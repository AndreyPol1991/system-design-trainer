/* Удобство: подсказки новичку прямо на холсте, группы в шапке, меню «⋯», сворачиваемые панели,
   пузырь Архи не закрывает схему. */
(function () {
  const $ = id => document.getElementById(id);
  const A = () => (SD.app && SD.app.A) || null;
  const KEY = 'amp-stroyka-ux-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  U.pal = U.pal || {};
  /* телефон: всё стоит друг под другом (как в CSS @media max-width: 900px) */
  const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);

  /* ---------- шапка: «Уровни» отдельно, остальное — в две группы ---------- */
  function navGroups() {
    const nav = document.querySelector('.topbar .nav'), sb = $('navSandbox');
    if (!nav || !sb || nav.querySelector('.nav-grp')) return;
    const groups = [];
    const mk = (label, ids) => {
      const g = document.createElement('div'); g.className = 'nav-grp';
      g.innerHTML = `<button type="button" class="nav-gbtn" aria-haspopup="true" aria-expanded="false">${label} <span aria-hidden="true">▾</span></button><div class="nav-menu" hidden></div>`;
      const menu = g.querySelector('.nav-menu');
      ids.forEach(id => { const b = $(id); if (b) menu.appendChild(b); });
      const btn = g.querySelector('.nav-gbtn');
      /* на телефоне шапка листается вбок и обрезает выпадающее меню — ставим его поверх страницы под кнопкой */
      const place = () => {
        ['position', 'left', 'right', 'top'].forEach(k => { menu.style[k] = ''; });
        if (!narrow()) return;
        const r = btn.getBoundingClientRect(), w = Math.max(menu.offsetWidth, 200);
        Object.assign(menu.style, { position: 'fixed', right: 'auto', top: Math.round(r.bottom + 6) + 'px', left: Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left))) + 'px' });
      };
      btn.addEventListener('click', e => { e.stopPropagation(); const open = menu.hidden; closeAll(); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) place(); });
      menu.addEventListener('click', () => setTimeout(closeAll, 0));
      nav.insertBefore(g, sb); groups.push(g);
      return g;
    };
    const closeAll = () => groups.forEach(g => { g.querySelector('.nav-menu').hidden = true; g.querySelector('.nav-gbtn').setAttribute('aria-expanded', 'false'); });
    mk('Учиться', ['navHub', 'navInt', 'navTour']);
    mk('Знания', ['navPat', 'navLib', 'navLand']);
    document.addEventListener('click', e => { if (!e.target.closest('.nav-grp')) closeAll(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
    /* меню, поставленное поверх страницы, не должно висеть отдельно от уехавшей кнопки */
    const onScroll = () => { if (narrow()) closeAll(); };
    window.addEventListener('scroll', onScroll, { passive: true }); nav.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- панель инструментов: главное в строку, редкое — в «⋯» ---------- */
  function toolbar() {
    const tb = document.querySelector('.stage .toolbar'); if (!tb || $('tbMore')) return;
    const more = document.createElement('div'); more.className = 'tb-more';
    more.innerHTML = `<button type="button" class="btn ghost" id="tbMore" aria-haspopup="true" aria-expanded="false" title="Ещё действия">⋯</button><div class="tb-menu" hidden></div>`;
    const menu = more.querySelector('.tb-menu'), btn = more.querySelector('#tbMore');
    ['solBtn', 'clearBtn'].forEach(id => { const b = $(id); if (b) menu.appendChild(b); });
    tb.querySelectorAll('.sep').forEach((s, i) => { if (i > 0) s.remove(); });
    tb.appendChild(more);
    const chk = $('checkBtn'); if (chk) { chk.classList.add('tb-main'); tb.appendChild(chk); }
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    menu.addEventListener('click', () => setTimeout(() => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }, 0));
    document.addEventListener('click', e => { if (!e.target.closest('.tb-more')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  }

  /* ---------- сворачиваемые панели: холсту больше места ---------- */
  function panels() {
    const ws = document.querySelector('.workspace'); if (!ws || $('palTg')) return;
    if (U.palMini === undefined) U.palMini = window.innerWidth < 1400;
    const pb = document.createElement('button'); pb.type = 'button'; pb.id = 'palTg'; pb.className = 'pane-tg pal-tg';
    const sb = document.createElement('button'); sb.type = 'button'; sb.id = 'sideTg'; sb.className = 'pane-tg side-tg';
    ws.appendChild(pb); ws.appendChild(sb);
    const apply = () => {
      ws.classList.toggle('pal-mini', !!U.palMini); ws.classList.toggle('side-hide', !!U.sideHide);
      pb.textContent = U.palMini ? '›' : '‹'; pb.title = U.palMini ? 'Развернуть палитру' : 'Свернуть палитру до значков';
      sb.textContent = U.sideHide ? '‹' : '›'; sb.title = U.sideHide ? 'Показать задание и настройки' : 'Спрятать правую панель — больше места схеме';
      setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    };
    pb.addEventListener('click', () => { U.palMini = !U.palMini; save(); apply(); });
    sb.addEventListener('click', () => { U.sideHide = !U.sideHide; save(); apply(); });
    apply();
  }

  /* ---------- палитра: раскрыть закрытое и готовые сервисы ---------- */
  function palette() {
    const p = $('palette'); if (!p) return;
    p.addEventListener('click', e => {
      const b = e.target.closest('[data-pmore]'); if (!b) return;
      const id = b.dataset.pmore, list = p.querySelector(`[data-plist="${id}"]`); if (!list) return;
      list.hidden = !list.hidden; U.pal[id] = !list.hidden; save();
      b.setAttribute('aria-expanded', String(!list.hidden));
      const ar = b.querySelector('span[aria-hidden]'); if (ar) ar.textContent = list.hidden ? '▸' : '▾';
    });
  }

  /* ---------- пузырь Архи не закрывает узлы ---------- */
  function mentorPlace() {
    const bub = $('mBubble'), m = $('mentor'); if (!bub || !m) return;
    /* сколько площади узлов закрывает пузырь */
    const cover = () => {
      const r = bub.getBoundingClientRect(); let s = 0;
      document.querySelectorAll('#nodesG .node:not(.l-hide)').forEach(n => { const q = n.getBoundingClientRect(); const w = Math.min(q.right, r.right) - Math.max(q.left, r.left), h = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top); if (w > 0 && h > 0) s += w * h; });
      return s;
    };
    let fitFor = '', fitView = '';
    const vpT = () => { const v = document.getElementById('viewport'); return v ? v.getAttribute('transform') : ''; };
    const place = () => {
      if (bub.hidden) {
        /* Арчи замолчал: если схему никто не двигал после нашей подгонки — вернуть её на весь холст */
        if (fitFor && fitView && fitView === vpT() && SD.editor) SD.editor.fit();
        fitFor = ''; fitView = ''; return;
      }
      m.classList.remove('up');
      const down = cover();
      if (down) m.classList.add('up');
      if (!down || !narrow()) return;
      /* телефон: холст низкий, пузырь закрывает схему и внизу, и вверху — встаёт туда, где закрывает меньше,
         а схема вписывается в свободную полосу, чтобы было видно, куда тянуть */
      const up = cover();
      if (up > down) m.classList.remove('up');
      if (!Math.min(up, down)) return;
      /* вписываем схему один раз на каждую новую реплику, а не на каждую мелкую правку пузыря */
      const sig = bub.textContent.slice(0, 240);
      if (sig === fitFor) return;
      const wr = $('canvasWrap').getBoundingClientRect(), mr = m.getBoundingClientRect(), isUp = m.classList.contains('up');
      const top = isUp ? mr.bottom - wr.top + 8 : 0, bottom = isUp ? 0 : wr.bottom - mr.top + 8;
      if (wr.height - top - bottom >= 110 && SD.editor && SD.editor.fitIn) { SD.editor.fitIn(top, bottom); fitFor = sig; fitView = vpT(); }
    };
    new MutationObserver(() => requestAnimationFrame(place)).observe(bub, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
    /* приветствие Арчи появляется раньше, чем мы подключились, — на телефоне расставляем его сразу */
    if (narrow()) requestAnimationFrame(place);
    /* схему только что вписали на весь холст заново (resize в app.js) — снова вписать её мимо пузыря;
       resize от адресной строки телефона холст не меняет — его пропускаем, как и app.js */
    const canvasSz = () => { const c = $('canvas'), r = c ? c.getBoundingClientRect() : { width: 0, height: 0 }; return Math.round(r.width) + 'x' + Math.round(r.height); };
    let sz = canvasSz();
    window.addEventListener('resize', ev => {
      const s = canvasSz(); if (ev.isTrusted && s === sz) return; sz = s;
      if (narrow()) { fitFor = ''; requestAnimationFrame(place); }
    });
    /* «Показать всё» на телефоне — всё в видимой части холста, мимо открытого пузыря */
    const zf = $('zoomFit');
    if (zf) zf.addEventListener('click', () => { if (narrow() && !bub.hidden) { fitFor = ''; requestAnimationFrame(place); } });
  }

  /* ---------- подсказки новичку прямо на холсте ---------- */
  function coachStep() {
    const S = A(); if (!S || !S.level || S.level.sandbox || S.level.interview || S.level.free || U.coachOff || (SD.walk && SD.walk.active())) return null;
    if (Object.keys(S.progress || {}).length >= 3) return null;
    const pre = new Set((S.level.preset || []).map(p => p[0]));
    const mine = S.graph.nodes.filter(n => n.type !== 'client' && !pre.has(n.id));
    if (!mine.length) return { k: 'add' };
    const orphan = mine.find(n => !S.graph.edges.some(e => e.to === n.id));
    if (orphan) return { k: 'link', n: orphan };
    if (!U.goalsSeen && S.goals && S.goals.length && !S.goals.every(g => g.ok)) return { k: 'goals' };
    return null;
  }
  let goalsT = 0;
  function coach() {
    const box = $('coach'), wrap = $('canvasWrap'); if (!box || !wrap) return;
    const st = coachStep();
    document.querySelectorAll('#palette .coach-pulse').forEach(x => x.classList.remove('coach-pulse'));
    if (!st) { box.hidden = true; return; }
    const wr = wrap.getBoundingClientRect(), rectOf = id => { const el = document.querySelector(`#nodesG .node[data-id="${id}"]`); return el ? el.getBoundingClientRect() : null; };
    const S = A(), cl = S.graph.nodes.find(n => n.type === 'client'), cr = cl ? rectOf(cl.id) : null;
    let html = '', x = wr.width / 2 - 120, y = wr.height / 2 - 50, cls = '';
    if (st.k === 'add') {
      const want = (S.level.allow || []).includes('app') ? 'app' : (S.level.allow || [])[0];
      const part = want && document.querySelector(`#palette .part[data-type="${want}"]`); if (part) part.classList.add('coach-pulse');
      const nm = want && SD.TYPES[want] ? SD.TYPES[want].name : 'компонент';
      if (cr) { x = cr.right - wr.left + 60; y = cr.top - wr.top - 6; }
      cls = 'ghost';
      html = `<b>Шаг 1. Поставь сюда «${nm}»</b><span>Перетащи его из палитры слева — он подсвечен.</span>`;
    } else if (st.k === 'link') {
      const r = rectOf(st.n.id), from = cl && !S.graph.edges.some(e => e.from === cl.id) ? 'Пользователи' : null;
      if (r) { x = r.left - wr.left - 250; y = r.top - wr.top; if (x < 10) { x = r.left - wr.left; y = r.bottom - wr.top + 12; } }
      cls = 'tip';
      html = `<b>Шаг 2. Соедини стрелкой</b><span>${from ? `Потяни от кружка справа у «${from}» к «${(st.n.label || SD.TYPES[st.n.type].name)}»` : `Проведи стрелку к «${(st.n.label || SD.TYPES[st.n.type].name)}» от того, кто его вызывает: тяни от кружка справа у узла`}. Запросы пойдут по стрелкам.</span>`;
    } else {
      x = 14; y = 14; cls = 'tip';
      html = (narrow() ? '<b>Шаг 3. Смотри на цели под схемой ↓</b>' : '<b>Шаг 3. Смотри на цели справа →</b>') + '<span>Красное — что ещё не выполнено: у такой цели есть кнопка «Почему?» — покажу виновника на схеме. Всё зелёное — уровень пройден.</span>';
      if (!goalsT) goalsT = setTimeout(() => { U.goalsSeen = true; save(); goalsT = 0; }, 9000);
    }
    /* телефон: холст маленький — одна подсказка за раз; пока говорит Арчи, рамку шага не рисуем (подсветка детали остаётся) */
    const mb = $('mBubble');
    if (narrow() && mb && !mb.hidden) { box.hidden = true; return; }
    box.className = 'coach ' + cls;
    box.style.left = Math.max(8, Math.min(wr.width - 260, x)) + 'px'; box.style.top = Math.max(8, Math.min(wr.height - 90, y)) + 'px';
    const body = `${html}<button type="button" class="coach-x" data-coachoff="1" title="Больше не подсказывать">×</button>`;
    if (box.dataset.k !== st.k + (st.n ? st.n.id : '')) { box.innerHTML = body; box.dataset.k = st.k + (st.n ? st.n.id : ''); }
    box.hidden = false;
  }
  function mountCoach() {
    const wrap = $('canvasWrap'); if (!wrap || $('coach')) return;
    const b = document.createElement('div'); b.id = 'coach'; b.className = 'coach'; b.hidden = true; wrap.appendChild(b);
    b.addEventListener('click', e => { if (e.target.closest('[data-coachoff]')) { U.coachOff = true; save(); b.hidden = true; } });
    setInterval(coach, 500);
  }

  /* модули шапки и холста монтируются раньше и позже нас — собираем всё, когда интерфейс готов */
  function mount() { setTimeout(() => { navGroups(); toolbar(); panels(); palette(); mentorPlace(); mountCoach(); }, 0); }
  SD.ux = { mount, palOpen: id => !!U.pal[id], resetCoach: () => { U.coachOff = false; U.goalsSeen = false; save(); } };
})();
