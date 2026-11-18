# Make a Study-OS set with your AI

Connect Study-OS once in an AI client that supports local MCP tools. Then ask the AI to make practice cards and open the Study-OS link it returns. Preview and save the set during a break or after 20:00 Oslo time. Your saved sets are under **My study sets** on Home.

> Use the Study-OS MCP tool to make 12 original questions and answers for [topic] from my notes. Return the clickable Study-OS import link.

## Connect Study-OS

1. [Download Study-OS](https://github.com/shadjosef/study-os/archive/refs/heads/main.zip) and extract it. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) if you need it.
2. In your AI client's MCP settings, add a local stdio server named `study-os`. Set the command and arguments below. Replace the script path with the absolute path on your device.

   ```json
   {
     "command": "uv",
     "args": ["run", "--script", "/absolute/path/to/Study-OS/tools/study_os_mcp.py"]
   }
   ```

3. Connect the server and send the starter prompt. The study set tool works without starting the desktop Study-OS server. Other Study-OS tools use the desktop server for your personal reports and schedule.

## Tool contract

`draft_study_set` accepts a title of up to 80 characters and 1–30 plain-text pairs. Each pair contains the question and answer, each up to 250 characters. Use original content you have permission to share.

```json
{
  "title": "Sampling",
  "cards": [
    ["What is a population?", "The full group of interest."],
    ["What is a sample?", "The subset that is observed."]
  ]
}
```

The tool returns `title`, `cardCount`, and `importUrl`. Give the student the URL unmodified. The draft is encoded in the URL fragment and the browser removes it from the address bar after opening. Anyone with the full link can read the cards, so keep personal data and restricted content out of the draft.

The website previews the set and offers **Save to my sets**. A signed-in Community member can choose to share it during break access. These sets use a separate practice view and earn no leaderboard or Elo points.
