"use client";

import { cx } from "./ui";

type Props = {
  page: number;
  totalPages: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  label?: string;
};

type PageItem = number | "ellipsis";

function pageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const visible = new Set([1, totalPages, page - 1, page, page + 1]);
  const pages = [...visible]
    .filter((item) => item >= 1 && item <= totalPages)
    .sort((left, right) => left - right);
  const items: PageItem[] = [];

  pages.forEach((item, index) => {
    const previous = pages[index - 1];
    if (previous && item - previous > 1) items.push("ellipsis");
    items.push(item);
  });

  return items;
}

const itemClass =
  "grid h-7 min-w-7 cursor-pointer place-items-center rounded-md px-1.5 text-xs font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export default function Pagination({
  page,
  totalPages,
  loading = false,
  onPageChange,
  label = "Pagination",
}: Props) {
  if (totalPages <= 1) return null;
  const pages = pageItems(page, totalPages);
  const disabled = (targetPage: number) =>
    loading || targetPage < 1 || targetPage > totalPages || targetPage === page;

  return (
    <nav aria-label={label} className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={disabled(page - 1)}
        aria-label="Previous page"
        className={cx(itemClass, "text-ink-2 hover:bg-subtle")}
      >
        <span aria-hidden>‹</span>
      </button>
      {pages.map((item, index) =>
        item === "ellipsis" ? (
          <span
            key={`ellipsis-${index}`}
            className="px-1 text-xs text-ink-3"
            aria-hidden
          >
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            onClick={() => onPageChange(item)}
            disabled={disabled(item)}
            aria-current={item === page ? "page" : undefined}
            aria-label={`Page ${item}`}
            className={cx(
              itemClass,
              item === page
                ? "bg-accent text-canvas disabled:opacity-100"
                : "text-ink-2 hover:bg-subtle",
            )}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={disabled(page + 1)}
        aria-label="Next page"
        className={cx(itemClass, "text-ink-2 hover:bg-subtle")}
      >
        <span aria-hidden>›</span>
      </button>
    </nav>
  );
}
