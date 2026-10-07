import { NextResponse } from "next/server";

import { resolvePlaceLocation } from "@/lib/google-maps";
import { normalizeAdminPost } from "@/lib/admin-posts";
import { getSocialPostTrace } from "@/lib/social-post-trace";
import { supabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

function isMissingTableOrColumn(
  error: { code?: string; message?: string } | null,
) {
  return (
    error?.code === "42P01" ||
    error?.code === "42703" ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205" ||
    /could not find (the table|a relationship)|does not exist|schema cache/i.test(
      error?.message || "",
    )
  );
}

type Data = Record<string, unknown>;
const data = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null =>
  Number.isFinite(Number(value)) ? Number(value) : null;
const words = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && Boolean(item.trim()),
        )
        .map((item) => item.trim())
    : [];
const firstText = (...values: unknown[]) =>
  values.map(text).find((value): value is string => Boolean(value)) || null;
const firstNumber = (...values: unknown[]) =>
  values.map(number).find((value): value is number => value !== null) ?? null;
const postUrlToken = (value: unknown) => {
  const url = text(value);
  if (!url) return null;
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) || null;
  } catch {
    return url.split("/").filter(Boolean).at(-1) || null;
  }
};

async function extractionRunsForPostUrl(postUrl: string | null) {
  const token = postUrlToken(postUrl);
  if (!token) return { data: [] as Data[], error: null };
  let emptyResult: { data: Data[]; error: null } = { data: [], error: null };
  let lastError: { code?: string; message?: string } | null = null;
  for (const column of ["input_url", "post_url", "url", "source_url"]) {
    const result = await supabaseAdmin
      .from("extraction_runs")
      .select("*")
      .ilike(column, `%${token}%`);
    if (!result.error) {
      if ((result.data ?? []).length)
        return result as { data: Data[]; error: null };
      emptyResult = result as { data: Data[]; error: null };
      continue;
    }
    lastError = result.error;
    if (!isMissingTableOrColumn(result.error))
      return { data: [], error: result.error };
  }
  return lastError && !emptyResult.data.length
    ? { data: [], error: lastError }
    : emptyResult;
}

async function extractionRunsForPost(
  socialPostId: string,
  postUrl: string | null,
) {
  const directResult = await supabaseAdmin
    .from("extraction_runs")
    .select("*")
    .eq("social_post_id", socialPostId);

  if (!directResult.error && (directResult.data ?? []).length) {
    return directResult as { data: Data[]; error: null };
  }

  if (directResult.error && !isMissingTableOrColumn(directResult.error)) {
    return { data: [] as Data[], error: directResult.error };
  }

  return extractionRunsForPostUrl(postUrl);
}

function extractedItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = data(value);
  for (const candidate of [
    source.items,
    source.data,
    source.comments,
    source.edges,
    source.nodes,
  ]) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map((item) => data(item).node || item);
  }
  return [];
}

function extractedNames(value: unknown): string[] {
  return [
    ...new Set(
      extractedItems(value)
        .map((item) => {
          if (typeof item === "string") return item.trim();
          const entry = data(item);
          return (
            firstText(
              entry.username,
              entry.name,
              entry.title,
              entry.uniqueId,
            ) || ""
          );
        })
        .filter(Boolean),
    ),
  ];
}

function extractedDate(value: unknown): string | null {
  const numeric = number(value);
  const parsed =
    numeric !== null
      ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
      : typeof value === "string"
        ? new Date(value)
        : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : null;
}

