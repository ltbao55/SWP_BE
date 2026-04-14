const mongoose = require('mongoose');

const warningSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['annotator', 'reviewer'],
    required: true
  },
  type: {
    type: String,
    enum: ['first_time', 'repeat', 'escalation'],
    default: 'first_time'
  },
  reason: {
    type: String,
    required: true
  },
  relatedTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  },
  relatedProjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  requiresAction: {
    type: Boolean,
    default: true
  },
  actionTaken: {
    type: Boolean,
    default: false
  },
  actionTakenAt: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
warningSchema.index({ userId: 1, createdAt: -1 });
warningSchema.index({ isRead: 1 });
warningSchema.index({ requiresAction: 1 });

module.exports = mongoose.model('Warning', warningSchema);
