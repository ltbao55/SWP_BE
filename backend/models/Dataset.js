const mongoose = require('mongoose');

const datasetSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['image', 'text', 'audio'],
    default: 'image'
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: false
  },
  subtopicId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subtopic',
    required: false
  },
  subtopicIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subtopic'
  }],
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true // Required to track who owns the dataset
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  files: [{
    filename: String,
    originalName: String,
    path: String,
    mimeType: String,
    size: Number,
    subtopicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subtopic',
      required: false
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  totalItems: {
    type: Number,
    default: 0
  },
  imageCount: {
    type: Number,
    default: 0
  },
  labelsets: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabelSet'
  }],
  status: {
    type: String,
    enum: ['draft', 'labeling', 'review', 'completed'],
    default: 'draft'
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

module.exports = mongoose.model('Dataset', datasetSchema);
