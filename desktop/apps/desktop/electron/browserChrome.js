const fs = require('fs')
const path = require('path')
const styles = fs.readFileSync(path.join(__dirname, 'browserTheme.css'), 'utf8')
const icons = {
  movies: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
  tvshows: '<rect x="2" y="6" width="20" height="14" rx="3"/><path d="m8 2 4 4 4-4"/>',
  surprise: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  continue: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
  getapp: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  school: '<path d="m2 8 10-5 10 5-10 5Zm4 3v6l6 3 6-3v-6M22 8v7"/>',
  suggest: '<path d="M8 17h8m-7 4h6M8 14a7 7 0 1 1 8 0v3H8Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 15v6h18v-6"/>',
  admin: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-4 10 3 3 5-6"/>',
  security: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  playlists: '<path d="M3 6h12M3 12h12M3 18h7"/><path d="M17 14v6l4-3Z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  apikeys: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 2 2"/>',
  audiobooks: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-.8-.5-1.4-.5-2.2 0-1 .8-1.8 1.8-1.8H18a3 3 0 0 0 3-3c0-5-4-9-9-9Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="7.5" r="1"/>'
}
icons.surprise = '<path d="M3 7h3c4 0 8 10 12 10h3m-4-4 4 4-4 4M3 17h3c2 0 3-2 4-3m4-4c1-2 2-3 4-3h3m-4-4 4 4-4 4"/>'
icons.livetv = '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="m8 3 4 4 4-4M12 11v5m-2.5-2.5h5"/>'
icons.more = '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
icons.search = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'
const labels = {movies:'Movies',tvshows:'TV Shows',music:'Music',audiobooks:'Audiobooks',playlists:'Playlists',surprise:'Discover',continue:'Continue Watching',livetv:'Live TV',getapp:'Get the Apps',school:'BeeboSchool',suggest:'Suggestions',apikeys:'API keys',appearance:'Appearance',security:'Account security',upload:'Upload',admin:'Admin'}
function brand() {
  return '<a class="beebo-brand" href="/" aria-label="Beebo home"><span class="beebo-mark" aria-hidden="true">b</span><span class="beebo-wordmark">beebo<small>ENTERTAINMENT</small></span></a>'
}
function sidebar(sections, active) {
  const order = require('./prefsRender').webNav(['movies','tvshows','music','audiobooks','livetv','continue','playlists','surprise','school','getapp','suggest','apikeys','appearance','security','upload','admin'])
  const links = order.map(key => sections.find(s => s.key === key)).filter(Boolean).map(s =>
    `${s.key === 'movies' ? '<div class="beebo-nav-label">YOUR LIBRARY</div>' : s.key === 'getapp' ? '<div class="beebo-nav-label">MORE FROM BEEBO</div>' : ''}<a href="${s.href}" class="beebo-nav-link"${s.key === active ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[s.key] || icons.movies}</svg><span>${labels[s.key] || s.label}</span></a>`
  ).join('')
  return `<aside class="beebo-sidebar" id="beebo-navigation" data-section="${active}" aria-label="Beebo navigation">${brand()}<button class="beebo-dismiss" type="button" aria-label="Close navigation">×</button><nav aria-label="Library">${links}</nav><div class="beebo-sidebar-foot"><strong>Your collection. Your screen.</strong>Make yourself comfortable.</div></aside>`
}
function icon(key) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key] || icons.movies}</svg>` }
function mobileHeader(active) {
  const tabs = [['movies', '/', 'Movies'], ['tvshows', '/tvshows', 'TV'], ['continue', '/continue', 'Continue'], ['surprise', '/surprise', 'Surf']]
  const title = active === 'surprise' ? 'Surf' : labels[active] || 'Beebo Entertainment'
  return `<header class="beebo-mobilebar"><a class="beebo-app-home" href="/" aria-label="Beebo home"><span class="beebo-mark" aria-hidden="true">b</span></a><div class="beebo-app-heading"><span>BEEBO ENTERTAINMENT</span><strong>${title}</strong></div><button class="beebo-search-button" type="button" aria-label="Search titles" hidden>${icon('search')}</button></header>
    <nav class="beebo-bottomnav" aria-label="Main tabs">${tabs.map(([key, href, label]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}><span class="beebo-tab-icon">${icon(key)}</span><span>${label}</span></a>`).join('')}<button class="beebo-menu${tabs.some(t => t[0] === active) ? '' : ' beebo-tab-selected'}" type="button" aria-label="More navigation" aria-controls="beebo-navigation" aria-expanded="false"><span class="beebo-tab-icon">${icon('more')}</span><span>More</span></button></nav><button class="beebo-scrim" type="button" tabindex="-1" aria-label="Close navigation"></button>`
}
const script = `
(() => {
  const menu = document.querySelector('.beebo-menu'), nav = document.getElementById('beebo-navigation');
  if (!menu || !nav) return;
  const close = nav.querySelector('.beebo-dismiss'), scrim = document.querySelector('.beebo-scrim');
  const main = document.getElementById('beebo-content'), mobile = window.matchMedia('(max-width:860px)');
  const header = document.querySelector('.beebo-mobilebar'), tabs = document.querySelector('.beebo-bottomnav');
  function toggle(open, restore) {
    document.body.classList.toggle('beebo-menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    if (main) main.inert = open;
    if (header) header.inert = open;
    if (tabs) tabs.inert = open;
    if (open) { nav.setAttribute('role', 'dialog'); nav.setAttribute('aria-modal', 'true'); }
    else { nav.removeAttribute('role'); nav.removeAttribute('aria-modal'); }
    if (open) close.focus(); else if (restore) menu.focus();
  }
  menu.addEventListener('click', () => toggle(true));
  close.addEventListener('click', () => toggle(false, true));
  scrim.addEventListener('click', () => toggle(false, true));
  mobile.addEventListener('change', () => toggle(false));
  document.addEventListener('keydown', e => {
    if (!document.body.classList.contains('beebo-menu-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); toggle(false, true); }
    if (e.key === 'Tab') {
      const entries = [...nav.querySelectorAll('a,button')].filter(el => el.offsetParent !== null);
      const first = entries[0], last = entries[entries.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Keep the phone search in the same position as the Android Movies/TV screens.
  const search = document.getElementById('q') || document.getElementById('camp-search');
  const searchButton = document.querySelector('.beebo-search-button');
  if (search && searchButton) {
    searchButton.hidden = false;
    searchButton.addEventListener('click', () => { search.scrollIntoView({block:'center'}); search.focus({preventScroll:true}); });
  }
  if (search && search.id === 'q' && main) {
    const position = document.createComment('Search position'); search.before(position);
    function positionSearch() {
      if (mobile.matches) { const top = main.querySelector('.topbar'); if (top) top.after(search); }
      else position.after(search);
    }
    positionSearch(); mobile.addEventListener('change', positionSearch);
  }
  // Android keeps sign-out in the app bar; keep the same real link on phones.
  const logout = main && main.querySelector('.topbar a[href="/logout"]');
  if (logout && header) {
    const original = document.createComment('Sign-out position'); logout.before(original);
    const originalClass = logout.className, originalHtml = logout.innerHTML;
    function positionLogout() {
      if (mobile.matches) {
        header.append(logout); logout.classList.add('beebo-mobile-logout');
        logout.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v16h5m5-12 4 4-4 4m-6-4h10"/></svg><span>Log out</span>';
      } else { original.after(logout); logout.className = originalClass; logout.innerHTML = originalHtml; }
    }
    positionLogout(); mobile.addEventListener('change', positionLogout);
  }
  // Hide empty letter groups after searching, so the A–Z index never jumps to a blank row.
  if (search) search.addEventListener(search.id === 'camp-search' ? 'beebo:filtered' : 'input', () => {
    document.querySelectorAll('[id^="letter-"]').forEach(section => {
      const cards = [...section.querySelectorAll('.card[data-name]')];
      if (!cards.length) return;
      section.hidden = cards.every(card => card.hidden || card.style.display === 'none');
      document.querySelectorAll('.beebo-alphabet a').forEach(link => {
        if (link.getAttribute('href') === '#' + section.id) {
          if (section.hidden) { link.setAttribute('aria-disabled','true'); link.setAttribute('tabindex','-1'); }
          else { link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); }
        }
      });
    });
  });
  document.querySelectorAll('.beebo-alphabet a').forEach(link => link.addEventListener('click', e => {
    if (link.getAttribute('aria-disabled') === 'true') e.preventDefault();
  }));
})();`
const playerStyles = `
  #bar{padding:14px 18px 28px;gap:9px;background:linear-gradient(#0b1327ed,#0b132788,transparent)}
  #bar .title{font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;letter-spacing:.1px}
  .pbtn{border-radius:9px;padding:9px 12px;min-height:38px;background:#102039c9;border-color:#6880ab80;backdrop-filter:blur(10px);text-decoration:none}
  .pbtn:hover{border-color:#d4af37;background:#483079dc}
  :where(button,a):focus-visible{outline:3px solid #d4af37;outline-offset:3px}
  #upnext,#toast{background:#101c32f5;border-color:#706094;border-radius:14px}
  #upnext .un-btn.primary,#resumeprompt .rp-btn.primary{background:linear-gradient(115deg,#7144c3,#355997);border-color:#a88cdb}
  @media(max-width:600px){#bar{padding:10px 12px 26px;gap:7px}.pbtn{font-size:12px;padding:8px 10px}}
  @media(prefers-reduced-motion:reduce){#bar,.pbtn{transition:none}}
`
module.exports = { styles, sidebar, brand, mobileHeader, script, playerStyles, labels }
