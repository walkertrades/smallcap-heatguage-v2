// Heat + Direction engine (v2 scoring), approved 2026-11-24.
// Plain script (no JSX) so it can be unit-tested outside the browser.
//
// HEAT is a 0-100 rank of today against the trailing year, built from four
// counts over the day's top-10 list. Only names that traded at least
// $20M count (volume x VWAP) -- thin rights/warrant tickers are ignored.
//
//   30%  names over 100% HOD
//   30%  gappers over 50%
//   25%  average HOD % of the counted names
//   15%  names that closed up 50%+
//
// Each input is ranked against the prior 250 trading days (percentile), then
// the four ranks are blended. Zones match the dial: <45 COLD, 45-68 NEUTRAL,
// >=69 HOT.
//
// DIRECTION is separate from the level:
//   COOLING     names over 100% per day, last 5 days, is at least 20% below the
//               prior 5 days AND the last 2 days are not back above the 5-day
//               average. Steps the playbook down one level.
//   HEATING     under 60% of 30%+ gappers closed below their open (5-day) AND
//               the last 2 days are above the 5-day average. Display only.
//   GREEN LIGHT Heat is HOT and under 60% of gappers closed red (5-day).
//               Can show together with HEATING.
//
// History before HEAT2_HISTORY_START is not used for ranking: the pre-2026
// backfill has reverse-split fakes in it. Days that cannot be ranked (too
// little history, or no runner list) keep the legacy score.
(function (root) {
  var HEAT2 = {
    HISTORY_START: "2025-10-01",
    DV_FLOOR: 20e6,
    WINDOW: 250,
    MIN_HISTORY: 60,
    WEIGHTS: { names100: 0.30, gappers50: 0.30, avgHod: 0.25, closedUp50: 0.15 },
    COOL_DROP: 0.8,
    GAP_RED_MAX: 0.60,
    HOT: 69,
    COLD_TOP: 45,
  };

  function parseVol(s) {
    var m = /^([\d.]+)\s*([KMB]?)/.exec(String(s == null ? "" : s));
    if (!m) return 0;
    var mult = { K: 1e3, M: 1e6, B: 1e9, "": 1 }[m[2]];
    return parseFloat(m[1]) * mult;
  }
  function dollarVol(r) { return parseVol(r.volRaw) * (Number(r.vwap) || 0); }
  function hodOf(r) { return r.hodExact != null ? Number(r.hodExact) : Number(r.hod); }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
  // numpy rounds half to even; match it so scores agree with the backtest.
  function roundHalfEven(x) {
    var f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }

  // One row of raw daily inputs from an entry's runner list.
  function dayInputs(entry) {
    var all = entry.runners || [];
    var R = [];
    for (var i = 0; i < all.length; i++) if (dollarVol(all[i]) >= HEAT2.DV_FLOOR) R.push(all[i]);
    var hods = R.map(hodOf);
    var big = R.filter(function (r) { return hodOf(r) >= 100; });
    var gappers = R.filter(function (r) { return (Number(r.gapPct) || 0) >= 30; });
    var kept = [];
    big.forEach(function (r) {
      var pc = Number(r.prevClose), hi = Number(r.high), c = Number(r.close);
      if (pc && hi && hi > pc) kept.push((c - pc) / (hi - pc));
    });
    var top3 = hods.slice().sort(function (a, b) { return b - a; }).slice(0, 3).map(function (h) { return Math.min(h, 600); });
    return {
      date: entry.date,
      counted: R.length,
      cut: all.length - R.length,
      names100: big.length,
      gappers50: R.filter(function (r) { return (Number(r.gapPct) || 0) >= 50; }).length,
      avgHod: hods.length ? mean(hods) : 0,
      closedUp50: R.filter(function (r) {
        var pc = Number(r.prevClose);
        return pc ? ((Number(r.close) - pc) / pc) * 100 >= 50 : false;
      }).length,
      gapRed: gappers.length
        ? mean(gappers.map(function (r) { var o = Number(r.open); return o ? (Number(r.close) < o ? 1 : 0) : 0; }))
        : NaN,
      kept: kept.length ? mean(kept) : NaN,
      top3: top3.length ? mean(top3) : 0,
      // descriptive only, used by the AI trend Tape line -- never scored
      aboveVwap: R.filter(function (r) { return r.vsVwap === "above"; }).length,
      dollarVol: R.reduce(function (s, r) { return s + dollarVol(r); }, 0),
    };
  }

  function pctRank(vals, i) {
    var lo = Math.max(0, i - HEAT2.WINDOW), n = i - lo, v = vals[i], less = 0, eq = 0;
    for (var k = lo; k < i; k++) { if (vals[k] < v) less++; else if (vals[k] === v) eq++; }
    return ((less + 0.5 * eq) / n) * 100;
  }
  // Rolling mean over the last `win` rows ending at i, skipping NaN, needing
  // at least `minN` real values (pandas rolling(win, min_periods=minN).mean()).
  function rollMean(vals, i, win, minN) {
    var s = 0, n = 0;
    for (var k = Math.max(0, i - win + 1); k <= i; k++) if (!isNaN(vals[k])) { s += vals[k]; n++; }
    var need = minN == null ? win : minN;
    if (i - win + 1 < 0 && minN == null) return NaN;
    return n >= need ? s / n : NaN;
  }

  // entries: raw day entries (any order). Returns { [date]: result }.
  function computeHeatDirection(entries) {
    var rows = (entries || [])
      .filter(function (e) { return e && e.date && e.date >= HEAT2.HISTORY_START && (e.runners || []).length; })
      .slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })
      .map(dayInputs);
    var col = function (k) { return rows.map(function (r) { return r[k]; }); };
    var B = col("names100"), G = col("gappers50"), A = col("avgHod"), C = col("closedUp50");
    var GR = col("gapRed"), K = col("kept"), T3 = col("top3");
    var t5 = rows.map(function (_, i) { return rollMean(B, i, 5); });
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var heat = null;
      if (i >= HEAT2.MIN_HISTORY) {
        var W = HEAT2.WEIGHTS;
        heat = roundHalfEven(W.names100 * pctRank(B, i) + W.gappers50 * pctRank(G, i) + W.avgHod * pctRank(A, i) + W.closedUp50 * pctRank(C, i));
      }
      var p5 = i >= 5 ? t5[i - 5] : NaN;
      var a2 = rollMean(B, i, 2);
      var gapRed5 = rollMean(GR, i, 5, 3);
      var kept5 = rollMean(K, i, 5, 3);
      var lead3 = rollMean(T3, i, 3, 2);
      var leadBase = i >= 3 ? rollMean(T3, i - 3, 10) : NaN;
      var cooling = !isNaN(t5[i]) && !isNaN(p5) && t5[i] <= p5 * HEAT2.COOL_DROP && a2 <= t5[i];
      var gappersHolding = !isNaN(gapRed5) && gapRed5 < HEAT2.GAP_RED_MAX;
      var heating = gappersHolding && !isNaN(t5[i]) && a2 > t5[i] && !cooling;
      var greenLight = heat != null && heat >= HEAT2.HOT && gappersHolding && !cooling;
      var zone = heat == null ? null : heat >= HEAT2.HOT ? "HOT" : heat >= HEAT2.COLD_TOP ? "NEUTRAL" : "COLD";
      out[r.date] = {
        heat: heat, zone: zone,
        direction: cooling ? "COOLING" : heating ? "HEATING" : "STEADY",
        cooling: cooling, heating: heating, greenLight: greenLight,
        inputs: { names100: r.names100, gappers50: r.gappers50, avgHod: r.avgHod, closedUp50: r.closedUp50, counted: r.counted, cut: r.cut,
          aboveVwap: r.aboveVwap, dollarVol: r.dollarVol,
          dollarVolPrior5: i >= 5 ? mean(rows.slice(i - 5, i).map(function (x) { return x.dollarVol; })) : NaN,
          names100Prev: i >= 1 ? rows[i - 1].names100 : null },
        tells: { last5: t5[i], prior5: p5, last2: a2, gapRed5: gapRed5, kept5: kept5, leadRatio: leadBase ? lead3 / leadBase : NaN },
      };
    }
    return out;
  }

  // Cooling steps the playbook down one level; nothing steps it up.
  function playbookStateFor(zone, cooling) {
    if (!zone) return "EMPTY";
    if (!cooling) return zone;
    return zone === "HOT" ? "NEUTRAL" : "COLD";
  }

  var api = { HEAT2: HEAT2, computeHeatDirection: computeHeatDirection, playbookStateFor: playbookStateFor, heat2DayInputs: dayInputs, heat2DollarVol: dollarVol };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== "undefined" ? window : null);
