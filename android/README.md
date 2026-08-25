# talk-app-android

A thin Android WebView shell around [talk-app](https://github.com/khaledq84ever/talk-app) — loads the web chat/voice app full-screen and grants it microphone access for voice calls.

## How it works

`MainActivity` is a single `WebView` pointed at `SERVER_URL` (in `MainActivity.java`), with JavaScript, DOM storage, and mic permission grants enabled so the web app's WebRTC voice works inside the app.

## Requirements

- `SERVER_URL` must point at a running instance of `talk-app`'s backend.
- Voice (`getUserMedia`) requires a secure context: HTTPS, or `10.0.2.2`/`localhost` for local emulator testing against a server on the host machine. A plain `http://` URL to anything else will load the chat UI but silently fail to grant microphone access.

## Building

No Gradle wrapper is checked in — build with a local Gradle install:

```bash
gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Requires Android SDK with `compileSdk 34`, `minSdk 26`, and Gradle 8.5+.
