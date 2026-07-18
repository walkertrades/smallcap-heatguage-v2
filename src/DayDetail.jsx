// Inline day-detail panel, rendered inside the strip card under the cells.
// Cleaner and more readable than the modal version.

function DayDetailInline({ entry, thresholds, onClose, onDeleteRunner, filterPredicate, filterActive }) {
  if (!entry) return null;
  const stateLower = entry.state.toLowerCase();
  const runners = entry.runners || [];
  const sorted = [...runners].sort((a, b) => b.hod - a.hod);

  // Reasoning bullets — three factor calls with pos/mid/neg signals
  const factors = [];
  if (entry.hod >= thresholds.hodHot) {
    factors.push({ kind: "pos", label: "AVG HOD", detail: `+${entry.hod}% ≥ ${thresholds.hodHot}%`, tag: "HOT" });
  } else if (entry.hod >= thresholds.hodNeutralLo) {
    factors.push({ kind: "mid", label: "AVG HOD", detail: `+${entry.hod}% (${thresholds.hodNeutralLo}–${thresholds.hodHot}%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG HOD", detail: `+${entry.hod}% < ${thresholds.hodNeutralLo}%`, tag: "COLD" });
  }
  if (entry.fade <= thresholds.fadeHot) {
    factors.push({ kind: "pos", label: "AVG FADE", detail: `${entry.fade}% ≤ ${thresholds.fadeHot}%`, tag: "HOT" });
  } else if (entry.fade <= thresholds.fadeCold) {
    factors.push({ kind: "mid", label: "AVG FADE", detail: `${entry.fade}% (${thresholds.fadeHot}–${thresholds.fadeCold}%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG FADE", detail: `${entry.fade}% > ${thresholds.fadeCold}%`, tag: "COLD" });
  }
  const timeLabel = entry.hodTime === "session" ? "SESSION" : entry.hodTime === "premarket" ? "PREMARKET" : "MIXED";
  const timeKind = entry.hodTime === "session" ? "pos" : entry.hodTime === "premarket" ? "neg" : "mid";
  const timeTag = entry.hodTime === "session" ? "HOT" : entry.hodTime === "premarket" ? "COLD" : "NEUTRAL";
  factors.push({ kind: timeKind, label: "TIME · MAJORITY", detail: timeLabel, tag: timeTag });

  // PM risk flag — shown when premarket-dominant regardless of state
  const pmFlag = entry.hodTime === "premarket";

  // Heavy fade risk flag — shown when avg fade > 40% regardless of HOD
  const fadeFlag = entry.fade > 40;
  const extremeFade = entry.fade > 55;

  const fmtDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  };

  return (
    <div className={`detail state-${stateLower}`}>
      <div className="detail-header">
        <div className="detail-header-left">
          <div className="label muted">{fmtDate(entry.date)}</div>
          <div className="detail-title-row">
            <span className={`detail-state state-text-${stateLower}`}>{entry.state}</span>
            <span className="detail-divider">·</span>
            <span className="detail-score">{entry.score}</span>
            {entry.theme && <span className="detail-theme">{entry.theme}</span>}
          </div>
        </div>
        <button className="detail-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {entry.note && (
        <div className="detail-summary">
          <span className="detail-summary-icon">✱</span>
          <p>{entry.note}</p>
        </div>
      )}

      {pmFlag && (
        <div className="pm-flag">
          <span className="pm-flag-icon">⚑</span>
          <div>
            <div className="pm-flag-title">PREMARKET HOD RISK</div>
            <div className="pm-flag-body">
              Dominant HOD hit before 9:30 — classic distribution pattern. State is {entry.state} from HOD/fade, but size down and treat PM prints as exit liquidity, not entries.
            </div>
          </div>
        </div>
      )}

      {fadeFlag && (
        <div className="pm-flag" style={{background: extremeFade ? "oklch(0.22 0.08 0)" : "oklch(0.22 0.06 25)", borderColor: extremeFade ? "oklch(0.55 0.18 0)" : "oklch(0.55 0.14 25)"}}>
          <span className="pm-flag-icon" style={{color: extremeFade ? "oklch(0.75 0.2 0)" : "oklch(0.80 0.18 30)"}}>⚡</span>
          <div>
            <div className="pm-flag-title" style={{color: extremeFade ? "oklch(0.80 0.18 0)" : "oklch(0.85 0.15 30)"}}>
              {extremeFade ? "EXTREME FADE RISK" : "HEAVY FADE TAPE"}
            </div>
            <div className="pm-flag-body">
              {extremeFade
                ? `Avg fade ${entry.fade}% — names gave back most of their move. Classic trap day pattern. Follow-through next session is high risk — size way down and wait for confirmation.`
                : `Avg fade ${entry.fade}% exceeds the cold threshold. Moves ran but didn't hold — take profits early and avoid chasing HOD breaks.`
              }
            </div>
          </div>
        </div>
      )}

      <div className="factor-grid">
        {factors.map((f, i) => (
          <div key={i} className={`factor factor-${f.kind}`}>
            <div className="factor-head">
              <span className="factor-label">{f.label}</span>
              <span className={`factor-tag tag-${f.tag.toLowerCase()}`}>{f.tag}</span>
            </div>
            <div className="factor-detail">{f.detail}</div>
          </div>
        ))}
      </div>

      {sorted.length > 0 && (
        <RunnersBlock runners={sorted} thresholds={thresholds} entry={entry} onDeleteRunner={onDeleteRunner} filterPredicate={filterPredicate} filterActive={filterActive} />
      )}
    </div>
  );
}

