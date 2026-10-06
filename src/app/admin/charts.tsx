"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { cx, fmt } from "./ui";

export type ColumnPoint = { date: string; value: number };

const PAD = { top: 10, right: 8, bottom: 24, left: 36 };

function niceTicks(max: number, integer: boolean): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const nice =
    [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? rough;
  // Counts step in whole numbers; amounts such as cost may step by 0.05.
  const step = integer ? Math.max(1, Math.round(nice)) : nice;
  const ticks: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const tick = Number((index * step).toPrecision(10));
    ticks.push(tick);
    if (tick >= max) break;
  }
  return ticks;
}

export type ValueFormat = "count" | "usd";
const formatValue = (value: number, format: ValueFormat, axis = false) =>
  format === "usd"
    ? `$${value.toFixed(axis ? (value && value < 1 ? 2 : 0) : value < 1 ? 4 : 2)}`
    : axis
      ? fmt.compact(value)
      : fmt.number(value);

function bucketLabel(date: string, granularity: "day" | "week", long = false) {
  if (granularity === "week") {
    const label = fmt.day(date, long);
    return long ? `Week of ${label}` : label;
  }
  return fmt.day(date, long);
}

/**
 * Single-series column chart over time. Each column's full-height band is the
 * hover/focus target; arrow keys move between columns when the chart has focus.
 * A table view carries every value for readers who can't use the hover layer.
 */
export function ColumnChart({
  points,
  seriesLabel,
  granularity,
  height = 200,
  valueFormat = "count",
}: {
  points: ColumnPoint[];
  seriesLabel: string;
  granularity: "day" | "week";
  height?: number;
  valueFormat?: ValueFormat;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.floor(entry.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(0, ...points.map((point) => point.value));
  const ticks = niceTicks(max, valueFormat === "count");
  const top = ticks.at(-1) || 1;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const band = points.length ? plotWidth / points.length : plotWidth;
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotWidth / 64))));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const activePoint = active !== null ? points[active] : null;

  function onKeyDown(event: React.KeyboardEvent) {
    if (!points.length) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActive((current) =>
        Math.min(points.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : points.length)) + step)),
      );
    } else if (event.key === "Escape") setActive(null);
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="relative"
        tabIndex={0}
        role="group"
        aria-label={`${seriesLabel} by ${granularity}, ${formatValue(total, valueFormat)} in total. Use left and right arrow keys to read each ${granularity}.`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <svg width={width} height={height} className="block" aria-hidden>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? "stroke-line-strong" : "stroke-line"}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-ink-3 text-[11px] tabular-nums"
              >
                {formatValue(tick, valueFormat, true)}
              </text>
            </g>
          ))}
          {points.map((point, index) => {
            const x = PAD.left + index * band;
            const barX = x + (band - barWidth) / 2;
            const barTop = y(point.value);
            const barHeight = PAD.top + plotHeight - barTop;
            const radius = Math.min(4, barWidth / 2, barHeight);
            return (
              <g key={point.date}>
                <rect
                  x={x}
                  y={PAD.top}
                  width={band}
                  height={plotHeight}
                  className={active === index ? "fill-subtle" : "fill-transparent"}
                  onPointerEnter={() => setActive(index)}
                />
                {point.value > 0 && (
                  <path
                    pointerEvents="none"
                    className="fill-accent"
                    d={`M${barX},${barTop + barHeight} V${barTop + radius} Q${barX},${barTop} ${barX + radius},${barTop} H${barX + barWidth - radius} Q${barX + barWidth},${barTop} ${barX + barWidth},${barTop + radius} V${barTop + barHeight} Z`}
                  />
                )}
                {index % labelEvery === 0 && (
                  <text
                    x={x + band / 2}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-ink-3 text-[11px]"
                  >
                    {bucketLabel(point.date, granularity)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {activePoint && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap"
            style={{
              left: Math.min(
                Math.max(PAD.left + active * band + band / 2 - 60, 0),
                width - 140,
              ),
            }}
          >
            <p className="text-sm font-semibold text-ink tabular-nums">
              {formatValue(activePoint.value, valueFormat)}
            </p>
            <p className="text-ink-3">
              {seriesLabel} · {bucketLabel(activePoint.date, granularity, true)}
            </p>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setShowTable((current) => !current)}
        aria-expanded={showTable}
        className="mt-2 cursor-pointer text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
      >
        {showTable ? "Hide data table" : "Show data table"}
      </button>
      {showTable && (
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-subtle text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {granularity === "week" ? "Week of" : "Day"}
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  {seriesLabel}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {points.map((point) => (
                <tr key={point.date}>
                  <td className="px-3 py-1.5 text-ink-2">
                    {fmt.day(point.date, true)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink tabular-nums">
                    {formatValue(point.value, valueFormat)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export type BarListItem = {
  key: string;
  label: string;
  count: number;
  href?: string;
};

/** Ranked horizontal bars as a list: label and value as text, bar as context. */
export function BarList({
  items,
  total,
  empty = "No data in this period.",
}: {
  items: BarListItem[];
  total?: number;
  empty?: string;
}) {
  if (!items.length) return <p className="text-[13px] text-ink-3">{empty}</p>;
  const max = Math.max(...items.map((item) => item.count), 1);
  const sum = total ?? items.reduce((acc, item) => acc + item.count, 0);
  return (
    <ul className="space-y-2.5">
      {items.map((item) => {
        const share = sum ? item.count / sum : 0;
        const label = (
          <span className="min-w-0 truncate" title={item.label}>
            {item.label}
          </span>
        );
        return (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              {item.href ? (
                <Link
                  href={item.href}
                  className="min-w-0 truncate text-ink hover:text-accent hover:underline"
                >
                  {label}
                </Link>
              ) : (
                <span className="min-w-0 truncate text-ink">{label}</span>
              )}
              <span className="shrink-0 text-ink-2 tabular-nums">
                {fmt.number(item.count)}
                <span className="ml-2 inline-block w-9 text-right text-xs text-ink-3">
                  {Math.round(share * 100)}%
                </span>
              </span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-subtle" aria-hidden>
              <div
                className={cx("h-1 rounded-full bg-accent")}
                style={{ width: `${(item.count / max) * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
