# PROJECT HANDOFF — The Heat Gauge + Trading Review System

**Owner:** Jack (Walker Trading LLC) — small-cap momentum day trader
**Last updated:** August 2026

---

## 1. WHAT EXISTS

### The Heat Gauge (primary analytics app)

| Item | Path / URL |
|---|---|
| Live site | `walkertrades.github.io/smallcap-heatguage-v2` |
| Production repo | `D:\Projects\smallcap-heatguage-v2` |
| Sandbox (edit here) | `D:\Projects\smallcap-heatguage-sandbox` |
| Old v1 (retired, untouched) | `D:\Projects\smallcap-heatguage` |

**Architecture:** No-build React. Babel transpiles JSX client-side in the browser. No bundler, no npm, no Node build step. All components use the `window.ComponentName` pattern and are loaded via `<script type="text/babel">` tags in `index.html` with cache-bust query strings. Deployed on GitHub Pages. All data loads from `data2.json` (~16MB, ~1,013 days).

**Key source files in `src/`:** `App.jsx`, `Overview.jsx`, `DayDetail.jsx`, `Insights.jsx`, `metrics.jsx`, `Playbook.jsx`, `Calendar.jsx`, `Settings.jsx`, `Gauge.jsx`, `Strip.jsx`, `scoring.jsx`, `v2schema.jsx`, `chartprefs.jsx`, `shots.jsx`, `firebase.js`, `dashboard.css`, `styles.css`

**Features built:**
- Vault-style animated landing page — GridScan WebGL shader background (ported raw GLSL, no Three.js/postprocessing/face-api deps), decrypt text effect, vault-door open transition on login
- Firebase auth (email/password), user profiles, shared chart uploads to Storage, real-time shared notes via Firestore
- Radial heat gauge with gradient arc (cold blue → amber → hot red)
- 5-day clickable rolling day cards — clicking loads that day into the whole dashboard
- "What's Driving Today" — 5D/15D avg heat score gradient bars + dominant country/float tier/price range/sector/catalyst as proportional bars out of 50
- Top Movers table — paginated 12/page, no dedup, sortable columns, date column first, time ranges: TODAY / 5D / 30D / YTD / LAST YEAR / TWO YEARS AGO / CUSTOM
- Historical Context — month-view heat calendar (scrollable by month, HOT=red / NEUTRAL=green / COLD=blue), HOD Time Distribution (15-min windows 4AM–8PM, session-colored, hover glow + tooltip + vertical tracking line, click-to-filter Top Movers with auto time-range sync)
- Period Comparison table — LAST 5D / PRIOR 5D / 30D / 90D / 180D with colored arrows on the 5D column
- $ Volume Trend chart — orange bars + EMA/SMA overlay, DAY/WEEK/MONTH grouping, 3M default, 3M/6M/12M/YTD/Custom ranges
- Playbook tab — folder system with full criteria filter builder, animated Folder components (orange), chart screenshot upload per play, "Add to Playbook" from any runner, Sort By with click-to-reverse
- Manual letter grading F → A++ plus Claude-generated `setupGrade` shown as a separate AI badge
- Collapsible sidebar (icon rail, persists to localStorage), custom candlestick logo (transparent bg, cold→hot gradient with glow on final red candle)
- Settings — chart defaults, indicator colors

### Python pipeline

Location: `D:\Projects\smallcap-heatguage-v2`

- `evening_recap_json_only.py` — daily data pull. Polygon for OHLCV/movers/SSR/reverse-split-ratio (30d lookback) **and `primary_exchange`**. AskEdgar stripped to **float/dilution only — it is no longer in the news path at all**. Claude Haiku 4.5 per runner → `newsSummary`, `bullFactors`, `bearFactors`, `tag`, `setupGrade`, `themes`. One call per day → `aiSummary`.
- `news_sources.py` — **StockTitan per-ticker RSS (press releases) + SEC EDGAR submissions (filings)**. Free, keyless, $0/mo.
- `themes.py` — runner theme extraction: word-boundary regex proposes, the existing Claude call judges.
- `symbols.py` — Polygon MIC → TradingView `EXCHANGE:SYMBOL` for chart-img.
- `chart_capture.py` — chart-img → Firebase Storage → `chartsAuto/`. Four timeframes per runner.
- `merge.py` — folds `heat-gauge-YYYY-MM-DD.json` into `data2.json`
- `playbook_context.txt` — Jack's full trading framework, injected into every Claude call. Gitignored.
- `cleanup_reverse_splits.py` — written, never run
- `historical_recap_polygon_only.py` — legacy

