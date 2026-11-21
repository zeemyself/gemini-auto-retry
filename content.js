// AI Prompt Auto-Retry Content Script

(function () {
  let settings = {
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
    ]
  };

  let lastPrompt = sessionStorage.getItem('auto_retry_last_prompt') || '';
  let currentAttempt = 0;
  let isRetrying = false;
  let retryTimer = null;
  let countdownInterval = null;
  let lastHandledErrorTimestamp = 0;
  let isBgHidden = false;
  let debuggerAttached = false;
  let lastClickMethod = 'none';

  // Load Settings
  chrome.storage.local.get(null, (res) => {
    if (res) {
      settings = { ...settings, ...res };
    }
  });

  // Listen for setting changes (direct message + storage sync for background tabs)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SETTINGS_UPDATED' && message.settings) {
      settings = { ...settings, ...message.settings };
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = { ...settings };
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key !== 'stats') next[key] = newValue;
    }
    settings = next;
  });

  // Detect Platform
  const hostname = window.location.hostname;
  let platform = 'AI Interface';
  if (hostname.includes('gemini.google.com')) platform = 'Gemini';
  else if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) platform = 'ChatGPT';
  else if (hostname.includes('claude.ai')) platform = 'Claude';

  // Helper: Check if an interactive element is connected, visible, and enabled
  function isElementUsable(el) {
    if (!el || !el.isConnected || el.disabled) return false;
    if (el.offsetHeight <= 0 || el.offsetWidth <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') {
      return false;
    }
    return true;
  }

  // Helper: Find Input Field
  function getInputElement() {
    const selectors = [
      'rich-textarea div[contenteditable="true"]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="Gemini" i]',
      '#prompt-textarea',
      'textarea[data-id]',
      'div[contenteditable="true"]',
      'textarea'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 0) return el;
    }
    return null;
  }

  // Helper: Get text from input element
  function getInputValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value.trim();
    }
    return el.innerText ? el.innerText.trim() : el.textContent.trim();
  }

  // Helper: Find Send Button
  function getSendButton() {
    const selectors = [
      'button.send-button',
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]'
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.offsetHeight > 0) return btn;
    }
    return null;
  }

  let userCancelledForCurrentError = false;
  let lastHandledErrorText = '';

  // Capture Prompt on Submit
  document.addEventListener('click', (e) => {
    const sendBtn = getSendButton();
    if (sendBtn && (sendBtn.contains(e.target) || e.target === sendBtn)) {
      const inputEl = getInputElement();
      const val = getInputValue(inputEl);
      if (val) {
        lastPrompt = val;
        sessionStorage.setItem('auto_retry_last_prompt', lastPrompt);
        currentAttempt = 0; // Reset attempts on manual user prompt
        userCancelledForCurrentError = false;
        lastHandledErrorText = '';
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const inputEl = getInputElement();
      if (inputEl && (document.activeElement === inputEl || inputEl.contains(document.activeElement))) {
        const val = getInputValue(inputEl);
        if (val) {
          lastPrompt = val;
          sessionStorage.setItem('auto_retry_last_prompt', lastPrompt);
          currentAttempt = 0;
          userCancelledForCurrentError = false;
          lastHandledErrorText = '';
        }
      }
    }
  }, true);

  // Error Pattern Scanner
  function checkForErrors() {
    if (!settings.enabled || isRetrying || userCancelledForCurrentError) return;

    // Cooldown check between retries
    const now = Date.now();
    if (now - lastHandledErrorTimestamp < 12000) return;

    const patterns = settings.customErrorPatterns || [];
    if (!patterns.length) return;

    // Helper to normalize apostrophes (replacing curly ’ with straight ')
    const norm = (str) => (str || '').replace(/’/g, "'");

    // Fast check with textContent first (avoids layout reflow / CPU spikes)
    const textContentNorm = norm(document.body.textContent);
    let candidateFound = false;
    for (const pat of patterns) {
      if (pat && pat.length > 2 && textContentNorm.includes(norm(pat))) {
        candidateFound = true;
        break;
      }
    }
    if (!candidateFound) return;

    const bodyTextNorm = norm(document.body.innerText);

    // Find the FIRST matching error pattern (prevents multiple retries if multiple keywords match at once)
    let foundPattern = null;
    for (const pat of patterns) {
      if (pat && pat.length > 2 && bodyTextNorm.includes(norm(pat))) {
        foundPattern = pat;
        break; // Trigger exactly ONCE for the first matching error pattern
      }
    }

    // Auto-retry ONLY triggers if an explicit error/refusal pattern is found
    if (foundPattern) {
      const isInfinite = settings.infiniteRetries === true || settings.maxRetries === 0;
      if (isInfinite || currentAttempt < settings.maxRetries) {
        lastHandledErrorTimestamp = now;
        lastHandledErrorText = foundPattern;
        const nativeRetryBtn = findNativeRetryButton();
        initiateAutoRetry(foundPattern, nativeRetryBtn);
      } else if (!isInfinite && currentAttempt >= settings.maxRetries && lastHandledErrorText !== foundPattern) {
        lastHandledErrorText = foundPattern;
        incrementStats('failed');
      }
    }
  }

  // Find native retry button within a DOM root, picking the LAST usable match
  function findRetryButtonInRoot(root) {
    const specificSelectors = [
      'button[aria-label="Redo"]',
      'button[aria-label*="Redo" i]',
      'button[aria-label*="Regenerate" i]',
      'button[aria-label*="Retry" i]',
      'button[aria-label*="Try again" i]',
      'div[description="Redo"] button',
      'button:has(mat-icon[data-mat-icon-name="redo"])'
    ];
    for (const sel of specificSelectors) {
      try {
        const matches = Array.from(root.querySelectorAll(sel)).filter(isElementUsable);
        if (matches.length) {
          return matches[matches.length - 1];
        }
      } catch (_) {
        // Ignore CSS selector syntax errors on fallback
      }
    }

    const buttons = Array.from(root.querySelectorAll('button')).filter(isElementUsable);
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        text.includes('redo') ||
        text.includes('retry') ||
        text.includes('regenerate') ||
        text.includes('try again')
      ) {
        return btn;
      }
    }
    return null;
  }

  // Find native retry buttons on chat platforms (e.g. Gemini "Redo", ChatGPT "Regenerate")
  // Always prefers the latest response turn rather than an earlier turn in chat history.
  function findNativeRetryButton() {
    const responses = document.querySelectorAll('model-response');
    if (responses.length) {
      const latestBtn = findRetryButtonInRoot(responses[responses.length - 1]);
      if (latestBtn) return latestBtn;
    }
    return findRetryButtonInRoot(document);
  }

  // Auto-Retry Controller
  function initiateAutoRetry(reason, nativeRetryBtn = null) {
    if (isRetrying) return;
    isRetrying = true;
    currentAttempt += 1;

    // Calculate delay
    const delay = settings.delaySeconds || 5;

    const isInfinite = settings.infiniteRetries === true || settings.maxRetries === 0;
    const maxDisplay = isInfinite ? '∞' : settings.maxRetries;

    updateBadge(`${currentAttempt}/${maxDisplay}`, '#F59E0B');

    // Show floating UI widget
    showRetryWidget(delay, currentAttempt, maxDisplay, reason, () => {
      // User clicked "Retry Now"
      pendingRetry = null;
      clearTimeout(retryTimer);
      clearInterval(countdownInterval);
      executeRetry(nativeRetryBtn);
    }, () => {
      // User clicked "Cancel"
      pendingRetry = null;
      clearTimeout(retryTimer);
      clearInterval(countdownInterval);
      removeWidget();
      isRetrying = false;
      userCancelledForCurrentError = true; // Prevent widget re-opening for current error
      updateBadge('', '');
    });

    // Start countdown. Deadline-based so heartbeat ticks can fire it while the
    // tab is hidden (page timers may be throttled in background tabs).
    pendingRetry = { at: Date.now() + delay * 1000, btn: nativeRetryBtn };
    retryTimer = setTimeout(pumpRetry, delay * 1000); // fast path when visible
  }

  // Fire the pending retry if its deadline has passed
  let pendingRetry = null;
  function pumpRetry() {
    if (!pendingRetry || Date.now() < pendingRetry.at) return;
    const { btn } = pendingRetry;
    pendingRetry = null;
    clearTimeout(retryTimer);
    clearInterval(countdownInterval);
    executeRetry(btn);
  }

  // Active DOM waiters polled on both DOM mutations and service-worker heartbeat ticks
  const activeWaiters = new Set();

  function pollWaiters() {
    for (const check of Array.from(activeWaiters)) {
      try {
        check();
      } catch (_) {}
    }
  }

  // Resolve with the first element returned by `finder`, reacting to DOM changes
  // and service-worker heartbeat ticks so background throttling never stalls waits.
  function waitForElement(finder, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const found = finder();
      if (found) return resolve(found);
      let done = false;
      const deadline = Date.now() + timeoutMs;

      const finish = (el) => {
        if (done) return;
        done = true;
        activeWaiters.delete(check);
        mo.disconnect();
        clearTimeout(safety);
        resolve(el || null);
      };

      const check = () => {
        const el = finder();
        if (el) finish(el);
        else if (Date.now() >= deadline) finish(null);
      };

      activeWaiters.add(check);
      const mo = new MutationObserver(check);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true });
      const safety = setTimeout(() => finish(finder()), timeoutMs);
    });
  }

  // Helper: Find "Try again" item in open secondary modal menu
  function findModalTryAgainButton() {
    const modalItems = Array.from(
      document.querySelectorAll('[role="menu"] [role="menuitem"], .cdk-overlay-pane [role="menuitem"], .mat-mdc-menu-item, [role="menuitem"]')
    ).filter(isElementUsable);
    for (let i = modalItems.length - 1; i >= 0; i--) {
      const el = modalItems[i];
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text.includes('try again')) {
        return el;
      }
    }
    return null;
  }

  // Send a runtime message with a timeout guard so a stalled response never hangs retries
  function sendMessageWithTimeout(payload, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, reason: 'timeout' });
        }
      }, timeoutMs);

      chrome.runtime.sendMessage(payload).then((res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res || { ok: false, reason: 'empty_response' });
        }
      }).catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: err?.message || 'send_error' });
        }
      });
    });
  }

  // Click an element using a CDP trusted mouse sequence when debugger is attached
  // and the target is unoccluded in viewport, with automatic fallback to DOM .click().
  async function robustClick(el) {
    if (!el || !el.isConnected) return false;

    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (_) {}

    if (debuggerAttached && settings.debuggerMode !== false) {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport =
        rect.width > 0 &&
        rect.height > 0 &&
        x >= 0 &&
        y >= 0 &&
        x <= window.innerWidth &&
        y <= window.innerHeight;

      if (inViewport) {
        const hit = document.elementFromPoint(x, y);
        const isHittable = Boolean(hit && (hit === el || el.contains(hit)));
        if (isHittable) {
          const res = await sendMessageWithTimeout({ type: 'CDP_CLICK', x, y }, 1500);
          if (res?.ok) {
            lastClickMethod = 'cdp';
            return true;
          }
        }
      }
    }

    // Fallback: focus + programmatic click
    try {
      el.focus?.({ preventScroll: true });
    } catch (_) {}
    el.click();
    lastClickMethod = 'dom';
    return true;
  }

  // Execute actual retry step (keeps isRetrying locked for the full click sequence)
  async function executeRetry(nativeRetryBtn = null) {
    removeWidget();
    isRetrying = true;

    try {
      // Step 0: Check if secondary popup menu is ALREADY open
      const openModalBtn = findModalTryAgainButton();
      if (openModalBtn) {
        const clicked = await robustClick(openModalBtn);
        lastHandledErrorTimestamp = Date.now();
        if (clicked) {
          incrementStats('success');
          updateBadge('OK', '#10B981');
          setTimeout(() => updateBadge('', ''), 3000);
        } else {
          incrementStats('failed');
        }
        return;
      }

      // Step 1: Native Retry / Redo Button
      let targetBtn =
        nativeRetryBtn && isElementUsable(nativeRetryBtn)
          ? nativeRetryBtn
          : findNativeRetryButton();

      if (!targetBtn) {
        // Button not rendered yet (e.g. response still finishing in a background tab)
        targetBtn = await waitForElement(findNativeRetryButton, 20000);
      }

      if (!targetBtn) {
        incrementStats('failed');
        return;
      }

      await clickNativeRetry(targetBtn);
    } finally {
      isRetrying = false;
    }
  }

  async function clickNativeRetry(btn) {
    const clicked = await robustClick(btn);
    lastHandledErrorTimestamp = Date.now();
    if (!clicked) {
      incrementStats('failed');
      return;
    }

    // Step 2: Handle secondary popup menu if it opens (e.g. Gemini "Redo" -> menu with "Try again")
    const secondaryBtn = await waitForElement(findModalTryAgainButton, 4000);
    if (secondaryBtn) {
      await robustClick(secondaryBtn);
      lastHandledErrorTimestamp = Date.now();
    }

    incrementStats('success');
    updateBadge('OK', '#10B981');
    setTimeout(() => updateBadge('', ''), 3000);
  }

  // Floating UI Widget
  function showRetryWidget(delaySeconds, attempt, maxAttempts, reason, onRetryNow, onCancel) {
    removeWidget();

    const widget = document.createElement('div');
    widget.id = 'ai-auto-retry-widget';

    widget.innerHTML = `
      <div class="retry-widget-header">
        <div class="retry-widget-title">
          <div class="retry-spinner"></div>
          <span>Auto-Retrying (${attempt}/${maxAttempts})</span>
        </div>
      </div>
      <div class="retry-widget-body">
        Triggered by: <strong>${escapeHtml(reason)}</strong>
      </div>
      ${lastPrompt ? `<div class="retry-widget-prompt">"${escapeHtml(lastPrompt)}"</div>` : ''}
      <div class="retry-progress-bar-container">
        <div class="retry-progress-bar" id="retryProgressBar"></div>
      </div>
      <div class="retry-widget-actions">
        <button class="retry-btn-cancel" id="retryWidgetCancel">Cancel</button>
        <button class="retry-btn-now" id="retryWidgetNow">Retry (${delaySeconds}s)</button>
      </div>
    `;

    document.body.appendChild(widget);

    const progressBar = widget.querySelector('#retryProgressBar');
    const retryNowBtn = widget.querySelector('#retryWidgetNow');
    const cancelBtn = widget.querySelector('#retryWidgetCancel');

    let remaining = delaySeconds;
    progressBar.style.transition = `width ${delaySeconds}s linear`;
    setTimeout(() => {
      progressBar.style.width = '0%';
    }, 50);

    countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining >= 0) {
        retryNowBtn.textContent = `Retry (${remaining}s)`;
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);

    retryNowBtn.addEventListener('click', onRetryNow);
    cancelBtn.addEventListener('click', onCancel);
  }

  function removeWidget() {
    const existing = document.getElementById('ai-auto-retry-widget');
    if (existing) existing.remove();
  }

  function incrementStats(status) {
    chrome.runtime.sendMessage({
      type: 'INCREMENT_STATS',
      status
    }).catch(() => {});
  }

  function updateBadge(text, color) {
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      text,
      color
    }).catch(() => {});
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  // Debounced observer to prevent high CPU/memory overhead during active response streaming
  let scanDebounceTimer = null;
  function debouncedCheckForErrors() {
    if (scanDebounceTimer) return;
    scanDebounceTimer = setTimeout(() => {
      scanDebounceTimer = null;
      checkForErrors();
    }, 600);
  }

  // Observe DOM changes for errors
  const observer = new MutationObserver(() => {
    debouncedCheckForErrors();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Periodic fallback check every 5 seconds
  setInterval(checkForErrors, 5000);

  // ---- Background heartbeat client ----
  // While this tab is backgrounded, the service worker sends a TICK every 500ms
  // over a long-lived port and pushes true BG_STATE (since CDP focus emulation
  // overrides document.hidden). Each tick polls waiters, fires due retries,
  // scans for errors, and lets page-visibility.js flush stalled frames.
  let hbPort = null;
  let reconnectTimer = null;
  let extensionAlive = true;

  function connectHeartbeat() {
    if (!extensionAlive || hbPort) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      hbPort = chrome.runtime.connect({ name: 'heartbeat' });
    } catch (_) {
      extensionAlive = false; // extension reloaded/removed: context invalidated
      return;
    }
    hbPort.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'BG_STATE') {
        isBgHidden = Boolean(msg.hidden);
        debuggerAttached = Boolean(msg.debuggerAttached);
        window.dispatchEvent(new CustomEvent('gar:bg-state', { detail: isBgHidden }));
      } else if (msg.type === 'TICK') {
        onHeartbeatTick();
        try { hbPort?.postMessage({ type: 'PONG' }); } catch (_) {}
      }
    });
    hbPort.onDisconnect.addListener(() => {
      hbPort = null;
      void chrome.runtime.lastError;
      if (extensionAlive && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectHeartbeat();
        }, 1000); // service worker restarted -> reconnect
      }
    });
    syncVisibility();
  }

  function syncVisibility() {
    if (!hbPort && extensionAlive) {
      connectHeartbeat();
      return;
    }
    try {
      hbPort?.postMessage({ type: document.hidden ? 'START' : 'STOP' });
    } catch (_) {}
  }

  // Hidden-tab diagnostics: logged to this tab's DevTools console every ~5s while
  // backgrounded, so we can see what (if anything) is still stalling.
  let pageStats = null;
  let tickCount = 0;
  window.addEventListener('gar:stats', (e) => {
    try { pageStats = JSON.parse(e.detail); } catch (_) {}
  });

  function onHeartbeatTick() {
    window.dispatchEvent(new Event('gar:tick')); // let Gemini render pending frames if stalled
    pollWaiters();
    pumpRetry();
    checkForErrors();

    if (++tickCount % 10 === 0 && (isBgHidden || document.hidden)) {
      const redoInDom = Array.from(document.querySelectorAll('button')).filter((b) => {
        const t = (b.getAttribute('aria-label') || b.innerText || '').toLowerCase();
        return /redo|retry|regenerate|try again/.test(t);
      });
      const responses = document.querySelectorAll('model-response, message-content');
      const lastResponse = responses[responses.length - 1];
      console.log('[Auto-Retry][hidden]', {
        ...pageStats,
        debuggerAttached,
        isBgHidden,
        lastClickMethod,
        retryBtn: !!findNativeRetryButton(),
        redoInDom: redoInDom.length,
        redoInDomDetail: redoInDom.slice(-3).map((b) => ({
          label: b.getAttribute('aria-label') || b.innerText.trim().slice(0, 30),
          h: b.offsetHeight,
          disabled: b.disabled
        })),
        lastResponseLen: lastResponse ? lastResponse.textContent.length : -1,
        pendingRetry: !!pendingRetry,
        isRetrying,
        cancelled: userCancelledForCurrentError,
        lastError: lastHandledErrorText,
        cooldownLeftMs: Math.max(0, 12000 - (Date.now() - lastHandledErrorTimestamp))
      });
    }
  }

  window.addEventListener('gar:visibility', syncVisibility);
  document.addEventListener('visibilitychange', syncVisibility); // in case page script is absent
  window.addEventListener('focus', syncVisibility);
  connectHeartbeat();

  console.log(`[Auto-Retry Extension] Initialized on ${platform}.`);
})();
