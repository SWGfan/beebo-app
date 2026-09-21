'use strict'
// The Audiobooks page of the website (/audiobooks): a "continue listening" shelf, the library (all
// books, series, reading order) and a player with chapters, speed, sleep timer, skip buttons and
// bookmarks. The page is a shell; everything else is fetched from /audiobooks-api/* with the login
// cookie (audiobookApi.js), so the phone browser and the desktop browser see exactly what the apps do.
//
// The player's arithmetic is not written twice: audiobookPlayer.js's functions are inlined below with
// .toString(), the same trick the Music page uses for ReplayGain.

const player = require('./audiobookPlayer')

const INLINED = ['clampSpeed', 'locate', 'bookPosition', 'chapterIndexAt', 'skipTarget', 'previousChapterStart', 'nextChapterStart', 'sleepStart', 'sleepStatus', 'sleepExtend', 'formatClock', 'formatLeft']
  .map((name) => player[name].toString())
  .join('\n')

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const STYLE = `
      <style>
        .abx-top { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
        .abx-top input { max-width:320px; margin:0; }
        .abx-tabs button, .abx-pill { background:#22262f; color:#cfd3da; border:none; padding:8px 14px; border-radius:18px; cursor:pointer; font-size:14px; }
        .abx-tabs button.on { background:#3b82f6; color:#fff; }
        .abx-shelf { display:flex; gap:14px; overflow-x:auto; padding:4px 0 14px; }
        .abx-shelf .abx-card { width:150px; flex:0 0 auto; }
        .abx-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; padding-bottom:140px; }
        .abx-card { position:relative; display:block; cursor:pointer; }
        .abx-card img, .abx-nocover { width:100%; aspect-ratio:1/1; object-fit:cover; display:flex; align-items:center; justify-content:center; background:#22262f; font-size:42px; color:#555; border-radius:8px; }
        .abx-prog { height:4px; background:#2a2f3a; border-radius:2px; margin-top:6px; overflow:hidden; }
        .abx-prog i { display:block; height:100%; background:#3b82f6; }
        .abx-h { margin:18px 0 8px; font-size:17px; }
        .abx-series { margin-bottom:22px; }
        .abx-order { display:flex; gap:10px; align-items:center; padding:8px 6px; border-bottom:1px solid #22262f; cursor:pointer; }
        .abx-order:hover, .abx-order.next { background:#1c2029; }
        .abx-order .n { width:34px; text-align:right; color:#8a8f98; }
        .abx-order .t { flex:1; min-width:0; }
        .abx-badge { font-size:12px; padding:2px 8px; border-radius:10px; background:#22262f; color:#8a8f98; }
        .abx-badge.f { background:#1f3d2b; color:#7bd88f; } .abx-badge.p { background:#1f2f4d; color:#8fb4ff; } .abx-badge.n { background:#4d3a1f; color:#ffcf8f; }
        .abx-bar { position:fixed; left:0; right:0; bottom:0; background:#171a21; border-top:1px solid #2a2f3a; padding:10px 16px; display:none; gap:12px; align-items:center; z-index:50; cursor:pointer; }
        .abx-bar img { width:48px; height:48px; object-fit:cover; border-radius:6px; background:#22262f; }
        .abx-bar .mt { flex:1; min-width:0; } .abx-bar .mt div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .abx-bar button { padding:8px 14px; font-size:18px; background:#2a2f3a; }
        .abx-panel { position:fixed; inset:0; background:rgba(0,0,0,.82); display:none; z-index:60; overflow:auto; padding:24px 12px 140px; }
        .abx-panel .in { max-width:760px; margin:0 auto; background:#171a21; border-radius:14px; padding:18px; }
        .abx-head { display:flex; gap:16px; align-items:flex-start; margin-bottom:12px; }
        .abx-head img { width:120px; height:120px; object-fit:cover; border-radius:8px; background:#22262f; }
        .abx-ctrl { display:flex; gap:10px; align-items:center; justify-content:center; margin:10px 0; flex-wrap:wrap; }
        .abx-ctrl button { background:#2a2f3a; font-size:16px; padding:10px 14px; }
        .abx-ctrl button.big { background:#3b82f6; font-size:22px; padding:12px 24px; }
        .abx-seek { display:flex; gap:10px; align-items:center; font-size:13px; color:#8a8f98; }
        .abx-seek input { flex:1; margin:0; }
        .abx-opts { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin:12px 0; color:#8a8f98; font-size:14px; }
        .abx-opts select, .abx-opts button { width:auto; margin:0; }
        .abx-opts button { padding:6px 12px; background:#2a2f3a; }
        .abx-list .row { display:flex; gap:10px; padding:9px 6px; border-bottom:1px solid #22262f; cursor:pointer; align-items:center; }
        .abx-list .row:hover, .abx-list .row.on { background:#22262f; }
        .abx-list .row .t { flex:1; min-width:0; } .abx-list .row .d { color:#8a8f98; font-size:13px; }
        .abx-list .row button { padding:4px 10px; font-size:12px; background:#2a2f3a; }
        @media (max-width:860px){ .abx-bar{ bottom:calc(74px + env(safe-area-inset-bottom)); z-index:24; } .abx-grid{ padding-bottom:220px; } }
        @media (max-width:520px){ .abx-head img{ width:84px; height:84px; } }
      </style>`