**Daily workflow:** run `evening_recap_json_only.py` → `merge.py` → push via GitHub Desktop. Both scripts write to **the folder they live in** (`OUTPUT_DIR` derives from `__file__`), so run the copy in the repo you actually mean to update; the startup banner names it and flags PRODUCTION.

**Re-running a date that already exists:** `merge.py` skips existing dates by default. `py -3 merge.py --force` replaces without asking; plain `py -3 merge.py` shows a side-by-side of the current vs incoming day and asks y/N (default no); `--skip-existing` never prompts, for unattended runs. Any replace takes a timestamped `data2.json.<stamp>.bak` first. The evening script warns at the date prompt when the date already exists, so a duplicate is caught **before** ~40 chart-img calls are spent, not after.

### Trading Review System

Location: `D:\TradingData\review_system\`

Files: `daily_review.py`, `second_pass.py`, `weekly_review.py`, `notion_helper.py`, `obsidian_helper.py`, `trade_parser.py`, `heat_gauge.py`, `claude_helper.py`, `config.py`, `dryrun.py`

**Flow:**
1. Export TraderVue CSV → `D:\TradingData\daily_exports\YYYY-MM-DD.csv`
2. `python daily_review.py --date YYYY-MM-DD` → parses trades, pulls heat gauge context, sends to Claude for First Pass, creates the Notion daily page, writes the Obsidian daily note, refreshes the root dashboard
3. Jack fills in Pre-Session, trade Grade/Tag/Notes, Scorecard, and My Notes in Notion
4. `python second_pass.py --date YYYY-MM-DD` → reads his notes, deeper feedback, generates tomorrow's index card, updates `recurring_leaks.md`
5. `python weekly_review.py --week YYYY-WNN` on Saturdays

All accept `--skip-notion` to write Obsidian only.

**Trade parser computes:** `mfe_capture_pct` (winners only — requires `mfe_dollar > 0 AND gross_pnl > 0`), `gave_back` (winner that kept under half its MFE), `round_tripper` (`mfe_dollar > 0 AND gross_pnl <= 0` — was green, closed red), `hold_minutes`, `session` bucket.

**Notion:** root page `3aff4efb30cf80c79066f04c8ac4d75d` ("Walker Trading Reviews"). Root has a red TODAY'S FOCUS callout, 3-column dashboard (This Week / 30-Day Stats / Active Patterns), and inline daily+weekly child pages. Daily pages: P&L-based icon (🟢/🔴/⚪), yellow focus callout, collapsed Pre-Session toggle, 7-column trades table, two-column scorecard checkboxes, gray "Claude's Read" callout, four color-coded My Notes callouts, purple Second Pass callout, "Index Card → {next trading day}".

**Obsidian:** vault at `D:\TradingData\Trading Brain\Trading Brain\` (note the nesting — the outer folder holds the app install). `obsidian-skills` from kepano installed at `.claude/`. Structure: `daily/`, `weekly/`, `profile/` (`edge_definition.md`, `recurring_leaks.md`, `market_cycle_reads.md`, `size_discipline_log.md`), `playbook/setups/`, `playbook/market_conditions/`, `index_cards/`.

---

## 2. ENVIRONMENT

All keys are Windows user environment variables — never hardcode, never prompt:

```
ANTHROPIC_API_KEY
POLYGON_API_KEY
ASKEDGAR_API_KEY          (float/dilution only — no longer used for news)
NOTION_API_KEY
CHARTIMG_API_KEY          chart-img.com, MEGA plan $10/mo
FIREBASE_SERVICE_ACCOUNT  path to the Admin SDK JSON — NOT in the repo
```

**`setx` only affects future processes.** After setting a variable you must open a
new terminal; an already-running shell will not see it. Every value can also be
read from `HKCU:\Environment` if a session predates the change.

**Python deps beyond the stdlib:** `requests`, `firebase-admin` (`pip install firebase-admin`).

Firebase project: `smallcap-heatguage`. Web config lives in `src/firebase.js` — this is intentional and correct; Firebase web keys are public by design and security is enforced by Firestore/Storage rules, which are published in the console.

Runs Windows. Python via Command Prompt. Node v18. GitHub Desktop for pushes.

---

## 3. WORKING RULES

- **Edit in the sandbox** (`smallcap-heatguage-sandbox`), preview on a local server, then robocopy into `smallcap-heatguage-v2` and push. Never edit v2 directly while iterating.
- Never execute `evening_recap_json_only.py`, `merge.py`, or anything that hits an external API during a build session — use existing `data2.json` for front-end testing. `py_compile` for syntax checks only.
- Verify work by actually loading the local server and using the feature as a user before reporting done.
- `data2.json` is the single source of truth. Manual edits break it easily — always validate JSON after any edit and back up before overwriting.
- No `import` statements in JSX — everything is `window.X` and CDN scripts.
- All Claude-generated copy must be **objective third person**. No names, no "he/his/you/your". Say "the playbook avoids", not "Jack avoids".

---

## 4. DOMAIN NOTES THAT HAVE CAUSED BUGS

- **China rig ≠ pump and dump.** Sustained all-day runner with afternoon continuation and high relative volume throughout is an aggressive institutional rig. Pump and dump is premarket spike + immediate fade. This distinction is in `playbook_context.txt`.
- **`hodTime` inconsistency:** `data2.json` stores `"session"` on **952** days, `"regular session"` on **57**, and `"premarket"` on **19** (1,028 total, counted 2026-08-15 — the previous "~49" figure was an estimate and was wrong). `scoring.jsx` only matches `"session"`, so those 57 days fall through to the `else` branch and get `timeScore = 15` instead of 90 — a 25%-weighted subscore, so **18.75 points low**. Note they do NOT also take the `-10` premarket penalty, which only fires on an exact `"premarket"` match. Measured effect of fixing it: p1 moves 42→46, p5 moves 48→52; min (32), max (96) and median (61) barely move. `NORMALIZE_HOD_TIME = False` in the review system's `config.py` so reviews match what the dashboard displays, quirk included. Fixing it properly means editing v2's scoring. The one-line fix is to run `raw.hodTime` through `normalizeRunnerTime()` in `App.jsx normalizeEntry()`, which already maps `"regular session"` → `"session"` but is currently only applied to *runner* times, not the day's.
- **TraderVue reports `Position MFE = 0.00` for premarket-entered positions** — MFE-derived metrics only ever cover regular-session trades. Sample size must be surfaced in any MFE stat.
- Warrant/rights filtering: only block 5+ char tickers ending W/WS/WT. Tickers ending R or U are often legitimate.
- HOD timezone: UTC-based `_to_et()` helper, EDT(-4) Mar–Oct, EST(-5) Nov–Feb — avoids double-shifting on an EST machine.
- AskEdgar variables (`audited_float_m`, `sector`, `country`, `mc`) must reset to Polygon defaults at the top of each ticker loop or data bleeds when AE rate-limits.
- Black swan override: avg HOD ≥ 300% AND fade > 40% forces HOT.
- Polygon's mover scan misses names — YXT (+1,136%, 1.78M float) was absent on 8/5 and had to be added by hand. Worth checking whether the threshold filters are too tight.
- GitHub Pages can stick in a queued deploy loop — fix by toggling Settings → Actions → General permissions.

### The recurring failure shape: things that lie rather than refuse

Three separate bugs in this project shared one form — **a source returning
plausible-looking wrong data instead of an error.** None of them threw. All of
them were believed for a while. Assume the next one looks like this too.

- **`NO-NEWS` on runners that had news.** The tag was the default whenever the
  headline list came back empty, including when the fetch had failed or the
  date was outside the feed's reach. A 429 looked identical to a clean tape.
  STKH (0.82M float) was tagged NO-NEWS while carrying a real PR *before* the
  move. Fixed: `newsStatus` is now one of `ok | none | error | outrange`, and
  NO-NEWS may only be inferred from `none`.

- **chart-img's free tier silently ignoring `{"length": N}`.** On BASIC, setting
  an EMA period returned **HTTP 200 with a perfectly plausible chart** in which
  every EMA was period 9. Not an error, not a warning — just wrong data that
  looked right, which is why several probe rounds were inconclusive. It works on
  MEGA. **If the key is ever downgraded, the charts will keep rendering and be
  wrong.** Anyone picking this up should know the free tier lies rather than
  refuses.

- **Naive `/ai/i` substring matching for themes.** Matched 1,639 of 9,644
  runners via "said", "chain", "retail", "Thailand". Word-boundary `\bAI\b`
  matches 280. 14.1% of the corpus would have been silently mis-themed.

Also in this family, though caught before shipping: `NYSE:MUA` renders a valid
chart for the ticker `MUAr`, but it's the **common stock, not the rights** — a
different security. `symbols.py` skips those rather than charting the wrong
instrument.

### The second recurring trap: paths that resolve somewhere you didn't mean

This has now bitten twice, both times pointing a script at the wrong repo while
looking completely normal. **Every path in this project must derive from
`__file__`, never from a hardcoded string and never from the current directory.**

- **`OUTPUT_DIR` was hardcoded** to `D:\Projects\smallcap-heatguage-v2` in
  `evening_recap_json_only.py`. Running the SANDBOX script therefore wrote its
  output into the PRODUCTION repo, next to the real `data2.json`, and printed
  "run merge.py there". One command away from merging un-reviewed data into
  production. Fixed: derives from `__file__`, overridable only via
  `HEATGAUGE_OUTPUT_DIR`.
- **`merge.py` resolved `DATA_FILE = "data2.json"` against the CURRENT
  DIRECTORY.** `py -3 D:\...\v2\merge.py` run from anywhere else would have
  silently read and rewritten a *different* `data2.json`. Same for the
  `heat-gauge-*.json` glob. Both fixed to `os.path.join(HERE, ...)`.

The startup banner now prints `Running from` / `Writing to` and flags
`*** PRODUCTION ***` before a single API call is spent. Keep that. If you add a
script, derive its paths the same way and check it with:

    grep -n "os.path.dirname(os.path.abspath(__file__))" *.py

---

## 5. WHERE THINGS LEFT OFF

**Just completed — the 10-item sandbox build (Aug 2026).** All in
`smallcap-heatguage-sandbox`, pending migration to v2.

1. Playbook subfolders sort alphabetically; "All Plays" pinned first.
2. Fullscreen viewers portal to `<body>` via `window.HgOverlay` — the chart
   viewer was trapped in `.mover-detail-inner`'s stacking context (`position:
   sticky` always creates one), so `.topbar` at z-20 painted over a z-200 modal.
3–4, 6, 9. **One shared Firestore override layer** — see §7.
5. Heat trend axis 30–95 (measured, not guessed); one shared `heatColor()`
   extracted from the gauge's SVG gradient.
7. Float-tier and session tooltips generated FROM the threshold definitions, so
   a label can't go stale.
8. News rebuilt on StockTitan + SEC.
10. Four-timeframe charts, manual + auto.

### News sources (item 8)

**StockTitan per-ticker RSS** `https://www.stocktitan.net/rss/news/{TICKER}` —
clean `title`/`link`/`pubDate`, no key, no signup. Measured 7/8 coverage on 2026
runs, **4/4 on the sub-$1 names**, which is exactly where Polygon failed.
**SEC EDGAR** `data.sec.gov/submissions/CIK{cik}.json` for filings — free, full
history to 2008+, ticker→CIK from `company_tickers.json`.

