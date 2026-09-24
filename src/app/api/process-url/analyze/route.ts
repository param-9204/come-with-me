import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAuthUser, resolveProfileId } from '@/lib/auth';
import { AiEnrichmentService } from '@/lib/services/ai-enrichment.service';
import { DbService } from '@/lib/services/db.service';
import { ApifyOcrService } from '@/lib/services/apify-ocr.service';
import { GptVisionOcrService } from '@/lib/services/gpt-vision-ocr.service';
import { WhisperService } from '@/lib/services/whisper.service';
import { mergeSameEntities } from '@/lib/services/place-evidence.service';
import { PipelineLog, candidateKey, plog, reasonCode, startStage, withPipelineLog } from '@/lib/services/pipeline-log';
import { ExtractionLogStore, finishedColumns, signalColumns } from '@/lib/services/extraction-log.store';
import { googleMapsUrl } from '@/lib/maps-url';
import type { PlaceExtraction, TranscriptResult, TranscriptSegment } from '@/lib/types/social';

export const maxDuration = 300;

/** Concurrent Google lookups + inserts per post. */
const SAVE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
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
  log.part = 'analysis';
  return withPipelineLog(log, async () => {
    try {
      return await handleAnalyze(request, log);
    } finally {
      await log.flush();
    }
  });
}

/** Final outcome of each accepted place for extraction_candidates: saved, linked, unsaved (and why), or failed. */
function recordSaveOutcomes(log: PipelineLog, results: Array<{ place: PlaceExtraction; id: string | null; error?: string }>): void {
  for (const { place, id, error } of results) {
    const outcome = log.saveOutcomes.get(place);
    const decision = error ? 'save_error' : outcome?.decision ?? (id ? 'saved' : 'unsaved');
    const reason = error ? `save threw: ${error}` : outcome?.reason ?? null;
    log.addCandidate({
      pass: log.acceptedPass.get(candidateKey(place.name)) ?? 'primary',
      decision,
      reasonCode: decision === 'saved' || decision === 'linked_existing' ? null : reasonCode(reason),
      reason,
      name: place.name,
      searchQuery: place.search_query || null,
      mentionType: place.mention_type ?? null,
      modelRole: place.role ?? null,
      baseCategory: place.base_category ?? null,
      category: place.category,
      savedCategory: outcome?.savedCategory ?? null,
      city: place.city,
      neighborhood: place.neighborhood,
      address: place.address,
      confidence: place.confidence,
      evidenceIds: place.evidence_ids ?? [],
      locationEvidenceIds: place.location_evidence_ids ?? [],
      evidenceSources: place.evidence_sources ?? [],
      evidenceSnippets: place.evidence_snippets ?? [],
      placeId: id,
      geocodeProvider: outcome?.provider ?? null,
      geocodeVerified: outcome?.verified ?? null,
      geocodeAmbiguous: outcome?.ambiguous ?? null,
      googlePlaceId: outcome?.googlePlaceId ?? null,
    });
  }
}

