// Background Service Worker for AI Prompt Auto-Retry Extension

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  delaySeconds: 3,
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
    "I can't modify",
    "that depict minors",
    "encountering an error"
  ],
  stats: {
    totalRetries: 0,
    successRetries: 0,
    failedRetries: 0
  }
};

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const updated = { ...DEFAULT_SETTINGS, ...existing };
  
  // Merge default patterns if missing
  if (!existing.customErrorPatterns) {
    updated.customErrorPatterns = DEFAULT_SETTINGS.customErrorPatterns;
  }
  
  // Clean up legacy logs if present
  delete updated.logs;
  await chrome.storage.local.remove('logs');
  
  await chrome.storage.local.set(updated);
  console.log('[Auto-Retry Extension] Initialized settings.');
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

