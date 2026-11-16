# Study-OS

Open-source (`MIT`), zero-dependency university practice engine, **WISEflow `FLOWmulti` (`±2%`) exam simulator**, **Multi-Semester Reference Hub**, and **Adaptive Timetable Studio** — built to pair seamlessly with **[`canvas-study-sync`](https://github.com/shadjosef/canvas-study-sync)** (cookie-session `Canvas-Archive` downloader) and **`Obsidian Vault`**.

Runs in **two modes from the exact same codebase**:
1. **Hosted Web Edition (GitHub Pages / Custom Domain)** — Zero install! Classmates open your domain to browse **Multi-Semester Reference Sheets** (with KaTeX math & SVG diagrams), practice copyright-safe **WISEflow `FLOWmulti` & mock exams**, and build custom study schedules in their browser (`localStorage`).
2. **Local Desktop Edition (`127.0.0.1:8765`, macOS & Windows)** — Plugs directly into a local **`Canvas-Archive`** (`canvas_session` cookie downloader) for 1-click course import, Side-by-Side Split PDF reading of university past papers, and OneDrive-synced FSRS-5 + `UPI` telemetry.

---

## Quick Start for Students (Local + `Canvas-Archive` Cookie Workflow)

1. **Sync your Canvas courses once via cookie session ([`canvas-study-sync`](https://github.com/shadjosef/canvas-study-sync))**:
   - Clone or unzip [`canvas-study-sync`](https://github.com/shadjosef/canvas-study-sync) into `Canvas-Archive/` and place `Study-OS/` right next to it (e.g. inside `Documents` or OneDrive).
   - Double-click **`Study OS.app`** / **`OPEN_STUDY_OS.command`** (macOS) or **`OPEN_STUDY_OS.cmd`** (Windows) — requires only **Python 3.9+ stdlib** (`0` pip packages).
   - Click **`Canvas Resync (Cookie Session)`** right inside Study-OS's Command Center, paste your `canvas_session` cookie in the private local window, and let `Canvas-Archive` download your PDFs, notebooks, and TimeEdit timetable.
2. **Plug `Canvas-Archive` into `Study-OS` in 1 click**:
   - Click **`Import Courses from Canvas-Archive`** in Study-OS (or run `python3 tools/cli.py sync-canvas --import-new`).
   - Study-OS automatically pairs past exam PDFs, solution guides, problem sets, and `.ipynb` notebooks into Study-OS's **Side-by-Side Split PDF Reader**!
3. **Build Your Adaptive Schedule (`Schedule Studio` Tab)**:
   - **Option 1 (Instant Auto-Scheduler)**: Paste your **TimeEdit `.ics` link** (or upload `.ics`) + enter your **weekly part-time job hours** (`0–45h/wk`). Study-OS automatically estimates sustainable self-study hours, adjusts for lectures + work, and slots `High-dlPFC (<15:00)` / `Med-dlPFC (15–18)` / `Low-dlPFC (18+)` blocks into open gaps (exportable back to `.ics`!).
   - **Option 2 (1-Prompt Any-LLM Copy/Paste — Zero API Keys)**: Click **`1. Copy Universal LLM Schedule Prompt`**, drop it into ChatGPT, Claude, Gemini, or a local on-device LLM (`Ollama` / `LM Studio`), and paste the returned `study-os-schedule-v1` JSON (or `.ics`) straight into **`2. Paste LLM Output`**.

---

## Core Capabilities

- **WISEflow `FLOWmulti` (`±2%`) & Exam Simulator**: Blind countdown sits or guided checks, enforcing dot-decimal `.` input, leading `-` outflows, `±2%` rounding tolerance, and carry-forward intermediate answers.
- **Multi-Semester Reference Hub**: Organizes authored Obsidian Semester Reference sheets (`Autumn 2026`, `Spring 2027`, …) with section search, KaTeX math, and embedded SVG diagrams.
- **Circadian dlPFC Cognitive Routing & 75m Flowtime**: Routes heavy novel derivations before `15:00` (`4.5h` High-dlPFC cap), interleaves topics, auto-pauses when window focus leaves, and enforces `1:5` off-screen recovery breaks.
- **FSRS-5 Spaced Repetition & Universal Productivity Index (`UPI`)**: Accuracy-gated `Beat-AI` pacing (`>=85%` accuracy, `0` hints) + FSRS-5 scheduling.

---

## Publishing Your Semester Hub to GitHub Pages + Free Student Domain

 With the **GitHub Student Developer Pack** (free `.me` / `.live` / `.tech` domain via Namecheap / Name.com + free HTTPS hosting on GitHub Pages):

```bash
# 1. Snapshot your authored Obsidian Reference Sheets + copyright-safe drills into site-pack/
python3 tools/build_public_site.py --sync-pack --cname yourdomain.me

# 2. Commit & push — .github/workflows/pages.yml automatically deploys to GitHub Pages!
git add . && git commit -m "chore: update semester reference pack" && git push
```

> **Copyright & Privacy Guarantee**: `data/` (personal telemetry, FSRS state, private builders in `data/local_builders/`, and copyrighted university PDFs/crops) is strictly `.gitignore`d. `build_public_site.py` exports **only** your authored reference sheets, SVGs, and synthetic/mock drills (`origin` in `synthetic_drill` / `mock_exam` without PDF image crops).

---

## CLI & AI Agent Maintenance

```bash
python3 tools/cli.py rebuild-catalog            # Validate schemas, assets & refresh Obsidian dashboard
python3 tools/cli.py sync-canvas --import-new   # Inspect Canvas-Archive & scaffold unimported courses
python3 tools/cli.py status                     # Print live UPI & course telemetry JSON
python3 tools/build_public_site.py --sync-pack  # Build static website bundle (./dist + ./site-pack)
```
