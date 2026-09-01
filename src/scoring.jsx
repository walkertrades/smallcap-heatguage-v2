// Scoring engine for the small-cap heat gauge.
// Exported to window so other Babel scripts can use it.

// NOTE: entry.hod is the LEAD runner's HOD %, NOT a day average -- the pipeline
// writes lead.hod (evening_recap_json_only.py, day-summary block). The UI still
// labels it "AVG HOD"; these thresholds are top-runner percentages.
const DEFAULT_THRESHOLDS = {
  hodHot: 200,        // lead-runner HOD >= 200 counts toward HOT
  hodNeutralLo: 125,  // 125-200 is NEUTRAL territory; below 125 is COLD
  fadeHot: 25,        // fade < 25 counts toward HOT
  fadeCold: 40,       // fade > 40 counts toward COLD
};

// Return a 0-100 "heat score" along with the categorical state.
// We compute three subscores (HOD, timing, fade), average them,
// then apply the premarket override per spec.
function computeHeat(entry, thresholds = DEFAULT_THRESHOLDS) {
  if (!entry || entry.hod == null || entry.fade == null || !entry.hodTime) {
    return { score: null, state: "EMPTY", sub: null };
  }

  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const hod = Number(entry.hod);
  const fade = Number(entry.fade);

  // HOD subscore: piecewise — cap raised to hodHot+500 so extreme days get full credit
  let hodScore;
  if (hod >= t.hodHot + 500) hodScore = 100;
  else if (hod >= t.hodHot + 100) hodScore = 85 + ((hod - (t.hodHot + 100)) / 400) * 15;
  else if (hod >= t.hodHot) hodScore = 75 + ((hod - t.hodHot) / 100) * 10;
  else if (hod >= t.hodNeutralLo) hodScore = 40 + ((hod - t.hodNeutralLo) / (t.hodHot - t.hodNeutralLo)) * 35;
  else hodScore = Math.max(0, (hod / t.hodNeutralLo) * 40);

  // Fade subscore (inverse — lower fade = hotter)
  // Weight reduced to 25% — fade matters but shouldn't override extreme HOD tape
  let fadeScore;
  if (fade <= t.fadeHot) fadeScore = 90 + Math.max(0, ((t.fadeHot - fade) / t.fadeHot) * 10);
  else if (fade <= t.fadeCold) fadeScore = 40 + ((t.fadeCold - fade) / (t.fadeCold - t.fadeHot)) * 50;
  else fadeScore = Math.max(0, 40 - ((fade - t.fadeCold) / 40) * 40);

  // Timing subscore
  let timeScore;
  if (entry.hodTime === "session") timeScore = 90;
  else if (entry.hodTime === "mixed") timeScore = 50;
  else timeScore = 15; // premarket

  // Weights: HOD 50%, fade 25%, time 25%
  let score = Math.round((hodScore * 0.50 + fadeScore * 0.25 + timeScore * 0.25));
  score = Math.max(0, Math.min(100, score));

  // Black swan override: HOD >= 300% with high fades = still HOT tape,
  // but flag it as a potential trap day. Extreme moves dominate regardless of fade.
  const BLACK_SWAN_HOD = 300;
  const isBlackSwan = hod >= BLACK_SWAN_HOD && fade > t.fadeCold;

  // State logic — premarket is a RISK FLAG, not an auto-downgrade.
  // Category is chosen from HOD + fade; premarket just adds a warning badge.
  let state;
  if (isBlackSwan) {
    // Extreme tape -- classify HOT regardless of fades
    state = "HOT";
  } else if (hod >= t.hodHot && fade <= t.fadeHot && entry.hodTime === "session") {
    state = "HOT";
  } else if (hod < t.hodNeutralLo || fade > t.fadeCold) {
    state = "COLD";
  } else if (hod >= t.hodHot && fade <= t.fadeCold) {
    state = entry.hodTime === "premarket" ? "NEUTRAL" : "HOT";
  } else {
    state = "NEUTRAL";
  }

  // Premarket applies a small score penalty but doesn't force COLD
  if (entry.hodTime === "premarket") {
    score = Math.max(0, score - 10);
  }

  return {
    score,
    state,
    isBlackSwan,
    sub: { hodScore: Math.round(hodScore), fadeScore: Math.round(fadeScore), timeScore },
  };
}

// Compute the current streak (consecutive days ending today with same state).
function computeStreak(entries) {
  if (!entries || entries.length === 0) return { state: "EMPTY", count: 0 };
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  const currentState = sorted[0].state;
  let count = 0;
  for (const e of sorted) {
    if (e.state === currentState) count++;
    else break;
  }
  return { state: currentState, count };
}

