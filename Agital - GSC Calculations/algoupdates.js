(() => {
  const updateData = [
    { date: '06/30/25', type: 'core' },
    { date: '03/13/25', type: 'core' },
    { date: '12/19/24', type: 'spam' },
    { date: '12/12/24', type: 'core' },
    { date: '11/11/24', type: 'core' },
    { date: '08/15/24', type: 'core' },
    { date: '06/20/24', type: 'spam' },
    { date: '03/05/24', type: 'spam' },
    { date: '03/05/24', type: 'core' },
    { date: '11/08/23', type: 'review' },
    { date: '11/02/23', type: 'core' },
    { date: '10/05/23', type: 'core' },
    { date: '10/04/23', type: 'spam' },
    { date: '09/14/23', type: 'HCU' },
    { date: '08/22/23', type: 'core' },
  ];

  // Function to parse a date string in 'MM/DD/YY' or 'MM/DD/YYYY' format
  function parseDate(dateString) {
    const [month, day, year] = dateString.split('/').map(Number);
    return new Date(year + (year < 100 ? 2000 : 0), month - 1, day);
  }

  // Function to validate if a string matches a date format
  function isValidDate(text) {
    // Regex to match MM/DD/YY or MM/DD/YYYY
    const dateRegex = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{2}|\d{4})$/;
    return dateRegex.test(text);
  }

  // Function to send an error message to the extension
  function sendErrorMessage(message) {
    chrome.runtime.sendMessage({
      type: 'ALG_UPDATE_ERROR',
      message: message,
    });
  }

  // Function to send a success message to the extension
  function sendSuccessMessage() {
    chrome.runtime.sendMessage({
      type: 'ALG_UPDATE_SUCCESS',
    });
  }

  // Function to apply algorithm updates
  function applyAlgorithmUpdates() {
    console.log('Applying algorithm updates...');

    // Find all 'rZqBPb' divs and select the latest one
    const graphContainers = document.querySelectorAll('div.rZqBPb');
    const latestGraphContainer = graphContainers[graphContainers.length - 1];

    if (!latestGraphContainer) {
      console.log('No graph container found. Cannot apply algorithm updates.');
      sendErrorMessage(
        "Algorithm update dates can't be applied to a comparison graph as dates aren't included in the GSC graph. Please select a Time Graph to see algorithm update dates."
      );
      return;
    }

    // Within latestGraphContainer, find the graph elements
    const dateGroup = latestGraphContainer.querySelector('g.PvhD9.kqOKYb');
    const svgGroup = latestGraphContainer.querySelector('g.SFDJge');

    if (!dateGroup || !svgGroup) {
      console.log('No visible graph elements found in the latest container.');
      sendErrorMessage(
        "Algorithm update dates can't be applied to a comparison graph as dates aren't included in the GSC graph. Please select a Time Graph to see algorithm update dates."
      );
      return;
    }

    // Extract date labels and validate them
    const dateElements = dateGroup.querySelectorAll('g.K2kob');
    let firstDate = null;
    let firstX = null;

    dateElements.forEach((element) => {
      const dateTextElement = element.querySelector('text.V67aGc tspan');
      const dateText = dateTextElement?.textContent.trim();
      const transform = element.getAttribute('transform');
      const xMatch = transform?.match(/translate\(([\d.]+),/);

      if (dateText && xMatch && isValidDate(dateText)) {
        const xPos = parseFloat(xMatch[1]);
        const parsedDate = parseDate(dateText);

        if (!firstDate || parsedDate < firstDate) {
          firstDate = parsedDate;
          firstX = xPos;
        }
      }
    });

    if (!firstDate || firstX === null) {
      console.log('No valid date labels found in the latest container.');
      sendErrorMessage(
        "Algorithm update dates can't be applied to a comparison graph as dates aren't included in the GSC graph. Please select a Time Graph to see algorithm update dates."
      );
      return;
    }

    // Find the path element containing the data points
    const pathElement = svgGroup.querySelector('path.RWgCYc-bdKbFb');

    if (!pathElement) {
      console.log('Data path not found in the latest container.');
      sendErrorMessage(
        "Algorithm update dates can't be applied to a comparison graph as dates aren't included in the GSC graph. Please select a Time Graph to see algorithm update dates."
      );
      return;
    }

    // Extract the 'd' attribute from the path, which contains the data points
    const pathData = pathElement.getAttribute('d');

    // Parse the path data to extract x-values (dates)
    const xValues = [];
    const pathCommands = pathData.match(/[ML]([\d.]+),([\d.]+)/g);

    if (pathCommands) {
      pathCommands.forEach((command) => {
        const [xStr, yStr] = command.slice(1).split(',');
        const xValue = parseFloat(xStr);
        xValues.push(xValue);
      });
    } else {
      console.log('No data points found in path.');
      sendErrorMessage(
        "Algorithm update dates can't be applied to a comparison graph as dates aren't included in the GSC graph. Please select a Time Graph to see algorithm update dates."
      );
      return;
    }

    // Number of data points
    const numberOfDataPoints = xValues.length;

    // Build the date map
    const dateMap = new Map();
    for (let i = 0; i < xValues.length; i++) {
      const xPos = xValues[i];
      const thisDate = new Date(firstDate.getTime() + i * 24 * 60 * 60 * 1000);
      dateMap.set(thisDate.getTime(), xPos);
    }

    const lastDate = new Date(
      firstDate.getTime() + (numberOfDataPoints - 1) * 24 * 60 * 60 * 1000
    );
    const lastX = xValues[xValues.length - 1];

    const totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
    const pixelsPerDay = (lastX - firstX) / totalDays;

    // Remove existing algorithm update lines in the latest container
    svgGroup.querySelectorAll('.algo-update-line').forEach((line) => line.remove());

    // Add new algorithm update lines based on updateData
    updateData.forEach((update) => {
      const updateDate = parseDate(update.date);

      // Only add lines for updates within the visible date range
      if (updateDate >= firstDate && updateDate <= lastDate) {
        const daysSinceFirstDate = (updateDate - firstDate) / (1000 * 60 * 60 * 24);
        const targetX = firstX + daysSinceFirstDate * pixelsPerDay;

        if (!isNaN(targetX)) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', targetX);
          line.setAttribute('y1', 0);
          line.setAttribute('x2', targetX);
          line.setAttribute('y2', 250);

          let color;
          switch (update.type) {
            case 'core':
              color = 'purple';
              break;
            case 'spam':
              color = 'red';
              break;
            case 'review':
              color = 'green';
              break;
            case 'HCU':
              color = 'magenta';
              break;
            default:
              color = 'black';
          }
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '1');
          line.setAttribute('class', 'algo-update-line');

          svgGroup.appendChild(line);
          console.log(`Added line for ${update.date} (${update.type})`);
        }
      } else {
        console.log(
          `Update ${update.date} (${update.type}) is outside the date range of the graph.`
        );
      }
    });

    // Instead of querying the entire document, let's look for .AaD0rc in the latest container
    const containerElement = latestGraphContainer.querySelector('.AaD0rc');

    // Now pass this container to addUpdateScorecard
    addUpdateScorecard(containerElement);

    // Send a success message after applying updates
    sendSuccessMessage();
  }

  // Accept the containerElement from the latest container
  function addUpdateScorecard(containerElement) {
    // **Step 1: Identify the stable parent container in the LATEST container
    if (!containerElement) {
      console.log('No .AaD0rc found inside the latest container.');
      sendErrorMessage(
        "Algorithm update dates can't be applied because there's no .AaD0rc to append the scorecard."
      );
      return;
    }

    // **Step 2: Remove Existing "Updates" Scorecard if Present**
    const existingLegend = containerElement.querySelector('[data-label="UPDATES"]');
    if (existingLegend) {
      existingLegend.remove();
      console.log('Existing "Updates" scorecard removed.');
    }

    // **Step 3: Create the New "Updates" Scorecard Element**
    const scorecard = document.createElement('div');
    scorecard.setAttribute('data-guidedhelpid', 'scorecard_4');
    scorecard.className = 'PCt8xf PK30O ZzqKLb IKe2ed BabY8d';
    scorecard.setAttribute('data-label', 'UPDATES');

    // **Content Structure of the "Updates" Scorecard**
    const contentDiv = document.createElement('div');
    contentDiv.className = 'yIS0Lc';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'V3oFR';
    titleDiv.setAttribute('title', 'Updates');
    titleDiv.style.paddingTop = '5px';
    titleDiv.style.paddingLeft = '5px';
    titleDiv.style.fontWeight = 'bold';

    const titleTextSpan = document.createElement('span');
    titleTextSpan.className = 'kKiCtc zMKVrd wuCBdd';
    titleTextSpan.textContent = 'Updates';

    titleDiv.appendChild(titleTextSpan);
    contentDiv.appendChild(titleDiv);

    // **Create the Update List with Color-Coded Labels**
    const updateListDiv = document.createElement('div');
    updateListDiv.className = 'nnLLaf vtZz6e';
    updateListDiv.style.fontSize = '14px';
    updateListDiv.style.padding = '10px';

    // **Define Update Types and Their Colors**
    const updates = [
      { text: 'Core', color: 'purple' },
      { text: 'Spam', color: 'red' },
      { text: 'Review', color: 'green' },
      { text: 'Helpful Content', color: 'magenta' },
    ];

    // **Add Each Update Type with Color Coding**
    updates.forEach((update) => {
      const updateItem = document.createElement('div');
      updateItem.style.display = 'flex';
      updateItem.style.alignItems = 'center';
      updateItem.style.marginBottom = '4px';

      // **Create a Colored Square for Each Update**
      const colorBox = document.createElement('span');
      colorBox.style.width = '12px';
      colorBox.style.height = '12px';
      colorBox.style.display = 'inline-block';
      colorBox.style.backgroundColor = update.color;
      colorBox.style.marginRight = '6px';

      // **Add Text Next to the Colored Square**
      const textSpan = document.createElement('span');
      textSpan.textContent = update.text;

      // **Append the Color Box and Text to the Item**
      updateItem.appendChild(colorBox);
      updateItem.appendChild(textSpan);

      // **Append the Item to the Update List**
      updateListDiv.appendChild(updateItem);
    });

    // **Append All Elements to the Scorecard**
    contentDiv.appendChild(updateListDiv);
    scorecard.appendChild(contentDiv);

    // **Step 4: Append the New Scorecard to the LATEST container's .AaD0rc**
    containerElement.appendChild(scorecard);
    console.log('Update "Updates" scorecard added successfully inside the latest container.');
  }

  // Function to observe graph changes and reapply updates
  function observeGraph() {
    const observer = new MutationObserver((mutations) => {
      let graphUpdated = false;
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            node.classList.contains('rZqBPb')
          ) {
            graphUpdated = true;
          }
        });
      });
      if (graphUpdated) {
        console.log('Graph updated. Reapplying algorithm updates and legend scorecard...');
        applyAlgorithmUpdates();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('Observer initialized.');
  }

  function init() {
    console.log('Initializing algorithm updates and legend...');
    applyAlgorithmUpdates();
    observeGraph();
  }

  init();
})();