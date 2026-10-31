// Page-world (MAIN) script: keeps Gemini rendering while its tab is in the background.
//
// Chrome pauses requestAnimationFrame in hidden tabs and Gemini defers rendering
// while document.hidden is true, so error/refusal text never reaches the DOM
// until the tab is focused again. This script:
//   1. Makes the page always appear visible/focused to Gemini.
//   2. Patches requestAnimationFrame so queued callbacks are still flushed while
//      hidden, driven by `gar:tick` events from the content script (which in turn
//      come from the unthrottled service-worker heartbeat) plus a timer fallback.
//
// The extension's content script runs in an isolated world and still sees the
// real visibility values; it is notified of changes via a `gar:visibility` event.

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
      } else flushFrames();
    }
  };
  window.addEventListener('visibilitychange', onVisibilityEvent, true);
  window.addEventListener('webkitvisibilitychange', onVisibilityEvent, true);

  // ---- 2. requestAnimationFrame that keeps running while hidden ----
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const pending = new Map(); // fakeId -> { cb, nativeId }
  let seq = 0x40000000; // separate id range from native ids

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
  // (~60 per elapsed second). Each frame runs as its own MessageChannel task:
  // these aren't throttled in hidden tabs, and microtasks (promises, Angular
  // change detection) run between frames just as they do in a real frame loop.
  const FRAME_MS = 1000 / 60;
  const MAX_BURST_FRAMES = 120;
  const burstChannel = new MessageChannel();
  let virtualTs = performance.now();
  let burstActive = false;
  let burstFrames = 0;
  const diag = { framesRun: 0, bursts: 0 };

  function startBurst() {
    if (burstActive || !pending.size) return;
    const now = performance.now();
    virtualTs = Math.max(virtualTs, now - MAX_BURST_FRAMES * FRAME_MS);
    burstActive = true;
    burstFrames = 0;
    diag.bursts++;
    burstChannel.port2.postMessage(0);
  }

  burstChannel.port1.onmessage = () => {
    const now = performance.now();
    if (!realHidden() || !pending.size) {
      burstActive = false;
      virtualTs = now; // don't "catch up" on idle time later
      return;
    }
    virtualTs = Math.min(virtualTs + FRAME_MS, now);
    flushFrames(virtualTs);
    burstFrames++;
    diag.framesRun++;
    if (virtualTs < now - 1 && burstFrames < MAX_BURST_FRAMES) {
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
      if (!realHidden()) return;
      startBurst();
      if (pending.size) scheduleFallbackFlush();
    }, 250);
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (typeof cb !== 'function') return nativeRAF(cb); // preserve native TypeError
    const id = ++seq;
    const entry = { cb, nativeId: 0 };
    pending.set(id, entry);
    entry.nativeId = nativeRAF((ts) => runFrame(id, ts));
    if (realHidden()) scheduleFallbackFlush();
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
  // Hidden tabs never advance CSS/Web Animations, so `animationend`,
  // `transitionend` and Animation `finish` events never fire. Gemini (Angular)
  // waits for these before showing the next part of a response and its action
  // bar. While hidden, finish each finite animation once its real duration has
  // elapsed and dispatch the completion events ourselves. Real (trusted)
  // duplicates of CSS events that Chrome delivers later are suppressed.
  const animFirstSeen = new WeakMap(); // Animation -> { at, remaining }
  const settled = new WeakSet();
  const syntheticCssEvents = new WeakMap(); // target -> Set("type|name|pseudo")
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
      if (now - seen.at < seen.remaining) continue;

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
    if (realHidden()) {
      startBurst();
      settleAnimations();
    }
    // Diagnostics for the content script (primitive detail crosses worlds).
    window.dispatchEvent(new CustomEvent('gar:stats', {
      detail: JSON.stringify({ pendingRAF: pending.size, ...diag })
    }));
  });
})();
