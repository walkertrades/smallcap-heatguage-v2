"""
cleanup_reverse_splits.py
-------------------------
Finds runners in data2.json whose numbers look like a reverse-split artifact
rather than a real move, prints them for review, and writes a cleaned copy.

Flag rule — a runner is flagged when BOTH of:
    HOD %  > 2000
    volume < 2,000,000 shares

A four-figure move on under 2M shares is a reverse-split artifact on its face,
so the price/volume signature alone is the test. (An earlier version also
required `reverseSplit` set OR no recognized catalyst — that never fired: the
v1 backlog has no reverseSplit field at all, and these rows all carry a
SYMPATHY / RETAIL PUMP style tag, which is exactly where a mis-scaled split
lands when there's no real catalyst to name.)

reverseSplit and tag are still printed as review context.

The original data2.json is NEVER modified. The cleaned file is written to
data2_cleaned.json with the flagged runners removed. Review the printed list,
then rename data2_cleaned.json -> data2.json yourself if it looks right.

Usage:
    python cleanup_reverse_splits.py
"""

import json
import os
import sys

DATA_FILE = "data2.json"
OUT_FILE = "data2_cleaned.json"

HOD_THRESHOLD = 1000.0         # percent
VOLUME_THRESHOLD = 10_000_000  # shares
REVIEW_CSV = "flagged_runners.csv"  # full flagged list for row-by-row review

# Manually reviewed and confirmed as REAL runners — never flag these, even when
# they match the price/volume rule. Keyed (date, ticker).
KEEP = {
    # opened $8.92, closed $86.36, +1,428% open->high on 4.9M shares.
    # prevClose is fine; this is a genuine ~10x intraday, not a split artifact.
    ("2026-01-29", "TCGL"),
}

# Tags we treat as a real, recognized catalyst. Anything else (or empty) counts
# as "no recognized catalyst" for the flag rule. Covers the v2 vocabulary plus
# the legacy v1 tags still present in historical data.
RECOGNIZED_TAGS = {
    # v2 catalyst vocabulary
    "EARNINGS", "FDA", "PHASE-1", "PHASE-2", "PHASE-3", "COMPLIANCE",
    "BANKRUPTCY", "ACQUISITION", "MERGER", "SHARE-BUYBACK", "SYMPATHY",
    "HALT-RESUME", "CONTRACT", "OFFERING",
    # legacy v1 tags
    "RIG", "FUNDAMENTAL", "NEWS-DRIVEN", "UNDERWRITER MANIP", "DILUTION BAIT",
    "RETAIL PUMP", "SHORT TRAP",
}
# NOTE: "NO-NEWS" and "MIXED" are deliberately NOT recognized — a 2000%+ move on
# thin volume with no catalyst is exactly the artifact we're hunting.


def parse_volume(vol):
    """volRaw is a display string like '80.8M' / '412.5K'; volDollar-style ints pass through."""
    if vol is None:
        return None
    if isinstance(vol, (int, float)):
        return float(vol)
    s = str(vol).strip().replace(",", "").replace("$", "")
    if not s:
        return None
    mult = 1.0
    if s[-1:].upper() == "K":
        mult, s = 1e3, s[:-1]
    elif s[-1:].upper() == "M":
        mult, s = 1e6, s[:-1]
    elif s[-1:].upper() == "B":
        mult, s = 1e9, s[:-1]
    try:
        return float(s) * mult
    except ValueError:
        return None


def hod_of(runner):
    v = runner.get("hodExact")
    if v is None:
        v = runner.get("hod")
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def open_to_high(runner):
    """
    Intraday move from the open to the high, in percent.

    This is the honest tell. It uses ONLY same-day prices, so a reverse split
    cannot distort it — whereas HOD % is measured against prevClose, which is
    exactly the value a split corrupts. A row with a four-figure HOD % but a
    low open->high never really moved; the "gain" is a stale prevClose.
    """
    o = runner.get("open")
    h = runner.get("high")
    try:
        o = float(o); h = float(h)
    except (TypeError, ValueError):
        return None
    if o <= 0:
        return None
    return (h - o) / o * 100.0


def is_flagged(runner, date=None):
    """Returns (flagged: bool, reason: str). Price/volume signature only."""
    if date is not None and (date, runner.get("sym")) in KEEP:
        return False, ""

    hod = hod_of(runner)
    vol = parse_volume(runner.get("volRaw"))

    if hod is None or hod <= HOD_THRESHOLD:
        return False, ""
    if vol is None or vol >= VOLUME_THRESHOLD:
        return False, ""

    # context for the review list (not part of the decision)
    notes = []
    rs = runner.get("reverseSplit")
    if rs not in (None, False, ""):
        notes.append(f"reverseSplit={rs}")
    tag = (runner.get("tag") or "").strip().upper()
    if tag and tag not in RECOGNIZED_TAGS:
        notes.append("no recognized catalyst")
    return True, "; ".join(notes) if notes else f"{hod:,.0f}% on {vol:,.0f} shares"


