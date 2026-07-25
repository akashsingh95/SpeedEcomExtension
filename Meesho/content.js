(() => {
  'use strict';

  const TAG = '[meesho-sync:content]';
  console.log(TAG, 'loaded at', location.href);

  const ORIGIN = 'https://supplier.meesho.com';
  const BASE_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'client-type': 'd-web',
    'client-version': 'v1',
  };

  // Verbose logging so you can inspect every request/response and the exact data
  // Meesho returns, right in the page console (F12). Set VERBOSE=false to silence.
  const VERBOSE = true;
  function log(...a) { if (VERBOSE) { try { console.log('%c[meesho-sync]', 'color:#6d28d9;font-weight:bold', ...a); } catch (_) {} } }
  function logReq(path, body) { if (VERBOSE) { try { console.log('%c[meesho-sync] → REQUEST', 'color:#2563eb;font-weight:bold', path, body ?? ''); } catch (_) {} } }
  function logRes(path, status, body) { if (VERBOSE) { try { console.log('%c[meesho-sync] ← RESPONSE [' + status + ']', 'color:#16a34a;font-weight:bold', path, body); } catch (_) {} } }

  // The actual authenticated fetch must run here, in the page's own origin,
  // so the browser attaches the seller's real session cookies. Everything
  // else - polling, backoff, timing between requests - lives in background.js
  // instead. A service worker is not a tab, so it is never slowed down by
  // Chrome's background-tab timer throttling the way this content script's
  // own timers would be if the user switches away from this tab.
  async function api(path, { body, identifier } = {}) {
    logReq(path, body);
    const res = await fetch(ORIGIN + path, {
      method: 'POST',
      credentials: 'include',
      headers: { ...BASE_HEADERS, ...(identifier ? { identifier } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    let retryAfter = null;
    try { const ra = res.headers.get('retry-after'); if (ra) retryAfter = Number(ra) || null; } catch (_) {}
    logRes(path, res.status, json);
    return { status: res.status, body: json, retryAfter };
  }

  function readSellerNameFromDom() {
    const selectors = [
      '[data-testid="user-name"]',
      '[data-testid="seller-name"]',
      '[data-testid="profile-name"]',
      '[class*="SellerName"]',
      '[class*="seller-name"]',
      '[class*="supplierName"]',
      '[class*="UserName"]',
      '[class*="ProfileName"]',
      '[class*="profile-name"]',
      'header [class*="name"]',
      '.seller-name',
      '.supplier-name',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return null;
  }

  // ── Message relay ────────────────────────────────────────────────────────
  // background.js drives all timing/orchestration and sends one request at a
  // time, waiting for the immediate reply - no loops or sleeps happen in this
  // content script anymore, so it can never be the thing that slows a sync
  // down just because the tab lost focus.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Lets background.js cheaply confirm this content script is actually alive
    // before relying on it - a discarded/navigated-away tab won't answer this.
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === 'RELAY_API_CALL') {
      (async () => {
        try {
          const r = await api(msg.path, { body: msg.body, identifier: msg.identifier });
          sendResponse({ ok: true, status: r.status, body: r.body, retryAfter: r.retryAfter });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'RELAY_DOM_SELLER_NAME') {
      sendResponse({ name: readSellerNameFromDom() });
      return false;
    }

    return false;
  });
})();
