'use strict'
// BeeboSchool — kid-facing lessons page BODY (styles + markup + script).
//
// Auth model: the server mints an API bearer token for the logged-in user and
// passes it to schoolBody(token); the page calls the EXISTING /api/school/*
// endpoints with that token. No backend/auth changes are needed — this is a
// pure additive front-end that reuses the already-built BeeboSchool backend.
function schoolBody(token, isAdmin) {
  return `
        <style>
          /* ---- BeeboSchool kid UI (scoped under #bs) ---- */
          #bs { max-width: 820px; margin: 4px auto 40px; -webkit-tap-highlight-color: transparent; }
          #bs .bs-hidden { display: none !important; }
          #bs h1 { font-size: 34px; text-align: center; margin: 6px 0 2px; }
          #bs .bs-sub { text-align: center; color: #8a8f98; margin: 0 0 22px; font-size: 16px; }
          #bs .bs-topline { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
          #bs .bs-kidchip { display:inline-flex; align-items:center; gap:8px; background:#171a21; border:1px solid #2a2f3a;
            border-radius:999px; padding:8px 14px; font-size:16px; font-weight:700; color:#eee; cursor:pointer; }
          #bs .bs-points { display:inline-flex; align-items:center; gap:8px; background:#241f0f; border:1px solid #6b5a2b;
            color:#ffd93b; border-radius:999px; padding:8px 16px; font-size:18px; font-weight:800; }
          #bs .bs-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px; }
          #bs .bs-tile { border:none; border-radius:22px; padding:30px 18px; text-align:center; cursor:pointer;
            color:#12131a; font-weight:800; font-size:24px; box-shadow:0 8px 0 rgba(0,0,0,0.35); transition:transform .08s ease; }
          #bs .bs-tile:active { transform:translateY(4px); box-shadow:0 4px 0 rgba(0,0,0,0.35); }
          #bs .bs-tile .bs-emoji { display:block; font-size:60px; line-height:1; margin-bottom:12px; }
          #bs .bs-tile .bs-tsub { display:block; font-size:15px; font-weight:600; opacity:.75; margin-top:6px; }
          #bs .bs-kidbtns { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; }
          #bs .bs-kidbtn { border:none; border-radius:20px; padding:26px 16px; font-size:26px; font-weight:800; color:#12131a;
            background:#4f9dff; cursor:pointer; box-shadow:0 7px 0 rgba(0,0,0,0.35); }
          #bs .bs-kidbtn:active { transform:translateY(4px); box-shadow:0 3px 0 rgba(0,0,0,0.35); }
          #bs .bs-progress { display:flex; gap:8px; justify-content:center; margin:6px 0 18px; }
          #bs .bs-dot { width:16px; height:16px; border-radius:50%; background:#2a2f3a; }
          #bs .bs-dot.bs-done { background:#3ddc84; }
          #bs .bs-dot.bs-now { background:#ffd93b; }
          #bs .bs-question { text-align:center; font-size:30px; font-weight:800; margin:6px 0 4px; }
          #bs .bs-speak { display:block; margin:0 auto 18px; background:#2a2f3a; color:#eee; border:none; border-radius:999px;
            padding:8px 18px; font-size:16px; font-weight:700; cursor:pointer; }
          #bs .bs-stage { text-align:center; font-size:56px; line-height:1.25; margin:8px 0 20px; min-height:70px; }
          #bs .bs-choices { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:16px; max-width:560px; margin:0 auto; }
          #bs .bs-choice { border:none; border-radius:20px; min-height:110px; font-size:52px; font-weight:800; color:#12131a;
            background:#eef1f6; cursor:pointer; box-shadow:0 7px 0 rgba(0,0,0,0.3); transition:transform .08s ease; }
          #bs .bs-choice:active { transform:translateY(4px); box-shadow:0 3px 0 rgba(0,0,0,0.3); }
          #bs .bs-choice.bs-right { background:#3ddc84 !important; animation:bs-pop .3s ease; }
          #bs .bs-choice.bs-wrong { animation:bs-shake .4s ease; }
          #bs .bs-choice.bs-hint { outline:5px dashed #ffd93b; outline-offset:3px; animation:bs-pulse 1s ease infinite; }
          #bs .bs-swatch { min-height:120px; }
          @keyframes bs-pop { 0%{transform:scale(1)} 40%{transform:scale(1.12)} 100%{transform:scale(1)} }
          @keyframes bs-shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} }
          @keyframes bs-pulse { 0%,100%{outline-color:#ffd93b} 50%{outline-color:#fff2a8} }
          #bs .bs-reward { text-align:center; padding:20px 0; }
          #bs .bs-pet { font-size:96px; line-height:1; animation:bs-bob 1.4s ease-in-out infinite; }
          @keyframes bs-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-14px)} }
          #bs .bs-stars { font-size:56px; letter-spacing:6px; margin:10px 0; }
          #bs .bs-bignum { font-size:26px; font-weight:800; color:#ffd93b; margin:8px 0 18px; }
          #bs .bs-nav { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-top:26px; }
          #bs .bs-navbtn { background:#2a2f3a; color:#eee; border:none; border-radius:14px; padding:14px 22px;
            font-size:17px; font-weight:700; cursor:pointer; text-decoration:none; display:inline-block; }
          #bs .bs-navbtn.bs-home { background:#4f9dff; color:#fff; }
          #bs .bs-msg { text-align:center; background:#171a21; border:1px solid #2a2f3a; border-radius:16px;
            padding:30px 22px; font-size:20px; line-height:1.5; }
          #bs .bs-toast { position:fixed; left:50%; top:22px; transform:translateX(-50%); background:#1f3a2a;
            border:1px solid #2b6b45; color:#9dffb8; padding:12px 20px; border-radius:14px; font-size:20px; font-weight:800;
            z-index:50; opacity:0; transition:opacity .2s ease; pointer-events:none; }
          #bs .bs-toast.bs-show { opacity:1; }
        </style>

        <div id="bs">
          <div id="bs-toast" class="bs-toast"></div>

          <section id="bs-screen-pick">
            <h1>🎓 BeeboSchool</h1>
            <p class="bs-sub">Who is playing today?</p>
            <div id="bs-kidlist" class="bs-kidbtns"></div>
            <div id="bs-nokids" class="bs-msg bs-hidden">
              👋 Hello! Ask a grown-up to add you in the <b>Beebo</b> app first,<br>then come back and play. 🐝
            </div>
            <div class="bs-nav">
              <a class="bs-navbtn bs-home" href="/">🏠 Home</a>
            </div>
          </section>

          <section id="bs-screen-lessons" class="bs-hidden">
            <div class="bs-topline">
              <button id="bs-kidchip" class="bs-kidchip" type="button">👤 <span id="bs-kidname"></span> · change</button>
              <span class="bs-points">⭐ <span id="bs-points">0</span></span>
            </div>
            <h1>Pick a lesson!</h1>
            <p class="bs-sub">Tap a card to start playing.</p>
            <div class="bs-tiles">
              <button class="bs-tile" type="button" data-lesson="letters" style="background:#7ee0ff;">
                <span class="bs-emoji">🔤</span>Letters<span class="bs-tsub">Find the letter</span>
              </button>
              <button class="bs-tile" type="button" data-lesson="counting" style="background:#8affc1;">
                <span class="bs-emoji">🔢</span>Counting<span class="bs-tsub">How many?</span>
              </button>
              <button class="bs-tile" type="button" data-lesson="colors" style="background:#ffb0e0;">
                <span class="bs-emoji">🎨</span>Colours<span class="bs-tsub">Tap the colour</span>
              </button>
            </div>
            <div class="bs-nav">
              <a class="bs-navbtn bs-home" href="/">🏠 Home</a>
            </div>
          </section>

          <section id="bs-screen-play" class="bs-hidden">
            <div id="bs-progress" class="bs-progress"></div>
            <div id="bs-question" class="bs-question"></div>
            <button id="bs-speak" class="bs-speak" type="button">🔊 Say it again</button>
            <div id="bs-stage" class="bs-stage"></div>
            <div id="bs-choices" class="bs-choices"></div>
            <div class="bs-nav">
              <button id="bs-back-lessons" class="bs-navbtn" type="button">← All lessons</button>
              <a class="bs-navbtn bs-home" href="/">🏠 Home</a>
            </div>
          </section>

          <section id="bs-screen-reward" class="bs-hidden">
            <div class="bs-reward">
              <div id="bs-pet" class="bs-pet">🐝</div>
              <div id="bs-reward-title" style="font-size:30px;font-weight:800;margin:6px 0;">Great job!</div>
              <div id="bs-stars" class="bs-stars">⭐⭐⭐</div>
              <div id="bs-earned" class="bs-bignum"></div>
              <div id="bs-encourage" class="bs-sub" style="font-size:18px;"></div>
            </div>
            <div class="bs-kidbtns" style="max-width:560px;margin:0 auto;">
              <button id="bs-again" class="bs-kidbtn" type="button" style="background:#8affc1;">🔁 Play again</button>
              <button id="bs-more" class="bs-kidbtn" type="button" style="background:#7ee0ff;">🎓 More lessons</button>
            </div>
            <div class="bs-nav">
              <a class="bs-navbtn bs-home" href="/">🏠 Home</a>
            </div>
          </section>
        </div>

        <script>
        (function () {
          'use strict';
          var BS_TOKEN = ${JSON.stringify(String(token || ''))};
          var BS_ADMIN = ${isAdmin ? 'true' : 'false'};
          var $ = function (id) { return document.getElementById(id); };
          var screens = { pick:'bs-screen-pick', lessons:'bs-screen-lessons', play:'bs-screen-play', reward:'bs-screen-reward' };
          function show(name) {
            Object.keys(screens).forEach(function (k) {
              var el = $(screens[k]);
              if (el) el.classList.toggle('bs-hidden', k !== name);
            });
            try { window.scrollTo(0, 0); } catch (e) {}
          }
          function toast(msg) {
            var t = $('bs-toast'); if (!t) return;
            t.textContent = msg; t.classList.add('bs-show');
            clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('bs-show'); }, 1100);
          }
          function say(text) {
            try {
              if (!('speechSynthesis' in window)) return;
              window.speechSynthesis.cancel();
              var u = new SpeechSynthesisUtterance(text);
              u.rate = 0.9; u.pitch = 1.15;
              window.speechSynthesis.speak(u);
            } catch (e) {}
          }
          function rand(n) { return Math.floor(Math.random() * n); }
          function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = rand(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
          function sample(arr, n, must) {
            var pool = arr.slice(); var out = must != null ? [must] : [];
            shuffle(pool);
            for (var i = 0; i < pool.length && out.length < n; i++) { if (pool[i] !== must) out.push(pool[i]); }
            return shuffle(out);
          }

          var LESSON_LABEL = { letters: 'Letters', counting: 'Counting', colors: 'Colours' };
          var TASKS_PER = 7;

          var child = null;
          var profile = { points: 0, pet: null };
          var lesson = null;
          var tasks = [];
          var plan = [];
          var idx = 0;
          var sessionStart = 0;
          var shownAt = 0;
          var answered = false;
          var wrongThisTask = 0;
          var hintThisTask = false;

          function api(path, opts) {
            opts = opts || {};
            var h = { 'Authorization': 'Bearer ' + BS_TOKEN };
            if (opts.headers) { for (var k in opts.headers) h[k] = opts.headers[k]; }
            opts.headers = h;
            return fetch(path, opts).then(function (r) { return r.json(); }).catch(function () { return null; });
          }
          function loadChildren() {
            return api('/api/school/children').then(function (d) {
              return (d && d.children) ? d.children : [];
            });
          }
          function loadProfile(id) {
            return api('/api/school/profile?child=' + encodeURIComponent(id)).then(function (d) {
              profile = (d && d.profile) ? d.profile : { points: 0, pet: null };
              return profile;
            });
          }

          function renderKids(kids) {
            var wrap = $('bs-kidlist'); wrap.textContent = '';
            var palette = ['#7ee0ff', '#8affc1', '#ffb0e0', '#ffd98a', '#c8b0ff', '#ffb3a0'];
            kids.forEach(function (k, i) {
              var b = document.createElement('button');
              b.type = 'button'; b.className = 'bs-kidbtn';
              b.style.background = palette[i % palette.length];
              b.textContent = '🙂 ' + (k.name || 'Me');
              b.addEventListener('click', function () { pickChild(k); });
              wrap.appendChild(b);
            });
            if (BS_ADMIN) {
              // Grown-up only: add a child so they can start playing.
              var add = document.createElement('button');
              add.type = 'button'; add.className = 'bs-kidbtn';
              add.style.background = '#2a2f3a'; add.style.color = '#eee';
              add.textContent = '➕ Add a child';
              add.addEventListener('click', addChild);
              wrap.appendChild(add);
              $('bs-nokids').classList.add('bs-hidden');
            } else {
              $('bs-nokids').classList.toggle('bs-hidden', kids.length > 0);
            }
          }
          function addChild() {
            var name = (window.prompt('Add a child — what is their name?') || '').trim();
            if (!name) return;
            api('/api/school/children', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name })
            }).then(function () { loadChildren().then(renderKids); });
          }
          function pickChild(k) {
            child = { id: k.id, name: k.name || 'Me' };
            try { sessionStorage.setItem('bsChild', JSON.stringify(child)); } catch (e) {}
            $('bs-kidname').textContent = child.name;
            loadProfile(child.id).then(function () {
              $('bs-points').textContent = profile.points || 0;
              show('lessons');
            });
          }

          var LETTERS = 'ABCDEFGHIJKLMNOPRSTUW'.split('');
          var OBJECTS = ['🍎', '⭐', '🐝', '🎈', '🐟', '🌸', '🚗', '🍪', '🦋', '🐸'];
          var COLOURS = [
            { name: 'red', hex: '#ff4d4d' }, { name: 'blue', hex: '#4f9dff' },
            { name: 'green', hex: '#3ddc84' }, { name: 'yellow', hex: '#ffd93b' },
            { name: 'orange', hex: '#ff8c42' }, { name: 'purple', hex: '#b06bff' },
            { name: 'pink', hex: '#ff7ac0' }, { name: 'brown', hex: '#b07a4a' }
          ];

          function buildPlan(which) {
            var out = [];
            for (var i = 0; i < TASKS_PER; i++) {
              if (which === 'letters') {
                var tgt = LETTERS[rand(LETTERS.length)];
                out.push({ answer: tgt, choices: sample(LETTERS, 4, tgt) });
              } else if (which === 'counting') {
                var n = 1 + rand(6);
                var obj = OBJECTS[rand(OBJECTS.length)];
                var nums = []; for (var x = 1; x <= 9; x++) nums.push(x);
                out.push({ answer: n, obj: obj, choices: sample(nums, 4, n) });
              } else {
                var c = COLOURS[rand(COLOURS.length)];
                var names = COLOURS.map(function (o) { return o.name; });
                var chosen = sample(names, 4, c.name);
                var swatches = chosen.map(function (nm) {
                  var found = COLOURS.filter(function (o) { return o.name === nm; })[0];
                  return { name: nm, hex: found.hex };
                });
                out.push({ answer: c.name, choices: swatches });
              }
            }
            return out;
          }

          function startLesson(which) {
            lesson = which;
            plan = buildPlan(which);
            tasks = [];
            idx = 0;
            sessionStart = Date.now();
            show('play');
            renderTask();
          }
          function renderProgress() {
            var p = $('bs-progress'); p.textContent = '';
            for (var i = 0; i < plan.length; i++) {
              var d = document.createElement('div');
              d.className = 'bs-dot' + (i < idx ? ' bs-done' : (i === idx ? ' bs-now' : ''));
              p.appendChild(d);
            }
          }
          function questionText() {
            var t = plan[idx];
            if (lesson === 'letters') return 'Find the letter ' + t.answer + '!';
            if (lesson === 'counting') return 'How many do you see?';
            return 'Tap the ' + t.answer + ' one!';
          }
          function renderTask() {
            answered = false; wrongThisTask = 0; hintThisTask = false;
            renderProgress();
            var t = plan[idx];
            var qEl = $('bs-question'); qEl.textContent = questionText();
            var stage = $('bs-stage'); stage.textContent = '';
            if (lesson === 'counting') {
              var row = '';
              for (var i = 0; i < t.answer; i++) row += t.obj;
              stage.textContent = row;
            } else if (lesson === 'colors') {
              stage.textContent = '🎨';
            } else {
              stage.textContent = '👀';
            }
            var box = $('bs-choices'); box.textContent = '';
            t.choices.forEach(function (choice) {
              var b = document.createElement('button');
              b.type = 'button'; b.className = 'bs-choice';
              if (lesson === 'colors') {
                b.classList.add('bs-swatch');
                b.style.background = choice.hex;
                b.setAttribute('aria-label', choice.name);
                b.dataset.val = choice.name;
              } else {
                b.textContent = String(choice);
                b.dataset.val = String(choice);
              }
              b.addEventListener('click', function () { onChoice(b, choice); });
              box.appendChild(b);
            });
            shownAt = (window.performance && performance.now) ? performance.now() : Date.now();
            say(lesson === 'counting' ? 'How many do you see?'
              : (lesson === 'letters' ? 'Find the letter ' + t.answer : 'Tap the ' + t.answer + ' one'));
          }
          function correctVal() {
            var t = plan[idx];
            return lesson === 'colors' ? t.answer : t.answer;
          }
          function valueOf(choice) {
            return lesson === 'colors' ? choice.name : choice;
          }
          function onChoice(btn, choice) {
            var t = plan[idx];
            var picked = valueOf(choice);
            var isRight = (picked === correctVal()) || (String(picked) === String(correctVal()));
            var now = (window.performance && performance.now) ? performance.now() : Date.now();
            if (!answered) {
              answered = true;
              tasks.push({
                type: lesson,
                correct: !!isRight,
                first: Math.max(0, Math.round(now - shownAt)),
                hint: false,
                motion: 'still'
              });
            }
            if (isRight) {
              btn.classList.add('bs-right');
              if (hintThisTask && tasks.length) tasks[tasks.length - 1].hint = true;
              disableChoices();
              say('Yes!'); toast('🎉 Yes!');
              setTimeout(next, 750);
            } else {
              btn.classList.add('bs-wrong');
              setTimeout(function () { btn.classList.remove('bs-wrong'); }, 400);
              wrongThisTask++;
              say('Try again'); toast('Try again 🙂');
              if (wrongThisTask >= 2 && !hintThisTask) {
                hintThisTask = true;
                if (tasks.length) tasks[tasks.length - 1].hint = true;
                highlightAnswer();
              }
            }
          }
          function disableChoices() {
            var kids = $('bs-choices').children;
            for (var i = 0; i < kids.length; i++) { kids[i].disabled = true; }
          }
          function highlightAnswer() {
            var kids = $('bs-choices').children;
            for (var i = 0; i < kids.length; i++) {
              if (kids[i].dataset.val === String(correctVal())) kids[i].classList.add('bs-hint');
            }
          }
          function next() {
            idx++;
            if (idx >= plan.length) { finishLesson(); return; }
            renderTask();
          }

          function finishLesson() {
            var at = Date.now();
            var ms = at - sessionStart;
            var session = {
              profileId: child.id,
              lesson: lesson,
              at: at,
              ms: ms,
              motion: 'still',
              tasks: tasks
            };
            api('/api/school/sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessions: [session] })
            });
            var firstTry = tasks.filter(function (t) { return t.correct; }).length;
            var earned = 5 + firstTry * 2;
            api('/api/school/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ child: child.id, addPoints: earned })
            }).then(function (d) {
              if (d && d.profile) { profile = d.profile; $('bs-points').textContent = profile.points || 0; }
            });
            showReward(firstTry, tasks.length, earned);
          }
          function showReward(firstTry, total, earned) {
            var pet = (profile && profile.pet && profile.pet.emoji) ? profile.pet.emoji : '🐝';
            $('bs-pet').textContent = pet;
            var ratio = total ? firstTry / total : 1;
            var stars = ratio >= 0.8 ? 3 : (ratio >= 0.5 ? 2 : 1);
            $('bs-stars').textContent = '⭐⭐⭐'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
            $('bs-reward-title').textContent = 'You did it!';
            $('bs-earned').textContent = '+' + earned + ' points!';
            var msgs = ['Amazing work! 🌟', 'You are a superstar! ✨', 'So clever! 🐝', 'Well done, keep going! 🎈'];
            $('bs-encourage').textContent = msgs[rand(msgs.length)];
            say('You did it! Well done!');
            show('reward');
          }

          Array.prototype.forEach.call(document.querySelectorAll('#bs .bs-tile'), function (tile) {
            tile.addEventListener('click', function () { startLesson(tile.dataset.lesson); });
          });
          $('bs-speak').addEventListener('click', function () {
            var t = plan[idx]; if (!t) return;
            say(lesson === 'counting' ? 'How many do you see?'
              : (lesson === 'letters' ? 'Find the letter ' + t.answer : 'Tap the ' + t.answer + ' one'));
          });
          $('bs-back-lessons').addEventListener('click', function () { try { window.speechSynthesis.cancel(); } catch (e) {} show('lessons'); });
          $('bs-again').addEventListener('click', function () { startLesson(lesson); });
          $('bs-more').addEventListener('click', function () { show('lessons'); });
          $('bs-kidchip').addEventListener('click', function () {
            try { sessionStorage.removeItem('bsChild'); } catch (e) {}
            child = null; show('pick');
          });

          loadChildren().then(function (kids) {
            renderKids(kids);
            show('pick');
            try {
              var saved = JSON.parse(sessionStorage.getItem('bsChild') || 'null');
              if (saved && saved.id && kids.some(function (k) { return k.id === saved.id; })) {
                pickChild(saved);
              }
            } catch (e) {}
          });
        })();
        </script>
  `
}

module.exports = { schoolBody }
