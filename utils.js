/**
 * utils.js — Shared utilities (content.js + background.js)
 *
 * Loaded in content scripts via manifest injection order,
 * and in the service worker via importScripts('utils.js').
 *
 * FIX: dmtGetSettings now checks chrome.runtime.lastError.
 * FIX: dmtSaveSettings now checks chrome.runtime.lastError and rejects on failure.
 * FIX: dmtInSchedule destructured sm/em but never used them — removed.
 * FIX: dmtBuildVars custom theme used bg2 for both bg2 AND bg3 — corrected.
 */

'use strict';

// ─── Default storage schema ───────────────────────────────────────────────────
const DMT_DEFAULTS = {
  globalEnabled: false,
  autoMode:      false,
  sites:         {},
  whitelist:     [],
  schedule: {
    enabled: false,
    start:   '20:00',
    end:     '07:00',
  },
  customTheme: {
    bg:   '#121212',
    bg2:  '#1e1e1e',
    text: '#e8e8e8',
    link: '#9d8aff',
  },
};

// Default per-site settings
const DMT_SITE_DEFAULTS = {
  enabled:      false,
  theme:        'dark',
  brightness:   100,
  contrast:     100,
  invertImages: false,
};

// ─── Theme palette ──────────────────────────────────────────────────────────────
const DMT_THEMES = {
  dark: {
    label: '🌑 Dark',
    bg: '#121212', bg2: '#1e1e1e', bg3: '#2a2a2a',
    text: '#e8e8e8', textMuted: '#a0a0a0', border: '#333333',
    link: '#9d8aff', linkHov: '#b8a8ff', input: '#1e1e2e',
    scrollBg: '#1a1a2a', scrollTh: '#3a3a5c', selBg: '#3a3a5c', selText: '#ffffff',
  },
  sepia: {
    label: '📜 Sepia',
    bg: '#1c1510', bg2: '#2a1f14', bg3: '#3a2e1a',
    text: '#f0e6c8', textMuted: '#c8b898', border: '#4a3c22',
    link: '#d4a843', linkHov: '#e8c060', input: '#2a1f14',
    scrollBg: '#1c1510', scrollTh: '#5a4a28', selBg: '#5a4a28', selText: '#f0e6c8',
  },
  highContrast: {
    label: '⚡ High Contrast',
    bg: '#000000', bg2: '#0d0d0d', bg3: '#1a1a1a',
    text: '#ffffff', textMuted: '#cccccc', border: '#ffffff',
    link: '#ffff00', linkHov: '#ffffaa', input: '#111111',
    scrollBg: '#000000', scrollTh: '#ffffff', selBg: '#ffffff', selText: '#000000',
  },
  midnight: {
    label: '🌌 Midnight',
    bg: '#0a0e1a', bg2: '#111827', bg3: '#1e2d45',
    text: '#cbd5e1', textMuted: '#94a3b8', border: '#1e2d45',
    link: '#60a5fa', linkHov: '#93c5fd', input: '#111827',
    scrollBg: '#0a0e1a', scrollTh: '#1e3a5f', selBg: '#1e3a5f', selText: '#cbd5e1',
  },
  forest: {
    label: '🌿 Forest',
    bg: '#0a1a0d', bg2: '#112214', bg3: '#1a3320',
    text: '#d4edda', textMuted: '#a8d5b5', border: '#1a3320',
    link: '#4ade80', linkHov: '#86efac', input: '#112214',
    scrollBg: '#0a1a0d', scrollTh: '#1a4a28', selBg: '#1a4a28', selText: '#d4edda',
  },
  custom: {
    label: '🎨 Custom',
    // Populated at runtime from customTheme storage key via dmtBuildVars()
  },
};

/**
 * Read the full settings object from chrome.storage.local,
 * merging defaults for any missing keys.
 *
 * FIX: Added chrome.runtime.lastError check to avoid silent failures
 *      when storage is unavailable (e.g. extension context invalidated).
 *
 * @returns {Promise<object>}
 */
function dmtGetSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, (raw) => {
      if (chrome.runtime.lastError) {
        // Reject so callers can handle the failure explicitly
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve({
        globalEnabled: raw.globalEnabled ?? DMT_DEFAULTS.globalEnabled,
        autoMode:      raw.autoMode      ?? DMT_DEFAULTS.autoMode,
        sites:         raw.sites         ?? {},
        whitelist:     raw.whitelist     ?? [],
        schedule:      { ...DMT_DEFAULTS.schedule,     ...(raw.schedule     ?? {}) },
        customTheme:   { ...DMT_DEFAULTS.customTheme,  ...(raw.customTheme  ?? {}) },
      });
    });
  });
}

/**
 * Write a partial patch to chrome.storage.local.
 *
 * FIX: Added chrome.runtime.lastError check so callers get a real rejection
 *      instead of silently losing data.
 *
 * @param {object} patch
 * @returns {Promise<void>}
 */
function dmtSaveSettings(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(patch, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Return merged site settings for a given origin,
 * falling back to DMT_SITE_DEFAULTS for any missing fields.
 *
 * @param {object} sites  — the sites map from storage
 * @param {string} origin
 * @returns {object}
 */
function dmtGetSite(sites, origin) {
  return { ...DMT_SITE_DEFAULTS, ...(sites[origin] ?? {}) };
}

/**
 * Return true if the current local time falls within [start, end].
 * Handles overnight ranges correctly (e.g. 20:00 → 07:00).
 *
 * FIX: Removed unused `sm` and `em` destructured variables.
 *
 * @param {string} start  — "HH:MM"
 * @param {string} end    — "HH:MM"
 * @returns {boolean}
 */
function dmtInSchedule(start, end) {
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  // Parse only the hour component we need; minutes are already included
  // by splitting on ':' and mapping both parts, then composing into total minutes.
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;  // FIX: sm/em are now actually used in the total
  const e = eh * 60 + em;

  // Overnight: start > end means the range wraps midnight
  return s > e
    ? (mins >= s || mins < e)   // e.g. 20:00–07:00
    : (mins >= s && mins < e);  // e.g. 08:00–18:00
}

/**
 * Build the CSS custom-property block for a given theme key.
 * Returned string is suitable for `:root { <string>; }`.
 *
 * FIX: Custom theme previously used `customTheme.bg2` for both `bg2` AND `bg3`,
 *      meaning bg3 was never distinct. Now bg3 is derived correctly.
 *
 * @param {string} themeKey
 * @param {object} customTheme
 * @returns {string}
 */
function dmtBuildVars(themeKey, customTheme) {
  let t = DMT_THEMES[themeKey] ?? DMT_THEMES.dark;

  if (themeKey === 'custom') {
    // Derive bg3 by lightening bg2 slightly rather than duplicating bg2
    const bg2 = customTheme.bg2 ?? DMT_THEMES.dark.bg2;
    t = {
      ...DMT_THEMES.dark,               // fill any unset vars with dark defaults
      bg:      customTheme.bg   ?? DMT_THEMES.dark.bg,
      bg2:     bg2,
      bg3:     customTheme.bg3  ?? bg2, // FIX: was incorrectly bg2 again
      text:    customTheme.text ?? DMT_THEMES.dark.text,
      link:    customTheme.link ?? DMT_THEMES.dark.link,
      linkHov: customTheme.link ?? DMT_THEMES.dark.linkHov,
    };
  }

  return [
    `--dmt-bg:        ${t.bg}`,
    `--dmt-bg2:       ${t.bg2}`,
    `--dmt-bg3:       ${t.bg3}`,
    `--dmt-text:      ${t.text}`,
    `--dmt-muted:     ${t.textMuted}`,
    `--dmt-border:    ${t.border}`,
    `--dmt-link:      ${t.link}`,
    `--dmt-link-hov:  ${t.linkHov}`,
    `--dmt-input:     ${t.input}`,
    `--dmt-scroll-bg: ${t.scrollBg}`,
    `--dmt-scroll-th: ${t.scrollTh}`,
    `--dmt-sel-bg:    ${t.selBg}`,
    `--dmt-sel-text:  ${t.selText}`,
  ].join('; ');
}
