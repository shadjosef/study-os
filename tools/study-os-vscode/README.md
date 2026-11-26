# Study-OS Companion v0.3.1 (VS Code / Antigravity / Cursor)

Full two-way Study-OS Jupyter workflow right inside Antigravity IDE, VS Code, or Cursor:

- **1-click deep link from Study-OS** (`antigravity://`, `vscode://`, or `cursor://`) → builds or re-opens an exam-format `.ipynb` notebook with per-subpart Markdown + Python cells and drops your cursor straight into the first code cell.
- **Automatic BI CSV dataset linking** (`hotel.csv → 155342--hotel.csv`, `citybike.csv → 155349--citybike.csv`, `parks.csv → 183960--parks.csv`, etc.) so `pd.read_csv("hotel.csv")` runs on the first try.
- **Top-of-cell CodeLens HUD & per-subpart AI-Par timers:** Tracks elapsed vs. target par time per subpart (`(4.a)`, `(4.b)`, …) right above each Python cell, auto-pauses when switching notebooks or after 3 min idle, and counts live cell executions (`3/6 cells`).
- **1-click `✓ Sync to Study-OS` (Status Bar & CodeLens):** Log `Got It (100%)`, `Mostly Right (75%)`, `Needs Revisit`, or open the Worked Solution back in Study-OS — updating AI-Par pace, UPI, FSRS, Oslo Metrics, and Cloud Sync automatically.

## Install (10 seconds)
1. In **Antigravity IDE**, **VS Code**, or **Cursor**, press `Cmd+Shift+P` (`Ctrl+Shift+P` on Windows) → **Extensions: Install from VSIX…** → select `study-os-companion.vsix`.
   - Or via CLI: `code --install-extension study-os-companion.vsix`
2. Open any EBA 3400 coding exercise on `https://studyos.no/` and click **Open in Antigravity / VS Code**.
