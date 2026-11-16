# Study-OS Agent Guidance

Resolve all paths relative to this directory (`Study-OS`). Handing this folder to any AI coding agent (Antigravity, Claude Code, Codex, Cursor) provides everything needed to maintain, extend, rebuild, or publish `Study-OS`.

1. **Read `AI_AGENT_PROTOCOL.md` first** — documents the module map (`app/`, `tools/`, `obsidian-plugin/`, `examples/`, `site-pack/`, `data/`), the `bank.json` + WISEflow `FLOWmulti` (`wiseflowFields` `±2%` / dot-decimal) schema, `study-os-schedule-v1` calendar JSON, and maintenance recipes.
2. **Protect Live Student Data (`CRITICAL`)**:
   - `data/state/progress.json`, `data/logs/attempts.jsonl`, and `data/logs/sessions.jsonl` hold **live study progress, FSRS memory states, Personal Bests, and session check-ins**.
   - **NEVER** wipe, overwrite, or inject synthetic test attempts/sessions into those files. Read `data/logs/ai_context_snapshot.json` (or run `python3 tools/cli.py status`) to inspect current student telemetry.
3. **Course Builders, `Canvas-Archive` Import & Public Site**:
   - Universal `Canvas-Archive` auto-import lives in `app/canvas_bridge.py` (`python3 tools/cli.py sync-canvas --import-new`).
   - Any private university-specific exam builders live in `data/local_builders/` (gitignored so copyrighted past-exam text never enters public Git).
   - Static GitHub Pages / custom-domain builds run via `python3 tools/build_public_site.py --sync-pack`.
   - After modifying any `bank.json` or builder, always run `python3 tools/cli.py rebuild-catalog` and verify zero schema/asset errors.
4. **Sibling Ecosystem Boundaries**:
   - `../Canvas-Archive`: Strictly **read-only** source for Canvas PDFs, notebooks, TimeEdit `CURRENT.json`, and `Canvas Resync` cookie-session launcher. Never overwrite `canvas-sync` outputs or `.canvas-sync.json`.
   - `../Obsidian Vault`: Canonical multi-semester reference notes. Only `../Obsidian Vault/01_Study_OS_Dashboard.md` is auto-written by `app/obsidian_sync.py`.
   - Google Calendar (`app/calendar_sync.py`): Strictly **read-only**.
