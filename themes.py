"""
Theme extraction for THE HEAT GAUGE.

THEME IS NOT CATALYST. They answer different questions and both are kept:
    catalyst = why it moved today      (earnings, offering, PR, 8-K, contract)
    theme    = what bucket it's in     (AI, drone, gold, quantum, China rig)
A name can be "PR catalyst + drone theme" at the same time. Neither overwrites
the other; both are displayed and both are independently filterable.

HOW IT WORKS — two stages, deliberately.
  1. candidate_themes(): word-boundary regex over the runner's news text. Cheap,
     deterministic, and narrows ~45 themes to a handful. It does NOT decide.
  2. The per-runner Claude call judges the candidates: is the theme actually the
     subject, is a named entity a real relationship or a passing mention, and how
     confident is it. Regex proposes, Claude disposes.

WHY WORD BOUNDARIES ARE NON-NEGOTIABLE
Measured over all 9,644 historical runners:
    naive  /ai/i    matched 1,639 runners  ("said", "chain", "retail", "Thailand")
    strict /\\bAI\\b/ matched   280 runners
That is 1,359 false positives — 14.1% of the corpus — from one lazy regex. Every
probe here is boundary-anchored, and the acronym probes are case-SENSITIVE.

NO BACKFILL. Themes exist only from the switchover forward. A runner with no
`themeStatus` field at all predates theming entirely, which is a different thing
from "we looked and found no theme" — see THEME_STATUS below.
"""

import re

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------
# Probe counts below are hits across all historical runner text (headlines,
# summaries, company names), measured 2026-08-15 over 9,644 runners. They
# indicate whether a theme is worth carrying, not how often it will fire on
# clean PR headlines — the historical corpus is the junky aggregator text the
# news rebuild replaced.

