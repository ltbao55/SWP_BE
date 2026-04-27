/**
 * Project Routes — /api/projects
 * Manages the full project lifecycle for the Data Labeling system.
 */

const express    = require('express');
const { supabaseAdmin, supabaseWithToken }          = require('../config/supabase');
const { auth, authorize }        = require('../middleware/auth');
const { logActivity }            = require('../utils/activityLogger');
const { projectValidators, handleValidationErrors } = require('../utils/validators');

const router = express.Router();

const PROJECT_SELECT = `
  id, name, description, guidelines, status, deadline,
  export_format, review_policy, total_tasks, reviewed_tasks,
  project_review, metadata, dataset_id, created_at, updated_at,
  manager:profiles!manager_id(id, username, full_name),
  dataset:datasets!dataset_id(id, name),
  members:project_members(role, user:profiles!user_id(id, username, full_name)),
  project_labels(label:labels(id, name, color, description))
`;

const shapeProject = (project) => {
  if (!project) return project;
  const labels = (project.project_labels || []).map((pl) => pl.label).filter(Boolean);
  const annotator_ids = (project.members || [])
    .filter(m => m.role === 'annotator')
    .map(m => m.user?.id)
    .filter(Boolean);
  const reviewer = (project.members || []).find(m => m.role === 'reviewer');
  return {
    ...project,
    labels,
    annotator_ids,
    reviewer_id: reviewer?.user?.id || null,
  };
};

