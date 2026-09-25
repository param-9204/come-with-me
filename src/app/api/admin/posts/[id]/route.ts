import { NextResponse } from 'next/server';

import { resolvePlaceLocation } from '@/lib/google-maps';
import { normalizeAdminPost } from '@/lib/admin-posts';
import { getSocialPostTrace } from '@/lib/social-post-trace';
import { supabaseAdmin } from '@/lib/supabase';

type Params = { params: Promise<{ id: string }> };

function isMissingTableOrColumn(error: { code?: string; message?: string } | null) {
  return error?.code === '42P01' || error?.code === '42703' || error?.code === 'PGRST204' || error?.code === 'PGRST205'
    || /could not find (the table|a relationship)|does not exist|schema cache/i.test(error?.message || '');
}

type Data = Record<string, unknown>;
const data = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const words = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
const firstText = (...values: unknown[]) => values.map(text).find((value): value is string => Boolean(value)) || null;
const firstNumber = (...values: unknown[]) => values.map(number).find((value): value is number => value !== null) ?? null;
const postUrlToken = (value: unknown) => {
  const url = text(value);
  if (!url) return null;
  try { return new URL(url).pathname.split('/').filter(Boolean).at(-1) || null; } catch { return url.split('/').filter(Boolean).at(-1) || null; }
};

async function extractionRunsForPostUrl(postUrl: string | null) {
  const token = postUrlToken(postUrl);
  if (!token) return { data: [] as Data[], error: null };
  let emptyResult: { data: Data[]; error: null } = { data: [], error: null };
  let lastError: { code?: string; message?: string } | null = null;
  for (const column of ['post_url', 'url', 'source_url']) {
    const result = await supabaseAdmin.from('extraction_runs').select('*').ilike(column, `%${token}%`);
    if (!result.error) {
      if ((result.data ?? []).length) return result as { data: Data[]; error: null };
      emptyResult = result as { data: Data[]; error: null };
      continue;
    }
    lastError = result.error;
    if (!isMissingTableOrColumn(result.error)) return { data: [], error: result.error };
  }
  return lastError && !emptyResult.data.length ? { data: [], error: lastError } : emptyResult;
}

function extractedItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = data(value);
  for (const candidate of [source.items, source.data, source.comments, source.edges, source.nodes]) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map((item) => data(item).node || item);
  }
  return [];
}

function extractedNames(value: unknown): string[] {
  return [...new Set(extractedItems(value).map((item) => {
    if (typeof item === 'string') return item.trim();
    const entry = data(item);
    return firstText(entry.username, entry.name, entry.title, entry.uniqueId) || '';
  }).filter(Boolean))];
}

