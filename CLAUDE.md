# Study-OS — Claude & AI Maintainer Entry Point

Read **`AGENTS.md`** and **`AI_AGENT_PROTOCOL.md`** in this directory before making changes.

Quick summary:
- **Zero-dependency stack**: Python 3.9+ stdlib (`app/server.py` on `http://127.0.0.1:8765`) + vanilla HTML/CSS/JS SPA (`app/public/`).
- **Live data safety**: Never reset, truncate, or write dummy test entries into `data/state/progress.json`, `data/logs/attempts.jsonl`, or `data/logs/sessions.jsonl`.
- **Reproducible course & mock-exam builders**: `tools/builders/{build_acct.py,build_acct_wiseflow_mocks.py,build_math.py,build_econ_ob_prog.py}`.
- **Mandatory post-edit validation**: `python3 tools/cli.py rebuild-catalog`.
