const mongoose = require('mongoose');
const subtopicSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  topicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  parentSubtopicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subtopic', default: null },
  guideline: { type: String, default: '' },
  taskType: { type: String, enum: ['classification', 'bbox', 'ner', 'sentiment', 'multi_label'], default: 'classification' },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  assets: [{
    filename: { type: String, required: true },
    originalName: { type: String, default: '' },
    path: { type: String, required: true },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    type: { type: String, enum: ['image', 'text', 'audio', 'video', 'other'], default: 'image' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now }
  }]
});
subtopicSchema.index({ topicId: 1, status: 1 });
subtopicSchema.index({ managerId: 1 });
subtopicSchema.index({ parentSubtopicId: 1 });
subtopicSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
module.exports = mongoose.model('Subtopic', subtopicSchema);
