"""Universal Read-Only Bridge between `Canvas-Archive` (`canvas-sync`) and `Study-OS`.

Allows any student who syncs their Canvas courses via a `canvas_session` cookie
in `Canvas-Archive` (`Canvas Resync.app` / `OPEN_RESYNC.cmd` / `canvas_sync.py`)
to:
  1. Auto-discover or configure their local `Canvas-Archive` directory.
  2. Start and monitor the installed Canvas Sync worker from Study-OS.
  3. Read live TimeEdit / Canvas timetable events (`ASSISTANT_CONTEXT/CURRENT.json`)
     automatically even without Google Calendar CLI setup.
  4. Import / scaffold ready-to-practice `Study-OS` course banks (`bank.json`)
     directly from downloaded Canvas PDFs, `.ipynb` notebooks, and modules,
     wired into Study-OS's Side-by-Side Split PDF Reader.

IMPORTANT: Strictly READ-ONLY with respect to `Canvas-Archive`. Never modifies
`Canvas-Archive` files, `.canvas-sync.json`, or active sync locks.
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo

from dlpfc import classify_intrinsic_dlpfc

OSLO_TZ = ZoneInfo("Europe/Oslo")
_RESYNC_URLS: dict[Path, str] = {}
_RESYNC_LOCK = threading.Lock()
COURSE_DOCUMENT_TYPES = {".pdf", ".epub", ".ppt", ".pptx"}
TUTOR_DOCUMENT_TYPES = COURSE_DOCUMENT_TYPES | {".md", ".txt", ".csv", ".py", ".ipynb"}
MAX_DOCUMENT_BYTES = 200 * 1024 * 1024

COURSE_COLORS = [
    "#28654d",
    "#1d5e8a",
    "#8c4a27",
    "#6d3b8e",
    "#2c6e7f",
    "#7a3e48",
]

EXAM_KEYWORDS = re.compile(
    r"\b(exam|eksamen|midterm|mock|sample\s+of\s+exam|past\s+paper|trial\s+exam|prøveeksamen|kontinuasjon)\b",
    re.I,
)
SOLUTION_KEYWORDS = re.compile(
    r"\b(solution|solutions|fasit|guideline|guidelines|sensorveiledning|examiner|suggested\s+answer|key|answers)\b|eba\d+l\.pdf$",
    re.I,
)
EXERCISE_KEYWORDS = re.compile(
    r"\b(exercise|exercises|problem|problems|assignment|homework|seminar|tutoring|practice|worksheet|case|øving|oppgave|quiz)\b",
    re.I,
)
SKIP_FILE_KEYWORDS = re.compile(
    r"\b(syllabus|course\s+outline|welcome|reading\s+list|pensum|schedule|timetable|title\s+page|front\s+page|formula\s+sheet)\b",
    re.I,
)


def settings_file_path(data_dir: Path) -> Path:
    return data_dir / "state" / "settings.json"


def load_settings(data_dir: Path) -> dict[str, Any]:
    path = settings_file_path(data_dir)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_settings(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    cur = load_settings(data_dir)
    for k, v in updates.items():
        if v is None or v == "":
            cur.pop(k, None)
        else:
            cur[k] = v
    cur["updatedAt"] = datetime.now(OSLO_TZ).isoformat()
    path = settings_file_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return cur


def looks_like_canvas_archive(path: Path) -> bool:
    if not path.is_dir():
        return False
    markers = (
        path / "SYNC_REPORT.json",
        path / ".canvas-sync.json",
        path / "canvas-sync" / "resync_app.py",
        path / "canvas-sync" / "canvas_sync.py",
        path / "ASSISTANT_CONTEXT" / "CURRENT.json",
    )
    if any(m.exists() for m in markers):
        return True
    try:
        return any(
            sub.is_dir() and re.search(r"--\d+$", sub.name)
            for sub in path.iterdir()
        )
    except OSError:
        return False


def resolve_canvas_archive(study_os_root: Path, data_dir: Path | None = None) -> Path | None:
    """Locate the student's `Canvas-Archive` directory across env, settings, sibling, or OneDrive."""
    candidates: list[Path] = []

    env_val = os.environ.get("STUDY_OS_CANVAS_ARCHIVE", "").strip()
    if env_val:
        candidates.append(Path(env_val).expanduser())

    if data_dir is not None:
        cfg_val = str(load_settings(data_dir).get("canvasArchivePath") or "").strip()
        if cfg_val:
            candidates.append(Path(cfg_val).expanduser())

    candidates.append(study_os_root.parent / "Canvas-Archive")

    home = Path.home()
    candidates.extend(
        [
            home / "Canvas-Archive",
            home / "Documents" / "Canvas-Archive",
        ]
    )

    # Check macOS / Windows OneDrive roots if sibling lookup did not match
    cloud_storage = home / "Library" / "CloudStorage"
    if cloud_storage.is_dir():
        try:
            for od in sorted(cloud_storage.glob("OneDrive*")):
                candidates.append(od / "Canvas-Archive")
        except OSError:
            pass
    try:
        for od in sorted(home.glob("OneDrive*")):
            if od.is_dir():
                candidates.append(od / "Canvas-Archive")
    except OSError:
        pass

    for cand in candidates:
        try:
            resolved = cand.resolve()
        except OSError:
            continue
        if looks_like_canvas_archive(resolved):
            return resolved
    return None


