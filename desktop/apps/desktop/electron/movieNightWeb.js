'use strict'
// ============================================================================
// movieNightWeb.js - the pages of Movie Night: the TV screen, the phone page, and the reactions overlay.
// ----------------------------------------------------------------------------
// Self-contained HTML: no third-party scripts, fonts, images or CDNs, so it all works on a home network with
// no internet. The programs are in movieNightClients.js; this file wraps them in a page and holds the styles.
//
// 10-FOOT DESIGN (TV screen)
//   * sizes are in vh / vw so the layout scales from 720p to 4K; body text is about 2.3vh (25 px on a 1080p TV)
//     and never smaller than 1.8vh for anything that matters; the TMDB credit is the only small line
//   * near-black background, white text, an amber focus ring 0.6vh thick: every text / background pair is
//     above 7:1 contrast, and nothing is told by colour alone (each player has a colour AND a shape AND a name;
//     right / wrong are words and a tick or cross, not just green / red)
//   * 5% safe margins (TV overscan), no scrolling, no hover, everything reachable with the arrow keys and OK
//   * prefers-reduced-motion and prefers-contrast are honoured; the poster reveal is stepped, not animated
// ============================================================================

const clients = require('./movieNightClients')

const TV_PATH = '/movie-night/tv'
const API_PATH = '/movie-night-api'

