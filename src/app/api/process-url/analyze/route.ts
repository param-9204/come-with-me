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

    // 2. Run OpenAI 32-Section AI analysis and Place Extraction in parallel
    const [aiAnalysis, placeAnalysis] = await Promise.all([
      AiEnrichmentService.analyzeContent(
        content,
        rawApifyData,
        transcript || '',
        gptAggregated.allTexts,
        apifyAllTexts
      ),
      AiEnrichmentService.extractPlace(
        content,
        transcript || '',
        [...gptAggregated.allTexts, ...apifyAllTexts]
      )
    ]);

    // 4. Save places to DB
    let placeIds: string[] = [];
    if (placeAnalysis && placeAnalysis.length > 0) {
      for (const place of placeAnalysis) {
        if (place.name) {
          try {
            const id = await DbService.savePlace(place, url, content.platform, transcript || '', finalUserId);
            if (id) placeIds.push(id);
          } catch (placeErr: any) {
            console.error('[API Analyze] Error saving individual place:', place.name, placeErr.message);
          }
        }
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
