import Link from "next/link";

/*
 * Shared admin primitives. Server-safe (no hooks); interactive pieces live in
 * ui-client.tsx. Colors come from the admin tokens defined in globals.css.
 */

const exactFormat = new Intl.NumberFormat("en");
const compactFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const fmt = {
  number: (value: unknown, fallback = "—") =>
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? exactFormat.format(Number(value))
      : fallback,
  compact: (value: unknown, fallback = "—") =>
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? compactFormat.format(Number(value))
      : fallback,
  percent: (value: number | null, digits = 0) =>
    value === null ? "—" : `${(value * 100).toFixed(digits)}%`,
  date: (value: unknown, withTime = false) => {
    if (typeof value !== "string" || !value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    }).format(date);
  },
  /** Formats a YYYY-MM-DD day without shifting it through the local timezone. */
  day: (value: string, withYear = false) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`)),
  relative: (value: unknown) => {
    if (typeof value !== "string" || !value) return "—";
    const elapsed = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(elapsed)) return "—";
    const minutes = Math.round(elapsed / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} d ago`;
    return fmt.date(value);
  },
};

export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export const buttonClass = (
  variant: "primary" | "secondary" | "ghost" = "secondary",
  size: "sm" | "md" = "md",
) =>
  cx(
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
    variant === "primary" && "bg-accent text-canvas hover:opacity-90",
    variant === "secondary" &&
      "border border-line-strong bg-surface text-ink hover:bg-subtle",
    variant === "ghost" && "text-ink-2 hover:bg-subtle hover:text-ink",
  );

export const inputClass =
  "h-8 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && (
          <div className="mb-1.5 text-xs text-ink-3">{breadcrumb}</div>
        )}
        <h1 className="truncate text-xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-[13px] text-ink-3">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  flush = false,
  id,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Removes body padding so tables and lists can run edge to edge. */
  flush?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={cx(
        "min-w-0 rounded-lg border border-line bg-surface",
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-ink-3">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}

export type StatItem = {
  label: string;
  value: React.ReactNode;
  /** Current and previous values; renders a signed change when both exist. */
  delta?: { value: number; previous: number | null };
  hint?: React.ReactNode;
  href?: string;
};

export function Delta({
  value,
  previous,
}: {
  value: number;
  previous: number | null;
}) {
  if (previous === null) return null;
  const change = value - previous;
  if (change === 0)
    return <span className="text-xs text-ink-3">No change</span>;
  const percent = previous ? Math.round((change / previous) * 100) : null;
  const up = change > 0;
  return (
    <span
      className={cx("text-xs font-medium", up ? "text-good" : "text-bad")}
      title={`Previous period: ${exactFormat.format(previous)}`}
    >
      <span aria-hidden>{up ? "↑" : "↓"}</span>{" "}
      <span className="sr-only">{up ? "Up" : "Down"} </span>
      {percent === null ? `+${exactFormat.format(change)}` : `${Math.abs(percent)}%`}
    </span>
  );
}

/** A single bordered row of headline numbers, divided rather than carded. */
export function StatStrip({
  items,
  caption,
}: {
  items: StatItem[];
  caption?: string;
}) {
  return (
    <section
      aria-label={caption}
      className="overflow-hidden rounded-lg border border-line bg-surface"
    >
      {caption && (
        <p className="border-b border-line px-4 py-2 text-xs text-ink-3">
          {caption}
        </p>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        {items.map((item) => {
          const body = (
            <>
              <dt className="text-xs text-ink-3">{item.label}</dt>
              <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-xl font-semibold text-ink">
                  {item.value}
                </span>
                {item.delta && <Delta {...item.delta} />}
              </dd>
              {item.hint && (
                <dd className="mt-0.5 text-xs text-ink-3">{item.hint}</dd>
              )}
            </>
          );
          const cell =
            "-mb-px -mr-px block border-b border-r border-line px-4 py-3";
          return item.href ? (
            <Link
              key={item.label}
              href={item.href}
              className={cx(cell, "hover:bg-subtle")}
            >
              {body}
            </Link>
          ) : (
            <div key={item.label} className={cell}>
              {body}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

const STATUS_TONES: Record<string, { dot: string; label: string }> = {
  completed: { dot: "bg-good", label: "Completed" },
  success: { dot: "bg-good", label: "Success" },
  saved: { dot: "bg-good", label: "Saved" },
  accepted: { dot: "bg-good", label: "Accepted" },
  failed: { dot: "bg-bad", label: "Failed" },
  error: { dot: "bg-bad", label: "Error" },
  rejected: { dot: "bg-bad", label: "Rejected" },
  merged: { dot: "bg-ink-3", label: "Merged" },
};

/** Status always pairs a colored dot with its text label. */
export function StatusBadge({ status }: { status: unknown }) {
  const key =
    typeof status === "string" && status ? status.toLowerCase() : "pending";
  const tone =
    STATUS_TONES[key] ??
    (/fail|error/.test(key)
      ? { dot: "bg-bad", label: key }
      : { dot: "bg-warn", label: key.replace(/_/g, " ") });
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2 capitalize">
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", tone.dot)} />
      {tone.label}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone === "accent"
          ? "bg-accent-soft text-accent"
          : "bg-subtle text-ink-2",
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-3">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Avatar({
  name,
  url,
  size = 28,
}: {
  name: string | null;
  url?: string | null;
  size?: number;
}) {
  const initials =
    (name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-full border border-line object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-subtle font-medium text-ink-2"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
    >
      {initials}
    </span>
  );
}

/** Label/value rows for record facts; rows with no value are omitted. */
export function FactList({
  items,
  columns = 1,
}: {
  items: Array<[string, React.ReactNode]>;
  columns?: 1 | 2;
}) {
  const visible = items.filter(
    ([, value]) =>
      value !== null && value !== undefined && value !== "" && value !== "—",
  );
  if (!visible.length)
    return <p className="text-[13px] text-ink-3">Nothing recorded.</p>;
  return (
    <dl
      className={cx(
        "grid gap-x-6 text-[13px]",
        columns === 2 && "sm:grid-cols-2",
      )}
    >
      {visible.map(([label, value]) => (
        <div
          key={label}
          className="flex min-w-0 items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0"
        >
          <dt className="shrink-0 text-ink-3">{label}</dt>
          <dd className="min-w-0 text-right break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Chips({ values }: { values: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="rounded bg-subtle px-1.5 py-0.5 text-xs text-ink-2"
        >
          {value}
        </span>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="divide-y divide-line">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="h-10 w-8 rounded bg-subtle" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded bg-subtle" />
            <div className="h-3 w-2/3 rounded bg-subtle" />
          </div>
        </div>
      ))}
    </div>
  );
}
