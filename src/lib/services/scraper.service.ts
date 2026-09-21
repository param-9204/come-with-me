import { ApifyClient } from 'apify-client';
import type { SocialContent, ApifyInstagramPost, ApifyTikTokPost } from '../types/social';

export class ScraperService {
  private static getClient() {
    return new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  }

  /** Keep actor output-field variation at the ingestion boundary. */
  private static firstHttpsUrl(...candidates: unknown[]): string {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const url = candidate.trim();
      if (/^https:\/\//i.test(url)) return url;
    }
    return '';
  }

  /**
   * Apify's video-download add-on returns a private KVS record URL. Convert
   * only that exact record shape into a record-scoped signed URL; never put
   * the account token in a browser-visible media URL.
   */
  private static async signApifyRecordUrl(url: string): Promise<string> {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'api.apify.com') return url;

      const match = parsed.pathname.match(/^\/v2\/key-value-stores\/([^/]+)\/records\/([^/]+)$/);
      if (!match) return url;

      const [, storeId, recordKey] = match;
      return await this.getClient()
        .keyValueStore(decodeURIComponent(storeId))
        .getRecordPublicUrl(decodeURIComponent(recordKey));
    } catch (error: any) {
      // Keep normal metadata processing available if a signed media link
      // cannot be made (for example, a record was already deleted).
      console.warn('[Apify TikTok] Could not sign downloaded-video record:', error.message);
      return url;
    }
  }

  static async normalizeTikTokRaw(raw: ApifyTikTokPost): Promise<{ normalized: SocialContent; raw: ApifyTikTokPost }> {
    const downloadedMediaUrls = Array.isArray((raw as any).mediaUrls)
      ? (raw as any).mediaUrls.flatMap((media: unknown) => {
        if (typeof media === 'string') return [media];
        if (media && typeof media === 'object') {
          const value = media as Record<string, unknown>;
          return [value.url, value.downloadUrl, value.downloadLink, value.videoUrl].filter(
            (candidate): candidate is string => typeof candidate === 'string'
          );
        }
        return [];
      })
      : [];

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

    const videoUrl = await this.signApifyRecordUrl(this.firstHttpsUrl(
      raw.videoUrl,
      (raw as any).videoMeta?.videoUrl,
      (raw as any).videoMeta?.playUrl,
      (raw as any).videoMeta?.downloadAddr,
      (raw as any).video?.playAddr,
      (raw as any).video?.downloadAddr,
      ...downloadedMediaUrls,
    ));

    const normalized: SocialContent = {
      platform: 'tiktok',
      contentType: contentType as 'video' | 'post',
      contentId: raw.id || Date.now().toString(),
      authorUsername: raw.authorMeta?.name || 'unknown',
      authorFullName: raw.authorMeta?.nickName || '',
      caption: raw.text || '',
      videoUrl,
      displayUrl: this.firstHttpsUrl(
        raw.videoMeta?.originalCoverUrl,
        (raw as any).videoMeta?.coverUrl,
        raw.videoMeta?.dynamicCoverUrl,
        (raw as any).coverUrl,
      ),
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

  /**
   * Apify can return a restricted-page record with a usable description but no
   * reliable media. Preserve only that source text for place extraction.
   */
  private static normalizeRestrictedInstagramRaw(raw: any): { normalized: SocialContent; raw: any } {
    const caption = typeof raw.description === 'string' ? raw.description.trim() : '';
    const hashtags = ((caption.match(/#[\p{L}\p{N}_]+/gu) || []) as string[]).map((tag: string) => tag.slice(1));
    const mentions = ((caption.match(/@[A-Za-z0-9._]+/g) || []) as string[]).map((mention: string) => mention.slice(1));

    return {
      normalized: {
        platform: 'instagram',
        // No media fields are supplied to the client, so it will skip OCR/audio.
        contentType: 'post',
        contentId: raw.media_id || raw.shared_entity_id || Date.now().toString(),
        authorUsername: raw.user?.username || 'unknown',
        authorFullName: '',
        caption,
        videoUrl: '',
        displayUrl: '',
        images: [],
        shortCode: raw.media_id || '',
        hashtags,
        mentions,
        taggedUsers: [],
        musicInfo: null,
        videoDuration: null,
        dimensions: null,
        paidPartnership: false,
        productType: null,
        publishedAt: null,
        metrics: { likes: null, views: null, plays: null, comments: null, shares: null, saves: null },
        rawApifyData: raw,
      },
      raw,
    };
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
        // Place names are often only present in the video frames. A caption and
        // cover alone cannot support a complete itinerary extraction.
        shouldDownloadVideos: true,
        shouldDownloadCovers: true,
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

    const firstItem = items[0] as any;
    const accessFailure = [firstItem?.error, firstItem?.http_error_reason, firstItem?.errorDescription]
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (/(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure) &&
      typeof firstItem.description === 'string' && firstItem.description.trim()) {
      console.warn('[Apify Scraper] Restricted page: using description-only place extraction.');
      return this.normalizeRestrictedInstagramRaw(firstItem);
    }

    if (actorId.includes('tiktok')) {
      return await this.normalizeTikTokRaw(items[0] as unknown as ApifyTikTokPost);
    } else {
      return this.normalizeInstagramRaw(items[0] as unknown as ApifyInstagramPost);
    }
  }
}
