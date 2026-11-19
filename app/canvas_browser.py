"""Local, read-only Canvas course and assignment snapshots from a paired browser."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from hmac import compare_digest
import json
import re
from secrets import token_urlsafe


CANVAS_ORIGIN = "https://canvas.bi.no"
MAX_SNAPSHOT_BYTES = 1024 * 1024
MAX_COURSES = 100
MAX_ASSIGNMENTS = 5000


def extension_origin(origin: str | None) -> bool:
    return bool(origin and re.fullmatch(r"chrome-extension://[a-p]{32}", origin))


def _digest(value: str) -> str:
    return sha256(value.encode()).hexdigest()


def _timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not 19 <= len(value) <= 40:
        raise ValueError("Canvas returned an invalid date.")
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("Canvas returned a date without a time zone.")
    return moment.astimezone(timezone.utc)


def _id(value) -> str:
    if isinstance(value, (str, int)) and re.fullmatch(r"[1-9][0-9]{0,19}", str(value)):
        return str(value)
    raise ValueError("Canvas returned an invalid course or assignment ID.")


def _name(value) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()[:300]
    raise ValueError("Canvas returned a course or assignment without a name.")


def parse_snapshot(payload: dict, now: datetime) -> dict:
    if payload.get("version") != 1 or payload.get("canvasOrigin") != CANVAS_ORIGIN:
        raise ValueError("Use Canvas Sync on the BI Canvas website.")
    captured = _timestamp(payload.get("capturedAt"))
    if abs(now - captured) > timedelta(minutes=30):
        raise ValueError("Check your computer clock and run the sync again.")
    courses = payload.get("courses")
    if not isinstance(courses, list) or len(courses) > MAX_COURSES:
        raise ValueError("Invalid Canvas course list.")

    result = {}
    assignment_count = 0
    for course in courses:
        if not isinstance(course, dict) or not isinstance(course.get("assignments"), list):
            raise ValueError("Invalid Canvas course.")
        course_id = _id(course.get("id"))
        course_url = f"{CANVAS_ORIGIN}/courses/{course_id}"
        assignments = {}
        assignment_count += len(course["assignments"])
        if assignment_count > MAX_ASSIGNMENTS:
            raise ValueError("This Canvas account has too many assignments for a single sync.")
        for assignment in course["assignments"]:
            if not isinstance(assignment, dict):
                raise ValueError("Invalid Canvas assignment.")
            assignment_id = _id(assignment.get("id"))
            due = assignment.get("dueAt")
            assignments[assignment_id] = {
                "id": assignment_id,
                "name": _name(assignment.get("name")),
                "dueAt": _timestamp(due).isoformat() if due is not None else None,
                "url": f"{course_url}/assignments/{assignment_id}",
            }
        result[course_id] = {
            "id": course_id,
            "name": _name(course.get("name")),
            "url": course_url,
            "assignments": sorted(assignments.values(), key=lambda item: (item["dueAt"] is None, item["dueAt"] or "", item["name"])),
        }
    return {
        "capturedAt": captured.isoformat(),
        "syncedAt": now.isoformat(),
        "courses": sorted(result.values(), key=lambda course: course["name"].casefold()),
    }


class CanvasBrowser:
    # The HTTP handler holds the shared state lock around operations on this instance.
    def __init__(self, file, write_json):
        self.file = file
        self.write_json = write_json
        self.pending = None

    def _load(self) -> dict:
        try:
            state = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(state, dict):
            raise ValueError("Could not read the saved Canvas connection.")
        return state

    def status(self) -> dict:
        state = self._load()
        return {"connected": bool(state.get("extension")), "snapshot": state.get("snapshot")}

    def issue_code(self) -> dict:
        code = token_urlsafe(18)
        self.pending = (_digest(code), datetime.now(timezone.utc) + timedelta(minutes=5))
        return {"code": code, "expiresInSeconds": 300}

    def link(self, origin: str, code) -> dict:
        if (
            not isinstance(code, str) or len(code) != 24 or not self.pending
            or datetime.now(timezone.utc) >= self.pending[1]
            or not compare_digest(self.pending[0], _digest(code))
        ):
            raise PermissionError("Get a new connection code from the desktop Study-OS app.")
        state = self._load()
        token = token_urlsafe(32)
        state["extension"] = {"origin": origin, "tokenHash": _digest(token)}
        self.write_json(self.file, state)
        self.pending = None
        return {"token": token}

    def disconnect(self) -> dict:
        state = self._load()
        state.pop("extension", None)
        self.write_json(self.file, state)
        self.pending = None
        return {"connected": False, "snapshot": state.get("snapshot")}

    def import_snapshot(self, origin: str, authorization: str, payload: dict) -> dict:
        state = self._load()
        link = state.get("extension") or {}
        if not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43}", authorization) or origin != link.get("origin") or not compare_digest(
            _digest(authorization[7:]), link.get("tokenHash", "")
        ):
            raise PermissionError("Pair this browser with the desktop Study-OS app again.")
        new = parse_snapshot(payload, datetime.now(timezone.utc))
        previous = state.get("snapshot")
        if not previous or new["capturedAt"] >= previous["capturedAt"]:
            state["snapshot"] = new
            self.write_json(self.file, state)
        saved = state["snapshot"]
        return {
            "syncedAt": saved["syncedAt"],
            "courses": len(saved["courses"]),
            "assignments": sum(len(course["assignments"]) for course in saved["courses"]),
        }
