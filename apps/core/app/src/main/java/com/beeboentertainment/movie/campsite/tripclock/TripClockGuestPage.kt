package com.beeboentertainment.movie.campsite.tripclock

/**
 * The read-only "are we there yet?" page a guest opens in their browser at /clock. A road, a little
 * car, how long is left in words and in kid units ("about 3 episodes"), and the parent's stops as
 * markers along the way.
 *
 * It is a plain page with no controls that change anything: only the host phone edits the clock.
 * It draws whatever `/api/family` says, using textContent only (no innerHTML), and it sends nothing.
 * It works with no internet: no fonts, images or scripts come from anywhere else.
 *
 * Wording: "Estimate only. Use your navigation app for directions." and "For passengers. Never for
 * the driver." are on the page. It does not claim to be navigation or a safety product.
 */
internal object TripClockGuestPage {

    fun html(): String = PAGE

    private const val PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#101c32"><title>Are we there yet? · Beebo</title>
<style>
:root{color-scheme:dark;--bg:#080d18;--panel:#14223a;--text:#f5f4ff;--muted:#b9c7dd;--gold:#efcc69;--green:#8adab0;--line:#3f5373}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top right,#1c2f52,#080d18 60%);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px 16px 40px;min-height:100vh}
main{max-width:640px;margin:0 auto}a{color:var(--gold)}h1{font-size:26px;margin:8px 0 2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0}
.big{font-size:clamp(34px,11vw,56px);font-weight:800;line-height:1.1;margin:4px 0}
.kid{font-size:clamp(22px,7vw,32px);color:var(--gold);font-weight:700;margin:2px 0 8px}
.muted{color:var(--muted);font-size:14px}
.road{position:relative;height:96px;margin:18px 4px 10px}
.road .line{position:absolute;left:0;right:0;top:56px;height:14px;border-radius:8px;background:#2a3a58;overflow:hidden}
.road .done{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#8adab0,#efcc69);width:0;transition:width .8s}
.road .dash{position:absolute;left:0;right:0;top:62px;border-top:2px dashed #ffffff55}
.car{position:absolute;top:18px;font-size:34px;transform:translateX(-50%);transition:left .8s}
.flag{position:absolute;right:-4px;top:14px;font-size:30px}
.stop{position:absolute;top:34px;transform:translateX(-50%);font-size:20px}
.stops{margin:6px 0 0;padding-left:20px}
.note{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:14px;color:var(--muted);font-size:13px}
@media(prefers-reduced-motion:reduce){.road .done,.car{transition:none}}
</style></head><body><main>
<p><a href="/library">&larr; Back</a></p>
<h1>Are we there yet?</h1>
<p class="muted">For passengers. Never for the driver.</p>
<div id="none" class="card" hidden><strong>No trip clock is running right now.</strong><p class="muted">When the grown-up starts one on the host phone, it shows up here.</p></div>
<div id="clock" hidden>
  <div class="card">
    <div class="muted" id="label">Time left</div>
    <div class="big" id="left"></div>
    <div class="kid" id="kid"></div>
    <div class="muted" id="eta"></div>
    <div class="road" aria-hidden="true"><div class="line"><div class="done" id="done"></div></div><div class="dash"></div><div id="markers"></div><div class="car" id="car">&#128663;</div><div class="flag">&#127937;</div></div>
    <div class="muted" id="late"></div>
    <div class="muted" id="distance"></div>
    <ul class="stops" id="stops"></ul>
  </div>
</div>
<div class="note" id="disclaimer">Estimate only. Use your navigation app for directions.</div>
<p class="muted" id="offline" hidden>Lost the connection to the host. Keep the host's Wi-Fi selected.</p>
</main>
<script>
(function(){
'use strict';
function g(id){return document.getElementById(id);}
function text(id,value){var n=g(id);n.textContent=value||'';}
function draw(c){
  if(!c){g('none').hidden=false;g('clock').hidden=true;return;}
  g('none').hidden=true;g('clock').hidden=false;
  text('label',c.arrived?'You made it!':(c.late?'Nearly there':'Time left'));
  text('left',c.arrived?'We are here!':c.left);
  text('kid',c.arrived?'':c.kid);
  text('eta',c.arrived?'':'Expected about '+c.eta);
  text('late',c.delayText);
  text('distance',c.distance);
  var pct=Math.max(0,Math.min(1,Number(c.fraction)||0))*100;
  g('done').style.width=pct+'%';g('car').style.left=pct+'%';
  var markers=g('markers');markers.replaceChildren();
  var list=g('stops');list.replaceChildren();
  (c.stops||[]).forEach(function(s){
    var m=document.createElement('span');m.className='stop';m.textContent='\u{1F4CD}';m.style.left=(Math.max(0,Math.min(1,Number(s.at)||0))*100)+'%';markers.appendChild(m);
    var li=document.createElement('li');li.textContent=s.title;list.appendChild(li);
  });
  if(c.disclaimer)text('disclaimer',c.disclaimer);
}
var busy=false;
function poll(){
  if(busy||document.hidden)return;busy=true;
  fetch('/api/family',{cache:'no-store'}).then(function(r){
    if(!r.ok)throw new Error('x');return r.json();
  }).then(function(j){g('offline').hidden=true;draw(j.clock);}).catch(function(){g('offline').hidden=false;}).then(function(){busy=false;});
}
poll();setInterval(poll,3000);document.addEventListener('visibilitychange',poll);
})();
</script></body></html>"""
}
