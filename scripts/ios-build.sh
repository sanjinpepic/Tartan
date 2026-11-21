#!/usr/bin/env bash
# Builds Tartan for iPhone, unsigned, as build/Tartan-<version>.ipa: SideStore or AltStore signs it
# with your own Apple ID when it installs it (free; it runs for 7 days, then they refresh it).
# Runs on a Mac with Xcode 26 or newer (Codemagic or GitHub Actions; there's no Mac here).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
CODE=$(node -p "require('./package.json').versionCode")
./scripts/ios-prepare.sh
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$CODE" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build | tail -n 40
rm -rf Payload && mkdir Payload && cp -R build/Build/Products/Release-iphoneos/App.app Payload/
mkdir -p ../../build && rm -f "../../build/Tartan-$VERSION.ipa" "../../build/Tartan-$VERSION-health.ipa"
# Two builds. Tartan-<version>.ipa is unsigned, as it always was: it installs with any Apple ID.
zip -qry "../../build/Tartan-$VERSION.ipa" Payload
echo "Built build/Tartan-$VERSION.ipa"
# Tartan-<version>-health.ipa is signed ad hoc with the app's entitlements (App/App.entitlements:
# Apple Health), so SideStore or AltStore asks for Apple Health when it signs it. Whether a free
# Apple ID may have that isn't sure, so it's a separate download to try: if it won't install,
# the plain one still does (and Apple Health then says it isn't allowed).
if codesign --force --deep --sign - Payload/App.app && codesign --force --sign - --entitlements App/App.entitlements --generate-entitlement-der Payload/App.app \
  && codesign -d --entitlements - Payload/App.app 2>/dev/null | grep -q healthkit; then
  zip -qry "../../build/Tartan-$VERSION-health.ipa" Payload
  echo "Built build/Tartan-$VERSION-health.ipa, signed ad hoc with Apple Health."
else
  echo "Couldn't sign it ad hoc: no Apple Health build this time."
fi
rm -rf Payload
