"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { AdminUserDetail } from "@/lib/admin-analytics";
import type { AdminPostSummary } from "@/lib/admin-posts";
import { BarList, ColumnChart } from "../../charts";
import PostsList from "../../posts-list";
import {
  Avatar,
  EmptyState,
  FactList,
  PageHeader,
  Panel,
  StatStrip,
  buttonClass,
  cx,
  fmt,
} from "../../ui";
import { CopyButton, TabPanel, Tabs } from "../../ui-client";

type Tab = "overview" | "posts" | "activity";

const SAVE_LABELS: Record<string, string> = {
  BEEN_HERE: "Been here",
  WANT_TO_GO: "Want to go",
};

export default function UserDetailView({
  detail,
  recentPosts,
  postsError,
}: {
  detail: AdminUserDetail;
  recentPosts: AdminPostSummary[];
  postsError: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [series, setSeries] = useState<"posts" | "saves">("posts");
  const { profile, stats } = detail;
  const name = profile.name || profile.email || "Unnamed user";
  const postsHref = `/admin?user=${profile.id}`;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <nav aria-label="Breadcrumb">
            <Link href="/admin/users" className="hover:text-ink hover:underline">
              Users
            </Link>
            <span aria-hidden className="mx-1.5">
              /
            </span>
            <span aria-current="page">{name}</span>
          </nav>
        }
        title={
          <span className="flex items-center gap-3">
            <Avatar name={name} url={profile.avatarUrl} size={40} />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        }
        description={[
          profile.email,
          profile.createdAt ? `Joined ${fmt.date(profile.createdAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <CopyButton value={profile.id} label="user ID">
              Copy ID
            </CopyButton>
            <Link
              href={`/admin/analytics?user=${profile.id}&range=all`}
              className={buttonClass("secondary")}
            >
              Analytics
            </Link>
            <Link href={postsHref} className={buttonClass("primary")}>
              View posts
            </Link>
          </>
        }
      />

      {detail.warnings.length > 0 && (
        <p
          role="status"
          className="rounded-md border border-line bg-warn-soft px-3 py-2 text-[13px] text-warn"
        >
          Some data could not be read, so totals may be low:{" "}
          {detail.warnings.join("; ")}
        </p>
      )}

      <StatStrip
        items={[
          {
            label: "Posts",
            value: fmt.number(stats.postsTotal),
            hint: `${fmt.number(stats.posts30d)} in the last 30 days`,
            href: postsHref,
          },
          {
            label: "Place saves",
            value: fmt.number(stats.savesTotal),
            hint: `${fmt.number(stats.saves30d)} in the last 30 days`,
          },
          {
            label: "Been here / want to go",
            value: `${fmt.number(stats.beenHere)} / ${fmt.number(stats.wantToGo)}`,
          },
          { label: "Active days", value: fmt.number(stats.activeDays) },
          {
            label: "Last active",
            value: (
              <span suppressHydrationWarning>
                {stats.lastActiveAt ? fmt.relative(stats.lastActiveAt) : "Never"}
              </span>
            ),
            hint: stats.firstActiveAt
              ? `First active ${fmt.date(stats.firstActiveAt)}`
              : undefined,
          },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <Tabs<Tab>
            label="User sections"
            idPrefix="user"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "posts", label: "Posts", count: stats.postsTotal },
              { id: "activity", label: "Activity" },
            ]}
          />
          <div className="mt-4">
            <TabPanel id={tab} idPrefix="user">
              {tab === "overview" && (
                <div className="space-y-4">
                  <Panel
                    title="Weekly activity"
                    description="Last 12 weeks, UTC"
                    actions={
                      <div
                        role="group"
                        aria-label="Chart metric"
                        className="flex rounded-md border border-line-strong p-0.5"
                      >
                        {(["posts", "saves"] as const).map((key) => (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={series === key}
                            onClick={() => setSeries(key)}
                            className={cx(
                              "h-6 cursor-pointer rounded px-2 text-xs font-medium",
                              series === key
                                ? "bg-subtle text-ink"
                                : "text-ink-3 hover:text-ink",
                            )}
                          >
                            {key === "posts" ? "Posts" : "Place saves"}
                          </button>
                        ))}
                      </div>
                    }
                  >
                    <ColumnChart
                      key={series}
                      seriesLabel={series === "posts" ? "Posts" : "Place saves"}
                      granularity="week"
                      height={180}
                      points={detail.weekly.map((week) => ({
                        date: week.date,
                        value: week[series],
                      }))}
                    />
                  </Panel>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Panel title="Platforms">
                      <BarList
                        items={detail.platforms.map((item) => ({
                          ...item,
                          key: item.key || "none",
                          href: item.key
                            ? `${postsHref}&platform=${item.key}`
                            : undefined,
                        }))}
                        empty="No posts yet."
                      />
                    </Panel>
                    <Panel title="Categories">
                      <BarList
                        items={detail.categories.map((item) => ({
                          ...item,
                          key: item.key || "none",
                        }))}
                        empty="No posts yet."
                      />
                    </Panel>
                  </div>
                </div>
              )}
              {tab === "posts" && (
                <Panel
                  title="Most recent posts"
                  description="Includes posts this user submitted after someone else first added them"
                  actions={
                    stats.postsTotal > recentPosts.length ? (
                      <Link href={postsHref} className={buttonClass("ghost", "sm")}>
                        All {fmt.number(stats.postsTotal)} posts
                      </Link>
                    ) : null
                  }
                  flush
                >
                  {postsError ? (
                    <p role="alert" className="p-4 text-[13px] text-bad">
                      Posts could not be loaded: {postsError}
                    </p>
                  ) : recentPosts.length ? (
                    <PostsList
                      posts={recentPosts}
                      postHref={(id) => `/admin/${id}?user=${profile.id}`}
                      sort="created_at"
                      ascending={false}
                      onSort={(sort, ascending) =>
                        router.push(
                          `${postsHref}${sort === "created_at" ? "" : `&sort=${sort}`}${ascending ? "&dir=asc" : ""}`,
                        )
                      }
                    />
                  ) : (
                    <EmptyState
                      title="No posts yet"
                      description="This user has not submitted any links."
                    />
                  )}
                </Panel>
              )}
              {tab === "activity" && <ActivityList detail={detail} />}
            </TabPanel>
          </div>
        </div>

        <aside aria-label="Profile">
          <Panel title="Profile">
            <FactList
              items={[
                [
                  "User ID",
                  <span key="id" className="font-mono text-xs break-all">
                    {profile.id}
                  </span>,
                ],
                [
                  "Clerk ID",
                  profile.clerkUserId ? (
                    <span key="clerk" className="font-mono text-xs break-all">
                      {profile.clerkUserId}
                    </span>
                  ) : null,
                ],
                ["Email", profile.email],
                ["Phone", profile.phone],
                ["Signed up with", profile.signupMethod],
                ["Last sign-in method", profile.lastSignInMethod],
                ["Joined", fmt.date(profile.createdAt, true)],
              ]}
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function ActivityList({ detail }: { detail: AdminUserDetail }) {
  if (!detail.activity.length)
    return (
      <Panel>
        <EmptyState
          title="No activity yet"
          description="Submitted posts and saved places appear here."
        />
      </Panel>
    );
  return (
    <Panel
      title="Recent activity"
      description="Latest 25 submissions and place saves"
      flush
    >
      <ol className="divide-y divide-line">
        {detail.activity.map((item, index) => (
          <li
            key={`${item.kind}-${item.at}-${index}`}
            className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 px-4 py-2.5 sm:grid-cols-[120px_minmax(0,1fr)]"
          >
            <time
              dateTime={item.at}
              title={fmt.date(item.at, true)}
              className="pt-px text-xs text-ink-3"
              suppressHydrationWarning
            >
              {fmt.relative(item.at)}
            </time>
            {item.kind === "post" ? (
              <div className="min-w-0">
                <p className="text-[13px] text-ink">
                  Submitted{" "}
                  <Link
                    href={`/admin/${item.postId}`}
                    className="font-medium hover:text-accent hover:underline"
                  >
                    @{item.author || "unknown"}
                  </Link>{" "}
                  <span className="text-ink-3 capitalize">
                    · {item.platform}
                    {item.status !== "completed" ? ` · ${item.status}` : ""}
                  </span>
                </p>
                {item.caption && (
                  <p className="truncate text-xs text-ink-3">{item.caption}</p>
                )}
              </div>
            ) : (
              <div className="min-w-0">
                <p className="text-[13px] text-ink">
                  Saved{" "}
                  <span className="font-medium">
                    {item.placeName || "a place"}
                  </span>
                  {item.placeCity && (
                    <span className="text-ink-3"> · {item.placeCity}</span>
                  )}
                </p>
                <p className="text-xs text-ink-3">
                  {item.saveStatus
                    ? (SAVE_LABELS[item.saveStatus] ?? item.saveStatus)
                    : "No list status"}
                  {item.postId && (
                    <>
                      {" · "}
                      <Link
                        href={`/admin/${item.postId}`}
                        className="hover:text-accent hover:underline"
                      >
                        from post
                      </Link>
                    </>
                  )}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
