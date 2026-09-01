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

// ── Nav icons ──────────────────────────────────────────────────────
// Inline SVG, no icon library. All five share one geometry: 24x24 box, outline
// only, stroke-width 1.5, round caps/joins, currentColor — so they inherit the
// nav item's active/inactive colour and stay legible at 20px with no label.
const NAV_ICON_PATHS = {
  // 2x2 dashboard grid
  overview: (
    <>
      <rect x="3.75" y="3.75" width="7" height="7" rx="1.6" />
      <rect x="13.25" y="3.75" width="7" height="7" rx="1.6" />
      <rect x="3.75" y="13.25" width="7" height="7" rx="1.6" />
      <rect x="13.25" y="13.25" width="7" height="7" rx="1.6" />
    </>
  ),
  // calendar: hanger rings + header band + a 2x2 date grid.
  // A folded top corner was tried first (see the report) — at 20px it read as a
  // document/spreadsheet, so the hangers carry the recognition instead.
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10.5h17" />
      <path d="M8 3v5M16 3v5" />
      <path d="M12 10.5v10M3.5 15.5h17" />
    </>
  ),
  // ascending bars on a baseline with an up-arrow over the tallest
  movers: (
    <>
      <path d="M3.25 20.5h17.5" />
      <rect x="4.5" y="14" width="3.6" height="6.5" rx="0.8" />
      <rect x="10.2" y="10.5" width="3.6" height="10" rx="0.8" />
      <rect x="15.9" y="10" width="3.6" height="10.5" rx="0.8" />
      <path d="M15 7.4 17.7 4.7l2.7 2.7" />
      <path d="M17.7 4.7v5.3" />
    </>
  ),
  // open book with a bookmark ribbon over the right-hand page
  playbook: (
    <>
      <path d="M12 8.1c-1.5-1.3-3.7-2-6.5-2-.85 0-1.5.65-1.5 1.45v9.9c0 .8.65 1.45 1.5 1.45 2.8 0 5 .7 6.5 2 1.5-1.3 3.7-2 6.5-2 .85 0 1.5-.65 1.5-1.45V7.55c0-.8-.65-1.45-1.5-1.45-2.8 0-5 .7-6.5 2Z" />
      <path d="M12 8.1v12.8" />
      <path d="M14.6 6.5v6.4l2.45-1.85L19.5 12.9V6.2" />
    </>
  ),
  // 8-tooth cog (path generated, see the tooth geometry in the report)
  settings: (
    <>
      <path d="M10 5.4L10.45 3.13L13.55 3.13L14 5.4L15.26 5.92L17.18 4.64L19.36 6.82L18.08 8.74L18.6 10L20.87 10.45L20.87 13.55L18.6 14L18.08 15.26L19.36 17.18L17.18 19.36L15.26 18.08L14 18.6L13.55 20.87L10.45 20.87L10 18.6L8.74 18.08L6.82 19.36L4.64 17.18L5.92 15.26L5.4 14L3.13 13.55L3.13 10.45L5.4 10L5.92 8.74L4.64 6.82L6.82 4.64L8.74 5.92Z" />
      <circle cx="12" cy="12" r="3.1" />
    </>
  ),
};

