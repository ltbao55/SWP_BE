/**
 * Topic Routes — /api/topics
 * Taxonomy layer: Topic → Subtopic → Dataset/LabelSet
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/topics/taxonomy ─────────────────────────────────
/**
 * @swagger
 * /api/topics/taxonomy:
 *   get:
 *     summary: Get full taxonomy tree (topics + nested subtopics with counts)
 *     description: Used by Topic Management UI sidebar and Create Dataset dropdown
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of active topics with nested subtopics and stats
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:              { type: string, format: uuid }
 *                   name:            { type: string }
 *                   description:     { type: string }
 *                   color:           { type: string }
 *                   is_active:       { type: boolean }
 *                   subtopic_count:  { type: integer }
 *                   asset_count:     { type: integer }
 *                   label_set_count: { type: integer }
 *                   subtopics:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:              { type: string, format: uuid }
 *                         name:            { type: string }
 *                         description:     { type: string }
 *                         asset_count:     { type: integer }
 *                         label_set_count: { type: integer }
 */
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
/**
 * @swagger
 * /api/topics:
 *   get:
 *     summary: List all active topics
 *     tags: [Topics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of topics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:          { type: string, format: uuid }
 *                   name:        { type: string }
 *                   description: { type: string }
 *                   color:       { type: string }
 *                   is_active:   { type: boolean }
 *                   created_at:  { type: string, format: date-time }
 */
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
/**
 * @swagger
 * /api/topics/{id}:
 *   get:
 *     summary: Get topic details with its subtopics
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
 *         description: Topic with subtopics array
 *       404:
 *         description: Topic not found
 */
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
 *               name:        { type: string, example: "Động vật" }
 *               description: { type: string }
 *               color:       { type: string, example: "#3b82f6" }
 *     responses:
 *       201:
 *         description: Topic created
 *       400:
 *         description: Name required or already exists
 */
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
 *               description: { type: string }
 *               color:       { type: string }
 *               is_active:   { type: boolean }
 *     responses:
 *       200:
 *         description: Updated topic
 */
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
/**
 * @swagger
 * /api/topics/{id}:
 *   delete:
 *     summary: Archive a topic — soft delete (manager / admin)
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
 *         description: Topic archived (is_active set to false)
 */
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
