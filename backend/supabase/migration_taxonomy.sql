-- ============================================================
-- MIGRATION: Taxonomy (topics, subtopics) + Dataset classification
--            + Project members (annotators / reviewers)
-- Run AFTER schema.sql. Safe to re-run (uses IF NOT EXISTS / DROP...CASCADE).
-- ============================================================

-- ── Cleanup (safe re-run) ────────────────────────────────────
DROP TABLE IF EXISTS public.dataset_subtopics CASCADE;
DROP TABLE IF EXISTS public.project_members   CASCADE;
DROP TABLE IF EXISTS public.subtopics         CASCADE;
DROP TABLE IF EXISTS public.topics            CASCADE;

-- ============================================================
-- 1) topics
-- ============================================================
CREATE TABLE public.topics (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT DEFAULT '#3b82f6',
  manager_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2) subtopics (N–1 topic)
-- ============================================================
CREATE TABLE public.subtopics (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic_id    UUID NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (topic_id, name)
);

-- ============================================================
-- 3) datasets — add topic_id
-- ============================================================
ALTER TABLE public.datasets
  ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES public.topics(id) ON DELETE SET NULL;

-- ============================================================
-- 4) dataset_subtopics  (M–N)
--    Một dataset thuộc nhiều subtopic, một subtopic có nhiều dataset.
-- ============================================================
CREATE TABLE public.dataset_subtopics (
  dataset_id  UUID NOT NULL REFERENCES public.datasets(id)  ON DELETE CASCADE,
  subtopic_id UUID NOT NULL REFERENCES public.subtopics(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_id, subtopic_id)
);

-- ============================================================
-- 5) project_members — annotators / reviewers
--    Thay vì lưu mảng trong JSONB, dùng bảng để join và query hiệu quả.
-- ============================================================
CREATE TABLE public.project_members (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('annotator', 'reviewer')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id, role)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subtopics_topic           ON public.subtopics(topic_id);
CREATE INDEX IF NOT EXISTS idx_datasets_topic            ON public.datasets(topic_id);
CREATE INDEX IF NOT EXISTS idx_dataset_subtopics_sub     ON public.dataset_subtopics(subtopic_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user      ON public.project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_role      ON public.project_members(project_id, role);

-- ── updated_at triggers ──────────────────────────────────────
CREATE TRIGGER trg_topics_upd    BEFORE UPDATE ON public.topics    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_subtopics_upd BEFORE UPDATE ON public.subtopics FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.topics            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subtopics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dataset_subtopics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members   ENABLE ROW LEVEL SECURITY;

-- topics: authenticated read, manager/admin write
CREATE POLICY "topics_select" ON public.topics
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "topics_write"  ON public.topics
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK    (public.get_my_role() IN ('admin','manager'));

-- subtopics
CREATE POLICY "subtopics_select" ON public.subtopics
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "subtopics_write"  ON public.subtopics
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK    (public.get_my_role() IN ('admin','manager'));

-- dataset_subtopics
CREATE POLICY "dataset_subtopics_select" ON public.dataset_subtopics
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "dataset_subtopics_write"  ON public.dataset_subtopics
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK    (public.get_my_role() IN ('admin','manager'));

-- project_members: member thấy chính mình; manager/admin full access
CREATE POLICY "project_members_select" ON public.project_members
  FOR SELECT USING (
    user_id = auth.uid() OR public.get_my_role() IN ('admin','manager','reviewer')
  );
CREATE POLICY "project_members_write"  ON public.project_members
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK    (public.get_my_role() IN ('admin','manager'));
