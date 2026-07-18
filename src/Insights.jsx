// Heat Gauge v2 — Insights layer: AI trend summary bar, filter panel,
// and $ volume trend chart. All three read the normalized v2 runner fields.

const { useState: useState_I, useMemo: useMemo_I } = React;

// ── Filter model ───────────────────────────────────────────────────
// Chip-toggle dims (small, enumerable sets) vs. search dims (large text lists).
const CHIP_DIMS = [
  { key: "tag",       label: "Catalyst",   get: (r) => r.tag || null },
  { key: "floatTier", label: "Float Tier", get: (r) => r.floatTier || null },
  { key: "session",   label: "Session",    get: (r) => r.session || null },
];
const SEARCH_DIMS = [
  { key: "sector",  label: "Sector",  get: (r) => r.sectorNorm || window.normalizeSector(r.sector) },
  { key: "country", label: "Country", get: (r) => r.country || null },
];
const SET_DIMS = [...CHIP_DIMS, ...SEARCH_DIMS];
const TIER_ORDER = ["Nano", "Micro", "Low", "Mid", "Thick", "Mega Thick"];
const SESSION_ORDER = ["premarket", "morning", "afternoon", "after-hours"];

// Range/threshold presets
const PRICE_PRESETS = [
  { key: "u1",   label: "Under $1", test: (o) => o != null && o < 1 },
  { key: "1_5",  label: "$1–$5",    test: (o) => o != null && o >= 1 && o < 5 },
  { key: "5_20", label: "$5–$20",   test: (o) => o != null && o >= 5 && o < 20 },
  { key: "20p",  label: "$20+",     test: (o) => o != null && o >= 20 },
];
const HOD_PRESETS = [
  { key: 50,  label: "50%+" }, { key: 100, label: "100%+" },
  { key: 200, label: "200%+" }, { key: 500, label: "500%+" },
];
const VOL_PRESETS = [
  { key: 500000,  label: "500K+" }, { key: 1000000, label: "1M+" }, { key: 5000000, label: "5M+" },
];

function runnerHodVal(r) { return r.hodExact != null ? r.hodExact : (r.hod != null ? r.hod : null); }

function buildFilterOptions(entries) {
  const sets = {};
  for (const d of SET_DIMS) sets[d.key] = new Set();
  for (const e of entries) {
    for (const r of (e.runners || [])) {
      for (const d of SET_DIMS) {
        const v = d.get(r);
        if (v != null && v !== "") sets[d.key].add(v);
      }
    }
  }
  const opts = {};
  for (const d of SET_DIMS) {
    let arr = Array.from(sets[d.key]);
    if (d.key === "floatTier") arr.sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
    else if (d.key === "session") arr.sort((a, b) => SESSION_ORDER.indexOf(a) - SESSION_ORDER.indexOf(b));
    else arr.sort();
    opts[d.key] = arr;
  }
  return opts;
}

// filterState = { <setDim>:Set, price:key|null, minHod:num|null, minVol:num|null, ssr:bool, rs:bool }
function emptyFilterState() {
  const s = {};
  for (const d of SET_DIMS) s[d.key] = new Set();
  s.price = null;
  s.minHod = null;
  s.minVol = null;
  s.ssr = false;
  s.rs = false;
  return s;
}
function filterActiveCount(state) {
  let n = 0;
  for (const d of SET_DIMS) n += state[d.key].size;
  if (state.price) n++;
  if (state.minHod) n++;
  if (state.minVol) n++;
  if (state.ssr) n++;
  if (state.rs) n++;
  return n;
}
function makePredicate(state) {
  const priceP = state.price ? PRICE_PRESETS.find((p) => p.key === state.price) : null;
  return (r) => {
    for (const d of SET_DIMS) {
      const sel = state[d.key];
      if (sel && sel.size > 0) {
        const v = d.get(r);
        if (!sel.has(v)) return false;
      }
    }
    if (priceP && !priceP.test(r.open)) return false;
    if (state.minHod) {
      const h = runnerHodVal(r);
      if (h == null || h < state.minHod) return false;
    }
    if (state.minVol) {
      const sv = window.parseShareVol(r.volRaw);
      if (sv == null || sv < state.minVol) return false;
    }
    if (state.ssr && !r.ssr) return false;
    if (state.rs && !r.reverseSplit) return false;
    return true;
  };
}

