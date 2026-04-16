/**
 * Supabase Client Configuration
 *
 * Two clients are exported:
 *  - supabaseAdmin  : service_role key — bypasses RLS, used server-side only
 *  - supabaseClient : anon key        — respects RLS, used for auth operations
 *
 * NEVER expose the service_role key to the frontend or any client code.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Ensure SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are set in .env'
  );
}

/**
 * Admin client — full access, bypasses RLS.
 * Use for all server-side mutations (create user, batch operations, cron jobs).
 */
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Public client — uses anon key, honours RLS.
 * Use for reading public data or when you want RLS enforced.
 */
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Create a Supabase client impersonating a specific JWT (user context).
 * Useful when you want RLS to enforce per-user visibility.
 *
 * @param {string} accessToken - JWT from Supabase Auth
 */
const supabaseWithToken = (accessToken) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

module.exports = { supabaseAdmin, supabaseClient, supabaseWithToken };
