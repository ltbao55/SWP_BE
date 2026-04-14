/**
 * Task Routes — /api/tasks
 * Core workflow engine: assigned → in_progress → submitted → approved/rejected → resubmitted
 */
const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { assertTransition, getSubmitStatus } = require('../utils/workflow');
const { taskAssignValidators, handleValidationErrors } = require('../utils/validators');

const router = express.Router();

const TASK_SELECT = `
  id, status, annotation_data, review_comments, error_category,
  review_notes, review_issues, submitted_at, reviewed_at, created_at, updated_at,
  project:projects!project_id(id, name, guidelines, deadline, review_policy),
  dataset:datasets!dataset_id(id, name),
  data_item:data_items!data_item_id(id, filename, original_name, storage_path, storage_url, mime_type),
  annotator:profiles!annotator_id(id, username, full_name),
  reviewer:profiles!reviewer_id(id, username, full_name),
  label_set:label_sets!label_set_id(id, name, labels(*))
`;

// GET /api/tasks/my-tasks
/**
 * @swagger
 * /api/tasks/my-tasks:
 *   get:
 *     summary: Get tasks assigned to the current user (annotator or reviewer)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [assigned, in_progress, submitted, resubmitted, approved, rejected, expired]
 *       - in: query
 *         name: project_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated task list
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Pagination'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Task' }
 */
router.get('/my-tasks', auth, async (req, res) => {
  try {
    const { status, project_id, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let query = supabaseAdmin
      .from('tasks')
      .select(TASK_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (req.user.role === 'annotator') query = query.eq('annotator_id', req.user.id);
    else if (req.user.role === 'reviewer') query = query.eq('reviewer_id', req.user.id);
    if (status)     query = query.eq('status', status);
    if (project_id) query = query.eq('project_id', project_id);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /tasks/my-tasks]', err);
    res.status(500).json({ message: 'Failed to fetch tasks.', error: err.message });
  }
});

// GET /api/tasks/project/:projectId — must come BEFORE /:id
/**
 * @swagger
 * /api/tasks/project/{projectId}:
 *   get:
 *     summary: List all tasks for a project (manager / admin / reviewer)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [assigned, in_progress, submitted, resubmitted, approved, rejected, expired]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated task list for the project
 */
router.get('/project/:projectId', auth, authorize('manager', 'admin', 'reviewer'), async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let query = supabaseAdmin
      .from('tasks')
      .select(TASK_SELECT, { count: 'exact' })
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: true })
      .range(offset, offset + Number(limit) - 1);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /tasks/project/:projectId]', err);
    res.status(500).json({ message: 'Failed to fetch project tasks.', error: err.message });
  }
});

// GET /api/tasks/:id
/**
 * @swagger
 * /api/tasks/{id}:
 *   get:
 *     summary: Get task details
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Task details with reviewer votes
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Task' }
 *       404:
 *         description: Task not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: task, error } = await supabaseAdmin
      .from('tasks')
      .select(TASK_SELECT + `, task_reviewers(id, reviewer_id, status, comment, reviewed_at, reviewer:profiles!reviewer_id(id, username, full_name))`)
      .eq('id', req.params.id)
      .single();
    if (error || !task) return res.status(404).json({ message: 'Task not found.' });
    if (req.user.role === 'annotator' && task.annotator?.id !== req.user.id)
      return res.status(403).json({ message: 'Access denied.' });
    res.json(task);
  } catch (err) {
    console.error('[GET /tasks/:id]', err);
    res.status(500).json({ message: 'Failed to fetch task.', error: err.message });
  }
});

// POST /api/tasks/assign — Manager assigns data items to annotator
/**
 * @swagger
 * /api/tasks/assign:
 *   post:
 *     summary: Batch assign data items to an annotator (manager / admin)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, dataset_id, annotator_id, data_item_ids]
 *             properties:
 *               project_id:
 *                 type: string
 *                 format: uuid
 *               dataset_id:
 *                 type: string
 *                 format: uuid
 *               annotator_id:
 *                 type: string
 *                 format: uuid
 *               data_item_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               reviewer_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Optional list of reviewers for multi-reviewer consensus
 *               label_set_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Tasks created and assigned
 *       400:
 *         description: Invalid annotator
 *       404:
 *         description: Project not found
 */
router.post('/assign', auth, authorize('manager', 'admin'), taskAssignValidators, handleValidationErrors, async (req, res) => {
  try {
    const { project_id, dataset_id, annotator_id, data_item_ids, reviewer_ids = [], label_set_id = null } = req.body;

    const { data: project } = await supabaseAdmin.from('projects').select('id, manager_id').eq('id', project_id).single();
    if (!project) return res.status(404).json({ message: 'Project not found.' });
    if (req.user.role === 'manager' && project.manager_id !== req.user.id)
      return res.status(403).json({ message: 'You can only assign tasks in your own projects.' });

    const { data: annotator } = await supabaseAdmin.from('profiles').select('id, role, is_active').eq('id', annotator_id).single();
    if (!annotator || annotator.role !== 'annotator' || !annotator.is_active)
      return res.status(400).json({ message: 'Invalid or inactive annotator.' });

    const taskInserts = data_item_ids.map((itemId) => ({
      project_id, dataset_id, data_item_id: itemId, annotator_id,
      label_set_id: label_set_id || null, status: 'assigned',
    }));

    const { data: tasks, error: taskError } = await supabaseAdmin.from('tasks').insert(taskInserts).select('id, data_item_id, status');
    if (taskError) throw taskError;

    if (reviewer_ids.length > 0) {
      const reviewerInserts = [];
      tasks.forEach((task) => reviewer_ids.forEach((rId) => reviewerInserts.push({ task_id: task.id, reviewer_id: rId, status: 'pending' })));
      await supabaseAdmin.from('task_reviewers').insert(reviewerInserts);
      await supabaseAdmin.from('tasks').update({ reviewer_id: reviewer_ids[0] }).in('id', tasks.map((t) => t.id));
    }

    await supabaseAdmin.from('data_items').update({ status: 'assigned' }).in('id', data_item_ids);
    const { count: taskCount } = await supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', project_id);
    await supabaseAdmin.from('projects').update({ total_tasks: taskCount, status: 'active' }).eq('id', project_id);

    await logActivity({ userId: req.user.id, action: 'task_assign', resourceType: 'task',
      description: `${tasks.length} task(s) assigned to annotator`, metadata: { project_id, annotator_id, count: tasks.length }, req });

    res.status(201).json({ message: `${tasks.length} task(s) assigned successfully.`, tasks });
  } catch (err) {
    console.error('[POST /tasks/assign]', err);
    res.status(500).json({ message: 'Failed to assign tasks.', error: err.message });
  }
});

