// Heat Gauge v2 — dashboard metrics engine.
// Pure functions that turn normalized entries/runners into the numbers the
// Overview dashboard renders: setup scores, daily KPI series, vs-30D deltas,
// factor drivers, distributions, calendars, catalyst counts, and copy.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => v != null && Number.isFinite(Number(v));
const mean = (a) => (a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : 0);
function hodValM(r) { return r.hodExact != null ? r.hodExact : (r.hod != null ? r.hod : null); }

// Float-tier "quality" — smaller float = more explosive = higher quality score.
const FLOAT_TIER_QUALITY = { "Nano": 100, "Micro": 85, "Low": 70, "Mid": 55, "Thick": 40, "Mega Thick": 25 };
function floatTierQuality(tier) { return FLOAT_TIER_QUALITY[tier] != null ? FLOAT_TIER_QUALITY[tier] : 50; }

// Per-runner 0–100 setup score: HOD strength + fade quality + rel vol + float.
function setupScore(r) {
  const hod = hodValM(r);
  const hodStr = hod != null ? clamp(hod / 300, 0, 1) * 100 : 0;
  const fadeQ = r.fade != null ? (1 - clamp(r.fade / 60, 0, 1)) * 100 : 50;
  const rv = r.relVol != null ? clamp(r.relVol / 30, 0, 1) * 100 : 40;
  const fq = floatTierQuality(r.floatTier);
  return Math.round(hodStr * 0.40 + fadeQ * 0.25 + rv * 0.20 + fq * 0.15);
}

// KPI bundle for an arbitrary set of runners.
function metricsOfRunners(runners) {
  const n = runners.length;
  if (!n) return { n: 0, avgHod: 0, avgFade: 0, pmLead: 0, ssr: 0, gapQuality: 0, floatQuality: 0, avgVolDollar: 0 };
  const hod = runners.map(hodValM).filter(finite);
  const fade = runners.map((r) => r.fade).filter(finite);
  const vol = runners.map((r) => r.volDollar).filter(finite);
  const pm = runners.filter((r) => r.session === "premarket").length;
  const ss = runners.filter((r) => r.ssr).length;
  const gapQ = mean(runners.map((r) => clamp(Math.max(Number(r.gapPct) || 0, 0) / 40, 0, 1) * 100));
  const floatQ = mean(runners.map((r) => floatTierQuality(r.floatTier)));
  return {
    n,
    avgHod: mean(hod),
    avgFade: mean(fade),
    pmLead: (pm / n) * 100,
    ssr: (ss / n) * 100,
    gapQuality: gapQ,
    floatQuality: floatQ,
    avgVolDollar: mean(vol),
  };
}

function confidenceScore(m) {
  const hodStr = clamp(m.avgHod / 250, 0, 1) * 100;
  const fadeQ = (1 - clamp(m.avgFade / 60, 0, 1)) * 100;
  return Math.round(hodStr * 0.45 + fadeQ * 0.35 + m.floatQuality * 0.20);
}

