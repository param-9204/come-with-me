"use client";

import { Fragment, useState } from "react";

import { evidenceLabel, isRoutinePoll, stageLabel } from "@/lib/pipeline-issues";
import { type Data, type PostDetail } from "./post-components";
import { FactList, Panel, StatusBadge, cx, fmt } from "./ui";
import { CopyButton } from "./ui-client";

/*
 * Readable view of get_social_post_trace (migration v27). Every record keeps
 * an "all fields" expansion, so nothing in the trace is hidden; the summary
 * columns only decide what is visible before a row is opened.
 */

const asRecord = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const asRecords = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter((item): item is Data => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown) =>
  value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const ms = (value: unknown) => {
  const n = num(value);
  if (n === null) return "—";
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
};
const pct = (value: unknown) => (num(value) === null ? "—" : `${Math.round((num(value) ?? 0) * 100)}%`);
const usd = (value: unknown) => (num(value) === null ? "—" : `$${(num(value) ?? 0).toFixed(4)}`);

/** Every key of a record. Scalars inline; objects and arrays as collapsible JSON. */
function AllFields({ value }: { value: Data }) {
  const entries = Object.entries(value);
  if (!entries.length) return <p className="text-xs text-ink-3">No fields recorded.</p>;
  return (
    <dl className="divide-y divide-line rounded-md border border-line bg-surface text-xs">
      {entries.map(([key, item]) => {
        const nested = item !== null && typeof item === "object";
        const empty = item === null || item === "" || (Array.isArray(item) && !item.length) ||
          (nested && !Array.isArray(item) && !Object.keys(item as Data).length);
        return (
          <div key={key} className="grid gap-x-4 gap-y-1 px-3 py-1.5 sm:grid-cols-[200px_minmax(0,1fr)]">
            <dt className="font-mono text-ink-3 break-all">{key}</dt>
            <dd className="min-w-0 text-ink-2">
              {empty ? (
                <span className="text-ink-3">{item === null ? "null" : Array.isArray(item) ? "[]" : nested ? "{}" : "empty"}</span>
              ) : nested ? (
                <details>
                  <summary className="cursor-pointer text-ink-3 hover:text-ink">
                    {Array.isArray(item) ? `${item.length} items` : `${Object.keys(item as Data).length} fields`}
                    {" · "}
                    {fmt.number(JSON.stringify(item).length)} characters
                  </summary>
                  <pre className="mt-1 max-h-80 overflow-auto rounded border border-line bg-canvas p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all">
                    {JSON.stringify(item, null, 2)}
                  </pre>
                </details>
              ) : (
                <span className="font-mono break-all whitespace-pre-wrap">{String(item)}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

type Column = {
  label: string;
  render: (row: Data) => React.ReactNode;
  className?: string;
};

/** Table with summary columns; each row opens to every field of the record. */
function RecordTable({
  rows,
  columns,
  expand = (row) => row,
  empty,
  rowTone,
}: {
  rows: Data[];
  columns: Column[];
  expand?: (row: Data) => Data;
  empty: string;
  rowTone?: (row: Data) => string | undefined;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(50);
  if (!rows.length) return <p className="px-4 py-3 text-[13px] text-ink-3">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-line bg-subtle text-xs text-ink-3">
          <tr>
            <th scope="col" className="w-6 px-2 py-2"><span className="sr-only">Expand</span></th>
            {columns.map((column) => (
              <th key={column.label} scope="col" className={cx("px-3 py-2 font-medium whitespace-nowrap", column.className)}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.slice(0, limit).map((row, index) => {
            const expanded = open === index;
            return (
              <Fragment key={index}>
                <tr className={cx("align-top", rowTone?.(row))}>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={expanded ? "Hide all fields" : "Show all fields"}
                      onClick={() => setOpen(expanded ? null : index)}
                      className="grid h-5 w-5 cursor-pointer place-items-center rounded text-ink-3 hover:bg-subtle hover:text-ink"
                    >
                      <span aria-hidden className={cx("transition-transform", expanded && "rotate-90")}>›</span>
                    </button>
                  </td>
                  {columns.map((column) => (
                    <td key={column.label} className={cx("px-3 py-2", column.className)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={columns.length + 1} className="bg-canvas/40 px-4 py-3">
                      <AllFields value={expand(row)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length > limit && (
        <div className="border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setLimit(rows.length)}
            className="cursor-pointer text-xs font-medium text-accent hover:underline"
          >
            Show all {fmt.number(rows.length)} rows
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-md border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-2.5 hover:bg-subtle">
        <span aria-hidden className="text-ink-3 transition-transform group-open:rotate-90">›</span>
        <span className="text-[13px] font-medium text-ink">{title}</span>
        {count !== undefined && (
          <span className="rounded bg-subtle px-1.5 text-[11px] text-ink-2 tabular-nums">{fmt.number(count)}</span>
        )}
        {description && <span className="hidden text-xs text-ink-3 sm:inline">{description}</span>}
      </summary>
      <div className="border-t border-line">{children}</div>
    </details>
  );
}

const truncate = (value: unknown, length = 140) => {
  const text = str(value);
  if (!text) return <span className="text-ink-3">—</span>;
  return <span title={text.length > length ? text : undefined}>{text.length > length ? `${text.slice(0, length)}…` : text}</span>;
};
// Apify status polls log "partial" while the actor is still running.
const status = (row: Data) =>
  isRoutinePoll(row) ? <span className="text-xs text-ink-3">Routine poll</span> : <StatusBadge status={row.status} />;
const levelTone = (row: Data) =>
  row.level === "error" ? "bg-bad-soft/50" : row.level === "warn" ? "bg-warn-soft/40" : undefined;

const POST_KEY_FIELDS: Array<[string, string]> = [
  ["status", "Status"],
  ["platform", "Platform"],
  ["content_type", "Format"],
  ["author_username", "Creator"],
  ["short_code", "Short code"],
  ["post_url", "Post URL"],
  ["canonical_source_key", "Canonical key"],
  ["merged_into_post_id", "Merged into"],
  ["user_id", "Created by user"],
  ["place_id", "Primary place"],
  ["primary_category", "Category"],
  ["created_at", "Created"],
  ["error_message", "Error"],
];

function TracePost({
  value,
  index,
  total,
  operations,
}: {
  value: Data;
  index: number;
  total: number;
  /** Stage runs loaded directly from extraction_stage_runs by the post API. */
  operations: Data[];
}) {
  const post = asRecord(value.social_post);
  const links = asRecords(value.place_links);
  const legacy = asRecords(value.legacy_places);
  const diagnostics = asRecord(value.diagnostics);
  const extraction = asRecord(value.extraction);
  const runs = asRecords(extraction.runs);
  const summaries = asRecords(extraction.run_summaries);
  const events = asRecords(extraction.events);
  // get_social_post_trace aliases extraction_stage_runs as "stage", which
  // collides with its stage column, so to_jsonb(stage) returns only the stage
  // name. Use the rows the post API read directly when that happens.
  const traceStageRuns = Array.isArray(extraction.stage_runs) ? extraction.stage_runs : [];
  const stageRunsLost = traceStageRuns.some((item) => typeof item === "string");
  const runIds = new Set(runs.map((run) => String(run.id)));
  const stageRuns = stageRunsLost
    ? operations.filter((operation) => runIds.has(String(operation.run_id)))
    : asRecords(extraction.stage_runs);
  const evidence = asRecords(extraction.evidence);
  const candidates = asRecords(extraction.place_candidates);
  const runErrors = asRecords(diagnostics.run_errors);
  const failedStages = stageRunsLost
    ? stageRuns.filter((operation) => operation.status === "failed" || operation.status === "partial")
    : asRecords(diagnostics.failed_or_partial_stage_runs);
  const errorEvents = asRecords(diagnostics.error_events);
  const nonAccepted = asRecords(diagnostics.non_accepted_candidates);
  const knownKeys = new Set(["social_post_id", "social_post", "place_links", "legacy_places", "diagnostics", "extraction"]);
  const extraKeys = Object.entries(value).filter(([key]) => !knownKeys.has(key));
  const extraExtraction = Object.entries(extraction).filter(
    ([key]) => !["runs", "run_summaries", "events", "stage_runs", "evidence", "place_candidates"].includes(key),
  );
  const diagnosticsCount = runErrors.length + failedStages.length + errorEvents.length + nonAccepted.length + (str(diagnostics.post_error_message) ? 1 : 0);

  return (
    <article className="space-y-2">
      {total > 1 && (
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[13px] font-medium text-ink">Post record {index + 1} of {total}</h3>
          <span className="font-mono text-xs text-ink-3">{String(value.social_post_id ?? "—")}</span>
          <StatusBadge status={post.status} />
          {str(post.merged_into_post_id) && (
            <span className="text-xs text-ink-3">duplicate, merged into {String(post.merged_into_post_id)}</span>
          )}
        </header>
      )}

      <Section title="Saved place links" count={links.length} description="social_post_places joined to places" defaultOpen>
        <RecordTable
          rows={links}
          empty="No places were linked to this post record."
          expand={(row) => ({ ...asRecord(row.social_post_place), place: asRecord(row.place) })}
          columns={[
            {
              label: "Place",
              render: (row) => {
                const place = asRecord(row.place);
                return (
                  <>
                    <p className="font-medium text-ink">{str(place.name) ?? "Unnamed place"}</p>
                    <p className="text-xs text-ink-3">
                      {[place.address, place.neighborhood, place.city].filter((part) => str(part)).join(", ") || "No address"}
                    </p>
                  </>
                );
              },
            },
            { label: "Category", render: (row) => truncate(asRecord(row.place).category) },
            { label: "Confidence", className: "text-right tabular-nums", render: (row) => pct(asRecord(row.social_post_place).confidence) },
            {
              label: "First seen",
              className: "whitespace-nowrap tabular-nums",
              render: (row) => {
                const link = asRecord(row.social_post_place);
                const seconds = num(link.first_seen_at_seconds);
                return [
                  seconds !== null ? `${seconds}s` : null,
                  num(link.sequence_position) !== null ? `#${link.sequence_position} in list` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—";
              },
            },
            { label: "Why it was linked", className: "min-w-72", render: (row) => truncate(asRecord(row.social_post_place).explanation, 220) },
          ]}
        />
      </Section>

      <Section
        title="Diagnostics"
        count={diagnosticsCount}
        description="Run errors, failed or partial calls, error events and places that were not accepted"
        defaultOpen={diagnosticsCount > 0}
      >
        <div className="space-y-4 py-3">
          {str(diagnostics.post_error_message) && (
            <p className="mx-4 rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{String(diagnostics.post_error_message)}</p>
          )}
          <div>
            <h4 className="px-4 pb-1 text-xs font-medium text-ink-3">Places not accepted ({nonAccepted.length})</h4>
            <RecordTable
              rows={nonAccepted}
              empty="Every candidate was accepted."
              columns={[
                { label: "Candidate", render: (row) => <span className="font-medium text-ink">{str(row.name) ?? "Unnamed"}</span> },
                { label: "Decision", render: (row) => <StatusBadge status={row.decision === "save_failed" ? "failed" : row.decision} /> },
                { label: "Reason", className: "min-w-72", render: (row) => truncate(row.decision_reason, 260) },
              ]}
            />
          </div>
          <div>
            <h4 className="px-4 pb-1 text-xs font-medium text-ink-3">Failed or partial calls ({failedStages.length})</h4>
            <RecordTable
              rows={failedStages}
              empty="No failed or partial provider calls."
              columns={[
                { label: "Call", render: (row) => `${stageLabel(row.stage)} · ${String(row.operation ?? "").replace(/_/g, " ")}` },
                { label: "Provider", render: (row) => [row.provider, row.model].filter((part) => str(part)).join(" · ") || "—" },
                { label: "Status", render: status },
                { label: "Error", className: "min-w-64", render: (row) => truncate(row.error_message ?? row.error_code, 200) },
              ]}
            />
          </div>
          <div>
            <h4 className="px-4 pb-1 text-xs font-medium text-ink-3">Error events ({errorEvents.length})</h4>
            <RecordTable
              rows={errorEvents}
              empty="No error events."
              columns={[
                { label: "Stage", render: (row) => stageLabel(row.stage) },
                { label: "Message", className: "min-w-72", render: (row) => truncate(row.message, 260) },
                { label: "When", className: "whitespace-nowrap", render: (row) => fmt.date(row.occurred_at, true) },
              ]}
            />
          </div>
          <div>
            <h4 className="px-4 pb-1 text-xs font-medium text-ink-3">Run errors ({runErrors.length})</h4>
            <RecordTable
              rows={runErrors}
              empty="No run-level errors."
              columns={[
                { label: "Run", render: (row) => <span className="font-mono text-xs">{String(row.run_id ?? "—")}</span> },
                { label: "Status", render: status },
                { label: "Error", className: "min-w-64", render: (row) => truncate(row.error_message ?? row.error_code, 220) },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section title="Place candidates" count={candidates.length} description="Every place the model proposed, with the final decision">
        <RecordTable
          rows={candidates}
          empty="No candidates were logged."
          columns={[
            {
              label: "Candidate",
              render: (row) => (
                <>
                  <p className="font-medium text-ink">{str(row.name) ?? "Unnamed"}</p>
                  <p className="text-xs text-ink-3 lowercase">
                    {[row.category, row.neighborhood, row.city].filter((part) => str(part)).join(" · ")}
                  </p>
                </>
              ),
            },
            { label: "Decision", render: (row) => <StatusBadge status={row.decision === "save_failed" ? "failed" : row.decision} /> },
            { label: "Confidence", className: "text-right tabular-nums", render: (row) => pct(row.confidence) },
            { label: "Reason", className: "min-w-72", render: (row) => truncate(row.decision_reason, 220) },
            {
              label: "Evidence",
              className: "whitespace-nowrap",
              render: (row) => (Array.isArray(row.evidence_ids) ? (row.evidence_ids as string[]).join(", ") : "—"),
            },
          ]}
        />
      </Section>

      <Section title="Event log" count={events.length} description="Every pipeline event, in order">
        <RecordTable
          rows={events}
          empty="No events were logged."
          rowTone={levelTone}
          columns={[
            { label: "At", className: "whitespace-nowrap font-mono text-xs tabular-nums", render: (row) => `+${ms(row.elapsed_ms)}` },
            { label: "Stage", render: (row) => stageLabel(row.stage) },
            { label: "Level", render: (row) => <span className="text-xs capitalize">{String(row.level ?? "")}</span> },
            { label: "Message", className: "min-w-80", render: (row) => truncate(row.message, 240) },
          ]}
        />
      </Section>

      <Section title="Provider calls" count={stageRuns.length} description="extraction_stage_runs">
        {stageRunsLost && (
          <p className="border-b border-line bg-warn-soft px-4 py-2 text-xs text-warn">
            The trace function returned only stage names for these rows (a column-name clash in get_social_post_trace),
            so they are shown from extraction_stage_runs directly. {traceStageRuns.length} trace entries,{" "}
            {stageRuns.length} rows loaded.
          </p>
        )}
        <RecordTable
          rows={stageRuns}
          empty="No provider calls were logged."
          rowTone={(row) => (row.status === "failed" ? "bg-bad-soft/50" : undefined)}
          columns={[
            { label: "Call", render: (row) => `${stageLabel(row.stage)} · ${String(row.operation ?? "").replace(/_/g, " ")}` },
            { label: "Provider", render: (row) => [row.provider, row.model].filter((part) => str(part)).join(" · ") || "—" },
            { label: "Duration", className: "text-right tabular-nums", render: (row) => ms(row.duration_ms) },
            { label: "Tokens", className: "text-right tabular-nums", render: (row) => fmt.number(row.total_tokens) },
            { label: "Cost", className: "text-right tabular-nums", render: (row) => usd(row.estimated_cost_usd) },
            { label: "Status", render: status },
          ]}
        />
      </Section>

      <Section title="Evidence" count={evidence.length} description="Text the model read; candidates cite these ids">
        <RecordTable
          rows={evidence}
          empty="No evidence was logged."
          columns={[
            { label: "Id", className: "font-mono text-xs", render: (row) => String(row.evidence_id ?? "—") },
            { label: "Source", className: "whitespace-nowrap", render: (row) => evidenceLabel(row.source_type) },
            { label: "Text", className: "min-w-80", render: (row) => truncate(row.text_value, 240) },
            {
              label: "At",
              className: "whitespace-nowrap text-xs",
              render: (row) =>
                Array.isArray(row.timestamps_sec) && row.timestamps_sec.length
                  ? (row.timestamps_sec as unknown[]).slice(0, 4).map((t) => `${Number(t)}s`).join(", ")
                  : "—",
            },
          ]}
        />
      </Section>

      <Section title="Runs" count={runs.length} description="extraction_runs with their cost and candidate summaries">
        <RecordTable
          rows={runs}
          empty="No runs were logged."
          expand={(row) => ({
            ...row,
            summary: summaries.find((summary) => summary.id === row.id) ?? null,
          })}
          columns={[
            { label: "Started", className: "whitespace-nowrap", render: (row) => fmt.date(row.started_at, true) },
            { label: "Entry point", render: (row) => String(row.entrypoint ?? "—").replace(/-/g, " ") },
            { label: "Status", render: status },
            { label: "Duration", className: "text-right tabular-nums", render: (row) => ms(row.duration_ms) },
            {
              label: "Cost",
              className: "text-right tabular-nums",
              render: (row) => usd(summaries.find((summary) => summary.id === row.id)?.estimated_cost_usd),
            },
            { label: "Error", className: "min-w-56", render: (row) => truncate(row.error_message ?? row.error_code) },
          ]}
        />
      </Section>

      <Section title="Post record" description="Every column of social_posts, including raw scraper and AI payloads">
        <div className="space-y-3 p-4">
          <FactList
            columns={2}
            items={POST_KEY_FIELDS.map(([key, label]) => [
              label,
              key === "status" ? <StatusBadge key={key} status={post.status} /> : key === "created_at" ? fmt.date(post[key], true) : str(post[key]),
            ])}
          />
          <details>
            <summary className="cursor-pointer text-xs font-medium text-ink-3 hover:text-ink">
              All {Object.keys(post).length} fields
            </summary>
            <div className="mt-2">
              <AllFields value={post} />
            </div>
          </details>
        </div>
      </Section>

      {legacy.length > 0 && (
        <Section title="Legacy places" count={legacy.length} description="places.social_post_id links from before the junction table">
          <RecordTable
            rows={legacy}
            empty=""
            columns={[
              { label: "Place", render: (row) => <span className="font-medium text-ink">{str(row.name) ?? "Unnamed"}</span> },
              { label: "Address", className: "min-w-56", render: (row) => truncate(row.address) },
              { label: "Created", className: "whitespace-nowrap", render: (row) => fmt.date(row.created_at, true) },
            ]}
          />
        </Section>
      )}

      {(extraKeys.length > 0 || extraExtraction.length > 0) && (
        <Section title="Other trace fields" description="Fields this view has no dedicated table for">
          <div className="p-4">
            <AllFields value={Object.fromEntries([...extraKeys, ...extraExtraction])} />
          </div>
        </Section>
      )}
    </article>
  );
}

export default function ApifyTraceDetails({ detail }: { detail: PostDetail }) {
  const trace = asRecord(detail.related.trace_json);
  const posts = asRecords(trace.posts);
  const json = JSON.stringify(trace, null, 2);

  return (
    <Panel
      title="Complete extraction trace"
      description={`get_social_post_trace for short code ${str(trace.short_code) ?? "—"}. Open any row for every field.`}
      actions={
        Object.keys(trace).length ? (
          <CopyButton value={json} label="trace JSON">
            Copy JSON
          </CopyButton>
        ) : null
      }
    >
      {!Object.keys(trace).length ? (
        <p className="text-[13px] text-ink-3">No complete extraction trace is available for this short code yet.</p>
      ) : posts.length ? (
        <div className="space-y-6">
          {posts.length > 1 && (
            <p className="text-xs text-ink-3">
              {posts.length} post records share this short code (the canonical post and merged duplicates).
            </p>
          )}
          {posts.map((post, index) => (
            <TracePost
              key={String(post.social_post_id ?? index)}
              value={post}
              index={index}
              total={posts.length}
              operations={asRecords(detail.related.operations)}
            />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-3">The trace query completed but returned no matching post record.</p>
      )}
    </Panel>
  );
}
