#!/usr/bin/env python3
"""Automated static SEO & GEO QA audit for Study-OS dist/ output.

Checks:
- Every HTML page listed in sitemap.xml exists on disk and has self-referencing canonical
- Unique <title>, valid <html lang>, single <h1>, meta description, OG/Twitter tags, and parseable JSON-LD
- Reciprocal self-referencing hreflang validation across HTML pages and sitemap.xml
- Zero robots.txt conflicts (no disallowed sitemap URLs, no dofollow internal links to disallowed paths)
- Utility & directory fallback pages carry noindex (canvas-connect, tutor-bridge, 404, courses/index, uni/index, pdfcraft)
- Static SEO landing pages use lightweight seo.css (< 25 KB) and mark SPA query links rel="nofollow"
- Zero orphan pages and zero broken internal relative HTML links
- Valid Markdown mirrors (.md), /llms.txt, and /llms-full.txt
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
        self.html_lang = ""
        self.title_parts: list[str] = []
        self.in_title = False
        self.in_ld = False
        self.ld_buf: list[str] = []
        self.json_lds: list[str] = []
        self.h1_count = 0
        self.meta_desc = ""
        self.meta_robots = ""
        self.canonical = ""
        self.og_title = ""
        self.og_desc = ""
        self.og_image = ""
        self.twitter_card = ""
        self.markdown_alt = ""
        self.hreflangs: dict[str, str] = {}
        self.stylesheets: list[str] = []
        self.links: list[tuple[str, str]] = []  # (href, rel)
        self.empty_img_srcs = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "html":
            self.html_lang = a.get("lang", "").strip()
        elif t == "title":
            self.in_title = True
        elif t == "h1":
            self.h1_count += 1
        elif t == "img" and "src" in a and a["src"].strip() == "":
            self.empty_img_srcs += 1
        elif t == "script" and a.get("type", "").lower() == "application/ld+json":
            self.in_ld = True
            self.ld_buf = []
        elif t == "meta":
            name = a.get("name", "").lower()
            prop = a.get("property", "").lower()
            content = a.get("content", "").strip()
            if name == "description":
                self.meta_desc = content
            elif name == "robots":
                self.meta_robots = content.lower()
            elif name == "twitter:card":
                self.twitter_card = content
            elif prop == "og:title":
                self.og_title = content
            elif prop == "og:description":
                self.og_desc = content
            elif prop == "og:image":
                self.og_image = content
        elif t == "link":
            rel_val = a.get("rel", "").lower()
            href = a.get("href", "").strip()
            if rel_val == "canonical":
                self.canonical = href
            elif rel_val == "stylesheet" and href:
                self.stylesheets.append(href)
            elif rel_val == "alternate":
                if a.get("type", "").lower() == "text/markdown":
                    self.markdown_alt = href
                elif a.get("hreflang"):
                    self.hreflangs[a["hreflang"].strip().lower()] = href
        elif t == "a" and a.get("href"):
            self.links.append((a["href"].strip(), a.get("rel", "").lower()))

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


def _parse_robots_disallow(robots_path: Path) -> list[str]:
    if not robots_path.is_file():
        return []
    disallows: list[str] = []
    in_star = False
    for raw in robots_path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.lower().startswith("user-agent:"):
            ua = line.split(":", 1)[1].strip()
            in_star = ua == "*"
        elif in_star and line.lower().startswith("disallow:"):
            val = line.split(":", 1)[1].strip()
            if val:
                disallows.append(val)
    return disallows


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
    if len(sitemap_urls) != len(set(sitemap_urls)):
        errors.append("sitemap.xml contains duplicate <loc> entries")

    disallows = _parse_robots_disallow(dist_dir / "robots.txt")
    seo_css = dist_dir / "seo.css"
    if not seo_css.is_file():
        errors.append("Missing lightweight seo.css")
    elif seo_css.stat().st_size > 25_000:
        errors.append(f"seo.css exceeds 25 KB performance budget ({seo_css.stat().st_size} bytes)")

    seen_titles: dict[str, str] = {}
    inbound_counts: dict[str, int] = {u: 0 for u in sitemap_urls}
    hreflang_map: dict[str, dict[str, str]] = {}

    for url in sitemap_urls:
        rel = url.removeprefix(base_url).lstrip("/")
        path_only = "/" + rel
        for rule in disallows:
            if path_only.startswith(rule):
                errors.append(f"Sitemap URL {url} is blocked by robots.txt Disallow: {rule}")

        target = dist_dir / (rel if rel else "index.html")
        if not target.is_file():
            errors.append(f"Sitemap URL missing file: {url} -> {target}")
            continue
        html = target.read_text(encoding="utf-8")
        p = PageInspector()
        p.feed(html)

        label = rel or "index.html"
        if not p.html_lang:
            errors.append(f"{label}: missing <html lang=...>")
        if p.h1_count != 1:
            errors.append(f"{label}: expected exactly 1 <h1>, found {p.h1_count}")
        if p.empty_img_srcs > 0:
            errors.append(f"{label}: found {p.empty_img_srcs} <img> tag(s) with empty src=\"\"")
        if "noindex" in p.meta_robots:
            errors.append(f"{label}: sitemap URL carries noindex ({p.meta_robots})")

        title = re.sub(r"\s+", " ", "".join(p.title_parts)).strip()
        if not title:
            errors.append(f"{label}: missing <title>")
        elif title in seen_titles:
            errors.append(f"Duplicate <title> '{title}' on {label} and {seen_titles[title]}")
        else:
            seen_titles[title] = label

        if len(p.meta_desc) < 60:
            errors.append(f"{label}: meta description too short ({len(p.meta_desc)} chars)")
        if not p.canonical:
            errors.append(f"{label}: missing canonical link")
        elif p.canonical != url:
            errors.append(f"{label}: canonical '{p.canonical}' does not match sitemap URL '{url}'")
        if not p.og_title or not p.og_desc or not p.og_image:
            errors.append(f"{label}: incomplete Open Graph tags (og:title/og:description/og:image)")
        if not p.twitter_card:
            errors.append(f"{label}: missing twitter:card")

        # Static SEO landing pages must use lightweight seo.css (not 318 KB styles.css)
        if rel:
            if any("styles.css" in s for s in p.stylesheets):
                errors.append(f"{label}: loads heavy SPA styles.css instead of lightweight seo.css")
            if not any("seo.css" in s for s in p.stylesheets):
                errors.append(f"{label}: missing seo.css stylesheet")

        if p.hreflangs:
            hreflang_map[url] = p.hreflangs
            if url not in p.hreflangs.values():
                errors.append(f"{label}: hreflang set is missing self-reference to {url}")

        if not p.markdown_alt:
            errors.append(f"{label}: missing <link rel=\"alternate\" type=\"text/markdown\">")
        elif p.markdown_alt.startswith(base_url):
            md_rel = p.markdown_alt.removeprefix(base_url).lstrip("/")
            md_file = dist_dir / md_rel
            if not md_file.is_file():
                errors.append(f"{label}: missing Markdown mirror {md_rel}")
            elif len(md_file.read_text(encoding="utf-8").strip()) < 400:
                errors.append(f"{label}: Markdown mirror {md_rel} is suspiciously short")

        if not p.json_lds:
            errors.append(f"{label}: missing JSON-LD structured data")
        for idx, raw_ld in enumerate(p.json_lds):
            try:
                parsed_ld = json.loads(raw_ld)
                if parsed_ld.get("@context") != "https://schema.org":
                    errors.append(f"{label}: JSON-LD #{idx + 1} missing @context=https://schema.org")
            except Exception as exc:
                errors.append(f"{label}: invalid JSON-LD #{idx + 1}: {exc}")

        for href, rel_attr in p.links:
            if href.startswith(("http://", "https://", "mailto:", "javascript:", "#", "obsidian:")):
                continue
            resolved = urljoin(url, href)
            parsed = urlsplit(resolved)
            clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            rel_tokens = set(rel_attr.split())

            # Check robots.txt Disallow conflict on dofollow internal links
            if parsed.netloc == urlsplit(base_url).netloc and "nofollow" not in rel_tokens:
                for rule in disallows:
                    if parsed.path.startswith(rule):
                        errors.append(f"{label}: dofollow link '{href}' targets robots.txt disallowed path {rule}")

            # Static SEO pages should mark parameterized SPA launcher URLs rel="nofollow"
            if rel and parsed.netloc == urlsplit(base_url).netloc and parsed.path in ("/", "") and parsed.query:
                if "nofollow" not in rel_tokens:
                    errors.append(f"{label}: parameterized SPA link '{href}' should have rel=\"nofollow\"")

            if clean_url in inbound_counts and clean_url != url and "nofollow" not in rel_tokens:
                inbound_counts[clean_url] += 1
            if parsed.netloc == urlsplit(base_url).netloc:
                rel_dest = parsed.path.lstrip("/")
                dest_file = dist_dir / (rel_dest if rel_dest else "index.html")
                if rel_dest and not dest_file.is_file():
                    errors.append(f"{label}: broken internal link '{href}' -> {dest_file}")

    # Verify bidirectional hreflang reciprocity
    for src_url, langs in hreflang_map.items():
        for lang_code, target_url in langs.items():
            if target_url == src_url:
                continue
            peer = hreflang_map.get(target_url)
            if not peer or src_url not in peer.values():
                errors.append(f"Non-reciprocal hreflang ({lang_code}): {src_url} -> {target_url}")

    for url, count in inbound_counts.items():
        if url.rstrip("/") == base_url.rstrip("/"):
            continue
        if count == 0:
            errors.append(f"Orphan sitemap page (0 inbound internal links): {url}")

    # Verify utility & directory fallback pages exist and carry noindex (no 301->404 traps or index leaks)
    noindex_required = [
        ("canvas-connect.html", True),
        ("tutor-bridge.html", True),
        ("404.html", True),
        ("courses/index.html", True),
        ("uni/index.html", True),
        ("pdfcraft/index.html", False),  # optional (present when built with --pdfcraft-archive)
    ]
    for rel_u, required in noindex_required:
        u_path = dist_dir / rel_u
        if not u_path.is_file():
            if required:
                errors.append(f"Missing expected utility/fallback page: {rel_u}")
            continue
        up = PageInspector()
        up.feed(u_path.read_text(encoding="utf-8"))
        if "noindex" not in up.meta_robots:
            errors.append(f"Utility page {rel_u} is missing <meta name=\"robots\" content=\"noindex...\">")

    # Verify GEO discovery files (`llms.txt` and `llms-full.txt`) and every linked `.md`/`.txt` mirror
    llms_path = dist_dir / "llms.txt"
    llms_full_path = dist_dir / "llms-full.txt"
    if not llms_path.is_file():
        errors.append("Missing llms.txt")
    else:
        llms_text = llms_path.read_text(encoding="utf-8")
        if len(llms_text.strip()) < 500:
            errors.append("llms.txt is suspiciously short")
        for m in re.finditer(r"\((https://studyos\.no/[^)\s]+)\)", llms_text):
            href = m.group(1)
            parsed = urlsplit(href)
            rel_target = parsed.path.lstrip("/")
            if rel_target and not (dist_dir / rel_target).is_file():
                errors.append(f"llms.txt broken link: {href} -> {dist_dir / rel_target}")
    if not llms_full_path.is_file():
        errors.append("Missing llms-full.txt")
    elif len(llms_full_path.read_text(encoding="utf-8").strip()) < 5000:
        errors.append("llms-full.txt is suspiciously short")

    md_count = sum(1 for p in dist_dir.rglob("*.md") if "vendor" not in p.parts)
    full_kb = (llms_full_path.stat().st_size / 1024) if llms_full_path.is_file() else 0.0
    css_kb = (seo_css.stat().st_size / 1024) if seo_css.is_file() else 0.0
    print(
        f"SEO/GEO Audit checked {len(sitemap_urls)} sitemap URLs, {md_count} .md mirrors, "
        f"seo.css ({css_kb:.1f} KB), llms-full.txt ({full_kb:.1f} KB): {len(errors)} error(s)"
    )
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
