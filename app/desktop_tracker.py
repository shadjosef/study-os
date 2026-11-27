#!/usr/bin/env python3
"""Auditable, Strictly Opt-In OS Activity Tracker & Focus Shield for Study-OS.

Privacy & Security Guarantees:
  - Pure Python 3.9-3.12+ standard library only (zero third-party dependencies).
  - ZERO network imports or network calls (no urllib, http, socket, or external IPC).
  - ZERO keylogging, ZERO screenshots, ZERO clipboard reads.
  - OFF by default (`enabled: false`) until explicitly opted in by the user.
  - Records ONLY frontmost application/process name + category + OS idle seconds
    (window titles are NOT captured by default).
  - Focus Shield ONLY soft-hides apps in the user's editable `distractionApps` list
    when ALL of: `enabled`, `focusShieldEnabled`, `sessionActive`, and `not paused`.
  - Stores compact 60-second aggregated JSONL buckets locally in
    `<data_dir>/logs/desktop_activity.jsonl` and atomic config in
    `<data_dir>/state/desktop_tracker_config.json`.
"""
from __future__ import annotations

import ctypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from typing import Any, Callable
from zoneinfo import ZoneInfo

OSLO_TZ = ZoneInfo("Europe/Oslo")
SOURCE_FILE = Path(__file__).resolve()
REPO_ROOT = SOURCE_FILE.parent.parent
SOURCE_REL_PATH = "app/desktop_tracker.py"
SCHEMA_VERSION = "study-os-desktop-telemetry-v1"

CATEGORY_ORDER = ("deep_study", "reading_notes", "browser", "distraction", "other")
EDITABLE_CATEGORY_KEYS = ("deep_study", "reading_notes", "browser", "distraction")

DEFAULT_CATEGORIES: dict[str, list[str]] = {
    "deep_study": [
        "Code",
        "Cursor",
        "Antigravity",
        "ChatGPT",
        "Claude",
        "Codex",
        "Perplexity",
        "Terminal",
        "iTerm2",
        "Warp",
        "PyCharm",
        "RStudio",
        "Microsoft Excel",
        "Numbers",
        "Stata",
        "MATLAB",
        "Jupyter",
        "Ghostty",
    ],
    "reading_notes": [
        "Obsidian",
        "Preview",
        "PdfCraft",
        "Skim",
        "Notion",
        "Goodnotes",
        "Zotero",
        "Anki",
        "Books",
    ],
    "browser": [
        "Google Chrome",
        "Safari",
        "Arc",
        "Brave Browser",
        "Firefox",
        "Microsoft Edge",
        "Vivaldi",
    ],
    "distraction": [
        "Discord",
        "Slack",
        "Messages",
        "Telegram",
        "WhatsApp",
        "Spotify",
        "Steam",
        "Twitter",
        "Instagram",
        "TikTok",
        "Reddit",
    ],
}

ALLOWED_CONFIG_KEYS = {
    "enabled",
    "paused",
    "focusShieldEnabled",
    "sessionActive",
    "captureWindowTitles",
    "idleThresholdSec",
    "categories",
    "distractionApps",
}

MAX_APPS_PER_LIST = 100
MAX_APP_NAME_LEN = 80
OS_PROBE_TIMEOUT_SEC = 1.5
DEFAULT_SAMPLE_INTERVAL_SEC = 5.0
DEFAULT_FLUSH_INTERVAL_SEC = 60.0
DEFAULT_IDLE_THRESHOLD_SEC = 60
DEFAULT_SHIELD_COOLDOWN_SEC = 15.0

_HID_IDLE_RE = re.compile(r'"HIDIdleTime"\s*=\s*(\d+)')
_CTRL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")

ProbeFn = Callable[[], tuple[str | None, float]]
HideFn = Callable[[str], bool]


def default_config() -> dict[str, Any]:
    """Return a fresh copy of the strictly opt-in default configuration."""
    return {
        "version": 1,
        "enabled": False,
        "paused": False,
        "focusShieldEnabled": False,
        "sessionActive": False,
        "captureWindowTitles": False,
        "idleThresholdSec": DEFAULT_IDLE_THRESHOLD_SEC,
        "categories": {key: list(apps) for key, apps in DEFAULT_CATEGORIES.items()},
        "distractionApps": list(DEFAULT_CATEGORIES["distraction"]),
    }