function apifyView(value: unknown, extractionStartedAt?: unknown) {
  const raw = data(value);
  if (!Object.keys(raw).length) return { available: false };

  const author = data(raw.authorMeta);
  const user = data(raw.user);
  const video = data(raw.videoMeta);
  const music = data(raw.musicMeta);
  const location = data(raw.location);
  const carousel =
    extractedItems(raw.childPosts).length ||
    extractedItems(raw.child_posts).length ||
    extractedItems(raw.carousel_media).length ||
    extractedItems(raw.carouselMedia).length;
  const commentSources = [
    raw.latestComments,
    raw.comments,
    raw.commentList,
    raw.commentsList,
    raw.topComments,
    data(raw.commentData).comments,
  ];
  const comments = commentSources
    .flatMap(extractedItems)
    .map((item) => {
      const comment = data(item);
      const commentAuthor = data(comment.user);
      const owner = data(comment.owner);
      return {
        author: firstText(
          comment.ownerUsername,
          comment.username,
          commentAuthor.username,
          commentAuthor.uniqueId,
          owner.username,
          owner.uniqueId,
        ),
        name: firstText(
          comment.ownerFullName,
          commentAuthor.full_name,
          commentAuthor.nickname,
          owner.full_name,
          owner.nickname,
        ),
        message: firstText(
          comment.text,
          comment.comment,
          comment.content,
          comment.commentText,
        ),
        created_at: extractedDate(
          comment.createdAt ||
            comment.created_at ||
            comment.timestamp ||
            comment.createTime,
        ),
        likes: firstNumber(
          comment.likesCount,
          comment.like_count,
          comment.diggCount,
          comment.likes,
        ),
        replies: firstNumber(
          comment.repliesCount,
          comment.reply_count,
          comment.replyCommentTotal,
          comment.reply_comment_total,
        ),
      };
    })
    .filter((comment) => comment.author || comment.name || comment.message);
  const extractedAt =
    [
      raw.scrapedAt,
      raw.scraped_at,
      raw.fetchedAt,
      raw.fetched_at,
      raw.crawledAt,
      raw.crawled_at,
      extractionStartedAt,
    ]
      .map(extractedDate)
      .find((value): value is string => Boolean(value)) || null;

  return {
    available: true,
    source: firstText(raw.source, raw.platform, raw.sourcePlatform) || "Apify",
    extracted_at: extractedAt,
    author: {
      username: firstText(
        raw.ownerUsername,
        author.name,
        user.username,
        user.unique_id,
      ),
      name: firstText(
        raw.ownerFullName,
        author.nickName,
        user.full_name,
        user.nickname,
      ),
    },
    post: {
      type: firstText(raw.type, raw.productType, raw.postType),
      published_at: extractedDate(
        raw.timestamp || raw.taken_at || raw.createTime || raw.create_time,
      ),
      location: firstText(raw.locationName, location.name, raw.address),
      duration: firstNumber(raw.videoDuration, video.duration),
      width: firstNumber(
        raw.dimensionsWidth,
        video.width,
        data(raw.dimensions).width,
      ),
      height: firstNumber(
        raw.dimensionsHeight,
        video.height,
        data(raw.dimensions).height,
      ),
      carousel_items: carousel || null,
    },
    engagement: {
      views: firstNumber(raw.videoViewCount, raw.playCount, raw.viewCount),
      likes: firstNumber(raw.likesCount, raw.diggCount),
      comments: firstNumber(raw.commentsCount, raw.commentCount),
      shares: firstNumber(raw.shareCount),
      saves: firstNumber(raw.collectCount, raw.saveCount),
    },
    hashtags: words(raw.hashtags),
    mentions: words(raw.mentions),
    tagged_accounts: [
      ...new Set(
        extractedNames(raw.taggedUsers).concat(
          extractedNames(raw.coauthorProducers),
        ),
      ),
    ],
    music: {
      title: firstText(music.musicName, raw.musicName, raw.music_title),
      artist: firstText(music.musicAuthor, raw.musicAuthor, raw.music_artist),
    },
    comments,
  };
}