function NavIcon({ name }) {
  const glyph = NAV_ICON_PATHS[name];
  if (!glyph) return null;
  return (
    <svg className="nav-svg" viewBox="0 0 24 24" width="20" height="20"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {glyph}
    </svg>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────
const NAV = [
  { key: "overview", label: "Overview",   icon: "overview" },
  { key: "calendar", label: "Calendar",   icon: "calendar" },
  { key: "movers",   label: "Top Movers", icon: "movers" },
];
const NAV_TAIL = [
  { key: "settings", label: "Settings",   icon: "settings" },
];

// Collapsed state survives reloads — it's a layout preference, not view state.
const SIDEBAR_KEY = "hg2:sidebarCollapsed";
function loadSidebarCollapsed() {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === "1"; } catch (_) { return false; }
}
function saveSidebarCollapsed(v) {
  try { window.localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0"); } catch (_) {}
}

function Sidebar({ view, setView, session, folders, folderId, setFolderId, onNewFolder, onDeleteFolder }) {
  const [open, setOpen] = useState_App(true);
  const [collapsed, setCollapsed] = useState_App(loadSidebarCollapsed);
  const toggleCollapsed = () => setCollapsed((v) => { saveSidebarCollapsed(!v); return !v; });

  // `data-label` feeds the CSS tooltip that replaces the hidden text when collapsed.
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <button className="sidebar-toggle" onClick={toggleCollapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}>
        {collapsed ? "›" : "‹"}
      </button>

      <div className="brand" data-label="THE HEAT GAUGE">
        <span className="brand-logo">
          {/* logo-icon.png is the gauge/bull mark ONLY, generated from the master
              artwork — the wordmark is illegible at 28px. object-position can't
              do this job: the source is square and so is the box, so `cover`
              never actually crops. */}
          <img className="brand-mark" src="src/logo-icon.png?v=46" width="28" height="28"
               alt="" draggable="false" />
        </span>
        <span className="brand-name">THE HEAT GAUGE</span>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${view === n.key ? "active" : ""}`}
            data-label={n.label} aria-label={n.label} onClick={() => setView(n.key)}>
            <span className="nav-icon"><NavIcon name={n.icon} /></span><span className="nav-text">{n.label}</span>
          </button>
        ))}

        {/* Playbook — expandable, its subfolders are saved filters */}
        <div className={`nav-group ${view === "playbook" ? "active-group" : ""}`}>
          <button className={`nav-item ${view === "playbook" ? "active" : ""}`}
            data-label="Playbook" aria-label="Playbook"
            onClick={() => { setView("playbook"); setOpen(true); }}>
            <span className="nav-icon"><NavIcon name="playbook" /></span><span className="nav-text">Playbook</span>
            <span className="nav-chev" role="button" aria-label={open ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>{open ? "▾" : "▸"}</span>
          </button>
          {open && !collapsed && (
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
          <button key={n.key} className={`nav-item ${view === n.key ? "active" : ""}`}
            data-label={n.label} aria-label={n.label} onClick={() => setView(n.key)}>
            <span className="nav-icon"><NavIcon name={n.icon} /></span><span className="nav-text">{n.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="session-card" data-label={`${session.label} · ${session.clock}`}>
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

function Topbar({ title, subtitle, session, dates, selectedDate, setSelectedDate, user, profile }) {
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
        <div className="topbar-session">
          <div className={`market-status session-${session.cls}`}><span className="session-dot" />{session.label}</div>
          <div className="topbar-clock">{session.clock}</div>
        </div>
        {window.AuthUserMenu && <window.AuthUserMenu user={user} profile={profile} />}
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
      <div className="placeholder-sub">This module is part of The Heat Gauge platform. The Overview dashboard is the live build.</div>
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
function App({ tweaks, user, profile }) {
  const [entries, setEntries] = useState_App([]);
  const [status, setStatus] = useState_App("loading");
  const [errorMsg, setErrorMsg] = useState_App("");
  const [selectedDate, setSelectedDate] = useState_App(null);
  const [view, setView] = useState_App("overview");
  const [filterState, setFilterState] = useState_App(() => window.emptyFilterState());
  // Folders live in a shared store (Playbook.jsx) so the sidebar, the Playbook
  // page and every "Add to Playbook" popover stay in sync without prop drilling.
  const folders = window.pbUseFolders();
  const [folderId, setFolderId] = useState_App("all");
  const [newFolderOpen, setNewFolderOpen] = useState_App(false);

  const createFolder = (f) => {
    window.pbAddFolder(f);
    setFolderId(f.id);
    setNewFolderOpen(false);
  };
  const deleteFolder = (id) => {
    window.pbDeleteFolder(id);
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
        // The UI's theme vocabulary is a hand-written mirror of the pipeline's.
        // Compare them the moment the data lands and shout if they disagree —
        // picking a theme the pipeline can't read back is a silent data bug.
        if (window.checkThemeVocab) window.checkThemeVocab(data && data.themeVocab);
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

  // Manual overrides are layered over the pipeline data ONCE, here, so every
  // downstream consumer — filters, Top Movers, Playbook criteria, Insights —
  // sees the same effective values as the tiles do. ovrVer changes whenever the
  // Firestore snapshot does, including edits made by someone else on the desk.
  // ovrMergeRunner returns the runner unchanged when it has no override, so
  // this stays cheap across ~9.6k runners.
  const ovrVer = window.ovrUseVersion ? window.ovrUseVersion() : 0;
  const scoredEntries = useMemo_App(() => entries.map((e) => {
    const r = window.computeHeat(e, thresholds);
    const runners = window.ovrMergeRunner
      ? (e.runners || []).map(window.ovrMergeRunner) : e.runners;
    return { ...e, runners, score: r.score, state: r.state, isBlackSwan: r.isBlackSwan || false };
  }), [entries, thresholds, ovrVer]);

  // The folder editor is reachable from places that don't hold `entries` (the
  // Add-to-Playbook popover), so publish the loaded data for its option lists.
  window.pbRegisterEntries(scoredEntries);

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
  }[view] || ["The Heat Gauge", ""];

  const latestEntry = useMemo_App(() => (scoredEntries.length ? [...scoredEntries].sort((a, b) => (a.date < b.date ? 1 : -1))[0] : null), [scoredEntries]);
  // NOTE: clicking a day in the Overview heat calendar shows an inline detail
  // panel there — it deliberately does NOT navigate away from the Overview.
  const shell = (body, banner) => (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} session={session}
        folders={folders} folderId={folderId} setFolderId={setFolderId}
        onNewFolder={() => setNewFolderOpen(true)} onDeleteFolder={deleteFolder} />
      <div className="main">
        <Topbar title={titleFor[0]} subtitle={titleFor[1]} session={session} dates={dates}
          selectedDate={selectedDate} setSelectedDate={setSelectedDate} user={user} profile={profile} />
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
    page = <window.SettingsPage entries={scoredEntries} />;
  } else if (view === "gauge") {
    page = <GaugePage entries={scoredEntries} selectedDate={selectedDate} onSelectDate={setSelectedDate} />;
  } else {
    page = <Placeholder title={titleFor[0]} />;
  }
  return shell(page, banner);
}

Object.assign(window, { App });
