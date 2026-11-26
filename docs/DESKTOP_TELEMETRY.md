# Study-OS Desktop Telemetry & Focus Shield Specification

Study-OS Desktop Edition (`127.0.0.1:8765`) includes an optional, strictly local, open-source OS activity tracker and Focus Shield implemented in [`app/desktop_tracker.py`](../app/desktop_tracker.py) using **Python 3.9–3.12+ standard library only** (zero third-party packages).

This document explains every operating-system call it makes, what it **never** collects, where local files live, and how any student can cryptographically verify both the release package and the exact running tracker source file.

---

## Core Privacy Guarantees

| Guarantee | Enforced Behavior |
| --- | --- |
| **OFF by default** | `enabled` defaults to `false`. Zero background polling threads are spawned until you explicitly opt in via the local UI (`POST /api/desktop/config`). |
| **Zero network calls** | `app/desktop_tracker.py` does not import `urllib`, `http`, `socket`, `ssl`, or any networking library. Telemetry never leaves your machine. |
| **Zero keylogging** | Never registers keyboard hooks, accessibility text readers, or input event taps. |
| **Zero screenshots** | Never captures display buffers, window thumbnails, or screen recordings. |
| **Zero clipboard access** | Never reads or writes the OS clipboard (`pbpaste`, Win32 clipboard APIs, etc.). |
| **No window titles by default** | Default collection stores only the active application/process name, its category, and OS idle seconds (`captureWindowTitles: false`). |
| **Loopback-only API** | Bound strictly to `127.0.0.1` / `localhost` / `::1` with `Host` DNS-rebinding checks, `Origin` / `Sec-Fetch-Site` CSRF rejection (`403`), and `Cache-Control: no-store`. |
| **1-click Incognito Pause** | Toggling `paused: true` immediately stops sampling and disables Focus Shield without losing your category configuration. |

---

## Exact Operating-System Calls

### macOS (`darwin`)
1. **Frontmost application name** (read-only, `1.5s` timeout):
   ```sh
   osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
   ```
2. **True OS idle duration** (read-only, `1.5s` timeout):
   ```sh
   ioreg -c IOHIDSystem
   ```
   Parses the numeric `HIDIdleTime` nanosecond counter only. No keystrokes or mouse coordinates are read.
3. **Opt-in Focus Shield soft-hide** (`1.5s` timeout):
   ```sh
   osascript -e 'on run argv' \
     -e 'tell application "System Events" to set visible of process (item 1 of argv) to false' \
     -e 'end run' -- "<AppName>"
   ```
   Passing the app name through `on run argv` avoids string interpolation or shell/AppleScript injection. It **only hides** the window (never force-quits or discards unsaved work).

### Windows (`win32`)
1. **Foreground process executable stem** via stdlib `ctypes`:
   - `user32.GetForegroundWindow`
   - `user32.GetWindowThreadProcessId`
   - `kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)`
   - `kernel32.QueryFullProcessImageNameW` (extracts basename stem only, e.g. `Code`, `Discord`; never calls `GetWindowTextW`)
2. **System idle duration** via stdlib `ctypes`:
   - `user32.GetLastInputInfo` + `kernel32.GetTickCount`
3. **Opt-in Focus Shield soft-minimize**:
   - `user32.ShowWindow(hwnd, SW_MINIMIZE)` (only minimizes; never terminates processes)

### Linux / Unsupported Platforms
- Clean no-op probe returning `(None, 0.0)` with zero crashes or external commands.

---

## How Focus Shield Works

Focus Shield is **opt-in** and non-destructive. It hides/minimizes a distracting application **only when all four conditions hold simultaneously**:

1. `enabled === true` (user explicitly opted into desktop tracking)
2. `focusShieldEnabled === true` (user explicitly enabled Focus Shield)
3. `sessionActive === true` (an active study block is running — automatically disarmed on breaks)
4. `paused === false` (Incognito Pause is off)
5. The user is active (not OS-idle) and the frontmost app matches an entry in the user's editable `distractionApps` list (case-insensitive).

A cooldown prevents repeated hide calls if you intentionally reopen an app.

---

## Local File Paths & Schema

All paths respect `STUDY_OS_DATA_DIR` (defaulting to `<repo>/data/`):

- **Configuration (atomic JSON):** `<data_dir>/state/desktop_tracker_config.json`
- **Activity Log (compact 60-second aggregated JSONL):** `<data_dir>/logs/desktop_activity.jsonl`

Example JSONL record:
```json
{"v":1,"ts":"2026-11-26T14:30:00+01:00","day":"2026-11-26","windowSec":60.0,"activeSec":55.0,"idleSec":5.0,"byCategory":{"deep_study":45.0,"reading_notes":10.0},"byApp":{"Code":45.0,"Obsidian":10.0},"shieldTriggers":0}
```

### Default Editable Categories
- **`deep_study`**: Code, Cursor, Antigravity, Terminal, iTerm2, Warp, PyCharm, RStudio, Microsoft Excel, Numbers, Stata, MATLAB, Jupyter, Ghostty
- **`reading_notes`**: Obsidian, Preview, PdfCraft, Skim, Notion, Goodnotes, Zotero, Anki, Books
- **`browser`**: Google Chrome, Safari, Arc, Brave Browser, Firefox, Microsoft Edge, Vivaldi
- **`distraction`**: Discord, Slack, Messages, Telegram, WhatsApp, Spotify, Steam, Twitter, Instagram, TikTok, Reddit
- **`other`**: Any application not listed above.

---

## Local HTTP Endpoints (Loopback Only)

| Method & Path | Purpose |
| --- | --- |
| `GET /api/desktop/status` | Returns current opt-in state, today's category & top-app totals, editable config, and `audit.sourceSha256`. |
| `POST /api/desktop/config` | Validates booleans (`enabled`, `paused`, `focusShieldEnabled`, `sessionActive`), `categories`, and `distractionApps`; atomically saves config and starts/stops the background sampler thread. |
| `GET /api/desktop/export` | Downloads a verifiable `study-os-desktop-telemetry.json` audit bundle containing `source.sha256`, daily rollups, top apps, raw records, and a canonical `payloadSha256`. |

---

## Cryptographic Verification Guide

### 1. Verify a GitHub Release Zip against `SHA256SUMS.txt`
On macOS / Linux:
```sh
shasum -a 256 -c SHA256SUMS.txt
```
On Windows (PowerShell):
```powershell
Get-FileHash .\Study-OS-Desktop-Windows.zip -Algorithm SHA256
```
You can also verify the GitHub SLSA build provenance attestation using GitHub CLI:
```sh
gh attestation verify Study-OS-Desktop-macOS.zip --owner shadjosef
```

### 2. Verify the Running Tracker Code (`sourceSha256`)
Compare the `sourceSha256` shown in the Metrics UI or exported JSON against your local file:
```sh
shasum -a 256 app/desktop_tracker.py
```

### 3. Verify an Exported Audit JSON (`payloadSha256`)
```sh
python3 - <<'PY'
import hashlib, json
bundle = json.load(open("study-os-desktop-telemetry.json", encoding="utf-8"))
expected = bundle.pop("payloadSha256")
bundle.pop("integrity", None)
canonical = json.dumps(bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
actual = hashlib.sha256(canonical).hexdigest()
assert actual == expected, f"Mismatch: {actual} != {expected}"
print("VERIFIED OK:", actual)
PY
```
