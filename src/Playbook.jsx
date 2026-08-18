// Playbook — a visual library of plays. Tiles carry the runner's key numbers
// plus a user-uploaded chart screenshot (shared with the Top Movers detail).
//
// Folders are saved filters. A folder now holds a full `criteria` object (every
// dimension the dashboard knows about) rather than the old one-rule-at-a-time
// `rules` array; legacy `rules` folders still match so nothing saved earlier
// breaks. Runners can also be PINNED into a folder by hand from anywhere in the
// app — pinned plays show up alongside the auto-matched ones.
//
// Identifiers prefixed `pb`/`PB` to stay unique in the shared global scope.

const { useState: useState_Pb, useMemo: useMemo_Pb, useEffect: useEffect_Pb, useRef: useRef_Pb } = React;

const PB_FOLDER_KEY = "hg2:playbookFolders";
const PB_PIN_KEY = "hg2:playbookPins";

// ── Criteria vocabulary ────────────────────────────────────────────
const PB_TIERS = ["Nano", "Micro", "Low", "Mid", "Thick", "Mega Thick"];
const PB_SESSIONS = ["premarket", "morning", "afternoon", "after-hours"];
// Claude's setupGrade scale (see evening_recap_json_only.py SETUP_GRADES).
const PB_AI_GRADES = ["A++", "A", "B+", "B", "C+", "C", "F"];
const PB_PRICE_RANGES = [
  { key: "u1",   label: "Under $1", test: (p) => p != null && p < 1 },
  { key: "1_10", label: "$1–$10",   test: (p) => p != null && p >= 1 && p < 10 },
  { key: "10p",  label: "$10+",     test: (p) => p != null && p >= 10 },
];
// The price labels already carry their numbers, but not their inclusivity —
// "$1–$10" doesn't say which end is open. Spelled out from the same bounds the
// test functions above use.
const PB_PRICE_HINTS = {
  "u1":   "open < $1.00",
  "1_10": "open ≥ $1.00 and < $10.00",
  "10p":  "open ≥ $10.00",
};
function pbPriceRangeHint(key) { return PB_PRICE_HINTS[key] || ""; }

const PB_SSR_MODES = [
  { key: "any",  label: "Any" },
  { key: "only", label: "SSR only" },
  { key: "no",   label: "No SSR" },
];

function pbEmptyCriteria() {
  return {
    floatTiers: [], countries: [], sectors: [], tags: [], sessions: [],
    grades: [], aiGrades: [], priceRanges: [], themes: [],
    minHod: null, maxFade: null,
    ssr: "any", dateFrom: "", dateTo: "",
  };
}
// Merge a stored (possibly partial / legacy) criteria blob onto the full shape.
function pbFullCriteria(c) { return Object.assign(pbEmptyCriteria(), c || {}); }

// Built-in folders. Criteria are pre-filled so they open in the editor ready to
// tweak, exactly like a user-made folder.
// "all" is RESERVED. It is the unfiltered catch-all view, the fallback in
// PlaybookPage, and the entry pbSortFolders pins to the top. It must never be
// renamed or given criteria.
//
// It was possible to destroy it: the folder editor saves with `folder.id`, so
// selecting All Plays -> Edit -> rename wrote straight over the builtin. The
// result looked harmless but there was then NO catch-all folder, and the sort
// pinned whatever now held the id. Guarded in pbUpdateFolder below, and the
// Edit control is hidden for it.
const PB_RESERVED_ID = "all";

const PB_DEFAULT_FOLDERS = [
  { id: "all", name: "All Plays", builtin: true, criteria: pbEmptyCriteria() },
  {
    id: "nanocn", name: "Nano Float China", builtin: true,
    criteria: Object.assign(pbEmptyCriteria(), { floatTiers: ["Nano"], countries: ["CN", "HK"] }),
  },
  {
    id: "newsdriven", name: "News Driven", builtin: true,
    // Spans both tag vocabularies: the v2 catalysts Claude emits and the legacy
    // v1 tags that most of data2.json still carries.
    criteria: Object.assign(pbEmptyCriteria(), {
      tags: ["NEWS-DRIVEN", "FUNDAMENTAL", "EARNINGS", "FDA", "PHASE-1", "PHASE-2",
             "PHASE-3", "CONTRACT", "ACQUISITION", "MERGER", "COMPLIANCE"],
    }),
  },
  {
    id: "sessionhod", name: "Session HODs", builtin: true,
    criteria: Object.assign(pbEmptyCriteria(), { sessions: ["morning", "afternoon"] }),
  },
];

// ── Folder store (localStorage + subscribers) ──────────────────────
// A single source of truth so the sidebar, the Playbook page and every
// "Add to Playbook" popover all see the same folders without prop drilling.
const pbFolderSubs = new Set();
let pbFolderCache = null;

