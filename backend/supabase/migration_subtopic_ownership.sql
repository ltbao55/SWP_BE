-- ============================================================
-- MIGRATION: Subtopic-owned assets + labelsets
--            + projects.dataset_id (for auto-task-generation)
-- Run AFTER migration_taxonomy.sql
-- ============================================================

-- ── 1) data_items: assets now belong to a Subtopic ──────────
--    Dataset is a "selection of subtopics" (M-N via dataset_subtopics),
--    so data_items are owned by subtopic; dataset_id becomes optional
--    (kept for legacy; tasks will resolve assets via dataset_subtopics).
ALTER TABLE public.data_items
  ADD COLUMN IF NOT EXISTS subtopic_id UUID REFERENCES public.subtopics(id) ON DELETE CASCADE;
ALTER TABLE public.data_items
  ALTER COLUMN dataset_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_items_subtopic ON public.data_items(subtopic_id);

-- ── 2) label_sets: a LabelSet belongs to a Subtopic ─────────
ALTER TABLE public.label_sets
  ADD COLUMN IF NOT EXISTS subtopic_id UUID REFERENCES public.subtopics(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_label_sets_subtopic ON public.label_sets(subtopic_id);

-- ── 3) projects: link to a Dataset for auto-task generation ─
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES public.datasets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_dataset ON public.projects(dataset_id);

-- ── 4) Taxonomy stats view (used by /api/topics/taxonomy) ───
DROP VIEW IF EXISTS public.topic_taxonomy_stats CASCADE;
CREATE OR REPLACE VIEW public.topic_taxonomy_stats AS
SELECT
  t.id                                             AS topic_id,
  COUNT(DISTINCT s.id)  FILTER (WHERE s.is_active) AS subtopic_count,
  COUNT(DISTINCT di.id)                            AS asset_count,
  COUNT(DISTINCT ls.id)                            AS label_set_count
FROM       public.topics     t
LEFT JOIN  public.subtopics  s  ON s.topic_id    = t.id
LEFT JOIN  public.data_items di ON di.subtopic_id = s.id
LEFT JOIN  public.label_sets ls ON ls.subtopic_id = s.id
GROUP BY t.id;

DROP VIEW IF EXISTS public.subtopic_stats CASCADE;
CREATE OR REPLACE VIEW public.subtopic_stats AS
SELECT
  s.id                  AS subtopic_id,
  COUNT(DISTINCT di.id) AS asset_count,
  COUNT(DISTINCT ls.id) AS label_set_count
FROM       public.subtopics  s
LEFT JOIN  public.data_items di ON di.subtopic_id = s.id
LEFT JOIN  public.label_sets ls ON ls.subtopic_id = s.id
GROUP BY s.id;
