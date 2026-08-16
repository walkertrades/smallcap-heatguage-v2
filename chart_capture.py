"""
Auto chart capture — chart-img.com -> Firebase Storage -> chartsAuto/.

WHY THIS EXISTS
TradingView's embed can't show a historical intraday chart. The evening run
snapshots each runner's day at pull time so the chart is frozen as it looked and
stays viewable forever.

VALIDATED CONFIG (2026-08-15, MEGA plan). Every value below was confirmed by
rendering real charts, not read off the docs — the docs are wrong about at least
two study names:
    study names the validator accepts : Moving Average Exponential, Moving
                                        Average, VWAP, Volume
    docs claim (both REJECTED)        : Exponential Moving Average,
                                        Volume Weighted Average
    period key                        : {"length": N}
    EMA colour key                    : Plot.color
    VWAP colour key                   : VWAP.color   (NOT Plot.color)
    extended hours                    : "session": "extended"  — renders real
                                        premarket and after-hours candles
    explicit window                   : "range": {"from","to"} ISO8601, honoured
    timezone                          : "America/New_York" puts the axis in ET

!! THE FREE TIER LIES !!
On BASIC, {"length": N} was SILENTLY IGNORED — HTTP 200, a plausible-looking
chart, and every EMA rendered as period 9. Not an error, not a warning, just
wrong data that looked right. That is why the early probes were inconclusive.
Same failure shape as a NO-NEWS tag on a runner that had news. If this ever gets
run on a downgraded key, the charts will look fine and be wrong.

SAFETY
  · hard ceiling on calls per run (CHART_MAX_CALLS). A runaway loop at 15 req/s
    would eat a 1,000/day quota in about a minute; this stops the run instead.
  · bytes are validated as a real PNG of plausible size BEFORE upload. A
    silently-uploaded broken image is the worst outcome — it wouldn't be noticed
    for weeks.
  · per-ticker isolation: one failure logs and skips, never kills the run.
  · idempotent: deterministic Storage paths per (ticker, date, timeframe), so
    re-running a date replaces that date's auto charts rather than duplicating.
"""

import datetime as _dt
import io
import json
import os
import time
import urllib.error
import urllib.request

import symbols as symbols_mod

CHARTIMG_URL = "https://api.chart-img.com/v2/tradingview/advanced-chart"
CHARTIMG_KEY = os.environ.get("CHARTIMG_API_KEY", "")

# MEGA allows 15 req/s and 1,000/day. We deliberately run far under both: a
# nightly run is ~40 images and there is no reason to go fast.
CHART_REQ_INTERVAL = 0.5        # seconds between calls
CHART_MAX_CALLS = 200           # hard stop for the whole run
CHART_TIMEOUT = 90

# A real chart at 1920x1080 lands around 70-150KB. Anything under this is an
# error page, a blank canvas, or a truncated download.
CHART_MIN_BYTES = 15_000
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

WIDTH, HEIGHT = 1920, 1080

# ── Indicator spec, approved 2026-08-15 ────────────────────────────
# Colours are tuned bright on purpose: these render on a dark background at
# modal size, not full-screen on a trading monitor, where dark blue and dark
# green disappear. VWAP is deliberately heavier than the EMAs — it's the anchor,
# they're context, and at uniform weight it vanished into the cluster.
EMA_SPEC = [
    (9,   "rgb(255,235,59)"),    # bright yellow
    (20,  "rgb(255,255,255)"),   # white
    (50,  "rgb(0,176,255)"),     # electric blue
    (200, "rgb(0,230,118)"),     # bright green
]
VWAP_COLOR = "rgb(255,0,144)"    # hot magenta
SMA200_COLOR = "rgb(179,136,255)"  # purple, daily only

INTRADAY_TFS = [("1m", "1m"), ("5m", "5m"), ("15m", "15m")]
DAILY_TF = ("1D", "1D")
ALL_TFS = [t[0] for t in INTRADAY_TFS] + [DAILY_TF[0]]

_STATS = {"calls": 0, "ok": 0, "failed": 0, "skipped": 0, "uploaded": 0,
          "bytes": 0, "errors": [], "capped": False}
_last_req = [0.0]


def reset_run_stats():
    _STATS.update({"calls": 0, "ok": 0, "failed": 0, "skipped": 0, "uploaded": 0,
                   "bytes": 0, "errors": [], "capped": False})


class QuotaCeiling(Exception):
    """Raised when the run hits CHART_MAX_CALLS. Stops the run loudly."""


