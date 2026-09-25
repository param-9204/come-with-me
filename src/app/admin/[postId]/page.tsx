import AdminPostsDashboard from '../posts-dashboard';

export const dynamic = 'force-dynamic';

export default async function AdminPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;

  return <AdminPostsDashboard initialPosts={[]} totalPosts={0} nextOffset={null} initialPostId={postId} />;
}
