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
2. SKIP background context, team history, or comparisons. EXAMPLES TO SKIP:
   - "From the team behind [Venue A]" -> Extract ONLY [Venue B]. SKIP [Venue A].
   - "From creators of X" / "By owners of Y" -> SKIP X and Y.
   - "Better than Z" / "Reminds me of Z" -> SKIP Z.
   - Tagged handles of other non-subject venues.
3. Clean handle names (e.g. "@[handle]" -> Name: "[Handle]").
4. Category MUST be exactly one of: ${PLACE_CATEGORIES.join(', ')}.
5. ADDRESS IS CRITICAL: Look closely for location pins (📍, 📌, 🗺️), street numbers & names (e.g. "305 Schermerhorn St"), or addresses anywhere in caption, OCR, or transcript. Extract full street address into "address". NEVER leave address null if street address or pin exists!
6. A borough or area (e.g. "Brooklyn", "SoHo") goes in "city" or "neighborhood". Do not invent non-existent cities.
7. Food is NOT a place.
8. Most posts feature only 1 place. Only return multiple if post genuinely reviews/visits multiple distinct venues.

OUTPUT JSON SCHEMA:
{
  "places": [{
    "name": "string (Featured place name)",
    "category": "string (MUST be from list above)",
    "neighborhood": "string|null",
    "city": "string (REQUIRED, e.g. Brooklyn, New York)",
    "address": "string|null (Full street address, e.g. 305 Schermerhorn St)",
    "description": "string (1 short sentence max)",
    "confidence": "number (0.5 to 1.0)"
  }]
}`;

const ANALYSIS_SYSTEM_PROMPT = `You are a location and content intelligence engine.
RULES:
1. Extract ALL places/restaurants ACTUALLY featured, visited, or reviewed in the post into "places". If none, return [].
2. SKIP background context, team history, or comparisons. EXAMPLES TO SKIP:
   - "From team behind [Venue A]" -> Extract [Venue B]. SKIP [Venue A].
   - "From creators of X" / "By owners of Y" / "Better than Z" -> SKIP X, Y, Z.
3. Clean handle names (e.g. "@[handle]" -> Name: "[Handle]").
4. Food is NOT a place. Put dishes in the place's "foods" array.
5. Category MUST be one of: ${PLACE_CATEGORIES.join(', ')}.
6. ADDRESS IS CRITICAL: Look closely for location pins (📍, 📌, 🗺️), street numbers/names (e.g. "305 Schermerhorn St"), or addresses anywhere in caption, OCR, or transcript. Extract full street address into "address". NEVER leave address null if street address or pin exists!

OUTPUT JSON SCHEMA:
{
  "places": [{
    "name": "string", "neighborhood": "string|null", "city": "string (REQUIRED)", "address": "string|null",
    "category": "string", "description": "short string", "confidence": 0.5-1.0,
    "foods": [{ "name": "string", "type": "string", "description": "string", "price": "number|null", "currency": "string|null", "is_signature": "boolean" }]
  }],
  "content": { "primary_category": "string", "summary": "1 sentence", "topics": [] },
  "audience": { "primary_audience": "string" },
  "creator": { "username": "string" }
}`;

export class AiEnrichmentService {
  static formatCondensedCaption(caption: string | null | undefined, maxLen = 1000): string {
    if (!caption) return '';
    const trimmed = caption.trim();
    if (trimmed.length <= maxLen) return trimmed;

    const lines = trimmed.split('\n');
    const locationRegex = /(📍|📌|🗺️|located|location|address|st\b|street|ave\b|avenue|blvd|rd\b|road|dr\b|drive|way\b|unit|suite|#)/i;

    const importantLines: string[] = [];
    let charCount = 0;

    for (const line of lines) {
      const isLoc = locationRegex.test(line);
      if (charCount < 400 || isLoc) {
        importantLines.push(line);
        charCount += line.length + 1;
      }
    }

    return importantLines.join('\n').substring(0, maxLen);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Place extraction (for map feature)
  // ──────────────────────────────────────────────────────────────────────
  static async extractPlace(
    content: SocialContent,
    transcript: string,
    ocrTexts: string[]
  ): Promise<PlaceExtraction[] | null> {
    const { client, model, isGroq } = getAIClient('chat');

    const condensedInput = {
      platform: content.platform,
      caption: AiEnrichmentService.formatCondensedCaption(content.caption, 1000),
      author_username: content.authorUsername,
      tagged_users: (content.taggedUsers || []).map(u => typeof u === 'string' ? u : u.username).slice(0, 5),
      ocr_texts: ocrTexts.slice(0, 8),
      audio_transcript: transcript ? transcript.substring(0, 200) : null,
    };

    const responseFormat: any = isGroq
      ? { type: 'json_object' }
      : {
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
                      description: 'One fixed map category',
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
      };

    const response = await client.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: PLACE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(condensedInput) },
      ],
      response_format: responseFormat,
    });

    const raw = response.choices[0].message.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.places || [];
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Full analysis
  // ──────────────────────────────────────────────────────────────────────
  static compressOcrTexts(texts: string[]): string[] {
    if (!texts || texts.length === 0) return [];

    let compressed = texts.map(text => {
      const words = text.split(/\s+/);
      return removeStopwords(words, eng).join(' ').trim();
    }).filter(t => t.length > 2);

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
      .slice(0, 15)
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
    const { client, model } = getAIClient('chat');

    const condensedOcr = [
      ...AiEnrichmentService.compressOcrTexts(gptOcrTexts).slice(0, 5),
      ...AiEnrichmentService.compressOcrTexts(apifyOcrTexts).slice(0, 5)
    ].slice(0, 8);

    const condensedInput = {
      platform: content.platform,
      content_type: content.contentType,
      caption: AiEnrichmentService.formatCondensedCaption(content.caption, 1000),
      hashtags: (content.hashtags || []).slice(0, 5),
      mentions: (content.mentions || []).slice(0, 5),
      author_username: content.authorUsername,
      tagged_users: (content.taggedUsers || []).map(u => typeof u === 'string' ? u : u.username).slice(0, 5),
      ocr_text: condensedOcr,
      whisper_transcript: transcript ? transcript.substring(0, 200) : null,
      transcript_entities: AiEnrichmentService.extractTranscriptEntities(transcript || ''),
    };

    const ocrAvailable = gptOcrTexts.length > 0 || apifyOcrTexts.length > 0;
    const transcriptAvailable = !!transcript && transcript.trim().length > 0;

    const userMessage = `Analyze the following social media content and return intelligence analysis as JSON:
=== INPUT DATA ===
${JSON.stringify(condensedInput, null, 2)}

=== MEDIA AVAILABILITY ===
OCR: ${ocrAvailable} (${gptOcrTexts.length} Vision, ${apifyOcrTexts.length} Apify)
Audio Transcript: ${transcriptAvailable}`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
    });
    const raw = response.choices[0].message.content || '{}';

    const parsedJson = JSON.parse(raw);
    const parsed = (parsedJson || {}) as Partial<AiAnalysisResult>;
    const places = (parsedJson.places || []) as PlaceExtraction[];

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
