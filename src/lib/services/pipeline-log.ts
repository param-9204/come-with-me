import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type PipelineLogLevel = 'info' | 'warn' | 'error';

export type PipelineStage =
  | 'run' | 'media' | 'frames' | 'ocr' | 'vision' | 'transcript'
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

const RETENTION_DAYS = 30;
const MAX_EVENTS = 2_000;
// Creator bios and comments can contain e-mail addresses; logs are kept for 30 days.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact<T>(value: T): T {
  if (typeof value === 'string') return value.replace(EMAIL_RE, '[email]') as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)])) as T;
  }
  return value;
}

/**
 * Structured log for one post's pipeline run. Events are printed to the
 * console, returned to the caller (the UI shows them), and appended as JSON
 * lines to logs/pipeline-YYYY-MM-DD.jsonl.
 */
export class PipelineLog {
  readonly events: PipelineLogEvent[] = [];
  private readonly started = Date.now();

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

  /** Append this run to the daily JSONL file. Best effort: never throws. */
  flush(): void {
    if (this.events.length === 0) return;
    const line = JSON.stringify({ runId: this.runId, ...this.context, events: this.events }) + '\n';
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

/** Message of a caught value, for log data. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
