import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidate, makeContent, modelResponse, ocrFrame, speech, visionFrame } from './fixtures';

// Scripted model: each test queues the JSON the model "returns" and can
// inspect the evidence prompt it was sent.
const model = vi.hoisted(() => ({
  responses: [] as string[],
  errors: [] as Error[],
  calls: [] as Array<{ system: string; user: string }>,
}));

vi.mock('../ai-client', () => ({
  supportsTemperature: () => true,
  executeAICall: async (_task: string, fn: (config: unknown, reportUsage?: () => void) => Promise<unknown>) => fn({
    model: 'test-model',
    provider: 'openai',
    isGroq: false,
    client: {
      chat: {
        completions: {
          create: async (request: { messages: Array<{ content: string }> }) => {
            model.calls.push({ system: request.messages[0].content, user: request.messages[1].content });
            const error = model.errors.shift();
            if (error) throw error;
            const content = model.responses.shift() ?? modelResponse([]);
            return { choices: [{ message: { content }, finish_reason: 'stop' }] };
          },
        },
      },
    },
  }, () => {}),
}));

import { AiEnrichmentService } from '../ai-enrichment.service';
import { LocationService } from '../location.service';

async function extract(content: ReturnType<typeof makeContent>, media: Parameters<typeof AiEnrichmentService.analyzeContent>[2], places: unknown[]) {
  model.responses.push(modelResponse(places));
  const result = await AiEnrichmentService.analyzeContent(content, {}, media);
  return result!;
}

beforeEach(() => {
  model.responses.length = 0;
  model.errors.length = 0;
  model.calls.length = 0;
  vi.restoreAllMocks();
});

