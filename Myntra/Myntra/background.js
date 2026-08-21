'use strict';

importScripts('jszip.min.js');

const TAG = '[myntra-sync:bg]';

const MAX_ATTEMPTS = 3;              // 1 initial try + 2 retries
const FETCH_TIMEOUT_MS = 30000;      // fallback ceiling per file if fetch() never settles
const LOG_MAX_ENTRIES = 200;

// Myntra's report files live on Azure Blob Storage, whose SAS URLs return no
// CORS headers at all ("No 'Access-Control-Allow-Origin' header is present"),
// which blocks fetch() from any origin, extension or page. This rule injects
// the missing header onto the RESPONSE for the extension's own requests to
// that host, before the browser's CORS check runs - it doesn't change what
// Azure sends, only what this extension's own fetch() calls see, and only for
// a host already covered by host_permissions. Same declarativeNetRequest
// mechanism the Meesho extension already uses (there, to rewrite Origin on
// requests; here, to add a response header) - not a new technique for this
// codebase, just applied in the other direction.
const BLOB_HOST = 'analyticsfereportci.blob.core.windows.net';
const CORS_FIX_RULE_ID = 1;
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [CORS_FIX_RULE_ID],
  addRules: [
    {
      id: CORS_FIX_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
        ],
      },
      condition: {
        urlFilter: `||${BLOB_HOST}/*`,
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ],
}).catch((e) => console.warn(TAG, 'declarativeNetRequest rule failed:', e?.message));

// ── Auth: SpeedEcom account login ───────────────────────────────────────────
// Same flow and same backend as the Meesho extension: GET public-key (PEM) ->
// RSA-OAEP/SHA-1 encrypt the password -> POST login (email + encrypted
// password) -> GET profile with the bearer token. Token is cached in
// chrome.storage.local indefinitely - nothing here clears it automatically.
const AUTH_ORIGIN = 'https://speedecomsolution.in';

// Production's CORS check rejects requests whose Origin isn't its own web
// app (the extension's real origin, chrome-extension://<id>, isn't on that
// allow-list). Fetch can't set Origin/Referer directly - forbidden headers -
// so this rewrites them at the network layer for AUTH_ORIGIN requests only,
// making the request look like it came from the site's own login page. Uses
// rule ID 2 - ID 1 is already taken by the Azure CORS-fix rule above.
const AUTH_HEADER_RULE_ID = 2;
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [AUTH_HEADER_RULE_ID],
  addRules: [
    {
      id: AUTH_HEADER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: AUTH_ORIGIN },
          { header: 'Referer', operation: 'set', value: `${AUTH_ORIGIN}/client/login` },
        ],
      },
      condition: {
        urlFilter: `||${AUTH_ORIGIN.replace(/^https?:\/\//, '')}/api/auth/*`,
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ],
}).catch((e) => console.warn(TAG, 'declarativeNetRequest rule failed:', e?.message));

function pemToArrayBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/[\r\n\s]+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function encryptPassword(password, pem) {
  const keyData = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey('spki', keyData, { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(password));
  return arrayBufferToBase64(cipher);
}

// Defensive extraction - the exact response shape isn't documented, so
// search for a JWT-looking string rather than hard-coding one field name.
function extractToken(body) {
  const isJwt = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
  const direct = body?.token || body?.accessToken || body?.access_token || body?.jwt ||
    body?.data?.token || body?.data?.accessToken || body?.result?.token;
  if (isJwt(direct)) return direct;
  const stack = [body];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const v of Object.values(cur)) {
      if (isJwt(v)) return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function extractUser(body) {
  const u = body?.data?.user || body?.user || body?.data || body;
  if (!u || typeof u !== 'object') return {};
  const name = u.name || u.fullName || u.full_name || u.business_name || u.businessName || u.company || u.displayName || u.username || null;
  const email = u.email || u.emailAddress || u.email_address || null;

  // Which marketplace panels this tenant should even see, so the chooser
  // list (shell/chooser.js) can hide the ones they have no access to
  // instead of always showing all three. tenantId.activatedMarketplaces is
  // one entry per linked marketplace ACCOUNT (a tenant can have several
  // under the same marketplace) - confirmed live via a full
  // GET /api/auth/profile capture - reduced here to one boolean per
  // marketplace this extension actually has a panel for. Kept identical to
  // Amazon's/Meesho's copy of this function since any of the three panels'
  // own AUTH_REFRESH_PROFILE can overwrite the shared `auth.user` record.
  const activatedList = Array.isArray(u.tenantId?.activatedMarketplaces) ? u.tenantId.activatedMarketplaces : [];
  const hasMarketplace = (needle) =>
    activatedList.some((m) => String(m?.marketplaceName || '').toLowerCase().includes(needle));
  const marketplaces = {
    amazon: hasMarketplace('amazon'),
    meesho: hasMarketplace('meesho'),
    myntra: hasMarketplace('myntra'),
  };

  return { name, email, marketplaces };
}

async function authLogin(email, password) {
  const pkRes = await fetch(`${AUTH_ORIGIN}/api/auth/public-key`, { headers: { accept: 'application/json' } });
  const pkBody = await pkRes.json().catch(() => ({}));
  if (!pkRes.ok || !pkBody?.publicKey) throw new Error(pkBody?.message || 'Could not reach login server.');

  const encryptedPassword = await encryptPassword(password, pkBody.publicKey);

  const loginRes = await fetch(`${AUTH_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
    body: JSON.stringify({ email, password: encryptedPassword }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) throw new Error(loginBody?.message || 'Invalid email or password.');

  const token = extractToken(loginBody);
  if (!token) throw new Error('Login succeeded but no session token was returned.');

  const user = await authFetchProfile(token);
  await chrome.storage.local.set({ auth: { token, user, loggedInAt: Date.now() } });
  return user;
}

async function authFetchProfile(token) {
  const res = await fetch(`${AUTH_ORIGIN}/api/auth/profile`, {
    headers: { accept: 'application/json, text/plain, */*', authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || 'Could not load profile.');
  return extractUser(body);
}

// Toolbar-icon badge - lets a running/finished sync be noticed without
// having the popup open at all. Badge text is stateful (unlike a popup),
// so it deliberately stays as-is (✓ or !) after a sync finishes until the
// popup is actually opened and acknowledges it (see the CLEAR_BADGE message,
// sent right after initMainApp() clears a finished syncProgress) - clearing
// it the instant the sync finishes would defeat the point of a passive
// "something happened" signal.
async function updateBadge(progress) {
  try {
    if (!progress || (!progress.active && !progress.finished)) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    if (progress.finished) {
      if (progress.error) {
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
      } else if (progress.cancelled) {
        await chrome.action.setBadgeText({ text: '' });
      } else {
        await chrome.action.setBadgeText({ text: '✓' });
        await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      }
      return;
    }
    // Active: show a done/total count once downloading is actually under
    // way (meaningful progress), otherwise a plain dot for the
    // scheduling/waiting-for-Myntra phases where there's nothing to count yet.
    const text = progress.total > 0 ? `${progress.done}/${progress.total}` : '•';
    await chrome.action.setBadgeText({ text: String(text).slice(0, 4) });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF9900' });
  } catch (_) {}
}

async function setProgress(progress) {
  try { await chrome.storage.local.set({ syncProgress: { ...progress, at: Date.now() } }); } catch (_) {}
  await updateBadge(progress);
}

// `active` is distinct from `finished`/`total`: it's true from the moment a
// sync starts until it ends, even while `total` is still 0 (during task
// collection, before any file count is known). Without this, the popup had
// no way to tell "just started, still figuring out how many files there
// are" apart from "nothing running at all", which is what made a fresh sync
// look like it hadn't started - and made a mid-collection popup reopen show
// the idle state instead of an in-progress one.
function newState(overrides) {
  return { active: true, total: 0, done: 0, failed: 0, failures: [], current: null, finished: false, error: null, paused: false, cancelled: false, ...overrides };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory only, on purpose: pause/cancel only ever need to affect the sync
// currently running in this same service worker execution - there is nothing
// to persist across a worker restart, since a restart already means the
// in-flight loop is gone.
let syncControl = { paused: false, cancelled: false };

function throwIfCancelled() {
  if (syncControl.cancelled) {
    const err = new Error('Cancelled by user.');
    err.cancelled = true;
    throw err;
  }
}

async function appendLog(entry) {
  const line = { ...entry, at: Date.now() };
  console.log(TAG, line.status, line.filename || '', line.detail || '');
  try {
    const { syncLog } = await chrome.storage.local.get('syncLog');
    const list = Array.isArray(syncLog) ? syncLog : [];
    list.push(line);
    while (list.length > LOG_MAX_ENTRIES) list.shift();
    await chrome.storage.local.set({ syncLog: list });
  } catch (_) {}
}

// One real fetch attempt for a single file's bytes. Works now because the
// declarativeNetRequest rule above injects the CORS header Azure doesn't
// send. A timeout via AbortController stands in for a network ceiling -
// fetch() itself has no built-in one, so a hung request would otherwise
// block the whole queue indefinitely.
async function fetchFileOnce(task) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(task.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
}

// Retries a single task up to MAX_ATTEMPTS on failure (network error, bad
// status, timed out) - never throws, always resolves with a result so the
// queue can continue to the next task regardless.
async function fetchFileWithRetry(task) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buf = await fetchFileOnce(task);
      await appendLog({ status: 'downloaded', filename: task.filename });
      return { ok: true, buf };
    } catch (e) {
      lastErr = e;
      const isFinal = attempt >= MAX_ATTEMPTS;
      await appendLog({ status: isFinal ? 'failed' : 'retrying', filename: task.filename, detail: e.message, attempt });
    }
  }
  return { ok: false, error: lastErr?.message || 'Unknown error' };
}

// Takes the full zip path (e.g. "Postpaid/2026-07-10-2435.64-DEUTH...csv"),
// only adding a " (2)" suffix if two tasks land on the exact same path -
// same filename in different payment-type folders is not a collision, since
// the full paths differ.
function uniqueZipName(used, name) {
  let n = (name && String(name).trim()) || 'file';
  if (!used.has(n)) { used.add(n); return n; }
  const dot = n.lastIndexOf('.');
  const base = dot > 0 ? n.slice(0, dot) : n;
  const ext = dot > 0 ? n.slice(dot) : '';
  let i = 2;
  while (used.has(`${base} (${i})${ext}`)) i++;
  const out = `${base} (${i})${ext}`;
  used.add(out);
  return out;
}

// Sequential by design - fetches one file at a time (gentle on Myntra's CDN,
// keeps progress meaningful), packs everything into one JSZip, and triggers
// exactly one chrome.downloads.download() call for the whole batch. This is
// what avoids hundreds of individual chrome.downloads calls for a large
// date range - there's only one real download event no matter how many
// files were collected.
async function processDownloadQueue(tasks, zipBaseName) {
  const state = newState({ total: tasks.length });
  await setProgress(state);

  const zip = new JSZip();
  const used = new Set();

  for (const task of tasks) {
    // Idle here without doing work while paused, preserving the counts so
    // far - resuming just continues the same loop, nothing is re-fetched.
    while (syncControl.paused && !syncControl.cancelled) {
      state.paused = true;
      state.current = 'Paused';
      await setProgress(state);
      await sleep(300);
    }
    state.paused = false;

    // Cancel means abort - stop immediately, no ZIP gets built at all.
    // Whatever bytes are already sitting in `zip` are simply discarded
    // (nothing is written to disk, no download fires) rather than packaged.
    if (syncControl.cancelled) break;

    state.current = task.filename;
    await setProgress(state);

    const result = await fetchFileWithRetry(task);
    if (result.ok) {
      const zipPath = task.zipFolder ? `${task.zipFolder}/${task.filename}` : task.filename;
      zip.file(uniqueZipName(used, zipPath), result.buf);
      state.done++;
    } else {
      state.failed++;
      state.failures.push({ filename: task.filename, reason: result.error });
    }
    await setProgress(state);
  }

  if (syncControl.cancelled) state.cancelled = true;

  if (state.done > 0 && !state.cancelled) {
    state.current = 'Generating ZIP...';
    await setProgress(state);

    // URL.createObjectURL is not available in this MV3 service worker
    // context, so JSZip generates a base64 string directly instead of a
    // Blob, and that becomes a data: URL - chrome.downloads.download()
    // accepts data: URLs natively, no createObjectURL/FileReader needed.
    const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const dataUrl = `data:application/zip;base64,${zipBase64}`;
    await new Promise((resolve) => {
      chrome.downloads.download({ url: dataUrl, filename: `${zipBaseName}.zip`, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) console.warn(TAG, 'zip download:', chrome.runtime.lastError.message);
        resolve(id);
      });
    });
  }

  if (state.cancelled) {
    const remaining = tasks.length - state.done - state.failed;
    state.current = `Cancelled - stopped after ${state.done} file(s) fetched, ${remaining} not attempted. No ZIP was created.`;
  } else {
    state.current = null;
  }
  state.finished = true;
  await setProgress(state);
  return state;
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(resp);
    });
  });
}

async function pingTab(tabId) {
  try { await sendToTab(tabId, { type: 'PING' }); return true; } catch (_) { return false; }
}

// content_scripts declared in manifest.json only auto-inject on page
// load/navigation - a tab that was already open before the extension was
// installed/reloaded (or one Chrome discarded) has no content script alive
// to answer messages, which is what "Receiving end does not exist" means.
// chrome.scripting.executeScript re-injects it into the tab as it already
// is, no page reload needed.
async function ensureContentScript(tabId) {
  if (await pingTab(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn(TAG, 'content.js injection failed:', e?.message);
    return false;
  }
  return pingTab(tabId);
}

// One retry, only for the specific "nothing answered" failure classes (dead
// content script, or a message port that closed before a response arrived) -
// any other error (e.g. Myntra's API itself returning an error) is rethrown
// immediately since retrying it would just repeat the same real failure.
async function sendToTabWithRecovery(tabId, message) {
  try {
    return await sendToTab(tabId, message);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection|message port closed/i.test(e.message)) throw e;
    console.warn(TAG, 'relay failed, attempting recovery:', e.message);
    if (!(await ensureContentScript(tabId))) throw e;
    return sendToTab(tabId, message);
  }
}

// The Speed Ecom account's registered business/company name - fallback only,
// used when the live Myntra seller name can't be scraped (content script
// unreachable, page structure changed, etc.), same pattern as Amazon's
// getTenantName()/fetchSellerAccountName().
async function getTenantName() {
  let auth;
  try {
    ({ auth } = await chrome.storage.local.get('auth'));
  } catch (_) {
    return 'Myntra';
  }
  return auth?.user?.name || 'Myntra';
}

// Confirmed live to always render the seller/business name (unlike the
// public marketing homepage or the Profile/Terms page, which don't).
const MYNTRA_DASHBOARD_URL = 'https://partners.myntrainfo.com/Dashboard?tab=overview';

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Last resort when no already-open Myntra tab has the seller name (e.g. the
// seller only ever has one Partner Portal tab open, and it isn't on the
// Dashboard): opens a hidden background tab to the Dashboard, fetches the
// name, then closes it again - session cookies are shared across tabs of
// the same origin, so this loads already logged in. Mirrors Amazon's
// resolvePageForCategory/navigateAndPreparePage pattern (open a dedicated
// temp tab for a page-bound value), scaled down to a single one-shot fetch
// since nothing here needs to persist across a service-worker restart.
async function fetchSellerNameViaHiddenTab() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: MYNTRA_DASHBOARD_URL, active: false });
    await waitForTabComplete(tab.id);
    if (!(await ensureContentScript(tab.id))) return null;
    // Chrome's 'complete' tab status fires once the Dashboard's initial page
    // shell loads - but it's a data-driven SPA, and the business name itself
    // only appears in the DOM a few seconds later, once an async API call
    // finishes and the page re-renders. A single check right after 'complete'
    // was confirmed live to land in that gap and find nothing, so this polls
    // instead of checking once.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      let resp;
      try { resp = await sendToTab(tab.id, { type: 'GET_SELLER_ACCOUNT_NAME' }); } catch (_) { resp = null; }
      if (resp?.name) return resp.name;
      await sleep(600);
    }
    return null;
  } catch (e) {
    console.warn(TAG, 'hidden-tab seller name fetch failed:', e?.message);
    return null;
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
  }
}

// The seller/business name only renders on certain Partner Portal pages
// (confirmed live: present on Dashboard, absent on the public marketing
// homepage and the Profile/Terms page) - not a persistent header on every
// page. So a sync started from a tab that happens to be on one of those
// other pages would otherwise fall back to the SpeedEcom tenant name even
// while a Dashboard tab sitting right next to it has the real answer. Tries
// the sync tab first (the common case, no extra work), then every other
// open Myntra tab, then finally a hidden Dashboard tab opened just for this.
async function fetchSellerAccountName(tabId) {
  try {
    const resp = await sendToTabWithRecovery(tabId, { type: 'GET_SELLER_ACCOUNT_NAME' });
    if (resp?.name) return resp.name;
  } catch (_) {}

  try {
    const tabs = await chrome.tabs.query({ url: 'https://partners.myntrainfo.com/*' });
    for (const t of tabs) {
      if (t.id === tabId) continue; // already tried above
      try {
        const resp = await sendToTabWithRecovery(t.id, { type: 'GET_SELLER_ACCOUNT_NAME' });
        if (resp?.name) return resp.name;
      } catch (_) {}
    }
  } catch (_) {}

  return fetchSellerNameViaHiddenTab();
}

// Builds the ZIP's filename - no more user-editable "ZIP file name" field,
// it's always derived from the live seller/business name (scraped from the
// Partner Portal page) and the requested date range, same idea as Amazon's
// buildZipName()/Meesho's Meesho_<Shop>_<from>_to_<to>.zip.
async function buildZipName(fromDate, toDate, tabId) {
  const scraped = tabId ? await fetchSellerAccountName(tabId) : null;
  const seller = safeZipName(scraped || (await getTenantName()));
  return `Myntra_Payments_${seller}_${fromDate}_to_${toDate}`;
}

function safeZipName(s) {
  return (
    String(s || 'Myntra_Payments')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'Myntra_Payments'
  );
}

// Only the file extension is taken from the URL now - the name itself is
// built from the row's own data (date, amount, UTR) instead of Myntra's raw
// Spark part-file name, per what's actually useful to identify a file by.
function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '.csv';
  } catch (_) {
    return '.csv';
  }
}

function sanitizeForFilename(s) {
  return (
    String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'file'
  );
}

// utrNumber arrives as e.g. "NFT-/XUTR/DEUTH02619185161X" - the meaningful,
// human-identifiable part is the last "/"-separated segment
// ("DEUTH02619185161X"); the rest is a fixed prefix on every row.
function utrShortCode(utrNumber) {
  const parts = String(utrNumber || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(utrNumber || 'UNKNOWN');
}

// paymentDate-amount-utrCode, e.g. "2026-07-10-2435.64-DEUTH02619185161X.csv" -
// the convention requested in place of Myntra's raw Spark part-file name.
function buildPaymentFilename(p, ext) {
  const date = p.paymentDate || 'unknown-date';
  const amount = p.amount != null ? String(p.amount) : 'unknown-amount';
  const utr = sanitizeForFilename(utrShortCode(p.utrNumber));
  return `${date}-${amount}-${utr}${ext}`;
}

// Groups files into a Postpaid/ or Prepaid/ folder inside the ZIP based on
// the row's own paymentMethod field - falls back to "Other" for any
// unexpected value rather than silently mislabeling it as one or the other.
function zipFolderFor(paymentMethod) {
  const m = String(paymentMethod || '').toLowerCase();
  if (m === 'postpaid') return 'Postpaid';
  if (m === 'prepaid') return 'Prepaid';
  return 'Other';
}

// Some rows (e.g. ZERO_PAYMENT_ADVICE / zero-amount advisory entries) carry a
// non-empty but non-URL value in utrDetailsLink - there's no real file behind
// them. Filtering these out at collection time avoids burning 3 retry
// attempts on a download that was never going to succeed.
function isDownloadableUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

const PAGE_SIZE = 100;

// Loops every selected type (PREPAID/POSTPAID) through every page of the
// payment-history API for the given date range, using the response's own
// totalPages as the authoritative stop condition - no DOM pagination reading
// needed since this calls the API directly.
async function collectPaymentTasksViaApi(tabId, { fromDate, toDate, types }) {
  const tasks = [];

  for (const paymentType of types) {
    let pageNo = 0;
    let totalPages = 1;

    do {
      // The relay message's own `type` (message-kind discriminator,
      // 'FETCH_PAYMENT_HISTORY') must stay distinct from the payment type
      // (PREPAID/POSTPAID). Naming this `paymentType` avoids a duplicate-key
      // collision in the object literal below - the previous `type` shorthand
      // here silently overwrote 'FETCH_PAYMENT_HISTORY' with 'PREPAID'/
      // 'POSTPAID', so content.js's `msg.type === 'FETCH_PAYMENT_HISTORY'`
      // check never matched and no listener ever responded.
      const resp = await sendToTabWithRecovery(tabId, {
        type: 'FETCH_PAYMENT_HISTORY',
        fromDate, toDate, paymentType, pageNo, pageSize: PAGE_SIZE,
      });
      if (!resp?.ok) throw new Error(resp?.error || `Could not fetch ${paymentType} payment history.`);
      if (resp.status >= 400) throw new Error(`Myntra returned HTTP ${resp.status} for ${paymentType}.`);

      const data = resp.body?.data;
      totalPages = data?.totalPages ?? 1;

      for (const p of data?.payments || []) {
        if (!p?.utrDetailsLink || !isDownloadableUrl(p.utrDetailsLink)) continue;
        tasks.push({
          url: p.utrDetailsLink,
          filename: buildPaymentFilename(p, extensionFromUrl(p.utrDetailsLink)),
          zipFolder: zipFolderFor(p.paymentMethod),
          reportType: 'payment',
          metadata: {
            utrNumber: p.utrNumber,
            amount: p.amount,
            paymentDate: p.paymentDate,
            paymentMethod: p.paymentMethod,
          },
        });
      }
      pageNo++;
      throwIfCancelled();
      await setProgress(newState({ current: `Collecting ${paymentType} list (page ${pageNo}/${totalPages}, ${tasks.length} found so far)...` }));
    } while (pageNo < totalPages);
  }

  return tasks;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'CLEAR_BADGE') {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'AUTH_LOGIN') {
    (async () => {
      try {
        const user = await authLogin(msg.email, msg.password);
        sendResponse({ ok: true, user });
      } catch (e) {
        console.warn(TAG, 'login failed:', e?.message);
        sendResponse({ ok: false, error: e?.message || 'Login failed.' });
      }
    })();
    return true; // keep the channel open for the async sendResponse above
  }

  if (msg?.type === 'AUTH_REFRESH_PROFILE') {
    (async () => {
      try {
        const { auth } = await chrome.storage.local.get('auth');
        if (!auth?.token) { sendResponse({ ok: false }); return; }
        const user = await authFetchProfile(auth.token);
        await chrome.storage.local.set({ auth: { ...auth, user } });
        sendResponse({ ok: true, user });
      } catch (e) {
        // Never clear the stored token here - a transient network/profile
        // error must not log the user out.
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg?.type === 'PAUSE_SYNC') {
    syncControl.paused = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'RESUME_SYNC') {
    syncControl.paused = false;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'CANCEL_SYNC') {
    syncControl.cancelled = true;
    syncControl.paused = false; // don't leave it stuck idling in the pause loop
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'START_PAYMENT_SYNC') {
    (async () => {
      try {
        syncControl = { paused: false, cancelled: false }; // fresh state per sync, not left over from a previous one
        await setProgress(newState({ current: 'Starting sync...' }));

        const tabs = await chrome.tabs.query({ url: 'https://partners.myntrainfo.com/*' });
        if (!tabs.length) {
          await setProgress(newState({ finished: true, error: 'Open the Myntra Partner Portal (logged in) first.' }));
          return;
        }
        const tab = tabs.find((t) => t.active) || tabs[0];

        if (!(await ensureContentScript(tab.id))) {
          throw new Error('Could not connect to the Myntra tab. Please reload the page and try again.');
        }

        const { fromDate, toDate, types } = msg;
        if (!fromDate || !toDate) throw new Error('Pick a date range first.');
        if (!Array.isArray(types) || !types.length) throw new Error('Select Prepaid and/or Postpaid first.');

        console.log(TAG, `starting sync: ${fromDate} to ${toDate}, types=${types.join(',')}`);
        await setProgress(newState({ current: 'Collecting payment list...' }));
        const tasks = await collectPaymentTasksViaApi(tab.id, { fromDate, toDate, types });

        if (!tasks.length) {
          await setProgress(newState({ finished: true, error: 'No payment files found for that date range.' }));
          return;
        }

        await processDownloadQueue(tasks, await buildZipName(fromDate, toDate, tab.id));
      } catch (e) {
        if (e?.cancelled) {
          // Cancelled during collection, before any file existed to zip -
          // nothing to package, unlike a cancel during the download phase.
          console.log(TAG, 'sync cancelled during collection');
          await setProgress(newState({ finished: true, cancelled: true, current: 'Cancelled - no files were downloaded yet.' }));
          return;
        }
        console.warn(TAG, 'sync failed:', e?.message);
        await setProgress(newState({ finished: true, error: e?.message || 'Sync failed.' }));
      }
    })();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
