// Chart screenshots — four timeframes per runner, shared across the whole desk.
//
// WHY FOUR SLOTS
// TradingView's embed can't show a historical intraday chart, so the only way
// to see how a day actually looked is a frozen image. Manual upload is the
// fallback for days the evening script doesn't run, and it is the ONLY
// fallback — there is no code-generated alternative — so it has to be solid.
//
// STORAGE
//   charts/{TICKER}-{date}      manual bundle, up to 4 timeframes  (this file writes)
//   chartsAuto/{TICKER}-{date}  pipeline bundle, up to 4           (Admin SDK only, read-only here)
//
// Two collections rather than one document on purpose: the pipeline writes with
// the Firebase Admin SDK, which BYPASSES security rules entirely. A rule saying
// "the pipeline may not touch manual slots" would be enforced against the
// browser and not against the pipeline — security theatre. Separate collections
// make it structural: a rules-bypassing write physically cannot reach manual
// data because it addresses a different document.
//
// RESOLUTION, per timeframe: manual[tf] ?? auto[tf] ?? null. Manual always
// holds primary; a later manual upload always takes it back.
//
// Identifiers are prefixed `sh`/`SH` to stay unique in the shared global scope.

const SH_MAX_W = 1600;        // downscale before upload — screenshots are often huge
const SH_MAX_BYTES = 10 * 1024 * 1024;

// Fixed display order. The SLOT decides the label, never the upload order — so
// dropping the daily first still files it under Daily and the cycler still runs
// 1m → 5m → 15m → Daily. A chart can never end up mislabelled.
const SH_TIMEFRAMES = [
  { key: "1m",  label: "1m" },
  { key: "5m",  label: "5m" },
  { key: "15m", label: "15m" },
  { key: "1D",  label: "Daily" },
];
const SH_TF_KEYS = SH_TIMEFRAMES.map((t) => t.key);
function shTfLabel(key) {
  if (key === "legacy") return "Chart (legacy)";
  const t = SH_TIMEFRAMES.find((x) => x.key === key);
  return t ? t.label : key;
}

function shDocId(sym, date) { return `${String(sym).toUpperCase()}-${date}`; }
function shDoc(sym, date) { return window.db.collection("charts").doc(shDocId(sym, date)); }
function shAutoDoc(sym, date) { return window.db.collection("chartsAuto").doc(shDocId(sym, date)); }
function shStoragePath(sym, date, tf, uid) { return `charts/${shDocId(sym, date)}-${tf}-${uid}.png`; }

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
          blob._w = w; blob._h = h;
          resolve(blob);
        }, "image/png");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function shFmtDate(ts) { return window.ntStamp ? window.ntStamp(ts) : ""; }

// Live handle for whoever uploaded, so a rename updates old chart credits too.
function ShotUploader({ uid, fallback }) {
  const live = window.pfUseProfile(uid);
  const name = (live && live.username) || fallback || "a trader";
  return <>{"@" + String(name).replace(/^@+/, "")}</>;
}

// ── Store ──────────────────────────────────────────────────────────
// Subscribes to BOTH docs and resolves them into one slot map.
function shUseCharts(sym, date) {
  const [manual, setManual] = React.useState(null);
  const [auto, setAuto] = React.useState(null);

  React.useEffect(() => {
    if (!window.fbReady || !date || !sym) return;
    let dead = false;
    const unsubs = [
      shDoc(sym, date).onSnapshot(
        (s) => { if (!dead) setManual(s.exists ? s.data() : null); },
        (e) => { if (!dead) console.warn("[shots] manual:", e.message); }),
      shAutoDoc(sym, date).onSnapshot(
        (s) => { if (!dead) setAuto(s.exists ? s.data() : null); },
        (e) => { if (!dead) console.warn("[shots] auto:", e.message); }),
    ];
    return () => { dead = true; unsubs.forEach((u) => u()); };
  }, [sym, date]);

  return React.useMemo(() => {
    const m = (manual && manual.manual) || {};
    const a = (auto && auto.auto) || {};
    // Docs written before the four-slot restructure carry a flat top-level url.
    // Those are multi-pane thinkorswim layouts, NOT 1m charts, so they get their
    // own first slot rather than being mislabelled into 1m. Read-time compat
    // only — no migration job, and it disappears once real slots are filled.
    const legacy = (manual && manual.url && !manual.manual)
      ? { url: manual.url, storagePath: manual.storagePath,
          uploaderUid: manual.uploaderUid,
          uploaderUsername: manual.uploaderUsername || manual.uploaderName,
          updatedAt: manual.updatedAt, source: "legacy" }
      : null;
    const slots = {};
    for (const tf of SH_TF_KEYS) {
      if (m[tf]) slots[tf] = Object.assign({}, m[tf], { source: "manual" });
      else if (a[tf]) slots[tf] = Object.assign({}, a[tf], { source: "auto" });
      else slots[tf] = null;
    }
    // The cycler walks only FILLED slots, so a missing timeframe is skipped
    // entirely rather than showing a broken image or a dead arrow.
    const filled = (legacy ? ["legacy"] : []).concat(SH_TF_KEYS.filter((k) => slots[k]));
    return { slots, legacy, filled, hasAny: filled.length > 0, raw: manual };
  }, [manual, auto]);
}

