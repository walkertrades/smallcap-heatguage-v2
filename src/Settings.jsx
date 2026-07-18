// Settings page — currently hosts Chart Settings (defaults applied to every
// TradingView chart in the runner detail rows). Persisted to localStorage.
const { useState: useState_St } = React;

function SegControl({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.key} className={`seg-btn ${value === o.key ? "active" : ""}`}
          onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, label }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}
      role="switch" aria-checked={on} aria-label={label}>
      <span className="toggle-knob" />
    </button>
  );
}

function SettingRow({ label, hint, children }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function SettingsPage() {
  const [prefs, setPrefs] = useState_St(() => window.cpLoad());
  const [saved, setSaved] = useState_St(false);

  const update = (patch) => {
    const next = window.cpSave({ ...prefs, ...patch });
    setPrefs(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  };
  const reset = () => { setPrefs(window.cpReset()); setSaved(true); window.setTimeout(() => setSaved(false), 1400); };

  const tfOpts = window.CP_TIMEFRAMES.map((t) => ({ key: t.key, label: t.label }));
  const ctOpts = window.CP_CHART_TYPES.map((t) => ({ key: t.key, label: t.label }));
  const yesNo = [{ key: true, label: "Yes" }, { key: false, label: "No" }];

  return (
    <div className="settings-page">
      <div className="card settings-card">
        <div className="settings-head">
          <div>
            <div className="card-title">CHART SETTINGS</div>
            <p className="settings-sub">Defaults applied to every chart opened in a runner's detail row.</p>
          </div>
          <div className="settings-actions">
            {saved && <span className="settings-saved">Saved ✓</span>}
            <button className="settings-reset" onClick={reset}>Reset defaults</button>
          </div>
        </div>

        <SettingRow label="Default timeframe" hint="Range the chart opens at">
          <SegControl options={tfOpts} value={prefs.timeframe} onChange={(v) => update({ timeframe: v })} />
        </SettingRow>

        <SettingRow label="Default chart type" hint="Candles, bars or line">
          <SegControl options={ctOpts} value={prefs.chartType} onChange={(v) => update({ chartType: v })} />
        </SettingRow>

        <SettingRow label="Show volume" hint="Volume pane under price">
          <SegControl options={yesNo} value={prefs.showVolume} onChange={(v) => update({ showVolume: v })} />
        </SettingRow>

        <SettingRow label="Show pre / after hours" hint="Extended-hours session data">
          <SegControl options={yesNo} value={prefs.extendedHours} onChange={(v) => update({ extendedHours: v })} />
        </SettingRow>

        <div className="set-row set-row-block">
          <div className="set-row-label">
            <span>Default indicators &amp; colors</span>
            <small>Studies loaded with every chart — click a swatch to recolor</small>
          </div>
          <div className="set-indicators">
            {window.CP_INDICATORS.map((ind) => (
              <div className="set-ind" key={ind.key}>
                <label className="set-swatch" style={{ background: prefs[ind.colorKey] }}>
                  <input type="color" value={prefs[ind.colorKey]}
                    onChange={(e) => update({ [ind.colorKey]: e.target.value })} />
                </label>
                <span>{ind.label}</span>
                <Toggle on={!!prefs[ind.key]} label={ind.label} onChange={(v) => update({ [ind.key]: v })} />
              </div>
            ))}
          </div>
        </div>

        <div className="settings-note">
          Charts use TradingView's free Advanced Chart widget (no API key). Two limits of the
          free widget worth knowing: it has no "jump to date" parameter, so a runner's chart
          opens on a range wide enough to <em>include</em> its trading day rather than centered
          on it; and study overrides apply per indicator <em>type</em>, so when several EMAs are
          enabled they share the first enabled EMA's color and length.
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { SettingsPage });
