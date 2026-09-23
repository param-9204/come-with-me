import { describe, expect, it } from 'vitest';
import {
  bestCasing, buildEvidence, hasLocationMarker, normalizeLocationMarker, combineSupport, formatEvidenceForPrompt, itemSupportsName, reconcileCategoryWithGoogle,
  sameEntity, categoryFromGoogleType,
} from '../place-evidence.service';
import type { EvidenceItem, PlaceExtraction } from '../../types/social';
import { makeContent, ocrFrame, speech, visionFrame } from './fixtures';

const place = (overrides: Partial<PlaceExtraction>): PlaceExtraction => ({
  name: '', city: '', neighborhood: '', address: '', category: 'RESTAURANTS', description: '', creator_handle: '', confidence: 0.5,
  ...overrides,
});

describe('buildEvidence', () => {
  const content = makeContent({
    caption: 'Friday crawl 🍸\n#philly #cocktails',
    hashtags: ['philly', 'cocktails'],
    accounts: [{ username: 'hopsingphl', fullName: 'Hop Sing Laundromat', relation: 'tagged' }],
  });
  const bundle = buildEvidence(content, {
    ocrFrames: [
      ocrFrame(0, 1, [['@phillyfoodie', 0.95], ['Follow', 0.9], ['HOP SING', 0.8]]),
      ocrFrame(1, 4, [['HOP SlNG', 0.62], ['blurry', 0.3]]),
    ],
    visionFrames: [visionFrame(1, 4, ['Hop Sing Laundromat'])],
    transcript: speech([[2, 5, 'first stop Hop Sing']]),
  });

  it('numbers each source and keeps hashtag-only caption lines out of the caption', () => {
    expect(bundle.items.map((item) => item.id)).toEqual(['C1', 'A1', 'O1', 'V1', 'S1', 'H1']);
    expect(bundle.byId.get('C1')?.text).toBe('Friday crawl 🍸');
  });

  it('removes platform UI text and the creator watermark, and drops low-confidence OCR', () => {
    const ocr = bundle.items.filter((item) => item.source === 'ocr');
    expect(ocr).toHaveLength(1);
    // "HOP SING" and the OCR typo "HOP SlNG" are one line seen at 1s and 4s.
    expect(ocr[0]).toMatchObject({ text: 'HOP SING', timestamps: [1, 4] });
    expect(ocr[0].weight).toBeCloseTo(0.64, 2);
  });

  it('marks what is present and what is missing', () => {
    expect(bundle.availability).toMatchObject({ caption: 'yes', location_tag: 'none', accounts: '1', speech: '1 segments (whisper)' });
  });

  it('formats compact prompt lines with timestamps and exclusions', () => {
    const prompt = formatEvidenceForPrompt(bundle);
    expect(prompt).toContain('NOT PLACES: creator @phillyfoodie / "Sam Eats"');
    expect(prompt).toContain('O1 on_screen(t=1s,4s ocr_conf=0.64): HOP SING');
    expect(prompt).toContain('S1 speech(2-5s): first stop Hop Sing');
    expect(prompt).toContain('A1 account(tagged): @hopsingphl "Hop Sing Laundromat"');
  });
});

describe('name support', () => {
  const item = (source: EvidenceItem['source'], text: string, extra: Partial<EvidenceItem> = {}): EvidenceItem =>
    ({ id: 'X1', source, text, weight: 0.5, ...extra });

  it('matches whole phrases, not substrings of other words', () => {
    expect(itemSupportsName('Ova', item('caption', 'a standing ovation'))).toBe(false);
    expect(itemSupportsName('Ova', item('caption', 'dinner at Ova tonight'))).toBe(true);
  });

  it('matches handles and hashtags written without spaces', () => {
    expect(itemSupportsName("Joe's Pizza", item('hashtags', '#joespizza #nyc'))).toBe(true);
    expect(itemSupportsName("Joe's Pizza", item('account', '', { username: 'joespizzanyc', displayName: '' }))).toBe(true);
  });

  it('tolerates small OCR errors but not different names', () => {
    expect(itemSupportsName('Girl & The Goat', item('ocr', 'GIRL & THE GOAT'))).toBe(true);
    expect(itemSupportsName('Kasama', item('ocr', 'KASAMA'))).toBe(true);
    expect(itemSupportsName('Pizzeria Beddia', item('ocr', 'PIZZERIA BEDDLA'))).toBe(true);
    expect(itemSupportsName('Pizzeria Beddia', item('ocr', 'PIZZERIA STELLA'))).toBe(false);
  });

  it('combines independent sources with noisy-OR, counting each source once', () => {
    const ocrA = item('ocr', 'x', { weight: 0.5 });
    const ocrB = item('vision_ocr', 'x', { weight: 0.65 });
    const tagged = item('account', 'x', { weight: 0.75 });
    expect(combineSupport([ocrA, ocrB])).toBeCloseTo(0.65, 5);
    expect(combineSupport([ocrB, tagged])).toBeCloseTo(1 - 0.35 * 0.25, 5);
  });
});

