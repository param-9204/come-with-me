import 'server-only';

import { supabaseAdmin } from '@/lib/supabase';

export type AdminPostSummary = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_phone: string | null;
  location_name: string | null;
  location_address: string | null;
  platform: string | null;
  content_type: string | null;
  author_username: string | null;
  caption: string | null;
  display_url: string | null;
  image_urls: string[];
  post_url: string | null;
  likes: number | null;
  views: number | null;
  comments: number | null;
  primary_category: string | null;
  short_code: string | null;
  status: string | null;
  created_at: string | null;
};

type Json = Record<string, unknown>;

const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || null;
const asNumber = (...values: unknown[]) => {
  const value = values.find((item) => Number.isFinite(Number(item)));
  return value === undefined ? null : Number(value);
};
const textList = (...values: unknown[]) => {
  for (const value of values) {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  }
  return [] as string[];
};
const names = (...values: unknown[]) => [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).flatMap((item) => {
  if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
  const itemRecord = record(item);
  const name = firstText(itemRecord.name, itemRecord.username, itemRecord.title);
  return name ? [name] : [];
}))];
const urls = (...values: unknown[]) => [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item)))];
const mediaUrls = (...values: unknown[]) => {
  const found = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const item = record(value);
    [item.url, item.downloadLink, item.downloadUrl, item.tiktokLink, item.imageUrl, item.imageURL, item.src, item.displayUrl, item.originalCoverUrl, item.coverUrl, item.thumbnail, item.thumbnailUrl, item.thumbnail_url, item.preview, item.previewUrl, item.preview_url, item.url_list, item.urlList, item.display_image, item.displayImage, item.image_versions2, item.imageVersions2, item.display_resources, item.displayResources, item.thumbnail_resources, item.thumbnailResources, item.candidates, item.images, item.imageUrls, item.childPosts, item.child_posts, item.carousel_media, item.carouselMedia].forEach((candidate) => visit(candidate, depth + 1));
  };
  values.forEach((value) => visit(value));
  return [...found];
};

/**
 * Converts the different Instagram/TikTok scraper shapes into dashboard data.
 * Raw provider payloads stay server-side; only useful display fields leave the API.
 */
export function normalizeAdminPost(post: Json) {
  const raw = record(post.raw_apify_data);
  const analysis = record(post.ai_analysis);
  const content = record(analysis.content);
  const audience = record(analysis.audience);
  const promotion = record(analysis.promotion);
  const engagement = record(analysis.engagement);
  const influencer = record(analysis.influencer_analysis);
  const visual = record(analysis.visual_analysis);
  const rawAuthor = record(raw.authorMeta);
  const rawVideo = record(raw.videoMeta);
  const rawMusic = record(raw.musicMeta);
  const savedMusic = record(post.music_info);
  const rawDimensions = record(raw.dimensions);

  const caption = firstText(post.caption, raw.caption, raw.text, raw.description) || '';
  const scrapedImages = mediaUrls(
    raw.images, raw.imageUrls, raw.slideshowImageLinks,
    raw.childPosts, raw.child_posts, raw.carousel_media, raw.carouselMedia,
    raw.image_versions2, raw.imageVersions2,
    record(raw.image_post_info).images, record(raw.imagePost).images,
    record(raw.node), record(raw.media), record(raw.itemInfo),
  );
  const displayUrl = firstText(
    post.display_url, raw.displayUrl, raw.coverUrl, raw.thumbnailUrl,
    rawVideo.originalCoverUrl, rawVideo.coverUrl, rawVideo.dynamicCoverUrl,
    scrapedImages[0],
  );
  const imageUrls = urls(displayUrl, scrapedImages);
  const musicName = firstText(savedMusic.song_name, rawMusic.musicName, raw.musicName);
  const musicArtist = firstText(savedMusic.artist_name, rawMusic.musicAuthor, raw.musicAuthor);
  const topics = textList(content.topics, analysis.topics);

  return {
    platform: firstText(post.platform, raw.platform) || 'social',
    user_id: firstText(post.user_id),
    user_name: null,
    user_phone: null,
    location_name: firstText(raw.locationName, record(raw.location).name),
    location_address: firstText(raw.address, record(raw.location).address),
    content_type: firstText(post.content_type, raw.productType, raw.type, raw.postType) || 'post',
    author_username: firstText(post.author_username, raw.ownerUsername, rawAuthor.name, record(raw.user).username) || 'unknown',
    owner_full_name: firstText(post.owner_full_name, raw.ownerFullName, rawAuthor.nickName),
    caption,
    post_url: firstText(post.post_url, raw.url, raw.webVideoUrl, raw.inputUrl),
    video_url: firstText(post.video_url, raw.videoUrl, raw.webVideoUrl, rawVideo.videoUrl, rawVideo.playUrl),
    display_url: displayUrl,
    image_urls: imageUrls,
    images: imageUrls,
    likes: asNumber(post.likes, raw.likesCount, raw.diggCount, engagement.likes),
    views: asNumber(post.views, raw.videoViewCount, raw.playCount, engagement.views),
    comments: asNumber(post.comments, raw.commentsCount, raw.commentCount, engagement.comments),
    shares: asNumber(raw.shareCount, engagement.shares),
    saves: asNumber(raw.collectCount, engagement.saves),
    video_plays: asNumber(post.video_plays, raw.videoPlayCount, engagement.plays),
    video_duration: asNumber(post.video_duration, raw.videoDuration, rawVideo.duration),
    dimensions_width: asNumber(post.dimensions_width, raw.dimensionsWidth, rawVideo.width, rawDimensions.width),
    dimensions_height: asNumber(post.dimensions_height, raw.dimensionsHeight, rawVideo.height, rawDimensions.height),
    hashtags: textList(post.hashtags, raw.hashtags),
    mentions: textList(post.mentions, raw.mentions),
    tagged_users: names(post.tagged_users, raw.taggedUsers, raw.coauthorProducers),
    mentioned_brands: names(post.mentioned_brands, record(analysis.entities).brands, visual.brands_visible),
    mentioned_locations: names(post.mentioned_locations, record(analysis.entities).locations),
    primary_category: firstText(post.primary_category, content.primary_category),
    secondary_categories: textList(post.secondary_categories, content.secondary_categories),
    content_summary: firstText(post.content_summary, content.summary, analysis.summary),
    short_code: firstText(post.short_code, raw.shortCode, raw.shortcode),
    niche: firstText(post.niche, influencer.niche),
    target_audience: firstText(post.target_audience, audience.primary_audience),
    call_to_actions: textList(post.call_to_actions, promotion.call_to_actions),
    topics,
    music_name: musicName,
    music_artist: musicArtist,
    first_comment: firstText(post.first_comment, raw.firstComment),
    transcript: firstText(post.whisper_transcript, record(analysis.audio).transcript),
    visible_text: firstText(post.ocr_combined_text),
    status: firstText(post.status) || 'pending',
    created_at: firstText(post.created_at),
  };
}

