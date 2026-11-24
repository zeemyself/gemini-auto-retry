// Page-world (MAIN) script: keeps Gemini rendering, timing, and overlays alive
// in background tabs WITHOUT requiring chrome.debugger.
//
// Layers:
//   1. Spoofs Page Visibility + document.hasFocus() and blocks window blur /
//      overlay focusout while backgrounded so Angular Material menus stay open.
//   2. Unthrottles short setTimeout / setInterval timers (<= 5s) when hidden so
//      Chrome's 1s / 60s Intensive Wake Up Throttling never stalls Angular/RxJS.
//   3. Drives requestAnimationFrame catch-up bursts via MessageChannel whenever
//      native VSync (BeginMainFrame) pauses in a hidden tab.
//   4. Settles finite CSS/Web Animations after their real duration elapses.
//   5. Provides WeakRef-backed IntersectionObserver & ResizeObserver fallbacks
//      while native BeginMainFrame is paused so lazy action bars ("Redo") mount.
//   6. Passively observes Gemini StreamGenerate fetch/XHR lifecycle to trigger
//      instant frame flushes and notify content.js when streaming starts/ends.

(function () {
  if (window.__garPageVisibilityInstalled) return;
  window.__garPageVisibilityInstalled = true;

  let keepAliveEnabled = true;
  let bgHidden = false;

  // ---- 1. Visibility & Focus/Blur Protection ----
  const docProto = Document.prototype;
  const origHiddenGetter = Object.getOwnPropertyDescriptor(docProto, 'hidden')?.get;
  const realHidden = () => {
    try {
      return origHiddenGetter ? Boolean(origHiddenGetter.call(document)) : false;
    } catch (_) {
      return false;
    }
  };

  const isBackgrounded = () => keepAliveEnabled && (bgHidden || realHidden());

  const defineGetter = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch (_) {}
  };
  defineGetter(docProto, 'hidden', false);
  defineGetter(docProto, 'webkitHidden', false);
  defineGetter(docProto, 'visibilityState', 'visible');
  defineGetter(docProto, 'webkitVisibilityState', 'visible');
  try {
    docProto.hasFocus = function hasFocus() {
      return true;
    };
  } catch (_) {}

  window.addEventListener('gar:config', (e) => {
    let detail = e?.detail;
    if (typeof detail === 'string') {
      try {
        detail = JSON.parse(detail);
      } catch (_) {
        detail = null;
      }
    }
    if (detail && typeof detail === 'object') {
      keepAliveEnabled = detail.enabled !== false && detail.backgroundKeepAlive !== false;
    }
  });

  window.addEventListener('gar:bg-state', (e) => {
    const next = Boolean(e?.detail);
    if (next && !bgHidden) {
      virtualTs = performance.now();
      if (pendingRaf.size) scheduleFallbackFlush();
      flushDueTimers();
    }
    bgHidden = next;
    if (!next) {
      burstActive = false;
      flushFrames();
      flushDueTimers();
    }
  });

  const onVisibilityEvent = (e) => {
    if (!keepAliveEnabled) return;
    e.stopImmediatePropagation();
    if (e.type === 'visibilitychange') {
      const hidden = realHidden();
      window.dispatchEvent(new CustomEvent('gar:visibility', { detail: hidden ? 'hidden' : 'visible' }));
      if (hidden) {
        virtualTs = performance.now();
        scheduleFallbackFlush();
      } else {
        burstActive = false;
        flushFrames();
        flushDueTimers();
      }
    }
  };
  window.addEventListener('visibilitychange', onVisibilityEvent, true);
  window.addEventListener('webkitvisibilitychange', onVisibilityEvent, true);
  document.addEventListener('visibilitychange', onVisibilityEvent, true);

  // Prevent window-level blur from notifying Gemini/Angular that the browser lost
  // OS focus, and protect open CDK menu overlays from dismissing on null-target blur.
  window.addEventListener(
    'blur',
    (e) => {
      if (!isBackgrounded()) return;
      if (e.target === window || e.target === document) {
        e.stopImmediatePropagation();
        return;
      }
      if (e.relatedTarget === null && e.target?.closest?.('.cdk-overlay-pane, [role="menu"]')) {
        e.stopImmediatePropagation();
      }
    },
    true
  );

  window.addEventListener(
    'focusout',
    (e) => {
      if (!isBackgrounded()) return;
      if (e.relatedTarget === null && e.target?.closest?.('.cdk-overlay-pane, [role="menu"]')) {
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // ---- 2. Unthrottled Short Timer Shim (setTimeout / setInterval) ----
  // Saved at document_start before Zone.js / Angular wraps window timers.
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);

  const MAX_SHIM_TIMEOUT_MS = 5000;
  const ZERO_DELAY_THRESHOLD_MS = 4;
  const MAX_IMMEDIATE_HOPS = 32;

  const managedTimers = new Map(); // id -> { cb, args, dueAt, interval, nativeId, isInterval }
  let timerSeq = 0x20000000;
  let immediateHops = 0;
  let immediateResetQueued = false;
  const zeroDelayChannel = new MessageChannel();
  const diag = {
    framesRun: 0,
    bursts: 0,
    timersFired: 0,
    animsSettled: 0,
    runningAnims: 0,
    ioSynthesized: 0,
    roSynthesized: 0
  };

  function resetImmediateHopBudget() {
    if (immediateResetQueued) return;
    immediateResetQueued = true;
    nativeSetTimeout(() => {
      immediateHops = 0;
      immediateResetQueued = false;
    }, 16);
  }

  function invokeTimerEntry(id) {
    const entry = managedTimers.get(id);
    if (!entry) return;

    if (entry.nativeId) {
      nativeClearTimeout(entry.nativeId);
      entry.nativeId = 0;
    }

    if (entry.isInterval) {
      const step = Math.max(16, entry.interval);
      entry.dueAt = performance.now() + step;
      entry.nativeId = nativeSetTimeout(() => invokeTimerEntry(id), step);
    } else {
      managedTimers.delete(id);
    }

    diag.timersFired++;
    try {
      entry.cb(...entry.args);
    } catch (err) {
      nativeSetTimeout(() => {
        throw err;
      }, 0);
    }
  }

  zeroDelayChannel.port1.onmessage = (e) => {
    if (e.data === -1) {
      if (isNativeRafStalled()) pollHiddenObservers();
      return;
    }
    invokeTimerEntry(e.data);
  };

  function flushDueTimers(now = performance.now()) {
    if (!managedTimers.size) return;
    // Snapshot current ids so timers scheduled inside callbacks wait for their own turn
    const ids = Array.from(managedTimers.keys());
    for (const id of ids) {
      const entry = managedTimers.get(id);
      if (entry && entry.dueAt <= now + 1) {
        invokeTimerEntry(id);
      }
    }
  }

  function clearManagedOrNative(id, isIntervalClear) {
    const entry = managedTimers.get(id);
    if (entry) {
      managedTimers.delete(id);
      if (entry.nativeId) {
        nativeClearTimeout(entry.nativeId);
      }
      return;
    }
    if (isIntervalClear) {
      nativeClearInterval(id);
    } else {
      nativeClearTimeout(id);
    }
  }

  window.setTimeout = function setTimeout(cb, delay = 0, ...args) {
    if (typeof cb !== 'function') {
      return nativeSetTimeout(cb, delay, ...args);
    }
    const ms = Math.max(0, Number(delay) || 0);
    if (!isBackgrounded() || ms > MAX_SHIM_TIMEOUT_MS) {
      return nativeSetTimeout(cb, delay, ...args);
    }

    const id = ++timerSeq;
    const dueAt = performance.now() + ms;
    const entry = { cb, args, dueAt, interval: 0, nativeId: 0, isInterval: false };
    managedTimers.set(id, entry);

    if (ms <= ZERO_DELAY_THRESHOLD_MS && immediateHops < MAX_IMMEDIATE_HOPS) {
      immediateHops++;
      resetImmediateHopBudget();
      zeroDelayChannel.port2.postMessage(id);
    } else {
      entry.nativeId = nativeSetTimeout(() => invokeTimerEntry(id), ms);
    }
    return id;
  };

  window.clearTimeout = function clearTimeout(id) {
    clearManagedOrNative(id, false);
  };

  window.setInterval = function setInterval(cb, delay = 0, ...args) {
    if (typeof cb !== 'function') {
      return nativeSetInterval(cb, delay, ...args);
    }
    const ms = Math.max(0, Number(delay) || 0);
    if (!isBackgrounded() || ms > MAX_SHIM_TIMEOUT_MS) {
      return nativeSetInterval(cb, delay, ...args);
    }

    const step = Math.max(16, ms);
    const id = ++timerSeq;
    const entry = {
      cb,
      args,
      dueAt: performance.now() + step,
      interval: step,
      nativeId: 0,
      isInterval: true
    };
    managedTimers.set(id, entry);
    entry.nativeId = nativeSetTimeout(() => invokeTimerEntry(id), step);
    return id;
  };

  window.clearInterval = function clearInterval(id) {
    clearManagedOrNative(id, true);
  };

  // ---- 3. requestAnimationFrame Catch-Up Bursts ----
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const pendingRaf = new Map(); // fakeId -> { cb, nativeId }
  let rafSeq = 0x40000000;

  const NATIVE_RAF_STALL_MS = 120;
  let lastNativeRafTs = performance.now();
  let pendingStartTs = 0;

  function isNativeRafStalled() {
    if (!isBackgrounded()) return false;
    if (pendingRaf.size > 0) {
      return performance.now() - Math.max(lastNativeRafTs, pendingStartTs) > NATIVE_RAF_STALL_MS;
    }
    return performance.now() - lastNativeRafTs > NATIVE_RAF_STALL_MS;
  }

  function runFrame(id, ts) {
    const entry = pendingRaf.get(id);
    if (!entry) return;
    pendingRaf.delete(id);
    nativeCAF(entry.nativeId);
    try {
      entry.cb(ts);
    } catch (err) {
      nativeSetTimeout(() => {
        throw err;
      }, 0);
    }
  }

  function flushFrames(ts = performance.now()) {
    if (!pendingRaf.size) return;
    for (const id of Array.from(pendingRaf.keys())) {
      runFrame(id, ts);
    }
  }

  const FRAME_MS = 1000 / 60;
  const MAX_BURST_FRAMES = 120;
  const burstChannel = new MessageChannel();
  let virtualTs = performance.now();
  let burstActive = false;
  let burstFrames = 0;

  function startBurst() {
    if (burstActive || !pendingRaf.size || !isNativeRafStalled()) return;
    const now = performance.now();
    virtualTs = Math.max(virtualTs, now - MAX_BURST_FRAMES * FRAME_MS);
    burstActive = true;
    burstFrames = 0;
    diag.bursts++;
    burstChannel.port2.postMessage(0);
  }

  burstChannel.port1.onmessage = () => {
    const now = performance.now();
    if (!isBackgrounded() || !pendingRaf.size || now - lastNativeRafTs <= NATIVE_RAF_STALL_MS) {
      burstActive = false;
      virtualTs = now;
      return;
    }
    virtualTs = Math.min(virtualTs + FRAME_MS, now);
    flushFrames(virtualTs);
    flushDueTimers(now);
    burstFrames++;
    diag.framesRun++;
    if (virtualTs < now - 1 && burstFrames < MAX_BURST_FRAMES && pendingRaf.size) {
      burstChannel.port2.postMessage(0);
    } else {
      burstActive = false;
    }
  };

  let fallbackTimer = null;
  function scheduleFallbackFlush() {
    if (fallbackTimer) return;
    fallbackTimer = nativeSetTimeout(() => {
      fallbackTimer = null;
      if (!isBackgrounded()) return;
      flushDueTimers();
      if (isNativeRafStalled()) startBurst();
      if (pendingRaf.size) scheduleFallbackFlush();
    }, 200);
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (typeof cb !== 'function') return nativeRAF(cb);
    if (pendingRaf.size === 0 && !burstActive) {
      pendingStartTs = performance.now();
    }
    const id = ++rafSeq;
    const entry = { cb, nativeId: 0 };
    pendingRaf.set(id, entry);
    entry.nativeId = nativeRAF((ts) => {
      lastNativeRafTs = performance.now();
      runFrame(id, ts);
    });
    if (isBackgrounded()) scheduleFallbackFlush();
    return id;
  };

  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const entry = pendingRaf.get(id);
    if (entry) {
      pendingRaf.delete(id);
      nativeCAF(entry.nativeId);
    } else {
      nativeCAF(id);
    }
  };

  // ---- 4. Finite CSS / Web Animation Settling ----
  const animFirstSeen = new WeakMap();
  const settledAnims = new WeakSet();
  const syntheticCssEvents = new WeakMap();
  const ANIM_SETTLE_GRACE_MS = 80;

  const cssKey = (type, name, pseudo) => `${type}|${name}|${pseudo || ''}`;
  const suppressTrustedDuplicate = (e) => {
    if (!e.isTrusted) return;
    const set = syntheticCssEvents.get(e.target);
    const key = cssKey(e.type, e.animationName ?? e.propertyName, e.pseudoElement);
    if (set && set.delete(key)) e.stopImmediatePropagation();
  };
  window.addEventListener('animationend', suppressTrustedDuplicate, true);
  window.addEventListener('transitionend', suppressTrustedDuplicate, true);

  function dispatchCss(target, type, init) {
    if (!target || typeof target.dispatchEvent !== 'function') return;
    const key = cssKey(type, init.animationName ?? init.propertyName, init.pseudoElement);
    let set = syntheticCssEvents.get(target);
    if (!set) syntheticCssEvents.set(target, (set = new Set()));
    set.add(key);
    const Ctor = type === 'animationend' ? AnimationEvent : TransitionEvent;
    target.dispatchEvent(new Ctor(type, { bubbles: true, ...init }));
  }

  function settleAnimations() {
    if (typeof document.getAnimations !== 'function') return;
    const now = performance.now();
    let running = 0;
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running' || settledAnims.has(a)) continue;
      running++;
      let timing;
      try {
        timing = a.effect && a.effect.getComputedTiming();
      } catch (_) {
        continue;
      }
      const end = timing && timing.endTime;
      if (!Number.isFinite(end)) continue; // skip infinite spinners

      let seen = animFirstSeen.get(a);
      if (!seen) {
        const cur = Number(a.currentTime) || 0;
        seen = { at: now, remaining: Math.max(0, (end - cur) / Math.abs(a.playbackRate || 1)) };
        animFirstSeen.set(a, seen);
      }
      if (now - seen.at < seen.remaining + ANIM_SETTLE_GRACE_MS) continue;

      settledAnims.add(a);
      diag.animsSettled++;
      try {
        a.finish();
      } catch (_) {}
      const target = a.effect && a.effect.target;
      const pseudoElement = (a.effect && a.effect.pseudoElement) || '';
      const elapsedTime = (timing.activeDuration || 0) / 1000;
      try {
        if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) {
          dispatchCss(target, 'animationend', { animationName: a.animationName, elapsedTime, pseudoElement });
        } else if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) {
          dispatchCss(target, 'transitionend', { propertyName: a.transitionProperty, elapsedTime, pseudoElement });
        }
        a.dispatchEvent(
          new AnimationPlaybackEvent('finish', {
            currentTime: a.currentTime,
            timelineTime: document.timeline ? document.timeline.currentTime : null
          })
        );
      } catch (_) {}
    }
    diag.runningAnims = running;
  }

  // ---- 5. IntersectionObserver & ResizeObserver Hidden-Tab Fallbacks ----
  const NativeIO = window.IntersectionObserver;
  const ioRefs = new Set(); // Set<WeakRef<PatchedIntersectionObserver>>

  if (typeof NativeIO === 'function' && typeof WeakRef === 'function') {
    class PatchedIntersectionObserver extends NativeIO {
      #cb;
      #targets = new Map(); // Element -> boolean (lastIntersecting)
      #ref = null;

      constructor(cb, options) {
        let selfRef = null;
        super((entries, obs) => {
          if (selfRef) {
            for (const entry of entries) {
              if (selfRef.#targets.has(entry.target)) {
                selfRef.#targets.set(entry.target, Boolean(entry.isIntersecting));
              }
            }
          }
          cb(entries, obs);
        }, options);
        selfRef = this;
        this.#cb = cb;
      }

      observe(target) {
        super.observe(target);
        if (target && typeof target.getBoundingClientRect === 'function') {
          if (!this.#targets.has(target)) {
            this.#targets.set(target, null);
          }
          if (!this.#ref) {
            this.#ref = new WeakRef(this);
            ioRefs.add(this.#ref);
          }
          if (isNativeRafStalled()) {
            zeroDelayChannel.port2.postMessage(-1); // yield then pump on next tick
          }
        }
      }

      unobserve(target) {
        super.unobserve(target);
        this.#targets.delete(target);
        if (this.#targets.size === 0 && this.#ref) {
          ioRefs.delete(this.#ref);
          this.#ref = null;
        }
      }

      disconnect() {
        super.disconnect();
        this.#targets.clear();
        if (this.#ref) {
          ioRefs.delete(this.#ref);
          this.#ref = null;
        }
      }

      _pollHidden(now) {
        if (!this.#targets.size) return;
        const rootEl = this.root && this.root.getBoundingClientRect ? this.root : null;
        const rootRect = rootEl
          ? rootEl.getBoundingClientRect()
          : {
              top: 0,
              left: 0,
              bottom: window.innerHeight || 800,
              right: window.innerWidth || 1280,
              width: window.innerWidth || 1280,
              height: window.innerHeight || 800
            };

        const synthetic = [];
        for (const [el, prev] of this.#targets.entries()) {
          if (!el.isConnected) continue;
          const r = el.getBoundingClientRect();
          const ixLeft = Math.max(r.left, rootRect.left);
          const ixTop = Math.max(r.top, rootRect.top);
          const ixRight = Math.min(r.right, rootRect.right);
          const ixBottom = Math.min(r.bottom, rootRect.bottom);
          const ixW = Math.max(0, ixRight - ixLeft);
          const ixH = Math.max(0, ixBottom - ixTop);
          const hasArea = r.width > 0 || r.height > 0;
          // Include generous vertical margin below viewport so bottom-of-response
          // action bars ("Redo") behind @defer(on viewport) mount on long replies.
          const isIntersecting =
            hasArea &&
            r.right >= rootRect.left &&
            r.left <= rootRect.right &&
            r.bottom >= rootRect.top - 1000 &&
            r.top <= rootRect.bottom + 8000;

          if (prev === isIntersecting) continue;
          this.#targets.set(el, isIntersecting);
          const area = r.width * r.height;
          const ratio = isIntersecting ? (area > 0 ? Math.min(1, (ixW * ixH) / area) : 1) : 0;
          synthetic.push({
            time: now,
            target: el,
            rootBounds: rootRect,
            boundingClientRect: r,
            intersectionRect: isIntersecting
              ? { top: ixTop, left: ixLeft, bottom: ixBottom, right: ixRight, width: ixW, height: ixH, x: ixLeft, y: ixTop }
              : { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 },
            isIntersecting,
            intersectionRatio: ratio,
            isVisible: isIntersecting
          });
        }

        if (synthetic.length) {
          diag.ioSynthesized += synthetic.length;
          try {
            this.#cb(synthetic, this);
          } catch (_) {}
        }
      }
    }

    try {
      Object.defineProperty(PatchedIntersectionObserver, 'name', { value: 'IntersectionObserver' });
      window.IntersectionObserver = PatchedIntersectionObserver;
    } catch (_) {}
  }

  const NativeRO = window.ResizeObserver;
  const roRefs = new Set(); // Set<WeakRef<PatchedResizeObserver>>

  if (typeof NativeRO === 'function' && typeof WeakRef === 'function') {
    class PatchedResizeObserver extends NativeRO {
      #cb;
      #targets = new Map(); // Element -> { w, h }
      #ref = null;

      constructor(cb) {
        let selfRef = null;
        super((entries, obs) => {
          if (selfRef) {
            for (const entry of entries) {
              if (selfRef.#targets.has(entry.target)) {
                const cr = entry.contentRect;
                selfRef.#targets.set(entry.target, { w: Math.round(cr.width), h: Math.round(cr.height) });
              }
            }
          }
          cb(entries, obs);
        });
        selfRef = this;
        this.#cb = cb;
      }

      observe(target, options) {
        super.observe(target, options);
        if (target && typeof target.getBoundingClientRect === 'function') {
          if (!this.#targets.has(target)) {
            this.#targets.set(target, null);
          }
          if (!this.#ref) {
            this.#ref = new WeakRef(this);
            roRefs.add(this.#ref);
          }
        }
      }

      unobserve(target) {
        super.unobserve(target);
        this.#targets.delete(target);
        if (this.#targets.size === 0 && this.#ref) {
          roRefs.delete(this.#ref);
          this.#ref = null;
        }
      }

      disconnect() {
        super.disconnect();
        this.#targets.clear();
        if (this.#ref) {
          roRefs.delete(this.#ref);
          this.#ref = null;
        }
      }

      _pollHidden() {
        if (!this.#targets.size) return;
        const synthetic = [];
        for (const [el, prev] of this.#targets.entries()) {
          if (!el.isConnected) continue;
          const r = el.getBoundingClientRect();
          const w = Math.round(r.width);
          const h = Math.round(r.height);
          if (prev && prev.w === w && prev.h === h) continue;
          this.#targets.set(el, { w, h });
          const box = [{ inlineSize: r.width, blockSize: r.height }];
          synthetic.push({
            target: el,
            contentRect: r,
            borderBoxSize: box,
            contentBoxSize: box,
            devicePixelContentBoxSize: box
          });
        }
        if (synthetic.length) {
          diag.roSynthesized += synthetic.length;
          try {
            this.#cb(synthetic, this);
          } catch (_) {}
        }
      }
    }

    try {
      Object.defineProperty(PatchedResizeObserver, 'name', { value: 'ResizeObserver' });
      window.ResizeObserver = PatchedResizeObserver;
    } catch (_) {}
  }

  function pollHiddenObservers() {
    const now = performance.now();
    for (const ref of Array.from(ioRefs)) {
      const obs = ref.deref();
      if (!obs) ioRefs.delete(ref);
      else obs._pollHidden(now);
    }
    for (const ref of Array.from(roRefs)) {
      const obs = ref.deref();
      if (!obs) roRefs.delete(ref);
      else obs._pollHidden();
    }
  }

  // ---- 6. Read-Only Gemini StreamGenerate Lifecycle Hook (fetch + XHR) ----
  let activeStreams = 0;

  function isGeminiStreamUrl(url) {
    if (typeof url !== 'string') return false;
    return (
      url.includes('StreamGenerate') ||
      url.includes('BardFrontendService') ||
      (url.includes('assistant.lamda') && /Generate/i.test(url))
    );
  }

  function emitStreamState(extra = {}) {
    window.dispatchEvent(
      new CustomEvent('gar:gen-state', {
        detail: JSON.stringify({
          generating: activeStreams > 0,
          activeStreams,
          ts: Date.now(),
          ...extra
        })
      })
    );
  }

  function onStreamStart() {
    activeStreams++;
    emitStreamState({ event: 'start' });
  }

  function onStreamEnd(status = 0, networkError = false) {
    activeStreams = Math.max(0, activeStreams - 1);
    if (isBackgrounded()) {
      flushDueTimers();
      if (isNativeRafStalled()) startBurst();
      settleAnimations();
      if (isNativeRafStalled()) pollHiddenObservers();
    }
    emitStreamState({
      event: 'end',
      status,
      networkError: Boolean(networkError || (status >= 400 && status < 600))
    });
  }

  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function fetch(input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input?.url || String(input || '');
      } catch (_) {}
      if (!isGeminiStreamUrl(url)) {
        return nativeFetch(input, init);
      }

      onStreamStart();
      return nativeFetch(input, init).then(
        (res) => {
          const status = res?.status || 200;
          // Clone or monitor body completion without consuming Gemini's stream
          if (res?.body && typeof res.clone === 'function') {
            try {
              const clone = res.clone();
              const reader = clone.body?.getReader?.();
              if (reader) {
                const pump = () =>
                  reader.read().then(
                    ({ done }) => (done ? onStreamEnd(status, false) : pump()),
                    () => onStreamEnd(status, true)
                  );
                pump();
                return res;
              }
            } catch (_) {}
          }
          onStreamEnd(status, false);
          return res;
        },
        (err) => {
          onStreamEnd(0, true);
          throw err;
        }
      );
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const xhrUrlMap = new WeakMap();

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      try {
        xhrUrlMap.set(this, typeof url === 'string' ? url : String(url || ''));
      } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(body) {
      const url = xhrUrlMap.get(this) || '';
      if (isGeminiStreamUrl(url)) {
        let ended = false;
        onStreamStart();
        const finish = (netErr) => {
          if (ended) return;
          ended = true;
          let status = 0;
          try {
            status = this.status || 0;
          } catch (_) {}
          onStreamEnd(status, netErr);
        };
        this.addEventListener('loadend', () => finish(false), { once: true });
        this.addEventListener('error', () => finish(true), { once: true });
        this.addEventListener('abort', () => finish(false), { once: true });
        this.addEventListener('timeout', () => finish(true), { once: true });
      }
      return origSend.call(this, body);
    };
  }

  // ---- 7. Heartbeat & Immediate Flush Coordination ----
  function runBackgroundMaintenance() {
    const hidden = isBackgrounded();
    const stalled = isNativeRafStalled();
    if (hidden) {
      flushDueTimers();
      if (stalled) {
        startBurst();
        pollHiddenObservers();
      }
      settleAnimations();
    }
    return { hidden, stalled };
  }

  // Triggered by content.js right after clicking Redo / opening menus so overlays
  // mount and animate in <150ms even between background heartbeat ticks.
  window.addEventListener('gar:flush-now', () => {
    if (!isBackgrounded()) return;
    let pulses = 0;
    const pulseChannel = new MessageChannel();
    pulseChannel.port1.onmessage = () => {
      runBackgroundMaintenance();
      if (++pulses < 8 && isBackgrounded()) {
        nativeSetTimeout(() => pulseChannel.port2.postMessage(0), 35);
      }
    };
    pulseChannel.port2.postMessage(0);
  });

  window.addEventListener('gar:tick', () => {
    const { stalled } = runBackgroundMaintenance();
    window.dispatchEvent(
      new CustomEvent('gar:stats', {
        detail: JSON.stringify({
          pendingRAF: pendingRaf.size,
          managedTimers: managedTimers.size,
          activeStreams,
          bgHidden,
          realHidden: realHidden(),
          nativeRafStalled: stalled,
          ...diag
        })
      })
    );
  });
})();