function shGet(charts, key) {
  return key === "legacy" ? charts.legacy : charts.slots[key];
}

// ── Upload / delete ────────────────────────────────────────────────
async function shUpload(sym, date, tf, file, me, prof, onPct) {
  const blob = await shFileToBlob(file);
  const uid = me.uid;
  const path = shStoragePath(sym, date, tf, uid);
  const task = window.storage.ref(path).put(blob, { contentType: "image/png" });
  await new Promise((resolve, reject) => {
    task.on("state_changed",
      (s) => onPct && onPct(Math.round((s.bytesTransferred / (s.totalBytes || 1)) * 100)),
      reject, resolve);
  });
  const url = await task.snapshot.ref.getDownloadURL();
  const patch = {
    ticker: String(sym).toUpperCase(),
    date,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  patch[`manual.${tf}`] = {
    url, storagePath: path,
    uploaderUid: uid,
    uploaderUsername: (prof && prof.username) || window.auDisplayName(me, prof),
    width: blob._w || null, height: blob._h || null, bytes: blob.size,
    updatedAt: new Date().toISOString(),
  };
  await shDoc(sym, date).set(patch, { merge: true });
}

async function shRemove(sym, date, tf, slot) {
  if (slot && slot.storagePath) {
    try { await window.storage.ref(slot.storagePath).delete(); } catch (_) {}
  }
  if (tf === "legacy") {
    await shDoc(sym, date).set({
      url: firebase.firestore.FieldValue.delete(),
      storagePath: firebase.firestore.FieldValue.delete(),
    }, { merge: true });
    return;
  }
  const patch = {};
  patch[`manual.${tf}`] = firebase.firestore.FieldValue.delete();
  await shDoc(sym, date).set(patch, { merge: true });
}

// ── One drop slot ──────────────────────────────────────────────────
// Empty slots show their label in grey placeholder text so the target is
// unambiguous BEFORE anything is dropped. Filled slots stay droppable so a
// chart can be replaced in place.
function ShotSlot({ sym, date, tf, slot, canEdit, onOpen }) {
  const [over, setOver] = React.useState(false);
  const [pct, setPct] = React.useState(-1);
  const [err, setErr] = React.useState("");
  const inputRef = React.useRef(null);
  const me = window.auCurrent().user || (window.auth && window.auth.currentUser) || null;
  const liveMe = window.pfUseProfile(me ? me.uid : null);

  const accept = async (file) => {
    setErr("");
    if (!me) { setErr("Sign in to upload."); return; }
    // Replacing loses whatever was there — including an annotated chart — so it
    // asks first.
    if (slot && !window.confirm(
      `Replace the ${shTfLabel(tf)} chart for ${String(sym).toUpperCase()}?\n\nThe current image will be deleted.`)) return;
    setPct(0);
    try {
      await shUpload(sym, date, tf, file, me, liveMe || window.auCurrent().profile, setPct);
    } catch (e) {
      setErr(e.code === "storage/unauthorized" ? "Storage rules rejected the upload." : (e.message || "Upload failed."));
    }
    setPct(-1);
  };

  if (pct >= 0) {
    return (
      <div className="sh-slot uploading">
        <span className="sh-slot-lbl">{shTfLabel(tf)}</span>
        <span className="sh-slot-txt">Uploading… {pct}%</span>
        <div className="shot-progress"><div className="shot-progress-fill" style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }

  return (
    <div className={`sh-slot ${slot ? "filled" : "empty"} ${over ? "over" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (slot && onOpen) onOpen(tf);
        else if (canEdit) inputRef.current && inputRef.current.click();
      }}
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault(); e.stopPropagation(); setOver(false);
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) accept(f);
      }}
      role="button" title={slot ? `${shTfLabel(tf)} — click to view` : `Drop a ${shTfLabel(tf)} chart`}>
      {slot ? (
        <>
          <img src={slot.url} alt={shTfLabel(tf)} />
          <span className="sh-slot-tag">{shTfLabel(tf)}</span>
          {slot.source === "auto" && <span className="sh-auto-badge" title="Generated by the evening pipeline">auto</span>}
          {canEdit && (
            <button className="sh-slot-x" title="Remove this chart"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Remove the ${shTfLabel(tf)} chart?`)) shRemove(sym, date, tf, slot);
              }}>×</button>
          )}
          {canEdit && (
            <button className="sh-slot-swap" title="Replace this chart"
              onClick={(e) => { e.stopPropagation(); inputRef.current && inputRef.current.click(); }}>replace</button>
          )}
        </>
      ) : (
        <>
          <span className="sh-slot-lbl">{shTfLabel(tf)}</span>
          <span className="sh-slot-txt">{canEdit ? "drop or click" : "empty"}</span>
        </>
      )}
      {err && <span className="sh-slot-err">{err}</span>}
      <input ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) accept(f); e.target.value = ""; }} />
    </div>
  );
}

