// App shell — persistent sidebar + topbar + page router. Loads and normalizes
// data2.json once, holds global date/filter state, and routes nav to pages.
const { useEffect: useEffect_App, useState: useState_App, useMemo: useMemo_App, useRef: useRef_App } = React;

const DATA_URL = "./data2.json";

// NOTE: top-level names are shared across these classic scripts (Babel emits
// `var`), so keep identifiers unique per file — a duplicate silently overwrites
// the earlier file's binding at runtime.
function fmtLongDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Map source runner.time → session/premarket/mixed for scoring back-compat.
function normalizeRunnerTime(raw) {
  if (!raw) return "mixed";
  const s = String(raw).toLowerCase();
  if (s.includes("pre")) return "premarket";
  if (s.includes("session") || s.includes("regular") || s.includes("rth")) return "session";
  return "mixed";
}

function normalizeEntry(raw) {
  if (!raw || !raw.date) return null;
  const runners = Array.isArray(raw.runners) ? raw.runners.map((r) => {
    const base = { ...r, time: normalizeRunnerTime(r.time), float: r.float != null ? r.float : r.floatM };
    return window.normalizeRunnerV2 ? window.normalizeRunnerV2(base, raw.date) : base;
  }) : [];

  const numericHods = runners.map((r) => Number(r.hod)).filter((v) => Number.isFinite(v));
  const numericFades = runners.map((r) => Number(r.fade)).filter((v) => Number.isFinite(v));
  const avgHod = numericHods.length ? numericHods.reduce((s, v) => s + v, 0) / numericHods.length : null;
  const avgFade = numericFades.length ? numericFades.reduce((s, v) => s + v, 0) / numericFades.length : null;
  const hod = avgHod != null ? Math.round(avgHod) : (raw.hod != null ? raw.hod : null);
  const fade = avgFade != null ? Math.round(avgFade) : (raw.fade != null ? raw.fade : null);

  let hodTime = raw.hodTime || null;
  if (!hodTime && runners.length) {
    const counts = { session: 0, premarket: 0, mixed: 0 };
    for (const r of runners) counts[r.time] = (counts[r.time] || 0) + 1;
    const total = counts.session + counts.premarket + counts.mixed;
    if (total && counts.session / total >= 0.6) hodTime = "session";
    else if (total && counts.premarket / total >= 0.5) hodTime = "premarket";
    else hodTime = "mixed";
  }

  const top = [...runners].sort((a, b) => (b.hod || 0) - (a.hod || 0))[0];
  let theme = raw.theme || null;
  if (!theme && top) theme = top.tag ? String(top.tag) : (top.sector || null);

  return { ...raw, runners, hod, fade, hodTime: hodTime || "mixed", theme, note: raw.note || null };
}

