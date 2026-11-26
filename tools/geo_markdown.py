"""Generate clean Markdown mirrors (`.md`), `/llms.txt`, and `/llms-full.txt` for AI Search / GEO.

Every public HTML page in `dist/` receives a corresponding pure-Markdown mirror (linked via
`<link rel="alternate" type="text/markdown" href="...">`) containing zero HTML/CSS/JS noise,
direct quotable answers, live build-time stats, structured tables, and bilingual Norwegian/English
FAQs for ClaudeBot, PerplexityBot, OAI-SearchBot, GPTBot, and coding/research agents.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import quote


# Authentic BI Norwegian Business School equivalent & historical exam course codes
BI_NO_EQUIVALENT_CODES: dict[str, str] = {
    "econ-2522": "SØK 3420",
    "acct-2527": "BØK 3430",
    "ob-2537": "ORG 3460",
    "math-2588": "EBA 1180 / EBA11805 / MET 1180",
    "prog-3021": "EBA34005",
}


def _course_code_label(cid: str, code: str) -> str:
    no_code = BI_NO_EQUIVALENT_CODES.get(cid)
    return f"{code} / {no_code}" if no_code and no_code != code else code


def _meta_block(
    *,
    canonical: str,
    md_url: str,
    lang: str,
    updated: str,
    extra: list[tuple[str, str]] | None = None,
) -> str:
    lines = [
        f"- **Canonical page:** {canonical}",
        f"- **Markdown mirror:** {md_url}",
        f"- **Language:** {lang}",
        f"- **Last updated:** {updated}",
        "- **Price:** 0 NOK (100% free, zero ads, no account required)",
    ]
    if extra:
        for k, v in extra:
            lines.append(f"- **{k}:** {v}")
    return "\n".join(lines)


def _fmt_faqs(faqs: list[tuple[str, str]], heading: str = "## Frequently Asked Questions") -> str:
    parts = [heading, ""]
    for q, a in faqs:
        parts.append(f"### {q}")
        parts.append(a)
        parts.append("")
    return "\n".join(parts).rstrip()


def _load_ref_toc(static_refs_dir: Path, slug: str) -> list[str]:
    rjson = static_refs_dir / f"{slug}.json"
    if not rjson.is_file():
        return []
    toc_items: list[str] = []
    try:
        rdata = json.loads(rjson.read_text(encoding="utf-8"))
        for h in (rdata.get("toc") or []):
            htext = str(h.get("text") or h.get("title") or "").strip() if isinstance(h, dict) else str(h).strip()
            htext = re.sub(r"[$*`]", "", htext).strip()
            if htext and len(htext) >= 3:
                toc_items.append(htext)
    except Exception:
        return []
    return toc_items


def _ref_slug(rel_file: str) -> str:
    stem = re.sub(r"\.md$", "", rel_file, flags=re.I).lower()
    return re.sub(r"[^a-z0-9]+", "-", stem).strip("-")


def generate_geo_markdown(
    *,
    out_dir: Path,
    base: str,
    bootstrap: dict[str, Any],
    course_no_blurbs: dict[str, str],
    universities: list[dict[str, Any]],
    bi_oslo_faqs: list[tuple[str, str]],
    norsk_faqs: list[tuple[str, str]],
    sync_faqs: list[tuple[str, str]],
    gpa_faqs: list[tuple[str, str]],
    compare_faqs: list[tuple[str, str]],
    ext_version: str = "1.7.1",
    wiseflow_faqs: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """Write `.md` mirrors for all 23 public HTML pages plus `/llms.txt` and `/llms-full.txt`."""
    base = base.rstrip("/")
    today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    catalog = [c for c in (bootstrap.get("catalog") or []) if c.get("courseId")]
    references = bootstrap.get("references") or []
    static_refs_dir = out_dir / "static-data" / "references"

    total_qs = sum(int(c.get("questionCount") or 0) for c in catalog)
    total_official = sum(int(c.get("officialCount") or 0) for c in catalog)
    total_book = sum(int(c.get("bookCount") or 0) for c in catalog)
    total_ai = sum(int(c.get("aiSyntheticCount") or 0) for c in catalog)
    total_flowmulti = sum(int(c.get("flowmultiCount") or 0) for c in catalog)

    # Precompute reference TOCs once
    ref_entries: list[dict[str, Any]] = []
    for ref in references:
        rfile = str(ref.get("file") or "")
        rtitle = str(ref.get("title") or rfile)
        rsub = str(ref.get("subtitle") or ref.get("semester") or "Reference Sheet")
        toc = _load_ref_toc(static_refs_dir, _ref_slug(rfile))
        ref_entries.append({
            "file": rfile,
            "title": rtitle,
            "subtitle": rsub,
            "courseId": str(ref.get("courseId") or ""),
            "toc": toc,
            "url": f"{base}/?view=references&note={quote(rfile, safe='')}",
        })

    written_files: list[str] = []
    corpus_sections: list[tuple[str, str]] = []

    def _write_md(rel_path: str, content: str, include_in_full: bool = True) -> None:
        target = out_dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        clean = content.strip() + "\n"
        target.write_text(clean, encoding="utf-8")
        written_files.append(rel_path)
        if include_in_full:
            corpus_sections.append((f"{base}/{rel_path}", clean))

    # Build reusable course summary rows
    course_table_rows = []
    for c in catalog:
        cid = str(c["courseId"])
        code = str(c.get("code") or cid.upper())
        code_lbl = _course_code_label(cid, code)
        title = str(c.get("title") or cid)
        qc = int(c.get("questionCount") or 0)
        off_c = int(c.get("officialCount") or 0)
        ai_c = int(c.get("aiSyntheticCount") or 0)
        exam_fmt = str((c.get("examInfo") or {}).get("format") or "Digital university exam")
        course_table_rows.append(
            f"| **{code_lbl}** | {title} | {qc} ({off_c} official / {ai_c} AI mock) | {exam_fmt} | [Guide]({base}/courses/{cid}.md) · [HTML]({base}/courses/{cid}.html) |"
        )
    course_table = "\n".join([
        "| Course Code (EN / NO) | Title | Practice Questions | Exam Format | Links |",
        "| --- | --- | --- | --- | --- |",
        *course_table_rows,
    ])

    uni_table_rows = [
        f"| **BI Norwegian Business School (BI Oslo)** | `canvas.bi.no` | TimeEdit (`cloud.timeedit.net`) | WISEflow FLOWmulti & BYOD | [Guide]({base}/bi-oslo.md) · [HTML]({base}/bi-oslo.html) |"
    ]
    for u in universities:
        uni_table_rows.append(
            f"| **{u['name']}** | `{u['canvas_host']}` | {u['timetable_name']} | {u['exam_platform']} | [Guide]({base}/uni/{u['slug']}.md) · [HTML]({base}/uni/{u['slug']}.html) |"
        )
    uni_table = "\n".join([
        "| University | Canvas LMS Host | Timetable System | Exam Platform | Links |",
        "| --- | --- | --- | --- | --- |",
        *uni_table_rows,
    ])

    # 1. `/index.md` — Master homepage mirror
    index_md = f"""# Study-OS — Free Canvas LMS Sync, WISEflow Exam Prep & Study Workspace

