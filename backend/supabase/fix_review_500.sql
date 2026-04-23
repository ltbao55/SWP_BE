-- ============================================================
-- FIX: "Failed to fetch pending reviews" — 500 Internal Server Error
-- ============================================================
-- Idempotent: safe to run multiple times.
-- Does NOT drop any existing data.
-- Run in Supabase SQL Editor.
-- ============================================================

-- ── 1. Ensure labels table has the correct (refactored) schema ─
-- Add manager_id column if missing
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

-- Remove old label_set_id dependency if it still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'labels' AND column_name = 'label_set_id'
  ) THEN
    ALTER TABLE public.labels DROP COLUMN label_set_id CASCADE;
  END IF;
END $$;

ALTER TABLE public.labels ALTER COLUMN name  SET NOT NULL;
ALTER TABLE public.labels ALTER COLUMN color SET DEFAULT '#3b82f6';

-- Add updated_at if missing
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

-- Unique name constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'labels_name_key'
  ) THEN
    ALTER TABLE public.labels ADD CONSTRAINT labels_name_key UNIQUE (name);
  END IF;
END $$;

-- ── 2. project_labels table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_labels (
  project_id UUID NOT NULL,
  label_id   UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, label_id)
);

-- FK: project_labels → projects
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

-- FK: project_labels → labels
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

-- ── 3. RLS on labels ───────────────────────────────────────────
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

-- ── 4. RLS on project_labels ───────────────────────────────────
ALTER TABLE public.project_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_labels_select" ON public.project_labels;
CREATE POLICY "project_labels_select" ON public.project_labels
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "project_labels_write" ON public.project_labels;
CREATE POLICY "project_labels_write" ON public.project_labels
  FOR ALL
  USING    (public.get_my_role() IN ('admin', 'manager'))
  WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- ── 5. project_members table ───────────────────────────────────
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

-- ── 6. projects.dataset_id column ─────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES public.datasets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_dataset ON public.projects(dataset_id);

-- ── 7. get_stratified_tasks() RPC ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_stratified_tasks(
  p_project_id  UUID,
  p_sample_rate FLOAT,
  p_limit       INT DEFAULT 50,
  p_offset      INT DEFAULT 0
)
RETURNS SETOF public.tasks AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY annotator_id ORDER BY random()) AS rank,
      COUNT(*)     OVER (PARTITION BY annotator_id)                    AS total_per_anno
    FROM public.tasks
    WHERE project_id = p_project_id
      AND status IN ('submitted', 'resubmitted')
  ) t
  WHERE rank <= CEIL(total_per_anno * p_sample_rate)
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 8. Fix tasks.error_category CHECK constraint ───────────────
-- Drop old constraint (if any) and recreate with all valid values
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_error_category_check;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_error_category_check
  CHECK (error_category IN (
    'incorrect_label', 'missing_label', 'poor_quality',
    'does_not_follow_guidelines', 'other'
  ));

-- ── 9. Recreate project_task_stats view ───────────────────────
-- (safe DROP + CREATE OR REPLACE)
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

-- ── 10. Verification query (run after script to confirm) ───────
/*
SELECT
  (SELECT COUNT(*) FROM public.labels)         AS labels_count,
  (SELECT COUNT(*) FROM public.project_labels) AS project_labels_count,
  (SELECT COUNT(*) FROM public.project_members)AS project_members_count,
  EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name   = 'get_stratified_tasks'
  ) AS rpc_exists,
  EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'project_labels_label_id_fkey'
  ) AS fk_label_exists;
*/