def main():
    if not os.path.exists(DATA_FILE):
        print(f"ERROR: {DATA_FILE} not found in {os.getcwd()}")
        sys.exit(1)

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data.get("entries", [])
    flagged = []
    total_runners = 0

    for entry in entries:
        date = entry.get("date", "?")
        for runner in entry.get("runners", []) or []:
            total_runners += 1
            hit, reason = is_flagged(runner, date)
            if hit:
                flagged.append({
                    "date": date,
                    "ticker": runner.get("sym", "?"),
                    "hodPct": hod_of(runner),
                    "volume": parse_volume(runner.get("volRaw")),
                    "volRaw": runner.get("volRaw"),
                    "reverseSplit": runner.get("reverseSplit"),
                    "tag": runner.get("tag"),
                    "name": runner.get("name", ""),
                    "float_m": runner.get("floatM", ""),
                    "open": runner.get("open", ""),
                    "close": runner.get("close", ""),
                    "openToHigh": open_to_high(runner),
                    "reason": reason,
                })

    # ---- report ----
    print("=" * 92)
    print("REVERSE-SPLIT / ARTIFACT SCAN")
    print("=" * 92)
    print(f"  Scanned      : {len(entries)} days, {total_runners} runners")
    print(f"  Rule         : HOD% > {HOD_THRESHOLD:,.0f} AND volume < {VOLUME_THRESHOLD:,} shares")
    print(f"  Flagged      : {len(flagged)} runners")
    print("=" * 92)

    if flagged:
        print(f"{'DATE':<12}{'TICKER':<9}{'HOD %':>11}{'VOLUME':>14}  {'REV SPLIT':<11}{'WHY'}")
        print("-" * 92)
        for r in sorted(flagged, key=lambda x: (-(x["hodPct"] or 0))):
            vol = f"{r['volume']:,.0f}" if r["volume"] is not None else "?"
            rs = str(r["reverseSplit"]) if r["reverseSplit"] not in (None, False, "") else "-"
            print(f"{r['date']:<12}{r['ticker']:<9}{r['hodPct']:>10,.0f}%{vol:>14}  {rs:<11}{r['reason']}")
        print("-" * 92)
    else:
        print("  Nothing matched the rule — no cleanup needed.")

    # ---- CSV of the flagged rows, for row-by-row review in a spreadsheet ----
    if flagged:
        import csv
        with open(REVIEW_CSV, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "ticker", "hodPct", "openToHigh", "volume", "volRaw",
                        "reverseSplit", "tag", "name", "float_m", "open", "close", "why"])
            for r in sorted(flagged, key=lambda x: (-(x["hodPct"] or 0))):
                oth = r.get("openToHigh")
                w.writerow([
                    r["date"], r["ticker"],
                    f"{r['hodPct']:.0f}" if r["hodPct"] is not None else "",
                    f"{oth:.1f}" if oth is not None else "",
                    f"{r['volume']:.0f}" if r["volume"] is not None else "",
                    r.get("volRaw", ""), r.get("reverseSplit") or "", r.get("tag") or "",
                    r.get("name", ""), r.get("float_m", ""), r.get("open", ""), r.get("close", ""),
                    r["reason"],
                ])
        print()
        print(f"  Review CSV: {os.path.abspath(REVIEW_CSV)}  ({len(flagged)} rows)")

    # ---- write cleaned copy (original untouched) ----
    drop = {(r["date"], r["ticker"]) for r in flagged}
    cleaned_entries = []
    for entry in entries:
        date = entry.get("date", "?")
        kept = [rr for rr in (entry.get("runners") or []) if (date, rr.get("sym")) not in drop]
        new_entry = dict(entry)
        new_entry["runners"] = kept
        cleaned_entries.append(new_entry)

    cleaned = dict(data)
    cleaned["entries"] = cleaned_entries
    cleaned["count"] = sum(len(e.get("runners", [])) for e in cleaned_entries)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)

    print()
    print(f"  Wrote  : {os.path.abspath(OUT_FILE)}")
    print(f"  Runners: {total_runners} -> {cleaned['count']} ({len(flagged)} removed)")
    print(f"  {DATA_FILE} was NOT modified.")
    print()
    print("  Review the list above. If it looks right, rename:")
    print(f"      {OUT_FILE}  ->  {DATA_FILE}")


if __name__ == "__main__":
    main()