// The browser side. ES5 on purpose (the same reasons the Music page is), no template literals inside.
const SCRIPT = String.raw`
      (function(){
        var API='/audiobooks-api';
        ${INLINED}
        var audio=document.getElementById('abx-audio'), bar=document.getElementById('abx-bar'), panel=document.getElementById('abx-panel'), pin=document.getElementById('abx-pin'), main=document.getElementById('abx-main');
        var S={view:'library', books:null, series:null, order:null, cont:null, q:'', prefs:{speed:1,skipBack:15,skipForward:30,sleepMinutes:0,sleepEndOfChapter:false}, book:null, progress:null, idx:0, pendingSeek:null, speed:1, sleep:null, tab:'chapters', bookmarks:[], next:null, lastSave:0, saving:null, playing:false, resumeAfterLoad:false};
        var SPEEDS=[0.5,0.75,0.9,1,1.1,1.25,1.35,1.5,1.75,2,2.25,2.5,2.75,3];
        var device='web'; try{ device=localStorage.getItem('beebo:ab:device')||''; if(!device){ device='web-'+Math.random().toString(36).slice(2,10); localStorage.setItem('beebo:ab:device',device) } }catch(e){ device='web' }
        function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
        function api(method,path,body,keepalive){ var o={method:method,credentials:'same-origin',headers:{}}; if(body!==undefined){ o.headers['Content-Type']='application/json'; o.body=JSON.stringify(body) } if(keepalive) o.keepalive=true;
          return fetch(API+path,o).then(function(r){ return r.json().catch(function(){ return {} }) }) }
        function $(id){ return document.getElementById(id) }
        function note(msg){ var e=$('abx-note'); if(e) e.textContent=msg||'' }

        // ---------- library views ----------
        function cardHtml(b){ var p=b.progress, pct=p?Math.round((p.fraction||0)*100):0, sub=esc(b.author)+(b.seriesIndex!=null&&b.series?' · Book '+esc(b.seriesIndex):'');
          return '<a class="card abx-card" href="#" data-book="'+esc(b.id)+'">'+(b.cover?'<img loading="lazy" src="'+esc(b.cover)+'" alt="">':'<div class="abx-nocover">&#127911;</div>')
            +(pct>0?'<div class="abx-prog"><i style="width:'+pct+'%"></i></div>':'')+'<div class="meta"><div class="title">'+esc(b.title)+'</div><div class="sub">'+sub+'</div>'
            +'<div class="sub">'+formatLeft(b.duration)+(p&&!p.finished&&p.remaining?' · '+formatLeft(p.remaining)+' left':'')+(p&&p.finished?' · finished':'')+'</div></div></a>' }
        function wireCards(root){ Array.prototype.forEach.call(root.querySelectorAll('[data-book]'),function(c){ c.onclick=function(e){ e.preventDefault(); openBook(c.getAttribute('data-book'),{autoplay:false}) } }) }
        function badge(st){ return st==='finished'?'<span class="abx-badge f">Finished</span>':st==='in_progress'?'<span class="abx-badge p">Listening</span>':'<span class="abx-badge">Not started</span>' }
        function renderShelf(){ var el=$('abx-shelf'); if(!el) return; var c=S.cont; if(!c||(!c.items.length&&!c.nextUp.length)){ el.innerHTML=''; return }
          var h='';
          if(c.items.length){ h+='<h3 class="abx-h">Continue listening</h3><div class="abx-shelf">'+c.items.map(function(x){ var b=x.book; b.progress=x.progress; return cardHtml(b) }).join('')+'</div>' }
          if(c.nextUp.length){ h+='<h3 class="abx-h">Up next in your series</h3><div class="abx-shelf">'+c.nextUp.map(function(x){ var b=x.book; b.progress=null; return cardHtml(b) }).join('')+'</div>' }
          el.innerHTML=h; wireCards(el) }
        function renderMain(){
          Array.prototype.forEach.call(document.querySelectorAll('.abx-tabs button'),function(b){ b.classList.toggle('on',b.getAttribute('data-view')===S.view) });
          if(S.view==='library'){ var list=S.books; if(!list){ main.innerHTML='<p class="muted">Loading&hellip;</p>'; return }
            main.innerHTML=list.length?'<div class="abx-grid">'+list.map(cardHtml).join('')+'</div>':'<p class="muted">Nothing matches.</p>'; wireCards(main); return }
          if(S.view==='series'){ var ss=S.series; if(!ss){ main.innerHTML='<p class="muted">Loading&hellip;</p>'; return }
            main.innerHTML=ss.length?'<div class="abx-grid">'+ss.map(function(s){ return '<a class="card abx-card" href="#" data-series="'+esc(s.id)+'">'+(s.cover?'<img loading="lazy" src="'+esc(s.cover)+'" alt="">':'<div class="abx-nocover">&#128218;</div>')+'<div class="meta"><div class="title">'+esc(s.name)+'</div><div class="sub">'+esc(s.author)+' · '+esc(s.bookCount)+' books</div></div></a>' }).join('')+'</div>':'<p class="muted">No series yet. Books are grouped into a series from their tags, a title like &ldquo;Name (Series #2)&rdquo;, or an Author/Series/Book folder layout.</p>';
            Array.prototype.forEach.call(main.querySelectorAll('[data-series]'),function(c){ c.onclick=function(e){ e.preventDefault(); S.view='order'; S.orderOnly=c.getAttribute('data-series'); S.order=null; loadOrder(); renderMain() } }); return }
          var o=S.order; if(!o){ main.innerHTML='<p class="muted">Loading&hellip;</p>'; return }
          var h=S.orderOnly?'<p><a class="muted" href="#" id="abx-all">&larr; All series</a></p>':'';
          h+=o.series.map(function(s){ return '<div class="abx-series"><h3 class="abx-h">'+esc(s.name)+' <span class="muted" style="font-weight:400">by '+esc(s.author)+' · '+esc(s.finishedCount)+' of '+esc(s.bookCount)+' finished</span></h3>'
            +s.books.map(function(b){ return '<div class="abx-order'+(b.next?' next':'')+'" data-book="'+esc(b.id)+'"><span class="n">'+(b.seriesIndex!=null?esc(b.seriesIndex):'&ndash;')+'</span><span class="t">'+esc(b.title)+'<div class="muted">'+formatLeft(b.duration)+(b.progress&&b.status==='in_progress'?' · '+formatLeft(b.progress.remaining)+' left':'')+'</div></span>'+(b.next&&b.status==='unstarted'?'<span class="abx-badge n">Up next</span>':badge(b.status))+'</div>' }).join('')+'</div>' }).join('');
          main.innerHTML=o.series.length?h:'<p class="muted">No series yet.</p>'; wireCards(main); var all=$('abx-all'); if(all) all.onclick=function(e){ e.preventDefault(); S.orderOnly=null; S.order=null; loadOrder(); renderMain() } }
        function loadShelf(){ api('GET','/continue').then(function(d){ if(d&&d.ok){ S.cont=d; renderShelf() } }) }
        function loadBooks(){ api('GET','/books?sort=title'+(S.q?'&q='+encodeURIComponent(S.q):'')).then(function(d){ if(d&&d.ok){ S.books=d.items; if(S.view==='library') renderMain() } }) }
        function loadSeries(){ api('GET','/series').then(function(d){ if(d&&d.ok){ S.series=d.items; if(S.view==='series') renderMain() } }) }
        function loadOrder(){ api('GET','/reading-order'+(S.orderOnly?'?seriesId='+S.orderOnly:'')).then(function(d){ if(d&&d.ok){ S.order=d; if(S.view==='order') renderMain() } }) }
        function refreshAll(){ loadShelf(); if(S.view==='library') loadBooks(); else if(S.view==='order') loadOrder() }
        Array.prototype.forEach.call(document.querySelectorAll('.abx-tabs button'),function(b){ b.onclick=function(){ S.view=b.getAttribute('data-view'); S.orderOnly=null; if(S.view==='library') loadBooks(); else if(S.view==='series') loadSeries(); else { S.order=null; loadOrder() } renderMain() } });
        var q=$('abx-q'); var qt=null; if(q) q.addEventListener('input',function(){ clearTimeout(qt); qt=setTimeout(function(){ S.q=q.value.trim(); S.view='library'; loadBooks(); renderMain() },250) });

        // ---------- the player ----------
        function dur(){ return S.book?S.book.duration:0 }
        function pos(){ if(!S.book) return 0; if(S.pendingSeek!==null) return bookPosition(S.book.parts,S.idx,S.pendingSeek); return bookPosition(S.book.parts,S.idx,audio.currentTime||0) }
        function partAt(i){ return S.book.parts[i] }
        function loadPart(i,offset,play){ var p=partAt(i); if(!p) return; S.idx=i; S.pendingSeek=offset||0; S.resumeAfterLoad=!!play;
          if(audio.getAttribute('data-part')===String(i)&&audio.readyState>=1){ audio.currentTime=S.pendingSeek; S.pendingSeek=null; S.resumeAfterLoad=false; if(play) audio.play().catch(function(){}); ui(); return }
          audio.setAttribute('data-part',String(i)); audio.src=p.stream; audio.defaultPlaybackRate=S.speed; audio.playbackRate=S.speed; audio.load() }
        audio.addEventListener('loadedmetadata',function(){ if(S.pendingSeek!==null){ try{ audio.currentTime=S.pendingSeek }catch(e){} S.pendingSeek=null } audio.playbackRate=S.speed; if(S.resumeAfterLoad){ S.resumeAfterLoad=false; audio.play().catch(function(){ note('Press play to start.') }) } ui() });
        function seekBook(sec,play){ if(!S.book) return; var t=Math.max(0,Math.min(sec,dur())); var l=locate(S.book.parts,t); loadPart(l.index,l.offset,play===undefined?!audio.paused:play); ui() }
        function setSpeed(v,persist){ S.speed=clampSpeed(v); audio.defaultPlaybackRate=S.speed; audio.playbackRate=S.speed;
          try{ audio.preservesPitch=true; audio.mozPreservesPitch=true; audio.webkitPreservesPitch=true }catch(e){}
          if(persist){ api('PUT','/prefs',{speed:S.speed}); S.prefs.speed=S.speed; save(true) } ui() }
        function save(force,ended){ if(!S.book) return; var now=Date.now(); if(!force&&now-S.lastSave<14000) return; S.lastSave=now; var p=ended?dur():pos();
          api('PUT','/book/'+S.book.id+'/progress',{position:p,speed:S.speed,deviceId:device,updatedAt:now},true).then(function(d){ if(d&&d.ok&&d.progress){ S.progress=d.progress; if(ended||force) loadShelf() } }).catch(function(){}) }
        audio.addEventListener('timeupdate',function(){ save(false); ui(); sleepTick() });
        audio.addEventListener('play',function(){ S.playing=true; ui() });
        audio.addEventListener('pause',function(){ S.playing=false; save(true); ui() });
        audio.addEventListener('ended',function(){ if(!S.book) return; if(S.idx+1<S.book.parts.length){ loadPart(S.idx+1,0,true) } else { S.playing=false; S.pendingSeek=null; save(true,true); ui(); note(S.next?'Finished. Next in the series: '+S.next.title:'Finished.') } });
        audio.addEventListener('error',function(){ if(S.book) note('This part could not be played. Your browser may not support its format.') });
        document.addEventListener('visibilitychange',function(){ if(document.hidden&&S.playing) save(true) });
        window.addEventListener('pagehide',function(){ if(S.playing) save(true) });

        function chapterNow(){ return S.book?chapterIndexAt(S.book.chapters,pos()):-1 }
        function ui(){ if(!S.book) return; var p=pos(), ci=chapterNow(), ch=ci>=0?S.book.chapters[ci]:null;
          var pb=$('abx-play'), mb=$('abx-mplay'); var glyph=S.playing?'&#10074;&#10074;':'&#9654;'; if(pb) pb.innerHTML=glyph; if(mb) mb.innerHTML=glyph;
          var cu=$('abx-cur'), le=$('abx-left'), rg=$('abx-range'), cn=$('abx-chapter'), mt=$('abx-mtime');
          if(cu) cu.textContent=formatClock(p); if(le) le.textContent='-'+formatClock(Math.max(0,dur()-p))+' left'; if(rg&&document.activeElement!==rg){ rg.max=Math.round(dur()); rg.value=Math.round(p) }
          if(cn) cn.textContent=ch?ch.title+' ('+(ci+1)+' of '+S.book.chapters.length+')':''; if(mt) mt.textContent=(ch?ch.title+' · ':'')+formatLeft(Math.max(0,dur()-p))+' left';
          var sp=$('abx-speed'); if(sp&&sp.value!==String(S.speed)){ if(!Array.prototype.some.call(sp.options,function(o){ return o.value===String(S.speed) })){ var o=document.createElement('option'); o.value=String(S.speed); o.textContent=S.speed+'x'; sp.appendChild(o) } sp.value=String(S.speed) }
          Array.prototype.forEach.call(document.querySelectorAll('#abx-list .row[data-ch]'),function(r){ var on=+r.getAttribute('data-ch')===ci; if(on&&!r.classList.contains('on')&&panel.style.display==='block'){ try{ r.scrollIntoView({block:'nearest'}) }catch(e){} } r.classList.toggle('on',on) });
          if('mediaSession' in navigator&&navigator.mediaSession.setPositionState){ try{ navigator.mediaSession.setPositionState({duration:audio.duration||1,position:Math.min(audio.currentTime||0,audio.duration||1),playbackRate:S.speed}) }catch(e){} } }

        // ---------- sleep timer ----------
        function sleepLabel(){ var e=$('abx-sleepleft'), b=$('abx-sleepplus'); if(!e) return; if(!S.sleep){ e.textContent=''; if(b) b.style.display='none'; return }
          var st=sleepStatus(S.sleep,Date.now(),pos()); e.textContent=S.sleep.mode==='chapter'?'Stops at the end of this chapter ('+formatClock(st.remaining)+')':'Stops in '+formatClock(st.remaining); if(b) b.style.display='' }
        function sleepTick(){ if(!S.sleep) return; var st=sleepStatus(S.sleep,Date.now(),pos());
          if(st.done){ audio.pause(); audio.volume=1; S.sleep=null; sleepLabel(); var sel=$('abx-sleep'); if(sel) sel.value='0'; note('Sleep timer ended.'); return }
          audio.volume=st.fade; sleepLabel() }
        setInterval(function(){ if(S.sleep) sleepTick() },500);
        function setSleep(v){ audio.volume=1; if(v==='0'||!v){ S.sleep=null; api('PUT','/prefs',{sleepMinutes:0,sleepEndOfChapter:false}); sleepLabel(); return }
          if(v==='chapter'){ S.sleep=sleepStart('chapter',0,Date.now(),S.book.chapters,pos()); if(!S.sleep){ note('This book has no chapters, so pick a number of minutes instead.'); var s=$('abx-sleep'); if(s) s.value='0' } else api('PUT','/prefs',{sleepEndOfChapter:true}) }
          else { S.sleep=sleepStart('minutes',+v,Date.now()); api('PUT','/prefs',{sleepMinutes:+v,sleepEndOfChapter:false}) }
          sleepLabel(); note('') }

        // ---------- bookmarks ----------
        function renderList(){ var el=$('abx-list'); if(!el||!S.book) return; var h='';
          if(S.tab==='chapters'){ var cs=S.book.chapters; h=cs.length?cs.map(function(c,i){ return '<div class="row" data-ch="'+esc(i)+'"><span class="t">'+esc(c.title)+'</span><span class="d">'+formatClock(c.start)+'</span></div>' }).join(''):'<p class="muted">This book has no chapter list.</p>' }
          else { h='<div style="margin-bottom:8px"><button class="btn-secondary" id="abx-addbm">&#128278; Bookmark this spot ('+formatClock(pos())+')</button></div>'+(S.bookmarks.length?S.bookmarks.map(function(b){ return '<div class="row" data-bm="'+esc(b.id)+'" data-at="'+esc(b.at)+'"><span class="t">'+formatClock(b.at)+(b.note?' &mdash; '+esc(b.note):'')+'</span><button data-del="'+esc(b.id)+'">Delete</button></div>' }).join(''):'<p class="muted">No bookmarks yet.</p>') }
          el.innerHTML=h;
          Array.prototype.forEach.call(el.querySelectorAll('[data-ch]'),function(r){ r.onclick=function(){ seekBook(S.book.chapters[+r.getAttribute('data-ch')].start,true) } });
          Array.prototype.forEach.call(el.querySelectorAll('[data-bm]'),function(r){ r.onclick=function(e){ if(e.target.getAttribute('data-del')) return; seekBook(+r.getAttribute('data-at'),true) } });
          Array.prototype.forEach.call(el.querySelectorAll('[data-del]'),function(b){ b.onclick=function(e){ e.stopPropagation(); api('DELETE','/book/'+S.book.id+'/bookmarks/'+b.getAttribute('data-del')).then(function(){ S.bookmarks=S.bookmarks.filter(function(x){ return x.id!==b.getAttribute('data-del') }); renderList(); tabLabels() }) } });
          var add=$('abx-addbm'); if(add) add.onclick=function(){ var n=window.prompt('Note for this bookmark (optional)',''); if(n===null) return; api('POST','/book/'+S.book.id+'/bookmarks',{at:pos(),note:n}).then(function(d){ if(d&&d.ok){ S.bookmarks.push(d.bookmark); S.bookmarks.sort(function(a,b){ return a.at-b.at }); renderList(); tabLabels() } else note('Could not save the bookmark.') }) }; ui() }
        function tabLabels(){ var a=$('abx-tab-ch'), b=$('abx-tab-bm'); if(a) a.textContent='Chapters ('+S.book.chapters.length+')'; if(b) b.textContent='Bookmarks ('+S.bookmarks.length+')'; if(a) a.classList.toggle('on',S.tab==='chapters'); if(b) b.classList.toggle('on',S.tab==='bookmarks') }

        function panelHtml(){ var b=S.book; var sp=SPEEDS.slice(); if(sp.indexOf(S.speed)<0){ sp.push(S.speed); sp.sort(function(x,y){ return x-y }) }
          return '<div style="display:flex;justify-content:flex-end"><button class="btn-secondary" id="abx-close">Close</button></div>'
            +'<div class="abx-head">'+(b.cover?'<img src="'+esc(b.cover)+'" alt="">':'<div class="abx-nocover" style="width:120px;height:120px">&#127911;</div>')+'<div style="min-width:0"><h3 style="margin:0">'+esc(b.title)+'</h3><div class="muted">'+esc(b.author)+'</div>'
            +(b.narrator?'<div class="muted">Narrated by '+esc(b.narrator)+'</div>':'')+(b.series?'<div class="muted">'+esc(b.series)+(b.seriesIndex!=null?', book '+esc(b.seriesIndex):'')+'</div>':'')+'<div class="muted">'+formatLeft(b.duration)+(b.year?' · '+esc(b.year):'')+'</div></div></div>'
            +'<div id="abx-chapter" style="font-weight:600;text-align:center;min-height:1.3em"></div>'
            +'<div class="abx-seek"><span id="abx-cur">0:00</span><input type="range" id="abx-range" min="0" max="'+Math.round(b.duration)+'" step="1" value="0"><span id="abx-left"></span></div>'
            +'<div class="abx-ctrl"><button id="abx-prevch" title="Previous chapter">&#9198;</button><button id="abx-back" title="Back">&#8634; '+S.prefs.skipBack+'</button><button id="abx-play" class="big" title="Play / pause">&#9654;</button><button id="abx-fwd" title="Forward">'+S.prefs.skipForward+' &#8635;</button><button id="abx-nextch" title="Next chapter">&#9197;</button></div>'
            +'<div class="abx-opts"><span>Speed <button id="abx-slower">&minus;</button> <select id="abx-speed">'+sp.map(function(x){ return '<option value="'+x+'">'+x+'x</option>' }).join('')+'</select> <button id="abx-faster">+</button></span>'
            +'<span>Sleep <select id="abx-sleep"><option value="0">Off</option><option value="5">5 min</option><option value="10">10 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">90 min</option><option value="chapter">End of chapter</option></select></span>'
            +'<span id="abx-sleepleft"></span><button id="abx-sleepplus" style="display:none">+5 min</button></div>'
            +'<div id="abx-note" class="muted" style="min-height:1.2em"></div>'
            +'<div class="abx-tabs" style="margin:8px 0"><button id="abx-tab-ch" data-tab="chapters"></button> <button id="abx-tab-bm" data-tab="bookmarks"></button></div>'
            +'<div class="abx-list" id="abx-list"></div>'
            +'<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn-secondary" id="abx-fin">Mark as finished</button><button class="btn-secondary" id="abx-unfin">Start over</button>'+(S.next?'<button class="btn-secondary" id="abx-next">Next in series: '+esc(S.next.title)+'</button>':'')+'</div>' }
        function wirePanel(){
          $('abx-close').onclick=function(){ panel.style.display='none' };
          $('abx-play').onclick=togglePlay; $('abx-back').onclick=function(){ seekBook(skipTarget(pos(),-S.prefs.skipBack,dur())) }; $('abx-fwd').onclick=function(){ seekBook(skipTarget(pos(),S.prefs.skipForward,dur())) };
          $('abx-prevch').onclick=function(){ var t=previousChapterStart(S.book.chapters,pos()); seekBook(t===null?0:t) }; $('abx-nextch').onclick=function(){ var t=nextChapterStart(S.book.chapters,pos()); if(t!==null) seekBook(t) };
          var rg=$('abx-range'); rg.oninput=function(){ var c=$('abx-cur'); if(c) c.textContent=formatClock(+rg.value) }; rg.onchange=function(){ seekBook(+rg.value); rg.blur() };
          $('abx-speed').onchange=function(){ setSpeed(+this.value,true) }; $('abx-slower').onclick=function(){ setSpeed(S.speed-0.05,true) }; $('abx-faster').onclick=function(){ setSpeed(S.speed+0.05,true) };
          $('abx-sleep').onchange=function(){ setSleep(this.value) }; $('abx-sleepplus').onclick=function(){ S.sleep=sleepExtend(S.sleep,5,Date.now()); sleepLabel() };
          Array.prototype.forEach.call(pin.querySelectorAll('[data-tab]'),function(b){ b.onclick=function(){ S.tab=b.getAttribute('data-tab'); renderList(); tabLabels() } });
          $('abx-fin').onclick=function(){ api('POST','/book/'+S.book.id+'/finished',{finished:true}).then(function(d){ if(d&&d.ok){ audio.pause(); S.progress=d.progress; note('Marked as finished.'); loadShelf() } }) };
          $('abx-unfin').onclick=function(){ api('POST','/book/'+S.book.id+'/finished',{finished:false}).then(function(d){ if(d&&d.ok){ S.progress=d.progress; seekBook(0,false); note('Back at the start.'); loadShelf() } }) };
          var nx=$('abx-next'); if(nx) nx.onclick=function(){ openBook(S.next.id,{autoplay:true}) }; }
        function togglePlay(){ if(!S.book) return; if(audio.paused){ if(S.pendingSeek===null&&!audio.getAttribute('src')) loadPart(S.idx,0,true); else audio.play().catch(function(){}) } else audio.pause() }
        $('abx-mplay').onclick=function(e){ e.stopPropagation(); togglePlay() };
        bar.onclick=function(){ if(S.book){ panel.style.display='block' } };
        panel.addEventListener('click',function(e){ if(e.target===panel) panel.style.display='none' });

        function openBook(id,o){ o=o||{}; if(S.book&&S.book.id===id){ panel.style.display='block'; if(o.autoplay&&audio.paused) togglePlay(); return }
          if(S.book&&S.playing) save(true);
          api('GET','/book/'+id+'?tokens=1').then(function(d){ if(!d||!d.ok){ return }
            S.book=d.book; S.progress=d.progress; S.bookmarks=d.bookmarks||[]; S.next=d.nextInSeries; S.prefs=d.prefs||S.prefs; S.speed=clampSpeed(d.speed||1); S.sleep=null; S.tab='chapters'; audio.volume=1;
            var start=d.progress&&!d.progress.finished?d.progress.position:0; if(o.position!=null) start=o.position;
            pin.innerHTML=panelHtml(); wirePanel(); tabLabels(); renderList(); setSpeed(S.speed,false);
            var mp=$('abx-mt'); if(mp) mp.textContent=d.book.title; var ma=$('abx-ma'); if(ma) ma.textContent=d.book.author; var mi=$('abx-mimg'); if(mi){ if(d.book.cover){ mi.src=d.book.cover; mi.style.visibility='visible' } else mi.style.visibility='hidden' }
            bar.style.display='flex'; panel.style.display='block';
            var l=locate(d.book.parts,start); audio.removeAttribute('data-part'); loadPart(l.index,l.offset,!!o.autoplay); ui();
            if('mediaSession' in navigator){ try{ navigator.mediaSession.metadata=new MediaMetadata({title:d.book.title,artist:d.book.author,album:d.book.series||'Audiobooks',artwork:d.book.cover?[{src:d.book.cover}]:[]});
              navigator.mediaSession.setActionHandler('play',function(){ togglePlay() }); navigator.mediaSession.setActionHandler('pause',function(){ audio.pause() });
              navigator.mediaSession.setActionHandler('seekbackward',function(){ seekBook(skipTarget(pos(),-S.prefs.skipBack,dur())) }); navigator.mediaSession.setActionHandler('seekforward',function(){ seekBook(skipTarget(pos(),S.prefs.skipForward,dur())) });
              navigator.mediaSession.setActionHandler('previoustrack',function(){ var t=previousChapterStart(S.book.chapters,pos()); seekBook(t===null?0:t) }); navigator.mediaSession.setActionHandler('nexttrack',function(){ var t=nextChapterStart(S.book.chapters,pos()); if(t!==null) seekBook(t) }) }catch(e){} } }) }

        loadShelf(); loadBooks(); renderMain();
      })();`

