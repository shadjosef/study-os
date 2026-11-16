# Study-OS · Self-Contained AI Architecture & Universal Schema Protocol (`v1.1`)

`Study-OS` is a self-contained, local-first, OneDrive-synced practice, competitive AI pacing, WISEflow exam-simulation, spaced-repetition (FSRS-5), and study-telemetry platform bridging:
- `../Canvas-Archive` (managed by `canvas-sync` — read originals here; never overwrite generated packs)
- `../Obsidian Vault` (canonical LLM-maintained semester references — deep-linked via `obsidian://` and rendered inline)
- Google Calendar (`50/10` and `20m` study blocks — strictly **read-only**)

> **CRITICAL LIVE DATA RULE FOR ALL AI AGENTS**
> `data/state/progress.json`, `data/logs/attempts.jsonl`, and `data/logs/sessions.jsonl` contain **real, live student progress and study sessions**.
> - **NEVER** delete, truncate, reset, or append synthetic test/dummy records to `progress.json`, `attempts.jsonl`, or `sessions.jsonl`.
> - When smoke-testing the HTTP server, use `GET` endpoints (`/api/ping`, `/api/bootstrap`, `/api/course/<id>`) or temporary scratch copies — never `POST` fake attempts into live logs.

---

## 1. Full Codebase Module Map (Zero External Dependencies)

The platform deliberately uses **Python 3.9+ stdlib** on the backend and **vanilla ES2020 HTML/CSS/JS** (with vendored offline `KaTeX` + `Marked`) on the frontend so there is **zero `npm` / `pip` / bundler bit-rot** across years or machines.

### Backend (`app/`)
- `app/dlpfc.py` — Cognitive control & prefrontal glutamate load classifier:
  - `classify_intrinsic_dlpfc(q)` assigns `dlpfcBase` (`1` = Low-dlPFC recall/recognition, `2` = Med-dlPFC procedural/applied, `3` = High-dlPFC novel multi-step synthesis/case/coding) and `cognitiveType` across all 953 course tasks.
  - `effective_dlpfc_tier(q, rec)` dynamically steps down mastered items via basal-ganglia chunking (`High -> Med · Chunked -> Low · Consolidated`) or escalates struggled/revisit items.
  - `circadian_dlpfc_target(hour, today_high_dlpfc_min)` routes queues across 3 daily phases (`08:00–15:00` High-dlPFC capped at `4.5h = 270m/day`, `15:00–18:00` Med-dlPFC procedural drills, `18:00+` Low-dlPFC consolidation/FSRS).
- `app/server.py` — Local HTTP + JSON REST API server (`http://127.0.0.1:8765`).
  - `StudyStore`: Thread-safe file persistence over `data/` (`catalog.json`, `courses/<id>/bank.json`, `state/progress.json`, `state/calendar_cache.json`, `logs/*.jsonl`).
  - Key routes:
    - `GET /api/ping` — Health check.
    - `GET /api/bootstrap` — Returns `catalog` (including `questionCount` and `flowmultiCount`), `progress`, `analytics`, `calendar`, `recommendedQueue`, and recent `sessions`.
    - `GET /api/course/<courseId>` — Full `bank.json` for a subject.
    - `GET /api/course-asset/<courseId>/<filename>` — Serves Retina `.png` / `.svg` figures from `data/courses/<courseId>/assets/`.
    - `GET /api/obsidian/section?file=...&heading=...` — Extracts exact Markdown section + Vault image links from `../Obsidian Vault`.
    - `POST /api/progress/status` — Single or bulk status toggle (`not_started`, `in_progress`, `done`, `revisit`, or `resetWork` which also clears `savedChoice`, `savedDraft`, `savedWiseflow`).
    - `POST /api/progress/draft` — Autosaves in-progress `choice`, `draft`, and `wiseflowAnswers` (`savedWiseflow` map).
    - `POST /api/attempt` — Logs a verified question attempt (`attempts.jsonl`), updates FSRS-5 memory state & Personal Best in `progress.json` (including `wiseflowAnswers`), recomputes `ai_context_snapshot.json`, and refreshes `../Obsidian Vault/01_Study_OS_Dashboard.md`.
    - `POST /api/session/checkin` — Logs 5-second post-run check-in (`focus`, `energy`, `startInertia`, `tags`, `note`, `upi`).
    - `POST /api/calendar/refresh` — Pulls read-only Google Calendar blocks.
