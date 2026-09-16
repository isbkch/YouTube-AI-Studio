#!/usr/bin/env bash
set -euo pipefail
WTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WTS_REPO_ROOT"
swift build --package-path apps/macos -c release
WTS_APP="$WTS_REPO_ROOT/dist/WinTheCloud Studio.app"
mkdir -p "$WTS_APP/Contents/MacOS" "$WTS_APP/Contents/Resources"
cp apps/macos/.build/release/WinTheCloudStudio "$WTS_APP/Contents/MacOS/WinTheCloudStudio"
python3 - "$WTS_APP" "$WTS_REPO_ROOT" <<'PY'
import plistlib,sys
with open(sys.argv[1]+'/Contents/Info.plist','wb') as f:
 plistlib.dump({'CFBundleName':'WinTheCloud Studio','CFBundleDisplayName':'WinTheCloud Studio','CFBundleIdentifier':'com.winthecloud.studio','CFBundleExecutable':'WinTheCloudStudio','CFBundleIconFile':'AppIcon','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','CFBundleVersion':'1','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,'WTSRuntimeRoot':sys.argv[2]},f)
PY
cp "$WTS_REPO_ROOT/apps/macos/Resources/AppIcon.icns" "$WTS_APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$WTS_APP"

WTS_INSTALLED_APP="/Applications/WinTheCloud Studio.app"
if ! rsync -a --delete "$WTS_APP/" "$WTS_INSTALLED_APP/"; then
	echo "error: could not write to /Applications. Re-run manually with sudo:" >&2
	echo "  sudo rsync -a --delete \"$WTS_APP/\" \"$WTS_INSTALLED_APP/\"" >&2
	exit 1
fi
codesign --force --sign - "$WTS_INSTALLED_APP" >/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$WTS_INSTALLED_APP" >/dev/null 2>&1 || true
/usr/bin/printf '%s\n' "$WTS_APP" "$WTS_INSTALLED_APP"