function pageBody({ nav, status }) {
  const st = status || {}
  const empty = !st.configured
    ? '<p class="empty">No Audiobooks folder yet. On the Beebo computer, open Settings and choose your Audiobooks folder.</p>'
    : st.scanning && !st.bookCount
      ? `<p class="empty">Reading your audiobooks&hellip; ${Number(st.progress && st.progress.done) || 0} of ${Number(st.progress && st.progress.total) || 0} files so far.</p>`
      : !st.bookCount
        ? '<p class="empty">No audiobooks found in your Audiobooks folders yet. Put an .m4b file, or a folder of .mp3 / .flac files, in the folder and check again.</p>'
        : ''
  return `
      <div class="topbar">
        <h2 style="margin:0;">Beebo Entertainment</h2>
        <a href="/logout" class="muted" style="color:#8a8f98;">Log out</a>
      </div>
      ${nav}
      ${STYLE}
      <div class="abx-top">
        <input id="abx-q" placeholder="Search title, author, narrator or series">
        <span class="abx-tabs"><button data-view="library" class="on">All books</button> <button data-view="series">Series</button> <button data-view="order">Reading order</button></span>
        <span class="muted">${escapeHtml(String(st.bookCount || 0))} books &middot; ${escapeHtml(String(st.seriesCount || 0))} series${st.scanning ? ' &middot; still reading&hellip;' : ''}</span>
      </div>
      ${empty}
      <div id="abx-shelf"></div>
      <div id="abx-main"></div>
      <div class="abx-panel" id="abx-panel"><div class="in" id="abx-pin"></div></div>
      <div class="abx-bar" id="abx-bar">
        <img id="abx-mimg" alt="">
        <div class="mt"><div id="abx-mt" style="font-weight:600"></div><div id="abx-ma" class="muted"></div><div id="abx-mtime" class="muted"></div></div>
        <button id="abx-mplay" title="Play / pause">&#9654;</button>
      </div>
      <audio id="abx-audio" preload="metadata"></audio>
      <script>${SCRIPT}</script>`
}

module.exports = { pageBody, escapeHtml, INLINED }
