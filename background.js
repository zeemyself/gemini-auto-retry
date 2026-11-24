// Background Service Worker for Gemini Auto-Retry (Debugger-Free MV3 Engine)

const GEMINI_URL_PATTERN = 'https://gemini.google.com/*';
const WATCHDOG_ALARM_NAME = 'gar-keepalive-watchdog';
const FAST_TICK_MS = 150; // While generating or retrying in a hidden tab
const IDLE_TICK_MS = 1000; // While monitoring an idle hidden tab

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  infiniteRetries: true,
  delaySeconds: 1,
  backgroundKeepAlive: true,
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
    "Could you try again",
    "go against my guidelines"
  ],
  stats: {
    totalRetries: 0,
    successRetries: 0,
    failedRetries: 0
  }
};

// ---- Runtime config cache ----
let runtimeConfig = {
  enabled: DEFAULT_SETTINGS.enabled,
  backgroundKeepAlive: DEFAULT_SETTINGS.backgroundKeepAlive
};
let configReadyPromise = null;

function ensureConfigLoaded() {
  if (!configReadyPromise) {
    configReadyPromise = chrome.storage.local
      .get(['enabled', 'backgroundKeepAlive'])
      .then((res) => {
        runtimeConfig = {
          enabled: res.enabled !== false,
          backgroundKeepAlive: res.backgroundKeepAlive !== false
        };
        return runtimeConfig;
      })
      .catch(() => runtimeConfig);
  }
  return configReadyPromise;
}

function isKeepAliveDesired() {
  return runtimeConfig.enabled && runtimeConfig.backgroundKeepAlive;
}

function isGeminiUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'gemini.google.com';
  } catch (_) {
    return false;
  }
}

// ---- Watchdog Alarm (ensures MV3 Service Worker revives if ever suspended) ----
async function syncWatchdogAlarm() {
  await ensureConfigLoaded();
  try {
    if (isKeepAliveDesired()) {
      const existing = await chrome.alarms.get(WATCHDOG_ALARM_NAME);
      if (!existing) {
        chrome.alarms.create(WATCHDOG_ALARM_NAME, { periodInMinutes: 0.5 });
      }
    } else {
      await chrome.alarms.clear(WATCHDOG_ALARM_NAME);
    }
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === WATCHDOG_ALARM_NAME) {
    syncAllGeminiTabs();
  }
});

// ---- Extension Lifecycle & Settings Sync ----
chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(null);

  const existingPatterns = Array.isArray(existing.customErrorPatterns) ? existing.customErrorPatterns : [];
  const mergedPatterns = Array.from(new Set([...DEFAULT_SETTINGS.customErrorPatterns, ...existingPatterns]));

  // Carry over user's prior debuggerMode preference into backgroundKeepAlive if upgrading
  const inheritedKeepAlive =
    existing.backgroundKeepAlive !== undefined
      ? existing.backgroundKeepAlive !== false
      : existing.debuggerMode !== undefined
        ? existing.debuggerMode !== false
        : DEFAULT_SETTINGS.backgroundKeepAlive;

  const updated = {
    ...existing,
    ...DEFAULT_SETTINGS,
    backgroundKeepAlive: inheritedKeepAlive,
    customErrorPatterns: mergedPatterns,
    stats: existing.stats || DEFAULT_SETTINGS.stats
  };

  delete updated.logs;
  delete updated.autoScroll;
  delete updated.debuggerMode;
  await chrome.storage.local.remove(['logs', 'autoScroll', 'debuggerMode']);

  await chrome.storage.local.set(updated);
  runtimeConfig = {
    enabled: updated.enabled !== false,
    backgroundKeepAlive: updated.backgroundKeepAlive !== false
  };
  configReadyPromise = Promise.resolve(runtimeConfig);

  console.log(`[Auto-Retry Extension] Initialized/updated settings (reason: ${details?.reason}).`);
  await syncWatchdogAlarm();
  await syncAllGeminiTabs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let configChanged = false;

  if (changes.enabled) {
    runtimeConfig.enabled = changes.enabled.newValue !== false;
    configChanged = true;
  }
  if (changes.backgroundKeepAlive) {
    runtimeConfig.backgroundKeepAlive = changes.backgroundKeepAlive.newValue !== false;
    configChanged = true;
  }

  if (configChanged) {
    configReadyPromise = Promise.resolve(runtimeConfig);
    syncWatchdogAlarm();
    syncAllGeminiTabs();
  }
});

