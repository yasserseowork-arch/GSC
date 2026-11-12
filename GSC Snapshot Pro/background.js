const RUN_STORAGE_KEY = 'gscSnapshotProRun';
const GSC_ORIGIN = 'https://search.google.com';
const SEARCH_CONSOLE_HOME_URL = `${GSC_ORIGIN}/search-console`;
const ROUTE_TIMEOUT_MS = 30000;
const REPORT_SETTLE_DELAY_MS = 2200;
const SEARCH_CONSOLE_HOME_SETTLE_DELAY_MS = 350;
const MAX_REPORT_ATTEMPTS = 1;
const SNAPSHOT_DB_NAME = 'gscSnapshotProDatabase';
const SNAPSHOT_DB_VERSION = 2;
const SNAPSHOT_STORE_NAME = 'snapshots';

let snapshotDatabasePromise;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createSnapshotId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openSnapshotDatabase() {
  if (snapshotDatabasePromise) return snapshotDatabasePromise;
  snapshotDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, SNAPSHOT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      const store = database.objectStoreNames.contains(SNAPSHOT_STORE_NAME)
        ? transaction.objectStore(SNAPSHOT_STORE_NAME)
        : database.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
      if (!store.indexNames.contains('resourceId')) store.createIndex('resourceId', 'resourceId');
      if (!store.indexNames.contains('propertyKey')) store.createIndex('propertyKey', 'propertyKey');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      snapshotDatabasePromise = null;
      reject(request.error || new Error('تعذر فتح مكتبة الصور المحلية.'));
    };
  });
  return snapshotDatabasePromise;
}

async function saveSnapshot(snapshot) {
  if (!snapshot?.imageData || !String(snapshot.imageData).startsWith('data:image/')) {
    throw new Error('لم تصل صورة صالحة إلى مكتبة اللقطات.');
  }
  const database = await openSnapshotDatabase();
  const record = {
    id: createSnapshotId(),
    ...snapshot,
    propertyKey: canonicalPropertyKey(snapshot.resourceId || snapshot.propertyLabel)
  };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readwrite');
    transaction.objectStore(SNAPSHOT_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('تعذر حفظ الصورة داخل الإكستنشن.'));
    transaction.onabort = () => reject(transaction.error || new Error('تم إيقاف حفظ الصورة داخل الإكستنشن.'));
  });
  return record;
}

async function getSnapshot(snapshotId) {
  const database = await openSnapshotDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SNAPSHOT_STORE_NAME).get(snapshotId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('تعذر قراءة الصورة المحفوظة.'));
  });
}

async function listSnapshots() {
  const database = await openSnapshotDatabase();
  const records = await new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SNAPSHOT_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('تعذر قراءة مكتبة الصور.'));
  });
  // Do not send the image payload in the list; the side panel asks for one image only when it is selected.
  return records
    .map(({ imageData, ...metadata }) => metadata)
    .sort((first, second) => second.createdAt - first.createdAt);
}

async function deleteSnapshot(snapshotId) {
  const database = await openSnapshotDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readwrite');
    transaction.objectStore(SNAPSHOT_STORE_NAME).delete(snapshotId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('تعذر حذف الصورة.'));
  });
}

async function clearSnapshots() {
  const database = await openSnapshotDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE_NAME, 'readwrite');
    transaction.objectStore(SNAPSHOT_STORE_NAME).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('تعذر مسح مكتبة الصور.'));
  });
}

async function snapshotSummary() {
  const snapshots = await listSnapshots();
  return { count: snapshots.length, latest: snapshots[0] || null };
}

function isGscUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === GSC_ORIGIN && parsed.pathname.startsWith('/search-console');
  } catch {
    return false;
  }
}

function displayProperty(resourceId) {
  const decoded = decodeURIComponent(resourceId || '');
  if (decoded.startsWith('sc-domain:')) return decoded.slice('sc-domain:'.length);
  try {
    return new URL(decoded).host || decoded;
  } catch {
    return decoded || 'Unknown property';
  }
}

function canonicalPropertyKey(resourceId) {
  const decoded = decodeURIComponent(resourceId || '').trim().toLowerCase();
  if (decoded.startsWith('sc-domain:')) return decoded.slice('sc-domain:'.length).replace(/^www\./, '');
  try {
    return new URL(decoded).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return decoded.replace(/^www\./, '');
  }
}

function propertyPriority(resourceId) {
  const decoded = decodeURIComponent(resourceId || '').trim().toLowerCase();
  // A domain property covers every protocol and subdomain, so it is the preferred default.
  if (decoded.startsWith('sc-domain:')) return 30;
  if (decoded.startsWith('https://')) return 20;
  if (decoded.startsWith('http://')) return 10;
  return 0;
}

function preferDomainProperties(properties) {
  const preferred = new Map();
  properties.forEach((property) => {
    const key = canonicalPropertyKey(property.resourceId);
    const current = preferred.get(key);
    if (!current || propertyPriority(property.resourceId) > propertyPriority(current.resourceId)) {
      preferred.set(key, property);
    }
  });
  // Preserve the Property selector's top-to-bottom order. The first visible site in
  // Search Console should be the first site processed, while still preferring Domain
  // Properties whenever URL-prefix and Domain entries represent the same website.
  return [...preferred.values()];
}

