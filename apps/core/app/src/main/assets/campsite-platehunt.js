// ---- Plate & Sign Hunt (Family Pack A) -----------------------------------------------------
// Inlined into campsite-games.html at the PAGE_PACKS marker, so it runs INSIDE the page's closure and
// uses its helpers (el, button, send, pick, render, app, state, sel, nameOf, campChoice). It is only
// drawing: every rule, every count and every name comes from the host in r.plates.
//
// Safety and privacy, as this page keeps them:
//  - Every string a guest could have typed (a nickname) is put on the page with textContent, through
//    el(). This file never builds HTML from a string and never evaluates text as code (a unit test
//    checks for the browser calls that would).
//  - The page never asks for the camera, the microphone or the location, and never sends a picture.
//  - "For passengers only, never the driver" is on the lobby, the round and the how-to-play card.
RULES.plates = {
  players: '1 or more, each on their own phone (or just one phone)',
  goal: 'Spot every state, province or letter on the list before you arrive. For passengers only, never the driver.',
  steps: [
    'Look out of the window for a licence plate from the list, or a sign with the next letter.',
    'Tap it the moment you see it. In Team mode it is ticked for everyone and shows who spotted it.',
    'In Race mode you have your own list and only you see which ones you have ticked.',
    'Ticked by mistake? Tap the ticked one and choose Take it back. The leader can take back any tick.',
    'The leader taps Finish round when you want to stop, or the round ends when the whole list is found.'
  ],
  note: 'Nothing checks that you really saw it, so play honestly. Passengers only, never the driver. Nothing is recorded: no camera, no location.'
};
labels.plates = 'Spot every state, province or letter on the road. Passengers only, never the driver.';

const PLATE_UI = { region: 'usa', mode: 'team' };

