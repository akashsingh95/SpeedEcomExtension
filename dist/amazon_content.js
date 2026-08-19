(() => {
  'use strict';

  // background.js's ensureContentScript() re-injects this file via
  // chrome.scripting.executeScript whenever a ping fails - without this
  // guard, re-injecting into a tab that already has a (possibly stale, from
  // before an extension reload) instance running would register a second,
  // independent onMessage listener. Two listeners answering the same message
  // is exactly what causes "message port closed before a response was
  // received": the port closes as soon as one responds, and the other's
  // response then has nowhere to go. (Same bug, same fix, as the Myntra
  // extension.)
  if (window.__amazonSyncContentLoaded) {
    console.warn('[amazon-sync:content] blocked a duplicate injection - a listener from an earlier load is already active in this tab.');
    return;
  }
  window.__amazonSyncContentLoaded = true;

  const TAG = '[amazon-sync:content]';
  console.log(TAG, 'loaded at', location.href);

  // Runs in the page's own origin (sellercentral.amazon.in) so fetch()
  // carries the seller's real session cookies - same reasoning as Myntra's
  // relay. Unlike Myntra though, every one of these calls is same-origin
  // (the content script and the API both live on sellercentral.amazon.in),
  // so there's no CORS complexity at all here - relative URLs and
  // credentials:'same-origin' just work.

  // Confirmed from a real captured request: reportVersion/includeSalesChannel
  // are fixed values the page itself always sends for this exact flow
  // (All Orders -> Order Date -> Exact dates), not something the caller
  // chooses - only startDate/endDate vary.
  async function scheduleOrderReport({ startDate, endDate }) {
    const res = await fetch('/order-reports-and-feeds/api/v1/reportRequest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'allOrdersReport',
        startDate,
        endDate,
        includeSalesChannel: null,
        reportVersion: 'orderDateVersion',
      }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // Generic list of every "All Orders" report batch (any status) - used to
  // poll a freshly requested one until it's Ready or has no data.
  async function fetchOrderReportStatus() {
    const res = await fetch('/order-reports-and-feeds/api/reportStatus?type=allOrdersReport', {
      credentials: 'same-origin',
      headers: { accept: '*/*' },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // documentMetadata returns the actual file bytes directly (Content-Disposition:
  // attachment, zstd-encoded - Chrome decompresses this transparently, same as
  // gzip/br, so res.arrayBuffer() already gives the real bytes). No redirect,
  // no separate blob host, unlike Myntra's report files - much simpler here.
  // Bytes are base64-encoded across the message boundary since
  // chrome.runtime message payloads need to be JSON-compatible, not a raw
  // ArrayBuffer.
  async function fetchOrderReportFile(referenceId) {
    const url = `/order-reports-and-feeds/api/documentMetadata?referenceId=${encodeURIComponent(referenceId)}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: '*/*' } });
    if (!res.ok) return { status: res.status, base64: null, filename: null };
    const disposition = res.headers.get('content-disposition') || '';
    const m = disposition.match(/filename="?([^";]+)"?/i);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { status: res.status, base64: btoa(binary), filename: m ? m[1] : null };
  }

  // ── Returns: /returns/report/generate|list|download ────────────────────
  // Unlike Orders, this endpoint requires a csrfToken - confirmed (after
  // exhausting every static search: DOM, page source, loaded JS, cookies,
  // sessionStorage, localStorage, network response bodies) to live in a
  // plain hidden input, read by the page's own code as:
  //   d.csrfToken = b("#returns-report-csrf-token").val();
  // (ManageYourReturnsUIAssets bundle, requestAdhocReport function). That
  // input only exists on the Return Reports page itself, so this returns
  // null if the active tab isn't actually on it.
  function getReturnsCsrfToken() {
    return document.querySelector('#returns-report-csrf-token')?.value || null;
  }

  // Confirmed live via a captured real submission: form-urlencoded (not
  // JSON), MM/DD/YYYY dates, and a response that's just an HTML "SUCCESS"
  // page with no report id in it at all - unlike Orders' reportRequest,
  // there's nothing here to track a specific new report by, which is why
  // background.js has to diff the report list before/after this call
  // instead of following one id end to end.
  async function scheduleReturnsReport({ fromDate, toDate, csrfToken }) {
    const body = new URLSearchParams({
      fromDate, toDate, reportDateRange: 'exactDates', reportType: 'RETURNS', csrfToken,
    });
    const res = await fetch('/returns/report/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'text/html,*/*', 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
      body: body.toString(),
    });
    return { status: res.status };
  }

  // /returns/report/list responds with a server-rendered HTML fragment (a
  // legacy page, not a JSON API like Orders' reportStatus) - DOMParser only
  // exists in a real page/DOM context, which is exactly why this parsing has
  // to happen here in content.js rather than in the background service
  // worker. Each .reportRequestRecord block covers one request; XML and TSV
  // are tracked as two independent columns since Amazon generates and
  // completes them separately (confirmed live - one can show "In progress"
  // while the other is already "Ready").
  function parseReturnsList(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const records = [];
    doc.querySelectorAll('.reportRequestRecord').forEach((rec) => {
      const topCols = rec.querySelectorAll(':scope > .a-row > .a-column');
      if (topCols.length < 4) return;

      const typeText = (topCols[0].childNodes[0]?.textContent || topCols[0].textContent || '').trim();
      const dateRangeText = topCols[1].textContent.replace(/\s+/g, ' ').trim();
      const dateMatch = dateRangeText.match(/(\d{2}-[A-Za-z]{3}-\d{4})\s*to\s*(\d{2}-[A-Za-z]{3}-\d{4})/);
      const requestedOn = topCols[2].textContent.replace(/\s+/g, ' ').trim();
      const formatCols = topCols[3].querySelectorAll(':scope > .a-row > .a-column');

      const parseFormatStatus = (col) => {
        if (!col) return { status: 'unknown' };
        const link = col.querySelector('a[href]');
        if (link) return { status: 'ready', url: link.getAttribute('href') };
        const text = col.textContent.replace(/\s+/g, ' ').trim();
        if (/no records/i.test(text)) return { status: 'no_records' };
        return { status: 'in_progress' };
      };

      records.push({
        type: typeText,
        dateRangeStart: dateMatch ? dateMatch[1] : null,
        dateRangeEnd: dateMatch ? dateMatch[2] : null,
        requestedOn,
        xml: parseFormatStatus(formatCols[0]),
        tsv: parseFormatStatus(formatCols[1]),
      });
    });
    return records;
  }

  async function fetchReturnsList() {
    const res = await fetch('/returns/report/list', {
      credentials: 'same-origin',
      headers: { accept: 'text/html,*/*', 'x-requested-with': 'XMLHttpRequest' },
    });
    const html = await res.text();
    return { status: res.status, records: parseReturnsList(html) };
  }

  // The download URL comes pre-built directly out of the list HTML's own
  // <a href> (report id + documentId + format all embedded already) - no
  // separate resolve step needed, unlike Orders. No CSRF token required for
  // this GET either.
  async function fetchReturnsFile(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: '*/*' } });
    if (!res.ok) return { status: res.status, base64: null };
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { status: res.status, base64: btoa(binary) };
  }

  // ── Payments: /payments/reports/api/request-report|report|download-report ──
  // The cleanest of the three so far - plain JSON, no CSRF token, and the
  // schedule response hands back a real reportId directly (like Orders,
  // unlike Returns). startDate/endDate are epoch ms in IST (marketplace
  // timezone), alongside separate ISO string fields the page also sends -
  // confirmed live from a real captured request/response pair.
  async function schedulePaymentsReport({ fromDate, toDate }) {
    const startDate = new Date(`${fromDate}T00:00:00+05:30`).getTime();
    const endDate = new Date(`${toDate}T23:59:59.999+05:30`).getTime();
    const res = await fetch('/payments/reports/api/request-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
      body: JSON.stringify({
        accountType: 'ALL',
        reportType: 'SELLER_TRANSACTION_DATE_RANGE',
        startDate,
        endDate,
        startDateISO: `${fromDate}T00:00:00+05:30`,
        endDateISO: `${toDate}T23:59:59+05:30`,
        timeRangeType: 'CUSTOM',
      }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // Per-report status check (like Orders' reportStatus, not a list to diff
  // like Returns) - status moves SCHEDULED -> ... -> DOWNLOADABLE.
  async function fetchPaymentsReportStatus(reportId) {
    const url = `/payments/reports/api/report?reportId=${encodeURIComponent(reportId)}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json, text/plain, */*' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  async function fetchPaymentsReportFile(reportId) {
    const url = `/payments/reports/api/download-report?reportId=${encodeURIComponent(reportId)}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: '*/*' } });
    if (!res.ok) return { status: res.status, base64: null, filename: null };
    const disposition = res.headers.get('content-disposition') || '';
    const m = disposition.match(/filename="([^"]+)"(?!\*)/i) || disposition.match(/filename="?([^";]+)"?/i);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { status: res.status, base64: btoa(binary), filename: m ? m[1] : null };
  }

  // ── GST On Demand Reports (B2B/B2C): /fba/gstreports/create-report|report-history|ondemand-download ──
  // Confirmed live via network capture + fetch/XHR/anchor-click interception
  // (create-report's own response is a bare 204, no id at all - the download
  // click itself never touches fetch/XHR/window.open, only a synthetic
  // <a>.click() built from data already in the report-history poll response).
  // reportType is the numeric code the real UI's radios map to - "59300" for
  // B2B, "61200" for B2C - and startDate/endDate are epoch ms, same shape as
  // Payments' schedule call.
  async function scheduleGstReport({ reportType, startDate, endDate }) {
    const res = await fetch('/fba/gstreports/create-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
      body: JSON.stringify({ reportType, startDate, endDate }),
    });
    return { status: res.status };
  }

  // Plain JSON (unlike Returns' HTML list) - reportMetadataList entries carry
  // reportType, dateRangeCovered:[start,end], dateRequested, dateCompleted,
  // reportStatus ("InQueue"/"InProgress"/"Done"), and reportDocumentId (only
  // once Done).
  async function fetchGstReportList() {
    const res = await fetch('/fba/gstreports/report-history', {
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*' },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // The real Download link builds this exact URL from data it already has in
  // memory from report-history (documentId + the displayed date-range-covered
  // string + reportType) - confirmed live from the intercepted synthetic
  // anchor's href. dateRangeCovered must be passed through verbatim (the
  // "YYYY/MM/DD hh:mm:ss AM/PM IST - YYYY/MM/DD hh:mm:ss AM/PM IST" string
  // from the matched report-history entry), not recomputed here.
  // dateRangeCovered is optional - confirmed live this same endpoint also
  // directly serves a GST Monthly Reports documentId with no
  // dateRangeCovered at all (Monthly's own metadata call never returns one).
  async function fetchGstReportFile({ documentId, dateRangeCovered, reportType }) {
    const params = new URLSearchParams({ documentId, reportType });
    if (dateRangeCovered) params.set('dateRangeCovered', dateRangeCovered);
    const url = `/fba/gstreports/ondemand-download?${params.toString()}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: '*/*' } });
    if (!res.ok) return { status: res.status, base64: null, filename: null };
    const disposition = res.headers.get('content-disposition') || '';
    const m = disposition.match(/filename="?([^";]+)"?/i);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { status: res.status, base64: btoa(binary), filename: m ? m[1] : null };
  }

  // ── GST Monthly Reports: /fba/gstreports/monthly-metadata ──────────────
  // Same /fba/gstreports/* app as On Demand above, but these reports are
  // pre-generated by Amazon (available on the 5th of the following month)
  // rather than scheduled on request - confirmed live the metadata call
  // itself already comes back reportStatus:"Done" immediately when a report
  // exists, no create/poll step at all. When no report exists for that exact
  // combination, every field (including reportStatus) comes back null
  // instead of an HTTP error - that's the real "no report available" signal
  // (matches the page's own "Sorry you do not have any reports available
  // for the current selection" message). reportType codes are Monthly's own,
  // different from On Demand's 59300/61200 - confirmed live MTR B2B = 41200,
  // MTR B2C = 39400 (STR is out of scope, same as On Demand above).
  // Downloading reuses fetchGstReportFile above - confirmed live the same
  // ondemand-download endpoint serves a monthly documentId with no
  // dateRangeCovered needed.
  async function fetchMonthlyGstMetadata({ reportType, month, year }) {
    const url = `/fba/gstreports/monthly-metadata?reportType=${encodeURIComponent(reportType)}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  // ── FBA Customer Returns: /reportcentral/api/v1/submitDownloadReport|getDownloadReportStatus|downloadFile ──
  // A completely different engine from /returns/report/* above - this is
  // Amazon's generic "Report Central" API (reportFRPId 2610 selects the
  // Customer Returns report specifically). Confirmed live via network
  // capture:
  // 1. The CSRF header (anti-csrftoken-a2z) is a static per-session value
  //    rendered server-side into a <meta name="anti-csrftoken-a2z"> tag in
  //    <head> - unlike Returns' hidden input, no page-specific DOM query
  //    needed beyond the meta tag always being present on this page.
  // 2. submitDownloadReport's own response carries the reportReferenceId
  //    directly (like Orders/Payments, unlike Returns/GST) - no snapshot/
  //    diff polling needed.
  // 3. getDownloadReportStatus returns a JSON array (not an object) since it
  //    supports batch-polling multiple referenceIds at once - status moves
  //    InQueue -> InProgress -> Done.
  // 4. downloadFile 303-redirects to a second same-origin URL
  //    (/listing/downloadfile?...) that actually serves the CSV bytes -
  //    fetch() follows that redirect transparently by default, so this
  //    needs no special handling beyond a normal GET.
  function getA2zCsrfToken() {
    return document.querySelector('meta[name="anti-csrftoken-a2z"]')?.content || null;
  }

  const FBA_RETURNS_REPORT_FRP_ID = 2610;

  async function submitFbaReturnsReport({ reportStartDate, reportEndDate, csrfToken }) {
    const params = new URLSearchParams({
      reportFileFormat: 'CSV',
      reportStartDate,
      reportEndDate,
      xdaysBeforeUntilToday: '-1',
      startDateTimeOffset: '0',
      endDateTimeOffset: '0',
      specialDateOptions: '',
      reportFRPId: String(FBA_RETURNS_REPORT_FRP_ID),
      language: '',
      disableTimezone: 'true',
    });
    const res = await fetch(`/reportcentral/api/v1/submitDownloadReport?${params.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*', 'anti-csrftoken-a2z': csrfToken },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  async function fetchFbaReturnsStatus({ referenceId, csrfToken }) {
    const url = `/reportcentral/api/v1/getDownloadReportStatus?referenceIds=${encodeURIComponent(referenceId)}`;
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: '*/*', 'anti-csrftoken-a2z': csrfToken },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, body };
  }

  async function fetchFbaReturnsFile(referenceId) {
    const url = `/reportcentral/api/v1/downloadFile?referenceId=${encodeURIComponent(referenceId)}&fileFormat=CSV`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: '*/*' } });
    if (!res.ok) return { status: res.status, base64: null, filename: null };
    const disposition = res.headers.get('content-disposition') || '';
    const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    const filename = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : null);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { status: res.status, base64: btoa(binary), filename };
  }

  // ── Sponsored Ads Reports: advertising.amazon.in/reports/api/subscriptions/* ──
  // A completely different origin from everything above (advertising.amazon.in,
  // not sellercentral.amazon.in) - confirmed live via network capture, a
  // failed static-string CSRF search (twice), and finally a real breakpoint
  // set inside axios's own xhr.js adapter to walk the call stack back to
  // where the app's shared HTTP client (base.ts) actually builds it:
  //   const csrfToken = document.getElementsByName('csrf-token')[0].value;
  // Same "plain DOM element, wrong search string the first few times" lesson
  // as Returns' csrf token and FBA Returns' meta tag - just a `name=` attribute
  // this time, not `id=` or a <meta>.
  //
  // entityId is read from the tab's own URL (?entityId=...), not from
  // window.AppContext.entityId the way the page's own code does it - content
  // scripts run in an isolated JS world that shares the DOM with the page but
  // NOT its global variables, so window.AppContext is invisible here even
  // though the DOM (and therefore document.getElementsByName) is shared.
  // marketplaceIds is a fixed Amazon-wide constant for the India marketplace
  // (not seller-specific), safe to hard-code like the other fixed report-shape
  // fields below.
  function getAdsCsrfToken() {
    return document.getElementsByName('csrf-token')[0]?.value || null;
  }

  function getAdsEntityId() {
    return new URLSearchParams(location.search).get('entityId');
  }

  const ADS_MARKETPLACE_ID = 'A21TJRUUN4KGV';

  // Three report shapes, one per category the seller wants (Sponsored TV
  // excluded by direct instruction) - each confirmed live via a full
  // request-payload capture of a real create-report submission (Run report
  // -> Network tab -> Copy as cURL), unaffected by which dates are picked.
  // columns/translationsMap are entirely different per shape, not just a
  // different subset of one shared list - notably Sponsored Display's use
  // snake_case field names (first_timestamp, portfolio_name, ...) where the
  // other two use camelCase - so each is kept as its own fully independent,
  // literally-captured payload rather than trying to derive one from
  // another. reportPeriod becomes "CUSTOM" for a real date range (vs. a
  // named preset like "LAST_30_DAYS", which is what these were captured
  // with) - confirmed live earlier for the Search Term report (same app,
  // same shape) by capturing the same call with a manually-picked date
  // range instead of a preset.
  const ADS_REPORT_SHAPES = {
    // Sponsored Products -> Advertised product
    sp: {
      reportName: 'Sponsored Products Advertised product report',
      reportType: 'adProducts',
      reportCategoryId: 'sp',
      filterTypes: ['marketplaceIds', 'mrcAccreditationStatus'],
      columns: [
        'startDate', 'endDate', 'portfolioName', 'campaignBudgetCurrencyCode', 'campaignName',
        'adGroupName', 'marketplaceId', 'advertisedSku', 'advertisedAsin', 'impressions',
        'clicks', 'clickThroughRate', 'costPerClick', 'spend', 'sales7d', 'acosClicks7d',
        'roasClicks7d', 'purchases7d', 'unitsSoldClicks7d', 'purchaseClickRate7d',
        'unitsSoldSameSku7d', 'unitsSoldOtherSku7d', 'attributedSalesSameSku7d', 'salesOtherSku7d',
      ],
      translationsMap: {
        startDate: 'Start Date', endDate: 'End Date', portfolioName: 'portfolioName',
        campaignBudgetCurrencyCode: 'Currency - not converted', campaignName: 'Campaign Name',
        adGroupName: 'Ad Group Name', marketplaceId: 'marketplaceId', advertisedSku: 'advertisedSku',
        advertisedAsin: 'advertisedAsin', impressions: 'Impressions',
        clicks: 'Clicks', clickThroughRate: 'clickThroughRate', costPerClick: 'costPerClick',
        spend: 'Spend', sales7d: '7 Day Total Sales - not converted', acosClicks7d: 'acosClicks7d',
        roasClicks7d: 'roasClicks7d', purchases7d: 'purchases7d', unitsSoldClicks7d: 'unitsSoldClicks7d',
        purchaseClickRate7d: 'purchaseClickRate7d', unitsSoldSameSku7d: 'unitsSoldSameSku7d',
        unitsSoldOtherSku7d: 'unitsSoldOtherSku7d', attributedSalesSameSku7d: 'attributedSalesSameSku7d',
        salesOtherSku7d: 'salesOtherSku7d',
      },
    },
    // Sponsored Brands -> Campaign
    hsa: {
      reportName: 'Sponsored Brands Campaign report',
      reportType: 'campaigns',
      reportCategoryId: 'hsa',
      filterTypes: ['marketplaceIds'],
      columns: [
        'startDate', 'endDate', 'portfolioName', 'campaignBudgetCurrencyCode', 'campaignName', 'costType',
        'marketplaceId', 'impressions', 'clicks', 'clickThroughRate', 'costPerClick', 'spend',
        'totalAcos14d', 'totalRoas14d', 'totalSales14d', 'purchaseCount14d', 'totalUnitsSold14d',
        'purchaseClickRate14d', 'viewableImpressions', 'vcpm', 'vtr', 'vctr',
        'richMediaEvent68Count', 'richMediaEvent70Count', 'richMediaEvent78Count', 'richMediaEvent66Count',
        'richMediaEvent79Count', 'richMediaEvent8193Count', 'video5SecondViewRate', 'brandSearchCount14d',
        'totalDpvCount14d', 'newToBrandPurchases', 'newToBrandPurchasesPercentage', 'newToBrandSales',
        'newToBrandSalesPercentage', 'newToBrandUnitsSold', 'newToBrandUnitsSoldPercentage',
        'newToBrandPurchasesRate', 'acosClicks14d', 'roasClicks14d', 'sales14d', 'purchases14d',
        'unitsSoldClicks14d', 'newToBrandDetailPageViews', 'newToBrandDetailPageViewClicks',
        'newToBrandDetailPageViewRate', 'newToBrandECPDetailPageView', 'brandStorePageView', 'addToCart',
        'addToCartClicks', 'addToCartRate', 'eCPAddToCart', 'brandedSearchesClicks', 'brandedSearchRate',
        'eCPBrandSearch', 'longTermSales', 'longTermROAS',
      ],
      translationsMap: {
        startDate: 'Start Date', endDate: 'End Date', portfolioName: 'portfolioName',
        campaignBudgetCurrencyCode: 'Currency - not converted', campaignName: 'Campaign Name',
        costType: 'costType', marketplaceId: 'marketplaceId', impressions: 'Impressions', clicks: 'Clicks',
        clickThroughRate: 'clickThroughRate', costPerClick: 'costPerClick', spend: 'Spend',
        totalAcos14d: 'totalAcos14d', totalRoas14d: 'totalRoas14d', totalSales14d: 'totalSales14d',
        purchaseCount14d: 'purchaseCount14d', totalUnitsSold14d: 'totalUnitsSold14d',
        purchaseClickRate14d: 'purchaseClickRate14d', viewableImpressions: 'viewableImpressions',
        vcpm: 'Cost per 1,000 viewable impressions (VCPM)', vtr: 'View-Through Rate (VTR)',
        vctr: 'Click-Through Rate for Views (vCTR)', richMediaEvent68Count: 'richMediaEvent68Count',
        richMediaEvent70Count: 'richMediaEvent70Count', richMediaEvent78Count: 'richMediaEvent78Count',
        richMediaEvent66Count: 'richMediaEvent66Count', richMediaEvent79Count: 'richMediaEvent79Count',
        richMediaEvent8193Count: 'richMediaEvent8193Count', video5SecondViewRate: 'video5SecondViewRate',
        brandSearchCount14d: 'brandSearchCount14d', totalDpvCount14d: 'totalDpvCount14d',
        newToBrandPurchases: 'newToBrandPurchases', newToBrandPurchasesPercentage: 'newToBrandPurchasesPercentage',
        newToBrandSales: 'newToBrandSales', newToBrandSalesPercentage: 'newToBrandSalesPercentage',
        newToBrandUnitsSold: 'newToBrandUnitsSold', newToBrandUnitsSoldPercentage: 'newToBrandUnitsSoldPercentage',
        newToBrandPurchasesRate: 'newToBrandPurchasesRate', acosClicks14d: 'acosClicks14d',
        roasClicks14d: 'roasClicks14d', sales14d: '14 Day Total Sales - not converted', purchases14d: 'purchases14d',
        unitsSoldClicks14d: 'unitsSoldClicks14d', newToBrandDetailPageViews: 'newToBrandDetailPageViews',
        newToBrandDetailPageViewClicks: 'newToBrandDetailPageViewClicks',
        newToBrandDetailPageViewRate: 'newToBrandDetailPageViewRate',
        newToBrandECPDetailPageView: 'newToBrandECPDetailPageView', brandStorePageView: 'brandStorePageView',
        addToCart: 'addToCart', addToCartClicks: 'addToCartClicks', addToCartRate: 'addToCartRate',
        eCPAddToCart: 'eCPAddToCart', brandedSearchesClicks: 'brandedSearchesClicks',
        brandedSearchRate: 'Branded search rate', eCPBrandSearch: 'eCPBrandSearch',
        longTermSales: 'longTermSales', longTermROAS: 'longTermROAS',
      },
    },
    // Sponsored Display -> Advertised product
    sd: {
      reportName: 'Sponsored Display Advertised product report',
      reportType: 'adProducts',
      reportCategoryId: 'sd',
      filterTypes: ['fenix', 'advertiserId', 'marketplaceId', 'adProductTypeCode'],
      columns: [
        'first_timestamp', 'last_timestamp', 'portfolio_name', 'campaign_budget_currency', 'campaign_name',
        'campaign_price_type_code', 'ad_name', 'ad_optimization_type', 'ad_creative_sku', 'ad_creative_asin',
        'impressions', 'viewable_impressions', 'clicks', 'ctr', 'total_dpv_count_14d', 'total_cost', 'cpc',
        'vcpm', 'total_acos_14d', 'total_roas_14d', 'purchase_count_14d', 'total_units_sold_14d',
        'total_sales_14d', 'sd_ntb_cutover_ntb_purchase_count_14d', 'sd_ntb_cutover_total_ntb_sales_14d',
        'sd_ntb_cutover_total_ntb_units_sold_14d', 'total_acos_from_clicks_14d', 'total_roas_from_clicks_14d',
        'purchase_click_count_14d', 'total_units_sold_from_clicks_14d', 'total_sales_from_clicks_14d',
        'ntb_purchase_click_count_14d', 'total_ntb_sales_from_clicks_14d', 'total_ntb_units_sold_from_clicks_14d',
      ],
      translationsMap: {
        first_timestamp: 'Start Date', last_timestamp: 'End Date', portfolio_name: 'Portfolio name',
        campaign_budget_currency: 'Currency', campaign_name: 'Campaign Name',
        campaign_price_type_code: 'Cost Type', ad_name: 'Ad Group Name', ad_optimization_type: 'Bid Optimisation',
        ad_creative_sku: 'Advertised SKU', ad_creative_asin: 'Advertised ASIN', impressions: 'Impressions',
        viewable_impressions: 'Viewable Impressions', clicks: 'Clicks', ctr: 'Click-Thru Rate (CTR)',
        total_dpv_count_14d: '14 Day Detail Page Views (DPV)', total_cost: 'Spend',
        cpc: 'Cost Per Click (CPC)', vcpm: 'Cost per 1,000 viewable impressions (VCPM)',
        total_acos_14d: 'Total Advertising Cost of Sales (ACOS)',
        total_roas_14d: 'Total Return on Advertising Spend (ROAS)', purchase_count_14d: '14 Day Total Orders (#)',
        total_units_sold_14d: '14 Day Total Units (#)', total_sales_14d: '14 Day Total Sales (₹)',
        sd_ntb_cutover_ntb_purchase_count_14d: '14 Day New-to-brand Orders (#)',
        sd_ntb_cutover_total_ntb_sales_14d: '14 Day New-to-brand Sales (₹)',
        sd_ntb_cutover_total_ntb_units_sold_14d: '14 Day New-to-brand Units (#)',
        total_acos_from_clicks_14d: 'Total Advertising Cost of Sales (ACOS) – (Click)',
        total_roas_from_clicks_14d: 'Total Return on Advertising Spend (ROAS) – (Click)',
        purchase_click_count_14d: '14 Day Total Orders (#) – (Click)',
        total_units_sold_from_clicks_14d: '14 Day Total Units (#) – (Click)',
        total_sales_from_clicks_14d: '14 Day Total Sales – (Click)',
        ntb_purchase_click_count_14d: '14 Day New-to-brand Orders (#) – (Click)',
        total_ntb_sales_from_clicks_14d: '14 Day New-to-brand Sales - (Click)',
        total_ntb_units_sold_from_clicks_14d: '14 Day New-to-brand Units (#) – (Click)',
        unallocated: 'Unallocated',
      },
    },
  };

  // Response is a bare report-id string (not wrapped in JSON) - confirmed
  // live, unlike every other schedule call in this file except Orders/Payments.
  async function scheduleAdsReport({ startDate, endDate, reportKey }) {
    const shape = ADS_REPORT_SHAPES[reportKey];
    if (!shape) return { status: 0, error: `Unknown ads report type: ${reportKey}` };
    const entityId = getAdsEntityId();
    if (!entityId) return { status: 0, entityIdMissing: true };
    const csrfToken = getAdsCsrfToken();
    if (!csrfToken) return { status: 0, csrfMissing: true };

    const res = await fetch(`/reports/api/subscriptions/custom?entityId=${encodeURIComponent(entityId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', 'anti-csrftoken-a2z': csrfToken },
      body: JSON.stringify({
        reportName: shape.reportName,
        reportType: shape.reportType,
        reportPeriod: 'CUSTOM',
        reportStartDate: startDate,
        reportEndDate: endDate,
        reportPeriodTimezone: 'Asia/Calcutta',
        subscriptionDelivery: { frequency: 'SINGLE' },
        reportMetadata: { reportCategoryId: shape.reportCategoryId, reportTypeId: shape.reportType, templateId: null, templateGuidance: null, timeUnitId: 'summary' },
        filterTypes: shape.filterTypes,
        recipients: null,
        reportCategory: shape.reportCategoryId,
        timeUnit: 'summary',
        currencyOfVisualization: null,
        columns: shape.columns,
        marketplaceIds: [ADS_MARKETPLACE_ID],
        campaignSites: null,
        mrcAccreditationStatus: null,
        translationsMap: shape.translationsMap,
      }),
    });
    const text = await res.text();
    // Response is a bare UUID string, not JSON - strip surrounding quotes if
    // the server happened to send it as a JSON string literal.
    const reportId = text.replace(/^"|"$/g, '').trim();
    return { status: res.status, reportId };
  }

  // Confirmed live via DevTools inspection: the account-switcher header in
  // Seller Central's top-left bar. The Vue `data-v-xxxxx` scoped-style
  // attribute isn't stable across deploys, so only the class name is
  // targeted. Text comes back with a stray trailing "." and extra
  // whitespace (e.g. "VRINDA ENTERPRISE  ."), hence the extra trim/strip.
  function readSellerAccountName() {
    const el = document.querySelector('.dropdown-account-switcher-header-label-global');
    if (!el) return null;
    const name = el.textContent.trim().replace(/\.+$/, '').trim();
    return name || null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Lets background.js cheaply confirm this content script is alive before
    // relying on it - a tab that was open before the extension loaded (or was
    // discarded/reloaded) won't answer this.
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    // Returns null (not an error) when the selector doesn't match - e.g. a
    // different Amazon origin like advertising.amazon.in - so background.js
    // can fall back to the SpeedEcom tenant name instead of failing the zip.
    if (msg?.type === 'GET_SELLER_ACCOUNT_NAME') {
      sendResponse({ name: readSellerAccountName() });
      return false;
    }

    if (msg?.type === 'SCHEDULE_ORDER_REPORT') {
      (async () => {
        try {
          const r = await scheduleOrderReport(msg);
          console.log(TAG, `schedule order report: HTTP ${r.status}`, r.body);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // async response
    }

    if (msg?.type === 'FETCH_ORDER_STATUS') {
      (async () => {
        try {
          const r = await fetchOrderReportStatus();
          console.log(TAG, `order report status: HTTP ${r.status}, entries=${r.body?.reportRequestResult?.length}`);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_ORDER_FILE') {
      (async () => {
        try {
          const r = await fetchOrderReportFile(msg.referenceId);
          console.log(TAG, `order report file: HTTP ${r.status}, bytes=${r.base64 ? Math.floor(r.base64.length * 0.75) : 0}`);
          sendResponse({ ok: true, status: r.status, base64: r.base64, filename: r.filename });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'SCHEDULE_RETURNS_REPORT') {
      (async () => {
        try {
          const csrfToken = getReturnsCsrfToken();
          if (!csrfToken) { sendResponse({ ok: true, status: 0, csrfMissing: true }); return; }
          const r = await scheduleReturnsReport({ fromDate: msg.fromDate, toDate: msg.toDate, csrfToken });
          console.log(TAG, `schedule returns report: HTTP ${r.status}`);
          // Reporting the page's own URL back lets background.js's navigation
          // orchestrator learn/cache "this is a confirmed-working Return
          // Reports URL" from real successful use, instead of it having to be
          // hardcoded (or guessed) anywhere.
          sendResponse({ ok: true, status: r.status, pageUrl: location.href });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    // Lets the background orchestrator confirm a page has actually finished
    // initializing (its CSRF token is rendered into the DOM) after navigating
    // to it, instead of guessing with a fixed delay.
    if (msg?.type === 'RETURNS_PAGE_READY') {
      sendResponse({ ready: !!getReturnsCsrfToken() });
      return false;
    }

    if (msg?.type === 'FETCH_RETURNS_LIST') {
      (async () => {
        try {
          const r = await fetchReturnsList();
          console.log(TAG, `returns list: HTTP ${r.status}, records=${r.records.length}`);
          sendResponse({ ok: true, status: r.status, records: r.records });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_RETURNS_FILE') {
      (async () => {
        try {
          const r = await fetchReturnsFile(msg.url);
          console.log(TAG, `returns file: HTTP ${r.status}, bytes=${r.base64 ? Math.floor(r.base64.length * 0.75) : 0}`);
          sendResponse({ ok: true, status: r.status, base64: r.base64 });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'SCHEDULE_PAYMENTS_REPORT') {
      (async () => {
        try {
          const r = await schedulePaymentsReport(msg);
          console.log(TAG, `schedule payments report: HTTP ${r.status}`, r.body?.reportId);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_PAYMENTS_STATUS') {
      (async () => {
        try {
          const r = await fetchPaymentsReportStatus(msg.reportId);
          console.log(TAG, `payments report status: HTTP ${r.status}, status=${r.body?.status}`);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_PAYMENTS_FILE') {
      (async () => {
        try {
          const r = await fetchPaymentsReportFile(msg.reportId);
          console.log(TAG, `payments report file: HTTP ${r.status}, bytes=${r.base64 ? Math.floor(r.base64.length * 0.75) : 0}`);
          sendResponse({ ok: true, status: r.status, base64: r.base64, filename: r.filename });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'SCHEDULE_GST_REPORT') {
      (async () => {
        try {
          const r = await scheduleGstReport(msg);
          console.log(TAG, `schedule gst report: HTTP ${r.status}`);
          sendResponse({ ok: true, status: r.status });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_GST_LIST') {
      (async () => {
        try {
          const r = await fetchGstReportList();
          console.log(TAG, `gst report list: HTTP ${r.status}, entries=${r.body?.reportMetadataList?.length}`);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_GST_FILE') {
      (async () => {
        try {
          const r = await fetchGstReportFile(msg);
          console.log(TAG, `gst report file: HTTP ${r.status}, bytes=${r.base64 ? Math.floor(r.base64.length * 0.75) : 0}`);
          sendResponse({ ok: true, status: r.status, base64: r.base64, filename: r.filename });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_MONTHLY_GST_METADATA') {
      (async () => {
        try {
          const r = await fetchMonthlyGstMetadata(msg);
          console.log(TAG, `monthly gst metadata: HTTP ${r.status}`, r.body?.reportStatus, r.body?.documentId);
          sendResponse({ ok: true, status: r.status, body: r.body });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'SCHEDULE_FBA_RETURNS_REPORT') {
      (async () => {
        try {
          const csrfToken = getA2zCsrfToken();
          if (!csrfToken) { sendResponse({ ok: true, status: 0, csrfMissing: true }); return; }
          const r = await submitFbaReturnsReport({ reportStartDate: msg.reportStartDate, reportEndDate: msg.reportEndDate, csrfToken });
          console.log(TAG, `schedule fba returns report: HTTP ${r.status}`, r.body?.reportReferenceId);
          // Unlike Standard Returns' page, this one was never confirmed via a
          // captured page URL - this is how the orchestrator learns it for
          // the first time (see PAGE_REQUIREMENTS.fbaReturns in background.js).
          sendResponse({ ok: true, status: r.status, body: r.body, pageUrl: location.href });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FETCH_FBA_RETURNS_STATUS') {
      (async () => {
        try {
          const csrfToken = getA2zCsrfToken();
          if (!csrfToken) { sendResponse({ ok: true, status: 0, csrfMissing: true }); return; }
          const r = await fetchFbaReturnsStatus({ referenceId: msg.referenceId, csrfToken });
          console.log(TAG, `fba returns report status: HTTP ${r.status}`, r.body);
          sendResponse({ ok: true, status: r.status, body: r.body, pageUrl: location.href });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'FBA_RETURNS_PAGE_READY') {
      sendResponse({ ready: !!getA2zCsrfToken() });
      return false;
    }

    if (msg?.type === 'FETCH_FBA_RETURNS_FILE') {
      (async () => {
        try {
          const r = await fetchFbaReturnsFile(msg.referenceId);
          console.log(TAG, `fba returns report file: HTTP ${r.status}, bytes=${r.base64 ? Math.floor(r.base64.length * 0.75) : 0}`);
          sendResponse({ ok: true, status: r.status, base64: r.base64, filename: r.filename });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (msg?.type === 'ADS_PAGE_READY') {
      sendResponse({ ready: !!(getAdsEntityId() && getAdsCsrfToken()) });
      return false;
    }

    if (msg?.type === 'SCHEDULE_ADS_REPORT') {
      (async () => {
        try {
          const r = await scheduleAdsReport(msg);
          console.log(TAG, `schedule ads report: HTTP ${r.status}`, r.reportId);
          sendResponse({ ok: true, status: r.status, reportId: r.reportId, csrfMissing: r.csrfMissing, entityIdMissing: r.entityIdMissing, pageUrl: location.href });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    return false;
  });
})();