function resolveRequestedProperties(availableProperties, rawProperties) {
  const byCanonicalKey = new Map();
  availableProperties.forEach((property) => {
    const key = canonicalPropertyKey(property.resourceId);
    const candidates = byCanonicalKey.get(key) || [];
    candidates.push(property);
    byCanonicalKey.set(key, candidates);
  });

  const properties = [];
  const seenKeys = new Set();
  let matchedCount = 0;
  let missingCount = 0;
  rawProperties.forEach((rawProperty) => {
    const resourceId = normaliseProperty(rawProperty);
    const key = canonicalPropertyKey(resourceId);
    // Keep the first line the user entered for every website, exactly in its list order.
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const matchingProperties = byCanonicalKey.get(key) || [];
    const bestMatch = preferDomainProperties(matchingProperties)[0];
    if (bestMatch) {
      properties.push(bestMatch);
      matchedCount += 1;
    } else {
      // This record is deliberately kept in its original slot. processRun marks it as
      // skipped without navigating to it, then proceeds immediately to the next line.
      properties.push({ resourceId, label: displayProperty(resourceId), unavailable: true });
      missingCount += 1;
    }
  });
  return { properties, matchedCount, missingCount };
}

function normaliseProperty(rawProperty) {
  const raw = decodeURIComponent(String(rawProperty || '').trim());
  if (!raw) throw new Error('وجدنا سطرًا فارغًا في قائمة المواقع.');

  try {
    const url = new URL(raw);
    const fromGscUrl = url.searchParams.get('resource_id');
    if (fromGscUrl) return fromGscUrl;
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}/`;
  } catch {
    // A Search Console domain property is not a valid URL, so handle it below.
  }

  if (raw.startsWith('sc-domain:')) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return `sc-domain:${raw}`;
  throw new Error(`صيغة الموقع غير صحيحة: ${raw}`);
}

function propertyFromUrl(url) {
  if (!isGscUrl(url)) return null;
  const parsed = new URL(url);
  const resourceId = parsed.searchParams.get('resource_id');
  return resourceId ? { resourceId, label: displayProperty(resourceId) } : null;
}

function reportUrl(resourceId, reportType) {
  const path = reportType === 'generative-ai'
    ? '/search-console/performance/search-analytics/ai'
    : '/search-console/performance/search-analytics';
  const url = new URL(path, GSC_ORIGIN);
  url.searchParams.set('resource_id', resourceId);
  url.searchParams.set('num_of_days', '7');
  url.searchParams.set('compare_date', 'PREV');
  return url.toString();
}

function safeFileSegment(value) {
  const cleaned = String(value || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'site';
}

function snapshotDateFileName(createdAt) {
  // The library treats every Property as a folder and every capture as a date-named file.
  // Including the time keeps two report captures made on the same day from overwriting each other.
  return new Date(createdAt).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '') + '.png';
}

function reportFileName(property, createdAt) {
  return `GSC Snapshot Pro/${safeFileSegment(property.label)}/${snapshotDateFileName(createdAt)}`;
}

async function getRunState() {
  const stored = await chrome.storage.local.get(RUN_STORAGE_KEY);
  return stored[RUN_STORAGE_KEY] || null;
}

async function saveRunState(state) {
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [RUN_STORAGE_KEY]: state });
  return state;
}

async function updateRunState(runId, update) {
  const state = await getRunState();
  if (!state || state.id !== runId) return null;
  update(state);
  return saveRunState(state);
}

function appendRunEvent(state, message, type = 'info') {
  state.events ||= [];
  state.events.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), message, type });
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
}

async function logRunEvent(runId, message, type = 'info') {
  return updateRunState(runId, (state) => appendRunEvent(state, message, type));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]?.id) throw new Error('لم يتم العثور على تبويب نشط.');
  return tabs[0];
}

async function getCurrentProperty() {
  const tab = await getActiveTab();
  const property = propertyFromUrl(tab.url);
  if (!property) {
    return {
      property: null,
      reason: 'افتح موقعًا داخل Google Search Console أولًا ثم افتح الإضافة.'
    };
  }

  // The URL is the source of truth. The small DOM probe only improves the label shown in the side panel.
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const candidates = [...document.querySelectorAll('[aria-haspopup], [role="combobox"], button')]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 40 && rect.height > 20 && rect.top < 180 && rect.left < 420;
          })
          .map((element) => (element.getAttribute('aria-label') || element.textContent || '').trim())
          .filter(Boolean);
        return candidates.find((text) => /sc-domain:|https?:\/\/|www\./i.test(text)) || null;
      }
    });
    if (result?.result) property.label = result.result.replace(/^Property:\s*/i, '').trim();
  } catch {
    // Reading the label is optional; cross-page timing must not prevent a run.
  }
  return { property, tab };
}

async function discoverPropertiesForTab(tab) {
  if (!isGscUrl(tab.url)) throw new Error('تعذر فتح Google Search Console لقراءة قائمة الـ Properties.');
  const current = propertyFromUrl(tab.url);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [current?.resourceId || ''],
    func: async (currentResourceId) => {
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const items = new Map();
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const normalizeDiscoveredResource = (value) => {
        const resourceId = decodeURIComponent(String(value || '').trim());
        if (/^sc-domain:[a-z0-9.-]+$/i.test(resourceId)) return resourceId;
        try {
          const url = new URL(resourceId);
          return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/` : null;
        } catch {
          return null;
        }
      };
      const add = (resourceId, label) => {
        const normalizedResourceId = normalizeDiscoveredResource(resourceId);
        if (!normalizedResourceId || items.has(normalizedResourceId)) return;
        items.set(normalizedResourceId, { resourceId: normalizedResourceId, label: cleanText(label) || normalizedResourceId });
      };
      const resourceFromUrl = (value) => {
        try {
          return new URL(value, location.href).searchParams.get('resource_id');
        } catch {
          return null;
        }
      };
      const resourceFromPropertyText = (value) => {
        const text = cleanText(value);
        const domainMatch = text.match(/\bsc-domain:[a-z0-9.-]+/i);
        if (domainMatch) return domainMatch[0];
        const urlMatch = text.match(/https?:\/\/[^\s<>"']+/i);
        if (urlMatch) {
          try {
            const url = new URL(urlMatch[0]);
            return `${url.origin}/`;
          } catch {
            return null;
          }
        }
        // GSC's Property picker commonly renders a Domain Property as only
        // "example.com" (without the internal sc-domain: prefix). These are
        // actual selectable properties, not ordinary page links.
        const bareDomainMatch = text.match(/(?:^|\s)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?=\s|$)/i);
        return bareDomainMatch ? `sc-domain:${bareDomainMatch[1].toLowerCase()}` : null;
      };
      const scan = (root = document) => {
        root.querySelectorAll('[data-resource-id], [data-resourceid]').forEach((element) => {
          add(
            element.getAttribute('data-resourceid') || element.getAttribute('data-resource-id'),
            element.getAttribute('aria-label') || element.textContent
          );
        });
        root.querySelectorAll('a[href*="resource_id="], [data-href*="resource_id="]').forEach((element) => {
          const resourceId = resourceFromUrl(element.href || element.getAttribute('data-href'));
          add(resourceId, element.getAttribute('aria-label') || element.textContent);
        });
        // Some GSC releases expose the property only as the text in a menu item.
        // Read those entries as well instead of assuming every item has an href.
        root.querySelectorAll('[role="menuitem"], [role="option"], [role="treeitem"]').forEach((element) => {
          if (!isVisible(element)) return;
          const label = element.getAttribute('aria-label') || element.textContent;
          const resourceId = resourceFromPropertyText(label);
          const propertyLabel = resourceId?.replace(/^sc-domain:/i, '') || label;
          add(resourceId, propertyLabel);
        });
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      };
      const propertyMenuRoots = () => {
        // This is the real GSC picker: #resource-selector-container > [role=listbox]
        // whose selectable rows expose data-resourceid (without a hyphen).
        const directLists = [...document.querySelectorAll('#resource-selector-container [role="listbox"]')]
          .filter(isVisible);
        if (directLists.length) return directLists;
        return [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"]')]
          .filter(isVisible)
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 120 && rect.height > 40 && rect.top < window.innerHeight;
          });
      };
      const displayCurrent = currentResourceId
        ? decodeURIComponent(currentResourceId).replace(/^sc-domain:/, '').toLowerCase()
        : '';
      // This stable Search Console container is more reliable than guessing from the page's URL-inspection input.
      const selectorControl = document.querySelector('#resource-selector-container [role="button"], #resource-selector-container button, #resource-selector-container [aria-haspopup]');
      const propertyControl = selectorControl || [...document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], button, [role="button"]')]
        .filter(isVisible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = cleanText(`${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`).toLowerCase();
          if (/inspect|inspection|inspect any url|فحص عنوان url/.test(text)) return null;
          if (rect.top > 200 || rect.left > 360 || rect.width < 60) return null;
          let score = 0;
          if (text.includes(displayCurrent)) score += 100;
          if (/property|properties|site|sites|domain|domains|sc-domain|https?:\/\//.test(text)) score += 30;
          if (element.hasAttribute('aria-haspopup')) score += 15;
          if (rect.left < 280) score += 8;
          return score ? { element, score } : null;
        })
        .filter(Boolean)
        .sort((first, second) => second.score - first.score)[0]?.element;

      let menuWasOpened = false;
      let openedMenuRoots = [];
      if (propertyControl) {
        const pickerWasAlreadyOpen = propertyControl.getAttribute('aria-expanded') === 'true' || propertyMenuRoots().length > 0;
        if (!pickerWasAlreadyOpen) {
          propertyControl.click();
          menuWasOpened = true;
        }
        // Poll only until the real picker rows appear. On a warm GSC page this resolves
        // almost immediately, instead of pausing for a fixed multi-second delay.
        const pickerDeadline = Date.now() + 4000;
        while (Date.now() < pickerDeadline) {
          openedMenuRoots = propertyMenuRoots();
          openedMenuRoots.forEach((menuRoot) => scan(menuRoot));
          if (items.size) break;
          await pause(100);
        }
      }

      // GSC virtualizes long property lists. Scrolling the selector menu progressively
      // makes every accessible property appear in the DOM so it can be collected.
      const scrollRoots = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"], div')]
        .filter(isVisible)
        .filter((element) => !openedMenuRoots.length || openedMenuRoots.some((menuRoot) => menuRoot === element || menuRoot.contains(element)))
        .filter((element) => element.scrollHeight > element.clientHeight + 12 && element.clientHeight > 90)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const roleBonus = /listbox|menu|dialog/.test(element.getAttribute('role') || '') ? 1000 : 0;
          const sideBonus = rect.left < 520 ? 100 : 0;
          const resourcesInside = new Set([
            ...[...element.querySelectorAll('[data-resource-id], [data-resourceid]')]
              .map((node) => node.getAttribute('data-resourceid') || node.getAttribute('data-resource-id')),
            ...[...element.querySelectorAll('a[href*="resource_id="], [data-href*="resource_id="]')]
              .map((node) => resourceFromUrl(node.href || node.getAttribute('data-href'))),
            ...[...element.querySelectorAll('[role="menuitem"], [role="option"], [role="treeitem"]')]
              .filter(isVisible)
              .map((node) => resourceFromPropertyText(node.getAttribute('aria-label') || node.textContent))
          ].filter(Boolean)).size;
          // A property menu contains several unique Properties; report content only repeats
          // the current one. Count text-only Domain Properties as well as href-based ones.
          return { element, score: resourcesInside * 10000 + roleBonus + sideBonus + Math.min(element.clientHeight, 600) };
        })
        .sort((first, second) => second.score - first.score);
      const scrollRoot = scrollRoots[0]?.element;
      const expectedPickerRows = Math.max(0, ...openedMenuRoots.map((menuRoot) => Number(menuRoot.getAttribute('data-childcount')) || 0));
      // GSC counts its final "Add property" row in data-childcount, so the actual
      // resource count is normally one lower. Avoid needless scrolling when all rows
      // are already rendered (as is typical for the account picker).
      const pickerAlreadyFullyRead = expectedPickerRows > 0 && items.size >= expectedPickerRows - 1;

      if (scrollRoot && !pickerAlreadyFullyRead) {
        scrollRoot.scrollTop = 0;
        await pause(180);
        let stalledSteps = 0;
        let previousCount = items.size;
        for (let step = 0; step < 80 && stalledSteps < 4; step += 1) {
          scan(scrollRoot);
          const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2;
          if (items.size === previousCount) stalledSteps += 1;
          else stalledSteps = 0;
          previousCount = items.size;
          if (atBottom) break;
          scrollRoot.scrollTop = Math.min(scrollRoot.scrollTop + Math.max(160, scrollRoot.clientHeight * 0.8), scrollRoot.scrollHeight);
          await pause(180);
        }
        scan(scrollRoot);
        scrollRoot.scrollTop = 0;
      }

      if (menuWasOpened) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return [...items.values()];
    }
  });

  const found = result?.result || [];
  const all = new Map();
  found.forEach((property) => {
    if (property?.resourceId) all.set(property.resourceId, {
      resourceId: property.resourceId,
      // Use the normalized property name instead of menu/container text. This avoids
      // bogus labels such as "Google Search Console" becoming a report target.
      label: displayProperty(property.resourceId)
    });
  });

  // Do not fall back to the URL currently open in Search Console. Google often redirects
  // its home page to a remembered Property, which is not evidence that it is the first
  // or an accessible Property in this account.
  return [...all.values()];
}

