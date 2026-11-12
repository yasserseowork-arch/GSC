(() => {
  // This file is injected both by the manual calculator and by the auto reporter.
  // Guarding it prevents duplicate listeners when a user clicks the manual button twice.
  if (window.__gscSnapshotReporterLoaded) return;
  window.__gscSnapshotReporterLoaded = true;

  const REPORT_DATA_TIMEOUT_MS = 90000;
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

  async function waitForComparisonData(reportType, timeout = REPORT_DATA_TIMEOUT_MS) {
    const startedAt = Date.now();
    let previousSignature = null;
    let stableReads = 0;

    while (Date.now() - startedAt < timeout) {
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
        error: 'لم تصل بيانات المقارنة خلال 90 ثانية. تأكد أن تقرير Last 7 days مقابل Previous period متاح لهذا الموقع ثم أعد المحاولة.'
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

  async function prepareCapture({ reportType = 'performance' } = {}) {
    const root = findReportRoot(reportType);
    if (!root) return { ok: false, error: 'The Search Console report card was not found.' };

    root.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
    // Give charts and web fonts a moment to repaint after scrolling before Chrome captures the tab.
    await sleep(1000);
    const rect = root.getBoundingClientRect();
    const padding = 10;
    const left = Math.max(0, rect.left - padding);
    const top = Math.max(0, rect.top - padding);
    const width = Math.min(window.innerWidth - left, rect.width + padding * 2);
    const height = Math.min(window.innerHeight - top - padding, rect.height + padding * 2);
    if (width < 50 || height < 50) return { ok: false, error: 'The report card is outside the visible area.' };

    return {
      ok: true,
      crop: {
        x: left,
        y: top,
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
