"use client";

import { useRef, useState } from "react";

import { buttonClass, cx } from "./ui";

export function CopyButton({
  value,
  label,
  children,
}: {
  value: string | null | undefined;
  label: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const text = value;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser blocked clipboard access; nothing else to do.
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={children ? undefined : `Copy ${label}`}
      title={`Copy ${label}`}
      className={buttonClass(children ? "secondary" : "ghost", "sm")}
    >
      {children}
      <span aria-live="polite" className={children ? "text-ink-3" : undefined}>
        {copied ? "Copied" : children ? null : "Copy"}
      </span>
    </button>
  );
}

export type TabItem<T extends string> = {
  id: T;
  label: string;
  count?: number | null;
};

/** WAI-ARIA tabs with roving focus (arrow keys, Home, End). */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
              selected
                ? "border-accent text-ink"
                : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span className="rounded bg-subtle px-1.5 text-[11px] text-ink-2 tabular-nums">
                {tab.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  idPrefix,
  children,
}: {
  id: string;
  idPrefix: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      tabIndex={0}
      className="focus-visible:outline-none"
    >
      {children}
    </div>
  );
}
