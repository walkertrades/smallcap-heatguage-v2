"""
migrate_new_days.py
-------------------
One-time migration: pull the newest trading days out of the v1 data2.json and
add them to the v2 data2.json.

  source      : D:\\Projects\\smallcap-heatguage\\data2.json        (v1)
  destination : D:\\Projects\\smallcap-heatguage-v2\\data2.json     (v2, overwritten)

Only entries dated CUTOFF (2026-07-08) or later are considered. A date that
already exists in v2 is skipped, never merged or overwritten — so the cleanup
work already done in v2 is preserved.

Before writing, the current v2 file is copied to a timestamped backup
(data2_backup_premigrate_YYYYmmdd_HHMMSS.json). Delete that line if you don't
want it — but v2 currently carries ~273 hand-reviewed removals, so it's cheap
insurance.

Usage:
    python migrate_new_days.py
"""

import json
import os
import shutil
from datetime import datetime, timezone

V1_PATH = r"D:\Projects\smallcap-heatguage\data2.json"
V2_PATH = r"D:\Projects\smallcap-heatguage-v2\data2.json"

CUTOFF = "2026-07-08"   # inclusive; ISO dates compare correctly as strings


def load_json(path, label):
    if not os.path.exists(path):
        raise SystemExit(f"ERROR: {label} not found:\n  {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    print("=" * 78)
    print("MIGRATE NEW DAYS  ·  v1  ->  v2")
    print("=" * 78)

    v1 = load_json(V1_PATH, "v1 source")
    v2 = load_json(V2_PATH, "v2 destination")

    v1_entries = v1.get("entries", []) or []
    # NOTE: copy the list. `v2.get("entries")` hands back a reference, so
    # appending to it also mutates v2["entries"] — which made the "before"
    # runner count read as the "after" count in the summary.
    v2_entries = list(v2.get("entries", []) or [])

    runners_before = sum(len(e.get("runners", []) or []) for e in v2_entries)
    v2_dates = {e.get("date") for e in v2_entries}

    print(f"  v1 source      : {len(v1_entries)} days")
    print(f"  v2 destination : {len(v2_entries)} days")
    print(f"  cutoff         : {CUTOFF} or later")
    print("-" * 78)

    # candidates from v1 at/after the cutoff, oldest -> newest for a stable log
    candidates = sorted(
        (e for e in v1_entries if (e.get("date") or "") >= CUTOFF),
        key=lambda e: e.get("date") or "",
    )

    added, skipped = [], []
    for entry in candidates:
        date = entry.get("date")
        if date in v2_dates:
            skipped.append(date)
            continue
        v2_entries.append(entry)
        v2_dates.add(date)
        added.append((date, len(entry.get("runners", []) or [])))

    # keep v2's convention: newest first
    v2_entries.sort(key=lambda e: e.get("date") or "", reverse=True)

    v2["entries"] = v2_entries
    v2["count"] = sum(len(e.get("runners", []) or []) for e in v2_entries)
    v2["exportedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # ---- report ----
    print(f"  candidates at/after cutoff : {len(candidates)}")
    print(f"  days ADDED                 : {len(added)}")
    print(f"  days SKIPPED (already in v2): {len(skipped)}")
    print("-" * 78)

    if added:
        print("  ADDED:")
        for date, n in added:
            print(f"    + {date}   {n} runners")
    else:
        print("  ADDED: none")

    if skipped:
        print()
        print("  SKIPPED (date already present in v2):")
        for date in skipped:
            print(f"    - {date}")

    if not added:
        print()
        print("  Nothing new to merge — v2 left unchanged.")
        return

    # ---- backup, then write ----
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = os.path.join(
        os.path.dirname(V2_PATH), f"data2_backup_premigrate_{stamp}.json"
    )
    shutil.copy2(V2_PATH, backup)

    with open(V2_PATH, "w", encoding="utf-8") as f:
        json.dump(v2, f, indent=2, ensure_ascii=False)

    print()
    print("-" * 78)
    print(f"  backup written : {backup}")
    print(f"  v2 updated     : {V2_PATH}")
    print(f"  days           : {len(v2_entries)}")
    print(f"  runners        : {runners_before} -> {v2['count']} (+{v2['count'] - runners_before})")
    print("=" * 78)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
