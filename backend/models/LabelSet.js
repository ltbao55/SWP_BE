const mongoose = require('mongoose');
const labelSetSchema = new mongoose.Schema({
  subtopicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subtopic', required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  labels: [{
    name: { type: String, required: true },
    color: { type: String, default: '#3b82f6' },
    description: { type: String, default: '' },
    shortcut: { type: String, default: '' },
  }],
  allowMultiple: { type: Boolean, default: false },
  required: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
labelSetSchema.index({ subtopicId: 1 });
labelSetSchema.index({ managerId: 1 });
labelSetSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
module.exports = mongoose.model('LabelSet', labelSetSchema);