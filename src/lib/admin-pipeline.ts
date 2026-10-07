import "server-only";

import type { DateRange } from "@/lib/admin-analytics";
import {
  isRoutinePoll,
  issueSignature,
  percentile,
  stageRank,
} from "@/lib/pipeline-issues";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Pipeline health from the extraction audit tables (migration v26). Info
 * events are not read; only warnings and errors feed the issue groups.
 * Aggregated in Node; fine for tens of thousands of rows per period.
 */

type Row = Record<string, unknown>;
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown) =>
  value !== null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
const addDays = (day: string, amount: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  ) + 1;
const today = () => new Date().toISOString().slice(0, 10);

async function fetchWindow(
  table: string,
  columns: string,
  timeColumn: string,
  from: string,
  to: string,
  warnings: string[],
  levels?: string[],
): Promise<Row[]> {
  const base = (select: string, head = false) => {
    let query = supabaseAdmin
      .from(table)
      .select(select, head ? { count: "exact", head: true } : undefined)
      .gte(timeColumn, `${from}T00:00:00Z`)
      .lt(timeColumn, `${addDays(to, 1)}T00:00:00Z`);
    if (levels) query = query.in("level", levels);
    return query;
  };
  // Count first, then fetch every page in parallel instead of one by one.
  const { count, error: countError } = await base("id", true);
  if (countError) {
    warnings.push(`${table}: ${countError.message}`);
    return [];
  }
  const pages = Math.ceil((count ?? 0) / PAGE_SIZE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, page) =>
      base(columns)
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
    ),
  );
  const rows: Row[] = [];
  for (const { data, error } of results) {
    if (error) {
      warnings.push(`${table}: ${error.message}`);
      continue;
    }
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

export type PipelineKpi = { value: number; previous: number | null };

export type PipelineIssue = {
  key: string;
  level: "warn" | "error";
  stage: string;
  signature: string;
  count: number;
  runs: number;
  posts: Array<{ id: string; label: string }>;
  postCount: number;
  firstSeen: string;
  lastSeen: string;
  samples: string[];
};

export type StageHealth = {
  stage: string;
  calls: number;
  failed: number;
  degraded: number;
  fallbacks: number;
  retries: number;
  p50: number | null;
  p95: number | null;
  tokens: number;
  cost: number;
  warnings: number;
  errors: number;
};

export type ProviderHealth = {
  key: string;
  provider: string;
  model: string | null;
  calls: number;
  failed: number;
  p50: number | null;
  p95: number | null;
  tokens: number;
  cost: number;
  lastError: string | null;
};

export type ProblemRun = {
  id: string;
  startedAt: string;
  status: string;
  entrypoint: string | null;
  platform: string | null;
  durationMs: number | null;
  postId: string | null;
  postLabel: string | null;
  inputUrl: string | null;
  error: string | null;
  errors: number;
  warnings: number;
};

export type PipelineReport = {
  range: DateRange;
  previous: { from: string; to: string };
  granularity: "day" | "week";
  loggingStartedAt: string | null;
  scope: { platform: string | null };
  platforms: string[];
  kpis: {
    runs: PipelineKpi;
    failedRuns: PipelineKpi;
    failureRate: number | null;
    partialRate: number | null;
    stuckRuns: number;
    p50Duration: number | null;
    p95Duration: number | null;
    cost: PipelineKpi;
    costPerRun: number | null;
    tokens: number;
    errorEvents: PipelineKpi;
    acceptedPlaces: number;
    unresolvedShare: number | null;
  };
  series: Array<{
    date: string;
    runs: number;
    failedRuns: number;
    errors: number;
    cost: number;
  }>;
  issues: PipelineIssue[];
  stages: StageHealth[];
  providers: ProviderHealth[];
  problemRuns: ProblemRun[];
  decisions: Array<{ key: string; count: number }>;
  dropReasons: Array<{ key: string; signature: string; count: number; decision: string }>;
  evidenceSources: Array<{ key: string; count: number }>;
  warnings: string[];
};

const weekStart = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
};

