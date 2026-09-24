import { NextResponse } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';
import { PipelineLog, recordPipelineOperation, withPipelineLog } from '@/lib/services/pipeline-log';

export async function POST(request: Request) {
  const log = new PipelineLog(`scrape-init-${Date.now()}`, { route: 'scrape-initiate' });
  return withPipelineLog(log, async () => {
    try {
      const body = await request.json();
      const { url, pipelineRunId, pipelineStartedAt } = body;
      log.adoptPipelineRun(pipelineRunId, pipelineStartedAt);

      if (!url || typeof url !== 'string') {
        return NextResponse.json({ error: 'Missing required field: url' }, { status: 400 });
      }

      log.setRunInput({ platform: url.includes('tiktok.com') ? 'tiktok' : 'instagram', inputUrl: url, entrypoint: 'scrape-initiate' });
      const startedAt = new Date();
      const { runId, actorId } = await ScraperService.initiateScrape(url);
      recordPipelineOperation({
        stage: 'scrape', operation: 'start_actor', provider: 'apify', model: actorId,
        startedAt, finishedAt: new Date(), requestSummary: { platform: url.includes('tiktok.com') ? 'tiktok' : 'instagram' },
        resultSummary: { actorRunId: runId },
      });

      return NextResponse.json({ success: true, runId, actorId, pipelineRunId: log.pipelineRunId, pipelineStartedAt: log.pipelineStartedAt });
    } catch (error: any) {
      log.fail(error);
      return NextResponse.json({ success: false, error: error.message || 'Failed to initiate scrape' }, { status: 500 });
    } finally {
      log.flush();
      await log.flushDatabase();
    }
  });
}
