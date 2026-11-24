# Study-OS Companion (VS Code / Antigravity / Cursor)

Opens any Study-OS Python/Jupyter exercise straight into VS Code, Antigravity IDE, or Cursor in real exam Jupyter Notebook format (`.ipynb`):

- **1-click deep link** from Study-OS (`antigravity://`, `vscode://`, or `cursor://`)
- **Cursor drops straight inside the first Python code cell** ready to type & run
- **Automatic BI dataset linking** (`hotel.csv`, `citybike.csv`, `london_bike.csv`, `parks.csv`, etc. — strips numeric Canvas prefixes like `155342--` so `pd.read_csv("hotel.csv")` runs on the first try)
- **Live AI-Par status bar urgency timer** right inside your IDE (turns yellow near par, red over par; click to pause/resume)

## Install (10 seconds)
1. Download `study-os-companion.vsix` from Study-OS (or run `python3 tools/study-os-vscode/build_vsix.py`).
2. In **Antigravity IDE** or **VS Code**: open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → **Extensions: Install from VSIX…** → pick `study-os-companion.vsix`.
   - Or in Terminal for VS Code: `code --install-extension study-os-companion.vsix`
3. Back in Study-OS, open any EBA 3400 coding exercise and click **Open in Antigravity / VS Code + Top AI-Par Bar**.
