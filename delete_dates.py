"""
delete_dates.py
---------------
Remove every entry dated CUTOFF (2026-07-08) or later from the v2 data2.json.

  target : D:\\Projects\\smallcap-heatguage-v2\\data2.json   (overwritten)

Before writing, the current file is copied to a timestamped backup
(data2_backup_predelete_YYYYmmdd_HHMMSS.json), same pattern as
migrate_new_days.py. If nothing matches, the file is left untouched.

Usage:
    python delete_dates.py
"""

import json
import os
import shutil
from datetime import datetime, timezone

DATA_PATH = r"D:\Projects\smallcap-heatguage-v2\data2.json"

CUTOFF = "2026-07-08"   # inclusive; ISO dates compare correctly as strings


def load_json(path, label):
    if not os.path.exists(path):
        raise SystemExit(f"ERROR: {label} not found:\n  {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    print("=" * 78)
    print("DELETE DATES  ·  remove entries on/after " + CUTOFF)
    print("=" * 78)

    data = load_json(DATA_PATH, "data2.json")

    # copy the list — `data.get("entries")` hands back a reference, and mutating
    # it in place would make the before/after counts read identically
    entries = list(data.get("entries", []) or [])
    days_before = len(entries)
    runners_before = sum(len(e.get("runners", []) or []) for e in entries)

    doomed = sorted(
        (e for e in entries if (e.get("date") or "") >= CUTOFF),
        key=lambda e: e.get("date") or "",
    )
    kept = [e for e in entries if (e.get("date") or "") < CUTOFF]

    print(f"  file        : {DATA_PATH}")
    print(f"  days before : {days_before}")
    print(f"  runners     : {runners_before}")
    print("-" * 78)
    print(f"  entries matching (date >= {CUTOFF}): {len(doomed)}")
    print("-" * 78)

    if not doomed:
        print("  Nothing matched — data2.json left unchanged.")
        return

    print("  REMOVING:")
    removed_runners = 0
    for e in doomed:
        n = len(e.get("runners", []) or [])
        removed_runners += n
        print(f"    - {e.get('date')}   {n} runners")

    # ---- backup, then write ----
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = os.path.join(
        os.path.dirname(DATA_PATH), f"data2_backup_predelete_{stamp}.json"
    )
    shutil.copy2(DATA_PATH, backup)

    # keep the existing convention: newest first
    kept.sort(key=lambda e: e.get("date") or "", reverse=True)

    data["entries"] = kept
    data["count"] = sum(len(e.get("runners", []) or []) for e in kept)
    data["exportedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print()
    print("-" * 78)
    print(f"  backup written : {backup}")
    print(f"  data2.json     : updated")
    print(f"  days           : {days_before} -> {len(kept)} (-{len(doomed)})")
    print(f"  runners        : {runners_before} -> {data['count']} (-{removed_runners})")
    print(f"  newest date now: {kept[0].get('date') if kept else 'n/a'}")
    print("=" * 78)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
