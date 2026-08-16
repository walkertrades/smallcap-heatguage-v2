// ── Shared grades ──────────────────────────────────────────────────
//
// Everyone on the desk grades independently and everyone sees everyone's
// grades. The DISPLAYED grade is the average of every submitted grade; the
// individual votes are what's stored.
//
//   grades/{TICKER}-{date}/gradeVotes/{uid}
//
// The document ID IS the uid. That's deliberate: it makes "a user can only
// write their own grade" a security rule that cannot be spoofed, because no
// field on the document is trusted for ownership.
//
// The subcollection is `gradeVotes`, NOT `users` — collectionGroup("users")
// would also match the top-level profile collection and pull profile documents
// into grade queries.
//
// READ PATTERN — one collection-group listener over every vote.
// The approved schema called for page-scoped `in` queries capped at 30 keys.
// Reading the existing code showed that to be wrong: grades are used to SORT
// (Overview.jsx:238 and Playbook pbMyGradeRank, both applied BEFORE pagination)
// and to FILTER (Playbook folder criteria carry a `grades` list matched across
// all 1,028 days). Both need every in-scope runner's grade, not just the
// visible page — page-scoped loading would sort and filter by whatever happened
// to be resident, which is silently wrong rather than merely slow. Votes are
// sparse in the same way overrides are, so one listener is correct AND cheap.
//
// Identifiers are prefixed `gr`/`Gr` to stay unique in the shared global scope.

const GR_COLL = "grades";
const GR_SUB = "gradeVotes";

// F..A++ mapped to a numeric scale for averaging. Index matches window.GRADES.
const GR_VALUE = { "F": 0, "D": 1, "C": 2, "B": 3, "A": 4, "A+": 5, "A++": 6 };

function grDocId(sym, date) { return `${String(sym).toUpperCase()}-${date}`; }
function grVoteRef(sym, date, uid) {
  return window.db.collection(GR_COLL).doc(grDocId(sym, date)).collection(GR_SUB).doc(uid);
}
function grUid() {
  const cur = window.auCurrent ? window.auCurrent() : null;
  const u = (cur && cur.user) || (window.auth && window.auth.currentUser) || null;
  return u ? u.uid : null;
}

// ── Store ──────────────────────────────────────────────────────────
let grCache = Object.create(null);   // { "PLAG-2026-08-11": { uid: vote } }
let grVersion = 0;
let grReady = false;
let grError = "";
let grUnsub = null;
const grSubs = new Set();

function grEmit() { grVersion++; grSubs.forEach((fn) => fn(grVersion)); }

function grStart() {
  if (!window.fbReady || !window.auth) return;
  window.auth.onAuthStateChanged((user) => {
    if (grUnsub) { grUnsub(); grUnsub = null; }
    if (!user) {
      grCache = Object.create(null); grReady = false; grError = "";
      grEmit();
      return;
    }
    grUnsub = window.db.collectionGroup(GR_SUB).onSnapshot(
      (snap) => {
        const next = Object.create(null);
        snap.forEach((d) => {
          const v = d.data() || {};
          // `key` is denormalised onto every vote, but fall back to the parent
          // doc id so a vote written without it still lands in the right bucket.
          const key = v.key || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
          if (!key) return;
          if (!next[key]) next[key] = Object.create(null);
          next[key][d.id] = Object.assign({}, v, { userId: v.userId || d.id });
        });
        grCache = next; grReady = true; grError = "";
        grEmit();
      },
      (e) => {
        grError = e.code === "permission-denied"
          ? "Firestore rules reject reads of `gradeVotes` — publish the grades rules block in src/firebase.js."
          : (e.message || "Could not load grades.");
        console.warn("[grades] listener:", grError);
        grEmit();
      },
    );
  });
}

function grStatus() { return { ready: grReady, error: grError }; }

function grUseVersion() {
  const [v, setV] = React.useState(grVersion);
  React.useEffect(() => {
    const fn = (nv) => setV(nv);
    grSubs.add(fn);
    setV(grVersion);
    return () => { grSubs.delete(fn); };
  }, []);
  return v;
}

// ── Read ───────────────────────────────────────────────────────────
function grVotes(date, sym) {
  if (!date || !sym) return [];
  const m = grCache[grDocId(sym, date)];
  if (!m) return [];
  return Object.keys(m).map((k) => m[k]).filter((v) => v && v.grade);
}

// Displayed grade = mean of all votes, rounded to the nearest valid label.
// Math.round takes .5 upward, so a straight split lands on the better grade.
function grAggregate(date, sym) {
  const votes = grVotes(date, sym);
  if (!votes.length) return { grade: null, count: 0, votes: [] };
  const nums = votes.map((v) => GR_VALUE[v.grade]).filter((n) => n != null);
  if (!nums.length) return { grade: null, count: 0, votes: [] };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const labels = window.GRADES || [];
  const grade = labels[Math.max(0, Math.min(labels.length - 1, Math.round(mean)))] || null;
  // Stable order for the tooltip: best grade first, then by name.
  const sorted = votes.slice().sort((a, b) =>
    (GR_VALUE[b.grade] - GR_VALUE[a.grade])
    || String(a.displayName || "").localeCompare(String(b.displayName || "")));
  return { grade, count: votes.length, votes: sorted, mean };
}

