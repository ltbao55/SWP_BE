-- ============================================================
-- DATA LABELING SUPPORT SYSTEM — SUPABASE SCHEMA v4
-- ============================================================

-- ── Cleanup (safe re-run) ────────────────────────────────────
DROP VIEW     IF EXISTS public.project_task_stats  CASCADE;
DROP TABLE    IF EXISTS public.activity_logs       CASCADE;
DROP TABLE    IF EXISTS public.task_reviewers      CASCADE;
DROP TABLE    IF EXISTS public.tasks               CASCADE;
DROP TABLE    IF EXISTS public.labels              CASCADE;
DROP TABLE    IF EXISTS public.label_sets          CASCADE;
DROP TABLE    IF EXISTS public.data_items          CASCADE;
DROP TABLE    IF EXISTS public.datasets            CASCADE;
DROP TABLE    IF EXISTS public.projects            CASCADE;
DROP TABLE    IF EXISTS public.system_settings     CASCADE;
DROP TABLE    IF EXISTS public.profiles            CASCADE;
DROP FUNCTION IF EXISTS public.get_my_role()       CASCADE;
DROP FUNCTION IF EXISTS public.update_updated_at() CASCADE;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- STEP 1 — profiles (must exist before get_my_role)
-- ============================================================
CREATE TABLE public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT UNIQUE NOT NULL,
  full_name  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'annotator'
               CHECK (role IN ('admin','manager','annotator','reviewer')),
  specialty  TEXT NOT NULL DEFAULT 'general',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STEP 2 — helper function (profiles now exists)
-- SECURITY DEFINER: runs as owner → bypasses RLS on profiles
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- ============================================================
-- STEP 3 — remaining tables
-- ============================================================
CREATE TABLE public.projects (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  description    TEXT,
  manager_id     UUID NOT NULL REFERENCES public.profiles(id),
  guidelines     TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','active','in_review','waiting_rework','finalizing','completed','archived')),
  deadline       TIMESTAMPTZ,
  export_format  TEXT NOT NULL DEFAULT 'JSON'
                   CHECK (export_format IN ('YOLO','VOC','COCO','JSON','CSV')),
  review_policy  JSONB NOT NULL DEFAULT '{"mode":"full","sample_rate":1,"reviewers_per_item":1}'::JSONB,
  total_tasks    INT NOT NULL DEFAULT 0,
  reviewed_tasks INT NOT NULL DEFAULT 0,
  project_review JSONB DEFAULT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.datasets (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id   UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  manager_id   UUID NOT NULL REFERENCES public.profiles(id),
  name         TEXT NOT NULL,
  description  TEXT,
  type         TEXT NOT NULL DEFAULT 'image'
                 CHECK (type IN ('image','text','audio','video')),
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','labeling','review','completed')),
  total_items  INT NOT NULL DEFAULT 0,
  storage_path TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.data_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_id    UUID NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  original_name TEXT,
  storage_path  TEXT NOT NULL,
  storage_url   TEXT,
  mime_type     TEXT,
  file_size     BIGINT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','assigned','completed')),
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.label_sets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id     UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  manager_id     UUID NOT NULL REFERENCES public.profiles(id),
  name           TEXT NOT NULL,
  description    TEXT,
  allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
  required       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.labels (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_set_id UUID NOT NULL REFERENCES public.label_sets(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#3b82f6',
  description  TEXT,
  shortcut     TEXT,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task status flow:
--   assigned → in_progress → submitted → approved (done)
--                                      → rejected → in_progress → resubmitted → approved/rejected
CREATE TABLE public.tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  dataset_id      UUID NOT NULL REFERENCES public.datasets(id),
  data_item_id    UUID NOT NULL REFERENCES public.data_items(id),
  annotator_id    UUID NOT NULL REFERENCES public.profiles(id),
  reviewer_id     UUID REFERENCES public.profiles(id),
  label_set_id    UUID REFERENCES public.label_sets(id),
  status          TEXT NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('pending','assigned','in_progress','submitted','resubmitted','approved','rejected','expired')),
  annotation_data JSONB DEFAULT NULL,
  review_comments TEXT,
  error_category  TEXT CHECK (error_category IN ('incorrect_label','missing_label','poor_quality','does_not_follow_guidelines','other')),
  review_notes    JSONB NOT NULL DEFAULT '[]'::JSONB,
  review_issues   JSONB NOT NULL DEFAULT '[]'::JSONB,
  submitted_at    TIMESTAMPTZ,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.task_reviewers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES public.profiles(id),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  comment     TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, reviewer_id)
);

CREATE TABLE public.activity_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT CHECK (resource_type IN ('project','task','dataset','user','system','label_set')),
  resource_id   UUID,
  description   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.system_settings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  storage_config JSONB NOT NULL DEFAULT '{"max_file_size":10485760,"max_files_per_dataset":2000}'::JSONB,
  task_config    JSONB NOT NULL DEFAULT '{"max_tasks_per_annotator":100,"auto_assign_enabled":false}'::JSONB,
  review_config  JSONB NOT NULL DEFAULT '{"require_review_comments":true,"max_rejections_before_escalation":3}'::JSONB,
  general_config JSONB NOT NULL DEFAULT '{"site_name":"Data Labeling System","maintenance_mode":false}'::JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     UUID REFERENCES public.profiles(id)
);

