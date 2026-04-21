/**
 * Task Workflow Engine
 *
 * State machine for Task status transitions.
 *
 * Valid states:
 *   pending      → not yet assigned to annotator
 *   assigned     → annotator assigned, not started
 *   in_progress  → annotator actively working
 *   submitted    → annotator submitted, awaiting first review
 *   resubmitted  → annotator re-submitted after rejection
 *   approved     → reviewer(s) approved — TERMINAL
 *   rejected     → reviewer(s) rejected, annotator must revise
 *   expired      → deadline passed before review — TERMINAL
 *
 * Allowed transitions:
 *   pending      → assigned      (manager assigns)
 *   assigned     → in_progress   (annotator starts)
 *   in_progress  → submitted     (annotator submits first time)
 *   rejected     → in_progress   (annotator resumes revision)
 *   in_progress  → resubmitted   (annotator re-submits after rejection)
 *   submitted    → approved      (reviewer approves)
 *   submitted    → rejected      (reviewer rejects)
 *   resubmitted  → approved      (reviewer approves revision)
 *   resubmitted  → rejected      (reviewer rejects again)
 *   submitted    → expired       (system cron — deadline passed)
 *   resubmitted  → expired       (system cron — deadline passed)
 */

const TRANSITIONS = {
  pending:      ['assigned'],
  assigned:     ['in_progress', 'submitted', 'resubmitted'],
  in_progress:  ['submitted', 'resubmitted'],
  rejected:     ['in_progress', 'resubmitted'],
  submitted:    ['approved', 'rejected', 'expired'],
  resubmitted:  ['approved', 'rejected', 'expired'],
  approved:     [],   // terminal
  expired:      [],   // terminal
};

/**
 * Check whether a status transition is valid.
 *
 * @param {string} from - Current status
 * @param {string} to   - Desired next status
 * @returns {boolean}
 */
const canTransition = (from, to) => {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
};

/**
 * Assert a transition is valid or throw a descriptive error.
 *
 * @param {string} from
 * @param {string} to
 * @throws {Error} if transition is not allowed
 */
const assertTransition = (from, to) => {
  if (!canTransition(from, to)) {
    const allowed = (TRANSITIONS[from] || []).join(', ') || 'none';
    throw new Error(
      `Invalid status transition: "${from}" → "${to}". ` +
      `Allowed transitions from "${from}": [${allowed}].`
    );
  }
};

/**
 * Determine the final task status using majority-vote logic
 * when multiple reviewers are assigned.
 *
 * @param {Array<{status: string}>} reviewerVotes - rows from task_reviewers
 * @param {string} currentTaskStatus - 'submitted' | 'resubmitted'
 * @returns {{ finalized: boolean, finalStatus: string, meta: object }}
 */
const resolveMajorityVote = (reviewerVotes, currentTaskStatus) => {
  const votes       = reviewerVotes || [];
  const total       = votes.length;
  const approveCount = votes.filter((v) => v.status === 'approved').length;
  const rejectCount  = votes.filter((v) => v.status === 'rejected').length;
  const decidedCount = approveCount + rejectCount;

  // No reviewers assigned - don't finalize to prevent auto-rejection
  if (total === 0) {
    return {
      finalized:   false,
      finalStatus: currentTaskStatus,
      meta: { approveCount: 0, rejectCount: 0, decidedCount: 0, total: 0 },
    };
  }

  const majorityNeeded = Math.floor(total / 2) + 1;

  if (decidedCount < majorityNeeded) {
    return {
      finalized:   false,
      finalStatus: currentTaskStatus,
      meta: { approveCount, rejectCount, decidedCount, total, majorityNeeded },
    };
  }

  return {
    finalized:   true,
    finalStatus: approveCount > rejectCount ? 'approved' : 'rejected',
    meta: { approveCount, rejectCount, decidedCount, total },
  };
};

/**
 * Determine next task status when annotator re-submits (after rejection).
 * Uses 'resubmitted' if task was previously rejected, otherwise 'submitted'.
 *
 * @param {string} currentStatus - Task's current status before submission
 * @returns {'submitted' | 'resubmitted'}
 */
const getSubmitStatus = (currentStatus) =>
  currentStatus === 'rejected' ? 'resubmitted' : 'submitted';

module.exports = { TRANSITIONS, canTransition, assertTransition, resolveMajorityVote, getSubmitStatus };
