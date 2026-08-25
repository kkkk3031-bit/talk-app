#!/usr/bin/env bash
# Rebuilds the Android app, bumps its version, and republishes the APK +
# version manifest that the app's self-update check (MainActivity.java,
# checkForUpdate()) polls on every launch. Run this after any change under
# android/ — the app on a device with the auto-updater already installed
# will pick it up on its next open, no manual reinstall needed.
set -euo pipefail
cd "$(dirname "$0")"

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/home/dev/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties

GRADLE="${GRADLE_BIN:-/home/dev/.local/gradle/gradle-8.5/bin/gradle}"
BUILD_GRADLE="app/build.gradle"

current_code=$(grep -oP 'versionCode \K\d+' "$BUILD_GRADLE")
next_code=$((current_code + 1))
next_name="1.$((next_code - 1))"

echo "==> Bumping versionCode $current_code -> $next_code (versionName $next_name)"
sed -i "s/versionCode $current_code/versionCode $next_code/" "$BUILD_GRADLE"
sed -i "s/versionName \"[^\"]*\"/versionName \"$next_name\"/" "$BUILD_GRADLE"

echo "==> Building debug APK"
"$GRADLE" assembleDebug

APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
APK_DST="../public/talkapp.apk"
cp "$APK_SRC" "$APK_DST"

echo "{\"versionCode\": $next_code, \"versionName\": \"$next_name\", \"url\": \"/talkapp.apk\"}" > ../public/apk-version.json

echo "==> Verifying built APK metadata"
"$ANDROID_SDK_ROOT"/build-tools/*/aapt dump badging "$APK_DST" 2>/dev/null | head -1

echo "==> Published: versionCode=$next_code versionName=$next_name -> public/talkapp.apk"
echo "    (server serves this from disk immediately, no server restart needed)"
