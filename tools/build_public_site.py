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
        add_ref(str(q["sourceId"]), int(q.get("sourcePage") or 1), "prompt")
    if q.get("solutionSourceId") and str(q["solutionSourceId"]) in public_sources:
        add_ref(str(q["solutionSourceId"]), int(q.get("solutionPage") or 1), "solution")
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
    by_coll: dict[str, list[dict[str, Any]]] = {}
    for q in qs:
        cid_q = str(q.get("collectionId") or "")
        if cid_q:
            by_coll.setdefault(cid_q, []).append(q)
    enriched_collections: list[dict[str, Any]] = []
    for col in bank.get("collections") or []:
        c_item = dict(col)
        c_qs = by_coll.get(str(col.get("id") or ""), [])
        c_item["questionIds"] = [q["id"] for q in c_qs]
        c_item["questionCount"] = len(c_qs)
        par_sum = 0.0
        for q in c_qs:
            p = q.get("pacing") or {}
            t_min = (p.get("exam") or {}).get("target") or (p.get("learning") or {}).get("target")
            par_sum += float(t_min) if isinstance(t_min, (int, float)) and t_min > 0 else (2.0 if q.get("kind") == "mcq" else 6.0)
        c_item["parMinutes"] = round(par_sum)
        enriched_collections.append(c_item)
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
        "collections": enriched_collections,
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


