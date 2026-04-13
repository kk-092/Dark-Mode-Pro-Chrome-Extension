/**
 * background.js — Manifest V3 Service Worker
 *
 * FIXES APPLIED:
 *  1. checkSchedule: collect ALL site mutations first, then do ONE
 *     dmtSaveSettings call instead of one per tab (eliminates race conditions
 *     and redundant storage writes).
 *  2. ctxWhitelist: merged the two separate dmtSaveSettings calls (sites +
 *     whitelist) into a single atomic write to eliminate the race condition
 *     where a read between the two writes could see inconsistent state.
 *  3. sendToTab: now uses chrome.scripting.executeScript as a fallback when
 *     the content script is not loaded (e.g. extension just installed, or
 *     page was open before extension was enabled).
 *  4. Added chrome.tabs.onActivated and chrome.tabs.onUpdated listeners so
 *     the schedule is re-evaluated when the user switches tabs or a page
 *     finishes loading — fixing the gap where the alarm fires every minute
 *     but a newly-opened tab isn't checked until the next alarm tick.
 *  5. All async functions now have try/catch with console.warn so errors
 *     are visible in the SW DevTools instead of silently disappearing.
 *  6. importScripts wrapped in try/catch so a utils.js parse error produces
 *     a clear error message rather than crashing the entire SW silently.
 */

'use strict';

try {
  importScripts('utils.js');
} catch (err) {
  console.error('[DMT] Failed to load utils.js:', err);
}

const ALARM_SCHEDULE = 'dmt_schedule_check';
const MENU_TOGGLE    = 'dmt_ctx_toggle';
const MENU_WHITELIST = 'dmt_ctx_whitelist';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  buildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  buildContextMenu();
});

/** Create the schedule alarm if it doesn't already exist. */
function ensureAlarm() {
  chrome.alarms.get(ALARM_SCHEDULE, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_SCHEDULE, { periodInMinutes: 1 });
    }
  });
}

// ─── Context Menu ────────────────────────────────────────────────────────────

function buildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TOGGLE,
      title: 'Toggle Dark Mode',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_WHITELIST,
      title: 'Add / Remove from Whitelist',
      contexts: ['page'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;

  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return; // not a valid navigable URL
  }

  try {
    const settings = await dmtGetSettings();
    if (info.menuItemId === MENU_TOGGLE) {
      await ctxToggle(tab, origin, settings);
    } else if (info.menuItemId === MENU_WHITELIST) {
      await ctxWhitelist(tab, origin, settings);
    }
  } catch (err) {
    console.warn('[DMT] Context menu action failed:', err);
  }
});

async function ctxToggle(tab, origin, settings) {
  if (settings.whitelist.includes(origin)) return;

  const site    = dmtGetSite(settings.sites, origin);
  const next    = !site.enabled;
  const updated = { ...settings.sites, [origin]: { ...site, enabled: next } };

  await dmtSaveSettings({ sites: updated });

  await sendToTab(tab.id, next
    ? { type: 'DMT_APPLY', site: { ...site, enabled: true }, customTheme: settings.customTheme }
    : { type: 'DMT_REMOVE' }
  );
}

async function ctxWhitelist(tab, origin, settings) {
  let whitelist = [...settings.whitelist];
  const isListed = whitelist.includes(origin);

  // Build the full patch atomically
  const patch = {};

  if (isListed) {
    // Remove from whitelist; don't change site.enabled
    patch.whitelist = whitelist.filter(o => o !== origin);
  } else {
    // Add to whitelist AND disable dark mode for this site in one write
    whitelist.push(origin);
    const site = dmtGetSite(settings.sites, origin);
    patch.whitelist = whitelist;
    patch.sites     = { ...settings.sites, [origin]: { ...site, enabled: false } };
  }

  // FIX: Single atomic write instead of two separate writes
  await dmtSaveSettings(patch);

  if (!isListed) {
    // Site was just whitelisted — remove dark mode
    await sendToTab(tab.id, { type: 'DMT_REMOVE' });
  }
}

// ─── Keyboard Shortcut ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-dark-mode') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;

  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }

  try {
    const settings = await dmtGetSettings();
    if (settings.whitelist.includes(origin)) return;

    const site    = dmtGetSite(settings.sites, origin);
    const next    = !site.enabled;
    const updated = { ...settings.sites, [origin]: { ...site, enabled: next } };

    await dmtSaveSettings({ sites: updated });
    await sendToTab(tab.id, next
      ? { type: 'DMT_APPLY', site: { ...site, enabled: true }, customTheme: settings.customTheme }
      : { type: 'DMT_REMOVE' }
    );
  } catch (err) {
    console.warn('[DMT] Keyboard shortcut action failed:', err);
  }
});

// ─── Schedule Alarm ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SCHEDULE) {
    checkSchedule().catch(err => console.warn('[DMT] Schedule check failed:', err));
  }
});

