// Profiles — usernames, avatars, and the shared profile cache.
//
// Notes and chart credits render from a LIVE `users/{uid}` subscription rather
// than from a copy stored on each note. That's what makes "change your username
// and it updates everywhere" actually true; denormalised copies would leave old
// notes showing the old handle forever. Each note still carries a denormalised
// snapshot as a fallback for when the live read is unavailable.
//
// Identifiers prefixed `pf`/`Pf` to stay unique in the shared global scope.

const { useState: useState_Pf, useEffect: useEffect_Pf, useRef: useRef_Pf } = React;

// ── username rules ─────────────────────────────────────────────────
const PF_USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
function pfNormalizeUsername(u) { return String(u || "").trim().replace(/^@+/, ""); }
function pfUsernameError(raw) {
  const u = pfNormalizeUsername(raw);
  if (!u) return "Pick a username.";
  if (u.length < 3) return "At least 3 characters.";
  if (u.length > 20) return "At most 20 characters.";
  if (!PF_USERNAME_RE.test(u)) return "Letters, numbers and underscores only.";
  return null;
}
// Usernames are reserved case-insensitively so @Jack and @jack can't collide.
function pfUsernameKey(u) { return pfNormalizeUsername(u).toLowerCase(); }

// ── deterministic avatar colour ────────────────────────────────────
// FNV-1a over the username, so a given person is always the same colour.
function pfAvatarHue(name) {
  const s = String(name || "?").toLowerCase();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % 360;
}
function pfAvatarColors(name) {
  const hue = pfAvatarHue(name);
  return {
    bg: `linear-gradient(140deg, oklch(0.68 0.15 ${hue}), oklch(0.55 0.16 ${(hue + 32) % 360}))`,
    fg: "oklch(0.16 0.02 260)",
  };
}
function pfLetter(profile, fallbackEmail) {
  const src = (profile && (profile.username || profile.fullName)) ||
    String(fallbackEmail || "").split("@")[0] || "?";
  return String(src).trim().charAt(0).toUpperCase() || "?";
}
function pfHandle(profile, fallbackEmail) {
  if (profile && profile.username) return "@" + profile.username;
  const e = String(fallbackEmail || "").split("@")[0];
  return e ? "@" + e : "@trader";
}

// ── shared live profile cache ──────────────────────────────────────
// One Firestore listener per uid, shared by every component that asks.
const pfState = {};
function pfSubscribe(uid, cb) {
  if (!uid) return function () {};
  if (!pfState[uid]) {
    pfState[uid] = { data: undefined, listeners: new Set(), unsub: null };
    try {
      pfState[uid].unsub = window.db.collection("users").doc(uid).onSnapshot(
        (snap) => {
          pfState[uid].data = snap.exists ? snap.data() : null;
          pfState[uid].listeners.forEach((f) => f(pfState[uid].data));
        },
        (e) => {
          // rules may not permit reading other people's profiles yet — fall back
          // to whatever the caller denormalised
          console.warn("[profile] live read unavailable for", uid, e.code || e.message);
          pfState[uid].data = null;
          pfState[uid].listeners.forEach((f) => f(null));
        },
      );
    } catch (e) { pfState[uid].data = null; }
  }
  const entry = pfState[uid];
  entry.listeners.add(cb);
  if (entry.data !== undefined) cb(entry.data);
  return function () { entry.listeners.delete(cb); };
}
function pfUseProfile(uid) {
  const [p, setP] = useState_Pf(() => (uid && pfState[uid] ? pfState[uid].data : undefined));
  useEffect_Pf(() => {
    if (!uid) { setP(null); return; }
    return pfSubscribe(uid, setP);
  }, [uid]);
  return p;
}
// nudge the cache immediately after our own write, so the UI doesn't wait
function pfPrime(uid, data) {
  if (!uid) return;
  if (!pfState[uid]) pfState[uid] = { data: undefined, listeners: new Set(), unsub: null };
  pfState[uid].data = Object.assign({}, pfState[uid].data || {}, data);
  pfState[uid].listeners.forEach((f) => f(pfState[uid].data));
}

// ── avatar image pipeline ──────────────────────────────────────────
const PF_AVATAR_PX = 200;
// Centre-crop to a square then downscale — keeps faces centred and keeps the
// upload small (a 4MB phone photo lands around 15KB).
function pfCompressAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error("That isn't an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Could not decode that image."));
      img.onload = () => {
        const side = Math.min(img.width || PF_AVATAR_PX, img.height || PF_AVATAR_PX);
        const sx = ((img.width || side) - side) / 2;
        const sy = ((img.height || side) - side) / 2;
        const cv = window.document.createElement("canvas");
        cv.width = PF_AVATAR_PX; cv.height = PF_AVATAR_PX;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, PF_AVATAR_PX, PF_AVATAR_PX);
        cv.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode that image."))),
          "image/jpeg", 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function pfUploadAvatar(uid, blob) {
  const ref = window.storage.ref("avatars/" + uid + ".jpg");
  await ref.put(blob, { contentType: "image/jpeg", cacheControl: "public,max-age=300" });
  return ref.getDownloadURL();
}

