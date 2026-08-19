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
  };
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
}

// ──────────────────────────────────────────────────────────────────────
// VIDEO OCR TYPES
// ──────────────────────────────────────────────────────────────────────

export interface VideoFrame {
  frameIndex: number;
  timestamp: number;   // seconds from start of video
  filePath: string;
  hash: string;        // MD5 for deduplication
}

/** Result from Apify OCR actor on a single frame */
export interface ApifyOcrFrameResult {
  frameIndex: number;
  timestamp: number;
  texts: string[];
  rawConfidence: number;
  rawResult: any;
  method: 'apify-ocr';
}

/** Result from GPT-4o Vision on a single frame */
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
  method: 'gpt-4o-vision';
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

export interface PlaceExtraction {
  name: string | null;
  city: string;
  neighborhood: string;
  address: string;
  category: string;
  description: string;
  creator_handle: string;
  confidence: number;
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
