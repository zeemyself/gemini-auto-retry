// Background Service Worker for AI Prompt Auto-Retry Extension

const GEMINI_URL_PATTERN = 'https://gemini.google.com/*';
const CDP_PROTOCOL_VERSION = '1.3';
const LIFECYCLE_REFRESH_INTERVAL_MS = 30000;

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  infiniteRetries: true,
  delaySeconds: 1,
  debuggerMode: true,
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

// ---- Runtime config cache ----
let runtimeConfig = {
  enabled: DEFAULT_SETTINGS.enabled,
  debuggerMode: DEFAULT_SETTINGS.debuggerMode
};
let configReadyPromise = null;

function ensureConfigLoaded() {
  if (!configReadyPromise) {
    configReadyPromise = chrome.storage.local
      .get(['enabled', 'debuggerMode'])
      .then((res) => {
        runtimeConfig = {
          enabled: res.enabled !== false,
          debuggerMode: res.debuggerMode !== false
        };
        return runtimeConfig;
      })
      .catch(() => runtimeConfig);
  }
  return configReadyPromise;
}

function isDebuggerDesired() {
  return runtimeConfig.enabled && runtimeConfig.debuggerMode;
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

// ---- Debugger Manager (CDP Focus Emulation, Lifecycle, Idle Override & Trusted Clicks) ----
const attachedTabs = new Set();          // tabIds currently attached by this extension
const attachInFlight = new Map();        // tabId -> Promise<boolean>
const userCanceledTabs = new Set();      // tabIds where user clicked "Cancel" on debugger banner
const devtoolsDetachedTabs = new Set();  // tabIds detached because Chrome DevTools opened
const lastLifecycleRefresh = new Map();  // tabId -> last Page.setWebLifecycleState timestamp

function sendCdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function sendCdpSafe(tabId, method, params = {}) {
  try {
    await sendCdp(tabId, method, params);
    return true;
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn(`[Auto-Retry][CDP] ${method} failed on tab ${tabId}: ${msg}`);
    return false;
  }
}

async function isAttachedBySelf(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    return targets.some(
      (t) => t.tabId === tabId && t.attached && t.extensionId === chrome.runtime.id
    );
  } catch (_) {
    return false;
  }
}

async function applyEmulation(tabId) {
  if (!attachedTabs.has(tabId)) return false;

  // Enable Page domain for navigation events & lifecycle commands
  await sendCdpSafe(tabId, 'Page.enable');

  // Force Blink FocusController (and visibility) to treat tab as actively focused
  const focusOk = await sendCdpSafe(tabId, 'Emulation.setFocusEmulationEnabled', {
    enabled: true
  });

  // Prevent Chromium Energy Saver / Background Tab Freezing from freezing the tab
  await sendCdpSafe(tabId, 'Page.setWebLifecycleState', { state: 'active' });

  // Prevent IdleDetector / idle-aware throttling while away from tab or machine
  await sendCdpSafe(tabId, 'Emulation.setIdleOverride', {
    isUserActive: true,
    isScreenUnlocked: true
  });

  lastLifecycleRefresh.set(tabId, Date.now());
  setDiscardable(tabId, false);

  if (focusOk) {
    console.log(`[Auto-Retry][CDP] Emulation applied on tab ${tabId} (focus + lifecycle + idle).`);
  }
  return focusOk;
}

async function attachDebugger(tabId, { force = false } = {}) {
  if (typeof tabId !== 'number') return false;
  await ensureConfigLoaded();

  if (!isDebuggerDesired()) return false;
  if (!force && userCanceledTabs.has(tabId)) return false;

  if (force) {
    userCanceledTabs.delete(tabId);
    devtoolsDetachedTabs.delete(tabId);
  }

  if (attachedTabs.has(tabId)) {
    if (force) await applyEmulation(tabId);
    return true;
  }

  if (attachInFlight.has(tabId)) {
    return attachInFlight.get(tabId);
  }

  const task = (async () => {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return false;
    }
    if (!tab || !isGeminiUrl(tab.url)) return false;

    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    } catch (err) {
      const msg = err?.message || String(err);
      if (await isAttachedBySelf(tabId)) {
        // Already attached by this extension (e.g. after service worker wake-up)
      } else if (/another debugger is already attached/i.test(msg)) {
        devtoolsDetachedTabs.add(tabId);
        return false;
      } else {
        console.warn(`[Auto-Retry][CDP] Failed to attach to tab ${tabId}: ${msg}`);
        return false;
      }
    }

    attachedTabs.add(tabId);
    userCanceledTabs.delete(tabId);
    devtoolsDetachedTabs.delete(tabId);
    await applyEmulation(tabId);
    pushBgState(tabId);
    return true;
  })().finally(() => {
    attachInFlight.delete(tabId);
  });

  attachInFlight.set(tabId, task);
  return task;
}

