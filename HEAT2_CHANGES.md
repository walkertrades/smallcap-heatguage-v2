# Heat + Direction (heat2) — sandbox change set, 2026-11-24

Sandbox only. Nothing in `smallcap-heatguage-v2` was touched. No change to
`data2.json`, the Python pipeline, or Firestore. No schema change: every input
is read from fields the pipeline already writes.

## Files

| File | Change |
|---|---|
| `src/heat2.js` | NEW. The scoring engine (plain script, no JSX). |
| `index.html` | Loads `src/heat2.js`; cache-bust versions bumped on changed files. |
| `src/App.jsx` | Scores each day with heat2; legacy score kept as fallback. Gauge page uses the new card. |
| `src/metrics.jsx` | `buildDailySeries` passes the day's `hd` detail through. |
| `src/Overview.jsx` | New `HeatDirectionCard` (Heat, Direction, Market State, Today's Playbook in one card). Confidence bar removed from the hero. Rolling strip shows Direction. |
| `src/Calendar.jsx` | Day cells show Cooling / Heating / Green light as text lines. |
| `src/dashboard.css` | `.hd-*` rules for the new card, `.roll-dir`, `.cal-dir`. |

## Rules implemented

- Only names with at least $20M traded (volume x VWAP) count.
- Heat = 30% names over 100% HOD, 30% gappers over 50%, 25% average HOD of
  counted names, 15% names closed up 50%+. Each ranked against the prior 250
  trading days, then blended. Zones: under 45 COLD, 45-68 NEUTRAL, 69+ HOT.
- Cooling = names over 100% per day over the last 5 days is at least 20% below
  the prior 5, and the last 2 days are not back above the 5-day average.
  Steps the playbook down one level.
- Heating = under 60% of 30%+ gappers closed below their open (5-day) and the
  last 2 days are above the 5-day average. Display only.
- Green light = Heat is HOT and gappers are holding. Can show with Heating.
- Move kept and top-3 runner size are shown as stats, not scored.

## Known limits

- Ranking uses history from 2025-10-01 on, and needs 60 trading days. The first
  day on the new score is 2025-12-26. Earlier days keep the legacy score and
  show "LEGACY SCORE" with no Direction.
- The Tweaks thresholds (hodHot, fadeHot, ...) only affect legacy-score days.
- No reverse-split guard yet. A split-day fake still counts as a runner.
- The AI trend bar is unchanged.
- `D:\TradingData\review_system\heat_gauge.py` still uses the old formula.

## Verified before writing

- heat2.js matches the backtest on all 288 ranked days (Heat, Cooling, Heating,
  Green light): zero mismatches.
- All changed `.jsx` files compile; the new card and strip render on real days.
- Not verified: the page in a browser with login. That is the local check.

## Added later on 2026-11-24

- Calendar tab rebuilt to the monthly mockups: Mon-Fri tiles, Direction lines,
  hover lift, no week column, no weekly label, no playbook line.
- Theme layer on the calendar (Country / Float / Price / All), computed on the
  100%+ names only. A value shows alone on a majority; two values show as a
  pair on a clean split with 4+ names.
- Price ranges are now Pennies, $1-$3, $3-$5, $5-$10, $10-$20, $20+ in
  `metrics.jsx`. Used by the calendar and the What's Driving card. Playbook
  folder criteria keep their own ranges.
- AI trend card (Tape / Supply / Watch) replaces the paragraph banner. Tape is
  computed in the browser. Supply and Watch are read from the new
  `ai-trend.json`; see `AI_TREND_TASK.md`. The old AISummaryBar is no longer
  rendered, so the 5-day Sonnet blend is no longer called.
- New file `ai-trend.json` (one entry, 2026-11-20). This is a new data file,
  not a change to `data2.json`.
- `data2.json` in the sandbox was replaced with production's copy (through
  2026-11-20).
