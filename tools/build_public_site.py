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
import json
from pathlib import Path
import re
import shutil
import sys
from typing import Any

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
from server import STORE  # noqa: E402


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


def filter_public_safe_bank(bank: dict[str, Any]) -> dict[str, Any] | None:
    """Keep only original/synthetic/mock items without copyrighted university PDF crops."""
    safe_origins = {"synthetic_drill", "mock_exam"}
    safe_qs: list[dict[str, Any]] = []
    for q in bank.get("questions") or []:
        if not q.get("available", True):
            continue
        if q.get("origin") not in safe_origins:
            continue
        if q.get("promptAssets") or q.get("contextAssets") or q.get("solutionAssets"):
            continue
        q_clean = dict(q)
        q_clean["sources"] = {}
        safe_qs.append(q_clean)

    if not safe_qs:
        return None

    used_colls = {q.get("collectionId") for q in safe_qs}
    out = dict(bank)
    out["collections"] = [c for c in (bank.get("collections") or []) if c.get("id") in used_colls]
    out["sources"] = {}
    out["questions"] = safe_qs
    return out


def build_catalog_entry(bank: dict[str, Any]) -> dict[str, Any]:
    qs = [q for q in (bank.get("questions") or []) if q.get("available", True)]
    obs = bank.get("obsidian") or {}
    main_ref = obs.get("mainReference") or ""
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


def build_site(out_dir: Path, cname: str = "") -> dict[str, Any]:
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
        return {
            "outDir": str(out_dir),
            "coursesExported": len(boot_saved.get("catalog") or []),
            "questionsExported": sum(c.get("questionCount", 0) for c in (boot_saved.get("catalog") or [])),
            "referencesExported": len(boot_saved.get("references") or []),
        }

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
    (static_dir / "bootstrap.json").write_text(
        json.dumps(bootstrap_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return {
        "outDir": str(out_dir),
        "coursesExported": len(public_catalog),
        "questionsExported": sum(c["questionCount"] for c in public_catalog),
        "referencesExported": len(exported_refs),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build static public web bundle of Study-OS.")
    parser.add_argument("--out", default=str(ROOT_DIR / "dist"), help="Output directory (default: ./dist)")
    parser.add_argument("--cname", default="", help="Optional custom domain for GitHub Pages CNAME file")
    parser.add_argument(
        "--sync-pack",
        action="store_true",
        help="Also snapshot copyright-safe static-data/ into ./site-pack/static-data for GitHub Pages CI",
    )
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    summary = build_site(out_path, cname=args.cname)
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
