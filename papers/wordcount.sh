#!/usr/bin/env bash
# SoftwareX running-word count (target <= 3000: abstract + body + captions + headers; excludes
# title/authors/refs/metadata table). Uses texcount if available, else a rough node fallback.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TEX="$DIR/softwarex/main.tex"

if command -v texcount >/dev/null 2>&1; then
  echo "== texcount (SoftwareX) =="
  texcount -inc -sum -q "$TEX" | sed -n '1,40p'
  echo
  echo "Use the sum of: Words in text + headers + captions (refs and the metadata tabular are excluded)."
else
  echo "texcount not found — rough fallback (strips commands; over-counts slightly):"
  node --input-type=module <<EOF
import { readFileSync } from 'node:fs';
let s = readFileSync('$TEX','utf8');
s = s.split('\\\\begin{document}')[1].split('\\\\bibliographystyle')[0];   // body only
s = s.replace(/%[^\n]*/g,' ').replace(/\\\\[A-Za-z]+(\[[^\]]*\])?(\{[^{}]*\})?/g,' ').replace(/[{}\$&]/g,' ');
const words = s.split(/\s+/).filter(w=>/[A-Za-z]/.test(w));
console.log('approx running words:', words.length, '(target <= 3000)');
EOF
fi
echo
echo "Figure count (SoftwareX, must be <= 6):"
grep -c '\\begin{figure}' "$TEX" || true
