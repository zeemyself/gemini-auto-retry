# Gemini Auto-Retry Chrome Extension

A Manifest V3 Chrome Extension designed to automatically capture user prompts and retry submitting them whenever Google Gemini encounters errors, rate limits, or network timeouts.

## Features

- **Automatic Error Detection**: Scans page content and DOM mutations for error phrases or native "Retry" / "Regenerate" buttons.
- **Prompt Auto-Capture**: Automatically captures your submitted prompt upon clicking send or pressing Enter.
- **In-Page Floating Widget**: Shows a status panel with live countdown timer, attempt count, and immediate "Retry Now" / "Cancel" controls.
- **Customizable Error Triggers**: Manage and add custom error text phrases or trigger patterns directly from the extension popup.
- **Smart Delays**: Adjust retry delay (seconds) and max retry attempts.
- **Low CPU & Memory Usage**: Optimized lightweight DOM observation and event-driven status badges.
- **Reliable Background Tab Retries (Chrome Debugger Mode)**: Uses `chrome.debugger` (CDP) to enable Blink focus emulation (`Emulation.setFocusEmulationEnabled`), keep background page lifecycle active (`Page.setWebLifecycleState`), override idle detection (`Emulation.setIdleOverride`), prevent tab discarding, and dispatch trusted mouse clicks (`Input.dispatchMouseEvent`) — backed by a hybrid service-worker heartbeat and `requestAnimationFrame` fallback shim.

## Personal Use / Chrome Debugging Banner

Because this extension uses the `debugger` permission for reliable background focus emulation, Chrome displays a `"Gemini Auto-Retry" started debugging this browser` infobar while attached to a Gemini tab:

- Clicking **Cancel** on the infobar cleanly pauses debugger attachment without re-attaching in a loop; you can click **Re-attach** in the extension popup whenever you want to resume.
- Opening DevTools (`F12` / Inspect) on a Gemini tab temporarily detaches the extension debugger (falling back to the page-visibility shim). To inspect extension logs without detaching Gemini, open the Service Worker console from `chrome://extensions`.
- *(Optional)* To suppress Chrome's debugging infobar completely for personal use, launch Chrome with `--silent-debugger-extension-api`.

## How to Install in Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `gemini-auto-retry` repository/project folder you downloaded or cloned.
5. The extension **Gemini Auto-Retry** icon will appear in your Chrome toolbar!

## Extension Files

- [`manifest.json`](file:///Users/zeemyself/Projects/gemini-auto-retry/manifest.json) — Extension Manifest V3 configuration
- [`popup.html`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.html) — Modern dark-mode extension popup interface
- [`popup.css`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.css) — Popup styling & design tokens
- [`popup.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/popup.js) — Popup logic, setting handlers & storage sync
- [`background.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/background.js) — Background service worker managing `chrome.debugger` focus emulation, CDP trusted clicks, true background-tab state tracking, heartbeat, stats, and badge updates
- [`page-visibility.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/page-visibility.js) — Page-world script that keeps Gemini rendering while its tab is hidden
- [`content.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.js) — Content script monitoring DOM & handling prompt auto-retry
- [`content.css`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.css) — Floating in-page widget UI styles
- [`icons/`](file:///Users/zeemyself/Projects/gemini-auto-retry/icons) — Extension icon set (16x16, 32x32, 48x48, 128x128)
