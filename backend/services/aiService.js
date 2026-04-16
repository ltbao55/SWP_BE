/**
 * AI Service — Abstraction layer for bounding box prediction.
 *
 * Supports two modes (controlled by env var AI_BBOX_MODE):
 *   "mock"   → returns realistic fake bboxes — use this to test FE flow
 *              without a real model or API key
 *   "gemini" → calls Google Gemini Vision (default when GEMINI_API_KEY is set)
 *
 * The route (tasks.js) calls ONLY getAIPredictions() and never knows
 * which provider is running underneath.
 */

const AI_MODE = process.env.AI_BBOX_MODE || 'gemini';

// ── Mock Provider ─────────────────────────────────────────────
/**
 * Simulate AI bbox predictions with a 300ms delay.
 * Returns a realistic flat array matching the same shape as the real provider.
 *
 * @param {string[]} labelNames
 * @returns {Array<{ label, x, y, width, height, confidence }>}
 */
const mockPredict = async (labelNames) => {
  await new Promise((r) => setTimeout(r, 300)); // simulate network latency

  if (!labelNames || labelNames.length === 0) return [];

  // Generate 2–4 fake boxes, cycling through available labels
  const count  = Math.floor(Math.random() * 3) + 2;
  const bboxes = [];

  for (let i = 0; i < count; i++) {
    const label = labelNames[i % labelNames.length];
    // Place boxes in different quadrants so they don't all stack
    const x = 50  + (i % 3) * 200 + Math.floor(Math.random() * 80);
    const y = 50  + (i % 2) * 180 + Math.floor(Math.random() * 60);
    bboxes.push({
      label,
      x,
      y,
      width:      100 + Math.floor(Math.random() * 120),
      height:     80  + Math.floor(Math.random() * 100),
      confidence: parseFloat((0.65 + Math.random() * 0.30).toFixed(2)),
    });
  }

  return bboxes;
};

// ── Gemini Provider ───────────────────────────────────────────
/**
 * Real bbox detection via Google Gemini Vision.
 * Delegates to preLabelImageWithBboxes in services/ai.js.
 *
 * @param {string} imageUrl
 * @param {Array<{name, description?}>} labels
 * @param {{ width: number, height: number }} imageSize
 * @returns {Array<{ label, x, y, width, height, confidence }>}
 */
const geminiPredict = async (imageUrl, labels, imageSize) => {
  const { preLabelImageWithBboxes } = require('./ai');
  const result = await preLabelImageWithBboxes(imageUrl, labels, imageSize);
  return result.bboxes; // already in { label, x, y, width, height, confidence } format
};

// ── Public API ────────────────────────────────────────────────
/**
 * Get AI bounding box predictions for an image.
 * Called by POST /api/tasks/:id/ai-assist in routes/tasks.js.
 *
 * @param {object} params
 * @param {string}   params.imageUrl   - Signed or public URL of the image
 * @param {Array}    params.labels     - [{name, description?}] from the task's label_set
 * @param {object}  [params.imageSize] - { width, height } in pixels (default 1000x1000)
 * @returns {Promise<Array<{ label, x, y, width, height, confidence }>>}
 */
const getAIPredictions = async ({ imageUrl, labels, imageSize = { width: 1000, height: 1000 } }) => {
  const labelNames = (labels || []).map((l) => l.name);

  if (AI_MODE === 'mock') {
    console.log('[aiService] Running in MOCK mode');
    return mockPredict(labelNames);
  }

  console.log(`[aiService] Running in GEMINI mode — model: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}`);
  return geminiPredict(imageUrl, labels, imageSize);
};

module.exports = { getAIPredictions };