function daysBetweenM(aISO, bISO) {
  return Math.round((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / 86400000);
}

// One row per day (oldest→newest) with all KPI metrics + heat score/state.
function buildDailySeries(scoredEntries) {
  const sorted = [...scoredEntries].sort((a, b) => (a.date < b.date ? -1 : 1));
  return sorted.map((e) => {
    const m = metricsOfRunners(e.runners || []);
    return {
      date: e.date,
      score: e.score != null ? e.score : 0,
      state: e.state || "NEUTRAL",
      confidence: confidenceScore(m),
      ...m,
    };
  });
}

// The KPI cards. Each: value today, 30-day average, delta, sparkline, and the
// direction that counts as "good" (for delta coloring).
const KPI_DEFS = [
  { key: "avgHod",       label: "AVG HOD",       fmt: (v) => `+${Math.round(v)}%`, better: 1,  color: "oklch(0.72 0.15 150)" },
  { key: "avgFade",      label: "AVG FADE",      fmt: (v) => `${Math.round(v)}%`,  better: -1, color: "oklch(0.68 0.20 25)" },
  { key: "pmLead",       label: "PM LEAD %",     fmt: (v) => `${Math.round(v)}%`,  better: -1, color: "oklch(0.75 0.15 70)" },
  { key: "ssr",          label: "SSR TRIGGER %", fmt: (v) => `${Math.round(v)}%`,  better: 0,  color: "oklch(0.70 0.14 210)" },
  { key: "gapQuality",   label: "GAP QUALITY",   fmt: (v) => `${Math.round(v)}%`,  better: 1,  color: "oklch(0.66 0.16 300)" },
  { key: "floatQuality", label: "FLOAT QUALITY", fmt: (v) => `${Math.round(v)}%`,  better: 1,  color: "oklch(0.72 0.13 190)" },
  { key: "confidence",   label: "CONFIDENCE",    fmt: (v) => `${Math.round(v)}%`,  better: 1,  color: "oklch(0.70 0.16 250)" },
];

function computeKpis(series) {
  if (!series.length) return [];
  const today = series[series.length - 1];
  const latestDate = today.date;
  const prior = series.slice(0, -1).filter((d) => daysBetweenM(d.date, latestDate) <= 30);
  const sparkN = 12;
  return KPI_DEFS.map((def) => {
    const value = today[def.key] || 0;
    const avg30 = prior.length ? mean(prior.map((d) => d[def.key] || 0)) : value;
    const delta = value - avg30;
    const spark = series.slice(-sparkN).map((d) => d[def.key] || 0);
    // "good" delta → positive sentiment
    let sentiment = 0;
    if (def.better !== 0 && Math.abs(delta) > 0.5) sentiment = (def.better > 0 ? delta > 0 : delta < 0) ? 1 : -1;
    return { ...def, value, avg30, delta, spark, sentiment };
  });
}

// Consistency over the last 30 days: share of days matching the most-recent state.
function consistency30d(series) {
  if (!series.length) return 0;
  const window = series.filter((d) => daysBetweenM(d.date, series[series.length - 1].date) <= 30);
  if (!window.length) return 0;
  const cur = window[window.length - 1].state;
  const match = window.filter((d) => d.state === cur).length;
  return (match / window.length) * 100;
}

// "What's Driving Today" — factor strength bars (0–100), each its own color.
function computeDrivers(series) {
  if (!series.length) return [];
  const today = series[series.length - 1];
  const prior = series.slice(0, -1).filter((d) => daysBetweenM(d.date, today.date) <= 30);
  const avg = (k) => (prior.length ? mean(prior.map((d) => d[k] || 0)) : (today[k] || 0));
  const relBar = (cur, base, invert) => {
    if (!base) return clamp(cur, 0, 100);
    const pct = (cur - base) / base;
    return clamp(50 + (invert ? -pct : pct) * 100, 0, 100);
  };
  return [
    { key: "momentum",  label: "Momentum",         value: Math.round(clamp(today.avgHod / 250, 0, 1) * 100), color: "oklch(0.70 0.16 250)" },
    { key: "hodVs30",   label: "Avg HOD vs 30D",   value: Math.round(relBar(today.avgHod, avg("avgHod"), false)), color: "oklch(0.72 0.15 150)" },
    { key: "fadeVs30",  label: "Avg Fade vs 30D",  value: Math.round(relBar(today.avgFade, avg("avgFade"), true)), color: "oklch(0.68 0.20 25)" },
    { key: "gapQ",      label: "Gap Quality",      value: Math.round(today.gapQuality), color: "oklch(0.66 0.16 300)" },
    { key: "pmLead",    label: "PM Lead %",        value: Math.round(today.pmLead), color: "oklch(0.75 0.15 70)" },
    { key: "ssr",       label: "SSR Trigger %",    value: Math.round(today.ssr), color: "oklch(0.70 0.14 210)" },
    { key: "consist",   label: "Consistency 30D",  value: Math.round(consistency30d(series)), color: "oklch(0.72 0.13 190)" },
  ];
}

// Runners across the last `days` calendar days (respecting an optional predicate).
function runnersInWindow(entries, days, predicate) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!sorted.length) return [];
  const latest = sorted[0].date;
  const out = [];
  for (const e of sorted) {
    if (daysBetweenM(e.date, latest) > days) continue;
    for (const r of (e.runners || [])) if (!predicate || predicate(r)) out.push(r);
  }
  return out;
}

// Last `days` of daily state/score (newest last) for the trend line.
function heatCalendar(series, days) {
  if (!series.length) return [];
  const latest = series[series.length - 1].date;
  return series.filter((d) => daysBetweenM(d.date, latest) <= days);
}

// ── Trailing windows anchored to a chosen day ──────────────────────
// `anchorDate` lets the dashboard re-compute everything for a day the user
// clicked in the rolling strip, not just the most recent one.
function anchorIndex(list, anchorDate) {
  if (!list.length) return -1;
  if (!anchorDate) return list.length - 1;
  const i = list.findIndex((d) => d.date === anchorDate);
  return i >= 0 ? i : list.length - 1;
}
function trailingDays(series, anchorDate, n) {
  const end = anchorIndex(series, anchorDate);
  if (end < 0) return [];
  return series.slice(Math.max(0, end - n + 1), end + 1);
}
function avgScoreWindow(series, anchorDate, n) {
  const w = trailingDays(series, anchorDate, n);
  return w.length ? mean(w.map((d) => d.score || 0)) : 0;
}