def _throttle():
    gap = time.time() - _last_req[0]
    if gap < CHART_REQ_INTERVAL:
        time.sleep(CHART_REQ_INTERVAL - gap)
    _last_req[0] = time.time()


# ── Request building ───────────────────────────────────────────────

def _et_offset(d):
    return -4 if 3 <= d.month <= 10 else -5


def intraday_range(date_str):
    """
    02:00 ET on the run date -> 20:00 ET, i.e. two hours of buffer before the
    4:00 AM premarket session through the end of after-hours. Verified: the
    window is honoured exactly; the chart simply starts at the first real print,
    which for a low-float name is typically 07:00-08:00.
    """
    d = _dt.datetime.strptime(date_str, "%Y-%m-%d")
    off = _et_offset(d)
    start = d.replace(hour=2) - _dt.timedelta(hours=off)
    end = d.replace(hour=20) - _dt.timedelta(hours=off)
    return {"from": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "to": end.strftime("%Y-%m-%dT%H:%M:%S.000Z")}


def daily_range(date_str, days=372):
    """~1 year (252 trading days is roughly 372 calendar days)."""
    d = _dt.datetime.strptime(date_str, "%Y-%m-%d")
    return {"from": (d - _dt.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00.000Z"),
            "to": d.strftime("%Y-%m-%dT23:59:59.000Z")}


def build_payload(tv_symbol, interval, date_str):
    if interval == "1D":
        studies = [
            {"name": "Moving Average Exponential", "input": {"length": 200},
             "override": {"Plot.color": "rgb(0,230,118)", "Plot.linewidth": 1}},
            {"name": "Moving Average", "input": {"length": 200},
             "override": {"Plot.color": SMA200_COLOR, "Plot.linewidth": 1}},
            {"name": "Volume"},
        ]
        payload = {"symbol": tv_symbol, "interval": "1D",
                   "timezone": "America/New_York",
                   "range": daily_range(date_str)}
    else:
        studies = [
            {"name": "Moving Average Exponential", "input": {"length": n},
             "override": {"Plot.color": c, "Plot.linewidth": 1}}
            for n, c in EMA_SPEC
        ] + [
            {"name": "VWAP", "override": {"VWAP.color": VWAP_COLOR, "VWAP.linewidth": 2}},
            {"name": "Volume"},
        ]
        payload = {"symbol": tv_symbol, "interval": interval,
                   "session": "extended", "timezone": "America/New_York",
                   "range": intraday_range(date_str)}
    payload.update({"width": WIDTH, "height": HEIGHT, "theme": "dark",
                    "studies": studies})
    return payload


# ── Fetch + validate ───────────────────────────────────────────────

def _valid_png(data):
    """(ok, reason). Rejects error pages, blanks and truncated downloads."""
    if not data:
        return False, "empty response"
    if not data.startswith(PNG_MAGIC):
        head = data[:120].decode("utf-8", "replace").strip()
        return False, f"not a PNG ({head[:90]})"
    if len(data) < CHART_MIN_BYTES:
        return False, f"implausibly small ({len(data)} bytes) - probably a blank chart"
    return True, ""


def fetch_chart(tv_symbol, interval, date_str):
    """(png_bytes, error). Raises QuotaCeiling if the run's call budget is spent."""
    if not CHARTIMG_KEY:
        return None, "CHARTIMG_API_KEY not set"
    # Record the ceiling actually in force. The backfill raises CHART_MAX_CALLS
    # for its run and restores it in a finally block — which used to run BEFORE
    # run_summary(), so a 443-call backfill printed "443 / 200 ceiling" and read
    # like the guard had been breached when it hadn't.
    _STATS["ceiling"] = CHART_MAX_CALLS
    if _STATS["calls"] >= CHART_MAX_CALLS:
        _STATS["capped"] = True
        raise QuotaCeiling(
            f"chart capture hit its {CHART_MAX_CALLS}-call ceiling for this run")
    body = json.dumps(build_payload(tv_symbol, interval, date_str)).encode("utf-8")
    _throttle()
    _STATS["calls"] += 1
    req = urllib.request.Request(CHARTIMG_URL, data=body, method="POST", headers={
        "x-api-key": CHARTIMG_KEY,
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=CHART_TIMEOUT) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:160]
        except Exception:                                  # noqa: BLE001
            pass
        return None, f"HTTP {e.code} {detail}"
    except Exception as e:                                 # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    ok, why = _valid_png(data)
    if not ok:
        return None, why
    # Counted HERE, not in capture_runner(), so the backfill — which drives
    # fetch_chart/upload_chart directly rather than going through
    # capture_runner — reports a real "images ok" instead of 0.
    _STATS["ok"] += 1
    return data, None


# ── Firebase Admin upload ──────────────────────────────────────────
_bucket = [None]


def _init_firebase():
    """
    Lazy init so the module imports cleanly on a machine without credentials —
    the rest of the evening run must not fail because charts aren't configured.
    """
    if _bucket[0] is not None:
        return _bucket[0]
    cred_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT") \
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path or not os.path.isfile(cred_path):
        raise RuntimeError(
            "FIREBASE_SERVICE_ACCOUNT is not set or does not point at a file. "
            "See the setup notes at the bottom of chart_capture.py.")
    import firebase_admin
    from firebase_admin import credentials, storage
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            credentials.Certificate(cred_path),
            {"storageBucket": "smallcap-heatguage.firebasestorage.app"})
    _bucket[0] = storage.bucket()
    return _bucket[0]


