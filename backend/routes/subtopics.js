/**
 * Subtopic Routes — /api/subtopics
 * Subtopics are children of a Topic.
 */

const express = require('express');
const multer  = require('multer');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();
const BUCKET = process.env.STORAGE_BUCKET || 'datasets';

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024, files: 50 },
});

// ── GET /api/subtopics?topic_id=... ──────────────────────────
/**
 * @swagger
 * /api/subtopics:
 *   get:
 *     summary: List subtopics (optionally filtered by topic)
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: topic_id
 *         schema: { type: string, format: uuid }
 *         description: Filter subtopics by parent topic
 *     responses:
 *       200:
 *         description: Array of subtopics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:          { type: string, format: uuid }
 *                   topic_id:    { type: string, format: uuid }
 *                   name:        { type: string }
 *                   description: { type: string }
 *                   is_active:   { type: boolean }
 *                   topic:
 *                     type: object
 *                     properties:
 *                       id:   { type: string, format: uuid }
 *                       name: { type: string }
 */
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
/**
 * @swagger
 * /api/subtopics/{id}:
 *   get:
 *     summary: Get subtopic details
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Subtopic with parent topic info
 *       404:
 *         description: Subtopic not found
 */
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
/**
 * @swagger
 * /api/subtopics:
 *   post:
 *     summary: Create a subtopic under a topic (manager / admin)
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [topic_id, name]
 *             properties:
 *               topic_id:    { type: string, format: uuid }
 *               name:        { type: string, example: "Chó, Mèo" }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Subtopic created
 *       400:
 *         description: topic_id required, name required, or duplicate
 *       404:
 *         description: Topic not found
 */
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
/**
 * @swagger
 * /api/subtopics/{id}:
 *   put:
 *     summary: Update a subtopic (manager / admin)
 *     tags: [Subtopics]
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
 *               is_active:   { type: boolean }
 *               topic_id:    { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated subtopic
 */
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
/**
 * @swagger
 * /api/subtopics/{id}:
 *   delete:
 *     summary: Archive a subtopic — soft delete (manager / admin)
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Subtopic archived
 */
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

// ═══════════════════════════════════════════════════════════════
// ASSET GALLERY (data_items owned by subtopic)
// ═══════════════════════════════════════════════════════════════

// GET /api/subtopics/:id/assets
/**
 * @swagger
 * /api/subtopics/{id}/assets:
 *   get:
 *     summary: List assets (images/files) in a subtopic's Asset Gallery
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Array of data_items owned by this subtopic
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:            { type: string, format: uuid }
 *                   filename:      { type: string }
 *                   original_name: { type: string }
 *                   storage_url:   { type: string }
 *                   mime_type:     { type: string }
 *                   file_size:     { type: integer }
 *                   status:        { type: string }
 *                   created_at:    { type: string, format: date-time }
 */
router.get('/:id/assets', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('data_items')
      .select('id, filename, original_name, storage_path, storage_url, mime_type, file_size, status, created_at')
      .eq('subtopic_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to list assets.', error: err.message });
  }
});

// POST /api/subtopics/:id/assets  (multipart, field "files")
/**
 * @swagger
 * /api/subtopics/{id}/assets:
 *   post:
 *     summary: Upload assets to a subtopic's Asset Gallery (manager / admin)
 *     tags: [Subtopics]
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *                 description: Max 50 files, 500MB each
 *     responses:
 *       201:
 *         description: Files uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:  { type: string }
 *                 uploaded: { type: array, items: { type: object } }
 *                 errors:   { type: array, items: { type: object } }
 *       400:
 *         description: No files provided
 *       404:
 *         description: Subtopic not found
 */
router.post('/:id/assets', auth, authorize('manager', 'admin'), upload.array('files', 50), async (req, res) => {
  try {
    const { data: subtopic } = await supabaseAdmin
      .from('subtopics').select('id').eq('id', req.params.id).single();
    if (!subtopic) return res.status(404).json({ message: 'Subtopic not found.' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ message: 'No files uploaded.' });

    const uploaded = [];
    const errors   = [];

    for (const file of files) {
      const filename    = `${Date.now()}_${file.originalname}`;
      const storagePath = `subtopics/${subtopic.id}/${filename}`;

      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });
      if (upErr) { errors.push({ filename: file.originalname, error: upErr.message }); continue; }

      const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
      const { data: item, error: iErr } = await supabaseAdmin.from('data_items').insert({
        subtopic_id:   subtopic.id,
        filename,
        original_name: file.originalname,
        storage_path:  storagePath,
        storage_url:   urlData.publicUrl,
        mime_type:     file.mimetype,
        file_size:     file.size,
        status:        'pending',
      }).select('id, filename, storage_url, mime_type, file_size').single();

      if (iErr) errors.push({ filename: file.originalname, error: iErr.message });
      else uploaded.push(item);
    }

    res.status(201).json({ message: `Uploaded ${uploaded.length} file(s).`, uploaded, errors });
  } catch (err) {
    console.error('[POST /subtopics/:id/assets]', err);
    res.status(500).json({ message: 'Upload failed.', error: err.message });
  }
});

