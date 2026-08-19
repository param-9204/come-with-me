import { NextResponse } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get('runId');
    const actorId = searchParams.get('actorId');

    if (!runId || !actorId) {
      return NextResponse.json({ error: 'Missing required query parameters: runId and actorId' }, { status: 400 });
    }

    const { status, defaultDatasetId } = await ScraperService.getScrapeStatus(runId);

    if (status === 'SUCCEEDED' && defaultDatasetId) {
      const { normalized, raw } = await ScraperService.fetchAndNormalize(defaultDatasetId, actorId);
      return NextResponse.json({
        success: true,
        status,
        data: normalized,
        raw,
      });
    }

    return NextResponse.json({
      success: true,
      status,
      data: null,
      raw: null,
    });
  } catch (error: any) {
    console.error('[API Scrape Status] Error:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to get scrape status',
    }, { status: 500 });
  }
}
