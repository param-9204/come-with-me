"use client";

import { Fragment, useMemo, useState } from "react";

import {
  evidenceLabel,
  isRoutinePoll,
  issueSignature,
  stageLabel,
  stageRank,
} from "@/lib/pipeline-issues";
import ApifyTraceDetails from "./apify-trace-details";
import PlaceInvestigation from "./place-investigation";
import {
  ApifyExtraction,
  type Data,
  type PostDetail,
  TraceLog,
  record,
  records,
  strings,
} from "./post-components";
import {
  EmptyState,
  FactList,
  Panel,
  StatusBadge,
  cx,
  fmt,
  inputClass,
} from "./ui";
import { TabPanel, Tabs } from "./ui-client";

type SubTab = "summary" | "places" | "operations" | "log" | "candidates" | "evidence" | "trace";
type Level = "info" | "warn" | "error";

const num = (value: unknown) =>
  value !== null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;
const ms = (value: number | null) => {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
};
/** Offset from run start, e.g. +15.2s or +1:02. */
const clock = (value: number | null) => {
  if (value === null) return "";
  const seconds = value / 1000;
  if (seconds < 60) return `+${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `+${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const usd = (value: number | null) =>
  value === null ? "—" : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);
const humanize = (value: unknown) =>
  typeof value === "string" && value ? value.replace(/[_-]/g, " ") : "—";

const LEVEL_TONE: Record<Level, string> = {
  error: "bg-bad",
  warn: "bg-warn",
  info: "bg-line-strong",
};
const LEVEL_LABEL: Record<Level, string> = {
  error: "Error",
  warn: "Warning",
  info: "Info",
};

function LevelBadge({ level }: { level: Level }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", LEVEL_TONE[level])} />
      {LEVEL_LABEL[level]}
    </span>
  );
}