def _clean_course_title(raw_name: str) -> str:
    cleaned = re.sub(r"\s+-\s+(?:Oslo|Bergen|Trondheim|Stavanger|Nettstudier|Online)$", "", raw_name.strip(), flags=re.I)
    return cleaned.strip() or raw_name.strip()


def _slugify_course(title: str, canvas_id: str) -> str:
    low = title.lower()
    short_map = [
        ("economics", "econ"),
        ("accounting", "acct"),
        ("mathematics", "math"),
        ("organizational behavior", "ob"),
        ("organisational behaviour", "ob"),
        ("programming", "prog"),
        ("statistics", "stat"),
        ("finance", "fin"),
        ("marketing", "mkt"),
        ("strategy", "strat"),
    ]
    for needle, slug in short_map:
        if needle in low:
            return f"{slug}-{canvas_id}"
    words = re.findall(r"[a-z0-9]+", low)
    stop = {"introduction", "to", "of", "and", "for", "in", "the", "fundamentals"}
    core = [w for w in words if w not in stop] or words or ["course"]
    return f"{core[0][:8]}-{canvas_id}"


def _extract_course_codes_from_current(archive_dir: Path) -> dict[str, str]:
    current_path = archive_dir / "ASSISTANT_CONTEXT" / "CURRENT.json"
    out: dict[str, str] = {}
    if not current_path.is_file():
        return out
    try:
        data = json.loads(current_path.read_text(encoding="utf-8"))
        for ev in ((data.get("timetable") or {}).get("events") or []):
            cids = ev.get("course_ids") or []
            codes = ev.get("course_codes") or []
            if len(cids) == 1 and codes:
                cid = str(cids[0])
                if cid not in out and codes[0]:
                    out[cid] = str(codes[0]).strip()
    except Exception:
        pass
    return out


def _infer_course_code(canvas_id: str, folder_path: Path, code_map: dict[str, str]) -> str:
    if canvas_id in code_map:
        return code_map[canvas_id]
    files_dir = folder_path / "Files"
    if files_dir.is_dir():
        counts: dict[str, int] = {}
        for f in files_dir.iterdir():
            m = re.search(r"\b([A-ZÆØÅ]{2,4}\s?\d{4,5})\b", f.name)
            if m:
                norm = re.sub(r"^([A-ZÆØÅ]{2,4})\s*(\d{4,5})$", r"\1 \2", m.group(1).upper())
                counts[norm] = counts.get(norm, 0) + 1
        if counts:
            return max(counts.items(), key=lambda kv: kv[1])[0]
    return f"CANVAS {canvas_id}"


def _discover_archive_courses(archive_dir: Path) -> list[dict[str, str]]:
    report_path = archive_dir / "SYNC_REPORT.json"
    found: dict[str, dict[str, str]] = {}
    if report_path.is_file():
        try:
            rep = json.loads(report_path.read_text(encoding="utf-8"))
            for c in rep.get("courses") or []:
                cid = str(c.get("id") or "").strip()
                folder = str(c.get("folder") or "").strip()
                if cid and folder and (archive_dir / folder).is_dir():
                    found[cid] = {
                        "canvasId": cid,
                        "name": str(c.get("name") or folder.rsplit("--", 1)[0]),
                        "folder": folder,
                    }
        except Exception:
            pass

    for sub in sorted(archive_dir.iterdir()):
        if not sub.is_dir():
            continue
        m = re.match(r"^(.+)--(\d+|local-[1-9]\d*)$", sub.name)
        if m and m.group(2) not in found:
            found[m.group(2)] = {
                "canvasId": m.group(2),
                "name": m.group(1),
                "folder": sub.name,
            }
    return list(found.values())


def canvas_course_documents(archive_dir: Path, canvas_id: str, *, tutoring: bool = False) -> list[dict[str, str]]:
    course = next((entry for entry in _discover_archive_courses(archive_dir)
                   if entry["canvasId"] == canvas_id), None)
    if not course:
        return []
    course_folder = archive_dir / course["folder"]
    folder = (course_folder if tutoring else course_folder / "Files").resolve()
    if archive_dir not in folder.parents:
        return []
    types = TUTOR_DOCUMENT_TYPES if tutoring else COURSE_DOCUMENT_TYPES
    return [
        {"name": path.name, "path": path.relative_to(archive_dir).as_posix(),
         "kind": path.suffix.lower()[1:]}
        for path in sorted(folder.rglob("*"), key=lambda path: (path.name.casefold(), path))
        if path.suffix.lower() in types and not any(part.startswith(".") for part in path.relative_to(folder).parts)
        and path.is_file() and archive_dir in path.resolve().parents
    ]


