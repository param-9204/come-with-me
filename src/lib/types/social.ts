// ── FULL TYPES: Social Media Intelligence Engine ──

// ──────────────────────────────────────────────────────────────────────
// RAW APIFY DATA TYPES (preserves every field from the API)
// ──────────────────────────────────────────────────────────────────────

export interface ApifyTaggedUser {
  full_name: string;
  id: string;
  is_verified: boolean;
  profile_pic_url: string;
  username: string;
}

export interface ApifyMusicInfo {
  artist_name: string;
  song_name: string;
  uses_original_audio: boolean;
  should_mute_audio: boolean;
  should_mute_audio_reason: string;
  audio_id: string;
}

/** Raw Instagram post object exactly as Apify returns it */
export interface ApifyInstagramPost {
  inputUrl: string;
  id: string;
  type: 'Video' | 'Image' | 'Sidecar';
  shortCode: string;
  caption: string;
  hashtags: string[];
  mentions: string[];
  url: string;
  commentsCount: number;
  firstComment: string;
  latestComments: any[];
  dimensionsHeight: number;
  dimensionsWidth: number;
  displayUrl: string;
  images: string[];
  videoUrl: string;
  alt: string | null;
  likesCount: number;        // -1 means hidden/unavailable
  videoViewCount: number;
  videoPlayCount: number;
  timestamp: string;         // ISO 8601
  childPosts: any[];
  ownerFullName: string;
  ownerUsername: string;
  ownerId: string;
  productType: string;       // 'clips' | 'feed' | 'igtv'
  videoDuration: number;     // seconds
  paidPartnership: boolean;
  taggedUsers: ApifyTaggedUser[];
  musicInfo: ApifyMusicInfo | null;
  isCommentsDisabled: boolean;
  /** Present only when the creator added a location tag. */
  locationName?: string;
  locationId?: number | string;
  coauthorProducers?: Array<{ username: string; full_name: string; id?: string }>;
}