function tokenUsageView(summaryValue: unknown, stageValues: unknown[]) {
  const summary = data(summaryValue);
  const stageRuns = stageValues.map(data).map((stage, index) => {
    const usage = data(stage.token_usage);
    const details = data(stage.usage);
    return {
      label:
        firstText(
          stage.stage_name,
          stage.stage,
          stage.name,
          stage.stage_type,
          stage.phase,
        ) || `Stage ${index + 1}`,
      status: firstText(stage.status, stage.run_status),
      provider: firstText(stage.provider, stage.service, stage.vendor),
      model: firstText(stage.model, stage.model_name),
      started_at: extractedDate(
        stage.started_at || stage.startedAt || stage.created_at,
      ),
      completed_at: extractedDate(
        stage.completed_at ||
          stage.completedAt ||
          stage.finished_at ||
          stage.updated_at,
      ),
      duration_ms: firstNumber(
        stage.duration_ms,
        stage.durationMs,
        stage.elapsed_ms,
      ),
      input_tokens: firstNumber(
        stage.input_tokens,
        stage.prompt_tokens,
        usage.input_tokens,
        usage.prompt_tokens,
        details.input_tokens,
      ),
      output_tokens: firstNumber(
        stage.output_tokens,
        stage.completion_tokens,
        usage.output_tokens,
        usage.completion_tokens,
        details.output_tokens,
      ),
      total_tokens: firstNumber(
        stage.total_tokens,
        usage.total_tokens,
        details.total_tokens,
      ),
      items_in: firstNumber(
        stage.items_in,
        stage.input_count,
        stage.records_in,
      ),
      items_out: firstNumber(
        stage.items_out,
        stage.output_count,
        stage.records_out,
      ),
      estimated_cost_usd: firstNumber(
        stage.estimated_cost_usd,
        stage.est_cost_usd,
        stage.cost_usd,
      ),
      error_message: firstText(stage.error_message, stage.error),
    };
  });

  return {
    total_tokens: firstNumber(summary.total_tokens),
    total_input_tokens: firstNumber(summary.total_input_tokens),
    total_output_tokens: firstNumber(summary.total_output_tokens),
    stages: stageRuns,
    raw: { summary, stages: stageValues },
  };
}

function cleanEvidence(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => data(item))
    .map((item) => ({
      source: text(item.source) || "evidence",
      text: text(item.text) || "",
      timestamps: Array.isArray(item.timestamps)
        ? item.timestamps.filter(
            (time): time is number => typeof time === "number",
          )
        : [],
    }))
    .filter((item) => item.text);
}

