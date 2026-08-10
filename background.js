// Background Service Worker for AI Prompt Auto-Retry Extension

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  infiniteRetries: true,
  delaySeconds: 2,
  useExponentialBackoff: false,
  autoScroll: true,
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
  
  // Clean up legacy logs if present
  delete updated.logs;
  await chrome.storage.local.remove('logs');
  
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

function updateBadge(text, color = '#4F46E5') {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

