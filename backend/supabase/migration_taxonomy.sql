-- ============================================================
-- DATA LABELING SUPPORT SYSTEM — MASTER MIGRATION v5
-- Replaces: migration_taxonomy.sql, migration_subtopic_ownership.sql,
--           migration_refactor_flow.sql, migration_asset_gallery.sql,
--           fix_labels_schema.sql, fix_missing_fk.sql,
--           fix_review_500.sql, migration_label_topic.sql
--
-- Run AFTER schema.sql (base tables must exist).
-- Idempotent: safe to run multiple times (uses IF NOT EXISTS / OR REPLACE).
-- Does NOT drop existing data.
-- ============================================================

-- ============================================================
-- PART 1 — TOPICS (global label grouping)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.topics (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  color       TEXT        NOT NULL DEFAULT '#6366f1',
  manager_id  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topics_manager ON public.topics(manager_id);

CREATE OR REPLACE TRIGGER trg_topics_upd
  BEFORE UPDATE ON public.topics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "topics_select" ON public.topics;
CREATE POLICY "topics_select" ON public.topics
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "topics_write" ON public.topics;
CREATE POLICY "topics_write" ON public.topics
  FOR ALL
  USING    (public.get_my_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- ============================================================
-- PART 2 — LABELS (master, global, reusable)
-- ============================================================

-- 2a. Ensure labels table has correct refactored schema
--     (removes old label_set_id dependency if present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'labels' AND column_name = 'label_set_id'
  ) THEN
    ALTER TABLE public.labels DROP COLUMN label_set_id CASCADE;
  END IF;
END $$;

-- 2b. Add manager_id if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'labels' AND column_name = 'manager_id'
  ) THEN
    ALTER TABLE public.labels
      ADD COLUMN manager_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2c. Add updated_at if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'labels' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.labels
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- 2d. Add topic_id (FK → topics) — THE NEW GROUPING COLUMN
ALTER TABLE public.labels
  ADD COLUMN IF NOT EXISTS topic_id UUID
  REFERENCES public.topics(id) ON DELETE SET NULL;

-- 2e. Column constraints
ALTER TABLE public.labels ALTER COLUMN name  SET NOT NULL;
ALTER TABLE public.labels ALTER COLUMN color SET DEFAULT '#3b82f6';

-- 2f. Unique name constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'labels_name_key'
  ) THEN
    ALTER TABLE public.labels ADD CONSTRAINT labels_name_key UNIQUE (name);
  END IF;
END $$;

-- 2g. Indexes
CREATE INDEX IF NOT EXISTS idx_labels_manager ON public.labels(manager_id);
CREATE INDEX IF NOT EXISTS idx_labels_topic   ON public.labels(topic_id);

-- 2h. RLS on labels
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "labels_select" ON public.labels;
CREATE POLICY "labels_select" ON public.labels
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "labels_insert" ON public.labels;
CREATE POLICY "labels_insert" ON public.labels
  FOR INSERT WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

DROP POLICY IF EXISTS "labels_update" ON public.labels;
CREATE POLICY "labels_update" ON public.labels
  FOR UPDATE USING (public.get_my_role() IN ('admin', 'manager'));

DROP POLICY IF EXISTS "labels_delete" ON public.labels;
CREATE POLICY "labels_delete" ON public.labels
  FOR DELETE USING (public.get_my_role() IN ('admin', 'manager'));

-- ============================================================
-- PART 3 — PROJECT_LABELS (M-N: project ↔ label)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.project_labels (
  project_id UUID NOT NULL,
  label_id   UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, label_id)
);

-- Foreign keys (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'project_labels_project_id_fkey'
      AND table_name = 'project_labels'
  ) THEN
    ALTER TABLE public.project_labels
      ADD CONSTRAINT project_labels_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'project_labels_label_id_fkey'
      AND table_name = 'project_labels'
  ) THEN
    ALTER TABLE public.project_labels
      ADD CONSTRAINT project_labels_label_id_fkey
      FOREIGN KEY (label_id) REFERENCES public.labels(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.project_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_labels_select" ON public.project_labels;
CREATE POLICY "project_labels_select" ON public.project_labels
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "project_labels_write" ON public.project_labels;
CREATE POLICY "project_labels_write" ON public.project_labels
  FOR ALL
  USING    (public.get_my_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- ============================================================
-- PART 4 — PROJECT_MEMBERS (annotators / reviewers per project)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.project_members (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('annotator', 'reviewer')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_proj ON public.project_members(project_id, role);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
CREATE POLICY "project_members_select" ON public.project_members
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.get_my_role() IN ('admin', 'manager', 'reviewer')
  );

DROP POLICY IF EXISTS "project_members_write" ON public.project_members;
CREATE POLICY "project_members_write" ON public.project_members
  FOR ALL
  USING    (public.get_my_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- ============================================================
-- PART 5 — PROJECTS: add dataset_id for auto-task generation
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dataset_id UUID
  REFERENCES public.datasets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_dataset ON public.projects(dataset_id);

-- ============================================================
-- PART 6 — TASKS: fix error_category CHECK constraint
-- ============================================================

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_error_category_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_error_category_check
  CHECK (error_category IN (
    'incorrect_label', 'missing_label', 'poor_quality',
    'does_not_follow_guidelines', 'other'
  ));

-- ============================================================
-- PART 7 — VIEWS
-- ============================================================

-- 7a. project_task_stats (recreate to stay in sync)
CREATE OR REPLACE VIEW public.project_task_stats AS
SELECT
  project_id,
  COUNT(*)                                              AS total_tasks,
  COUNT(*) FILTER (WHERE status = 'assigned')           AS assigned_tasks,
  COUNT(*) FILTER (WHERE status = 'in_progress')        AS in_progress_tasks,
  COUNT(*) FILTER (WHERE status = 'submitted')          AS submitted_tasks,
  COUNT(*) FILTER (WHERE status = 'resubmitted')        AS resubmitted_tasks,
  COUNT(*) FILTER (WHERE status = 'approved')           AS approved_tasks,
  COUNT(*) FILTER (WHERE status = 'rejected')           AS rejected_tasks,
  COUNT(*) FILTER (WHERE status = 'expired')            AS expired_tasks,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'approved')::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 2
  )                                                     AS approval_rate
FROM public.tasks
GROUP BY project_id;

-- ============================================================
-- PART 8 — DROP deprecated RPC (column count mismatch bug)
-- get_stratified_tasks() is replaced by JS-side sampling in reviews.js
-- ============================================================

DROP FUNCTION IF EXISTS public.get_stratified_tasks(UUID, FLOAT, INT, INT) CASCADE;

-- ============================================================
-- PART 9 — VERIFICATION (uncomment to confirm after running)
-- ============================================================
/*
SELECT
  'topics'          AS tbl, COUNT(*) FROM public.topics
UNION ALL SELECT
  'labels',           COUNT(*) FROM public.labels
UNION ALL SELECT
  'project_labels',   COUNT(*) FROM public.project_labels
UNION ALL SELECT
  'project_members',  COUNT(*) FROM public.project_members;

-- Check topic_id column exists on labels
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'labels'
  AND column_name  IN ('topic_id', 'manager_id', 'updated_at');
*/
