const express = require('express');
const { body, validationResult } = require('express-validator');
const Task = require('../models/Task');
const Project = require('../models/Project');
const { auth, authorize } = require('../middleware/auth');
const { createActivityLog } = require('./activityLogs');

const router = express.Router();

const isTaskOverdue = (task) => {
  const deadline = task?.projectId?.deadline;
  if (!deadline) return false;
  const deadlineDate = new Date(deadline);
  if (Number.isNaN(deadlineDate.getTime())) return false;
  return deadlineDate < new Date();
};

const applyMajorityDecision = (task) => {
  const votes = Array.isArray(task.reviewers) ? task.reviewers : [];
  const approveCount = votes.filter((r) => r.status === 'approved').length;
  const rejectCount = votes.filter((r) => r.status === 'rejected').length;
  const decidedCount = approveCount + rejectCount;
  const totalReviewers = votes.length;

  if (totalReviewers === 0) {
    return {
      finalized: true,
      finalStatus: task.status || 'submitted',
      winningVote: task.status === 'rejected' ? 'rejected' : 'approved',
      approveCount,
      rejectCount,
      decidedCount,
      totalReviewers,
    };
  }

  // Require all assigned reviewers to vote before finalizing.
  // This ensures manager-assigned reviewers all see and can grade the task.
  if (decidedCount < totalReviewers) {
    return {
      finalized: false,
      finalStatus: 'submitted',
      winningVote: null,
      approveCount,
      rejectCount,
      decidedCount,
      totalReviewers,
    };
  }

  if (approveCount > rejectCount) {
    return {
      finalized: true,
      finalStatus: 'approved',
      winningVote: 'approved',
      approveCount,
      rejectCount,
      decidedCount,
      totalReviewers,
    };
  }

  // Tie or reject majority => rejected
  return {
    finalized: true,
    finalStatus: 'rejected',
    winningVote: 'rejected',
    approveCount,
    rejectCount,
    decidedCount,
    totalReviewers,
  };
};

