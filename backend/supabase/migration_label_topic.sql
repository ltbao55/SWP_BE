-- ============================================================
-- MIGRATION: Add topic_id to labels table
-- Reuses existing public.topics table (from migration_taxonomy.sql).
-- Each label can optionally belong to one topic (global grouping).
-- Safe to re-run (IF NOT EXISTS).
-- Run AFTER schema.sql AND migration_taxonomy.sql.
-- ============================================================

-- 1. Add topic_id FK column to labels
ALTER TABLE public.labels
  ADD COLUMN IF NOT EXISTS topic_id UUID
  REFERENCES public.topics(id) ON DELETE SET NULL;

-- 2. Index for fast lookup by topic
CREATE INDEX IF NOT EXISTS idx_labels_topic ON public.labels(topic_id);

-- Done. Use PUT /api/labels/:id/topic to assign a label to a topic.
-- Use GET /api/labels?grouped=true for grouped response.
-- Use GET /api/topics to list all topics with their labels.
