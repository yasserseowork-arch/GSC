const $ = (selector) => document.querySelector(selector);

let snapshots = [];
let selectedSnapshotId = null;

function reportLabel(reportType) {
  return reportType === 'generative-ai' ? 'GENERATIVE AI' : 'PERFORMANCE';
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('ar-EG', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

function clickChange(metrics) {
  const clicks = metrics?.clicks;
  if (!clicks || typeof clicks.change !== 'number') return null;
  return clicks.change;
}

function renderList() {
  const list = $('#snapshot-list');
  $('#snapshot-count').textContent = String(snapshots.length);
  $('#clear-library').disabled = snapshots.length === 0;
  list.replaceChildren();

  if (!snapshots.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = 'لم يتم حفظ أي صور بعد. ابدأ تقريرًا من نافذة الإكستنشن.';
    list.appendChild(empty);
    return;
  }

  snapshots.forEach((snapshot) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `snapshot-row ${snapshot.reportType === 'generative-ai' ? 'ai' : ''}${snapshot.id === selectedSnapshotId ? ' active' : ''}`;
    row.dataset.snapshotId = snapshot.id;

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
  renderList();
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
    if (change === null) {
      metric.hidden = true;
    } else {
      metric.hidden = false;
      metric.className = `metric-chip${change < 0 ? ' negative' : ''}`;
      metric.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}% Clicks`;
    }

    $('#empty-preview').hidden = true;
    $('#snapshot-preview').hidden = false;
    renderList();
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
  renderList();

  if (retainSelection && selectedSnapshotId) await selectSnapshot(selectedSnapshotId);
  else if (snapshots.length) await selectSnapshot(snapshots[0].id);
  else resetPreview();
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

function safelyRun(task) {
  return () => task().catch((error) => console.error(error));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SNAPSHOT_LIBRARY_UPDATED') {
    loadSnapshots().catch((error) => console.error(error));
  }
});

document.addEventListener('DOMContentLoaded', () => {
  $('#export-snapshot').addEventListener('click', safelyRun(exportSelectedSnapshot));
  $('#delete-snapshot').addEventListener('click', safelyRun(deleteSelectedSnapshot));
  $('#clear-library').addEventListener('click', safelyRun(clearLibrary));
  loadSnapshots({ retainSelection: false }).catch((error) => console.error(error));
});