async function discoverProperties() {
  return discoverPropertiesForTab(await getActiveTab());
}

function isExpectedReportRoute(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin
      && current.pathname === target.pathname
      && current.searchParams.get('resource_id') === target.searchParams.get('resource_id')
      && current.searchParams.get('num_of_days') === '7'
      && current.searchParams.get('compare_date') === 'PREV';
  } catch {
    return false;
  }
}

async function throwIfCancelled(runId) {
  if (runId && await cancellationRequested(runId)) throw new Error('__CANCELLED__');
}

async function sleepWithCancellation(runId, milliseconds) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    await throwIfCancelled(runId);
    await sleep(Math.min(250, Math.max(1, until - Date.now())));
  }
  await throwIfCancelled(runId);
}

async function awaitWithCancellation(promise, runId) {
  if (!runId) return promise;
  let settled = false;
  const cancellation = (async () => {
    while (!settled) {
      await throwIfCancelled(runId);
      await sleep(250);
    }
  })();
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    settled = true;
  }
}

async function waitForReportRoute(tabId, targetUrl, runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ROUTE_TIMEOUT_MS) {
    await throwIfCancelled(runId);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('تم إغلاق تبويب Google Search Console أثناء التشغيل.');
    }

    // Search Console is a single-page app. Moving between reports often changes the URL
    // without emitting a new "complete" tab-loading event, which caused the old 60s timeout.
    if (isExpectedReportRoute(tab.url, targetUrl)) return;
    await sleepWithCancellation(runId, 300);
  }
  throw new Error('لم يتم فتح رابط تقرير Google Search Console. تأكد أن حسابك لديه صلاحية للموقع وأنك ما زلت مسجل الدخول.');
}

