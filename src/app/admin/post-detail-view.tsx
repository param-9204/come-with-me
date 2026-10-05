"use client";

import { useState } from "react";

import ApifyTraceDetails from "./apify-trace-details";
import ExtractedComments from "./extracted-comments";
import PostMediaGallery from "./post-media-gallery";
import {
  ApifyExtraction,
  type Data,
  type PostDetail,
  ExtractionPipeline,
  Info,
  Metric,
  OverlayMetric,
  Places,
  PostReference,
  Section,
  Tags,
  TokenUsage,
  TraceLog,
  date,
  strings,
  text,
} from "./post-components";

type PrimaryTab = "social" | "apify";
type ExtractionView = "readable" | "json";

const tabClass = (active: boolean) =>
  `cursor-pointer rounded-lg px-3 py-2 text-xs font-bold transition ${active ? "bg-indigo-500/20 text-indigo-200" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`;

function SocialPostMetrics({ post }: { post: Data }) {
  const metrics: Array<[string, unknown]> = [
    ["Views", post.views],
    ["Likes", post.likes],
    ["Comments", post.comments],
    ["Video plays", post.video_plays],
    ["Shares", post.shares],
    ["Saves", post.saves],
  ];
  const availableMetrics = metrics.filter(([, value]) =>
    Number.isFinite(Number(value)),
  );

  if (!availableMetrics.length) return null;
  return (
    <Section title="Post / reel metrics">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {availableMetrics.map(([title, value]) => (
          <Metric key={title} title={title} value={value} />
        ))}
      </div>
    </Section>
  );
}

