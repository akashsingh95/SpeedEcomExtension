'use strict';
// Speed Ecom - panel chrome.
//
// Loaded AFTER each marketplace's own popup.js. Purely additive: it does not
// touch any marketplace logic, it only adjusts the shared shell around it, so
// the three panels read as pages of one extension instead of three:
//
//   * unifies the header - the three were a dark navy, a purple and a magenta
//     bar with different padding, badges and type - into one design, with the
//     marketplace's identity carried by an accent colour that matches the one
//     it already has on the marketplace list;
//   * hides that panel's own logout button - logout now lives on the
//     marketplace list, so there is exactly one place to sign out;
//   * hides that panel's own login view - login is centralised on the
//     marketplace list, so a panel is only ever reached while signed in;
//   * puts a back control in the header;
//   * sends you back to the list if the session is missing or disappears.
//
// All three popups happen to share the same header markup (.header, .logo-icon,
// .brand-title, .badge, .badge-dot) and the same auth ids (#userBar,
// #logoutBtn, #loginView), so one file covers all three. build.js asserts those
// ids still exist, so a marketplace renaming one fails the build rather than
// silently losing the control.

(function () {
  const CHOOSER = 'chooser.html';

  // Accent per marketplace, matching the row marks on the marketplace list so
  // the colour you clicked carries through into the panel.
  const THEME = {
    amazon: { name: 'Amazon', accent: '#f59e0b', onAccent: '#1a1200' },
    meesho: { name: 'Meesho', accent: '#ec4899', onAccent: '#ffffff' },
    myntra: { name: 'Myntra', accent: '#6366f1', onAccent: '#ffffff' },
  };

  const id = (location.pathname.match(/(amazon|meesho|myntra)_popup\.html/) || [])[1];
  const theme = THEME[id] || { name: '', accent: '#64748b', onAccent: '#ffffff' };

  // ── Styles ────────────────────────────────────────────────────────────────
  // Injected rather than edited into each popup.html so the marketplace markup
  // stays verbatim. This <style> is appended after the popup's own, so equal
  // specificity already wins; !important is used only where the original sets
  // the property inline.
  const style = document.createElement('style');
  style.textContent = `
    #logoutBtn { display: none !important; }
    #loginView { display: none !important; }

    /* ── Unified header ─────────────────────────────────────────────────── */
    .header {
      background: #0f172a;
      padding: 0 12px;
      min-height: 46px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 9px;
      position: relative;
      overflow: visible;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      box-shadow: inset 0 -2px 0 0 ${theme.accent};
    }
    .header .logo-icon {
      width: 22px; height: 22px;
      border-radius: 6px;
      flex-shrink: 0;
      box-shadow: none;
    }
    .header .brand-title {
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.1px;
      line-height: 1.2;
      color: #fff;
    }
    /* Amazon is the only one with a subtitle; drop it so all three match. */
    .header .brand-sub { display: none; }

    .header .badge {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 5px;
      background: ${theme.accent};
      border: 0;
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 9px; font-weight: 700;
      letter-spacing: 0.5px; text-transform: uppercase;
      color: ${theme.onAccent};
      flex-shrink: 0;
      box-shadow: none;
    }
    .header .badge-dot {
      width: 4px; height: 4px; border-radius: 50%;
      background: currentColor;
      opacity: 0.5;
      flex-shrink: 0;
    }

    /* Meesho's download-history button lives in the header too. */
    .header .header-icon-btn {
      background: rgba(255,255,255,0.08);
      border: 0;
      border-radius: 5px;
      color: rgba(255,255,255,0.8);
      padding: 5px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      margin-left: 0;
    }
    .header .header-icon-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }

    /* ── Unified account row ────────────────────────────────────────────── */
    /* The three used different padding (8px 18px vs 6px 16px), avatar sizes
       (27px vs 24px) and tinted backgrounds. Aligned to the header's 12px
       gutter so the logo, avatar and content below share one left edge. */
    .user-bar {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 12px;
      background: #f8fafc;
      border-bottom: 1px solid #e9edf2;
    }
    .user-bar .user-avatar {
      width: 26px; height: 26px;
      border-radius: 50%;
      flex-shrink: 0;
      background: ${theme.accent};
      color: ${theme.onAccent};
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.2px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: none;
    }
    .user-bar .user-meta {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      gap: 1px;
      line-height: 1.25;
    }
    .user-bar .user-name {
      font-size: 12px; font-weight: 600; color: #111827;
    }
    .user-bar .user-email {
      font-size: 10.5px; color: #6b7280;
    }
    /* Hidden by default in Amazon's own CSS; only restyled for when it shows. */
    .user-bar .user-tenant {
      font-size: 10px; font-weight: 700; color: ${theme.accent};
      letter-spacing: 0.2px;
    }

    /* ── Back control (in the header, left of the logo) ──────────────────── */
    .se-back {
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.08);
      border: 0; border-radius: 5px;
      cursor: pointer;
      color: rgba(255,255,255,0.8);
      width: 22px; height: 22px;
      padding: 0;
      flex-shrink: 0;
      margin-right: -2px;
    }
    .se-back:hover { background: rgba(255,255,255,0.18); color: #fff; }
    .se-back svg { display: block; }
  `;
  document.head.appendChild(style);

  // ── Header contents ───────────────────────────────────────────────────────
  function decorateHeader() {
    const header = document.querySelector('.header');
    if (!header || header.querySelector('.se-back')) return;

    // Back control, first item in the header.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'se-back';
    btn.title = 'Back to all marketplaces';
    btn.setAttribute('aria-label', 'Back to all marketplaces');
    btn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 18 9 12 15 6"/></svg>';
    btn.addEventListener('click', () => {
      window.location.href = CHOOSER;
    });
    header.insertBefore(btn, header.firstChild);

    // Normalise the badge label. Meesho's said "Supplier Tool" while the other
    // two said their marketplace name; all three now name their marketplace.
    // The dot is preserved - only the text alongside it is replaced.
    const badge = header.querySelector('.badge');
    if (badge && theme.name) {
      const dot = badge.querySelector('.badge-dot');
      badge.textContent = '';
      if (dot) badge.appendChild(dot);
      badge.appendChild(document.createTextNode(theme.name));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateHeader);
  } else {
    decorateHeader();
  }

  // ── Session guard ─────────────────────────────────────────────────────────
  // A panel is only reachable while signed in. `auth` is the shared Speed Ecom
  // session (deliberately not namespaced by se_shim.js), so this reads the same
  // record the marketplace's own code reads.
  function toChooser() {
    window.location.replace(CHOOSER);
  }

  chrome.storage.local
    .get('auth')
    .then((data) => {
      if (!data || !data.auth || !data.auth.token) toChooser();
    })
    .catch(() => {});

  // Also cover the session going away while the panel is open (expiry, or a
  // logout performed from the marketplace list in another popup).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.auth) return;
    const next = changes.auth.newValue;
    if (!next || !next.token) toChooser();
  });
})();
