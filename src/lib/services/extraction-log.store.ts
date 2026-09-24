import { supabaseAdmin } from '../supabase';
import { errorMessage, truncate, type CallRecord, type PipelineLog, type StageRecord } from './pipeline-log';
import type { SocialContent } from '../types/social';

/**
 * Writes pipeline logs to the extraction_* tables (supabase/migration_v26_extraction_logs.sql).
 *
 * - Best effort: a logging failure never fails the pipeline.
 * - Until the migration is applied, the first write reports it once and DB
 *   logging stays off for the process (JSONL logs continue).
 * - PIPELINE_LOG_DB=off disables it explicitly.
 */

export type RunRoute = 'stream' | 'process-url' | 'analyze' | 'media';
export type RunTrigger = 'new' | 'retry' | 'legacy_recovery' | 'cached_restricted_recovery' | 'cache_hit';
export type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cache_hit';

export interface StartRunInput {
  socialPostId?: string | null;
  userId?: string | null;
  platform?: string | null;
  inputUrl: string;
  route: RunRoute;
  trigger?: RunTrigger;
}

const INSERT_CHUNK = 500;

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204' ||
    /does not exist|could not find the table|schema cache/i.test(error.message || '');
}

function int(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : Math.round(number);
}

function stageRow(runId: string, stage: StageRecord) {
  return {
    run_id: runId,
    stage: stage.stage,
    provider: stage.provider ?? null,
    status: stage.status,
    started_at: stage.startedAt,
    duration_ms: int(stage.durationMs),
    items_in: int(stage.itemsIn),
    items_out: int(stage.itemsOut),
    error_message: truncate(stage.error),
    details: stage.details ?? null,
  };
}

function callRow(runId: string, call: CallRecord) {
  return {
    run_id: runId,
    stage: call.stage,
    operation: call.operation,
    provider: call.provider,
    model: call.model ?? null,
    status: call.status,
    attempt: int(call.attempt) ?? 1,
    is_fallback: !!call.isFallback,
    http_status: int(call.httpStatus),
    error_message: truncate(call.error),
    input_tokens: int(call.inputTokens),
    output_tokens: int(call.outputTokens),
    total_tokens: int(call.totalTokens),
    cached_input_tokens: int(call.cachedInputTokens),
    reasoning_tokens: int(call.reasoningTokens),
    audio_seconds: call.audioSeconds ?? null,
    images: int(call.images),
    request_units: int(call.requestUnits) ?? 1,
    est_cost_usd: call.costUsd ?? null,
    cost_source: call.costSource ?? null,
    latency_ms: int(call.latencyMs),
    finish_reason: call.finishReason ?? null,
    prompt_hash: call.promptHash ?? null,
    created_at: call.at || new Date().toISOString(),
  };
}

/** Input-signal counts for extraction_runs (raw content stays on social_posts). */
export function signalColumns(content: SocialContent | null | undefined, raw?: unknown): Record<string, unknown> {
  if (!content) return {};
  const accounts = content.accounts || [];
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const accessFailure = [record.error, record.http_error_reason, record.errorDescription]
    .filter((value) => typeof value === 'string').join(' ');
  return {
    platform: content.platform,
    content_type: content.contentType,
    content_id: content.contentId && !String(content.contentId).startsWith('pending_') ? String(content.contentId) : null,
    caption_chars: (content.caption || '').length,
    hashtag_count: (content.hashtags || []).length,
    mention_count: (content.mentions || []).length,
    tagged_account_count: accounts.filter((account) => account.relation !== 'mention').length || (content.taggedUsers || []).length,
    has_location_tag: !!content.locationTag,
    comment_count: (content.comments || []).length,
    creator_comment_count: (content.comments || []).filter((comment) => comment.isCreator).length,
    video_duration_sec: content.videoDuration ?? null,
    subtitle_tracks: (content.subtitleTracks || []).length,
    is_restricted: /(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure),
  };
}

