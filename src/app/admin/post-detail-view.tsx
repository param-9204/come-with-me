"use client";

import Link from "next/link";
import { useState } from "react";

import ExtractedComments, { apifyComments } from "./extracted-comments";
import ExtractionView, { latestRunHealth } from "./extraction-view";
import PostMediaGallery from "./post-media-gallery";
import Thumbnail from "./post-thumbnail";
import {
  type PostDetail,
  Places,
  collectPlaces,
  record,
  records,
  strings,
} from "./post-components";
import {
  Avatar,
  Chips,
  FactList,
  PageHeader,
  Panel,
  StatStrip,
  StatusBadge,
  buttonClass,
  fmt,
} from "./ui";
import { CopyButton, TabPanel, Tabs } from "./ui-client";

type Tab = "overview" | "places" | "comments" | "extraction" | "raw";
const TABS: Tab[] = ["overview", "places", "comments", "extraction", "raw"];

const optional = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

function initialTab(): Tab {
  if (typeof window === "undefined") return "overview";
  const hash = window.location.hash.slice(1) as Tab;
  return TABS.includes(hash) ? hash : "overview";
}

function Caption({ caption }: { caption: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!caption)
    return <p className="text-[13px] text-ink-3">This post has no caption.</p>;
  const long = caption.length > 420 || caption.split("\n").length > 8;
  return (
    <div>
      <p
        className={`text-[13px] leading-6 whitespace-pre-wrap text-ink ${long && !expanded ? "line-clamp-8" : ""}`}
      >
        {caption}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 cursor-pointer text-xs font-medium text-accent hover:underline"
        >
          {expanded ? "Show less" : "Show full caption"}
        </button>
      )}
    </div>
  );
}

