#!/usr/bin/env bash
# Assembles src/*.js (+ src/index.template.html) into the single index.html
# the project ships. Run this after editing anything under src/ -- index.html
# is a build artifact now, not a hand-edited file.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/compose.mjs
