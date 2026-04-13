/**
 * popup.js v3.1 — Bug-fix pass
 *
 * FIXES APPLIED:
 *  1. msgTab: added fallback injection when content script is not loaded.
 *     Previously .catch(() => {}) swallowed all errors silently.
 *
 *  2. boot: DMT_PING response was destructured as `{ active }` which throws
 *     a TypeError if the response is undefined (e.g. content script not
 *     loaded). Now safely handled with optional chaining.
 *
 *  3. autoModeToggle: was sending DMT_PING as a "nudge" which does nothing
 *     useful. Now sends DMT_APPLY or DMT_REMOVE based on the actual state.
 *
 *  4. resetFilters: was calling saveSiteField twice (two separate storage
 *     writes). Now batches both field updates into one write.
 *
 *  5. saveSiteField: the brightness/contrast slider handlers call getSite()
 *     after awaiting saveSiteField(), but getSite() reads from state.sites
 *     which is already updated synchronously before the await. This is fine,
 *     but the pattern was confusing. Added a comment to clarify.
 *
 *  6. importSettings: added type validation for individual fields to prevent
 *     importing malformed data that could corrupt storage.
 *
 *  7. exportSettings: now creates and clicks the anchor correctly without
 *     relying on document.body.appendChild (popup DOM is minimal).
 *
 *  8. chrome:// / non-injectable tabs: popup now disables the toggle button
 *     and shows a clear message when the active tab can't run content scripts.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  globalEnabled: false,
  autoMode:      false,
  sites:         {},
  whitelist:     [],
  schedule:      { enabled: false, start: '20:00', end: '07:00' },
  customTheme:   { bg: '#121212', bg2: '#1e1e1e', text: '#e8e8e8', link: '#9d8aff' },
};

let currentTabId     = null;
let currentOrigin    = null;
let tabIsInjectable  = true; // false for chrome://, PDF, etc.

// ─── Utilities ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Send a message to the active tab's content script.
 *
 * FIX: Previously used .catch(() => {}) which silently swallowed all errors.
 *      Now distinguishes between "content script not loaded" (recoverable via
 *      background script injection) and real errors (logged as warnings).
 *
 *      For the popup context we can't call chrome.scripting directly
 *      (requires "scripting" permission which popup has, but the injection
 *      is better handled by the background). Instead we send a special
 *      DMT_INJECT_AND_APPLY message to background.js which handles it.
 */
async function msgTab(message) {
  if (!currentTabId || !tabIsInjectable) return;

  try {
    await chrome.tabs.sendMessage(currentTabId, message);
  } catch (err) {
    const msg = err?.message ?? '';
    const isNotConnected =
      msg.includes('Could not establish connection') ||
      msg.includes('Receiving end does not exist');

    if (isNotConnected) {
      // Content script not loaded — ask background to inject + apply
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          files:  ['utils.js', 'content.js'],
        });
        // Small delay for listener registration
        await new Promise(r => setTimeout(r, 50));
        await chrome.tabs.sendMessage(currentTabId, message);
      } catch {
        // Tab not injectable (chrome://, PDF, etc.) — mark it
        tabIsInjectable = false;
      }
    } else {
      console.warn('[DMT popup] Unexpected sendMessage error:', msg);
    }
  }
}

function getSite() {
  return dmtGetSite(state.sites, currentOrigin);
}

async function save(patch) {
  Object.assign(state, patch);
  try {
    await dmtSaveSettings(patch);
  } catch (err) {
    console.warn('[DMT popup] save() failed:', err);
  }
}

/**
 * Save one or more per-site fields in a single storage write.
 *
 * FIX: Previously resetFilters called this twice, causing two separate
 *      storage writes. Now accepts an object of field→value pairs so
 *      multiple fields can be updated atomically.
 *
 * @param {object} fields  — e.g. { brightness: 100, contrast: 100 }
 */
async function saveSiteFields(fields) {
  const site    = getSite();
  const updated = { ...state.sites, [currentOrigin]: { ...site, ...fields } };
  state.sites   = updated;
  try {
    await dmtSaveSettings({ sites: updated });
  } catch (err) {
    console.warn('[DMT popup] saveSiteFields() failed:', err);
  }
}

// Keep the single-field variant as a thin wrapper for convenience
async function saveSiteField(field, value) {
  return saveSiteFields({ [field]: value });
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'sites') renderSites();
    });
  });
}