function extractedDate(value: unknown): string | null {
  const numeric = number(value);
  const parsed = numeric !== null
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function apifyView(value: unknown, extractionStartedAt?: unknown) {
  const raw = data(value);
  if (!Object.keys(raw).length) return { available: false };

  const author = data(raw.authorMeta);
  const user = data(raw.user);
  const video = data(raw.videoMeta);
  const music = data(raw.musicMeta);
  const location = data(raw.location);
  const carousel = extractedItems(raw.childPosts).length || extractedItems(raw.child_posts).length || extractedItems(raw.carousel_media).length || extractedItems(raw.carouselMedia).length;
  const commentSources = [raw.latestComments, raw.comments, raw.commentList, raw.commentsList, raw.topComments, data(raw.commentData).comments];
  const comments = commentSources.flatMap(extractedItems).map((item) => {
    const comment = data(item);
    const commentAuthor = data(comment.user);
    const owner = data(comment.owner);
    return {
      author: firstText(comment.ownerUsername, comment.username, commentAuthor.username, commentAuthor.uniqueId, owner.username, owner.uniqueId),
      name: firstText(comment.ownerFullName, commentAuthor.full_name, commentAuthor.nickname, owner.full_name, owner.nickname),
      message: firstText(comment.text, comment.comment, comment.content, comment.commentText),
      created_at: extractedDate(comment.createdAt || comment.created_at || comment.timestamp || comment.createTime),
      likes: firstNumber(comment.likesCount, comment.like_count, comment.diggCount, comment.likes),
      replies: firstNumber(comment.repliesCount, comment.reply_count, comment.replyCommentTotal, comment.reply_comment_total),
    };
  }).filter((comment) => comment.author || comment.name || comment.message);
  const extractedAt = [raw.scrapedAt, raw.scraped_at, raw.fetchedAt, raw.fetched_at, raw.crawledAt, raw.crawled_at, extractionStartedAt]
    .map(extractedDate)
    .find((value): value is string => Boolean(value)) || null;

  return {
    available: true,
    source: firstText(raw.source, raw.platform, raw.sourcePlatform) || 'Apify',
    extracted_at: extractedAt,
    author: {
      username: firstText(raw.ownerUsername, author.name, user.username, user.unique_id),
      name: firstText(raw.ownerFullName, author.nickName, user.full_name, user.nickname),
    },
    post: {
      type: firstText(raw.type, raw.productType, raw.postType),
      published_at: extractedDate(raw.timestamp || raw.taken_at || raw.createTime || raw.create_time),
      location: firstText(raw.locationName, location.name, raw.address),
      duration: firstNumber(raw.videoDuration, video.duration),
      width: firstNumber(raw.dimensionsWidth, video.width, data(raw.dimensions).width),
      height: firstNumber(raw.dimensionsHeight, video.height, data(raw.dimensions).height),
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
    tagged_accounts: [...new Set(extractedNames(raw.taggedUsers).concat(extractedNames(raw.coauthorProducers)))],
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
      label: firstText(stage.stage_name, stage.stage, stage.name, stage.stage_type, stage.phase) || `Stage ${index + 1}`,
      status: firstText(stage.status, stage.run_status),
      provider: firstText(stage.provider, stage.service, stage.vendor),
      model: firstText(stage.model, stage.model_name),
      started_at: extractedDate(stage.started_at || stage.startedAt || stage.created_at),
      completed_at: extractedDate(stage.completed_at || stage.completedAt || stage.finished_at || stage.updated_at),
      duration_ms: firstNumber(stage.duration_ms, stage.durationMs, stage.elapsed_ms),
      input_tokens: firstNumber(stage.input_tokens, stage.prompt_tokens, usage.input_tokens, usage.prompt_tokens, details.input_tokens),
      output_tokens: firstNumber(stage.output_tokens, stage.completion_tokens, usage.output_tokens, usage.completion_tokens, details.output_tokens),
      total_tokens: firstNumber(stage.total_tokens, usage.total_tokens, details.total_tokens),
      items_in: firstNumber(stage.items_in, stage.input_count, stage.records_in),
      items_out: firstNumber(stage.items_out, stage.output_count, stage.records_out),
      estimated_cost_usd: firstNumber(stage.estimated_cost_usd, stage.est_cost_usd, stage.cost_usd),
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
  return value.map((item) => data(item)).map((item) => ({
    source: text(item.source) || 'evidence',
    text: text(item.text) || '',
    timestamps: Array.isArray(item.timestamps) ? item.timestamps.filter((time): time is number => typeof time === 'number') : [],
  })).filter((item) => item.text);
}

function extractionView(runs: Data[], stages: Data[], calls: Data[], candidates: Data[], logs: Data[]) {
  return runs.map((run, index) => {
    const runId = run.id;
    const evidenceBySource = data(run.evidence_by_source);
    const logItems = logs.filter((log) => log.run_id === runId).map((log) => ({
      part: text(log.part) || 'pipeline',
      events: number(log.event_count) || 0,
      warnings: number(log.warn_count) || 0,
      errors: number(log.error_count) || 0,
    }));
    return {
      label: `Run ${index + 1}`,
      trigger: text(run.trigger) || 'processing',
      status: text(run.status) || 'pending',
      started_at: text(run.started_at) || text(run.created_at),
      duration_ms: number(run.duration_ms),
      failed_stage: text(run.failed_stage),
      error_message: text(run.error_message),
      input: {
        caption_characters: number(run.caption_chars),
        hashtags: number(run.hashtag_count),
        mentions: number(run.mention_count),
        tagged_accounts: number(run.tagged_account_count),
        comments: number(run.comment_count),
        media_items: number(run.media_items),
        subtitle_tracks: number(run.subtitle_tracks),
      },
      evidence: {
        items: number(run.evidence_items),
        sources: Object.entries(evidenceBySource).map(([source, count]) => ({ source, count: number(count) || 0 })),
        transcript_source: text(run.transcript_source),
        transcript_language: text(run.transcript_language),
        ocr_frames: number(run.ocr_frames),
        vision_frames: number(run.vision_frames),
      },
      outcome: {
        candidates: number(run.candidates_count),
        accepted: number(run.accepted_count),
        rejected: number(run.rejected_count),
        saved: number(run.saved_count),
        unsaved: number(run.unsaved_count),
        recovery_places_added: number(run.recovery_places_added),
      },
      stages: stages.filter((stage) => stage.run_id === runId).map((stage) => ({
        stage: text(stage.stage) || 'stage', provider: text(stage.provider), status: text(stage.status) || 'pending',
        duration_ms: number(stage.duration_ms), items_in: number(stage.items_in), items_out: number(stage.items_out), error_message: text(stage.error_message),
      })),
      calls: calls.filter((call) => call.run_id === runId).map((call) => ({
        operation: text(call.operation) || 'operation', stage: text(call.stage), provider: text(call.provider), model: text(call.model), status: text(call.status) || 'pending',
        latency_ms: number(call.latency_ms), input_tokens: number(call.input_tokens), output_tokens: number(call.output_tokens), total_tokens: number(call.total_tokens), audio_seconds: number(call.audio_seconds), images: number(call.images), estimated_cost_usd: number(call.est_cost_usd), error_message: text(call.error_message),
      })),
      candidates: candidates.filter((candidate) => candidate.run_id === runId).map((candidate) => ({
        name: text(candidate.name), decision: text(candidate.decision) || 'pending', pass: text(candidate.pass), reason: text(candidate.reason),
        search_query: text(candidate.search_query), mention_type: text(candidate.mention_type), model_role: text(candidate.model_role),
        category: text(candidate.saved_category) || text(candidate.category) || text(candidate.base_category), city: text(candidate.city), neighborhood: text(candidate.neighborhood), address: text(candidate.address),
        confidence: number(candidate.confidence), evidence_sources: words(candidate.evidence_sources), evidence: cleanEvidence(candidate.evidence_snippets), geocode_provider: text(candidate.geocode_provider),
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
    return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
  }

  const { data: post, error: postError } = await supabaseAdmin
    .from('social_posts')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (postError) {
    return NextResponse.json({ error: postError.message }, { status: 500 });
  }

  if (!post) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  }
  const normalizedPost = normalizeAdminPost(post);
  const runUrlToken = postUrlToken(normalizedPost.post_url);

  const extractionRunsPromise = extractionRunsForPostUrl(normalizedPost.post_url);
  const [profileResult, primaryPlaceResult, directPlacesResult, linkedPlacesResult, savedPlacesResult, runsResult, tokenSummaryResult, stageRunsResult] = await Promise.all([
    post.user_id
      ? supabaseAdmin.from('profiles').select('*').eq('id', post.user_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    post.place_id
      ? supabaseAdmin.from('places').select('*').eq('id', post.place_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseAdmin.from('places').select('*').eq('social_post_id', id).order('created_at', { ascending: false }),
    supabaseAdmin
      .from('social_post_places')
      .select('id, social_post_id, place_id, confidence, explanation, evidence, created_at, places(*)')
      .eq('social_post_id', id)
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('saved_places').select('*').eq('social_post_id', id).order('created_at', { ascending: false }),
    extractionRunsPromise,
    supabaseAdmin.from('extraction_run_summary').select('*').eq('social_post_id', id).maybeSingle(),
    supabaseAdmin.from('extraction_stage_runs').select('*').eq('social_post_id', id),
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
  ].filter((error) => error && !isMissingTableOrColumn(error as { code?: string; message?: string }));

  const runs = runsResult.data ?? [];
  const runIds = runs.map((run) => run.id).filter(Boolean);
  const [stagesResult, callsResult, candidatesResult, logsResult] = runIds.length
    ? await Promise.all([
        supabaseAdmin.from('extraction_run_stages').select('*').in('run_id', runIds).order('started_at', { ascending: true }),
        supabaseAdmin.from('extraction_run_calls').select('*').in('run_id', runIds).order('created_at', { ascending: true }),
        supabaseAdmin.from('extraction_candidates').select('*').in('run_id', runIds).order('created_at', { ascending: true }),
        supabaseAdmin.from('extraction_run_logs').select('*').in('run_id', runIds).order('created_at', { ascending: true }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];

  const telemetryErrors = [stagesResult.error, callsResult.error, candidatesResult.error, logsResult.error]
    .filter((error) => error && !isMissingTableOrColumn(error as { code?: string; message?: string }));

  const placesById = new Map<string, Record<string, unknown>>();
  if (primaryPlaceResult.data?.id) placesById.set(primaryPlaceResult.data.id, primaryPlaceResult.data);
  for (const place of directPlacesResult.data ?? []) {
    if (place.id) placesById.set(place.id, place);
  }
  for (const link of linkedPlacesResult.data ?? []) {
    const place = link.places;
    if (place && !Array.isArray(place) && typeof place === 'object') {
      const record = place as unknown as Record<string, unknown>;
      if (typeof record.id === 'string') placesById.set(record.id, record);
    }
  }
  const locations = await Promise.all(
    [...placesById.values()].slice(0, 12).map((place) => resolvePlaceLocation({
      id: String(place.id),
      name: typeof place.name === 'string' ? place.name : null,
      address: typeof place.address === 'string' ? place.address : null,
      neighborhood: typeof place.neighborhood === 'string' ? place.neighborhood : null,
      city: typeof place.city === 'string' ? place.city : null,
      latitude: typeof place.latitude === 'number' ? place.latitude : null,
      longitude: typeof place.longitude === 'number' ? place.longitude : null,
    }))
  );

  const extractionShortCode = runs.map((run) => firstText(
    run.short_code,
    run.shortCode,
    run.shortcode,
    run.content_short_code,
    run.post_short_code,
  )).find((value): value is string => Boolean(value)) || runUrlToken;
  const traceResult = extractionShortCode ? await getSocialPostTrace(extractionShortCode) : { trace: { available: false }, raw: {}, error: null };

  return NextResponse.json({
    success: true,
    post: normalizedPost,
    related: {
      primary_place: primaryPlaceResult.data,
      direct_places: directPlacesResult.data ?? [],
      place_links: linkedPlacesResult.data ?? [],
      apify: apifyView(post.raw_apify_data, runs[0]?.started_at || runs[0]?.created_at || post.created_at),
      post_reference: {
        url: normalizedPost.post_url,
        short_code: extractionShortCode,
      },
      trace: traceResult.trace,
      trace_json: traceResult.raw,
      token_usage: tokenUsageView(tokenSummaryResult.data, stageRunsResult.data ?? []),
      extraction: extractionView(runs, stagesResult.data ?? [], callsResult.data ?? [], candidatesResult.data ?? [], logsResult.data ?? []),
      locations,
    },
    warnings: [...relationErrors, ...telemetryErrors].map((error) => (error as { message?: string }).message || 'Related data could not be loaded'),
  });
}
