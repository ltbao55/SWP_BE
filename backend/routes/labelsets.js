/**
 * Label Set Routes — /api/labelsets
 * A LabelSet is now owned by a Subtopic. CRUD by id here; listing/creation
 * scoped to a subtopic lives under /api/subtopics/:id/labelsets.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

const SELECT = `
  id, name, description, allow_multiple, required, subtopic_id, created_at, updated_at,
  subtopic:subtopics!subtopic_id(id, name, topic_id),
  labels(id, name, color, description, shortcut, sort_order)
`;

// GET /api/labelsets?subtopic_id=...
router.get('/', auth, async (req, res) => {
  try {
    let query = supabaseAdmin.from('label_sets').select(SELECT).order('created_at', { ascending: false });
    if (req.query.subtopic_id) query = query.eq('subtopic_id', req.query.subtopic_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to list label sets.', error: err.message });
  }
});

// GET /api/labelsets/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('label_sets').select(SELECT).eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'Label set not found.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch label set.', error: err.message });
  }
});

// PUT /api/labelsets/:id  (name/description/flags only; labels via /labels routes)
router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const allowed = ['name', 'description', 'allow_multiple', 'required'];
    const updates = {};
    allowed.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

    const { data, error } = await supabaseAdmin
      .from('label_sets').update(updates).eq('id', req.params.id).select(SELECT).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update label set.', error: err.message });
  }
});

// DELETE /api/labelsets/:id
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('label_sets').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Label set deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete label set.', error: err.message });
  }
});

module.exports = router;
