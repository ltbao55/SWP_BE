const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  questions: [{
    question: {
      type: String,
      required: true
    },
    options: [{
      key: String, // 'A', 'B', etc.
      value: String, // Text of the option
    }],
    required: {
      type: Boolean,
      default: true
    }
  }],
  guidelines: {
    type: String,
    required: true
  },
  reviewPolicy: {
    mode: {
      type: String,
      enum: ['full', 'sample'],
      default: 'full'
    },
    sampleRate: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.1
    },
    reviewersPerItem: {
      type: Number,
      min: 1,
      max: 10,
      default: 3
    }
  },
  status: {
    type: String,
    enum: [
      'draft',           // Chua bat dau
      'active',         // Dang hoat dong
      'in_review',      // Dang duoc review (co task submitted)
      'waiting_rework', // Co task bi reject, cho annotator lam lai
      'finalizing',     // Dang tinh toan finalize
      'completed',      // Da hoan thanh
      'archived'        // Da dong
    ],
    default: 'draft'
  },
  deadline: {
    type: Date
  },
  exportFormat: {
    type: String,
    enum: ['YOLO', 'VOC', 'COCO', 'JSON', 'CSV'],
    default: 'JSON'
  },

  // === REVIEW SUMMARY FIELDS ===
  totalTasks: {
    type: Number,
    default: 0
  },
  reviewedTasks: {
    type: Number,
    default: 0
  },

  projectReview: {
    status: {
      type: String,
      enum: ['pending', 'in_review', 'approved', 'rejected', 'expired'],
      default: 'pending'
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedAt: Date,
    comment: {
      type: String,
      default: ''
    },
    approvalRate: {
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
    expiredTasks: {
      type: Number,
      default: 0
    },
    pendingTasks: {
      type: Number,
      default: 0
    }
  },

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Project', projectSchema);
