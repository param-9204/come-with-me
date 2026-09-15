import { getAIClient } from './ai-client';
import type { SocialContent, AiAnalysisResult, PlaceExtraction } from '../types/social';
import * as stringSimilarity from 'string-similarity';
import { removeStopwords, eng } from 'stopword';
import nlp from 'compromise';

const PLACE_CATEGORIES = [
  'RESTAURANTS', 'COFFEE', 'TRAVEL', 'ADVENTURE', 'NATURE', 'CITY',
  'SHOPPING', 'NIGHTLIFE', 'CULTURE', 'HIDDEN GEMS', 'BARS',
] as const;

const PLACE_SYSTEM_PROMPT = `You are a deterministic place extractor.
RULES:
1. Extract ONLY the place(s) the post is ACTUALLY ABOUT (featured, reviewed, recommended, visited). Return them in the "places" array. If none, return [].
2. DO NOT extract places that are merely mentioned, compared to, tagged, or referenced as context. Examples of what to SKIP:
   - "From the team behind @kyma.nyc" → Kyma is background context, NOT the featured place. Skip it.
   - "Better than Carbone" → Carbone is a comparison, NOT the featured place. Skip it.
   - Tagged handles of other restaurants/venues that are not the subject of the post.
   - Collaborator or photographer handles that happen to be venue names.
3. Focus on accurately identifying the PLACE NAME, ADDRESS, and CATEGORY.
4. Category MUST be exactly one of: ${PLACE_CATEGORIES.join(', ')}.
5. A city is only a place if it's the main destination. Otherwise put it in the "city" field.
6. Trust OCR > Audio > Caption > Hashtags.
7. Handle Inference for the FEATURED place only: @selenesoho -> name: Selene, city: New York City, neighborhood: SoHo.
8. Do not extract food as a place.
9. NO geographic hallucinations. E.g. If you see "Brooklyn", map it to New York City, not Australia, unless explicitly stated.
10. ADDRESS IS CRITICAL: Always try to extract or infer the full street address for the featured place. If no address or city can be determined at all, DO NOT include the place.
11. Every place MUST have at least a city. Do not return places where both address and city are empty.
12. Most posts feature only ONE place. Only return multiple if the post genuinely reviews/visits multiple locations (e.g. "Top 5 cafes in NYC").

OUTPUT JSON SCHEMA:
{
  "places": [{
    "name": "string (The featured place name)",
    "category": "string (MUST be from the list above)",
    "neighborhood": "string (or empty)",
    "city": "string (REQUIRED - must not be empty)",
    "address": "string (full street address if known, or empty)",
    "description": "string (1 short sentence max)",
    "confidence": "number (0.5 to 1.0)"
  }]
}`;

const ANALYSIS_SYSTEM_PROMPT = `
You are a location/food intelligence engine.
RULES:
1. Extract ONLY the place(s) the post is ACTUALLY ABOUT (featured, reviewed, recommended, visited) into the "places" array. If none, return [].
2. DO NOT extract places that are merely mentioned, tagged, compared to, or referenced as background context. Examples:
   - "From the team behind @kyma.nyc" → Skip Kyma, it is NOT the featured place.
   - Tagged handles of other venues → Skip unless the post is specifically about that venue.
   - "Reminds me of X" or "Better than Y" → Skip X and Y.
3. Trust OCR > Audio > Caption > Hashtags.
4. Food is NOT a place. Extract foods separately into the featured place's "foods" array.
5. If the FEATURED venue is a handle (e.g. @selenesoho), extract name "Selene", city "New York City", neighborhood "SoHo".
6. Use ONLY these exact categories: RESTAURANTS, COFFEE, TRAVEL, ADVENTURE, NATURE, CITY, SHOPPING, NIGHTLIFE, CULTURE, HIDDEN GEMS, BARS.
7. NO hallucinations. Use null for missing data.
8. ADDRESS IS CRITICAL: Always extract or infer the full street address for the featured place. Every place MUST have at least a city — skip places where both city and address are unknown.
9. Most posts feature ONE place. Only return multiple if the post genuinely reviews/visits multiple locations (e.g. a listicle or multi-stop trip).
OUTPUT JSON SCHEMA:
{
  "places": [{
    "name": "string", "neighborhood": "string|null", "city": "string (REQUIRED)", "address": "string|null",
    "category": "string(from list above)", "description": "short string",
    "source": "string", "confidence": 0.5-1.0,
    "foods": [{ "name": "string", "type": "string", "description": "string", "price": "number|null", "currency": "string|null", "is_signature": "boolean", "source": "string", "confidence": "number" }]
  }],
  "content": { "primary_category": "string", "categories": [], "summary": "string", "topics": [] },
  "audience": { "primary_audience": "string", "interests": [] },
  "creator": { "username": "string" }
}`;



