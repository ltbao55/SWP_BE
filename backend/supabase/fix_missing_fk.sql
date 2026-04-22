-- ============================================================
-- FIX: Missing Foreign Key relationship for project_labels
-- ============================================================

-- 1. Ensure project_labels table exists with correct constraints
-- If it already exists, we will just add the missing FKs.

DO $$
BEGIN
    -- Check if project_id FK exists, if not add it
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'project_labels_project_id_fkey' 
        AND table_name = 'project_labels'
    ) THEN
        ALTER TABLE public.project_labels 
        ADD CONSTRAINT project_labels_project_id_fkey 
        FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
    END IF;

    -- Check if label_id FK exists, if not add it
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

-- 2. Enable RLS (In case it was missed in previous migrations)
ALTER TABLE public.project_labels ENABLE ROW LEVEL SECURITY;

-- 3. Add Policies
DROP POLICY IF EXISTS "project_labels_select" ON public.project_labels;
CREATE POLICY "project_labels_select" ON public.project_labels
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "project_labels_write" ON public.project_labels;
CREATE POLICY "project_labels_write" ON public.project_labels
  FOR ALL USING (public.get_my_role() IN ('admin','manager'))
  WITH CHECK (public.get_my_role() IN ('admin','manager'));
