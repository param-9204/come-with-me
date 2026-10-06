"use client";

import { FactList, fmt } from "./ui";

type Data = Record<string, unknown>;

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
  item === null || item === undefined || item === "" ? "—" : String(item);
const coordinate = (item: unknown) =>
  typeof item === "number" ? item.toFixed(6) : null;
const similarity = (item: unknown) => {
  const score = Number(item);
  if (item === null || item === undefined || !Number.isFinite(score))
    return "—";
  const percentage = score <= 1 ? score * 100 : score;
  return `${percentage.toFixed(1).replace(/\.0$/, "")}%`;
};

export default function LocationFinding({ trace }: { trace: Data }) {
  const location = record(trace.location);
  const foundMatches = matches(trace.location_matches);
  const latitude = coordinate(location.latitude);
  const longitude = coordinate(location.longitude);
  const coordinates =
    latitude && longitude
      ? `${latitude}, ${longitude}`
      : latitude
        ? `${latitude}; longitude missing`
        : longitude
          ? `${longitude}; latitude missing`
          : "Not captured";

  return (
    <div className="mt-6 border-t border-line pt-4">
      <h4 className="mb-1 text-xs font-medium text-ink-3">Location finding</h4>
      <FactList
        columns={2}
        items={[
          ["Place", value(location.name)],
          ["Address", value(location.address)],
          ["Coordinates", coordinates],
        ]}
      />
      <details className="mt-3 rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-ink-2 hover:text-ink">
          Geocode matches with a similarity score ({foundMatches.length})
        </summary>
        {foundMatches.length ? (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-subtle text-xs text-ink-3">
                <tr>
                  {["Result", "Similarity", "Type / match", "Address", "Address mismatch", "Results", "Selected"].map(
                    (label) => (
                      <th
                        key={label}
                        scope="col"
                        className="px-3 py-2 font-medium whitespace-nowrap"
                      >
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {foundMatches.map((match, index) => (
                  <tr key={`${value(match.event_id)}-${index}`} className="align-top">
                    <td className="px-3 py-2">
                      <p className="font-medium text-ink">{value(match.name)}</p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink">
                          Event details
                        </summary>
                        <div className="mt-1 space-y-0.5 text-xs text-ink-3">
                          <p>Event {value(match.event_id)}</p>
                          <p>Run {value(match.run_id)}</p>
                          <p>
                            Stage {value(match.stage)} · {value(match.level)}
                            {typeof match.elapsed_ms === "number"
                              ? ` · ${match.elapsed_ms.toLocaleString()} ms`
                              : ""}
                          </p>
                          <p className="break-words">
                            Search: {value(match.search_message)}
                          </p>
                        </div>
                      </details>
                    </td>
                    <td className="px-3 py-2 text-ink-2 tabular-nums">
                      {similarity(match.similarity)}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {value(match.type)} / {value(match.match)}
                    </td>
                    <td className="min-w-48 px-3 py-2 text-ink-2">
                      {value(match.address)}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {typeof match.sourceAddressMismatch === "boolean"
                        ? match.sourceAddressMismatch
                          ? "Yes"
                          : "No"
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-2 tabular-nums">
                      {fmt.number(match.results)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-ink-3">
                      {fmt.date(match.occurred_at, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-line px-3 py-2 text-[13px] text-ink-3">
            No geocode search with a similarity score was recorded.
          </p>
        )}
      </details>
    </div>
  );
}
