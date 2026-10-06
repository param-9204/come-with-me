"use client";

import { useMemo, useState } from "react";

import { evidenceLabel, stageLabel } from "@/lib/pipeline-issues";
import { collectPlaces, type Data, type PostDetail, record, records, strings } from "./post-components";
import { EmptyState, Panel, cx, inputClass } from "./ui";

/*
 * Answers "why wasn't X found?" and "why was Y added?" for one run by
 * collecting every logged trace of a place name: model proposals, candidate
 * decisions, geocode searches and results, save decisions, saved links and
 * the evidence text the model read.
 */

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown) =>
  value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

/** Lowercase, strip accents and punctuation so "Café %Arabica" matches "cafe arabica". */
export function normalizeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP = new Set(["the", "and", "cafe", "coffee", "bar", "restaurant", "nyc", "new", "york", "of"]);

/** True when every meaningful word of the name appears in the text. */
function mentions(haystack: string, needle: string) {
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const words = needle.split(" ").filter((word) => word.length > 2 && !STOP.has(word));
  return words.length > 0 && words.every((word) => new RegExp(`\\b${word}\\b`).test(haystack));
}

type Outcome = "saved" | "rejected" | "unresolved" | "save_failed" | "proposed" | "evidence_only" | "not_seen";

const OUTCOME_COPY: Record<Outcome, { label: string; tone: string }> = {
  saved: { label: "Saved", tone: "bg-good" },
  rejected: { label: "Rejected", tone: "bg-bad" },
  unresolved: { label: "Not saved: no verified location", tone: "bg-warn" },
  save_failed: { label: "Save failed", tone: "bg-bad" },
  proposed: { label: "Proposed, then dropped", tone: "bg-warn" },
  evidence_only: { label: "In the text, never proposed", tone: "bg-warn" },
  not_seen: { label: "Never seen", tone: "bg-line-strong" },
};

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const copy = OUTCOME_COPY[outcome];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", copy.tone)} />
      {copy.label}
    </span>
  );
}

type StoryItem = {
  key: string;
  at: number | null;
  stage: string;
  level: string;
  kind: "event" | "operation" | "candidate" | "link";
  title: string;
  detail: Data | null;
};

type RunData = {
  events: Data[];
  operations: Data[];
  candidates: Data[];
  evidence: Data[];
  places: Data[];
  links: Data[];
  runStart: number;
};

/** Every proposal list the model logged ("Model returned N candidate(s)"). */
function proposedNames(events: Data[]) {
  const names = new Map<string, string>();
  for (const event of events) {
    for (const candidate of records(record(event.data).candidates)) {
      const name = str(candidate.name);
      if (name) names.set(normalizeName(name), name);
    }
  }
  return names;
}

