#!/usr/bin/env python3
"""Package tools/study-os-vscode/ into a spec-compliant .vsix archive (zero external deps)."""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PKG = json.loads((HERE / "package.json").read_text(encoding="utf-8"))


def _xa(val: str) -> str:
    return xml_escape(str(val or ""), {'"': "&quot;", "'": "&apos;"})


CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
"""

CATEGORIES = ",".join(PKG.get("categories") or ["Education", "Notebooks", "Other"])
KEYWORDS = ",".join(PKG.get("keywords") or [])
ICON_FILE = str(PKG.get("icon") or "").strip()
HAS_ICON = bool(ICON_FILE and (HERE / ICON_FILE).is_file())
HAS_LICENSE = (HERE / "LICENSE").is_file()

EXTRA_ASSETS = []
if HAS_LICENSE:
    EXTRA_ASSETS.append('    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>')
if HAS_ICON:
    EXTRA_ASSETS.append(f'    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{_xa(ICON_FILE)}" Addressable="true"/>')

PROPERTIES = [
    f'      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{_xa((PKG.get("engines") or {}).get("vscode", "^1.80.0"))}"/>',
    f'      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{_xa((PKG.get("repository") or {}).get("url", "https://github.com/shadjosef/study-os.git"))}"/>',
    f'      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{_xa(PKG.get("homepage", "https://studyos.no"))}"/>',
]
if (PKG.get("bugs") or {}).get("url"):
    PROPERTIES.append(f'      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{_xa(PKG["bugs"]["url"])}"/>')
if (PKG.get("galleryBanner") or {}).get("color"):
    PROPERTIES.append(f'      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="{_xa(PKG["galleryBanner"]["color"])}"/>')
if (PKG.get("galleryBanner") or {}).get("theme"):
    PROPERTIES.append(f'      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="{_xa(PKG["galleryBanner"]["theme"])}"/>')

MANIFEST_XML = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{_xa(PKG['name'])}" Version="{_xa(PKG['version'])}" Publisher="{_xa(PKG['publisher'])}"/>
    <DisplayName>{xml_escape(PKG['displayName'])}</DisplayName>
    <Description xml:space="preserve">{xml_escape(PKG['description'])}</Description>
    <Tags>{xml_escape(KEYWORDS)}</Tags>
    <Categories>{xml_escape(CATEGORIES)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
{chr(10).join(PROPERTIES)}
    </Properties>
{f'    <Icon>extension/{_xa(ICON_FILE)}</Icon>' if HAS_ICON else ''}
{f'    <License>extension/LICENSE</License>' if HAS_LICENSE else ''}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
{chr(10).join(EXTRA_ASSETS)}
  </Assets>
</PackageManifest>
"""


def build_vsix(out_path: Path) -> None:
    # Self-verify well-formed XML so malformed manifests can never be shipped.
    ET.fromstring(CONTENT_TYPES_XML)
    ET.fromstring(MANIFEST_XML)

    files = ["package.json", "extension.js", "README.md"]
    if HAS_LICENSE:
        files.append("LICENSE")
    if HAS_ICON:
        files.append(ICON_FILE)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        zf.writestr("extension.vsixmanifest", MANIFEST_XML)
        for fname in files:
            zf.write(HERE / fname, arcname=f"extension/{fname}")
    print(f"Built {out_path} ({out_path.stat().st_size} bytes, v{PKG['version']}, XML validated)")


if __name__ == "__main__":
    build_vsix(ROOT / "app" / "public" / "downloads" / "study-os-companion.vsix")
