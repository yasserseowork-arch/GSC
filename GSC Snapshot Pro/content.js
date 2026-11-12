(() => {
  // This file is injected by the automated report runner on each Search Console report.
  // Guarding it prevents duplicate message listeners if the report is retried.
  if (window.__gscSnapshotReporterLoaded) return;
  window.__gscSnapshotReporterLoaded = true;

  const PERFORMANCE_DATA_TIMEOUT_MS = 40000;
  const GENERATIVE_AI_DATA_TIMEOUT_MS = 25000;
  const DATA_POLL_INTERVAL_MS = 750;
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const isVisible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');

  function parseLocalizedNumber(value) {
    if (value === null || value === undefined) return Number.NaN;
    let text = String(value).trim()
      .replace(/[\u00A0\u202F]/g, ' ')
      .replace(/[٠-٩]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
      .replace(/[۰-۹]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
      .replace(/[%٪]/g, '')
      .replace(/−/g, '-');

    const suffixMatch = text.match(/\s*([KMB])$/i);
    const multiplier = suffixMatch
      ? ({ K: 1e3, M: 1e6, B: 1e9 }[suffixMatch[1].toUpperCase()])
      : 1;
    text = text.replace(/\s*[KMB]$/i, '').replace(/\s/g, '');

    if (text.includes(',') && text.includes('.')) {
      // The separator appearing last is almost always the decimal separator.
      text = text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
    } else if (text.includes(',')) {
      const pieces = text.split(',');
      text = pieces.length > 2 || (pieces[1]?.length === 3 && pieces[0].length <= 3)
        ? text.replace(/,/g, '')
        : text.replace(',', '.');
    }

    const result = Number.parseFloat(text);
    return Number.isFinite(result) ? result * multiplier : Number.NaN;
  }

  function metricValueNodes(label) {
    const selector = `[data-label="${label}"] .nnLLaf`;
    return [...document.querySelectorAll(selector)].filter(isVisible);
  }

  function rawMetricValue(node) {
    return node.getAttribute('title')
      || node.getAttribute('data-numeric-value')
      || node.textContent?.trim()
      || '';
  }

  function getMetric(label) {
    const nodes = metricValueNodes(label);
    const values = nodes
      .map((node) => parseLocalizedNumber(rawMetricValue(node)))
      .filter((value) => Number.isFinite(value));

    if (values.length < 2) return null;
    // Search Console renders the selected period first, followed by the previous period.
    const [current, previous] = values;
    return {
      current,
      previous,
      change: previous === 0 ? null : ((current - previous) / previous) * 100,
      difference: current - previous
    };
  }

  function hasComparisonData(reportType) {
    const required = reportType === 'generative-ai' ? 'IMPRESSIONS' : 'CLICKS';
    return Boolean(getMetric(required));
  }

  function comparisonSignature(reportType) {
    const required = reportType === 'generative-ai' ? 'IMPRESSIONS' : 'CLICKS';
    const metric = getMetric(required);
    return metric ? `${metric.current}:${metric.previous}` : null;
  }

  function blockingReportMessage() {
    const text = (document.body?.innerText || '').toLowerCase();
    const blocked = [
      /you don't have access/,
      /you do not have access/,
      /not eligible/,
      /not available for this property/,
      /no data available/,
      /something went wrong/,
      /ليس لديك صلاحية/,
      /لا تتوفر بيانات/,
      /حدث خطأ/
    ];
    return blocked.some((pattern) => pattern.test(text));
  }

  async function waitForComparisonData(reportType) {
    const timeout = reportType === 'generative-ai'
      ? GENERATIVE_AI_DATA_TIMEOUT_MS
      : PERFORMANCE_DATA_TIMEOUT_MS;
    const startedAt = Date.now();
    let previousSignature = null;
    let stableReads = 0;

    while (Date.now() - startedAt < timeout) {
      if (blockingReportMessage()) {
        throw new Error('هذا التقرير غير متاح أو لا توجد بيانات قابلة للمقارنة لهذا الـ Property.');
      }
      const signature = comparisonSignature(reportType);
      if (signature) {
        // A second identical read prevents taking a screenshot while GSC is replacing
        // the old property card during a single-page-app navigation.
        stableReads = signature === previousSignature ? stableReads + 1 : 0;
        previousSignature = signature;
        if (stableReads >= 1) return true;
      }
      await sleep(DATA_POLL_INTERVAL_MS);
    }
    return false;
  }

  function metricLabelText(metric) {
    if (metric.kind === 'position') return metric.data.difference.toFixed(2);
    if (metric.data.change === null) return '—';
    return `${metric.data.change.toFixed(2)}%`;
  }

  function metricIsPositive(metric) {
    if (metric.kind === 'position') return metric.data.difference < 0;
    return metric.data.change !== null && metric.data.change >= 0;
  }

  function addMetricChange(label, kind = 'percentage') {
    const data = getMetric(label);
    if (!data) return null;

    const cards = [...document.querySelectorAll(`[data-label="${label}"]`)].filter(isVisible);
    const card = cards[cards.length - 1];
    if (!card) return data;

    card.querySelectorAll(`.gsc-snapshot-percentage-change[data-gsc-snapshot-label="${label}"]`).forEach((element) => element.remove());
    const metric = { data, kind };
    const percentageElement = document.createElement('div');
    percentageElement.className = 'gsc-snapshot-percentage-change';
    percentageElement.dataset.gscSnapshotLabel = label;
    percentageElement.style.cssText = 'font-size:15px;font-weight:bold;margin-top:10px;color:inherit;line-height:1.25;';

    const prefix = document.createElement('span');
    prefix.textContent = 'Change: ';
    const value = document.createElement('span');
    value.textContent = metricLabelText(metric);
    value.style.cssText = `border:2px solid ${metricIsPositive(metric) ? 'green' : 'red'};padding:2px;margin-inline-start:5px;`;
    percentageElement.append(prefix, value);

    const mount = card.querySelector('.m10vVd') || card.querySelector('.nnLLaf')?.parentElement || card;
    mount.appendChild(percentageElement);
    return data;
  }

  function addRowPercentageChanges() {
    document.querySelectorAll('table.i3WFpf').forEach((table) => {
      table.querySelectorAll('tbody tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        const columnPairs = [
          { previous: 2, current: 1, target: 3 },
          { previous: 5, current: 4, target: 6 },
          { previous: 8, current: 7, target: 9 }
        ];

        columnPairs.forEach(({ previous, current, target }) => {
          const previousValue = Number.parseFloat(cells[previous]?.getAttribute('data-numeric-value'));
          const currentValue = Number.parseFloat(cells[current]?.getAttribute('data-numeric-value'));
          const targetCell = cells[target];
          if (!targetCell || !Number.isFinite(previousValue) || !Number.isFinite(currentValue)) return;

          targetCell.querySelectorAll('.gsc-snapshot-row-percentage-change').forEach((element) => element.remove());
          const percentage = previousValue === 0 ? null : ((currentValue - previousValue) / previousValue) * 100;
          const badge = document.createElement('div');
          badge.className = 'gsc-snapshot-row-percentage-change';
          badge.textContent = `(${percentage === null ? '—' : `${percentage.toFixed(2)}%`})`;
          badge.style.cssText = `display:inline-block;border:1px solid ${percentage !== null && percentage >= 0 ? 'green' : 'red'};padding:2px 4px;margin-top:5px;border-radius:3px;`;
          targetCell.appendChild(badge);
        });
      });
    });
  }

  function collectMetrics() {
    const clicks = getMetric('CLICKS');
    const impressions = getMetric('IMPRESSIONS');
    const ctr = getMetric('CTR');
    const position = getMetric('POSITION');
    return { clicks, impressions, ctr, position };
  }

  async function runCalculations({ reportType = 'performance', waitForData = false } = {}) {
    const available = waitForData ? await waitForComparisonData(reportType) : hasComparisonData(reportType);
    if (!available) {
      return {
        ok: false,
        error: 'لم تصل بيانات المقارنة في الوقت المتوقع. تم تخطي هذا التقرير بدلًا من إبقاء التشغيل عالقًا.'
      };
    }

    const metrics = collectMetrics();
    addMetricChange('CLICKS');
    addMetricChange('IMPRESSIONS');
    addMetricChange('CTR');
    addMetricChange('POSITION', 'position');
    addRowPercentageChanges();
    return { ok: true, metrics };
  }

  function findReportRoot(reportType) {
    const labels = reportType === 'generative-ai' ? ['IMPRESSIONS'] : ['CLICKS', 'IMPRESSIONS'];
    const roots = [...document.querySelectorAll('div.rZqBPb')].filter((root) => {
      if (!isVisible(root) || !root.querySelector('svg')) return false;
      return labels.some((label) => root.querySelector(`[data-label="${label}"]`));
    });
    if (roots.length) return roots[roots.length - 1];

    const anchor = labels
      .map((label) => [...document.querySelectorAll(`[data-label="${label}"]`)].find(isVisible))
      .find(Boolean);
    if (!anchor) return null;

    let candidate = anchor;
    for (let index = 0; candidate?.parentElement && index < 8; index += 1) {
      candidate = candidate.parentElement;
      const rect = candidate.getBoundingClientRect();
      if (candidate.querySelector('svg') && rect.width > 450 && rect.height > 250) return candidate;
    }
    return anchor.parentElement;
  }

  function reportCaptureBounds(reportRoot) {
    const metricRects = [...reportRoot.querySelectorAll('[data-label]')]
      .filter(isVisible)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 50 && rect.height > 35);
    const chartRects = [...reportRoot.querySelectorAll('svg')]
      .filter(isVisible)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 260 && rect.height > 100)
      .sort((first, second) => second.width * second.height - first.width * first.height);
    const rects = [...metricRects, ...(chartRects.length ? [chartRects[0]] : [])];
    if (!rects.length) return null;

    // Capture only the metric cards and their comparison chart. This deliberately
    // excludes the browser frame, left navigation, filters, tables, and side panel.
    const padding = 12;
    const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - padding);
    const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - padding);
    const right = Math.min(window.innerWidth, Math.max(...rects.map((rect) => rect.right)) + padding);
    const bottom = Math.min(window.innerHeight, Math.max(...rects.map((rect) => rect.bottom)) + padding);
    return { left, top, right, bottom };
  }

  async function prepareCapture({ reportType = 'performance' } = {}) {
    const reportRoot = findReportRoot(reportType);
    if (!reportRoot) return { ok: false, error: 'The Search Console report card was not found.' };

    reportRoot.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
    // Give charts and web fonts a moment to repaint after scrolling before Chrome captures the tab.
    await sleep(700);
    const bounds = reportCaptureBounds(reportRoot);
    if (!bounds) return { ok: false, error: 'The Search Console report area was not found.' };

    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width < 50 || height < 50) return { ok: false, error: 'The report card is outside the visible area.' };

    return {
      ok: true,
      crop: {
        x: bounds.left,
        y: bounds.top,
        pageX: bounds.left + window.scrollX,
        pageY: bounds.top + window.scrollY,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GSC_SNAPSHOT_RUN_CALCULATIONS') {
      runCalculations(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'GSC_SNAPSHOT_PREPARE_CAPTURE') {
      prepareCapture(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return undefined;
  });
})();
