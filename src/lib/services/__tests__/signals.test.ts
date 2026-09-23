import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabaseAdmin: {} }));

import { ScraperService } from '../scraper.service';
import { WhisperService } from '../whisper.service';
import { LocationService } from '../location.service';
import { mediaItemsFor, namedPlaceCount, pickSubtitleTrack, promisedPlaceCount, selectFramesForPlaceIntent, selectFramesForVisionFallback } from '../media-evidence.service';
import { googleTypeConflict } from '../place-evidence.service';
import { escapeLike, verifiedEvidence } from '../db.service';
import { buildConfidentLines, wordStatsFromTsv } from '../apify-ocr.service';
import { makeContent, ocrFrame } from './fixtures';

// Shapes below mirror real apify/instagram-scraper and clockworks/tiktok-scraper items.
const instagramRaw = {
  ownerUsername: 'phillyfoodie',
  locationName: 'Philadelphia, Pennsylvania',
  locationId: 1234,
  firstComment: 'where is this??',
  latestComments: [
    { text: '📍 The Gas Lamp, 140 N 2nd St', ownerUsername: 'phillyfoodie', likesCount: 4 },
    { text: 'where is this??', ownerUsername: 'someone', likesCount: 1 },
  ],
  alt: 'Video by Sam Eats on June 02, 2026.',
  taggedUsers: [
    { username: 'thegaslamphotel', full_name: 'The Gas Lamp Hotel', id: '1', is_verified: false, profile_pic_url: '' },
    { username: 'phillyfoodie', full_name: 'Sam Eats', id: '2', is_verified: false, profile_pic_url: '' },
  ],
  coauthorProducers: [{ username: 'visitphilly', full_name: 'Visit Philadelphia' }],
  childPosts: [{ alt: 'Photo by Sam Eats in Old City, Philadelphia on June 02, 2026.', taggedUsers: [{ username: 'fikacafe', full_name: 'Fika Café' }] }],
};

describe('ScraperService.extractPlaceSignals', () => {
  it('maps Instagram location tag, comments, tagged/collab accounts and informative alt text', () => {
    const signals = ScraperService.extractPlaceSignals(instagramRaw, 'instagram');
    expect(signals.locationTag).toEqual({ name: 'Philadelphia, Pennsylvania', id: '1234' });
    expect(signals.comments).toEqual([
      { text: '📍 The Gas Lamp, 140 N 2nd St', ownerUsername: 'phillyfoodie', isCreator: true, likes: 4 },
      { text: 'where is this??', ownerUsername: 'someone', isCreator: false, likes: 1 },
    ]);
    expect(signals.accounts).toEqual([
      { username: 'thegaslamphotel', fullName: 'The Gas Lamp Hotel', relation: 'tagged' },
      { username: 'fikacafe', fullName: 'Fika Café', relation: 'tagged' },
      { username: 'visitphilly', fullName: 'Visit Philadelphia', relation: 'coauthor' },
    ]);
    // "Video by X on <date>" carries nothing; "Photo by X in <place> on <date>" does.
    expect(signals.altTexts).toEqual(['Photo by Sam Eats in Old City, Philadelphia on June 02, 2026.']);
  });

  it('maps TikTok subtitles, mention display names and the bio', () => {
    const signals = ScraperService.extractPlaceSignals({
      authorMeta: { name: 'bookgirl', signature: 'NYC 📍 books & coffee' },
      textLanguage: 'en',
      detailedMentions: [
        { id: '1', name: 'twistedspinephl', nickName: 'The Twisted Spine' },
        { id: '2', name: 'bookgirl', nickName: 'me' },
      ],
      videoMeta: {
        subtitleLinks: [
          { language: 'eng-US', source: 'ASR', downloadLink: 'https://v16m.tiktokcdn-us.com/sub.vtt' },
          { language: 'eng-US', source: 'MT', downloadLink: 'http://insecure.example/sub.vtt' },
        ],
      },
    }, 'tiktok');
    expect(signals.accounts).toEqual([{ username: 'twistedspinephl', fullName: 'The Twisted Spine', relation: 'mention' }]);
    expect(signals.subtitleTracks).toEqual([{ language: 'eng-US', source: 'ASR', url: 'https://v16m.tiktokcdn-us.com/sub.vtt' }]);
    expect(signals.creatorBio).toBe('NYC 📍 books & coffee');
    expect(signals.captionLanguage).toBe('en');
  });

  it('is safe on missing data', () => {
    expect(ScraperService.extractPlaceSignals(null, 'instagram')).toEqual({});
    expect(ScraperService.extractPlaceSignals({}, 'instagram').locationTag).toBeNull();
  });
});

