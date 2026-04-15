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

// ═══════════════════════════════════════════════════════════════
// ASSET GALLERY (data_items owned by subtopic)
// ═══════════════════════════════════════════════════════════════

// GET /api/subtopics/:id/assets
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
