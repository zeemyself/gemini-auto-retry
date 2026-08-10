document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const masterToggle = document.getElementById('masterToggle');
  const delaySeconds = document.getElementById('delaySeconds');
  const delayVal = document.getElementById('delayVal');
  const maxRetries = document.getElementById('maxRetries');
  const maxRetriesVal = document.getElementById('maxRetriesVal');
  const infiniteRetries = document.getElementById('infiniteRetries');
  const autoScroll = document.getElementById('autoScroll');

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
    'autoScroll',
    'customErrorPatterns',
    'stats'
  ]);

  // Sync state to inputs
  masterToggle.checked = settings.enabled !== false;
  delaySeconds.value = settings.delaySeconds !== undefined ? settings.delaySeconds : 3;
  delayVal.textContent = `${delaySeconds.value}s`;
  maxRetries.value = settings.maxRetries !== undefined ? settings.maxRetries : 10;
  infiniteRetries.checked = settings.infiniteRetries === true;
  
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

  autoScroll.checked = settings.autoScroll !== false;

  currentPatterns = settings.customErrorPatterns || [];

  // Update Stats
  const stats = settings.stats || { totalRetries: 0, successRetries: 0 };
  statTotal.textContent = stats.totalRetries;
  statSuccess.textContent = stats.successRetries;
  statStatus.textContent = masterToggle.checked ? 'Active' : 'Disabled';
  statStatus.className = masterToggle.checked ? 'stat-value text-indigo' : 'stat-value';

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
      autoScroll: autoScroll.checked,
      customErrorPatterns: currentPatterns
    };

    await chrome.storage.local.set(updatedSettings);

    // Notify active content tabs
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_UPDATED', settings: updatedSettings }).catch(() => {});
    }

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
