const RUN_STORAGE_KEY = 'gscSnapshotProRun';
const GSC_ORIGIN = 'https://search.google.com';
const REPORT_ZOOM = 0.8;
const ROUTE_TIMEOUT_MS = 30000;
const REPORT_SETTLE_DELAY_MS = 2200;
const MAX_REPORT_ATTEMPTS = 1;
const SNAPSHOT_DB_NAME = 'gscSnapshotProDatabase';
const SNAPSHOT_STORE_NAME = 'snapshots';

let snapshotDatabasePromise;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createSnapshotId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openSnapshotDatabase() {
  if (snapshotDatabasePromise) return snapshotDatabasePromise;
  snapshotDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        const store = database.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('resourceId', 'resourceId');
      }
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
  const database = await openSnapshotDatabase();
  const record = { id: createSnapshotId(), ...snapshot };
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

function reportFileName(property, reportType) {
  const day = new Date().toISOString().slice(0, 10);
  const reportName = reportType === 'generative-ai' ? 'generative-ai' : 'performance';
  return `GSC Snapshot Pro/${safeFileSegment(property.label)}/${reportName}-week-over-week-${day}.png`;
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

async function discoverProperties() {
  const tab = await getActiveTab();
  const current = propertyFromUrl(tab.url);
  if (!current) throw new Error('افتح Google Search Console أولًا لاستيراد قائمة الخصائص.');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [current.resourceId],
    func: async (currentResourceId) => {
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const items = new Map();
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const add = (resourceId, label) => {
        if (!resourceId || items.has(resourceId)) return;
        items.set(resourceId, { resourceId, label: cleanText(label) || resourceId });
      };
      const resourceFromUrl = (value) => {
        try {
          return new URL(value, location.href).searchParams.get('resource_id');
        } catch {
          return null;
        }
      };
      const scan = (root = document) => {
        root.querySelectorAll('[data-resource-id]').forEach((element) => {
          add(element.getAttribute('data-resource-id'), element.getAttribute('aria-label') || element.textContent);
        });
        root.querySelectorAll('a[href*="resource_id="], [data-href*="resource_id="]').forEach((element) => {
          const resourceId = resourceFromUrl(element.href || element.getAttribute('data-href'));
          add(resourceId, element.getAttribute('aria-label') || element.textContent);
        });
      };
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      };
      const displayCurrent = decodeURIComponent(currentResourceId).replace(/^sc-domain:/, '').toLowerCase();
      // This stable Search Console container is more reliable than guessing from the page's URL-inspection input.
      const selectorControl = document.querySelector('#resource-selector-container [role="button"][aria-haspopup="menu"]');
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

      scan();
      let menuWasOpened = false;
      if (propertyControl) {
        propertyControl.click();
        menuWasOpened = true;
        await pause(800);
        scan();
      }

      // GSC virtualizes long property lists. Scrolling the selector menu progressively
      // makes every accessible property appear in the DOM so it can be collected.
      const scrollRoots = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], div')]
        .filter(isVisible)
        .filter((element) => element.scrollHeight > element.clientHeight + 12 && element.clientHeight > 90)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const roleBonus = /listbox|menu|dialog/.test(element.getAttribute('role') || '') ? 1000 : 0;
          const sideBonus = rect.left < 520 ? 100 : 0;
          const resourcesInside = new Set([
            ...[...element.querySelectorAll('[data-resource-id]')].map((node) => node.getAttribute('data-resource-id')),
            ...[...element.querySelectorAll('a[href*="resource_id="], [data-href*="resource_id="]')]
              .map((node) => resourceFromUrl(node.href || node.getAttribute('data-href')))
          ].filter(Boolean)).size;
          // A property menu contains several unique resource ids; report content only repeats the current one.
          return { element, score: resourcesInside * 10000 + roleBonus + sideBonus + Math.min(element.clientHeight, 600) };
        })
        .sort((first, second) => second.score - first.score);
      const scrollRoot = scrollRoots[0]?.element;

      if (scrollRoot) {
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
  const all = new Map([[current.resourceId, current]]);
  found.forEach((property) => {
    if (property?.resourceId) all.set(property.resourceId, {
      resourceId: property.resourceId,
      label: property.label || displayProperty(property.resourceId)
    });
  });
  return [...all.values()].sort((first, second) => first.label.localeCompare(second.label));
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

async function waitForReportRoute(tabId, targetUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ROUTE_TIMEOUT_MS) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('تم إغلاق تبويب Google Search Console أثناء التشغيل.');
    }

    // Search Console is a single-page app. Moving between reports often changes the URL
    // without emitting a new "complete" tab-loading event, which caused the old 60s timeout.
    if (isExpectedReportRoute(tab.url, targetUrl)) return;
    await sleep(300);
  }
  throw new Error('لم يتم فتح رابط تقرير Google Search Console. تأكد أن حسابك لديه صلاحية للموقع وأنك ما زلت مسجل الدخول.');
}

