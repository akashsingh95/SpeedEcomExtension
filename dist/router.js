'use strict';
// Speed Ecom - per-tab popup router.
//
// MV3 allows exactly one default popup, but the popup can be overridden per
// tab. So each marketplace keeps its ORIGINAL popup.html, untouched, with its
// own CSS and its own width (Amazon 360px, Meesho 344px, Myntra 320px), and
// Chrome sizes each one natively. On any other tab the chooser is shown.
//
// This runs in the worker's real global scope (no shim) - it is Speed Ecom's
// own code, not part of any marketplace bundle.

(function () {
  const ROUTES = [
    [/^https:\/\/(?:sellercentral|advertising)\.amazon\.in\//i, 'amazon_popup.html'],
    [/^https:\/\/supplier\.meesho\.com\//i, 'meesho_popup.html'],
    [/^https:\/\/partners\.myntrainfo\.com\//i, 'myntra_popup.html'],
  ];
  const CHOOSER = 'chooser.html';

  function popupFor(url) {
    if (!url) return CHOOSER;
    for (const [re, page] of ROUTES) if (re.test(url)) return page;
    return CHOOSER;
  }

  function apply(tabId, url) {
    if (tabId == null || tabId < 0) return;
    // Tabs we have no host permission for report no URL; those are never one of
    // our three domains, so falling back to the chooser is correct.
    chrome.action.setPopup({ tabId, popup: popupFor(url) }).catch(() => {});
  }

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'complete') apply(tabId, tab && tab.url ? tab.url : info.url);
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then((tab) => apply(tabId, tab && tab.url)).catch(() => {});
  });

  // Re-apply to every open tab on each worker startup, so tabs that already
  // existed before the extension loaded (or was reloaded/updated) get the right
  // popup without needing a navigation first.
  chrome.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) apply(t.id, t.url);
    })
    .catch(() => {});
})();
