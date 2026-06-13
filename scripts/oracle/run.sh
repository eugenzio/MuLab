#!/usr/bin/env bash
# Regenerate the Phase 2 reference fixtures using the pinned 3.12 venv.
# Usage: bash scripts/oracle/run.sh   (from the repo root)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -x "$HERE/.venv/bin/python" ]; then
  echo "venv missing. Create it first:"
  echo "  python3.12 -m venv scripts/oracle/.venv"
  echo "  scripts/oracle/.venv/bin/pip install -r scripts/oracle/requirements.txt"
  exit 1
fi

"$HERE/.venv/bin/python" "$HERE/make_fixtures.py"
