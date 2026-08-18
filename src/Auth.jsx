// Auth layer — landing/login screen, auth-state hook, and the header user menu.
// Identifiers prefixed `au`/`AU` to stay unique in the shared global scope.

const { useState: useState_Au, useEffect: useEffect_Au, useRef: useRef_Au } = React;

// ── helpers ────────────────────────────────────────────────────────
function auInitials(name, email) {
  const src = (name || "").trim() || (email || "").split("@")[0] || "?";
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : src.slice(0, 2);
  return letters.toUpperCase();
}
function auDisplayName(user, profile) {
  if (profile && profile.username) return profile.username;
  if (profile && profile.displayName) return profile.displayName; // pre-username accounts
  if (user && user.displayName) return user.displayName;
  if (user && user.email) return user.email.split("@")[0];
  return "Trader";
}
// Firebase error codes are not user-facing copy — translate the ones we expect.
const AU_ERRORS = {
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/user-not-found": "No account found for that email.",
  "auth/wrong-password": "Incorrect password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/invalid-login-credentials": "Incorrect email or password.",
  "auth/email-already-in-use": "An account with that email already exists.",
  "auth/weak-password": "Password must be at least 6 characters.",
  "auth/too-many-requests": "Too many attempts — wait a moment and try again.",
  "auth/network-request-failed": "Network error — check your connection.",
  "auth/operation-not-allowed": "Email sign-in is not enabled for this project.",
};
function auErrorText(e) {
  if (!e) return "";
  const code = (e.code || "").toLowerCase();
  return AU_ERRORS[code] || e.message || "Something went wrong. Try again.";
}
function auReduced() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
}

// ── vault sound ────────────────────────────────────────────────────
// Synthesised, not a bundled asset: a low thunk plus a filtered noise clack.
// Off by default; the toggle persists. The AudioContext is only created inside
// a click handler, which keeps browser autoplay policy happy.
const AU_SOUND_KEY = "hg2:vaultSound";
let auAudioCtx = null;
function auSoundOn() {
  try { return window.localStorage.getItem(AU_SOUND_KEY) === "1"; } catch (_) { return false; }
}
function auSetSound(on) {
  try { window.localStorage.setItem(AU_SOUND_KEY, on ? "1" : "0"); } catch (_) {}
}
function auVaultSound() {
  if (!auSoundOn()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    auAudioCtx = auAudioCtx || new Ctx();
    if (auAudioCtx.state === "suspended") auAudioCtx.resume();
    const ctx = auAudioCtx, t = ctx.currentTime;

    const osc = ctx.createOscillator(), og = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(122, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.15);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.32);

    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1400;
    const ng = ctx.createGain(); ng.gain.value = 0.15;
    src.connect(hp).connect(ng).connect(ctx.destination);
    src.start(t);
  } catch (_) {}
}