async function detachDebugger(tabId) {
  if (typeof tabId !== 'number') return;

  const inflight = attachInFlight.get(tabId);
  if (inflight) {
    try {
      await inflight;
    } catch (_) {}
  }

  const wasAttached = attachedTabs.has(tabId) || (await isAttachedBySelf(tabId));
  if (wasAttached) {
    await sendCdpSafe(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    await sendCdpSafe(tabId, 'Emulation.clearIdleOverride');
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {}
  }

  attachedTabs.delete(tabId);
  lastLifecycleRefresh.delete(tabId);

  const entry = heartbeatPorts.get(tabId);
  if (!entry || !entry.active) {
    setDiscardable(tabId, true);
  }
  pushBgState(tabId);
}

async function dispatchTrustedClick(tabId, x, y) {
  if (typeof tabId !== 'number' || !attachedTabs.has(tabId)) {
    return { ok: false, reason: 'not_attached' };
  }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: 'invalid_coordinates' };
  }

  try {
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0
    });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    console.log(`[Auto-Retry][CDP] Trusted click dispatched on tab ${tabId} at (${Math.round(x)}, ${Math.round(y)}).`);
    return { ok: true };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn(`[Auto-Retry][CDP] Trusted click failed on tab ${tabId}: ${msg}`);
    return { ok: false, reason: msg };
  }
}

async function syncAllGeminiTabs({ force = false } = {}) {
  await ensureConfigLoaded();

  if (force) {
    userCanceledTabs.clear();
    devtoolsDetachedTabs.clear();
  }

  // Reconcile targets already attached by this extension (survives SW restarts)
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
      if (!target.attached || target.extensionId !== chrome.runtime.id || typeof target.tabId !== 'number') {
        continue;
      }
      if (!isDebuggerDesired() || !isGeminiUrl(target.url)) {
        await detachDebugger(target.tabId);
      } else {
        attachedTabs.add(target.tabId);
        await applyEmulation(target.tabId);
      }
    }
  } catch (_) {}

  let geminiTabs = [];
  try {
    geminiTabs = await chrome.tabs.query({ url: GEMINI_URL_PATTERN });
  } catch (_) {}

  if (isDebuggerDesired()) {
    for (const tab of geminiTabs) {
      if (typeof tab.id !== 'number') continue;
      if (!force && (userCanceledTabs.has(tab.id) || devtoolsDetachedTabs.has(tab.id))) {
        continue;
      }
      await attachDebugger(tab.id, { force });
    }
  } else {
    for (const tabId of Array.from(attachedTabs)) {
      await detachDebugger(tabId);
    }
  }

  await syncAllTabBackgroundStates();
}

async function getDebuggerStatus() {
  await ensureConfigLoaded();
  let geminiTabs = [];
  try {
    geminiTabs = await chrome.tabs.query({ url: GEMINI_URL_PATTERN });
  } catch (_) {}

  const geminiTabIds = new Set(geminiTabs.map((t) => t.id).filter((id) => typeof id === 'number'));
  let attachedCount = 0;
  let canceledCount = 0;
  let devtoolsCount = 0;

  for (const tabId of geminiTabIds) {
    if (attachedTabs.has(tabId)) attachedCount++;
    else if (userCanceledTabs.has(tabId)) canceledCount++;
    else if (devtoolsDetachedTabs.has(tabId)) devtoolsCount++;
  }

  return {
    enabled: runtimeConfig.enabled,
    debuggerMode: runtimeConfig.debuggerMode,
    geminiTabCount: geminiTabIds.size,
    attachedCount,
    canceledCount,
    devtoolsCount
  };
}