> **Quick summary:** Study-OS ([studyos.no]({base}/)) is a 100% free, ad-free, open-source student study workspace built in Oslo, Norway for BI Norwegian Business School, UiA, NTNU, UiO, NHH, UiB, OsloMet, UiS, UiT, USN, NMBU, HVL, Kristiania, and any university running Instructure Canvas (`*.instructure.com`). It includes **{total_qs:,} practice questions** across **{len(catalog)} core university courses**, **{len(references)} multi-semester KaTeX formula reference sheets**, a timed **WISEflow FLOWmulti** exam simulator, 1-click **Canvas + TimeEdit/TP + Ed Discussion** browser sync (`v{ext_version}`), an instant local PDF viewer (up to 260 MB per file, zero uploads), FSRS spaced repetition, live study rooms / 1v1 duels, a free **Norwegian ECTS GPA calculator**, and the **Adamlite AI Tutor**.

{_meta_block(canonical=f"{base}/", md_url=f"{base}/index.md", lang="en, nb-NO", updated=today_iso, extra=[("Full AI corpus", f"{base}/llms-full.txt"), ("Directory index", f"{base}/llms.txt"), ("Source code", "https://github.com/shadjosef/study-os")])}

## Quick Facts

| Attribute | Details |
| --- | --- |
| **Price** | 0 NOK / Free forever — no ads, no paywalls, no tracking cookies |
| **Account required?** | Optional — practice, notes, local PDFs, and GPA calculator work immediately offline in your browser |
| **Practice question bank** | {total_qs:,} structured questions ({total_official} official past exam & course sets, {total_book} textbook index items, {total_ai} clearly labeled AI mocks/drills, {total_flowmulti} multi-box WISEflow FLOWmulti exercises) |
| **Reference sheets** | {len(references)} semester Markdown guides with KaTeX math formulas and custom SVG diagrams |
| **Canvas LMS sync** | Manifest V3 extension (`Study-OS Sync v{ext_version}`) supporting `canvas.bi.no`, `uia.instructure.com`, `ntnu.instructure.com`, `uio.instructure.com` / `canvas.uio.no`, `nhh.instructure.com`, `mitt.uib.no`, `oslomet.instructure.com`, `canvas.uis.no`, `canvas.uit.no`, `canvas.usn.no`, `canvas.nmbu.no`, `canvas.hvl.no`, `canvas.kristiania.no`, and any `*.instructure.com` — zero passwords or cookies copied |
| **Timetable & scheduler** | Imports TimeEdit (`cloud.timeedit.net`), Norwegian TP (`tp.educloud.no`, `tp.uio.no`), Google Calendar, and Apple Calendar `.ics` feeds into a circadian DLPFC study plan |
| **Local PDF reader** | Split-screen inline viewer with full-text search & dark mode; files up to 260 MB stay private in local IndexedDB (never uploaded) |
| **AI Tutor** | Adamlite — side-pane streaming tutor that reads only the active question, your working, and the matching Markdown reference section |
| **Privacy & GDPR** | Norway / EEA GDPR compliant; optional cloud sync & Passkey/Google Sign-In hosted on Cloudflare Workers / D1 (EU jurisdiction) |

## Built-in Public Courses ({total_qs:,} Questions)

{course_table}

## Supported Universities (Norway & Worldwide)

{uni_table}

## All Public Guides (Markdown Mirrors)

- [BI Oslo Exam Prep Guide (EN)]({base}/bi-oslo.md) · ([HTML]({base}/bi-oslo.html))
- [Study-OS på norsk — Eksamensøving Norge (NB)]({base}/norsk.md) · ([HTML]({base}/norsk.html))
- [WISEflow FLOWmulti & BYOD Exam Simulator]({base}/wiseflow-practice.md) · ([HTML]({base}/wiseflow-practice.html))
- [1-Click Canvas LMS, TimeEdit/TP & Ed Discussion Sync]({base}/bi-canvas-timeedit-sync.md) · ([HTML]({base}/bi-canvas-timeedit-sync.html))
- [Karaktersnitt Kalkulator / Norwegian ECTS GPA Calculator]({base}/gpa-calculator.md) · ([HTML]({base}/gpa-calculator.html))
- [Supported Universities Directory]({base}/universities.md) · ([HTML]({base}/universities.html))
- [Course Notes & Formula Reference Hub ({len(references)} sheets)]({base}/notes.md) · ([HTML]({base}/notes.html))
- [Study-OS vs Notion, Anki, Quizlet, Studocu & Norwegian Exam Portals]({base}/compare.md) · ([HTML]({base}/compare.html))
- [Privacy Policy (GDPR)]({base}/privacy.md) · [Terms of Use]({base}/terms.md)
"""
    _write_md("index.md", index_md)

    # 2. `/bi-oslo.md`
    bi_oslo_md = f"""# BI Oslo Exam Prep, WISEflow Mock Exams & Canvas Sync — Study-OS

> **Quick summary:** Study-OS is a free, independent exam-preparation workspace built specifically around **BI Norwegian Business School (Campus Oslo / Nydalen)** courses — covering **{total_qs:,} practice questions**, **{len(references)} formula & concept reference sheets**, timed 3-hour **WISEflow FLOWmulti** mock exams, **Adamlite AI Tutor**, and 1-click **BI Canvas (`canvas.bi.no`), TimeEdit, and Ed Discussion** sync.

{_meta_block(canonical=f"{base}/bi-oslo.html", md_url=f"{base}/bi-oslo.md", lang="en, nb-NO", updated=today_iso, extra=[("Location", "Oslo, Norway (Nydalen)"), ("Affiliation", "Independent student project — not officially affiliated with BI Norwegian Business School")])}

## BI Oslo Courses Included (English & Norwegian Equivalents)

{course_table}

## Key Features Built for BI Oslo Exam Season

1. **WISEflow FLOWmulti & BYOD Simulation:** Timed 180-minute exam papers modeled on BI's real digital school exams (dot decimals `.`, negative cash flows `-50`, `±2%` numeric tolerance, blind no-hint mode, full error breakdown by topic).
2. **Circadian DLPFC Study Scheduling:** Schedules High-DLPFC quantitative/synthesis questions during peak daytime focus (`08:00–15:00` Oslo time) and lower-load retrieval drills in the evening.
3. **1-Click BI Canvas, TimeEdit & Ed Discussion Sync:** Pair Study-OS Sync v{ext_version} once with a 6-character code and pull active courses, deadlines, and lecture timetables straight from your already signed-in browser tabs — zero passwords or cookies copied.
4. **Private Curriculum PDFs + Adamlite AI Tutor:** Drop lecture slides, past exam PDFs, or textbooks (up to 260 MB locally in IndexedDB) for instant split-screen reading next to exercises and streaming AI explanations.
5. **Norwegian ECTS GPA / Master's Planner:** Calculate your BI `7.5 ECTS` weighted average (`A=5` to `E=1`) and see what grades you need for MSc / Siviløkonom admission at [gpa-calculator.html]({base}/gpa-calculator.html).

