/**
 * Activity Log Routes — /api/activity-logs
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// GET /api/activity-logs — Admin only
/**
 * @swagger
 * /api/activity-logs:
 *   get:
 *     summary: List activity logs with filters (admin only)
 *     tags: [Activity Logs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *         description: e.g. login, task_submit, project_create
 *       - in: query
 *         name: user_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: resource_type
 *         schema: { type: string }
 *         description: e.g. task, project, dataset, system
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated activity log entries
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Pagination'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:            { type: string, format: uuid }
 *                           action:        { type: string }
 *                           resource_type: { type: string }
 *                           resource_id:   { type: string }
 *                           description:   { type: string }
 *                           ip_address:    { type: string }
 *                           created_at:    { type: string, format: date-time }
 *                           user:          { $ref: '#/components/schemas/UserProfile' }
 */
router.get('/', auth, authorize('admin'), async (req, res) => {
  try {
    const { action, user_id, resource_type, start_date, end_date, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabaseAdmin
      .from('activity_logs')
      .select('*, user:profiles!user_id(id, username, full_name, role)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (action)        query = query.eq('action', action);
    if (user_id)       query = query.eq('user_id', user_id);
    if (resource_type) query = query.eq('resource_type', resource_type);
    if (start_date)    query = query.gte('created_at', start_date);
    if (end_date)      query = query.lte('created_at', end_date);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /activity-logs]', err);
    res.status(500).json({ message: 'Failed to fetch activity logs.', error: err.message });
  }
});

// GET /api/activity-logs/stats — Admin only
/**
 * @swagger
 * /api/activity-logs/stats:
 *   get:
 *     summary: Get action counts for the last 7 days (admin only)
 *     tags: [Activity Logs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Action counts grouped by action type
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 action_counts:
 *                   type: object
 *                   example: { login: 42, task_submit: 18, project_create: 3 }
 *                 period:
 *                   type: string
 *                   example: last_7_days
 */
router.get('/stats', auth, authorize('admin'), async (req, res) => {
  try {
    const { data: actionStats, error: aErr } = await supabaseAdmin
      .from('activity_logs')
      .select('action')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    if (aErr) throw aErr;

    const counts = {};
    (actionStats || []).forEach((row) => {
      counts[row.action] = (counts[row.action] || 0) + 1;
    });

    res.json({ action_counts: counts, period: 'last_7_days' });
  } catch (err) {
    console.error('[GET /activity-logs/stats]', err);
    res.status(500).json({ message: 'Failed to fetch stats.', error: err.message });
  }
});

module.exports = router;