// Re-apply emulation after top-level navigations or full reloads
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (typeof tabId !== 'number' || !attachedTabs.has(tabId)) return;

  if (
    (method === 'Page.frameNavigated' && !params?.frame?.parentId) ||
    method === 'Page.loadEventFired'
  ) {
    applyEmulation(tabId);
  }
});

// Track debugger detachment cleanly (never loop-reattach on user cancel or DevTools open)
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source?.tabId;
  if (typeof tabId !== 'number') return;

  attachedTabs.delete(tabId);
  lastLifecycleRefresh.delete(tabId);
  console.log(`[Auto-Retry][CDP] Detached from tab ${tabId} (reason: ${reason}).`);

  if (reason === 'canceled_by_user') {
    userCanceledTabs.add(tabId);
  } else if (reason === 'replaced_with_devtools') {
    devtoolsDetachedTabs.add(tabId);
  } else if (reason === 'target_closed') {
    userCanceledTabs.delete(tabId);
    devtoolsDetachedTabs.delete(tabId);
  }

  const entry = heartbeatPorts.get(tabId);
  if (!entry || !entry.active) {
    setDiscardable(tabId, true);
  }
  pushBgState(tabId);
});

// ---- Extension Lifecycle & Settings Sync ----
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
  runtimeConfig = {
    enabled: updated.enabled !== false,
    debuggerMode: updated.debuggerMode !== false
  };
  configReadyPromise = Promise.resolve(runtimeConfig);

  console.log(`[Auto-Retry Extension] Initialized/updated settings (reason: ${details?.reason}).`);
  await syncAllGeminiTabs({ force: true });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let debuggerSettingChanged = false;

  if (changes.enabled) {
    runtimeConfig.enabled = changes.enabled.newValue !== false;
    debuggerSettingChanged = true;
  }
  if (changes.debuggerMode) {
    runtimeConfig.debuggerMode = changes.debuggerMode.newValue !== false;
    debuggerSettingChanged = true;
  }

  if (debuggerSettingChanged) {
    configReadyPromise = Promise.resolve(runtimeConfig);
    if (isDebuggerDesired()) {
      // Explicitly re-enabling clears previous user cancel / DevTools pause flags
      syncAllGeminiTabs({ force: true });
    } else {
      syncAllGeminiTabs();
    }
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

  if (message.type === 'CDP_CLICK') {
    const tabId = sender?.tab?.id;
    dispatchTrustedClick(tabId, message.x, message.y).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_DEBUGGER_STATUS') {
    getDebuggerStatus().then(sendResponse);
    return true;
  }

  if (message.type === 'REATTACH_DEBUGGER') {
    syncAllGeminiTabs({ force: true })
      .then(() => getDebuggerStatus())
      .then(sendResponse);
    return true;
  }

  if (message.type === 'SYNC_DEBUGGER') {
    syncAllGeminiTabs()
      .then(() => getDebuggerStatus())
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

// ---- Background Heartbeat & Browser-Level Background State Tracking ----
// Note: Once Emulation.setFocusEmulationEnabled(true) is active, Blink reports
// document.hidden === false even to the content script. Therefore the service
// worker tracks each Gemini tab's TRUE background state using Chrome's tab and
// window APIs (tab.active, window.state, window.focused) and drives the 500ms
// heartbeat directly.
const heartbeatPorts = new Map(); // tabId -> { port, browserHidden, contentHidden, active }
let heartbeatTimer = null;

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
      hidden: entry.active,
      debuggerAttached: attachedTabs.has(tabId)
    });
  } catch (_) {}
}

