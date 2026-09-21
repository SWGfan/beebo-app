'use strict'
const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
function pageBody(info) {
  const available = info.hasPassword && (info.eligible || info.enabled)
  return `<main style="max-width:760px;margin:32px auto;padding:24px">
    <p class="muted">YOUR PROFILE</p><h1>Viewing privacy</h1>
    <section style="background:#101c31;border:1px solid #35445f;border-radius:18px;padding:24px;color:#f5f3ff">
      <form id="viewing-privacy-form">
        <label style="display:flex;gap:12px;align-items:center;font-size:20px;font-weight:700">
          <input id="private-history" type="checkbox" ${info.enabled ? 'checked' : ''} ${available ? '' : 'disabled'} style="width:24px;height:24px;accent-color:#9366f2"> Keep my viewing history private
        </label>
        <p>Hide your past and future movie and episode titles, playback progress and now-playing details from Beebo’s owner and administrator reports. Your own History and Continue Watching still work.</p>
        <p>The owner can still see bandwidth, device and connection status, stream counts and aggregate watch time to manage the household.</p>
        <p>Titles you deliberately share in a watch party, queue, request or report remain visible. This setting does not encrypt history against someone with direct access to the storage computer or erase previously exported copies.</p>
        <p>${escape(info.message)}</p>
        ${available ? `<label for="privacy-password">Confirm with your current Beebo password</label><input id="privacy-password" type="password" autocomplete="current-password" maxlength="256" required style="display:block;width:100%;box-sizing:border-box;margin:10px 0 16px;padding:14px;background:#080f20;color:#fff;border:1px solid #566888;border-radius:10px"><p class="muted">Changing this setting signs your other devices out. This device stays signed in. Keep access to your recovery email: the owner cannot reset a private profile’s password for you.</p><button type="submit" id="privacy-save" class="btn">Save privacy setting</button>` : ''}
        <p id="privacy-feedback" role="status" aria-live="polite"></p>
      </form>
    </section>
    <script>
      (() => {
        const form = document.getElementById('viewing-privacy-form');
        const button = document.getElementById('privacy-save');
        if (!button) return;
        form.addEventListener('submit', async event => {
          event.preventDefault(); button.disabled = true;
          const password = document.getElementById('privacy-password');
          const feedback = document.getElementById('privacy-feedback');
          feedback.textContent = 'Saving…';
          try {
            const response = await fetch('/viewing-privacy', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:document.getElementById('private-history').checked,password:password.value})});
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || 'Could not save. Sign in again if your session expired.');
            password.value = ''; location.reload();
          } catch (error) { password.value = ''; feedback.textContent = error.message || 'Could not save. Try again.'; button.disabled = false; }
        });
      })();
    </script>
  </main>`
}
module.exports = { pageBody }