-- ============================================================
-- STEP 4 — indexes
-- ============================================================
CREATE INDEX idx_projects_manager   ON public.projects(manager_id);
CREATE INDEX idx_projects_status    ON public.projects(status);
CREATE INDEX idx_datasets_project   ON public.datasets(project_id);
CREATE INDEX idx_datasets_manager   ON public.datasets(manager_id);
CREATE INDEX idx_data_items_dataset ON public.data_items(dataset_id);
CREATE INDEX idx_label_sets_project ON public.label_sets(project_id);
CREATE INDEX idx_labels_set         ON public.labels(label_set_id);
CREATE INDEX idx_tasks_project      ON public.tasks(project_id);
CREATE INDEX idx_tasks_annotator    ON public.tasks(annotator_id);
CREATE INDEX idx_tasks_reviewer     ON public.tasks(reviewer_id);
CREATE INDEX idx_tasks_status       ON public.tasks(status);
CREATE INDEX idx_tasks_data_item    ON public.tasks(data_item_id);
CREATE INDEX idx_task_rev_task      ON public.task_reviewers(task_id);
CREATE INDEX idx_task_rev_reviewer  ON public.task_reviewers(reviewer_id);
CREATE INDEX idx_activity_user      ON public.activity_logs(user_id, created_at DESC);

-- ============================================================
-- STEP 5 — updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_profiles_upd   BEFORE UPDATE ON public.profiles   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_upd   BEFORE UPDATE ON public.projects   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_datasets_upd   BEFORE UPDATE ON public.datasets   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_labelsets_upd  BEFORE UPDATE ON public.label_sets FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tasks_upd      BEFORE UPDATE ON public.tasks      FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- STEP 6 — enable RLS
-- ============================================================
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_sets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.labels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_reviewers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- STEP 7 — RLS policies (get_my_role() + profiles both exist)
-- ============================================================

-- profiles
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id OR public.get_my_role() = 'admin')
  WITH CHECK  (auth.uid() = id OR public.get_my_role() = 'admin');

CREATE POLICY "profiles_delete" ON public.profiles
  FOR DELETE USING (public.get_my_role() = 'admin');

-- projects
CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT WITH CHECK (
    public.get_my_role() IN ('admin','manager') AND manager_id = auth.uid()
  );

CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

CREATE POLICY "projects_delete" ON public.projects
  FOR DELETE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

-- datasets
CREATE POLICY "datasets_select" ON public.datasets
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "datasets_insert" ON public.datasets
  FOR INSERT WITH CHECK (
    public.get_my_role() IN ('admin','manager') AND manager_id = auth.uid()
  );

CREATE POLICY "datasets_update" ON public.datasets
  FOR UPDATE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

CREATE POLICY "datasets_delete" ON public.datasets
  FOR DELETE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

