"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type {
  AdminPostStatusFilter,
  AdminPostSummary,
} from "@/lib/admin-posts";
import Pagination from "./pagination";
import PostsList from "./posts-list";
import Thumbnail from "./post-thumbnail";
import { EmptyState, buttonClass, cx, fmt, inputClass } from "./ui";

type Props = {
  posts: AdminPostSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageSizes: number[];
  counts: Record<AdminPostStatusFilter, number | null>;
  platforms: string[];
  view: "table" | "grid";
  filterUser: string | null;
  error: string | null;
};

const STATUS_TABS: Array<{ id: AdminPostStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "processing", label: "Processing" },
  { id: "failed", label: "Failed" },
  { id: "merged", label: "Merged" },
];

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
};

const SORT_OPTIONS = [
  { value: "created_at:desc", label: "Newest first" },
  { value: "created_at:asc", label: "Oldest first" },
  { value: "views:desc", label: "Most viewed" },
  { value: "likes:desc", label: "Most liked" },
  { value: "comments:desc", label: "Most comments" },
];

export default function PostsBrowser({
  posts,
  total,
  page,
  pageSize,
  pageSizes,
  counts,
  platforms,
  view,
  filterUser,
  error,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const urlSearch = searchParams.get("q") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [syncedSearch, setSyncedSearch] = useState(urlSearch);

  // Back/forward navigation changes the URL; keep the input in step with it.
  if (urlSearch !== syncedSearch) {
    setSyncedSearch(urlSearch);
    setSearch(urlSearch);
  }

  const status = (searchParams.get("status") ??
    "all") as AdminPostStatusFilter;
  const sortValue = `${searchParams.get("sort") ?? "created_at"}:${searchParams.get("dir") === "asc" ? "asc" : "desc"}`;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  function update(changes: Record<string, string | null>, keepPage = false) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    if (!keepPage) params.delete("page");
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    });
  }

  useEffect(() => {
    const term = search.trim();
    if (term === urlSearch.trim()) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (term) params.set("q", term);
      else params.delete("q");
      params.delete("page");
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, urlSearch, pathname, router]);

  const query = searchParams.toString();
  const postHref = (id: string) => `/admin/${id}${query ? `?${query}` : ""}`;

  const chips: Array<{ key: string; label: string; clear: string[] }> = [];
  if (filterUser)
    chips.push({ key: "user", label: `User: ${filterUser}`, clear: ["user"] });
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from || to)
    chips.push({
      key: "dates",
      label: `Added ${from ? fmt.day(from, true) : "…"} – ${to ? fmt.day(to, true) : "today"}`,
      clear: ["from", "to"],
    });
  const filtersActive =
    chips.length > 0 ||
    Boolean(urlSearch) ||
    Boolean(searchParams.get("platform")) ||
    Boolean(searchParams.get("type")) ||
    status !== "all";

  function clearAll() {
    setSearch("");
    update({
      q: null,
      user: null,
      from: null,
      to: null,
      platform: null,
      type: null,
      status: null,
    });
  }

  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);

  return (
    <section
      aria-label="Posts"
      className="overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div
        role="group"
        aria-label="Filter by status"
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line px-2 pt-2"
      >
        {STATUS_TABS.map((tab) => {
          const active = status === tab.id;
          const count = counts[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={active}
              onClick={() =>
                update({ status: tab.id === "all" ? null : tab.id })
              }
              className={cx(
                "flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-medium whitespace-nowrap transition-colors",
                active
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {tab.label}
              {count !== null && (
                <span className="text-xs font-normal text-ink-3 tabular-nums">
                  {fmt.number(count)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 border-b border-line p-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="post-search" className="sr-only">
            Search posts
          </label>
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="m14 14 4 4" strokeLinecap="round" />
          </svg>
          <input
            id="post-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search creator, caption, URL, short code, category or user"
            className={cx(inputClass, "w-full pl-8")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Platform"
            value={searchParams.get("platform") ?? ""}
            onChange={(event) => update({ platform: event.target.value })}
            className={inputClass}
          >
            <option value="">All platforms</option>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>
                {PLATFORM_LABELS[platform] ??
                  platform.charAt(0).toUpperCase() + platform.slice(1)}
              </option>
            ))}
          </select>
          <select
            aria-label="Format"
            value={searchParams.get("type") ?? ""}
            onChange={(event) => update({ type: event.target.value })}
            className={inputClass}
          >
            <option value="">All formats</option>
            <option value="reel">Reel</option>
            <option value="post">Post</option>
            <option value="video">Video</option>
          </select>
          <select
            aria-label="Sort"
            value={sortValue}
            onChange={(event) => {
              const [sort, dir] = event.target.value.split(":");
              update({
                sort: sort === "created_at" ? null : sort,
                dir: dir === "asc" ? "asc" : null,
              });
            }}
            className={inputClass}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div
            role="group"
            aria-label="Layout"
            className="flex rounded-md border border-line-strong p-0.5"
          >
            {(["table", "grid"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() =>
                  update({ view: option === "grid" ? "cards" : null }, true)
                }
                className={cx(
                  "h-6 cursor-pointer rounded px-2 text-xs font-medium capitalize",
                  view === option
                    ? "bg-subtle text-ink"
                    : "text-ink-3 hover:text-ink",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(chips.length > 0 || filtersActive) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-md bg-accent-soft py-0.5 pr-1 pl-2 text-xs text-accent"
            >
              {chip.label}
              <button
                type="button"
                aria-label={`Remove filter ${chip.label}`}
                onClick={() =>
                  update(Object.fromEntries(chip.clear.map((key) => [key, null])))
                }
                className="grid h-4 w-4 cursor-pointer place-items-center rounded hover:bg-surface"
              >
                <span aria-hidden>×</span>
              </button>
            </span>
          ))}
          {filtersActive && (
            <button
              type="button"
              onClick={clearAll}
              className="cursor-pointer text-xs text-ink-3 hover:text-ink hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-bad-soft px-4 py-3 text-[13px] text-bad"
        >
          <span>Posts could not be loaded: {error}</span>
          <button
            type="button"
            onClick={() => startTransition(() => router.refresh())}
            className={buttonClass("secondary", "sm")}
          >
            Try again
          </button>
        </div>
      )}

      <div
        aria-busy={isPending}
        className={cx("relative transition-opacity", isPending && "opacity-60")}
      >
        {isPending && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-accent"
          />
        )}
        {posts.length === 0 && !error ? (
          filtersActive ? (
            <EmptyState
              title="No posts match these filters"
              description="Try a broader search or remove a filter."
              action={
                <button
                  type="button"
                  onClick={clearAll}
                  className={buttonClass("secondary")}
                >
                  Clear all filters
                </button>
              }
            />
          ) : (
            <EmptyState
              title="No posts yet"
              description="Posts appear here once a user submits an Instagram or TikTok link."
            />
          )
        ) : view === "grid" ? (
          <PostGrid posts={posts} postHref={postHref} />
        ) : (
          <PostsList
            posts={posts}
            postHref={postHref}
            sort={searchParams.get("sort") ?? "created_at"}
            ascending={searchParams.get("dir") === "asc"}
            onSort={(sort, ascending) =>
              update({
                sort: sort === "created_at" ? null : sort,
                dir: ascending ? "asc" : null,
              })
            }
          />
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-xs text-ink-3">
          <span className="tabular-nums">
            {total
              ? `${fmt.number(first)}–${fmt.number(last)} of ${fmt.number(total)}`
              : "0 posts"}
          </span>
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(event) =>
                update({
                  size:
                    Number(event.target.value) === pageSizes[0]
                      ? null
                      : event.target.value,
                })
              }
              className={cx(inputClass, "h-7 px-1.5 text-xs")}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Pagination
          page={page}
          totalPages={pages}
          loading={isPending}
          onPageChange={(next) =>
            update({ page: next > 1 ? String(next) : null }, true)
          }
        />
      </div>
    </section>
  );
}

function PostGrid({
  posts,
  postHref,
}: {
  posts: AdminPostSummary[];
  postHref: (id: string) => string;
}) {
  return (
    <ul className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {posts.map((post) => (
        <li key={post.id} className="bg-surface">
          <Link
            href={postHref(post.id)}
            className="group block p-2.5 hover:bg-subtle"
          >
            <Thumbnail post={post} className="aspect-4/5 w-full" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-[13px] font-medium text-ink group-hover:text-accent">
                @{post.author_username || "unknown"}
              </p>
              <span
                className="shrink-0 text-xs text-ink-3"
                suppressHydrationWarning
              >
                {fmt.relative(post.created_at)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-3 capitalize">
              {[post.platform, post.content_type].filter(Boolean).join(" · ")}
              {post.status !== "completed" && ` · ${post.status}`}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
