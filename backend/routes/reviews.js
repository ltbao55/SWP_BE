/**
 * Review Routes — /api/reviews
 * Handles the approve/reject workflow with multi-reviewer majority vote support.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { resolveMajorityVote } = require('../utils/workflow');
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

    // Tasks where reviewer is assigned AND has not voted yet
    let taskIdsQuery = supabaseAdmin
      .from('task_reviewers')
      .select('task_id')
      .eq('reviewer_id', req.user.id)
      .eq('status', 'pending');

    const { data: pendingAssignments } = await taskIdsQuery;
    const taskIds = (pendingAssignments || []).map((r) => r.task_id);

    // Also include tasks where reviewer_id is set directly (single-reviewer mode)
    let query = supabaseAdmin
      .from('tasks')
      .select(TASK_WITH_PROJECT, { count: 'exact' })
      .in('status', ['submitted', 'resubmitted'])
      .order('submitted_at', { ascending: true })
      .range(offset, offset + Number(limit) - 1);

    if (taskIds.length > 0) {
      query = query.or(`id.in.(${taskIds.join(',')}),reviewer_id.eq.${req.user.id}`);
    } else {
      query = query.eq('reviewer_id', req.user.id);
    }

    if (project_id) query = query.eq('project_id', project_id);

    const { data, error, count } = await query;
    if (error) throw error;

    // Filter out tasks where deadline has passed (no reviews after deadline)
    const now = new Date();
    const actionable = (data || []).filter((t) => {
      const deadline = t.project?.deadline;
      return !deadline || new Date(deadline) > now;
    });

    res.json({ data: actionable, total: actionable.length, raw_count: count });
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

// ── GET /api/reviews/task/:id ─────────────────────────────────
/**
 * @swagger
 * /api/reviews/task/{id}:
 *   get:
 *     summary: Get a task for review (reviewer must be assigned)
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Task with annotation data and reviewer votes
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Task' }
 *       403:
 *         description: Not assigned to this task
 *       404:
 *         description: Task not found
 */
