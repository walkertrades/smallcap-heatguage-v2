"""
Charts-only backfill. Captures auto charts for days already in data2.json.

SCOPE, deliberately narrow:
  · writes ONLY to Firebase Storage charts/auto/** and Firestore chartsAuto/*
  · NEVER writes data2.json - no news, no themes, no tvSymbol, no scoring, no grades
  · NEVER touches charts/* - manual uploads live there and must survive untouched
  · Polygon is used read-only, to resolve an exchange prefix per unique ticker

WHY THE AGE GATE EXISTS
chart-img returns HTTP 200 with a valid ~41 KB PNG containing NO CANDLES when the
requested window is older than TradingView's intraday retention. Measured
2026-08-15 on NASDAQ:CYCU, images inspected rather than inferred from status:

    1m   works at 12d   -> identical 41,211-byte empty frame at 15d/16d/23d/30d
    5m   works at 30d   -> empty by 65d
    15m  works at 121d  -> empty at 212d
    1D   works at 212d+

So a day past the wall is SKIPPED, not fetched-and-validated: fetching would
spend a call to receive a blank that has to be thrown away anyway. Retention is
measured in CALENDAR days, not trading days - the market being shut does not
extend TradingView's history.

The byte floor is raised to 45 KB for backfill (the nightly default of 15 KB
does not catch a 41 KB empty frame). Belt and braces: the gate should mean no
blank is ever requested, and the floor catches it if retention shifts.
"""

import argparse
import datetime as _dt
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                           # noqa: BLE001
    pass

import chart_capture as cc
import symbols as symbols_mod

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data2.json")
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".backfill_state.json")

# Measured retention in CALENDAR days, with a safety margin off the observed wall.
RETENTION_DAYS = {"1m": 12, "5m": 30, "15m": 110, "1D": 3650}

# Raised floor for backfill. An out-of-range frame is ~41 KB; real charts on a
# live date measured 88-170 KB.
BACKFILL_MIN_BYTES = 45_000

# Backfill needs a bigger budget than the 200/run nightly ceiling, but still a
# hard stop - a runaway loop at 15 req/s eats 1,000/day in about a minute.
BACKFILL_MAX_CALLS = 600

# Remembered so the "re-run tomorrow" hint can echo the exact window used.
DAYS_USED = [14]


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return set(tuple(x) for x in json.load(f))
    except Exception:                                       # noqa: BLE001
        return set()


def save_state(done):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(list(done)), f)
    except Exception as e:                                  # noqa: BLE001
        print(f"  (could not persist resume state: {e})")


