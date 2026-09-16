#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$WTS_REPO_ROOT/scripts/build-macos.sh"
open "$WTS_REPO_ROOT/dist/WinTheCloud Studio.app"