// ── character-by-character decrypt ─────────────────────────────────
const AU_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/\\<>*+=";
function AuthDecrypt({ text, delay, speed, className }) {
  const settle = speed || 42;
  const wait = delay || 0;
  const [out, setOut] = useState_Au(() => (auReduced() ? text : text.replace(/\S/g, " ")));

  useEffect_Au(() => {
    if (auReduced()) { setOut(text); return; }
    const chars = text.split("");
    let raf = 0, start = null;
    const tick = (ts) => {
      if (start === null) start = ts;
      const el = ts - start - wait;
      if (el < 0) { raf = requestAnimationFrame(tick); return; }
      const locked = Math.floor(el / settle);
      if (locked >= chars.length) { setOut(text); return; }
      setOut(chars.map((c, i) => {
        if (c === " ") return " ";
        if (i < locked) return c;
        return AU_GLYPHS[Math.floor(Math.random() * AU_GLYPHS.length)];
      }).join(""));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, wait, settle]);

  return <span className={className}>{out}</span>;
}

// ── auth state ─────────────────────────────────────────────────────
// { status: "loading" | "in" | "out", user, profile }
function auUseAuth() {
  const [state, setState] = useState_Au({ status: "loading", user: null, profile: null });

  useEffect_Au(() => {
    if (!window.fbReady || !window.auth) {
      setState({ status: "out", user: null, profile: null, fatal: "Firebase failed to load." });
      return;
    }
    const unsub = window.auth.onAuthStateChanged(async (user) => {
      if (!user) { setState({ status: "out", user: null, profile: null }); return; }
      let profile = null;
      try {
        const ref = window.db.collection("users").doc(user.uid);
        // createUserWithEmailAndPassword signs the user in BEFORE the signup's
        // profile write lands, so the doc is legitimately missing for a moment.
        // Poll briefly instead of healing straight away — healing too eagerly
        // overwrites the real display name with the email prefix, and because
        // it's a race it only bites some of the time.
        for (var attempt = 0; attempt < 6; attempt++) {
          const snap = await ref.get();
          if (snap.exists) { profile = snap.data(); break; }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 400));
        }
        if (!profile) {
          // Genuinely orphaned: a signup interrupted between createUser and the
          // profile write would otherwise have no profile doc forever.
          const guess = (user.displayName || (user.email || "").split("@")[0] || "trader")
            .replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || "trader";
          profile = {
            username: guess,
            fullName: "",
            photoURL: user.photoURL || null,
            email: user.email || "",
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            role: "trader",
          };
          await ref.set(profile, { merge: true });
        }
      } catch (e) {
        // a locked-down rules set shouldn't blank the whole app
        console.warn("[auth] could not load/create profile:", e.message);
      }
      setState({ status: "in", user, profile });
    });
    return unsub;
  }, []);

  return state;
}

