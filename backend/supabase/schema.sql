-- ============================================================
-- DATA LABELING SUPPORT SYSTEM — MASTER SCHEMA
-- (Consolidated single file for context and execution)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PART 1: CORE TABLES (Ordered by dependencies)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  username text NOT NULL UNIQUE,
  full_name text NOT NULL,
  role text NOT NULL DEFAULT 'annotator'::text CHECK (role = ANY (ARRAY['admin'::text, 'manager'::text, 'annotator'::text, 'reviewer'::text])),
  specialty text NOT NULL DEFAULT 'general'::text,
  is_active boolean NOT NULL DEFAULT true,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.topics (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE,
  description text,
  color text NOT NULL DEFAULT '#6366f1'::text,
  manager_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT topics_pkey PRIMARY KEY (id),
  CONSTRAINT topics_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.projects (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  manager_id uuid NOT NULL,
  guidelines text NOT NULL DEFAULT ''::text,
  status text NOT NULL DEFAULT 'draft'::text CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'in_review'::text, 'waiting_rework'::text, 'finalizing'::text, 'completed'::text, 'archived'::text])),
  deadline timestamp with time zone,
  export_format text NOT NULL DEFAULT 'JSON'::text CHECK (export_format = ANY (ARRAY['YOLO'::text, 'VOC'::text, 'COCO'::text, 'JSON'::text, 'CSV'::text])),
  review_policy jsonb NOT NULL DEFAULT '{"mode": "full", "sample_rate": 1, "reviewers_per_item": 1}'::jsonb,
  total_tasks integer NOT NULL DEFAULT 0,
  reviewed_tasks integer NOT NULL DEFAULT 0,
  project_review jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  dataset_id uuid,
  CONSTRAINT projects_pkey PRIMARY KEY (id),
  CONSTRAINT projects_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.profiles(id)
);

CREATE TABLE IF NOT EXISTS public.datasets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  project_id uuid,
  manager_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  type text NOT NULL DEFAULT 'image'::text CHECK (type = ANY (ARRAY['image'::text, 'text'::text, 'audio'::text, 'video'::text])),
  status text NOT NULL DEFAULT 'draft'::text CHECK (status = ANY (ARRAY['draft'::text, 'labeling'::text, 'review'::text, 'completed'::text])),
  total_items integer NOT NULL DEFAULT 0,
  storage_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT datasets_pkey PRIMARY KEY (id),
  CONSTRAINT datasets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL,
  CONSTRAINT datasets_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.profiles(id)
);

-- Add circular dependency fk for projects.dataset_id after datasets is created
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'projects_dataset_id_fkey') THEN
    ALTER TABLE public.projects 
      ADD CONSTRAINT projects_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.data_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  dataset_id uuid NOT NULL,
  filename text NOT NULL,
  original_name text,
  storage_path text NOT NULL,
  storage_url text,
  mime_type text,
  file_size bigint,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'assigned'::text, 'completed'::text])),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ai_status text DEFAULT 'pending'::text CHECK (ai_status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text, 'skipped'::text])),
  ai_suggestion jsonb,
  ai_processed_at timestamp with time zone,
  ai_confidence double precision,
  image_width integer,
  image_height integer,
  CONSTRAINT data_items_pkey PRIMARY KEY (id),
  CONSTRAINT data_items_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.labels (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE,
  color text DEFAULT '#3b82f6'::text,
  description text,
  manager_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  topic_id uuid,
  CONSTRAINT labels_pkey PRIMARY KEY (id),
  CONSTRAINT labels_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT labels_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.project_labels (
  project_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT project_labels_pkey PRIMARY KEY (project_id, label_id),
  CONSTRAINT project_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.labels(id) ON DELETE CASCADE,
  CONSTRAINT project_labels_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.project_members (
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['annotator'::text, 'reviewer'::text])),
  added_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT project_members_pkey PRIMARY KEY (project_id, user_id, role),
  CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.system_settings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  storage_config jsonb NOT NULL DEFAULT '{"max_file_size": 10485760, "max_files_per_dataset": 2000}'::jsonb,
  task_config jsonb NOT NULL DEFAULT '{"auto_assign_enabled": false, "max_tasks_per_annotator": 100}'::jsonb,
  review_config jsonb NOT NULL DEFAULT '{"require_review_comments": true, "max_rejections_before_escalation": 3}'::jsonb,
  general_config jsonb NOT NULL DEFAULT '{"site_name": "Data Labeling System", "maintenance_mode": false}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT system_settings_pkey PRIMARY KEY (id),
  CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  data_item_id uuid NOT NULL,
  annotator_id uuid NOT NULL,
  reviewer_id uuid,
  status text NOT NULL DEFAULT 'assigned'::text CHECK (status = ANY (ARRAY['pending'::text, 'assigned'::text, 'in_progress'::text, 'submitted'::text, 'resubmitted'::text, 'approved'::text, 'rejected'::text, 'expired'::text])),
  annotation_data jsonb,
  review_comments text,
  error_category text CHECK (error_category = ANY (ARRAY['incorrect_label'::text, 'missing_label'::text, 'poor_quality'::text, 'does_not_follow_guidelines'::text, 'other'::text])),
  review_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamp with time zone,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT tasks_pkey PRIMARY KEY (id),
  CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT tasks_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.datasets(id),
  CONSTRAINT tasks_data_item_id_fkey FOREIGN KEY (data_item_id) REFERENCES public.data_items(id),
  CONSTRAINT tasks_annotator_id_fkey FOREIGN KEY (annotator_id) REFERENCES public.profiles(id),
  CONSTRAINT tasks_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.profiles(id)
);

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  action text NOT NULL,
  resource_type text CHECK (resource_type = ANY (ARRAY['project'::text, 'task'::text, 'dataset'::text, 'user'::text, 'system'::text, 'label_set'::text])),
  resource_id uuid,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT activity_logs_pkey PRIMARY KEY (id),
  CONSTRAINT activity_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- ============================================================
