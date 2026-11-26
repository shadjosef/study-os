# Security Policy

Study-OS is built as a local-first, zero-dependency student study workspace with strict data minimization and EU data residency for optional cloud features.

## Supported Surfaces

Security updates and hardening apply to the latest release on `main` across all active Study-OS surfaces:

| Surface | Location | Scope |
| --- | --- | --- |
| **Static Web App & PWA (`studyos.no`)** | `app/public/`, `tools/build_public_site.py` | Zero-build client SPA, offline service worker, KaTeX/PdfCraft WASM inline PDF reader, local IndexedDB vault |
| **Cloudflare Workers + D1 EU Backend** | `community/*.mjs`, `community/schema.sql` | Auth (Passkeys, Google OAuth, device link & recovery keys), cloud sync, leaderboard, study pods, 1v1 duels, AI tutor proxy, private material storage |
| **`Study-OS Sync` Chrome Extension (MV3)** | `canvas-sync-extension/` | Manifest V3 extension syncing Canvas LMS, TimeEdit/TP, and Ed Discussion metadata from signed-in browser tabs |
| **VS Code / IDE Companion** | `tools/study-os-vscode/` | `vscode://` notebook deep-linking, local CSV dataset symlinks, CodeLens AI-Par timer, completion sync |
| **Local Desktop Server & MCP Bridge** | `app/server.py`, `tools/study_os_mcp.py` | Loopback-only (`127.0.0.1:8765`) local workspace server and stdio MCP bridge for AI clients |

## Privacy & Security Architecture

### Local-First Browser Storage & Private PDF Vault
- **No account required:** Practice history, FSRS-5 scheduling state, timers, custom schedules, and optional user-supplied Gemini API keys stay in browser storage unless the student explicitly signs in.
- **Local IndexedDB PDF vault:** Textbooks, lecture slides, and synced Canvas PDFs (up to 260 MB per file) remain locally inside the browser's IndexedDB and render client-side via PdfCraft WASM — copyrighted Canvas PDFs are never uploaded to Study-OS servers.
- **Optional encrypted member archive:** Access strings decrypt local archive bundles in-browser using Web Crypto (`remember` mode uses non-extractable keys; `Lock full library` clears stored keys).

### Chrome Extension (`Study-OS Sync`, Manifest V3)
- **Zero password or cookie export:** Extension scripts only perform same-origin reads inside signed-in Canvas LMS, TimeEdit/TP, or Ed Discussion tabs authorized by the user. Passwords are never read and session cookies are never exported or transmitted to Study-OS.
- **Scoped permissions & opt-in telemetry:** Host permissions are restricted to explicit university LMS, timetable, Ed Discussion, and Study-OS API origins. Focus telemetry requires explicit user opt-in and Chrome's optional `tabs` permission, storing only daily domain-category minute counters (never full URLs, paths, or page titles).
- **Paired API access:** Extension cloud sync uses a revocable 6-character device link code scoped to explicit extension-only API paths (`extensionAllowedPaths`).

### Authentication, Edge API Hardening & EU Data Residency
- **Strong authentication:** Supports WebAuthn Passkeys (Face ID / Touch ID with atomic single-use challenges, RP ID hash verification, `crossOrigin` rejection, and signature counter validation), Google Sign-In (`RS256` JWT signature + `aud`/`iss`/`email_verified`/`exp`/`nbf` checks against Google JWKS), single-use 5-minute device link codes, and 160-bit recovery keys (stored only as SHA-256 hashes).
- **EU GDPR D1 residency:** Optional synced profiles, progress backups, study rooms, and private user materials are stored in Cloudflare D1 provisioned with `--jurisdiction eu`. Students can revoke individual sessions, unlink OAuth providers, or permanently delete their profile and cascading records at any time via `POST /delete-profile`.
- **Defense-in-depth Worker controls:**
  - Strict CORS origin allowlist (`WEB_ORIGIN` / `WEB_ADDITIONAL_ORIGIN`, optional pinned `CHROME_EXTENSION_IDS`), zero wildcard reflection, and `Access-Control-Allow-Credentials` never emitted.
  - Security headers across JSON, SSE, and binary responses (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on authenticated/token/sync responses, and `Content-Security-Policy: default-src 'none'; sandbox` on private material downloads).
  - 100% parameterized D1 SQL queries (`?` bindings, zero template interpolation), enforced request body byte caps (`413` on overflow), prototype-pollution key filtering, strict SSRF host allowlists (`cloud.timeedit.net`, `tp.educloud.no`, `tp.uio.no`) with `redirect: 'error'` and private/IP-literal blocking, Cloudflare Turnstile + Worker rate limiting on auth flows, and sanitized error responses with no stack-trace leakage.

### Local Server, VS Code Companion & MCP Bridge
- The desktop server binds to loopback (`127.0.0.1`) rather than public network interfaces, and the MCP bridge (`tools/study_os_mcp.py`) runs locally over `stdio`.
- Automated Worker security regression tests live in [`tests/worker/security.test.mjs`](tests/worker/security.test.mjs) (`node --test tests/worker/security.test.mjs`).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities, credential exposures, or exploitable bugs affecting live users.

1. **Preferred channel:** Submit a private report via **GitHub Security Advisories** at `https://github.com/shadjosef/study-os/security/advisories/new`.
2. **What to include:**
   - Affected surface (`studyos.no`, Worker route, Chrome extension, VS Code companion, or local server/MCP)
   - Clear reproduction steps or minimal proof of concept
   - Estimated impact and any suggested remediation
3. **Response targets:**
   - **Acknowledgement:** Within 72 hours
   - **Triage & status update:** Within 7 days
   - **Remediation:** Critical/high-severity issues affecting live student data or authentication are prioritized for immediate patching and coordinated disclosure after a fix is deployed.

Please test only against your own local instance or your own test account — never access or modify other students' profiles, rooms, or synced data.
