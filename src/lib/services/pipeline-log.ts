import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { estimateCostUsd } from './usage-cost';

export type PipelineLogLevel = 'info' | 'warn' | 'error';

export type PipelineStage =
  | 'run' | 'scrape' | 'media' | 'frames' | 'ocr' | 'vision' | 'transcript'
  | 'evidence' | 'model' | 'candidates' | 'geocode' | 'db';

export interface PipelineLogEvent {
  /** ISO time the event was recorded. */
  at: string;
  /** Milliseconds since the run started. */
  ms: number;
  stage: PipelineStage;
  level: PipelineLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export type StageStatus = 'success' | 'partial' | 'skipped' | 'failed';

/** One execution of a pipeline stage (download, OCR step, model pass, …). */
export interface StageRecord {
  stage: string;
  provider?: string | null;
  status: StageStatus;
  startedAt: string;
  durationMs: number;
  itemsIn?: number | null;
  itemsOut?: number | null;
  error?: string | null;
  details?: Record<string, unknown>;
}

/** One metered external call attempt (LLM, OCR, speech, geocoder, scraper). */
export interface CallRecord {
  stage: PipelineStage;
  operation: string;
  provider: string;
  model?: string | null;
  status: 'success' | 'error';
  attempt?: number;
  isFallback?: boolean;
  httpStatus?: number | null;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  audioSeconds?: number | null;
  images?: number | null;
  requestUnits?: number | null;
  latencyMs?: number | null;
  finishReason?: string | null;
  promptHash?: string | null;
  /** Provider-reported cost; otherwise estimated from the price table. */
  costUsd?: number | null;
  costSource?: 'price_table' | 'provider_reported' | 'free' | null;
  at?: string;
}

export type CandidatePass = 'primary' | 'recovery' | 'restricted_recovery';
export type CandidateDecision = 'rejected' | 'saved' | 'linked_existing' | 'unsaved' | 'save_error';

/** Outcome of one model candidate: why it was dropped, or where it was saved. */
export interface CandidateRecord {
  pass: CandidatePass;
  decision: CandidateDecision;
  reasonCode?: string | null;
  reason?: string | null;
  name?: string | null;
  searchQuery?: string | null;
  mentionType?: string | null;
  modelRole?: string | null;
  baseCategory?: string | null;
  category?: string | null;
  savedCategory?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  confidence?: number | null;
  evidenceIds?: string[];
  locationEvidenceIds?: string[];
  evidenceSources?: string[];
  evidenceSnippets?: unknown[];
  placeId?: string | null;
  geocodeProvider?: string | null;
  geocodeVerified?: boolean | null;
  geocodeAmbiguous?: boolean | null;
  googlePlaceId?: string | null;
}

/** What DbService.savePlace did with one place (set inside savePlace, read by the analyze route). */
export interface SaveOutcome {
  decision: Exclude<CandidateDecision, 'rejected'>;
  reason?: string;
  placeId?: string | null;
  provider?: string | null;
  verified?: boolean;
  ambiguous?: boolean;
  googlePlaceId?: string | null;
  savedCategory?: string | null;
}

export interface EvidenceSnapshotItem {
  id: string;
  source: string;
  text: string;
  t?: number[];
}

const RETENTION_DAYS = 30;
const MAX_EVENTS = 2_000;
/** Size guards for log rows only (extraction itself is not capped). */
const MAX_ERROR_CHARS = 1_000;
const MAX_EVIDENCE_TEXT_CHARS = 300;
const MAX_CALL_RECORDS = 5_000;
// Creator bios and comments can contain e-mail addresses; logs are kept for 30 days.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redact<T>(value: T): T {
  if (typeof value === 'string') return value.replace(EMAIL_RE, '[email]') as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)])) as T;
  }
  return value;
}

export function truncate(value: string | null | undefined, max = MAX_ERROR_CHARS): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** "low evidence score 0.32" → "low_evidence_score", "role:background" → "role_background". */
export function reasonCode(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const code = reason.toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, ' ')
    .replace(/[^a-z]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return code || null;
}

