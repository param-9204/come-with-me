This is a [Next.js](https://nextjs.org) project bootstrapped with `[create-next-app](https://nextjs.org/docs/app/api-reference/cli/create-next-app)`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Google Maps setup

Place resolution uses Google Maps only. Add a server-side key to `.env`:

```env
GOOGLE_MAPS_API_KEY=your-server-side-google-maps-key
```

Enable **Places API (New)** and **Geocoding API** for that key in Google Cloud,
with billing enabled. Do not expose this key with a `NEXT_PUBLIC_` prefix. The
older `GOOGLE_PLACES_API_KEY` name remains supported during migration.

## Place extraction pipeline

Places are extracted from every signal a post has, not just the caption:
caption, hashtags, Instagram location tag, tagged / collab / mentioned
accounts (with display names), creator comments, image alt text, on-screen
text (OCR) and speech. Each place records why it was found, for example
"Name found in on-screen text (12s) and speech (6s); location from the
caption."

Media processing (`src/lib/services/media-evidence.service.ts`) runs once per
post:

1. Every carousel slide and every video in the post (no page limit).
2. Video frames: one frame per second for the full length of the video
   (a 45 s video gives 45 frames). No duplicate removal, no frame limit.
3. Local OCR (Tesseract) on every frame and slide, using up to 4 workers
   (`OCR_WORKERS`).
4. Vision OCR on every carousel slide, on video frames local OCR could not
   read (stylised overlays, shop signs), and on every frame of a list post
   whose places are not named in the text.
5. Speech: TikTok's own subtitles when available (free), otherwise Whisper.

There are no page, frame or line caps by default. Processing time grows with
video length (local OCR measured at about 0.6 s per frame per worker on a
720p reel; this varies by machine and resolution), and list
posts send every frame to vision OCR. Set the optional caps below only if run
time or cost needs bounding.

Optional settings:

```env
# Vision OCR fallback: google (default when a Google key exists) | openai | off
OCR_FALLBACK_PROVIDER=google
# Separate key for Cloud Vision (defaults to GOOGLE_MAPS_API_KEY). The key's
# project must have the Cloud Vision API enabled and the key must be allowed
# to call it; otherwise the pipeline falls back to OpenAI vision.
GOOGLE_VISION_API_KEY=
OCR_FALLBACK_MAX_FRAMES=     # optional cap on vision OCR for unreadable video frames (default: none)
OCR_MAX_KEY_FRAMES=          # optional cap on frames per video, spread evenly (default: none)
OCR_WORKERS=                 # parallel Tesseract workers (default: min(4, CPU cores))
OCR_LANGS=eng+hin            # Tesseract languages
GROQ_API_KEY=                # if set, Groq whisper-large-v3 is used first for speech
OPENAI_CHAT_MODEL=gpt-4o
# Geocoding fallback when Google is not configured, out of quota, or finds no
# verified match. NEXT_PUBLIC_MAPBOX_TOKEN is used if this is not set.
MAPBOX_ACCESS_TOKEN=
```

Geocoding order: Google Places → Mapbox (Search Box API for venues, Geocoding
v6 for cities and addresses). Both go through the same checks (name
similarity, city, neighbourhood, address); Mapbox results are never stored as
Google place ids. Every carousel slide is read with vision OCR (slides are the
content of guide posts).

Apply `supabase/migration_v25_place_evidence.sql` to enable Google place-id
deduplication and stored per-post explanations. The app detects the new
columns at runtime and works without them.

Run the tests with `npm test`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit file.

This project uses `[next/font](https://nextjs.org/docs/app/building-your-application/optimizing/fonts)` to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
