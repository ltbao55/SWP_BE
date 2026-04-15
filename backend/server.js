/**
 * Data Labeling Support System — Express Server
 * Stack: Node.js + Express + Supabase (PostgreSQL, Auth, Storage)
 */

const express      = require('express');
const cors         = require('cors');
const dotenv       = require('dotenv');
const path         = require('path');
const cron         = require('node-cron');
const os           = require('os');
const swaggerUi    = require('swagger-ui-express');
const swaggerSpec  = require('./config/swagger');

dotenv.config();

const { supabaseAdmin } = require('./config/supabase');
const { logActivity }   = require('./utils/activityLogger');

const app = express();

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',').map((o) => o.trim());
const allowAllOrigins = allowedOrigins.includes('*');

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin "${origin}" not allowed.`));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Request logger (dev) ──────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Swagger UI ────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Data Labeling API Docs',
  swaggerOptions: {
    persistAuthorization: true,   // keep Bearer token across page refreshes
    filter: true,                 // enable tag/search filtering
  },
}));
// Raw OpenAPI JSON spec (useful for code generation)
app.get('/api-docs.json', (_req, res) => res.json(swaggerSpec));
console.log('   Swagger UI: /api-docs');

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/projects',      require('./routes/projects'));
app.use('/api/datasets',      require('./routes/datasets'));
app.use('/api/tasks',         require('./routes/tasks'));
app.use('/api/reviews',       require('./routes/reviews'));
app.use('/api/activity-logs', require('./routes/activityLogs'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/ai',            require('./routes/ai'));
app.use('/api/topics',        require('./routes/topics'));
app.use('/api/subtopics',     require('./routes/subtopics'));

// ── System Health ─────────────────────────────────────────────
/**
 * @swagger
 * /api/admin/system-health:
 *   get:
 *     summary: System health check
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: System status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 server:   { type: object }
 *                 database: { type: object }
 *                 storage:  { type: object }
 *                 memory:   { type: object }
 */
app.get('/api/admin/system-health', async (_req, res) => {
  try {
    const totalMem = os.totalmem();
    const usedMem  = totalMem - os.freemem();

    // Quick Supabase connectivity check
    const { error: dbError } = await supabaseAdmin.from('system_settings').select('id').limit(1);

    res.json({
      server: {
        status:      'running',
        uptime:      process.uptime(),
        version:     '2.0.0',
        node_version: process.version,
        environment: process.env.NODE_ENV,
      },
      database: {
        status:   dbError ? 'error' : 'connected',
        provider: 'supabase-postgresql',
        error:    dbError?.message || null,
      },
      storage: {
        provider: 'supabase-storage',
        bucket:   process.env.STORAGE_BUCKET || 'datasets',
      },
      memory: {
        used_mb:    Math.round(usedMem / 1024 / 1024),
        total_mb:   Math.round(totalMem / 1024 / 1024),
        percentage: Math.round((usedMem / totalMem) * 100),
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route "${req.method} ${req.path}" not found.` });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error.',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Serve React build in production ──────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  app.get('*', (_req, res) =>
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'))
  );
}

// ============================================================
// CRON: Auto-finalize expired projects (every 5 minutes)
// ============================================================
const autoFinalizeExpiredProjects = async () => {
  try {
    const now = new Date().toISOString();

    // Find active projects past deadline
    const { data: expiredProjects, error } = await supabaseAdmin
      .from('projects')
      .select('id, name, manager_id')
      .lt('deadline', now)
      .not('status', 'in', '("completed","archived")');

    if (error || !expiredProjects || expiredProjects.length === 0) return;

    for (const project of expiredProjects) {
      // Skip if already finalized
      const { data: existing } = await supabaseAdmin
        .from('projects').select('project_review').eq('id', project.id).single();
      if (existing?.project_review?.status && ['approved','rejected','expired'].includes(existing.project_review.status)) continue;

      // Mark still-pending submitted tasks as expired
      await supabaseAdmin.from('tasks')
        .update({ status: 'expired' })
        .eq('project_id', project.id)
        .in('status', ['submitted', 'resubmitted']);

      // Get final stats
      const { data: stats } = await supabaseAdmin
        .from('project_task_stats').select('*').eq('project_id', project.id).single();

      const approvalRate = parseFloat(stats?.approval_rate || 0);
      const finalStatus  = approvalRate >= 70 ? 'approved' : 'rejected';

      const projectReview = {
        status:        finalStatus,
        reviewed_by:   null, // system
        reviewed_at:   now,
        comment:       `Auto-finalized on deadline (${finalStatus}). Approval rate: ${approvalRate}%.`,
        approval_rate: approvalRate,
        approved_tasks: stats?.approved_tasks || 0,
        total_tasks:    stats?.total_tasks || 0,
      };

      await supabaseAdmin.from('projects').update({
        status:         'completed',
        project_review: projectReview,
      }).eq('id', project.id);

      await logActivity({
        userId:       null,
        action:       `project_auto_${finalStatus}`,
        resourceType: 'project',
        resourceId:   project.id,
        description:  `[CRON] Project "${project.name}" auto-${finalStatus}. Rate: ${approvalRate}%`,
        metadata:     { approvalRate, ...stats },
      });

      console.log(`[CRON] Auto-${finalStatus}: Project "${project.name}" (rate: ${approvalRate}%)`);
    }
  } catch (err) {
    console.error('[CRON] autoFinalizeExpiredProjects error:', err.message);
  }
};

// Run on startup + every 5 minutes
autoFinalizeExpiredProjects();
cron.schedule('*/5 * * * *', autoFinalizeExpiredProjects);
console.log('[CRON] Auto-finalize scheduler started (every 5 min)');

// ── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`   Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`   Health: http://localhost:${PORT}/api/admin/system-health\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Run this to free it (PowerShell):`);
    console.error(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
