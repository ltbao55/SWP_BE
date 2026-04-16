/**
 * System Settings Routes — /api/settings
 * Manages the singleton system_settings row in Supabase.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

const getSettings = async () => {
  const { data, error } = await supabaseAdmin.from('system_settings').select('*').limit(1).single();
  if (error) throw error;
  return data;
};

// GET /api/settings
/**
 * @swagger
 * /api/settings:
 *   get:
 *     summary: Get system settings (admin only)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System settings object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:             { type: string, format: uuid }
 *                 storage_config: { type: object }
 *                 task_config:    { type: object }
 *                 review_config:  { type: object }
 *                 general_config: { type: object }
 *                 updated_by:     { type: string, format: uuid }
 *                 updated_at:     { type: string, format: date-time }
 */
router.get('/', auth, authorize('admin'), async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch settings.', error: err.message });
  }
});

// PUT /api/settings
/**
 * @swagger
 * /api/settings:
 *   put:
 *     summary: Update system settings — fields are deep-merged (admin only)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               storage_config:
 *                 type: object
 *                 example: { max_file_size_mb: 100 }
 *               task_config:
 *                 type: object
 *                 example: { auto_expire_days: 7 }
 *               review_config:
 *                 type: object
 *                 example: { min_approval_rate: 70 }
 *               general_config:
 *                 type: object
 *                 example: { app_name: "DataLabel Pro" }
 *     responses:
 *       200:
 *         description: Updated settings
 */
router.put('/', auth, authorize('admin'), async (req, res) => {
  try {
    const settings = await getSettings();
    const allowed = ['storage_config', 'task_config', 'review_config', 'general_config'];
    const updates = { updated_by: req.user.id };
    allowed.forEach((field) => {
      if (field in req.body) updates[field] = { ...settings[field], ...req.body[field] };
    });

    const { data, error } = await supabaseAdmin.from('system_settings')
      .update(updates).eq('id', settings.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update settings.', error: err.message });
  }
});

module.exports = router;
