document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const masterToggle = document.getElementById('masterToggle');
  const delaySeconds = document.getElementById('delaySeconds');
  const delayVal = document.getElementById('delayVal');
  const maxRetries = document.getElementById('maxRetries');
  const maxRetriesVal = document.getElementById('maxRetriesVal');
  const infiniteRetries = document.getElementById('infiniteRetries');
  const debuggerMode = document.getElementById('debuggerMode');

  const debuggerStatusDot = document.getElementById('debuggerStatusDot');
  const debuggerStatusText = document.getElementById('debuggerStatusText');
  const reattachBtn = document.getElementById('reattachBtn');

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

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
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
    'debuggerMode',
    'customErrorPatterns',
    'stats'
  ]);

  // Sync state to inputs
  masterToggle.checked = settings.enabled !== false;
  delaySeconds.value = settings.delaySeconds !== undefined ? settings.delaySeconds : 3;
  delayVal.textContent = `${delaySeconds.value}s`;
  maxRetries.value = settings.maxRetries !== undefined ? settings.maxRetries : 10;
  infiniteRetries.checked = settings.infiniteRetries === true;
  debuggerMode.checked = settings.debuggerMode !== false;

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

  // Render live debugger status
  function renderDebuggerStatus(status) {
    if (!status) {
      debuggerStatusDot.className = 'status-dot dot-muted';
      debuggerStatusText.textContent = 'Debugger status unavailable';
      reattachBtn.classList.add('hidden');
      return;
    }

    if (!status.enabled || !status.debuggerMode) {
      debuggerStatusDot.className = 'status-dot dot-muted';
      debuggerStatusText.textContent = 'Debugger disabled';
      reattachBtn.classList.add('hidden');
      return;
    }

    if (status.geminiTabCount === 0) {
      debuggerStatusDot.className = 'status-dot dot-muted';
      debuggerStatusText.textContent = 'No Gemini tabs open';
      reattachBtn.classList.add('hidden');
      return;
    }

    const tabWord = status.attachedCount === 1 ? 'tab' : 'tabs';
    if (status.attachedCount === status.geminiTabCount) {
      debuggerStatusDot.className = 'status-dot dot-active';
      debuggerStatusText.textContent = `Debugger attached (${status.attachedCount} ${tabWord})`;
      reattachBtn.classList.add('hidden');
      return;
    }

    debuggerStatusDot.className = 'status-dot dot-warn';
    if (status.canceledCount > 0) {
      debuggerStatusText.textContent = 'Debugger paused (banner canceled)';
    } else if (status.devtoolsCount > 0) {
      debuggerStatusText.textContent = 'Detached (DevTools open on tab)';
    } else {
      debuggerStatusText.textContent = `Attached ${status.attachedCount}/${status.geminiTabCount} tabs`;
    }
    reattachBtn.classList.remove('hidden');
  }

  async function refreshDebuggerStatus() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_DEBUGGER_STATUS' });
      renderDebuggerStatus(status);
    } catch (_) {
      renderDebuggerStatus(null);
    }
  }

  refreshDebuggerStatus();

  reattachBtn.addEventListener('click', async () => {
    reattachBtn.disabled = true;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'REATTACH_DEBUGGER' });
      renderDebuggerStatus(status);
    } catch (_) {
      renderDebuggerStatus(null);
    } finally {
      reattachBtn.disabled = false;
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

    // Delete Pattern event listener
    document.querySelectorAll('.delete-pattern-btn').forEach(btn => {
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
      debuggerMode: debuggerMode.checked,
      customErrorPatterns: currentPatterns
    };

    await chrome.storage.local.set(updatedSettings);

    // Notify ALL open Gemini tabs (including background tabs)
    try {
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of geminiTabs) {
        if (typeof tab.id === 'number') {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: updatedSettings }).catch(() => {});
        }
      }
    } catch (_) {}

    // Sync debugger attachment immediately and refresh status display
    try {
      const status = await chrome.runtime.sendMessage({ type: 'SYNC_DEBUGGER' });
      renderDebuggerStatus(status);
    } catch (_) {}

    // Show toast
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2000);
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }
});
