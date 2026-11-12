const $ = (selector) => document.querySelector(selector);

let pollingTimer = null;
let snapshots = [];
let selectedSnapshotId = null;
let domReady = false;

function setRunMessage(message = '', type = 'error') {
  const element = $('#run-message');
  if (!element) return;
  element.textContent = message;
  element.style.color = type === 'success' ? '#6ee7b7' : type === 'info' ? '#93c5fd' : '#fda4af';
}

function propertyText(property) {
  return property?.resourceId ? (property.label || property.resourceId) : 'افتح أي موقع داخل Google Search Console أولًا';
}

function parseProperties(text) {
  return text.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
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
  panel.hidden = !status;
  $('#cancel-run').classList.toggle('hidden', status !== 'running');
  $('#start-run').disabled = status === 'running';
  if (!status) return;

  const statusLabels = { running: 'جارٍ إنشاء التقارير', completed: 'اكتمل إنشاء التقارير', cancelled: 'تم إيقاف التشغيل', failed: 'توقف التشغيل بسبب خطأ' };
  $('#run-status').textContent = statusLabels[status] || status;
  $('#run-indicator').className = `indicator ${status}`;
  const current = state.records?.find((item) => item.status === 'running');
  $('#run-detail').textContent = current ? `${current.label} — ${current.detail || 'جارٍ تحميل تقرير Google Search Console…'}` : state.message || '';

  const list = $('#run-records');
  list.replaceChildren();
  (state.records || []).forEach((record) => {
    const item = document.createElement('li');
    item.className = record.status || '';
    item.textContent = recordSummary(record);
    list.appendChild(item);
  });
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
    if (response?.error) throw new Error(response.error);
    const state = response?.state;
    renderRunState(state);
    if (state?.status === 'running') startPolling();
    else {
      stopPolling();
      refreshSnapshotSummary();
    }
  } catch (error) {
    setRunMessage(error.message);
  }
}

function startPolling() {
  if (!pollingTimer) pollingTimer = window.setInterval(refreshState, 1000);
}

function stopPolling() {
  if (pollingTimer) window.clearInterval(pollingTimer);
  pollingTimer = null;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('لم يتم العثور على تبويب نشط.');
  return tab;
}

async function loadCurrentProperty() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_PROPERTY' });
    if (response?.error) throw new Error(response.error);
    $('#current-property').textContent = propertyText(response?.property);
  } catch (error) {
    $('#current-property').textContent = 'تعذر قراءة الموقع المفتوح';
    setRunMessage(error.message);
  }
}

async function discoverProperties() {
  const button = $('#discover-properties');
  button.disabled = true;
  setRunMessage('جارٍ فتح قائمة الخصائص وجمع المواقع من الحساب…', 'info');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DISCOVER_PROPERTIES' });
    if (response?.error) throw new Error(response.error);
    if (!response?.properties?.length) throw new Error('لم يتم العثور على Properties. أضف قائمة المواقع يدويًا.');
    $('#properties').value = response.properties.map((property) => property.resourceId).join('\n');
    setRunMessage(`تم استيراد ${response.properties.length} Property من الحساب.`, 'success');
  } catch (error) {
    setRunMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

async function startRun() {
  const button = $('#start-run');
  button.disabled = true;
  setRunMessage('', 'info');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_RUN',
      rawProperties: parseProperties($('#properties').value),
      options: {
        skipDecliningClicks: $('#skip-declines').checked,
        includeGenerativeAi: $('#include-generative').checked
      }
    });
    if (!response?.started) throw new Error(response?.error || 'تعذر بدء التقرير.');
    renderRunState(response.state);
    startPolling();
  } catch (error) {
    setRunMessage(error.message);
    await refreshState();
  } finally {
    button.disabled = false;
  }
}

async function cancelRun() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CANCEL_RUN' });
    if (response?.error) throw new Error(response.error);
    await refreshState();
  } catch (error) {
    setRunMessage(error.message);
  }
}

function reportLabel(reportType) {
  return reportType === 'generative-ai' ? 'GENERATIVE AI' : 'PERFORMANCE';
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function clickChange(metrics) {
  const clicks = metrics?.clicks;
  return clicks && typeof clicks.change === 'number' ? clicks.change : null;
}

function renderSnapshotList() {
  const list = $('#snapshot-list');
  $('#library-count').textContent = String(snapshots.length);
  $('#snapshot-count').textContent = String(snapshots.length);
  $('#clear-library').disabled = snapshots.length === 0;
  list.replaceChildren();
  if (!snapshots.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = 'لم يتم حفظ أي صور بعد. ابدأ تقريرًا من تبويب التشغيل.';
    list.appendChild(empty);
    return;
  }

  snapshots.forEach((snapshot) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `snapshot-row ${snapshot.reportType === 'generative-ai' ? 'ai' : ''}${snapshot.id === selectedSnapshotId ? ' active' : ''}`;
    const type = document.createElement('span');
    type.className = 'row-type';
    type.textContent = reportLabel(snapshot.reportType);
    const property = document.createElement('strong');
    property.className = 'row-property';
    property.textContent = snapshot.propertyLabel;
    const date = document.createElement('time');
    date.className = 'row-date';
    date.textContent = formatDate(snapshot.createdAt);
    row.append(type, property, date);
    row.addEventListener('click', () => selectSnapshot(snapshot.id));
    list.appendChild(row);
  });
}

