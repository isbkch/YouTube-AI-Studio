#!/usr/bin/env bash
set -euo pipefail
WTS_QA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WTS_QA_ENV="${WTS_ALIGNMENT_ENV:-$HOME/Library/Caches/YouTube-AI-Studio/transcription-venv}"
mkdir -p "$(dirname "$WTS_QA_ENV")"
uv venv --python 3.12 --allow-existing "$WTS_QA_ENV"
uv pip install --python "$WTS_QA_ENV/bin/python" -r "$WTS_QA_ROOT/scripts/transcription-requirements.txt"
"$WTS_QA_ENV/bin/python" "$WTS_QA_ROOT/scripts/transcription-audio.py" --probe
