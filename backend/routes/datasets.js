/**
 * Dataset Routes — /api/datasets
 * Handles dataset management with Supabase Storage for file uploads.
 * Files are stored in the "datasets" bucket under: {dataset_id}/{filename}
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const unzipper = require('unzipper');
const { Readable } = require('stream');

const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { datasetValidators, handleValidationErrors } = require('../utils/validators');

const router = express.Router();
const BUCKET = process.env.STORAGE_BUCKET || 'datasets';

// Multer: store files in memory for direct Supabase Storage upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024, files: 50 }, // 500MB per file, 50 files max per request
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'text/plain', 'text/csv',
      'application/zip', 'application/x-zip-compressed',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type "${file.mimetype}" is not allowed.`));
  },
});

const DATASET_SELECT = `
  id, name, description, type, status, total_items, storage_path, metadata, created_at, updated_at,
  manager:profiles!manager_id(id, username, full_name),
  project:projects!project_id(id, name)
`;

// ── GET /api/datasets ────────────────────────────────────────
/**
 * @swagger
 * /api/datasets:
 *   get:
 *     summary: List datasets (manager / admin / reviewer)
 *     tags: [Datasets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [image, text, audio, video]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated dataset list
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Pagination'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Dataset' }
 */
router.get('/', auth, authorize('manager', 'admin', 'reviewer'), async (req, res) => {
  try {
    const { project_id, type, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabaseAdmin
      .from('datasets')
      .select(DATASET_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (req.user.role === 'manager') query = query.eq('manager_id', req.user.id);
    if (project_id) query = query.eq('project_id', project_id);
    if (type)       query = query.eq('type', type);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /datasets]', err);
    res.status(500).json({ message: 'Failed to fetch datasets.', error: err.message });
  }
});

// ── GET /api/datasets/:id ────────────────────────────────────
/**
 * @swagger
 * /api/datasets/{id}:
 *   get:
 *     summary: Get dataset details with data items
 *     tags: [Datasets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Dataset with all data_items
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Dataset' }
 *       404:
 *         description: Dataset not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: dataset, error } = await supabaseAdmin
      .from('datasets')
      .select(`${DATASET_SELECT}, data_items(id, filename, original_name, storage_url, mime_type, file_size, status, created_at)`)
      .eq('id', req.params.id)
      .single();
    if (error || !dataset) return res.status(404).json({ message: 'Dataset not found.' });
    res.json(dataset);
  } catch (err) {
    console.error('[GET /datasets/:id]', err);
    res.status(500).json({ message: 'Failed to fetch dataset.', error: err.message });
  }
});

// ── POST /api/datasets ───────────────────────────────────────
/**
 * @swagger
 * /api/datasets:
 *   post:
 *     summary: Create a new dataset (manager / admin)
 *     tags: [Datasets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Traffic Cameras Batch 1
 *               description:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [image, text, audio, video]
 *               project_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Dataset created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Dataset' }
 */
router.post('/', auth, authorize('manager', 'admin'), datasetValidators, handleValidationErrors, async (req, res) => {
  try {
    const { name, description = '', type, project_id = null, metadata = {} } = req.body;

    const { data: dataset, error } = await supabaseAdmin
      .from('datasets')
      .insert({ name, description, type, project_id, manager_id: req.user.id, metadata, status: 'draft' })
      .select(DATASET_SELECT)
      .single();
    if (error) throw error;

    await logActivity({ userId: req.user.id, action: 'dataset_upload', resourceType: 'dataset',
      resourceId: dataset.id, description: `Dataset "${name}" created`, metadata: { name, type }, req });

    res.status(201).json(dataset);
  } catch (err) {
    console.error('[POST /datasets]', err);
    res.status(500).json({ message: 'Failed to create dataset.', error: err.message });
  }
});

// ── POST /api/datasets/:id/upload ───────────────────────────
/**
 * @swagger
 * /api/datasets/{id}/upload:
 *   post:
 *     summary: Upload files to a dataset (max 50 files, 500MB each; ZIP auto-extracted)
 *     tags: [Datasets]
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
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Image (jpg/png/webp/bmp/gif), audio (mp3/wav/ogg), text, CSV, or ZIP
 *     responses:
 *       201:
 *         description: Files uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:     { type: string }
 *                 uploaded:    { type: array, items: { type: object } }
 *                 errors:      { type: array, items: { type: object } }
 *                 total_items: { type: integer }
 *       400:
 *         description: No files provided
 *       403:
 *         description: Not your dataset
 *       404:
 *         description: Dataset not found
 */
router.post('/:id/upload', auth, authorize('manager', 'admin'), upload.array('files', 50), async (req, res) => {
  try {
    const { data: dataset } = await supabaseAdmin.from('datasets').select('id, name, type, manager_id').eq('id', req.params.id).single();
    if (!dataset) return res.status(404).json({ message: 'Dataset not found.' });
    if (req.user.role === 'manager' && dataset.manager_id !== req.user.id)
      return res.status(403).json({ message: 'You can only upload to your own datasets.' });

    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ message: 'No files uploaded.' });

    const uploadedItems = [];
    const errors = [];

    for (const file of files) {
      const isZip = file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';

      if (isZip) {
        // Extract ZIP and upload individual files
        try {
          const zipStream = Readable.from(file.buffer);
          const directory = await unzipper.Open.buffer(file.buffer);

          for (const entry of directory.files) {
            if (entry.type !== 'File') continue;
            const entryName = path.basename(entry.path);
            if (entryName.startsWith('.') || entryName.startsWith('__MACOSX')) continue;

            const entryBuffer = await entry.buffer();
            const storagePath = `${dataset.id}/${Date.now()}_${entryName}`;

            const { error: uploadErr } = await supabaseAdmin.storage
              .from(BUCKET)
              .upload(storagePath, entryBuffer, { upsert: true });

            if (uploadErr) { errors.push({ filename: entryName, error: uploadErr.message }); continue; }

            const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);

            const { data: item, error: itemErr } = await supabaseAdmin.from('data_items').insert({
              dataset_id:    dataset.id,
              filename:      entryName,
              original_name: entryName,
              storage_path:  storagePath,
              storage_url:   urlData.publicUrl,
              mime_type:     'image/jpeg',  // detect from extension in production
              file_size:     entryBuffer.length,
              status:        'pending',
            }).select('id, filename, storage_url').single();

            if (itemErr) errors.push({ filename: entryName, error: itemErr.message });
            else uploadedItems.push(item);
          }
        } catch (zipErr) {
          errors.push({ filename: file.originalname, error: `ZIP extraction failed: ${zipErr.message}` });
        }
      } else {
        // Direct file upload
        const filename     = `${Date.now()}_${file.originalname}`;
        const storagePath  = `${dataset.id}/${filename}`;

        const { error: uploadErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

        if (uploadErr) { errors.push({ filename: file.originalname, error: uploadErr.message }); continue; }

        const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);

        const { data: item, error: itemErr } = await supabaseAdmin.from('data_items').insert({
          dataset_id:    dataset.id,
          filename,
          original_name: file.originalname,
          storage_path:  storagePath,
          storage_url:   urlData.publicUrl,
          mime_type:     file.mimetype,
          file_size:     file.size,
          status:        'pending',
        }).select('id, filename, storage_url, mime_type').single();

        if (itemErr) errors.push({ filename: file.originalname, error: itemErr.message });
        else uploadedItems.push(item);
      }
    }

    // Update dataset total_items
    const { count: itemCount } = await supabaseAdmin
      .from('data_items').select('id', { count: 'exact', head: true }).eq('dataset_id', dataset.id);

    await supabaseAdmin.from('datasets').update({ total_items: itemCount, status: 'labeling' }).eq('id', dataset.id);

    res.status(201).json({
      message:    `Uploaded ${uploadedItems.length} file(s).`,
      uploaded:   uploadedItems,
      errors,
      total_items: itemCount,
    });
  } catch (err) {
    console.error('[POST /datasets/:id/upload]', err);
    res.status(500).json({ message: 'Upload failed.', error: err.message });
  }
});