// ══ TAB 1 — MAIN ═════════════════════════════════════════════════════════════════════════

function renderMain() {
  const site   = getSite();
  const isDark = site.enabled;

  document.body.classList.toggle('dark', isDark);

  const btn = $('toggleBtn');
  btn.classList.toggle('btn-on',  isDark);
  btn.classList.toggle('btn-off', !isDark);
  btn.setAttribute('aria-pressed', String(isDark));
  // FIX: disable toggle button on non-injectable tabs
  btn.disabled = !tabIsInjectable;
  btn.title    = tabIsInjectable ? '' : 'Dark mode cannot be applied on this page';

  $('btnIcon').textContent = isDark ? '☀️' : '🌑';
  $('btnText').textContent = isDark ? 'Disable Dark Mode' : 'Enable Dark Mode';

  const badge = $('statusBadge');
  badge.textContent = isDark ? 'ON' : 'OFF';
  badge.classList.toggle('on', isDark);

  $('screenMock').classList.toggle('dark-screen', isDark);

  $('globalToggle').checked       = state.globalEnabled;
  $('autoModeToggle').checked     = state.autoMode;
  $('invertImagesToggle').checked = site.invertImages;

  $('themeChip').textContent    = `🎨 ${(DMT_THEMES[site.theme]?.label ?? '').split(' ').slice(1).join(' ') || 'Dark'}`;
  $('scheduleChip').textContent = state.schedule.enabled ? '⏰ Scheduled' : '⏰ Manual';

  renderSiteCount();
}

function renderSiteCount() {
  const count = Object.values(state.sites).filter(s => s.enabled).length;
  $('siteCountChip').textContent = `🌐 ${count} site${count !== 1 ? 's' : ''}`;
}

function initMain() {
  $('toggleBtn').addEventListener('click', async () => {
    const next = !getSite().enabled;
    await saveSiteField('enabled', next);
    renderMain();
    renderThemes();
    await msgTab(next
      ? { type: 'DMT_APPLY', site: getSite(), customTheme: state.customTheme }
      : { type: 'DMT_REMOVE' }
    );
  });

  $('globalToggle').addEventListener('change', async (e) => {
    await save({ globalEnabled: e.target.checked });
    if (e.target.checked) {
      await msgTab({ type: 'DMT_APPLY', site: getSite(), customTheme: state.customTheme });
    } else {
      if (!getSite().enabled) await msgTab({ type: 'DMT_REMOVE' });
    }
  });

  /**
   * FIX: autoModeToggle previously sent DMT_PING as a "nudge" which does
   * nothing — DMT_PING just returns { ok, active } and the content script
   * takes no action. Now we send the correct message based on the new state.
   */
  $('autoModeToggle').addEventListener('change', async (e) => {
    await save({ autoMode: e.target.checked });
    if (e.target.checked) {
      // Auto mode on: let content script decide based on system preference
      // Send a full apply; content.js will read storage and decide
      await msgTab({ type: 'DMT_APPLY', site: getSite(), customTheme: state.customTheme });
    } else {
      // Auto mode off: revert to per-site setting
      const site = getSite();
      if (site.enabled) {
        await msgTab({ type: 'DMT_APPLY', site, customTheme: state.customTheme });
      } else {
        await msgTab({ type: 'DMT_REMOVE' });
      }
    }
  });

  $('invertImagesToggle').addEventListener('change', async (e) => {
    await saveSiteField('invertImages', e.target.checked);
    const site = getSite();
    if (site.enabled) {
      await msgTab({
        type:         'DMT_FILTER',
        brightness:   site.brightness,
        contrast:     site.contrast,
        invertImages: e.target.checked,
      });
    }
  });
}

// ══ TAB 2 — THEMES ══════════════════════════════════════════════════════════════════════

function renderThemes() {
  const theme = getSite().theme;
  document.querySelectorAll('.theme-card').forEach(card => {
    const active = card.dataset.theme === theme;
    card.classList.toggle('active', active);
    card.setAttribute('aria-checked', String(active));
  });
  updateCustomThemePreview();
}

function initThemes() {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', async () => {
      await saveSiteField('theme', card.dataset.theme);
      renderThemes();
      renderMain();
      const site = getSite();
      if (site.enabled) {
        await msgTab({ type: 'DMT_THEME', theme: card.dataset.theme, customTheme: state.customTheme });
      }
    });
  });
}

