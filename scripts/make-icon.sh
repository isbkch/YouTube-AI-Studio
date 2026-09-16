#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
trap 'rm -rf "$(dirname "$ICONSET")"' EXIT
swift "$WTS_REPO_ROOT/scripts/make-icon.swift" "$ICONSET"
mkdir -p "$WTS_REPO_ROOT/apps/macos/Resources"
iconutil -c icns "$ICONSET" -o "$WTS_REPO_ROOT/apps/macos/Resources/AppIcon.icns"