describe('WhisperService', () => {
  it('drops silence, repetition loops and known hallucinations', () => {
    const { kept, dropped } = WhisperService.filterSegments([
      { start: 0, end: 2, text: ' We are at Lucali ', no_speech_prob: 0.05, avg_logprob: -0.2, compression_ratio: 1.3 },
      { start: 2, end: 4, text: 'la la la', no_speech_prob: 0.8, avg_logprob: -1.4, compression_ratio: 1.1 },
      { start: 4, end: 9, text: 'yeah yeah yeah yeah yeah yeah', no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.1 },
      { start: 9, end: 10, text: 'Thank you for watching!', no_speech_prob: 0.3, avg_logprob: -0.5, compression_ratio: 1 },
    ]);
    expect(kept).toEqual([{ start: 0, end: 2, text: 'We are at Lucali' }]);
    expect(dropped).toBe(3);
  });

  it('parses TikTok WebVTT subtitles into timed segments', () => {
    const vtt = 'WEBVTT\n\n\n00:00:00.020 --> 00:00:04.020\nWhat do you guys say that we go\nto a horror themed bookstore?\n\n00:00:06.022 --> 00:00:08.061\nWe are going to <b>the twisted spine</b>.\n';
    expect(WhisperService.parseWebVtt(vtt)).toEqual([
      { start: 0.02, end: 4.02, text: 'What do you guys say that we go to a horror themed bookstore?' },
      { start: 6.022, end: 8.061, text: 'We are going to the twisted spine.' },
    ]);
  });

  it('reads the original text from legacy stored transcripts', () => {
    const stored = 'Original Transcript:\nहम यहाँ हैं\n\nEnglish Translation:\nWe are here';
    expect(WhisperService.fromStoredText(stored)?.text).toBe('हम यहाँ हैं');
    expect(WhisperService.fromStoredText('')).toBeNull();
  });

  it('labels non-English transcripts with their language', () => {
    expect(WhisperService.formatTranscript({ text: 'hola', language: 'spanish', segments: [], source: 'whisper', droppedSegments: 0 })).toBe('[spanish] hola');
    expect(WhisperService.formatTranscript({ text: 'hi', language: 'en', segments: [], source: 'whisper', droppedSegments: 0 })).toBe('hi');
  });
});

describe('LocationService.nameSimilarity', () => {
  it('accepts descriptor-only differences', () => {
    expect(LocationService.nameSimilarity("Katz's", "Katz's Delicatessen")).toBeGreaterThanOrEqual(0.85);
    expect(LocationService.nameSimilarity('joespizza', "Joe's Pizza")).toBe(1);
    expect(LocationService.nameSimilarity('Blue Bottle Coffee', 'Blue Bottle Coffee Williamsburg', ['Williamsburg'])).toBeGreaterThanOrEqual(0.85);
  });

  it('accepts a branch suffix only when it is part of the listing address', () => {
    expect(LocationService.nameSimilarity("Joe's Pizza", "Joe's Pizza Broadway", ['1435 Broadway, New York'])).toBeGreaterThanOrEqual(0.85);
    expect(LocationService.nameSimilarity("Joe's Pizza", "Joe's Pizza Broadway")).toBeLessThan(0.85);
  });

  it('rejects a different venue that shares a prefix', () => {
    expect(LocationService.nameSimilarity("Joe's", "Joe's Shanghai", ['46 Bowery, New York'])).toBeLessThan(0.85);
    expect(LocationService.nameSimilarity('Lucali', 'Lucia Pizza')).toBeLessThan(0.85);
  });
});

describe('vision OCR fallback selection', () => {
  it('sends only frames where local OCR saw words but could not read them', () => {
    const frames = [
      ocrFrame(0, 0, [], { total: 0, confident: 0, meanConfidence: 0 }),   // no text at all → skip
      ocrFrame(1, 2, [], { total: 10, confident: 9, meanConfidence: 90 }), // clean overlay → skip
      ocrFrame(2, 4, [], { total: 8, confident: 2, meanConfidence: 48 }),  // stylised sign → send
      ocrFrame(3, 6, [], { total: 4, confident: 3, meanConfidence: 66 }),  // low mean → send
      ocrFrame(4, 8, [], { total: 2, confident: 0, meanConfidence: 30 }),  // too few words → skip
    ];
    expect(selectFramesForVisionFallback(frames, 8)).toEqual([2, 3]);
    expect(selectFramesForVisionFallback(frames, 1)).toEqual([2]);
  });
});

