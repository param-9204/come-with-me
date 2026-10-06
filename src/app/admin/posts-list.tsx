"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import type { AdminPostSummary } from "@/lib/admin-posts";
import Thumbnail from "./post-thumbnail";
import { StatusBadge, cx, fmt } from "./ui";

type SortKey = "created_at" | "views" | "likes" | "comments";
type Props = {
  posts: AdminPostSummary[];
  postHref: (id: string) => string;
  sort: string;
  ascending: boolean;
  onSort: (sort: SortKey, ascending: boolean) => void;
};

function SortHeader({
  column,
  label,
  className,
  sort,
  ascending,
  onSort,
}: {
  column: SortKey;
  label: string;
  className?: string;
} & Pick<Props, "sort" | "ascending" | "onSort">) {
  const active = sort === column;
  return (
    <th
      scope="col"
      aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}
      className={cx("px-3 py-2 font-medium", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column, active ? !ascending : false)}
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
 * Posts table. Secondary columns drop out as the viewport narrows; on phones the
 * post cell carries a one-line summary of what the hidden columns showed.
 */
export default function PostsList({
  posts,
  postHref,
  sort,
  ascending,
  onSort,
}: Props) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-line bg-subtle text-xs text-ink-3">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Post
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium whitespace-nowrap lg:table-cell">
              Submitted by
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
              Format
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">
              Category
            </th>
            <SortHeader
              sort={sort}
              ascending={ascending}
              onSort={onSort}
              column="views"
              label="Views"
              className="hidden text-right md:table-cell"
            />
            <SortHeader
              sort={sort}
              ascending={ascending}
              onSort={onSort}
              column="likes"
              label="Likes"
              className="hidden text-right md:table-cell"
            />
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <SortHeader
              sort={sort}
              ascending={ascending}
              onSort={onSort}
              column="created_at"
              label="Added"
              className="hidden text-right sm:table-cell"
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {posts.map((post) => {
            const href = postHref(post.id);
            return (
              <tr
                key={post.id}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a")) return;
                  router.push(href);
                }}
                className="cursor-pointer align-middle hover:bg-subtle"
              >
                <td className="w-full max-w-0 px-3 py-2">
                  <div className="flex min-w-52 items-center gap-3">
                    <Thumbnail post={post} className="h-11 w-9 shrink-0" />
                    <div className="min-w-0">
                      <Link
                        href={href}
                        className="block truncate font-medium text-ink hover:text-accent"
                      >
                        @{post.author_username || "unknown"}
                      </Link>
                      <p
                        className="truncate text-xs text-ink-3"
                        title={post.caption || undefined}
                      >
                        {post.caption?.split("\n")[0] || "No caption"}
                      </p>
                      <p
                        className="mt-0.5 truncate text-xs text-ink-3 capitalize md:hidden"
                        suppressHydrationWarning
                      >
                        {[
                          post.platform,
                          post.content_type,
                          post.views ? `${fmt.compact(post.views)} views` : null,
                          fmt.relative(post.created_at),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="hidden px-3 py-2 lg:table-cell">
                  {post.user_id ? (
                    <Link
                      href={`/admin/users/${post.user_id}`}
                      className="block max-w-44 truncate text-ink-2 hover:text-accent hover:underline"
                    >
                      {post.user_name || "Unnamed user"}
                    </Link>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="hidden px-3 py-2 whitespace-nowrap text-ink-2 capitalize md:table-cell">
                  {[post.platform, post.content_type].filter(Boolean).join(" · ")}
                </td>
                <td className="hidden max-w-40 truncate px-3 py-2 text-ink-2 capitalize xl:table-cell">
                  {post.primary_category?.toLowerCase() || (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">
                  {fmt.compact(post.views)}
                </td>
                <td className="hidden px-3 py-2 text-right text-ink-2 tabular-nums md:table-cell">
                  {fmt.compact(post.likes)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={post.status} />
                </td>
                <td
                  className="hidden px-3 py-2 text-right whitespace-nowrap text-ink-3 sm:table-cell"
                  title={fmt.date(post.created_at, true)}
                  suppressHydrationWarning
                >
                  {fmt.relative(post.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
