import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supabaseAdmin } from '../supabase';
import type { EvidenceItem, PlaceExtraction } from '../types/social';

export type PipelineLogLevel = 'info' | 'warn' | 'error';
export type PipelineRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type PipelineOperationStatus = 'success' | 'partial' | 'failed' | 'skipped';

export type PipelineStage =
  | 'run' | 'scrape' | 'media' | 'frames' | 'ocr' | 'vision' | 'transcript'
  | 'evidence' | 'model' | 'candidates' | 'geocode' | 'db';

export interface PipelineLogEvent {
  at: string;
  ms: number;
  stage: PipelineStage;
  level: PipelineLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface PipelineOperationInput {
  stage: PipelineStage;
  operation: string;
  provider?: string | null;
  model?: string | null;
  status?: PipelineOperationStatus;
  attempt?: number;
  isFallback?: boolean;
  startedAt?: Date;
  finishedAt?: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  inputUnits?: number | null;
  outputUnits?: number | null;
  /** Direct per-operation estimate for unit-priced APIs such as Cloud Vision. */
  estimatedCostUsd?: number | null;
  costBasis?: Record<string, unknown>;
  requestSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  error?: unknown;
  retryable?: boolean | null;
}

interface PipelineOperation extends Required<Pick<PipelineOperationInput, 'stage' | 'operation'>> {
  provider: string | null;
  model: string | null;
  status: PipelineOperationStatus;
  attempt: number;
  isFallback: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  inputUnits: number | null;
  outputUnits: number | null;
  estimatedCostUsd: number | null;
  costBasis: Record<string, unknown>;
  requestSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
}

interface PipelineEvidenceRecord {
  evidenceId: string;
  sourceType: string;
  textValue: string;
  textSha256: string;
  confidence: number | null;
  timestampsSec: number[];
  frameIndexes: number[];
  provider: string | null;
  model: string | null;
  attributes: Record<string, unknown>;
}

interface PipelineCandidateRecord {
  candidateKey: string;
  placeId: string | null;
  name: string | null;
  category: string | null;
  baseCategory: string | null;
  city: string | null;
  neighborhood: string | null;
  address: string | null;
  confidence: number | null;
  mentionType: string | null;
  role: string | null;
  decision: 'accepted' | 'rejected' | 'unresolved' | 'save_failed';
  decisionReason: string | null;
  evidenceIds: string[];
  locationEvidenceIds: string[];
  evidenceSources: string[];
  modelProvider: string | null;
  model: string | null;
  details: Record<string, unknown>;
}

export interface PipelineRunInput {
  platform?: string | null;
  inputUrl?: string | null;
  socialPostId?: string | null;
  entrypoint?: string | null;
  contentId?: string | null;
  contentType?: string | null;
  caption?: string | null;
  hashtags?: string[] | null;
  mentions?: string[] | null;
  taggedAccounts?: unknown[] | null;
  metadata?: Record<string, unknown>;
}

const RETENTION_DAYS = 30;
const MAX_EVENTS = 2_000;
const MAX_DB_EVENTS = 2_000;
const MAX_TEXT_LENGTH = 8_000;
const MAX_JSON_STRING_LENGTH = 4_000;
const DB_LOG_TIMEOUT_MS = Math.max(200, Number(process.env.PIPELINE_DB_LOG_TIMEOUT_MS) || 1_500);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<!\d)(?:\+?\d[\d().\-\s]{7,}\d)(?!\d)/g;
const SECRET_RE = /\b(?:sk|rk|pk|AIza)[-_A-Za-z0-9]{12,}\b/g;
const AUTH_RE = /\b(?:bearer|token|api[_-]?key)\s+[^\s,;]+/gi;
const URL_SECRET_RE = /([?&](?:access_token|api[_-]?key|key|token|signature|x-amz-signature)=)[^&#\s]+/gi;

/** Defaults are estimates only. Override them in PIPELINE_MODEL_COST_RATES_JSON when pricing changes. */
const DEFAULT_TOKEN_RATES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'openai:gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'openai:gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai:gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
};

function clip(value: string, max = MAX_JSON_STRING_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function redactString(value: string, max = MAX_JSON_STRING_LENGTH): string {
  return clip(value, max)
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[phone]')
    .replace(SECRET_RE, '[secret]')
    .replace(AUTH_RE, '[credential]')
    .replace(URL_SECRET_RE, '$1[secret]');
}

function redact<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.slice(0, 250).map((entry) => redact(entry, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (depth >= 5) return '[truncated-object]' as T;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(?:authorization|password|api[_-]?key|token|cookie|base64|image|audio)$/i.test(key))
      .slice(0, 100)
      .map(([key, entry]) => [key, redact(entry, depth + 1)])) as T;
  }
  return value;
}

function safeRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return redact(value || {}) as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function errorDetails(error: unknown): { code: string | null; message: string | null } {
  if (!error) return { code: null, message: null };
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  return {
    code: value.code ? String(value.code) : value.status ? String(value.status) : null,
    message: redactString(value.message ? String(value.message) : String(error)),
  };
}

function configuredTokenRates(): Record<string, { inputPerMillion: number; outputPerMillion: number }> {
  try {
    const parsed = JSON.parse(process.env.PIPELINE_MODEL_COST_RATES_JSON || '{}') as Record<string, any>;
    const sanitized = Object.entries(parsed).flatMap(([key, value]) => {
      const input = asNumber(value?.inputPerMillion);
      const output = asNumber(value?.outputPerMillion);
      return input === null || output === null ? [] : [[key.toLowerCase(), { inputPerMillion: input, outputPerMillion: output }] as const];
    });
    return { ...DEFAULT_TOKEN_RATES, ...Object.fromEntries(sanitized) };
  } catch {
    return DEFAULT_TOKEN_RATES;
  }
}

function estimateTokenCost(provider: string | null, model: string | null, input: number | null, output: number | null): { cost: number | null; basis: Record<string, unknown> } {
  if (!provider || !model || (input === null && output === null)) return { cost: null, basis: {} };
  const key = `${provider}:${model}`.toLowerCase();
  const rate = configuredTokenRates()[key];
  if (!rate) return { cost: null, basis: { pricing: 'unknown', pricingKey: key } };
  const cost = ((input || 0) / 1_000_000) * rate.inputPerMillion + ((output || 0) / 1_000_000) * rate.outputPerMillion;
  return {
    cost: Number(cost.toFixed(8)),
    basis: { pricing: 'token_estimate', pricingKey: key, inputPerMillion: rate.inputPerMillion, outputPerMillion: rate.outputPerMillion },
  };
}

