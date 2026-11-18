#!/usr/bin/env python3
"""Package local teaching materials for the browser library. Requires cryptography."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
from zipfile import ZipFile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
from server import StudyStore  # noqa: E402
from dlpfc import classify_intrinsic_dlpfc  # noqa: E402

COURSES = ("econ-2522", "acct-2527", "math-2588", "ob-2537", "prog-3021")
FORMATS = {
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ipynb": "application/x-ipynb+json",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
PRIVATE_NAME = re.compile(
    r"shad|macbook|student.list|attendance|gradebook|midtermeval|"
    r"eba\s*1180[2356]res|submissions|contact.list|participant|customer|complaint", re.I
)
IDENTIFIER = re.compile(
    rb"github_pat_[A-Za-z0-9_]{35,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    rb"|canvas_session[=\x22][A-Za-z0-9.%_\-]{30,}|(?:07shadjosef|shadjosef688)@gmail\.com", re.I
)


def access_key(path: Path, rotate: bool) -> bytes:
    if path.exists() and not rotate:
        token = path.read_text(encoding="ascii").strip()
        if re.fullmatch(r"sos1_[A-Za-z0-9_-]{43}", token):
            return base64.urlsafe_b64decode(token[5:] + "=")
        raise ValueError("Invalid key file. Use a generated Study-OS access string.")
    key = secrets.token_bytes(32)
    token = "sos1_" + base64.urlsafe_b64encode(key).decode().rstrip("=")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if rotate else os.O_EXCL), 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as output:
        output.write(token + "\n")
    path.chmod(0o600)
    return key


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def inside(root: Path, name: str) -> Path | None:
    path = (root / name).resolve()
    return path if root in path.parents and path.is_file() else None


def title_for(path: Path) -> str:
    return re.sub(r"^\d+--", "", path.name)


def section_for(path: Path, is_book: bool) -> str:
    if is_book:
        return "Books"
    if re.search(r"exam|marking|guideline|term\s*paper|course\s*paper|20\d\d[hv].*eba", path.stem, re.I):
        return "Exams and marking guides"
    if path.suffix.lower() == ".csv":
        return "Datasets"
    if re.search(r"assignment|exercise|tutor|problem|solution|practice", path.stem, re.I):
        return "Exercises and tutoring"
    return "Lectures and course materials"


def safe_payload(path: Path) -> bytes | None:
    if PRIVATE_NAME.search(path.name) or path.suffix.lower() not in FORMATS:
        return None
    if path.stat().st_size > 100_000_000:
        return None
    value = path.read_bytes()
    if not value or IDENTIFIER.search(value):
        return None
    if path.suffix.lower() == ".ipynb":
        note = json.loads(value)
        for cell in note.get("cells", []):
            cell["metadata"] = {}
            if cell.get("cell_type") == "code":
                cell["execution_count"] = None
                cell["outputs"] = []
        note["metadata"] = {}
        value = json_bytes(note)
    if path.suffix.lower() == ".csv":
        header = value.split(b"\n", 1)[0]
        if re.search(rb"(?:full.?name|email|phone|personnummer|home_address)", header, re.I):
            return None
    return value


def extras_by_course(extra_files: list[str]) -> dict[str, list[Path]]:
    extras = {cid: [] for cid in COURSES}
    for arg in extra_files:
        cid, path = arg.split("=", 1)
        extras[cid].append(Path(path).expanduser().resolve(strict=True))
    return extras


def package(study_os: Path, canvas: Path, vault: Path, out: Path, key: bytes,
            extras: dict[str, list[Path]]) -> None:
    cipher = AESGCM(key)
    store = StudyStore(ROOT, study_os / "data")
    seen: dict[bytes, str] = {}
    metadata = {"format": 1, "courses": {}}
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_suffix(".partial")
    try:
        with ZipFile(temporary, "w") as bundle:
            def add(value: bytes) -> str:
                digest = hashlib.sha256(value).digest()
                if digest not in seen:
                    ident = secrets.token_hex(18)
                    nonce = secrets.token_bytes(12)
                    ciphertext = cipher.encrypt(nonce, value, ident.encode("ascii"))
                    bundle.writestr(f"{ident}.enc", nonce + ciphertext)
                    seen[digest] = ident
                return seen[digest]

            def material(path: Path) -> dict | None:
                value = safe_payload(path)
                if value is None:
                    return None
                return {"id": add(value), "title": title_for(path), "mime": FORMATS[path.suffix.lower()]}

            for cid in COURSES:
                bank = store.load_course_bank(cid)
                if not bank:
                    raise ValueError(f"Missing course bank for {cid}")
                canvas_id = bank["canvasId"]
                course_dir, = canvas.glob(f"*--{canvas_id}")
                source_files = {}
                documents = {}
                for category in ("Files", "Books"):
                    for path in sorted((course_dir / category).glob("*")):
                        if not path.is_file() or not inside(course_dir, str(path)):
                            continue
                        document = material(path)
                        if document:
                            document["section"] = section_for(path, category == "Books")
                            documents.setdefault(document["id"], document)
                            source_files[path.resolve()] = document
                for path in extras[cid]:
                    document = material(path)
                    if document:
                        document["section"] = section_for(path, False)
                        documents.setdefault(document["id"], document)

                mapped = {}
                for source_id, source in bank.get("sources", {}).items():
                    ref = source.get("canvasPath") or source.get("vaultPath")
                    source_root = canvas if source.get("canvasPath") else vault
                    path = inside(source_root, ref) if ref else None
                    if path:
                        doc = source_files.get(path)
                        if doc is None:
                            # Do not pull unrelated Vault notes or private files referenced by a bank.
                            if canvas in path.parents:
                                doc = material(path)
                        if doc:
                            mapped[source_id] = {**doc, "title": source.get("title") or doc["title"]}
                bank["sources"] = mapped

                assets = {}
                course_root = store.courses_dir / cid
                for question in bank["questions"]:
                    for field in ("promptAssets", "contextAssets", "solutionAssets"):
                        for asset in question.get(field, []):
                            rel = asset.get("src") if isinstance(asset, dict) else asset
                            if not rel or rel in assets:
                                continue
                            path = inside(course_root, rel)
                            if path:
                                doc = material(path)
                                if doc:
                                    assets[rel] = doc
                serialized = json_bytes(bank)
                if IDENTIFIER.search(serialized):
                    raise ValueError(f"A private identifier was found in bank {cid}")
                questions = [q for q in bank["questions"] if q.get("available", True)]
                tiers = [q.get("dlpfcBase") or classify_intrinsic_dlpfc(q)[0] for q in questions]
                metadata["courses"][cid] = {
                    "bank": add(serialized),
                    "assets": assets,
                    "documents": sorted(documents.values(), key=lambda d: (d["section"], d["title"].lower())),
                    "catalog": {
                        "topics": bank.get("topics", []),
                        "collections": bank.get("collections", []),
                        "questionCount": len(questions),
                        "mcqCount": sum(q["kind"] == "mcq" for q in questions),
                        "writtenOrCalcCount": sum(q["kind"] != "mcq" for q in questions),
                        "flowmultiCount": sum(bool(q.get("wiseflowFields")) for q in questions),
                        "hardCount": sum(q.get("difficulty", 2) == 3 for q in questions),
                        "highDlpfcCount": tiers.count(3),
                        "medDlpfcCount": tiers.count(2),
                        "lowDlpfcCount": tiers.count(1),
                    },
                }
                print(f"{cid}: {len(questions)} questions, {len(documents)} documents, {len(assets)} figures")
            bundle.writestr("index.json", json_bytes({"format": 1, "manifest": add(json_bytes(metadata))}))
        if temporary.stat().st_size > 900_000_000:
            raise ValueError("Encrypted archive exceeds 900 MB. Reduce the selection for Pages.")
        temporary.replace(out)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Encrypted archive: {out} ({out.stat().st_size:,} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["study-os", "canvas", "vault", "output", "key-file"]:
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--extra", action="append", default=[], help="Optional course-id=/path/to/material")
    parser.add_argument("--rotate-key", action="store_true", help="Generate a replacement access string")
    args = parser.parse_args()
    key = access_key(args.key_file, args.rotate_key)
    package(args.study_os.resolve(), args.canvas.resolve(), args.vault.resolve(), args.output,
            key, extras_by_course(args.extra))


if __name__ == "__main__":
    main()