Object.assign(window, { DayDetailInline });

function RunnersBlock({ runners, thresholds, entry, onDeleteRunner, filterPredicate, filterActive }) {
  const [advanced, setAdvanced] = React.useState(false);
  const [expandedSym, setExpandedSym] = React.useState(null);

  const toggleExpand = (sym) => setExpandedSym((prev) => (prev === sym ? null : sym));

  // When filters are active, narrow the runner list to matches.
  const shown = (filterActive && filterPredicate) ? runners.filter(filterPredicate) : runners;

  if (filterActive && shown.length === 0) {
    return (
      <div className="runners">
        <div className="runners-head-row">
          <div className="runners-label label">TOP MOVERS · 0 of {runners.length} match filters</div>
        </div>
        <div className="runners-nomatch">No runners on this day match the active filters.</div>
      </div>
    );
  }

  return (
    <div className="runners">
      <div className="runners-head-row">
        <div className="runners-label label">TOP MOVERS · {shown.length}{filterActive ? ` of ${runners.length}` : ""}</div>
        <div className="adv-toggle" role="group" aria-label="Detail level">
          <button
            className={`adv-btn ${!advanced ? "active" : ""}`}
            onClick={() => setAdvanced(false)}
            type="button"
          >BASIC</button>
          <button
            className={`adv-btn ${advanced ? "active" : ""}`}
            onClick={() => setAdvanced(true)}
            type="button"
          >ADVANCED</button>
        </div>
      </div>

      {!advanced ? (
        <div className="runners-grid">
          <div className="runners-head">
            <span>TICKER</span>
            <span className="num">HOD</span>
            <span className="num">FADE</span>
            <span className="num">TIME</span>
            <span />
          </div>
          {shown.map((r) => {
            const isExpanded = expandedSym === r.sym;
            return (
              <React.Fragment key={r.sym}>
                <div
                  className={`runners-row runner-row-click ${isExpanded ? "is-expanded" : ""}`}
                  onClick={() => toggleExpand(r.sym)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="runner-sym">
                    <span className="runner-chev" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> {r.sym}
                  </span>
                  <span className="num runner-hod">+{r.hod}%</span>
                  <span className={`num runner-fade ${r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid"}`}>
                    {r.fade}%
                  </span>
                  <span className={`num runner-time time-${window.sessionColorClass(r.session)}`} title={window.sessionLabel(r.session)}>
                    {window.sessionAbbr(r.session)}
                  </span>
                  {onDeleteRunner && (
                    <button
                      className="runner-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Remove ${r.sym} from ${entry.date}?`)) {
                          onDeleteRunner(entry.date, r.sym);
                        }
                      }}
                      aria-label={`Remove ${r.sym}`}
                      title={`Remove ${r.sym}`}
                    >×</button>
                  )}
                </div>
                {isExpanded && (
                  <div className="runner-tile-wrap">
                    <RunnerTile r={r} />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        <AdvancedRunnersTable runners={shown} thresholds={thresholds} entry={entry} onDeleteRunner={onDeleteRunner} expandedSym={expandedSym} onToggleExpand={toggleExpand} />
      )}
    </div>
  );
}

function AdvancedRunnersTable({ runners, thresholds, entry, onDeleteRunner, expandedSym, onToggleExpand }) {
  return (
    <div className="adv-table-wrap">
      <table className="adv-table">
        <thead>
          <tr>
            <th className="sticky-col">TICKER</th>
            <th>NAME</th>
            <th>SECTOR</th>
            <th className="num">CTRY</th>
            <th className="num">FLOAT</th>
            <th className="num">MKT CAP</th>
            <th className="num">HOD %</th>
            <th className="num">HOD TIME</th>
            <th className="num">FADE %</th>
            <th className="num">GAP %</th>
            <th className="num">OPEN</th>
            <th className="num">HIGH</th>
            <th className="num">CLOSE</th>
            <th className="num">VWAP</th>
            <th className="num">PM HIGH</th>
            <th className="num">RELVOL</th>
            <th>NEWS</th>
            <th className="num">SESSION</th>
            {onDeleteRunner && <th />}
          </tr>
        </thead>
        <tbody>
          {runners.map((r) => {
            const fadeClass = r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid";
            const isExpanded = expandedSym === r.sym;
            const colCount = 18 + (onDeleteRunner ? 1 : 0);
            return (
              <React.Fragment key={r.sym}>
                <tr
                  className={`adv-row-click ${isExpanded ? "is-expanded" : ""}`}
                  onClick={() => onToggleExpand && onToggleExpand(r.sym)}
                >
                  <td className="sticky-col adv-t-sym">
                    <span className="runner-chev" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> {r.sym}
                  </td>
                  <td className="adv-t-name" title={r.name || ""}>{r.name || "—"}</td>
                  <td>{r.sector || "—"}</td>
                  <td className="num">{r.country || "—"}</td>
                  <td className="num">{r.floatM != null ? `${r.floatM}M` : "—"}</td>
                  <td className="num">{r.marketCap || "—"}</td>
                  <td className="num runner-hod">+{r.hodExact != null ? r.hodExact.toFixed(1) : r.hod}%</td>
                  <td className="num adv-t-timeex">{r.hodTimeExact || "—"}</td>
                  <td className={`num ${fadeClass}`}>{r.fade != null ? `${r.fade}%` : "—"}</td>
                  <td className="num">{r.gapPct != null ? `${r.gapPct > 0 ? "+" : ""}${r.gapPct}%` : "—"}</td>
                  <td className="num">{r.open != null ? `$${fmt(r.open)}` : "—"}</td>
                  <td className="num">{r.high != null ? `$${fmt(r.high)}` : "—"}</td>
                  <td className="num">
                    {r.close != null ? `$${fmt(r.close)}` : "—"}
                    {r.vsVwap && <span className="adv-t-sub"> {r.vsVwap === "above" ? "▲" : "▼"}</span>}
                  </td>
                  <td className="num">{r.vwap != null ? `$${fmt(r.vwap)}` : "—"}</td>
                  <td className="num">{r.pmHigh != null ? `$${fmt(r.pmHigh)}` : "—"}</td>
                  <td className="num">{r.relVol != null ? `${r.relVol}×` : "—"}</td>
                  <td className="adv-t-news">
                    {r.news && r.news.length > 0 ? (
                      <span className="adv-t-news-chip" title={r.news.join(" • ")}>
                        <span className="adv-t-news-dot" /> {r.news.length} {r.news[0]}
                      </span>
                    ) : (
                      <span className="adv-t-none">—</span>
                    )}
                  </td>
                  <td className={`num runner-time time-${window.sessionColorClass(r.session)}`} title={window.sessionLabel(r.session)}>
                    {window.sessionAbbr(r.session)}
                  </td>
                  {onDeleteRunner && (
                    <td>
                      <button
                        className="runner-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Remove ${r.sym} from ${entry.date}?`)) onDeleteRunner(entry.date, r.sym);
                        }}
                        aria-label={`Remove ${r.sym}`}
                      >×</button>
                    </td>
                  )}
                </tr>
                {isExpanded && (
                  <tr className="adv-tile-row">
                    <td colSpan={colCount}>
                      <RunnerTile r={r} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdvancedRunnerCard({ r, thresholds, entry, onDelete }) {
  const fadeClass = r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid";
  const stats = [
    r.prevClose != null && { k: "PREV CLOSE", v: `$${fmt(r.prevClose)}` },
    r.open != null && { k: "OPEN", v: `$${fmt(r.open)}`, sub: r.gapPct != null ? `${r.gapPct > 0 ? "+" : ""}${r.gapPct}% gap` : null },
    r.high != null && { k: "HOD", v: `$${fmt(r.high)}`, sub: r.hodTimeExact || null },
    r.low != null && { k: "LOW", v: `$${fmt(r.low)}` },
    r.close != null && { k: "CLOSE", v: `$${fmt(r.close)}`, sub: r.vsVwap ? `${r.vsVwap} VWAP` : null },
    r.vwap != null && { k: "VWAP", v: `$${fmt(r.vwap)}` },
    r.pmHigh != null && { k: "PM HIGH", v: `$${fmt(r.pmHigh)}` },
    r.relVol != null && { k: "RELVOL", v: `${r.relVol}×`, sub: r.avgVolM != null ? `avg ${r.avgVolM}M` : null },
  ].filter(Boolean);

  return (
    <div className="adv-card">
      <div className="adv-card-head">
        <div className="adv-card-id">
          <div className="adv-card-symrow">
            <span className="adv-sym">{r.sym}</span>
            <span className="adv-hod">+{r.hodExact != null ? r.hodExact.toFixed(2) : r.hod}%</span>
            <span className={`num runner-fade ${fadeClass} adv-fade`}>{r.fade}% fade</span>
            <span className={`num runner-time time-${r.time} adv-time`}>
              {r.time === "premarket" ? "PM" : r.time === "session" ? "SESS" : "MIX"}
            </span>
          </div>
          {r.name && <div className="adv-name">{r.name}</div>}
          <div className="adv-meta">
            {r.sector && <span className="adv-chip">{r.sector}</span>}
            {r.country && <span className="adv-chip muted">{r.country}</span>}
            {r.floatM != null && <span className="adv-chip muted">Float {r.floatM}M</span>}
            {r.marketCap && <span className="adv-chip muted">MC {r.marketCap}</span>}
          </div>
        </div>
        {onDelete && (
          <button
            className="runner-delete adv-delete"
            onClick={() => {
              if (confirm(`Remove ${r.sym} from ${entry.date}?`)) onDelete(entry.date, r.sym);
            }}
            aria-label={`Remove ${r.sym}`}
          >×</button>
        )}
      </div>

      {stats.length > 0 && (
        <div className="adv-stats">
          {stats.map((s) => (
            <div className="adv-stat" key={s.k}>
              <div className="adv-stat-k">{s.k}</div>
              <div className="adv-stat-v">{s.v}</div>
              {s.sub && <div className="adv-stat-sub">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {r.news && r.news.length > 0 && (
        <div className="adv-news">
          <div className="adv-news-label">NEWS · {r.news.length}</div>
          <ul className="adv-news-list">
            {r.news.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) < 1) return n.toFixed(3);
  if (Math.abs(n) < 10) return n.toFixed(2);
  return n.toFixed(2);
}

// Classification tag → accent color token for the left-border stripe + pill.
const TAG_ACCENT = {
  "RIG":               "oklch(0.7 0.18 150)",
  "FUNDAMENTAL":       "oklch(0.7 0.16 160)",
  "NEWS-DRIVEN":       "oklch(0.75 0.15 85)",
  "UNDERWRITER MANIP": "oklch(0.65 0.22 25)",
  "DILUTION BAIT":     "oklch(0.7 0.17 50)",
  "RETAIL PUMP":       "oklch(0.7 0.2 320)",
  "COMPLIANCE":        "oklch(0.72 0.15 90)",
  "SYMPATHY":          "oklch(0.7 0.14 240)",
  "MIXED":             "oklch(0.6 0.02 250)",
};
function tagAccent(tag) {
  return TAG_ACCENT[tag && tag.toUpperCase()] || TAG_ACCENT.MIXED;
}

// Strip leading ":red_circle:" / emoji circles and return { dot, text }.
// dot ∈ {"red","yellow","green","orange","blue","none"}
function extractTldrDot(s) {
  if (!s) return { dot: "none", text: "" };
  const map = [
    [/^\s*(?::red_circle:|🔴)\s*/i,    "red"],
    [/^\s*(?::yellow_circle:|🟡)\s*/i, "yellow"],
    [/^\s*(?::green_circle:|🟢)\s*/i,  "green"],
    [/^\s*(?::orange_circle:|🟠)\s*/i, "orange"],
    [/^\s*(?::blue_circle:|🔵)\s*/i,   "blue"],
  ];
  for (const [rx, dot] of map) {
    if (rx.test(s)) return { dot, text: s.replace(rx, "").trim() };
  }
  return { dot: "none", text: s.trim() };
}

// Linkify headline: first word looking like a URL becomes the link target,
// otherwise we build a Google News search for ticker + headline.
function headlineHref(sym, title) {
  const urlMatch = title && title.match(/https?:\/\/\S+/);
  if (urlMatch) return urlMatch[0];
  const q = encodeURIComponent(`${sym} ${title}`);
  return `https://news.google.com/search?q=${q}`;
}

function DottedList({ label, items }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="rt-lbl">{label}</div>
      <ul className="rt-tldr">
        {items.map((t, i) => {
          const { dot, text } = extractTldrDot(t);
          return (
            <li key={i}>
              {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
              <span>{linkifyText(text || t)}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Maps literal stoplight emoji to dot className, e.g. "🔴" → "red"
function emojiToDot(em) {
  if (!em) return null;
  if (em.includes("🔴")) return "red";
  if (em.includes("🟡")) return "yellow";
  if (em.includes("🟢")) return "green";
  if (em.includes("🟠")) return "orange";
  if (em.includes("🔵")) return "blue";
  return null;
}

function DynamicSection({ section }) {
  if (!section) return null;
  const headerDot = emojiToDot(section.emoji);
  const hasBullets = section.bullets && section.bullets.length > 0;
  const hasProse = !hasBullets && section.prose;
  if (!hasBullets && !hasProse) return null;

  return (
    <>
      <div className="rt-lbl rt-lbl-dyn">
        {headerDot && <span className={`rt-dot-ic rt-dot-${headerDot} rt-dot-inline`} />}
        <span>{section.title}</span>
      </div>
      {hasBullets && (
        <ul className="rt-tldr">
          {section.bullets.map((t, i) => {
            const { dot, text } = extractTldrDot(t);
            return (
              <li key={i}>
                {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
                <span>{linkifyText(text || t)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {hasProse && (
        <div className="rt-prose">{linkifyText(section.prose)}</div>
      )}
    </>
  );
}

// Turn inline URLs into <a> tags. Returns an array of strings + elements.
function linkifyText(s) {
  if (!s) return s;
  const parts = [];
  const rx = /(https?:\/\/[^\s)]+)/g;
  let last = 0, m;
  let i = 0;
  while ((m = rx.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(
      <a key={`ln-${i++}`} href={m[1]} target="_blank" rel="noreferrer" className="rt-link">
        {m[1].replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 50)}…
      </a>
    );
    last = m.index + m[1].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// ── v2 chip row: colored tag chips by type ─────────────────────────
// catalyst = one color family, country = another, sector = another,
// float tier = another. Colors come from window (v2schema.jsx).
function TagChips({ r }) {
  const chips = [];
  if (r.tag) {
    chips.push({ cls: "catalyst", label: String(r.tag).toUpperCase(), color: window.catalystColor(r.tag) });
  }
  if (r.floatTier) {
    chips.push({ cls: "floattier", label: r.floatTier + (r.floatM != null ? ` · ${r.floatM}M` : ""), color: window.floatTierColor(r.floatTier) });
  }
  if (r.sector) {
    const sec = r.sectorNorm || window.normalizeSector(r.sector);
    chips.push({ cls: "sector", label: sec, color: window.sectorColor(sec), title: r.sector });
  }
  if (r.country) {
    chips.push({ cls: "country", label: r.country, color: window.countryColor(r.country) });
  }
  if (r.marketCap) {
    chips.push({ cls: "mktcap", label: `MC ${r.marketCap}`, color: "oklch(0.52 0.02 250)" });
  }
  if (chips.length === 0) return null;
  return (
    <div className="rt-chips">
      {chips.map((c, i) => (
        <span key={i} className={`rt-chip rt-chip-${c.cls}`} style={{ "--chip-color": c.color }} title={c.title || c.cls}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

// ── Warning badges: SSR + reverse split ────────────────────────────
function WarnBadges({ r }) {
  const badges = [];
  if (r.ssr) badges.push({ key: "ssr", label: "SSR", title: "Short Sale Restriction active this day" });
  if (r.reverseSplit) badges.push({ key: "rs", label: `RS ${r.reverseSplit}`, title: `Reverse split within 30 days (${r.reverseSplit})` });
  if (badges.length === 0) return null;
  return (
    <div className="rt-warn-badges">
      {badges.map((b) => (
        <span key={b.key} className={`rt-warn-badge rt-warn-${b.key}`} title={b.title}>
          <span className="rt-warn-ic" aria-hidden="true">⚠</span> {b.label}
        </span>
      ))}
    </div>
  );
}

// ── Expanded HOD time slot ─────────────────────────────────────────
function HodTimeSlot({ r }) {
  const sess = r.session || window.deriveSession(r.hodTimeExact, r.time);
  const label = window.sessionLabel(sess);
  return (
    <div className={`rt-hodslot rt-sess-${sess}`}>
      <span className="rt-hodslot-k">HOD HIT</span>
      <span className="rt-hodslot-time">{r.hodTimeExact || "—"}</span>
      <span className="rt-hodslot-sess">{label}</span>
      {r.volDollar != null && (
        <span className="rt-hodslot-vol">$Vol {window.fmtDollar(r.volDollar)}</span>
      )}
    </div>
  );
}

// ── Bull / bear factor lists (Claude-generated in v2) ──────────────
function FactorColumns({ r }) {
  const bull = Array.isArray(r.bullFactors) ? r.bullFactors : [];
  const bear = Array.isArray(r.bearFactors) ? r.bearFactors : [];
  if (bull.length === 0 && bear.length === 0) return null;
  return (
    <div className="rt-factors">
      {bull.length > 0 && (
        <div className="rt-factor-col rt-factor-bull">
          <div className="rt-factor-h">▲ BULL</div>
          <ul>{bull.map((b, i) => <li key={i}>{linkifyText(b)}</li>)}</ul>
        </div>
      )}
      {bear.length > 0 && (
        <div className="rt-factor-col rt-factor-bear">
          <div className="rt-factor-h">▼ BEAR</div>
          <ul>{bear.map((b, i) => <li key={i}>{linkifyText(b)}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ── Behavior tag — manual, editable inline, persisted to localStorage ──
const BEHAVIOR_PRESETS = [
  "Clean fade", "Backside short", "Frontside runner", "Halt-go", "Grinder",
  "Trap / squeeze", "Multiday", "Choppy", "One-and-done", "Dead",
];
function BehaviorEditor({ r }) {
  const date = r._date;
  const [value, setValue] = React.useState(() => window.getBehaviorTag(date, r.sym, r.behaviorTag) || "");
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);

  const commit = (v) => {
    const saved = window.setBehaviorTag(date, r.sym, v);
    setValue(saved);
    setEditing(false);
  };

  return (
    <div className="rt-behavior">
      <div className="rt-behavior-head">
        <span className="rt-lbl rt-behavior-lbl">BEHAVIOR</span>
        {!editing && (
          value
            ? <span className="rt-behavior-chip" onClick={() => { setDraft(value); setEditing(true); }} title="Click to edit">{value}</span>
            : <button className="rt-behavior-add" onClick={() => { setDraft(""); setEditing(true); }}>+ tag behavior</button>
        )}
      </div>
      {editing && (
        <div className="rt-behavior-edit" onClick={(e) => e.stopPropagation()}>
          <input
            className="rt-behavior-input"
            autoFocus
            value={draft}
            placeholder="e.g. backside short"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(draft);
              else if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="rt-behavior-presets">
            {BEHAVIOR_PRESETS.map((p) => (
              <button key={p} className="rt-behavior-preset" onClick={() => commit(p)}>{p}</button>
            ))}
          </div>
          <div className="rt-behavior-actions">
            <button className="rt-behavior-save" onClick={() => commit(draft)}>Save</button>
            {value && <button className="rt-behavior-clear" onClick={() => commit("")}>Clear</button>}
            <button className="rt-behavior-cancel" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// TradingView Advanced Chart widget (free, no API key). Uses tv.js rather than
// the raw iframe because only this one honors studies_overrides — that's what
// makes the indicator colors in Settings actually apply.
let _tvSeq = 0;
function TradingViewChart({ sym, date }) {
  const idRef = React.useRef("tvc-" + (++_tvSeq));
  const hostRef = React.useRef(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!sym) return;
    let cancelled = false;
    const mount = () => {
      if (cancelled || !hostRef.current) return;
      if (!window.TradingView || !window.TradingView.widget) { setFailed(true); return; }
      hostRef.current.innerHTML = "";
      try {
        new window.TradingView.widget(window.cpWidgetConfig(sym, idRef.current, date, window.cpLoad()));
      } catch (e) { setFailed(true); }
    };
    if (window.TradingView && window.TradingView.widget) mount();
    else {
      // tv.js is loaded from index.html; wait for it if it hasn't landed yet
      let tries = 0;
      const iv = window.setInterval(() => {
        if (window.TradingView && window.TradingView.widget) { window.clearInterval(iv); mount(); }
        else if (++tries > 40) { window.clearInterval(iv); setFailed(true); }
      }, 100);
      return () => { cancelled = true; window.clearInterval(iv); };
    }
    return () => { cancelled = true; };
  }, [sym, date]);

  if (!sym) return null;
  const range = window.cpRangeForDate(date);
  return (
    <div className="rt-chart">
      <div className="rt-chart-head">
        <span className="rt-lbl">CHART · {String(sym).toUpperCase()}</span>
        {date && <span className="rt-chart-date">showing {range} window incl. {date}</span>}
      </div>
      <div className="rt-chart-frame">
        <div id={idRef.current} ref={hostRef} className="rt-chart-host" />
        {failed && <div className="rt-chart-fail">Chart unavailable (TradingView script blocked).</div>}
      </div>
    </div>
  );
}

// Inline catalyst tag editor — pick from the v2 vocabulary and/or add custom
// tags (ETB, HARD-TO-BORROW, HALT-L1…). Persists to localStorage by date+ticker.
function TagEditor({ r, edit, onChange, onClose }) {
  const [tag, setTag] = React.useState((edit && edit.tag) || r.tag || "");
  const [customs, setCustoms] = React.useState((edit && edit.customTags) || []);
  const [draft, setDraft] = React.useState("");

  const addCustom = () => {
    const v = draft.trim().toUpperCase();
    if (!v || customs.indexOf(v) >= 0) return;
    setCustoms(customs.concat(v));
    setDraft("");
  };
  const save = () => {
    onChange(window.setTagEdit(r._date, r.sym, { tag, customTags: customs }));
    onClose();
  };
  const clear = () => {
    onChange(window.setTagEdit(r._date, r.sym, { tag: null, customTags: [] }));
    onClose();
  };

  return (
    <div className="tagedit" onClick={(e) => e.stopPropagation()}>
      <div className="tagedit-lbl">CATALYST</div>
      <div className="tagedit-opts">
        {window.V2_CATALYST_TAGS.map((t) => (
          <button key={t} className={`tagedit-opt ${tag === t ? "on" : ""}`}
            style={{ "--cat": window.catalystColor(t) }} onClick={() => setTag(t)}>{t}</button>
        ))}
      </div>
      <div className="tagedit-lbl">CUSTOM TAGS</div>
      {customs.length > 0 && (
        <div className="tagedit-customs">
          {customs.map((c) => (
            <button key={c} className="rt-chip rt-chip-custom" onClick={() => setCustoms(customs.filter((x) => x !== c))}>
              {c} <span className="tagedit-x">×</span>
            </button>
          ))}
        </div>
      )}
      <div className="tagedit-add">
        <input value={draft} placeholder="e.g. ETB, HARD-TO-BORROW, HALT-L1"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} />
        <button className="tagedit-addbtn" onClick={addCustom}>Add</button>
      </div>
      <div className="tagedit-actions">
        <button className="tagedit-save" onClick={save}>Save</button>
        <button className="tagedit-clear" onClick={clear}>Reset</button>
        <button className="tagedit-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// v2 cleanup: these research sections are being replaced by Claude summarization
// in the pipeline, so they're hidden from the expanded runner view.
const HIDDEN_SECTIONS = /dilution|compliance|debt|liabilit/i;
function visibleSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.filter((s) => !HIDDEN_SECTIONS.test(String(s && s.title) || ""));
}

// Inline manual grade picker (replaces the auto Setup Score).
function GradePicker({ r, onGradeChange }) {
  const [grade, setGradeState] = React.useState(() => window.getGrade(r._date, r.sym));
  const pick = (g) => {
    const next = window.setGrade(r._date, r.sym, g === grade ? null : g); // click again to clear
    setGradeState(next);
    if (onGradeChange) onGradeChange(next);
  };
  const c = window.gradeColor(grade);
  return (
    <div className="rt-grade">
      <span className="rt-lbl rt-grade-lbl">GRADE</span>
      <span className={`grade-badge ${grade ? "graded" : "ungraded"} ${grade === "A++" ? "grade-gold" : ""}`} style={{ "--gc": c }}>
        {grade || "—"}
      </span>
      <div className="rt-grade-opts">
        {window.GRADES.map((g) => (
          <button key={g} className={`rt-grade-opt ${grade === g ? "on" : ""}`}
            style={{ "--gc": window.gradeColor(g) }}
            onClick={(e) => { e.stopPropagation(); pick(g); }}>{g}</button>
        ))}
      </div>
    </div>
  );
}

function RunnerTile({ r, onGradeChange }) {
  const [edit, setEdit] = React.useState(() => window.getTagEdit(r._date, r.sym));
  const [editing, setEditing] = React.useState(false);
  // an edited catalyst overrides the pipeline's tag
  const effTag = (edit && edit.tag) || r.tag;
  const rr = { ...r, tag: effTag };
  const tag = (effTag || "MIXED").toUpperCase();
  const accent = tagAccent(tag);
  const sections = visibleSections(r.sections);
  const hasTile = r.riskBadges || r.reasons || r.tldr || r.news && r.news.length > 0;

  // If this runner was imported from a weekly/daily recap WITHOUT the evening-recap
  // extras, we still show a clean tile with price action + whatever we have.
  return (
    <div className="runner-tile" style={{ "--tag-accent": accent }}>
      <div className="runner-tile-head">
        <div className="rt-left">
          <span className="rt-sym">{r.sym}</span>
          {r.tag && <span className="rt-tag" style={{ background: accent }}>{tag}</span>}
        </div>
        <div className="rt-hod">+{r.hodExact != null ? r.hodExact.toFixed(2) : r.hod}% <span className="rt-hod-sub">HOD</span></div>
      </div>

      <div className="rt-chiprow">
        <TagChips r={rr} />
        {edit && edit.customTags && edit.customTags.length > 0 && (
          <div className="rt-chips rt-chips-custom">
            {edit.customTags.map((c) => (
              <span key={c} className="rt-chip rt-chip-custom">{c}</span>
            ))}
          </div>
        )}
        <button className="rt-editbtn" onClick={(e) => { e.stopPropagation(); setEditing((v) => !v); }}>
          {editing ? "Close" : "Edit Tags"}
        </button>
      </div>
      {editing && (
        <TagEditor r={r} edit={edit} onChange={setEdit} onClose={() => setEditing(false)} />
      )}
      <WarnBadges r={r} />
      <GradePicker r={r} onGradeChange={onGradeChange} />
      <HodTimeSlot r={r} />

      {/* Chart screenshots replaced the TradingView embed. Shared storage with
          the Playbook tiles — same ticker+date shows the same image in both. */}
      <div className="rt-chart">
        <div className="rt-chart-head">
          <span className="rt-lbl">CHART · {String(r.sym).toUpperCase()}</span>
          <span className="rt-chart-date">{r._date}</span>
        </div>
        <window.ShotZone date={r._date} sym={r.sym} />
      </div>

      {r.newsSummary && (
        <div className="rt-newssum">
          <div className="rt-lbl">NEWS SUMMARY</div>
          <p className="rt-newssum-body">{linkifyText(r.newsSummary)}</p>
        </div>
      )}

      <FactorColumns r={r} />

      {r.riskBadges && r.riskBadges.length > 0 && (
        <div className="rt-badges">
          {r.riskBadges.map((b, i) => <span key={i} className="rt-badge">{b}</span>)}
        </div>
      )}

      {/* Dynamic research-report sections (News / Why it's running, Dilution Risk,
          Compliance, Analyst Notes, Theme, Other Catalysts, etc.) */}
      {sections.length > 0 && sections.map((s, i) => (
        <DynamicSection key={i} section={s} />
      ))}

      {/* Legacy fallback: if the recap used the old **Why it ran** format
          AND there are no dynamic sections */}
      {sections.length === 0 &&
       r.reasons && r.reasons.length > 0 && (
        <>
          <div className="rt-lbl">Why it ran</div>
          <ul className="rt-reasons">
            {r.reasons.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </>
      )}

      {r.tldr && r.tldr.length > 0 && (
        <>
          <div className="rt-lbl">AskEdgar TLDR</div>
          <ul className="rt-tldr">
            {r.tldr.map((t, i) => {
              const { dot, text } = extractTldrDot(t);
              return (
                <li key={i}>
                  {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
                  <span>{text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="rt-pa">
        {r.prevClose != null && (
          <div><span className="rt-k">Prev</span><b>${fmt(r.prevClose)}</b></div>
        )}
        {r.open != null && (
          <div>
            <span className="rt-k">Open</span>
            <b>${fmt(r.open)}</b>
            {r.gapPct != null && <i>({r.gapPct > 0 ? "+" : ""}{r.gapPct}%)</i>}
          </div>
        )}
        {r.high != null && (
          <div>
            <span className="rt-k">HOD</span>
            <b>${fmt(r.high)}</b>
            {r.hodTimeExact && <i>{r.hodTimeExact}</i>}
          </div>
        )}
        {r.close != null && (
          <div>
            <span className="rt-k">Close</span>
            <b>${fmt(r.close)}</b>
            {r.fade != null && <i>(fade {r.fade}%)</i>}
          </div>
        )}
        {r.vwap != null && (
          <div>
            <span className="rt-k">VWAP</span>
            <b>${fmt(r.vwap)}</b>
            {r.vsVwap && <i>({r.vsVwap})</i>}
          </div>
        )}
        {(r.volRaw || r.relVol != null) && (
          <div>
            <span className="rt-k">Vol</span>
            {r.volRaw && <b>{r.volRaw}</b>}
            {r.relVol != null && <i>RelVol {r.relVol}x</i>}
          </div>
        )}
        {r.pmHigh != null && (
          <div>
            <span className="rt-k">PM High</span>
            <b>${fmt(r.pmHigh)}</b>
          </div>
        )}
        {r.low != null && (
          <div>
            <span className="rt-k">Low</span>
            <b>${fmt(r.low)}</b>
          </div>
        )}
      </div>

      {r.news && r.news.length > 0 && (
        <>
          <div className="rt-lbl">Headlines</div>
          <ul className="rt-headlines">
            {r.news.map((h, i) => (
              <li key={i}>
                <a href={headlineHref(r.sym, h)} target="_blank" rel="noopener noreferrer">
                  {h}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      <BehaviorEditor r={r} />

      {!hasTile && !r.close && (
        <div className="rt-empty">
          No evening-recap detail on file for this runner. Re-import this day from <code>recap_YYYY-MM-DD.md</code> produced by <code>evening_recap.py</code> to see the full tile.
        </div>
      )}
    </div>
  );
}

Object.assign(window, { RunnersBlock, AdvancedRunnerCard, AdvancedRunnersTable, RunnerTile });