async function navigateToReport(tabId, url, runId) {
  await throwIfCancelled(runId);
  // Leave the automation tab in the background. The report is captured through the
  // DevTools protocol, so it never needs to steal the user's active tab.
  await chrome.tabs.update(tabId, { url });
  await waitForReportRoute(tabId, url, runId);
  // Let the SPA finish replacing the old report card before reading its metrics.
  await sleepWithCancellation(runId, REPORT_SETTLE_DELAY_MS);
}

async function waitForPropertySelector(tabId, runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ROUTE_TIMEOUT_MS) {
    await throwIfCancelled(runId);
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => Boolean(document.querySelector('#resource-selector-container [role="button"], #resource-selector-container button, #resource-selector-container [aria-haspopup]'))
      });
      if (result?.result) return;
    } catch {
      throw new Error('تعذر الوصول إلى واجهة Google Search Console.');
    }
    await sleepWithCancellation(runId, 400);
  }
  throw new Error('لم تظهر قائمة الـ Properties في Search Console. تأكد من تسجيل الدخول وأن الحساب لديه مواقع مضافة.');
}

async function navigateToSearchConsoleHome(tabId, runId) {
  await throwIfCancelled(runId);
  // Do not bring Search Console to the foreground during automatic processing.
  await chrome.tabs.update(tabId, { url: SEARCH_CONSOLE_HOME_URL });
  const startedAt = Date.now();
  while (Date.now() - startedAt < ROUTE_TIMEOUT_MS) {
    await throwIfCancelled(runId);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isGscUrl(tab.url)) {
        // The selector waiter below already polls the rendered UI. A short settle keeps
        // startup responsive without racing GSC's initial navigation.
        await sleepWithCancellation(runId, SEARCH_CONSOLE_HOME_SETTLE_DELAY_MS);
        await waitForPropertySelector(tabId, runId);
        return chrome.tabs.get(tabId);
      }
    } catch {
      throw new Error('تم إغلاق تبويب Google Search Console أثناء التشغيل.');
    }
    await sleepWithCancellation(runId, 300);
  }
  throw new Error('تعذر فتح صفحة Google Search Console. تأكد من تسجيل الدخول إلى حساب Google.');
}

