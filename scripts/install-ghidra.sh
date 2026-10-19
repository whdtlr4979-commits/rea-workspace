#!/usr/bin/env bash
# Installs headless Ghidra for REA's native analysis provider.
# REA accepts Ghidra 12.1.x only and needs a JDK 21 (java + javac) on PATH.
set -euo pipefail

GHIDRA_VERSION=12.1.4
GHIDRA_BUILD_DATE=20260921
GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
INSTALL_ROOT=/opt
GHIDRA_DIR="$INSTALL_ROOT/ghidra_${GHIDRA_VERSION}_PUBLIC"

if [ -x "$GHIDRA_DIR/support/analyzeHeadless" ]; then
  echo "Ghidra $GHIDRA_VERSION already installed at $GHIDRA_DIR"
else
  if ! command -v javac >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq openjdk-21-jdk-headless
  fi
  zip="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD_DATE}.zip"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 4 -o "$tmp/$zip" \
    "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/$zip"
  echo "$GHIDRA_SHA256  $tmp/$zip" | sha256sum -c -
  unzip -q "$tmp/$zip" -d "$INSTALL_ROOT"
fi

# REA finds Ghidra through ghidraRun on PATH (resolved via its real path),
# so no GHIDRA_INSTALL_DIR export is needed.
ln -sf "$GHIDRA_DIR/ghidraRun" /usr/local/bin/ghidraRun
echo "Ghidra ready: $(readlink -f /usr/local/bin/ghidraRun)"
