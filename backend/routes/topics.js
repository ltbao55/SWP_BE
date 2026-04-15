/**
 * Topic Routes — /api/topics
 * Taxonomy layer: Topic → Subtopic → Dataset/LabelSet
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/topics/taxonomy ─────────────────────────────────
// Trả về Topic + nested Subtopics + counts (subtopic_count / asset_count / label_set_count)
// cho UI "Topic Management" (sidebar số liệu) và dropdown Create Dataset.
router.get('/taxonomy', auth, async (req, res) => {
  try {
    const { data: topics, error } = await supabaseAdmin
      .from('topics')
      .select(`
        id, name, description, color, is_active,
        subtopics(id, name, description, is_active)
      `)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;

    const [{ data: topicStats }, { data: subStats }] = await Promise.all([
      supabaseAdmin.from('topic_taxonomy_stats').select('*'),
      supabaseAdmin.from('subtopic_stats').select('*'),
    ]);

    const topicMap = Object.fromEntries((topicStats || []).map((r) => [r.topic_id, r]));
    const subMap   = Object.fromEntries((subStats || []).map((r) => [r.subtopic_id, r]));

    const taxonomy = (topics || []).map((t) => ({
      ...t,
      subtopic_count:  topicMap[t.id]?.subtopic_count  ?? 0,
      asset_count:     topicMap[t.id]?.asset_count     ?? 0,
      label_set_count: topicMap[t.id]?.label_set_count ?? 0,
      subtopics: (t.subtopics || [])
        .filter((s) => s.is_active)
        .map((s) => ({
          ...s,
          asset_count:     subMap[s.id]?.asset_count     ?? 0,
          label_set_count: subMap[s.id]?.label_set_count ?? 0,
        })),
    }));

    res.json(taxonomy);
  } catch (err) {
    console.error('[GET /topics/taxonomy]', err);
    res.status(500).json({ message: 'Failed to load taxonomy.', error: err.message });
  }
});

// ── GET /api/topics ──────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('topics')
      .select('id, name, description, color, is_active, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch topics.', error: err.message });
  }
});

// ── GET /api/topics/:id ─────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('topics')
      .select('*, subtopics(id, name, description, is_active)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ message: 'Topic not found.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch topic.', error: err.message });
  }
});

// ── POST /api/topics ────────────────────────────────────────
router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, description = '', color = '#3b82f6' } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Topic name is required.' });

    const { data, error } = await supabaseAdmin
      .from('topics')
      .insert({ name: name.trim(), description, color, manager_id: req.user.id })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ message: 'Topic name already exists.' });
    res.status(500).json({ message: 'Failed to create topic.', error: err.message });
  }
});

// ── PUT /api/topics/:id ─────────────────────────────────────
router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const allowed = ['name', 'description', 'color', 'is_active'];
    const updates = {};
    allowed.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

    const { data, error } = await supabaseAdmin
      .from('topics').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update topic.', error: err.message });
  }
});

// ── DELETE /api/topics/:id ──────────────────────────────────
// Soft delete: set is_active = false. Cascade tự xoá subtopics/dataset_subtopics nếu hard-delete.
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('topics').update({ is_active: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Topic archived.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to archive topic.', error: err.message });
  }
});

module.exports = router;
