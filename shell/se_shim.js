'use strict';
// Speed Ecom - per-marketplace `chrome` facade.
//
// Each marketplace's original background.js / popup.js is wrapped in an IIFE
// that shadows the global `chrome` with the object returned here. That lets the
// three codebases keep their ORIGINAL source, byte for byte, while sharing one
// service worker and one storage area:
//
//   * storage keys listed in `prefixedKeys` are transparently prefixed on write
//     and un-prefixed on read, so `get('syncProgress')` still resolves to
//     `{ syncProgress: ... }` and existing destructuring keeps working;
//   * every other key (notably `auth`) is left alone, so the Speed Ecom login
//     stays shared across all three panels by design;
//   * runtime messages are tagged with the sending marketplace, and each
//     onMessage listener ignores messages tagged for a different one - so
//     Amazon's AUTH_LOGIN handler no longer answers Meesho's AUTH_LOGIN.
//
// Untagged messages (i.e. from content scripts, which have no shim) are passed
// through to every listener, exactly as before.

(function (glob) {
  const REAL = glob.chrome;
  const ALL_PREFIXES = ['amz_', 'mee_', 'myn_'];

  glob.__seShim = function (mkt, prefixedKeys) {
    const PFX = mkt + '_';
    const KEYS = new Set(prefixedKeys || []);

    const enc = (k) => (KEYS.has(k) ? PFX + k : k);
    const dec = (k) =>
      k.startsWith(PFX) && KEYS.has(k.slice(PFX.length)) ? k.slice(PFX.length) : k;
    // A key owned by one of the OTHER marketplaces - never surface it here.
    const isForeign = (k) => ALL_PREFIXES.some((p) => p !== PFX && k.startsWith(p));

    function encQuery(q) {
      if (q == null) return q;
      if (typeof q === 'string') return enc(q);
      if (Array.isArray(q)) return q.map(enc);
      const out = {};
      for (const k of Object.keys(q)) out[enc(k)] = q[k];
      return out;
    }

    function encObject(obj) {
      const out = {};
      for (const k of Object.keys(obj || {})) out[enc(k)] = obj[k];
      return out;
    }

    function decObject(res) {
      const out = {};
      for (const k of Object.keys(res || {})) {
        if (isForeign(k)) continue;
        out[dec(k)] = res[k];
      }
      return out;
    }

    // ── storage.local / storage.sync ─────────────────────────────────────────
    function wrapArea(area) {
      return new Proxy(area, {
        get(t, p) {
          if (p === 'get') {
            return (query, cb) =>
              typeof cb === 'function'
                ? t.get(encQuery(query), (r) => cb(decObject(r)))
                : t.get(encQuery(query)).then(decObject);
          }
          if (p === 'set') {
            return (obj, cb) =>
              typeof cb === 'function' ? t.set(encObject(obj), cb) : t.set(encObject(obj));
          }
          if (p === 'remove') {
            return (keys, cb) => {
              const k = Array.isArray(keys) ? keys.map(enc) : enc(keys);
              return typeof cb === 'function' ? t.remove(k, cb) : t.remove(k);
            };
          }
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    }

    const localArea = wrapArea(REAL.storage.local);
    const syncArea = REAL.storage.sync ? wrapArea(REAL.storage.sync) : undefined;

    // addListener/removeListener are given different function objects than the
    // caller passed, so the mapping has to be remembered to support removal.
    const changeWrappers = new WeakMap();

    const storageFacade = new Proxy(REAL.storage, {
      get(t, p) {
        if (p === 'local') return localArea;
        if (p === 'sync') return syncArea;
        if (p === 'onChanged') {
          return {
            addListener(fn) {
              const wrapped = (changes, areaName) => {
                const out = {};
                let any = false;
                for (const k of Object.keys(changes || {})) {
                  if (isForeign(k)) continue;
                  out[dec(k)] = changes[k];
                  any = true;
                }
                if (any) fn(out, areaName);
              };
              changeWrappers.set(fn, wrapped);
              return t.onChanged.addListener(wrapped);
            },
            removeListener(fn) {
              return t.onChanged.removeListener(changeWrappers.get(fn) || fn);
            },
            hasListener(fn) {
              return t.onChanged.hasListener(changeWrappers.get(fn) || fn);
            },
          };
        }
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });

    // ── runtime messaging ────────────────────────────────────────────────────
    const messageWrappers = new WeakMap();

    const runtimeFacade = new Proxy(REAL.runtime, {
      get(t, p) {
        if (p === 'sendMessage') {
          return (...args) => {
            // Signatures: (msg), (msg, cb), (msg, opts), (msg, opts, cb).
            // The (extensionId, msg, ...) form is not used by any of the three
            // extensions, and is left untouched if it ever appears.
            if (args.length && args[0] && typeof args[0] === 'object') {
              args[0] = Object.assign({}, args[0], { __seMkt: mkt });
            }
            return t.sendMessage(...args);
          };
        }
        if (p === 'onMessage') {
          return {
            addListener(fn) {
              const wrapped = (msg, sender, sendResponse) => {
                // Tagged for someone else -> not ours, don't answer.
                if (msg && msg.__seMkt && msg.__seMkt !== mkt) return false;
                return fn(msg, sender, sendResponse);
              };
              messageWrappers.set(fn, wrapped);
              return t.onMessage.addListener(wrapped);
            },
            removeListener(fn) {
              return t.onMessage.removeListener(messageWrappers.get(fn) || fn);
            },
            hasListener(fn) {
              return t.onMessage.hasListener(messageWrappers.get(fn) || fn);
            },
          };
        }
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });

    // Everything else (tabs, alarms, downloads, scripting,
    // declarativeNetRequest, action, ...) passes straight through.
    return new Proxy(REAL, {
      get(t, p) {
        if (p === 'storage') return storageFacade;
        if (p === 'runtime') return runtimeFacade;
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
})(typeof self !== 'undefined' ? self : window);
