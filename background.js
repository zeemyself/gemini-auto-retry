// Background Service Worker for AI Prompt Auto-Retry Extension

const DEFAULT_SETTINGS = {
  enabled: true,
  maxRetries: 10,
  delaySeconds: 3,
  useExponentialBackoff: false,
  autoScroll: true,
  customErrorPatterns: [
    "Something went wrong",
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
    "that depict minors",
    "encountering an error"
  ],
  stats: {
    totalRetries: 0,
    successRetries: 0,
    failedRetries: 0
  },
  logs: []
};

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const updated = { ...DEFAULT_SETTINGS, ...existing };
  
  // Merge default patterns if missing
  if (!existing.customErrorPatterns) {
    updated.customErrorPatterns = DEFAULT_SETTINGS.customErrorPatterns;
  }
  
  await chrome.storage.local.set(updated);
  console.log('[Auto-Retry Extension] Initialized settings.');
});

// Handle incoming messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LOG_RETRY_EVENT') {
    handleRetryLog(message.payload);
    sendResponse({ status: 'ok' });
  } else if (message.type === 'UPDATE_BADGE') {
    updateBadge(message.text, message.color);
    sendResponse({ status: 'ok' });
  }
  return true;
});

async function handleRetryLog(payload) {
  const data = await chrome.storage.local.get(['stats', 'logs']);
  const stats = data.stats || { totalRetries: 0, successRetries: 0, failedRetries: 0 };
  const logs = data.logs || [];

  stats.totalRetries += 1;
  if (payload.status === 'success') {
    stats.successRetries += 1;
  } else if (payload.status === 'failed') {
    stats.failedRetries += 1;
  }

  // Prepend log entry and keep last 50 entries
  const newLog = {
    timestamp: new Date().toISOString(),
    prompt: payload.prompt || '(No prompt text captured)',
    url: payload.url || '',
    platform: payload.platform || 'Unknown',
    attempt: payload.attempt || 1,
    status: payload.status || 'retrying',
    reason: payload.reason || ''
  };

  logs.unshift(newLog);
  if (logs.length > 50) logs.pop();

  await chrome.storage.local.set({ stats, logs });
}

function updateBadge(text, color = '#4F46E5') {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}