def sanitize_app_name(raw: Any) -> str:
    """Normalize an application/process name safely without control characters."""
    if not isinstance(raw, str):
        return ""
    cleaned = _CTRL_CHARS_RE.sub("", raw).strip()
    if len(cleaned) > MAX_APP_NAME_LEN:
        cleaned = cleaned[:MAX_APP_NAME_LEN].strip()
    return cleaned


def _norm_key(name: str) -> str:
    cleaned = sanitize_app_name(name).lower()
    if cleaned.endswith(".exe"):
        cleaned = cleaned[:-4]
    elif cleaned.endswith(".app"):
        cleaned = cleaned[:-4]
    return cleaned


def _validate_app_list(raw: Any, field_name: str) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError(f"'{field_name}' must be a list of application names.")
    if len(raw) > MAX_APPS_PER_LIST:
        raise ValueError(f"'{field_name}' cannot exceed {MAX_APPS_PER_LIST} entries.")
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            raise ValueError(f"Every entry in '{field_name}' must be a string.")
        if _CTRL_CHARS_RE.search(item):
            raise ValueError(f"Entries in '{field_name}' cannot contain control characters.")
        cleaned = item.strip()
        if not cleaned:
            continue
        if len(cleaned) > MAX_APP_NAME_LEN:
            raise ValueError(f"App name in '{field_name}' exceeds {MAX_APP_NAME_LEN} characters.")
        key = _norm_key(cleaned)
        if key and key not in seen:
            seen.add(key)
            out.append(cleaned)
    return out


def compute_source_sha256(source_path: Path = SOURCE_FILE) -> str:
    """Return the exact SHA-256 hex digest of this tracker source file."""
    return hashlib.sha256(source_path.read_bytes()).hexdigest()


def compute_payload_sha256(payload: dict[str, Any]) -> str:
    """Compute a deterministic canonical SHA-256 digest over a JSON-serializable dict."""
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line)


def _read_jsonl(path: Path, max_lines: int = 50_000) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    rows.append(parsed)
    except OSError:
        return []
    if len(rows) > max_lines:
        return rows[-max_lines:]
    return rows


