#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$WTS_REPO_ROOT/scripts/build-macos.sh"
if [ -d "/Applications/YouTube-AI-Studio.app" ]; then
	open -n "/Applications/YouTube-AI-Studio.app" --args "$@"
else
	open -n "$WTS_REPO_ROOT/dist/YouTube-AI-Studio.app" --args "$@"
fi
