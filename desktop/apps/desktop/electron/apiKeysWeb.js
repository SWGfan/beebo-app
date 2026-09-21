'use strict'
// "My API keys": the page where anyone with an account makes and removes their own keys
// (docs/PUBLIC-API.md). Same rules as POST /api/me/api-keys/*: only the scopes their account may
// grant, only their own keys, only over a secure connection because the secret is shown once.
// The page posts JSON to /my-api-keys (see streamServer.js); the secret appears in that one
// response and nowhere in the page source.

const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const SCOPE_LABELS = {
  library: ['Library', 'Movies, TV shows, collections and what was added recently.'],
  history: ['History', 'Your own Continue Watching and viewing history.'],
  'now-playing': ['Now playing', 'Who is watching what right now, and the live event stream.'],
  metrics: ['Metrics', 'The Prometheus scrape (only while the owner has metrics switched on).']
}

const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never')

function pageBody({ keys = [], scopes = [], maxKeys = 10, defaultRatePerMinute = 120, secure = true, restricted = false, rateMin = 10, rateMax = 1200 } = {}) {
  if (restricted) {
    return `<main style="max-width:760px;margin:32px auto;padding:24px"><p class="muted">YOUR PROFILE</p><h1>API keys</h1>
      <p>API keys are not available on a profile with parental limits.</p></main>`
  }
  const boxes = scopes.map((s) => {
    const [label, blurb] = SCOPE_LABELS[s] || [s, '']
    return `<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 8px"><input type="checkbox" name="scope" value="${escape(s)}" ${s === 'library' ? 'checked' : ''} style="margin-top:4px;width:auto"><span><strong>${escape(label)}</strong><span class="muted" style="display:block;font-size:13px">${escape(blurb)}</span></span></label>`
  }).join('')
  const rows = keys.map((k) => `<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;padding:12px 0;border-top:1px solid #35445f">
      <div style="flex:1 1 240px;min-width:0"><div style="font-weight:700;word-break:break-word">${escape(k.name)}</div>
        <div class="muted" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${escape(k.hint)}</div>
        <div class="muted" style="font-size:13px;margin-top:4px">Reads: ${escape((k.scopes || []).map((s) => (SCOPE_LABELS[s] || [s])[0]).join(', ') || 'nothing')} · up to ${escape(k.ratePerMinute)} requests a minute · made ${escape(when(k.createdAt))} · last used ${escape(when(k.lastUsedAt))}</div></div>
      <button type="button" class="btn key-remove" data-id="${escape(k.id)}">Remove key</button></div>`).join('')
  return `<main style="max-width:760px;margin:32px auto;padding:24px">
    <p class="muted">YOUR PROFILE</p><h1>API keys</h1>
    <section style="background:#101c31;border:1px solid #35445f;border-radius:18px;padding:24px;color:#f5f3ff">
      <p>An API key lets a program you run (a dashboard, Home Assistant, a script) read parts of Beebo <strong>as you</strong>, and nothing else: it can never sign in, change anything or open Admin. Each key can be removed on its own, and stops working the moment you do.</p>
      ${secure ? '' : '<p style="color:#e2c16a"><strong>This page is not on a secure connection.</strong> A new key is shown once and is a password, so keys can only be made over https. Open this page through your Beebo web address instead.</p>'}
      <form id="key-form" ${secure ? '' : 'style="opacity:.5;pointer-events:none"'}>
        <label style="display:block;margin:0 0 12px"><div class="muted" style="margin-bottom:6px">Name (what it is for)</div>
          <input id="key-name" type="text" maxlength="60" required placeholder="Home Assistant" style="max-width:340px;width:100%;box-sizing:border-box"></label>
        <div class="muted" style="margin-bottom:6px">It may read</div>${boxes}
        <label style="display:block;margin:12px 0"><div class="muted" style="margin-bottom:6px">Requests per minute (empty for ${escape(defaultRatePerMinute)})</div>
          <input id="key-rate" type="number" min="${escape(rateMin)}" max="${escape(rateMax)}" step="1" style="width:140px"></label>
        <button type="submit" class="btn" id="key-make">Make the key</button>
        <p class="muted" style="font-size:13px">Up to ${escape(maxKeys)} keys.</p>
      </form>
      <div id="key-shown" role="status" aria-live="polite" style="display:none;margin-top:16px;padding:14px;border:1px solid #4f9dff;border-radius:12px">
        <strong>Copy this key now. It can't be shown again.</strong>
        <div id="key-token" style="font-family:ui-monospace,Consolas,monospace;word-break:break-all;margin-top:8px;user-select:all"></div>
      </div>
      <p id="key-feedback" role="status" aria-live="polite"></p>
      <h2 style="font-size:18px;margin:22px 0 0">Your keys (${keys.length})</h2>
      ${rows || '<p class="muted">No API keys yet.</p>'}
    </section>
    <script>
      (() => {
        const feedback = document.getElementById('key-feedback');
        const post = async (payload) => {
          const response = await fetch('/my-api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) throw new Error(result.message || 'That did not work (' + (result.error || response.status) + ').');
          return result;
        };
        const form = document.getElementById('key-form');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          feedback.textContent = 'Making the key…';
          try {
            const scopes = [...form.querySelectorAll('input[name=scope]:checked')].map((box) => box.value);
            const rate = document.getElementById('key-rate').value;
            const result = await post({ action: 'create', name: document.getElementById('key-name').value, scopes, ...(rate ? { ratePerMinute: Number(rate) } : {}) });
            document.getElementById('key-token').textContent = result.token;
            document.getElementById('key-shown').style.display = 'block';
            feedback.textContent = 'Key made. It stays on this page until you leave it.';
            form.reset();
          } catch (error) { feedback.textContent = error.message; }
        });
        document.querySelectorAll('.key-remove').forEach((button) => button.addEventListener('click', async () => {
          button.disabled = true;
          try { await post({ action: 'revoke', id: button.dataset.id }); location.reload(); }
          catch (error) { feedback.textContent = error.message; button.disabled = false; }
        }));
      })();
    </script>
  </main>`
}

const MESSAGES = {
  bad_name: 'Give it a name (up to 60 characters) so you can tell it apart later.',
  bad_key_scope: 'Tick at least one thing this key may read.',
  scope_not_allowed: 'Your account cannot put that on a key.',
  bad_rate: 'That request limit is not a whole number in the allowed range.',
  too_many_keys: 'That is the most keys you can hold. Remove one you no longer use first.',
  not_found: 'That key is already gone.',
  https_required: 'Keys can only be made over a secure (https) connection.',
  not_available: 'API keys are not available on this profile.'
}

module.exports = { pageBody, MESSAGES }
