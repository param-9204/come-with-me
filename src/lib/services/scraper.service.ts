import { ApifyClient } from 'apify-client';
import type { SocialContent, ApifyInstagramPost, ApifyTikTokPost } from '../types/social';

export class ScraperService {
  private static getClient() {
    return new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  }

  static normalizeTikTokRaw(raw: ApifyTikTokPost): { normalized: SocialContent; raw: ApifyTikTokPost } {
    // Try to extract image URLs from various possible fields for slideshow/photo-mode posts
    let images: string[] = [];
    if (Array.isArray((raw as any).slideshowImageLinks)) {
      images = (raw as any).slideshowImageLinks.map((item: any) => {
        if (typeof item === 'string') return item;
        return item?.downloadLink || item?.tiktokLink || '';
      }).filter(Boolean);
    } else if (Array.isArray((raw as any).imageUrls)) {
      images = (raw as any).imageUrls;
    } else if (Array.isArray((raw as any).images)) {
      images = (raw as any).images.map((img: any) => {
        if (typeof img === 'string') return img;
        return img?.url || img?.display_image?.url_list?.[0] || img?.imageURL?.urlList?.[0] || '';
      }).filter(Boolean);
    } else if ((raw as any).image_post_info?.images) {
      const imgArray = (raw as any).image_post_info.images;
      if (Array.isArray(imgArray)) {
        images = imgArray.map((img: any) => img?.display_image?.url_list?.[0]).filter(Boolean);
      }
    } else if ((raw as any).imagePost?.images) {
      const imgArray = (raw as any).imagePost.images;
      if (Array.isArray(imgArray)) {
        images = imgArray.map((img: any) => img?.imageURL?.urlList?.[0]).filter(Boolean);
      }
    }

    const isSlideshow = (raw as any).isSlideshow === true || images.length > 0 || (raw as any).postType === 'slideshow';
    const contentType = isSlideshow ? 'post' : 'video';

    const normalized: SocialContent = {
      platform: 'tiktok',
      contentType: contentType as 'video' | 'post',
      contentId: raw.id || Date.now().toString(),
      authorUsername: raw.authorMeta?.name || 'unknown',
      authorFullName: raw.authorMeta?.nickName || '',
      caption: raw.text || '',
      videoUrl: raw.videoUrl || '',
      displayUrl: raw.videoMeta?.originalCoverUrl || raw.videoMeta?.dynamicCoverUrl || '',
      images: images.length > 0 ? images : undefined,
      shortCode: raw.id || '',
      hashtags: (raw.hashtags || []).map((h: any) => h.name || h.title || h),
      mentions: raw.mentions || [],
      taggedUsers: [],
      musicInfo: raw.musicMeta ? {
        artist_name: raw.musicMeta.musicAuthor || '',
        song_name: raw.musicMeta.musicName || '',
        uses_original_audio: raw.musicMeta.musicOriginal || false,
        should_mute_audio: false,
        should_mute_audio_reason: '',
        audio_id: raw.musicMeta.musicId || '',
      } : null,
      videoDuration: raw.videoMeta?.duration || null,
      dimensions: raw.videoMeta ? { width: raw.videoMeta.width, height: raw.videoMeta.height } : null,
      paidPartnership: raw.isSponsored || raw.isAd || false,
      productType: null,
      publishedAt: raw.createTimeISO || (raw.createTime ? new Date(raw.createTime * 1000).toISOString() : null),
      metrics: {
        likes: raw.diggCount ?? null,
        views: raw.playCount ?? null,
        plays: raw.playCount ?? null,
        comments: raw.commentCount ?? null,
        shares: raw.shareCount ?? null,
        saves: raw.collectCount ?? null,
      },
      rawApifyData: raw,
    };

    return { normalized, raw };
  }

  private static normalizeInstagramUrl(url: string): string {
    let cleaned = url.trim();

    // Ensure https:// prefix
    if (!cleaned.startsWith('http')) {
      cleaned = 'https://' + cleaned;
    }

    try {
      const parsed = new URL(cleaned);

      // Enforce https
      parsed.protocol = 'https:';

      // Enforce www.instagram.com
      if (!parsed.hostname.includes('instagram.com')) {
        throw new Error('Not an Instagram URL');
      }
      parsed.hostname = 'www.instagram.com';

      // Strip ALL query params and fragment (e.g. ?igsh=, ?utm_source=, #)
      parsed.search = '';
      parsed.hash = '';

      // Remove trailing slash from pathname for consistency
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      parsed.pathname = pathname;

      const result = parsed.toString();
      console.log(`[Apify Instagram] Normalized URL: ${url} → ${result}`);
      return result;
    } catch {
      console.warn(`[Apify Instagram] Could not parse URL, using as-is: ${url}`);
      return url;
    }
  }