describe('place found in a single source', () => {
  it('caption only', async () => {
    const content = makeContent({ caption: 'Best tacos in town at Taqueria El Sol 🌮', hashtags: ['austin'], videoUrl: '' , contentType: 'post' });
    const { places } = await extract(content, {}, [
      candidate({ name: 'Taqueria El Sol', city: 'Austin', name_evidence: ['C1'], location_evidence: ['H1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Taqueria El Sol', city: 'Austin', evidence_sources: ['caption'] });
    expect(places[0].explanation).toBe('Name found in the caption; location from the hashtags.');
  });

  it('keeps an explicitly stated city but rejects a founding year mistaken for an address', async () => {
    const content = makeContent({
      caption: 'Casa Carmen Winery is in West Grove, PA. Founded in 2017 by two brothers.',
      contentType: 'post',
      videoUrl: '',
    });
    const { places } = await extract(content, {}, [
      candidate({
        name: 'Casa Carmen Winery', city: 'West Grove', address: '2017 by Street',
        name_evidence: ['C1'], location_evidence: ['C1'],
      }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Casa Carmen Winery', city: 'West Grove', address: '' });
  });

  it('on-screen text only (caption says nothing), with the city from the location tag', async () => {
    const content = makeContent({
      caption: 'you HAVE to try this 😍',
      locationTag: { name: 'Brooklyn, New York', id: '1' },
    });
    const media = {
      ocrFrames: [
        ocrFrame(0, 3, [['LUCALI', 0.9]]),
        ocrFrame(1, 6, [['LUCALI', 0.88], ['575 Henry St', 0.8]]),
      ],
    };
    const { places } = await extract(content, media, [
      candidate({ name: 'Lucali', city: 'Brooklyn', address: '575 Henry St', name_evidence: ['O1'], location_evidence: ['L1', 'O2'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Lucali', city: 'New York', address: '575 Henry St', evidence_sources: ['ocr'] });
    expect(places[0].explanation).toContain('on-screen text (3s, 6s)');
    expect(places[0].explanation).toContain('location from the post location tag');
    // OCR seen in two frames (0.3 + 0.3×0.9 + 0.1, capped at 0.65) + grounded address (0.08).
    expect(places[0].confidence).toBeCloseTo(0.73, 2);
  });

  it('speech only', async () => {
    const content = makeContent({ caption: 'weekend vibes' });
    const media = { transcript: speech([[0, 3, 'okay we are at Pizzeria Beddia in Philly'], [3, 6, 'this is the best pie']]) };
    const { places } = await extract(content, media, [
      candidate({ name: 'Pizzeria Beddia', city: 'Philadelphia', name_evidence: ['S1'], location_evidence: ['S1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Pizzeria Beddia', city: 'Philadelphia', evidence_sources: ['speech'] });
    expect(places[0].explanation).toBe('Name found in speech (0s).');
  });

  it('tagged business account only (display name from the tag)', async () => {
    const content = makeContent({
      caption: 'date night ✨',
      accounts: [{ username: 'thegaslamphotel', fullName: 'The Gas Lamp Hotel', relation: 'tagged' }],
      locationTag: { name: 'Philadelphia, Pennsylvania', id: '2' },
    });
    const { places } = await extract(content, {}, [
      candidate({ name: 'The Gas Lamp Hotel', city: 'Philadelphia', base_category: 'TRAVEL', category: 'TRAVEL', name_evidence: ['A1'], location_evidence: ['L1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'The Gas Lamp Hotel', category: 'TRAVEL', evidence_sources: ['account'] });
    expect(places[0].explanation).toContain('tagged account @thegaslamphotel');
    expect(model.calls[0].user).toContain('A1 account(tagged): @thegaslamphotel "The Gas Lamp Hotel"');
  });

  it('platform location tag names the venue', async () => {
    const content = makeContent({ caption: 'late night slice 🍕', hashtags: ['nyc'], locationTag: { name: "Joe's Pizza", id: '3' } });
    const { places } = await extract(content, {}, [
      candidate({ name: "Joe's Pizza", city: 'New York', name_evidence: ['L1'], location_evidence: ['H1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: "Joe's Pizza", city: 'New York' });
    expect(places[0].evidence_sources).toContain('location_tag');
    expect(places[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("creator's own comment carries the location", async () => {
    const content = makeContent({
      caption: 'best matcha ever',
      comments: [{ text: '📍 Cha Cha Matcha, NoHo NYC', ownerUsername: 'phillyfoodie', isCreator: true, likes: 3 }],
    });
    const { places } = await extract(content, {}, [
      candidate({ name: 'Cha Cha Matcha', city: 'New York', neighborhood: 'NoHo', base_category: 'COFFEE', category: 'COFFEE', name_evidence: ['K1'], location_evidence: ['K1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Cha Cha Matcha', city: 'New York', neighborhood: 'NoHo', evidence_sources: ['comment_creator'] });
  });
});

describe('place found by combining sources', () => {
  it('name on screen + city in caption', async () => {
    const content = makeContent({ caption: "Philly's best cheesesteak? 🤔" });
    const media = { ocrFrames: [ocrFrame(0, 2, [["DALESSANDRO'S STEAKS", 0.8]])] };
    const { places } = await extract(content, media, [
      candidate({ name: "Dalessandro's Steaks", city: 'Philadelphia', name_evidence: ['O1'], location_evidence: ['C1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0].city).toBe('Philadelphia');
    expect(places[0].explanation).toBe('Name found in on-screen text (2s); location from the caption.');
  });

  it('name spoken + city from the location tag', async () => {
    const content = makeContent({ caption: 'sunday brunch', locationTag: { name: 'Boston, Massachusetts', id: '4' } });
    const media = { transcript: speech([[1, 4, 'we came to Tatte for brunch']]) };
    const { places } = await extract(content, media, [
      candidate({ name: 'Tatte', city: 'Boston', base_category: 'COFFEE', category: 'COFFEE', name_evidence: ['S1'], location_evidence: ['L1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Tatte', city: 'Boston' });
    expect(places[0].explanation).toBe('Name found in speech (1s); location from the post location tag.');
  });

  it('shop sign read only by the vision fallback', async () => {
    const content = makeContent({ caption: 'found this gem', locationTag: { name: 'Lisbon, Portugal', id: '5' } });
    const media = {
      ocrFrames: [ocrFrame(0, 4, [], { total: 7, confident: 1, meanConfidence: 41 })],
      visionFrames: [visionFrame(0, 4, ['Livraria Bertrand', 'Desde 1732'])],
    };
    const { places } = await extract(content, media, [
      candidate({ name: 'Livraria Bertrand', city: 'Lisbon', base_category: 'SHOPPING', category: 'SHOPPING', name_evidence: ['V1'], location_evidence: ['L1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Livraria Bertrand', city: 'Lisbon', evidence_sources: ['vision_ocr'] });
  });

  it('sign read as separate lines on one frame ("RADIO CITY" / "MUSIC HALL")', async () => {
    const content = makeContent({ caption: 'December in New York just feels different 🎄', locationTag: { name: 'New York, New York', id: '6' } });
    const media = { visionFrames: [visionFrame(3, 8, ['RADIO CITY', 'MUSIC HALL', 'December in New York'])] };
    const { places } = await extract(content, media, [
      candidate({ name: 'Radio City Music Hall', city: 'New York', base_category: 'CULTURE', category: 'CULTURE', name_evidence: ['V1', 'V2'], location_evidence: ['L1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Radio City Music Hall', city: 'New York', evidence_ids: ['V1', 'V2'] });
  });

  it('lowercase subtitle names get proper casing', async () => {
    const content = makeContent({ caption: 'best bookstore ever #newyorkcity', hashtags: ['newyorkcity'] });
    const media = { transcript: speech([[6, 8, 'We are going to the twisted spine.']]) };
    const { places } = await extract(content, media, [
      candidate({ name: 'the twisted spine', city: 'New York', base_category: 'SHOPPING', category: 'SHOPPING', name_evidence: ['S1'] }),
    ]);
    expect(places[0].name).toBe('The Twisted Spine');
  });

  it('pin-sticker list reel (real case: 5 West Village restaurants); a poster is not a place', async () => {
    const content = makeContent({
      platform: 'tiktok',
      caption: '5 restaurants in the West Village perfect for fall 🤎🍂  #nycfall #nyc #westvillage',
      hashtags: ['nycfall', 'nyc', 'westvillage'],
      musicInfo: { artist_name: 'Frank Sinatra', song_name: 'Autumn In New York', uses_original_audio: false, should_mute_audio: false, should_mute_audio_reason: '', audio_id: '1' },
    });
    const title = '5 cozy restaurants in the west village for fall';
    const media = {
      ocrFrames: [ocrFrame(0, 1, [['cozy restaurants in the', 0.92], ['west village for fall', 0.96]])],
      visionFrames: [
        visionFrame(1, 1.1, [title, 'LA DOLCE VITA']),
        visionFrame(2, 1.9, [title, '📍 Fellini Cucina']),
        visionFrame(4, 4.1, [title, '📍 Buvette']),
        visionFrame(5, 6.3, [title, '📍 Bar Pisellino']),
        visionFrame(7, 8.6, [title, '📍 Canto West Village']),
        visionFrame(8, 10, [title, '📍 Morandi']),
      ],
      transcript: speech([[0, 12, 'Autumn in New York, it spells the thrill of first nighting.']]),
    };
    const names = ['La Dolce Vita', 'Fellini Cucina', 'Buvette', 'Bar Pisellino', 'Canto West Village', 'Morandi'];
    const { places, rejected } = await extract(content, media, names.map((name) =>
      candidate({ name, city: 'New York', neighborhood: 'West Village', location_evidence: ['C1'] })
    ));
    expect(places.map((p) => p.name)).toEqual(names.slice(1));
    expect(places.every((p) => p.city === 'New York' && p.neighborhood === 'West Village')).toBe(true);
    expect(rejected).toContainEqual({ name: 'La Dolce Vita', reason: 'un-pinned screen text in a pin-labelled post' });
  });

  it('pins in different styles, each carrying the address on the sticker', async () => {
    const content = makeContent({ platform: 'tiktok', caption: 'date night spots 🍷 #westvillage #nyc', hashtags: ['westvillage', 'nyc'] });
    const media = {
      visionFrames: [
        visionFrame(0, 1, ['📌 Buvette · 42 Grove St']),
        visionFrame(1, 4, ['Location: Morandi · 211 Waverly Pl']),
      ],
    };
    const { places } = await extract(content, media, [
      candidate({ name: 'Buvette', city: 'New York', address: '42 Grove St', name_evidence: ['V1'], location_evidence: ['V1', 'H1'] }),
      candidate({ name: 'Morandi', city: 'New York', address: '211 Waverly Pl', name_evidence: ['V2'], location_evidence: ['V2', 'H1'] }),
    ]);
    expect(places.map((p) => [p.name, p.address])).toEqual([['Buvette', '42 Grove St'], ['Morandi', '211 Waverly Pl']]);
    expect(model.calls[0].user).toContain('V1 on_screen_hq(t=1s): 📍 Buvette · 42 Grove St');
    expect(model.calls[0].user).toContain('V2 on_screen_hq(t=4s): 📍 Morandi · 211 Waverly Pl');
  });

  it('pins that only name areas do not turn storefront signs into scenery', async () => {
    const content = makeContent({ caption: 'nyc brunch crawl', hashtags: ['nyc'] });
    const media = {
      visionFrames: [
        visionFrame(0, 1, ['📍 West Village', 'BUVETTE']),
        visionFrame(1, 5, ['📍 SoHo', 'BALTHAZAR']),
      ],
    };
    const { places } = await extract(content, media, [
      candidate({ name: 'Buvette', city: 'New York', neighborhood: 'West Village', name_evidence: ['V2'] }),
      candidate({ name: 'Balthazar', city: 'New York', neighborhood: 'SoHo', name_evidence: ['V4'] }),
    ]);
    expect(places.map((p) => p.name)).toEqual(['Buvette', 'Balthazar']);
  });

  it('list reel with several places; the city itself is context, not a place', async () => {
    const content = makeContent({ caption: '3 spots in Chicago 👇' });
    const media = {
      ocrFrames: [
        ocrFrame(0, 2, [['1. Au Cheval', 0.85]]),
        ocrFrame(1, 6, [['2. Girl & The Goat', 0.8]]),
        ocrFrame(2, 10, [['3. Kasama', 0.9]]),
      ],
    };
    const { places, rejected } = await extract(content, media, [
      candidate({ name: 'Au Cheval', city: 'Chicago', name_evidence: ['O1'], location_evidence: ['C1'] }),
      candidate({ name: 'Girl & The Goat', city: 'Chicago', name_evidence: ['O2'], location_evidence: ['C1'] }),
      candidate({ name: 'Kasama', city: 'Chicago', name_evidence: ['O3'], location_evidence: ['C1'] }),
      candidate({ name: 'Chicago', city: 'Chicago', base_category: 'CITY', category: 'CITY', name_evidence: ['C1'] }),
    ]);
    expect(places.map((p) => p.name)).toEqual(['Au Cheval', 'Girl & The Goat', 'Kasama']);
    expect(places.every((p) => p.city === 'Chicago')).toBe(true);
    expect(rejected).toContainEqual({ name: 'Chicago', reason: 'city is location context' });
  });

  it('handle and display name for the same venue are merged', async () => {
    const content = makeContent({
      caption: 'the best slice @joespizzanyc',
      accounts: [{ username: 'joespizzanyc', fullName: '', relation: 'mention' }],
      hashtags: ['nyc'],
    });
    const media = { ocrFrames: [ocrFrame(0, 1, [["JOE'S PIZZ4", 0.72]])] };
    const { places } = await extract(content, media, [
      candidate({ name: 'joespizzanyc', mention_type: 'handle', city: 'New York', name_evidence: ['A1'] }),
      candidate({ name: "Joe's Pizza", city: 'New York', name_evidence: ['O1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0].name).toBe("Joe's Pizza");
    expect(places[0].evidence_sources).toEqual(expect.arrayContaining(['account', 'ocr']));
  });
});

describe('indirect mentions', () => {
  const content = makeContent({ caption: 'spooky season 🎃', hashtags: ['philly'] });
  const media = { transcript: speech([[0, 4, 'we found this horror themed bookstore on Frankford Ave']]) };
  const indirect = candidate({
    name: '', mention_type: 'indirect', city: 'Philadelphia', base_category: 'SHOPPING', category: 'SHOPPING',
    search_query: 'horror themed bookstore Frankford Ave Philadelphia', name_evidence: ['S1'], location_evidence: ['H1'],
  });

  it('resolves only when Google returns exactly one place, with a capped score', async () => {
    vi.spyOn(LocationService, 'findUniquePlace').mockResolvedValue({ name: 'The Twisted Spine', city: 'Philadelphia' });
    const { places } = await extract(content, media, [indirect]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'The Twisted Spine', mention_type: 'indirect', city: 'Philadelphia' });
    expect(places[0].confidence).toBeLessThanOrEqual(0.6);
    expect(places[0].explanation).toContain('Described (not named) in speech');
    expect(places[0].explanation).toContain('Google Maps returned a single match');
  });

  it('is dropped when the description is not specific enough', async () => {
    vi.spyOn(LocationService, 'findUniquePlace').mockResolvedValue(null);
    const { places, rejected } = await extract(content, media, [indirect]);
    expect(places).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toContain('indirect mention has no unique Google match');
  });

  it('is dropped when the query words are not in the evidence', async () => {
    const spy = vi.spyOn(LocationService, 'findUniquePlace');
    const { places } = await extract(content, media, [{ ...indirect, search_query: 'famous cheesesteak shop South Philly' }]);
    expect(places).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('false positives are rejected', () => {
  it('a name the model invented (not in any evidence)', async () => {
    const { places, rejected } = await extract(makeContent({ caption: 'amazing dinner tonight' }), {}, [
      candidate({ name: 'Carbone', city: 'New York', name_evidence: ['C1'] }),
    ]);
    expect(places).toHaveLength(0);
    expect(rejected).toContainEqual({ name: 'Carbone', reason: 'name not found in evidence' });
  });

  it("the creator's watermark handle", async () => {
    const media = { ocrFrames: [ocrFrame(0, 1, [['@phillyfoodie', 0.95]])] };
    const result = await extract(makeContent({ caption: 'lunch' }), media, [
      candidate({ name: 'phillyfoodie', mention_type: 'handle', name_evidence: ['O1'] }),
    ]);
    expect(result.places).toHaveLength(0);
    // The watermark is removed from the evidence before the model sees it.
    expect(model.calls[0].user).not.toContain('O1');
  });

  it('the audio track shown on screen', async () => {
    const content = makeContent({
      caption: 'vibes',
      musicInfo: { artist_name: 'Drake', song_name: 'Passionfruit', uses_original_audio: false, should_mute_audio: false, should_mute_audio_reason: '', audio_id: '1' },
    });
    const media = { ocrFrames: [ocrFrame(0, 1, [['Passionfruit - Drake', 0.9]])] };
    const { places, rejected } = await extract(content, media, [
      candidate({ name: 'Passionfruit', base_category: 'BARS', category: 'BARS', name_evidence: ['O1'] }),
    ]);
    expect(places).toHaveLength(0);
    expect(rejected).toContainEqual({ name: 'Passionfruit', reason: 'audio track' });
  });

  it('song lyrics on a licensed track are down-weighted and flagged to the model', async () => {
    const content = makeContent({
      caption: 'city nights',
      musicInfo: { artist_name: 'Barry Manilow', song_name: 'Copacabana', uses_original_audio: false, should_mute_audio: false, should_mute_audio_reason: '', audio_id: '2' },
    });
    const media = { transcript: speech([[0, 4, 'her name was Lola, she was a showgirl at the Copa']]) };
    const { places, rejected } = await extract(content, media, [
      candidate({ name: 'Copa', base_category: 'NIGHTLIFE', category: 'NIGHTLIFE', name_evidence: ['S1'] }),
    ]);
    expect(model.calls[0].user).toContain('S lines may be song lyrics');
    expect(places).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/^low evidence score/);
  });

  it('a brand only visible in the background', async () => {
    const media = { ocrFrames: [ocrFrame(0, 1, [['STARBUCKS', 0.9]])] };
    const { places, rejected } = await extract(makeContent({ caption: 'morning routine' }), media, [
      candidate({ name: 'Starbucks', role: 'background', base_category: 'COFFEE', category: 'COFFEE', name_evidence: ['O1'] }),
    ]);
    expect(places).toHaveLength(0);
    expect(rejected).toContainEqual({ name: 'Starbucks', reason: 'role:background' });
  });

  it('a city the model added from its own knowledge is cleared', async () => {
    const media = { ocrFrames: [ocrFrame(0, 1, [['LUCALI', 0.9]])] };
    const { places } = await extract(makeContent({ caption: 'pizza night' }), media, [
      candidate({ name: 'Lucali', city: 'New York', name_evidence: ['O1'] }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0].city).toBe('');
  });

  it('an address that is not in the evidence is cleared', async () => {
    const content = makeContent({ caption: 'Kasama in Chicago is worth the wait' });
    const { places } = await extract(content, {}, [
      candidate({ name: 'Kasama', city: 'Chicago', address: '1001 N Winchester Ave', name_evidence: ['C1'] }),
    ]);
    expect(places[0].address).toBe('');
  });

  it('a generic phrase used as a name', async () => {
    const { places } = await extract(makeContent({ caption: 'this place is unreal' }), {}, [
      candidate({ name: 'this place', name_evidence: ['C1'] }),
    ]);
    expect(places).toHaveLength(0);
  });

  it('a name that only appears in a stranger comment is too weak', async () => {
    const content = makeContent({
      caption: 'guess where',
      comments: [{ text: 'is this Carbone??', ownerUsername: 'someone', isCreator: false, likes: 0 }],
    });
    const { places, rejected } = await extract(content, {}, [
      candidate({ name: 'Carbone', name_evidence: ['K1'] }),
    ]);
    expect(places).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/^low evidence score/);
  });

  it('HIDDEN GEMS requires explicit creator language', async () => {
    const withLanguage = await extract(makeContent({ caption: 'This hidden gem: Café Lumière in Lisbon' }), {}, [
      candidate({ name: 'Café Lumière', city: 'Lisbon', base_category: 'COFFEE', category: 'HIDDEN GEMS', name_evidence: ['C1'] }),
    ]);
    expect(withLanguage.places[0].category).toBe('HIDDEN GEMS');

    const without = await extract(makeContent({ caption: 'Café Lumière in Lisbon' }), {}, [
      candidate({ name: 'Café Lumière', city: 'Lisbon', base_category: 'COFFEE', category: 'HIDDEN GEMS', name_evidence: ['C1'] }),
    ]);
    expect(without.places[0].category).toBe('COFFEE');
  });
});

describe('resilience', () => {
  it('recovers every venue card from Vision and drops a repeated guide watermark', async () => {
    const content = makeContent({ caption: 'Most popular dining spots in Ahmedabad' });
    const media = {
      visionFrames: [
        visionFrame(0, 0, ['SWAGATAM AMDAVAD', 'MOST POPULAR', 'DINING SPOTS', 'IN AHMEDABAD']),
        visionFrame(1, 1, ['SWAGATAM AMDAVAD', 'MAUVE', 'Sindhu Bhavan']),
        visionFrame(2, 2, ['SWAGATAM AMDAVAD', 'RUNGG PREMIUM DINING', 'NehruNagar']),
        visionFrame(3, 3, ['SWAGATAM AMDAVAD', 'PEP HOUSE', 'Thaltej']),
        visionFrame(4, 4, ['SWAGATAM AMDAVAD', 'THE PRIMO BY', 'MANN & SALWA', 'Ambli']),
        visionFrame(5, 5, ['SWAGATAM AMDAVAD', 'PATANG', 'Ellisbridge']),
        visionFrame(6, 6, ['SWAGATAM AMDAVAD', '@MANGO', 'Thaltej']),
        visionFrame(7, 7, ['SWAGATAM AMDAVAD', 'UNDER THE NEEM', 'TREES', 'Bodakdev']),
        visionFrame(8, 8, ['SWAGATAM AMDAVAD', 'LAUREL', 'Ambli']),
      ],
    };
    const result = await extract(content, media, [
      candidate({ name: 'Swagatam Amdavad', city: 'Ahmedabad', name_evidence: ['V1'] }),
      candidate({ name: 'Rungg Premium Dining', city: 'Ahmedabad', name_evidence: ['V7'] }),
      candidate({ name: 'PEP House', city: 'Ahmedabad', name_evidence: ['V9'] }),
      candidate({ name: 'THE Primo BY Mann & Salwa', city: 'Ahmedabad', name_evidence: ['V11', 'V12'] }),
      candidate({ name: 'Patang', city: 'Ahmedabad', name_evidence: ['V14'] }),
      candidate({ name: 'THE Neem', city: 'Ahmedabad', name_evidence: ['V17'] }),
    ]);
    expect(result.places.map((place) => place.name.toLowerCase())).toEqual([
      'rungg premium dining', 'pep house', 'the primo by mann & salwa', 'patang',
      'under the neem trees', 'mauve', '@mango', 'laurel',
    ]);
    expect(result.places.map((place) => place.name)).not.toContain('Swagatam Amdavad');
  });

  it('returns verified source data when all AI providers are rate-limited', async () => {
    model.errors.push(Object.assign(new Error('429 Rate Limit reached on tokens per min'), { status: 429 }));
    const result = await AiEnrichmentService.analyzeContent(makeContent({ caption: 'Kasama, Chicago' }), {}, {});
    expect(result?.places).toEqual([]);
    expect(result?.warning).toContain('rate-limited');
    expect(result?.analysis.caption_analysis.original_caption).toBe('Kasama, Chicago');
  });

  it('skips the model call when there is no evidence at all', async () => {
    const result = await AiEnrichmentService.analyzeContent(makeContent({ caption: '', videoUrl: '' }), {}, {});
    expect(result?.places).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('reports which signals were unavailable in the prompt', async () => {
    await extract(makeContent({ caption: 'hello' }), { ocrFrames: [ocrFrame(0, 1, [])] }, []);
    expect(model.calls[0].user).toContain('SIGNALS: caption=yes location_tag=none');
    expect(model.calls[0].user).toContain('on_screen_text=no text found');
    expect(model.calls[0].user).toContain('speech=not available');
  });

  it('tolerates malformed model items (Groq JSON mode)', async () => {
    model.responses.push(JSON.stringify({
      places: [
        { name: 'Kasama', category: 'RESTAURANTS' }, // missing fields → defaults
        'garbage',
        { name: '#ad', category: 'RESTAURANTS' },
        { name: 'X', category: 'NOT_A_CATEGORY' },
      ],
    }));
    const result = await AiEnrichmentService.analyzeContent(makeContent({ caption: 'Kasama, Chicago' }), {}, {});
    expect(result?.places.map((p) => p.name)).toEqual(['Kasama']);
  });
});
