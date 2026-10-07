"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { UserRow } from "@/lib/admin-analytics";
import Pagination from "./pagination";
import { Avatar, EmptyState, cx, fmt, inputClass } from "./ui";

export type UserSort =
  | "postsInRange"
  | "postsTotal"
  | "savesInRange"
  | "savesTotal"
  | "lastActive"
  | "joined"
  | "name";

const sortValue = (row: UserRow, sort: UserSort): number | string => {
  switch (sort) {
    case "lastActive":
      return row.lastActiveAt ?? "";
    case "joined":
      return row.joinedAt ?? "";
    case "name":
      return (row.name || row.email || "").toLowerCase();
    default:
      return row[sort];
  }
};

function Header({
  column,
  label,
  className,
  sort,
  ascending,
  onSort,
}: {
  column: UserSort;
  label: string;
  className?: string;
  sort: UserSort;
  ascending: boolean;
  onSort: (column: UserSort) => void;
}) {
  const active = sort === column;
  return (
    <th
      scope="col"
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      className={cx("px-3 py-2 font-medium whitespace-nowrap", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cx(
          "inline-flex cursor-pointer items-center gap-1 hover:text-ink",
          active && "text-ink",
        )}
      >
        {label}
        <span aria-hidden className="text-[10px]">
          {active ? (ascending ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/**
 * User-wise activity table. Rows are already aggregated server-side; search,
 * sorting and paging run locally because the full user list is in memory.
 */
export default function UsersTable({
  rows,
  periodLabel,
  initialSort = "postsInRange",
  pageSize = 10,
  showPeriod = true,
}: {
  rows: UserRow[];
  periodLabel: string;
  initialSort?: UserSort;
  pageSize?: number;
  showPeriod?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<UserSort>(initialSort);
  const [ascending, setAscending] = useState(initialSort === "name");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = term
      ? rows.filter((row) =>
          [row.name, row.email, row.id].some((value) =>
            value?.toLowerCase().includes(term),
          ),
        )
      : rows;
    return [...matches].sort((a, b) => {
      const left = sortValue(a, sort);
      const right = sortValue(b, sort);
      const result =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      // Ties fall back to most recent activity, then name.
      return (
        (ascending ? result : -result) ||
        String(b.lastActiveAt ?? "").localeCompare(String(a.lastActiveAt ?? "")) ||
        String(a.name ?? "").localeCompare(String(b.name ?? ""))
      );
    });
  }, [rows, search, sort, ascending]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * pageSize, current * pageSize);
  const maxPosts = Math.max(1, ...rows.map((row) => row.postsInRange));
  const headerProps = { sort, ascending, onSort: sortBy };

  function sortBy(column: UserSort) {
    if (column === sort) setAscending((value) => !value);
    else {
      setSort(column);
      setAscending(column === "name");
    }
    setPage(1);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Search users</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search name, email or ID"
            className={cx(inputClass, "w-full")}
          />
        </label>
        <p className="text-xs text-ink-3 tabular-nums">
          {fmt.number(filtered.length)}{" "}
          {filtered.length === 1 ? "user" : "users"}
        </p>
      </div>
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line bg-subtle text-xs text-ink-3">
              <tr>
                <Header {...headerProps} column="name" label="User" />
                {showPeriod && (
                  <Header
                  {...headerProps}
                    column="postsInRange"
                    label={`Posts · ${periodLabel}`}
                    className="text-right"
                  />
                )}
                <Header
                  {...headerProps}
                  column="postsTotal"
                  label="Posts · all time"
                  className="hidden text-right sm:table-cell"
                />
                {showPeriod && (
                  <Header
                  {...headerProps}
                    column="savesInRange"
                    label={`Saves · ${periodLabel}`}
                    className="hidden text-right md:table-cell"
                  />
                )}
                <Header
                  {...headerProps}
                  column="savesTotal"
                  label="Saves · all time"
                  className={cx("text-right", showPeriod ? "hidden lg:table-cell" : "hidden sm:table-cell")}
                />
                <Header
                  {...headerProps}
                  column="lastActive"
                  label="Last active"
                  className="hidden text-right md:table-cell"
                />
                <Header
                  {...headerProps}
                  column="joined"
                  label="Joined"
                  className="hidden text-right lg:table-cell"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((row) => {
                const href = `/admin/users/${row.id}`;
                return (
                  <tr
                    key={row.id}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a")) return;
                      router.push(href);
                    }}
                    className="cursor-pointer hover:bg-subtle"
                  >
                    <td className="w-full max-w-0 px-3 py-2">
                      <div className="flex min-w-48 items-center gap-2.5">
                        <Avatar name={row.name || row.email} url={row.avatarUrl} />
                        <div className="min-w-0">
                          <Link
                            href={href}
                            className="block truncate font-medium text-ink hover:text-accent"
                          >
                            {row.name || "Unnamed user"}
                          </Link>
                          <p className="truncate text-xs text-ink-3">
                            {row.email || row.id}
                          </p>
                        </div>
                      </div>
                    </td>
                    {showPeriod && (
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span
                            aria-hidden
                            className="hidden h-1 w-16 rounded-full bg-subtle sm:block"
                          >
                            <span
                              className="block h-1 rounded-full bg-accent"
                              style={{
                                width: `${(row.postsInRange / maxPosts) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="w-8 text-ink tabular-nums">
                            {fmt.number(row.postsInRange)}
                          </span>
                        </div>
                      </td>
                    )}
                    <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums sm:table-cell">
                      {fmt.number(row.postsTotal)}
                    </td>
                    {showPeriod && (
                      <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">
                        {fmt.number(row.savesInRange)}
                      </td>
                    )}
                    <td
                      className={cx(
                        "px-3 py-2 text-right text-ink-2 tabular-nums",
                        showPeriod ? "hidden lg:table-cell" : "hidden sm:table-cell",
                      )}
                    >
                      {fmt.number(row.savesTotal)}
                    </td>
                    <td
                      className="hidden px-3 py-2 text-right whitespace-nowrap text-ink-3 md:table-cell"
                      title={fmt.date(row.lastActiveAt, true)}
                      suppressHydrationWarning
                    >
                      {row.lastActiveAt ? fmt.relative(row.lastActiveAt) : "Never"}
                    </td>
                    <td className="hidden px-3 py-2 text-right whitespace-nowrap text-ink-3 lg:table-cell">
                      {fmt.date(row.joinedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={rows.length ? "No users match this search" : "No users yet"}
        />
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
          <span className="text-xs text-ink-3 tabular-nums">
            Page {current} of {pages}
          </span>
          <Pagination
            label="Users pagination"
            page={current}
            totalPages={pages}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
