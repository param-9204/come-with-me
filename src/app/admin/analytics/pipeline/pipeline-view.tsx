"use client";

import Link from "next/link";
import { Fragment, useState } from "react";

import type { PipelineIssue, PipelineReport } from "@/lib/admin-pipeline";
import { evidenceLabel, stageLabel, stageRank } from "@/lib/pipeline-issues";
import { BarList, ColumnChart } from "../../charts";
import {
  EmptyState,
  PageHeader,
  Panel,
  StatStrip,
  StatusBadge,
  cx,
  fmt,
  inputClass,
} from "../../ui";
import {
  AnalyticsNav,
  RangeControls,
  platformName,
  rangeLabel,
  useUrlUpdate,
} from "../controls";

type Metric = "runs" | "failedRuns" | "errors" | "cost";
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "runs", label: "Runs" },
  { key: "failedRuns", label: "Failed runs" },
  { key: "errors", label: "Errors" },
  { key: "cost", label: "Est. cost" },
];

const ms = (value: number | null) => {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
};
const usd = (value: number | null) =>
  value === null ? "—" : value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const rate = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "—";

const th = "px-3 py-2 font-medium whitespace-nowrap";
const DECISION_LABEL: Record<string, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  unresolved: "Unresolved (no verified location)",
  save_failed: "Save failed",
};

function LevelDot({ level }: { level: "warn" | "error" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", level === "error" ? "bg-bad" : "bg-warn")} />
      {level === "error" ? "Error" : "Warning"}
    </span>
  );
}