{_fmt_faqs(bi_oslo_faqs, "## BI Oslo FAQ / Ofte stilte spørsmål")}
"""
    _write_md("bi-oslo.md", bi_oslo_md)

    # 3. `/norsk.md`
    norsk_md = f"""# Study-OS Norge — Gratis eksamensøving, Canvas-synk & WISEflow (BI, UiA, NTNU, UiO, NHH)

> **Kort oppsummert:** Study-OS ([studyos.no]({base}/)) er en **100 % gratis**, reklamefri og uavhengig studieplattform laget i Oslo for norske universitets- og høyskolestudenter (BI, UiA, NTNU, UiO, NHH, UiB, OsloMet m.fl.). Du får **{total_qs:,} øvingsoppgaver**, **{len(references)} formel- og kursnotater**, 3-timers **WISEflow FLOWmulti**-eksamenssimulator, **karaktersnittkalkulator (A–F & studiepoeng)**, lokal PDF-leser (opptil 260 MB), **Adamlite AI-veileder** og 1-klikks synk med **Canvas, TimeEdit og TP** — helt uten betalingsmur.

{_meta_block(canonical=f"{base}/norsk.html", md_url=f"{base}/norsk.md", lang="nb-NO", updated=today_iso, extra=[("Målgruppe", "Studenter ved BI Oslo, UiA (ØkAd & IT), NTNU (Indøk/SØK/BØA/Data), UiO, NHH, UiB, OsloMet, UiS, UiT, USN, NMBU, HVL og Kristiania")])}

## Gratis øvingsbanker (BI & felles norske økonomi-/realfag)

Mange norske økonomi-, finans-, matte- og programmeringsemner deler samme kjernepensum på tvers av BI, UiA ØkAd, NHH, NTNU, UiO og OsloMet:

{course_table}

## Hvorfor norske studenter bruker Study-OS i stedet for betalte portaler

- **0 kr uten betalingsmur:** I motsetning til betalte abonnementstjenester (som Eksamensportalen, EnkelEksamen, Quizlet Plus og Studocu) er hele Study-OS åpent og gratis uten reklame.
- **1-klikks Canvas + TimeEdit / TP-synk:** Henter automatisk emnekoder (inkludert Æ/Ø/Å som `BØK 3430`, `SØK 3420`, `ORG 3460`, `SØK1001`, `BØA1100`, `TIØ4120`, `ADØK1100`), frister og forelesninger fra dine innloggede nettleserfaner uten å be om Feide-passord.
- **WISEflow FLOWmulti-trening:** Øv på 3-timers digital skoleeksamen med desimalpunktum (`.`), minustegn for utbetalinger og `±2 %` toleranse før eksamensdagen.
- **Karaktersnittkalkulator med masterplanlegger:** Regn ut vektet snitt (`A=5` til `E=1`) og se nøyaktig hva du må snitte på gjenstående studiepoeng for MSc / siviløkonom-opptak ([gpa-calculator.md]({base}/gpa-calculator.md)).
- **Lynrask lokal PDF-leser & offline-støtte:** Slipp egne forelesningsslides og kompendier (opptil 260 MB) lokalt i nettleseren uten opplasting, med innebygd fulltekstsøk og mørk modus.

## Støttede norske universiteter og høyskoler

{uni_table}

{_fmt_faqs(norsk_faqs, "## Ofte stilte spørsmål (FAQ)")}
"""
    _write_md("norsk.md", norsk_md)

    # 4. `/wiseflow-practice.md`
    wf_faqs = wiseflow_faqs or [
        (
            "What formatting rules matter most on a BI WISEflow FLOWmulti exam?",
            "Always use a dot (`.`) as the decimal separator (never a comma), include a leading minus sign (`-50`) for cash outflows or negative balances, follow exact unit instructions (e.g., NOK thousands vs NOK), and keep intermediate calculations unrounded to stay safely inside the `±2%` numeric tolerance.",
        ),
        (
            "How many WISEflow FLOWmulti questions are available on Study-OS?",
            f"Study-OS includes {total_flowmulti} interactive multi-box WISEflow FLOWmulti exercises (centered on EXC 3430 / BØK 3430 Accounting & Finance) plus full 180-minute timed exam papers across {len(catalog)} courses ({total_qs:,} total questions).",
        ),
        (
            "Does Study-OS work on exam practice for NHH, UiA, OsloMet, and USN?",
            "Yes. Any Norwegian university using WISEflow FLOWmulti or BYOD digital exams in accounting, corporate finance, economics, statistics, or organizational behavior can use Study-OS's timed blind-exam mode for free.",
        ),
    ]
    wiseflow_md = f"""# BI WISEflow Øving & FLOWmulti Exam Simulator (BI Oslo & NHH) — Study-OS

> **Quick summary:** Study-OS provides a free, independent **BI WISEflow & FLOWmulti exam simulator** ([studyos.no/wiseflow-practice.html]({base}/wiseflow-practice.html)) built for Norwegian university digital school exams (BI Oslo, NHH, UiA, OsloMet). It trains multi-box accounting/finance worksheets (`{total_flowmulti}` FLOWmulti problems), dot-decimal (`.`) formatting, negative outflow signs (`-`), `±2%` rounding tolerance checks, 180-minute exam pacing, and blind no-hint grading without login.

{_meta_block(canonical=f"{base}/wiseflow-practice.html", md_url=f"{base}/wiseflow-practice.md", lang="en, nb-NO", updated=today_iso, extra=[("Launch Exams Hub", f"{base}/?view=exams"), ("FLOWmulti multi-box items", str(total_flowmulti))])}

## WISEflow FLOWmulti Formatting Rules (Exam-Day Checklist)

| Rule | Correct Format | Common Mistake to Avoid |
| --- | --- | --- |
| **Decimal separator** | Dot: `12.50` | Comma `12,50` (often rejected or misparsed in numeric boxes) |
| **Negative values / cash outflows** | Leading minus: `-45000` | Parentheses `(45000)` or forgetting the minus sign |
| **Rounding tolerance** | Keep full precision until final step (`±2%` tolerance) | Rounding intermediate ratios to 1 decimal too early |
| **Time pacing (180 min)** | ~1 min per point on 180-pt BI papers | Spending 45+ minutes stuck on Part 1 before Part 3 cases |
| **Pre-exam setup (Norway)** | Test official WISEflow Demoflow & Device Monitor/FLOWlock ≥30 min early | Launching Lockdown Browser 2 minutes before exam start |

## What Study-OS Trains Before Exam Day