describe('sameEntity', () => {
  it('merges spelling variants and handles within the same city', () => {
    expect(sameEntity(place({ name: "Joe's Pizza", city: 'New York' }), place({ name: 'joespizzanyc', city: '' }))).toBe(true);
    expect(sameEntity(place({ name: 'Cafe Lumiere' }), place({ name: 'Café Lumière' }))).toBe(true);
  });

  it('keeps branches and same-name places in other cities apart', () => {
    expect(sameEntity(place({ name: 'Shake Shack', address: '691 8th Ave' }), place({ name: 'Shake Shack', address: '366 Columbus Ave' }))).toBe(false);
    expect(sameEntity(place({ name: 'Blue Bottle', city: 'New York' }), place({ name: 'Blue Bottle', city: 'San Francisco' }))).toBe(false);
  });
});

describe('category', () => {
  it('maps Google place types', () => {
    expect(categoryFromGoogleType('cocktail_bar')).toBe('BARS');
    expect(categoryFromGoogleType('coffee_shop')).toBe('COFFEE');
    expect(categoryFromGoogleType('ramen_restaurant')).toBe('RESTAURANTS');
    expect(categoryFromGoogleType('clothing_store')).toBe('SHOPPING');
    expect(categoryFromGoogleType('ice_cream_shop')).toBeNull();
    expect(categoryFromGoogleType('tourist_attraction')).toBeNull();
  });

  it('lets Google decide venue type but keeps experience categories', () => {
    expect(reconcileCategoryWithGoogle('COFFEE', 'bar', ['bar', 'point_of_interest'])).toBe('BARS');
    expect(reconcileCategoryWithGoogle('NATURE', 'italian_restaurant', ['restaurant'])).toBe('RESTAURANTS');
    expect(reconcileCategoryWithGoogle('BARS', 'restaurant', ['restaurant', 'bar'])).toBe('BARS');
    expect(reconcileCategoryWithGoogle('CULTURE', 'park', ['park'])).toBe('CULTURE');
    expect(reconcileCategoryWithGoogle('HIDDEN GEMS', 'cafe', ['cafe'])).toBe('HIDDEN GEMS');
    expect(reconcileCategoryWithGoogle('CITY', 'tourist_attraction', [])).toBe('CITY');
  });
});

describe('screen text hygiene and casing', () => {
  it('drops prose (book pages, menus) but keeps sign-length lines', () => {
    const page = 'William had been murdered. As I could not pass through the town, I was obliged to cross the lake in a boat';
    const bundle = buildEvidence(makeContent(), { visionFrames: [visionFrame(0, 1, [page, 'Livraria Bertrand'])] });
    expect(bundle.items.map((item) => item.text)).toEqual(['Livraria Bertrand']);
  });

  it('prefers a mixed-case spelling from the evidence, otherwise title case', () => {
    const items = [
      { id: 'O1', source: 'ocr' as const, text: 'LUCALI', weight: 0.6 },
      { id: 'C1', source: 'caption' as const, text: 'dinner at Lucali tonight', weight: 0.7 },
    ];
    expect(bestCasing('LUCALI', items)).toBe('Lucali');
    expect(bestCasing('the twisted spine', [])).toBe('The Twisted Spine');
    expect(bestCasing("DALESSANDRO'S STEAKS", [])).toBe("Dalessandro's Steaks");
    expect(bestCasing('joespizzanyc', [])).toBe('joespizzanyc');
    expect(bestCasing('Café Lumière', [])).toBe('Café Lumière');
  });
});

describe('location markers (every pin style)', () => {
  it('recognises emoji pins, map-pin glyphs, text labels and trailing pins', () => {
    for (const line of ['📍 Buvette', '📌 Buvette', '🗺️ Buvette', '🧭 Buvette', '🚩 Buvette', '⚲ Buvette', '📍: Buvette', 'Location: Buvette', 'LOCATION - Buvette', 'Address: 42 Grove St', 'located at Buvette', 'Buvette 📍']) {
      expect({ line, marked: hasLocationMarker(line), normalized: normalizeLocationMarker(line) })
        .toMatchObject({ marked: true, normalized: expect.stringMatching(/^📍 /) });
    }
    expect(normalizeLocationMarker('Address: 42 Grove St')).toBe('📍 42 Grove St');
    expect(normalizeLocationMarker('Buvette 🗺️')).toBe('📍 Buvette');
  });

  it('leaves ordinary text alone', () => {
    for (const line of ['5 cozy restaurants in the west village', 'where are we going?', 'best spot ever', 'Buvette']) {
      expect(hasLocationMarker(line)).toBe(false);
      expect(normalizeLocationMarker(line)).toBe(line);
    }
  });

  it('normalises markers in captions, OCR and vision text before extraction', () => {
    const bundle = buildEvidence(makeContent({ caption: 'fall list\n📌 Buvette · 42 Grove St' }), {
      ocrFrames: [ocrFrame(0, 1, [['Location: Morandi', 0.9]])],
      visionFrames: [visionFrame(1, 2, ['🗺️ Canto West Village'])],
    });
    expect(bundle.items.map((item) => item.text)).toEqual([
      'fall list', '📍 Buvette · 42 Grove St', '📍 Morandi', '📍 Canto West Village',
    ]);
  });
});
