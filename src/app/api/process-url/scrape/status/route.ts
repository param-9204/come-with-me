import { NextResponse } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';
import { PipelineLog, recordPipelineOperation, withPipelineLog } from '@/lib/services/pipeline-log';

export async function GET(request: Request) {
  const log = new PipelineLog(`scrape-status-${Date.now()}`, { route: 'scrape-status' });
  return withPipelineLog(log, async () => {
    try {
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get('runId');
    const actorId = searchParams.get('actorId');
    const pipelineRunId = searchParams.get('pipelineRunId');
    const pipelineStartedAt = searchParams.get('pipelineStartedAt');
    const inputUrl = searchParams.get('url');
    log.adoptPipelineRun(pipelineRunId, pipelineStartedAt);
    log.setRunInput({ inputUrl, entrypoint: 'scrape-status', platform: inputUrl?.includes('tiktok.com') ? 'tiktok' : inputUrl ? 'instagram' : null });

    if (!runId || !actorId) {
      return NextResponse.json({ error: 'Missing required query parameters: runId and actorId' }, { status: 400 });
    }

    const startedAt = new Date();
    const { status, defaultDatasetId } = await ScraperService.getScrapeStatus(runId);
    recordPipelineOperation({
      stage: 'scrape', operation: 'poll_actor', provider: 'apify', model: actorId,
      startedAt, finishedAt: new Date(),
      status: ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status) ? 'failed' : status === 'SUCCEEDED' ? 'success' : 'partial',
      requestSummary: { actorRunId: runId }, resultSummary: { actorStatus: status, defaultDatasetId: defaultDatasetId || null },
      retryable: !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status),
    });

    if (status === 'SUCCEEDED' && defaultDatasetId) {
      const { normalized, raw } = await ScraperService.fetchAndNormalize(defaultDatasetId, actorId);
      const accessFailure = [raw?.error, raw?.http_error_reason, raw?.errorDescription]
        .filter((value) => typeof value === 'string')
        .join(' ');
      const isRestricted = /(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure);
      log.setRunInput({
        platform: normalized.platform,
        contentId: normalized.contentId,
        contentType: normalized.contentType,
        caption: normalized.caption,
        hashtags: normalized.hashtags,
        mentions: normalized.mentions,
        taggedAccounts: normalized.taggedUsers,
        metadata: { restricted: isRestricted, hasVideoUrl: Boolean(normalized.videoUrl), contentDuration: normalized.videoDuration },
      });
      return NextResponse.json({
        success: true,
        status,
        data: normalized,
        raw,
        partial: isRestricted,
        warning: isRestricted
          ? (raw?.errorDescription || 'Restricted access, only partial data available')
          : null,
      });
    }

    return NextResponse.json({
      success: true,
      status,
      data: null,
      raw: null,
    });
  } catch (error: any) {
    log.fail(error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to get scrape status',
    }, { status: 500 });
    } finally {
      log.flush();
      await log.flushDatabase();
    }
  });
}