1. **Multi-Box FLOWmulti Grading (`EXC 3430 / BØK 3430`):** Fill out full income statements, balance sheets, NPV/IRR schedules, absorption costing tables, and Right/Wrong statements with instant box-by-box verification.
2. **Timed 180-Minute Blind Mode:** Solutions and hints stay hidden until you submit the full paper, followed by a complete error breakdown by syllabus topic and DLPFC difficulty tier.
3. **Live Oslo Exam Countdowns:** Exact countdown timers in `Europe/Oslo` time to every scheduled exam.
4. **Zero-Friction Practice Links:**
   - [EXC 3430 / BØK 3430 Accounting & Finance FLOWmulti]({base}/courses/acct-2527.md)
   - [EXC 3420 / SØK 3420 Economics I]({base}/courses/econ-2522.md)
   - [EXC 3460 / ORG 3460 OB & Leadership MCQ]({base}/courses/ob-2537.md)
   - [EBA 3400 Python Programming & Data]({base}/courses/prog-3021.md)
   - [EBA 1181 / EBA 1180 Mathematics for Data Science]({base}/courses/math-2588.md)

{_fmt_faqs(wf_faqs, "## WISEflow Exam Prep FAQ")}
"""
    _write_md("wiseflow-practice.md", wiseflow_md)

    # 5. `/bi-canvas-timeedit-sync.md`
    sync_md = f"""# 1-Click Canvas LMS, TimeEdit/TP & Ed Discussion Sync Extension (v{ext_version}) — Study-OS

> **Quick summary:** **Study-OS Sync v{ext_version}** is a free Manifest V3 Chrome/Brave/Edge/Vivaldi extension that syncs active **Canvas LMS** courses, syllabus modules, and assignment deadlines together with **TimeEdit / Norwegian TP** lecture timetables and **Ed Discussion** into [studyos.no]({base}/) in 1 click — with zero school passwords, zero OAuth IT approval, and zero cookie copying.

{_meta_block(canonical=f"{base}/bi-canvas-timeedit-sync.html", md_url=f"{base}/bi-canvas-timeedit-sync.md", lang="en, nb-NO", updated=today_iso, extra=[("Extension version", f"{ext_version} (Manifest V3)"), ("Supported browsers", "Chrome, Brave, Edge, Vivaldi"), ("Direct ZIP download", f"{base}/downloads/study-os-sync-extension.zip")])}

## Supported LMS & Timetable Hosts

| Platform Type | Supported Domains / Systems |
| --- | --- |
| **Norwegian Canvas LMS** | `canvas.bi.no` (BI), `uia.instructure.com` / `canvas.uia.no` (UiA), `ntnu.instructure.com` / `canvas.ntnu.no` (NTNU), `uio.instructure.com` / `canvas.uio.no` (UiO), `nhh.instructure.com` / `canvas.nhh.no` (NHH), `mitt.uib.no` (UiB), `oslomet.instructure.com` / `canvas.oslomet.no` (OsloMet), `canvas.uis.no` (UiS), `canvas.uit.no` (UiT), `canvas.usn.no` (USN), `canvas.nmbu.no` (NMBU), `canvas.hvl.no` (HVL), `canvas.kristiania.no` (Kristiania) |
| **Global Canvas LMS** | Any university worldwide running `*.instructure.com` |
| **Timetables** | TimeEdit (`cloud.timeedit.net`), Norwegian TP (`tp.educloud.no/*`, `tp.uio.no`), plus any `.ics` feed (Google Calendar, Apple Calendar) |
| **Course Forums** | Ed Discussion (`eu.edstem.org`, `edstem.org`, `us.edstem.org`, `au.edstem.org`) |

## 4-Step Setup (Takes ~30 Seconds)

1. **Install Study-OS Sync v{ext_version}** in Chrome, Brave, Edge, or Vivaldi ([download ZIP]({base}/downloads/study-os-sync-extension.zip)).
2. **Generate a 6-character pairing code** inside [studyos.no]({base}/) → **Sync Canvas** and paste it once in the extension popup.
3. **Keep your signed-in school tabs open** (Canvas, TimeEdit / TP, and optionally Ed Discussion) and click **Sync** once.
4. **Attach personal PDFs locally (optional):** Drop lecture slides, exam papers, or textbooks (up to 260 MB per PDF) into Study-OS for instant split-screen reading — stored strictly in local IndexedDB, never uploaded.

## Security & Privacy Guarantees

- **Zero passwords or Feide logins:** Study-OS never asks for or sees your university username or password.
- **Zero session cookies exported:** Requests run locally inside your already authenticated browser tab using standard same-origin Canvas API calls.
- **Norwegian Æ/Ø/Å course code parser:** Automatically recognizes codes like `BØK 3430`, `SØK 3420`, `ORG 3460`, `SØK1001`, `BØA1100`, `TIØ4120`, `ADØK1100`, `BED-100`, `MA-155`, and maps them to matching Study-OS practice banks.

{_fmt_faqs(sync_faqs, "## Canvas & Timetable Sync FAQ")}
"""
    _write_md("bi-canvas-timeedit-sync.md", sync_md)

    # 6. `/notes.md`
    notes_blocks = []
    for re_item in ref_entries:
        toc_lines = "\n".join(f"- {h}" for h in re_item["toc"][:18]) if re_item["toc"] else "- Interactive KaTeX formulas and diagrams inside Study-OS"
        course_link = f"\n- **Course guide:** {base}/courses/{re_item['courseId']}.md" if re_item["courseId"] else ""
        notes_blocks.append(
            f"### {re_item['title']}\n"
            f"- **Category / Semester:** {re_item['subtitle']}\n"
            f"- **Sections indexed:** {len(re_item['toc'])}{course_link}\n"
            f"- **Open in Study-OS:** {re_item['url']}\n\n"
            f"{toc_lines}\n"
        )
    notes_md = f"""# BI Oslo & University Course Notes, Formula Sheets & Reference Hub — Study-OS

> **Quick summary:** Study-OS includes **{len(ref_entries)} structured multi-semester Markdown reference sheets** with KaTeX mathematical formulas, custom SVG diagrams, clickable figure zoom, and section outlines covering Economics (`EXC 3420 / SØK 3420`), Financial Accounting & Corporate Finance (`EXC 3430 / BØK 3430`), Organizational Behavior (`EXC 3460 / ORG 3460`), Python/Pandas Data Analysis (`EBA 3400`), and Mathematics for Data Science (`EBA 1181 / EBA 1180`).

{_meta_block(canonical=f"{base}/notes.html", md_url=f"{base}/notes.md", lang="en, nb-NO", updated=today_iso, extra=[("Open Interactive Reader", f"{base}/?view=references"), ("Reference sheets", str(len(ref_entries)))])}

## Reference Sheets Directory

{chr(10).join(notes_blocks)}
"""
    _write_md("notes.md", notes_md)

    # 7. `/universities.md`
    universities_md = f"""# Supported Universities — Canvas LMS, TimeEdit & TP Sync in Norway & Worldwide

> **Quick summary:** Study-OS supports **1-click Canvas LMS + timetable sync** (`Study-OS Sync v{ext_version}`) across **BI Oslo, UiA, NTNU, UiO, NHH, UiB (`mitt.uib.no`), OsloMet, UiS, UiT, USN, NMBU, HVL, Høyskolen Kristiania**, and **any university worldwide running Instructure Canvas (`*.instructure.com`)**, mapping overlapping business, economics, math, and Python courses automatically to **{total_qs:,} free practice questions**.