// ---- Message Handling ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'UPDATE_BADGE') {
    updateBadge(message.text, message.color);
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'INCREMENT_STATS') {
    handleIncrementStats(message.status).then(() => sendResponse({ status: 'ok' }));
    return true;
  }

  if (message.type === 'GET_KEEPALIVE_STATUS') {
    getKeepAliveStatus().then(sendResponse);
    return true;
  }

  if (message.type === 'SYNC_KEEPALIVE') {
    syncAllGeminiTabs()
      .then(() => getKeepAliveStatus())
      .then(sendResponse);
    return true;
  }

  return false;
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

// ---- Adaptive Background Heartbeat & Browser-Level Visibility Tracking ----
const heartbeatPorts = new Map();
// tabId -> {
//   port,
//   browserHidden: boolean,
//   contentHidden: boolean,
//   hidden: boolean,
//   busy: boolean,
//   webLockActive: boolean,
//   webrtcActive: boolean,
//   lastTickAt: number
// }
let heartbeatTimer = null;
let heartbeatIntervalMs = 0;

async function isTabBackgrounded(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return true;
    const win = await chrome.windows.get(tab.windowId);
    return win.state === 'minimized' || !win.focused;
  } catch (_) {
    return false;
  }
}

function pushBgState(tabId) {
  const entry = heartbeatPorts.get(tabId);
  if (!entry) return;
  try {
    entry.port.postMessage({
      type: 'BG_STATE',
      hidden: Boolean(entry.hidden && isKeepAliveDesired()),
      keepAliveEnabled: isKeepAliveDesired()
    });
  } catch (_) {}
}

async function refreshTabBackgroundState(tabId) {
  const entry = heartbeatPorts.get(tabId);
  if (!entry) return;

  const browserHidden = await isTabBackgrounded(tabId);
  if (heartbeatPorts.get(tabId) !== entry) return;

  entry.browserHidden = browserHidden;
  entry.hidden = entry.browserHidden || entry.contentHidden;

  const shouldProtectFromDiscard = isKeepAliveDesired() && (entry.hidden || entry.busy);
  setDiscardable(tabId, !shouldProtectFromDiscard);

  pushBgState(tabId);
  syncHeartbeatTimer();
}

async function syncAllTabBackgroundStates() {
  const tabIds = Array.from(heartbeatPorts.keys());
  await Promise.all(tabIds.map((tabId) => refreshTabBackgroundState(tabId)));
}

async function syncAllGeminiTabs() {
  await ensureConfigLoaded();
  await syncAllTabBackgroundStates();

  // Also ensure any open Gemini tabs without a port yet have autoDiscardable synced
  try {
    const geminiTabs = await chrome.tabs.query({ url: GEMINI_URL_PATTERN });
    const protect = isKeepAliveDesired();
    for (const tab of geminiTabs) {
      if (typeof tab.id !== 'number') continue;
      if (!heartbeatPorts.has(tab.id)) {
        setDiscardable(tab.id, !protect);
      }
    }
  } catch (_) {}
}