async function navigateToReport(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForReportRoute(tabId, url);
  // Let the SPA finish replacing the old report card before reading its metrics.
  await sleep(REPORT_SETTLE_DELAY_MS);
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

async function captureReport(tabId, windowId, property, reportType, metrics = null) {
  await chrome.tabs.update(tabId, { active: true });
  const target = await chrome.tabs.sendMessage(tabId, {
    type: 'GSC_SNAPSHOT_PREPARE_CAPTURE',
    reportType
  });
  if (!target?.ok) throw new Error(target?.error || 'تعذر تجهيز لقطة الشاشة.');

  const fullScreenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  let image = fullScreenshot;
  try {
    image = await cropScreenshot(fullScreenshot, target.crop);
  } catch (error) {
    // A complete report capture is preferable to dropping a finished report if browser image APIs fail.
    console.warn('Could not crop Search Console screenshot', error);
  }

  const filename = reportFileName(property, reportType);
  const snapshot = await saveSnapshot({
    propertyLabel: property.label,
    resourceId: property.resourceId,
    reportType,
    metrics,
    filename,
    createdAt: Date.now(),
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

async function runReport(runId, tabId, windowId, property, reportType, recordIndex, { capture = true } = {}) {
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
      await navigateToReport(tabId, targetUrl);
      if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');

      await setRecord(runId, recordIndex, { detail: `جارٍ انتظار وتحليل بيانات ${routeName}…` });
      const calculation = await runCalculationsInTab(tabId, reportType);
      if (!calculation?.ok) throw new Error(calculation?.error || `تعذر قراءة مقارنة ${routeName}.`);
      if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');

      if (!capture) return { calculation };
      await setRecord(runId, recordIndex, { detail: `جارٍ تثبيت وحفظ لقطة ${routeName} في مكتبة الإكستنشن…` });
      await sleep(700);
      const saved = await captureReport(tabId, windowId, property, reportType, calculation.metrics);
      return { calculation, saved };
    } catch (error) {
      if (error.message === '__CANCELLED__') throw error;
      lastError = error;
    }
  }

  throw new Error(lastError?.message || `تعذر تحميل تقرير ${routeName}.`);
}

async function processRun(runId) {
  let initialState = await getRunState();
  if (!initialState || initialState.id !== runId) return;

  const { tabId, windowId, properties, options, originalZoom } = initialState;
  try {
    for (let index = 0; index < properties.length; index += 1) {
      if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');
      const property = properties[index];
      await setRecord(runId, index, { status: 'running', detail: 'جارٍ بدء الموقع…' });

      try {
        // Calculate first so declining clicks can be filtered before any image is saved.
        const performance = await runReport(runId, tabId, windowId, property, 'performance', index, { capture: false });
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
          continue;
        }

        await setRecord(runId, index, { detail: 'جارٍ حفظ لقطة Performance في مكتبة الإكستنشن…' });
        const performanceSaved = await captureReport(tabId, windowId, property, 'performance', performance.calculation.metrics);
        await setRecord(runId, index, {
          performance: { status: 'captured', ...performanceSaved }
        });

        if (options.includeGenerativeAi) {
          try {
            const generativeAi = await runReport(runId, tabId, windowId, property, 'generative-ai', index);
            await setRecord(runId, index, {
              generativeAi: { status: 'captured', ...generativeAi.saved }
            });
          } catch (error) {
            if (error.message === '__CANCELLED__') throw error;
            await setRecord(runId, index, {
              generativeAi: { status: 'unavailable', error: error.message }
            });
          }
        }

        await setRecord(runId, index, { status: 'completed', detail: 'اكتمل.' });
      } catch (error) {
        if (error.message === '__CANCELLED__') throw error;
        await setRecord(runId, index, {
          status: 'error',
          detail: '',
          error: error.message,
          performance: { status: 'error', error: error.message }
        });
      }
    }

    await updateRunState(runId, (state) => {
      state.status = 'completed';
      state.message = 'اكتمل حفظ جميع التقارير المتاحة داخل مكتبة الإكستنشن.';
      state.cancelRequested = false;
    });
  } catch (error) {
    if (error.message === '__CANCELLED__') {
      await updateRunState(runId, (state) => {
        state.status = 'cancelled';
        state.message = 'تم إيقاف التشغيل بناءً على طلبك.';
      });
    } else {
      await updateRunState(runId, (state) => {
        state.status = 'failed';
        state.message = error.message || 'حدث خطأ غير متوقع أثناء التشغيل.';
      });
    }
  } finally {
    if (Number.isFinite(originalZoom)) {
      try {
        await chrome.tabs.setZoom(tabId, originalZoom);
      } catch {
        // The tab may have been closed. The run status already communicates that failure.
      }
    }
  }
}

async function startRun(message) {
  const existing = await getRunState();
  if (existing?.status === 'running') throw new Error('يوجد تقرير قيد التشغيل بالفعل.');

  const current = await getCurrentProperty();
  const tab = current.tab;
  if (!tab?.id || !current.property) throw new Error(current.reason || 'افتح موقعًا داخل Google Search Console أولًا.');

  const inputs = message.rawProperties?.length ? message.rawProperties : [current.property.resourceId];
  const unique = new Map();
  inputs.forEach((input) => {
    const resourceId = normaliseProperty(input);
    unique.set(resourceId, { resourceId, label: displayProperty(resourceId) });
  });
  const properties = [...unique.values()];
  if (!properties.length) throw new Error('أضف موقعًا واحدًا على الأقل.');

  let originalZoom = 1;
  try {
    originalZoom = await chrome.tabs.getZoom(tab.id);
    await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
    await chrome.tabs.setZoom(tab.id, REPORT_ZOOM);
  } catch {
    // Zoom is only to fit the report card into one capture. The report can still run at the existing zoom.
  }

  const state = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    startedAt: Date.now(),
    tabId: tab.id,
    windowId: tab.windowId,
    originalZoom,
    properties,
    options: {
      skipDecliningClicks: message.options?.skipDecliningClicks !== false,
      includeGenerativeAi: message.options?.includeGenerativeAi !== false
    },
    records: properties.map((property) => ({
      ...property,
      status: 'queued',
      performance: { status: 'queued' },
      generativeAi: { status: 'queued' }
    })),
    message: 'جارٍ تجهيز التقرير…',
    cancelRequested: false
  };
  await saveRunState(state);

  // Do not await the long-running flow: the side panel receives an immediate response and can stay open safely.
  processRun(state.id).catch(async (error) => {
    await updateRunState(state.id, (latest) => {
      latest.status = 'failed';
      latest.message = error.message || 'تعذر تشغيل التقرير.';
    });
  });
  return { started: true, state };
}

async function openSnapshotSidePanel(tabId) {
  if (!chrome.sidePanel) throw new Error('ميزة Side Panel تحتاج إصدار Chrome حديث.');
  const targetTabId = tabId || (await getActiveTab()).id;
  await chrome.sidePanel.setOptions({
    tabId: targetTabId,
    path: 'sidepanel.html',
    enabled: true
  });
  await chrome.sidePanel.open({ tabId: targetTabId });
  return { ok: true };
}

async function exportSnapshot(snapshotId) {
  const snapshot = await getSnapshot(snapshotId);
  if (!snapshot?.imageData) throw new Error('الصورة المطلوبة غير موجودة في مكتبة الإكستنشن.');
  const downloadId = await chrome.downloads.download({
    url: snapshot.imageData,
    filename: snapshot.filename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { downloadId, filename: snapshot.filename };
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
    OPEN_SNAPSHOT_SIDEBAR: async () => openSnapshotSidePanel(message.tabId),
    START_RUN: () => startRun(message),
    CANCEL_RUN: async () => {
      const state = await getRunState();
      if (state?.status === 'running') {
        state.cancelRequested = true;
        state.message = 'سيتم الإيقاف بعد المرحلة الحالية…';
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
