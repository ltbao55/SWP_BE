/**
 * Authentication & Authorization Middleware
 * Uses Supabase Auth JWT — no local JWT secret needed.
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * auth — Verifies the Bearer token from Supabase Auth.
 * Attaches `req.user` (profile row) and `req.token` to the request.
 */
const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: 'No token provided. Authorization denied.' });
    }

    // Verify the JWT against Supabase Auth
    const { data: { user: authUser }, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authUser) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    // Fetch the profile (role, active status, etc.)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, username, full_name, role, specialty, is_active, avatar_url')
      .eq('id', authUser.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ message: 'User profile not found.' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ message: 'Account is deactivated. Contact an administrator.' });
    }

    req.token = token;
    req.user  = {
      id:        profile.id,
      email:     authUser.email,
      username:  profile.username,
      fullName:  profile.full_name,
      role:      profile.role.toLowerCase(),
      specialty: profile.specialty,
      isActive:  profile.is_active,
    };

    next();
  } catch (err) {
    console.error('[auth middleware]', err);
    res.status(500).json({ message: 'Authentication error.', error: err.message });
  }
};

/**
 * authorize — Role-based access control gate.
 * Usage: router.get('/route', auth, authorize('admin', 'manager'), handler)
 *
 * @param {...string} roles - Allowed roles (case-insensitive)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized — not authenticated.' });
  }

  const allowedRoles = roles.map((r) => r.toLowerCase());
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      message: `Forbidden — requires one of: [${allowedRoles.join(', ')}]. Your role: ${req.user.role}.`,
    });
  }

  next();
};

module.exports = { auth, authorize };