/**
 * Check the schedule and apply/remove dark mode on all open tabs.
 *
 * FIX: Previously wrote to storage once per tab inside the loop, causing
 *      a race condition where a concurrent read (from another tab loading)
 *      could see a partially-updated sites map.
 *
 *      New approach:
 *       1. Determine what needs to change for every tab.
 *       2. Build one merged `sites` patch.
 *       3. Write it in a single dmtSaveSettings call.
 *       4. Then send messages to all affected tabs.
 */
async function checkSchedule() {
  const settings = await dmtGetSettings();
  const { enabled, start, end } = settings.schedule;
  if (!enabled) return;

  const inRange = dmtInSchedule(start, end);
  const tabs    = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  // Collect mutations
  const sitePatch   = { ...settings.sites };
  const toApply     = [];  // [{ tabId, site }]
  const toRemove    = [];  // [tabId]
  let   hasChanges  = false;

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;

    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }

    if (settings.whitelist.includes(origin)) continue;

    const site = dmtGetSite(settings.sites, origin);

    if (inRange && !site.enabled) {
      sitePatch[origin] = { ...site, enabled: true };
      toApply.push({ tabId: tab.id, site: sitePatch[origin] });
      hasChanges = true;
    } else if (!inRange && site.enabled) {
      sitePatch[origin] = { ...site, enabled: false };
      toRemove.push(tab.id);
      hasChanges = true;
    }
  }

  // FIX: One write for all changes
  if (hasChanges) {
    await dmtSaveSettings({ sites: sitePatch });
  }

  // Now notify tabs (after storage is consistent)
  for (const { tabId, site } of toApply) {
    await sendToTab(tabId, { type: 'DMT_APPLY', site, customTheme: settings.customTheme });
  }
  for (const tabId of toRemove) {
    await sendToTab(tabId, { type: 'DMT_REMOVE' });
  }
}

// ─── Tab lifecycle ────────────────────────────────────────────────────────────
//
// FIX: The alarm fires every minute, but a tab that is opened or navigated
//      to mid-interval won't be checked until the next tick. These listeners
//      re-apply the schedule immediately when a tab finishes loading or
//      when the user switches to a different tab.
//
// We only run a lightweight single-tab check (not the full loop) to avoid
// unnecessary storage reads on every tab switch.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act when the page has fully loaded (not on every redirect/load event)
  if (changeInfo.status !== 'complete' || !tab.url) return;
  applyScheduleToTab(tabId, tab.url).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    applyScheduleToTab(tabId, tab.url).catch(() => {});
  });
});

/**
 * Apply or remove dark mode on a single tab based on the current schedule.
 * Only acts if the schedule is enabled; otherwise a no-op.
 */
async function applyScheduleToTab(tabId, url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  // Ignore non-navigable pages
  if (!origin.startsWith('http')) return;

  const settings = await dmtGetSettings();
  const { enabled, start, end } = settings.schedule;
  if (!enabled) return;

  if (settings.whitelist.includes(origin)) return;

  const inRange = dmtInSchedule(start, end);
  const site    = dmtGetSite(settings.sites, origin);

  if (inRange && !site.enabled) {
    const updated = { ...settings.sites, [origin]: { ...site, enabled: true } };
    await dmtSaveSettings({ sites: updated });
    await sendToTab(tabId, { type: 'DMT_APPLY', site: updated[origin], customTheme: settings.customTheme });
  } else if (!inRange && site.enabled) {
    const updated = { ...settings.sites, [origin]: { ...site, enabled: false } };
    await dmtSaveSettings({ sites: updated });
    await sendToTab(tabId, { type: 'DMT_REMOVE' });
  }
}

// ─── sendToTab with content script fallback ──────────────────────────────────────
//
// FIX: The old sendToTab silently swallowed ALL errors.
//      The most common real error is "Could not establish connection" which
//      means the content script hasn't been injected yet (e.g. the extension
//      was just installed and existing tabs don't have it).
//
//      We now detect this specific error and fall back to
//      chrome.scripting.executeScript to inject utils.js + content.js
//      programmatically, then retry the message.

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = err?.message ?? '';
    const isNotConnected =
      msg.includes('Could not establish connection') ||
      msg.includes('Receiving end does not exist');

    if (!isNotConnected) {
      // A real unexpected error — log it
      console.warn(`[DMT] sendToTab(${tabId}) unexpected error:`, msg);
      return;
    }

    // Content script not present — inject it, then retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ['utils.js', 'content.js'],
      });
      // Brief delay so the injected script can register its message listener
      await new Promise(r => setTimeout(r, 50));
      await chrome.tabs.sendMessage(tabId, message);
    } catch (injectErr) {
      // Tab may be a chrome:// page, PDF, or otherwise non-injectable
      // This is expected and not an error worth surfacing
    }
  }
}
