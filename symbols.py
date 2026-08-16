"""
Ticker -> TradingView EXCHANGE:SYMBOL resolution for chart-img.

chart-img addresses charts by TradingView symbol, which needs an exchange
prefix. Polygon's /v3/reference/tickers already returns `primary_exchange` as a
MIC code, so this costs no extra API calls — the pipeline just reads a field it
was already fetching.

MAPPING VERIFIED, NOT ASSUMED (2026-08-15). Every row below was confirmed by
rendering a real chart, and each was also confirmed to REJECT the wrong prefix,
so the map discriminates rather than accepting anything:

    XNAS -> NASDAQ    NASDAQ:WETO  200      NASDAQ:BQ    422
    XASE -> AMEX      AMEX:BQ      200      AMEX:MUAR    422
    XNYS -> NYSE      NYSE:MUA     200      NYSE:MUAR    422

Distribution across 45 recent runners: XNAS 40, XASE 4, XNYS 1. Those three
cover the universe; anything else is unmapped and skipped loudly rather than
guessed at.
"""

import re

# MIC code -> TradingView exchange prefix.
MIC_TO_PREFIX = {
    "XNAS": "NASDAQ",   # verified
    "XASE": "AMEX",     # verified — NYSE American. Polygon says XASE even for
                        # names TradingView labels "NYSE Arca" (e.g. PLAG).
    "XNYS": "NYSE",     # verified
    # Added 2026-08-15 after the 16-day backfill refused AXTU/AXTL/AXTX — Cboe
    # BZX-listed leveraged ETFs (T-REX / Leverage Shares / Tradr 2X AXTI) that
    # genuinely appear in the movers scan. VERIFIED by rendering: BATS:AXTU
    # returns "T-REX 2X Long AXTI Daily Target ETF - Cboe One", matching
    # data2.json's name exactly. AMEX:AXTU resolves to the SAME security with
    # identical OHLC (TradingView routes both labels to one instrument), so the
    # permissiveness here is harmless rather than a wrong-instrument risk.
    "BATS": "BATS",     # verified
}
# Plausible but NEVER SEEN in our data and NEVER VERIFIED against chart-img.
# Deliberately not in the map above: a wrong prefix that happens to resolve
# would chart the wrong instrument silently, which is worse than skipping.
UNVERIFIED_MICS = {"ARCX", "XCBO", "OTCM"}

# Rights / preferred / when-issued tickers carry a lowercase suffix in our data
# (MUAr, WALpA, OTAIr, RQIr, TYGr — 7 across all history).
#
# These CANNOT be charted safely. Uppercasing gives a 422 (NYSE:MUAR fails), and
# stripping the suffix resolves to the COMMON stock (NYSE:MUA renders fine) —
# a different security with different price action. A chart of the wrong
# instrument that looks perfectly valid is exactly the silent-wrong-data failure
# this project keeps running into, so they are skipped instead.
_ODD_SUFFIX = re.compile(r"[a-z]")


def is_chartable(ticker):
    """(bool, reason). False means do not attempt a chart for this ticker."""
    t = str(ticker or "")
    if not t:
        return False, "empty ticker"
    if _ODD_SUFFIX.search(t):
        return False, f"rights/preferred suffix ({t}) - cannot be charted without resolving to the wrong security"
    return True, ""


def tv_symbol(ticker, mic):
    """
    (symbol, reason). symbol is None when the ticker can't be addressed, with
    the reason recorded so the run summary can report it rather than swallow it.
    """
    ok, why = is_chartable(ticker)
    if not ok:
        return None, why
    code = str(mic or "").upper()
    prefix = MIC_TO_PREFIX.get(code)
    if not prefix:
        if code in UNVERIFIED_MICS:
            return None, f"exchange {code} is plausible but unverified - refusing to guess a prefix"
        return None, f"unknown primary_exchange {code or '(none)'}"
    return f"{prefix}:{str(ticker).upper()}", ""


if __name__ == "__main__":
    cases = [("CYCU", "XNAS"), ("PLAG", "XASE"), ("MUA", "XNYS"),
             ("MUAr", "XNYS"), ("WALpA", "XNAS"), ("FOO", "ARCX"),
             ("BAR", "XXXX"), ("BAZ", None)]
    for t, m in cases:
        s, why = tv_symbol(t, m)
        print(f"  {t:8} {str(m):6} -> {str(s):16} {why}")
