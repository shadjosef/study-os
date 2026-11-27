"""Comprehensive zero-dependency Python unit & integration test suite for Study-OS.

Runs strictly on Python 3.9-3.12+ stdlib (`python3 -m unittest discover -s tests/python -v`).
All filesystem & HTTP tests run inside isolated `tempfile.TemporaryDirectory()` sandboxes
and NEVER read from or write to live `data/state/progress.json` or `data/logs/*`.
"""
from __future__ import annotations

import base64
import contextlib
from datetime import datetime, timedelta, timezone
import gzip
import http.client
from http.server import ThreadingHTTPServer
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse
from zipfile import ZipFile
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
APP_DIR = REPO_ROOT / "app"
TOOLS_DIR = REPO_ROOT / "tools"
for _p in (str(APP_DIR), str(TOOLS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import analytics  # noqa: E402
import calendar_sync  # noqa: E402
from canvas_browser import CanvasBrowser  # noqa: E402
import dlpfc  # noqa: E402
import server as study_server  # noqa: E402
import study_os_mcp  # noqa: E402
import timetable_planner  # noqa: E402
from tutor_bridge import LiveTutor  # noqa: E402

OSLO_TZ = ZoneInfo("Europe/Oslo")


def _sample_course_bank(course_id: str = "econ-2522", code: str = "EXC 3420") -> dict:
    return {
        "courseId": course_id,
        "canvasId": "2522",
        "code": code,
        "title": "Economics I",
        "shortTitle": "Economics",
        "semester": "Autumn 2026",
        "examInfo": {"date": "2026-12-15"},
        "topics": [
            {"id": "1", "title": "Capitalist Revolution", "keywords": ["marginal product", "capitalist"]},
            {"id": "3", "title": "Preferences & MRS", "keywords": ["mrs", "indifference", "budget line"]},
        ],
        "collections": [{"id": "SET-1", "title": "Core Drills"}],
        "questions": [
            {
                "id": f"{course_id}:q1",
                "courseId": course_id,
                "topicId": "1",
                "collectionId": "SET-1",
                "origin": "lecture",
                "kind": "mcq",
                "difficulty": 1,
                "title": "Marginal Product Definition",
                "promptMarkdown": "Define marginal product of labor.",
                "hints": ["Think about the derivative."],
                "solutionMarkdown": "Slope of the production function.",
                "pacing": {"learning": {"target": 2.0}, "exam": {"target": 1.5}},
                "available": True,
            },
            {
                "id": f"{course_id}:q2",
                "courseId": course_id,
                "topicId": "3",
                "collectionId": "SET-1",
                "origin": "exam",
                "kind": "calculation",
                "difficulty": 3,
                "title": "Constrained Utility Optimization",
                "promptMarkdown": "Calculate MRS and optimal bundle given $U(x,y)=x^{0.5}y^{0.5}$.",
                "hints": ["Set MRS equal to the price ratio."],
                "solutionMarkdown": "x* = m / (2p_x).",
                "pacing": {"learning": {"target": 18.0}, "exam": {"target": 14.0}},
                "available": True,
            },
            {
                "id": f"{course_id}:q3",
                "courseId": course_id,
                "topicId": "3",
                "collectionId": "SET-1",
                "origin": "exam",
                "kind": "calculation",
                "difficulty": 2,
                "title": "Budget Line Slope",
                "promptMarkdown": "Compute the slope of the budget line.",
                "hints": ["Use -p_x / p_y."],
                "solutionMarkdown": "-p_x / p_y.",
                "pacing": {"learning": {"target": 10.0}, "exam": {"target": 8.0}},
                "available": True,
            },
        ],
    }


def _sample_acct_bank() -> dict:
    return {
        "courseId": "acct-2527",
        "canvasId": "2527",
        "code": "EXC 3430",
        "title": "Fundamentals of Accounting",
        "shortTitle": "Accounting",
        "semester": "Autumn 2026",
        "examInfo": {"date": "2026-12-10"},
        "topics": [{"id": "10", "title": "Investment Appraisal & NPV", "keywords": ["npv", "irr"]}],
        "collections": [],
        "questions": [
            {
                "id": "acct-2527:npv1",
                "courseId": "acct-2527",
                "topicId": "10",
                "origin": "exam",
                "kind": "wiseflow",
                "difficulty": 3,
                "title": "NPV Multi-Part Sheet",
                "promptMarkdown": "Calculate NPV and IRR for the project.",
                "hints": ["Discount each cash flow."],
                "solutionMarkdown": "NPV = 16,528.93.",
                "wiseflowFields": [
                    {"id": "f1", "label": "CF0", "type": "number", "expected": -200000},
                    {"id": "f2", "label": "PV", "type": "number", "expected": 216528.93},
                    {"id": "f3", "label": "NPV", "type": "number", "expected": 16528.93},
                    {"id": "f4", "label": "Decision", "type": "choice", "options": ["Accept", "Reject"], "answerIndex": 0},
                ],
                "pacing": {"learning": {"target": 26.0}, "exam": {"target": 20.0}},
                "available": True,
            }
        ],
    }


# =============================================================================
# 1. FSRS-5 Math & Cross-Language Parity (Python analytics.py vs JS fsrs.js)
# =============================================================================
class TestFsrs5AndParity(unittest.TestCase):
    def setUp(self) -> None:
        self.base_dt = datetime(2026, 5, 1, 10, 0, 0, tzinfo=timezone.utc)

    def test_first_review_initialization_all_grades(self) -> None:
        again = analytics.update_fsrs_card(None, 1, self.base_dt)
        hard = analytics.update_fsrs_card(None, 2, self.base_dt)
        good = analytics.update_fsrs_card(None, 3, self.base_dt)
        easy = analytics.update_fsrs_card(None, 4, self.base_dt)

        self.assertEqual(again["stability"], 0.4)
        self.assertEqual(again["difficulty"], 6.8)
        self.assertEqual(again["reps"], 1)
        self.assertEqual(again["lapses"], 1)

        self.assertEqual(hard["stability"], 1.2)
        self.assertEqual(hard["difficulty"], 5.7)
        self.assertEqual(good["stability"], 3.2)
        self.assertEqual(good["difficulty"], 4.6)
        self.assertEqual(easy["stability"], 7.5)
        self.assertEqual(easy["difficulty"], 3.5)
        self.assertEqual(easy["lapses"], 0)

        # Verify due offset for Again (0.02 days) vs Good (3.2 days)
        again_due = datetime.fromisoformat(again["due"])
        good_due = datetime.fromisoformat(good["due"])
        self.assertAlmostEqual((again_due - self.base_dt).total_seconds(), 0.02 * 86400, places=2)
        self.assertAlmostEqual((good_due - self.base_dt).total_seconds(), 3.2 * 86400, places=2)

    def test_subsequent_reviews_growth_and_lapse_reset(self) -> None:
        first = analytics.update_fsrs_card(None, 3, self.base_dt)
        later = self.base_dt + timedelta(days=3)

        again = analytics.update_fsrs_card(first, 1, later)
        hard = analytics.update_fsrs_card(first, 2, later)
        good = analytics.update_fsrs_card(first, 3, later)
        easy = analytics.update_fsrs_card(first, 4, later)

        self.assertEqual(again["reps"], 2)
        self.assertEqual(again["lapses"], 1)
        self.assertLess(again["stability"], first["stability"])
        again_due = datetime.fromisoformat(again["due"])
        self.assertAlmostEqual((again_due - later).total_seconds(), 0.04 * 86400, places=2)

        self.assertGreater(hard["stability"], first["stability"])
        self.assertGreater(good["stability"], hard["stability"])
        self.assertGreater(easy["stability"], good["stability"])

    def test_stability_caps_at_365_and_difficulty_clamps_1_to_10(self) -> None:
        card = analytics.update_fsrs_card(None, 4, self.base_dt)
        clock = self.base_dt
        for _ in range(14):
            clock += timedelta(days=card["stability"])
            card = analytics.update_fsrs_card(card, 4, clock)
        self.assertLessEqual(card["stability"], 365.0)
        self.assertEqual(card["stability"], 365.0)
        self.assertGreaterEqual(card["difficulty"], 1.0)
        self.assertLessEqual(card["difficulty"], 10.0)

        # Repeated lapses must keep difficulty <= 10.0 and stability >= 0.3
        hard_card = analytics.update_fsrs_card(None, 1, self.base_dt)
        for step in range(12):
            hard_card = analytics.update_fsrs_card(hard_card, 1, self.base_dt + timedelta(days=step + 1))
        self.assertGreaterEqual(hard_card["difficulty"], 1.0)
        self.assertLessEqual(hard_card["difficulty"], 10.0)
        self.assertGreaterEqual(hard_card["stability"], 0.3)

    def test_edge_and_malformed_inputs_fail_safe(self) -> None:
        # UTC 'Z' suffix timestamp, negative/NaN stability, out-of-range grades, naive now
        prev = {
            "reps": 2,
            "stability": -5.0,
            "difficulty": float("nan"),
            "lapses": 0,
            "lastReview": "2026-05-01T10:00:00.000Z",
        }
        nxt = analytics.update_fsrs_card(prev, 99, datetime(2026, 5, 4, 10, 0, 0))
        self.assertEqual(nxt["reps"], 3)
        self.assertEqual(nxt["lastGrade"], 4)
        self.assertTrue(math.isfinite(nxt["stability"]) and nxt["stability"] > 0)
        self.assertTrue(1.0 <= nxt["difficulty"] <= 10.0)

        bad_ts = analytics.update_fsrs_card({"reps": 1, "stability": 3.0, "difficulty": 5.0, "lastReview": "garbage"}, 3, self.base_dt)
        self.assertEqual(bad_ts["reps"], 2)
        self.assertGreater(bad_ts["stability"], 3.0)

    def test_cross_language_parity_with_js_fsrs_module(self) -> None:
        node_bin = shutil.which("node")
        if not node_bin:
            self.skipTest("node runtime not installed")

        fsrs_js_path = REPO_ROOT / "app" / "public" / "js" / "core" / "fsrs.js"
        self.assertTrue(fsrs_js_path.is_file(), "Expected app/public/js/core/fsrs.js to exist")

        # Multi-step review scenarios covering init, growth, hard/good/easy, lapse, recovery, and 365d cap
        trajectories = [
            [(0.0, 1), (0.04, 2), (1.2, 3), (4.0, 3), (12.0, 4), (40.0, 4), (120.0, 4), (250.0, 4), (365.0, 4)],
            [(0.0, 3), (3.2, 3), (10.0, 1), (0.1, 2), (2.0, 3), (7.5, 4)],
            [(0.0, 2), (1.0, 2), (2.5, 2), (6.0, 3)],
            [(0.0, 4), (7.5, 4), (30.0, 4), (110.0, 4), (365.0, 1), (1.0, 3)],
        ]

        py_results = []
        base_ms = int(self.base_dt.timestamp() * 1000)
        for traj in trajectories:
            card = None
            clock = self.base_dt
            traj_out = []
            for delta_days, grade in traj:
                clock = clock + timedelta(days=delta_days)
                card = analytics.update_fsrs_card(card, grade, clock)
                traj_out.append(
                    {
                        "stability": card["stability"],
                        "difficulty": card["difficulty"],
                        "reps": card["reps"],
                        "lapses": card["lapses"],
                        "lastGrade": card["lastGrade"],
                        "dueMs": round(datetime.fromisoformat(card["due"]).timestamp() * 1000),
                    }
                )
            py_results.append(traj_out)

        node_script = """
const fsrs = require(process.argv[1]);
const trajectories = JSON.parse(process.argv[2]);
const baseMs = Number(process.argv[3]);
const out = trajectories.map((traj) => {
  let card = null;
  let clock = baseMs;
  return traj.map(([deltaDays, grade]) => {
    clock += deltaDays * fsrs.MS_PER_DAY;
    card = fsrs.updateFsrs5Card(card, grade, clock);
    return {
      stability: card.stability,
      difficulty: card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      lastGrade: card.lastGrade,
      dueMs: Date.parse(card.due),
    };
  });
});
process.stdout.write(JSON.stringify(out));
"""
        proc = subprocess.run(
            [node_bin, "-e", node_script, str(fsrs_js_path), json.dumps(trajectories), str(base_ms)],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        js_results = json.loads(proc.stdout)

        self.assertEqual(len(py_results), len(js_results))
        for t_idx, (py_traj, js_traj) in enumerate(zip(py_results, js_results)):
            for s_idx, (py_step, js_step) in enumerate(zip(py_traj, js_traj)):
                msg = f"Mismatch at trajectory {t_idx} step {s_idx}: py={py_step} vs js={js_step}"
                self.assertAlmostEqual(py_step["stability"], js_step["stability"], places=2, msg=msg)
                self.assertAlmostEqual(py_step["difficulty"], js_step["difficulty"], places=2, msg=msg)
                self.assertEqual(py_step["reps"], js_step["reps"], msg=msg)
                self.assertEqual(py_step["lapses"], js_step["lapses"], msg=msg)
                self.assertEqual(py_step["lastGrade"], js_step["lastGrade"], msg=msg)
                # Due timestamps match within 1s (sub-ms floating point rounding in JS Date vs Python timedelta)
                self.assertLessEqual(abs(py_step["dueMs"] - js_step["dueMs"]), 1000, msg=msg)

        # Also cross-check suggestFsrsGrade parity
        metric_cases = [
            (60, 120, 0, 30, 0.45, False),
            (60, 120, 1, 30, 0.95, False),
            (60, 120, 0, 30, 0.95, True),
            (180, 120, 0, 30, 0.95, False),
            (110, 120, 0, 30, 0.92, False),
            (90, 120, 0, 30, 1.0, False),
        ]
        py_grades = [
            analytics.compute_attempt_metrics(a, p, h, hh, q, assisted=asst)
            for a, p, h, hh, q, asst in metric_cases
        ]
        grade_script = """
const fsrs = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(cases.map((c) => fsrs.suggestFsrsGrade(c))));
"""
        js_grade_inputs = [
            {
                "qualityAccuracy": m["qualityAccuracy"],
                "effectiveSec": m["effectiveSec"],
                "aiParSec": m["aiParSec"],
                "hintsUsed": case[2],
                "assisted": case[5],
                "beatAi": m["beatAi"],
            }
            for case, m in zip(metric_cases, py_grades)
        ]
        proc2 = subprocess.run(
            [node_bin, "-e", grade_script, str(fsrs_js_path), json.dumps(js_grade_inputs)],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        js_grades = json.loads(proc2.stdout)
        self.assertEqual([m["suggestedFsrsGrade"] for m in py_grades], js_grades)

        # Also cross-check schedule.js study-budget & circadian parity
        schedule_js_path = REPO_ROOT / "app" / "public" / "js" / "core" / "schedule.js"
        if schedule_js_path.is_file():
            budget_cases = [(0, 8, 4), (6, 8, 4), (16, 8, 4), (50, 10, 4), (0, 0, 8)]
            py_budgets = [
                timetable_planner.estimate_recommended_study_hours(w, c, n)
                for w, c, n in budget_cases
            ]
            sched_script = """
const sched = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(cases.map(([w, c, n]) => sched.computeClientStudyEstimate(w, c, n))));
"""
            proc3 = subprocess.run(
                [node_bin, "-e", sched_script, str(schedule_js_path), json.dumps(budget_cases)],
                capture_output=True,
                text=True,
                check=True,
                timeout=15,
            )
            js_budgets = json.loads(proc3.stdout)
            self.assertEqual(py_budgets, js_budgets)


# =============================================================================
# 2. Analytics, UPI, Readiness, Streaks & Correlations
# =============================================================================
class TestAnalytics(unittest.TestCase):
    def test_compute_attempt_metrics_accuracy_gated_and_closed_book(self) -> None:
        # Clean fast mastery beats AI par and suggests Easy (4)
        fast = analytics.compute_attempt_metrics(
            active_sec=90, ai_par_sec=120, hints_used=0, hint_handicap_sec=30,
            quality_accuracy=1.0, assisted=False, dlpfc_tier=3, profile="exam", auto_graded=True,
        )
        self.assertTrue(fast["beatAi"])
        self.assertEqual(fast["suggestedFsrsGrade"], 4)
        self.assertLess(fast["deltaSec"], 0)
        self.assertGreater(fast["itemUpi"], 100)

        # Rushing wrong answer gets 0 Beat-AI credit & grade 1
        rushed_wrong = analytics.compute_attempt_metrics(
            active_sec=20, ai_par_sec=120, hints_used=0, hint_handicap_sec=30, quality_accuracy=0.4,
        )
        self.assertFalse(rushed_wrong["beatAi"])
        self.assertEqual(rushed_wrong["suggestedFsrsGrade"], 1)

        # Hint used disqualifies Beat-AI and caps suggested grade at 2 (Hard)
        hinted = analytics.compute_attempt_metrics(
            active_sec=60, ai_par_sec=120, hints_used=1, hint_handicap_sec=30, quality_accuracy=1.0,
        )
        self.assertFalse(hinted["beatAi"])
        self.assertEqual(hinted["effectiveSec"], 90.0)
        self.assertEqual(hinted["suggestedFsrsGrade"], 2)

        # Open-book / assisted run disqualifies closed-book Beat-AI
        assisted = analytics.compute_attempt_metrics(
            active_sec=60, ai_par_sec=120, hints_used=0, hint_handicap_sec=30, quality_accuracy=1.0, assisted=True,
        )
        self.assertFalse(assisted["beatAi"])
        self.assertEqual(assisted["suggestedFsrsGrade"], 2)

        # Self-graded written tasks cap pace ratio at 1.00
        written = analytics.compute_attempt_metrics(
            active_sec=30, ai_par_sec=120, hints_used=0, hint_handicap_sec=30,
            quality_accuracy=1.0, auto_graded=False,
        )
        self.assertLessEqual(written["paceRatio"], 1.0)

        # Non-finite / negative values handled cleanly without NaN
        edge = analytics.compute_attempt_metrics(
            active_sec=-25, ai_par_sec=float("nan"), hints_used=-2, hint_handicap_sec=float("inf"),
            quality_accuracy=float("nan"),
        )
        self.assertEqual(edge["activeSec"], 0.0)
        self.assertEqual(edge["qualityAccuracy"], 0.0)
        self.assertFalse(edge["beatAi"])

    def test_aggregate_attempt_group_empty_and_weighted(self) -> None:
        empty = analytics.aggregate_attempt_group([])
        self.assertEqual(empty["count"], 0)
        self.assertIsNone(empty["upi"])
        self.assertIsNone(empty["avgAccuracy"])

        # Malformed None values in attempt rows should not crash
        rows = [
            {"kind": "mcq", "qualityAccuracy": 1.0, "paceRatio": 1.2, "beatAi": True, "deltaSec": -15, "activeSec": 60, "dlpfcTier": 2},
            {"kind": "written", "autoGraded": False, "qualityAccuracy": None, "paceRatio": None, "beatAi": False, "deltaSec": None, "activeSec": 120},
        ]
        agg = analytics.aggregate_attempt_group(rows)
        self.assertEqual(agg["count"], 2)
        self.assertAlmostEqual(agg["avgAccuracy"], 0.5, places=3)
        self.assertAlmostEqual(agg["totalActiveMinutes"], 3.0, places=1)
        self.assertIsInstance(agg["upi"], int)

    def test_pearson_and_correlations(self) -> None:
        self.assertIsNone(analytics.pearson_r([1.0, 2.0], [1.0, 2.0]))
        self.assertIsNone(analytics.pearson_r([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]))
        self.assertEqual(analytics.pearson_r([1.0, 2.0, 3.0, 4.0], [10.0, 20.0, 30.0, 40.0]), 1.0)

        onboarding = analytics.compute_correlations([{"upi": 90, "checkIn": {"focus": 4}}])
        self.assertEqual(onboarding[0]["factor"], "onboarding")

        sessions = [
            {"upi": 70, "checkIn": {"focus": 2, "energy": 2, "tags": ["Home"]}},
            {"upi": 75, "checkIn": {"focus": 2, "energy": 3, "tags": ["Home"]}},
            {"upi": 95, "checkIn": {"focus": 4, "energy": 4, "tags": ["Library"]}},
            {"upi": 105, "checkIn": {"focus": 5, "energy": 5, "tags": ["Library"]}},
            # Malformed bool/non-list checkIn should be ignored cleanly
            {"upi": True, "checkIn": {"focus": True, "tags": "not-a-list"}},
        ]
        insights = analytics.compute_correlations(sessions)
        factors = {item["factor"]: item for item in insights}
        self.assertIn("focus", factors)
        self.assertGreater(factors["focus"]["r"], 0.9)
        self.assertIn("tag:Library", factors)
        self.assertGreater(factors["tag:Library"]["deltaUpi"], 20.0)

    def test_build_full_analytics_empty_and_multi_course_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp) / "root"
            tmp_data = Path(tmp) / "isolated_data"
            tmp_root.mkdir()
            tmp_data.mkdir()

            # 1. Empty progress & empty courses
            empty_summary = analytics.build_full_analytics(tmp_root, {}, {}, data_dir=tmp_data)
            self.assertEqual(empty_summary["streakDays"], 0)
            self.assertEqual(empty_summary["totalXp"], 0)
            self.assertEqual(empty_summary["totalAttempts"], 0)
            self.assertEqual(len(empty_summary["dailySeries"]), 14)
            self.assertTrue((tmp_data / "logs" / "ai_context_snapshot.json").is_file())
            self.assertFalse((tmp_root / "data" / "logs" / "ai_context_snapshot.json").exists())

            # 2. Multi-course attempts & consecutive 3-day streak
            now = datetime.now(OSLO_TZ)
            attempts = [
                {
                    "timestamp": (now - timedelta(days=2)).isoformat(),
                    "courseId": "econ-2522",
                    "questionId": "econ-2522:q1",
                    "topicId": "1",
                    "kind": "mcq",
                    "dlpfcTier": 1,
                    "qualityAccuracy": 1.0,
                    "paceRatio": 1.15,
                    "beatAi": True,
                    "deltaSec": -12.0,
                    "activeSec": 90.0,
                },
                {
                    "timestamp": (now - timedelta(days=1)).isoformat(),
                    "courseId": "acct-2527",
                    "questionId": "acct-2527:npv1",
                    "topicId": "10",
                    "kind": "wiseflow",
                    "dlpfcTier": 3,
                    "qualityAccuracy": 0.9,
                    "paceRatio": 1.05,
                    "beatAi": True,
                    "deltaSec": -30.0,
                    "activeSec": 900.0,
                },
                {
                    "timestamp": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "courseId": "econ-2522",
                    "questionId": "econ-2522:q2",
                    "topicId": "3",
                    "kind": "calculation",
                    "dlpfcTier": 3,
                    "qualityAccuracy": 0.4,
                    "paceRatio": 0.16,
                    "beatAi": False,
                    "deltaSec": 180.0,
                    "activeSec": 600.0,
                },
            ]
            sessions = [
                {
                    "endedAt": now.isoformat(),
                    "activeSec": 600.0,
                    "awaySec": 60.0,
                    "focusDensity": 0.91,
                    "upi": 88,
                }
            ]
            logs_dir = tmp_data / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            (logs_dir / "attempts.jsonl").write_text("\n".join(json.dumps(a) for a in attempts) + "\n", encoding="utf-8")
            (logs_dir / "sessions.jsonl").write_text("\n".join(json.dumps(s) for s in sessions) + "\n", encoding="utf-8")

            courses = {"econ-2522": _sample_course_bank(), "acct-2527": _sample_acct_bank()}
            progress = {
                "records": {
                    "econ-2522:q1": {"status": "done", "beatAiCount": 1, "fsrs": {"due": (now - timedelta(hours=2)).isoformat()}},
                    "econ-2522:q2": {"status": "revisit", "fsrs": {"due": (now - timedelta(hours=1)).isoformat()}},
                    "acct-2527:npv1": {"status": "done", "beatAiCount": 1, "fsrs": {"due": (now + timedelta(days=5)).isoformat()}},
                }
            }
            summary = analytics.build_full_analytics(tmp_root, courses, progress, data_dir=tmp_data)
            self.assertEqual(summary["streakDays"], 3)
            # XP = 3*15 + 2*10 + 1*25 = 90
            self.assertEqual(summary["totalXp"], 90)
            self.assertEqual(summary["courseProgress"]["econ-2522"]["done"], 1)
            self.assertEqual(summary["courseProgress"]["econ-2522"]["revisit"], 1)
            self.assertEqual(summary["courseProgress"]["econ-2522"]["dueFsrs"], 2)
            self.assertEqual(summary["courseProgress"]["acct-2527"]["dueFsrs"], 0)
            self.assertEqual(summary["dlpfcBudget"]["todayHighMinutes"], 10.0)
            self.assertTrue(summary["weakTopics"])
            self.assertEqual(summary["weakTopics"][0]["topicId"], "3")
            self.assertIn("econ-2522", summary["topicMatrix"])


# =============================================================================
# 3. DLPFC Cognitive Control Classifier & Circadian Router
# =============================================================================
class TestDlpfc(unittest.TestCase):
    def test_intrinsic_classification_across_courses(self) -> None:
        self.assertEqual(dlpfc.classify_intrinsic_dlpfc({"courseId": "econ-2522", "kind": "mcq", "difficulty": 1}), (1, "recall"))
        self.assertEqual(
            dlpfc.classify_intrinsic_dlpfc({"courseId": "econ-2522", "kind": "mcq", "difficulty": 2, "promptMarkdown": "Calculate profit"}),
            (2, "procedural"),
        )
        self.assertEqual(
            dlpfc.classify_intrinsic_dlpfc({"courseId": "acct-2527", "kind": "wiseflow", "wiseflowFields": [{}, {}, {}, {}]}),
            (3, "synthesis"),
        )
        self.assertEqual(dlpfc.classify_intrinsic_dlpfc({"courseId": "ob-2537", "kind": "written"}), (3, "synthesis"))
        self.assertEqual(dlpfc.classify_intrinsic_dlpfc({"courseId": "math-2588", "kind": "calculation", "difficulty": 1}), (1, "recall"))
        self.assertEqual(dlpfc.classify_intrinsic_dlpfc({"courseId": "prog-3021", "kind": "coding", "difficulty": 2}), (2, "procedural"))

    def test_effective_tier_escalation_and_chunked_stepdown(self) -> None:
        high_q = {"courseId": "acct-2527", "kind": "wiseflow", "wiseflowFields": [{}, {}, {}, {}]}
        self.assertEqual(dlpfc.effective_dlpfc_tier(high_q, None), (3, False))
        self.assertEqual(
            dlpfc.effective_dlpfc_tier(high_q, {"status": "done", "fsrs": {"reps": 1, "stability": 3.2, "lastGrade": 3}}),
            (2, True),
        )
        self.assertEqual(
            dlpfc.effective_dlpfc_tier(high_q, {"status": "done", "fsrs": {"reps": 2, "stability": 5.5, "lastGrade": 3}}),
            (1, True),
        )
        # Lapse escalates low MCQ to tier 2
        mcq = {"courseId": "econ-2522", "kind": "mcq", "difficulty": 1}
        self.assertEqual(dlpfc.effective_dlpfc_tier(mcq, {"status": "revisit", "fsrs": {"lastGrade": 1}}), (2, False))

    def test_circadian_windows_and_invalid_edge_inputs(self) -> None:
        self.assertEqual(dlpfc.circadian_dlpfc_target(8, 0.0)[0], "high_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(14, 269.9)[0], "high_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(14, 270.0)[0], "med_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(15, 0.0)[0], "med_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(17, 0.0)[0], "med_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(18, 0.0)[0], "low_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(3, 0.0)[0], "low_dlpfc")

        # Invalid / edge inputs fail safe to low_dlpfc and never raise
        self.assertEqual(dlpfc.circadian_dlpfc_target(-1, -50.0)[0], "low_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(25, float("nan"))[0], "low_dlpfc")
        self.assertEqual(dlpfc.circadian_dlpfc_target(None, None)[0], "low_dlpfc")  # type: ignore[arg-type]
        self.assertEqual(dlpfc.circadian_dlpfc_target(True, 0)[0], "low_dlpfc")  # type: ignore[arg-type]
        self.assertEqual(dlpfc.classify_intrinsic_dlpfc({"difficulty": "bad", "points": None, "pacing": "bad", "wiseflowFields": 5}), (1, "recall"))
        self.assertEqual(dlpfc.effective_dlpfc_tier({"dlpfcBase": True, "kind": "mcq"}, {"fsrs": {"lastGrade": "bad", "reps": "bad"}}), (1, False))


# =============================================================================
# 4. TimeEdit / ICS Calendar Parser & Calendar Sync
# =============================================================================
class TestCalendarAndIcs(unittest.TestCase):
    def test_parse_ics_folded_escaped_utc_oslo_tzid_valarm_cancelled(self) -> None:
        ics = "\r\n".join(
            [
                "BEGIN:VCALENDAR",
                "VERSION:2.0",
                "BEGIN:VEVENT",
                "UID:ev-winter@timeedit.net",
                "DTSTART:20260115T080000Z",
                "DTEND:20260115T100000Z",
                "SUMMARY:EXC 3420 Economics\\, Lecture 1\\; Part",
                " A (Folded)",
                "DESCRIPTION:Line1\\nLine2\\\\nLiteral\\,Comma",
                "LOCATION:BI Oslo\\, A2-010",
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "SUMMARY:Alarm Should Not Overwrite Event",
                "DESCRIPTION:Ignore this alarm description",
                "END:VALARM",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:ev-summer@timeedit.net",
                "DTSTART:20260615T080000Z",
                "DTEND:20260615T093000Z",
                "SUMMARY:Summer UTC Check",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:ev-quoted-tz@timeedit.net",
                'DTSTART;TZID="Europe/Oslo":20261120T120000',
                'DTEND;TZID="Europe/Oslo":20261120T130000',
                "SUMMARY:Quoted TZID Event",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:ev-cancelled@timeedit.net",
                "STATUS:CANCELLED",
                "DTSTART:20260116T080000Z",
                "DTEND:20260116T090000Z",
                "SUMMARY:Should Be Skipped",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:ev-no-end@timeedit.net",
                "DTSTART:20260117T100000Z",
                "SUMMARY:Missing DTEND defaults to 60m",
                "END:VEVENT",
                "END:VCALENDAR",
            ]
        )
        events = timetable_planner.parse_ics_events(ics)
        self.assertEqual(len(events), 4)

        winter = next(e for e in events if e["id"] == "ev-winter@timeedit.net")
        self.assertEqual(winter["summary"], "EXC 3420 Economics, Lecture 1; PartA (Folded)")
        self.assertEqual(winter["description"], "Line1\nLine2\\nLiteral,Comma")
        self.assertEqual(winter["location"], "BI Oslo, A2-010")
        # Winter in Oslo is CET (+01:00): 08:00Z -> 09:00+01:00
        self.assertEqual(winter["start"], "2026-01-15T09:00:00+01:00")
        self.assertEqual(winter["end"], "2026-01-15T11:00:00+01:00")

        summer = next(e for e in events if e["id"] == "ev-summer@timeedit.net")
        # Summer in Oslo is CEST (+02:00): 08:00Z -> 10:00+02:00
        self.assertEqual(summer["start"], "2026-06-15T10:00:00+02:00")

        quoted_tz = next(e for e in events if e["id"] == "ev-quoted-tz@timeedit.net")
        self.assertEqual(quoted_tz["start"], "2026-11-20T12:00:00+01:00")

        no_end = next(e for e in events if e["id"] == "ev-no-end@timeedit.net")
        self.assertEqual(no_end["start"], "2026-01-17T11:00:00+01:00")
        self.assertEqual(no_end["end"], "2026-01-17T12:00:00+01:00")

    def test_malformed_ics_rejected_without_crashing(self) -> None:
        self.assertEqual(timetable_planner.parse_ics_events(""), [])
        self.assertEqual(timetable_planner.parse_ics_events("not an ics file at all"), [])
        self.assertEqual(timetable_planner.parse_ics_events(None), [])  # type: ignore[arg-type]
        malformed = """BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20269999T999999Z
SUMMARY:Invalid date
END:VEVENT
BEGIN:VEVENT
DTSTART:20260115T090000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:Truncated without END
"""
        self.assertEqual(timetable_planner.parse_ics_events(malformed), [])

    def test_fetch_timeedit_ics_ssrf_and_scheme_guards(self) -> None:
        for bad_url in [
            "file:///etc/passwd",
            "ftp://example.com/cal.ics",
            "http://127.0.0.1:8765/api/ping",
            "http://localhost:8765/api/bootstrap",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/cal.ics",
            "https://user:pass@example.com/cal.ics",
        ]:
            with self.assertRaises(ValueError, msg=f"Should reject {bad_url}"):
                timetable_planner.fetch_timeedit_ics(bad_url)

    def test_export_ics_sanitizes_injection_and_roundtrips(self) -> None:
        blocks = [
            {
                "eventId": "blk-1",
                "summary": "Econ, Topic 3; Drill\r\nBEGIN:VEVENT\r\nSUMMARY:Injected",
                "start": "2026-11-26T09:00:00+01:00",
                "end": "2026-11-26T09:50:00+01:00",
                "courseId": "econ-2522",
                "dlpfcMode": "high_dlpfc",
            }
        ]
        ics_out = timetable_planner.export_blocks_to_ics(blocks, cal_name="My\r\nCal")
        self.assertEqual(ics_out.splitlines().count("BEGIN:VEVENT"), 1)
        self.assertEqual(ics_out.splitlines().count("END:VEVENT"), 1)
        reparsed = timetable_planner.parse_ics_events(ics_out)
        self.assertEqual(len(reparsed), 1)
        self.assertIn("Econ, Topic 3; Drill", reparsed[0]["summary"])

    def test_calendar_sync_parse_classify_normalize_and_auto_queue(self) -> None:
        # Date-only in summer must be midnight Oslo (+02:00), not 01:00+02:00
        summer_mid = calendar_sync.parse_iso("2026-07-15")
        self.assertIsNotNone(summer_mid)
        assert summer_mid is not None
        self.assertEqual(summer_mid.hour, 0)
        self.assertEqual(summer_mid.strftime("%z"), "+0200")
        self.assertIsNone(calendar_sync.parse_iso("not-a-date"))

        # Classification filters non-study & tags subjects/kinds
        self.assertIsNone(calendar_sync.classify_event("Fresh Fitness Gym"))
        lec = calendar_sync.classify_event("[BI Class] Economics Topic 3 Lecture")
        self.assertEqual(lec["courseId"], "econ-2522")
        self.assertEqual(lec["blockKind"], "class_session")
        self.assertIn("3", lec["topicIds"])

        recall = calendar_sync.classify_event("Accounting: 20 min NPV flashcards")
        self.assertEqual(recall["courseId"], "acct-2527")
        self.assertEqual(recall["blockKind"], "recall_sprint")

        # Normalize skips cancelled and inverted end<=start events
        raw_events = [
            {
                "id": "e1",
                "summary": "Economics Topic 3 Practice (50/10)",
                "start": {"dateTime": "2026-11-26T09:00:00+01:00"},
                "end": {"dateTime": "2026-11-26T10:00:00+01:00"},
            },
            {
                "id": "e-cancelled",
                "status": "cancelled",
                "summary": "Economics Lecture",
                "start": {"dateTime": "2026-11-26T10:00:00+01:00"},
                "end": {"dateTime": "2026-11-26T11:00:00+01:00"},
            },
            {
                "id": "e-inverted",
                "summary": "Economics Topic 1",
                "start": {"dateTime": "2026-11-26T12:00:00+01:00"},
                "end": {"dateTime": "2026-11-26T11:00:00+01:00"},
            },
        ]
        blocks = calendar_sync.normalize_raw_events(raw_events)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["focusMinutes"], 50)
        self.assertEqual(blocks[0]["dlpfcMode"], "high_dlpfc")

        # Auto queue prioritizes high-dlPFC in morning and respects unknown courses
        courses = {"econ-2522": _sample_course_bank()}
        q_res = calendar_sync.build_auto_queue_for_block(blocks[0], courses, {})
        self.assertTrue(q_res["questionIds"])
        self.assertEqual(q_res["questionIds"][0], "econ-2522:q2")
        unknown_res = calendar_sync.build_auto_queue_for_block({"courseId": "missing"}, courses, {})
        self.assertEqual(unknown_res["questionIds"], [])


# =============================================================================
# 5. Timetable Planner (Adaptive Schedule Generation)
# =============================================================================
class TestTimetablePlanner(unittest.TestCase):
    def setUp(self) -> None:
        self.courses = {"econ-2522": _sample_course_bank(), "acct-2527": _sample_acct_bank()}
        self.now = datetime(2026, 11, 23, 7, 0, 0, tzinfo=OSLO_TZ)  # Monday 07:00

    def test_schedule_generation_without_and_with_conflicts(self) -> None:
        prefs = {
            **timetable_planner.default_schedule_prefs(),
            "weeklyWorkHours": 12.0,
            "blockMinutes": 50,
            "breakMinutes": 10,
            "restDays": [6, 99],  # Invalid weekday 99 must be ignored
        }
        no_conflict = timetable_planner.generate_adaptive_schedule(
            fixed_events=[], courses_by_id=self.courses, progress_state={}, prefs=prefs, days_ahead=14, now_dt=self.now
        )
        study_blocks = [b for b in no_conflict["blocks"] if b["origin"] == "auto_scheduler"]
        self.assertTrue(study_blocks)
        # No blocks placed on Sunday (weekday 6)
        for b in study_blocks:
            self.assertNotEqual(datetime.fromisoformat(b["start"]).weekday(), 6)

        # With fixed TimeEdit conflict on Monday 08:00-11:00
        fixed = [
            {
                "id": "lec-1",
                "summary": "EXC 3420 Lecture",
                "start": "2026-11-23T08:00:00+01:00",
                "end": "2026-11-23T11:00:00+01:00",
            }
        ]
        with_conflict = timetable_planner.generate_adaptive_schedule(
            fixed_events=fixed, courses_by_id=self.courses, progress_state={}, prefs=prefs, days_ahead=7, now_dt=self.now
        )
        lec_s = datetime.fromisoformat(fixed[0]["start"])
        lec_e = datetime.fromisoformat(fixed[0]["end"])
        for b in with_conflict["blocks"]:
            if b["origin"] == "auto_scheduler":
                bs = datetime.fromisoformat(b["start"])
                be = datetime.fromisoformat(b["end"])
                # Must not overlap lecture (+10m break padding)
                self.assertFalse(bs < lec_e + timedelta(minutes=10) and be + timedelta(minutes=10) > lec_s)

    def test_budget_caps_midnight_and_empty_bounds(self) -> None:
        # Tight manual study hours cap
        prefs_cap = {
            **timetable_planner.default_schedule_prefs(),
            "autoAdjustStudy": False,
            "targetStudyHours": 3.0,  # 180m / 50m = 3 blocks per week
            "blockMinutes": 50,
            "breakMinutes": 10,
        }
        res_cap = timetable_planner.generate_adaptive_schedule(
            fixed_events=[], courses_by_id=self.courses, progress_state={}, prefs=prefs_cap, days_ahead=7, now_dt=self.now
        )
        self.assertLessEqual(len(res_cap["blocks"]), 3)

        # Midnight wrap-around bedtime (`00:00` and `01:00`) succeeds cleanly
        for bed in ("00:00", "01:00"):
            res_mid = timetable_planner.generate_adaptive_schedule(
                fixed_events=[],
                courses_by_id=self.courses,
                progress_state={},
                prefs={**timetable_planner.default_schedule_prefs(), "wakeTime": "08:00", "bedTime": bed},
                days_ahead=3,
                now_dt=self.now,
            )
            self.assertTrue(res_mid["blocks"])

        # Equal wake/bed raises ValueError
        with self.assertRaises(ValueError):
            timetable_planner.generate_adaptive_schedule(
                fixed_events=[],
                courses_by_id=self.courses,
                progress_state={},
                prefs={"wakeTime": "08:00", "bedTime": "08:00"},
                days_ahead=3,
                now_dt=self.now,
            )

        # Empty courses catalog & days_ahead=0 return empty blocks safely
        empty_cat = timetable_planner.generate_adaptive_schedule(
            fixed_events=[], courses_by_id={}, progress_state={}, prefs=timetable_planner.default_schedule_prefs(), days_ahead=7, now_dt=self.now
        )
        self.assertEqual(empty_cat["blocks"], [])
        zero_days = timetable_planner.generate_adaptive_schedule(
            fixed_events=[], courses_by_id=self.courses, progress_state={}, prefs=timetable_planner.default_schedule_prefs(), days_ahead=0, now_dt=self.now
        )
        self.assertEqual(zero_days["blocks"], [])

    def test_universal_schedule_payload_json_and_ics(self) -> None:
        raw_json = """Here is your schedule:
```json
{"blocks": [
  {"title": "Economics Topic 3", "date": "2026-11-26", "startTime": "09:00", "endTime": "09:50"},
  {"title": "Invalid Time Skipped", "date": "2026-11-26", "startTime": "25:99", "endTime": "26:00"},
  {"title": "Accounting NPV", "start": "2026-11-26T11:00:00+01:00", "end": "2026-11-26T10:00:00+01:00", "durationMinutes": 45}
]}
```"""
        blocks = timetable_planner.parse_universal_schedule_payload(raw_json, self.courses)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["courseId"], "econ-2522")
        # Inverted end<=start was repaired using durationMinutes
        self.assertEqual(blocks[1]["durationMinutes"], 45)
        with self.assertRaises(ValueError):
            timetable_planner.parse_universal_schedule_payload("   ", self.courses)


# =============================================================================
# 6. Local HTTP Server Security & API Integration Tests (Ephemeral 127.0.0.1:0)
# =============================================================================
class TestLocalHttpServer(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name).resolve()
        self.tmp_root = self.tmp_path / "study_os_root"
        self.tmp_data = self.tmp_path / "data"
        self.tmp_public = self.tmp_path / "public"
        self.secret_outside = self.tmp_path / "secret.txt"
        self.secret_outside.write_text("TOP_SECRET_DO_NOT_LEAK", encoding="utf-8")

        # Set up isolated static public directory + symlink pointing outside
        (self.tmp_public / "subdir").mkdir(parents=True)
        (self.tmp_public / "index.html").write_text("<!doctype html><h1>Study-OS Test</h1>", encoding="utf-8")
        (self.tmp_public / "app.js").write_text("console.log('ok');", encoding="utf-8")
        (self.tmp_public / "escape_link.txt").symlink_to(self.secret_outside)

        # Set up isolated course bank + valid asset + symlink escaping course dir
        course_dir = self.tmp_data / "courses" / "econ-2522"
        (course_dir / "assets").mkdir(parents=True)
        (course_dir / "bank.json").write_text(json.dumps(_sample_course_bank()), encoding="utf-8")
        (course_dir / "assets" / "graph.svg").write_text("<svg></svg>", encoding="utf-8")
        (course_dir / "assets" / "escape.txt").symlink_to(self.secret_outside)
        (self.tmp_data / "state").mkdir(parents=True, exist_ok=True)
        (self.tmp_data / "state" / "progress.json").write_text(
            json.dumps({"version": 1, "records": {"secret": {"status": "done"}}}), encoding="utf-8"
        )

        self._gcal_patch = mock.patch.object(calendar_sync, "find_gcalendar_bin", return_value=None)
        self._gcal_patch.start()
        self.store = study_server.StudyStore(self.tmp_root, data_dir=self.tmp_data)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), study_server.StudyOSHandler)
        self.httpd.store = self.store  # type: ignore[attr-defined]
        self.httpd.public_dir = self.tmp_public  # type: ignore[attr-defined]
        self.httpd.live_tutor = LiveTutor()  # type: ignore[attr-defined]
        self.httpd.canvas_browser = CanvasBrowser(  # type: ignore[attr-defined]
            self.tmp_data / "state" / "canvas-browser.json", study_server.atomic_write_json
        )
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(timeout=5)
        self._gcal_patch.stop()
        self._tmp.cleanup()

    def _request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            req_headers = dict(headers or {})
            conn.putrequest(method, path, skip_host=("Host" in req_headers))
            for k, v in req_headers.items():
                conn.putheader(k, v)
            if body is not None and "Content-Length" not in req_headers:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            resp = conn.getresponse()
            raw = resp.read()
            hdrs = {k.lower(): v for k, v in resp.getheaders()}
            return resp.status, hdrs, raw
        finally:
            conn.close()

    def _assert_security_headers(self, headers: dict[str, str]) -> None:
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers.get("x-frame-options"), "DENY")
        self.assertEqual(headers.get("referrer-policy"), "strict-origin-when-cross-origin")
        self.assertEqual(headers.get("cache-control"), "no-store")

    def test_ping_bootstrap_and_security_headers(self) -> None:
        status, hdrs, raw = self._request("GET", "/api/ping")
        self.assertEqual(status, 200)
        self._assert_security_headers(hdrs)
        self.assertTrue(json.loads(raw)["ok"])

        # localhost Host also works cleanly
        status_lh, _, raw_lh = self._request("GET", "/api/ping", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(status_lh, 200)
        self.assertTrue(json.loads(raw_lh)["ok"])

        status_b, hdrs_b, raw_b = self._request("GET", "/api/bootstrap")
        self.assertEqual(status_b, 200)
        self._assert_security_headers(hdrs_b)
        boot = json.loads(raw_b)
        self.assertEqual(len(boot["catalog"]), 1)
        self.assertEqual(boot["catalog"][0]["courseId"], "econ-2522")
        # Verify snapshot written only to isolated temp dir
        self.assertTrue((self.tmp_data / "logs" / "ai_context_snapshot.json").is_file())

    def test_static_serving_and_traversal_and_symlink_blocking(self) -> None:
        status, hdrs, raw = self._request("GET", "/app.js")
        self.assertEqual(status, 200)
        self._assert_security_headers(hdrs)
        self.assertIn(b"console.log", raw)

        # Directory listing must be blocked
        status_dir, _, _ = self._request("GET", "/subdir/")
        self.assertEqual(status_dir, 403)

        # Raw, percent-encoded, double-encoded, backslash, and symlink traversal must all fail (403)
        for bad_path in [
            "/../secret.txt",
            "/%2e%2e/secret.txt",
            "/%252e%252e/secret.txt",
            "/subdir/../../secret.txt",
            "/..%5csecret.txt",
            "/escape_link.txt",
        ]:
            st, h, body = self._request("GET", bad_path)
            self.assertIn(st, (400, 403, 404), f"Expected rejection for {bad_path}, got {st}")
            self.assertNotIn(b"TOP_SECRET_DO_NOT_LEAK", body, f"Leaked secret via {bad_path}")
            self._assert_security_headers(h)

        # Course asset valid vs traversal (`%2e%2e/state/progress.json`) vs symlink escape
        ok_st, _, ok_body = self._request("GET", "/api/course-asset/econ-2522/assets/graph.svg")
        self.assertEqual(ok_st, 200)
        self.assertIn(b"<svg>", ok_body)

        for bad_asset in [
            "/api/course-asset/%2e%2e/state/progress.json",
            "/api/course-asset/../state/progress.json",
            "/api/course-asset/econ-2522/../../secret.txt",
            "/api/course-asset/econ-2522/assets/escape.txt",
        ]:
            st, _, body = self._request("GET", bad_asset)
            self.assertEqual(st, 403, f"Expected 403 for {bad_asset}, got {st}")
            self.assertNotIn(b"TOP_SECRET_DO_NOT_LEAK", body)
            self.assertNotIn(b'"secret"', body)

    def test_dns_rebinding_cors_and_cross_origin_post_protection(self) -> None:
        # DNS rebinding attempt with untrusted Host header -> 403
        st_rebind, _, _ = self._request("GET", "/api/bootstrap", headers={"Host": f"evil.example:{self.port}"})
        self.assertEqual(st_rebind, 403)

        # Untrusted Origin on GET must NOT receive wildcard ACAO
        st_get, hdrs_get, _ = self._request("GET", "/api/ping", headers={"Origin": "https://evil.example"})
        self.assertEqual(st_get, 200)
        self.assertIsNone(hdrs_get.get("access-control-allow-origin"))

        # Trusted local Origin receives exact reflection + Vary: Origin
        trusted_origin = f"http://127.0.0.1:{self.port}"
        st_ok, hdrs_ok, _ = self._request("GET", "/api/ping", headers={"Origin": trusted_origin})
        self.assertEqual(st_ok, 200)
        self.assertEqual(hdrs_ok.get("access-control-allow-origin"), trusted_origin)
        self.assertEqual(hdrs_ok.get("vary"), "Origin")

        # Cross-origin POST -> 403
        payload = json.dumps({"questionId": "econ-2522:q1", "courseId": "econ-2522", "qualityAccuracy": 1.0}).encode()
        st_csrf, _, _ = self._request(
            "POST", "/api/attempt", body=payload,
            headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        )
        self.assertEqual(st_csrf, 403)

        # Cross-site fetch metadata without Origin -> 403
        st_sfs, _, _ = self._request(
            "POST", "/api/attempt", body=payload,
            headers={"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(st_sfs, 403)

    def test_oversized_post_413_malformed_json_400_and_no_tracebacks(self) -> None:
        # Oversized Content-Length header rejected immediately with 413 JSON
        st_413, hdrs_413, raw_413 = self._request(
            "POST",
            "/api/attempt",
            body=None,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(study_server.MAX_JSON_BODY_BYTES + 1024),
            },
        )
        self.assertEqual(st_413, 413)
        self._assert_security_headers(hdrs_413)
        self.assertIn("error", json.loads(raw_413))
        self.assertNotIn(b"Traceback", raw_413)

        # Malformed JSON -> 400 clean JSON
        st_bad, _, raw_bad = self._request(
            "POST", "/api/attempt", body=b"{not valid json", headers={"Content-Type": "application/json"}
        )
        self.assertEqual(st_bad, 400)
        self.assertIn("error", json.loads(raw_bad))
        self.assertNotIn(b"Traceback", raw_bad)

        # Non-object JSON -> 400
        st_arr, _, _ = self._request(
            "POST", "/api/attempt", body=b"[1, 2, 3]", headers={"Content-Type": "application/json"}
        )
        self.assertEqual(st_arr, 400)

        # Bad numeric field -> 400 (never 500 traceback!)
        st_num, _, raw_num = self._request(
            "POST",
            "/api/attempt",
            body=json.dumps({"questionId": "econ-2522:q1", "courseId": "econ-2522", "activeSec": "NaN"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(st_num, 400)
        self.assertNotIn(b"Traceback", raw_num)

        # Valid POST attempt & backup export round-trip
        st_att, _, raw_att = self._request(
            "POST",
            "/api/attempt",
            body=json.dumps(
                {
                    "questionId": "econ-2522:q1",
                    "courseId": "econ-2522",
                    "activeSec": 80,
                    "aiParSec": 120,
                    "qualityAccuracy": 1.0,
                }
            ).encode(),
            headers={"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(st_att, 200)
        att_data = json.loads(raw_att)
        self.assertTrue(att_data["ok"])
        self.assertTrue(att_data["attempt"]["beatAi"])

        st_bak, _, raw_bak = self._request("GET", "/api/export-backup")
        self.assertEqual(st_bak, 200)
        bak = json.loads(raw_bak)
        self.assertEqual(len(bak["attempts"]), 1)

        st_ics, hdrs_ics, raw_ics = self._request("GET", "/api/schedule/export.ics")
        self.assertEqual(st_ics, 200)
        self.assertIn("text/calendar", hdrs_ics.get("content-type", ""))
        self.assertIn(b"BEGIN:VCALENDAR", raw_ics)

    def test_progress_session_schedule_and_vault_endpoints(self) -> None:
        origin_hdr = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}

        # Draft save -> sets in_progress
        st, _, raw = self._request(
            "POST", "/api/progress/draft",
            body=json.dumps({"questionId": "econ-2522:q2", "draft": "MRS = y/x", "activeElapsedSec": 45}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st, 200)
        self.assertTrue(json.loads(raw)["ok"])

        # Invalid questionIds type (string instead of list) -> 400
        st_bad_qids, _, _ = self._request(
            "POST", "/api/progress/status",
            body=json.dumps({"questionIds": "econ-2522:q2", "status": "done"}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_bad_qids, 400)

        # Valid status update & difficulty override & session logging
        st_stat, _, raw_stat = self._request(
            "POST", "/api/progress/status",
            body=json.dumps({"questionIds": ["econ-2522:q2"], "status": "done"}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_stat, 200)
        self.assertEqual(json.loads(raw_stat)["updated"], 1)

        st_diff, _, raw_diff = self._request(
            "POST", "/api/progress/difficulty",
            body=json.dumps({"questionId": "econ-2522:q2", "fsrsGrade": 4}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_diff, 200)
        self.assertEqual(json.loads(raw_diff)["record"]["lastUserGrade"], 4)

        st_ses, _, raw_ses = self._request(
            "POST", "/api/session",
            body=json.dumps({"courseId": "econ-2522", "reviewedCount": 2, "activeSec": 600, "wallSec": 660, "avgAccuracy": 0.9, "avgPaceRatio": 1.1}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_ses, 200)
        self.assertIsInstance(json.loads(raw_ses)["session"]["upi"], int)

        # Schedule generate rejects SSRF timeeditUrl -> 400
        st_ssrf, _, raw_ssrf = self._request(
            "POST", "/api/schedule/generate",
            body=json.dumps({"prefs": {"timeeditUrl": "http://127.0.0.1:8765/api/bootstrap"}}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_ssrf, 400)
        self.assertIn("error", json.loads(raw_ssrf))

        # Unknown API route returns clean JSON 404
        st_404, _, raw_404 = self._request("GET", "/api/does-not-exist")
        self.assertEqual(st_404, 404)
        self.assertIn("error", json.loads(raw_404))

        # Vault asset wildcard / traversal rejected cleanly
        st_vault, _, _ = self._request("GET", "/api/vault-asset?path=*.md")
        self.assertIn(st_vault, (400, 404))

        # CLI main() rejects non-loopback host binding (0.0.0.0)
        with mock.patch.object(sys, "argv", ["server.py", "--host", "0.0.0.0"]), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                study_server.main()
            self.assertNotEqual(cm.exception.code, 0)

    def test_ai_assisted_attempt_and_solo_retry_toggle(self) -> None:
        origin_hdr = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}

        # 1. Submitting a 100% attempt with aiAssisted=True keeps status="revisit", beatAi=False, and flags aiAssisted
        st1, _, raw1 = self._request(
            "POST", "/api/attempt",
            body=json.dumps({
                "courseId": "econ-2522",
                "questionId": "econ-2522:q2",
                "topicId": "3",
                "kind": "calculation",
                "activeSec": 60,
                "aiParSec": 120,
                "qualityAccuracy": 1.0,
                "aiAssisted": True,
                "aiAssistedSource": "copy",
            }).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st1, 200)
        d1 = json.loads(raw1)
        self.assertEqual(d1["record"]["status"], "revisit")
        self.assertTrue(d1["record"]["aiAssisted"])
        self.assertEqual(d1["record"]["aiAssistedCount"], 1)
        self.assertFalse(d1["attempt"]["beatAi"])
        self.assertTrue(d1["attempt"]["assisted"])
        self.assertTrue(d1["attempt"]["aiAssisted"])
        self.assertEqual(d1["attempt"]["fsrsGrade"], 1)

        # 2. Rating Hard (grade=2) while aiAssisted is True MUST keep status="revisit" (not flip to done)
        st_hard, _, raw_hard = self._request(
            "POST", "/api/progress/difficulty",
            body=json.dumps({"questionId": "econ-2522:q2", "fsrsGrade": 2}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_hard, 200)
        self.assertEqual(json.loads(raw_hard)["record"]["status"], "revisit")

        # 3. Toggling Used AI OFF restores done & clears aiAssisted
        st_off, _, raw_off = self._request(
            "POST", "/api/progress/ai-assisted",
            body=json.dumps({"questionId": "econ-2522:q2", "aiAssisted": False}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_off, 200)
        d_off = json.loads(raw_off)
        self.assertFalse(d_off["record"]["aiAssisted"])
        self.assertEqual(d_off["record"]["status"], "done")

        # 4. Toggling Used AI ON flips back to revisit & aiAssisted=True
        st_on, _, raw_on = self._request(
            "POST", "/api/progress/ai-assisted",
            body=json.dumps({"questionId": "econ-2522:q2", "aiAssisted": True}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_on, 200)
        d_on = json.loads(raw_on)
        self.assertTrue(d_on["record"]["aiAssisted"])
        self.assertEqual(d_on["record"]["status"], "revisit")

        # 5. Clean solo retry later clears aiAssisted and marks done
        st_solo, _, raw_solo = self._request(
            "POST", "/api/attempt",
            body=json.dumps({
                "courseId": "econ-2522",
                "questionId": "econ-2522:q2",
                "topicId": "3",
                "kind": "calculation",
                "activeSec": 80,
                "aiParSec": 120,
                "qualityAccuracy": 1.0,
                "aiAssisted": False,
                "assisted": False,
            }).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_solo, 200)
        d_solo = json.loads(raw_solo)
        self.assertFalse(d_solo["record"]["aiAssisted"])
        self.assertEqual(d_solo["record"]["status"], "done")
        self.assertTrue(d_solo["attempt"]["beatAi"])


# =============================================================================
# 7. MCP Server (`tools/study_os_mcp.py`) Pure Helpers & Local Bridge Tests
# =============================================================================
class TestStudyOsMcp(unittest.TestCase):
    def test_pure_helpers_draft_study_set_and_slide_excerpt(self) -> None:
        # draft_study_set produces a decodable gzip+base64url Study-OS import link
        res = study_os_mcp.draft_study_set("Micro Review", [("What is MRS?", "Slope of indifference curve.")])
        self.assertEqual(res["cardCount"], 1)
        self.assertTrue(res["importUrl"].startswith("https://studyos.no/#study-set="))
        code = res["importUrl"].split("#study-set=", 1)[1]
        padded = code + "=" * (-len(code) % 4)
        decoded = json.loads(gzip.decompress(base64.urlsafe_b64decode(padded)).decode("utf-8"))
        self.assertEqual(decoded["format"], "study-os-set-v1")
        self.assertEqual(decoded["cards"], [["What is MRS?", "Slope of indifference curve."]])

        # Invalid draft inputs rejected cleanly
        for bad_title, bad_cards in [
            ("", [("Q", "A")]),
            ("Valid", []),
            ("Valid", [("Q", "")]),
            ("Valid", [("only-one",)]),  # type: ignore[list-item]
            (123, [("Q", "A")]),  # type: ignore[list-item]
        ]:
            with self.assertRaises(ValueError):
                study_os_mcp.draft_study_set(bad_title, bad_cards)  # type: ignore[arg-type]

        # slide_excerpt parses OOXML PPTX slides cleanly and rejects corrupt zip
        buf = io.BytesIO()
        with ZipFile(buf, "w") as zf:
            zf.writestr(
                "ppt/slides/slide1.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                "<a:t>Slide One</a:t><a:t>Key Formula</a:t></p:sld>",
            )
            zf.writestr(
                "ppt/slides/slide2.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Slide Two</a:t></p:sld>',
            )
        buf.seek(0)
        slides = study_os_mcp.slide_excerpt(buf, 1, 2)
        self.assertEqual(slides, [{"number": 1, "text": "Slide One Key Formula"}, {"number": 2, "text": "Slide Two"}])

        with self.assertRaises(ValueError):
            study_os_mcp.slide_excerpt(io.BytesIO(b"not a zip"), 1, 1)

        # Invalid course ID rejected before making any HTTP call
        with self.assertRaises(ValueError):
            study_os_mcp.bank("../etc/passwd")

    def test_mcp_tools_against_isolated_ephemeral_server(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(calendar_sync, "find_gcalendar_bin", return_value=None):
            tmp_path = Path(tmp).resolve()
            tmp_root = tmp_path / "root"
            tmp_data = tmp_path / "data"
            tmp_pub = tmp_path / "public"
            tmp_pub.mkdir()
            cdir = tmp_data / "courses" / "econ-2522"
            cdir.mkdir(parents=True)
            (cdir / "bank.json").write_text(json.dumps(_sample_course_bank()), encoding="utf-8")

            httpd = ThreadingHTTPServer(("127.0.0.1", 0), study_server.StudyOSHandler)
            httpd.store = study_server.StudyStore(tmp_root, data_dir=tmp_data)  # type: ignore[attr-defined]
            httpd.public_dir = tmp_pub  # type: ignore[attr-defined]
            tutor = LiveTutor()
            httpd.live_tutor = tutor  # type: ignore[attr-defined]
            httpd.canvas_browser = CanvasBrowser(  # type: ignore[attr-defined]
                tmp_data / "state" / "canvas-browser.json", study_server.atomic_write_json
            )
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()

            prev_base = study_os_mcp.BASE
            study_os_mcp.BASE = f"http://127.0.0.1:{port}"
            try:
                courses = study_os_mcp.list_courses()
                self.assertEqual(len(courses["courses"]), 1)
                self.assertEqual(courses["courses"][0]["id"], "econ-2522")

                found = study_os_mcp.search_questions("econ-2522", query="MRS")
                self.assertEqual(found["total"], 1)
                self.assertEqual(found["questions"][0]["id"], "econ-2522:q2")

                q_no_ans = study_os_mcp.read_question("econ-2522:q2", include_answers=False)
                self.assertNotIn("solutionMarkdown", q_no_ans)
                q_with_ans = study_os_mcp.read_question("econ-2522:q2", include_answers=True)
                self.assertIn("solutionMarkdown", q_with_ans)

                # Malformed wake_time falls back cleanly without crashing
                bp = study_os_mcp.circadian_dlpfc_blueprint(wake_time="bad:time", bed_time="invalid")
                self.assertEqual(bp["wakeTime"], "07:30")
                self.assertEqual(len(bp["windows"]), 3)

                # Live tutor gating: waiting -> blind exam blocks search_questions
                self.assertEqual(study_os_mcp.get_current_exercise()["mode"], "waiting")
                tutor.update(
                    {
                        "tab": "11111111-2222-3333-4444-555555555555",
                        "activity": int(datetime.now(timezone.utc).timestamp() * 1000),
                        "state": {"mode": "blind"},
                    }
                )
                self.assertEqual(study_os_mcp.get_current_exercise()["mode"], "blind")
                with self.assertRaises(ValueError):
                    study_os_mcp.search_questions("econ-2522", query="MRS")

                # Desktop HTML injects data-study-mode="local" & data-community-api when site-pack/community.json exists
                (tmp_root / "site-pack").mkdir(parents=True, exist_ok=True)
                (tmp_root / "site-pack" / "community.json").write_text(
                    json.dumps({"api": "https://example.workers.dev"}), encoding="utf-8"
                )
                (tmp_pub / "index.html").write_text('<!doctype html><html lang="en"><body>ok</body></html>', encoding="utf-8")
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as resp:
                    html = resp.read().decode("utf-8")
                    self.assertIn('data-study-mode="local"', html)
                    self.assertIn('data-community-api="https://example.workers.dev"', html)

                # POST /api/sync-merge merges cloud backup non-destructively and deduplicates attempts/sessions
                merge_payload = json.dumps({
                    "format": "study-os-backup-v1",
                    "progress": {
                        "records": {
                            "econ-2522:q1": {"status": "done", "attempts": 3, "updatedAt": "2026-11-27T10:00:00Z"},
                        }
                    },
                    "attempts": [{"ts": "2026-11-27T10:00:00Z", "questionId": "econ-2522:q1", "sessionId": "s1", "qualityAccuracy": 1.0}],
                    "sessions": [{"sessionId": "s1", "startedAt": "2026-11-27T09:50:00Z", "activeSec": 600}],
                }).encode("utf-8")
                req1 = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/sync-merge",
                    data=merge_payload,
                    headers={"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"},
                    method="POST",
                )
                with urllib.request.urlopen(req1) as r1:
                    m1 = json.loads(r1.read().decode("utf-8"))
                    self.assertEqual(m1["mergedRecords"], 1)
                    self.assertEqual(m1["addedAttempts"], 1)
                    self.assertEqual(m1["addedSessions"], 1)
                # Second identical merge must add 0 duplicates
                req2 = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/sync-merge",
                    data=merge_payload,
                    headers={"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"},
                    method="POST",
                )
                with urllib.request.urlopen(req2) as r2:
                    m2 = json.loads(r2.read().decode("utf-8"))
                    self.assertEqual(m2["mergedRecords"], 0)
                    self.assertEqual(m2["addedAttempts"], 0)
                    self.assertEqual(m2["addedSessions"], 0)
            finally:
                study_os_mcp.BASE = prev_base
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
