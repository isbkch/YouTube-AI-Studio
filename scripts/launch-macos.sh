#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$WTS_REPO_ROOT/scripts/build-macos.sh"
if [ -d "/Applications/yt-ai-studio.app" ]; then
	open -n "/Applications/yt-ai-studio.app" --args "$@"
else
	open -n "$WTS_REPO_ROOT/dist/yt-ai-studio.app" --args "$@"
fi