THEME_PROBES = {
    # ── base vocabulary from the brief ──
    "AI":                  [r"\bAI\b", r"(?i)\bartificial intelligence\b", r"(?i)\bmachine learning\b", r"\bLLM\b", r"(?i)\bgenerative ai\b"],
    "Quantum":             [r"(?i)\bquantum\b"],
    "Data Center":         [r"(?i)\bdata cent(er|re)s?\b", r"(?i)\bhyperscale"],
    "Nuclear/Uranium":     [r"(?i)\buranium\b", r"(?i)\bnuclear\b", r"\bSMR\b", r"(?i)\bsmall modular reactor"],
    "Gold/Silver":         [r"(?i)\bgold\b", r"(?i)\bsilver\b", r"(?i)\bbullion\b", r"(?i)\bore body\b"],
    "Oil & Gas":           [r"(?i)\boil\b", r"(?i)\bnatural gas\b", r"(?i)\bdrilling\b", r"(?i)\bpetroleum\b"],
    "Lithium/Battery":     [r"(?i)\blithium\b", r"(?i)\bbatter(y|ies)\b", r"(?i)\banode\b", r"(?i)\bcathode\b"],
    "EV":                  [r"\bEVs?\b", r"(?i)\belectric vehicles?\b", r"(?i)\bcharging station"],
    "Drone/UAV":           [r"(?i)\bdrones?\b", r"\bUAVs?\b", r"(?i)\bunmanned aerial\b", r"(?i)\bevtol\b"],
    "Defense":             [r"(?i)\bdefen[cs]e\b", r"(?i)\bmilitary\b", r"\bDoD\b", r"(?i)\bpentagon\b", r"(?i)\bwarfare\b"],
    "Space":               [r"(?i)\bsatellites?\b", r"(?i)\borbital\b", r"(?i)\blaunch vehicle", r"(?i)\bspacecraft\b"],
    "Crypto/Bitcoin":      [r"(?i)\bbitcoin\b", r"(?i)\bcrypto\w*", r"(?i)\bblockchain\b", r"(?i)\bethereum\b", r"(?i)\bstablecoin\b"],
    "Biotech-Clinical":    [r"(?i)\bphase\s*(1|2|3|i{1,3})\b", r"(?i)\bclinical trial", r"(?i)\btopline\b", r"(?i)\benrol(l)?ment\b"],
    "Biotech-FDA":         [r"\bFDA\b", r"(?i)\b510\(k\)\b", r"\bIND\b", r"\bNDA\b", r"(?i)\borphan drug\b", r"(?i)\bbreakthrough therapy\b"],
    "Cannabis":            [r"(?i)\bcannabis\b", r"(?i)\bmarijuana\b", r"\bTHC\b", r"(?i)\bhemp\b", r"(?i)\bpsychedelic"],
    "Robotics":            [r"(?i)\brobotics?\b", r"(?i)\bhumanoid\b", r"(?i)\bautomation\b"],
    "Semiconductor":       [r"(?i)\bsemiconductors?\b", r"(?i)\bfoundry\b", r"(?i)\bwafer\b", r"(?i)\bchipsets?\b"],
    "Rare Earth":          [r"(?i)\brare earth\b", r"(?i)\bneodymium\b", r"(?i)\bpermanent magnets?\b"],
    "Shipping":            [r"(?i)\bshipping\b", r"(?i)\bdry bulk\b", r"(?i)\btankers?\b", r"(?i)\bvessels?\b"],
    "Solar":               [r"(?i)\bsolar\b", r"(?i)\bphotovoltaic\b"],
    "Weight Loss/GLP-1":   [r"(?i)\bglp-?1\b", r"(?i)\bweight loss\b", r"(?i)\bobesity\b", r"(?i)\bsemaglutide\b"],
    "Cybersecurity":       [r"(?i)\bcybersecurity\b", r"(?i)\bcyberattack\b", r"(?i)\bransomware\b", r"(?i)\bzero trust\b"],
    "Agriculture":         [r"(?i)\bagricultur\w+", r"(?i)\bfarming\b", r"(?i)\bfertilizer\b", r"(?i)\bcrops?\b"],
    "Nasdaq Compliance":   [r"(?i)\bminimum bid price\b", r"(?i)\bdeficiency\b", r"(?i)\blisting requirement", r"(?i)\bdelisting\b", r"(?i)\bregain compliance\b"],
    "Reverse Merger/SPAC": [r"\bSPAC\b", r"(?i)\breverse merger\b", r"(?i)\bbusiness combination\b", r"(?i)\bde-?spac\b"],

    # ── named entities: regex only PROPOSES, Claude judges the relationship ──
    "Tesla":        [r"\bTesla\b"],
    "Apple":        [r"\bApple\b"],
    "Nvidia":       [r"(?i)\bnvidia\b"],
    "SpaceX":       [r"(?i)\bspacex\b"],
    "Amazon":       [r"\bAmazon\b"],
    "Google":       [r"\bGoogle\b", r"\bAlphabet\b"],
    "Microsoft":    [r"\bMicrosoft\b"],
    "OpenAI":       [r"(?i)\bopenai\b"],
    "Trump/Policy": [r"\bTrump\b", r"(?i)\btariffs?\b", r"(?i)\bexecutive order\b"],

    # ── ADDITIONS proposed from the historical corpus (counts in comments) ──
    "Medical Device":   [r"(?i)\bmedical device\b", r"(?i)\bdiagnostics?\b", r"(?i)\bimaging\b"],          # 73
    "Education":        [r"(?i)\beducation\b", r"(?i)\btutoring\b", r"(?i)\bedtech\b", r"(?i)\bvocational\b"],  # 64
    "Fintech/Payments": [r"(?i)\bfintech\b", r"(?i)\bpayments?\b", r"(?i)\bremittance\b", r"(?i)\bneobank\b"],  # 45
    "Logistics":        [r"(?i)\blogistics\b", r"(?i)\bsupply chain\b", r"(?i)\bwarehous\w+", r"(?i)\bfreight\b"],  # 39
    "Consumer Brand":   [r"(?i)\bbeverage\b", r"(?i)\bsnack\b", r"(?i)\bapparel\b", r"(?i)\bcosmetics?\b", r"(?i)\bskincare\b"],  # 35
    "Gaming/Betting":   [r"(?i)\bcasino\b", r"(?i)\bsports betting\b", r"(?i)\bigaming\b", r"(?i)\bonline gaming\b"],  # 21
}

# Themes that can only ever be produced from combined signals, never keywords.
# "China rig" is a distinct shape in the playbook: a Greater-China name with a
# small float and no real cash catalyst. 239 of 320 Greater-China runners in our
# history carried a float under 10M, which is why this is worth naming.
COMBINED_THEMES = ["China Rig"]

# Named-entity themes require a real relationship, not a mention. Claude decides:
#   "Signs supply agreement with Tesla"        -> real
#   "Former Tesla engineer joins advisory board" -> weak
#   "Sues Tesla" / a passing comparison         -> not a theme at all
ENTITY_THEMES = {"Tesla", "Apple", "Nvidia", "SpaceX", "Amazon", "Google",
                 "Microsoft", "OpenAI", "Trump/Policy"}

THEME_VOCAB = sorted(set(THEME_PROBES) | set(COMBINED_THEMES))

MAX_THEMES = 3
MIN_CONFIDENCE = 0.35        # below this we emit nothing rather than guess
UNCERTAIN_BELOW = 0.6        # UI flags these as uncertain rather than fact

# themeStatus values written onto every runner the pipeline touches.
#   "ok"      - themes found
#   "none"    - looked, nothing clearly present (an empty theme beats a wrong one)
#   "nonews"  - no usable news text to judge from
#   "unknown" - the news fetch itself failed, so we can't claim anything
# A runner with NO themeStatus field predates theming and must never be read as
# "no theme" — same lie as NO-NEWS, and it covers every historical day.
THEME_STATUS = ("ok", "none", "nonews", "unknown")

