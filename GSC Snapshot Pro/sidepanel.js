const $ = (selector) => document.querySelector(selector);

let pollingTimer = null;
let snapshots = [];
let selectedSnapshotId = null;
let expandedFolders = new Set();
let domReady = false;
let runMode = 'all';

function setRunMessage(message = '', type = 'error') {
  const element = $('#run-message');
  if (!element) return;
  element.textContent = message;
  element.style.color = type === 'success' ? '#6ee7b7' : type === 'info' ? '#93c5fd' : '#fda4af';
}

function parseProperties(text) {
  return text.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

function setRunMode(mode) {
  runMode = mode;
  const selected = mode === 'selected';
  $('#mode-all').classList.toggle('active', !selected);
  $('#mode-selected').classList.toggle('active', selected);
  $('#selected-sites-box').hidden = !selected;
  if (selected) $('#selected-sites').focus();
}

function formatMetric(metric) {
  if (!metric || typeof metric.current !== 'number' || typeof metric.previous !== 'number') return '';
  const sign = metric.change > 0 ? '+' : '';
  return `${sign}${metric.change.toFixed(2)}% نقرات`;
}

function eventTime(timestamp) {
  return new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
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
  const isActive = status === 'running' || status === 'cancelling';
  panel.hidden = !status;
  $('#cancel-run').classList.toggle('hidden', !isActive);
  $('#cancel-run').disabled = status === 'cancelling';
  $('#cancel-run').textContent = status === 'cancelling' ? 'جارٍ الإيقاف…' : 'إيقاف التشغيل';
  $('#start-run').disabled = isActive;

  const events = state?.events || [];
  const activityPanel = $('#activity-panel');
  activityPanel.hidden = events.length === 0;
  $('#activity-count').textContent = String(events.length);
  const activityLog = $('#activity-log');
  activityLog.replaceChildren();
  [...events].reverse().forEach((event) => {
    const item = document.createElement('li');
    item.className = event.type || 'info';
    const text = document.createElement('span');
    text.textContent = event.message;
    const time = document.createElement('time');
    time.textContent = eventTime(event.at);
    item.append(text, time);
    activityLog.appendChild(item);
  });

  if (!status) return;
  const statusLabels = {
    running: 'جارٍ إنشاء التقارير',
    cancelling: 'جارٍ إيقاف التشغيل',
    completed: 'اكتمل إنشاء التقارير',
    cancelled: 'تم إيقاف التشغيل',
    failed: 'توقف التشغيل بسبب خطأ'
  };
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
    if (state?.status === 'running' || state?.status === 'cancelling') startPolling();
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

async function startRun() {
  const button = $('#start-run');
  button.disabled = true;
  setRunMessage('', 'info');
  try {
    const rawProperties = runMode === 'selected' ? parseProperties($('#selected-sites').value) : [];
    if (runMode === 'selected' && !rawProperties.length) {
      throw new Error('أضف رابط موقع واحد على الأقل، أو اختر تشغيل كل المواقع.');
    }
    const response = await chrome.runtime.sendMessage({
      type: 'START_RUN',
      mode: runMode,
      autoDiscover: true,
      rawProperties,
      options: {
        skipDecliningClicks: true,
        includeGenerativeAi: true
      }
    });
    if (!response?.started) throw new Error(response?.error || 'تعذر بدء التقرير.');
    renderRunState(response.state);
    startPolling();
  } catch (error) {
    setRunMessage(error.message);
    await refreshState();
  }
}

async function cancelRun() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CANCEL_RUN' });
    if (response?.error) throw new Error(response.error);
    renderRunState(response?.state || null);
    startPolling();
  } catch (error) {
    setRunMessage(error.message);
  }
}

