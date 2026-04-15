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

module.exports = { groupBboxesByLabel };
