-- Migration: Add status column to saved_places to manage 'BEEN_HERE' and 'WANT_TO_GO'

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'saved_place_status') THEN
        CREATE TYPE saved_place_status AS ENUM ('SAVED', 'BEEN_HERE', 'WANT_TO_GO');
    END IF;
END
$$;

-- Add the status column to the saved_places table
ALTER TABLE saved_places
ADD COLUMN IF NOT EXISTS status saved_place_status DEFAULT 'SAVED';

-- Create an index to optimize filtering by status
CREATE INDEX IF NOT EXISTS idx_saved_places_status ON saved_places(status);