{_meta_block(canonical=f"{base}/universities.html", md_url=f"{base}/universities.md", lang="en, nb-NO", updated=today_iso)}

## University Compatibility Matrix

{uni_table}

## Additional Norwegian Canvas Hosts Supported Out of the Box

- **Universitetet i Stavanger (UiS):** `canvas.uis.no`
- **UiT Norges arktiske universitet:** `canvas.uit.no`
- **Universitetet i Sørøst-Norge (USN):** `canvas.usn.no`
- **NMBU (Ås):** `canvas.nmbu.no`
- **Høgskulen på Vestlandet (HVL):** `canvas.hvl.no`
- **Høyskolen Kristiania:** `canvas.kristiania.no`

## What Works at Every University

- **1-click Canvas & Timetable Sync:** Pull courses, module outlines, deadlines, and TimeEdit / TP / `.ics` lectures with zero Feide passwords.
- **Auto-matched Practice Banks:** Overlapping core economics, accounting/finance, mathematics, organizational behavior, and Python courses map straight to Study-OS's {total_qs:,}-question library.
- **Bring Your Own PDFs (Up to 260 MB Local):** Drop any university lecture slides, past exams, or textbooks privately in-browser with instant split-screen viewing and full-text search.
- **Free Norwegian ECTS GPA Calculator:** Built-in presets for BI, UiA ØkAd, NTNU, UiO, and NHH ([gpa-calculator.md]({base}/gpa-calculator.md)).
"""
    _write_md("universities.md", universities_md)

    # 8. `/gpa-calculator.md`
    gpa_md = f"""# Karaktersnitt & GPA Kalkulator (BI & Universitet / Norwegian ECTS GPA) — Study-OS

> **Kort oppsummert / Quick summary:** Study-OS tilbyr en **100 % gratis GPA- og karaktersnittkalkulator uten innlogging** ([studyos.no/gpa-calculator.html]({base}/gpa-calculator.html)) for BI og norske universiteter/høyskoler (NHH, NTNU, UiO, UiA, UiB, OsloMet). Regn ut studiepoengvektet snitt (`A = 5` til `E = 1`), ekskluder *Bestått / Ikke bestått* automatisk, se estimert 4.0-skala for utveksling, og planlegg målsnitt for masteropptak (MSc / siviløkonom).

{_meta_block(canonical=f"{base}/gpa-calculator.html", md_url=f"{base}/gpa-calculator.md", lang="nb-NO, en", updated=today_iso, extra=[("Interactive Calculator", f"{base}/gpa-calculator.html"), ("Storage", "100% local in browser (localStorage), zero server tracking")])}

## Norsk karakterskala (Universitet og høyskole · ECTS)

| Bokstavkarakter | Tallverdi (Snittpoeng) | Teller på karaktersnittet? | Beskrivelse |
| --- | --- | --- | --- |
| **A** | `5` | Ja | Fremragende |
| **B** | `4` | Ja | Meget god |
| **C** | `3` | Ja | God |
| **D** | `2` | Ja | Nokså god |
| **E** | `1` | Ja | Tilstrekkelig |
| **F** | `0` | Nei (ikke bestått) | Ikke bestått |
| **Bestått (P)** | — | Nei | Gir studiepoeng, men inngår ikke i vektet snitt |

## Formel for studiepoengvektet karaktersnitt

```text
Karaktersnitt = SUM(tallkarakter_i * studiepoeng_i) / SUM(graderte studiepoeng_i)
```

### Regneeksempel (1 semester · 30 studiepoeng)
- Emne 1 (`7.5 stp`, **A = 5**): `7.5 × 5 = 37.5`
- Emne 2 (`7.5 stp`, **B = 4**): `7.5 × 4 = 30.0`
- Emne 3 (`7.5 stp`, **B = 4**): `7.5 × 4 = 30.0`
- Emne 4 (`7.5 stp`, **A = 5**): `7.5 × 5 = 37.5`
- **Totalt:** `135.0 / 30 = 4.50` (tilsvarende **A**).

### Målsnitt-formel for masteropptak (MSc / Siviløkonom)

```text
Nødvendig snitt på gjenstående stp = (Målsnitt * (Nåværende stp + Gjenstående stp) - Nåværende vektede poeng) / Gjenstående stp
```

- **Typiske opptaksgrenser i Norge:** Formelt minstekrav er vanligvis **C (`2.5–3.0`)**, mens konkurranseutsatte masterprogrammer som **siviløkonom / MSc på NHH, BI og NTNU** ofte ligger rundt **`3.7–4.3`** (B-nivå).
- **Ferdige maler i kalkulatoren:** BI Oslo (`7.5 stp`), UiA ØkAd (`7.5 stp`), NTNU (`7.5 stp`), UiO (`10 stp`) og NHH (`7.5 stp`).

{_fmt_faqs(gpa_faqs, "## Ofte stilte spørsmål om karaktersnitt")}
"""
    _write_md("gpa-calculator.md", gpa_md)

    # 9. `/compare.md`
    compare_md = f"""# Study-OS vs Notion, Anki, Quizlet, Studocu & Norwegian Exam Portals (2026 Comparison)

> **Quick summary:** Study-OS is a free, open-source exam-prep and Canvas/timetable workspace built for Norwegian university students (BI, UiA, NTNU, UiO, NHH, UiB, OsloMet). Unlike general note wikis (**Notion**, **Obsidian**), pure flashcard tools (**Anki**, **Quizlet**), or paid Norwegian exam sites (**Eksamensportalen**, **EnkelEksamen**, **Utenat**, **Studocu**), Study-OS combines **1-click Canvas + TimeEdit/TP sync (`v{ext_version}`)**, **WISEflow FLOWmulti simulation**, **instant local 260 MB PDF reading**, **FSRS spaced repetition**, and **Adamlite AI tutoring** at **0 NOK** — while honestly recommending Anki, Notion, or EnkelEksamen when those tools fit better.

{_meta_block(canonical=f"{base}/compare.html", md_url=f"{base}/compare.md", lang="en, nb-NO", updated=today_iso)}

## Feature-by-Feature Comparison Matrix

| Capability | Study-OS | Notion | Anki | Quizlet | Paid NO Exam Portals (Eksamensportalen / EnkelEksamen / Studocu) |
| --- | --- | --- | --- | --- | --- |
| **1-Click Canvas LMS Sync (`BI`, `UiA`, `NTNU`, `UiO`, `NHH`, `UiB`, `*.instructure.com`)** | **Yes (built-in v{ext_version})** | Manual / paid plugins | No | No | No |
| **TimeEdit & Norwegian TP (`.ics`) Auto-Scheduler** | **Yes (built-in)** | Manual calendar | No | No | No |
| **WISEflow FLOWmulti (`±2%` multi-box accounting/finance exam mode)** | **Yes (built-in)** | No | No | MCQ only | Partial / paid |
| **Instant Split-Screen Local PDF Reader + Search (up to 260 MB)** | **Yes (local IndexedDB)** | 5 MB free file cap | Add-ons | Paid upload | Blurred / paywalled docs |
| **FSRS Spaced Repetition** | **Yes (built-in)** | Manual | **Gold standard** | Basic (paywalled Learn) | Limited |
| **Long-Form Wiki & Group Project Docs** | Basic notes | **Best-in-class** | No | No | No |
| **Pre-recorded Norwegian Video Courses** | No | No | No | No | **Yes (EnkelEksamen)** |
| **Price for Full Features** | **100% Free (0 NOK, no ads)** | Freemium + paid AI | Free (iOS app paid) | Paywalled Learn/Test | Subscription / per-course fee |

