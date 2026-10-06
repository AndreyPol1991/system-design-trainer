/* «Провалиться внутрь»: узел увеличивается во весь экран, внутри — живая модель того, как он работает.
   Каркас общий, сцены для типов узлов регистрируются в SD.XRAY[type]. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const KEY = 'amp-stroyka-xray-v1';
  SD.XRAY = SD.XRAY || {};
  const A = () => SD.app.A;
  const resAll = () => A().res1 || A().res;
  const nodeOf = id => A().graph.nodes.find(n => n.id === id);
  const nm = n => n ? (n.label || SD.TYPES[n.type].name) : '';
  const X = { stack: [], id: null, sc: null, def: null, raf: 0, speed: 0.5, run: true, last: 0, statT: 0, resRef: null, log: [], scn: null, done: {}, view: null };
  /* у сцены может быть несколько видов, у каждого — свои ситуации */
  const partsOf = () => { const p = X.def && X.def.parts; return (typeof p === 'function' ? p(X.view) : p) || null; };
  const scnList = () => { const v = X.def && X.def.views && X.def.views.find(x => x.id === X.view); return (v && v.scenarios) || (X.def && X.def.scenarios) || []; };
  const loadDone = () => { try { X.done = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { X.done = {}; } };
  const saveDone = () => { try { localStorage.setItem(KEY, JSON.stringify(X.done)); } catch (e) { /* без хранилища */ } };
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  function mount() {
    const m = document.createElement('div');
    m.className = 'modal xr-modal'; m.id = 'xrModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet xr-sheet" role="dialog" aria-modal="true" aria-labelledby="xrTitle">
      <div class="sheet-head xr-head"><nav class="xr-crumbs" id="xrCrumbs" aria-label="Где ты"></nav><div class="xr-live" id="xrLive"></div><button class="btn ghost x" type="button" data-close>Закрыть</button></div>
      <div class="xr-body">
        <div class="xr-main">
          <div class="xr-ctl" id="xrCtl"></div>
          <div class="xr-pan"><svg class="xr-svg" id="xrSvg" viewBox="0 0 1000 500" role="img" aria-labelledby="xrTitle"></svg></div>
          <p class="xr-pan-tip">Картинка шире экрана — листай её пальцем влево и вправо.</p>
          <div class="xr-html" id="xrHtml" hidden></div>
          <p class="xr-hint" id="xrHint" hidden></p>
          <div class="xr-stats" id="xrStats"></div>
        </div>
        <aside class="xr-side">
          <div class="simple" id="xrSimple"></div>
          <div id="xrPart"></div>
          <div id="xrParts"></div>
          <div class="lab-card xr-now" id="xrNow"></div>
          <div id="xrProps"></div>
          <h3 class="xr-h">Попробуй</h3><ul class="lab-tasks xr-tries" id="xrTries"></ul>
          <h3 class="xr-h">Что на картинке</h3><ul class="xr-legend" id="xrLegend"></ul>
          <h3 class="xr-h">Что происходило</h3><ul class="lab-log" id="xrLog"></ul>
          <div class="xr-nb" id="xrNb"></div>
        </aside>
      </div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('change', onChange);
    m.addEventListener('input', e => { const t = e.target; if (t.dataset.xp && t.type === 'range') { const o = t.parentElement.querySelector('output'); if (o) o.textContent = t.value; } });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('xrModal').hidden) { e.stopPropagation(); back(); } }, true);
  }
  /* сцены грузятся по требованию: SD.XRAY_LAZY[type] — файл сцены (js/xray-lazy.js). После загрузки новую сцену
     оборачивают SD.XRAY_HOOKS — «на данных», «Бизнес», мини-графики — в том же порядке, в каком подключены их файлы */
  SD.XRAY_LAZY = SD.XRAY_LAZY || {};
  SD.XRAY_HOOKS = SD.XRAY_HOOKS || [];
  const has = type => !!SD.XRAY[type] || !!SD.XRAY_LAZY[type];
  const files = {}, hooked = new Set();
  function need(type) {
    if (SD.XRAY[type] || !SD.XRAY_LAZY[type]) return Promise.resolve(!!SD.XRAY[type]);
    const src = SD.XRAY_LAZY[type];
    if (!files[src]) files[src] = new Promise(res => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => {
        Object.keys(SD.XRAY).filter(t => SD.XRAY_LAZY[t] && !hooked.has(t)).forEach(t => {
          hooked.add(t);
          SD.XRAY_HOOKS.forEach(h => { try { h(t); } catch (e) { if (window.console) console.warn('xray: обёртка сцены', t, e); } });
        });
        res();
      };
      s.onerror = () => { delete files[src]; res(); };
      document.head.appendChild(s);
    });
    return files[src].then(() => !!SD.XRAY[type]);
  }
  /* узел ещё без сцены: грузим и открываем; курсор «жду», чтобы было видно, что клик принят */
  function later(type, fn) {
    document.documentElement.classList.add('xr-loading');
    need(type).then(ok => { document.documentElement.classList.remove('xr-loading'); if (ok) fn(); else if (SD.app && SD.app.toast) SD.app.toast('Сцена не загрузилась — проверь интернет и попробуй ещё раз.'); });
  }
  /* через несколько секунд после старта, когда браузер свободен, подгружаем сцены узлов текущей схемы — открытие будет мгновенным */
  function prefetch() {
    const g = SD.app && SD.app.A && SD.app.A.graph; if (!g) return;
    [...new Set(g.nodes.map(n => n.type))].filter(t => !SD.XRAY[t] && SD.XRAY_LAZY[t]).reduce((p, t) => p.then(() => need(t)), Promise.resolve());
  }
  setTimeout(() => (window.requestIdleCallback || (f => setTimeout(f, 0)))(prefetch), 5000);

  /* ---------- открыть, перейти к соседу, вернуться ---------- */
  function open(id, fromEl) {
    const n = nodeOf(id); if (!n || !has(n.type)) return false;
    if (!SD.XRAY[n.type]) { later(n.type, () => open(id, fromEl)); return true; }
    X.stack = [id];
    show(id);
    zoom(fromEl || document.querySelector(`#nodesG .node[data-id="${id}"]`), false);
    seenHint(n);
    return true;
  }
  function go(id) {
    const n = nodeOf(id); if (!n || !has(n.type)) return;
    if (!SD.XRAY[n.type]) { later(n.type, () => go(id)); return; }
    const i = X.stack.indexOf(id);
    if (i >= 0) X.stack = X.stack.slice(0, i + 1); else X.stack.push(id);
    show(id);
    const sh = document.querySelector('#xrModal .xr-sheet');
    if (sh && !reduced() && sh.animate) sh.animate([{ transform: 'scale(.94)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function back() {
    if (X.part) { setPart(null); return; }
    if (X.stack.length > 1) { X.stack.pop(); show(X.stack[X.stack.length - 1]); return; }
    close();
  }
  function close() {
    const m = $('xrModal'); if (m.hidden) return;
    const el = document.querySelector(`#nodesG .node[data-id="${X.id}"]`);
    stop();
    const sh = m.querySelector('.xr-sheet');
    const tok = X.closeTok = (X.closeTok || 0) + 1;   /* закрытие доводим один раз и не трогаем окно, если его успели открыть снова */
    const fin = () => { if (X.closeTok !== tok) return; X.closeTok = 0; m.hidden = true; m.classList.remove('xr-out'); };
    if (el && sh.animate && !reduced()) { const k = flip(el, sh); if (k) { m.classList.add('xr-out'); const an = sh.animate([{ transform: 'none', opacity: 1 }, { transform: k, opacity: 0.2 }], { duration: 260, easing: 'ease-in' }); an.onfinish = fin; setTimeout(fin, 400); return; } }
    fin();
  }
  function flip(el, sh) {
    const r = el.getBoundingClientRect(), f = sh.getBoundingClientRect();
    if (!r.width || !f.width) return null;
    return `translate(${(r.left + r.width / 2 - (f.left + f.width / 2)).toFixed(1)}px,${(r.top + r.height / 2 - (f.top + f.height / 2)).toFixed(1)}px) scale(${(r.width / f.width).toFixed(3)},${(r.height / f.height).toFixed(3)})`;
  }
  function zoom(el) {
    const m = $('xrModal'), sh = m.querySelector('.xr-sheet');
    X.closeTok = 0; m.classList.remove('xr-out'); m.hidden = false;
    if (!el || !sh.animate || reduced()) return;
    const k = flip(el, sh); if (!k) return;
    sh.animate([{ transform: k, opacity: 0.35, borderRadius: '14px' }, { transform: 'none', opacity: 1 }], { duration: 440, easing: 'cubic-bezier(.2,.8,.2,1)' });
    m.animate([{ backgroundColor: 'transparent' }, {}], { duration: 440 });
  }
  function seenHint(n) {
    loadDone();
    if (X.done._seen || !SD.mentor) return;
    X.done._seen = 1; saveDone();
    SD.mentor.say(`Ты провалился внутрь узла «${esc(nm(n))}». Здесь видно, <b>как он работает</b>: каждый запрос — точка. Цифры вверху те же, что на площадке. Меняй настройки справа и ситуации над картинкой — и смотри, что происходит. Esc — на шаг назад.`, { force: true, mood: 'happy', auto: 16000, acts: [['Понял', 'hide', '', true]] });
  }

  /* ---------- показать сцену ---------- */
  function show(id) {
    stop();
    const n = nodeOf(id), def = SD.XRAY[n.type];
    X.id = id; X.def = def; X.log = []; X.part = null; X.view = def.views ? def.views[0].id : null; X.scn = scnList()[0] ? scnList()[0].id : null;
    X.speed = 0.5; X.run = true;
    loadDone();
    const ctx = makeCtx(n);
    $('xrSvg').setAttribute('viewBox', def.viewBox || '0 0 1000 500');
    $('xrSvg').innerHTML = ''; $('xrSvg').style.display = ''; { const tp0 = document.querySelector('.xr-pan-tip'); if (tp0) tp0.style.display = ''; } $('xrHtml').hidden = true; $('xrHtml').innerHTML = '';
    renderCrumbs(); renderLive(); renderCtl(); renderProps(); renderTries(); renderLegend(); renderNb(); renderParts(); renderPart();
    const s = def.simple ? def.simple(n) : null;
    $('xrSimple').innerHTML = s ? `<span class="eyebrow">Простыми словами</span><span class="an">${s.an}</span>${s.pl ? `<span class="pl">${s.pl}</span>` : ''}` : '';
    $('xrSimple').hidden = !s;
    X.ctx = ctx;
    X.sc = def.mount(ctx) || {};
    X.resRef = resAll();
    if (X.scn && X.sc.scenario) X.sc.scenario(X.scn, true);
    X.last = performance.now(); X.statT = 0;
    const tok = X.tok = (X.tok || 0) + 1;
    const loop = now => {
      if (tok !== X.tok || !X.sc) return;
      const dt = Math.min(100, now - X.last); X.last = now;
      if (resAll() !== X.resRef) { X.resRef = resAll(); refresh(); }
      if (X.run && X.sc.tick) X.sc.tick(dt * X.speed);
      if (X.sc.draw) X.sc.draw();
      if (now - X.statT > 300) { X.statT = now; side(); }
      X.raf = requestAnimationFrame(loop);
    };
    X.raf = requestAnimationFrame(loop);
    side();
  }
  function stop() { X.tok = (X.tok || 0) + 1; cancelAnimationFrame(X.raf); X.raf = 0; if (X.sc && X.sc.destroy) X.sc.destroy(); X.sc = null; }
  function refresh() {
    const n = nodeOf(X.id); if (!n) { close(); return; }
    X.ctx.node = n; X.ctx.res = (resAll() || { nodes: {} }).nodes[n.id] || {}; X.ctx.all = resAll();
    renderLive(); renderPropsVals(); renderNb();
    if (X.sc.refresh) X.sc.refresh();
  }
  function makeCtx(n) {
    const all = resAll() || { nodes: {}, edges: {} };
    const ctx = {
      node: n, res: all.nodes[n.id] || {}, all, A: A(), svg: $('xrSvg'), esc,
      nm: id => nm(nodeOf(id)), nodeOf,
      outs: () => A().graph.edges.filter(e => e.from === ctx.node.id).map(e => ({ e, n: nodeOf(e.to), r: (resAll() || { nodes: {} }).nodes[e.to] || {}, er: (resAll() || { edges: {} }).edges[e.id] || {} })).filter(x => x.n),
      ins: () => A().graph.edges.filter(e => e.to === ctx.node.id).map(e => ({ e, n: nodeOf(e.from), r: (resAll() || { nodes: {} }).nodes[e.from] || {}, er: (resAll() || { edges: {} }).edges[e.id] || {} })).filter(x => x.n),
      go: id => go(id), canGo: id => { const k = nodeOf(id); return !!(k && has(k.type)); },
      log: (txt, cls) => { X.log.unshift({ txt, cls: cls || '' }); X.log = X.log.slice(0, 9); },
      done: tid => doneTry(tid),
      setProp: (k, v) => SD.app.setProp(ctx.node.id, k, v),
      scenario: () => X.scn,
      view: () => X.view,
      html: $('xrHtml'),
      useHtml: on => { $('xrSvg').style.display = on ? 'none' : ''; $('xrHtml').hidden = !on; const tp = document.querySelector('.xr-pan-tip'); if (tp) tp.style.display = on ? 'none' : ''; },
      part: () => X.part,
      setPart: k => setPart(k),
      speed: () => X.speed
    };
    return ctx;
  }

  /* ---------- шапка, управление, бок ---------- */
  function renderCrumbs() {
    const parts = [`<button type="button" class="linkish" data-close>Площадка</button>`].concat(X.stack.map((id, i) => {
      const n = nodeOf(id), last = i === X.stack.length - 1;
      if (last && X.part && partsOf() && partsOf()[X.part]) return `<button type="button" class="linkish" data-xpart="">${esc(nm(n))}</button><span aria-hidden="true">›</span><h2 id="xrTitle">${esc(partsOf()[X.part].name)} <small>как устроен</small></h2>`;
      return last ? `<h2 id="xrTitle">${esc(nm(n))} <small>изнутри</small></h2>` : `<button type="button" class="linkish" data-xgo="${id}">${esc(nm(n))}</button>`;
    }));
    $('xrCrumbs').innerHTML = parts.join('<span aria-hidden="true">›</span>');
  }
  function renderLive() {
    const n = nodeOf(X.id), r = (resAll() || { nodes: {} }).nodes[X.id] || {};
    let chips = X.def.live ? X.def.live(n, r, resAll()) : null;
    if (!chips) {
      chips = [['Поток', SD.fmt.num(r.rps || 0) + '/с', '']];
      if (r.util != null && !(SD.TYPES[n.type].managed && r.util < 0.01)) chips.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      if (r.count > 1 || n.props.count > 1) chips.push(['Экземпляров', String(r.count || n.props.count), '']);
    }
    $('xrLive').innerHTML = `<span class="xr-live-l">как на площадке:</span>` + chips.map(([l, v, c]) => `<span class="xr-chip ${c || ''}"><small>${esc(l)}</small><b>${esc(v)}</b></span>`).join('');
  }
  function renderCtl() {
    const d = X.def;
    let h = '';
    if (d.views) h += `<div class="xr-grp xr-views"><b>Что показать</b><div class="seg">${d.views.map(v => `<button type="button" data-xview="${v.id}" aria-selected="${v.id === X.view}">${esc(v.name)}</button>`).join('')}</div></div>`;
    const sl = scnList();
    if (sl.length) h += `<div class="xr-grp"><b>${X.view && d.views && d.views.find(v => v.id === X.view).scnLabel || 'Ситуация'}</b><div class="seg" id="xrScn">${sl.map(s => `<button type="button" data-xscn="${s.id}" aria-selected="${s.id === X.scn}" title="${esc(s.note || '')}">${esc(s.name)}</button>`).join('')}</div></div>`;
    h += `<div class="xr-grp"><b>Скорость</b><div class="seg">${[[0.25, '×¼'], [0.5, '×½'], [1, '×1']].map(([v, t]) => `<button type="button" data-xspd="${v}" aria-selected="${v === X.speed}">${t}</button>`).join('')}<button type="button" data-xact="pause">Пауза</button></div></div>`;
    $('xrCtl').innerHTML = h;
  }
  function propDefs() {
    const n = nodeOf(X.id), all = SD.TYPES[n.type].props || [], L = A().level;
    return (X.def.props || []).map(k => all.find(p => p.key === k)).filter(d => d && !(d.feature && !(L.sandbox || (L.features || []).includes(d.feature))) && !(d.showIf && !d.showIf(n)));
  }
  function renderProps() {
    const n = nodeOf(X.id), defs = propDefs();
    if (!defs.length) { $('xrProps').innerHTML = ''; return; }
    $('xrProps').innerHTML = `<h3 class="xr-h">Настройки этого узла</h3><p class="xr-note">Те же, что в инспекторе. Поменяй — изменится и площадка.</p>` + defs.map(d => {
      const v = n.props[d.key], id = 'xp_' + d.key;
      let c = '';
      if (d.type === 'select') c = `<select id="${id}" data-xp="${d.key}">${d.options.map(([k, t]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      else if (d.type === 'toggle') c = `<input type="checkbox" id="${id}" data-xp="${d.key}" ${v ? 'checked' : ''}>`;
      else if (d.type === 'range') c = `<input type="range" id="${id}" data-xp="${d.key}" min="${d.min}" max="${d.max}" value="${v}"><output>${v}</output>`;
      else if (d.type === 'multi') c = `<div class="xr-multi" id="${id}">${d.options.map(([k, t]) => `<label><input type="checkbox" data-xp="${d.key}" data-xmulti="${k}" ${(v || []).includes(k) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div>`;
      else return '';
      return `<div class="xr-prop ${d.type}"><label for="${id}">${esc(d.label)}</label>${c}<small class="xr-pm" data-xpm="${d.key}"></small></div>`;
    }).join('');
    renderPropsVals();
  }
  function renderPropsVals() {
    const n = nodeOf(X.id); if (!n) return;
    propDefs().forEach(d => {
      const el = document.querySelector(`#xrProps [data-xp="${d.key}"]`), mm = document.querySelector(`#xrProps [data-xpm="${d.key}"]`);
      const v = n.props[d.key];
      if (d.type === 'multi') { document.querySelectorAll(`#xrProps [data-xp="${d.key}"]`).forEach(cb => { cb.checked = (v || []).includes(cb.dataset.xmulti); }); }
      else if (el && document.activeElement !== el) { if (d.type === 'toggle') el.checked = !!v; else el.value = v; const o = el.parentElement.querySelector('output'); if (o) o.textContent = v; }
      if (mm) { const s = SD.optSimple ? SD.optSimple(n.type, d.key, v) : null; mm.textContent = s || (d.type === 'toggle' ? (v ? 'включено' : 'выключено') : ''); }
    });
  }
  function renderTries() {
    const d = X.def, dn = X.done[nodeOf(X.id).type] || [];
    $('xrTries').innerHTML = (d.tries || []).map(t => `<li class="${dn.includes(t.id) ? 'ok' : ''}"><span class="st">${dn.includes(t.id) ? '✓' : '·'}</span>${esc(t.text)}</li>`).join('');
    $('xrTries').previousElementSibling.hidden = !(d.tries || []).length;
  }
  function doneTry(tid) {
    const k = nodeOf(X.id).type; X.done[k] = X.done[k] || [];
    if (X.done[k].includes(tid)) return;
    X.done[k].push(tid); saveDone(); renderTries();
    const t = (X.def.tries || []).find(x => x.id === tid);
    if (t && SD.app) SD.app.toast('Получилось: ' + t.text);
  }
  function renderParts() {
    const ps = partsOf(), hint = $('xrHint');
    if (!ps) { $('xrParts').innerHTML = ''; hint.hidden = true; return; }
    hint.hidden = false;
    hint.textContent = X.part ? 'Ты внутри блока. Esc или крошка вверху — назад ко всему узлу.' : X.def.html ? 'Как он устроен внутри — блоки «Из чего состоит» справа.' : 'Нажми на любой блок на картинке — провалишься в него: что это, зачем и как он работает.';
    $('xrParts').innerHTML = `<h3 class="xr-h">Из чего состоит — нажми, чтобы разобрать</h3><div class="xr-parts">${Object.entries(ps).map(([k, p]) => `<button type="button" class="chip-btn ${X.part === k ? 'on' : ''}" data-xpart="${k}">${esc(p.name)}</button>`).join('')}</div>`;
  }
  function renderPart() {
    const ps = partsOf(), p = X.part && ps ? ps[X.part] : null, box = $('xrPart');
    if (!p) { box.innerHTML = ''; return; }
    const n = nodeOf(X.id), defs = SD.TYPES[n.type].props || [];
    const knobs = (p.knobs || []).map(k => defs.find(d => d.key === k)).filter(Boolean);
    let h = `<div class="xr-partbox"><div class="xr-ph"><span class="eyebrow">Блок</span><b>${esc(p.name)}</b><button type="button" class="chg-x" data-xpart="" aria-label="Закрыть разбор блока">×</button></div>`;
    if (p.an || p.pl) h += `<div class="simple sm">${p.an ? `<span class="an">${p.an}</span>` : ''}${p.pl ? `<span class="pl">${p.pl}</span>` : ''}</div>`;
    if (p.how && p.how.length) h += `<h4>Как работает</h4><ol class="gd-steps">${p.how.map(x => `<li>${x}</li>`).join('')}</ol>`;
    if (p.watch) h += `<h4>Что смотреть на картинке</h4><p>${p.watch}</p>`;
    if (knobs.length) h += `<h4>Какие настройки на него влияют</h4><ul class="xr-knobs">${knobs.map(d => { const v = n.props[d.key], m = SD.optSimple ? SD.optSimple(n.type, d.key, v) : null; return `<li><b>${esc(d.label)}</b>: ${esc(SD.valueLabel(d, v))}${m ? ` — ${esc(m)}` : ''}</li>`; }).join('')}</ul>`;
    if (p.real) h += `<h4>В жизни</h4><p>${p.real}</p>`;
    box.innerHTML = h + '</div>';
  }
  function setPart(k) {
    const ps = partsOf();
    X.part = k && ps && ps[k] ? k : null;
    renderCrumbs(); renderParts(); renderPart();
    if (X.sc && X.sc.focus) X.sc.focus(X.part);
    if (X.part) X.ctx.log(`<b>Разбираем блок «${esc(ps[X.part].name)}».</b>`);
    side();
    const sd = document.querySelector('#xrModal .xr-side'); if (sd && X.part) sd.scrollTop = 0;
  }
  function renderLegend() { const lg = typeof X.def.legend === 'function' ? X.def.legend(X.view) : X.def.legend; $('xrLegend').innerHTML = (lg || []).map(([c, t]) => `<li><i class="xr-sw ${c}"></i>${esc(t)}</li>`).join(''); }
  function renderNb() {
    const n = nodeOf(X.id), g = A().graph;
    const ins = g.edges.filter(e => e.to === n.id).map(e => nodeOf(e.from)).filter(k => k && has(k.type));
    const outs = g.edges.filter(e => e.from === n.id).map(e => nodeOf(e.to)).filter(k => k && has(k.type));
    let h = SD.archLens ? SD.archLens.nodeBlock(n.id, 'node', true) : '';
    if (ins.length || outs.length) h += `<h3 class="xr-h">Провалиться в соседа</h3><div class="xr-nbs">${ins.map(k => `<button type="button" class="btn ghost" data-xgo="${k.id}">← ${esc(nm(k))}</button>`).join('')}${outs.map(k => `<button type="button" class="btn ghost" data-xgo="${k.id}">${esc(nm(k))} →</button>`).join('')}</div>`;
    if ((n.type === 'app' || n.type === 'worker') && SD.innerUI) h += `<button type="button" class="dive-cta" data-xact="inner">${SD.icon('app')}<span><b>Собрать свои слои: роуты, сервисы, репозитории</b><small>Редактор компонентов: добавляй и связывай, смотри трассу запроса и код каждого файла</small></span></button>`;
    if (X.def.dive && SD.DIVES[X.def.dive]) h += `<button type="button" class="dive-cta" data-xact="dive">${SD.icon(n.type)}<span><b>Пошаговый разбор</b><small>${esc(SD.DIVES[X.def.dive].title)}</small></span></button>`;
    $('xrNb').innerHTML = h;
  }
  function side() {
    if (!X.sc) return;
    if (X.sc.now) $('xrNow').innerHTML = X.sc.now() || '';
    if (X.sc.stats) $('xrStats').innerHTML = (X.sc.stats() || []).map(([l, v, c, s]) => `<div><small>${esc(l)}</small><b class="${c || ''}">${esc(v)}</b>${s ? `<span>${esc(s)}</span>` : ''}</div>`).join('');
    $('xrLog').innerHTML = X.log.map(l => `<li class="${l.cls}">${l.txt}</li>`).join('');
  }

  /* ---------- события ---------- */
  function onClick(e) {
    const m = $('xrModal');
    if (e.target === m || e.target.closest('[data-close]')) { close(); return; }
    const pt = e.target.closest('[data-xpart]'); if (pt) { setPart(pt.dataset.xpart || null); return; }
    const g = e.target.closest('[data-xgo]'); if (g && g.dataset.xgo) { go(g.dataset.xgo); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.xscn) {
      X.scn = b.dataset.xscn; m.querySelectorAll('[data-xscn]').forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
      const s = scnList().find(x => x.id === X.scn);
      X.ctx.log(`<b>Ситуация: ${esc(s.name)}.</b> ${esc(s.note || '')}`);
      if (X.sc.scenario) X.sc.scenario(X.scn, false);
      side();
    }
    if (b.dataset.xview) {
      X.view = b.dataset.xview; X.scn = scnList()[0] ? scnList()[0].id : null; X.part = null;
      renderCtl(); renderLegend(); renderCrumbs(); renderParts(); renderPart();
      if (X.sc.view) X.sc.view(X.view);
      if (X.scn && X.sc.scenario) X.sc.scenario(X.scn, true);
      const v = X.def.views.find(x => x.id === X.view);
      X.ctx.log(`<b>Вид: ${esc(v.name)}.</b>`);
      side(); return;
    }
    if (b.dataset.xspd) { X.speed = +b.dataset.xspd; m.querySelectorAll('[data-xspd]').forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false')); }
    if (b.dataset.xact === 'pause') { X.run = !X.run; b.textContent = X.run ? 'Пауза' : 'Пуск'; X.last = performance.now(); }
    if (b.dataset.xact === 'inner') { const id = X.id; close(); SD.innerUI.open(id); }
    if (b.dataset.xact === 'dive') SD.player.open(X.def.dive);
  }
  function onChange(e) {
    const t = e.target, k = t.dataset.xp; if (!k) return;
    const n = nodeOf(X.id), d = propDefs().find(x => x.key === k); if (!d) return;
    const prev = n.props[k];
    let v = d.type === 'toggle' ? t.checked : d.type === 'range' ? +t.value : t.value;
    if (d.type === 'multi') { const cur = (prev || []).slice(), m = t.dataset.xmulti; v = t.checked ? [...new Set(cur.concat(m))] : cur.filter(x => x !== m); }
    if (d.type === 'select') { const o = d.options.find(x => String(x[0]) === String(v)); if (o) v = o[0]; }
    SD.app.setProp(n.id, k, v);
    const watch = X.sc && X.sc.onProp ? X.sc.onProp(k, prev, v) : null;
    X.ctx.log(`<b>Ты поменял «${esc(d.label)}»:</b> ${esc(SD.valueLabel(d, prev))} → ${esc(SD.valueLabel(d, v))}.${watch ? ' ' + watch : ''}`, 'chg');
    renderProps(); side();
  }

  SD.xray = { mount, open, go, close, has, need };
})();
