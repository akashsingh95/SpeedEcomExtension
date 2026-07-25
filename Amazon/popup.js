'use strict';

const $ = (id) => document.getElementById(id);

function isoDate(d) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayStamp() {
  return isoDate(new Date());
}

// Confirmed live: requesting a report whose range includes today or
// yesterday gets Amazon to schedule generation for "tomorrow" instead of
// running it immediately - a range ending 2+ days back generates in
// seconds. Same lesson, same fix, as Myntra's date cap.
function maxSelectableDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  return isoDate(cutoff);
}

// Confirmed live: a request wider than this doesn't get rejected at
// schedule time - Amazon accepts it, marks the report "Ready", and puts
// "Date range exceeded. Report can be requested only upto 30 days" inside
// the report FILE ITSELF instead - but that error text is only approximate.
// Confirmed live separately: a real 31-day span (a full May, 01/05-31/05)
// came back "Ready" with a genuine working Download link, not the
// error-placeholder file - so the actual enforced limit is a full calendar
// month (up to 31 days), not a strict 30.
const MAX_RANGE_DAYS = 31;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function rangeDays(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00`) - new Date(`${fromDate}T00:00:00`)) / 86400000) + 1;
}

// Return Reports' own validation allows up to and including today ("Date
// range cannot exceed 60 days" / "should not exceed the current date"), but
// applying the same 2-days-back cutoff as Orders/Payments here too, per
// direct instruction - same safe-margin reasoning even without separate
// confirmed evidence of a generation-delay quirk on this specific endpoint.
const MAX_RETURNS_RANGE_DAYS = 60;
function maxReturnsSelectableDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  return isoDate(cutoff);
}

// FBA Customer Returns is a different report (Report Central's
// CUSTOMER_RETURNS, reportFRPId 2610) from the Standard Returns above -
// confirmed live neither the 60-day range cap nor the 2-days-back
// generation-delay cutoff apply here: a 14+ month range ending on today's
// date was accepted and generated successfully.
function isFbaReturnsType() {
  return $('returnsTypeFba').checked;
}
function maxFbaReturnsSelectableDate() {
  return todayStamp();
}

// Swaps the Bulk tab's report-type checkboxes for a live per-category
// status list (colored dot + label) the moment a bulk sync's scheduling/
// polling phase is under way, and swaps back once it's no longer active -
// `progress.bulk` only ever exists during those two phases (background.js
// stops including it once a bulk run reaches its download phase, or once
// any other single-category sync is the one running instead).
const BULK_LIVE_META = {
  orders: { row: 'bulkLiveOrders', dot: 'bulkLiveOrdersDot', status: 'bulkLiveOrdersStatus' },
  payments: { row: 'bulkLivePayments', dot: 'bulkLivePaymentsDot', status: 'bulkLivePaymentsStatus' },
  gst: { row: 'bulkLiveGst', dot: 'bulkLiveGstDot', status: 'bulkLiveGstStatus' },
  returns: { row: 'bulkLiveReturns', dot: 'bulkLiveReturnsDot', status: 'bulkLiveReturnsStatus' },
  fbaReturns: { row: 'bulkLiveFbaReturns', dot: 'bulkLiveFbaReturnsDot', status: 'bulkLiveFbaReturnsStatus' },
};
function renderBulkLive(progress) {
  const bulk = progress?.active && !progress?.finished ? progress.bulk : null;
  const selectSection = $('bulkSelectSection');
  const liveGrid = $('bulkLiveGrid');

  if (!bulk) {
    selectSection.style.display = '';
    liveGrid.style.display = 'none';
    return;
  }

  selectSection.style.display = 'none';
  liveGrid.style.display = 'flex';

  // The backend genuinely polls every still-pending category together each
  // tick (deliberate - mirrors Meesho's "wait on all at once" efficiency, so
  // a slow category never blocks a fast one from finishing early). More
  // than one can legitimately be "In progress" at the same real moment, and
  // showing that honestly - rather than picking just one to display as
  // active - is what keeps a fast category (e.g. Payments finishing before
  // Orders) from appearing to silently skip straight to Done with no
  // visible in-between state.
  for (const cat of Object.keys(BULK_LIVE_META)) {
    const meta = BULK_LIVE_META[cat];
    const rowEl = $(meta.row);
    const dotEl = $(meta.dot);
    const statusEl = $(meta.status);
    if (!rowEl || !dotEl || !statusEl) continue;

    const included = bulk.categories.includes(cat);
    rowEl.style.display = included ? 'flex' : 'none';
    if (!included) continue;

    const phase = bulk.sub[cat]?.phase;
    let text = 'Pending';
    let dotBg = '#ffffff', dotBorder = '#98a1b0', spin = false;
    let statusColor = '#9aa0ac';
    let rowBg = '#ffffff', rowBorder = '#ecedf3';

    if (phase === 'scheduling' || phase === 'polling') {
      text = 'In progress...';
      dotBg = 'transparent'; dotBorder = '#ffcb70'; spin = true;
      statusColor = '#E85D04';
    } else if (phase === 'ready') {
      text = 'Done';
      dotBg = '#16a34a'; dotBorder = '#16a34a';
      statusColor = '#15803d';
      rowBg = '#f2fbf6'; rowBorder = '#bbf0d1';
    } else if (phase === 'failed') {
      text = 'Failed';
      dotBg = '#dc2626'; dotBorder = '#dc2626';
      statusColor = '#b91c1c';
      rowBg = '#fef2f2'; rowBorder = '#fecaca';
    }

    dotEl.style.background = dotBg;
    dotEl.style.borderColor = dotBorder;
    if (spin) {
      dotEl.style.borderTopColor = '#E85D04';
      dotEl.style.borderRightColor = '#E85D04';
      dotEl.style.animation = 'liveSpin 0.7s linear infinite';
    } else {
      dotEl.style.borderTopColor = dotBorder;
      dotEl.style.borderRightColor = dotBorder;
      dotEl.style.animation = 'none';
    }

    statusEl.style.color = statusColor;
    statusEl.textContent = text;

    rowEl.style.background = rowBg;
    rowEl.style.borderColor = rowBorder;
  }
}

function render(progress) {
  renderBulkLive(progress);
  const wrap = $('progress');
  // `active` (not `total`) is the real "is a sync running/just finished"
  // signal - total stays 0 during report generation (before we know whether
  // there's a file at all), which would otherwise look identical to
  // "nothing running".
  if (!progress || !progress.active) {
    wrap.classList.remove('show');
    $('sync').disabled = false;
    $('syncReturns').disabled = false;
    $('syncPayments').disabled = false;
    $('syncGst').disabled = false;
    $('syncAds').disabled = false;
    $('syncBulk').disabled = false;
    $('progressActions').style.display = 'none';
    return;
  }
  wrap.classList.add('show');
  // Only one sync (any single category, or one Bulk run) can run at a time,
  // sharing this same progress state - all buttons disable together
  // regardless of which one is actually running.
  $('sync').disabled = !progress.finished;
  $('syncReturns').disabled = !progress.finished;
  $('syncPayments').disabled = !progress.finished;
  $('syncGst').disabled = !progress.finished;
  $('syncAds').disabled = !progress.finished;
  $('syncBulk').disabled = !progress.finished;

  const fill = $('progressFill');
  fill.classList.remove('indeterminate', 'success', 'cancelled', 'failed');

  // Pause/Cancel only make sense while something is still running.
  if (!progress.finished) {
    $('progressActions').style.display = 'flex';
    $('pauseResumeLabel').textContent = progress.paused ? 'Resume' : 'Pause';
  } else {
    $('progressActions').style.display = 'none';
  }

  if (progress.error) {
    $('progressCount').textContent = 'Sync failed';
    $('progressPct').textContent = '';
    $('progressCurrent').style.display = 'none';
    $('progressFailures').style.display = 'none';
    $('progressDone').style.display = 'none';
    $('progressError').style.display = 'block';
    $('progressError').textContent = progress.error;
    fill.style.width = '100%';
    fill.classList.add('failed');
    return;
  }
  $('progressError').style.display = 'none';

  if (progress.total === 0) {
    // Still requesting/waiting for the report to generate - don't know the
    // file count yet (or, if finished+cancelled, cancellation happened
    // before any file existed to download at all).
    $('progressCount').textContent = progress.current || 'Processing...';
    $('progressPct').textContent = '';
    $('progressCurrent').style.display = 'none';
    $('progressFailures').style.display = 'none';
    $('progressDone').style.display = 'none';
    fill.classList.add('indeterminate');
    return;
  }

  const doneSoFar = progress.done + progress.failed;
  const pct = Math.round((doneSoFar / progress.total) * 100);
  $('progressCount').textContent = `Downloading ${doneSoFar} / ${progress.total}`;
  $('progressPct').textContent = `${pct}%`;
  fill.style.width = `${pct}%`;

  if (progress.current && !progress.finished) {
    $('progressCurrent').textContent = `Current: ${progress.current}`;
    $('progressCurrent').style.display = 'block';
  } else {
    $('progressCurrent').style.display = 'none';
  }

  if (progress.failed > 0) {
    $('progressFailures').style.display = 'block';
    $('progressFailures').textContent = `Failures: ${progress.failed}`;
  } else {
    $('progressFailures').style.display = 'none';
  }

  if (progress.finished) {
    $('progressDone').style.display = 'flex';
    if (progress.cancelled) {
      $('progressCount').textContent = progress.current || 'Cancelled - no ZIP was created';
      $('progressPct').textContent = '';
      $('progressDone').textContent = 'Cancelled';
      $('progressDone').className = 'progress-done cancel';
      fill.style.width = '100%';
      fill.classList.add('cancelled');
    } else {
      $('progressCount').textContent = `Downloaded ${progress.done} / ${progress.total}`;
      $('progressDone').textContent = 'Completed';
      $('progressDone').className = 'progress-done ok';
      fill.classList.add('success');
    }
  }
}

async function refresh() {
  let syncProgress;
  try { ({ syncProgress } = await chrome.storage.local.get('syncProgress')); } catch (_) { return; }
  render(syncProgress);
  return syncProgress;
}

// The background alarm alone can leave status looking stale for up to
// ~1 minute (Chrome enforces a real floor on alarm periods regardless of
// what's asked for) - while the popup is actually open and watching, poke
// the background to run an immediate check instead of waiting on it, same
// trigger Pause/Resume already use, just on a timer.
async function pollNow() {
  let syncProgress;
  try { ({ syncProgress } = await chrome.storage.local.get('syncProgress')); } catch (_) { return; }
  if (!syncProgress?.active || syncProgress?.finished) return;
  try { await chrome.runtime.sendMessage({ type: 'POLL_NOW' }); } catch (_) {}
}

function showFormError(msg) {
  const el = $('formError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearFormError() {
  $('formError').style.display = 'none';
}

// Mirrors Amazon's own picker: once one date is chosen, the other end's
// selectable range is visually locked to a 30-day window around it (on top
// of the existing 2-days-back cutoff), rather than letting the picker offer
// dates that would only fail later.
function updateDateConstraints() {
  const maxDate = maxSelectableDate();
  const fromEl = $('fromDate');
  const toEl = $('toDate');

  toEl.max = fromEl.value ? [addDays(fromEl.value, MAX_RANGE_DAYS - 1), maxDate].sort()[0] : maxDate;
  toEl.min = fromEl.value || '';
  fromEl.max = maxDate;
  // Intentionally no fromEl.min - Orders has no earliest-date floor at all
  // (confirmed live: any month/year is selectable in Amazon's own picker).
  // Constraining it based on toEl's current value would lock the calendar
  // widget out of ever navigating back past whatever toDate already holds,
  // which is exactly the bug this fixes: both fields start pre-filled with
  // recent dates, so a from<->to mutual bound trapped fromDate in the last
  // ~30 days with no way to reach an older month at all.
}

// The `max`/`min` attributes on <input type="date"> only constrain the
// calendar picker UI - they do nothing to stop a manually typed value,
// which just silently sits there out of range until something explicitly
// checks it (previously only the Sync click did). This clamps it back the
// moment a field commits a value, so typing an out-of-range date or a
// >30-day span is corrected immediately instead of only being caught on
// submit.
function clampDateInputs() {
  const maxDate = maxSelectableDate();
  const fromEl = $('fromDate');
  const toEl = $('toDate');
  const reasons = [];

  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  if (fromEl.value && toEl.value && rangeDays(fromEl.value, toEl.value) > MAX_RANGE_DAYS) {
    let newTo = addDays(fromEl.value, MAX_RANGE_DAYS - 1);
    if (newTo > maxDate) newTo = maxDate;
    toEl.value = newTo;
    reasons.push('Amazon only allows a 30-day range per request');
  }

  updateDateConstraints();
  if (reasons.length) {
    showFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('fromDate').addEventListener('change', clampDateInputs);
$('toDate').addEventListener('change', clampDateInputs);

$('sync').addEventListener('click', async () => {
  clearFormError();

  const fromDate = $('fromDate').value;
  const toDate = $('toDate').value;
  const zipName = $('zipName').value.trim() || `Amazon_Orders_${todayStamp()}`;

  const maxDate = maxSelectableDate();
  if (!fromDate || !toDate) { showFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showFormError('From date must be before the To date.'); return; }
  if (toDate > maxDate) { showFormError(`The latest selectable date is ${maxDate} (2 days ago) - Amazon delays generation to the next day for anything more recent.`); return; }
  if (rangeDays(fromDate, toDate) > MAX_RANGE_DAYS) { showFormError(`You can only request up to ${MAX_RANGE_DAYS} days at a time.`); return; }

  // Render immediately rather than waiting for the next 800ms poll tick -
  // background.js will overwrite this with its own progress within
  // milliseconds, but the button/"Processing..." state should never look
  // like nothing happened right after clicking.
  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: 'START_ORDER_SYNC', fromDate, toDate, zipName });
  } catch (_) {
    $('sync').disabled = false;
  }
});

// ── Tabs: Orders / Returns / Payments / B2B/B2C / Ads / Bulk ────────────────
function selectTab(tab) {
  $('tabOrdersBtn').classList.toggle('active', tab === 'orders');
  $('tabReturnsBtn').classList.toggle('active', tab === 'returns');
  $('tabPaymentsBtn').classList.toggle('active', tab === 'payments');
  $('tabGstBtn').classList.toggle('active', tab === 'gst');
  $('tabAdsBtn').classList.toggle('active', tab === 'ads');
  $('tabBulkBtn').classList.toggle('active', tab === 'bulk');
  $('ordersPanel').classList.toggle('active', tab === 'orders');
  $('returnsPanel').classList.toggle('active', tab === 'returns');
  $('paymentsPanel').classList.toggle('active', tab === 'payments');
  $('gstPanel').classList.toggle('active', tab === 'gst');
  $('adsPanel').classList.toggle('active', tab === 'ads');
  $('bulkPanel').classList.toggle('active', tab === 'bulk');
}
$('tabOrdersBtn').addEventListener('click', () => selectTab('orders'));
$('tabReturnsBtn').addEventListener('click', () => selectTab('returns'));
$('tabPaymentsBtn').addEventListener('click', () => selectTab('payments'));
$('tabGstBtn').addEventListener('click', () => selectTab('gst'));
$('tabAdsBtn').addEventListener('click', () => selectTab('ads'));
$('tabBulkBtn').addEventListener('click', () => selectTab('bulk'));

function showReturnsFormError(msg) {
  const el = $('returnsFormError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearReturnsFormError() {
  $('returnsFormError').style.display = 'none';
}

function updateReturnsDateConstraints() {
  const fromEl = $('returnsFromDate');
  const toEl = $('returnsToDate');

  if (isFbaReturnsType()) {
    const maxDate = maxFbaReturnsSelectableDate();
    toEl.max = maxDate;
    toEl.min = fromEl.value || '';
    fromEl.max = maxDate;
    fromEl.min = '';
    return;
  }

  const maxDate = maxReturnsSelectableDate();
  toEl.max = fromEl.value ? [addDays(fromEl.value, MAX_RETURNS_RANGE_DAYS - 1), maxDate].sort()[0] : maxDate;
  toEl.min = fromEl.value || '';
  fromEl.max = maxDate;
  // No fromEl.min here either - same fix as Orders, for the same reason.
}

function clampReturnsDateInputs() {
  const fromEl = $('returnsFromDate');
  const toEl = $('returnsToDate');
  const reasons = [];

  if (isFbaReturnsType()) {
    const maxDate = maxFbaReturnsSelectableDate();
    if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (today)`); }
    if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (today)`); }
    if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }
    updateReturnsDateConstraints();
    if (reasons.length) showReturnsFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
    return;
  }

  const maxDate = maxReturnsSelectableDate();
  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  if (fromEl.value && toEl.value && rangeDays(fromEl.value, toEl.value) > MAX_RETURNS_RANGE_DAYS) {
    let newTo = addDays(fromEl.value, MAX_RETURNS_RANGE_DAYS - 1);
    if (newTo > maxDate) newTo = maxDate;
    toEl.value = newTo;
    reasons.push(`Amazon only allows a ${MAX_RETURNS_RANGE_DAYS}-day range per request`);
  }

  updateReturnsDateConstraints();
  if (reasons.length) {
    showReturnsFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('returnsFromDate').addEventListener('change', clampReturnsDateInputs);
$('returnsToDate').addEventListener('change', clampReturnsDateInputs);

function updateReturnsTypeUI() {
  const fba = isFbaReturnsType();
  $('returnsCardTitle').textContent = fba ? 'FBA Customer Returns Report' : 'All Returns Report';
  $('returnsCardSub').textContent = fba
    ? "Pulls the FBA customer returns CSV from Seller Central's Fulfilment Reports and bundles it into one ZIP. No 60-day range limit."
    : "Pulls TSV return data from Seller Central's Return Reports page and bundles it into one ZIP.";
  $('returnsHelpNote').textContent = fba
    ? 'Needs the FBA customer returns report page (Fulfilment Reports → Customer Returns) open in this Seller Central tab.'
    : 'Needs the Return Reports page (Returns → Return Reports) open in this Seller Central tab.';
  $('returnsZipName').placeholder = fba ? 'Amazon_FBA_Returns' : 'Amazon_Returns';
  clampReturnsDateInputs();
}
$('returnsTypeStandard').addEventListener('change', updateReturnsTypeUI);
$('returnsTypeFba').addEventListener('change', updateReturnsTypeUI);

$('syncReturns').addEventListener('click', async () => {
  clearReturnsFormError();

  const fba = isFbaReturnsType();
  const fromDate = $('returnsFromDate').value;
  const toDate = $('returnsToDate').value;
  const zipName = $('returnsZipName').value.trim() || (fba ? `Amazon_FBA_Returns_${todayStamp()}` : `Amazon_Returns_${todayStamp()}`);

  if (!fromDate || !toDate) { showReturnsFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showReturnsFormError('From date must be before the To date.'); return; }

  if (fba) {
    const maxDate = maxFbaReturnsSelectableDate();
    if (toDate > maxDate) { showReturnsFormError(`The latest selectable date is ${maxDate} (today).`); return; }
  } else {
    const maxDate = maxReturnsSelectableDate();
    if (toDate > maxDate) { showReturnsFormError(`The latest selectable date is ${maxDate} (2 days ago).`); return; }
    if (rangeDays(fromDate, toDate) > MAX_RETURNS_RANGE_DAYS) { showReturnsFormError(`You can only request up to ${MAX_RETURNS_RANGE_DAYS} days at a time.`); return; }
  }

  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: fba ? 'START_FBA_RETURNS_SYNC' : 'START_RETURNS_SYNC', fromDate, toDate, zipName });
  } catch (_) {
    $('syncReturns').disabled = false;
  }
});

// Confirmed live: unlike Orders (30-day cap) and Returns (60-day cap),
// Amazon enforces no maximum date-range width for the Payments Transaction
// report - an 18+ month request was accepted and processed successfully.
// So no range-day cap here, just the same 2-days-back cutoff as the others
// for consistency (per direct instruction, not confirmed evidence of a
// generation-delay quirk on this specific endpoint).
function maxPaymentsSelectableDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  return isoDate(cutoff);
}

function showPaymentsFormError(msg) {
  const el = $('paymentsFormError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearPaymentsFormError() {
  $('paymentsFormError').style.display = 'none';
}

function updatePaymentsDateConstraints() {
  const maxDate = maxPaymentsSelectableDate();
  const fromEl = $('paymentsFromDate');
  const toEl = $('paymentsToDate');
  toEl.max = maxDate;
  toEl.min = fromEl.value || '';
  fromEl.max = maxDate;
}

function clampPaymentsDateInputs() {
  const maxDate = maxPaymentsSelectableDate();
  const fromEl = $('paymentsFromDate');
  const toEl = $('paymentsToDate');
  const reasons = [];

  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  updatePaymentsDateConstraints();
  if (reasons.length) {
    showPaymentsFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('paymentsFromDate').addEventListener('change', clampPaymentsDateInputs);
$('paymentsToDate').addEventListener('change', clampPaymentsDateInputs);

$('syncPayments').addEventListener('click', async () => {
  clearPaymentsFormError();

  const fromDate = $('paymentsFromDate').value;
  const toDate = $('paymentsToDate').value;
  const zipName = $('paymentsZipName').value.trim() || `Amazon_Payments_${todayStamp()}`;

  const maxDate = maxPaymentsSelectableDate();
  if (!fromDate || !toDate) { showPaymentsFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showPaymentsFormError('From date must be before the To date.'); return; }
  if (toDate > maxDate) { showPaymentsFormError(`The latest selectable date is ${maxDate} (2 days ago).`); return; }

  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: 'START_PAYMENTS_SYNC', fromDate, toDate, zipName });
  } catch (_) {
    $('syncPayments').disabled = false;
  }
});

// Confirmed live (GST On Demand Reports page's own note: "You can request
// report for any duration within the last 45 days") - unlike Orders/Returns,
// this cap is anchored to today, not a span cap between the two picked
// dates, and today itself IS a valid selectable date here (no 2-days-back
// cutoff) - per direct instruction, since GST reports don't share Orders'/
// Returns'/Payments' generation-delay quirk for recent dates.
const MAX_GST_LOOKBACK_DAYS = 45;
function maxGstSelectableDate() {
  return todayStamp();
}
function minGstSelectableDate() {
  return addDays(todayStamp(), -(MAX_GST_LOOKBACK_DAYS - 1));
}

function showGstFormError(msg) {
  const el = $('gstFormError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearGstFormError() {
  $('gstFormError').style.display = 'none';
}

function updateGstDateConstraints() {
  const minDate = minGstSelectableDate();
  const maxDate = maxGstSelectableDate();
  const fromEl = $('gstFromDate');
  const toEl = $('gstToDate');

  fromEl.min = minDate;
  fromEl.max = maxDate;
  toEl.min = fromEl.value || minDate;
  toEl.max = maxDate;
}

function clampGstDateInputs() {
  const minDate = minGstSelectableDate();
  const maxDate = maxGstSelectableDate();
  const fromEl = $('gstFromDate');
  const toEl = $('gstToDate');
  const reasons = [];

  if (fromEl.value && fromEl.value < minDate) { fromEl.value = minDate; reasons.push(`the earliest selectable date is ${minDate} (45 days back)`); }
  if (toEl.value && toEl.value < minDate) { toEl.value = minDate; reasons.push(`the earliest selectable date is ${minDate} (45 days back)`); }
  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (today)`); }
  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (today)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  updateGstDateConstraints();
  if (reasons.length) {
    showGstFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('gstFromDate').addEventListener('change', clampGstDateInputs);
$('gstToDate').addEventListener('change', clampGstDateInputs);

$('syncGst').addEventListener('click', async () => {
  clearGstFormError();

  const fromDate = $('gstFromDate').value;
  const toDate = $('gstToDate').value;
  const zipName = $('gstZipName').value.trim() || `Amazon_GST_${todayStamp()}`;
  const reportType = $('gstTypeB2B').checked ? $('gstTypeB2B').value : $('gstTypeB2C').value;
  const label = $('gstTypeB2B').checked ? 'B2B' : 'B2C';

  const minDate = minGstSelectableDate();
  const maxDate = maxGstSelectableDate();
  if (!fromDate || !toDate) { showGstFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showGstFormError('From date must be before the To date.'); return; }
  if (fromDate < minDate) { showGstFormError(`The earliest selectable date is ${minDate} (45 days back).`); return; }
  if (toDate > maxDate) { showGstFormError(`The latest selectable date is ${maxDate} (today).`); return; }

  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: 'START_GST_SYNC', reportType, label, fromDate, toDate, zipName });
  } catch (_) {
    $('syncGst').disabled = false;
  }
});