export async function getPipelineHealth(options: {
  range: DateRange | null;
  platform?: string | null;
}): Promise<PipelineReport> {
  const warnings: string[] = [];
  const platform = options.platform || null;
  const { data: firstRun } = await supabaseAdmin
    .from("extraction_runs")
    .select("created_at")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const loggingStartedAt = str(firstRun?.created_at);
  const range: DateRange = options.range ?? {
    key: "all",
    from: loggingStartedAt ? loggingStartedAt.slice(0, 10) : today(),
    to: today(),
  };
  const length = daysBetween(range.from, range.to);
  const previous = { from: addDays(range.from, -length), to: addDays(range.from, -1) };
  const hasPrevious = range.key !== "all";
  const windowFrom = hasPrevious ? previous.from : range.from;

  const [runRows, operationRows, eventRows, candidateRows, evidenceRows] =
    await Promise.all([
      fetchWindow(
        "extraction_runs",
        "id, social_post_id, platform, entrypoint, status, error_code, error_message, input_url, started_at, duration_ms, created_at",
        "created_at",
        windowFrom,
        range.to,
        warnings,
      ),
      fetchWindow(
        "extraction_stage_runs",
        "id, run_id, social_post_id, stage, operation, status, provider, model, attempt, is_fallback, duration_ms, total_tokens, estimated_cost_usd, error_code, error_message, started_at",
        "started_at",
        windowFrom,
        range.to,
        warnings,
      ),
      fetchWindow(
        "extraction_run_events",
        "id, run_id, social_post_id, stage, level, message, occurred_at",
        "occurred_at",
        windowFrom,
        range.to,
        warnings,
        ["warn", "error"],
      ),
      fetchWindow(
        "extraction_place_candidates",
        "id, run_id, decision, decision_reason, created_at",
        "created_at",
        range.from,
        range.to,
        warnings,
      ),
      fetchWindow(
        "extraction_evidence",
        "id, run_id, source_type, created_at",
        "created_at",
        range.from,
        range.to,
        warnings,
      ),
    ]);

  const runById = new Map(runRows.map((run) => [String(run.id), run]));
  const platforms = [
    ...new Set(runRows.map((run) => str(run.platform)).filter((p): p is string => Boolean(p))),
  ].sort();
  const inScope = (runId: unknown) => {
    if (!platform) return true;
    const run = runById.get(String(runId));
    return run ? run.platform === platform : false;
  };
  const inCurrent = (iso: unknown) =>
    typeof iso === "string" && iso.slice(0, 10) >= range.from && iso.slice(0, 10) <= range.to;
  const inPrevious = (iso: unknown) =>
    hasPrevious &&
    typeof iso === "string" &&
    iso.slice(0, 10) >= previous.from &&
    iso.slice(0, 10) <= previous.to;

  const runs = runRows.filter((run) => !platform || run.platform === platform);
  const operations = operationRows.filter((op) => inScope(op.run_id));
  const events = eventRows.filter((event) => inScope(event.run_id));
  const candidates = candidateRows.filter((candidate) => inScope(candidate.run_id));
  const evidence = evidenceRows.filter((item) => inScope(item.run_id));

  const currentRuns = runs.filter((run) => inCurrent(run.created_at));
  const previousRuns = runs.filter((run) => inPrevious(run.created_at));
  const currentOps = operations.filter((op) => inCurrent(op.started_at));
  const currentEvents = events.filter((event) => inCurrent(event.occurred_at));

  const finished = currentRuns.filter((run) =>
    ["completed", "partial", "failed"].includes(String(run.status)),
  );
  const failed = (list: Row[]) => list.filter((run) => run.status === "failed").length;
  const durations = finished
    .filter((run) => run.status !== "failed")
    .map((run) => num(run.duration_ms))
    .filter((value): value is number => value !== null);
  const costOf = (list: Row[]) =>
    list.reduce((sum, op) => sum + (num(op.estimated_cost_usd) ?? 0), 0);
  const errorCount = (list: Row[], ops: Row[]) =>
    list.filter((event) => event.level === "error").length +
    ops.filter((op) => op.status === "failed").length;
  const previousOps = operations.filter((op) => inPrevious(op.started_at));
  const previousEvents = events.filter((event) => inPrevious(event.occurred_at));
  const stuckBefore = Date.now() - 30 * 60_000;

  // Post labels for issue and run drill-downs.
  const postIds = [
    ...new Set(
      [...currentRuns, ...currentEvents, ...currentOps]
        .map((row) => str(row.social_post_id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const postLabels = new Map<string, string>();
  for (let index = 0; index < postIds.length; index += 100) {
    const { data } = await supabaseAdmin
      .from("social_posts")
      .select("id, author_username, platform")
      .in("id", postIds.slice(index, index + 100));
    for (const post of (data ?? []) as Row[])
      postLabels.set(String(post.id), `@${str(post.author_username) ?? "unknown"}`);
  }
  const postOfRun = (runId: unknown, fallback: unknown) =>
    str(fallback) ?? str(runById.get(String(runId))?.social_post_id);

  // Issue groups: warning/error events, failed provider calls, failed runs.
  const issues = new Map<
    string,
    PipelineIssue & { runSet: Set<string>; postSet: Set<string> }
  >();
  const addIssue = (
    level: "warn" | "error",
    stage: string,
    message: string | null,
    at: string,
    runId: unknown,
    postId: string | null,
  ) => {
    const signature = issueSignature(message);
    const key = `${level}:${stage}:${signature}`;
    const issue =
      issues.get(key) ??
      ({
        key,
        level,
        stage,
        signature,
        count: 0,
        runs: 0,
        posts: [],
        postCount: 0,
        firstSeen: at,
        lastSeen: at,
        samples: [],
        runSet: new Set<string>(),
        postSet: new Set<string>(),
      } as PipelineIssue & { runSet: Set<string>; postSet: Set<string> });
    issue.count += 1;
    if (at < issue.firstSeen) issue.firstSeen = at;
    if (at > issue.lastSeen) issue.lastSeen = at;
    if (runId) issue.runSet.add(String(runId));
    if (postId) issue.postSet.add(postId);
    if (message && issue.samples.length < 4 && !issue.samples.includes(message))
      issue.samples.push(message);
    issues.set(key, issue);
  };
  for (const event of currentEvents)
    addIssue(
      event.level === "error" ? "error" : "warn",
      String(event.stage),
      str(event.message),
      String(event.occurred_at),
      event.run_id,
      postOfRun(event.run_id, event.social_post_id),
    );
  for (const op of currentOps.filter((item) => item.status === "failed"))
    addIssue(
      "error",
      String(op.stage),
      `${String(op.operation).replace(/_/g, " ")} failed (${str(op.provider) ?? "unknown"}): ${str(op.error_message) ?? str(op.error_code) ?? "no error message"}`,
      String(op.started_at),
      op.run_id,
      postOfRun(op.run_id, op.social_post_id),
    );
  for (const run of currentRuns.filter((item) => item.status === "failed"))
    addIssue(
      "error",
      "run",
      str(run.error_message) ?? str(run.error_code) ?? "Run failed without a message",
      String(run.created_at),
      run.id,
      str(run.social_post_id),
    );

  // Stage health.
  const stageMap = new Map<string, Row[]>();
  for (const op of currentOps) {
    if (isRoutinePoll(op)) continue;
    const list = stageMap.get(String(op.stage)) ?? [];
    list.push(op);
    stageMap.set(String(op.stage), list);
  }
  const stageNames = new Set([
    ...stageMap.keys(),
    ...currentEvents.map((event) => String(event.stage)).filter((stage) => stage !== "run"),
  ]);
  const stages: StageHealth[] = [...stageNames]
    .map((stage) => {
      const list = stageMap.get(stage) ?? [];
      const times = list
        .map((op) => num(op.duration_ms))
        .filter((value): value is number => value !== null);
      const stageEvents = currentEvents.filter((event) => event.stage === stage);
      return {
        stage,
        calls: list.length,
        failed: list.filter((op) => op.status === "failed").length,
        degraded: list.filter((op) => op.status === "partial").length,
        fallbacks: list.filter((op) => op.is_fallback === true).length,
        retries: list.filter((op) => (num(op.attempt) ?? 1) > 1).length,
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        tokens: list.reduce((sum, op) => sum + (num(op.total_tokens) ?? 0), 0),
        cost: costOf(list),
        warnings: stageEvents.filter((event) => event.level === "warn").length,
        errors: stageEvents.filter((event) => event.level === "error").length,
      };
    })
    .sort((a, b) => stageRank(a.stage) - stageRank(b.stage));

  // Provider health.
  const providerMap = new Map<string, Row[]>();
  for (const op of currentOps) {
    if (isRoutinePoll(op)) continue;
    const key = `${str(op.provider) ?? "unknown"}|${str(op.model) ?? ""}`;
    const list = providerMap.get(key) ?? [];
    list.push(op);
    providerMap.set(key, list);
  }
  const providers: ProviderHealth[] = [...providerMap.entries()]
    .map(([key, list]) => {
      const [provider, model] = key.split("|");
      const times = list
        .map((op) => num(op.duration_ms))
        .filter((value): value is number => value !== null);
      const lastFailure = list
        .filter((op) => op.status === "failed")
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      return {
        key,
        provider,
        model: model || null,
        calls: list.length,
        failed: list.filter((op) => op.status === "failed").length,
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        tokens: list.reduce((sum, op) => sum + (num(op.total_tokens) ?? 0), 0),
        cost: costOf(list),
        lastError: lastFailure
          ? (str(lastFailure.error_message) ?? str(lastFailure.error_code))
          : null,
      };
    })
    .sort((a, b) => b.failed - a.failed || b.calls - a.calls);

  // Recent failed/partial runs with their own error and warning counts.
  const eventsByRun = new Map<string, { errors: number; warnings: number; first: string | null }>();
  for (const event of currentEvents) {
    const entry = eventsByRun.get(String(event.run_id)) ?? { errors: 0, warnings: 0, first: null };
    if (event.level === "error") {
      entry.errors += 1;
      entry.first ??= str(event.message);
    } else entry.warnings += 1;
    eventsByRun.set(String(event.run_id), entry);
  }
  const problemRuns: ProblemRun[] = currentRuns
    .filter(
      (run) =>
        run.status === "failed" ||
        run.status === "partial" ||
        (run.status === "running" && Date.parse(String(run.created_at)) < stuckBefore),
    )
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 40)
    .map((run) => {
      const counts = eventsByRun.get(String(run.id));
      const postId = str(run.social_post_id);
      return {
        id: String(run.id),
        startedAt: String(run.started_at ?? run.created_at),
        status: String(run.status),
        entrypoint: str(run.entrypoint),
        platform: str(run.platform),
        durationMs: num(run.duration_ms),
        postId,
        postLabel: postId ? (postLabels.get(postId) ?? null) : null,
        inputUrl: str(run.input_url),
        error: str(run.error_message) ?? counts?.first ?? null,
        errors: counts?.errors ?? 0,
        warnings: counts?.warnings ?? 0,
      };
    });

  // Series.
  const granularity: "day" | "week" = length > 92 ? "week" : "day";
  const bucketOf = (iso: string) =>
    granularity === "week" ? weekStart(iso.slice(0, 10)) : iso.slice(0, 10);
  const buckets = new Map<string, PipelineReport["series"][number]>();
  for (
    let day = granularity === "week" ? weekStart(range.from) : range.from;
    day <= range.to;
    day = addDays(day, granularity === "week" ? 7 : 1)
  )
    buckets.set(day, { date: day, runs: 0, failedRuns: 0, errors: 0, cost: 0 });
  for (const run of currentRuns) {
    const bucket = buckets.get(bucketOf(String(run.created_at)));
    if (!bucket) continue;
    bucket.runs += 1;
    if (run.status === "failed") bucket.failedRuns += 1;
  }
  for (const op of currentOps) {
    const bucket = buckets.get(bucketOf(String(op.started_at)));
    if (!bucket) continue;
    bucket.cost += num(op.estimated_cost_usd) ?? 0;
    if (op.status === "failed") bucket.errors += 1;
  }
  for (const event of currentEvents) {
    if (event.level !== "error") continue;
    const bucket = buckets.get(bucketOf(String(event.occurred_at)));
    if (bucket) bucket.errors += 1;
  }

  // Extraction quality.
  const decisionCounts = new Map<string, number>();
  for (const candidate of candidates)
    decisionCounts.set(String(candidate.decision), (decisionCounts.get(String(candidate.decision)) ?? 0) + 1);
  const reasonMap = new Map<string, { key: string; signature: string; count: number; decision: string }>();
  for (const candidate of candidates) {
    if (candidate.decision === "accepted") continue;
    const signature = issueSignature(str(candidate.decision_reason));
    const key = `${candidate.decision}:${signature}`;
    const entry = reasonMap.get(key) ?? { key, signature, count: 0, decision: String(candidate.decision) };
    entry.count += 1;
    reasonMap.set(key, entry);
  }
  const sourceCounts = new Map<string, number>();
  for (const item of evidence)
    sourceCounts.set(String(item.source_type), (sourceCounts.get(String(item.source_type)) ?? 0) + 1);

  const totalCandidates = candidates.length;
  return {
    range,
    previous,
    granularity,
    loggingStartedAt,
    scope: { platform },
    platforms,
    kpis: {
      runs: { value: currentRuns.length, previous: hasPrevious ? previousRuns.length : null },
      failedRuns: { value: failed(currentRuns), previous: hasPrevious ? failed(previousRuns) : null },
      failureRate: finished.length ? failed(finished) / finished.length : null,
      partialRate: finished.length
        ? finished.filter((run) => run.status === "partial").length / finished.length
        : null,
      stuckRuns: currentRuns.filter(
        (run) => run.status === "running" && Date.parse(String(run.created_at)) < stuckBefore,
      ).length,
      p50Duration: percentile(durations, 50),
      p95Duration: percentile(durations, 95),
      cost: { value: costOf(currentOps), previous: hasPrevious ? costOf(previousOps) : null },
      costPerRun: finished.length ? costOf(currentOps) / finished.length : null,
      tokens: currentOps.reduce((sum, op) => sum + (num(op.total_tokens) ?? 0), 0),
      errorEvents: {
        value: errorCount(currentEvents, currentOps),
        previous: hasPrevious ? errorCount(previousEvents, previousOps) : null,
      },
      acceptedPlaces: decisionCounts.get("accepted") ?? 0,
      unresolvedShare: totalCandidates
        ? ((decisionCounts.get("unresolved") ?? 0) + (decisionCounts.get("save_failed") ?? 0)) /
          totalCandidates
        : null,
    },
    series: [...buckets.values()],
    issues: [...issues.values()]
      .map(({ runSet, postSet, ...issue }) => ({
        ...issue,
        runs: runSet.size,
        postCount: postSet.size,
        posts: [...postSet]
          .slice(0, 12)
          .map((id) => ({ id, label: postLabels.get(id) ?? "Post" })),
      }))
      .sort(
        (a, b) =>
          (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) ||
          b.count - a.count,
      ),
    stages,
    providers,
    problemRuns,
    decisions: [...decisionCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    dropReasons: [...reasonMap.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    evidenceSources: [...sourceCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    warnings,
  };
}
