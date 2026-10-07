import PostDetailPage from "../post-detail-page";

export const dynamic = "force-dynamic";

export default async function AdminPostPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;

  return <PostDetailPage postId={postId} />;
}