// ── username reservation ───────────────────────────────────────────
// usernames/{lowercased} holds { uid, username } for O(1) uniqueness checks.
async function pfUsernameTaken(username) {
  const snap = await window.db.collection("usernames").doc(pfUsernameKey(username)).get();
  return snap.exists;
}
// Claim inside a transaction so two simultaneous signups can't both win.
async function pfClaimUsername(uid, username, previous) {
  const db = window.db;
  const key = pfUsernameKey(username);
  const ref = db.collection("usernames").doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().uid !== uid) throw new Error("That username is taken.");
    tx.set(ref, { uid, username: pfNormalizeUsername(username) });
    const prevKey = previous ? pfUsernameKey(previous) : null;
    if (prevKey && prevKey !== key) tx.delete(db.collection("usernames").doc(prevKey));
  });
}

// ── avatar ─────────────────────────────────────────────────────────
// `fallback` is the snapshot stored on the note/chart, used until (or unless)
// the live profile arrives.
function Avatar({ uid, fallback, email, size, tooltip, className }) {
  const live = pfUseProfile(uid);
  const p = (live && (live.username || live.photoURL)) ? live : (fallback || live || null);
  const px = size || 26;
  const handle = pfHandle(p, email);
  const colors = pfAvatarColors(p && p.username ? p.username : handle);
  const style = { width: px, height: px, flexBasis: px, fontSize: Math.max(9, Math.round(px * 0.42)) };

  const body = p && p.photoURL
    ? <img className="pf-avatar-img" src={p.photoURL} alt="" draggable="false" />
    : <span className="pf-avatar-letter">{pfLetter(p, email)}</span>;

  return (
    <span className={`pf-avatar ${className || ""}`} style={p && p.photoURL ? style : Object.assign({ background: colors.bg, color: colors.fg }, style)}>
      {body}
      {tooltip && (
        <span className="pf-avatar-tip">
          <b>{handle}</b>
          {p && p.fullName ? <em>{p.fullName}</em> : null}
        </span>
      )}
    </span>
  );
}

// ── circular photo picker (signup + edit profile) ──────────────────
function PhotoPicker({ preview, onPick, onClear, busy, label }) {
  const inputRef = useRef_Pf(null);
  return (
    <div className="pf-photo">
      <button type="button" className={`pf-photo-zone ${preview ? "has" : ""}`} disabled={busy}
        onClick={() => inputRef.current && inputRef.current.click()}
        aria-label={preview ? "Change photo" : "Add photo"}>
        {preview
          ? <img src={preview} alt="" draggable="false" />
          : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" />
              <circle cx="12" cy="12.6" r="3.4" />
            </svg>
          )}
      </button>
      <div className="pf-photo-meta">
        <span className="pf-photo-label">{label || (preview ? "Photo added" : "Add Photo")}</span>
        <span className="pf-photo-hint">
          {preview
            ? <button type="button" className="pf-photo-clear" onClick={onClear} disabled={busy}>Remove</button>
            : "Optional · square crop, 200px"}
        </span>
      </div>
      <input ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) onPick(f); e.target.value = ""; }} />
    </div>
  );
}

