#!/usr/bin/env node
'use strict';
// Verifies se_shim.js against a mock chrome API. The shim is the only new logic
// sitting in the marketplaces' data path, so it gets tested directly.
//
//   Usage:  node test-shim.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Mock chrome ───────────────────────────────────────────────────────────────
function makeMockChrome() {
  const store = {};
  const changeListeners = [];
  const messageListeners = [];

  const local = {
    async get(query) {
      if (query == null) return { ...store };
      const keys = typeof query === 'string' ? [query] : Array.isArray(query) ? query : Object.keys(query);
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const k of Object.keys(obj)) {
        changes[k] = { oldValue: store[k], newValue: obj[k] };
        store[k] = obj[k];
      }
      changeListeners.forEach((fn) => fn(changes, 'local'));
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of arr) {
        changes[k] = { oldValue: store[k], newValue: undefined };
        delete store[k];
      }
      changeListeners.forEach((fn) => fn(changes, 'local'));
    },
  };

  return {
    __store: store,
    __emit: (msg) => messageListeners.map((fn) => fn(msg, {}, () => {})),
    storage: {
      local,
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => changeListeners.splice(changeListeners.indexOf(fn), 1),
        hasListener: (fn) => changeListeners.includes(fn),
      },
    },
    runtime: {
      id: 'mock-extension-id',
      lastError: undefined,
      getURL: (p) => `chrome-extension://mock/${p}`,
      sendMessage: async (msg) => ({ echoed: msg }),
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
        removeListener: (fn) => messageListeners.splice(messageListeners.indexOf(fn), 1),
        hasListener: (fn) => messageListeners.includes(fn),
      },
    },
    tabs: { sendMessage: async () => 'tab-ok' },
    alarms: { create: () => 'alarm-created' },
  };
}

// ── Load the shim ─────────────────────────────────────────────────────────────
const shimSrc = fs.readFileSync(path.join(__dirname, 'shell', 'se_shim.js'), 'utf8');
const mock = makeMockChrome();
const sandbox = { chrome: mock, console };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(shimSrc, sandbox);

const amz = sandbox.__seShim('amz', ['syncProgress', 'syncLog']);
const myn = sandbox.__seShim('myn', ['syncProgress', 'syncLog']);
const mee = sandbox.__seShim('mee', []);

