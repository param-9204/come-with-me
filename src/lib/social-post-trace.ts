import 'server-only';

import { supabaseAdmin } from '@/lib/supabase';

type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const numeric = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;

function find(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 7 || value === null || value === undefined) return null;
  if (Array.isArray(value)) for (const item of value) { const found = find(item, keys, depth + 1); if (found !== null) return found; }
  const item = record(value);
  for (const key of keys) if (item[key] !== null && item[key] !== undefined) return item[key];
  for (const child of Object.values(item)) { const found = find(child, keys, depth + 1); if (found !== null) return found; }
  return null;
}

function location(value: unknown, depth = 0): Data | null {
  if (depth > 7 || value === null || value === undefined) return null;
  if (Array.isArray(value)) for (const item of value) { const found = location(item, depth + 1); if (found) return found; }
  const item = record(value);
  if (numeric(item.latitude ?? item.lat) !== null || numeric(item.longitude ?? item.lng ?? item.lon) !== null) return item;
  for (const child of Object.values(item)) { const found = location(child, depth + 1); if (found) return found; }
  return null;
}

function parsedTrace(value: unknown): Data {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function traceView(value: unknown) {
  const trace = parsedTrace(value);
  const place = location(trace) || {};
  const transcript = text(find(trace, ['whisper_transcript', 'transcript', 'audio_transcript', 'text'])) || null;
  const ocr = text(find(trace, ['ocr_combined_text', 'ocr_text', 'ocrText', 'detected_text'])) || null;
  const categories = find(trace, ['secondary_categories', 'categories']);
  return {
    available: Object.keys(trace).length > 0,
    video: {
      duration: numeric(find(trace, ['video_duration', 'duration_seconds', 'duration'])),
      width: numeric(find(trace, ['dimensions_width', 'width'])),
      height: numeric(find(trace, ['dimensions_height', 'height'])),
      url: text(find(trace, ['video_url', 'videoUrl'])),
    },
    audio: {
      transcript,
      language: text(find(trace, ['transcript_language', 'language', 'detected_language'])),
      duration: numeric(find(trace, ['audio_seconds', 'audio_duration', 'duration_seconds'])),
      source: text(find(trace, ['transcript_source', 'audio_source', 'provider'])),
    },
    ocr: { text: ocr, frames: numeric(find(trace, ['ocr_frames', 'frame_count', 'frames_processed'])) },
    enrichment: {
      summary: text(find(trace, ['content_summary', 'summary'])),
      primary_category: text(find(trace, ['primary_category', 'category'])),
      categories: Array.isArray(categories) ? categories.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [],
      fine_tuning: text(find(trace, ['fine_tuning', 'fineTuning', 'guardrail', 'category_guardrail'])),
    },
    location: {
      name: text(place.name ?? place.location_name ?? place.title),
      address: text(place.address ?? place.formatted_address),
      latitude: numeric(place.latitude ?? place.lat),
      longitude: numeric(place.longitude ?? place.lng ?? place.lon),
    },
  };
}

export async function getSocialPostTrace(shortCode: string) {
  let lastError: { message?: string } | null = null;
  for (const args of [{ source_code: shortCode }, { short_code: shortCode }, { p_short_code: shortCode }, { code: shortCode }]) {
    const result = await supabaseAdmin.rpc('get_social_post_trace', args);
    if (!result.error) return { trace: traceView(result.data), raw: parsedTrace(result.data), error: null };
    lastError = result.error;
  }
  return { trace: { available: false }, raw: {}, error: lastError?.message || 'Trace data could not be loaded' };
}
