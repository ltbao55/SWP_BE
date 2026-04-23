/**
 * User Management Routes — /api/users
 * CRUD for user profiles. Admin manages all; manager sees annotators/reviewers.
 */

const express = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { auth, authorize } = require('../middleware/auth');
const { logActivity }     = require('../utils/activityLogger');

const router = express.Router();

const PROFILE_SELECT = 'id, username, full_name, role, specialty, is_active, avatar_url, created_at, updated_at';

// ── GET /api/users ───────────────────────────────────────────
/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: List users (managers see only annotators/reviewers)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [admin, manager, annotator, reviewer]
 *       - in: query
 *         name: is_active
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Paginated list of users
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Pagination'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/UserProfile' }
 */
router.get('/', auth, async (req, res) => {
  try {
    const { role, is_active, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabaseAdmin.from('profiles')
      .select(PROFILE_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    // Managers can only see annotators and reviewers
    if (req.user.role === 'manager') {
      query = query.in('role', ['annotator', 'reviewer']);
    }

    if (role)      query = query.eq('role', role);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /users]', err);
    res.status(500).json({ message: 'Failed to fetch users.', error: err.message });
  }
});

// ── GET /api/users/me ────────────────────────────────────────
/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current user's profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/UserProfile' }
 */
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ── GET /api/users/:id ───────────────────────────────────────
/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UserProfile' }
 *       404:
 *         description: User not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: user, error } = await supabaseAdmin.from('profiles')
      .select(PROFILE_SELECT).eq('id', req.params.id).single();
    if (error || !user) return res.status(404).json({ message: 'User not found.' });

    // Non-admins can only see themselves or teammates (annotators/reviewers)
    if (req.user.role === 'annotator' && req.user.id !== req.params.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    res.json(user);
  } catch (err) {
    console.error('[GET /users/:id]', err);
    res.status(500).json({ message: 'Failed to fetch user.', error: err.message });
  }
});

// ── PUT /api/users/me ────────────────────────────────────────
/**
 * @swagger
 * /api/users/me:
 *   put:
 *     summary: Update own profile (full_name, specialty, avatar_url)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name:  { type: string }
 *               specialty:  { type: string }
 *               avatar_url: { type: string }
 *     responses:
 *       200:
 *         description: Updated profile
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UserProfile' }
 */
router.put('/me', auth, async (req, res) => {
  try {
    const allowed = ['full_name', 'specialty', 'avatar_url'];
    const updates = {};
    allowed.forEach((f) => { if (f in req.body) updates[f] = req.body[f]; });

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ message: 'No updatable fields provided.' });

    const { data: updated, error } = await supabaseAdmin.from('profiles')
      .update(updates).eq('id', req.user.id).select(PROFILE_SELECT).single();
    if (error) throw error;

    res.json(updated);
  } catch (err) {
    console.error('[PUT /users/me]', err);
    res.status(500).json({ message: 'Failed to update profile.', error: err.message });
  }
});

// ── PUT /api/users/:id — Admin only ──────────────────────────
/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Admin — update any user (role, is_active, etc.)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name:  { type: string }
 *               specialty:  { type: string }
 *               role:
 *                 type: string
 *                 enum: [admin, manager, annotator, reviewer]
 *               is_active:  { type: boolean }
 *     responses:
 *       200:
 *         description: Updated user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UserProfile' }
 *       404:
 *         description: User not found
 */
router.put('/:id', auth, authorize('admin'), async (req, res) => {
  try {
    const { full_name, specialty, role, is_active } = req.body;
    const updates = {};
    if (full_name  !== undefined) updates.full_name  = full_name;
    if (specialty  !== undefined) updates.specialty  = specialty;
    if (role       !== undefined) {
      const validRoles = ['admin', 'manager', 'annotator', 'reviewer'];
      if (!validRoles.includes(role)) return res.status(400).json({ message: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      updates.role = role;
    }
    if (is_active !== undefined) updates.is_active = (is_active === true || is_active === 'true');

    const { data: updated, error } = await supabaseAdmin.from('profiles')
      .update(updates).eq('id', req.params.id).select(PROFILE_SELECT).single();
    if (error || !updated) return res.status(404).json({ message: 'User not found.' });

    await logActivity({ userId: req.user.id, action: 'user_update', resourceType: 'user',
      resourceId: req.params.id, description: `User ${req.params.id} updated`,
      metadata: { fields: Object.keys(updates) }, req });

    res.json(updated);
  } catch (err) {
    console.error('[PUT /users/:id]', err);
    res.status(500).json({ message: 'Failed to update user.', error: err.message });
  }
});

// ── DELETE /api/users/:id — Admin only ───────────────────────
/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Admin — delete a user account
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: User deleted
 *       400:
 *         description: Cannot delete own account
 */
router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ message: 'You cannot delete your own account.' });

    // Delete from Supabase Auth (profiles row cascades via FK)
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    if (error) throw error;

    await logActivity({ userId: req.user.id, action: 'user_delete', resourceType: 'user',
      resourceId: req.params.id, description: `User ${req.params.id} deleted`, req });

    res.json({ message: 'User deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /users/:id]', err);
    res.status(500).json({ message: 'Failed to delete user.', error: err.message });
  }
});

module.exports = router;
