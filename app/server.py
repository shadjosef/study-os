#!/usr/bin/env python3
"""Study-OS Local-First API & Static Web Server.

Zero external pip dependencies required (pure Python 3.9+ stdlib).
Persists all progress, FSRS memory states, attempts, and session check-ins
directly into OneDrive (`Study-OS/data/`) for cross-PC sync and AI agent access.
"""
from __future__ import annotations

import argparse
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from typing import Any
import urllib.parse
import webbrowser
from zoneinfo import ZoneInfo

APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
PUBLIC_DIR = APP_DIR / "public"
DATA_DIR = Path(os.environ.get("STUDY_OS_DATA_DIR") or (ROOT_DIR / "data")).expanduser().resolve()

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from analytics import (  # noqa: E402
    build_full_analytics,
    compute_attempt_metrics,
    read_jsonl,
    update_fsrs_card,
)
from calendar_sync import (  # noqa: E402
    build_auto_queue_for_block,
    load_fallback_from_canvas_archive,
    refresh_calendar_cache,
)
from canvas_bridge import (  # noqa: E402
    COURSE_DOCUMENT_TYPES,
    MAX_DOCUMENT_BYTES,
    add_canvas_document,
    canvas_course_documents,
    canvas_resync,
    import_courses_from_canvas_archive,
    inspect_canvas_archive,
    install_demo_course,
    launch_canvas_resync,
    resolve_canvas_archive,
    save_settings,
)
from dlpfc import (  # noqa: E402
    classify_intrinsic_dlpfc,
    effective_dlpfc_tier,
)
from obsidian_sync import (  # noqa: E402
    discover_reference_library,
    extract_reference_section,
    make_obsidian_uri,
    vault_root,
    write_obsidian_dashboard,
)
from timetable_planner import (  # noqa: E402
    default_schedule_prefs,
    export_blocks_to_ics,
    fetch_timeedit_ics,
    generate_adaptive_schedule,
    load_custom_schedule,
    parse_ics_events,
    parse_universal_schedule_payload,
    save_custom_schedule,
)
from tutor_bridge import LiveTutor, with_source_links  # noqa: E402

OSLO_TZ = ZoneInfo("Europe/Oslo")
STATE_LOCK = threading.RLock()


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False) + "\n"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line)


def merge_course_practice(bank: dict[str, Any], supplement: dict[str, Any]) -> dict[str, Any]:
    """Append bundled practice without replacing any matching items in the main bank."""
    if bank["courseId"] != supplement["courseId"]:
        return bank
    merged = dict(bank)
    main_exam = bank.get("examInfo") or {}
    if not main_exam.get("date") and supplement.get("examInfo", {}).get("date"):
        merged["examInfo"] = {**main_exam, **supplement["examInfo"]}
    for field in ("topics", "collections", "questions"):
        entries = list(bank.get(field) or [])
        ids = {entry["id"] for entry in entries}
        for entry in supplement.get(field, []):
            if entry["id"] not in ids:
                entries.append(entry)
                ids.add(entry["id"])
        merged[field] = entries
    return merged