## Honest Trade-Offs: When to Choose Another Tool Instead

- **Pick Anki** if you study medicine, law memorization, or languages and need 10,000+ atomic image-occlusion flashcards with heavy mobile-first review.
- **Pick Notion or Obsidian** as your primary long-form lecture wiki, thesis outline, or group-assignment document workspace (Study-OS pairs directly with Obsidian Markdown vaults!).
- **Pick EnkelEksamen** if you specifically want paid Norwegian video lectures recorded from scratch for a course you missed completely.
- **Pick Study-OS** when you want your **Canvas deadlines + TimeEdit/TP timetable**, **exam-format practice** (Economics, Accounting/Finance, Math, Python, OB), **WISEflow FLOWmulti drills**, **instant side-by-side local PDFs**, and an **AI tutor** in one free, zero-paywall workspace.

{_fmt_faqs(compare_faqs, "## Comparison FAQ")}
"""
    _write_md("compare.md", compare_md)

    # 10. Per-course pages (`/courses/<cid>.md`)
    for course in catalog:
        cid = str(course["courseId"])
        code = str(course.get("code") or cid.upper()).strip()
        code_lbl = _course_code_label(cid, code)
        no_eq = BI_NO_EQUIVALENT_CODES.get(cid, "")
        title = str(course.get("title") or cid).strip()
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
        topic_lines: list[str] = []
        for idx_t, t in enumerate(raw_topics):
            if isinstance(t, dict):
                t_title = str(t.get("title") or t.get("name") or t.get("id") or "").strip()
                kws = [str(k).strip() for k in (t.get("keywords") or []) if str(k).strip()][:6]
                if t_title:
                    topic_lines.append(f"{idx_t + 1}. **{t_title}**" + (f" — {', '.join(kws)}" if kws else ""))
            else:
                t_title = str(t).strip()
                if t_title:
                    topic_lines.append(f"{idx_t + 1}. **{t_title}**")
        no_blurb = course_no_blurbs.get(
            cid,
            f"Øvingsoppgaver, kursnotater og WISEflow eksamensforberedelse for {code_lbl} ved Handelshøyskolen BI i Oslo.",
        )

        colls = course.get("collections") or []
        coll_rows = [
            f"| {str(col.get('title') or col.get('id') or '')} | {str((col.get('provenance') or {}).get('label') or col.get('kind') or 'Practice')} | {int(col.get('questionCount') or 0)} | {int(col.get('parMinutes') or 0)} min |"
            for col in colls[:18]
            if int(col.get("questionCount") or 0) > 0
        ]
        coll_section = (
            "\n## Past Exams & Practice Sets Included\n\n"
            "| Collection / Exam Paper | Provenance | Questions | Est. Par Time |\n"
            "| --- | --- | --- | --- |\n"
            + "\n".join(coll_rows)
            + "\n"
            if coll_rows else ""
        )

        course_faqs = [
            (
                f"How can I practice for {code_lbl} ({title}) at BI Oslo?",
                f"Open {code} at {base}/?course={cid} to drill {q_count} practice questions across {len(topic_lines)} syllabus topics, run timed {duration}-minute WISEflow mock exams, read formula notes, and ask the Adamlite AI Tutor for step-by-step guidance.",
            ),
            (
                f"What is the {code} exam format?",
                f"{exam_format}. {exam_notes}" if exam_notes else f"{exam_format} ({duration} minutes).",
            ),
            (
                f"Har Study-OS tidligere eksamener og øvingsoppgaver for {code_lbl}?",
                f"Ja. {code_lbl} på Study-OS inneholder {q_count} oppgaver ({off_c} fra tidligere BI-eksamener og kurssett" + (f", {book_c} pensumbok-indekserte oppgaver" if book_c else "") + f" og {ai_c} tydelig merkede AI-prøveeksamener), sortert etter emne og vanskelighetsgrad — helt gratis.",
            ),
            (
                f"Is {code} practice on Study-OS free?",
                "Yes. Study-OS is a free, independent student project in Oslo with zero ads and works directly in your browser without requiring an account.",
            ),
        ]
        topics_md = "\n".join(topic_lines) if topic_lines else "Interactive syllabus questions and formula notes ready inside Study-OS."
        sibling_courses = "\n".join(
            f"- [{_course_code_label(str(oc['courseId']), str(oc.get('code') or ''))} · {oc.get('title', '')}]({base}/courses/{oc['courseId']}.md)"
            for oc in catalog if oc["courseId"] != cid
        )

        course_md = f"""# {code_lbl}: {title} — BI Oslo Exam Prep & Practice Questions | Study-OS

> **Quick summary:** Free exam preparation for **{code} ({title})**{f' — Norwegian / related BI codes **{no_eq}** —' if no_eq else ''} at BI Norwegian Business School in Oslo: **{q_count} practice questions** ({off_c} official past exam / course exercises, {book_c} textbook study index items, {ai_c} clearly labeled AI mock/synthetic drills), **{len(topic_lines)} syllabus topics**, timed **{duration}-minute** WISEflow simulation, KaTeX formula sheets, and **Adamlite AI Tutor**.

> **På norsk:** {no_blurb}

{_meta_block(canonical=f"{base}/courses/{cid}.html", md_url=f"{base}/courses/{cid}.md", lang="en, nb-NO", updated=today_iso, extra=[("Direct Practice Link", f"{base}/?course={cid}"), ("WISEflow Timed Exam Mode", f"{base}/?view=exams&course={cid}"), ("Course Notes", f"{base}/notes.html")])}

## Course & Question Bank Breakdown

| Metric | Value |
| --- | --- |
| **Course Code (EN / NO)** | `{code_lbl}` |
| **Total Practice Questions** | **{q_count}** |
| **Official Past Exam / Course Exercises** | {off_c} |
| **Textbook Study Index (Bring Your Own PDF)** | {book_c} |
| **Clearly Labeled AI Mock / Synthetic Drills** | {ai_c} |
| **WISEflow FLOWmulti Multi-Box Items** | {wf_c} |
| **Cognitive Load Tiers (High / Med / Low DLPFC)** | {high_c} / {med_c} / {low_c} |
| **Exam Format** | {exam_format} |
| **Exam Duration** | {duration} minutes |
{f"| **Scheduled Exam Date (Oslo)** | {exam_date} |" if exam_date else "| **Exam Notes** | " + (exam_notes or f"Timed {duration}-minute simulation inside Study-OS Exams Hub.") + " |"}

{f"**Exam details:** {exam_notes}" if exam_notes and exam_date else ""}
{coll_section}
## Syllabus Topics Covered ({len(topic_lines)})

