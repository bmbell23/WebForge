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

# #149: refuse to publish an APK under a version it doesn't contain.
#
# The endpoint (releases/version.txt) and the artifact beside it MUST agree, or
# the phone downloads, installs, finds itself no newer, and re-prompts on every
# launch — forever. That shipped twice: #106 (the APK was never rebuilt) and
# #149 (assembleDebug reported UP-TO-DATE because the version had been bumped
# after the last Android build). Two different mistakes, one outcome, so this is
# a gate rather than a note to be careful.
#
# The version is read out of the built APK with aapt2 — never from build.gradle
# or version.txt, since a stale artifact is precisely what's being caught and
# both of those would cheerfully report the number we hoped was in there.
echo "🔎 Verifying the APK actually contains $VERSION"
PUBLISHED="$REPO_ROOT/releases/webforge.apk"
if ! STAGED_VERSION=$(node "$REPO_ROOT/scripts/apkversion.js" check "$SRC" "$VERSION" "$PUBLISHED"); then
    echo
    echo "   Nothing was staged. Re-run with --clean if the build keeps no-op'ing."
    exit 1
fi
APK_VERSION="${STAGED_VERSION%% *}"
echo "   APK reports $STAGED_VERSION — matches version.txt"

mkdir -p "$REPO_ROOT/releases"
cp "$SRC" "$REPO_ROOT/releases/webforge.apk"
# Written from the APK's own versionName, not copied from version.txt: the two
# can then never disagree by construction, only by the check above failing first.
printf '%s\n' "$APK_VERSION" > "$REPO_ROOT/releases/version.txt"

SIZE=$(stat -c%s "$REPO_ROOT/releases/webforge.apk")
echo
echo "✅ Staged: releases/webforge.apk ($SIZE bytes) + releases/version.txt ($APK_VERSION)"
echo "   Served at: http://100.69.184.113:8012/webforge.apk (once the release container is up)"
echo "   First-time install:  adb install releases/webforge.apk"
echo "   (or browse to the URL above on the phone and open the download)"
