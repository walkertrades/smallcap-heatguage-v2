// Shared notes on a runner — Firestore at notes/{ticker}-{date}/comments.
// Live for every signed-in user via onSnapshot, so a note added by one trader
// shows up on another's open tile without a refresh.
//
// Identifiers prefixed `nt`/`NT` to stay unique in the shared global scope.

const { useState: useState_Nt, useEffect: useEffect_Nt } = React;

function ntDocId(sym, date) { return `${String(sym).toUpperCase()}-${date}`; }
function ntCollection(sym, date) {
  return window.db.collection("notes").doc(ntDocId(sym, date)).collection("comments");
}

// "Jul 27 · 9:42 AM"
const NT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ntStamp(ts) {
  let d = null;
  if (!ts) d = new Date();                       // serverTimestamp not resolved yet
  else if (typeof ts.toDate === "function") d = ts.toDate();
  else if (ts instanceof Date) d = ts;
  else if (typeof ts === "number") d = new Date(ts);
  if (!d || isNaN(d.getTime())) return "just now";
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return `${NT_MONTHS[d.getMonth()]} ${d.getDate()} · ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

// Live handle for a note's author, so renaming updates historical notes.
function NoteHandle({ uid, fallback }) {
  const live = window.pfUseProfile(uid);
  const name = (live && live.username) || fallback || "trader";
  return <>{"@" + String(name).replace(/^@+/, "")}</>;
}

function NoteRow({ note, canDelete, onDelete }) {
  const [busy, setBusy] = useState_Nt(false);
  const del = async () => {
    if (busy) return;
    setBusy(true);
    try { await onDelete(note.id); } catch (_) { setBusy(false); }
  };
  return (
    <li className={`note-row ${busy ? "going" : ""}`}>
      {/* Avatar reads the LIVE profile for authorUid, falling back to the
          snapshot stored on the note — so a username change updates old notes. */}
      <window.Avatar uid={note.authorUid} size={26} tooltip
        fallback={{ username: note.authorUsername || note.authorName, fullName: note.authorFullName, photoURL: note.authorPhotoURL }} />
      <div className="note-body">
        <div className="note-meta">
          <span className="note-author">
            <NoteHandle uid={note.authorUid} fallback={note.authorUsername || note.authorName} />
          </span>
          <span className="note-time">{ntStamp(note.createdAt)}</span>
          {canDelete && (
            <button className="note-del" onClick={del} disabled={busy} title="Delete note" aria-label="Delete note">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h16" />
                <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
                <path d="M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7" />
                <path d="M10.5 11v6M13.5 11v6" />
              </svg>
            </button>
          )}
        </div>
        <p className="note-text">{note.text}</p>
      </div>
    </li>
  );
}

function NotesPanel({ sym, date, user, profile }) {
  const [notes, setNotes] = useState_Nt([]);
  const [text, setText] = useState_Nt("");
  const [busy, setBusy] = useState_Nt(false);
  const [err, setErr] = useState_Nt("");
  const [ready, setReady] = useState_Nt(false);

  const cur = window.auCurrent ? window.auCurrent() : { user: null, profile: null };
  const me = user || cur.user || (window.auth && window.auth.currentUser) || null;
  const uid = me ? me.uid : null;
  const liveMe = window.pfUseProfile(uid);
  const myProfile = liveMe || profile || cur.profile;

  useEffect_Nt(() => {
    if (!window.fbReady || !sym || !date) { setReady(true); return; }
    let cancelled = false;
    const unsub = ntCollection(sym, date)
      .orderBy("createdAt", "asc")
      .onSnapshot(
        (snap) => {
          if (cancelled) return;
          setNotes(snap.docs.map((d) => Object.assign({ id: d.id }, d.data())));
          setReady(true);
          setErr("");
        },
        (e) => {
          if (cancelled) return;
          console.warn("[notes] listener:", e.message);
          setErr("Could not load notes.");
          setReady(true);
        },
      );
    return () => { cancelled = true; unsub(); };
  }, [sym, date]);

  const add = async (e) => {
    if (e) e.preventDefault();
    const body = text.trim();
    if (!body || busy || !uid) return;
    setBusy(true); setErr("");
    try {
      const live = myProfile || {};
      await ntCollection(sym, date).add({
        text: body,
        authorUid: uid,
        // denormalised snapshot — a fallback for when the live profile read
        // isn't permitted; the UI prefers the live one so renames propagate
        authorName: window.auDisplayName(me, live),
        authorUsername: (live && live.username) || window.auDisplayName(me, live),
        authorFullName: (live && live.fullName) || "",
        authorPhotoURL: (live && live.photoURL) || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setText("");
    } catch (e2) {
      setErr(e2.message || "Could not add note.");
    }
    setBusy(false);
  };

  const remove = async (id) => {
    try { await ntCollection(sym, date).doc(id).delete(); }
    catch (e) { setErr("Could not delete that note."); throw e; }
  };

  return (
    <div className="notes" onClick={(e) => e.stopPropagation()}>
      <div className="notes-head">
        <span className="rt-lbl">NOTES</span>
        <span className="notes-count">{notes.length || ""}</span>
      </div>

      {!ready ? (
        <p className="notes-empty">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="notes-empty">No notes on {String(sym).toUpperCase()} yet — add the first one.</p>
      ) : (
        <ul className="notes-list">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} canDelete={!!uid && n.authorUid === uid} onDelete={remove} />
          ))}
        </ul>
      )}

      <form className="notes-add" onSubmit={add}>
        <input type="text" value={text} placeholder="Add a note for the desk…" disabled={busy || !uid}
          onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={busy || !text.trim() || !uid}>
          {busy ? "Adding…" : "Add Note"}
        </button>
      </form>
      {err && <p className="notes-err">{err}</p>}
    </div>
  );
}

Object.assign(window, { NotesPanel, ntStamp, ntDocId });
