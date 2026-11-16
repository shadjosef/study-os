"""Two-way bridge between Study-OS and the sibling Obsidian Vault.

- Reads live Markdown reference notes and extracts exact sections for the in-app Reference Drawer.
- Generates obsidian:// deep-link URIs for 1-click jump to Obsidian Desktop.
- Writes `Obsidian Vault/01_Study_OS_Dashboard.md` (never overwrites canonical course notes!).
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import re
from typing import Any
import urllib.parse
from zoneinfo import ZoneInfo

OSLO_TZ = ZoneInfo("Europe/Oslo")


def vault_root(study_os_root: Path, data_dir: Path | None = None) -> Path:
    env_v = os.environ.get("STUDY_OS_OBSIDIAN_VAULT", "").strip()
    if env_v:
        cand = Path(env_v).expanduser().resolve()
        if cand.is_dir():
            return cand
    d_dir = data_dir or (study_os_root / "data")
    cfg_path = d_dir / "state" / "settings.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            custom_v = str(cfg.get("obsidianVaultPath") or "").strip()
            if custom_v and Path(custom_v).expanduser().is_dir():
                return Path(custom_v).expanduser().resolve()
        except Exception:
            pass
    return (study_os_root.parent / "Obsidian Vault").resolve()


def make_obsidian_uri(vault_name: str, rel_file: str, heading: str = "") -> str:
    clean_file = rel_file.replace("\\", "/")
    if clean_file.endswith(".md"):
        clean_file = clean_file[:-3]
    target = f"{clean_file}#{heading}" if heading else clean_file
    return (
        f"obsidian://open?vault={urllib.parse.quote(vault_name)}"
        f"&file={urllib.parse.quote(target)}"
    )


def strip_frontmatter(md_text: str) -> str:
    if md_text.startswith("---"):
        end = md_text.find("\n---", 3)
        if end != -1:
            after = md_text.find("\n", end + 4)
            return md_text[after + 1 :] if after != -1 else ""
    return md_text


def parse_headings(md_text: str) -> list[dict[str, Any]]:
    body = strip_frontmatter(md_text)
    lines = body.splitlines()
    headings: list[dict[str, Any]] = []
    in_code = False
    for idx, line in enumerate(lines):
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = re.match(r"^(#{1,4})\s+(.+?)\s*$", line)
        if m:
            headings.append(
                {
                    "level": len(m.group(1)),
                    "title": m.group(2).strip(),
                    "line": idx,
                }
            )
    return headings


def resolve_vault_note_path(v_root: Path | None, raw_target: str, source_rel_file: str) -> str:
    """Resolves shortest-path or subfolder wikilinks to canonical vault-relative paths."""
    clean = raw_target.replace("\\", "/").strip().lstrip("/")
    if not clean or v_root is None or not v_root.is_dir():
        return clean
    has_md = clean.lower().endswith(".md")
    stem_rel = clean[:-3] if has_md else clean
    src_dir = Path(source_rel_file).parent

    candidates = [
        v_root / f"{stem_rel}.md",
        v_root / clean,
        (v_root / src_dir / f"{stem_rel}.md").resolve(),
        (v_root / src_dir / clean).resolve(),
    ]
    # Handle legacy sub-vault prefixes like `EXC3420-support/...` -> `EXC3420-Obsidian/EXC3420-support/...`
    if src_dir.parts:
        top_folder = src_dir.parts[0]
        candidates.append((v_root / top_folder / f"{stem_rel}.md").resolve())
        candidates.append((v_root / top_folder / clean).resolve())

    for cand in candidates:
        if cand.is_file() and v_root in cand.parents:
            rel = str(cand.relative_to(v_root)).replace("\\", "/")
            return rel[:-3] if rel.lower().endswith(".md") else rel

    # Fallback: unique suffix match in vault
    target_suffix = f"/{stem_rel.lower()}.md"
    for p in v_root.rglob("*.md"):
        if ".obsidian" in p.parts:
            continue
        rel_str = str(p.relative_to(v_root)).replace("\\", "/")
        if f"/{rel_str.lower()}" .endswith(target_suffix):
            return rel_str[:-3]
    return clean


def rewrite_obsidian_markdown(
    md_text: str,
    source_rel_file: str,
    vault_name: str = "Obsidian Vault",
    v_root: Path | None = None,
) -> str:
    """Converts Obsidian ![[image]] embeds, [[Note#Heading|Label]] wikilinks, and relative Markdown images/links."""
    base_dir = str(Path(source_rel_file).parent).replace("\\", "/")
    if base_dir == ".":
        base_dir = ""

    def resolve_vault_asset(raw_target: str) -> str:
        target = urllib.parse.unquote(raw_target.split("|")[0].strip())
        encoded_target = urllib.parse.quote(target)
        encoded_base = urllib.parse.quote(base_dir)
        return f"/api/vault-asset?path={encoded_target}&from={encoded_base}"

    # 1. Image embeds ![[foo.png|caption]]
    def repl_embed(m: re.Match) -> str:
        inner = m.group(1).replace("\\|", "|")
        parts = inner.split("|", 1)
        path_part = parts[0].strip()
        alt = parts[1].strip() if len(parts) > 1 else Path(path_part).stem
        if re.search(r"\.(png|jpg|jpeg|svg|gif|webp)$", path_part, re.I):
            return f"![{alt}]({resolve_vault_asset(path_part)})"
        resolved = resolve_vault_note_path(v_root, path_part, source_rel_file)
        uri = make_obsidian_uri(vault_name, resolved)
        return f"[{alt}]({uri})"

    out = re.sub(r"!\[\[([^\]]+)\]\]", repl_embed, md_text)

    # 2. Wikilinks [[Target#Heading|Alias]]
    def repl_wikilink(m: re.Match) -> str:
        inner = m.group(1).replace("\\|", "|")
        parts = inner.split("|", 1)
        target = parts[0].strip()
        label = parts[1].strip() if len(parts) > 1 else target.lstrip("#")
        if target.startswith("#"):
            uri = make_obsidian_uri(vault_name, source_rel_file, target[1:])
        elif "#" in target:
            f_part, h_part = target.split("#", 1)
            resolved_f = resolve_vault_note_path(v_root, f_part, source_rel_file) if f_part else source_rel_file
            uri = make_obsidian_uri(vault_name, resolved_f, h_part)
        else:
            resolved_f = resolve_vault_note_path(v_root, target, source_rel_file)
            uri = make_obsidian_uri(vault_name, resolved_f)
        return f"[{label}]({uri})"

    out = re.sub(r"(?<!!)\[\[([^\]]+)\]\]", repl_wikilink, out)

    # 3. Standard relative Markdown images ![alt](figures/01-ellipse.svg)
    def repl_md_img(m: re.Match) -> str:
        alt = m.group(1)
        raw_url = m.group(2).strip()
        if raw_url.startswith(("http://", "https://", "/api/", "data:", "obsidian://")):
            return m.group(0)
        clean_path = raw_url.split("#")[0].strip()
        return f"![{alt}]({resolve_vault_asset(clean_path)})"

    out = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl_md_img, out)

    # 4. Standard relative Markdown note links [Archive audit](Archive%20audit.md)
    def repl_md_link(m: re.Match) -> str:
        label = m.group(1)
        raw_url = m.group(2).strip()
        if raw_url.startswith(("http://", "https://", "/api/", "obsidian://", "mailto:", "#", "file://")):
            return m.group(0)
        unq = urllib.parse.unquote(raw_url)
        path_part, frag = (unq.split("#", 1) + [""])[:2]
        if path_part.lower().endswith(".md"):
            resolved_f = resolve_vault_note_path(v_root, path_part, source_rel_file)
            return f"[{label}]({make_obsidian_uri(vault_name, resolved_f, frag)})"
        return m.group(0)

    out = re.sub(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)", repl_md_link, out)
    return out


def extract_reference_section(
    study_os_root: Path,
    rel_file: str,
    heading_query: str = "",
) -> dict[str, Any]:
    v_root = vault_root(study_os_root)
    clean_rel = rel_file.lstrip("/\\")
    target_path = (v_root / clean_rel).resolve()
    if not target_path.is_file() or v_root not in target_path.parents:
        return {
            "available": False,
            "error": f"Note not found in Obsidian Vault: {clean_rel}",
            "obsidianUri": make_obsidian_uri("Obsidian Vault", clean_rel, heading_query),
        }

    raw = target_path.read_text(encoding="utf-8", errors="replace")
    body = strip_frontmatter(raw)
    lines = body.splitlines()
    headings = parse_headings(raw)

    selected_heading = ""
    slice_md = ""

    if heading_query:
        q_norm = re.sub(r"\s+", " ", heading_query.strip().lower().lstrip("#").strip())
        norm_titles = [re.sub(r"\s+", " ", h["title"].lower()) for h in headings]
        match_idx = None
        # Pass 1: Exact normalized title match
        for idx, t_norm in enumerate(norm_titles):
            if t_norm == q_norm:
                match_idx = idx
                break
        # Pass 2: Query substring inside heading title
        if match_idx is None:
            for idx, t_norm in enumerate(norm_titles):
                if q_norm in t_norm:
                    match_idx = idx
                    break
        # Pass 3: Heading title inside query (only if heading is sufficiently specific)
        if match_idx is None:
            for idx, t_norm in enumerate(norm_titles):
                if len(t_norm) >= 10 and t_norm in q_norm:
                    match_idx = idx
                    break
        if match_idx is not None:
            h_obj = headings[match_idx]
            selected_heading = h_obj["title"]
            start_line = h_obj["line"]
            end_line = len(lines)
            for nxt in headings[match_idx + 1 :]:
                if nxt["level"] <= h_obj["level"]:
                    end_line = nxt["line"]
                    break
            slice_md = "\n".join(lines[start_line:end_line]).strip()

    if not slice_md:
        # Return concise overview (first ~160 lines) + full TOC so user can click any section!
        slice_md = "\n".join(lines[:160]).strip()

    rewritten = rewrite_obsidian_markdown(slice_md, clean_rel, "Obsidian Vault", v_root=v_root)
    return {
        "available": True,
        "file": clean_rel,
        "selectedHeading": selected_heading,
        "obsidianUri": make_obsidian_uri("Obsidian Vault", clean_rel, selected_heading or heading_query),
        "markdown": rewritten,
        "toc": [{"level": h["level"], "title": h["title"]} for h in headings if h["level"] <= 3][:80],
    }


def write_obsidian_dashboard(
    study_os_root: Path,
    catalog: list[dict[str, Any]],
    analytics_summary: dict[str, Any],
    calendar_blocks: list[dict[str, Any]],
    recent_sessions: list[dict[str, Any]],
) -> Path | None:
    """Writes a clean, auto-updated `01_Study_OS_Dashboard.md` inside Obsidian Vault."""
    v_root = vault_root(study_os_root)
    if not v_root.is_dir():
        return None

    now = datetime.now(OSLO_TZ)
    ov = analytics_summary.get("overall") or {}
    streak = analytics_summary.get("streakDays", 0)
    xp = analytics_summary.get("totalXp", 0)
    upi = ov.get("upi")
    upi_str = f"{upi}" if upi is not None else "—"
    beat_pct = f"{ov['beatAiRate']*100:.0f}%" if ov.get("beatAiRate") is not None else "—"
    acc_pct = f"{ov['avgAccuracy']*100:.0f}%" if ov.get("avgAccuracy") is not None else "—"

    lines = [
        "---",
        "title: Study-OS Live Dashboard",
        "tags: [study-os, dashboard, telemetry]",
        "cssclasses: [study-reference]",
        f"updated: {now.strftime('%Y-%m-%d %H:%M')}",
        "---",
        "# Study-OS · Universal Practice & Telemetry Hub",
        "",
        "> [!tip] Zero-Inertia Launch",
        "> - **Open Web App:** [Launch Study-OS (`http://127.0.0.1:8765`)](http://127.0.0.1:8765) *(or double-click `Study OS.app` / `OPEN_STUDY_OS.command` in `Study-OS/`)*",
        "> - **Canonical References:** [[00_HOME|Back to Study Home]]",
        f"> - **Live Metrics ({now.strftime('%d %b %H:%M')}):** Universal Productivity Index **`{upi_str}`** · Accuracy **`{acc_pct}`** · Beat AI Par **`{beat_pct}`** · Streak **`{streak}d`** · **`{xp} XP`**",
        "",
        "## Upcoming Google Calendar Study Blocks",
        "",
        "| Date & Time | Scheduled Block | Mode | Quick Start |",
        "|---|---|---|---|",
    ]

    now_iso = now.isoformat()
    upcoming = [b for b in calendar_blocks if b.get("endIso", "") >= now_iso and b.get("blockKind") in ("study_block", "recall_sprint")][:6]
    if upcoming:
        for b in upcoming:
            cid = b.get("courseId") or ""
            eid = urllib.parse.quote(b.get("eventId") or "")
            link = f"[Start Block ▶](http://127.0.0.1:8765/?autostart_event={eid})" if cid else "—"
            lines.append(
                f"| `{b.get('date')} {b.get('startLabel')}–{b.get('endLabel')}` | {b.get('summary','').replace('|','/')} | `{b.get('focusMinutes',50)}m` | {link} |"
            )
    else:
        lines.append("| — | *Refresh Google Calendar inside Study-OS to load upcoming blocks* | — | [Open App](http://127.0.0.1:8765) |")

    lines.extend(
        [
            "",
            "## Course Mastery & AI Pace Benchmarks",
            "",
            "| Course | Done / Total | Revisit | Due FSRS | UPI | Beat AI % | Vault Reference | Practice |",
            "|---|---:|---:|---:|---:|---:|---|---|",
        ]
    )

    by_course = (analytics_summary.get("subgroups") or {}).get("byCourse") or {}
    course_prog = analytics_summary.get("courseProgress") or {}
    for c in catalog:
        cid = c["courseId"]
        cp = course_prog.get(cid) or {}
        cm = by_course.get(cid) or {}
        ref = c.get("obsidianMainReference") or ""
        ref_link = f"[[{ref[:-3] if ref.endswith('.md') else ref}|Reference]]" if ref else "—"
        c_upi = cm.get("upi") if cm.get("upi") is not None else "—"
        c_beat = f"{cm['beatAiRate']*100:.0f}%" if cm.get("beatAiRate") is not None else "—"
        lines.append(
            f"| **{c['code']} · {c['shortTitle']}** | `{cp.get('done',0)} / {cp.get('total',0)}` | `{cp.get('revisit',0)}` | `{cp.get('dueFsrs',0)}` | `{c_upi}` | `{c_beat}` | {ref_link} | [Practice ▶](http://127.0.0.1:8765/?course={cid}) |"
        )

    corrs = analytics_summary.get("correlations") or []
    if corrs:
        lines.extend(["", "## AI Correlation Insights (Check-Ins vs Objective Performance)", ""])
        for item in corrs[:5]:
            lines.append(f"- **{item['label']}**: {item['summary']}")

    if recent_sessions:
        lines.extend(
            [
                "",
                "## Recent Logged Sessions & Micro-Journal",
                "",
                "| When | Course | Checked | UPI | Check-In (F/E/I) | Tags & Note |",
                "|---|---|---:|---:|---|---|",
            ]
        )
        for s in recent_sessions[-8:][::-1]:
            when = (s.get("endedAt") or "")[:16].replace("T", " ")
            ci = s.get("checkIn") or {}
            fei = f"`{ci.get('focus','–')}/{ci.get('energy','–')}/{ci.get('startInertia','–')}`" if ci else "—"
            tags = ", ".join(ci.get("tags") or [])
            note = (ci.get("note") or "").replace("|", "/").strip()
            combined = " · ".join(x for x in [tags, note] if x) or "—"
            lines.append(
                f"| `{when}` | `{s.get('courseId','all')}` | `{s.get('reviewedCount',0)}` | `{s.get('upi','—')}` | {fei} | {combined} |"
            )

    out_path = v_root / "01_Study_OS_Dashboard.md"
    tmp = out_path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(out_path)
    return out_path


def _extract_frontmatter_field(md_text: str, field_name: str) -> str:
    if not md_text.startswith("---"):
        return ""
    end = md_text.find("\n---", 3)
    if end == -1:
        return ""
    fm = md_text[3:end]
    m = re.search(rf"^{re.escape(field_name)}:\s*['\"]?([^'\"\n]+)['\"]?\s*$", fm, re.M | re.I)
    return m.group(1).strip() if m else ""


def discover_reference_library(
    study_os_root: Path,
    catalog: list[dict[str, Any]],
    data_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Build the Multi-Semester Reference Library across course banks + Obsidian Vault notes."""
    v_root = vault_root(study_os_root, data_dir)
    seen_files: set[str] = set()
    entries: list[dict[str, Any]] = []

    # 1. Course-linked canonical references
    for c in catalog:
        obs = c.get("obsidian") or {}
        main_ref = str(obs.get("mainReference") or c.get("obsidianMainReference") or "").strip()
        if not main_ref:
            continue
        ref_path = v_root / main_ref
        if not ref_path.is_file():
            continue
        seen_files.add(main_ref)
        raw_md = ref_path.read_text(encoding="utf-8", errors="replace")
        headings = [h for h in parse_headings(raw_md) if h["level"] <= 2]
        companions = []
        for comp_key, comp_label in (("workedExamples", "Worked Examples"), ("practiceNote", "Practice Pack")):
            comp_rel = str(obs.get(comp_key) or "").strip()
            if comp_rel and comp_rel != main_ref and (v_root / comp_rel).is_file():
                companions.append({"label": comp_label, "file": comp_rel})

        entries.append(
            {
                "id": c["courseId"],
                "courseId": c["courseId"],
                "code": c.get("code") or c["courseId"].upper(),
                "title": c.get("title") or Path(main_ref).stem,
                "shortTitle": c.get("shortTitle") or c.get("title") or Path(main_ref).stem,
                "semester": c.get("semester") or _extract_frontmatter_field(raw_md, "semester") or "Autumn 2026",
                "color": c.get("color") or "#28654d",
                "file": main_ref,
                "obsidianUri": make_obsidian_uri(obs.get("vault") or "Obsidian Vault", main_ref),
                "headingCount": len(headings),
                "headings": [h["title"] for h in headings[:24]],
                "companions": companions,
                "questionCount": c.get("questionCount", 0),
                "updatedAt": datetime.fromtimestamp(ref_path.stat().st_mtime, tz=OSLO_TZ).strftime("%Y-%m-%d"),
            }
        )

    # 2. Standalone future-semester reference sheets dropped into Obsidian Vault
    if v_root.is_dir():
        for md_file in sorted(v_root.rglob("*.md")):
            if any(part.startswith(".") or "Career" in part for part in md_file.parts):
                continue
            rel = md_file.relative_to(v_root).as_posix()
            if rel in seen_files or rel in ("00_HOME.md", "01_Study_OS_Dashboard.md", "AGENTS.md"):
                continue
            is_ref_sheet = bool(
                re.search(r"semester\s+reference", md_file.stem, re.I)
                or re.match(r"^[A-Z]{3}\s?\d{4}\s+-\s+", md_file.stem)
            )
            if not is_ref_sheet:
                continue
            raw_md = md_file.read_text(encoding="utf-8", errors="replace")
            sem = _extract_frontmatter_field(raw_md, "semester") or "Reference Library"
            code_m = re.match(r"^([A-Z]{3}\s?\d{4})\b", md_file.stem)
            code = code_m.group(1) if code_m else "REF"
            headings = [h for h in parse_headings(raw_md) if h["level"] <= 2]
            seen_files.add(rel)
            entries.append(
                {
                    "id": f"ref-{re.sub(r'[^a-z0-9]+', '-', md_file.stem.lower()).strip('-')}",
                    "courseId": "",
                    "code": code,
                    "title": md_file.stem,
                    "shortTitle": md_file.stem.split(" - ")[0],
                    "semester": sem,
                    "color": "#2c6e7f",
                    "file": rel,
                    "obsidianUri": make_obsidian_uri("Obsidian Vault", rel),
                    "headingCount": len(headings),
                    "headings": [h["title"] for h in headings[:24]],
                    "companions": [],
                    "questionCount": 0,
                    "updatedAt": datetime.fromtimestamp(md_file.stat().st_mtime, tz=OSLO_TZ).strftime("%Y-%m-%d"),
                }
            )

    return entries
