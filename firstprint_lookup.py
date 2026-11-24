"""FirstPrint company profiles for the evening recap, fetched through Claude Code.

FirstPrint has no API key. It is reachable only through the claude.ai
connector, which the Claude Code command line carries when it is signed in with
the Claude account. This module makes ONE Claude Code call for the whole runner
list, asks for the profile fields copied as-is, and checks every value before
handing it back.

    import firstprint_lookup
    profiles, problem = firstprint_lookup.lookup(["NXAT", "MSS"])
    # profiles: {"NXAT": {...}, ...}   problem: None, or a one-line reason

Never raises. On any failure it returns what it has (possibly {}) plus the
reason, so the recap can fall back to AskEdgar for the names that are missing.

Claude Code is given the FirstPrint tools and nothing else, runs in an empty
temp folder, and ANTHROPIC_API_KEY is removed from the child process only
(with the key present Claude Code switches the connectors off).

    python firstprint_lookup.py NXAT MSS      print the checked profiles
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TIMEOUT_S = 600
MAX_TICKERS = 14
MAX_LINE = 320           # cap on any FirstPrint sentence stored per runner

FIRSTPRINT_TOOLS = "mcp__claude_ai_First_Print"
BLOCKED_TOOLS = ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "Read",
                 "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"]

# FirstPrint spells countries out; data2.json stores the 2-letter code.
COUNTRY_CODES = {
    "united states": "US", "usa": "US", "u.s.": "US", "china": "CN",
    "people's republic of china": "CN", "prc": "CN", "hong kong": "HK",
    "singapore": "SG", "israel": "IL", "canada": "CA", "cayman islands": "KY",
    "british virgin islands": "VG", "united kingdom": "GB", "uk": "GB",
    "japan": "JP", "south korea": "KR", "korea": "KR", "taiwan": "TW",
    "malaysia": "MY", "india": "IN", "australia": "AU", "germany": "DE",
    "france": "FR", "switzerland": "CH", "netherlands": "NL", "ireland": "IE",
    "greece": "GR", "cyprus": "CY", "united arab emirates": "AE", "uae": "AE",
    "brazil": "BR", "mexico": "MX", "argentina": "AR", "bermuda": "BM",
    "marshall islands": "MH", "thailand": "TH", "indonesia": "ID",
    "vietnam": "VN", "philippines": "PH", "macau": "MO", "kazakhstan": "KZ",
    "italy": "IT", "spain": "ES", "sweden": "SE", "norway": "NO",
    "denmark": "DK", "finland": "FI", "belgium": "BE", "luxembourg": "LU",
    "monaco": "MC", "turkey": "TR", "south africa": "ZA", "nigeria": "NG",
    "new zealand": "NZ", "chile": "CL", "colombia": "CO", "peru": "PE",
    "panama": "PA", "bahamas": "BS", "jersey": "JE", "guernsey": "GG",
    "isle of man": "IM", "malta": "MT", "austria": "AT", "portugal": "PT",
    "poland": "PL", "czech republic": "CZ", "hungary": "HU", "romania": "RO",
    "estonia": "EE", "latvia": "LV", "lithuania": "LT", "iceland": "IS",
    "saudi arabia": "SA", "qatar": "QA", "egypt": "EG", "cambodia": "KH",
}


def country_code(name):
    """'China' -> 'CN'. None when the name is missing or not in the table."""
    if not name:
        return None
    s = str(name).strip()
    if len(s) == 2 and s.isalpha():
        return s.upper()
    return COUNTRY_CODES.get(s.lower())


def _prompt(tickers):
    return f"""Look up each of these tickers with the First Print connector's company profile tool, one call per ticker: {", ".join(tickers)}

Use no other tools. Do not read or write any files.

Then reply with ONE JSON object and nothing else (no code fence, no commentary):

{{"profiles": [ {{...one object per ticker...}} ]}}

Each object copies values EXACTLY as the tool returned them. Do not round, convert, reword, summarise or guess. Use null when a value is absent. Keys and where each comes from in the tool result:

