-- Migration v23: Add avatar_url column to profiles table for storing user profile image (S3 URL)

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS avatar_url text;

-- Comment for documentation
COMMENT ON COLUMN public.profiles.avatar_url IS 'S3 URL or external URL for the user profile image';
