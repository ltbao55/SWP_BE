const express = require('express');
const router = express.Router();
const Subtopic = require('../models/Subtopic');
const LabelSet = require('../models/LabelSet');
const { auth, authorize } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const mime = require('mime-types');
const Dataset = require('../models/Dataset');
const Project = require('../models/Project');
const Task = require('../models/Task');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/subtopics', req.params.id || 'temp');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

const hasLockedAssignmentForSubtopics = async (subtopicIds = []) => {
  if (!Array.isArray(subtopicIds) || subtopicIds.length === 0) return false;

  const datasetIds = await Dataset.find({
    $or: [
      { subtopicId: { $in: subtopicIds } },
      { subtopicIds: { $in: subtopicIds } },
    ],
  }).distinct('_id');

  if (datasetIds.length === 0) return false;

  const assignedTasks = await Task.find({
    datasetId: { $in: datasetIds },
    annotatorId: { $ne: null },
    $or: [
      { reviewerId: { $ne: null } },
      { 'reviewers.0': { $exists: true } },
    ],
  }).select('projectId').lean();

  const projectIds = [...new Set(assignedTasks.map(t => t.projectId?.toString()).filter(Boolean))];
  if (projectIds.length === 0) return false;

  const lockedProject = await Project.findOne({ _id: { $in: projectIds }, status: { $ne: 'completed' } }).select('_id').lean();
  return Boolean(lockedProject);
};

// Infer file kind
const inferFileKind = (mimeType, originalName = '') => {
  const name = (originalName || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('text/')) return 'text';
  if (mt === 'application/json' || name.endsWith('.json')) return 'text';
  if (mt === 'application/xml' || name.endsWith('.xml')) return 'text';
  if (mt === 'text/csv' || name.endsWith('.csv')) return 'text';
  if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.ogg')) return 'audio';
  if (name.endsWith('.mp4') || name.endsWith('.m4v') || mt === 'video/mp4') return 'audio';
  return 'other';
};

// Check if file is archive
const isArchiveUpload = (file) => {
  if (!file) return false;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mt = (file.mimetype || '').toLowerCase();
  return (
    ext === '.zip' ||
    mt === 'application/zip' ||
    mt === 'application/x-zip-compressed'
  );
};

// Extract ZIP and collect image files
const extractZipAndCollectFiles = async ({ zipPath, destRoot, subtopicId, maxFiles = 2000 }) => {
  if (!fs.existsSync(destRoot)) fs.mkdirSync(destRoot, { recursive: true });

  const directory = await unzipper.Open.file(zipPath);
  const extracted = [];

  const candidates = directory.files.filter(f => f.type === 'File');
  if (candidates.length > maxFiles) {
    throw new Error(`ZIP chua qua nhieu file (${candidates.length}). Gioi han la ${maxFiles}.`);
  }

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    const entryPath = (entry.path || '').toString();
    if (!entryPath || entryPath.includes('__MACOSX') || entryPath.split('/').some(p => p.startsWith('.'))) {
      const s = await entry.stream();
      s.autodrain();
      continue;
    }

    const baseName = path.basename(entryPath);
    const guessedMime = mime.lookup(baseName) || 'application/octet-stream';
    const kind = inferFileKind(guessedMime, baseName);

    // Skip non-image files
    if (kind !== 'image') {
      const s = await entry.stream();
      s.autodrain();
      continue;
    }

    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(baseName);
    const safeOutName = `${uniqueSuffix}${ext}`;
    const outPath = path.join(destRoot, safeOutName);

    await new Promise(async (resolve, reject) => {
      try {
        const readStream = await entry.stream();
        const writeStream = fs.createWriteStream(outPath);
        readStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        readStream.on('error', reject);
      } catch (e) {
        reject(e);
      }
    });

    extracted.push({
      filename: safeOutName,
      originalName: baseName,
      path: '/uploads/subtopics/' + subtopicId + '/' + safeOutName,
      mimeType: guessedMime,
      size: fs.statSync(outPath).size,
      type: 'image',
      uploadedBy: null,
      uploadedAt: new Date()
    });
  }

  return extracted;
};

