export type CanonicalSocialSource = {
  platform: 'instagram' | 'tiktok' | 'youtube' | 'facebook';
  cleanUrl: string;
  key: string;
};

function isPlatformHost(host: string, platform: 'instagram' | 'tiktok' | 'facebook'): boolean {
  return host === `${platform}.com` || host.endsWith(`.${platform}.com`);
}

/**
 * Produces one stable identity before scraping. URL query strings, mobile/www
 * hosts, trailing slashes, and Instagram reel aliases must not create a new
 * social_posts row for the same source post.
 */
export function canonicalizeSocialSource(url: string): CanonicalSocialSource {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, '');
  const path = (parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/');

  let platform: CanonicalSocialSource['platform'];
  if (isPlatformHost(host, 'instagram')) platform = 'instagram';
  else if (isPlatformHost(host, 'tiktok')) platform = 'tiktok';
  else if (isPlatformHost(host, 'facebook') || host === 'fb.watch') platform = 'facebook';
  else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') platform = 'youtube';
  else throw new Error('Only Instagram, TikTok, YouTube, and Facebook URLs are supported');

  const instagramCode = platform === 'instagram'
    ? path.match(/^\/(?:p|reel|reels|tv)\/([^/]+)/i)?.[1]
    : null;
  const tiktokVideoId = platform === 'tiktok'
    ? path.match(/\/video\/(\d+)/i)?.[1]
    : null;
  const youtubeVideoId = platform === 'youtube'
    ? (host === 'youtu.be' ? path.match(/^\/([^/]+)/)?.[1] : path.match(/^\/(?:shorts|watch)\/([^/?]+)/i)?.[1] || parsed.searchParams.get('v'))
    : null;
  const facebookReelId = platform === 'facebook'
    ? path.match(/^\/(?:reel|reels)\/([^/]+)/i)?.[1] || path.match(/\/videos\/([^/]+)/i)?.[1] || parsed.searchParams.get('v')
    : null;
  const key = instagramCode
    ? `instagram:${instagramCode}`
    : tiktokVideoId
      ? `tiktok:${tiktokVideoId}`
      : youtubeVideoId
        ? `youtube:${youtubeVideoId}`
        : facebookReelId
          ? `facebook:${facebookReelId}`
          : `${platform}:${host}${path}`;

  // `v` is not optional for a YouTube /watch URL. Keep an actor-runnable
  // canonical URL while still using the stable content ID as the cache key.
  const cleanUrl = youtubeVideoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`
    : platform === 'facebook' && parsed.searchParams.get('v')
      ? `https://${host}${path}?v=${encodeURIComponent(parsed.searchParams.get('v')!)}`
      : `https://${host}${path}`;
  return { platform, cleanUrl, key };
}

/**
 * TikTok t/ and vm/ links do not carry the numeric video ID. Resolve only
 * those links, with a short timeout, so a short link and its final video URL
 * share the same pre-scrape key. A provider block simply falls back to the
 * safe URL-form key; the content-id merge remains the later fallback.
 */
export async function resolveCanonicalSocialSource(url: string): Promise<CanonicalSocialSource> {
  const source = canonicalizeSocialSource(url);
  if (source.platform !== 'tiktok' || /^tiktok:\d+$/.test(source.key)) return source;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: controller.signal });
    const resolved = canonicalizeSocialSource(response.url);
    return /^tiktok:\d+$/.test(resolved.key) ? resolved : source;
  } catch {
    return source;
  } finally {
    clearTimeout(timeout);
  }
}
