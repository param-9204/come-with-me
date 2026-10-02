"use client";

import { useState } from "react";

import LocationFinding from "./location-finding";
import PlaceMap from "./place-map";

export type Data = Record<string, unknown>;
type Location = {
  place_id: string;
  address: string | null;
  map_url: string | null;
  latitude: number | null;
  longitude: number | null;
};
export type PostDetail = { post: Data; related: Data; warnings?: string[] };

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exact = new Intl.NumberFormat("en");
export const text = (item: unknown, fallback = "Not available") =>
  item === null || item === undefined || item === "" ? fallback : String(item);
const stat = (item: unknown) =>
  Number.isFinite(Number(item)) ? compact.format(Number(item)) : "â€”";
export const date = (item: unknown, withTime = false) =>
  typeof item === "string" && item
    ? new Intl.DateTimeFormat("en", {
        day: "numeric",
        month: "short",
        year: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      }).format(new Date(item))
    : "â€”";
export const strings = (item: unknown) =>
  Array.isArray(item)
    ? item.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
    : [];

function Status({ value }: { value: unknown }) {
  const label = text(value, "Pending").replace(/_/g, " ");
  const good = /completed|success|saved/i.test(label);
  const bad = /failed|error|rejected/i.test(label);
  return (
    <span
      className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[.13em] ${good ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : bad ? "border-rose-400/30 bg-rose-400/10 text-rose-300" : "border-zinc-700 bg-zinc-950/70 text-zinc-300"}`}
    >
      {label}
    </span>
  );
}

export function Metric({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
      <p className="text-lg font-bold text-zinc-100">{stat(value)}</p>
      <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
        {title}
      </p>
    </div>
  );
}

export function OverlayMetric({
  label,
  value,
}: {
  label: "Views" | "Likes" | "Comments" | "Plays" | "Shares" | "Saves";
  value: unknown;
}) {
  const paths = {
    Views: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12S5.25 6.75 12 6.75 21.75 12 21.75 12 18.75 17.25 12 17.25 2.25 12 2.25 12Z M12 14.25A2.25 2.25 0 1 0 12 9.75a2.25 2.25 0 0 0 0 4.5Z"
      />
    ),
    Likes: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"
      />
    ),
    Comments: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 8.25h9m-9 3h5.25M21 11.25c0 4.14-4.03 7.5-9 7.5a10.9 10.9 0 0 1-3.54-.58L3 20.25l1.57-4.2A7.07 7.07 0 0 1 3 11.25c0-4.14 4.03-7.5 9-7.5s9 3.36 9 7.5Z"
      />
    ),
    Plays: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m9.75 7.5 6 4.5-6 4.5v-9Z"
      />
    ),
    Shares: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 7.5 12 3m0 0 4.5 4.5M12 3v11.25M5.25 12.75v4.5A2.25 2.25 0 0 0 7.5 19.5h9a2.25 2.25 0 0 0 2.25-2.25v-4.5"
      />
    ),
    Saves: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.25 3.75h13.5v16.5L12 16.5l-6.75 3.75V3.75Z"
      />
    ),
  };
  const accent =
    label === "Likes"
      ? "bg-pink-500 text-white shadow-pink-500/30"
      : "bg-zinc-800/95 text-zinc-200";
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className={`grid h-8 w-8 place-items-center rounded-full border border-white/10 shadow-lg ${accent}`}
      >
        <svg
          className="h-4 w-4"
          fill={label === "Likes" ? "currentColor" : "none"}
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          {paths[label]}
        </svg>
      </span>
      <p className="text-[10px] font-bold leading-none text-white">
        {stat(value)}
      </p>
    </div>
  );
}

export function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/65 p-5 shadow-2xl shadow-black/10">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-base font-bold text-white">{title}</h2>
        {note && <p className="text-xs text-zinc-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export function Info({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
        {title}
      </p>
      <div className="text-sm leading-6 text-zinc-200">{children}</div>
    </div>
  );
}

export function Tags({ values }: { values: string[] }) {
  if (!values.length)
    return <span className="text-sm text-zinc-500">Not available</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
        >
          {value}
        </span>
      ))}
    </div>
  );
}

function ExactMetric({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="text-xl font-bold text-white">
        {Number.isFinite(Number(value)) ? exact.format(Number(value)) : "â€”"}
      </p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
        {title}
      </p>
    </div>
  );
}

function CopyReference({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copyValue = value;
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Copy is unavailable only when the browser blocks clipboard access.
    }
  }
  return (
    <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
        {label}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-sm text-zinc-200"
          title={value}
        >
          {value}
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          className="cursor-pointer grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 transition hover:border-indigo-400 hover:text-indigo-200"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
          </svg>
        </button>
      </div>
      {copied && (
        <p className="mt-1 text-[10px] font-semibold text-emerald-300">
          Copied
        </p>
      )}
    </div>
  );
}

export function PostReference({ detail }: { detail: PostDetail }) {
  const reference =
    detail.related.post_reference &&
    typeof detail.related.post_reference === "object" &&
    !Array.isArray(detail.related.post_reference)
      ? (detail.related.post_reference as Data)
      : {};
  const url =
    typeof detail.post.post_url === "string" && detail.post.post_url
      ? detail.post.post_url
      : typeof reference.url === "string"
        ? reference.url
        : null;
  const shortCode =
    typeof reference.short_code === "string" && reference.short_code
      ? reference.short_code
      : null;
  if (!url && !shortCode) return null;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/65 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyReference label="Post URL" value={url} />
        <CopyReference label="Short code" value={shortCode} />
      </div>
    </section>
  );
}

export function Places({ detail }: { detail: PostDetail }) {
  const related = detail.related;
  const linked = Array.isArray(related.place_links)
    ? (related.place_links as Data[])
    : [];
  const direct = Array.isArray(related.direct_places)
    ? (related.direct_places as Data[])
    : [];
  const primary =
    related.primary_place &&
    typeof related.primary_place === "object" &&
    !Array.isArray(related.primary_place)
      ? (related.primary_place as Data)
      : null;
  const locations = Array.isArray(related.locations)
    ? (related.locations as Location[])
    : [];
  const places = new Map<string, Data>();
  [primary, ...direct].forEach(
    (place) =>
      place && typeof place.id === "string" && places.set(place.id, place),
  );
  linked.forEach((link) => {
    const place = link.places;
    if (
      place &&
      typeof place === "object" &&
      !Array.isArray(place) &&
      typeof (place as Data).id === "string"
    )
      places.set((place as Data).id as string, place as Data);
  });
  if (!places.size)
    return (
      <p className="text-sm text-zinc-500">
        No places were detected for this post.
      </p>
    );
  const sortedPlaces = [...places.values()].sort((left, right) =>
    text(left.name, "Unnamed place").localeCompare(
      text(right.name, "Unnamed place"),
      undefined,
      { numeric: true, sensitivity: "base" },
    ),
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sortedPlaces.map((place) => {
        const location = locations.find((entry) => entry.place_id === place.id);
        const link = linked.find((entry) => entry.place_id === place.id);
        const name = text(place.name, "Unnamed place");
        const canMap =
          location?.latitude !== null &&
          location?.latitude !== undefined &&
          location?.longitude !== null &&
          location?.longitude !== undefined;
        return (
          <article
            key={String(place.id)}
            className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/65"
          >
            {canMap ? (
              <PlaceMap
                latitude={location.latitude!}
                longitude={location.longitude!}
                label={name}
              />
            ) : (
              <div className="grid h-36 place-items-center bg-zinc-800/50 px-6 text-center text-sm text-zinc-500">
                A precise map location is not available for this place yet.
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-zinc-100">{name}</h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    {[place.category, place.neighborhood, place.city]
                      .filter(Boolean)
                      .join(" Â· ") || "Place details"}
                  </p>
                </div>
                {typeof link?.confidence === "number" && (
                  <span className="rounded-lg bg-indigo-400/10 px-2 py-1 text-xs font-bold text-indigo-300">
                    {Math.round(link.confidence * 100)}% match
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                {location?.address || text(place.address)}
              </p>
              {typeof link?.explanation === "string" && link.explanation && (
                <p className="mt-3 border-l-2 border-indigo-400/60 pl-3 text-xs leading-5 text-zinc-500">
                  {link.explanation}
                </p>
              )}
              {(place.google_place_id || location?.latitude) && (
                <a
                  href={
                    place.google_place_id
                      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${place.google_place_id}`
                      : `https://www.google.com/maps/search/?api=1&query=${location?.latitude},${location?.longitude}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-indigo-300 hover:text-indigo-200"
                >
                  Open location in Google Maps <span aria-hidden>&#8599;</span>
                </a>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Pipeline({ detail }: { detail: PostDetail }) {
  const related = detail.related;
  const runs = Array.isArray(related.extraction_runs)
    ? (related.extraction_runs as Data[])
    : [];
  const stages = Array.isArray(related.extraction_run_stages)
    ? (related.extraction_run_stages as Data[])
    : [];
  const candidates = Array.isArray(related.extraction_candidates)
    ? (related.extraction_candidates as Data[])
    : [];
  if (!runs.length)
    return (
      <p className="text-sm text-zinc-500">
        No processing history has been recorded for this post.
      </p>
    );
  return (
    <div className="space-y-3">
      {runs.map((run, runIndex) => {
        const runStages = stages.filter((stage) => stage.run_id === run.id);
        const runCandidates = candidates.filter(
          (candidate) => candidate.run_id === run.id,
        );
        return (
          <details
            key={String(run.id)}
            className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
          >
            <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold capitalize text-zinc-200">
                    {text(run.trigger, "Processing run").replace(/_/g, " ")}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {date(run.created_at, true)}
                  </p>
                </div>
                <Status value={run.status} />
              </div>
            </summary>
            <div className="mt-5 border-t border-zinc-800 pt-5">
              <div className="grid gap-2 sm:grid-cols-3">
                <Metric title="Places saved" value={run.saved_count} />
                <Metric title="Accepted" value={run.accepted_count} />
                <Metric title="Candidates" value={run.candidates_count} />
              </div>
              {runStages.length ? (
                <div className="mt-5">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
                    Processing stages
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {runStages.map((stage, index) => (
                      <span
                        key={`${text(stage.stage)}-${index}`}
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300"
                      >
                        {text(stage.stage).replace(/_/g, " ")}{" "}
                        <span className="text-zinc-600">Â·</span>{" "}
                        <span className="text-zinc-400">
                          {text(stage.provider)}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {runCandidates.length ? (
                <div className="mt-5">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
                    Detected places
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {runCandidates.map((candidate, index) => (
                      <div
                        key={`${text(candidate.name)}-${index}`}
                        className="rounded-lg bg-zinc-900 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium text-zinc-200">
                            {text(candidate.name)}
                          </p>
                          <Status value={candidate.decision} />
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">
                          {[candidate.category, candidate.city]
                            .filter(Boolean)
                            .join(" Â· ")}
                        </p>
                        {typeof candidate.reason === "string" &&
                          candidate.reason && (
                            <p className="mt-2 text-xs leading-5 text-zinc-500">
                              {candidate.reason}
                            </p>
                          )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function ExtractionPipeline({ detail }: { detail: PostDetail }) {
  const runs = Array.isArray(detail.related.extraction)
    ? (detail.related.extraction as Data[])
    : [];
  if (!runs.length)
    return (
      <p className="text-sm text-zinc-500">
        No extraction record is available for this post.
      </p>
    );

  return (
    <div className="space-y-4">
      {runs.map((run, runIndex) => {
        const input =
          run.input && typeof run.input === "object" ? (run.input as Data) : {};
        const evidence =
          run.evidence && typeof run.evidence === "object"
            ? (run.evidence as Data)
            : {};
        const outcome =
          run.outcome && typeof run.outcome === "object"
            ? (run.outcome as Data)
            : {};
        const stages = Array.isArray(run.stages) ? (run.stages as Data[]) : [];
        const calls = Array.isArray(run.calls) ? (run.calls as Data[]) : [];
        const candidates = Array.isArray(run.candidates)
          ? (run.candidates as Data[])
          : [];
        const logs = Array.isArray(run.logs) ? (run.logs as Data[]) : [];
        const sources = Array.isArray(evidence.sources)
          ? (evidence.sources as Data[])
          : [];
        return (
          <details
            key={`${text(run.label)}-${runIndex}`}
            className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60"
          >
            <summary className="cursor-pointer list-none p-5 transition hover:bg-zinc-900/70">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-base font-bold text-zinc-100">
                    {text(run.label)}{" "}
                    <span className="font-normal capitalize text-zinc-500">
                      Â· {text(run.trigger).replace(/_/g, " ")}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {date(run.started_at, true)}
                    {typeof run.duration_ms === "number"
                      ? ` Â· ${(run.duration_ms / 1000).toFixed(1)} sec`
                      : ""}
                  </p>
                </div>
                <Status value={run.status} />
              </div>
              {typeof run.error_message === "string" && run.error_message && (
                <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 p-2.5 text-xs leading-5 text-rose-200">
                  {run.error_message}
                </p>
              )}
            </summary>
            <div className="space-y-6 border-t border-zinc-800 p-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <AuditGroup
                  title="Input captured"
                  values={[
                    ["Caption", input.caption_characters, "characters"],
                    ["Hashtags", input.hashtags],
                    ["Mentions", input.mentions],
                    ["Tagged accounts", input.tagged_accounts],
                    ["Comments", input.comments],
                    ["Media items", input.media_items],
                    ["Subtitle tracks", input.subtitle_tracks],
                  ]}
                />
                <AuditGroup
                  title="Evidence used"
                  values={[
                    ["Evidence items", evidence.items],
                    ["OCR frames", evidence.ocr_frames],
                    ["Vision frames", evidence.vision_frames],
                    ["Transcript source", evidence.transcript_source],
                    ["Transcript language", evidence.transcript_language],
                  ]}
                />
                <AuditGroup
                  title="Extraction outcome"
                  values={[
                    ["Candidates", outcome.candidates],
                    ["Accepted", outcome.accepted],
                    ["Rejected", outcome.rejected],
                    ["Places saved", outcome.saved],
                    ["Not saved", outcome.unsaved],
                    ["Recovery added", outcome.recovery_places_added],
                  ]}
                />
              </div>

              {sources.length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
                    Evidence sources
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {sources.map((source, index) => (
                      <span
                        key={`${text(source.source)}-${index}`}
                        className="rounded-lg border border-indigo-400/20 bg-indigo-400/10 px-2.5 py-1.5 text-xs text-indigo-200"
                      >
                        {text(source.source)}{" "}
                        <span className="text-indigo-300/70">
                          {text(source.count)}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stages.length > 0 && (
                <div>
                  <p className="mb-3 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
                    Pipeline stages
                  </p>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {stages.map((stage, index) => (
                      <div
                        key={`${text(stage.stage)}-${index}`}
                        className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold capitalize text-zinc-200">
                              {text(stage.stage).replace(/_/g, " ")}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                              {text(stage.provider)}
                              {typeof stage.duration_ms === "number"
                                ? ` Â· ${(stage.duration_ms / 1000).toFixed(1)} sec`
                                : ""}
                            </p>
                          </div>
                          <Status value={stage.status} />
                        </div>
                        {(typeof stage.items_in === "number" ||
                          typeof stage.items_out === "number") && (
                          <p className="mt-2 text-xs text-zinc-500">
                            Items: {text(stage.items_in)} in Â·{" "}
                            {text(stage.items_out)} out
                          </p>
                        )}
                        {typeof stage.error_message === "string" &&
                          stage.error_message && (
                            <p className="mt-2 text-xs leading-5 text-rose-300">
                              {stage.error_message}
                            </p>
                          )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {candidates.length > 0 && (
                <div>
                  <p className="mb-3 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
                    Candidate places and supporting evidence
                  </p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {candidates.map((candidate, index) => (
                      <CandidateCard
                        key={`${text(candidate.name)}-${index}`}
                        candidate={candidate}
                      />
                    ))}
                  </div>
                </div>
              )}

              {calls.length > 0 && (
                <details className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-zinc-300">
                    External services used ({calls.length})
                  </summary>
                  <div className="mt-4 grid gap-2 lg:grid-cols-2">
                    {calls.map((call, index) => (
                      <div
                        key={`${text(call.operation)}-${index}`}
                        className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium capitalize text-zinc-200">
                              {text(call.operation).replace(/_/g, " ")}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                              {[call.provider, call.model]
                                .filter(
                                  (item) => typeof item === "string" && item,
                                )
                                .join(" Â· ")}
                            </p>
                          </div>
                          <Status value={call.status} />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                          {typeof call.latency_ms === "number" && (
                            <span>
                              {(call.latency_ms / 1000).toFixed(1)} sec
                            </span>
                          )}
                          {typeof call.total_tokens === "number" && (
                            <span>
                              {call.total_tokens.toLocaleString()} tokens
                            </span>
                          )}
                          {typeof call.images === "number" && (
                            <span>{call.images} images</span>
                          )}
                          {typeof call.estimated_cost_usd === "number" && (
                            <span>${call.estimated_cost_usd.toFixed(4)}</span>
                          )}
                        </div>
                        {typeof call.error_message === "string" &&
                          call.error_message && (
                            <p className="mt-2 text-xs leading-5 text-rose-300">
                              {call.error_message}
                            </p>
                          )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {logs.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {logs.map((log, index) => (
                    <span
                      key={`${text(log.part)}-${index}`}
                      className="rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-400"
                    >
                      {text(log.part)}: {text(log.events)} events Â·{" "}
                      {text(log.warnings)} warnings Â· {text(log.errors)} errors
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function AuditGroup({
  title,
  values,
}: {
  title: string;
  values: Array<[string, unknown, string?]>;
}) {
  const visible = values.filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  if (!visible.length)
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
          {title}
        </p>
        <p className="mt-3 text-sm text-zinc-500">Not recorded</p>
      </div>
    );
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
        {title}
      </p>
      <div className="space-y-2">
        {visible.map(([label, value, suffix]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="text-zinc-500">{label}</span>
            <span className="text-right font-medium text-zinc-200">
              {typeof value === "number" ? value.toLocaleString() : text(value)}
              {suffix ? ` ${suffix}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: Data }) {
  const evidence = Array.isArray(candidate.evidence)
    ? (candidate.evidence as Data[])
    : [];
  const sources = strings(candidate.evidence_sources);
  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold text-zinc-100">
            {text(candidate.name, "Unnamed candidate")}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {[candidate.category, candidate.neighborhood, candidate.city]
              .filter(Boolean)
              .join(" Â· ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Status value={candidate.decision} />
          {typeof candidate.confidence === "number" && (
            <span className="rounded-lg bg-indigo-400/10 px-2 py-1 text-xs font-bold text-indigo-300">
              {Math.round(candidate.confidence * 100)}%
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
        {typeof candidate.mention_type === "string" &&
          candidate.mention_type && (
            <span>{candidate.mention_type} mention</span>
          )}
        {typeof candidate.model_role === "string" && candidate.model_role && (
          <span>{candidate.model_role}</span>
        )}
        {typeof candidate.geocode_provider === "string" &&
          candidate.geocode_provider && (
            <span>Located with {candidate.geocode_provider}</span>
          )}
      </div>
      {typeof candidate.search_query === "string" && candidate.search_query && (
        <p className="mt-3 rounded-lg bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
          Search context: {candidate.search_query}
        </p>
      )}
      {typeof candidate.reason === "string" && candidate.reason && (
        <p className="mt-3 text-xs leading-5 text-zinc-400">
          {candidate.reason}
        </p>
      )}
      {sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sources.map((source) => (
            <span
              key={source}
              className="rounded bg-zinc-800 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400"
            >
              {source}
            </span>
          ))}
        </div>
      )}
      {evidence.length > 0 && (
        <div className="mt-4 space-y-2">
          {evidence.slice(0, 3).map((item, index) => (
            <blockquote
              key={`${text(item.source)}-${index}`}
              className="border-l-2 border-indigo-400/60 pl-3 text-xs leading-5 text-zinc-400"
            >
              <span className="mr-1 font-semibold uppercase tracking-wide text-indigo-300">
                {text(item.source)}:
              </span>
              {text(item.text)}
            </blockquote>
          ))}
        </div>
      )}
    </article>
  );
}

export function ApifyExtraction({
  detail,
  showComments = false,
}: {
  detail: PostDetail;
  showComments?: boolean;
}) {
  const apify =
    detail.related.apify &&
    typeof detail.related.apify === "object" &&
    !Array.isArray(detail.related.apify)
      ? (detail.related.apify as Data)
      : {};
  if (Object.keys(apify).length === 0)
    return (
      <Section title="Apify extraction">
        <p className="text-sm text-zinc-500">
          No Apify extraction data was saved for this post.
        </p>
      </Section>
    );

  const author =
    apify.author && typeof apify.author === "object"
      ? (apify.author as Data)
      : {};
  const post =
    apify.post && typeof apify.post === "object" ? (apify.post as Data) : {};
  const engagement =
    apify.engagement && typeof apify.engagement === "object"
      ? (apify.engagement as Data)
      : {};
  const music =
    apify.music && typeof apify.music === "object" ? (apify.music as Data) : {};
  const comments = Array.isArray(apify.comments)
    ? (apify.comments as Data[])
    : [];
  const metrics = [
    ["Views", engagement.views],
    ["Likes", engagement.likes],
    ["Comments", engagement.comments],
    ["Shares", engagement.shares],
    ["Saves", engagement.saves],
  ].filter(([, value]) => Number.isFinite(Number(value)));
  const postFacts = [
    ["Post format", post.type],
    [
      "URL extraction started",
      typeof apify.extracted_at === "string"
        ? date(apify.extracted_at, true)
        : null,
    ],
    ["Published", post.published_at ? date(post.published_at, true) : null],
    ["Location", post.location],
    [
      "Duration",
      typeof post.duration === "number" ? `${post.duration} seconds` : null,
    ],
    [
      "Media size",
      post.width && post.height ? `${post.width} Ã— ${post.height}` : null,
    ],
    ["Carousel items", post.carousel_items],
  ].filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  const creatorUsername =
    typeof author.username === "string" ? author.username : null;
  const creatorName = typeof author.name === "string" ? author.name : null;
  const sound = [music.title, music.artist]
    .filter(
      (value): value is string => typeof value === "string" && Boolean(value),
    )
    .join(" â€” ");

  return (
    <Section
      title="Apify extraction"
      note={`Formatted from ${text(apify.source)} data`}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
            Creator & post source
          </p>
          <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {creatorUsername && <Info title="Creator">@{creatorUsername}</Info>}
            {creatorName && <Info title="Display name">{creatorName}</Info>}
            {postFacts.map(([label, value]) => (
              <Info key={String(label)} title={String(label)}>
                {String(value)}
              </Info>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-zinc-500">
            Audio & mentions
          </p>
          <div className="mt-4 space-y-4">
            {sound && <Info title="Sound">{sound}</Info>}
            <Info title="Hashtags">
              <Tags values={strings(apify.hashtags)} />
            </Info>
            <Info title="Mentions">
              <Tags values={strings(apify.mentions)} />
            </Info>
            <Info title="Tagged accounts">
              <Tags values={strings(apify.tagged_accounts)} />
            </Info>
          </div>
        </div>
      </div>

      {metrics.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {metrics.map(([label, value]) => (
            <ExactMetric
              key={String(label)}
              title={String(label)}
              value={value}
            />
          ))}
        </div>
      )}

      {showComments && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60">
          <details>
            <summary className="cursor-pointer list-none p-4 transition hover:bg-zinc-900/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-zinc-100">Extracted comments</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Comments captured by Apify for this post.
                  </p>
                </div>
                <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-bold text-zinc-300">
                  {comments.length}
                </span>
              </div>
            </summary>
            <div className="border-t border-zinc-800 p-4">
              {comments.length ? (
                <div className="space-y-3">
                  {comments.map((comment, index) => {
                    const commentAuthor =
                      typeof comment.author === "string" && comment.author
                        ? comment.author
                        : null;
                    const commentName =
                      typeof comment.name === "string" && comment.name
                        ? comment.name
                        : null;
                    const commentDate =
                      typeof comment.created_at === "string" &&
                      comment.created_at
                        ? comment.created_at
                        : null;
                    const commentMessage =
                      typeof comment.message === "string" && comment.message
                        ? comment.message
                        : null;
                    return (
                      <article
                        key={`${commentAuthor || commentName || "comment"}-${index}`}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-zinc-100">
                              {commentAuthor
                                ? `@${commentAuthor}`
                                : commentName || "Unknown commenter"}
                            </p>
                            {commentName && commentAuthor && (
                              <p className="mt-0.5 text-xs text-zinc-500">
                                {commentName}
                              </p>
                            )}
                          </div>
                          <div className="flex gap-3 text-[11px] text-zinc-500">
                            {commentDate && (
                              <span>{date(commentDate, true)}</span>
                            )}
                            {typeof comment.likes === "number" && (
                              <span>â™¡ {stat(comment.likes)}</span>
                            )}
                            {typeof comment.replies === "number" && (
                              <span>{comment.replies} replies</span>
                            )}
                          </div>
                        </div>
                        {commentMessage && (
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                            {commentMessage}
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">
                  Apify did not return comments for this post.
                </p>
              )}
            </div>
          </details>
        </div>
      )}
    </Section>
  );
}

export function TokenUsage({ detail }: { detail: PostDetail }) {
  const usage =
    detail.related.token_usage &&
    typeof detail.related.token_usage === "object" &&
    !Array.isArray(detail.related.token_usage)
      ? (detail.related.token_usage as Data)
      : {};
  const tokenCount = (value: unknown) =>
    Number.isFinite(Number(value)) ? Number(value) : 0;
  const totalTokens = tokenCount(usage.total_tokens);
  const totalInputTokens = tokenCount(usage.total_input_tokens);
  const totalOutputTokens = tokenCount(usage.total_output_tokens);
  const stages = (
    Array.isArray(usage.stages) ? (usage.stages as Data[]) : []
  ).map((stage, index) => ({
    key: `${typeof stage.label === "string" ? stage.label : "stage"}-${index}`,
    label:
      typeof stage.label === "string" && stage.label
        ? stage.label.replace(/_/g, " ")
        : `Stage ${index + 1}`,
    status:
      typeof stage.status === "string" && stage.status ? stage.status : null,
    provider:
      typeof stage.provider === "string" && stage.provider
        ? stage.provider
        : null,
    model: typeof stage.model === "string" && stage.model ? stage.model : null,
    startedAt:
      typeof stage.started_at === "string" && stage.started_at
        ? stage.started_at
        : null,
    completedAt:
      typeof stage.completed_at === "string" && stage.completed_at
        ? stage.completed_at
        : null,
    duration: Number.isFinite(Number(stage.duration_ms))
      ? Number(stage.duration_ms)
      : null,
    input: tokenCount(stage.input_tokens),
    output: tokenCount(stage.output_tokens),
    total: Number.isFinite(Number(stage.total_tokens))
      ? Number(stage.total_tokens)
      : tokenCount(stage.input_tokens) + tokenCount(stage.output_tokens),
    itemsIn: Number.isFinite(Number(stage.items_in))
      ? Number(stage.items_in)
      : null,
    itemsOut: Number.isFinite(Number(stage.items_out))
      ? Number(stage.items_out)
      : null,
    cost: Number.isFinite(Number(stage.estimated_cost_usd))
      ? Number(stage.estimated_cost_usd)
      : null,
    error:
      typeof stage.error_message === "string" && stage.error_message
        ? stage.error_message
        : null,
  }));

  return (
    <Section title="Token usage" note="From extraction_run_summary">
      <>
        <div className="rounded-xl border border-indigo-400/20 bg-[linear-gradient(135deg,rgba(79,70,229,.16),rgba(24,24,27,.7))] p-5">
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-300">
            Total tokens used
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <ExactMetric title="Total tokens" value={totalTokens} />
            <ExactMetric title="Total input tokens" value={totalInputTokens} />
            <ExactMetric
              title="Total output tokens"
              value={totalOutputTokens}
            />
          </div>
        </div>
        <details className="mt-4 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
          <summary className="cursor-pointer list-none p-4 transition hover:bg-zinc-900/60">
            <span className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/15 px-3 py-2 text-xs font-bold text-indigo-200">
              <span>Token bifurcation</span>
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5 text-indigo-300"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            </span>
            <span className="ml-3 text-xs text-zinc-500">
              {stages.length} extraction stages
            </span>
          </summary>
          <div className="border-t border-zinc-800 p-4">
            {stages.length ? (
              <div className="space-y-4">
                {stages.map((stage) => (
                  <article
                    key={stage.key}
                    className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 bg-zinc-950/50 p-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-bold capitalize text-zinc-100">
                            {stage.label}
                          </p>
                          {stage.status && <Status value={stage.status} />}
                        </div>
                        {(stage.provider || stage.model) && (
                          <p className="mt-1 text-xs text-zinc-500">
                            {[stage.provider, stage.model]
                              .filter(Boolean)
                              .join(" Â· ")}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-indigo-200">
                          {exact.format(stage.total)}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-[.12em] text-zinc-500">
                          Total tokens
                        </p>
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="grid gap-2 sm:grid-cols-3">
                        <ExactMetric title="Input tokens" value={stage.input} />
                        <ExactMetric
                          title="Output tokens"
                          value={stage.output}
                        />
                        <ExactMetric title="Total tokens" value={stage.total} />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500">
                        {stage.startedAt && (
                          <span>Started: {date(stage.startedAt, true)}</span>
                        )}
                        {stage.completedAt && (
                          <span>
                            Completed: {date(stage.completedAt, true)}
                          </span>
                        )}
                        {stage.duration !== null && (
                          <span>
                            Duration: {(stage.duration / 1000).toFixed(1)} sec
                          </span>
                        )}
                        {stage.itemsIn !== null && (
                          <span>Items in: {exact.format(stage.itemsIn)}</span>
                        )}
                        {stage.itemsOut !== null && (
                          <span>Items out: {exact.format(stage.itemsOut)}</span>
                        )}
                        {stage.cost !== null && (
                          <span>Estimated cost: ${stage.cost.toFixed(4)}</span>
                        )}
                      </div>
                      {stage.error && (
                        <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-200">
                          {stage.error}
                        </p>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                No stage-run token data was recorded for this post.
              </p>
            )}
          </div>
        </details>
      </>
    </Section>
  );
}

export function TraceLog({ detail }: { detail: PostDetail }) {
  const trace =
    detail.related.trace &&
    typeof detail.related.trace === "object" &&
    !Array.isArray(detail.related.trace)
      ? (detail.related.trace as Data)
      : {};
  if (trace.available !== true)
    return (
      <Section title="Processing log">
        <p className="text-sm text-zinc-500">
          No trace data is available for this short code yet.
        </p>
      </Section>
    );
  const video =
    trace.video && typeof trace.video === "object" ? (trace.video as Data) : {};
  const audio =
    trace.audio && typeof trace.audio === "object" ? (trace.audio as Data) : {};
  const ocr =
    trace.ocr && typeof trace.ocr === "object" ? (trace.ocr as Data) : {};
  const enrichment =
    trace.enrichment && typeof trace.enrichment === "object"
      ? (trace.enrichment as Data)
      : {};
  const location =
    trace.location && typeof trace.location === "object"
      ? (trace.location as Data)
      : {};
  const locationMatch =
    trace.location_match && typeof trace.location_match === "object"
      ? (trace.location_match as Data)
      : {};
  const latitude =
    typeof location.latitude === "number" ? location.latitude : null;
  const longitude =
    typeof location.longitude === "number" ? location.longitude : null;
  const formatCoordinate = (value: number) => value.toFixed(6);
  const coordinateStatus =
    latitude !== null && longitude !== null
      ? `Latitude: ${formatCoordinate(latitude)}, Longitude: ${formatCoordinate(longitude)}`
      : latitude !== null
        ? `Latitude: ${formatCoordinate(latitude)}; longitude missing`
        : longitude !== null
          ? `Longitude: ${formatCoordinate(longitude)}; latitude missing`
          : "No coordinates captured";
  const similarity =
    typeof locationMatch.similarity === "number"
      ? locationMatch.similarity
      : null;
  const similarityLabel =
    similarity === null
      ? "Not available"
      : `${(similarity <= 1 ? similarity * 100 : similarity).toFixed(1).replace(/\.0$/, "")}%`;
  const highestMatch = [
    locationMatch.name,
    locationMatch.type,
    locationMatch.match,
  ]
    .filter(
      (value): value is string => typeof value === "string" && Boolean(value),
    )
    .join(" · ");
  const sourceAddressMismatch =
    typeof locationMatch.source_address_mismatch === "boolean"
      ? locationMatch.source_address_mismatch
        ? "Yes"
        : "No"
      : "Not available";
  const transcript =
    typeof audio.transcript === "string" && audio.transcript
      ? audio.transcript
      : null;
  const ocrText = typeof ocr.text === "string" && ocr.text ? ocr.text : null;

  return (
    <Section title="Processing log" note="Trace data for this post">
      <>
        <div className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-indigo-300">
              Video details
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Info title="Duration">
                {typeof video.duration === "number"
                  ? `${video.duration} seconds`
                  : "Not available"}
              </Info>
              <Info title="Format">
                {typeof video.width === "number" &&
                typeof video.height === "number"
                  ? `${video.width} Ã— ${video.height}`
                  : "Not available"}
              </Info>
              {typeof video.url === "string" && video.url && (
                <a
                  href={video.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-indigo-300 hover:text-indigo-200"
                >
                  Open extracted video &#8599;
                </a>
              )}
            </div>
          </article>
          <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-indigo-300">
              Audio extraction Â· Whisper
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Info title="Source">{text(audio.source)}</Info>
              <Info title="Language">{text(audio.language)}</Info>
              <Info title="Audio duration">
                {typeof audio.duration === "number"
                  ? `${audio.duration} seconds`
                  : "Not available"}
              </Info>
            </div>
            {transcript && (
              <details className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/60">
                <summary className="cursor-pointer px-3 py-2.5 text-xs font-bold text-zinc-200">
                  View Whisper transcript
                </summary>
                <p className="border-t border-zinc-800 p-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                  {transcript}
                </p>
              </details>
            )}
          </article>
          <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-indigo-300">
              OCR evidence
            </p>
            <div className="mt-4">
              <Info title="Frames processed">
                {Number.isFinite(Number(ocr.frames))
                  ? exact.format(Number(ocr.frames))
                  : "Not available"}
              </Info>
              {ocrText && (
                <p className="mt-4 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm leading-6 text-zinc-300">
                  {ocrText}
                </p>
              )}
            </div>
          </article>
          <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-indigo-300">
              Fine-tuning & category guardrails
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Info title="Primary category">
                {text(enrichment.primary_category)}
              </Info>
              <Info title="Fine-tuning result">
                {text(enrichment.fine_tuning)}
              </Info>
            </div>
            <div className="mt-4">
              <Info title="Additional categories">
                <Tags values={strings(enrichment.categories)} />
              </Info>
            </div>
            {typeof enrichment.summary === "string" && enrichment.summary && (
              <p className="mt-4 text-sm leading-6 text-zinc-300">
                {enrichment.summary}
              </p>
            )}
          </article>
        </div>
        <LocationFinding trace={trace} />
      </>
    </Section>
  );
}