router.get('/', auth, async (req, res) => {
  try {
    const filter = { status: 'active' };
    if (req.query.topicId) filter.topicId = req.query.topicId;
    if (req.user.role !== 'admin') filter.managerId = req.user._id;
    const subtoptics = await Subtopic.find(filter).sort({ order: 1 }).populate('topicId', 'name color');
    res.json(subtoptics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const subtopic = await Subtopic.findById(req.params.id).populate('topicId', 'name color');
    if (!subtopic) return res.status(404).json({ error: 'Subtopic not found' });
    const labelSets = await LabelSet.find({ subtopicId: subtopic._id });
    res.json({ subtopic, labelSets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    if (req.user.role === 'manager' && req.body?.topicId) {
      const siblingIds = await Subtopic.find({ topicId: req.body.topicId }).distinct('_id');
      const locked = await hasLockedAssignmentForSubtopics(siblingIds.map(String));
      if (locked) {
        return res.status(400).json({
          error: 'Topic nay dang duoc phan cong trong project dang hoat dong. Khong the them subtopic moi.',
        });
      }
    }

    const subtopic = new Subtopic({ ...req.body, managerId: req.user._id });
    await subtopic.save();
    res.status(201).json(subtopic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const existing = await Subtopic.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Subtopic not found' });

    if (req.user.role === 'manager') {
      const locked = await hasLockedAssignmentForSubtopics([String(existing._id)]);
      if (locked) {
        return res.status(400).json({
          error: 'Subtopic da duoc phan cong trong project dang hoat dong. Khong the sua.',
        });
      }
    }

    const subtopic = await Subtopic.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    res.json(subtopic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const existing = await Subtopic.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Subtopic not found' });

    if (req.user.role === 'manager') {
      const locked = await hasLockedAssignmentForSubtopics([String(existing._id)]);
      if (locked) {
        return res.status(400).json({
          error: 'Subtopic da duoc phan cong trong project dang hoat dong. Khong the xoa.',
        });
      }
    }

    const subtopic = await Subtopic.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
    res.json({ message: 'Subtopic archived' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== ASSET MANAGEMENT =====
// GET /api/subtopics/:id/assets - Get all assets of a subtopic
router.get('/:id/assets', auth, async (req, res) => {
  try {
    const subtopic = await Subtopic.findById(req.params.id);
    if (!subtopic) return res.status(404).json({ error: 'Subtopic not found' });
    res.json(subtopic.assets || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/subtopics/:id/assets - Upload assets to a subtopic (supports ZIP extraction)
router.post('/:id/assets', auth, upload.array('files', 100), async (req, res) => {
  try {
    const subtopic = await Subtopic.findById(req.params.id);
    if (!subtopic) return res.status(404).json({ error: 'Subtopic not found' });

    if (req.user.role === 'manager') {
      const locked = await hasLockedAssignmentForSubtopics([String(subtopic._id)]);
      if (locked) {
        return res.status(400).json({
          error: 'Subtopic da duoc phan cong trong project dang hoat dong. Khong the upload asset.',
        });
      }
    }

    const allNewAssets = [];

    for (const file of (req.files || [])) {
      if (isArchiveUpload(file)) {
        // Extract ZIP - only extract image files
        const extractDir = path.join(__dirname, '../uploads/subtopics', subtopic._id.toString());
        try {
          const extracted = await extractZipAndCollectFiles({
            zipPath: file.path,
            destRoot: extractDir,
            subtopicId: subtopic._id.toString(),
          });
          allNewAssets.push(...extracted);
        } finally {
          // Clean up ZIP file after extraction
          if (file.path && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch (e) {}
          }
        }
      } else {
        // Regular file upload
        const ext = path.extname(file.originalname).toLowerCase();
        let assetType = 'other';
        if (/^\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(ext)) assetType = 'image';
        else if (/^\.(txt|csv|json|xml|log)$/i.test(ext)) assetType = 'text';
        else if (/^\.(mp4|avi|mov|wmv|flv|webm)$/i.test(ext)) assetType = 'video';
        else if (/^\.(mp3|wav|ogg|flac|aac)$/i.test(ext)) assetType = 'audio';

        allNewAssets.push({
          filename: file.filename,
          originalName: file.originalname,
          path: '/uploads/subtopics/' + subtopic._id.toString() + '/' + file.filename,
          mimeType: file.mimetype,
          size: file.size,
          type: assetType,
          uploadedBy: req.user._id,
          uploadedAt: new Date()
        });
      }
    }

    subtopic.assets.push(...allNewAssets);
    await subtopic.save();
    res.status(201).json({ message: 'Upload thanh cong', assets: allNewAssets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/subtopics/:id/assets/:assetId - Delete an asset
router.delete('/:id/assets/:assetId', auth, async (req, res) => {
  try {
    const subtopic = await Subtopic.findById(req.params.id);
    if (!subtopic) return res.status(404).json({ error: 'Subtopic not found' });

    if (req.user.role === 'manager') {
      const locked = await hasLockedAssignmentForSubtopics([String(subtopic._id)]);
      if (locked) {
        return res.status(400).json({
          error: 'Subtopic da duoc phan cong trong project dang hoat dong. Khong the xoa asset.',
        });
      }
    }

    const asset = subtopic.assets.id(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Delete physical file
    const filePath = path.join(__dirname, '..', asset.path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    asset.deleteOne();
    await subtopic.save();
    res.json({ message: 'Xoa asset thanh cong' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
