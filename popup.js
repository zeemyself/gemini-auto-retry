document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const masterToggle = document.getElementById('masterToggle');
  const delaySeconds = document.getElementById('delaySeconds');
  const delayVal = document.getElementById('delayVal');
  const maxRetries = document.getElementById('maxRetries');
  const maxRetriesVal = document.getElementById('maxRetriesVal');
  const infiniteRetries = document.getElementById('infiniteRetries');
  const backgroundKeepAlive = document.getElementById('backgroundKeepAlive');

  const keepAliveStatusDot = document.getElementById('keepAliveStatusDot');
  const keepAliveStatusText = document.getElementById('keepAliveStatusText');
  const reloadTabsBtn = document.getElementById('reloadTabsBtn');

  const statTotal = document.getElementById('statTotal');
  const statSuccess = document.getElementById('statSuccess');
  const statStatus = document.getElementById('statStatus');

  const newPatternInput = document.getElementById('newPatternInput');
  const addPatternBtn = document.getElementById('addPatternBtn');
  const patternsList = document.getElementById('patternsList');

  const saveBtn = document.getElementById('saveBtn');
  const toast = document.getElementById('toast');

  let currentPatterns = [];

  // Tab navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${targetTab}`).classList.add('active');
    });
  });

  // Load Settings from storage
  const settings = await chrome.storage.local.get([
    'enabled',
    'delaySeconds',
    'maxRetries',
    'infiniteRetries',
    'backgroundKeepAlive',
    'customErrorPatterns',
    'stats'
  ]);

  // Sync state to inputs
  masterToggle.checked = settings.enabled !== false;
  delaySeconds.value = settings.delaySeconds !== undefined ? settings.delaySeconds : 1;
  delayVal.textContent = `${delaySeconds.value}s`;
  maxRetries.value = settings.maxRetries !== undefined ? settings.maxRetries : 10;
  infiniteRetries.checked = settings.infiniteRetries !== false;
  backgroundKeepAlive.checked = settings.backgroundKeepAlive !== false;

  function updateMaxRetriesUI() {
    if (infiniteRetries.checked) {
      maxRetries.disabled = true;
      maxRetriesVal.textContent = '∞';
    } else {
      maxRetries.disabled = false;
      maxRetriesVal.textContent = maxRetries.value;
    }
  }
  updateMaxRetriesUI();

  currentPatterns = settings.customErrorPatterns || [];

  // Update Stats
  const stats = settings.stats || { totalRetries: 0, successRetries: 0 };
  statTotal.textContent = stats.totalRetries;
  statSuccess.textContent = stats.successRetries;
  statStatus.textContent = masterToggle.checked ? 'Active' : 'Disabled';
  statStatus.className = masterToggle.checked ? 'stat-value text-indigo' : 'stat-value';

  // Render live Background Keep-Alive status
  function renderKeepAliveStatus(status) {
    if (!status) {
      keepAliveStatusDot.className = 'status-dot dot-muted';
      keepAliveStatusText.textContent = 'Background guard unavailable';
      reloadTabsBtn.classList.add('hidden');
      return;
    }

    if (!status.enabled || !status.backgroundKeepAlive) {
      keepAliveStatusDot.className = 'status-dot dot-muted';
      keepAliveStatusText.textContent = 'Background Keep-Alive disabled';
      reloadTabsBtn.classList.add('hidden');
      return;
    }

    if (status.geminiTabCount === 0) {
      keepAliveStatusDot.className = 'status-dot dot-muted';
      keepAliveStatusText.textContent = 'Ready — no Gemini tabs open';
      reloadTabsBtn.classList.add('hidden');
      return;
    }

    if (status.connectedCount < status.geminiTabCount) {
      const missing = status.geminiTabCount - status.connectedCount;
      keepAliveStatusDot.className = 'status-dot dot-warn';
      keepAliveStatusText.textContent = `Reload ${missing} Gemini ${missing === 1 ? 'tab' : 'tabs'} to activate`;
      reloadTabsBtn.classList.remove('hidden');
      return;
    }

    reloadTabsBtn.classList.add('hidden');
    keepAliveStatusDot.className = 'status-dot dot-active';

    if (status.hiddenCount > 0) {
      const tabWord = status.hiddenCount === 1 ? 'tab' : 'tabs';
      const suffix = status.busyCount > 0 ? ' · active' : '';
      keepAliveStatusText.textContent = `Keeping ${status.hiddenCount} hidden ${tabWord} alive${suffix}`;
    } else {
      const tabWord = status.connectedCount === 1 ? 'tab' : 'tabs';
      keepAliveStatusText.textContent = `Guarding ${status.connectedCount} Gemini ${tabWord}`;
    }
  }

  async function refreshKeepAliveStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_KEEPALIVE_STATUS' });
      renderKeepAliveStatus(status);
    } catch (_) {
      renderKeepAliveStatus(null);
    }
  }

  refreshKeepAliveStatus();

  reloadTabsBtn.addEventListener('click', async () => {
    reloadTabsBtn.disabled = true;
    try {
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of geminiTabs) {
        if (typeof tab.id === 'number') {
          await chrome.tabs.reload(tab.id);
        }
      }
      setTimeout(refreshKeepAliveStatus, 1200);
    } catch (_) {
      renderKeepAliveStatus(null);
    } finally {
      reloadTabsBtn.disabled = false;
    }
  });

  // Event Listeners
  delaySeconds.addEventListener('input', (e) => {
    delayVal.textContent = `${e.target.value}s`;
  });

  maxRetries.addEventListener('input', (e) => {
    if (!infiniteRetries.checked) {
      maxRetriesVal.textContent = e.target.value;
    }
  });

  infiniteRetries.addEventListener('change', () => {
    updateMaxRetriesUI();
  });

  masterToggle.addEventListener('change', (e) => {
    statStatus.textContent = e.target.checked ? 'Active' : 'Disabled';
    statStatus.className = e.target.checked ? 'stat-value text-indigo' : 'stat-value';
  });

  // Render Patterns
  function renderPatterns() {
    patternsList.innerHTML = '';
    currentPatterns.forEach((pattern, index) => {
      const li = document.createElement('li');
      li.className = 'pattern-item';
      li.innerHTML = `
        <span>${escapeHtml(pattern)}</span>
        <button class="delete-pattern-btn" data-index="${index}">&times;</button>
      `;
      patternsList.appendChild(li);
    });

    document.querySelectorAll('.delete-pattern-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        currentPatterns.splice(idx, 1);
        renderPatterns();
      });
    });
  }

  renderPatterns();

  // Add New Pattern
  addPatternBtn.addEventListener('click', () => {
    const text = newPatternInput.value.trim();
    if (text && !currentPatterns.includes(text)) {
      currentPatterns.push(text);
      newPatternInput.value = '';
      renderPatterns();
    }
  });

  newPatternInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addPatternBtn.click();
    }
  });

  // Save Settings
  saveBtn.addEventListener('click', async () => {
    const updatedSettings = {
      enabled: masterToggle.checked,
      delaySeconds: parseInt(delaySeconds.value, 10),
      maxRetries: parseInt(maxRetries.value, 10),
      infiniteRetries: infiniteRetries.checked,
      backgroundKeepAlive: backgroundKeepAlive.checked,
      customErrorPatterns: currentPatterns
    };

    await chrome.storage.local.set(updatedSettings);

    // Notify ALL open Gemini tabs (including background tabs)
    try {
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of geminiTabs) {
        if (typeof tab.id === 'number') {
          chrome.tabs
            .sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: updatedSettings })
            .catch(() => {});
        }
      }
    } catch (_) {}

    // Sync background keep-alive state and refresh status bar
    try {
      const status = await chrome.runtime.sendMessage({ type: 'SYNC_KEEPALIVE' });
      renderKeepAliveStatus(status);
    } catch (_) {}

    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2000);
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }
});
