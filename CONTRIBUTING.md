# Contributing to Study-OS

Thank you for contributing to Study-OS! Study-OS is a free, open-source (`MIT`), local-first university study workbench built for reliability during exam season.

Before opening a pull request, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system layout and [`SECURITY.md`](SECURITY.md) for privacy and security boundaries.

---

## Engineering Principles

1. **Zero frontend build step & zero runtime dependencies:**
   - The web app (`app/public/`) runs directly in modern browsers as vanilla HTML, CSS custom properties, and ES/IIFE JS — no Webpack, Vite, React, or runtime `node_modules`.
   - The desktop server (`app/server.py`), analytics/FSRS engine (`app/analytics.py`, `app/dlpfc.py`), and build/audit CLIs (`tools/*.py`) use **Python 3.9+ standard library only** (the standalone MCP bridge `tools/study_os_mcp.py` uses PEP 723 inline `uv` metadata for `mcp` and `pypdf`).
   - The Cloudflare Worker (`community/*.mjs`) uses Web Standards APIs + Cloudflare D1/Workers AI bindings with zero npm runtime dependencies.
2. **Pure, testable core modules:**
   - Put pure algorithms (FSRS-5 scheduling, WISEflow grading, circadian DLPFC scheduling, analytics math) in UMD-lite modules under `app/public/js/core/` that populate `window.StudyCore` in browsers and `module.exports` in Node.
   - Annotate exported functions and types with JSDoc so `tsc --noEmit -p jsconfig.json` catches type/nullability regressions with zero transpilation.
   - Keep FSRS-5 and DLPFC behavior aligned across Python (`app/analytics.py`, `app/dlpfc.py`) and JS (`app/public/js/core/fsrs.js`, `app/public/js/core/schedule.js`).
3. **Local-first privacy & accessibility by default:**
   - Cold visitors on `studyos.no` must be able to practice immediately without a signup wall.
   - All public pages must preserve WCAG AA landmarks (single `<h1>`, `<main id="main-content">`, `.skip-link`, `<nav aria-label>`, `alt` on every `<img>`), zero horizontal overflow at `390×844`, and static landing page `CLS < 0.05`.

---

## Local Development Setup

```bash
git clone https://github.com/shadjosef/study-os.git
cd study-os

# Start the loopback-only local desktop server (http://127.0.0.1:8765)
python3 app/server.py

# Validate course banks, assets, and rebuild catalog metadata
python3 tools/cli.py rebuild-catalog
```

*(On Windows, install `tzdata` once via `py -3 -m pip install tzdata` for `Europe/Oslo` timezone support.)*

---

## Verification & Test Commands

Run the relevant checks below before opening a pull request — CI (`.github/workflows/ci.yml`) runs every one of them on pushes and PRs to `main`:

### 1. Python bytecode, warning & unit test checks
```bash
python3 -Werror -m py_compile app/*.py tools/*.py tools/study-os-vscode/build_vsix.py
python3 -m unittest discover -s tests/python -v   # runs whenever tests/python/ exists
```

### 2. JavaScript syntax & JSDoc TypeScript checks
```bash
for f in \
  app/public/js/*.js \
  app/public/js/core/*.js \
  app/public/offline-worker.js \
  canvas-sync-extension/*.js \
  community/*.mjs \
  tools/study-os-vscode/*.js \
  tools/smoke_test_e2e.mjs \
  obsidian-plugin/main.js; do
  node --check "$f"
done

# Type-check app/public/js/core/*.js via JSDoc without adding repo node_modules
npx --yes -p typescript tsc --noEmit -p jsconfig.json
```

### 3. Node core & Worker security tests
```bash
# Runs tests/core.test.mjs, tests/worker/security.test.mjs, and any other tests/**/*.test.mjs
node --test $(find tests -name '*.test.mjs' -type f | sort)
```

### 4. Static site build & SEO/GEO audit
```bash
python3 tools/build_public_site.py --out /tmp/study-os-dist
python3 tools/seo_audit.py --dir /tmp/study-os-dist
```

### 5. Headless Chromium E2E smoke & regression tests
```bash
mkdir -p /tmp/pw-ci
npm --prefix /tmp/pw-ci install --no-save playwright-core@latest
PLAYWRIGHT_MODULE=/tmp/pw-ci/node_modules/playwright-core \
  node tools/smoke_test_e2e.mjs /tmp/study-os-dist
rm -rf /tmp/study-os-dist
```

`tools/smoke_test_e2e.mjs` verifies:
- Cold-visit `/` SPA boot with zero blocking login wall
- Interactive WISEflow FLOWmulti (`/wiseflow-practice.html`) and ECTS GPA calculator (`/gpa-calculator.html`) flows
- A11y landmarks & semantics across 7 core pages
- Static landing page Core Web Vitals (`CLS < 0.05`)
- Mobile `390×844` zero horizontal overflow
- PWA `offline-worker.js` registration, `v2-option-b` cache creation, Option B icon precaching, and zero self-caching
- Zero uncaught page errors, zero console errors, and zero same-origin 4xx/5xx responses

---

## Strict Repository Guardrails

### Never commit student data or copyrighted material
- **`data/` is strictly local/personal:** Never commit, wipe, or inject synthetic entries into `data/state/progress.json`, `data/logs/attempts.jsonl`, or `data/logs/sessions.jsonl`.
- **Private exam builders & copyrighted PDFs:** Keep university-specific copyrighted past-exam builders inside gitignored `data/local_builders/`. Public static bundles (`site-pack/` and `tools/build_public_site.py`) must only include copyright-safe practice items, original reference notes, and synthetic/mock drills.

### Chrome Extension (`canvas-sync-extension/`) review-window discipline
- `Study-OS Sync` is published to the Chrome Web Store as a Manifest V3 extension.
- **Avoid churn during active CWS review windows:** Batch non-urgent extension changes rather than submitting overlapping updates while a release is in Chrome Web Store review.
- **Permission minimalism:** Keep `manifest.json` `description <= 132` chars, never request broad `<all_urls>` permissions, never read passwords or export session cookies, and keep optional permissions (`tabs`, `http://127.0.0.1/*`) strictly opt-in.
- Update `docs/chrome-web-store-submission.md` whenever permissions, disclosures, or store assets change.

### Edge Backend Security (`community/*.mjs`)
- Use **100% parameterized D1 SQL queries** (`?` bindings) — never interpolate user input into SQL strings.
- Preserve strict CORS origin allowlists (no wildcard reflection, no `Access-Control-Allow-Credentials`), request body byte caps (`413`), prototype-pollution key filtering, SSRF timetable host allowlists with `redirect: 'error'`, and security response headers.
- Add or update regression tests in `tests/worker/security.test.mjs` for every new endpoint or auth/security change.

---

## Pull Request Process

1. Branch from `main` with a focused, descriptive name (e.g., `fix/wiseflow-tolerance` or `feat/ntnu-schedule-import`).
2. Keep commits clean and scoped — avoid mixing unrelated formatting changes with functional fixes.
3. Complete the verification and guardrail checkboxes in the pull request template.
4. For security vulnerabilities, **do not** open a PR or public issue; follow [`SECURITY.md`](SECURITY.md).
