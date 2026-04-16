-- ============================================================
-- MIGRATION: Asset Gallery for Subtopics
-- Run AFTER schema.sql + migration_taxonomy.sql
-- Safe to re-run (uses IF NOT EXISTS / DROP IF EXISTS)
-- ============================================================

-- ── STEP 1: Thêm subtopic_id vào data_items ───────────────────
ALTER TABLE public.data_items
  ADD COLUMN IF NOT EXISTS subtopic_id UUID
    REFERENCES public.subtopics(id) ON DELETE SET NULL;

-- ── STEP 2: Cho phép dataset_id nullable ─────────────────────
-- (ảnh upload vào subtopic gallery chưa cần gắn dataset)
ALTER TABLE public.data_items
  ALTER COLUMN dataset_id DROP NOT NULL;

-- ── STEP 3: Index để tăng tốc truy vấn theo subtopic ─────────
CREATE INDEX IF NOT EXISTS idx_data_items_subtopic
  ON public.data_items(subtopic_id);

-- ── STEP 4: Thêm các trường hỗ trợ AI (tương lai) ────────────
ALTER TABLE public.data_items
  ADD COLUMN IF NOT EXISTS ai_status TEXT DEFAULT 'pending'
    CHECK (ai_status IN ('pending','processing','done','failed','skipped')),
  ADD COLUMN IF NOT EXISTS ai_suggestion   JSONB    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_processed_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_confidence   FLOAT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS image_width     INT      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS image_height    INT      DEFAULT NULL;

-- ── STEP 5: Storage bucket — set PUBLIC để ảnh hiển thị được ──
-- Chạy lệnh này trong Supabase SQL Editor:
/*
UPDATE storage.buckets
  SET public = true
  WHERE id = 'datasets';
*/

-- ── STEP 6: Storage RLS policies ─────────────────────────────
-- Xóa policies cũ nếu có, tạo lại cho rõ ràng
-- (Chạy trong Supabase SQL Editor → Storage section)
/*
DROP POLICY IF EXISTS "storage_upload"  ON storage.objects;
DROP POLICY IF EXISTS "storage_read"    ON storage.objects;
DROP POLICY IF EXISTS "storage_delete"  ON storage.objects;

-- Upload: chỉ manager/admin
CREATE POLICY "storage_upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'datasets'
    AND public.get_my_role() IN ('admin', 'manager')
  );

-- Read: mọi user đã login (ảnh subtopic gallery)
CREATE POLICY "storage_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'datasets'
    AND auth.role() = 'authenticated'
  );

-- Delete: chỉ manager/admin
CREATE POLICY "storage_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'datasets'
    AND public.get_my_role() IN ('admin', 'manager')
  );
*/
