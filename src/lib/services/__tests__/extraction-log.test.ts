import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Supabase: records every insert/update, returns a scripted error when set.
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
  updates: [] as Array<{ table: string; fields: Record<string, unknown>; id: string }>,
  error: null as null | { code: string; message: string },
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: (rows: Row | Row[]) => {
        db.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        const result = Promise.resolve({ data: null, error: db.error });
        return Object.assign(result, {
          select: () => ({ single: async () => ({ data: db.error ? null : { id: 'run-1' }, error: db.error }) }),
        });
      },
      update: (fields: Row) => ({
        eq: async (_column: string, id: string) => {
          db.updates.push({ table, fields, id });
          return { error: db.error };
        },
      }),
    }),
  },
}));

import { chatUsage, estimateCostUsd } from '../usage-cost';
import { executeAICall } from '../ai-client';
import { finalizeCandidates } from '../ai-enrichment.service';
import { buildEvidence } from '../place-evidence.service';
import { ExtractionLogStore } from '../extraction-log.store';
import { PipelineLog, logCall, reasonCode, startStage, withPipelineLog } from '../pipeline-log';
import { candidate, makeContent } from './fixtures';

const ENV_KEYS = ['OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENAI_CHAT_MODEL', 'GROQ_CHAT_MODEL', 'PRICING_OVERRIDES_JSON', 'PIPELINE_LOG_DB', 'PIPELINE_LOG_DIR'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  db.inserts.length = 0;
  db.updates.length = 0;
  db.error = null;
  (ExtractionLogStore as unknown as { disabled: boolean }).disabled = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('cost estimates', () => {
  it('prices cached input tokens at the cached rate', () => {
    const { costUsd, source } = estimateCostUsd({
      provider: 'openai', model: 'gpt-4o', operation: 'place_extraction',
      inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000,
    });
    // 600k × $2.50 + 400k × $1.25 + 100k × $10, per 1M tokens.
    expect(costUsd).toBeCloseTo(3.0, 6);
    expect(source).toBe('price_table');
  });

  it('matches the longest model prefix (gpt-4o-mini is not billed as gpt-4o)', () => {
    expect(estimateCostUsd({ provider: 'openai', model: 'gpt-4o-mini-2024-07-18', operation: 'x', inputTokens: 1_000_000 }).costUsd).toBeCloseTo(0.15, 6);
  });

  it('prices speech by audio minute and Google calls by request', () => {
    expect(estimateCostUsd({ provider: 'openai', model: 'whisper-1', operation: 'transcription', audioSeconds: 90 }).costUsd).toBeCloseTo(0.009, 6);
    expect(estimateCostUsd({ provider: 'google', operation: 'places_text_search' }).costUsd).toBeCloseTo(0.032, 6);
  });

  it('returns null (not 0) for an unpriced model, and honours PRICING_OVERRIDES_JSON', () => {
    expect(estimateCostUsd({ provider: 'groq', model: 'openai/gpt-oss-20b', operation: 'x', inputTokens: 1000 }).costUsd).toBeNull();
    process.env.PRICING_OVERRIDES_JSON = JSON.stringify({ 'groq:openai/gpt-oss-20b': { inputPer1M: 1, outputPer1M: 2 } });
    expect(estimateCostUsd({ provider: 'groq', model: 'openai/gpt-oss-20b', operation: 'x', inputTokens: 1_000_000, outputTokens: 1_000_000 }).costUsd).toBeCloseTo(3, 6);
  });

  it('reads OpenAI-compatible usage, including cached and reasoning tokens', () => {
    expect(chatUsage({
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 40 } },
      choices: [{ finish_reason: 'length' }],
    })).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 1024, reasoningTokens: 40, finishReason: 'length' });
  });
});

