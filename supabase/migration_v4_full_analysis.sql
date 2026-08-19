-- ── MIGRATION V4: Full Analysis & Raw Data Storage ──
-- Run this in your Supabase SQL Editor after migration_v3_social_posts.sql
-- This adds all new columns needed for the full intelligence pipeline

-- ── 1. SOCIAL POSTS — Add all new columns ──
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS raw_apify_data        jsonb,          -- Full unmodified Apify response
  ADD COLUMN IF NOT EXISTS ai_analysis           jsonb,          -- Full 32-section OpenAI analysis
  ADD COLUMN IF NOT EXISTS ocr_frames_apify      jsonb,          -- Timestamped Apify OCR frame results
  ADD COLUMN IF NOT EXISTS ocr_frames_gpt        jsonb,          -- Timestamped GPT-4o Vision frame results
  ADD COLUMN IF NOT EXISTS whisper_transcript    text,           -- Whisper audio transcript
  ADD COLUMN IF NOT EXISTS video_plays           integer,        -- videoPlayCount from Apify
  ADD COLUMN IF NOT EXISTS video_duration        integer,        -- Duration in seconds
  ADD COLUMN IF NOT EXISTS dimensions_width      integer,        -- Video width px
  ADD COLUMN IF NOT EXISTS dimensions_height     integer,        -- Video height px
  ADD COLUMN IF NOT EXISTS hashtags              text[],         -- Array of hashtags (without #)
  ADD COLUMN IF NOT EXISTS mentions              text[],         -- Array of mentions (without @)
  ADD COLUMN IF NOT EXISTS tagged_users          jsonb,          -- Full tagged user objects
  ADD COLUMN IF NOT EXISTS music_info            jsonb,          -- Artist, song, audio_id
  ADD COLUMN IF NOT EXISTS mentioned_brands      text[],         -- AI-extracted brand names
  ADD COLUMN IF NOT EXISTS mentioned_locations   text[],         -- AI-extracted location names
  ADD COLUMN IF NOT EXISTS primary_category      text,           -- e.g. "Food & Dining"
  ADD COLUMN IF NOT EXISTS secondary_categories  text[],         -- Additional categories
  ADD COLUMN IF NOT EXISTS content_summary       text,           -- AI-generated content summary
  ADD COLUMN IF NOT EXISTS is_promotional        boolean,        -- Whether content appears promotional
  ADD COLUMN IF NOT EXISTS is_paid_partnership   boolean,        -- Platform-confirmed paid partnership
  ADD COLUMN IF NOT EXISTS owner_full_name       text,           -- Creator full name
  ADD COLUMN IF NOT EXISTS short_code            text,           -- Instagram shortCode
  ADD COLUMN IF NOT EXISTS product_type          text,           -- e.g. "clips", "feed"
  ADD COLUMN IF NOT EXISTS engagement_rate       numeric(8,4),   -- Calculated engagement rate
  ADD COLUMN IF NOT EXISTS ocr_combined_text     text,           -- Merged unique OCR text (searchable)
  ADD COLUMN IF NOT EXISTS display_url           text,           -- Thumbnail/cover image URL
  ADD COLUMN IF NOT EXISTS first_comment         text,           -- First comment on post
  ADD COLUMN IF NOT EXISTS niche                 text,           -- AI-extracted influencer niche
  ADD COLUMN IF NOT EXISTS target_audience       text,           -- AI-extracted audience description
  ADD COLUMN IF NOT EXISTS call_to_actions       text[];         -- Detected CTAs

-- ── 2. INDEXES for fast queries ──

-- GIN index on hashtags array for "posts with hashtag X" queries
CREATE INDEX IF NOT EXISTS idx_social_posts_hashtags
  ON public.social_posts USING gin(hashtags);

-- GIN index on mentioned_brands for brand analysis
CREATE INDEX IF NOT EXISTS idx_social_posts_brands
  ON public.social_posts USING gin(mentioned_brands);

-- GIN index on raw Apify data for flexible JSONB queries
CREATE INDEX IF NOT EXISTS idx_social_posts_raw_apify
  ON public.social_posts USING gin(raw_apify_data);

-- GIN index on AI analysis for campaign queries
CREATE INDEX IF NOT EXISTS idx_social_posts_ai_analysis
  ON public.social_posts USING gin(ai_analysis);

-- Full-text search on combined OCR text
CREATE INDEX IF NOT EXISTS idx_social_posts_ocr_text
  ON public.social_posts USING gin(to_tsvector('english', coalesce(ocr_combined_text, '')));

-- ── 3. Add platform index for fast platform filtering ──
CREATE INDEX IF NOT EXISTS idx_social_posts_platform
  ON public.social_posts(platform);

-- ── 4. Add engagement_rate index for sorting by performance ──
CREATE INDEX IF NOT EXISTS idx_social_posts_engagement
  ON public.social_posts(engagement_rate DESC NULLS LAST);

-- ── 5. View: social_posts_enriched — easy frontend queries ──
CREATE OR REPLACE VIEW public.social_posts_enriched AS
SELECT
  sp.id,
  sp.platform,
  sp.content_type,
  sp.content_id,
  sp.author_username,
  sp.owner_full_name,
  sp.short_code,
  sp.caption,
  sp.video_url,
  sp.display_url,
  sp.likes,
  sp.views,
  sp.comments,
  sp.video_plays,
  sp.video_duration,
  sp.dimensions_width,
  sp.dimensions_height,
  sp.hashtags,
  sp.mentions,
  sp.tagged_users,
  sp.music_info,
  sp.mentioned_brands,
  sp.mentioned_locations,
  sp.primary_category,
  sp.secondary_categories,
  sp.content_summary,
  sp.is_promotional,
  sp.is_paid_partnership,
  sp.engagement_rate,
  sp.niche,
  sp.target_audience,
  sp.call_to_actions,
  sp.ocr_combined_text,
  sp.whisper_transcript,
  sp.created_at,
  -- Place details joined
  p.name AS place_name,
  p.city AS place_city,
  p.neighborhood AS place_neighborhood,
  p.category AS place_category,
  p.latitude,
  p.longitude,
  p.address AS place_address
FROM public.social_posts sp
LEFT JOIN public.places p ON sp.place_id = p.id;