- `app/analytics.py` — Pure math module:
  - Accuracy-gated Pace Ratio (`PR`), "Beat the AI" verification, Universal Productivity Index (`UPI`), FSRS-5 4-grade scheduler (`again`, `hard`, `good`, `easy`), Pearson/tag delta correlations, and `ai_context_snapshot.json` builder.
- `app/calendar_sync.py` — Read-only Google Calendar integration (via `gcal` CLI / cached JSON) + zero-decision-fatigue queue assembler (`build_recommended_queue`).
- `app/obsidian_sync.py` — Heading-aware Markdown extractor for `../Obsidian Vault` + generator for `../Obsidian Vault/01_Study_OS_Dashboard.md`.

### Frontend SPA (`app/public/`)
- `app/public/index.html` — Single-page shell with 4 top-level views (`Command Center`, `Courses & Banks`, `🎓 Exam Simulator`, `UPI & Telemetry`), Full-Screen Competitive/WISEflow Runner (`#runner-overlay`), Live Obsidian Reference Drawer (`#ref-drawer`), 5-Second Check-In Modal (`#checkin-modal`), and Click-to-Zoom Retina Figure Lightbox (`#img-lightbox`).
- `app/public/styles.css` — Academic Paper & Ink design system (`Fraunces` + `Plus Jakarta Sans` + `JetBrains Mono`), Ghost Timer bar, WISEflow FLOWmulti worksheet styling (`.wf-sheet`, `.wf-row`, `.wf-pass`, `.wf-fail`), Exam Simulator cards, and responsive layouts.
- `app/public/js/render.js` (`window.StudyUI`) — Safe Markdown + KaTeX (`$...$`, `$$...$$`) renderer, Retina `.pdf-figure` click-to-zoom lightbox wiring, toast notifications, Live Obsidian Reference Drawer controller, Universal non-pausable 75m working interval clock (`workClock`), and procedural Web Audio background sound masking engine (`soundMasker` — seamless stereo crossfaded `Deep Brown`, `Speech Blocker`, `Warm Pink`, `Soft Rain`, `Cabin Hum`, `Brown + 40Hz`, live Tone/Volume controls, `M` shortcut, and automatic `1:5` break muting).
- `app/public/js/runner.js` (`window.StudyRunner`) — Interactive execution engine:
  - **Guided Learning / Section Check Mode**: Per-question Ghost Timer vs AI Par, Hint Handicap (`+30s` / `+15%`), instant MCQ/FLOWmulti/Rubric verification, and FSRS-5 memory rating (`1–4`).
  - **Strict Blind WISEflow Exam Sit (`examStyle: 'blind'`)**: Full exam paper countdown clock (`180m` / `240m`), `⚑ Flag for Review (F)`, silent answer entry across all MCQs & FLOWmulti boxes without answer leaks, and 1-click **`Submit & Grade Paper`** batch-grading every item simultaneously with a full score breakdown.
  - **WISEflow FLOWmulti Auto-Grader**: `parseWiseflowNumber` (enforces BI WISEflow leading minus `-50` rule, flags parentheses `(-50)`, parses thousand commas & 2-decimal precision) + `gradeSingleWiseflowField` (`±2%` relative tolerance or `±0.02` minimum absolute floor, plus `altExpected` intermediate-rounding targets).
  - **Keyboard Shortcuts**: `1–6` / `A–F` (MCQ select), `Enter` (check answer), `H` (reveal hint), `S` (toggle solution), `O` (Obsidian drawer), `F` (flag in Blind Exam mode), `T` (pause/resume timer), `←` / `→` (prev/next item).
- `app/public/js/app.js` (`window.StudyApp`) — State store & view controller for Command Center, Courses & Banks (filtering, search, bulk Complete/Uncomplete/Revisit/Reset), **`🎓 Exam Simulator` Hub** (`renderExamsHub` with Official Past Papers, Full WISEflow Mock Exams, and 1-click Randomized Full Mock Exam Generator across all 5 courses), and UPI Telemetry charts.