Rejected: Polygon (thin), Benzinga (sales-gated; free tier is teaser + backlink),
Tiingo (3 months history self-serve), direct PR wires (spread across four wires,
no ticker keying, no archive).

**No backfill, by decision.** StockTitan caps at ~50 items/ticker. Historical
days carry `newsStatus: outrange` and are edited by hand. Rate limits are real —
1 req/s with backoff; 2 of 10 tickers hit 429 during testing.

### Themes (item 9)

41 themes. Added from corpus analysis: Medical Device, Education,
Fintech/Payments, Logistics, Consumer Brand, Gaming/Betting. **Rejected despite
high hit counts** — Offering/Dilution (417), Reverse Split (196), Buyback (20):
those are *catalysts*, and folding them in would collapse the catalyst/theme
separation. `China Rig` is combined-signal only (239 of 320 Greater-China
runners are sub-10M float). No backfill.

`V2_THEMES` in `v2schema.jsx` mirrors `THEME_VOCAB` in `themes.py` by hand. The
pipeline ships its vocabulary in `data2.json` as `themeVocab` and the browser
checks itself against it at load, reporting drift loudly in console and in the
theme picker.

### chart-img (item 10)

**MEGA, $10/mo** — 1,000/day, 15/s, 1920×1600. `POST
https://api.chart-img.com/v2/tradingview/advanced-chart`, `x-api-key` header.
The layout-chart endpoint is deliberately NOT used: it needs TradingView session
cookies that expire and can only be renewed by hand.

