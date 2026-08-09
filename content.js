// AI Prompt Auto-Retry Content Script

(function () {
  let settings = {
    enabled: true,
    maxRetries: 10,
    infiniteRetries: false,
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
      "encountering an error",
      "try your request again",
      "with something else instead"
    ]
  };

  let lastPrompt = sessionStorage.getItem('auto_retry_last_prompt') || '';
  let currentAttempt = 0;
  let isRetrying = false;
  let retryTimer = null;
  let countdownInterval = null;
  let lastHandledErrorTimestamp = 0;

  // Load Settings
  chrome.storage.local.get(null, (res) => {
    if (res) {
      settings = { ...settings, ...res };
    }
  });

  // Listen for setting changes
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
      settings = message.settings;
    }
  });

  // Detect Platform
  const hostname = window.location.hostname;
  let platform = 'AI Interface';
  if (hostname.includes('gemini.google.com')) platform = 'Gemini';
  else if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) platform = 'ChatGPT';
  else if (hostname.includes('claude.ai')) platform = 'Claude';

  // Helper: Find Input Field
  function getInputElement() {
    // Platform specific & generic fallback
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

  // Helper: Set text into input element
  function setInputValue(el, text) {
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
        let nativeRetryBtn = findNativeRetryButton();
        initiateAutoRetry(foundPattern, nativeRetryBtn);
      } else if (!isInfinite && currentAttempt >= settings.maxRetries && lastHandledErrorText !== foundPattern) {
        lastHandledErrorText = foundPattern;
        incrementStats('failed');
      }
    }
  }

  // Find native retry buttons on chat platforms (e.g. Gemini "Redo", ChatGPT "Regenerate")
  function findNativeRetryButton() {
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
        const btn = document.querySelector(sel);
        if (btn && btn.offsetHeight > 0 && !btn.disabled) {
          return btn;
        }
      } catch (err) {
        // Ignore CSS selector syntax errors on fallback
      }
    }

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        (text.includes('redo') || text.includes('retry') || text.includes('regenerate') || text.includes('try again')) &&
        btn.offsetHeight > 0 &&
        !btn.disabled
      ) {
        return btn;
      }
    }
    return null;
  }

  // Auto-Retry Controller
  function initiateAutoRetry(reason, nativeRetryBtn = null) {
    if (isRetrying) return;
    isRetrying = true;
    currentAttempt += 1;

    // Calculate delay
    const baseDelay = settings.delaySeconds || 5;
    const delay = settings.useExponentialBackoff
      ? baseDelay * Math.pow(2, currentAttempt - 1)
      : baseDelay;

    const isInfinite = settings.infiniteRetries === true || settings.maxRetries === 0;
    const maxDisplay = isInfinite ? '∞' : settings.maxRetries;

    updateBadge(`${currentAttempt}/${maxDisplay}`, '#F59E0B');

    // Show floating UI widget
    showRetryWidget(delay, currentAttempt, maxDisplay, reason, () => {
      // User clicked "Retry Now"
      clearTimeout(retryTimer);
      clearInterval(countdownInterval);
      executeRetry(nativeRetryBtn);
    }, () => {
      // User clicked "Cancel"
      clearTimeout(retryTimer);
      clearInterval(countdownInterval);
      removeWidget();
      isRetrying = false;
      userCancelledForCurrentError = true; // Prevent widget re-opening for current error
      updateBadge('', '');
    });

    // Start countdown
    retryTimer = setTimeout(() => {
      executeRetry(nativeRetryBtn);
    }, delay * 1000);
  }

  // Helper: Find "Try again" item in open secondary modal menu
  function findModalTryAgainButton() {
    const modalItems = Array.from(
      document.querySelectorAll('[role="menu"] [role="menuitem"], .cdk-overlay-pane [role="menuitem"], .mat-mdc-menu-item, [role="menuitem"]')
    );
    for (const el of modalItems) {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text.includes('try again') && el.offsetHeight > 0 && !el.disabled) {
        return el;
      }
    }
    return null;
  }

  // Execute actual retry step
  function executeRetry(nativeRetryBtn = null) {
    removeWidget();
    isRetrying = false;

    // Step 0: Check if secondary popup menu is ALREADY open
    const openModalBtn = findModalTryAgainButton();
    if (openModalBtn) {
      openModalBtn.click();
      incrementStats('success');
      updateBadge('OK', '#10B981');
      setTimeout(() => updateBadge('', ''), 3000);
      scrollIfNeeded();
      return;
    }

    // Step 1: Native Retry / Redo Button
    const freshNativeBtn = nativeRetryBtn || findNativeRetryButton();
    if (freshNativeBtn) {
      freshNativeBtn.click();
      incrementStats('success');

      // Step 2: Handle secondary popup menu if it opens (e.g. Gemini "Redo" -> menu with "Try again")
      setTimeout(() => {
        const secondaryBtn = findModalTryAgainButton();
        if (secondaryBtn) {
          secondaryBtn.click();
        }
      }, 300);

      updateBadge('OK', '#10B981');
      setTimeout(() => updateBadge('', ''), 3000);
      scrollIfNeeded();
      return;
    }

    // Step 3: Re-populate prompt input & submit as fallback
    const inputEl = getInputElement();
    const targetPrompt = lastPrompt || sessionStorage.getItem('auto_retry_last_prompt');

    if (inputEl && targetPrompt) {
      setInputValue(inputEl, targetPrompt);
      setTimeout(() => {
        const sendBtn = getSendButton();
        if (sendBtn) {
          sendBtn.click();
          incrementStats('success');
          updateBadge('OK', '#10B981');
          setTimeout(() => updateBadge('', ''), 3000);
          scrollIfNeeded();
        } else {
          incrementStats('failed');
        }
      }, 500);
    } else {
      incrementStats('failed');
    }
  }

  function scrollIfNeeded() {
    if (settings.autoScroll) {
      setTimeout(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }, 300);
    }
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

  console.log(`[Auto-Retry Extension] Initialized on ${platform}.`);
})();
