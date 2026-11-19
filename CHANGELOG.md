# Study-OS changelog

## 19 November 2026

- Upgraded Home course cards & scoring calibration: switching **`All · Easy · Medium · Hard`** now dynamically updates every course card's `done/total`, progress bar, `revisit`, and `UPI` for that exact difficulty; added a **`25m · 50m · 75m`** study block selector right on Home (default **`50m`**); tightened MCQ AI Pars to realistic timings (e.g. `0:50–1:15` Easy Practice / `0:35–0:55` Exam instead of `4:00`); and made UPI reward **Hard** (`1.22×`) and **Exam Par** (`1.08×`) while conservatively weighting self-graded written tasks (`0.45×`, pace capped at `1.0×`).
- Upgraded the in-house **Study-OS Sync Chrome extension** (`canvas-sync-extension/` v1.2.0) to sync **BI Canvas** (courses, module headings & private personal deadlines), **BI TimeEdit** (1-click timetable push directly to Schedule across desktop & phone), and **Ed Discussion** (course linking) directly to **studyos.no** via a 6-char device pairing code — with default-public, deduplicated **Community Courses** where multiple students refreshing the same course contribute directly to the existing course without duplicates, plus `✨ AI Study` & Admin Verify/Hide controls.
- Upgraded the mobile and desktop interface with **iOS 26/27 Liquid Glass** polish: added a floating frosted-glass **Mobile Bottom Tab Bar**, compacted mobile Home (`138px → 52px`) and Runner (`175px → 52px`) headers, anchored a thumb-reachable Runner action bar, and fixed Google Sign-In button overflow on narrow phones.
- Added a **Home difficulty selector (`All · Easy · Medium · Hard`)** with full **75-minute AI-Par study blocks** across Home course cards and Course Explorer defaults, and lowered end-of-run feedback friction so normal sessions save silently with a Dynamic Island toast (check-in appears only on 45m+ deep sessions or submitted blind exams).
- Added a built-in **✨ Socratic AI Tutor** inside practice questions (`T` shortcut or `✨ AI` pill) powered out-of-the-box by **Cloudflare Workers AI** (free tier, per-user daily cap) plus optional on-device **Personal Free Gemini Key (BYOK)** support for **Gemini 4 Hydrogen**, **Gemini 3.8 Flash**, and **Gemini 3.5 Flash-Lite**.
- Added **Continue with Google** (Google Identity Services + RS256 JWKS verification in Cloudflare Workers & D1): one-click sign-in across iPhone, Mac, Windows, and Android, invite-gated first-time onboarding, and Google account linking/disconnecting in **Settings → Passkeys & Linked Devices** (activates dynamically when `GOOGLE_CLIENT_ID` is configured on the Worker).
- Added **Face ID / Touch ID Passkey sign-in** (WebAuthn), **5-minute 6-character cross-device link codes** (`K7M-9P2`), **multi-device session management**, and **automatic cross-device Cloud Progress Sync** (answers, FSRS intervals, sessions, and custom schedules synced via Cloudflare D1 EU) — all accessible from the revamped Sign-In sheet and **Settings → Account & Sync**.
- Upgraded the full Study-OS interface to an **iOS 26/27 Liquid Glass** design system: floating frosted-glass navigation and runner capsules, concentric pill/squircle geometry, Bento course cards with accent rims and next-exam countdown, a calmer Zen runner card with a collapsible `•••` tools menu, Dynamic Island toasts, a `⌘K` / `Ctrl+K` **Quick Jump** spotlight palette, and automatic asset cache-busting (`?v=<hash>`) + network-first Service Worker updates so new releases appear immediately on reload.
- Decluttered the global navigation bar, Home screen, Course Explorer, and Runner topbar, and introduced an **iOS-style Settings** sheet (press `,` or click **Settings**) with live search, grouped inset cards, iOS switches, segmented controls, and collapsible Soundscape & EQ controls — housing Dark Mode, PDF Dark Mode, Background Sound, Auto-Pause, Fullscreen, Layout Presets, AI Tutor, Sync/Admin tools, Library unlock, Offline copy, and Export/Import Backup.
- Added a **Community Admin** panel (available anytime to Admin profiles on the Community tab) to pause/open signups, create/revoke/delete hashed invite codes and custom join strings (with optional max uses & expiry), disable the legacy env invite code, and manage members (rename, reset 30-day nickname lock, remove).
- Added **Edit profile & PFP** and **Break tracking** in Community: upload a cropped profile photo or choose a preset avatar, set an optional short bio, update your nickname once every 30 days (unlimited for Admin), and track total break time, break count, average break length, and break frequency per study hour on profiles and the leaderboard. Avatars also appear across global chat, direct messages, study rooms, and duel Elo rankings.
- Added a live **AI tutor** MCP bridge (`get_current_exercise`, `list_course_files`, default Socratic tutoring instructions, hosted-site desktop bridge, and `docs/ai-tutor.md`) plus a desktop **Admin** panel for linking local PDF pages to exercises.
- Added **Try demo (no code needed)** mode so visitors can explore practice questions and study notes without a Community invite code.
- Start Canvas Sync, follow sync progress, and import new courses from the desktop Study-OS hub.
- Paste credentials from the clipboard and sync Ed alone or alongside Canvas. Reuse an Ed token saved in the computer's secure store.
- Add your own books and slides to a course through Canvas Sync. Open local PDFs in the course library.
- Reorganized the break controls for narrow windows and fixed the course list overlapping notes while scrolling.

## 18 November 2026

- Added a 12-problem mock for the Autumn 2026 Mathematics exam.
- Renamed practice difficulty to Easy, Medium and Hard.
- Added a course library with question references beside exercises and a searchable index of original files.
- Added a local MCP bridge for question search, reports and schedule updates.
- Added AI-created study sets with one-click import from the Study-OS MCP tool.
- Added break-time layout presets with optional dlPFC labels and a daily practice budget. Share a preset as a copyable code.
- Break tools lock at zero before 20:00 Oslo time. Add one minute to reopen them or start your next session. Evening access runs until midnight.
- Added the option to remember the full-library key on this browser.
- Added inline zoom and margin trimming for task excerpts and source PDFs. Drag the split divider to change the pane widths.
- Added the 4 December Mathematics for Data Science exam date and countdown.
- Copy the full exercise, or choose **Copy for AI**, to get the question text, your answers, and any revealed solution without the surrounding controls.
- Split keeps the task and answers side by side in narrow browser windows.
- Pinch over a PDF or exam excerpt to zoom the document in place.
- Simplified worksheet labels and grading feedback.

## Community

- Every Community profile appears on the members-only leaderboard with hours, completed questions, attempts and practice accuracy.
- The leaderboard, global chat and direct messages open during a timed Study-OS break. The leaderboard also shows the current timer status of active Community members.
- The Community-enabled site requires a display name on the study leaderboard. The invite code is separate from the course library key.
- Members can share study sets on break and save them for solo practice. Custom sets stay outside community and Elo scoring.
- Group study rooms sync a 25-minute session and live practice counts. Rated maths duels have a five-minute round and a separate Elo leaderboard.
