"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { PostDetail } from "./post-components";
import PostDetailView from "./post-detail-view";
import { EmptyState, buttonClass } from "./ui";

type Props = { postId: string };

export default function PostDetailPage({ postId }: Props) {
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

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
        if (!response.ok) {
          setError({
            message: body.error || "Unable to load the post",
            status: response.status,
          });
          return;
        }
        setDetail(body);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError({
          message:
            reason instanceof Error ? reason.message : "Unable to load the post",
          status: 0,
        });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadPost();
    return () => controller.abort();
  }, [postId, attempt]);

  // The list's filters and page travel with the URL so "Posts" returns to them.
  const query = searchParams.toString();
  const backHref = query ? `/admin?${query}` : "/admin";

  if (loading)
    return (
      <div aria-busy className="space-y-5">
        <span className="sr-only">Loading post details…</span>
        <div className="h-4 w-40 rounded bg-subtle" />
        <div className="flex gap-4">
          <div className="h-20 w-16 rounded-md bg-subtle" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-5 w-1/3 rounded bg-subtle" />
            <div className="h-3 w-1/2 rounded bg-subtle" />
          </div>
        </div>
        <div className="h-20 rounded-lg border border-line bg-surface" />
        <div className="h-96 rounded-lg border border-line bg-surface" />
      </div>
    );

  if (error || !detail)
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          title={error?.status === 404 ? "Post not found" : "This post could not be loaded"}
          description={
            error?.status === 404
              ? "It may have been deleted or merged into another post."
              : error?.message
          }
          action={
            <div className="flex justify-center gap-2">
              <Link href={backHref} className={buttonClass("secondary")}>
                Back to posts
              </Link>
              {error?.status !== 404 && (
                <button
                  type="button"
                  onClick={() => setAttempt((current) => current + 1)}
                  className={buttonClass("primary")}
                >
                  Try again
                </button>
              )}
            </div>
          }
        />
      </div>
    );

  return <PostDetailView postId={postId} detail={detail} backHref={backHref} />;
}
