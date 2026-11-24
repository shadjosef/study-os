"""Universal & Subgroup Productivity Metrics, FSRS-5 Scheduler, and Correlation Engine."""
from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from dlpfc import HIGH_DLPFC_DAILY_CAP_MIN, circadian_dlpfc_target, classify_intrinsic_dlpfc

OSLO_TZ = ZoneInfo("Europe/Oslo")


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def is_auto_graded_attempt(a: dict[str, Any]) -> bool:
    if isinstance(a.get("autoGraded"), bool):
        return a["autoGraded"]
    kind = str(a.get("kind") or "").lower()
    return kind in ("mcq", "wiseflow", "flowmulti")


def difficulty_upi_multiplier(tier: int, profile: str = "learning") -> float:
    base = {1: 0.85, 2: 1.00, 3: 1.22}.get(int(tier or 2), 1.00)
    exam_bonus = 1.08 if str(profile or "learning").lower() == "exam" else 1.0
    return base * exam_bonus


def compute_attempt_metrics(
    active_sec: float,
    ai_par_sec: float,
    hints_used: int,
    hint_handicap_sec: float,
    quality_accuracy: float,
    assisted: bool = False,
    dlpfc_tier: int = 2,
    profile: str = "learning",
    auto_graded: bool = True,
) -> dict[str, Any]:
    """Accuracy-Gated & Zero-Hint 'Beat the AI' scoring.

    - Beating AI Par ONLY counts when quality_accuracy >= 0.85, hints_used == 0, and assisted is False!
    - Rushing wrong answers or peeking hints/solutions yields 0 Beat-AI credit.
    - Hard (Tier 3) and Exam-Par runs receive a UPI difficulty bonus; Easy (Tier 1) scales conservatively.
    - Self-graded written tasks cap pace ratio at 1.00 and carry reduced weight in aggregate UPI.
    """
    q = clamp(float(quality_accuracy), 0.0, 1.0)
    par = max(15.0, float(ai_par_sec))
    handicap = max(0, int(hints_used)) * max(0.0, float(hint_handicap_sec))
    effective_sec = max(1.0, float(active_sec) + handicap)
    delta_sec = round(effective_sec - par, 1)  # negative = faster than AI Par!

    if q < 0.6:
        pace_ratio = round(0.4 * q, 3)
        beat_ai = False
    else:
        max_pr = 1.50 if auto_graded else 1.00
        raw_ratio = clamp(par / max(effective_sec, 0.25 * par), 0.35, max_pr)
        pace_ratio = round(raw_ratio * q, 3)
        beat_ai = bool(q >= 0.85 and int(hints_used) == 0 and (not assisted) and effective_sec <= par)

    # Single-question difficulty & verification-aware UPI preview
    mult = difficulty_upi_multiplier(dlpfc_tier, profile)
    pr_cap = 1.35 if auto_graded else 1.00
    raw_upi = 100.0 * (0.45 * q + 0.35 * min(pace_ratio, pr_cap) + 0.20 * 0.90) * mult
    item_upi = round(clamp(raw_upi, 0.0, 150.0))

    # FSRS rating auto-suggestion: 1=Again, 2=Hard, 3=Good, 4=Easy
    if q < 0.6:
        fsrs_grade = 1
    elif hints_used > 0 or assisted or effective_sec > par * 1.25 or q < 0.85:
        fsrs_grade = 2
    elif beat_ai and hints_used == 0 and effective_sec <= par * 0.85 and q >= 0.99:
        fsrs_grade = 4
    else:
        fsrs_grade = 3

    return {
        "activeSec": round(active_sec, 1),
        "effectiveSec": round(effective_sec, 1),
        "aiParSec": round(par, 1),
        "hintHandicapSec": round(handicap, 1),
        "deltaSec": delta_sec,
        "qualityAccuracy": round(q, 3),
        "paceRatio": pace_ratio,
        "beatAi": beat_ai,
        "itemUpi": item_upi,
        "suggestedFsrsGrade": fsrs_grade,
    }


