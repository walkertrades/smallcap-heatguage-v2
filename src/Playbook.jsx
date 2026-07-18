// Playbook — a visual library of plays. Tiles carry the runner's key numbers
// plus a user-uploaded chart screenshot (shared with the Top Movers detail).
// Folders are saved filters; users can add their own.
//
// Identifiers prefixed `pb`/`PB` to stay unique in the shared global scope.

const { useState: useState_Pb, useMemo: useMemo_Pb } = React;

const PB_FOLDER_KEY = "hg2:playbookFolders";

// Built-in folders. `rules` are ANDed; each rule is {field, op, value}.
const PB_DEFAULT_FOLDERS = [
  { id: "all",       name: "All Plays",        builtin: true, rules: [] },
  { id: "nanocn",    name: "Nano Float China", builtin: true, rules: [{ field: "floatTier", op: "is", value: "Nano" }, { field: "country", op: "in", value: ["CN", "HK"] }] },
  { id: "newsdriven",name: "News Driven",      builtin: true, rules: [{ field: "tag", op: "contains-any", value: ["NEWS", "FDA", "EARNINGS", "PHASE", "CONTRACT", "ACQUISITION", "MERGER"] }] },
  { id: "sessionhod",name: "Session HODs",     builtin: true, rules: [{ field: "session", op: "in", value: ["morning", "afternoon"] }] },
];

// Fields offered by the "new folder" builder.
const PB_FIELDS = [
  { key: "country",   label: "Country",    of: (r) => r.country },
  { key: "floatTier", label: "Float Tier", of: (r) => r.floatTier },
  { key: "sectorNorm",label: "Sector",     of: (r) => r.sectorNorm },
  { key: "session",   label: "Session",    of: (r) => r.session },
  { key: "tag",       label: "Catalyst",   of: (r) => r.tag },
];

function pbLoadFolders() {
  try {
    const raw = window.localStorage.getItem(PB_FOLDER_KEY);
    const custom = raw ? JSON.parse(raw) : [];
    return PB_DEFAULT_FOLDERS.concat(Array.isArray(custom) ? custom : []);
  } catch (_) { return PB_DEFAULT_FOLDERS.slice(); }
}
function pbSaveCustom(customs) {
  try { window.localStorage.setItem(PB_FOLDER_KEY, JSON.stringify(customs)); } catch (_) {}
}
function pbCustomOnly(folders) { return folders.filter((f) => !f.builtin); }

function pbFieldOf(r, field) {
  const f = PB_FIELDS.find((x) => x.key === field);
  return f ? f.of(r) : r[field];
}
function pbMatches(r, folder) {
  if (!folder || !folder.rules || !folder.rules.length) return true;
  return folder.rules.every((rule) => {
    const v = pbFieldOf(r, rule.field);
    if (v == null) return false;
    if (rule.op === "is") return String(v) === String(rule.value);
    if (rule.op === "in") return rule.value.indexOf(String(v)) >= 0;
    if (rule.op === "contains-any") {
      const s = String(v).toUpperCase();
      return rule.value.some((needle) => s.indexOf(needle) >= 0);
    }
    return true;
  });
}

const PB_GRADES = ["All", "A++", "A+", "A", "B", "C", "D", "F", "Ungraded"];

function pbFmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return `${m}/${d}/${String(y).slice(2)}`;
}

// ── One play tile ──────────────────────────────────────────────────
function PlayTile({ r, onOpen }) {
  const grade = window.getGrade(r._date, r.sym);
  const hod = r.hodExact != null ? Math.round(r.hodExact) : (r.hod || 0);
  return (
    <div className="play-tile">
      <div className="play-head" onClick={() => onOpen(r)} role="button">
        <div className="play-id">
          <span className="play-sym">{r.sym}</span>
          <span className="play-date">{pbFmtDate(r._date)}</span>
        </div>
        <span className={`grade-badge ${grade ? "graded" : "ungraded"} ${grade === "A++" ? "grade-gold" : ""}`}
          style={{ "--gc": window.gradeColor(grade) }}>{grade || "—"}</span>
      </div>

      <div className="play-stats" onClick={() => onOpen(r)}>
        <span className="play-hod">+{hod}%</span>
        <span className={`play-fade ${r.fade > 40 ? "neg" : r.fade < 20 ? "pos" : "fadewarn"}`}>{r.fade}% fade</span>
        {r.tag && <span className="cat-badge" style={{ "--cat": window.catalystColor(r.tag) }}>{String(r.tag).toUpperCase()}</span>}
      </div>

      <div className="play-chart">
        <window.ShotZone date={r._date} sym={r.sym} compact />
      </div>

      <button className="play-expand" onClick={() => onOpen(r)}>View detail →</button>
    </div>
  );
}