Verified by rendering, because **the docs are wrong**:

| | correct | docs claim |
|---|---|---|
| EMA | `Moving Average Exponential` | `Exponential Moving Average` ✗ |
| SMA | `Moving Average` | — |
| VWAP | `VWAP` | `Volume Weighted Average` ✗ |
| period | `{"length": N}` | `{"in_0": N}` ✗ |
| EMA colour | `Plot.color` | — |
| VWAP colour | `VWAP.color` | `Plot.color` ✗ |

`session: "extended"` renders real premarket/after-hours candles (**PASS** — the
whole feature depended on this). `range: {from,to}` ISO8601 is honoured exactly;
`timezone: "America/New_York"` puts the axis in ET. Intraday window is 02:00 ET →
20:00 ET; the chart starts at the first real print, typically 07:00–08:00.

Approved indicator spec (`chart_capture.py`): EMA 9 yellow / 20 white / 50
electric blue / 200 bright green all at linewidth 1, VWAP hot magenta
`rgb(255,0,144)` at linewidth **2** (it's the anchor, they're context), Volume
subpanel. Daily: EMA 200 green + SMA 200 purple + Volume, 1 year, no VWAP.

Exchange prefixes verified, and each rejects the wrong prefix: `XNAS→NASDAQ`,
`XASE→AMEX`, `XNYS→NYSE`. Distribution across 45 recent runners: 40/4/1.
`ARCX`/`BATS` are deliberately unmapped — guessing could chart a wrong-but-valid
instrument.

