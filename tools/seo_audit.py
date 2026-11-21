#!/usr/bin/env python3
"""Automated static SEO QA audit for Study-OS dist/ output.

Checks:
- Every HTML page listed in sitemap.xml exists on disk
- Unique <title> and non-empty <meta name="description">
- Canonical link, OG tags, and valid parseable JSON-LD scripts
- Zero orphan pages (every sitemap HTML URL receives >= 1 internal link from other pages)
- Zero broken internal relative HTML links
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit


class PageInspector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title_parts: list[str] = []
        self.in_title = False
        self.in_ld = False
        self.ld_buf: list[str] = []
        self.json_lds: list[str] = []
        self.meta_desc = ""
        self.canonical = ""
        self.og_title = ""
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "title":
            self.in_title = True
        elif t == "script" and a.get("type", "").lower() == "application/ld+json":
            self.in_ld = True
            self.ld_buf = []
        elif t == "meta":
            if a.get("name", "").lower() == "description":
                self.meta_desc = a.get("content", "").strip()
            elif a.get("property", "").lower() == "og:title":
                self.og_title = a.get("content", "").strip()
        elif t == "link" and a.get("rel", "").lower() == "canonical":
            self.canonical = a.get("href", "").strip()
        elif t == "a" and a.get("href"):
            self.links.append(a["href"].strip())

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self.in_title = False
        elif t == "script" and self.in_ld:
            self.in_ld = False
            self.json_lds.append("".join(self.ld_buf).strip())

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if self.in_ld:
            self.ld_buf.append(data)


def audit(dist_dir: Path, base_url: str = "https://studyos.no") -> list[str]:
    errors: list[str] = []
    sm_path = dist_dir / "sitemap.xml"
    if not sm_path.is_file():
        return [f"Missing sitemap.xml in {dist_dir}"]

    root = ET.fromstring(sm_path.read_text(encoding="utf-8"))
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    sitemap_urls = [el.text.strip() for el in root.findall(f".//{ns}loc") if el.text]
    if not sitemap_urls:
        return ["sitemap.xml has 0 URLs"]

    seen_titles: dict[str, str] = {}
    inbound_counts: dict[str, int] = {u: 0 for u in sitemap_urls}

    for url in sitemap_urls:
        rel = url.removeprefix(base_url).lstrip("/")
        target = dist_dir / (rel if rel else "index.html")
        if not target.is_file():
            errors.append(f"Sitemap URL missing file: {url} -> {target}")
            continue
        html = target.read_text(encoding="utf-8")
        p = PageInspector()
        p.feed(html)
        title = re.sub(r"\s+", " ", "".join(p.title_parts)).strip()
        if not title:
            errors.append(f"{rel or 'index.html'}: missing <title>")
        elif title in seen_titles:
            errors.append(f"Duplicate <title> '{title}' on {rel} and {seen_titles[title]}")
        else:
            seen_titles[title] = rel or "index.html"

        if rel not in ("privacy.html", "terms.html"):
            if len(p.meta_desc) < 60:
                errors.append(f"{rel or 'index.html'}: meta description too short ({len(p.meta_desc)} chars)")
            if not p.canonical:
                errors.append(f"{rel or 'index.html'}: missing canonical link")
            if not p.og_title:
                errors.append(f"{rel or 'index.html'}: missing og:title")

        for idx, raw_ld in enumerate(p.json_lds):
            try:
                json.loads(raw_ld)
            except Exception as exc:
                errors.append(f"{rel or 'index.html'}: invalid JSON-LD #{idx + 1}: {exc}")

        for href in p.links:
            if href.startswith(("http://", "https://", "mailto:", "javascript:", "#", "obsidian:")):
                continue
            resolved = urljoin(url, href)
            parsed = urlsplit(resolved)
            clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            if clean_url in inbound_counts and clean_url != url:
                inbound_counts[clean_url] += 1
            if parsed.netloc == urlsplit(base_url).netloc:
                rel_dest = parsed.path.lstrip("/")
                dest_file = dist_dir / (rel_dest if rel_dest else "index.html")
                if rel_dest and not dest_file.is_file():
                    errors.append(f"{rel or 'index.html'}: broken internal link '{href}' -> {dest_file}")

    for url, count in inbound_counts.items():
        if url.rstrip("/") == base_url.rstrip("/"):
            continue
        if count == 0:
            errors.append(f"Orphan sitemap page (0 inbound internal links): {url}")

    print(f"SEO Audit checked {len(sitemap_urls)} sitemap URLs: {len(errors)} error(s)")
    for u, c in sorted(inbound_counts.items()):
        print(f"  {c:2d} inbound | {u}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args()
    errs = audit(args.dir)
    if errs:
        for e in errs:
            print("ERROR:", e, file=sys.stderr)
        return 1
    print("SEO AUDIT PASSED!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
