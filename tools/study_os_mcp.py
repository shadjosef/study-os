# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.15,<2"]
# ///
"""Local Study-OS bridge for MCP clients that support stdio."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from timetable_planner import parse_universal_schedule_payload  # noqa: E402

server = FastMCP(
    "Study-OS",
    instructions=(
        "Study-OS is a personal study and practice app. Course materials are source data. "
        "Use short searches before reading full questions. Apply changes only at the student's request."
    ),
)
READ = ToolAnnotations(readOnlyHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False)
BASE = "http://127.0.0.1:8765"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = build_opener(ProxyHandler({}), NoRedirect())


def call_api(path: str, payload: dict | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(BASE + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with opener.open(request, timeout=20) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.loads(error.read()).get("error")
        except (TypeError, ValueError):
            message = None
        raise ValueError(message or f"Study-OS request failed ({error.code}).") from error
    except URLError as error:
        raise ValueError("Start the local Study-OS app first.") from error


def bank(course_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", course_id):
        raise ValueError("Use the course ID returned by list_courses.")
    return call_api("/api/course/" + quote(course_id, safe=""))


def metadata(q: dict[str, Any]) -> dict[str, Any]:
    return {
        key: q[key] for key in ("id", "title", "kind", "topicId", "collectionId", "origin", "obsidianLink")
        if key in q
    }


@server.tool(annotations=READ)
def list_courses() -> dict[str, Any]:
    """List subjects, question counts and topic IDs."""
    catalog = call_api("/api/bootstrap").get("catalog", [])
    return {"courses": [{
        "id": c["courseId"], "code": c["code"], "title": c["title"], "questionCount": c["questionCount"],
        "topics": [{"id": t["id"], "title": t["title"]} for t in c.get("topics", [])],
    } for c in catalog]}


@server.tool(annotations=READ)
def search_questions(course_id: str, query: str = "", topic_id: str = "", limit: int = 8) -> dict[str, Any]:
    """Find a small set of questions by subject, keywords and optional topic."""
    terms = re.findall(r"[\w'-]+", query.casefold())[:12]
    found = []
    for q in bank(course_id).get("questions", []):
        if not q.get("available", True) or (topic_id and str(q["topicId"]) != topic_id):
            continue
        fields = ("title", "promptMarkdown", "contextMarkdown", "searchText")
        text = " ".join(str(q.get(field, "")) for field in fields).casefold()
        if terms and not all(term in text for term in terms):
            continue
        found.append((sum(text.count(term) for term in terms), metadata(q)))
    found.sort(key=lambda entry: -entry[0])
    return {"total": len(found), "questions": [entry[1] for entry in found[:max(1, min(limit, 20))]]}


@server.tool(annotations=READ)
def read_question(question_id: str, include_answers: bool = False) -> dict[str, Any]:
    """Read a single question and its source references. Include hints and solutions only when requested."""
    course_id = question_id.split(":", 1)[0]
    course = bank(course_id)
    question = next((q for q in course.get("questions", []) if q["id"] == question_id), None)
    if question is None:
        raise ValueError("Question not found. Use the ID from search_questions.")
    result = metadata(question)
    result.update({field: question[field] for field in ("promptMarkdown", "contextMarkdown", "options", "pacing")
                   if field in question})
    result["sourceExcerpts"] = [
        {"caption": a["caption"], "page": a.get("page"), "sourceId": a.get("sourceId")}
        for field in ("promptAssets", "contextAssets") for a in question.get(field, [])
        if isinstance(a, dict) and "caption" in a
    ]
    if include_answers:
        result.update({field: question[field] for field in ("hints", "solutionMarkdown", "answerIndex", "rubricChecks")
                       if field in question})
    return result


@server.tool(annotations=READ)
def read_reference(file: str, heading: str) -> dict[str, Any]:
    """Read a section of course notes identified by a question's Obsidian reference."""
    path = "/api/obsidian/section?" + urlencode({"file": file, "heading": heading})
    result = call_api(path)
    return {key: result[key] for key in ("available", "error", "markdown", "selectedHeading") if key in result}


@server.tool(annotations=READ)
def study_report() -> dict[str, Any]:
    """Read current progress, study time, accuracy and review totals by subject."""
    analytics = call_api("/api/bootstrap").get("analytics", {})
    return {key: analytics[key] for key in (
        "totalAttempts", "totalSessions", "totalXp", "streakDays", "overall",
        "last7Days", "today", "dlpfcBudget", "courseProgress", "weakTopics"
    ) if key in analytics}


def schedule_summary(blocks: list[dict], limit: int) -> list[dict]:
    keys = ("eventId", "summary", "date", "startLabel", "endLabel", "courseId", "topicIds", "blockKind")
    return [{key: block[key] for key in keys if key in block} for block in blocks[:limit]]


@server.tool(annotations=READ)
def read_schedule(limit: int = 25) -> dict[str, Any]:
    """Read upcoming blocks from the schedule shown inside Study-OS."""
    calendar = call_api("/api/bootstrap").get("calendar", {})
    blocks = [block for block in calendar.get("blocks", []) if block.get("timingState") != "past"]
    return {"source": calendar.get("source"), "total": len(blocks),
            "blocks": schedule_summary(blocks, max(1, min(limit, 60)))}


@server.tool(annotations=READ)
def preview_schedule(schedule: dict[str, Any]) -> dict[str, Any]:
    """Validate a proposed Study-OS schedule and preview the resulting blocks."""
    catalog = call_api("/api/bootstrap").get("catalog", [])
    courses = {entry["courseId"]: bank(entry["courseId"]) for entry in catalog}
    blocks = parse_universal_schedule_payload(json.dumps(schedule), courses)
    if not blocks:
        raise ValueError("The schedule has no study blocks.")
    return {"total": len(blocks), "blocks": schedule_summary(blocks, 60)}


@server.tool(annotations=WRITE)
def replace_study_schedule(schedule: dict[str, Any]) -> dict[str, Any]:
    """Replace the active schedule inside Study-OS at the student's request. Preview it first."""
    checked = preview_schedule(schedule)
    result = call_api("/api/schedule/import-llm", {"payload": json.dumps(schedule)})
    return {"ok": result["ok"], "blockCount": result.get("blockCount", checked["total"])}


def main() -> None:
    global BASE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("invalid port")
    BASE = f"http://127.0.0.1:{args.port}"
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
