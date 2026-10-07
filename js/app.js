/* Приложение: состояние, уровни, пересчёт, обработчики интерфейса. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KEY = 'amp-stroyploshchadka-v1';

  const A = {
    level: null, graph: null, sel: null, mul: 1, down: {}, running: true,
    res: null, res1: null, chaos: [], goals: [], advice: [], anLive: null,
    progress: {}, quiz: {}, quizPick: {}, hintsShown: {}, diagPick: {}, history: [], backlog: 0, tab: 'task'
  };

  /* ---------- хранение прогресса ---------- */
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      A.progress = s.progress || {}; A.quiz = s.quiz || {}; A.quizPick = s.quizPick || {}; A.hintsShown = s.hintsShown || {}; A.diagPick = s.diagPick || {}; Object.assign(SD.DIAG, s.diag || {});
      return s;
    } catch (e) { return {}; }
  }
  function save(extra) {
    try {
      const prev = JSON.parse(localStorage.getItem(KEY) || '{}');
      localStorage.setItem(KEY, JSON.stringify(Object.assign(prev, { progress: A.progress, quiz: A.quiz, quizPick: A.quizPick, hintsShown: A.hintsShown, diag: SD.DIAG, diagPick: A.diagPick }, extra || {})));
    } catch (e) { /* хранилище недоступно — работаем без него */ }
  }

  /* ---------- граф из описания уровня ---------- */
  function graphFrom(level, spec) {
    const nodes = [], edges = [];
    const add = ([id, type, x, y, props, label]) => {
      if (nodes.some(n => n.id === id)) return;
      nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props ? JSON.parse(JSON.stringify(props)) : {}), label: label || (type === 'external' && level.ext ? level.ext.name : undefined) });
    };
    (level.preset || []).forEach(add);
    if (spec) {
      spec.nodes.forEach(add);
      spec.edges.forEach(([a, b, p], i) => edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) }));
    }
    return { nodes, edges };
  }

  function loadLevel(level, spec) {
    A.level = level;
    A.graph = graphFrom(level, spec === undefined ? (level.start || null) : spec);
    if (SD.inner) A.graph.nodes.forEach(n => SD.inner.syncFlags(n, A.graph));
    A.down = {}; A.backlog = 0; A.history = []; A.sel = null; A.feed = []; A.pending = null;
    SD.editor.setGraph(A.graph);
    renderPalette(); renderHeader();
    recompute(true);
    requestAnimationFrame(() => SD.editor.fit());
    save({ last: level.id });
    $('healBtn').hidden = true;
    setTab('task');
    SD.mentor.onLevel(level);
    /* маршрут и постепенное раскрытие инструментов (js/ux.js) */
    if (SD.ux && SD.ux.onLevel) SD.ux.onLevel(level);
  }

  /* ---------- пересчёт ---------- */
  let pending = null;
  function schedule(full) {
    if (pending) { pending.full = pending.full || full; return; }
    pending = { full };
    requestAnimationFrame(() => { const p = pending; pending = null; recompute(p.full); });
  }
  function recompute(full) {
    const L = A.level, g = A.graph;
    const clean = A.mul === 1 && !Object.keys(A.down).length;
    const before = full && A.pending ? { res: A.res1, goals: A.goals } : null;
    A.res = SD.sim.run(L, g, { mul: A.mul, down: A.down });
    if (full || !A.res1) {
      A.res1 = clean ? A.res : SD.sim.run(L, g, { mul: 1 });
      A.chaos = SD.sim.chaos(L, g);
      const an1 = SD.sim.analyze(L, g, A.res1);
      A.goals = L.sandbox ? [] : SD.evalGoals(L, g, A.res1, A.chaos, an1);
      if (!L.sandbox && A.goals.length && A.goals.every(x => x.ok)) award();
      if (L.interview && SD.interview) SD.interview.onRecompute(A);
    }
    if (before && SD.explain) { SD.explain.onChange(A.pending, before); A.pending = null; }
    if (before && SD.editor.markDeltas) SD.editor.markDeltas(before.res, A.res1);
    A.anLive = SD.sim.analyze(L, g, A.res);
    A.advice = SD.sim.advise(L, g, A.res, A.anLive);
    SD.editor.render(A.res);
    SD.panels.metrics(A);
    renderPanes();
    if (SD.mentor) SD.mentor.onUpdate();
  }
  function award() {
    const L = A.level;
    if (SD.bridge) SD.bridge.won(L, A);
    if (L.interview) { if (!A.intWon || A.intWon !== L.id) { A.intWon = L.id; toast('Схема выполняет все цели симулятора. Возвращайся к этапам собеседования.'); if (SD.mentor) SD.mentor.onEvent('win', { stars: 3 }); } return; }
    const quizAll = L.decisions.every((_, i) => (A.quiz[L.id] || {})[i] === 'right');
    const cheap = L.stretch && A.res1.cost <= L.stretch.cost;
    const st = 1 + (quizAll ? 1 : 0) + (cheap ? 1 : 0);
    const prev = (A.progress[L.id] || {}).stars || 0;
    if (st > prev) {
      A.progress[L.id] = { stars: st };
      save();
      renderHeader();
      if (SD.ux && SD.ux.onWin) SD.ux.onWin(L);
      if (!prev) { toast(`Уровень «${L.title}» пройден. Звёзд: ${st} из 3.`); if (SD.mentor) SD.mentor.onEvent('win', { stars: st }); }
    }
  }
  /* «Следующий уровень»: уровень на маршруте «Моего пути» — дальше по маршруту, иначе по треку, как раньше */
  function nextStep() {
    const r = SD.ux && SD.ux.routeNext ? SD.ux.routeNext(A.level) : null;
    if (r) { r.open(); return; }
    const nx = SD.nextLevel(A.level); if (nx) loadLevel(nx);
  }
  function nextLabel() {
    const b = $('paneTask').querySelector('[data-act="next"]'); if (!b || b.dataset.route) return;
    const r = SD.ux && SD.ux.routeNext ? SD.ux.routeNext(A.level) : null; if (!r) return;
    b.dataset.route = '1'; b.textContent = 'Дальше по маршруту: ' + r.title + ' →';
    const nx = SD.nextLevel(A.level);
    if (nx && nx.id !== r.key) { const t = document.createElement('button'); t.type = 'button'; t.className = 'btn ghost'; t.setAttribute('data-act', 'tracknext'); t.textContent = 'Следующий в треке: ' + nx.title; b.after(t); }
  }
  function renderPanes() {
    if (A.tab === 'task') { SD.panels.task(A); nextLabel(); }
    if (A.tab === 'node') SD.inspector.render(A);
    if (A.tab === 'stats') SD.panels.stats(A);
    if (A.tab === 'live') SD.explain.render();
    const bad = A.goals && A.goals.some(x => !x.ok);
    $('tabTask').innerHTML = 'Задание' + (bad && A.advice.some(a => a.sev === 'bad') ? '<span class="dot"></span>' : '');
  }

  /* ---------- шапка и палитра ---------- */
  function renderHeader() {
    const L = A.level, i = SD.LEVELS.indexOf(L);
    $('lvlTag').textContent = L.free ? 'СВОБОДНО' : L.daily ? 'СОБЫТИЕ ДНЯ' : L.sandbox ? 'ПЕСОЧНИЦА' : L.interview ? 'СОБЕСЕДОВАНИЕ' : L.innerLvl ? 'ВНУТРИ СЕРВИСА' : L.knobLvl ? 'НАСТРОЙКА' : L.saasLvl ? 'SAAS' : L.cloudLvl ? 'ОБЛАКО' : L.dataLvl ? 'ДАННЫЕ' : L.opsLvl ? 'ЭКСПЛУАТАЦИЯ' : L.archLvl ? 'АРХИТЕКТУРА' : L.practice ? 'ПРАКТИКУМ' : L.fix ? 'ИНЦИДЕНТ' : `УР. ${i + 1}/${SD.LEVELS.length}`;
    $('lvlName').textContent = L.title;
    const st = (A.progress[L.id] || {}).stars || 0;
    $('lvlStars').textContent = L.sandbox || L.interview ? '' : SD.panels.stars(st);
    $('navSandbox').setAttribute('aria-pressed', L.sandbox ? 'true' : 'false');
    $('navLevels').setAttribute('aria-pressed', L.sandbox ? 'false' : 'true');
  }
  /* карта уровней + один следующий шаг маршрута сверху и подсветка этого шага на карте (js/path.js) */
  function openMap() {
    SD.panels.map(A);
    const n = SD.path && SD.path.next ? SD.path.next() : null, body = $('mapBody');
    if (n && n.item && body) {
      const d = document.createElement('div'); d.className = 'hub-next map-next';
      d.innerHTML = `<span>Дальше по маршруту: <b>${esc(n.item.title)}</b> <small>· ${esc(n.why)}</small></span><button type="button" class="btn primary" data-mapnext="1">Перейти</button><button type="button" class="btn ghost" data-mappath="1">Мой путь</button>`;
      body.insertBefore(d, body.firstChild);
      const b = body.querySelector(`[data-level="${n.item.key}"]`); if (b) b.classList.add('route-next');
    }
    openModal('mapModal');
  }
  function firstLevelWith(type) { const i = SD.LEVELS.findIndex(l => (l.allow || []).includes(type)); return i < 0 ? null : i + 1; }
  function renderPalette() {
    const allow = new Set(A.level.allow || []);
    let h = '';
    if (SD.SERVICE_PRESETS) {
      const ps = SD.SERVICE_PRESETS.filter(p => allow.has(p.type));
      if (ps.length) {
        const openPre = A.level.archLvl || A.level.opsLvl || A.level.sandbox || (SD.ux && SD.ux.palOpen('presets'));
        h += `<div class="grp p-presets"><button type="button" class="p-more preset-h" data-pmore="presets" aria-expanded="${!!openPre}">Готовые сервисы · ${ps.length} <span aria-hidden="true">${openPre ? '▾' : '▸'}</span></button><div class="p-list" data-plist="presets" ${openPre ? '' : 'hidden'}>`;
        ps.forEach(p => { h += `<button type="button" class="part preset" data-type="${p.type}" data-preset="${p.id}" title="${esc(p.label)}: ${esc(p.short)}">${SD.icon(p.type)}<span class="t"><b>${esc(p.label)}</b><small>${esc(p.short)}</small></span></button>`; });
        h += `</div></div>`;
      }
    }
    const lockedG = [], toolsG = []; let lockedN = 0, toolsN = 0;
    const toolsOpen = A.level.opsLvl || A.level.sandbox || A.graph.nodes.some(n => SD.TYPES[n.type] && SD.TYPES[n.type].ops) || (SD.ux && SD.ux.palOpen('tools'));
    SD.GROUPS.forEach(g => {
      const types = Object.entries(SD.TYPES).filter(([, t]) => t.group === g.id);
      if (!types.length) return;
      const isOk = ([k, t]) => allow.has(k) || !!t.ops, part = ([k, t]) => {
        const ok = isOk([k, t]);
        const lv = firstLevelWith(k);
        return `<button type="button" class="part ${ok ? '' : 'locked'}" data-type="${k}" ${ok ? `title="${esc(t.name)}: ${esc(t.short)}"` : `title="${lv ? 'Откроется на уровне ' + lv : 'Доступно в песочнице'}" aria-disabled="true"`}>${SD.icon(k)}<span class="t"><b>${esc(t.name)}</b><small>${ok ? esc(t.short) : lv ? 'с уровня ' + lv : 'в песочнице'}</small></span></button>`;
      };
      const okT = types.filter(isOk), lockT = types.filter(x => !isOk(x));
      if (types.every(([, t]) => t.ops)) { toolsG.push(`<div class="grp"><h4>${esc(g.label)}</h4>${types.map(part).join('')}</div>`); toolsN += types.length; return; }
      if (!okT.length) { lockedG.push(`<div class="grp"><h4>${esc(g.label)}</h4>${lockT.map(part).join('')}</div>`); lockedN += lockT.length; return; }
      h += `<div class="grp"><h4>${esc(g.label)}</h4>`;
      okT.forEach(x => { h += part(x); });
      if (lockT.length) { const op = SD.ux && SD.ux.palOpen(g.id); h += `<button type="button" class="p-more" data-pmore="${g.id}" aria-expanded="${!!op}">${okT.length ? 'ещё' : 'закрыто'} ${lockT.length} — откроются дальше <span aria-hidden="true">${op ? '▾' : '▸'}</span></button><div class="p-list" data-plist="${g.id}" ${op ? '' : 'hidden'}>${lockT.map(part).join('')}</div>`; }
      h += `</div>`;
    });
    if (toolsG.length) h += `<div class="grp p-tools"><button type="button" class="p-more preset-h" data-pmore="tools" aria-expanded="${!!toolsOpen}" title="Мониторинг, логи, трейсы, Kubernetes: ставь, когда нужно увидеть, что происходит внутри">Инструменты эксплуатации · ${toolsN} <span aria-hidden="true">${toolsOpen ? '▾' : '▸'}</span></button><div class="p-list" data-plist="tools" ${toolsOpen ? '' : 'hidden'}>${toolsG.join('')}</div></div>`;
    if (lockedG.length) { const op = SD.ux && SD.ux.palOpen('locked'); h += `<div class="grp p-locked"><button type="button" class="p-more" data-pmore="locked" aria-expanded="${!!op}">Ещё ${lockedN} деталей откроются дальше <span aria-hidden="true">${op ? '▾' : '▸'}</span></button><div class="p-list" data-plist="locked" ${op ? '' : 'hidden'}>${lockedG.join('')}</div></div>`; }
    h += `<p class="tip">Перетащи деталь на площадку или нажми на неё. Связь — от кружка справа у узла к другому узлу.</p>`;
    $('palette').innerHTML = h;
    const legend = new Set(Object.keys(A.level.traffic).filter(k => A.level.traffic[k] > 0));
    if (A.level.job) legend.add('job');
    $('legend').innerHTML = [...legend].map(k => `<span><i style="background:${SD.kindColor(k)}"></i>${esc(SD.KINDS[k].label)}</span>`).join('') + '<span><i style="background:var(--bad)"></i>отказы</span><button type="button" class="lg-help" id="lgHelp">Как читать схему</button>';
  }

  /* ---------- вкладки ---------- */
  function setTab(t) {
    A.tab = t;
    if (t === 'live') $('tabLive').textContent = 'Разбор';
    [['task', 'tabTask', 'paneTask'], ['node', 'tabNode', 'paneNode'], ['live', 'tabLive', 'paneLive'], ['stats', 'tabStats', 'paneStats']].forEach(([k, b, p]) => {
      $(b).setAttribute('aria-selected', k === t ? 'true' : 'false');
      $(p).hidden = k !== t;
    });
    renderPanes();
  }

  /* ---------- служебное ---------- */
  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3600);
  }
  function confirmBox(text, okLabel, fn) {
    const wrap = document.createElement('div');
    wrap.className = 'confirm';
    wrap.innerHTML = `<div class="box" role="dialog" aria-modal="true"><p>${esc(text)}</p><div class="row"><button type="button" class="btn ghost" data-c="no">Отмена</button><button type="button" class="btn primary" data-c="yes">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-c="yes"]').focus();
    wrap.addEventListener('click', e => {
      const c = e.target.closest('[data-c]');
      if (!c && e.target !== wrap) return;
      wrap.remove();
      if (c && c.getAttribute('data-c') === 'yes') fn();
    });
  }
  function openModal(id) { $(id).hidden = false; const f = $(id).querySelector('button'); if (f) f.focus(); }
  function closeModals() { if (!$('diveModal').hidden) { SD.player.close(); return; } if ($('xrModal') && !$('xrModal').hidden) { SD.xray.close(); return; } if ($('labModal') && !$('labModal').hidden) { $('labModal').querySelector('[data-close]').click(); return; } ['guideModal', 'prModal', 'mapModal', 'libModal', 'patModal', 'hubModal', 'intModal', 'innerModal'].forEach(id => { if ($(id)) $(id).hidden = true; }); }
  function openDive(id) { if (!SD.player.open(id)) toast('Этот разбор появится в следующей версии.'); else if (SD.mentor) SD.mentor.onEvent('dive', id); }

  function chaosTargets() {
    return A.graph.nodes.filter(n => {
      const ok = SD.sim.CHAOS_TYPES.has(n.type) || (SD.AI_TYPES_SET && SD.AI_TYPES_SET.has(n.type) && !['router', 'semcache'].includes(n.type));
      if (!ok) return false;
      if (n.type === 'queue' && SD.ENGINES[n.props.engine].managed) return false;
      if (n.type === 'llm' && n.props.hosting === 'api' && A.down[n.id]) return false;
      const r = A.res && A.res.nodes[n.id];
      return r && r.alive > 0 && r.rps > 0;
    });
  }
  function kill(id) {
    A.down[id] = (A.down[id] || 0) + 1;
    const n = A.graph.nodes.find(x => x.id === id);
    $('healBtn').hidden = false;
    recompute(false);
    toast(`Упал экземпляр «${n.label || SD.TYPES[n.type].name}». Смотри, что стало с успешностью.`);
    if (SD.mentor) SD.mentor.onEvent('chaos', { name: n.label || SD.TYPES[n.type].name });
  }

  /* ---------- обработчики ---------- */
  function bind() {
    SD.editor.init($('canvas'), {
      onChange: (why, detail) => { if (why !== 'move') { A.pending = Object.assign({ kind: why }, detail); A.backlog = 0; schedule(true); } },
      onSelect: sel => { A.sel = sel; if (sel) setTab('node'); else renderPanes(); if (SD.mentor) SD.mentor.onEvent('select'); },
      onOpenEdge: id => { const e = A.graph.edges.find(x => x.id === id); if (!e) return; const a = A.graph.nodes.find(x => x.id === e.from), b = A.graph.nodes.find(x => x.id === e.to); if (a && b && SD.edgeKind(a, b).resil && SD.labs) { SD.resilCtx = { edgeId: id }; SD.labs.open('resil'); } else setTab('node'); },
      onOpen: id => { const n = A.graph.nodes.find(x => x.id === id); if (n && SD.xray && SD.xray.has(n.type)) SD.xray.open(id); else if (n && (n.type === 'app' || n.type === 'worker') && SD.innerUI) SD.innerUI.open(id); else setTab('node'); },
      onToast: toast
    });
    SD.editor.bindPalette($('palette'));
    SD.player.bind();
    SD.mentor.init(A, {
      revealHint: () => { A.hintsShown[A.level.id] = (A.hintsShown[A.level.id] || 0) + 1; save(); renderPanes(); },
      openDive, solution: () => $('solBtn').click(), heal: () => $('healBtn').click(),
      next: nextStep
    });

    $('tabTask').addEventListener('click', () => setTab('task'));
    $('tabNode').addEventListener('click', () => setTab('node'));
    $('tabStats').addEventListener('click', () => setTab('stats'));
    $('tabLive').addEventListener('click', () => setTab('live'));
    SD.explain.init(A, { notify: (card, now) => {
      if (now || A.tab === 'live') { setTab('live'); return; }
      $('tabLive').innerHTML = 'Разбор<span class="dot" style="background:var(--accent)"></span>';
      if (SD.mentor) SD.mentor.liveHint(card);
    } });

    $('runBtn').addEventListener('click', () => {
      A.running = !A.running;
      SD.editor.setRunning(A.running);
      $('runBtn').textContent = A.running ? '■ Пауза' : '▶ Пуск';
    });
    /* волна нагрузки: ×1 → ×3 → ×1 за 13 секунд */
    let wave = null;
    const fmtMul = m => '×' + m.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
    const stopWave = () => { if (!wave) return; clearInterval(wave); wave = null; $('waveBtn').textContent = 'Волна ↗'; $('waveCap').hidden = true; };
    $('canvasWrap').addEventListener('click', e => {
      if (e.target.closest('#lgHelp')) { $('lgPanel').hidden = !$('lgPanel').hidden; return; }
      if (e.target.closest('#lgClose')) $('lgPanel').hidden = true;
    });
    $('waveBtn').addEventListener('click', () => {
      if (wave) { stopWave(); return; }
      if (!A.running) $('runBtn').click();
      const t0 = performance.now(), base = Math.min(A.mul, 1.5);
      const hasAuto = A.graph.nodes.some(n => n.props.autoscale);
      toast(hasAuto ? 'Волна: нагрузка вырастет до ×3 и вернётся. Смотри, как автомасштабирование добавляет экземпляры.' : 'Волна: нагрузка вырастет до ×3 и вернётся. Включи автомасштабирование у сервиса, чтобы он сам добавлял экземпляры.');
      $('waveBtn').textContent = '■ Стоп';
      wave = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        let m;
        if (t < 5) m = base + (3 - base) * (t / 5);
        else if (t < 8) m = 3;
        else if (t < 13) m = 3 - (3 - base) * ((t - 8) / 5);
        else m = base;
        A.mul = m; $('loadRange').value = m; $('loadOut').textContent = fmtMul(m);
        recompute(false);
        const r = A.res, phase = t < 5 ? 'нагрузка растёт' : t < 8 ? 'пик' : 'спадает';
        $('waveCap').hidden = false;
        $('waveCap').innerHTML = `Волна: <b>${fmtMul(m)}</b> · ${phase}${r ? ` · успешно <b>${SD.fmt.pct(r.total.success)}</b> · ${SD.fmt.ms(r.total.lat)}` : ''}`;
        if (t >= 13) stopWave();
      }, 200);
    });
    $('loadRange').addEventListener('pointerdown', stopWave);
    $('loadRange').addEventListener('input', e => {
      A.mul = +e.target.value;
      $('loadOut').textContent = '×' + A.mul.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
      schedule(false);
    });
    $('checkBtn').addEventListener('click', () => {
      recompute(true); setTab('task');
      if (SD.mentor) SD.mentor.onEvent('check');
      if (A.level.sandbox) { toast('В песочнице нет целей: смотри метрики и советы прораба.'); return; }
      const bad = A.goals.filter(g => !g.ok);
      if (bad.length && SD.bridge) SD.bridge.miss(A.level);
      toast(bad.length ? `Не выполнено целей: ${bad.length} из ${A.goals.length}. Первая: ${bad[0].text.toLowerCase()}.` : 'Все цели выполнены.');
    });
    $('chaosBtn').addEventListener('click', () => {
      const t = chaosTargets();
      if (!t.length) { toast('Ронять нечего: нет узлов, которые могут упасть.'); return; }
      kill(t[Math.floor(Math.random() * t.length)].id);
    });
    $('healBtn').addEventListener('click', () => { A.down = {}; $('healBtn').hidden = true; recompute(false); toast('Все узлы снова в строю.'); if (SD.mentor) SD.mentor.onEvent('heal'); });
    $('navTour').addEventListener('click', () => SD.mentor.tour());
    $('solBtn').addEventListener('click', () => {
      const L = A.level;
      if (!L.solution) { toast(L.interview ? 'На собеседовании эталона нет: он откроется в разборе после завершения.' : 'В песочнице эталона нет.'); return; }
      confirmBox('Заменить твою схему эталонным решением? Текущая схема пропадёт.', 'Показать эталон', () => { if (SD.bridge) SD.bridge.peek(L); loadLevel(L, L.solution); toast(L.solution.note); });
    });
    $('clearBtn').addEventListener('click', () => confirmBox('Вернуть уровень к началу? Твоя схема пропадёт.', 'Начать заново', () => loadLevel(A.level)));
    $('zoomIn').addEventListener('click', SD.editor.zoomIn);
    $('zoomOut').addEventListener('click', SD.editor.zoomOut);
    $('zoomFit').addEventListener('click', SD.editor.fit);

    $('levelBtn').addEventListener('click', openMap);
    $('navLevels').addEventListener('click', openMap);
    $('navSandbox').addEventListener('click', () => loadLevel(SD.SANDBOX, null));
    $('navLib').addEventListener('click', () => { SD.panels.library(A); openModal('libModal'); });
    SD.patterns.mount();
    $('navPat').addEventListener('click', () => SD.patterns.open());
    SD.labs.mount(); SD.hub.mount();
    if (SD.innerUI) SD.innerUI.mount();
    if (SD.xray) SD.xray.mount();
    if (SD.archLens) SD.archLens.mount();
    if (SD.opsUI) SD.opsUI.mount();
    if (SD.ux) SD.ux.mount();
    if (SD.learn) SD.learn.mount();
    if (SD.walk) SD.walk.mount();
    if (SD.cmd) SD.cmd.mount();
    if (SD.daily) SD.daily.mount();
    if (SD.calc) SD.calc.mount();
    if (SD.free) SD.free.mount();
    if (SD.share) SD.share.mount();
    if (SD.path) SD.path.mount();
    if (SD.trace) SD.trace.mount();
    if (SD.landscape) SD.landscape.mount();
    if (SD.principles) SD.principles.mount();
    if (SD.guide) SD.guide.mount();
    $('navHub').addEventListener('click', () => SD.hub.open());
    if (SD.interview) { SD.interview.mount(); $('navInt').hidden = false; $('navInt').addEventListener('click', () => SD.interview.open()); }
    $('themeBtn').addEventListener('click', toggleTheme);

    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) { if (m.id === 'diveModal') SD.player.close(); else m.hidden = true; }
    }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

    $('mapBody').addEventListener('click', e => {
      if (e.target.closest('[data-mapnext]')) { const n = SD.path && SD.path.next ? SD.path.next() : null; $('mapModal').hidden = true; if (n && n.item) n.item.open(); return; }
      if (e.target.closest('[data-mappath]')) { $('mapModal').hidden = true; if (SD.path) SD.path.open(); return; }
      const b = e.target.closest('[data-level]'); if (!b) return;
      const id = b.getAttribute('data-level');
      $('mapModal').hidden = true;
      loadLevel(SD.levelById(id));
    });
    $('libBody').addEventListener('click', e => { const p = e.target.closest('[data-openpat]'); if (p) { $('libModal').hidden = true; SD.patterns.open(); return; } const b = e.target.closest('[data-dive]'); if (b) openDive(b.getAttribute('data-dive')); });

    ['paneTask', 'paneNode', 'paneStats', 'paneLive'].forEach(p => {
      $(p).addEventListener('click', onPaneClick);
      $(p).addEventListener('input', onPaneInput);
      $(p).addEventListener('change', onPaneInput);
    });

    setInterval(timeTick, 1000);
  }

  function onPaneClick(e) {
    const t = e.target.closest('button, [data-dive], [data-sel]');
    if (!t) return;
    if (t.hasAttribute('data-dive')) { openDive(t.getAttribute('data-dive')); return; }
    if (t.hasAttribute('data-pat')) { SD.patterns.open(t.getAttribute('data-pat')); return; }
    if (t.hasAttribute('data-guide') && SD.guide && A.sel && A.sel.type === 'node') { e.preventDefault(); SD.guide.open(A.sel.id, t.getAttribute('data-guide')); return; }
    if (t.hasAttribute('data-eguide') && SD.guide && A.sel && A.sel.type === 'edge') { e.preventDefault(); SD.guide.openEdge(A.sel.id, t.getAttribute('data-eguide')); return; }
    if (t.hasAttribute('data-diag')) {
      const L = A.level, id = t.getAttribute('data-diag');
      A.diagPick[L.id] = id;
      if (id === L.diagnose.answer) { SD.DIAG[L.id] = true; if (SD.mentor) SD.mentor.say('Диагноз верный. Теперь перестрой систему так, чтобы все цели загорелись зелёным. Что изменится в цифрах — смотри во вкладке «Разбор».', { mood: 'happy', auto: 9000 }); }
      save(); recompute(true); return;
    }
    if (t.hasAttribute('data-sel')) { SD.editor.select({ type: 'node', id: t.getAttribute('data-sel') }); return; }
    if (t.hasAttribute('data-sele')) { SD.editor.select({ type: 'edge', id: t.getAttribute('data-sele') }); return; }
    if (t.hasAttribute('data-q')) {
      const L = A.level, qi = +t.getAttribute('data-q'), oi = +t.getAttribute('data-o');
      A.quizPick[L.id] = Object.assign({}, A.quizPick[L.id], { [qi]: oi });
      A.quiz[L.id] = Object.assign({}, A.quiz[L.id], { [qi]: L.decisions[qi].opts[oi].v });
      save();
      if (A.goals.length && A.goals.every(g => g.ok)) award();
      renderPanes();
      return;
    }
    const act = t.getAttribute('data-act');
    if (act === 'hint') { A.hintsShown[A.level.id] = (A.hintsShown[A.level.id] || 0) + 1; save(); renderPanes(); }
    if (act === 'next') nextStep();
    if (act === 'tracknext') { const nx = SD.nextLevel(A.level); if (nx) loadLevel(nx); }
    if (act === 'patcard') SD.patterns.open(A.level.pattern);
    if (act === 'guide' && SD.guide) SD.guide.open(t.getAttribute('data-id'), t.getAttribute('data-key') || null);
    if (act === 'chgclose' && A.lastChange) { A.lastChange.dismissed = true; renderPanes(); }
    if (act === 'chgundo' && A.lastChange) { const lc = A.lastChange; if (lc.kind === 'prop') setProp(lc.id, lc.key, lc.prev); if (lc.kind === 'eprop') setEdgeProp(lc.id, lc.key, lc.prev); toast('Вернул как было — смотри, что изменилось обратно.'); }
    if (act === 'resil' && SD.labs && A.sel && A.sel.type === 'edge') { SD.resilCtx = { edgeId: A.sel.id }; SD.labs.open('resil'); }
    if (act === 'inner' && SD.innerUI) SD.innerUI.open(t.getAttribute('data-id'));
    if (act === 'xray' && SD.xray) SD.xray.open(t.getAttribute('data-id'));
    if (act === 'intback' && SD.interview) SD.interview.back();
    if (act === 'intopen' && SD.interview) SD.interview.open('list');
    if (act === 'kill') kill(t.getAttribute('data-id'));
    if (act === 'heal') { delete A.down[t.getAttribute('data-id')]; if (!Object.keys(A.down).length) $('healBtn').hidden = true; recompute(false); }
    if (act === 'delnode') { SD.editor.select({ type: 'node', id: t.getAttribute('data-id') }); SD.editor.removeSel(); }
    if (act === 'deledge') SD.editor.removeSel();
    if (act === 'explainnode') { const n = A.graph.nodes.find(x => x.id === t.getAttribute('data-id')); if (n) SD.explain.forNode(n); }
    if (act === 'explainedge' && A.sel && A.sel.type === 'edge') { const ed = A.graph.edges.find(x => x.id === A.sel.id); if (ed) SD.explain.forEdge(ed); }
  }

  function onPaneInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-prop') && A.sel && A.sel.type === 'node') {
      const n = A.graph.nodes.find(x => x.id === A.sel.id); if (!n) return;
      const d = SD.TYPES[n.type].props.find(p => p.key === t.getAttribute('data-prop'));
      const prevVal = Array.isArray(n.props[d.key]) ? n.props[d.key].slice() : n.props[d.key];
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (d.type === 'multi') {
        if (e.type === 'input') return;
        const set = new Set(n.props[d.key] || []);
        if (t.checked) set.add(t.getAttribute('data-multi')); else set.delete(t.getAttribute('data-multi'));
        v = d.options.map(o => o[0]).filter(k => set.has(k));
      }
      if (d.type === 'range') v = +v;
      if (d.type === 'select' && d.options.length && typeof d.options[0][0] === 'number') v = +v;
      n.props[d.key] = v;
      if (d.key === 'role' && SD.applyRole) { SD.applyRole(n, v, prevVal); SD.editor.render(A.res); }
      const out = t.parentElement.querySelector('output'); if (out) out.textContent = v;
      if (e.type === 'change' || d.type !== 'range') { A.pending = { kind: 'prop', node: n, key: d.key, value: v, prev: e.type === 'change' && d.type === 'range' ? (A.rangeStart && A.rangeStart.key === d.key ? A.rangeStart.v : prevVal) : prevVal }; A.rangeStart = null; A.backlog = 0; schedule(true); }
      else if (!A.rangeStart || A.rangeStart.key !== d.key) A.rangeStart = { key: d.key, v: prevVal };
      else schedule(false);
      return;
    }
    if (t.hasAttribute('data-eprop') && A.sel && A.sel.type === 'edge') {
      const ed = A.graph.edges.find(x => x.id === A.sel.id); if (!ed) return;
      const k = t.getAttribute('data-eprop');
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'timeout' || k === 'retries') v = +v;
      const prevE = Object.assign(SD.edgeDefaults(), ed.props)[k];
      ed.props = Object.assign(SD.edgeDefaults(), ed.props, { [k]: v });
      const out = t.parentElement.querySelector('output'); if (out) out.textContent = v;
      if (e.type === 'change') { A.pending = { kind: 'eprop', edge: ed, key: k, value: v, prev: A.erangeStart && A.erangeStart.key === k ? A.erangeStart.v : prevE }; A.erangeStart = null; schedule(true); } else { if (!A.erangeStart || A.erangeStart.key !== k) A.erangeStart = { key: k, v: prevE }; schedule(false); }
      return;
    }
    if (t.hasAttribute('data-rename') && A.sel) {
      const n = A.graph.nodes.find(x => x.id === A.sel.id); if (!n) return;
      n.label = t.value.trim() || undefined;
      SD.editor.render(A.res);
      return;
    }
    if (t.hasAttribute('data-sb')) { A.level.traffic[t.getAttribute('data-sb')] = Math.max(0, +t.value || 0); if (e.type === 'change') { renderPalette(); schedule(true); } return; }
    if (t.hasAttribute('data-sbf')) {
      const f = t.getAttribute('data-sbf'), L = A.level;
      if (f === 'global') L.global = t.checked;
      else if (f === 'jobTarget') {
        const presets = { external: { ms: 500, conc: 50, cpu: false, fanout: 0, from: 'write' }, cache: { ms: 40, conc: 50, fanout: 200, cpu: false, from: 'write' }, nosql: { ms: 20, conc: 20, cpu: false, fanout: 0, from: 'write' }, objstore: { ms: 20000, conc: 4, cpu: true, fanout: 0, from: 'upload' }, vectordb: { ms: 3000, conc: 10, cpu: false, fanout: 0, from: 'docs' } };
        L.job = Object.assign({ label: t.options[t.selectedIndex].text.toLowerCase(), target: t.value }, presets[t.value]);
        L.feed = t.value === 'cache';
      } else L[f] = +t.value;
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = f === 'contention' ? Math.round(+t.value * 100) + ' %' : f === 'hotSetGb' ? t.value + ' ГБ' : SD.fmt.num(+t.value);
      if (e.type === 'change') schedule(true); else schedule(false);
    }
  }

  function timeTick() {
    if (!A.running || !A.res || document.hidden) return;
    const r = A.res;
    if (r.jobs.in > 0) {
      if (r.jobs.backlogRate > 0.5) A.backlog += r.jobs.backlogRate;
      else {
        const spare = Object.values(r.queues).reduce((s, q) => s + q.spare, 0);
        A.backlog = Math.max(0, A.backlog - spare);
      }
    } else A.backlog = 0;
    A.history.push({ s: r.total.success, lat: r.total.lat, b: A.backlog });
    if (A.history.length > 90) A.history.shift();
    SD.panels.metrics(A);
    if (A.tab === 'stats') SD.panels.stats(A);
  }

  /* ---------- тема ---------- */
  function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    save({ theme: next });
  }

  /* ---------- старт ---------- */
  function start(snapshot) {
    const s = load();
    if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
    bind();
    const snap = snapshot && snapshot.levelId ? snapshot : null;
    const lvl = snap ? SD.levelById(snap.levelId) : null;
    const first = SD.LEVELS.find(l => !(A.progress[l.id] || {}).stars) || SD.LEVELS[0];
    const last = s.last && SD.levelById(s.last);
    const L0 = lvl || last || first;
    loadLevel(L0, L0.interview && SD.interview ? SD.interview.specFor(L0) : undefined);
    if (snap && snap.graph) { A.graph = snap.graph; SD.editor.setGraph(A.graph); recompute(true); requestAnimationFrame(() => SD.editor.fit()); }
    /* на телефоне resize прилетает и при прокрутке (прячется адресная строка, выезжает клавиатура):
       холст того же размера — не сбрасываем масштаб и сдвиг, которые человек выставил пальцами */
    const canvasSz = () => { const r = $('canvas').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
    let fitSz = canvasSz();
    window.addEventListener('resize', ev => {
      const sz = canvasSz();
      if (ev.isTrusted && sz === fitSz) return;
      fitSz = sz; SD.editor.fit();
    });
  }
  const hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(() => ({ levelId: A.level && A.level.id, graph: A.graph }));
  if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});

  function setProp(id, key, v) {
    const n = A.graph.nodes.find(x => x.id === id); if (!n) return;
    const prev = Array.isArray(n.props[key]) ? n.props[key].slice() : n.props[key];
    n.props[key] = v;
    if (key === 'role' && SD.applyRole) SD.applyRole(n, v, prev);
    A.pending = { kind: 'prop', node: n, key, value: v, prev }; A.backlog = 0;
    recompute(true);
  }
  function setEdgeProp(id, k, v) {
    const ed = A.graph.edges.find(x => x.id === id); if (!ed) return;
    const prev = Object.assign(SD.edgeDefaults(), ed.props)[k];
    ed.props = Object.assign(SD.edgeDefaults(), ed.props, { [k]: v });
    A.pending = { kind: 'eprop', edge: ed, key: k, value: v, prev };
    recompute(true);
  }
  SD.app = { A, loadLevel, recompute, toast, setProp, setEdgeProp };
})();
