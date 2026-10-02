"use client";

import type { AdminPostSummary } from "@/lib/admin-posts";
import PostDetailPage from "./post-detail-page";
import PostsBrowser from "./posts-browser";

type Props = {
  initialPosts: AdminPostSummary[];
  totalPosts: number;
  nextOffset: number | null;
  initialListPage?: number;
  initialPostId?: string;
  initialError?: string;
};

/**
 * Chooses between the dashboard browser and an individual post detail page.
 * Each view owns only the state it needs, keeping this route entry point small.
 */
export default function AdminPostsDashboard({
  initialPostId,
  ...browserProps
}: Props) {
  if (initialPostId) return <PostDetailPage postId={initialPostId} />;
  return <PostsBrowser {...browserProps} />;
}
