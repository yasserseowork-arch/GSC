const $ = (selector) => document.querySelector(selector);

let currentProperty = null;
let pollingTimer = null;

function setManualStatus(message, type = '') {
  const element = $('#manual-status');
  element.textContent = message;
  element.style.color = type === 'error' ? '#c33535' : type === 'success' ? '#137a40' : '#62708a';
}

function showError(error) {
  const message = error?.message || String(error);
  setManualStatus(message, 'error');
}

function propertyText(property) {
  if (!property?.resourceId) return 'افتح أي موقع داخل Google Search Console أولًا';
  return property.label || property.resourceId;
}

function parseProperties(text) {
  return text
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatMetric(metric) {
  if (!metric || typeof metric.current !== 'number' || typeof metric.previous !== 'number') return '';
  const sign = metric.change > 0 ? '+' : '';
  return `${sign}${metric.change.toFixed(2)}% نقرات`;
}

function recordSummary(record) {
  const metric = formatMetric(record.clicks);
  if (record.status === 'skipped') return `${record.label}: تم التخطي${metric ? ` (${metric})` : ''}`;
  if (record.status === 'error') return `${record.label}: ${record.error || 'تعذر إكمال التقرير'}`;
  if (record.status === 'running') return `${record.label}: ${record.detail || 'جارٍ المعالجة…'}`;
  if (record.status === 'completed') {
    const reports = [];
    if (record.performance?.status === 'captured') reports.push('Performance');
    if (record.generativeAi?.status === 'captured') reports.push('Generative AI');
    if (record.generativeAi?.status === 'unavailable') reports.push('Generative AI غير متاح');
    return `${record.label}: ${reports.join(' + ') || 'اكتمل'}${metric ? ` (${metric})` : ''}`;
  }
  return `${record.label}: في الانتظار`;
}

function renderRunState(state) {
  const panel = $('#run-panel');
  const status = state?.status;
  const hasState = Boolean(state && status);
  panel.hidden = !hasState;
  $('#cancel-run').classList.toggle('hidden', status !== 'running');
  $('#start-run').disabled = status === 'running';

  if (!hasState) return;

  const statusLabels = {
    running: 'جارٍ إنشاء التقارير',
    completed: 'اكتمل إنشاء التقارير',
    cancelled: 'تم إيقاف التشغيل',
    failed: 'توقف التشغيل بسبب خطأ'
  };
  $('#run-status').textContent = statusLabels[status] || status;
  const indicator = $('#run-indicator');
  indicator.className = `indicator ${status}`;

  const current = state.records?.find((item) => item.status === 'running');
  $('#run-detail').textContent = current
    ? `${current.label} — ${current.detail || 'جارٍ تحميل تقرير Google Search Console…'}`
    : state.message || '';

  const list = $('#run-records');
  list.replaceChildren();
  (state.records || []).forEach((record) => {
    const li = document.createElement('li');
    li.className = record.status || '';
    li.textContent = recordSummary(record);
    list.appendChild(li);
  });
}

async function refreshState() {
  try {
    const { state } = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
    renderRunState(state);
    if (state?.status === 'running') startPolling();
    else stopPolling();
  } catch (error) {
    console.debug('Unable to read run state', error);
  }
}

function startPolling() {
  if (!pollingTimer) pollingTimer = window.setInterval(refreshState, 1000);
}

function stopPolling() {
  if (pollingTimer) window.clearInterval(pollingTimer);
  pollingTimer = null;
}

async function loadCurrentProperty() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROPERTY' });
    currentProperty = response.property;
    $('#current-property').textContent = propertyText(currentProperty);
  } catch (error) {
    currentProperty = null;
    $('#current-property').textContent = 'تعذر قراءة الموقع المفتوح';
  }
}

async function discoverProperties() {
  const button = $('#discover-properties');
  button.disabled = true;
  setManualStatus('جارٍ قراءة قائمة الخصائص المتاحة…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DISCOVER_PROPERTIES' });
    if (!response.properties?.length) throw new Error('لم يتم العثور على مواقع. اكتب قائمة المواقع يدويًا.');

    $('#properties').value = response.properties.map((property) => property.resourceId).join('\n');
    setManualStatus(`تم استيراد ${response.properties.length} موقع/مواقع.`, 'success');
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

async function startRun() {
  const properties = parseProperties($('#properties').value);
  const button = $('#start-run');
  button.disabled = true;
  setManualStatus('');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_RUN',
      rawProperties: properties,
      options: {
        skipDecliningClicks: $('#skip-declines').checked,
        includeGenerativeAi: $('#include-generative').checked
      }
    });
    if (!response?.started) throw new Error(response?.error || 'تعذر بدء التقرير.');
    renderRunState(response.state);
    startPolling();
  } catch (error) {
    showError(error);
    await refreshState();
  } finally {
    button.disabled = false;
  }
}

async function cancelRun() {
  try {
    await chrome.runtime.sendMessage({ type: 'CANCEL_RUN' });
    await refreshState();
  } catch (error) {
    showError(error);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('لم يتم العثور على تبويب مفتوح.');
  return tab;
}

async function runManualCalculations() {
  const button = $('#run-script');
  button.disabled = true;
  setManualStatus('جارٍ تطبيق حسابات Agital…');
  try {
    const tab = await activeTab();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'AGITAL_RUN_CALCULATIONS',
      reportType: 'performance',
      waitForData: false
    });
    if (!result?.ok) throw new Error(result?.error || 'تعذر تطبيق الحسابات على هذه الصفحة.');
    setManualStatus('Percentage changes were applied successfully.', 'success');
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

async function runAlgorithmUpdates() {
  const button = $('#show-algo-updates');
  button.disabled = true;
  setManualStatus('جارٍ إضافة علامات تحديثات الخوارزمية…');
  const listener = (message) => {
    if (message.type === 'ALG_UPDATE_ERROR') setManualStatus(message.message, 'error');
    if (message.type === 'ALG_UPDATE_SUCCESS') setManualStatus('تمت إضافة علامات تحديثات الخوارزمية.', 'success');
  };
  chrome.runtime.onMessage.addListener(listener);
  try {
    const tab = await activeTab();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['algoupdates.js'] });
  } catch (error) {
    showError(error);
  } finally {
    window.setTimeout(() => chrome.runtime.onMessage.removeListener(listener), 2500);
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#discover-properties').addEventListener('click', discoverProperties);
  $('#start-run').addEventListener('click', startRun);
  $('#cancel-run').addEventListener('click', cancelRun);
  $('#run-script').addEventListener('click', runManualCalculations);
  $('#show-algo-updates').addEventListener('click', runAlgorithmUpdates);

  await Promise.all([loadCurrentProperty(), refreshState()]);
});

window.addEventListener('unload', stopPolling);
