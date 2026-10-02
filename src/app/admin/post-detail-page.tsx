"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { PostDetail } from "./post-components";
import PostDetailView from "./post-detail-view";

type Props = { postId: string };

export default function PostDetailPage({ postId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPost() {
      setDetail(null);
      setError(null);
      setLoading(true);
      try {
        const response = await fetch(`/api/admin/posts/${postId}`, {
          signal: controller.signal,
        });
        const body = (await response.json()) as PostDetail & { error?: string };
        if (!response.ok)
          throw new Error(body.error || "Unable to load the post");
        setDetail(body);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : "Unable to load the post",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadPost();
    return () => controller.abort();
  }, [postId]);

  const query = searchParams.toString();
  const backHref = query ? `/admin?${query}` : "/admin";

  return (
    <main className="min-h-screen bg-[#09090b] text-zinc-100">
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="cursor-pointer mb-5 inline-flex items-center gap-2 text-sm font-semibold text-zinc-400 hover:text-white"
        >
          <span aria-hidden>←</span> Back to all posts
        </button>
        {loading && (
          <div className="grid min-h-[550px] place-items-center rounded-2xl border border-zinc-800 bg-zinc-900/40">
            <p className="animate-pulse text-sm text-zinc-400">
              Loading post details…
            </p>
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            {error}
          </div>
        )}
        {detail && !loading && <PostDetailView detail={detail} />}
      </div>
    </main>
  );
}
