"""Local live exercise sharing and question source links."""
from __future__ import annotations

import re
import threading
import time
from typing import Any


class LiveTutor:
    def __init__(self) -> None:
        self.views: dict[str, tuple[float, float, dict[str, Any]]] = {}
        self.lock = threading.Lock()

    def recent(self, now: float) -> None:
        self.views = {key: item for key, item in self.views.items() if now - item[0] < 45}

    def update(self, body: dict[str, Any]) -> None:
        tab = body.get("tab")
        activity = body.get("activity")
        state = body.get("state")
        if not isinstance(tab, str) or not re.fullmatch(r"[a-f0-9-]{36}", tab):
            raise ValueError("Invalid tab identifier.")
        if type(activity) is not int or not 0 <= activity <= int(time.time() * 1000) + 300_000:
            raise ValueError("Invalid tutor update time.")
        if not isinstance(state, dict) or state.get("mode") not in ("practice", "blind", "waiting"):
            raise ValueError("Invalid tutor state.")
        if state["mode"] == "practice":
            fields = {"courseId": 80, "questionId": 180, "course": 240, "title": 500,
                      "context": 95_000, "noteFile": 1024, "noteHeading": 512}
            if not state.get("courseId") or not state.get("questionId"):
                raise ValueError("The exercise is missing its course or question ID.")
            for key, max_length in fields.items():
                value = state.get(key, "")
                if not isinstance(value, str) or len(value) > max_length:
                    raise ValueError("The exercise context is too large.")
            state = {key: state[key] for key in (*fields, "mode") if key in state}
        else:
            state = {"mode": state["mode"]}
        with self.lock:
            now = time.monotonic()
            self.recent(now)
            previous = self.views.get(tab)
            if previous and (activity < previous[1] or (activity == previous[1] and previous[2]["mode"] == "waiting")):
                return
            self.views[tab] = (now, activity, state)
            if len(self.views) > 16:
                oldest = min(self.views, key=lambda key: self.views[key][0])
                self.views.pop(oldest)

    def current(self) -> dict[str, Any]:
        with self.lock:
            self.recent(time.monotonic())
            latest = max((item for item in self.views.values() if item[2]["mode"] != "waiting"),
                         key=lambda item: item[1], default=None)
            return latest[2] if latest else {"mode": "waiting"}


def with_source_links(bank: dict, links: dict) -> dict:
    if not links:
        return bank
    return {**bank, "questions": [
        {**question, "extraReference": links[question["id"]]} if question["id"] in links else question
        for question in bank.get("questions", [])
    ]}