describe('media helpers', () => {
  it('prefers creator captions, then speech recognition, then machine translation', () => {
    const tracks = [
      { language: 'eng-US', source: 'MT', url: 'https://a' },
      { language: 'spa-ES', source: 'ASR', url: 'https://b' },
      { language: 'eng-US', source: 'ASR', url: 'https://c' },
    ];
    expect(pickSubtitleTrack(tracks, 'en')?.url).toBe('https://c');
    expect(pickSubtitleTrack([...tracks, { language: 'eng-US', source: 'LC', url: 'https://d' }], 'en')?.url).toBe('https://d');
    expect(pickSubtitleTrack([], 'en')).toBeNull();
  });

  it('builds the media list for video, carousel and single-image posts', () => {
    expect(mediaItemsFor(makeContent(), {})).toEqual([{ kind: 'video', url: 'https://cdn.example.com/video.mp4' }]);
    const carousel = makeContent({ contentType: 'post', videoUrl: '' });
    expect(mediaItemsFor(carousel, {
      childPosts: [
        { type: 'Image', displayUrl: 'https://img/1.jpg' },
        { type: 'Video', videoUrl: 'https://vid/2.mp4', displayUrl: 'https://img/2.jpg' },
      ],
    })).toEqual([{ kind: 'video', url: 'https://vid/2.mp4' }, { kind: 'image', url: 'https://img/1.jpg' }]);
    expect(mediaItemsFor(makeContent({ contentType: 'post', videoUrl: '', images: [] }), {}))
      .toEqual([{ kind: 'image', url: 'https://cdn.example.com/cover.jpg' }]);
  });
});

describe('Tesseract TSV parsing', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const word = (line: number, conf: number, text: string) => `5\t1\t1\t1\t${line}\t1\t0\t0\t10\t10\t${conf}\t${text}`;

  it('keeps confident lines with their mean confidence', () => {
    const tsv = [header, word(1, 92, 'JOES'), word(1, 88, 'PIZZA'), word(2, 30, 'x7#'), word(3, 40, 'blurry')].join('\n');
    expect(buildConfidentLines(tsv)).toEqual([{ text: 'JOES PIZZA', confidence: 0.9 }]);
    // 'x7#' has letters and digits, so it counts as a (low-confidence) word.
    expect(wordStatsFromTsv(tsv)).toEqual({ total: 4, confident: 2, meanConfidence: 63 });
  });
});

describe('DB helpers', () => {
  it('escapes LIKE wildcards in names', () => {
    expect(escapeLike('100% Pizza')).toBe('100\\% Pizza');
    expect(escapeLike('Dim_Sum')).toBe('Dim\\_Sum');
  });

  it('raises confidence after Google verification and flags chain ambiguity', () => {
    const place = { confidence: 0.73, explanation: 'Name found in on-screen text (3s).' };
    expect(verifiedEvidence(place, { verified: true })).toEqual({
      confidence: 0.83,
      explanation: 'Name found in on-screen text (3s). Verified on Google Maps.',
    });
    expect(verifiedEvidence(place, { verified: true, ambiguous: true }).confidence).toBe(0.73);
    expect(verifiedEvidence(place, { verified: false })).toEqual({ confidence: 0.73, explanation: 'Name found in on-screen text (3s).' });
  });
});

