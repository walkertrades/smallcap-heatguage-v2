"""
News sourcing for THE HEAT GAUGE — StockTitan (press releases) + SEC EDGAR (filings).

WHY THESE TWO
Polygon's news endpoint was tried and abandoned: coverage on sub-$1 small caps is
too thin. AskEdgar is being pulled out of the NEWS path for the same reason (its
float/dilution usage is untouched). Measured 2026-08-15 against 10 real runners
from data2.json, weighted to sub-$1 low-float names that ran on a PR:

    StockTitan per-ticker RSS   7/8 on 2026 runs, 4/4 of the sub-$1 ones
    SEC submissions API         full history, back to 2008 on our test names

Both are free and keyless. Total cost $0/month.

WHAT THIS DELIBERATELY DOES NOT DO
No backfill. StockTitan's per-ticker feed is capped at ~50 items, so it cannot
reach historical days, and we decided not to pay for an archive. Everything here
is going-forward-only; historical days keep whatever they already have and are
edited by hand in the UI where it matters.

No AI paraphrasing. The old path fed roundup junk ("Here Are 75 Stocks Moving In
Tuesday's Mid-Day Session") into a summarizer, which faithfully summarized
garbage. These are the real press release headlines, stored raw.

RELIABILITY
  · 1 request/second, exponential backoff on 429 (StockTitan rate-limits hard —
    2 of 10 tickers got 429 at 1 req/s during testing, both fine on retry)
  · per-ticker isolation: one failure logs and skips, never kills the run
  · "checked and found nothing" and "the fetch failed" are DIFFERENT statuses.
    Conflating them makes a rate-limit look like a clean tape, so NO-NEWS may
    only ever be inferred from status == "none".
"""

import datetime as _dt
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

# StockTitan blocks non-browser agents on HTML; the RSS path is fine but still
# rate-limits, so keep a browser UA and stay slow.
_ST_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
# SEC requires a descriptive User-Agent with contact details. Not optional.
_SEC_UA = "WalkerTrading HeatGauge walkertradingde@gmail.com"

_ST_RSS = "https://www.stocktitan.net/rss/news/{sym}"
_SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
_SEC_SUBS = "https://data.sec.gov/submissions/CIK{cik}.json"

# Filing types worth surfacing. Everything else (CORRESP, EFFECT, SC 13G/A…) is
# noise on a momentum chart.
SEC_FORMS = {
    "8-K": "Form 8-K", "8-K/A": "Form 8-K/A",
    "424B5": "424B5 offering", "424B4": "424B4 offering", "424B3": "424B3 offering",
    "S-1": "S-1 registration", "S-1/A": "S-1/A", "S-3": "S-3 shelf", "S-3/A": "S-3/A",
    "6-K": "Form 6-K", "20-F": "Form 20-F", "40-F": "Form 40-F",
    "10-Q": "Form 10-Q", "10-K": "Form 10-K",
    "SC 13D": "13D stake", "SC 13D/A": "13D/A stake",
    "425": "Merger comms", "DEF 14A": "Proxy",
}

# Per-run counters. reset_run_stats() at the top of a run, run_summary() at the end.
_STATS = {"ok": 0, "none": 0, "error": 0, "outrange": 0, "items": 0, "st_429": 0,
          # Source and timing mix. Without these a whole source can die silently:
          # StockTitan returns HTTP 200 with a VALID BUT EMPTY RSS channel for an
          # unknown ticker, which is indistinguishable from "no news" unless you
          # can see that PR items dropped to zero across the entire run.
          "pr": 0, "sec": 0, "before": 0, "after": 0,
          "tickers": []}

# One request per second, globally, across both sources.
_MIN_INTERVAL = 1.0
_last_req = [0.0]


def reset_run_stats():
    _STATS.update({"ok": 0, "none": 0, "error": 0, "outrange": 0,
                   "items": 0, "st_429": 0,
                   "pr": 0, "sec": 0, "before": 0, "after": 0, "tickers": []})


def _throttle():
    gap = time.time() - _last_req[0]
    if gap < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - gap)
    _last_req[0] = time.time()


