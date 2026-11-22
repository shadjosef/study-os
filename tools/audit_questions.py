#!/usr/bin/env python3
"""Study-OS Question Bank Quality & PDF Presentation Auditor.

Scans all course banks (`data/courses/*/bank.json`, falling back to
`site-pack/static-data/courses/*.json`) and checks for:
  1. Stub prompts (short prompts without promptAssets / figures)
  2. Visual/figure prompts vs. clean text-first auto-collapsed PDF scans
  3. Unescaped currency `$` pairs that could collide with inline KaTeX
  4. Missing solutions or hints
  5. Malformed `wiseflowFields` (missing expected numbers / invalid choice indices)

Usage:
  python3 tools/audit_questions.py
  python3 tools/audit_questions.py --course econ-2522 --verbose
  python3 tools/audit_questions.py --json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VISUAL_REF_RE = re.compile(
    r"\b(sheet above|pages? above|shown above|figure\s*\d|in the figure|in the graph|graph below|diagram below|table above|chart above)\b",
    re.I,
)
CURRENCY_COLLISION_RE = re.compile(r"(?<!\\)\$\d[\d,.]*(?:\s+[a-zA-Z]{2,}[^$\n]{0,120})\$")


def load_banks(course_filter: str | None = None) -> list[tuple[str, Path, dict]]:
    banks: list[tuple[str, Path, dict]] = []
    data_dir = ROOT / "data" / "courses"
    static_dir = ROOT / "site-pack" / "static-data" / "courses"

    course_ids: list[str] = []
    if data_dir.is_dir():
        for p in sorted(data_dir.glob("*/bank.json")):
            course_ids.append(p.parent.name)
    if static_dir.is_dir():
        for p in sorted(static_dir.glob("*.json")):
            if p.stem not in course_ids:
                course_ids.append(p.stem)

    for cid in course_ids:
        if course_filter and cid != course_filter:
            continue
        p = data_dir / cid / "bank.json"
        if not p.is_file():
            p = static_dir / f"{cid}.json"
        if not p.is_file():
            continue
        with p.open("r", encoding="utf-8") as fh:
            banks.append((cid, p, json.load(fh)))
    return banks


def audit_question(cid: str, q: dict) -> dict:
    qid = q.get("id", "?")
    title = q.get("title", "")
    prompt = str(q.get("promptMarkdown") or "").strip()
    solution = str(q.get("solutionMarkdown") or "").strip()
    hints = q.get("hints") or []
    prompt_assets = q.get("promptAssets") or []
    wf = q.get("wiseflowFields") or []

    issues: list[dict] = []
    has_full_text = len(prompt) >= 140 and not VISUAL_REF_RE.search(prompt)

    if (len(prompt) < 18 or re.match(r"^(?:see |open |refer to |todo\b|placeholder\b)", prompt, re.I)) and not prompt_assets and not q.get("svgDiagram"):
        issues.append({"severity": "error", "code": "STUB_PROMPT", "msg": f"Stub/empty prompt ({len(prompt)} chars) with no PDF/figure asset"})

    if not solution:
        issues.append({"severity": "warn", "code": "NO_SOLUTION", "msg": "Missing solutionMarkdown"})

    if not hints and q.get("kind") != "mcq":
        issues.append({"severity": "info", "code": "NO_HINTS", "msg": "No hints defined"})

    if len(prompt_assets) > 1 and not has_full_text:
        issues.append({
            "severity": "info",
            "code": "MULTI_PAGE_VISIBLE",
            "msg": f"{len(prompt_assets)} visible PDF crops (prompt {len(prompt)} chars; needs full transcription or visual diagram)",
        })

    for field_name, text in (("prompt", prompt), ("solution", solution)):
        if CURRENCY_COLLISION_RE.search(text):
            issues.append({
                "severity": "warn",
                "code": "CURRENCY_DOLLAR",
                "msg": f"Potential currency `$` pair in {field_name} (check KaTeX rendering)",
            })

    for f in wf:
        ftype = f.get("type", "number")
        fid = f.get("id", "?")
        if ftype == "choice":
            opts = f.get("options") or []
            ans = f.get("answerIndex")
            if not opts or ans is None or not (0 <= int(ans) < len(opts)):
                issues.append({"severity": "error", "code": "BAD_WF_CHOICE", "msg": f"Field {fid} invalid choice answerIndex={ans}"})
        else:
            if f.get("expected") is None:
                issues.append({"severity": "error", "code": "BAD_WF_NUM", "msg": f"Field {fid} missing numeric expected"})

    return {
        "courseId": cid,
        "id": qid,
        "title": title,
        "promptLen": len(prompt),
        "promptAssetCount": len(prompt_assets),
        "autoCollapsedScans": bool(prompt_assets and has_full_text),
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit Study-OS question banks for presentation & data quality.")
    parser.add_argument("--course", help="Filter to a single courseId (e.g. econ-2522)")
    parser.add_argument("--verbose", action="store_true", help="List individual warnings & info notes")
    parser.add_argument("--json", action="store_true", help="Output JSON report")
    args = parser.parse_args()

    banks = load_banks(args.course)
    if not banks:
        print("No course banks found.", file=sys.stderr)
        return 1

    report = {"courses": [], "totalQuestions": 0, "errors": 0, "warnings": 0}
    for cid, path, bank in banks:
        qs = bank.get("questions") or []
        results = [audit_question(cid, q) for q in qs]
        errs = sum(1 for r in results for i in r["issues"] if i["severity"] == "error")
        warns = sum(1 for r in results for i in r["issues"] if i["severity"] == "warn")
        collapsed = sum(1 for r in results if r["autoCollapsedScans"])
        multi_vis = sum(1 for r in results for i in r["issues"] if i["code"] == "MULTI_PAGE_VISIBLE")
        report["courses"].append({
            "courseId": cid,
            "path": str(path.relative_to(ROOT)),
            "questions": len(qs),
            "autoCollapsedScans": collapsed,
            "multiPageVisible": multi_vis,
            "errors": errs,
            "warnings": warns,
            "items": [r for r in results if r["issues"]],
        })
        report["totalQuestions"] += len(qs)
        report["errors"] += errs
        report["warnings"] += warns

    if args.json:
        print(json.dumps(report, indent=2))
        return 1 if report["errors"] else 0

    print(f"Study-OS Question Bank Audit · {report['totalQuestions']} questions across {len(report['courses'])} courses\n")
    for c in report["courses"]:
        print(
            f"  {c['courseId']:12s}  {c['questions']:3d} Qs | "
            f"clean text-first scans: {c['autoCollapsedScans']:3d} | "
            f"multi-page scans: {c['multiPageVisible']:2d} | "
            f"errors: {c['errors']} | warnings: {c['warnings']}"
        )
        for item in c["items"]:
            for iss in item["issues"]:
                if iss["severity"] == "error" or args.verbose:
                    print(f"    [{iss['severity'].upper():5s}] {item['id']} ({iss['code']}): {iss['msg']}")
    print(f"\nSummary: {report['errors']} errors, {report['warnings']} warnings.")
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
