-- ============================================================
-- MIGRATION: Refactor Flow (Remove Taxonomy, Add Master Labels)
-- Run this migration manually in Supabase SQL Editor
-- ============================================================

-- 1. DROP views and tables related to Topic/Subtopic
DROP VIEW IF EXISTS public.topic_taxonomy_stats CASCADE;
DROP VIEW IF EXISTS public.subtopic_stats CASCADE;
DROP TABLE IF EXISTS public.dataset_subtopics CASCADE;
ALTER TABLE IF EXISTS public.data_items DROP COLUMN IF EXISTS subtopic_id CASCADE;
ALTER TABLE IF EXISTS public.label_sets DROP COLUMN IF EXISTS subtopic_id CASCADE;
DROP TABLE IF EXISTS public.subtopics CASCADE;
DROP TABLE IF EXISTS public.topics CASCADE;

-- 2. Modify data_items to depend cleanly on dataset_id
-- We must make dataset_id NOT NULL. If there are orphans, we can delete them.
DELETE FROM public.task_reviewers WHERE task_id IN (SELECT id FROM public.tasks WHERE data_item_id IN (SELECT id FROM public.data_items WHERE dataset_id IS NULL));
DELETE FROM public.tasks WHERE data_item_id IN (SELECT id FROM public.data_items WHERE dataset_id IS NULL);
DELETE FROM public.data_items WHERE dataset_id IS NULL;
ALTER TABLE public.data_items ALTER COLUMN dataset_id SET NOT NULL;

-- 3. Modify datasets: remove topic dependency
ALTER TABLE public.datasets DROP COLUMN IF EXISTS topic_id CASCADE;

-- 4. Delete old tasks constraint mapping to label_set_id
ALTER TABLE public.tasks DROP COLUMN IF EXISTS label_set_id CASCADE;

-- 5. Drop old label structures
DROP TABLE IF EXISTS public.labels CASCADE;
DROP TABLE IF EXISTS public.label_sets CASCADE;

-- 6. Create NEW Master Labels table
CREATE TABLE IF NOT EXISTS public.labels (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#3b82f6',
  description TEXT,
  manager_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_manager ON public.labels(manager_id);

-- 7. Create NEW Project Labels table (M-N mapping)
CREATE TABLE IF NOT EXISTS public.project_labels (
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  label_id UUID REFERENCES public.labels(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  PRIMARY KEY (project_id, label_id)
);

-- Create the update function in case it doesn't exist
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for updating labels
CREATE TRIGGER handle_updated_at_labels
  BEFORE UPDATE ON public.labels
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
