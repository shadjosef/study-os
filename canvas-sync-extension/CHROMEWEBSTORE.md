# Chrome Web Store Listing — Study-OS Sync

> Last Updated: 2026-11-24

## Store Listing

**Extension Name** [REQUIRED]
Study-OS Sync

**Short Description** [REQUIRED]
One-click & auto-sync for Canvas LMS (BI, UiA, NHH, UiO, NTNU+), TimeEdit/TP timetables, Ed Discussion & opt-in focus stats.

**Detailed Description** [REQUIRED]
Study-OS Sync connects your signed-in university Canvas LMS, TimeEdit or TP class timetable, and Ed Discussion tabs directly to your Study-OS dashboard in one click.

Key Features
One-click sync across Canvas LMS (BI, UiA, UiB, UiO, NTNU, OsloMet, NHH, UiS, UiT, USN, NMBU, HVL, Kristiania, and any Instructure Canvas school), TimeEdit and Norwegian TP timetables, and Ed Discussion.
Automatic background refreshes whenever you open your signed-in school tabs (Canvas and Ed every 12 hours, timetables every 3 days), with a one-click toggle to pause auto-sync anytime.
Direct in-browser Canvas PDF viewing inside Study-OS: opens your lecture slides using your own signed-in browser session so copyrighted course files never touch external servers.
Opt-in on-device browser focus stats: when explicitly enabled by you, tallies daily Study vs. Distraction vs. Other category minutes locally on your device without storing URLs, page titles, or browsing history.
Optional community course catalog sharing that contributes course codes and module headings while keeping your personal deadlines and timetable strictly private.

How to Use It
1. Open studyos.no, click Sync Canvas, and generate a 6-character pairing code.
2. Click the Study-OS Sync toolbar icon and paste your 6-character code once to connect.
3. Open your signed-in Canvas, TimeEdit/TP, or Ed Discussion tab and click Sync — your courses, module topics, deadlines, and lecture schedule appear immediately in Study-OS.

Privacy & Security
Study-OS Sync works strictly through your existing signed-in browser tabs and never asks for your school username, password, or Feide login. Your Canvas session cookies and Ed Discussion session tokens are never stored or transmitted to Study-OS servers, Canvas PDF files stay strictly on your own device, and opt-in focus categories store only daily numeric totals locally.

Support
Questions, school requests, or bug reports: visit https://studyos.no or contact the developer email listed below.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Syncs a student's signed-in university Canvas LMS courses and deadlines, TimeEdit/TP class timetables, Ed Discussion courses, and optional local study-focus category totals into their Study-OS dashboard.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 PNG | ✅ Ready | `store-assets/screenshot-1280x800.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 PNG | ✅ Ready | `store-assets/promo-small-440x280.png` |
| Demo Animation (web/docs only, excluded from ZIP) | — | ✅ Ready | `store-assets/study-os-sync-demo.gif` |

