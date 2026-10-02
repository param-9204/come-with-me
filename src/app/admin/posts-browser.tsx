"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { AdminPostSummary } from "@/lib/admin-posts";
import PostsList from "./posts-list";

type DashboardView = "cards" | "list";
type Props = {
  initialPosts: AdminPostSummary[];
  totalPosts: number;
  nextOffset: number | null;
  initialListPage?: number;
  initialError?: string;
};

const PAGE_SIZE = 15;
const text = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

export default function PostsBrowser({
  initialPosts,
  totalPosts,
  nextOffset: initialNextOffset,
  initialListPage = 1,
  initialError,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const dashboardView: DashboardView =
    searchParams.get("view") === "list" ? "list" : "cards";
  const [search, setSearch] = useState("");
  const [loadedPosts, setLoadedPosts] = useState(initialPosts);
  const [nextOffset, setNextOffset] = useState<number | null>(
    initialNextOffset,
  );
  const [cardsReady, setCardsReady] = useState(
    dashboardView === "cards" || initialListPage === 1,
  );
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [listPosts, setListPosts] = useState(initialPosts);
  const [listPage, setListPage] = useState(initialListPage);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);

  const cards = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return loadedPosts;
    return loadedPosts.filter((post) =>
      [
        post.author_username,
        post.caption,
        post.platform,
        post.status,
        post.post_url,
      ].some((value) => text(value).toLowerCase().includes(term)),
    );
  }, [loadedPosts, search]);

  function dashboardHref(view: DashboardView, page = 1) {
    const params = new URLSearchParams(query);
    params.set("view", view);
    if (view === "list" && page > 1) params.set("page", String(page));
    else params.delete("page");
    return `${pathname}?${params.toString()}`;
  }

  function openPost(id: string) {
    const page = dashboardView === "list" ? listPage : 1;
    router.push(
      `/admin/${id}${dashboardHref(dashboardView, page).slice(pathname.length)}`,
    );
  }

  async function setView(view: DashboardView) {
    if (view === "cards" && !cardsReady) {
      setIsLoadingMore(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/admin/posts?offset=0&limit=${PAGE_SIZE}`,
        );
        const body = (await response.json()) as {
          posts?: AdminPostSummary[];
          nextOffset?: number | null;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || "Unable to load posts");
        setLoadedPosts(body.posts || []);
        setNextOffset(body.nextOffset ?? null);
        setCardsReady(true);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load posts",
        );
        return;
      } finally {
        setIsLoadingMore(false);
      }
    }
    router.replace(dashboardHref(view, view === "list" ? listPage : 1), {
      scroll: false,
    });
  }

  const fetchListPage = useCallback(async (page: number) => {
    setListLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/posts?offset=${(page - 1) * PAGE_SIZE}&limit=${PAGE_SIZE}`,
      );
      const body = (await response.json()) as {
        posts?: AdminPostSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "Unable to load posts");
      setListPosts(body.posts || []);
      setListPage(page);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load posts",
      );
      return false;
    } finally {
      setListLoading(false);
    }
  }, []);

  async function changeListPage(page: number) {
    const pages = Math.max(1, Math.ceil(totalPosts / PAGE_SIZE));
    if (page < 1 || page > pages || listLoading || page === listPage) return;
    if (await fetchListPage(page))
      router.replace(dashboardHref("list", page), { scroll: false });
  }

  const loadMorePosts = useCallback(async () => {
    if (nextOffset === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/posts?offset=${nextOffset}&limit=${PAGE_SIZE}`,
      );
      const body = (await response.json()) as {
        posts?: AdminPostSummary[];
        nextOffset?: number | null;
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error || "Unable to load more posts");
      setLoadedPosts((current) => {
        const ids = new Set(current.map((post) => post.id));
        return [
          ...current,
          ...(body.posts || []).filter((post) => !ids.has(post.id)),
        ];
      });
      setNextOffset(body.nextOffset ?? null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load more posts",
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, nextOffset]);

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;
    if (
      !sentinel ||
      dashboardView !== "cards" ||
      nextOffset === null ||
      isLoadingMore ||
      search.trim()
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadMorePosts();
      },
      { rootMargin: "280px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [dashboardView, loadMorePosts, nextOffset, isLoadingMore, search]);

  return (
    <main className="min-h-screen bg-[#09090b] text-zinc-100">
      <div className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="mb-7 flex flex-col justify-between gap-5 overflow-hidden rounded-3xl border border-zinc-800 bg-[radial-gradient(circle_at_80%_0%,rgba(99,102,241,.22),transparent_30%),linear-gradient(135deg,#18181b,#09090b)] p-6 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-indigo-300">
              Come With Me · Admin
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Posts dashboard
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              Browse posts in small batches and open any post for complete
              insights.
            </p>
          </div>
          <div className="rounded-2xl border border-indigo-400/20 bg-indigo-400/10 px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-300">
              Total posts
            </p>
            <p className="mt-1 text-3xl font-bold text-white">
              {totalPosts.toLocaleString()}
            </p>
          </div>
        </header>
        {(initialError || error) && (
          <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">
            Could not load posts: {error || initialError}
          </div>
        )}
        <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="post-search">
            Search posts
          </label>
          <input
            id="post-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search creator, caption, post URL, platform, or status…"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400 sm:max-w-md"
          />
          <div className="flex items-center gap-3">
            <p className="text-sm text-zinc-500">
              {dashboardView === "cards"
                ? `Loaded ${loadedPosts.length.toLocaleString()} of ${totalPosts.toLocaleString()} posts`
                : `${Math.min(listPage * PAGE_SIZE, totalPosts).toLocaleString()} / ${totalPosts.toLocaleString()} posts`}
            </p>
            <div className="flex rounded-lg border border-zinc-700 bg-zinc-900 p-1">
              <button
                type="button"
                onClick={() => void setView("cards")}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold ${dashboardView === "cards" ? "bg-indigo-500/20 text-indigo-200" : "text-zinc-500"}`}
              >
                Card View
              </button>
              <button
                type="button"
                onClick={() => void setView("list")}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold ${dashboardView === "list" ? "bg-indigo-500/20 text-indigo-200" : "text-zinc-500"}`}
              >
                List view
              </button>
            </div>
          </div>
        </div>
        {dashboardView === "cards" ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {cards.map((post) => (
                <PostThumbnail
                  key={post.id}
                  post={post}
                  onOpen={() => openPost(post.id)}
                />
              ))}
            </div>
            {!cards.length && (
              <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-zinc-700 text-sm text-zinc-500">
                No loaded posts match this search.
              </div>
            )}
            {nextOffset !== null && (
              <div ref={loadMoreSentinel} className="h-4" aria-live="polite">
                <span className="sr-only">
                  {isLoadingMore
                    ? "Loading more posts"
                    : "More posts load as you scroll"}
                </span>
              </div>
            )}
          </>
        ) : (
          <PostsList
            posts={listPosts}
            total={totalPosts}
            page={listPage}
            loading={listLoading}
            search={search}
            onPageChange={changeListPage}
            onOpen={openPost}
          />
        )}
      </div>
    </main>
  );
}

function PostThumbnail({
  post,
  onOpen,
}: {
  post: AdminPostSummary;
  onOpen: () => void;
}) {
  const imageUrls = [
    ...new Set(
      [post.display_url, ...post.image_urls].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      ),
    ),
  ];
  const [imageIndex, setImageIndex] = useState(0);
  const imageUrl = imageUrls[imageIndex];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-[4/5] cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-left shadow-lg shadow-black/20 transition duration-300 hover:-translate-y-1 hover:border-indigo-400/60 hover:shadow-indigo-950/60"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Post thumbnail"
          onError={() =>
            setImageIndex((current) =>
              current < imageUrls.length - 1 ? current + 1 : current,
            )
          }
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="grid h-full place-items-center bg-gradient-to-br from-zinc-800 to-zinc-950 text-4xl text-zinc-600">
          ◌
        </div>
      )}
      <time
        dateTime={post.created_at || undefined}
        className="absolute bottom-3 right-3 rounded-lg border border-white/10 bg-black/60 px-2.5 py-1.5 text-[10px] font-semibold text-white/90 shadow-lg backdrop-blur-md"
      >
        {post.created_at
          ? new Intl.DateTimeFormat("en", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(post.created_at))
          : "—"}
      </time>
    </button>
  );
}