async function injectReporter(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await sleep(80);
}

async function runCalculationsInTab(tabId, reportType) {
  await injectReporter(tabId);
  return chrome.tabs.sendMessage(tabId, {
    type: 'GSC_SNAPSHOT_RUN_CALCULATIONS',
    reportType,
    waitForData: true
  });
}

function dataUrlFromBlob(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
  });
}

async function cropScreenshot(dataUrl, crop) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const scaleX = bitmap.width / crop.viewportWidth;
    const scaleY = bitmap.height / crop.viewportHeight;
    const sourceX = Math.max(0, Math.round(crop.x * scaleX));
    const sourceY = Math.max(0, Math.round(crop.y * scaleY));
    const sourceWidth = Math.min(bitmap.width - sourceX, Math.max(1, Math.round(crop.width * scaleX)));
    const sourceHeight = Math.min(bitmap.height - sourceY, Math.max(1, Math.round(crop.height * scaleY)));
    // Preserve the small pale GSC page margin around the rounded report surface.
    // It gives the saved image the same clean report-card framing as the reference screenshots.
    const frame = Math.max(4, Math.round(5 * scaleX));
    const canvas = new OffscreenCanvas(sourceWidth + frame * 2, sourceHeight + frame * 2);
    const context = canvas.getContext('2d');
    context.fillStyle = '#eef3f8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      frame,
      frame,
      sourceWidth,
      sourceHeight
    );
    return dataUrlFromBlob(await canvas.convertToBlob({ type: 'image/png' }));
  } finally {
    bitmap.close();
  }
}

async function captureVisibleTabFallback(tabId) {
  // This branch is only used when another DevTools client prevents debugger attachment.
  // The regular path below captures entirely in the background.
  const reportTab = await chrome.tabs.get(tabId);
  const [previousActiveTab] = await chrome.tabs.query({ active: true, windowId: reportTab.windowId });
  const mustSwitch = previousActiveTab?.id !== tabId;
  if (mustSwitch) await chrome.tabs.update(tabId, { active: true });
  try {
    return await chrome.tabs.captureVisibleTab(reportTab.windowId, { format: 'png' });
  } finally {
    const [currentActiveTab] = await chrome.tabs.query({ active: true, windowId: reportTab.windowId });
    if (mustSwitch && currentActiveTab?.id === tabId && previousActiveTab?.id) {
      await chrome.tabs.update(previousActiveTab.id, { active: true }).catch(() => {});
    }
  }
}

async function captureBackgroundTab(tabId) {
  const target = { tabId };
  let attached = false;
  let debuggerError = null;
  try {
    // captureVisibleTab only works for the foreground tab and loses its activeTab grant
    // after navigation. CDP captures this specific GSC tab while the user works elsewhere.
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    if (!result?.data) throw new Error('لم يستجب المتصفح ببيانات الصورة.');
    return `data:image/png;base64,${result.data}`;
  } catch (error) {
    debuggerError = error;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // Closing the tab or detaching elsewhere should not hide the original failure.
      }
    }
  }

  try {
    return await captureVisibleTabFallback(tabId);
  } catch (fallbackError) {
    throw new Error(`تعذر التقاط صورة التقرير: ${debuggerError?.message || debuggerError || 'تعذر استخدام الالتقاط في الخلفية'}؛ ${fallbackError.message || fallbackError}`);
  }
}

async function captureReport(tabId, property, reportType, metrics = null) {
  const target = await chrome.tabs.sendMessage(tabId, {
    type: 'GSC_SNAPSHOT_PREPARE_CAPTURE',
    reportType
  });
  if (!target?.ok) throw new Error(target?.error || 'تعذر تجهيز لقطة الشاشة.');

  const fullScreenshot = await captureBackgroundTab(tabId);
  let image = fullScreenshot;
  try {
    image = await cropScreenshot(fullScreenshot, target.crop);
  } catch (error) {
    // A complete report capture is preferable to dropping a finished report if browser image APIs fail.
    console.warn('Could not crop Search Console screenshot', error);
  }

  const createdAt = Date.now();
  const filename = reportFileName(property, createdAt);
  const snapshot = await saveSnapshot({
    propertyLabel: property.label,
    resourceId: property.resourceId,
    reportType,
    metrics,
    filename,
    createdAt,
    imageData: image
  });
  chrome.runtime.sendMessage({ type: 'SNAPSHOT_LIBRARY_UPDATED' }).catch(() => {
    // No side panel is open; the image is still safely saved in IndexedDB.
  });
  return { snapshotId: snapshot.id, filename };
}

