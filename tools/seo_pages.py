"""High-intent multi-university SEO hubs, free GPA calculator micro-tool, and honest comparison page.

Design principles (2026 SEO / GEO best practices):
- Every university page carries genuinely unique data (exact LMS host, timetable platform & .ics flow,
  exam platform, real local course codes mapped to Study-OS practice banks, bilingual Norwegian + English FAQs).
- Extractable Atomic Content Units (ACUs), structured tables, and JSON-LD (WebApplication, HowTo,
  FAQPage, BreadcrumbList, CollectionPage, ItemList) for Google Search, Google AI Overviews, ChatGPT Search,
  and Perplexity.
- Lightweight `seo.css` (~7 KB) instead of the 318 KB SPA bundle for instant LCP/FCP on mobile.
- Tight hub-and-spoke + sibling internal linking (zero orphan pages) and clean `/uni/index.html` fallback.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
from html import escape
from pathlib import Path
from typing import Any


UNIVERSITIES: list[dict[str, Any]] = [
    {
        "slug": "uia",
        "lang": "nb",
        "short": "UiA",
        "name": "Universitetet i Agder (UiA)",
        "city": "Kristiansand & Grimstad",
        "geo_region": "NO-42",
        "geo_placename": "Kristiansand, Norway",
        "canvas_host": "uia.instructure.com",
        "canvas_url": "https://uia.instructure.com/",
        "timetable_name": "TP (Timeplanleggingssystemet)",
        "timetable_url": "https://tp.educloud.no/uia/",
        "exam_platform": "Inspera Assessment & WISEflow",
        "program_focus": "Økonomi og administrasjon (ØkAd), finans, teknologi og ledelse",
        "title": "UiA Canvas & TP Timeplan Sync · Gratis Eksamensøving (ØkAd) · Study-OS",
        "desc": (
            "Synk UiA Canvas (uia.instructure.com) og TP-timeplan (tp.educloud.no/uia) i 1 klikk. "
            "Gratis eksamensøving for UiA ØkAd (BED-100, MA-155, SE-100, ORG-100), notater og AI-veileder."
        ),
        "lead_en": (
            "Connect your University of Agder Canvas courses and TP timetable in 30 seconds — with automatic "
            "syllabus matching for UiA ØkAd subjects, deadline tracking, instant inline PDF reading, and AI tutoring."
        ),
        "lead_nb": (
            "Koble til uia.instructure.com og TP-timeplanen din fra tp.educloud.no/uia med 1 klikk — uten UiA-passord. "
            "Study-OS kobler automatisk UiA ØkAd-emner til over 1 180 ferdige øvingsoppgaver og formelnotater."
        ),
        "course_mappings": [
            ("BED-100", "Bedriftsøkonomi", "acct-2527", "Accounting & Finance", "Bidragskalkyle, balanse, kontantstrøm, investering og finansiering"),
            ("MA-155", "Matematikk for økonomer", "math-2588", "Mathematics", "Derivasjon, elastisitet, Lagrange-optimalisering og finansmatte"),
            ("SE-100", "Samfunnsøkonomi", "econ-2522", "Economics I", "Tilbud/etterspørsel, markedssvikt, monopol, BNP og inflasjon"),
            ("ORG-100", "Organisasjon og ledelse", "ob-2537", "OB & Leadership", "Ledelsesteori, motivasjon, organisasjonsstruktur og kultur"),
            ("ME-100", "Metode / Statistikk", "math-2588", "Mathematics & Quant", "Kvantitativ metode, sannsynlighet, regresjon og tolkning"),
        ],
        "timetable_steps": [
            "Logg inn på UiA Canvas (uia.instructure.com) og åpne tp.educloud.no/uia (Min timeplan).",
            "Installer Study-OS Sync (Chrome/Brave/Edge), lim inn 6-tegns paringskode fra studyos.no én gang.",
            "Klikk Sync i utvidelsen — emner, frister og forelesninger fra TP legges rett inn i ukeplanen din.",
            "Alternativt: klikk Abonnér i TP, kopier iCal-lenken (.ics) og lim den inn i Schedule Studio på studyos.no.",
        ],
        "faqs": [
            (
                "Virker Study-OS Sync med uia.instructure.com (UiA Canvas)?",
                "Ja. Study-OS Sync v{ext_version} støtter uia.instructure.com og canvas.uia.no automatisk, leser aktive UiA-emnekoder (som BED-100, MA-155, SE-100 og ORG-100) via din allerede innloggede nettleserfane, og lagrer aldri Feide-passordet ditt.",
            ),
            (
                "Hvordan synker jeg UiA sin TP-timeplan (tp.educloud.no/uia)?",
                "Study-OS støtter både direkte 1-klikks synk fra en åpen tp.educloud.no/uia-fane i Chrome-utvidelsen og innliming av TP sin Abonnér/iCal-lenke inne i Schedule-fanen på studyos.no.",
            ),
            (
                "Hvilke øvingsoppgaver passer for UiA Økonomi og administrasjon (ØkAd)?",
                "Når du synker UiA-emnene dine, kobler Study-OS automatisk Bedriftsøkonomi (BED-100) til Accounting & Finance, Matematikk for økonomer (MA-155) til Mathematics, Samfunnsøkonomi (SE-100) til Economics I, og Organisasjon og ledelse (ORG-100) til OB & Leadership.",
            ),
            (
                "Kan jeg lese egne UiA-forelesningsnotater og eksamens-PDF-er i Study-OS?",
                "Ja. Du kan dra og slippe ubegrenset med lokale PDF-er (opptil 260 MB per fil privat i nettleseren) og få øyeblikkelig side-ved-side PDF-visning med søk og mørk modus.",
            ),
        ],
    },
    {
        "slug": "ntnu",
        "lang": "nb",
        "short": "NTNU",
        "name": "NTNU (Trondheim, Gjøvik & Ålesund)",
        "city": "Trondheim, Gjøvik & Ålesund",
        "geo_region": "NO-50",
        "geo_placename": "Trondheim, Norway",
        "canvas_host": "ntnu.instructure.com",
        "canvas_url": "https://ntnu.instructure.com/",
        "timetable_name": "TP (tp.educloud.no/ntnu)",
        "timetable_url": "https://tp.educloud.no/ntnu/",
        "exam_platform": "Inspera Assessment",
        "program_focus": "Indøk (TIØ), Samfunnsøkonomi (SØK), ØkAd (BØA), Data & Matte (TDT/TMA)",
        "title": "NTNU Canvas & TP Timeplan Sync · Øvingsoppgaver & AI-Veileder · Study-OS",
        "desc": (
            "Synk NTNU-emner og frister + TP-timeplan (tp.educloud.no/ntnu) inn i én studieplan. "
            "Gratis øvingsbank for SØK1001, BØA1100, TIØ4120, TDT4100 og TMA4100 med AI-veileder."
        ),
        "lead_en": (
            "Sync your NTNU Canvas courses and TP timetable into an adaptive circadian study plan, pair your local "
            "lecture PDFs for instant inline viewing, and drill overlapping Economics, Finance, Python, and Calculus topics."
        ),
        "lead_nb": (
            "Samle NTNU-timeplanen fra TP, oppgavefrister, egne PDF-notater og tidsstyrte 50-minutters økter på ett sted. "
            "Automatisk gjenkjenning av norske emnekoder med ÆØÅ som SØK1001, BØA1100 og TIØ4120."
        ),
        "course_mappings": [
            ("BØA1100 / TIØ4120", "Finansregnskap & Bedriftsøkonomi", "acct-2527", "Accounting & Finance", "Regnskapsanalyse, nåverdi, kapitalkostnad og kontantstrøm"),
            ("SØK1001 / SØK1002", "Mikro- og makroøkonomi", "econ-2522", "Economics I", "Konsument-/produsentteori, velferdsøkonomi og makromodeller"),
            ("TMA4100 / MA0001", "Matematikk / Kalkulus", "math-2588", "Mathematics", "Derivasjon, integrasjon, optimering og funksjoner av flere variabler"),
            ("TDT4100 / ITGK", "Python & Programmering", "prog-3021", "Programming & Data", "Python-datastrukturer, filbehandling, Pandas og feilsøking"),
        ],
        "timetable_steps": [
            "Åpne ntnu.instructure.com (dersom emnet bruker Canvas) og din personlige timeplan på tp.educloud.no/ntnu.",
            "Installer Study-OS Sync og par én gang med 6-tegns kode fra studyos.no.",
            "Klikk Sync for å hente forelesninger fra TP og frister inn i Schedule Studio — eller lim inn TP sin .ics-lenke direkte.",
            "Slipp forelesningsslides og tidligere eksamener fra Blackboard/Canvas rett inn for lynrask split-screen PDF-lesing.",
        ],
        "faqs": [
            (
                "Fungerer Study-OS for NTNU-studenter når noen emner bruker Blackboard?",
                "Ja! Selv om emnet ditt ligger i Blackboard, kan du synke hele NTNU-timeplanen fra tp.educloud.no/ntnu (.ics eller 1-klikk), slippe alle nedlastede PDF-er/øvinger privat i nettleseren, og bruke alle 1 180+ øvingsoppgavene og AI-veilederen gratis.",
            ),
            (
                "Støtter Study-OS norske emnekoder med Æ, Ø og Å som SØK1001 og TIØ4120?",
                "Ja. Emnekode-parseren i Study-OS Sync v{ext_version} støtter ÆØÅ (SØK1001, BØA1100, TIØ4120) og kobler emnene dine til relevante oppgavebanker automatisk.",
            ),
            (
                "Hvor rask er PDF-leseren for store NTNU-kompendier og pensumbøker?",
                "Study-OS bruker lokal IndexedDB-lagring (opptil 260 MB per PDF) med LRU side-caching og innebygd fulltekstsøk, slik at sidebytte skjer på få millisekunder uten opplasting til eksterne servere.",
            ),
        ],
    },
    {
        "slug": "uio",
        "lang": "nb",
        "short": "UiO",
        "name": "Universitetet i Oslo (UiO)",
        "city": "Oslo (Blindern)",
        "geo_region": "NO-03",
        "geo_placename": "Oslo, Norway",
        "canvas_host": "uio.instructure.com",
        "canvas_url": "https://uio.instructure.com/",
        "timetable_name": "TP UiO (tp.uio.no)",
        "timetable_url": "https://tp.uio.no/",
        "exam_platform": "Inspera Assessment",
        "program_focus": "Samfunnsøkonomi (ECON), Informatikk (IN1000), Matematikk (MAT1100)",
        "title": "UiO Canvas & TP Timeplan Sync · Eksamensøving Oslo · Study-OS",
        "desc": (
            "Synk UiO Canvas (uio.instructure.com / canvas.uio.no) og tp.uio.no timeplan i 1 klikk. "
            "Gratis øvingsbank for ECON1210, IN1000 og MAT1100 med AI-veileder og rask PDF-leser."
        ),
        "lead_en": (
            "Built in Oslo for Blindern and Oslo students: 1-click UiO Canvas & tp.uio.no timetable sync, "
            "spaced-repetition exam drills for Economics, Python, and Calculus, plus instant side-by-side PDFs."
        ),
        "lead_nb": (
            "Laget i Oslo: synk uio.instructure.com / canvas.uio.no og timeplanen fra tp.uio.no med 1 klikk. "
            "Få oversikt over obligatoriske innleveringer, døgnrytmebasert leseplan og over 1 180 øvingsoppgaver."
        ),
        "course_mappings": [
            ("ECON1210 / ECON1310", "Mikro- og makroøkonomi", "econ-2522", "Economics I", "Markedslikevekt, elastisitet, monopol, finans- og pengepolitikk"),
            ("IN1000 / IN1900", "Introduksjon til programmering (Python)", "prog-3021", "Programming & Data", "Python-løkker, funksjoner, lister, ordbøker og databehandling"),
            ("MAT1100 / MAT1001", "Kalkulus & Matematikk", "math-2588", "Mathematics", "Derivasjon, optimalisering, flere variabler og rekker"),
        ],
        "timetable_steps": [
            "Hold uio.instructure.com (eller canvas.uio.no) og tp.uio.no åpne i nettleseren din.",
            "Installer Study-OS Sync (Chrome/Brave/Edge) og koble sammen med en 6-tegns kode fra studyos.no.",
            "Klikk Sync for å hente alle aktive UiO-emner, oblig-frister og forelesninger fra tp.uio.no.",
            "Planlegg studieøkter automatisk rundt forelesninger og deltidsjobb i Schedule Studio.",
        ],
        "faqs": [
            (
                "Støtter Study-OS både canvas.uio.no og uio.instructure.com?",
                "Ja. Begge domenene gjenkjennes automatisk som UiO i Study-OS Sync v{ext_version}, og alle lenker til emner og obliger går direkte tilbake til ditt UiO Canvas.",
            ),
            (
                "Kan jeg importere timeplanen min fra tp.uio.no?",
                "Ja! Study-OS godtar både 1-klikks synk fra en åpen tp.uio.no-fane og direkte innliming av iCal/.ics-lenken fra Mine studier / TP.",
            ),
            (
                "Koster Study-OS noe for UiO-studenter?",
                "Nei, Study-OS er 100 % gratis uten reklame eller sporingscookies, og alle data lagres under europeiske GDPR-regler.",
            ),
        ],
    },
    {
        "slug": "nhh",
        "lang": "nb",
        "short": "NHH",
        "name": "Norges Handelshøyskole (NHH)",
        "city": "Bergen",
        "geo_region": "NO-46",
        "geo_placename": "Bergen, Norway",
        "canvas_host": "nhh.instructure.com",
        "canvas_url": "https://nhh.instructure.com/",
        "timetable_name": "TimeEdit (cloud.timeedit.net)",
        "timetable_url": "https://cloud.timeedit.net/",
        "exam_platform": "WISEflow",
        "program_focus": "Økonomi og administrasjon (BED, SAM, MET, SOL, FIE)",
        "title": "NHH Canvas, TimeEdit & WISEflow Øving · Gratis Studieplattform · Study-OS",
        "desc": (
            "Synk NHH Canvas (nhh.instructure.com) og TimeEdit i 1 klikk. Øv på BED1/BED2, SAM1/SAM2, "
            "MET1 og SOL1 med WISEflow-simulator, karaktersnittkalkulator og AI-veileder."
        ),
        "lead_en": (
            "1-click NHH Canvas & TimeEdit sync paired with timed WISEflow exam simulations, accounting & economics "
            "question banks, instant inline PDF reading, and a Norwegian ECTS GPA planner."
        ),
        "lead_nb": (
            "Perfekt for NHH-studenter i Bergen: 1-klikks synk med NHH Canvas og TimeEdit, WISEflow-eksamensmodus "
            "med ±2 % avrundingsregler, samt over 1 180 øvingsoppgaver i regnskap, finans, samfunnsøkonomi og matte."
        ),
        "course_mappings": [
            ("BED1 / BED2 / BED10", "Finansregnskap & Bedriftsøkonomi", "acct-2527", "Accounting & Finance", "Balanse, resultat, kontantstrøm, investeringsanalyse og finansiering"),
            ("SAM1 / SAM2", "Mikro- og makroøkonomi", "econ-2522", "Economics I", "Tilbud/etterspørsel, markedsmakt, IS-LM og pengepolitikk"),
            ("MET1 / MET2", "Matematikk & Statistikk for økonomer", "math-2588", "Mathematics", "Flervariabel kalkulus, Lagrange, optimering og kvantitativ metode"),
            ("SOL1 / SOL2", "Strategi, organisasjon og ledelse", "ob-2537", "OB & Leadership", "Organisasjonsatferd, ledelse, motivasjon og strategi"),
        ],
        "timetable_steps": [
            "Åpne nhh.instructure.com (eller canvas.nhh.no) og TimeEdit-timeplanen din i Chrome/Brave/Edge.",
            "Par Study-OS Sync én gang med 6-tegns koden fra studyos.no.",
            "Klikk Sync for å importere NHH-emner, frister og TimeEdit-forelesninger automatisk.",
            "Bruk WISEflow-eksamensmodus (3 timer, ingen hint) og sjekk målsnittet ditt i vår gratis karakterkalkulator.",
        ],
        "faqs": [
            (
                "Fungerer WISEflow-eksamenssimulatoren for NHH-fag?",
                "Ja. Simulatoren trener tidsstyring på 3-timers WISEflow-eksamener med desimalpunktum, minustegn for utbetalinger og ±2 % toleranse på flerfelt-oppgaver i regnskap og finans.",
            ),
            (
                "Gjenkjenner Study-OS NHH-emnekoder som BED10, FIE400 og SAM2?",
                "Ja. Study-OS Sync v{ext_version} støtter NHH sine Canvas-domener (nhh.instructure.com / canvas.nhh.no), TimeEdit .ics-strømmer og kobler økonomi- og finansfag rett til relevante oppgavebanker.",
            ),
        ],
    },
    {
        "slug": "uib",
        "lang": "nb",
        "short": "UiB",
        "name": "Universitetet i Bergen (Mitt UiB)",
        "city": "Bergen",
        "geo_region": "NO-46",
        "geo_placename": "Bergen, Norway",
        "canvas_host": "mitt.uib.no",
        "canvas_url": "https://mitt.uib.no/",
        "timetable_name": "TP UiB (tp.educloud.no/uib)",
        "timetable_url": "https://tp.educloud.no/uib/",
        "exam_platform": "Inspera Assessment",
        "program_focus": "Samfunnsøkonomi (ECON), Informatikk (INF100), Matematikk (MAT111), Org (AORG)",
        "title": "Mitt UiB (mitt.uib.no) & TP Timeplan Sync · Study-OS for UiB-studenter",
        "desc": (
            "Synk Mitt UiB (mitt.uib.no) emner, moduler og frister + TP-timeplan i 1 klikk. "
            "Gratis studieplattform med øvingsoppgaver for ECON110, INF100, MAT111 og rask PDF-leser."
        ),
        "lead_en": (
            "Full native support for Mitt UiB (mitt.uib.no) and UiB's TP timetable: pull courses, modules, and "
            "deadlines in 1 click without sharing Feide passwords, plus 1,180+ overlapping practice drills."
        ),
        "lead_nb": (
            "Full støtte for mitt.uib.no (UiB sitt egne Canvas-domene) og TP-timeplanen. "
            "Hent emner, moduler og innleveringsfrister på sekunder — helt privat og gratis."
        ),
        "course_mappings": [
            ("ECON110 / ECON130", "Mikro- og makroøkonomi", "econ-2522", "Economics I", "Markedsteori, elastisiteter, velferd og makroøkonomi"),
            ("INF100", "Grunnkurs i programmering (Python)", "prog-3021", "Programming & Data", "Python-grunnlag, datastrukturer, analyse og visualisering"),
            ("MAT111 / MAT101", "Grunnkurs i matematikk", "math-2588", "Mathematics", "Derivasjon, optimering og funksjonsanalyse"),
            ("AORG100", "Organisasjon og ledelse", "ob-2537", "OB & Leadership", "Organisasjonsteori, ledelse og beslutningsprosesser"),
        ],
        "timetable_steps": [
            "Logg inn på mitt.uib.no og åpne timeplanen din i TP (tp.educloud.no/uib).",
            "Installer Study-OS Sync (eksplisitt støtte for mitt.uib.no) og par én gang med 6-tegns kode.",
            "Klikk Sync for å overføre aktive UiB-emner, frister og forelesninger til Study-OS.",
        ],
        "faqs": [
            (
                "Hvorfor fungerer Study-OS med mitt.uib.no når andre Canvas-utvidelser feiler?",
                "Mange Canvas-utvidelser sjekker bare *.instructure.com og glemmer UiB sitt domene mitt.uib.no. Study-OS Sync v{ext_version} har eksplisitt tillatelse og gjenkjenning for mitt.uib.no.",
            ),
            (
                "Kan jeg synke både Mitt UiB og TP-timeplanen samtidig?",
                "Ja. Ha begge fanene åpne og klikk Sync én gang — så hentes både Canvas-emner/frister og TP-forelesninger parallelt.",
            ),
        ],
    },
    {
        "slug": "oslomet",
        "lang": "nb",
        "short": "OsloMet",
        "name": "OsloMet — Storbyuniversitetet",
        "city": "Oslo (Pilestredet & Kjeller)",
        "geo_region": "NO-03",
        "geo_placename": "Oslo, Norway",
        "canvas_host": "oslomet.instructure.com",
        "canvas_url": "https://oslomet.instructure.com/",
        "timetable_name": "TP / TimeEdit OsloMet",
        "timetable_url": "https://tp.educloud.no/oslomet/",
        "exam_platform": "Inspera Assessment & WISEflow",
        "program_focus": "Økonomi og administrasjon (ADØK / ØA), Anvendt datateknologi (DATA1100)",
        "title": "OsloMet Canvas & Timeplan Sync · ØkAd & Data Øvingsoppgaver · Study-OS",
        "desc": (
            "Synk OsloMet Canvas (oslomet.instructure.com) og timeplan i 1 klikk. Gratis øvingsoppgaver for "
            "ADØK1100, ØA1100 og DATA1100 med AI-veileder, formelnotater og lokal PDF-leser."
        ),
        "lead_en": (
            "1-click OsloMet Canvas & timetable sync for Pilestredet and Kjeller students — automatically matching "
            "ØkAd (ADØK/ØA) and IT (DATA) courses to 1,180+ active-recall questions and formula sheets."
        ),
        "lead_nb": (
            "Synk oslomet.instructure.com og timeplanen din inn i Study-OS i 1 klikk. "
            "Støtter norske emnekoder som ADØK1100 og ØA1100, pluss lokal side-ved-side PDF-lesing."
        ),
        "course_mappings": [
            ("ADØK1100 / ØA1100", "Bedriftsøkonomi & Finansregnskap", "acct-2527", "Accounting & Finance", "Regnskap, kostnadskalkyler, budsjettering og investering"),
            ("ADØK / Samfunnsøkonomi", "Mikro- og makroøkonomi", "econ-2522", "Economics I", "Markedsmekanismer, elastisitet og makroøkonomi"),
            ("DATA1100 / Programmering", "Programmering & Data", "prog-3021", "Programming & Data", "Python, databehandling, algoritmer og visualisering"),
            ("MEF1000 / Metode", "Matematikk & Kvantitativ metode", "math-2588", "Mathematics", "Derivasjon, optimalisering og statistiske modeller"),
        ],
        "timetable_steps": [
            "Logg inn på oslomet.instructure.com (eller canvas.oslomet.no) og åpne timeplanen din.",
            "Installer Study-OS Sync og koble sammen med 6-tegns kode fra studyos.no.",
            "Klikk Sync én gang — emner, frister og undervisningstidspunkt holdes automatisk oppdatert.",
        ],
        "faqs": [
            (
                "Virker Study-OS Sync med oslomet.instructure.com og norske emnekoder som ADØK1100?",
                "Ja. Study-OS Sync v{ext_version} støtter både oslomet.instructure.com og canvas.oslomet.no samt emnekoder med Æ, Ø og Å.",
            ),
            (
                "Kan OsloMet ØkAd-studenter bruke regnskaps- og økonomioppgavene i Study-OS?",
                "Ja! Kjernetemaene i norsk ØkAd (regnskap, bidragskalkyler, investering, mikro/makro, matematikk og organisasjonsatferd) er felles på tvers av OsloMet, BI, UiA og NHH.",
            ),
        ],
    },
    {
        "slug": "canvas-lms",
        "lang": "en",
        "short": "Any Canvas LMS",
        "name": "Any Canvas LMS University (*.instructure.com)",
        "city": "Worldwide (Instructure Canvas)",
        "geo_region": "NO",
        "geo_placename": "Global / Norway",
        "canvas_host": "*.instructure.com",
        "canvas_url": "https://studyos.no/",
        "timetable_name": "TimeEdit, TP, Google Calendar & Apple Calendar (.ics)",
        "timetable_url": "https://studyos.no/?view=schedule",
        "exam_platform": "Canvas Quizzes, WISEflow, Inspera & Written Exams",
        "program_focus": "Economics, Accounting & Finance, Calculus, Python, Organizational Behavior & Custom PDFs",
        "title": "Free Canvas LMS Study Tool & 1-Click Deadline Sync Extension · Study-OS",
        "desc": (
            "Sync any Instructure Canvas (*.instructure.com) courses, modules & assignment deadlines into a free "
            "study workspace with circadian scheduling, instant inline PDF reader, FSRS spaced repetition & AI tutor."
        ),
        "lead_en": (
            "Works with any university running Instructure Canvas (*.instructure.com): pull active courses, syllabus "
            "modules, and assignment deadlines in 1 click using your already signed-in tab — zero OAuth admin approval, "
            "zero passwords, and 100% free."
        ),
        "lead_nb": (
            "Bruker skolen din Canvas (*.instructure.com)? Study-OS Sync oppdager automatisk Canvas-fanen din, "
            "henter emner, moduler og frister med 1 klikk — uten passord eller admin-godkjenning."
        ),
        "course_mappings": [
            ("ACCT / FIN", "Financial Accounting & Corporate Finance", "acct-2527", "Accounting & Finance", "Balance sheets, cash flows, ratios, depreciation, NPV/IRR"),
            ("ECON 101 / 102", "Microeconomics & Macroeconomics", "econ-2522", "Economics I", "Supply & demand, elasticity, market structures, GDP & inflation"),
            ("MATH / CALC", "Calculus & Applied Mathematics", "math-2588", "Mathematics", "Derivatives, chain rule, multivariable optimization & Lagrange"),
            ("CS / PYTHON", "Python Programming & Data Analysis", "prog-3021", "Programming & Data", "Python fundamentals, Pandas data cleaning & visualization"),
            ("MGMT / OB", "Organizational Behavior & Leadership", "ob-2537", "OB & Leadership", "Leadership models, motivation, culture, power & teams"),
        ],
        "timetable_steps": [
            "Open your university's signed-in Canvas tab (any https://*.instructure.com or custom Norwegian Canvas host).",
            "Install Study-OS Sync (Manifest V3) and paste a one-time 6-character pairing code from studyos.no.",
            "Click Sync once — Study-OS auto-detects your school, imports active courses, modules & due dates, and refreshes quietly in the background.",
            "Drop your own lecture slides, past exams, or textbooks (up to 260 MB/PDF locally) for instant split-screen reading with in-PDF search.",
        ],
        "faqs": [
            (
                "Does Study-OS Sync require my university IT department to approve an OAuth app?",
                "No. Study-OS Sync v{ext_version} runs inside your already signed-in browser tab using standard Canvas REST API same-origin requests. It never asks for your school password or copies cookies, so any student at any Canvas university can use it immediately.",
            ),
            (
                "How does Study-OS handle copyrighted university PDFs and textbooks?",
                "Study-OS never uploads or shares university PDFs publicly. Files you drop (up to 260 MB per PDF) stay strictly private inside your browser's local IndexedDB storage with instant inline rendering and in-PDF search.",
            ),
            (
                "Does it work with Google Calendar, Apple Calendar, TimeEdit, and TP?",
                "Yes. You can import any .ics timetable from Google Calendar, Apple Calendar, TimeEdit, or Norwegian TP, and Study-OS automatically builds a two-week circadian study plan around your classes and work hours.",
            ),
        ],
    },
]

# Additional Norwegian Canvas hosts natively supported in canvas-sync-extension/manifest.json
EXTRA_NORWEGIAN_SCHOOLS: list[tuple[str, str, str, str]] = [
    ("Universitetet i Stavanger (UiS)", "canvas.uis.no", "TimeEdit / .ics", "Økonomi, ingeniør, data & samfunnsfag"),
    ("UiT Norges arktiske universitet", "canvas.uit.no", "TimeEdit / TP (.ics)", "Handelshøgskolen, realfag & informatikk"),
    ("Universitetet i Sørøst-Norge (USN)", "canvas.usn.no", "TimeEdit / .ics", "ØkAd, finans, IT & ledelse"),
    ("NMBU (Ås)", "canvas.nmbu.no", "TimeEdit / .ics", "Økonomi, datavitenskap & matematikk"),
    ("Høgskulen på Vestlandet (HVL)", "canvas.hvl.no", "TimeEdit / .ics", "Økonomi, ingeniør & datafag"),
    ("Høyskolen Kristiania", "canvas.kristiania.no", "TimeEdit / .ics", "Økonomi, ledelse, markedsføring & IT"),
]


GPA_FAQS: list[tuple[str, str]] = [
    (
        "Hvordan regnes karaktersnitt på universitet og høyskole i Norge (A–F)?",
        "I norsk høyere utdanning regnes karaktersnitt som et studiepoengvektet gjennomsnitt der A = 5, B = 4, C = 3, D = 2 og E = 1. Hver tallkarakter ganges med antall studiepoeng (f.eks. 7,5 eller 10 stp), summeres, og deles på totalt antall beståtte graderte studiepoeng.",
    ),
    (
        "Teller Bestått / Ikke bestått (Pass/Fail) på karaktersnittet?",
        "Nei. Emner vurdert med Bestått / Ikke bestått (som enkelte ex.phil.- eller praksisemner) gir studiepoeng, men inngår ikke i beregningen av karaktersnitt til masteropptak ved BI, NHH, NTNU, UiO eller UiA.",
    ),
    (
        "Hvilket karaktersnitt trenger man for masteropptak (MSc / siviløkonom)?",
        "De fleste norske masterprogrammer krever minimum C (2,5–3,0) som formelt minstekrav, mens populære programmer som siviløkonom / MSc på NHH, BI og NTNU ofte har konkurransepoeng rundt 3,7–4,3 (B-nivå). Bruk målsnitt-kalkulatoren over for å se hva du må få på gjenstående emner.",
    ),
    (
        "Lagres karakterene mine på en server?",
        "Nei. Alt beregnes lokalt i nettleseren din og lagres kun i din egen nettleser (localStorage) — ingen konto, ingen reklame, ingen sporing.",
    ),
]

COMPARE_FAQS: list[tuple[str, str]] = [
    (
        "Should I replace Notion or Obsidian with Study-OS?",
        "Not necessarily. Notion and Obsidian are still better for writing long-form essays, group project wikis, and personal note gardens. Study-OS shines during exam prep: syncing Canvas/TimeEdit/TP automatically, running timed WISEflow/active-recall sessions, reading PDFs side-by-side instantly, and tracking study debt.",
    ),
    (
        "How is Study-OS different from Anki or Quizlet?",
        "Anki is unbeatable for pure vocabulary/medical flashcard memorization. Study-OS uses FSRS spaced repetition like Anki, but adds multi-step calculation & WISEflow FLOWmulti worksheets, 1-click Canvas + TimeEdit/TP timetable sync, instant inline PDF pages, and circadian DLPFC scheduling.",
    ),
    (
        "Why is Study-OS free when Quizlet Plus, Studocu, and Norwegian exam portals charge monthly?",
        "Study-OS is an independent open-source student project built in Oslo with lightweight Cloudflare & static browser architecture (PDFs stay local in your browser), keeping operating costs near zero with no ads or paywalls.",
    ),
]


def _breadcrumb_ld(base: str, crumbs: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": idx + 1,
                "name": name,
                "item": url if url.startswith("http") else f"{base}/{url.lstrip('/')}",
            }
            for idx, (name, url) in enumerate(crumbs)
        ],
    }


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


def _fmt_faq_answer(ans: str, ext_version: str) -> str:
    return ans.replace("{ext_version}", ext_version)


def generate_growth_seo_pages(
    out_dir: Path,
    base: str,
    total_qs: int,
    ref_count: int,
    seo_theme_script: str,
    seo_page_style: str = "",
    *,
    catalog: list[dict[str, Any]] | None = None,
    ext_version: str = "1.7.1",
    seo_css_root: str = "./seo.css",
    seo_css_sub: str = "../seo.css",
    today_iso: str = "",
) -> list[tuple[str, str, str]]:
    """Generate multi-university hubs, free GPA calculator micro-tool, and honest comparison page.

    Returns list of (url, priority, changefreq) tuples to append to sitemap.xml.
    """
    today = today_iso or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    course_by_id = {str(c.get("courseId") or ""): c for c in (catalog or []) if c.get("courseId")}
    sitemap_entries: list[tuple[str, str, str]] = []
    uni_dir = out_dir / "uni"
    uni_dir.mkdir(parents=True, exist_ok=True)

    # 1. Individual University Hub Pages (`/uni/<slug>.html`) — Unique Data Layer pSEO 2.0
    for uni in UNIVERSITIES:
        slug = uni["slug"]
        page_lang = uni.get("lang", "nb")
        og_locale = "en_US" if page_lang == "en" else "nb_NO"
        og_locale_alt = "nb_NO" if page_lang == "en" else "en_GB"
        page_url = f"{base}/uni/{slug}.html"
        siblings = [u for u in UNIVERSITIES if u["slug"] != slug]
        sibling_links = "".join(
            f'<a class="ghost-btn" href="./{escape(s["slug"], quote=True)}.html">{escape(s["short"])}</a>'
            for s in siblings
        )

        mapping_rows_parts: list[str] = []
        for code, cname, cid, bank_lbl, topics in uni["course_mappings"]:
            live_c = course_by_id.get(cid)
            live_qs = int(live_c.get("questionCount") or 0) if live_c else 0
            label_with_count = f"{bank_lbl} ({live_qs} Qs)" if live_qs else bank_lbl
            mapping_rows_parts.append(
                f"""          <tr>
            <td><strong>{escape(code)}</strong></td>
            <td>{escape(cname)}</td>
            <td><a href="../courses/{escape(cid, quote=True)}.html">{escape(label_with_count)}</a></td>
            <td>{escape(topics)}</td>
          </tr>\n"""
            )
        mapping_rows = "".join(mapping_rows_parts)

        steps_html = "".join(
            f"        <li><strong>Step {i + 1}:</strong> {escape(step)}</li>\n"
            for i, step in enumerate(uni["timetable_steps"])
        )

        resolved_faqs = [(q, _fmt_faq_answer(a, ext_version)) for q, a in uni["faqs"]]
        faq_html = "".join(
            f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
            for q, a in resolved_faqs
        )

        tt_url = uni["timetable_url"]
        tt_rel = "noopener nofollow" if "?view=" in tt_url else "noopener"

        json_ld = {
            "@context": "https://schema.org",
            "@graph": [
                _breadcrumb_ld(base, [
                    ("Study-OS", f"{base}/"),
                    ("Universities", f"{base}/universities.html"),
                    (uni["short"], page_url),
                ]),
                {
                    "@type": "WebPage",
                    "@id": f"{page_url}#webpage",
                    "url": page_url,
                    "name": uni["title"],
                    "description": uni["desc"],
                    "image": f"{base}/og-image.png",
                    "dateModified": today,
                    "inLanguage": ["en", "nb"] if page_lang == "en" else ["nb", "en"],
                    "about": [uni["name"], "Canvas LMS", uni["timetable_name"], "Exam Preparation"],
                    "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                    "publisher": _publisher_ld(base),
                },
                {
                    "@type": "HowTo",
                    "name": f"How to sync {uni['short']} Canvas and {uni['timetable_name']} to Study-OS",
                    "totalTime": "PT1M",
                    "step": [
                        {"@type": "HowToStep", "position": i + 1, "text": step}
                        for i, step in enumerate(uni["timetable_steps"])
                    ],
                },
                {
                    "@type": "FAQPage",
                    "mainEntity": [
                        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                        for q, a in resolved_faqs
                    ],
                },
            ],
        }

        lead_first = (
            f'      <p class="seo-lead" lang="en">{escape(uni["lead_en"])}</p>\n'
            f'      <p class="seo-lead seo-lead-sub" lang="nb">{escape(uni["lead_nb"])}</p>'
            if page_lang == "en"
            else f'      <p class="seo-lead" lang="nb">{escape(uni["lead_nb"])}</p>\n'
            f'      <p class="seo-lead seo-lead-sub" lang="en">{escape(uni["lead_en"])}</p>'
        )

        html = f"""<!doctype html>
