import Link from "next/link";

import { getAdminAnalytics, resolveRange } from "@/lib/admin-analytics";
import { PageHeader, Panel, buttonClass, fmt } from "../ui";
import UsersTable, { type UserSort } from "../users-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SORTS: UserSort[] = [
  "postsInRange",
  "postsTotal",
  "savesInRange",
  "savesTotal",
  "lastActive",
  "joined",
  "name",
];

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params.sort as UserSort;
  const report = await getAdminAnalytics({ range: resolveRange({}) });
  const active = report.users.filter((user) => user.postsInRange || user.savesInRange).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Users"
        description={`${fmt.number(report.kpis.totalUsers)} registered · ${fmt.number(active)} active in the last 30 days`}
        actions={
          <Link href="/admin/analytics#users" className={buttonClass("secondary")}>
            View trends
          </Link>
        }
      />
      {report.warnings.length > 0 && (
        <p
          role="status"
          className="rounded-md border border-line bg-warn-soft px-3 py-2 text-[13px] text-warn"
        >
          Some data could not be read, so totals may be low:{" "}
          {report.warnings.join("; ")}
        </p>
      )}
      <Panel
        title="All users"
        description="Active means the user submitted a post or saved a place."
        flush
      >
        <UsersTable
          rows={report.users}
          periodLabel="30d"
          pageSize={25}
          initialSort={SORTS.includes(requested) ? requested : "lastActive"}
        />
      </Panel>
    </div>
  );
}
