/**
 * Review Routes — /api/reviews
 * Handles the approve/reject workflow with multi-reviewer majority vote support.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { approveValidators, rejectValidators, handleValidationErrors } = require('../utils/validators');

const router = express.Router();

const TASK_WITH_PROJECT = `
  id, status, annotation_data, review_comments, error_category,
  review_notes, submitted_at, created_at,
  project:projects!project_id(id, name, guidelines, deadline, project_labels(label:labels(*))),
  data_item:data_items!data_item_id(id, filename, storage_url, mime_type),
  annotator:profiles!annotator_id(id, username, full_name)
`;

// ── GET /api/reviews/pending ──────────────────────────────────
/**
 * @swagger
 * /api/reviews/pending:
 *   get:
 *     summary: Get tasks pending this reviewer's vote
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *         description: List of tasks awaiting review (deadline-filtered)
 */
router.get('/pending', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { project_id, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // 1. Fetch project policy if project_id is provided
    let sampleRate = 1.0;
    if (project_id && project_id !== 'undefined' && project_id !== 'null') {
      const { data: project, error: projErr } = await supabaseAdmin
        .from('projects')
        .select('review_policy')
        .eq('id', project_id)
        .single();
      
      if (projErr) {
        console.warn(`[GET /reviews/pending] Could not fetch project ${project_id}:`, projErr.message);
      } else if (project?.review_policy?.sample_rate) {
        sampleRate = parseFloat(project.review_policy.sample_rate);
      }
    }

    // 2. Build and execute query
    let data, count;
    // Only apply sampling if we have a valid project_id AND sampleRate < 1.0
    if (project_id && project_id !== 'undefined' && project_id !== 'null' && sampleRate < 1.0) {
      console.log(`[GET /reviews/pending] Applying stratified sampling (rate=${sampleRate}) for project ${project_id}`);
      // Use SQL function for stratified sampling (gets base task rows)
      const { data: sampledTasks, error: rpcErr } = await supabaseAdmin.rpc('get_stratified_tasks', {
        p_project_id:  project_id,
        p_sample_rate: sampleRate,
        p_limit:       Number(limit),
        p_offset:      offset
      });
      if (rpcErr) {
        console.error('[GET /reviews/pending] RPC Error:', rpcErr);
        throw rpcErr;
      }
      
      if (!sampledTasks || sampledTasks.length === 0) {
        data = [];
        count = 0;
      } else {
        const ids = sampledTasks.map(t => t.id);
        const { data: fullTasks, error: selectErr } = await supabaseAdmin
          .from('tasks')
          .select(TASK_WITH_PROJECT)
          .in('id', ids)
          .order('submitted_at', { ascending: true });
        
        if (selectErr) throw selectErr;
        data = fullTasks;
        count = data.length; // Approximate
      }
    } else {
      // Full review or no project filter
      console.log(`[GET /reviews/pending] Fetching full review queue. Project: ${project_id || 'All'}`);
      let query = supabaseAdmin
        .from('tasks')
        .select(TASK_WITH_PROJECT, { count: 'exact' })
        .in('status', ['submitted', 'resubmitted'])
        .order('submitted_at', { ascending: true })
        .range(offset, offset + Number(limit) - 1);

      if (project_id && project_id !== 'undefined' && project_id !== 'null') {
        query = query.eq('project_id', project_id);
      }
      if (req.user.role === 'reviewer') {
        query = query.or(`reviewer_id.is.null,reviewer_id.eq.${req.user.id}`);
      }

      const { data: fullData, error: fullErr, count: totalCount } = await query;
      if (fullErr) {
        console.error('[GET /reviews/pending] Query Error:', fullErr);
        throw fullErr;
      }
      data  = fullData;
      count = totalCount;
    }

    res.json({ 
      data, 
      total: count, 
      sampling: isSampleMode ? `stratified_${sampleRate*100}%` : 'full'
    });
  } catch (err) {
    console.error('[GET /reviews/pending]', err);
    res.status(500).json({ message: 'Failed to fetch pending reviews.', error: err.message });
  }
});

