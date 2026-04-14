const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
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
    enum: ['approval_streak', 'high_quality', 'fast_completion', 'no_errors', 'improvement', 'bonus_task'],
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  scoreBonus: {
    type: Number,
    default: 0,
    min: 0
  },
  relatedTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  },
  relatedProjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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
rewardSchema.index({ userId: 1, createdAt: -1 });
rewardSchema.index({ type: 1 });

module.exports = mongoose.model('Reward', rewardSchema);