function extractionView(
  runs: Data[],
  stages: Data[],
  calls: Data[],
  candidates: Data[],
  logs: Data[],
) {
  return runs.map((run, index) => {
    const runId = run.id;
    const inputSnapshot = data(run.input_snapshot);
    const resultSummary = data(run.result_summary);
    const inputMeta = data(inputSnapshot.metadata);

    const captionChars =
      typeof inputSnapshot.caption === "string"
        ? inputSnapshot.caption.length
        : null;
    const hashtagCount = Array.isArray(inputSnapshot.hashtags)
      ? inputSnapshot.hashtags.length
      : null;
    const mentionCount = Array.isArray(inputSnapshot.mentions)
      ? inputSnapshot.mentions.length
      : null;
    const taggedAccountCount = Array.isArray(inputSnapshot.taggedAccounts)
      ? inputSnapshot.taggedAccounts.length
      : null;
    const subtitleTracks = Array.isArray(inputMeta.subtitleTracks)
      ? inputMeta.subtitleTracks.length
      : null;

    const logItems = logs
      .filter((log) => log.run_id === runId)
      .map((log) => ({
        part: text(log.part) || "pipeline",
        events: number(log.event_count) || 0,
        warnings: number(log.warn_count) || 0,
        errors: number(log.error_count) || 0,
      }));
    return {
      label: `Run ${index + 1}`,
      trigger: text(run.entrypoint) || text(run.trigger) || "processing",
      status: text(run.status) || "pending",
      started_at: text(run.started_at) || text(run.created_at),
      duration_ms: number(run.duration_ms),
      error_message: text(run.error_message),
      input: {
        caption_characters:
          captionChars !== null ? captionChars : number(run.caption_chars),
        hashtags:
          hashtagCount !== null ? hashtagCount : number(run.hashtag_count),
        mentions:
          mentionCount !== null ? mentionCount : number(run.mention_count),
        tagged_accounts:
          taggedAccountCount !== null
            ? taggedAccountCount
            : number(run.tagged_account_count),
        comments: number(run.comment_count),
        media_items: number(run.media_items),
        subtitle_tracks:
          subtitleTracks !== null
            ? subtitleTracks
            : number(run.subtitle_tracks),
      },
      evidence: {
        items: number(run.evidence_items),
        sources: [], // evidence_by_source was removed from the schema
        transcript_source: text(run.transcript_source),
        transcript_language: text(run.transcript_language),
        ocr_frames: number(inputMeta.ocrFrameCount) ?? number(run.ocr_frames),
        vision_frames:
          number(inputMeta.visionFrameCount) ?? number(run.vision_frames),
      },
      outcome: {
        candidates:
          number(resultSummary.returnedPlaceCount) ??
          number(run.candidates_count),
        accepted:
          number(resultSummary.persistedPlaceCount) ??
          number(run.accepted_count),
        rejected:
          number(resultSummary.rejectedCandidateCount) ??
          number(run.rejected_count),
        saved:
          number(resultSummary.persistedPlaceCount) ?? number(run.saved_count),
        unsaved:
          number(resultSummary.unresolvedPlaceCount) ??
          number(run.unsaved_count),
        recovery_places_added: number(run.recovery_places_added),
      },
      stages: stages
        .filter((stage) => stage.run_id === runId)
        .map((stage) => ({
          stage: text(stage.stage) || "stage",
          provider: text(stage.provider),
          status: text(stage.status) || "pending",
          duration_ms: number(stage.duration_ms),
          items_in: number(stage.items_in),
          items_out: number(stage.items_out),
          error_message: text(stage.error_message),
        })),
      calls: calls
        .filter((call) => call.run_id === runId)
        .map((call) => ({
          operation: text(call.operation) || "operation",
          stage: text(call.stage),
          provider: text(call.provider),
          model: text(call.model),
          status: text(call.status) || "pending",
          latency_ms: number(call.latency_ms),
          input_tokens: number(call.input_tokens),
          output_tokens: number(call.output_tokens),
          total_tokens: number(call.total_tokens),
          audio_seconds: number(call.audio_seconds),
          images: number(call.images),
          estimated_cost_usd: number(call.est_cost_usd),
          error_message: text(call.error_message),
        })),
      candidates: candidates
        .filter((candidate) => candidate.run_id === runId)
        .map((candidate) => ({
          name: text(candidate.name),
          decision: text(candidate.decision) || "pending",
          pass: text(candidate.pass),
          reason: text(candidate.reason),
          search_query: text(candidate.search_query),
          mention_type: text(candidate.mention_type),
          model_role: text(candidate.model_role),
          category:
            text(candidate.saved_category) ||
            text(candidate.category) ||
            text(candidate.base_category),
          city: text(candidate.city),
          neighborhood: text(candidate.neighborhood),
          address: text(candidate.address),
          confidence: number(candidate.confidence),
          evidence_sources: words(candidate.evidence_sources),
          evidence: cleanEvidence(candidate.evidence_snippets),
          geocode_provider: text(candidate.geocode_provider),
        })),
      logs: logItems,
    };
  });
}

/**
 * GET /api/admin/posts/:id
 *
 * Keeps the list query small and returns the full post record only once an
 * administrator selects a post. It also follows every current relationship
 * that is keyed by social_post_id.
 */