async function getKeepAliveStatus() {
  await ensureConfigLoaded();
  let geminiTabs = [];
  try {
    geminiTabs = await chrome.tabs.query({ url: GEMINI_URL_PATTERN });
  } catch (_) {}

  const geminiTabIds = new Set(geminiTabs.map((t) => t.id).filter((id) => typeof id === 'number'));
  let connectedCount = 0;
  let hiddenCount = 0;
  let busyCount = 0;
  let protectedCount = 0;

  for (const tabId of geminiTabIds) {
    const entry = heartbeatPorts.get(tabId);
    if (!entry) continue;
    connectedCount++;
    if (entry.hidden) hiddenCount++;
    if (entry.busy) busyCount++;
    if (entry.webLockActive || entry.webrtcActive) protectedCount++;
  }

  return {
    enabled: runtimeConfig.enabled,
    backgroundKeepAlive: runtimeConfig.backgroundKeepAlive,
    geminiTabCount: geminiTabIds.size,
    connectedCount,
    hiddenCount,
    busyCount,
    protectedCount
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'heartbeat' || !port.sender?.tab?.id) return;
  const tabId = port.sender.tab.id;
  const entry = {
    port,
    browserHidden: false,
    contentHidden: false,
    hidden: false,
    busy: false,
    webLockActive: false,
    webrtcActive: false,
    lastTickAt: 0
  };
  heartbeatPorts.set(tabId, entry);

  ensureConfigLoaded().then(() => {
    refreshTabBackgroundState(tabId);
  });

  port.onMessage.addListener((msg) => {
    const current = heartbeatPorts.get(tabId);
    if (!current || current.port !== port || !msg) return;

    if (msg.type === 'START' || msg.type === 'STOP') {
      current.contentHidden = msg.type === 'START';
      current.hidden = current.browserHidden || current.contentHidden;
      const shouldProtect = isKeepAliveDesired() && (current.hidden || current.busy);
      setDiscardable(tabId, !shouldProtect);
      pushBgState(tabId);
      syncHeartbeatTimer();
    } else if (msg.type === 'ACTIVITY') {
      current.busy = Boolean(msg.busy);
      current.webLockActive = Boolean(msg.webLock);
      current.webrtcActive = Boolean(msg.webrtc);
      const shouldProtect = isKeepAliveDesired() && (current.hidden || current.busy);
      setDiscardable(tabId, !shouldProtect);
      syncHeartbeatTimer();
    }
    // Receiving 'PONG' or any message resets Chrome's 30s MV3 Service Worker idle timer.
  });

  port.onDisconnect.addListener(() => {
    const current = heartbeatPorts.get(tabId);
    if (current && current.port === port) {
      heartbeatPorts.delete(tabId);
      setDiscardable(tabId, true);
    }
    syncHeartbeatTimer();
  });
});

function syncHeartbeatTimer() {
  if (!isKeepAliveDesired()) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      heartbeatIntervalMs = 0;
    }
    return;
  }

  let anyHidden = false;
  let anyHiddenBusy = false;
  for (const entry of heartbeatPorts.values()) {
    if (entry.hidden) {
      anyHidden = true;
      if (entry.busy) anyHiddenBusy = true;
    }
  }

  const desiredInterval = !anyHidden ? 0 : anyHiddenBusy ? FAST_TICK_MS : IDLE_TICK_MS;
  if (desiredInterval === heartbeatIntervalMs) return;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatIntervalMs = desiredInterval;

  if (desiredInterval > 0) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of heartbeatPorts.values()) {
        if (!entry.hidden) continue;
        const minGap = entry.busy ? FAST_TICK_MS - 20 : IDLE_TICK_MS - 50;
        if (now - entry.lastTickAt < minGap) continue;
        entry.lastTickAt = now;
        try {
          entry.port.postMessage({ type: 'TICK', busy: entry.busy });
        } catch (_) {}
      }
    }, desiredInterval);
  }
}

// ---- Tab & Window Listeners ----
chrome.tabs.onActivated.addListener(() => {
  syncAllTabBackgroundStates();
});

chrome.windows.onFocusChanged.addListener(() => {
  syncAllTabBackgroundStates();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (!url) return;
  if (isGeminiUrl(url) && changeInfo.status === 'complete') {
    refreshTabBackgroundState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  heartbeatPorts.delete(tabId);
  syncHeartbeatTimer();
});

function setDiscardable(tabId, value) {
  chrome.tabs.update(tabId, { autoDiscardable: value }).catch(() => {});
}

function updateBadge(text, color = '#4F46E5') {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

// Initialize watchdog & tab states on Service Worker startup
syncWatchdogAlarm();
syncAllGeminiTabs();