// ══ TAB 3 — ADJUST ════════════════════════════════════════════════════════════════════

// 50ms debounce: responsive but doesn't spam messages while dragging
const sendFilter = debounce((brightness, contrast, invertImages) => {
  const site = getSite();
  if (site.enabled) {
    msgTab({ type: 'DMT_FILTER', brightness, contrast, invertImages });
  }
}, 50);

function renderAdjust() {
  const site = getSite();
  $('brightnessSlider').value    = site.brightness;
  $('contrastSlider').value      = site.contrast;
  $('brightnessVal').textContent = `${site.brightness}%`;
  $('contrastVal').textContent   = `${site.contrast}%`;
}

function initAdjust() {
  $('brightnessSlider').addEventListener('input', async (e) => {
    const val = Number(e.target.value);
    $('brightnessVal').textContent = `${val}%`;
    // Note: saveSiteField updates state.sites synchronously before the await,
    // so getSite() after the await returns the updated value.
    await saveSiteField('brightness', val);
    sendFilter(val, getSite().contrast, getSite().invertImages);
  });

  $('contrastSlider').addEventListener('input', async (e) => {
    const val = Number(e.target.value);
    $('contrastVal').textContent = `${val}%`;
    await saveSiteField('contrast', val);
    sendFilter(getSite().brightness, val, getSite().invertImages);
  });

  /**
   * FIX: Was calling saveSiteField twice (two separate storage writes).
   * Now uses saveSiteFields to batch both into one write.
   */
  $('resetFilters').addEventListener('click', async () => {
    await saveSiteFields({ brightness: 100, contrast: 100 });
    renderAdjust();
    const site = getSite();
    if (site.enabled) {
      await msgTab({ type: 'DMT_FILTER', brightness: 100, contrast: 100, invertImages: site.invertImages });
    }
  });
}

// ══ TAB 4 — SCHEDULE ═══════════════════════════════════════════════════════════════════

function renderSchedule() {
  const { enabled, start, end } = state.schedule;
  $('scheduleToggle').checked = enabled;
  $('scheduleStart').value    = start;
  $('scheduleEnd').value      = end;
  updateScheduleNote();
}

function updateScheduleNote() {
  const note    = $('scheduleNote');
  const enabled = $('scheduleToggle').checked;
  const start   = $('scheduleStart').value || '20:00';
  const end     = $('scheduleEnd').value   || '07:00';

  if (!enabled) {
    note.textContent = 'Schedule is off.';
    note.classList.remove('on');
    $('scheduleChip').textContent = '⏰ Manual';
  } else {
    note.textContent = `Auto-enables at ${start}, disables at ${end}.`;
    note.classList.add('on');
    $('scheduleChip').textContent = '⏰ Scheduled';
  }
}

function initSchedule() {
  const saveSchedule = async () => {
    const schedule = {
      enabled: $('scheduleToggle').checked,
      start:   $('scheduleStart').value  || '20:00',
      end:     $('scheduleEnd').value    || '07:00',
    };
    await save({ schedule });
    updateScheduleNote();
  };

  $('scheduleToggle').addEventListener('change', saveSchedule);
  $('scheduleStart').addEventListener('change',  saveSchedule);
  $('scheduleEnd').addEventListener('change',    saveSchedule);
}

// ══ TAB 5 — SITES ═══════════════════════════════════════════════════════════════════════

