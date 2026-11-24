# Gemini Auto-Retry Chrome Extension

A Manifest V3 Chrome Extension designed to automatically capture user prompts and retry submitting them whenever Google Gemini encounters errors, refusals, rate limits, or network timeouts.

## Features

- **Turn-Scoped Error Detection**: Scans only the latest Gemini response turn and active alert banners (never false-triggering on older chat history or user prompts) once streaming completes.
- **Prompt Auto-Capture**: Automatically captures your submitted prompt upon clicking send or pressing Enter.
- **In-Page Floating Widget**: Shows a status panel with live countdown timer, attempt count, and immediate "Retry Now" / "Cancel" controls.
- **Customizable Error Triggers**: Manage and add custom error text phrases or trigger patterns directly from the extension popup.
- **Smart Delays & Guaranteed Cooldown Wakeup**: Configurable retry delay and max/infinite attempts, with automatic wakeup if an error arrives during cooldown.
- **Debugger-Free Background Tab Retries**: Keeps hidden Gemini tabs rendering and retrying reliably **without** `chrome.debugger` banners or DevTools conflicts:
  - **Native Blink Scheduler Exemptions**: Holds a lightweight `WebLock` (preventing Chrome Energy Saver / Tab Freezing at 0% CPU) and spins up a demand-driven in-memory loopback `RTCPeerConnection` data channel while hidden (disabling Chrome's 10s/60s Intensive Wake Up Throttling with zero audio or permissions).
  - **Complete Hidden-Tab Shims**: Unthrottled short `setTimeout` / `setInterval` scheduler, `MessageChannel`-driven `requestAnimationFrame` catch-up bursts, finite CSS/Web Animation settling, `IntersectionObserver` / `ResizeObserver` fallbacks, and `blur` / `focusout` protection for Angular Material menus.
  - **Adaptive MV3 Heartbeat + `chrome.alarms` Watchdog**: Runs fast `150ms` ticks during active background streaming/retries, drops to `1000ms` while idle-hidden, and uses `0` ticks when foregrounded.
  - See [background.md](./background.md) for a deep dive into the Chromium & Gemini background-tab bottlenecks and how v2.0.0 solves them.

## How to Install in Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `gemini-auto-retry` repository/project folder you downloaded or cloned.
5. Refresh any already-open `gemini.google.com` tabs once so the `document_start` script activates.

## Extension Files

- [`manifest.json`](file:///Users/zeemyself/Projects/gemini-auto-retry/manifest.json) — Extension Manifest V3 configuration (no `debugger` permission)
- [`popup.html`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.html) — Modern dark-mode extension popup interface
- [`popup.css`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.css) — Popup styling & design tokens
- [`popup.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.js) — Popup logic, live keep-alive status & storage sync
- [`background.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/background.js) — Background service worker driving adaptive heartbeat ticks, `chrome.alarms` watchdog, tab discard protection, stats, and badge updates
- [`page-visibility.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/page-visibility.js) — Page-world (`MAIN`) script providing visibility/blur protection, unthrottled short timers, `rAF` bursts, animation settling, observer fallbacks, and stream-lifecycle tracking
- [`content.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.js) — Content script managing `WebLocks`/loopback `WebRTC` exemptions, turn-scoped error detection, and W3C pointer/mouse retry clicks
- [`content.css`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.css) — Floating in-page widget UI styles
- [`background.md`](./background.md) — Deep dive into background-tab bottlenecks & v2.0.0 architecture
- [`icons/`](file:///Users/zeemyself/Projects/gemini-auto-retry/icons) — Extension icon set (16x16, 32x32, 48x48, 128x128)
