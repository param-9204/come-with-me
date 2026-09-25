import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import { DbService } from '@/lib/services/db.service';
import { ApifyOcrService } from '@/lib/services/apify-ocr.service';
import { GptVisionOcrService } from '@/lib/services/gpt-vision-ocr.service';
import { WhisperService } from '@/lib/services/whisper.service';
import { mergeSameEntities } from '@/lib/services/place-evidence.service';
import { PipelineLog, plog, recordPipelineEvidence, recordPlaceCandidate, withPipelineLog } from '@/lib/services/pipeline-log';
import { googleMapsUrl } from '@/lib/maps-url';
import type { PlaceExtraction, TranscriptResult, TranscriptSegment } from '@/lib/types/social';

export const maxDuration = 300;

/** Concurrent Google lookups + inserts per post. */
const SAVE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

function transcriptFromBody(
  text: string,
  segments: unknown,
  source: unknown,
  language: unknown
): TranscriptResult | null {
  const validSegments: TranscriptSegment[] = Array.isArray(segments)
    ? segments
      .filter((segment: any) => segment && typeof segment.text === 'string')
      .map((segment: any) => ({ start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: segment.text }))
    : [];
  if (validSegments.length === 0) return WhisperService.fromStoredText(text);
  return {
    text: validSegments.map((segment) => segment.text).join(' '),
    language: typeof language === 'string' ? language : null,
    segments: validSegments,
    source: source === 'platform-subtitles' ? 'platform-subtitles' : 'whisper',
    droppedSegments: 0,
  };
}

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
  const log = new PipelineLog(`analyze-${Date.now()}`, { route: 'analyze' });
  return withPipelineLog(log, async () => {
    try {
      return await handleAnalyze(request, log);
    } finally {
      log.flush();
      await log.flushDatabase();
    }
  });
}

