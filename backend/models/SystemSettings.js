const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema({
  // Email Configuration
  email: {
    enabled: {
      type: Boolean,
      default: false
    },
    smtpHost: {
      type: String,
      default: ''
    },
    smtpPort: {
      type: Number,
      default: 587
    },
    smtpUser: {
      type: String,
      default: ''
    },
    smtpPassword: {
      type: String,
      default: ''
    },
    fromEmail: {
      type: String,
      default: ''
    },
    fromName: {
      type: String,
      default: 'Data Labeling System'
    }
  },
  
  // Storage & File Limits
  storage: {
    maxFileSize: {
      type: Number,
      default: 10485760, // 10MB in bytes
      required: true
    },
    maxFilesPerDataset: {
      type: Number,
      default: 100,
      required: true
    },
    allowedFileTypes: {
      type: [String],
      default: ['image/jpeg', 'image/png', 'image/jpg', 'image/gif', 'image/webp']
    },
    storageLimitPerProject: {
      type: Number,
      default: 1073741824 // 1GB in bytes
    }
  },
  
  // Task Configuration
  tasks: {
    maxTasksPerAnnotator: {
      type: Number,
      default: 100
    },
    autoAssignEnabled: {
      type: Boolean,
      default: false
    },
    defaultTaskStatus: {
      type: String,
      enum: ['assigned', 'in_progress'],
      default: 'assigned'
    }
  },
  
  // Review Configuration
  review: {
    requireReviewComments: {
      type: Boolean,
      default: true
    },
    autoApproveAfterDays: {
      type: Number,
      default: 0 // 0 means disabled
    },
    maxRejectionsBeforeEscalation: {
      type: Number,
      default: 3
    }
  },
  
  // System General Settings
  general: {
    siteName: {
      type: String,
      default: 'Team8-WDP'
    },
    maintenanceMode: {
      type: Boolean,
      default: false
    },
    maintenanceMessage: {
      type: String,
      default: 'System is under maintenance. Please check back later.'
    },
    allowRegistration: {
      type: Boolean,
      default: true
    },
    defaultUserRole: {
      type: String,
      enum: ['annotator', 'reviewer'],
      default: 'annotator'
    }
  },
  
  // Notification Settings
  notifications: {
    emailOnTaskAssigned: {
      type: Boolean,
      default: false
    },
    emailOnTaskSubmitted: {
      type: Boolean,
      default: false
    },
    emailOnTaskReviewed: {
      type: Boolean,
      default: false
    },
    emailOnTaskRejected: {
      type: Boolean,
      default: true
    }
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

// Ensure only one settings document exists
systemSettingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
