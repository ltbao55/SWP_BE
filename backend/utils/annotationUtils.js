/**
 * Annotation Utilities
 * Helper functions for processing annotation_data before saving to DB.
 */

/**
 * Group bounding boxes by their label and attach the result as `annotation_data.grouped`.
 *
 * Input  (flat array from FE):
 *   { bboxes: [{ label: "cat", x, y, width, height }, { label: "dog", x, y, width, height }] }
 *
 * Output (added `grouped` field, original `bboxes` kept for COCO export compatibility):
 *   {
 *     bboxes: [...],          ← unchanged, used by COCO export in projects.js
 *     grouped: {
 *       "cat": [{ x, y, width, height }],
 *       "dog": [{ x, y, width, height }]
 *     }
 *   }
 *
 * Rules:
 *  - If `annotation_data` is null/undefined → return as-is.
 *  - If `bboxes` is missing or empty → attach `grouped: {}` and return.
 *  - Each bbox entry that has no `label` field is placed under key "__unlabeled".
 *  - The `label` field is stripped from each grouped entry (redundant once grouped).
 *  - All other top-level fields (labels, ai_suggestion, spans, …) are preserved unchanged.
 *
 * @param {object|null} annotationData - Raw annotation_data from request body
 * @returns {object|null} annotation_data with `grouped` field populated
 */
const groupBboxesByLabel = (annotationData) => {
  if (!annotationData || typeof annotationData !== 'object') return annotationData;

  const bboxes = annotationData.bboxes;

  if (!Array.isArray(bboxes) || bboxes.length === 0) {
    return { ...annotationData, grouped: {} };
  }

  const grouped = {};

  for (const bbox of bboxes) {
    const { label, ...coords } = bbox;
    const key = (typeof label === 'string' && label.trim()) ? label.trim() : '__unlabeled';

    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(coords);
  }

  return { ...annotationData, grouped };
};

/**
 * Format a flat AI prediction array into grouped-by-label structure for FE rendering.
 *
 * Input  (raw AI output — flat array):
 *   [
 *     { label: "cat", x: 10, y: 20, width: 50, height: 30, confidence: 0.92 },
 *     { label: "dog", x: 100, y: 120, width: 60, height: 40, confidence: 0.85 },
 *     { label: "cat", x: 55, y: 65, width: 45, height: 25, confidence: 0.78 }
 *   ]
 *
 * Output (grouped by label — ready for FE bbox renderer):
 *   {
 *     "cat": [
 *       { x: 10, y: 20, width: 50, height: 30, confidence: 0.92 },
 *       { x: 55, y: 65, width: 45, height: 25, confidence: 0.78 }
 *     ],
 *     "dog": [
 *       { x: 100, y: 120, width: 60, height: 40, confidence: 0.85 }
 *     ]
 *   }
 *
 * @param {Array} bboxes - Flat array of bbox objects from AI service
 * @returns {Object} Grouped map { [label]: [coords, ...] }
 */
const formatGroupedData = (bboxes) => {
  if (!Array.isArray(bboxes) || bboxes.length === 0) return {};

  const grouped = {};
  for (const bbox of bboxes) {
    const { label, ...coords } = bbox;
    const key = (typeof label === 'string' && label.trim()) ? label.trim() : '__unlabeled';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(coords);
  }
  return grouped;
};

module.exports = { groupBboxesByLabel, formatGroupedData };
