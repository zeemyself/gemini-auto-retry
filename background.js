// Background Service Worker for AI Prompt Auto-Retry Extension

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  infiniteRetries: true,
  delaySeconds: 1,
  customErrorPatterns: [
    "Please try again",
    "Rate limit exceeded",
    "Too many requests",
    "An error occurred",
    "Failed to generate",
    "Network error",
    "Capacity reached",
    "Quota exceeded",
    "Internal error",
    "Service unavailable",
    "Generation stopped",
    "I can't depict",
    "I can't generate",
    "I can't create",
    "I can't change the outfit",
    "I cannot modify",
    "I cannot change",
    "I can't modify",
    "I cannot fulfill this request",
    "that depict minors",
    "encountering an error",
    "try your request again",
    "with something else instead",
    "Could you try again"
  ],
  stats: {
    totalRetries: 0,
    successRetries: 0,
    failedRetries: 0
  }
};

// Initialize/update settings on extension install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(null);
  
  // Merge DEFAULT_SETTINGS error patterns with any custom user-added patterns
  const existingPatterns = Array.isArray(existing.customErrorPatterns) ? existing.customErrorPatterns : [];
  const mergedPatterns = Array.from(new Set([...DEFAULT_SETTINGS.customErrorPatterns, ...existingPatterns]));
  
  // DEFAULT_SETTINGS takes precedence on install/update, while preserving stats and user patterns
  const updated = {
    ...existing,
    ...DEFAULT_SETTINGS,
    customErrorPatterns: mergedPatterns,
    stats: existing.stats || DEFAULT_SETTINGS.stats
  };
  
  // Clean up legacy keys if present
  delete updated.logs;
  delete updated.autoScroll;
  await chrome.storage.local.remove(['logs', 'autoScroll']);
  
  await chrome.storage.local.set(updated);
  console.log(`[Auto-Retry Extension] Initialized/updated settings (reason: ${details?.reason}).`);
});

// Handle incoming messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_BADGE') {
    updateBadge(message.text, message.color);
    sendResponse({ status: 'ok' });
  } else if (message.type === 'INCREMENT_STATS') {
    handleIncrementStats(message.status);
    sendResponse({ status: 'ok' });
  }
  return true;
});

async function handleIncrementStats(status) {
  const data = await chrome.storage.local.get('stats');
  const stats = data.stats || { totalRetries: 0, successRetries: 0, failedRetries: 0 };
  stats.totalRetries += 1;
  if (status === 'success') {
    stats.successRetries += 1;
  } else if (status === 'failed') {
    stats.failedRetries += 1;
  }
  await chrome.storage.local.set({ stats });
}

// ---- Background heartbeat ----
// Hidden tabs have their timers throttled (down to once per minute) and their
// rendering paused. The service worker is not throttled, so it drives a 1s tick
// into every hidden Gemini tab over a long-lived port. Each tick lets the content
// script scan for errors, fire due retries, and flush Gemini's pending frames.
const heartbeatPorts = new Map(); // tabId -> { port, active }
let heartbeatTimer = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'heartbeat' || !port.sender?.tab?.id) return;
  const tabId = port.sender.tab.id;
  heartbeatPorts.set(tabId, { port, active: false });

  port.onMessage.addListener((msg) => {
    const entry = heartbeatPorts.get(tabId);
    if (!entry || entry.port !== port) return;
    if (msg.type === 'START' && !entry.active) {
      entry.active = true;
      setDiscardable(tabId, false);
    } else if (msg.type === 'STOP' && entry.active) {
      entry.active = false;
      setDiscardable(tabId, true);
    }
    // 'PONG' needs no handling: receiving it resets the service worker idle timer.
    syncHeartbeatTimer();
  });

  port.onDisconnect.addListener(() => {
    const entry = heartbeatPorts.get(tabId);
    if (entry && entry.port === port) {
      heartbeatPorts.delete(tabId);
      if (entry.active) setDiscardable(tabId, true);
    }
    syncHeartbeatTimer();
  });
});

function syncHeartbeatTimer() {
  const anyActive = [...heartbeatPorts.values()].some((e) => e.active);
  if (anyActive && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const { port, active } of heartbeatPorts.values()) {
        if (!active) continue;
        try {
          port.postMessage({ type: 'TICK' });
        } catch (_) {}
      }
    }, 500);
  } else if (!anyActive && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function setDiscardable(tabId, value) {
  chrome.tabs.update(tabId, { autoDiscardable: value }).catch(() => {});
}

function updateBadge(text, color = '#4F46E5') {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