function Issues({ issues }: { issues: PipelineIssue[] }) {
  const [level, setLevel] = useState<"all" | "error" | "warn">("all");
  const [stage, setStage] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(15);
  const stages = [...new Set(issues.map((issue) => issue.stage))].sort(
    (a, b) => stageRank(a) - stageRank(b),
  );
  const term = query.trim().toLowerCase();
  const visible = issues.filter(
    (issue) =>
      (level === "all" || issue.level === level) &&
      (!stage || issue.stage === stage) &&
      (!term ||
        issue.signature.toLowerCase().includes(term) ||
        issue.samples.some((sample) => sample.toLowerCase().includes(term))),
  );
  const count = (target: "error" | "warn") =>
    issues.filter((issue) => issue.level === target).reduce((sum, issue) => sum + issue.count, 0);

  return (
    <Panel
      id="issues"
      title="Where errors come from"
      description="Warnings, errors, failed provider calls and failed runs, grouped by type. Open a row for the affected posts."
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <div role="group" aria-label="Level" className="flex rounded-md border border-line-strong p-0.5">
          {(
            [
              ["all", "All", count("error") + count("warn")],
              ["error", "Errors", count("error")],
              ["warn", "Warnings", count("warn")],
            ] as const
          ).map(([id, label, total]) => (
            <button
              key={id}
              type="button"
              aria-pressed={level === id}
              onClick={() => setLevel(id)}
              className={cx(
                "h-6 cursor-pointer rounded px-2 text-xs font-medium",
                level === id ? "bg-subtle text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {label} <span className="font-normal text-ink-3 tabular-nums">{fmt.number(total)}</span>
            </button>
          ))}
        </div>
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
          aria-label="Search issues"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages"
          className={cx(inputClass, "h-7 min-w-0 flex-1 text-xs sm:max-w-64")}
        />
        <span className="ml-auto text-xs text-ink-3 tabular-nums">
          {fmt.number(visible.length)} issue types
        </span>
      </div>
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-subtle text-xs text-ink-3">
              <tr>
                <th scope="col" className={th}>Level</th>
                <th scope="col" className={th}>Stage</th>
                <th scope="col" className={th}>Issue</th>
                <th scope="col" className={cx(th, "text-right")}>Times</th>
                <th scope="col" className={cx(th, "hidden text-right md:table-cell")}>Runs</th>
                <th scope="col" className={cx(th, "hidden text-right md:table-cell")}>Posts</th>
                <th scope="col" className={cx(th, "hidden text-right sm:table-cell")}>Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.slice(0, limit).map((issue) => {
                const expanded = open === issue.key;
                return (
                  <Fragment key={issue.key}>
                    <tr className="align-top">
                      <td className="px-3 py-2"><LevelDot level={issue.level} /></td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-2">{stageLabel(issue.stage)}</td>
                      <td className="w-full max-w-0 px-3 py-2">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : issue.key)}
                          className="min-w-64 cursor-pointer text-left text-ink hover:text-accent"
                        >
                          <span aria-hidden className={cx("mr-1 inline-block text-ink-3 transition-transform", expanded && "rotate-90")}>
                            ›
                          </span>
                          {issue.signature.charAt(0).toUpperCase() + issue.signature.slice(1)}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-ink tabular-nums">{fmt.number(issue.count)}</td>
                      <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">{fmt.number(issue.runs)}</td>
                      <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">{fmt.number(issue.postCount)}</td>
                      <td
                        className="hidden px-3 py-2 text-right whitespace-nowrap text-ink-3 sm:table-cell"
                        title={fmt.date(issue.lastSeen, true)}
                        suppressHydrationWarning
                      >
                        {fmt.relative(issue.lastSeen)}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={7} className="bg-canvas/40 px-4 py-3">
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                            <div>
                              <p className="mb-1.5 text-xs font-medium text-ink-3">Example messages</p>
                              <ul className="space-y-1">
                                {issue.samples.map((sample, index) => (
                                  <li key={index} className="text-xs break-words text-ink-2">{sample}</li>
                                ))}
                              </ul>
                              <p className="mt-2 text-xs text-ink-3">
                                First seen {fmt.date(issue.firstSeen, true)} · last seen {fmt.date(issue.lastSeen, true)}
                              </p>
                            </div>
                            <div>
                              <p className="mb-1.5 text-xs font-medium text-ink-3">
                                Affected posts {issue.postCount > issue.posts.length && `(first ${issue.posts.length} of ${fmt.number(issue.postCount)})`}
                              </p>
                              {issue.posts.length ? (
                                <ul className="flex flex-wrap gap-1.5">
                                  {issue.posts.map((post) => (
                                    <li key={post.id}>
                                      <Link
                                        href={`/admin/${post.id}#extraction`}
                                        className="inline-block rounded bg-surface px-1.5 py-0.5 text-xs text-ink-2 ring-1 ring-line hover:text-accent"
                                      >
                                        {post.label}
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-xs text-ink-3">These runs were not linked to a post.</p>
                              )}
                            </div>
                          </div>
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
          title={issues.length ? "No issues match these filters" : "No warnings or errors in this period"}
        />
      )}
      {visible.length > limit && (
        <div className="border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setLimit((current) => current + 25)}
            className="cursor-pointer text-xs font-medium text-accent hover:underline"
          >
            Show more ({fmt.number(visible.length - limit)} remaining)
          </button>
        </div>
      )}
    </Panel>
  );
}

export default function PipelineView({ report }: { report: PipelineReport }) {
  const { isPending, update } = useUrlUpdate();
  const [metric, setMetric] = useState<Metric>("runs");
  const [runLimit, setRunLimit] = useState(15);
  const { range, kpis } = report;
  const vsLabel =
    range.key === "all"
      ? ""
      : ` · compared with ${fmt.day(report.previous.from, true)} – ${fmt.day(report.previous.to, true)}`;
  const loggingStart = report.loggingStartedAt?.slice(0, 10) ?? null;
  const totalCandidates = report.decisions.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description={`${rangeLabel(range)}: ${fmt.day(range.from, true)} – ${fmt.day(range.to, true)} (UTC)${vsLabel}`}
      />
      <AnalyticsNav />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <RangeControls key={`${range.from}-${range.to}`} range={range} update={update} />
        <select
          aria-label="Platform"
          value={report.scope.platform ?? ""}
          onChange={(event) => update({ platform: event.target.value })}
          className={cx(inputClass, "self-start")}
        >
          <option value="">All platforms</option>
          {report.platforms.map((platform) => (
            <option key={platform} value={platform}>
              {platformName(platform)}
            </option>
          ))}
        </select>
      </div>

      {loggingStart && range.from < loggingStart && (
        <p className="text-xs text-ink-3">
          Pipeline audit logging began on {fmt.day(loggingStart, true)}; earlier days have no run data.
        </p>
      )}
      {report.warnings.length > 0 && (
        <p role="status" className="rounded-md border border-line bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Some log tables could not be read, so totals may be low: {report.warnings.join("; ")}
        </p>
      )}

      <div aria-busy={isPending} className={cx("space-y-5 transition-opacity", isPending && "opacity-60")}>
        <StatStrip
          items={[
            {
              label: "Extraction runs",
              value: fmt.number(kpis.runs.value),
              delta: kpis.runs,
              hint: kpis.stuckRuns
                ? `${kpis.stuckRuns} still "running" after 30 min`
                : undefined,
            },
            {
              label: "Failed runs",
              value: fmt.percent(kpis.failureRate, 1),
              hint: `${fmt.number(kpis.failedRuns.value)} failed · ${fmt.percent(kpis.partialRate)} partial`,
            },
            {
              label: "Errors",
              value: fmt.number(kpis.errorEvents.value),
              delta: kpis.errorEvents,
              hint: "Error events and failed provider calls",
            },
            {
              label: "Run duration",
              value: ms(kpis.p50Duration),
              hint: `median · p95 ${ms(kpis.p95Duration)}`,
            },
            {
              label: "Est. AI and API cost",
              value: usd(kpis.cost.value),
              delta: kpis.cost,
              hint: `${usd(kpis.costPerRun)} per run · ${fmt.compact(kpis.tokens)} tokens`,
            },
            {
              label: "Places accepted",
              value: fmt.number(kpis.acceptedPlaces),
              hint: `${fmt.percent(kpis.unresolvedShare)} of candidates unresolved`,
            },
          ]}
        />

        <Panel
          title="Over time"
          description={`Per ${report.granularity}, UTC${metric === "cost" ? ". Cost is an estimate from logged token counts, not an invoice." : ""}`}
          actions={
            <div role="group" aria-label="Chart metric" className="flex flex-wrap rounded-md border border-line-strong p-0.5">
              {METRICS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={metric === item.key}
                  onClick={() => setMetric(item.key)}
                  className={cx(
                    "h-6 cursor-pointer rounded px-2 text-xs font-medium",
                    metric === item.key ? "bg-subtle text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          }
        >
          <ColumnChart
            key={`${metric}-${range.from}-${range.to}`}
            seriesLabel={METRICS.find((item) => item.key === metric)?.label ?? "Runs"}
            granularity={report.granularity}
            valueFormat={metric === "cost" ? "usd" : "count"}
            height={220}
            points={report.series.map((point) => ({ date: point.date, value: point[metric] }))}
          />
        </Panel>

        <Issues issues={report.issues} />

        <div className="grid gap-5 2xl:grid-cols-2">
          <Panel
            title="Stage health"
            description="Provider calls per stage. Routine scrape polls are excluded."
            flush
          >
            {report.stages.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-line bg-subtle text-xs text-ink-3">
                    <tr>
                      <th scope="col" className={th}>Stage</th>
                      <th scope="col" className={cx(th, "text-right")}>Calls</th>
                      <th scope="col" className={cx(th, "text-right")}>Failed</th>
                      <th scope="col" className={cx(th, "text-right")}>Degraded</th>
                      <th scope="col" className={cx(th, "text-right")}>p50 / p95</th>
                      <th scope="col" className={cx(th, "text-right")}>Warn / err</th>
                      <th scope="col" className={cx(th, "text-right")}>Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {report.stages.map((stage) => (
                      <tr key={stage.stage}>
                        <td className="px-3 py-2 text-ink">
                          {stageLabel(stage.stage)}
                          {(stage.fallbacks > 0 || stage.retries > 0) && (
                            <span className="block text-xs text-ink-3">
                              {[stage.retries && `${stage.retries} retries`, stage.fallbacks && `${stage.fallbacks} fallbacks`]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{stage.calls ? fmt.number(stage.calls) : "—"}</td>
                        <td className={cx("px-3 py-2 text-right whitespace-nowrap tabular-nums", stage.failed ? "text-bad" : "text-ink-3")}>
                          {stage.calls ? `${fmt.number(stage.failed)} · ${rate(stage.failed, stage.calls)}` : "—"}
                        </td>
                        <td className={cx("px-3 py-2 text-right tabular-nums", stage.degraded ? "text-warn" : "text-ink-3")}>
                          {stage.calls ? fmt.number(stage.degraded) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap text-ink-2 tabular-nums">
                          {stage.calls ? `${ms(stage.p50)} / ${ms(stage.p95)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">
                          {fmt.number(stage.warnings)} / {fmt.number(stage.errors)}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{stage.cost ? usd(stage.cost) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No stage activity in this period" />
            )}
          </Panel>

          <Panel title="Providers" description="Every external model and API the pipeline called" flush>
            {report.providers.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-line bg-subtle text-xs text-ink-3">
                    <tr>
                      <th scope="col" className={th}>Provider · model</th>
                      <th scope="col" className={cx(th, "text-right")}>Calls</th>
                      <th scope="col" className={cx(th, "text-right")}>Failed</th>
                      <th scope="col" className={cx(th, "text-right")}>p50 / p95</th>
                      <th scope="col" className={cx(th, "text-right")}>Tokens</th>
                      <th scope="col" className={cx(th, "text-right")}>Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {report.providers.map((provider) => (
                      <tr key={provider.key} className="align-top">
                        <td className="max-w-0 px-3 py-2">
                          <p className="min-w-40 truncate text-ink" title={provider.model ?? undefined}>
                            {provider.provider === "unknown" ? "Provider not recorded" : provider.provider}
                            {provider.model && <span className="text-ink-3"> · {provider.model}</span>}
                          </p>
                          {provider.lastError && (
                            <p className="truncate text-xs text-bad" title={provider.lastError}>
                              {provider.lastError}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{fmt.number(provider.calls)}</td>
                        <td className={cx("px-3 py-2 text-right whitespace-nowrap tabular-nums", provider.failed ? "text-bad" : "text-ink-3")}>
                          {fmt.number(provider.failed)} · {rate(provider.failed, provider.calls)}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap text-ink-2 tabular-nums">
                          {ms(provider.p50)} / {ms(provider.p95)}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{provider.tokens ? fmt.compact(provider.tokens) : "—"}</td>
                        <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{provider.cost ? usd(provider.cost) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No provider calls in this period" />
            )}
          </Panel>
        </div>

        <Panel
          title="Failed and partial runs"
          description="Most recent first. Runs still marked running after 30 minutes are included."
          flush
        >
          {report.problemRuns.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-subtle text-xs text-ink-3">
                  <tr>
                    <th scope="col" className={th}>Started</th>
                    <th scope="col" className={th}>Post</th>
                    <th scope="col" className={th}>Status</th>
                    <th scope="col" className={th}>What went wrong</th>
                    <th scope="col" className={cx(th, "hidden text-right md:table-cell")}>Err / warn</th>
                    <th scope="col" className={cx(th, "hidden text-right md:table-cell")}>Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.problemRuns.slice(0, runLimit).map((run) => (
                    <tr key={run.id} className="align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-ink-3" title={fmt.date(run.startedAt, true)} suppressHydrationWarning>
                        {fmt.relative(run.startedAt)}
                      </td>
                      <td className="px-3 py-2">
                        {run.postId ? (
                          <Link href={`/admin/${run.postId}#extraction`} className="whitespace-nowrap text-ink hover:text-accent hover:underline">
                            {run.postLabel ?? "Open post"}
                          </Link>
                        ) : (
                          <span className="block max-w-48 truncate text-ink-3" title={run.inputUrl ?? undefined}>
                            {run.inputUrl ?? "No post"}
                          </span>
                        )}
                        <span className="block text-xs text-ink-3 capitalize">
                          {[run.platform && platformName(run.platform), run.entrypoint?.replace(/-/g, " ")].filter(Boolean).join(" · ")}
                        </span>
                      </td>
                      <td className="px-3 py-2"><StatusBadge status={run.status} /></td>
                      <td className="w-full max-w-0 px-3 py-2">
                        <p className="min-w-56 text-xs break-words text-ink-2">{run.error ?? "Completed with warnings; see the post's Extraction tab"}</p>
                      </td>
                      <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">
                        {run.errors} / {run.warnings}
                      </td>
                      <td className="hidden px-3 py-2 text-right whitespace-nowrap text-ink-2 tabular-nums md:table-cell">{ms(run.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No failed or partial runs in this period" />
          )}
          {report.problemRuns.length > runLimit && (
            <div className="border-t border-line px-3 py-2">
              <button
                type="button"
                onClick={() => setRunLimit(report.problemRuns.length)}
                className="cursor-pointer text-xs font-medium text-accent hover:underline"
              >
                Show {report.problemRuns.length - runLimit} more
              </button>
            </div>
          )}
        </Panel>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Panel title="Candidate decisions" description={`${fmt.number(totalCandidates)} places proposed by the model`}>
            <BarList
              items={report.decisions.map((item) => ({
                key: item.key,
                label: DECISION_LABEL[item.key] ?? item.key,
                count: item.count,
              }))}
            />
          </Panel>
          <Panel title="Why places were dropped" description="Rejected, unresolved and failed saves, grouped by reason" flush>
            {report.dropReasons.length ? (
              <ul className="divide-y divide-line">
                {report.dropReasons.map((reason) => (
                  <li key={reason.key} className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 text-[13px] text-ink">
                      {reason.signature}
                      <span className="block text-xs text-ink-3">{DECISION_LABEL[reason.decision] ?? reason.decision}</span>
                    </span>
                    <span className="shrink-0 text-[13px] text-ink-2 tabular-nums">{fmt.number(reason.count)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-[13px] text-ink-3">No candidates were dropped in this period.</p>
            )}
          </Panel>
          <Panel title="Evidence sources" description="Where the text the model read came from">
            <BarList
              items={report.evidenceSources.map((item) => ({
                key: item.key,
                label: evidenceLabel(item.key),
                count: item.count,
              }))}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