function pipelineLoggingEnabled(): boolean {
  return process.env.PIPELINE_DB_LOGGING !== 'false'
    && !!process.env.NEXT_PUBLIC_SUPABASE_URL
    && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

let databaseUnavailableUntil = 0;

/**
 * Structured log for one extraction run. It remains compatible with the
 * existing JSONL/console logger and adds a best-effort database audit trail.
 */
export class PipelineLog {
  readonly events: PipelineLogEvent[] = [];
  readonly operations: PipelineOperation[] = [];
  readonly evidence: PipelineEvidenceRecord[] = [];
  readonly candidates = new Map<string, PipelineCandidateRecord>();
  pipelineRunId: string;
  private started: Date;
  private input: PipelineRunInput = {};
  private result: Record<string, unknown> = {};
  private status: PipelineRunStatus = 'running';
  private finalError: { code: string | null; message: string | null } = { code: null, message: null };
  private databaseFlushed = false;

  constructor(public runId: string, readonly context: Record<string, unknown> = {}) {
    const requestedId = typeof context.pipelineRunId === 'string' ? context.pipelineRunId : '';
    this.pipelineRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)
      ? requestedId
      : randomUUID();
    const started = typeof context.pipelineStartedAt === 'string' ? new Date(context.pipelineStartedAt) : null;
    this.started = started && Number.isFinite(started.getTime()) ? started : new Date();
  }

  /** Join a media and analysis request to one durable pipeline run. */
  adoptPipelineRun(pipelineRunId: unknown, pipelineStartedAt?: unknown): void {
    if (typeof pipelineRunId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pipelineRunId)) return;
    this.pipelineRunId = pipelineRunId;
    if (typeof pipelineStartedAt === 'string') {
      const started = new Date(pipelineStartedAt);
      if (Number.isFinite(started.getTime())) this.started = started;
    }
  }

  get pipelineStartedAt(): string {
    return this.started.toISOString();
  }

  setRunInput(input: PipelineRunInput): void {
    this.input = {
      ...this.input,
      ...input,
      hashtags: input.hashtags ? input.hashtags.slice(0, 100) : this.input.hashtags,
      mentions: input.mentions ? input.mentions.slice(0, 100) : this.input.mentions,
      taggedAccounts: input.taggedAccounts ? input.taggedAccounts.slice(0, 100) : this.input.taggedAccounts,
      metadata: { ...(this.input.metadata || {}), ...(input.metadata || {}) },
    };
  }

  setResult(summary: Record<string, unknown>, status: PipelineRunStatus = 'completed'): void {
    this.result = { ...this.result, ...safeRecord(summary) };
    this.status = status;
  }

  fail(error: unknown, summary?: Record<string, unknown>): void {
    this.status = 'failed';
    this.finalError = errorDetails(error);
    if (summary) this.result = { ...this.result, ...safeRecord(summary) };
  }

  add(stage: PipelineStage, level: PipelineLogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({
      at: new Date().toISOString(),
      ms: Math.max(0, Date.now() - this.started.getTime()),
      stage,
      level,
      message: redactString(message),
      ...(data && Object.keys(data).length ? { data: safeRecord(data) } : {}),
    });
  }

  recordOperation(input: PipelineOperationInput): void {
    const startedAt = input.startedAt || new Date();
    const finishedAt = input.finishedAt || new Date();
    const inputTokens = asNumber(input.inputTokens);
    const outputTokens = asNumber(input.outputTokens);
    const totalTokens = asNumber(input.totalTokens) ?? ((inputTokens !== null || outputTokens !== null) ? (inputTokens || 0) + (outputTokens || 0) : null);
    const calculated = estimateTokenCost(input.provider || null, input.model || null, inputTokens, outputTokens);
    const directCost = asNumber(input.estimatedCostUsd);
    const error = errorDetails(input.error);
    this.operations.push({
      stage: input.stage,
      operation: redactString(input.operation, 160),
      provider: input.provider ? redactString(input.provider, 160) : null,
      model: input.model ? redactString(input.model, 240) : null,
      status: input.status || (input.error ? 'failed' : 'success'),
      attempt: Math.max(1, Math.floor(input.attempt || 1)),
      isFallback: !!input.isFallback,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      inputTokens,
      outputTokens,
      totalTokens,
      inputUnits: asNumber(input.inputUnits),
      outputUnits: asNumber(input.outputUnits),
      estimatedCostUsd: directCost ?? calculated.cost,
      costBasis: safeRecord({ ...calculated.basis, ...(input.costBasis || {}) }),
      requestSummary: safeRecord(input.requestSummary),
      resultSummary: safeRecord(input.resultSummary),
      errorCode: error.code,
      errorMessage: error.message,
      retryable: typeof input.retryable === 'boolean' ? input.retryable : null,
    });
  }

  recordEvidence(items: EvidenceItem[], provider?: string | null, model?: string | null): void {
    for (const item of items) {
      const text = redactString(item.text || '', MAX_TEXT_LENGTH);
      if (!item.id || !text) continue;
      this.evidence.push({
        evidenceId: clip(item.id, 100),
        sourceType: clip(item.source, 80),
        textValue: text,
        textSha256: createHash('sha256').update(text).digest('hex'),
        confidence: asNumber(item.weight),
        timestampsSec: (item.timestamps || []).map(Number).filter(Number.isFinite).slice(0, 120),
        frameIndexes: (item.frames || []).map(Number).filter(Number.isFinite).slice(0, 120),
        provider: provider ? clip(provider, 160) : null,
        model: model ? clip(model, 240) : null,
        attributes: safeRecord({ username: item.username, displayName: item.displayName, relation: item.relation }),
      });
    }
  }

  recordCandidate(candidate: PipelineCandidateRecord): void {
    this.candidates.set(candidate.candidateKey, {
      ...candidate,
      name: candidate.name ? redactString(candidate.name, 500) : null,
      city: candidate.city ? redactString(candidate.city, 500) : null,
      neighborhood: candidate.neighborhood ? redactString(candidate.neighborhood, 500) : null,
      address: candidate.address ? redactString(candidate.address, 1_000) : null,
      decisionReason: candidate.decisionReason ? redactString(candidate.decisionReason, 2_000) : null,
      evidenceIds: candidate.evidenceIds.slice(0, 100),
      locationEvidenceIds: candidate.locationEvidenceIds.slice(0, 100),
      evidenceSources: candidate.evidenceSources.slice(0, 30),
      details: safeRecord(candidate.details),
    });
  }

  /** Append the legacy JSONL file. Best effort: never throws. */
  flush(): void {
    if (this.events.length === 0) return;
    const line = JSON.stringify({ runId: this.runId, pipelineRunId: this.pipelineRunId, ...this.context, events: this.events }) + '\n';
    for (const dir of logDirectories()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `pipeline-${new Date().toISOString().slice(0, 10)}.jsonl`), line);
        pruneOldLogs(dir);
        return;
      } catch {
        // Read-only filesystem (serverless): try the next location.
      }
    }
  }

  /** Persist the durable audit trail. Never throws or changes pipeline output. */
  async flushDatabase(): Promise<void> {
    if (this.databaseFlushed || !pipelineLoggingEnabled() || Date.now() < databaseUnavailableUntil) return;
    this.databaseFlushed = true;
    const persist = this.persistDatabase();
    try {
      await Promise.race([
        persist,
        new Promise<void>((resolve) => setTimeout(resolve, DB_LOG_TIMEOUT_MS)),
      ]);
    } catch (error) {
      databaseUnavailableUntil = Date.now() + 60_000;
      console.warn('[pipeline-log] Database audit logging skipped:', errorDetails(error).message);
    }
  }

  private async persistDatabase(): Promise<void> {
    const now = new Date();
    const durationMs = Math.max(0, now.getTime() - this.started.getTime());
    const inferredFailure = this.status === 'running' && this.events.some((event) => event.level === 'error');
    const status = inferredFailure ? 'partial' : this.status;
    const inputSnapshot = safeRecord({
      contentId: this.input.contentId || null,
      contentType: this.input.contentType || null,
      caption: this.input.caption ? redactString(this.input.caption, MAX_TEXT_LENGTH) : null,
      hashtags: this.input.hashtags || [],
      mentions: this.input.mentions || [],
      taggedAccounts: this.input.taggedAccounts || [],
      metadata: this.input.metadata || {},
    });
    const { error: runError } = await supabaseAdmin.from('extraction_runs').upsert({
      id: this.pipelineRunId,
      external_run_id: this.runId,
      social_post_id: this.input.socialPostId || this.context.socialPostId || null,
      platform: this.input.platform || this.context.platform || null,
      input_url: this.input.inputUrl || this.context.url || null,
      entrypoint: this.input.entrypoint || this.context.route || null,
      status,
      input_snapshot: inputSnapshot,
      result_summary: safeRecord(this.result),
      error_code: this.finalError.code,
      error_message: this.finalError.message,
      started_at: this.started.toISOString(),
      ...(status === 'running' ? {} : { finished_at: now.toISOString(), duration_ms: durationMs }),
      updated_at: now.toISOString(),
    }, { onConflict: 'id' });
    if (runError) throw runError;

    const events = this.events.slice(0, MAX_DB_EVENTS).map((event) => ({
      run_id: this.pipelineRunId,
      occurred_at: event.at,
      elapsed_ms: event.ms,
      stage: event.stage,
      level: event.level,
      message: event.message,
      data: event.data || {},
    }));
    if (events.length) {
      const { error } = await supabaseAdmin.from('extraction_run_events').insert(events);
      if (error) throw error;
    }

    if (this.operations.length) {
      const { error } = await supabaseAdmin.from('extraction_stage_runs').insert(this.operations.map((operation) => ({
        run_id: this.pipelineRunId,
        stage: operation.stage,
        operation: operation.operation,
        status: operation.status,
        provider: operation.provider,
        model: operation.model,
        attempt: operation.attempt,
        is_fallback: operation.isFallback,
        started_at: operation.startedAt,
        finished_at: operation.finishedAt,
        duration_ms: operation.durationMs,
        input_tokens: operation.inputTokens,
        output_tokens: operation.outputTokens,
        total_tokens: operation.totalTokens,
        input_units: operation.inputUnits,
        output_units: operation.outputUnits,
        estimated_cost_usd: operation.estimatedCostUsd,
        cost_basis: operation.costBasis,
        request_summary: operation.requestSummary,
        result_summary: operation.resultSummary,
        error_code: operation.errorCode,
        error_message: operation.errorMessage,
        retryable: operation.retryable,
      })));
      if (error) throw error;
    }

    if (this.evidence.length) {
      const rows = [...new Map(this.evidence.map((item) => [item.evidenceId, item])).values()].map((item) => ({
        run_id: this.pipelineRunId,
        evidence_id: item.evidenceId,
        source_type: item.sourceType,
        text_value: item.textValue,
        text_sha256: item.textSha256,
        confidence: item.confidence,
        timestamps_sec: item.timestampsSec,
        frame_indexes: item.frameIndexes,
        provider: item.provider,
        model: item.model,
        attributes: item.attributes,
      }));
      const { error } = await supabaseAdmin.from('extraction_evidence').upsert(rows, { onConflict: 'run_id,evidence_id' });
      if (error) throw error;
    }

    if (this.candidates.size) {
      const rows = [...this.candidates.values()].map((candidate) => ({
        run_id: this.pipelineRunId,
        candidate_key: candidate.candidateKey,
        place_id: candidate.placeId,
        name: candidate.name,
        category: candidate.category,
        base_category: candidate.baseCategory,
        city: candidate.city,
        neighborhood: candidate.neighborhood,
        address: candidate.address,
        confidence: candidate.confidence,
        mention_type: candidate.mentionType,
        role: candidate.role,
        decision: candidate.decision,
        decision_reason: candidate.decisionReason,
        evidence_ids: candidate.evidenceIds,
        location_evidence_ids: candidate.locationEvidenceIds,
        evidence_sources: candidate.evidenceSources,
        model_provider: candidate.modelProvider,
        model: candidate.model,
        details: candidate.details,
        updated_at: now.toISOString(),
      }));
      const { error } = await supabaseAdmin.from('extraction_place_candidates').upsert(rows, { onConflict: 'run_id,candidate_key' });
      if (error) throw error;
    }
  }
}