def inspect_canvas_archive(
    study_os_root: Path,
    data_dir: Path,
    existing_courses: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return read-only status, sync freshness, and course linkage for `Canvas-Archive`."""
    cfg = load_settings(data_dir)
    archive_dir = resolve_canvas_archive(study_os_root, data_dir)
    if archive_dir is None:
        return {
            "connected": False,
            "configuredPath": cfg.get("canvasArchivePath") or "",
            "archivePath": "",
            "hasResyncApp": False,
            "syncActive": False,
            "lastSyncAt": None,
            "timetableAvailable": False,
            "courses": [],
            "unimportedCount": 0,
        }

    existing_by_canvas_id: dict[str, str] = {}
    referenced_paths: set[str] = set()
    for cid, bank in (existing_courses or {}).items():
        b_canvas = str(bank.get("canvasId") or "").strip()
        if b_canvas:
            existing_by_canvas_id[b_canvas] = cid
        elif "-" in cid and cid.rsplit("-", 1)[-1].isdigit():
            existing_by_canvas_id[cid.rsplit("-", 1)[-1]] = cid
        for src in (bank.get("sources") or {}).values():
            cp = str((src or {}).get("canvasPath") or "").strip().replace("\\", "/")
            if cp:
                referenced_paths.add(cp)

    resync_script = archive_dir / "canvas-sync" / "resync_app.py"
    mac_app = archive_dir / "Canvas Resync.app"
    win_cmd = archive_dir / "OPEN_RESYNC.cmd"
    has_resync = resync_script.is_file() or mac_app.is_dir() or win_cmd.is_file()

    report_path = archive_dir / "SYNC_REPORT.json"
    last_sync_iso: str | None = None
    if report_path.is_file():
        last_sync_iso = datetime.fromtimestamp(report_path.stat().st_mtime, tz=OSLO_TZ).isoformat()

    current_path = archive_dir / "ASSISTANT_CONTEXT" / "CURRENT.json"
    timetable_available = False
    if current_path.is_file():
        try:
            cur_meta = json.loads(current_path.read_text(encoding="utf-8"))
            timetable_available = bool((cur_meta.get("timetable") or {}).get("events"))
            if not last_sync_iso and cur_meta.get("published_at"):
                last_sync_iso = str(cur_meta["published_at"])
        except Exception:
            pass

    code_map = _extract_course_codes_from_current(archive_dir)
    courses_out: list[dict[str, Any]] = []
    unimported_count = 0

    for entry in _discover_archive_courses(archive_dir):
        canvas_id = entry["canvasId"]
        folder_name = entry["folder"]
        folder_path = archive_dir / folder_name
        clean_title = _clean_course_title(entry["name"])
        code = _infer_course_code(canvas_id, folder_path, code_map)

        pdfs: list[Path] = []
        notebooks: list[Path] = []
        for sub_rel in ("Files", "Practice"):
            sub_dir = folder_path / sub_rel
            if sub_dir.is_dir():
                pdfs.extend(sorted(sub_dir.rglob("*.pdf")))
                notebooks.extend(sorted(sub_dir.rglob("*.ipynb")))

        exam_pdfs = [
            p for p in pdfs
            if EXAM_KEYWORDS.search(p.name) and not SOLUTION_KEYWORDS.search(p.name)
        ]
        exercise_pdfs = [
            p for p in pdfs
            if not EXAM_KEYWORDS.search(p.name)
            and not SOLUTION_KEYWORDS.search(p.name)
            and EXERCISE_KEYWORDS.search(p.name)
        ]
        is_program_hub = bool(
            re.search(r"\b(bachelor|master|programme|program\s+hub|orientation)\b", clean_title, re.I)
            and not exam_pdfs
            and not exercise_pdfs
            and not notebooks
        )

        linked_id = existing_by_canvas_id.get(canvas_id, "")
        untracked_exams = 0
        for p in exam_pdfs:
            rel_cp = p.relative_to(archive_dir).as_posix()
            if rel_cp not in referenced_paths:
                untracked_exams += 1

        if not linked_id and not is_program_hub and (pdfs or notebooks):
            unimported_count += 1

        courses_out.append(
            {
                "canvasId": canvas_id,
                "code": code,
                "title": clean_title,
                "folder": folder_name,
                "pdfCount": len(pdfs),
                "notebookCount": len(notebooks),
                "examCount": len(exam_pdfs),
                "exerciseCount": len(exercise_pdfs),
                "isProgramHub": is_program_hub,
                "linkedCourseId": linked_id,
                "suggestedCourseId": linked_id or _slugify_course(clean_title, canvas_id),
                "untrackedExamFiles": untracked_exams,
            }
        )

    return {
        "connected": True,
        "configuredPath": cfg.get("canvasArchivePath") or "",
        "archivePath": str(archive_dir),
        "hasResyncApp": has_resync,
        "lastSyncAt": last_sync_iso,
        "timetableAvailable": timetable_available,
        "courses": courses_out,
        "unimportedCount": unimported_count,
    }


def _resync_environment() -> dict[str, str]:
    clean_env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
    for secret_key in ("CANVAS_SESSION", "CANVAS_TOKEN", "ED_API_TOKEN", "CANVAS_OAUTH_SESSION", "CANVAS_OAUTH_CONFIG"):
        clean_env.pop(secret_key, None)
    return clean_env


def _resync_python(archive_dir: Path) -> str:
    tool = archive_dir / "canvas-sync"
    candidates = [
        tool / ".venv-macos" / "bin" / "python3",
        tool / ".venv" / "Scripts" / "python.exe",
        tool / ".venv" / "bin" / "python3",
        Path(sys.executable),
    ]
    return next((str(path) for path in candidates if path.is_file()), sys.executable)


def launch_canvas_resync(archive_dir: Path) -> dict[str, Any]:
    """Open the standalone Canvas Sync app."""
    resync_py = archive_dir / "canvas-sync" / "resync_app.py"
    clean_env = _resync_environment()

    if resync_py.is_file():
        py_bin = _resync_python(archive_dir)
        popen_kwargs: dict[str, Any] = {
            "cwd": str(archive_dir),
            "env": clean_env,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            popen_kwargs["start_new_session"] = True
        subprocess.Popen([py_bin, str(resync_py), "--archive", str(archive_dir)], **popen_kwargs)
        return {
            "ok": True,
            "message": "Opened Canvas Resync cookie-session window in your browser.",
        }

    mac_app = archive_dir / "Canvas Resync.app"
    if sys.platform == "darwin" and mac_app.is_dir():
        subprocess.Popen(["open", str(mac_app)], env=clean_env)
        return {"ok": True, "message": "Launched Canvas Resync.app."}

    win_cmd = archive_dir / "OPEN_RESYNC.cmd"
    if os.name == "nt" and win_cmd.is_file():
        os.startfile(str(win_cmd))  # type: ignore[attr-defined]
        return {"ok": True, "message": "Launched OPEN_RESYNC.cmd."}

    return {
        "ok": False,
        "error": "Could not find canvas-sync/resync_app.py inside Canvas-Archive.",
    }


_RESYNC_WITHOUT_BROWSER = """
import contextlib
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
from resync_app import find_window, instance_folder, launch
root = Path(sys.argv[2])
with contextlib.redirect_stdout(sys.stderr):
    if launch(root, open_browser=False):
        raise SystemExit(1)
url = find_window(root, instance_folder(root))
if not url:
    raise SystemExit(1)
print(url)
"""


def _resync_url(archive_dir: Path) -> str:
    with _RESYNC_LOCK:
        url = _RESYNC_URLS.get(archive_dir)
        if url:
            return url
        tool = archive_dir / "canvas-sync"
        if not (tool / "resync_app.py").is_file():
            raise ValueError("Install Canvas Sync in your Canvas-Archive folder first.")
        run = subprocess.run(
            [_resync_python(archive_dir), "-B", "-c", _RESYNC_WITHOUT_BROWSER, str(tool), str(archive_dir)],
            cwd=tool, env=_resync_environment(), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=25,
        )
        url = run.stdout.strip()
        match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})/[A-Za-z0-9_-]{43}/", url)
        if run.returncode or not match or not 1 <= int(match[1]) <= 65535:
            raise ValueError("Canvas Sync could not start here. Open the standalone app to check its setup.")
        _RESYNC_URLS[archive_dir] = url
        return url


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _engine_request(url: str, route: str, data: Any = None, headers: dict[str, str] | None = None) -> Request:
    if data is None:
        return Request(url + route)
    origin, key = url.rstrip("/").rsplit("/", 1)
    return Request(url + route, data, headers={"Origin": origin, "X-Canvas-Client": key, **(headers or {})})


def canvas_resync(archive_dir: Path, options: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    """Use the installed, loopback-only Canvas Sync process for status and start."""
    try:
        url = _resync_url(archive_dir)
    except ValueError as exc:
        return 503, {"error": str(exc)}
    except (OSError, subprocess.SubprocessError):
        return 503, {"error": "Canvas Sync could not start. Try again or open the standalone app."}

    req = _engine_request(url, "status")
    if options is not None:
        req = _engine_request(url, "start", json.dumps(options).encode("utf-8"),
                              {"Content-Type": "application/json"})
    try:
        # The broker follows only its validated loopback URL. In particular, a
        # redirect must never forward the session or engine authorization key.
        opener = build_opener(ProxyHandler({}), _RejectRedirects())
        with opener.open(req, timeout=8) as response:
            result = json.load(response)
        if options is not None:
            return 202, {"started": True}
        if not isinstance(result, dict) or result.get("archive") != str(archive_dir.resolve()):
            raise ValueError("Canvas Sync archive mismatch")
        return 200, {
            "phase": result.get("phase"), "message": result.get("message"),
            "started": result.get("started"), "finished": result.get("finished"),
            "estimated_remaining_seconds": result.get("estimated_remaining_seconds"),
            "log": (result.get("log") or "")[-16000:],
        }
    except HTTPError as exc:
        if options is not None and exc.code == 409:
            return 409, {"error": "A sync is already running. Reopen the dialog to see its progress."}
        if options is not None and exc.code == 400:
            label = "Canvas session and Ed token" if options.get("ed_include") else "Canvas session"
            if options.get("ed_only"):
                label = "Ed token and region"
            return 400, {"error": f"Check your {label} and try again."}
    except (URLError, TimeoutError, ValueError):
        pass

    with _RESYNC_LOCK:
        if _RESYNC_URLS.get(archive_dir) == url:
            _RESYNC_URLS.pop(archive_dir)
    return 502, {"error": "Lost the connection to Canvas Sync. Reopen the dialog to reconnect."}


def add_canvas_document(archive_dir: Path, canvas_id: str, encoded_name: str,
                        stream: Any, size: int) -> tuple[int, dict[str, Any]]:
    def chunks():
        remaining = size
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("Incomplete file")
            remaining -= len(chunk)
            yield chunk

    try:
        url = _resync_url(archive_dir)
        req = _engine_request(url, "library/upload", chunks(), {
            "Content-Type": "application/octet-stream", "Content-Length": str(size),
            "X-Study-Course": canvas_id, "X-Study-Name": encoded_name,
        })
        with build_opener(ProxyHandler({}), _RejectRedirects()).open(req, timeout=40) as response:
            result = json.load(response)
        return 201, {"name": result["name"], "reused": bool(result.get("reused"))}
    except HTTPError as error:
        if error.code == 409:
            return 409, {"error": "Wait for the running sync or file import to finish."}
        if error.code == 400:
            return 400, {"error": "Canvas Sync could not copy this file. Check the course and available disk space."}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return 502, {"error": "Could not add the file. Check the Canvas Sync app and try again."}


def _strip_id_prefix(filename: str) -> str:
    stem = Path(filename).stem
    return re.sub(r"^\d+--", "", stem).replace("_", " ").strip()


def _match_solution_file(target: Path, solution_files: list[Path]) -> Path | None:
    t_clean = _strip_id_prefix(target.name).lower()
    t_nums = re.findall(r"\d{2,4}[a-z]?|\b\d+\b", t_clean)
    best: tuple[int, Path | None] = (0, None)
    for sf in solution_files:
        s_clean = _strip_id_prefix(sf.name).lower()
        score = 0
        for tok in set(re.findall(r"[a-z]{4,}|\d{1,4}[a-z]?", t_clean)):
            if tok in {"exam", "exercise", "exercises", "problem", "problems", "pdf"}:
                continue
            if tok in s_clean:
                score += 3 if tok in t_nums else 2
        if score > best[0] and score >= 3:
            best = (score, sf)
    return best[1]


def _extract_obsidian_mapping(archive_dir: Path, study_os_root: Path) -> dict[str, str]:
    ai_cfg = archive_dir / "AI_CONFIG.json"
    vault_dir = study_os_root.parent / "Obsidian Vault"
    out: dict[str, str] = {}
    if not ai_cfg.is_file() or not vault_dir.is_dir():
        return out
    try:
        cfg = json.loads(ai_cfg.read_text(encoding="utf-8"))
        # Support map or list formats in AI_CONFIG.json
        notes = cfg.get("study_notes") or cfg.get("notes") or {}
        if isinstance(notes, dict):
            for cid, entry in notes.items():
                if isinstance(entry, str) and (vault_dir / entry).is_file():
                    out[str(cid)] = entry
                elif isinstance(entry, list):
                    for item in entry:
                        rel = item.get("path") if isinstance(item, dict) else str(item)
                        if rel and (vault_dir / rel).is_file():
                            out[str(cid)] = rel
                            break
    except Exception:
        pass
    return out


def _infer_topics_from_files(all_files: list[Path], obs_main: str) -> list[dict[str, Any]]:
    discovered: dict[int, str] = {}
    rx = re.compile(r"\b(?:lecture|lesson|topic|chapter|module|forelesning)\s*0*(\d{1,2})\b[\s:_-]*([A-Za-z][^\d\n._]{3,45})?", re.I)
    for f in all_files:
        clean = _strip_id_prefix(f.name)
        if SOLUTION_KEYWORDS.search(clean) or EXAM_KEYWORDS.search(clean):
            continue
        m = rx.search(clean)
        if m:
            num = int(m.group(1))
            if 1 <= num <= 24 and num not in discovered:
                sub = (m.group(2) or "").strip(" -_—()")
                discovered[num] = f"Topic {num}: {sub}" if sub else f"Topic {num}"
    if len(discovered) >= 3:
        return [
            {
                "id": str(num),
                "number": num,
                "title": discovered[num],
                "obsidianFile": obs_main,
                "obsidianHeading": "",
                "keywords": [w.lower() for w in re.findall(r"[A-Za-z]{4,}", discovered[num])[:6]],
            }
            for num in sorted(discovered)
        ]
    return [
        {"id": "1", "number": 1, "title": "Core Lectures & Concepts", "obsidianFile": obs_main, "obsidianHeading": "", "keywords": ["lecture", "concept", "theory"]},
        {"id": "2", "number": 2, "title": "Problem Sets & Exercises", "obsidianFile": obs_main, "obsidianHeading": "", "keywords": ["exercise", "problem", "seminar"]},
        {"id": "3", "number": 3, "title": "Exam Preparation & Synthesis", "obsidianFile": obs_main, "obsidianHeading": "", "keywords": ["exam", "mock", "case"]},
    ]


def _parse_ipynb_tasks(nb_path: Path, archive_dir: Path, course_id: str, topic_id: str, coll_id: str, src_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
    except Exception:
        return items
    cells = nb.get("cells") or []
    stem_label = _strip_id_prefix(nb_path.name)
    task_idx = 0
    for i, cell in enumerate(cells):
        if cell.get("cell_type") != "markdown":
            continue
        md = "".join(cell.get("source") or []).strip()
        if not re.match(r"^#{1,3}\s+(?:Task|Exercise|Problem|Question)\b", md, re.I):
            continue
        task_idx += 1
        lines = md.splitlines()
        heading = re.sub(r"^#{1,3}\s+", "", lines[0]).strip()
        body = "\n".join(lines[1:]).strip() or heading
        code_starter = ""
        if i + 1 < len(cells) and cells[i + 1].get("cell_type") == "code":
            code_starter = "".join(cells[i + 1].get("source") or []).strip()
        if code_starter:
            body = f"{body}\n\n```python\n{code_starter}\n```"
        lid = f"NB-{nb_path.stem[:10]}-{task_idx}"
        qid = f"{course_id}:{re.sub(r'[^A-Za-z0-9_-]', '', lid)}"
        q_obj: dict[str, Any] = {
            "id": qid,
            "localId": lid,
            "courseId": course_id,
            "topicId": topic_id,
            "collectionId": coll_id,
            "sourceId": src_id,
            "origin": "original_exercise",
            "kind": "coding",
            "difficulty": 2,
            "title": f"{stem_label} · {heading}",
            "promptMarkdown": body,
            "promptAssets": [],
            "contextMarkdown": "",
            "contextAssets": [],
            "svgDiagram": "",
            "options": [],
            "answerIndex": None,
            "numericCheck": None,
            "rubricChecks": [
                "Write clean, runnable code in a notebook cell without syntax or runtime errors",
                "Verify output on edge cases and format printed/plotted results clearly",
            ],
            "hints": [
                "Break the prompt into inputs, transformation steps, and expected output format.",
                "Test intermediate variables on a small example before running the full cell.",
            ],
            "solutionMarkdown": f"Compare your executed output against the course solution notebook (`{nb_path.relative_to(archive_dir).as_posix()}`).",
            "solutionAssets": [],
            "pitfall": "",
            "obsidianLink": {"file": "", "heading": ""},
            "pacing": {
                "learning": {"target": 14.0, "min": 9.0, "max": 20.0},
                "exam": {"target": 9.0, "min": 6.0, "max": 13.0},
                "stuckMinutes": 4.5,
                "reviewMinutes": 2.0,
                "hintHandicapSeconds": 60,
                "rationale": "Imported Canvas Jupyter notebook task.",
            },
            "available": True,
            "tags": ["canvas-import", "notebook", "coding"],
        }
        tier, cog = classify_intrinsic_dlpfc(q_obj)
        q_obj["dlpfcBase"] = tier
        q_obj["cognitiveType"] = cog
        items.append(q_obj)
    return items


def build_course_bank_from_canvas_folder(
    archive_dir: Path,
    study_os_root: Path,
    course_meta: dict[str, Any],
    color_idx: int = 0,
    obs_note: str = "",
) -> dict[str, Any]:
    """Scaffold a schemaVersion-1 `bank.json` from a synced `Canvas-Archive` course folder."""
    canvas_id = str(course_meta["canvasId"])
    course_id = str(course_meta["suggestedCourseId"])
    folder_path = archive_dir / str(course_meta["folder"])
    title = str(course_meta["title"])
    code = str(course_meta["code"])

    all_pdfs: list[Path] = []
    all_nbs: list[Path] = []
    for sub_name in ("Files", "Practice"):
        sub_dir = folder_path / sub_name
        if sub_dir.is_dir():
            all_pdfs.extend(sorted(sub_dir.rglob("*.pdf")))
            all_nbs.extend(sorted(sub_dir.rglob("*.ipynb")))

    topics = _infer_topics_from_files([*all_pdfs, *all_nbs], obs_note)
    default_topic_id = topics[0]["id"]
    exam_topic_id = topics[-1]["id"]

    sol_pdfs = [p for p in all_pdfs if SOLUTION_KEYWORDS.search(p.name)]
    exam_pdfs = [
        p for p in all_pdfs
        if EXAM_KEYWORDS.search(p.name)
        and not SOLUTION_KEYWORDS.search(p.name)
        and not SKIP_FILE_KEYWORDS.search(p.name)
    ]
    ex_pdfs = [
        p for p in all_pdfs
        if p not in exam_pdfs
        and not SOLUTION_KEYWORDS.search(p.name)
        and not SKIP_FILE_KEYWORDS.search(p.name)
        and EXERCISE_KEYWORDS.search(p.name)
    ]
    # Fallback: if a course names files by week/lecture without "exercise"/"exam", include top non-solution PDFs
    if not exam_pdfs and not ex_pdfs and all_pdfs:
        ex_pdfs = [p for p in all_pdfs if not SOLUTION_KEYWORDS.search(p.name) and not SKIP_FILE_KEYWORDS.search(p.name)][:20]

    sources: dict[str, dict[str, str]] = {}
    collections: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []

    def register_source(prefix: str, idx: int, path_obj: Path) -> str:
        sid = f"{prefix}_{idx}"
        sources[sid] = {
            "title": _strip_id_prefix(path_obj.name),
            "canvasPath": path_obj.relative_to(archive_dir).as_posix(),
        }
        return sid

    if exam_pdfs:
        collections.append({"id": "canvas-exams", "title": "Official Past Exams & Mock Papers (Canvas)", "kind": "exam", "durationMinutes": 180})
        for idx, ep in enumerate(exam_pdfs, 1):
            qp_sid = register_source("EXAM", idx, ep)
            sol_match = _match_solution_file(ep, sol_pdfs)
            sol_sid = register_source("EXAMSOL", idx, sol_match) if sol_match else ""
            label = _strip_id_prefix(ep.name)
            lid = f"EX-{idx}"
            sol_note = (
                f"Open the matched official solution/guideline PDF (`{sources[sol_sid]['title']}`) in the **Source PDF** tab above to grade each part."
                if sol_sid
                else "Review against official lecture notes and examiner criteria in your Canvas-Archive."
            )
            q_obj: dict[str, Any] = {
                "id": f"{course_id}:{lid}",
                "localId": lid,
                "courseId": course_id,
                "topicId": exam_topic_id,
                "collectionId": "canvas-exams",
                "sourceId": qp_sid,
                "solutionSourceId": sol_sid,
                "origin": "original_exam",
                "kind": "written",
                "difficulty": 3,
                "title": f"Past Exam · {label}",
                "promptMarkdown": (
                    f"Complete **{label}** using the embedded **Source PDF** reader on the left (`V` to toggle Split View).\n\n"
                    "Work under timed exam conditions before revealing the solution guide."
                ),
                "promptAssets": [],
                "contextMarkdown": "",
                "contextAssets": [],
                "svgDiagram": "",
                "options": [],
                "answerIndex": None,
                "numericCheck": None,
                "rubricChecks": [
                    "Completed all exam sections independently within the target time budget",
                    "Checked method, units/rounding, and edge-case reasoning against official criteria",
                    "Logged any missed sub-questions as Revisit for spaced FSRS follow-up",
                ],
                "hints": [
                    "Do a fast 2-minute pass across the Source PDF first to allocate minutes proportional to points.",
                    "Write explicit assumptions and intermediate steps so partial credit is protected.",
                ],
                "solutionMarkdown": sol_note,
                "solutionAssets": [],
                "pitfall": "",
                "obsidianLink": {"file": obs_note, "heading": ""},
                "pacing": {
                    "learning": {"target": 45.0, "min": 30.0, "max": 75.0},
                    "exam": {"target": 35.0, "min": 20.0, "max": 60.0},
                    "stuckMinutes": 8.0,
                    "reviewMinutes": 5.0,
                    "hintHandicapSeconds": 60,
                    "rationale": "Full Canvas exam paper sit via Split PDF Reader.",
                },
                "available": True,
                "tags": ["canvas-import", "exam"],
            }
            tier, cog = classify_intrinsic_dlpfc(q_obj)
            q_obj["dlpfcBase"] = tier
            q_obj["cognitiveType"] = cog
            questions.append(q_obj)

    if ex_pdfs:
        collections.append({"id": "canvas-exercises", "title": "Course Problem Sets & Exercises (Canvas)", "kind": "exercise"})
        for idx, xp in enumerate(ex_pdfs, 1):
            xp_sid = register_source("EXER", idx, xp)
            sol_match = _match_solution_file(xp, sol_pdfs)
            sol_sid = register_source("EXERSOL", idx, sol_match) if sol_match else ""
            label = _strip_id_prefix(xp.name)
            m_top = re.search(r"\b(?:topic|lecture|lesson|chapter|set|assignment)\s*0*(\d{1,2})\b", label, re.I)
            tid = str(int(m_top.group(1))) if (m_top and any(t["id"] == str(int(m_top.group(1))) for t in topics)) else default_topic_id
            lid = f"PS-{idx}"
            sol_note = (
                f"Compare your workings step-by-step against `{sources[sol_sid]['title']}` in the **Source PDF** tab."
                if sol_sid
                else "Verify your steps against your lecture slides and worked examples."
            )
            q_obj = {
                "id": f"{course_id}:{lid}",
                "localId": lid,
                "courseId": course_id,
                "topicId": tid,
                "collectionId": "canvas-exercises",
                "sourceId": xp_sid,
                "solutionSourceId": sol_sid,
                "origin": "original_exercise",
                "kind": "calculation",
                "difficulty": 2,
                "title": label,
                "promptMarkdown": (
                    f"Solve **{label}** using the **Source PDF** tab in Split View (`V`).\n\n"
                    "Record your working or key numerical/conceptual conclusions in the scratchpad before checking."
                ),
                "promptAssets": [],
                "contextMarkdown": "",
                "contextAssets": [],
                "svgDiagram": "",
                "options": [],
                "answerIndex": None,
                "numericCheck": None,
                "rubricChecks": [
                    "Solved core problems unassisted before consulting solutions",
                    "Verified final numerical answers, signs, and units",
                ],
                "hints": [
                    "Identify which lecture model or formula governs each sub-problem before calculating.",
                    "Check boundary conditions, signs, and units on your final expression.",
                ],
                "solutionMarkdown": sol_note,
                "solutionAssets": [],
                "pitfall": "",
                "obsidianLink": {"file": obs_note, "heading": ""},
                "pacing": {
                    "learning": {"target": 20.0, "min": 12.0, "max": 30.0},
                    "exam": {"target": 12.0, "min": 8.0, "max": 18.0},
                    "stuckMinutes": 5.0,
                    "reviewMinutes": 3.0,
                    "hintHandicapSeconds": 60,
                    "rationale": "Canvas problem set via Split PDF Reader.",
                },
                "available": True,
                "tags": ["canvas-import", "exercise"],
            }
            tier, cog = classify_intrinsic_dlpfc(q_obj)
            q_obj["dlpfcBase"] = tier
            q_obj["cognitiveType"] = cog
            questions.append(q_obj)

    nb_candidates = [nb for nb in all_nbs if not SOLUTION_KEYWORDS.search(nb.name)]
    if nb_candidates:
        collections.append({"id": "canvas-notebooks", "title": "Jupyter Coding Notebooks (Canvas)", "kind": "drill"})
        for idx, nb in enumerate(nb_candidates[:12], 1):
            nb_sid = register_source("NB", idx, nb)
            parsed_tasks = _parse_ipynb_tasks(nb, archive_dir, course_id, default_topic_id, "canvas-notebooks", nb_sid)
            questions.extend(parsed_tasks)

    if not questions:
        collections.append({"id": "canvas-study", "title": "Course Study Pack", "kind": "drill"})
        questions.append(
            {
                "id": f"{course_id}:INTRO-1",
                "localId": "INTRO-1",
                "courseId": course_id,
                "topicId": default_topic_id,
                "collectionId": "canvas-study",
                "origin": "lecture",
                "kind": "written",
                "difficulty": 2,
                "dlpfcBase": 2,
                "cognitiveType": "procedural_application",
                "title": f"{code} · Active Recall & Syllabus Overview",
                "promptMarkdown": f"Summarize the core models, exam format, and key formulas for **{title}** from memory before checking your synced Canvas materials.",
                "promptAssets": [],
                "contextMarkdown": "",
                "contextAssets": [],
                "svgDiagram": "",
                "options": [],
                "answerIndex": None,
                "numericCheck": None,
                "rubricChecks": [
                    "Listed core examinable topics and assessment rules",
                    "Identified highest-weight problem types to drill",
                ],
                "hints": [
                    "Check Announcements and Exam Information in your Canvas-Archive.",
                    "Map each module to concrete problem types.",
                ],
                "solutionMarkdown": "Review your synced course folder in `Canvas-Archive` or ask your AI coding agent to enrich this `bank.json` using `AI_AGENT_PROTOCOL.md`.",
                "solutionAssets": [],
                "pitfall": "",
                "obsidianLink": {"file": obs_note, "heading": ""},
                "pacing": {
                    "learning": {"target": 10.0, "min": 6.0, "max": 15.0},
                    "exam": {"target": 6.0, "min": 4.0, "max": 9.0},
                    "stuckMinutes": 3.0,
                    "reviewMinutes": 1.5,
                    "hintHandicapSeconds": 45,
                    "rationale": "Initial course orientation recall.",
                },
                "available": True,
                "tags": ["canvas-import"],
            }
        )

    short_words = [w for w in title.split() if w.lower() not in {"introduction", "to", "of", "and", "fundamentals", "for"}]
    short_title = " ".join(short_words[:2]) if short_words else code

    return {
        "schemaVersion": 1,
        "courseId": course_id,
        "canvasId": canvas_id,
        "code": code,
        "title": title,
        "shortTitle": short_title,
        "semester": "Synced from Canvas-Archive",
        "color": COURSE_COLORS[color_idx % len(COURSE_COLORS)],
        "examInfo": {
            "date": "",
            "format": "Synced from Canvas-Archive (Split PDF Reader + Timed Practice)",
            "durationMinutes": 180,
            "notes": f"Auto-scaffolded from Canvas-Archive/{course_meta['folder']}. Use Split View (V) to read original PDFs side-by-side.",
        },
        "obsidian": {
            "vault": "Obsidian Vault",
            "mainReference": obs_note,
            "workedExamples": "",
            "practiceNote": "",
        },
        "topics": topics,
        "collections": collections,
        "sources": sources,
        "questions": questions,
    }


def import_courses_from_canvas_archive(
    study_os_root: Path,
    data_dir: Path,
    existing_courses: dict[str, dict[str, Any]],
    selected_canvas_ids: list[str] | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Import unimported (or selected) courses from `Canvas-Archive` into `data/courses/`."""
    status = inspect_canvas_archive(study_os_root, data_dir, existing_courses)
    if not status.get("connected"):
        return {"ok": False, "error": "Canvas-Archive not found. Configure its folder path or run Canvas Resync first."}

    archive_dir = Path(status["archivePath"])
    obs_map = _extract_obsidian_mapping(archive_dir, study_os_root)
    wanted = {str(x) for x in selected_canvas_ids} if selected_canvas_ids else None

    imported: list[dict[str, Any]] = []
    skipped: list[str] = []

    for idx, c_meta in enumerate(status.get("courses") or []):
        cid = str(c_meta["canvasId"])
        if wanted is not None:
            if cid not in wanted:
                continue
        else:
            if c_meta.get("isProgramHub") or c_meta.get("linkedCourseId"):
                skipped.append(c_meta["folder"])
                continue

        out_course_id = str(c_meta["suggestedCourseId"])
        out_dir = data_dir / "courses" / out_course_id
        bank_path = out_dir / "bank.json"
        if bank_path.is_file() and not overwrite:
            skipped.append(out_course_id)
            continue

        (out_dir / "assets").mkdir(parents=True, exist_ok=True)
        bank = build_course_bank_from_canvas_folder(
            archive_dir=archive_dir,
            study_os_root=study_os_root,
            course_meta=c_meta,
            color_idx=len(existing_courses) + idx,
            obs_note=obs_map.get(cid, ""),
        )
        tmp = bank_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(bank_path)
        imported.append(
            {
                "courseId": out_course_id,
                "canvasId": cid,
                "title": bank["title"],
                "questionCount": len(bank["questions"]),
            }
        )

    return {
        "ok": True,
        "imported": imported,
        "skipped": skipped,
    }


def install_demo_course(study_os_root: Path, data_dir: Path) -> dict[str, Any]:
    """Copy `examples/demo-course/bank.json` into `data/courses/demo-101/bank.json`."""
    demo_src = study_os_root / "examples" / "demo-course" / "bank.json"
    if not demo_src.is_file():
        return {"ok": False, "error": "Demo course template not found in examples/demo-course/bank.json."}
    out_dir = data_dir / "courses" / "demo-101"
    (out_dir / "assets").mkdir(parents=True, exist_ok=True)
    dst = out_dir / "bank.json"
    shutil.copy2(demo_src, dst)
    return {"ok": True, "courseId": "demo-101"}