/** JSON that is safe inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029')
}

const TV_CSS = `
:root{--bg:#0b0d12;--panel:#161a23;--panel2:#212838;--ink:#ffffff;--dim:#c9cfdb;--accent:#ffd43b;--good:#8ce99a;--bad:#ffa8a8;--line:#4b5568}
*{box-sizing:border-box}
html{font-size:2.3vh}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden}
.app{position:relative;width:100vw;height:100vh;display:flex;flex-direction:column;padding:3.5vh 5vw 2vh}
.top{display:flex;justify-content:space-between;align-items:center;min-height:6vh}
.brand{display:flex;align-items:baseline}
.logo{font-weight:800;letter-spacing:.18em;color:var(--accent);font-size:1.3rem}
.hostname{margin-left:1.2rem;color:var(--dim)}
.topright{display:flex;align-items:center}
.joinmini{display:flex;align-items:center;margin-right:1.2rem;color:var(--dim)}
.joinmini .jl{margin-right:.8rem;font-weight:700;color:var(--ink)}
.joinmini canvas{height:8vh;width:8vh;border-radius:.6vh}
.main{flex:1;min-height:0;display:flex;flex-direction:column}
.foot{padding-top:1vh;color:var(--dim);font-size:.78rem}
.h1{font-size:2.6rem;font-weight:800;margin:0 0 1.2vh}
.h2{font-size:1.7rem;font-weight:700;margin:0 0 1.2vh}
.h3{font-size:1.25rem;font-weight:700;margin:1.6vh 0 .8vh;color:var(--dim)}
.hint{color:var(--dim);font-size:1.05rem;margin-top:1vh}
.note{margin-top:1.2vh;padding:1vh 1.4vh;border:.3vh solid var(--accent);border-radius:1vh;color:var(--ink);font-size:1rem}
.loading{margin:auto;font-size:2rem;color:var(--dim)}
.btn{font:inherit;font-size:1.05rem;color:var(--ink);background:var(--panel2);border:.35vh solid var(--line);border-radius:1.2vh;padding:1.1vh 1.8vh;margin:.5vh .6vh .5vh 0;cursor:pointer;min-height:5.4vh;text-align:left}
.btn:focus{outline:.6vh solid var(--accent);outline-offset:.3vh;background:#2f3950;border-color:#fff}
.btn.primary{background:var(--accent);color:#111;font-weight:800;border-color:var(--accent)}
.btn.primary:focus{background:#fff;color:#000}
.btn.danger{border-color:var(--bad);color:var(--bad)}
.btn.small{font-size:.95rem;min-height:4.6vh;padding:.8vh 1.4vh}
.btn.wide{display:block;width:100%}
.btn.game{display:inline-block;width:47%;vertical-align:top;font-weight:700;font-size:1.25rem;min-height:9vh}
.btn.game .blurb{display:block;font-weight:400;font-size:.85rem;color:var(--dim);margin-top:.4vh}
.btn.game.off{opacity:.62;border-style:dashed}
.hostrow{margin-top:1.4vh;display:flex;flex-wrap:wrap}
.lobby{display:flex;flex:1;min-height:0}
.lobbyleft{width:36%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-right:2vw}
.lobbyright{flex:1;min-width:0;overflow:hidden}
.qr{background:#fff;border-radius:1.2vh}
.bigcode{font-family:Consolas,"Courier New",monospace;font-weight:800;font-size:4.6rem;letter-spacing:.22em;margin-top:1.4vh;color:var(--accent)}
.guests{display:flex;flex-wrap:wrap;min-height:8vh}
.badge{display:inline-flex;align-items:center;color:#111;font-weight:800;border-radius:5vh;padding:.5vh 1.4vh .5vh .9vh;margin:0 .9vh .9vh 0;font-size:1.15rem;max-width:100%}
.badge.big{font-size:1.5rem}
.badge .glyph{background:#111;color:#fff;border-radius:50%;width:1.7rem;height:1.7rem;display:inline-flex;align-items:center;justify-content:center;margin-right:.7vh;font-size:.95rem}
.badge .bn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge.away{opacity:.55}
.hostTag,.teamTag{margin-left:.9vh;background:#111;color:#fff;border-radius:1vh;padding:0 .8vh;font-size:.7rem;letter-spacing:.06em}
.featured{margin:1vh 0;font-size:1.3rem;font-weight:700;color:var(--accent)}
.sugg{color:var(--dim)}.sg{margin-right:1.2vh}
.ask,.vote,.result,.board,.reveal{display:flex;flex-direction:column;flex:1;min-height:0}
.qhead{display:flex;justify-content:space-between;font-size:1.2rem;color:var(--dim);margin-bottom:.6vh}
.qnum{font-weight:700;color:var(--ink)}
.qbody{display:flex;flex:1;min-height:0}
.qleft{width:26%;padding-right:2.2vw;display:flex;align-items:flex-start;justify-content:center}
.qright{flex:1;min-width:0}
.posterbox{width:100%;text-align:center}
.poster{max-width:100%;max-height:44vh;border-radius:1vh;border:.3vh solid var(--line);background:#000}
.posterbox.none{padding:6vh 1vw;border:.3vh dashed var(--line);border-radius:1vh;color:var(--dim)}
.prompt{font-size:2.1rem;font-weight:800;line-height:1.2;margin-bottom:1.6vh}
.clues{margin-bottom:1.4vh}.clue{font-size:1.35rem;margin:.5vh 0}.clue.dim{color:var(--dim)}
.opts{display:grid;grid-template-columns:1fr 1fr;grid-gap:1.6vh}
.opt{display:flex;align-items:center;background:var(--panel);border:.4vh solid var(--line);border-radius:1.4vh;padding:1.6vh 1.6vh;font-size:1.55rem;font-weight:700;min-height:11vh}
.opt .ol{flex:none;width:3.4rem;height:3.4rem;border-radius:50%;background:var(--ink);color:#111;display:inline-flex;align-items:center;justify-content:center;margin-right:1.4vh;font-size:1.5rem}
.opt .ph{width:7vh;height:7vh;object-fit:cover;border-radius:50%;margin-right:1.4vh;flex:none}
.opt .ph.tall{width:9vh;height:13.5vh;border-radius:.8vh;object-fit:cover}
.opt .ot{flex:1}
.opts.ba .opt{flex-direction:column;justify-content:center;text-align:center;padding:1.4vh}
.opts.ba .ol{margin:0 0 1vh 0}
.opts.ba .ph.tall{width:auto;height:27vh;margin:0 0 1vh 0;border-radius:.8vh}
.opts.ba .ot{flex:none}
.cd{display:flex;align-items:center;margin:.6vh 0 1.2vh}
.bar{flex:1;height:1.6vh;background:var(--panel2);border:.25vh solid var(--line);border-radius:1vh;overflow:hidden}
.fill{height:100%;width:100%;background:var(--accent)}
.cdnum{width:5rem;text-align:right;font-weight:800;font-size:1.5rem}
.paused{font-size:2.4rem;font-weight:800;text-align:center;color:var(--accent);padding:1vh;border:.5vh solid var(--accent);border-radius:1.4vh;margin-top:1vh}
.answer{font-size:2.8rem;font-weight:800;color:var(--good);margin:.4vh 0 1vh}
.results{display:flex;flex-wrap:wrap;margin-top:1vh}
.res{display:flex;align-items:center;width:48%;margin:0 2% .8vh 0;padding:.6vh 1vh;border-radius:1vh;border:.3vh solid var(--line);font-size:1.05rem}
.res.ok{border-color:var(--good)}.res.no{opacity:.85}.res.skip{opacity:.6;border-style:dashed}
.res .rmark{margin-left:auto;margin-right:1.2vh;font-weight:700}
.res .rpts{font-weight:800;min-width:4rem;text-align:right}
.lb{display:flex;flex-wrap:wrap;margin-top:.6vh;border-top:.3vh solid var(--line);padding-top:.8vh}
.lbrow{display:flex;align-items:center;margin-right:2vw;font-size:1rem}
.lbrow .rk{font-weight:800;margin-right:.8vh;min-width:2.4rem}
.lbrow .rpts{margin-left:.8vh;font-weight:800}
.lbrow.big{font-size:1.5rem;width:100%;padding:.8vh 1.4vh;margin:0 0 1vh;background:var(--panel);border-radius:1.2vh;border:.3vh solid var(--line)}
.lbrow.big.first{border-color:var(--accent)}
.rank{display:flex;flex-wrap:wrap;align-content:flex-start}
.rank .lbrow.big{width:100%}
.rank.two .lbrow.big{width:49%;margin-right:1%;font-size:1.05rem;padding:.4vh 1vh;margin-bottom:.8vh}
.rank.two .lbrow.big .badge{font-size:1.05rem;margin-right:1vh}
.rank.two .lbrow.big .tot{display:none}
.lbrow.big .badge{margin:0 2vh 0 0}
.lbrow.big .rpts{margin-left:auto}
.lbrow.big .tot{margin-left:2vh;color:var(--dim);font-size:1rem}
.winner{font-size:2.6rem;font-weight:800;color:var(--accent);margin-bottom:1.6vh}
.cols{display:flex;flex:1;min-height:0;overflow:hidden}
.cols .rank{flex:1;margin-right:3vw}.cols .teams{width:30%}
.teamrow{display:flex;padding:1vh 1.4vh;margin-bottom:1vh;border:.5vh solid;border-radius:1.2vh;font-size:1.4rem;font-weight:700}
.teamrow .tn{flex:1;margin-left:1vh}
.cands{display:flex;flex-wrap:wrap;flex:1;min-height:0;overflow:hidden;align-content:flex-start}
.cand{width:17.6%;margin:0 1.2% 1.6vh 0;text-align:center}
.cands.n3 .cand,.cands.n4 .cand{width:22%}
.cands.n6 .cand,.cands.n7 .cand,.cands.n8 .cand{width:23.5%;margin-right:1%;margin-bottom:1vh}
.cands.n6 .cposter,.cands.n7 .cposter,.cands.n8 .cposter{height:16vh}
.cands.n6 .ctitle,.cands.n7 .ctitle,.cands.n8 .ctitle{font-size:1rem}
.cposter{width:100%;height:36vh;object-fit:cover;border-radius:1vh;border:.3vh solid var(--line);background:#111;display:block}
.ctitle{font-weight:800;font-size:1.15rem;margin-top:.8vh}.cyear{color:var(--dim);font-size:.9rem}
.bars{margin-top:1.4vh}
.barline{display:flex;align-items:center;margin-bottom:1vh;font-size:1.1rem}
.barline .bl{width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.barline .track{flex:1;height:2.4vh;background:var(--panel2);border-radius:1.2vh;margin:0 1.4vh;overflow:hidden;border:.2vh solid var(--line)}
.barline .fill2{display:block;height:100%;background:var(--dim)}
.barline.win .fill2{background:var(--accent)}.barline.win{font-weight:800;color:var(--accent)}
.barline .bv{width:24%;color:var(--ink)}
.msg{margin:auto;text-align:center;max-width:70vw}
.dialog{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;z-index:50}
.dialog .card{background:var(--panel);border:.4vh solid var(--accent);border-radius:1.6vh;padding:4vh 4vw;text-align:center}
.dialog .hostrow{justify-content:center}
.toast{position:fixed;left:50%;bottom:6vh;transform:translateX(-50%);background:var(--panel2);border:.35vh solid var(--accent);color:var(--ink);border-radius:1.2vh;padding:1.2vh 2.4vh;font-size:1.2rem;max-width:80vw;display:none;z-index:60}
.toast.on{display:block}
.floats{position:fixed;right:4vw;bottom:3vh;width:22vw;height:0;z-index:40;pointer-events:none}
.fl{position:absolute;bottom:0;text-align:center;animation:mnRise 3.4s ease-out forwards}
.fl .fe{display:block;font-size:4.4vh}
.fl .fn{display:inline-block;font-size:.75rem;background:rgba(0,0,0,.65);border:.2vh solid;border-radius:1vh;padding:0 .8vh;color:#fff}
.fl.still{animation:none;bottom:1vh}
@keyframes mnRise{from{transform:translateY(0);opacity:1}to{transform:translateY(-32vh);opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.fl{bottom:1vh}}
@media (prefers-contrast:more){:root{--line:#9aa5bb;--dim:#e6eaf2}.btn,.opt,.res{border-width:.5vh}}
`

const GUEST_CSS = `
:root{color-scheme:dark light;--bg:#0f1218;--card:#1a1f2b;--card2:#252c3b;--ink:#f6f8fb;--dim:#c0c8d6;--accent:#ffd43b;--onaccent:#161616;--line:#4a5468;--good:#8ce99a;--bad:#ffa8a8}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f8;--card:#ffffff;--card2:#eceff5;--ink:#14171c;--dim:#454d5c;--accent:#5b3fd0;--onaccent:#ffffff;--line:#8b94a6;--good:#0b6b1f;--bad:#a12020}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
#app{max-width:560px;margin:0 auto;padding:16px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:8vh}
h1{font-size:1.5rem;margin:0 0 8px}.sub{color:var(--dim);margin:6px 0}.fine{color:var(--dim);font-size:.82rem;margin-top:16px}
.field{margin:14px 0}.field label{display:block;font-size:.9rem;color:var(--dim);margin-bottom:6px}
.in{width:100%;font:inherit;font-size:1.15rem;padding:14px;border-radius:12px;border:2px solid var(--line);background:var(--card2);color:var(--ink)}
.in:focus,.b:focus,.opt:focus,.sw:focus,.rx:focus{outline:3px solid var(--accent);outline-offset:2px}
.palette{display:flex;flex-wrap:wrap;margin:8px -4px}
.sw{width:56px;height:56px;border-radius:50%;border:3px solid transparent;margin:4px;color:#111;font-size:1.3rem;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.sw.on{border-color:var(--ink);box-shadow:0 0 0 3px var(--accent)}
.sw.taken{opacity:.25;cursor:not-allowed}
.b{font:inherit;font-weight:700;min-height:56px;padding:12px 18px;border-radius:14px;border:2px solid var(--line);background:var(--card2);color:var(--ink);cursor:pointer;width:100%;margin-top:10px}
.b.primary{background:var(--accent);color:var(--onaccent);border-color:var(--accent)}
.b.big{min-height:68px;font-size:1.25rem}
.b:disabled{opacity:.5}
.b.link{background:transparent;border:0;text-decoration:underline;color:var(--dim);min-height:44px}
.b.danger{border-color:var(--bad);color:var(--bad)}
.b.mini{min-height:44px;width:auto;padding:6px 12px;margin:0 0 0 8px;font-size:.9rem}
.b.step{width:auto;flex:1;margin:4px}
.page .hdr{display:flex;align-items:center;flex-wrap:wrap;margin:6px 0 10px}
.chip{display:inline-flex;align-items:center;border-radius:99px;padding:5px 14px 5px 6px;color:#111;font-weight:800;margin:2px 6px 2px 0;max-width:100%}
.chip .gl{width:28px;height:28px;border-radius:50%;background:#111;color:#fff;display:inline-flex;align-items:center;justify-content:center;margin-right:8px;font-size:.85rem}
.tag{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:.75rem;margin-right:6px;letter-spacing:.05em}
.pts{margin-left:auto;font-weight:800;font-size:1.2rem}
.stack{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:8px 0}
.meta{font-size:.85rem;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.prompt{font-size:1.35rem;font-weight:800;margin:6px 0 12px}
.options{display:block}
.opt{display:flex;align-items:center;width:100%;min-height:72px;margin:8px 0;padding:10px 14px;border-radius:16px;border:2px solid var(--line);background:var(--card2);color:var(--ink);font:inherit;font-size:1.15rem;font-weight:700;text-align:left;cursor:pointer}
.opt:disabled{opacity:.6}
.opt .ol{flex:none;width:40px;height:40px;border-radius:50%;background:var(--ink);color:var(--bg);display:inline-flex;align-items:center;justify-content:center;margin-right:12px}
.tbar{height:10px;background:var(--card2);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:4px 0 8px}.tfill{height:100%;background:var(--accent);width:100%}
.locked{font-size:1.5rem;font-weight:800;color:var(--good);margin:8px 0}
.yours{font-weight:700;margin:6px 0}
.yearbig{font-size:4rem;font-weight:900;text-align:center;margin:6px 0}.yrow{display:flex}
.range{width:100%;height:48px;margin:8px 0}
.verdict{font-size:1.6rem;font-weight:800;margin:6px 0}.verdict.ok{color:var(--good)}.verdict.no{color:var(--bad)}
.answerline{font-weight:700;margin-bottom:10px}
.lbr{display:flex;align-items:center;padding:6px 0;border-top:1px solid var(--line)}.lbr.me{background:var(--card2)}
.lbr .rk{min-width:44px;font-weight:800}.lbr .rp{margin-left:auto;font-weight:800}
.cand{padding:10px 0;border-top:1px solid var(--line)}.cand .ct{font-weight:800;margin-bottom:6px}
.vact{display:flex}.vact .b{margin:0 6px 0 0;min-height:50px}
.b.sent{background:var(--good);color:#111;border-color:var(--good)}
.b.yes.on{background:var(--good);color:#111;border-color:var(--good)}.b.veto.on{background:var(--bad);color:#111;border-color:var(--bad)}
.reacts{display:flex;flex-wrap:wrap;justify-content:center;margin:12px 0}
.rx{font-size:1.9rem;width:58px;height:58px;border-radius:50%;border:2px solid var(--line);background:var(--card2);margin:4px;cursor:pointer}
.host{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:8px 14px;margin:10px 0}
.host summary{min-height:44px;font-weight:800;cursor:pointer;display:flex;align-items:center}
.hb.off{opacity:.55}
.prow{display:flex;align-items:center;margin:6px 0;flex-wrap:wrap}
.suggest .slist .b{font-size:1rem;min-height:48px}
.note{background:var(--card2);border:1px solid var(--accent);border-radius:10px;padding:8px 12px;margin:8px 0}
.live{min-height:1.4em;color:var(--dim);margin-top:8px;font-size:.95rem}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

const OVERLAY_CSS = `
#mnOverlay{position:fixed;right:12px;bottom:18%;width:180px;height:0;z-index:2147483000;pointer-events:none}
#mnOverlay .mnr{position:absolute;bottom:0;text-align:center;opacity:.92;animation:mnRise 3.2s ease-out forwards}
#mnOverlay .mne{display:block;font-size:34px;line-height:1.1;text-shadow:0 1px 4px rgba(0,0,0,.6)}
#mnOverlay .mnn{display:inline-block;font:12px system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:rgba(0,0,0,.55);border:1px solid #fff;border-radius:10px;padding:0 7px}
#mnOverlay .mnr.still{animation:none;bottom:0}
@keyframes mnRise{from{transform:translateY(0);opacity:.92}to{transform:translateY(-190px);opacity:0}}
@media (prefers-reduced-motion:reduce){#mnOverlay .mnr{animation:none}}
`

const head = (title, css) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="dark light">' +
  `<title>${title}</title><style>${css}</style></head>`

/** The shared screen. Opens at /tv, /movie-night or /movie-night/tv. */
function tvPageHtml({ sounds = false } = {}) {
  const cfg = { api: API_PATH, sounds: !!sounds }
  return head('Movie Night', TV_CSS) +
    '<body><div id="app" class="app"><div class="loading">Starting Movie Night\u2026</div></div>' +
    '<noscript><div class="msg"><h1>Movie Night needs JavaScript.</h1></div></noscript>' +
    `<script>\n(${clients.movieNightTvClient.toString()})(${scriptJson(cfg)});\n</script></body></html>`
}

