import type {
  ApifyOcrFrameResult, GptVisionFrameResult, SocialContent, TranscriptResult,
} from '../../types/social';

export function makeContent(overrides: Partial<SocialContent> = {}): SocialContent {
  return {
    platform: 'instagram',
    contentId: 'post-1',
    contentType: 'reel',
    authorUsername: 'phillyfoodie',
    authorFullName: 'Sam Eats',
    caption: '',
    videoUrl: 'https://cdn.example.com/video.mp4',
    displayUrl: 'https://cdn.example.com/cover.jpg',
    images: [],
    shortCode: 'abc',
    metrics: { likes: null, views: null, plays: null, comments: null, shares: null, saves: null },
    hashtags: [],
    mentions: [],
    taggedUsers: [],
    musicInfo: null,
    videoDuration: 30,
    dimensions: null,
    paidPartnership: false,
    productType: 'clips',
    publishedAt: null,
    rawApifyData: {},
    locationTag: null,
    comments: [],
    altTexts: [],
    creatorBio: '',
    accounts: [],
    subtitleTracks: [],
    captionLanguage: null,
    ...overrides,
  };
}

/** Local OCR frame; each line is [text, confidence 0–1]. */
export function ocrFrame(
  frameIndex: number,
  timestamp: number,
  lines: Array<[string, number]>,
  wordStats = { total: 6, confident: 6, meanConfidence: 88 }
): ApifyOcrFrameResult {
  return {
    frameIndex,
    timestamp,
    texts: lines.map(([text]) => text),
    rawConfidence: 0.8,
    rawResult: {},
    method: 'apify-ocr',
    lines: lines.map(([text, confidence]) => ({ text, confidence })),
    wordStats,
  };
}

export function visionFrame(frameIndex: number, timestamp: number, texts: string[]): GptVisionFrameResult {
  return {
    frameIndex, timestamp, texts,
    brands: [], locations: [], prices: [], cta: [], description: '', confidence: 0, method: 'google-vision',
  };
}

/** Timed speech; each segment is [start, end, text]. */
export function speech(segments: Array<[number, number, string]>): TranscriptResult {
  return {
    text: segments.map(([, , text]) => text).join(' '),
    language: 'en',
    segments: segments.map(([start, end, text]) => ({ start, end, text })),
    source: 'whisper',
    droppedSegments: 0,
  };
}

/** A model place item with every schema field populated. */
export function candidate(overrides: Record<string, unknown> = {}) {
  return {
    name: '',
    mention_type: 'explicit',
    role: 'featured',
    name_evidence: [],
    location_evidence: [],
    city: '',
    neighborhood: '',
    address: '',
    base_category: 'RESTAURANTS',
    category: 'RESTAURANTS',
    description: '',
    search_query: '',
    ...overrides,
  };
}

export function modelResponse(places: unknown[]): string {
  return JSON.stringify({
    places,
    analysis: {
      summary: '', primary_category: '', topics: [], keywords: [], tone: [], niche: '',
      is_promotional: false, is_sponsored: false, promotion_type: '', call_to_actions: [], offers: [],
      primary_audience: '', audience_interests: [], geographic_focus: [], audience_intent: '', audience_confidence: 0,
    },
  });
}