async function resetRunInterface() {
  const resetButton = $('#reset-run-interface');
  const stateResponse = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
  const isActive = stateResponse?.state?.status === 'running' || stateResponse?.state?.status === 'cancelling';
  const warning = isActive
    ? 'سيتم إيقاف التشغيل الحالي ومسح حالة الواجهة والسجل فقط. الصور المحفوظة لن تُحذف. هل تريد المتابعة؟'
    : 'سيتم مسح حالة التشغيل والسجل من الواجهة فقط. الصور المحفوظة لن تُحذف. هل تريد المتابعة؟';
  if (!window.confirm(warning)) return;

  resetButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESET_RUN_INTERFACE' });
    if (response?.error) throw new Error(response.error);
    stopPolling();
    $('#selected-sites').value = '';
    setRunMode('all');
    renderRunState(null);
    setRunMessage('تمت إعادة ضبط واجهة التشغيل والسجل. مكتبة الصور كما هي.', 'success');
  } catch (error) {
    setRunMessage(error.message);
  } finally {
    resetButton.disabled = false;
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

function snapshotFolderKey(snapshot) {
  return snapshot.resourceId || snapshot.propertyLabel || 'unknown-property';
}

function formatFileDate(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
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

  const folders = new Map();
  snapshots.forEach((snapshot) => {
    const key = snapshotFolderKey(snapshot);
    const folder = folders.get(key) || { key, label: snapshot.propertyLabel, snapshots: [] };
    folder.snapshots.push(snapshot);
    folders.set(key, folder);
  });

  const selectedFolder = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId);
  if (selectedFolder) expandedFolders.add(snapshotFolderKey(selectedFolder));

  [...folders.values()]
    .sort((first, second) => second.snapshots[0].createdAt - first.snapshots[0].createdAt)
    .forEach((folder) => {
      const folderElement = document.createElement('section');
      folderElement.className = 'snapshot-folder';
      const isExpanded = expandedFolders.has(folder.key);

      const header = document.createElement('button');
      header.type = 'button';
      header.className = `folder-header${isExpanded ? ' open' : ''}`;
      header.setAttribute('aria-expanded', String(isExpanded));
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.textContent = isExpanded ? '▾' : '▸';
      const label = document.createElement('strong');
      label.className = 'folder-label';
      label.textContent = folder.label;
      const count = document.createElement('small');
      count.textContent = String(folder.snapshots.length);
      header.append(icon, label, count);
      header.addEventListener('click', () => {
        if (expandedFolders.has(folder.key)) expandedFolders.delete(folder.key);
        else expandedFolders.add(folder.key);
        renderSnapshotList();
      });

      const files = document.createElement('div');
      files.className = 'folder-files';
      files.hidden = !isExpanded;
      folder.snapshots.forEach((snapshot) => {
        const file = document.createElement('button');
        file.type = 'button';
        file.className = `snapshot-file${snapshot.id === selectedSnapshotId ? ' active' : ''}`;
        file.title = reportLabel(snapshot.reportType);
        const fileIcon = document.createElement('span');
        fileIcon.className = `file-icon${snapshot.reportType === 'generative-ai' ? ' ai' : ''}`;
        fileIcon.textContent = '▧';
        const filename = document.createElement('time');
        filename.className = 'file-date';
        filename.textContent = formatFileDate(snapshot.createdAt);
        file.append(fileIcon, filename);
        file.addEventListener('click', () => selectSnapshot(snapshot.id));
        files.appendChild(file);
      });

      folderElement.append(header, files);
      list.appendChild(folderElement);
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
  $('#mode-all').addEventListener('click', () => setRunMode('all'));
  $('#mode-selected').addEventListener('click', () => setRunMode('selected'));
  $('#start-run').addEventListener('click', startRun);
  $('#cancel-run').addEventListener('click', cancelRun);
  $('#reset-run-interface').addEventListener('click', safelyRun(resetRunInterface));
  $('#export-snapshot').addEventListener('click', safelyRun(exportSelectedSnapshot));
  $('#delete-snapshot').addEventListener('click', safelyRun(deleteSelectedSnapshot));
  $('#clear-library').addEventListener('click', safelyRun(clearLibrary));
  await Promise.all([refreshState(), refreshSnapshotSummary()]);
});

window.addEventListener('unload', stopPolling);
