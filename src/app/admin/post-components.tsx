"use client";

import LocationFinding from "./location-finding";
import PlaceMap from "./place-map";
import { Chips, FactList, Panel, fmt } from "./ui";

export type Data = Record<string, unknown>;
type Location = {
  place_id: string;
  address: string | null;
  map_url: string | null;
  latitude: number | null;
  longitude: number | null;
};
export type PostDetail = { post: Data; related: Data; warnings?: string[] };

export const text = (item: unknown, fallback = "Not available") =>
  item === null || item === undefined || item === "" ? fallback : String(item);
export const date = (item: unknown, withTime = false) =>
  fmt.date(item, withTime);
export const strings = (item: unknown) =>
  Array.isArray(item)
    ? item.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
    : [];
export const record = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
export const records = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Data =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

/** Unique places from every relation the API returns, sorted by name. */
export function collectPlaces(detail: PostDetail) {
  const related = detail.related;
  const linked = records(related.place_links);
  const places = new Map<string, Data>();
  [record(related.primary_place), ...records(related.direct_places)].forEach(
    (place) => {
      if (typeof place.id === "string") places.set(place.id, place);
    },
  );
  linked.forEach((link) => {
    const place = record(link.places);
    if (typeof place.id === "string") places.set(place.id, place);
  });
  return {
    linked,
    places: [...places.values()].sort((left, right) =>
      text(left.name, "Unnamed place").localeCompare(
        text(right.name, "Unnamed place"),
        undefined,
        { numeric: true, sensitivity: "base" },
      ),
    ),
  };
}