// Confirmed live: the Sponsored Products -> Search term report's own
// reportMetadata catalog entry gives maxLookBackDays: 65, and the real date
// picker's actual allowed range (19 May - 22 Jul, with 22 Jul = today) spans
// exactly 65 days ending on TODAY - so unlike Orders/Returns' floating span
// (which can slide to any past month), this is an ANCHORED window relative
// to today, same shape as GST's 45-day rule. The 2-days-back cutoff (instead
// of GST's "today is fine") is applied per direct instruction for
// consistency, not separately confirmed evidence of a generation-delay
// quirk on this specific endpoint.
const MAX_ADS_LOOKBACK_DAYS = 65;
function maxAdsSelectableDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  return isoDate(cutoff);
}
function minAdsSelectableDate() {
  return addDays(todayStamp(), -(MAX_ADS_LOOKBACK_DAYS - 1));
}

function showAdsFormError(msg) {
  const el = $('adsFormError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearAdsFormError() {
  $('adsFormError').style.display = 'none';
}

function updateAdsDateConstraints() {
  const minDate = minAdsSelectableDate();
  const maxDate = maxAdsSelectableDate();
  const fromEl = $('adsFromDate');
  const toEl = $('adsToDate');

  fromEl.min = minDate;
  fromEl.max = maxDate;
  toEl.min = fromEl.value || minDate;
  toEl.max = maxDate;
}

function clampAdsDateInputs() {
  const minDate = minAdsSelectableDate();
  const maxDate = maxAdsSelectableDate();
  const fromEl = $('adsFromDate');
  const toEl = $('adsToDate');
  const reasons = [];

  if (fromEl.value && fromEl.value < minDate) { fromEl.value = minDate; reasons.push(`the earliest selectable date is ${minDate} (65 days back)`); }
  if (toEl.value && toEl.value < minDate) { toEl.value = minDate; reasons.push(`the earliest selectable date is ${minDate} (65 days back)`); }
  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  updateAdsDateConstraints();
  if (reasons.length) {
    showAdsFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('adsFromDate').addEventListener('change', clampAdsDateInputs);
$('adsToDate').addEventListener('change', clampAdsDateInputs);

$('syncAds').addEventListener('click', async () => {
  clearAdsFormError();

  const fromDate = $('adsFromDate').value;
  const toDate = $('adsToDate').value;
  const zipName = $('adsZipName').value.trim() || `Amazon_Ads_${todayStamp()}`;

  const minDate = minAdsSelectableDate();
  const maxDate = maxAdsSelectableDate();
  if (!fromDate || !toDate) { showAdsFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showAdsFormError('From date must be before the To date.'); return; }
  if (fromDate < minDate) { showAdsFormError(`The earliest selectable date is ${minDate} (65 days back).`); return; }
  if (toDate > maxDate) { showAdsFormError(`The latest selectable date is ${maxDate} (2 days ago).`); return; }

  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: 'START_ADS_SYNC', fromDate, toDate, zipName });
  } catch (_) {
    $('syncAds').disabled = false;
  }
});

