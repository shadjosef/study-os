## Summary

<!-- Briefly describe what this PR changes and why. Link any related issues (`Closes #...`). -->

## Type of change

- [ ] Bug fix
- [ ] Feature / enhancement
- [ ] Security hardening
- [ ] Performance / Accessibility / PWA improvement
- [ ] Tests / CI / Documentation

## Verification

Run the applicable checks locally before requesting review (see [`CONTRIBUTING.md`](CONTRIBUTING.md)):

- [ ] Python syntax & warnings: `python3 -Werror -m py_compile app/*.py tools/*.py tools/study-os-vscode/build_vsix.py`
- [ ] Python unit tests (if applicable): `python3 -m unittest discover -s tests/python -v`
- [ ] JS syntax check (`node --check`) & JSDoc typecheck (`tsc --noEmit -p jsconfig.json`)
- [ ] Node unit & Worker security tests: `node --test tests/core.test.mjs tests/worker/security.test.mjs`
- [ ] Static site build & SEO/GEO audit: `python3 tools/build_public_site.py --out /tmp/study-os-dist && python3 tools/seo_audit.py --dir /tmp/study-os-dist`
- [ ] Headless Chromium E2E smoke & regression suite: `node tools/smoke_test_e2e.mjs /tmp/study-os-dist`

## Guardrails

- [ ] No live student data (`data/state/*`, `data/logs/*`), personal secrets, or copyrighted course PDFs are committed.
- [ ] Zero runtime npm/pip dependencies added to the core web app, Worker, or Python desktop app.
- [ ] Any `community/*.mjs` SQL queries use 100% parameterized `?` bindings and preserve strict CORS/SSRF/header controls.
- [ ] If touching `canvas-sync-extension/`, Chrome Web Store MV3 rules (`description <= 132` chars, minimal permissions, zero cookie/password export) and active review-window impact were verified.