export function Places({
  detail,
  onInvestigate,
}: {
  detail: PostDetail;
  /** Opens the extraction place check for this name. */
  onInvestigate?: (name: string) => void;
}) {
  const { linked, places } = collectPlaces(detail);
  const locations = Array.isArray(detail.related.locations)
    ? (detail.related.locations as Location[])
    : [];
  if (!places.length)
    return (
      <Panel>
        <p className="text-[13px] text-ink-3">
          No places were detected for this post.
        </p>
      </Panel>
    );
  return (
    <Panel
      title="Places found"
      description="Map pins use the saved coordinates, or a resolved address when none were saved."
      flush
    >
      <ul className="divide-y divide-line">
        {places.map((place) => {
          const location = locations.find(
            (entry) => entry.place_id === place.id,
          );
          const link = linked.find((entry) => entry.place_id === place.id);
          const name = text(place.name, "Unnamed place");
          const canMap =
            typeof location?.latitude === "number" &&
            typeof location?.longitude === "number";
          const mapsHref = place.google_place_id
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${place.google_place_id}`
            : canMap
              ? `https://www.google.com/maps/search/?api=1&query=${location!.latitude},${location!.longitude}`
              : null;
          return (
            <li
              key={String(place.id)}
              className="grid gap-4 p-4 sm:grid-cols-[176px_minmax(0,1fr)]"
            >
              <div className="self-start overflow-hidden rounded-md border border-line">
                {canMap ? (
                  <PlaceMap
                    latitude={location!.latitude!}
                    longitude={location!.longitude!}
                    label={name}
                  />
                ) : (
                  <div className="grid h-28 place-items-center bg-subtle px-4 text-center text-xs text-ink-3">
                    No precise location yet
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-medium text-ink">{name}</h3>
                    <p className="mt-0.5 text-xs text-ink-3 capitalize">
                      {[place.category, place.neighborhood, place.city]
                        .filter(Boolean)
                        .map((item) => String(item).toLowerCase())
                        .join(" · ") || "No category"}
                    </p>
                  </div>
                  {typeof link?.confidence === "number" && (
                    <span className="text-xs text-ink-2 tabular-nums">
                      {Math.round(link.confidence * 100)}% match
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[13px] text-ink-2">
                  {location?.address || text(place.address, "No address")}
                </p>
                {typeof link?.explanation === "string" && link.explanation && (
                  <p className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-5 text-ink-3">
                    {link.explanation}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {onInvestigate && (
                  <button
                    type="button"
                    onClick={() => onInvestigate(name)}
                    className="cursor-pointer text-xs font-medium text-accent hover:underline"
                  >
                    Why this place?
                  </button>
                )}
                {mapsHref && (
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-xs font-medium text-accent hover:underline"
                  >
                    Open in Google Maps ↗
                  </a>
                )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function ApifyExtraction({ detail }: { detail: PostDetail }) {
  const apify = record(detail.related.apify);
  if (!Object.keys(apify).length || apify.available === false)
    return (
      <Panel title="Source data">
        <p className="text-[13px] text-ink-3">
          No Apify extraction data was saved for this post.
        </p>
      </Panel>
    );

  const author = record(apify.author);
  const post = record(apify.post);
  const engagement = record(apify.engagement);
  const music = record(apify.music);
  const sound = [music.title, music.artist]
    .filter(
      (value): value is string => typeof value === "string" && Boolean(value),
    )
    .join(" — ");
  const tagRows: Array<[string, string[]]> = [
    ["Hashtags", strings(apify.hashtags)],
    ["Mentions", strings(apify.mentions)],
    ["Tagged accounts", strings(apify.tagged_accounts)],
  ];

  return (
    <Panel
      title="Source data"
      description={`As scraped from ${text(apify.source)}`}
    >
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <FactList
          items={[
            [
              "Creator",
              typeof author.username === "string" ? `@${author.username}` : null,
            ],
            ["Display name", optionalText(author.name)],
            ["Format", optionalText(post.type)],
            [
              "Published",
              post.published_at ? date(post.published_at, true) : null,
            ],
            [
              "Scrape started",
              apify.extracted_at ? date(apify.extracted_at, true) : null,
            ],
            ["Location tag", optionalText(post.location)],
            [
              "Duration",
              typeof post.duration === "number" ? `${post.duration} s` : null,
            ],
            [
              "Media size",
              post.width && post.height
                ? `${post.width} × ${post.height}`
                : null,
            ],
            [
              "Carousel items",
              post.carousel_items ? String(post.carousel_items) : null,
            ],
            ["Sound", sound || null],
          ]}
        />
        <div>
          <FactList
            items={[
              ["Views", fmt.number(engagement.views)],
              ["Likes", fmt.number(engagement.likes)],
              ["Comments", fmt.number(engagement.comments)],
              ["Shares", fmt.number(engagement.shares)],
              ["Saves", fmt.number(engagement.saves)],
            ]}
          />
          <div className="mt-3 space-y-3">
            {tagRows
              .filter(([, values]) => values.length)
              .map(([label, values]) => (
                <div key={label}>
                  <p className="mb-1 text-xs text-ink-3">{label}</p>
                  <Chips values={values} />
                </div>
              ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function TraceLog({ detail }: { detail: PostDetail }) {
  const trace = record(detail.related.trace);
  if (trace.available !== true)
    return (
      <Panel title="Processing log">
        <p className="text-[13px] text-ink-3">
          No trace data is available for this short code yet.
        </p>
      </Panel>
    );
  const video = record(trace.video);
  const audio = record(trace.audio);
  const ocr = record(trace.ocr);
  const enrichment = record(trace.enrichment);
  const transcript = optionalText(audio.transcript);
  const ocrText = optionalText(ocr.text);
  const categories = strings(enrichment.categories);

  return (
    <Panel title="Processing log" description="Trace data for this post">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div>
          <h4 className="mb-1 text-xs font-medium text-ink-3">Video</h4>
          <FactList
            items={[
              [
                "Duration",
                typeof video.duration === "number"
                  ? `${video.duration} s`
                  : null,
              ],
              [
                "Format",
                typeof video.width === "number" &&
                typeof video.height === "number"
                  ? `${video.width} × ${video.height}`
                  : null,
              ],
              [
                "Extracted video",
                optionalText(video.url) ? (
                  <a
                    href={String(video.url)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    Open ↗
                  </a>
                ) : null,
              ],
            ]}
          />
        </div>
        <div>
          <h4 className="mb-1 text-xs font-medium text-ink-3">
            Audio (Whisper)
          </h4>
          <FactList
            items={[
              ["Source", optionalText(audio.source)],
              ["Language", optionalText(audio.language)],
              [
                "Duration",
                typeof audio.duration === "number"
                  ? `${audio.duration} s`
                  : null,
              ],
            ]}
          />
          {transcript && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">
                Transcript
              </summary>
              <p className="mt-2 text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                {transcript}
              </p>
            </details>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-xs font-medium text-ink-3">OCR</h4>
          <FactList
            items={[["Frames processed", fmt.number(ocr.frames, "")]]}
          />
          {ocrText && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">
                Detected text
              </summary>
              <p className="mt-2 text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                {ocrText}
              </p>
            </details>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-xs font-medium text-ink-3">
            Category guardrails
          </h4>
          <FactList
            items={[
              ["Primary category", optionalText(enrichment.primary_category)],
              ["Fine-tuning result", optionalText(enrichment.fine_tuning)],
              [
                "Additional categories",
                categories.length ? categories.join(", ") : null,
              ],
            ]}
          />
          {optionalText(enrichment.summary) && (
            <p className="mt-2 text-[13px] leading-6 text-ink-2">
              {String(enrichment.summary)}
            </p>
          )}
        </div>
      </div>
      <LocationFinding trace={trace} />
    </Panel>
  );
}