// ── GET /api/reviews/reviewed ─────────────────────────────────
/**
 * @swagger
 * /api/reviews/reviewed:
 *   get:
 *     summary: Get tasks already reviewed by the current reviewer
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *         description: Reviewed tasks (approved or rejected)
 */
router.get('/reviewed', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { project_id, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabaseAdmin
      .from('tasks')
      .select(TASK_WITH_PROJECT, { count: 'exact' })
      .in('status', ['approved', 'rejected'])
      .eq('reviewer_id', req.user.id)
      .order('reviewed_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (project_id) query = query.eq('project_id', project_id);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    console.error('[GET /reviews/reviewed]', err);
    res.status(500).json({ message: 'Failed to fetch reviewed tasks.', error: err.message });
  }
});

// ── GET /api/reviews/stats ────────────────────────────────────
/**
 * @swagger
 * /api/reviews/stats:
 *   get:
 *     summary: Get review statistics for the current reviewer
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Status counts and error category breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status_counts:
 *                   type: object
 *                   example: { submitted: 3, approved: 10, rejected: 2, total: 15 }
 *                 error_category_counts:
 *                   type: object
 *                   example: { wrong_label: 2, missing_annotation: 1 }
 */
router.get('/stats', auth, authorize('reviewer', 'manager', 'admin'), async (req, res) => {
  try {
    const { data: statusStats, error: sErr } = await supabaseAdmin
      .from('tasks')
      .select('status')
      .eq('reviewer_id', req.user.id);
    if (sErr) throw sErr;

    const counts = { submitted: 0, resubmitted: 0, approved: 0, rejected: 0, total: 0 };
    (statusStats || []).forEach((t) => {
      counts.total++;
      if (counts[t.status] !== undefined) counts[t.status]++;
    });

    const { data: errorStats, error: eErr } = await supabaseAdmin
      .from('tasks')
      .select('error_category')
      .eq('reviewer_id', req.user.id)
      .not('error_category', 'is', null);
    if (eErr) throw eErr;

    const errorCounts = {};
    (errorStats || []).forEach((t) => {
      errorCounts[t.error_category] = (errorCounts[t.error_category] || 0) + 1;
    });

    res.json({ status_counts: counts, error_category_counts: errorCounts });
  } catch (err) {
    console.error('[GET /reviews/stats]', err);
    res.status(500).json({ message: 'Failed to fetch review stats.', error: err.message });
  }
});

router.get('/task/:id', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { data: task, error } = await supabaseAdmin
      .from('tasks')
      .select(TASK_WITH_PROJECT)
      .eq('id', req.params.id)
      .single();
    if (error || !task) return res.status(404).json({ message: 'Task not found.' });

    res.json(task);
  } catch (err) {
    console.error('[GET /reviews/task/:id]', err);
    res.status(500).json({ message: 'Failed to fetch task.', error: err.message });
  }
});

// ── POST /api/reviews/:id/approve ────────────────────────────
/**
 * @swagger
 * /api/reviews/{id}/approve:
 *   post:
 *     summary: Approve a submitted task
 *     tags: [Reviews]
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
 *               review_comments:
 *                 type: string
 *               review_notes:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Task approved
 *       400:
 *         description: Task not in reviewable state or deadline passed
 */
router.post('/:id/approve', auth, authorize('reviewer', 'admin'), approveValidators, handleValidationErrors, async (req, res) => {
  try {
    const { review_comments = '', review_notes = [] } = req.body;
    const now = new Date().toISOString();

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('id, status, annotation_data, project:projects!project_id(deadline)')
      .eq('id', req.params.id)
      .single();
    if (taskErr || !task) return res.status(404).json({ message: 'Task not found.' });

    if (!['submitted', 'resubmitted'].includes(task.status)) {
      return res.status(400).json({
        message: `Task cannot be reviewed. Current status: "${task.status}". Only submitted/resubmitted tasks can be reviewed.`,
      });
    }

    if (!task.annotation_data || Object.keys(task.annotation_data).length === 0) {
      return res.status(400).json({ message: 'Cannot approve a task without annotation data.' });
    }

    const deadline = task.project?.deadline;
    if (deadline && new Date(deadline) < new Date()) {
      return res.status(400).json({ message: 'Task deadline has passed — cannot review.' });
    }

    const taskUpdate = {
      status:          'approved',
      review_comments: review_comments,
      review_notes:    review_notes,
      reviewed_at:     now,
      reviewer_id:     req.user.id,
    };

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('tasks').update(taskUpdate).eq('id', req.params.id).select('id, status, reviewed_at').single();
    if (updateErr) throw updateErr;

    await logActivity({ userId: req.user.id, action: 'task_approve', resourceType: 'task',
      resourceId: req.params.id, description: `Task approved by reviewer`, req });

    res.json({ message: 'Task approved.', task: updated });
  } catch (err) {
    console.error('[POST /reviews/:id/approve]', err);
    res.status(500).json({ message: 'Failed to approve task.', error: err.message });
  }
});