describe('executeAICall metering', () => {
  it('records every provider attempt: the failed primary and the fallback that answered', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk-test';
    delete process.env.OPENAI_CHAT_MODEL;
    delete process.env.GROQ_CHAT_MODEL;
    const log = new PipelineLog('run');

    const result = await withPipelineLog(log, () => executeAICall('chat', async ({ provider, reportUsage }) => {
      if (provider === 'openai') {
        reportUsage?.({ inputTokens: 100 });
        throw Object.assign(new Error('Rate limit reached'), { status: 429 });
      }
      reportUsage?.(chatUsage({ usage: { prompt_tokens: 1000, completion_tokens: 200 }, choices: [{ finish_reason: 'stop' }] }));
      return 'ok';
    }, { operation: 'place_extraction', promptHash: 'abc123' }));

    expect(result).toBe('ok');
    expect(log.calls).toHaveLength(2);
    expect(log.calls[0]).toMatchObject({
      operation: 'place_extraction', provider: 'openai', model: 'gpt-4o', status: 'error',
      attempt: 1, isFallback: false, httpStatus: 429, inputTokens: 100, promptHash: 'abc123', error: 'Rate limit reached',
    });
    // Tokens reported before the failure are billed, so they are priced.
    expect(log.calls[0].costUsd).toBeCloseTo(0.00025, 8);
    expect(log.calls[1]).toMatchObject({
      provider: 'groq', status: 'success', attempt: 2, isFallback: true,
      inputTokens: 1000, outputTokens: 200, totalTokens: 1200, finishReason: 'stop',
      costUsd: null, costSource: null,
    });
  });

  it('records nothing outside a pipeline run', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    await expect(executeAICall('chat', async () => 'ok')).resolves.toBe('ok');
    const log = new PipelineLog('unused');
    logCall({ stage: 'model', operation: 'x', provider: 'openai', status: 'success' });
    expect(log.calls).toHaveLength(0);
  });
});

describe('stage timing', () => {
  it('records status, item counts and duration on the current run', async () => {
    const log = new PipelineLog('run');
    await withPipelineLog(log, async () => {
      const end = startStage('vision_ocr', 'glm');
      await new Promise((resolve) => setTimeout(resolve, 5));
      end('partial', { itemsIn: 12, itemsOut: 7, error: 'x'.repeat(5_000) });
    });
    expect(log.stages).toHaveLength(1);
    expect(log.stages[0]).toMatchObject({ stage: 'vision_ocr', provider: 'glm', status: 'partial', itemsIn: 12, itemsOut: 7 });
    expect(log.stages[0].durationMs).toBeGreaterThanOrEqual(4);
    expect(log.stages[0].error!.length).toBeLessThanOrEqual(1_001);
  });
});

describe('candidate outcomes', () => {
  it('reason codes are stable slugs', () => {
    expect(reasonCode('low evidence score 0.32')).toBe('low_evidence_score');
    expect(reasonCode('role:background')).toBe('role_background');
    expect(reasonCode('name not found in evidence')).toBe('name_not_found_in_evidence');
    expect(reasonCode(null)).toBeNull();
  });

  it('logs rejected candidates with their reason and model fields, and remembers the accepting pass', async () => {
    const content = makeContent({ caption: 'Best tacos in town at Taqueria El Sol 🌮', hashtags: ['austin'], videoUrl: '', contentType: 'post' });
    const bundle = buildEvidence(content, {});
    const log = new PipelineLog('run');

    const outcome = await withPipelineLog(log, () => finalizeCandidates([
      candidate({ name: 'Taqueria El Sol', city: 'Austin', name_evidence: ['C1'], location_evidence: ['H1'] }),
      candidate({ name: 'Imaginary Bistro', city: 'Austin', name_evidence: ['C1'], category: 'RESTAURANTS' }),
      candidate({ name: 'Coca-Cola', role: 'background', name_evidence: ['C1'] }),
    ] as unknown as Parameters<typeof finalizeCandidates>[0], bundle, content.authorUsername, { pass: 'recovery', resolveIndirect: false }));

    expect(outcome.places.map((place) => place.name)).toEqual(['Taqueria El Sol']);
    expect(log.runPatch).toMatchObject({ candidates_count: 3, rejected_count: 2 });
    const rejected = Object.fromEntries(log.candidates.map((row) => [row.name, row]));
    expect(rejected['Imaginary Bistro']).toMatchObject({ pass: 'recovery', decision: 'rejected', reasonCode: 'name_not_found_in_evidence', category: 'RESTAURANTS', modelRole: 'featured' });
    expect(rejected['Coca-Cola']).toMatchObject({ decision: 'rejected', reasonCode: 'role_background', modelRole: 'background' });
    expect(log.acceptedPass.get('taqueriaelsol')).toBe('recovery');
  });
});