function SocialPostVideo({ post }: { post: Data }) {
  const videoUrl = typeof post.video_url === "string" ? post.video_url : null;
  if (!videoUrl) return null;

  return (
    <Section title="Video">
      <a
        href={videoUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-300 hover:text-indigo-200"
      >
        Open post video <span aria-hidden>&#8599;</span>
      </a>
    </Section>
  );
}

function PostPreview({ post }: { post: Data }) {
  const primaryImageUrl =
    typeof post.display_url === "string" ? post.display_url : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/65">
      <div className="grid lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="relative !h-[439px] !w-[260px] overflow-hidden bg-zinc-950 lg:mx-0">
          {primaryImageUrl ? (
            <img
              src={primaryImageUrl}
              alt="Post cover"
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-5xl text-zinc-700">
              &#9678;
            </div>
          )}
          <p className="absolute left-3 top-3 rounded-md bg-black/45 px-2 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-white shadow-lg">
            {text(post.platform)} {text(post.content_type)}
          </p>
          <div className="absolute bottom-[86px] right-2 grid w-[48px] grid-cols-1 gap-2 rounded-2xl border border-white/15 bg-black/55 py-2 shadow-xl backdrop-blur-md">
            <OverlayMetric label="Views" value={post.views} />
            <OverlayMetric label="Likes" value={post.likes} />
            <OverlayMetric label="Comments" value={post.comments} />
            <OverlayMetric label="Plays" value={post.video_plays} />
            <OverlayMetric label="Shares" value={post.shares} />
            <OverlayMetric label="Saves" value={post.saves} />
          </div>
          <div className="absolute bottom-3 left-3 right-[60px] rounded-xl border border-white/15 bg-black/40 p-3 backdrop-blur-md">
            <p className="truncate text-base font-bold text-white">
              @{text(post.author_username)}
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-white/75">
              {[post.owner_full_name, post.niche]
                .filter(
                  (item): item is string =>
                    typeof item === "string" && item.length > 0,
                )
                .join(" | ") || "Creator profile"}
            </p>
          </div>
        </div>
        <div className="h-[439px] overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-zinc-700">
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-indigo-300">
            Caption
          </p>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-200">
            {text(post.caption)}
          </p>
          <div className="mt-6 space-y-5">
            <Info title="Hashtags">
              <Tags values={strings(post.hashtags)} />
            </Info>
            <Info title="Mentions">
              <Tags values={strings(post.mentions)} />
            </Info>
            {typeof post.first_comment === "string" && post.first_comment && (
              <Info title="First comment">
                <p className="whitespace-pre-wrap text-zinc-400">
                  {post.first_comment}
                </p>
              </Info>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SocialPostContent({ detail }: { detail: PostDetail }) {
  const post = detail.post;
  const images = strings(post.images);
  const primaryImageUrl =
    typeof post.display_url === "string" ? post.display_url : null;
  const music = [post.music_name, post.music_artist]
    .filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
    .join(" — ");

  return (
    <div className="space-y-5">
      <PostMediaGallery imageUrls={images} primaryImageUrl={primaryImageUrl} />
      <PostReference detail={detail} />
      <SocialPostMetrics post={post} />
      <SocialPostVideo post={post} />
      <TokenUsage detail={detail} />
      <Section title="Content insights" note={date(post.created_at, true)}>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          <Info title="Summary">{text(post.content_summary)}</Info>
          <Info title="Primary category">{text(post.primary_category)}</Info>
          <Info title="Additional categories">
            <Tags values={strings(post.secondary_categories)} />
          </Info>
          <Info title="Music">{music || "Not available"}</Info>
          <Info title="Video duration">
            {typeof post.video_duration === "number"
              ? `${post.video_duration} seconds`
              : "Not available"}
          </Info>
          <Info title="Video format">
            {post.dimensions_width && post.dimensions_height
              ? `${post.dimensions_width} × ${post.dimensions_height}`
              : "Not available"}
          </Info>
          <Info title="Creator niche">{text(post.niche)}</Info>
          <Info title="Audience">{text(post.target_audience)}</Info>
          <Info title="First comment">{text(post.first_comment)}</Info>
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Info title="Hashtags">
            <Tags values={strings(post.hashtags)} />
          </Info>
          <Info title="Mentions">
            <Tags values={strings(post.mentions)} />
          </Info>
          <Info title="Tagged creators">
            <Tags values={strings(post.tagged_users)} />
          </Info>
          <Info title="Brands mentioned">
            <Tags values={strings(post.mentioned_brands)} />
          </Info>
          <Info title="Locations mentioned">
            <Tags values={strings(post.mentioned_locations)} />
          </Info>
          <Info title="Calls to action">
            <Tags values={strings(post.call_to_actions)} />
          </Info>
          <Info title="Content topics">
            <Tags values={strings(post.topics)} />
          </Info>
        </div>
      </Section>
      <Section
        title="Places found"
        note="Map pins use saved or resolved locations"
      >
        <Places detail={detail} />
      </Section>
      <ExtractedComments detail={detail} />
    </div>
  );
}

function ApifyExtractionContent({ detail }: { detail: PostDetail }) {
  const post = detail.post;
  const hasExtractedContent =
    (typeof post.transcript === "string" && post.transcript) ||
    (typeof post.visible_text === "string" && post.visible_text);

  return (
    <div className="space-y-5">
      <ApifyExtraction detail={detail} />
      <TraceLog detail={detail} />
      <ApifyTraceDetails detail={detail} />
      {hasExtractedContent && (
        <Section title="Spoken and visible content">
          <div className="grid gap-5 lg:grid-cols-2">
            {typeof post.transcript === "string" && post.transcript && (
              <Info title="Audio transcript">
                <p className="whitespace-pre-wrap text-zinc-300">
                  {post.transcript}
                </p>
              </Info>
            )}
            {typeof post.visible_text === "string" && post.visible_text && (
              <Info title="Text detected in media">
                <p className="whitespace-pre-wrap text-zinc-300">
                  {post.visible_text}
                </p>
              </Info>
            )}
          </div>
        </Section>
      )}
      <Section
        title="Extraction details"
        note="Evidence, candidates, stages, and service activity"
      >
        <ExtractionPipeline detail={detail} />
      </Section>
    </div>
  );
}

export default function PostDetailView({ detail }: { detail: PostDetail }) {
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>("social");
  const [extractionView, setExtractionView] =
    useState<ExtractionView>("readable");
  const extractionJson = {
    apify: detail.related.apify ?? null,
    trace: detail.related.trace ?? null,
    trace_json: detail.related.trace_json ?? null,
    extraction: detail.related.extraction ?? null,
    spoken_content:
      typeof detail.post.transcript === "string"
        ? detail.post.transcript
        : null,
    visible_content:
      typeof detail.post.visible_text === "string"
        ? detail.post.visible_text
        : null,
  };

  return (
    <div className="space-y-5">
      <PostPreview post={detail.post} />
      {detail.warnings?.length ? (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
          Some optional records could not be loaded for this post.
        </div>
      ) : null}

      <div className="space-y-5">
        <div
          className="flex flex-wrap items-center gap-2"
          role="tablist"
          aria-label="Post details"
        >
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "social"}
            onClick={() => setPrimaryTab("social")}
            className={tabClass(primaryTab === "social")}
          >
            Social Post Details
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "apify"}
            onClick={() => setPrimaryTab("apify")}
            className={tabClass(primaryTab === "apify")}
          >
            Extraction Details
          </button>
        </div>

        {primaryTab === "social" ? (
          <div role="tabpanel">
            <SocialPostContent detail={detail} />
          </div>
        ) : (
          <div role="tabpanel">
            <div
              className="mb-4 flex items-center gap-2"
              role="tablist"
              aria-label="Apify extraction view"
            >
              <button
                type="button"
                role="tab"
                aria-selected={extractionView === "readable"}
                onClick={() => setExtractionView("readable")}
                className={tabClass(extractionView === "readable")}
              >
                Readable View
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={extractionView === "json"}
                onClick={() => setExtractionView("json")}
                className={tabClass(extractionView === "json")}
              >
                JSON View
              </button>
            </div>
            {extractionView === "readable" ? (
              <ApifyExtractionContent detail={detail} />
            ) : (
              <pre className="max-h-[560px] overflow-auto rounded-xl border border-zinc-800 bg-[#09090b] p-4 font-mono text-xs leading-6 text-emerald-200">
                {JSON.stringify(extractionJson, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