(async () => {
  console.log('\nStorage namespacing');

  // The exact pattern both Amazon and Myntra popups use.
  await amz.storage.local.set({ syncProgress: { done: 3, total: 9 } });
  await myn.storage.local.set({ syncProgress: { done: 1, total: 2 } });

  check(
    'colliding key is physically namespaced',
    'amz_syncProgress' in mock.__store && 'myn_syncProgress' in mock.__store && !('syncProgress' in mock.__store),
    Object.keys(mock.__store).join(', ')
  );

  let got = {};
  ({ syncProgress: got } = await amz.storage.local.get('syncProgress'));
  check('destructuring by original key still works', eq(got, { done: 3, total: 9 }), JSON.stringify(got));

  ({ syncProgress: got } = await myn.storage.local.get('syncProgress'));
  check('the two marketplaces do not read each other', eq(got, { done: 1, total: 2 }), JSON.stringify(got));

  // Amazon and Myntra both write syncLog; each must see only its own.
  await amz.storage.local.set({ syncLog: ['a1'] });
  await myn.storage.local.set({ syncLog: ['m1'] });
  const aLog = await amz.storage.local.get(['syncLog']);
  const mLog = await myn.storage.local.get(['syncLog']);
  check('array-form get is namespaced', eq(aLog, { syncLog: ['a1'] }) && eq(mLog, { syncLog: ['m1'] }));

  console.log('\nShared login (deliberately NOT namespaced)');
  await amz.storage.local.set({ auth: { token: 't0', user: { name: 'Seller' } } });
  const meeAuth = await mee.storage.local.get('auth');
  const mynAuth = await myn.storage.local.get('auth');
  check('auth written on Amazon is visible to Meesho', meeAuth.auth && meeAuth.auth.token === 't0');
  check('auth written on Amazon is visible to Myntra', mynAuth.auth && mynAuth.auth.token === 't0');
  check('auth is stored unprefixed', 'auth' in mock.__store && !('amz_auth' in mock.__store));

  console.log('\nremove()');
  await amz.storage.local.remove('syncProgress');
  check(
    'remove only clears own namespaced key',
    !('amz_syncProgress' in mock.__store) && 'myn_syncProgress' in mock.__store
  );

  console.log('\nonChanged filtering');
  const seenByAmz = [];
  const seenByMyn = [];
  amz.storage.onChanged.addListener((changes) => seenByAmz.push(Object.keys(changes)));
  myn.storage.onChanged.addListener((changes) => seenByMyn.push(Object.keys(changes)));
  await myn.storage.local.set({ syncProgress: { done: 2, total: 2 } });
  check('Amazon is not notified of Myntra-only changes', seenByAmz.length === 0, JSON.stringify(seenByAmz));
  check('Myntra sees its change under the ORIGINAL key name', eq(seenByMyn, [['syncProgress']]), JSON.stringify(seenByMyn));

  seenByAmz.length = 0;
  seenByMyn.length = 0;
  await mee.storage.local.set({ auth: { token: 't1' } });
  check('shared auth change reaches every marketplace', eq(seenByAmz, [['auth']]) && eq(seenByMyn, [['auth']]));

  console.log('\nGet-all does not leak foreign keys');
  const all = await amz.storage.local.get(null);
  check(
    'get(null) hides other marketplaces',
    !Object.keys(all).some((k) => k.startsWith('myn_') || k.startsWith('mee_')),
    Object.keys(all).join(', ')
  );

  console.log('\nMessage routing');
  const heard = { amz: [], mee: [], myn: [] };
  amz.runtime.onMessage.addListener((m) => { heard.amz.push(m.type); return false; });
  mee.runtime.onMessage.addListener((m) => { heard.mee.push(m.type); return false; });
  myn.runtime.onMessage.addListener((m) => { heard.myn.push(m.type); return false; });

  // What each popup now actually puts on the wire.
  const sent = [];
  const realSend = mock.runtime.sendMessage;
  mock.runtime.sendMessage = async (m) => { sent.push(m); return realSend(m); };
  await amz.runtime.sendMessage({ type: 'AUTH_LOGIN', email: 'a@b.c' });
  check('outgoing message is tagged with its marketplace', sent[0].__seMkt === 'amz', JSON.stringify(sent[0]));
  check('original message fields are preserved', sent[0].type === 'AUTH_LOGIN' && sent[0].email === 'a@b.c');

  mock.__emit(sent[0]);
  check('only Amazon answers Amazon AUTH_LOGIN', eq(heard.amz, ['AUTH_LOGIN']) && !heard.mee.length && !heard.myn.length,
    `amz=${heard.amz} mee=${heard.mee} myn=${heard.myn}`);

  // The dynamic ternary both Amazon and Myntra use for pause/resume.
  heard.amz.length = 0; heard.myn.length = 0;
  sent.length = 0;
  await myn.runtime.sendMessage({ type: false ? 'RESUME_SYNC' : 'PAUSE_SYNC' });
  mock.__emit(sent[0]);
  check('dynamically-built PAUSE_SYNC reaches only Myntra', eq(heard.myn, ['PAUSE_SYNC']) && !heard.amz.length,
    `amz=${heard.amz} myn=${heard.myn}`);

  // Content scripts have no shim, so their messages carry no tag and must still
  // reach every listener exactly as before the merge.
  heard.amz.length = 0; heard.mee.length = 0; heard.myn.length = 0;
  mock.__emit({ type: 'PING' });
  check('untagged (content-script) messages still broadcast', heard.amz.length === 1 && heard.mee.length === 1 && heard.myn.length === 1);

  console.log('\nPassthrough');
  check('chrome.runtime.getURL passes through', amz.runtime.getURL('x.png') === 'chrome-extension://mock/x.png');
  check('chrome.runtime.id passes through', amz.runtime.id === 'mock-extension-id');
  check('chrome.tabs passes through', typeof amz.tabs.sendMessage === 'function');
  check('chrome.alarms passes through', amz.alarms.create() === 'alarm-created');

  console.log(fail === 0 ? `\n✓ ${pass}/${pass + fail} shim checks passed\n` : `\n✗ ${fail} of ${pass + fail} shim checks FAILED\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