// ── DELETE /api/datasets/:id ─────────────────────────────────
/**
 * @swagger
 * /api/datasets/{id}:
 *   delete:
 *     summary: Delete a dataset and all its files from storage (manager / admin)
 *     tags: [Datasets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Dataset deleted
 *       403:
 *         description: Not your dataset
 *       404:
 *         description: Dataset not found
 */
router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { data: dataset } = await supabaseAdmin.from('datasets').select('id, name, manager_id').eq('id', req.params.id).single();
    if (!dataset) return res.status(404).json({ message: 'Dataset not found.' });
    if (req.user.role === 'manager' && dataset.manager_id !== req.user.id)
      return res.status(403).json({ message: 'You can only delete your own datasets.' });

    // Delete all Storage objects for this dataset
    const { data: items } = await supabaseAdmin.from('data_items').select('storage_path').eq('dataset_id', dataset.id);
    if (items && items.length > 0) {
      const paths = items.map((i) => i.storage_path).filter(Boolean);
      if (paths.length > 0) await supabaseAdmin.storage.from(BUCKET).remove(paths);
    }

    const { error } = await supabaseAdmin.from('datasets').delete().eq('id', req.params.id);
    if (error) throw error;

    await logActivity({ userId: req.user.id, action: 'dataset_delete', resourceType: 'dataset',
      resourceId: req.params.id, description: `Dataset "${dataset.name}" deleted`, req });

    res.json({ message: 'Dataset deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /datasets/:id]', err);
    res.status(500).json({ message: 'Failed to delete dataset.', error: err.message });
  }
});

// ── GET /api/datasets/:id/signed-url/:itemId ─────────────────
/**
 * @swagger
 * /api/datasets/{id}/signed-url/{itemId}:
 *   get:
 *     summary: Get a 1-hour signed URL for a private file
 *     tags: [Datasets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Dataset ID
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Data item ID
 *     responses:
 *       200:
 *         description: Signed URL (expires in 3600 seconds)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 signed_url: { type: string }
 *                 expires_in: { type: integer, example: 3600 }
 *       404:
 *         description: File not found
 */
router.get('/:id/signed-url/:itemId', auth, async (req, res) => {
  try {
    const { data: item } = await supabaseAdmin
      .from('data_items').select('id, storage_path, dataset_id').eq('id', req.params.itemId).single();
    if (!item || item.dataset_id !== req.params.id) return res.status(404).json({ message: 'File not found.' });

    const { data: signed, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(item.storage_path, 3600); // 1 hour
    if (error) throw error;

    res.json({ signed_url: signed.signedUrl, expires_in: 3600 });
  } catch (err) {
    console.error('[GET /datasets/:id/signed-url/:itemId]', err);
    res.status(500).json({ message: 'Failed to create signed URL.', error: err.message });
  }
});

module.exports = router;
