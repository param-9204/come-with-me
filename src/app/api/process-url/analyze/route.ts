import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/auth';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import { DbService } from '@/lib/services/db.service';
import { ApifyOcrService } from '@/lib/services/apify-ocr.service';
import { GptVisionOcrService } from '@/lib/services/gpt-vision-ocr.service';

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

    const finalUserId = userId || resolvedUserId;

    if (!content || !url) {
      return NextResponse.json({ error: 'Missing required fields: content and url' }, { status: 400 });
    }

    console.log(`[API Analyze] Running enrichment for: ${url}`);

    // 1. Process OCR results (Deduplicate)
    const gptAggregated = GptVisionOcrService.aggregateResults([]);
    const apifyAllTexts = ApifyOcrService.deduplicateAcrossFrames(apifyOcrFrames);

    // 2. Run OpenAI consolidated AI analysis (32-Section & Place Extraction in one call)
    const enrichmentResult = await AiEnrichmentService.analyzeContent(
      content,
      rawApifyData,
      transcript || '',
      gptAggregated.allTexts,
      apifyAllTexts
    );

    const aiAnalysis = enrichmentResult?.analysis || null;
    const placeAnalysis = enrichmentResult?.places || [];

    // 4. Save places to DB (Parallelized geocoding & saving)
    let placeIds: string[] = [];
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
          return await DbService.savePlace(place, url, content.platform, transcript || '', finalUserId, inputSocialPostId);
        } catch (placeErr: any) {
          console.error('[API Analyze] Error saving individual place:', place.name, placeErr.message);
          return null;
        }
      });
      const resolvedIds = await Promise.all(savePlacePromises);
      placeIds = resolvedIds.filter(Boolean) as string[];
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

    return NextResponse.json({
      success: true,
      scrapedData: content,
      rawApifyData,
      transcript,
      ocrComparison,
      aiAnalysis,
      places: placeAnalysis,
      place: placeAnalysis && placeAnalysis.length > 0 ? placeAnalysis[0] : null,
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
