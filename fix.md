Fix bug: Reviewer project detail page shows wrong progress percentage.

## Bug description
In the reviewer project detail page (`src/pages/Reviewer/Projects/ProjectDetail/index.jsx`),
the "Tiến độ review" (review progress) bar shows 50% instead of 100% when the reviewer
has already reviewed all sampled tasks.

## Scenario
- Project has 8 images, assigned to 2 annotators (4 images each)
- Both annotators submitted all their tasks (8 submitted tasks in DB)
- Sample rate: 20% → system randomly picks 20% per annotator = 1 task × 2 annotators = 2 tasks for reviewer
- Reviewer approved both 2 sampled tasks
- Expected progress: 100% (2/2) — reviewer is DONE
- Actual progress shown: 50% (2/4) — WRONG

## Root cause
In `ProjectDetail/index.jsx`, the progress calculation uses the wrong denominator.

The FE calls two APIs simultaneously:
- GET /api/reviews/pending  → returns 2 sampled tasks (the ones reviewer needs to review)
- GET /api/reviews/reviewed → returns 2 already-approved tasks

Then in the fallback stats calculation (around line 65–76), it sets:
  total = pending.length + reviewed.length = 2 + 2 = 4   ← WRONG

Then the progress bar (around line 154) calculates:
  reviewed    = approved + rejected = 2 + 0 = 2
  progressPct = Math.round((reviewed / stats.total) * 100) = 2/4 = 50%  ← WRONG

The denominator `stats.total` equals 4 because it incorrectly adds
"tasks already reviewed" + "tasks still pending review" — double counting.

The correct denominator should be:
  sampled = reviewed + pending = 2 + 0 = 2
  (after reviewing all sampled tasks, pending becomes 0)
  progressPct = 2/2 = 100%  ← CORRECT

## Fix required
In `src/pages/Reviewer/Projects/ProjectDetail/index.jsx`, find the lines:

  const reviewed    = (stats?.approved ?? 0) + (stats?.rejected ?? 0);
  const progressPct = stats?.total ? Math.round((reviewed / stats.total) * 100) : 0;

Replace with:

  const reviewed    = (stats?.approved ?? 0) + (stats?.rejected ?? 0);
  const sampled     = reviewed + (stats?.pending ?? 0);
  const progressPct = sampled > 0 ? Math.round((reviewed / sampled) * 100) : 0;

Also update the progress bar display text (around line 290) from:
  {progressPct}% ({reviewed}/{stats.total})

To:
  {progressPct}% ({reviewed}/{sampled})

## Why this fix is correct
- `stats.pending` = number of sampled tasks still waiting for review
- `stats.approved + stats.rejected` = number of sampled tasks already reviewed
- `sampled = pending + reviewed` = total tasks the reviewer is responsible for
- When reviewer finishes all: pending=0, reviewed=2, sampled=2, progress=100% ✅
- This is independent of how many total tasks exist in the DB (8 in this case)

## Do NOT change
- Backend code (reviews.js) — sampling logic is correct
- Any other FE files — only ProjectDetail/index.jsx needs updating
- The stats card showing "Tổng task" — keep as is (it shows the sampled count correctly)