/** Raw TikTok post object exactly as Apify (clockworks/tiktok-scraper) returns it */
export interface ApifyTikTokPost {
  id: string;
  text: string;
  webVideoUrl: string;
  videoUrl: string;
  videoMeta: {
    height: number;
    width: number;
    duration: number;
    format: string;
    originalCoverUrl: string;
    dynamicCoverUrl: string;
    subtitleLinks?: Array<{ language: string; downloadLink?: string; tiktokLink?: string; source?: string }>;
  };
  textLanguage?: string;
  detailedMentions?: Array<{ id: string; name: string; nickName: string }>;
  authorMeta: {
    id: string;
    name: string;         // username
    nickName: string;     // display name
    verified: boolean;
    avatar: string;
    signature: string;
  };
  musicMeta: {
    musicId: string;
    musicName: string;
    musicAuthor: string;
    musicOriginal: boolean;
    playUrl: string;
    coverMediumUrl: string;
  };
  createTime: number;      // Unix timestamp
  createTimeISO: string;
  diggCount: number;       // likes
  shareCount: number;
  playCount: number;
  collectCount: number;    // saves/bookmarks
  commentCount: number;
  hashtags: Array<{ id: string; name: string; title: string }>;
  mentions: string[];
  isAd: boolean;
  isPinned: boolean;
  isSponsored: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// PLACE SIGNALS (platform metadata that can identify a place)
// ──────────────────────────────────────────────────────────────────────

/** Instagram location tag (`locationName` / `locationId`). Often city-level. */
export interface SocialLocationTag {
  name: string;
  id: string | null;
  /** Postal address the platform attaches to the tag (TikTok `locationMeta.address`), when present. */
  address?: string | null;
}

export interface SocialComment {
  text: string;
  ownerUsername: string;
  /** True when the post author wrote the comment (pinned "📍 location" replies). */
  isCreator: boolean;
  likes: number | null;
}

/** An account linked to the post, with its display name when the platform provides one. */
export interface SocialAccountRef {
  username: string;
  fullName: string;
  relation: 'tagged' | 'coauthor' | 'mention';
}

/** Platform-provided subtitle track (TikTok `videoMeta.subtitleLinks`, WebVTT). */
export interface SubtitleTrack {
  language: string;
  /** ASR = automatic speech recognition, LC = creator caption, MT = machine translation. */
  source: string;
  url: string;
}

// ──────────────────────────────────────────────────────────────────────
// NORMALIZED CONTENT (backward-compat bridge layer)
// ──────────────────────────────────────────────────────────────────────

export interface SocialContent {
  platform: 'instagram' | 'tiktok';
  contentId: string;
  contentType: 'post' | 'reel' | 'video';
  authorUsername: string;
  authorFullName: string;
  caption: string;
  videoUrl?: string;
  displayUrl?: string;
  images?: string[];
  shortCode?: string;
  ocrText?: string[];
  translateToEnglish?: boolean;
  metrics: {
    likes: number | null;    // null when hidden (likesCount === -1)
    views: number | null;
    plays: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
  };
  hashtags: string[];
  mentions: string[];
  taggedUsers: ApifyTaggedUser[];
  musicInfo: ApifyMusicInfo | null;
  videoDuration: number | null;
  dimensions: { width: number; height: number } | null;
  paidPartnership: boolean;
  productType: string | null;
  publishedAt: string | null;
  rawApifyData: ApifyInstagramPost | ApifyTikTokPost | Record<string, any>;
  // ── Place signals (optional: absent on older stored records) ──
  locationTag?: SocialLocationTag | null;
  comments?: SocialComment[];
  altTexts?: string[];
  creatorBio?: string;
  accounts?: SocialAccountRef[];
  subtitleTracks?: SubtitleTrack[];
  captionLanguage?: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// VIDEO OCR TYPES
// ──────────────────────────────────────────────────────────────────────

export interface VideoFrame {
  frameIndex: number;
  timestamp: number;   // seconds from start of video
  /** Frame used by local OCR (may be contrast-enhanced grayscale). */
  filePath: string;
  /** Unprocessed colour frame for vision OCR; falls back to `filePath`. */
  colorFilePath?: string;
  hash: string;
}

export interface OcrLine {
  text: string;
  /** 0–1 */
  confidence: number;
}

/** Result from local Tesseract OCR on a single frame (legacy name kept for stored data). */
export interface ApifyOcrFrameResult {
  frameIndex: number;
  timestamp: number;
  /** Lines not seen in an earlier frame (legacy consumers). */
  texts: string[];
  rawConfidence: number;
  rawResult: any;
  method: 'apify-ocr';
  /** Every confident line in this frame, with per-line confidence. */
  lines?: OcrLine[];
  /** Word-level statistics used to decide whether a frame needs vision OCR. */
  wordStats?: { total: number; confident: number; meanConfidence: number };
}

/** Result from a vision OCR provider on a single frame */
export interface GptVisionFrameResult {
  frameIndex: number;
  timestamp: number;
  texts: string[];
  brands: string[];
  locations: string[];
  prices: string[];
  cta: string[];
  description: string;
  confidence: number;
  /** The actual OCR backend; older stored rows may retain the previous mini label. */
  method: 'gpt-4o-mini-vision' | 'gpt-4o-vision' | 'google-vision';
  /**
   * Strings from `texts` that are physically part of the filmed scene (shop or
   * street signs, menus, packaging, billboards) rather than text added in
   * editing (titles, stickers, list overlays, pins). Absent when the OCR
   * backend cannot tell them apart (Google Vision, older stored rows).
   */
  sceneTexts?: string[];
  /**
   * Present only on one representative empty frame when Vision could not be
   * used. Keeping it on a frame preserves the existing stored OCR schema
   * without duplicating the same failure payload for every video frame.
   */
  warning?: {
    code: 'gpt_vision_limit_exceeded';
    message: string;
  };
}

// ──────────────────────────────────────────────────────────────────────
// TRANSCRIPT TYPES
// ──────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  language: string | null;
  segments: TranscriptSegment[];
  source: 'platform-subtitles' | 'whisper' | 'stored' | 'none';
  /** Segments removed as silence, music, or known speech-to-text hallucinations. */
  droppedSegments: number;
}

// ──────────────────────────────────────────────────────────────────────
// EVIDENCE MODEL (multi-signal place extraction)
// ──────────────────────────────────────────────────────────────────────

export type EvidenceSource =
  | 'caption'
  | 'hashtags'
  | 'location_tag'
  | 'account'
  | 'comment_creator'
  | 'comment'
  | 'alt_text'
  | 'creator_bio'
  | 'ocr'
  | 'vision_ocr'
  | 'speech';

export interface EvidenceItem {
  /** Short stable id cited by the model, e.g. "C2", "O7", "S3". */
  id: string;
  source: EvidenceSource;
  text: string;
  /** Prior reliability of this item as support for a place name (0–1). */
  weight: number;
  /** Seconds from the start of the video where the text was seen or spoken. */
  timestamps?: number[];
  /** OCR only: frame indexes the line was read in (lets multi-line signs be matched per frame). */
  frames?: number[];
  /**
   * OCR only: true when Vision reported this line as text physically in the
   * scene (a street sign, a logo on a cup) every time it was read, rather than
   * an overlay the creator added. Undefined when unknown.
   */
  scene?: boolean;
  /** For account items. */
  username?: string;
  displayName?: string;
  relation?: SocialAccountRef['relation'];
}

/** Aggregated OCR comparison output */
export interface OcrComparisonResult {
  apifyOcr: {
    frames: ApifyOcrFrameResult[];
    allTexts: string[];
    totalFramesProcessed: number;
    processingTimeMs: number;
  };
  gptVision: {
    frames: GptVisionFrameResult[];
    allTexts: string[];
    allBrands: string[];
    allLocations: string[];
    allPrices: string[];
    allCtas: string[];
    totalFramesProcessed: number;
    processingTimeMs: number;
  };
}

// ──────────────────────────────────────────────────────────────────────
// AI ANALYSIS OUTPUT (32-section prompt output schema)
// ──────────────────────────────────────────────────────────────────────

export interface AiAnalysisResult {
  platform: string;
  content: {
    content_id: string;
    content_type: string;
    url: string;
    video_url: string | null;
    thumbnail_url: string | null;
    published_at: string | null;
    duration_seconds: number | null;
    dimensions: { width: number | null; height: number | null; orientation: string } | null;
    summary: string;
    primary_category: string;
    secondary_categories: string[];
    topics: string[];
    keywords: string[];
  };
  creator: {
    id: string;
    username: string;
    full_name: string;
    profile_url: string | null;
    verified: boolean | null;
  };
  caption_analysis: {
    original_caption: string;
    summary: string;
    keywords: string[];
    hashtags: string[];
    mentions: string[];
    call_to_actions: string[];
  };
  entities: {
    brands: EntityItem[];
    products: EntityItem[];
    companies: EntityItem[];
    restaurants: EntityItem[];
    services: EntityItem[];
    people: EntityItem[];
    locations: LocationEntity[];
    websites: EntityItem[];
  };
  visual_analysis: {
    visible_text: VisibleTextItem[];
    products_visible: string[];
    brands_visible: string[];
    people_visible: string[];
    locations_visible: string[];
    objects_visible: string[];
    logos_visible: string[];
  };
  audio_analysis: {
    artist: string | null;
    song_name: string | null;
    audio_id: string | null;
    uses_original_audio: boolean | null;
    transcript: string | null;
    spoken_information: string[];
  };
  promotion: {
    is_promotional: boolean | null;
    is_sponsored: boolean | null;
    is_paid_partnership: boolean | null;
    promotion_type: string | null;
    promoted_entities: string[];
    offers: string[];
    discounts: string[];
    call_to_actions: string[];
  };
  audience: {
    primary_audience: string;
    interests: string[];
    geographic_focus: string[];
    intent: string;
    confidence: number;
  };
  content_style: {
    tone: string[];
    style: string[];
    format: string;
  };
  engagement: {
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    views: number | null;
    plays: number | null;
    reach: number | null;
    impressions: number | null;
    engagement_rate: number | null;
    engagement_rate_formula: string | null;
  };
  hashtags: {
    all: string[];
    brand: string[];
    product: string[];
    industry: string[];
    location: string[];
    campaign: string[];
    topic: string[];
    generic: string[];
  };
  campaign_insights: {
    relevant_industries: string[];
    relevant_brand_categories: string[];
    relevant_product_categories: string[];
    relevant_audiences: string[];
    relevant_locations: string[];
    potential_campaign_themes: string[];
    potential_collaboration_categories: string[];
    campaign_suitability: string;
    reasoning: string;
  };
  influencer_analysis: {
    niche: string;
    sub_niches: string[];
    content_strengths: string[];
    potential_collaboration_types: string[];
    potential_brand_categories: string[];
  };
  data_quality: {
    available_fields: string[];
    missing_fields: string[];
    unavailable_metrics: string[];
    media_analysis_available: boolean;
    ocr_available: boolean;
    transcript_available: boolean;
  };
  extracted_information: Array<{
    field: string;
    value: string;
    source: string;
    confidence: number;
  }>;
}

export interface EntityItem {
  name: string;
  type: string;
  source: string;
  explicit: boolean;
  confidence: number;
  context?: string;
}

export interface LocationEntity extends EntityItem {
  country?: string | null;
  city?: string | null;
  address?: string | null;
  location_type?: string;
}

export interface VisibleTextItem {
  text: string;
  normalized_text: string;
  location?: string | null;
  confidence: number;
  source: 'ocr' | 'inference';
}

// ──────────────────────────────────────────────────────────────────────
// PIPELINE RESULT (returned to frontend)
// ──────────────────────────────────────────────────────────────────────

export interface PipelineResult {
  success: boolean;
  scrapedData: SocialContent | null;
  rawApifyData: any;
  transcript: string;
  ocrComparison: OcrComparisonResult | null;
  aiAnalysis: AiAnalysisResult | null;
  places: PlaceExtraction[] | null;
  placeIds: string[];
  pipelineSteps: PipelineStep[];
  error?: string;
}

export interface PipelineStep {
  step: number;
  name: string;
  status: 'success' | 'skipped' | 'error' | 'pending';
  durationMs: number;
  details?: string;
}

export type PlaceCategory = 'RESTAURANTS' | 'COFFEE' | 'TRAVEL' | 'ADVENTURE' | 'NATURE' | 'CITY' | 'SHOPPING' | 'NIGHTLIFE' | 'CULTURE' | 'HIDDEN GEMS' | 'BARS';

export interface PlaceExtraction {
  name: string | null;
  city: string;
  neighborhood: string;
  address: string;
  category: PlaceCategory;
  description: string;
  creator_handle: string;
  /** Evidence-based score, 0–1. */
  confidence: number;
  social_post_id?: string;
  // ── Evidence (set by the multi-signal extractor) ──
  /** Category describing what the place is; never HIDDEN GEMS. */
  base_category?: Exclude<PlaceCategory, 'HIDDEN GEMS'>;
  mention_type?: 'explicit' | 'handle' | 'indirect';
  role?: 'featured' | 'recommended';
  /** Evidence ids that contain or identify the name. */
  evidence_ids?: string[];
  /** Evidence ids that support the city/neighbourhood/address. */
  location_evidence_ids?: string[];
  evidence_sources?: EvidenceSource[];
  /** Human-readable reason this place was detected. */
  explanation?: string;
  /** The evidence lines behind the name and location (trimmed), for audit/UI. */
  evidence_snippets?: Array<{ id: string; source: EvidenceSource; text: string; timestamps?: number[] }>;
  /** Maps search text for indirect mentions (words taken from evidence only). */
  search_query?: string;
  /**
   * The place's name as the city's own maps write it, when the post uses
   * another language ("Statue of Liberty" for "Statua della Libertà").
   * Used only as map search text; `name` stays as written in the post.
   */
  map_name?: string;
  google_place_id?: string | null;
}

// Legacy compat
export interface EnrichedAnalysis {
  topics: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  hook_type: string;
  summary: string;
  call_to_action?: string;
  brand_mentions?: string[];
}
