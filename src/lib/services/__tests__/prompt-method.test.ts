import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidate, makeContent, modelResponse, visionFrame } from './fixtures';

// Scripted model that records every request, including the output budget, so
// the tests can check what the extraction and vision prompts actually send.
const model = vi.hoisted(() => ({
  name: 'gpt-4o-mini',
  responses: [] as string[],
  calls: [] as Array<{ system: string; user: string; maxTokens: number }>,
}));

vi.mock('../ai-client', () => ({
  supportsTemperature: () => true,
  executeAICall: async (_task: string, fn: (config: unknown, reportUsage?: () => void) => Promise<unknown>) => fn({
    model: model.name,
    provider: 'openai',
    isGroq: false,
    client: {
      chat: {
        completions: {
          create: async (request: { max_completion_tokens: number; messages: Array<{ content: unknown }> }) => {
            const text = (content: unknown) => typeof content === 'string' ? content : JSON.stringify(content);
            model.calls.push({
              system: text(request.messages[0].content),
              user: text(request.messages[1].content),
              maxTokens: request.max_completion_tokens,
            });
            const content = model.responses.shift() ?? modelResponse([]);
            return { choices: [{ message: { content }, finish_reason: 'stop' }] };
          },
        },
      },
    },
  }, () => {}),
}));

import { AiEnrichmentService, countListEntries, countScreenCards, splitNameDescriptor } from '../ai-enrichment.service';
import { buildEvidence, formatEvidenceForPrompt } from '../place-evidence.service';
import { GptVisionOcrService } from '../gpt-vision-ocr.service';

beforeEach(() => {
  model.name = 'gpt-4o-mini';
  model.responses = [];
  model.calls = [];
});

// Real case: instagram.com/p/CnhbmdOu0wu, a 6-second reel whose caption lists
// 48 vegetarian restaurants under cuisine headings.
const NYC_CAPTION = [
  '🗽NYC VEGETARIAN FOOD GUIDE⬇️',
  "🗽We love NYC and did you know it's a haven for vegetarians because there are so many vegetarian friendly restaurants!",
  '‼️Remember to make reservations!',
  '🥡Asian:', 'Planta queen ', 'Soup kitchen-szechuan Chinese ', 'Beyond sushi ', 'Hangawi-korean',
  '🍕Pizza :', 'Double zero ', "Screamer's pizza", 'Coletta',
  '🫔Indian:', 'Gupshup', 'Tamarind Tribeca', 'Indian accent - children under 10 not allowed ', 'NY dosas - food cart',
  '☕️Cafe:', 'Angelina Paris ', 'Pret a Manger', 'Paris baguette',
  'Also let me know below if you want more content like this❤️', '.', '.',
].join('\n');

const nycReel = () => makeContent({
  authorUsername: 'thewickedvegetarian',
  authorFullName: 'RUNJHUN | Life & Style',
  caption: NYC_CAPTION,
  hashtags: ['vegetarianfoodguide', 'foodnyc'],
  videoDuration: 6,
});

const title = ['NYC', 'VEGETARIAN', 'FOOD GUIDE'];
const withScene = (frame: ReturnType<typeof visionFrame>, sceneTexts: string[]) => ({ ...frame, sceneTexts });

