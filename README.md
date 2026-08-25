# talk-app

Minimal Discord/TeamSpeak-style chat + voice app. Pure JS, no native dependencies, no database — text history is persisted to a local JSON file.

## Stack

- **Backend:** Node.js, Express, Socket.IO (`server.js`)
- **Frontend:** static HTML/CSS/JS (`public/`), no build step
- **Voice:** WebRTC peer-to-peer mesh, signaled over the same Socket.IO connection, with a public TURN relay (openrelay.metered.ca) alongside STUN so peers behind restrictive NATs can still connect

## Features

- Text channels (`#general`, `#random`) with persisted history
- Live presence list
- Voice channel: click **Join Voice** to open a mic-to-mic mesh call with everyone else in voice
- Red "speaking" indicator on the voice button, driven by real-time Web Audio volume analysis
- Settings modal: choose input microphone, adjust output volume (saved per-browser)

## Running locally

```bash
npm install
node server.js
```

Open `http://localhost:3000`. Voice requires a secure context — `localhost` and `127.0.0.1` work over plain HTTP for this; any other host needs HTTPS (e.g. via a tunnel) for microphone access to be granted.

## Android

A thin WebView shell wrapping this app lives in `android/`. See [android/README.md](android/README.md) for build instructions. It points at a `SERVER_URL` that must be reachable from the device.
