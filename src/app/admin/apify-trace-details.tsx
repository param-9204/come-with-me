"use client";

import { type Data, type PostDetail, Section } from "./post-components";

type TraceValue =
  | null
  | boolean
  | number
  | string
  | TraceValue[]
  | { [key: string]: TraceValue };

const asRecord = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const asRecords = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Data =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
const humanize = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const isUrl = (value: string) => /^https?:\/\//i.test(value);
const firstText = (...values: unknown[]) => {
  const value = values.find(
    (item): item is string => typeof item === "string" && Boolean(item.trim()),
  );
  return value?.trim() || null;
};
const identifier = (record: Data, fallback: string) => {
  const value = [
    record.short_code,
    record.content_id,
    record.external_run_id,
    record.candidate_key,
    record.name,
    record.stage,
    record.id,
  ].find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value : fallback;
};

function cardHeaderDetails(title: string, record: Data) {
  if (/^evidence\b/i.test(title)) {
    const snippet = asRecords(record.snippets)[0] || {};
    const id = firstText(
      record.id,
      record.evidence_id,
      snippet.id,
      Array.isArray(record.ids) ? record.ids[0] : null,
    );
    const content = firstText(record.text, record.text_value, snippet.text);
    return id || content
      ? { primary: id || "Evidence", secondary: content }
      : null;
  }

  if (/^place candidates?\b/i.test(title)) {
    const name = firstText(record.name, record.place_name);
    const city = firstText(record.city, record.place_city);
    return name || city
      ? { primary: name || "Unnamed place", secondary: city }
      : null;
  }

  return null;
}

function Value({
  value,
  fieldName,
  depth = 0,
}: {
  value: unknown;
  fieldName: string;
  depth?: number;
}) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-zinc-500">Not recorded</span>;
  }

  if (typeof value === "string") {
    if (isUrl(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="break-all text-sm text-indigo-300 hover:text-indigo-200"
        >
          {value}
        </a>
      );
    }
    return (
      <p className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">
        {value || "Not recorded"}
      </p>
    );
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-sm text-zinc-200">{String(value)}</p>;
  }

  if (Array.isArray(value)) {
    if (!value.length)
      return <span className="text-sm text-zinc-500">No records</span>;
    if (value.every(isScalar)) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item, index) => (
            <span
              key={`${fieldName}-${index}`}
              className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
            >
              {item === null ? "Not recorded" : String(item)}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {value.map((item, index) => (
          <RecordCard
            key={`${fieldName}-${index}`}
            title={`${humanize(fieldName)} ${index + 1}`}
            value={item}
            depth={depth + 1}
          />
        ))}
      </div>
    );
  }

  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/60">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white">
        View {humanize(fieldName)} details
      </summary>
      <div className="border-t border-zinc-800 p-3">
        <RecordFields value={asRecord(value)} depth={depth + 1} />
      </div>
    </details>
  );
}

function RecordFields({ value, depth = 0 }: { value: Data; depth?: number }) {
  const fields = Object.entries(value);
  if (!fields.length)
    return <p className="text-sm text-zinc-500">No fields were recorded.</p>;

  return (
    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
      {fields.map(([key, fieldValue]) => {
        const wide =
          !isScalar(fieldValue) ||
          (typeof fieldValue === "string" && fieldValue.length > 100);
        return (
          <div key={key} className={wide ? "sm:col-span-2" : undefined}>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
              {humanize(key)}
            </p>
            <Value value={fieldValue} fieldName={key} depth={depth} />
          </div>
        );
      })}
    </div>
  );
}

function RecordCard({
  title,
  value,
  depth = 0,
}: {
  title: string;
  value: unknown;
  depth?: number;
}) {
  const record = asRecord(value);
  const headerDetails = cardHeaderDetails(title, record);
  if (!Object.keys(record).length) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <p className="text-sm text-zinc-500">{title}: no recorded fields.</p>
      </div>
    );
  }

  return (
    <details className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
      <summary className="cursor-pointer list-none px-4 py-3 transition hover:bg-zinc-900/60">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold text-zinc-100">{title}</p>
            {!headerDetails && (
              <p className="mt-1 truncate text-xs text-zinc-500">
                {identifier(record, "Recorded data")}
              </p>
            )}
          </div>
          {headerDetails && (
            <div className="min-w-0 text-right">
              <p className="font-semibold text-indigo-200">
                {headerDetails.primary}
              </p>
              {headerDetails.secondary && (
                <p
                  title={headerDetails.secondary}
                  className="mt-1 max-w-[28rem] truncate text-xs text-zinc-400"
                >
                  {headerDetails.secondary}
                </p>
              )}
            </div>
          )}
        </div>
      </summary>
      <div className="border-t border-zinc-800 p-4">
        <RecordFields value={record} depth={depth} />
      </div>
    </details>
  );
}

function TracePost({ value, index }: { value: Data; index: number }) {
  const groups: Array<[string, unknown]> = [
    ["Social post record", value.social_post],
    ["Place links", value.place_links],
    ["Legacy places", value.legacy_places],
    ["Diagnostics", value.diagnostics],
    ["Extraction records", value.extraction],
  ];
  const knownKeys = new Set([
    "social_post_id",
    "social_post",
    "place_links",
    "legacy_places",
    "diagnostics",
    "extraction",
  ]);
  const extraGroups = Object.entries(value).filter(
    ([key]) => !knownKeys.has(key),
  );
  const postId =
    typeof value.social_post_id === "string" ? value.social_post_id : null;

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/55">
      <header className="border-b border-zinc-800 bg-zinc-950/40 px-5 py-4">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-300">
          Trace post {index + 1}
        </p>
        <p className="mt-1 break-all font-semibold text-zinc-100">
          {postId || "Post ID not recorded"}
        </p>
      </header>
      <div className="space-y-4 p-5">
        {groups.map(([title, group]) => (
          <RecordCard key={title} title={title} value={group} />
        ))}
        {extraGroups.map(([key, group]) => (
          <RecordCard key={key} title={humanize(key)} value={group} />
        ))}
      </div>
    </article>
  );
}

export default function ApifyTraceDetails({ detail }: { detail: PostDetail }) {
  const trace = asRecord(detail.related.trace_json);
  const posts = asRecords(trace.posts);
  const topLevelFields = Object.entries(trace).filter(
    ([key]) => key !== "posts",
  );

  return (
    <Section
      title="Complete extraction trace"
      note="Readable result from get_social_post_trace"
    >
      {!Object.keys(trace).length ? (
        <p className="text-sm text-zinc-500">
          No complete extraction trace is available for this short code yet.
        </p>
      ) : (
        <div className="space-y-5">
          {topLevelFields.length > 0 && (
            <div className="rounded-xl border border-indigo-400/20 bg-indigo-400/5 p-4">
              <RecordFields value={Object.fromEntries(topLevelFields)} />
            </div>
          )}
          {posts.length ? (
            <div className="space-y-5">
              {posts.map((post, index) => (
                <TracePost
                  key={identifier(post, `post-${index}`)}
                  value={post}
                  index={index}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              The trace query completed but did not return a matching post
              record.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
