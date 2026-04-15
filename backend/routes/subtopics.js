/**
 * Subtopic Routes — /api/subtopics
 * Subtopics are children of a Topic.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/subtopics?topic_id=... ──────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('subtopics')
      .select('id, topic_id, name, description, is_active, topic:topics(id, name)')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (req.query.topic_id) query = query.eq('topic_id', req.query.topic_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch subtopics.', error: err.message });
  }
});

// ── GET /api/subtopics/:id ──────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('subtopics')
      .select('*, topic:topics(id, name, color)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ message: 'Subtopic not found.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch subtopic.', error: err.message });
  }
});

// ── POST /api/subtopics ─────────────────────────────────────
router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { topic_id, name, description = '' } = req.body;
    if (!topic_id) return res.status(400).json({ message: 'topic_id is required.' });
    if (!name?.trim()) return res.status(400).json({ message: 'Subtopic name is required.' });

    const { data, error } = await supabaseAdmin
      .from('subtopics')
      .insert({ topic_id, name: name.trim(), description })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ message: 'Subtopic already exists under this topic.' });
    if (err.code === '23503') return res.status(400).json({ message: 'Topic does not exist.' });
    res.status(500).json({ message: 'Failed to create subtopic.', error: err.message });
  }
});

// ── PUT /api/subtopics/:id ──────────────────────────────────
router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const allowed = ['name', 'description', 'is_active', 'topic_id'];
    const updates = {};
    allowed.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

    const { data, error } = await supabaseAdmin
      .from('subtopics').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update subtopic.', error: err.message });
  }
});

// ── DELETE /api/subtopics/:id ───────────────────────────────
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('subtopics').update({ is_active: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Subtopic archived.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to archive subtopic.', error: err.message });
  }
});

module.exports = router;
