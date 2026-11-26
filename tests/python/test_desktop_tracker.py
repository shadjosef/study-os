"""Isolated zero-dependency unit & HTTP tests for Study-OS Desktop Telemetry & Focus Shield.

All tests run inside `tempfile.TemporaryDirectory()` with mocked OS probes and hide callbacks.
They NEVER read from or write to live `data/` and NEVER hide real user applications.
"""
from __future__ import annotations

import ast
from datetime import datetime, timedelta
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
APP_DIR = REPO_ROOT / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import desktop_tracker  # noqa: E402
from desktop_tracker import DesktopTracker, compute_payload_sha256, compute_source_sha256  # noqa: E402
import server as study_server  # noqa: E402

OSLO_TZ = ZoneInfo("Europe/Oslo")


class TestDesktopTrackerUnit(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name).resolve() / "data"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_zero_network_or_spyware_imports_in_source(self) -> None:
        """Audit AST of app/desktop_tracker.py to verify zero networking imports."""
        src_path = APP_DIR / "desktop_tracker.py"
        tree = ast.parse(src_path.read_text(encoding="utf-8"))
        forbidden_roots = {
            "urllib",
            "http",
            "socket",
            "ssl",
            "ftplib",
            "smtplib",
            "requests",
            "httpx",
            "aiohttp",
            "pynput",
            "pyautogui",
            "PIL",
            "mss",
        }
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertTrue(
            imported.isdisjoint(forbidden_roots),
            f"Forbidden imports detected in desktop_tracker.py: {imported & forbidden_roots}",
        )

    def test_off_by_default_and_never_starts_thread_or_records(self) -> None:
        probe_calls = 0

        def fake_probe() -> tuple[str | None, float]:
            nonlocal probe_calls
            probe_calls += 1
            return ("Code", 0.0)

        tracker = DesktopTracker(
            data_dir=self.data_dir,
            probe_fn=fake_probe,
            hide_fn=lambda _: True,
            platform_name="darwin",
        )
        try:
            st = tracker.status()
            self.assertTrue(st["available"])
            self.assertFalse(st["enabled"])
            self.assertFalse(st["paused"])
            self.assertFalse(st["focusShieldEnabled"])
            self.assertFalse(st["sessionActive"])
            self.assertFalse(tracker.is_running())
            self.assertEqual(st["today"]["totalSec"], 0.0)
            self.assertEqual(st["audit"]["networkCalls"], 0)
            self.assertFalse(st["audit"]["keylogging"])
            self.assertFalse(st["audit"]["screenshots"])

            res = tracker.sample_once(delta_sec=10.0)
            self.assertFalse(res["recorded"])
            self.assertEqual(res["reason"], "disabled")
            self.assertEqual(probe_calls, 0)
            self.assertFalse(tracker.log_path.exists())
        finally:
            tracker.stop()

    def test_opt_in_recording_classification_idle_and_60s_jsonl_flush(self) -> None:
        samples = [
            ("Code", 0.0),
            ("Obsidian", 2.0),
            ("Google Chrome", 5.0),
            ("Discord", 1.0),
            ("Finder", 0.0),
            ("Code", 95.0),  # Idle >= 60s -> recorded as idleSec, NOT Code
        ]
        idx = 0

        def fake_probe() -> tuple[str | None, float]:
            nonlocal idx
            item = samples[idx]
            idx += 1
            return item

        tracker = DesktopTracker(
            data_dir=self.data_dir,
            probe_fn=fake_probe,
            hide_fn=lambda _: True,
            platform_name="darwin",
            flush_interval_sec=60.0,
            auto_start=False,
        )
        base = datetime(2026, 11, 26, 10, 0, 0, tzinfo=OSLO_TZ)
        tracker.update_config({"enabled": True})

        for i in range(len(samples)):
            r = tracker.sample_once(delta_sec=10.0, now=base + timedelta(seconds=i * 10))
            self.assertTrue(r["recorded"])
            self.assertFalse(r["shieldTriggered"])

        # 6 samples * 10s = 60s -> automatically flushed to desktop_activity.jsonl
        self.assertTrue(tracker.log_path.is_file())
        lines = [json.loads(line) for line in tracker.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        row = lines[0]
        self.assertEqual(row["day"], "2026-11-26")
        self.assertEqual(row["windowSec"], 60.0)
        self.assertEqual(row["activeSec"], 50.0)
        self.assertEqual(row["idleSec"], 10.0)
        self.assertEqual(row["byCategory"]["deep_study"], 10.0)
        self.assertEqual(row["byCategory"]["reading_notes"], 10.0)
        self.assertEqual(row["byCategory"]["browser"], 10.0)
        self.assertEqual(row["byCategory"]["distraction"], 10.0)
        self.assertEqual(row["byCategory"]["other"], 10.0)
        # Ensure zero window titles or unexpected keys exist in JSONL
        self.assertNotIn("windowTitle", row)

        st = tracker.status(now=base + timedelta(seconds=60))
        self.assertEqual(st["today"]["totalSec"], 60.0)
        self.assertEqual(st["today"]["activeSec"], 50.0)
        self.assertEqual(st["today"]["idleSec"], 10.0)
        top_names = {entry["app"] for entry in st["today"]["topApps"]}
        self.assertEqual(top_names, {"Code", "Obsidian", "Google Chrome", "Discord", "Finder"})

    def test_pause_incognito_suppresses_recording_and_shield(self) -> None:
        hidden_apps: list[str] = []
        probe_calls = 0

        def fake_probe() -> tuple[str | None, float]:
            nonlocal probe_calls
            probe_calls += 1
            return ("Discord", 0.0)

        tracker = DesktopTracker(
            data_dir=self.data_dir,
            probe_fn=fake_probe,
            hide_fn=lambda app: (hidden_apps.append(app) or True),
            platform_name="darwin",
            shield_cooldown_sec=0.0,
            auto_start=False,
        )
        tracker.update_config(
            {
                "enabled": True,
                "paused": True,
                "focusShieldEnabled": True,
                "sessionActive": True,
            }
        )
        res = tracker.sample_once(delta_sec=15.0)
        self.assertFalse(res["recorded"])
        self.assertEqual(res["reason"], "paused")
        self.assertFalse(res["shieldTriggered"])
        self.assertEqual(probe_calls, 0)
        self.assertEqual(hidden_apps, [])
        self.assertEqual(tracker.status()["today"]["totalSec"], 0.0)

    def test_focus_shield_triggers_only_when_all_guards_hold(self) -> None:
        hidden_apps: list[str] = []
        current_sample: list[tuple[str | None, float]] = [("Discord", 0.0)]

        tracker = DesktopTracker(
            data_dir=self.data_dir,
            probe_fn=lambda: current_sample[0],
            hide_fn=lambda app: (hidden_apps.append(app) or True),
            platform_name="darwin",
            shield_cooldown_sec=0.0,
            auto_start=False,
        )
        now = datetime(2026, 11, 26, 11, 0, 0, tzinfo=OSLO_TZ)

        # 1. enabled=True, focusShieldEnabled=False, sessionActive=True -> must NOT hide
        tracker.update_config({"enabled": True, "focusShieldEnabled": False, "sessionActive": True, "paused": False})
        r1 = tracker.sample_once(delta_sec=5.0, now=now)
        self.assertFalse(r1["shieldTriggered"])
        self.assertEqual(hidden_apps, [])

        # 2. focusShieldEnabled=True, sessionActive=False (on break!) -> must NOT hide
        tracker.update_config({"focusShieldEnabled": True, "sessionActive": False})
        r2 = tracker.sample_once(delta_sec=5.0, now=now + timedelta(seconds=5))
        self.assertFalse(r2["shieldTriggered"])
        self.assertEqual(hidden_apps, [])

        # 3. All armed, but app is deep_study ("Code") -> must NOT hide
        tracker.update_config({"sessionActive": True})
        current_sample[0] = ("Code", 0.0)
        r3 = tracker.sample_once(delta_sec=5.0, now=now + timedelta(seconds=10))
        self.assertFalse(r3["shieldTriggered"])
        self.assertEqual(hidden_apps, [])

        # 4. All armed, app is Discord, but user is idle (>= 60s) -> must NOT hide
        current_sample[0] = ("Discord", 75.0)
        r4 = tracker.sample_once(delta_sec=5.0, now=now + timedelta(seconds=15))
        self.assertFalse(r4["shieldTriggered"])
        self.assertEqual(hidden_apps, [])

        # 5. All armed + active + distraction app ("Discord") -> MUST hide!
        current_sample[0] = ("Discord", 0.0)
        r5 = tracker.sample_once(delta_sec=5.0, now=now + timedelta(seconds=20))
        self.assertTrue(r5["shieldTriggered"])
        self.assertEqual(hidden_apps, ["Discord"])

        # 6. Pause toggled ON -> must NOT hide again
        tracker.update_config({"paused": True})
        r6 = tracker.sample_once(delta_sec=5.0, now=now + timedelta(seconds=25))
        self.assertFalse(r6["shieldTriggered"])
        self.assertEqual(hidden_apps, ["Discord"])

    def test_linux_probe_is_clean_noop(self) -> None:
        self.assertEqual(desktop_tracker.probe_os_activity("linux"), (None, 0.0))
        self.assertFalse(desktop_tracker.hide_application("Discord", "linux"))

    def test_export_audit_bundle_sha256_verification(self) -> None:
        tracker = DesktopTracker(
            data_dir=self.data_dir,
            probe_fn=lambda: ("PyCharm", 0.0),
            hide_fn=lambda _: True,
            platform_name="darwin",
            auto_start=False,
        )
        now = datetime(2026, 11, 26, 14, 0, 0, tzinfo=OSLO_TZ)
        tracker.update_config({"enabled": True})
        tracker.sample_once(delta_sec=30.0, now=now)

        bundle = tracker.export_audit_bundle(now=now + timedelta(seconds=30))
        self.assertEqual(bundle["schemaVersion"], "study-os-desktop-telemetry-v1")
        self.assertEqual(bundle["source"]["path"], "app/desktop_tracker.py")
        expected_src_hash = hashlib.sha256((APP_DIR / "desktop_tracker.py").read_bytes()).hexdigest()
        self.assertEqual(bundle["source"]["sha256"], expected_src_hash)
        self.assertEqual(bundle["source"]["sha256"], compute_source_sha256())
        self.assertEqual(bundle["summary"]["activeSec"], 30.0)
        self.assertEqual(len(bundle["dailyRollups"]), 1)
        self.assertEqual(bundle["topApps"][0]["app"], "PyCharm")
        self.assertEqual(bundle["topApps"][0]["category"], "deep_study")

        # Independently verify canonical payloadSha256
        claimed = bundle["payloadSha256"]
        self.assertEqual(claimed, bundle["integrity"]["payloadSha256"])
        unsigned = {k: v for k, v in bundle.items() if k not in ("integrity", "payloadSha256")}
        self.assertEqual(compute_payload_sha256(unsigned), claimed)

        # Tampering with a single field must break payloadSha256 verification
        tampered = json.loads(json.dumps(unsigned))
        tampered["summary"]["activeSec"] = 9999.0
        self.assertNotEqual(compute_payload_sha256(tampered), claimed)


class TestDesktopEndpointsHttp(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name).resolve()
        self.tmp_root = self.tmp_path / "root"
        self.tmp_data = self.tmp_path / "data"
        self.tmp_public = self.tmp_path / "public"
        self.tmp_public.mkdir(parents=True)
        (self.tmp_public / "index.html").write_text("<!doctype html><h1>Test</h1>", encoding="utf-8")

        self.store = study_server.StudyStore(self.tmp_root, data_dir=self.tmp_data)
        self.tracker = DesktopTracker(
            data_dir=self.tmp_data,
            probe_fn=lambda: ("Code", 0.0),
            hide_fn=lambda _: True,
            platform_name="darwin",
            sample_interval_sec=0.2,
            flush_interval_sec=60.0,
            auto_start=True,
        )
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), study_server.StudyOSHandler)
        self.httpd.store = self.store  # type: ignore[attr-defined]
        self.httpd.public_dir = self.tmp_public  # type: ignore[attr-defined]
        self.httpd.desktop_tracker = self.tracker  # type: ignore[attr-defined]
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self) -> None:
        self.tracker.stop()
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(timeout=5)
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

    def test_status_config_export_and_security_guards(self) -> None:
        origin_hdr = {
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{self.port}",
        }

        # 1. GET /api/desktop/status defaults to OFF
        st, hdrs, raw = self._request("GET", "/api/desktop/status")
        self.assertEqual(st, 200)
        self._assert_security_headers(hdrs)
        data = json.loads(raw)
        self.assertTrue(data["available"])
        self.assertFalse(data["enabled"])
        self.assertEqual(data["audit"]["sourcePath"], "app/desktop_tracker.py")
        self.assertEqual(data["audit"]["sourceSha256"], compute_source_sha256())
        self.assertEqual(data["audit"]["networkCalls"], 0)
        self.assertFalse(data["audit"]["keylogging"])
        self.assertFalse(data["audit"]["screenshots"])

        # 2. Cross-origin POST -> 403, cross-site GET -> 403, invalid Host -> 403
        st_csrf, _, _ = self._request(
            "POST",
            "/api/desktop/config",
            body=json.dumps({"enabled": True}).encode(),
            headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        )
        self.assertEqual(st_csrf, 403)

        st_xget, _, _ = self._request(
            "GET",
            "/api/desktop/status",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(st_xget, 403)

        st_host, _, _ = self._request(
            "GET",
            "/api/desktop/status",
            headers={"Host": f"evil.example:{self.port}"},
        )
        self.assertEqual(st_host, 403)

        # 3. Invalid config bodies -> 400 (non-boolean, unknown key, invalid list)
        for bad_body in [
            {"enabled": "yes"},
            {"paused": 1},
            {"focusShieldEnabled": "true"},
            {"distractionApps": "Discord"},
            {"categories": {"bogus": ["Code"]}},
            {"unknownField": True},
        ]:
            st_bad, hdrs_bad, raw_bad = self._request(
                "POST",
                "/api/desktop/config",
                body=json.dumps(bad_body).encode(),
                headers=origin_hdr,
            )
            self.assertEqual(st_bad, 400, f"Expected 400 for {bad_body}, got {st_bad}")
            self._assert_security_headers(hdrs_bad)
            self.assertIn("error", json.loads(raw_bad))
            self.assertNotIn(b"Traceback", raw_bad)

        # 4. Valid POST /api/desktop/config enables tracker & persists atomically to temp data_dir
        st_on, _, raw_on = self._request(
            "POST",
            "/api/desktop/config",
            body=json.dumps(
                {
                    "enabled": True,
                    "focusShieldEnabled": True,
                    "sessionActive": True,
                    "distractionApps": ["Discord", "Steam"],
                }
            ).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_on, 200)
        on_data = json.loads(raw_on)
        self.assertTrue(on_data["enabled"])
        self.assertTrue(on_data["focusShieldEnabled"])
        self.assertTrue(on_data["sessionActive"])
        self.assertEqual(on_data["config"]["distractionApps"], ["Discord", "Steam"])
        self.assertTrue((self.tmp_data / "state" / "desktop_tracker_config.json").is_file())
        self.assertTrue(self.tracker.is_running())

        # Record a deterministic sample and disable cleanly
        self.tracker.sample_once(delta_sec=20.0)
        st_off, _, raw_off = self._request(
            "POST",
            "/api/desktop/config",
            body=json.dumps({"enabled": False}).encode(),
            headers=origin_hdr,
        )
        self.assertEqual(st_off, 200)
        self.assertFalse(json.loads(raw_off)["enabled"])
        self.assertFalse(self.tracker.is_running())

        # 5. GET /api/desktop/export returns verifiable attachment JSON with matching SHA-256
        st_exp, hdrs_exp, raw_exp = self._request("GET", "/api/desktop/export")
        self.assertEqual(st_exp, 200)
        self._assert_security_headers(hdrs_exp)
        self.assertIn(
            'attachment; filename="study-os-desktop-telemetry.json"',
            hdrs_exp.get("content-disposition", ""),
        )
        bundle = json.loads(raw_exp)
        self.assertEqual(bundle["source"]["sha256"], compute_source_sha256())
        unsigned = {k: v for k, v in bundle.items() if k not in ("integrity", "payloadSha256")}
        self.assertEqual(compute_payload_sha256(unsigned), bundle["payloadSha256"])
        self.assertGreaterEqual(bundle["summary"]["activeSec"], 20.0)

    def test_turnkey_bundled_public_courses_and_references_without_data_dir(self) -> None:
        import urllib.parse

        with tempfile.TemporaryDirectory() as td:
            empty_data = Path(td) / "data"
            bundled_store = study_server.StudyStore(REPO_ROOT, data_dir=empty_data)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), study_server.StudyOSHandler)
            httpd.store = bundled_store
            httpd.public_dir = REPO_ROOT / "app" / "public"
            port = httpd.server_address[1]
            t = threading.Thread(target=httpd.serve_forever, daemon=True)
            t.start()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                conn.request("GET", "/api/bootstrap")
                resp = conn.getresponse()
                raw_boot = resp.read()
                self.assertEqual(resp.status, 200)
                boot = json.loads(raw_boot)
                cids = {c["courseId"] for c in boot.get("catalog", [])}
                self.assertTrue({"acct-2527", "econ-2522", "math-2588", "ob-2537", "prog-3021"}.issubset(cids))
                self.assertGreaterEqual(len(boot.get("references", [])), 5)

                first_ref_file = boot["references"][0]["file"]
                conn.request("GET", f"/api/obsidian/section?file={urllib.parse.quote(first_ref_file)}")
                resp2 = conn.getresponse()
                sec_data = json.loads(resp2.read())
                self.assertEqual(resp2.status, 200)
                self.assertTrue(sec_data.get("available"))
                self.assertGreater(len(sec_data.get("markdown", "")), 500)

                conn.request("GET", "/static-data/vault-assets/../../community/worker.mjs")
                resp3 = conn.getresponse()
                resp3.read()
                self.assertIn(resp3.status, (400, 403, 404))
                conn.close()
            finally:
                bundled_store.stop_desktop_tracker()
                httpd.shutdown()
                httpd.server_close()
                t.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
