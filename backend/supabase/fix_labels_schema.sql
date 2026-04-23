-- SQL FIX: Ensure 'labels' table matches the Master Label schema
-- Run this in Supabase SQL Editor

-- 1. Remove the old dependency on label_sets if it exists
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='labels' AND column_name='label_set_id'
    ) THEN
        ALTER TABLE public.labels DROP COLUMN label_set_id CASCADE;
    END IF;
END $$;

-- 2. Ensure manager_id exists
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='labels' AND column_name='manager_id'
    ) THEN
        ALTER TABLE public.labels ADD COLUMN manager_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 3. Ensure other columns are correct
ALTER TABLE public.labels ALTER COLUMN name SET NOT NULL;
ALTER TABLE public.labels ALTER COLUMN color SET DEFAULT '#3b82f6';

-- 4. Ensure name is UNIQUE
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'labels_name_key'
    ) THEN
        ALTER TABLE public.labels ADD CONSTRAINT labels_name_key UNIQUE (name);
    END IF;
END $$;

-- 5. Fix RLS (Allow all authenticated users to read, managers/admins to write)
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "labels_select" ON public.labels;
CREATE POLICY "labels_select" ON public.labels
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "labels_insert" ON public.labels;
CREATE POLICY "labels_insert" ON public.labels
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'))
    );

DROP POLICY IF EXISTS "labels_update" ON public.labels;
CREATE POLICY "labels_update" ON public.labels
    FOR UPDATE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'))
    );

DROP POLICY IF EXISTS "labels_delete" ON public.labels;
CREATE POLICY "labels_delete" ON public.labels
    FOR DELETE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'))
    );
