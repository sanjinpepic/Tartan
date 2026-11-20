#!/usr/bin/env bash
# Builds Tartan for iPhone, unsigned, as build/Tartan-<version>.ipa: SideStore or AltStore signs it
# with your own Apple ID when it installs it (free; it runs for 7 days, then they refresh it).
# Runs on a Mac with Xcode 26 or newer (Codemagic or GitHub Actions; there's no Mac here).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
CODE=$(node -p "require('./package.json').versionCode")
bun install --frozen-lockfile
bun run build:web
npx cap sync ios
# Capacitor writes its package for the app's iOS 26 target but marks it Swift tools 5.9, which
# doesn't know iOS 26 ("'v26' is unavailable"); 6.2 does (Xcode 26).
sed -i '' 's|^// swift-tools-version: 5.9|// swift-tools-version: 6.2|' ios/App/CapApp-SPM/Package.swift
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$CODE" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build | tail -n 40
rm -rf Payload && mkdir Payload && cp -R build/Build/Products/Release-iphoneos/App.app Payload/
mkdir -p ../../build && rm -f "../../build/Tartan-$VERSION.ipa"
zip -qry "../../build/Tartan-$VERSION.ipa" Payload && rm -rf Payload
echo "Built build/Tartan-$VERSION.ipa"
