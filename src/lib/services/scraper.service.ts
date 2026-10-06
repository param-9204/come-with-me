import { ApifyClient } from 'apify-client';
import type {
  SocialContent, ApifyInstagramPost, ApifyTikTokPost,
  SocialAccountRef, SocialComment, SocialLocationTag, SubtitleTrack,
} from '../types/social';

type PlaceSignals = Pick<SocialContent,
  'locationTag' | 'comments' | 'altTexts' | 'creatorBio' | 'accounts' | 'subtitleTracks' | 'captionLanguage'>;

const MAX_COMMENTS = 20;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Instagram's generated alt text is usually only "Video by X on June 2, 2026." — no place data. */
function isInformativeAltText(alt: string): boolean {
  const trivial = alt.match(/^(?:Photo|Video)(?: shared)? by (.+?) on [A-Z][a-z]+ \d{1,2}, \d{4}\.?$/);
  if (!trivial) return true;
  // "Photo by X in Paris, France on …" carries a location.
  return /\sin\s+\p{Lu}/u.test(trivial[1]);
}

export class ScraperService {
  /**
   * Extract every platform field that can identify a place. Field names were
   * verified against real apify/instagram-scraper and clockworks/tiktok-scraper
   * output. Pure: safe to run on stored `raw_apify_data`.
   */
  static extractPlaceSignals(raw: any, platform: SocialContent['platform']): PlaceSignals {
    if (!raw || typeof raw !== 'object') return {};
    const accounts: SocialAccountRef[] = [];
    const addAccount = (username: unknown, fullName: unknown, relation: SocialAccountRef['relation']) => {
      const handle = text(username).replace(/^@/, '');
      if (!handle || accounts.some((a) => a.username.toLowerCase() === handle.toLowerCase())) return;
      accounts.push({ username: handle, fullName: text(fullName), relation });
    };

    if (platform === 'tiktok') {
      const owner = text(raw.authorMeta?.name).toLowerCase();
      for (const mention of Array.isArray(raw.detailedMentions) ? raw.detailedMentions : []) {
        if (text(mention?.name).toLowerCase() !== owner) addAccount(mention?.name, mention?.nickName, 'mention');
      }
      const subtitleTracks: SubtitleTrack[] = (Array.isArray(raw.videoMeta?.subtitleLinks) ? raw.videoMeta.subtitleLinks : [])
        .map((track: any) => ({
          language: text(track?.language),
          source: text(track?.source).toUpperCase(),
          url: text(track?.downloadLink) || text(track?.tiktokLink),
        }))
        .filter((track: SubtitleTrack) => /^https:\/\//i.test(track.url));
      // TikTok's own location tag ("London Bridge", "London EC4R 3TN, UK").
      // It was dropped before, so TikTok posts never had a location tag.
      const meta = raw.locationMeta || {};
      const tiktokLocation = text(meta.locationName) || text(meta.city);
      return {
        locationTag: tiktokLocation
          ? { name: tiktokLocation, id: meta.locationId != null ? String(meta.locationId) : null, address: text(meta.address) || null }
          : null,
        comments: [],
        altTexts: [],
        creatorBio: text(raw.authorMeta?.signature),
        accounts,
        subtitleTracks,
        captionLanguage: text(raw.textLanguage) || null,
      };
    }

    if (platform !== 'instagram') {
      const locationName = text(raw.locationName) || text(raw.location?.name) || text(raw.location);
      return {
        locationTag: locationName ? { name: locationName, id: text(raw.locationId) || null } : null,
        comments: [],
        altTexts: [],
        creatorBio: text(raw.author?.description) || text(raw.channelDescription),
        accounts: [],
        subtitleTracks: [],
        captionLanguage: text(raw.language) || null,
      };
    }

    const ownerUsername = text(raw.ownerUsername).toLowerCase();
    const children: any[] = Array.isArray(raw.childPosts) ? raw.childPosts : [];

    for (const post of [raw, ...children]) {
      for (const user of Array.isArray(post?.taggedUsers) ? post.taggedUsers : []) {
        if (text(user?.username).toLowerCase() !== ownerUsername) addAccount(user?.username, user?.full_name, 'tagged');
      }
    }
    for (const producer of Array.isArray(raw.coauthorProducers) ? raw.coauthorProducers : []) {
      if (text(producer?.username).toLowerCase() !== ownerUsername) addAccount(producer?.username, producer?.full_name, 'coauthor');
    }

    const locationName = text(raw.locationName);
    const locationTag: SocialLocationTag | null = locationName
      ? { name: locationName, id: raw.locationId != null ? String(raw.locationId) : null }
      : null;

    const comments: SocialComment[] = [];
    const seenComments = new Set<string>();
    const addComment = (body: unknown, author: unknown, likes: unknown) => {
      const value = text(body);
      const key = value.toLowerCase();
      if (!value || seenComments.has(key)) return;
      seenComments.add(key);
      const username = text(author).replace(/^@/, '');
      comments.push({
        text: value.slice(0, 500),
        ownerUsername: username,
        isCreator: !!username && username.toLowerCase() === ownerUsername,
        likes: typeof likes === 'number' ? likes : null,
      });
    };
    for (const comment of Array.isArray(raw.latestComments) ? raw.latestComments : []) {
      addComment(comment?.text, comment?.ownerUsername || comment?.owner?.username, comment?.likesCount);
    }
    // `firstComment` is text only; the author is unknown.
    addComment(raw.firstComment, '', null);

    const altTexts = [...new Set([raw, ...children].map((post) => text(post?.alt)).filter(Boolean))]
      .filter(isInformativeAltText);

    return {
      locationTag,
      comments: comments.slice(0, MAX_COMMENTS),
      altTexts,
      creatorBio: '',
      accounts,
      subtitleTracks: [],
      captionLanguage: null,
    };
  }


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

  private static numberOrNull(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  /** Extract only media-like URLs. Do not mistake a post/watch URL for a video. */
  private static mediaUrlsFrom(value: unknown, key = '', depth = 0): string[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === 'string') {
      return /(?:video|media|download|mp4|file|asset|play)/i.test(key) && /^https:\/\//i.test(value.trim())
        ? [value.trim()]
        : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => this.mediaUrlsFrom(item, key, depth + 1));
    if (typeof value !== 'object') return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) =>
      this.mediaUrlsFrom(childValue, childKey, depth + 1)
    );
  }

  private static platformForActor(actorId: string): SocialContent['platform'] {
    const actor = actorId.toLowerCase();
    if (actor === String(process.env.APIFY_YOUTUBE_METADATA_ACTOR_ID || '').toLowerCase() || actor.includes('youtube')) return 'youtube';
    if (actor === String(process.env.APIFY_FACEBOOK_REELS_METADATA_ACTOR_ID || '').toLowerCase() || actor.includes('facebook')) return 'facebook';
    return actor.includes('tiktok') ? 'tiktok' : 'instagram';
  }

  private static async downloadVideoFallback(
    platform: 'youtube' | 'facebook',
    sourceUrl: string,
    raw: Record<string, any>,
  ): Promise<string> {
    const actorId = platform === 'youtube'
      ? text(process.env.APIFY_YOUTUBE_DOWNLOADER_ACTOR_ID)
      : text(process.env.APIFY_FACEBOOK_REELS_DOWNLOADER_ACTOR_ID);
    const inputMode = platform === 'youtube'
      ? text(process.env.APIFY_YOUTUBE_DOWNLOADER_INPUT_MODE) || 'startUrls-object'
      : text(process.env.APIFY_FACEBOOK_REELS_DOWNLOADER_INPUT_MODE) || 'startUrls-object';

    if (!actorId) {
      raw.media_fallback = { status: 'not_configured', platform, sourceUrl };
      return '';
    }
    if (!sourceUrl) {
      raw.media_fallback = { status: 'source_url_missing', platform, actorId };
      return '';
    }
    if (inputMode !== 'startUrls-object' && inputMode !== 'startUrls-string') {
      raw.media_fallback = { status: 'unsupported_input_mode', platform, actorId, inputMode };
      return '';
    }

    const input = inputMode === 'startUrls-object'
      ? { startUrls: [{ url: sourceUrl }] }
      : { workflow: 'videoUrls', startUrls: [sourceUrl], maxResults: 1, downloadMp4: true };
    const run = await this.getClient().actor(actorId).call(input);
    if (!run?.defaultDatasetId) {
      raw.media_fallback = { status: 'no_dataset', platform, actorId, runId: run?.id || null };
      return '';
    }
    const { items } = await this.getClient().dataset(run.defaultDatasetId).listItems({ limit: 1 });
    const mediaUrl = this.firstHttpsUrl(...(items || []).flatMap((item: any) => [
      item.videoMp4Url, item.videoMp4UrlHd, item.videoMp4UrlSd, item.videoUrl,
      item.downloadUrl, item.downloadLink, item.mediaUrl, item.fileUrl, item.mp4Url,
      ...this.mediaUrlsFrom(item),
    ]));
    raw.media_fallback = {
      status: mediaUrl ? 'downloaded' : 'artifact_missing',
      platform,
      actorId,
      runId: run.id,
      datasetId: run.defaultDatasetId,
    };
    return mediaUrl ? this.signApifyRecordUrl(mediaUrl) : '';
  }

  private static async withVideoFallback(
    normalized: SocialContent,
    raw: Record<string, any>,
    sourceUrl: string,
  ): Promise<{ normalized: SocialContent; raw: Record<string, any> }> {
    if (normalized.videoUrl || (normalized.platform !== 'youtube' && normalized.platform !== 'facebook')) {
      return { normalized, raw };
    }
    const videoUrl = await this.downloadVideoFallback(normalized.platform, sourceUrl, raw);
    if (videoUrl) raw.media_fallback = { ...(raw.media_fallback || {}), videoUrl };
    return { normalized: { ...normalized, videoUrl }, raw };
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
      ...this.extractPlaceSignals(raw, 'tiktok'),
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
      ...this.extractPlaceSignals(raw, 'instagram'),
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

  static normalizeYouTubeRaw(raw: Record<string, any>): { normalized: SocialContent; raw: Record<string, any> } {
    const videoUrl = this.firstHttpsUrl(
      raw.media_fallback?.videoUrl, raw.videoUrl, raw.video_url, raw.downloadUrl, raw.download_url, raw.videoDownloadUrl,
      raw.streamingUrl, raw.streaming_url, raw.mediaUrl, raw.media_url,
    );
    const contentId = text(raw.id) || text(raw.videoId) || text(raw.video_id) || text(raw.shortCode) || Date.now().toString();
    const caption = text(raw.description) || text(raw.caption) || text(raw.title);
    const authorUsername = text(raw.channelHandle).replace(/^@/, '') || text(raw.channelId) || text(raw.channelName) || 'unknown';
    const normalized: SocialContent = {
      platform: 'youtube', contentType: 'video', contentId, authorUsername,
      authorFullName: text(raw.channelName) || text(raw.authorName), caption, videoUrl,
      displayUrl: this.firstHttpsUrl(raw.thumbnailUrl, raw.thumbnail_url, raw.thumbnail, raw.imageUrl),
      images: [], shortCode: contentId,
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.map((tag: unknown) => text(tag).replace(/^#/, '')).filter(Boolean) : [],
      mentions: [], taggedUsers: [], musicInfo: null,
      ...this.extractPlaceSignals(raw, 'youtube'),
      videoDuration: this.numberOrNull(raw.duration) || this.numberOrNull(raw.lengthSeconds),
      dimensions: null, paidPartnership: false, productType: null,
      publishedAt: text(raw.publishDate) || text(raw.publishedAt) || text(raw.uploadDate) || null,
      metrics: {
        likes: this.numberOrNull(raw.likeCount) || this.numberOrNull(raw.likes),
        views: this.numberOrNull(raw.viewCount) || this.numberOrNull(raw.views),
        plays: this.numberOrNull(raw.viewCount) || this.numberOrNull(raw.views),
        comments: this.numberOrNull(raw.commentCount) || this.numberOrNull(raw.comments),
        shares: null, saves: null,
      }, rawApifyData: raw,
    };
    return { normalized, raw };
  }

  static normalizeFacebookRaw(raw: Record<string, any>): { normalized: SocialContent; raw: Record<string, any> } {
    const videoUrl = this.firstHttpsUrl(
      raw.media_fallback?.videoUrl, raw.videoMp4Url, raw.videoMp4UrlHd, raw.videoMp4UrlSd, raw.videoUrl, raw.video_url, raw.videoDownloadUrl, raw.videoDownloadLink,
      raw.downloadUrl, raw.download_url, raw.hdVideoUrl, raw.sdVideoUrl, raw.mediaUrl,
    );
    const contentId = text(raw.id) || text(raw.reelId) || text(raw.videoId) || text(raw.video_id) || Date.now().toString();
    const author = raw.author && typeof raw.author === 'object' ? raw.author : {};
    const normalized: SocialContent = {
      platform: 'facebook', contentType: 'reel', contentId,
      authorUsername: text(raw.authorUsername) || text(raw.creatorUsername) || text(raw.creatorId) || text(author.username) || 'unknown',
      authorFullName: text(raw.authorName) || text(raw.creatorName) || text(author.name),
      caption: text(raw.caption) || text(raw.description) || text(raw.text), videoUrl,
      displayUrl: this.firstHttpsUrl(raw.thumbnailUrl, raw.thumbnail_url, raw.thumbnail, raw.coverUrl, raw.imageUrl),
      images: [], shortCode: contentId,
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.map((tag: unknown) => text(tag).replace(/^#/, '')).filter(Boolean) : [],
      mentions: [], taggedUsers: [], musicInfo: null,
      ...this.extractPlaceSignals(raw, 'facebook'),
      videoDuration: this.numberOrNull(raw.durationSeconds) || this.numberOrNull(raw.duration),
      dimensions: this.numberOrNull(raw.width) && this.numberOrNull(raw.height)
        ? { width: this.numberOrNull(raw.width)!, height: this.numberOrNull(raw.height)! }
        : null,
      paidPartnership: false, productType: null,
      publishedAt: text(raw.publishedAt) || text(raw.createdAt) || text(raw.timestamp) || null,
      metrics: {
        likes: this.numberOrNull(raw.likes) || this.numberOrNull(raw.reactions),
        views: this.numberOrNull(raw.views) || this.numberOrNull(raw.viewCount),
        plays: this.numberOrNull(raw.plays) || this.numberOrNull(raw.views),
        comments: this.numberOrNull(raw.comments) || this.numberOrNull(raw.commentCount),
        shares: this.numberOrNull(raw.shares) || this.numberOrNull(raw.shareCount), saves: null,
      }, rawApifyData: raw,
    };
    return { normalized, raw };
  }

  static normalizeRawForPlatform(raw: Record<string, any>, platform: SocialContent['platform']): Promise<{ normalized: SocialContent; raw: any }> | { normalized: SocialContent; raw: any } {
    if (platform === 'tiktok') return this.normalizeTikTokRaw(raw as ApifyTikTokPost);
    if (platform === 'youtube') return this.normalizeYouTubeRaw(raw);
    if (platform === 'facebook') return this.normalizeFacebookRaw(raw);
    return this.normalizeInstagramRaw(raw as ApifyInstagramPost);
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
    } else if (/(?:youtube\.com|youtu\.be)/i.test(url)) {
      const actorId = text(process.env.APIFY_YOUTUBE_METADATA_ACTOR_ID);
      if (!actorId) throw new Error('APIFY_YOUTUBE_METADATA_ACTOR_ID is not configured');
      const run = await client.actor(actorId).start({ startUrls: [{ url }], maxResults: 1 }, startOptions);
      return { runId: run.id, actorId };
    } else if (/(?:facebook\.com|fb\.watch)/i.test(url)) {
      const actorId = text(process.env.APIFY_FACEBOOK_REELS_METADATA_ACTOR_ID);
      if (!actorId) throw new Error('APIFY_FACEBOOK_REELS_METADATA_ACTOR_ID is not configured');
      const inputMode = text(process.env.APIFY_FACEBOOK_REELS_METADATA_INPUT_MODE) || 'startUrls-string';
      const input = inputMode === 'startUrls-string'
        ? { workflow: 'videoUrls', startUrls: [url], maxResults: 1, downloadMp4: true }
        : inputMode === 'urls-array'
          ? { urls: [url] }
          : null;
      if (!input) throw new Error(`Unsupported Facebook metadata input mode: ${inputMode}`);
      const run = await client.actor(actorId).start(input, startOptions);
      return { runId: run.id, actorId };
    } else {
      throw new Error('Unsupported URL. Must be TikTok, Instagram, YouTube, or Facebook.');
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

  static async fetchAndNormalize(datasetId: string, actorId: string, sourceUrl?: string): Promise<{ normalized: SocialContent; raw: any }> {
    const client = this.getClient();
    const { items } = await client.dataset(datasetId).listItems({ limit: 1 });
    if (!items || items.length === 0) {
      if (this.platformForActor(actorId) === 'facebook') {
        throw new Error(
          'Facebook did not expose public video data for this Reel. It may be private, removed, age/region restricted, or require Facebook login. Only a Reel playable while logged out can be processed without approved Facebook authentication.'
        );
      }
      throw new Error('No items returned in dataset.');
    }

    const firstItem = items[0] as any;
    const accessFailure = [firstItem?.error, firstItem?.http_error_reason, firstItem?.errorDescription]
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (/(?:restricted|age[ _-]*restriction|age[ _-]*limited)/i.test(accessFailure) &&
      typeof firstItem.description === 'string' && firstItem.description.trim()) {
      console.warn('[Apify Scraper] Restricted page: using description-only place extraction.');
      return this.normalizeRestrictedInstagramRaw(firstItem);
    }

    const platform = this.platformForActor(actorId);
    const normalizedResult = await this.normalizeRawForPlatform(firstItem, platform);
    const sourceFromRecord = this.firstHttpsUrl(
      firstItem.url, firstItem.webVideoUrl, firstItem.inputUrl, firstItem.videoUrl,
      firstItem.video_url, firstItem.sourceUrl, firstItem.source_url,
    );
    return this.withVideoFallback(normalizedResult.normalized, firstItem, sourceUrl || sourceFromRecord || normalizedResult.normalized.displayUrl || '');
  }
}
