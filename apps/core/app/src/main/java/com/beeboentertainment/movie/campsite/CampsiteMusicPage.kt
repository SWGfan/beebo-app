package com.beeboentertainment.movie.campsite

/**
 * The guest's "Music together" page. Server-rendered shell + the dependency-free script from
 * assets/campsite-music.js, inlined so the page needs no second authenticated request and the
 * script can never be out of step with the host that serves it.
 *
 * Every dynamic string (track titles come from music tags, names from guests) is written by the
 * script with textContent, never as markup. The one value rendered here, the guest's own name,
 * is escaped.
 */
internal object CampsiteMusicPage {
    private fun escape(value: String): String = value.replace("&", "&amp;")
        .replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")

    fun music(guest: String, script: String): String = CampsiteWebPages.page("Music together", """
      <style>$css</style>
      <header class="topbar"><h2>Music together</h2><span class="camp-user">${escape(guest)}</span></header>
      <section class="mus-card" id="mus-root" aria-label="Music playing together">
        <span class="camp-eyebrow">PLAYING TOGETHER</span>
        <h1 class="mus-title" id="mus-title">Waiting for your host</h1>
        <p class="mus-artist" id="mus-artist">When the host taps "Play together", the same song plays on every phone at once.</p>
        <div class="mus-progress" aria-hidden="true"><div id="mus-bar"></div></div>
        <div class="mus-times"><span id="mus-time">0:00</span><span id="mus-dur">0:00</span></div>

        <div class="mus-gate" id="mus-gate" hidden>
          <button type="button" id="mus-unlock">Tap to enable audio</button>
          <p>Your browser only lets a page make sound after a tap. One tap and this phone joins in, exactly on the beat.</p>
        </div>

        <div class="mus-sync" id="mus-sync" data-level="idle" role="status" aria-live="polite">
          <span class="mus-dot" aria-hidden="true"></span>
          <b id="mus-sync-text">Connecting...</b>
          <small id="mus-sync-detail"></small>
        </div>

        <div class="mus-row">
          <label for="mus-volume">Volume</label>
          <input id="mus-volume" type="range" min="0" max="100" value="100" aria-label="Volume on this phone">
        </div>
        <div class="mus-row">
          <span>This phone plays</span><b id="mus-role">Everything</b>
        </div>
        <div class="mus-row">
          <span>Sounds late or early?</span>
          <span class="mus-trim">
            <button type="button" id="mus-trim-minus" aria-label="Play 10 milliseconds earlier">-10 ms</button>
            <b id="mus-trim-val">0 ms</b>
            <button type="button" id="mus-trim-plus" aria-label="Play 10 milliseconds later">+10 ms</button>
          </span>
        </div>
        <p class="mus-note" id="mus-note" role="alert" hidden></p>
      </section>
      <section class="mus-card" aria-label="Up next">
        <span class="camp-eyebrow">UP NEXT</span>
        <ol class="mus-queue" id="mus-queue"></ol>
      </section>
      <p class="camp-note">Keep this page open and the screen on while you listen. Leaving the page stops the music on this phone; come back and it catches up on its own. Bluetooth speakers add a little delay of their own - use the trim buttons to line it up.</p>
    """.trimIndent(), active = "music", script = script + "\nif (typeof BeeboMusic !== 'undefined') window.beeboMusic = BeeboMusic.mount(document);")

    private val css = """
.mus-card{margin:0 0 18px;padding:20px 20px 16px;background:radial-gradient(ellipse at 100% 0,#3a3160,transparent 60%),linear-gradient(115deg,#1d2b49,#172038);border:1px solid #3e4b68;border-radius:17px}
.mus-title{font-size:26px;line-height:1.2;margin:8px 0 6px;overflow-wrap:anywhere}.mus-artist{margin:0 0 16px;color:#b8c5dc;font-size:14px}
.mus-progress{height:6px;background:#0b1528;border-radius:99px;overflow:hidden}.mus-progress div{height:100%;width:0;background:linear-gradient(90deg,#7950cf,#d4af37)}
.mus-times{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#acb6cf;font-variant-numeric:tabular-nums}
.mus-gate{margin:16px 0 4px;padding:16px;text-align:center;background:#070c17cc;border:1px solid #d4af37;border-radius:13px}.mus-gate p{margin:10px 0 0;font-size:12px;color:#b8c5dc}
.beebo-main .mus-gate button{min-height:52px;padding:12px 26px;font-size:16px;border-radius:999px}
.mus-sync{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:16px 0 8px;padding:11px 14px;background:#152540;border:1px solid #3e4b68;border-radius:13px;font-size:13px}
.mus-sync small{color:#acb6cf;font-size:11px}
.mus-dot{width:11px;height:11px;border-radius:50%;background:#6c7891;flex-shrink:0}
.mus-sync[data-level=good] .mus-dot{background:#4cd08a;box-shadow:0 0 0 4px #4cd08a30}.mus-sync[data-level=warn] .mus-dot{background:#e5b94e}.mus-sync[data-level=bad] .mus-dot{background:#e8615c}
.mus-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 2px;font-size:13px;color:#c6d2e8}.mus-row input[type=range]{flex:1;max-width:260px;padding:0;min-height:30px}
.mus-trim{display:flex;align-items:center;gap:8px}.mus-trim b{min-width:52px;text-align:center;font-variant-numeric:tabular-nums}.beebo-main .mus-trim button{min-height:36px;padding:6px 10px;font-size:12px}
.mus-note{margin:10px 0 0;padding:10px 12px;background:#3a1f2a;border:1px solid #8a3b4a;border-radius:10px;font-size:12px;color:#ffd9de}
.mus-queue{margin:10px 0 0;padding:0;list-style:none;counter-reset:q}.mus-queue li{counter-increment:q;display:flex;gap:10px;padding:8px 0;border-top:1px solid #2c3e5d;font-size:13px}.mus-queue li:first-child{border-top:0}.mus-queue li::before{content:counter(q);flex:0 0 22px;color:#8ea0c0;font-variant-numeric:tabular-nums}
.mus-queue li[aria-current=true]{color:#f4d788;font-weight:650}.mus-queue small{display:block;color:#98a8c6;font-weight:400}
.mus-empty{color:#98a8c6;font-size:13px;margin:10px 0 0}
""".trimIndent()
}
