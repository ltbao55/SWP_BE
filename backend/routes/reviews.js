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

// TASK_WITH_PROJECT: Minimal safe select for reviewer workflow.
// - project_labels(label:labels(*)) excluded: requires FK migrations not guaranteed on all envs.
// - dataset_id excluded from projects: added by migration_subtopic_ownership.sql, not in base schema.
// - dataset_id excluded from data_items select in join: not needed for review display.
// Only columns guaranteed to exist in schema.sql v4 are used here.
const TASK_WITH_PROJECT = `
  id, status, annotation_data, review_comments, error_category,
  review_notes, review_issues, submitted_at, reviewed_at, created_at, updated_at,
  project:projects!project_id(id, name, guidelines, deadline, review_policy),
  data_item:data_items!data_item_id(id, filename, original_name, storage_path, storage_url, mime_type),
  annotator:profiles!annotator_id(id, username, full_name),
  reviewer:profiles!reviewer_id(id, username, full_name)
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
    console.log(`[GET /reviews/pending] User: ${req.user.id}, Role: ${req.user.role}, project_id: ${project_id}, page: ${page}, limit: ${limit}`);
    const validProjectId = (project_id && project_id !== 'undefined' && project_id !== 'null')
      ? project_id : null;

    // ── Helper: fetch full task list for a project (no sampling) ──
    const getFullTasks = async (pid) => {
      let q = supabaseAdmin
        .from('tasks')
        .select(TASK_WITH_PROJECT)
        .in('status', ['submitted', 'resubmitted'])
        .order('submitted_at', { ascending: true });
      if (pid) q = q.eq('project_id', pid);
      if (req.user.role === 'reviewer') {
        q = q.or(`reviewer_id.is.null,reviewer_id.eq.${req.user.id}`);
      }
      const { data, error } = await q;
      if (error) {
        console.error('[DB Error]', error);
        throw error;
      }
      return data || [];
    };

    // ── Helper: stratified sample for a project (JS-side, no RPC) ──
    // ROOT CAUSE FIX: The get_stratified_tasks() Supabase RPC was created when
    // tasks had 16 columns. After migrations, tasks now has 18 columns → PostgreSQL
    // error 42804 "Number of returned columns (18) does not match expected column count (16)".
    // Solution: implement sampling in JS using only id+annotator_id, then fetch full
    // details with TASK_WITH_PROJECT. This is schema-change-safe.
    const getSampledTasks = async (pid, rate) => {
      // Step 1: get only id + annotator_id to compute stratified selection
      const { data: candidates, error: candidateErr } = await supabaseAdmin
        .from('tasks')
        .select('id, annotator_id')
        .eq('project_id', pid)
        .in('status', ['submitted', 'resubmitted']);

      if (candidateErr) { console.error('[Stratified Sampling - candidates]', candidateErr); throw candidateErr; }
      if (!candidates?.length) return [];

      // Step 2: group by annotator_id
      const byAnnotator = {};
      for (const t of candidates) {
        if (!byAnnotator[t.annotator_id]) byAnnotator[t.annotator_id] = [];
        byAnnotator[t.annotator_id].push(t.id);
      }

      // Step 3: for each annotator, randomly take ceil(count * rate) task IDs
      const selectedIds = [];
      for (const ids of Object.values(byAnnotator)) {
        const shuffled = [...ids].sort(() => Math.random() - 0.5);
        const take = Math.ceil(ids.length * rate);
        selectedIds.push(...shuffled.slice(0, take));
      }

      if (!selectedIds.length) return [];

      // Step 4: fetch full task details for the selected IDs using safe TASK_WITH_PROJECT
      let q = supabaseAdmin
        .from('tasks')
        .select(TASK_WITH_PROJECT)
        .in('id', selectedIds)
        .order('submitted_at', { ascending: true });
      if (req.user.role === 'reviewer') {
        q = q.or(`reviewer_id.is.null,reviewer_id.eq.${req.user.id}`);
      }
      const { data, error } = await q;
      if (error) { console.error('[Stratified Sampling - fetch]', error); throw error; }
      return data || [];
    };


    let allTasks = [];
    let samplingMode = 'full';

    if (validProjectId) {
      // ── Single project mode ──
      const { data: project } = await supabaseAdmin
        .from('projects').select('review_policy').eq('id', validProjectId).single();

      const sampleRate = parseFloat(project?.review_policy?.sample_rate || 1.0);
      console.log(`[GET /reviews/pending] project=${validProjectId} sampleRate=${sampleRate}`);

      if (sampleRate < 1.0) {
        allTasks = await getSampledTasks(validProjectId, sampleRate);
        samplingMode = `stratified_${sampleRate * 100}%`;
      } else {
        allTasks = await getFullTasks(validProjectId);
      }
    } else {
      // ── All-projects mode: discover projects → apply per-project sampling ──
      console.log('[GET /reviews/pending] No project_id — discovering projects for reviewer');

      // Step 1: find all distinct project_ids with pending tasks for this reviewer
      let discoveryQ = supabaseAdmin
        .from('tasks')
        .select('project_id')
        .in('status', ['submitted', 'resubmitted']);
      if (req.user.role === 'reviewer') {
        discoveryQ = discoveryQ.or(`reviewer_id.is.null,reviewer_id.eq.${req.user.id}`);
      }
      const { data: taskRows, error: discErr } = await discoveryQ;
      if (discErr) throw discErr;

      const distinctProjectIds = [...new Set((taskRows || []).map(t => t.project_id).filter(Boolean))];
      console.log('[GET /reviews/pending] Distinct projects:', distinctProjectIds.length);

      if (distinctProjectIds.length === 0) {
        return res.json({ data: [], total: 0, sampling: 'full' });
      }

      // Step 2: fetch review_policy for each project
      const { data: projects, error: projErr } = await supabaseAdmin
        .from('projects')
        .select('id, review_policy')
        .in('id', distinctProjectIds);
      if (projErr) throw projErr;

      const projectMap = {};
      (projects || []).forEach(p => { projectMap[p.id] = p; });

      // Step 3: apply sampling per project and combine
      for (const pid of distinctProjectIds) {
        const proj = projectMap[pid];
        const rate = parseFloat(proj?.review_policy?.sample_rate || 1.0);

        if (rate < 1.0) {
          samplingMode = 'stratified';
          const sampled = await getSampledTasks(pid, rate);
          allTasks.push(...sampled);
        } else {
          const full = await getFullTasks(pid);
          allTasks.push(...full);
        }
      }

      // Sort combined results chronologically
      allTasks.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    }

    // Paginate in-memory
    const total = allTasks.length;
    const paginatedData = allTasks.slice(offset, offset + Number(limit));

    res.json({ data: paginatedData, total, sampling: samplingMode });
  } catch (err) {
    console.error('[GET /reviews/pending] CRITICAL ERROR:', err);
    // Include more details in the response for easier debugging during development/deployment phase
    res.status(500).json({ 
      message: 'Failed to fetch pending reviews.', 
      error: err.message,
      code: err.code,
      details: err.details,
      hint: err.hint
    });
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