// ── live username availability ─────────────────────────────────────
// status: "" | "checking" | "ok" | "taken" | "invalid" | "unavailable"
function pfUseUsernameCheck(raw, currentUsername) {
  const [status, setStatus] = useState_Pf("");
  const [message, setMessage] = useState_Pf("");

  useEffect_Pf(() => {
    const u = pfNormalizeUsername(raw);
    if (!u) { setStatus(""); setMessage(""); return; }
    const err = pfUsernameError(u);
    if (err) { setStatus("invalid"); setMessage(err); return; }
    if (currentUsername && pfUsernameKey(u) === pfUsernameKey(currentUsername)) {
      setStatus("ok"); setMessage("This is your username."); return;
    }
    setStatus("checking"); setMessage("Checking…");
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const taken = await pfUsernameTaken(u);
        if (cancelled) return;
        setStatus(taken ? "taken" : "ok");
        setMessage(taken ? "That username is taken." : "Available");
      } catch (e) {
        if (cancelled) return;
        // rules not published yet → can't verify; don't block the user
        setStatus("unavailable");
        setMessage("Can't verify right now.");
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [raw, currentUsername]);

  return { status, message };
}

function PfUsernameField({ value, onChange, disabled, currentUsername, autoFocus }) {
  const { status, message } = pfUseUsernameCheck(value, currentUsername);
  return (
    <label className="vault-field pf-username">
      <span>Username</span>
      <div className={`pf-username-wrap ${status}`}>
        <span className="pf-username-at">@</span>
        <input type="text" value={value} placeholder="jackw" autoComplete="username"
          disabled={disabled} autoFocus={autoFocus} maxLength={20}
          onChange={(e) => onChange(pfNormalizeUsername(e.target.value))} />
        <span className="pf-username-mark" aria-hidden="true">
          {status === "checking" ? <span className="pf-spin" />
            : status === "ok" ? "✓"
            : (status === "taken" || status === "invalid") ? "✕"
            : status === "unavailable" ? "!" : ""}
        </span>
      </div>
      {message && <span className={`pf-username-msg ${status}`}>{message}</span>}
    </label>
  );
}

// ── edit profile modal ─────────────────────────────────────────────
function EditProfileModal({ user, profile, onClose }) {
  const [username, setUsername] = useState_Pf((profile && profile.username) || "");
  const [fullName, setFullName] = useState_Pf((profile && profile.fullName) || "");
  const [photoBlob, setPhotoBlob] = useState_Pf(null);
  const [preview, setPreview] = useState_Pf((profile && profile.photoURL) || null);
  const [cleared, setCleared] = useState_Pf(false);
  const [busy, setBusy] = useState_Pf(false);
  const [err, setErr] = useState_Pf("");
  const [done, setDone] = useState_Pf(false);

  const original = (profile && profile.username) || "";
  const { status } = pfUseUsernameCheck(username, original);

  const pick = async (file) => {
    setErr("");
    try {
      const blob = await pfCompressAvatar(file);
      setPhotoBlob(blob);
      setCleared(false);
      setPreview(URL.createObjectURL(blob));
    } catch (e) { setErr(e.message); }
  };

  const save = async (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    const uErr = pfUsernameError(username);
    if (uErr) { setErr(uErr); return; }
    if (status === "taken") { setErr("That username is taken."); return; }

    setBusy(true); setErr("");
    try {
      const patch = { username: pfNormalizeUsername(username), fullName: fullName.trim() };
      if (pfUsernameKey(username) !== pfUsernameKey(original)) {
        await pfClaimUsername(user.uid, username, original);
      }
      if (photoBlob) patch.photoURL = await pfUploadAvatar(user.uid, photoBlob);
      else if (cleared) patch.photoURL = null;

      await window.db.collection("users").doc(user.uid).set(patch, { merge: true });
      pfPrime(user.uid, patch);
      try { await user.updateProfile({ displayName: patch.username }); } catch (_) {}
      setDone(true);
      window.setTimeout(onClose, 550);
    } catch (e2) {
      setErr(e2.code === "permission-denied"
        ? "Firestore rules don't allow this yet — see src/firebase.js."
        : (e2.message || "Could not save."));
      setBusy(false);
    }
  };

  useEffect_Pf(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="pf-modal" onClick={() => !busy && onClose()}>
      <form className="pf-modal-card" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="pf-modal-head">
          <h2>Edit Profile</h2>
          <button type="button" className="pf-modal-close" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>

        <PhotoPicker preview={preview} busy={busy} onPick={pick}
          onClear={() => { setPhotoBlob(null); setPreview(null); setCleared(true); }}
          label={preview ? "Profile photo" : "Add Photo"} />

        <PfUsernameField value={username} onChange={setUsername} disabled={busy} currentUsername={original} />

        <label className="vault-field">
          <span>Full name</span>
          <input type="text" value={fullName} placeholder="Jack Walker" autoComplete="name"
            disabled={busy} onChange={(e) => setFullName(e.target.value)} />
        </label>

        <button type="submit" className={`vault-submit ${busy ? "busy" : ""}`}
          disabled={busy || status === "taken" || status === "invalid"}>
          <span className="vault-submit-label">
            {done ? "SAVED" : busy ? "SAVING…" : "SAVE CHANGES"}
          </span>
          {busy && <span className="vault-submit-bar" aria-hidden="true" />}
        </button>
        {err && <p className="vault-error" role="alert">{err}</p>}
      </form>
    </div>
  );
}

Object.assign(window, {
  Avatar, PhotoPicker, PfUsernameField, EditProfileModal,
  pfUseProfile, pfPrime, pfSubscribe,
  pfUsernameError, pfNormalizeUsername, pfUsernameKey, pfUsernameTaken, pfClaimUsername,
  pfCompressAvatar, pfUploadAvatar, pfAvatarColors, pfAvatarHue, pfHandle, pfLetter,
  pfUseUsernameCheck, PF_USERNAME_RE,
});
