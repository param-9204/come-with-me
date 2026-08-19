/**
 * AiEnrichmentService — Full 32-Section Social Media Intelligence Analysis
 *
 * Implements the complete analysis prompt described in the project brief.
 * Input:  raw Apify JSON + Whisper transcript + OCR frame texts
 * Output: structured AiAnalysisResult covering all 32 sections
 */

import OpenAI from 'openai';
import type { SocialContent, AiAnalysisResult, PlaceExtraction } from '../types/social';

const PLACE_SYSTEM_PROMPT = `You are a place extraction assistant for the social map app "Come With Me".
Your job is to extract all physical places (restaurants, cafes, bars, shops, hotels, attractions, destinations) from social media posts.

=== DYNAMIC CATEGORIZATION GUIDE ===
Determine a highly precise, hyper-specific category for each place by analyzing all video details (OCR text, audio transcripts, caption keywords, hashtags, and social handles):
1. TRIANGULATE EVIDENCE & KEYWORDS:
   - Scan OCR text and audio transcripts for specific culinary, beverage, or retail clues:
     - Keywords "espresso", "latte", "pour over", "roaster" -> "Specialty Coffee Roastery & Cafe"
     - Keywords "croissant", "pastry", "sourdough", "baguette", "bakery" -> "Artisanal Bakery & Cafe"
     - Keywords "natural wine", "orange wine", "biodynamic" -> "Natural Wine Bar"
     - Keywords "speakeasy", "hidden entrance", "secret door" -> "Speakeasy Cocktail Lounge"
     - Keywords "omakase", "nigiri", "sushi chef" -> "Omakase Sushi Bar"
     - Keywords "neapolitan", "woodfired", "pizza", "pizzeria" -> "Neapolitan Pizzeria"
     - Keywords "matcha", "whisk", "ceremonial" -> "Artisanal Matcha Bar"
2. SPECIFICITY OVER GENERALITY:
   - Avoid generic terms like "Restaurant", "Bar", "Shop", or "Cafe". Instead, capture the exact cuisine style, vibe, and format:
     - Dining Styles: Use "Japanese Omakase Spot", "Italian Osteria", "Ramen & Gyoza Shop", "Argentine Steakhouse", "French Bistro", "Spanish Tapas Bar", "Greek Taverna", "Taco Stand", "Korean BBQ Restaurant", "Brunch Cafe", "Artisanal Dessert Parlor".
     - Beverage & Nightlife: Use "Rooftop Cocktail Bar", "Speakeasy Cocktail Lounge", "Natural Wine Bar", "Craft Brewery Taproom", "Specialty Matcha Bar", "Third-Wave Coffee Shop", "Specialty Boba Shop".
     - Specialized Retail: Use "Vintage Apparel Store", "Concept Lifestyle Store", "Aesthetic Stationery Shop", "Artisanal Pastry Shop", "Independent Bookstore", "Fine Cheese & Wine Shop".
     - Sightseeing & Attractions: Use "Contemporary Art Gallery", "Scenic Lookout Point", "Botanical Garden", "Amusement Park Ride", "Historical Landmark Palace", "Public Beach & Boardwalk", "Hiking Trailhead".
3. COMBINED / MULTI-PURPOSE VENUES: If a place offers dual services (e.g., bookstore cafe or natural wine bar restaurant), use a descriptive combined name like "Bookstore & Cafe" or "Natural Wine Bar & Bistro".
4. FORMATTING: Always capitalize each word of the category (e.g., "Speakeasy Cocktail Lounge", "Artisanal Bakery & Cafe").
5. FALLBACK RULE: Only use basic broad categories ("Restaurant", "Cafe", "Bar", "Shop", "Hotel", "Attraction") if there is absolutely no specific context.

=== CRITICAL RULES & INSTRUCTIONS ===
1. OUTPUT: Return ONLY valid JSON matching the schema. No markdown fences. If no places are found, return "places": [].
2. MULTI-ENTITY: Extract ALL distinct physical locations.
3. EVIDENCE PRIORITY: Visual Signage (OCR storefront/decor) > Spoken Words (Audio) > Location Metadata > Caption Place Names > Tagged Venue Handles > Hashtags > Geographic Inference.
4. ATTRIBUTES:
   - category: Use the dynamic category derived using the DYNAMIC CATEGORIZATION GUIDE above.
   - confidence: 0.0 to 1.0 (1.0 = explicit, 0.5 = handle inference).
   - city: Best guess (e.g. from context or handle suffix). Leave blank/null if unclear. Do NOT guess or default.
   - neighborhood & address: Extract ONLY if explicitly supported by inputs. Do not guess/hallucinate.
   - creator_handle: Prefix with @. Use the post author's username, NOT the venue's handle.
5. PLACE VS CITY/FOOD:
   - Specific attraction name is the place, not the city (e.g. name="Taj Mahal", city="Agra").
   - For travel guides, map actual destinations recommended (e.g. "Goa"), not generic context (e.g. "India").
   - Food is NOT a place. Extract the restaurant name, not the menu item (e.g. name="XYZ", NOT name="Butter Chicken").
6. HANDLE INFERENCE: If the venue is referenced only as a tagged handle (e.g. @tashca.nyc, @carbone_la), strip the "@" and city suffixes to get the venue name (e.g. "Tashca", "Carbone") and map the suffix to the city (.nyc -> New York, .la -> Los Angeles, .miami -> Miami, .chi -> Chicago, .sf -> San Francisco, .dc -> Washington DC, .nola -> New Orleans, .atx -> Austin, .london/.uk -> London, .delhi -> Delhi, .bom/.mumbai -> Mumbai, .blr -> Bengaluru). Inferred places have confidence = 0.5.
7. OCR NOISE: Ignore base64 strings, technical scripts, HTML, or random symbols. Synthesize partial OCR words.
`;

