-- Migration: Add parent_list_id for 2-level nested lists

ALTER TABLE lists 
ADD COLUMN IF NOT EXISTS parent_list_id UUID REFERENCES lists(id) ON DELETE CASCADE;

-- Create a function to prevent deep nesting (enforce max 2 levels: Parent -> Child)
CREATE OR REPLACE FUNCTION check_nested_list_depth()
RETURNS TRIGGER AS $$
DECLARE
  parent_depth INTEGER;
BEGIN
  IF NEW.parent_list_id IS NOT NULL THEN
    -- Check if the intended parent is itself a child
    SELECT (parent_list_id IS NOT NULL) INTO parent_depth
    FROM lists
    WHERE id = NEW.parent_list_id;

    IF parent_depth THEN
      RAISE EXCEPTION 'Maximum list nesting depth exceeded. A child list cannot have its own children.';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to enforce the 2-level nested structure on insert or update
DROP TRIGGER IF EXISTS enforce_list_depth ON lists;
CREATE TRIGGER enforce_list_depth
BEFORE INSERT OR UPDATE ON lists
FOR EACH ROW EXECUTE FUNCTION check_nested_list_depth();
