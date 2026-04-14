/**
 * Project Routes — /api/projects
 * Manages the full project lifecycle for the Data Labeling system.
 */

const express    = require('express');
const { supabaseAdmin }          = require('../config/supabase');
const { auth, authorize }        = require('../middleware/auth');
const { logActivity }            = require('../utils/activityLogger');
const { projectValidators, handleValidationErrors } = require('../utils/validators');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────
const PROJECT_SELECT = `
  id, name, description, guidelines, status, deadline,
  export_format, review_policy, total_tasks, reviewed_tasks,
  project_review, metadata, created_at, updated_at,
  manager:profiles!manager_id(id, username, full_name)
`;

// ── GET /api/projects ────────────────────────────────────────
/**
 * @swagger
 * /api/projects:
 *   get:
 *     summary: List projects (filtered by role)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [draft, active, in_review, waiting_rework, finalizing, completed, archived]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated list of projects
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Pagination'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Project' }
 */
router.get('/', auth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabaseAdmin
      .from('projects')
      .select(PROJECT_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (req.user.role === 'manager') {
      query = query.eq('manager_id', req.user.id);
    } else if (req.user.role === 'annotator') {
      const { data: taskProjects } = await supabaseAdmin
        .from('tasks')
        .select('project_id')
        .eq('annotator_id', req.user.id);
      const projectIds = [...new Set((taskProjects || []).map((t) => t.project_id))];
      if (projectIds.length === 0) return res.json({ data: [], total: 0, page: 1, limit });
      query = query.in('id', projectIds);
    }

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /projects]', err);
    res.status(500).json({ message: 'Failed to fetch projects.', error: err.message });
  }
});

// ── GET /api/projects/:id ────────────────────────────────────
/**
 * @swagger
 * /api/projects/{id}:
 *   get:
 *     summary: Get project details (includes label sets and task stats)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Project with label_sets and stats
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Project' }
 *       404:
 *         description: Project not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select(`
        ${PROJECT_SELECT},
        label_sets(id, name, description, allow_multiple, required,
          labels(id, name, color, description, shortcut, sort_order)
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !project) return res.status(404).json({ message: 'Project not found.' });

    const { data: stats } = await supabaseAdmin
      .from('project_task_stats')
      .select('*')
      .eq('project_id', req.params.id)
      .maybeSingle();

    res.json({ ...project, stats: stats || null });
  } catch (err) {
    console.error('[GET /projects/:id]', err);
    res.status(500).json({ message: 'Failed to fetch project.', error: err.message });
  }
});

// ── POST /api/projects ───────────────────────────────────────
/**
 * @swagger
 * /api/projects:
 *   post:
 *     summary: Create a new project (manager / admin)
 *     tags: [Projects]
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
 *               name:          { type: string, example: "Vehicle Detection Q1" }
 *               description:   { type: string }
 *               guidelines:    { type: string }
 *               deadline:      { type: string, format: date-time }
 *               export_format:
 *                 type: string
 *                 enum: [JSON, CSV, COCO, YOLO, VOC]
 *                 default: JSON
 *               review_policy:
 *                 type: object
 *                 example: { mode: "full", sample_rate: 1, reviewers_per_item: 1 }
 *     responses:
 *       201:
 *         description: Project created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Project' }
 */
router.post(
  '/',
  auth, authorize('manager', 'admin'),
  projectValidators, handleValidationErrors,
  async (req, res) => {
    try {
      const {
        name, description = '', guidelines = '',
        deadline, export_format = 'JSON',
        review_policy = { mode: 'full', sample_rate: 1, reviewers_per_item: 1 },
        metadata = {},
      } = req.body;

      const { data: project, error } = await supabaseAdmin
        .from('projects')
        .insert({
          name, description, guidelines,
          manager_id:    req.user.id,
          deadline:      deadline || null,
          export_format, review_policy, metadata,
          status:        'draft',
        })
        .select(PROJECT_SELECT)
        .single();

      if (error) throw error;

      await logActivity({
        userId: req.user.id, action: 'project_create',
        resourceType: 'project', resourceId: project.id,
        description: `Project "${name}" created`, metadata: { name }, req,
      });

      res.status(201).json(project);
    } catch (err) {
      console.error('[POST /projects]', err);
      res.status(500).json({ message: 'Failed to create project.', error: err.message });
    }
  }
);

