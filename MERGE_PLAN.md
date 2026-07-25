# Speed Ecom Extension — Unified Build Plan

Merging `Amazon/`, `Meesho/`, `Myntra/Myntra/` into ONE Chrome MV3 extension
named **Speed Ecom Extension**, keeping each marketplace's UI and behaviour
exactly as it is today.

---

## 1. What I found (why previous attempts failed)

### 1.1 The `speedecom/` attempt is broken at the root

`speedecom/background.js` is a 60-line stub. The real logic —
`amazon_background.js` (89 KB), `meesho_background.js` (80 KB),
`myntra_background.js` (24 KB) — **is never loaded by anything**. Its own
comment says "Messages are handled by marketplace-specific popup.js files",
which is wrong: popups only *send* messages, backgrounds do the work. So every
sync silently does nothing.

Second bug: `popup.js` does `document.documentElement.innerHTML = html` then
appends a `<script>`. `innerHTML` never executes scripts, and the document is
already parsed, so the marketplace UI is inert even when it renders.

Verdict: not repairable. Rebuild from the three known-good originals.

### 1.2 The real MV3 constraints

Only two things genuinely cannot be duplicated in one extension:

| Resource | Limit | Impact |
|---|---|---|
| Service worker | exactly 1 | 3 backgrounds must coexist in one worker |
| Action popup | 1 *default* | but it can be **overridden per tab** — this saves us |

Everything else merges for free: content scripts, host permissions, icons.

### 1.3 Collision inventory (measured, not guessed)

**A. Top-level identifiers — ~40 collisions.** Concatenating the three
backgrounds throws `SyntaxError: Identifier 'TAG' has already been declared`
and the entire service worker dies. Duplicated across 2–3 files:

```
TAG, MAX_ATTEMPTS, LOG_MAX_ENTRIES, AUTH_ORIGIN, AUTH_HEADER_RULE_ID, sleep,
pemToArrayBuffer, arrayBufferToBase64, encryptPassword, extractToken,
extractUser, authLogin, authFetchProfile, setProgress, newState, appendLog,
fetchFileOnce, fetchFileWithRetry, uniqueZipName, processDownloadQueue,
sendToTab, pingTab, ensureContentScript, sendToTabWithRecovery, safeZipName, ...
```

**B. declarativeNetRequest rule IDs.**
Amazon `AUTH_HEADER_RULE_ID = 1`, Meesho `AUTH_HEADER_RULE_ID = 1`,
Myntra `CORS_FIX_RULE_ID = 1` + `AUTH_HEADER_RULE_ID = 2`.
In one extension these share a namespace. Each block calls
`removeRuleIds: [1]`, so whichever runs last deletes the others' rules —
**login breaks for two of the three marketplaces**, and Myntra's blob-CORS fix
gets wiped. This is a silent failure, very likely one of the "too many issues"
seen before.

**C. Message type collisions.** All three backgrounds handle `AUTH_LOGIN` and
`AUTH_REFRESH_PROFILE`; Amazon and Myntra both handle `PAUSE_SYNC`,
`RESUME_SYNC`, `CANCEL_SYNC`. `chrome.runtime.onMessage` broadcasts to *every*
listener, so one login click fires three network calls and three
`sendResponse()` on one channel → console errors, and a Myntra "Cancel" would
also cancel a running Amazon sync.

**D. Storage key collisions.**
- `syncLog` — Amazon + Myntra overwrite each other
- `syncProgress` — Amazon popup + Myntra popup overwrite each other
- `auth` — all three. **Leave this shared on purpose**: one Speed Ecom login
  unlocks all three panels. That's an upgrade, not a conflict.

**E. Non-collisions — confirmed safe, no work needed.**
- Content script domains are disjoint (`sellercentral.amazon.in` +
  `advertising.amazon.in` / `supplier.meesho.com` /
  `partners.myntrainfo.com`) → three separate manifest entries, files used
  verbatim.
