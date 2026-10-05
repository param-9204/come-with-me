"use client";

type Props = {
  page: number;
  totalPages: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
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

export default function Pagination({
  page,
  totalPages,
  loading = false,
  onPageChange,
}: Props) {
  const pages = pageItems(page, totalPages);
  const disabled = (targetPage: number) =>
    loading || targetPage < 1 || targetPage > totalPages || targetPage === page;

  return (
    <nav
      aria-label="Posts pagination"
      className="flex flex-wrap items-center gap-1.5"
    >
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={disabled(page - 1)}
        aria-label="Previous page"
        className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-700 text-zinc-300 transition hover:border-indigo-400 hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden>←</span>
      </button>
      {pages.map((item, index) =>
        item === "ellipsis" ? (
          <span
            key={`ellipsis-${index}`}
            className="px-1 text-xs text-zinc-500"
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
            className={`grid h-8 min-w-8 place-items-center rounded-lg border px-2 text-xs font-bold transition disabled:cursor-not-allowed ${item === page ? "border-indigo-400/40 bg-indigo-500/20 text-indigo-100" : "border-zinc-700 text-zinc-300 hover:border-indigo-400 hover:text-indigo-200"}`}
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
        className="grid h-8 w-8 place-items-center rounded-lg border border-indigo-400/30 bg-indigo-500/15 text-indigo-200 transition hover:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden>→</span>
      </button>
    </nav>
  );
}
