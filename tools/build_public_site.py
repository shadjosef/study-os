#!/usr/bin/env python3
"""Build a Static Public Web Bundle (`dist/`) of Study-OS for GitHub Pages / Custom Domains.

Bundles:
  1. The zero-build Study-OS Single-Page App (`app/public/*`).
  2. Multi-Semester Reference Sheets (`Obsidian Vault` Markdown + SVG diagrams),
     rewriting `/api/vault-asset` image links to static `./static-data/vault-assets/...`.
  3. Copyright-safe Practice & WISEflow FLOWmulti Simulator banks (`synthetic_drill`
     and `mock_exam` items without copyrighted PDF crops, plus `examples/demo-course`).
  4. Zero personal student progress, logs, or calendar events (each visitor's progress
     persists privately in their own browser's `localStorage`).

Usage:
  python3 tools/build_public_site.py                    # Builds ./dist
  python3 tools/build_public_site.py --cname studyos.me # Also writes ./dist/CNAME
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html import escape
import json
from pathlib import Path
import re
import shutil
import sys
from typing import Any
from urllib.parse import quote, unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

ROOT_DIR = Path(__file__).resolve().parent.parent
APP_DIR = ROOT_DIR / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from dlpfc import classify_intrinsic_dlpfc  # noqa: E402
from obsidian_sync import (  # noqa: E402
    discover_reference_library,
    parse_headings,
    rewrite_obsidian_markdown,
    strip_frontmatter,
    vault_root,
)
from server import STORE, merge_course_practice  # noqa: E402


def ref_slug(rel_file: str) -> str:
    stem = re.sub(r"\.md$", "", rel_file, flags=re.I).lower()
    return re.sub(r"[^a-z0-9]+", "-", stem).strip("-")


def rewrite_static_vault_assets(
    md_text: str,
    source_rel_file: str,
    v_root: Path,
    out_vault_assets_dir: Path,
) -> str:
    """Copy referenced Vault SVG/image assets into `dist/static-data/vault-assets/` and rewrite URLs."""
    rewritten = rewrite_obsidian_markdown(md_text, source_rel_file, v_root=v_root)

    def _replace_api_asset(m: re.Match[str]) -> str:
        alt = m.group(1)
        qs = m.group(2)
        params: dict[str, str] = {}
        for part in qs.split("&"):
            if "=" in part:
                k, v = part.split("=", 1)
                from urllib.parse import unquote
                params[k] = unquote(v)
        rel_path = params.get("path", "").lstrip("/\\")
        from_dir = params.get("from", "")
        candidates = []
        if from_dir:
            candidates.append((v_root / from_dir / rel_path).resolve())
        candidates.append((v_root / rel_path).resolve())
        resolved: Path | None = None
        for cand in candidates:
            if cand.is_file() and v_root in cand.parents:
                resolved = cand
                break
        if not resolved and rel_path:
            fname = Path(rel_path).name
            for hit in v_root.rglob(fname):
                if hit.is_file() and ".obsidian" not in hit.parts:
                    resolved = hit
                    break
        if not resolved:
            return m.group(0)
        rel_in_vault = resolved.relative_to(v_root).as_posix()
        dst = out_vault_assets_dir / rel_in_vault
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(resolved, dst)
        return f"![{alt}](./static-data/vault-assets/{rel_in_vault})"

    return re.sub(r"!\[([^\]]*)\]\(/api/vault-asset\?([^)]+)\)", _replace_api_asset, rewritten)


SOLUTION_DOC_RE = re.compile(
    r"solution|guideline|evaluation|examiner\s*guide|marking|eba11805l\.pdf|20\d\d[hv]_.*l\.pdf",
    re.I,
)
BOOK_SOURCE_RE = re.compile(r"textbook|atrill|mclaney|/Books/", re.I)


def build_question_provenance(q: dict[str, Any], collections_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Attach explicit, honest provenance & LLM attribution metadata to every question."""
    origin = str(q.get("origin") or "")
    col_id = str(q.get("collectionId") or "")
    col_title = str((collections_by_id.get(col_id) or {}).get("title") or col_id)
    explicit_model = q.get("generatedBy") or q.get("llmModel")

    if origin == "original_exam":
        return {
            "category": "past_exam",
            "label": "Past Exam",
            "synthetic": False,
            "llmModel": None,
            "sourceDetail": col_title,
        }
    if origin == "tutoring":
        return {
            "category": "tutoring",
            "label": "Tutoring Session",
            "synthetic": False,
            "llmModel": None,
            "sourceDetail": col_title,
        }
    if origin == "lecture":
        return {
            "category": "lecture",
            "label": "Lecture Set",
            "synthetic": False,
            "llmModel": None,
            "sourceDetail": col_title,
        }
    if origin == "reading_submission":
        return {
            "category": "reading",
            "label": "Reading Task",
            "synthetic": False,
            "llmModel": None,
            "sourceDetail": col_title,
        }
    if origin == "textbook":
        return {
            "category": "book",
            "label": "Book Exercise",
            "synthetic": False,
            "llmModel": None,
            "sourceDetail": col_title or "Atrill & McLaney (12th ed.)",
        }
    if origin == "mock_exam":
        if explicit_model:
            llm = str(explicit_model)
        elif col_id == "WF-MOCK-D":
            llm = "Gemini (Antigravity)"
        elif re.fullmatch(r"WF-MOCK-[ABC]", col_id):
            llm = "AI Builder + Gemini (Antigravity format)"
        else:
            llm = "LLM-generated (legacy — model unlogged)"
        return {
            "category": "ai_mock",
            "label": "AI Mock Exam",
            "synthetic": True,
            "llmModel": llm,
            "sourceDetail": col_title,
        }
    if origin == "synthetic_drill":
        llm = str(explicit_model) if explicit_model else "LLM-generated (legacy — model unlogged)"
        return {
            "category": "ai_synthetic",
            "label": "AI Synthetic",
            "synthetic": True,
            "llmModel": llm,
            "sourceDetail": col_title,
        }
    return {
        "category": "exercise",
        "label": "BI Exercise",
        "synthetic": False,
        "llmModel": None,
        "sourceDetail": col_title,
    }


