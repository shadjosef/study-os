#!/usr/bin/env python3
"""Study-OS AI Agent & Maintenance CLI.

Designed so any AI assistant (Antigravity, Codex, Claude) or power user can:
  python3 tools/cli.py status              # Print full course & UPI summary + correlations
  python3 tools/cli.py rebuild-catalog     # Validate all banks, rebuild catalog & Obsidian dashboard
  python3 tools/cli.py refresh-calendar    # Pull read-only Google Calendar 14-day window
  python3 tools/cli.py recalibrate         # Compare AI Par times vs empirical student attempts
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT_DIR = Path(__file__).resolve().parent.parent
APP_DIR = ROOT_DIR / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from analytics import build_full_analytics, read_jsonl  # noqa: E402
from calendar_sync import refresh_calendar_cache  # noqa: E402
from canvas_bridge import import_courses_from_canvas_archive, inspect_canvas_archive  # noqa: E402
from dlpfc import classify_intrinsic_dlpfc  # noqa: E402
from obsidian_sync import write_obsidian_dashboard  # noqa: E402
from server import STORE, atomic_write_json  # noqa: E402


REQUIRED_QUESTION_FIELDS = {
    "id",
    "courseId",
    "topicId",
    "origin",
    "kind",
    "title",
    "promptMarkdown",
    "hints",
    "solutionMarkdown",
    "pacing",
}


def validate_banks() -> tuple[int, list[str]]:
    errors: list[str] = []
    total_q = 0
    _, courses_by_id = STORE.discover_courses()
    for cid, bank in courses_by_id.items():
        c_dir = STORE.courses_dir / cid
        qs = bank.get("questions") or []
        seen_ids: set[str] = set()
        for idx, q in enumerate(qs):
            total_q += 1
            missing = REQUIRED_QUESTION_FIELDS - set(q.keys())
            if missing:
                errors.append(f"[{cid}] Q#{idx} ({q.get('id')}) missing fields: {sorted(missing)}")
            qid = q.get("id")
            if qid in seen_ids:
                errors.append(f"[{cid}] Duplicate question id: {qid}")
            seen_ids.add(str(qid))
            for asset_list_key in ("promptAssets", "solutionAssets", "contextAssets"):
                for asset in q.get(asset_list_key) or []:
                    src = asset.get("src")
                    if src and not (c_dir / src).is_file():
                        errors.append(f"[{cid}] {qid} missing asset file: {src}")
            for wf_idx, wf in enumerate(q.get("wiseflowFields") or []):
                ftype = wf.get("type")
                if not wf.get("id") or not wf.get("label") or ftype not in ("number", "choice"):
                    errors.append(f"[{cid}] {qid} wiseflowFields[{wf_idx}] invalid id/label/type")
                elif ftype == "number":
                    try:
                        float(wf["expected"])
                    except Exception:
                        errors.append(f"[{cid}] {qid} wiseflowFields[{wf_idx}] non-numeric expected")
                elif ftype == "choice":
                    opts = wf.get("options") or []
                    ans = wf.get("answerIndex")
                    if not isinstance(opts, list) or len(opts) < 2 or not isinstance(ans, int) or not (0 <= ans < len(opts)):
                        errors.append(f"[{cid}] {qid} wiseflowFields[{wf_idx}] invalid choice options/answerIndex")
    return total_q, errors


def stamp_dlpfc_across_banks() -> int:
    stamped = 0
    if not STORE.courses_dir.is_dir():
        return 0
    for sub in sorted(STORE.courses_dir.iterdir()):
        bank_file = sub / "bank.json"
        if not bank_file.is_file():
            continue
        bank = json.loads(bank_file.read_text(encoding="utf-8"))
        changed = False
        for q in bank.get("questions") or []:
            tier, cog_type = classify_intrinsic_dlpfc(q)
            if q.get("dlpfcBase") != tier or q.get("cognitiveType") != cog_type:
                q["dlpfcBase"] = tier
                q["cognitiveType"] = cog_type
                changed = True
                stamped += 1
        if changed:
            atomic_write_json(bank_file, bank)
    return stamped


def cmd_rebuild_catalog(_args: argparse.Namespace) -> int:
    stamped = stamp_dlpfc_across_banks()
    total_q, errors = validate_banks()
    catalog, courses_by_id = STORE.discover_courses()
    prog = STORE.load_progress()
    analytics = build_full_analytics(ROOT_DIR, courses_by_id, prog)
    cal = STORE.load_or_refresh_calendar(force=False)
    sessions = read_jsonl(STORE.sessions_path, max_lines=200)
    dash = write_obsidian_dashboard(ROOT_DIR, catalog, analytics, cal.get("blocks") or [], sessions)

    print(f"Validated {len(catalog)} course banks ({total_q} total questions).")
    for c in catalog:
        print(f"  - {c['courseId']:10s} | {c['code']:8s} | {c['questionCount']:4d} available Qs | {c['title']}")
    if dash:
        print(f"Updated Obsidian dashboard: {dash}")
    if errors:
        print(f"\nWARNINGS ({len(errors)}):")
        for err in errors[:25]:
            print("  !", err)
        return 1
    print("All schemas and asset references verified OK.")
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    catalog, courses_by_id = STORE.discover_courses()
    prog = STORE.load_progress()
    summary = build_full_analytics(ROOT_DIR, courses_by_id, prog)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


def cmd_refresh_calendar(_args: argparse.Namespace) -> int:
    cal = refresh_calendar_cache(ROOT_DIR, days_ahead=14)
    print(f"Calendar source: {cal.get('source')} · {len(cal.get('blocks') or [])} study/class blocks cached.")
    for b in (cal.get("blocks") or [])[:10]:
        print(f"  {b['date']} {b['startLabel']}-{b['endLabel']} | {b.get('courseId') or 'general':10s} | {b['summary']}")
    return 0


def cmd_recalibrate(args: argparse.Namespace) -> int:
    attempts = read_jsonl(STORE.attempts_path, max_lines=10000)
    by_q: dict[str, list[float]] = {}
    for a in attempts:
        if float(a.get("qualityAccuracy") or 0) >= 0.85:
            by_q.setdefault(a["questionId"], []).append(float(a["effectiveSec"]) / 60.0)
    if not by_q:
        print("No verified >=85% accuracy attempts logged yet to recalibrate AI Par budgets.")
        return 0
    _, courses_by_id = STORE.discover_courses()
    adjustments = []
    for cid, bank in courses_by_id.items():
        if args.course and cid != args.course:
            continue
        for q in bank.get("questions") or []:
            samples = by_q.get(q["id"]) or []
            if len(samples) >= 2:
                emp_med = sorted(samples)[len(samples) // 2]
                cur_exam = float(((q.get("pacing") or {}).get("exam") or {}).get("target") or 2.0)
                blended = round(0.65 * cur_exam + 0.35 * emp_med, 1)
                adjustments.append((q["id"], len(samples), cur_exam, round(emp_med, 2), blended))
                if not args.dry_run:
                    q["pacing"]["exam"]["target"] = blended
        if not args.dry_run and adjustments:
            (STORE.courses_dir / cid / "bank.json").write_text(
                json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
    for qid, n, old_t, emp_t, new_t in adjustments[:30]:
        print(f"  {qid:28s} | n={n} | old exam par={old_t}m | empirical={emp_t}m -> suggested={new_t}m")
    if not adjustments:
        print("Need at least 2 verified attempts on an item before recalibrating its AI Par.")
    return 0


def cmd_sync_canvas(args: argparse.Namespace) -> int:
    _, courses_by_id = STORE.discover_courses()
    status = inspect_canvas_archive(ROOT_DIR, STORE.data_dir, courses_by_id)
    if not status.get("connected"):
        print("Canvas-Archive not found. Place Canvas-Archive next to Study-OS or set STUDY_OS_CANVAS_ARCHIVE.")
        return 1
    print(f"Canvas-Archive connected at: {status['archivePath']}")
    for c in status.get("courses") or []:
        tag = f"linked -> {c['linkedCourseId']}" if c["linkedCourseId"] else ("hub (skip)" if c["isProgramHub"] else "unimported")
        print(f"  - [{c['canvasId']}] {c['code']} · {c['title']} ({c['pdfCount']} PDFs, {c['notebookCount']} NBs) [{tag}]")
    if args.import_new:
        res = import_courses_from_canvas_archive(ROOT_DIR, STORE.data_dir, courses_by_id, overwrite=args.overwrite)
        print(f"Imported {len(res.get('imported') or [])} course(s): {[x['courseId'] for x in (res.get('imported') or [])]}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Study-OS AI & Admin CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("rebuild-catalog").set_defaults(func=cmd_rebuild_catalog)
    sub.add_parser("refresh-calendar").set_defaults(func=cmd_refresh_calendar)
    sc = sub.add_parser("sync-canvas")
    sc.add_argument("--import-new", action="store_true", help="Scaffold unimported Canvas-Archive courses into data/courses/")
    sc.add_argument("--overwrite", action="store_true", help="Rebuild even if bank.json exists")
    sc.set_defaults(func=cmd_sync_canvas)
    rec = sub.add_parser("recalibrate")
    rec.add_argument("--course", default="")
    rec.add_argument("--dry-run", action="store_true", default=True)
    rec.add_argument("--apply", dest="dry_run", action="store_false")
    rec.set_defaults(func=cmd_recalibrate)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
