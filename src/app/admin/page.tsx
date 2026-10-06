import Link from "next/link";

import { getAdminOverview } from "@/lib/admin-analytics";
import {
  getAdminPostPage,
  getAdminPostStatusCounts,
  parseAdminPostFilters,
} from "@/lib/admin-posts";
import { supabaseAdmin } from "@/lib/supabase";
import PostsBrowser from "./posts-browser";
import { PageHeader, StatStrip, buttonClass, fmt } from "./ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZES = [15, 30, 50];

type SearchParams = Record<string, string | string[] | undefined>;

async function userLabel(userId: string | undefined) {
  if (!userId) return null;
  if (userId === "none") return "Unattributed";
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("display_name, email")
    .eq("id", userId)
    .maybeSingle();
  return data?.display_name || data?.email || "Unknown user";
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const requestedSize = Number(params.size);
  const pageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : 15;
  const filters = parseAdminPostFilters(params, pageSize);
  const [result, counts, overview, filterUser] = await Promise.all([
    getAdminPostPage(filters),
    getAdminPostStatusCounts(filters),
    getAdminOverview().catch(() => null),
    userLabel(filters.userId),
  ]);
  const view = params.view === "cards" ? "grid" : "table";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Posts"
        description={
          overview
            ? `${fmt.number(overview.totalPosts)} unique posts from ${fmt.number(overview.totalUsers)} registered users`
            : "Every social post submitted for place extraction"
        }
        actions={
          <Link href="/admin/analytics" className={buttonClass("secondary")}>
            View analytics
          </Link>
        }
      />
      {overview && (
        <StatStrip
          caption="Last 7 days, compared with the 7 days before"
          items={[
            {
              label: "Posts added",
              value: fmt.number(overview.posts7d.value),
              delta: overview.posts7d,
              href: `/admin?from=${overview.range.from}&to=${overview.range.to}`,
            },
            {
              label: "Active users",
              value: fmt.number(overview.activeUsers7d.value),
              delta: overview.activeUsers7d,
              hint: "Submitted a post or saved a place",
              href: "/admin/users?sort=lastActive",
            },
            {
              label: "New users",
              value: fmt.number(overview.newUsers7d.value),
              delta: overview.newUsers7d,
              href: "/admin/users?sort=joined",
            },
            {
              label: "Place saves",
              value: fmt.number(overview.saves7d.value),
              delta: overview.saves7d,
              href: "/admin/analytics?range=7d",
            },
          ]}
        />
      )}
      <PostsBrowser
        posts={result.posts}
        total={result.total}
        page={filters.page}
        pageSize={pageSize}
        pageSizes={PAGE_SIZES}
        counts={counts}
        platforms={overview?.platforms ?? ["instagram", "tiktok"]}
        view={view}
        filterUser={filterUser}
        error={result.error ?? null}
      />
    </div>
  );
}