async function refreshTabBackgroundState(tabId) {
  const entry = heartbeatPorts.get(tabId);
  if (!entry) return;

  const wasBackgrounded = entry.browserHidden;
  const browserHidden = await isTabBackgrounded(tabId);
  // Port might have disconnected while awaiting tab/window info
  if (heartbeatPorts.get(tabId) !== entry) return;

  entry.browserHidden = browserHidden;
  entry.active = entry.browserHidden || entry.contentHidden;

  // Keep non-discardable whenever backgrounded OR debugger-attached
  setDiscardable(tabId, !(entry.active || attachedTabs.has(tabId)));

  // If the tab just went into background after DevTools previously detached us,
  // try once to re-attach (succeeds seamlessly if DevTools was closed; silently no-ops if still open)
  if (
    browserHidden &&
    !wasBackgrounded &&
    devtoolsDetachedTabs.has(tabId) &&
    !userCanceledTabs.has(tabId) &&
    isDebuggerDesired()
  ) {
    await attachDebugger(tabId);
  }

  pushBgState(tabId);
  syncHeartbeatTimer();
}

async function syncAllTabBackgroundStates() {
  const tabIds = Array.from(heartbeatPorts.keys());
  await Promise.all(tabIds.map((tabId) => refreshTabBackgroundState(tabId)));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'heartbeat' || !port.sender?.tab?.id) return;
  const tabId = port.sender.tab.id;
  const entry = {
    port,
    browserHidden: false,
    contentHidden: false,
    active: false
  };
  heartbeatPorts.set(tabId, entry);

  // Ensure debugger is attached for newly connected Gemini tabs & push real BG_STATE
  ensureConfigLoaded().then(async () => {
    if (isDebuggerDesired() && !userCanceledTabs.has(tabId) && !devtoolsDetachedTabs.has(tabId)) {
      await attachDebugger(tabId);
    }
    await refreshTabBackgroundState(tabId);
  });

  port.onMessage.addListener((msg) => {
    const current = heartbeatPorts.get(tabId);
    if (!current || current.port !== port) return;
    if (msg.type === 'START') {
      current.contentHidden = true;
      current.active = current.browserHidden || current.contentHidden;
      setDiscardable(tabId, false);
      pushBgState(tabId);
      syncHeartbeatTimer();
    } else if (msg.type === 'STOP') {
      current.contentHidden = false;
      current.active = current.browserHidden || current.contentHidden;
      if (!current.active && !attachedTabs.has(tabId)) {
        setDiscardable(tabId, true);
      }
      pushBgState(tabId);
      syncHeartbeatTimer();
    }
    // 'PONG' needs no handling: receiving it resets the service worker idle timer.
  });

  port.onDisconnect.addListener(() => {
    const current = heartbeatPorts.get(tabId);
    if (current && current.port === port) {
      heartbeatPorts.delete(tabId);
      if (current.active && !attachedTabs.has(tabId)) {
        setDiscardable(tabId, true);
      }
    }
    syncHeartbeatTimer();
  });
});

function syncHeartbeatTimer() {
  const anyActive = [...heartbeatPorts.values()].some((e) => e.active);
  if (anyActive && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [tabId, entry] of heartbeatPorts.entries()) {
        if (!entry.active) continue;
        try {
          entry.port.postMessage({ type: 'TICK' });
        } catch (_) {}

        // Periodically re-assert active web lifecycle state for backgrounded attached tabs
        if (
          attachedTabs.has(tabId) &&
          now - (lastLifecycleRefresh.get(tabId) || 0) >= LIFECYCLE_REFRESH_INTERVAL_MS
        ) {
          lastLifecycleRefresh.set(tabId, now);
          sendCdpSafe(tabId, 'Page.setWebLifecycleState', { state: 'active' });
        }
      }
    }, 500);
  } else if (!anyActive && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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

  if (isGeminiUrl(url)) {
    if (changeInfo.status === 'complete') {
      // Page reload: allow re-attaching if DevTools was closed in the meantime
      devtoolsDetachedTabs.delete(tabId);
      attachDebugger(tabId);
    } else if (changeInfo.url && !devtoolsDetachedTabs.has(tabId)) {
      attachDebugger(tabId);
    }
  } else if (attachedTabs.has(tabId)) {
    // Navigated away from Gemini -> detach cleanly
    userCanceledTabs.delete(tabId);
    devtoolsDetachedTabs.delete(tabId);
    detachDebugger(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  attachInFlight.delete(tabId);
  userCanceledTabs.delete(tabId);
  devtoolsDetachedTabs.delete(tabId);
  lastLifecycleRefresh.delete(tabId);
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

// Reconcile open Gemini tabs whenever the service worker starts up
syncAllGeminiTabs();