/** The phone page. `code` / `key` are already validated by the caller (normalizeCode / normalizeKey). */
function joinPageHtml({ code = '', key = '' } = {}) {
  const cfg = { api: API_PATH, code: /^[A-Z0-9]{6}$/.test(code) ? code : '', key: /^[A-Za-z0-9_-]{16}$/.test(key) ? key : '' }
  return head('Join Movie Night', GUEST_CSS) +
    '<body><div id="app"><div class="card"><h1>Movie Night</h1><p class="sub">Loading\u2026</p></div></div>' +
    '<noscript><div class="card"><h1>Movie Night needs JavaScript.</h1></div></noscript>' +
    `<script>\n(${clients.movieNightGuestClient.toString()})(${scriptJson(cfg)});\n</script></body></html>`
}

/** A plain page for "turned off" / "home Wi-Fi only". `escaped` MUST already be HTML-escaped. */
function messagePageHtml(escaped) {
  return head('Movie Night', ':root{color-scheme:dark light}body{font:20px system-ui,Segoe UI,Arial,sans-serif;background:#0f1218;color:#f6f8fb;margin:0}main{max-width:560px;margin:14vh auto;padding:0 22px;text-align:center}@media (prefers-color-scheme:light){body{background:#f4f5f8;color:#14171c}}') +
    `<body><main><h1>Movie Night</h1><p>${escaped}</p><p><a style="color:inherit" href="/">Back to the library</a></p></main></body></html>`
}

/**
 * The block appended to the player page (streamServer.playerPage, one line). It does NOTHING unless the address
 * carries #mn=<ticket> (put there by the Movie Night TV page when the host presses "Play it"): then it shows
 * the room's emoji reactions over the film. Read-only; the ticket cannot change anything in the room.
 */
function reactionOverlayHtml() {
  return `<style>${OVERLAY_CSS}</style><script>\n(${clients.movieNightOverlayClient.toString()})(${scriptJson({ api: API_PATH })});\n</script>`
}

module.exports = { tvPageHtml, joinPageHtml, messagePageHtml, reactionOverlayHtml, scriptJson, TV_PATH, API_PATH, TV_CSS, GUEST_CSS, OVERLAY_CSS }