function chipColorFor(dimKey, value) {
  if (dimKey === "tag") return window.catalystColor(value);
  if (dimKey === "floatTier") return window.floatTierColor(value);
  if (dimKey === "sector") return window.sectorColor(value);
  if (dimKey === "country") return window.countryColor(value);
  if (dimKey === "session") return "oklch(0.6 0.08 250)";
  return "oklch(0.6 0.02 250)";
}
function optionLabel(dimKey, value) {
  if (dimKey === "session") return window.sessionLabel(value);
  return value;
}

function cloneFilterState(state) {
  const next = { price: state.price, minHod: state.minHod, minVol: state.minVol, ssr: state.ssr, rs: state.rs };
  for (const d of SET_DIMS) next[d.key] = new Set(state[d.key]);
  return next;
}

// ── Searchable multi-select (sector / country) ─────────────────────
function SearchMultiSelect({ dimKey, options, selected, onToggle }) {
  const [q, setQ] = useState_I("");
  const query = q.trim().toLowerCase();
  const matches = query
    ? options.filter((o) => String(o).toLowerCase().includes(query) && !selected.has(o)).slice(0, 10)
    : [];
  return (
    <div className="filter-search">
      {selected.size > 0 && (
        <div className="filter-search-selected">
          {Array.from(selected).map((v) => (
            <button key={v} className="filter-opt on" style={{ "--opt-color": chipColorFor(dimKey, v) }} onClick={() => onToggle(dimKey, v)}>
              {optionLabel(dimKey, v)} <span className="filter-opt-x">×</span>
            </button>
          ))}
        </div>
      )}
      <input
        className="filter-search-input"
        placeholder={`Type to filter ${dimKey}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {matches.length > 0 && (
        <div className="filter-search-results">
          {matches.map((v) => (
            <button key={v} className="filter-opt" style={{ "--opt-color": chipColorFor(dimKey, v) }}
              onClick={() => { onToggle(dimKey, v); setQ(""); }}>
              {optionLabel(dimKey, v)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Filter panel ───────────────────────────────────────────────────
function FilterPanel({ entries, state, onChange, matchCount, totalCount }) {
  const [open, setOpen] = useState_I(false);
  const options = useMemo_I(() => buildFilterOptions(entries), [entries]);
  const active = filterActiveCount(state);

  const toggle = (dimKey, value) => {
    const next = cloneFilterState(state);
    if (next[dimKey].has(value)) next[dimKey].delete(value);
    else next[dimKey].add(value);
    onChange(next);
  };
  const setScalar = (key, value) => {
    const next = cloneFilterState(state);
    next[key] = next[key] === value ? null : value; // click active again = clear
    onChange(next);
  };
  const toggleBool = (key) => {
    const next = cloneFilterState(state);
    next[key] = !next[key];
    onChange(next);
  };
  const clearAll = () => onChange(emptyFilterState());

  return (
    <div className="filter-panel">
      <div className="filter-bar" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
        <span className="filter-icon" aria-hidden="true">⛃</span>
        <span className="label">FILTERS</span>
        {active > 0 && <span className="filter-count">{active}</span>}
        <span className="filter-match">{matchCount} / {totalCount} runners</span>
        <span className="filter-chev">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="filter-body">
          {CHIP_DIMS.map((d) => (
            <div key={d.key} className="filter-group">
              <div className="filter-group-label">{d.label}</div>
              <div className="filter-options">
                {options[d.key].length === 0 && <span className="filter-none">—</span>}
                {options[d.key].map((v) => {
                  const on = state[d.key].has(v);
                  return (
                    <button key={v} className={`filter-opt ${on ? "on" : ""}`}
                      style={{ "--opt-color": chipColorFor(d.key, v) }}
                      onClick={() => toggle(d.key, v)}>{optionLabel(d.key, v)}</button>
                  );
                })}
              </div>
            </div>
          ))}

          {SEARCH_DIMS.map((d) => (
            <div key={d.key} className="filter-group">
              <div className="filter-group-label">{d.label}</div>
              <SearchMultiSelect dimKey={d.key} options={options[d.key]} selected={state[d.key]} onToggle={toggle} />
            </div>
          ))}

          <div className="filter-group">
            <div className="filter-group-label">Price (open)</div>
            <div className="filter-options">
              {PRICE_PRESETS.map((p) => (
                <button key={p.key} className={`filter-opt ${state.price === p.key ? "on" : ""}`}
                  onClick={() => setScalar("price", p.key)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="filter-group-label">Min HOD %</div>
            <div className="filter-options">
              {HOD_PRESETS.map((p) => (
                <button key={p.key} className={`filter-opt ${state.minHod === p.key ? "on" : ""}`}
                  onClick={() => setScalar("minHod", p.key)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="filter-group-label">Min Volume</div>
            <div className="filter-options">
              {VOL_PRESETS.map((p) => (
                <button key={p.key} className={`filter-opt ${state.minVol === p.key ? "on" : ""}`}
                  onClick={() => setScalar("minVol", p.key)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="filter-group-label">Flags</div>
            <div className="filter-options">
              <button className={`filter-opt filter-warn ${state.ssr ? "on" : ""}`} onClick={() => toggleBool("ssr")}>SSR</button>
              <button className={`filter-opt filter-warn ${state.rs ? "on" : ""}`} onClick={() => toggleBool("rs")}>Reverse Split</button>
            </div>
          </div>

          {active > 0 && (
            <button className="filter-clear" onClick={clearAll}>Clear all filters ({active})</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── $ volume trend chart ───────────────────────────────────────────
const RANGES = [
  { key: "3M", days: 92, mode: "cal" },
  { key: "6M", days: 183, mode: "cal" },
  { key: "12M", days: 366, mode: "cal" },
  { key: "YTD", mode: "ytd" },
  { key: "custom", mode: "custom" },
];

function daysBetween(aISO, bISO) {
  const a = new Date(aISO + "T00:00:00");
  const b = new Date(bISO + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

const MA_PERIOD = 21;

// EMA / SMA over the full series so the line is meaningful even at a window's edge.
function movingAverage(values, period, type) {
  const out = new Array(values.length).fill(null);
  if (type === "sma") {
    for (let i = 0; i < values.length; i++) {
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        out[i] = s / period;
      }
    }
  } else { // ema
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Given the oldest→newest perDay series, return inclusive [start,end] indices
// for the selected range.
function windowBounds(perDay, range, customFrom, customTo) {
  const n = perDay.length;
  if (n === 0) return [0, -1];
  const rd = RANGES.find((r) => r.key === range) || RANGES[0];
  if (rd.mode === "count") return [Math.max(0, n - rd.days), n - 1];
  if (rd.mode === "ytd") {
    const jan1 = perDay[n - 1].date.slice(0, 4) + "-01-01";
    let start = n - 1;
    while (start > 0 && perDay[start - 1].date >= jan1) start--;
    return [start, n - 1];
  }
  if (rd.mode === "cal") {
    const latest = perDay[n - 1].date;
    let start = n - 1;
    while (start > 0 && daysBetween(perDay[start - 1].date, latest) <= rd.days) start--;
    return [start, n - 1];
  }
  // custom
  if (customFrom && customTo) {
    let start = perDay.findIndex((d) => d.date >= customFrom);
    let end = -1;
    for (let i = n - 1; i >= 0; i--) { if (perDay[i].date <= customTo) { end = i; break; } }
    if (start === -1 || end === -1 || end < start) return [0, -1];
    return [start, end];
  }
  return [Math.max(0, n - 10), n - 1];
}

// Group a daily series into DAY / WEEK (Mon-start) / MONTH buckets, summing $ volume.
function groupByPeriod(days, mode) {
  if (mode === "day") return days;
  const keyOf = (iso) => {
    const d = new Date(iso + "T00:00:00");
    if (mode === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const dow = (d.getDay() + 6) % 7; // Mon = 0
    d.setDate(d.getDate() - dow);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const map = new Map();
  for (const d of days) {
    const k = keyOf(d.date);
    const cur = map.get(k) || { date: k, volDollar: 0, count: 0 };
    cur.volDollar += d.volDollar;
    cur.count += d.count;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
const GROUPINGS = [{ key: "day", label: "DAY" }, { key: "week", label: "WEEK" }, { key: "month", label: "MONTH" }];

function VolChart({ entries, predicate }) {
  const [range, setRange] = useState_I("3M");
  const [chartType, setChartType] = useState_I("bar");
  const [grouping, setGrouping] = useState_I("day"); // day | week | month
  const [maType, setMaType] = useState_I("ema");     // "ema" | "sma" | "off"
  const [customFrom, setCustomFrom] = useState_I("");
  const [customTo, setCustomTo] = useState_I("");

  const perDay = useMemo_I(() => {
    const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest→newest
    return sorted.map((e) => {
      let sum = 0, n = 0;
      for (const r of (e.runners || [])) {
        if (predicate && !predicate(r)) continue;
        n++;
        if (r.volDollar != null && Number.isFinite(r.volDollar)) sum += r.volDollar;
      }
      return { date: e.date, volDollar: sum, count: n };
    });
  }, [entries, predicate]);

  // Range selects the time window on the DAILY series, then grouping decides bar
  // granularity, then the moving average is computed over the grouped bars.
  const [start, end] = useMemo_I(
    () => windowBounds(perDay, range, customFrom, customTo),
    [perDay, range, customFrom, customTo]
  );
  const grouped = useMemo_I(
    () => groupByPeriod(perDay.slice(start, end + 1), grouping),
    [perDay, start, end, grouping]
  );
  const maSeries = useMemo_I(
    () => (maType === "off" ? null : movingAverage(grouped.map((d) => d.volDollar), MA_PERIOD, maType)),
    [grouped, maType]
  );
  const data = useMemo_I(
    () => grouped.map((d, i) => ({ date: d.date, val: d.volDollar, volDollar: d.volDollar, count: d.count, ma: maSeries ? maSeries[i] : null })),
    [grouped, maSeries]
  );

  const fmtVal = (v) => window.fmtDollar(v);
  const maxVal = Math.max(1, ...data.map((d) => Math.max(d.val, d.ma != null ? d.ma : 0)));
  const total = data.reduce((s, d) => s + d.val, 0);
  const groupLabel = (GROUPINGS.find((g) => g.key === grouping) || GROUPINGS[0]).label.toLowerCase();
  const totalLabel = `${window.fmtDollar(total)} total · ${data.length} ${groupLabel}${data.length === 1 ? "" : "s"}`;

  return (
    <div className="volchart">
      <div className="volchart-head">
        <div className="volchart-title">
          <span className="label">$ VOLUME TREND</span>
          <span className="volchart-total">{totalLabel}</span>
        </div>
        <div className="volchart-controls">
          <div className="volchart-types">
            {GROUPINGS.map((g) => (
              <button key={g.key} className={`vc-type ${grouping === g.key ? "active" : ""}`}
                onClick={() => setGrouping(g.key)}>{g.label}</button>
            ))}
          </div>
          <div className="volchart-ranges">
            {RANGES.map((r) => (
              <button key={r.key} className={`vc-range ${range === r.key ? "active" : ""}`}
                onClick={() => setRange(r.key)}>{r.key === "custom" ? "Custom" : r.key}</button>
            ))}
          </div>
          <div className="volchart-types">
            <button className={`vc-type ${chartType === "bar" ? "active" : ""}`} onClick={() => setChartType("bar")}>Bar</button>
            <button className={`vc-type ${chartType === "line" ? "active" : ""}`} onClick={() => setChartType("line")}>Line</button>
          </div>
          <div className="volchart-types" title={`${MA_PERIOD}-period moving average overlay`}>
            <button className={`vc-type ${maType === "ema" ? "active" : ""}`} onClick={() => setMaType("ema")}>EMA</button>
            <button className={`vc-type ${maType === "sma" ? "active" : ""}`} onClick={() => setMaType("sma")}>SMA</button>
            <button className={`vc-type ${maType === "off" ? "active" : ""}`} onClick={() => setMaType("off")}>Off</button>
          </div>
        </div>
      </div>

      {range === "custom" && (
        <div className="volchart-custom">
          <label>From <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></label>
          <label>To <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></label>
        </div>
      )}

      {data.length === 0 ? (
        <div className="volchart-empty">No data in range for the current filters.</div>
      ) : (
        <>
          <VolChartSvg data={data} maxVal={maxVal} type={chartType} fmtVal={fmtVal} showMa={maType !== "off"} />
          {maType !== "off" && (
            <div className="volchart-legend">
              <span className="vc-legend-bar" /> $ volume
              <span className="vc-legend-ma" /> {MA_PERIOD}-day {maType.toUpperCase()}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VolChartSvg({ data, maxVal, type, fmtVal, showMa }) {
  const W = 760, H = 200, padL = 8, padR = 8, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = data.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - (v / maxVal) * innerH;
  const barW = Math.max(2, Math.min(48, (innerW / Math.max(1, n)) * 0.62));
  const fmtShortDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const step = Math.ceil(n / 10);
  const linePts = data.map((d, i) => `${x(i)},${y(d.val)}`).join(" ");
  const maPts = data.map((d, i) => (d.ma != null ? `${x(i)},${y(d.ma)}` : null)).filter(Boolean).join(" ");

  return (
    <div className="volchart-svg-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="volchart-svg" preserveAspectRatio="none">
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} className="vc-axis" />
        {type === "bar" ? (
          data.map((d, i) => {
            const bh = (d.val / maxVal) * innerH;
            const bx = (n === 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW) - barW / 2;
            return (
              <rect key={i} x={bx} y={padT + innerH - bh} width={barW} height={bh} className="vc-bar" rx="1">
                <title>{d.date}: {fmtVal(d.val)}</title>
              </rect>
            );
          })
        ) : (
          <>
            <polyline points={linePts} className="vc-line" fill="none" />
            {data.map((d, i) => (
              <circle key={i} cx={x(i)} cy={y(d.val)} r="2.5" className="vc-dot">
                <title>{d.date}: {fmtVal(d.val)}</title>
              </circle>
            ))}
          </>
        )}
        {showMa && maPts && <polyline points={maPts} className="vc-ma-line" fill="none" />}
        {data.map((d, i) => (
          (i % step === 0 || i === n - 1) ? (
            <text key={i} x={x(i)} y={H - 8} className="vc-xlabel" textAnchor="middle">{fmtShortDate(d.date)}</text>
          ) : null
        ))}
      </svg>
    </div>
  );
}

// ── Period comparison table ────────────────────────────────────────
function fmtClock(min) {
  if (min == null || !Number.isFinite(min)) return "—";
  min = Math.round(min);
  let h = Math.floor(min / 60), m = ((min % 60) + 60) % 60;
  const ap = h >= 12 ? "PM" : "AM";
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
}
function pct(v) { return v == null ? "—" : `${Math.round(v)}%`; }

function periodMetrics(runners) {
  const n = runners.length;
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  if (!n) return { n: 0, avgHod: null, avgFade: null, avgVol: null, avgTime: null, pctSession: null, pctPre: null, pctF20: null, pctF40: null };
  const hodVals = runners.map(runnerHodVal).filter((v) => v != null);
  const fadeVals = runners.map((r) => r.fade).filter((v) => v != null);
  const volVals = runners.map((r) => r.volDollar).filter((v) => v != null && Number.isFinite(v));
  const times = runners.map((r) => window.minutesFromExact(r.hodTimeExact)).filter((v) => v != null);
  const sess = runners.filter((r) => r.session === "morning" || r.session === "afternoon").length;
  const pre = runners.filter((r) => r.session === "premarket").length;
  const f20 = runners.filter((r) => r.fade != null && r.fade < 20).length;
  const f40 = runners.filter((r) => r.fade != null && r.fade > 40).length;
  return {
    n,
    avgHod: avg(hodVals),
    avgFade: avg(fadeVals),
    avgVol: avg(volVals),
    avgTime: avg(times),
    pctSession: (sess / n) * 100,
    pctPre: (pre / n) * 100,
    pctF20: (f20 / n) * 100,
    pctF40: (f40 / n) * 100,
  };
}

// dir: +1 higher is better, -1 lower is better, 0 no directional judgment.
const PERIOD_ROWS = [
  { key: "n",          label: "Total runners",     fmt: (m) => m.n,                                    val: (m) => m.n,          dir: 1 },
  { key: "avgHod",     label: "Avg HOD %",          fmt: (m) => (m.avgHod != null ? `+${Math.round(m.avgHod)}%` : "—"), val: (m) => m.avgHod, dir: 1 },
  { key: "avgFade",    label: "Avg fade %",         fmt: (m) => (m.avgFade != null ? `${Math.round(m.avgFade)}%` : "—"), val: (m) => m.avgFade, dir: -1 },
  { key: "avgVol",     label: "Avg $ volume",       fmt: (m) => (m.avgVol != null ? window.fmtDollar(m.avgVol) : "—"),  val: (m) => m.avgVol,  dir: 1 },
  { key: "avgTime",    label: "Avg time to HOD",    fmt: (m) => fmtClock(m.avgTime),                    val: (m) => m.avgTime,    dir: 0 },
  { key: "pctSession", label: "% session HODs",     fmt: (m) => pct(m.pctSession),                      val: (m) => m.pctSession, dir: 1 },
  { key: "pctPre",     label: "% premarket HODs",   fmt: (m) => pct(m.pctPre),                          val: (m) => m.pctPre,     dir: -1 },
  { key: "pctF20",     label: "% fade under 20%",   fmt: (m) => pct(m.pctF20),                          val: (m) => m.pctF20,     dir: 1 },
  { key: "pctF40",     label: "% fade over 40%",    fmt: (m) => pct(m.pctF40),                          val: (m) => m.pctF40,     dir: -1 },
];

function PeriodComparison({ entries, predicate }) {
  const cols = useMemo_I(() => {
    const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    if (!sorted.length) return null;
    const latest = sorted[0].date;
    const runnersOf = (subset) => {
      const rs = [];
      for (const e of subset) for (const r of (e.runners || [])) if (!predicate || predicate(r)) rs.push(r);
      return rs;
    };
    const within = (days) => sorted.filter((e) => daysBetween(e.date, latest) <= days);
    return {
      last5:  periodMetrics(runnersOf(sorted.slice(0, 5))),
      prior5: periodMetrics(runnersOf(sorted.slice(5, 10))),
      d30:    periodMetrics(runnersOf(within(30))),
      d90:    periodMetrics(runnersOf(within(90))),
      d180:   periodMetrics(runnersOf(within(180))),
    };
  }, [entries, predicate]);

  if (!cols) return null;
  const COLS = [["LAST 5D", "last5"], ["PRIOR 5D", "prior5"], ["30 DAYS", "d30"], ["90 DAYS", "d90"], ["180 DAYS", "d180"]];

  // LAST 5D is the only column that carries direction: colored text + arrow.
  // Every other period column stays plain.
  const trend = (row) => {
    if (row.dir === 0) return { cls: "", arrow: "" };
    const a = row.val(cols.last5), b = row.val(cols.prior5);
    if (a == null || b == null || a === b) return { cls: "", arrow: "" };
    const better = row.dir > 0 ? a > b : a < b;
    // arrow reflects the raw movement, color reflects whether that's good
    const up = a > b;
    return { cls: better ? "pc-up" : "pc-down", arrow: up ? " ▲" : " ▼" };
  };

  return (
    <div className="period-comp">
      <div className="period-comp-head"><span className="label">PERIOD COMPARISON</span></div>
      <div className="period-comp-wrap">
        <table className="period-comp-table">
          <thead>
            <tr>
              <th className="pc-metric"></th>
              {COLS.map(([lbl]) => <th key={lbl} className="num">{lbl}</th>)}
            </tr>
          </thead>
          <tbody>
            {PERIOD_ROWS.map((row) => {
              const t = trend(row);
              return (
                <tr key={row.key}>
                  <td className="pc-metric">{row.label}</td>
                  {COLS.map(([lbl, key]) => (
                    <td key={key} className={`num ${key === "last5" ? t.cls : ""}`}>
                      {row.fmt(cols[key])}{key === "last5" ? t.arrow : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── AI trend summary bar ───────────────────────────────────────────
// Pre-computed by Python (entry.aiSummary or top-level data.aiSummary in v2).
// Until real data lands, derive a lightweight themes-bubbling-up read from the
// most recent days so the bar is never empty (static-placeholder-first per spec).
function AISummaryBar({ entries, aiSummary }) {
  const dom = useMemo_I(() => computeDominance(entries), [entries]);
  const autoText = dom && dom.clauses.length ? `Last ${dom.days} days — ${dom.clauses.join("; ")}.` : null;
  const summary = aiSummary || autoText;
  if (!summary && (!dom || dom.chips.length === 0)) return null;
  const isReal = !!aiSummary;

  return (
    <div className="ai-summary-bar">
      <span className="ai-summary-badge">{isReal ? "AI TREND" : "TREND · auto"}</span>
      {summary && <p className="ai-summary-text">{summary}</p>}
      {dom && dom.chips.length > 0 && (
        <div className="ai-summary-chips">
          {dom.chips.map((c, i) => (
            <span key={i} className={`ai-summary-chip ai-chip-${c.kind}`} style={{ "--chip-color": c.color }}>{c.label} <b>{c.count}</b></span>
          ))}
        </div>
      )}
    </div>
  );
}

// What's bubbling up across the most recent ~5 trading days.
// Float-tier and HOD-time dominance are ALWAYS surfaced. Catalyst and country
// only surface when one clearly dominates by a meaningful margin (not a bare lead).
function computeDominance(entries) {
  if (!entries || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
  const tag = {}, tier = {}, ctry = {}, sess = {};
  let n = 0;
  for (const e of sorted) {
    for (const r of (e.runners || [])) {
      n++;
      if (r.tag) tag[r.tag] = (tag[r.tag] || 0) + 1;
      if (r.floatTier) tier[r.floatTier] = (tier[r.floatTier] || 0) + 1;
      if (r.country) ctry[r.country] = (ctry[r.country] || 0) + 1;
      if (r.session) sess[r.session] = (sess[r.session] || 0) + 1;
    }
  }
  if (n === 0) return null;
  const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const chips = [], clauses = [];

  // Catalyst — only when clearly dominant: >=30% share AND >=1.4x the runner-up.
  const tr = rank(tag);
  if (tr.length) {
    const c1 = tr[0][1], c2 = tr[1] ? tr[1][1] : 0;
    if (c1 / n >= 0.30 && (tr.length < 2 || c1 >= 1.4 * c2)) {
      chips.push({ label: tr[0][0], count: c1, color: window.catalystColor(tr[0][0]), kind: "catalyst" });
      clauses.push(`${tr[0][0]} catalysts dominant`);
    }
  }
  // Float tier — always show the leader.
  const fr = rank(tier);
  if (fr.length) {
    chips.push({ label: fr[0][0], count: fr[0][1], color: window.floatTierColor(fr[0][0]), kind: "floattier" });
    clauses.push(`${fr[0][0]}-float names leading`);
  }
  // HOD time — always show the leader.
  const sr = rank(sess);
  if (sr.length) {
    chips.push({ label: window.sessionLabel(sr[0][0]), count: sr[0][1], color: "oklch(0.62 0.09 250)", kind: "session" });
    clauses.push(`${window.sessionLabel(sr[0][0]).toLowerCase()} HODs most common`);
  }
  // Country — only when one stands out: >=30% share AND >=1.5x the runner-up.
  const cr = rank(ctry);
  if (cr.length) {
    const k1 = cr[0][1], k2 = cr[1] ? cr[1][1] : 0;
    if (k1 / n >= 0.30 && (cr.length < 2 || k1 >= 1.5 * k2)) {
      chips.push({ label: cr[0][0], count: k1, color: window.countryColor(cr[0][0]), kind: "country" });
      clauses.push(`${cr[0][0]} representation elevated`);
    }
  }
  return { chips, clauses, days: sorted.length };
}

Object.assign(window, {
  buildFilterOptions,
  emptyFilterState,
  makePredicate,
  filterActiveCount,
  cloneFilterState,
  FilterPanel,
  VolChart,
  PeriodComparison,
  AISummaryBar,
});