// Price buckets used by the "dominant themes" readout.
const PRICE_BUCKETS = [
  { key: "Under $1", test: (o) => o != null && o < 1 },
  { key: "$1–$10",   test: (o) => o != null && o >= 1 && o < 10 },
  { key: "$10+",     test: (o) => o != null && o >= 10 },
];
function priceBucketOf(open) {
  const b = PRICE_BUCKETS.find((x) => x.test(Number(open)));
  return b ? b.key : null;
}

// Top country / float tier / price range / sector / catalyst by runner count
// across the `days` trading days ending at anchorDate.
function dominantThemes(entries, anchorDate, days, predicate) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const end = anchorIndex(sorted, anchorDate);
  if (end < 0) return { total: 0 };
  const runners = [];
  for (let i = Math.max(0, end - days + 1); i <= end; i++) {
    for (const r of (sorted[i].runners || [])) if (!predicate || predicate(r)) runners.push(r);
  }
  const topOf = (fn) => {
    const c = {};
    for (const r of runners) { const v = fn(r); if (v) c[v] = (c[v] || 0) + 1; }
    const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return e ? { value: e[0], count: e[1] } : null;
  };
  return {
    country:    topOf((r) => r.country),
    floatTier:  topOf((r) => r.floatTier),
    priceRange: topOf((r) => priceBucketOf(r.open)),
    sector:     topOf((r) => r.sectorNorm),
    catalyst:   topOf((r) => r.tag),
    total: runners.length,
  };
}