function logDirectories(): string[] {
  return [process.env.PIPELINE_LOG_DIR, path.join(process.cwd(), 'logs'), path.join(os.tmpdir(), 'logs')]
    .filter((dir): dir is string => !!dir);
}

let lastPrune = 0;
function pruneOldLogs(dir: string): void {
  if (Date.now() - lastPrune < 60 * 60_000) return;
  lastPrune = Date.now();
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(/^pipeline-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (match && new Date(match[1]).getTime() < cutoff) fs.rmSync(path.join(dir, file), { force: true });
  }
}

const storage = new AsyncLocalStorage<PipelineLog>();

export function withPipelineLog<T>(log: PipelineLog, fn: () => Promise<T>): Promise<T> {
  return storage.run(log, fn);
}

export function currentPipelineLog(): PipelineLog | undefined {
  return storage.getStore();
}

const CONSOLE_METHOD: Record<PipelineLogLevel, 'log' | 'warn' | 'error'> = { info: 'log', warn: 'warn', error: 'error' };

export function plog(stage: PipelineStage, message: string, data?: Record<string, unknown>, level: PipelineLogLevel = 'info'): void {
  const log = storage.getStore();
  const prefix = `[${stage}]${log ? ` [${log.runId.slice(0, 8)}]` : ''}`;
  const write = console[CONSOLE_METHOD[level]];
  if (data && Object.keys(data).length) write(prefix, redactString(message), JSON.stringify(safeRecord(data)));
  else write(prefix, redactString(message));
  log?.add(stage, level, message, data);
}

