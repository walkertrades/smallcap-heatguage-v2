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
//   bullFactors[], bearFactors[], behaviorTag (manual — Firestore, see overrides.jsx)
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
// Session buckets, in minutes from ET midnight. `min` inclusive, `max`
// exclusive; null means unbounded. Single source of truth in the same way
// FLOAT_TIERS is: deriveSession() buckets from it and the filter tooltips
// describe it, so the boundaries can't drift apart from their labels.
const SESSION_BOUNDS = [
  { key: "premarket",   min: null, max: 570 },   // up to 9:30 AM
  { key: "morning",     min: 570,  max: 720 },   // 9:30 AM – 12:00 PM
  { key: "afternoon",   min: 720,  max: 960 },   // 12:00 PM – 4:00 PM
  { key: "after-hours", min: 960,  max: null },  // 4:00 PM onward
];
function deriveSession(hodTimeExact, timeRaw) {
  const min = minutesFromExact(hodTimeExact);
  if (min == null) {
    const s = String(timeRaw || "").toLowerCase();
    if (s.includes("pre")) return "premarket";
    if (s.includes("after") || s.includes("post") || s.includes("ah")) return "after-hours";
    if (s.includes("session") || s.includes("regular") || s.includes("rth")) return "morning";
    return "morning";
  }
  for (const b of SESSION_BOUNDS) {
    if ((b.min == null || min >= b.min) && (b.max == null || min < b.max)) return b.key;
  }
  return "after-hours";
}
// "before 9:30AM ET" / "9:30AM – 12PM ET" / "4PM ET onward"
function sessionRange(key) {
  const b = SESSION_BOUNDS.find((x) => x.key === key);
  if (!b) return "";
  const fmt = window.fmtClockMin || ((m) => String(m));
  if (b.min == null) return `HOD before ${fmt(b.max)} ET`;
  if (b.max == null) return `HOD ${fmt(b.min)} ET onward`;
  return `HOD ${fmt(b.min)} – ${fmt(b.max)} ET`;
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
// Float tier bounds, in millions of shares. `min` inclusive, `max` exclusive;
// null means unbounded on that side.
//
// This array is the SINGLE SOURCE OF TRUTH: floatTier() assigns from it and the
// filter tooltips describe it, so a threshold change can never leave a stale
// label behind in the UI.
const FLOAT_TIERS = [
  { key: "Nano",       min: null, max: 1 },
  { key: "Micro",      min: 1,    max: 5 },
  { key: "Low",        min: 5,    max: 10 },
  { key: "Mid",        min: 10,   max: 20 },
  { key: "Thick",      min: 20,   max: 50 },
  { key: "Mega Thick", min: 50,   max: null },
];
function floatTier(floatM) {
  const f = Number(floatM);
  if (floatM == null || !Number.isFinite(f)) return null;
  for (const t of FLOAT_TIERS) {
    if ((t.min == null || f >= t.min) && (t.max == null || f < t.max)) return t.key;
  }
  return null;
}
// "< 1M float" / "1M – 5M float" / "≥ 50M float"
function floatTierRange(tier) {
  const t = FLOAT_TIERS.find((x) => x.key === tier);
  if (!t) return "";
  if (t.min == null) return `< ${t.max}M float`;
  if (t.max == null) return `≥ ${t.min}M float`;
  return `${t.min}M – ${t.max}M float`;
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
  "LIQUIDITY-TRAP":    "oklch(0.64 0.19 15)",
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

// ── Theme vocabulary ───────────────────────────────────────────────
// THEME IS NOT CATALYST. Catalyst answers "why did it move today"; theme
// answers "what bucket is this company in". A name can be "PR catalyst + drone
// theme" at once — both are stored, both displayed, both independently
// filterable, and neither overwrites the other.
//
// Must stay in sync with THEME_VOCAB in themes.py (the pipeline is authoritative;
// this copy exists because the browser can't import Python). Regenerate with:
//     py -3 -c "import themes, json; print(json.dumps(themes.THEME_VOCAB))"
//
// NOTE this is distinct from entries[].theme, the DAY-level market-tape
// descriptor ("PM-Led Tape", "Hot Tape") that already exists on all 1,028 days.
// Runner themes are `themes`, plural, always an array.
const V2_THEMES = [
  "AI", "Agriculture", "Amazon", "Apple", "Biotech-Clinical", "Biotech-FDA",
  "Cannabis", "China Rig", "Consumer Brand", "Crypto/Bitcoin", "Cybersecurity",
  "Data Center", "Defense", "Drone/UAV", "EV", "Education", "Fintech/Payments",
  "Gaming/Betting", "Gold/Silver", "Google", "Lithium/Battery", "Logistics",
  "Medical Device", "Microsoft", "Nasdaq Compliance", "Nuclear/Uranium",
  "Nvidia", "Oil & Gas", "OpenAI", "Quantum", "Rare Earth",
  "Reverse Merger/SPAC", "Robotics", "Semiconductor", "Shipping", "Solar",
  "Space", "SpaceX", "Tesla", "Trump/Policy", "Weight Loss/GLP-1",
];
// Named-entity themes need a real relationship, not a mention — the Claude call
// judges that. Listed here so the UI can mark them as relationship-based.
const V2_ENTITY_THEMES = ["Amazon", "Apple", "Google", "Microsoft", "Nvidia",
                          "OpenAI", "SpaceX", "Tesla", "Trump/Policy"];
const V2_THEME_MAX = 3;

// Themes get their own hue family — deliberately violet/magenta, so a theme chip
// is never confused with a catalyst chip at a glance.
function themeColor(name) {
  if (!name) return "oklch(0.6 0.02 250)";
  const h = 265 + (hueHash(String(name), "theme") % 90);   // 265-355: violet→magenta
  return `oklch(0.70 0.14 ${h})`;
}

// ── Vocabulary drift check ─────────────────────────────────────────
// V2_THEMES above is a hand-maintained mirror of THEME_VOCAB in themes.py. The
// pipeline ships its own copy in data2.json as `themeVocab`, and this compares
// the two at load. It does NOT auto-fix — a silent correction would hide the
// fact that the two files disagree. It reports, loudly, so the mismatch gets
// fixed at the source before anyone hand-picks a theme the pipeline can't read.
let _themeDrift = null;
function checkThemeVocab(pipelineVocab) {
  if (!Array.isArray(pipelineVocab) || !pipelineVocab.length) {
    _themeDrift = { checked: false, reason: "data2.json carries no themeVocab yet — run the pipeline once" };
    return _themeDrift;
  }
  const mine = new Set(V2_THEMES), theirs = new Set(pipelineVocab);
  const missingInUi = pipelineVocab.filter((t) => !mine.has(t));
  const extraInUi   = V2_THEMES.filter((t) => !theirs.has(t));
  _themeDrift = {
    checked: true,
    ok: missingInUi.length === 0 && extraInUi.length === 0,
    missingInUi, extraInUi,
  };
  if (!_themeDrift.ok) {
    console.error(
      "%c[THEME VOCABULARY DRIFT]", "color:#ff6a1f;font-weight:800",
      "\n  src/v2schema.jsx V2_THEMES disagrees with themes.py THEME_VOCAB.",
      "\n  In the pipeline but NOT in the UI:", missingInUi.length ? missingInUi : "(none)",
      "\n  In the UI but NOT in the pipeline:", extraInUi.length ? extraInUi : "(none)",
      "\n  Picking a theme from the second list writes a value the pipeline cannot read back.",
      "\n  Fix: py -3 -c \"import themes, json; print(json.dumps(themes.THEME_VOCAB))\"  ->  paste into V2_THEMES",
    );
  }
  return _themeDrift;
}
function themeVocabDrift() { return _themeDrift; }

// A runner with NO themeStatus predates theming entirely. That is NOT "no theme
// found", and conflating them would make a filter on Drone/UAV look like the
// theme never runs when the truth is we weren't tagging yet.
function themeState(r) {
  if (!r || r.themeStatus == null) return "predates";
  if (Array.isArray(r.themes) && r.themes.length) return "ok";
  return r.themeStatus;   // none | nonews | unknown
}

// ── Country vocabulary ─────────────────────────────────────────────
// The 28 ISO-2 codes present in data2.json, ORDERED BY FREQUENCY (measured
// 2026-08-15 over 9,644 runners), same convention as the catalyst list.
//
// Worth knowing why the override matters: 9,177 of 9,644 runners — 95.2% — are
// tagged US, and CN only 184. AskEdgar defaults to USA on names that are
// actually Chinese, so US is systematically over-reported and the manual
// override is the only correction.
//
// Codes are stored, not names: filters, Insights and the Playbook all group on
// the raw code, so writing a name here would fragment those groupings.
const V2_COUNTRIES = [
  "US", "CN", "HK", "IL", "SG", "CA", "GB", "JP", "MY", "TW", "KY", "AU",
  "AE", "GR", "MH", "DE", "KH", "TH", "BE", "ES", "KR", "IT", "CI", "JE",
  "FR", "VG", "IE", "CY",
];
const V2_COUNTRY_NAMES = {
  US: "United States", CN: "China", HK: "Hong Kong", IL: "Israel",
  SG: "Singapore", CA: "Canada", GB: "United Kingdom", JP: "Japan",
  MY: "Malaysia", TW: "Taiwan", KY: "Cayman Islands", AU: "Australia",
  AE: "United Arab Emirates", GR: "Greece", MH: "Marshall Islands",
  DE: "Germany", KH: "Cambodia", TH: "Thailand", BE: "Belgium", ES: "Spain",
  KR: "South Korea", IT: "Italy", CI: "Cote d'Ivoire", JE: "Jersey",
  FR: "France", VG: "British Virgin Islands", IE: "Ireland", CY: "Cyprus",
};
function countryLabel(code) {
  const c = String(code || "").toUpperCase();
  const n = V2_COUNTRY_NAMES[c];
  return n ? `${c} — ${n}` : c;
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

// ── Catalyst vocabulary ────────────────────────────────────────────
// The full controlled list offered in the catalyst dropdown: the v2 vocabulary
// Claude emits plus the legacy v1 tags most of data2.json still carries.
//
// ORDERED BY FREQUENCY in data2.json (counts measured 2026-08-15 over 9,644
// runners / 1,028 days), so the tags actually used land at the top and the long
// tail sits below. Ties broken alphabetically for a stable order.
//
// The zero-count entries at the bottom are deliberate, not dead weight: FDA and
// PHASE-1/2/3 have no occurrences because biotech runners haven't hit the scan
// window yet, not because they're wrong.
const V2_CATALYST_TAGS = [
  "RETAIL PUMP",        // 6779
  "SYMPATHY",           // 1576
  "NEWS-DRIVEN",        //  451
  "RIG",                //  307
  "NO-NEWS",            //  181
  "DILUTION BAIT",      //  105
  "FUNDAMENTAL",        //  103
  "UNDERWRITER MANIP",  //   43
  "OFFERING",           //   21
  "CONTRACT",           //   16
  "COMPLIANCE",         //   15
  "EARNINGS",           //   15
  "ACQUISITION",        //   14
  "MERGER",             //    7
  "HALT-RESUME",        //    3
  "SHARE-BUYBACK",      //    3
  "PHASE-1",            //    2
  "PHASE-2",            //    2
  "LIQUIDITY-TRAP",     //    1
  "BANKRUPTCY",         //    0
  "FDA",                //    0
  "PHASE-3",            //    0
];

// ── Manual grade (replaces the auto Setup Score) ───────────────────
// The label scale and its colours. Storage and averaging live in grades.jsx.
// Index in this array IS the numeric value used to average grades (F=0 … A++=6),
// so the order is load-bearing — don't reorder it.
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
// getGrade / setGrade used to live here against localStorage. Grades are now
// per-user documents in Firestore so the whole desk sees each other's — see
// grades.jsx, which owns window.getGrade (the AVERAGED grade) and
// window.grSetMyGrade (your own vote only).

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
  // behaviorTag is no longer read here — it moved to the shared Firestore
  // override layer (overrides.jsx) and is layered on by ovrMergeRunner at
  // render time, alongside catalyst / country / themes.
  const behaviorTag = r.behaviorTag != null ? r.behaviorTag : "";
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
    setupGrade: r.setupGrade != null ? r.setupGrade : null,
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
  FLOAT_TIERS,
  floatTierRange,
  SESSION_BOUNDS,
  sessionRange,
  normalizeSector,
  SECTOR_CATEGORIES,
  catalystColor,
  floatTierColor,
  countryColor,
  sectorColor,
  V2_CATALYST_TAGS,
  V2_COUNTRIES,
  V2_COUNTRY_NAMES,
  countryLabel,
  V2_THEMES,
  V2_ENTITY_THEMES,
  V2_THEME_MAX,
  themeColor,
  themeState,
  checkThemeVocab,
  themeVocabDrift,
  GRADES,
  gradeRank,
  gradeColor,
  normalizeRunnerV2,
  CATALYST_COLORS,
  FLOATTIER_COLORS,
});