def update_fsrs_card(prev: dict[str, Any] | None, grade: int, now: datetime | None = None) -> dict[str, Any]:
    """Compact FSRS-5 inspired memory state update (`grade` in 1..4)."""
    t = now or datetime.now(OSLO_TZ)
    g = int(clamp(grade, 1, 4))
    if not prev or not prev.get("reps"):
        init_s = {1: 0.4, 2: 1.2, 3: 3.2, 4: 7.5}[g]
        init_d = clamp(6.8 - (g - 1) * 1.1, 1.0, 10.0)
        interval_days = 0.02 if g == 1 else round(init_s, 2)
        due = t + timedelta(days=interval_days)
        return {
            "stability": round(init_s, 2),
            "difficulty": round(init_d, 2),
            "reps": 1,
            "lapses": 1 if g == 1 else 0,
            "lastGrade": g,
            "lastReview": t.isoformat(),
            "due": due.isoformat(),
        }

    s = float(prev.get("stability") or 1.5)
    d = float(prev.get("difficulty") or 5.0)
    reps = int(prev.get("reps") or 0) + 1
    lapses = int(prev.get("lapses") or 0)
    last_rev = prev.get("lastReview")
    elapsed_days = 1.0
    if last_rev:
        try:
            elapsed_days = max(0.05, (t - datetime.fromisoformat(last_rev)).total_seconds() / 86400.0)
        except Exception:
            elapsed_days = 1.0

    retrievability = math.pow(1.0 + elapsed_days / (9.0 * max(0.2, s)), -1.0)
    d_next = clamp(d - 0.55 * (g - 3), 1.0, 10.0)
    d_next = 0.85 * d_next + 0.15 * 5.2

    if g == 1:
        lapses += 1
        s_next = clamp(s * 0.28, 0.3, max(1.0, s * 0.6))
        interval_days = 0.04  # ~1 hour / same day revisit
    else:
        hard_mult = 0.78 if g == 2 else (1.28 if g == 4 else 1.0)
        growth = 1.0 + math.exp(1.45) * (11.0 - d_next) * math.pow(s, -0.18) * (
            math.exp(0.85 * (1.0 - retrievability)) - 1.0
        ) * hard_mult
        s_next = clamp(s * max(1.15, growth), 0.5, 365.0)
        interval_days = round(s_next, 2)

    due = t + timedelta(days=interval_days)
    return {
        "stability": round(s_next, 2),
        "difficulty": round(d_next, 2),
        "reps": reps,
        "lapses": lapses,
        "lastGrade": g,
        "lastReview": t.isoformat(),
        "due": due.isoformat(),
    }


def read_jsonl(path: Path, max_lines: int = 5000) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines[-max_lines:]:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except ValueError:
                continue
    except OSError:
        return []
    return rows


def aggregate_attempt_group(attempts: list[dict[str, Any]], focus_density: float = 0.88) -> dict[str, Any]:
    if not attempts:
        return {
            "count": 0,
            "avgAccuracy": None,
            "avgPaceRatio": None,
            "beatAiRate": None,
            "avgDeltaSec": None,
            "totalActiveMinutes": 0.0,
            "upi": None,
        }
    n = len(attempts)
    avg_q = sum(float(a.get("qualityAccuracy", 0.0)) for a in attempts) / n
    avg_pr = sum(min(1.35 if is_auto_graded_attempt(a) else 1.00, float(a.get("paceRatio", 0.0))) for a in attempts) / n
    beat_rate = sum(1 for a in attempts if a.get("beatAi")) / n
    avg_delta = sum(float(a.get("deltaSec", 0.0)) for a in attempts) / n
    tot_min = sum(float(a.get("activeSec", 0.0)) for a in attempts) / 60.0
    fd = clamp(focus_density, 0.0, 1.0)
    weighted_sum = 0.0
    total_w = 0.0
    for a in attempts:
        auto = is_auto_graded_attempt(a)
        w = 1.0 if auto else 0.45
        q_val = clamp(float(a.get("qualityAccuracy", 0.0)), 0.0, 1.0)
        pr_val = min(1.35 if auto else 1.00, float(a.get("paceRatio", 0.0)))
        tier = int(a.get("dlpfcTier") or (1 if str(a.get("kind") or "") == "mcq" else 2))
        mult = difficulty_upi_multiplier(tier, str(a.get("profile") or "learning"))
        item_score = 100.0 * (0.45 * q_val + 0.35 * pr_val + 0.20 * fd) * mult
        weighted_sum += w * clamp(item_score, 0.0, 150.0)
        total_w += w
    upi = round(weighted_sum / max(0.001, total_w))
    return {
        "count": n,
        "avgAccuracy": round(avg_q, 3),
        "avgPaceRatio": round(avg_pr, 3),
        "beatAiRate": round(beat_rate, 3),
        "avgDeltaSec": round(avg_delta, 1),
        "totalActiveMinutes": round(tot_min, 1),
        "upi": upi,
    }


