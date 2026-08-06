# Gemini Auto-Retry Chrome Extension

A Manifest V3 Chrome Extension designed to automatically capture user prompts and retry submitting them whenever Google Gemini encounters errors, rate limits, or network timeouts.

## Features

- **Automatic Error Detection**: Scans page content and DOM mutations for error phrases or native "Retry" / "Regenerate" buttons.
- **Prompt Auto-Capture**: Automatically captures your submitted prompt upon clicking send or pressing Enter.
- **In-Page Floating Widget**: Shows a status panel with live countdown timer, attempt count, and immediate "Retry Now" / "Cancel" controls.
- **Customizable Error Triggers**: Manage and add custom error text phrases or trigger patterns directly from the extension popup.
- **Smart Delays & Backoff**: Adjust initial delay (seconds), max retry attempts, and toggle exponential backoff on repeated failures.
- **Activity & Analytics Log**: Live activity log showing recent retry events, timestamps, platforms, and success rates.

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
- [`background.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/background.js) — Background service worker for logging and badge updates
- [`content.js`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.js) — Content script monitoring DOM & handling prompt auto-retry
- [`content.css`](file:///Users/zeemyself/Projects/gemini-auto-retry/content.css) — Floating in-page widget UI styles
- [`icons/`](file:///Users/zeemyself/Projects/gemini-auto-retry/icons) — Extension icon set (16x16, 32x32, 48x48, 128x128)
