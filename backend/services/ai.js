/**
 * AI Service — Google Gemini wrapper for image pre-labeling
 * Free tier: 15 req/min, 1M tokens/day
 * Get key at: https://aistudio.google.com/apikey
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey   = process.env.GEMINI_API_KEY;
const modelId  = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

if (!apiKey) {
  console.warn('[AI] GEMINI_API_KEY is not set — /api/ai/* routes will fail.');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

/**
 * Download an image URL and return { base64, mimeType }.
 * Works with both public and signed Supabase Storage URLs.
 */
const fetchImageAsBase64 = async (imageUrl) => {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);

  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  const buffer   = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType };
};

/**
 * Pre-label an image given a list of allowed labels.
 *
 * @param {string} imageUrl
 * @param {Array<{name:string, description?:string}>} labels
 * @returns {Promise<{ labels: Array<{name:string, confidence:number, reasoning:string}>, raw:string }>}
 */
const preLabelImage = async (imageUrl, labels) => {
  if (!genAI) throw new Error('GEMINI_API_KEY not configured');
  if (!labels || labels.length === 0) throw new Error('No labels provided');

  const model = genAI.getGenerativeModel({ model: modelId });

  const labelList = labels
    .map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ''}`)
    .join('\n');

  const prompt = `You are an image annotation assistant for a data labeling system.
Look at the image carefully and determine which of the following labels apply:

${labelList}

Rules:
- Use ONLY the exact label names provided above (case-sensitive)
- Only include labels you are confident about (confidence > 0.5)
- Confidence must be a number between 0 and 1
- Keep "reasoning" brief (one sentence)
- Respond ONLY with valid JSON — no markdown, no code fences, no extra text

Output format:
{
  "labels": [
    {"name": "<exact_label_name>", "confidence": 0.95, "reasoning": "brief reason"}
  ]
}`;

  const { base64, mimeType } = await fetchImageAsBase64(imageUrl);

  const result = await model.generateContent([
    prompt,
    { inlineData: { mimeType, data: base64 } },
  ]);

  const text = result.response.text().trim();

  // Strip code fences if Gemini wraps the JSON
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Fall back: extract first JSON object substring
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`AI returned non-JSON response: ${text.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }

  // Validate suggestions against allowed label names
  const allowedNames = new Set(labels.map((l) => l.name));
  const validLabels  = (parsed.labels || []).filter((l) => allowedNames.has(l.name));

  return { labels: validLabels, raw: text };
};

module.exports = { preLabelImage };