class StudyStore:
    def __init__(self, root: Path, data_dir: Path | None = None) -> None:
        self.root = root
        env_data = os.environ.get("STUDY_OS_DATA_DIR")
        self.data_dir = data_dir or (Path(env_data).expanduser().resolve() if env_data else (root / "data"))
        self.courses_dir = self.data_dir / "courses"
        self.progress_path = self.data_dir / "state" / "progress.json"
        self.calendar_path = self.data_dir / "state" / "calendar_cache.json"
        self.attempts_path = self.data_dir / "logs" / "attempts.jsonl"
        self.sessions_path = self.data_dir / "logs" / "sessions.jsonl"
        self.catalog_path = self.data_dir / "catalog.json"
        self._bank_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}

    def load_progress(self) -> dict[str, Any]:
        if not self.progress_path.is_file():
            return {"version": 1, "updatedAt": datetime.now(OSLO_TZ).isoformat(), "records": {}}
        try:
            data = json.loads(self.progress_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("records"), dict):
                return data
        except Exception:
            pass
        return {"version": 1, "updatedAt": datetime.now(OSLO_TZ).isoformat(), "records": {}}

    def save_progress(self, state: dict[str, Any]) -> None:
        state["updatedAt"] = datetime.now(OSLO_TZ).isoformat()
        atomic_write_json(self.progress_path, state)

    def load_course_bank(self, course_id: str) -> dict[str, Any] | None:
        if not course_id or "/" in course_id or "\\" in course_id or ".." in course_id:
            return None
        bank_file = self.courses_dir / course_id / "bank.json"
        if not bank_file.is_file():
            return None
        supplement_file = self.root / "examples" / "math-2588" / "bank.json"
        has_supplement = course_id == "math-2588" and supplement_file.is_file()
        signature = (
            bank_file.stat().st_mtime_ns,
            supplement_file.stat().st_mtime_ns if has_supplement else 0,
        )
        cached = self._bank_cache.get(course_id)
        if cached and cached[0] == signature:
            return cached[1]
        try:
            bank = json.loads(bank_file.read_text(encoding="utf-8"))
        except Exception:
            return None
        if has_supplement:
            try:
                supplement = json.loads(supplement_file.read_text(encoding="utf-8"))
                bank = merge_course_practice(bank, supplement)
            except (OSError, ValueError, TypeError, KeyError):
                # The local bank is usable even while OneDrive copies the supplement.
                return bank
        self._bank_cache[course_id] = (signature, bank)
        return bank

    def discover_courses(self) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
        courses_by_id: dict[str, dict[str, Any]] = {}
        if self.courses_dir.is_dir():
            for sub in sorted(self.courses_dir.iterdir()):
                if not sub.is_dir():
                    continue
                bank = self.load_course_bank(sub.name)
                if bank and bank.get("courseId"):
                    courses_by_id[bank["courseId"]] = bank

        # Order nicely: Economics, Accounting, Mathematics, OB, Programming, then any future courses
        preferred = ["econ-2522", "acct-2527", "math-2588", "ob-2537", "prog-3021"]
        ordered_ids = [cid for cid in preferred if cid in courses_by_id] + [
            cid for cid in sorted(courses_by_id.keys()) if cid not in preferred
        ]

        catalog: list[dict[str, Any]] = []
        for cid in ordered_ids:
            b = courses_by_id[cid]
            qs = [q for q in b.get("questions", []) if q.get("available", True)]
            obs = b.get("obsidian") or {}
            main_ref = obs.get("mainReference") or ""
            catalog.append(
                {
                    "courseId": cid,
                    "canvasId": b.get("canvasId", ""),
                    "code": b.get("code", cid.upper()),
                    "title": b.get("title", cid),
                    "shortTitle": b.get("shortTitle") or b.get("title", cid),
                    "semester": b.get("semester", "Autumn 2026"),
                    "color": b.get("color", "#28654d"),
                    "examInfo": b.get("examInfo") or {},
                    "questionCount": len(qs),
                    "mcqCount": sum(1 for q in qs if q.get("kind") == "mcq"),
                    "writtenOrCalcCount": sum(1 for q in qs if q.get("kind") != "mcq"),
                    "hardCount": sum(1 for q in qs if int(q.get("difficulty") or 2) >= 3),
                    "highDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 3),
                    "medDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 2),
                    "lowDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 1),
                    "longHorizonCount": sum(
                        1
                        for q in qs
                        if q.get("kind") != "mcq"
                        and float(((q.get("pacing") or {}).get("learning") or {}).get("target") or 0) >= 8.0
                    ),
                    "flowmultiCount": sum(1 for q in qs if q.get("wiseflowFields")),
                    "topicCount": len(b.get("topics") or []),
                    "topics": b.get("topics") or [],
                    "collections": b.get("collections") or [],
                    "obsidian": obs,
                    "obsidianMainReference": main_ref,
                    "obsidianUri": make_obsidian_uri(obs.get("vault") or "Obsidian Vault", main_ref) if main_ref else "",
                }
            )

        atomic_write_json(self.catalog_path, {"version": 1, "updatedAt": datetime.now(OSLO_TZ).isoformat(), "courses": catalog})
        return catalog, courses_by_id

    def load_or_refresh_calendar(
        self,
        force: bool = False,
        courses_by_id: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        custom = load_custom_schedule(self.data_dir)
        if custom.get("enabled") and custom.get("blocks"):
            return refresh_calendar_cache(
                self.root, days_ahead=14, data_dir=self.data_dir, courses_by_id=courses_by_id
            )
        if not force and self.calendar_path.is_file():
            try:
                cached = json.loads(self.calendar_path.read_text(encoding="utf-8"))
                updated = cached.get("updatedAt")
                if updated:
                    age_min = (datetime.now(OSLO_TZ) - datetime.fromisoformat(updated)).total_seconds() / 60.0
                    if age_min < 120 and cached.get("blocks"):
                        return cached
            except Exception:
                pass
        return refresh_calendar_cache(
            self.root, days_ahead=14, data_dir=self.data_dir, courses_by_id=courses_by_id
        )

    def build_bootstrap(self, force_calendar: bool = False) -> dict[str, Any]:
        with STATE_LOCK:
            catalog, courses_by_id = self.discover_courses()
            progress = self.load_progress()
            cal = self.load_or_refresh_calendar(force=force_calendar, courses_by_id=courses_by_id)
            sessions = read_jsonl(self.sessions_path, max_lines=200)
            completed_event_ids = {s.get("calendarEventId") for s in sessions if s.get("calendarEventId")}
            analytics = build_full_analytics(self.root, courses_by_id, progress)
            today_high_min = float((analytics.get("dlpfcBudget") or {}).get("todayHighMinutes") or 0.0)

            now = datetime.now(OSLO_TZ)
            now_iso = now.isoformat()
            enriched_blocks: list[dict[str, Any]] = []
            for b in cal.get("blocks") or []:
                b_copy = dict(b)
                b_copy["completed"] = b.get("eventId") in completed_event_ids
                # Determine live vs upcoming
                try:
                    st = datetime.fromisoformat(b["startIso"])
                    en = datetime.fromisoformat(b["endIso"])
                    if st - (en - st) * 0.25 <= now <= en:
                        b_copy["timingState"] = "live_now"
                    elif now < st:
                        b_copy["timingState"] = "upcoming"
                    else:
                        b_copy["timingState"] = "past"
                except Exception:
                    b_copy["timingState"] = "upcoming"

                if b_copy.get("blockKind") in ("study_block", "recall_sprint") and b_copy["timingState"] != "past":
                    b_copy["autoQueue"] = build_auto_queue_for_block(
                        b_copy, courses_by_id, progress.get("records") or {}, today_high_min
                    )
                enriched_blocks.append(b_copy)

            # Keep Obsidian Dashboard fresh!
            try:
                write_obsidian_dashboard(self.root, catalog, analytics, enriched_blocks, sessions)
            except Exception:
                pass

            sched_cfg = load_custom_schedule(self.data_dir)
            return {
                "serverTime": now_iso,
                "timezone": "Europe/Oslo",
                "mode": "local",
                "catalog": catalog,
                "references": discover_reference_library(self.root, catalog, self.data_dir),
                "canvasArchive": inspect_canvas_archive(self.root, self.data_dir, courses_by_id),
                "scheduleConfig": {
                    "enabled": bool(sched_cfg.get("enabled")),
                    "source": sched_cfg.get("source") or "",
                    "prefs": sched_cfg.get("prefs") or default_schedule_prefs(),
                    "estimate": sched_cfg.get("estimate"),
                },
                "progress": progress,
                "calendar": {
                    "updatedAt": cal.get("updatedAt"),
                    "source": cal.get("source"),
                    "estimate": cal.get("estimate"),
                    "blocks": enriched_blocks,
                },
                "analytics": analytics,
                "recentSessions": sessions[-25:][::-1],
            }


STORE = StudyStore(ROOT_DIR)
LIVE_TUTOR = LiveTutor()


def read_source_links() -> dict:
    path = STORE.data_dir / "state" / "question-source-links.json"
    try:
        links = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(links, dict):
        raise ValueError("Could not read the saved question source links.")
    return links


class StudyOSHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Quiet clean logging
        if os.environ.get("STUDY_OS_VERBOSE") == "1":
            super().log_message(fmt, *args)

    def end_headers(self) -> None:
        # Allow local Obsidian Desktop plugin (`app://obsidian.md`) & localhost access
        if not self.path.startswith("/api/tutor/") and self.path.partition("?")[0] not in {
            "/api/canvas/sync", "/api/canvas/add-file", "/api/canvas/documents", "/api/canvas-file"
        }:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file_path(self, file_path: Path) -> None:
        if not file_path.is_file():
            self.send_json({"error": "File not found"}, status=404)
            return
        ctype, _ = mimetypes.guess_type(str(file_path))
        if file_path.suffix.lower() == ".pdf":
            ctype = "application/pdf"
        with file_path.open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            start, stop = 0, size
            is_pdf = ctype == "application/pdf"
            byte_range = re.fullmatch(r"bytes=([0-9]{0,20})-([0-9]{0,20})", self.headers.get("Range", "")) if is_pdf else None
            if byte_range and (byte_range[1] or byte_range[2]):
                if byte_range[1]:
                    start = int(byte_range[1])
                    if byte_range[2]:
                        stop = min(size, int(byte_range[2]) + 1)
                else:
                    start = max(0, size - int(byte_range[2]))
                if start >= stop:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{stop - 1}/{size}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            if is_pdf:
                self.send_header("Accept-Ranges", "bytes")
            if file_path.suffix.lower() in {".pdf", ".png", ".jpg", ".jpeg", ".svg", ".webp"}:
                self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + urllib.parse.quote(file_path.name))
            self.send_header("Content-Length", str(stop - start))
            self.end_headers()
            source.seek(start)
            try:
                remaining = stop - start
                while remaining and (chunk := source.read(min(remaining, 1024 * 1024))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 16 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if route == "/api/ping":
            self.send_json({"ok": True, "service": "study-os", "version": "1.0.0"})
            return

        if route in ("/api/tutor/live", "/api/tutor/config"):
            if not self.is_local_canvas_request(require_origin=False):
                self.send_json({"error": "Connect from the desktop Study-OS app."}, status=403)
                return
            if route.endswith("/live"):
                self.send_json(LIVE_TUTOR.current())
            else:
                self.send_json({"script": str(ROOT_DIR / "tools" / "study_os_mcp.py"),
                                "port": self.server.server_address[1]})
            return

        if route == "/api/bootstrap":
            force_cal = (qs.get("refresh_calendar") or ["0"])[0] == "1"
            self.send_json(STORE.build_bootstrap(force_calendar=force_cal))
            return

        if route.startswith("/api/course/"):
            cid = urllib.parse.unquote(route[len("/api/course/") :]).strip("/")
            bank = STORE.load_course_bank(cid)
            if not bank:
                self.send_json({"error": f"Course '{cid}' not found"}, status=404)
                return
            try:
                links = read_source_links()
            except (OSError, ValueError):
                links = {}
            self.send_json(with_source_links(bank, links))
            return

        if route.startswith("/api/course-asset/"):
            rest = urllib.parse.unquote(route[len("/api/course-asset/") :]).lstrip("/")
            parts = rest.split("/", 1)
            if len(parts) != 2:
                self.send_json({"error": "Invalid asset path"}, status=400)
                return
            cid, rel = parts
            c_root = (STORE.courses_dir / cid).resolve()
            target = (c_root / rel).resolve()
            if c_root not in target.parents:
                self.send_json({"error": "Forbidden"}, status=403)
                return
            self.send_file_path(target)
            return

        if route == "/api/obsidian/section":
            rel_file = (qs.get("file") or [""])[0]
            heading = (qs.get("heading") or [""])[0]
            if not rel_file:
                self.send_json({"available": False, "error": "Missing file parameter"}, status=400)
                return
            self.send_json(extract_reference_section(ROOT_DIR, rel_file, heading))
            return

        if route == "/api/vault-asset":
            rel_path = (qs.get("path") or [""])[0].strip().lstrip("/\\")
            from_dir = (qs.get("from") or [""])[0].strip()
            open_native = (qs.get("open") or ["0"])[0] == "1"
            v_root = vault_root(ROOT_DIR, STORE.data_dir)
            candidates = []
            if from_dir:
                candidates.append((v_root / from_dir / rel_path).resolve())
            candidates.append((v_root / rel_path).resolve())
            # Obsidian shortest-path attachment lookup fallback
            fname = Path(rel_path).name
            resolved_match: Path | None = None
            for cand in candidates:
                if cand.is_file() and v_root in cand.parents:
                    resolved_match = cand
                    break
            if not resolved_match and fname:
                for match in v_root.rglob(fname):
                    if match.is_file() and ".obsidian" not in match.parts:
                        resolved_match = match
                        break
            if not resolved_match:
                self.send_json({"error": "Vault asset not found"}, status=404)
                return
            if open_native:
                if sys.platform == "darwin":
                    subprocess.Popen(["open", str(resolved_match)])
                elif os.name == "nt":
                    os.startfile(str(resolved_match))  # type: ignore[attr-defined]
                self.send_json({"ok": True, "opened": str(resolved_match)})
                return
            self.send_file_path(resolved_match)
            return

        if route == "/api/canvas-file":
            rel_path = (qs.get("path") or [""])[0].strip().lstrip("/\\")
            open_native = (qs.get("open") or ["0"])[0] == "1"
            archive_root = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
            if archive_root is None:
                self.send_json({"error": "Canvas-Archive not configured or not found"}, status=404)
                return
            target = (archive_root / rel_path).resolve()
            if not target.is_file() or archive_root not in target.parents:
                self.send_json({"error": "Original Canvas file not found"}, status=404)
                return
            if open_native:
                if sys.platform == "darwin":
                    subprocess.Popen(["open", str(target)])
                elif os.name == "nt":
                    os.startfile(str(target))  # type: ignore[attr-defined]
                self.send_json({"ok": True, "opened": str(target)})
                return
            self.send_file_path(target)
            return

        if route == "/api/canvas/status":
            _, courses_by_id = STORE.discover_courses()
            self.send_json(inspect_canvas_archive(ROOT_DIR, STORE.data_dir, courses_by_id))
            return

        if route == "/api/canvas/documents":
            if not self.is_local_canvas_request(require_origin=False):
                self.send_json({"error": "Open course files from local Study-OS."}, status=403)
                return
            archive = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
            canvas_id = (qs.get("course") or [""])[0]
            self.send_json({"files": canvas_course_documents(archive, canvas_id) if archive else []})
            return

        if route == "/api/schedule/export.ics":
            boot = STORE.build_bootstrap(force_calendar=False)
            ics_body = export_blocks_to_ics(boot.get("calendar", {}).get("blocks") or []).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="study-os-schedule.ics"')
            self.send_header("Content-Length", str(len(ics_body)))
            self.end_headers()
            self.wfile.write(ics_body)
            return

        if route == "/api/export-backup":
            with STATE_LOCK:
                payload = {
                    "exportedAt": datetime.now(OSLO_TZ).isoformat(),
                    "format": "study-os-backup-v1",
                    "progress": STORE.load_progress(),
                    "attempts": read_jsonl(STORE.attempts_path, max_lines=20000),
                    "sessions": read_jsonl(STORE.sessions_path, max_lines=5000),
                }
            self.send_json(payload)
            return

        # Serve SPA static files (fallback to index.html for client-side routes)
        super().do_GET()

    def is_local_canvas_request(self, *, require_origin: bool = True) -> bool:
        port = self.server.server_address[1]
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        return (
            self.client_address[0] == "127.0.0.1"
            and host in {f"127.0.0.1:{port}", f"localhost:{port}"}
            and (origin == f"http://{host}" or (origin is None and not require_origin))
        )

    def handle_canvas_sync(self) -> None:
        if not self.is_local_canvas_request():
            self.send_json({"error": "Open Canvas Sync from the local Study-OS app."}, status=403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384 or self.headers.get_content_type() != "application/json":
                raise ValueError
            body = self.read_json_body()
            if not isinstance(body, dict) or body.get("action") not in ("status", "start"):
                raise ValueError
            options = None
            if body["action"] == "start":
                mode = body.get("mode", "canvas")
                if mode not in ("canvas", "ed", "both"):
                    raise ValueError
                options = {"session": ""}
                if mode != "ed":
                    session = body.get("session")
                    if not isinstance(session, str) or not session.strip():
                        raise ValueError
                    options["session"] = session.strip()
                if mode != "canvas":
                    token = body.get("edToken", "")
                    region = body.get("edRegion", "eu")
                    remember = body.get("rememberEd", False)
                    if not isinstance(token, str) or region not in ("eu", "us", "au") or not isinstance(remember, bool):
                        raise ValueError
                    options.update(
                        ed_token=token.strip(), ed_region=region, ed_only=(mode == "ed"),
                        ed_include=True, ed_remember=(remember and bool(token.strip())),
                    )
        except ValueError:
            self.send_json({"error": "Invalid Canvas Sync request."}, status=400)
            return
        archive = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
        if archive is None:
            self.send_json({"error": "Connect your Canvas-Archive folder first."}, status=404)
            return
        status, result = canvas_resync(archive, options)
        self.send_json(result, status=status)

    def handle_canvas_add_file(self) -> None:
        if not self.is_local_canvas_request():
            self.send_json({"error": "Add books and PDFs from local Study-OS."}, status=403)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            canvas_id = self.headers.get("X-Study-Course", "")
            encoded_name = self.headers.get("X-Study-Name", "")
            name = urllib.parse.unquote(encoded_name, errors="strict")
            if (
                not 0 < size <= MAX_DOCUMENT_BYTES
                or self.headers.get("Transfer-Encoding")
                or self.headers.get_content_type() != "application/octet-stream"
                or not re.fullmatch(r"(?:local-)?[0-9]{1,20}", canvas_id)
                or not name or name.startswith(".") or "/" in name or "\\" in name or any(ord(ch) < 32 for ch in name)
                or Path(name).suffix.lower() not in COURSE_DOCUMENT_TYPES
            ):
                raise ValueError
        except ValueError:
            self.send_json({"error": "Choose a PDF, EPUB or PowerPoint file up to 200 MB."}, status=400)
            return
        archive = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
        if archive is None:
            self.send_json({"error": "Connect your Canvas-Archive folder first."}, status=404)
            return
        self.connection.settimeout(35)
        status, result = add_canvas_document(archive, canvas_id, encoded_name, self.rfile, size)
        self.send_json(result, status=status)

    def handle_tutor(self, route: str) -> None:
        if not self.is_local_canvas_request():
            self.send_json({"error": "Open the local Study-OS app first."}, status=403)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 420_000 or self.headers.get_content_type() != "application/json":
                raise ValueError("Invalid tutor request.")
            body = self.read_json_body()
            if not isinstance(body, dict):
                raise ValueError("Invalid tutor request.")
            if route.endswith("/live"):
                LIVE_TUTOR.update(body)
            else:
                self.save_source_link(body)
        except (OSError, ValueError) as error:
            self.send_json({"error": str(error) if isinstance(error, ValueError) else "Could not save the source link."},
                           status=400)
            return
        self.send_json({"ok": True})

    def save_source_link(self, body: dict) -> None:
        course_id, question_id = body.get("courseId"), body.get("questionId")
        if not isinstance(course_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", course_id):
            raise ValueError("Choose a course.")
        bank = STORE.load_course_bank(course_id) or {}
        if not any(q["id"] == question_id for q in bank.get("questions", [])):
            raise ValueError("Choose an exercise in this course.")
        path = body.get("path", "")
        archive = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
        if path:
            page = body.get("page")
            if type(page) is not int or not 1 <= page <= 50_000 or not archive:
                raise ValueError("Choose a PDF and enter its page number.")
            files = canvas_course_documents(archive, str(bank.get("canvasId") or ""))
            source = next((file for file in files if file["path"] == path and file["kind"] == "pdf"), None)
            if not source:
                raise ValueError("Choose a PDF already in this course's local library.")
        with STATE_LOCK:
            links = read_source_links()
            if path:
                links[question_id] = {"path": source["path"], "title": source["name"], "page": page}
            else:
                links.pop(question_id, None)
            atomic_write_json(STORE.data_dir / "state" / "question-source-links.json", links)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path

        if route in ("/api/tutor/live", "/api/tutor/source-link"):
            self.handle_tutor(route)
            return

        if route == "/api/canvas/sync":
            self.handle_canvas_sync()
            return

        if route == "/api/canvas/add-file":
            self.handle_canvas_add_file()
            return

        try:
            body = self.read_json_body()
        except Exception as exc:
            self.send_json({"error": f"Invalid JSON: {exc}"}, status=400)
            return

        if route == "/api/calendar/refresh":
            self.send_json(STORE.build_bootstrap(force_calendar=True))
            return

        if route == "/api/canvas/config":
            save_settings(
                STORE.data_dir,
                {
                    "canvasArchivePath": str(body.get("canvasArchivePath") or "").strip(),
                    "obsidianVaultPath": str(body.get("obsidianVaultPath") or "").strip(),
                },
            )
            self.send_json(STORE.build_bootstrap(force_calendar=False))
            return

        if route == "/api/canvas/open-resync":
            archive_dir = resolve_canvas_archive(ROOT_DIR, STORE.data_dir)
            if archive_dir is None:
                self.send_json({"ok": False, "error": "Canvas-Archive folder not found."}, status=404)
                return
            res = launch_canvas_resync(archive_dir)
            self.send_json(res, status=200 if res.get("ok") else 400)
            return

        if route == "/api/canvas/import":
            with STATE_LOCK:
                if body.get("action") == "demo":
                    res = install_demo_course(ROOT_DIR, STORE.data_dir)
                else:
                    _, courses_by_id = STORE.discover_courses()
                    sel_ids = body.get("canvasIds")
                    res = import_courses_from_canvas_archive(
                        ROOT_DIR,
                        STORE.data_dir,
                        courses_by_id,
                        selected_canvas_ids=sel_ids if isinstance(sel_ids, list) else None,
                        overwrite=bool(body.get("overwrite", False)),
                    )
                boot = STORE.build_bootstrap(force_calendar=False)
            self.send_json({**res, "bootstrap": boot}, status=200 if res.get("ok") else 400)
            return

        if route == "/api/schedule/generate":
            with STATE_LOCK:
                _, courses_by_id = STORE.discover_courses()
                prog = STORE.load_progress()
                cur_cfg = load_custom_schedule(STORE.data_dir)
                prefs = {**default_schedule_prefs(), **(cur_cfg.get("prefs") or {}), **(body.get("prefs") or {})}
                ics_text = str(body.get("icsText") or "").strip()
                te_url = str(prefs.get("timeeditUrl") or "").strip()

                fixed_events: list[dict[str, Any]] = []
                try:
                    if ics_text:
                        fixed_events = parse_ics_events(ics_text)
                    elif te_url:
                        fetched_ics = fetch_timeedit_ics(te_url)
                        fixed_events = parse_ics_events(fetched_ics)
                    else:
                        # Use Canvas-Archive TimeEdit snapshot if available
                        fb = load_fallback_from_canvas_archive(ROOT_DIR, data_dir=STORE.data_dir, courses_by_id=courses_by_id)
                        fixed_events = [
                            {
                                "id": b["eventId"],
                                "summary": b["summary"],
                                "location": b.get("location", ""),
                                "start": b["startIso"],
                                "end": b["endIso"],
                            }
                            for b in fb
                        ]
                except Exception as exc:
                    self.send_json({"ok": False, "error": f"TimeEdit .ics error: {exc}"}, status=400)
                    return

                gen = generate_adaptive_schedule(
                    fixed_events=fixed_events,
                    courses_by_id=courses_by_id,
                    progress_state=prog,
                    prefs=prefs,
                    days_ahead=14,
                )
                save_custom_schedule(
                    STORE.data_dir,
                    {
                        "enabled": True,
                        "source": "timeedit_auto_scheduler",
                        "prefs": prefs,
                        "estimate": gen["estimate"],
                        "blocks": gen["blocks"],
                    },
                )
                boot = STORE.build_bootstrap(force_calendar=True)
            self.send_json({"ok": True, "estimate": gen["estimate"], "blockCount": len(gen["blocks"]), "bootstrap": boot})
            return

        if route == "/api/schedule/import-llm":
            with STATE_LOCK:
                if body.get("action") == "reset":
                    cur = load_custom_schedule(STORE.data_dir)
                    cur["enabled"] = False
                    save_custom_schedule(STORE.data_dir, cur)
                    boot = STORE.build_bootstrap(force_calendar=True)
                    self.send_json({"ok": True, "reset": True, "bootstrap": boot})
                    return

                raw_payload = str(body.get("payload") or "")
                _, courses_by_id = STORE.discover_courses()
                try:
                    blocks = parse_universal_schedule_payload(raw_payload, courses_by_id)
                except Exception as exc:
                    self.send_json({"ok": False, "error": str(exc)}, status=400)
                    return

                cur = load_custom_schedule(STORE.data_dir)
                cur.update(
                    {
                        "enabled": True,
                        "source": "llm_universal_import",
                        "blocks": blocks,
                    }
                )
                save_custom_schedule(STORE.data_dir, cur)
                boot = STORE.build_bootstrap(force_calendar=True)
            self.send_json({"ok": True, "blockCount": len(blocks), "bootstrap": boot})
            return

        if route == "/api/progress/status":
            # Mark 1 or multiple questions as not_started (uncomplete!), in_progress, done, revisit, or reset
            qids = body.get("questionIds") or ([body["questionId"]] if body.get("questionId") else [])
            new_status = str(body.get("status") or "not_started")
            reset_work = bool(body.get("resetWork", False))
            if new_status not in ("not_started", "in_progress", "done", "revisit"):
                self.send_json({"error": "Invalid status"}, status=400)
                return
            with STATE_LOCK:
                prog = STORE.load_progress()
                recs = prog.setdefault("records", {})
                now_iso = datetime.now(OSLO_TZ).isoformat()
                for qid in qids:
                    rec = recs.setdefault(str(qid), {})
                    rec["status"] = new_status
                    rec["updatedAt"] = now_iso
                    if reset_work or new_status == "not_started":
                        if reset_work:
                            for k in ("savedDraft", "savedChoice", "savedWiseflow", "checkedRubricIndices", "activeElapsedSec", "hintsUsed"):
                                rec.pop(k, None)
                STORE.save_progress(prog)
            self.send_json({"ok": True, "updated": len(qids), "status": new_status})
            return

        if route == "/api/progress/draft":
            qid = str(body.get("questionId") or "")
            if not qid:
                self.send_json({"error": "Missing questionId"}, status=400)
                return
            with STATE_LOCK:
                prog = STORE.load_progress()
                rec = prog.setdefault("records", {}).setdefault(qid, {})
                if "draft" in body:
                    rec["savedDraft"] = str(body["draft"] or "")
                if "choice" in body:
                    rec["savedChoice"] = body["choice"]
                if "wiseflowAnswers" in body and isinstance(body["wiseflowAnswers"], dict):
                    rec["savedWiseflow"] = body["wiseflowAnswers"]
                if "checkedRubricIndices" in body:
                    rec["checkedRubricIndices"] = body["checkedRubricIndices"]
                if "hintsUsed" in body:
                    rec["hintsUsed"] = int(body["hintsUsed"] or 0)
                if "activeElapsedSec" in body:
                    rec["activeElapsedSec"] = round(float(body["activeElapsedSec"] or 0), 1)
                if "profile" in body:
                    rec["lastProfile"] = str(body["profile"])
                has_wf = any(str(v).strip() != "" for v in (rec.get("savedWiseflow") or {}).values())
                if (rec.get("status") in (None, "not_started")) and (
                    rec.get("savedDraft", "").strip() or rec.get("savedChoice") is not None or has_wf
                ):
                    rec["status"] = "in_progress"
                rec["updatedAt"] = datetime.now(OSLO_TZ).isoformat()
                STORE.save_progress(prog)
            self.send_json({"ok": True})
            return

        if route == "/api/attempt":
            qid = str(body.get("questionId") or "")
            cid = str(body.get("courseId") or "")
            if not qid or not cid:
                self.send_json({"error": "Missing questionId or courseId"}, status=400)
                return

            assisted = bool(body.get("assisted", False))
            metrics = compute_attempt_metrics(
                active_sec=float(body.get("activeSec") or 1.0),
                ai_par_sec=float(body.get("aiParSec") or 120.0),
                hints_used=int(body.get("hintsUsed") or 0),
                hint_handicap_sec=float(body.get("hintHandicapSec") or 30.0),
                quality_accuracy=float(body.get("qualityAccuracy") or 0.0),
                assisted=assisted,
            )
            fsrs_grade = int(body.get("fsrsGrade") or metrics["suggestedFsrsGrade"])
            now = datetime.now(OSLO_TZ)

            with STATE_LOCK:
                prog = STORE.load_progress()
                rec = prog.setdefault("records", {}).setdefault(qid, {})
                prev_fsrs = dict(rec["fsrs"]) if isinstance(rec.get("fsrs"), dict) else None
                rec["prevFsrsSnapshot"] = prev_fsrs
                rec["fsrs"] = update_fsrs_card(prev_fsrs, fsrs_grade, now)
                rec["attemptCount"] = int(rec.get("attemptCount") or 0) + 1
                rec["lastAttemptAt"] = now.isoformat()
                rec["lastAttempt"] = metrics
                if body.get("draft") is not None:
                    rec["savedDraft"] = str(body["draft"])
                if body.get("choice") is not None:
                    rec["savedChoice"] = body["choice"]
                if isinstance(body.get("wiseflowAnswers"), dict):
                    rec["savedWiseflow"] = body["wiseflowAnswers"]
                if body.get("checkedRubricIndices") is not None:
                    rec["checkedRubricIndices"] = body["checkedRubricIndices"]

                # Automatic status update (user can still override anytime!)
                explicit_status = body.get("explicitStatus")
                if explicit_status in ("not_started", "in_progress", "done", "revisit"):
                    rec["status"] = explicit_status
                else:
                    rec["status"] = "done" if metrics["qualityAccuracy"] >= 0.75 else "revisit"

                if metrics["beatAi"]:
                    rec["beatAiCount"] = int(rec.get("beatAiCount") or 0) + 1
                if metrics["qualityAccuracy"] >= 0.85:
                    prev_pb = rec.get("pbEffectiveSec")
                    if prev_pb is None or metrics["effectiveSec"] < float(prev_pb):
                        rec["pbEffectiveSec"] = metrics["effectiveSec"]

                STORE.save_progress(prog)

                _, courses_by_id = STORE.discover_courses()
                q_obj = None
                if cid in courses_by_id:
                    for cand_q in courses_by_id[cid].get("questions") or []:
                        if cand_q.get("id") == qid:
                            q_obj = cand_q
                            break
                raw_dlpfc = body.get("dlpfcTier")
                if raw_dlpfc in (1, 2, 3):
                    dlpfc_tier = int(raw_dlpfc)
                elif q_obj is not None:
                    dlpfc_tier = effective_dlpfc_tier(q_obj, prev_fsrs and {"status": "done", "fsrs": prev_fsrs} or None)[0]
                else:
                    dlpfc_tier = 1 if body.get("kind") == "mcq" else 2

                raw_switches = body.get("focusSwitches")
                clean_switches = raw_switches[-25:] if isinstance(raw_switches, list) else []

                attempt_row = {
                    "timestamp": now.isoformat(),
                    "sessionId": body.get("sessionId") or "",
                    "courseId": cid,
                    "questionId": qid,
                    "topicId": str(body.get("topicId") or ""),
                    "kind": str(body.get("kind") or "mcq"),
                    "dlpfcTier": dlpfc_tier,
                    "profile": str(body.get("profile") or "learning"),
                    "hintsUsed": int(body.get("hintsUsed") or 0),
                    "assisted": assisted,
                    "fsrsGrade": fsrs_grade,
                    "focusSwitchCount": int(body.get("focusSwitchCount") or 0),
                    "awayElapsedSec": round(float(body.get("awayElapsedSec") or 0.0), 1),
                    "manualPauseCount": int(body.get("manualPauseCount") or 0),
                    "focusSwitches": clean_switches,
                    **metrics,
                }
                append_jsonl(STORE.attempts_path, attempt_row)

                analytics = build_full_analytics(ROOT_DIR, courses_by_id, prog)

            self.send_json(
                {
                    "ok": True,
                    "attempt": attempt_row,
                    "record": rec,
                    "analytics": analytics,
                }
            )
            return

        if route == "/api/progress/difficulty":
            # Optional 1-click perceived difficulty / FSRS override (`fsrsGrade` in 1..4 or `personalDifficulty` in 1..3)
            qid = str(body.get("questionId") or "")
            if not qid:
                self.send_json({"error": "Missing questionId"}, status=400)
                return
            grade_raw = body.get("fsrsGrade")
            pdiff_raw = body.get("personalDifficulty")
            now = datetime.now(OSLO_TZ)
            with STATE_LOCK:
                prog = STORE.load_progress()
                rec = prog.setdefault("records", {}).setdefault(qid, {})
                if grade_raw is not None:
                    grade = max(1, min(4, int(grade_raw)))
                    base_fsrs = rec.get("prevFsrsSnapshot") if "prevFsrsSnapshot" in rec else rec.get("fsrs")
                    rec["fsrs"] = update_fsrs_card(base_fsrs, grade, now)
                    rec["lastUserGrade"] = grade
                    # Map FSRS grade (1=Again, 2=Hard, 3=Good, 4=Easy) -> personalDifficulty (3=Hard, 2=Standard, 1=Easy)
                    rec["personalDifficulty"] = 3 if grade in (1, 2) else (1 if grade == 4 else 2)
                    if grade == 1:
                        rec["status"] = "revisit"
                    elif grade in (3, 4) and rec.get("status") == "revisit":
                        rec["status"] = "done"
                elif pdiff_raw is not None:
                    if pdiff_raw in (0, "auto", ""):
                        rec.pop("personalDifficulty", None)
                    else:
                        rec["personalDifficulty"] = max(1, min(3, int(pdiff_raw)))
                rec["updatedAt"] = now.isoformat()
                STORE.save_progress(prog)
                _, courses_by_id = STORE.discover_courses()
                analytics = build_full_analytics(ROOT_DIR, courses_by_id, prog)
            self.send_json({"ok": True, "record": rec, "analytics": analytics})
            return

        if route == "/api/session":
            now = datetime.now(OSLO_TZ)
            wall_sec = max(1.0, float(body.get("wallSec") or 60.0))
            active_sec = max(0.0, float(body.get("activeSec") or 0.0))
            focus_density = round(min(1.0, active_sec / wall_sec), 3) if wall_sec > 0 else 0.85
            avg_q = float(body.get("avgAccuracy") or 0.0)
            avg_pr = float(body.get("avgPaceRatio") or 0.0)
            reviewed_count = int(body.get("reviewedCount") or 0)

            upi = (
                round(100.0 * (0.45 * avg_q + 0.35 * min(avg_pr, 1.35) + 0.20 * focus_density))
                if reviewed_count > 0
                else None
            )

            session_row = {
                "sessionId": body.get("sessionId") or f"ses-{int(now.timestamp())}",
                "startedAt": body.get("startedAt") or now.isoformat(),
                "endedAt": now.isoformat(),
                "courseId": body.get("courseId") or "mixed",
                "topicIds": body.get("topicIds") or [],
                "profile": body.get("profile") or "learning",
                "calendarEventId": body.get("calendarEventId") or "",
                "calendarSummary": body.get("calendarSummary") or "",
                "reviewedCount": reviewed_count,
                "beatAiCount": int(body.get("beatAiCount") or 0),
                "activeSec": round(active_sec, 1),
                "wallSec": round(wall_sec, 1),
                "focusDensity": focus_density,
                "focusSwitchCount": int(body.get("focusSwitchCount") or 0),
                "awaySec": round(float(body.get("awaySec") or 0.0), 1),
                "highDlpfcSec": round(float(body.get("highDlpfcSec") or 0.0), 1),
                "avgAccuracy": round(avg_q, 3),
                "avgPaceRatio": round(avg_pr, 3),
                "upi": upi,
                "checkIn": body.get("checkIn") or None,
            }

            with STATE_LOCK:
                append_jsonl(STORE.sessions_path, session_row)
                catalog, courses_by_id = STORE.discover_courses()
                prog = STORE.load_progress()
                analytics = build_full_analytics(ROOT_DIR, courses_by_id, prog)
                cal = STORE.load_or_refresh_calendar(force=False)
                sessions = read_jsonl(STORE.sessions_path, max_lines=200)
                try:
                    write_obsidian_dashboard(ROOT_DIR, catalog, analytics, cal.get("blocks") or [], sessions)
                except Exception:
                    pass

            self.send_json({"ok": True, "session": session_row, "analytics": analytics})
            return

        if route == "/api/import-legacy":
            # Supports both Study-OS backups and legacy `Economics I Original Questions.html` exports!
            imported = 0
            with STATE_LOCK:
                prog = STORE.load_progress()
                recs = prog.setdefault("records", {})
                if body.get("format") == "study-os-backup-v1" and isinstance(body.get("progress"), dict):
                    src_recs = body["progress"].get("records") or {}
                    for qid, r in src_recs.items():
                        recs[qid] = r
                        imported += 1
                elif isinstance(body.get("records"), dict):
                    # Legacy Economics I Original Questions (`econ-originals-v1`)
                    for old_id, r in body["records"].items():
                        if not isinstance(r, dict):
                            continue
                        new_id = old_id if ":" in old_id else f"econ-2522:{old_id}"
                        dst = recs.setdefault(new_id, {})
                        st = r.get("status")
                        if not st:
                            if r.get("self") == "retry" or r.get("correct") is False:
                                st = "revisit"
                            elif r.get("self") == "solved" or r.get("correct") is True:
                                st = "done"
                            elif r.get("savedDraft") or r.get("savedChoice") is not None:
                                st = "in_progress"
                            else:
                                st = "not_started"
                        dst["status"] = st
                        if r.get("savedDraft"):
                            dst["savedDraft"] = r["savedDraft"]
                        if r.get("savedChoice") is not None:
                            dst["savedChoice"] = r["savedChoice"]
                        imported += 1
                STORE.save_progress(prog)
            self.send_json({"ok": True, "importedRecords": imported})
            return

        self.send_json({"error": "Unknown API endpoint"}, status=404)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Study-OS local server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open browser on start")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}"
    try:
        server = ThreadingHTTPServer((args.host, args.port), StudyOSHandler)
    except OSError:
        # Already running on this port! Just open browser if requested.
        print(f"Study-OS is already running at {url}")
        if args.open:
            webbrowser.open(url)
        return

    print(f"Study-OS running at {url}")
    print(f"Data directory (OneDrive-synced): {DATA_DIR}")
    if args.open:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Study-OS server.")
        server.server_close()


if __name__ == "__main__":
    main()