# ---------------------------------------------------------------------------
# OS Probes (stdlib only, graceful degradation when unavailable or sandboxed)
# ---------------------------------------------------------------------------
def _probe_macos_frontmost_app(timeout: float = OS_PROBE_TIMEOUT_SEC) -> str | None:
    try:
        proc = subprocess.run(
            [
                "osascript",
                "-e",
                'tell application "System Events" to get name of first application process whose frontmost is true',
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    name = sanitize_app_name(proc.stdout)
    return name or None


def _probe_macos_idle_seconds(timeout: float = OS_PROBE_TIMEOUT_SEC) -> float:
    try:
        proc = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 0.0
    if proc.returncode != 0:
        return 0.0
    match = _HID_IDLE_RE.search(proc.stdout or "")
    if not match:
        return 0.0
    try:
        nanos = int(match.group(1))
    except ValueError:
        return 0.0
    return max(0.0, nanos / 1_000_000_000.0)


def _hide_macos_app(app_name: str, timeout: float = OS_PROBE_TIMEOUT_SEC) -> bool:
    clean = sanitize_app_name(app_name)
    if not clean:
        return False
    # Pass app name via `on run argv` so AppleScript string injection is impossible.
    try:
        proc = subprocess.run(
            [
                "osascript",
                "-e",
                "on run argv",
                "-e",
                'tell application "System Events" to set visible of process (item 1 of argv) to false',
                "-e",
                "end run",
                "--",
                clean,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def _probe_windows_activity() -> tuple[str | None, float]:
    if sys.platform != "win32":
        return None, 0.0
    app_name: str | None = None
    idle_sec = 0.0
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

        # 1. Foreground process executable name (never reads window titles)
        hwnd = user32.GetForegroundWindow()
        if hwnd:
            pid = ctypes.c_ulong(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
                if handle:
                    try:
                        buf_len = ctypes.c_ulong(1024)
                        buf = ctypes.create_unicode_buffer(buf_len.value)
                        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(buf_len)):
                            stem = Path(buf.value).stem
                            app_name = sanitize_app_name(stem) or None
                    finally:
                        kernel32.CloseHandle(handle)

        # 2. System idle seconds via GetLastInputInfo
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if user32.GetLastInputInfo(ctypes.byref(lii)):
            tick_ms = int(kernel32.GetTickCount()) & 0xFFFFFFFF
            elapsed_ms = (tick_ms - int(lii.dwTime)) & 0xFFFFFFFF
            idle_sec = max(0.0, elapsed_ms / 1000.0)
    except Exception:
        return app_name, idle_sec
    return app_name, idle_sec


def _hide_windows_foreground() -> bool:
    if sys.platform != "win32":
        return False
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False
        SW_MINIMIZE = 6
        return bool(user32.ShowWindow(hwnd, SW_MINIMIZE))
    except Exception:
        return False


def probe_os_activity(platform_name: str | None = None) -> tuple[str | None, float]:
    """Return `(frontmost_app_name, os_idle_seconds)` for the current OS, or `(None, 0.0)`."""
    plat = platform_name or sys.platform
    if plat == "darwin":
        return _probe_macos_frontmost_app(), _probe_macos_idle_seconds()
    if plat == "win32":
        return _probe_windows_activity()
    return None, 0.0


def hide_application(app_name: str, platform_name: str | None = None) -> bool:
    """Soft-hide a distracting application (never kills or closes unsaved work)."""
    plat = platform_name or sys.platform
    if plat == "darwin":
        return _hide_macos_app(app_name)
    if plat == "win32":
        return _hide_windows_foreground()
    return False


# ---------------------------------------------------------------------------
# Stateful Auditable DesktopTracker
# ---------------------------------------------------------------------------
class DesktopTracker:
    """Opt-in local OS activity tracker and Focus Shield controller."""

    def __init__(
        self,
        data_dir: Path,
        *,
        probe_fn: ProbeFn | None = None,
        hide_fn: HideFn | None = None,
        platform_name: str | None = None,
        sample_interval_sec: float = DEFAULT_SAMPLE_INTERVAL_SEC,
        flush_interval_sec: float = DEFAULT_FLUSH_INTERVAL_SEC,
        shield_cooldown_sec: float = DEFAULT_SHIELD_COOLDOWN_SEC,
        auto_start: bool = True,
    ) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.config_path = self.data_dir / "state" / "desktop_tracker_config.json"
        self.log_path = self.data_dir / "logs" / "desktop_activity.jsonl"
        self.platform_name = platform_name or sys.platform
        self._probe_fn: ProbeFn = probe_fn or (lambda: probe_os_activity(self.platform_name))
        self._hide_fn: HideFn = hide_fn or (lambda app: hide_application(app, self.platform_name))
        self.sample_interval_sec = max(0.05, float(sample_interval_sec))
        self.flush_interval_sec = max(1.0, float(flush_interval_sec))
        self.shield_cooldown_sec = max(0.0, float(shield_cooldown_sec))
        self.auto_start = bool(auto_start)

        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._config: dict[str, Any] = self._load_config()
        self._pending: dict[str, Any] | None = None
        self._last_shield_at: dict[str, float] = {}
        self._live_category: str = "idle"
        self._live_active: bool = False
        self._live_ts: float = 0.0

        # Strictly off by default: only start a background thread if saved config opted in.
        if self.auto_start and self._config.get("enabled"):
            self._start_thread_locked()

    def _load_config(self) -> dict[str, Any]:
        cfg = default_config()
        if not self.config_path.is_file():
            return cfg
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cfg
        if not isinstance(raw, dict):
            return cfg
        for bool_key in ("enabled", "paused", "focusShieldEnabled", "sessionActive", "captureWindowTitles"):
            if isinstance(raw.get(bool_key), bool):
                cfg[bool_key] = raw[bool_key]
        idle_val = raw.get("idleThresholdSec")
        if isinstance(idle_val, int) and not isinstance(idle_val, bool) and 15 <= idle_val <= 3600:
            cfg["idleThresholdSec"] = idle_val
        raw_cats = raw.get("categories")
        if isinstance(raw_cats, dict):
            for key in EDITABLE_CATEGORY_KEYS:
                if key in raw_cats:
                    try:
                        cfg["categories"][key] = _validate_app_list(raw_cats[key], f"categories.{key}")
                    except ValueError:
                        pass
        if "distractionApps" in raw:
            try:
                cfg["distractionApps"] = _validate_app_list(raw["distractionApps"], "distractionApps")
            except ValueError:
                pass
        return cfg

    def get_config(self) -> dict[str, Any]:
        with self._lock:
            return {
                "version": int(self._config.get("version", 1)),
                "enabled": bool(self._config["enabled"]),
                "paused": bool(self._config["paused"]),
                "focusShieldEnabled": bool(self._config["focusShieldEnabled"]),
                "sessionActive": bool(self._config["sessionActive"]),
                "captureWindowTitles": bool(self._config.get("captureWindowTitles", False)),
                "idleThresholdSec": int(self._config.get("idleThresholdSec", DEFAULT_IDLE_THRESHOLD_SEC)),
                "categories": {
                    key: list(self._config["categories"].get(key, []))
                    for key in EDITABLE_CATEGORY_KEYS
                },
                "distractionApps": list(self._config["distractionApps"]),
            }

    def is_running(self) -> bool:
        with self._lock:
            return bool(self._thread is not None and self._thread.is_alive())

    def _start_thread_locked(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="study-os-desktop-tracker",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        """Cleanly stop the background sampler thread and flush any pending bucket."""
        with self._lock:
            thread = self._thread
            self._stop_event.set()
            self._flush_pending_locked()
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        with self._lock:
            if self._thread is thread:
                self._thread = None

    def _run_loop(self) -> None:
        while not self._stop_event.wait(self.sample_interval_sec):
            try:
                self.sample_once(delta_sec=self.sample_interval_sec)
            except Exception:
                # Never crash the background daemon on transient OS probe glitches.
                pass

    def update_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Validate, atomically persist, and apply configuration updates."""
        if not isinstance(patch, dict):
            raise ValueError("Configuration payload must be a JSON object.")

        unknown = set(patch.keys()) - ALLOWED_CONFIG_KEYS
        if unknown:
            raise ValueError(f"Unsupported desktop config field(s): {', '.join(sorted(unknown))}.")

        with self._lock:
            next_cfg = self.get_config()

            for bool_key in ("enabled", "paused", "focusShieldEnabled", "sessionActive", "captureWindowTitles"):
                if bool_key in patch:
                    val = patch[bool_key]
                    if not isinstance(val, bool):
                        raise ValueError(f"'{bool_key}' must be a boolean.")
                    next_cfg[bool_key] = val

            if "idleThresholdSec" in patch:
                idle_val = patch["idleThresholdSec"]
                if isinstance(idle_val, bool) or not isinstance(idle_val, int) or not (15 <= idle_val <= 3600):
                    raise ValueError("'idleThresholdSec' must be an integer between 15 and 3600.")
                next_cfg["idleThresholdSec"] = idle_val

            if "categories" in patch:
                raw_cats = patch["categories"]
                if not isinstance(raw_cats, dict):
                    raise ValueError("'categories' must be an object mapping category names to app lists.")
                unknown_cats = set(raw_cats.keys()) - set(EDITABLE_CATEGORY_KEYS)
                if unknown_cats:
                    raise ValueError(f"Unknown category key(s): {', '.join(sorted(unknown_cats))}.")
                for cat_key, raw_apps in raw_cats.items():
                    next_cfg["categories"][cat_key] = _validate_app_list(raw_apps, f"categories.{cat_key}")

            if "distractionApps" in patch:
                next_cfg["distractionApps"] = _validate_app_list(patch["distractionApps"], "distractionApps")

            _atomic_write_json(self.config_path, next_cfg)
            self._config = next_cfg

            if not next_cfg["enabled"]:
                self._flush_pending_locked()
                thread = self._thread
                self._stop_event.set()
            else:
                thread = None
                if self.auto_start:
                    self._start_thread_locked()

        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
            with self._lock:
                if self._thread is thread:
                    self._thread = None

        return self.status()

    def classify_app(self, app_name: str | None) -> str:
        """Map an application name to one of the 5 canonical categories."""
        key = _norm_key(app_name or "")
        if not key:
            return "other"
        with self._lock:
            cats = self._config["categories"]
            for cat in EDITABLE_CATEGORY_KEYS:
                if any(_norm_key(candidate) == key for candidate in cats.get(cat, [])):
                    return cat
            if any(_norm_key(candidate) == key for candidate in self._config.get("distractionApps", [])):
                return "distraction"
        return "other"

    def is_distraction_app(self, app_name: str | None) -> bool:
        key = _norm_key(app_name or "")
        if not key:
            return False
        with self._lock:
            return any(_norm_key(candidate) == key for candidate in self._config.get("distractionApps", []))

    def _new_pending_bucket(self, now: datetime) -> dict[str, Any]:
        return {
            "startedAt": now.isoformat(),
            "day": now.strftime("%Y-%m-%d"),
            "windowSec": 0.0,
            "activeSec": 0.0,
            "idleSec": 0.0,
            "byCategory": {},
            "byApp": {},
            "shieldTriggers": 0,
        }

    def _serialize_bucket(self, bucket: dict[str, Any], ts_iso: str) -> dict[str, Any]:
        by_cat = {
            k: round(float(v), 1)
            for k, v in bucket["byCategory"].items()
            if float(v) > 0
        }
        by_app = {
            k: round(float(v), 1)
            for k, v in bucket["byApp"].items()
            if float(v) > 0
        }
        return {
            "v": 1,
            "ts": ts_iso,
            "day": bucket["day"],
            "windowSec": round(float(bucket["windowSec"]), 1),
            "activeSec": round(float(bucket["activeSec"]), 1),
            "idleSec": round(float(bucket["idleSec"]), 1),
            "byCategory": by_cat,
            "byApp": by_app,
            "shieldTriggers": int(bucket["shieldTriggers"]),
        }

    def _flush_pending_locked(self, now: datetime | None = None) -> dict[str, Any] | None:
        if not self._pending:
            return None
        if float(self._pending.get("windowSec") or 0.0) <= 0.0:
            self._pending = None
            return None
        ts = (now or datetime.now(OSLO_TZ)).isoformat()
        record = self._serialize_bucket(self._pending, ts)
        _append_jsonl(self.log_path, record)
        self._pending = None
        return record

    def flush(self, now: datetime | None = None) -> dict[str, Any] | None:
        """Flush any accumulated in-memory seconds to the local JSONL log."""
        with self._lock:
            return self._flush_pending_locked(now=now)

    def sample_once(
        self,
        *,
        delta_sec: float | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Take one single privacy-preserving OS sample and apply Focus Shield if armed."""
        step = max(0.1, float(self.sample_interval_sec if delta_sec is None else delta_sec))
        current = (now or datetime.now(OSLO_TZ)).astimezone(OSLO_TZ)

        with self._lock:
            if not self._config["enabled"]:
                return {"recorded": False, "reason": "disabled", "shieldTriggered": False}
            if self._config["paused"]:
                return {"recorded": False, "reason": "paused", "shieldTriggered": False}

        # Execute OS probe outside the state lock so slow subprocesses never block HTTP handlers.
        raw_app, raw_idle = self._probe_fn()
        app_name = sanitize_app_name(raw_app) if raw_app else ""
        try:
            os_idle_sec = max(0.0, float(raw_idle or 0.0))
        except (TypeError, ValueError):
            os_idle_sec = 0.0

        should_hide = False
        category = "other"
        flushed_record: dict[str, Any] | None = None

        with self._lock:
            if not self._config["enabled"]:
                return {"recorded": False, "reason": "disabled", "shieldTriggered": False}
            if self._config["paused"]:
                return {"recorded": False, "reason": "paused", "shieldTriggered": False}

            day_key = current.strftime("%Y-%m-%d")
            if self._pending is not None and self._pending["day"] != day_key:
                flushed_record = self._flush_pending_locked(now=current)
            if self._pending is None:
                self._pending = self._new_pending_bucket(current)

            idle_threshold = int(self._config.get("idleThresholdSec", DEFAULT_IDLE_THRESHOLD_SEC))
            is_idle = os_idle_sec >= float(idle_threshold)
            self._pending["windowSec"] += step

            if is_idle:
                self._pending["idleSec"] += step
                category = "idle"
                self._live_category = "idle"
                self._live_active = False
                self._live_ts = current.timestamp()
            elif app_name:
                category = self.classify_app(app_name)
                self._live_category = category
                self._live_active = True
                self._live_ts = current.timestamp()
                self._pending["activeSec"] += step
                self._pending["byCategory"][category] = self._pending["byCategory"].get(category, 0.0) + step
                self._pending["byApp"][app_name] = self._pending["byApp"].get(app_name, 0.0) + step

                if (
                    self._config["enabled"]
                    and self._config["focusShieldEnabled"]
                    and self._config["sessionActive"]
                    and not self._config["paused"]
                    and self.is_distraction_app(app_name)
                ):
                    now_ts = current.timestamp()
                    app_key = _norm_key(app_name)
                    last_ts = self._last_shield_at.get(app_key, -1e18)
                    if (now_ts - last_ts) >= self.shield_cooldown_sec:
                        should_hide = True
                        self._last_shield_at[app_key] = now_ts

        shield_triggered = False
        if should_hide and app_name:
            try:
                shield_triggered = bool(self._hide_fn(app_name))
            except Exception:
                shield_triggered = False

        with self._lock:
            if self._pending is not None:
                if shield_triggered:
                    self._pending["shieldTriggers"] += 1
                if self._pending["windowSec"] >= self.flush_interval_sec:
                    flushed_record = self._flush_pending_locked(now=current)

        return {
            "recorded": True,
            "app": None if category == "idle" else (app_name or None),
            "category": category,
            "idleSec": round(os_idle_sec, 1),
            "shieldTriggered": shield_triggered,
            "flushed": flushed_record is not None,
        }

    def _aggregate_records(
        self,
        records: list[dict[str, Any]],
        *,
        day_filter: str | None = None,
    ) -> dict[str, Any]:
        by_category: dict[str, float] = {cat: 0.0 for cat in CATEGORY_ORDER}
        by_app: dict[str, float] = {}
        active_sec = 0.0
        idle_sec = 0.0
        shield_triggers = 0

        for row in records:
            if day_filter is not None and row.get("day") != day_filter:
                continue
            active_sec += max(0.0, float(row.get("activeSec") or 0.0))
            idle_sec += max(0.0, float(row.get("idleSec") or 0.0))
            shield_triggers += max(0, int(row.get("shieldTriggers") or 0))
            raw_apps = row.get("byApp")
            has_apps = isinstance(raw_apps, dict) and bool(raw_apps)
            if has_apps:
                for app, secs in raw_apps.items():
                    clean = sanitize_app_name(app)
                    val = max(0.0, float(secs or 0.0))
                    if clean and val > 0:
                        by_app[clean] = by_app.get(clean, 0.0) + val
                        cat = self.classify_app(clean)
                        target = cat if cat in by_category else "other"
                        by_category[target] += val
            else:
                raw_cats = row.get("byCategory")
                if isinstance(raw_cats, dict):
                    for cat, secs in raw_cats.items():
                        target = cat if cat in by_category else "other"
                        by_category[target] += max(0.0, float(secs or 0.0))

        top_apps = [
            {
                "app": app,
                "category": self.classify_app(app),
                "sec": round(sec, 1),
            }
            for app, sec in sorted(by_app.items(), key=lambda kv: (-kv[1], kv[0].lower()))[:12]
            if sec > 0
        ]
        rounded_cats = {cat: round(by_category[cat], 1) for cat in CATEGORY_ORDER}
        rounded_active = round(active_sec, 1)
        rounded_idle = round(idle_sec, 1)
        return {
            "totalSec": round(rounded_active + rounded_idle, 1),
            "activeSec": rounded_active,
            "idleSec": rounded_idle,
            "shieldTriggers": shield_triggers,
            "byCategory": rounded_cats,
            "topApps": top_apps,
        }

    def _combined_records_locked(self, now: datetime) -> list[dict[str, Any]]:
        rows = _read_jsonl(self.log_path)
        if self._pending and float(self._pending.get("windowSec") or 0.0) > 0.0:
            rows.append(self._serialize_bucket(self._pending, now.isoformat()))
        return rows

    def _audit_metadata(self) -> dict[str, Any]:
        return {
            "sourcePath": SOURCE_REL_PATH,
            "sourceSha256": compute_source_sha256(SOURCE_FILE),
            "logPath": str(self.log_path),
            "configPath": str(self.config_path),
            "networkCalls": 0,
            "keylogging": False,
            "screenshots": False,
            "clipboardAccess": False,
            "windowTitlesDefault": False,
        }

    def status(self, now: datetime | None = None) -> dict[str, Any]:
        """Return current telemetry status, today's breakdown, config, and audit proof."""
        current = (now or datetime.now(OSLO_TZ)).astimezone(OSLO_TZ)
        today_key = current.strftime("%Y-%m-%d")
        with self._lock:
            cfg = self.get_config()
            rows = self._combined_records_locked(current)
            live_fresh = (
                cfg["enabled"]
                and not cfg["paused"]
                and self._live_active
                and (current.timestamp() - self._live_ts) <= max(20.0, self.sample_interval_sec * 4.0)
            )
            live_state = {
                "category": self._live_category if live_fresh else "idle",
                "active": bool(live_fresh),
            }
        today_agg = self._aggregate_records(rows, day_filter=today_key)
        return {
            "available": True,
            "platform": self.platform_name,
            "enabled": cfg["enabled"],
            "paused": cfg["paused"],
            "focusShieldEnabled": cfg["focusShieldEnabled"],
            "sessionActive": cfg["sessionActive"],
            "live": live_state,
            "today": {
                "day": today_key,
                **today_agg,
            },
            "config": cfg,
            "audit": self._audit_metadata(),
        }

    def export_audit_bundle(self, now: datetime | None = None) -> dict[str, Any]:
        """Build a self-verifying JSON export bundle with source and payload SHA-256 hashes."""
        current = (now or datetime.now(OSLO_TZ)).astimezone(OSLO_TZ)
        with self._lock:
            self._flush_pending_locked(now=current)
            cfg = self.get_config()
            records = _read_jsonl(self.log_path)

        days = sorted({str(r.get("day") or "") for r in records if r.get("day")})
        daily_rollups = [
            {"day": day, **self._aggregate_records(records, day_filter=day)}
            for day in days
        ]
        overall = self._aggregate_records(records)

        payload: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "exportedAt": current.isoformat(),
            "timezone": "Europe/Oslo",
            "platform": self.platform_name,
            "source": {
                "path": SOURCE_REL_PATH,
                "sha256": compute_source_sha256(SOURCE_FILE),
            },
            "privacyGuarantees": {
                "optInOnly": True,
                "networkCalls": 0,
                "keylogging": False,
                "screenshots": False,
                "clipboardAccess": False,
                "windowTitlesDefault": False,
            },
            "config": cfg,
            "summary": {
                "recordCount": len(records),
                "dayCount": len(daily_rollups),
                "totalSec": overall["totalSec"],
                "activeSec": overall["activeSec"],
                "idleSec": overall["idleSec"],
                "shieldTriggers": overall["shieldTriggers"],
                "byCategory": overall["byCategory"],
            },
            "dailyRollups": daily_rollups,
            "topApps": overall["topApps"],
            "records": records,
        }
        payload_sha256 = compute_payload_sha256(payload)
        return {
            **payload,
            "integrity": {
                "algorithm": "SHA-256",
                "canonicalization": "json(sort_keys=True, separators=(',', ':'), ensure_ascii=False) excluding 'integrity' and 'payloadSha256'",
                "payloadSha256": payload_sha256,
            },
            "payloadSha256": payload_sha256,
        }
