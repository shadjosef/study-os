"""Read-only Google Calendar & TimeEdit schedule reader for Study-OS.

IMPORTANT: Strictly READ-ONLY. Never mutates remote Google Calendar events;
the existing Codex planner remains the sole writer of remote calendar events.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any
from zoneinfo import ZoneInfo

from canvas_bridge import resolve_canvas_archive
from dlpfc import circadian_dlpfc_target, effective_dlpfc_tier
from timetable_planner import load_custom_schedule, match_course_for_text

OSLO_TZ = ZoneInfo("Europe/Oslo")

COURSE_MATCHERS = [
    {
        "courseId": "acct-2527",
        "patterns": [r"\baccount", r"\bexc\s*3430\b", r"\bfinance\b", r"\bnpv\b", r"\bcash[- ]flow", r"\bbookkeeping\b", r"\bt-account"],
        "topicPatterns": [
            (r"\bch(?:apter)?\.?\s*10\b|\bnpv\b|\birr\b|\bpayback\b|\bresidual income\b|\barr\b|\bdiscount", "10"),
            (r"\bch(?:apter)?\.?\s*8\b|\bfull cost|\babc\b|\bactivity[- ]based|\boverhead", "8"),
            (r"\bch(?:apter)?\.?\s*7\b|\bbreak[- ]even|\bcvp\b|\bscarce|\brelevant cost|\bmargin of safety", "7"),
            (r"\bch(?:apter)?\.?\s*5\b|\bcash[- ]?flow", "5"),
            (r"\bdeb\b|\bdouble[- ]entry|\bt-account|\btrial balance|\bdebit", "DEB"),
            (r"\bch(?:apter)?\.?\s*(?:\d+\s*[-–]\s*)?3\b|\bincome statement|\baccrual|\bdepreciation|\bperformance", "3"),
            (r"\bch(?:apter)?\.?\s*2\b|\bbalance sheet|\bfinancial position", "2"),
            (r"\bch(?:apter)?\.?\s*1\b|\bfoundation", "1"),
        ],
    },
    {
        "courseId": "econ-2522",
        "patterns": [r"\becon", r"\bexc\s*3420\b", r"\bmrs\b", r"\bisocost\b", r"\binflation\b", r"\bws[-–]ps\b"],
        "topicPatterns": [
            (r"\btopic\s*9\b|\binflation\b|\bcpi\b|\bphillips|\bconflicting claims|\bmonetary", "9"),
            (r"\btopic\s*8\b|\bgdp\b|\bbusiness cycle|\bconsumption smoothing|\bmultiplier", "8"),
            (r"\btopic\s*7\b|\bunion|\blorenz|\bgini\b|\bvoice effect", "7"),
            (r"\btopic\s*6\b|\bws[-–]ps\b|\bwage[- ]setting|\bprice[- ]setting|\blabou?r market", "6"),
            (r"\btopic\s*5\b|\bcompetitive market|\bsupply and demand|\bsurplus|\bprice[- ]taker", "5"),
            (r"\btopic\s*4\b|\bemployment rent|\bincomplete contract|\bno[- ]shirking|\bdiscipline", "4"),
            (r"\btopic\s*3\b|\bmrs\b|\bmrt\b|\bindifference|\bbudget line|\bincome and substitution", "3"),
            (r"\btopic\s*2\b|\bopportunity cost|\bisocost|\binnovation rent|\bdominance", "2"),
            (r"\btopic\s*1\b|\bcapitalist|\baverage product|\bmarginal product", "1"),
        ],
    },
    {
        "courseId": "math-2588",
        "patterns": [r"\bmath", r"\beba\s*118[015]", r"\beba\s*29102", r"\bcalculus\b", r"\bderivative", r"\btaylor\b"],
        "topicPatterns": [
            (r"\btaylor|\blinearis", "18"),
            (r"\belasticit", "17"),
            (r"\bmarginal cost|\bcost optimum|\bprofit max", "16"),
            (r"\bh[oô]pital", "15"),
            (r"\bconvex|\bconcav|\binflection|\bsecond derivative", "14"),
            (r"\bimplicit", "13"),
            (r"\boptimis|\bstationary|\bextreme|\bmaxima\b|\bminima\b|\bmaximum\b|\bminimum\b", "12"),
            (r"\btangent|\bdifferenti|\bchain rule|\bproduct rule|\bquotient rule", "11"),
            (r"\binverse|\blogarithm|\bexponential|\bln\b", "10"),
            (r"\basymptote|\bcontinuit|\blimit", "9"),
            (r"\bellipse|\bcircle|\bhyperbola|\bconic|\bquadratic graph", "8"),
            (r"\binequalit|\bsign chart|\bradical", "7"),
            (r"\bpolynomial division|\bfactor", "6"),
            (r"\bparameter", "5"),
            (r"\bseries|\bgeometric\s+sum|\bannuit|\bperpetuit|\bcontinuous compound", "4"),
            (r"\bpresent value|\bcash[- ]?flows?\b|\birr\b|\bnpv\b", "3"),
            (r"\binterest|\brates?\b|\bpower|\broot", "2"),
            (r"\balgebra", "1"),
        ],
    },
    {
        "courseId": "ob-2537",
        "patterns": [r"\borgani[sz]ational\b", r"\b\bob\b", r"\bexc\s*3460\b", r"\bleadership\b", r"\brobbins\b"],
        "topicPatterns": [
            (r"\blesson\s*14\b|\bconflict|\bpower\b|\bpolitic|\bnegotiat", "14"),
            (r"\blesson\s*13\b|\bdecision|\bbias|\bheuristic|\borgani[sz]ational learning", "13"),
            (r"\blesson\s*12\b|\bmotivation|\bjob design|\bjustice|\bexpectancy|\bequity", "12"),
            (r"\blesson\s*11\b|\btechnology|\balgorithmic", "11"),
            (r"\blesson\s*10\b|\bstructure|\bmatrix|\bmechanistic|\borganic|\bhr\b", "10"),
            (r"\blesson\s*9\b|\bdiversity|\bcreativity", "9"),
            (r"\blesson\s*8\b|\bcommunication|\bchange|\blewin|\bkotter", "8"),
            (r"\blesson\s*7\b|\battitude|\bemotion|\bstress|\bburnout|\bsatisfaction|\bcommitment", "7"),
            (r"\blesson\s*6\b|\bcharisma|\bfollowership|\bdark side", "6"),
            (r"\blesson\s*5\b|\bleadership|\btransformational", "5"),
            (r"\blesson\s*4\b|\bgroups?\b|\bteams?\b|\bgroupthink|\bpsychological safety", "4"),
            (r"\blesson\s*3\b|\bpersonality|\bbig five|\bperception|\battribution", "3"),
            (r"\blesson\s*2\b|\bculture", "2"),
            (r"\blesson\s*1\b", "1"),
        ],
    },
    {
        "courseId": "prog-3021",
        "patterns": [r"\bprogram", r"\bpython\b", r"\beba\s*3400\b", r"\bcoding\b", r"\bnotebook\b", r"\bdebugging\b"],
        "topicPatterns": [
            (r"\btime series|\bvisuali[sz]|\bmatplotlib|\bplot", "6"),
            (r"\bpandas|\bdataframe|\bcleaning|\baggregat", "5"),
            (r"\bscope\b|\bmodule|\bdebug", "4"),
            (r"\bdict|\btuple|\bfunction|\bdef\b", "3"),
            (r"\bloop|\bfor\b|\bwhile\b|\bcomprehension|\bsimulation", "2"),
            (r"\bstring|\binput|\bif\b|\bconditional", "1"),
        ],
    },
]

NON_STUDY_PATTERNS = [
    r"\bsleep\b",
    r"\bmorning routine\b",
    r"\bwind[- ]down\b",
    r"(?<!pre-)\bgym\b",
    r"\bfresh fitness\b",
    r"\bdinner\b",
    r"\blunch\b",
    r"\bbreakfast\b",
    r"\bbatch prep\b",
    r"\bgrocer",
    r"\bshower\b",
    r"\bfree time\b",
    r"\brecovery\b",
    r"\bhome admin\b",
    r"\burgent home admin\b",
    r"^admin:",
    r"\bprepare oats\b",
    r"\bbag/clothes\b",
    r"\bpick up\b",
    r"\btravel,\s*transition\b",
    r"\bbreathing room\b",
    r"\bfreezer\b",
    r"\bskincare\b",
    r"\bassessment\s+(?:preparation|arrival)\b",
    r"\bhome exam:\s*(?:equipment|login)",
    r"^\[done\]",
]

TITLE_PREFIX_MAP = [
    (r"^(?:\[bi class\]\s*)?(?:accounting|fundamentals of accounting|exc\s*3430)\b", "acct-2527"),
    (r"^(?:\[bi class\]\s*)?(?:economics|econ\b|exc\s*3420)\b", "econ-2522"),
    (r"^(?:\[bi class\]\s*)?(?:maths?|mathematics|eba\s*118[015])\b", "math-2588"),
    (r"^(?:\[bi class\]\s*)?(?:ob\b|organi[sz]ational|exc\s*3460)\b", "ob-2537"),
    (r"^(?:\[bi class\]\s*)?(?:programming|python|eba\s*3400)\b", "prog-3021"),
]


def find_gcalendar_bin() -> str | None:
    direct = shutil.which("gcalendar")
    if direct:
        return direct
    home = Path.home()
    candidates = [
        home / ".gemini/antigravity/bin/gcalendar",
        home / ".local/bin/gcalendar",
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def parse_iso(dt_str: str | None) -> datetime | None:
    if not dt_str:
        return None
    try:
        if len(dt_str) == 10 and dt_str[4] == "-":
            return datetime.fromisoformat(dt_str + "T00:00:00+01:00").astimezone(OSLO_TZ)
        return datetime.fromisoformat(dt_str.replace("Z", "+00:00")).astimezone(OSLO_TZ)
    except ValueError:
        return None


def classify_event(
    summary: str,
    description: str = "",
    courses_by_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    summary_low = summary.lower()
    if any(re.search(p, summary_low) for p in NON_STUDY_PATTERNS):
        return None

    matched_course = None
    matched_topics: list[str] = []
    # 1. Explicit subject prefix in event title always wins!
    for prefix_pat, cid in TITLE_PREFIX_MAP:
        if re.search(prefix_pat, summary_low):
            if not courses_by_id or cid in courses_by_id:
                matched_course = cid
                break

    # 2. Fallback to course-name / code patterns in summary
    if not matched_course:
        for cm in COURSE_MATCHERS:
            if any(re.search(p, summary_low) for p in cm["patterns"][:3]):
                if not courses_by_id or cm["courseId"] in courses_by_id:
                    matched_course = cm["courseId"]
                    break

    # 3. Dynamic multi-semester / multi-university course matcher from loaded banks
    if not matched_course and courses_by_id:
        dyn_cid, dyn_topics = match_course_for_text(f"{summary} {description}", courses_by_id)
        if dyn_cid:
            matched_course = dyn_cid
            matched_topics = dyn_topics

    # 4. Populate topicIds ONLY from the matched course's topic map in summary_low!
    if matched_course and not matched_topics:
        cm_obj = next((c for c in COURSE_MATCHERS if c["courseId"] == matched_course), None)
        if cm_obj:
            for pat, tid in cm_obj["topicPatterns"]:
                if re.search(pat, summary_low):
                    if tid not in matched_topics:
                        matched_topics.append(tid)
        elif courses_by_id and matched_course in courses_by_id:
            _, matched_topics = match_course_for_text(f"{summary} {description}", {matched_course: courses_by_id[matched_course]})

    is_weekly_review = bool(re.search(r"\bweekly review\b", summary_low))
    if not matched_course and not is_weekly_review:
        return None

    is_recall = bool(re.search(r"\b20\s*min|\bflashcard|\bnotebooklm|\brecall\b", summary_low))
    is_lecture = bool(
        re.search(r"^\[bi class|\bforelesning\b|\bøving\b|\bextra session\b|\brevision session\b", summary_low)
        or (re.search(r"\b(?:lecture|tutoring|ta session|seminar)\b", summary_low) and "follow-through" not in summary_low)
    )
    is_exam = bool(
        re.search(r"^\[exam\]|^\[bi exam\]|\beksamen\b", summary_low)
        or (
            re.search(r":\s*(?:(?:home|final|written|oral)\s+)?exam\b", summary_low)
            and not re.search(r"\b(?:mark|repair|setup|warm-up|follow-through|prep|practice|after)\b", summary_low)
        )
        or (
            re.search(r"\bmock exam\b|\bfull 3-hour paper\b", summary_low)
            and not re.search(r"\b(?:mark|repair|setup|warm-up|follow-through)\b", summary_low)
        )
    )

    kind = "study_block"
    if is_weekly_review:
        kind = "weekly_review"
    elif is_exam:
        kind = "exam"
    elif is_lecture:
        kind = "class_session"
    elif is_recall:
        kind = "recall_sprint"

    return {
        "courseId": matched_course,
        "topicIds": matched_topics,
        "blockKind": kind,
        "recommendedProfile": "exam" if is_recall or is_exam else "learning",
    }


def normalize_raw_events(
    raw_events: list[dict[str, Any]],
    courses_by_id: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for ev in raw_events:
        if ev.get("status") == "cancelled":
            continue
        summary = (ev.get("summary") or "").strip()
        summary_low = summary.lower()
        description = (ev.get("description") or "").strip()
        start_raw = (ev.get("start") or {}).get("dateTime")
        end_raw = (ev.get("end") or {}).get("dateTime")
        start_dt = parse_iso(start_raw)
        end_dt = parse_iso(end_raw)
        if not start_dt or not end_dt:
            continue
        info = classify_event(summary, description, courses_by_id=courses_by_id)
        if not info:
            continue
        total_min = max(5, int(round((end_dt - start_dt).total_seconds() / 60)))
        explicit_m = re.search(r"\((\d{2})\s*m(?:in)?\b", summary_low)
        if explicit_m and info["blockKind"] in ("study_block", "recall_sprint"):
            focus_min = int(explicit_m.group(1))
        elif info["blockKind"] == "study_block" and 55 <= total_min <= 65 and ("(50/10)" in summary or "Flowtime" in summary or "Arena" in summary):
            focus_min = 50
        elif info["blockKind"] == "study_block" and 85 <= total_min <= 135:
            focus_min = int(round(total_min * 0.82))
        else:
            focus_min = total_min
        attempt_budget_min = round(focus_min * 0.76, 1)
        # Clean first paragraph of description for concise actionable instructions
        first_para = description.split("\n\n")[0].strip() if description else ""
        if info["blockKind"] == "recall_sprint":
            dlpfc_mode = "low_dlpfc"
        elif start_dt.hour < 14:
            dlpfc_mode = "high_dlpfc"
        elif start_dt.hour < 18:
            dlpfc_mode = "med_dlpfc"
        else:
            dlpfc_mode = "low_dlpfc"
        start_iso = start_dt.isoformat()
        end_iso = end_dt.isoformat()
        start_lbl = start_dt.strftime("%H:%M")
        end_lbl = end_dt.strftime("%H:%M")
        blocks.append(
            {
                "eventId": ev.get("id") or f"ev-{int(start_dt.timestamp())}",
                "summary": summary,
                "focusNote": first_para[:420],
                "location": ev.get("location") or "",
                "htmlLink": ev.get("htmlLink") or "",
                "start": start_iso,
                "end": end_iso,
                "startIso": start_iso,
                "endIso": end_iso,
                "date": start_dt.strftime("%Y-%m-%d"),
                "startTime": start_lbl,
                "endTime": end_lbl,
                "startLabel": start_lbl,
                "endLabel": end_lbl,
                "calendarMinutes": total_min,
                "durationMinutes": total_min,
                "focusMinutes": focus_min,
                "attemptBudgetMinutes": attempt_budget_min,
                "dlpfcMode": dlpfc_mode,
                **info,
            }
        )
    blocks.sort(key=lambda b: b["startIso"])
    return blocks


def _fetch_gcalendar_events(
    gcal: str,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[dict[str, Any]], str | None]:
    """Fetch read-only events across all selected user calendars in 10-day chunks."""
    env = os.environ.copy()
    gcal_account = env.get("STUDY_OS_GCAL_ACCOUNT")
    if gcal_account and not env.get("AGY_ACCOUNT"):
        env["AGY_ACCOUNT"] = gcal_account

    cal_ids: list[str] = []
    error_msg: str | None = None
    try:
        cals_proc = subprocess.run(
            [gcal, "readonly", "calendars", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=env,
        )
        if cals_proc.returncode == 0 and cals_proc.stdout.strip().startswith("["):
            for entry in json.loads(cals_proc.stdout):
                cid = str(entry.get("id") or "").strip()
                if not cid:
                    continue
                if "#holiday@" in cid or "#contacts@" in cid or "#weeknum@" in cid:
                    continue
                if entry.get("hidden") or entry.get("deleted"):
                    continue
                if entry.get("selected", True) or entry.get("primary") or entry.get("accessRole") == "owner":
                    cal_ids.append(cid)
        elif cals_proc.returncode != 0:
            error_msg = (cals_proc.stderr or cals_proc.stdout or "").strip()[:240]
    except Exception as exc:
        error_msg = str(exc)[:240]

    if not cal_ids:
        cal_ids = ["primary"]

    raw_by_id: dict[str, dict[str, Any]] = {}
    ordered_raw: list[dict[str, Any]] = []
    chunk_days = 10

    for cal_id in cal_ids:
        cursor = window_start
        while cursor <= window_end:
            chunk_end = min(window_end, cursor + timedelta(days=chunk_days - 1))
            s_str = cursor.strftime("%Y-%m-%d") + "T00:00:00+01:00"
            e_str = chunk_end.strftime("%Y-%m-%d") + "T23:59:59+01:00"
            try:
                proc = subprocess.run(
                    [
                        gcal,
                        "readonly",
                        "events",
                        "--cal",
                        cal_id,
                        "--start",
                        s_str,
                        "--end",
                        e_str,
                        "--max",
                        "250",
                        "--json",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                    env=env,
                )
                if proc.returncode == 0 and proc.stdout.strip().startswith(("[", "{")):
                    parsed = json.loads(proc.stdout)
                    items = parsed if isinstance(parsed, list) else parsed.get("items", parsed.get("events", []))
                    for ev in items:
                        eid = str(ev.get("id") or "")
                        if eid and eid in raw_by_id:
                            continue
                        if eid:
                            raw_by_id[eid] = ev
                        ordered_raw.append(ev)
                elif proc.returncode != 0 and not error_msg:
                    error_msg = (proc.stderr or proc.stdout or "").strip()[:240]
            except Exception as exc:
                if not error_msg:
                    error_msg = str(exc)[:240]
            cursor = chunk_end + timedelta(days=1)

    return ordered_raw, error_msg


def refresh_calendar_cache(
    study_os_root: Path,
    days_ahead: int = 21,
    data_dir: Path | None = None,
    courses_by_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    d_dir = data_dir or (study_os_root / "data")
    cache_path = d_dir / "state" / "calendar_cache.json"
    now = datetime.now(OSLO_TZ)
    window_start = now - timedelta(days=1)
    window_end = now + timedelta(days=days_ahead)
    start_date = window_start.strftime("%Y-%m-%d")
    end_date = window_end.strftime("%Y-%m-%d")

    # 1. If student configured an active TimeEdit / LLM Custom Schedule in Study-OS, serve it first!
    custom_sched = load_custom_schedule(d_dir)
    if custom_sched.get("enabled") and custom_sched.get("blocks"):
        return {
            "updatedAt": custom_sched.get("updatedAt") or now.isoformat(),
            "source": custom_sched.get("source") or "custom_schedule",
            "timezone": "Europe/Oslo",
            "windowStart": start_date,
            "windowEnd": end_date,
            "estimate": custom_sched.get("estimate"),
            "blocks": custom_sched["blocks"],
        }

    gcal = find_gcalendar_bin()
    raw_events: list[dict[str, Any]] = []
    source = "cache_only"
    error_msg = None

    if gcal:
        raw_events, error_msg = _fetch_gcalendar_events(gcal, window_start, window_end)
        if raw_events:
            source = "google_calendar_live"

    if raw_events:
        blocks = normalize_raw_events(raw_events, courses_by_id=courses_by_id)
        payload = {
            "updatedAt": now.isoformat(),
            "source": source,
            "timezone": "Europe/Oslo",
            "windowStart": start_date,
            "windowEnd": end_date,
            "blocks": blocks,
        }
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(cache_path)
        return payload

    # Fallback: return existing cache if present, or inspect Canvas-Archive CURRENT.json
    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if error_msg:
                cached["lastRefreshNotice"] = error_msg
            return cached
        except Exception:
            pass

    fallback_blocks = load_fallback_from_canvas_archive(study_os_root, data_dir=d_dir, courses_by_id=courses_by_id)
    payload = {
        "updatedAt": now.isoformat(),
        "source": "canvas_archive_timetable" if fallback_blocks else "empty",
        "timezone": "Europe/Oslo",
        "blocks": fallback_blocks,
    }
    if error_msg:
        payload["lastRefreshNotice"] = error_msg
    return payload


def load_fallback_from_canvas_archive(
    study_os_root: Path,
    data_dir: Path | None = None,
    courses_by_id: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    archive_dir = resolve_canvas_archive(study_os_root, data_dir)
    if archive_dir is None:
        return []
    current_json = archive_dir / "ASSISTANT_CONTEXT" / "CURRENT.json"
    if not current_json.is_file():
        return []
    try:
        data = json.loads(current_json.read_text(encoding="utf-8"))
        events = (data.get("timetable") or {}).get("events") or []
        pseudo = []
        for ev in events[:120]:
            pseudo.append(
                {
                    "id": ev.get("uid") or ev.get("id"),
                    "summary": ev.get("summary") or ev.get("title") or "",
                    "description": ev.get("description") or "",
                    "location": ev.get("location") or "",
                    "start": {"dateTime": ev.get("start")},
                    "end": {"dateTime": ev.get("end")},
                }
            )
        return normalize_raw_events(pseudo, courses_by_id=courses_by_id)
    except Exception:
        return []


def build_auto_queue_for_block(
    block: dict[str, Any],
    courses_by_id: dict[str, dict[str, Any]],
    progress_records: dict[str, dict[str, Any]],
    today_high_dlpfc_min: float = 0.0,
) -> dict[str, Any]:
    """Pre-selects the optimal zero-decision-fatigue exercise queue matched to Circadian dlPFC capacity."""
    cid = block.get("courseId")
    if not cid or cid not in courses_by_id:
        return {"questionIds": [], "estimatedMinutes": 0.0, "strategy": "Select any course to begin."}

    bank = courses_by_id[cid]
    questions = [q for q in bank.get("questions", []) if q.get("available", True)]
    target_topics = set(str(t) for t in (block.get("topicIds") or []))
    profile = block.get("recommendedProfile") or "learning"
    budget_min = float(block.get("attemptBudgetMinutes") or 35.0)
    is_recall = block.get("blockKind") == "recall_sprint"
    now_iso = datetime.now(OSLO_TZ).isoformat()

    start_lbl = str(block.get("startLabel") or "")
    block_hour = int(start_lbl.split(":")[0]) if ":" in start_lbl and start_lbl.split(":")[0].isdigit() else datetime.now(OSLO_TZ).hour

    if is_recall:
        dlpfc_mode = "low_dlpfc"
    else:
        dlpfc_mode, _ = circadian_dlpfc_target(block_hour, today_high_dlpfc_min)

    def q_minutes(q: dict[str, Any]) -> float:
        pacing = q.get("pacing") or {}
        prof = pacing.get(profile) or pacing.get("learning") or {}
        return float(prof.get("target") or (2.0 if q.get("kind") == "mcq" else 10.0))

    def q_eff_tier(q: dict[str, Any]) -> int:
        return effective_dlpfc_tier(q, progress_records.get(q["id"]))[0]

    # Filter out Easy recognition items during morning Hard windows whenever High/Med work remains
    if dlpfc_mode == "high_dlpfc":
        deep_min = sum(
            q_minutes(q)
            for q in questions
            if q_eff_tier(q) >= 2 and (progress_records.get(q["id"]) or {}).get("status") != "done"
        )
        candidate_pool = (
            [q for q in questions if q_eff_tier(q) >= 2]
            if deep_min >= min(20.0, budget_min * 0.55)
            else questions
        )
    elif dlpfc_mode == "low_dlpfc":
        light_pool = [q for q in questions if q_eff_tier(q) <= 2]
        candidate_pool = light_pool if len(light_pool) >= 3 else questions
    else:
        candidate_pool = questions

    def priority_key(q: dict[str, Any]) -> tuple:
        rec = progress_records.get(q["id"]) or {}
        status = rec.get("status") or "not_started"
        fsrs = rec.get("fsrs") or {}
        due = fsrs.get("due")
        is_due = bool(due and due <= now_iso and status in ("done", "revisit"))
        in_topic = 0 if (not target_topics or str(q.get("topicId")) in target_topics) else 1
        tier = q_eff_tier(q)
        qm = round(q_minutes(q), 1)
        is_mcq = 1 if q.get("kind") == "mcq" else 0
        synth_rank = 1 if q.get("origin") == "synthetic_drill" else 0

        if in_topic == 0 and status == "revisit":
            bucket = 0
        elif in_topic == 0 and status == "in_progress":
            bucket = 1
        elif in_topic == 0 and is_due:
            bucket = 2
        elif in_topic == 0 and status == "not_started":
            bucket = 3
        elif status == "revisit" or is_due:
            bucket = 4
        elif status == "not_started":
            bucket = 5
        else:
            bucket = 6

        if dlpfc_mode == "low_dlpfc":
            # Evening / Recall Sprint: Tier 1 -> Tier 2, concise recognition & FSRS reviews first
            tier_pref = {1: 0, 2: 1, 3: 2}[tier]
            return (bucket, tier_pref, 0 if is_mcq else 1, qm, q["id"])
        if dlpfc_mode == "high_dlpfc":
            # Morning Peak: Tier 3 Novel Synthesis -> Tier 2 Procedural, non-MCQ & longer horizon first
            tier_pref = {3: 0, 2: 1, 1: 2}[tier]
            return (bucket, tier_pref, is_mcq, -qm, synth_rank, q["id"])
        # Afternoon Medium Downshift (15:00–18:00 or post-4.5h cap): Tier 2 Procedural -> Tier 1 -> Tier 3
        tier_pref = {2: 0, 1: 1, 3: 2}[tier]
        return (bucket, tier_pref, synth_rank, abs(qm - 12.0), q["id"])

    raw_ranked = sorted(candidate_pool, key=priority_key)

    # Interleave distinct topics within the same (bucket, dlPFC tier) band to prevent autopilot recipe-grinding
    ranked: list[dict[str, Any]] = []
    i_idx = 0
    while i_idx < len(raw_ranked):
        head_key = priority_key(raw_ranked[i_idx])[:2]
        band: list[dict[str, Any]] = []
        while i_idx < len(raw_ranked) and priority_key(raw_ranked[i_idx])[:2] == head_key:
            band.append(raw_ranked[i_idx])
            i_idx += 1
        by_t: dict[str, list[dict[str, Any]]] = {}
        t_order: list[str] = []
        for item in band:
            tk = str(item.get("topicId") or "")
            if tk not in by_t:
                by_t[tk] = []
                t_order.append(tk)
            by_t[tk].append(item)
        added = True
        while added:
            added = False
            for tk in t_order:
                if by_t[tk]:
                    ranked.append(by_t[tk].pop(0))
                    added = True

    chosen: list[str] = []
    acc_min = 0.0
    max_items = 10 if is_recall else (20 if budget_min >= 50 else 14)

    for q in ranked:
        qm = q_minutes(q)
        if chosen and (acc_min + qm > budget_min * 1.25 or len(chosen) >= max_items):
            if len(chosen) >= (1 if acc_min >= budget_min * 0.65 else 2):
                break
            continue
        chosen.append(q["id"])
        acc_min += qm
        if acc_min >= budget_min * 0.92:
            break

    if not chosen and ranked:
        chosen = [ranked[0]["id"]]
        acc_min = q_minutes(ranked[0])

    topic_label = f"Topic(s) {', '.join(block['topicIds'])}" if block.get("topicIds") else "Course priority"
    mode_tag = {
        "high_dlpfc": "Hard · Multi-step",
        "med_dlpfc": "Medium · Standard practice",
        "low_dlpfc": "Easy · Recall",
    }[dlpfc_mode]
    return {
        "questionIds": chosen,
        "estimatedMinutes": round(acc_min, 1),
        "profile": profile,
        "cognitiveMode": dlpfc_mode,
        "strategy": f"{mode_tag} · {len(chosen)} queued ({topic_label}) · ~{round(acc_min)}m Par",
    }
