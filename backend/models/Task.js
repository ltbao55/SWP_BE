const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  datasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    required: true
  },
  subtopicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subtopic',
    required: false
  },
  annotatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataItem: {
    filename: String,
    path: String,
    mimeType: String
  },
  status: {
    type: String,
    enum: ['assigned', 'in_progress', 'completed', 'submitted', 'approved', 'rejected', 'revised'],
    default: 'assigned'
  },
  labels: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Labels available for this task (loaded from Dataset → Subtopic → LabelSet)
  availableLabels: [{
    name: { type: String, required: true },
    color: { type: String, default: '#3b82f6' },
    description: { type: String, default: '' },
    shortcut: { type: String, default: '' }
  }],
  // Multi-annotator consensus fields (non-breaking, optional)
  annotatorLabels: [
    {
      annotatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      labels: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
      },
      submittedAt: Date,
      taskId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task'
      }
    }
  ],
  consensusLabel: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  consensusScore: {
    type: Number,
    min: 0,
    max: 1,
    default: null
  },
  consensusMeta: {
    method: {
      type: String,
      enum: ['majority_vote', 'manual', 'none'],
      default: 'none'
    },
    winningVotes: {
      type: Number,
      default: 0
    },
    totalVotes: {
      type: Number,
      default: 0
    },
    isTie: {
      type: Boolean,
      default: false
    },
    needsReview: {
      type: Boolean,
      default: false
    },
    decidedAt: Date
  },
  sentenceFeedbacks: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  submittedAt: {
    type: Date
  },
  reviewedAt: {
    type: Date
  },
  reviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewers: [
    {
      reviewerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
      },
      comment: String,
      reviewedAt: Date
    }
  ],
  reviewNotes: [
    {
      bbox: [Number],
      label: String,
      comment: String,
      createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }
  ],
  reviewComments: {
    type: String
  },
  errorCategory: {
    type: String
  },
  // Store detailed issues when rejecting a task
  reviewIssues: [
    {
      type: {
        type: String,
        required: true
      },
      typeId: String,
      targetId: {
        type: String,
        default: null
      },
      targetDetails: {
        id: String,
        label: String,
        index: Number
      },
      comment: {
        type: String,
        default: null
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }
  ],
  primaryForItem: {
    type: Boolean,
    default: false
  },
  primarySelectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  primarySelectedAt: {
    type: Date
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

module.exports = mongoose.model('Task', taskSchema);
