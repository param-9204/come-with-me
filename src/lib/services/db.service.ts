import { supabaseAdmin } from '../supabase';
import type { SocialContent, AiAnalysisResult, ApifyOcrFrameResult, GptVisionFrameResult, PlaceExtraction } from '../types/social';
import { LocationService } from './location.service';

export interface PlaceInput {
  name: string | null;
  city: string;
  neighborhood: string;
  address: string;
  category: string;
  description: string;
  creator_handle: string;
  confidence: number;
}

export class DbService {
  // ──────────────────────────────────────────────────────────────────
  // Save / upsert a place (Come With Me map entity)
  // ──────────────────────────────────────────────────────────────────
  static async savePlace(
    placeData: PlaceInput,
    sourceUrl: string,
    sourcePlatform: string,
    audioTranscript?: string,
    userId?: string
  ): Promise<string | null> {
    if (!placeData.name) {
      console.warn('[DB] Place name is null — skipping insert.');
      return null;
    }

    let lat: number | null = null;
    let lng: number | null = null;
    let neighborhood = placeData.neighborhood;
    let address = placeData.address;

    const coords = await LocationService.geocodePlace(placeData.name, placeData.city || '', placeData.address);
    lat = coords.lat;
    lng = coords.lng;
    if (coords.formattedAddress && !address) {
      address = coords.formattedAddress;
    }

    if (!neighborhood && lat && lng) {
      neighborhood = await LocationService.getNeighborhood(lat, lng);
    }

    // Ensure the city is recorded in our cities table
    const cityName = (placeData.city || '').trim();
    if (cityName) {
      try {
        let cityLat: number | null = null;
        let cityLng: number | null = null;
        try {
          const cityCoords = await LocationService.geocodePlace('', cityName);
          if (cityCoords.lat && cityCoords.lng) {
            cityLat = cityCoords.lat;
            cityLng = cityCoords.lng;
          }
        } catch (geoErr) {
          console.warn('[DB] Failed to geocode city center coordinates:', geoErr);
        }

        await supabaseAdmin
          .from('cities')
          .upsert({ 
            name: cityName,
            latitude: cityLat,
            longitude: cityLng
          }, { onConflict: 'name' });
      } catch (err) {
        console.error('[DB] Failed to upsert city:', err);
      }
    }

    // Idempotent: skip if place already exists
    const { data: existing } = await supabaseAdmin
      .from('places')
      .select('id')
      .ilike('name', placeData.name.trim())
      .ilike('city', (placeData.city || '').trim())
      .maybeSingle();

    if (existing) {
      console.log(`[DB] Place already exists: ${existing.id}`);
      return existing.id;
    }

    const { data: newPlace, error } = await supabaseAdmin
      .from('places')
      .insert({
        name: placeData.name.trim(),
        address: address || '',
        city: placeData.city || '',
        neighborhood,
        category: placeData.category || 'Restaurants',
        description: placeData.description || '',
        source: sourcePlatform,
        creator_handle: placeData.creator_handle || '',
        source_url: sourceUrl || '',
        audio_transcript: audioTranscript || '',
        latitude: lat,
        longitude: lng,
        user_id: userId || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[DB] Place insert error:', error);
      throw new Error(`Failed to save place: ${error.message}`);
    }

    console.log(`[DB] New place saved: ${placeData.name} (${newPlace.id})`);
    return newPlace.id;
  }

  // ──────────────────────────────────────────────────────────────────
  // Save the full social post with ALL data
  // ──────────────────────────────────────────────────────────────────
  static async saveSocialPost(
    content: SocialContent,
    rawApifyData: any,
    aiAnalysis: AiAnalysisResult | null,
    apifyOcrFrames: ApifyOcrFrameResult[],
    gptOcrFrames: GptVisionFrameResult[],
    transcript: string,
    placeIds: string[],
    sourceUrl: string,
    userId?: string,
    socialPostId?: string
  ): Promise<string | null> {
    console.log(`[DB] Saving full social post for ${content.platform}/${content.contentId}...`);

    // Build combined OCR text (searchable plain text field)
    const gptTexts = [...new Set(gptOcrFrames.flatMap(f => f.texts).filter(Boolean))];
    const apifyTexts = [...new Set(apifyOcrFrames.flatMap(f => f.texts).filter(Boolean))];
    const combinedOcrText = [...new Set([...gptTexts, ...apifyTexts])].join(' ');

    // Extract top-level analysis fields for indexed columns
    const primaryCategory = aiAnalysis?.content?.primary_category || null;
    const secondaryCategories = aiAnalysis?.content?.secondary_categories || [];
    const contentSummary = aiAnalysis?.content?.summary || null;
    const mentionedBrands = aiAnalysis
      ? [
        ...aiAnalysis.entities.brands.map(b => b.name),
        ...aiAnalysis.visual_analysis.brands_visible,
      ].filter((v, i, a) => v && a.indexOf(v) === i)
      : [];
    const mentionedLocations = aiAnalysis
      ? aiAnalysis.entities.locations.map(l => l.name).filter(Boolean)
      : [];
    const callToActions = aiAnalysis?.promotion?.call_to_actions || [];
    const niche = aiAnalysis?.influencer_analysis?.niche || null;
    const targetAudience = aiAnalysis?.audience?.primary_audience || null;

    // Compute engagement rate if possible
    let engagementRate: number | null = null;
    const likes = content.metrics.likes;
    const comments = content.metrics.comments;
    const views = content.metrics.views;
    if (likes !== null && comments !== null && views && views > 0) {
      engagementRate = parseFloat(((likes + comments) / views * 100).toFixed(4));
    }

    const payload = {
      // ── Place link ──────────────────────────────
      place_id: placeIds.length > 0 ? placeIds[0] : null,

      // ── User association ────────────────────────
      user_id: userId || null,

      // ── Platform / type ─────────────────────────
      platform: content.platform,
      content_type: content.contentType,
      content_id: content.contentId,
      product_type: content.productType,
      short_code: content.shortCode,

      // ── Original source link ────────────────────
      post_url: sourceUrl || null,

      // ── Creator ─────────────────────────────────
      author_username: content.authorUsername,
      owner_full_name: content.authorFullName,

      // ── Content ─────────────────────────────────
      caption: content.caption,
      video_url: content.videoUrl || '',
      display_url: content.displayUrl || '',
      first_comment: rawApifyData?.firstComment || null,

      // ── Metrics ─────────────────────────────────
      likes: content.metrics.likes != null ? Math.round(Number(content.metrics.likes)) : 0,
      views: content.metrics.views != null ? Math.round(Number(content.metrics.views)) : 0,
      comments: content.metrics.comments != null ? Math.round(Number(content.metrics.comments)) : 0,
      video_plays: content.metrics.plays != null ? Math.round(Number(content.metrics.plays)) : null,
      engagement_rate: engagementRate,

      // ── Video metadata ──────────────────────────
      video_duration: content.videoDuration != null ? Math.round(Number(content.videoDuration)) : null,
      dimensions_width: content.dimensions?.width != null ? Math.round(Number(content.dimensions.width)) : null,
      dimensions_height: content.dimensions?.height != null ? Math.round(Number(content.dimensions.height)) : null,

      // ── Social graph ────────────────────────────
      hashtags: content.hashtags,
      mentions: content.mentions,
      tagged_users: content.taggedUsers?.length ? content.taggedUsers : null,
      music_info: content.musicInfo || null,

      // ── Commercial ──────────────────────────────
      is_paid_partnership: content.paidPartnership,
      is_promotional: aiAnalysis?.promotion?.is_promotional ?? null,

      // ── AI Analysis ─────────────────────────────
      mentioned_brands: mentionedBrands.length ? mentionedBrands : null,
      mentioned_locations: mentionedLocations.length ? mentionedLocations : null,
      primary_category: primaryCategory,
      secondary_categories: secondaryCategories.length ? secondaryCategories : null,
      content_summary: contentSummary,
      niche,
      target_audience: targetAudience,
      call_to_actions: callToActions.length ? callToActions : null,

      // ── Media analysis ──────────────────────────
      whisper_transcript: transcript || null,
      ocr_combined_text: combinedOcrText || null,
      ocr_frames_apify: apifyOcrFrames.length ? apifyOcrFrames : null,
      ocr_frames_gpt: gptOcrFrames.length ? gptOcrFrames : null,

      // ── Raw data (stored as-is, never modified) ─
      raw_apify_data: rawApifyData || null,
      ai_analysis: aiAnalysis || null,
    };

    const finalPayload = {
      ...payload,
      status: 'completed',
      error_message: null
    };

    let query;
    if (socialPostId) {
      query = supabaseAdmin
        .from('social_posts')
        .update(finalPayload)
        .eq('id', socialPostId);
    } else {
      query = supabaseAdmin
        .from('social_posts')
        .upsert(finalPayload, { onConflict: 'platform, content_id' });
    }

    const { data, error } = await query
      .select('id')
      .single();

    if (error) {
      // Handle unique constraint duplicate violation by updating canonical row and resolving placeholder
      if (error.code === '23505' && socialPostId) {
        console.log(`[DB] Social post already exists. Merging payload into existing post...`);
        const { data: existingPost } = await supabaseAdmin
          .from('social_posts')
          .select('id')
          .eq('platform', payload.platform)
          .eq('content_id', payload.content_id)
          .single();

        if (existingPost) {
          // Update the existing canonical post
          await supabaseAdmin
            .from('social_posts')
            .update(finalPayload)
            .eq('id', existingPost.id);

          // Update the placeholder row to completed so the client gets status success
          await supabaseAdmin
            .from('social_posts')
            .update({
              status: 'completed',
              ai_analysis: aiAnalysis,
              whisper_transcript: transcript || null,
            })
            .eq('id', socialPostId);

          return existingPost.id;
        }
      }

      console.error('[DB] Social post upsert error:', error);
      throw new Error(`Failed to save social post: ${error.message}`);
    }

    console.log(`[DB] Social post saved: ${data?.id}`);
    return data?.id || null;
  }
}