// ── PUT /api/projects/:id ────────────────────────────────────
/**
 * @swagger
 * /api/projects/{id}:
 *   put:
 *     summary: Update project (manager / admin)
 *     tags: [Projects]
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
 *               name:          { type: string }
 *               description:   { type: string }
 *               guidelines:    { type: string }
 *               deadline:      { type: string, format: date-time }
 *               export_format: { type: string, enum: [JSON, CSV, COCO, YOLO, VOC] }
 *               status:
 *                 type: string
 *                 enum: [draft, active, in_review, waiting_rework, finalizing, completed, archived]
 *               review_policy: { type: object }
 *     responses:
 *       200:
 *         description: Updated project
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Project' }
 *       403:
 *         description: Not your project
 *       404:
 *         description: Project not found
 */
router.put(
  '/:id',
  auth, authorize('manager', 'admin'),
  projectValidators, handleValidationErrors,
  async (req, res) => {
    try {
      if (req.user.role === 'manager') {
        const { data: existing } = await supabaseAdmin
          .from('projects').select('manager_id').eq('id', req.params.id).single();
        if (!existing) return res.status(404).json({ message: 'Project not found.' });
        if (existing.manager_id !== req.user.id)
          return res.status(403).json({ message: 'You can only edit your own projects.' });
      }

      const allowedFields = ['name','description','guidelines','deadline','export_format','review_policy','status','metadata'];
      const updates = {};
      allowedFields.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

      const { data: project, error } = await supabaseAdmin
        .from('projects')
        .update(updates)
        .eq('id', req.params.id)
        .select(PROJECT_SELECT)
        .single();

      if (error) throw error;

      await logActivity({
        userId: req.user.id, action: 'project_update',
        resourceType: 'project', resourceId: project.id,
        description: `Project "${project.name}" updated`,
        metadata: { fields: Object.keys(updates) }, req,
      });

      res.json(project);
    } catch (err) {
      console.error('[PUT /projects/:id]', err);
      res.status(500).json({ message: 'Failed to update project.', error: err.message });
    }
  }
);

// ── DELETE /api/projects/:id ─────────────────────────────────
/**
 * @swagger
 * /api/projects/{id}:
 *   delete:
 *     summary: Delete project (manager / admin)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Project deleted
 *       403:
 *         description: Not your project
 *       404:
 *         description: Project not found
 */
router.delete('/:id', auth, authorize('admin', 'manager'), async (req, res) => {
  try {
    const { data: project } = await supabaseAdmin
      .from('projects').select('id, name, manager_id').eq('id', req.params.id).single();
    if (!project) return res.status(404).json({ message: 'Project not found.' });

    if (req.user.role === 'manager' && project.manager_id !== req.user.id)
      return res.status(403).json({ message: 'You can only delete your own projects.' });

    const { error } = await supabaseAdmin.from('projects').delete().eq('id', req.params.id);
    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'project_delete',
      resourceType: 'project', resourceId: req.params.id,
      description: `Project "${project.name}" deleted`, req,
    });

    res.json({ message: 'Project deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /projects/:id]', err);
    res.status(500).json({ message: 'Failed to delete project.', error: err.message });
  }
});

// ── GET /api/projects/:id/quality ───────────────────────────
/**
 * @swagger
 * /api/projects/{id}/quality:
 *   get:
 *     summary: Get project quality / task stats
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Quality metrics (total_tasks, approved_tasks, approval_rate, etc.)
 */
router.get('/:id/quality', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { data: stats, error } = await supabaseAdmin
      .from('project_task_stats').select('*').eq('project_id', req.params.id).single();
    if (error) throw error;
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch quality stats.', error: err.message });
  }
});

// ── POST /api/projects/:id/approve ──────────────────────────
/**
 * @swagger
 * /api/projects/{id}/approve:
 *   post:
 *     summary: Approve a project (reviewer / admin) — requires ≥70% approval rate
 *     tags: [Projects]
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
 *               comment: { type: string }
 *     responses:
 *       200:
 *         description: Project approved
 *       400:
 *         description: Approval rate below 70%
 */
router.post('/:id/approve', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { comment = '' } = req.body;

    const { data: stats } = await supabaseAdmin
      .from('project_task_stats').select('*').eq('project_id', req.params.id).single();

    const approvalRate = parseFloat(stats?.approval_rate || 0);

    if (approvalRate < 70) {
      return res.status(400).json({
        message: `Approval rate is ${approvalRate}% — below the 70% threshold.`,
        approval_rate: approvalRate,
      });
    }

    const projectReview = {
      status: 'approved', reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString(), comment,
      approval_rate: approvalRate,
      approved_tasks: stats.approved_tasks,
      rejected_tasks: stats.rejected_tasks,
      total_tasks:    stats.total_tasks,
    };

    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .update({ status: 'completed', project_review: projectReview, reviewed_tasks: stats.total_tasks })
      .eq('id', req.params.id)
      .select('id, name, status')
      .single();

    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'project_approve',
      resourceType: 'project', resourceId: req.params.id,
      description: `Project "${project.name}" approved (${approvalRate}%)`, req,
    });

    res.json({ message: 'Project approved.', project, approval_rate: approvalRate });
  } catch (err) {
    console.error('[POST /projects/:id/approve]', err);
    res.status(500).json({ message: 'Failed to approve project.', error: err.message });
  }
});

