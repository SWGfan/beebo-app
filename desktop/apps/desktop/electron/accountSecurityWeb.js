'use strict'
// ============================================================================
// accountSecurityWeb.js - the web pages for the account-security bundle.
// ----------------------------------------------------------------------------
// Plain HTML strings (streamServer wraps them in its page() shell), like viewingPrivacyWeb.js:
//   twoFactorLoginBody   the second step after a right password
//   resetWithCodeBody    "the owner gave me a one-time code"
//   securityBody         /account/security: two-factor, password, signed-in devices, own activity
// Nothing here trusts what it is given: every value goes through esc(), and the scripts write to the
// page with textContent only.
// ============================================================================
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function twoFactorLoginBody({ challenge, error, action = '/login/2fa' } = {}) {
  return `<div class="wrap">
      <h2>Two-step sign-in</h2>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <p class="muted">Enter the 6-digit code from your authenticator app. Lost your phone? Type one of your recovery codes instead.</p>
      <form method="POST" action="${esc(action)}" autocomplete="off">
        <input type="hidden" name="challenge" value="${esc(challenge || '')}">
        <input name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="123456 or a recovery code" required maxlength="32" autofocus>
        <button type="submit">Verify</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Start over</a></p>
    </div>`
}

const STRENGTH_SCRIPT = `
  function beeboStrength(input, meter, endpoint, extra) {
    var timer = null, seq = 0;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var mine = ++seq;
      timer = setTimeout(function () {
        if (!input.value) { meter.textContent = ''; return; }
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ password: input.value }, extra ? extra() : {})) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (mine !== seq || !d) return;
            var hint = d.issues && d.issues.length ? d.issues[0].message : (d.suggestions && d.suggestions[0]) || '';
            meter.textContent = (d.label || '') + (hint ? ' - ' + hint : '');
            meter.style.color = d.ok ? (d.score >= 3 ? '#9dffb8' : '#ffd98a') : '#ff9d9d';
          }).catch(function () {});
      }, 250);
    });
  }`

// A strength line + script to put under a password box on a plain page (sign-up, reset link).
// Talks to POST /account/password-check on the same server; nothing typed goes anywhere else.
function strengthMeter({ inputName = 'password', usernameName } = {}) {
  return `<div id="beebo-pw-meter" class="muted" role="status" aria-live="polite" style="min-height:1.4em;margin:-4px 0 12px"></div>
    <script>${STRENGTH_SCRIPT}
      (function () {
        var input = document.querySelector('[name=${inputName}]');
        var user = ${usernameName ? `document.querySelector('[name=${usernameName}]')` : 'null'};
        if (input) beeboStrength(input, document.getElementById('beebo-pw-meter'), '/account/password-check', function () { return user ? { username: user.value } : {}; });
      })();
    </script>`
}

function resetWithCodeBody({ error, username, done } = {}) {
  if (done) {
    return `<div class="wrap">
      <h2>Password updated</h2>
      <div class="success">You can sign in with your new password now. Every device that was signed in has been signed out.</div>
      <a class="btn" href="/login">Sign in</a>
    </div>`
  }
  return `<div class="wrap">
      <h2>Reset with a one-time code</h2>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <p class="muted">The owner of this server can make you a one-time reset code. It expires quickly and works once.</p>
      <form method="POST" action="/reset-with-code" autocomplete="off">
        <input name="username" placeholder="Username" value="${esc(username || '')}" autocomplete="username" autocapitalize="none" autocorrect="off" required maxlength="40">
        <input id="reset-code" name="code" placeholder="Reset code (XXXX-XXXX-XXXX)" autocapitalize="characters" spellcheck="false" required maxlength="32">
        <input id="reset-pass" name="password" type="password" placeholder="New password" autocomplete="new-password" required minlength="8" maxlength="256">
        <div id="reset-meter" class="muted" role="status" aria-live="polite" style="min-height:1.4em;margin:-4px 0 12px"></div>
        <button type="submit">Set new password</button>
      </form>
      <p class="muted" style="margin-top:18px;"><a href="/login" style="color:#4f9dff;">Back to sign in</a></p>
      <script>${STRENGTH_SCRIPT}
        (function () {
          // A link from the owner can carry the code after a # (never sent to the server or written to logs).
          var m = /(?:^|[#&])c=([A-Za-z0-9-]{4,40})/.exec(location.hash || '');
          if (m) { document.getElementById('reset-code').value = m[1]; history.replaceState(null, '', location.pathname + location.search); }
          beeboStrength(document.getElementById('reset-pass'), document.getElementById('reset-meter'), '/account/password-check', function () { return { username: document.querySelector('[name=username]').value }; });
        })();
      </script>
    </div>`
}

