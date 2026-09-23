import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidate, makeContent, modelResponse, visionFrame } from './fixtures';

// Scripted model (same approach as extraction-patterns.test.ts).
const model = vi.hoisted(() => ({ responses: [] as string[], calls: [] as Array<{ user: string }> }));
vi.mock('../ai-client', () => ({
  supportsTemperature: () => true,
  executeAICall: async (_task: string, fn: (config: unknown) => Promise<unknown>) => fn({
    model: 'test-model', provider: 'openai', isGroq: false,
    client: {
      chat: {
        completions: {
          create: async (request: { messages: Array<{ content: string }> }) => {
            model.calls.push({ user: request.messages[1].content });
            const content = model.responses.shift() ?? modelResponse([]);
            return { choices: [{ message: { content }, finish_reason: 'stop' }] };
          },
        },
      },
    },
  }),
}));

import { AiEnrichmentService } from '../ai-enrichment.service';

// Real case: a 10-slide "72 hours in NYC" guide (instagram.com/p/DclmlT_DpJD).
const guide = (extra: Parameters<typeof makeContent>[0] = {}) => makeContent({
  contentType: 'post',
  videoUrl: '',
  caption: 'the perfect 72 hours in NYC\nDay 2 - Evening plans\n@brasseriecognac',
  locationTag: { name: 'New York City', id: '1' },
  accounts: [
    { username: 'brasseriecognac', fullName: 'Brasserie Cognac', relation: 'tagged' },
    { username: 'nytimes', fullName: 'The New York Times', relation: 'tagged' },
    { username: 'lindustriebk', fullName: "L'industrie Pizzeria ™️", relation: 'tagged' },
  ],
  ...extra,
});

async function extract(content: ReturnType<typeof makeContent>, media: Parameters<typeof AiEnrichmentService.analyzeContent>[2], places: unknown[]) {
  model.responses.push(modelResponse(places));
  return (await AiEnrichmentService.analyzeContent(content, {}, media))!;
}

beforeEach(() => {
  model.responses.length = 0;
  model.calls.length = 0;
});

describe('address counting', () => {
  it('counts the same address read by two OCR engines once', () => {
    expect(AiEnrichmentService.countDistinctSourceAddresses([
      'Market Bar · 1207 Nostrand Ave, Brooklyn, NY', 'Market Bar 1207 Nostrand',
      'Paul’s · 283 Nostrand Ave, Brooklyn, NY', 'Pauls 283 Nostrand Ave',
      'Sip-N-Chat Lounge · 2910 Avenue D, Brooklyn, NY',
    ])).toBe(3);
  });
});

describe('guide carousels', () => {
  it('keeps list entries on slides even when other places carry pins', async () => {
    const media = {
      visionFrames: [
        visionFrame(0, 0, ['📍 Theodora', 'DAY 1 - CHINATOWN', 'Mei Lah Wah', 'Hay Hay Roasted']),
        visionFrame(1, 0, ['📍 Into Archive']),
      ],
    };
    const { places } = await extract(guide(), media, [
      candidate({ name: 'Theodora', city: 'New York', name_evidence: ['V1'] }),
      candidate({ name: 'Into Archive', city: 'New York', base_category: 'SHOPPING', category: 'SHOPPING', name_evidence: ['V5'] }),
      candidate({ name: 'Mei Lah Wah', city: 'New York', name_evidence: ['V3'] }),
      candidate({ name: 'Hay Hay Roasted', city: 'New York', name_evidence: ['V4'] }),
    ]);
    expect(places.map((p) => p.name)).toEqual(['Theodora', 'Into Archive', 'Mei Lah Wah', 'Hay Hay Roasted']);
  });

  it('never discards a tagged place as "mentioned only"', async () => {
    const { places } = await extract(guide(), {}, [
      candidate({ name: 'Brasserie Cognac', role: 'mentioned_only', city: 'New York', name_evidence: ['C3', 'A1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0].role).toBe('recommended');
  });

  it('does not use account display names as location evidence, and strips ™️ from names', async () => {
    const { places } = await extract(guide(), {}, [
      candidate({ name: "L'industrie Pizzeria ™️", city: 'New York', name_evidence: ['A3'] }),
    ]);
    expect(places[0].name).toBe("L'industrie Pizzeria");
    const accountIds = ['A1', 'A2', 'A3'];
    expect(places[0].location_evidence_ids?.some((id) => accountIds.includes(id))).toBe(false);
    expect(places[0].explanation).not.toContain('@nytimes');
  });

  it('runs a recovery pass when the evidence marks more locations than were returned', async () => {
    const media = { visionFrames: [visionFrame(0, 0, ['📍 Vowels', '📍 Zemeta', '📍 Hauteline'])] };
    const shop = (name: string, id: string) => candidate({ name, city: 'New York', base_category: 'SHOPPING', category: 'SHOPPING', name_evidence: [id] });
    model.responses.push(modelResponse([shop('Vowels', 'V1')]));
    model.responses.push(JSON.stringify({ places: [shop('Vowels', 'V1'), shop('Zemeta', 'V2'), shop('Hauteline', 'V3')] }));
    const result = await AiEnrichmentService.analyzeContent(guide(), {}, media);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].user).toContain('CHECK: the evidence marks 3 location(s) with 📍');
    expect(result!.places.map((p) => p.name)).toEqual(['Vowels', 'Zemeta', 'Hauteline']);
  });
});
