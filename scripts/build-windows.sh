#!/bin/bash
# Build the WebForge Windows NSIS installer (cross-built on Linux via
# electron-builder) and stage it + latest.yml into releases/windows/, which
# the webforge_releases nginx container serves at
# http://100.69.184.113:8012/windows/. Installed apps (electron-updater,
# generic provider) poll latest.yml there and auto-download newer versions.
#
# Usage:  ./scripts/build-windows.sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/windows"

VERSION="$(cat "$REPO_ROOT/version.txt")"
echo "🔨 Building WebForge Windows installer (version: $VERSION)"

npm install
# version.txt is the single source of truth. It's injected into the build with
# electron-builder's extraMetadata rather than by rewriting package.json —
# `npm version` left the repo permanently dirty after every build, and that
# stray change got swept into the NEXT ticket's commit.

# electron-builder needs wine to stamp Windows exe metadata; wine isn't
# installed on this host, so the build step runs in the official
# electronuserland/builder:wine image (node_modules is host-installed and
# linux-x64 either way; electron/NSIS downloads are cached on the host).
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
docker run --rm \
    -v "$REPO_ROOT:/project" \
    -v "$HOME/.cache/electron:/root/.cache/electron" \
    -v "$HOME/.cache/electron-builder:/root/.cache/electron-builder" \
    -w /project/windows \
    electronuserland/builder:wine \
    /bin/bash -c "npx electron-builder --win nsis -c.extraMetadata.version=$VERSION"
# The container runs as root — hand the outputs back to the host user.
docker run --rm -v "$REPO_ROOT:/project" alpine \
    chown -R "$(id -u):$(id -g)" /project/windows/dist

EXE="dist/WebForge Setup $VERSION.exe"
if [ ! -f "$EXE" ]; then
    echo "❌ Build finished but installer not found at $EXE"
    ls -la dist/ || true
    exit 1
fi

mkdir -p "$REPO_ROOT/releases/windows"
cp "$EXE" dist/latest.yml "$REPO_ROOT/releases/windows/"
cp "dist/WebForge Setup $VERSION.exe.blockmap" "$REPO_ROOT/releases/windows/" 2>/dev/null || true

SIZE=$(stat -c%s "$REPO_ROOT/releases/windows/WebForge Setup $VERSION.exe")
echo
echo "✅ Staged: releases/windows/WebForge Setup $VERSION.exe ($SIZE bytes) + latest.yml"
echo "   First-time install: download http://100.69.184.113:8012/windows/WebForge%20Setup%20$VERSION.exe"
echo "   Installed apps auto-update from http://100.69.184.113:8012/windows/latest.yml"
