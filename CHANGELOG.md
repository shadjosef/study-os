# Study-OS changelog

## 19 November 2026

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