const ANALYSIS_SYSTEM_PROMPT = `
You are the location and food intelligence engine for "Come With Me", a social mapping, travel, and restaurant discovery app.
Your job is to analyze social media scraper data, OCR frame results, and audio transcripts to extract structured data.

=== CRITICAL RULES & INSTRUCTIONS ===
1. MULTI-ENTITY EXTRACTION: A single post can contain multiple places. Extract EVERY physical place, attraction, business, or destination. Do NOT select only the first or most prominent. Return all in the "places" array. If none are found, return "places": [].
2. DATA TRIANGULATION: Synthesize all inputs. Transcripts (audio) and OCR (menus, signage) are highly accurate and override vague captions.
3. EVIDENCE PRIORITY: Trust evidence in this order: Visual Signage (OCR) > Spoken Words (Audio) > Location Metadata > Explicit Caption Names > Tagged Venue Handles > Hashtags.
4. WHAT IS A PLACE: Physical destinations (states, islands, lakes), attractions (landmarks, historical sites, palaces), or businesses (restaurants, bars, shops). Use the dynamic category derived using the DYNAMIC CATEGORIZATION GUIDE below. Do NOT mix up specific attractions with their city (e.g. name="Taj Mahal", city="Agra", category="Historical Landmark", NOT name="Agra").

=== DYNAMIC CATEGORIZATION GUIDE ===
Determine a highly precise, hyper-specific category for each place by analyzing all video details (OCR text, audio transcripts, caption keywords, hashtags, and social handles):
1. TRIANGULATE EVIDENCE & KEYWORDS:
   - Scan OCR text and audio transcripts for specific culinary, beverage, or retail clues:
     - Keywords "espresso", "latte", "pour over", "roaster" -> "Specialty Coffee Roastery & Cafe"
     - Keywords "croissant", "pastry", "sourdough", "baguette", "bakery" -> "Artisanal Bakery & Cafe"
     - Keywords "natural wine", "orange wine", "biodynamic" -> "Natural Wine Bar"
     - Keywords "speakeasy", "hidden entrance", "secret door" -> "Speakeasy Cocktail Lounge"
     - Keywords "omakase", "nigiri", "sushi chef" -> "Omakase Sushi Bar"
     - Keywords "neapolitan", "woodfired", "pizza", "pizzeria" -> "Neapolitan Pizzeria"
     - Keywords "matcha", "whisk", "ceremonial" -> "Artisanal Matcha Bar"
2. SPECIFICITY OVER GENERALITY:
   - Avoid generic terms like "Restaurant", "Bar", "Shop", or "Cafe". Instead, capture the exact cuisine style, vibe, and format:
     - Dining Styles: Use "Japanese Omakase Spot", "Italian Osteria", "Ramen & Gyoza Shop", "Argentine Steakhouse", "French Bistro", "Spanish Tapas Bar", "Greek Taverna", "Taco Stand", "Korean BBQ Restaurant", "Brunch Cafe", "Artisanal Dessert Parlor".
     - Beverage & Nightlife: Use "Rooftop Cocktail Bar", "Speakeasy Cocktail Lounge", "Natural Wine Bar", "Craft Brewery Taproom", "Specialty Matcha Bar", "Third-Wave Coffee Shop", "Specialty Boba Shop".
     - Specialized Retail: Use "Vintage Apparel Store", "Concept Lifestyle Store", "Aesthetic Stationery Shop", "Artisanal Pastry Shop", "Independent Bookstore", "Fine Cheese & Wine Shop".
     - Sightseeing & Attractions: Use "Contemporary Art Gallery", "Scenic Lookout Point", "Botanical Garden", "Amusement Park Ride", "Historical Landmark Palace", "Public Beach & Boardwalk", "Hiking Trailhead".
3. COMBINED / MULTI-PURPOSE VENUES: If a place offers dual services (e.g., bookstore cafe or natural wine bar restaurant), use a descriptive combined name like "Bookstore & Cafe" or "Natural Wine Bar & Bistro".
4. FORMATTING: Always capitalize each word of the category (e.g., "Speakeasy Cocktail Lounge", "Artisanal Bakery & Cafe").
5. FALLBACK RULE: Only use basic broad categories ("Restaurant", "Cafe", "Bar", "Shop", "Hotel", "Attraction") if there is absolutely no specific context.
5. RESTAURANTS & FOOD LOGIC: Food is NOT a place. Extract food items separately and link them to their associated place via the "foods" array.
   - Extract name, type, description, price, currency, source, confidence, and is_signature.
   - "is_signature" is true ONLY if explicitly described as signature, famous, must-try, viral, bestselling, etc.
   - Price and currency should be extracted ONLY if explicitly stated or shown in OCR.
6. OCR NOISE: Ignore technical metadata, HTML tags, scripts, base64 strings, or single-character noise. Synthesize text fragments across frames.
7. SOCIAL HANDLE INFERENCE: If a venue is referenced only as a handle (e.g. @tashca.nyc, @carbone_la), extract it as the venue (e.g. "Tashca", "Carbone") and map the suffix to the city (.nyc -> New York, .la -> Los Angeles, .miami -> Miami, .chi -> Chicago, .sf -> San Francisco, .dc -> Washington DC, .nola -> New Orleans, .atx -> Austin, .london/.uk -> London, .delhi -> Delhi, .bom/.mumbai -> Mumbai, .blr -> Bengaluru). Inferred places have confidence = 0.5.
8. CREATOR & METRICS: Calculate engagement_rate = ((likes + comments) / views) * 100 if those metrics are valid. If likesCount is -1, likes = null. paidPartnership status is authoritative. creator_handle must map to the author's username (prefixed with @), NOT a venue handle.
9. CITY RESOLUTION: Determine city using address, audio, OCR, metadata, caption, or handle suffix. Leave blank/null if it cannot be determined.
10. NO HALLUCINATION: Never fabricate details. Use null for unavailable optional scalars, [] for arrays, and "" for empty strings.
11. DEDUPLICATION: Merge identical places into one, but keep different branches of the same business separate.
 
=== REQUIRED OUTPUT STRUCTURE ===
Return ONLY valid JSON matching this exact structure:
{
  "places": [
    {
      "name": "Place Name or null",
      "city": "City Name",
      "country": "Country Name or null",
      "neighborhood": "Neighborhood or \"\"",
      "address": "Address or \"\"",
      "category": "Dynamic category (e.g. Rooftop Bar, Italian Restaurant, Dessert Shop, Cocktail Lounge, Boutique Hotel, etc.)",
      "description": "Factual description",
      "creator_handle": "Creator Handle or \"\"",
      "source": "visual | ocr | audio | caption | metadata | hashtag | handle | comment | inference",
      "confidence": 0.0 to 1.0,
      "foods": [
        {
          "name": "Food Name",
          "type": "Main dish | Starter | Dessert | Snack | Street food | Breakfast | Lunch | Dinner | Beverage | Coffee | Tea | Cocktail | Bakery | Fast food",
          "description": "Description",
          "price": number or null,
          "currency": "USD | INR | etc. or null",
          "is_signature": false,
          "source": "caption | ocr | audio | inference",
          "confidence": 0.0 to 1.0
        }
      ],
      "activities": [],
      "highlights": []
    }
  ],
  "content": {
    "primary_category": "Travel | Food | Restaurant | Coffee | Nightlife | Shopping | Hotels | Attractions | Local Experience",
    "categories": [],
    "niches": [],
    "summary": "1-2 sentence detailed summary of the post",
    "topics": ["main topic 1", "main topic 2"],
    "keywords": ["keyword1", "keyword2"]
  },
  "content_style": {
    "tone": ["excited | informative | aesthetic | humorous | etc."],
    "style": [],
    "format": ""
  },
  "influencer_analysis": {
    "niche": "Main niche, e.g. Budget Travel, Cafe Reviews, Street Food"
  },
  "audience": {
    "primary_audience": "e.g. foodies, travelers",
    "interests": [],
    "geographic_focus": [],
    "intent": "",
    "confidence": 0.0 to 1.0
  },
  "promotion": {
    "is_promotional": true | false | null,
    "is_sponsored": true | false | null,
    "is_paid_partnership": true | false | null,
    "promotion_type": null,
    "promoted_entities": [],
    "offers": [],
    "discounts": [],
    "call_to_actions": []
  },
  "creator": {
    "handle": "",
    "full_name": "",
    "username": "",
    "confidence": 0.0
  },
  "metrics": {
    "likes": null,
    "comments": null,
    "shares": null,
    "saves": null,
    "views": null,
    "plays": null,
    "reach": null,
    "impressions": null,
    "engagement_rate": null
  },
  "partnership": {
    "is_paid_partnership": null
  }
}
`;