def auto_storage_path(sym, date_str, tf):
    """
    Deterministic per (ticker, date, timeframe) — this is what makes re-running
    a date idempotent. Same path = overwrite, so no duplicates and no orphans.
    Mirrors charts/auto/... in the Storage rules, which are read-only to browsers.
    """
    return f"charts/auto/{str(sym).upper()}-{date_str}-{tf}.png"


def upload_chart(sym, date_str, tf, data):
    bucket = _init_firebase()
    path = auto_storage_path(sym, date_str, tf)
    blob = bucket.blob(path)
    blob.upload_from_string(data, content_type="image/png")
    blob.make_public()
    _STATS["uploaded"] += 1
    _STATS["bytes"] += len(data)
    return {"url": blob.public_url, "storagePath": path,
            "bytes": len(data), "width": WIDTH, "height": HEIGHT}


def write_auto_slot(sym, date_str, tf, slot):
    """
    Write ONE timeframe into chartsAuto with merge=True.

    The backfill needs this rather than write_auto_doc(): it captures timeframe
    by timeframe, and a full-document replace would wipe slots written earlier
    in the same day the moment one interval was gated out or failed.
    Same collection, same deterministic path - still never touches charts/*.
    """
    import firebase_admin                                   # noqa: F401
    from firebase_admin import firestore
    _init_firebase()
    db = firestore.client()
    doc_id = f"{str(sym).upper()}-{date_str}"
    db.collection("chartsAuto").document(doc_id).set({
        "ticker": str(sym).upper(),
        "date": date_str,
        "auto": {tf: slot},
        "source": "chart-img",
        "specVersion": 1,
        "capturedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return doc_id


def write_auto_doc(sym, date_str, slots):
    """
    chartsAuto/{TICKER}-{date}. A SEPARATE collection from charts/ on purpose:
    the Admin SDK bypasses security rules entirely, so the only real guarantee
    that the pipeline can never destroy a manual upload is that it addresses a
    different document.
    """
    import firebase_admin
    from firebase_admin import firestore
    _init_firebase()
    db = firestore.client()
    doc_id = f"{str(sym).upper()}-{date_str}"
    db.collection("chartsAuto").document(doc_id).set({
        "ticker": str(sym).upper(),
        "date": date_str,
        "auto": slots,
        "source": "chart-img",
        "specVersion": 1,
        "capturedAt": firestore.SERVER_TIMESTAMP,
    }, merge=False)   # full replace: re-running a date cleanly supersedes it
    return doc_id


# ── Per-runner entry point ─────────────────────────────────────────

def capture_runner(sym, date_str, tv_symbol, dry_run=False):
    """
    Four timeframes for one runner. Returns (slots, errors).
    Never raises except QuotaCeiling — a per-ticker failure is logged and
    skipped so one bad symbol can't kill the run.
    """
    if not tv_symbol:
        ok, why = symbols_mod.is_chartable(sym)
        reason = why or "no tradingview symbol resolved"
        _STATS["skipped"] += 1
        _STATS["errors"].append((sym, reason))
        return {}, [reason]

    slots, errors = {}, []
    for tf in ALL_TFS:
        try:
            data, err = fetch_chart(tv_symbol, tf, date_str)
        except QuotaCeiling:
            raise
        if err:
            errors.append(f"{tf}: {err}")
            _STATS["failed"] += 1
            continue
        # "ok" is incremented inside fetch_chart() now — counting it again here
        # would double-count on the nightly path and still report 0 on the
        # backfill path, which drives fetch/upload directly.
        if dry_run:
            slots[tf] = {"bytes": len(data), "dryRun": True}
            continue
        try:
            slots[tf] = upload_chart(sym, date_str, tf, data)
        except Exception as e:                             # noqa: BLE001
            errors.append(f"{tf}: upload failed: {type(e).__name__}: {e}")
            _STATS["failed"] += 1

    if slots and not dry_run:
        try:
            write_auto_doc(sym, date_str, slots)
        except Exception as e:                             # noqa: BLE001
            errors.append(f"firestore write failed: {type(e).__name__}: {e}")
    for e in errors:
        _STATS["errors"].append((sym, e))
    return slots, errors


def run_summary():
    lines = [
        "",
        "=" * 62,
        "CHART CAPTURE SUMMARY",
        f"  chart-img calls   : {_STATS['calls']} / {_STATS.get('ceiling') or CHART_MAX_CALLS} ceiling",
        f"  images ok         : {_STATS['ok']}",
        f"  uploaded          : {_STATS['uploaded']}  ({_STATS['bytes']/1e6:.1f} MB)",
        f"  failed            : {_STATS['failed']}",
        f"  skipped (symbol)  : {_STATS['skipped']}",
    ]
    # THE tell for a silently-degraded chart. CHART_MIN_BYTES only rejects
    # obvious blanks; a chart that rendered with no candles, or lost its studies,
    # still clears the floor while being visibly useless. Real 1920x1080 charts
    # measured 88-170 KB. A run averaging well under that is wrong even though
    # every single call returned HTTP 200.
    if _STATS["uploaded"]:
        avg_kb = _STATS["bytes"] / _STATS["uploaded"] / 1024.0
        lines.append(f"  avg image size    : {avg_kb:.0f} KB   (healthy 70-170 KB)")
        if avg_kb < 40:
            lines.append("  !! AVERAGE IMAGE IS TOO SMALL - charts probably rendered blank or")
            lines.append("  !! lost their studies. Open one before trusting this date.")
    if _STATS["capped"]:
        lines += ["", "  !! RUN STOPPED: hit the per-run call ceiling.",
                  "  !! Charts are INCOMPLETE for this date. Investigate before re-running -",
                  "  !! a runaway loop can eat the daily quota in about a minute at full rate."]
    if _STATS["errors"]:
        lines.append("  failures:")
        for sym, err in _STATS["errors"][:40]:
            lines.append(f"    {sym}: {err}")
        if len(_STATS["errors"]) > 40:
            lines.append(f"    ... and {len(_STATS['errors']) - 40} more")
    lines.append("=" * 62)
    return "\n".join(lines)


# ===========================================================================
# SETUP — one-time, before the first real run
#
# 1. pip install firebase-admin
#
# 2. Firebase Console -> Project settings (gear) -> Service accounts tab
#    -> "Generate new private key" -> Generate key. A JSON file downloads.
#    Treat it like a password: it bypasses ALL security rules.
#
# 3. Move it somewhere outside the repo, e.g.
#       C:\Users\jackw\.secrets\smallcap-heatguage-admin.json
#    It must NOT live in the project folder - this repo is pushed to GitHub.
#
# 4. setx FIREBASE_SERVICE_ACCOUNT "C:\Users\jackw\.secrets\smallcap-heatguage-admin.json"
#    then open a NEW terminal (setx only affects future processes).
#
# 5. Storage rules already deny browser writes to charts/auto/**; the Admin SDK
#    bypasses rules, which is why auto and manual live in different collections.
#
# Smoke test without touching Firebase or uploading anything:
#     py -3 chart_capture.py NASDAQ:CYCU 2026-08-14
# ===========================================================================

if __name__ == "__main__":
    import sys
    reset_run_stats()
    sym_arg = sys.argv[1] if len(sys.argv) > 1 else "NASDAQ:CYCU"
    date_arg = sys.argv[2] if len(sys.argv) > 2 else "2026-08-14"
    ticker = sym_arg.split(":")[-1]
    print(f"DRY RUN (no upload): {sym_arg} @ {date_arg}")
    print(f"  intraday window: {intraday_range(date_arg)}")
    print(f"  daily window:    {daily_range(date_arg)}")
    slots, errs = capture_runner(ticker, date_arg, sym_arg, dry_run=True)
    for tf in ALL_TFS:
        s = slots.get(tf)
        print(f"  {tf:4} {'OK  ' + str(s['bytes']) + ' bytes' if s else 'FAILED'}")
    for e in errs:
        print(f"  error: {e}")
    print(run_summary())
