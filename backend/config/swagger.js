/**
 * Swagger / OpenAPI 3.0 configuration
 * UI available at: http://localhost:5000/api-docs
 */

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Data Labeling Support System API',
      version: '2.0.0',
      description:
        'REST API for the Data Labeling Support System. Authenticate via **POST /api/auth/login**, copy the `access_token`, then click **Authorize** and enter `Bearer <token>`.',
    },
    servers: [
      { url: 'https://swp-be-3x8u.onrender.com', description: 'Production (Render)' },
      { url: 'http://localhost:5000',            description: 'Local development' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        // ── Common ────────────────────────────────────────────────
        Error: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            error:   { type: 'string' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            page:  { type: 'integer' },
            limit: { type: 'integer' },
          },
        },

        // ── Auth ──────────────────────────────────────────────────
        AuthTokens: {
          type: 'object',
          properties: {
            access_token:  { type: 'string' },
            refresh_token: { type: 'string' },
            expires_in:    { type: 'integer' },
          },
        },

        // ── User / Profile ────────────────────────────────────────
        UserProfile: {
          type: 'object',
          properties: {
            id:         { type: 'string', format: 'uuid' },
            email:      { type: 'string', format: 'email' },
            username:   { type: 'string' },
            full_name:  { type: 'string' },
            role:       { type: 'string', enum: ['admin', 'manager', 'annotator', 'reviewer'] },
            specialty:  { type: 'string' },
            is_active:  { type: 'boolean' },
            avatar_url: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },

        // ── Project ───────────────────────────────────────────────
        Project: {
          type: 'object',
          properties: {
            id:            { type: 'string', format: 'uuid' },
            name:          { type: 'string' },
            description:   { type: 'string' },
            guidelines:    { type: 'string' },
            status:        { type: 'string', enum: ['draft','active','in_review','waiting_rework','finalizing','completed','archived'] },
            deadline:      { type: 'string', format: 'date-time', nullable: true },
            export_format: { type: 'string', enum: ['JSON','CSV','COCO','YOLO','VOC'] },
            review_policy: { type: 'object' },
            total_tasks:   { type: 'integer' },
            project_review:{ type: 'object', nullable: true },
            created_at:    { type: 'string', format: 'date-time' },
            manager:       { $ref: '#/components/schemas/UserProfile' },
          },
        },

        // ── Dataset ───────────────────────────────────────────────
        Dataset: {
          type: 'object',
          properties: {
            id:          { type: 'string', format: 'uuid' },
            name:        { type: 'string' },
            description: { type: 'string' },
            type:        { type: 'string', enum: ['image','text','audio','video'] },
            status:      { type: 'string', enum: ['draft','labeling','review','completed'] },
            total_items: { type: 'integer' },
            created_at:  { type: 'string', format: 'date-time' },
            manager:     { $ref: '#/components/schemas/UserProfile' },
          },
        },

        // ── Task ──────────────────────────────────────────────────
        Task: {
          type: 'object',
          properties: {
            id:              { type: 'string', format: 'uuid' },
            status:          { type: 'string', enum: ['assigned','in_progress','submitted','resubmitted','approved','rejected','expired'] },
            annotation_data: { type: 'object', nullable: true },
            review_comments: { type: 'string', nullable: true },
            error_category:  { type: 'string', nullable: true },
            submitted_at:    { type: 'string', format: 'date-time', nullable: true },
            reviewed_at:     { type: 'string', format: 'date-time', nullable: true },
            created_at:      { type: 'string', format: 'date-time' },
            project:         { $ref: '#/components/schemas/Project' },
            annotator:       { $ref: '#/components/schemas/UserProfile' },
            reviewer:        { $ref: '#/components/schemas/UserProfile' },
          },
        },

        // ── Label ─────────────────────────────────────────────────
        Label: {
          type: 'object',
          properties: {
            id:          { type: 'string', format: 'uuid' },
            name:        { type: 'string' },
            color:       { type: 'string', description: 'Hex color, e.g. #FF0000' },
            description: { type: 'string', nullable: true },
            shortcut:    { type: 'string', nullable: true },
            sort_order:  { type: 'integer' },
          },
        },

        // ── Label Set ─────────────────────────────────────────────
        LabelSet: {
          type: 'object',
          properties: {
            id:             { type: 'string', format: 'uuid' },
            name:           { type: 'string' },
            description:    { type: 'string', nullable: true },
            allow_multiple: { type: 'boolean' },
            required:       { type: 'boolean' },
            labels:         { type: 'array', items: { $ref: '#/components/schemas/Label' } },
          },
        },
      },
    },
    // Apply Bearer auth globally — individual routes can override
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth',          description: 'Authentication & session management' },
      { name: 'Users',         description: 'User profile management' },
      { name: 'Projects',      description: 'Project lifecycle management' },
      { name: 'Datasets',      description: 'Dataset & file management' },
      { name: 'Tasks',         description: 'Annotation task workflow' },
      { name: 'Reviews',       description: 'Review & approval workflow' },
      { name: 'Activity Logs', description: 'Audit trail (admin only)' },
      { name: 'Settings',      description: 'System settings (admin only)' },
      { name: 'AI',            description: 'AI-assisted pre-labeling (Google Gemini)' },
      { name: 'Health',        description: 'System health check' },
    ],
  },
  // Scan all route files for JSDoc @swagger annotations
  apis: ['./routes/*.js', './server.js'],
};

module.exports = swaggerJsdoc(options);