// ── Bulk: Orders + Payments + B2B/B2C in one pass ───────────────────────────
// Returns and Ads are deliberately left out for now - both need a specific
// Seller Central/Ads page open on the exact right tab (not just the right
// origin), which doesn't fit cleanly into "one shared date range, one shared
// tab" yet.
//
// The shared range's own ceiling is already the same "today - 2 days" cutoff
// Orders/Payments/GST each use individually, so Payments never needs to be
// grayed out here - only Orders (30-day span cap) and B2B/B2C (45-day
// lookback floor) can actually fall outside whatever range is picked.
function bulkOrdersFits(fromDate, toDate) {
  return rangeDays(fromDate, toDate) <= MAX_RANGE_DAYS;
}
function bulkGstFits(fromDate) {
  return fromDate >= minGstSelectableDate();
}
// Standard Returns caps at MAX_RETURNS_RANGE_DAYS; FBA Customer Returns has
// no span cap at all (confirmed live - see maxFbaReturnsSelectableDate above).
// Because FBA always fits, the Returns category as a whole should never be
// grayed out for range reasons - only the Standard radio option itself
// should be disabled (with an automatic fallback to FBA) when the picked
// range is too wide for Standard specifically.
function bulkStandardReturnsFits(fromDate, toDate) {
  return rangeDays(fromDate, toDate) <= MAX_RETURNS_RANGE_DAYS;
}

