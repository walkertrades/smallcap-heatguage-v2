// Chart screenshots — shared across the whole desk.
//
// Image bytes live in Firebase Storage at charts/{TICKER}-{date}-{uid}.png; the
// pointer lives in Firestore at charts/{TICKER}-{date} (one doc per ticker+date,
// so a re-upload by anyone replaces what everybody sees). The doc is watched
// with onSnapshot, so the SAME tile in the Playbook and in the Top Movers detail
// both show whatever was uploaded last, live.
//
// Identifiers are prefixed `sh`/`SH` to stay unique in the shared global scope.

const SH_MAX_W = 1600;        // downscale before upload — screenshots are often huge
const SH_MAX_BYTES = 10 * 1024 * 1024;

function shDocId(sym, date) { return `${String(sym).toUpperCase()}-${date}`; }
function shDoc(sym, date) { return window.db.collection("charts").doc(shDocId(sym, date)); }
function shStoragePath(sym, date, uid) { return `charts/${shDocId(sym, date)}-${uid}.png`; }

// Read a File, downscale it, hand back a PNG Blob.
function shFileToBlob(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error("That isn't an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Could not decode that image."));
      img.onload = () => {
        const scale = Math.min(1, SH_MAX_W / (img.width || SH_MAX_W));
        const w = Math.max(1, Math.round((img.width || SH_MAX_W) * scale));
        const h = Math.max(1, Math.round((img.height || 400) * scale));
        const cv = window.document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        cv.toBlob((blob) => {
          if (!blob) return reject(new Error("Could not encode that image."));
          if (blob.size > SH_MAX_BYTES) return reject(new Error("Image is too large (10MB max)."));
          resolve(blob);
        }, "image/png");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function shFmtDate(ts) {
  return window.ntStamp ? window.ntStamp(ts) : "";
}

// Live handle for whoever uploaded, so a rename updates old chart credits too.
function ShotUploader({ uid, fallback }) {
  const live = window.pfUseProfile(uid);
  const name = (live && live.username) || fallback || "a trader";
  return <>{"@" + String(name).replace(/^@+/, "")}</>;
}

// Fullscreen viewer for an uploaded shot.
function ShotLightbox({ src, label, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!src) return null;
  return (
    <div className="shot-lightbox" onClick={onClose}>
      <div className="shot-lightbox-bar">
        <span>{label}</span>
        <button className="shot-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <img src={src} alt={label} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// Drop/click upload zone backed by Firebase. Shows whatever the desk uploaded last.
function ShotZone({ date, sym, compact, user, onChange }) {
  const [shot, setShot] = React.useState(null);   // { url, uploaderName, uploaderUid, updatedAt }
  const [err, setErr] = React.useState("");
  const [over, setOver] = React.useState(false);
  const [zoom, setZoom] = React.useState(false);
  const [pct, setPct] = React.useState(-1);       // -1 idle, 0..100 uploading
  const inputRef = React.useRef(null);

  const me = user || window.auCurrent().user
    || (window.auth && window.auth.currentUser) || null;
  const uid = me ? me.uid : null;
  // live profile, so the credit we denormalise is the current handle rather
  // than whatever auCurrent() happened to be holding
  const liveMe = window.pfUseProfile(uid);

  // live-subscribe to this ticker+date's chart doc
  React.useEffect(() => {
    if (!window.fbReady || !date || !sym) return;
    let cancelled = false;
    const unsub = shDoc(sym, date).onSnapshot(
      (snap) => {
        if (cancelled) return;
        setShot(snap.exists ? snap.data() : null);
      },
      (e) => { if (!cancelled) console.warn("[shots] listener:", e.message); },
    );
    return () => { cancelled = true; unsub(); };
  }, [date, sym]);

  const accept = async (file) => {
    setErr("");
    if (!uid) { setErr("Sign in to upload charts."); return; }
    let blob;
    try { blob = await shFileToBlob(file); }
    catch (e) { setErr(e.message); return; }

    setPct(0);
    const prof = liveMe || window.auCurrent().profile;
    try {
      const path = shStoragePath(sym, date, uid);
      const task = window.storage.ref(path).put(blob, { contentType: "image/png" });
      await new Promise((resolve, reject) => {
        task.on("state_changed",
          (s) => setPct(Math.round((s.bytesTransferred / (s.totalBytes || 1)) * 100)),
          reject,
          resolve);
      });
      const url = await task.snapshot.ref.getDownloadURL();
      await shDoc(sym, date).set({
        url,
        storagePath: path,
        ticker: String(sym).toUpperCase(),
        date,
        uploaderUid: uid,
        uploaderName: window.auDisplayName(me, prof),
        uploaderUsername: (prof && prof.username) || window.auDisplayName(me, prof),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      // onSnapshot paints it; no local set needed
      if (onChange) onChange(url);
    } catch (e) {
      console.warn("[shots] upload:", e);
      setErr(e.code === "storage/unauthorized"
        ? "Storage rules rejected the upload."
        : (e.message || "Upload failed."));
    }
    setPct(-1);
  };

  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) accept(f);
  };

  const remove = async (e) => {
    e.stopPropagation();
    if (!shot || !uid || shot.uploaderUid !== uid) return;
    try {
      if (shot.storagePath) {
        try { await window.storage.ref(shot.storagePath).delete(); } catch (_) {}
      }
      await shDoc(sym, date).delete();
      if (onChange) onChange(null);
    } catch (e2) {
      setErr("Could not remove that chart.");
    }
  };

  const label = `${sym} · ${date}`;
  const mine = !!(shot && uid && shot.uploaderUid === uid);

  if (shot && shot.url) {
    return (
      <>
        <div className={`shot-has ${compact ? "compact" : ""}`}>
          <img src={shot.url} alt={label} onClick={(e) => { e.stopPropagation(); setZoom(true); }} />
          {mine && <button className="shot-remove" onClick={remove} title="Remove screenshot">×</button>}
        </div>
        <div className="shot-credit">
          Uploaded by <b><ShotUploader uid={shot.uploaderUid} fallback={shot.uploaderUsername || shot.uploaderName} /></b>
          {" · "}{shFmtDate(shot.updatedAt)}
        </div>
        {zoom && <ShotLightbox src={shot.url} label={label} onClose={() => setZoom(false)} />}
      </>
    );
  }

  if (pct >= 0) {
    return (
      <div className={`shot-zone uploading ${compact ? "compact" : ""}`}>
        <span className="shot-zone-txt">Uploading… {pct}%</span>
        <div className="shot-progress"><div className="shot-progress-fill" style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }

  return (
    <div
      className={`shot-zone ${compact ? "compact" : ""} ${over ? "over" : ""}`}
      onClick={(e) => { e.stopPropagation(); inputRef.current && inputRef.current.click(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      role="button"
    >
      <span className="shot-zone-ic">⬆</span>
      <span className="shot-zone-txt">Drop chart screenshot or click to upload</span>
      {err && <span className="shot-zone-err">{err}</span>}
      <input ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) accept(f); e.target.value = ""; }} />
    </div>
  );
}

Object.assign(window, {
  ShotZone, ShotLightbox, shFileToBlob, shDocId, shStoragePath,
});
