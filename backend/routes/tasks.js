/**
 * Task Routes — /api/tasks
 * Core workflow engine: assigned → in_progress → submitted → approved/rejected → resubmitted
 */
const express = require('express');
const { supabaseAdmin, supabaseWithToken }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { assertTransition, getSubmitStatus } = require('../utils/workflow');
const { taskAssignValidators, handleValidationErrors } = require('../utils/validators');
const { groupBboxesByLabel, formatGroupedData } = require('../utils/annotationUtils');
const { getAIPredictions } = require('../services/aiService');

const router = express.Router();

const TASK_SELECT = `
  id, status, annotation_data, review_comments, error_category,
  review_notes, review_issues, submitted_at, reviewed_at, created_at, updated_at,
  project:projects!project_id(id, name, guidelines, deadline, review_policy, dataset_id, project_labels(label:labels(*))),
  dataset:datasets!dataset_id(id, name),
  data_item:data_items!data_item_id(id, filename, original_name, storage_path, storage_url, mime_type, dataset_id),
  annotator:profiles!annotator_id(id, username, full_name),
  reviewer:profiles!reviewer_id(id, username, full_name)
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
      .select(TASK_SELECT)
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

// POST /api/tasks/assign — Manager assigns items by auto splitting among annotators
/**
 * @swagger
 * /api/tasks/assign:
 *   post:
 *     summary: Auto-split unassigned data items from a dataset evenly across annotators (manager / admin)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, dataset_id, annotator_ids]
 *             properties:
 *               project_id:
 *                 type: string
 *                 format: uuid
 *               dataset_id:
 *                 type: string
 *                 format: uuid
 *               annotator_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               reviewer_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional explicit reviewer assignment
 *     responses:
 *       201:
 *         description: Tasks auto-split and assigned
 *       400:
 *         description: No annotators provided or invalid annotator
 *       404:
 *         description: Project not found
 */
router.post('/assign', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { project_id, dataset_id, annotator_ids = [], reviewer_id = null } = req.body;

    if (!annotator_ids || annotator_ids.length === 0) {
      return res.status(400).json({ message: 'Must provide at least one annotator_id.' });
    }

    const { data: project } = await supabaseAdmin.from('projects').select('id, manager_id').eq('id', project_id).single();
    if (!project) return res.status(404).json({ message: 'Project not found.' });
    if (req.user.role === 'manager' && project.manager_id !== req.user.id)
      return res.status(403).json({ message: 'You can only assign tasks in your own projects.' });

    // Validate annotators
    const { data: validAnnotators } = await supabaseAdmin
      .from('profiles').select('id')
      .in('id', annotator_ids).eq('role', 'annotator').eq('is_active', true);
    if (!validAnnotators || validAnnotators.length !== annotator_ids.length) {
      return res.status(400).json({ message: 'One or more invalid or inactive annotators provided.' });
    }

    // Find all items in this dataset that do not have a task for this project
    const { data: existingTasks } = await supabaseAdmin.from('tasks').select('data_item_id').eq('project_id', project_id);
    const assignedItemIds = new Set((existingTasks || []).map(t => t.data_item_id));

    const { data: allItems } = await supabaseAdmin.from('data_items').select('id').eq('dataset_id', dataset_id);
    const unassignedItems = (allItems || []).filter(item => !assignedItemIds.has(item.id));

    if (unassignedItems.length === 0) {
      return res.status(400).json({ message: 'No unassigned items left in this dataset for this project.' });
    }

    const annotators = validAnnotators.map(a => a.id);

    // Round-robin distribution
    const taskInserts = unassignedItems.map((item, i) => ({
      project_id, dataset_id, data_item_id: item.id,
      annotator_id: annotators[i % annotators.length],
      reviewer_id: reviewer_id || null,
      status: 'assigned',
    }));

    const { data: tasks, error: taskError } = await supabaseWithToken(req.token).from('tasks').insert(taskInserts).select('id, data_item_id, status');
    if (taskError) throw taskError;



    const dataItemIds = tasks.map(t => t.data_item_id);
    await supabaseAdmin.from('data_items').update({ status: 'assigned' }).in('id', dataItemIds);
    
    // Update total tasks in project
    const { count: taskCount } = await supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).eq('project_id', project_id);
    await supabaseAdmin.from('projects').update({ total_tasks: taskCount, status: 'active' }).eq('id', project_id);

    await logActivity({ userId: req.user.id, action: 'task_assign', resourceType: 'task',
      description: `${tasks.length} task(s) evenly distributed among ${annotators.length} annotator(s)`, metadata: { project_id, count: tasks.length }, req });

    res.status(201).json({ message: `${tasks.length} task(s) auto-assigned successfully.`, tasks });
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
 *                 description: >
 *                   Annotation payload. `bboxes` will be automatically grouped by label
 *                   and stored in `grouped` field before saving.
 *                 example:
 *                   labels: ["cat"]
 *                   bboxes:
 *                     - { label: "cat", x: 10, y: 20, width: 50, height: 30 }
 *                     - { label: "dog", x: 100, y: 120, width: 60, height: 40 }
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
    const currentStatus = (task.status || '').toLowerCase().trim();
    const allowedStatuses = ['in_progress', 'assigned', 'rejected'];
    
    if (!allowedStatuses.includes(currentStatus)) {
      console.log(`[DEBUG /save] Blocking save for Task ${req.params.id}. Status: "${currentStatus}" (Found: ${task.status})`);
      return res.status(400).json({ 
        message: `Cannot save a task with status "${task.status}". Allowed: ${allowedStatuses.join(', ')}` 
      });
    }

    // Group bboxes by label before persisting (adds `grouped` field, keeps `bboxes` for COCO export)
    const processedAnnotation = groupBboxesByLabel(annotation_data);

    const { data: updated, error } = await supabaseAdmin.from('tasks')
      .update({ annotation_data: processedAnnotation, status: task.status === 'assigned' ? 'in_progress' : task.status })
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
 * /api/tasks/batch-submit:
 *   post:
 *     summary: Submit multiple tasks for review in a single request
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [submissions]
 *             properties:
 *               submissions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     annotation_data: { type: object }
 *     responses:
 *       200:
 *         description: All tasks processed
 *       400:
 *         description: Invalid input or transitions
 */
router.post('/batch-submit', auth, authorize('annotator'), async (req, res) => {
  try {
    const { submissions } = req.body;
    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({ message: 'No submissions provided.' });
    }

    const results = [];
    const errors = [];

    for (const sub of submissions) {
      const { id, annotation_data } = sub;
      try {
        const { data: task } = await supabaseAdmin.from('tasks')
          .select('id, status, annotator_id, annotation_data, review_comments')
          .eq('id', id)
          .single();

        if (!task) throw new Error('Task not found');
        if (task.annotator_id !== req.user.id) throw new Error('Forbidden');

        const isResubmission = task.status === 'rejected' || task.review_comments !== null;
        const nextStatus = isResubmission ? 'resubmitted' : getSubmitStatus(task.status);
        assertTransition(task.status, nextStatus);

        const rawAnnotation = annotation_data ?? task.annotation_data;
        if (!rawAnnotation || Object.keys(rawAnnotation).length === 0)
          throw new Error('Missing annotation data');

        const finalAnnotation = groupBboxesByLabel(rawAnnotation);

        const { data: updated, error } = await supabaseAdmin.from('tasks')
          .update({ 
            annotation_data: finalAnnotation, 
            status: nextStatus, 
            submitted_at: new Date().toISOString(),
            review_comments: null,
            review_notes: [],
            review_issues: [],
            error_category: null  // reset to null on submit; only reviewer sets this on reject
          })
          .eq('id', id).select('id, status, submitted_at').single();

        if (error) throw error;

        await logActivity({ userId: req.user.id, action: 'task_submit', resourceType: 'task', resourceId: id,
          description: `Task submitted (${task.status} → ${nextStatus})`, req });

        results.push(updated);
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    res.json({ message: `Processed ${submissions.length} submissions.`, results, errors });
  } catch (err) {
    console.error('[POST /tasks/batch-submit]', err);
    res.status(500).json({ message: 'Batch submit failed.', error: err.message });
  }
});

router.post('/:id/submit', auth, authorize('annotator'), async (req, res) => {
  try {
    const { annotation_data } = req.body;
    const { data: task } = await supabaseAdmin.from('tasks').select('id, status, annotator_id, annotation_data, review_comments').eq('id', req.params.id).single();
    if (!task) return res.status(404).json({ message: 'Task not found.' });
    if (task.annotator_id !== req.user.id) return res.status(403).json({ message: 'This task is not assigned to you.' });

    const isResubmission = task.status === 'rejected' || task.review_comments !== null;
    const nextStatus = isResubmission ? 'resubmitted' : getSubmitStatus(task.status);
    
    assertTransition(task.status, nextStatus);

    const rawAnnotation = annotation_data ?? task.annotation_data;
    if (!rawAnnotation || Object.keys(rawAnnotation).length === 0)
      return res.status(400).json({ message: 'Cannot submit a task without annotation data.' });

    // Group bboxes by label before final submission (adds `grouped` field, keeps `bboxes` for COCO export)
    const finalAnnotation = groupBboxesByLabel(rawAnnotation);

    const { data: updated, error } = await supabaseAdmin.from('tasks')
      .update({ 
        annotation_data: finalAnnotation, 
        status: nextStatus, 
        submitted_at: new Date().toISOString(),
        review_comments: null,
        review_notes: [],
        review_issues: [],
        error_category: null  // reset to null on submit; only reviewer sets this on reject
      })
      .eq('id', req.params.id).select('id, status, submitted_at').single();
    if (error) throw error;

    // Task submission logic — status updated to nextStatus, reviewer status handled via tasks.status
    await logActivity({ userId: req.user.id, action: 'task_submit', resourceType: 'task', resourceId: req.params.id,
      description: `Task submitted (${task.status} → ${nextStatus})`, req });

    res.json({ message: 'Task submitted for review.', task: updated });
  } catch (err) {
    if (err.message.startsWith('Invalid status transition')) return res.status(400).json({ message: err.message });
    console.error('[POST /tasks/:id/submit]', err);
    res.status(500).json({ message: 'Failed to submit task.', error: err.message });
  }
});

// POST /api/tasks/:id/ai-assist
/**
 * @swagger
 * /api/tasks/{id}/ai-assist:
 *   post:
 *     summary: Trigger AI to generate draft bounding boxes for an image (annotator button)
 *     description: |
 *       Human-in-the-loop flow:
 *       1. Annotator clicks "AI Assist" button on the labeling UI
 *       2. FE calls this endpoint
 *       3. Backend fetches the task image from Supabase Storage
 *       4. Sends image to AI model (Gemini / Mock) for bbox detection
 *       5. Returns grouped bboxes — FE renders them as draggable draft boxes
 *       6. Annotator adjusts → calls PUT /:id/save to persist final result
 *
 *       Note: this endpoint does NOT save anything to DB.
 *       It only returns suggestions for the annotator to review.
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
 *               image_width:
 *                 type: integer
 *                 default: 1000
 *                 description: Canvas width in pixels (for coordinate scaling)
 *               image_height:
 *                 type: integer
 *                 default: 1000
 *                 description: Canvas height in pixels (for coordinate scaling)
 *     responses:
 *       200:
 *         description: AI draft bboxes grouped by label — ready for FE renderer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task_id:   { type: string, format: uuid }
 *                 mode:      { type: string, enum: [mock, gemini], example: gemini }
 *                 bboxes:
 *                   type: array
 *                   description: Flat list of predicted boxes
 *                   items:
 *                     type: object
 *                     properties:
 *                       label:      { type: string }
 *                       x:          { type: integer }
 *                       y:          { type: integer }
 *                       width:      { type: integer }
 *                       height:     { type: integer }
 *                       confidence: { type: number, format: float }
 *                 grouped:
 *                   type: object
 *                   description: Same bboxes grouped by label for FE rendering
 *                   example:
 *                     cat: [{ x: 10, y: 20, width: 50, height: 30, confidence: 0.92 }]
 *                     dog: [{ x: 100, y: 120, width: 60, height: 40, confidence: 0.85 }]
 *       400:
 *         description: Task is not an image or has no label set
 *       403:
 *         description: Task not assigned to you
 *       404:
 *         description: Task not found
 */
router.post('/:id/ai-assist', auth, authorize('annotator'), async (req, res) => {
  try {
    const { image_width = 1000, image_height = 1000 } = req.body;

    // ── STEP 1: Load task with image + label set ──────────────
    const { data: task, error } = await supabaseAdmin
      .from('tasks')
      .select(`
        id, status, annotator_id,
        data_item:data_items!data_item_id(id, storage_path, storage_url, mime_type),
        project:projects!project_id(
          project_labels(label:labels(id, name, description))
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !task) return res.status(404).json({ message: 'Task not found.' });
    if (task.annotator_id !== req.user.id)
      return res.status(403).json({ message: 'This task is not assigned to you.' });

    // ── STEP 2: Validate image task ───────────────────────────
    const mime = task.data_item?.mime_type || '';
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ message: `AI Assist only supports image tasks. Got: ${mime}` });
    }
    const projectLabels = (task.project?.project_labels || []).map(pl => pl.label).filter(Boolean);
    if (projectLabels.length === 0) {
      return res.status(400).json({ message: 'Project has no labels — cannot determine what to detect.' });
    }

    // ── STEP 3: Get image URL (prefer signed URL for private storage) ──
    let imageUrl = task.data_item.storage_url;
    if (task.data_item.storage_path) {
      const { data: signed } = await supabaseAdmin.storage
        .from(process.env.STORAGE_BUCKET || 'datasets')
        .createSignedUrl(task.data_item.storage_path, 600); // 10 min validity
      if (signed?.signedUrl) imageUrl = signed.signedUrl;
    }
    if (!imageUrl) return res.status(400).json({ message: 'Image URL is not available.' });

    // ── STEP 4: Call AI service (Mock or Gemini) ──────────────
    const rawBboxes = await getAIPredictions({
      imageUrl,
      labels:    projectLabels,
      imageSize: { width: image_width, height: image_height },
    });

    // ── STEP 5: Format output — flat array + grouped map ──────
    // grouped goes to FE bbox renderer; bboxes[] stays for annotator to
    // pass back via PUT /:id/save when they're done adjusting
    const grouped = formatGroupedData(rawBboxes);

    res.json({
      task_id: task.id,
      mode:    process.env.AI_BBOX_MODE || 'gemini',
      bboxes:  rawBboxes,  // flat — FE populates the canvas with these
      grouped,             // grouped — FE can also use this for label-aware rendering
    });
  } catch (err) {
    console.error('[POST /tasks/:id/ai-assist]', err);
    res.status(500).json({ message: 'AI Assist failed.', error: err.message });
  }
});

module.exports = router;
