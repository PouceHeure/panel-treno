#!/bin/sh
# One command for a new export: rebuilds the report and the tables from it, restamps the assets, runs the tests.
#   scripts/update-model.sh path/to/export.json
set -e
[ -n "$1" ] || { echo "usage: scripts/update-model.sh path/to/export.json"; exit 2; }
cd "$(dirname "$0")/.."
python3 scripts/evaluate.py "$1"
python3 scripts/stamp-assets.py
node --test tests/*.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
python3 -m unittest discover -s tests -p "test_*.py" 2>&1 | tail -3
echo "done: review with git diff --stat data/, then commit"