function fmtWhen(ms) {
  return ms ? new Date(ms).toISOString() : ''
}

// The signed-in person's page. `info` is accountSecurityApi.overview(); apiBase is where its JSON lives.
function securityBody({ info, apiBase, required, weakFlag } = {}) {
  // info carries sign-in device labels and browser names (attacker-influenced): jsonForScript escapes < > & and U+2028/9.
  const boot = require('./httpSecurity').jsonForScript({ apiBase, info })
  return `<main style="max-width:780px;margin:24px auto;padding:0 16px 48px" id="acct-sec">
  <p class="muted">YOUR ACCOUNT</p>
  <h1 style="margin-top:0">Account security</h1>
  ${required ? `<div class="error" style="font-size:15px"><strong>Two-factor is required.</strong> The owner of this server requires admins to use two-factor sign-in. Turn it on below to keep using the site.</div>` : ''}
  <div id="acct-status" role="status" aria-live="polite" class="muted" style="min-height:1.4em"></div>
  <style>
    #acct-sec section { background:#141a26; border:1px solid #2a3348; border-radius:14px; padding:20px; margin:16px 0; }
    #acct-sec h3 { margin:0 0 6px; }
    #acct-sec label { display:block; font-size:13px; color:#aab3c5; margin:10px 0 4px; }
    #acct-sec input { margin-bottom:6px; }
    #acct-sec .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    #acct-sec .pill { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; font-weight:700; }
    #acct-sec .on { background:#1f3a2a; color:#9dffb8; } #acct-sec .off { background:#3a2f1f; color:#ffd98a; }
    #acct-sec table { width:100%; border-collapse:collapse; font-size:14px; } #acct-sec td, #acct-sec th { text-align:left; padding:8px 6px; border-bottom:1px solid #232b3d; vertical-align:top; }
    #acct-sec .codes { font-family:ui-monospace,Consolas,monospace; font-size:16px; columns:2; background:#0b0f18; padding:14px; border-radius:10px; letter-spacing:1px; }
    #acct-sec button.small { padding:6px 12px; font-size:13px; }
    #acct-sec .danger { background:#7a2b31; }
    #acct-sec .qr svg { max-width:200px; height:auto; border-radius:8px; }
    #acct-sec code { background:#0b0f18; padding:2px 6px; border-radius:6px; word-break:break-all; }
  </style>

  <section id="tf-card">
    <h3>Two-factor sign-in <span id="tf-pill" class="pill"></span></h3>
    <p class="muted">Asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis, 1Password...) after your password. Someone who learns your password still cannot get in.</p>
    <div id="tf-body"></div>
  </section>

  <section id="pw-card">
    <h3>Change password</h3>
    <form id="pw-form" autocomplete="off">
      <label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password" maxlength="256" required>
      <label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" maxlength="256" required>
      <div id="pw-meter" class="muted" role="status" aria-live="polite" style="min-height:1.4em"></div>
      <div id="pw-code-wrap" hidden><label for="pw-code">Two-factor code</label><input id="pw-code" inputmode="text" autocomplete="one-time-code" maxlength="32"></div>
      <p class="muted">Changing it signs every other device out. Passwords on the list of most-used passwords are refused; nothing you type here is sent anywhere but this server.</p>
      <button type="submit">Change password</button>
    </form>
  </section>

  <section id="dev-card">
    <h3>Signed-in devices</h3>
    <p class="muted">Every browser and app that is signed in to your account. Anything you do not recognise: sign it out, then change your password.</p>
    <div id="dev-list"></div>
    <div class="row" style="margin-top:12px">
      <button class="small btn-secondary" id="dev-others" type="button">Sign out everywhere else</button>
      <button class="small danger" id="dev-all" type="button">Sign out everywhere, including here</button>
    </div>
  </section>

  <section id="act-card">
    <h3>Recent activity on your account</h3>
    <div id="act-list" class="muted"></div>
  </section>

  <script>
  (function () {
    var boot = ${boot};
    var api = boot.apiBase, info = boot.info;
    var $ = function (id) { return document.getElementById(id); };
    function el(tag, text, attrs) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    function say(msg, bad) { var s = $('acct-status'); s.textContent = msg || ''; s.style.color = bad ? '#ff9d9d' : '#9dffb8'; }
    function post(sub, body) {
      return fetch(api + '/' + sub, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Unexpected answer from the server.' }; }); });
    }
    function reload(msg) { return fetch(api).then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok) { info = d; render(); } if (msg) say(msg); }); }
    function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }

    function pwField(id, label, autocomplete) {
      var wrap = el('div'); wrap.appendChild(el('label', label, { for: id }));
      var i = el('input', null, { id: id, type: 'password', autocomplete: autocomplete, maxlength: '256' }); wrap.appendChild(i); return { wrap: wrap, input: i };
    }
    function codeField(id, label) {
      var wrap = el('div'); wrap.appendChild(el('label', label, { for: id }));
      var i = el('input', null, { id: id, autocomplete: 'one-time-code', maxlength: '32', inputmode: 'text', spellcheck: 'false' }); wrap.appendChild(i); return { wrap: wrap, input: i };
    }

    function showRecovery(codes, container) {
      container.textContent = '';
      container.appendChild(el('p', 'Recovery codes. Each one works once if you lose your phone. They are shown only now: save them somewhere safe (a password manager, or print them).'));
      var box = el('div', null, { class: 'codes' });
      codes.forEach(function (c) { box.appendChild(el('div', c)); });
      container.appendChild(box);
      var row = el('div', null, { class: 'row' }); row.style.marginTop = '10px';
      var dl = el('button', 'Download as a text file', { type: 'button', class: 'small btn-secondary' });
      dl.onclick = function () { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['Beebo Entertainment recovery codes for ' + info.user.username + '\\n\\n' + codes.join('\\n') + '\\n'], { type: 'text/plain' })); a.download = 'beebo-recovery-codes.txt'; a.click(); };
      var done = el('button', 'I have saved them', { type: 'button', class: 'small' });
      done.onclick = function () { reload('Two-factor is on.'); };
      row.appendChild(dl); row.appendChild(done); container.appendChild(row);
    }

    function renderTwoFactor() {
      var tf = info.twoFactor, body = $('tf-body'); body.textContent = '';
      var pill = $('tf-pill'); pill.textContent = tf.enabled ? 'ON' : 'OFF'; pill.className = 'pill ' + (tf.enabled ? 'on' : 'off');
      $('pw-code-wrap').hidden = !tf.enabled;
      if (!tf.enabled) {
        var pw = pwField('tf-pw', info.hasPassword ? 'Your password' : 'Your access code', 'current-password');
        var go = el('button', 'Turn on two-factor', { type: 'button' });
        body.appendChild(pw.wrap); body.appendChild(go);
        go.onclick = function () {
          go.disabled = true; say('Starting...');
          post('2fa/begin', { password: pw.input.value }).then(function (d) {
            go.disabled = false;
            if (!d.ok) { say(d.message || 'Could not start.', true); return; }
            say('');
            body.textContent = '';
            body.appendChild(el('p', '1. Scan this with your authenticator app (or type the key in by hand).'));
            var qr = el('div', null, { class: 'qr' }); qr.innerHTML = d.qrSvg || ''; body.appendChild(qr);
            var key = el('p', 'Key: '); key.appendChild(el('code', d.secretSpaced)); body.appendChild(key);
            body.appendChild(el('p', '2. Type the 6-digit code the app shows to finish.'));
            var c = codeField('tf-confirm', 'Code from the app'); body.appendChild(c.wrap);
            var fin = el('button', 'Finish', { type: 'button' }); body.appendChild(fin);
            fin.onclick = function () {
              fin.disabled = true;
              post('2fa/confirm', { code: c.input.value }).then(function (r) {
                fin.disabled = false;
                if (!r.ok) { say(r.message || 'That code did not work.', true); return; }
                say(r.message || ''); showRecovery(r.recoveryCodes || [], body);
              });
            };
          });
        };
      } else {
        body.appendChild(el('p', 'On since ' + new Date(tf.enabledAt || Date.now()).toLocaleDateString() + '. ' + tf.recoveryRemaining + ' recovery code' + (tf.recoveryRemaining === 1 ? '' : 's') + ' left.'));
        var pw2 = pwField('tf-pw2', 'Your password', 'current-password'), c2 = codeField('tf-code2', 'A current code from your app');
        body.appendChild(pw2.wrap); body.appendChild(c2.wrap);
        var row = el('div', null, { class: 'row' }); row.style.marginTop = '8px';
        var regen = el('button', 'Make new recovery codes', { type: 'button', class: 'small btn-secondary' });
        var off = el('button', 'Turn off two-factor', { type: 'button', class: 'small danger' });
        row.appendChild(regen); if (!(info.user.isAdmin && info.policy.requireForAdmins)) row.appendChild(off);
        body.appendChild(row);
        var out = el('div'); out.style.marginTop = '12px'; body.appendChild(out);
        regen.onclick = function () {
          post('2fa/recovery-codes', { password: pw2.input.value, code: c2.input.value }).then(function (r) {
            if (!r.ok) { say(r.message || 'Could not do that.', true); return; }
            say('New recovery codes made. The old ones no longer work.'); showRecovery(r.recoveryCodes || [], out);
          });
        };
        off.onclick = function () {
          if (!confirm('Turn off two-factor? Your account will be protected by your password alone.')) return;
          post('2fa/disable', { password: pw2.input.value, code: c2.input.value }).then(function (r) {
            if (!r.ok) { say(r.message || 'Could not turn it off.', true); return; }
            reload('Two-factor is off.');
          });
        };
      }
    }

    function renderDevices() {
      var list = $('dev-list'); list.textContent = '';
      if (!info.sessions.length) { list.appendChild(el('p', 'No listed devices. (Older sign-ins made before this list existed are not shown, but "sign out everywhere" ends them too.)', { class: 'muted' })); return; }
      var t = el('table'); var head = el('tr'); ['Device', 'From', 'Last active', 'Signed in', ''].forEach(function (h) { head.appendChild(el('th', h)); }); t.appendChild(head);
      info.sessions.forEach(function (s) {
        var tr = el('tr');
        tr.appendChild(el('td', s.device + (s.current ? ' (this device)' : '')));
        tr.appendChild(el('td', s.ip || 'unknown'));
        tr.appendChild(el('td', ago(s.lastSeenAt)));
        tr.appendChild(el('td', new Date(s.createdAt).toLocaleDateString()));
        var td = el('td'); var b = el('button', s.current ? 'Sign out' : 'Revoke', { type: 'button', class: 'small btn-secondary' });
        b.onclick = function () { post('sessions/revoke', { id: s.id }).then(function (r) { if (!r.ok) { say(r.message || 'Could not do that.', true); return; } if (s.current) { location.href = '/login'; return; } reload('Device signed out.'); }); };
        td.appendChild(b); tr.appendChild(td); t.appendChild(tr);
      });
      list.appendChild(t);
    }

    function renderActivity() {
      var box = $('act-list'); box.textContent = '';
      if (!info.events.length) { box.textContent = 'Nothing yet.'; return; }
      info.events.forEach(function (e) { var p = el('div', new Date(e.time).toLocaleString() + '  -  ' + e.label + (e.ip ? '  (' + e.ip + ')' : '')); p.style.padding = '3px 0'; box.appendChild(p); });
    }

    function render() { renderTwoFactor(); renderDevices(); renderActivity(); }
    render();

    ${STRENGTH_SCRIPT}
    beeboStrength($('pw-new'), $('pw-meter'), api + '/password-check');

    $('pw-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      post('password', { currentPassword: $('pw-cur').value, newPassword: $('pw-new').value, code: $('pw-code').value }).then(function (r) {
        if (!r.ok) { say(r.message || 'Could not change the password.', true); return; }
        $('pw-cur').value = ''; $('pw-new').value = ''; $('pw-code').value = ''; $('pw-meter').textContent = '';
        reload(r.message || 'Password changed.');
      });
    });
    $('dev-others').onclick = function () { post('sessions/revoke-all', {}).then(function (r) { if (!r.ok) { say(r.message || 'Could not do that.', true); return; } reload('Signed out ' + r.ended + ' other device' + (r.ended === 1 ? '' : 's') + '.'); }); };
    $('dev-all').onclick = function () { if (!confirm('Sign out of every device, including this one?')) return; post('sessions/revoke-all', { includeCurrent: true }).then(function (r) { if (r.ok) location.href = '/login'; else say(r.message || 'Could not do that.', true); }); };
  })();
  </script>
</main>`
}

module.exports = { twoFactorLoginBody, resetWithCodeBody, securityBody, strengthMeter, esc, fmtWhen }
