#!/bin/bash
# Build the WebForge debug APK and stage it (plus version.txt) into releases/,
# which the webforge_releases nginx container serves on :8012. Installed apps
# poll http://100.69.184.113:8012/version.txt and pull /webforge.apk when it's
# newer — in-place upgrade, no uninstall (debug builds share the same
# ~/.android/debug.keystore signing key, so Android treats it as an upgrade).
#
# Usage:  ./scripts/build-apk.sh           # build + stage
#         ./scripts/build-apk.sh --clean   # gradle clean first
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/android"

VERSION="$(cat "$REPO_ROOT/version.txt" 2>/dev/null || echo unknown)"
echo "🔨 Building WebForge debug APK (version: $VERSION)"

# #61: the About page content is shared with the Windows app — stage it into
# APK assets so both platforms render identical documentation.
ASSETS="$REPO_ROOT/android/app/src/main/assets"
mkdir -p "$ASSETS"
cp "$REPO_ROOT/shared/about.json" "$ASSETS/about.json"
# #121: the new-tab page is shared with the Windows app — one copy, in shared/.
cp "$REPO_ROOT/shared/newtab.html" "$ASSETS/newtab.html"
echo "📄 Staged shared/about.json + shared/newtab.html -> assets/"

if [ "$1" = "--clean" ]; then
    ./gradlew clean
fi

./gradlew assembleDebug

SRC="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$SRC" ]; then
    echo "❌ Build succeeded but APK not found at $SRC"
    exit 1
fi

mkdir -p "$REPO_ROOT/releases"
cp "$SRC" "$REPO_ROOT/releases/webforge.apk"
cp "$REPO_ROOT/version.txt" "$REPO_ROOT/releases/version.txt"

SIZE=$(stat -c%s "$REPO_ROOT/releases/webforge.apk")
echo
echo "✅ Staged: releases/webforge.apk ($SIZE bytes) + releases/version.txt ($VERSION)"
echo "   Served at: http://100.69.184.113:8012/webforge.apk (once the release container is up)"
echo "   First-time install:  adb install releases/webforge.apk"
echo "   (or browse to the URL above on the phone and open the download)"
