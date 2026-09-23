import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PipelineLog, currentPipelineLog, plog, withPipelineLog } from '../pipeline-log';
import { googleMapsUrl } from '../../maps-url';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PIPELINE_LOG_DIR;
});

describe('pipeline log', () => {
  it('records events for the current run only, across nested async calls', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = new PipelineLog('post-a');
    const b = new PipelineLog('post-b');
    const nested = async (label: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      plog('geocode', `lookup ${label}`, { label });
    };
    await Promise.all([
      withPipelineLog(a, () => nested('a')),
      withPipelineLog(b, () => nested('b')),
    ]);
    plog('run', 'outside any run');
    expect(a.events.map((e) => e.message)).toEqual(['lookup a']);
    expect(b.events.map((e) => e.message)).toEqual(['lookup b']);
    expect(a.events[0]).toMatchObject({ stage: 'geocode', level: 'info', data: { label: 'a' } });
    expect(currentPipelineLog()).toBeUndefined();
  });

  it('masks e-mail addresses (creator bios, comments) in messages and data', async () => {
    const log = new PipelineLog('post-c');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withPipelineLog(log, async () => plog('evidence', 'Bio for someone@example.com', { items: ['B1 creator_bio: 💌 sofie.w@gmail.com'] }));
    expect(log.events[0]).toMatchObject({ message: 'Bio for [email]', data: { items: ['B1 creator_bio: 💌 [email]'] } });
    expect(String(spy.mock.calls[0])).not.toContain('@gmail.com');
  });

  it('writes each run as one JSON line to the daily pipeline log file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plog-'));
    process.env.PIPELINE_LOG_DIR = dir;
    const log = new PipelineLog('7687242127117405471', { route: 'analyze' });
    await withPipelineLog(log, async () => plog('db', 'Not saved', { reason: 'no verified location' }, 'warn'));
    log.flush();
    const file = path.join(dir, `pipeline-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(entry).toMatchObject({ runId: '7687242127117405471', route: 'analyze' });
    expect(entry.events[0]).toMatchObject({ stage: 'db', level: 'warn', message: 'Not saved' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('googleMapsUrl', () => {
  it('opens the exact Google listing when the place id is known', () => {
    expect(googleMapsUrl({ latitude: 40.7331, longitude: -74.0045, google_place_id: 'ChIJabc' }))
      .toBe('https://www.google.com/maps/search/?api=1&query=40.7331%2C-74.0045&query_place_id=ChIJabc');
  });

  it('falls back to the verified coordinates, and returns null without them', () => {
    expect(googleMapsUrl({ latitude: 40.7331, longitude: -74.0045 }))
      .toBe('https://www.google.com/maps/search/?api=1&query=40.7331%2C-74.0045');
    expect(googleMapsUrl({ latitude: null, longitude: null })).toBeNull();
  });
});
