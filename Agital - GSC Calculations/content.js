(() => {
    /*******************************************************
     * 0) Helpers for sending messages to popup.js
     *******************************************************/
    function sendErrorMessage(message) {
        chrome.runtime.sendMessage({
            type: 'PERCENTAGE_CHANGE_ERROR',
            message: message,
        });
    }

    function sendSuccessMessage(message) {
        chrome.runtime.sendMessage({
            type: 'PERCENTAGE_CHANGE_SUCCESS',
            message: message,
        });
    }

    /*******************************************************
     * 1) Date-check helpers
     *******************************************************/
    function parseDate(dateString) {
        const [month, day, year] = dateString.split('/').map(Number);
        const fullYear = year < 100 ? 2000 + year : year;
        return new Date(fullYear, month - 1, day);
    }

    function isValidDate(text) {
        const dateRegex = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{2}|\d{4})$/;
        return dateRegex.test(text);
    }

    function graphHasSingleDateOnXAxis() {
        const graphContainers = document.querySelectorAll('div.rZqBPb');
        if (!graphContainers.length) {
            console.log('No rZqBPb containers found, skipping date check.');
            return false;
        }

        const latestGraphContainer = graphContainers[graphContainers.length - 1];
        const dateGroup = latestGraphContainer.querySelector('g.PvhD9.kqOKYb');
        if (!dateGroup) {
            console.log('No dateGroup found, so no single-date axis detected.');
            return false;
        }

        const dateElements = dateGroup.querySelectorAll('g.K2kob');
        let foundAtLeastOneDate = false;
        dateElements.forEach((element) => {
            const dateTextElement = element.querySelector('text.V67aGc tspan');
            const dateText = dateTextElement?.textContent.trim();
            const transform = element.getAttribute('transform');
            if (dateText && transform && isValidDate(dateText)) {
                foundAtLeastOneDate = true;
            }
        });
        return foundAtLeastOneDate;
    }

    /*******************************************************
     * 2) Percentage change logic
     *******************************************************/
    function parseLocalizedNumber(input) {
        let normalized;
        input = input.replace(/\u00A0/g, ' ');

        if (input.includes(',') && input.includes('.')) {
            if (input.indexOf(',') > input.indexOf('.')) {
                console.log(`Detected European format with both comma and period: ${input}`);
                normalized = input.replace(/\./g, '').replace(/,/g, '.');
            } else {
                console.log(`Detected US format with both comma and period: ${input}`);
                normalized = input.replace(/,/g, '');
            }
        } else if (input.includes(',') && input.includes(' ')) {
            console.log(`Detected European format with space as thousands separator and comma as decimal: ${input}`);
            normalized = input.replace(/\s/g, '').replace(/,/g, '.');
        } else if (input.includes(' ') && !input.includes(',')) {
            console.log(`Detected format with space as thousands separator: ${input}`);
            normalized = input.replace(/\s/g, '');
        } else if (input.includes(',')) {
            const commaIndex = input.lastIndexOf(',');
            if (input.length - commaIndex === 4 && !input.includes('.')) {
                console.log(`Detected US format with comma as thousands separator: ${input}`);
                normalized = input.replace(/,/g, '');
            } else {
                console.log(`Detected European format with comma as decimal separator: ${input}`);
                normalized = input.replace(/,/g, '.');
            }
        } else if (input.includes('.')) {
            const periodIndex = input.lastIndexOf('.');
            if (input.length - periodIndex === 3 || input.length - periodIndex === 2) {
                console.log(`Detected format with period as decimal separator: ${input}`);
                normalized = input;
            } else {
                console.log(`Detected format with period as thousands separator: ${input}`);
                normalized = input.replace(/\./g, '');
            }
        } else {
            console.log(`Detected plain number format: ${input}`);
            normalized = input;
        }
        return parseFloat(normalized);
    }

    function extractData(label) {
        console.log(`Extracting data for ${label}`);
        const elements = Array.from(document.querySelectorAll(`[data-label="${label}"] .nnLLaf`))
            .filter(el => el.offsetParent !== null);
        if (elements.length < 2) {
            console.log(`Not enough data points found for ${label} — skipping calculations.`);
            return { current: 0, previous: 0 };
        }
        const current = parseLocalizedNumber(elements[0].getAttribute('title'));
        const previous = parseLocalizedNumber(elements[1].getAttribute('title'));
        console.log(`${label} - Current: ${current}, Previous: ${previous}`);
        return { current, previous };
    }

    function calculatePercentageChange(previous, current) {
        if (previous === 0) {
            console.log('Previous value is 0, cannot calculate percentage change. Returning 0.');
            return 0;
        }
        return ((current - previous) / previous) * 100;
    }

    function calculateDifference(previous, current) {
        return current - previous;
    }

    function addPercentageChange() {
        console.log('Adding percentage changes...');
        const clicksData = extractData('CLICKS');
        const impressionsData = extractData('IMPRESSIONS');
        const ctrData = extractData('CTR');
        const positionData = extractData('POSITION');

        const percentageChanges = {
            clicks: calculatePercentageChange(clicksData.previous, clicksData.current).toFixed(2),
            impressions: calculatePercentageChange(impressionsData.previous, impressionsData.current).toFixed(2),
            ctr: calculatePercentageChange(ctrData.previous, ctrData.current).toFixed(2),
            position: calculateDifference(positionData.previous, positionData.current).toFixed(2)
        };

        console.log('Percentage Changes:', percentageChanges);

        const metrics = [
            { label: 'CLICKS', change: percentageChanges.clicks, isPercentage: true },
            { label: 'IMPRESSIONS', change: percentageChanges.impressions, isPercentage: true },
            { label: 'CTR', change: percentageChanges.ctr, isPercentage: true },
            { label: 'POSITION', change: percentageChanges.position, isPercentage: false }
        ];

        metrics.forEach(metric => {
            const metricElements = Array.from(document.querySelectorAll(`[data-label="${metric.label}"] .m10vVd`))
                .filter(el => el.offsetParent !== null);
            if (metricElements.length > 1) {
                console.log(`Adding change info for ${metric.label}`);
                const latestMetricElement = metricElements[metricElements.length - 1];
                const percentageElement = document.createElement('div');
                percentageElement.classList.add('percentage-change');
                percentageElement.style.fontSize = '15px';
                percentageElement.style.fontWeight = 'bold';
                percentageElement.style.marginTop = '10px';
                percentageElement.style.color = 'inherit';

                const changeText = document.createElement('span');
                changeText.textContent = 'Change: ';

                const changeValue = document.createElement('span');
                changeValue.textContent = metric.change + (metric.isPercentage ? '%' : '');
                changeValue.style.border = '2px solid';
                changeValue.style.borderColor = (metric.label === 'POSITION')
                    ? (parseFloat(metric.change) < 0 ? 'green' : 'red')
                    : (metric.change.startsWith('-') ? 'red' : 'green');
                changeValue.style.padding = '2px';
                changeValue.style.marginLeft = '5px';

                percentageElement.appendChild(changeText);
                percentageElement.appendChild(changeValue);

                const existingElement = latestMetricElement.querySelector('.percentage-change');
                if (existingElement) {
                    existingElement.remove();
                }
                latestMetricElement.appendChild(percentageElement);
            } else {
                console.log(`Not enough metric elements found for ${metric.label} — skipping that metric's calculation.`);
            }
        });
    }

    function addPercentageChangeToRows() {
        console.log('Adding percentage changes to table rows...');

        const tables = document.querySelectorAll('table.i3WFpf');
        if (tables.length === 0) {
            console.log('No tables found with the class i3WFpf. Skipping row-based changes.');
            return;
        }

        tables.forEach((table, tableIndex) => {
            console.log(`Processing table ${tableIndex + 1} of ${tables.length}`);
            const rows = table.querySelectorAll('tbody tr');
            if (rows.length === 0) {
                console.log(`No rows found in table ${tableIndex + 1}. Skipping...`);
                return;
            }

            rows.forEach((row, rowIndex) => {
                const cells = row.querySelectorAll('td');
                const columnPairs = [
                    { oldIndex: 2, newIndex: 1, diffIndex: 3 },  // Clicks
                    { oldIndex: 5, newIndex: 4, diffIndex: 6 },  // Impressions
                    { oldIndex: 8, newIndex: 7, diffIndex: 9 }   // CTR
                ];

                columnPairs.forEach(({ oldIndex, newIndex, diffIndex }) => {
                    const oldValueCell = cells[oldIndex];
                    const newValueCell = cells[newIndex];
                    const differenceCell = cells[diffIndex];

                    if (oldValueCell && newValueCell && differenceCell) {
                        const oldValueAttr = oldValueCell.getAttribute('data-numeric-value');
                        const newValueAttr = newValueCell.getAttribute('data-numeric-value');

                        if (oldValueAttr === null || newValueAttr === null) {
                            console.log(`Row ${rowIndex + 1}: Missing data-numeric-value. Skipping this row for ${oldIndex}, ${newIndex}, ${diffIndex}.`);
                            return;
                        }

                        const oldValue = parseFloat(oldValueAttr);
                        const newValue = parseFloat(newValueAttr);

                        if (isNaN(oldValue) || isNaN(newValue)) {
                            console.log(`Row ${rowIndex + 1}: Invalid numeric values. Skipping...`);
                            return;
                        }

                        const percentageChange = calculatePercentageChange(oldValue, newValue).toFixed(2);

                        const existingPercentageDiv = differenceCell.querySelector('.percentage-change');
                        if (existingPercentageDiv) {
                            existingPercentageDiv.remove();
                        }

                        const percentageDiv = document.createElement('div');
                        percentageDiv.textContent = `(${percentageChange}%)`;
                        percentageDiv.classList.add('percentage-change');

                        percentageDiv.style.border = '1px solid';
                        percentageDiv.style.padding = '2px 4px';
                        percentageDiv.style.marginTop = '5px';
                        percentageDiv.style.borderRadius = '3px';

                        const differenceSpan = differenceCell.querySelector('span');
                        percentageDiv.style.color = differenceSpan ? differenceSpan.style.color : 'inherit';

                        if (parseFloat(percentageChange) > 0) {
                            percentageDiv.style.borderColor = 'green';
                        } else {
                            percentageDiv.style.borderColor = 'red';
                        }

                        if (differenceSpan) {
                            differenceSpan.appendChild(percentageDiv);
                        } else {
                            differenceCell.appendChild(percentageDiv);
                        }
                    } else {
                        console.log(
                            `Row ${rowIndex + 1}: Missing cells for indices ${oldIndex}, ${newIndex}, ${diffIndex}. Skipping this chunk.`
                        );
                    }
                });
            });

            console.log(`Finished row-based changes for table ${tableIndex + 1}.`);
        });
    }

    /*******************************************************
     * Remove the observer logic; we only rely on checkForChanges()
     *******************************************************/
    function checkForChanges() {
        console.log('Checking for changes...');

        if (graphHasSingleDateOnXAxis()) {
            console.log('Date-based view detected. Skipping percentage changes...');
            sendErrorMessage('Percentage Change Can Only Be Applied in Comparison Views');
            return;
        }
        addPercentageChange();
        addPercentageChangeToRows();

        sendSuccessMessage('Percentage changes were applied successfully.');
    }

    // Initialize the script
    function init() {
        console.log('Initializing script...');
        // We just call checkForChanges once
        checkForChanges();
    }

    // Optional: if you have a refresh button, you can still attach it
    const refreshButton = document.getElementById('refresh-stats');
    if (refreshButton) {
        refreshButton.addEventListener('click', checkForChanges);
    }

    init();
})();