router.get('/task/:id', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { data: task, error } = await supabaseAdmin
      .from('tasks')
      .select(TASK_WITH_PROJECT + `, task_reviewers(id, reviewer_id, status, comment, reviewed_at, reviewer:profiles!reviewer_id(id, username, full_name))`)
      .eq('id', req.params.id)
      .single();
    if (error || !task) return res.status(404).json({ message: 'Task not found.' });

    // Verify reviewer is assigned to this task
    const isAssigned =
      task.reviewer?.id === req.user.id ||
      (task.task_reviewers || []).some((r) => r.reviewer_id === req.user.id) ||
      req.user.role === 'admin';

    if (!isAssigned) return res.status(403).json({ message: 'You are not assigned to review this task.' });
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
 *     summary: Approve a submitted task (supports multi-reviewer majority vote)
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
 *         description: Vote recorded (finalized if majority reached)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:   { type: string }
 *                 task:      { $ref: '#/components/schemas/Task' }
 *                 finalized: { type: boolean }
 *                 decision:  { type: object }
 *       400:
 *         description: Task not in reviewable state, already voted, or deadline passed
 */
router.post('/:id/approve', auth, authorize('reviewer', 'admin'), approveValidators, handleValidationErrors, async (req, res) => {
  try {
    const { review_comments = '', review_notes = [] } = req.body;
    const now = new Date().toISOString();

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('id, status, annotation_data, reviewer_id, project:projects!project_id(deadline)')
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

    // Multi-reviewer: record this reviewer's vote
    const { data: myVote } = await supabaseAdmin.from('task_reviewers')
      .select('id, status').eq('task_id', req.params.id).eq('reviewer_id', req.user.id).maybeSingle();

    if (myVote) {
      if (myVote.status !== 'pending') return res.status(400).json({ message: 'You have already voted on this task.' });
      await supabaseAdmin.from('task_reviewers')
        .update({ status: 'approved', comment: review_comments, reviewed_at: now })
        .eq('id', myVote.id);
    }

    // Resolve final status via majority vote
    const { data: allVotes } = await supabaseAdmin.from('task_reviewers')
      .select('status').eq('task_id', req.params.id);

    const decision = resolveMajorityVote(allVotes || [], task.status);

    const taskUpdate = {
      status:          decision.finalStatus,
      review_comments: decision.finalStatus === 'approved' ? review_comments : task.review_comments,
      review_notes:    decision.finalStatus === 'approved' ? review_notes : task.review_notes,
      reviewed_at:     decision.finalized ? now : task.reviewed_at,
      reviewer_id:     decision.finalized ? req.user.id : task.reviewer_id,
    };

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('tasks').update(taskUpdate).eq('id', req.params.id).select('id, status, reviewed_at').single();
    if (updateErr) throw updateErr;

    await logActivity({ userId: req.user.id, action: 'task_approve', resourceType: 'task',
      resourceId: req.params.id, description: `Task approve vote. Final: ${decision.finalStatus}`,
      metadata: { decision, finalized: decision.finalized }, req });

    res.json({
      message:   decision.finalized ? `Task ${decision.finalStatus}.` : 'Vote recorded. Awaiting other reviewers.',
      task:      updated,
      finalized: decision.finalized,
      decision:  decision.meta,
    });
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
 *     summary: Reject a submitted task with a required comment (supports majority vote)
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
 *         description: Vote recorded (finalized if majority reached)
 *       400:
 *         description: Task not reviewable, already voted, or deadline passed
 */
router.post('/:id/reject', auth, authorize('reviewer', 'admin'), rejectValidators, handleValidationErrors, async (req, res) => {
  try {
    const { review_comments, error_category = 'other', review_notes = [], review_issues = [] } = req.body;
    const now = new Date().toISOString();

    const { data: task, error: taskErr } = await supabaseAdmin
      .from('tasks')
      .select('id, status, reviewer_id, project:projects!project_id(deadline)')
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

    // Multi-reviewer: record this reviewer's vote
    const { data: myVote } = await supabaseAdmin.from('task_reviewers')
      .select('id, status').eq('task_id', req.params.id).eq('reviewer_id', req.user.id).maybeSingle();

    if (myVote) {
      if (myVote.status !== 'pending') return res.status(400).json({ message: 'You have already voted on this task.' });
      await supabaseAdmin.from('task_reviewers')
        .update({ status: 'rejected', comment: review_comments, reviewed_at: now })
        .eq('id', myVote.id);
    }

    // Resolve final status via majority vote
    const { data: allVotes } = await supabaseAdmin.from('task_reviewers')
      .select('status').eq('task_id', req.params.id);

    const decision = resolveMajorityVote(allVotes || [], task.status);

    const taskUpdate = {
      status:       decision.finalStatus,
      reviewed_at:  decision.finalized ? now : task.reviewed_at,
      reviewer_id:  decision.finalized ? req.user.id : task.reviewer_id,
    };

    if (decision.finalized && decision.finalStatus === 'rejected') {
      taskUpdate.review_comments = review_comments;
      taskUpdate.error_category  = error_category;
      taskUpdate.review_notes    = review_notes;
      taskUpdate.review_issues   = review_issues;
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('tasks').update(taskUpdate).eq('id', req.params.id).select('id, status, review_comments, error_category, reviewed_at').single();
    if (updateErr) throw updateErr;

    await logActivity({ userId: req.user.id, action: 'task_reject', resourceType: 'task',
      resourceId: req.params.id, description: `Task reject vote. Final: ${decision.finalStatus}`,
      metadata: { error_category, decision, finalized: decision.finalized }, req });

    res.json({
      message:   decision.finalized ? `Task ${decision.finalStatus}.` : 'Vote recorded. Awaiting other reviewers.',
      task:      updated,
      finalized: decision.finalized,
      decision:  decision.meta,
    });
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
