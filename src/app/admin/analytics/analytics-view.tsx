"use client";

import Link from "next/link";
import { useState } from "react";

import type { AnalyticsReport, Breakdown } from "@/lib/admin-analytics";
import { BarList, type BarListItem, ColumnChart } from "../charts";
import {
  FactList,
  PageHeader,
  Panel,
  StatStrip,
  buttonClass,
  cx,
  fmt,
} from "../ui";
import UsersTable from "../users-table";
import { AdminSelect } from "../ui-client";
import {
  AnalyticsNav,
  RangeControls,
  platformName,
  rangeLabel as labelForRange,
  useUrlUpdate,
} from "./controls";

type Metric = "posts" | "activeUsers" | "newUsers" | "saves";

const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "posts", label: "Posts" },
  { key: "activeUsers", label: "Active users" },
  { key: "newUsers", label: "New users" },
  { key: "saves", label: "Place saves" },
];

export default function AnalyticsView({ report }: { report: AnalyticsReport }) {
  const { isPending, update } = useUrlUpdate();
  const [metric, setMetric] = useState<Metric>("posts");

  const { range, kpis, scope, scopedUser } = report;
  const userScoped = Boolean(scope.userId);
  const metrics = userScoped
    ? METRICS.filter((item) => item.key !== "newUsers")
    : METRICS;
  const activeMetric = metrics.some((item) => item.key === metric)
    ? metric
    : "posts";

  /** Builds an /admin posts link for the current period and filters. */
  function postsHref(extra: Record<string, string> = {}) {
    const params = new URLSearchParams();
    if (range.key !== "all") {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    if (scope.platform) params.set("platform", scope.platform);
    if (scope.userId) params.set("user", scope.userId);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    return `/admin?${params.toString()}`;
  }

  const rangeLabel = labelForRange(range);
  const periodShort =
    range.key === "custom" ? "period" : range.key === "all" ? "all" : range.key;
  const vsLabel =
    range.key === "all"
      ? ""
      : ` · compared with ${fmt.day(report.previous.from, true)} – ${fmt.day(report.previous.to, true)}`;

  const toItems = (
    items: Breakdown[],
    href?: (item: Breakdown) => string | undefined,
  ): BarListItem[] =>
    items.map((item) => ({
      key: item.key || "none",
      label: item.label,
      count: item.count,
      href: href && item.key && item.key !== "__other" ? href(item) : undefined,
    }));

  const sortedUsers = [...report.users].sort((a, b) =>
    (a.name || a.email || "").localeCompare(b.name || b.email || ""),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description={`${rangeLabel}: ${fmt.day(range.from, true)} – ${fmt.day(range.to, true)} (UTC)${vsLabel}`}
      />
      <AnalyticsNav />

      <div
        role="group"
        aria-label="Analytics filters"
        className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"
      >
        <RangeControls key={`${range.from}-${range.to}`} range={range} update={update} />
        <div className="flex flex-wrap items-center gap-2">
          <AdminSelect
            label="Platform"
            value={scope.platform ?? ""}
            onChange={(platform) => update({ platform })}
            options={[
              { value: "", label: "All platforms" },
              ...report.platforms.map((platform) => ({
                value: platform,
                label: platformName(platform),
              })),
            ]}
            className="min-w-30"
          />
          <AdminSelect
            label="User"
            value={scope.userId ?? ""}
            onChange={(user) => update({ user })}
            options={[
              { value: "", label: "All users" },
              ...sortedUsers.map((user) => ({
                value: user.id,
                label: user.name || user.email || user.id,
              })),
            ]}
            className="w-56 max-w-full"
          />
        </div>
      </div>

      {report.warnings.length > 0 && (
        <p
          role="status"
          className="rounded-md border border-line bg-warn-soft px-3 py-2 text-[13px] text-warn"
        >
          Some data could not be read, so totals may be low:{" "}
          {report.warnings.join("; ")}
        </p>
      )}

      {userScoped && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-accent-soft px-3 py-2 text-[13px] text-ink">
          <span>
            Showing activity for{" "}
            <strong className="font-medium">
              {scopedUser?.name || scopedUser?.email || "this user"}
            </strong>
            . Post dates are when this user submitted each post.
          </span>
          <span className="flex gap-3">
            <Link
              href={`/admin/users/${scope.userId}`}
              className="font-medium text-accent hover:underline"
            >
              Open profile
            </Link>
            <button
              type="button"
              onClick={() => update({ user: null })}
              className="cursor-pointer text-ink-2 hover:text-ink hover:underline"
            >
              Show all users
            </button>
          </span>
        </div>
      )}

      <div
        aria-busy={isPending}
        className={cx("space-y-5 transition-opacity", isPending && "opacity-60")}
      >
        <StatStrip
          items={[
            {
              label: userScoped ? "Posts submitted" : "Posts",
              value: fmt.number(kpis.posts.value),
              delta: kpis.posts,
              href: postsHref(),
            },
            ...(userScoped
              ? []
              : [
                  {
                    label: "Active users",
                    value: fmt.number(kpis.activeUsers.value),
                    delta: kpis.activeUsers,
                    hint: `of ${fmt.number(kpis.totalUsers)} registered`,
                  },
                  {
                    label: "New users",
                    value: fmt.number(kpis.newUsers.value),
                    delta: kpis.newUsers,
                  },
                ]),
            {
              label: "Place saves",
              value: fmt.number(kpis.saves.value),
              delta: kpis.saves,
            },
            {
              label: "Processed successfully",
              value: fmt.percent(kpis.completionRate),
              hint: "Share of posts that completed extraction",
              href: postsHref({ status: "failed" }),
            },
            ...(userScoped
              ? []
              : [
                  {
                    label: "Posts per active user",
                    value:
                      kpis.postsPerActiveUser === null
                        ? "—"
                        : kpis.postsPerActiveUser.toFixed(1),
                    hint: `${fmt.number(kpis.unattributedPosts)} posts have no user`,
                  },
                ]),
          ]}
        />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Panel
            title="Activity over time"
            description={`Per ${report.granularity}, UTC`}
            actions={
              <div
                role="group"
                aria-label="Chart metric"
                className="flex flex-wrap rounded-md border border-line-strong p-0.5"
              >
                {metrics.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={activeMetric === item.key}
                    onClick={() => setMetric(item.key)}
                    className={cx(
                      "h-6 cursor-pointer rounded px-2 text-xs font-medium",
                      activeMetric === item.key
                        ? "bg-subtle text-ink"
                        : "text-ink-3 hover:text-ink",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            }
          >
            <ColumnChart
              key={`${activeMetric}-${range.from}-${range.to}`}
              seriesLabel={
                metrics.find((item) => item.key === activeMetric)?.label ??
                "Posts"
              }
              granularity={report.granularity}
              height={264}
              points={report.series.map((point) => ({
                date: point.date,
                value: point[activeMetric],
              }))}
            />
          </Panel>

          <div className="space-y-5">
            <Panel title="Processing status">
              <BarList
                items={toItems(report.breakdowns.status, (item) =>
                  postsHref({ status: item.key }),
                )}
              />
            </Panel>
            <Panel
              title="Source engagement"
              description={`Platform metrics of ${fmt.number(report.engagement.postsWithMetrics)} posts with view counts`}
            >
              <FactList
                items={[
                  ["Median views", fmt.compact(report.engagement.medianViews)],
                  ["Median likes", fmt.compact(report.engagement.medianLikes)],
                  ["Total views", fmt.compact(report.engagement.totalViews)],
                  ["Total likes", fmt.compact(report.engagement.totalLikes)],
                  [
                    "Total comments",
                    fmt.compact(report.engagement.totalComments),
                  ],
                ]}
              />
            </Panel>
          </div>
        </div>

        {!userScoped && (
          <Panel
            id="users"
            title="User activity"
            description={
              kpis.unattributedPosts > 0 ? (
                <>
                  Posts each user submitted or re-submitted.{" "}
                  <Link
                    href={postsHref({ user: "none" })}
                    className="text-accent hover:underline"
                  >
                    {fmt.number(kpis.unattributedPosts)} posts in this period
                    have no user
                  </Link>
                  .
                </>
              ) : (
                "Posts each user submitted or re-submitted"
              )
            }
            actions={
              <Link href="/admin/users" className={buttonClass("ghost", "sm")}>
                All users
              </Link>
            }
            flush
          >
            <UsersTable rows={report.users} periodLabel={periodShort} />
          </Panel>
        )}

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Panel title="Categories" description="Primary category per post">
            <BarList
              items={toItems(report.breakdowns.category, (item) =>
                postsHref({ q: item.label }),
              )}
            />
          </Panel>
          <Panel title="Platforms and formats">
            <BarList
              items={toItems(report.breakdowns.platform, (item) =>
                postsHref({ platform: item.key }),
              )}
            />
            <div className="mt-5 border-t border-line pt-4">
              <BarList
                items={toItems(report.breakdowns.contentType, (item) =>
                  postsHref({ type: item.key }),
                )}
              />
            </div>
          </Panel>
          <Panel
            title="Most submitted creators"
            description="Instagram and TikTok accounts behind the posts"
          >
            <BarList
              items={toItems(report.breakdowns.creators, (item) =>
                postsHref({ q: item.key }),
              )}
              total={kpis.posts.value}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