function resetPreview() {
  selectedSnapshotId = null;
  $('#snapshot-preview').hidden = true;
  $('#empty-preview').hidden = false;
  renderSnapshotList();
}

async function selectSnapshot(snapshotId) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT', snapshotId });
    if (response?.error) throw new Error(response.error);
    const snapshot = response?.snapshot;
    if (!snapshot?.imageData) throw new Error('لم تعد الصورة موجودة في المكتبة.');
    selectedSnapshotId = snapshot.id;
    $('#preview-image').src = snapshot.imageData;
    $('#preview-image').alt = `${reportLabel(snapshot.reportType)} — ${snapshot.propertyLabel}`;
    const type = $('#preview-type');
    type.textContent = reportLabel(snapshot.reportType);
    type.className = `type-badge ${snapshot.reportType === 'generative-ai' ? 'ai' : ''}`;
    $('#preview-property').textContent = snapshot.propertyLabel;
    $('#preview-date').textContent = formatDate(snapshot.createdAt);
    const metric = $('#preview-change');
    const change = clickChange(snapshot.metrics);
    metric.hidden = change === null;
    if (change !== null) {
      metric.className = `metric-chip${change < 0 ? ' negative' : ''}`;
      metric.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}% Clicks`;
    }
    $('#empty-preview').hidden = true;
    $('#snapshot-preview').hidden = false;
    renderSnapshotList();
  } catch (error) {
    console.error(error);
    resetPreview();
  }
}

async function loadSnapshots({ retainSelection = true } = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'LIST_SNAPSHOTS' });
  if (response?.error) throw new Error(response.error);
  snapshots = response?.snapshots || [];
  if (!snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) selectedSnapshotId = null;
  renderSnapshotList();
  if (retainSelection && selectedSnapshotId) await selectSnapshot(selectedSnapshotId);
  else if (snapshots.length) await selectSnapshot(snapshots[0].id);
  else resetPreview();
}

async function refreshSnapshotSummary() {
  try {
    const summary = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT_SUMMARY' });
    if (summary?.error) throw new Error(summary.error);
    $('#library-count').textContent = String(summary?.count || 0);
    $('#snapshot-count').textContent = String(summary?.count || 0);
  } catch (error) {
    console.debug('Unable to read snapshot summary', error);
  }
}

async function exportSelectedSnapshot() {
  if (!selectedSnapshotId) return;
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_SNAPSHOT', snapshotId: selectedSnapshotId });
  if (response?.error) throw new Error(response.error);
}

async function deleteSelectedSnapshot() {
  if (!selectedSnapshotId) return;
  const snapshot = snapshots.find((item) => item.id === selectedSnapshotId);
  if (snapshot && !window.confirm(`حذف لقطة ${snapshot.propertyLabel} من مكتبة الإكستنشن؟`)) return;
  const response = await chrome.runtime.sendMessage({ type: 'DELETE_SNAPSHOT', snapshotId: selectedSnapshotId });
  if (response?.error) throw new Error(response.error);
  selectedSnapshotId = null;
  await loadSnapshots({ retainSelection: false });
}

async function clearLibrary() {
  if (!snapshots.length) return;
  if (!window.confirm(`سيتم حذف ${snapshots.length} لقطة محفوظة داخل الإكستنشن. هل تريد المتابعة؟`)) return;
  const response = await chrome.runtime.sendMessage({ type: 'CLEAR_SNAPSHOTS' });
  if (response?.error) throw new Error(response.error);
  selectedSnapshotId = null;
  await loadSnapshots({ retainSelection: false });
}

function switchView(view) {
  const showLibrary = view === 'library';
  $('#run-view').hidden = showLibrary;
  $('#library-view').hidden = !showLibrary;
  $('#tab-run').classList.toggle('active', !showLibrary);
  $('#tab-library').classList.toggle('active', showLibrary);
  if (showLibrary) loadSnapshots().catch((error) => console.error(error));
}

function safelyRun(task) {
  return () => task().catch((error) => setRunMessage(error.message));
}

chrome.runtime.onMessage.addListener((message) => {
  if (!domReady || message?.type !== 'SNAPSHOT_LIBRARY_UPDATED') return;
  refreshSnapshotSummary();
  if (!$('#library-view').hidden) loadSnapshots().catch((error) => console.error(error));
});

document.addEventListener('DOMContentLoaded', async () => {
  domReady = true;
  $('#tab-run').addEventListener('click', () => switchView('run'));
  $('#tab-library').addEventListener('click', () => switchView('library'));
  $('#discover-properties').addEventListener('click', discoverProperties);
  $('#start-run').addEventListener('click', startRun);
  $('#cancel-run').addEventListener('click', cancelRun);
  $('#export-snapshot').addEventListener('click', safelyRun(exportSelectedSnapshot));
  $('#delete-snapshot').addEventListener('click', safelyRun(deleteSelectedSnapshot));
  $('#clear-library').addEventListener('click', safelyRun(clearLibrary));
  await Promise.all([loadCurrentProperty(), refreshState(), refreshSnapshotSummary()]);
});

window.addEventListener('unload', stopPolling);
