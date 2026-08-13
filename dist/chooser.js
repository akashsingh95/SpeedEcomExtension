'use strict';
// Speed Ecom - marketplace list + centralised login.
//
// This is the extension's home screen. Signed out it shows one Speed Ecom login
// for all three marketplaces; signed in it lists them with their live sync
// status and holds the single logout control.
//
// It reads each marketplace's progress straight out of chrome.storage.local
// (read-only, no messages, no changes to any marketplace's code) so a running
// sync stays visible from any tab.
//
// Clicking a row does a real document navigation to that marketplace's original
// popup.html, so the panel loads with its own CSS and its own scripts running
// normally.

(function () {
  // Login is routed through Amazon's existing AUTH_LOGIN handler rather than
  // adding a fourth copy of the auth code. All three backgrounds ship a
  // byte-identical authLogin() (verified at build time), and all three write the
  // same shared `auth` record, so which one answers is immaterial - it just has
  // to be exactly one, which is what tagging the message achieves. Storage still
  // uses the raw `chrome`, since this page must read every marketplace's keys.
  const authBus = globalThis.__seShim('amz', []);

  const MARKETS = [
    {
      id: 'amazon',
      name: 'Amazon',
      popup: 'amazon_popup.html',
      portal: 'https://sellercentral.amazon.in/',
      progressKey: 'amz_syncProgress',
    },
    {
      id: 'meesho',
      name: 'Meesho',
      popup: 'meesho_popup.html',
      portal: 'https://supplier.meesho.com/',
      statusKey: 'lastStatus',
    },
    {
      id: 'myntra',
      name: 'Myntra',
      popup: 'myntra_popup.html',
      portal: 'https://partners.myntrainfo.com/',
      progressKey: 'myn_syncProgress',
    },
  ];

  const $ = (id) => document.getElementById(id);
  const WATCHED = ['auth', 'amz_syncProgress', 'myn_syncProgress', 'lastStatus'];

  // Amazon + Myntra share the same progress shape (see newState() in both
  // backgrounds): { active, total, done, failed, current, finished, error,
  // paused, cancelled }.
  function describeProgress(p) {
    if (!p) return { text: 'Idle', cls: '', pct: null };
    if (p.error) return { text: String(p.error).slice(0, 60), cls: 'err', pct: null };
    if (p.cancelled) return { text: 'Cancelled', cls: '', pct: null };
    if (p.finished) {
      const failed = p.failed ? `, ${p.failed} failed` : '';
      return { text: `Done — ${p.done || 0} file(s)${failed}`, cls: 'done', pct: null };
    }
    if (p.active) {
      const pct = p.total ? Math.round(((p.done || 0) / p.total) * 100) : null;
      const state = p.paused ? 'Paused' : 'Syncing';
      const cnt = p.total ? ` ${p.done || 0}/${p.total}` : '';
      const cur = p.current ? ` · ${p.current}` : '';
      return { text: `${state}${cnt}${cur}`.slice(0, 64), cls: 'busy', pct };
    }
    return { text: 'Idle', cls: '', pct: null };
  }

  // Meesho writes { ...status, at } via setStatus().
  function describeStatus(s) {
    if (!s) return { text: 'Idle', cls: '', pct: null };
    const text = s.message || s.text || s.stage || s.state || 'Idle';
    let cls = '';
    if (s.error || /fail|error/i.test(String(text))) cls = 'err';
    else if (s.done || s.finished || /complete|done/i.test(String(text))) cls = 'done';
    else if (s.running || s.active || s.busy) cls = 'busy';
    return { text: String(text).slice(0, 64), cls, pct: null };
  }

  // ── Marketplace list ──────────────────────────────────────────────────────
  const rows = {};
  for (const m of MARKETS) {
    const row = document.createElement('button');
    row.className = 'row';
    row.type = 'button';

    const mark = document.createElement('div');
    mark.className = `row-mark ${m.id}`;
    mark.title = m.name;
    const markImg = document.createElement('img');
    markImg.src = `brand-icons/${m.id}.png`;
    markImg.alt = m.name;
    mark.appendChild(markImg);

    const meta = document.createElement('div');
    meta.className = 'row-meta';

    const name = document.createElement('div');
    name.className = 'row-name';
    name.textContent = m.name;

    const status = document.createElement('div');
    status.className = 'row-status';
    status.textContent = 'Idle';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    meta.append(name, status, bar);

    const portal = document.createElement('button');
    portal.className = 'portal';
    portal.type = 'button';
    portal.textContent = 'Portal';
    portal.title = `Open ${m.name} seller portal`;
    portal.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: m.portal });
      window.close();
    });

    const go = document.createElement('span');
    go.className = 'row-go';
    go.textContent = '›';

    row.append(mark, meta, portal, go);
    row.addEventListener('click', () => {
      window.location.href = m.popup;
    });

    $('list').appendChild(row);
    rows[m.id] = { status, bar, fill };
  }

  function paint(m, info) {
    const r = rows[m.id];
    r.status.textContent = info.text;
    r.status.className = `row-status ${info.cls}`;
    if (info.pct == null) {
      r.bar.style.display = 'none';
    } else {
      r.bar.style.display = 'block';
      r.fill.style.width = `${Math.max(0, Math.min(100, info.pct))}%`;
    }
  }

  function initials(user) {
    const s = (user && (user.name || user.fullName || user.email)) || '';
    const parts = String(s).trim().split(/[\s@._-]+/).filter(Boolean);
    if (!parts.length) return '—';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  // ── View switching ────────────────────────────────────────────────────────
  function showLogin() {
    $('loginView').hidden = false;
    $('listView').hidden = true;
    const email = $('seLoginEmail');
    if (email && !email.value) email.focus();
  }

  function showList(user) {
    $('loginView').hidden = true;
    $('listView').hidden = false;
    $('avatar').textContent = initials(user);
    $('acctName').textContent = (user && (user.name || user.fullName)) || 'Signed in';
    $('acctEmail').textContent = (user && user.email) || '';
  }

  async function refresh() {
    let data = {};
    try {
      data = await chrome.storage.local.get(WATCHED);
    } catch (_) {
      return;
    }

    if (!data.auth || !data.auth.token) {
      showLogin();
      return;
    }
    showList(data.auth.user || {});

    for (const m of MARKETS) {
      paint(m, m.progressKey ? describeProgress(data[m.progressKey]) : describeStatus(data[m.statusKey]));
    }
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  function setError(msg) {
    const el = $('seLoginError');
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  async function doLogin() {
    const btn = $('seLoginBtn');
    const email = $('seLoginEmail').value.trim();
    const password = $('seLoginPassword').value;

    setError('');
    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const resp = await authBus.runtime.sendMessage({ type: 'AUTH_LOGIN', email, password });
      if (resp && resp.ok) {
        $('seLoginPassword').value = '';
        await refresh();
      } else {
        setError((resp && resp.error) || 'Login failed.');
      }
    } catch (e) {
      setError((e && e.message) || 'Login failed.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  $('seLoginBtn').addEventListener('click', doLogin);
  for (const id of ['seLoginEmail', 'seLoginPassword']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
  }

  $('sePwToggle').addEventListener('click', () => {
    const input = $('seLoginPassword');
    const btn = $('sePwToggle');
    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    btn.classList.toggle('showing', showing);
    btn.title = showing ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', btn.title);
  });

  // ── Logout (the single place to sign out) ─────────────────────────────────
  $('seLogoutBtn').addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove('auth');
    } catch (_) {}
    $('seLoginEmail').value = '';
    $('seLoginPassword').value = '';
    $('seLoginPassword').type = 'password';
    $('sePwToggle').classList.remove('showing');
    setError('');
    await refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (WATCHED.some((k) => k in changes)) refresh();
  });

  refresh();
})();