// PUT /api/tasks/:id/start
/**
 * @swagger
 * /api/tasks/{id}/start:
 *   put:
 *     summary: Start a task — transition assigned → in_progress (annotator)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Task status updated to in_progress
 *       400:
 *         description: Invalid status transition
 *       403:
 *         description: Task not assigned to you
 */
router.put('/:id/start', auth, authorize('annotator'), async (req, res) => {
  try {
    const { data: task } = await supabaseAdmin.from('tasks').select('id, status, annotator_id').eq('id', req.params.id).single();
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    if (task.annotator_id !== req.user.id) return res.status(403).json({ message: 'This task is not assigned to you.' });
    assertTransition(task.status, 'in_progress');
    const { data: updated, error } = await supabaseAdmin.from('tasks').update({ status: 'in_progress' }).eq('id', req.params.id).select('id, status').single();
    if (error) throw error;
    res.json(updated);
  } catch (err) {
    if (err.message.startsWith('Invalid status transition')) return res.status(400).json({ message: err.message });
    console.error('[PUT /tasks/:id/start]', err);
    res.status(500).json({ message: 'Failed to start task.', error: err.message });
  }
});

// PUT /api/tasks/:id/save — Draft save, no status change
/**
 * @swagger
 * /api/tasks/{id}/save:
 *   put:
 *     summary: Save annotation progress (draft, no status change) (annotator)
 *     tags: [Tasks]
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
 *             required: [annotation_data]
 *             properties:
 *               annotation_data:
 *                 type: object
 *                 example: { labels: ["car", "truck"], bboxes: [] }
 *     responses:
 *       200:
 *         description: Progress saved
 *       400:
 *         description: Task status does not allow saving
 */
router.put('/:id/save', auth, authorize('annotator'), async (req, res) => {
  try {
    const { annotation_data } = req.body;
    const { data: task } = await supabaseAdmin.from('tasks').select('id, status, annotator_id').eq('id', req.params.id).single();
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    if (task.annotator_id !== req.user.id) return res.status(403).json({ message: 'This task is not assigned to you.' });
    if (!['in_progress', 'assigned', 'rejected'].includes(task.status))
      return res.status(400).json({ message: `Cannot save a task with status "${task.status}".` });

    const { data: updated, error } = await supabaseAdmin.from('tasks')
      .update({ annotation_data, status: task.status === 'assigned' ? 'in_progress' : task.status })
      .eq('id', req.params.id).select('id, status, annotation_data').single();
    if (error) throw error;
    res.json(updated);
  } catch (err) {
    console.error('[PUT /tasks/:id/save]', err);
    res.status(500).json({ message: 'Failed to save progress.', error: err.message });
  }
});

// POST /api/tasks/:id/submit
/**
 * @swagger
 * /api/tasks/{id}/submit:
 *   post:
 *     summary: Submit task for review — in_progress → submitted (or rejected → resubmitted) (annotator)
 *     tags: [Tasks]
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
 *               annotation_data:
 *                 type: object
 *                 description: Optional final annotation (overrides saved draft)
 *     responses:
 *       200:
 *         description: Task submitted for review
 *       400:
 *         description: No annotation data or invalid transition
 */
router.post('/:id/submit', auth, authorize('annotator'), async (req, res) => {
  try {
    const { annotation_data } = req.body;
    const { data: task } = await supabaseAdmin.from('tasks').select('id, status, annotator_id, annotation_data').eq('id', req.params.id).single();
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    if (task.annotator_id !== req.user.id) return res.status(403).json({ message: 'This task is not assigned to you.' });

    const nextStatus = getSubmitStatus(task.status);
    assertTransition(task.status, nextStatus);

    const finalAnnotation = annotation_data ?? task.annotation_data;
    if (!finalAnnotation || Object.keys(finalAnnotation).length === 0)
      return res.status(400).json({ message: 'Cannot submit a task without annotation data.' });

    const { data: updated, error } = await supabaseAdmin.from('tasks')
      .update({ annotation_data: finalAnnotation, status: nextStatus, submitted_at: new Date().toISOString() })
      .eq('id', req.params.id).select('id, status, submitted_at').single();
    if (error) throw error;

    await logActivity({ userId: req.user.id, action: 'task_submit', resourceType: 'task', resourceId: req.params.id,
      description: `Task submitted (${task.status} → ${nextStatus})`, req });

    res.json({ message: 'Task submitted for review.', task: updated });
  } catch (err) {
    if (err.message.startsWith('Invalid status transition')) return res.status(400).json({ message: err.message });
    console.error('[POST /tasks/:id/submit]', err);
    res.status(500).json({ message: 'Failed to submit task.', error: err.message });
  }
});

module.exports = router;
