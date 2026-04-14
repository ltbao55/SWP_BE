const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const mime = require('mime-types');
const Dataset = require('../models/Dataset');
const Project = require('../models/Project');
const Task = require('../models/Task');
const { auth, authorize } = require('../middleware/auth');
const { createActivityLog } = require('./activityLogs');

const router = express.Router();

const inferFileKind = (mimeType, originalName = '') => {
  const name = (originalName || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('text/')) return 'text';
  if (mt === 'application/json' || name.endsWith('.json')) return 'text';
  if (mt === 'application/xml' || name.endsWith('.xml')) return 'text';
  if (mt === 'text/csv' || name.endsWith('.csv')) return 'text';
  // common audio extensions when mimeType is unreliable
  if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.ogg')) return 'audio';
  // MP4 files can contain audio (video/mp4 mimeType but may be audio-only)
  if (name.endsWith('.mp4') || name.endsWith('.m4v') || mt === 'video/mp4') return 'audio';
  return 'other';
};

const validateFilesForDatasetType = (datasetType, files) => {
  const errors = [];
  for (const f of files) {
    const kind = inferFileKind(f.mimeType, f.originalName);
    if (datasetType === 'image' && kind !== 'image') {
      errors.push({ file: f.originalName || f.filename, reason: `Expected image, got ${f.mimeType || 'unknown'}` });
    }
    if (datasetType === 'audio' && kind !== 'audio') {
      errors.push({ file: f.originalName || f.filename, reason: `Expected audio, got ${f.mimeType || 'unknown'}` });
    }
    if (datasetType === 'text' && kind !== 'text') {
      errors.push({ file: f.originalName || f.filename, reason: `Expected text, got ${f.mimeType || 'unknown'}` });
    }
  }
  return errors;
};