### Native Obsidian Desktop Plugin (`obsidian-plugin/`)
- Installed into `../Obsidian Vault/.obsidian/plugins/study-os-bridge/` (`manifest.json`, `main.js`, `styles.css`). Connects to `http://127.0.0.1:8765` to show live course progress, UPI, next calendar block, and 1-click *Practice Current Section* actions inside Obsidian.

### CLI, PDF Cropper & Reproducible Course Builders (`tools/`)
- `tools/cli.py` — Schema/asset/WISEflow validator (`rebuild-catalog`), telemetry printer (`status`), calendar sync (`refresh-calendar`), and empirical AI Par recalibrator (`recalibrate`).
- `tools/render_pdf.swift` + compiled `tools/render_pdf` — Native macOS `PDFKit` Retina (`2x` scale) PDF page/region cropper for extracting crisp exam tables, plots, and equations into `data/courses/<courseId>/assets/`.
- `tools/builders/` — Reproducible bank generators for all 5 Autumn 2026 BI courses:
  - `tools/builders/build_econ_ob_prog.py` — Builds `econ-2522` (`EXC 3420` Economics I, 324 Qs), `ob-2537` (`EXC 3460` Organizational Behavior & Leadership, 95 Qs), and `prog-3021` (`EBA 3400` Programming, 48 Qs).
  - `tools/builders/build_acct.py` — Builds `acct-2527` (`EXC 3430` Accounting & Finance) from Canvas PDFs, textbook exercises, and the 2023 Final Exam (`E23F`), then automatically invokes `enrich_accounting_bank()` from `build_acct_wiseflow_mocks.py`.
  - `tools/builders/build_acct_wiseflow_mocks.py` — Attaches interactive `wiseflowFields` (`±2%` / 2-decimal boxes) to `E23F-E1..E4` + core calculation exercises AND generates **3 complete 180-point WISEflow Mock Exams** (`WF-MOCK-A`, `WF-MOCK-B`, `WF-MOCK-C` — 14 parts / 180 pts / 180 mins each, mirroring the exact 2023 BI exam blueprint). Can be run standalone (`python3 tools/builders/build_acct_wiseflow_mocks.py`) or via `build_acct.py`.
  - `tools/builders/build_math.py` — Builds `math-2588` (`EBA 1181` Mathematics for Data Science, 152 Qs + 321 Retina PDF crops across 8 official exams 2022–2025, Sample Exam, Mock Paper & Digital Exams, and MC Drills).

---

## 2. Course Bank Schema (`data/courses/<courseId>/bank.json`)

Every course bank MUST validate via `python3 tools/cli.py rebuild-catalog` against this JSON structure:

```json
{
  "schemaVersion": 1,
  "courseId": "acct-2527",
  "canvasId": "2527",
  "code": "EXC 3430",
  "title": "Accounting and Finance",
  "shortTitle": "Accounting",
  "semester": "Autumn 2026",
  "color": "#1e4d7b",
  "examInfo": {
    "date": "2026-12-01",
    "format": "3-hour WISEflow FLOWmulti digital school exam (180 pts)",
    "durationMinutes": 180,
    "notes": "~1/3 MCQs & Right/Wrong, ~2/3 numeric answer boxes (2 decimals, ±2% rounding margin, leading minus -50)."
  },
  "obsidian": {
    "vault": "Obsidian Vault",
    "mainReference": "Accounting/EXC3430 - Financial Accounting & Financial Management.md"
  },
  "topics": [
    {
      "id": "1",
      "number": 1,
      "title": "Financial Statements & Accounting Equation",
      "obsidianFile": "Accounting/EXC3430 - Financial Accounting & Financial Management.md",
      "obsidianHeading": "",
      "keywords": ["balance sheet", "income statement", "equity"]
    }
  ],
  "collections": [
    { "id": "E23F", "title": "Autumn 2023 Final Exam (180 pts)", "kind": "exam" },
    { "id": "WF-MOCK-A", "title": "WISEflow Mock Exam A — NordicTech ASA (180 pts)", "kind": "mock_exam" }
  ],
  "sources": {
    "E23F": {
      "title": "Final Exam Autumn 2023",
      "canvasPath": "Accounting--2527/Files/..."
    }
  },
  "questions": [
    {
      "id": "acct-2527:WF-MOCK-A-E1",
      "localId": "WF-MOCK-A-E1",
      "courseId": "acct-2527",
      "topicId": "4",
      "collectionId": "WF-MOCK-A",
      "origin": "mock_exam",
      "kind": "calculation",
      "difficulty": 3,
      "points": 38,
      "title": "Mock Exam A · Exercise 1 — Cash Flow & Ratios (38 pts)",
      "promptMarkdown": "Markdown + LaTeX ($\\text{OCF}$, $$\\text{ROCE} = \\frac{\\text{EBIT}}{\\text{CE}}$$) tables and instructions.",
      "promptAssets": [],
      "contextMarkdown": "",
      "contextAssets": [],
      "svgDiagram": "",
      "options": [],
      "answerIndex": null,
      "wiseflowFields": [
        {
          "id": "ocf",
          "section": "Part A — Statement of Cash Flows",
          "label": "(a) Operating cash flow (OCF)",
          "type": "number",
          "expected": 412.0,
          "altExpected": [412.5],
          "relTol": 0.02,
          "absTol": 0.02,
          "unit": "£k",
          "points": 8,
          "note": "EBIT 340 + Depr 95 - ΔWC 23 = 412"
        },
        {
          "id": "gearing_verdict",
          "section": "Part B — Financial Interpretation",
          "label": "(b) Is the company high-geared (>50%)?",
          "type": "choice",
          "options": ["Yes — High-geared (> 50%)", "No — Moderately geared (≤ 50%)"],
          "answerIndex": 0,
          "points": 3
        }
      ],
      "rubricChecks": [
        "Compute Operating Cash Flow accurately",
        "Apply leading minus sign for cash outflows"
      ],
      "hints": [
        "Hint 1: Start from Operating Profit (EBIT) and add back non-cash depreciation.",
        "Hint 2: Working capital build-up is a cash outflow (enter outflows with a minus sign `-`)."
      ],
      "solutionMarkdown": "Step-by-step worked solution matching every WISEflow box.",
      "solutionAssets": [],
      "pitfall": "Never wrap outflows in parentheses `(50)` in WISEflow — always enter `-50`.",
      "obsidianLink": {
        "file": "Accounting/EXC3430 - Financial Accounting & Financial Management.md",
        "heading": ""
      },
      "pacing": {
        "learning": { "target": 46.0, "min": 35.0, "max": 60.0 },
        "exam": { "target": 38.0, "min": 30.0, "max": 44.0 },
        "stuckMinutes": 8.0,
        "reviewMinutes": 5.0,
        "hintHandicapSeconds": 60,
        "rationale": "38 exam points = 38 minutes on the 180-min BI WISEflow clock."
      },
      "available": true,
      "tags": ["wiseflow", "flowmulti", "mock-exam"]
    }
  ]
}
```

### WISEflow FLOWmulti (`wiseflowFields`) Contract
Any `calculation` or `written` question in **any** course (`acct-2527`, `econ-2522`, `math-2588`, etc.) automatically renders as an interactive WISEflow FLOWmulti multi-box worksheet whenever `wiseflowFields` is a non-empty array:
1. **`type: "number"` fields**:
   - `id` (required string, unique within question), `label` (required string), `expected` (required float/int).
   - Optional: `section` (group header), `altExpected` (array of floats accepted when carrying rounded intermediate numbers forward), `relTol` (default `0.02` = **±2% margin**), `absTol` (default `0.02` for 2-decimal rounding near zero), `unit` (display badge like `"£"`, `"%"`, `"NOK"`, `"units"` — user still types bare numbers), `points` (default `1`), `note` (concise formula shown after grading).
   - **BI WISEflow Input Rules enforced in `runner.js` (`203251--EXC3430_Title page exam_2026.pdf`)**:
     - Leading minus sign required for negatives (`-50` or `-4857.25`); accounting parentheses `(50)` trigger an explicit WISEflow format warning.
     - **Dot `.` required as decimal operator** (`7.25` or `0.893`); typing a decimal comma (`7,25` or `12,50`) is rejected with an explicit WISEflow warning (`commaError`), while valid 3-digit thousand separators (`1,520,000`) are stripped cleanly.
     - Passes if `|userValue - target| <= max(relTol * |target|, absTol)` for `expected` or any entry in `altExpected` (whole numbers by default unless 3-decimal rounding is announced).
