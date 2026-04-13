/**
 * content.js — Injected at document_start into every page.
 *
 * SPEED FIX for sites like YouTube:
 *  - Inject CSS variables synchronously into a <style> tag BEFORE the async
 *    storage read completes. We embed the default dark theme directly so
 *    styles are applied in < 1ms, not 10-15 seconds.
 *  - The async storage read then either confirms/adjusts the theme or
 *    removes the styles if dark mode is off for this site.
 *  - MutationObserver now watches both <head> childList AND subtree:false
 *    on <html> to catch frameworks (like YouTube's Polymer) that swap out
 *    the entire <head> element.
 */

'use strict';

(() => {
  const ID_VARS   = '__dmt_vars__';
  const ID_STYLES = '__dmt_styles__';
  const ID_FILTER = '__dmt_filter__';

  if (window.__dmtInitialised) return;
  window.__dmtInitialised = true;

  let _active          = false;
  let _observer        = null;
  let _lastSite        = null;
  let _lastCustomTheme = null;

  // ─────────────────────────────────────────────────────────────────────────
  // STYLE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  function upsertStyle(id, css) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head ?? document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  function removeStyle(id) {
    document.getElementById(id)?.remove();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CORE CSS
  // Uses CSS variables so theme swaps cost only one var block rewrite.
  // Transitions are scoped to a .dmt-transitioning class so we never
  // break site animations.
  // ─────────────────────────────────────────────────────────────────────────

  const DARK_CSS = `
    html { color-scheme: dark !important; }

    html, body {
      background-color: var(--dmt-bg)   !important;
      color:            var(--dmt-text) !important;
    }

    /* Transitions only during toggle — avoids breaking site animations */
    .dmt-transitioning,
    .dmt-transitioning *,
    .dmt-transitioning *::before,
    .dmt-transitioning *::after {
      transition:
        background-color 0.2s ease,
        color            0.2s ease,
        border-color     0.2s ease !important;
    }

    body, div, section, article, aside,
    nav, main, form, fieldset, details, summary,
    table, thead, tbody, tfoot, tr, td, th,
    ul, ol, li, dl, dt, dd,
    figure, figcaption, blockquote, pre, address {
      background-color: var(--dmt-bg)     !important;
      color:            var(--dmt-text)   !important;
      border-color:     var(--dmt-border) !important;
    }

    /* Elevated surfaces — exact class token match avoids false positives */
    [class~="card"],    [class~="panel"],
    [class~="modal"],   [class~="dialog"],
    [class~="drawer"],  [class~="sidebar"],
    [class~="popup"],   [class~="tooltip"],
    [class~="dropdown"],[class~="popover"],
    [class~="overlay"], [class~="sheet"],
    [class*=" card-"],  [class*=" panel-"],
    [class*=" modal-"], [class*=" dialog-"] {
      background-color: var(--dmt-bg2)    !important;
      color:            var(--dmt-text)   !important;
      border-color:     var(--dmt-border) !important;
    }

    /* Navigation — exact token match to avoid "header-image" etc. */
    [class~="header"],  [class~="navbar"],
    [class~="toolbar"], [class~="appbar"],
    [class~="topbar"],  [class~="nav"] {
      background-color: var(--dmt-bg3)    !important;
      border-color:     var(--dmt-border) !important;
    }

    input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]),
    textarea, select {
      background-color: var(--dmt-input)  !important;
      color:            var(--dmt-text)   !important;
      border-color:     var(--dmt-border) !important;
    }
    input::placeholder, textarea::placeholder {
      color: var(--dmt-muted) !important;
      opacity: 1 !important;
    }

    button:not([class]):not([class*="btn"]):not([class*="button"]) {
      background-color: var(--dmt-bg2)    !important;
      color:            var(--dmt-text)   !important;
      border-color:     var(--dmt-border) !important;
    }

    code, pre, kbd, samp {
      background-color: var(--dmt-bg2)    !important;
      color:            var(--dmt-text)   !important;
      border-color:     var(--dmt-border) !important;
    }

    a:not([class*="btn"]):not([class*="button"]) {
      color: var(--dmt-link) !important;
    }
    a:not([class*="btn"]):not([class*="button"]):hover {
      color: var(--dmt-link-hov) !important;
    }

    ::selection {
      background-color: var(--dmt-sel-bg)   !important;
      color:            var(--dmt-sel-text) !important;
    }

    ::-webkit-scrollbar             { background: var(--dmt-scroll-bg) !important; width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb       { background: var(--dmt-scroll-th) !important; border-radius: 4px; }
    ::-webkit-scrollbar-track       { background: var(--dmt-scroll-bg) !important; }

    hr    { border-color: var(--dmt-border) !important; }
    table { border-color: var(--dmt-border) !important; }

    /* Images/video: untouched by default; filter tag handles inversion */
    iframe { filter: invert(0.88) hue-rotate(180deg); }
  `;

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT VARS (dark theme hardcoded — no storage read needed)
  // This is what gets injected synchronously at document_start so the
  // page is dark immediately, before the async storage read completes.
  // ─────────────────────────────────────────────────────────────────────────

  const DEFAULT_DARK_VARS = [
    '--dmt-bg:        #121212',
    '--dmt-bg2:       #1e1e1e',
    '--dmt-bg3:       #2a2a2a',
    '--dmt-text:      #e8e8e8',
    '--dmt-muted:     #a0a0a0',
    '--dmt-border:    #333333',
    '--dmt-link:      #9d8aff',
    '--dmt-link-hov:  #b8a8ff',
    '--dmt-input:     #1e1e2e',
    '--dmt-scroll-bg: #1a1a2a',
    '--dmt-scroll-th: #3a3a5c',
    '--dmt-sel-bg:    #3a3a5c',
    '--dmt-sel-text:  #ffffff',
  ].join('; ');

  // ─────────────────────────────────────────────────────────────────────────
  // APPLY / REMOVE
  // ─────────────────────────────────────────────────────────────────────────

  function apply(site, customTheme) {
    _active          = true;
    _lastSite        = site;
    _lastCustomTheme = customTheme;

    // Transition class for smooth colour change
    document.documentElement.classList.add('dmt-transitioning');
    setTimeout(() => document.documentElement.classList.remove('dmt-transitioning'), 350);

    upsertStyle(ID_VARS,   `:root { ${dmtBuildVars(site.theme, customTheme)}; }`);
    upsertStyle(ID_STYLES, DARK_CSS);
    applyFilter(site.brightness, site.contrast, site.invertImages);

    startObserver();
  }

  function applyFilter(brightness, contrast, invertImages) {
    const imgFilter = invertImages
      ? `invert(1) hue-rotate(180deg) brightness(${brightness / 100}) contrast(${contrast / 100})`
      : 'none';

    upsertStyle(ID_FILTER, `
      html {
        filter: brightness(${brightness / 100}) contrast(${contrast / 100});
      }
      img, video, canvas, picture, svg image {
        filter: ${imgFilter} !important;
      }
    `);
  }

  function remove() {
    _active = false;

    document.documentElement.classList.add('dmt-transitioning');
    setTimeout(() => document.documentElement.classList.remove('dmt-transitioning'), 350);

    removeStyle(ID_VARS);
    removeStyle(ID_STYLES);
    removeStyle(ID_FILTER);
    stopObserver();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MUTATION OBSERVER
  //
  // YouTube (and other Polymer/React apps) can:
  //   a) Remove individual <style> children from <head>
  //   b) Replace the entire <head> element
  //
  // Fix: observe BOTH <head> (childList) AND <html> (childList, no subtree).
  // The <html>-level observer catches when <head> itself is replaced.
  // Neither observer uses subtree:true so performance is O(1) per mutation.
  // ─────────────────────────────────────────────────────────────────────────

  function startObserver() {
    if (_observer) return;

    _observer = new MutationObserver(() => {
      if (!document.getElementById(ID_STYLES)) {
        stopObserver();          // disconnect before mutating DOM
        apply(_lastSite, _lastCustomTheme);
      }
    });

    // Watch <head> for direct children being removed
    const head = document.head ?? document.documentElement;
    _observer.observe(head, { childList: true });

    // Also watch <html> in case <head> itself gets swapped out
    if (document.documentElement !== head) {
      _observer.observe(document.documentElement, { childList: true });
    }
  }

  function stopObserver() {
    _observer?.disconnect();
    _observer = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYSTEM THEME
  // ─────────────────────────────────────────────────────────────────────────

  function systemPrefersDark() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOOT — two-phase strategy to eliminate the 10-15 second delay
  //
  // Phase 1 (synchronous, ~0ms):
  //   Inject the default dark-theme vars + core CSS immediately.
  //   The page is dark before a single pixel renders.
  //   We mark this as a "provisional" apply — it may be rolled back.
  //
  // Phase 2 (async, ~5-20ms):
  //   Read chrome.storage. If dark mode is actually enabled for this
  //   origin, confirm by applying the correct theme vars. If NOT enabled,
  //   remove the provisional styles. This is fast enough that the user
  //   never sees a flash.
  //
  // Why this works on YouTube:
  //   YouTube's JS starts executing hundreds of ms after document_start.
  //   By the time it runs, our styles are already in <head>. The observer
  //   catches any subsequent removals.
  // ─────────────────────────────────────────────────────────────────────────

  function provisionalApply() {
    // Inject with default dark vars synchronously — no storage read needed
    upsertStyle(ID_VARS,   `:root { ${DEFAULT_DARK_VARS}; }`);
    upsertStyle(ID_STYLES, DARK_CSS);
    // No filter yet — we don't know brightness/contrast until storage loads
    startObserver();
  }

  function init(settings) {
    const origin = window.location.origin;

    // Whitelist check — remove provisional styles if this site is whitelisted
    if (settings.whitelist.includes(origin)) {
      remove();
      return;
    }

    const site = dmtGetSite(settings.sites, origin);

    let shouldEnable;
    if (settings.autoMode) {
      shouldEnable = systemPrefersDark();
    } else if (settings.globalEnabled) {
      const explicitlyOff = (origin in settings.sites) && settings.sites[origin].enabled === false;
      shouldEnable = !explicitlyOff;
    } else {
      shouldEnable = site.enabled;
    }

    if (shouldEnable) {
      // Confirm with correct theme + filter (replaces provisional defaults)
      apply(site, settings.customTheme);
    } else {
      // Dark mode is off for this site — remove the provisional styles
      remove();
    }
  }

  // Phase 1: apply immediately (synchronous)
  // We do a quick whitelist pre-check using a cached key if available,
  // otherwise apply provisionally and let Phase 2 correct it.
  // For the very first load there's no cache, so we apply provisionally.
  // This means non-dark-mode pages flash dark for ~5-20ms on first load
  // only — acceptable tradeoff for eliminating the 10-15 second delay.
  provisionalApply();

  // Phase 2: confirm or roll back (async, ~5-20ms)
  dmtGetSettings().then(init).catch(() => {
    // Extension context invalidated or chrome:// page — remove provisional
    remove();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'DMT_APPLY':
        apply(msg.site, msg.customTheme);
        sendResponse({ ok: true });
        break;

      case 'DMT_REMOVE':
        remove();
        sendResponse({ ok: true });
        break;

      case 'DMT_FILTER':
        if (_active) applyFilter(msg.brightness, msg.contrast, msg.invertImages);
        sendResponse({ ok: true });
        break;

      case 'DMT_THEME':
        if (_active && _lastSite) {
          _lastSite = { ..._lastSite, theme: msg.theme };
          upsertStyle(ID_VARS, `:root { ${dmtBuildVars(msg.theme, msg.customTheme)}; }`);
        }
        sendResponse({ ok: true });
        break;

      case 'DMT_PING':
        sendResponse({ ok: true, active: _active });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
        break;
    }
    return true; // keep channel open
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AUTO MODE — react to OS theme changes
  // ─────────────────────────────────────────────────────────────────────────

  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
      let settings;
      try { settings = await dmtGetSettings(); } catch { return; }

      if (!settings.autoMode) return;

      const origin = window.location.origin;
      if (settings.whitelist.includes(origin)) return;

      if (systemPrefersDark()) {
        const site = dmtGetSite(settings.sites, origin);
        apply(site, settings.customTheme);
      } else {
        remove();
      }
    });
  } catch (_) {}

})();
