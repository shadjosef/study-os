# Study-OS Roadmap

This document tracks shipped architectural milestones and upcoming initiatives across Study-OS.

---

## Shipped Milestones

### Brand Identity, PWA v2 & WCAG AA Accessibility
- **Option B brand system & PWA v2 (`v2-option-b`):** Unified crisp icon set (`favicon.ico`, `pwa/favicon-48.png`, `pwa/favicon-96.png`, `pwa/study-os-192.png`, `pwa/study-os-512.png`) and hardened `app/public/offline-worker.js` with build-fingerprinted `v2-option-b` caches, network-first navigation, stale-while-revalidate static assets, automatic stale-cache eviction, and strict auth/API/self-cache exclusions.
- **Accessibility & performance guards:** Consistent semantic landmarks across the SPA and static hub (single `<h1>`, `<main id="main-content">`, `.skip-link`, `<nav aria-label>`, `alt` attributes), mobile `390×844` responsive overflow checks, and static landing-page Core Web Vitals (`CLS < 0.05`) enforced in headless Chromium CI (`tools/smoke_test_e2e.mjs`).

### Modular Core, Type Safety & Automated Verification
- **UMD-lite pure core (`app/public/js/core/`):** Extracted `fsrs.js` (FSRS-5 & DLPFC cognitive load), `grading.js` (BI WISEflow `FLOWmulti` parser/grader & ECTS scale), and `schedule.js` (circadian sleep windows, study-budget estimation, 14-day Study Debt rollover) with dual browser (`window.StudyCore`) and Node (`module.exports`) support.
- **Zero-dependency quality gates:** JSDoc TypeScript checking via `jsconfig.json`, 53+ zero-dependency `node --test` unit and edge-security tests (`tests/core.test.mjs`, `tests/worker/security.test.mjs`), SEO/GEO auditing (`tools/seo_audit.py`), and full CI automation (`.github/workflows/ci.yml`).

### Edge Backend Security Hardening & Disclosure Policy (`SECURITY.md`)
- **EU-resident Cloudflare Workers + D1 (`community/*.mjs`):** WebAuthn Passkeys, Google Sign-In (`RS256` JWKS verification), 5-minute 6-character device link codes, 160-bit hashed recovery keys, cross-device progress sync, timed Study Pods, 1v1 Elo Duels, and Adamlite streaming AI tutor (Gemini + Cloudflare Workers AI fallback).
- **Defense-in-depth hardening:** Strict CORS allowlist (zero wildcard reflection, no credentials header), 100% parameterized D1 SQL, Turnstile + Worker rate limiting (`AUTH_RATE_LIMIT`), streaming request size caps (`413`), prototype-pollution key filtering, strict TimeEdit/TP SSRF allowlist with `redirect: 'error'`, chunked private material quota enforcement with sandboxed download CSP, and formal disclosure policy in [`SECURITY.md`](../SECURITY.md).

### Multi-University Sync, IDE Companion, Inline WASM PDF & GEO Hub
- **Multi-university `Study-OS Sync` Chrome Extension (`v1.7.2`, MV3):** 1-click & opt-in auto-sync for 13+ Norwegian universities plus any `*.instructure.com` Canvas instance, TimeEdit/TP timetables, Ed Discussion, and local-only IndexedDB PDF handoff with zero password or cookie export.
- **VS Code / Antigravity / Cursor Companion (`v0.3.1`) & Local MCP Bridge:** 1-click `.ipynb` deep-links, automatic CSV dataset symlinks, per-subpart AI-Par CodeLens timers, completion sync back to Study-OS, and local FastMCP `stdio` tooling (`tools/study_os_mcp.py`) with blind-exam guardrails.
- **SEO / GEO Static Hub & Lazy PdfCraft WASM:** Lightweight `seo.css` landing pages, per-page `.md` mirrors, `/llms.txt` & `/llms-full.txt`, optional Cloudflare Edge GEO Worker (`community/edge-geo-worker.mjs`), and SHA-256-verified lazy-loaded PdfCraft WASM PDF editing.

---

## Planned Features & Upcoming Cycles

### 1. Early Post-Exam Attempt Verification & Privacy-Preserving Class Analytics
- **Private client-side attempt checker:** Let students compare their submitted WISEflow answers against early community/unofficial worked solutions privately in their browser (`localStorage`), with automatic matching by question text / Learnosity item UUID so per-student question and option shuffling still grades accurately.
- **Blind-aggregate anonymous cohort statistics (opt-in):**
  - Unauthenticated submission endpoint decoupled from Community profiles (zero profile keys, nicknames, or individual grade rows stored).
  - Client-salted SHA-256 nullifier to prevent duplicate counting without linking to an identity.
  - Persist only aggregate counters per exam: score histogram (for exact median, quartiles, and grade distribution), per-question accuracy tallies (`% correct` / `% skipped`), and running sufficient statistics (`n, sumX, sumY, sumXX, sumYY, sumXY` + coarse tier bins) for Pearson correlations between coarsened Study-OS metrics (study hours, accuracy, UPI, practice volume, break habits) and exam outcomes.
  - Enforce `k`-anonymity (`k >= 5` participants overall, `>= 3` per tier bin) before unlocking aggregate displays.
  - Optional future upgrade: 2-server Prio / additive secret-sharing + ZK range proofs so no single server sees an individual contribution even in transit.

### 2. Cross-Language Test Parity & Analytics Coverage
- Expand automated Python `unittest` coverage (`tests/python/`) for `app/analytics.py`, `app/dlpfc.py`, `app/timetable_planner.py`, and static site/SEO tooling alongside JS analytics/core tests (`tests/*.test.mjs`) to lock FSRS-5 and UPI parity across desktop and web.

### 3. Edge GEO Deployment & Multi-University Expansion
- Activate `community/edge-geo-worker.mjs` behind Cloudflare DNS for `studyos.no` to serve live `Accept: text/markdown` content negotiation and PII-free AI crawler telemetry.
- Expand university landing hubs, bilingual Norwegian/English study playbooks, and verified community course packs across NTNU, UiO, NHH, UiB, OsloMet, UiA, and international `*.instructure.com` schools.

### 4. Offline-First Sync Resilience
- Add deterministic field-level conflict resolution for multi-device FSRS card merges and study-debt state when switching between offline PWA sessions, mobile phones, and desktop Study-OS.
