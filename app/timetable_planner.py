"""Universal TimeEdit (.ics), Work-Hours Auto-Scheduler & Zero-Key LLM Schedule Importer.

Supports three seamless scheduling workflows in Study-OS:
  1. TimeEdit `.ics` URL (or uploaded `.ics` text) + Weekly Part-Time Work Hours:
     Automatically imports lectures/seminars/exams, estimates realistic weekly study
     hours adjusted for hours worked (`Lectures + Job + Deep Study`), and slots
     circadian `Hard (<15:00)` / `Medium (15–18)` / `Easy (18+)` study
     blocks into open calendar gaps.
  2. One-Prompt "Any-LLM" Copy-Paste Workflow (ChatGPT, Claude, Gemini, local Ollama):
     Student copies a pre-filled prompt with their classes/courses/work hours into ANY
     LLM and pastes back either `study-os-schedule-v1` JSON or standard RFC 5545 `.ics`.
  3. Standard `.ics` Calendar Export (`GET /api/schedule/export.ics`) for Google, Apple,
     or Outlook Calendar.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

OSLO_TZ = ZoneInfo("Europe/Oslo")


def schedule_state_path(data_dir: Path) -> Path:
    return data_dir / "state" / "custom_schedule.json"


def load_custom_schedule(data_dir: Path) -> dict[str, Any]:
    path = schedule_state_path(data_dir)
    if not path.is_file():
        return {"enabled": False, "prefs": default_schedule_prefs(), "blocks": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("prefs", default_schedule_prefs())
            data.setdefault("blocks", [])
            return data
    except Exception:
        pass
    return {"enabled": False, "prefs": default_schedule_prefs(), "blocks": []}


def save_custom_schedule(data_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    payload["updatedAt"] = datetime.now(OSLO_TZ).isoformat()
    path = schedule_state_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return payload


def default_schedule_prefs() -> dict[str, Any]:
    return {
        "timeeditUrl": "",
        "weeklyWorkHours": 0.0,
        "autoAdjustStudy": True,
        "targetStudyHours": 28.0,
        "dayStartHour": 8,
        "dayEndHour": 19,
        "blockMinutes": 50,
        "breakMinutes": 10,
        "restDays": [6],  # 0=Mon .. 6=Sun (Sunday light/off by default)
        "courseWeights": {},
        "notes": "",
    }


def _daily_study_minutes(prefs: dict[str, Any]) -> tuple[int, int]:
    wake, bed = prefs.get("wakeTime"), prefs.get("bedTime")
    if wake is not None or bed is not None:
        def parse(value):
            if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
                raise ValueError("Enter a wake-up time and a bedtime.")
            h, m = map(int, value.split(":"))
            return 60 * h + m
        start, end = parse(wake), parse(bed)
        if start == end:
            raise ValueError("Wake-up time and bedtime must be different.")
        return min(1440, start + 30), min(1440, end + (1440 if end < start else 0) - 30)
    start = max(5, min(14, int(prefs.get("dayStartHour") or 8)))
    end = max(start + 3, min(23, int(prefs.get("dayEndHour") or 19)))
    return start * 60, end * 60


def estimate_recommended_study_hours(
    weekly_work_hours: float,
    weekly_class_hours: float,
    course_count: int = 4,
) -> dict[str, float]:
    """Compute sustainable weekly self-study hours given job hours and lecture load.

    Full-time semester benchmark (~40h academic week = classes + self-study),
    softly compressed by part-time employment (`~0.6h` reduction per work hour above
    8h/wk) so total committed hours (`Work + Classes + Deep Study`) stay sustainable
    under a ~54h/wk cognitive ceiling.
    """
    work_h = max(0.0, min(60.0, float(weekly_work_hours or 0.0)))
    class_h = max(0.0, min(35.0, float(weekly_class_hours or 0.0)))
    base_academic = max(12.0, min(42.0, course_count * 8.0))
    raw_self_study = max(6.0, base_academic - class_h)

    # Allow 8h/wk part-time work with minimal study cut, then taper 0.65h per extra job hour
    work_penalty = max(0.0, work_h - 6.0) * 0.60
    recommended = round(max(5.0, min(36.0, raw_self_study - work_penalty)), 1)
    total_committed = round(work_h + class_h + recommended, 1)
    return {
        "recommendedStudyHours": recommended,
        "weeklyWorkHours": round(work_h, 1),
        "weeklyClassHours": round(class_h, 1),
        "totalCommittedHours": total_committed,
    }


def fetch_timeedit_ics(url: str, timeout_sec: int = 12) -> str:
    """Fetch a TimeEdit (or standard webcal/https) `.ics` feed safely via stdlib."""
    clean = url.strip()
    if clean.startswith("webcal://"):
        clean = "https://" + clean[len("webcal://") :]
    parsed = urllib.parse.urlsplit(clean)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("TimeEdit link must be a valid http(s):// or webcal:// .ics URL.")
    req = urllib.request.Request(
        clean,
        headers={"User-Agent": "Study-OS-Timetable-Sync/1.0 (Read-Only ICS)"},
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        raw = resp.read(2_500_000)
    return raw.decode("utf-8", errors="replace")


def _unfold_ics_lines(ics_text: str) -> list[str]:
    unfolded: list[str] = []
    for raw_line in ics_text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw_line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += raw_line[1:]
        else:
            unfolded.append(raw_line)
    return unfolded


def _unescape_ics_value(val: str) -> str:
    return (
        val.replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )


def _parse_ics_dt(raw_val: str, params: str = "", default_tz: ZoneInfo = OSLO_TZ) -> datetime | None:
    val = raw_val.strip()
    tz = default_tz
    tz_m = re.search(r"TZID=([^;:]+)", params or "", re.I)
    if tz_m:
        try:
            tz = ZoneInfo(tz_m.group(1).strip())
        except Exception:
            tz = default_tz

    try:
        if re.fullmatch(r"\d{8}T\d{6}Z", val):
            dt_utc = datetime.strptime(val, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            return dt_utc.astimezone(default_tz)
        if re.fullmatch(r"\d{8}T\d{6}", val):
            dt_loc = datetime.strptime(val, "%Y%m%dT%H%M%S").replace(tzinfo=tz)
            return dt_loc.astimezone(default_tz)
        if re.fullmatch(r"\d{8}", val):
            d_only = datetime.strptime(val, "%Y%m%d").replace(tzinfo=tz)
            return d_only.astimezone(default_tz)
    except ValueError:
        return None
    return None


def parse_ics_events(ics_text: str, tz: ZoneInfo = OSLO_TZ) -> list[dict[str, Any]]:
    """Parse RFC 5545 `VEVENT` entries from a TimeEdit or calendar `.ics` file."""
    events: list[dict[str, Any]] = []
    in_event = False
    cur: dict[str, tuple[str, str]] = {}

    for line in _unfold_ics_lines(ics_text):
        u = line.strip()
        if u == "BEGIN:VEVENT":
            in_event = True
            cur = {}
            continue
        if u == "END:VEVENT":
            in_event = False
            dt_start = _parse_ics_dt(*(cur.get("DTSTART") or ("", ""))[::-1], default_tz=tz) if "DTSTART" in cur else None
            dt_end = _parse_ics_dt(*(cur.get("DTEND") or ("", ""))[::-1], default_tz=tz) if "DTEND" in cur else None
            summary = _unescape_ics_value((cur.get("SUMMARY") or ("", ""))[1])
            desc = _unescape_ics_value((cur.get("DESCRIPTION") or ("", ""))[1])
            loc = _unescape_ics_value((cur.get("LOCATION") or ("", ""))[1])
            uid = _unescape_ics_value((cur.get("UID") or ("", ""))[1])
            if dt_start and summary:
                if not dt_end or dt_end <= dt_start:
                    dt_end = dt_start + timedelta(minutes=60)
                if not uid:
                    uid = "ics-" + hashlib.sha1(f"{dt_start.isoformat()}:{summary}".encode("utf-8")).hexdigest()[:12]
                events.append(
                    {
                        "id": uid,
                        "summary": summary,
                        "description": desc,
                        "location": loc,
                        "start": dt_start.isoformat(),
                        "end": dt_end.isoformat(),
                    }
                )
            continue

        if in_event and ":" in line:
            left, val = line.split(":", 1)
            parts = left.split(";", 1)
            prop = parts[0].upper().strip()
            params = parts[1] if len(parts) > 1 else ""
            cur[prop] = (params, val)

    events.sort(key=lambda e: e["start"])
    return events


def match_course_for_text(text: str, courses_by_id: dict[str, dict[str, Any]]) -> tuple[str, list[str]]:
    """Match any event title/description to a loaded `Study-OS` course & topic."""
    low = text.lower()
    best_cid = ""
    best_score = 0

    for cid, bank in courses_by_id.items():
        score = 0
        code = str(bank.get("code") or "").strip().lower()
        code_compact = re.sub(r"\s+", "", code)
        canvas_id = str(bank.get("canvasId") or "").strip()
        title = str(bank.get("title") or "").strip().lower()
        short_t = str(bank.get("shortTitle") or "").strip().lower()

        if code and (code in low or (len(code_compact) >= 5 and code_compact in re.sub(r"\s+", "", low))):
            score += 10
        if cid.lower() in low:
            score += 10
        if canvas_id and canvas_id.isdigit() and re.search(rf"\b{re.escape(canvas_id)}\b", low):
            score += 6
        if title and len(title) >= 5 and title in low:
            score += 8
        elif short_t and len(short_t) >= 4 and re.search(rf"\b{re.escape(short_t)}\b", low):
            score += 5

        if score > best_score:
            best_score = score
            best_cid = cid

    if not best_cid:
        return "", []

    topics_matched: list[str] = []
    bank = courses_by_id[best_cid]
    for t in bank.get("topics") or []:
        tid = str(t.get("id") or "")
        kws = [str(k).lower() for k in (t.get("keywords") or []) if len(str(k)) >= 3]
        t_title = str(t.get("title") or "").lower()
        if (tid.isdigit() and re.search(rf"\b(?:topic|lesson|chapter|lecture)\s*0*{tid}\b", low)) or any(
            kw in low for kw in kws
        ):
            topics_matched.append(tid)
        elif len(t_title) >= 8 and t_title in low:
            topics_matched.append(tid)

    return best_cid, topics_matched[:2]


def _overlaps(s1: datetime, e1: datetime, intervals: list[tuple[datetime, datetime]], pad_min: int = 10) -> bool:
    pad = timedelta(minutes=pad_min)
    for s2, e2 in intervals:
        if s1 < (e2 + pad) and (e1 + pad) > s2:
            return True
    return False


def generate_adaptive_schedule(
    fixed_events: list[dict[str, Any]],
    courses_by_id: dict[str, dict[str, Any]],
    progress_state: dict[str, Any],
    prefs: dict[str, Any],
    days_ahead: int = 14,
    now_dt: datetime | None = None,
) -> dict[str, Any]:
    """Build a 14-day schedule combining fixed TimeEdit classes + adaptive study blocks."""
    now = (now_dt or datetime.now(OSLO_TZ)).astimezone(OSLO_TZ)
    start_day = now.date()
    end_limit = now + timedelta(days=days_ahead)

    work_hours = float(prefs.get("weeklyWorkHours") or 0.0)
    auto_adjust = bool(prefs.get("autoAdjustStudy", True))
    day_start_m, day_end_m = _daily_study_minutes(prefs)
    block_min = max(25, min(90, int(prefs.get("blockMinutes") or 50)))
    break_min = max(5, min(30, int(prefs.get("breakMinutes") or 10)))
    rest_days = {int(x) for x in (prefs.get("restDays") or []) if str(x).isdigit()}
    custom_weights = prefs.get("courseWeights") or {}

    # 1. Convert fixed events within [start_day, start_day + days_ahead] into normalized blocks
    fixed_blocks: list[dict[str, Any]] = []
    busy_by_day: dict[date, list[tuple[datetime, datetime]]] = {}
    class_minutes_week1 = 0.0
    week1_cutoff = now + timedelta(days=7)

    for ev in fixed_events:
        try:
            sdt = datetime.fromisoformat(str(ev["start"]).replace("Z", "+00:00")).astimezone(OSLO_TZ)
            edt = datetime.fromisoformat(str(ev["end"]).replace("Z", "+00:00")).astimezone(OSLO_TZ)
        except Exception:
            continue
        if edt <= now - timedelta(hours=2) or sdt > end_limit:
            continue
        dur = max(15, int(round((edt - sdt).total_seconds() / 60.0)))
        if sdt < week1_cutoff and edt > now:
            class_minutes_week1 += dur

        for offset in range(days_ahead):
            which_day = start_day + timedelta(days=offset)
            if sdt.date() <= which_day <= edt.date():
                busy_by_day.setdefault(which_day, []).append((sdt, edt))
        cid, tids = match_course_for_text(f"{ev.get('summary', '')} {ev.get('description', '')}", courses_by_id)
        summary_clean = re.sub(r"\s+", " ", str(ev.get("summary") or "Scheduled Class")).strip()
        is_exam_ev = bool(re.search(r"\b(exam|eksamen|midterm|mock)\b", summary_clean, re.I))

        fixed_blocks.append(
            {
                "eventId": str(ev.get("id") or f"ev-{len(fixed_blocks)+1}"),
                "summary": summary_clean,
                "date": sdt.strftime("%Y-%m-%d"),
                "start": sdt.isoformat(),
                "end": edt.isoformat(),
                "startIso": sdt.isoformat(),
                "endIso": edt.isoformat(),
                "startLabel": sdt.strftime("%H:%M"),
                "endLabel": edt.strftime("%H:%M"),
                "calendarMinutes": dur,
                "durationMinutes": dur,
                "focusMinutes": dur,
                "attemptBudgetMinutes": max(20, int(round(dur * 0.75))),
                "courseId": cid,
                "topicIds": tids,
                "blockKind": "exam" if is_exam_ev else "class_session",
                "blockType": "exam" if is_exam_ev else "lecture",
                "recommendedProfile": "exam" if is_exam_ev else "learning",
                "location": str(ev.get("location") or ""),
                "origin": "timeedit",
            }
        )

    est = estimate_recommended_study_hours(
        weekly_work_hours=work_hours,
        weekly_class_hours=class_minutes_week1 / 60.0,
        course_count=max(1, len(courses_by_id)),
    )
    weekly_study_hours = (
        est["recommendedStudyHours"]
        if auto_adjust
        else max(2.0, min(50.0, float(prefs.get("targetStudyHours") or est["recommendedStudyHours"])))
    )
    est["activeTargetStudyHours"] = round(weekly_study_hours, 1)

    if not courses_by_id:
        return {"blocks": fixed_blocks, "estimate": est}

    # 2. Compute priority weight for each course (exam urgency + unfinished ratio + user weight)
    records = (progress_state or {}).get("records") or {}
    course_weights: list[tuple[str, float]] = []
    for cid, bank in courses_by_id.items():
        u_mult = float(custom_weights.get(cid, 1.0) or 1.0)
        if u_mult <= 0:
            continue
        qs = [q for q in (bank.get("questions") or []) if q.get("available", True)]
        done_n = sum(1 for q in qs if (records.get(q["id"]) or {}).get("status") == "done")
        unfinished_ratio = 1.0 - (done_n / max(1, len(qs)))

        urgency = 1.0
        exam_str = str((bank.get("examInfo") or {}).get("date") or "").strip()
        if len(exam_str) == 10:
            try:
                d_left = (date.fromisoformat(exam_str) - start_day).days
                if d_left < 0:
                    urgency = 0.25
                elif d_left <= 7:
                    urgency = 2.4
                elif d_left <= 14:
                    urgency = 1.8
                elif d_left <= 25:
                    urgency = 1.35
            except ValueError:
                pass
        weight = max(0.2, round(u_mult * urgency * (0.45 + 0.75 * unfinished_ratio), 3))
        course_weights.append((cid, weight))

    if not course_weights:
        course_weights = [(cid, 1.0) for cid in courses_by_id]

    # Build weighted round-robin course rotation
    total_w = sum(w for _, w in course_weights)
    blocks_per_week = max(0, int((weekly_study_hours * 60.0 + 1e-6) // block_min))
    total_target_blocks = blocks_per_week * 2  # across 14 days
    quotas = {cid: max(1, int(round(total_target_blocks * (w / total_w)))) for cid, w in course_weights}

    # 3. Slot study blocks into free daily intervals across the next 14 days
    active_days_per_week = max(1, 7 - len(rest_days))
    daily_cap = (blocks_per_week + active_days_per_week - 1) // active_days_per_week
    generated_blocks: list[dict[str, Any]] = []
    placed_week = 0
    rr_idx = 0
    ordered_cids = [cid for cid, _ in sorted(course_weights, key=lambda kv: -kv[1])]

    for day_offset in range(days_ahead):
        if day_offset % 7 == 0:
            placed_week = 0
        cur_day = start_day + timedelta(days=day_offset)
        if cur_day.weekday() in rest_days:
            continue

        midnight = datetime.combine(cur_day, time(0, 0), tzinfo=OSLO_TZ)
        day_start = midnight + timedelta(minutes=day_start_m)
        day_end = midnight + timedelta(minutes=day_end_m)
        if cur_day == start_day and now > day_start:
            # Round up to next 15-minute mark
            mins_up = 15 - (now.minute % 15)
            day_start = (now + timedelta(minutes=mins_up)).replace(second=0, microsecond=0)
        if day_start + timedelta(minutes=block_min) > day_end:
            continue

        busy = busy_by_day.setdefault(cur_day, [])
        placed_today = 0
        cursor = day_start

        while cursor + timedelta(minutes=block_min) <= day_end and placed_today < daily_cap and placed_week < blocks_per_week:
            cand_end = cursor + timedelta(minutes=block_min)
            if _overlaps(cursor, cand_end, busy, pad_min=break_min):
                cursor += timedelta(minutes=15)
                continue

            # Pick next course with remaining quota (avoiding courses whose exam date already passed!)
            chosen_cid = ""
            for step in range(len(ordered_cids)):
                cand_cid = ordered_cids[(rr_idx + step) % len(ordered_cids)]
                exam_d = str((courses_by_id[cand_cid].get("examInfo") or {}).get("date") or "")
                if len(exam_d) == 10:
                    try:
                        if cur_day > date.fromisoformat(exam_d):
                            continue
                    except ValueError:
                        pass
                if quotas.get(cand_cid, 0) > 0:
                    chosen_cid = cand_cid
                    rr_idx = (rr_idx + step + 1) % len(ordered_cids)
                    break
            if not chosen_cid:
                eligible = []
                for cid in ordered_cids:
                    exam = str((courses_by_id[cid].get("examInfo") or {}).get("date") or "")
                    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", exam) or exam >= cur_day.isoformat():
                        eligible.append(cid)
                if not eligible:
                    break
                chosen_cid = eligible[rr_idx % len(eligible)]
                rr_idx += 1

            quotas[chosen_cid] = max(0, quotas.get(chosen_cid, 1) - 1)
            c_bank = courses_by_id[chosen_cid]
            c_code = c_bank.get("code") or chosen_cid.upper()
            c_short = c_bank.get("shortTitle") or c_bank.get("title") or chosen_cid

            hour = cursor.hour
            if hour < 15:
                phase_tag = "Hard · Multi-step"
                b_type = "deep_50_10"
            elif hour < 18:
                phase_tag = "Medium practice"
                b_type = "deep_50_10"
            else:
                phase_tag = "Easy · Recall"
                b_type = "sprint_20"

            generated_blocks.append(
                {
                    "eventId": f"auto-{cur_day.isoformat()}-{cursor.strftime('%H%M')}-{chosen_cid}",
                    "summary": f"{c_code} {c_short} — {phase_tag} ({block_min}/{break_min})",
                    "date": cur_day.isoformat(),
                    "start": cursor.isoformat(),
                    "end": cand_end.isoformat(),
                    "startIso": cursor.isoformat(),
                    "endIso": cand_end.isoformat(),
                    "startLabel": cursor.strftime("%H:%M"),
                    "endLabel": cand_end.strftime("%H:%M"),
                    "calendarMinutes": block_min,
                    "durationMinutes": block_min,
                    "focusMinutes": block_min,
                    "attemptBudgetMinutes": max(18, int(round(block_min * 0.85))),
                    "courseId": chosen_cid,
                    "topicIds": [],
                    "blockKind": "recall_sprint" if hour >= 18 else "study_block",
                    "blockType": b_type,
                    "recommendedProfile": "learning",
                    "origin": "auto_scheduler",
                }
            )
            busy.append((cursor, cand_end))
            placed_today += 1
            placed_week += 1
            cursor = cand_end + timedelta(minutes=break_min)

    all_blocks = sorted([*fixed_blocks, *generated_blocks], key=lambda b: b["start"])
    return {
        "blocks": all_blocks,
        "estimate": est,
    }


def parse_universal_schedule_payload(
    raw_text: str,
    courses_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Parse pasted LLM output in EITHER `study-os-schedule-v1` JSON OR RFC 5545 `.ics`."""
    cleaned = raw_text.strip()
    if not cleaned:
        raise ValueError("Paste the JSON or .ics calendar block returned by your LLM.")

    # Strip Markdown code fences (```json ... ``` or ```ics ... ```) if copied straight from chat
    fence_m = re.search(r"```(?:json|ics|icalendar|calendar)?\s*([\s\S]+?)```", cleaned, re.I)
    if fence_m:
        cleaned = fence_m.group(1).strip()

    # Path A: RFC 5545 iCalendar (.ics)
    if "BEGIN:VCALENDAR" in cleaned.upper() or "BEGIN:VEVENT" in cleaned.upper():
        evs = parse_ics_events(cleaned)
        if not evs:
            raise ValueError("No VEVENT items found in pasted .ics text.")
        out_ics: list[dict[str, Any]] = []
        for idx, ev in enumerate(evs, 1):
            sdt = datetime.fromisoformat(ev["start"]).astimezone(OSLO_TZ)
            edt = datetime.fromisoformat(ev["end"]).astimezone(OSLO_TZ)
            dur = max(15, int(round((edt - sdt).total_seconds() / 60.0)))
            cid, tids = match_course_for_text(f"{ev['summary']} {ev.get('description', '')}", courses_by_id)
            out_ics.append(
                {
                    "eventId": str(ev.get("id") or f"llm-ics-{idx}"),
                    "summary": ev["summary"],
                    "date": sdt.strftime("%Y-%m-%d"),
                    "start": sdt.isoformat(),
                    "end": edt.isoformat(),
                    "startIso": sdt.isoformat(),
                    "endIso": edt.isoformat(),
                    "startLabel": sdt.strftime("%H:%M"),
                    "endLabel": edt.strftime("%H:%M"),
                    "calendarMinutes": dur,
                    "durationMinutes": dur,
                    "focusMinutes": dur,
                    "attemptBudgetMinutes": max(15, int(round(dur * 0.85))),
                    "courseId": cid,
                    "topicIds": tids,
                    "blockKind": "study_block" if dur >= 35 else "recall_sprint",
                    "blockType": "deep_50_10" if dur >= 35 else "sprint_20",
                    "recommendedProfile": "exam" if "exam" in ev["summary"].lower() else "learning",
                    "origin": "llm_ics",
                }
            )
        return out_ics

    # Path B: Universal Calendar JSON (`study-os-schedule-v1` or bare JSON array)
    # Extract outermost JSON object or array even if LLM added conversational prose around it
    first_brace = min((i for i in (cleaned.find("{"), cleaned.find("[")) if i != -1), default=-1)
    if first_brace > 0:
        cleaned = cleaned[first_brace:]
    last_brace = max(cleaned.rfind("}"), cleaned.rfind("]"))
    if last_brace != -1:
        cleaned = cleaned[: last_brace + 1]

    data = json.loads(cleaned)
    raw_blocks = data.get("blocks") or data.get("events") if isinstance(data, dict) else data
    if not isinstance(raw_blocks, list) or not raw_blocks:
        raise ValueError("JSON schedule must contain a non-empty 'blocks' (or 'events') array.")

    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(raw_blocks, 1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("summary") or f"Study Block {idx}").strip()
        raw_start = str(item.get("start") or "").strip()
        raw_end = str(item.get("end") or "").strip()
        raw_date = str(item.get("date") or "").strip()

        # Accept either full ISO (`2026-11-17T09:00:00+01:00`) or `date` + `startTime`/`endTime` (`09:00`)
        if "T" in raw_start:
            sdt = datetime.fromisoformat(raw_start.replace("Z", "+00:00"))
            if sdt.tzinfo is None:
                sdt = sdt.replace(tzinfo=OSLO_TZ)
            else:
                sdt = sdt.astimezone(OSLO_TZ)
        elif raw_date and re.match(r"^\d{1,2}:\d{2}$", raw_start or str(item.get("startTime") or "")):
            hm = raw_start or str(item.get("startTime"))
            h, m = (int(x) for x in hm.split(":"))
            sdt = datetime.combine(date.fromisoformat(raw_date), time(h, m), tzinfo=OSLO_TZ)
        else:
            continue

        if raw_end and "T" in raw_end:
            edt = datetime.fromisoformat(raw_end.replace("Z", "+00:00"))
            edt = edt.replace(tzinfo=OSLO_TZ) if edt.tzinfo is None else edt.astimezone(OSLO_TZ)
        elif raw_date and re.match(r"^\d{1,2}:\d{2}$", raw_end or str(item.get("endTime") or "")):
            hm_e = raw_end or str(item.get("endTime"))
            h, m = (int(x) for x in hm_e.split(":"))
            edt = datetime.combine(sdt.date(), time(h, m), tzinfo=OSLO_TZ)
        else:
            dur_m = int(item.get("durationMinutes") or 50)
            edt = sdt + timedelta(minutes=max(15, dur_m))

        dur = max(15, int(round((edt - sdt).total_seconds() / 60.0)))
        explicit_cid = str(item.get("courseId") or "").strip()
        if explicit_cid and explicit_cid not in courses_by_id:
            explicit_cid, auto_tids = match_course_for_text(f"{explicit_cid} {title}", courses_by_id)
        else:
            _, auto_tids = match_course_for_text(title, courses_by_id)
        if not explicit_cid:
            explicit_cid, auto_tids = match_course_for_text(title, courses_by_id)

        raw_tids = item.get("topicIds")
        tids = [str(x) for x in raw_tids] if isinstance(raw_tids, list) and raw_tids else auto_tids
        b_type = str(item.get("blockType") or ("lecture" if item.get("kind") == "class" else "deep_50_10"))
        prof = str(item.get("profile") or item.get("recommendedProfile") or ("exam" if b_type == "exam" else "learning"))

        normalized.append(
            {
                "eventId": str(item.get("id") or item.get("eventId") or f"llm-{idx}-{sdt.strftime('%m%d%H%M')}"),
                "summary": title,
                "date": sdt.strftime("%Y-%m-%d"),
                "start": sdt.isoformat(),
                "end": edt.isoformat(),
                "startIso": sdt.isoformat(),
                "endIso": edt.isoformat(),
                "startLabel": sdt.strftime("%H:%M"),
                "endLabel": edt.strftime("%H:%M"),
                "calendarMinutes": dur,
                "durationMinutes": dur,
                "focusMinutes": int(item.get("focusMinutes") or dur),
                "attemptBudgetMinutes": int(item.get("attemptBudgetMinutes") or max(15, round(dur * 0.85))),
                "courseId": explicit_cid,
                "topicIds": tids,
                "blockKind": "class_session" if b_type == "lecture" else ("exam" if b_type == "exam" else ("recall_sprint" if dur < 35 else "study_block")),
                "blockType": b_type,
                "recommendedProfile": prof if prof in ("learning", "exam") else "learning",
                "origin": "llm_json",
            }
        )

    if not normalized:
        raise ValueError("Could not parse any valid dated blocks from the JSON payload.")
    normalized.sort(key=lambda b: b["start"])
    return normalized


