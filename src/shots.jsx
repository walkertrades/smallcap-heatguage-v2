// Chart screenshots — user-uploaded images stored as base64 in localStorage,
// keyed by ticker + date so the SAME image shows in both the Playbook tile and
// the Top Movers expanded detail.
//
// Identifiers are prefixed `sh`/`SH` to stay unique in the shared global scope.

const SH_KEY = "hg2:chartShots";
const SH_MAX_W = 1400;      // downscale before storing — localStorage is ~5MB total
const SH_QUALITY = 0.82;

function shKey(date, sym) { return `${date}::${sym}`; }
function shLoadAll() {
  try {
    const raw = window.localStorage.getItem(SH_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function shGet(date, sym) {
  const m = shLoadAll();
  return m[shKey(date, sym)] || null;
}
function shSet(date, sym, dataUrl) {
  const m = shLoadAll();
  const k = shKey(date, sym);
  if (!dataUrl) delete m[k];
  else m[k] = dataUrl;
  try {
    window.localStorage.setItem(SH_KEY, JSON.stringify(m));
  } catch (e) {
    // quota exceeded — surface it rather than failing silently
    return { ok: false, error: "Storage full — remove some screenshots first." };
  }
  return { ok: true };
}
function shCount() { return Object.keys(shLoadAll()).length; }

// Read a File, downscale it, return a JPEG data URL.
function shFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error("Not an image file"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.onload = () => {
        const scale = Math.min(1, SH_MAX_W / (img.width || SH_MAX_W));
        const w = Math.max(1, Math.round((img.width || SH_MAX_W) * scale));
        const h = Math.max(1, Math.round((img.height || 400) * scale));
        const cv = window.document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(cv.toDataURL("image/jpeg", SH_QUALITY)); }
        catch (e) { reject(new Error("Could not encode image")); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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

// Drop/click upload zone. Shows the stored image once one exists.
function ShotZone({ date, sym, compact, onChange }) {
  const [src, setSrc] = React.useState(() => shGet(date, sym));
  const [err, setErr] = React.useState("");
  const [over, setOver] = React.useState(false);
  const [zoom, setZoom] = React.useState(false);
  const inputRef = React.useRef(null);

  React.useEffect(() => { setSrc(shGet(date, sym)); }, [date, sym]);

  const accept = async (file) => {
    setErr("");
    try {
      const url = await shFileToDataUrl(file);
      const res = shSet(date, sym, url);
      if (!res.ok) { setErr(res.error); return; }
      setSrc(url);
      if (onChange) onChange(url);
    } catch (e) { setErr(e.message || "Upload failed"); }
  };
  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) accept(f);
  };
  const remove = (e) => {
    e.stopPropagation();
    shSet(date, sym, null);
    setSrc(null);
    if (onChange) onChange(null);
  };

  const label = `${sym} · ${date}`;
  if (src) {
    return (
      <>
        <div className={`shot-has ${compact ? "compact" : ""}`}>
          <img src={src} alt={label} onClick={(e) => { e.stopPropagation(); setZoom(true); }} />
          <button className="shot-remove" onClick={remove} title="Remove screenshot">×</button>
        </div>
        {zoom && <ShotLightbox src={src} label={label} onClose={() => setZoom(false)} />}
      </>
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
  SH_KEY, shGet, shSet, shCount, shFileToDataUrl, ShotZone, ShotLightbox,
});