Safety: hard **200-call ceiling per run** (15/s against a bug would eat 1,000/day
in a minute), PNG magic-byte + size validation before upload, per-ticker
isolation, deterministic Storage paths so re-running a date is idempotent.

**VERIFIED END TO END** on 2026-08-13 in the sandbox: `40 calls / 40 images /
40 uploaded / 0 failed / 0 skipped, avg 117 KB` — comfortably inside the
70-170 KB healthy band, and the charts render in the app with the ticker in the
image matching the runner. Requires `pip install firebase-admin` (7.5.0) and
`FIREBASE_SERVICE_ACCOUNT` pointing at the service-account JSON.

### Migrated to v2 on 2026-08-16

Code copied to `smallcap-heatguage-v2` (byte-identical, verified): the whole
`src/` tree, `index.html`, and seven Python modules. **`data2.json` was
deliberately NOT copied** — production keeps its own until the pipeline is run
there, so the first production data write is a deliberate act.

Backfill run before migration: **452 auto chart images** across 12 trading days
(2026-07-30 → 2026-08-14), all four timeframes where retention allowed.

**Run the pipeline with:**

    py -3 evening_recap_json_only.py                 # asks only the date
    py -3 evening_recap_json_only.py --date 2026-08-17   # fully non-interactive
    py -3 merge.py                                   # skips existing dates, asks before replacing
    py -3 merge.py --force                           # replaces without asking

All keys come from environment variables — nothing is prompted. Missing
`POLYGON_API_KEY` or `ASKEDGAR_API_KEY` aborts loudly before any work.
`--debug` replaces the old debug prompt. `--date` also suppresses the "continue
anyway" and "press Enter to close" prompts and **exits non-zero on failure**, so
a scheduled run reports as failed rather than silently succeeding.

