/**
 * AI Routes — /api/ai
 * Auto pre-labeling for image annotation tasks using Google Gemini.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');
const { preLabelImage }   = require('../services/ai');

const router = express.Router();
const BUCKET = process.env.STORAGE_BUCKET || 'datasets';

// ── POST /api/ai/pre-label/:taskId ────────────────────────────
/**
 * @swagger
 * /api/ai/pre-label/{taskId}:
 *   post:
 *     summary: Auto pre-label an image task using Gemini AI
 *     description: |
 *       Uses the task's image and label set to generate AI suggestions.
 *       Pass `apply=true` to save suggestions into `task.annotation_data.ai_suggestion`.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: apply
 *         schema: { type: boolean, default: false }
 *         description: If true, save the AI suggestion to the task's annotation_data
 *     responses:
 *       200:
 *         description: AI label suggestions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task_id: { type: string, format: uuid }
 *                 model:   { type: string, example: gemini-2.0-flash }
 *                 suggestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:       { type: string }
 *                       confidence: { type: number, format: float, example: 0.95 }
 *                       reasoning:  { type: string }
 *                 applied: { type: boolean }
 *       400:
 *         description: Task is not an image task or has no label set
 *       403:
 *         description: Task not assigned to you
 *       404:
 *         description: Task not found
 *       500:
 *         description: AI provider error
 */
router.post('/pre-label/:taskId', auth, async (req, res) => {
  try {
    const apply = req.query.apply === 'true';

    const { data: task, error } = await supabaseAdmin
      .from('tasks')
      .select(`
        id, status, annotator_id, annotation_data,
        data_item:data_items!data_item_id(id, storage_path, storage_url, mime_type),
        label_set:label_sets!label_set_id(id, name,
          labels(id, name, description)
        )
      `)
      .eq('id', req.params.taskId)
      .single();

    if (error || !task) return res.status(404).json({ message: 'Task not found.' });

    // Permission: annotator owns task, or manager/admin/reviewer
    const isOwner = task.annotator_id === req.user.id;
    const isStaff = ['admin', 'manager', 'reviewer'].includes(req.user.role);
    if (!isOwner && !isStaff) {
      return res.status(403).json({ message: 'You do not have access to this task.' });
    }

    // Validate task is image-based
    if (!task.data_item) {
      return res.status(400).json({ message: 'Task has no associated data item.' });
    }
    const mime = task.data_item.mime_type || '';
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ message: `AI pre-labeling only supports images. Got: ${mime}` });
    }

    if (!task.label_set || !task.label_set.labels?.length) {
      return res.status(400).json({ message: 'Task has no label set with labels.' });
    }

    // Get a working URL — prefer signed URL for private buckets
    let imageUrl = task.data_item.storage_url;
    if (task.data_item.storage_path) {
      const { data: signed } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(task.data_item.storage_path, 600);
      if (signed?.signedUrl) imageUrl = signed.signedUrl;
    }

    if (!imageUrl) {
      return res.status(400).json({ message: 'Image URL is not available.' });
    }

    const aiResult = await preLabelImage(imageUrl, task.label_set.labels);

    let applied = false;
    if (apply && isOwner) {
      const newAnnotation = {
        ...(task.annotation_data || {}),
        ai_suggestion: {
          model:        process.env.GEMINI_MODEL || 'gemini-2.0-flash',
          generated_at: new Date().toISOString(),
          suggestions:  aiResult.labels,
        },
      };
      await supabaseAdmin.from('tasks')
        .update({ annotation_data: newAnnotation })
        .eq('id', task.id);
      applied = true;
    }

    await logActivity({
      userId:       req.user.id,
      action:       'ai_pre_label',
      resourceType: 'task',
      resourceId:   task.id,
      description:  `AI pre-labeled task with ${aiResult.labels.length} suggestion(s)`,
      metadata:     { model: process.env.GEMINI_MODEL, count: aiResult.labels.length, applied },
      req,
    });

    res.json({
      task_id:     task.id,
      model:       process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      suggestions: aiResult.labels,
      applied,
    });
  } catch (err) {
    console.error('[POST /ai/pre-label/:taskId]', err);
    res.status(500).json({ message: 'AI pre-labeling failed.', error: err.message });
  }
});

// ── POST /api/ai/analyze-image ────────────────────────────────
/**
 * @swagger
 * /api/ai/analyze-image:
 *   post:
 *     summary: Ad-hoc — analyze any image with a custom set of labels
 *     description: |
 *       Pass an image URL and a list of candidate labels. Useful for quick testing
 *       outside the task workflow.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image_url, labels]
 *             properties:
 *               image_url:
 *                 type: string
 *                 example: https://example.com/cat.jpg
 *               labels:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:        { type: string, example: cat }
 *                     description: { type: string, example: A domestic feline }
 *     responses:
 *       200:
 *         description: AI label suggestions
 *       400:
 *         description: Missing image_url or labels
 *       500:
 *         description: AI provider error
 */
router.post('/analyze-image', auth, authorize('admin', 'manager', 'reviewer'), async (req, res) => {
  try {
    const { image_url, labels } = req.body;
    if (!image_url) return res.status(400).json({ message: 'image_url is required.' });
    if (!Array.isArray(labels) || labels.length === 0) {
      return res.status(400).json({ message: 'labels array is required.' });
    }

    const aiResult = await preLabelImage(image_url, labels);
    res.json({
      model:       process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      suggestions: aiResult.labels,
    });
  } catch (err) {
    console.error('[POST /ai/analyze-image]', err);
    res.status(500).json({ message: 'AI analysis failed.', error: err.message });
  }
});

module.exports = router;