// ── Live ET clock + market session ─────────────────────────────────
function marketSession(now) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0 Sun .. 6 Sat
  const mins = et.getHours() * 60 + et.getMinutes();
  const clock = et.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) + " ET";
  if (day === 0 || day === 6) return { label: "Market Closed", cls: "closed", clock, next: "Mon Premarket 4:00 AM ET" };
  if (mins < 240) return { label: "Market Closed", cls: "closed", clock, next: "Premarket 4:00 AM ET" };
  if (mins < 570) return { label: "Premarket", cls: "pre", clock, next: "Open 9:30 AM ET" };
  if (mins < 960) return { label: "Market Open", cls: "open", clock, next: mins < 720 ? "Mid Session 12:00 PM ET" : "Close 4:00 PM ET" };
  if (mins < 1200) return { label: "After Hours", cls: "after", clock, next: "Close 8:00 PM ET" };
  return { label: "Market Closed", cls: "closed", clock, next: "Premarket 4:00 AM ET" };
}
function useClock() {
  const [now, setNow] = useState_App(() => new Date());
  useEffect_App(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── Sidebar ────────────────────────────────────────────────────────
const NAV = [
  { key: "overview", label: "Overview",   icon: "▦" },
  { key: "calendar", label: "Calendar",   icon: "▤" },
  { key: "movers",   label: "Top Movers", icon: "↗" },
];
const NAV_TAIL = [
  { key: "settings", label: "Settings",   icon: "⚙" },
];

function Sidebar({ view, setView, session, folders, folderId, setFolderId, onNewFolder, onDeleteFolder }) {
  const [open, setOpen] = useState_App(true);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo">🔥</span>
        <span className="brand-name">SMALL CAP HEAT</span>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${view === n.key ? "active" : ""}`} onClick={() => setView(n.key)}>
            <span className="nav-icon">{n.icon}</span><span>{n.label}</span>
          </button>
        ))}

        {/* Playbook — expandable, its subfolders are saved filters */}
        <div className={`nav-group ${view === "playbook" ? "active-group" : ""}`}>
          <button className={`nav-item ${view === "playbook" ? "active" : ""}`}
            onClick={() => { setView("playbook"); setOpen(true); }}>
            <span className="nav-icon">▣</span><span>Playbook</span>
            <span className="nav-chev" role="button" aria-label={open ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div className="nav-sub">
              {folders.map((f) => (
                <button key={f.id}
                  className={`nav-subitem ${view === "playbook" && folderId === f.id ? "active" : ""}`}
                  onClick={() => { setView("playbook"); setFolderId(f.id); }}>
                  <span className="nav-subdot" />{f.name}
                  {!f.builtin && (
                    <span className="nav-subdel" title="Delete folder"
                      onClick={(e) => { e.stopPropagation(); onDeleteFolder(f.id); }}>×</span>
                  )}
                </button>
              ))}
              <button className="nav-newfolder" onClick={() => { setView("playbook"); onNewFolder(); }}>+ New Folder</button>
            </div>
          )}
        </div>

        {NAV_TAIL.map((n) => (
          <button key={n.key} className={`nav-item ${view === n.key ? "active" : ""}`} onClick={() => setView(n.key)}>
            <span className="nav-icon">{n.icon}</span><span>{n.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="session-card">
          <div className="card-label">MARKET SESSION</div>
          <div className={`session-status session-${session.cls}`}>
            <span className="session-dot" />{session.label}
          </div>
          <div className="session-clock">{session.clock}</div>
          <div className="session-next">Next: {session.next}</div>
        </div>
      </div>
    </aside>
  );
}

// ── Topbar ─────────────────────────────────────────────────────────
function Dropdown({ label, value, options, onChange }) {
  return (
    <label className="tb-select">
      <span className="tb-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange && onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function Topbar({ title, subtitle, session, dates, selectedDate, setSelectedDate }) {
  const dateOpts = [{ value: "", label: "Latest" }, ...dates.map((d) => ({ value: d, label: fmtLongDate(d) }))];
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="topbar-controls">
        <Dropdown label="Date" value={selectedDate || ""} options={dateOpts} onChange={(v) => setSelectedDate(v || null)} />
      </div>
      <div className="topbar-right">
        <div className={`market-status session-${session.cls}`}><span className="session-dot" />{session.label}</div>
        <div className="topbar-clock">{session.clock}</div>
      </div>
    </header>
  );
}

// ── Placeholder page ───────────────────────────────────────────────
function Placeholder({ title }) {
  return (
    <div className="placeholder">
      <div className="placeholder-glyph">◱</div>
      <div className="placeholder-title">{title}</div>
      <div className="placeholder-sub">This module is part of the Small Cap Heat platform. The Overview dashboard is the live build.</div>
    </div>
  );
}

function GaugePage({ entries, selectedDate, onSelectDate }) {
  const s = window.buildDailySeries(entries);
  const today = selectedDate ? s.find((d) => d.date === selectedDate) : (s.length ? s[s.length - 1] : null);
  const state = today ? today.state : "EMPTY";
  const rules = window.RULES[state] || window.RULES.NEUTRAL;
  return (
    <div className="gauge-page">
      <section className="hero-grid hero-grid-2">
        <window.HeatScoreCard today={today} />
        <window.MarketStateCard state={state} rules={rules} />
      </section>
      <window.RollingStrip series={s} activeDate={today ? today.date : null} onSelectDay={onSelectDate} />
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────
function App({ tweaks }) {
  const [entries, setEntries] = useState_App([]);
  const [status, setStatus] = useState_App("loading");
  const [errorMsg, setErrorMsg] = useState_App("");
  const [selectedDate, setSelectedDate] = useState_App(null);
  const [view, setView] = useState_App("overview");
  const [filterState, setFilterState] = useState_App(() => window.emptyFilterState());
  const [folders, setFolders] = useState_App(() => window.pbLoadFolders());
  const [folderId, setFolderId] = useState_App("all");
  const [newFolderOpen, setNewFolderOpen] = useState_App(false);

  const createFolder = (f) => {
    const next = folders.concat([f]);
    setFolders(next);
    window.pbSaveCustom(window.pbCustomOnly(next));
    setFolderId(f.id);
    setNewFolderOpen(false);
  };
  const deleteFolder = (id) => {
    const next = folders.filter((f) => f.id !== id);
    setFolders(next);
    window.pbSaveCustom(window.pbCustomOnly(next));
    if (folderId === id) setFolderId("all");
  };
  const now = useClock();
  const session = marketSession(now);

  const thresholds = useMemo_App(() => ({
    hodHot: tweaks.hodHot, hodNeutralLo: tweaks.hodNeutralLo, fadeHot: tweaks.fadeHot, fadeCold: tweaks.fadeCold,
  }), [tweaks]);

  useEffect_App(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DATA_URL, { cache: "no-store" });
        if (res.status === 404) { if (!cancelled) { setEntries([]); setStatus("empty"); } return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!raw.trim()) { if (!cancelled) { setEntries([]); setStatus("empty"); } return; }
        let data; try { data = JSON.parse(raw); } catch { throw new Error("data2.json is not valid JSON"); }
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
        if (cancelled) return;
        if (!list || list.length === 0) { setEntries([]); setStatus("empty"); return; }
        const normalized = list.map(normalizeEntry).filter(Boolean);
        if (normalized.length === 0) { setEntries([]); setStatus("empty"); return; }
        setEntries(normalized);
        setStatus("ready");
      } catch (err) {
        if (!cancelled) { setErrorMsg(err.message || String(err)); setStatus("error"); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const scoredEntries = useMemo_App(() => entries.map((e) => {
    const r = window.computeHeat(e, thresholds);
    return { ...e, score: r.score, state: r.state, isBlackSwan: r.isBlackSwan || false };
  }), [entries, thresholds]);

  const filterPredicate = useMemo_App(() => window.makePredicate(filterState), [filterState]);
  const filterActive = useMemo_App(() => window.filterActiveCount(filterState) > 0, [filterState]);

  const dates = useMemo_App(() => [...scoredEntries].map((e) => e.date).sort((a, b) => (a < b ? 1 : -1)), [scoredEntries]);

  const titleFor = {
    overview: ["Market Heat Overview", "Real-time analysis of small cap market conditions"],
    gauge: ["Heat Gauge", "Market temperature and today's playbook"],
    calendar: ["Calendar", "Daily heat state across the month"],
    movers: ["Top Movers", "Every runner occurrence in the selected range"],
    playbook: ["Playbook", "Your library of plays, grouped into folders"],
    settings: ["Settings", "Platform configuration"],
  }[view] || ["Small Cap Heat", ""];

  const latestEntry = useMemo_App(() => (scoredEntries.length ? [...scoredEntries].sort((a, b) => (a.date < b.date ? 1 : -1))[0] : null), [scoredEntries]);
  // NOTE: clicking a day in the Overview heat calendar shows an inline detail
  // panel there — it deliberately does NOT navigate away from the Overview.
  const shell = (body, banner) => (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} session={session}
        folders={folders} folderId={folderId} setFolderId={setFolderId}
        onNewFolder={() => setNewFolderOpen(true)} onDeleteFolder={deleteFolder} />
      <div className="main">
        <Topbar title={titleFor[0]} subtitle={titleFor[1]} session={session} dates={dates} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
        {banner}
        <div className="content">{body}</div>
      </div>
    </div>
  );

  if (status === "loading") return shell(<div className="data-status"><div className="label muted">FETCHING {DATA_URL}…</div></div>);
  if (status === "empty") return shell(<div className="data-status data-status-empty"><div className="data-status-glyph">∅</div><div className="data-status-title">NO DATA LOADED</div><div className="data-status-hint">Add entries to <code>data2.json</code> and reload.</div></div>);
  if (status === "error") return shell(<div className="data-status data-status-error"><div className="label">COULD NOT LOAD {DATA_URL}</div><div className="data-status-msg">{errorMsg}</div></div>);

  let page, banner = null;
  if (view === "overview") {
    banner = <div className="trend-banner"><window.AISummaryBar entries={scoredEntries} aiSummary={(latestEntry && latestEntry.aiSummary) || null} /></div>;
    page = <window.Overview entries={scoredEntries} thresholds={thresholds} filterState={filterState} setFilterState={setFilterState} filterPredicate={filterPredicate} filterActive={filterActive} selectedDate={selectedDate} onSelectDate={setSelectedDate} />;
  } else if (view === "calendar") {
    page = <window.CalendarView entries={scoredEntries} thresholds={thresholds} onDeleteRunner={null} focusDate={selectedDate} />;
  } else if (view === "movers") {
    page = <window.TopMovers entries={scoredEntries} selectedDate={selectedDate} filterPredicate={filterPredicate} filterActive={filterActive} />;
  } else if (view === "playbook") {
    page = <window.PlaybookPage entries={scoredEntries} folderId={folderId} folders={folders}
      newFolderOpen={newFolderOpen} onCreateFolder={createFolder} onCancelFolder={() => setNewFolderOpen(false)} />;
  } else if (view === "settings") {
    page = <window.SettingsPage />;
  } else if (view === "gauge") {
    page = <GaugePage entries={scoredEntries} selectedDate={selectedDate} onSelectDate={setSelectedDate} />;
  } else {
    page = <Placeholder title={titleFor[0]} />;
  }
  return shell(page, banner);
}

Object.assign(window, { App });