// ── landing / login (vault) ────────────────────────────────────────
// The two .vault-door panels ARE the background: closed they cover the screen,
// on success they slide apart to reveal the dashboard already mounted beneath.
function AuthLanding() {
  const [mode, setMode] = useState_Au("signin"); // signin | signup
  const [email, setEmail] = useState_Au("");
  const [password, setPassword] = useState_Au("");
  const [confirm, setConfirm] = useState_Au("");
  const [username, setUsername] = useState_Au("");
  const [fullName, setFullName] = useState_Au("");
  const [photoBlob, setPhotoBlob] = useState_Au(null);
  const [photoPreview, setPhotoPreview] = useState_Au(null);
  const [busy, setBusy] = useState_Au(false);
  const [err, setErr] = useState_Au("");
  const [shake, setShake] = useState_Au(false);
  const [sound, setSound] = useState_Au(auSoundOn);

  const isSignup = mode === "signup";
  const swap = (next) => { setMode(next); setErr(""); setPassword(""); setConfirm(""); };
  const nameCheck = window.pfUseUsernameCheck(isSignup ? username : "", null);

  const fail = (msg) => {
    setErr(msg);
    setBusy(false);
    setShake(true);
    window.setTimeout(() => setShake(false), 520);
  };

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    setErr("");

    const mail = email.trim();
    if (!mail || !password) return fail("Enter your email and password.");
    if (isSignup) {
      const uErr = window.pfUsernameError(username);
      if (uErr) return fail(uErr);
      if (nameCheck.status === "taken") return fail("That username is taken.");
      if (password.length < 6) return fail("Password must be at least 6 characters.");
      if (password !== confirm) return fail("Passwords don't match.");
    }

    setBusy(true);
    try {
      if (isSignup) {
        const handle = window.pfNormalizeUsername(username);
        // Re-check immediately before creating: the debounced indicator can be
        // stale, and two people can race between keystroke and submit.
        try {
          if (await window.pfUsernameTaken(handle)) return fail("That username is taken.");
        } catch (_) { /* rules may block the read; the claim below is the real gate */ }

        const cred = await window.auth.createUserWithEmailAndPassword(mail, password);
        const uid = cred.user.uid;

        let photoURL = null;
        if (photoBlob) {
          // Deliberately non-blocking: the account already exists by this point,
          // so failing the whole signup over a photo would be worse. But don't
          // drop it silently — stash the reason so Edit Profile can say why the
          // photo never appeared.
          try { photoURL = await window.pfUploadAvatar(uid, photoBlob); }
          catch (e3) {
            console.warn("[auth] avatar upload failed:", e3.code || e3.message);
            window.pfNoteAvatarFailure(e3.message);
          }
        }
        // Claim transactionally so simultaneous signups can't both take it.
        try { await window.pfClaimUsername(uid, handle, null); }
        catch (e4) { console.warn("[auth] username reservation failed:", e4.code || e4.message); }

        try { await cred.user.updateProfile({ displayName: handle, photoURL: photoURL || null }); } catch (_) {}
        await window.db.collection("users").doc(uid).set({
          username: handle,
          fullName: fullName.trim(),
          photoURL: photoURL,
          email: mail,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          role: "trader",
        });
      } else {
        await window.auth.signInWithEmailAndPassword(mail, password);
      }
      // the gate watches the auth transition and runs the vault-door sequence;
      // leave `busy` set so the button stays in its AUTHENTICATING state right
      // up until this component fades out under the parting doors
    } catch (e2) {
      fail(auErrorText(e2));
    }
  };

  const toggleSound = () => {
    const next = !sound;
    auSetSound(next);
    setSound(next);
    if (next) auVaultSound(); // confirm audibly, and unlock the AudioContext
  };

  return (
    <div className="vault-inner">
      <button type="button" className={`vault-sound ${sound ? "on" : ""}`} onClick={toggleSound}
        title={sound ? "Sound on — click to mute" : "Sound off — click to enable"}
        aria-pressed={sound} aria-label="Toggle vault sound">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 9.5h3.2L13 5.6v12.8L8.2 14.5H5z" />
          {sound
            ? <><path d="M16.2 9.2a4 4 0 0 1 0 5.6" /><path d="M18.6 6.8a7.5 7.5 0 0 1 0 10.4" /></>
            : <><path d="M16.5 10l4 4" /><path d="M20.5 10l-4 4" /></>}
        </svg>
      </button>

      <header className="vault-head">
        {/* The artwork carries the "Heat Gauge" wordmark itself, so the old
            decrypt <h1> would print the name twice. The title is kept in the
            DOM for screen readers and search, visually hidden. */}
        <div className="vault-logo" aria-hidden="true">
          <img src="src/logo-mark.png?v=46" alt="" draggable="false" />
        </div>
        <h1 className="vault-title vault-title-sr">THE HEAT GAUGE</h1>
        <p className="vault-sub">
          <AuthDecrypt text="PROFESSIONAL MOMENTUM ANALYSIS" delay={900} speed={16} />
        </p>
      </header>

      <form className={`vault-card ${shake ? "shake" : ""} ${err ? "errored" : ""}`} onSubmit={submit}>
        {/* border traced by a scaled SVG rect so the stroke stays 1px */}
        <svg className="vault-trace" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0.5" y="0.5" width="99" height="99" pathLength="100" vectorEffect="non-scaling-stroke" />
        </svg>

        <div className="vault-card-head">
          <span className="vault-card-title">{isSignup ? "REGISTER ACCESS" : "SECURE ACCESS"}</span>
          <span className="vault-card-dot" />
        </div>

        {isSignup && (
          <>
            <window.PhotoPicker preview={photoPreview} busy={busy}
              onPick={async (file) => {
                setErr("");
                try {
                  const blob = await window.pfCompressAvatar(file);
                  setPhotoBlob(blob);
                  setPhotoPreview(URL.createObjectURL(blob));
                } catch (e2) { setErr(e2.message); }
              }}
              onClear={() => { setPhotoBlob(null); setPhotoPreview(null); }} />
            <window.PfUsernameField value={username} onChange={setUsername} disabled={busy} />
            <label className="vault-field">
              <span>Full name <i>optional</i></span>
              <input type="text" value={fullName} autoComplete="name" placeholder="Jack Walker"
                onChange={(e) => setFullName(e.target.value)} disabled={busy} />
            </label>
          </>
        )}

        <label className="vault-field">
          <span>Email</span>
          <input type="email" value={email} autoComplete="email" placeholder="you@desk.com"
            onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </label>

        <label className="vault-field">
          <span>Password</span>
          <input type="password" value={password} placeholder="••••••••"
            autoComplete={isSignup ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </label>

        {isSignup && (
          <label className="vault-field">
            <span>Confirm password</span>
            <input type="password" value={confirm} autoComplete="new-password" placeholder="••••••••"
              onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
          </label>
        )}

        <button type="submit" className={`vault-submit ${busy ? "busy" : ""}`} disabled={busy}>
          <span className="vault-submit-label">
            {busy ? "AUTHENTICATING…" : (isSignup ? "CREATE ACCOUNT" : "SIGN IN")}
          </span>
          {busy && <span className="vault-submit-bar" aria-hidden="true" />}
        </button>

        {err && <p className="vault-error" role="alert">{err}</p>}

        <p className="vault-toggle">
          {isSignup ? "Already have access?" : "No account?"}
          <button type="button" onClick={() => swap(isSignup ? "signin" : "signup")} disabled={busy}>
            {isSignup ? "Sign in" : "Create Account"}
          </button>
        </p>
      </form>

      <p className="vault-foot">THE HEAT GAUGE · MOMENTUM DESK</p>
    </div>
  );
}
// ── header user chip + dropdown ────────────────────────────────────
function AuthUserMenu({ user, profile }) {
  const [open, setOpen] = useState_Au(false);
  const [busy, setBusy] = useState_Au(false);
  const [editing, setEditing] = useState_Au(false);
  const wrapRef = useRef_Au(null);

  // live profile wins over the snapshot passed down, so an edit shows instantly
  const live = window.pfUseProfile(user ? user.uid : null);
  const p = live || profile;
  const email = (user && user.email) || "";
  const handle = window.pfHandle(p, email);
  const fullName = (p && p.fullName) || "";

  useEffect_Au(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signOut = async () => {
    setBusy(true);
    try { await window.auth.signOut(); } catch (e) { console.warn("[auth] sign out:", e); setBusy(false); }
  };

  return (
    <div className="user-chip-wrap" ref={wrapRef}>
      <button className={`user-chip ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu" aria-expanded={open} title={`${handle}${fullName ? " · " + fullName : ""} · ${email}`}>
        <window.Avatar uid={user && user.uid} fallback={p} email={email} size={26} />
        <span className="user-chip-name">{handle}</span>
        <span className="user-chip-chev">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head">
            <window.Avatar uid={user && user.uid} fallback={p} email={email} size={38} />
            <div className="user-menu-id">
              <span className="user-menu-name">{handle}</span>
              {fullName && <span className="user-menu-full">{fullName}</span>}
              <span className="user-menu-email">{email}</span>
            </div>
          </div>
          <button className="user-editprofile" role="menuitem"
            onClick={() => { setOpen(false); setEditing(true); }}>
            Edit Profile
          </button>
          <button className="user-signout" onClick={signOut} disabled={busy} role="menuitem">
            {busy ? "Signing out…" : "Sign Out"}
          </button>
        </div>
      )}

      {editing && (
        <window.EditProfileModal user={user} profile={p} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

// ── gate ───────────────────────────────────────────────────────────
// Drives the vault sequence. The dashboard mounts as soon as Firebase reports a
// user; the door overlay stays on top until the panels finish sliding apart, so
// the reveal is of real content rather than a cross-fade.
const AU_OPEN_MS = 1150;
const AU_CLOSE_MS = 900;

function VaultDoors({ phase }) {
  // Each door holds a full-viewport canvas anchored to its outer edge, so the
  // two together show one continuous scene across the seam. GridScan renders
  // once into the left canvas and blits to the right — the corridor stays
  // unbroken while the doors can still part independently.
  const leftRef = useRef_Au(null);
  const rightRef = useRef_Au(null);

  useEffect_Au(() => {
    if (!window.GridScan || !leftRef.current || !rightRef.current) return;
    // Prop names match the React Bits <GridScan /> API.
    const fx = window.GridScan.mount([leftRef.current, rightRef.current], {
      sensitivity: 0.55,
      lineThickness: 1,
      linesColor: "#ff4500",
      gridScale: 0.1,
      scanColor: "#ff9a4d",
      scanOpacity: 0.55,
      enablePost: true,
      bloomIntensity: 0.85,
      chromaticAberration: 0.0022,
      noiseIntensity: 0.012,
      lineJitter: 0.06,
      scanGlow: 0.5,
      scanSoftness: 2,
      scanDuration: 2.6,
      scanDelay: 1.6,
    });
    return () => fx.destroy();
  }, []);

  return (
    <>
      <div className="vault-door left"><canvas className="vault-grid" ref={leftRef} /></div>
      <div className="vault-door right"><canvas className="vault-grid" ref={rightRef} /></div>
      <span className={`vault-seam ${phase === "opening" ? "parting" : ""}`} />
    </>
  );
}

function AuthGate({ children }) {
  const auth = auUseAuth();
  const [phase, setPhase] = useState_Au("locked"); // locked | opening | open | closing
  const prevStatus = useRef_Au(auth.status);
  // Phase is mirrored into a ref so the effect below can branch on it WITHOUT
  // listing it as a dependency — if it were a dep, setting the phase would
  // re-run the effect and its cleanup would cancel the timer it just armed.
  const phaseRef = useRef_Au("locked");
  const advance = (next) => { phaseRef.current = next; setPhase(next); };

  // The gate drives the whole sequence off the auth transition. Doing it from a
  // callback in the landing races this effect — auth flips first, and the
  // overlay would unmount before the doors ever moved.
  useEffect_Au(() => {
    const was = prevStatus.current;
    prevStatus.current = auth.status;
    let timer = 0;

    if (auth.status === "in" && phaseRef.current === "locked") {
      advance("opening");
      auVaultSound();
      timer = window.setTimeout(() => advance("open"), AU_OPEN_MS);
    } else if (was === "in" && auth.status === "out") {
      advance("closing");
      auVaultSound();
      timer = window.setTimeout(() => advance("locked"), AU_CLOSE_MS);
    }
    return () => { if (timer) window.clearTimeout(timer); };
  }, [auth.status]);

  if (auth.status === "loading") {
    return (
      <div className="vault locked booting">
        <VaultDoors phase="locked" />
        <div className="vault-inner"><span className="vault-boot" /></div>
      </div>
    );
  }

  const authed = auth.status === "in";
  // Published for the leaf components (chart zone, notes) that sit several
  // levels below App — they only mount inside the gate, and signing out
  // unmounts them wholesale.
  window.__hgAuth = authed ? { user: auth.user, profile: auth.profile } : null;

  // The overlay only leaves once the doors have finished travelling, so the
  // reveal shows real dashboard content rather than a cross-fade.
  return (
    <>
      {authed && <div className="app-under">{children(auth)}</div>}
      {phase !== "open" && (
        <div className={`vault ${phase}`}>
          <VaultDoors phase={phase} />
          {/* kept mounted through `opening` so the CSS can fade it out under
              the parting doors */}
          <AuthLanding />
        </div>
      )}
    </>
  );
}
function auCurrent() { return window.__hgAuth || { user: null, profile: null }; }

Object.assign(window, {
  AuthGate, AuthLanding, AuthUserMenu, auUseAuth, auCurrent, AuthDecrypt,
  auInitials, auDisplayName, auErrorText, auSoundOn, auSetSound, auVaultSound,
});
