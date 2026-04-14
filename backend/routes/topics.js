const express = require('express');
const router = express.Router();
const Topic = require('../models/Topic');
const Subtopic = require('../models/Subtopic');
const Dataset = require('../models/Dataset');
const LabelSet = require('../models/LabelSet');
const { auth, authorize } = require('../middleware/auth');
const Project = require('../models/Project');
const Task = require('../models/Task');

const hasLockedAssignmentForTopic = async (topicId) => {
  const subtopicIds = await Subtopic.find({ topicId }).distinct('_id');
  if (!subtopicIds.length) return false;

  const datasetIds = await Dataset.find({
    $or: [
      { subtopicId: { $in: subtopicIds } },
      { subtopicIds: { $in: subtopicIds } },
    ],
  }).distinct('_id');

  if (!datasetIds.length) return false;

  const assignedTasks = await Task.find({
    datasetId: { $in: datasetIds },
    annotatorId: { $ne: null },
    $or: [
      { reviewerId: { $ne: null } },
      { 'reviewers.0': { $exists: true } },
    ],
  }).select('projectId').lean();

  const projectIds = [...new Set(assignedTasks.map(t => t.projectId?.toString()).filter(Boolean))];
  if (!projectIds.length) return false;

  const lockedProject = await Project.findOne({ _id: { $in: projectIds }, status: { $ne: 'completed' } }).select('_id').lean();
  return Boolean(lockedProject);
};

router.get('/', auth, async (req, res) => {
  try {
    const filter = { status: 'active' };
    if (req.user.role !== 'admin') filter.managerId = req.user._id;
    const topics = await Topic.find(filter).sort({ order: 1, createdAt: -1 });
    const result = await Promise.all(topics.map(async (t) => {
      const subtopicIds = await Subtopic.find({ topicId: t._id, status: 'active' }).distinct('_id');
      const subtopics = subtopicIds.length;
      const datasets = await Dataset.countDocuments({ subtopicId: { $in: subtopicIds } });
      const labels = await LabelSet.countDocuments({ subtopicId: { $in: subtopicIds } });
      return { ...t.toObject(), subtopics, datasets, labels };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const topic = await Topic.findById(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    const subtoptics = await Subtopic.find({ topicId: topic._id, status: 'active' }).sort({ order: 1 });
    res.json({ topic, subtoptics });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Tên topic không được để trống' });
    }
    // Check for duplicate name under the same manager
    const existing = await Topic.findOne({
      name: name.trim(),
      managerId: req.user._id,
      status: 'active'
    });
    if (existing) {
      return res.status(400).json({ error: 'Tên topic đã tồn tại. Vui lòng chọn tên khác.' });
    }
    const topic = new Topic({ ...req.body, name: name.trim(), managerId: req.user._id });
    await topic.save();
    res.status(201).json(topic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (name && name.trim()) {
      const existing = await Topic.findOne({
        name: name.trim(),
        managerId: req.user._id,
        status: 'active',
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({ error: 'Tên topic đã tồn tại. Vui lòng chọn tên khác.' });
      }
    }
    const topic = await Topic.findByIdAndUpdate(req.params.id, { ...req.body, name: name ? name.trim() : undefined }, { new: true, runValidators: true });
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    res.json(topic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const topic = await Topic.findById(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    if (req.user.role === 'manager') {
      const locked = await hasLockedAssignmentForTopic(topic._id);
      if (locked) {
        return res.status(400).json({
          error: 'Topic da duoc phan cong trong project dang hoat dong. Khong the xoa.',
        });
      }
    }

    const archived = await Topic.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
    res.json({ message: 'Topic archived', topic: archived });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;