**Immediate next:**
1. **Publish both rulesets** (Firestore + Storage) — they changed and are NOT yet live. The `charts` delete rule now requires an empty `manual` map; under the old rule deleting a chart doc fails permanently. Storage needs the single-segment `charts/{fileName}` wildcard plus `charts/auto/{fileName}` — see §7 and `src/firebase.js`.
2. **Run the pipeline in production and merge**, so `data2.json` gains news, themes, `tvSymbol` and `themeVocab`.
3. **Windows Task Scheduler — moved UP in priority.** The 1m chart archive only exists going forward: chart-img's 1m retention is ~12 calendar days, so **every night the pipeline doesn't run is a night of 1m charts that can never be recovered.** This is now unblocked — the script reads all keys from env vars, takes `--date`, never prompts, and exits non-zero on failure. Schedule `evening_recap_json_only.py --date today` → `merge.py --force` → `daily_review.py` at ~5pm on trading days.
4. Remove personal pronouns from Claude output in two places — `call_claude_daily()` in `evening_recap_json_only.py`, and the 5-day trend blend API call in `src/Insights.jsx`
5. Add the China rig section to `playbook_context.txt` if not already present

**Backlog:**
- **[TOP PRIORITY] Playbook -> Firestore migration.** Folders and pins still live in `hg2:playbookFolders` / `hg2:playbookPins`, which is per-ORIGIN localStorage. Two separate incidents traced to this: (1) production folders are a completely different store from the sandbox, so nothing travels between machines and Mikey/Eric see none of it; (2) 2026-08-18 — the reserved `all` id was silently claimed by a renamed folder ("Penny Runners"), destroying the All Plays catch-all and mis-pinning the sidebar. A guard is now in place (`PB_RESERVED_ID`), but the underlying store is still invisible, un-shared and un-auditable. Migrate to `playbookFolders` / `playbookPins` collections on the same subscribe-once-cache pattern as `overrides.jsx`; built-ins stay code-defined and merge over the stored set; pin keys are already `{date}::{sym}` so the doc-id convention carries over.
- **120-day 15m + Daily chart backfill.** `backfill_charts.py --days 120` covers it; ~1,634 calls, ~190 MB, about two days at the 1,000/day cap. Deliberately 15m+Daily only: 1m retention is ~12 days and 5m ~30, so requesting those for older dates returns blank frames that look successful. The age gate already refuses them. Was verified working on the 16-day run — Jul 31 and Jul 30 correctly gated 1m at zero API cost.
- **Leveraged ETFs in the movers scan.** The backfill surfaced `AXTU` / `AXTL` / `AXTX` — T-REX 2X, Leverage Shares 2X and Tradr 2X Long AXTI, all Cboe BZX-listed 2x products tracking the same underlying. They pass the mover filters and now chart correctly under the `BATS:` prefix, but **they are not really separate runners** — three leveraged wrappers on one move, each with its own tiny "float". Open question: filter them out of the scan, tag them as derivatives, or keep them. They inflate runner counts and would distort any float-tier or country statistic.
- **Playbook folders + pins are still localStorage** (`hg2:playbookFolders`, `hg2:playbookPins`) — per-browser, so the Playbook doesn't travel between machines and Mikey/Eric can't see it. This is the biggest remaining instance of the flaw items 3/4/6/9 fixed, and it's the agreed next item after these 10. Migration would mean: a `playbookFolders` collection (shared, group-writable, folders are desk-wide not per-user), a `playbookPins` collection keyed `{TICKER}-{date}` holding a folder-id array, both on the same subscribe-once-cache pattern as `overrides.jsx`. Built-in folders stay code-defined and are merged over the stored set, as now. The pin store already keys on `date::sym`, so the doc-id convention carries over unchanged.
- Polygon 1-minute OHLCV around each trade's entry/exit, fed into the daily review prompt, so Claude can reason about actual price action rather than just P&L
- Investigate why Polygon's mover scan missed YXT; loosen thresholds if that's the cause
- Decide whether `LIQUIDITY-TRAP` becomes a permanent catalyst tag (1 occurrence; kept in the 22-tag vocabulary for now)
- In-app "Ask Claude" panel with the day's runner data pre-loaded
- Weekly round-trip trend wired into `weekly_review.py` (`round_tripper_count` etc. already computed in `summarize()`, not yet consumed)
- `ARCX`/`BATS` exchange prefixes unverified — map them if a runner ever appears on one

