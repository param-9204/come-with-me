import { notFound } from "next/navigation";

import { getAdminUserDetail } from "@/lib/admin-analytics";
import { getAdminPostPage } from "@/lib/admin-posts";
import UserDetailView from "./user-detail-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const [detail, recent] = await Promise.all([
    getAdminUserDetail(userId),
    getAdminPostPage({ userId, limit: 10 }),
  ]);
  if (!detail) notFound();

  return (
    <UserDetailView
      detail={detail}
      recentPosts={recent.posts}
      postsError={recent.error ?? null}
    />
  );
}
