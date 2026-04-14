/**
 * Centralised Activity Logger
 * Writes to the activity_logs table using the service-role client (bypasses RLS).
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Log an action to activity_logs.
 *
 * @param {object} opts
 * @param {string|null}  opts.userId       - UUID of the acting user (null = system)
 * @param {string}       opts.action       - e.g. 'login', 'task_submit', 'project_create'
 * @param {string}       opts.resourceType - 'project' | 'task' | 'dataset' | 'user' | 'system' | 'label_set'
 * @param {string|null}  opts.resourceId   - UUID of the affected resource
 * @param {string}       opts.description  - Human-readable description
 * @param {object}       [opts.metadata]   - Extra structured data
 * @param {object|null}  [opts.req]        - Express request (for IP / userAgent)
 */
const logActivity = async ({
  userId,
  action,
  resourceType,
  resourceId = null,
  description,
  metadata = {},
  req = null,
}) => {
  try {
    await supabaseAdmin.from('activity_logs').insert({
      user_id:       userId || null,
      action,
      resource_type: resourceType,
      resource_id:   resourceId || null,
      description,
      metadata,
      ip_address:    req ? (req.ip || req.headers['x-forwarded-for'] || null) : null,
      user_agent:    req ? (req.headers['user-agent'] || null) : null,
    });
  } catch (err) {
    // Never let logging errors break the main flow
    console.error('[activityLogger] Failed to write log:', err.message);
  }
};

module.exports = { logActivity };