function pbReadSaved() {
  try {
    const raw = window.localStorage.getItem(PB_FOLDER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
// "All Plays" is the default view, not a peer folder, so it is pinned to the
// top permanently. Everything below it sorts alphabetically, case-insensitively
// — built-ins and user folders in one list, no manual ordering. Applied on load
// and again on every mutation so a create or rename lands in the right slot
// immediately.
function pbSortFolders(list) {
  return list.slice().sort((a, b) => {
    const aAll = a && a.id === "all", bAll = b && b.id === "all";
    if (aAll !== bAll) return aAll ? -1 : 1;
    return String(a && a.name || "").localeCompare(String(b && b.name || ""), undefined,
      { sensitivity: "base", numeric: true });
  });
}
function pbLoadFolders() {
  const saved = pbReadSaved();
  const byId = {};
  for (const f of saved) if (f && f.id) byId[f.id] = f;
  // built-ins keep their identity but adopt any saved edits
  const builtins = PB_DEFAULT_FOLDERS.map((d) =>
    byId[d.id] ? Object.assign({}, d, byId[d.id], { builtin: true }) : d);
  const builtinIds = PB_DEFAULT_FOLDERS.map((d) => d.id);
  const customs = saved.filter((f) => f && f.id && builtinIds.indexOf(f.id) < 0)
    .map((f) => Object.assign({}, f, { builtin: false }));
  return pbSortFolders(builtins.concat(customs));
}
function pbAllFolders() {
  if (!pbFolderCache) pbFolderCache = pbLoadFolders();
  return pbFolderCache;
}
// Persist everything except built-ins still identical to their defaults, so a
// future change to PB_DEFAULT_FOLDERS still reaches users who never edited them.
function pbPersist(folders) {
  const out = folders.filter((f) => {
    if (!f.builtin) return true;
    const def = PB_DEFAULT_FOLDERS.find((d) => d.id === f.id);
    return !def || JSON.stringify(def) !== JSON.stringify(f);
  });
  try { window.localStorage.setItem(PB_FOLDER_KEY, JSON.stringify(out)); } catch (_) {}
}
function pbSetFolders(next) {
  const sorted = pbSortFolders(next);
  pbFolderCache = sorted;
  pbPersist(sorted);
  pbFolderSubs.forEach((fn) => fn(sorted));
}
function pbAddFolder(f) {
  // A create can't normally reach "all" (pbNewFolderId emits "c..." ids), but
  // never let one through.
  if (f && f.id === PB_RESERVED_ID) f = Object.assign({}, f, { id: pbNewFolderId() });
  const next = pbAllFolders().concat([Object.assign({ builtin: false }, f)]);
  pbSetFolders(next);
  return f;
}
function pbUpdateFolder(id, patch) {
  // Defence in depth: even if a future UI path forgets, the reserved folder's
  // name and criteria are not writable.
  if (id === PB_RESERVED_ID) {
    const safe = Object.assign({}, patch);
    delete safe.name; delete safe.criteria; delete safe.rules;
    if (!Object.keys(safe).length) {
      console.warn('[playbook] "All Plays" is the unfiltered fallback view - it cannot be '
        + 'renamed or filtered. Create a new folder instead.');
      return false;
    }
    patch = safe;
  }
  const next = pbAllFolders().map((f) => (f.id === id ? Object.assign({}, f, patch) : f));
  pbSetFolders(next);
  return true;
}
function pbDeleteFolder(id) {
  pbSetFolders(pbAllFolders().filter((f) => f.id !== id));
  pbUnpinFolder(id);
}
function pbUseFolders() {
  const [folders, setLocal] = useState_Pb(pbAllFolders);
  useEffect_Pb(() => {
    const fn = (next) => setLocal(next);
    pbFolderSubs.add(fn);
    setLocal(pbAllFolders());
    return () => { pbFolderSubs.delete(fn); };
  }, []);
  return folders;
}
function pbNewFolderId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Pin store (manual "add to playbook") ───────────────────────────
// { "2026-07-24::ABCD": ["folderId", ...] } — keyed by date + ticker.
const pbPinSubs = new Set();
let pbPinCache = null;

function pbPinKey(date, sym) { return `${date}::${sym}`; }
function pbLoadPins() {
  try {
    const raw = window.localStorage.getItem(PB_PIN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) { return {}; }
}
function pbAllPins() {
  if (!pbPinCache) pbPinCache = pbLoadPins();
  return pbPinCache;
}
function pbSetPins(next) {
  pbPinCache = next;
  try { window.localStorage.setItem(PB_PIN_KEY, JSON.stringify(next)); } catch (_) {}
  pbPinSubs.forEach((fn) => fn(next));
}
function pbPinsFor(date, sym) { return pbAllPins()[pbPinKey(date, sym)] || []; }
function pbTogglePin(date, sym, folderId) {
  const k = pbPinKey(date, sym);
  const cur = pbAllPins()[k] || [];
  const has = cur.indexOf(folderId) >= 0;
  const list = has ? cur.filter((x) => x !== folderId) : cur.concat([folderId]);
  const next = Object.assign({}, pbAllPins());
  if (list.length) next[k] = list; else delete next[k];
  pbSetPins(next);
  return !has;
}
// Drop a deleted folder out of every pin list so it can't strand runners.
function pbUnpinFolder(folderId) {
  const cur = pbAllPins();
  const next = {};
  let changed = false;
  for (const k of Object.keys(cur)) {
    const list = (cur[k] || []).filter((x) => x !== folderId);
    if (list.length !== (cur[k] || []).length) changed = true;
    if (list.length) next[k] = list;
  }
  if (changed) pbSetPins(next);
}
function pbUsePins() {
  const [pins, setLocal] = useState_Pb(pbAllPins);
  useEffect_Pb(() => {
    const fn = (next) => setLocal(next);
    pbPinSubs.add(fn);
    setLocal(pbAllPins());
    return () => { pbPinSubs.delete(fn); };
  }, []);
  return pins;
}

// ── Option source ──────────────────────────────────────────────────
// The folder editor is reachable from places that don't hold `entries` (the
// Add-to-Playbook popover in Top Movers), so App registers the loaded data once
// and the editor reads its dropdown options from here.
let pbEntriesRef = null;
let pbOptCache = null;
function pbRegisterEntries(entries) {
  if (entries !== pbEntriesRef) { pbEntriesRef = entries; pbOptCache = null; }
}
function pbOptions() {
  if (pbOptCache) return pbOptCache;
  const countries = new Set(), sectors = new Set(), tags = new Set();
  for (const e of (pbEntriesRef || [])) {
    for (const r of (e.runners || [])) {
      if (r.country) countries.add(String(r.country));
      if (r.sectorNorm) sectors.add(String(r.sectorNorm));
      if (r.tag) tags.add(String(r.tag).toUpperCase());
    }
  }
  // Always offer the full v2 catalyst vocabulary even when the loaded data
  // hasn't produced those tags yet, then append whatever legacy tags exist.
  const v2 = (window.V2_CATALYST_TAGS || []).slice();
  const legacy = Array.from(tags).filter((t) => v2.indexOf(t) < 0).sort();
  pbOptCache = {
    countries: Array.from(countries).sort(),
    sectors: Array.from(sectors).sort(),
    tags: v2.concat(legacy),
  };
  return pbOptCache;
}

// ── Matching ───────────────────────────────────────────────────────
// r.tag is already the EFFECTIVE catalyst — App.jsx layers manual overrides
// over the pipeline value before anything downstream sees a runner — so folder
// criteria automatically match what's displayed on the tile.
function pbEffTag(r) {
  return r.tag ? String(r.tag).toUpperCase() : null;
}
function pbPrice(r) {
  if (r.open != null && Number.isFinite(Number(r.open))) return Number(r.open);
  if (r.close != null && Number.isFinite(Number(r.close))) return Number(r.close);
  return null;
}
function pbHodVal(r) { return r.hodExact != null ? Number(r.hodExact) : (r.hod != null ? Number(r.hod) : null); }
function pbFadeVal(r) { return r.fadeExact != null ? Number(r.fadeExact) : (r.fade != null ? Number(r.fade) : null); }
// An empty selection means "no constraint on this dimension".
function pbIn(arr, v) { return !arr || arr.length === 0 || (v != null && arr.indexOf(v) >= 0); }

function pbMatchesCriteria(r, raw) {
  const c = pbFullCriteria(raw);
  if (!pbIn(c.floatTiers, r.floatTier)) return false;
  if (!pbIn(c.countries, r.country)) return false;
  if (!pbIn(c.sectors, r.sectorNorm)) return false;
  if (!pbIn(c.sessions, r.session)) return false;
  if (c.tags.length && !pbIn(c.tags, pbEffTag(r))) return false;
  // Theme is independent of catalyst and multi-valued: match if the runner
  // carries ANY selected theme. Runners predating theme tagging simply have no
  // themes and therefore never match — surfaced in the editor's hint.
  if ((c.themes || []).length) {
    const rt = (Array.isArray(r.themes) ? r.themes : [])
      .map((t) => (typeof t === "string" ? t : t && t.theme)).filter(Boolean);
    if (!rt.some((t) => c.themes.indexOf(t) >= 0)) return false;
  }
  if (c.grades.length) {
    const g = window.getGrade(r._date, r.sym) || "Ungraded";
    if (c.grades.indexOf(g) < 0) return false;
  }
  if (c.aiGrades.length) {
    const g = r.setupGrade || "Ungraded";
    if (c.aiGrades.indexOf(g) < 0) return false;
  }
  if (c.minHod != null) { const h = pbHodVal(r); if (h == null || h < c.minHod) return false; }
  if (c.maxFade != null) { const f = pbFadeVal(r); if (f == null || f > c.maxFade) return false; }
  if (c.priceRanges.length) {
    const p = pbPrice(r);
    const ok = c.priceRanges.some((k) => {
      const pr = PB_PRICE_RANGES.find((x) => x.key === k);
      return pr && pr.test(p);
    });
    if (!ok) return false;
  }
  if (c.ssr === "only" && !r.ssr) return false;
  if (c.ssr === "no" && r.ssr) return false;
  if (c.dateFrom && String(r._date || "") < c.dateFrom) return false;
  if (c.dateTo && String(r._date || "") > c.dateTo) return false;
  return true;
}

// Legacy folders saved before the criteria builder existed.
const PB_FIELDS = [
  { key: "country",   label: "Country",    of: (r) => r.country },
  { key: "floatTier", label: "Float Tier", of: (r) => r.floatTier },
  { key: "sectorNorm",label: "Sector",     of: (r) => r.sectorNorm },
  { key: "session",   label: "Session",    of: (r) => r.session },
  { key: "tag",       label: "Catalyst",   of: (r) => r.tag },
];
function pbFieldOf(r, field) {
  const f = PB_FIELDS.find((x) => x.key === field);
  return f ? f.of(r) : r[field];
}
function pbMatchesRules(r, rules) {
  return rules.every((rule) => {
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
function pbMatches(r, folder) {
  if (!folder) return true;
  if (folder.criteria) return pbMatchesCriteria(r, folder.criteria);
  if (folder.rules && folder.rules.length) return pbMatchesRules(r, folder.rules);
  return true;
}
function pbCriteriaCount(raw) {
  const c = pbFullCriteria(raw);
  let n = 0;
  for (const k of ["floatTiers", "countries", "sectors", "tags", "sessions", "grades", "aiGrades", "priceRanges", "themes"]) {
    if (c[k].length) n++;
  }
  if (c.minHod != null) n++;
  if (c.maxFade != null) n++;
  if (c.ssr !== "any") n++;
  if (c.dateFrom || c.dateTo) n++;
  return n;
}

// ── Tile sorting ───────────────────────────────────────────────────
// Both grade sorts rank best-first and drop ungraded runners to the bottom.
function pbMyGradeRank(r) { return window.gradeRank(window.getGrade(r._date, r.sym)); } // -1 when ungraded
function pbAiGradeRank(r) {
  const i = PB_AI_GRADES.indexOf(r.setupGrade); // 0 = A++ … 6 = F
  return i < 0 ? -1 : PB_AI_GRADES.length - i;  // higher = better, ungraded last
}
// `dir` is the FIRST-click direction; clicking the active option again flips it.
// -1 sorts high→low, which for the grade ranks means A++ first.
const PB_SORTS = [
  { key: "hod",     label: "HOD %",    dir: -1, get: (r) => (r.hodExact != null ? r.hodExact : (r.hod || 0)) },
  { key: "fade",    label: "Fade %",   dir: -1, get: (r) => (r.fadeExact != null ? r.fadeExact : (r.fade != null ? r.fade : -1)) },
  { key: "mygrade", label: "My Grade", dir: -1, get: pbMyGradeRank },
  { key: "aigrade", label: "AI Grade", dir: -1, get: pbAiGradeRank },
  { key: "date",    label: "Date",     dir: -1, text: true, get: (r) => r._date || "" },
  { key: "vol",     label: "$ Volume", dir: -1, get: (r) => (r.volDollar != null ? r.volDollar : -1) },
];
function pbSortDef(key) { return PB_SORTS.find((s) => s.key === key) || PB_SORTS[0]; }

function pbFmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return `${m}/${d}/${String(y).slice(2)}`;
}
function pbSessionLabel(s) { return window.sessionLabel ? window.sessionLabel(s) : s; }

// ── Editor building blocks ─────────────────────────────────────────
// `titleOf` surfaces the numeric range behind a tiered option — hovering "Nano"
// says "< 1M float". The text comes from the threshold definitions themselves
// (v2schema FLOAT_TIERS / SESSION_BOUNDS), never a restatement of them.
function PbChips({ options, selected, onToggle, colorOf, labelOf, titleOf }) {
  const sel = selected || [];
  return (
    <div className="pbe-chips">
      {options.map((o) => {
        const on = sel.indexOf(o) >= 0;
        const c = colorOf ? colorOf(o) : null;
        const t = titleOf ? titleOf(o) : null;
        return (
          <button key={o} type="button"
            className={`pbe-chip ${on ? "on" : ""} ${t ? "has-range" : ""}`}
            style={c ? { "--oc": c } : null} title={t || null} onClick={() => onToggle(o)}>
            {labelOf ? labelOf(o) : o}
          </button>
        );
      })}
    </div>
  );
}

// Searchable multi-select for the long lists (country, sector).
function PbSearchSelect({ options, selected, onToggle, placeholder, colorOf }) {
  const [q, setQ] = useState_Pb("");
  const sel = selected || [];
  const query = q.trim().toLowerCase();
  const matches = query
    ? options.filter((o) => String(o).toLowerCase().includes(query) && sel.indexOf(o) < 0).slice(0, 12)
    : [];
  return (
    <div className="pbe-search">
      {sel.length > 0 && (
        <div className="pbe-chips">
          {sel.map((v) => (
            <button key={v} type="button" className="pbe-chip on"
              style={colorOf ? { "--oc": colorOf(v) } : null} onClick={() => onToggle(v)}>
              {v} <span className="pbe-chip-x">×</span>
            </button>
          ))}
        </div>
      )}
      <input className="pbe-input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && (
        <div className="pbe-results">
          {matches.map((v) => (
            <button key={v} type="button" className="pbe-chip"
              style={colorOf ? { "--oc": colorOf(v) } : null}
              onClick={() => { onToggle(v); setQ(""); }}>{v}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function PbRow({ label, hint, children }) {
  return (
    <div className="pbe-row">
      <div className="pbe-row-lbl">{label}{hint && <span className="pbe-row-hint">{hint}</span>}</div>
      <div className="pbe-row-body">{children}</div>
    </div>
  );
}

// ── Folder editor ──────────────────────────────────────────────────
// `folder` null = create mode. Used both on the Playbook page and inline in the
// Add-to-Playbook popover.
function FolderEditor({ folder, onSave, onCancel }) {
  const opts = pbOptions();
  const [name, setName] = useState_Pb(() => (folder ? folder.name : ""));
  const [c, setC] = useState_Pb(() => pbFullCriteria(folder ? folder.criteria : null));

  const set = (key, value) => setC((prev) => Object.assign({}, prev, { [key]: value }));
  const toggleIn = (key, value) => setC((prev) => {
    const cur = prev[key] || [];
    const next = cur.indexOf(value) >= 0 ? cur.filter((x) => x !== value) : cur.concat([value]);
    return Object.assign({}, prev, { [key]: next });
  });
  const num = (key) => (e) => {
    const v = e.target.value.trim();
    set(key, v === "" ? null : Number(v));
  };

  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSave({ id: folder ? folder.id : pbNewFolderId(), name: n, criteria: c, rules: undefined });
  };

  const count = pbCriteriaCount(c);
  return (
    <div className="pb-editor">
      <div className="pbe-head">
        <input className="pbe-name" placeholder="Folder name" value={name}
          onChange={(e) => setName(e.target.value)} autoFocus />
        <span className="pbe-count">{count} {count === 1 ? "criterion" : "criteria"}</span>
      </div>

      <div className="pbe-grid">
        <PbRow label="FLOAT TIER">
          <PbChips options={PB_TIERS} selected={c.floatTiers} onToggle={(v) => toggleIn("floatTiers", v)}
            colorOf={window.floatTierColor} titleOf={window.floatTierRange} />
        </PbRow>

        <PbRow label="SESSION">
          <PbChips options={PB_SESSIONS} selected={c.sessions} onToggle={(v) => toggleIn("sessions", v)}
            labelOf={pbSessionLabel} titleOf={window.sessionRange} />
        </PbRow>

        <PbRow label="COUNTRY" hint={c.countries.length ? `${c.countries.length} selected` : null}>
          <PbSearchSelect options={opts.countries} selected={c.countries}
            onToggle={(v) => toggleIn("countries", v)} placeholder="Type a country code…"
            colorOf={window.countryColor} />
        </PbRow>

        <PbRow label="SECTOR" hint={c.sectors.length ? `${c.sectors.length} selected` : null}>
          <PbSearchSelect options={opts.sectors} selected={c.sectors}
            onToggle={(v) => toggleIn("sectors", v)} placeholder="Type a sector…"
            colorOf={window.sectorColor} />
        </PbRow>

        <PbRow label="CATALYST">
          <PbChips options={opts.tags} selected={c.tags} onToggle={(v) => toggleIn("tags", v)}
            colorOf={window.catalystColor} />
        </PbRow>

        <PbRow label="THEME" hint="separate from catalyst · only tagged from the pipeline switchover forward">
          <PbChips options={window.V2_THEMES || []} selected={c.themes}
            onToggle={(v) => toggleIn("themes", v)} colorOf={window.themeColor} />
        </PbRow>

        <PbRow label="MY GRADE">
          <PbChips options={window.GRADES.slice().reverse().concat(["Ungraded"])} selected={c.grades}
            onToggle={(v) => toggleIn("grades", v)}
            colorOf={(g) => (g === "Ungraded" ? null : window.gradeColor(g))} />
        </PbRow>

        <PbRow label="AI GRADE" hint="from Claude's setupGrade">
          <PbChips options={PB_AI_GRADES.concat(["Ungraded"])} selected={c.aiGrades}
            onToggle={(v) => toggleIn("aiGrades", v)}
            colorOf={(g) => (g === "Ungraded" ? null : window.gradeColor(String(g).replace(/\+$/, "")))} />
        </PbRow>

        <PbRow label="PRICE RANGE">
          <PbChips options={PB_PRICE_RANGES.map((p) => p.key)} selected={c.priceRanges}
            onToggle={(v) => toggleIn("priceRanges", v)}
            labelOf={(k) => (PB_PRICE_RANGES.find((p) => p.key === k) || {}).label}
            titleOf={pbPriceRangeHint} />
        </PbRow>

        <PbRow label="THRESHOLDS">
          <div className="pbe-nums">
            <label className="pbe-num">
              <span>HOD % ≥</span>
              <input type="number" inputMode="numeric" placeholder="any"
                value={c.minHod == null ? "" : c.minHod} onChange={num("minHod")} />
            </label>
            <label className="pbe-num">
              <span>FADE % ≤</span>
              <input type="number" inputMode="numeric" placeholder="any"
                value={c.maxFade == null ? "" : c.maxFade} onChange={num("maxFade")} />
            </label>
          </div>
        </PbRow>

        <PbRow label="SSR FLAG">
          <div className="pbe-chips">
            {PB_SSR_MODES.map((m) => (
              <button key={m.key} type="button" className={`pbe-chip ${c.ssr === m.key ? "on" : ""}`}
                onClick={() => set("ssr", m.key)}>{m.label}</button>
            ))}
          </div>
        </PbRow>

        <PbRow label="DATE RANGE" hint="optional">
          <div className="pbe-nums">
            <label className="pbe-num">
              <span>From</span>
              <input type="date" value={c.dateFrom || ""} onChange={(e) => set("dateFrom", e.target.value)} />
            </label>
            <label className="pbe-num">
              <span>To</span>
              <input type="date" value={c.dateTo || ""} onChange={(e) => set("dateTo", e.target.value)} />
            </label>
          </div>
        </PbRow>
      </div>

      <div className="pbe-actions">
        <button type="button" className="pbe-reset" onClick={() => setC(pbEmptyCriteria())}>Clear criteria</button>
        <div className="pbe-actions-right">
          <button type="button" className="pb-nf-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="pb-nf-save" onClick={save} disabled={!name.trim()}>Save Folder</button>
        </div>
      </div>
    </div>
  );
}

// ── Add to Playbook (button + popover) ─────────────────────────────
// Dropped into the Top Movers rows and the expanded runner detail. Reads the
// shared folder/pin stores directly so it works anywhere without prop drilling.
function AddToPlaybook({ r, compact }) {
  const folders = pbUseFolders();
  const pins = pbUsePins();
  const [open, setOpen] = useState_Pb(false);
  const [creating, setCreating] = useState_Pb(false);
  const [pos, setPos] = useState_Pb(null);
  const btnRef = useRef_Pb(null);
  const popRef = useRef_Pb(null);

  const key = pbPinKey(r._date, r.sym);
  const mine = pins[key] || [];

  useEffect_Pb(() => {
    if (!open) return;
    const onDown = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleOpen = (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const b = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
    if (b) {
      const W = 250;
      setPos({
        top: Math.min(b.bottom + 6, window.innerHeight - 280),
        left: Math.max(8, Math.min(b.left, window.innerWidth - W - 8)),
      });
    }
    setOpen(true);
  };

  const created = (f) => {
    pbAddFolder(f);
    pbTogglePin(r._date, r.sym, f.id); // drop the runner straight into the new folder
    setCreating(false);
  };

  return (
    <>
      <button ref={btnRef} type="button" title="Add to Playbook"
        className={`pb-addbtn ${mine.length ? "on" : ""} ${compact ? "compact" : ""}`}
        onClick={toggleOpen}>
        <span className="pb-addbtn-ic">{mine.length ? "★" : "☆"}</span>
        {!compact && <span className="pb-addbtn-txt">Playbook{mine.length ? ` · ${mine.length}` : ""}</span>}
      </button>

      {open && pos && !creating && (
        <div ref={popRef} className="pb-pop" style={{ top: pos.top + "px", left: pos.left + "px" }}
          onClick={(e) => e.stopPropagation()}>
          <div className="pb-pop-head">
            <span className="pb-pop-title">ADD {r.sym} TO</span>
            <button type="button" className="pb-pop-close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="pb-pop-list">
            {folders.map((f) => {
              const on = mine.indexOf(f.id) >= 0;
              return (
                <button key={f.id} type="button" className={`pb-pop-item ${on ? "on" : ""}`}
                  onClick={() => pbTogglePin(r._date, r.sym, f.id)}>
                  <span className={`pb-pop-box ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>
                  <span className="pb-pop-name">{f.name}</span>
                </button>
              );
            })}
          </div>
          <button type="button" className="pb-pop-new" onClick={() => setCreating(true)}>+ Create New Folder</button>
        </div>
      )}

      {creating && (
        <window.HgOverlay onClose={() => setCreating(false)} className="hgo-dim hgo-scroll">
          <div className="pb-modal-inner pb-modal-editor">
            <div className="card">
              <div className="card-title">NEW PLAYBOOK FOLDER</div>
              <p className="pbe-note">{r.sym} · {pbFmtDate(r._date)} will be added to this folder once saved.</p>
              <FolderEditor folder={null} onSave={created} onCancel={() => setCreating(false)} />
            </div>
          </div>
        </window.HgOverlay>
      )}
    </>
  );
}

// ── One play tile ──────────────────────────────────────────────────
function PlayTile({ r, pinned, onOpen }) {
  const hod = r.hodExact != null ? Math.round(r.hodExact) : (r.hod || 0);
  return (
    <div className={`play-tile ${pinned ? "pinned" : ""}`}>
      <div className="play-head" onClick={() => onOpen(r)} role="button">
        <div className="play-id">
          <span className="play-sym">
            {r.sym}
            {pinned && <span className="play-pin" title="Manually added to this folder">📌 PINNED</span>}
          </span>
          <span className="play-date">{pbFmtDate(r._date)}</span>
        </div>
        <div className="play-grades">
          {r.setupGrade && (
            <span className="grade-badge grade-badge-ai"
              style={{ "--gc": window.gradeColor(String(r.setupGrade).replace(/\+$/, "")) }}
              title="Claude's setup grade">{r.setupGrade}</span>
          )}
          <window.GrGradeBadge date={r._date} sym={r.sym} showEmpty />
        </div>
      </div>

      <div className="play-stats" onClick={() => onOpen(r)}>
        <span className="play-hod">+{hod}%</span>
        <span className={`play-fade ${r.fade > 40 ? "neg" : r.fade < 20 ? "pos" : "fadewarn"}`}>{r.fade}% fade</span>
        {r.tag && (
          <span className="cat-badge" style={{ "--cat": window.catalystColor(r.tag) }}>
            {String(r.tag).toUpperCase()}
            {r._manual && r._manual.catalyst && <span className="rt-chip-man" title="Set manually">✎</span>}
          </span>
        )}
      </div>

      <div className="play-chart">
        <window.ShotZone date={r._date} sym={r.sym} compact />
      </div>

      <div className="play-foot">
        <button className="play-expand" onClick={() => onOpen(r)}>View detail →</button>
        <AddToPlaybook r={r} compact />
      </div>
    </div>
  );
}

// ── Playbook page ──────────────────────────────────────────────────
function PlaybookPage({ entries, folderId, folders, onOpenNewFolder, newFolderOpen, onCreateFolder, onCancelFolder }) {
  // { key, dir } — clicking the active option flips dir; a different option
  // resets to that option's first-click direction.
  const [sort, setSort] = useState_Pb(() => ({ key: "hod", dir: pbSortDef("hod").dir }));
  const pickSort = (key) => setSort((prev) => (
    prev.key === key ? { key, dir: -prev.dir } : { key, dir: pbSortDef(key).dir }
  ));
  const [openRunner, setOpenRunner] = useState_Pb(null);
  const [editing, setEditing] = useState_Pb(false);
  const [page, setPage] = useState_Pb(1);
  const pins = pbUsePins();
  // Folder criteria can FILTER on grade and the tile list can SORT by it, both
  // across every runner rather than the visible page — so a grade write by
  // anyone has to re-run the match and the sort below.
  const grVer = window.grUseVersion ? window.grUseVersion() : 0;
  const PER_PAGE = 24;

  // Fall back to "All Plays" by id, not by position — the list is sorted by
  // name, so folders[0] is whatever happens to sort first.
  const folder = folders.find((f) => f.id === folderId)
    || folders.find((f) => f.id === "all") || folders[0];

  const allRunners = useMemo_Pb(() => {
    const out = [];
    for (const e of entries) for (const r of (e.runners || [])) out.push(r);
    out.sort((a, b) => (a._date < b._date ? 1 : a._date > b._date ? -1 : (b.hod || 0) - (a.hod || 0)));
    return out;
  }, [entries]);

  const matched = useMemo_Pb(() => {
    const out = [];
    const fid = folder ? folder.id : null;
    for (const r of allRunners) {
      const pinned = fid ? (pins[pbPinKey(r._date, r.sym)] || []).indexOf(fid) >= 0 : false;
      // a pinned runner belongs to the folder even if it fails the criteria
      if (!pinned && !pbMatches(r, folder)) continue;
      out.push({ r, pinned });
    }
    return out;
  }, [allRunners, folder, pins, grVer]);

  // allRunners is already date-desc / HOD-desc and Array#sort is stable, so ties
  // (every runner on the grade sorts today) keep that ordering underneath.
  const tiles = useMemo_Pb(() => {
    const s = pbSortDef(sort.key);
    return matched.slice().sort((a, b) => {
      const av = s.get(a.r), bv = s.get(b.r);
      if (s.text) return String(av).localeCompare(String(bv)) * sort.dir;
      return (av - bv) * sort.dir;
    });
  }, [matched, sort, grVer]);

  React.useEffect(() => { setPage(1); }, [folderId, sort]);
  React.useEffect(() => { setEditing(false); }, [folderId]);

  const pageCount = Math.max(1, Math.ceil(tiles.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const shown = tiles.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const pinnedCount = tiles.filter((t) => t.pinned).length;
  const critCount = folder ? pbCriteriaCount(folder.criteria) : 0;

  const saveEdit = (f) => { pbUpdateFolder(f.id, { name: f.name, criteria: f.criteria, rules: undefined }); setEditing(false); };

  return (
    <div className="playbook">
      <div className="pb-bar">
        <div className="pb-title">
          <span className="card-title">{folder ? folder.name : "All Plays"}</span>
          <span className="pb-count">
            {tiles.length} plays
            {pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ""}
            {critCount > 0 ? ` · ${critCount} criteria` : ""}
          </span>
          {/* All Plays is the unfiltered catch-all and the pinned default —
              editing it used to overwrite the builtin in place and leave a
              normal folder squatting on the reserved id. Offer a new folder
              instead of an edit. */}
          {folder && !editing && !newFolderOpen && folder.id !== PB_RESERVED_ID && (
            <button className="pb-edit" onClick={() => setEditing(true)}>Edit filters</button>
          )}
          {folder && !editing && !newFolderOpen && folder.id === PB_RESERVED_ID && (
            <button className="pb-edit" title="All Plays shows every runner and can't be filtered"
              onClick={onOpenNewFolder}>+ New folder</button>
          )}
        </div>
      </div>

      <div className="pb-sortbar">
        <span className="pb-sortlbl">SORT BY</span>
        <div className="pb-sorts">
          {PB_SORTS.map((s) => {
            const on = sort.key === s.key;
            const asc = on && sort.dir === 1;
            return (
              <button key={s.key} className={`pb-sort ${on ? "active" : ""}`}
                title={on
                  ? `${s.label} — ${asc ? "lowest first" : "highest first"} · click to reverse`
                  : `Sort by ${s.label}`}
                onClick={() => pickSort(s.key)}>
                {s.label}
                {on && <span className="pb-sort-dir">{asc ? "↑" : "↓"}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {newFolderOpen && (
        <div className="card">
          <div className="card-title">NEW PLAYBOOK FOLDER</div>
          <FolderEditor folder={null} onSave={onCreateFolder} onCancel={onCancelFolder} />
        </div>
      )}

      {editing && folder && (
        <div className="card">
          <div className="card-title">EDIT · {folder.name}</div>
          <FolderEditor folder={folder} onSave={saveEdit} onCancel={() => setEditing(false)} />
        </div>
      )}

      {shown.length === 0 ? (
        <div className="pb-empty">No plays match this folder's criteria yet.</div>
      ) : (
        <div className="play-grid">
          {shown.map((t) => (
            <PlayTile key={`${t.r._date}::${t.r.sym}`} r={t.r} pinned={t.pinned} onOpen={setOpenRunner} />
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
        <window.HgOverlay label={`${openRunner.sym} · ${pbFmtDate(openRunner._date)}`}
          onClose={() => setOpenRunner(null)} className="hgo-dim hgo-scroll">
          <div className="pb-modal-inner">
            <window.RunnerTile r={openRunner} />
          </div>
        </window.HgOverlay>
      )}
    </div>
  );
}

Object.assign(window, {
  PlaybookPage, FolderEditor, AddToPlaybook,
  pbLoadFolders, pbAllFolders, pbUseFolders, pbAddFolder, pbUpdateFolder, pbDeleteFolder, pbNewFolderId,
  pbUsePins, pbPinsFor, pbTogglePin, pbPinKey,
  pbMatches, pbMatchesCriteria, pbEmptyCriteria, pbCriteriaCount,
  pbRegisterEntries, pbOptions,
  PB_DEFAULT_FOLDERS, PB_FIELDS, PB_SORTS, PB_AI_GRADES, PB_PRICE_RANGES,
});