/** Models and OCR order in effect (never keys). */
export function pipelineConfig(): Record<string, unknown> {
  const env = process.env;
  const has = (name: string) => !!env[name]?.trim() && !env[name]!.trim().startsWith('your-');
  return {
    ocrOrder: env.OCR_ORDER || null,
    chatModel: env.OPENAI_CHAT_MODEL || 'gpt-4o',
    groqChatModel: env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b',
    visionModel: env.USE_GPT_VISION_MODEL || null,
    glmModel: env.GLM_OCR_MODEL || 'glm-4.6v-flash',
    audioModelOpenAi: env.OPENAI_AUDIO_MODEL || 'whisper-1',
    audioModelGroq: env.GROQ_AUDIO_MODEL || 'whisper-large-v3',
    ocrFallbackMaxFrames: env.OCR_FALLBACK_MAX_FRAMES || null,
    providers: {
      openai: has('OPENAI_API_KEY'),
      groq: has('GROQ_API_KEY'),
      zai: has('ZAI_API_KEY'),
      googlePlaces: has('GOOGLE_PLACES_API_KEY') || has('GOOGLE_MAPS_API_KEY'),
      mapbox: has('MAPBOX_ACCESS_TOKEN') || has('NEXT_PUBLIC_MAPBOX_TOKEN'),
    },
  };
}

function pipelineVersion(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.PIPELINE_VERSION;
  return sha ? sha.slice(0, 40) : null;
}

/** Columns for a finished run. */
export function finishedColumns(startedAtMs: number, status: RunStatus, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    ...extra,
    ...(typeof extra.error_message === 'string' ? { error_message: truncate(extra.error_message) } : {}),
  };
}

export class ExtractionLogStore {
  private static disabled = false;

  static enabled(): boolean {
    return !this.disabled && !/^(off|false|0|no)$/i.test(process.env.PIPELINE_LOG_DB?.trim() || '');
  }

  /** True when the write succeeded. Turns DB logging off when the tables do not exist yet. */
  private static ok(error: { code?: string; message?: string } | null, what: string): boolean {
    if (!error) return true;
    if (isMissingTable(error)) {
      if (!this.disabled) {
        console.warn(`[extraction-log] ${what}: log tables or columns not found (${error.message}) — apply supabase/migration_v26_extraction_logs.sql. DB logging is off until restart.`);
      }
      this.disabled = true;
      return false;
    }
    console.warn(`[extraction-log] ${what} failed:`, error.message);
    return false;
  }

  /** Create the run row. Returns its id, or null when DB logging is off or the insert failed. */
  static async startRun(input: StartRunInput): Promise<string | null> {
    if (!this.enabled()) return null;
    const row = {
      social_post_id: input.socialPostId || null,
      user_id: input.userId || null,
      platform: input.platform || null,
      input_url: input.inputUrl,
      route: input.route,
      trigger: input.trigger || 'new',
      status: 'running',
      pipeline_version: pipelineVersion(),
      config: pipelineConfig(),
    };
    try {
      let { data, error } = await supabaseAdmin.from('extraction_runs').insert(row).select('id').single();
      // A caller-supplied user id that is not a profile row must not cost us the whole run log.
      if (error?.code === '23503' && row.user_id) {
        ({ data, error } = await supabaseAdmin.from('extraction_runs').insert({ ...row, user_id: null }).select('id').single());
      }
      return this.ok(error, 'start run') ? data?.id ?? null : null;
    } catch (error) {
      console.warn('[extraction-log] start run failed:', errorMessage(error));
      return null;
    }
  }

  /** A request served from a completed post: records avoided cost for cache-hit analysis. */
  static async recordCacheHit(input: Omit<StartRunInput, 'trigger'>): Promise<void> {
    if (!this.enabled()) return;
    try {
      const now = new Date().toISOString();
      const { error } = await supabaseAdmin.from('extraction_runs').insert({
        social_post_id: input.socialPostId || null,
        user_id: input.userId || null,
        platform: input.platform || null,
        input_url: input.inputUrl,
        route: input.route,
        trigger: 'cache_hit',
        status: 'cache_hit',
        started_at: now,
        finished_at: now,
        duration_ms: 0,
        pipeline_version: pipelineVersion(),
      });
      this.ok(error, 'record cache hit');
    } catch (error) {
      console.warn('[extraction-log] record cache hit failed:', errorMessage(error));
    }
  }

  /**
   * Whether this post already had a run with this trigger, optionally only in
   * the given statuses (loop guard for recovery re-runs). False when DB logging is off.
   */
  static async hasRun(socialPostId: string, trigger: RunTrigger, statuses?: RunStatus[]): Promise<boolean> {
    if (!this.enabled() || !socialPostId) return false;
    try {
      let query = supabaseAdmin
        .from('extraction_runs')
        .select('id')
        .eq('social_post_id', socialPostId)
        .eq('trigger', trigger);
      if (statuses?.length) query = query.in('status', statuses);
      const { data, error } = await query.limit(1);
      return this.ok(error, 'look up runs') && (data?.length || 0) > 0;
    } catch {
      return false;
    }
  }

