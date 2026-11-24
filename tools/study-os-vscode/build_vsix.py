#!/usr/bin/env python3
"""Package tools/study-os-vscode/ into a spec-compliant .vsix archive (zero external deps)."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PKG = json.loads((HERE / "package.json").read_text(encoding="utf-8"))

CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""

MANIFEST_XML = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{PKG['name']}" Version="{PKG['version']}" Publisher="{PKG['publisher']}"/>
    <DisplayName>{PKG['displayName']}</DisplayName>
    <Description xml:space="preserve">{PKG['description']}</Description>
    <Categories>Education,Notebooks,Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
"""


def build_vsix(out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        zf.writestr("extension.vsixmanifest", MANIFEST_XML)
        for fname in ("package.json", "extension.js", "README.md"):
            zf.write(HERE / fname, arcname=f"extension/{fname}")
    print(f"Built {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    build_vsix(ROOT / "app" / "public" / "downloads" / "study-os-companion.vsix")
