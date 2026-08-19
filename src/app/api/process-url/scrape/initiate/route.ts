import { NextResponse } from 'next/server';
import { ScraperService } from '@/lib/services/scraper.service';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing required field: url' }, { status: 400 });
    }

    const { runId, actorId } = await ScraperService.initiateScrape(url);

    return NextResponse.json({
      success: true,
      runId,
      actorId,
    });
  } catch (error: any) {
    console.error('[API Initiate Scrape] Error:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to initiate scrape',
    }, { status: 500 });
  }
}