def time_of_day_bucket(iso_ts: str) -> str:
    try:
        h = datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).astimezone(OSLO_TZ).hour
        if h < 12:
            return "morning_06_12"
        if h < 17:
            return "afternoon_12_17"
        return "evening_17_23"
    except Exception:
        return "unknown"


def pearson_r(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3 or len(ys) != n:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx < 1e-9 or dy < 1e-9:
        return None
    return round(num / (dx * dy), 3)


def compute_correlations(sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Correlates 5-second subjective check-ins & context tags with objective session UPI & Beat-AI rate."""
    valid = [s for s in sessions if isinstance(s.get("checkIn"), dict) and s.get("upi") is not None]
    insights: list[dict[str, Any]] = []
    if len(valid) < 2:
        return [
            {
                "factor": "onboarding",
                "label": "Telemetry Ready",
                "sampleSize": len(valid),
                "r": None,
                "summary": "Complete 2–3 study runs with the 5-second check-in to unlock personal Focus, Energy, Inertia & Location correlations.",
            }
        ]

    for key, label in [
        ("focus", "Self-Rated Focus (1–5) → UPI"),
        ("energy", "Pre/Session Energy (1–5) → UPI"),
        ("startInertia", "Start Inertia (1–5) → UPI"),
    ]:
        pairs = [
            (float(s["checkIn"][key]), float(s["upi"]))
            for s in valid
            if isinstance(s["checkIn"].get(key), (int, float))
        ]
        if len(pairs) >= 3:
            xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
            r = pearson_r(xs, ys)
            high = [y for x, y in pairs if x >= 4]
            low = [y for x, y in pairs if x <= 2]
            diff_txt = ""
            if high and low:
                delta = round(sum(high) / len(high) - sum(low) / len(low), 1)
                diff_txt = f" (avg UPI {delta:+.1f} when ≥4 vs ≤2)"
            if r is not None:
                insights.append(
                    {
                        "factor": key,
                        "label": label,
                        "sampleSize": len(pairs),
                        "r": r,
                        "summary": f"r = {r:+.2f} across {len(pairs)} sessions{diff_txt}.",
                    }
                )

    # Tag comparisons (e.g. BI Library vs Home, Low Sleep, Phone Distraction, Flow State)
    all_tags: set[str] = set()
    for s in valid:
        for t in s["checkIn"].get("tags") or []:
            all_tags.add(str(t))

    for tag in sorted(all_tags):
        with_t = [float(s["upi"]) for s in valid if tag in (s["checkIn"].get("tags") or [])]
        without_t = [float(s["upi"]) for s in valid if tag not in (s["checkIn"].get("tags") or [])]
        if len(with_t) >= 2 and len(without_t) >= 2:
            avg_w = sum(with_t) / len(with_t)
            avg_wo = sum(without_t) / len(without_t)
            delta = round(avg_w - avg_wo, 1)
            insights.append(
                {
                    "factor": f"tag:{tag}",
                    "label": f"Tag '{tag}' Impact",
                    "sampleSize": len(with_t),
                    "deltaUpi": delta,
                    "r": None,
                    "summary": f"Avg UPI {avg_w:.0f} with '{tag}' (n={len(with_t)}) vs {avg_wo:.0f} without ({delta:+.1f} UPI).",
                }
            )

    return insights


def build_full_analytics(
    study_os_root: Path,
    courses_by_id: dict[str, dict[str, Any]],
    progress_state: dict[str, Any],
) -> dict[str, Any]:
    attempts = read_jsonl(study_os_root / "data" / "logs" / "attempts.jsonl")
    sessions = read_jsonl(study_os_root / "data" / "logs" / "sessions.jsonl")
    records: dict[str, dict[str, Any]] = progress_state.get("records") or {}

    now = datetime.now(OSLO_TZ)
    now_iso = now.isoformat()
    today_str = now.strftime("%Y-%m-%d")
    seven_days_ago = (now - timedelta(days=7)).isoformat()

    avg_focus_density = (
        sum(float(s.get("focusDensity", 0.88)) for s in sessions) / len(sessions)
        if sessions
        else 0.88
    )

    overall = aggregate_attempt_group(attempts, avg_focus_density)
    last_7d = aggregate_attempt_group(
        [a for a in attempts if (a.get("timestamp") or "") >= seven_days_ago],
        avg_focus_density,
    )
    today_metrics = aggregate_attempt_group(
        [a for a in attempts if (a.get("timestamp") or "").startswith(today_str)],
        avg_focus_density,
    )

    # Subgroups
    by_course: dict[str, Any] = {}
    by_topic: dict[str, Any] = {}
    by_kind: dict[str, Any] = {}
    by_profile: dict[str, Any] = {}
    by_time_slot: dict[str, Any] = {}

    def bucket_push(d: dict[str, list], k: str, item: Any) -> None:
        d.setdefault(k, []).append(item)

    g_course: dict[str, list] = {}
    g_course_tier: dict[str, list] = {}
    g_topic: dict[str, list] = {}
    g_kind: dict[str, list] = {}
    g_prof: dict[str, list] = {}
    g_slot: dict[str, list] = {}
    g_dlpfc: dict[str, list] = {}

    q_lookup: dict[str, dict[str, Any]] = {}
    for bank in courses_by_id.values():
        for q in bank.get("questions") or []:
            q_lookup[q["id"]] = q

    today_dlpfc_sec = {1: 0.0, 2: 0.0, 3: 0.0}
    today_focus_switches = 0
    today_away_sec = 0.0

    for a in attempts:
        cid = str(a.get("courseId") or "unknown")
        tid = f"{cid}:{a.get('topicId') or 'general'}"
        raw_tier = a.get("dlpfcTier")
        if raw_tier in (1, 2, 3):
            tier = int(raw_tier)
        else:
            q_obj = q_lookup.get(str(a.get("questionId") or ""))
            tier = classify_intrinsic_dlpfc(q_obj)[0] if q_obj else (1 if a.get("kind") == "mcq" else 2)
        tier_key = {3: "high_3", 2: "med_2", 1: "low_1"}[tier]

        bucket_push(g_course, cid, a)
        bucket_push(g_course_tier, f"{cid}:{tier}", a)
        bucket_push(g_topic, tid, a)
        bucket_push(g_kind, str(a.get("kind") or "mcq"), a)
        bucket_push(g_prof, str(a.get("profile") or "learning"), a)
        bucket_push(g_slot, time_of_day_bucket(str(a.get("timestamp") or "")), a)
        bucket_push(g_dlpfc, tier_key, a)

        if str(a.get("timestamp") or "").startswith(today_str):
            today_dlpfc_sec[tier] += float(a.get("activeSec") or 0.0)
            today_focus_switches += int(a.get("focusSwitchCount") or 0)
            today_away_sec += float(a.get("awayElapsedSec") or 0.0)

    by_dlpfc: dict[str, Any] = {}
    by_course_tier: dict[str, Any] = {}
    for k, arr in g_course.items():
        by_course[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_course_tier.items():
        by_course_tier[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_topic.items():
        by_topic[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_kind.items():
        by_kind[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_prof.items():
        by_profile[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_slot.items():
        by_time_slot[k] = aggregate_attempt_group(arr, avg_focus_density)
    for k, arr in g_dlpfc.items():
        by_dlpfc[k] = aggregate_attempt_group(arr, avg_focus_density)

    today_high_min = round(today_dlpfc_sec[3] / 60.0, 1)
    today_med_min = round(today_dlpfc_sec[2] / 60.0, 1)
    today_low_min = round(today_dlpfc_sec[1] / 60.0, 1)
    rec_mode, rec_reason = circadian_dlpfc_target(now.hour, today_high_min)
    dlpfc_budget = {
        "todayHighMinutes": today_high_min,
        "todayMedMinutes": today_med_min,
        "todayLowMinutes": today_low_min,
        "dailyHighCapMinutes": HIGH_DLPFC_DAILY_CAP_MIN,
        "remainingHighMinutes": round(max(0.0, HIGH_DLPFC_DAILY_CAP_MIN - today_high_min), 1),
        "todayFocusSwitches": today_focus_switches,
        "todayAwayMinutes": round(today_away_sec / 60.0, 1),
        "recommendedCircadianMode": rec_mode,
        "recommendedRationale": rec_reason,
    }

    # Course completion & FSRS due counts
    course_progress: dict[str, Any] = {}
    weak_topics: list[dict[str, Any]] = []

    for cid, bank in courses_by_id.items():
        qs = [q for q in bank.get("questions", []) if q.get("available", True)]
        by_tier = {
            "1": {"total": 0, "done": 0, "revisit": 0, "in_progress": 0, "dueFsrs": 0},
            "2": {"total": 0, "done": 0, "revisit": 0, "in_progress": 0, "dueFsrs": 0},
            "3": {"total": 0, "done": 0, "revisit": 0, "in_progress": 0, "dueFsrs": 0},
        }
        counts: dict[str, Any] = {"total": len(qs), "not_started": 0, "in_progress": 0, "done": 0, "revisit": 0, "dueFsrs": 0, "beatAiItems": 0, "byTier": by_tier}
        topic_titles = {str(t["id"]): t["title"] for t in bank.get("topics") or []}
        topic_revisit: dict[str, int] = {}

        for q in qs:
            rec = records.get(q["id"]) or {}
            st = rec.get("status") or "not_started"
            t_key_str = str(min(3, max(1, int(q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]))))
            tb = by_tier[t_key_str]
            tb["total"] += 1
            counts[st if st in counts else "not_started"] += 1
            if st in tb:
                tb[st] += 1
            if (rec.get("beatAiCount") or 0) > 0:
                counts["beatAiItems"] += 1
            fsrs = rec.get("fsrs") or {}
            if fsrs.get("due") and fsrs["due"] <= now_iso and st in ("done", "revisit"):
                counts["dueFsrs"] += 1
                tb["dueFsrs"] += 1
            if st == "revisit":
                tid = str(q.get("topicId") or "")
                topic_revisit[tid] = topic_revisit.get(tid, 0) + 1

        course_progress[cid] = counts
        for tid, rev_n in topic_revisit.items():
            t_key = f"{cid}:{tid}"
            tm = by_topic.get(t_key) or {}
            weak_topics.append(
                {
                    "courseId": cid,
                    "courseTitle": bank.get("shortTitle") or bank.get("title"),
                    "topicId": tid,
                    "topicTitle": topic_titles.get(tid, f"Topic {tid}"),
                    "revisitCount": rev_n,
                    "avgAccuracy": tm.get("avgAccuracy"),
                    "upi": tm.get("upi"),
                }
            )

    weak_topics.sort(key=lambda w: (-w["revisitCount"], w["avgAccuracy"] if w["avgAccuracy"] is not None else 1.0))

    # Active day streak & XP
    active_days: set[str] = set()
    for a in attempts:
        ts = str(a.get("timestamp") or "")
        if len(ts) >= 10:
            active_days.add(ts[:10])
    for s in sessions:
        ts = str(s.get("endedAt") or "")
        if len(ts) >= 10:
            active_days.add(ts[:10])

    streak = 0
    cursor = now.date()
    if cursor.strftime("%Y-%m-%d") not in active_days:
        cursor = cursor - timedelta(days=1)
    while cursor.strftime("%Y-%m-%d") in active_days:
        streak += 1
        cursor = cursor - timedelta(days=1)

    # XP: +15 per verified attempt + +10 bonus for Accuracy-Gated Beat-AI + +25 per logged check-in session
    total_xp = (
        len(attempts) * 15
        + sum(10 for a in attempts if a.get("beatAi"))
        + len(sessions) * 25
    )

    correlations = compute_correlations(sessions)

    def _oslo_day(ts_val: Any) -> str:
        raw = str(ts_val or "")
        if not raw:
            return ""
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(OSLO_TZ).strftime("%Y-%m-%d")
        except Exception:
            return raw[:10] if len(raw) >= 10 else ""

    def _attempt_tier(a_item: dict[str, Any]) -> int:
        raw_t = a_item.get("dlpfcTier")
        if raw_t in (1, 2, 3):
            return int(raw_t)
        q_o = q_lookup.get(str(a_item.get("questionId") or ""))
        return classify_intrinsic_dlpfc(q_o)[0] if q_o else (1 if a_item.get("kind") == "mcq" else 2)

    def _adj_units(a_item: dict[str, Any]) -> float:
        tier = _attempt_tier(a_item)
        tier_w = 1.35 if tier == 3 else (0.75 if tier == 1 else 1.0)
        par_sec = max(45.0, float(a_item.get("aiParSec") or a_item.get("parSec") or (90 if a_item.get("kind") == "mcq" else 300)))
        q_acc = clamp(float(a_item.get("qualityAccuracy", 0.8)), 0.3, 1.0)
        return (par_sec / 180.0) * tier_w * q_acc

    last7_days_set = {(now.date() - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)}
    prev7_days_set = {(now.date() - timedelta(days=i + 7)).strftime("%Y-%m-%d") for i in range(7)}
    last7_atts = [a for a in attempts if _oslo_day(a.get("timestamp")) in last7_days_set]
    prev7_atts = [a for a in attempts if _oslo_day(a.get("timestamp")) in prev7_days_set]
    prev_7d = aggregate_attempt_group(prev7_atts, avg_focus_density)
    last_7d = {
        **last_7d,
        "prev7Upi": prev_7d.get("upi"),
        "attempts": len(last7_atts),
        "adjustedUnits": round(sum(_adj_units(a) for a in last7_atts), 1),
        "prevAdjustedUnits": round(sum(_adj_units(a) for a in prev7_atts), 1),
    }

    # Oslo daily series (last 14+ days)
    day_buckets: dict[str, dict[str, Any]] = {}

    def _ensure_day(dk: str) -> dict[str, Any]:
        row = day_buckets.get(dk)
        if row is None:
            row = {
                "day": dk,
                "isToday": dk == today_str,
                "activeSec": 0.0,
                "highSec": 0.0,
                "medSec": 0.0,
                "lowSec": 0.0,
                "awaySec": 0.0,
                "sessActiveSec": 0.0,
                "attempts": [],
                "adjustedUnits": 0.0,
                "byCourseSec": {},
            }
            day_buckets[dk] = row
        return row

    for i in range(13, -1, -1):
        _ensure_day((now.date() - timedelta(days=i)).strftime("%Y-%m-%d"))

    for a in attempts:
        dk = _oslo_day(a.get("timestamp"))
        if not dk:
            continue
        dr = _ensure_day(dk)
        sec = max(0.0, float(a.get("activeSec") or 0.0))
        tier = _attempt_tier(a)
        cid = str(a.get("courseId") or "")
        dr["attempts"].append(a)
        dr["activeSec"] += sec
        if tier == 3:
            dr["highSec"] += sec
        elif tier == 1:
            dr["lowSec"] += sec
        else:
            dr["medSec"] += sec
        dr["adjustedUnits"] += _adj_units(a)
        if cid:
            dr["byCourseSec"][cid] = dr["byCourseSec"].get(cid, 0.0) + sec

    for s in sessions:
        dk = _oslo_day(s.get("endedAt") or s.get("startedAt"))
        if not dk:
            continue
        dr = _ensure_day(dk)
        dr["sessActiveSec"] += max(0.0, float(s.get("activeSec") or 0.0))
        dr["awaySec"] += max(0.0, float(s.get("awaySec") or 0.0))

    daily_series: list[dict[str, Any]] = []
    for dk in sorted(day_buckets.keys())[-60:]:
        dr = day_buckets[dk]
        eff_active = max(dr["activeSec"], min(dr["sessActiveSec"], dr["activeSec"] + 1800.0))
        active_min = round(eff_active / 60.0, 1)
        off_min = round(dr["awaySec"] / 60.0, 1)
        screen_min = round((eff_active + dr["awaySec"]) / 60.0, 1)
        eff_pct = min(100, round((active_min / screen_min) * 100)) if screen_min > 0.5 else None
        arr = dr["attempts"]
        grp = aggregate_attempt_group(arr, avg_focus_density) if arr else {}
        daily_series.append(
            {
                "day": dk,
                "isToday": dr["isToday"],
                "activeMin": active_min,
                "highMin": round(dr["highSec"] / 60.0, 1),
                "medMin": round(dr["medSec"] / 60.0, 1),
                "lowMin": round(dr["lowSec"] / 60.0, 1),
                "screenMin": screen_min,
                "offScreenMin": off_min,
                "efficiencyPct": eff_pct,
                "attempts": len(arr),
                "adjustedUnits": round(dr["adjustedUnits"], 1),
                "avgPaceRatio": grp.get("avgPaceRatio"),
                "upi": grp.get("upi"),
                "accuracyPct": round(grp["avgAccuracy"] * 100) if grp.get("avgAccuracy") is not None else None,
                "byCourseMin": {k: round(v / 60.0, 1) for k, v in dr["byCourseSec"].items()},
            }
        )

    # Topic coverage & Hours Worked vs Exact 1.0x AI-Par Exam Target
    topic_matrix: dict[str, list[dict[str, Any]]] = {}
    for cid, bank in courses_by_id.items():
        qs = [q for q in bank.get("questions", []) if q.get("available", True)]
        by_tid_qs: dict[str, list[dict[str, Any]]] = {}
        for q in qs:
            by_tid_qs.setdefault(str(q.get("topicId") or "general"), []).append(q)
        rows_for_course: list[dict[str, Any]] = []
        for idx_t, t in enumerate(bank.get("topics") or []):
            tid = str(t.get("id") or "")
            t_qs = by_tid_qs.get(tid) or []
            if not t_qs:
                continue
            par_min_sum = 0.0
            for q in t_qs:
                pacing = q.get("pacing") or {}
                learn_t = (pacing.get("learning") or {}).get("target")
                par_min_sum += float(learn_t) if isinstance(learn_t, (int, float)) and learn_t > 0 else (2.0 if q.get("kind") == "mcq" else 6.0)
            recommended_min = max(15, round(par_min_sum))
            t_atts = g_topic.get(f"{cid}:{tid}") or []
            att_qids = {str(a.get("questionId") or "") for a in t_atts}
            att_sec = sum(max(0.0, float(a.get("activeSec") or 0.0)) for a in t_atts)
            done_n = 0
            rev_n = 0
            credit_min = 0.0
            avg_q_par = par_min_sum / max(1, len(t_qs))
            for q in t_qs:
                rec = records.get(q["id"]) or {}
                st = rec.get("status") or ""
                if st == "done":
                    done_n += 1
                    if q["id"] not in att_qids:
                        credit_min += avg_q_par * 0.85
                elif st == "revisit":
                    rev_n += 1
            worked_min = round(att_sec / 60.0 + credit_min, 1)
            ratio = worked_min / recommended_min if recommended_min > 0 else 0.0
            cov_pct = min(100, round((done_n / max(1, len(t_qs))) * 100))
            tm = by_topic.get(f"{cid}:{tid}") or {}
            avg_acc = tm.get("avgAccuracy")
            status = (
                "ready"
                if (ratio >= 0.72 or cov_pct >= 75) and (avg_acc is None or avg_acc >= 0.72) and rev_n <= 1
                else ("building" if (ratio >= 0.30 or cov_pct >= 30) else "lacking")
            )
            rows_for_course.append(
                {
                    "id": tid,
                    "order": idx_t,
                    "title": t.get("title") or f"Topic {tid}",
                    "workedMin": worked_min,
                    "recommendedMin": recommended_min,
                    "ratioToPar": round(ratio, 3),
                    "doneCount": done_n,
                    "totalCount": len(t_qs),
                    "revisitCount": rev_n,
                    "coveragePct": cov_pct,
                    "avgPaceRatio": tm.get("avgPaceRatio"),
                    "avgAccuracy": avg_acc,
                    "status": status,
                }
            )
        if rows_for_course:
            topic_matrix[cid] = rows_for_course

    summary = {
        "generatedAt": now_iso,
        "streakDays": streak,
        "totalXp": total_xp,
        "totalAttempts": len(attempts),
        "totalSessions": len(sessions),
        "overall": overall,
        "last7Days": last_7d,
        "today": today_metrics,
        "dlpfcBudget": dlpfc_budget,
        "courseProgress": course_progress,
        "subgroups": {
            "byCourse": by_course,
            "byCourseTier": by_course_tier,
            "byTopic": by_topic,
            "byKind": by_kind,
            "byProfile": by_profile,
            "byTimeSlot": by_time_slot,
            "byDlpfcTier": by_dlpfc,
        },
        "dailySeries": daily_series,
        "topicMatrix": topic_matrix,
        "weakTopics": weak_topics[:12],
        "correlations": correlations,
    }

    # Persist compact AI snapshot so LLM agents can read 1 small file for complete study context!
    snap_path = study_os_root / "data" / "logs" / "ai_context_snapshot.json"
    snap_path.parent.mkdir(parents=True, exist_ok=True)
    snap_payload = {
        **summary,
        "recentSessions": sessions[-10:],
    }
    tmp = snap_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(snap_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(snap_path)

    return summary