def export_blocks_to_ics(blocks: list[dict[str, Any]], cal_name: str = "Study-OS Adaptive Schedule") -> str:
    """Serialize Study-OS schedule blocks to standard RFC 5545 `.ics` format."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Study-OS//Adaptive Study Schedule//EN",
        "CALSCALE:GREGORIAN",
        f"X-WR-CALNAME:{cal_name}",
    ]
    for b in blocks:
        try:
            sdt = datetime.fromisoformat(str(b["start"]).replace("Z", "+00:00")).astimezone(timezone.utc)
            edt = datetime.fromisoformat(str(b["end"]).replace("Z", "+00:00")).astimezone(timezone.utc)
        except Exception:
            continue
        uid = re.sub(r"[^A-Za-z0-9._@-]", "-", str(b.get("eventId") or "block")) + "@study-os.local"
        summary = str(b.get("summary") or "Study Block").replace(",", "\\,").replace(";", "\\;")
        cid = str(b.get("courseId") or "")
        desc = f"Course: {cid} | Profile: {b.get('recommendedProfile', 'learning')}".replace(",", "\\,")
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{uid}",
                f"DTSTAMP:{stamp}",
                f"DTSTART:{sdt.strftime('%Y%m%dT%H%M%SZ')}",
                f"DTEND:{edt.strftime('%Y%m%dT%H%M%SZ')}",
                f"SUMMARY:{summary}",
                f"DESCRIPTION:{desc}",
                "END:VEVENT",
            ]
        )
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