function investigate(term: string, data: RunData) {
  const needle = normalizeName(term);
  const placeById = new Map(data.places.map((place) => [String(place.id), place]));
  const savedPlaces = data.places.filter((place) => mentions(normalizeName(String(place.name ?? "")), needle));
  const candidates = data.candidates.filter((candidate) =>
    mentions(normalizeName(String(candidate.name ?? "")), needle) ||
    (candidate.place_id && savedPlaces.some((place) => place.id === candidate.place_id)),
  );
  const proposals = [...proposedNames(data.events).entries()].filter(([key]) => mentions(key, needle));
  const evidence = data.evidence.filter((item) => mentions(normalizeName(String(item.text_value ?? "")), needle));

  const story: StoryItem[] = [];
  for (const event of data.events) {
    const haystack = normalizeName(`${event.message ?? ""} ${JSON.stringify(event.data ?? {})}`);
    if (!mentions(haystack, needle)) continue;
    // Surface the chosen geocode result and its similarity in the line itself.
    const chosen = record(record(event.data).chosen);
    const similarity = num(chosen.similarity);
    const chosenText = [
      similarity !== null ? `${Math.round(similarity * 100)}% name similarity` : null,
      str(chosen.address),
    ]
      .filter(Boolean)
      .join(" · ");
    story.push({
      key: `e${event.id}`,
      at: num(event.elapsed_ms),
      stage: String(event.stage),
      level: String(event.level),
      kind: "event",
      title: chosenText ? `${event.message} (${chosenText})` : String(event.message),
      detail: record(event.data),
    });
  }
  for (const operation of data.operations) {
    const request = record(operation.request_summary);
    const haystack = normalizeName(`${JSON.stringify(request)} ${JSON.stringify(operation.result_summary ?? {})}`);
    if (operation.stage !== "geocode" || !mentions(haystack, needle)) continue;
    const result = record(operation.result_summary);
    const started = Date.parse(String(operation.started_at));
    story.push({
      key: `o${operation.id}`,
      at: Number.isFinite(started) && Number.isFinite(data.runStart) ? started - data.runStart : null,
      stage: "geocode",
      level: operation.status === "failed" ? "error" : operation.status === "partial" ? "warn" : "info",
      kind: "operation",
      title: `Location lookup for "${str(request.name) ?? term}" via ${str(result.provider) ?? str(operation.provider) ?? "unknown provider"}: ${
        result.verified === true ? "verified" : result.verified === false ? "not verified" : String(operation.status)
      }${str(result.identity) ? ` (${result.identity} name match)` : ""}`,
      detail: { request, result, duration_ms: operation.duration_ms, provider: operation.provider, model: operation.model },
    });
  }
  for (const candidate of candidates) {
    story.push({
      key: `c${candidate.id}`,
      at: null,
      stage: "candidates",
      level: candidate.decision === "accepted" ? "info" : "warn",
      kind: "candidate",
      title: `Final decision for "${candidate.name}": ${String(candidate.decision).replace(/_/g, " ")}${
        str(candidate.decision_reason) ? ` — ${candidate.decision_reason}` : ""
      }`,
      detail: candidate,
    });
  }
  for (const link of data.links) {
    const place = placeById.get(String(link.place_id));
    if (!place || !savedPlaces.includes(place)) continue;
    story.push({
      key: `l${link.id ?? link.place_id}`,
      at: null,
      stage: "db",
      level: "info",
      kind: "link",
      title: `Saved and linked to this post as "${place.name}"${num(link.confidence) !== null ? ` (${Math.round((num(link.confidence) ?? 0) * 100)}% confidence)` : ""}`,
      detail: { ...link, place },
    });
  }
  story.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  const decided = candidates.find((candidate) => candidate.decision === "accepted") ?? candidates[0];
  const outcome: Outcome = savedPlaces.length
    ? "saved"
    : decided
      ? ((decided.decision === "accepted" ? "save_failed" : decided.decision) as Outcome)
      : proposals.length
        ? "proposed"
        : evidence.length
          ? "evidence_only"
          : "not_seen";
  return { outcome, savedPlaces, candidates, proposals, evidence, story };
}

const VERDICTS: Record<Outcome, (term: string) => string> = {
  saved: () => "This place was found and saved. The steps below show the evidence and location lookup behind it.",
  rejected: () =>
    "The model proposed this place, but a later check rejected it. The decision reason explains which rule removed it.",
  unresolved: () =>
    "The model proposed this place, but no lookup returned a location close enough to verify, so it was not saved.",
  save_failed: () => "The place passed every check but the database save failed.",
  proposed: () =>
    "The model listed this name, but it never reached a final decision. It was likely merged with another name or filtered as a duplicate; check the events below.",
  evidence_only: () =>
    "The name appears in the text the model read, but the model never proposed it as a place. This is a model recall miss, not a lookup problem.",
  not_seen: (term) =>
    `"${term}" does not appear in the caption, comments, speech or on-screen text that the pipeline read. If it is in the video, OCR or transcription missed it, or it only appears visually without readable text.`,
};

