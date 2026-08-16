"""
merge.py
--------
Merges a new heat-gauge dated JSON into the master data2.json.
Run this after historical_heatgauge.py generates a new file.

Usage:
    python merge.py

Place this script in the same folder as data2.json and your
generated heat-gauge-YYYY-MM-DD.json files.
"""

import json, os, glob, shutil, sys
from datetime import datetime, timezone

# Windows hands a cp1252 stdout to any REDIRECTED process, so the emoji in the
# banner raises UnicodeEncodeError the moment output is piped or logged to a
# file — fine interactively, fatal under Task Scheduler. Force UTF-8 and never
# let a decorative character kill a run.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                           # noqa: BLE001
    pass


# Resolve against the SCRIPT's folder, not the current directory. Everything
# else in the pipeline derives its paths from __file__; a cwd-relative
# "data2.json" meant `py -3 D:\...\v2\merge.py` run from anywhere else would
# silently target a different file — the same class of mistake as the
# hardcoded OUTPUT_DIR that dropped sandbox output into production.
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "data2.json")

# An unattended invocation must never block on a prompt.
NONINTERACTIVE = ("--force" in sys.argv) or ("--skip-existing" in sys.argv)


def utc_now_iso() -> str:
    """
    Replaces datetime.utcnow(), which is deprecated and scheduled for removal.
    utcnow() returned a NAIVE datetime that merely happened to hold UTC, so
    anything that later localised it silently shifted the timestamp. The
    timezone-aware form is correct as well as future-proof; `.replace(tzinfo=None)`
    keeps the exact "...Z" string shape data2.json already uses.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"


def backup_data_file() -> str:
    """
    data2.json is the single source of truth and a replace overwrites a day in
    place, so take a copy first. Working rule: back up before overwriting.
    """
    if not os.path.exists(DATA_FILE):
        return ""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = f"{DATA_FILE}.{stamp}.bak"
    shutil.copy2(DATA_FILE, dest)
    return dest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, data: dict):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Saved → {os.path.abspath(path)}")


def find_new_files() -> list[str]:
    """Find all heat-gauge-*.json files in the current folder, excluding data2.json."""
    files = glob.glob(os.path.join(HERE, "heat-gauge-*.json"))
    return sorted(files)


def pick_file(files: list[str]) -> str:
    """Let the user pick which file to merge if there are multiple."""
    if not files:
        return None
    if len(files) == 1:
        return files[0]

    print("\nMultiple heat-gauge files found:")
    for i, f in enumerate(files):
        print(f"  {i+1}) {f}")
    print(f"  {len(files)+1}) Merge ALL of them")

    choice = input("\nSelect: ").strip()
    try:
        idx = int(choice) - 1
        if idx == len(files):
            return "__all__"
        return files[idx]
    except:
        print("Invalid choice.")
        return None


# ---------------------------------------------------------------------------
# Core merge logic
# ---------------------------------------------------------------------------

def describe_entry(e: dict) -> str:
    """
    One-line shape of a day, so a replace decision is made on evidence rather
    than on the date alone. The counts are exactly the fields that differ
    between an old-pipeline pull and a current one.
    """
    rs = e.get("runners", [])
    news = sum(1 for r in rs if r.get("newsItems"))
    themes = sum(1 for r in rs if r.get("themes"))
    tv = sum(1 for r in rs if r.get("tvSymbol"))
    graded = sum(1 for r in rs if r.get("setupGrade"))
    return (f"{len(rs):2} runners | {news:2} with newsItems | {themes:2} with themes | "
            f"{tv:2} with tvSymbol | {graded:2} AI-graded")


def merge_entries(existing: list, incoming: list, force: bool = False,
                  skip_existing: bool = False) -> tuple[list, int, int, int]:
    """
    Merges incoming entries into existing, keyed by date.
    Returns (merged_list, added, skipped, replaced).

    A date that already exists is SKIPPED by default — overwriting production
    data has to be a deliberate act. `--force` replaces without asking;
    otherwise you get a side-by-side of old vs new and an explicit y/N whose
    default is skip. `--skip-existing` never prompts, for unattended runs.
    """
    existing_dates = {e["date"]: i for i, e in enumerate(existing)}
    added = skipped = replaced = 0

    for entry in incoming:
        d = entry["date"]
        if d not in existing_dates:
            existing.append(entry)
            existing_dates[d] = len(existing) - 1
            print(f"  [ADD]  {d} - {len(entry.get('runners', []))} runners")
            added += 1
            continue

        idx = existing_dates[d]
        old = existing[idx]
        if skip_existing:
            print(f"  [SKIP] {d} already exists - skipping")
            skipped += 1
            continue

        print(f"\n  {d} ALREADY EXISTS in {DATA_FILE}:")
        print(f"     current : {describe_entry(old)}")
        print(f"     incoming: {describe_entry(entry)}")

        if force:
            print("     --force given - replacing.")
        else:
            print("\n     Replace it? The current version will be overwritten. (y/N):")
            if input("     > ").strip().lower() not in ("y", "yes"):
                print(f"  [SKIP] {d} kept as-is")
                skipped += 1
                continue

        existing[idx] = entry
        print(f"  [REPLACE] {d} - {len(entry.get('runners', []))} runners")
        replaced += 1

    # Sort chronologically descending (newest first, matches existing pattern)
    existing.sort(key=lambda e: e["date"], reverse=True)
    return existing, added, skipped, replaced


def merge_file(master: dict, new_file: str, force: bool = False,
               skip_existing: bool = False) -> tuple[dict, int, int, int]:
    """Merge one dated JSON file into the master dict."""
    print(f"\nMerging: {new_file}")
    new_data = load_json(new_file)
    incoming = new_data.get("entries", [])

    merged, added, skipped, replaced = merge_entries(
        master.get("entries", []), incoming, force=force, skip_existing=skip_existing)

    master["entries"]    = merged
    master["count"]      = sum(len(e.get("runners", [])) for e in merged)
    master["exportedAt"] = utc_now_iso()

    # Carry over thresholds from new file if master doesn't have them
    if "thresholds" not in master and "thresholds" in new_data:
        master["thresholds"] = new_data["thresholds"]

    # The theme vocabulary the pipeline used, shipped WITH the data so the
    # browser can verify its own copy against it. Always take the newest — the
    # pipeline is authoritative, and a stale mirror in v2schema.jsx would let
    # someone hand-pick a theme the pipeline can't read back.
    if "themeVocab" in new_data:
        master["themeVocab"] = new_data["themeVocab"]

    return master, added, skipped, replaced


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    force = "--force" in sys.argv
    skip_existing = "--skip-existing" in sys.argv

    print("🔀 Heat Gauge — Merge Tool")
    print("=" * 40)
    print(f"  Target: {os.path.abspath(DATA_FILE)}")
    if force:
        print("  --force: existing dates will be REPLACED without asking.")
    elif skip_existing:
        print("  --skip-existing: existing dates will be skipped, no prompts.")
    else:
        print("  Existing dates are skipped unless you confirm a replace.")

    # Load or initialize master
    if os.path.exists(DATA_FILE):
        print(f"\nLoading existing {DATA_FILE}...")
        master = load_json(DATA_FILE)
        print(f"  {len(master.get('entries', []))} existing days")
    else:
        print(f"\n{DATA_FILE} not found — will create a new one.")
        master = {
            "schema":     "heat-gauge.v1",
            "exportedAt": utc_now_iso(),
            "count":      0,
            "thresholds": {
                "hodHot":       150,
                "hodNeutralLo": 100,
                "fadeHot":      25,
                "fadeCold":     40,
            },
            "entries": [],
        }

    # Find files to merge
    new_files = find_new_files()
    if not new_files:
        print("\nNo heat-gauge-*.json files found in this folder.")
        print("Run historical_heatgauge.py first to generate one.")
        input("\nPress Enter to close...")
        return

    choice = pick_file(new_files)
    if not choice:
        input("\nPress Enter to close...")
        return

    files_to_merge = new_files if choice == "__all__" else [choice]

    total_added = total_skipped = total_replaced = 0

    for f in files_to_merge:
        master, added, skipped, replaced = merge_file(
            master, f, force=force, skip_existing=skip_existing)
        total_added    += added
        total_skipped  += skipped
        total_replaced += replaced

    # Summary
    print(f"\n{'='*40}")
    print(f"  Days added    : {total_added}")
    print(f"  Days replaced : {total_replaced}")
    print(f"  Days skipped  : {total_skipped}")
    print(f"  Total days    : {len(master['entries'])}")
    print(f"  Total runners : {master['count']}")

    # A replace changes the file just as much as an add does — the old code only
    # saved when something was ADDED, which would have silently discarded every
    # replacement.
    if total_added == 0 and total_replaced == 0:
        print("\n  Nothing to save — data2.json unchanged.")
        input("\nPress Enter to close...")
        return

    if total_replaced:
        bak = backup_data_file()
        if bak:
            print(f"\n  Backed up previous data2.json -> {bak}")

    save_json(DATA_FILE, master)

    # Ask if user wants to delete the merged source files
    if total_added > 0 or total_replaced > 0:
        print("\nDelete the merged source file(s) to keep the folder clean? (y/N):")
        if input("> ").strip().lower() in ("y", "yes"):
            for f in files_to_merge:
                os.remove(f)
                print(f"  Deleted {f}")

    print("\n✅ Done! Push data2.json via GitHub Desktop.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