-- PART 2: VIEWS
-- ============================================================

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
-- PART 3: FUNCTIONS AND TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_upd ON public.profiles;
CREATE TRIGGER trg_profiles_upd   BEFORE UPDATE ON public.profiles   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_projects_upd ON public.projects;
CREATE TRIGGER trg_projects_upd   BEFORE UPDATE ON public.projects   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_datasets_upd ON public.datasets;
CREATE TRIGGER trg_datasets_upd   BEFORE UPDATE ON public.datasets   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_upd ON public.tasks;
CREATE TRIGGER trg_tasks_upd      BEFORE UPDATE ON public.tasks      FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_topics_upd ON public.topics;
CREATE TRIGGER trg_topics_upd     BEFORE UPDATE ON public.topics     FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_labels_upd ON public.labels;
CREATE TRIGGER trg_labels_upd     BEFORE UPDATE ON public.labels     FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- PART 4: ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================

ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.labels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_labels  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id OR public.get_my_role() = 'admin') WITH CHECK (auth.uid() = id OR public.get_my_role() = 'admin');

-- projects
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects FOR INSERT WITH CHECK (public.get_my_role() IN ('admin','manager') AND manager_id = auth.uid());
DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects FOR UPDATE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');
DROP POLICY IF EXISTS "projects_delete" ON public.projects;
CREATE POLICY "projects_delete" ON public.projects FOR DELETE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

-- datasets
DROP POLICY IF EXISTS "datasets_select" ON public.datasets;
CREATE POLICY "datasets_select" ON public.datasets FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "datasets_insert" ON public.datasets;
CREATE POLICY "datasets_insert" ON public.datasets FOR INSERT WITH CHECK (public.get_my_role() IN ('admin','manager') AND manager_id = auth.uid());
DROP POLICY IF EXISTS "datasets_update" ON public.datasets;
CREATE POLICY "datasets_update" ON public.datasets FOR UPDATE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');
DROP POLICY IF EXISTS "datasets_delete" ON public.datasets;
CREATE POLICY "datasets_delete" ON public.datasets FOR DELETE USING (manager_id = auth.uid() OR public.get_my_role() = 'admin');

-- data_items
DROP POLICY IF EXISTS "data_items_select" ON public.data_items;
CREATE POLICY "data_items_select" ON public.data_items FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "data_items_write" ON public.data_items;
CREATE POLICY "data_items_write" ON public.data_items FOR ALL USING (public.get_my_role() IN ('admin','manager')) WITH CHECK (public.get_my_role() IN ('admin','manager'));

-- topics
DROP POLICY IF EXISTS "topics_select" ON public.topics;
CREATE POLICY "topics_select" ON public.topics FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "topics_write" ON public.topics;
CREATE POLICY "topics_write" ON public.topics FOR ALL USING (public.get_my_role() IN ('admin', 'manager')) WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- labels
DROP POLICY IF EXISTS "labels_select" ON public.labels;
CREATE POLICY "labels_select" ON public.labels FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "labels_write" ON public.labels;
CREATE POLICY "labels_write" ON public.labels FOR ALL USING (public.get_my_role() IN ('admin','manager')) WITH CHECK (public.get_my_role() IN ('admin','manager'));

-- project_labels
DROP POLICY IF EXISTS "project_labels_select" ON public.project_labels;
CREATE POLICY "project_labels_select" ON public.project_labels FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "project_labels_write" ON public.project_labels;
CREATE POLICY "project_labels_write" ON public.project_labels FOR ALL USING (public.get_my_role() IN ('admin', 'manager')) WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- project_members
DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
CREATE POLICY "project_members_select" ON public.project_members FOR SELECT USING (user_id = auth.uid() OR public.get_my_role() IN ('admin', 'manager', 'reviewer'));
DROP POLICY IF EXISTS "project_members_write" ON public.project_members;
CREATE POLICY "project_members_write" ON public.project_members FOR ALL USING (public.get_my_role() IN ('admin', 'manager')) WITH CHECK (public.get_my_role() IN ('admin', 'manager'));

-- tasks
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT USING (annotator_id = auth.uid() OR reviewer_id = auth.uid() OR public.get_my_role() IN ('admin','manager','reviewer'));
DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT WITH CHECK (public.get_my_role() IN ('admin','manager'));
DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE USING (annotator_id = auth.uid() OR reviewer_id = auth.uid() OR public.get_my_role() IN ('admin','manager'));
DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE USING (public.get_my_role() = 'admin');

-- activity_logs
DROP POLICY IF EXISTS "activity_logs_select" ON public.activity_logs;
CREATE POLICY "activity_logs_select" ON public.activity_logs FOR SELECT USING (user_id = auth.uid() OR public.get_my_role() = 'admin');
DROP POLICY IF EXISTS "activity_logs_insert" ON public.activity_logs;
CREATE POLICY "activity_logs_insert" ON public.activity_logs FOR INSERT WITH CHECK (TRUE);

-- system_settings
DROP POLICY IF EXISTS "settings_select" ON public.system_settings;
CREATE POLICY "settings_select" ON public.system_settings FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "settings_write" ON public.system_settings;
CREATE POLICY "settings_write" ON public.system_settings FOR ALL USING (public.get_my_role() = 'admin') WITH CHECK (public.get_my_role() = 'admin');

-- Seed settings if empty
INSERT INTO public.system_settings (id) 
SELECT uuid_generate_v4() 
WHERE NOT EXISTS (SELECT 1 FROM public.system_settings);