<html lang="{escape(page_lang, quote=True)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(uni['desc'], quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="{escape(uni['geo_region'], quote=True)}">
  <meta name="geo.placename" content="{escape(uni['geo_placename'], quote=True)}">
  <link rel="canonical" href="{escape(page_url, quote=True)}">
  <link rel="alternate" type="text/markdown" href="{base}/uni/{escape(slug, quote=True)}.md" title="{escape(uni['short'], quote=True)} Guide (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="{og_locale}">
  <meta property="og:locale:alternate" content="{og_locale_alt}">
  <meta property="og:url" content="{escape(page_url, quote=True)}">
  <meta property="og:title" content="{escape(uni['title'], quote=True)}">
  <meta property="og:description" content="{escape(uni['desc'], quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS for {escape(uni['short'], quote=True)} — Canvas LMS and Timetable Sync">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(uni['title'], quote=True)}">
  <meta name="twitter:description" content="{escape(uni['desc'], quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{seo_theme_script}
  <title>{escape(uni['title'])}</title>
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-48.png" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-96.png" sizes="96x96">
  <link rel="icon" type="image/png" href="/pwa/study-os-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/pwa/study-os-192.png">
  <link rel="stylesheet" href="{escape(seo_css_sub, quote=True)}">
  <script type="application/ld+json">{json.dumps(json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="../" class="ghost-btn">← Open Study-OS</a>
        <a href="../universities.html" class="ghost-btn">All Universities</a>
        <a href="../gpa-calculator.html" class="ghost-btn">GPA Calculator</a>
      </div>
      <span class="badge">{escape(uni['short'])} · {escape(uni['city'])}</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">{escape(uni['name'])} · {escape(uni['canvas_host'])} · {escape(uni['timetable_name'])}</span>
      <h1>Study-OS for {escape(uni['short'])} Students — Canvas &amp; Timetable Sync</h1>
      <div class="seo-acu">
        <strong>Quick summary:</strong> Study-OS connects directly to <code>{escape(uni['canvas_host'])}</code> and <strong>{escape(uni['timetable_name'])}</strong> in 1 click (zero passwords copied), matches {escape(uni['short'])} courses to <strong>{total_qs:,} free practice questions</strong> &amp; <strong>{ref_count} formula sheets</strong>, and includes an instant inline PDF reader and AI tutor.
      </div>
{lead_first}
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="../">Open Study-OS Workspace →</a>
        <a class="ghost-btn btn-lg" href="../downloads/study-os-sync-extension.zip" download>Download Sync Extension (v{escape(ext_version)})</a>
        <a class="ghost-btn btn-lg" href="../gpa-calculator.html">Karaktersnitt Kalkulator</a>
      </div>
      <div class="seo-stats">
        <div class="seo-stat"><strong>{escape(uni['canvas_host'])}</strong><small>Auto-detected Canvas LMS</small></div>
        <div class="seo-stat"><strong>{escape(uni['timetable_name'].split(' ')[0])}</strong><small>Timetable (.ics / 1-click)</small></div>
        <div class="seo-stat"><strong>{total_qs:,}</strong><small>Practice questions</small></div>
        <div class="seo-stat"><strong>0 kr</strong><small>Free · GDPR EU · No ads</small></div>
      </div>
    </article>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Auto-matched syllabus banks · {escape(uni['program_focus'])}</span>
      <h2>Popular {escape(uni['short'])} courses matched on Study-OS</h2>
      <p>When you sync your {escape(uni['short'])} Canvas tab, Study-OS places your courses right at the top of Home and links overlapping topics directly to our interactive practice banks &amp; formula sheets:</p>
      <div class="uni-table-wrap">
        <table class="uni-table">
          <thead>
            <tr>
              <th>{escape(uni['short'])} Code</th>
              <th>Course</th>
              <th>Matched Study-OS Bank</th>
              <th>Overlapping Exam Topics</th>
            </tr>
          </thead>
          <tbody>
{mapping_rows}          </tbody>
        </table>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">30-second setup · {escape(uni['exam_platform'])}</span>
      <h2>How to sync {escape(uni['short'])} Canvas &amp; {escape(uni['timetable_name'])}</h2>
      <ol class="seo-steps">
{steps_html}      </ol>
      <div class="seo-cta-row" style="margin-top:12px">
        <a class="ghost-btn" href="{escape(uni['canvas_url'], quote=True)}" target="_blank" rel="noopener">Open {escape(uni['short'])} Canvas ↗</a>
        <a class="ghost-btn" href="{escape(tt_url, quote=True)}" target="_blank" rel="{tt_rel}">Open {escape(uni['timetable_name'])} ↗</a>
        <a class="ghost-btn" href="../bi-canvas-timeedit-sync.html">Full Extension Guide</a>
      </div>
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">{escape(uni['short'])} FAQ / Ofte stilte spørsmål</h2>
      <div class="seo-faq">
{faq_html}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Supported universities &amp; tools</span>
      <h2>Explore other university guides on Study-OS</h2>
      <div class="seo-cta-row" style="margin-top:8px">
        <a class="ghost-btn" href="../bi-oslo.html">BI Oslo</a>
        {sibling_links}
        <a class="ghost-btn" href="../wiseflow-practice.html">WISEflow Exams</a>
        <a class="ghost-btn" href="../compare.html">Study-OS vs Notion &amp; Anki</a>
      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent student project in Norway (not officially affiliated with {escape(uni['name'])}).</span>
      <nav aria-label="Footer links">
        <a href="../">App</a>
        <a href="../universities.html">Universities</a>
        <a href="../norsk.html" lang="nb">Norsk</a>
        <a href="../gpa-calculator.html">GPA Calculator</a>
        <a href="../compare.html">Compare</a>
        <a href="../bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="../notes.html">Notes</a>
        <a href="../privacy.html">Privacy</a>
        <a href="../terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
        (uni_dir / f"{slug}.html").write_text(html, encoding="utf-8")
        sitemap_entries.append((page_url, "0.85", "weekly"))

    # 1B. Clean `/uni/index.html` fallback (prevents GitHub Pages `/uni` -> `/uni/` 301->404 without duplicating `/universities.html`)
    uni_index_links = "".join(
        f'        <a class="ghost-btn" href="./{escape(u["slug"], quote=True)}.html">{escape(u["name"])}</a>\n'
        for u in UNIVERSITIES
    )
    uni_index_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="{base}/universities.html">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{seo_theme_script}
  <title>University Guides Directory · Study-OS</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="stylesheet" href="{escape(seo_css_sub, quote=True)}">
</head>
<body>
  <main class="nf-shell">
    <article class="panel nf-card">
      <span class="eyebrow">Study-OS · Supported Universities</span>
      <h1>University Canvas &amp; Timetable Guides</h1>
      <p class="muted">Browse the full university compatibility directory or jump directly to your school guide below.</p>
      <div class="nf-links">
        <a class="primary-btn" href="../universities.html">Open Full Universities Directory →</a>
        <a class="ghost-btn" href="../bi-oslo.html">BI Norwegian Business School (BI Oslo)</a>
{uni_index_links}      </div>
    </article>
  </main>
</body>
</html>
"""
    (uni_dir / "index.html").write_text(uni_index_html, encoding="utf-8")

    # 2. Central Multi-University Hub (`/universities.html`)
    hub_title = "Supported Universities · Canvas, TimeEdit & TP Sync · Study-OS"
    hub_desc = (
        f"Free Canvas LMS & TimeEdit/TP sync for BI Oslo, UiA, NTNU, UiO, NHH, UiB, OsloMet, UiS, UiT, USN & any "
        f"*.instructure.com school — {total_qs:,} questions & AI tutor."
    )
    hub_cards = [
        f"""      <article class="panel seo-card">
        <div>
          <span class="eyebrow">canvas.bi.no · TimeEdit · WISEflow</span>
          <h3>BI Norwegian Business School (BI Oslo)</h3>
          <p>5 full course banks (EXC 3420 / SØK 3420, EXC 3430 / BØK 3430, EXC 3460 / ORG 3460, EBA 3400, EBA 1181 / EBA 1180), {total_qs:,} questions, WISEflow FLOWmulti simulator, and 1-click BI Canvas/TimeEdit sync.</p>
        </div>
        <div class="seo-cta-row">
          <a class="primary-btn" href="./bi-oslo.html">BI Oslo Guide →</a>
          <a class="ghost-btn" href="./wiseflow-practice.html">WISEflow</a>
        </div>
      </article>\n"""
    ]
    for u in UNIVERSITIES:
        hub_cards.append(
            f"""      <article class="panel seo-card">
        <div>
          <span class="eyebrow">{escape(u['canvas_host'])} · {escape(u['timetable_name'])}</span>
          <h3>{escape(u['name'])}</h3>
          <p>{escape(u['desc'])}</p>
        </div>
        <div class="seo-cta-row">
          <a class="primary-btn" href="./uni/{escape(u['slug'], quote=True)}.html">{escape(u['short'])} Guide →</a>
          <a class="ghost-btn" href="./">Open App</a>
        </div>
      </article>\n"""
        )

    extra_school_rows = "".join(
        f"          <tr><td><strong>{escape(name)}</strong></td><td><code>{escape(host)}</code></td><td>{escape(tt)}</td><td>{escape(focus)}</td></tr>\n"
        for name, host, tt, focus in EXTRA_NORWEGIAN_SCHOOLS
    )

    hub_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            _breadcrumb_ld(base, [("Study-OS", f"{base}/"), ("Universities", f"{base}/universities.html")]),
            {
                "@type": "CollectionPage",
                "name": hub_title,
                "url": f"{base}/universities.html",
                "description": hub_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today,
                "inLanguage": ["en", "nb"],
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "ItemList",
                "name": "Universities Supported by Study-OS Canvas & Timetable Sync",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "BI Oslo", "url": f"{base}/bi-oslo.html"},
                    *[
                        {"@type": "ListItem", "position": i + 2, "name": u["name"], "url": f"{base}/uni/{u['slug']}.html"}
                        for i, u in enumerate(UNIVERSITIES)
                    ],
                ],
            },
        ],
    }

    hub_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(hub_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO">
  <meta name="geo.placename" content="Norway">
  <link rel="canonical" href="{base}/universities.html">
  <link rel="alternate" type="text/markdown" href="{base}/universities.md" title="Supported Universities (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/universities.html">
  <meta property="og:title" content="{escape(hub_title, quote=True)}">
  <meta property="og:description" content="{escape(hub_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS Supported Norwegian and Global Canvas Universities">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(hub_title, quote=True)}">
  <meta name="twitter:description" content="{escape(hub_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{seo_theme_script}
  <title>{escape(hub_title)}</title>
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-48.png" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-96.png" sizes="96x96">
  <link rel="icon" type="image/png" href="/pwa/study-os-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/pwa/study-os-192.png">
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(hub_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./gpa-calculator.html" class="ghost-btn">GPA Calculator</a>
        <a href="./compare.html" class="ghost-btn">Compare</a>
      </div>
      <span class="badge">Norway + Any *.instructure.com Canvas</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Multi-University Directory · Canvas · TimeEdit · TP · Ed</span>
      <h1>Universities Supported by Study-OS</h1>
      <p class="seo-lead">{escape(hub_desc)}</p>
      <p class="seo-lead seo-lead-sub" lang="nb">
        Velg universitetet ditt under for oppsett av 1-klikks Canvas-synk (Study-OS Sync v{escape(ext_version)}), TimeEdit / TP-timeplan og matchede eksamensoppgaver — helt gratis uten skolepassord.
      </p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Launch Study-OS →</a>
        <a class="ghost-btn btn-lg" href="./bi-canvas-timeedit-sync.html">Canvas Sync Extension (v{escape(ext_version)})</a>
        <a class="ghost-btn btn-lg" href="./gpa-calculator.html">Karaktersnitt Kalkulator</a>
      </div>
    </article>

    <section>
      <h2 style="margin:0 0 8px">Dedicated University Guides</h2>
      <div class="seo-grid">
{"".join(hub_cards)}      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Built-in host support · Study-OS Sync v{escape(ext_version)}</span>
      <h2>More Norwegian Universities Supported Out of the Box</h2>
      <p>Study-OS Sync v{escape(ext_version)} includes native Manifest V3 host permissions for all major Norwegian Canvas domains below — plus every global <code>*.instructure.com</code> school:</p>
      <div class="seo-table-wrap">
        <table class="seo-table">
          <thead>
            <tr>
              <th>Institution</th>
              <th>Canvas LMS Host</th>
              <th>Timetable</th>
              <th>Overlapping Subjects</th>
            </tr>
          </thead>
          <tbody>
{extra_school_rows}          </tbody>
        </table>
      </div>
      <div class="seo-cta-row" style="margin-top:10px">
        <a class="primary-btn" href="./bi-canvas-timeedit-sync.html">Install Sync Extension (v{escape(ext_version)}) →</a>
        <a class="ghost-btn" href="./uni/canvas-lms.html">Any *.instructure.com Guide</a>
      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent open-source student workspace in Norway.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./compare.html">Compare</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "universities.html").write_text(hub_html, encoding="utf-8")
    sitemap_entries.append((f"{base}/universities.html", "0.9", "weekly"))

    # 3. Free Zero-Auth Micro-Tool Link Magnet: Norwegian University GPA / Karaktersnitt Calculator (`/gpa-calculator.html`)
    gpa_title = "Karaktersnitt & GPA Kalkulator (BI & Universitet) · Study-OS"
    gpa_desc = (
        "Gratis GPA kalkulator for BI & norske universiteter (NHH, NTNU, UiO, UiA). "
        "Regn ut snitt med studiepoeng (A=5 til E=1) og målsnitt for masteropptak."
    )
    gpa_faqs = GPA_FAQS
    gpa_faq_html = "".join(
        f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
        for q, a in gpa_faqs
    )
    gpa_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            _breadcrumb_ld(base, [("Study-OS", f"{base}/"), ("Karaktersnitt Kalkulator", f"{base}/gpa-calculator.html")]),
            {
                "@type": "WebApplication",
                "name": "Study-OS Karaktersnitt Kalkulator (Norwegian University ECTS GPA Calculator)",
                "url": f"{base}/gpa-calculator.html",
                "applicationCategory": "EducationalApplication",
                "operatingSystem": "Web",
                "isAccessibleForFree": True,
                "dateModified": today,
                "inLanguage": ["nb", "en"],
                "description": gpa_desc,
                "image": f"{base}/og-image.png",
                "offers": {"@type": "Offer", "price": "0", "priceCurrency": "NOK"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                    for q, a in gpa_faqs
                ],
            },
        ],
    }

    gpa_html = f"""<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(gpa_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="geo.region" content="NO">
  <meta name="geo.placename" content="Norway">
  <link rel="canonical" href="{base}/gpa-calculator.html">
  <link rel="alternate" type="text/markdown" href="{base}/gpa-calculator.md" title="Karaktersnitt Kalkulator (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="nb_NO">
  <meta property="og:locale:alternate" content="en_GB">
  <meta property="og:url" content="{base}/gpa-calculator.html">
  <meta property="og:title" content="{escape(gpa_title, quote=True)}">
  <meta property="og:description" content="{escape(gpa_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS Karaktersnitt Kalkulator for norske universiteter og høyskoler">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(gpa_title, quote=True)}">
  <meta name="twitter:description" content="{escape(gpa_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{seo_theme_script}
  <title>{escape(gpa_title)}</title>
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-48.png" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-96.png" sizes="96x96">
  <link rel="icon" type="image/png" href="/pwa/study-os-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/pwa/study-os-192.png">
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(gpa_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./universities.html" class="ghost-btn">Universities</a>
        <a href="./compare.html" class="ghost-btn">Compare</a>
      </div>
      <span class="badge">A=5 · B=4 · C=3 · D=2 · E=1 (ECTS)</span>
    </nav>

    <article class="panel seo-hero" style="margin-bottom:16px">
      <span class="eyebrow">Gratis verktøy · GPA Kalkulator BI &amp; Norske Universiteter (ECTS)</span>
      <h1>Karaktersnitt &amp; GPA Kalkulator (BI &amp; Universitet)</h1>
      <p class="seo-lead" style="margin-bottom:12px">
        Vil du regne ut snitt på BI eller et norsk universitet? Beregn studiepoengvektet karaktersnitt (A = 5 til E = 1), omtrentlig 4.0-skala og nøyaktig hvilket snitt du trenger på gjenstående eksamener for masteropptak ved BI, NHH, UiA, NTNU, UiO, UiB eller OsloMet.
      </p>

      <div class="seo-cta-row" style="margin-bottom:10px">
        <button type="button" class="ghost-btn" data-preset="bi">BI Oslo (7,5 stp)</button>
        <button type="button" class="ghost-btn" data-preset="uia">UiA ØkAd (7,5 stp)</button>
        <button type="button" class="ghost-btn" data-preset="ntnu">NTNU (7,5 stp)</button>
        <button type="button" class="ghost-btn" data-preset="uio">UiO (10 stp)</button>
        <button type="button" class="ghost-btn" data-preset="nhh">NHH (7,5 stp)</button>
      </div>

      <div class="gpa-grid" aria-live="polite">
        <div class="gpa-kpi"><strong id="gpa-avg">—</strong><small>Vektet snitt (A=5, E=1)</small></div>
        <div class="gpa-kpi"><strong id="gpa-letter">—</strong><small>Tilsvarende bokstavkarakter</small></div>
        <div class="gpa-kpi"><strong id="gpa-credits">0 stp</strong><small>Totale studiepoeng (ECTS)</small></div>
        <div class="gpa-kpi"><strong id="gpa-us">—</strong><small>Ca. 4.0-skala (utveksling)</small></div>
      </div>

      <div id="gpa-rows" style="margin-top:12px"></div>
      <div class="seo-cta-row" style="margin-top:10px">
        <button type="button" class="primary-btn" id="gpa-add-row">+ Legg til emne</button>
        <button type="button" class="ghost-btn" id="gpa-copy-btn">Kopier oppsummering</button>
        <button type="button" class="ghost-btn" id="gpa-reset-btn">Nullstill</button>
      </div>
    </article>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Masteropptak &amp; Målplanlegger</span>
      <h2>Hva må jeg få på resten av studiet for å nå målsnittet?</h2>
      <div class="gpa-target-box">
        <label>Ønsket karaktersnitt (1.0 – 5.0)
          <input type="number" id="gpa-target" min="1" max="5" step="0.1" value="4.0">
        </label>
        <label>Gjenstående graderte studiepoeng
          <input type="number" id="gpa-rem-ects" min="0" max="300" step="2.5" value="60">
        </label>
      </div>
      <div class="gpa-result-banner" id="gpa-target-out">Legg inn karakterene dine over for å beregne kravet for gjenstående emner.</div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Norsk karakterskala (Universitet &amp; Høyskole · ECTS)</span>
      <h2>Slik regner du ut vektet karaktersnitt med studiepoeng</h2>
      <p>Formelen for vektet snitt i norsk høyere utdanning er <code>SUM(tallkarakter × studiepoeng) / SUM(graderte studiepoeng)</code>. Emner med <strong>Bestått (P)</strong> gir studiepoeng, men ekskluderes fra telleren og nevneren.</p>
      <div class="seo-table-wrap">
        <table class="seo-table">
          <thead>
            <tr>
              <th>Bokstavkarakter</th>
              <th>Tallverdi</th>
              <th>Teller på snittet?</th>
              <th>Beskrivelse</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>A</strong></td><td><code>5</code></td><td>Ja</td><td>Fremragende prestasjon</td></tr>
            <tr><td><strong>B</strong></td><td><code>4</code></td><td>Ja</td><td>Meget god prestasjon</td></tr>
            <tr><td><strong>C</strong></td><td><code>3</code></td><td>Ja</td><td>Jevnt god prestasjon</td></tr>
            <tr><td><strong>D</strong></td><td><code>2</code></td><td>Ja</td><td>Nokså god prestasjon</td></tr>
            <tr><td><strong>E</strong></td><td><code>1</code></td><td>Ja</td><td>Tilstrekkelig prestasjon</td></tr>
            <tr><td><strong>F</strong></td><td><code>0</code></td><td>Nei</td><td>Ikke bestått</td></tr>
            <tr><td><strong>Bestått (P)</strong></td><td>—</td><td>Nei</td><td>Gir studiepoeng, påvirker ikke snittet</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Løft snittet før neste eksamen</span>
      <h2>Øv smartere med Study-OS (helt gratis)</h2>
      <p>Synk emnene dine fra Canvas (BI, UiA, NTNU, UiO, NHH, UiB, OsloMet) og timeplanen fra TimeEdit / TP, øv på {total_qs:,} oppgaver med FSRS-repetisjon, og les forelesnings-PDF-er rett ved siden av oppgaven.</p>
      <div class="seo-cta-row" style="margin-top:10px">
        <a class="primary-btn" href="./">Åpne Study-OS →</a>
        <a class="ghost-btn" href="./universities.html">Velg universitet</a>
        <a class="ghost-btn" href="./bi-canvas-timeedit-sync.html">Canvas Sync (v{escape(ext_version)})</a>
        <a class="ghost-btn" href="./wiseflow-practice.html">WISEflow Eksamen</a>
      </div>
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">Ofte stilte spørsmål om karaktersnitt</h2>
      <div class="seo-faq">
{gpa_faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Gratis studentverktøy i Norge · Ingen sporing eller reklame.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./universities.html">Universities</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./compare.html">Compare</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>

  <script>
    (function () {{
      var STORAGE_KEY = 'study-os-gpa-calc-v1';
      var POINTS = {{ A: 5, B: 4, C: 3, D: 2, E: 1, P: null }};
      var PRESETS = {{
        bi: [
          {{ name: 'EXC 3420 Economics I', ects: 7.5, grade: 'B' }},
          {{ name: 'EXC 3430 Accounting & Finance', ects: 7.5, grade: 'A' }},
          {{ name: 'EXC 3460 Org. Behavior & Leadership', ects: 7.5, grade: 'B' }},
          {{ name: 'EBA 3400 Programming & Data', ects: 7.5, grade: 'A' }}
        ],
        uia: [
          {{ name: 'BED-100 Bedriftsøkonomi', ects: 7.5, grade: 'B' }},
          {{ name: 'MA-155 Matematikk for økonomer', ects: 7.5, grade: 'A' }},
          {{ name: 'SE-100 Samfunnsøkonomi', ects: 7.5, grade: 'B' }},
          {{ name: 'ORG-100 Organisasjon og ledelse', ects: 7.5, grade: 'B' }}
        ],
        ntnu: [
          {{ name: 'TMA4100 Matematikk 1', ects: 7.5, grade: 'B' }},
          {{ name: 'TDT4100 Objektorientert prog.', ects: 7.5, grade: 'A' }},
          {{ name: 'SØK1001 Mikroøkonomi', ects: 7.5, grade: 'B' }},
          {{ name: 'EXPH0300 Examen philosophicum', ects: 7.5, grade: 'C' }}
        ],
        uio: [
          {{ name: 'ECON1210 Mikroøkonomi 1', ects: 10, grade: 'B' }},
          {{ name: 'IN1000 Introduksjon til prog.', ects: 10, grade: 'A' }},
          {{ name: 'EXPHIL03 Examen philosophicum', ects: 10, grade: 'B' }}
        ],
        nhh: [
          {{ name: 'BED1 Grunnleggende regnskap', ects: 7.5, grade: 'A' }},
          {{ name: 'SAM1 Mikroøkonomi', ects: 7.5, grade: 'B' }},
          {{ name: 'MET1 Matematikk for økonomer', ects: 7.5, grade: 'B' }},
          {{ name: 'SOL1 Strategi og ledelse', ects: 7.5, grade: 'B' }}
        ]
      }};

      var rows = [];
      try {{
        var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (Array.isArray(saved) && saved.length) rows = saved;
      }} catch (e) {{}}
      if (!rows.length) rows = PRESETS.bi.map(function (r) {{ return Object.assign({{}}, r); }});

      var rowsEl = document.getElementById('gpa-rows');
      var targetEl = document.getElementById('gpa-target');
      var remEl = document.getElementById('gpa-rem-ects');

      function letterFor(avg) {{
        if (avg >= 4.5) return 'A';
        if (avg >= 3.5) return 'B';
        if (avg >= 2.5) return 'C';
        if (avg >= 1.5) return 'D';
        return 'E';
      }}

      function save() {{
        try {{ localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); }} catch (e) {{}}
      }}

      function compute() {{
        var weighted = 0, gradedEcts = 0, totalEcts = 0;
        rows.forEach(function (r) {{
          var e = Math.max(0, Number(r.ects) || 0);
          totalEcts += e;
          var p = POINTS[r.grade];
          if (typeof p === 'number' && e > 0) {{
            weighted += p * e;
            gradedEcts += e;
          }}
        }});
        var avg = gradedEcts > 0 ? weighted / gradedEcts : null;
        document.getElementById('gpa-avg').textContent = avg !== null ? avg.toFixed(2) : '—';
        document.getElementById('gpa-letter').textContent = avg !== null ? letterFor(avg) : '—';
        document.getElementById('gpa-credits').textContent = (Math.round(totalEcts * 10) / 10) + ' stp';
        document.getElementById('gpa-us').textContent = avg !== null ? Math.min(4.0, Math.max(0, (avg - 1) * 0.75 + 1.0)).toFixed(2) : '—';

        var out = document.getElementById('gpa-target-out');
        var goal = Number(targetEl.value) || 4.0;
        var rem = Math.max(0, Number(remEl.value) || 0);
        if (avg === null) {{
          out.textContent = 'Legg inn minst ett gradert emne over for å beregne kravet.';
        }} else if (rem <= 0) {{
          out.textContent = avg >= goal ? 'Du har allerede nådd målsnittet på ' + goal.toFixed(2) + '!' : 'Legg inn antall gjenstående studiepoeng for å beregne nødvendig snitt.';
        }} else {{
          var needed = ((goal * (gradedEcts + rem)) - weighted) / rem;
          if (needed > 5.0) {{
            var maxPossible = (weighted + 5 * rem) / (gradedEcts + rem);
            out.innerHTML = 'For <strong>' + goal.toFixed(2) + '</strong> kreves ' + needed.toFixed(2) + ' (over maks 5.0). Med bare A-er på resten (' + rem + ' stp) ender du på <strong>' + maxPossible.toFixed(2) + ' (' + letterFor(maxPossible) + ')</strong>.';
          }} else if (needed <= 1.0) {{
            out.innerHTML = 'Du ligger allerede foran målet! Selv med E (1.0) på resten ender du over <strong>' + goal.toFixed(2) + '</strong>.';
          }} else {{
            out.innerHTML = 'For å nå <strong>' + goal.toFixed(2) + ' (' + letterFor(goal) + ')</strong> totalt må du snitte <strong>' + needed.toFixed(2) + ' (' + letterFor(needed) + ')</strong> på de neste <strong>' + rem + ' stp</strong>.';
          }}
        }}
        save();
      }}

      function render() {{
        rowsEl.innerHTML = '';
        rows.forEach(function (r, idx) {{
          var div = document.createElement('div');
          div.className = 'gpa-row';
          div.innerHTML =
            '<input type="text" value="' + String(r.name || '').replace(/"/g, '&quot;') + '" placeholder="Emnekode / navn" aria-label="Emnenavn">' +
            '<select aria-label="Karakter">' +
              ['A', 'B', 'C', 'D', 'E', 'P'].map(function (g) {{
                var lbl = g === 'P' ? 'Bestått' : g + ' (' + POINTS[g] + ')';
                return '<option value="' + g + '"' + (r.grade === g ? ' selected' : '') + '>' + lbl + '</option>';
              }}).join('') +
            '</select>' +
            '<input type="number" min="0" max="60" step="0.5" value="' + (r.ects ?? 7.5) + '" aria-label="Studiepoeng">' +
            '<button type="button" class="ghost-btn" style="padding:6px 0;text-align:center" aria-label="Fjern emne">×</button>';
          var inputs = div.querySelectorAll('input, select');
          inputs[0].oninput = function () {{ rows[idx].name = this.value; save(); }};
          inputs[1].onchange = function () {{ rows[idx].grade = this.value; compute(); }};
          inputs[2].oninput = function () {{ rows[idx].ects = Number(this.value) || 0; compute(); }};
          div.querySelector('button').onclick = function () {{ rows.splice(idx, 1); render(); compute(); }};
          rowsEl.appendChild(div);
        }});
        compute();
      }}

      document.getElementById('gpa-add-row').onclick = function () {{
        rows.push({{ name: '', ects: 7.5, grade: 'B' }});
        render();
      }};
      document.getElementById('gpa-reset-btn').onclick = function () {{
        rows = [{{ name: '', ects: 7.5, grade: 'B' }}, {{ name: '', ects: 7.5, grade: 'B' }}];
        render();
      }};
      document.getElementById('gpa-copy-btn').onclick = function () {{
        var txt = 'Karaktersnitt (studyos.no/gpa-calculator.html): ' + document.getElementById('gpa-avg').textContent +
          ' (' + document.getElementById('gpa-letter').textContent + ') · ' + document.getElementById('gpa-credits').textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        this.textContent = 'Kopiert ✓';
        var b = this;
        setTimeout(function () {{ b.textContent = 'Kopier oppsummering'; }}, 1800);
      }};
      document.querySelectorAll('[data-preset]').forEach(function (btn) {{
        btn.onclick = function () {{
          var list = PRESETS[this.dataset.preset];
          if (list) {{
            rows = list.map(function (r) {{ return Object.assign({{}}, r); }});
            render();
          }}
        }};
      }});
      targetEl.oninput = compute;
      remEl.oninput = compute;
      render();
    }})();
  </script>
</body>
</html>
"""
    (out_dir / "gpa-calculator.html").write_text(gpa_html, encoding="utf-8")
    sitemap_entries.append((f"{base}/gpa-calculator.html", "0.9", "monthly"))

    # 4. Honest BOFU Comparison & Alternatives Page (`/compare.html`)
    cmp_title = "Study-OS vs Notion, Anki, Quizlet & Exam Portals (2026)"
    cmp_desc = (
        "Honest comparison of Study-OS vs Notion, Anki, Quizlet, Studocu & EnkelEksamen for Canvas LMS, "
        "TimeEdit/TP & WISEflow exam prep — including honest trade-offs."
    )
    cmp_faqs = COMPARE_FAQS
    cmp_faq_html = "".join(
        f"        <details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>\n"
        for q, a in cmp_faqs
    )
    cmp_json_ld = {
        "@context": "https://schema.org",
        "@graph": [
            _breadcrumb_ld(base, [("Study-OS", f"{base}/"), ("Compare", f"{base}/compare.html")]),
            {
                "@type": "WebPage",
                "name": cmp_title,
                "url": f"{base}/compare.html",
                "description": cmp_desc,
                "image": f"{base}/og-image.png",
                "dateModified": today,
                "inLanguage": ["en", "nb"],
                "isPartOf": {"@type": "WebSite", "name": "Study-OS", "url": f"{base}/"},
                "publisher": _publisher_ld(base),
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                    for q, a in cmp_faqs
                ],
            },
        ],
    }

    cmp_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(cmp_desc, quote=True)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <link rel="canonical" href="{base}/compare.html">
  <link rel="alternate" type="text/markdown" href="{base}/compare.md" title="Study-OS Comparison (Markdown)">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Study-OS">
  <meta property="og:locale" content="en_GB">
  <meta property="og:locale:alternate" content="nb_NO">
  <meta property="og:url" content="{base}/compare.html">
  <meta property="og:title" content="{escape(cmp_title, quote=True)}">
  <meta property="og:description" content="{escape(cmp_desc, quote=True)}">
  <meta property="og:image" content="{base}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Study-OS vs Notion, Anki, Quizlet, and Norwegian Exam Portals">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(cmp_title, quote=True)}">
  <meta name="twitter:description" content="{escape(cmp_desc, quote=True)}">
  <meta name="twitter:image" content="{base}/og-image.png">
  <meta name="theme-color" id="meta-theme-color" content="#f3f5f7">
{seo_theme_script}
  <title>{escape(cmp_title)}</title>
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-48.png" sizes="48x48">
  <link rel="icon" type="image/png" href="/pwa/favicon-96.png" sizes="96x96">
  <link rel="icon" type="image/png" href="/pwa/study-os-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/pwa/study-os-192.png">
  <link rel="stylesheet" href="{escape(seo_css_root, quote=True)}">
  <script type="application/ld+json">{json.dumps(cmp_json_ld, ensure_ascii=False)}</script>
</head>
<body>
  <main class="seo-shell">
    <nav class="seo-nav" aria-label="Breadcrumb">
      <div class="seo-cta-row">
        <a href="./" class="ghost-btn">← Open Study-OS</a>
        <a href="./universities.html" class="ghost-btn">Universities</a>
        <a href="./gpa-calculator.html" class="ghost-btn">GPA Calculator</a>
      </div>
      <span class="badge">Honest 2026 Comparison</span>
    </nav>

    <article class="panel seo-hero">
      <span class="eyebrow">Canvas LMS &amp; Exam Prep Alternatives</span>
      <h1>Study-OS vs Notion, Anki, Quizlet &amp; Paid Exam Portals</h1>
      <p class="seo-lead">{escape(cmp_desc)}</p>
      <div class="seo-cta-row">
        <a class="primary-btn btn-lg" href="./">Try Study-OS Free (No Login Needed) →</a>
        <a class="ghost-btn btn-lg" href="./bi-canvas-timeedit-sync.html">Canvas &amp; Timetable Sync</a>
        <a class="ghost-btn btn-lg" href="./wiseflow-practice.html">WISEflow Simulator</a>
      </div>
    </article>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Feature-by-feature breakdown</span>
      <h2>Quick comparison matrix</h2>
      <div class="cmp-wrap">
        <table class="cmp-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Study-OS</th>
              <th>Notion</th>
              <th>Anki</th>
              <th>Quizlet</th>
              <th>Paid NO Exam Portals (Eksamensportalen / EnkelEksamen / Studocu)</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><strong>1-Click Canvas LMS Sync (BI, UiA, UiO, NTNU, *.instructure.com)</strong></td><td class="cmp-yes">Built-in (v{escape(ext_version)})</td><td>Manual / paid plugins</td><td>No</td><td>No</td><td>No</td></tr>
            <tr><td><strong>TimeEdit &amp; Norwegian TP (.ics) Auto-Scheduler</strong></td><td class="cmp-yes">Built-in</td><td>Manual calendar</td><td>No</td><td>No</td><td>No</td></tr>
            <tr><td><strong>WISEflow FLOWmulti (±2% multi-box exam mode)</strong></td><td class="cmp-yes">Built-in</td><td>No</td><td>No</td><td>MCQ only</td><td>Partial / paid</td></tr>
            <tr><td><strong>Instant Split-Screen PDF + In-PDF Search (up to 260 MB local)</strong></td><td class="cmp-yes">Built-in (local)</td><td>5 MB free cap</td><td>Add-ons</td><td>Paid upload</td><td>Blurred / paywalled docs</td></tr>
            <tr><td><strong>FSRS Spaced Repetition</strong></td><td class="cmp-yes">Built-in</td><td>Manual</td><td class="cmp-yes">Gold standard</td><td>Basic (paywalled)</td><td>Limited</td></tr>
            <tr><td><strong>Long-Form Wiki &amp; Group Project Docs</strong></td><td>Basic notes</td><td class="cmp-yes">Best-in-class</td><td>No</td><td>No</td><td>No</td></tr>
            <tr><td><strong>Pre-recorded Norwegian Video Courses</strong></td><td>No</td><td>No</td><td>No</td><td>No</td><td class="cmp-yes">Yes (EnkelEksamen)</td></tr>
            <tr><td><strong>Price for Full Features</strong></td><td class="cmp-yes">100% Free (0 NOK)</td><td>Freemium + AI paid</td><td class="cmp-yes">Free (iOS paid)</td><td>Paywalled modes</td><td>Subscription / per-course fee</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel seo-card" style="margin-bottom:16px">
      <span class="eyebrow">Honest trade-offs</span>
      <h2>When you should pick another tool instead</h2>
      <ul class="seo-topics">
        <li><strong>Use Anki</strong> if you study medicine, languages, or anatomy and need 10,000+ atomic image-occlusion flashcards with heavy mobile-first review.</li>
        <li><strong>Use Notion or Obsidian</strong> as your primary long-form lecture-note wiki, thesis outline, or group-assignment hub (Study-OS pairs nicely with Obsidian notes!).</li>
        <li><strong>Use EnkelEksamen</strong> if you specifically want paid Norwegian video lectures recorded from scratch for a course you missed completely.</li>
        <li><strong>Use Study-OS</strong> when you want your Canvas deadlines, TimeEdit/TP classes, exam-format practice (Economics, Accounting, Finance, Math, Python &amp; OB), WISEflow FLOWmulti drills, instant side-by-side PDFs, and timed study blocks running in one free workspace.</li>
      </ul>
    </section>

    <section style="margin-bottom:16px">
      <h2 style="margin:0 0 6px">Comparison FAQ</h2>
      <div class="seo-faq">
{cmp_faq_html}      </div>
    </section>

    <footer class="seo-foot">
      <span>Study-OS · Independent open-source student workspace.</span>
      <nav aria-label="Footer links">
        <a href="./">App</a>
        <a href="./universities.html">Universities</a>
        <a href="./gpa-calculator.html">GPA Calculator</a>
        <a href="./bi-oslo.html">BI Oslo</a>
        <a href="./norsk.html" lang="nb">Norsk</a>
        <a href="./wiseflow-practice.html">WISEflow</a>
        <a href="./bi-canvas-timeedit-sync.html">Canvas Sync</a>
        <a href="./notes.html">Notes</a>
        <a href="./privacy.html">Privacy</a>
        <a href="./terms.html">Terms</a>
      </nav>
    </footer>
  </main>
</body>
</html>
"""
    (out_dir / "compare.html").write_text(cmp_html, encoding="utf-8")
    sitemap_entries.append((f"{base}/compare.html", "0.85", "monthly"))

    return sitemap_entries