export function recordPipelineOperation(input: PipelineOperationInput): void {
  storage.getStore()?.recordOperation(input);
}

export function recordPipelineEvidence(items: EvidenceItem[], provider?: string | null, model?: string | null): void {
  storage.getStore()?.recordEvidence(items, provider, model);
}

export function recordPlaceCandidate(
  candidateKey: string,
  place: PlaceExtraction | { name?: string | null; reason?: string },
  decision: PipelineCandidateRecord['decision'],
  options: { placeId?: string | null; reason?: string | null; details?: Record<string, unknown>; modelProvider?: string | null; model?: string | null } = {}
): void {
  const value = place as PlaceExtraction;
  storage.getStore()?.recordCandidate({
    candidateKey,
    placeId: options.placeId || null,
    name: value.name || null,
    category: value.category || null,
    baseCategory: value.base_category || null,
    city: value.city || null,
    neighborhood: value.neighborhood || null,
    address: value.address || null,
    confidence: asNumber(value.confidence),
    mentionType: value.mention_type || null,
    role: value.role || null,
    decision,
    decisionReason: options.reason || (place as { reason?: string }).reason || value.explanation || null,
    evidenceIds: value.evidence_ids || [],
    locationEvidenceIds: value.location_evidence_ids || [],
    evidenceSources: value.evidence_sources || [],
    modelProvider: options.modelProvider || null,
    model: options.model || null,
    details: options.details || {},
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