{topics_md}

{_fmt_faqs(course_faqs, f"## {code_lbl} Exam Prep FAQ")}

## Other BI Oslo Courses on Study-OS

{sibling_courses}
"""
        _write_md(f"courses/{cid}.md", course_md)

    # 11. Per-university pages (`/uni/<slug>.md`)
    course_by_id = {str(c["courseId"]): c for c in catalog}
    for uni in universities:
        slug = uni["slug"]
        mapping_md_rows = []
        for code, cname, cid, bank_lbl, topics in uni["course_mappings"]:
            live_c = course_by_id.get(cid)
            if live_c:
                live_lbl = f"{live_c.get('shortTitle') or live_c.get('title')} ({int(live_c.get('questionCount') or 0)} Qs)"
            else:
                live_lbl = bank_lbl
            mapping_md_rows.append(
                f"| **{code}** | {cname} | [{live_lbl}]({base}/courses/{cid}.md) | {topics} |"
            )
        mapping_table = "\n".join([
            f"| {uni['short']} Course Code | Course Name | Matched Study-OS Practice Bank | Overlapping Exam Topics |",
            "| --- | --- | --- | --- |",
            *mapping_md_rows,
        ])
        steps_md = "\n".join(f"{i + 1}. {step}" for i, step in enumerate(uni["timetable_steps"]))
        sibling_unis = "\n".join(
            f"- [{s['name']} (`{s['canvas_host']}`)]({base}/uni/{s['slug']}.md)"
            for s in universities if s["slug"] != slug
        )
        uni_heading = uni["name"] if f"({uni['short']})" in uni["name"] or uni["short"] in uni["name"] else f"{uni['name']} ({uni['short']})"
        resolved_uni_faqs = [(q, a.replace("{ext_version}", ext_version)) for q, a in uni["faqs"]]

        uni_md = f"""# Study-OS for {uni_heading} — Canvas & {uni['timetable_name']} Sync

> **Quick summary:** Study-OS connects directly to **`{uni['canvas_host']}`** and **{uni['timetable_name']}** in 1 click (zero Feide passwords copied), automatically matches **{uni['short']}** courses to **{total_qs:,} free practice questions** & **{len(references)} formula sheets**, and includes an instant local PDF reader (up to 260 MB) and **Adamlite AI Tutor**.

> **På norsk:** {uni['lead_nb']}

{_meta_block(canonical=f"{base}/uni/{slug}.html", md_url=f"{base}/uni/{slug}.md", lang="en, nb-NO" if uni.get("lang") == "en" else "nb-NO, en", updated=today_iso, extra=[("Campus / City", uni['city']), ("Canvas LMS Host", f"`{uni['canvas_host']}`"), ("Timetable System", uni['timetable_name']), ("Exam Platform", uni['exam_platform']), ("Program Focus", uni['program_focus'])])}

## Auto-Matched {uni['short']} Courses on Study-OS

{mapping_table}

## 30-Second Setup ({uni['short']} Canvas + {uni['timetable_name']})

{steps_md}

- **Launch Study-OS:** {base}/
- **Download Sync Extension (v{ext_version}):** {base}/downloads/study-os-sync-extension.zip
- **Norwegian ECTS GPA Calculator:** {base}/gpa-calculator.md

{_fmt_faqs(resolved_uni_faqs, f"## {uni['short']} FAQ / Ofte stilte spørsmål")}

## Other Supported Universities

- [BI Norwegian Business School — BI Oslo (`canvas.bi.no`)]({base}/bi-oslo.md)
{sibling_unis}
"""
        _write_md(f"uni/{slug}.md", uni_md)

    # 12. `/privacy.md` and `/terms.md`
    privacy_md = f"""# Privacy Policy — Study-OS

> **Quick summary:** Study-OS ([studyos.no]({base}/)) is a free, privacy-first student study workspace compliant with **GDPR (Norway / EEA)**. It uses zero advertising networks, zero third-party analytics trackers, and zero cross-site tracking cookies. You can practice offline in your browser with no account; optional cloud sync is hosted on **Cloudflare Workers / D1 (EU region)**.

{_meta_block(canonical=f"{base}/privacy.html", md_url=f"{base}/privacy.md", lang="en", updated=today_iso)}

## 1. Data Stored Locally on Your Device
Practice answers, timers, theme preferences, study schedules, personal PDF files (stored in local IndexedDB up to 260 MB per file), and optional user-supplied Google Gemini API keys remain on your device unless you explicitly sign in to sync progress.

## 2. Optional Accounts & Google Sign-In
- Optional Google Sign-In, Passkeys, or study profiles store only your display name, account identifier, and synced study progress on Cloudflare Workers / D1 (EU jurisdiction).
- Google Sign-In verifies identity only (OpenID basic profile/email). Study-OS never accesses Gmail, Drive, or other Google services and adheres to the Google API Services User Data Policy (including Limited Use requirements).