// ── POST /api/reviews/:id/reject ─────────────────────────────
/**
 * @swagger
 * /api/reviews/{id}/reject:
 *   post:
 *     summary: Reject a submitted task with a required comment
 *     tags: [Reviews]
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
 *             required: [review_comments]
 *             properties:
 *               review_comments:
 *                 type: string
 *                 example: "Bounding boxes are misaligned on objects 3 and 7."
 *               error_category:
 *                 type: string
 *                 example: wrong_boundary
 *               review_notes:
 *                 type: array
 *                 items: { type: string }
 *               review_issues:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       200:
 *         description: Task rejected
 *       400:
 *         description: Task not reviewable or deadline passed
 */
router.post('/:id/reject', auth, authorize('reviewer', 'admin'), rejectValidators, handleValidationErrors, async (req, res) => {
  try {
    const { review_comments, error_category = 'other', review_notes = [], review_issues = [] } = req.body;
    const now = new Date().toISOString();

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('id, status, project:projects!project_id(deadline)')
      .eq('id', req.params.id)
      .single();
    if (taskErr || !task) return res.status(404).json({ message: 'Task not found.' });

    if (!['submitted', 'resubmitted'].includes(task.status)) {
      return res.status(400).json({
        message: `Task cannot be rejected. Current status: "${task.status}".`,
      });
    }

    const deadline = task.project?.deadline;
    if (deadline && new Date(deadline) < new Date()) {
      return res.status(400).json({ message: 'Task deadline has passed — cannot review.' });
    }

    const taskUpdate = {
      status:          'rejected',
      reviewed_at:     now,
      reviewer_id:     req.user.id,
      review_comments: review_comments,
      error_category:  error_category,
      review_notes:    review_notes,
      review_issues:   review_issues,
    };

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('tasks').update(taskUpdate).eq('id', req.params.id).select('id, status, review_comments, error_category, reviewed_at').single();
    if (updateErr) throw updateErr;

    await logActivity({ userId: req.user.id, action: 'task_reject', resourceType: 'task',
      resourceId: req.params.id, description: `Task rejected by reviewer`,
      metadata: { error_category }, req });

    res.json({ message: 'Task rejected.', task: updated });
  } catch (err) {
    console.error('[POST /reviews/:id/reject]', err);
    res.status(500).json({ message: 'Failed to reject task.', error: err.message });
  }
});

// ── GET /api/reviews/projects/:projectId/stats ───────────────
/**
 * @swagger
 * /api/reviews/projects/{projectId}/stats:
 *   get:
 *     summary: Get aggregated task stats for a project
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Project-level review stats (total, approved, rejected, approval_rate)
 */
router.get('/projects/:projectId/stats', auth, authorize('reviewer', 'manager', 'admin'), async (req, res) => {
  try {
    const { data: stats, error } = await supabaseAdmin
      .from('project_task_stats').select('*').eq('project_id', req.params.projectId).maybeSingle();
    if (error) throw error;
    res.json(stats || { project_id: req.params.projectId, total_tasks: 0, approved_tasks: 0, rejected_tasks: 0, approval_rate: 0 });
  } catch (err) {
    console.error('[GET /reviews/projects/:projectId/stats]', err);
    res.status(500).json({ message: 'Failed to fetch project stats.', error: err.message });
  }
});

module.exports = router;