export class AiEnrichmentService {
  // ──────────────────────────────────────────────────────────────────────
  // 1. Place extraction (for the Come With Me map feature)
  // ──────────────────────────────────────────────────────────────────────
  static async extractPlace(
    content: SocialContent,
    transcript: string,
    ocrTexts: string[]
  ): Promise<PlaceExtraction[] | null> {
    const { client, model, isGroq } = getAIClient('chat');

    const userMessage = JSON.stringify({
      platform: content.platform,
      content_type: content.contentType,
      author_username: content.authorUsername,
      author_full_name: content.authorFullName,
      caption: content.caption,
      hashtags: content.hashtags,
      mentions: content.mentions,
      tagged_users: content.taggedUsers.map(u => u.username),
      ocr_texts: ocrTexts,
      audio_transcript: transcript || null,
    });

    const response = await client.chat.completions.create({
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: PLACE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'place_extraction_list',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              places: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    city: { type: 'string' },
                    neighborhood: { type: 'string' },
                    address: { type: 'string' },
                    category: {
                      type: 'string',
                      enum: [...PLACE_CATEGORIES],
                      description: 'One fixed Come With Me map category',
                    },
                    description: { type: 'string' },
                    creator_handle: { type: 'string' },
                    confidence: { type: 'number', minimum: 0.5, maximum: 1 },
                  },
                  required: ['name', 'city', 'neighborhood', 'address', 'category', 'description', 'creator_handle', 'confidence'],
                  additionalProperties: false,
                },
              },
            },
            required: ['places'],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.choices[0].message.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.places || [];
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Full 32-section analysis
  // ──────────────────────────────────────────────────────────────────────
  static compressOcrTexts(texts: string[]): string[] {
    if (!texts || texts.length === 0) return [];

    // 1. Remove stopwords to compress text
    let compressed = texts.map(text => {
      const words = text.split(/\s+/);
      return removeStopwords(words, eng).join(' ').trim();
    }).filter(t => t.length > 2);

    // 2. Fuzzy deduplication (Dice's Coefficient)
    const unique: string[] = [];
    for (const text of compressed) {
      if (unique.length === 0) {
        unique.push(text);
        continue;
      }

      const bestMatch = stringSimilarity.findBestMatch(text.toLowerCase(), unique.map(u => u.toLowerCase()));
      if (bestMatch.bestMatch.rating < 0.85) {
        unique.push(text);
      }
    }

    return unique;
  }

  static extractTranscriptEntities(transcript: string): string {
    if (!transcript || transcript.trim().length === 0) return '';
    const doc = nlp(transcript);
    const places = doc.places().out('array');
    const nouns = doc.nouns().out('array');
    const entities = Array.from(new Set([...places, ...nouns]))
      .filter(w => w.length > 3)
      .slice(0, 30) // Cap to top 30 entities
      .join(', ');
    return entities;
  }

  static async analyzeContent(
    content: SocialContent,
    rawApifyData: any,
    transcript: string,
    gptOcrTexts: string[],
    apifyOcrTexts: string[]
  ): Promise<{ analysis: AiAnalysisResult; places: PlaceExtraction[] } | null> {
    const { client, model, isGroq } = getAIClient('chat');

    const ocrAvailable = gptOcrTexts.length > 0 || apifyOcrTexts.length > 0;
    const transcriptAvailable = !!transcript && transcript.trim().length > 0;

    // Build a condensed version of the raw data for the prompt
    // (avoid sending huge token payloads — send the key fields)
    const condensedInput = {
      platform: content.platform,
      content_type: content.contentType,
      caption: content.caption ? content.caption.substring(0, 400) : '',
      hashtags: content.hashtags,
      mentions: content.mentions,
      author_username: content.authorUsername,
      tagged_users: content.taggedUsers,
      ocr_gpt_vision: AiEnrichmentService.compressOcrTexts(gptOcrTexts).slice(0, 15),
      ocr_apify: AiEnrichmentService.compressOcrTexts(apifyOcrTexts).slice(0, 50),
      whisper_transcript: transcript ? transcript.substring(0, 600) : null,
      transcript_entities: AiEnrichmentService.extractTranscriptEntities(transcript || ''),
    };

    const userMessage = `
Analyze the following social media content and return a complete intelligence analysis as JSON.

=== INPUT DATA ===
${JSON.stringify(condensedInput, null, 2)}

=== MEDIA ANALYSIS AVAILABILITY ===
OCR text available: ${ocrAvailable} (${gptOcrTexts.length} GPT Vision texts, ${apifyOcrTexts.length} Apify OCR texts)
Audio transcript available: ${transcriptAvailable}

Return the full analysis JSON.`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2500,
    });
    const raw = response.choices[0].message.content || '{}';

    // Parse and validate — fill required top-level keys if missing
    const parsedJson = JSON.parse(raw);
    const parsed = (parsedJson || {}) as Partial<AiAnalysisResult>;
    const places = (parsedJson.places || []) as PlaceExtraction[];

    // Ensure all sections exist with safe defaults and merge scraper metadata
    const analysis: AiAnalysisResult = {
      platform: parsed.platform || content.platform,
      content: {
        content_id: content.contentId,
        content_type: content.contentType,
        url: rawApifyData.url || rawApifyData.webVideoUrl || '',
        video_url: content.videoUrl || null,
        thumbnail_url: content.displayUrl || null,
        published_at: content.publishedAt,
        duration_seconds: content.videoDuration,
        dimensions: content.dimensions
          ? { ...content.dimensions, orientation: content.dimensions.height > content.dimensions.width ? 'vertical' : 'horizontal' }
          : null,
        summary: parsed.content?.summary || '',
        primary_category: parsed.content?.primary_category || '',
        secondary_categories: parsed.content?.secondary_categories || [],
        topics: parsed.content?.topics || [],
        keywords: parsed.content?.keywords || [],
      },
      creator: {
        id: rawApifyData.ownerId || rawApifyData.authorMeta?.id || '',
        username: content.authorUsername,
        full_name: content.authorFullName,
        profile_url: parsed.creator?.profile_url || null,
        verified: parsed.creator?.verified || null,
      },
      caption_analysis: {
        original_caption: content.caption,
        summary: parsed.caption_analysis?.summary || '',
        keywords: parsed.caption_analysis?.keywords || [],
        hashtags: content.hashtags,
        mentions: content.mentions,
        call_to_actions: parsed.caption_analysis?.call_to_actions || [],
      },
      entities: parsed.entities || { brands: [], products: [], companies: [], restaurants: [], services: [], people: [], locations: [], websites: [] },
      visual_analysis: parsed.visual_analysis || { visible_text: [], products_visible: [], brands_visible: [], people_visible: [], locations_visible: [], objects_visible: [], logos_visible: [] },
      audio_analysis: parsed.audio_analysis || {
        artist: content.musicInfo?.artist_name || null,
        song_name: content.musicInfo?.song_name || null,
        audio_id: content.musicInfo?.audio_id || null,
        uses_original_audio: content.musicInfo?.uses_original_audio || null,
        transcript: transcript || null,
        spoken_information: [],
      },
      promotion: {
        is_promotional: parsed.promotion?.is_promotional ?? null,
        is_sponsored: parsed.promotion?.is_sponsored ?? null,
        is_paid_partnership: parsed.promotion?.is_paid_partnership ?? content.paidPartnership,
        promotion_type: parsed.promotion?.promotion_type || null,
        promoted_entities: parsed.promotion?.promoted_entities || [],
        offers: parsed.promotion?.offers || [],
        discounts: parsed.promotion?.discounts || [],
        call_to_actions: parsed.promotion?.call_to_actions || [],
      },
      audience: {
        primary_audience: parsed.audience?.primary_audience || '',
        interests: parsed.audience?.interests || [],
        geographic_focus: parsed.audience?.geographic_focus || [],
        intent: parsed.audience?.intent || '',
        confidence: parsed.audience?.confidence || 0,
      },
      content_style: {
        tone: parsed.content_style?.tone || [],
        style: parsed.content_style?.style || [],
        format: parsed.content_style?.format || '',
      },
      engagement: parsed.engagement || {
        likes: content.metrics.likes,
        comments: content.metrics.comments,
        shares: content.metrics.shares,
        saves: content.metrics.saves,
        views: content.metrics.views,
        plays: content.metrics.plays,
        reach: null,
        impressions: null,
        engagement_rate: null,
        engagement_rate_formula: null,
      },
      hashtags: parsed.hashtags || { all: content.hashtags, brand: [], product: [], industry: [], location: [], campaign: [], topic: [], generic: [] },
      campaign_insights: parsed.campaign_insights || { relevant_industries: [], relevant_brand_categories: [], relevant_product_categories: [], relevant_audiences: [], relevant_locations: [], potential_campaign_themes: [], potential_collaboration_categories: [], campaign_suitability: '', reasoning: '' },
      influencer_analysis: {
        niche: parsed.influencer_analysis?.niche || '',
        sub_niches: parsed.influencer_analysis?.sub_niches || [],
        content_strengths: parsed.influencer_analysis?.content_strengths || [],
        potential_collaboration_types: parsed.influencer_analysis?.potential_collaboration_types || [],
        potential_brand_categories: parsed.influencer_analysis?.potential_brand_categories || [],
      },
      data_quality: parsed.data_quality || {
        available_fields: Object.keys(condensedInput).filter(k => (condensedInput as any)[k] != null),
        missing_fields: [],
        unavailable_metrics: Object.entries(content.metrics).filter(([, v]) => v === null).map(([k]) => k),
        media_analysis_available: ocrAvailable || transcriptAvailable,
        ocr_available: ocrAvailable,
        transcript_available: transcriptAvailable,
      },
      extracted_information: parsed.extracted_information || [],
    };

    return { analysis, places };
  }
}