function StoryList({ story }: { story: StoryItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!story.length) return <p className="px-4 py-3 text-[13px] text-ink-3">No log entries mention this name.</p>;
  return (
    <ol className="divide-y divide-line">
      {story.map((item) => {
        const expanded = open === item.key;
        const hasDetail = item.detail && Object.keys(item.detail).length > 0;
        return (
          <li key={item.key}>
            <button
              type="button"
              disabled={!hasDetail}
              aria-expanded={hasDetail ? expanded : undefined}
              onClick={() => setOpen(expanded ? null : item.key)}
              className="grid w-full grid-cols-[56px_80px_minmax(0,1fr)] items-baseline gap-3 px-4 py-2 text-left enabled:cursor-pointer enabled:hover:bg-subtle max-sm:grid-cols-[minmax(0,1fr)]"
            >
              <span className="font-mono text-xs text-ink-3 tabular-nums max-sm:hidden">
                {item.at === null ? "" : `+${(item.at / 1000).toFixed(1)}s`}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-ink-3 max-sm:hidden">
                <span
                  aria-hidden
                  className={cx(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    item.level === "error" ? "bg-bad" : item.level === "warn" ? "bg-warn" : "bg-line-strong",
                  )}
                />
                {stageLabel(item.stage)}
              </span>
              <span className="min-w-0 text-[13px] break-words text-ink">
                {item.title}
                {hasDetail && <span aria-hidden className="ml-1.5 text-ink-3">{expanded ? "▾" : "▸"}</span>}
              </span>
            </button>
            {expanded && hasDetail && (
              <pre className="mx-4 mb-2 max-h-72 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[11px] leading-5 text-ink-2">
                {JSON.stringify(item.detail, null, 2)}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  const words = normalizeName(term)
    .split(" ")
    .filter((word) => word.length > 2)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        index % 2 ? (
          <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default function PlaceInvestigation({
  detail,
  runId,
  initialQuery = "",
}: {
  detail: PostDetail;
  runId: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const related = detail.related;
  const data: RunData = useMemo(() => {
    const byRun = (items: Data[]) => items.filter((item) => String(item.run_id) === runId);
    const run = records(related.runs).find((item) => String(item.id) === runId);
    return {
      events: byRun(records(related.events)),
      operations: byRun(records(related.operations)),
      candidates: byRun(records(related.candidates)),
      evidence: byRun(records(related.evidence)),
      places: collectPlaces(detail).places,
      links: records(related.place_links),
      runStart: run ? Date.parse(String(run.started_at)) : NaN,
    };
  }, [detail, related, runId]);

  // Every name the run considered, merged across sources.
  const rows = useMemo(() => {
    const byKey = new Map<string, { name: string; outcome: Outcome; why: string | null; location: string | null; sources: string[] }>();
    const linkByPlace = new Map(data.links.map((link) => [String(link.place_id), link]));
    for (const place of data.places) {
      const name = String(place.name ?? "Unnamed place");
      const candidate = data.candidates.find((item) => item.place_id === place.id) ??
        data.candidates.find((item) => normalizeName(String(item.name ?? "")) === normalizeName(name));
      const link = linkByPlace.get(String(place.id));
      byKey.set(normalizeName(name), {
        name,
        outcome: "saved",
        why: str(candidate?.decision_reason) ?? str(link?.explanation),
        location: [place.address, place.neighborhood, place.city].filter((part) => str(part)).join(", ") || null,
        sources: strings(candidate?.evidence_sources),
      });
    }
    for (const candidate of data.candidates) {
      const key = normalizeName(String(candidate.name ?? ""));
      if (!key || byKey.has(key) || (candidate.place_id && data.places.some((place) => place.id === candidate.place_id))) continue;
      byKey.set(key, {
        name: String(candidate.name),
        outcome: (candidate.decision === "accepted" ? "save_failed" : candidate.decision) as Outcome,
        why: str(candidate.decision_reason),
        location: [candidate.address, candidate.neighborhood, candidate.city].filter((part) => str(part)).join(", ") || null,
        sources: strings(candidate.evidence_sources),
      });
    }
    for (const [key, name] of proposedNames(data.events)) {
      if ([...byKey.keys()].some((existing) => mentions(existing, key) || mentions(key, existing))) continue;
      byKey.set(key, { name, outcome: "proposed", why: null, location: null, sources: [] });
    }
    const order: Outcome[] = ["saved", "save_failed", "unresolved", "rejected", "proposed"];
    return [...byKey.values()].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome) || a.name.localeCompare(b.name));
  }, [data]);

  const term = query.trim();
  const result = term.length >= 2 ? investigate(term, data) : null;

  return (
    <div className="space-y-4">
      <Panel
        title="Place check"
        description="Type the place a client says is missing or wrong. The check searches every proposal, decision, location lookup, saved link and piece of evidence in this run."
      >
        <label className="block">
          <span className="sr-only">Place name</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Blue Bottle Coffee"
            className={cx(inputClass, "h-9 w-full text-sm")}
          />
        </label>
        {result && (
          <div className="mt-4 space-y-1.5">
            <OutcomeBadge outcome={result.outcome} />
            <p className="text-[13px] leading-6 text-ink">{VERDICTS[result.outcome](term)}</p>
            <p className="text-xs text-ink-3">
              Matched {result.savedPlaces.length} saved {result.savedPlaces.length === 1 ? "place" : "places"},{" "}
              {result.candidates.length} {result.candidates.length === 1 ? "candidate" : "candidates"},{" "}
              {result.proposals.length} model {result.proposals.length === 1 ? "proposal" : "proposals"},{" "}
              {result.story.length} log entries and {result.evidence.length} evidence {result.evidence.length === 1 ? "line" : "lines"}.
              Matching ignores case, accents and punctuation.
            </p>
          </div>
        )}
      </Panel>

      {result ? (
        <>
          <Panel title="What happened to it" description="Every log entry that mentions this name, in run order" flush>
            <StoryList story={result.story} />
          </Panel>
          <Panel title="Where it appears in the evidence" description="Text the model read that contains this name" flush>
            {result.evidence.length ? (
              <ul className="divide-y divide-line">
                {result.evidence.map((item) => {
                  const timestamps = Array.isArray(item.timestamps_sec) ? (item.timestamps_sec as unknown[]) : [];
                  return (
                    <li key={String(item.id)} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-4 py-2">
                      <span className="font-mono text-xs text-ink-3">{String(item.evidence_id)}</span>
                      <div className="min-w-0">
                        <p className="text-[13px] break-words whitespace-pre-wrap text-ink">
                          <Highlight text={String(item.text_value)} term={term} />
                        </p>
                        <p className="mt-0.5 text-xs text-ink-3">
                          {evidenceLabel(item.source_type)}
                          {timestamps.length > 0 && ` · at ${timestamps.slice(0, 6).map((t) => `${Number(t)}s`).join(", ")}`}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-ink-3">
                No caption, comment, speech or on-screen text contains this name.
              </p>
            )}
          </Panel>
        </>
      ) : (
        <Panel
          title="Every place this run considered"
          description="Saved places, candidates the checks removed, and names the model proposed. Select a name to see its full story."
          flush
        >
          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-line bg-subtle text-xs text-ink-3">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Place</th>
                    <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
                    <th scope="col" className="px-3 py-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((row) => (
                    <tr key={row.name} className="align-top">
                      <td className="min-w-48 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setQuery(row.name)}
                          className="cursor-pointer text-left font-medium text-ink hover:text-accent hover:underline"
                        >
                          {row.name}
                        </button>
                        {row.location && <p className="text-xs text-ink-3">{row.location}</p>}
                      </td>
                      <td className="px-3 py-2"><OutcomeBadge outcome={row.outcome} /></td>
                      <td className="w-full max-w-0 px-3 py-2">
                        <p className="min-w-56 text-xs leading-5 text-ink-2">
                          {row.why ?? (row.outcome === "proposed" ? "No final decision was logged for this name." : "—")}
                        </p>
                        {row.sources.length > 0 && (
                          <p className="text-xs text-ink-3">Evidence: {row.sources.map(evidenceLabel).join(", ")}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No places were proposed in this run" />
          )}
        </Panel>
      )}
    </div>
  );
}