def trading_days(days_back, today):
    """Days present in data2.json within `days_back` CALENDAR days of today."""
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    cutoff = today - _dt.timedelta(days=days_back)
    out = []
    for e in data.get("entries", []):
        try:
            d = _dt.datetime.strptime(e["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if cutoff <= d <= today:
            out.append((e["date"], d, e.get("runners", [])))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def gate(age_days):
    """Which timeframes are inside retention for a day this old."""
    return [tf for tf in cc.ALL_TFS if age_days <= RETENTION_DAYS[tf]]


def build_plan(days_back, today):
    plan = []
    for date_str, d, runners in trading_days(days_back, today):
        age = (today - d).days
        allowed = gate(age)
        skipped = [tf for tf in cc.ALL_TFS if tf not in allowed]
        plan.append({
            "date": date_str, "age": age, "runners": len(runners),
            "allowed": allowed, "skipped": skipped,
            "syms": [r.get("sym") for r in runners],
            "have_tv": sum(1 for r in runners if r.get("tvSymbol")),
        })
    return plan


def print_plan(plan, days_back):
    print("=" * 74)
    print(f"CHARTS BACKFILL PLAN - last {days_back} calendar days")
    print("=" * 74)
    print("\nRetention gates (CALENDAR days, measured 2026-08-15):")
    for tf in cc.ALL_TFS:
        print(f"    {tf:4} <= {RETENTION_DAYS[tf]:>4} days")
    print(f"\n  byte floor for this run : {BACKFILL_MIN_BYTES:,} "
          f"(nightly default {cc.CHART_MIN_BYTES:,} would pass a 41 KB blank)")
    print(f"  call ceiling            : {BACKFILL_MAX_CALLS}")
    print()
    print(f"  {'date':12} {'age':>4} {'runners':>8}  {'capture':22} {'skipped (past wall)'}")
    print("  " + "-" * 70)
    total = 0
    per_tf = {tf: 0 for tf in cc.ALL_TFS}
    for p in plan:
        calls = p["runners"] * len(p["allowed"])
        total += calls
        for tf in p["allowed"]:
            per_tf[tf] += p["runners"]
        print(f"  {p['date']:12} {p['age']:>3}d {p['runners']:>8}  "
              f"{','.join(p['allowed']):22} {','.join(p['skipped']) or '-'}")
    print("  " + "-" * 70)
    print(f"  days: {len(plan)}   runners: {sum(p['runners'] for p in plan)}   "
          f"TOTAL CALLS: {total}")
    print("\n  per timeframe:")
    for tf in cc.ALL_TFS:
        print(f"    {tf:4} {per_tf[tf]:>5} images")
    est_mb = total * 117 / 1024.0
    print(f"\n  estimated storage: ~{est_mb:.0f} MB at the measured 117 KB/image")
    tv = sum(p["have_tv"] for p in plan)
    tot_r = sum(p["runners"] for p in plan)
    print(f"  runners already carrying tvSymbol: {tv}/{tot_r} "
          f"- the rest resolve via a read-only Polygon lookup, cached per unique ticker")
    if total > BACKFILL_MAX_CALLS:
        print(f"\n  !! plan exceeds the {BACKFILL_MAX_CALLS}-call ceiling - raise it or narrow the window")
    print("=" * 74)


def resolve_symbol(sym, cache, poly_key):
    """Exchange prefix per UNIQUE ticker. Read-only; nothing is written back."""
    if sym in cache:
        return cache[sym]
    mic = None
    try:
        import urllib.request
        url = f"https://api.polygon.io/v3/reference/tickers/{sym}?apiKey={poly_key}"
        with urllib.request.urlopen(url, timeout=20) as r:
            mic = (json.loads(r.read()).get("results") or {}).get("primary_exchange")
    except Exception as e:                                  # noqa: BLE001
        print(f"    [{sym}] polygon lookup failed: {type(e).__name__}")
    tv, why = symbols_mod.tv_symbol(sym, mic)
    cache[sym] = (tv, why)
    return cache[sym]


def run(plan, poly_key, dry_run=False):
    # Raise the floor for this run only; the nightly default stays as it is.
    original_floor = cc.CHART_MIN_BYTES
    original_cap = cc.CHART_MAX_CALLS
    cc.CHART_MIN_BYTES = BACKFILL_MIN_BYTES
    cc.CHART_MAX_CALLS = BACKFILL_MAX_CALLS
    cc.reset_run_stats()

    done = load_state()
    if done:
        print(f"\n  Resuming - {len(done)} (ticker,date,timeframe) slots already captured.\n")
    cache = {}
    report = []
    capped = False
    exhausted = False
    stopped_at = None

    # The ceiling is a SAFETY STOP, not an error: hitting it must still produce
    # the per-day report and the summary. Letting QuotaCeiling propagate killed
    # the script before either printed — 52 days of work completed and reported
    # nothing but a one-line message, which defeats the point of the guard.
    try:
        for p in plan:
            date_str = p["date"]
            landed, skipped_gate, failed, skipped_sym = 0, 0, 0, 0
            try:
                for sym in p["syms"]:
                    tv, why = resolve_symbol(sym, cache, poly_key)
                    if not tv:
                        skipped_sym += 1
                        print(f"    [{date_str}] {sym}: {why}")
                        continue
                    for tf in cc.ALL_TFS:
                        if tf not in p["allowed"]:
                            skipped_gate += 1
                            continue
                        key = (sym, date_str, tf)
                        if key in done:
                            continue
                        if dry_run:
                            landed += 1
                            continue
                        data, err = cc.fetch_chart(tv, tf, date_str)
                        if err:
                            failed += 1
                            # Also record it centrally — the summary's "failed"
                            # counter lives in chart_capture and only
                            # capture_runner() was feeding it, so a backfill
                            # reported "failed: 0" while 339 calls had failed.
                            cc._STATS["failed"] += 1
                            print(f"    [{date_str}] {sym} {tf}: {err}")
                            continue
                        try:
                            slot = cc.upload_chart(sym, date_str, tf, data)
                            # merge=True so each timeframe lands independently and
                            # a partial day is never rewritten as a whole.
                            cc.write_auto_slot(sym, date_str, tf, slot)
                            done.add(key)
                            landed += 1
                        except Exception as e:              # noqa: BLE001
                            failed += 1
                            print(f"    [{date_str}] {sym} {tf}: upload failed: {type(e).__name__}: {e}")
                    save_state(done)
            except (cc.QuotaCeiling, cc.QuotaExhausted) as e:
                capped = True
                stopped_at = date_str
                exhausted = isinstance(e, cc.QuotaExhausted)
                print(f"\n  !! {e}")
            # record the day even when the ceiling cut it short, so the report
            # shows exactly how far the run got
            report.append((date_str, p["age"], landed, skipped_gate, skipped_sym, failed, p["skipped"]))
            print(f"  {date_str} ({p['age']}d): {landed} captured, "
                  f"{skipped_gate} gated, {skipped_sym} unchartable, {failed} failed"
                  + ("   <-- CEILING, day incomplete" if capped else ""))
            if capped:
                break
    finally:
        save_state(done)
        cc.CHART_MIN_BYTES = original_floor
        cc.CHART_MAX_CALLS = original_cap

    print("\n" + "=" * 74)
    print("BACKFILL REPORT - per day")
    print("=" * 74)
    print(f"  {'date':12} {'age':>4} {'got':>5} {'gated':>6} {'nosym':>6} {'fail':>5}  past-wall")
    for date_str, age, landed, gated, nosym, failed, wall in report:
        print(f"  {date_str:12} {age:>3}d {landed:>5} {gated:>6} {nosym:>6} {failed:>5}  {','.join(wall) or '-'}")
    print(cc.run_summary())

    if capped:
        remaining = sum(
            len([s for s in p["syms"]]) * len(p["allowed"]) for p in plan
        ) - len(done)
        print(f"\n  STOPPED AT THE CALL CEILING on {stopped_at}. This backfill is INCOMPLETE.")
        print(f"  {len(done)} slots captured so far; roughly {max(0, remaining)} still to go.")
        print("  Re-run the SAME command tomorrow - resume state skips everything")
        print("  already captured, so it picks up exactly where this stopped:")
        print(f"      py -3 backfill_charts.py --days {DAYS_USED[0]} --max-calls {BACKFILL_MAX_CALLS}")
    return capped


def main():
    global BACKFILL_MAX_CALLS
    ap = argparse.ArgumentParser(description="Charts-only backfill (never writes data2.json)")
    ap.add_argument("--days", type=int, default=14, help="calendar days back (default 14)")
    ap.add_argument("--plan", action="store_true", help="print the plan and exit")
    ap.add_argument("--dry-run", action="store_true", help="walk the plan without calling chart-img")
    ap.add_argument("--reset-state", action="store_true", help="forget resume state and start over")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD)")
    ap.add_argument("--max-calls", type=int, default=BACKFILL_MAX_CALLS,
                    help=f"per-run call ceiling (default {BACKFILL_MAX_CALLS}). "
                         "Keep below the plan's 1,000/day API quota; resume state "
                         "lets the next run pick up exactly where this one stopped.")
    args = ap.parse_args()
    BACKFILL_MAX_CALLS = args.max_calls
    DAYS_USED[0] = args.days

    today = (_dt.datetime.strptime(args.today, "%Y-%m-%d").date()
             if args.today else _dt.date.today())
    if args.reset_state and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
        print("  resume state cleared")

    plan = build_plan(args.days, today)
    print_plan(plan, args.days)
    if args.plan:
        print("\n  --plan only. Nothing captured, nothing written.")
        return

    poly_key = os.environ.get("POLYGON_API_KEY", "")
    if not poly_key:
        print("\n  POLYGON_API_KEY not set - needed to resolve exchange prefixes.")
        return
    if not cc.CHARTIMG_KEY:
        print("\n  CHARTIMG_API_KEY not set.")
        return
    capped = run(plan, poly_key, dry_run=args.dry_run)
    # Exit 2 = stopped at the ceiling, incomplete but not broken.
    # Distinct from 1 (a real failure) so automation can tell them apart.
    if capped:
        sys.exit(2)


if __name__ == "__main__":
    main()
