"""Neuroscience-grounded dlPFC Cognitive Control Load Classifier & Circadian Router.

Models prefrontal glutamate accumulation (Wiehler et al., 2022; Xia & Soutschek et al., 2026)
and basal-ganglia / parietal procedural chunking across 3 cognitive tiers:
  - Tier 3 (`high` / `synthesis`): Unseen multi-variable derivations, proofs, multi-part FLOWmulti
    statements, architectural coding, and complex multi-theory case synthesis (08:00–15:00, <=4.5h/day cap).
  - Tier 2 (`med` / `procedural`): Standard single-method calculation drills, quantitative MCQs,
    debugging/foundational coding, and *previously mastered* Tier-3 problems shifting into speed/automaticity
    drills (15:00–18:00).
  - Tier 1 (`low` / `recall`): Fast conceptual recognition MCQs, short reading/definition checks,
    and consolidated FSRS spaced-repetition reviews (18:00+ evening wind-down).
"""
from __future__ import annotations

import math
import re
from typing import Any

HIGH_DLPFC_DAILY_CAP_MIN = 270.0  # 4.5 hours/day max-intensity novel dlPFC budget

_QUANT_RE = re.compile(
    r"\$[^$]+\$|\b\d+(?:\.\d+)?%|\bcalculate\b|\bcompute\b|\bprofit\b|\bequilibrium\b|\bderivative\b|\bnpv\b|\belasticity\b",
    re.I,
)


def _safe_int(val: Any, default: int) -> int:
    if isinstance(val, bool) or val is None:
        return default
    try:
        f = float(val)
        if not math.isfinite(f):
            return default
        return int(f)
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_float(val: Any, default: float) -> float:
    if isinstance(val, bool) or val is None:
        return default
    try:
        f = float(val)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError, OverflowError):
        return default


def classify_intrinsic_dlpfc(q: dict[str, Any]) -> tuple[int, str]:
    """Determines intrinsic `(dlpfcBase, cognitiveType)` for an unchunked question."""
    if not isinstance(q, dict):
        return 2, "procedural"
    cid = str(q.get("courseId") or "")
    kind = str(q.get("kind") or "mcq")
    diff = _safe_int(q.get("difficulty"), 2)
    pacing = q.get("pacing") if isinstance(q.get("pacing"), dict) else {}
    learning = pacing.get("learning") if isinstance(pacing.get("learning"), dict) else {}
    default_target = 4.0 if kind == "mcq" else 12.0
    raw_target = _safe_float(learning.get("target"), 0.0)
    target = raw_target if raw_target > 0 else default_target
    raw_wf = q.get("wiseflowFields")
    wf = len(raw_wf) if isinstance(raw_wf, (list, tuple)) else 0
    pts = _safe_float(q.get("points"), 0.0)
    prompt = f"{q.get('promptMarkdown') or ''} {q.get('contextMarkdown') or ''}"
    col = str(q.get("collectionId") or "")

    if kind == "mcq":
        has_math = bool(_QUANT_RE.search(prompt))
        if cid == "ob-2537":
            if len(prompt) >= 430 and diff >= 3:
                return 3, "synthesis"
            if diff >= 2 and len(prompt) >= 190:
                return 2, "procedural"
            return 1, "recall"
        if target >= 6.5 or (has_math and diff >= 2):
            return 2, "procedural"
        return 1, "recall"

    if cid == "acct-2527":
        if wf >= 4 or pts >= 20 or diff >= 3 or target >= 25.0:
            return 3, "synthesis"
        if kind == "calculation" or target >= 10.0:
            return 2, "procedural"
        return 1, "recall"

    if cid == "econ-2522":
        if col == "SYN-CASE" or diff >= 3 or target >= 18.0:
            return 3, "synthesis"
        if target >= 8.0 or kind == "calculation":
            return 2, "procedural"
        return 1, "recall"

    if cid == "math-2588":
        if diff >= 3 or target >= 15.0:
            return 3, "synthesis"
        if diff <= 1 or target <= 4.0:
            return 1, "recall"
        return 2, "procedural"

    if cid == "ob-2537":
        return 3, "synthesis"

    if cid == "prog-3021":
        if diff >= 3 or target >= 16.0:
            return 3, "synthesis"
        return 2, "procedural"

    if diff >= 3 or target >= 18.0 or wf >= 4:
        return 3, "synthesis"
    if kind != "mcq" and target >= 8.0:
        return 2, "procedural"
    return 1, "recall"


def effective_dlpfc_tier(q: dict[str, Any], rec: dict[str, Any] | None = None) -> tuple[int, bool]:
    """Computes live student-specific `(effectiveTier, isChunkedStepdown)`.

    - Struggle / revisit / FSRS lapse escalates load because schema repair recruits executive control.
    - Clean mastery (`done`, `lastGrade >= 3`) steps a `High-dlPFC` item down into `Med-dlPFC`
      procedural speed-drilling, and multi-rep consolidated items (`reps >= 2`, `stability >= 5d`)
      down into `Low-dlPFC` spaced recall.
    """
    if not isinstance(q, dict):
        return 2, False
    raw_base = q.get("dlpfcBase")
    base = int(raw_base) if (not isinstance(raw_base, bool) and raw_base in (1, 2, 3)) else classify_intrinsic_dlpfc(q)[0]
    if not isinstance(rec, dict) or not rec:
        return base, False

    status = str(rec.get("status") or "not_started")
    p_diff = _safe_int(rec.get("personalDifficulty"), 0)
    raw_fsrs = rec.get("fsrs")
    fsrs = raw_fsrs if isinstance(raw_fsrs, dict) else {}
    raw_last_g = fsrs.get("lastGrade")
    last_g = _safe_int(raw_last_g, -1) if raw_last_g is not None else None
    if last_g == -1:
        last_g = None
    reps = max(0, _safe_int(fsrs.get("reps"), 0))
    stab = max(0.0, _safe_float(fsrs.get("stability"), 0.0))

    if p_diff == 3 or status == "revisit" or last_g == 1:
        escalated = min(3, max(base, 2 if q.get("kind") == "mcq" else 3))
        return escalated, False

    if status == "done" and (last_g is None or last_g >= 3):
        if p_diff == 1 or (reps >= 2 and stab >= 5.0):
            return 1, base > 1
        if base == 3 and reps >= 1:
            return 2, True

    return base, False


def circadian_dlpfc_target(hour: int, today_high_dlpfc_min: float = 0.0) -> tuple[str, str]:
    """Returns `(modeKey, shortRationale)` for a given local hour (`0..23`) and daily High-dlPFC usage."""
    hr = _safe_float(hour, -1.0)
    used = max(0.0, _safe_float(today_high_dlpfc_min, 0.0))
    if 6 <= hr < 15:
        if used >= HIGH_DLPFC_DAILY_CAP_MIN:
            return (
                "med_dlpfc",
                f"4.5h High-dlPFC cap reached ({used / 60.0:.1f}h) · Procedural Downshift",
            )
        return ("high_dlpfc", "08:00–15:00 Peak Capacity · High-dlPFC Novel Synthesis")
    if 15 <= hr < 18:
        return ("med_dlpfc", "15:00–18:00 Afternoon Downshift · Med-dlPFC Procedural Drills")
    return ("low_dlpfc", "Evening Wind-Down · Low-dlPFC Recall & Spaced Review")
