#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT="../study-os-sync-v${VERSION}-clean.zip"
rm -f "$OUT"
zip -r "$OUT" . \
  -x ".git/*" \
  -x "node_modules/*" \
  -x ".env" \
  -x "*.map" \
  -x "CHROMEWEBSTORE.md" \
  -x "README.md" \
  -x ".DS_Store" \
  -x "Thumbs.db" \
  -x "*.sh" \
  -x "*.zip" \
  -x "store-assets/*"
echo "Clean CWS package created: $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT"