describe('place-intent vision escalation', () => {
  const titleFrames = Array.from({ length: 11 }, (_, i) => ocrFrame(i, i, i % 2 ? [['cozy restaurants in the', 0.92], ['west village for fall', 0.95]] : []));

  it('reads the promised count from caption or overlay', () => {
    expect(promisedPlaceCount(['5 restaurants in the West Village perfect for fall'])).toBe(5);
    expect(promisedPlaceCount(['5cozy restaurants in the'])).toBeNull(); // OCR glued the number to the word
    expect(promisedPlaceCount(['5 cozy restaurants in the'])).toBe(5);
    expect(promisedPlaceCount(['my top 10 cafes in Paris'])).toBe(10);
    expect(promisedPlaceCount(['three hidden gem bars'])).toBe(3);
    expect(promisedPlaceCount(['2026 was a good year'])).toBeNull();
  });

  it('sends every frame when a list is promised but no text names the places', () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(selectFramesForPlaceIntent(makeContent({ caption: '5 restaurants in the West Village perfect for fall' }), titleFrames)).toEqual(all);
    expect(selectFramesForPlaceIntent(makeContent({ caption: '3 spots in Chicago' }), titleFrames)).toEqual(all);
  });

  it('does nothing when the caption already lists the places or the post is not about places', () => {
    const listed = makeContent({ caption: '3 spots in Chicago\n1. Au Cheval\n2. Kasama\n3. Girl & The Goat' });
    expect(namedPlaceCount(listed)).toBe(3);
    const pinned = makeContent({ caption: ['2 spots in NYC', '📌 Buvette', 'Location: Morandi'].join('\n') });
    expect(namedPlaceCount(pinned)).toBe(2);
    expect(selectFramesForPlaceIntent(pinned, titleFrames)).toEqual([]);
    expect(selectFramesForPlaceIntent(listed, titleFrames)).toEqual([]);
    const routineFrames = [ocrFrame(0, 0, [['step 1: cleanser', 0.9]]), ocrFrame(1, 2, [])];
    expect(selectFramesForPlaceIntent(makeContent({ caption: 'my morning skincare routine' }), routineFrames)).toEqual([]);
  });

  it('includes frames where local OCR already read text (vision may read more)', () => {
    const frames = [
      ocrFrame(0, 0, [['cozy restaurants in the', 0.9]]),
      ocrFrame(1, 1, [['cozy restaurants in the', 0.9], ['KASAMA', 0.9]]),
      ocrFrame(2, 2, []),
    ];
    expect(selectFramesForPlaceIntent(makeContent({ caption: 'where to eat in Chicago' }), frames)).toEqual([0, 1, 2]);
  });
});

describe('carousel slides always get vision OCR', () => {
  it('sends every image slide, even ones local OCR read cleanly', async () => {
    const { MediaEvidenceService } = await import('../media-evidence.service');
    const { GoogleVisionOcrService } = await import('../google-vision-ocr.service');
    process.env.GOOGLE_VISION_API_KEY = 'test-key';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent = vi.spyOn(GoogleVisionOcrService, 'extractTextFromFrames').mockResolvedValue([]);
    const slides = [0, 1, 2].map((i) => ({ frameIndex: i, timestamp: 0, filePath: `slide${i}.jpg`, colorFilePath: `slide${i}.jpg`, hash: String(i) }));
    const clean = slides.map((slide) => ocrFrame(slide.frameIndex, 0, [['Cheap Eats', 0.95]], { total: 8, confident: 8, meanConfidence: 92 }));
    await MediaEvidenceService.runVisionFallback(slides, clean, makeContent({ contentType: 'post', videoUrl: '' }), [0, 1, 2]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0].map((frame) => frame.frameIndex)).toEqual([0, 1, 2]);
    delete process.env.GOOGLE_VISION_API_KEY;
    vi.restoreAllMocks();
  });
});

describe('no page caps', () => {
  it('processes every carousel slide (a 12-slide post listed all its places on slides 11–12)', () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ type: 'Image', displayUrl: `https://img/${i}.jpg` }));
    const items = mediaItemsFor(makeContent({ contentType: 'post', videoUrl: '' }), { childPosts: slides });
    expect(items).toHaveLength(12);
    expect(items[11]).toEqual({ kind: 'image', url: 'https://img/11.jpg' });
  });

  it('processes every video inside a carousel', () => {
    const children = Array.from({ length: 5 }, (_, i) => ({ type: 'Video', videoUrl: `https://vid/${i}.mp4` }));
    expect(mediaItemsFor(makeContent({ contentType: 'post', videoUrl: '' }), { childPosts: children })).toHaveLength(5);
  });
});

describe('googleTypeConflict', () => {
  it('flags a different kind of venue and accepts same-family types', () => {
    expect(googleTypeConflict('RESTAURANTS', 'shoe_store', ['shoe_store', 'store'])).toBe('SHOPPING');
    expect(googleTypeConflict('RESTAURANTS', 'coffee_shop', ['coffee_shop', 'cafe'])).toBeNull();
    expect(googleTypeConflict('RESTAURANTS', 'bar', ['bar'])).toBeNull();
    expect(googleTypeConflict('NATURE', 'italian_restaurant', ['restaurant'])).toBe('RESTAURANTS');
    expect(googleTypeConflict('CITY', 'clothing_store', [])).toBeNull();
    expect(googleTypeConflict('RESTAURANTS', 'point_of_interest', [])).toBeNull();
  });
});
