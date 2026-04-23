/**
 * Master Label Routes — /api/labels
 * Managers can create globally reusable labels.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');

const router = express.Router();

// GET /api/labels - List master labels
router.get('/', auth, authorize('manager', 'admin', 'reviewer'), async (req, res) => {
  try {
    const { data: labels, error } = await supabaseAdmin
      .from('labels')
      .select('id, name, color, description, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(labels || []);
  } catch (err) {
    console.error('[GET /labels]', err);
    res.status(500).json({ message: 'Failed to fetch labels.', error: err.message });
  }
});

// POST /api/labels - Create master label
router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, color, description } = req.body;
    console.log('[POST /labels] Attempting to create label:', { name, color, description, userId: req.user.id });

    if (!name) return res.status(400).json({ message: 'Label name is required.' });

    const { data, error } = await supabaseAdmin
      .from('labels')
      .insert({ name, color, description, manager_id: req.user.id })
      .select('id, name, color, description, created_at')
      .single();

    if (error) {
      console.error('[POST /labels] Supabase error:', error);
      if (error.code === '23505') { // unique constraint
        return res.status(400).json({ message: `Label with name '${name}' already exists.` });
      }
      return res.status(500).json({ message: 'Database failure during label creation.', error: error.message, details: error.details });
    }

    if (!data) {
       console.warn('[POST /labels] No data returned from insert (silent failure).');
       return res.status(500).json({ message: 'Label creation failed silently (no data returned).' });
    }

    await logActivity({
      userId: req.user.id, action: 'label_create', resourceType: 'label',
      resourceId: data.id, description: `Created master label "${data.name}"`, req
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('[POST /labels] Catch error:', err);
    res.status(500).json({ message: 'Unexpected failure during label creation.', error: err.message });
  }
});

// PUT /api/labels/:id - Update master label
router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, color, description } = req.body;
    if (!name) return res.status(400).json({ message: 'Label name is required.' });

    const { data, error } = await supabaseAdmin
      .from('labels')
      .update({ name, color, description, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, name, color, description, created_at, updated_at')
      .single();

    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'label_update', resourceType: 'label',
      resourceId: data.id, description: `Updated master label "${data.name}"`, req
    });

    res.json(data);
  } catch (err) {
    console.error('[PUT /labels/:id]', err);
    res.status(500).json({ message: 'Failed to update label.', error: err.message });
  }
});

// DELETE /api/labels/:id - Delete master label
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('labels')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'label_delete', resourceType: 'label',
      resourceId: req.params.id, description: 'Deleted master label', req
    });

    res.json({ message: 'Label deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /labels/:id]', err);
    res.status(500).json({ message: 'Failed to delete label.', error: err.message });
  }
});

module.exports = router;