export async function getAdminPostList(): Promise<{
  posts: AdminPostSummary[];
  total: number;
  error?: string;
}> {
  return getAdminPostPage();
}

export async function getAdminPostPage(options: { limit?: number; offset?: number } = {}): Promise<{
  posts: AdminPostSummary[];
  total: number;
  nextOffset: number | null;
  error?: string;
}> {
  const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const { count, error: countError } = await supabaseAdmin
    .from('social_posts')
    .select('id', { count: 'exact', head: true });

  if (countError) {
    console.error('[Admin] Unable to count posts:', countError.message);
    return { posts: [], total: 0, nextOffset: null, error: countError.message };
  }

  const fields = 'id, user_id, place_id, platform, content_type, author_username, caption, display_url, post_url, likes, views, comments, primary_category, short_code, status, created_at, raw_apify_data';
  const { data, error } = await supabaseAdmin
    .from('social_posts')
    .select(fields)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[Admin] Unable to load posts:', error.message);
    return { posts: [], total: count ?? 0, nextOffset: null, error: error.message };
  }

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((post) => post.user_id).filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  const placeIds = [...new Set(rows.map((post) => post.place_id).filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  const [profilesResult, placesResult] = await Promise.all([
    userIds.length ? supabaseAdmin.from('profiles').select('id, display_name, phone').in('id', userIds) : Promise.resolve({ data: [] }),
    placeIds.length ? supabaseAdmin.from('places').select('id, name, address, neighborhood, city').in('id', placeIds) : Promise.resolve({ data: [] }),
  ]);
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const places = new Map((placesResult.data ?? []).map((place) => [place.id, place]));
  const posts = rows.map((post) => {
    const normalized = normalizeAdminPost(post as Json);
    const profile = typeof post.user_id === 'string' ? profiles.get(post.user_id) : null;
    const place = typeof post.place_id === 'string' ? places.get(post.place_id) : null;
    return {
      id: post.id,
      ...normalized,
      user_name: profile?.display_name ?? null,
      user_phone: profile?.phone ?? null,
      location_name: place?.name ?? normalized.location_name,
      location_address: place ? [place.address, place.neighborhood, place.city].filter(Boolean).join(', ') : normalized.location_address,
    };
  }) as AdminPostSummary[];
  const resolvedTotal = count ?? posts.length;
  const nextOffset = offset + posts.length < resolvedTotal ? offset + posts.length : null;

  return {
    posts,
    total: resolvedTotal,
    nextOffset,
  };
}