---

## 7. FIRESTORE SCHEMA

One override layer serves catalyst, country, themes, behavior, custom tags and
news. Doc IDs are `{TICKER}-{date}` with the ticker UPPERCASED and the date
exactly as `data2.json` stores it (`YYYY-MM-DD`) — the same convention
`shots.jsx` and `Notes.jsx` already use. **The uppercase step is load-bearing**:
7 tickers in history are mixed-case (`MUAr`, `WALpA`), and a lookup that doesn't
uppercase silently loses their overrides.

```
overrides/{TICKER}-{date}
  { ticker, date, updatedAt,
    catalyst   : { value, custom, by, byName, at },
    country    : { value, custom, by, byName, at },
    themes     : { value: [{theme, confidence, uncertain}], by, byName, at },
    behavior   : { value, by, byName, at },
    customTags : { value: [str], by, byName, at },
    news       : { value: { add: [item], hide: [url] }, by, byName, at } }

grades/{TICKER}-{date}/gradeVotes/{uid}
  { grade, userId, displayName, ticker, date, key, updatedAt }

charts/{TICKER}-{date}       { ticker, date, manual: { "1m","5m","15m","1D" },
                               url/storagePath  ← legacy flat image, read-compat }
chartsAuto/{TICKER}-{date}   { ticker, date, auto: {same four}, source, specVersion }

notes/{TICKER}-{date}/comments/{id}   unchanged
users/{uid}, usernames/{name}         unchanged
```

**Merge:** `ovrMergeRunner()` in `App.jsx`'s `scoredEntries` — ONE call site, so
filters, Top Movers, Playbook criteria and Insights all see the same effective
values the tiles do. Override always wins per field, with no recency comparison:
a manual country survives the nightly pipeline rewriting it back to `US`.
`_base` keeps the pipeline's original so the editor can offer "use AI value".

**Reads:** `overrides` and `gradeVotes` each use ONE collection-wide `onSnapshot`
for the session. Grades deliberately are *not* page-scoped — Top Movers and
Playbook both **sort and filter** on grade before pagination, so a page-scoped
load would sort by whatever happened to be resident. That is silently wrong
rather than merely slow. No composite indexes are required; an unfiltered
collection-group query is served by the automatic `__name__` index.

**Charts resolution:** `manual[tf] ?? auto[tf] ?? null` per timeframe. Manual
always holds primary. Auto lives in a **separate collection** because the Admin
SDK bypasses security rules entirely — a rule saying "the pipeline may not touch
manual slots" would be enforced against the browser and not the pipeline. The
separation is structural, not policy.

**Orphans** (override exists, ticker dropped out of `data2.json`) are inert and
**never auto-deleted** — YXT proved a runner can vanish from a nightly rebuild
and come back. Surfaced in Settings with a manual delete.

Rules of record live in `src/firebase.js`. Note the Storage block uses a
**single-segment** wildcard `charts/{fileName}`: Firebase rules are a permissive
union, so `charts/{allPaths=**}` would grant browser writes to `charts/auto/**`
no matter what the auto rule says.

**Retired localStorage** (cleared once per browser, stamped `hg2:lsPurge`):
level 1 `hg2:tagEdits`, `hg2:behavior`; level 2 `hg2:grades`. Still local and
correctly so: `hg2:chartPrefs`, `hg2:sidebarCollapsed`, `hg2:vaultSound`.

---

## 8. HOW JACK WANTS TO BE TALKED TO

Direct. No fluff, no preamble, no "great question". Push back when something is wrong rather than agreeing politely. Concise unless depth is asked for. Flag real limitations honestly instead of building something that half-works — the TradingView date-jump limitation was correctly surfaced rather than faked, and that was the right call.