- Alarm names are disjoint (`amazon-*-sync-tick` vs `pruneDownloadHistory` vs
  Meesho's dynamic wait alarms) and every listener already name-checks.
- `jszip.min.js` is byte-identical in all three (`md5 b5d02b3f…`) → ship one copy.
- Icon sets are byte-identical → ship one set.

**F. Popup widths differ:** Amazon 360 px, Meesho 344 px, Myntra 320 px.
This rules out one shared popup document and points straight at the per-tab
popup approach below.

---

## 2. The two design decisions

### Decision 1 — Per-tab popup, not a merged popup page

Use `chrome.action.setPopup({ tabId, popup })` from the service worker:

| Active tab | Popup shown |
|---|---|
| `sellercentral.amazon.in` / `advertising.amazon.in` | `amazon/popup.html` |
| `supplier.meesho.com` | `meesho/popup.html` |
| `partners.myntrainfo.com` | `myntra/popup.html` |
| anything else | `chooser.html` (small Speed Ecom launcher) |

Why this over an iframe shell or merged `<div>` panes:

- The three `popup.html` files are used **completely untouched** — own document,
  own CSS, own scripts, own width. Pixel-identical to today, guaranteed.
- No CSS scoping work (all three style bare `body`/`button` selectors and would
  otherwise fight).
- No script-injection timing problem — the exact failure mode of the last attempt.
- Native popup auto-sizing per marketplace, so 360/344/320 all stay correct.

This is also literally the stated requirement: *"if I open Meesho panel then it
shows Meesho extension."*

`chooser.html` is the only new UI — see §2.3.

### Decision 3 — `chooser.html`: live status, not just links

**Decided.** On a non-marketplace tab the icon opens a chooser that shows all
three marketplaces *with their current sync progress*, so nothing is lost
versus the standalone extensions (today you can check Amazon progress from any
tab; the chooser preserves that).

- Reads `amz_syncProgress`, `myn_syncProgress` and Meesho's `syncState` /
  `lastStatus` directly from `chrome.storage.local` — read-only, no new
  messages, no changes to any marketplace's code.
- Live-updates via `chrome.storage.onChanged`.
- Shows shared login state (`auth`), with a single Login / Logout control.
- Clicking a marketplace row does `window.location.href = 'amazon_popup.html'`
  — a **real document navigation** inside the popup, so the panel loads with
  its own CSS and its own scripts running normally. This is *not* the
  innerHTML/inject approach that broke the previous attempt.
- A row also offers "open portal" to launch the seller site in a tab.

### Decision 4 — Centralised login and navigation (added after first working build)

The merge left three separate login forms and three logout buttons even though
the session was already shared. Requested change: one login, one logout, and a
way back to the list from inside a panel.

- **Login** moves to the marketplace list. Signed out, the list shows a single
  Speed Ecom sign-in; signed in, it shows the marketplaces.
- **Logout** exists in exactly one place — the account bar on that list.
- **Back** — every panel gets a "‹ All" control in its user bar.
- Each panel's own `#loginView` and `#logoutBtn` are hidden, and a panel
  redirects to the list if the session is missing or disappears while open.

### Decision 5 — Unified header and account row

The three headers had nothing in common beyond their markup: a dark navy, a
purple and a magenta bar, `14px 18px` vs `8px 16px` padding, an orange-gradient
badge vs two translucent ones, 27px vs 24px avatars, three different tinted
account rows — and Meesho's badge read "Supplier Tool" while the other two named
their marketplace.

All three now use one header: `#0f172a` (the same bar as the marketplace list),
a 46px row on a 12px gutter, a 2px accent underline, and a solid accent badge
naming the marketplace. The accent per marketplace — Amazon amber, Meesho pink,
Myntra indigo — is the same colour that marketplace has on the list, so the
colour you clicked carries into the panel, and the avatar picks it up too.

The back control moved from the account row into the header, which is where a
back affordance belongs and which leaves the account row as just avatar + name.
Everything lines up on one 12px gutter: back button and avatar share a left
edge, badge and name share a right edge. Verified by measuring
`getBoundingClientRect()` in all three panels at their three different widths
(360 / 344 / 320) — identical geometry in each.

Implemented as `shell/panel_chrome.js`, loaded *after* each marketplace's own
popup.js. Purely additive — it only adjusts the shared shell (hide two
elements, insert one button, guard the session). No marketplace logic is
touched, and the popup bodies stay verbatim. All three popups happen to use the
same ids (`#userBar`, `#logoutBtn`, `#loginView`), so one file covers all three;
`build.js` asserts those ids still exist so a future marketplace update that
renames one fails the build instead of silently losing the button.

The list's login reuses Amazon's existing `AUTH_LOGIN` handler (tagged via the
shim so exactly one background answers) rather than adding a fourth copy of the
auth code — the three `authLogin()` implementations are byte-identical, verified
by diff.

### Decision 2 — Generate the merged extension with a build script; never hand-edit

`build.js` (plain Node, no dependencies) reads the three pristine originals and
emits `dist/`. The originals in `Amazon/`, `Meesho/`, `Myntra/` are **never
modified** — they stay the source of truth. Re-run the build whenever one
marketplace extension is updated.

This is the single biggest difference from previous attempts, which were
one-way hand-merges: unrepeatable, and impossible to diff against the working
original when something broke.

---

## 3. The transforms `build.js` applies

Full honesty: a byte-for-byte merge is impossible in MV3. Below is the
**complete** list of changes. All are mechanical and none touch UI, layout,
business logic, or feature behaviour.

### T1 — IIFE-wrap each background (fixes collision A)

```js
// dist/background.js
'use strict';
importScripts('jszip.min.js');
importScripts('amazon_background.js', 'meesho_background.js', 'myntra_background.js');
```

and each generated `*_background.js` is the original file wrapped:

```js
(function () {
/* ---- original Amazon/background.js, verbatim ---- */
})();
```

Every top-level `const`/`function` becomes function-scoped. Forty collisions
gone, **zero characters changed inside the body**. Each file is fully
self-contained today (verified — no cross-file references), so wrapping is safe.
The original `importScripts('jszip.min.js')` line at the top of each is dropped
since the entry loads it once; that is the only removal.

### T2 — Offset DNR rule IDs (fixes collision B)

Four integer constants, per marketplace:

| File | Constant | Before | After |
|---|---|---|---|
| amazon_background.js | `AUTH_HEADER_RULE_ID` | 1 | 101 |
| meesho_background.js | `AUTH_HEADER_RULE_ID` | 1 | 201 |
| myntra_background.js | `CORS_FIX_RULE_ID` | 1 | 301 |
| myntra_background.js | `AUTH_HEADER_RULE_ID` | 2 | 302 |

Every `removeRuleIds` / `addRules` site already references the constant, so
changing the constant is sufficient. Build asserts no literal rule-ID numbers
remain.

### T3 + T4 — `chrome` API shim (fixes collisions C and D)

**Revised during implementation.** The original plan textually renamed message
types and storage keys. Measuring the real call sites killed that idea:

- `syncProgress` is read as
  `({ syncProgress } = await chrome.storage.local.get('syncProgress'))` —
  destructuring by the original key name — and is *also* a local variable 24×
  in Amazon's popup and 13× in Myntra's. A blanket rename hits the variable; a
  surgical rename is error-prone in exactly the places hardest to verify.
- `PAUSE_SYNC`/`RESUME_SYNC` are built dynamically:
  `const type = syncProgress?.paused ? 'RESUME_SYNC' : 'PAUSE_SYNC';`

So instead of editing the sources, each IIFE shadows the global `chrome` with a
facade (`shell/se_shim.js`) that does the namespacing at the API boundary:

- **Storage** — keys in the module's `prefixedKeys` list are prefixed on write
  and un-prefixed on read, so `get('syncProgress')` still resolves to
  `{ syncProgress: … }` and destructuring keeps working untouched.
  `onChanged` is filtered to the module's own keys and reported under the
  original names. Only genuine collisions are listed (`syncProgress`,
  `syncLog`); marketplace-unique keys stay as-is so existing stored state
  survives the upgrade.
- **`auth` is not in any list** → stays shared → single sign-on, as decided.
- **Messages** — outgoing `runtime.sendMessage` is tagged `__seMkt`, and each
  `onMessage` listener ignores messages tagged for a different marketplace.
  Untagged messages (from content scripts, which have no shim) still broadcast
  to every listener exactly as before.
- Everything else (`tabs`, `alarms`, `downloads`, `scripting`,
  `declarativeNetRequest`, `action`, `runtime.getURL`, `lastError`, …) passes
  straight through.

Net effect: **zero source edits** for C and D. Verified by `test-shim.js`
(21 checks) against a mock `chrome`.

<details>
<summary>Superseded: the original textual-rename design</summary>


Applied symmetrically to each marketplace's `background.js` **and** `popup.js`,
so both sides always agree:

| Type | Amazon | Meesho | Myntra |
|---|---|---|---|
| `AUTH_LOGIN` | `AMZ_AUTH_LOGIN` | `MEE_AUTH_LOGIN` | `MYN_AUTH_LOGIN` |
| `AUTH_REFRESH_PROFILE` | `AMZ_AUTH_REFRESH_PROFILE` | `MEE_…` | `MYN_…` |
| `PAUSE_SYNC` / `RESUME_SYNC` / `CANCEL_SYNC` | `AMZ_…` | — | `MYN_…` |

Types that are already unique (`START_ORDER_SYNC`, `START_BULK_SYNC`,
`SYNC_NOW`, `START_PAYMENT_SYNC`, `GET_HISTORY`, `POLL_NOW`, …) are left alone.
Content-script types (`PING`, `FETCH_*`, `RELAY_*`) are left alone — those go
over `chrome.tabs.sendMessage` to one domain-scoped tab and cannot cross.

Build asserts: for each prefixed type, the count of occurrences in
`*_background.js` + `*_popup.js` equals the count in the original pair.

`syncLog` → `amz_syncLog` / `myn_syncLog`
`syncProgress` → `amz_syncProgress` / `myn_syncProgress`

</details>

`auth` is deliberately left shared → single sign-on across all three panels.
**Decided.** Accepted trade-off: logging out on any one panel logs you out of
all three. (To revert later, add `auth` to every marketplace's `prefixedKeys`
in `build.js` — that restores today's three-independent-logins behaviour.)

### T5 — Merged manifest

```jsonc
{
  "manifest_version": 3,
  "name": "Speed Ecom Extension",
  "version": "1.0.0",
  "permissions": ["storage","downloads","scripting","declarativeNetRequest","alarms","tabs"],
  "host_permissions": [ /* union of all three, deduped */ ],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "chooser.html", "default_title": "Speed Ecom" },
  "content_scripts": [
    { "matches": ["https://sellercentral.amazon.in/*","https://advertising.amazon.in/*"],
      "js": ["amazon_content.js"], "run_at": "document_idle" },
    { "matches": ["https://supplier.meesho.com/*"],
      "js": ["meesho_content.js"], "run_at": "document_idle" },
    { "matches": ["https://partners.myntrainfo.com/*"],
      "js": ["myntra_content.js"], "run_at": "document_idle" }
  ]
}
```

`"tabs"` is added so the worker can read tab URLs on activation to pick the
right popup. Content scripts and popup HTML files are copied **verbatim** (only
popup.js gets T3/T4).

### T6 — Popup router (new file, ~40 lines)

In `dist/router.js`, loaded by `background.js` outside the IIFEs:

```js
const ROUTES = [
  [/^https:\/\/(sellercentral|advertising)\.amazon\.in\//, 'amazon_popup.html'],
  [/^https:\/\/supplier\.meesho\.com\//,                   'meesho_popup.html'],
  [/^https:\/\/partners\.myntrainfo\.com\//,               'myntra_popup.html'],
];
// on tabs.onUpdated + tabs.onActivated → chrome.action.setPopup({ tabId, popup })
// no match → chooser.html
```

---

## 4. Output layout

```
dist/
  manifest.json          generated (T5)
  background.js          6-line entry: jszip + 3 importScripts + router
  router.js              new (T6)
  amazon_background.js   original, IIFE-wrapped (T1) + T2
  meesho_background.js   original, IIFE-wrapped (T1) + T2
  myntra_background.js   original, IIFE-wrapped (T1) + T2
  amazon_content.js      VERBATIM
  meesho_content.js      VERBATIM
  myntra_content.js      VERBATIM
  amazon_popup.html      VERBATIM
  meesho_popup.html      VERBATIM
  myntra_popup.html      VERBATIM
  amazon_popup.js        original + T3/T4
  meesho_popup.js        original + T3/T4
  myntra_popup.js        original + T3/T4
  chooser.html           new
  jszip.min.js           one copy
  icon.png  icons/       one set
```

Note each `*_popup.html` references `popup.js` — build rewrites that one
`<script src>` to `amazon_popup.js` etc. That is the only edit to the HTML.

---

## 5. Build order

**Status: steps 1–5 are implemented and `node build.js` passes all assertions.**
What remains is step 6 — the in-Chrome verification in §6, which needs real
logged-in sessions and so has to be done by hand.

Automated verification that has already run:

- `node build.js` — 5 structural checks (content-script matches preserved,
  host permissions cover all three originals, DNR ids unique, content scripts
  byte-identical, popup bodies contained verbatim), plus per-file asserts that
  each background body matches its pristine original after replaying only the
  declared transforms
- `node test-shim.js` — 21 checks on the storage/message shim
- `node --check` on all 14 generated JS files
- Manual diffs: `amazon_popup.html` differs from the original by the one
  `<script>` tag; `amazon_background.js` differs by the rule-ID line and the
  wrapper's blank lines. Nothing else.



1. **Scaffold + copy** — `build.js`, verbatim copies, dedupe jszip/icons. Load
   in Chrome: worker registers clean, no popup wiring yet.
2. **T5 manifest + T1 IIFE wrap** — the make-or-break step. Load unpacked and
   confirm the service worker console shows all three init lines and **zero**
   `already been declared` errors.
3. **T2 DNR IDs** — verify with
   `chrome.declarativeNetRequest.getSessionRules()` in the worker console:
   expect exactly 4 rules, ids 101/201/301/302.
4. **T6 router + chooser.html** — confirm the correct popup opens per domain.
5. **T3 + T4 namespacing** — the assert-backed rename pass.
6. **Full verification** (§6).

Steps 2 and 5 are where prior attempts died, so each ends with a hard check
before moving on.

---

## 6. Verification — every feature, per marketplace

Nothing is "done" until all of this passes on a real logged-in session.

**Shared**
- [ ] Worker console: no syntax/duplicate-declaration errors, 3 init lines
- [ ] `getSessionRules()` → 4 rules, ids 101/201/301/302
- [ ] Login once on any panel → other two panels already show logged in
- [ ] Logout → all three panels show logged out (accepted, see T4)

**Marketplace list / centralised login**
- [x] Signed out → single Speed Ecom login form *(verified against a mock)*
- [x] Wrong password → inline error, button re-enabled *(verified)*
- [x] Correct password → list appears with name, email, avatar *(verified)*
- [x] Logout returns to the login form and clears the fields *(verified)*
- [ ] Real login against speedecomsolution.com succeeds
- [ ] Start an Amazon sync → list shows its live progress from an unrelated tab
- [ ] Progress updates live while the list is open (`storage.onChanged`)
- [ ] Clicking a row navigates to that full panel, CSS + scripts intact
- [ ] "Portal" launches the seller site in a new tab

**Panel chrome (all three panels)**
- [x] "‹ All" button present as first item in the user bar *(verified on Myntra)*
- [x] Panel's own logout button hidden *(verified)*
- [x] Panel's own login view hidden *(verified)*
- [ ] "‹ All" returns to the marketplace list from each of the three panels
- [ ] Logging out from the list closes/redirects an open panel

**Amazon** (`sellercentral.amazon.in`)
- [ ] Popup is pixel-identical to the standalone build, 360 px wide
- [ ] Orders, Returns, Payments, GST B2B/B2C, FBA Returns, Sponsored Ads each
      schedule → poll → download a ZIP
- [ ] Bulk sync mode runs all categories
- [ ] Pause / Resume / Cancel affect **only** Amazon
- [ ] Progress bar + sync log render correctly

**Meesho** (`supplier.meesho.com`)
- [ ] Popup identical, 344 px wide
- [ ] Orders / Payments / Returns / Claims for a date range → one ZIP
- [ ] Download history lists entries; re-download works; clear history works
- [ ] Seller name resolves via DOM relay

**Myntra** (`partners.myntrainfo.com`)
- [ ] Popup identical, 320 px wide
- [ ] Prepaid + Postpaid date-range download → one ZIP
- [ ] Blob-host CORS fix works (rule 301 alive)
- [ ] Cancel affects **only** Myntra

**Cross-marketplace**
- [ ] Start an Amazon sync, switch to the Meesho tab, start a Meesho sync —
      both complete, no interference, no overwritten progress
- [ ] Non-marketplace tab → chooser opens, three buttons work

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| IIFE wrap breaks something subtle | Step 2 is isolated and independently verified before anything else changes |
| Missed a colliding message type | Build asserts occurrence counts match the original per file |
| One long-running sync starves another in one worker | All three are already async/alarm-driven; §6 cross-test covers it |
| Chrome kills the worker mid-sync | Unchanged from today — all three already use alarms to survive this |
| A marketplace ships an update later | Re-run `build.js` against the new original; no hand-merge ever again |

---

## 8. Explicitly out of scope

No refactoring, no de-duplicating the three near-identical `authLogin`
implementations, no shared utility module, no UI restyling, no version bumps to
marketplace logic. Deliberate: shared code means one marketplace's change can
break another. They stay independent.
