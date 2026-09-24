import { NextResponse } from 'next/server';
import { MediaEvidenceService } from '@/lib/services/media-evidence.service';
import { PipelineLog, plog, withPipelineLog } from '@/lib/services/pipeline-log';
import type { SocialContent } from '@/lib/types/social';

// Download + key frames + OCR + transcript for one post in a single invocation.
export const maxDuration = 300;

export async function POST(request: Request) {
  const log = new PipelineLog(`media-${Date.now()}`, { route: 'media' });
  log.part = 'media';
  return withPipelineLog(log, async () => {
    try {
      const body = await request.json();
      const content = body?.content as SocialContent | undefined;
      if (!content || typeof content !== 'object' || !content.platform) {
        return NextResponse.json({ success: false, error: 'Missing required field: content' }, { status: 400 });
      }
      // Same run id as the analysis step, so both halves of a post share one id in the logs.
      log.runId = String(content.contentId || log.runId);
      Object.assign(log.context, { platform: content.platform, contentId: content.contentId });
      // Joins the caller's extraction run when it passes one; standalone calls are not persisted.
      if (typeof body.extractionRunId === 'string' && body.extractionRunId) log.extractionRunId = body.extractionRunId;

      const result = await MediaEvidenceService.collect(content, body.rawApifyData || content.rawApifyData || null, {
        persistAudio: body.persistAudio !== false,
      });

      return NextResponse.json({
        success: true,
        ocrFrames: result.ocrFrames,
        visionFrames: result.visionFrames,
        transcript: result.transcriptText,
        transcriptSegments: result.transcript?.segments || [],
        transcriptSource: result.transcript?.source || 'none',
        transcriptLanguage: result.transcript?.language || null,
        audioUpload: result.audioUpload,
        steps: result.steps,
        log: log.events,
      });
    } catch (error: any) {
      plog('media', 'Media processing failed', { error: error.message || String(error) }, 'error');
      return NextResponse.json({ success: false, error: error.message || 'Media processing failed', log: log.events }, { status: 500 });
    } finally {
      await log.flush();
    }
  });
}