/** Small key/value view for the JSON summaries the logger stores. */
function SummaryValues({ value }: { value: Data }) {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== null && item !== undefined && item !== "",
  );
  if (!entries.length) return <p className="text-xs text-ink-3">Nothing recorded.</p>;
  return (
    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {entries.map(([key, item]) => (
        <div key={key} className="flex min-w-0 gap-2">
          <dt className="shrink-0 text-ink-3">{humanize(key)}</dt>
          <dd className="min-w-0 font-mono break-all text-ink-2">
            {typeof item === "object" ? JSON.stringify(item) : String(item)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SegmentFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string; count?: number }>;
  onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap rounded-md border border-line-strong p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            "h-6 cursor-pointer rounded px-2 text-xs font-medium whitespace-nowrap",
            value === option.id ? "bg-subtle text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1 font-normal text-ink-3 tabular-nums">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

type Issue = {
  key: string;
  level: Level;
  stage: string;
  signature: string;
  count: number;
  firstElapsed: number | null;
  samples: Array<{ message: string; elapsed: number | null }>;
};

function buildIssues(events: Data[], operations: Data[], runStart: number): Issue[] {
  const groups = new Map<string, Issue>();
  const add = (level: Level, stage: string, message: string, elapsed: number | null) => {
    const signature = issueSignature(message);
    const key = `${level}:${stage}:${signature}`;
    const issue = groups.get(key) ?? {
      key,
      level,
      stage,
      signature,
      count: 0,
      firstElapsed: elapsed,
      samples: [],
    };
    issue.count += 1;
    if (elapsed !== null && (issue.firstElapsed === null || elapsed < issue.firstElapsed))
      issue.firstElapsed = elapsed;
    if (issue.samples.length < 8) issue.samples.push({ message, elapsed });
    groups.set(key, issue);
  };
  for (const event of events) {
    if (event.level === "warn" || event.level === "error")
      add(event.level, String(event.stage), String(event.message ?? ""), num(event.elapsed_ms));
  }
  // Failed provider calls are not always echoed as error events.
  for (const operation of operations) {
    if (operation.status !== "failed") continue;
    const started = time(operation.started_at);
    add(
      "error",
      String(operation.stage),
      `${humanize(operation.operation)} failed (${str(operation.provider) ?? "unknown provider"}): ${str(operation.error_message) ?? str(operation.error_code) ?? "no error message"}`,
      Number.isFinite(started) && Number.isFinite(runStart) ? started - runStart : null,
    );
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) ||
      b.count - a.count ||
      stageRank(a.stage) - stageRank(b.stage),
  );
}

function IssuesPanel({ issues }: { issues: Issue[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const errors = issues.filter((issue) => issue.level === "error").reduce((n, i) => n + i.count, 0);
  const warnings = issues.filter((issue) => issue.level === "warn").reduce((n, i) => n + i.count, 0);
  return (
    <Panel
      title="Issues"
      description={
        issues.length
          ? `${fmt.number(errors)} ${errors === 1 ? "error" : "errors"} and ${fmt.number(warnings)} ${warnings === 1 ? "warning" : "warnings"}, grouped by type`
          : undefined
      }
      flush
    >
      {issues.length ? (
        <ul className="divide-y divide-line">
          {issues.map((issue) => {
            const expanded = open === issue.key;
            return (
              <li key={issue.key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : issue.key)}
                  className="grid w-full cursor-pointer grid-cols-[72px_80px_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5 text-left hover:bg-subtle"
                >
                  <LevelBadge level={issue.level} />
                  <span className="text-xs text-ink-3">{stageLabel(issue.stage)}</span>
                  <span className="min-w-0 text-[13px] text-ink">
                    {issue.signature.charAt(0).toUpperCase() + issue.signature.slice(1)}
                  </span>
                  <span className="text-xs text-ink-2 tabular-nums">×{fmt.number(issue.count)}</span>
                </button>
                {expanded && (
                  <ul className="space-y-1 border-t border-line bg-canvas/40 px-4 py-2.5 pl-[172px] max-sm:pl-4">
                    {issue.samples.map((sample, index) => (
                      <li key={index} className="flex gap-3 text-xs">
                        <span className="w-14 shrink-0 font-mono text-ink-3 tabular-nums">
                          {clock(sample.elapsed)}
                        </span>
                        <span className="min-w-0 break-words text-ink-2">{sample.message}</span>
                      </li>
                    ))}
                    {issue.count > issue.samples.length && (
                      <li className="text-xs text-ink-3">
                        and {fmt.number(issue.count - issue.samples.length)} more in the event log
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[13px] text-ink-3">
          No warnings or errors were logged for this run.
        </p>
      )}
    </Panel>
  );
}

type StageRow = {
  stage: string;
  start: number;
  end: number;
  calls: number;
  failed: number;
  degraded: number;
  fallbacks: number;
  tokens: number;
  cost: number | null;
  warnings: number;
  errors: number;
};

/**
 * Stage spans: provider calls give exact start/finish times; stages that only
 * log events (media, frames, save) use their first and last event instead.
 */
function buildStages(events: Data[], operations: Data[], runStart: number): StageRow[] {
  const rows = new Map<string, StageRow>();
  const row = (stage: string) => {
    const existing = rows.get(stage);
    if (existing) return existing;
    const created: StageRow = {
      stage,
      start: Infinity,
      end: -Infinity,
      calls: 0,
      failed: 0,
      degraded: 0,
      fallbacks: 0,
      tokens: 0,
      cost: null,
      warnings: 0,
      errors: 0,
    };
    rows.set(stage, created);
    return created;
  };
  for (const operation of operations) {
    const target = row(String(operation.stage));
    const start = time(operation.started_at) - runStart;
    const end = time(operation.finished_at) - runStart;
    if (Number.isFinite(start)) target.start = Math.min(target.start, start);
    if (Number.isFinite(end)) target.end = Math.max(target.end, end);
    target.calls += 1;
    if (operation.status === "failed") target.failed += 1;
    if (operation.status === "partial" && !isRoutinePoll(operation)) target.degraded += 1;
    if (operation.is_fallback === true) target.fallbacks += 1;
    target.tokens += num(operation.total_tokens) ?? 0;
    const cost = num(operation.estimated_cost_usd);
    if (cost !== null) target.cost = (target.cost ?? 0) + cost;
  }
  const opStages = new Set(operations.map((operation) => String(operation.stage)));
  for (const event of events) {
    const stage = String(event.stage);
    if (stage === "run") continue;
    const target = row(stage);
    if (event.level === "warn") target.warnings += 1;
    if (event.level === "error") target.errors += 1;
    const elapsed = num(event.elapsed_ms);
    if (!opStages.has(stage) && elapsed !== null) {
      target.start = Math.min(target.start, elapsed);
      target.end = Math.max(target.end, elapsed);
    }
  }
  return [...rows.values()]
    .map((item) => ({
      ...item,
      start: Number.isFinite(item.start) ? Math.max(0, item.start) : 0,
      end: Number.isFinite(item.end) ? Math.max(0, item.end) : 0,
    }))
    .sort((a, b) => a.start - b.start || stageRank(a.stage) - stageRank(b.stage));
}

function Waterfall({ stages, duration }: { stages: StageRow[]; duration: number | null }) {
  const total = Math.max(duration ?? 0, ...stages.map((stage) => stage.end), 1);
  return (
    <Panel
      title="Where the time went"
      description="Each bar spans a stage's first to last activity within the run"
      flush
    >
      {stages.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-subtle text-xs text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Stage</th>
                <th scope="col" className="w-[40%] px-3 py-2 font-medium">
                  <span className="sr-only">Timeline</span>
                  <span aria-hidden className="flex justify-between font-normal">
                    <span>0 s</span>
                    <span>{ms(total)}</span>
                  </span>
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Span</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Calls</th>
                <th scope="col" className="px-3 py-2 font-medium">Problems</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {stages.map((stage) => {
                const left = (stage.start / total) * 100;
                const width = Math.max(((stage.end - stage.start) / total) * 100, 0.6);
                const problems = [
                  stage.failed && `${stage.failed} failed`,
                  stage.errors && `${stage.errors} ${stage.errors === 1 ? "error" : "errors"}`,
                  stage.degraded && `${stage.degraded} degraded`,
                  stage.warnings && `${stage.warnings} ${stage.warnings === 1 ? "warning" : "warnings"}`,
                  stage.fallbacks && `${stage.fallbacks} fallback`,
                ].filter(Boolean);
                return (
                  <tr key={stage.stage}>
                    <td className="px-3 py-2 whitespace-nowrap text-ink">{stageLabel(stage.stage)}</td>
                    <td className="px-3 py-2">
                      <div
                        className="relative h-2 rounded-full bg-subtle"
                        title={`${ms(stage.start)} → ${ms(stage.end)}`}
                      >
                        <div
                          className={cx(
                            "absolute inset-y-0 rounded-full",
                            stage.failed || stage.errors ? "bg-bad" : "bg-accent",
                          )}
                          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-ink-2 tabular-nums">
                      {ms(stage.end - stage.start)}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">
                      {stage.calls ? fmt.number(stage.calls) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {problems.length ? (
                        <span className={stage.failed || stage.errors ? "text-bad" : "text-warn"}>
                          {problems.join(" · ")}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">
                      {stage.tokens ? fmt.number(stage.tokens) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{usd(stage.cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-3 text-[13px] text-ink-3">No stage activity was logged for this run.</p>
      )}
    </Panel>
  );
}

function Operations({ operations }: { operations: Data[] }) {
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [open, setOpen] = useState<string | null>(null);
  const problems = operations.filter(
    (operation) =>
      operation.status === "failed" ||
      (operation.status === "partial" && !isRoutinePoll(operation)) ||
      operation.is_fallback === true ||
      (num(operation.attempt) ?? 1) > 1,
  );
  const visible = filter === "all" ? operations : problems;
  const totals = operations.reduce<{ tokens: number; cost: number; duration: number }>(
    (sum, operation) => ({
      tokens: sum.tokens + (num(operation.total_tokens) ?? 0),
      cost: sum.cost + (num(operation.estimated_cost_usd) ?? 0),
      duration: sum.duration + (num(operation.duration_ms) ?? 0),
    }),
    { tokens: 0, cost: 0, duration: 0 },
  );
  return (
    <Panel
      title="Provider operations"
      description={`${fmt.number(operations.length)} calls · ${fmt.number(totals.tokens)} tokens · ${usd(totals.cost)} estimated`}
      actions={
        <SegmentFilter
          label="Operations filter"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All", count: operations.length },
            { id: "problems", label: "Failed, degraded or retried", count: problems.length },
          ]}
        />
      }
      flush
    >
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-subtle text-xs text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Operation</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Duration</th>
                <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">Tokens in / out</th>
                <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">Est. cost</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((operation) => {
                const key = String(operation.id);
                const expanded = open === key;
                const attempt = num(operation.attempt) ?? 1;
                return (
                  <Fragment key={key}>
                    <tr className="align-top">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : key)}
                          className="cursor-pointer text-left hover:text-accent"
                        >
                          <span aria-hidden className={cx("mr-1 inline-block text-ink-3 transition-transform", expanded && "rotate-90")}>
                            ›
                          </span>
                          <span className="text-ink">{stageLabel(operation.stage)}</span>
                          <span className="text-ink-3"> · {humanize(operation.operation)}</span>
                        </button>
                        <p className="pl-3 text-xs break-all text-ink-3">
                          {[operation.provider, operation.model].filter((item) => str(item)).join(" · ") || "No provider recorded"}
                        </p>
                        {(attempt > 1 || operation.is_fallback === true) && (
                          <p className="mt-0.5 pl-3 text-xs text-warn">
                            {[attempt > 1 && `attempt ${attempt}`, operation.is_fallback === true && "fallback"]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        {str(operation.error_message) && (
                          <p className="mt-0.5 pl-3 text-xs break-words text-bad">
                            {str(operation.error_code) ? `${operation.error_code}: ` : ""}
                            {String(operation.error_message)}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{ms(num(operation.duration_ms))}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-ink-2 tabular-nums">
                        {num(operation.input_tokens) !== null || num(operation.output_tokens) !== null
                          ? `${fmt.number(operation.input_tokens, "0")} / ${fmt.number(operation.output_tokens, "0")}`
                          : num(operation.input_units) !== null
                            ? `${fmt.number(operation.input_units)} units`
                            : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{usd(num(operation.estimated_cost_usd))}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isRoutinePoll(operation) ? (
                          <span className="text-xs text-ink-3">Still running</span>
                        ) : (
                          <StatusBadge status={operation.status} />
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5} className="bg-canvas/40 px-6 py-3">
                          <div className="grid gap-4 lg:grid-cols-2">
                            <div>
                              <p className="mb-1.5 text-xs font-medium text-ink-3">Request</p>
                              <SummaryValues value={record(operation.request_summary)} />
                            </div>
                            <div>
                              <p className="mb-1.5 text-xs font-medium text-ink-3">Result</p>
                              <SummaryValues value={record(operation.result_summary)} />
                            </div>
                          </div>
                          <p className="mt-3 text-xs text-ink-3">
                            {fmt.date(operation.started_at, true)} → {fmt.date(operation.finished_at, true)}
                            {typeof operation.retryable === "boolean" &&
                              ` · ${operation.retryable ? "retryable" : "not retryable"}`}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={operations.length ? "No failed, degraded or retried calls" : "No provider calls were logged"}
        />
      )}
    </Panel>
  );
}

function EventLog({ events, truncated }: { events: Data[]; truncated: boolean }) {
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [stage, setStage] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const stages = [...new Set(events.map((event) => String(event.stage)))].sort(
    (a, b) => stageRank(a) - stageRank(b),
  );
  const counts = {
    warn: events.filter((event) => event.level === "warn").length,
    error: events.filter((event) => event.level === "error").length,
  };
  const term = query.trim().toLowerCase();
  const visible = events.filter(
    (event) =>
      (level === "all" ||
        (level === "warn" ? event.level !== "info" : event.level === "error")) &&
      (!stage || event.stage === stage) &&
      (!term ||
        String(event.message).toLowerCase().includes(term) ||
        JSON.stringify(event.data ?? {}).toLowerCase().includes(term)),
  );

  return (
    <Panel
      title="Event log"
      description={
        truncated
          ? "Showing the first 5,000 events of this post's runs"
          : "Every event the pipeline logged for this run, in order"
      }
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <SegmentFilter
          label="Level"
          value={level}
          onChange={setLevel}
          options={[
            { id: "all", label: "All", count: events.length },
            { id: "warn", label: "Warnings and errors", count: counts.warn + counts.error },
            { id: "error", label: "Errors", count: counts.error },
          ]}
        />
        <select
          aria-label="Stage"
          value={stage}
          onChange={(event) => setStage(event.target.value)}
          className={cx(inputClass, "h-7 text-xs")}
        >
          <option value="">All stages</option>
          {stages.map((item) => (
            <option key={item} value={item}>
              {stageLabel(item)}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Search events"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages and data"
          className={cx(inputClass, "h-7 min-w-0 flex-1 text-xs sm:max-w-64")}
        />
        <span className="ml-auto text-xs text-ink-3 tabular-nums">
          {fmt.number(visible.length)} shown
        </span>
      </div>
      {visible.length ? (
        <ol className="divide-y divide-line text-xs">
          {visible.slice(0, limit).map((event) => {
            const key = String(event.id);
            const payload = record(event.data);
            const hasData = Object.keys(payload).length > 0;
            const expanded = open === key;
            return (
              <li key={key} className={cx(event.level === "error" && "bg-bad-soft/60")}>
                <button
                  type="button"
                  disabled={!hasData}
                  aria-expanded={hasData ? expanded : undefined}
                  onClick={() => setOpen(expanded ? null : key)}
                  className="grid w-full grid-cols-[64px_64px_72px_minmax(0,1fr)] items-baseline gap-3 px-3 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-subtle max-sm:grid-cols-[56px_minmax(0,1fr)]"
                >
                  <span className="font-mono text-ink-3 tabular-nums">{clock(num(event.elapsed_ms))}</span>
                  <span className="max-sm:hidden">
                    <LevelBadge level={(event.level as Level) ?? "info"} />
                  </span>
                  <span className="truncate text-ink-3 max-sm:hidden">{stageLabel(event.stage)}</span>
                  <span className="min-w-0 text-[13px] break-words text-ink">
                    {String(event.message)}
                    {hasData && <span aria-hidden className="ml-1.5 text-ink-3">{expanded ? "▾" : "▸"}</span>}
                  </span>
                </button>
                {expanded && (
                  <pre className="mx-3 mb-2 max-h-72 font-mono overflow-auto rounded-md border border-line bg-surface p-3 text-[11px] leading-5 text-ink-2">
                    {JSON.stringify(payload, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState title={events.length ? "No events match these filters" : "No events were logged for this run"} />
      )}
      {visible.length > limit && (
        <div className="border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setLimit((current) => current + 200)}
            className="cursor-pointer text-xs font-medium text-accent hover:underline"
          >
            Show 200 more of {fmt.number(visible.length - limit)} remaining
          </button>
        </div>
      )}
    </Panel>
  );
}

const DECISIONS = ["accepted", "rejected", "unresolved", "save_failed"] as const;
const DECISION_LABEL: Record<string, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  unresolved: "Unresolved",
  save_failed: "Save failed",
};

function EvidenceQuotes({ ids, evidenceById }: { ids: string[]; evidenceById: Map<string, Data> }) {
  const items = ids.map((id) => ({ id, item: evidenceById.get(id) }));
  if (!items.length) return <p className="text-xs text-ink-3">None linked.</p>;
  return (
    <ul className="space-y-1">
      {items.map(({ id, item }) => (
        <li key={id} className="flex gap-2 text-xs">
          <span className="w-10 shrink-0 font-mono text-ink-3">{id}</span>
          {item ? (
            <span className="min-w-0 text-ink-2">
              <span className="text-ink-3">{evidenceLabel(item.source_type)}</span>
              {Array.isArray(item.timestamps_sec) && item.timestamps_sec.length > 0 && (
                <span className="text-ink-3">
                  {" "}
                  @ {(item.timestamps_sec as number[]).slice(0, 4).map((t) => `${Number(t)}s`).join(", ")}
                </span>
              )}
              : {String(item.text_value)}
            </span>
          ) : (
            <span className="text-ink-3">Evidence text not stored</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Candidates({ candidates, evidenceById }: { candidates: Data[]; evidenceById: Map<string, Data> }) {
  const [decision, setDecision] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);
  const counts = Object.fromEntries(
    DECISIONS.map((item) => [item, candidates.filter((candidate) => candidate.decision === item).length]),
  );
  const visible = candidates.filter((candidate) => decision === "all" || candidate.decision === decision);
  return (
    <Panel
      title="Place candidates"
      description="Every place the model proposed, and why it was kept or dropped"
      actions={
        <SegmentFilter
          label="Decision"
          value={decision}
          onChange={setDecision}
          options={[
            { id: "all", label: "All", count: candidates.length },
            ...DECISIONS.filter((item) => counts[item] > 0).map((item) => ({
              id: item,
              label: DECISION_LABEL[item],
              count: counts[item],
            })),
          ]}
        />
      }
      flush
    >
      {visible.length ? (
        <ul className="divide-y divide-line">
          {visible.map((candidate) => {
            const key = String(candidate.id);
            const expanded = open === key;
            const meta = [candidate.category, candidate.neighborhood, candidate.city, candidate.mention_type, candidate.role]
              .filter((item) => str(item))
              .map((item) => humanize(item).toLowerCase());
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : key)}
                  className="block w-full cursor-pointer px-4 py-2.5 text-left hover:bg-subtle"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-[13px] font-medium text-ink">
                      {str(candidate.name) ?? "Unnamed candidate"}
                      {meta.length > 0 && (
                        <span className="ml-2 text-xs font-normal text-ink-3 capitalize">{meta.join(" · ")}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-3">
                      {num(candidate.confidence) !== null && (
                        <span className="text-xs text-ink-2 tabular-nums">
                          {Math.round((num(candidate.confidence) ?? 0) * 100)}%
                        </span>
                      )}
                      <StatusBadge status={candidate.decision === "save_failed" ? "failed" : candidate.decision} />
                    </span>
                  </span>
                  {str(candidate.decision_reason) && (
                    <span className="mt-0.5 block text-xs leading-5 text-ink-2">{String(candidate.decision_reason)}</span>
                  )}
                </button>
                {expanded && (
                  <div className="grid gap-4 border-t border-line bg-canvas/40 px-4 py-3 lg:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-ink-3">Name evidence</p>
                      <EvidenceQuotes ids={strings(candidate.evidence_ids)} evidenceById={evidenceById} />
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-ink-3">Location evidence</p>
                      <EvidenceQuotes ids={strings(candidate.location_evidence_ids)} evidenceById={evidenceById} />
                    </div>
                    <div className="lg:col-span-2">
                      <FactList
                        columns={2}
                        items={[
                          ["Address", str(candidate.address)],
                          ["Base category", str(candidate.base_category)],
                          ["Evidence sources", strings(candidate.evidence_sources).map(evidenceLabel).join(", ") || null],
                          ["Model", [candidate.model_provider, candidate.model].filter((item) => str(item)).join(" · ") || null],
                          ["Saved place ID", str(candidate.place_id)],
                          ["Candidate key", str(candidate.candidate_key)],
                        ]}
                      />
                      {Object.keys(record(candidate.details)).length > 0 && (
                        <div className="mt-2">
                          <SummaryValues value={record(candidate.details)} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title={candidates.length ? "No candidates with this decision" : "No place candidates were logged for this run"} />
      )}
    </Panel>
  );
}

function Evidence({ evidence }: { evidence: Data[] }) {
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const sources = [...new Set(evidence.map((item) => String(item.source_type)))]
    .map((key) => ({ key, count: evidence.filter((item) => item.source_type === key).length }))
    .sort((a, b) => b.count - a.count);
  const term = query.trim().toLowerCase();
  const visible = evidence.filter(
    (item) =>
      (!source || item.source_type === source) &&
      (!term || String(item.text_value).toLowerCase().includes(term)),
  );
  return (
    <Panel
      title="Evidence"
      description="Text the model read, with the id candidates cite"
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <SegmentFilter
          label="Source"
          value={source}
          onChange={setSource}
          options={[
            { id: "", label: "All", count: evidence.length },
            ...sources.map((item) => ({ id: item.key, label: evidenceLabel(item.key), count: item.count })),
          ]}
        />
        <input
          type="search"
          aria-label="Search evidence"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search text"
          className={cx(inputClass, "h-7 min-w-0 flex-1 text-xs sm:max-w-56")}
        />
      </div>
      {visible.length ? (
        <ul className="max-h-[560px] divide-y divide-line overflow-auto">
          {visible.map((item) => {
            const timestamps = Array.isArray(item.timestamps_sec) ? (item.timestamps_sec as unknown[]) : [];
            return (
              <li key={String(item.id)} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-4 py-2">
                <span className="font-mono text-xs text-ink-3">{String(item.evidence_id)}</span>
                <div className="min-w-0">
                  <p className="text-[13px] break-words whitespace-pre-wrap text-ink">{String(item.text_value)}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {[
                      evidenceLabel(item.source_type),
                      timestamps.length
                        ? `at ${timestamps.slice(0, 6).map((t) => `${Number(t)}s`).join(", ")}${timestamps.length > 6 ? "…" : ""}`
                        : null,
                      num(item.confidence) !== null ? `${Math.round((num(item.confidence) ?? 0) * 100)}% confidence` : null,
                      [item.provider, item.model].filter((value) => str(value)).join(" · ") || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title={evidence.length ? "No evidence matches" : "No evidence was logged for this run"} />
      )}
    </Panel>
  );
}

const RESULT_LABELS: Record<string, string> = {
  returnedPlaceCount: "Places returned",
  persistedPlaceCount: "Places saved",
  unresolvedPlaceCount: "Unresolved places",
  rejectedCandidateCount: "Rejected candidates",
  restricted: "Restricted content",
};

export default function ExtractionView({
  detail,
  placeQuery = "",
}: {
  detail: PostDetail;
  /** Opens the place check pre-filled, e.g. from the Places tab. */
  placeQuery?: string;
}) {
  const related = detail.related;
  const runs = useMemo(
    () =>
      records(related.runs).sort(
        (a, b) => (time(b.started_at) || 0) - (time(a.started_at) || 0),
      ),
    [related.runs],
  );
  const operationsAll = records(related.operations);
  const eventsAll = records(related.events);
  const candidatesAll = records(related.candidates);
  const evidenceAll = records(related.evidence);
  // Open the most recent run that actually logged something.
  const [runId, setRunId] = useState<string>(() => {
    const informative = runs.find((run) =>
      eventsAll.some((event) => event.run_id === run.id) ||
      operationsAll.some((operation) => operation.run_id === run.id),
    );
    return String((informative ?? runs[0])?.id ?? "");
  });
  const [tab, setTab] = useState<SubTab>(placeQuery ? "places" : "summary");

  const run = runs.find((item) => String(item.id) === runId) ?? null;
  const byRun = (items: Data[]) => items.filter((item) => String(item.run_id) === runId);
  const operations = byRun(operationsAll).sort(
    (a, b) => time(a.started_at) - time(b.started_at) || stageRank(String(a.stage)) - stageRank(String(b.stage)),
  );
  const events = byRun(eventsAll);
  const candidates = byRun(candidatesAll);
  const evidence = byRun(evidenceAll);
  const evidenceById = new Map(evidence.map((item) => [String(item.evidence_id), item]));
  const runStart = run ? time(run.started_at) : NaN;
  const issues = buildIssues(events, operations, runStart);
  const stages = buildStages(events, operations, runStart);
  const legacy = records(related.extraction)[records(related.runs).findIndex((item) => String(item.id) === runId)] ?? {};

  const cost = operations.reduce<number | null>((sum, operation) => {
    const value = num(operation.estimated_cost_usd);
    return value === null ? sum : (sum ?? 0) + value;
  }, null);
  const tokens = operations.reduce((sum, operation) => sum + (num(operation.total_tokens) ?? 0), 0);
  const failedCalls = operations.filter((operation) => operation.status === "failed").length;
  const result = record(run?.result_summary);
  const resultWarnings = strings(result.warnings);

  if (!runs.length)
    return (
      <div className="space-y-4">
        <Panel>
          <EmptyState
            title="No extraction runs were logged for this post"
            description="Audit logging started on 24 Sept 2026; older posts only have the processing trace below."
          />
        </Panel>
        <TraceLog detail={detail} />
        <ApifyExtraction detail={detail} />
        <ApifyTraceDetails detail={detail} />
      </div>
    );

  return (
    <div className="space-y-4">
      {runs.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="extraction-run" className="text-xs text-ink-3">
            Run
          </label>
          <select
            id="extraction-run"
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            className={cx(inputClass, "max-w-full")}
          >
            {runs.map((item, index) => (
              <option key={String(item.id)} value={String(item.id)}>
                {`#${runs.length - index} · ${humanize(item.entrypoint)} · ${fmt.date(item.started_at, true)} · ${humanize(item.status)}`}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-3">{runs.length} runs for this post</span>
        </div>
      )}

      {run && (
        <section aria-label="Run summary" className="rounded-lg border border-line bg-surface">
          <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
            {[
              ["Status", <StatusBadge key="s" status={run.status} />],
              ["Entry point", capitalize(humanize(run.entrypoint))],
              ["Started", fmt.date(run.started_at, true)],
              ["Duration", ms(num(run.duration_ms))],
              ["Est. cost", usd(cost)],
              ["Tokens", fmt.number(tokens)],
              ["Calls", `${fmt.number(operations.length)}${failedCalls ? ` · ${failedCalls} failed` : ""}`],
            ].map(([label, value]) => (
              <div key={String(label)} className="-mr-px -mb-px border-r border-b border-line px-4 py-2.5">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd className="mt-0.5 text-[13px] font-medium text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {(str(run.error_message) || resultWarnings.length > 0) && (
            <div className="space-y-1 border-t border-line px-4 py-2.5 text-[13px]">
              {str(run.error_message) && (
                <p className="text-bad">
                  {str(run.error_code) ? `${run.error_code}: ` : ""}
                  {String(run.error_message)}
                </p>
              )}
              {resultWarnings.map((warning, index) => (
                <p key={index} className="text-warn">{warning}</p>
              ))}
            </div>
          )}
        </section>
      )}

      <div>
        <Tabs<SubTab>
          label="Extraction sections"
          idPrefix="extraction"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "summary", label: "Summary", count: issues.length || null },
            { id: "places", label: "Place check" },
            { id: "operations", label: "Operations", count: operations.length },
            { id: "log", label: "Event log", count: events.length },
            { id: "candidates", label: "Candidates", count: candidates.length },
            { id: "evidence", label: "Evidence", count: evidence.length },
            { id: "trace", label: "Trace & source" },
          ]}
        />
        <div className="mt-4">
          <TabPanel id={tab} idPrefix="extraction">
            {tab === "summary" && (
              <div className="space-y-4">
                <IssuesPanel issues={issues} />
                <Waterfall stages={stages} duration={num(run?.duration_ms)} />
                <Panel title="Run input and outcome">
                  <div className="grid gap-x-8 gap-y-4 md:grid-cols-3">
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-ink-3">Outcome</h4>
                      <FactList
                        items={Object.entries(RESULT_LABELS).map(([key, label]) => [
                          label,
                          typeof result[key] === "boolean"
                            ? result[key]
                              ? "Yes"
                              : "No"
                            : fmt.number(result[key], ""),
                        ])}
                      />
                    </div>
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-ink-3">Input</h4>
                      <FactList
                        items={Object.entries(record(legacy.input)).map(([key, value]) => [
                          humanize(key).replace(/^\w/, (c) => c.toUpperCase()),
                          fmt.number(value, ""),
                        ])}
                      />
                    </div>
                    <div>
                      <h4 className="mb-1 text-xs font-medium text-ink-3">Evidence by source</h4>
                      <FactList
                        items={Object.entries(
                          evidence.reduce<Record<string, number>>((groups, item) => {
                            const key = evidenceLabel(item.source_type);
                            groups[key] = (groups[key] ?? 0) + 1;
                            return groups;
                          }, {}),
                        )
                          .sort((a, b) => b[1] - a[1])
                          .map(([label, count]) => [label, fmt.number(count)])}
                      />
                    </div>
                  </div>
                </Panel>
              </div>
            )}
            {tab === "places" && (
              <PlaceInvestigation key={`${runId}-${placeQuery}`} detail={detail} runId={runId} initialQuery={placeQuery} />
            )}
            {tab === "operations" && <Operations operations={operations} />}
            {tab === "log" && <EventLog events={events} truncated={related.events_truncated === true} />}
            {tab === "candidates" && <Candidates candidates={candidates} evidenceById={evidenceById} />}
            {tab === "evidence" && <Evidence evidence={evidence} />}
            {tab === "trace" && (
              <div className="space-y-4">
                <TraceLog detail={detail} />
                <ApifyExtraction detail={detail} />
                <ApifyTraceDetails detail={detail} />
              </div>
            )}
          </TabPanel>
        </div>
      </div>
    </div>
  );
}

/** Latest run status and issue counts, for the post header banner. */
export function latestRunHealth(detail: PostDetail) {
  const runs = records(detail.related.runs).sort(
    (a, b) => (time(b.started_at) || 0) - (time(a.started_at) || 0),
  );
  const latest = runs[0];
  if (!latest) return null;
  const events = records(detail.related.events).filter((event) => event.run_id === latest.id);
  const failedCalls = records(detail.related.operations).filter(
    (operation) => operation.run_id === latest.id && operation.status === "failed",
  ).length;
  return {
    status: String(latest.status ?? ""),
    errors: events.filter((event) => event.level === "error").length + failedCalls,
    warnings: events.filter((event) => event.level === "warn").length,
    message: str(latest.error_message),
  };
}