def sanitize_public_sources(bank: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Convert raw local source paths into copyright-safe metadata & BI Canvas file pointers."""
    canvas_course_id = str(bank.get("canvasId") or "").strip()
    out: dict[str, dict[str, Any]] = {}
    for sid, meta in (bank.get("sources") or {}).items():
        if not isinstance(meta, dict):
            continue
        title = str(meta.get("title") or sid).strip()
        cpath = str(meta.get("canvasPath") or "").strip()
        vpath = str(meta.get("vaultPath") or "").strip()
        raw_path = cpath or vpath
        raw_name = Path(raw_path).name if raw_path else title
        id_match = re.match(r"^(\d{4,10})--(.+)$", raw_name)
        canvas_file_id = id_match.group(1) if id_match else ""
        clean_filename = id_match.group(2) if id_match else raw_name
        if "CliffsNotes" in clean_filename:
            clean_filename = "EXC_3430_Exam_2023.pdf"

        # Detect publisher textbook vs BI Canvas material (double-entry bookkeeping slides stay canvas)
        is_book = bool(
            (sid.lower().startswith("textbook") or "atrill" in title.lower() or "/Books/" in raw_path)
            and "excurse" not in title.lower()
        )
        kind = "book" if is_book else "canvas"
        canvas_url = ""
        if kind == "canvas":
            if canvas_course_id and canvas_file_id:
                canvas_url = f"https://canvas.bi.no/courses/{canvas_course_id}/files/{canvas_file_id}"
            elif canvas_course_id:
                canvas_url = f"https://canvas.bi.no/courses/{canvas_course_id}/files"
        is_solution = bool(SOLUTION_DOC_RE.search(f"{title} {clean_filename}"))
        out[str(sid)] = {
            "id": str(sid),
            "title": title,
            "filename": clean_filename,
            "kind": kind,
            "canvasCourseId": canvas_course_id if kind == "canvas" else "",
            "canvasFileId": canvas_file_id if kind == "canvas" else "",
            "canvasUrl": canvas_url,
            "isSolution": is_solution,
        }
    return out


def build_question_source_refs(
    q: dict[str, Any],
    public_sources: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build copyright-free source reference pointers (book pages / Canvas PDFs) without raw PDFs or image crops."""
    refs: list[dict[str, Any]] = []
    seen: set[tuple[str, int, str]] = set()

    def add_ref(sid: str, page: int, role: str, caption: str = "") -> None:
        meta = public_sources.get(str(sid))
        if not meta:
            return
        pg = max(1, int(page or 1))
        key = (meta["id"], pg, role)
        if key in seen:
            return
        seen.add(key)
        is_sol = role == "solution" or bool(meta.get("isSolution"))
        refs.append({
            "sourceId": meta["id"],
            "kind": meta["kind"],
            "title": meta["title"],
            "filename": meta["filename"],
            "page": pg,
            "role": role,
            "caption": caption or f"{meta['title']} · p. {pg}",
            "canvasCourseId": meta.get("canvasCourseId", ""),
            "canvasFileId": meta.get("canvasFileId", ""),
            "canvasUrl": meta.get("canvasUrl", ""),
            "isSolution": is_sol,
        })

    for role, field in (("context", "contextAssets"), ("prompt", "promptAssets"), ("solution", "solutionAssets")):
        for item in q.get(field) or []:
            if isinstance(item, dict) and item.get("sourceId"):
                add_ref(str(item["sourceId"]), int(item.get("page") or 1), role, str(item.get("caption") or ""))

    if q.get("sourceId") and str(q["sourceId"]) in public_sources:
        add_ref(str(q["sourceId"]), 1, "prompt")
    if q.get("solutionSourceId") and str(q["solutionSourceId"]) in public_sources:
        add_ref(str(q["solutionSourceId"]), 1, "solution")
    if not refs and q.get("collectionId"):
        col_id = str(q["collectionId"])
        col_source_aliases = {
            "sample-exam": "SAMPLE",
            "lesson-8": "L8",
            "tech-structure": "TECH",
            "diagnostics": "SLIDES",
            "debugging-practice": "DEBUG",
            "official-mock": "OFFMOCK",
            "pandas-viz-exam2": "L16_TS",
        }
        mapped_sid = col_id if col_id in public_sources else col_source_aliases.get(col_id, "")
        if mapped_sid and mapped_sid in public_sources:
            add_ref(mapped_sid, 1, "prompt")
    return refs


def filter_public_safe_bank(bank: dict[str, Any]) -> dict[str, Any] | None:
    """Build copyright-safe open bank for ALL users (signed-in & demo) with provenance & Canvas/BYOB source pointers.

    - Includes all structured questions across BI Past Exams, Exercises, Tutoring, Lectures, Readings,
      Textbook Study Index, and clearly labeled AI Mocks / Synthetics.
    - Strips ALL raw PDFs, slides, PNG page crops, local filesystem paths, and verbatim textbook prose.
    - Attaches explicit `provenance` (category + LLM model) and copyright-free `sourceRefs` so students
      unlock readable BI PDFs via Canvas Sync or drop their own textbook PDF locally in-browser.
    """
    raw_colls = bank.get("collections") or []
    collections_by_id = {str(c.get("id")): c for c in raw_colls if isinstance(c, dict) and c.get("id")}
    public_sources = sanitize_public_sources(bank)

    category_order = {
        "past_exam": 0,
        "exercise": 1,
        "tutoring": 1,
        "lecture": 2,
        "reading": 2,
        "book": 3,
        "ai_mock": 4,
        "ai_synthetic": 5,
    }

    safe_qs: list[dict[str, Any]] = []
    for q in bank.get("questions") or []:
        if not q.get("available", True):
            continue
        q_clean = dict(q)
        prov = build_question_provenance(q_clean, collections_by_id)
        refs = build_question_source_refs(q_clean, public_sources)

        # Remove copyrighted PDF/image crop paths & backend file refs
        q_clean["promptAssets"] = []
        q_clean["contextAssets"] = []
        q_clean["solutionAssets"] = []
        q_clean.pop("extraReference", None)
        q_clean["sources"] = {}
        q_clean["provenance"] = prov
        if refs:
            q_clean["sourceRefs"] = refs

        # Never redistribute verbatim textbook publisher text (Atrill & McLaney / Pearson)
        if prov["category"] == "book":
            book_ref = next((r for r in refs if r["kind"] == "book" and r["role"] != "solution"), None)
            sol_ref = next((r for r in refs if r["kind"] == "book" and r["role"] == "solution"), None)
            book_title = (book_ref or sol_ref or {}).get("title") or "Atrill & McLaney · Accounting and Finance for Non-Specialists (12th ed.)"
            p_hint = f"p. {book_ref['page']}" if book_ref else "matching chapter"
            s_hint = f" (answer reference: p. {sol_ref['page']})" if sol_ref else ""
            q_clean["promptMarkdown"] = (
                f"Complete **{q_clean.get('title') or q_clean.get('localId') or 'this textbook exercise'}** "
                f"from *{book_title}* (**{p_hint}**{s_hint}).\n\n"
                f"Use the **Source Context** dropzone below to attach your own PDF copy of the textbook — "
                f"Study-OS will jump straight to **{p_hint}** locally in your browser without uploading the file."
            )
            if not q_clean.get("solutionMarkdown") or len(str(q_clean.get("solutionMarkdown") or "")) > 520:
                sol_pg = f" (**p. {sol_ref['page']}**)" if sol_ref else ""
                q_clean["solutionMarkdown"] = (
                    f"Compare your working against the printed textbook answer in *{book_title}*"
                    f"{sol_pg} via your local PDF copy."
                )

        safe_qs.append(q_clean)

    if not safe_qs:
        return None

    # Sort collections so Official BI Past Exams & Course Sets always appear BEFORE AI Mocks / Synthetics
    used_colls = {q.get("collectionId") for q in safe_qs}
    coll_rank_map: dict[str, tuple[int, dict[str, Any]]] = {}
    for q in safe_qs:
        cid = str(q.get("collectionId") or "")
        p = q["provenance"]
        r = category_order.get(p["category"], 3)
        if cid not in coll_rank_map or r < coll_rank_map[cid][0]:
            coll_rank_map[cid] = (r, p)

    enriched_colls: list[dict[str, Any]] = []
    for idx, c in enumerate(raw_colls):
        cid = str(c.get("id") or "")
        if cid not in used_colls:
            continue
        c_copy = dict(c)
        rank, prov = coll_rank_map.get(cid, (3, {"category": "exercise", "label": "BI Exercise", "synthetic": False, "llmModel": None}))
        c_copy["provenance"] = {
            "category": prov["category"],
            "label": prov["label"],
            "synthetic": prov["synthetic"],
            "llmModel": prov["llmModel"],
        }
        c_copy["_sortKey"] = (rank, idx)
        enriched_colls.append(c_copy)
    enriched_colls.sort(key=lambda c: c.pop("_sortKey"))

    out = dict(bank)
    out["collections"] = enriched_colls
    out["sources"] = public_sources
    out["questions"] = safe_qs
    return out


def build_catalog_entry(bank: dict[str, Any]) -> dict[str, Any]:
    qs = [q for q in (bank.get("questions") or []) if q.get("available", True)]
    obs = bank.get("obsidian") or {}
    main_ref = obs.get("mainReference") or ""
    synthetic_count = sum(
        1 for q in qs
        if (q.get("provenance") or {}).get("synthetic")
        or q.get("origin") in {"synthetic_drill", "mock_exam"}
    )
    book_count = sum(
        1 for q in qs
        if (q.get("provenance") or {}).get("category") == "book" or q.get("origin") == "textbook"
    )
    official_count = len(qs) - synthetic_count - book_count
    return {
        "courseId": bank["courseId"],
        "canvasId": bank.get("canvasId", ""),
        "code": bank.get("code", bank["courseId"].upper()),
        "title": bank.get("title", bank["courseId"]),
        "shortTitle": bank.get("shortTitle") or bank.get("title", bank["courseId"]),
        "semester": bank.get("semester", "Starter Pack"),
        "color": bank.get("color", "#28654d"),
        "examInfo": bank.get("examInfo") or {},
        "questionCount": len(qs),
        "officialCount": official_count,
        "bookCount": book_count,
        "aiSyntheticCount": synthetic_count,
        "mcqCount": sum(1 for q in qs if q.get("kind") == "mcq"),
        "writtenOrCalcCount": sum(1 for q in qs if q.get("kind") != "mcq"),
        "hardCount": sum(1 for q in qs if int(q.get("difficulty") or 2) >= 3),
        "highDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 3),
        "medDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 2),
        "lowDlpfcCount": sum(1 for q in qs if (q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0]) == 1),
        "flowmultiCount": sum(1 for q in qs if q.get("wiseflowFields")),
        "topicCount": len(bank.get("topics") or []),
        "topics": bank.get("topics") or [],
        "collections": bank.get("collections") or [],
        "obsidian": obs,
        "obsidianMainReference": main_ref,
        "obsidianUri": "",
    }


