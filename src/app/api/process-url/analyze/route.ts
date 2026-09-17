import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import { DbService } from '@/lib/services/db.service';
import { ApifyOcrService } from '@/lib/services/apify-ocr.service';
import { GptVisionOcrService } from '@/lib/services/gpt-vision-ocr.service';
import type { PlaceExtraction } from '@/lib/types/social';

function normalizedPlaceName(name: string | null | undefined): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSamePlace(a: PlaceExtraction, b: PlaceExtraction): boolean {
  const aName = normalizedPlaceName(a.name);
  const bName = normalizedPlaceName(b.name);
  if (!aName || !bName) return false;

  const namesMatch = aName === bName ||
    (Math.min(aName.length, bName.length) >= 5 && (aName.includes(bName) || bName.includes(aName)));
  const aCity = (a.city || '').trim().toLowerCase();
  const bCity = (b.city || '').trim().toLowerCase();

  return namesMatch && (!aCity || !bCity || aCity === bCity);
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser(request);
    const resolvedUserId = user?.id || null;
    const body = await request.json();
    const {
      content,
      rawApifyData,
      transcript,
      apifyOcrFrames = [],
      url,
      userId,
      audioUploadId,
      socialPostId: inputSocialPostId,
    } = body;


    const finalUserId = (userId || resolvedUserId) || undefined;

    if (!content || !url) {
      return NextResponse.json({ error: 'Missing required fields: content and url' }, { status: 400 });
    }

    console.log(`[API Analyze] Running enrichment for: ${url}`);
    const accessFailure = [rawApifyData?.error, rawApifyData?.http_error_reason, rawApifyData?.errorDescription]
      .filter((value) => typeof value === 'string')
      .join(' ');
    const isRestrictedPage = /(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure);
    const restrictedPageMessage = isRestrictedPage
      ? (rawApifyData?.errorDescription || 'Restricted access, only partial data available')
      : null;

    // 1. Process OCR results (Deduplicate)
    const gptAggregated = GptVisionOcrService.aggregateResults([]);
    const apifyAllTexts = ApifyOcrService.deduplicateAcrossFrames(apifyOcrFrames);

    // 2. One strict response supplies both lightweight content intelligence and
    // the authoritative place list. This avoids sending caption/OCR/transcript twice.
    const enrichmentResult = await AiEnrichmentService.analyzeContent(
      content,
      rawApifyData,
      transcript || '',
      gptAggregated.allTexts,
      apifyAllTexts
    );

    const aiAnalysis = enrichmentResult?.analysis || null;
    let placeAnalysis = enrichmentResult?.places || [];
    // Restricted-page records contain description text only. If the compact
    // combined response found no place, use the focused extractor as a
    // recovery path; normal complete posts never make this extra request.
    if (restrictedPageMessage && placeAnalysis.length === 0) {
      console.warn('[API Analyze] Restricted page returned no places; running description-only place recovery.');
      try {
        placeAnalysis = await AiEnrichmentService.extractPlace(
          content,
          transcript || '',
          apifyAllTexts
        );
      } catch (placeError: any) {
        console.warn('[API Analyze] Restricted-page place recovery failed:', placeError.message);
      }
    }
    console.log(`[API Analyze] Schema-valid place count: ${placeAnalysis.length}`);

    // 4. Save places to DB (Parallelized geocoding & saving)
    let placeIds: string[] = [];
    let unresolvedPlaces: PlaceExtraction[] = [];
    if (placeAnalysis && placeAnalysis.length > 0) {
      // In-memory deduplication by name and city
      const seenPlaces = new Set<string>();
      const uniquePlaces = placeAnalysis.filter((place) => {
        if (!place.name) return false;
        const key = `${place.name.toLowerCase().trim()}_${(place.city || '').toLowerCase().trim()}`;
        if (seenPlaces.has(key)) {
          console.log(`[API Analyze] Skipping duplicate place extraction in-memory: "${place.name}" in "${place.city}"`);
          return false;
        }
        seenPlaces.add(key);
        return true;
      });

      const savePlacePromises = uniquePlaces.map(async (place) => {
        try {
          const id = await DbService.savePlace(place, url, content.platform, transcript || '', finalUserId, inputSocialPostId, content.authorUsername);
          return { place, id };
        } catch (placeErr: any) {
          console.error('[API Analyze] Error saving individual place:', place.name, placeErr.message);
          return { place, id: null };
        }
      });
      const saveResults = await Promise.all(savePlacePromises);
      placeIds = saveResults.map((result) => result.id).filter(Boolean) as string[];
      unresolvedPlaces = saveResults.filter((result) => !result.id).map((result) => result.place);
      if (unresolvedPlaces.length > 0) {
        console.warn(
          `[API Analyze] Returning ${unresolvedPlaces.length} unresolved place(s): ` +
          unresolvedPlaces.map((place) => place.name).join(', ')
        );
      }
    }

    // 5. Save full social post record to DB
    let socialPostId: string | null = null;
    try {
      socialPostId = await DbService.saveSocialPost(
        content,
        rawApifyData,
        aiAnalysis,
        apifyOcrFrames,
        [], // empty GPT vision frames
        transcript || '',
        placeIds,
        url,
        finalUserId,
        inputSocialPostId
      );
    } catch (dbErr: any) {
      console.error('[API Analyze] Error saving social post to DB:', dbErr.message);
      // We throw this error because saving the social post is critical
      throw dbErr;
    }

    // 6. Link Audio Upload to Social Post
    let linkedAudio = null;
    if (audioUploadId && socialPostId) {
      try {
        const { data: dbData, error: dbError } = await supabaseAdmin
          .from('audio_uploads')
          .update({ social_post_id: socialPostId })
          .eq('id', audioUploadId)
          .select('id, file_name, public_url')
          .single();

        if (!dbError && dbData) {
          linkedAudio = dbData;
          console.log('[API Analyze] Successfully linked audio upload to social post:', socialPostId);
        } else {
          console.warn('[API Analyze] Failed to link audio upload in DB:', dbError?.message);
        }
      } catch (audioLinkErr: any) {
        console.error('[API Analyze] Audio link error:', audioLinkErr.message);
      }
    }

    // 7. Assemble final response
    const ocrComparison = {
      apifyOcr: {
        frames: apifyOcrFrames,
        allTexts: apifyAllTexts,
        totalFramesProcessed: apifyOcrFrames.length,
        processingTimeMs: 0, // client-tracked
      },
      gptVision: {
        frames: [],
        allTexts: [],
        allBrands: [],
        allLocations: [],
        allPrices: [],
        allCtas: [],
        totalFramesProcessed: 0,
        processingTimeMs: 0,
      },
    };

    // Fetch fully enriched saved places with author_username and creator details
    const savedPlaces = socialPostId ? await DbService.getPlacesForSocialPost(socialPostId) : [];

    let rawAuthorUsername = content?.authorUsername || null;
    if (!rawAuthorUsername) {
      const targetPostId = socialPostId || inputSocialPostId;
      if (targetPostId) {
        const { data: postData } = await supabaseAdmin
          .from('social_posts')
          .select('author_username')
          .eq('id', targetPostId)
          .maybeSingle();

        if (postData?.author_username) {
          rawAuthorUsername = postData.author_username;
        }
      }
    }

    const finalAuthorUsername = rawAuthorUsername ? rawAuthorUsername.replace(/^@/, '') : null;
    const finalCreatorHandle = rawAuthorUsername ? (rawAuthorUsername.startsWith('@') ? rawAuthorUsername : `@${rawAuthorUsername}`) : null;

    // Keep extracted places visible when persistence is blocked by missing or
    // unverified address data; never silently turn four extracted places into three.
    const responseOnlyPlaces = unresolvedPlaces.filter(
      (unresolved) => !savedPlaces.some((saved) => isSamePlace(saved, unresolved))
    );
    const placesSource = [...savedPlaces, ...responseOnlyPlaces];
    const finalPlaces = placesSource.map((p: any) => ({
      ...p,
      place_id: p.id || p.place_id,
      author_username: finalAuthorUsername,
      creator_handle: finalCreatorHandle,
      creators: finalCreatorHandle ? [{ creator_handle: finalCreatorHandle, post_url: url, platform: content?.platform }] : [],
    }));

    return NextResponse.json({
      success: true,
      partial: Boolean(restrictedPageMessage),
      // Successful partial results still retain the source-access error.
      error: restrictedPageMessage,
      scrapedData: content,
      rawApifyData,
      transcript,
      ocrComparison,
      aiAnalysis,
      places: finalPlaces,
      place: finalPlaces.length > 0 ? finalPlaces[0] : null,
      placeIds,
      socialPostId,
      audioUpload: linkedAudio,
    });

  } catch (error: any) {
    console.error('[API Analyze] Unhandled error:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Analysis processing failed',
    }, { status: 500 });
  }
}