async function handleAnalyze(request: Request, log: PipelineLog) {
  try {
    const user = await getAuthUser(request);
    const resolvedUserId = user?.id || null;
    const body = await request.json();
    const {
      content,
      rawApifyData,
      transcript,
      transcriptSegments,
      transcriptSource,
      transcriptLanguage,
      apifyOcrFrames = [],
      gptVisionFrames = [],
      url,
      userId,
      audioUploadId,
      socialPostId: inputSocialPostId,
      pipelineRunId,
      pipelineStartedAt,
      processingWarnings = [],
    } = body;
    log.adoptPipelineRun(pipelineRunId, pipelineStartedAt);
    const transcriptResult = transcriptFromBody(transcript || '', transcriptSegments, transcriptSource, transcriptLanguage);
    const clientWarnings = Array.isArray(processingWarnings)
      ? [...new Set(processingWarnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0))]
      : [];


    const finalUserId = (userId || resolvedUserId) || undefined;

    if (!content || !url) {
      return NextResponse.json({ error: 'Missing required fields: content and url' }, { status: 400 });
    }

    log.runId = String(content.contentId || url);
    Object.assign(log.context, { url, platform: content.platform, socialPostId: inputSocialPostId || null });
    log.setRunInput({
      platform: content.platform,
      inputUrl: url,
      socialPostId: inputSocialPostId || null,
      entrypoint: 'analyze',
      contentId: content.contentId,
      contentType: content.contentType,
      caption: content.caption,
      hashtags: content.hashtags,
      mentions: content.mentions,
      taggedAccounts: content.taggedUsers,
      metadata: {
        locationTag: content.locationTag || null,
        videoDuration: content.videoDuration,
        dimensions: content.dimensions,
        subtitleTracks: content.subtitleTracks?.map((track: any) => ({ language: track.language, source: track.source })) || [],
        ocrFrameCount: apifyOcrFrames.length,
        visionFrameCount: gptVisionFrames.length,
      },
    });
    plog('run', 'Analysis started', {
      url,
      platform: content.platform,
      contentType: content.contentType,
      ocrFrames: apifyOcrFrames.length,
      visionFrames: gptVisionFrames.length,
      transcript: transcriptResult ? `${transcriptResult.source}, ${transcriptResult.segments.length} segment(s)` : 'none',
      warnings: clientWarnings,
    });
    const accessFailure = [rawApifyData?.error, rawApifyData?.http_error_reason, rawApifyData?.errorDescription]
      .filter((value) => typeof value === 'string')
      .join(' ');
    const isRestrictedPage = /(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure);
    const restrictedPageMessage = isRestrictedPage ? 'restricted' : null;

    // 1. Process OCR results (Deduplicate)
    const apifyAllTexts = ApifyOcrService.deduplicateAcrossFrames(apifyOcrFrames);
    const gptAggregated = GptVisionOcrService.aggregateResults(gptVisionFrames);

    // 2. One model call supplies both lightweight content intelligence and the
    // place candidates; every candidate is then verified against the evidence.
    const media = {
      ocrFrames: apifyOcrFrames,
      visionFrames: gptVisionFrames,
      transcript: transcriptResult,
    };
    const evidenceBundle = AiEnrichmentService.buildEvidence(content, media);
    recordPipelineEvidence(evidenceBundle.items);
    const enrichmentResult = await AiEnrichmentService.analyzeContent(content, rawApifyData, media);
    const enrichmentWarnings = enrichmentResult?.warning ? [enrichmentResult.warning] : [];

    const aiAnalysis = enrichmentResult?.analysis || null;
    let placeAnalysis = enrichmentResult?.places || [];
    let rejectedCandidates = enrichmentResult?.rejected || [];
    // Restricted-page records contain description text only. If the combined
    // response found no place, run the places-only extractor as a recovery
    // path; normal complete posts never make this extra request.
    if (restrictedPageMessage && placeAnalysis.length === 0) {
      plog('run', 'Restricted page returned no places; running description-only recovery', undefined, 'warn');
      try {
        const recovery = await AiEnrichmentService.extractPlaces(content, media);
        placeAnalysis = recovery.places;
        rejectedCandidates = [...rejectedCandidates, ...recovery.rejected];
      } catch (placeError: any) {
        plog('run', 'Restricted-page recovery failed', { error: placeError.message }, 'warn');
      }
    }
    plog('run', `${placeAnalysis.length} evidence-verified place(s) to save`, {
      places: placeAnalysis.map((place) => `${place.name} (${place.category}, ${place.confidence})`),
    });

    // 4. Save places to DB (bounded concurrency: Google lookups + inserts)
    let placeIds: string[] = [];
    let unresolvedPlaces: PlaceExtraction[] = [];
    if (placeAnalysis && placeAnalysis.length > 0) {
      const uniquePlaces = mergeSameEntities(placeAnalysis.filter((place) => !!place.name), evidenceBundle);

      const saveResults = await mapWithConcurrency(uniquePlaces, SAVE_CONCURRENCY, async (place, index) => {
        const candidateKey = `accepted-${index}`;
        recordPlaceCandidate(candidateKey, place, 'accepted');
        try {
          const id = await DbService.savePlace(place, url, content.platform, transcript || '', finalUserId, inputSocialPostId, content.authorUsername);
          recordPlaceCandidate(candidateKey, place, id ? 'accepted' : 'unresolved', {
            placeId: id,
            reason: id ? place.explanation || 'Evidence verified and place persisted.' : 'No verified location was available for persistence.',
          });
          return { place, id };
        } catch (placeErr: any) {
          plog('db', `Error saving "${place.name}"`, { error: placeErr.message }, 'error');
          recordPlaceCandidate(candidateKey, place, 'save_failed', { reason: placeErr.message || String(placeErr) });
          return { place, id: null };
        }
      });
      placeIds = [...new Set(saveResults.map((result) => result.id).filter(Boolean) as string[])];
      unresolvedPlaces = saveResults.filter((result) => !result.id).map((result) => result.place);
      if (unresolvedPlaces.length > 0) {
        plog('run', `${unresolvedPlaces.length} place(s) not saved (no verified location); returned without coordinates`, {
          places: unresolvedPlaces.map((place) => place.name),
        }, 'warn');
      }
    }
    for (const [index, rejected] of rejectedCandidates.entries()) {
      recordPlaceCandidate(`rejected-${index}`, rejected, 'rejected', { reason: rejected.reason });
    }

    // 5. Save full social post record to DB
    let socialPostId: string | null = null;
    try {
      socialPostId = await DbService.saveSocialPost(
        content,
        rawApifyData,
        aiAnalysis,
        apifyOcrFrames,
        gptVisionFrames,
        transcript || '',
        placeIds,
        url,
        finalUserId,
        inputSocialPostId
      );
    } catch (dbErr: any) {
      plog('db', 'Error saving the social post', { error: dbErr.message }, 'error');
      // We throw this error because saving the social post is critical
      throw dbErr;
    }
    // Direct /analyze callers may not have supplied a post ID. The durable
    // audit flush happens after this handler, so attach the persisted ID now
    // and every audit child row receives the same social_post_id.
    log.setRunInput({ socialPostId });

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
        } else {
          plog('db', 'Failed to link the audio upload', { error: dbError?.message }, 'warn');
        }
      } catch (audioLinkErr: any) {
        plog('db', 'Audio link error', { error: audioLinkErr.message }, 'warn');
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
        frames: gptVisionFrames,
        allTexts: gptAggregated.allTexts,
        allBrands: gptAggregated.allBrands,
        allLocations: gptAggregated.allLocations,
        allPrices: gptAggregated.allPrices,
        allCtas: gptAggregated.allCtas,
        totalFramesProcessed: gptVisionFrames.length,
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
      map_url: googleMapsUrl(p),
      author_username: finalAuthorUsername,
      creator_handle: finalCreatorHandle,
      creators: finalCreatorHandle ? [{ creator_handle: finalCreatorHandle, post_url: url, platform: content?.platform }] : [],
    }));
    plog('run', `Analysis finished: ${finalPlaces.length} place(s)`, {
      socialPostId,
      places: finalPlaces.map((p: any) => ({
        name: p.name,
        saved: !!p.id,
        lat: p.latitude ?? null,
        lng: p.longitude ?? null,
        mapUrl: p.map_url,
      })),
    });
    log.setResult({
      socialPostId,
      returnedPlaceCount: finalPlaces.length,
      persistedPlaceCount: placeIds.length,
      unresolvedPlaceCount: unresolvedPlaces.length,
      rejectedCandidateCount: rejectedCandidates.length,
      restricted: Boolean(restrictedPageMessage),
      warnings: [...clientWarnings, ...enrichmentWarnings],
    }, unresolvedPlaces.length > 0 || Boolean(restrictedPageMessage) || clientWarnings.length > 0 || enrichmentWarnings.length > 0 ? 'partial' : 'completed');
    const partialResultMessage = finalPlaces.length > 0
      ? 'This post contains Restricted content. Place were found.'
      : 'This post contains Restricted content. No places were found.';

    const resultWarnings = [
      ...(restrictedPageMessage ? [partialResultMessage] : []),
      ...clientWarnings,
      ...enrichmentWarnings,
    ];
    return NextResponse.json({
      success: true,
      partial: resultWarnings.length > 0,
      // A successful partial result reports whether the available source text
      // produced a verifiable place, rather than exposing a generic error.
      error: resultWarnings.length > 0 ? resultWarnings.join(' ') : null,
      warnings: resultWarnings,
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
      log: log.events,
    });

  } catch (error: any) {
    plog('run', 'Analysis failed', { error: error.message || String(error) }, 'error');
    log.fail(error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Analysis processing failed',
      log: log.events,
    }, { status: 500 });
  }
}
