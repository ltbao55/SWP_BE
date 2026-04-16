/**
 * Auth Routes — /api/auth
 * Delegates credential management to Supabase Auth.
 * Profile data (role, full_name, etc.) is stored in public.profiles.
 */

const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { auth }          = require('../middleware/auth');
const { logActivity }   = require('../utils/activityLogger');
const {
  registerValidators,
  loginValidators,
  handleValidationErrors,
} = require('../utils/validators');

const router = express.Router();

// ── POST /api/auth/register ─────────────────────────────────
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, username, full_name, role]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 example: secret123
 *               username:
 *                 type: string
 *                 example: john_doe
 *               full_name:
 *                 type: string
 *                 example: John Doe
 *               role:
 *                 type: string
 *                 enum: [admin, manager, annotator, reviewer]
 *                 example: annotator
 *               specialty:
 *                 type: string
 *                 example: general
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/AuthTokens'
 *                 - type: object
 *                   properties:
 *                     message: { type: string }
 *                     user:    { $ref: '#/components/schemas/UserProfile' }
 *       409:
 *         description: Email or username already taken
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/register', registerValidators, handleValidationErrors, async (req, res) => {
  const { email, password, username, full_name, role, specialty = 'general' } = req.body;

  try {
    // 1. Check username uniqueness (Supabase Auth does not enforce this)
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }

    // 2. Create the auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,          // skip email verification in dev
      user_metadata: { username, full_name, role },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ message: 'Email is already registered.' });
      }
      throw authError;
    }

    const userId = authData.user.id;

    // 3. Insert profile row
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id:        userId,
      username,
      full_name,
      role,
      specialty,
      is_active: true,
    });

    if (profileError) {
      // Rollback the auth user if profile creation fails
      await supabaseAdmin.auth.admin.deleteUser(userId);
      throw profileError;
    }

    // 4. Sign the user in to get tokens
    const { data: session, error: sessionError } =
      await supabaseAdmin.auth.admin.generateLink({
        type:  'magiclink',
        email,
      });

    // Use password sign-in instead to get proper tokens
    const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) throw signInError;

    await logActivity({
      userId,
      action:       'user_create',
      resourceType: 'user',
      resourceId:   userId,
      description:  `User "${username}" (${role}) registered`,
      metadata:     { username, email, role },
      req,
    });

    res.status(201).json({
      message: 'User registered successfully.',
      access_token:  signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      expires_in:    signInData.session.expires_in,
      user: {
        id:        userId,
        email,
        username,
        full_name,
        role,
        specialty,
      },
    });
  } catch (err) {
    console.error('[POST /auth/register]', err);
    res.status(500).json({ message: 'Registration failed.', error: err.message });
  }
});

// ── POST /api/auth/login ────────────────────────────────────
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login and obtain JWT tokens
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 example: secret123
 *     responses:
 *       200:
 *         description: Login successful — copy access_token and use as Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/AuthTokens'
 *                 - type: object
 *                   properties:
 *                     user: { $ref: '#/components/schemas/UserProfile' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       403:
 *         description: Account deactivated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/login', loginValidators, handleValidationErrors, async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data: signInData, error: signInError } =
      await supabaseAdmin.auth.signInWithPassword({ email, password });

    if (signInError) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const userId = signInData.user.id;

    // Fetch profile to check is_active and include role
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('username, full_name, role, specialty, is_active')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ message: 'User profile not found. Contact an administrator.' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ message: 'Account is deactivated. Contact an administrator.' });
    }

    await logActivity({
      userId,
      action:       'login',
      resourceType: 'system',
      description:  `User "${profile.username}" logged in`,
      metadata:     { role: profile.role },
      req,
    });

    res.json({
      access_token:  signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      expires_in:    signInData.session.expires_in,
      user: {
        id:        userId,
        email:     signInData.user.email,
        username:  profile.username,
        full_name: profile.full_name,
        role:      profile.role,
        specialty: profile.specialty,
      },
    });
  } catch (err) {
    console.error('[POST /auth/login]', err);
    res.status(500).json({ message: 'Login failed.', error: err.message });
  }
});

// ── POST /api/auth/refresh ──────────────────────────────────
/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token using refresh_token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: New tokens issued
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthTokens' }
 *       401:
 *         description: Refresh token invalid or expired
 */
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ message: 'refresh_token is required.' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token });

    if (error) {
      return res.status(401).json({ message: 'Token refresh failed.', error: error.message });
    }

    res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
    });
  } catch (err) {
    res.status(500).json({ message: 'Token refresh error.', error: err.message });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────
/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout (invalidate session)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post('/logout', auth, async (req, res) => {
  try {
    await supabaseAdmin.auth.admin.signOut(req.token);

    await logActivity({
      userId:       req.user.id,
      action:       'logout',
      resourceType: 'system',
      description:  `User "${req.user.username}" logged out`,
      req,
    });

    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    // Even if sign-out fails, respond 200 — token will expire naturally
    res.json({ message: 'Logged out.' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────
/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Auth]
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
 *       401:
 *         description: Unauthorized
 */
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ── PUT /api/auth/me/password ───────────────────────────────
/**
 * @swagger
 * /api/auth/me/password:
 *   put:
 *     summary: Change current user's password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [current_password, new_password]
 *             properties:
 *               current_password:
 *                 type: string
 *               new_password:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Password updated
 *       400:
 *         description: Current password incorrect or new password too short
 */
router.put('/me/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  }

  try {
    // Verify current password by signing in
    const { error: verifyError } = await supabaseAdmin.auth.signInWithPassword({
      email:    req.user.email,
      password: current_password,
    });

    if (verifyError) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      req.user.id,
      { password: new_password }
    );

    if (updateError) throw updateError;

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[PUT /auth/me/password]', err);
    res.status(500).json({ message: 'Password update failed.', error: err.message });
  }
});

module.exports = router;