// DELETE /api/subtopics/:id/assets/:itemId
/**
 * @swagger
 * /api/subtopics/{id}/assets/{itemId}:
 *   delete:
 *     summary: Delete an asset from a subtopic's Asset Gallery (manager / admin)
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Subtopic ID
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Data item ID
 *     responses:
 *       200:
 *         description: Asset deleted from storage and database
 *       404:
 *         description: Asset not found or does not belong to this subtopic
 */
router.delete('/:id/assets/:itemId', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { data: item } = await supabaseAdmin
      .from('data_items').select('id, storage_path, subtopic_id').eq('id', req.params.itemId).single();
    if (!item || item.subtopic_id !== req.params.id)
      return res.status(404).json({ message: 'Asset not found.' });

    if (item.storage_path) await supabaseAdmin.storage.from(BUCKET).remove([item.storage_path]);
    await supabaseAdmin.from('data_items').delete().eq('id', item.id);
    res.json({ message: 'Asset deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete asset.', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// LABEL SETS (owned by subtopic)
// ═══════════════════════════════════════════════════════════════

// GET /api/subtopics/:id/labelsets
/**
 * @swagger
 * /api/subtopics/{id}/labelsets:
 *   get:
 *     summary: List label sets belonging to a subtopic (Label Management panel)
 *     tags: [Subtopics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Array of label sets with their labels
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:             { type: string, format: uuid }
 *                   name:           { type: string }
 *                   description:    { type: string }
 *                   allow_multiple: { type: boolean }
 *                   required:       { type: boolean }
 *                   labels:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:         { type: string, format: uuid }
 *                         name:       { type: string }
 *                         color:      { type: string }
 *                         shortcut:   { type: string }
 *                         sort_order: { type: integer }
 */
router.get('/:id/labelsets', auth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('label_sets')
      .select('id, name, description, allow_multiple, required, labels(id, name, color, shortcut, sort_order)')
      .eq('subtopic_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to list label sets.', error: err.message });
  }
});

// POST /api/subtopics/:id/labelsets
/**
 * @swagger
 * /api/subtopics/{id}/labelsets:
 *   post:
 *     summary: Create a label set for a subtopic — "Define" button (manager / admin)
 *     tags: [Subtopics]
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
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Animal Classification
 *               description:
 *                 type: string
 *               allow_multiple:
 *                 type: boolean
 *                 default: false
 *               required:
 *                 type: boolean
 *                 default: true
 *               labels:
 *                 type: array
 *                 description: Initial labels to create with the set
 *                 items:
 *                   type: object
 *                   required: [name]
 *                   properties:
 *                     name:        { type: string, example: "Chó" }
 *                     color:       { type: string, example: "#ef4444" }
 *                     description: { type: string }
 *                     shortcut:    { type: string }
 *                     sort_order:  { type: integer }
 *     responses:
 *       201:
 *         description: Label set created with labels
 *       400:
 *         description: Name required
 */
router.post('/:id/labelsets', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name, description = '', allow_multiple = false, required = true, labels = [] } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Label set name is required.' });

    const { data: labelSet, error } = await supabaseAdmin
      .from('label_sets')
      .insert({
        subtopic_id:   req.params.id,
        manager_id:    req.user.id,
        name:          name.trim(),
        description, allow_multiple, required,
      })
      .select('id, name, allow_multiple, required')
      .single();
    if (error) throw error;

    if (Array.isArray(labels) && labels.length > 0) {
      const rows = labels.map((l, i) => ({
        label_set_id: labelSet.id,
        name:         l.name,
        color:        l.color || '#3b82f6',
        description:  l.description || null,
        shortcut:     l.shortcut || null,
        sort_order:   l.sort_order ?? i,
      }));
      const { error: lErr } = await supabaseAdmin.from('labels').insert(rows);
      if (lErr) {
        await supabaseAdmin.from('label_sets').delete().eq('id', labelSet.id); // rollback
        throw lErr;
      }
    }

    const { data: full } = await supabaseAdmin
      .from('label_sets')
      .select('id, name, description, allow_multiple, required, labels(id, name, color, shortcut, sort_order)')
      .eq('id', labelSet.id).single();
    res.status(201).json(full);
  } catch (err) {
    console.error('[POST /subtopics/:id/labelsets]', err);
    res.status(500).json({ message: 'Failed to create label set.', error: err.message });
  }
});

module.exports = router;