## 3. Optional Browser Sync & AI Tutor
- The optional **Study-OS Sync** Chrome extension (`v{ext_version}`) runs only on signed-in Canvas LMS, TimeEdit/TP timetable, or Ed Discussion tabs you authorize. It never reads passwords or exports session cookies; any in-tab Ed session lookup stays strictly in memory to query Ed's own API and is never saved or transmitted to Study-OS.
- **Local-only Canvas PDF viewing:** Direct-fetched Canvas lecture slides stay strictly inside your browser and local IndexedDB and are never uploaded to Study-OS servers.
- **Toggleable community course catalog:** Can be disabled anytime in one click in the popup; merges only non-personal course codes, course titles, and module headings while keeping personal deadlines, timetables, grades, submissions, and files private.
- **Opt-in on-device Browser Focus Telemetry:** Off by default; only if explicitly enabled (with Chrome's optional `tabs` permission) does it tally daily Study / Distraction / Other category minutes locally on-device with zero URLs, paths, or page titles stored or uploaded.
- When you message the **Adamlite AI Tutor**, your prompt, the active question, your working, and the matching Markdown reference section are sent to the configured LLM provider (Cloudflare Workers AI or Google Gemini) solely to produce your tutoring answer.

## 4. Cookies & Tracking
Zero advertising networks, zero third-party trackers, zero cross-site tracking cookies.

## 5. GDPR Rights & Deletion
Under GDPR (Norway / EEA), you can export your data, clear local storage, disconnect Google Sign-In, or request full account deletion at [github.com/shadjosef/study-os/issues](https://github.com/shadjosef/study-os/issues).
"""
    _write_md("privacy.md", privacy_md, include_in_full=False)

    terms_md = f"""# Terms of Use — Study-OS

> **Quick summary:** Study-OS ([studyos.no]({base}/)) is an independent, free, non-commercial open-source student study tool in Norway — not officially affiliated with BI Norwegian Business School, UiA, NTNU, UiO, NHH, UiB, OsloMet, or Instructure / Canvas.

{_meta_block(canonical=f"{base}/terms.html", md_url=f"{base}/terms.md", lang="en", updated=today_iso)}

## 1. Independent Student Project
Study-OS is an independent, non-commercial student workspace and is not officially affiliated with, endorsed by, or operated by any university or LMS vendor.

## 2. Copyright & Student-Synced Materials
- Public practice drills, reference sheets, and simulators included in Study-OS are original study aids.
- Students using the local browser extension or local PDF viewer are responsible for only importing materials they are authorized to access and never uploading copyrighted textbooks, slides, or exam PDFs to public community sets.

## 3. Fair Use & Community
Do not abuse the hosted AI Tutor, spam community courses, attempt to bypass authentication or rate limits, or impersonate other students.

## 4. As-Is Disclaimer
Study-OS, AI Tutor hints, GPA calculations, and study schedules are provided "as is" for personal study support. Always verify official deadlines, grades, and exam rules on your university's official portal.

## 5. Contact
Questions, takedown notices, or feedback: [github.com/shadjosef/study-os/issues](https://github.com/shadjosef/study-os/issues).
"""
    _write_md("terms.md", terms_md, include_in_full=False)

    # 13. Upgraded `/llms.txt` (llmstxt.org spec — links directly to clean `.md` mirrors + `/llms-full.txt`)
    llms_course_lines = [
        f"- [{_course_code_label(str(c['courseId']), str(c.get('code') or ''))} · {c.get('title', '')}]({base}/courses/{c['courseId']}.md): "
        f"{int(c.get('questionCount') or 0)} practice questions · {(c.get('examInfo') or {}).get('format', 'Exam prep')}"
        for c in catalog
    ]
    llms_uni_lines = [
        f"- [{u['name']} (`{u['canvas_host']}`)]({base}/uni/{u['slug']}.md): {u['timetable_name']} · {u['program_focus']}"
        for u in universities
    ]
    llms_ref_lines = [
        f"- {re_item['title']} ({len(re_item['toc'])} sections): {', '.join(re_item['toc'][:6])}"
        for re_item in ref_entries
    ]
    llms_txt = "\n".join([
        "# Study-OS",
        "",
        f"> Free, ad-free, open-source student workspace and exam-prep platform built in Oslo, Norway ({base}/) "
        f"for BI Norwegian Business School, UiA, NTNU, UiO, NHH, UiB (`mitt.uib.no`), OsloMet, UiS, UiT, USN, NMBU, HVL, Kristiania, "
        f"and any university running Instructure Canvas (`*.instructure.com`). Includes {total_qs:,} practice questions across {len(catalog)} courses, "
        f"{len(references)} KaTeX formula sheets, a timed WISEflow FLOWmulti exam simulator ({total_flowmulti} multi-box items), "
        f"1-click Canvas + TimeEdit/TP browser sync (`v{ext_version}`, zero passwords), instant local PDF viewing (up to 260 MB), "
        f"a free Norwegian ECTS GPA calculator, FSRS spaced repetition, and the Adamlite AI Tutor.",
        "",
        "## Complete Single-File Documentation (Recommended for LLMs)",
        f"- [Full Study-OS Markdown Corpus (llms-full.txt)]({base}/llms-full.txt): Single-file plain-Markdown bundle of all public Study-OS guides, course banks, university Canvas/TP setup docs, WISEflow rules, GPA calculator formula, and honest tool comparisons.",
        f"- [Homepage Overview (Markdown)]({base}/index.md): Quick facts, live question counts, and links to all guides.",
        "",
        "## Core Guides & Free Tools (Clean Markdown Mirrors)",
        f"- [BI Oslo Study Guide (English)]({base}/bi-oslo.md): Complete overview of BI Oslo courses (EXC/BØK/SØK/ORG/EBA), WISEflow mocks, and Canvas/TimeEdit sync.",
        f"- [Study-OS på norsk (Bokmål)]({base}/norsk.md): Norwegian guide for BI, UiA, NTNU, UiO, NHH, UiB, and OsloMet students.",
        f"- [WISEflow FLOWmulti & BYOD Exam Simulator]({base}/wiseflow-practice.md): Timed 3-hour exam simulation, dot-decimal (`.`) & `±2%` rounding rules, and exam-day checklist.",
        f"- [Canvas LMS, TimeEdit/TP & Ed Discussion 1-Click Sync]({base}/bi-canvas-timeedit-sync.md): Manifest V3 extension (`v{ext_version}`) setup for Norwegian & global Canvas universities.",
        f"- [Karaktersnitt Kalkulator / Norwegian ECTS GPA Calculator]({base}/gpa-calculator.md): Free zero-login `A=5` to `E=1` weighted GPA calculator with MSc / Siviløkonom target planner.",
        f"- [Supported Universities Directory]({base}/universities.md): Full compatibility matrix for Norwegian universities & any `*.instructure.com` Canvas school.",
        f"- [Study-OS vs Notion, Anki, Quizlet, Studocu & Norwegian Exam Portals]({base}/compare.md): Honest 2026 feature comparison and trade-offs.",
        f"- [Course Notes & Formula Reference Hub]({base}/notes.md): Section index of all {len(references)} KaTeX semester reference sheets.",
        "",
        "## Supported Universities",
        *llms_uni_lines,
        "",
        f"## Public Practice Courses ({total_qs:,} Questions)",
        *llms_course_lines,
        "",
        "## Reference Sheets",
        *llms_ref_lines,
        "",
        "## Optional",
        f"- [Privacy Policy (GDPR Norway / EEA)]({base}/privacy.md)",
        f"- [Terms of Use]({base}/terms.md)",
        f"- [Interactive Web App (HTML)]({base}/)",
        "- [Open-source GitHub Repository](https://github.com/shadjosef/study-os)",
        "",
    ])
    (out_dir / "llms.txt").write_text(llms_txt, encoding="utf-8")

    # 14. `/llms-full.txt` — Consolidated single-file Markdown corpus
    full_header = "\n".join([
        "# Study-OS — Full Plain-Markdown Documentation Corpus (`llms-full.txt`)",
        "",
        f"> Generated {today_iso} for AI assistants, search engines, and coding agents. "
        f"Contains {len(corpus_sections)} clean Markdown documents covering {base}/ ({total_qs:,} practice questions, "
        f"{len(catalog)} courses, {len(references)} reference sheets, 7 university hubs + 6 additional Norwegian Canvas schools, "
        f"WISEflow FLOWmulti rules, Canvas/TimeEdit/TP sync v{ext_version}, Norwegian ECTS GPA calculator, and honest tool comparisons).",
        "",
        f"- Index: {base}/llms.txt",
        f"- Website: {base}/",
        f"- Source: https://github.com/shadjosef/study-os",
        "",
    ])
    full_chunks = [full_header]
    for src_url, md_body in corpus_sections:
        full_chunks.append(f"\n---\n<!-- source: {src_url} -->\n\n{md_body}")
    llms_full_text = "\n".join(full_chunks).strip() + "\n"
    (out_dir / "llms-full.txt").write_text(llms_full_text, encoding="utf-8")

    return {
        "markdownMirrors": len(written_files),
        "markdownPaths": written_files,
        "llmsFullBytes": len(llms_full_text.encode("utf-8")),
    }