async function autoDistributeTasks({ project, dataset_id, annotators, reviewer_id, token }) {
  // 1) all data_items in the dataset
  const { data: items } = await supabaseAdmin
    .from('data_items').select('id').eq('dataset_id', dataset_id);
  if (!items || items.length === 0) return { created: 0 };

  // 2) round-robin assign annotators
  const taskRows = items.map((it, i) => ({
    project_id:   project.id,
    dataset_id,
    data_item_id: it.id,
    annotator_id: annotators[i % annotators.length],
    reviewer_id:  reviewer_id || null,
    status:       'assigned',
  }));

  const { data: insertedTasks, error: tErr } = await supabaseWithToken(token)
    .from('tasks').insert(taskRows).select('id');
  if (tErr) throw tErr;

  // 3) update project counters + status
  await supabaseAdmin.from('projects')
    .update({ total_tasks: insertedTasks.length, status: 'active' })
    .eq('id', project.id);

  return { created: insertedTasks.length };
}

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
      const { data: memberProjects } = await supabaseAdmin
        .from('project_members')
        .select('project_id')
        .eq('user_id', req.user.id);
      const projectIds = [...new Set((memberProjects || []).map((t) => t.project_id))];
      if (projectIds.length === 0) return res.json({ data: [], total: 0, page: 1, limit });
      query = query.in('id', projectIds);
    }

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data: (data || []).map(shapeProject), total: count, page: Number(page), limit: Number(limit) });
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
 *     summary: Get project details (includes labels and task stats)
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
 *         description: Project with project_labels and stats
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
      .select(PROJECT_SELECT)
      .eq('id', req.params.id)
      .single();

    if (error || !project) return res.status(404).json({ message: 'Project not found.' });

    const { data: stats } = await supabaseAdmin
      .from('project_task_stats')
      .select('*')
      .eq('project_id', req.params.id)
      .maybeSingle();

    res.json(shapeProject({ ...project, stats: stats || null }));
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
 *               dataset_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: Dataset to auto-distribute tasks from (optional)
 *               annotator_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: User IDs with role=annotator to assign to this project
 *               reviewer_id:
 *                 type: string
 *                 format: uuid
 *                 description: Specific reviewer for the project tasks
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
        dataset_id    = null,
        label_ids     = [],
        annotator_ids = [],
        reviewer_id   = null,
        reviewer_ids  = [],
      } = req.body;

      // Backward compatibility: if reviewer_ids provided but reviewer_id is not, take first
      const finalReviewerId = reviewer_id || (reviewer_ids && reviewer_ids.length > 0 ? reviewer_ids[0] : null);

      const annotators = [...new Set(annotator_ids)];
      const labels     = [...new Set(label_ids)];

      // ── STEP 1: insert project ──
      const { data: project, error } = await supabaseAdmin
        .from('projects')
        .insert({
          name, description, guidelines,
          manager_id:    req.user.id,
          dataset_id,
          deadline:      deadline || null,
          export_format, review_policy, metadata,
          status:        'draft',
        })
        .select('id, name')
        .single();
      if (error) throw error;

      // ── STEP 2: insert project_members ──
      const memberRows = [
        ...annotators.map((uid) => ({ project_id: project.id, user_id: uid, role: 'annotator' })),
        ...(finalReviewerId ? [{ project_id: project.id, user_id: finalReviewerId, role: 'reviewer' }] : []),
      ];
      if (memberRows.length > 0) {
        const { error: memErr } = await supabaseAdmin.from('project_members').insert(memberRows);
        if (memErr) {
          await supabaseAdmin.from('projects').delete().eq('id', project.id);
          throw memErr;
        }
      }

      // ── STEP 2.5: insert project_labels ──
      if (labels.length > 0) {
        const labelRows = labels.map(uid => ({ project_id: project.id, label_id: uid }));
        const { error: lbErr } = await supabaseAdmin.from('project_labels').insert(labelRows);
        if (lbErr) {
          await supabaseAdmin.from('projects').delete().eq('id', project.id);
          throw lbErr;
        }
      }

      // ── RE-SELECT Full project to ensure relations exist ──
      const { data: fullProject } = await supabaseAdmin
        .from('projects')
        .select(PROJECT_SELECT)
        .eq('id', project.id)
        .single();

      // ── STEP 3: auto-distribute tasks if dataset_id + annotators provided ──
      let taskStats = { created: 0 };
      if (dataset_id && annotators.length > 0) {
        taskStats = await autoDistributeTasks({
          project: fullProject,
          dataset_id,
          annotators,
          reviewer_id: finalReviewerId,
          token: req.token,
        });
      }

      await logActivity({
        userId: req.user.id, action: 'project_create',
        resourceType: 'project', resourceId: project.id,
        description: `Project "${name}" created${taskStats.created ? ` (${taskStats.created} tasks auto-generated)` : ''}`,
        metadata: { name, dataset_id, tasks: taskStats.created }, req,
      });

      res.status(201).json(shapeProject({ ...fullProject, tasks_created: taskStats.created }));
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

      const allowedFields = ['name','description','guidelines','deadline','export_format','review_policy','status','metadata','dataset_id'];
      const updates = {};
      allowedFields.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

      // Handle label_ids update if provided
      if (Array.isArray(req.body.label_ids)) {
        const labels = [...new Set(req.body.label_ids)];
        // Delete old labels
        await supabaseAdmin.from('project_labels').delete().eq('project_id', req.params.id);
        // Insert new labels
        if (labels.length > 0) {
          const labelRows = labels.map(uid => ({ project_id: req.params.id, label_id: uid }));
          const { error: lbErr } = await supabaseAdmin.from('project_labels').insert(labelRows);
          if (lbErr) throw lbErr;
        }
      }

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

      res.json(shapeProject(project));
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
      .from('project_task_stats').select('*').eq('project_id', req.params.id).maybeSingle();
    if (error) throw error;
    res.json(stats || {
      project_id: req.params.id,
      total_tasks: 0,
      approved_tasks: 0,
      rejected_tasks: 0,
      pending_tasks: 0,
      approval_rate: 0
    });
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
      .from('project_task_stats').select('*').eq('project_id', req.params.id).maybeSingle();

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

    const { data: projectList, error } = await supabaseAdmin
      .from('projects')
      .update({ status: 'completed', project_review: projectReview, reviewed_tasks: parseInt(stats?.total_tasks || 0, 10) })
      .eq('id', req.params.id)
      .select('id, name, status');

    if (error) throw error;
    const project = projectList?.[0] || { id: req.params.id, name: 'Project' };

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
      .from('project_task_stats').select('*').eq('project_id', req.params.id).maybeSingle();

    const projectReview = {
      status: 'rejected', reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString(),
      comment: comment.trim(),
      approval_rate: parseFloat(stats?.approval_rate || 0),
    };

    const { data: projectList, error } = await supabaseAdmin
      .from('projects')
      .update({ status: 'waiting_rework', project_review: projectReview })
      .eq('id', req.params.id)
      .select('id, name, status');

    if (error) throw error;
    const project = projectList?.[0] || { id: req.params.id, name: 'Project' };

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