// ── The four-slot grid ─────────────────────────────────────────────
function ShotSlots({ sym, date, charts, onOpen }) {
  return (
    <div className="sh-slots">
      {charts.legacy && (
        <ShotSlot sym={sym} date={date} tf="legacy" slot={charts.legacy} canEdit onOpen={onOpen} />
      )}
      {SH_TIMEFRAMES.map((t) => (
        <ShotSlot key={t.key} sym={sym} date={date} tf={t.key}
          slot={charts.slots[t.key]} canEdit onOpen={onOpen} />
      ))}
    </div>
  );
}

// ── Fullscreen viewer with the timeframe cycler ────────────────────
// Arrow pattern from the X/Twitter viewer, WITHOUT the peek-at-the-next-image
// behaviour: one chart fills the frame, no sliver of the neighbour.
function ChartViewer({ sym, date, charts, startTf, onClose }) {
  const seq = charts.filled;
  const [manage, setManage] = React.useState(!charts.hasAny);
  const [idx, setIdx] = React.useState(() => {
    const i = seq.indexOf(startTf);
    return i >= 0 ? i : 0;   // opens on 1m when present, else the lowest filled
  });

  const safeIdx = Math.max(0, Math.min(seq.length - 1, idx));
  const curKey = seq[safeIdx];
  const cur = curKey ? shGet(charts, curKey) : null;

  // Preload the neighbours so switching is instant with no loading flash.
  React.useEffect(() => {
    [safeIdx - 1, safeIdx + 1].forEach((i) => {
      const k = seq[i];
      const s = k && shGet(charts, k);
      if (s && s.url) { const im = new window.Image(); im.src = s.url; }
    });
  }, [safeIdx, seq, charts]);

  // Left/right scoped to the modal. Capture phase + stopPropagation so they can
  // never reach the day selector or any other page-level handler underneath —
  // same approach HgOverlay uses for ESC.
  React.useEffect(() => {
    if (manage) return;
    const onKey = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.stopPropagation(); e.preventDefault();
      setIdx((i) => {
        const n = e.key === "ArrowLeft" ? i - 1 : i + 1;
        return Math.max(0, Math.min(seq.length - 1, n));   // no wraparound
      });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [manage, seq.length]);

  const label = `${String(sym).toUpperCase()} · ${date}`;

  if (manage) {
    return (
      <window.HgOverlay label={`${label} · manage charts`} onClose={onClose} className="hgo-dim hgo-scroll">
        <div className="sh-manage">
          <div className="sh-manage-head">
            <span className="card-title">CHARTS · {String(sym).toUpperCase()}</span>
            {charts.hasAny && (
              <button className="sh-manage-done" onClick={() => setManage(false)}>Done</button>
            )}
          </div>
          <p className="sh-manage-hint">
            Drop an image on a slot, or click it to browse. Order is fixed by the slot —
            uploading the daily first still files it under Daily.
          </p>
          <ShotSlots sym={sym} date={date} charts={charts}
            onOpen={(tf) => { const i = seq.indexOf(tf); if (i >= 0) { setIdx(i); setManage(false); } }} />
        </div>
      </window.HgOverlay>
    );
  }

  return (
    <window.HgOverlay label={`${label} · ${shTfLabel(curKey)}`} onClose={onClose} className="hgo-view">
      <div className="sh-viewer">
        {cur && <img className="sh-viewer-img" src={cur.url} alt={shTfLabel(curKey)} />}

        {/* Arrows persist — they don't fade or wait for hover. The whole point
            is that it's immediately obvious more charts exist. Hidden at the
            ends so position in the sequence is always unambiguous. */}
        {safeIdx > 0 && (
          <button className="sh-arrow left" aria-label="Previous timeframe"
            onClick={(e) => { e.stopPropagation(); setIdx(safeIdx - 1); }}>‹</button>
        )}
        {safeIdx < seq.length - 1 && (
          <button className="sh-arrow right" aria-label="Next timeframe"
            onClick={(e) => { e.stopPropagation(); setIdx(safeIdx + 1); }}>›</button>
        )}

        <div className="sh-viewer-bar" onMouseDown={(e) => e.stopPropagation()}>
          <span className="sh-tf-name">{shTfLabel(curKey)}</span>
          <span className="sh-tf-pos">{safeIdx + 1} of {seq.length}</span>
          <span className="sh-dots">
            {seq.map((k, i) => (
              <button key={k} className={`sh-dot ${i === safeIdx ? "on" : ""}`} title={shTfLabel(k)}
                onClick={(e) => { e.stopPropagation(); setIdx(i); }} />
            ))}
          </span>
          {cur && cur.source === "auto" && <span className="sh-auto-badge">auto</span>}
          {cur && cur.uploaderUid && (
            <span className="sh-viewer-credit">
              <ShotUploader uid={cur.uploaderUid} fallback={cur.uploaderUsername} />
            </span>
          )}
          <button className="sh-manage-btn" onClick={(e) => { e.stopPropagation(); setManage(true); }}>
            manage charts
          </button>
        </div>
      </div>
    </window.HgOverlay>
  );
}

// ── The tile ───────────────────────────────────────────────────────
function ShotZone({ date, sym, compact }) {
  const charts = shUseCharts(sym, date);
  const [open, setOpen] = React.useState(null);   // null | timeframe key

  const primary = charts.filled[0] || null;
  const slot = primary ? shGet(charts, primary) : null;

  return (
    <>
      {slot ? (
        <>
          <div className={`shot-has ${compact ? "compact" : ""}`}
            onClick={(e) => { e.stopPropagation(); setOpen(primary); }}>
            <img src={slot.url} alt={`${sym} ${shTfLabel(primary)}`} />
            <span className="sh-count">
              {shTfLabel(primary)}{charts.filled.length > 1 ? ` · 1 of ${charts.filled.length}` : ""}
            </span>
            {slot.source === "auto" && <span className="sh-auto-badge">auto</span>}
          </div>
          {!compact && (
            <div className="shot-credit">
              {slot.uploaderUid && (
                <>Uploaded by <b><ShotUploader uid={slot.uploaderUid} fallback={slot.uploaderUsername} /></b>{" · "}</>
              )}
              {shFmtDate(slot.updatedAt)}
              <button className="sh-edit-link" onClick={(e) => { e.stopPropagation(); setOpen(primary); }}>
                manage charts
              </button>
            </div>
          )}
        </>
      ) : (
        <div className={`shot-zone ${compact ? "compact" : ""}`} role="button"
          onClick={(e) => { e.stopPropagation(); setOpen("1m"); }}>
          <span className="shot-zone-ic">⬆</span>
          <span className="shot-zone-txt">
            {compact ? "Add charts" : "No charts yet — click to add 1m / 5m / 15m / Daily"}
          </span>
        </div>
      )}

      {open !== null && (
        <ChartViewer sym={sym} date={date} charts={charts} startTf={open}
          onClose={() => setOpen(null)} />
      )}
    </>
  );
}

Object.assign(window, {
  ShotZone, ChartViewer, ShotSlots, ShotSlot, shUseCharts,
  shFileToBlob, shDocId, shStoragePath, shTfLabel,
  SH_TIMEFRAMES, SH_TF_KEYS,
});
