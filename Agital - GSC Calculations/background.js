const RUN_STORAGE_KEY = 'agitalGscAutoReporterRun';
const GSC_ORIGIN = 'https://search.google.com';
const REPORT_ZOOM = 0.8;
const LOAD_TIMEOUT_MS = 60000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  return `GSC week over week/${safeFileSegment(property.label)}/${reportName}-week-over-week-${day}.png`;
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

  // The URL is the source of truth. The small DOM probe only improves the label shown in the popup.
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
    func: async () => {
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const readResources = () => {
        const items = new Map();
        const add = (resourceId, label) => {
          if (!resourceId || items.has(resourceId)) return;
          items.set(resourceId, { resourceId, label: (label || resourceId).trim() });
        };

        document.querySelectorAll('a[href*="resource_id="]').forEach((link) => {
          try {
            const resourceId = new URL(link.href).searchParams.get('resource_id');
            add(resourceId, link.textContent);
          } catch {
            // Ignore malformed navigation links.
          }
        });
        document.querySelectorAll('[data-resource-id]').forEach((element) => {
          add(element.getAttribute('data-resource-id'), element.textContent);
        });
        return [...items.values()];
      };

      let resources = readResources();
      if (resources.length < 2) {
        const buttons = [...document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], button')];
        const propertyControl = buttons.find((element) => {
          const rect = element.getBoundingClientRect();
          const text = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
          return rect.left < 380 && rect.top < 190 && rect.width > 70 && /property|site|domain|https?:\/\//i.test(text);
        });
        if (propertyControl) {
          propertyControl.click();
          await pause(650);
          resources = readResources();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      }
      return resources;
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
  return [...all.values()];
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      callback(value);
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(reject, new Error('تم إغلاق تبويب Google Search Console أثناء التشغيل.'));
    };
    const timer = setTimeout(() => finish(reject, new Error('استغرق تحميل Google Search Console وقتًا أطول من المتوقع.')), LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function navigateToReport(tabId, url) {
  const loading = waitForTabLoad(tabId);
  await chrome.tabs.update(tabId, { url, active: true });
  await loading;
  // The tab reports "complete" before Search Console finishes its client-side data request.
  await sleep(850);
}

async function injectReporter(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await sleep(80);
}

async function runCalculationsInTab(tabId, reportType) {
  await injectReporter(tabId);
  return chrome.tabs.sendMessage(tabId, {
    type: 'AGITAL_RUN_CALCULATIONS',
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
    const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    canvas.getContext('2d').drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    return dataUrlFromBlob(await canvas.convertToBlob({ type: 'image/png' }));
  } finally {
    bitmap.close();
  }
}

async function captureReport(tabId, windowId, property, reportType) {
  await chrome.tabs.update(tabId, { active: true });
  const target = await chrome.tabs.sendMessage(tabId, {
    type: 'AGITAL_PREPARE_CAPTURE',
    reportType
  });
  if (!target?.ok) throw new Error(target?.error || 'تعذر تجهيز لقطة الشاشة.');

  const fullScreenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  let image = fullScreenshot;
  try {
    image = await cropScreenshot(fullScreenshot, target.crop);
  } catch (error) {
    // A full report screenshot is preferable to dropping a finished report if browser image APIs fail.
    console.warn('Could not crop Search Console screenshot', error);
  }

  const downloadId = await chrome.downloads.download({
    url: image,
    filename: reportFileName(property, reportType),
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { downloadId, filename: reportFileName(property, reportType) };
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
  await setRecord(runId, recordIndex, { detail: `جارٍ فتح ${routeName}…` });
  await navigateToReport(tabId, reportUrl(property.resourceId, reportType));
  if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');

  await setRecord(runId, recordIndex, { detail: `جارٍ حساب التغيير في ${routeName}…` });
  const calculation = await runCalculationsInTab(tabId, reportType);
  if (!calculation?.ok) throw new Error(calculation?.error || `تعذر قراءة مقارنة ${routeName}.`);
  if (await cancellationRequested(runId)) throw new Error('__CANCELLED__');

  if (!capture) return { calculation };
  await setRecord(runId, recordIndex, { detail: `جارٍ حفظ لقطة ${routeName}…` });
  const saved = await captureReport(tabId, windowId, property, reportType);
  return { calculation, saved };
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

        await setRecord(runId, index, { detail: 'جارٍ حفظ لقطة Performance…' });
        const performanceSaved = await captureReport(tabId, windowId, property, 'performance');
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
      state.message = 'اكتمل حفظ جميع التقارير المتاحة في التنزيلات.';
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

  // Do not await the long-running flow: the popup receives an immediate response and may be closed safely.
  processRun(state.id).catch(async (error) => {
    await updateRunState(state.id, (latest) => {
      latest.status = 'failed';
      latest.message = error.message || 'تعذر تشغيل التقرير.';
    });
  });
  return { started: true, state };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return undefined;

  const handlers = {
    GET_RUN_STATE: async () => ({ state: await getRunState() }),
    GET_CURRENT_PROPERTY: getCurrentProperty,
    DISCOVER_PROPERTIES: async () => ({ properties: await discoverProperties() }),
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
