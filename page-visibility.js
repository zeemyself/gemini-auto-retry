// Page-world (MAIN) script: keeps Gemini rendering while its tab is in the background.
//
// Works as a hybrid defense-in-depth layer alongside chrome.debugger focus emulation:
//   1. Makes the page always appear visible/focused to Gemini (covers document_start
//      before debugger attaches, plus fallback when DevTools detaches the debugger).
//   2. Receives the browser's true background state (`gar:bg-state`) from the service
//      worker via content.js, because CDP focus emulation overrides document.hidden.
//   3. Patches requestAnimationFrame and settles finite animations ONLY when the tab
//      is truly backgrounded AND Chromium's native rAF has actually stalled, so it
//      never interferes when native 60fps rendering is active.

(function () {
  if (window.__garPageVisibilityInstalled) return;
  window.__garPageVisibilityInstalled = true;

  // ---- 1. Visibility spoofing ----
  const docProto = Document.prototype;
  const origHiddenGetter = Object.getOwnPropertyDescriptor(docProto, 'hidden')?.get;
  const realHidden = () => (origHiddenGetter ? origHiddenGetter.call(document) : false);

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
    docProto.hasFocus = function () { return true; };
  } catch (_) {}

  // Browser-level background state pushed from background.js -> content.js
  let bgHidden = false;
  const isBackgrounded = () => bgHidden || realHidden();

  window.addEventListener('gar:bg-state', (e) => {
    const next = Boolean(e.detail);
    if (next && !bgHidden) {
      virtualTs = performance.now();
      if (pending.size) scheduleFallbackFlush();
    }
    bgHidden = next;
    if (!next) {
      burstActive = false;
      flushFrames();
    }
  });

  // Intercept visibility events at the earliest point (window, capture phase)
  // so Gemini never learns the tab is hidden. Forward the real state to the
  // extension content script via a private event.
  const onVisibilityEvent = (e) => {
    e.stopImmediatePropagation();
    if (e.type === 'visibilitychange') {
      const hidden = realHidden();
      window.dispatchEvent(new CustomEvent('gar:visibility', { detail: hidden ? 'hidden' : 'visible' }));
      if (hidden) {
        virtualTs = performance.now();
        scheduleFallbackFlush();
      } else {
        flushFrames();
      }
    }
  };
  window.addEventListener('visibilitychange', onVisibilityEvent, true);
  window.addEventListener('webkitvisibilitychange', onVisibilityEvent, true);

  // ---- 2. requestAnimationFrame that keeps running if native VSync pauses ----
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map(); // fakeId -> { cb, nativeId }
  let seq = 0x40000000; // separate id range from native ids

  const NATIVE_RAF_STALL_MS = 150;
  let lastNativeRafTs = performance.now();
  let pendingStartTs = 0;

  function isNativeRafStalled() {
    if (!pending.size) return false;
    return performance.now() - Math.max(lastNativeRafTs, pendingStartTs) > NATIVE_RAF_STALL_MS;
  }

  function runFrame(id, ts) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    nativeCAF(entry.nativeId);
    try {
      entry.cb(ts);
    } catch (err) {
      setTimeout(() => { throw err; }); // report without breaking the flush loop
    }
  }

  function flushFrames(ts = performance.now()) {
    if (!pending.size) return;
    // Snapshot: callbacks that re-request a frame run on the next flush.
    for (const id of Array.from(pending.keys())) runFrame(id, ts);
  }

  // ---- Catch-up bursts ----
  // Gemini reveals responses progressively, frame by frame, and only shows the
  // action bar (Redo, etc.) once the reveal finishes. One frame per heartbeat
  // is far too slow, so each tick replays the frames missed since the last one
  // (~60 per elapsed second) whenever native rAF has stalled in the background.
  const FRAME_MS = 1000 / 60;
  const MAX_BURST_FRAMES = 120;
  const burstChannel = new MessageChannel();
  let virtualTs = performance.now();
  let burstActive = false;
  let burstFrames = 0;
  const diag = { framesRun: 0, bursts: 0 };

  function startBurst() {
    if (burstActive || !pending.size || !isNativeRafStalled()) return;
    const now = performance.now();
    virtualTs = Math.max(virtualTs, now - MAX_BURST_FRAMES * FRAME_MS);
    burstActive = true;
    burstFrames = 0;
    diag.bursts++;
    burstChannel.port2.postMessage(0);
  }

  burstChannel.port1.onmessage = () => {
    const now = performance.now();
    // Stop immediately if foregrounded, queue drained, or native rAF resumed
    if (!isBackgrounded() || !pending.size || now - lastNativeRafTs <= NATIVE_RAF_STALL_MS) {
      burstActive = false;
      virtualTs = now; // don't "catch up" on idle time later
      return;
    }
    virtualTs = Math.min(virtualTs + FRAME_MS, now);
    flushFrames(virtualTs);
    burstFrames++;
    diag.framesRun++;
    if (virtualTs < now - 1 && burstFrames < MAX_BURST_FRAMES && pending.size) {
      burstChannel.port2.postMessage(0);
    } else {
      burstActive = false;
    }
  };

  let fallbackTimer = null;
  function scheduleFallbackFlush() {
    if (fallbackTimer) return;
    // Throttled by Chrome while hidden (>=1s), but keeps things moving even
    // without heartbeat ticks.
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      if (!isBackgrounded()) return;
      if (isNativeRafStalled()) startBurst();
      if (pending.size) scheduleFallbackFlush();
    }, 250);
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (typeof cb !== 'function') return nativeRAF(cb); // preserve native TypeError
    if (pending.size === 0 && !burstActive) {
      pendingStartTs = performance.now();
    }
    const id = ++seq;
    const entry = { cb, nativeId: 0 };
    pending.set(id, entry);
    entry.nativeId = nativeRAF((ts) => {
      lastNativeRafTs = performance.now();
      runFrame(id, ts);
    });
    if (isBackgrounded()) scheduleFallbackFlush();
    return id;
  };

  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      nativeCAF(entry.nativeId);
    } else {
      nativeCAF(id);
    }
  };

  // ---- 3. Animation settling ----
  // Hidden tabs may pause CSS/Web Animations, preventing `animationend`,
  // `transitionend` and Animation `finish` events from firing. While backgrounded,
  // finish each finite animation once its real duration (+100ms grace) has elapsed
  // if it is still stuck in 'running'. Naturally completing animations finish on
  // their own before the grace period and are skipped automatically.
  const animFirstSeen = new WeakMap(); // Animation -> { at, remaining }
  const settled = new WeakSet();
  const syntheticCssEvents = new WeakMap(); // target -> Set("type|name|pseudo")
  const ANIM_SETTLE_GRACE_MS = 100;
  diag.animsSettled = 0;
  diag.runningAnims = 0;

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
      if (a.playState !== 'running' || settled.has(a)) continue;
      running++;
      let timing;
      try { timing = a.effect && a.effect.getComputedTiming(); } catch (_) { continue; }
      const end = timing && timing.endTime;
      if (!Number.isFinite(end)) continue; // skip infinite loops (spinners)

      let seen = animFirstSeen.get(a);
      if (!seen) {
        const cur = Number(a.currentTime) || 0;
        seen = { at: now, remaining: Math.max(0, (end - cur) / Math.abs(a.playbackRate || 1)) };
        animFirstSeen.set(a, seen);
      }
      if (now - seen.at < seen.remaining + ANIM_SETTLE_GRACE_MS) continue;

      settled.add(a);
      diag.animsSettled++;
      try { a.finish(); } catch (_) {}
      const target = a.effect && a.effect.target;
      const pseudoElement = (a.effect && a.effect.pseudoElement) || '';
      const elapsedTime = (timing.activeDuration || 0) / 1000;
      try {
        if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) {
          dispatchCss(target, 'animationend', { animationName: a.animationName, elapsedTime, pseudoElement });
        } else if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) {
          dispatchCss(target, 'transitionend', { propertyName: a.transitionProperty, elapsedTime, pseudoElement });
        }
        a.dispatchEvent(new AnimationPlaybackEvent('finish', {
          currentTime: a.currentTime,
          timelineTime: document.timeline ? document.timeline.currentTime : null
        }));
      } catch (_) {}
    }
    diag.runningAnims = running;
  }

  // Heartbeat ticks from the content script (unthrottled message tasks).
  window.addEventListener('gar:tick', () => {
    const hidden = isBackgrounded();
    const stalled = isNativeRafStalled();
    if (hidden) {
      if (stalled) startBurst();
      settleAnimations();
    }
    // Diagnostics for the content script (primitive detail crosses worlds).
    window.dispatchEvent(new CustomEvent('gar:stats', {
      detail: JSON.stringify({
        pendingRAF: pending.size,
        bgHidden,
        realHidden: realHidden(),
        nativeRafStalled: stalled,
        ...diag
      })
    }));
  });
})();