// The app-wide accessor. Every existing consumer — Top Movers' grade column and
// sort, Playbook tiles, folder criteria — reads the AVERAGED grade through this.
function getGrade(date, sym) { return grAggregate(date, sym).grade; }

function grMyGrade(date, sym) {
  const uid = grUid();
  if (!uid) return null;
  const m = grCache[grDocId(sym, date)];
  return (m && m[uid] && m[uid].grade) || null;
}

// ── Write ──────────────────────────────────────────────────────────
// Only ever touches the caller's own vote document.
async function grSetMyGrade(date, sym, grade) {
  if (!window.fbReady) throw new Error("Firestore is not available.");
  const cur = window.auCurrent ? window.auCurrent() : { user: null, profile: null };
  const user = cur.user || (window.auth && window.auth.currentUser) || null;
  if (!user) throw new Error("Sign in to grade.");
  const ref = grVoteRef(sym, date, user.uid);
  if (!grade) { await ref.delete(); return null; }
  if ((window.GRADES || []).indexOf(grade) < 0) throw new Error("Unknown grade: " + grade);
  await ref.set({
    grade,
    userId: user.uid,
    // Snapshot fallback only — the UI renders the CURRENT handle via
    // pfSubscribe(uid), so a rename propagates to grades cast long ago.
    displayName: window.auDisplayName ? window.auDisplayName(user, cur.profile) : (user.email || "trader"),
    ticker: String(sym).toUpperCase(),
    date,
    key: grDocId(sym, date),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return grade;
}

// ── Live grader handles ────────────────────────────────────────────
// One hook rather than a hook per grader, so the number of hooks stays constant
// as votes come and go. Uses pfSubscribe (not pfUseProfile) for exactly that
// reason — same live-profile cache, no per-row hook.
function grUseNames(votes) {
  const ids = votes.map((v) => v.userId).filter(Boolean).sort().join(",");
  const [names, setNames] = React.useState({});
  React.useEffect(() => {
    if (!ids || !window.pfSubscribe) { setNames({}); return; }
    const list = ids.split(",");
    const unsubs = list.map((uid) => window.pfSubscribe(uid, (p) => {
      const n = p && p.username;
      if (!n) return;
      setNames((prev) => (prev[uid] === n ? prev : Object.assign({}, prev, { [uid]: n })));
    }));
    return () => unsubs.forEach((f) => { if (typeof f === "function") f(); });
  }, [ids]);
  return names;
}

function grHandle(vote, names) {
  const n = (names && names[vote.userId]) || vote.displayName || "a trader";
  return "@" + String(n).replace(/^@+/, "");
}

// ── Badge ──────────────────────────────────────────────────────────
// The averaged grade, a superscript count once 2+ people have graded, and a
// hover listing every grader with their individual grade.
//
// The tooltip is a native `title` on purpose. A styled tooltip would sit inside
// the Top Movers table, whose scroll container clips it and whose sticky column
// creates a stacking context — the exact trap that hid the chart viewer behind
// the header bar. A native tooltip cannot be clipped by either.
function GrGradeBadge({ date, sym, showEmpty }) {
  grUseVersion();
  const agg = grAggregate(date, sym);
  const names = grUseNames(agg.votes);
  const g = agg.grade;
  if (!g && !showEmpty) return null;

  const title = agg.count
    ? `Average of ${agg.count} grade${agg.count > 1 ? "s" : ""}: ${g}\n`
      + agg.votes.map((v) => `${grHandle(v, names)} · ${v.grade}`).join("\n")
    : "Ungraded";

  return (
    <span className={`grade-badge ${g ? "graded" : "ungraded"} ${g === "A++" ? "grade-gold" : ""}`}
      style={{ "--gc": window.gradeColor(g) }} title={title}>
      {g || "—"}
      {agg.count >= 2 && <sup className="gr-count">{agg.count}</sup>}
    </span>
  );
}

// The roster under the picker, so it's visible without hovering who graded what.
function GrGraderList({ date, sym }) {
  grUseVersion();
  const agg = grAggregate(date, sym);
  const names = grUseNames(agg.votes);
  const me = grUid();
  if (!agg.count) return null;
  return (
    <div className="gr-roster">
      {agg.votes.map((v) => (
        <span key={v.userId} className={`gr-roster-item ${v.userId === me ? "mine" : ""}`}
          title={v.userId === me ? "Your grade" : "Another trader's grade — read only"}>
          <span className="gr-roster-name">{grHandle(v, names)}</span>
          <span className="gr-roster-grade" style={{ color: window.gradeColor(v.grade) }}>{v.grade}</span>
        </span>
      ))}
    </div>
  );
}

grStart();

Object.assign(window, {
  grDocId, grVotes, grAggregate, getGrade, grMyGrade, grSetMyGrade,
  grUseVersion, grUseNames, grStatus, GrGradeBadge, GrGraderList,
  GR_VALUE,
});
