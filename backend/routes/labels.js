/**
 * Master Label Routes — /api/labels
 * Managers can create globally reusable labels.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');

const router = express.Router();

/**
 * @swagger
 * /api/labels:
 *   get:
 *     summary: List master labels (with optional topic grouping)
 *     tags: [Labels]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: grouped
 *         schema: { type: boolean, default: false }
 *         description: >
 *           If true, returns labels grouped by topic.
 *           Response shape: `{ groups: [{ id, name, color, labels: [...] }] }`.
 *           Groups include an "Uncategorized" entry for labels without a topic.
 *     responses:
 *       200:
 *         description: Flat label list (default) or grouped by topic (grouped=true)
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: array
 *                   items: { $ref: '#/components/schemas/Label' }
 *                 - type: object
 *                   properties:
 *                     groups:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Topic' }
 */

router.get('/', auth, authorize('manager', 'admin', 'reviewer'), async (req, res) => {
  try {
    const { grouped } = req.query;

    const { data: labels, error } = await supabaseAdmin
      .from('labels')
      .select('id, name, color, description, shortcut, sort_order, topic_id, topic:topics!topic_id(id, name, color, description), created_at')
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true });

    if (error) throw error;

    // ?grouped=true — group labels by topic for FE label picker
    if (grouped === 'true') {
      const groupMap = {};
      const uncategorized = { id: null, name: 'Uncategorized', color: '#6b7280', labels: [] };

      for (const label of labels || []) {
        if (!label.topic_id || !label.topic) {
          uncategorized.labels.push(label);
        } else {
          const key = label.topic_id;
          if (!groupMap[key]) {
            groupMap[key] = { ...label.topic, labels: [] };
          }
          groupMap[key].labels.push(label);
        }
      }

      const groups = Object.values(groupMap);
      if (uncategorized.labels.length > 0) groups.push(uncategorized);
      return res.json({ groups });
    }

    res.json(labels || []);
  } catch (err) {
    console.error('[GET /labels]', err);
    res.status(500).json({ message: 'Failed to fetch labels.', error: err.message });
  }
});

/**
 * @swagger
 * /api/labels:
 *   post:
 *     summary: Create a master label (manager / admin)
 *     tags: [Labels]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, example: Dog }
 *               color:       { type: string, example: '#f59e0b' }
 *               description: { type: string }
 *               topic_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: Optional topic to group this label into
 *     responses:
 *       201:
 *         description: Label created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Label' }
 *       400:
 *         description: Invalid input or duplicate name
 */
router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, color, description, topic_id = null } = req.body;
    console.log('[POST /labels] Attempting to create label:', { name, color, description, topic_id, userId: req.user.id });

    if (!name) return res.status(400).json({ message: 'Label name is required.' });

    // Validate topic_id if provided
    if (topic_id) {
      const { data: topic } = await supabaseAdmin.from('topics').select('id').eq('id', topic_id).single();
      if (!topic) return res.status(400).json({ message: 'Topic not found.' });
    }

    const { data, error } = await supabaseAdmin
      .from('labels')
      .insert({ name, color, description, topic_id, manager_id: req.user.id })
      .select('id, name, color, description, topic_id, topic:topics!topic_id(id, name, color), created_at')
      .single();

    if (error) {
      console.error('[POST /labels] Supabase error:', error);
      
      // Handle schema mismatch errors (e.g., column doesn't exist or constraint failed)
      if (error.code === '42703') { // undefined_column
        return res.status(500).json({ 
          message: 'Database schema mismatch: "manager_id" column is missing from "labels" table. Please run the fix_labels_schema.sql script.',
          error: error.message 
        });
      }
      if (error.code === '23502') { // not_null_violation
        return res.status(400).json({ 
          message: 'Database constraint failed: A required column (possibly label_set_id) is missing. Your database might be on an old schema.',
          error: error.message 
        });
      }
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

/**
 * @swagger
 * /api/labels/{id}:
 *   put:
 *     summary: Update a master label (manager / admin)
 *     tags: [Labels]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               color: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Label updated
 */
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

/**
 * @swagger
 * /api/labels/{id}:
 *   delete:
 *     summary: Delete a master label (manager / admin)
 *     tags: [Labels]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Label deleted
 */
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

// ── PUT /api/labels/:id/topic ───────────────────────────────
/**
 * @swagger
 * /api/labels/{id}/topic:
 *   put:
 *     summary: Assign or unassign a label to/from a topic (manager / admin)
 *     tags: [Labels]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               topic_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: Pass null to remove label from its topic (Uncategorized)
 *     responses:
 *       200:
 *         description: Label topic updated
 *       404:
 *         description: Label or topic not found
 */
router.put('/:id/topic', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { topic_id = null } = req.body;

    // Validate topic exists (skip if null — means unassign)
    if (topic_id) {
      const { data: topic } = await supabaseAdmin
        .from('topics').select('id, name').eq('id', topic_id).single();
      if (!topic) return res.status(404).json({ message: 'Topic not found.' });
    }

    const { data, error } = await supabaseAdmin
      .from('labels')
      .update({ topic_id })
      .eq('id', req.params.id)
      .select('id, name, color, topic_id, topic:topics!topic_id(id, name, color)')
      .single();

    if (error || !data) return res.status(404).json({ message: 'Label not found.' });

    await logActivity({
      userId: req.user.id, action: 'label_update', resourceType: 'label',
      resourceId: data.id,
      description: topic_id
        ? `Assigned label "${data.name}" to topic "${data.topic?.name}"`
        : `Removed label "${data.name}" from topic (Uncategorized)`,
      req,
    });

    res.json(data);
  } catch (err) {
    console.error('[PUT /labels/:id/topic]', err);
    res.status(500).json({ message: 'Failed to update label topic.', error: err.message });
  }
});

module.exports = router;
