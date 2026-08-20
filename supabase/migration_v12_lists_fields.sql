-- ── MIGRATION V12: SCHEMA REALIGNMENT FOR PROFILES, LISTS, AND SAVED PLACES ──
-- Paste and execute this script inside your Supabase SQL Editor.

-- 1. Drop existing tables that depend on lists and profiles
DROP TABLE IF EXISTS public.list_places CASCADE;
DROP TABLE IF EXISTS public.list_collaborators CASCADE;
DROP TABLE IF EXISTS public.lists CASCADE;
DROP TABLE IF EXISTS public.saved_places CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- 2. Re-create public.profiles table (strictly like Image 2)
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  phone text,
  created_at timestamptz DEFAULT now()
);

-- 3. Re-create public.lists table (strictly like Image 2)
CREATE TABLE public.lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  description text,
  city text DEFAULT 'New York',
  cover_emoji text DEFAULT '📍',
  is_public boolean DEFAULT true,
  slug text,
  created_at timestamptz DEFAULT now()
);

-- 4. Re-create public.list_places table (strictly like Image 2)
CREATE TABLE public.list_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  position integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, place_id)
);

-- 5. Re-create public.list_collaborators table
CREATE TABLE public.list_collaborators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES public.lists(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role text DEFAULT 'editor', -- editor | viewer
  created_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
);

-- 6. Re-create public.saved_places table (strictly like Image 2)
CREATE TABLE public.saved_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  place_id uuid REFERENCES public.places(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, place_id)
);

-- 7. Enable Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_places ENABLE ROW LEVEL SECURITY;

-- 8. Re-create profiles policies
CREATE POLICY "Anyone can read profiles" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (id = auth.uid());
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (id = auth.uid());

-- 9. Re-create lists policies
CREATE POLICY "Users can view their own lists and shared lists" ON public.lists FOR SELECT USING (
  user_id = auth.uid()
  OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
  OR is_public = true
);
CREATE POLICY "Users can create their own lists" ON public.lists FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Owners can update their lists" ON public.lists FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Owners can delete their lists" ON public.lists FOR DELETE USING (user_id = auth.uid());

-- 10. Re-create list_places policies
CREATE POLICY "Users can view places in accessible lists" ON public.list_places FOR SELECT USING (
  list_id IN (
    SELECT id FROM public.lists WHERE
      user_id = auth.uid()
      OR id IN (SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid())
      OR is_public = true
  )
);
CREATE POLICY "List owners and collaborators can add places" ON public.list_places FOR INSERT WITH CHECK (
  list_id IN (
    SELECT id FROM public.lists WHERE user_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);
CREATE POLICY "List owners and collaborators can remove places" ON public.list_places FOR DELETE USING (
  list_id IN (
    SELECT id FROM public.lists WHERE user_id = auth.uid()
    UNION
    SELECT list_id FROM public.list_collaborators WHERE user_id = auth.uid() AND role = 'editor'
  )
);

-- 11. Re-create list_collaborators policies
CREATE POLICY "Users can view list collaborators" ON public.list_collaborators FOR SELECT USING (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
  OR user_id = auth.uid()
);
CREATE POLICY "Owners can invite collaborators" ON public.list_collaborators FOR INSERT WITH CHECK (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
);
CREATE POLICY "Owners can remove collaborators" ON public.list_collaborators FOR DELETE USING (
  list_id IN (SELECT id FROM public.lists WHERE user_id = auth.uid())
);

-- 12. Re-create saved_places policies
CREATE POLICY "Users can view their saved places" ON public.saved_places FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their saved places" ON public.saved_places FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their saved places" ON public.saved_places FOR DELETE USING (auth.uid() = user_id);

-- 13. Re-create handle_new_user() trigger function using phone
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, phone)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Explorer'),
    new.phone
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 14. Reload PostgREST schema cache to apply changes immediately
NOTIFY pgrst, 'reload schema';