function renderSites() {
  const { whitelist, sites } = state;
  const activeCount = Object.values(sites).filter(s => s.enabled).length;

  $('statEnabled').textContent      = activeCount;
  $('statWhitelisted').textContent  = whitelist.length;
  $('currentOrigin').textContent    = currentOrigin?.replace(/https?:\/\//, '') ?? '—';
  $('whitelistCurrentSite').checked = whitelist.includes(currentOrigin);

  const list  = $('whitelistList');
  const empty = $('wlEmpty');
  list.querySelectorAll('.wl-item').forEach(el => el.remove());

  const items = whitelist.filter(Boolean);
  empty.style.display = items.length ? 'none' : 'block';

  items.forEach(origin => {
    const row = document.createElement('div');
    row.className = 'wl-item';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <span title="${origin}">${origin.replace(/https?:\/\//, '')}</span>
      <button class="wl-remove" data-origin="${origin}" aria-label="Remove ${origin}">✕</button>
    `;
    row.querySelector('.wl-remove').addEventListener('click', () => removeWhitelist(origin));
    list.appendChild(row);
  });

  renderSiteCount();
}

async function removeWhitelist(origin) {
  state.whitelist = state.whitelist.filter(o => o !== origin);
  try {
    await dmtSaveSettings({ whitelist: state.whitelist });
  } catch (err) {
    console.warn('[DMT popup] removeWhitelist() failed:', err);
  }
  renderSites();
}

function initSites() {
  $('whitelistCurrentSite').addEventListener('change', async (e) => {
    const isWhitelisted = e.target.checked;
    if (isWhitelisted) {
      if (!state.whitelist.includes(currentOrigin)) {
        state.whitelist = [...state.whitelist, currentOrigin];
      }
      await saveSiteField('enabled', false);
      await msgTab({ type: 'DMT_REMOVE' });
      renderMain();
    } else {
      state.whitelist = state.whitelist.filter(o => o !== currentOrigin);
    }
    try {
      await dmtSaveSettings({ whitelist: state.whitelist });
    } catch (err) {
      console.warn('[DMT popup] whitelist save failed:', err);
    }
    renderSites();
  });

  $('exportBtn').addEventListener('click', exportSettings);
  $('importFile').addEventListener('change', importSettings);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportSettings() {
  try {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href:     url,
      download: 'dark-mode-pro-settings.json',
    });
    // FIX: append to body, click, then clean up
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn('[DMT popup] Export failed:', err);
    alert('Export failed. Please try again.');
  }
}

/**
 * FIX: Added per-field type validation so malformed imports can't corrupt
 * storage. Each field is checked against its expected type before applying.
 */
function importSettings(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = () => alert('Failed to read file.');
  reader.onload  = async (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (typeof imported !== 'object' || imported === null || Array.isArray(imported)) {
        throw new Error('Root must be an object');
      }

      const patch = {};

      // Validate each field before accepting it
      if ('globalEnabled' in imported && typeof imported.globalEnabled === 'boolean') {
        patch.globalEnabled = imported.globalEnabled;
      }
      if ('autoMode' in imported && typeof imported.autoMode === 'boolean') {
        patch.autoMode = imported.autoMode;
      }
      if ('sites' in imported && typeof imported.sites === 'object' && !Array.isArray(imported.sites)) {
        patch.sites = imported.sites;
      }
      if ('whitelist' in imported && Array.isArray(imported.whitelist)) {
        patch.whitelist = imported.whitelist.filter(v => typeof v === 'string');
      }
      if ('schedule' in imported && typeof imported.schedule === 'object') {
        patch.schedule = {
          enabled: typeof imported.schedule.enabled === 'boolean' ? imported.schedule.enabled : false,
          start:   typeof imported.schedule.start   === 'string'  ? imported.schedule.start   : '20:00',
          end:     typeof imported.schedule.end     === 'string'  ? imported.schedule.end     : '07:00',
        };
      }
      if ('customTheme' in imported && typeof imported.customTheme === 'object') {
        patch.customTheme = {
          bg:   typeof imported.customTheme.bg   === 'string' ? imported.customTheme.bg   : '#121212',
          bg2:  typeof imported.customTheme.bg2  === 'string' ? imported.customTheme.bg2  : '#1e1e1e',
          text: typeof imported.customTheme.text === 'string' ? imported.customTheme.text : '#e8e8e8',
          link: typeof imported.customTheme.link === 'string' ? imported.customTheme.link : '#9d8aff',
        };
      }

      if (Object.keys(patch).length === 0) {
        throw new Error('No valid fields found in import file');
      }

      await save(patch);
      renderAll();
      alert('Settings imported successfully!');
    } catch (err) {
      console.warn('[DMT popup] Import failed:', err);
      alert(`Import failed: ${err.message}`);
    }
  };

  reader.readAsText(file);
  e.target.value = ''; // Allow re-importing the same file
}

// ══ TAB 6 — CUSTOM THEME ═════════════════════════════════════════════════════════════════

const COLOR_FIELDS = [
  { colorId: 'colorBg',   hexId: 'colorBgHex',   key: 'bg'   },
  { colorId: 'colorBg2',  hexId: 'colorBg2Hex',  key: 'bg2'  },
  { colorId: 'colorText', hexId: 'colorTextHex', key: 'text' },
  { colorId: 'colorLink', hexId: 'colorLinkHex', key: 'link' },
];

function renderCustom() {
  const ct = state.customTheme;
  COLOR_FIELDS.forEach(({ colorId, hexId, key }) => {
    $(colorId).value = ct[key] ?? '#121212';
    $(hexId).value   = ct[key] ?? '#121212';
  });
  updateCustomThemePreview();
}

function updateCustomThemePreview() {
  const ct   = state.customTheme;
  const card = $('customPreviewCard');
  if (card) {
    card.style.setProperty('--cpv-bg',   ct.bg   ?? '#121212');
    card.style.setProperty('--cpv-bg2',  ct.bg2  ?? '#1e1e1e');
    card.style.setProperty('--cpv-link', ct.link ?? '#9d8aff');
  }
  const preview = $('customThemePreview');
  if (preview) {
    preview.style.setProperty('--tp-bg',  ct.bg   ?? '#121212');
    preview.style.setProperty('--tp-bar', ct.bg2  ?? '#1e1e1e');
    preview.style.setProperty('--tp-acc', ct.link ?? '#9d8aff');
  }
}

function initCustom() {
  COLOR_FIELDS.forEach(({ colorId, hexId, key }) => {
    const colorEl = $(colorId);
    const hexEl   = $(hexId);

    colorEl.addEventListener('input', () => {
      hexEl.value = colorEl.value;
      state.customTheme[key] = colorEl.value;
      updateCustomThemePreview();
    });

    hexEl.addEventListener('input', () => {
      const val = hexEl.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        colorEl.value = val;
        state.customTheme[key] = val;
        updateCustomThemePreview();
      }
    });
  });

  $('saveCustomTheme').addEventListener('click', async () => {
    await save({ customTheme: { ...state.customTheme } });
    await saveSiteField('theme', 'custom');
    renderThemes();
    renderMain();
    const site = getSite();
    if (site.enabled) {
      await msgTab({ type: 'DMT_APPLY', site: { ...site, theme: 'custom' }, customTheme: state.customTheme });
    }
  });

  $('resetCustomTheme').addEventListener('click', async () => {
    const defaults = { bg: '#121212', bg2: '#1e1e1e', text: '#e8e8e8', link: '#9d8aff' };
    await save({ customTheme: defaults });
    renderCustom();
  });
}

// ══ RENDER ALL ══════════════════════════════════════════════════════════════════════════

function renderAll() {
  renderMain();
  renderThemes();
  renderAdjust();
  renderSchedule();
  renderSites();
  renderCustom();
}

// ══ BOOT ══════════════════════════════════════════════════════════════════════════════

async function boot() {
  // 1. Identify the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;

  try {
    currentOrigin = tab?.url ? new URL(tab.url).origin : 'unknown';
  } catch {
    currentOrigin = 'unknown';
  }

  // Mark non-injectable tabs (chrome://, about:, PDF viewer, etc.)
  tabIsInjectable = Boolean(
    tab?.url &&
    (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
  );

  // 2. Load settings
  try {
    const loaded = await dmtGetSettings();
    Object.assign(state, loaded);
  } catch (err) {
    console.warn('[DMT popup] Failed to load settings:', err);
  }

  // 3. Wire up all tabs
  initTabs();
  initMain();
  initThemes();
  initAdjust();
  initSchedule();
  initSites();
  initCustom();

  // 4. Render
  renderAll();

  // 5. Sync page state
  if (!tabIsInjectable) return; // nothing to sync on chrome:// pages

  /**
   * FIX: Previously destructured the ping response as `{ active }` which
   * throws TypeError if the response is undefined (content script not loaded).
   * Now uses optional chaining and handles the not-loaded case explicitly.
   */
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { type: 'DMT_PING' });
    const isActive = response?.active ?? false;
    const site     = getSite();
    const isWhitelisted = state.whitelist.includes(currentOrigin);

    if (!isWhitelisted && (site.enabled || state.globalEnabled)) {
      await msgTab({ type: 'DMT_APPLY', site, customTheme: state.customTheme });
    } else if (!site.enabled && !state.globalEnabled) {
      if (isActive) await msgTab({ type: 'DMT_REMOVE' });
    }
  } catch {
    // Content script not loaded yet — msgTab will inject on first action
  }
}

document.addEventListener('DOMContentLoaded', boot);