function showBulkFormError(msg) {
  const el = $('bulkFormError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearBulkFormError() {
  $('bulkFormError').style.display = 'none';
}

function updateBulkDateConstraints() {
  const maxDate = maxSelectableDate();
  const fromEl = $('bulkFromDate');
  const toEl = $('bulkToDate');
  fromEl.max = maxDate;
  toEl.max = maxDate;
  toEl.min = fromEl.value || '';
  // No fromEl.min - none of Orders/Payments/GST have an earliest-date floor
  // that's independent of today, so the calendar widget should never be
  // blocked from navigating to an older month.
}

// Grays out (and unchecks) whichever checkbox doesn't fit the currently
// picked range, rather than letting the user select a combination that
// would just fail once the sync actually tries it.
// Keeps a ds-card's visual (filled checkbox, orange border) in sync with
// its real <input>, since toggling .checked/.disabled in JS doesn't touch
// the wrapping label's own classes automatically.
function syncDsCardVisual(cardEl, inputEl) {
  cardEl.classList.toggle('checked', inputEl.checked);
  cardEl.classList.toggle('disabled', inputEl.disabled);
}

function updateBulkAvailability() {
  const fromDate = $('bulkFromDate').value;
  const toDate = $('bulkToDate').value;
  const ordersEl = $('bulkOrders');
  const gstEl = $('bulkGst');
  const returnsEl = $('bulkReturns');
  const note = $('bulkAvailabilityNote');
  const reasons = [];

  const ordersOk = !fromDate || !toDate || bulkOrdersFits(fromDate, toDate);
  ordersEl.disabled = !ordersOk;
  if (!ordersOk) { ordersEl.checked = false; reasons.push(`Orders needs a ${MAX_RANGE_DAYS}-day span or less`); }
  syncDsCardVisual($('bulkOrdersCard'), ordersEl);

  const gstOk = !fromDate || bulkGstFits(fromDate);
  gstEl.disabled = !gstOk;
  if (!gstOk) { gstEl.checked = false; reasons.push(`B2B/B2C only supports the last ${MAX_GST_LOOKBACK_DAYS} days`); }
  syncDsCardVisual($('bulkGstCard'), gstEl);

  // FBA Customer Returns has no range cap, so Returns as a category is never
  // grayed out for range reasons - only the Standard option can fall outside
  // the picked range, and if it does while selected, fall back to FBA
  // automatically rather than disabling the whole tile out from under the user.
  const standardFits = !fromDate || !toDate || bulkStandardReturnsFits(fromDate, toDate);
  const standardTypeEl = $('bulkReturnsTypeStandard');
  const fbaTypeEl = $('bulkReturnsTypeFba');
  standardTypeEl.disabled = !returnsEl.checked || !standardFits;
  fbaTypeEl.disabled = !returnsEl.checked;
  if (!standardFits && standardTypeEl.checked) {
    standardTypeEl.checked = false;
    fbaTypeEl.checked = true;
    reasons.push(`Standard Returns needs a ${MAX_RETURNS_RANGE_DAYS}-day span or less, so switched to FBA Customer Returns for this range`);
  }
  syncDsCardVisual($('bulkReturnsCard'), returnsEl);

  syncDsCardVisual($('bulkPaymentsCard'), $('bulkPayments'));

  $('bulkGstTypeB2B').disabled = !gstEl.checked;
  $('bulkGstTypeB2C').disabled = !gstEl.checked;

  if (reasons.length) {
    note.textContent = `Grayed out for this range - ${reasons.join('; ')}.`;
    note.style.display = 'block';
  } else {
    note.style.display = 'none';
  }
}

function clampBulkDateInputs() {
  const maxDate = maxSelectableDate();
  const fromEl = $('bulkFromDate');
  const toEl = $('bulkToDate');
  const reasons = [];

  if (fromEl.value && fromEl.value > maxDate) { fromEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (toEl.value && toEl.value > maxDate) { toEl.value = maxDate; reasons.push(`the latest selectable date is ${maxDate} (2 days ago)`); }
  if (fromEl.value && toEl.value && fromEl.value > toEl.value) { fromEl.value = toEl.value; reasons.push("the From date can't be after the To date"); }

  updateBulkDateConstraints();
  updateBulkAvailability();
  if (reasons.length) {
    showBulkFormError(`Dates adjusted automatically - ${[...new Set(reasons)].join('; ')}.`);
  }
}
$('bulkFromDate').addEventListener('change', clampBulkDateInputs);
$('bulkToDate').addEventListener('change', clampBulkDateInputs);
$('bulkOrders').addEventListener('change', () => syncDsCardVisual($('bulkOrdersCard'), $('bulkOrders')));
$('bulkPayments').addEventListener('change', () => syncDsCardVisual($('bulkPaymentsCard'), $('bulkPayments')));
$('bulkGst').addEventListener('change', () => {
  syncDsCardVisual($('bulkGstCard'), $('bulkGst'));
  $('bulkGstTypeB2B').disabled = !$('bulkGst').checked;
  $('bulkGstTypeB2C').disabled = !$('bulkGst').checked;
});
$('bulkReturns').addEventListener('change', updateBulkAvailability);
$('bulkReturnsTypeStandard').addEventListener('change', updateBulkAvailability);
$('bulkReturnsTypeFba').addEventListener('change', updateBulkAvailability);

$('syncBulk').addEventListener('click', async () => {
  clearBulkFormError();

  const fromDate = $('bulkFromDate').value;
  const toDate = $('bulkToDate').value;
  const zipName = $('bulkZipName').value.trim() || `Amazon_Bulk_${todayStamp()}`;
  const maxDate = maxSelectableDate();

  if (!fromDate || !toDate) { showBulkFormError('Pick a date range first.'); return; }
  if (fromDate > toDate) { showBulkFormError('From date must be before the To date.'); return; }
  if (toDate > maxDate) { showBulkFormError(`The latest selectable date is ${maxDate} (2 days ago).`); return; }

  const categories = [];
  if ($('bulkOrders').checked && !$('bulkOrders').disabled) categories.push('orders');
  if ($('bulkPayments').checked) categories.push('payments');
  if ($('bulkGst').checked && !$('bulkGst').disabled) categories.push('gst');
  if ($('bulkReturns').checked && !$('bulkReturns').disabled) {
    categories.push($('bulkReturnsTypeFba').checked ? 'fbaReturns' : 'returns');
  }

  if (!categories.length) { showBulkFormError('Pick at least one report type.'); return; }

  const gstReportType = $('bulkGstTypeB2B').checked ? $('bulkGstTypeB2B').value : $('bulkGstTypeB2C').value;
  const gstLabel = $('bulkGstTypeB2B').checked ? 'B2B' : 'B2C';

  render({ active: true, total: 0, done: 0, failed: 0, failures: [], current: 'Starting sync...', finished: false, error: null, paused: false, cancelled: false });
  try { await chrome.storage.local.remove('syncProgress'); } catch (_) {}
  try {
    await chrome.runtime.sendMessage({ type: 'START_BULK_SYNC', categories, fromDate, toDate, gstReportType, gstLabel, zipName });
  } catch (_) {
    $('syncBulk').disabled = false;
  }
});

$('pauseResumeBtn').addEventListener('click', async () => {
  let syncProgress;
  try { ({ syncProgress } = await chrome.storage.local.get('syncProgress')); } catch (_) {}
  const type = syncProgress?.paused ? 'RESUME_SYNC' : 'PAUSE_SYNC';
  try { await chrome.runtime.sendMessage({ type }); } catch (_) {}
});

$('cancelBtn').addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'CANCEL_SYNC' }); } catch (_) {}
});

