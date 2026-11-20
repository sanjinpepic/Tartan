#!/usr/bin/env bash
# The steps every iPhone build shares (scripts/ios-build.sh, .github/workflows/ios-screens.yml):
# the public web bundle into the app, Capacitor's sync, and Capacitor's package marked Swift tools
# 6.2, which knows iOS 26 (Capacitor writes 5.9: "'v26' is unavailable"). On a Mac with Xcode 26+.
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bun run build:web:public
npx cap sync ios
sed -i '' 's|^// swift-tools-version: 5.9|// swift-tools-version: 6.2|' ios/App/CapApp-SPM/Package.swift