// ── Heat calendar grid: weeks as rows, Mon–Fri as columns ──────────
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function buildCalendarGrid(series, tradingDays) {
  if (!series.length) return [];
  const last = series.slice(-(tradingDays || 30)); // oldest→newest
  const map = {};
  for (const d of last) map[d.date] = d;
  const firstD = new Date(last[0].date + "T00:00:00");
  const lastD = new Date(last[last.length - 1].date + "T00:00:00");
  // back up to the Monday of the first week
  const cur = new Date(firstD);
  cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
  const weeks = [];
  let guard = 0;
  while (cur <= lastD && guard++ < 15) {
    const week = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(cur);
      d.setDate(cur.getDate() + i);
      const iso = isoOf(d);
      week.push({
        iso,
        day: d.getDate(),
        month: d.toLocaleString("en-US", { month: "short" }),
        data: map[iso] || null,
      });
    }
    weeks.push(week);
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

// ── True month grid (Sun–Sat) for the heat calendar ────────────────
const MONTH_LABELS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
function buildMonthGrid(year, month, series) {
  const map = {};
  for (const d of series) map[d.date] = d;
  const daysIn = new Date(year, month + 1, 0).getDate();
  const startDow = new Date(year, month, 1).getDay(); // 0 = Sun
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = new Date(year, month, d).getDay();
    cells.push({ iso, day: d, dow, weekend: dow === 0 || dow === 6, data: map[iso] || null });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ── Top-movers range aggregation ───────────────────────────────────
// Dedupe by ticker across the window, keeping the row with the best HOD %.
function moversForRange(entries, range, custom, predicate) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  if (!sorted.length) return [];
  // Calendar-year ranges are anchored to the newest year present in the data so
  // they still work on a historical dataset.
  const refYear = Number(sorted[0].date.slice(0, 4));
  const inYear = (y) => sorted.filter((e) => Number(e.date.slice(0, 4)) === y);

  let subset;
  if (range === "d5") subset = sorted.slice(0, 5);
  else if (range === "d30") subset = sorted.slice(0, 30);
  else if (range === "ytd") subset = inYear(refYear);
  else if (range === "lastyear") subset = inYear(refYear - 1);
  else if (range === "twoyears") subset = inYear(refYear - 2);
  else if (range === "custom") {
    const from = custom && custom.from, to = custom && custom.to;
    subset = (from && to) ? sorted.filter((e) => e.date >= from && e.date <= to) : sorted.slice(0, 1);
  } else { // "today" — the selected day, else the most recent
    const day = custom && custom.day;
    const hit = day ? sorted.find((e) => e.date === day) : null;
    subset = hit ? [hit] : sorted.slice(0, 1);
  }
  // No dedup: every occurrence of a ticker in the window is its own row, so a
  // name that ran on several days shows up once per day.
  const out = [];
  for (const e of subset) {
    for (const r of (e.runners || [])) {
      if (predicate && !predicate(r)) continue;
      out.push({ ...r, _date: r._date || e.date });
    }
  }
  return out;
}

// ── HOD time-of-day distribution ───────────────────────────────────
// 15-minute buckets from 4:00 AM to 8:00 PM ET, grouped into session zones.
const HOD_ZONES = [
  { key: "pre",   label: "PREMARKET",    start: 240,  end: 570,  color: "oklch(0.68 0.15 255)" },
  { key: "open",  label: "MARKET OPEN",  start: 570,  end: 720,  color: "oklch(0.78 0.16 150)" },
  { key: "mid",   label: "MID SESSION",  start: 720,  end: 840,  color: "oklch(0.82 0.15 95)" },
  { key: "close", label: "MARKET CLOSE", start: 840,  end: 960,  color: "oklch(0.72 0.18 45)" },
  { key: "after", label: "AFTER HOURS",  start: 960,  end: 1200, color: "oklch(0.66 0.16 305)" },
];
const HOD_BUCKET_MIN = 15;
const HOD_START = 240, HOD_END = 1200;

function fmtClockMin(min) {
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  let hh = h % 12; if (hh === 0) hh = 12;
  return m === 0 ? `${hh}${ap}` : `${hh}:${String(m).padStart(2, "0")}${ap}`;
}

function hodTimeDistribution(entries, days, predicate) {
  const runners = runnersInWindow(entries, days, predicate);
  const nB = Math.round((HOD_END - HOD_START) / HOD_BUCKET_MIN);
  const counts = new Array(nB).fill(0);
  let placed = 0;
  for (const r of runners) {
    const m = window.minutesFromExact(r.hodTimeExact);
    if (m == null || m < HOD_START || m >= HOD_END) continue;
    const i = Math.floor((m - HOD_START) / HOD_BUCKET_MIN);
    if (i >= 0 && i < nB) { counts[i]++; placed++; }
  }
  const zones = HOD_ZONES.map((z) => {
    const from = Math.max(0, Math.round((z.start - HOD_START) / HOD_BUCKET_MIN));
    const to = Math.min(nB, Math.round((z.end - HOD_START) / HOD_BUCKET_MIN));
    const buckets = [];
    for (let i = from; i < to; i++) {
      buckets.push({ i, start: HOD_START + i * HOD_BUCKET_MIN, count: counts[i] });
    }
    return { ...z, buckets, total: buckets.reduce((s, b) => s + b.count, 0) };
  });
  return { zones, max: Math.max(1, ...counts), total: placed };
}

// Catalyst counts for a single entry's runners.
function catalystCounts(entry) {
  const counts = {};
  for (const r of (entry.runners || [])) {
    if (r.tag) counts[r.tag] = (counts[r.tag] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// Top movers for a day, ranked by setup score, with the score attached.
function topMovers(entry, predicate, limit) {
  const rs = (entry.runners || []).filter((r) => !predicate || predicate(r)).map((r) => ({ ...r, setup: setupScore(r) }));
  rs.sort((a, b) => b.setup - a.setup);
  return limit ? rs.slice(0, limit) : rs;
}

// Market state → 3-line recommendation copy.
function marketRec(state) {
  const REC = {
    HOT: "Tape is hot — press A+ setups with conviction and let winners run. Session HODs are buyable on volume confirmation. Add into strength on clean HOD clearouts.",
    NEUTRAL: "Selective tape — one name, quicker profits. Take first targets faster and keep stops tight. Confirm HOD timing before any entry; don't force size.",
    COLD: "A+ only — if it's not obvious, sit out. Minimum size, fastest exits, no runners. Treat premarket HODs as distribution traps, not entries.",
    EMPTY: "No data loaded for this session.",
  };
  return REC[state] || REC.NEUTRAL;
}

Object.assign(window, {
  setupScore,
  floatTierQuality,
  metricsOfRunners,
  confidenceScore,
  buildDailySeries,
  computeKpis,
  computeDrivers,
  consistency30d,
  runnersInWindow,
  trailingDays,
  avgScoreWindow,
  dominantThemes,
  priceBucketOf,
  PRICE_BUCKETS,
  heatCalendar,
  buildCalendarGrid,
  buildMonthGrid,
  moversForRange,
  MONTH_LABELS,
  hodTimeDistribution,
  fmtClockMin,
  HOD_ZONES,
  catalystCounts,
  topMovers,
  marketRec,
  KPI_DEFS,
});
