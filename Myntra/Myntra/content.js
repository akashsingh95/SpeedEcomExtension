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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Lets background.js cheaply confirm this content script is alive before
    // relying on it - a tab that was open before the extension loaded (or was
    // discarded/reloaded) won't answer this.
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
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
