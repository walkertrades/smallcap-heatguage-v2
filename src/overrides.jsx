// ── Shared manual-override layer ───────────────────────────────────
//
// ONE layer, five features: catalyst (item 3), country (item 4), themes
// (item 9), behavior, and custom tags. Grades are deliberately NOT here — a
// displayed grade is an aggregate of N per-user documents, not a field
// override, so it gets its own collection.
//
// WHY THIS EXISTS AT ALL
// data2.json is regenerated nightly by the Python pipeline, so a manual edit
// written back into it would be wiped on the next run. Every manual edit lives
// in Firestore instead and is layered over the pipeline values at render time.
// It replaced a localStorage layer, which was per-browser: edits didn't travel
// between machines and nobody else on the desk could see them.
//
// STORAGE
//   overrides/{TICKER}-{date}     one doc per runner, sparse
// The doc id matches shDocId()/ntDocId() exactly. Ticker is UPPERCASED — data
// has 7 mixed-case rights/preferreds (MUAr, WALpA, OTAIr…) and the lookup must
// uppercase too or those silently lose their overrides.
//
// READ PATTERN
// One collection-wide onSnapshot for the whole session. These docs are sparse —
// they exist only where somebody actually edited something — so every page
// (Overview, Top Movers over any range, Playbook across all 1,028 days) is then
// served from memory with zero further reads, and an edit by another trader
// appears live. Tripwire: past ~5,000 docs, move to date-range-scoped listeners.
//
// Identifiers are prefixed `ovr`/`Ovr` to stay unique in the shared global scope.

const OVR_COLL = "overrides";
// Every field carries its own { value, by, byName, at } provenance block, which
// is what drives the "manually set" marker in the UI without a second lookup.
// `news` is the one field whose value is an object rather than a scalar/array:
//   { add: [item…], hide: [url…] }
// Editing a pipeline item = hide it + add a replacement, so there's no special
// "edit" case and no way to end up with a half-edited pipeline item. Still one
// field on the same doc with the same {value, by, byName, at} envelope.
const OVR_FIELDS = ["catalyst", "country", "themes", "behavior", "customTags", "news"];

function ovrDocId(sym, date) { return `${String(sym).toUpperCase()}-${date}`; }
function ovrRef(sym, date) { return window.db.collection(OVR_COLL).doc(ovrDocId(sym, date)); }

// ── Store ──────────────────────────────────────────────────────────
let ovrCache = Object.create(null);   // { "PLAG-2026-08-11": {catalyst:{…}, …} }
let ovrVersion = 0;                   // bumped on every snapshot, for memo deps
let ovrReady = false;
let ovrError = "";
let ovrUnsub = null;
const ovrSubs = new Set();

function ovrEmit() { ovrVersion++; ovrSubs.forEach((fn) => fn(ovrVersion)); }

function ovrStart() {
  if (!window.fbReady || !window.auth) return;
  // Rules require an authenticated read, so the listener follows the session
  // rather than attaching once at load.
  window.auth.onAuthStateChanged((user) => {
    if (ovrUnsub) { ovrUnsub(); ovrUnsub = null; }
    if (!user) {
      ovrCache = Object.create(null); ovrReady = false; ovrError = "";
      ovrEmit();
      return;
    }
    ovrUnsub = window.db.collection(OVR_COLL).onSnapshot(
      (snap) => {
        const next = Object.create(null);
        snap.forEach((d) => { next[d.id] = d.data(); });
        ovrCache = next; ovrReady = true; ovrError = "";
        ovrEmit();
      },
      (e) => {
        ovrError = e.code === "permission-denied"
          ? "Firestore rules reject reads of `overrides` — publish the rules block in src/firebase.js."
          : (e.message || "Could not load overrides.");
        console.warn("[overrides] listener:", ovrError);
        ovrEmit();
      },
    );
  });
}

function ovrGet(date, sym) {
  if (!date || !sym) return null;
  return ovrCache[ovrDocId(sym, date)] || null;
}
function ovrStatus() { return { ready: ovrReady, error: ovrError, count: Object.keys(ovrCache).length }; }

