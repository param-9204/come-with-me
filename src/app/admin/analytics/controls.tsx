"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import type { DateRange, RangeKey } from "@/lib/admin-analytics";
import { buttonClass, cx, inputClass } from "../ui";

export const RANGES: Array<{ key: RangeKey; label: string; long: string }> = [
  { key: "7d", label: "7D", long: "Last 7 days" },
  { key: "30d", label: "30D", long: "Last 30 days" },
  { key: "90d", label: "90D", long: "Last 90 days" },
  { key: "12m", label: "12M", long: "Last 12 months" },
  { key: "all", label: "All", long: "All time" },
];

export const rangeLabel = (range: DateRange) =>
  RANGES.find((item) => item.key === range.key)?.long ?? "Custom range";

/** Replaces URL params in a transition so the page can show a pending state. */
export function useUrlUpdate() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  function update(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    startTransition(() =>
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      }),
    );
  }
  return { isPending, update };
}

export function RangeControls({
  range,
  update,
}: {
  range: DateRange;
  update: (changes: Record<string, string | null>) => void;
}) {
  const [showCustom, setShowCustom] = useState(range.key === "custom");
  const [customFrom, setCustomFrom] = useState(range.from);
  const [customTo, setCustomTo] = useState(range.to);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="Date range"
        className="flex rounded-md border border-line-strong bg-surface p-0.5"
      >
        {RANGES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={range.key === item.key}
            title={item.long}
            onClick={() => {
              setShowCustom(false);
              update({
                range: item.key === "30d" ? null : item.key,
                from: null,
                to: null,
              });
            }}
            className={cx(
              "h-7 cursor-pointer rounded px-2.5 text-xs font-medium",
              range.key === item.key
                ? "bg-ink text-canvas"
                : "text-ink-2 hover:bg-subtle",
            )}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={range.key === "custom"}
          aria-expanded={showCustom}
          onClick={() => setShowCustom((value) => !value)}
          className={cx(
            "h-7 cursor-pointer rounded px-2.5 text-xs font-medium",
            range.key === "custom"
              ? "bg-ink text-canvas"
              : "text-ink-2 hover:bg-subtle",
          )}
        >
          Custom
        </button>
      </div>
      {showCustom && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (customFrom && customTo && customFrom <= customTo)
              update({ range: null, from: customFrom, to: customTo });
          }}
        >
          <label className="sr-only" htmlFor="range-from">
            From
          </label>
          <input
            id="range-from"
            type="date"
            value={customFrom}
            max={customTo}
            onChange={(event) => setCustomFrom(event.target.value)}
            className={inputClass}
          />
          <span className="text-xs text-ink-3">to</span>
          <label className="sr-only" htmlFor="range-to">
            To
          </label>
          <input
            id="range-to"
            type="date"
            value={customTo}
            min={customFrom}
            onChange={(event) => setCustomTo(event.target.value)}
            className={inputClass}
          />
          <button type="submit" className={buttonClass("secondary")}>
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

const SECTIONS = [
  { href: "/admin/analytics", label: "Users & posts" },
  { href: "/admin/analytics/pipeline", label: "Pipeline health" },
];

/** Switches analytics views while keeping the shared range and platform. */
export function AnalyticsNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const shared = new URLSearchParams();
  for (const key of ["range", "from", "to", "platform"]) {
    const value = searchParams.get(key);
    if (value) shared.set(key, value);
  }
  const query = shared.toString();
  return (
    <nav aria-label="Analytics views" className="flex gap-5 border-b border-line">
      {SECTIONS.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={query ? `${section.href}?${query}` : section.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "border-b-2 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
              active
                ? "border-accent text-ink"
                : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

export const PLATFORM_NAMES: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
};
export const platformName = (platform: string) =>
  PLATFORM_NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