(function plateStyles() {
  const css =
    '.ph-count{font-size:22px;font-weight:800;margin:6px 0}' +
    '.ph-bar{height:14px;border-radius:9px;background:#1b3050;border:1px solid var(--line);overflow:hidden;margin:4px 0 10px}' +
    '.ph-bar span{display:block;height:100%;background:linear-gradient(90deg,#8adab0,#efcc69);transition:width .4s}' +
    '.ph-next{font-size:20px;font-weight:700;margin:6px 0}' +
    '.ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:7px;margin:12px 0}' +
    '.ph-grid.ph-alpha{grid-template-columns:repeat(auto-fill,minmax(56px,1fr))}' +
    '.ph-cell{min-height:64px;min-width:0;padding:6px 3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;line-height:1.15;overflow-wrap:anywhere;transition:background .35s,border-color .35s,transform .35s}' +
    '.ph-cell b{font-size:20px;letter-spacing:.5px}' +
    '.ph-cell small{font-size:11px;color:var(--muted)}' +
    '.ph-cell.on{background:linear-gradient(145deg,#2f6b52,#1c4a46);border-color:var(--green);color:#fff}' +
    '.ph-cell.on small{color:#d6f3e4}' +
    '.ph-cell:disabled{opacity:.55}.ph-cell.on:disabled{opacity:1}' +
    '.ph-cheer{padding:16px;margin:12px 0;border-radius:16px;border:2px solid var(--gold);background:linear-gradient(150deg,#4a3a12,#233d32);font-size:22px;font-weight:800;text-align:center}' +
    '@media(prefers-reduced-motion:no-preference){.ph-cheer{animation:ph-pop .7s ease-out}.ph-cell.on{animation:ph-fill .5s ease-out}}' +
    '@keyframes ph-pop{0%{transform:scale(.85);opacity:0}70%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}' +
    '@keyframes ph-fill{0%{transform:scale(.9)}100%{transform:scale(1)}}' +
    '.ph-race li{margin:3px 0}';
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();

function plateSetupText() { return 'region=' + PLATE_UI.region + ';mode=' + PLATE_UI.mode; }

PACK_A.lobby.plates = function (r, owner) {
  app.append(
    el('p', r.blurb || labels.plates, 'muted'),
    el('p', 'For passengers only, never the driver. Nothing is recorded: no camera, no location. Nothing needs the internet.', 'notice')
  );
  if (owner) {
    const box = el('div', null, 'panel');
    box.append(el('strong', 'Host settings'));
    campChoice(box, 'What to look for', [
      ['usa', 'USA (50 states + DC)'],
      ['canada', 'Canada (10 provinces + 3 territories)'],
      ['both', 'USA + Canada'],
      ['alphabet', 'Alphabet signs A to Z']
    ], () => PLATE_UI.region, v => { PLATE_UI.region = v; });
    campChoice(box, 'How to play', [
      ['team', 'Team: one shared list'],
      ['race', 'Race: everyone has their own list']
    ], () => PLATE_UI.mode, v => { PLATE_UI.mode = v; });
    app.append(box);
    app.append(button('Start round', () => send('start', { text: plateSetupText() }), false, 'primary'));
  } else {
    app.append(el('p', nameOf(r, r.owner) + ' will start the round.'));
  }
};

PACK_A.draw.plates = function (r, c) {
  const p = r.plates;
  if (!p) { app.append(el('p', 'Getting the list ready...', 'muted')); return; }
  const owner = c.owner, playing = c.playing, finished = c.finished, active = c.active;
  const team = p.mode === 'team';
  const marked = i => team ? !!(p.team && p.team[i]) : (p.mine || []).indexOf(i) >= 0;
  const markedIdx = p.items.map((_, i) => i).filter(marked);
  const lastMarked = markedIdx.length ? markedIdx[markedIdx.length - 1] : -1;

  app.append(el('p', p.note, 'notice'));

  // How far along, in words and as a bar (the bar is the "map fills in" part).
  const count = el('div', p.found + ' of ' + p.total + ' ' + p.noun, 'ph-count');
  const bar = el('div', null, 'ph-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Spotted so far');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(p.total));
  bar.setAttribute('aria-valuenow', String(p.found));
  const fill = el('span');
  fill.style.width = Math.round(100 * p.found / Math.max(1, p.total)) + '%';
  bar.append(fill);
  app.append(count, bar);
  if (p.complete) app.append(el('div', 'Every one found! What a car.', 'ph-cheer'));
  if (p.ordered && playing && p.next >= 0) app.append(el('p', 'Look for: ' + p.items[p.next].name, 'ph-next'));

  // A race shows how far along everybody is, and nothing more: their lists are theirs.
  if (!team && (p.progress || []).length > 1) {
    const list = el('ul', null, 'ph-race');
    p.progress.forEach(q => list.append(el('li', q.name + (q.id === state.you ? ' (you)' : '') + ': ' + q.found + ' of ' + p.total)));
    app.append(list);
  }

  const canUndo = i => {
    if (!marked(i) || !playing || !active) return false;
    if (p.ordered && i !== lastMarked) return false;
    return team ? (p.teamBy[i] === state.you || owner) : true;
  };
  const grid = el('div', null, 'ph-grid' + (p.ordered ? ' ph-alpha' : ''));
  p.items.forEach((it, i) => {
    const on = marked(i);
    const by = team && on ? p.team[i] : '';
    let action = null;
    let off = true;
    if (playing && active) {
      if (!on && (!p.ordered || i === p.next)) { action = () => send('spot', { cell: i }); off = false; }
      else if (canUndo(i)) { action = () => pick({ kind: 'undo', cell: i, game: r.game, round: r.round, phase: r.phase }); off = false; }
    }
    const b = button('', action || (() => {}), off, 'ph-cell' + (on ? ' on' : ''));
    b.append(el('b', it.abbr), el('small', by || (p.ordered ? '' : it.name)));
    b.setAttribute('aria-label', it.name + (on ? ', spotted' + (by ? ' by ' + by : '') : ', not spotted yet'));
    grid.append(b);
  });
  app.append(grid);

  // Taking a tick back is two taps on purpose: on a bumpy road one stray tap must not undo a find.
  if (sel && sel.kind === 'undo' && playing) {
    const it = p.items[sel.cell];
    const box = el('div', null, 'panel');
    box.append(el('strong', 'Take back ' + it.name + '?'));
    row(box,
      button('Yes, take it back', () => send('unspot', { cell: sel.cell }), false, 'primary'),
      button('Keep it', () => pick(null)));
    app.append(box);
  }

  if (playing && owner) {
    if (sel && sel.kind === 'finish') {
      const box = el('div', null, 'panel');
      box.append(el('strong', 'Finish the round now?'));
      row(box,
        button('Yes, finish', () => send('finish'), false, 'primary'),
        button('Keep looking', () => pick(null)));
      app.append(box);
    } else {
      app.append(button('Finish round', () => pick({ kind: 'finish', game: r.game, round: r.round, phase: r.phase })));
    }
  }

  if (finished) {
    app.append(el('h2', team ? 'Round over: spotted ' + p.found + ' of ' + p.total + ' ' + p.noun : 'Round over'));
    if (team) {
      const missing = p.items.filter((_, i) => !marked(i)).map(it => it.name);
      if (missing.length) app.append(el('p', 'Still to find: ' + missing.join(', '), 'muted'));
    }
    if (owner) {
      app.append(button('Play again', () => send('start', { text: 'region=' + p.region + ';mode=' + p.mode }), false, 'primary'));
      app.append(button('Change the list', () => send('leave')));
    } else {
      app.append(el('p', nameOf(r, r.owner) + ' can start the next round.'));
    }
  }
};
