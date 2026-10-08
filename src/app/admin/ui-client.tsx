"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { buttonClass, cx, inputClass } from "./ui";

type AdminSelectOption = {
  value: string;
  label: string;
};

/** Themeable replacement for native select popups, whose highlight is OS-controlled. */
export function AdminSelect({
  label,
  value,
  options,
  onChange,
  className,
  buttonClassName,
  placement = "bottom",
}: {
  label: string;
  value: string;
  options: AdminSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  buttonClassName?: string;
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedOption = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) return;

    requestAnimationFrame(() => listRef.current?.focus());

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnResize = () => setOpen(false);

    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open, selectedIndex]);

  function openList() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const desiredMenuHeight = Math.min(options.length * 32 + 10, 240);
    const spaceAbove = Math.max(0, rect.top - 8);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 8);
    const openAbove =
      placement === "top" ||
      (spaceBelow < desiredMenuHeight && spaceAbove > spaceBelow);
    const menuHeight = Math.min(
      desiredMenuHeight,
      Math.max(32, window.innerHeight - 16),
    );
    const preferredTop = openAbove
      ? rect.top - menuHeight - 4
      : rect.bottom + 4;
    const top = Math.max(
      8,
      Math.min(preferredTop, window.innerHeight - menuHeight - 8),
    );
    const right = Math.max(8, window.innerWidth - rect.right);
    setMenuPosition({
      right,
      top,
      minWidth: rect.width,
      maxHeight: menuHeight,
    });
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        (current + direction + options.length) % options.length,
      );
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  if (!selectedOption) return null;

  const menu =
    open && menuPosition
      ? createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={0}
            aria-label={label}
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
            onKeyDown={handleListKeyDown}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (
                !rootRef.current?.contains(nextTarget) &&
                !listRef.current?.contains(nextTarget)
              ) {
                setOpen(false);
              }
            }}
            style={{
              ...menuPosition,
              backgroundColor: "var(--admin-surface)",
            }}
            className="admin-root fixed z-[100] max-h-60 overflow-y-auto rounded-md border border-line-strong p-1 text-[13px] text-ink shadow-2xl focus:outline-none"
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                title={option.label}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(index)}
                className={cx(
                  "flex h-8 cursor-pointer items-center truncate rounded px-2.5",
                  index === activeIndex
                    ? "bg-accent text-canvas"
                    : option.value === value
                      ? "bg-accent-soft text-accent"
                      : "text-ink hover:bg-subtle",
                )}
              >
                {option.label}
              </li>
            ))}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={className}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => {
          if (open) setOpen(false);
          else openList();
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            openList();
          }
        }}
        className={cx(
          inputClass,
          "flex w-full cursor-pointer items-center justify-between gap-3 text-left",
          buttonClassName,
        )}
      >
        <span className="min-w-0 truncate">{selectedOption.label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 8"
          className={cx(
            "h-2 w-3 shrink-0 fill-none stroke-current transition-transform",
            open && "rotate-180",
          )}
        >
          <path d="m1 1 5 5 5-5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu}
    </div>
  );
}

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
