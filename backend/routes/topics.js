/**
 * Topic Routes — /api/topics
 * Global label grouping. A topic (e.g. "Animals") contains many labels.
 * Reuses the existing public.topics table (migration_taxonomy.sql).
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');

const router = express.Router();

const TOPIC_SELECT = 'id, name, color, description, is_active, sort_order, created_at, updated_at';

// ── GET /api/topics ──────────────────────────────────────────
/**
 * @swagger
 * /api/topics:
 *   get:
 *     summary: List all topics, optionally with their labels
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: with_labels
 *         schema: { type: boolean, default: false }
 *         description: If true, each topic includes its labels array
 *       - in: query
 *         name: is_active
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: List of topics
 */
router.get('/', auth, async (req, res) => {
  try {
    const { with_labels, is_active } = req.query;

    const selectStr = with_labels === 'true'
      ? `${TOPIC_SELECT}, labels(id, name, color, description, shortcut, sort_order)`
      : TOPIC_SELECT;

    let query = supabaseAdmin
      .from('topics')
      .select(selectStr)
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true });

    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error('[GET /topics]', err);
    res.status(500).json({ message: 'Failed to fetch topics.', error: err.message });
  }
});

// ── GET /api/topics/:id ──────────────────────────────────────
/**
 * @swagger
 * /api/topics/{id}:
 *   get:
 *     summary: Get a topic with its labels
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Topic with labels
 *       404:
 *         description: Topic not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('topics')
      .select(`${TOPIC_SELECT}, labels(id, name, color, description, shortcut, sort_order)`)
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ message: 'Topic not found.' });
    res.json(data);
  } catch (err) {
    console.error('[GET /topics/:id]', err);
    res.status(500).json({ message: 'Failed to fetch topic.', error: err.message });
  }
});

// ── POST /api/topics ─────────────────────────────────────────
/**
 * @swagger
 * /api/topics:
 *   post:
 *     summary: Create a new topic (manager / admin)
 *     tags: [Topics]
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
 *               name:        { type: string, example: Animals }
 *               color:       { type: string, example: '#10b981' }
 *               description: { type: string }
 *               sort_order:  { type: integer, default: 0 }
 *     responses:
 *       201:
 *         description: Topic created
 *       409:
 *         description: Topic name already exists
 */
router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, color = '#6366f1', description = '', sort_order = 0 } = req.body;

    if (!name?.trim()) return res.status(400).json({ message: 'Topic name is required.' });

    const { data, error } = await supabaseAdmin
      .from('topics')
      .insert({
        name:        name.trim(),
        color,
        description,
        sort_order,
        manager_id:  req.user.id,
        is_active:   true,
      })
      .select(TOPIC_SELECT)
      .single();

    if (error) {
      if (error.code === '23505')
        return res.status(409).json({ message: `Topic "${name}" already exists.` });
      throw error;
    }

    await logActivity({
      userId: req.user.id, action: 'topic_create', resourceType: 'label_set',
      resourceId: data.id, description: `Created topic "${data.name}"`, req,
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('[POST /topics]', err);
    res.status(500).json({ message: 'Failed to create topic.', error: err.message });
  }
});

// ── PUT /api/topics/:id ──────────────────────────────────────
/**
 * @swagger
 * /api/topics/{id}:
 *   put:
 *     summary: Update a topic (manager / admin)
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:        { type: string }
 *               color:       { type: string }
 *               description: { type: string }
 *               sort_order:  { type: integer }
 *               is_active:   { type: boolean }
 *     responses:
 *       200:
 *         description: Topic updated
 *       404:
 *         description: Topic not found
 */
router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, color, description, sort_order, is_active } = req.body;
    const updates = {};
    if (name        !== undefined) updates.name        = name.trim();
    if (color       !== undefined) updates.color       = color;
    if (description !== undefined) updates.description = description;
    if (sort_order  !== undefined) updates.sort_order  = sort_order;
    if (is_active   !== undefined) updates.is_active   = is_active;

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ message: 'No updatable fields provided.' });

    const { data, error } = await supabaseAdmin
      .from('topics')
      .update(updates)
      .eq('id', req.params.id)
      .select(TOPIC_SELECT)
      .single();

    if (error || !data) return res.status(404).json({ message: 'Topic not found.' });

    await logActivity({
      userId: req.user.id, action: 'topic_update', resourceType: 'label_set',
      resourceId: data.id, description: `Updated topic "${data.name}"`, req,
    });

    res.json(data);
  } catch (err) {
    console.error('[PUT /topics/:id]', err);
    res.status(500).json({ message: 'Failed to update topic.', error: err.message });
  }
});

// ── DELETE /api/topics/:id ───────────────────────────────────
/**
 * @swagger
 * /api/topics/{id}:
 *   delete:
 *     summary: Delete a topic (manager / admin). Labels in this topic become Uncategorized (topic_id = NULL).
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Topic deleted, labels unlinked
 *       404:
 *         description: Topic not found
 */
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    // Fetch before delete (for log)
    const { data: topic } = await supabaseAdmin
      .from('topics').select('id, name').eq('id', req.params.id).single();
    if (!topic) return res.status(404).json({ message: 'Topic not found.' });

    // Count labels that will be unlinked
    const { count: labelCount } = await supabaseAdmin
      .from('labels')
      .select('id', { count: 'exact', head: true })
      .eq('topic_id', req.params.id);

    // Delete topic — FK ON DELETE SET NULL auto-nulls labels.topic_id
    const { error } = await supabaseAdmin.from('topics').delete().eq('id', req.params.id);
    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'topic_delete', resourceType: 'label_set',
      resourceId: req.params.id,
      description: `Deleted topic "${topic.name}" (${labelCount ?? 0} label(s) unlinked)`, req,
    });

    res.json({
      message:        `Topic "${topic.name}" deleted.`,
      labels_unlinked: labelCount ?? 0,
    });
  } catch (err) {
    console.error('[DELETE /topics/:id]', err);
    res.status(500).json({ message: 'Failed to delete topic.', error: err.message });
  }
});

module.exports = router;