_COMPILED = {k: [re.compile(p) for p in v] for k, v in THEME_PROBES.items()}


def candidate_themes(text):
    """Word-boundary regex prefilter. Proposes; never decides."""
    if not text or not str(text).strip():
        return []
    t = str(text)
    return [name for name, pats in _COMPILED.items() if any(p.search(t) for p in pats)]


def runner_text(runner, news_items):
    """Everything worth matching against, newest news first."""
    parts = []
    for i in (news_items or []):
        if i.get("title"):
            parts.append(i["title"])
    if runner.get("name"):
        parts.append(runner["name"])
    if runner.get("sector"):
        parts.append(runner["sector"])
    return "\n".join(parts)


def float_tier(f):
    try:
        f = float(f)
    except (TypeError, ValueError):
        return None
    if f < 1:   return "Nano"
    if f < 5:   return "Micro"
    if f < 10:  return "Low"
    if f < 20:  return "Mid"
    if f < 50:  return "Thick"
    return "Mega Thick"


def build_theme_context(runner, news_items):
    """
    The signal bundle handed to Claude. Sector, country and float tier go in
    alongside the headline text on purpose — "China + low float + no real cash
    catalyst" is a pattern no amount of headline regex will find.
    """
    text = runner_text(runner, news_items)
    cands = candidate_themes(text)
    country = str(runner.get("country") or "").upper()
    tier = float_tier(runner.get("float") or runner.get("floatM"))
    return {
        "candidates": cands,
        "entity_candidates": [c for c in cands if c in ENTITY_THEMES],
        "sector": runner.get("sector"),
        "country": country,
        "float_tier": tier,
        "greater_china": country in ("CN", "HK", "TW", "SG", "MY", "KH"),
        "headlines": [i.get("title") for i in (news_items or []) if i.get("title")][:8],
    }


def normalize(raw, news_status="ok"):
    """
    Validate whatever Claude returned. Anything outside the vocabulary is
    dropped rather than coerced — a wrong theme is worse than no theme.
    Returns (themes, status).
    """
    if news_status in ("error", "outrange"):
        return [], "unknown"
    out = []
    for t in (raw or []):
        if not isinstance(t, dict):
            continue
        name = str(t.get("theme") or t.get("name") or "").strip()
        if name not in THEME_VOCAB:
            continue
        try:
            conf = float(t.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        conf = max(0.0, min(1.0, conf))
        if conf < MIN_CONFIDENCE:
            continue
        if any(o["theme"] == name for o in out):
            continue
        out.append({
            "theme": name,
            "confidence": round(conf, 2),
            "uncertain": conf < UNCERTAIN_BELOW,
        })
    out.sort(key=lambda x: -x["confidence"])
    out = out[:MAX_THEMES]
    if out:
        return out, "ok"
    return [], ("nonews" if news_status == "none" else "none")


PROMPT_RULES = (
    "THEME RULES (theme is NOT catalyst — catalyst is why it moved today, theme is\n"
    "what bucket the company belongs to; a name can have both):\n"
    "  - Choose ONLY from theme_vocabulary. Never invent a theme.\n"
    "  - regex_candidates were found by word matching and are SUGGESTIONS ONLY.\n"
    "    Reject any where the word appears incidentally rather than as the subject.\n"
    "  - Named entities (Tesla, Apple, Nvidia, SpaceX, Amazon, Google, Microsoft,\n"
    "    OpenAI, Trump/Policy) require a REAL RELATIONSHIP, not a mention:\n"
    "      'Signs supply agreement with Tesla'          -> Tesla theme, high confidence\n"
    "      'Former Tesla engineer joins advisory board' -> weak, confidence below 0.5\n"
    "      'Sues Tesla' or a passing comparison         -> NOT a theme, omit entirely\n"
    "  - 'China Rig' applies when greater_china is true AND the float tier is Nano/\n"
    "    Micro/Low AND there is no substantive cash catalyst. It is a structural\n"
    "    pattern, not a keyword.\n"
    "  - At most 3 themes, ordered by confidence, each 0.0-1.0.\n"
    "  - If no theme is clearly present, return an EMPTY array. An empty theme list\n"
    "    is better than a wrong one. Do not force a match.\n"
)


if __name__ == "__main__":
    tests = [
        ("AI trap", "Retailer said the supply chain in Thailand remains constrained"),
        ("AI real", "Company launches AI-powered diagnostics platform"),
        ("drone", "Firm receives UAV contract from the Department of Defense"),
        ("entity", "Signs supply agreement with Tesla for battery components"),
        ("weak entity", "Former Tesla engineer joins the advisory board"),
        ("none", "Company announces annual general meeting date"),
    ]
    print("regex prefilter (stage 1 only — Claude still has to agree)\n")
    for label, t in tests:
        print(f"  {label:12} -> {candidate_themes(t) or '(none)'}")
        print(f"               {t[:76]}")
    print(f"\nvocabulary: {len(THEME_VOCAB)} themes")