// ── New-folder builder ─────────────────────────────────────────────
function NewFolderForm({ options, onCreate, onCancel }) {
  const [name, setName] = useState_Pb("");
  const [field, setField] = useState_Pb("country");
  const [value, setValue] = useState_Pb("");
  const vals = options[field] || [];

  const create = () => {
    if (!name.trim() || !value) return;
    onCreate({
      id: "c" + Date.now(),
      name: name.trim(),
      rules: [{ field, op: "is", value }],
    });
  };
  return (
    <div className="pb-newfolder">
      <input className="pb-nf-name" placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="pb-nf-rule">
        <select value={field} onChange={(e) => { setField(e.target.value); setValue(""); }}>
          {PB_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <span className="pb-nf-eq">=</span>
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">choose…</option>
          {vals.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="pb-nf-actions">
        <button className="pb-nf-save" onClick={create} disabled={!name.trim() || !value}>Create</button>
        <button className="pb-nf-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Playbook page ──────────────────────────────────────────────────
function PlaybookPage({ entries, folderId, folders, onOpenNewFolder, newFolderOpen, onCreateFolder, onCancelFolder }) {
  const [grade, setGrade] = useState_Pb("All");
  const [openRunner, setOpenRunner] = useState_Pb(null);
  const [page, setPage] = useState_Pb(1);
  const PER_PAGE = 24;

  const folder = folders.find((f) => f.id === folderId) || folders[0];

  const allRunners = useMemo_Pb(() => {
    const out = [];
    for (const e of entries) for (const r of (e.runners || [])) out.push(r);
    out.sort((a, b) => (a._date < b._date ? 1 : a._date > b._date ? -1 : (b.hod || 0) - (a.hod || 0)));
    return out;
  }, [entries]);

  const options = useMemo_Pb(() => {
    const o = {};
    for (const f of PB_FIELDS) {
      const s = new Set();
      for (const r of allRunners) { const v = f.of(r); if (v) s.add(String(v)); }
      o[f.key] = Array.from(s).sort();
    }
    return o;
  }, [allRunners]);

  const tiles = useMemo_Pb(() => {
    return allRunners.filter((r) => {
      if (!pbMatches(r, folder)) return false;
      if (grade !== "All") {
        const g = window.getGrade(r._date, r.sym);
        if (grade === "Ungraded") { if (g) return false; }
        else if (g !== grade) return false;
      }
      return true;
    });
  }, [allRunners, folder, grade]);

  React.useEffect(() => { setPage(1); }, [folderId, grade]);

  const pageCount = Math.max(1, Math.ceil(tiles.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const shown = tiles.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  return (
    <div className="playbook">
      <div className="pb-bar">
        <div className="pb-title">
          <span className="card-title">{folder ? folder.name : "All Plays"}</span>
          <span className="pb-count">{tiles.length} plays</span>
        </div>
        <div className="pb-grades">
          {PB_GRADES.map((g) => (
            <button key={g} className={`pb-grade ${grade === g ? "active" : ""}`}
              style={g !== "All" && g !== "Ungraded" ? { "--gc": window.gradeColor(g) } : null}
              onClick={() => setGrade(g)}>{g}</button>
          ))}
        </div>
      </div>

      {newFolderOpen && (
        <NewFolderForm options={options} onCreate={onCreateFolder} onCancel={onCancelFolder} />
      )}

      {shown.length === 0 ? (
        <div className="pb-empty">No plays match this folder{grade !== "All" ? ` at grade ${grade}` : ""}.</div>
      ) : (
        <div className="play-grid">
          {shown.map((r) => (
            <PlayTile key={`${r._date}::${r.sym}`} r={r} onOpen={setOpenRunner} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="pb-pager">
          <button className="pager-btn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Previous</button>
          <span className="pager-pos">Page {safePage} of {pageCount}</span>
          <button className="pager-btn" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next ›</button>
        </div>
      )}

      {openRunner && (
        <div className="pb-modal" onClick={() => setOpenRunner(null)}>
          <div className="pb-modal-inner" onClick={(e) => e.stopPropagation()}>
            <button className="pb-modal-close" onClick={() => setOpenRunner(null)}>×</button>
            <window.RunnerTile r={openRunner} />
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  PlaybookPage, pbLoadFolders, pbSaveCustom, pbCustomOnly, pbMatches,
  PB_DEFAULT_FOLDERS, PB_FIELDS, PB_GRADES,
});