async function handleAnalyze(request: Request, log: PipelineLog) {
  // True when this request created the run (called directly, not from the pipeline routes).
  let ownsRun = false;
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
      extractionRunId,
    } = body;
    const transcriptResult = transcriptFromBody(transcript || '', transcriptSegments, transcriptSource, transcriptLanguage);


    const finalUserId = (userId || resolvedUserId) || undefined;

    if (!content || !url) {
      return NextResponse.json({ error: 'Missing required fields: content and url' }, { status: 400 });
    }

    log.runId = String(content.contentId || url);
    Object.assign(log.context, { url, platform: content.platform, socialPostId: inputSocialPostId || null });
    if (typeof extractionRunId === 'string' && extractionRunId) {
      log.extractionRunId = extractionRunId;
    } else {
      log.extractionRunId = await ExtractionLogStore.startRun({
        socialPostId: inputSocialPostId || null,
        userId: finalUserId || null,
        platform: content.platform,
        inputUrl: url,
        route: 'analyze',
      });
      ownsRun = !!log.extractionRunId;
    }
    log.patch(signalColumns(content, rawApifyData));
    plog('run', 'Analysis started', {
      url,
      platform: content.platform,
      contentType: content.contentType,
      ocrFrames: apifyOcrFrames.length,
      visionFrames: gptVisionFrames.length,
      transcript: transcriptResult ? `${transcriptResult.source}, ${transcriptResult.segments.length} segment(s)` : 'none',
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
    const enrichmentResult = await AiEnrichmentService.analyzeContent(content, rawApifyData, media);

    const aiAnalysis = enrichmentResult?.analysis || null;
    let placeAnalysis = enrichmentResult?.places || [];
    // Restricted-page records contain description text only. If the combined
    // response found no place, run the places-only extractor as a recovery
    // path; normal complete posts never make this extra request.
    if (restrictedPageMessage && placeAnalysis.length === 0) {
      plog('run', 'Restricted page returned no places; running description-only recovery', undefined, 'warn');
      try {
        placeAnalysis = (await AiEnrichmentService.extractPlaces(content, media)).places;
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
    log.patch({ accepted_count: 0, saved_count: 0, unsaved_count: 0 });
    if (placeAnalysis && placeAnalysis.length > 0) {
      const bundle = AiEnrichmentService.buildEvidence(content, media);
      const uniquePlaces = mergeSameEntities(placeAnalysis.filter((place) => !!place.name), bundle);

      const endSave = startStage('save_places', null);
      const saveResults = await mapWithConcurrency(uniquePlaces, SAVE_CONCURRENCY, async (place): Promise<{ place: PlaceExtraction; id: string | null; error?: string }> => {
        try {
          const id = await DbService.savePlace(place, url, content.platform, transcript || '', finalUserId, inputSocialPostId, content.authorUsername);
          return { place, id };
        } catch (placeErr: any) {
          plog('db', `Error saving "${place.name}"`, { error: placeErr.message }, 'error');
          return { place, id: null, error: placeErr.message || String(placeErr) };
        }
      });
      placeIds = [...new Set(saveResults.map((result) => result.id).filter(Boolean) as string[])];
      unresolvedPlaces = saveResults.filter((result) => !result.id).map((result) => result.place);
      const savedCount = saveResults.filter((result) => result.id).length;
      endSave(uniquePlaces.length === savedCount ? 'success' : savedCount ? 'partial' : 'failed', {
        itemsIn: uniquePlaces.length,
        itemsOut: savedCount,
        details: { uniquePlaceIds: placeIds.length, errors: saveResults.filter((result) => result.error).length },
      });
      recordSaveOutcomes(log, saveResults);
      log.patch({ accepted_count: uniquePlaces.length, saved_count: savedCount, unsaved_count: unresolvedPlaces.length });
      if (unresolvedPlaces.length > 0) {
        plog('run', `${unresolvedPlaces.length} place(s) not saved (no verified location); returned without coordinates`, {
          places: unresolvedPlaces.map((place) => place.name),
        }, 'warn');
      }
    }

    // 5. Save full social post record to DB
    let socialPostId: string | null = null;
    const endPersist = startStage('persist_post', null);
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
      endPersist('success', { itemsIn: 1, itemsOut: 1 });
    } catch (dbErr: any) {
      endPersist('failed', { itemsIn: 1, itemsOut: 0, error: dbErr.message });
      plog('db', 'Error saving the social post', { error: dbErr.message }, 'error');
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
    const partialResultMessage = finalPlaces.length > 0
      ? 'This post contains Restricted content. Place were found.'
      : 'This post contains Restricted content. No places were found.';
    if (ownsRun) log.patch(finishedColumns(log.started, restrictedPageMessage ? 'partial' : 'completed', { social_post_id: socialPostId }));

    return NextResponse.json({
      success: true,
      partial: Boolean(restrictedPageMessage),
      // A successful partial result reports whether the available source text
      // produced a verifiable place, rather than exposing a generic error.
      error: restrictedPageMessage ? partialResultMessage : null,
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
    if (ownsRun) {
      log.patch(finishedColumns(log.started, 'failed', { failed_stage: 'analysis', error_code: 'ANALYSIS_FAILURE', error_message: error.message || String(error) }));
    }
    return NextResponse.json({
      success: false,
      error: error.message || 'Analysis processing failed',
      log: log.events,
    }, { status: 500 });
  }
}