-- data_items
CREATE POLICY "data_items_select" ON public.data_items
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "data_items_write" ON public.data_items
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK (public.get_my_role() IN ('admin','manager'));

-- label_sets
CREATE POLICY "label_sets_select" ON public.label_sets
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "label_sets_write" ON public.label_sets
  FOR ALL USING (manager_id = auth.uid() OR public.get_my_role() = 'admin')
  WITH CHECK (manager_id = auth.uid() OR public.get_my_role() = 'admin');

-- labels
CREATE POLICY "labels_select" ON public.labels
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "labels_write" ON public.labels
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK (public.get_my_role() IN ('admin','manager'));

-- tasks
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT USING (
    annotator_id = auth.uid()
    OR reviewer_id = auth.uid()
    OR public.get_my_role() IN ('admin','manager','reviewer')
  );

CREATE POLICY "tasks_insert" ON public.tasks
  FOR INSERT WITH CHECK (public.get_my_role() IN ('admin','manager'));

CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE USING (
    annotator_id = auth.uid()
    OR reviewer_id = auth.uid()
    OR public.get_my_role() IN ('admin','manager')
  );

CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE USING (public.get_my_role() = 'admin');

-- task_reviewers
CREATE POLICY "task_reviewers_select" ON public.task_reviewers
  FOR SELECT USING (reviewer_id = auth.uid() OR public.get_my_role() IN ('admin','manager'));

CREATE POLICY "task_reviewers_insert" ON public.task_reviewers
  FOR INSERT WITH CHECK (public.get_my_role() IN ('admin','manager'));

CREATE POLICY "task_reviewers_update" ON public.task_reviewers
  FOR UPDATE USING (reviewer_id = auth.uid() OR public.get_my_role() IN ('admin','manager'));

-- activity_logs
CREATE POLICY "activity_logs_select" ON public.activity_logs
  FOR SELECT USING (user_id = auth.uid() OR public.get_my_role() = 'admin');

CREATE POLICY "activity_logs_insert" ON public.activity_logs
  FOR INSERT WITH CHECK (TRUE);

-- system_settings
CREATE POLICY "settings_select" ON public.system_settings
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "settings_write" ON public.system_settings
  FOR ALL USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

-- ============================================================
-- STEP 8 — seed + view
-- ============================================================
INSERT INTO public.system_settings (id) VALUES (uuid_generate_v4());

CREATE OR REPLACE VIEW public.project_task_stats AS
SELECT
  project_id,
  COUNT(*)                                             AS total_tasks,
  COUNT(*) FILTER (WHERE status = 'assigned')         AS assigned_tasks,
  COUNT(*) FILTER (WHERE status = 'in_progress')      AS in_progress_tasks,
  COUNT(*) FILTER (WHERE status = 'submitted')        AS submitted_tasks,
  COUNT(*) FILTER (WHERE status = 'resubmitted')      AS resubmitted_tasks,
  COUNT(*) FILTER (WHERE status = 'approved')         AS approved_tasks,
  COUNT(*) FILTER (WHERE status = 'rejected')         AS rejected_tasks,
  COUNT(*) FILTER (WHERE status = 'expired')          AS expired_tasks,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'approved')::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 2
  )                                                   AS approval_rate
FROM public.tasks
GROUP BY project_id;

-- ============================================================
-- STEP 9 — Storage bucket (run separately in SQL Editor)
-- ============================================================
/*
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('datasets','datasets',false,524288000,
  ARRAY['image/jpeg','image/png','image/webp','image/bmp','image/gif',
        'audio/mpeg','audio/wav','text/plain','text/csv','application/zip'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "storage_upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id='datasets' AND public.get_my_role() IN ('admin','manager'));

CREATE POLICY "storage_read" ON storage.objects FOR SELECT
  USING (bucket_id='datasets' AND auth.role()='authenticated');

CREATE POLICY "storage_delete" ON storage.objects FOR DELETE
  USING (bucket_id='datasets' AND public.get_my_role() IN ('admin','manager'));
*/