export async function GET(_: Request, { params }: Params) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "Missing post ID" }, { status: 400 });
  }

  const { data: post, error: postError } = await supabaseAdmin
    .from("social_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (postError) {
    return NextResponse.json({ error: postError.message }, { status: 500 });
  }

  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  const normalizedPost = normalizeAdminPost(post);
  const runUrlToken = postUrlToken(normalizedPost.post_url);

  // Newer extraction rows have an indexed direct post relation. The legacy
  // URL lookup remains as a fallback for older, unlinked rows.
  const extractionRunsPromise = extractionRunsForPost(
    id,
    normalizedPost.post_url,
  );
  const [
    profileResult,
    primaryPlaceResult,
    directPlacesResult,
    linkedPlacesResult,
    savedPlacesResult,
    runsResult,
    tokenSummaryResult,
    stageRunsResult,
    accessesResult,
  ] = await Promise.all([
    post.user_id
      ? supabaseAdmin
          .from("profiles")
          .select("*")
          .eq("id", post.user_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    post.place_id
      ? supabaseAdmin
          .from("places")
          .select("*")
          .eq("id", post.place_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseAdmin
      .from("places")
      .select("*")
      .eq("social_post_id", id)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("social_post_places")
      .select(
        "id, social_post_id, place_id, confidence, explanation, evidence, created_at, places(*)",
      )
      .eq("social_post_id", id)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("saved_places")
      .select("*")
      .eq("social_post_id", id)
      .order("created_at", { ascending: false }),
    extractionRunsPromise,
    supabaseAdmin
      .from("extraction_run_summary")
      .select("*")
      .eq("social_post_id", id)
      // A re-processed post has several runs; summarise the latest one.
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("extraction_stage_runs")
      .select("*")
      .eq("social_post_id", id),
    supabaseAdmin
      .from("social_post_accesses")
      .select("user_id, event, created_at")
      .eq("social_post_id", id)
      .not("user_id", "is", null)
      .order("created_at", { ascending: true }),
  ]);

  const relationErrors = [
    profileResult.error,
    primaryPlaceResult.error,
    directPlacesResult.error,
    linkedPlacesResult.error,
    savedPlacesResult.error,
    runsResult.error,
    tokenSummaryResult.error,
    stageRunsResult.error,
    accessesResult.error,
  ].filter(
    (error) =>
      error &&
      !isMissingTableOrColumn(error as { code?: string; message?: string }),
  );

  // Everyone who submitted this URL: the creator of the row plus later
  // submissions recorded in social_post_accesses.
  const requesterIds = [
    ...new Set(
      [
        typeof post.user_id === "string" ? post.user_id : null,
        ...(accessesResult.data ?? []).map((access) => access.user_id),
      ].filter((value): value is string => typeof value === "string"),
    ),
  ];
  const requesterProfiles = requesterIds.length
    ? await supabaseAdmin
        .from("profiles")
        .select("id, display_name, email, avatar_url, created_at")
        .in("id", requesterIds)
    : { data: [] as Data[] };
  const requesterById = new Map(
    ((requesterProfiles.data ?? []) as Data[]).map((profile) => [
      String(profile.id),
      profile,
    ]),
  );
  const requesters = requesterIds.map((userId) => {
    const firstAccess = (accessesResult.data ?? []).find(
      (access) => access.user_id === userId,
    );
    const profile = requesterById.get(userId) ?? {};
    return {
      user_id: userId,
      display_name: text(profile.display_name),
      email: text(profile.email),
      avatar_url: text(profile.avatar_url),
      is_creator: userId === post.user_id,
      first_requested_at:
        userId === post.user_id
          ? text(post.created_at)
          : text(firstAccess?.created_at),
    };
  });
  const savedPlaces = savedPlacesResult.data ?? [];

  const runs = runsResult.data ?? [];
  const runIds = runs.map((run) => run.id).filter(Boolean);
  // Audit tables written by the pipeline logger (migration v26).
  const telemetryPromise = runIds.length
    ? Promise.all([
        supabaseAdmin
          .from("extraction_stage_runs")
          .select("*")
          .in("run_id", runIds)
          .order("started_at", { ascending: true }),
        supabaseAdmin
          .from("extraction_run_events")
          .select("id, run_id, occurred_at, elapsed_ms, stage, level, message, data")
          .in("run_id", runIds)
          .order("occurred_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(5000),
        supabaseAdmin
          .from("extraction_place_candidates")
          .select("*")
          .in("run_id", runIds)
          .order("created_at", { ascending: true }),
        supabaseAdmin
          .from("extraction_evidence")
          .select(
            "id, run_id, evidence_id, source_type, text_value, confidence, timestamps_sec, frame_indexes, provider, model, attributes",
          )
          .in("run_id", runIds)
          .order("id", { ascending: true })
          .limit(5000),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];

  const placesById = new Map<string, Record<string, unknown>>();
  if (primaryPlaceResult.data?.id)
    placesById.set(primaryPlaceResult.data.id, primaryPlaceResult.data);
  for (const place of directPlacesResult.data ?? []) {
    if (place.id) placesById.set(place.id, place);
  }
  for (const link of linkedPlacesResult.data ?? []) {
    const place = link.places;
    if (place && !Array.isArray(place) && typeof place === "object") {
      const record = place as unknown as Record<string, unknown>;
      if (typeof record.id === "string") placesById.set(record.id, record);
    }
  }
  const locationsPromise = Promise.all(
    [...placesById.values()].slice(0, 12).map((place) =>
      resolvePlaceLocation({
        id: String(place.id),
        name: typeof place.name === "string" ? place.name : null,
        address: typeof place.address === "string" ? place.address : null,
        neighborhood:
          typeof place.neighborhood === "string" ? place.neighborhood : null,
        city: typeof place.city === "string" ? place.city : null,
        latitude: typeof place.latitude === "number" ? place.latitude : null,
        longitude: typeof place.longitude === "number" ? place.longitude : null,
      }),
    ),
  );

  const extractionShortCode =
    runs
      .map((run) =>
        firstText(
          run.short_code,
          run.shortCode,
          run.shortcode,
          run.content_short_code,
          run.post_short_code,
        ),
      )
      .find((value): value is string => Boolean(value)) || runUrlToken;
  const tracePromise = extractionShortCode
    ? getSocialPostTrace(extractionShortCode)
    : Promise.resolve({ trace: { available: false }, raw: {}, error: null });
  const [
    [operationsResult, eventsResult, candidatesResult, evidenceResult],
    locations,
    traceResult,
  ] = await Promise.all([telemetryPromise, locationsPromise, tracePromise]);

  const operations = (operationsResult.data ?? []) as Data[];
  const candidates = (candidatesResult.data ?? []) as Data[];
  const events = (eventsResult.data ?? []) as Data[];
  const evidenceById = new Map(
    ((evidenceResult.data ?? []) as Data[]).map((item) => [
      `${item.run_id}:${item.evidence_id}`,
      item,
    ]),
  );
  // Per-run, per-stage event totals for the legacy extraction summary.
  const eventGroups = new Map<string, Data>();
  for (const event of events) {
    const key = `${event.run_id}:${event.stage}`;
    const group = eventGroups.get(key) ?? {
      run_id: event.run_id,
      part: event.stage,
      event_count: 0,
      warn_count: 0,
      error_count: 0,
    };
    group.event_count = Number(group.event_count) + 1;
    if (event.level === "warn") group.warn_count = Number(group.warn_count) + 1;
    if (event.level === "error")
      group.error_count = Number(group.error_count) + 1;
    eventGroups.set(key, group);
  }
  const eventCounts = [...eventGroups.values()];
  // The legacy summary reads reason/evidence_snippets and latency/cost aliases.
  for (const candidate of candidates) {
    candidate.reason = candidate.decision_reason;
    candidate.evidence_snippets = words(candidate.evidence_ids).flatMap(
      (evidenceId) => {
        const item = evidenceById.get(`${candidate.run_id}:${evidenceId}`);
        return item
          ? [
              {
                source: item.source_type,
                text: item.text_value,
                timestamps: item.timestamps_sec,
              },
            ]
          : [];
      },
    );
  }
  for (const operation of operations) {
    operation.latency_ms = operation.duration_ms;
    operation.est_cost_usd = operation.estimated_cost_usd;
  }

  const telemetryErrors = [
    operationsResult.error,
    eventsResult.error,
    candidatesResult.error,
    evidenceResult.error,
  ].filter(
    (error) =>
      error &&
      !isMissingTableOrColumn(error as { code?: string; message?: string }),
  );

  return NextResponse.json({
    success: true,
    post: normalizedPost,
    related: {
      primary_place: primaryPlaceResult.data,
      direct_places: directPlacesResult.data ?? [],
      place_links: linkedPlacesResult.data ?? [],
      apify: apifyView(
        post.raw_apify_data,
        runs[0]?.started_at || runs[0]?.created_at || post.created_at,
      ),
      post_reference: {
        url: normalizedPost.post_url,
        short_code: extractionShortCode,
      },
      trace: traceResult.trace,
      trace_json: traceResult.raw,
      token_usage: tokenUsageView(
        tokenSummaryResult.data,
        stageRunsResult.data ?? [],
      ),
      extraction: extractionView(
        runs,
        operations,
        operations,
        candidates,
        eventCounts,
      ),
      // Full audit trail per run, for the Extraction tab.
      runs: runs.map((run) => ({
        id: run.id,
        external_run_id: text(run.external_run_id),
        entrypoint: text(run.entrypoint),
        platform: text(run.platform),
        input_url: text(run.input_url),
        status: text(run.status),
        error_code: text(run.error_code),
        error_message: text(run.error_message),
        started_at: text(run.started_at),
        finished_at: text(run.finished_at),
        duration_ms: number(run.duration_ms),
        result_summary: data(run.result_summary),
      })),
      operations: operations.map((operation) => ({
        id: operation.id,
        run_id: operation.run_id,
        stage: text(operation.stage),
        operation: text(operation.operation),
        status: text(operation.status),
        provider: text(operation.provider),
        model: text(operation.model),
        attempt: number(operation.attempt),
        is_fallback: operation.is_fallback === true,
        retryable:
          typeof operation.retryable === "boolean" ? operation.retryable : null,
        started_at: text(operation.started_at),
        finished_at: text(operation.finished_at),
        duration_ms: number(operation.duration_ms),
        input_tokens: number(operation.input_tokens),
        output_tokens: number(operation.output_tokens),
        total_tokens: number(operation.total_tokens),
        input_units: number(operation.input_units),
        output_units: number(operation.output_units),
        estimated_cost_usd: number(operation.estimated_cost_usd),
        request_summary: data(operation.request_summary),
        result_summary: data(operation.result_summary),
        error_code: text(operation.error_code),
        error_message: text(operation.error_message),
      })),
      events,
      events_truncated: events.length >= 5000,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        run_id: candidate.run_id,
        candidate_key: text(candidate.candidate_key),
        place_id: text(candidate.place_id),
        name: text(candidate.name),
        category: text(candidate.category),
        base_category: text(candidate.base_category),
        city: text(candidate.city),
        neighborhood: text(candidate.neighborhood),
        address: text(candidate.address),
        confidence: number(candidate.confidence),
        mention_type: text(candidate.mention_type),
        role: text(candidate.role),
        decision: text(candidate.decision),
        decision_reason: text(candidate.decision_reason),
        evidence_ids: words(candidate.evidence_ids),
        location_evidence_ids: words(candidate.location_evidence_ids),
        evidence_sources: words(candidate.evidence_sources),
        model_provider: text(candidate.model_provider),
        model: text(candidate.model),
        details: data(candidate.details),
      })),
      evidence: (evidenceResult.data ?? []) as Data[],
      locations,
      requesters,
      saves: {
        total: savedPlaces.length,
        users: new Set(savedPlaces.map((save) => save.user_id)).size,
        been_here: savedPlaces.filter((save) => save.status === "BEEN_HERE")
          .length,
        want_to_go: savedPlaces.filter((save) => save.status === "WANT_TO_GO")
          .length,
      },
    },
    warnings: [...relationErrors, ...telemetryErrors].map(
      (error) =>
        (error as { message?: string }).message ||
        "Related data could not be loaded",
    ),
  });
}