async function cancellationRequested(runId) {
  const state = await getRunState();
  return !state || state.id !== runId || Boolean(state.cancelRequested);
}

async function setRecord(runId, index, changes) {
  return updateRunState(runId, (state) => {
    const record = state.records[index];
    if (!record) return;
    Object.assign(record, changes);
  });
}

async function runReport(runId, tabId, property, reportType, recordIndex, { capture = true } = {}) {
  const routeName = reportType === 'generative-ai' ? 'Generative AI features' : 'Performance';
  const targetUrl = reportUrl(property.resourceId, reportType);
  let lastError;

  for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
    try {
      await setRecord(runId, recordIndex, {
        detail: attempt === 1
          ? `جارٍ فتح ${routeName}…`
          : `لم تكتمل البيانات بعد؛ جارٍ إعادة محاولة ${routeName} (${attempt}/${MAX_REPORT_ATTEMPTS})…`
      });
      await logRunEvent(runId, `فتح تقرير ${routeName} لـ ${property.label}.`, 'info');
      await navigateToReport(tabId, targetUrl, runId);
      await throwIfCancelled(runId);

      await setRecord(runId, recordIndex, { detail: `جارٍ انتظار وتحليل بيانات ${routeName}…` });
      const calculation = await awaitWithCancellation(runCalculationsInTab(tabId, reportType), runId);
      if (!calculation?.ok) throw new Error(calculation?.error || `تعذر قراءة مقارنة ${routeName}.`);
      await logRunEvent(runId, `تمت قراءة وحساب مقارنة ${routeName} لـ ${property.label}.`, 'info');
      await throwIfCancelled(runId);

      if (!capture) return { calculation };
      await setRecord(runId, recordIndex, { detail: `جارٍ تثبيت وحفظ لقطة ${routeName} في مكتبة الإكستنشن…` });
      await logRunEvent(runId, `جارٍ حفظ لقطة ${routeName} داخل مكتبة الإكستنشن.`, 'info');
      await sleepWithCancellation(runId, 700);
      await throwIfCancelled(runId);
      const saved = await captureReport(tabId, property, reportType, calculation.metrics);
      return { calculation, saved };
    } catch (error) {
      if (error.message === '__CANCELLED__') throw error;
      lastError = error;
    }
  }

  throw new Error(lastError?.message || `تعذر تحميل تقرير ${routeName}.`);
}

function isUnavailablePropertyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /you don't have access|you do not have access|not available|no data|صلاحية|غير متاح|لا توجد بيانات|property/.test(message);
}

async function processRun(runId) {
  let initialState = await getRunState();
  if (!initialState || initialState.id !== runId) return;

  const { tabId, properties, options } = initialState;
  try {
    for (let index = 0; index < properties.length; index += 1) {
      if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');
      const property = properties[index];
      if (property.unavailable) {
        await setRecord(runId, index, {
          status: 'skipped',
          detail: 'تم التخطي: هذا الـ Property غير موجود أو غير متاح في حساب Google Search Console الحالي.',
          performance: { status: 'skipped' },
          generativeAi: { status: 'skipped' }
        });
        await logRunEvent(runId, `تم تخطي ${property.label}: غير موجود في حساب Search Console الحالي.`, 'warning');
        continue;
      }
      await setRecord(runId, index, { status: 'running', detail: 'جارٍ بدء الموقع…' });
      await logRunEvent(runId, `بدء معالجة ${property.label} — الموقع ${index + 1} من ${properties.length}.`, 'info');

      try {
        // Calculate first so declining clicks can be filtered before any image is saved.
        const performance = await runReport(runId, tabId, property, 'performance', index, { capture: false });
        const clicks = performance.calculation.metrics?.clicks || null;
        await setRecord(runId, index, { clicks });

        const hasDecliningClicks = clicks
          && Number.isFinite(clicks.current)
          && Number.isFinite(clicks.previous)
          && clicks.current < clicks.previous;
        if (options.skipDecliningClicks && hasDecliningClicks) {
          await setRecord(runId, index, {
            status: 'skipped',
            detail: 'تم التخطي: النقرات أقل من الأسبوع السابق، لذلك لم يتم حفظ أي مقارنة.',
            performance: { status: 'skipped' },
            generativeAi: { status: 'skipped' }
          });
          await logRunEvent(runId, `تم تخطي ${property.label}: النقرات أقل من الأسبوع السابق.`, 'warning');
          continue;
        }

        await setRecord(runId, index, { detail: 'جارٍ حفظ لقطة Performance في مكتبة الإكستنشن…' });
        await throwIfCancelled(runId);
        const performanceSaved = await captureReport(tabId, property, 'performance', performance.calculation.metrics);
        await throwIfCancelled(runId);
        await setRecord(runId, index, {
          performance: { status: 'captured', ...performanceSaved }
        });

        if (options.includeGenerativeAi) {
          try {
            const generativeAi = await runReport(runId, tabId, property, 'generative-ai', index);
            await setRecord(runId, index, {
              generativeAi: { status: 'captured', ...generativeAi.saved }
            });
          } catch (error) {
            if (error.message === '__CANCELLED__') throw error;
            await setRecord(runId, index, {
              generativeAi: { status: 'unavailable', error: error.message }
            });
            await logRunEvent(runId, `تقرير Generative AI غير متاح لـ ${property.label}، تم الاكتفاء بـ Performance.`, 'warning');
          }
        }

        await setRecord(runId, index, { status: 'completed', detail: 'اكتمل.' });
        await logRunEvent(runId, `اكتمل ${property.label} وتم حفظ اللقطات المتاحة في المكتبة.`, 'success');
      } catch (error) {
        if (error.message === '__CANCELLED__') throw error;
        const unavailable = isUnavailablePropertyError(error);
        await setRecord(runId, index, {
          status: unavailable ? 'skipped' : 'error',
          detail: unavailable ? 'تم التخطي: هذا الـ Property غير متاح في الحساب الحالي أو لا يملك بيانات قابلة للمقارنة.' : '',
          error: error.message,
          performance: { status: unavailable ? 'skipped' : 'error', error: error.message },
          generativeAi: unavailable ? { status: 'skipped' } : { status: 'queued' }
        });
        await logRunEvent(
          runId,
          unavailable
            ? `تم تخطي ${property.label}: غير متاح في الحساب الحالي أو لا توجد بيانات قابلة للمقارنة.`
            : `تعذر إكمال ${property.label}: ${error.message}`,
          unavailable ? 'warning' : 'error'
        );
      }
    }

    await updateRunState(runId, (state) => {
      state.status = 'completed';
      state.message = 'اكتمل حفظ جميع التقارير المتاحة داخل مكتبة الإكستنشن.';
      state.cancelRequested = false;
      appendRunEvent(state, 'اكتمل التشغيل بالكامل. يمكنك مراجعة الصور من مكتبة اللقطات.', 'success');
    });
  } catch (error) {
    if (error.message === '__CANCELLED__') {
      await updateRunState(runId, (state) => {
        state.status = 'cancelled';
        state.message = 'تم إيقاف التشغيل بناءً على طلبك.';
        appendRunEvent(state, 'تم إيقاف التشغيل بناءً على طلبك.', 'warning');
      });
    } else {
      await updateRunState(runId, (state) => {
        state.status = 'failed';
        state.message = error.message || 'حدث خطأ غير متوقع أثناء التشغيل.';
        appendRunEvent(state, state.message, 'error');
      });
    }
  }
}