  static normalizeInstagramRaw(raw: ApifyInstagramPost): { normalized: SocialContent; raw: ApifyInstagramPost } {
    const isCarousel = raw.type === 'Sidecar' || (raw.childPosts && raw.childPosts.length > 0);
    const isVideo = !isCarousel && (raw.type === 'Video' || !!raw.videoUrl);
    const contentType = isVideo ? 'reel' : 'post';

    // Treat likesCount === -1 as unavailable (Instagram hides likes)
    const likes = raw.likesCount === -1 ? null : (raw.likesCount ?? null);

    // Extract carousel images from childPosts if present
    let images: string[] = [];
    if (raw.childPosts && raw.childPosts.length > 0) {
      images = raw.childPosts
        .map((child: any) => child.displayUrl || child.url || child.videoUrl)
        .filter(Boolean);
    } else if (raw.images && raw.images.length > 0) {
      images = raw.images;
    } else if (raw.displayUrl) {
      images = [raw.displayUrl];
    }

    const normalized: SocialContent = {
      platform: 'instagram',
      contentType: contentType as 'reel' | 'post',
      contentId: raw.id || raw.shortCode || Date.now().toString(),
      authorUsername: raw.ownerUsername || 'unknown',
      authorFullName: raw.ownerFullName || '',
      caption: raw.caption || '',
      videoUrl: raw.videoUrl || '',
      displayUrl: raw.displayUrl || '',
      images: images,
      shortCode: raw.shortCode || '',
      hashtags: raw.hashtags || [],
      mentions: raw.mentions || [],
      taggedUsers: raw.taggedUsers || [],
      musicInfo: raw.musicInfo || null,
      videoDuration: raw.videoDuration || null,
      dimensions: (raw.dimensionsWidth && raw.dimensionsHeight)
        ? { width: raw.dimensionsWidth, height: raw.dimensionsHeight }
        : null,
      paidPartnership: raw.paidPartnership || false,
      productType: raw.productType || null,
      publishedAt: raw.timestamp || null,
      metrics: {
        likes,
        views: raw.videoViewCount ?? null,
        plays: raw.videoPlayCount ?? null,
        comments: raw.commentsCount ?? null,
        shares: null,   // Instagram API doesn't expose shares
        saves: null,    // Instagram API doesn't expose saves
      },
      rawApifyData: raw,
    };

    return { normalized, raw };
  }

  static async initiateScrape(
    url: string,
    webhookUrl?: string,
    socialPostId?: string
  ): Promise<{ runId: string; actorId: string }> {
    const client = this.getClient();
    const startOptions: any = {};

    if (webhookUrl && socialPostId) {
      startOptions.webhooks = [
        {
          eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
          requestUrl: webhookUrl,
          shouldInterpolateStrings: true,
          payloadTemplate: `{
            "runId": "{{resource.id}}",
            "status": "{{resource.status}}",
            "defaultDatasetId": "{{resource.defaultDatasetId}}",
            "socialPostId": "${socialPostId}"
          }`
        }
      ];
    }

    if (url.includes('tiktok.com')) {
      console.log(`[Apify TikTok] Initiating async run: ${url}`);
      const run = await client.actor('clockworks/tiktok-scraper').start({
        postURLs: [url],
        maxItems: 1,
      }, startOptions);
      return { runId: run.id, actorId: 'clockworks/tiktok-scraper' };
    } else if (url.includes('instagram.com')) {
      const cleanUrl = this.normalizeInstagramUrl(url);
      console.log(`[Apify Instagram] Initiating async run: ${cleanUrl}`);
      const run = await client.actor('apify/instagram-scraper').start({
        directUrls: [cleanUrl],
        resultsType: 'details',
      }, startOptions);
      return { runId: run.id, actorId: 'apify/instagram-scraper' };
    } else {
      throw new Error('Unsupported URL. Must be TikTok or Instagram.');
    }
  }

  static async getScrapeStatus(runId: string): Promise<{ status: string; defaultDatasetId: string | null }> {
    const client = this.getClient();
    const run = await client.run(runId).get();
    if (!run) throw new Error(`Apify run not found: ${runId}`);
    return {
      status: run.status,
      defaultDatasetId: run.defaultDatasetId || null,
    };
  }

  static async fetchAndNormalize(datasetId: string, actorId: string): Promise<{ normalized: SocialContent; raw: any }> {
    const client = this.getClient();
    const { items } = await client.dataset(datasetId).listItems({ limit: 1 });
    if (!items || items.length === 0) throw new Error('No items returned in dataset.');

    if (actorId.includes('tiktok')) {
      return this.normalizeTikTokRaw(items[0] as unknown as ApifyTikTokPost);
    } else {
      return this.normalizeInstagramRaw(items[0] as unknown as ApifyInstagramPost);
    }
  }
}