// ── POST /api/projects/:id/reject ───────────────────────────
/**
 * @swagger
 * /api/projects/{id}/reject:
 *   post:
 *     summary: Reject a project and return it for rework (reviewer / admin)
 *     tags: [Projects]
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
 *             required: [comment]
 *             properties:
 *               comment: { type: string, example: "Too many annotation errors in dataset B." }
 *     responses:
 *       200:
 *         description: Project rejected and set to waiting_rework
 *       400:
 *         description: Comment required
 */
router.post('/:id/reject', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment?.trim()) return res.status(400).json({ message: 'Rejection comment is required.' });

    const { data: stats } = await supabaseAdmin
      .from('project_task_stats').select('*').eq('project_id', req.params.id).single();

    const projectReview = {
      status: 'rejected', reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString(),
      comment: comment.trim(),
      approval_rate: parseFloat(stats?.approval_rate || 0),
    };

    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .update({ status: 'waiting_rework', project_review: projectReview })
      .eq('id', req.params.id)
      .select('id, name, status')
      .single();

    if (error) throw error;

    await logActivity({
      userId: req.user.id, action: 'project_reject',
      resourceType: 'project', resourceId: req.params.id,
      description: `Project "${project.name}" rejected`, req,
    });

    res.json({ message: 'Project rejected and returned for rework.', project });
  } catch (err) {
    console.error('[POST /projects/:id/reject]', err);
    res.status(500).json({ message: 'Failed to reject project.', error: err.message });
  }
});

// ── GET /api/projects/:id/export ────────────────────────────
/**
 * @swagger
 * /api/projects/{id}/export:
 *   get:
 *     summary: Export approved annotations (manager / admin)
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [JSON, CSV, COCO]
 *           default: JSON
 *     responses:
 *       200:
 *         description: Exported file (JSON / CSV / COCO)
 */
router.get('/:id/export', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const format = (req.query.format || 'JSON').toUpperCase();

    const { data: tasks, error } = await supabaseAdmin
      .from('tasks')
      .select(`
        id, status, annotation_data, submitted_at, reviewed_at,
        data_item:data_items(id, filename, original_name, storage_url, mime_type),
        annotator:profiles!annotator_id(id, username, full_name)
      `)
      .eq('project_id', req.params.id)
      .eq('status', 'approved');

    if (error) throw error;

    if (format === 'CSV') {
      const rows = ['filename,annotator,status,submitted_at,reviewed_at'];
      tasks.forEach((t) => {
        rows.push([
          t.data_item?.filename || '', t.annotator?.username || '',
          t.status, t.submitted_at || '', t.reviewed_at || '',
        ].join(','));
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="export.csv"');
      return res.send(rows.join('\n'));
    }

    if (format === 'COCO') {
      const coco = { info: { date_created: new Date().toISOString() }, images: [], annotations: [], categories: [] };
      const catMap = {};
      let annId = 1;
      tasks.forEach((task, i) => {
        coco.images.push({ id: i + 1, file_name: task.data_item?.filename || `item_${i+1}`, url: task.data_item?.storage_url || '' });
        (task.annotation_data?.bboxes || []).forEach((b) => {
          if (!catMap[b.label]) { catMap[b.label] = Object.keys(catMap).length + 1; coco.categories.push({ id: catMap[b.label], name: b.label }); }
          coco.annotations.push({ id: annId++, image_id: i+1, category_id: catMap[b.label], bbox: [b.x, b.y, b.width, b.height], area: b.width * b.height, iscrowd: 0 });
        });
      });
      res.setHeader('Content-Disposition', 'attachment; filename="export_coco.json"');
      return res.json(coco);
    }

    // Default: JSON
    res.setHeader('Content-Disposition', 'attachment; filename="export.json"');
    res.json({ project_id: req.params.id, format: 'JSON', exported_at: new Date().toISOString(), tasks });
  } catch (err) {
    console.error('[GET /projects/:id/export]', err);
    res.status(500).json({ message: 'Export failed.', error: err.message });
  }
});

module.exports = router;
