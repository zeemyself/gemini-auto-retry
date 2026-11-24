// AI Prompt Auto-Retry Content Script (Debugger-Free Background Engine)

(function () {
  let settings = {
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
      "Could you try again"
    ]
  };

  const FAST_RETRY_COOLDOWN_MS = 1500; // After a confirmed new generation cycle finishes
  const FALLBACK_COOLDOWN_MS = 8000;   // Safety guard if stream lifecycle wasn't observed
  const MAX_STREAM_HOLD_MS = 45000;    // Never hold error checks longer than 45s on stuck streams
  const BOOST_WINDOW_MS = 10000;       // Keep 150ms fast heartbeat briefly after stream/retry activity

  let lastPrompt = sessionStorage.getItem('auto_retry_last_prompt') || '';
  let currentAttempt = 0;
  let isRetrying = false;
  let retryTimer = null;
  let countdownInterval = null;
  let lastHandledErrorTimestamp = 0;
  let sawNewGenerationSinceRetry = false;
  let cooldownRecheckAt = 0;
  let cooldownRecheckTimer = null;

  let isBgHidden = false;
  let keepAliveAllowedByBg = true;
  let streamGenerating = false;
  let lastStreamStartTs = 0;
  let activeBoostUntil = 0;

  let userCancelledForCurrentError = false;
  let lastHandledErrorText = '';

  function pushConfigToMainWorld() {
    try {
      window.dispatchEvent(
        new CustomEvent('gar:config', {
          detail: JSON.stringify({
            enabled: settings.enabled !== false,
            backgroundKeepAlive: settings.backgroundKeepAlive !== false
          })
        })
      );
    } catch (_) {}
  }

  function isKeepAliveActive() {
    return settings.enabled !== false && settings.backgroundKeepAlive !== false && keepAliveAllowedByBg;
  }

  function isTabHidden() {
    return Boolean(isBgHidden || document.hidden);
  }

  function bumpActivityBoost(durationMs = BOOST_WINDOW_MS) {
    activeBoostUntil = Math.max(activeBoostUntil, Date.now() + durationMs);
    reportActivityState();
  }

  // ---- Native Blink Scheduler Exemptions (WebLocks + Demand-Driven Loopback WebRTC) ----
  // 1. WebLock: triggers CannotFreezeReason::kHoldingWebLock in Chromium PerformanceManager
  //    at 0% CPU so Energy Saver / Background Tab Freezing never freezes the tab.
  // 2. Loopback RTCPeerConnection + open RTCDataChannel: activates ONLY while the tab is
  //    hidden, registering SchedulingPolicy::Feature::kWebRTC in PageSchedulerImpl to
  //    opt out of 10s/60s Intensive Wake Up Throttling with zero audio or banners.
  let webLockRelease = null;
  let webLockPending = false;

  let rtcPc1 = null;
  let rtcPc2 = null;
  let rtcChannel = null;
  let rtcStarting = false;
  let lastRtcPingAt = 0;

  function ensureWebLock() {
    if (!isKeepAliveActive()) {
      releaseWebLock();
      return;
    }
    if (webLockRelease || webLockPending || !navigator.locks?.request) return;
    webLockPending = true;
    const lockName = `gar-keepalive-${Math.random().toString(36).slice(2)}`;
    navigator.locks
      .request(lockName, { mode: 'exclusive' }, () => {
        webLockPending = false;
        if (!isKeepAliveActive()) return Promise.resolve();
        return new Promise((resolve) => {
          webLockRelease = () => {
            webLockRelease = null;
            resolve();
            reportActivityState();
          };
          reportActivityState();
        });
      })
      .catch(() => {
        webLockPending = false;
        webLockRelease = null;
      });
  }

  function releaseWebLock() {
    if (webLockRelease) {
      const release = webLockRelease;
      webLockRelease = null;
      release();
    }
  }

  async function ensureWebRtcKeepAlive() {
    if (!isKeepAliveActive() || !isTabHidden()) {
      teardownWebRtcKeepAlive();
      return;
    }
    if (rtcPc1 || rtcStarting || typeof RTCPeerConnection !== 'function') return;
    rtcStarting = true;

    let pc1 = null;
    let pc2 = null;
    try {
      pc1 = new RTCPeerConnection({ iceServers: [] });
      pc2 = new RTCPeerConnection({ iceServers: [] });
      const dc = pc1.createDataChannel('gar-keepalive', { ordered: false, maxRetransmits: 0 });

      pc1.onicecandidate = (e) => {
        if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {});
      };
      pc2.onicecandidate = (e) => {
        if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {});
      };
      pc2.ondatachannel = (e) => {
        e.channel.onmessage = () => {};
      };
      dc.onopen = () => {
        try {
          dc.send('1');
        } catch (_) {}
        reportActivityState();
      };
      dc.onclose = () => {
        if (rtcChannel === dc) {
          teardownWebRtcKeepAlive();
        }
      };

      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      if (!isKeepAliveActive() || !isTabHidden()) {
        try { dc.close(); } catch (_) {}
        try { pc1.close(); } catch (_) {}
        try { pc2.close(); } catch (_) {}
        return;
      }

      rtcPc1 = pc1;
      rtcPc2 = pc2;
      rtcChannel = dc;
      reportActivityState();
    } catch (_) {
      try { pc1?.close(); } catch (_) {}
      try { pc2?.close(); } catch (_) {}
    } finally {
      rtcStarting = false;
    }
  }

  function pingWebRtcKeepAlive() {
    if (!rtcChannel || rtcChannel.readyState !== 'open') return;
    const now = Date.now();
    if (now - lastRtcPingAt < 2000) return;
    lastRtcPingAt = now;
    try {
      if (rtcChannel.bufferedAmount < 1024) {
        rtcChannel.send('k');
      }
    } catch (_) {}
  }

  function teardownWebRtcKeepAlive() {
    const dc = rtcChannel;
    const pc1 = rtcPc1;
    const pc2 = rtcPc2;
    rtcChannel = null;
    rtcPc1 = null;
    rtcPc2 = null;
    if (dc) {
      try { dc.close(); } catch (_) {}
    }
    if (pc1) {
      try { pc1.close(); } catch (_) {}
    }
    if (pc2) {
      try { pc2.close(); } catch (_) {}
    }
    if (dc || pc1 || pc2) {
      reportActivityState();
    }
  }

  function syncSchedulerExemptions() {
    ensureWebLock();
    if (isKeepAliveActive() && isTabHidden()) {
      ensureWebRtcKeepAlive();
    } else {
      teardownWebRtcKeepAlive();
    }
  }

  // Load Settings
  chrome.storage.local.get(null, (res) => {
    if (res) {
      settings = { ...settings, ...res };
      pushConfigToMainWorld();
      syncSchedulerExemptions();
    }
  });

  // Listen for setting changes (direct message + storage sync for background tabs)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SETTINGS_UPDATED' && message.settings) {
      settings = { ...settings, ...message.settings };
      pushConfigToMainWorld();
      syncSchedulerExemptions();
      reportActivityState();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = { ...settings };
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key !== 'stats') next[key] = newValue;
    }
    settings = next;
    pushConfigToMainWorld();
    syncSchedulerExemptions();
    reportActivityState();
  });

  // Listen for stream generation lifecycle events from page-visibility.js (MAIN world)
  window.addEventListener('gar:gen-state', (e) => {
    let data = null;
    try {
      data = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
    } catch (_) {}
    if (!data) return;

    const wasGenerating = streamGenerating;
    streamGenerating = Boolean(data.generating);

    if (streamGenerating && !wasGenerating) {
      lastStreamStartTs = Date.now();
      bumpActivityBoost(BOOST_WINDOW_MS);
    } else if (!streamGenerating && wasGenerating) {
      if (lastHandledErrorTimestamp > 0) {
        sawNewGenerationSinceRetry = true;
      }
      bumpActivityBoost(BOOST_WINDOW_MS);
      // Let final stream chunks render before scanning for errors
      setTimeout(checkForErrors, 350);
    } else {
      reportActivityState();
    }
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
    if (el.getAttribute?.('aria-disabled') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') {
      return false;
    }
    return true;
  }

  // Helper: Detect if Gemini is actively streaming a response right now
  function isStopButtonVisible() {
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button.stop-button',
      'button:has(mat-icon[data-mat-icon-name="stop"])'
    ];
    for (const sel of stopSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && isElementUsable(btn)) return true;
      } catch (_) {}
    }
    return false;
  }

  function isCurrentlyStreaming() {
    if (isStopButtonVisible()) return true;
    if (streamGenerating && Date.now() - lastStreamStartTs < MAX_STREAM_HOLD_MS) {
      return true;
    }
    return false;
  }

  function isTabBusy() {
    return Boolean(
      isRetrying ||
      pendingRetry ||
      cooldownRecheckAt > Date.now() ||
      isCurrentlyStreaming() ||
      Date.now() < activeBoostUntil
    );
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

  function onUserPromptSubmitted(val) {
    if (val) {
      lastPrompt = val;
      sessionStorage.setItem('auto_retry_last_prompt', lastPrompt);
    }
    currentAttempt = 0;
    userCancelledForCurrentError = false;
    lastHandledErrorText = '';
    lastHandledErrorTimestamp = 0;
    sawNewGenerationSinceRetry = false;
    bumpActivityBoost(BOOST_WINDOW_MS);
  }

  // Capture Prompt on Submit
  document.addEventListener(
    'click',
    (e) => {
      const sendBtn = getSendButton();
      if (sendBtn && (sendBtn.contains(e.target) || e.target === sendBtn)) {
        const inputEl = getInputElement();
        onUserPromptSubmitted(getInputValue(inputEl));
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const inputEl = getInputElement();
        if (inputEl && (document.activeElement === inputEl || inputEl.contains(document.activeElement))) {
          const val = getInputValue(inputEl);
          if (val) onUserPromptSubmitted(val);
        }
      }
    },
    true
  );

  // ---- Turn-Scoped DOM Roots (prevents matching old chat history or user prompts) ----
  function getLatestActiveModelResponse() {
    const responses = document.querySelectorAll('model-response');
    if (!responses.length) return null;
    const lastResponse = responses[responses.length - 1];

    // If a newer <user-query> appears AFTER the last <model-response>, Gemini hasn't
    // mounted the new turn's <model-response> yet — ignore the stale previous turn.
    const userQueries = document.querySelectorAll('user-query, [data-message-author-role="user"]');
    if (userQueries.length) {
      const lastUserQuery = userQueries[userQueries.length - 1];
      const pos = lastResponse.compareDocumentPosition(lastUserQuery);
      if (!(pos & Node.DOCUMENT_POSITION_CONTAINED_BY) && (pos & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return null;
      }
    }
    return lastResponse;
  }

  function getErrorScanRoots() {
    const roots = [];
    const latestResponse = getLatestActiveModelResponse();
    if (latestResponse) {
      roots.push(latestResponse);
    }

    const alertSelectors =
      'mat-snack-bar-container, .mat-mdc-snack-bar-container, simple-snack-bar, [role="alert"], error-message, .error-container';
    for (const el of document.querySelectorAll(alertSelectors)) {
      if (el.id === 'ai-auto-retry-widget' || el.closest('#ai-auto-retry-widget')) continue;
      if (el.offsetHeight > 0 || (el.textContent && el.textContent.trim().length > 0)) {
        roots.push(el);
      }
    }

    // Fallback only if the page has zero <model-response> and zero <user-query> elements
    if (!roots.length && !document.querySelector('model-response, user-query')) {
      if (document.body) roots.push(document.body);
    }

    return roots;
  }

  function scheduleCooldownRecheck(delayMs) {
    const wakeAt = Date.now() + Math.max(60, delayMs);
    if (cooldownRecheckAt > Date.now() && wakeAt >= cooldownRecheckAt) return;
    cooldownRecheckAt = wakeAt;
    clearTimeout(cooldownRecheckTimer);
    cooldownRecheckTimer = setTimeout(() => {
      cooldownRecheckAt = 0;
      checkForErrors();
    }, Math.max(60, delayMs));
    bumpActivityBoost(delayMs + 3000);
  }

  // Error Pattern Scanner
  function checkForErrors() {
    if (!settings.enabled || isRetrying || pendingRetry || userCancelledForCurrentError) return;

    const patterns = settings.customErrorPatterns || [];
    if (!patterns.length) return;

    // Wait while Gemini is actively streaming tokens so the response & Redo button finish mounting
    if (isCurrentlyStreaming()) {
      if (lastHandledErrorTimestamp > 0) {
        sawNewGenerationSinceRetry = true;
      }
      return;
    }

    const roots = getErrorScanRoots();
    if (!roots.length) return;

    const norm = (str) => (str || '').replace(/’/g, "'");

    // Fast pre-check via textContent across scoped roots (zero layout reflow)
    let combinedRaw = '';
    for (const root of roots) {
      combinedRaw += '\n' + (root.textContent || '');
    }
    const textContentNorm = norm(combinedRaw);

    let candidateFound = false;
    for (const pat of patterns) {
      if (pat && pat.length > 2 && textContentNorm.includes(norm(pat))) {
        candidateFound = true;
        break;
      }
    }
    if (!candidateFound) return;

    // Cooldown check: if an error arrived during cooldown, schedule a guaranteed wakeup!
    const now = Date.now();
    if (lastHandledErrorTimestamp > 0) {
      const requiredCooldown = sawNewGenerationSinceRetry ? FAST_RETRY_COOLDOWN_MS : FALLBACK_COOLDOWN_MS;
      const elapsed = now - lastHandledErrorTimestamp;
      if (elapsed < requiredCooldown) {
        scheduleCooldownRecheck(requiredCooldown - elapsed + 50);
        return;
      }
    }

    // Confirm visibility using innerText (excluding our own widget if body fallback was used)
    let visibleCombined = '';
    for (const root of roots) {
      if (root === document.body) {
        visibleCombined += '\n' + (root.innerText || '');
      } else {
        visibleCombined += '\n' + (root.innerText || root.textContent || '');
      }
    }
    const visibleNorm = norm(visibleCombined);

    let foundPattern = null;
    for (const pat of patterns) {
      if (pat && pat.length > 2 && visibleNorm.includes(norm(pat))) {
        foundPattern = pat;
        break;
      }
    }

    if (foundPattern) {
      const isInfinite = settings.infiniteRetries === true || settings.maxRetries === 0;
      if (isInfinite || currentAttempt < settings.maxRetries) {
        lastHandledErrorTimestamp = now;
        sawNewGenerationSinceRetry = false;
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
  function findRetryButtonInRoot(root, excludedContainers = null) {
    const isAllowed = (el) => {
      if (!isElementUsable(el)) return false;
      if (el.closest('#ai-auto-retry-widget')) return false;
      if (excludedContainers) {
        const ownerTurn = el.closest('model-response');
        if (ownerTurn && excludedContainers.has(ownerTurn)) return false;
      }
      return true;
    };

    const specificSelectors = [
      'button[aria-label="Redo"]',
      'button[aria-label*="Redo" i]',
      'button[aria-label*="Regenerate" i]',
      'button[aria-label*="Retry" i]',
      'button[aria-label*="Try again" i]',
      'div[description="Redo"] button',
      'button:has(mat-icon[data-mat-icon-name="redo"])',
      'button:has(mat-icon[fonticon="refresh"])'
    ];
    for (const sel of specificSelectors) {
      try {
        const matches = Array.from(root.querySelectorAll(sel)).filter(isAllowed);
        if (matches.length) {
          return matches[matches.length - 1];
        }
      } catch (_) {}
    }

    const buttons = Array.from(root.querySelectorAll('button')).filter(isAllowed);
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

  // Find native retry button for ONLY the latest active turn (never clicks an older turn's Redo)
  function findNativeRetryButton() {
    const allResponses = Array.from(document.querySelectorAll('model-response'));
    const latestResponse = getLatestActiveModelResponse();

    if (latestResponse) {
      const latestBtn = findRetryButtonInRoot(latestResponse);
      if (latestBtn) return latestBtn;
    }

    // Exclude all historical <model-response> turns so document-level fallback only
    // matches active error cards/banners outside <model-response>.
    const staleTurns = new Set(
      latestResponse ? allResponses.filter((r) => r !== latestResponse) : allResponses
    );
    return findRetryButtonInRoot(document, staleTurns);
  }

  // Auto-Retry Controller
  let pendingRetry = null;

  function initiateAutoRetry(reason, nativeRetryBtn = null) {
    if (isRetrying) return;
    isRetrying = true;
    currentAttempt += 1;
    bumpActivityBoost(BOOST_WINDOW_MS);

    const delay = settings.delaySeconds || 1;
    const isInfinite = settings.infiniteRetries === true || settings.maxRetries === 0;
    const maxDisplay = isInfinite ? '∞' : settings.maxRetries;

    updateBadge(`${currentAttempt}/${maxDisplay}`, '#F59E0B');

    showRetryWidget(
      delay,
      currentAttempt,
      maxDisplay,
      reason,
      () => {
        pendingRetry = null;
        clearTimeout(retryTimer);
        clearInterval(countdownInterval);
        executeRetry(nativeRetryBtn);
      },
      () => {
        pendingRetry = null;
        clearTimeout(retryTimer);
        clearInterval(countdownInterval);
        removeWidget();
        isRetrying = false;
        userCancelledForCurrentError = true;
        updateBadge('', '');
        reportActivityState();
      }
    );

    pendingRetry = { at: Date.now() + delay * 1000, btn: nativeRetryBtn };
    retryTimer = setTimeout(pumpRetry, delay * 1000);
    reportActivityState();
  }

  function pumpRetry() {
    if (!pendingRetry || Date.now() < pendingRetry.at) return;
    const { btn } = pendingRetry;
    pendingRetry = null;
    clearTimeout(retryTimer);
    clearInterval(countdownInterval);
    executeRetry(btn);
  }

  function pumpCooldownRecheck() {
    if (cooldownRecheckAt > 0 && Date.now() >= cooldownRecheckAt) {
      cooldownRecheckAt = 0;
      clearTimeout(cooldownRecheckTimer);
      checkForErrors();
    }
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

  function waitForCondition(predicate, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const initial = predicate();
      if (initial) return resolve(initial);
      let done = false;
      const deadline = Date.now() + timeoutMs;

      const finish = (val) => {
        if (done) return;
        done = true;
        activeWaiters.delete(check);
        mo.disconnect();
        clearTimeout(safety);
        resolve(val || null);
      };

      const check = () => {
        const val = predicate();
        if (val) finish(val);
        else if (Date.now() >= deadline) finish(null);
      };

      activeWaiters.add(check);
      const mo = new MutationObserver(check);
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      const safety = setTimeout(() => finish(predicate()), timeoutMs);
    });
  }

  // Helper: Find "Try again" item in open secondary Angular Material menu
  function findModalTryAgainButton() {
    const modalItems = Array.from(
      document.querySelectorAll(
        '[role="menu"] [role="menuitem"], .cdk-overlay-pane [role="menuitem"], .mat-mdc-menu-item, [role="menuitem"]'
      )
    ).filter(isElementUsable);
    for (let i = modalItems.length - 1; i >= 0; i--) {
      const el = modalItems[i];
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text.includes('try again') || text.includes('regenerate') || text.includes('retry')) {
        return el;
      }
    }
    return null;
  }

  // Dispatch a complete W3C pointer + mouse + focus + click sequence with real coordinates
  // so Angular Material MatMenuTrigger (_openedBy = 'mouse') and Wiz jsaction fire reliably
  // without requiring chrome.debugger.
  async function robustClick(el) {
    if (!el || !el.isConnected) return false;

    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (_) {}

    const rect = el.getBoundingClientRect();
    const clientX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
    const clientY = rect.height > 0 ? rect.top + rect.height / 2 : 0;

    const commonMouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY
    };

    const firePointer = (type, buttons, button) => {
      if (typeof PointerEvent !== 'function') return;
      try {
        el.dispatchEvent(
          new PointerEvent(type, {
            ...commonMouseInit,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: buttons ? 0.5 : 0,
            button,
            buttons
          })
        );
      } catch (_) {}
    };

    const fireMouse = (type, buttons, button, detail = 1) => {
      try {
        el.dispatchEvent(
          new MouseEvent(type, {
            ...commonMouseInit,
            button,
            buttons,
            detail
          })
        );
      } catch (_) {}
    };

    firePointer('pointerover', 0, -1);
    fireMouse('mouseover', 0, 0, 0);
    firePointer('pointerdown', 1, 0);
    fireMouse('mousedown', 1, 0, 1);
    try {
      el.focus?.({ preventScroll: true });
    } catch (_) {}
    firePointer('pointerup', 0, 0);
    fireMouse('mouseup', 0, 0, 1);
    el.click();

    // Immediately pulse MAIN-world timers, rAF, and menu animations when hidden
    if (isTabHidden()) {
      window.dispatchEvent(new Event('gar:flush-now'));
    }

    return true;
  }

  async function executeRetry(nativeRetryBtn = null) {
    removeWidget();
    isRetrying = true;
    bumpActivityBoost(BOOST_WINDOW_MS);

    try {
      // Step 0: Check if secondary popup menu is ALREADY open
      const openModalBtn = findModalTryAgainButton();
      if (openModalBtn) {
        const clicked = await robustClick(openModalBtn);
        lastHandledErrorTimestamp = Date.now();
        sawNewGenerationSinceRetry = false;
        if (clicked) {
          incrementStats('success');
          updateBadge('OK', '#10B981');
          setTimeout(() => updateBadge('', ''), 3000);
        } else {
          incrementStats('failed');
        }
        return;
      }

      // Step 1: Locate Native Retry / Redo Button for the latest active turn
      let targetBtn =
        nativeRetryBtn && isElementUsable(nativeRetryBtn) ? nativeRetryBtn : findNativeRetryButton();

      if (!targetBtn) {
        if (isTabHidden()) {
          window.dispatchEvent(new Event('gar:flush-now'));
        }
        targetBtn = await waitForCondition(findNativeRetryButton, 20000);
      }

      if (!targetBtn) {
        incrementStats('failed');
        return;
      }

      await clickNativeRetry(targetBtn);
    } finally {
      isRetrying = false;
      reportActivityState();
    }
  }

  async function clickNativeRetry(btn) {
    const clickedAt = Date.now();
    const clicked = await robustClick(btn);
    lastHandledErrorTimestamp = Date.now();
    sawNewGenerationSinceRetry = false;
    if (!clicked) {
      incrementStats('failed');
      return;
    }

    // Step 2: Wait for EITHER secondary menu ("Try again") OR immediate stream start
    // (direct Retry buttons start streaming immediately without opening a dropdown).
    const nextAction = await waitForCondition(() => {
      const menuBtn = findModalTryAgainButton();
      if (menuBtn) return { kind: 'menu', el: menuBtn };
      if (Date.now() - clickedAt >= 250 && isCurrentlyStreaming()) {
        return { kind: 'streaming' };
      }
      return null;
    }, 3500);

    if (nextAction?.kind === 'menu' && nextAction.el) {
      await robustClick(nextAction.el);
      lastHandledErrorTimestamp = Date.now();
      sawNewGenerationSinceRetry = false;
    }

    bumpActivityBoost(BOOST_WINDOW_MS);
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
    chrome.runtime
      .sendMessage({
        type: 'INCREMENT_STATS',
        status
      })
      .catch(() => {});
  }

  function updateBadge(text, color) {
    chrome.runtime
      .sendMessage({
        type: 'UPDATE_BADGE',
        text,
        color
      })
      .catch(() => {});
  }

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

  // Debounced observer to prevent high CPU/memory overhead during active response streaming
  let scanDebounceTimer = null;
  function debouncedCheckForErrors() {
    if (scanDebounceTimer) return;
    scanDebounceTimer = setTimeout(() => {
      scanDebounceTimer = null;
      checkForErrors();
    }, 500);
  }

  const observer = new MutationObserver(() => {
    debouncedCheckForErrors();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Periodic fallback check every 4 seconds
  const fallbackScanInterval = setInterval(checkForErrors, 4000);

  // ---- Background Heartbeat Client ----
  let hbPort = null;
  let reconnectTimer = null;
  let extensionAlive = true;
  let lastReportedBusy = null;
  let lastReportedWebLock = null;
  let lastReportedWebRtc = null;

  function cleanupInvalidatedContext() {
    extensionAlive = false;
    clearTimeout(reconnectTimer);
    clearInterval(fallbackScanInterval);
    observer.disconnect();
    releaseWebLock();
    teardownWebRtcKeepAlive();
  }

  function reportActivityState(force = false) {
    if (!hbPort || !extensionAlive) return;
    const busy = isTabBusy();
    const webLock = Boolean(webLockRelease);
    const webrtc = Boolean(rtcChannel && rtcChannel.readyState === 'open');
    if (
      !force &&
      busy === lastReportedBusy &&
      webLock === lastReportedWebLock &&
      webrtc === lastReportedWebRtc
    ) {
      return;
    }
    lastReportedBusy = busy;
    lastReportedWebLock = webLock;
    lastReportedWebRtc = webrtc;
    try {
      hbPort.postMessage({ type: 'ACTIVITY', busy, webLock, webrtc });
    } catch (_) {}
  }

  function connectHeartbeat() {
    if (!extensionAlive || hbPort) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      hbPort = chrome.runtime.connect({ name: 'heartbeat' });
    } catch (_) {
      cleanupInvalidatedContext();
      return;
    }

    lastReportedBusy = null;
    hbPort.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'BG_STATE') {
        isBgHidden = Boolean(msg.hidden);
        keepAliveAllowedByBg = msg.keepAliveEnabled !== false;
        window.dispatchEvent(new CustomEvent('gar:bg-state', { detail: isBgHidden }));
        syncSchedulerExemptions();
        reportActivityState(true);
      } else if (msg.type === 'TICK') {
        onHeartbeatTick();
        try {
          hbPort?.postMessage({ type: 'PONG' });
        } catch (_) {}
      }
    });

    hbPort.onDisconnect.addListener(() => {
      hbPort = null;
      void chrome.runtime.lastError;
      if (!chrome.runtime?.id) {
        cleanupInvalidatedContext();
        return;
      }
      if (extensionAlive && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectHeartbeat();
        }, 1000);
      }
    });

    syncVisibility();
    reportActivityState(true);
  }

  function syncVisibility() {
    syncSchedulerExemptions();
    if (!hbPort && extensionAlive) {
      connectHeartbeat();
      return;
    }
    try {
      hbPort?.postMessage({ type: document.hidden ? 'START' : 'STOP' });
    } catch (_) {}
    reportActivityState();
  }

  // Hidden-tab diagnostics (logged every ~5s while hidden)
  let pageStats = null;
  let lastDiagLogAt = 0;
  window.addEventListener('gar:stats', (e) => {
    try {
      pageStats = JSON.parse(e.detail);
    } catch (_) {}
  });

  function onHeartbeatTick() {
    window.dispatchEvent(new Event('gar:tick'));
    pingWebRtcKeepAlive();
    pollWaiters();
    pumpRetry();
    pumpCooldownRecheck();
    checkForErrors();
    reportActivityState();

    const now = Date.now();
    if (isTabHidden() && now - lastDiagLogAt >= 5000) {
      lastDiagLogAt = now;
      const latestResponse = getLatestActiveModelResponse();
      console.log('[Auto-Retry][hidden]', {
        ...pageStats,
        isBgHidden,
        webLock: Boolean(webLockRelease),
        webrtc: Boolean(rtcChannel && rtcChannel.readyState === 'open'),
        busy: isTabBusy(),
        streaming: isCurrentlyStreaming(),
        retryBtn: Boolean(findNativeRetryButton()),
        lastResponseLen: latestResponse ? latestResponse.textContent.length : -1,
        pendingRetry: Boolean(pendingRetry),
        isRetrying,
        sawNewGen: sawNewGenerationSinceRetry,
        lastError: lastHandledErrorText
      });
    }
  }

  window.addEventListener('gar:visibility', syncVisibility);
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('focus', syncVisibility);

  pushConfigToMainWorld();
  syncSchedulerExemptions();
  connectHeartbeat();

  console.log(`[Auto-Retry Extension] Initialized on ${platform} (debugger-free keep-alive).`);
})();
