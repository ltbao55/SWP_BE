/**
 * Shared request validators using express-validator.
 * Import named arrays into routes as needed.
 */

const { body, param, query, validationResult } = require('express-validator');

/**
 * Middleware: halt with 400 if any validation error exists.
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation failed.',
      errors:  errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// ── Auth ─────────────────────────────────────────────────────
const registerValidators = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required.'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 chars.')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, underscores.'),
  body('full_name').trim().notEmpty().withMessage('Full name is required.'),
  body('role').isIn(['admin', 'manager', 'annotator', 'reviewer']).withMessage('Invalid role.'),
];

const loginValidators = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required.'),
  body('password').notEmpty().withMessage('Password is required.'),
];

// ── Project ───────────────────────────────────────────────────
const projectValidators = [
  body('name').trim().isLength({ min: 3, max: 200 }).withMessage('Project name must be 3-200 chars.'),
  body('guidelines').optional().isString(),
  body('deadline').optional().isISO8601().withMessage('Deadline must be an ISO 8601 date.')
    .custom((val) => {
      if (val && new Date(val) <= new Date()) throw new Error('Deadline must be in the future.');
      return true;
    }),
  body('review_policy.mode').optional().isIn(['full', 'sample']),
  body('review_policy.sample_rate').optional().isFloat({ min: 0.01, max: 1.0 }),
  body('review_policy.reviewers_per_item').optional().isInt({ min: 1, max: 10 }),
  body('export_format').optional().isIn(['YOLO', 'VOC', 'COCO', 'JSON', 'CSV']),
  body('dataset_id').optional({ nullable: true }).isUUID().withMessage('dataset_id must be a valid UUID.'),
  body('annotator_ids').optional().isArray().withMessage('annotator_ids must be an array.'),
  body('annotator_ids.*').optional().isUUID().withMessage('Each annotator_id must be a UUID.'),
  body('reviewer_id').optional({ nullable: true }).isUUID().withMessage('reviewer_id must be a valid UUID.'),
  body('label_ids').optional().isArray().withMessage('label_ids must be an array.'),
  body('label_ids.*').optional().isUUID().withMessage('Each label_id must be a UUID.'),
];

// ── Dataset ───────────────────────────────────────────────────
const datasetValidators = [
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Dataset name must be 2-200 chars.'),
  body('type').isIn(['image', 'text', 'audio', 'video']).withMessage('Type must be image|text|audio|video.'),
  body('project_id').optional({ nullable: true }).isUUID().withMessage('project_id must be a valid UUID.'),
];

// ── Task ──────────────────────────────────────────────────────
const taskAssignValidators = [
  body('dataset_id').isUUID().withMessage('dataset_id must be a UUID.'),
  body('annotator_id').isUUID().withMessage('annotator_id must be a UUID.'),
  body('data_item_ids').isArray({ min: 1 }).withMessage('data_item_ids must be a non-empty array.'),
  body('data_item_ids.*').isUUID().withMessage('Each data_item_id must be a UUID.'),
];

// ── Review ────────────────────────────────────────────────────
const approveValidators = [
  param('id').isUUID().withMessage('Task ID must be a UUID.'),
  body('review_comments').optional().isString().isLength({ max: 2000 }),
];

const rejectValidators = [
  param('id').isUUID().withMessage('Task ID must be a UUID.'),
  body('review_comments').trim().notEmpty().withMessage('Review comments are required when rejecting.'),
  body('error_category').optional().isIn([
    'incorrect_label', 'missing_label', 'poor_quality',
    'does_not_follow_guidelines', 'other',
  ]).withMessage('Invalid error category.'),
  body('review_notes').optional().isArray(),
];

// ── Label Set ─────────────────────────────────────────────────
const labelSetValidators = [
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Label set name must be 2-100 chars.'),
  body('labels').isArray({ min: 1 }).withMessage('At least one label is required.'),
  body('labels.*.name').trim().notEmpty().withMessage('Each label must have a name.'),
  body('labels.*.color').optional().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Color must be a hex code.'),
];

module.exports = {
  handleValidationErrors,
  registerValidators,
  loginValidators,
  projectValidators,
  datasetValidators,
  taskAssignValidators,
  approveValidators,
  rejectValidators,
  labelSetValidators,
};