/** Key used to match a candidate across passes and against save results. */
export function candidateKey(name: string | null | undefined): string {
  return (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Structured log for one post's pipeline run. Events are printed to the
 * console, returned to the caller (the UI shows them), and appended as JSON
 * lines to logs/pipeline-YYYY-MM-DD.jsonl. When `extractionRunId` is set,
 * flush() also writes the run's stages, metered calls, candidate outcomes and
 * events to the extraction_* tables (migration v26).
 */
export class PipelineLog {
  readonly events: PipelineLogEvent[] = [];
  readonly stages: StageRecord[] = [];
  readonly calls: CallRecord[] = [];
  readonly candidates: CandidateRecord[] = [];
  /** Columns to update on extraction_runs at flush. */
  readonly runPatch: Record<string, unknown> = {};
  /** Evidence exactly as sent to the model (trimmed), for "what did the model see?". */
  evidence: EvidenceSnapshotItem[] | null = null;
  /** First pass that accepted each candidate (by candidateKey). */
  readonly acceptedPass = new Map<string, CandidatePass>();
  readonly saveOutcomes = new WeakMap<object, SaveOutcome>();
  /** extraction_runs.id; DB persistence is skipped without it. */
  extractionRunId: string | null = null;
  /** Which part of the run this log covers (one run can span two HTTP requests). */
  part = 'pipeline';
  /** Events already written to extraction_run_logs, so a second flush only adds new ones. */
  persistedEvents = 0;
  readonly started = Date.now();

  /** Platform content id when known, so media and analysis logs of one post share an id. */
  constructor(public runId: string, readonly context: Record<string, unknown> = {}) {}

  add(stage: PipelineStage, level: PipelineLogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({
      at: new Date().toISOString(),
      ms: Date.now() - this.started,
      stage,
      level,
      message: redact(message),
      ...(data && Object.keys(data).length ? { data: redact(data) } : {}),
    });
  }

  addStage(record: StageRecord): void {
    this.stages.push({ ...record, error: truncate(record.error), details: record.details ? redact(record.details) : undefined });
  }

  addCall(record: CallRecord): void {
    if (this.calls.length >= MAX_CALL_RECORDS) return;
    this.calls.push(record);
  }

  addCandidate(record: CandidateRecord): void {
    this.candidates.push(redact(record));
  }

  patch(fields: Record<string, unknown>): void {
    Object.assign(this.runPatch, fields);
  }

  /** Add to a numeric run column (e.g. candidates across the primary and recovery passes). */
  increment(column: string, by: number): void {
    this.runPatch[column] = (Number(this.runPatch[column]) || 0) + by;
  }

  setEvidence(items: Array<{ id: string; source: string; text: string; timestamps?: number[] }>): void {
    this.evidence = items.map((item) => ({
      id: item.id,
      source: item.source,
      text: redact(item.text.length > MAX_EVIDENCE_TEXT_CHARS ? `${item.text.slice(0, MAX_EVIDENCE_TEXT_CHARS)}…` : item.text),
      ...(item.timestamps?.length ? { t: item.timestamps.slice(0, 5) } : {}),
    }));
  }

  /**
   * Append this run to the daily JSONL file (synchronously), then persist to
   * the database when a run id is set. Best effort: never throws.
   */
  async flush(): Promise<void> {
    if (this.events.length > 0) {
      const line = JSON.stringify({ runId: this.runId, extractionRunId: this.extractionRunId, ...this.context, events: this.events }) + '\n';
      for (const dir of logDirectories()) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, `pipeline-${new Date().toISOString().slice(0, 10)}.jsonl`), line);
          pruneOldLogs(dir);
          break;
        } catch {
          // Read-only filesystem (serverless): try the next location.
        }
      }
    }
    if (!this.extractionRunId) return;
    try {
      const { ExtractionLogStore } = await import('./extraction-log.store');
      await ExtractionLogStore.persist(this);
    } catch (error) {
      console.warn('[pipeline-log] DB persistence failed:', errorMessage(error));
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

/** Run `fn` with `log` as the current pipeline log for every nested async call. */
export function withPipelineLog<T>(log: PipelineLog, fn: () => Promise<T>): Promise<T> {
  return storage.run(log, fn);
}

export function currentPipelineLog(): PipelineLog | undefined {
  return storage.getStore();
}

// Resolved at call time so console wrappers (log shippers, test spies) see pipeline logs.
const CONSOLE_METHOD: Record<PipelineLogLevel, 'log' | 'warn' | 'error'> = { info: 'log', warn: 'warn', error: 'error' };

/**
 * Log one pipeline event: always to the console, and to the current run's
 * log when one is active.
 */
export function plog(
  stage: PipelineStage,
  message: string,
  data?: Record<string, unknown>,
  level: PipelineLogLevel = 'info'
): void {
  const log = storage.getStore();
  const prefix = `[${stage}]${log ? ` [${log.runId.slice(0, 8)}]` : ''}`;
  const write = console[CONSOLE_METHOD[level]];
  if (data && Object.keys(data).length) write(prefix, redact(message), JSON.stringify(redact(data)));
  else write(prefix, redact(message));
  log?.add(stage, level, message, data);
}

type StageFields = Omit<StageRecord, 'stage' | 'provider' | 'status' | 'startedAt' | 'durationMs'> & { provider?: string | null };

/**
 * Start timing a stage of the current run. Call the returned function once
 * with the outcome. No-op outside a run.
 */
export function startStage(stage: string, provider?: string | null) {
  const log = storage.getStore();
  const started = Date.now();
  return (status: StageStatus, fields: StageFields = {}): void => {
    log?.addStage({
      stage,
      provider: fields.provider ?? provider ?? null,
      status,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      itemsIn: fields.itemsIn ?? null,
      itemsOut: fields.itemsOut ?? null,
      error: fields.error ?? null,
      details: fields.details,
    });
  };
}

/** Status of a stage from how many of its inputs it handled. */
export function stageStatus(itemsIn: number, itemsOut: number): StageStatus {
  if (itemsIn === 0) return 'skipped';
  if (itemsOut === 0) return 'failed';
  return itemsOut < itemsIn ? 'partial' : 'success';
}

/**
 * Record one metered external call on the current run, with its estimated
 * cost. No-op outside a run.
 */
export function logCall(record: CallRecord, log: PipelineLog | undefined = storage.getStore()): void {
  if (!log) return;
  const hasUsage = !!(record.inputTokens || record.outputTokens || record.audioSeconds);
  let costUsd = record.costUsd ?? null;
  let costSource = record.costSource ?? null;
  // Failed requests with no reported usage are normally not billed: leave their cost empty.
  if (costUsd === null && (record.status === 'success' || hasUsage)) {
    const estimate = estimateCostUsd({
      provider: record.provider,
      model: record.model,
      operation: record.operation,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      audioSeconds: record.audioSeconds,
      images: record.images,
      requestUnits: record.requestUnits,
    });
    costUsd = estimate.costUsd;
    costSource = estimate.source;
  }
  const totalTokens = record.totalTokens ?? (record.inputTokens || record.outputTokens
    ? (record.inputTokens || 0) + (record.outputTokens || 0)
    : null);
  log.addCall({
    ...record,
    totalTokens,
    error: truncate(record.error ? redact(record.error) : null),
    costUsd,
    costSource,
    at: record.at || new Date().toISOString(),
  });
}

/** Set run columns on the current run. No-op outside a run. */
export function patchRun(fields: Record<string, unknown>): void {
  storage.getStore()?.patch(fields);
}

/** Remember what savePlace did with this place object (read back by the analyze route). */
export function noteSaveOutcome(place: object, outcome: SaveOutcome): void {
  storage.getStore()?.saveOutcomes.set(place, outcome);
}

/** Message of a caught value, for log data. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
