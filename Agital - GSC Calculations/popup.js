// popup.js

// Existing functionality for running calculations
document.getElementById('run-script').addEventListener('click', () => {
    // Set up the message listener
    const messageListener = (message, sender, sendResponse) => {
        // Listen for the new message types from content.js
        if (message.type === 'PERCENTAGE_CHANGE_ERROR') {
            updateStatus(message.message, 'red');
        } else if (message.type === 'PERCENTAGE_CHANGE_SUCCESS') {
            updateStatus(message.message, 'green');
        }
        // Remove the listener after handling the message
        chrome.runtime.onMessage.removeListener(messageListener);
    };

    chrome.runtime.onMessage.addListener(messageListener);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length > 0) {
            chrome.scripting.executeScript(
                {
                    target: { tabId: tabs[0].id },
                    files: ['content.js'], // Inject your updated content script
                },
                () => {
                    if (chrome.runtime.lastError) {
                        console.error('Error executing script:', chrome.runtime.lastError.message);
                        updateStatus('Failed to run calculations.', 'red');
                        // Remove the listener in case of error
                        chrome.runtime.onMessage.removeListener(messageListener);
                    } else {
                        // Set a temporary status right after injection
                        // (You can rename or remove this if you’d prefer to rely solely on messages from content.js)
                        //updateStatus('percentage change calculations applied', 'blue');
                    }
                }
            );
        } else {
            console.error('No active tab found.');
            updateStatus('No active tab found.', 'red');
            // Remove the listener since there's no active tab
            chrome.runtime.onMessage.removeListener(messageListener);
        }
    });
});

// New functionality for showing algorithm updates
document.getElementById('show-algo-updates').addEventListener('click', () => {
    // Set up the message listener
    const messageListener = (message, sender, sendResponse) => {
        // This part remains the same, still looking for ALG_UPDATE_* types
        if (message.type === 'ALG_UPDATE_ERROR') {
            updateStatus(message.message, 'red');
        } else if (message.type === 'ALG_UPDATE_SUCCESS') {
            updateStatus(message.message, 'green');
        }
        // Remove the listener after handling the message
        chrome.runtime.onMessage.removeListener(messageListener);
    };

    chrome.runtime.onMessage.addListener(messageListener);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length > 0) {
            chrome.scripting.executeScript(
                {
                    target: { tabId: tabs[0].id },
                    files: ['algoupdates.js'], // Trigger your new script
                },
                () => {
                    if (chrome.runtime.lastError) {
                        console.error('Error executing script:', chrome.runtime.lastError.message);
                        updateStatus('Failed to show algorithm updates.', 'red');
                        // Remove the listener in case of error
                        chrome.runtime.onMessage.removeListener(messageListener);
                    } else {
                        // Temporary status
                        updateStatus('Applying algorithm updates...', 'blue');
                    }
                }
            );
        } else {
            console.error('No active tab found.');
            updateStatus('No active tab found.', 'red');
            // Remove the listener since there's no active tab
            chrome.runtime.onMessage.removeListener(messageListener);
        }
    });
});

// Function to update the status message in the popup
function updateStatus(message, color) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = message;
        statusElement.style.color = color;
    }
}

// Optional: Clear status when the popup is opened
document.addEventListener('DOMContentLoaded', () => {
    updateStatus('', 'black');
});