function Overview({ detail }: { detail: PostDetail }) {
  const post = detail.post;
  const tagGroups: Array<[string, string[]]> = [
    ["Hashtags", strings(post.hashtags)],
    ["Mentions", strings(post.mentions)],
    ["Tagged creators", strings(post.tagged_users)],
    ["Brands mentioned", strings(post.mentioned_brands)],
    ["Locations mentioned", strings(post.mentioned_locations)],
    ["Calls to action", strings(post.call_to_actions)],
    ["Topics", strings(post.topics)],
  ];
  const present = tagGroups.filter(([, values]) => values.length);
  const missing = tagGroups.filter(([, values]) => !values.length);
  const transcript = optional(post.transcript);
  const visibleText = optional(post.visible_text);

  return (
    <div className="space-y-4">
      <Panel title="Caption">
        <Caption caption={optional(post.caption)} />
        {optional(post.first_comment) && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-1 text-xs text-ink-3">First comment</p>
            <p className="text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
              {String(post.first_comment)}
            </p>
          </div>
        )}
      </Panel>
      <Panel title="AI analysis">
        {optional(post.content_summary) ? (
          <p className="text-[13px] leading-6 text-ink">
            {String(post.content_summary)}
          </p>
        ) : (
          <p className="text-[13px] text-ink-3">No summary was generated.</p>
        )}
        {present.length > 0 && (
          <dl className="mt-4 divide-y divide-line border-t border-line">
            {present.map(([label, values]) => (
              <div
                key={label}
                className="grid gap-1 py-2.5 sm:grid-cols-[160px_minmax(0,1fr)]"
              >
                <dt className="text-xs text-ink-3 sm:pt-0.5">{label}</dt>
                <dd>
                  <Chips values={values} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {missing.length > 0 && (
          <p className="mt-3 text-xs text-ink-3">
            None recorded: {missing.map(([label]) => label.toLowerCase()).join(", ")}.
          </p>
        )}
      </Panel>
      {(transcript || visibleText) && (
        <Panel title="Spoken and on-screen text">
          <div className="space-y-2">
            {transcript && (
              <details>
                <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">
                  Audio transcript
                </summary>
                <p className="mt-2 text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                  {transcript}
                </p>
              </details>
            )}
            {visibleText && (
              <details>
                <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">
                  Text detected in media
                </summary>
                <p className="mt-2 text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                  {visibleText}
                </p>
              </details>
            )}
          </div>
        </Panel>
      )}
      <PostMediaGallery
        imageUrls={strings(post.images)}
        primaryImageUrl={optional(post.display_url)}
      />
    </div>
  );
}

function Requesters({ detail }: { detail: PostDetail }) {
  const requesters = records(detail.related.requesters);
  return (
    <Panel
      title="Requested by"
      description={
        requesters.length > 1
          ? `${requesters.length} users submitted this link`
          : undefined
      }
      flush
    >
      {requesters.length ? (
        <ul className="divide-y divide-line">
          {requesters.map((requester) => (
            <li key={String(requester.user_id)}>
              <Link
                href={`/admin/users/${requester.user_id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-subtle"
              >
                <Avatar
                  name={optional(requester.display_name)}
                  url={optional(requester.avatar_url)}
                />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {optional(requester.display_name) ||
                      optional(requester.email) ||
                      "Unnamed user"}
                  </p>
                  <p className="truncate text-xs text-ink-3">
                    {requester.is_creator ? "Created" : "Requested"}{" "}
                    {fmt.relative(requester.first_requested_at)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[13px] text-ink-3">
          Not linked to a registered user. It was submitted before user
          attribution or without signing in.
        </p>
      )}
    </Panel>
  );
}

export default function PostDetailView({
  postId,
  detail,
  backHref,
}: {
  postId: string;
  detail: PostDetail;
  backHref: string;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [placeQuery, setPlaceQuery] = useState("");
  const post = detail.post;
  const related = detail.related;
  const saves = record(related.saves);
  const reference = record(related.post_reference);
  const postUrl = optional(post.post_url) || optional(reference.url);
  const shortCode = optional(reference.short_code) || optional(post.short_code);
  const places = collectPlaces(detail).places.length;
  const comments = apifyComments(detail).length;
  const tokens = record(related.token_usage).total_tokens;
  const health = latestRunHealth(detail);
  const author = optional(post.author_username) || "unknown";
  const music = [post.music_name, post.music_artist]
    .filter((item): item is string => typeof item === "string" && Boolean(item))
    .join(" — ");

  function changeTab(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.hash = next === "overview" ? "" : next;
    window.history.replaceState(window.history.state, "", url);
  }

  const rawJson = {
    post,
    apify: related.apify ?? null,
    trace: related.trace ?? null,
    trace_json: related.trace_json ?? null,
    extraction: related.extraction ?? null,
    token_usage: related.token_usage ?? null,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <nav aria-label="Breadcrumb">
            <Link href={backHref} className="hover:text-ink hover:underline">
              Posts
            </Link>
            <span aria-hidden className="mx-1.5">
              /
            </span>
            <span aria-current="page">{shortCode || "Post"}</span>
          </nav>
        }
        title={
          <span className="flex items-center gap-3">
            <Thumbnail
              post={{
                id: postId,
                display_url: optional(post.display_url),
                image_urls: strings(post.images),
              }}
              className="h-12 w-10 shrink-0"
            />
            <span className="min-w-0 truncate">@{author}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 capitalize">
            <span>
              {[post.platform, post.content_type].filter(Boolean).join(" · ")}
            </span>
            <span aria-hidden>·</span>
            <span className="normal-case">
              Added {fmt.date(post.created_at, true)}
            </span>
            <span aria-hidden>·</span>
            <StatusBadge status={post.status} />
          </span>
        }
        actions={
          <>
            <CopyButton value={postId} label="post ID">
              Copy ID
            </CopyButton>
            {postUrl && (
              <a
                href={postUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("secondary")}
              >
                Open original ↗
              </a>
            )}
          </>
        }
      />

      {health &&
        (health.status === "failed" ||
          health.status === "partial" ||
          health.errors > 0) && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px]"
          >
            <span className="flex flex-wrap items-center gap-x-2 text-ink">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${health.status === "failed" || health.errors ? "bg-bad" : "bg-warn"}`}
              />
              Latest extraction {health.status === "completed" ? "completed" : `finished ${health.status}`}
              {" with "}
              {health.errors} {health.errors === 1 ? "error" : "errors"} and{" "}
              {health.warnings} {health.warnings === 1 ? "warning" : "warnings"}
              {health.message && <span className="text-ink-3">· {health.message}</span>}
            </span>
            <button
              type="button"
              onClick={() => changeTab("extraction")}
              className="cursor-pointer text-xs font-medium text-accent hover:underline"
            >
              Review issues
            </button>
          </div>
        )}

      {detail.warnings?.length ? (
        <p
          role="status"
          className="rounded-md border border-line bg-warn-soft px-3 py-2 text-[13px] text-warn"
        >
          Some optional records could not be loaded: {detail.warnings.join("; ")}
        </p>
      ) : null}

      <StatStrip
        items={[
          // Instagram reels report plays rather than views.
          Number(post.views) > 0 || !(Number(post.video_plays) > 0)
            ? { label: "Views", value: fmt.compact(post.views) }
            : { label: "Plays", value: fmt.compact(post.video_plays) },
          { label: "Likes", value: fmt.compact(post.likes) },
          { label: "Comments", value: fmt.compact(post.comments) },
          { label: "Shares", value: fmt.compact(post.shares) },
          { label: "Places found", value: fmt.number(places) },
          {
            label: "Saved in app",
            value: fmt.number(saves.total ?? 0),
            hint:
              typeof saves.users === "number" && saves.users > 0
                ? `by ${fmt.number(saves.users)} ${saves.users === 1 ? "user" : "users"}`
                : undefined,
          },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <Tabs<Tab>
            label="Post sections"
            idPrefix="post"
            active={tab}
            onChange={changeTab}
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "places", label: "Places", count: places },
              { id: "comments", label: "Comments", count: comments },
              {
                id: "extraction",
                label: "Extraction",
                count: health && health.errors > 0 ? health.errors : null,
              },
              { id: "raw", label: "Raw data" },
            ]}
          />
          <div className="mt-4">
            <TabPanel id={tab} idPrefix="post">
              {tab === "overview" && <Overview detail={detail} />}
              {tab === "places" && (
                <Places
                  detail={detail}
                  onInvestigate={(name) => {
                    setPlaceQuery(name);
                    changeTab("extraction");
                  }}
                />
              )}
              {tab === "comments" && <ExtractedComments detail={detail} />}
              {tab === "extraction" && (
                <ExtractionView key={placeQuery} detail={detail} placeQuery={placeQuery} />
              )}
              {tab === "raw" && (
                <Panel
                  title="Raw data"
                  description="Normalized post plus every related record returned by the API"
                  actions={
                    <CopyButton
                      value={JSON.stringify(rawJson, null, 2)}
                      label="raw JSON"
                    >
                      Copy JSON
                    </CopyButton>
                  }
                  flush
                >
                  <pre className="max-h-160 overflow-auto p-4 font-mono text-xs leading-5 text-ink-2">
                    {JSON.stringify(rawJson, null, 2)}
                  </pre>
                </Panel>
              )}
            </TabPanel>
          </div>
        </div>

        <aside className="space-y-4" aria-label="Post details">
          <Requesters detail={detail} />
          <Panel title="Details">
            <FactList
              items={[
                [
                  "Post ID",
                  <span key="id" className="font-mono text-xs break-all">
                    {postId}
                  </span>,
                ],
                ["Short code", shortCode],
                ["Creator name", optional(post.owner_full_name)],
                [
                  "Category",
                  optional(post.primary_category)?.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) ?? null,
                ],
                [
                  "Also tagged",
                  strings(post.secondary_categories).join(", ") || null,
                ],
                ["Niche", optional(post.niche)],
                ["Audience", optional(post.target_audience)],
                [
                  "Duration",
                  typeof post.video_duration === "number"
                    ? `${post.video_duration} s`
                    : null,
                ],
                [
                  "Dimensions",
                  post.dimensions_width && post.dimensions_height
                    ? `${post.dimensions_width} × ${post.dimensions_height}`
                    : null,
                ],
                ["Video plays", fmt.number(post.video_plays, "")],
                ["Platform saves", fmt.number(post.saves, "")],
                ["Music", music || null],
                ["Tokens used", fmt.number(tokens, "")],
                [
                  "Been here / want to go",
                  typeof saves.total === "number" && saves.total > 0
                    ? `${fmt.number(saves.been_here)} / ${fmt.number(saves.want_to_go)}`
                    : null,
                ],
                [
                  "Video",
                  optional(post.video_url) ? (
                    <a
                      key="video"
                      href={String(post.video_url)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      Open ↗
                    </a>
                  ) : null,
                ],
              ]}
            />
          </Panel>
        </aside>
      </div>
    </div>
  );
}