"ticker": the ticker as asked
"found": true if the tool returned a profile, false if it returned nothing or an error
"hq_country": data.hq_country
"incorporated_in": data.incorporated_in
"shares_outstanding": data.shares_outstanding.shares (a number)
"shares_as_of": data.shares_outstanding.as_of
"float": data.float.float (a number)
"float_reliable": data.float.reliable (true/false)
"can_sell_now": data.can_sell.now (true/false)
"can_sell_how": data.can_sell.how (array of strings)
"can_sell_line": data.can_sell.summary if it exists, otherwise data.can_sell.next
"other_dilution_now": data.can_sell.other_dilution_now
"pending_registrations": data.can_sell.pending_registrations (a number)
"dilution_risk": data.dilution_risk
"rating_offering": data.ratings.offering.level
"rating_overhead": data.ratings.overhead.level
"rating_historical": data.ratings.historical.level
"rating_cash": data.ratings.cash.level
"cash_usd": data.cash.reported_cash_usd (a number)
"net_cash_usd": data.cash.net_cash_usd (a number)
"cash_as_of": data.cash.as_of
"runway_months": the cash runway in months if data.cash gives one (a number), otherwise null
"splits": data.splits as an array of {{"ratio": number, "direction": "reverse" or "forward", "effective": "YYYY-MM-DD"}}, or [] if there are none
"deficiency_notice": data.listing_deficiency_notice
"page": firstprint_page
"built": as_of.built"""


def _find_claude():
    found = shutil.which("claude")
    if found:
        return found
    for name in ("claude.exe", "claude"):
        guess = os.path.join(os.path.expanduser("~"), ".local", "bin", name)
        if os.path.isfile(guess):
            return guess
    return None


def _ask(prompt, timeout):
    exe = _find_claude()
    if not exe:
        raise RuntimeError("the claude command was not found (Claude Code not installed or not on PATH)")
    env = {k: v for k, v in os.environ.items() if k.upper() != "ANTHROPIC_API_KEY"}
    cmd = [exe, "-p", prompt, "--allowedTools", FIRSTPRINT_TOOLS,
           "--disallowedTools", *BLOCKED_TOOLS]
    with tempfile.TemporaryDirectory(prefix="fp_lookup_") as work:
        try:
            done = subprocess.run(cmd, cwd=work, env=env, capture_output=True,
                                  text=True, encoding="utf-8", errors="replace",
                                  timeout=timeout, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Claude Code did not answer within {timeout} seconds")
    out = (done.stdout or "").strip()
    if done.returncode != 0:
        tail = ((done.stderr or "").strip() or out)[-300:]
        raise RuntimeError(f"Claude Code exited with code {done.returncode}: {tail}")
    return out


def _num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).replace(",", "").replace("$", ""))
    except ValueError:
        return None


def _text(v, cap=MAX_LINE):
    if v is None or isinstance(v, (dict, list)):
        return None
    s = " ".join(str(v).split())
    if not s:
        return None
    return s if len(s) <= cap else s[:cap - 1].rstrip() + "…"


def _date(v):
    s = str(v or "")[:10]
    return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else None


def _level(v):
    s = _text(v, 24)
    return s if s and s.lower() in ("low", "medium", "high", "very high", "extreme", "unknown") else None


def _bool(v):
    return v if isinstance(v, bool) else None


def clean(raw):
    """One raw profile from the model -> a checked profile, or None to discard it."""
    if not isinstance(raw, dict) or raw.get("found") is False:
        return None
    shares = _num(raw.get("shares_outstanding"))
    flt = _num(raw.get("float"))
    if flt is not None and flt <= 0:
        flt = None
    # A float bigger than the share count is a copying error, not a float.
    if flt is not None and shares and flt > shares * 1.05:
        flt = None
    splits = []
    for s in raw.get("splits") or []:
        if not isinstance(s, dict):
            continue
        ratio, eff = _num(s.get("ratio")), _date(s.get("effective"))
        direction = str(s.get("direction") or "").lower()
        if ratio and eff and direction in ("reverse", "forward"):
            splits.append({"ratio": ratio, "direction": direction, "effective": eff})
    how = [h for h in (_text(x, 20) for x in (raw.get("can_sell_how") or [])
                       if not isinstance(x, (dict, list))) if h][:6]
    hq = _text(raw.get("hq_country"), 60)
    inc = _text(raw.get("incorporated_in"), 60)
    out = {
        "hqCountry": hq, "hqCode": country_code(hq),
        "incCountry": inc, "incCode": country_code(inc),
        "shares": shares, "sharesAsOf": _date(raw.get("shares_as_of")),
        "float": flt, "floatReliable": _bool(raw.get("float_reliable")),
        "canSellNow": _bool(raw.get("can_sell_now")), "canSellHow": how,
        "canSellLine": _text(raw.get("can_sell_line")),
        "otherDilution": _text(raw.get("other_dilution_now")),
        "pendingRegs": _num(raw.get("pending_registrations")),
        "dilutionRisk": _level(raw.get("dilution_risk")),
        "ratings": {k: _level(raw.get("rating_" + k))
                    for k in ("offering", "overhead", "historical", "cash")},
        "cashUsd": _num(raw.get("cash_usd")), "netCashUsd": _num(raw.get("net_cash_usd")),
        "cashAsOf": _date(raw.get("cash_as_of")),
        "runwayMonths": _num(raw.get("runway_months")),
        "splits": splits[:6],
        "deficiencyNotice": _date(raw.get("deficiency_notice")),
        "page": None, "built": _text(raw.get("built"), 40),
    }
    page = _text(raw.get("page"), 120)
    if page and page.startswith("https://app.firstprint.ai/"):
        out["page"] = page
    # Nothing usable at all: treat as not found so the recap falls back.
    if out["float"] is None and not out["hqCountry"] and out["canSellNow"] is None:
        return None
    return out


def lookup(tickers, timeout=TIMEOUT_S):
    """({TICKER: profile}, problem). problem is None when every ticker came back."""
    want = []
    for t in tickers:
        t = str(t or "").upper().strip()
        if re.match(r"^[A-Z0-9.\-]{1,12}$", t) and t not in want:
            want.append(t)
    want = want[:MAX_TICKERS]
    if not want:
        return {}, None
    try:
        text = _ask(_prompt(want), timeout)
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise RuntimeError("the answer was not JSON: " + text[:200])
        rows = json.loads(text[start:end + 1]).get("profiles")
        if not isinstance(rows, list):
            raise RuntimeError("the answer had no 'profiles' list")
    except (RuntimeError, ValueError, OSError) as exc:
        return {}, str(exc)

    out = {}
    for raw in rows:
        t = str((raw or {}).get("ticker") or "").upper().strip() if isinstance(raw, dict) else ""
        if t in want and t not in out:
            prof = clean(raw)
            if prof:
                out[t] = prof
    missing = [t for t in want if t not in out]
    return out, ("no usable profile for " + ", ".join(missing)) if missing else None


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                       # noqa: BLE001
        pass
    got, why = lookup(sys.argv[1:])
    print(json.dumps(got, indent=1, ensure_ascii=False))
    if why:
        print("PROBLEM:", why)
    sys.exit(0 if got else 1)