describe('ExtractionLogStore', () => {
  it('writes stages, calls, candidates and events in one batch per table, then clears the buffers', async () => {
    process.env.PIPELINE_LOG_DIR = os.tmpdir();
    const log = new PipelineLog('7687', { socialPostId: 'post-9' });
    log.extractionRunId = 'run-1';
    log.part = 'analysis';
    await withPipelineLog(log, async () => {
      startStage('extraction', 'combined')('success', { itemsIn: 5, itemsOut: 2 });
      logCall({ stage: 'model', operation: 'place_extraction', provider: 'openai', model: 'gpt-4o', status: 'success', inputTokens: 2000, outputTokens: 500 });
      log.addCandidate({ pass: 'primary', decision: 'rejected', reasonCode: 'generic_name', reason: 'generic name', name: 'this cafe' });
      log.setEvidence([{ id: 'B1', source: 'creator_bio', text: 'collabs: someone@example.com' }]);
      log.patch({ saved_count: 2 });
    });
    const { plog } = await import('../pipeline-log');
    await withPipelineLog(log, async () => plog('run', 'done'));

    await log.flush();

    const byTable: Record<string, Array<Record<string, any>>> = Object.fromEntries(db.inserts.map((insert) => [insert.table, insert.rows])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byTable.extraction_run_stages[0]).toMatchObject({ run_id: 'run-1', stage: 'extraction', provider: 'combined', status: 'success', items_in: 5, items_out: 2 });
    expect(byTable.extraction_run_calls[0]).toMatchObject({ run_id: 'run-1', provider: 'openai', input_tokens: 2000, output_tokens: 500, total_tokens: 2500, cost_source: 'price_table' });
    expect(byTable.extraction_run_calls[0].est_cost_usd).toBeCloseTo(0.01, 6);
    expect(byTable.extraction_candidates[0]).toMatchObject({ run_id: 'run-1', social_post_id: 'post-9', decision: 'rejected', reason_code: 'generic_name' });
    expect(byTable.extraction_run_logs[0]).toMatchObject({ run_id: 'run-1', part: 'analysis', event_count: 1 });
    expect(byTable.extraction_run_logs[0].evidence[0].text).toBe('collabs: [email]');
    expect(db.updates).toEqual([{ table: 'extraction_runs', fields: { saved_count: 2 }, id: 'run-1' }]);

    // A second flush adds nothing new.
    db.inserts.length = 0;
    db.updates.length = 0;
    await log.flush();
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('turns itself off, once, when the migration has not been applied', async () => {
    db.error = { code: '42P01', message: 'relation "public.extraction_runs" does not exist' };
    expect(await ExtractionLogStore.startRun({ inputUrl: 'https://www.instagram.com/p/x', route: 'stream' })).toBeNull();
    expect(ExtractionLogStore.enabled()).toBe(false);
    const insertsBefore = db.inserts.length;
    expect(await ExtractionLogStore.startRun({ inputUrl: 'https://www.instagram.com/p/y', route: 'stream' })).toBeNull();
    expect(db.inserts.length).toBe(insertsBefore);
    expect(await ExtractionLogStore.hasRun('post-1', 'legacy_recovery')).toBe(false);
  });

  it('can be disabled with PIPELINE_LOG_DB=off', async () => {
    process.env.PIPELINE_LOG_DB = 'off';
    expect(await ExtractionLogStore.startRun({ inputUrl: 'https://www.tiktok.com/@a/video/1', route: 'stream' })).toBeNull();
    expect(db.inserts).toHaveLength(0);
  });
});
