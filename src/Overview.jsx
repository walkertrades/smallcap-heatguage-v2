// Overview — the primary dashboard page. Answers, top to bottom:
//  1) How hot is the tape?  (hero: heat score + state + drivers)
//  2) Why?                  (KPI cards + drivers + AI rec)
//  3) Which stocks?         (Top Movers)
//  4) Historical context    (calendars, distributions, trend, period compare, charts)
const { useState: useState_Ov, useMemo: useMemo_Ov } = React;

// ── Small building blocks ──────────────────────────────────────────
function Sparkline({ data, color, w = 116, h = 34 }) {
  if (!data || data.length < 2) return <div className="spark-empty" />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPts = `0,${h} ${pts} ${w},${h}`;
  const id = "sg" + Math.round(x(1) * 100) + color.length;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// Confidence bar — continuous gradient fill from cold blue → hot orange.
function ConfBar({ pct }) {
  const p = clampN(pct, 0, 100);
  return (
    <div className="confbar">
      <div className="confbar-mask" style={{ width: `${100 - p}%` }} />
    </div>
  );
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Hero: heat score / state / drivers ─────────────────────────────
function HeatScoreCard({ today }) {
  const score = today ? Math.round(today.score) : null;
  const state = today ? today.state : "EMPTY";
  const conf = today ? today.confidence : 0;
  const stateColor = state === "HOT" ? "var(--hot)" : state === "COLD" ? "var(--cold)" : "var(--neutral)";
  return (
    <div className="card hero-card heat-card">
      <div className="card-label">MARKET HEAT SCORE</div>
      <div className="heat-row">
        <div className="heat-num-block">
          <div className="heat-num" style={{ color: stateColor }}>{score == null ? "—" : score}</div>
          <div className="heat-state" style={{ color: stateColor }}>{state === "EMPTY" ? "NO DATA" : state}</div>
          <div className="heat-scale">0 – 100 SCALE</div>
        </div>
        <div className="heat-gauge"><window.Gauge score={score} state={state} /></div>
      </div>
      <div className="conf-row">
        <span className="conf-label">Confidence</span>
        <ConfBar pct={conf} />
        <span className="conf-val">{Math.round(conf)}%</span>
      </div>
    </div>
  );
}

function MarketStateCard({ state, rules }) {
  const stateColor = state === "HOT" ? "var(--hot)" : state === "COLD" ? "var(--cold)" : "var(--neutral)";
  const icon = state === "HOT" ? "🔥" : state === "COLD" ? "❄" : "⚡";
  const rec = window.marketRec(state);
  return (
    <div className="card hero-card state-panel">
      <div className="state-panel-top">
        <div>
          <div className="card-label">MARKET STATE</div>
          <div className="state-panel-big" style={{ color: stateColor }}>{state === "EMPTY" ? "NO DATA" : state}</div>
        </div>
        <div className="state-panel-icon" style={{ color: stateColor }}>{icon}</div>
      </div>
      <p className="state-panel-rec">{rec}</p>
      {rules && (
        <>
          <div className="card-sublabel">TODAY'S PLAYBOOK</div>
          <ul className="playbook">
            {rules.bullets.slice(0, 4).map((b, i) => (
              <li key={i}><span className="playbook-dot" style={{ background: stateColor }} />{b}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Heat-score bar whose filled portion is coloured by where it lands on a
// cold-blue → green → hot-orange gradient (mask reveals the gradient).
function ScoreBar({ label, score }) {
  const p = clampN(score, 0, 100);
  return (
    <div className="scorebar-row">
      <span className="scorebar-lbl">{label}</span>
      <div className="scorebar"><div className="scorebar-mask" style={{ width: `${100 - p}%` }} /></div>
      <span className="scorebar-val">{Math.round(score)}</span>
    </div>
  );
}

const THEME_BAR_MAX = 50; // bars fill proportionally out of 50 runners
const THEME_ROWS = [
  { key: "country",    label: "COUNTRY",     color: "oklch(0.68 0.13 250)" },
  { key: "floatTier",  label: "FLOAT TIER",  color: "oklch(0.70 0.15 40)" },
  { key: "priceRange", label: "PRICE RANGE", color: "oklch(0.72 0.14 150)" },
  { key: "sector",     label: "SECTOR",      color: "oklch(0.68 0.13 300)" },
  { key: "catalyst",   label: "CATALYST",    color: "oklch(0.78 0.15 92)" },
];

function WhatsDrivingCard({ series, entries, anchorDate, predicate }) {
  const avg5 = useMemo_Ov(() => window.avgScoreWindow(series, anchorDate, 5), [series, anchorDate]);
  const avg15 = useMemo_Ov(() => window.avgScoreWindow(series, anchorDate, 15), [series, anchorDate]);
  const themes = useMemo_Ov(() => window.dominantThemes(entries, anchorDate, 5, predicate), [entries, anchorDate, predicate]);

  return (
    <div className="card hero-card driving-card">
      <div className="card-label">WHAT'S DRIVING TODAY</div>

      <div className="scorebars">
        <ScoreBar label="5D AVG" score={avg5} />
        <ScoreBar label="15D AVG" score={avg15} />
      </div>

      <div className="card-sublabel">LAST 5 DAYS · DOMINANT</div>
      <div className="themes">
        {THEME_ROWS.map((t) => {
          const v = themes[t.key];
          const pct = v ? clampN((v.count / THEME_BAR_MAX) * 100, 0, 100) : 0;
          return (
            <div className="theme-row" key={t.key} title={t.label}>
              <span className="theme-lbl">{t.label}</span>
              <span className="theme-name">{v ? v.value : "—"}</span>
              <div className="theme-track">
                <div className="theme-fill" style={{ width: `${pct}%`, background: t.color }} />
              </div>
              <span className="theme-count" style={{ color: t.color }}>{v ? v.count : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 5-day rolling strip (replaces the KPI cards) ───────────────────
function RollingStrip({ series, activeDate, onSelectDay }) {
  const last5 = series.slice(-5);
  const avg5 = last5.length ? last5.reduce((s, d) => s + (d.score || 0), 0) / last5.length : 0;
  const fmtDay = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  };
  const active = activeDate && last5.some((d) => d.date === activeDate)
    ? activeDate
    : (last5.length ? last5[last5.length - 1].date : null);

  return (
    <div className="rollstrip">
      {last5.map((d) => {
        const st = String(d.state || "").toLowerCase();
        const delta = (d.score || 0) - avg5;
        const isOn = d.date === active;
        return (
          <button key={d.date} className={`card roll-card roll-${st} ${isOn ? "active" : ""}`}
            onClick={() => onSelectDay && onSelectDay(d.date)} title={`Load ${d.date}`}>
            <div className="roll-date">{fmtDay(d.date)}</div>
            <div className="roll-score">{Math.round(d.score)}</div>
            <div className={`roll-delta ${delta >= 0 ? "up" : "down"}`}>
              {delta >= 0 ? "+" : ""}{Math.round(delta)} vs 5D avg
            </div>
            <div className={`roll-state roll-text-${st}`}>{d.state}</div>
            <div className="roll-stats">
              <span>HOD <b>+{Math.round(d.avgHod)}%</b></span>
              <span>FADE <b>{Math.round(d.avgFade)}%</b></span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Top Movers ─────────────────────────────────────────────────────
function CatalystBadge({ tag }) {
  if (!tag) return null;
  const color = window.catalystColor(tag);
  return <span className="cat-badge" style={{ "--cat": color }}>{String(tag).toUpperCase()}</span>;
}
// Manual letter grade (replaces the auto-computed setup score).
function GradeBadge({ grade }) {
  const c = window.gradeColor(grade);
  return (
    <span className={`grade-badge ${grade ? "graded" : "ungraded"} ${grade === "A++" ? "grade-gold" : ""}`}
      style={{ "--gc": c }} title={grade ? `Grade ${grade}` : "Ungraded"}>
      {grade || "—"}
    </span>
  );
}

const MOVER_RANGES = [
  { key: "today", label: "TODAY" },
  { key: "d5", label: "LAST 5D" },
  { key: "d30", label: "30D" },
  { key: "ytd", label: "YTD" },
  { key: "lastyear", label: "LAST YEAR" },
  { key: "twoyears", label: "TWO YEARS AGO" },
  { key: "custom", label: "CUSTOM" },
];
// Every column is sortable. `get` returns the raw value used for comparison.
function fmtShortDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return `${m}/${d}/${String(y).slice(2)}`;
}
const MOVER_COLS = [
  { key: "date",    label: "DATE",      text: true,  get: (r) => r._date || "" },
  { key: "sym",     label: "TICKER",    text: true,  get: (r) => r.sym || "" },
  { key: "floatM",  label: "FLOAT",     num: true,   get: (r) => (r.floatM != null ? r.floatM : -1) },
  { key: "tag",     label: "CATALYSTS", text: true,  get: (r) => r.tag || "" },
  { key: "gapPct",  label: "PM GAP %",  num: true,   get: (r) => (r.gapPct != null ? r.gapPct : -1e9) },
  { key: "hod",     label: "HOD %",     num: true,   get: (r) => hodDisp(r) },
  { key: "fade",    label: "FADE %",    num: true,   get: (r) => (r.fade != null ? r.fade : 1e9) },
  { key: "vol",     label: "VOLUME",    num: true,   get: (r) => window.parseShareVol(r.volRaw) || 0 },
  { key: "country", label: "COUNTRY",   text: true,  get: (r) => r.country || "" },
  { key: "sector",  label: "SECTOR",    text: true,  get: (r) => r.sectorNorm || "" },
  { key: "grade",   label: "GRADE",     num: true,   get: (r) => window.gradeRank(window.getGrade(r._date, r.sym)) },
];

function TopMovers({ entries, selectedDate, filterPredicate, filterActive }) {
  const [range, setRange] = useState_Ov("today");
  const [from, setFrom] = useState_Ov("");
  const [to, setTo] = useState_Ov("");
  const [sort, setSort] = useState_Ov({ key: "hod", dir: -1 }); // default HOD % desc
  const [gradeTick, setGradeTick] = useState_Ov(0); // bumped when a grade is edited
  const [page, setPage] = useState_Ov(1);
  const [expanded, setExpanded] = useState_Ov(null);

  const rows = useMemo_Ov(() => {
    const list = window.moversForRange(
      entries, range, { day: selectedDate, from, to },
      filterActive && filterPredicate ? filterPredicate : null
    );
    const col = MOVER_COLS.find((c) => c.key === sort.key) || MOVER_COLS[4];
    const sorted = [...list].sort((a, b) => {
      const av = col.get(a), bv = col.get(b);
      if (col.text) return String(av).localeCompare(String(bv)) * sort.dir;
      return (av - bv) * sort.dir;
    });
    return sorted;
  }, [entries, range, selectedDate, from, to, filterPredicate, filterActive, sort, gradeTick]);

  const clickSort = (col) => {
    setSort((s) => s.key === col.key
      ? { key: col.key, dir: -s.dir }
      : { key: col.key, dir: col.text ? 1 : -1 });
  };
  const arrow = (col) => (sort.key === col.key ? (sort.dir === -1 ? " ▾" : " ▴") : "");

  // The expanded detail lives inside a table that can scroll horizontally, so it
  // would otherwise lay out at the table's full width and spill past the card.
  // Measure the visible scroll-container width and pin the panel to it.
  const wrapRef = React.useRef(null);
  const [wrapW, setWrapW] = useState_Ov(0);
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrapW(el.clientWidth);
    measure();
    let ro = null;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
    window.addEventListener("resize", measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // ── pagination: 12 rows per page ──
  const PER_PAGE = 12;
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const shown = rows.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  // snap back to page 1 whenever the underlying set changes
  React.useEffect(() => { setPage(1); }, [range, from, to, selectedDate, filterActive, sort.key, sort.dir]);

  // NOTE: "warn" is already a styled component class in styles.css (red box) —
  // use a unique name so the fade cell only tints the text.
  const fadeCls = (f) => (f == null ? "" : f < 20 ? "pos" : f <= 40 ? "fadewarn" : "neg");
  const rangeLabel = (MOVER_RANGES.find((r) => r.key === range) || {}).label;

  return (
    <div className="card movers-card">
      <div className="movers-head">
        <span className="card-title">TOP MOVERS</span>
        <div className="mover-tabs">
          {MOVER_RANGES.map((r) => (
            <button key={r.key} className={`mover-tab ${range === r.key ? "active" : ""}`}
              onClick={() => { setRange(r.key); setPage(1); }}>{r.label}</button>
          ))}
        </div>
      </div>

      {range === "custom" && (
        <div className="mover-custom">
          <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {(!from || !to) && <span className="muted">pick both dates</span>}
        </div>
      )}

      <div className="movers-table-wrap" ref={wrapRef}>
        <table className="movers-table">
          <thead>
            <tr>
              <th>#</th>
              {MOVER_COLS.map((c) => (
                <th key={c.key} className={`sortable ${c.num ? "num" : ""} ${sort.key === c.key ? "sorted" : ""}`}
                  onClick={() => clickSort(c)}>{c.label}{arrow(c)}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={MOVER_COLS.length + 2} className="movers-empty">
                No runners in this range{filterActive ? " matching the active filters" : ""}.
              </td></tr>
            )}
            {shown.map((r, i) => {
              // a ticker can now appear on several dates, so key on both
              const rowKey = `${r._date}::${r.sym}`;
              const isOpen = expanded === rowKey;
              const gapCls = r.gapPct > 0 ? "pos" : r.gapPct < 0 ? "neg" : "";
              return (
                <React.Fragment key={rowKey}>
                  <tr className={`mover-row ${isOpen ? "open" : ""}`} onClick={() => setExpanded(isOpen ? null : rowKey)}>
                    <td className="mv-rank">{(safePage - 1) * PER_PAGE + i + 1}</td>
                    <td className="mv-date">{fmtShortDate(r._date)}</td>
                    <td className="mv-tick">
                      <span className="mv-sym">{r.sym}</span>
                      <span className="mv-name">{r.name || ""}</span>
                    </td>
                    <td className="num">{r.floatM != null ? `${r.floatM}M` : "—"}</td>
                    <td><div className="mv-cats">
                      <CatalystBadge tag={r.tag} />
                      {r.ssr && <span className="cat-badge cat-ssr">SSR</span>}
                    </div></td>
                    <td className={`num ${gapCls}`}>{r.gapPct != null ? `${r.gapPct > 0 ? "+" : ""}${r.gapPct}%` : "—"}</td>
                    <td className="num pos">+{hodDisp(r)}%</td>
                    <td className={`num ${fadeCls(r.fade)}`}>{r.fade != null ? `${r.fade}%` : "—"}</td>
                    <td className="num">{r.volRaw || "—"}</td>
                    <td>{r.country || "—"}</td>
                    <td className="mv-sector">{r.sectorNorm || "—"}</td>
                    <td className="num"><GradeBadge grade={window.getGrade(r._date, r.sym)} /></td>
                    <td className="mv-chev"><span className={`mv-chev-ic ${isOpen ? "open" : ""}`}>›</span></td>
                  </tr>
                  {isOpen && (
                    <tr className="mover-detail-row">
                      <td colSpan={MOVER_COLS.length + 2}>
                        {/* small inset: the panel sits inside the table, so matching
                            the container exactly nudges the table past it */}
                        <div className="mover-detail-inner" style={wrapW ? { width: Math.max(0, wrapW - 8) + "px" } : null}>
                          <window.RunnerTile r={r} onGradeChange={() => setGradeTick((t) => t + 1)} />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="movers-foot">
        <span>{rows.length} movers · {rangeLabel} · every occurrence listed</span>
        <div className="pager">
          <button className="pager-btn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Previous</button>
          <span className="pager-pos">Page {safePage} of {pageCount}</span>
          <button className="pager-btn" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next ›</button>
        </div>
        <span className="muted">Sorted by {(MOVER_COLS.find((c) => c.key === sort.key) || {}).label} {sort.dir === -1 ? "▾" : "▴"}</span>
      </div>
    </div>
  );
}
function hodDisp(r) { return r.hodExact != null ? Math.round(r.hodExact) : (r.hod || 0); }

// ── Historical context ─────────────────────────────────────────────
function stateColorVar(s) { return s === "HOT" ? "var(--hot)" : s === "COLD" ? "var(--cold)" : s === "NEUTRAL" ? "var(--neutral)" : "var(--card-border)"; }

// True month calendar — Sun–Sat grid, month navigation, click a day to open it
// on the Calendar tab.
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function HeatCalendar({ series }) {
  const [picked, setPicked] = useState_Ov(null); // day detail shown inline — no navigation
  const latest = series.length ? series[series.length - 1].date : null;
  const initial = useMemo_Ov(() => {
    if (!latest) { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; }
    const [y, m] = latest.split("-").map(Number);
    return { year: y, month: m - 1 };
  }, [latest]);
  const [cursor, setCursor] = useState_Ov(initial);
  // Follow the data if it loads after first paint.
  const [seeded, setSeeded] = useState_Ov(false);
  if (!seeded && latest) { setSeeded(true); setCursor(initial); }

  const weeks = useMemo_Ov(() => window.buildMonthGrid(cursor.year, cursor.month, series), [cursor, series]);
  const step = (delta) => {
    let m = cursor.month + delta, y = cursor.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setCursor({ year: y, month: m });
  };

  return (
    <div className="hist-box">
      <div className="calx-nav">
        <button className="calx-navbtn" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <span className="calx-title">{window.MONTH_LABELS[cursor.month]} {cursor.year}</span>
        <button className="calx-navbtn" onClick={() => step(1)} aria-label="Next month">›</button>
      </div>
      <div className="calx">
        <div className="calx-head">
          {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
        </div>
        {weeks.map((week, wi) => (
          <div className="calx-week" key={wi}>
            {week.map((c, ci) => {
              if (!c) return <div key={`e${ci}`} className="calx-cell calx-blank" />;
              const st = c.data ? String(c.data.state || "").toLowerCase() : "none";
              const clickable = !!c.data;
              const isPicked = picked && picked.iso === c.iso;
              return (
                <div key={c.iso}
                  className={`calx-cell calx-${c.weekend ? "weekend" : st} ${clickable ? "clickable" : ""} ${isPicked ? "picked" : ""}`}
                  onClick={() => clickable && setPicked(isPicked ? null : { iso: c.iso, d: c.data })}
                  role={clickable ? "button" : undefined}
                  title={c.data ? `${c.iso} · ${c.data.state} · score ${Math.round(c.data.score)}` : c.iso}>
                  <span className="calx-day">{c.day}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {picked && <CalDayDetail iso={picked.iso} d={picked.d} onClose={() => setPicked(null)} />}
      <div className="cal-legend">
        <span><i className="calx-swatch calx-hot" /> HOT</span>
        <span><i className="calx-swatch calx-neutral" /> NEUTRAL</span>
        <span><i className="calx-swatch calx-cold" /> COLD</span>
        <span><i className="calx-swatch calx-none" /> No data</span>
      </div>
    </div>
  );
}

// Inline detail for a clicked calendar day — stays on the Overview page.
function CalDayDetail({ iso, d, onClose }) {
  const st = String(d.state || "").toLowerCase();
  const long = new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  return (
    <div className={`calday calday-${st}`}>
      <div className="calday-head">
        <span className="calday-date">{long}</span>
        <button className="calday-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="calday-top">
        <span className={`calday-state calday-text-${st}`}>{d.state}</span>
        <span className="calday-score">{Math.round(d.score)}<small>/100</small></span>
      </div>
      <div className="calday-stats">
        <div><span>RUNNERS</span><b>{d.n}</b></div>
        <div><span>AVG HOD</span><b>+{Math.round(d.avgHod)}%</b></div>
        <div><span>AVG FADE</span><b>{Math.round(d.avgFade)}%</b></div>
        <div><span>PM LED</span><b>{Math.round(d.pmLead)}%</b></div>
      </div>
    </div>
  );
}

// HOD Time Distribution — 15-min buckets 4:00 AM → 8:00 PM, grouped by session zone.
const HOD_RANGES = [{ key: "5D", days: 5 }, { key: "30D", days: 30 }, { key: "90D", days: 90 }];
const TOTAL_BUCKETS = 64; // 4:00 AM → 8:00 PM in 15-minute steps
function HodTimeDistribution({ entries, predicate }) {
  const [range, setRange] = useState_Ov("30D");
  const [hover, setHover] = useState_Ov(null);
  const days = (HOD_RANGES.find((r) => r.key === range) || HOD_RANGES[1]).days;
  const dist = useMemo_Ov(() => window.hodTimeDistribution(entries, days, predicate), [entries, days, predicate]);

  return (
    <div className="card hodtime-card">
      <div className="hodtime-head">
        <div>
          <span className="card-title">HOD TIME DISTRIBUTION</span>
          <span className="hodtime-sub">{dist.total} runners · when the high of day printed</span>
        </div>
        <div className="volchart-ranges">
          {HOD_RANGES.map((r) => (
            <button key={r.key} className={`vc-range ${range === r.key ? "active" : ""}`} onClick={() => setRange(r.key)}>{r.key}</button>
          ))}
        </div>
      </div>

      <div className="hodtime-zonelabels">
        {dist.zones.map((z) => (
          <span key={z.key} className="hodtime-zonelabel" style={{ flex: z.buckets.length, "--zc": z.color }}>{z.label}</span>
        ))}
      </div>

      <div className="hodtime-plot" onMouseLeave={() => setHover(null)}>
        {/* vertical tracking line — anchors the eye to the hovered bucket */}
        {hover && <div className="hodtime-vline" style={{ left: `${((hover.i + 0.5) / TOTAL_BUCKETS) * 100}%` }} />}
        {hover && (
          <div className={`hodtime-tip ${hover.i > TOTAL_BUCKETS * 0.66 ? "flip" : ""}`}
            style={{ left: `${((hover.i + 0.5) / TOTAL_BUCKETS) * 100}%`, "--zc": hover.color }}>
            <div className="hodtime-tip-time">{window.fmtClockMin(hover.start)}–{window.fmtClockMin(hover.start + 15)}</div>
            <div className="hodtime-tip-row"><b>{hover.count}</b> {hover.count === 1 ? "runner" : "runners"}</div>
            <div className="hodtime-tip-pct">{dist.total ? ((hover.count / dist.total) * 100).toFixed(1) : "0.0"}% of total</div>
            <div className="hodtime-tip-zone">{hover.label}</div>
          </div>
        )}
        {dist.zones.map((z) => (
          <div key={z.key} className="hodtime-zone" style={{ flex: z.buckets.length, "--zc": z.color }}>
            {z.buckets.map((b) => (
              <div key={b.i} className={`hodtime-col ${hover && hover.i === b.i ? "hovered" : ""}`}
                onMouseEnter={() => setHover({ i: b.i, start: b.start, count: b.count, color: z.color, label: z.label })}>
                <div className="hodtime-bar" style={{ height: `${Math.max((b.count / dist.max) * 100, b.count ? 1.5 : 0)}%` }} />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="hodtime-axis">
        {dist.zones.map((z) => (
          <span key={z.key} style={{ flex: z.buckets.length }}>{window.fmtClockMin(z.start)}</span>
        ))}
        <span className="hodtime-axis-end">8PM</span>
      </div>
    </div>
  );
}

function HeatTrend({ series }) {
  const data = window.heatCalendar(series, 30);
  const W = 320, H = 70, pad = 6;
  const n = data.length;
  const x = (i) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (v / 100) * (H - 2 * pad);
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.score).toFixed(1)}`).join(" ");
  const last = data.length ? Math.round(data[data.length - 1].score) : 0;
  return (
    <div className="hist-box hist-trend">
      <div className="hist-label">HEAT SCORE TREND (30D)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" preserveAspectRatio="none">
        {[25, 50, 75].map((g) => <line key={g} x1={pad} y1={y(g)} x2={W - pad} y2={y(g)} className="trend-grid" />)}
        <polyline points={pts} className="trend-line" fill="none" />
        {n > 0 && <circle cx={x(n - 1)} cy={y(data[n - 1].score)} r="3" className="trend-dot" />}
      </svg>
      <div className="trend-last">{last}</div>
    </div>
  );
}

function HistoricalContext({ series }) {
  return (
    <div className="card hist-card">
      <div className="card-title">HISTORICAL CONTEXT</div>
      <HeatCalendar series={series} />
      <HeatTrend series={series} />
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────
function Overview({ entries, thresholds, filterState, setFilterState, filterPredicate, filterActive, selectedDate, onSelectDate }) {
  const series = useMemo_Ov(() => window.buildDailySeries(entries), [entries]);
  const today = useMemo_Ov(() => {
    if (selectedDate) { const hit = entries.find((e) => e.date === selectedDate); if (hit) return series.find((s) => s.date === selectedDate); }
    return series.length ? series[series.length - 1] : null;
  }, [series, entries, selectedDate]);
  const todayEntry = useMemo_Ov(() => {
    const d = today ? today.date : null;
    return d ? entries.find((e) => e.date === d) : (entries.length ? [...entries].sort((a, b) => (a.date < b.date ? 1 : -1))[0] : null);
  }, [entries, today]);

  const state = today ? today.state : "EMPTY";
  const rules = window.RULES[state] || window.RULES.NEUTRAL;
  const predicate = filterActive ? filterPredicate : null;

  const runnerCounts = useMemo_Ov(() => {
    let total = 0, match = 0;
    for (const e of entries) for (const r of (e.runners || [])) { total++; if (filterPredicate(r)) match++; }
    return { total, match };
  }, [entries, filterPredicate]);

  return (
    <div className="overview">
      <section className="hero-grid">
        <HeatScoreCard today={today} />
        <MarketStateCard state={state} rules={rules} />
        <WhatsDrivingCard series={series} entries={entries} anchorDate={today ? today.date : null} predicate={predicate} />
      </section>

      <RollingStrip series={series} activeDate={today ? today.date : null} onSelectDay={onSelectDate} />

      <section className="mid-grid">
        <TopMovers entries={entries} selectedDate={today ? today.date : null} filterPredicate={filterPredicate} filterActive={filterActive} />
        <HistoricalContext series={series} />
      </section>

      <HodTimeDistribution entries={entries} predicate={predicate} />

      {/* Period Comparison + $ Volume are the last content on the page —
          Market Intel, High Impact Catalysts and the Filters bar were removed. */}
      <section className="analysis-grid">
        <window.PeriodComparison entries={entries} predicate={predicate} />
        <window.VolChart entries={entries} predicate={predicate} />
      </section>
    </div>
  );
}

Object.assign(window, { Overview, TopMovers, HeatScoreCard, MarketStateCard, WhatsDrivingCard, RollingStrip });
