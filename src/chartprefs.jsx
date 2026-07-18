// Chart preferences — user defaults for the TradingView charts embedded in the
// runner detail rows. Persisted to localStorage and applied to every chart.
//
// NOTE on identifiers: these scripts share one global namespace (Babel emits
// `var` at top level), so everything here is prefixed `cp`/`CP` to stay unique.

const CP_KEY = "hg2:chartPrefs";

const CP_DEFAULTS = {
  timeframe: "3M",      // 1D | 5D | 1M | 3M | 1Y  (fallback when no runner date)
  chartType: "candles", // candles | bars | line
  showVolume: true,
  extendedHours: false,
  ema9: false,
  ema20: false,
  ema50: false,
  ema200: false,
  vwap: false,
  // indicator colors
  vwapColor: "#2962FF",   // blue
  ema9Color: "#FF9800",   // orange
  ema20Color: "#FFEB3B",  // yellow
  ema50Color: "#FFFFFF",  // white
  ema200Color: "#4CAF50", // green
};

const CP_TIMEFRAMES = [
  { key: "1D", label: "1D", range: "1D", interval: "5" },
  { key: "5D", label: "5D", range: "5D", interval: "30" },
  { key: "1M", label: "1M", range: "1M", interval: "D" },
  { key: "3M", label: "3M", range: "3M", interval: "D" },
  { key: "1Y", label: "1Y", range: "12M", interval: "D" },
];
const CP_CHART_TYPES = [
  { key: "candles", label: "Candles", style: "1" },
  { key: "bars",    label: "Bars",    style: "0" },
  { key: "line",    label: "Line",    style: "2" },
];

// Indicator definitions — toggle key + color key + TradingView study id/length.
const CP_INDICATORS = [
  { key: "ema9",   colorKey: "ema9Color",   label: "EMA 9",   study: "MAExp@tv-basicstudies", length: 9 },
  { key: "ema20",  colorKey: "ema20Color",  label: "EMA 20",  study: "MAExp@tv-basicstudies", length: 20 },
  { key: "ema50",  colorKey: "ema50Color",  label: "EMA 50",  study: "MAExp@tv-basicstudies", length: 50 },
  { key: "ema200", colorKey: "ema200Color", label: "EMA 200", study: "MAExp@tv-basicstudies", length: 200 },
  { key: "vwap",   colorKey: "vwapColor",   label: "VWAP",    study: "VWAP@tv-basicstudies" },
];

function cpLoad() {
  try {
    const raw = window.localStorage.getItem(CP_KEY);
    return raw ? { ...CP_DEFAULTS, ...JSON.parse(raw) } : { ...CP_DEFAULTS };
  } catch (_) { return { ...CP_DEFAULTS }; }
}
function cpSave(prefs) {
  const next = { ...CP_DEFAULTS, ...prefs };
  try { window.localStorage.setItem(CP_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}
function cpReset() {
  try { window.localStorage.removeItem(CP_KEY); } catch (_) {}
  return { ...CP_DEFAULTS };
}

// The free embed has no "jump to date" parameter (verified — `date`/`to`/`time`
// are ignored). The best we can do is widen the range so the runner's trading
// day actually falls inside the visible window.
function cpRangeForDate(iso) {
  if (!iso) return null;
  const then = new Date(iso + "T00:00:00");
  const now = new Date();
  const days = Math.max(0, Math.round((now - then) / 86400000));
  if (days <= 4) return "5D";
  if (days <= 25) return "1M";
  if (days <= 80) return "3M";
  if (days <= 170) return "6M";
  if (days <= 350) return "12M";
  if (days <= 1800) return "60M";
  return "ALL";
}

// Config for the TradingView Advanced Chart widget (tv.js). Unlike the raw
// iframe, this one honors studies_overrides, which is what makes the color
// settings actually take effect.
function cpWidgetConfig(symbol, containerId, dateISO, prefsIn) {
  const p = prefsIn || cpLoad();
  const tf = CP_TIMEFRAMES.find((t) => t.key === p.timeframe) || CP_TIMEFRAMES[3];
  const ct = CP_CHART_TYPES.find((t) => t.key === p.chartType) || CP_CHART_TYPES[0];
  const range = cpRangeForDate(dateISO) || tf.range;

  const studies = [];
  const overrides = {};
  const enabledEmas = CP_INDICATORS.filter((i) => i.key !== "vwap" && p[i.key]);
  for (const ind of enabledEmas) studies.push(ind.study);
  if (p.vwap) studies.push("VWAP@tv-basicstudies");

  // studies_overrides apply per study TYPE, so all EMA plots share one color /
  // length. Use the first enabled EMA's settings as the shared value.
  if (enabledEmas.length) {
    overrides["moving average exponential.plot.color"] = p[enabledEmas[0].colorKey];
    overrides["moving average exponential.length"] = enabledEmas[0].length;
  }
  if (p.vwap) overrides["vwap.plot.color"] = p.vwapColor;

  return {
    container_id: containerId,
    symbol: String(symbol || "").toUpperCase(),
    interval: tf.interval,
    range,
    theme: "dark",
    style: ct.style,
    timezone: "America/New_York",
    locale: "en",
    autosize: true,
    hide_side_toolbar: true,
    allow_symbol_change: false,
    save_image: false,
    hide_volume: !p.showVolume,
    withdateranges: true,
    extended_hours: !!p.extendedHours,
    studies,
    studies_overrides: overrides,
  };
}

Object.assign(window, {
  CP_KEY, CP_DEFAULTS, CP_TIMEFRAMES, CP_CHART_TYPES, CP_INDICATORS,
  cpLoad, cpSave, cpReset, cpRangeForDate, cpWidgetConfig,
});
