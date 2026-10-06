import { supabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 5 * 1024 * 1024;
// Server-side fetches are limited to the social CDNs scraped media comes from.
const MEDIA_HOST =
  /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn(-us|-eu)?\.com|ytimg\.com)$/i;
const INSTAGRAM_CODE =
  /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

async function fetchImage(url: string) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0" },
    });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.startsWith("image/")) return null;
    const body = await response.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_BYTES) return null;
    return { body, type };
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/posts/:id/thumbnail
 *
 * Scraped Instagram image URLs are signed and expire after a few days. For
 * Instagram posts this asks instagram.com for a freshly signed cover image and
 * serves the bytes from this origin: the fresh CDN response carries
 * Cross-Origin-Resource-Policy: same-origin, so browsers would refuse it in an
 * <img> on the admin domain. Only post ids are accepted, never arbitrary URLs.
 */
export async function GET(_: Request, { params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) return new Response(null, { status: 404 });

  const { data: post } = await supabaseAdmin
    .from("social_posts")
    .select("platform, short_code, post_url, display_url")
    .eq("id", id)
    .maybeSingle();
  if (!post) return new Response(null, { status: 404 });

  const candidates: string[] = [];
  const shortCode =
    (post.platform === "instagram" &&
      (post.short_code ||
        (typeof post.post_url === "string"
          ? post.post_url.match(INSTAGRAM_CODE)?.[1]
          : null))) ||
    null;
  if (shortCode && /^[A-Za-z0-9_-]+$/.test(shortCode))
    candidates.push(`https://www.instagram.com/p/${shortCode}/media/?size=m`);
  // The stored URL may still be valid but blocked by the browser's CORP check.
  if (typeof post.display_url === "string") {
    try {
      const url = new URL(post.display_url);
      if (url.protocol === "https:" && MEDIA_HOST.test(url.hostname))
        candidates.push(url.toString());
    } catch {
      // Not a URL; nothing to try.
    }
  }

  for (const url of candidates) {
    const image = await fetchImage(url);
    if (image)
      return new Response(image.body, {
        headers: {
          "content-type": image.type,
          // Fresh Instagram links stay valid for days; let the browser reuse it.
          "cache-control": "private, max-age=21600",
        },
      });
  }
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "private, max-age=600" },
  });
}