describe('extraction prompt method', () => {
  it('never asks a model for more output than it accepts', async () => {
    model.responses.push(modelResponse([]));
    await AiEnrichmentService.analyzeContent(makeContent({ caption: 'Kasama, Chicago' }), {}, {});
    expect(model.calls[0].maxTokens).toBeLessThanOrEqual(16_384);
  });

  it('walks the model through the steps and explains the line tags', async () => {
    await AiEnrichmentService.analyzeContent(makeContent({ caption: 'Kasama, Chicago' }), {}, {});
    const system = model.calls[0].system;
    for (const step of ['1. POST SHAPE', '2. LOCATION CONTEXT', '3. CANDIDATES', '4. FIELDS', '5. ROLE', '6. CHECK']) {
      expect(system).toContain(step);
    }
    expect(system).toContain('img=N');
    expect(system).toContain('scene = text physically in the filmed scene');
  });

  it('recovers a caption list the first answer missed, cleans the names, and ignores scene text (real reel)', async () => {
    const media = {
      visionFrames: [
        withScene(visionFrame(0, 0, [...title, 'THENOMADIC.COM', 'W 23 St']), ['W 23 St']),
        visionFrame(1, 1, title),
        visionFrame(2, 2, title),
        withScene(visionFrame(4, 4, ['NYC VEGETARIAN FOOD GUIDE', '1540 BROADWAY']), ['1540 BROADWAY']),
        withScene(visionFrame(6, 6, ['NYC VEGETARIAN FOOD GUIDE', 'ANGELINA Paris since 1903']), ['ANGELINA Paris since 1903']),
      ],
    };
    const place = (name: string) => candidate({ name, role: 'recommended', city: 'New York', location_evidence: ['C1'] });
    // First answer: only the venue that is also on screen, as in the logged run.
    model.responses.push(modelResponse([place('Angelina Paris')]));
    model.responses.push(JSON.stringify({ places: [
      place('Planta queen'), place('Soup kitchen-szechuan Chinese'), place('Beyond sushi'), place('Hangawi-korean'),
      place('Double zero'), place("Screamer's pizza"), place('Coletta'), place('Gupshup'), place('Tamarind Tribeca'),
      place('Indian accent - children under 10 not allowed'), place('NY dosas - food cart'),
      place('Angelina Paris'), place('Pret a Manger'), place('Paris baguette'),
    ] }));

    const result = await AiEnrichmentService.analyzeContent(nycReel(), {}, media);

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0].user).toMatch(/V\d+ on_screen_hq\(t=0s scene\): W 23 St/);
    expect(model.calls[1].user).toContain('14 list line(s) and 0 slide/scene label(s), but only 1 place(s) were returned');
    const names = result!.places.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining([
      'Angelina Paris', 'Planta queen', 'Soup kitchen', 'Hangawi', 'Indian accent', 'NY dosas', 'Tamarind Tribeca',
    ]));
    expect(names).toHaveLength(14);
    expect(names.some((name) => /23 St|NOMADIC|BROADWAY/i.test(name || ''))).toBe(false);
    expect(result!.places.every((p) => p.city === 'New York' && !p.address)).toBe(true);
    expect(result!.places.find((p) => p.name === 'Hangawi')?.description).toBe('korean');
  });

  it('frames without scene labels: street signs, web addresses and stray signs are not venue cards', async () => {
    const media = {
      visionFrames: [
        visionFrame(0, 0, [...title, 'W 23 St']),
        visionFrame(1, 1, [...title, 'W 23 St', 'thenomadic.com', 'LUXURY', 'SERVICES']),
        visionFrame(2, 2, title),
        visionFrame(3, 3, title),
        visionFrame(6, 6, [...title, 'ANGELINA', 'Paris depuis 1903']),
      ],
    };
    const result = await AiEnrichmentService.analyzeContent(nycReel(), {}, media);
    expect(result!.places.map((p) => p.name)).toEqual([]);
  });

  it('does not run a second call when the list was fully returned', async () => {
    const names = ['Planta queen', 'Beyond sushi', 'Double zero', 'Coletta', 'Gupshup', 'Tamarind Tribeca', 'Pret a Manger', 'Paris baguette', 'Angelina Paris', "Screamer's pizza", 'Hangawi'];
    model.responses.push(modelResponse(names.map((name) => candidate({ name, role: 'recommended', city: 'New York' }))));
    await AiEnrichmentService.analyzeContent(nycReel(), {}, {});
    expect(model.calls).toHaveLength(1);
  });
});

describe('name descriptors', () => {
  it.each([
    ['Hangawi-korean', 'Hangawi', 'korean'],
    ['Soup kitchen-szechuan Chinese', 'Soup kitchen', 'szechuan Chinese'],
    ['Uptown thai- Thai', 'Uptown thai', 'Thai'],
    ['Sarvana Bhavan-South Indian', 'Sarvana Bhavan', 'South Indian'],
    ['NY dosas - food cart', 'NY dosas', 'food cart'],
    ['Junoon- children under 10 not allowed', 'Junoon', 'children under 10 not allowed'],
    ["Mama's (Vegan)", "Mama's", 'Vegan'],
  ])('moves the descriptor out of "%s"', (raw, name, note) => {
    expect(splitNameDescriptor(raw)).toEqual({ name, note });
  });

  it.each(['Jean-Georges', 'Canto - West Village', 'Wa-Jeal', 'Pret a Manger', 'Franchia vegan', 'Tamarind Tribeca'])(
    'leaves "%s" alone', (raw) => {
      expect(splitNameDescriptor(raw)).toEqual({ name: raw, note: '' });
    },
  );
});

describe('list entries', () => {
  it('counts entries under headings and bulleted lines, not prose', () => {
    // 4 Asian + 3 Pizza + 4 Indian + 3 Cafe; the title and the sentences are not entries.
    expect(countListEntries([NYC_CAPTION])).toBe(14);
    expect(countListEntries(['Best 3 spots:\n1. Kasama\n2. Avec\n3. Girl & The Goat'])).toBe(3);
    expect(countListEntries(['Had the best brunch today! The pancakes were unreal.\nWill be back soon.'])).toBe(0);
    expect(countListEntries(['Sunday vibes\nCoffee first'])).toBe(0);
  });
});