function queuedRecords(properties) {
  return properties.map((property) => ({
    ...property,
    status: 'queued',
    performance: { status: 'queued' },
    generativeAi: { status: 'queued' }
  }));
}

async function bootstrapAndProcessRun(runId) {
  let state = await getRunState();
  if (!state || state.id !== runId) return;

  try {
    await updateRunState(runId, (latest) => {
      latest.message = 'تم بدء التشغيل. جارٍ فتح Google Search Console واستخراج كل الـ Properties…';
      latest.records[0].status = 'running';
      latest.records[0].detail = 'جارٍ فتح صفحة Google Search Console…';
      appendRunEvent(latest, 'تم استلام أمر التشغيل. جارٍ فتح صفحة Google Search Console.', 'info');
    });
    const tab = await navigateToSearchConsoleHome(state.tabId, runId);
    await throwIfCancelled(runId);

    await updateRunState(runId, (latest) => {
      latest.records[0].detail = 'جارٍ قراءة كل الـ Properties من حساب Search Console…';
      appendRunEvent(latest, 'تم فتح Search Console. جارٍ قراءة قائمة الـ Properties المتاحة.', 'info');
    });
    const discoveredProperties = await awaitWithCancellation(discoverPropertiesForTab(tab), runId);
    await throwIfCancelled(runId);

    if (!discoveredProperties.length && state.runMode === 'all') {
      throw new Error('لم يتم العثور على أي Property يمكن الوصول إليه في حساب Search Console المفتوح.');
    }

    const selection = state.runMode === 'selected'
      ? resolveRequestedProperties(discoveredProperties, state.requestedProperties)
      : {
        properties: preferDomainProperties(discoveredProperties),
        matchedCount: discoveredProperties.length,
        missingCount: 0
      };
    const properties = selection.properties;
    if (!properties.length) throw new Error('لم يتم العثور على Properties مطابقة للقائمة المطلوبة.');

    await updateRunState(runId, (latest) => {
      latest.properties = properties;
      latest.records = queuedRecords(properties);
      latest.message = state.runMode === 'selected'
        ? `سيتم تنفيذ ${properties.length} سطر بنفس الترتيب الذي أدخلته: ${selection.matchedCount} موجود و${selection.missingCount} سيتم تخطيه.`
        : `تم استخراج ${discoveredProperties.length} Property واختيار ${properties.length} Domain Property مفضلة. جارٍ بدء التشغيل…`;
      appendRunEvent(
        latest,
        state.runMode === 'selected'
          ? `تم ترتيب المواقع كما أدخلتها: ${selection.matchedCount} Property متاح و${selection.missingCount} سيتم تخطيه دون فتحه.`
          : `تم استخراج ${discoveredProperties.length} Property بعد إزالة التكرارات واختيار ${properties.length} Domain Property.`,
        selection.missingCount ? 'warning' : 'success'
      );
    });
    await processRun(runId);
  } catch (error) {
    state = await getRunState();
    if (!state || state.id !== runId) return;
    await updateRunState(runId, (latest) => {
      if (error.message === '__CANCELLED__') {
        latest.status = 'cancelled';
        latest.message = 'تم إيقاف التشغيل بناءً على طلبك.';
        appendRunEvent(latest, 'تم إيقاف التشغيل أثناء تجهيز قائمة المواقع.', 'warning');
      } else {
        latest.status = 'failed';
        latest.message = error.message || 'تعذر تجهيز تشغيل التقرير.';
        appendRunEvent(latest, latest.message, 'error');
        if (latest.records[0]) {
          latest.records[0].status = 'error';
          latest.records[0].error = latest.message;
          latest.records[0].detail = '';
        }
      }
    });
  }
}

