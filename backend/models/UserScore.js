const mongoose = require('mongoose');

const userScoreSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  role: {
    type: String,
    enum: ['annotator', 'reviewer', 'manager'],
    required: true
  },
  qualityScore: {
    type: Number,
    default: 100,
    min: 0,
    max: 100
  },
  totalTasks: {
    type: Number,
    default: 0
  },
  completedTasks: {
    type: Number,
    default: 0
  },
  approvedTasks: {
    type: Number,
    default: 0
  },
  rejectedTasks: {
    type: Number,
    default: 0
  },
  errorRate: {
    type: Number,
    default: 0, // Percentage
    min: 0,
    max: 100
  },
  currentPenaltyLevel: {
    type: String,
    enum: ['none', 'warning', 'light', 'heavy'],
    default: 'none'
  },
  isRestricted: {
    type: Boolean,
    default: false
  },
  restrictionUntil: {
    type: Date
  },
  weeklyTaskLimit: {
    type: Number,
    default: null // null = unlimited, set khi bị phạt
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient queries
userScoreSchema.index({ userId: 1 });
userScoreSchema.index({ qualityScore: -1 });
userScoreSchema.index({ role: 1 });

module.exports = mongoose.model('UserScore', userScoreSchema);
