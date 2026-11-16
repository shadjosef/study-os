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


def compute_attempt_metrics(
    active_sec: float,
    ai_par_sec: float,
    hints_used: int,
    hint_handicap_sec: float,
    quality_accuracy: float,
    assisted: bool = False,
) -> dict[str, Any]:
    """Accuracy-Gated & Zero-Hint 'Beat the AI' scoring.

    - Beating AI Par ONLY counts when quality_accuracy >= 0.85, hints_used == 0, and assisted is False!
    - Rushing wrong answers or peeking hints/solutions yields 0 Beat-AI credit.
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
        raw_ratio = clamp(par / max(effective_sec, 0.25 * par), 0.35, 1.50)
        pace_ratio = round(raw_ratio * q, 3)
        beat_ai = bool(q >= 0.85 and int(hints_used) == 0 and (not assisted) and effective_sec <= par)

    # Single-question UPI preview (assuming 0.90 focus density while actively answering)
    item_upi = round(100.0 * (0.45 * q + 0.35 * min(pace_ratio, 1.35) + 0.20 * 0.90))

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
    avg_pr = sum(min(1.35, float(a.get("paceRatio", 0.0))) for a in attempts) / n
    beat_rate = sum(1 for a in attempts if a.get("beatAi")) / n
    avg_delta = sum(float(a.get("deltaSec", 0.0)) for a in attempts) / n
    tot_min = sum(float(a.get("activeSec", 0.0)) for a in attempts) / 60.0
    upi = round(100.0 * (0.45 * avg_q + 0.35 * avg_pr + 0.20 * clamp(focus_density, 0.0, 1.0)))
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
    for k, arr in g_course.items():
        by_course[k] = aggregate_attempt_group(arr, avg_focus_density)
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
        counts = {"total": len(qs), "not_started": 0, "in_progress": 0, "done": 0, "revisit": 0, "dueFsrs": 0, "beatAiItems": 0}
        topic_titles = {str(t["id"]): t["title"] for t in bank.get("topics") or []}
        topic_revisit: dict[str, int] = {}

        for q in qs:
            rec = records.get(q["id"]) or {}
            st = rec.get("status") or "not_started"
            counts[st if st in counts else "not_started"] += 1
            if (rec.get("beatAiCount") or 0) > 0:
                counts["beatAiItems"] += 1
            fsrs = rec.get("fsrs") or {}
            if fsrs.get("due") and fsrs["due"] <= now_iso and st in ("done", "revisit"):
                counts["dueFsrs"] += 1
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
            "byTopic": by_topic,
            "byKind": by_kind,
            "byProfile": by_profile,
            "byTimeSlot": by_time_slot,
            "byDlpfcTier": by_dlpfc,
        },
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
