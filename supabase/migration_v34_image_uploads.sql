-- Direct image uploads are kept separate from social-post links so existing
-- URL processing and social_post_places invariants remain unchanged.

CREATE TABLE IF NOT EXISTS public.uploaded_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  file_names text[] NOT NULL DEFAULT '{}',
  storage_paths text[] NOT NULL DEFAULT '{}',
  image_urls text[] NOT NULL DEFAULT '{}',
  caption text NOT NULL DEFAULT '',
  ai_analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_images_user_id ON public.uploaded_images(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_images_status ON public.uploaded_images(status);

-- Reuse the established social_post_places link table for both source modes:
-- URL rows have social_post_id; uploaded-image rows have uploaded_image_id.
ALTER TABLE public.social_post_places
  ADD COLUMN IF NOT EXISTS uploaded_image_id uuid
    REFERENCES public.uploaded_images(id) ON DELETE CASCADE;

ALTER TABLE public.social_post_places
  ADD COLUMN IF NOT EXISTS confidence numeric(4, 3),
  ADD COLUMN IF NOT EXISTS explanation text,
  ADD COLUMN IF NOT EXISTS evidence jsonb;

ALTER TABLE public.social_post_places
  ALTER COLUMN social_post_id DROP NOT NULL;

ALTER TABLE public.social_post_places
  DROP CONSTRAINT IF EXISTS social_post_places_one_source;

ALTER TABLE public.social_post_places
  ADD CONSTRAINT social_post_places_one_source CHECK (
    (social_post_id IS NOT NULL AND uploaded_image_id IS NULL)
    OR (social_post_id IS NULL AND uploaded_image_id IS NOT NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.social_post_places'::regclass
      AND conname = 'social_post_places_uploaded_image_place_key'
  ) THEN
    ALTER TABLE public.social_post_places
      ADD CONSTRAINT social_post_places_uploaded_image_place_key
      UNIQUE (uploaded_image_id, place_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_social_post_places_uploaded_image_id
  ON public.social_post_places(uploaded_image_id)
  WHERE uploaded_image_id IS NOT NULL;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'image_uploads',
  'image_uploads',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read image uploads" ON storage.objects;
CREATE POLICY "Public read image uploads" ON storage.objects
  FOR SELECT USING (bucket_id = 'image_uploads');

NOTIFY pgrst, 'reload schema';