describe('slide and scene labels', () => {
  it('counts one label per venue card, ignoring a title read on only some slides (real Ahmedabad carousel)', () => {
    const brand = 'SWAGATAM AMDAVAD';
    expect(countScreenCards([
      visionFrame(0, 0, [brand, 'MOST POPULAR', 'DINING SPOTS', 'IN AHMEDABAD']),
      visionFrame(1, 0, [brand, 'MAUVE', 'Sindhu Bhavan']),
      visionFrame(2, 0, [brand, 'RUNGG PREMIUM DINING', 'NehruNagar']),
      visionFrame(3, 0, [brand, 'PEP HOUSE', 'Thaltej']),
      visionFrame(4, 0, ['THE PRIMO BY', 'MANN & SALWA', 'Ambli']),
      visionFrame(5, 0, ['PATANG', 'Ellisbridge']),
      visionFrame(6, 0, ['@MANGO', 'Thaltej']),
      visionFrame(7, 0, ['UNDER THE NEEM', 'TREES', 'Bodakdev']),
      visionFrame(8, 0, [brand, 'LAUREL', 'Ambli']),
    ])).toBe(8);
  });

  it('does not count scene text, web addresses, street signs or the guide cover', () => {
    expect(countScreenCards([
      withScene(visionFrame(0, 0, [...title, 'THENOMADIC.COM', 'W 23 St']), ['W 23 St']),
      visionFrame(1, 1, title),
      visionFrame(2, 2, title),
      withScene(visionFrame(4, 4, ['NYC VEGETARIAN FOOD GUIDE', '1540 BROADWAY']), ['1540 BROADWAY']),
      withScene(visionFrame(6, 6, ['NYC VEGETARIAN FOOD GUIDE', 'ANGELINA Paris since 1903']), ['ANGELINA Paris since 1903']),
    ])).toBe(0);
  });

  it('counts a card once however many frames it stays on screen', () => {
    expect(countScreenCards([
      visionFrame(0, 0, ['📍 Buvette · 42 Grove St']),
      visionFrame(1, 1, ['📍 Buvette · 42 Grove St']),
      visionFrame(2, 2, ['📍 Morandi']),
    ])).toBe(2);
  });
});

describe('evidence tags', () => {
  it('numbers carousel slides so text on one slide can be paired', () => {
    const bundle = buildEvidence(makeContent({ contentType: 'post', videoUrl: '' }), {
      visionFrames: [visionFrame(0, 0, ['📍 Theodora']), visionFrame(1, 0, ['Mei Lah Wah', '88 E Broadway'])],
    });
    const prompt = formatEvidenceForPrompt(bundle);
    expect(prompt).toContain('V1 on_screen_hq(img=1): 📍 Theodora');
    expect(prompt).toContain('V2 on_screen_hq(img=2): Mei Lah Wah');
    expect(prompt).toContain('V3 on_screen_hq(img=2): 88 E Broadway');
  });

  it('marks a line as scene text only when every labelled sighting was scene text', () => {
    const bundle = buildEvidence(makeContent(), {
      visionFrames: [
        withScene(visionFrame(0, 0, ['Buvette', 'W 23 St']), ['W 23 St']),
        withScene(visionFrame(1, 1, ['Buvette']), ['Buvette']),
      ],
    });
    const byText = new Map(bundle.items.map((item) => [item.text, item]));
    expect(byText.get('W 23 St')?.scene).toBe(true);
    expect(byText.get('Buvette')?.scene).toBeUndefined();
  });
});

describe('vision OCR scene labels', () => {
  it('keeps only scene strings that were also transcribed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
    const file = path.join(dir, 'frame.jpg');
    fs.writeFileSync(file, 'not-a-real-image');
    model.name = 'gpt-4o';
    model.responses.push(JSON.stringify({ images: [{
      index: 0,
      texts: ['NYC VEGETARIAN FOOD GUIDE', 'W 23 St'],
      scene: ['w 23 st', 'Invented Sign'],
    }] }));
    try {
      const [frame] = await GptVisionOcrService.extractTextFromFramesBatched([
        { frameIndex: 0, timestamp: 0, filePath: file, hash: 'test' },
      ]);
      expect(frame.texts).toEqual(['NYC VEGETARIAN FOOD GUIDE', 'W 23 St']);
      expect(frame.sceneTexts).toEqual(['W 23 St']);
      expect(model.calls[0].system).toContain('"scene"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