  static async patchRun(runId: string | null | undefined, fields: Record<string, unknown>): Promise<void> {
    if (!runId || !this.enabled() || Object.keys(fields).length === 0) return;
    try {
      const { error } = await supabaseAdmin.from('extraction_runs').update(fields).eq('id', runId);
      this.ok(error, 'update run');
    } catch (error) {
      console.warn('[extraction-log] update run failed:', errorMessage(error));
    }
  }

  private static async insertChunked(table: string, rows: Record<string, unknown>[]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
      const { error } = await supabaseAdmin.from(table).insert(rows.slice(offset, offset + INSERT_CHUNK));
      if (!this.ok(error, `insert ${table}`)) return;
    }
  }

  /** Stages and calls recorded outside a PipelineLog (e.g. the Apify webhook). */
  static async persistDetached(
    runId: string | null | undefined,
    records: { stages?: StageRecord[]; calls?: CallRecord[]; patch?: Record<string, unknown> }
  ): Promise<void> {
    if (!runId || !this.enabled()) return;
    try {
      await Promise.all([
        records.stages?.length ? this.insertChunked('extraction_run_stages', records.stages.map((stage) => stageRow(runId, stage))) : null,
        records.calls?.length ? this.insertChunked('extraction_run_calls', records.calls.map((call) => callRow(runId, call))) : null,
        records.patch ? this.patchRun(runId, records.patch) : null,
      ]);
    } catch (error) {
      console.warn('[extraction-log] detached persist failed:', errorMessage(error));
    }
  }

  /**
   * Write everything a PipelineLog collected. Buffers are cleared afterwards,
   * so a second flush does not duplicate rows.
   */
  static async persist(log: PipelineLog): Promise<void> {
    const runId = log.extractionRunId;
    if (!runId || !this.enabled()) return;

    const stages = log.stages.splice(0);
    const calls = log.calls.splice(0);
    const candidates = log.candidates.splice(0);
    const patch = { ...log.runPatch };
    for (const key of Object.keys(log.runPatch)) delete log.runPatch[key];
    const socialPostId = typeof log.context.socialPostId === 'string' ? log.context.socialPostId : null;

    const events = log.events.slice(log.persistedEvents);
    log.persistedEvents = log.events.length;
    const logRow = events.length || log.evidence ? {
      run_id: runId,
      part: log.part,
      event_count: events.length,
      warn_count: events.filter((event) => event.level === 'warn').length,
      error_count: events.filter((event) => event.level === 'error').length,
      events,
      evidence: log.evidence,
    } : null;
    log.evidence = null;

    const candidateRows = candidates.map((candidate) => ({
      run_id: runId,
      social_post_id: socialPostId,
      pass: candidate.pass,
      decision: candidate.decision,
      reason_code: candidate.reasonCode ?? null,
      reason: truncate(candidate.reason, 300),
      name: candidate.name ?? null,
      search_query: candidate.searchQuery || null,
      mention_type: candidate.mentionType ?? null,
      model_role: candidate.modelRole ?? null,
      base_category: candidate.baseCategory ?? null,
      category: candidate.category ?? null,
      saved_category: candidate.savedCategory ?? null,
      city: candidate.city || null,
      neighborhood: candidate.neighborhood || null,
      address: candidate.address || null,
      confidence: typeof candidate.confidence === 'number' ? Math.round(candidate.confidence * 1000) / 1000 : null,
      evidence_ids: candidate.evidenceIds ?? null,
      location_evidence_ids: candidate.locationEvidenceIds ?? null,
      evidence_sources: candidate.evidenceSources ?? null,
      evidence_snippets: candidate.evidenceSnippets ?? null,
      place_id: candidate.placeId ?? null,
      geocode_provider: candidate.geocodeProvider ?? null,
      geocode_verified: candidate.geocodeVerified ?? null,
      geocode_ambiguous: candidate.geocodeAmbiguous ?? null,
      google_place_id: candidate.googlePlaceId ?? null,
    }));

    try {
      await Promise.all([
        stages.length ? this.insertChunked('extraction_run_stages', stages.map((stage) => stageRow(runId, stage))) : null,
        calls.length ? this.insertChunked('extraction_run_calls', calls.map((call) => callRow(runId, call))) : null,
        candidateRows.length ? this.insertChunked('extraction_candidates', candidateRows) : null,
        logRow ? this.insertChunked('extraction_run_logs', [logRow]) : null,
        Object.keys(patch).length ? this.patchRun(runId, patch) : null,
      ]);
    } catch (error) {
      console.warn('[extraction-log] persist failed:', errorMessage(error));
    }
  }
}
