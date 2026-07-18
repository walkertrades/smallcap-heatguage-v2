// Heat Gauge v2 — schema derivation + chip/badge color system.
// Locks the v2 runner schema and DERIVES every v2 field from whatever the
// source JSON carries, so the front-end works identically on:
//   • today's v1 data2.json (no v2 fields)  → fields derived / gracefully empty
//   • tomorrow's v2 output (Python emits the fields directly) → used as-is
//
// v2 runner schema (each runner should carry, or have derived):
//   sym, hod, fade, hodTimeExact, session, volRaw, volDollar, floatM, country,
//   sector, marketCap, tag (catalyst), floatTier, ssr (bool),
//   reverseSplit (null | "10:1"), newsHeadlines[], newsSummary,
//   bullFactors[], bearFactors[], behaviorTag (manual, localStorage)
//
// Exposed on window so the other in-browser Babel modules can use it.

// ── Session bucketing ──────────────────────────────────────────────
// hodTimeExact comes as strings like "16:24 PM ET", "09:59 AM ET",
// "06:12 PM ET". The hour is sometimes already 24h (16:24) and sometimes
// 12h with an AM/PM suffix (06:12 PM). Parse both robustly.
function minutesFromExact(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (hh > 12) {
    // already 24h — trust the hour, ignore any (contradictory) AM/PM suffix
  } else if (ap === "PM") {
    if (hh !== 12) hh += 12;
  } else if (ap === "AM") {
    if (hh === 12) hh = 0;
  }
  return hh * 60 + mm;
}

// Premarket <9:30 · Morning 9:30–12:00 · Afternoon 12:00–16:00 · After-hours ≥16:00
function deriveSession(hodTimeExact, timeRaw) {
  const min = minutesFromExact(hodTimeExact);
  if (min == null) {
    const s = String(timeRaw || "").toLowerCase();
    if (s.includes("pre")) return "premarket";
    if (s.includes("after") || s.includes("post") || s.includes("ah")) return "after-hours";
    if (s.includes("session") || s.includes("regular") || s.includes("rth")) return "morning";
    return "morning";
  }
  if (min < 570) return "premarket";
  if (min < 720) return "morning";
  if (min < 960) return "afternoon";
  return "after-hours";
}

const SESSION_LABELS = {
  "premarket": "PREMARKET",
  "morning": "MORNING",
  "afternoon": "AFTERNOON",
  "after-hours": "AFTER HOURS",
};
function sessionLabel(sess) { return SESSION_LABELS[sess] || "—"; }

// Short forms + color grouping for compact table cells — always derived from the
// SAME session bucket as the full label, so table and tile never disagree.
const SESSION_ABBR = {
  "premarket": "PRE",
  "morning": "AM",
  "afternoon": "PM",
  "after-hours": "AH",
};
function sessionAbbr(sess) { return SESSION_ABBR[sess] || "—"; }
// premarket = risk, regular session (morning/afternoon) = good, after-hours = neutral
function sessionColorClass(sess) {
  if (sess === "premarket") return "premarket";
  if (sess === "morning" || sess === "afternoon") return "session";
  if (sess === "after-hours") return "afterhours";
  return "mixed";
}

// ── Volume / $ volume ──────────────────────────────────────────────
// volRaw is a display string like "80.8M" / "338.0M". Parse to a number.
function parseShareVol(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,\s]/g, "");
  const m = s.match(/([\d.]+)\s*([kmbt])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || "").toLowerCase();
  if (suf === "k") n *= 1e3;
  else if (suf === "m") n *= 1e6;
  else if (suf === "b") n *= 1e9;
  else if (suf === "t") n *= 1e12;
  return n;
}

// $ volume = price × share volume. Prefer an explicit volDollar; else derive
// from share volume × representative price (VWAP > close > high).
function computeVolDollar(r) {
  if (r == null) return null;
  if (r.volDollar != null && Number.isFinite(Number(r.volDollar))) return Number(r.volDollar);
  const shares = parseShareVol(r.volRaw);
  if (shares == null) return null;
  const price = r.vwap != null ? Number(r.vwap)
    : r.close != null ? Number(r.close)
    : r.high != null ? Number(r.high)
    : null;
  if (price == null || !Number.isFinite(price)) return null;
  return shares * price;
}