const isArchiveUpload = (file) => {
  if (!file) return false;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mt = (file.mimetype || '').toLowerCase();
  return (
    ext === '.zip' ||
    ext === '.rar' ||
    mt === 'application/zip' ||
    mt === 'application/x-zip-compressed' ||
    mt === 'application/vnd.rar' ||
    mt === 'application/x-rar-compressed'
  );
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const summarizeAnnotationResult = (labels) => {
  if (!labels || typeof labels !== 'object') return 'Chưa có kết quả gán nhãn';

  if (Array.isArray(labels.objects)) {
    if (labels.objects.length === 0) return 'Image: 0 object';
    const byLabel = labels.objects.reduce((acc, obj) => {
      const key = obj?.label || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const parts = Object.entries(byLabel).map(([k, v]) => `${k}: ${v}`);
    return `Image objects (${labels.objects.length}): ${parts.join(', ')}`;
  }

  if (Array.isArray(labels.spans)) {
    if (labels.spans.length === 0) return 'Text: 0 span';
    const byLabel = labels.spans.reduce((acc, span) => {
      const key = span?.label || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const parts = Object.entries(byLabel).map(([k, v]) => `${k}: ${v}`);
    return `Text spans (${labels.spans.length}): ${parts.join(', ')}`;
  }

  if (typeof labels.label === 'string' && labels.label.trim()) {
    return `Classification: ${labels.label}`;
  }

  const keys = Object.keys(labels);
  if (keys.length === 0) return 'Chưa có kết quả gán nhãn';
  return `Annotation keys: ${keys.join(', ')}`;
};

// Helper function to normalize path to relative path from backend root
const normalizePath = (filePath) => {
  if (!filePath) return '';
  // Convert backslashes to forward slashes
  let normalized = filePath.replace(/\\/g, '/');
  
  // Extract relative path from 'uploads' onwards
  const uploadsIndex = normalized.indexOf('uploads/');
  if (uploadsIndex !== -1) {
    return normalized.substring(uploadsIndex);
  }
  
  // If already relative and starts with 'uploads/', return as is
  if (normalized.startsWith('uploads/')) {
    return normalized;
  }
  
  // Fallback: if path contains 'uploads' anywhere, try to extract
  const lastUploadsIndex = normalized.lastIndexOf('uploads/');
  if (lastUploadsIndex !== -1) {
    return normalized.substring(lastUploadsIndex);
  }
  
  // If no 'uploads' found, assume it's already relative or return empty
  return normalized;
};

const extractZipAndCollectFiles = async ({ zipPath, destRoot, datasetType, maxFiles = 2000 }) => {
  ensureDir(destRoot);

  const directory = await unzipper.Open.file(zipPath);
  const extracted = [];

  // Basic protection against zip bombs (count-based)
  const candidates = directory.files.filter(f => f.type === 'File');
  if (candidates.length > maxFiles) {
    throw new Error(`ZIP contains too many files (${candidates.length}). Max allowed is ${maxFiles}.`);
  }

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;

    // Skip macOS metadata + hidden files
    const entryPath = (entry.path || '').toString();
    if (!entryPath || entryPath.includes('__MACOSX') || entryPath.split('/').some(p => p.startsWith('.'))) {
      // drain stream
      const s = await entry.stream();
      s.autodrain();
      continue;
    }

    const baseName = path.basename(entryPath);
    const guessedMime = mime.lookup(baseName) || 'application/octet-stream';
    const kind = inferFileKind(guessedMime, baseName);
    if (datasetType === 'image' && kind !== 'image') {
      const s = await entry.stream();
      s.autodrain();
      continue;
    }
    if (datasetType === 'text' && kind !== 'text') {
      const s = await entry.stream();
      s.autodrain();
      continue;
    }
    if (datasetType === 'audio' && kind !== 'audio') {
      const s = await entry.stream();
      s.autodrain();
      continue;
    }

    // Write extracted file
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

    const stat = fs.statSync(outPath);
    extracted.push({
      filename: safeOutName,
      originalName: baseName,
      path: normalizePath(outPath),
      mimeType: guessedMime,
      size: stat.size,
    });
  }

  return extracted;
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/datasets';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB (audio can be larger)
});

// Get all datasets for current manager OR all datasets for admin
router.get('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    let datasets;
    // Admin sees all datasets, manager sees only their own
    if (req.user.role === 'admin') {
      datasets = await Dataset.find()
        .populate({
          path: 'projectId',
          select: 'name labelSet',
          options: { lean: true }
        })
        .populate('managerId', 'username fullName')
        .sort({ createdAt: -1 })
        .lean();
    } else {
      datasets = await Dataset.find({ managerId: req.user._id })
        .populate({
          path: 'projectId',
          select: 'name labelSet',
          options: { lean: true }
        })
        .sort({ createdAt: -1 })
        .lean();
    }

    // Convert to plain objects and handle null projectId
    const datasetsWithProject = datasets.map(ds => ({
      ...ds,
      projectId: ds.projectId || null,
      managerName: ds.managerId?.fullName || ds.managerId?.username || 'Unknown'
    }));

    res.json(datasetsWithProject);
  } catch (error) {
    console.error('Error fetching datasets:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all datasets for a project
router.get('/project/:projectId', auth, async (req, res) => {
  try {
    const datasets = await Dataset.find({ projectId: req.params.projectId })
      .sort({ createdAt: -1 });
    res.json(datasets);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get dataset by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const dataset = await Dataset.findById(req.params.id)
      .populate('projectId', 'name managerId');
    
    if (!dataset) {
      return res.status(404).json({ message: 'Dataset not found' });
    }

    res.json(dataset);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create dataset - supports both file upload AND subtopic pool reference
router.post('/', auth, authorize('manager', 'admin'), upload.array('files', 100), async (req, res) => {
  try {
    const { projectId, subtopicId, name, description, type, imageCount } = req.body;
    const datasetType = (type || 'image').toString().toLowerCase();

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Dataset name is required' });
    }

    if (!['image', 'text', 'audio'].includes(datasetType)) {
      return res.status(400).json({ message: 'Invalid dataset type. Must be one of: image, text, audio' });
    }

    let managerId = req.user._id;
    if (req.user.role === 'admin' && projectId) {
      const project = await Project.findById(projectId);
      if (project) managerId = project.managerId;
    }

    let files = [];
    let totalItems = 0;
    let ic = 0;
    let labelsets = [];

    // MODE 1: Subtopic pool reference
    if (subtopicId && (!req.files || req.files.length === 0)) {
      const Subtopic = require('../models/Subtopic');
      const LabelSet = require('../models/LabelSet');

      const subtopic = await Subtopic.findById(subtopicId);
      if (!subtopic) return res.status(404).json({ message: 'Subtopic not found' });

      const assetLimit = parseInt(imageCount) || 100;
      const allAssets = subtopic.assets || [];
      const imageAssets = allAssets.filter(a => a.type === 'image').slice(0, assetLimit);

      const subtopicLabelsets = await LabelSet.find({ subtopicId: subtopicId }).lean();
      labelsets = subtopicLabelsets.map(ls => ls._id);

      files = imageAssets.map(a => ({
        filename: a.filename || (a.path || '').split('/').pop(),
        originalName: a.originalName || a.filename || 'Unknown',
        path: a.path,
        mimeType: a.mimeType || a.type,
        size: a.size || 0,
        uploadedAt: a.uploadedAt || new Date()
      }));
      totalItems = files.length;
      ic = files.length;
    }
    // MODE 2: File upload
    else if (req.files && req.files.length > 0) {
      if (req.files.length === 1 && isArchiveUpload(req.files[0])) {
        const archiveFile = req.files[0];
        const archiveExt = path.extname(archiveFile.originalname || '').toLowerCase();

        if (archiveExt === '.rar') {
          if (archiveFile.path && fs.existsSync(archiveFile.path)) { try { fs.unlinkSync(archiveFile.path); } catch (e) {} }
          return res.status(400).json({ message: 'RAR files are not supported. Please use ZIP.' });
        }

        const extractDir = path.join('uploads/datasets', `extracted-${Date.now()}-${Math.round(Math.random() * 1e6)}`);
        try {
          files = await extractZipAndCollectFiles({ zipPath: archiveFile.path, destRoot: extractDir, datasetType });
        } finally {
          if (archiveFile.path && fs.existsSync(archiveFile.path)) { try { fs.unlinkSync(archiveFile.path); } catch (e) {} }
        }

        if (!files || files.length === 0) {
          return res.status(400).json({ message: `Archive does not contain valid files for type "${datasetType}".` });
        }
      } else {
        files = req.files.map(file => ({
          filename: file.filename,
          originalName: file.originalname,
          path: normalizePath(file.path),
          mimeType: file.mimetype,
          size: file.size
        }));
      }

      const fileErrors = validateFilesForDatasetType(datasetType, files);
      if (fileErrors.length > 0) {
        files.forEach(f => { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        return res.status(400).json({ message: `Uploaded files do not match dataset type "${datasetType}"`, errors: fileErrors });
      }
      totalItems = files.length;
      ic = files.length;
    } else {
      return res.status(400).json({ message: 'Either upload files OR select a subtopic pool. Both cannot be empty.' });
    }

    const dataset = new Dataset({
      type: datasetType,
      projectId: projectId || null,
      subtopicId: subtopicId || null,
      managerId: managerId,
      name: name.trim(),
      description: description?.trim() || '',
      files,
      totalItems,
      imageCount: ic,
      labelsets,
      status: 'draft'
    });

    await dataset.save();

    await createActivityLog(
      req.user._id,
      'dataset_create',
      'dataset',
      dataset._id,
      `Created dataset: ${dataset.name} with ${totalItems} items from ${subtopicId ? 'subtopic pool' : 'upload'}`,
      { datasetName: dataset.name, totalItems, subtopicId, source: subtopicId ? 'subtopic_pool' : 'upload' },
      req
    );

    res.status(201).json(dataset);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

