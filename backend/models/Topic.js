const mongoose = require('mongoose');
const topicSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  color: { type: String, default: '#3b82f6' },
  icon: { type: String, default: 'folder' },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
topicSchema.index({ managerId: 1, status: 1 });
topicSchema.index({ order: 1 });
topicSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
module.exports = mongoose.model('Topic', topicSchema);