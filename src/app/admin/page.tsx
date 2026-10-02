import AdminPostsDashboard from "./posts-dashboard";
import { getAdminPostPage } from "@/lib/admin-posts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = { view?: string; page?: string };

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const requestedPage = Number(params.page);
  const initialListPage =
    params.view === "list" &&
    Number.isInteger(requestedPage) &&
    requestedPage > 1
      ? requestedPage
      : 1;
  const { posts, total, error, nextOffset } = await getAdminPostPage({
    limit: 15,
    offset: (initialListPage - 1) * 15,
  });

  return (
    <AdminPostsDashboard
      initialPosts={posts}
      totalPosts={total}
      nextOffset={nextOffset}
      initialListPage={initialListPage}
      initialError={error}
    />
  );
}
