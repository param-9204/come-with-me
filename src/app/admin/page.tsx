import AdminPostsDashboard from './posts-dashboard';
import { getAdminPostPage } from '@/lib/admin-posts';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const { posts, total, error, nextOffset } = await getAdminPostPage({ limit: 15 });

  return <AdminPostsDashboard initialPosts={posts} totalPosts={total} nextOffset={nextOffset} initialError={error} />;
}