// Get tasks pending review
router.get('/pending', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();

    const tasks = await Task.find({
      status: 'submitted',
      $or: [
        {
          reviewers: {
            $elemMatch: {
              reviewerId: { $in: [reviewerId, reviewerIdString] },
              status: 'pending',
            },
          },
        },
        {
          $and: [
            {
          $and: [
            { reviewerId: { $in: [reviewerId, reviewerIdString] } },
            {
              $or: [
                { reviewers: { $exists: false } },
                { reviewers: { $size: 0 } },
              ],
            },
          ],
        },
            {
              $or: [
                { reviewers: { $exists: false } },
                { reviewers: { $size: 0 } },
              ],
            },
          ],
        },
        { reviewers: { $exists: true, $size: 0 } },
        { reviewers: { $exists: false } },
      ],
    })
      .populate('projectId', 'name labelSet guidelines questions deadline')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .populate('reviewers.reviewerId', 'username fullName')
      .sort({ submittedAt: 1 });

    const actionableTasks = tasks.filter((t) => !isTaskOverdue(t));
    res.json(actionableTasks);
  } catch (error) {
    console.error('Error in /api/reviews/pending:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all reviewed tasks (approved/rejected)
router.get('/reviewed', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();

    const tasks = await Task.find({
      status: { $in: ['approved', 'rejected'] },
      $or: [
        { reviewerId: { $in: [reviewerId, reviewerIdString] } },
        {
          reviewers: {
            $elemMatch: {
              reviewerId: { $in: [reviewerId, reviewerIdString] },
              status: { $in: ['approved', 'rejected'] },
            },
          },
        },
      ],
    })
      .populate('projectId', 'name labelSet guidelines questions')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .populate('reviewerId', 'username fullName')
      .sort({ reviewedAt: -1 });

    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all tasks for reviewer (pending + reviewed)
router.get('/all', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();

    // Find ALL tasks where this reviewer is in the reviewers array (regardless of task status)
    // This ensures reviewer sees tasks assigned to them even if not yet submitted
    const allTasks = await Task.find({
      'reviewers.reviewerId': { $in: [reviewerId, reviewerIdString] },
    })
      .populate('projectId', 'name labelSet guidelines questions deadline')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .populate('reviewers.reviewerId', 'username fullName')
      .populate('reviewerId', 'username fullName')
      .sort({ submittedAt: 1 });

    // Also find tasks where reviewerId field matches (project-level reviewer)
    const reviewerIdTasks = await Task.find({
      reviewerId: { $in: [reviewerId, reviewerIdString] },
    })
      .populate('projectId', 'name labelSet guidelines questions deadline')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .populate('reviewers.reviewerId', 'username fullName')
      .populate('reviewerId', 'username fullName')
      .sort({ submittedAt: 1 });

    // Merge and deduplicate
    const taskMap = new Map();
    [...allTasks, ...reviewerIdTasks].forEach((t) => {
      taskMap.set(t._id.toString(), t);
    });
    const mergedTasks = Array.from(taskMap.values());

    // Separate into pending (still needs review) and reviewed (already decided)
    const pendingTasks = mergedTasks.filter((t) => {
      return ['submitted', 'assigned', 'in_progress', 'completed', 'revised'].includes(t.status);
    });

    const reviewedTasks = mergedTasks.filter((t) => {
      return ['approved', 'rejected'].includes(t.status);
    });

    res.json({ pending: pendingTasks, reviewed: reviewedTasks });
  } catch (error) {
    console.error('Error in /api/reviews/all:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Reviewer overview: include assigned/not-submitted + submitted + reviewed
router.get('/overview', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();

    const reviewerAssignedQuery = {
      $or: [
        {
          reviewers: {
            $elemMatch: {
              reviewerId: { $in: [reviewerId, reviewerIdString] },
            },
          },
        },
        { reviewerId: { $in: [reviewerId, reviewerIdString] } },
      ],
    };

    const tasks = await Task.find(reviewerAssignedQuery)
      .populate('projectId', 'name deadline projectReview')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .sort({ updatedAt: -1 });

    res.json({ tasks });
  } catch (error) {
    console.error('Error in /api/reviews/overview:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Set primary item for dataset (reviewer)
router.post('/:id/primary', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    if (task.status !== 'approved') {
      return res.status(400).json({ message: 'Chỉ được chọn ảnh chính cho task đã approved.' });
    }

    const mimeType = (task?.dataItem?.mimeType || '').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      return res.status(400).json({ message: 'Chỉ task image mới được đặt Primary.' });
    }

    // Clear other primary selections for same raw item in this dataset
    const primaryMatch = {
      _id: { $ne: task._id },
      datasetId: task.datasetId,
      primaryForItem: true,
    };

    if (task.dataItem?.path) {
      primaryMatch['dataItem.path'] = task.dataItem.path;
    } else if (task.dataItem?.filename) {
      primaryMatch['dataItem.filename'] = task.dataItem.filename;
    }

    await Task.updateMany(primaryMatch, { $set: { primaryForItem: false } });

    task.primaryForItem = true;
    task.primarySelectedBy = req.user._id;
    task.primarySelectedAt = new Date();
    await task.save();

    res.json({ message: 'Đã đặt ảnh chính cho item.', taskId: task._id });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Approve task
router.post('/:id/approve', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate('projectId', 'name guidelines deadline');
    if (!task) return res.status(404).json({ message: 'Task not found' });

    if (task.status !== 'submitted') {
      return res.status(400).json({
        message: `Task cannot be approved. Current status: ${task.status}. Only submitted tasks can be approved.`,
      });
    }

    if (isTaskOverdue(task)) {
      return res.status(400).json({
        message: 'Task đã quá hạn deadline project, reviewer không thể review nữa.',
      });
    }

    if (!task.labels || Object.keys(task.labels).length === 0) {
      return res.status(400).json({ message: 'Cannot approve task without labels' });
    }

    if (task.reviewers && task.reviewers.length > 0) {
      const assigned = task.reviewers.find((r) => r.reviewerId?.toString() === req.user._id.toString());
      if (!assigned) return res.status(403).json({ message: 'You are not assigned to review this task' });
      if (assigned.status !== 'pending') {
        return res.status(400).json({ message: 'You have already submitted your review decision for this task' });
      }

      assigned.status = 'approved';
      assigned.reviewedAt = new Date();
      assigned.comment = req.body.reviewComments || assigned.comment;
    }

    const decision = applyMajorityDecision(task);
    const now = new Date();

    // Persist shared output only when final decision is reached.
    if (decision.finalized && decision.winningVote === 'approved') {
      if (req.body.reviewComments) task.reviewComments = req.body.reviewComments;
      if (Array.isArray(req.body.reviewNotes)) {
        task.reviewNotes = req.body.reviewNotes.map((n) => ({
          ...n,
          createdBy: req.user._id,
          createdAt: now,
        }));
      }
    }

    task.status = decision.finalStatus;
    task.updatedAt = now;

    if (decision.finalized) {
      task.reviewedAt = now;
      task.reviewerId = req.user._id;
    }

    await task.save();
    await task.populate('annotatorId', 'username fullName');
    await task.populate('reviewerId', 'username fullName');

    await createActivityLog(
      req.user._id,
      'task_approve',
      'task',
      task._id,
      `Reviewed task (approve vote) submitted by ${task.annotatorId?.fullName || task.annotatorId?.username}`,
      {
        taskId: task._id.toString(),
        annotatorId: task.annotatorId?._id?.toString() || task.annotatorId?.toString(),
        finalStatus: task.status,
        votes: {
          approve: decision.approveCount,
          reject: decision.rejectCount,
          decided: decision.decidedCount,
          total: decision.totalReviewers,
        },
      },
      req
    );

    res.json(task);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Reject task
router.post(
  '/:id/reject',
  auth,
  authorize('reviewer', 'admin'),
  [
    body('reviewComments').trim().notEmpty().withMessage('Review comments are required when rejecting a task'),
    body('errorCategory').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const task = await Task.findById(req.params.id).populate('projectId', 'name guidelines deadline');
      if (!task) return res.status(404).json({ message: 'Task not found' });

      if (task.status !== 'submitted') {
        return res.status(400).json({
          message: `Task cannot be rejected. Current status: ${task.status}. Only submitted tasks can be rejected.`,
        });
      }

      if (isTaskOverdue(task)) {
        return res.status(400).json({
          message: 'Task đã quá hạn deadline project, reviewer không thể review nữa.',
        });
      }

      if (!req.body.reviewComments || req.body.reviewComments.trim() === '') {
        return res.status(400).json({ message: 'Review comments are required when rejecting a task' });
      }

      const validErrorCategories = [
        'incorrect_label',
        'missing_label',
        'poor_quality',
        'does_not_follow_guidelines',
        'other',
      ];
      if (req.body.errorCategory && !validErrorCategories.includes(req.body.errorCategory)) {
        return res.status(400).json({
          message: `Invalid error category. Valid categories are: ${validErrorCategories.join(', ')}`,
        });
      }

      if (task.reviewers && task.reviewers.length > 0) {
        const assigned = task.reviewers.find((r) => r.reviewerId?.toString() === req.user._id.toString());
        if (!assigned) return res.status(403).json({ message: 'You are not assigned to review this task' });
        if (assigned.status !== 'pending') {
          return res.status(400).json({ message: 'You have already submitted your review decision for this task' });
        }

        assigned.status = 'rejected';
        assigned.reviewedAt = new Date();
        assigned.comment = req.body.reviewComments.trim();
      }

      const decision = applyMajorityDecision(task);
      const now = new Date();

      if (decision.finalized && decision.winningVote === 'rejected') {
        if (Array.isArray(req.body.reviewNotes) && req.body.reviewNotes.length > 0) {
          task.reviewNotes = req.body.reviewNotes.map((n) => ({
            ...n,
            createdBy: req.user._id,
            createdAt: now,
          }));
        } else {
          task.reviewNotes = [];
        }

        task.reviewComments = req.body.reviewComments.trim();
        task.errorCategory = req.body.errorCategory || 'other';
        
        // Save detailed review issues
        if (req.body.review && Array.isArray(req.body.review.issues)) {
          task.reviewIssues = req.body.review.issues.map(issue => ({
            type: issue.type,
            typeId: issue.typeId,
            targetId: issue.targetId,
            targetDetails: issue.targetDetails || null,
            comment: issue.comment,
            createdAt: now
          }));
        }
      }

      task.status = decision.finalStatus;
      task.updatedAt = now;

      if (decision.finalized) {
        task.reviewedAt = now;
        task.reviewerId = req.user._id;
      }

      await task.save();
    
      await task.populate('annotatorId', 'username fullName');
      await task.populate('reviewerId', 'username fullName');

      await createActivityLog(
        req.user._id,
        'task_reject',
        'task',
        task._id,
        `Reviewed task (reject vote) submitted by ${task.annotatorId?.fullName || task.annotatorId?.username}`,
        {
          taskId: task._id.toString(),
          annotatorId: task.annotatorId?._id?.toString() || task.annotatorId?.toString(),
          errorCategory: task.errorCategory,
          finalStatus: task.status,
          votes: {
            approve: decision.approveCount,
            reject: decision.rejectCount,
            decided: decision.decidedCount,
            total: decision.totalReviewers,
          },
        },
        req
      );

      res.json(task);
    } catch (error) {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// Get review statistics
router.get('/stats', auth, authorize('reviewer', 'manager', 'admin'), async (req, res) => {
  try {
    const stats = await Task.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const errorStats = await Task.aggregate([
      {
        $match: { errorCategory: { $exists: true, $ne: null } },
      },
      {
        $group: {
          _id: '$errorCategory',
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({ statusStats: stats, errorStats });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Handle sentence-level feedback (blind per reviewer)
router.post('/:id/sentences', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const { index, action, feedback } = req.body;

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    if (!task.sentenceFeedbacks) task.sentenceFeedbacks = {};

    const feedbackKey = `sentence_${index}_${req.user._id.toString()}`;
    task.sentenceFeedbacks[feedbackKey] = {
      action,
      feedback,
      reviewerId: req.user._id,
      reviewedAt: new Date(),
    };

    task.markModified('sentenceFeedbacks');
    await task.save();

    res.json({
      message: `Sentence ${index} marked as ${action}`,
      sentenceFeedbacks: task.sentenceFeedbacks,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get projects where this reviewer is assigned (via tasks or project-level reviewerId)
router.get('/projects', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();

    // Find tasks where reviewer is in reviewers array
    const reviewerTasks = await Task.find({
      'reviewers.reviewerId': { $in: [reviewerId, reviewerIdString] },
    }).select('projectId').lean();

    const projectIdsFromTasks = reviewerTasks.map((t) => t.projectId);

    // Also find projects where reviewerId field matches (project-level reviewer)
    const projectsWithReviewerId = await Project.find({
      $or: [
        { reviewerId: { $in: [reviewerId, reviewerIdString] } },
        { _id: { $in: projectIdsFromTasks } },
      ],
    })
      .populate('managerId', 'username fullName email')
      .sort({ updatedAt: -1 });

    res.json(projectsWithReviewerId);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get tasks with deadline info for reviewer (due soon + overdue)
router.get('/tasks/deadline', auth, authorize('reviewer', 'admin'), async (req, res) => {
  try {
    const reviewerId = req.user._id;
    const reviewerIdString = reviewerId.toString();
    const now = new Date();

    // Tasks still not finalized (pending review, in progress, assigned, completed, revised)
    const activeStatuses = ['submitted', 'assigned', 'in_progress', 'completed', 'revised'];

    const tasks = await Task.find({
      status: { $in: activeStatuses },
      $or: [
        { reviewerId: { $in: [reviewerId, reviewerIdString] } },
        {
          reviewers: {
            $elemMatch: {
              reviewerId: { $in: [reviewerId, reviewerIdString] },
            },
          },
        },
      ],
    })
      .populate('projectId', 'name deadline')
      .populate('datasetId', 'name')
      .populate('annotatorId', 'username fullName')
      .sort({ submittedAt: 1 });

    const dueSoonTasks = [];
    const overdueTasks = [];

    tasks.forEach((task) => {
      const deadline = task.projectId?.deadline;
      if (!deadline) {
        // No deadline = neutral, add to due soon
        dueSoonTasks.push(task);
        return;
      }
      const deadlineDate = new Date(deadline);
      if (Number.isNaN(deadlineDate.getTime())) {
        dueSoonTasks.push(task);
        return;
      }

      // overdue if deadline passed
      if (deadlineDate < now) {
        overdueTasks.push(task);
      } else {
        // due within 3 days
        const threeDays = 3 * 24 * 60 * 60 * 1000;
        if (deadlineDate - now <= threeDays) {
          dueSoonTasks.push(task);
        }
        // otherwise don't show (far future)
      }
    });

    res.json({ dueSoon: dueSoonTasks, overdue: overdueTasks });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