// Subscribe to the store. Components that render override-dependent data call
// this so a snapshot (yours or somebody else's) repaints them.
function ovrUseVersion() {
  const [v, setV] = React.useState(ovrVersion);
  React.useEffect(() => {
    const fn = (nv) => setV(nv);
    ovrSubs.add(fn);
    setV(ovrVersion);
    return () => { ovrSubs.delete(fn); };
  }, []);
  return v;
}
function ovrUseOverride(date, sym) {
  ovrUseVersion();
  return ovrGet(date, sym);
}

// ── Write ──────────────────────────────────────────────────────────
// Passing an empty value clears the field; clearing the last field drops the
// whole document so the collection stays sparse.
async function ovrSetField(date, sym, field, value, extra) {
  if (OVR_FIELDS.indexOf(field) < 0) throw new Error("unknown override field: " + field);
  if (!window.fbReady) throw new Error("Firestore is not available.");
  const cur = window.auCurrent ? window.auCurrent() : { user: null, profile: null };
  const user = cur.user || (window.auth && window.auth.currentUser) || null;
  if (!user) throw new Error("Sign in to edit.");

  const empty = value == null || value === ""
    || (Array.isArray(value) && value.length === 0)
    // `news` holds { add, hide } — empty when both lists are.
    || (typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length > 0
        && Object.keys(value).every((k) => Array.isArray(value[k]) && value[k].length === 0));

  // What survives this write, so we know whether the doc still has a reason to exist.
  const existing = ovrGet(date, sym) || {};
  const remaining = OVR_FIELDS.filter((f) => (f === field ? !empty : !!existing[f]));
  const ref = ovrRef(sym, date);

  if (!remaining.length) { await ref.delete(); return; }

  const patch = {
    ticker: String(sym).toUpperCase(),
    date,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  patch[field] = empty
    ? firebase.firestore.FieldValue.delete()
    : Object.assign({
        value,
        by: user.uid,
        // Snapshot fallback only — the UI renders the CURRENT handle through
        // pfUseProfile(by), so a rename propagates to old edits.
        byName: window.auDisplayName ? window.auDisplayName(user, cur.profile) : (user.email || "trader"),
        at: firebase.firestore.FieldValue.serverTimestamp(),
      }, extra || {});
  await ref.set(patch, { merge: true });
}
function ovrClearField(date, sym, field) { return ovrSetField(date, sym, field, null); }

// ── Merge ──────────────────────────────────────────────────────────
// Precedence, lowest to highest:
//   1. raw data2.json runner
//   2. normalizeRunnerV2() derived fields
//   3. pipeline themes/news (also written into data2.json)
//   4. this override doc — ALWAYS WINS, per field
// There is no recency comparison: a manual value stays authoritative until it
// is manually cleared, which is the whole point (the pipeline rewrites country
// to US every night on names that are actually Chinese).
//
// `_manual` carries the provenance block per field so the UI can mark a value
// as hand-set without a second lookup.
function ovrMergeRunner(r) {
  if (!r || !r._date) return r;
  const ov = ovrGet(r._date, r.sym);
  if (!ov) return r;
  const out = Object.assign({}, r);
  const man = {};
  // Keep the pipeline's own values around: the editor shows them as the
  // "use the AI value" option, and reverting an override has to restore them.
  out._base = { tag: r.tag || "", country: r.country || "", themes: r.themes || [] };
  if (ov.catalyst && ov.catalyst.value)   { out.tag = ov.catalyst.value;          man.catalyst = ov.catalyst; }
  if (ov.country && ov.country.value)     { out.country = ov.country.value;       man.country = ov.country; }
  if (ov.themes && Array.isArray(ov.themes.value))         { out.themes = ov.themes.value;         man.themes = ov.themes; }
  if (ov.behavior && ov.behavior.value)   { out.behaviorTag = ov.behavior.value;  man.behavior = ov.behavior; }
  if (ov.customTags && Array.isArray(ov.customTags.value)) { out.customTags = ov.customTags.value; man.customTags = ov.customTags; }
  if (ov.news && ov.news.value) {
    out.newsItems = ovrMergeNews(r.newsItems, ov.news);
    man.news = ov.news;
  }
  out._manual = man;
  return out;
}

// Manual news items merge with pipeline ones and always win: a hidden URL drops
// the pipeline item, and manual additions are layered on top. Sorted newest
// first so the list reads the same however the items arrived.
function ovrMergeNews(pipelineItems, newsOv) {
  const v = newsOv.value || {};
  const hide = Array.isArray(v.hide) ? v.hide : [];
  const add = Array.isArray(v.add) ? v.add : [];
  const kept = (pipelineItems || []).filter((i) => hide.indexOf(i.url) < 0);
  const manual = add.map((i) => Object.assign({}, i, {
    _manual: true, by: newsOv.by, byName: newsOv.byName,
  }));
  return kept.concat(manual).sort((a, b) =>
    String(b.published_utc || "").localeCompare(String(a.published_utc || "")));
}

// ── Retired localStorage layers ────────────────────────────────────
// Cleared once per browser so the old per-browser layer can't silently shadow
// the shared one. Levelled: item 6 adds level 2 for `hg2:grades` when the
// shared grade layer replaces it. Do NOT purge a key before its replacement
// ships — that deletes data with nothing to read it back from.
const OVR_PURGE_KEY = "hg2:lsPurge";
const OVR_PURGE_LEVEL = 2;
const OVR_LEGACY_KEYS = {
  1: ["hg2:tagEdits", "hg2:behavior"],   // replaced by overrides.jsx
  2: ["hg2:grades"],                     // replaced by grades.jsx
};
function ovrPurgeLegacy() {
  try {
    const done = parseInt(window.localStorage.getItem(OVR_PURGE_KEY) || "0", 10) || 0;
    if (done >= OVR_PURGE_LEVEL) return;
    for (let lvl = done + 1; lvl <= OVR_PURGE_LEVEL; lvl++) {
      for (const k of (OVR_LEGACY_KEYS[lvl] || [])) window.localStorage.removeItem(k);
    }
    window.localStorage.setItem(OVR_PURGE_KEY, String(OVR_PURGE_LEVEL));
  } catch (_) {}
}

// ── Orphans ────────────────────────────────────────────────────────
// An override whose ticker+date no longer appears in data2.json. These are
// inert — lookup is driven by the runners being rendered, so an orphan is never
// read — but they cost a document in the collection-wide listener.
//
// NEVER auto-deleted, deliberately. data2.json is regenerated nightly and HAS
// dropped runners that later came back: YXT (+1,136%, 1.78M float) was missing
// from Polygon's scan on 8/5 and had to be added by hand. Auto-pruning would
// have destroyed a hand-made override on exactly the name that mattered most.
// Surfaced here with a manual button instead. Nothing silent.
function ovrOrphans(entries) {
  const live = Object.create(null);
  for (const e of (entries || [])) {
    for (const r of (e.runners || [])) {
      live[ovrDocId(r.sym, e.date)] = true;
    }
  }
  const out = [];
  for (const key of Object.keys(ovrCache)) {
    if (!live[key]) {
      const d = ovrCache[key] || {};
      out.push({
        key,
        ticker: d.ticker || key.split("-")[0],
        date: d.date || key.slice(key.indexOf("-") + 1),
        fields: OVR_FIELDS.filter((f) => d[f]),
      });
    }
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function ovrDeleteDoc(key) {
  await window.db.collection(OVR_COLL).doc(key).delete();
}

ovrPurgeLegacy();
ovrStart();

Object.assign(window, {
  ovrDocId, ovrGet, ovrStatus, ovrUseVersion, ovrUseOverride,
  ovrSetField, ovrClearField, ovrMergeRunner, ovrMergeNews,
  ovrOrphans, ovrDeleteDoc,
  OVR_FIELDS,
});