---

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `scripting` | `permissions` | Runs lightweight read-only extraction inside the student's already signed-in Canvas LMS, TimeEdit/TP timetable, and Ed Discussion tabs when syncing, so Study-OS never needs school passwords or API keys. |
| `storage` | `permissions` | Stores the Study-OS pairing token, display nickname, auto-sync preference, community-catalog opt-in, last synced timestamps, and optional local daily focus category totals on-device (`chrome.storage.local` / `chrome.storage.session`). |
| `alarms` | `permissions` | Schedules reliable periodic checks when the user opts into on-device study focus category totals (30-second sampling) and clears sync-confirmation badges cleanly after background sleep. |
| `tabs` | `optional_permissions` | Requested **only** if the student explicitly turns on "Browser Focus Categories" in the popup; inspects only the active tab's hostname in memory to increment a local Study/Distraction/Other counter without ever saving URLs, paths, or page titles. |
| `https://canvas.bi.no/*`, `https://*.instructure.com/*`, `https://canvas.uia.no/*`, `https://mitt.uib.no/*`, `https://canvas.uio.no/*`, `https://canvas.ntnu.no/*`, `https://canvas.oslomet.no/*`, `https://canvas.nhh.no/*`, `https://canvas.uis.no/*`, `https://canvas.uit.no/*`, `https://canvas.usn.no/*`, `https://canvas.nmbu.no/*`, `https://canvas.hvl.no/*`, `https://canvas.kristiania.no/*` | `host_permissions` | Detects open Canvas LMS tabs across Norwegian universities and Instructure Canvas schools, reads active course titles, module headings, and assignment deadlines, and fetches Canvas PDF lecture slides locally inside the browser. |
| `https://instructure-uploads-eu.s3.eu-west-1.amazonaws.com/*`, `https://instructure-uploads-eu.s3.amazonaws.com/*`, `https://instructure-uploads.s3.amazonaws.com/*` | `host_permissions` | Canvas redirects PDF downloads to temporary signed Instructure S3 URLs; allows following those redirects to return PDF bytes strictly to the student's local `studyos.no` tab without uploading copyrighted files to any server. |
| `https://cloud.timeedit.net/*`, `https://tp.educloud.no/*`, `https://tp.uio.no/*` | `host_permissions` | Detects open TimeEdit or Norwegian TP timetable tabs and reads their `.ics` / iCal schedule feeds to populate the student's Study-OS class schedule. |
| `https://edstem.org/*`, `https://eu.edstem.org/*`, `https://us.edstem.org/*`, `https://au.edstem.org/*` | `host_permissions` | Detects signed-in Ed Discussion tabs and reads enrolled course titles and category headings. Any in-tab Ed session token is read strictly in memory to query Ed's own `/api/user` endpoint and is never saved or sent to Study-OS servers. |
| `https://shadjosef-study-os.shadjosef-study-os.workers.dev/*` | `host_permissions` | Official Study-OS backend API used to exchange the 6-character pairing code and sync course metadata, deadlines, and timetables to the student's Study-OS account. |
| `http://127.0.0.1/*` | `optional_host_permissions` | Optional local-only permission used solely if a student connects to a self-hosted desktop Study-OS companion on `127.0.0.1:8765`. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | Only a user-chosen Study-OS display nickname is stored locally | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | Yes (Study-OS pairing token only) | Study-OS pairing token sent only to `shadjosef-study-os.workers.dev` | Authenticates sync requests to the user's own Study-OS account. Canvas cookies and Ed tokens are never stored or transmitted to Study-OS. | No |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | No | No | School tab detection is scoped to listed domains; opt-in focus telemetry records only numeric daily category seconds locally (zero URLs or titles stored or uploaded) | No |
| User activity | Yes (opt-in local daily category seconds only) | No (stays 100% local in-browser) | Displays daily Study vs. Distraction category balance inside the user's own Study-OS dashboard | No |
| Website content | Yes (school course metadata & `.ics` timetable) | Sent to user's Study-OS account (`shadjosef-study-os.workers.dev`); Canvas PDFs stay 100% local | Populates courses, deadlines, module headings, and timetable (optional opt-in for non-personal course catalog sharing) | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
`https://studyos.no/privacy`

---

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Study-OS

**Contact Email** [REQUIRED]
*(Active monitored email configured in Chrome Web Store Developer Dashboard)*

**Support URL / Email** [RECOMMENDED]
`https://studyos.no`

**Homepage URL** [RECOMMENDED]
`https://studyos.no`

---

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.7.1 | 2026-11-24 | Fixed CWS-blocking `manifest.json` description >132 chars (177 → 124 chars); fixed `focusTelemetryEnabled` missing from `status` storage fetch so the toggle persists in popup; added MV3 `chrome.storage.session` sync locks + alarm-backed stale badge clearing; converted all `onMessage` handlers to `async/await` with `try/catch`; guarded popup checkbox rejections; added `CHROMEWEBSTORE.md` & clean ZIP packaging script (`package-extension.sh`). | Ready to Submit |
| 1.7.0 | 2026-11-23 | Added opt-in on-device Browser Focus Categories (`alarms` + optional `tabs` permission) bridged to Study-OS dashboard. | Superseded |
| 1.6.0 | 2026-11-21 | Multi-university Norwegian Canvas support, TP timetables, front-page topic fallback, and local Canvas PDF bridge. | Submitted / In Review |
| 1.5.1 | 2026-11-20 | Initial Chrome Web Store submission. | Superseded |