// Trading rules per state — copy sourced from reviewed reference
const RULES = {
  HOT: {
    label: "AGGRESSIVE",
    tagline: "Press A+ setups with conviction",
    color: "hot",
    bullets: [
      "Press A+ setups with conviction",
      "Allow runners — trail, don't exit early",
      "Add with structure on HOD clearouts",
      "Session HODs are buyable — wait for volume confirm",
    ],
  },
  NEUTRAL: {
    label: "SELECTIVE",
    tagline: "One name, quicker profits",
    color: "neutral",
    bullets: [
      "One name focus only",
      "Take profits quicker at first PT",
      "Tighter stops — no adding into weakness",
      "Check HOD time before any entry",
    ],
  },
  COLD: {
    label: "DEFENSIVE",
    tagline: "A+ only — if it's not obvious, sit out",
    color: "cold",
    bullets: [
      "A+ only — if it's not obvious, sit out",
      "Minimum size on every trade",
      "Fastest exits — no runners today",
      "Premarket HOD = distribution trap, avoid",
    ],
  },
  EMPTY: {
    label: "NO DATA",
    tagline: "Log today's metrics",
    color: "neutral",
    bullets: ["Enter today's readings to calibrate."],
  },
};

// ── Heat colour scale ──────────────────────────────────────────────
// ONE gradient for the whole app: cold blue → cyan → green → amber → orange →
// hot red. These are the exact stops the radial gauge has always used; they
// were locked inside an SVG <linearGradient> in Gauge.jsx, so nothing else
// could reach them. The gauge now builds its stops from this array and every
// other heat-coloured element calls heatColor(), so there is still exactly one
// scale and a change to it lands everywhere at once.
//
// NOTE the cold end is BLUE, not green — green sits in the MIDDLE of this ramp.
// Anything colouring by heat must keep that, or the same number would read as a
// different temperature depending on which control you looked at.
const HEAT_GRADIENT = [
  { at: 0,   l: 0.62, c: 0.18, h: 255 },
  { at: 26,  l: 0.68, c: 0.15, h: 215 },
  { at: 48,  l: 0.80, c: 0.15, h: 150 },
  { at: 68,  l: 0.86, c: 0.16, h: 95  },
  { at: 86,  l: 0.76, c: 0.19, h: 55  },
  { at: 100, l: 0.64, c: 0.23, h: 28  },
];
function heatStopColor(s) { return `oklch(${s.l} ${s.c} ${s.h})`; }

// `score` is ALWAYS on the absolute 0–100 scale, never a chart's zoomed axis —
// a 61 has to read as the same temperature on the dial and on the trend line.
function heatColor(score) {
  const v = Number(score);
  if (score == null || !Number.isFinite(v)) return "oklch(0.55 0.02 260)";
  const s = Math.max(0, Math.min(100, v));
  let a = HEAT_GRADIENT[0], b = HEAT_GRADIENT[HEAT_GRADIENT.length - 1];
  for (let i = 0; i < HEAT_GRADIENT.length - 1; i++) {
    if (s >= HEAT_GRADIENT[i].at && s <= HEAT_GRADIENT[i + 1].at) {
      a = HEAT_GRADIENT[i]; b = HEAT_GRADIENT[i + 1];
      break;
    }
  }
  const span = b.at - a.at;
  const t = span === 0 ? 0 : (s - a.at) / span;
  const mix = (x, y) => x + (y - x) * t;
  // Hue runs 255 → 28 monotonically down, so linear interpolation is safe here
  // — there is no wraparound to shortest-path around the colour wheel.
  return `oklch(${mix(a.l, b.l).toFixed(4)} ${mix(a.c, b.c).toFixed(4)} ${mix(a.h, b.h).toFixed(2)})`;
}

// Visual zone boundaries in score. Shared by the radial gauge's arc highlight
// and the trend chart's gridlines, so the chart's bands line up with the dial's.
const HEAT_ZONE_EDGE = { coldTop: 45, hotBottom: 62 };

// Trend-chart y-axis. RE-DERIVED 2026-09-01 for the 200/125 thresholds.
//   across 1,039 days: min 29 | p1 48 | median 83 | p95 96 | p99 96 | max 97
// The distribution is TOP-HEAVY (26% of days score above 90), so a 95 ceiling
// would clamp 115 days (11.1%) flat against the top edge. 30-97 clips nothing
// above and one day below. Values outside are CLAMPED, never dropped.
const HEAT_AXIS = { min: 30, max: 97 };

Object.assign(window, {
  computeHeat, computeStreak, RULES, DEFAULT_THRESHOLDS,
  HEAT_GRADIENT, heatStopColor, heatColor, HEAT_ZONE_EDGE, HEAT_AXIS,
});
