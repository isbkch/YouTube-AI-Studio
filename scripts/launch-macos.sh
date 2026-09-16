#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$WTS_REPO_ROOT/scripts/build-macos.sh"
if [ -d "/Applications/WinTheCloud Studio.app" ]; then
	open -n "/Applications/WinTheCloud Studio.app" --args "$@"
else
	open -n "$WTS_REPO_ROOT/dist/WinTheCloud Studio.app" --args "$@"
fi