async function initMainApp() {
  const maxDate = maxSelectableDate();
  const past = new Date();
  past.setDate(past.getDate() - 8); // last 7 days back from maxSelectableDate, inclusive
  $('fromDate').value = isoDate(past);
  $('toDate').value = maxDate;
  updateDateConstraints();
  $('zipName').value = `Amazon_Orders_${todayStamp()}`;

  const returnsMaxDate = maxReturnsSelectableDate();
  const returnsPast = new Date();
  returnsPast.setDate(returnsPast.getDate() - 8); // last 7 days back from maxReturnsSelectableDate, inclusive
  $('returnsFromDate').value = isoDate(returnsPast);
  $('returnsToDate').value = returnsMaxDate;
  updateReturnsTypeUI();
  $('returnsZipName').value = `Amazon_Returns_${todayStamp()}`;

  const paymentsMaxDate = maxPaymentsSelectableDate();
  const paymentsPast = new Date();
  paymentsPast.setDate(paymentsPast.getDate() - 8); // last 7 days back from maxPaymentsSelectableDate, inclusive
  $('paymentsFromDate').value = isoDate(paymentsPast);
  $('paymentsToDate').value = paymentsMaxDate;
  updatePaymentsDateConstraints();
  $('paymentsZipName').value = `Amazon_Payments_${todayStamp()}`;

  const gstMaxDate = maxGstSelectableDate();
  const gstMinDate = minGstSelectableDate();
  $('gstFromDate').value = gstMinDate;
  $('gstToDate').value = gstMaxDate;
  updateGstDateConstraints();
  $('gstZipName').value = `Amazon_GST_${todayStamp()}`;

  const adsMaxDate = maxAdsSelectableDate();
  const adsMinDate = minAdsSelectableDate();
  $('adsFromDate').value = adsMinDate;
  $('adsToDate').value = adsMaxDate;
  updateAdsDateConstraints();
  $('adsZipName').value = `Amazon_Ads_${todayStamp()}`;

  const bulkMaxDate = maxSelectableDate();
  const bulkPast = new Date();
  bulkPast.setDate(bulkPast.getDate() - 8); // last 7 days back from bulkMaxDate, inclusive - fits Orders/GST both by default
  $('bulkFromDate').value = isoDate(bulkPast);
  $('bulkToDate').value = bulkMaxDate;
  updateBulkDateConstraints();
  updateBulkAvailability();
  $('bulkZipName').value = `Amazon_Bulk_${todayStamp()}`;

  // A finished result (success or error) from a previous session should never
  // resurface just because the popup was reopened - only an in-progress sync
  // (finished === false) is worth showing on open.
  try {
    const { syncProgress } = await chrome.storage.local.get('syncProgress');
    if (syncProgress?.finished) await chrome.storage.local.remove('syncProgress');
  } catch (_) {}

  await refresh();
  setInterval(refresh, 800);
  setInterval(pollNow, 4000);
}