2. **`type: "choice"` fields** (embedded Right/Wrong, Favourable/Adverse, Accept/Reject sub-dropdowns inside multi-part exercises):
   - `id` (required), `label` (required), `options` (string array, length >= 2), `answerIndex` (0-based int), `points` (default `1`).

### Valid Enum Values
- `origin`: `"original_exam"` | `"original_exercise"` | `"reading_submission"` | `"tutoring"` | `"lecture"` | `"textbook"` | `"mock_exam"` | `"synthetic_drill"`
- `kind`: `"mcq"` | `"calculation"` | `"written"` | `"coding"`
- `difficulty`: `1` (Foundation), `2` (Standard Exam), `3` (Multi-part / Case / Stretch)

---

## 3. Universal Productivity Index (`UPI`) & Accuracy-Gated "Beat the AI"

1. **Effective Attempt Time**:
   $$\text{EffectiveSec} = \text{ActiveElapsedSec} + (\text{HintsUsed} \times \text{HintHandicapSeconds})$$
2. **Quality Accuracy (`Q` in `[0, 1]`)**:
   - `mcq`: `1.0` if chosen option matches `answerIndex` on first check, else `0.0`.
   - `wiseflowFields` (`FLOWmulti`): points-weighted fraction `earnedPoints / totalPoints` across all numeric (`±2%`) and choice boxes.
   - `calculation` / `written` / `coding` (without `wiseflowFields`): fraction of `rubricChecks` passed (`checked / total`), or self-assessment rating (`solved = 1.0`, `partial = 0.6`, `retry = 0.0`).
3. **Accuracy-Gated Pace Ratio (`PR`), Working Session Clock, Focus Telemetry & Foveal Layout**:
   - If $Q < 0.60$: $\text{BeatAI} = \text{false}$ and speed cannot inflate efficiency.
   - **Zero-Hint Unassisted Beat-AI** triggers only when $Q \ge 0.85$, $\text{HintsUsed} = 0$, $\text{assisted} = \text{false}$, **and** $\text{EffectiveSec} \le \text{AIParSec}$.
   - **Universal 75m Working Session + Accumulated Screen & Off-Screen Time (`StudyUI.workClock`)**: Tracks continuous active **Screen Time** (`dayScreenSec`) and **Off-Screen Time** (`dayOffScreenSec` from `1:5` recovery breaks + unfocused away pauses), synced with backend `today.totalActiveMinutes` and `dlpfcBudget.todayAwayMinutes`, hard-capped at `75:00` (`4500s`) per wave with scaled `1:5` recovery breaks (`>20m` panoramic gaze + hydration + zero screens).
   - **Manual Pause + Automatic Window/Tab Focus-Loss Pause (`runner.js`)**: Clicking `#run-live-pill` (`P`) pauses manually; `Auto: Win` / `Auto: Tab` / `Auto: Off` automatically pauses both the question timer and the `75m` wave when another window or tab takes focus, logs each focus switch (`reason`, `leftAt`, `returnedAt`, `sec`, `focusSwitchCount`, `awayElapsedSec`) into `attempts.jsonl` and `sessions.jsonl`, and auto-resumes when focus returns.
   - **3-Phase Circadian dlPFC Routing + Topic Interleaving + Error-Driven Plasticity**: Routes tasks across `High-dlPFC (<15:00, 4.5h/day cap)`, `Med-dlPFC (15:00–18:00)`, and `Low-dlPFC (18:00+)`, round-robin interleaves `topicId` within each priority band, and applies a 2-tap early-peek guard on unseen `High-dlPFC` items.
   - **Foveal Minimal-Eye-Movement Layout vs Adaptive Split Reader (`runner.js` + `styles.css`)**: Compact tasks (MCQs without figures/tables, short written/calc/coding prompts `< 520` chars) automatically use a centered `690px` single-column Foveal Focus layout with a 1-line Par bar above the prompt, `2x2` grid for short 4-option MCQs, inline `Check Answer` -> `Next Question →` action bar directly below the options, and optional `1-Tap Check` MCQ mode. Multi-part WISEflow worksheets, PDF figures/tables, long cases, or active `Source PDF` / `Reference` tabs automatically switch to Split View (`V` / `#run-layout-btn` overrides per question).
   - **Hybrid Difficulty Adaptation (`POST /api/progress/difficulty`)**: Completion time vs AI Par + accuracy + hints auto-computes an FSRS-5 grade (`1..4`); users can optionally tap `Again · Hard · Good · Easy` in the solution panel to override `personalDifficulty` (`1..3`) and FSRS scheduling, or click `+ Queue Similar` when `Hard` / `Again` is selected.