export class AiEnrichmentService {
  private static getClient() {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1. Place extraction (for the Come With Me map feature)
  // ──────────────────────────────────────────────────────────────────────
  static async extractPlace(
    content: SocialContent,
    transcript: string,
    ocrTexts: string[]
  ): Promise<PlaceExtraction[] | null> {
    const openai = this.getClient();

    const userMessage = `
Platform: ${content.platform}
Type: ${content.contentType}
Author: ${content.authorUsername} (${content.authorFullName})
Caption: "${content.caption}"
Hashtags: ${content.hashtags.join(', ')}
Mentions: ${content.mentions.join(', ')}
Tagged users: ${content.taggedUsers.map(u => u.username).join(', ')}
OCR Text (visible on screen): ${ocrTexts.length > 0 ? ocrTexts.join(' | ') : 'None'}
Audio Transcript: "${transcript || 'None'}"

Extract all places/location details.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
                    name: { type: ['string', 'null'] },
                    city: { type: 'string' },
                    neighborhood: { type: 'string' },
                    address: { type: 'string' },
                    category: { type: 'string', description: 'A precise, dynamic category representing what kind of place this is (e.g. "Rooftop Bar", "Italian Restaurant", "Museum", "Boutique Hotel", "Scenic Lookout", "Boba Shop", etc.)' },
                    description: { type: 'string' },
                    creator_handle: { type: 'string' },
                    confidence: { type: 'number' },
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
  static async analyzeContent(
    content: SocialContent,
    rawApifyData: any,
    transcript: string,
    gptOcrTexts: string[],
    apifyOcrTexts: string[]
  ): Promise<AiAnalysisResult | null> {
    const openai = this.getClient();

    const ocrAvailable = gptOcrTexts.length > 0 || apifyOcrTexts.length > 0;
    const transcriptAvailable = !!transcript && transcript.trim().length > 0;

    // Build a condensed version of the raw data for the prompt
    // (avoid sending huge token payloads — send the key fields)
    const condensedInput = {
      platform: content.platform,
      content_id: content.contentId,
      content_type: content.contentType,
      short_code: content.shortCode,
      url: rawApifyData.url || rawApifyData.webVideoUrl || '',
      video_url: content.videoUrl,
      thumbnail_url: content.displayUrl,
      published_at: content.publishedAt,
      duration_seconds: content.videoDuration,
      dimensions: content.dimensions,
      caption: content.caption,
      hashtags: content.hashtags,
      mentions: content.mentions,
      author_username: content.authorUsername,
      author_full_name: content.authorFullName,
      author_id: rawApifyData.ownerId || rawApifyData.authorMeta?.id || null,
      tagged_users: content.taggedUsers,
      music_info: content.musicInfo,
      product_type: content.productType,
      paid_partnership: content.paidPartnership,
      metrics: {
        likes: content.metrics.likes,
        views: content.metrics.views,
        plays: content.metrics.plays,
        comments: content.metrics.comments,
        shares: content.metrics.shares,
        saves: content.metrics.saves,
      },
      // OCR results (our key addition)
      ocr_gpt_vision: gptOcrTexts.slice(0, 30),
      ocr_apify: apifyOcrTexts.slice(0, 30),
      // Audio transcript
      whisper_transcript: transcript || null,
    };

    const userMessage = `
Analyze the following social media content and return a complete intelligence analysis as JSON.

=== INPUT DATA ===
${JSON.stringify(condensedInput, null, 2)}

=== MEDIA ANALYSIS AVAILABILITY ===
OCR text available: ${ocrAvailable} (${gptOcrTexts.length} GPT Vision texts, ${apifyOcrTexts.length} Apify OCR texts)
Audio transcript available: ${transcriptAvailable}

Return the full analysis JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
    });
    const raw = response.choices[0].message.content || '{}';

    // Parse and validate — fill required top-level keys if missing
    const parsed = JSON.parse(raw) as Partial<AiAnalysisResult>;

    // Ensure all sections exist with safe defaults and merge scraper metadata
    return {
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
  }
}
