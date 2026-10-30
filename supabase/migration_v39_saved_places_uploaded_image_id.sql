-- Migration v39: Add uploaded_image_id to saved_places table
-- This allows saved places to be linked directly to an uploaded image source (just like social_post_id links to social posts).

-- 1. Add uploaded_image_id column referencing public.uploaded_images
ALTER TABLE public.saved_places 
ADD COLUMN IF NOT EXISTS uploaded_image_id uuid REFERENCES public.uploaded_images(id) ON DELETE CASCADE;

-- 2. Add index for fast lookups by uploaded_image_id
CREATE INDEX IF NOT EXISTS idx_saved_places_uploaded_image_id ON public.saved_places(uploaded_image_id);

-- 3. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