4. **Universal Productivity Index (`UPI`, `100` = on-par with AI at 100% accuracy & full focus)**:
   Computed globally and across subgroups: `courseId`, `topicId`, `kind`, `profile` (`learning` / `exam`), `timeSlot` (`morning` / `afternoon` / `evening`), and check-in `tags`.

---

## 4. Step-by-Step AI Maintenance Recipes

### A. Validate All Banks, Assets, Catalog & Obsidian Dashboard
Always run after editing any `bank.json` or builder script:
```bash
python3 tools/cli.py rebuild-catalog
```
Checks required fields, duplicate IDs, image asset existence, and `wiseflowFields` integrity across all courses, then updates `data/catalog.json`, `data/logs/ai_context_snapshot.json`, and `../Obsidian Vault/01_Study_OS_Dashboard.md`.

### B. Add More Accounting WISEflow Mock Exams (e.g. `WF-MOCK-D`, `WF-MOCK-E`)
1. Open `tools/builders/build_acct_wiseflow_mocks.py`.
2. Follow `build_mock_a()` / `build_mock_b()` / `build_mock_c()` (180 points = 10 theory MCQs `[60 pts]` + 4 multi-box `wiseflowFields` exercises `[120 pts]` covering Financial Statements/Cash Flow/Ratios, Cost-Volume-Profit & Relevant Costing, Budgeting & Variances, and Capital Investment NPV/IRR/WACC).
3. Register the new collection (`{"id": "WF-MOCK-D", "title": "...", "kind": "mock_exam"}`) inside `enrich_accounting_bank()`.
4. Run `python3 tools/builders/build_acct_wiseflow_mocks.py && python3 tools/cli.py rebuild-catalog`.
5. The new paper automatically appears in **`🎓 Exam Simulator`** with both Blind WISEflow Sit and Guided Section Check buttons.

### C. Add a New Semester Course (e.g. Spring 2027)
1. Create `data/courses/<new-course-id>/assets/` and generate `data/courses/<new-course-id>/bank.json` following Section 2 above (cropping PDF figures from `../Canvas-Archive` via `./tools/render_pdf` if needed).
2. Run `python3 tools/cli.py rebuild-catalog` — `StudyStore.discover_courses()` auto-discovers every `data/courses/*/bank.json` and adds it to `Command Center`, `Courses & Banks`, `🎓 Exam Simulator`, `UPI & Telemetry`, and `Obsidian`.
3. To archive finished semester courses later without losing history, add `"archived": true` to the course's `bank.json`.

### D. Modify Backend or Frontend Code & Reload Running Server
1. Syntax-check edits before reloading:
   ```bash
   python3 -m py_compile app/server.py app/analytics.py app/calendar_sync.py app/obsidian_sync.py tools/cli.py
   node --check app/public/js/render.js && node --check app/public/js/runner.js && node --check app/public/js/app.js
   ```
2. Frontend (`app/public/*`) changes apply immediately on browser refresh (`server.py` sends `Cache-Control: no-store`).
3. If `app/*.py` changed and `Study OS.app` is already running in the background on port `8765`, gracefully restart the Python process **without** `--open` (so no extra browser window pops up):
   ```bash
   pkill -f "Study-OS/app/server.py" || true
   nohup python3 app/server.py >> "$HOME/Library/Logs/StudyOS/server.log" 2>&1 </dev/null &
   ```
