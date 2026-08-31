---
name: web-demo-recorder
description: Record a human-like product walkthrough of a website into an MP4 video for promotion (X/Twitter, docs, sales). Uses playwright-core + full Chromium (headed) with realistic typing/scroll/pause timing, detects Cloudflare/Turnstile challenge pages, converts webm to mp4 with system ffmpeg, and extracts a verification frame. Triggers: record demo video, 录屏, 录演示视频, 产品演示视频, product walkthrough video, screen recording of the site, make a promo video.
agent_created: true
---

# Web Demo Recorder

## Overview

Record a human-like walkthrough of a website into an MP4 video suitable for X/Twitter promotion, docs, or sales demos. The browser operates like a human: real typing delay, smooth scrolling, natural pauses, Apply-fix click. Output is a clean video (no mouse cursor noise, no window chrome).

## When to use

- User asks to record a demo / promo video of the site ("录屏", "录演示视频", "record demo", "product walkthrough")
- User wants a video to post on X / social media, or embed in docs/sales material

## Steps

### 1. Run the recorder

```bash
node skills/web-demo-recorder/scripts/record-demo.mjs \
  --url http://localhost:8787 \
  --domain example.com \
  --out /Users/david/WorkBuddy/2026-08-30-11-52-18/demo-recording
```

Flags:
- `--url` - site to record. **Prefer the LOCAL dev server** (`wrangler dev`), see the Cloudflare note below
- `--domain` - domain to type into the scan box
- `--out` - output dir (webm + mp4 + verify frame saved here)
- `--width/--height` - viewport size, default 1280x800

The script automatically:
- Discovers full Chromium (Google Chrome for Testing under ms-playwright cache) - **never use the headless shell for recording** (Cloudflare flags it immediately)
- Records with realistic human timing (90ms typing delay, smooth wheels, pauses)
- Runs the walkthrough: blank page -> open site -> hold on landing (brand) -> scroll -> type domain -> scan -> report -> scroll findings -> Apply fix -> back to top. **No language toggle** - demos stay in English (project convention).
- Detects Cloudflare/Turnstile challenge pages and reports clearly
- Converts the newest webm to `demo.mp4` using **system ffmpeg** and extracts `verify-1s.png`

### 2. Verify content

Read `verify-1s.png` (or extract frames at key timestamps) to confirm the video captured real page content, not a challenge page. Optionally extract more frames for the user:

```bash
/opt/homebrew/bin/ffmpeg -y -ss 10 -i demo.mp4 -frames:v 1 frame-10s.png
```

### 3. Deliver

Present the mp4 (and a few key frames) to the user with `present_files`. For X promotion, suggest linking the live site in the caption.

## Critical environment knowledge

- **Cloudflare Turnstile blocks ALL automated browsers** - even headed full Chromium with a real UA. If the target site is behind Cloudflare (e.g. toolfront.dev), the recorded video will be ~100% challenge page. Do NOT waste a recording on it; record the local dev server instead (identical code, no challenge) and tell the user to link the live URL in the caption.
- **playwright-core** lives at `/Users/david/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs` (load via dynamic `import(pathToFileURL(...))`; NODE_PATH does not work for ESM).
- **Chromium**: use the FULL `chromium-1228/.../Google Chrome for Testing.app` build, `headless: false` (headed). The headless shell (`chromium_headless_shell-*`) is detected as a bot.
- **ffmpeg**: use SYSTEM ffmpeg (`/opt/homebrew/bin/ffmpeg`). The playwright-bundled ffmpeg (`ffmpeg-mac`) cannot mux mp4 (`Unrecognized option 'movflags'` / `Error initializing the muxer`).
- Video specs: 1280x800, ~28s for the full walkthrough, h264/yuv420p (X-compatible). Add `-movflags +faststart` for web playback.

## Relationship to other flows

- Complements `precommit-ui-regression` (same environment discovery pattern)
- The 28s full-walkthrough is X-optimal; for a longer cut (mobile view, more interactions), ask the user to record with their own browser (they have the cf_clearance cookie) - provide the human-readable action list from this skill's Steps section
