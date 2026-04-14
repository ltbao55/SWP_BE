const express = require('express');
const router = express.Router();
const LabelSet = require('../models/LabelSet');
const { auth, authorize } = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.subtopicId) filter.subtopicId = req.query.subtopicId;
    if (req.user.role !== 'admin') filter.managerId = req.user._id;
    const labelSets = await LabelSet.find(filter).populate('subtopicId', 'name topicId');
    res.json(labelSets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const labelSet = await LabelSet.findById(req.params.id).populate('subtopicId', 'name topicId');
    if (!labelSet) return res.status(404).json({ error: 'LabelSet not found' });
    res.json(labelSet);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const labelSet = new LabelSet({ ...req.body, managerId: req.user._id });
    await labelSet.save();
    res.status(201).json(labelSet);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const labelSet = await LabelSet.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!labelSet) return res.status(404).json({ error: 'LabelSet not found' });
    res.json(labelSet);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', auth, authorize('manager', 'admin'), async (req, res) => {
  try {
    const labelSet = await LabelSet.findByIdAndDelete(req.params.id);
    if (!labelSet) return res.status(404).json({ error: 'LabelSet not found' });
    res.json({ message: 'LabelSet deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;