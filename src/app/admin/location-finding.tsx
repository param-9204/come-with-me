"use client";

type Data = Record<string, unknown>;

function Info({
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

const date = (item: string) =>
  new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(item));

const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const matches = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Data =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const value = (item: unknown) =>
  item === null || item === undefined || item === ""
    ? "Not available"
    : String(item);
const coordinate = (item: unknown) =>
  typeof item === "number" ? item.toFixed(6) : null;
const similarity = (item: unknown) => {
  const score = Number(item);
  if (!Number.isFinite(score)) return "Not available";
  const percentage = score <= 1 ? score * 100 : score;
  return `${percentage.toFixed(1).replace(/\.0$/, "")}%`;
};

function GeocodeMatch({ match, index }: { match: Data; index: number }) {
  const sourceAddressMismatch =
    typeof match.sourceAddressMismatch === "boolean"
      ? match.sourceAddressMismatch
        ? "Yes"
        : "No"
      : "Not available";

  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-bold text-zinc-100">{value(match.name)}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Geocode result {index + 1}
          </p>
        </div>
        <span className="rounded-lg bg-indigo-500/15 px-2.5 py-1 text-xs font-bold text-indigo-200">
          {similarity(match.similarity)} similarity
        </span>
      </div>

      <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        <Info title="Place type">{value(match.type)}</Info>
        <Info title="Match type">{value(match.match)}</Info>
        <Info title="Matched address">{value(match.address)}</Info>
        <Info title="Source address mismatch">{sourceAddressMismatch}</Info>
        <Info title="Search results">
          {typeof match.results === "number"
            ? match.results.toLocaleString()
            : "Not available"}
        </Info>
        <Info title="Event ID">{value(match.event_id)}</Info>
        <Info title="Run ID">{value(match.run_id)}</Info>
        <Info title="Social post ID">{value(match.social_post_id)}</Info>
        <Info title="Stage">{value(match.stage)}</Info>
        <Info title="Level">{value(match.level)}</Info>
        <Info title="Elapsed time">
          {typeof match.elapsed_ms === "number"
            ? `${match.elapsed_ms.toLocaleString()} ms`
            : "Not available"}
        </Info>
        <Info title="Selected at">
          {typeof match.occurred_at === "string"
            ? date(match.occurred_at)
            : "Not available"}
        </Info>
      </div>

      <Info title="Google Maps search">
        <p className="mt-1 break-words text-zinc-300">
          {value(match.search_message)}
        </p>
      </Info>
    </article>
  );
}

export default function LocationFinding({ trace }: { trace: Data }) {
  const location = record(trace.location);
  const foundMatches = matches(trace.location_matches);
  const latitude = coordinate(location.latitude);
  const longitude = coordinate(location.longitude);
  const coordinates =
    latitude && longitude
      ? `Latitude: ${latitude}, Longitude: ${longitude}`
      : latitude
        ? `Latitude: ${latitude}; longitude missing`
        : longitude
          ? `Longitude: ${longitude}; latitude missing`
          : "No coordinates captured";

  return (
    <article className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <p className="text-[10px] font-bold uppercase tracking-[.14em] text-indigo-300">
        Location finding
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Info title="Place">{value(location.name)}</Info>
        <Info title="Address">{value(location.address)}</Info>
        <Info title="Coordinates">{coordinates}</Info>
      </div>

      <details className="mt-5 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
        <summary className="cursor-pointer list-none px-4 py-3 transition hover:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold text-zinc-100">Location search matches</p>
              <p className="mt-1 text-xs text-zinc-500">
                Every geocode result that recorded a similarity score.
              </p>
            </div>
            <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-bold text-zinc-300">
              {foundMatches.length}
            </span>
          </div>
        </summary>
        <div className="space-y-3 border-t border-zinc-800 p-4">
          {foundMatches.length ? (
            foundMatches.map((match, index) => (
              <GeocodeMatch
                key={`${value(match.event_id)}-${index}`}
                match={match}
                index={index}
              />
            ))
          ) : (
            <p className="text-sm text-zinc-500">
              No geocode search with a similarity score was recorded for this
              post.
            </p>
          )}
        </div>
      </details>
    </article>
  );
}