// ── Auth: gate the whole app behind a Speed Ecom account ────────────────────
async function getAuth() {
  try { const { auth } = await chrome.storage.local.get('auth'); return auth || null; } catch (_) { return null; }
}

function initials(name, email) {
  const s = (name || email || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function showUserBar(user) {
  const name = user?.name || null;
  const email = user?.email || null;
  const tenant = user?.tenant || null;
  $('userAvatar').textContent = initials(tenant || name, email);
  const tenantEl = $('userTenant');
  const nameEl = $('userName');
  if (tenant) {
    // Tenant (the seller/company registered with SpeedEcom) is what's worth
    // showing - the personal login name (e.g. "demo1") is redundant/less
    // meaningful once it's on screen, so it's dropped rather than shown twice.
    tenantEl.textContent = tenant;
    tenantEl.style.display = 'block';
    nameEl.style.display = 'none';
  } else {
    tenantEl.textContent = '';
    tenantEl.style.display = 'none';
    nameEl.style.display = 'block';
    nameEl.textContent = name || email || 'Signed in';
  }
  $('userEmail').textContent = email || '';
  $('userBar').style.display = 'flex';
}

function showLoginView() {
  $('loginView').style.display = 'block';
  $('mainView').style.display = 'none';
  $('userBar').style.display = 'none';
}

function showMainView() {
  $('loginView').style.display = 'none';
  $('mainView').style.display = 'block';
}

async function doLogin() {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  const err = $('loginError');
  err.style.display = 'none';

  if (!email || !password) {
    err.textContent = 'Enter both email and password.';
    err.style.display = 'block';
    return;
  }

  $('loginBtn').disabled = true;
  const label = $('loginBtn').lastChild;
  label.textContent = 'Signing in…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AUTH_LOGIN', email, password });
    if (resp?.ok) {
      $('loginPassword').value = '';
      showUserBar(resp.user || {});
      showMainView();
      initMainApp();
    } else {
      err.textContent = resp?.error || 'Login failed.';
      err.style.display = 'block';
    }
  } catch (_) {
    err.textContent = 'Could not reach the login server.';
    err.style.display = 'block';
  } finally {
    $('loginBtn').disabled = false;
    label.textContent = 'Login';
  }
}

$('loginBtn').addEventListener('click', doLogin);
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

$('pwToggle').addEventListener('click', () => {
  const input = $('loginPassword');
  const btn = $('pwToggle');
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  btn.classList.toggle('showing', showing);
  btn.title = showing ? 'Hide password' : 'Show password';
  btn.setAttribute('aria-label', btn.title);
});

async function doLogout() {
  try { await chrome.storage.local.remove('auth'); } catch (_) {}
  $('loginEmail').value = '';
  $('loginPassword').value = '';
  $('loginError').style.display = 'none';
  showLoginView();
}

$('logoutBtn').addEventListener('click', doLogout);

$('footerYear').textContent = String(new Date().getFullYear());

// ── Bootstrap: gate the whole app behind sign-in ────────────────────────────
(async () => {
  const auth = await getAuth();
  if (!auth?.token) {
    showLoginView();
    return;
  }

  showUserBar(auth.user || {});
  showMainView();
  await initMainApp();

  // Best-effort background refresh of the displayed profile. Failures here
  // are silently ignored - they must never sign the user out.
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AUTH_REFRESH_PROFILE' });
    if (resp?.ok && resp.user) showUserBar(resp.user);
  } catch (_) {}
})();
