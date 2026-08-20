(() => {
  'use strict';

  // background.js's ensureContentScript() re-injects this file via
  // chrome.scripting.executeScript whenever a ping fails - without this
  // guard, re-injecting into a tab that already has a (possibly stale, from
  // before an extension reload) instance running would register a second,
  // independent onMessage listener. Two listeners answering the same message
  // is exactly what causes "message port closed before a response was
  // received": the port closes as soon as one responds, and the other's
  // response then has nowhere to go.
  if (window.__myntraSyncContentLoaded) {
    console.warn('[myntra-sync:content] blocked a duplicate injection - a listener from an earlier load is already active in this tab.');
    return;
  }
  window.__myntraSyncContentLoaded = true;

  const TAG = '[myntra-sync:content]';
  const API_ORIGIN = 'https://partnersapi.myntrainfo.com';
  console.log(TAG, 'loaded at', location.href);

  // Runs in the page's own origin so fetch() carries the seller's real
  // session cookies (Akamai bot-manager cookies included) - a background
  // service worker calling this API directly would not pass the same
  // origin/session checks. credentials:'include' plus the two headers below
  // mirror exactly what the page's own network calls send.
  async function fetchPaymentHistoryPage({ fromDate, toDate, paymentType, pageNo, pageSize }) {
    const url =
      `${API_ORIGIN}/api/partners/report/summary/payment-history` +
      `?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}` +
      `&type=${encodeURIComponent(paymentType)}&pageNo=${pageNo}&pageSize=${pageSize}`;

    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'x-myntra-app-name': 'partners',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // Confirmed live via DevTools inspection: the page header's subtitle line
  // on the Partner Portal (e.g. "BANDHANI VILLA" under "Business Growth
  // Dashboard" - <div class="aui-text-body p-pageHeader-module-css-
  // pageHeaderSubtitle aui-text-dark aui-text-high display-initial">).
  // Matched by a stable substring of the CSS-module class name rather than
  // the exact string, in case a build ever changes the module hash/prefix.
  function readSellerAccountName() {
    const el = document.querySelector('[class*="pageHeaderSubtitle" i]');
    const text = el?.textContent?.trim();
    if (text) return text;

    // Fallback guesses, not confirmed - kept only in case the sync ever runs
    // from a Partner Portal page that doesn't render this header at all.
    const selectors = [
      '[class*="businessName" i]', '[class*="business-name" i]', '[class*="BusinessName" i]',
      '[class*="storeName" i]', '[class*="store-name" i]', '[class*="StoreName" i]',
      '[class*="sellerName" i]', '[class*="seller-name" i]',
      '[data-testid*="business" i]', '[data-testid*="store" i]', '[data-testid*="seller" i]',
    ];
    for (const sel of selectors) {
      const fallbackEl = document.querySelector(sel);
      const fallbackText = fallbackEl?.textContent?.trim();
      if (fallbackText) return fallbackText;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Lets background.js cheaply confirm this content script is alive before
    // relying on it - a tab that was open before the extension loaded (or was
    // discarded/reloaded) won't answer this.
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    // Returns null (not an error) when nothing matches, so background.js can
    // fall back to the SpeedEcom tenant name instead of failing the zip.
    if (msg?.type === 'GET_SELLER_ACCOUNT_NAME') {
      sendResponse({ name: readSellerAccountName() });
      return false;
    }

    if (msg?.type === 'FETCH_PAYMENT_HISTORY') {
      (async () => {
        try {
          const r = await fetchPaymentHistoryPage(msg);
          console.log(TAG, `${msg.paymentType} page ${msg.pageNo}: HTTP ${r.status}, totalPages=${r.body?.data?.totalPages}, rows=${r.body?.data?.payments?.length}`);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // async response
    }

    return false;
  });
})();
