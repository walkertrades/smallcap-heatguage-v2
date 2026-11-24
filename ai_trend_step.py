"""SUPPLY / WATCH lines for the Heat Gauge AI trend card.

Runs after evening_recap_json_only.py and merge.py. Reads one day from
data2.json (read only), picks the names that matter, asks Claude Code to look
them up on FirstPrint, and writes the two lines into ai-trend.json.

    python ai_trend_step.py                      newest day in data2.json
    python ai_trend_step.py --date 2026-11-20    a specific day
    python ai_trend_step.py --dry-run            show the tickers, call nothing

Why Claude Code: FirstPrint has no API key. It is only reachable through the
claude.ai connector, and the Claude Code command line carries that connector
when it is signed in with the Claude account. ANTHROPIC_API_KEY is removed
from the child process only -- with the key present Claude Code switches the
connectors off.

Claude Code is given the FirstPrint tools and nothing else. It answers with
JSON on stdout; this script does every file write. data2.json is never written.

Exit code 0 = wrote the day, or nothing qualified. 1 = failed, nothing written.
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Same counting rule as src/heat2.js.
DV_FLOOR = 20e6        # dollars traded (volume x VWAP)
HOD_MIN = 100          # ran 100% or more at the high
MAX_NAMES = 4
MAX_CHARS = 320        # hard cap per line
ASK_CHARS = 240        # what the model is asked for; leaves slack under the cap
TIMEOUT_S = 420

FIRSTPRINT_TOOLS = "mcp__claude_ai_First_Print"
BLOCKED_TOOLS = ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "Read",
                 "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task"]

# The card copy is objective third person. A line with these in it is refused.
class LineRejected(RuntimeError):
    """The answer came back but a line broke the card rules. Worth one retry."""


PRONOUNS = re.compile(r"\b(i|i'm|i've|me|my|we|our|you|your|he|she|his|her|him)\b", re.I)


def parse_vol(s):
    m = re.match(r"^([\d.]+)\s*([KMB]?)", str(s if s is not None else ""))
    if not m:
        return 0.0
    return float(m.group(1)) * {"K": 1e3, "M": 1e6, "B": 1e9, "": 1}[m.group(2)]


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def dollar_vol(r):
    return parse_vol(r.get("volRaw")) * num(r.get("vwap"))


def hod_of(r):
    return num(r.get("hodExact")) if r.get("hodExact") is not None else num(r.get("hod"))


def pick_names(entry):
    """Counted 100%+ names, biggest dollar volume first, at most four."""
    rows = [r for r in (entry.get("runners") or [])
            if r.get("sym") and dollar_vol(r) >= DV_FLOOR and hod_of(r) >= HOD_MIN]
    rows.sort(key=dollar_vol, reverse=True)
    return rows[:MAX_NAMES]


def load_entry(repo, date_str):
    with open(os.path.join(repo, "data2.json"), "r", encoding="utf-8") as f:
        entries = json.load(f).get("entries") or []
    entries = [e for e in entries if e.get("date")]
    if not entries:
        return None
    if date_str:
        return next((e for e in entries if e["date"] == date_str), None)
    return max(entries, key=lambda e: e["date"])


def build_prompt(date_str, names):
    listed = "\n".join(
        f"- {r['sym']}: ${dollar_vol(r) / 1e6:.0f}M traded, high of day +{hod_of(r):.0f}%"
        for r in names)
    return f"""These small-cap stocks were the biggest runners on {date_str}, biggest dollar volume first:

{listed}

Look up each one with the First Print connector (company profile, and dilution detail where the profile is not enough). Use no other tools. Do not read or write any files.

Then reply with ONE JSON object and nothing else, no code fence, no commentary:

{{"supply": "...", "watch": "...", "tickers": ["..."], "asOf": "YYYY-MM-DD"}}

supply: which of these names can sell stock today and how much room they have, which cannot and why, and which are short of cash. Lead with the two biggest by dollar volume.

watch: anything dated or structural a trader would not see on a chart: delisting or deficiency notices, pending registrations, reverse splits or split votes, and the name with the least overhead supply.