def install_pdfcraft_web(out_dir: Path, archive: Path) -> None:
    """Verify and install the official storytold/pdfcraft web WASM build under out_dir/pdfcraft/.

    Kept outside git and excluded from offline-worker.js precache so initial Study-OS loads stay
    zero-bloat; downloaded lazily only when the user clicks 'Edit PDF'.
    """
    spec = json.loads((ROOT_DIR / "site-pack" / "pdfcraft-web.json").read_text(encoding="utf-8"))
    fingerprint = hashlib.sha256()
    with archive.open("rb") as fh:
        for chunk in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            fingerprint.update(chunk)
    if fingerprint.hexdigest() != spec["sha256"]:
        raise ValueError(
            f"PdfCraft archive SHA-256 mismatch: expected {spec['sha256']}, got {fingerprint.hexdigest()}"
        )

    prefix = f"pdfcraft-web-{spec['version']}/"
    allowed_names = {"index.html", "LICENSE-APACHE", "LICENSE-MIT", "NOTICE"}
    allowed_exts = {".js", ".wasm", ".onnx", ".txt"}
    skip_names = {"README.md", "HOSTING.md", "_headers", ".htaccess"}

    dest_root = (out_dir / "pdfcraft").resolve()
    if dest_root.exists():
        shutil.rmtree(dest_root)
    dest_root.mkdir(parents=True, exist_ok=True)

    total_bytes = 0
    has_index = False
    with ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            if not info.filename.startswith(prefix):
                raise ValueError(f"Unexpected PdfCraft archive entry: {info.filename}")
            rel_str = info.filename[len(prefix):]
            if not rel_str or rel_str.startswith("/") or ".." in Path(rel_str).parts:
                raise ValueError(f"Unsafe PdfCraft archive path: {info.filename}")
            if rel_str in skip_names:
                continue
            rel_path = Path(rel_str)
            if rel_str not in allowed_names and rel_path.suffix.lower() not in allowed_exts:
                raise ValueError(f"Unexpected file type in PdfCraft archive: {rel_str}")
            total_bytes += info.file_size
            if total_bytes > 160_000_000:
                raise ValueError("PdfCraft archive exceeds expected 160 MB static budget.")
            target = (dest_root / rel_path).resolve()
            if not target.is_relative_to(dest_root):
                raise ValueError(f"Path escape in PdfCraft archive: {rel_str}")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            if rel_str == "index.html":
                has_index = True
                # Strip integrity from <link rel="preload" as="fetch"> so Chromium logs 0 console warnings.
                html_text = data.decode("utf-8")
                html_text = re.sub(
                    r'(<link\s+rel="preload"[^>]*?)\s+integrity="[^"]*"([^>]*>)',
                    r"\1\2",
                    html_text,
                )
                if 'name="robots"' not in html_text.lower():
                    html_text = html_text.replace(
                        "<head>",
                        '<head>\n    <meta name="robots" content="noindex, nofollow" />',
                        1,
                    )
                target.write_text(html_text, encoding="utf-8")
            else:
                target.write_bytes(data)

    if not has_index:
        raise ValueError("PdfCraft archive is missing index.html.")


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
    .seo-preview-media { margin: 18px 0 0; padding: 0; border-radius: 16px; overflow: hidden; border: 1px solid var(--line); background: #0b1312; }
    .seo-preview-media img { display: block; width: 100%; height: auto; }
  </style>"""

SEO_ICON_LINKS = """  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-48.png" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-96.png" sizes="96x96">
  <link rel="icon" type="image/png" href="/pwa/study-os-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/pwa/study-os-192.png">"""

COURSE_NO_BLURBS: dict[str, str] = {
    "econ-2522": "Samfunnsøkonomi (SØK 3420 / EXC 3420 — mikroøkonomi og makroøkonomi) · Tidligere eksamener, øvingsoppgaver, kursnotater og WISEflow eksamensforberedelse for BI Oslo.",
    "acct-2527": "Finansregnskap og bedriftsøkonomi (BØK 3430 / EXC 3430) · Øv på 180-poengs WISEflow FLOWmulti-oppgaver, regnskapsanalyse og finansberegninger for BI Oslo.",
    "ob-2537": "Organisasjonsatferd og ledelse (ORG 3460 / EXC 3460) · Flervalgsoppgaver (MCQ), begrepsoversikt og tidsstyrt WISEflow-eksamenssimulator for BI Oslo.",
    "prog-3021": "Programmering, datauttrekk og visualisering i Python (EBA 3400 / EBA34005 — pandas, numpy, matplotlib, seaborn) · Øving til hjemmeeksamen i Jupyter Notebook ved BI Oslo.",
    "math-2588": "Matematikk for datavitenskap (EBA 1181 / EBA 1180 / EBA11805 / MET 1180) · Tidligere BI-eksamener, regneoppgaver, løsningsforslag og formelnotater for BI Oslo.",
}

# Authentic BI Norwegian Business School equivalent & historical exam course codes
BI_COURSE_ALIASES: dict[str, dict[str, Any]] = {
    "econ-2522": {"noCode": "SØK 3420", "altCodes": ["SØK 3420", "Samfunnsøkonomi"]},
    "acct-2527": {"noCode": "BØK 3430", "altCodes": ["BØK 3430", "Finansregnskap og bedriftsøkonomi"]},
    "ob-2537": {"noCode": "ORG 3460", "altCodes": ["ORG 3460", "Organisasjonsatferd og ledelse"]},
    "prog-3021": {"noCode": "", "altCodes": ["EBA34005", "Python BI Oslo"]},
    "math-2588": {"noCode": "EBA 1180", "altCodes": ["EBA 1180", "EBA11805", "EBA 2910", "MET 1180"]},
}


def _extension_version() -> str:
    manifest = ROOT_DIR / "canvas-sync-extension" / "manifest.json"
    if manifest.is_file():
        try:
            ver = str(json.loads(manifest.read_text(encoding="utf-8")).get("version") or "").strip()
            if ver:
                return ver
        except Exception:
            pass
    return "1.7.1"


def _publisher_ld(base: str) -> dict[str, Any]:
    return {
        "@type": "Organization",
        "name": "Study-OS",
        "url": f"{base}/",
        "logo": {
            "@type": "ImageObject",
            "url": f"{base}/pwa/study-os-192.png",
            "width": 192,
            "height": 192,
        },
    }


def _course_code_pair(cid: str, code: str) -> str:
    no_code = str((BI_COURSE_ALIASES.get(cid) or {}).get("noCode") or "").strip()
    return f"{code} / {no_code}" if no_code and no_code != code else code


def generate_seo_pages(out_dir: Path, bootstrap: dict[str, Any], base_url: str = "https://studyos.no") -> list[str]:
    """Generate indexable static Oslo, multi-university & per-course HTML pages, GEO Markdown mirrors, and sitemap.xml."""
    base = base_url.rstrip("/")
    catalog = bootstrap.get("catalog") or []
    references = bootstrap.get("references") or []
    total_qs = sum(int(c.get("questionCount") or 0) for c in catalog)
    total_flowmulti = sum(int(c.get("flowmultiCount") or 0) for c in catalog)
    today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ext_version = _extension_version()

    seo_css_file = out_dir / "seo.css"
    seo_css_v = hashlib.sha256(seo_css_file.read_bytes()).hexdigest()[:8] if seo_css_file.is_file() else ""
    seo_css_root = f"./seo.css?v={seo_css_v}" if seo_css_v else "./seo.css"
    seo_css_sub = f"../seo.css?v={seo_css_v}" if seo_css_v else "../seo.css"
    seo_css_abs = f"/seo.css?v={seo_css_v}" if seo_css_v else "/seo.css"

    # Stamp cache-busted seo.css onto static legal & 404 HTML files copied from app/public/
    for static_name, css_target in (("privacy.html", seo_css_root), ("terms.html", seo_css_root), ("404.html", seo_css_abs)):
        sp = out_dir / static_name
        if sp.is_file():
            raw_s = sp.read_text(encoding="utf-8")
            raw_s = raw_s.replace('href="./seo.css"', f'href="{css_target}"').replace('href="/seo.css"', f'href="{css_target}"')
            sp.write_text(raw_s, encoding="utf-8")

    static_refs_dir = out_dir / "static-data" / "references"
    ref_toc_by_course: dict[str, list[str]] = {}
    for ref in references:
        r_cid = str(ref.get("courseId") or "").strip()
        rfile = str(ref.get("file") or "")
        if not r_cid or not rfile:
            continue
        rjson = static_refs_dir / f"{ref_slug(rfile)}.json"
        if rjson.is_file():
            try:
                rdata = json.loads(rjson.read_text(encoding="utf-8"))
                heads = []
                for h in (rdata.get("toc") or []):
                    ht = str(h.get("text") or h.get("title") or "").strip() if isinstance(h, dict) else str(h).strip()
                    ht = re.sub(r"[$*`]", "", ht).strip()
                    if ht and len(ht) >= 3:
                        heads.append(ht)
                if heads:
                    ref_toc_by_course[r_cid] = heads
            except Exception:
                pass

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
        code_pair = _course_code_pair(cid, code)
        alias_meta = BI_COURSE_ALIASES.get(cid) or {}
        alt_codes = list(alias_meta.get("altCodes") or [])
        title = str(course.get("title") or cid).strip()
        short_title = str(course.get("shortTitle") or title).strip()
        color = str(course.get("color") or "#1f6b58").strip()
        exam = course.get("examInfo") or {}
        exam_format = str(exam.get("format") or "Digital university exam").strip()
        exam_notes = str(exam.get("notes") or "").strip()
        exam_date = str(exam.get("date") or "").strip()
        duration = int(exam.get("durationMinutes") or 180)
        q_count = int(course.get("questionCount") or 0)
        off_c = int(course.get("officialCount") or 0)
        book_c = int(course.get("bookCount") or 0)
        ai_c = int(course.get("aiSyntheticCount") or 0)
        wf_c = int(course.get("flowmultiCount") or 0)
        high_c = int(course.get("highDlpfcCount") or 0)
        med_c = int(course.get("medDlpfcCount") or 0)
        low_c = int(course.get("lowDlpfcCount") or 0)

        raw_topics = course.get("topics") or []
        topic_entries: list[tuple[str, list[str]]] = []
        for t in raw_topics:
            if isinstance(t, dict):
                t_name = str(t.get("title") or t.get("name") or t.get("id") or "").strip()
                t_kws = [str(k).strip() for k in (t.get("keywords") or []) if str(k).strip()][:5]
                if t_name:
                    topic_entries.append((t_name, t_kws))
            else:
                t_name = str(t).strip()
                if t_name:
                    topic_entries.append((t_name, []))
        topic_names = [tn for tn, _ in topic_entries]

        no_blurb = COURSE_NO_BLURBS.get(
            cid,
            f"Øvingsoppgaver, kursnotater og WISEflow eksamensforberedelse for {code_pair} ved Handelshøyskolen BI i Oslo.",
        )

        page_url = f"{base}/courses/{cid}.html"
        page_title = f"{code_pair} {short_title} — BI Oslo Exam Prep | Study-OS"
        meta_desc = (
            f"Free {code_pair} ({short_title}) BI Oslo exam prep: {q_count} questions ({off_c} official BI tasks), "
            f"{len(topic_names)} topics, WISEflow mocks, formula notes & AI tutor."
        )
        course_faqs = [
            (
                f"How can I practice for {code_pair} ({title}) at BI Oslo?",
                f"Open {code} in Study-OS to drill {q_count} practice questions across {len(topic_names)} syllabus topics, run timed {duration}-minute WISEflow mock exams, read KaTeX formula notes, and ask the side-pane Adamlite AI Tutor for step-by-step guidance.",
            ),
            (
                f"What is the {code} exam format at BI Norwegian Business School?",
                f"{exam_format}. {exam_notes}" if exam_notes else f"{exam_format} ({duration} minutes).",
            ),
            (
                f"Har Study-OS tidligere eksamener og øvingsoppgaver for {code_pair}?",
                f"Ja. {code_pair} på Study-OS har {q_count} oppgaver ({off_c} fra tidligere BI-eksamener og oppgavesett"
                + (f", {book_c} pensumbok-indekserte oppgaver" if book_c else "")
                + f" og {ai_c} tydelig merkede AI-prøveeksamener), gruppert etter pensumtema og vanskelighetsgrad — helt gratis uten konto.",
            ),
            (
                f"Is {code} practice on Study-OS free?",
                "Yes. Study-OS is a free, independent open-source student project in Oslo with zero ads and works directly in your browser without requiring an account.",
            ),
        ]

        course_schema: dict[str, Any] = {
            "@type": "Course",
            "name": f"{code_pair} · {title}",
            "courseCode": code,
            "description": meta_desc,
            "url": page_url,
            "image": f"{base}/og-image.png",
            "inLanguage": ["en", "nb"],
            "isAccessibleForFree": True,
            "provider": _publisher_ld(base),
            "educationalLevel": "University / Bachelor",
            "about": topic_names[:14],
            "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "NOK",
                "category": "Free",
            },
        }
        if alt_codes:
            course_schema["alternateName"] = alt_codes

        json_ld = {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "WebPage",
                    "@id": f"{page_url}#webpage",
                    "url": page_url,
                    "name": page_title,
                    "description": meta_desc,
                    "image": f"{base}/og-image.png",
                    "dateModified": today_iso,
                    "inLanguage": ["en", "nb"],
                    "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                    "publisher": _publisher_ld(base),
                },
                course_schema,
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
                        {"@type": "ListItem", "position": 3, "name": f"{code_pair} · {short_title}", "item": page_url},
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
            f'{escape(_course_code_pair(str(oc["courseId"]), str(oc.get("code", ""))))} · {escape(str(oc.get("shortTitle") or oc.get("title", "")))}</a>'
            for oc in catalog if oc.get("courseId") and oc.get("courseId") != cid
        )
        topics_html = (
            '<ul class="seo-topics">'
            + "".join(
                f"<li><strong>{escape(tn)}</strong>"
                + (f'<span class="seo-topic-kw">{escape(" · ".join(kws))}</span>' if kws else "")
                + "</li>"
                for tn, kws in topic_entries
            )
            + "</ul>"
            if topic_entries else '<p class="muted">Interactive practice questions and summary notes ready inside Study-OS.</p>'
        )

        # Real Past Exams & Exercise Collections table
        colls = [col for col in (course.get("collections") or []) if int(col.get("questionCount") or 0) > 0]
        coll_rows = "".join(
            f"""          <tr>
            <td><strong>{escape(str(col.get("title") or col.get("id") or ""))}</strong></td>
            <td><span class="badge">{escape(str((col.get("provenance") or {}).get("label") or col.get("kind") or "Practice"))}</span></td>
            <td>{int(col.get("questionCount") or 0)}</td>
            <td>{int(col.get("parMinutes") or 0)} min</td>
          </tr>\n"""
            for col in colls[:16]
        )
        collections_block = (
            f"""    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Past exams &amp; problem sets · {off_c} official · {ai_c} AI mock{f' · {wf_c} FLOWmulti' if wf_c else ''}</span>
      <h2>Past exam papers &amp; practice sets in {escape(code_pair)}</h2>
      <p>Every exercise is tagged by origin so you can filter strictly for <strong>Real BI Tasks Only</strong>, <strong>Past Exams</strong>, or extra timed AI rehearsals:</p>
      <div class="seo-table-wrap">
        <table class="seo-table">
          <thead>
            <tr>
              <th>Exam Paper / Exercise Set</th>
              <th>Source</th>
              <th>Questions</th>
              <th>Est. Par</th>
            </tr>
          </thead>
          <tbody>
{coll_rows}          </tbody>
        </table>
      </div>
    </section>\n"""
            if coll_rows else ""
        )

        # Linked Formula / Reference Sheet TOC preview
        course_ref_heads = ref_toc_by_course.get(cid) or []
        ref_preview_block = (
            f"""    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Formula sheet &amp; semester reference · {len(course_ref_heads)} sections</span>
      <h2>Course notes included for {escape(code_pair)}</h2>
      <ul class="seo-topics">{"".join(f"<li>{escape(h)}</li>" for h in course_ref_heads[:12])}</ul>
      <div class="seo-cta-row" style="margin-top:10px">
        <a class="ghost-btn" href="../notes.html">Browse all formula sheets</a>
        <a class="ghost-btn" href="../?view=references" rel="nofollow">Open interactive Notes reader →</a>
      </div>
    </section>\n"""
            if course_ref_heads else ""
        )

        exam_block = f"""    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Exam format · Oslo / WISEflow</span>
      <h2>{escape(exam_format)}</h2>
      <p>{escape(exam_notes or f'Timed {duration}-minute exam simulation available inside Study-OS Exams Hub.')}</p>
      {f'<p style="margin-top:8px"><strong>Scheduled exam date:</strong> {escape(exam_date)} (Oslo time)</p>' if exam_date else ''}
    </section>"""

        alt_line = (
            f" Also covers Norwegian / historical BI course codes <code>{escape(', '.join(alt_codes))}</code>."
            if alt_codes else ""
        )

        course_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(meta_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{escape(page_url, quote=True)}">
  <link rel="alternate" type="text/markdown" href="{base}/courses/{escape(cid, quote=True)}.md" title="{escape(code, quote=True)} Guide (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{escape(page_url, quote=True)}">
  <meta property="og:title" content="{escape(page_title, quote=True)}">
  <meta property="og:description" content="{escape(meta_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="{escape(code_pair, quote=True)} {escape(title, quote=True)} exam prep on Study-OS">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(page_title, quote=True)}">
  <meta name="twitter:description" content="{escape(meta_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(page_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_sub, quote=True)}">
  <script type="application/ld+json">{json.dumps(json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="../" class="ghost-btn">← Open Study-OS</a>
        <a href="../bi-oslo.html" class="ghost-btn">BI Oslo Courses</a>
        <a href="../wiseflow-practice.html" class="ghost-btn">WISEflow</a>
      </div>
      <span class="badge" style="border-color:{escape(color, quote=True)}">{escape(code_pair)} · Oslo, Norway</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow" style="color:{escape(color, quote=True)}">{escape(code_pair)} · BI Oslo Exam Preparation</span>
      <h1>{escape(code_pair)}: {escape(title)}</h1>
      <div class="seo-acu">
        <strong>Quick summary:</strong> Free BI Oslo exam prep for <strong>{escape(code_pair)} ({escape(title)})</strong> with <strong>{q_count} practice questions</strong> ({off_c} official past exams &amp; course sets, {ai_c} AI mocks), <strong>{len(topic_names)} syllabus topics</strong>, timed {duration}-minute WISEflow simulation, KaTeX formula sheets, and Adamlite AI Tutor.{alt_line}
      </div>
      <p class="seo-lead" lang="nb">{escape(no_blurb)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="../?course={escape(cid, quote=True)}" rel="nofollow">Start practicing {escape(code)} →</a>
        <a class="ghost-btn btn-lg" href="../?view=exams&amp;course={escape(cid, quote=True)}" rel="nofollow">WISEflow Exam Mode</a>
        <a class="ghost-btn btn-lg" href="../notes.html">Formula Sheets</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{q_count}</strong><small>Practice questions</small></div>
        <div class="seo-stat"><strong>{off_c}</strong><small>Official BI tasks &amp; exams</small></div>
        <div class="seo-stat"><strong>{duration} min</strong><small>Timed exam simulation</small></div>
        <div class="seo-stat"><strong>{high_c} / {med_c} / {low_c}</strong><small>High / Med / Low DLPFC</small></div>
      </div>
    </article>
{exam_block}
{collections_block}    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Syllabus coverage · {len(topic_names)} topics</span>
      <h2>Topics &amp; key exam concepts in {escape(code_pair)}</h2>
      {topics_html}
    </section>
{ref_preview_block}
    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">{escape(code_pair)} Exam Prep FAQ / Ofte stilte spørsmål</h2>
      <div class="seo-faq">
{course_faq_html}      </div>
    </section>

    <section class="panel seo-card">
      <span class="eyebrow">More BI Oslo courses &amp; tools</span>
      <h2>Other BI Oslo courses on Study-OS</h2>
      <div class="seo-cta-row" style="margin-top:8px">
        {other_links}
        <a class="ghost-btn" href="../gpa-calculator.html">GPA Calculator</a>
        <a class="ghost-btn" href="../universities.html">All Universities</a>
      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway (not officially affiliated with BI Norwegian Business School).</span>
      <nav aria-label="Footer links">
        <a href="../">App</a>
        <a href="../bi-oslo.html">BI Oslo</a>
        <a href="../norsk.html" lang="nb">Norsk</a>
        <a href="../universities.html">Universities</a>
        <a href="../wiseflow-practice.html">WISEflow</a>
        <a href="../gpa-calculator.html">GPA Calculator</a>
        <a href="../bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="../notes.html">Notes</a>
        <a href="../compare.html">Compare</a>
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

    # 1B. Clean `/courses/index.html` fallback (prevents GitHub Pages `/courses` -> `/courses/` 301->404 without cannibalizing `/bi-oslo.html`)
    courses_index_links = "".join(
        f'        <a class="ghost-btn" href="./{escape(str(c["courseId"]), quote=True)}.html">'
        f'{escape(_course_code_pair(str(c["courseId"]), str(c.get("code") or "")))} · {escape(str(c.get("shortTitle") or c.get("title") or ""))}</a>\n'
        for c in catalog if c.get("courseId")
    )
    courses_index_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="{base}/bi-oslo.html">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>BI Oslo Course Guides · Study-OS</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="stylesheet" href="{escape(seo_css_sub, quote=True)}">
</head>
<body>
  <main class="nf-shell">
    <article class="panel nf-card">
      <span class="eyebrow">Study-OS · Course Directory</span>
      <h1>BI Oslo &amp; Core Course Guides</h1>
      <p class="muted">Select a course guide below or open the complete BI Oslo exam-prep hub.</p>
      <div class="nf-links">
        <a class="primary-btn" href="../bi-oslo.html">Open BI Oslo Hub →</a>
{courses_index_links}        <a class="ghost-btn" href="../universities.html">All Universities</a>
      </div>
    </article>
  </main>
</body>
</html>
"""
    (courses_dir / "index.html").write_text(courses_index_html, encoding="utf-8")

    # 2. Dedicated Oslo / Norway bilingual landing page (`/bi-oslo.html`)
    oslo_title = "BI Oslo Exam Prep, WISEflow Mock Exams & Canvas Sync · Study-OS"
    oslo_desc = (
        f"Free BI Oslo study hub: {total_qs:,} practice questions (EXC/SØK 3420, EXC/BØK 3430, EXC/ORG 3460, EBA 3400, EBA 1181), "
        f"WISEflow mocks, notes & Canvas sync."
    )
    course_cards_html = "".join(
        f"""      <article class="panel seo-card">
        <div>
          <span class="eyebrow" style="color:{escape(str(c.get('color') or '#1f6b58'), quote=True)}">{escape(_course_code_pair(str(c['courseId']), str(c.get('code') or '')))} · {int(c.get('questionCount') or 0)} Qs</span>
          <h3>{escape(str(c.get('title') or ''))}</h3>
          <p>{escape(COURSE_NO_BLURBS.get(str(c.get('courseId') or ''), str((c.get('examInfo') or {}).get('format') or '')))}</p>
        </div>
        <div class="seo-cta-row">
          <a class="primary-btn" href="./courses/{escape(str(c['courseId']), quote=True)}.html">Course guide</a>
          <a class="ghost-btn" href="./?course={escape(str(c['courseId']), quote=True)}" rel="nofollow">Practice →</a>
        </div>
      </article>\n"""
        for c in catalog if c.get("courseId")
    )
    faq_items = [
        (
            "Hva er Study-OS for studenter i Oslo og på Handelshøyskolen BI?",
            "Study-OS (studyos.no) er en gratis, uavhengig studieplattform laget for studenter i Oslo — spesielt tilpasset BI-emner som EXC 3420 / SØK 3420, EXC 3430 / BØK 3430, EXC 3460 / ORG 3460, EBA 3400 og EBA 1181 / EBA 1180. Du får øvingsoppgaver, kursnotater, WISEflow-eksamensmodus, AI-veileder og 1-klikks synk med BI Canvas, TimeEdit og Ed Discussion.",
        ),
        (
            "Does Study-OS simulate WISEflow FLOWmulti and BYOD exams?",
            "Yes. The Exams Hub includes timed exam simulations modeled on BI's 3-hour WISEflow FLOWmulti and BYOD digital school exams, complete with Oslo exam countdowns, difficulty tiers (Low, Med, High DLPFC), and detailed review analytics.",
        ),
        (
            "How does 1-click BI Canvas, TimeEdit, and Ed Discussion sync work?",
            f"Install the Study-OS Sync v{ext_version} Chrome extension, pair it once with a 6-character code from studyos.no, keep your signed-in BI Canvas, TimeEdit, or Ed tabs open, and click Sync once. It never reads passwords or copies session cookies — it only imports your courses, assignment deadlines, and class timetable.",
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
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                    {"@type": "ListItem", "position": 2, "name": "BI Oslo Guide", "item": f"{base}/bi-oslo.html"},
                ],
            },
            {
                "@type": "WebPage",
                "@id": f"{base}/bi-oslo.html#webpage",
                "url": f"{base}/bi-oslo.html",
                "name": oslo_title,
                "description": oslo_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today_iso,
                "inLanguage": ["en", "nb"],
                "about": {"@type": "City", "name": "Oslo"},
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
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
                        "name": f"{_course_code_pair(str(c['courseId']), str(c.get('code') or ''))} · {c.get('title', '')}",
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
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <meta name="geo.position" content="59.9483;10.7686">
  <meta name="ICBM" content="59.9483, 10.7686">
  <link rel="canonical" href="{base}/bi-oslo.html">
  <link rel="alternate" type="text/markdown" href="{base}/bi-oslo.md" title="BI Oslo Guide (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/bi-oslo.html">
  <meta property="og:title" content="{escape(oslo_title, quote=True)}">
  <meta property="og:description" content="{escape(oslo_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS BI Oslo Exam Prep, Course Notes and WISEflow Practice Workspace">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(oslo_title, quote=True)}">
  <meta name="twitter:description" content="{escape(oslo_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(oslo_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(oslo_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS App</a>
        <a href="./universities.html" class="ghost-btn">All Universities</a>
        <a href="./gpa-calculator.html" class="ghost-btn">GPA Calculator</a>
      </div>
      <span class="badge">Oslo, Norway · BI Student Hub</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Oslo · Handelshøyskolen BI · Independent Student Project</span>
      <h1>BI Oslo Exam Prep, WISEflow Mock Exams &amp; Course Notes</h1>
      <p class="seo-lead">{escape(oslo_desc)}</p>
      <p class="seo-lead seo-lead-sub" lang="nb">
        Gratis eksamensforberedelse for BI-studenter i Oslo (Nydalen): øvingsoppgaver for EXC/SØK 3420, EXC/BØK 3430, EXC/ORG 3460, EBA 3400 og EBA 1181/1180, kursnotater, WISEflow FLOWmulti-simulator, AI-veileder og 1-klikks BI Canvas/TimeEdit-synk.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Launch Study-OS Workspace →</a>
        <a class="ghost-btn btn-lg" href="./wiseflow-practice.html">WISEflow Exam Simulator</a>
        <a class="ghost-btn btn-lg" href="./notes.html">Browse Course Notes ({len(references)})</a>
        <a class="ghost-btn btn-lg" href="./gpa-calculator.html">BI GPA Calculator</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{len(catalog)}</strong><small>BI Oslo courses</small></div>
        <div class="seo-stat"><strong>{total_qs:,}</strong><small>Practice questions</small></div>
        <div class="seo-stat"><strong>{len(references)}</strong><small>Reference sheets</small></div>
        <div class="seo-stat"><strong>100% Free</strong><small>No ads or trackers</small></div>
      </div>
      <figure class="seo-preview-media">
        <img src="{base}/og-image.png" width="1200" height="630" alt="Study-OS BI Oslo Exam Prep, Course Notes and WISEflow Practice Workspace" loading="eager" fetchpriority="high" decoding="async">
      </figure>
    </article>

    <section class="bi-demo-card" style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="eyebrow" style="margin:0;padding:3px 9px;border-radius:999px;background:var(--accent-soft)">12s Walkthrough</span>
        <strong style="font-size:14px">See the 3-Pane Study Workspace, Notes &amp; AI Tutor in action</strong>
      </div>
      <div class="ws-demo-viewport" aria-label="Animated walkthrough of Study-OS 3-Pane Workspace, context-matched notes, and solution review">
        <div class="ws-demo-camera">
          <div class="bi-demo-browser">
            <div class="bi-demo-chrome">
              <span class="bi-demo-dots"><i></i><i></i><i></i></span>
              <div class="bi-demo-tab active" style="display:inline-flex;align-items:center;gap:4px">
                <img class="bi-demo-picon" src="./pwa/favicon-48.png" width="12" height="12" alt="" style="width:12px;height:12px">
                studyos.no · 3-Pane Runner
              </div>
              <div class="bi-demo-tab">Adamlite Par 18:00</div>
              <div class="bi-demo-tab">FSRS-5</div>
            </div>
            <div class="ws-demo-grid">
              <div class="ws-demo-pane p-notes">
                <span class="ws-demo-ptag">Needed Notes</span>
                <div style="font-weight:700;color:#e2e8f0">Ch. 2 · Equilibrium &amp; Tax</div>
                <div class="ws-demo-formula">P* = MC(Q*) · slope = -P_F/P_E</div>
                <div style="color:#94a3b8;margin-top:4px">Auto-matched KaTeX notes &amp; inline PDFs</div>
              </div>
              <div class="ws-demo-pane">
                <span class="ws-demo-ptag">EXC 3420 · Task</span>
                <div style="font-weight:700;color:#f8fafc">Aluminium Market &amp; Tariff (a–e)</div>
                <div style="color:#cbd5e1;margin-top:4px">Competitive market at P = $80; a 25% input tariff raises MC by 15%.</div>
              </div>
              <div class="ws-demo-pane p-ans">
                <span class="ws-demo-ptag">Answer &amp; AI</span>
                <div class="ws-demo-field"><span>Post-tariff MC: 92</span><i>✓</i></div>
                <div class="ws-demo-field"><span>Hint 1/2 · Adamlite AI</span><i>✓</i></div>
                <div class="ws-demo-checkbtn">Reveal Solution</div>
                <div class="ws-demo-passed">✓ Mastered · Beat-AI Pace</div>
              </div>
            </div>
          </div>
          <div class="ws-demo-cursor" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#ffffff" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round">
              <path d="M5 3l14 9-6.5 1.4L9 20z"></path>
            </svg>
            <span class="ws-demo-ripple"></span>
          </div>
        </div>
        <div class="bi-demo-caption">
          <span class="bi-demo-cap ws-demo-cap1">1. Context-matched <b>KaTeX Notes &amp; PDFs</b> open beside the task</span>
          <span class="bi-demo-cap ws-demo-cap2">2. Draft answers, pull <b>Hints / Adamlite AI</b> &amp; reveal official solutions</span>
          <span class="bi-demo-cap ws-demo-cap3">3. Track <b>FSRS-5 mastery</b>, adaptive schedule &amp; Canvas sync ✓</span>
        </div>
        <div class="bi-demo-progress"><i class="ws-demo-bar"></i></div>
      </div>
    </section>

    <section>
      <h2 style="margin:0 0 8px">BI Oslo Courses &amp; Exam Guides (EN / NO Codes)</h2>
      <div class="seo-grid">
{course_cards_html}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:18px">
      <span class="eyebrow">Built for Oslo exam season</span>
      <h2>Why BI Oslo students use Study-OS</h2>
      <ul class="seo-topics">
        <li><strong>WISEflow FLOWmulti &amp; BYOD timing:</strong> Practice under realistic 180-minute Oslo exam conditions with automatic score and speed tracking.</li>
        <li><strong>Circadian DLPFC scheduling:</strong> Match High DLPFC synthesis problems to peak morning focus (08:00–15:00 Oslo) and lighter retrieval drills to evenings.</li>
        <li><strong>1-click BI Canvas, TimeEdit &amp; Ed sync:</strong> Pull courses, deadlines, and lectures straight from your open browser tabs with Study-OS Sync v{escape(ext_version)} — zero cookie copying.</li>
        <li><strong>Private curriculum PDFs &amp; AI Tutor:</strong> Drop your own lecture slides or textbooks (up to 260 MB locally) and ask Adamlite AI while solving exercises.</li>
      </ul>
      <div class="seo-cta-row" style="margin-top:10px">
        <a class="ghost-btn" href="./bi-canvas-timeedit-sync.html">BI Canvas &amp; TimeEdit Sync Guide</a>
        <a class="ghost-btn" href="./compare.html">Study-OS vs Notion, Anki &amp; Paid Portals</a>
        <a class="ghost-btn" href="./norsk.html" lang="nb">Les på norsk</a>
      </div>
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
        <a href="./universities.html">Universities</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./bi-canvas-timeedit-sync.html">BI Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./compare.html">Compare</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "bi-oslo.html").write_text(oslo_html, encoding="utf-8")

    # 3. Pure Norwegian Bokmål landing page (`/norsk.html`, lang="nb") — reciprocal hreflang with `/`
    nb_title = "Study-OS Norge · Gratis eksamensøving, Canvas-synk & WISEflow"
    nb_desc = (
        f"Gratis studieplattform for BI Oslo, UiA, NTNU, UiO, NHH, UiB & OsloMet: {total_qs:,} øvingsoppgaver, "
        f"WISEflow-simulator, karaktersnittkalkulator & 1-klikks Canvas-synk."
    )
    nb_faqs = [
        (
            "Hvilke BI-emner i Oslo støttes i Study-OS?",
            "Den åpne utgaven har øvingsoppgaver og notater for EXC 3420 / SØK 3420 (Economics I / samfunnsøkonomi), EXC 3430 / BØK 3430 (finansregnskap og bedriftsøkonomi), EXC 3460 / ORG 3460 (organisasjonsatferd og ledelse), EBA 3400 (Python-programmering og datavisualisering) og EBA 1181 / EBA 1180 (matematikk for datavitenskap). Du kan også synke alle dine egne Canvas-emner med 1 klikk.",
        ),
        (
            "Hvordan fungerer WISEflow FLOWmulti-simulatoren?",
            "I Exams-fanen kan du kjøre 3-timers tidsstyrte prøveeksamener som følger BI sine regler for desimalpunktum (.), minustegn for utbetalinger og ±2 % avrundingsmargin — med umiddelbar gjennomgang etter innlevering.",
        ),
        (
            "Hvordan synker jeg Canvas, TimeEdit/TP og Ed Discussion?",
            f"Med Chrome-utvidelsen Study-OS Sync v{ext_version} kobler du deg opp én gang med en 6-tegns kode fra studyos.no. Når du har åpne innloggede faner for Canvas (BI, UiA, NTNU, UiO, NHH, Mitt UiB, OsloMet m.fl.), TimeEdit / TP eller Ed, klikker du Sync én gang for å oppdatere fag, frister og forelesningstimeplan — helt uten passord eller kopiering av cookies.",
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
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                    {"@type": "ListItem", "position": 2, "name": "Norsk", "item": f"{base}/norsk.html"},
                ],
            },
            {
                "@type": "WebPage",
                "@id": f"{base}/norsk.html#webpage",
                "url": f"{base}/norsk.html",
                "name": nb_title,
                "description": nb_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today_iso,
                "inLanguage": "nb",
                "about": {"@type": "Country", "name": "Norway"},
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
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
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <meta name="geo.position" content="59.9483;10.7686">
  <link rel="canonical" href="{base}/norsk.html">
  <link rel="alternate" type="text/markdown" href="{base}/norsk.md" title="Study-OS på norsk (Markdown)">
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
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS Norge — Gratis eksamensøving, Canvas-synk og WISEflow">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(nb_title, quote=True)}">
  <meta name="twitter:description" content="{escape(nb_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(nb_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(nb_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Hovednavigasjon">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Åpne Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn" lang="en">English BI Guide</a>
        <a href="./gpa-calculator.html" class="ghost-btn">Karaktersnitt</a>
      </div>
      <span class="badge">Norge · Gratis uten betalingsmur</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Norge · BI Oslo, UiA, NTNU, UiO, NHH, UiB &amp; OsloMet</span>
      <h1>Gratis eksamensøving, Canvas-synk &amp; WISEflow for norske studenter</h1>
      <p class="seo-lead">{escape(nb_desc)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Start øving i Study-OS →</a>
        <a class="ghost-btn btn-lg" href="./universities.html">Velg universitet (UiA, NTNU, UiO, NHH…)</a>
        <a class="ghost-btn btn-lg" href="./gpa-calculator.html">Karaktersnitt Kalkulator</a>
        <a class="ghost-btn btn-lg" href="./bi-canvas-timeedit-sync.html">Canvas &amp; TimeEdit/TP Sync</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{len(catalog)}</strong><small>Komplette fagbanker</small></div>
        <div class="seo-stat"><strong>{total_qs:,}</strong><small>Øvingsoppgaver</small></div>
        <div class="seo-stat"><strong>{len(references)}</strong><small>Kursnotater &amp; formler</small></div>
        <div class="seo-stat"><strong>0 kr</strong><small>Ingen reklame</small></div>
      </div>
    </article>

    <section>
      <h2 style="margin:0 0 8px">BI-emner og felles norske økonomi- og realfag</h2>
      <div class="seo-grid">
{course_cards_html}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:18px">
      <span class="eyebrow">1-klikks Canvas, TimeEdit &amp; TP-synk</span>
      <h2>Velg ditt universitet eller høyskole i Norge</h2>
      <p>Study-OS Sync v{escape(ext_version)} kobler seg direkte til din innloggede Canvas- og timeplanfane uten Feide-passord:</p>
      <div class="seo-cta-row" style="margin-top:8px">
        <a class="ghost-btn" href="./bi-oslo.html">BI Oslo</a>
        <a class="ghost-btn" href="./uni/uia.html">UiA</a>
        <a class="ghost-btn" href="./uni/ntnu.html">NTNU</a>
        <a class="ghost-btn" href="./uni/uio.html">UiO</a>
        <a class="ghost-btn" href="./uni/nhh.html">NHH</a>
        <a class="ghost-btn" href="./uni/uib.html">Mitt UiB</a>
        <a class="ghost-btn" href="./uni/oslomet.html">OsloMet</a>
        <a class="ghost-btn" href="./universities.html">Alle universiteter →</a>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:18px">
      <span class="eyebrow">Smart studieteknikk i eksamensperioden</span>
      <h2>Alt du trenger til eksamen samlet på ett sted</h2>
      <ul class="seo-topics">
        <li><strong>Nedtelling til eksamen i Oslo-tid:</strong> Se nøyaktig hvor mange dager, timer og minutter som gjenstår til hver eksamen.</li>
        <li><strong>Døgnrytme og DLPFC-nivåer:</strong> Planlegg krevende regne- og caseoppgaver på formiddagen (08:00–15:00) og lettere repetisjon på kvelden.</li>
        <li><strong>Egne pensum-PDF-er &amp; AI-veileder:</strong> Slipp egne forelesningsnotater (opptil 260 MB lokalt i nettleseren) og få hjelp av Adamlite AI rett ved siden av oppgaven.</li>
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
        <a href="./bi-oslo.html" lang="en">BI Oslo</a>
        <a href="./universities.html">Universiteter</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./gpa-calculator.html">Karaktersnitt</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./notes.html">Notater</a>
        <a href="./compare.html">Sammenlign</a>
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
    wf_title = "BI WISEflow Øving & FLOWmulti Exam Simulator · Study-OS"
    wf_desc = (
        f"Gratis BI WISEflow øving & 3-timers FLOWmulti-simulator (BI Oslo & NHH): {total_flowmulti} flerfeltsoppgaver, "
        f"desimalpunktum (.), ±2 % margin & direkte retting."
    )
    wf_faqs = [
        (
            "What formatting rules matter most on a BI WISEflow FLOWmulti exam?",
            "Always use a dot (.) as the decimal separator (never a comma), include a leading minus sign (-50) for cash outflows or negative balances, follow exact unit instructions (e.g., NOK thousands vs NOK), and keep intermediate calculations unrounded to stay safely inside the ±2% numeric tolerance.",
        ),
        (
            "How many WISEflow FLOWmulti questions are available on Study-OS?",
            f"Study-OS includes {total_flowmulti} interactive multi-box WISEflow FLOWmulti exercises (centered on EXC 3430 / BØK 3430 Accounting & Finance) plus full 180-minute timed exam papers across {len(catalog)} courses ({total_qs:,} total questions).",
        ),
        (
            "Does Study-OS work for WISEflow exams at NHH, UiA, OsloMet, and USN?",
            "Yes. Any Norwegian university using WISEflow FLOWmulti or BYOD digital exams in accounting, corporate finance, economics, mathematics, or organizational behavior can use Study-OS's timed blind-exam mode for free.",
        ),
    ]
    wf_faq_html = "".join(
        f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
        for q, a in wf_faqs
    )
    wf_course_rows = "".join(
        f"""          <tr>
            <td><a href="./courses/{escape(str(c['courseId']), quote=True)}.html"><strong>{escape(_course_code_pair(str(c['courseId']), str(c.get('code') or '')))}</strong></a></td>
            <td>{escape(str(c.get('title') or ''))}</td>
            <td>{escape(str((c.get('examInfo') or {}).get('format') or 'Digital exam'))}</td>
            <td>{int(c.get('questionCount') or 0)} Qs</td>
          </tr>\n"""
        for c in catalog if c.get("courseId")
    )
    wf_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                    {"@type": "ListItem", "position": 2, "name": "WISEflow Practice", "item": f"{base}/wiseflow-practice.html"},
                ],
            },
            {
                "@type": "WebPage",
                "@id": f"{base}/wiseflow-practice.html#webpage",
                "name": wf_title,
                "url": f"{base}/wiseflow-practice.html",
                "description": wf_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today_iso,
                "inLanguage": ["en", "nb"],
                "about": ["WISEflow", "FLOWmulti", "BI Norwegian Business School", "Oslo exam preparation"],
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "HowTo",
                "name": "How to avoid formatting errors on a WISEflow FLOWmulti digital exam",
                "totalTime": "PT5M",
                "step": [
                    {"@type": "HowToStep", "position": 1, "text": "Use a dot (.) as decimal separator in numeric boxes, never a Norwegian comma (,)."},
                    {"@type": "HowToStep", "position": 2, "text": "Enter negative cash outflows with a leading minus sign (e.g. -45000), never parentheses."},
                    {"@type": "HowToStep", "position": 3, "text": "Keep full intermediate decimal precision until the final entry to stay inside the ±2% tolerance band."},
                    {"@type": "HowToStep", "position": 4, "text": "Rehearse a full 180-minute blind timed paper in Study-OS Exams Hub before exam day."},
                ],
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                    for q, a in wf_faqs
                ],
            },
        ],
    }
    wf_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(wf_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/wiseflow-practice.html">
  <link rel="alternate" type="text/markdown" href="{base}/wiseflow-practice.md" title="WISEflow Exam Simulator (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/wiseflow-practice.html">
  <meta property="og:title" content="{escape(wf_title, quote=True)}">
  <meta property="og:description" content="{escape(wf_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="WISEflow FLOWmulti and BYOD Exam Simulator on Study-OS">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(wf_title, quote=True)}">
  <meta name="twitter:description" content="{escape(wf_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(wf_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(wf_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
        <a href="./gpa-calculator.html" class="ghost-btn">GPA Calculator</a>
      </div>
      <span class="badge">WISEflow · FLOWmulti · Oslo</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">BI WISEflow Øving · BI Oslo &amp; Norwegian Digital Exams</span>
      <h1>BI WISEflow Øving &amp; FLOWmulti Exam Simulator</h1>
      <div class="seo-acu">
        <strong>Quick summary:</strong> Study-OS is a free, independent <strong>BI WISEflow &amp; FLOWmulti exam simulator</strong> with <strong>{total_flowmulti} multi-box FLOWmulti worksheets</strong> and <strong>{total_qs:,} practice questions</strong> across {len(catalog)} BI Oslo courses — enforcing dot-decimal (<code>.</code>) input, leading minus outflows (<code>-</code>), <code>±2%</code> tolerance, and blind 180-minute pacing (no login required).
      </div>
      <p class="seo-lead" lang="nb">
        Øv til BI WISEflow-eksamen med realistiske 3-timers prøveeksamener før eksamensdagen: lær reglene for desimalpunktum (.), negative kontantstrømmer (-50), avrundingsmargin (±2 %) og tidsstyring på BI Oslo, NHH, UiA og OsloMet — helt gratis uten innlogging.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./?view=exams" rel="nofollow">Launch WISEflow Exams Hub →</a>
        <a class="ghost-btn btn-lg" href="./courses/acct-2527.html">EXC/BØK 3430 FLOWmulti</a>
        <a class="ghost-btn btn-lg" href="./courses/econ-2522.html">EXC/SØK 3420 Economics</a>
        <a class="ghost-btn btn-lg" href="./courses/ob-2537.html">EXC/ORG 3460 MCQ</a>
      </div>
    </article>

    <section class="panel seo-card" style="margin-bottom:16px" id="wf-live-demo">
      <span class="eyebrow">Interactive Tryout · Zero Login Required</span>
      <h2>Test BI WISEflow FLOWmulti Formatting Live (EXC / BØK 3430)</h2>
      <p>
        <strong>Mini-case:</strong> Nordic Tech AS buys a machine for <strong>NOK 200,000</strong> today (<code>t = 0</code>), generating <strong>NOK 120,000</strong> at <code>t = 1</code> and <strong>NOK 130,000</strong> at <code>t = 2</code> (discount rate <code>r = 10%</code>). Enter all three boxes using official WISEflow numeric rules (dot <code>.</code> decimal, leading <code>-</code> for cash outflows, <code>±2%</code> tolerance):
      </p>
      <div class="wf-demo-grid">
        <div class="wf-demo-field" data-wf-box="cf0">
          <label for="wf-in-cf0">1. Initial Cash Flow at t = 0 (NOK)</label>
          <input id="wf-in-cf0" type="text" inputmode="text" placeholder="e.g. -200000" autocomplete="off">
          <span class="wf-demo-hint" id="wf-msg-cf0">Include sign for cash outflow</span>
        </div>
        <div class="wf-demo-field" data-wf-box="pv">
          <label for="wf-in-pv">2. Present Value of Inflows (t = 1 &amp; t = 2)</label>
          <input id="wf-in-pv" type="text" inputmode="text" placeholder="e.g. 216528.93" autocomplete="off">
          <span class="wf-demo-hint" id="wf-msg-pv">Use dot (.) decimal, never comma</span>
        </div>
        <div class="wf-demo-field" data-wf-box="npv">
          <label for="wf-in-npv">3. Net Present Value — NPV (NOK)</label>
          <input id="wf-in-npv" type="text" inputmode="text" placeholder="e.g. 16528.93" autocomplete="off">
          <span class="wf-demo-hint" id="wf-msg-npv">±2% tolerance around exact NPV</span>
        </div>
      </div>
      <div class="seo-cta-row">
        <button type="button" class="primary-btn" id="wf-check-btn">Check FLOWmulti Answers</button>
        <button type="button" class="ghost-btn" id="wf-fill-btn">Show Worked Values</button>
        <a class="ghost-btn" href="./?view=exams" rel="nofollow">Open All {total_flowmulti} FLOWmulti Worksheets →</a>
      </div>
      <div class="gpa-result-banner" id="wf-demo-status" aria-live="polite">
        Try typing <code>200000</code> (missing minus) or <code>216528,93</code> (Norwegian comma) to see the exact WISEflow formatting pitfalls Study-OS catches.
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Exam-day checklist · Avoid technical point loss</span>
      <h2>WISEflow FLOWmulti Formatting Rules</h2>
      <div class="seo-table-wrap">
        <table class="seo-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Correct Input</th>
              <th>Common Mistake to Avoid</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>Decimal separator</strong></td><td><code>12.50</code> (dot)</td><td>Comma <code>12,50</code> (misparsed in numeric boxes)</td></tr>
            <tr><td><strong>Negative values / cash outflows</strong></td><td><code>-45000</code> (leading minus)</td><td>Parentheses <code>(45000)</code> or omitting the minus sign</td></tr>
            <tr><td><strong>Rounding tolerance</strong></td><td>Keep unrounded intermediates (<code>±2%</code>)</td><td>Rounding intermediate ratios to 1 decimal too early</td></tr>
            <tr><td><strong>180-minute pacing</strong></td><td>~1 min per point on 180-pt BI papers</td><td>Spending 45+ minutes stuck on Part 1 before Part 3 cases</td></tr>
            <tr><td><strong>FLOWlock / Device Monitor</strong></td><td>Test official WISEflow Demoflow ≥30 min early</td><td>Launching Lockdown Browser 2 minutes before start</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Course-by-course simulation</span>
      <h2>BI Oslo Digital Exam Formats on Study-OS</h2>
      <div class="seo-table-wrap">
        <table class="seo-table">
          <thead>
            <tr>
              <th>Course Code</th>
              <th>Subject</th>
              <th>Exam Format</th>
              <th>Bank Size</th>
            </tr>
          </thead>
          <tbody>
{wf_course_rows}          </tbody>
        </table>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Built for BI WISEflow rules</span>
      <h2>What Study-OS trains before exam day</h2>
      <ul class="seo-topics">
        <li><strong>Multi-box FLOWmulti grading (EXC / BØK 3430):</strong> Trains dot-decimal input (<code>.</code> never comma), leading minus signs for outflows, and ±2% tolerance checks across multi-section accounting and finance exercises.</li>
        <li><strong>Timed 180-minute exam clock:</strong> Full paper countdown paired with per-question pace telemetry so you never run out of time on Part 3 analytical cases.</li>
        <li><strong>No-hint blind exam mode:</strong> Hides solutions and hints until you click <em>Submit Paper</em>, then produces a full error breakdown by topic and cognitive tier.</li>
        <li><strong>Live Oslo exam countdowns:</strong> Track exact days, hours, minutes, and seconds remaining to every upcoming BI Oslo exam date.</li>
      </ul>
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">WISEflow Exam Prep FAQ</h2>
      <div class="seo-faq">
{wf_faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./universities.html">Universities</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./compare.html">Compare</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
  <script>
    (function () {{
      var SPEC = [
        {{ key: 'cf0', target: -200000, tol: 0.001, requireNeg: true }},
        {{ key: 'pv', target: 216528.93, tol: 0.02, requireNeg: false }},
        {{ key: 'npv', target: 16528.93, tol: 0.02, requireNeg: false }}
      ];
      function checkAll() {{
        var passed = 0;
        SPEC.forEach(function (item) {{
          var wrap = document.querySelector('[data-wf-box="' + item.key + '"]');
          var inp = document.getElementById('wf-in-' + item.key);
          var msg = document.getElementById('wf-msg-' + item.key);
          var raw = String(inp.value || '').trim();
          wrap.classList.remove('ok', 'bad');
          if (!raw) {{
            wrap.classList.add('bad');
            msg.textContent = 'Enter a numeric value first.';
            return;
          }}
          if (raw.indexOf(',') !== -1) {{
            wrap.classList.add('bad');
            msg.textContent = 'Comma detected — WISEflow numeric boxes require dot (.) decimals and no thousand commas.';
            return;
          }}
          if (/^\\(.*\\)$/.test(raw)) {{
            wrap.classList.add('bad');
            msg.textContent = 'Parentheses detected — use a leading minus sign (e.g. -200000) on WISEflow.';
            return;
          }}
          var cleaned = raw.replace(/\\s+/g, '');
          var num = Number(cleaned);
          if (!Number.isFinite(num)) {{
            wrap.classList.add('bad');
            msg.textContent = 'Enter digits only (no NOK text or currency symbols).';
            return;
          }}
          if (item.requireNeg && num > 0 && Math.abs(num - Math.abs(item.target)) <= Math.abs(item.target) * 0.02) {{
            wrap.classList.add('bad');
            msg.textContent = 'Missing minus sign! Cash outflows at t = 0 must be negative (-200000).';
            return;
          }}
          var diff = Math.abs(num - item.target);
          var allowed = Math.abs(item.target) * item.tol;
          if (diff <= allowed) {{
            wrap.classList.add('ok');
            msg.textContent = '✓ Accepted inside WISEflow ±2% band (exact: ' + item.target + ').';
            passed++;
          }} else {{
            wrap.classList.add('bad');
            msg.textContent = 'Outside ±2% tolerance — check discounting (120000/1.1 + 130000/1.1²).';
          }}
        }});
        var status = document.getElementById('wf-demo-status');
        if (passed === SPEC.length) {{
          status.innerHTML = '<strong>3/3 passed!</strong> Ready for full 3-hour papers? Open the <a href="./?view=exams" rel="nofollow">WISEflow Exams Hub →</a>';
        }} else {{
          status.textContent = passed + '/3 boxes accepted — fix the highlighted WISEflow rule(s) above and check again.';
        }}
      }}
      document.getElementById('wf-check-btn')?.addEventListener('click', checkAll);
      document.getElementById('wf-fill-btn')?.addEventListener('click', function () {{
        document.getElementById('wf-in-cf0').value = '-200000';
        document.getElementById('wf-in-pv').value = '216528.93';
        document.getElementById('wf-in-npv').value = '16528.93';
        checkAll();
      }});
    }})();
  </script>
</body>
</html>
"""
    (out_dir / "wiseflow-practice.html").write_text(wf_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/wiseflow-practice.html", "0.85", "monthly"))

    # 5. Multi-School Canvas, TimeEdit/TP & Ed Discussion Sync landing page (`/bi-canvas-timeedit-sync.html`)
    sync_title = "Canvas LMS, TimeEdit & TP 1-Click Sync Extension · Study-OS"
    sync_desc = (
        f"Sync Canvas LMS courses & deadlines (BI, UiA, NTNU, UiO, NHH, UiB & *.instructure.com), "
        f"TimeEdit / TP timetables & Ed Discussion in 1 click (v{ext_version}) — zero passwords."
    )
    sync_faqs = [
        (
            f"Which universities work with Study-OS Sync v{ext_version}?",
            "Study-OS Sync works out of the box with BI Oslo (canvas.bi.no), UiA (uia.instructure.com & tp.educloud.no/uia), NTNU, UiO (canvas.uio.no & tp.uio.no), NHH, UiB (mitt.uib.no), OsloMet, UiS, UiT, USN, NMBU, HVL, Kristiania, and any university worldwide running Instructure Canvas (*.instructure.com).",
        ),
        (
            "Does Study-OS Sync need my school password or Feide credentials?",
            "Never. It runs locally inside your already signed-in Canvas, TimeEdit, TP, or Ed browser tab using same-origin browser requests and only transmits course codes, module titles, and private deadlines to your paired Study-OS account.",
        ),
        (
            "Does it support both TimeEdit and Norwegian TP (tp.educloud.no)?",
            "Yes. Study-OS Sync auto-detects both cloud.timeedit.net (BI, NHH, etc.) and tp.educloud.no / tp.uio.no (UiA, NTNU, UiO, UiB, OsloMet) and imports your lectures directly into your circadian study schedule.",
        ),
    ]
    sync_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                    {"@type": "ListItem", "position": 2, "name": "Canvas & Timetable Sync", "item": f"{base}/bi-canvas-timeedit-sync.html"},
                ],
            },
            {
                "@type": "WebPage",
                "@id": f"{base}/bi-canvas-timeedit-sync.html#webpage",
                "url": f"{base}/bi-canvas-timeedit-sync.html",
                "name": sync_title,
                "description": sync_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today_iso,
                "inLanguage": ["en", "nb"],
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "SoftwareApplication",
                "name": "Study-OS Sync",
                "applicationCategory": "BrowserApplication",
                "operatingSystem": "Chrome, Brave, Edge, Vivaldi",
                "url": f"{base}/bi-canvas-timeedit-sync.html",
                "downloadUrl": f"{base}/downloads/study-os-sync-extension.zip",
                "softwareVersion": ext_version,
                "isAccessibleForFree": True,
                "offers": {"@type": "Offer", "price": "0", "priceCurrency": "NOK"},
                "description": sync_desc,
            },
            {
                "@type": "HowTo",
                "name": "How to sync Canvas LMS, TimeEdit or TP, and Ed Discussion to Study-OS",
                "totalTime": "PT1M",
                "step": [
                    {"@type": "HowToStep", "position": 1, "text": f"Install Study-OS Sync v{ext_version} in Chrome, Brave, Edge, or Vivaldi."},
                    {"@type": "HowToStep", "position": 2, "text": "Sign in at studyos.no, open Sync Canvas, and generate a one-time 6-character pairing code."},
                    {"@type": "HowToStep", "position": 3, "text": "Open your signed-in Canvas (e.g. canvas.bi.no, uia.instructure.com, mitt.uib.no, or any *.instructure.com) and TimeEdit/TP tab, then click Sync once."},
                    {"@type": "HowToStep", "position": 4, "text": "Drop any personal lecture PDFs or textbooks (up to 260 MB locally) to unlock instant inline side-by-side PDF viewing."},
                ],
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                    for q, a in sync_faqs
                ],
            },
        ],
    }
    sync_faq_html = "".join(
        f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
        for q, a in sync_faqs
    )
    sync_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(sync_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/bi-canvas-timeedit-sync.html">
  <link rel="alternate" type="text/markdown" href="{base}/bi-canvas-timeedit-sync.md" title="Canvas & Timetable Sync (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/bi-canvas-timeedit-sync.html">
  <meta property="og:title" content="{escape(sync_title, quote=True)}">
  <meta property="og:description" content="{escape(sync_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS Sync 1-Click Canvas, TimeEdit and TP Extension">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(sync_title, quote=True)}">
  <meta name="twitter:description" content="{escape(sync_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(sync_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(sync_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./universities.html" class="ghost-btn">Universities</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
      </div>
      <span class="badge">Chrome Extension · v{escape(ext_version)} · Multi-School Auto-Sync + MV3</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Canvas LMS (BI · UiA · NHH · UiO · NTNU · UiB) · TimeEdit / TP · Ed</span>
      <h1>1-Click &amp; Auto Canvas, TimeEdit/TP &amp; Ed Sync</h1>
      <p class="seo-lead">{escape(sync_desc)}</p>
      <p class="seo-lead seo-lead-sub" lang="nb">
        Synkroniser aktive emner og frister fra <strong>Canvas</strong> (BI Oslo, UiA, NHH, UiO, NTNU, OsloMet, UiB, UiS, UiT, USN, NMBU, HVL og Kristiania), timeplanen din fra <strong>TimeEdit / TP</strong> og tråder fra <strong>Ed Discussion</strong> automatisk eller med 1 klikk — helt uten skolepassord.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Open Study-OS → Sync Canvas</a>
        <a class="ghost-btn btn-lg" href="./downloads/study-os-sync-extension.zip" download>Download Extension ZIP (v{escape(ext_version)})</a>
        <a class="ghost-btn btn-lg" href="./?view=schedule" rel="nofollow">Schedule Studio</a>
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
                  <img class="bi-demo-picon" src="./pwa/favicon-48.png" width="16" height="16" alt="">
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
        <li><strong>1. Pair once:</strong> Sign in at <code>studyos.no</code>, click <strong>Sync Canvas</strong>, and copy a 6-character pairing code into the extension popup.</li>
        <li><strong>2. Keep your school tabs open:</strong> Leave your signed-in Canvas tab (<code>canvas.bi.no</code>, <code>uia.instructure.com</code>, <code>mitt.uib.no</code>, <code>*.instructure.com</code>), <code>cloud.timeedit.net</code> / <code>tp.educloud.no</code>, or <code>edstem.org</code> open in Chrome, Brave, Edge, or Vivaldi.</li>
        <li><strong>3. Click Sync once:</strong> Pulls active courses, module outlines, assignment due dates, and TimeEdit/TP class lectures into your private Study-OS schedule and course list.</li>
        <li><strong>4. Attach your own PDFs:</strong> Drop personal curriculum PDFs, lecture slides, or full textbooks (up to 260 MB locally) for instant inline split-screen PDF viewing with built-in search.</li>
      </ul>
      <div class="seo-cta-row" style="margin-top:12px">
        <a class="ghost-btn" href="./universities.html">All Universities</a>
        <a class="ghost-btn" href="./uni/uia.html">UiA Guide</a>
        <a class="ghost-btn" href="./uni/ntnu.html">NTNU Guide</a>
        <a class="ghost-btn" href="./uni/uio.html">UiO Guide</a>
        <a class="ghost-btn" href="./uni/nhh.html">NHH Guide</a>
        <a class="ghost-btn" href="./uni/uib.html">UiB Guide</a>
        <a class="ghost-btn" href="./uni/oslomet.html">OsloMet Guide</a>
        <a class="ghost-btn" href="./uni/canvas-lms.html">Any Canvas School</a>
      </div>
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">Sync FAQ / Ofte stilte spørsmål</h2>
      <div class="seo-faq">
{sync_faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent open-source student project in Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./universities.html">Universities</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./compare.html">Compare</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
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
        f"Browse {len(references)} BI Oslo KaTeX formula sheets & course notes for EXC/SØK 3420, EXC/BØK 3430, "
        f"EXC/ORG 3460, EBA 3400 Python & EBA 1181/1180 Math — 100% free."
    )
    ref_cards_parts: list[str] = []
    ref_itemlist_elements: list[dict[str, Any]] = []
    for ref_idx, ref in enumerate(references):
        rfile = str(ref.get("file") or "")
        rtitle = str(ref.get("title") or rfile)
        rsub = str(ref.get("subtitle") or ref.get("semester") or "Reference Sheet")
        r_cid = str(ref.get("courseId") or "").strip()
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
        toc_html = (
            '<ul class="seo-topics">'
            + "".join(f"<li>{escape(h)}</li>" for h in shown_toc)
            + "</ul>"
            if shown_toc else ""
        )
        # Deduplicate companion entries by file path
        seen_comp: set[str] = set()
        comp_labels: list[str] = []
        for comp in (ref.get("companions") or []):
            c_file = str(comp.get("file") or "").strip()
            c_lbl = str(comp.get("label") or "").strip()
            if c_file and c_file not in seen_comp and c_lbl:
                seen_comp.add(c_file)
                comp_labels.append(c_lbl)
        comp_meta = f' · Includes: {", ".join(comp_labels)}' if comp_labels else ""
        note_qs = quote(rfile, safe="")
        course_btn = (
            f'<a class="ghost-btn" href="./courses/{escape(r_cid, quote=True)}.html">Course guide</a>'
            if r_cid else ""
        )
        ref_itemlist_elements.append({
            "@type": "ListItem",
            "position": ref_idx + 1,
            "name": rtitle,
            "url": f"{base}/courses/{r_cid}.html" if r_cid else f"{base}/notes.html",
        })
        ref_cards_parts.append(
            f"""    <section class="panel seo-card" style="margin-bottom:14px">
      <div class="seo-nav" style="margin-bottom:4px">
        <div>
          <span class="eyebrow">{escape(rsub)}{escape(comp_meta)}</span>
          <h2 style="margin:2px 0 0">{escape(rtitle)}</h2>
        </div>
        <div class="seo-cta-row">
          {course_btn}
          <a class="primary-btn" href="./?view=references&amp;note={note_qs}" rel="nofollow">Open notes →</a>
        </div>
      </div>
      {toc_html}
    </section>\n"""
        )
    notes_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Study-OS", "item": f"{base}/"},
                    {"@type": "ListItem", "position": 2, "name": "Course Notes", "item": f"{base}/notes.html"},
                ],
            },
            {
                "@type": "CollectionPage",
                "@id": f"{base}/notes.html#webpage",
                "name": notes_title,
                "url": f"{base}/notes.html",
                "description": notes_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today_iso,
                "inLanguage": ["en", "nb"],
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "ItemList",
                "name": "Study-OS BI Oslo Course Reference Sheets",
                "itemListElement": ref_itemlist_elements,
            },
        ],
    }
    notes_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(notes_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO-03">
  <meta name="geo.placename" content="Oslo, Norway">
  <link rel="canonical" href="{base}/notes.html">
  <link rel="alternate" type="text/markdown" href="{base}/notes.md" title="Course Notes & Reference Hub (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/notes.html">
  <meta property="og:title" content="{escape(notes_title, quote=True)}">
  <meta property="og:description" content="{escape(notes_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS BI Oslo Course Notes, Formula Sheets and Reference Hub">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(notes_title, quote=True)}">
  <meta name="twitter:description" content="{escape(notes_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{SEO_THEME_SCRIPT}
  <title>{escape(notes_title)}</title>
{SEO_ICON_LINKS}
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(notes_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./bi-oslo.html" class="ghost-btn">BI Oslo Guide</a>
        <a href="./wiseflow-practice.html" class="ghost-btn">WISEflow</a>
      </div>
      <span class="badge">{len(references)} Reference Sheets · KaTeX &amp; Diagrams</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Multi-Semester Reference Hub · Oslo</span>
      <h1>BI Oslo Course Notes &amp; Formula Sheets</h1>
      <p class="seo-lead">{escape(notes_desc)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./?view=references" rel="nofollow">Open Interactive Notes Reader →</a>
        <a class="ghost-btn btn-lg" href="./bi-oslo.html">Browse Courses</a>
        <a class="ghost-btn btn-lg" href="./gpa-calculator.html">GPA Calculator</a>
      </div>
    </article>

{"".join(ref_cards_parts)}
    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Oslo, Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./universities.html">Universities</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./compare.html">Compare</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "notes.html").write_text(notes_html, encoding="utf-8")
    sitemap_urls.append((f"{base}/notes.html", "0.8", "weekly"))

    # 6B. Multi-University Hubs (`/universities.html`, `/uni/*.html`), GPA Calculator (`/gpa-calculator.html`), and Comparison (`/compare.html`)
    from seo_pages import COMPARE_FAQS, GPA_FAQS, UNIVERSITIES, generate_growth_seo_pages
    growth_entries = generate_growth_seo_pages(
        out_dir=out_dir,
        base=base,
        total_qs=total_qs,
        ref_count=len(references),
        seo_theme_script=SEO_THEME_SCRIPT,
        seo_page_style="",
        catalog=catalog,
        ext_version=ext_version,
        seo_css_root=seo_css_root,
        seo_css_sub=seo_css_sub,
        today_iso=today_iso,
    )
    sitemap_urls.extend(growth_entries)

    # 7. AI Search / GEO Markdown mirrors (all 23 public pages), `/llms.txt`, and `/llms-full.txt`
    from geo_markdown import generate_geo_markdown
    generate_geo_markdown(
        out_dir=out_dir,
        base=base,
        bootstrap=bootstrap,
        course_no_blurbs=COURSE_NO_BLURBS,
        universities=UNIVERSITIES,
        bi_oslo_faqs=faq_items,
        norsk_faqs=nb_faqs,
        sync_faqs=sync_faqs,
        gpa_faqs=GPA_FAQS,
        compare_faqs=COMPARE_FAQS,
        ext_version=ext_version,
        wiseflow_faqs=wf_faqs,
    )

    # 8. Auto-generated XML Sitemap (`sitemap.xml`) with xhtml:link reciprocal hreflang for `/` <-> `/norsk.html`
    sitemap_urls.extend([
        (f"{base}/privacy.html", "0.3", "yearly"),
        (f"{base}/terms.html", "0.3", "yearly"),
    ])
    hreflang_pair = {f"{base}/", f"{base}/norsk.html"}
    hreflang_xml = (
        f'    <xhtml:link rel="alternate" hreflang="en" href="{escape(base)}/"/>\n'
        f'    <xhtml:link rel="alternate" hreflang="nb-NO" href="{escape(base)}/norsk.html"/>\n'
        f'    <xhtml:link rel="alternate" hreflang="x-default" href="{escape(base)}/"/>\n'
    )
    url_entries_parts: list[str] = []
    for loc, prio, freq in sitemap_urls:
        alts = hreflang_xml if loc in hreflang_pair else ""
        url_entries_parts.append(
            f"  <url>\n"
            f"    <loc>{escape(loc)}</loc>\n"
            f"{alts}"
            f"    <lastmod>{today_iso}</lastmod>\n"
            f"    <changefreq>{freq}</changefreq>\n"
            f"    <priority>{prio}</priority>\n"
            f"  </url>\n"
        )
    sitemap_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f"{''.join(url_entries_parts)}"
        "</urlset>\n"
    )
    (out_dir / "sitemap.xml").write_text(sitemap_xml, encoding="utf-8")
    return [loc for loc, _, _ in sitemap_urls]


def finalize_site(
    out_dir: Path,
    bootstrap: dict[str, Any],
    member_archive: Path | None = None,
    pdfcraft_archive: Path | None = None,
) -> dict[str, Any]:
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
        topic_map = {}
        for t_item in course_entry.get("topics", []):
            tid = str(t_item.get("id", ""))
            if tid:
                topic_map[tid] = {
                    "id": tid,
                    "title": t_item.get("title", f"Topic {tid}"),
                    "questionCount": 0,
                    "parMinutes": 0.0,
                    "questionIds": [],
                }
        for q in cqs:
            t = int(q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0])
            t_clamped = min(3, max(1, t))
            tier_ids[str(t_clamped)].append(q["id"])
            tid = str(q.get("topicId", ""))
            if tid:
                if tid not in topic_map:
                    topic_map[tid] = {
                        "id": tid,
                        "title": f"Topic {tid}",
                        "questionCount": 0,
                        "parMinutes": 0.0,
                        "questionIds": [],
                    }
                raw_learn_min = float((q.get("pacing") or {}).get("learning", {}).get("target") or (2.0 if q.get("kind") == "mcq" else 6.0))
                if q.get("kind") == "mcq":
                    text_len = len(q.get("contextMarkdown") or "") + len(q.get("promptMarkdown") or "") + sum(len(str(o)) for o in (q.get("options") or []))
                    extra_cap = 25 if t_clamped == 1 else (35 if t_clamped == 2 else 45)
                    extra_s = min(extra_cap, round(max(0, text_len - 160) / 14))
                    base_s = 50 if t_clamped == 1 else (80 if t_clamped == 2 else 120)
                    max_s = 85 if t_clamped == 1 else (135 if t_clamped == 2 else 190)
                    par_min = min(raw_learn_min * 60.0, max_s, base_s + extra_s) / 60.0
                else:
                    par_min = max(1.0, raw_learn_min)
                tm = topic_map[tid]
                tm["questionCount"] += 1
                tm["parMinutes"] = round(tm["parMinutes"] + par_min, 1)
                tm["questionIds"].append(q["id"])
        course_entry["tierQuestionIds"] = tier_ids
        course_entry["lowDlpfcCount"] = len(tier_ids["1"])
        course_entry["medDlpfcCount"] = len(tier_ids["2"])
        course_entry["highDlpfcCount"] = len(tier_ids["3"])
        course_entry["topicStats"] = [v for v in topic_map.values() if v["questionCount"] > 0]
        by_coll_qids: dict[str, list[str]] = {}
        by_coll_par: dict[str, float] = {}
        by_coll_auto: dict[str, int] = {}
        by_coll_pts: dict[str, float] = {}
        for q in cqs:
            col_id = str(q.get("collectionId") or "")
            if not col_id:
                continue
            by_coll_qids.setdefault(col_id, []).append(q["id"])
            is_auto_q = (
                q.get("kind") == "mcq"
                or bool(q.get("wiseflowFields"))
                or bool(q.get("numericCheck"))
            )
            if is_auto_q:
                by_coll_auto[col_id] = by_coll_auto.get(col_id, 0) + 1
            q_pts = q.get("points")
            by_coll_pts[col_id] = by_coll_pts.get(col_id, 0.0) + (
                float(q_pts) if isinstance(q_pts, (int, float)) and q_pts > 0 else (2.0 if q.get("kind") == "mcq" else 10.0)
            )
            p = q.get("pacing") or {}
            t_min = (p.get("exam") or {}).get("target") or (p.get("learning") or {}).get("target")
            by_coll_par[col_id] = by_coll_par.get(col_id, 0.0) + (
                float(t_min) if isinstance(t_min, (int, float)) and t_min > 0 else (2.0 if q.get("kind") == "mcq" else 6.0)
            )
        enriched_colls = []
        for col in course_entry.get("collections") or []:
            c_copy = dict(col)
            cid_col = str(col.get("id") or "")
            qids_col = by_coll_qids.get(cid_col, [])
            q_n = len(qids_col)
            auto_n = by_coll_auto.get(cid_col, 0)
            c_copy["questionIds"] = qids_col
            c_copy["questionCount"] = q_n
            c_copy["parMinutes"] = round(by_coll_par.get(cid_col, 0.0))
            c_copy["totalPoints"] = round(by_coll_pts.get(cid_col, 0.0), 1)
            c_copy["gradingMode"] = (
                "auto" if q_n > 0 and auto_n == q_n else ("mixed" if auto_n > 0 else "rubric")
            )
            enriched_colls.append(c_copy)
        course_entry["collections"] = enriched_colls
    boot_bytes = (json.dumps(bootstrap, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (static_dir / "bootstrap.json").write_bytes(boot_bytes)
    boot_hash = hashlib.sha256(boot_bytes).hexdigest()[:8]
    index = out_dir / "index.html"
    html = index.read_text(encoding="utf-8")
    member_marker = ' data-member-library="1"' if member_archive else ''
    pdfcraft_marker = ' data-pdfcraft="1"' if pdfcraft_archive else ''
    boot_marker = f' data-boot-v="{boot_hash}"'
    community_marker = ""
    config = ROOT_DIR / "site-pack" / "community.json"
    if config.is_file():
        endpoint = json.loads(config.read_text(encoding="utf-8"))["api"].rstrip("/")
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("The community endpoint must be an HTTPS URL without credentials.")
        community_marker = f' data-community-api="{escape(endpoint, quote=True)}"'
    html = html.replace("<html ", f'<html data-study-mode="web"{boot_marker}{member_marker}{pdfcraft_marker}{community_marker} ', 1)
    html = html.replace(
        "</head>",
        '  <link rel="manifest" href="./app.webmanifest">\n'
        f'  <link rel="preload" href="./static-data/bootstrap.json?v={boot_hash}" as="fetch" crossorigin>\n'
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
        ext_skip_names = {"CHROMEWEBSTORE.md", "README.md", "Thumbs.db", ".DS_Store"}
        ext_skip_suffixes = {".sh", ".zip", ".map"}
        with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as zf:
            for item in sorted(ext_src.rglob("*")):
                rel_parts = item.relative_to(ext_src).parts
                if (
                    item.is_file()
                    and not any(part.startswith(".") for part in rel_parts)
                    and "store-assets" not in rel_parts
                    and item.name not in ext_skip_names
                    and item.suffix.lower() not in ext_skip_suffixes
                ):
                    zf.write(item, item.relative_to(ext_src).as_posix())

    # Generate static indexable Oslo & per-course SEO pages plus sitemap.xml
    seo_urls = generate_seo_pages(out_dir, bootstrap)

    template = (ROOT_DIR / "tools" / "offline-worker.js").read_bytes()
    fingerprint = hashlib.sha256(template)
    assets = []
    seo_skip_files = {
        ".nojekyll", "CNAME", "404.html", "robots.txt", "sitemap.xml", "llms.txt", "llms-full.txt",
        "seo.css", "og-image.png", "favicon.ico", "bi-oslo.html", "norsk.html",
        "wiseflow-practice.html", "bi-canvas-timeedit-sync.html", "notes.html",
        "universities.html", "gpa-calculator.html", "compare.html",
        "7d4c9e2a8b1f4063a5e7c2d9f1b84e60.txt",
    }
    for path in sorted(out_dir.rglob("*")):
        if path.is_file() and path.name not in seo_skip_files:
            if path.suffix.lower() == ".md":
                continue
            rel = path.relative_to(out_dir).as_posix()
            if rel.startswith("downloads/") or rel.startswith("courses/") or rel.startswith("uni/") or rel.startswith("pdfcraft/"):
                continue
            assets.append(quote(rel, safe="/"))
            fingerprint.update(rel.encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest())
    (out_dir / "offline-worker.js").write_bytes(
        (f"const VERSION = {json.dumps(fingerprint.hexdigest()[:20])};\n"
         f"const ASSETS = {json.dumps(assets)};\n").encode() + template
    )
    if member_archive:
        install_member_library(out_dir, member_archive)
    if pdfcraft_archive:
        install_pdfcraft_web(out_dir, pdfcraft_archive)
    return {
        "outDir": str(out_dir),
        "coursesExported": len(bootstrap["catalog"]),
        "questionsExported": sum(c["questionCount"] for c in bootstrap["catalog"]),
        "referencesExported": len(bootstrap["references"]),
        "seoPages": len(seo_urls),
    }


def build_site(
    out_dir: Path,
    cname: str = "",
    member_archive: Path | None = None,
    pdfcraft_archive: Path | None = None,
) -> dict[str, Any]:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(APP_DIR / "public", out_dir, ignore=shutil.ignore_patterns("pdfcraft"))
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
        return finalize_site(out_dir, boot_saved, member_archive, pdfcraft_archive)

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
    return finalize_site(out_dir, bootstrap_payload, member_archive, pdfcraft_archive)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build static public web bundle of Study-OS.")
    parser.add_argument("--out", default=str(ROOT_DIR / "dist"), help="Output directory (default: ./dist)")
    parser.add_argument("--cname", default="", help="Optional custom domain for GitHub Pages CNAME file")
    parser.add_argument("--member-archive", type=Path, help="Verified encrypted library release asset")
    parser.add_argument("--pdfcraft-archive", type=Path, help="Verified storytold/pdfcraft web release zip")
    parser.add_argument(
        "--sync-pack",
        action="store_true",
        help="Also snapshot copyright-safe static-data/ into ./site-pack/static-data for GitHub Pages CI",
    )
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    summary = build_site(
        out_path,
        cname=args.cname,
        member_archive=args.member_archive,
        pdfcraft_archive=args.pdfcraft_archive,
    )
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
