const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  action: {
    type: String,
    required: true,
    enum: [
      'login', 'logout',
      'project_create', 'project_update', 'project_delete',
      'task_assign', 'task_label', 'task_submit', 'task_approve', 'task_reject',
      'dataset_upload', 'dataset_delete',
      'user_create', 'user_update', 'user_delete', 'user_activate', 'user_deactivate',
      'export_data'
    ]
  },
  resourceType: {
    type: String,
    enum: ['project', 'task', 'dataset', 'user', 'system']
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId
  },
  description: {
    type: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster queries
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ resourceType: 1, resourceId: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
