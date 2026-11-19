# Study-OS AI Tutor (Live MCP Bridge)

Connect Study-OS once in **Codex**, **Claude Code**, **Antigravity**, or any MCP-compatible AI client. While you practice, your AI tutor automatically sees the exact exercise you have open, your current working/draft, linked PDF excerpt text, and the matching section of your study notes — without you pasting anything.

By default, the Study-OS MCP instructions guide your AI to act as a **Socratic tutor**: giving one hint or next step at a time, checking your reasoning, citing your notes or PDF page, and holding back the full solution unless you explicitly ask. During a **Blind Exam Sit**, live sharing automatically reports `"mode": "blind"` so your AI won't spoil answers.

## 1. Connect your AI client (one-time setup)

1. Start the desktop Study-OS app (`OPEN_STUDY_OS.command` on macOS or `OPEN_STUDY_OS.cmd` on Windows) so `http://127.0.0.1:8765` is running.
2. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if you don't already have it.
3. In Study-OS, open **AI tutor** from Settings or from an exercise:
   - **Codex:** click **Copy Codex settings** and paste into `~/.codex/config.toml`.
   - **Claude Code / Antigravity / Cursor / other MCP clients:** click **Copy MCP JSON** and paste into your client's MCP server config.
4. Restart or reconnect the `study-os` MCP server in your AI client.

Example MCP JSON config:

```json
{
  "mcpServers": {
    "study-os": {
      "command": "uv",
      "args": ["run", "--script", "/absolute/path/to/Study-OS/tools/study_os_mcp.py", "--port", "8765"]
    }
  }
}
```

## 2. Share your active exercise

- **Desktop Study-OS (`http://127.0.0.1:8765`):** Click **AI tutor → Share current exercise**. Sharing stays active for your current browser tab session and renews automatically while you work.
- **Hosted website (`https://shadjosef.github.io/study-os/`):** Keep the desktop Study-OS app running, then click **AI tutor → Connect desktop app** and confirm sharing in the local popup. Keep that popup open or minimized. The website relays the active exercise directly to your desktop bridge. When you ask your AI for help, your AI client may send the tool results to its model provider.

## 3. Starter tutoring prompt

Click **Copy tutor prompt** in Study-OS or paste:

> Use Study-OS `get_current_exercise` to see what I am working on. Tutor me with one next step or hint at a time. Check my working and cite the relevant notes or page when helpful. Give the full solution only if I explicitly ask.

## 4. Linking local PDFs and books (Desktop Admin)

Open **Settings → Admin** on the desktop to:

- Sync Canvas or Ed Discussion materials,
- Add local PDFs, slides, or books to a course, and
- **Link a PDF page to an exercise** (`Save source link`). Once linked, that PDF page appears beside the exercise in Study-OS and its readable text is included automatically in `get_current_exercise`.

## Available MCP tools

| Tool | Purpose |
| --- | --- |
| `get_current_exercise` | Reads the currently open exercise, your live working, linked PDF excerpt text, and matching Obsidian reference section. |
| `list_courses` / `search_questions` / `read_question` | Browse and inspect questions across your course banks (`include_answers=False` by default). |
| `read_reference` | Reads a specific section from your Obsidian reference notes. |
| `list_course_files` | Finds local Canvas and Obsidian sources by title and returns their IDs. |
| `read_course_file` | Reads targeted PDF pages, slide text, notebooks, CSVs and text from the selected course. Use the original viewer for scans and figures. |
| `study_report` | Reads your current progress, accuracy, FSRS review queue, and weak topics. |
| `read_schedule` / `preview_schedule` / `replace_study_schedule` | Inspects or updates your Study-OS schedule (only when you ask). |
| `draft_study_set` | Creates a 1-click Study-OS import link for 1–30 original study cards. |
