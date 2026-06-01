export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type !== 'CHECKOUT_DETECTED') return;
    if (!sender.tab?.id) return;

    // Set badge to signal the user
    chrome.action.setBadgeText({ text: '!', tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#1D9E75', tabId: sender.tab.id });

    // Store context so popup can read it immediately on open
    chrome.storage.session.set({
      [`checkout:${sender.tab.id}`]: message.context,
    });
  });

  // Clear badge when user navigates away
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      chrome.action.setBadgeText({ text: '', tabId });
      chrome.storage.session.remove(`checkout:${tabId}`);
    }
  });
});