def _fetch(url, ua, tries=3):
    """
    GET with throttling and exponential backoff on 429/5xx.
    Returns (body_text, error_string). Exactly one of them is None.
    """
    delay = 2.0
    last = "unknown error"
    for attempt in range(tries):
        _throttle()
        req = urllib.request.Request(url, headers={
            "User-Agent": ua,
            "Accept": "*/*",
            "Accept-Encoding": "identity",   # skip gzip so we don't hand-roll a decoder
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace"), None
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 429:
                _STATS["st_429"] += 1
            # 4xx other than 429 won't improve on retry
            if e.code not in (429, 500, 502, 503, 504):
                return None, last
        except Exception as e:                      # noqa: BLE001 - network is broad
            last = f"{type(e).__name__}: {e}"
        if attempt < tries - 1:
            time.sleep(delay)
            delay *= 2
    return None, last


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def _et_offset(d):
    """EDT (-4) Mar-Oct, EST (-5) Nov-Feb. Matches the convention already used
    elsewhere in the pipeline so we don't double-shift on an EST machine."""
    return -4 if 3 <= d.month <= 10 else -5


def _parse_rfc822(s):
    """RSS pubDate -> naive UTC datetime, or None."""
    if not s:
        return None
    s = s.strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z",
                "%a, %d %b %Y %H:%M %Z", "%d %b %Y %H:%M:%S %Z"):
        try:
            dt = _dt.datetime.strptime(s, fmt)
            if dt.tzinfo is not None:
                dt = dt.astimezone(_dt.timezone.utc).replace(tzinfo=None)
            return dt
        except ValueError:
            continue
    return None


def _hod_utc(date_str, hod_time_et):
    """
    The moment the high printed, as naive UTC — the reference point for deciding
    whether a headline preceded or followed the move. Falls back to 16:00 ET
    (the close) when we have no intraday HOD time.
    """
    try:
        d = _dt.datetime.strptime(date_str, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    hh, mm = 16, 0
    m = re.match(r"^\s*(\d{1,2}):(\d{2})", str(hod_time_et or ""))
    if m:
        hh, mm = int(m.group(1)), int(m.group(2))
    local = d.replace(hour=min(hh, 23), minute=min(mm, 59))
    return local - _dt.timedelta(hours=_et_offset(d))


# ---------------------------------------------------------------------------
# StockTitan — press releases, ticker-keyed in the URL
# ---------------------------------------------------------------------------

_ST_SUFFIX = re.compile(r"\s*\|\s*[A-Z.\-]+ Stock News\s*$", re.I)


def fetch_stocktitan(sym):
    """
    Returns (items, error, oldest) where `oldest` is the datetime of the oldest
    item the feed carries.

    `oldest` exists because the feed is capped at ~50 items per ticker. Asking
    about a date older than that is NOT the same as there being no news — the
    feed simply doesn't reach. build_news() uses this to avoid reporting a
    confident "no news" about a period it never actually saw.

    A successful fetch with zero items returns ([], None, None) — a real
    "no news", distinct from (None, error, None).
    """
    body, err = _fetch(_ST_RSS.format(sym=str(sym).upper()), _ST_UA)
    if err:
        return None, err, None
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        return None, f"bad XML: {e}", None
    out = []
    for it in root.iterfind(".//item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = _parse_rfc822(it.findtext("pubDate"))
        if not title or not link:
            continue
        # StockTitan appends " | XXXX Stock News" to every headline.
        title = _ST_SUFFIX.sub("", title).strip()
        out.append({
            "title": title,
            "url": link,
            "publisher": "StockTitan",
            "published_utc": pub.strftime("%Y-%m-%dT%H:%M:%SZ") if pub else None,
            "_dt": pub,
            "source_type": "PR",
        })
    stamps = [i["_dt"] for i in out if i.get("_dt")]
    return out, None, (min(stamps) if stamps else None)


# ---------------------------------------------------------------------------
# SEC EDGAR — filings, full history, free
# ---------------------------------------------------------------------------

_cik_map = {}


def load_sec_tickers(force=False):
    """ticker -> zero-padded CIK. Fetched once per run."""
    global _cik_map
    if _cik_map and not force:
        return _cik_map
    body, err = _fetch(_SEC_TICKERS, _SEC_UA)
    if err:
        print(f"    [news] SEC ticker map unavailable ({err}) — filings disabled this run")
        return {}
    import json
    try:
        raw = json.loads(body)
    except ValueError as e:
        print(f"    [news] SEC ticker map unparseable: {e}")
        return {}
    _cik_map = {v["ticker"].upper(): str(v["cik_str"]).zfill(10)
                for v in raw.values() if v.get("ticker")}
    return _cik_map


def fetch_sec(sym, date_str, days_back=7):
    """
    Filings within `days_back` of the run date. Returns (items, error).
    A ticker absent from SEC's map returns ([], None): we checked, there is
    nothing to find — not an error. About 1 in 10 of our historical names has
    already renamed or reverse-merged out of the current symbol map.
    """
    cmap = load_sec_tickers()
    if not cmap:
        return None, "no SEC ticker map"
    cik = cmap.get(str(sym).upper())
    if not cik:
        return [], None
    body, err = _fetch(_SEC_SUBS.format(cik=cik), _SEC_UA)
    if err:
        return None, err
    import json
    try:
        j = json.loads(body)
    except ValueError as e:
        return None, f"bad JSON: {e}"
    recent = (j.get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    dates = recent.get("filingDate") or []
    accs = recent.get("accessionNumber") or []
    docs = recent.get("primaryDocument") or []
    try:
        end = _dt.datetime.strptime(date_str, "%Y-%m-%d")
    except (TypeError, ValueError):
        return [], None
    start = end - _dt.timedelta(days=days_back)
    out = []
    for i, form in enumerate(forms):
        if form not in SEC_FORMS:
            continue
        try:
            fd = _dt.datetime.strptime(dates[i], "%Y-%m-%d")
        except (ValueError, IndexError):
            continue
        if not (start <= fd <= end):
            continue
        acc = (accs[i] if i < len(accs) else "").replace("-", "")
        doc = docs[i] if i < len(docs) else ""
        url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/{doc}"
               if acc and doc else
               f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type={form}")
        # Filings carry a date but no intraday time; 16:00 ET is the honest
        # placeholder — EDGAR's dissemination cutoff.
        out.append({
            "title": SEC_FORMS[form],
            "url": url,
            "publisher": "SEC EDGAR",
            "published_utc": (fd.replace(hour=16) - _dt.timedelta(hours=_et_offset(fd))
                              ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "_dt": fd.replace(hour=16) - _dt.timedelta(hours=_et_offset(fd)),
            "source_type": "SEC",
            "form": form,
        })
    return out, None


# ---------------------------------------------------------------------------
# Dedupe + merge
# ---------------------------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def _norm_words(title):
    return set(_WORD.findall(str(title or "").lower()))


def _similar(a, b):
    """Jaccard over title words. The same story from five outlets shows once."""
    wa, wb = _norm_words(a), _norm_words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / float(len(wa | wb))


def dedupe(items, threshold=0.72):
    out = []
    for it in items:
        if any(_similar(it["title"], k["title"]) >= threshold for k in out):
            continue
        out.append(it)
    return out


def build_news(sym, date_str, hod_time_et=None, window_days=7, limit=6):
    """
    The one entry point the pipeline calls.

    Returns (items, status) where status is:
        "ok"       - fetched successfully, at least one item
        "none"     - fetched successfully, genuinely nothing   <- NO-NEWS valid ONLY here
        "error"    - a fetch failed; we do NOT know whether news exists
        "outrange" - the date predates what the feed can reach; we never saw it

    Each item carries `rel`: "before" if it published before the high printed
    (so it could be the catalyst) or "after" if it followed the move (reactive,
    and must not be read as a cause).
    """
    errors = []
    items = []
    st_oldest = None

    try:
        st, err, st_oldest = fetch_stocktitan(sym)
        if err:
            errors.append(f"stocktitan: {err}")
        elif st:
            items.extend(st)
    except Exception as e:                          # noqa: BLE001
        errors.append(f"stocktitan: {type(e).__name__}: {e}")

    try:
        sec, err = fetch_sec(sym, date_str, days_back=window_days)
        if err:
            errors.append(f"sec: {err}")
        elif sec:
            items.extend(sec)
    except Exception as e:                          # noqa: BLE001
        errors.append(f"sec: {type(e).__name__}: {e}")

    # Keep only items inside the window around the run date.
    try:
        end = _dt.datetime.strptime(date_str, "%Y-%m-%d") + _dt.timedelta(days=2)
        start = end - _dt.timedelta(days=window_days + 2)
    except (TypeError, ValueError):
        start = end = None
    if start and end:
        items = [i for i in items if i.get("_dt") and start <= i["_dt"] <= end]

    items.sort(key=lambda i: i.get("_dt") or _dt.datetime.min, reverse=True)
    items = dedupe(items)[:limit]

    hod = _hod_utc(date_str, hod_time_et)
    for i in items:
        d = i.pop("_dt", None)
        i["rel"] = "before" if (hod and d and d <= hod) else "after"

    # Both sources failing is an error. One failing while the other returns
    # items is still usable; one failing with nothing found is NOT "no news".
    if errors and not items:
        status = "error"
    elif items:
        status = "ok"
    elif st_oldest and end and st_oldest > end:
        # The whole feed is newer than the day we asked about — the ~50-item cap
        # cut us off before this date. We never saw this period, so calling it
        # "no news" would be a claim we can't support.
        status = "outrange"
    else:
        status = "none"

    _STATS[status] += 1
    _STATS["items"] += len(items)
    for i in items:
        _STATS["pr" if i.get("source_type") == "PR" else "sec"] += 1
        _STATS["before" if i.get("rel") == "before" else "after"] += 1
    _STATS["tickers"].append((sym, status, len(items), "; ".join(errors)))
    if errors:
        print(f"    [news] {sym}: {'; '.join(errors)}")
    return items, status


def run_summary():
    """
    Loud, not buried. Zero-news tickers are the number that matters: silent
    empties are how this rots without anyone noticing.
    """
    total = _STATS["ok"] + _STATS["none"] + _STATS["error"] + _STATS["outrange"]
    lines = [
        "",
        "=" * 62,
        "NEWS SUMMARY",
        f"  tickers processed : {total}",
        f"  with news         : {_STATS['ok']}",
        f"  NO NEWS (checked) : {_STATS['none']}",
        f"  FETCH FAILED      : {_STATS['error']}   <-- news unknown, NOT no-news",
        f"  OUT OF FEED RANGE : {_STATS['outrange']}   <-- date predates the feed, never checked",
        f"  items stored      : {_STATS['items']}",
        f"    by source       : {_STATS['pr']} PR (StockTitan) / {_STATS['sec']} SEC",
        f"    vs the move     : {_STATS['before']} before / {_STATS['after']} after",
        f"  429 backoffs      : {_STATS['st_429']}",
    ]
    # A whole source dying is silent: StockTitan answers HTTP 200 with a valid
    # but EMPTY channel for a ticker it doesn't know, which reads exactly like
    # "no news" per-ticker. It only becomes visible in aggregate.
    if _STATS["items"] and _STATS["pr"] == 0:
        lines.append("  !! ZERO PR items across the whole run - StockTitan is likely down or blocked")
    if _STATS["items"] and _STATS["sec"] == 0:
        lines.append("  !! ZERO SEC items across the whole run - check the SEC ticker map / User-Agent")
    if _STATS["error"]:
        lines.append("  failures:")
        for sym, st, _n, err in _STATS["tickers"]:
            if st == "error":
                lines.append(f"    {sym}: {err}")
    if total and _STATS["none"] + _STATS["error"] + _STATS["outrange"] > total * 0.5:
        # ASCII only: this prints to a Windows console that mangles em-dashes.
        lines.append("  !! over half the run returned nothing - check the sources before trusting this day")
    lines.append("=" * 62)
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    reset_run_stats()
    sym = sys.argv[1] if len(sys.argv) > 1 else "CYCU"
    date = sys.argv[2] if len(sys.argv) > 2 else "2026-07-30"
    hod = sys.argv[3] if len(sys.argv) > 3 else None
    got, st = build_news(sym, date, hod)
    print(f"\n{sym} @ {date}  status={st}  items={len(got)}")
    for i in got:
        print(f"  [{i['source_type']:3}] {i.get('rel','?'):6} {i['published_utc']}  {i['title'][:88]}")
        print(f"        {i['url'][:110]}")
    print(run_summary())
