# Study-OS Browser Sync Extension (Canvas · TimeEdit · Ed Discussion)

One lightweight in-house Chrome extension syncs your **BI Canvas** courses & personal deadlines, **BI TimeEdit** timetable, and **Ed Discussion** courses directly to your **studyos.no** account — with zero token copying and zero local Python server required.

## Install once (30 seconds)
1. Download or clone the `canvas-sync-extension/` folder from this repository.
2. Open Chrome → go to `chrome://extensions` → toggle **Developer mode** ON.
3. Click **Load unpacked** and select the `canvas-sync-extension` folder.
4. Pin **Study-OS Sync** to your Chrome toolbar.

## Pair once with studyos.no
1. Sign in at **https://studyos.no/** (with Google, Passkey, or nickname).
2. Open **Settings → Passkeys & Linked Devices** (or **Schedule → Get 6-char pairing code**) and click **Generate 6-char code** (e.g. `K7M-9P2`).
3. Click the **Study-OS Sync** extension icon, paste the 6-char code, and click **Connect to Study-OS**.
   - *(Optional: Desktop Study-OS users can still paste a 24-character desktop code from `http://127.0.0.1:8765/canvas-connect.html`.)*

## One-click recurring sync
Click the **Study-OS Sync** icon while on any of these signed-in tabs:
- **BI Canvas (`https://canvas.bi.no`):** Syncs your active courses, module/syllabus topic headings, and personal assignment deadlines.
  - **Default-public deduplicated Community Courses:** By default, course codes, titles, and copyright-safe module headings are added/merged directly into the **Community Courses** catalog on `studyos.no` (deduplicated by course code — when another student refreshes the same course, it contributes to the existing course without creating duplicates). Uncheck *"Share course catalog to Community"* in the popup anytime to keep your courses private.
  - **Personal & copyright safety:** Your personal assignment deadlines stay private to your own account, and copyrighted course PDFs/books are **never** uploaded to public servers.
- **BI TimeEdit (`https://cloud.timeedit.net`):** Open your schedule view in TimeEdit and click **Study-OS Sync** — your timetable automatically syncs to **Schedule** on both desktop and phone so Study-OS plans study blocks around your real lectures, work hours, and sleep.
- **Ed Discussion (`https://eu.edstem.org` / `https://edstem.org`):** Links your active Ed Discussion courses directly onto matching Community courses by course code (no duplicate courses, no private posts uploaded).
