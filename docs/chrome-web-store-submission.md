# Publishing **Study-OS Sync** to the Chrome Web Store

This guide contains every copy-paste field, permission justification, privacy declaration, and asset path needed to publish `canvas-sync-extension/` (`v1.3.1`, Manifest V3) to the Chrome Web Store.

---

## 1. Upload Package & Graphic Assets

| Asset | Exact path | Notes |
| --- | --- | --- |
| **Extension ZIP** | `https://studyos.no/downloads/study-os-sync-extension.zip` (built by `python3 tools/build_public_site.py`) | Manifest V3 (`v1.3.1`), `icons/` included, `store-assets/` excluded |
| **Store Icon (128×128)** | `canvas-sync-extension/icons/icon-128.png` | Bundled in ZIP and ready for CWS Store Icon |
| **Small Promo Tile (440×280)** | `canvas-sync-extension/store-assets/promo-small-440x280.png` | 24-bit RGB PNG, no transparency |
| **Screenshot 1 (1280×800)** | `canvas-sync-extension/store-assets/screenshot-1280x800.png` | 24-bit RGB PNG, no transparency |

> **Tip:** To rebuild a fresh ZIP locally at any time:
> ```bash
> python3 tools/build_public_site.py --out /tmp/study-os-cws-dist
> open /tmp/study-os-cws-dist/downloads/
> ```

---

## 2. One-Time Chrome Web Store Developer Registration

1. Open **https://chrome.google.com/webstore/devconsole** signed in to the Google account that will own the extension.
2. Pay the one-time **\$5 USD** Chrome Web Store developer registration fee (if not already registered).
3. In **Account**, set a contact email (e.g. `contact@studyos.no` or your developer email) and verify it.
4. Click **+ New Item** → upload `study-os-sync-extension.zip`.

---

## 3. Store Listing Fields (Copy-Paste)

- **Name:** `Study-OS Sync`
- **Summary (132 chars max):**
  `One-click sync for BI Canvas courses & deadlines, TimeEdit schedules, and Ed Discussion directly into Study-OS.`
- **Detailed Description:**
  ```text
  Study-OS Sync connects your signed-in BI Norwegian Business School tabs to your Study-OS workspace (https://studyos.no) in one click — no OAuth apps, no manual API keys, and no copying session cookies.

  WHAT IT SYNCS
  • BI Canvas (canvas.bi.no): active courses, module outlines, assignment titles, and due dates.
  • TimeEdit (cloud.timeedit.net): your class timetable (.ics / JSON schedule events) into Study-OS Schedule Studio.
  • Ed Discussion (edstem.org / eu.edstem.org): your course list and recent discussion thread titles.

  HOW IT WORKS
  1. Open studyos.no → click "Sync BI" → generate a 6-character pairing code once.
  2. Paste the code into the Study-OS Sync extension popup.
  3. Keep your signed-in BI Canvas, TimeEdit, or Ed tab open and click "Sync open tabs" once.

  PRIVACY & SECURITY
  • Runs ONLY when you click Sync — zero background tracking or continuous scraping.
  • Never reads, stores, or transmits your BI password, Canvas session cookies, or grades.
  • All requests run inside your own open browser tab with same-origin permissions, and only structured course/deadline/timetable metadata is sent to your Study-OS profile.
  • Open source & independent student project: https://studyos.no/privacy.html
  ```
- **Category:** `Education` (or `Productivity`)
- **Language:** `English`
- **Homepage URL:** `https://studyos.no`
- **Support URL:** `https://studyos.no` (or GitHub Issues URL)
- **Privacy Policy URL:** `https://studyos.no/privacy.html`

---

## 4. Privacy Practices Tab (Copy-Paste Justifications)

### Single Purpose Description
```text
Sync the signed-in student's BI Canvas courses/deadlines, TimeEdit timetable events, and Ed Discussion course titles from already open browser tabs into their Study-OS account upon an explicit popup click.
```

### Permission Justifications

- **`scripting`:**
  ```text
  Injects small, strictly on-demand collector functions into the user's already open BI Canvas, TimeEdit, or Ed Discussion tab only when the user clicks "Sync" in the extension popup, reading course titles, assignment deadlines, timetable events, and Ed thread titles via same-origin requests without touching cookies or credentials.
  ```
- **`storage`:**
  ```text
  Stores the user's Study-OS pairing token (issued after pasting a one-time 6-character code from studyos.no), display nickname, and public/private sharing toggle locally in chrome.storage.local.
  ```
- **Host permissions (`canvas.bi.no`, `cloud.timeedit.net`, `*.edstem.org`, `shadjosef-study-os.shadjosef-study-os.workers.dev`):**
  ```text
  Explicitly scoped to the three BI Norwegian Business School student portals (BI Canvas, TimeEdit, and Ed Discussion) so the extension can detect open tabs and run on-demand collectors only on those origins, plus the Study-OS Cloudflare Worker API endpoint where the synced course/schedule JSON payload is uploaded for the user's paired Study-OS profile. Localhost (http://127.0.0.1/*) is strictly an optional_host_permission for local desktop development.
  ```
- **Are you using remote code?**
  - Select **No, I am not using remote code.** (All JavaScript is bundled in `background.js` and `popup.js`; zero external scripts or `eval`.)

### Data Usage Disclosures
- Check **Website content** (specifically user-initiated course names, module titles, assignment due dates, timetable events, and Ed thread titles sent to Study-OS when the user clicks Sync).
- Check **Authentication information** ONLY if prompted for the Study-OS pairing token stored in `chrome.storage.local` (note: zero Canvas/BI credentials or cookies are ever collected).
- Certify all 3 Limited Use checkboxes:
  - [x] I do not sell or transfer user data to third parties, outside of the approved use cases
  - [x] I do not use or transfer user data for purposes that are unrelated to the item's single purpose
  - [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Reviewer Test Instructions (Distribution / Testing Notes)
```text
This extension is built for BI Norwegian Business School students who have active accounts on canvas.bi.no, cloud.timeedit.net, and edstem.org.
To verify the pairing flow without BI student credentials:
1. Open https://studyos.no, sign in (or join with a nickname), and click "Sync BI" on the home screen.
2. Click "Generate 6-character code" and paste the code into the Study-OS Sync extension popup to confirm pairing succeeds.
3. The extension does not run any background scraping; syncing only activates when the user opens one of the three BI portals and explicitly clicks the Sync button.
```

---

## 5. After Approval

Once Google approves the listing (~1–3 business days):
1. Copy your published Chrome Web Store URL (`https://chromewebstore.google.com/detail/study-os-sync/<EXTENSION_ID>`).
2. Update the `Install extension` button in `app/public/js/app.js` (`openSyncBiModal`) to link straight to the Chrome Web Store page (keeping the `.zip` download as a fallback for developers).