def add_bundled_practice(static_dir: Path, bootstrap: dict[str, Any]) -> None:
    """Include starter mathematics exercises in hosted builds and refreshed packs (ordered after official BI exams)."""
    bank_file = ROOT_DIR / "examples" / "math-2588" / "bank.json"
    starter = json.loads(bank_file.read_text(encoding="utf-8"))
    starter_colls = {str(c.get("id")): c for c in (starter.get("collections") or []) if c.get("id")}
    for q in starter.get("questions") or []:
        if "provenance" not in q:
            q["provenance"] = build_question_provenance(q, starter_colls)
    for c in starter.get("collections") or []:
        if "provenance" not in c:
            is_mock = c.get("kind") in {"mock_exam", "mock"} or "mock" in str(c.get("id") or "").lower()
            c["provenance"] = {
                "category": "ai_mock" if is_mock else "ai_synthetic",
                "label": "AI Mock Exam" if is_mock else "AI Synthetic",
                "synthetic": True,
                "llmModel": "LLM-generated (legacy — model unlogged)",
            }
    reference = next(
        (r for r in bootstrap["references"] if r["file"] == starter["obsidian"]["mainReference"]),
        None,
    )
    if reference is None:
        return
    course_id = starter["courseId"]
    course_file = static_dir / "courses" / f"{course_id}.json"
    if course_file.is_file():
        bank = json.loads(course_file.read_text(encoding="utf-8"))
        bank = merge_course_practice(bank, starter)
        # Keep Official BI Past Exams & Course Papers first, AI mocks/drills after
        bank["collections"] = sorted(
            bank.get("collections") or [],
            key=lambda c: (1 if (c.get("provenance") or {}).get("synthetic") else 0),
        )
    else:
        bank = starter
    prep_file = "math-reference/Autumn 2026 exam preparation.md"
    prep_markdown = bank_file.with_name("autumn-2026-prep.md").read_text(encoding="utf-8")
    prep = {"file": prep_file, "toc": parse_headings(prep_markdown), "markdown": prep_markdown}
    (static_dir / "references" / f"{ref_slug(prep_file)}.json").write_text(
        json.dumps(prep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    companions = [c for c in reference.get("companions", []) if c["file"] != prep_file]
    reference["companions"] = [
        {"file": prep_file, "label": "Autumn 2026 exam preparation"}, *companions,
    ]
    bank["obsidian"].setdefault("practiceNote", prep_file)
    course_file.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    entry = build_catalog_entry(bank)
    bootstrap["catalog"] = [c for c in bootstrap["catalog"] if c["courseId"] != course_id]
    bootstrap["catalog"].append(entry)
    reference["courseId"] = course_id
    reference["questionCount"] = entry["questionCount"]


def install_member_library(out_dir: Path, archive: Path) -> None:
    # The release asset contains only encrypted files and a small index. Enforce
    # its layout before copying anything into the publication directory.
    release = json.loads((ROOT_DIR / "site-pack" / "member-archive.json").read_text(encoding="utf-8"))
    fingerprint = hashlib.sha256()
    with archive.open("rb") as signed:
        for chunk in iter(lambda: signed.read(4 * 1024 * 1024), b""):
            fingerprint.update(chunk)
    if fingerprint.hexdigest() != release["sha256"]:
        raise ValueError("Encrypted member archive checksum does not match the release.")
    with ZipFile(archive) as package:
        entries = package.infolist()
        names = {entry.filename for entry in entries}
        if len(names) != len(entries) or "index.json" not in names:
            raise ValueError("Invalid member archive layout.")
        for entry in entries:
            if entry.filename != "index.json" and (
                not re.fullmatch(r"[0-9a-f]{36}\.enc", entry.filename) or entry.file_size < 28
            ):
                raise ValueError("Member archive contains an unexpected file.")
        index = json.loads(package.read("index.json"))
        if index.get("format") != 1 or f"{index.get('manifest')}.enc" not in names:
            raise ValueError("Missing encrypted member manifest.")
        if sum(entry.file_size for entry in entries) > 900_000_000:
            raise ValueError("Member archive is too large for Pages.")
        package.extractall(out_dir / "member-library")


SEO_THEME_SCRIPT = """  <script>
    (function () {
      function syncTheme() {
        try {
          var raw = JSON.parse(localStorage.getItem('study-os-theme-v2') || 'null');
          var mode = raw && (raw.theme === 'light' || raw.theme === 'dark') ? raw.theme : 'system';
          var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          var effective = mode === 'system' ? (sysDark ? 'dark' : 'light') : mode;
          document.documentElement.dataset.theme = effective;
          document.documentElement.dataset.themeMode = mode;
          var m = document.getElementById('meta-theme-color');
          if (m) m.setAttribute('content', effective === 'dark' ? '#090d0c' : '#f3f5f7');
        } catch (e) {}
      }
      syncTheme();
      if (window.matchMedia) {
        var mql = window.matchMedia('(prefers-color-scheme: dark)');
        if (mql.addEventListener) mql.addEventListener('change', syncTheme);
        else if (mql.addListener) mql.addListener(syncTheme);
      }
    })();
  </script>"""

SEO_PAGE_STYLE = """  <style>
    .seo-shell { max-width: 920px; margin: 0 auto; padding: clamp(16px, 4vw, 36px) 16px 56px; }
    .seo-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 18px; }
    .seo-hero { padding: clamp(22px, 4vw, 34px); margin-bottom: 18px; }
    .seo-hero h1 { margin: 6px 0 10px; font-size: clamp(26px, 4vw, 36px); line-height: 1.15; letter-spacing: -0.025em; }
    .seo-lead { font-size: 16px; line-height: 1.55; color: var(--muted); max-width: 72ch; margin: 0 0 18px; }
    .seo-cta-row { display: flex; flex-wrap: wrap; gap: 10px; }
    .seo-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 0; }
    .seo-stat { padding: 12px 14px; border-radius: 14px; background: var(--panel-alt); border: 1px solid var(--line); }
    .seo-stat strong { display: block; font-size: 20px; letter-spacing: -0.02em; }
    .seo-stat small { color: var(--muted); font-size: 12.5px; }
    .seo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 14px 0 22px; }
    .seo-card { padding: 18px 20px; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }
    .seo-card h2, .seo-card h3 { margin: 4px 0 6px; font-size: 18px; }
    .seo-card p { margin: 0; font-size: 14px; line-height: 1.5; color: var(--muted); }
    .seo-topics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; list-style: none; padding: 0; margin: 12px 0 0; }
    .seo-topics li { padding: 9px 12px; border-radius: 11px; background: var(--panel-alt); border: 1px solid var(--line); font-size: 13.5px; }
    .seo-faq { display: grid; gap: 12px; margin-top: 14px; }
    .seo-faq details { padding: 14px 16px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); }
    .seo-faq summary { font-weight: 600; cursor: pointer; }
    .seo-faq p { margin: 8px 0 0; line-height: 1.55; color: var(--muted); font-size: 14px; }
    .seo-foot { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--muted); }
    .seo-foot nav { display: flex; flex-wrap: wrap; gap: 14px; }
  </style>"""

COURSE_NO_BLURBS: dict[str, str] = {
    "econ-2522": "Samfunnsøkonomi (mikroøkonomi og makroøkonomi) · Øvingsoppgaver, notater og WISEflow eksamensforberedelse for BI-studenter i Oslo.",
    "acct-2527": "Finansregnskap og bedriftsøkonomi · Øv på 180-poengs WISEflow FLOWmulti-oppgaver, regnskapsanalyse og finansberegninger for BI Oslo.",
    "ob-2537": "Organisasjonsatferd og ledelse · Flervalgsoppgaver (MCQ), begrepsoversikt og tidsstyrt eksamenssimulator for BI Oslo.",
    "prog-3021": "Programmering, datauttrekk og visualisering i Python (pandas, numpy, matplotlib, seaborn) · Øving til hjemmeeksamen i Jupyter Notebook ved BI Oslo.",
    "math-2588": "Matematikk for datavitenskap · Regneoppgaver, løsningsforslag og eksamensnotater for studenter ved Handelshøyskolen BI i Oslo.",
}


def generate_seo_pages(out_dir: Path, bootstrap: dict[str, Any], base_url: str = "https://studyos.no") -> list[str]:
    """Generate indexable static Oslo landing & per-course HTML pages plus sitemap.xml."""
    base = base_url.rstrip("/")
    catalog = bootstrap.get("catalog") or []
    references = bootstrap.get("references") or []
    total_qs = sum(int(c.get("questionCount") or 0) for c in catalog)
    today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    courses_dir = out_dir / "courses"
    courses_dir.mkdir(parents=True, exist_ok=True)
    sitemap_urls: list[tuple[str, str, str]] = [
        (f"{base}/", "1.0", "weekly"),
        (f"{base}/bi-oslo.html", "0.9", "weekly"),
    ]

    # 1. Per-course static indexable pages (`/courses/<courseId>.html`)
    for course in catalog:
        cid = str(course.get("courseId") or "").strip()
        if not cid or not re.fullmatch(r"[a-z0-9-]+", cid):
            continue
        code = str(course.get("code") or cid.upper()).strip()
        title = str(course.get("title") or cid).strip()
        color = str(course.get("color") or "#1f6b58").strip()
        exam = course.get("examInfo") or {}
        exam_format = str(exam.get("format") or "Digital university exam").strip()
        exam_notes = str(exam.get("notes") or "").strip()
        exam_date = str(exam.get("date") or "").strip()
        duration = int(exam.get("durationMinutes") or 180)
        q_count = int(course.get("questionCount") or 0)
        high_c = int(course.get("highDlpfcCount") or 0)
        med_c = int(course.get("medDlpfcCount") or 0)
        low_c = int(course.get("lowDlpfcCount") or 0)
        raw_topics = course.get("topics") or []
        topic_names = [
            str(t.get("title") or t.get("name") or t.get("id") or "").strip()
            if isinstance(t, dict) else str(t).strip()
            for t in raw_topics
        ]
        topic_names = [t for t in topic_names if t]
        no_blurb = COURSE_NO_BLURBS.get(
            cid,
            f"Øvingsoppgaver, kursnotater og WISEflow eksamensforberedelse for {code} ved Handelshøyskolen BI i Oslo.",
        )

        page_url = f"{base}/courses/{cid}.html"
        page_title = f"{code} {title} — BI Oslo Exam Prep & Practice | Study-OS"
        meta_desc = (
            f"Free {code} ({title}) exam prep for BI Oslo students: {q_count} practice questions, "
            f"{len(topic_names)} syllabus topics, WISEflow mock exams, course notes & Al tutor on Study-OS."
        )
        course_faqs = [
            (
                f"How can I practice for {code} ({title}) at BI Oslo?",
                f"Open {code} in Study-OS to drill {q_count} practice questions across {len(topic_names)} syllabus topics, run timed {duration}-minute WISEflow mock exams, read formula notes, and ask the side-pane Al Tutor for step-by-step guidance.",
            ),
            (
                f"What is the {code} exam format?",
                f"{exam_format}. {exam_notes}" if exam_notes else f"{exam_format} ({duration} minutes).",
            ),
            (
                f"Is {code} practice on Study-OS free?",
                "Yes. Study-OS is a free, independent student project in Oslo with zero ads and works directly in your browser without requiring an account.",
            ),
        ]
        json_ld = {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "Course",
                    "name": f"{code} · {title}",
                    "courseCode": code,
                    "description": meta_desc,
                    "url": page_url,
                    "inLanguage": ["en", "nb"],
                    "isAccessibleForFree": True,
                    "provider": {
                        "@type": "Organization",
                        "name": "Study-OS (Independent BI Oslo student project)",
                        "url": f"{base}/",
                    },
                    "educationalLevel": "University / Bachelor",
                    "about": topic_names[:12],
                    "offers": {
                        "@type": "Offer",
                        "price": "0",
                        "priceCurrency": "NOK",
                        "category": "Free",
                    },
                },
                {
                    "@type": "FAQPage",
                    "mainEntity": [
                        {"@type": "Question", "name": fq, "acceptedAnswer": {"@type": "Answer", "text": fa}}
                        for fq, fa in course_faqs
                    ],
                },
                {
                    "@type": "BreadcrumbList",
                    "itemListElement": [
                        {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                        {"@type": "ListItem", "position": 2, "name": "BI Oslo Courses", "item": f"{base}/bi-oslo.html"},
                        {"@type": "ListItem", "position": 3, "name": f"{code} · {title}", "item": page_url},
                    ],
                },
            ],
        }
        course_faq_html = "".join(
            f"        <details><summary>{escape(fq)}</summary><p>{escape(fa)}</p></details>\n"
            for fq, fa in course_faqs
        )
        other_links = "".join(
            f'<a class="ghost-btn" href="./{escape(str(oc["courseId"]), quote=True)}.html">'
            f'{escape(str(oc.get("code", "")))} · {escape(str(oc.get("shortTitle") or oc.get("title", "")))}</a>'
            for oc in catalog if oc.get("courseId") and oc.get("courseId") != cid
        )
        topics_html = (
            "<ul class=\"seo-topics\">"
            + "".join(f"<li>{escape(t)}</li>" for t in topic_names)
            + "</ul>"
            if topic_names else "<p class=\"muted\">Interactive practice questions and summary notes ready inside Study-OS.</p>"
        )
        exam_block = f"""
      <section class="panel seo-card" style="margin-bottom:16px">
        <span class="eyebrow">Exam format · Oslo / WISEflow</span>
        <h2>{escape(exam_format)}</h2>
        <p>{escape(exam_notes or f'Timed {duration}-minute exam simulation available inside Study-OS Exams Hub.')}</p>
        {f'<p style="margin-top:8px"><strong>Scheduled exam date:</strong> {escape(exam_date)} (Oslo time)</p>' if exam_date else ''}
      </section>"""

        course_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(meta_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{escape(page_url, quote=True)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:url" content="{escape(page_url, quote=True)}">
  <meta property="og:title" content="{escape(page_title, quote=True)}">
  <meta property="og:description" content="{escape(meta_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(page_title, quote=True)}">
  <meta name="twitter:description" content="{escape(meta_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(page_title)}</title>
  <link rel="icon" href="../favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="../pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="../styles.css">
{SEO_PAGE_STYLE}
  <script type="application/ld+json">{json.dumps(json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="../" class="ghost-btn">← Open Study-OS</a>
        <a href="../bi-oslo.html" class="ghost-btn">All BI Oslo Courses</a>
      </div>
      <span class="badge" style="border-color:{escape(color, quote=True)}">{escape(code)} · Oslo, Norway</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow" style="color:{escape(color, quote=True)}">{escape(code)} · BI Oslo Exam Preparation</span>
      <h1>{escape(code)}: {escape(title)}</h1>
      <p class="seo-lead">{escape(meta_desc)}</p>
      <p class="seo-lead" lang="nb" style="font-size:14.5px;margin-top:-8px">{escape(no_blurb)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="../?course={escape(cid, quote=True)}">Start practicing {escape(code)} →</a>
        <a class="ghost-btn btn-lg" href="../?view=exams&amp;course={escape(cid, quote=True)}">WISEflow Exam Mode</a>
        <a class="ghost-btn btn-lg" href="../?view=references">Course Notes</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{q_count}</strong><small>Practice questions</small></div>
        <div class="seo-stat"><strong>{len(topic_names)}</strong><small>Syllabus topics</small></div>
        <div class="seo-stat"><strong>{duration} min</strong><small>Timed exam simulation</small></div>
        <div class="seo-stat"><strong>{high_c} / {med_c} / {low_c}</strong><small>High / Med / Low DLPFC</small></div>
      </div>
    </article>
{exam_block}
    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Syllabus coverage</span>
      <h2>Topics covered in {escape(code)}</h2>
      {topics_html}
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">{escape(code)} Exam Prep FAQ</h2>
      <div class="seo-faq">
{course_faq_html}      </div>
    </section>

    <section class="panel seo-card">
      <span class="eyebrow">More courses in Oslo</span>
      <h2>Other BI Oslo courses on Study-OS</h2>
      <div class="seo-cta-row" style="margin-top:8px">{other_links}</div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway (not officially affiliated with BI Norwegian Business School).</span>
      <nav aria-label="Footer links">
        <a href="../">App</a>
        <a href="../bi-oslo.html">BI Oslo Guide</a>
        <a href="../privacy.html">Privacy</a>
        <a href="../terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
        (courses_dir / f"{cid}.html").write_text(course_html, encoding="utf-8")
        sitemap_urls.append((page_url, "0.85", "weekly"))

    # 2. Dedicated Oslo / Norway bilingual landing page (`/bi-oslo.html`)
    oslo_title = "BI Oslo Exam Prep, WISEflow Mock Exams & Canvas Sync · Study-OS"
    oslo_desc = (
        f"Free independent study hub for BI Norwegian Business School students in Oslo: {total_qs}+ practice questions, "
        f"WISEflow FLOWmulti mock exams, course notes, Al Tutor & 1-click BI Canvas/TimeEdit sync."
    )
    course_cards_html = "".join(
        f"""      <article class="panel seo-card">
        <div>
          <span class="eyebrow" style="color:{escape(str(c.get('color') or '#1f6b58'), quote=True)}">{escape(str(c.get('code') or ''))} · {int(c.get('questionCount') or 0)} Qs</span>
          <h3>{escape(str(c.get('title') or ''))}</h3>
          <p>{escape(COURSE_NO_BLURBS.get(str(c.get('courseId') or ''), str((c.get('examInfo') or {}).get('format') or '')))}</p>
        </div>
        <div class="seo-cta-row">
          <a class="primary-btn" href="./courses/{escape(str(c['courseId']), quote=True)}.html">Course guide</a>
          <a class="ghost-btn" href="./?course={escape(str(c['courseId']), quote=True)}">Practice →</a>
        </div>
      </article>\n"""
        for c in catalog if c.get("courseId")
    )
    faq_items = [
        (
            "Hva er Study-OS for studenter i Oslo og på Handelshøyskolen BI?",
            "Study-OS (studyos.no) er en gratis, uavhengig studieplattform laget for studenter i Oslo — spesielt tilpasset BI-emner som EXC 3420, EXC 3430, EXC 3460, EBA 3400 og EBA 1181. Du får øvingsoppgaver, kursnotater, WISEflow-eksamensmodus, Al-veileder og 1-klikks synk med BI Canvas, TimeEdit og Ed Discussion.",
        ),
        (
            "Does Study-OS simulate WISEflow FLOWmulti and BYOD exams?",
            "Yes. The Exams Hub includes timed exam simulations modeled on BI's 3-hour WISEflow FLOWmulti and BYOD digital school exams, complete with Oslo exam countdowns, difficulty tiers (Low, Med, High DLPFC), and detailed review analytics.",
        ),
        (
            "How does 1-click BI Canvas, TimeEdit, and Ed Discussion sync work?",
            "Install the Study-OS Sync Chrome extension, pair it once with a 6-character code from studyos.no, keep your signed-in BI Canvas, TimeEdit, or Ed tabs open, and click Sync once. It never reads passwords or copies session cookies — it only imports your courses, assignment deadlines, and class timetable.",
        ),
        (
            "Is Study-OS free and GDPR-compliant in Norway?",
            "Yes. Study-OS is completely free, has zero ads or third-party tracking cookies, works offline in your browser without an account, and stores optional synced profiles on Cloudflare EU servers under Norway / EEA GDPR rules.",
        ),
    ]
    oslo_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": f"{base}/bi-oslo.html#webpage",
                "url": f"{base}/bi-oslo.html",
                "name": oslo_title,
                "description": oslo_desc,
                "inLanguage": ["en", "nb"],
                "about": {"@type": "City", "name": "Oslo"},
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": q,
                        "acceptedAnswer": {"@type": "Answer", "text": a},
                    }
                    for q, a in faq_items
                ],
            },
            {
                "@type": "ItemList",
                "name": "BI Oslo Courses on Study-OS",
                "itemListElement": [
                    {
                        "@type": "ListItem",
                        "position": idx + 1,
                        "name": f"{c.get('code', '')} · {c.get('title', '')}",
                        "url": f"{base}/courses/{c['courseId']}.html",
                    }
                    for idx, c in enumerate(catalog) if c.get("courseId")
                ],
            },
        ],
    }
    faq_html = "".join(
        f"""        <details>
          <summary>{escape(q)}</summary>
          <p>{escape(a)}</p>
        </details>\n"""
        for q, a in faq_items
    )
    oslo_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(oslo_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <meta name="geo.position" content="59.9483;10.7686">
  <meta name="ICBM" content="59.9483, 10.7686">
  <link rel="canonical" href="{base}/bi-oslo.html">
  <link rel="alternate" hreflang="nb-NO" href="{base}/norsk.html">
  <link rel="alternate" hreflang="en" href="{base}/">
  <link rel="alternate" hreflang="x-default" href="{base}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/bi-oslo.html">
  <meta property="og:title" content="{escape(oslo_title, quote=True)}">
  <meta property="og:description" content="{escape(oslo_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(oslo_title, quote=True)}">
  <meta name="twitter:description" content="{escape(oslo_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(oslo_title)}</title>
  <link rel="icon" href="./favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="./pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="./styles.css">
{SEO_PAGE_STYLE}
  <script type="application/ld+json">{json.dumps(oslo_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Primary navigation">
      <a href="./" class="ghost-btn">← Open Study-OS App</a>
      <span class="badge">Oslo, Norway · BI Student Hub</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Oslo · Handelshøyskolen BI · Independent Student Project</span>
      <h1>BI Oslo Exam Prep, WISEflow Mock Exams &amp; Course Notes</h1>
      <p class="seo-lead">{escape(oslo_desc)}</p>
      <p class="seo-lead" lang="nb" style="font-size:14.5px;margin-top:-8px">
        Gratis eksamensforberedelse for BI-studenter i Oslo (Nydalen): øvingsoppgaver, kursnotater, WISEflow FLOWmulti-simulator, Al-veileder, timeplanlegging fra TimeEdit og synk med BI Canvas.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Launch Study-OS Workspace →</a>
        <a class="ghost-btn btn-lg" href="./?view=exams">Open WISEflow Exams Hub</a>
        <a class="ghost-btn btn-lg" href="./?view=references">Browse Course Notes ({len(references)})</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{len(catalog)}</strong><small>BI Oslo courses</small></div>
        <div class="seo-stat"><strong>{total_qs}+</strong><small>Practice questions</small></div>
        <div class="seo-stat"><strong>{len(references)}</strong><small>Reference sheets</small></div>
        <div class="seo-stat"><strong>100% Free</strong><small>No ads or trackers</small></div>
      </div>
    </article>

    <section>
      <h2 style="margin:0 0 8px">BI Oslo Courses &amp; Exam Guides</h2>
      <div class="seo-grid">
{course_cards_html}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:18px">
      <span class="eyebrow">Built for Oslo exam season</span>
      <h2>Why BI Oslo students use Study-OS</h2>
      <ul class="seo-topics">
        <li><strong>WISEflow FLOWmulti &amp; BYOD timing:</strong> Practice under realistic 180-minute Oslo exam conditions with automatic score and speed tracking.</li>
        <li><strong>Circadian DLPFC scheduling:</strong> Match High DLPFC synthesis problems to peak morning focus (08:00–15:00 Oslo) and lighter retrieval drills to evenings.</li>
        <li><strong>1-click BI Canvas, TimeEdit &amp; Ed sync:</strong> Pull courses, deadlines, and lectures straight from your open browser tabs without copying cookies.</li>
        <li><strong>Private curriculum PDFs &amp; Al Tutor:</strong> Attach your own lecture slides/PDFs to your profile and ask the side-pane Al Tutor while solving exercises.</li>
      </ul>
    </section>

    <section>
      <h2 style="margin:0 0 6px">Frequently Asked Questions / Ofte stilte spørsmål</h2>
      <div class="seo-faq">
{faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway (not officially affiliated with BI Norwegian Business School).</span>
      <nav aria-label="Footer links">
        <a href="./">Home</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./bi-canvas-timeedit-sync.html">BI Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "bi-oslo.html").write_text(oslo_html, encoding="utf-8")

    # 3. Pure Norwegian Bokmål Oslo landing page (`/norsk.html`, lang="nb")
    nb_title = "Study-OS Norge · Gratis eksamensøving for BI Oslo (WISEflow & Canvas)"
    nb_desc = (
        f"Gratis studieplattform for studenter ved Handelshøyskolen BI i Oslo: {total_qs}+ øvingsoppgaver, "
        f"WISEflow FLOWmulti-eksamener, kursnotater, Al-veileder og 1-klikks synk med BI Canvas og TimeEdit."
    )
    nb_faqs = [
        (
            "Hvilke BI-emner i Oslo støttes i Study-OS?",
            "Den åpne utgaven har øvingsoppgaver og notater for EXC 3420 (Economics I / samfunnsøkonomi), EXC 3430 (finansregnskap og bedriftsøkonomi), EXC 3460 (organisasjonsatferd og ledelse), EBA 3400 (Python-programmering og datavisualisering) og EBA 1181 (matematikk for datavitenskap). Du kan også synke alle dine egne BI Canvas-emner med 1 klikk.",
        ),
        (
            "Hvordan fungerer WISEflow FLOWmulti-simulatoren?",
            "I Exams-fanen kan du kjøre 3-timers tidsstyrte prøveeksamener som følger BI sine regler for desimalpunktum (.), minustegn for utbetalinger og ±2 % avrundingsmargin — med umiddelbar gjennomgang etter innlevering.",
        ),
        (
            "Hvordan synker jeg BI Canvas, TimeEdit og Ed Discussion?",
            "Med Chrome-utvidelsen Study-OS Sync kobler du deg opp én gang med en 6-tegns kode fra studyos.no. Når du har åpne innloggede faner for BI Canvas, TimeEdit eller Ed, klikker du Sync én gang for å oppdatere fag, frister og forelesningstimeplan — helt uten passord eller kopiering av cookies.",
        ),
        (
            "Er Study-OS gratis og trygt å bruke?",
            "Ja. Study-OS er et gratis, uavhengig studentprosjekt i Oslo uten reklame eller sporingscookies. Alt kan brukes lokalt i nettleseren uten konto, og valgfri profilsynk lagres innenfor EU/EØS (GDPR).",
        ),
    ]
    nb_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": f"{base}/norsk.html#webpage",
                "url": f"{base}/norsk.html",
                "name": nb_title,
                "description": nb_desc,
                "inLanguage": "nb",
                "about": {"@type": "City", "name": "Oslo"},
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                    for q, a in nb_faqs
                ],
            },
        ],
    }
    nb_faq_html = "".join(
        f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
        for q, a in nb_faqs
    )
    nb_html = f"""<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(nb_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <meta name="geo.position" content="59.9483;10.7686">
  <link rel="canonical" href="{base}/norsk.html">
  <link rel="alternate" hreflang="nb-NO" href="{base}/norsk.html">
  <link rel="alternate" hreflang="en" href="{base}/">
  <link rel="alternate" hreflang="x-default" href="{base}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="nb_NO">
  <meta property="og:locale:alternate" content="en_GB">
  <meta property="og:url" content="{base}/norsk.html">
  <meta property="og:title" content="{escape(nb_title, quote=True)}">
  <meta property="og:description" content="{escape(nb_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(nb_title, quote=True)}">
  <meta name="twitter:description" content="{escape(nb_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(nb_title)}</title>
  <link rel="icon" href="./favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="./pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="./styles.css">
{SEO_PAGE_STYLE}
  <script type="application/ld+json">{json.dumps(nb_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Hovednavigasjon">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Åpne Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn" lang="en">English Guide</a>
      </div>
      <span class="badge">Oslo, Norge · Gratis for BI-studenter</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Oslo · Handelshøyskolen BI · Eksamensforberedelse</span>
      <h1>Eksamensøving for BI-studenter i Oslo — helt gratis</h1>
      <p class="seo-lead">{escape(nb_desc)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Start øving i Study-OS →</a>
        <a class="ghost-btn btn-lg" href="./wiseflow-practice.html">WISEflow-simulator</a>
        <a class="ghost-btn btn-lg" href="./bi-canvas-timeedit-sync.html">Synk BI Canvas &amp; TimeEdit</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{len(catalog)}</strong><small>BI-emner klare nå</small></div>
        <div class="seo-stat"><strong>{total_qs}+</strong><small>Øvingsoppgaver</small></div>
        <div class="seo-stat"><strong>{len(references)}</strong><small>Kursnotater &amp; formler</small></div>
        <div class="seo-stat"><strong>0 kr</strong><small>Ingen reklame</small></div>
      </div>
    </article>

    <section>
      <h2 style="margin:0 0 8px">BI-emner og tidligere oppgavetyper</h2>
      <div class="seo-grid">
{course_cards_html}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:18px">
      <span class="eyebrow">Smart studieteknikk i eksamensperioden</span>
      <h2>Alt du trenger til eksamen i Nydalen samlet på ett sted</h2>
      <ul class="seo-topics">
        <li><strong>Nedtelling til eksamen i Oslo-tid:</strong> Se nøyaktig hvor mange dager, timer og minutter som gjenstår til hver BI-eksamen.</li>
        <li><strong>Døgnrytme og DLPFC-nivåer:</strong> Planlegg krevende regne- og caseoppgaver på formiddagen (08:00–15:00) og lettere repetisjon på kvelden.</li>
        <li><strong>Egne pensum-PDF-er &amp; Al-veileder:</strong> Last opp egne forelesningsnotater privat til profilen din og få hjelp av Al-veilederen rett ved siden av oppgaven.</li>
        <li><strong>Fungerende offline som app:</strong> Lagre fagene lokalt i nettleseren og øv videre på T-banen eller lesesalen uten nett.</li>
      </ul>
    </section>

    <section>
      <h2 style="margin:0 0 6px">Ofte stilte spørsmål</h2>
      <div class="seo-faq">
{nb_faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Uavhengig studentprosjekt i Oslo (ikke offisielt tilknyttet Handelshøyskolen BI).</span>
      <nav aria-label="Bunnlenker">
        <a href="./">Åpne app</a>
        <a href="./bi-oslo.html" lang="en">English</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./notes.html">Notater</a>
        <a href="./privacy.html">Personvern</a>
        <a href="./terms.html">Vilkår</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "norsk.html").write_text(nb_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/norsk.html", "0.9", "weekly"))

    # 4. WISEflow FLOWmulti & BYOD Simulator landing page (`/wiseflow-practice.html`)
    wf_title = "WISEflow FLOWmulti & BYOD Exam Simulator for BI Oslo · Study-OS"
    wf_desc = (
        "Practice timed 3-hour WISEflow FLOWmulti and BYOD digital school exams for BI Oslo (EXC 3430, EXC 3420, EXC 3460, EBA 3400) "
        "with dot-decimal formatting, ±2% rounding checks, and instant grading."
    )
    wf_json_ld = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": wf_title,
        "url": f"{base}/wiseflow-practice.html",
        "description": wf_desc,
        "inLanguage": ["en", "nb"],
        "about": ["WISEflow", "FLOWmulti", "BI Norwegian Business School", "Oslo exam preparation"],
    }
    wf_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(wf_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/wiseflow-practice.html">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:url" content="{base}/wiseflow-practice.html">
  <meta property="og:title" content="{escape(wf_title, quote=True)}">
  <meta property="og:description" content="{escape(wf_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(wf_title, quote=True)}">
  <meta name="twitter:description" content="{escape(wf_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(wf_title)}</title>
  <link rel="icon" href="./favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="./pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="./styles.css">
{SEO_PAGE_STYLE}
  <script type="application/ld+json">{json.dumps(wf_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
      </div>
      <span class="badge">WISEflow · FLOWmulti · Oslo</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">WISEflow Practice · BI Oslo Digital Exams</span>
      <h1>WISEflow FLOWmulti &amp; BYOD Mock Exam Simulator</h1>
      <p class="seo-lead">{escape(wf_desc)}</p>
      <p class="seo-lead" lang="nb" style="font-size:14.5px;margin-top:-8px">
        Øv på realistiske 3-timers WISEflow-eksamener i Oslo før eksamensdagen: lær reglene for desimalpunktum (.), negative kontantstrømmer (-50), avrundingsmargin (±2 %) og tidsstyring.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./?view=exams">Launch WISEflow Exams Hub →</a>
        <a class="ghost-btn btn-lg" href="./courses/acct-2527.html">EXC 3430 FLOWmulti</a>
        <a class="ghost-btn btn-lg" href="./courses/econ-2522.html">EXC 3420 Economics</a>
        <a class="ghost-btn btn-lg" href="./courses/ob-2537.html">EXC 3460 MCQ</a>
      </div>
    </article>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Built for BI WISEflow rules</span>
      <h2>What Study-OS trains before exam day</h2>
      <ul class="seo-topics">
        <li><strong>Multi-box FLOWmulti grading (EXC 3430):</strong> Trains dot-decimal input (<code>.</code> never comma), leading minus signs for outflows, and ±2% tolerance checks across multi-section accounting and finance exercises.</li>
        <li><strong>Timed 180-minute exam clock:</strong> Full paper countdown paired with per-question pace telemetry so you never run out of time on Part 3 analytical cases.</li>
        <li><strong>No-hint blind exam mode:</strong> Hides solutions and hints until you click <em>Submit Paper</em>, then produces a full error breakdown by topic and cognitive tier.</li>
        <li><strong>Live Oslo exam countdowns:</strong> Track exact days, hours, minutes, and seconds remaining to every upcoming BI Oslo exam date.</li>
      </ul>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./bi-canvas-timeedit-sync.html">BI Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "wiseflow-practice.html").write_text(wf_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/wiseflow-practice.html", "0.85", "monthly"))

    # 5. BI Canvas, TimeEdit & Ed Discussion Sync landing page (`/bi-canvas-timeedit-sync.html`)
    sync_title = "BI Canvas, TimeEdit & Ed Discussion 1-Click Sync · Study-OS Sync"
    sync_desc = (
        "Sync BI Norwegian Business School Canvas courses & deadlines, TimeEdit class schedules (.ics), and Ed Discussion threads "
        "into Study-OS in 1 click using the Study-OS Sync Chrome extension — zero passwords or cookies copied."
    )
    sync_json_ld = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "Study-OS Sync",
        "applicationCategory": "BrowserApplication",
        "operatingSystem": "Chrome, Brave, Edge, Vivaldi",
        "url": f"{base}/bi-canvas-timeedit-sync.html",
        "downloadUrl": f"{base}/downloads/study-os-sync-extension.zip",
        "softwareVersion": "1.6.0",
        "isAccessibleForFree": True,
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "NOK"},
        "description": sync_desc,
    }
    sync_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(sync_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/bi-canvas-timeedit-sync.html">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:url" content="{base}/bi-canvas-timeedit-sync.html">
  <meta property="og:title" content="{escape(sync_title, quote=True)}">
  <meta property="og:description" content="{escape(sync_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(sync_title, quote=True)}">
  <meta name="twitter:description" content="{escape(sync_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(sync_title)}</title>
  <link rel="icon" href="./favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="./pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="./styles.css">
{SEO_PAGE_STYLE}
  <script type="application/ld+json">{json.dumps(sync_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
      </div>
      <span class="badge">Chrome Extension · v1.6.0 · Multi-School Auto-Sync + MV3</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Canvas LMS (BI · UiA · NHH · UiO · NTNU · UiB) · TimeEdit / TP · Ed</span>
      <h1>1-Click &amp; Auto Canvas, TimeEdit/TP &amp; Ed Sync</h1>
      <p class="seo-lead">{escape(sync_desc)}</p>
      <p class="seo-lead" lang="nb" style="font-size:14.5px;margin-top:-8px">
        Synkroniser aktive emner og frister fra <strong>Canvas</strong> (BI Oslo, UiA, NHH, UiO, NTNU, OsloMet, UiB m.fl.), timeplanen din fra <strong>TimeEdit / TP</strong> og tråder fra <strong>Ed Discussion</strong> automatisk eller med 1 klikk — helt uten skolepassord.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Open Study-OS → Sync Canvas</a>
        <a class="ghost-btn btn-lg" href="./downloads/study-os-sync-extension.zip" download>Download Extension ZIP (v1.6.0)</a>
        <a class="ghost-btn btn-lg" href="./?view=schedule">Schedule Studio</a>
      </div>
    </article>

    <section class="bi-demo-card" style="margin-bottom:16px">
      <div class="row-between" style="margin-bottom:8px;gap:8px">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="badge live">10s Walkthrough</span>
          <strong style="font-size:13.5px">Watch how 1-Click &amp; Auto-Sync works</strong>
        </div>
      </div>
      <div class="bi-demo-viewport">
        <div class="bi-demo-camera">
          <div class="bi-demo-browser">
            <div class="bi-demo-chrome">
              <span class="bi-demo-dots"><i></i><i></i><i></i></span>
              <div class="bi-demo-tab active">studyos.no</div>
              <div class="bi-demo-tab">● canvas.bi.no</div>
              <div class="bi-demo-tab">● timeedit.net</div>
              <div class="bi-demo-tab">● eu.edstem.org</div>
            </div>
            <div class="bi-demo-canvas">
              <div class="bi-demo-left">
                <div class="bi-demo-eyebrow">Study-OS · Sync BI</div>
                <div class="bi-demo-h">Pair once in 10 seconds</div>
                <div class="bi-demo-code-btn">Generate 6-char code</div>
                <div class="bi-demo-code-pill">K7M-9P2</div>
              </div>
              <div class="bi-demo-popup">
                <div class="bi-demo-phead">
                  <span class="bi-demo-pdot"></span>
                  <b>Study-OS Sync</b>
                  <span class="bi-demo-ppill">3 tabs ready</span>
                </div>
                <div class="bi-demo-pchips">
                  <span>BI Canvas<i>● Ready</i></span>
                  <span>TimeEdit<i>● Ready</i></span>
                  <span>Ed<i>● Ready</i></span>
                </div>
                <div class="bi-demo-pbtn">Sync all 3 open tabs</div>
                <div class="bi-demo-presults">
                  <div class="bi-demo-res r1">✓ Canvas: 5 courses, 18 deadlines</div>
                  <div class="bi-demo-res r2">✓ TimeEdit: 42 classes synced</div>
                  <div class="bi-demo-res r3">✓ Ed: 2 courses · Auto-sync ON</div>
                </div>
              </div>
            </div>
          </div>
          <div class="bi-demo-cursor" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#ffffff" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round">
              <path d="M5 3l14 9-6.5 1.4L9 20z"></path>
            </svg>
            <span class="bi-demo-ripple"></span>
          </div>
        </div>
        <div class="bi-demo-caption">
          <span class="bi-demo-cap c1">1. Click <b>Generate 6-char code</b> on studyos.no</span>
          <span class="bi-demo-cap c2">2. Paste once in <b>Study-OS Sync</b> &amp; click Sync</span>
          <span class="bi-demo-cap c3">3. <b>Canvas, TimeEdit &amp; Ed</b> stay synced automatically ✓</span>
        </div>
        <div class="bi-demo-progress"><i></i></div>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">How it works in 30 seconds</span>
      <h2>Zero OAuth, zero passwords, zero cookie copying</h2>
      <ul class="seo-topics">
        <li><strong>1. Pair once:</strong> Sign in at <code>studyos.no</code>, click <strong>Sync BI</strong>, and copy a 6-character pairing code into the extension popup.</li>
        <li><strong>2. Keep BI tabs open:</strong> Leave your signed-in <code>canvas.bi.no</code>, <code>cloud.timeedit.net</code>, or <code>edstem.org</code> tabs open in Chrome, Brave, Edge, or Vivaldi.</li>
        <li><strong>3. Click Sync once:</strong> Pulls active courses, module outlines, assignment due dates, and TimeEdit class lectures into your private Study-OS schedule and course list.</li>
        <li><strong>4. Attach your own PDFs:</strong> Drop personal curriculum PDFs, lecture slides, or cheat sheets inside Sync BI to keep them synced privately to your Study-OS profile.</li>
      </ul>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "bi-canvas-timeedit-sync.html").write_text(sync_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/bi-canvas-timeedit-sync.html", "0.85", "monthly"))

    # 6. Static Course Notes & Reference Sheets Directory (`/notes.html`)
    notes_title = "BI Oslo Course Notes, Formula Sheets & Reference Hub · Study-OS"
    notes_desc = (
        f"Browse {len(references)} structured BI Oslo semester reference sheets with KaTeX formulas, diagrams, and section index "
        f"for Economics I (EXC 3420), Accounting & Finance (EXC 3430), Org. Behavior (EXC 3460), Python (EBA 3400) & Math (EBA 1181)."
    )
    ref_cards_parts: list[str] = []
    llms_ref_lines: list[str] = []
    static_refs_dir = out_dir / "static-data" / "references"
    for ref in references:
        rfile = str(ref.get("file") or "")
        rtitle = str(ref.get("title") or rfile)
        rsub = str(ref.get("subtitle") or ref.get("semester") or "Reference Sheet")
        toc_items: list[str] = []
        rjson = static_refs_dir / f"{ref_slug(rfile)}.json"
        if rjson.is_file():
            try:
                rdata = json.loads(rjson.read_text(encoding="utf-8"))
                for h in (rdata.get("toc") or []):
                    htext = str(h.get("text") or h.get("title") or "").strip() if isinstance(h, dict) else str(h).strip()
                    htext = re.sub(r"[$*`]", "", htext).strip()
                    if htext and len(htext) >= 3:
                        toc_items.append(htext)
            except Exception:
                pass
        shown_toc = toc_items[:12]
        llms_ref_lines.append(f"- {rtitle} ({len(toc_items)} sections): {', '.join(shown_toc[:6])}")
        toc_html = (
            "<ul class=\"seo-topics\">"
            + "".join(f"<li>{escape(h)}</li>" for h in shown_toc)
            + "</ul>"
            if shown_toc else ""
        )
        note_qs = quote(rfile, safe="")
        ref_cards_parts.append(
            f"""    <section class="panel seo-card" style="margin-bottom:14px">
      <div class="seo-nav" style="margin-bottom:4px">
        <div>
          <span class="eyebrow">{escape(rsub)}</span>
          <h2 style="margin:2px 0 0">{escape(rtitle)}</h2>
        </div>
        <a class="primary-btn" href="./?view=references&amp;note={note_qs}">Open notes →</a>
      </div>
      {toc_html}
    </section>\n"""
        )
    notes_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(notes_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/notes.html">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:url" content="{base}/notes.html">
  <meta property="og:title" content="{escape(notes_title, quote=True)}">
  <meta property="og:description" content="{escape(notes_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(notes_title, quote=True)}">
  <meta name="twitter:description" content="{escape(notes_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(notes_title)}</title>
  <link rel="icon" href="./favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="./pwa/study-os-192.png" sizes="192x192">
  <link rel="stylesheet" href="./styles.css">
{SEO_PAGE_STYLE}
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
      </div>
      <span class="badge">{len(references)} Reference Sheets · KaTeX &amp; Diagrams</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Multi-Semester Reference Hub · Oslo</span>
      <h1>BI Oslo Course Notes &amp; Formula Sheets</h1>
      <p class="seo-lead">{escape(notes_desc)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./?view=references">Open Interactive Notes Reader →</a>
        <a class="ghost-btn btn-lg" href="./bi-oslo.html">Browse Courses</a>
      </div>
    </article>

{"".join(ref_cards_parts)}
    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./bi-canvas-timeedit-sync.html">BI Sync</a>
        <a href="./privacy.html">Privacy</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "notes.html").write_text(notes_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/notes.html", "0.8", "weekly"))

    # 7. AI Search / GEO discovery file (`/llms.txt`)
    llms_course_lines = [
        f"- [{c.get('code', '')} · {c.get('title', '')}]({base}/courses/{c['courseId']}.html): "
        f"{int(c.get('questionCount') or 0)} practice questions · {(c.get('examInfo') or {}).get('format', 'Exam prep')}"
        for c in catalog if c.get("courseId")
    ]
    llms_txt = "\n".join([
        "# Study-OS (https://studyos.no)",
        "",
        "> Free, independent student exam preparation workspace for Oslo, Norway and BI Norwegian Business School courses. "
        "Includes active-recall practice questions, timed WISEflow FLOWmulti & BYOD mock exams, KaTeX course notes, "
        "side-pane Al Tutor, circadian DLPFC study scheduling, and 1-click BI Canvas / TimeEdit / Ed Discussion sync.",
        "",
        "## Core Pages",
        f"- [Study-OS Interactive Workspace]({base}/): Main web application with practice runner, timers, and progress tracking.",
        f"- [BI Oslo Study Guide (English)]({base}/bi-oslo.html): Overview of BI Oslo courses, exam tools, and FAQ.",
        f"- [Study-OS på norsk (BI Oslo)]({base}/norsk.html): Norwegian Bokmål guide for BI Oslo students.",
        f"- [WISEflow FLOWmulti & BYOD Exam Simulator]({base}/wiseflow-practice.html): Timed 3-hour mock exams with BI formatting rules.",
        f"- [BI Canvas, TimeEdit & Ed Discussion Sync]({base}/bi-canvas-timeedit-sync.html): Manifest V3 Chrome extension for 1-click sync.",
        f"- [BI Oslo Course Notes & Reference Hub]({base}/notes.html): Full index of semester reference sheets and formulas.",
        "",
        "## Public BI Oslo Courses",
        *llms_course_lines,
        "",
        "## Reference Sheets",
        *llms_ref_lines,
        "",
        "## Legal & Source",
        f"- [Privacy Policy (GDPR Norway / EEA)]({base}/privacy.html)",
        f"- [Terms of Use]({base}/terms.html)",
        "- [Open-source repository](https://github.com/shadjosef/study-os)",
        "",
    ])
    (out_dir / "llms.txt").write_text(llms_txt, encoding="utf-8")

    # 8. Auto-generated XML Sitemap (`sitemap.xml`)
    sitemap_urls.extend([
        (f"{base}/privacy.html", "0.3", "yearly"),
        (f"{base}/terms.html", "0.3", "yearly"),
    ])
    url_entries = "".join(
        f"  <url>\n"
        f"    <loc>{escape(loc)}</loc>\n"
        f"    <lastmod>{today_iso}</lastmod>\n"
        f"    <changefreq>{freq}</changefreq>\n"
        f"    <priority>{prio}</priority>\n"
        f"  </url>\n"
        for loc, prio, freq in sitemap_urls
    )
    sitemap_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{url_entries}"
        "</urlset>\n"
    )
    (out_dir / "sitemap.xml").write_text(sitemap_xml, encoding="utf-8")
    return [loc for loc, _, _ in sitemap_urls]


def finalize_site(out_dir: Path, bootstrap: dict[str, Any], member_archive: Path | None = None) -> dict[str, Any]:
    static_dir = out_dir / "static-data"
    add_bundled_practice(static_dir, bootstrap)
    for ref in bootstrap["references"]:
        for entry in [ref, *ref.get("companions", [])]:
            path = static_dir / "references" / f"{ref_slug(entry['file'])}.json"
            note = json.loads(path.read_text(encoding="utf-8"))
            for asset in re.findall(r"!\[[^\]]*\]\(\./(static-data/vault-assets/[^)]+)\)", note["markdown"]):
                if not (out_dir / unquote(asset)).is_file():
                    raise ValueError(f"Missing figure {asset} in {entry['file']}")
    for course_entry in bootstrap.get("catalog", []):
        cid = course_entry.get("courseId")
        cfile = static_dir / "courses" / f"{cid}.json"
        if not cid or not cfile.is_file():
            continue
        cbank = json.loads(cfile.read_text(encoding="utf-8"))
        cqs = [q for q in cbank.get("questions", []) if q.get("available", True)]
        tier_ids = {"1": [], "2": [], "3": []}
        for q in cqs:
            t = int(q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0])
            tier_ids[str(min(3, max(1, t)))].append(q["id"])
        course_entry["tierQuestionIds"] = tier_ids
        course_entry["lowDlpfcCount"] = len(tier_ids["1"])
        course_entry["medDlpfcCount"] = len(tier_ids["2"])
        course_entry["highDlpfcCount"] = len(tier_ids["3"])
    (static_dir / "bootstrap.json").write_text(
        json.dumps(bootstrap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    index = out_dir / "index.html"
    html = index.read_text(encoding="utf-8")
    member_marker = ' data-member-library="1"' if member_archive else ''
    community_marker = ""
    config = ROOT_DIR / "site-pack" / "community.json"
    if config.is_file():
        endpoint = json.loads(config.read_text(encoding="utf-8"))["api"].rstrip("/")
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("The community endpoint must be an HTTPS URL without credentials.")
        community_marker = f' data-community-api="{escape(endpoint, quote=True)}"'
    html = html.replace("<html ", f'<html data-study-mode="web"{member_marker}{community_marker} ', 1)
    html = html.replace(
        "</head>",
        '  <link rel="manifest" href="./app.webmanifest">\n'
        '  <link rel="preload" href="./static-data/bootstrap.json" as="fetch" crossorigin>\n'
        '</head>',
        1,
    )

    def _stamp_asset(match: re.Match[str]) -> str:
        attr, rel = match.group(1), match.group(2)
        target = out_dir / rel
        if not target.is_file():
            return match.group(0)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()[:8]
        return f'{attr}="./{rel}?v={digest}"'

    html = re.sub(r'(href|src)="\./((?:styles\.css|js/[A-Za-z0-9._-]+\.js))"', _stamp_asset, html)
    index.write_text(html, encoding="utf-8")

    # Package the in-house Study-OS Sync Chrome extension (Manifest V3) for direct download / Chrome Web Store upload.
    ext_src = ROOT_DIR / "canvas-sync-extension"
    if ext_src.is_dir():
        dl_dir = out_dir / "downloads"
        dl_dir.mkdir(parents=True, exist_ok=True)
        zip_path = dl_dir / "study-os-sync-extension.zip"
        with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as zf:
            for item in sorted(ext_src.rglob("*")):
                rel_parts = item.relative_to(ext_src).parts
                if item.is_file() and not any(part.startswith(".") for part in rel_parts) and "store-assets" not in rel_parts:
                    zf.write(item, item.relative_to(ext_src).as_posix())

    # Generate static indexable Oslo & per-course SEO pages plus sitemap.xml
    seo_urls = generate_seo_pages(out_dir, bootstrap)

    template = (ROOT_DIR / "tools" / "offline-worker.js").read_bytes()
    fingerprint = hashlib.sha256(template)
    assets = []
    seo_skip_files = {
        ".nojekyll", "CNAME", "404.html", "robots.txt", "sitemap.xml", "llms.txt",
        "og-image.png", "favicon.ico", "bi-oslo.html", "norsk.html",
        "wiseflow-practice.html", "bi-canvas-timeedit-sync.html", "notes.html",
        "7d4c9e2a8b1f4063a5e7c2d9f1b84e60.txt",
    }
    for path in sorted(out_dir.rglob("*")):
        if path.is_file() and path.name not in seo_skip_files:
            rel = path.relative_to(out_dir).as_posix()
            if rel.startswith("downloads/") or rel.startswith("courses/"):
                continue
            assets.append(quote(rel, safe="/"))
            fingerprint.update(rel.encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest())
    (out_dir / "offline-worker.js").write_bytes(
        (f"const VERSION = {json.dumps(fingerprint.hexdigest()[:20])};\n"
         f"const ASSETS = {json.dumps(assets)};\n").encode() + template
    )
    if member_archive:
        install_member_library(out_dir, member_archive)
    return {
        "outDir": str(out_dir),
        "coursesExported": len(bootstrap["catalog"]),
        "questionsExported": sum(c["questionCount"] for c in bootstrap["catalog"]),
        "referencesExported": len(bootstrap["references"]),
        "seoPages": len(seo_urls),
    }


def build_site(out_dir: Path, cname: str = "", member_archive: Path | None = None) -> dict[str, Any]:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(APP_DIR / "public", out_dir)
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    if cname.strip():
        (out_dir / "CNAME").write_text(cname.strip() + "\n", encoding="utf-8")

    static_dir = out_dir / "static-data"
    pack_static = ROOT_DIR / "site-pack" / "static-data"

    raw_catalog, courses_by_id = STORE.discover_courses()
    v_root = vault_root(ROOT_DIR, STORE.data_dir)

    # In CI (GitHub Actions) where local OneDrive `data/` and `Obsidian Vault` are absent,
    # hydrate directly from the pre-exported copyright-safe `site-pack/static-data/` if present!
    if not raw_catalog and not v_root.is_dir() and (pack_static / "bootstrap.json").is_file():
        shutil.copytree(pack_static, static_dir)
        boot_saved = json.loads((static_dir / "bootstrap.json").read_text(encoding="utf-8"))
        return finalize_site(out_dir, boot_saved, member_archive)

    courses_out = static_dir / "courses"
    refs_out = static_dir / "references"
    vault_assets_out = static_dir / "vault-assets"
    courses_out.mkdir(parents=True, exist_ok=True)
    refs_out.mkdir(parents=True, exist_ok=True)
    vault_assets_out.mkdir(parents=True, exist_ok=True)

    public_banks: list[dict[str, Any]] = []

    for cid in [c["courseId"] for c in raw_catalog]:
        safe_b = filter_public_safe_bank(courses_by_id[cid])
        if safe_b:
            public_banks.append(safe_b)

    # Always include the interactive Demo Showcase if no local courses exist (e.g. GitHub Actions CI)
    demo_path = ROOT_DIR / "examples" / "demo-course" / "bank.json"
    if not public_banks and demo_path.is_file():
        public_banks.append(json.loads(demo_path.read_text(encoding="utf-8")))

    public_catalog: list[dict[str, Any]] = []
    for pb in public_banks:
        cid = pb["courseId"]
        (courses_out / f"{cid}.json").write_text(
            json.dumps(pb, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        public_catalog.append(build_catalog_entry(pb))

    # Export Multi-Semester Reference Sheets from Obsidian Vault (if present)
    refs_meta = discover_reference_library(ROOT_DIR, raw_catalog or public_catalog, STORE.data_dir)
    exported_refs: list[dict[str, Any]] = []
    exported_files: set[str] = set()

    def export_one_md(rel_file: str) -> bool:
        if not rel_file or rel_file in exported_files:
            return rel_file in exported_files
        md_path = v_root / rel_file
        if not md_path.is_file():
            return False
        raw_md = md_path.read_text(encoding="utf-8", errors="replace")
        body = strip_frontmatter(raw_md)
        clean_md = rewrite_static_vault_assets(body, rel_file, v_root, vault_assets_out)
        toc = parse_headings(clean_md)
        slug = ref_slug(rel_file)
        (refs_out / f"{slug}.json").write_text(
            json.dumps({"file": rel_file, "toc": toc, "markdown": clean_md}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        exported_files.add(rel_file)
        return True

    for r in refs_meta:
        if export_one_md(r["file"]):
            valid_comps = [c for c in (r.get("companions") or []) if export_one_md(c["file"])]
            r_pub = dict(r)
            r_pub["obsidianUri"] = ""
            r_pub["companions"] = valid_comps
            # Only keep courseId button if that course is in public_catalog
            if r_pub.get("courseId") and not any(c["courseId"] == r_pub["courseId"] for c in public_catalog):
                r_pub["courseId"] = ""
                r_pub["questionCount"] = 0
            exported_refs.append(r_pub)

    bootstrap_payload = {
        "serverTime": datetime.now(timezone.utc).isoformat(),
        "timezone": "Europe/Oslo",
        "mode": "static_web",
        "catalog": public_catalog,
        "references": exported_refs,
        "canvasArchive": {"connected": False, "courses": [], "unimportedCount": 0},
        "scheduleConfig": {"enabled": False, "prefs": {}},
        "progress": {"records": {}},
        "calendar": {"source": "static_web", "blocks": []},
        "analytics": {},
        "recentSessions": [],
    }
    return finalize_site(out_dir, bootstrap_payload, member_archive)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build static public web bundle of Study-OS.")
    parser.add_argument("--out", default=str(ROOT_DIR / "dist"), help="Output directory (default: ./dist)")
    parser.add_argument("--cname", default="", help="Optional custom domain for GitHub Pages CNAME file")
    parser.add_argument("--member-archive", type=Path, help="Verified encrypted library release asset")
    parser.add_argument(
        "--sync-pack",
        action="store_true",
        help="Also snapshot copyright-safe static-data/ into ./site-pack/static-data for GitHub Pages CI",
    )
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    summary = build_site(out_path, cname=args.cname, member_archive=args.member_archive)
    if args.sync_pack:
        pack_dst = ROOT_DIR / "site-pack" / "static-data"
        if pack_dst.exists():
            shutil.rmtree(pack_dst)
        pack_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(out_path / "static-data", pack_dst)
        print(f"Synced public pack into {pack_dst}")
    print(
        f"Built static Study-OS site in {summary['outDir']} "
        f"({summary['coursesExported']} public courses, {summary['questionsExported']} copyright-safe Qs, "
        f"{summary['referencesExported']} reference sheets)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