// Compact $ formatting: $1.2B / $340M / $12M
function fmtDollar(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// ── Float tiers ────────────────────────────────────────────────────
// Nano <1M · Micro 1–5M · Low 5–10M · Mid 10–20M · Thick 20–50M · Mega Thick 50M+
function floatTier(floatM) {
  const f = Number(floatM);
  if (floatM == null || !Number.isFinite(f)) return null;
  if (f < 1) return "Nano";
  if (f < 5) return "Micro";
  if (f < 10) return "Low";
  if (f < 20) return "Mid";
  if (f < 50) return "Thick";
  return "Mega Thick";
}

// ── Color system ───────────────────────────────────────────────────
// Catalyst tags — the v2 controlled vocabulary (Claude-assigned). Colors chosen
// so families read together: bio (FDA/PHASE-*) greens, corporate actions blues,
// distress reds/oranges, structural purples.
const CATALYST_COLORS = {
  "EARNINGS":      "oklch(0.68 0.16 145)",
  "FDA":           "oklch(0.70 0.17 160)",
  "PHASE-1":       "oklch(0.72 0.14 175)",
  "PHASE-2":       "oklch(0.70 0.15 185)",
  "PHASE-3":       "oklch(0.68 0.16 195)",
  "COMPLIANCE":    "oklch(0.72 0.15 90)",
  "BANKRUPTCY":    "oklch(0.58 0.20 25)",
  "ACQUISITION":   "oklch(0.62 0.16 255)",
  "MERGER":        "oklch(0.60 0.15 265)",
  "SHARE-BUYBACK": "oklch(0.66 0.15 300)",
  "SYMPATHY":      "oklch(0.66 0.14 240)",
  "NO-NEWS":       "oklch(0.55 0.03 250)",
  "HALT-RESUME":   "oklch(0.70 0.18 55)",
  "CONTRACT":      "oklch(0.66 0.14 210)",
  "OFFERING":      "oklch(0.66 0.18 45)",
};
// Legacy v1 tag vocabulary — kept so today's data2.json still colors sensibly.
const LEGACY_TAG_COLORS = {
  "RIG":               "oklch(0.7 0.18 150)",
  "FUNDAMENTAL":       "oklch(0.7 0.16 160)",
  "NEWS-DRIVEN":       "oklch(0.75 0.15 85)",
  "UNDERWRITER MANIP": "oklch(0.65 0.22 25)",
  "DILUTION BAIT":     "oklch(0.7 0.17 50)",
  "RETAIL PUMP":       "oklch(0.7 0.2 320)",
  "SHORT TRAP":        "oklch(0.68 0.19 20)",
  "COMPLIANCE":        "oklch(0.72 0.15 90)",
  "SYMPATHY":          "oklch(0.7 0.14 240)",
  "MIXED":             "oklch(0.6 0.02 250)",
};
function catalystColor(tag) {
  if (!tag) return "oklch(0.6 0.02 250)";
  const t = String(tag).toUpperCase();
  return CATALYST_COLORS[t] || LEGACY_TAG_COLORS[t] || "oklch(0.6 0.02 250)";
}

// Float tier — cool→warm ramp, smaller float = hotter/riskier.
const FLOATTIER_COLORS = {
  "Nano":       "oklch(0.66 0.20 25)",
  "Micro":      "oklch(0.68 0.17 50)",
  "Low":        "oklch(0.72 0.14 85)",
  "Mid":        "oklch(0.66 0.12 150)",
  "Thick":      "oklch(0.60 0.10 220)",
  "Mega Thick": "oklch(0.55 0.08 260)",
};
function floatTierColor(tier) {
  return FLOATTIER_COLORS[tier] || "oklch(0.6 0.02 250)";
}

// Country / sector — many distinct values, so hash the string to a stable hue.
function hueHash(str, salt) {
  let h = 2166136261 >>> 0;
  const s = (salt || "") + String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}
function countryColor(c) {
  if (!c) return "oklch(0.55 0.02 250)";
  return `oklch(0.60 0.11 ${hueHash(c, "C")})`;
}
function sectorColor(s) {
  if (!s) return "oklch(0.55 0.02 250)";
  return `oklch(0.55 0.09 ${hueHash(s, "S")})`;
}

// ── Sector normalization ───────────────────────────────────────────
// Source data mixes clean sector names with raw SIC descriptions
// ("Pharmaceutical Preparations", "Crude Petroleum & Natural Gas", ...).
// Collapse everything into a small readable set of categories.
const SECTOR_CATEGORIES = ["Healthcare", "Biotech", "Energy", "Tech", "Industrials", "Financial", "Consumer", "Materials", "Other"];
function normalizeSector(raw) {
  if (!raw) return "Other";
  const s = String(raw).toLowerCase();
  if (/(biotech|biologic|pharmaceutic|\bdrug|clinical|therapeut|vaccine|genom|gene therap|life scien|diagnostic)/.test(s)) return "Biotech";
  if (/(health|hospital|medical|\bcare\b|dental|nursing|surg|medic|device)/.test(s)) return "Healthcare";
  if (/(oil|gas|petroleum|energy|coal|solar|renewable|uranium|drilling|pipeline|power)/.test(s)) return "Energy";
  if (/(software|technolog|semiconductor|computer|internet|\bdata\b|cloud|electron|artificial intelligence|\bai\b|saas|cyber|fintech)/.test(s)) return "Tech";
  if (/(industrial|manufactur|machin|aerospace|defense|construction|engineering|transport|logistic|airline|freight|electrical)/.test(s)) return "Industrials";
  if (/(bank|financ|insurance|capital|invest|lending|mortgage|asset manage|blank check|shell|acquisition corp|holding|reit|real estate)/.test(s)) return "Financial";
  if (/(retail|consumer|apparel|food|beverage|restaurant|media|entertainment|hotel|leisure|e-commerce|commerce|cannabis|gaming|automob|\bauto\b|tobacco)/.test(s)) return "Consumer";
  if (/(mining|metal|gold|silver|copper|material|chemical|steel|mineral|lithium|rare earth|forest|paper|agricult)/.test(s)) return "Materials";
  return "Other";
}

// ── Behavior tag (manual, localStorage) ────────────────────────────
// User-set per runner after reviewing charts. Editable inline in the day tile.
const BEHAVIOR_KEY = "hg2:behavior";
function behaviorKey(date, sym) { return `${date}::${sym}`; }
function loadBehaviorMap() {
  try {
    const raw = window.localStorage.getItem(BEHAVIOR_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function getBehaviorTag(date, sym, fallback) {
  const map = loadBehaviorMap();
  const v = map[behaviorKey(date, sym)];
  return v != null ? v : (fallback != null ? fallback : "");
}
function setBehaviorTag(date, sym, value) {
  let map = loadBehaviorMap();
  const k = behaviorKey(date, sym);
  if (value == null || String(value).trim() === "") delete map[k];
  else map[k] = String(value).trim();
  try { window.localStorage.setItem(BEHAVIOR_KEY, JSON.stringify(map)); } catch (_) {}
  return map[k] || "";
}

// ── Catalyst tag edits (manual, localStorage) ──────────────────────
// Keyed by date+ticker so an edit survives refresh and follows that runner.
const TAGEDIT_KEY = "hg2:tagEdits";
const V2_CATALYST_TAGS = [
  "EARNINGS", "FDA", "PHASE-1", "PHASE-2", "PHASE-3", "COMPLIANCE",
  "BANKRUPTCY", "ACQUISITION", "MERGER", "SHARE-BUYBACK", "SYMPATHY",
  "NO-NEWS", "HALT-RESUME", "CONTRACT", "OFFERING",
];
function loadTagEdits() {
  try {
    const raw = window.localStorage.getItem(TAGEDIT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function getTagEdit(date, sym) {
  const m = loadTagEdits();
  return m[`${date}::${sym}`] || null;
}
function setTagEdit(date, sym, edit) {
  const m = loadTagEdits();
  const k = `${date}::${sym}`;
  const clean = {
    tag: edit && edit.tag ? String(edit.tag) : null,
    customTags: edit && Array.isArray(edit.customTags) ? edit.customTags.map(String).filter(Boolean) : [],
  };
  if (!clean.tag && clean.customTags.length === 0) delete m[k];
  else m[k] = clean;
  try { window.localStorage.setItem(TAGEDIT_KEY, JSON.stringify(m)); } catch (_) {}
  return m[k] || null;
}

// ── Manual grade (replaces the auto Setup Score) ───────────────────
// User-assigned per runner, persisted by date+ticker. Blank until graded.
const GRADE_KEY = "hg2:grades";
const GRADES = ["F", "D", "C", "B", "A", "A+", "A++"];
function gradeRank(g) {
  const i = GRADES.indexOf(g);
  return i < 0 ? -1 : i; // ungraded sorts below F
}
function gradeColor(g) {
  switch (g) {
    case "F":   return "oklch(0.62 0.21 25)";   // red
    case "D":   return "oklch(0.66 0.20 30)";   // red
    case "C":   return "oklch(0.72 0.18 55)";   // orange
    case "B":   return "oklch(0.84 0.16 92)";   // yellow
    case "A":   return "oklch(0.76 0.17 150)";  // green
    case "A+":  return "oklch(0.86 0.22 145)";  // bright green
    case "A++": return "oklch(0.85 0.16 85)";   // gold
    default:    return "oklch(0.55 0.02 260)";  // ungraded gray
  }
}
function loadGrades() {
  try {
    const raw = window.localStorage.getItem(GRADE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function getGrade(date, sym) {
  const m = loadGrades();
  return m[`${date}::${sym}`] || null;
}
function setGrade(date, sym, grade) {
  const m = loadGrades();
  const k = `${date}::${sym}`;
  if (!grade || GRADES.indexOf(grade) < 0) delete m[k];
  else m[k] = grade;
  try { window.localStorage.setItem(GRADE_KEY, JSON.stringify(m)); } catch (_) {}
  return m[k] || null;
}

// ── Runner normalization ───────────────────────────────────────────
// Augment a raw runner with all derived v2 fields. Non-destructive: existing
// v2 fields on the runner win; everything else is derived. `date` is threaded
// in so behaviorTag can key on (date, sym).
function normalizeRunnerV2(r, date) {
  if (!r) return r;
  const session = r.session || deriveSession(r.hodTimeExact, r.time);
  const tier = r.floatTier || floatTier(r.floatM);
  const volDollar = computeVolDollar(r);
  const newsHeadlines = Array.isArray(r.newsHeadlines) ? r.newsHeadlines
    : (Array.isArray(r.news) ? r.news : []);
  const bullFactors = Array.isArray(r.bullFactors) ? r.bullFactors : [];
  const bearFactors = Array.isArray(r.bearFactors) ? r.bearFactors : [];
  const ssr = r.ssr === true;
  const reverseSplit = (r.reverseSplit != null && r.reverseSplit !== false) ? r.reverseSplit : null;
  const behaviorTag = getBehaviorTag(date, r.sym, r.behaviorTag);
  return {
    ...r,
    _date: date,
    session,
    sectorNorm: normalizeSector(r.sector),
    floatTier: tier,
    volDollar,
    newsHeadlines,
    newsSummary: r.newsSummary != null ? r.newsSummary : null,
    bullFactors,
    bearFactors,
    ssr,
    reverseSplit,
    behaviorTag,
  };
}

Object.assign(window, {
  minutesFromExact,
  deriveSession,
  sessionLabel,
  sessionAbbr,
  sessionColorClass,
  parseShareVol,
  computeVolDollar,
  fmtDollar,
  floatTier,
  normalizeSector,
  SECTOR_CATEGORIES,
  catalystColor,
  floatTierColor,
  countryColor,
  sectorColor,
  getBehaviorTag,
  setBehaviorTag,
  getTagEdit,
  setTagEdit,
  V2_CATALYST_TAGS,
  GRADES,
  gradeRank,
  gradeColor,
  getGrade,
  setGrade,
  normalizeRunnerV2,
  CATALYST_COLORS,
  FLOATTIER_COLORS,
});