async function startRun(message) {
  const existing = await getRunState();
  if (existing?.status === 'running' || existing?.status === 'cancelling') {
    throw new Error('يوجد تقرير قيد التشغيل بالفعل. أوقفه أو أعد ضبط الواجهة أولًا.');
  }

  let tab = await getActiveTab();
  // If the side panel was opened away from GSC, protect the current page by creating
  // a dedicated Search Console tab for the fully automatic run.
  if (!isGscUrl(tab.url)) {
    // A dedicated non-active tab makes it possible to run the whole batch while the
    // user keeps browsing. It is captured through chrome.debugger, not the viewport.
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  }

  const runMode = message.mode === 'selected' ? 'selected' : 'all';
  const requestedProperties = [...new Set((message.rawProperties || []).map((value) => String(value).trim()).filter(Boolean))];
  if (runMode === 'selected' && !requestedProperties.length) {
    throw new Error('أضف رابط موقع واحد على الأقل أو اختر تشغيل كل المواقع.');
  }
  // Validate user-provided links before opening Search Console, so invalid input fails immediately.
  if (runMode === 'selected') requestedProperties.forEach(normaliseProperty);
  const properties = [{ resourceId: '', label: 'حساب Google Search Console' }];

  // Respect the browser zoom selected by the user. Screenshot cropping already adapts
  // to the viewport scale, so changing Chrome's zoom is unnecessary and distracting.
  const automaticDiscovery = true;
  const state = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    startedAt: Date.now(),
    tabId: tab.id,
    runMode,
    requestedProperties,
    properties,
    options: {
      skipDecliningClicks: message.options?.skipDecliningClicks !== false,
      includeGenerativeAi: message.options?.includeGenerativeAi !== false
    },
    records: queuedRecords(properties),
    events: [{ id: `${Date.now()}-start`, at: Date.now(), message: 'تم بدء التشغيل بنجاح في الخلفية. يمكنك الانتقال لأي تبويب آخر وسيستمر حفظ اللقطات.', type: 'success' }],
    message: 'تم بدء التشغيل في الخلفية. جارٍ فتح Google Search Console تلقائيًا…',
    cancelRequested: false
  };
  await saveRunState(state);

  // Return immediately so the side panel confirms that the run has started before GSC is opened.
  const runner = automaticDiscovery ? bootstrapAndProcessRun(state.id) : processRun(state.id);
  runner.catch(async (error) => {
    await updateRunState(state.id, (latest) => {
      latest.status = 'failed';
      latest.message = error.message || 'تعذر تشغيل التقرير.';
    });
  });
  return { started: true, state };
}

async function resetRunInterface() {
  // Run status and log live in chrome.storage.local. Snapshot images are held in
  // IndexedDB, so this never touches the screenshot library.
  await chrome.storage.local.remove(RUN_STORAGE_KEY);
  return { reset: true };
}

async function exportSnapshot(snapshotId) {
  const snapshot = await getSnapshot(snapshotId);
  if (!snapshot?.imageData) throw new Error('الصورة المطلوبة غير موجودة في مكتبة الإكستنشن.');
  // Rebuild the path on export so old library entries also follow the folder/date layout.
  const filename = reportFileName({ label: snapshot.propertyLabel }, snapshot.createdAt);
  const downloadId = await chrome.downloads.download({
    url: snapshot.imageData,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { downloadId, filename };
}

function configureSidePanel() {
  if (!chrome.sidePanel) return;
  // The extension action opens this persistent right-side panel directly; there is no transient popup.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.debug('Could not configure side-panel action behavior.', error);
  });
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch((error) => {
    console.debug('Could not configure the snapshot side panel.', error);
  });
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return undefined;

  const handlers = {
    GET_RUN_STATE: async () => ({ state: await getRunState() }),
    GET_CURRENT_PROPERTY: getCurrentProperty,
    DISCOVER_PROPERTIES: async () => ({ properties: await discoverProperties() }),
    GET_SNAPSHOT_SUMMARY: async () => snapshotSummary(),
    LIST_SNAPSHOTS: async () => ({ snapshots: await listSnapshots() }),
    GET_SNAPSHOT: async () => ({ snapshot: await getSnapshot(message.snapshotId) }),
    DELETE_SNAPSHOT: async () => {
      await deleteSnapshot(message.snapshotId);
      return snapshotSummary();
    },
    CLEAR_SNAPSHOTS: async () => {
      await clearSnapshots();
      return { count: 0 };
    },
    EXPORT_SNAPSHOT: async () => exportSnapshot(message.snapshotId),
    RESET_RUN_INTERFACE: resetRunInterface,
    START_RUN: () => startRun(message),
    CANCEL_RUN: async () => {
      const state = await getRunState();
      if (state?.status === 'running' || state?.status === 'cancelling') {
        state.cancelRequested = true;
        state.status = 'cancelling';
        state.message = 'جارٍ إيقاف التشغيل الآن…';
        appendRunEvent(state, 'تم استلام طلب الإيقاف. لن يتم فتح أو حفظ أي تقرير جديد.', 'warning');
        await saveRunState(state);
      }
      return { state };
    }
  };

  const handler = handlers[message.type];
  if (!handler) return undefined;
  handler()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || String(error) }));
  return true;
});