Rules for both lines:
- At most two sentences and at most {ASK_CHARS} characters each, counted with spaces. Shorter is better: this is a small card. Plain words, no jargon beyond ATM, shelf, S-1, float.
- Objective third person. No personal pronouns, no names of people, no advice, no predictions.
- State only what First Print returned. If a profile is missing or flagged unreliable, leave that name out.
- tickers: only the tickers actually mentioned in the two lines.
- asOf: First Print's own data date if it gives one, otherwise today's date.
- If First Print cannot be reached at all, reply exactly: {{"error": "one line saying why"}}"""


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    for name in ("claude.exe", "claude"):
        guess = os.path.join(os.path.expanduser("~"), ".local", "bin", name)
        if os.path.isfile(guess):
            return guess
    return None


def ask_claude(prompt):
    exe = find_claude()
    if not exe:
        raise RuntimeError("the claude command was not found (Claude Code is not installed or not on PATH)")
    env = {k: v for k, v in os.environ.items() if k.upper() != "ANTHROPIC_API_KEY"}
    cmd = [exe, "-p", prompt,
           "--allowedTools", FIRSTPRINT_TOOLS,
           "--disallowedTools", *BLOCKED_TOOLS]
    # An empty working folder: nothing of the repo is in reach of the model.
    with tempfile.TemporaryDirectory(prefix="ai_trend_") as work:
        try:
            done = subprocess.run(cmd, cwd=work, env=env, capture_output=True,
                                  text=True, encoding="utf-8", errors="replace",
                                  timeout=TIMEOUT_S, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Claude Code did not answer within {TIMEOUT_S} seconds")
    out = (done.stdout or "").strip()
    if done.returncode != 0:
        tail = ((done.stderr or "").strip() or out)[-400:]
        raise RuntimeError(f"Claude Code exited with code {done.returncode}: {tail}")
    return out


def parse_answer(text, allowed):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("the answer was not JSON: " + text[:300])
    try:
        obj = json.loads(text[start:end + 1])
    except ValueError as exc:
        raise RuntimeError(f"the answer was not valid JSON ({exc}): " + text[:300])
    if obj.get("error"):
        raise RuntimeError("FirstPrint was not reached: " + str(obj["error"])[:300])

    lines = {}
    for key in ("supply", "watch"):
        val = " ".join(str(obj.get(key) or "").split())
        if not val:
            raise RuntimeError(f"the answer had no {key} line")
        if len(val) > MAX_CHARS:
            raise LineRejected(f"the {key} line is too long ({len(val)} characters, limit {ASK_CHARS})")
        hit = PRONOUNS.search(val)
        if hit:
            raise LineRejected(f"the {key} line is not third person (found '{hit.group(0)}')")
        lines[key] = val

    said = [str(t).upper() for t in (obj.get("tickers") or [])]
    tickers = [t for t in allowed if t in said] or \
              [t for t in allowed if re.search(rf"\b{re.escape(t)}\b", lines["supply"] + " " + lines["watch"])]
    as_of = str(obj.get("asOf") or "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", as_of):
        as_of = dt.date.today().isoformat()
    return {"supply": lines["supply"], "watch": lines["watch"], "tickers": tickers,
            "source": "FirstPrint", "asOf": as_of}


def fix_prompt(answer, problem):
    """Second pass, no lookups: the facts are in the first answer, only the wording is wrong."""
    return f"""This JSON was written for a small dashboard card but was rejected: {problem}.

{answer}

Rewrite it so it passes. Keep the same facts and the same keys. Each of supply and watch: at most two sentences and at most {ASK_CHARS} characters with spaces, objective third person, no personal pronouns, no advice. Drop the least important detail first. Use no tools. Reply with the ONE JSON object and nothing else."""


def get_day(date_str, names, tickers):
    answer = ask_claude(build_prompt(date_str, names))
    try:
        return parse_answer(answer, tickers)
    except LineRejected as exc:
        print(f"  first answer rejected ({exc}); asking for a shorter rewrite")
        return parse_answer(ask_claude(fix_prompt(answer, str(exc))), tickers)


def write_day(path, date_str, day):
    doc = {"v": 1, "days": {}}
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        if not isinstance(doc.get("days"), dict):
            raise RuntimeError(f"{os.path.basename(path)} has no 'days' object; left untouched")
    doc["days"][date_str] = day
    doc["days"] = dict(sorted(doc["days"].items()))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description="Write SUPPLY / WATCH for one day into ai-trend.json")
    ap.add_argument("--date", help="YYYY-MM-DD; default is the newest day in data2.json")
    ap.add_argument("--repo", default=HERE, help="Heat Gauge folder (default: this script's folder)")
    ap.add_argument("--out", help="write here instead of ai-trend.json (for testing)")
    ap.add_argument("--dry-run", action="store_true", help="show the tickers and stop")
    args = ap.parse_args()

    try:
        entry = load_entry(args.repo, args.date)
    except (OSError, ValueError) as exc:
        print(f"ai trend: could not read data2.json ({exc})")
        return 1
    if entry is None:
        print(f"ai trend: no data2.json entry for {args.date or 'any date'}; nothing written")
        return 1

    date_str = entry["date"]
    names = pick_names(entry)
    if not names:
        print(f"ai trend {date_str}: no name ran 100%+ on $20M+; nothing to look up")
        return 0
    tickers = [r["sym"].upper() for r in names]
    print(f"ai trend {date_str}: looking up {', '.join(tickers)} on FirstPrint")
    if args.dry_run:
        print(build_prompt(date_str, names))
        return 0

    out_path = args.out or os.path.join(args.repo, "ai-trend.json")
    try:
        day = get_day(date_str, names, tickers)
        write_day(out_path, date_str, day)
    except (RuntimeError, OSError, ValueError) as exc:
        print(f"ai trend {date_str}: FAILED - {exc}")
        print("  nothing written; the card shows the TAPE line only for this day")
        return 1

    print(f"  SUPPLY: {day['supply']}")
    print(f"  WATCH:  {day['watch']}")
    print(f"  wrote {os.path.basename(out_path)} ({date_str}, as of {day['asOf']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
