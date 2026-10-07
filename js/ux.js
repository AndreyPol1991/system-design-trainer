/* Удобство: маршрут с первой минуты (цель → «Дальше»), три раздела в шапке («Путь · Практика · Справочник»),
   меню «⋯» по смыслу, постепенное раскрытие инструментов с подсказкой «Новое: …», подсказки новичку на холсте,
   сворачиваемые панели, пузырь Арчи не закрывает схему. Ничего не убираем: скрытое находится через Ctrl+K,
   «Показать все инструменты сразу» и прямые ссылки. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const A = () => (SD.app && SD.app.A) || null;
  const KEY = 'amp-stroyka-ux-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  U.pal = U.pal || {};
  U.rv = U.rv || {};
  /* телефон: всё стоит друг под другом (как в CSS @media max-width: 900px) */
  const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
  const toast = t => { if (SD.app && SD.app.toast) SD.app.toast(t); };
  const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
  const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };

  /* ---------- шапка: три раздела «Путь · Практика · Справочник» ----------
     id кнопок прежние — их нажимают другие модули и Ctrl+K; меняются только подписи и место. */
  const NAV = [
    { id: 'path', label: 'Путь', title: 'Куда идти дальше: цель, уровни, событие дня, разминка', items: ['navPath', 'navLevels', 'navDaily', 'navWarm', 'navTour'] },
    { id: 'prac', label: 'Практика', title: 'Попробовать руками: лаборатории, собеседование, группа, песочница', items: ['navLabs', 'navHub', 'navInt', 'navGroup', 'navSandbox', 'navFree'] },
    { id: 'ref', label: 'Справочник', title: 'Прочитать и найти: паттерны, разборы, ландшафт, поиск', items: ['navPat', 'navLib', 'navLand', 'navFind'] }
  ];
  /* подпись в меню и строка «что внутри» простыми словами */
  const NAV_TXT = {
    navPath: ['Мой путь', 'цель, навыки и следующий шаг'],
    navLevels: ['Уровни и треки', 'карта всех уровней по порядку'],
    navDaily: [null, 'новое испытание каждый день'],
    /* разминка дня (js/warmup.js): подпись «Разминка · N карточек» ставит сам модуль */
    navWarm: [null, '5 минут повторения пройденного'],
    navTour: ['Экскурсия по интерфейсу', 'Арчи покажет, что где, за минуту'],
    navLabs: ['Лаборатории', 'опыты руками: шарды, кворум, выкладка'],
    navHub: ['Все тренировки', 'паттерны, инциденты, настройки, треки'],
    navInt: [null, 'задача на время, как на интервью'],
    /* режим группы (js/group.js): кнопку ставит сам модуль рядом с «Собеседованием» */
    navGroup: [null, 'разбор у доски: экран, QR, сравнение решений'],
    navSandbox: [null, 'собирай что угодно, без целей'],
    navFree: [null, 'кейс без эталона — оценю любую схему'],
    navPat: [null, 'каталог: на пальцах и в коде'],
    navLib: ['Разборы и шпаргалки', 'как это работает, по шагам'],
    navLand: [null, 'CI/CD, Kubernetes, наблюдаемость, данные'],
    navFind: ['Поиск по всему', 'уровень, паттерн, действие · Ctrl+K']
  };
  let navG = [];
  function navLabel(b) {
    const t = NAV_TXT[b.id]; if (!t || b.dataset.navTx) return;
    b.dataset.navTx = '1';
    /* экскурсия по интерфейсу раньше пряталась атрибутом hidden (была только у Арчи и в Ctrl+K) — теперь пункт меню «Путь» */
    if (b.id === 'navTour') b.hidden = false;
    if (t[0]) { const tn = [...b.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); if (tn) tn.textContent = t[0]; else b.insertBefore(document.createTextNode(t[0]), b.firstChild); }
    const s = document.createElement('small'); s.className = 'nav-sub'; s.textContent = t[1]; b.appendChild(s);
  }
  function navPlace() {
    if (!navG.length) return;
    NAV.forEach((g, gi) => { const menu = navG[gi].querySelector('.nav-menu'); g.items.forEach(id => { const b = $(id); if (b) { navLabel(b); if (b.parentNode !== menu) menu.appendChild(b); } }); });
    /* порядок внутри меню — как в описании; чужие кнопки, которых нет в списке, остаются там, куда их поставили */
    NAV.forEach((g, gi) => { const menu = navG[gi].querySelector('.nav-menu'); g.items.forEach(id => { const b = $(id); if (b && b.parentNode === menu) menu.appendChild(b); }); });
  }
  function navGroups() {
    const nav = document.querySelector('.topbar .nav'), sb = $('navSandbox');
    if (!nav || !sb || nav.querySelector('.nav-grp')) return;
    /* новые пункты: «Лаборатории» (хаб на разделе лабораторий) и «Поиск по всему» (то же, что Ctrl+K) */
    if (!$('navLabs')) { const b = document.createElement('button'); b.type = 'button'; b.id = 'navLabs'; b.textContent = 'Лаборатории'; b.addEventListener('click', () => { if (SD.hub) SD.hub.open('labs'); }); nav.appendChild(b); }
    if (!$('navFind')) { const b = document.createElement('button'); b.type = 'button'; b.id = 'navFind'; b.textContent = 'Поиск по всему'; b.addEventListener('click', () => { if (SD.cmd) SD.cmd.open(); }); nav.appendChild(b); }
    const first = nav.firstChild;
    const closeAll = () => navG.forEach(g => { g.querySelector('.nav-menu').hidden = true; g.querySelector('.nav-gbtn').setAttribute('aria-expanded', 'false'); });
    NAV.forEach(def => {
      const g = document.createElement('div'); g.className = 'nav-grp'; g.dataset.grp = def.id;
      g.innerHTML = `<button type="button" class="nav-gbtn" aria-haspopup="true" aria-expanded="false" title="${esc(def.title)}">${def.label} <span aria-hidden="true">▾</span></button><div class="nav-menu" hidden></div>`;
      const menu = g.querySelector('.nav-menu'), btn = g.querySelector('.nav-gbtn');
      /* на телефоне шапка листается вбок и обрезает выпадающее меню — ставим его поверх страницы под кнопкой */
      const place = () => {
        ['position', 'left', 'right', 'top'].forEach(k => { menu.style[k] = ''; });
        if (!narrow()) return;
        const r = btn.getBoundingClientRect(), w = Math.max(menu.offsetWidth, 200);
        Object.assign(menu.style, { position: 'fixed', right: 'auto', top: Math.round(r.bottom + 6) + 'px', left: Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left))) + 'px' });
      };
      btn.addEventListener('click', e => { e.stopPropagation(); navPlace(); const open = menu.hidden; closeAll(); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) place(); });
      menu.addEventListener('click', () => setTimeout(closeAll, 0));
      nav.insertBefore(g, first); navG.push(g);
    });
    navPlace();
    document.addEventListener('click', e => { if (!e.target.closest('.nav-grp')) closeAll(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
    /* меню, поставленное поверх страницы, не должно висеть отдельно от уехавшей кнопки */
    const onScroll = () => { if (narrow()) closeAll(); };
    window.addEventListener('scroll', onScroll, { passive: true }); nav.addEventListener('scroll', onScroll, { passive: true });
    /* «Мой путь», «Событие дня» и «Свободный режим» вставляют свои кнопки чуть позже — разложить и их */
    [60, 400, 1500].forEach(t => setTimeout(navPlace, t));
  }

  /* ---------- панель инструментов: главное в строку, редкое — в «⋯» по трём группам ---------- */
  const MORE = [
    { id: 'scheme', label: 'Схема', test: b => /^Отменить|^Вернуть/.test(b.textContent.trim()) || b.id === 'clearBtn' },
    { id: 'help', label: 'Помощь с решением', test: b => ['walkBtn', 'solBtn', 'traceBtn'].includes(b.id) },
    { id: 'view', label: 'Вид и обмен', test: () => true }
  ];
  const MORE_ORDER = ['undo', 'redo', 'clearBtn', 'walkBtn', 'solBtn', 'traceBtn', 'shareBtn', 'find', 'calm', 'big', 'rvAllBtn'];
  const moreKey = b => b.id || (b.dataset.pref ? b.dataset.pref : /^Отменить/.test(b.textContent.trim()) ? 'undo' : /^Вернуть/.test(b.textContent.trim()) ? 'redo' : /^Поиск/.test(b.textContent.trim()) ? 'find' : '');
  function moreGroups() {
    const menu = document.querySelector('.tb-menu'); if (!menu) return;
    if (!menu.querySelector('.tbm-g')) MORE.forEach(g => { const d = document.createElement('div'); d.className = 'tbm-g'; d.dataset.g = g.id; d.innerHTML = `<span class="tbm-h">${g.label}</span>`; menu.appendChild(d); });
    const sb = $('solBtn'); if (sb && !sb.dataset.navTx) { sb.dataset.navTx = '1'; sb.textContent = 'Эталон целиком'; sb.title = 'Заменить схему готовым решением'; }
    const cb = $('clearBtn'); if (cb && !cb.dataset.navTx) { cb.dataset.navTx = '1'; cb.textContent = 'Начать уровень заново'; }
    const all = [...menu.querySelectorAll('button')];
    all.forEach(b => { const g = MORE.find(x => x.test(b)); const box = menu.querySelector(`.tbm-g[data-g="${g.id}"]`); if (b.parentNode !== box) box.appendChild(b); });
    menu.querySelectorAll('.tbm-g').forEach(box => [...box.querySelectorAll('button')].sort((a, b) => { const ia = MORE_ORDER.indexOf(moreKey(a)), ib = MORE_ORDER.indexOf(moreKey(b)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }).forEach(b => box.appendChild(b)));
  }
  function toolbar() {
    const tb = document.querySelector('.stage .toolbar'); if (!tb || $('tbMore')) return;
    const more = document.createElement('div'); more.className = 'tb-more';
    more.innerHTML = `<button type="button" class="btn ghost" id="tbMore" aria-haspopup="true" aria-expanded="false" title="Ещё действия: отмена, эталон, вид, поделиться">⋯</button><div class="tb-menu" hidden></div>`;
    const menu = more.querySelector('.tb-menu'), btn = more.querySelector('#tbMore');
    ['solBtn', 'clearBtn'].forEach(id => { const b = $(id); if (b) menu.appendChild(b); });
    /* переключатель для опытных: все инструменты сразу */
    const all = document.createElement('button'); all.type = 'button'; all.id = 'rvAllBtn'; all.className = 'btn ghost tbm-it'; all.setAttribute('data-rvall', '1');
    all.innerHTML = '<span class="ck" aria-hidden="true"></span><span>Показать все инструменты сразу</span>';
    menu.appendChild(all);
    tb.querySelectorAll('.sep').forEach((s, i) => { if (i > 0) s.remove(); });
    tb.appendChild(more);
    const chk = $('checkBtn'); if (chk) { chk.classList.add('tb-main'); tb.appendChild(chk); }
    btn.addEventListener('click', e => { e.stopPropagation(); moreGroups(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    menu.addEventListener('click', () => setTimeout(() => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }, 0));
    document.addEventListener('click', e => { if (!e.target.closest('.tb-more')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    /* «Отменить», «Поделиться», «Проследить запрос», «Эталон по шагам» добавляют другие модули чуть позже */
    [60, 400, 1500].forEach(t => setTimeout(moreGroups, t));
  }

  /* ---------- постепенное раскрытие инструментов ----------
     Новичку на первом уровне не нужны «Волна», хаос-тест и приборы эксплуатации — они появляются,
     когда пройдено N уровней или на уровне, где без них не обойтись. Открытое остаётся открытым. */
  const levelText = (() => {
    const memo = new WeakMap();
    return L => {
      if (memo.has(L)) return memo.get(L);
      const out = [], seen = new Set();
      const walk = (o, d) => { if (o == null || d > 5) return; if (typeof o === 'string') { out.push(o); return; } if (typeof o !== 'object' || seen.has(o)) return; seen.add(o); if (Array.isArray(o)) o.forEach(x => walk(x, d + 1)); else Object.keys(o).forEach(k => { if (!['solution', 'start', 'preset', 'picture', 'fingers', 'decisions'].includes(k)) walk(o[k], d + 1); }); };
      walk(L, 0); const s = out.join('\n'); memo.set(L, s); return s;
    };
  })();
  const has = (L, rx) => rx.test(levelText(L));
  const solNodes = L => (L.solution && L.solution.nodes) || [];
  const typesIn = L => { const s = new Set(); [L.preset || [], (L.start && L.start.nodes) || [], solNodes(L)].forEach(a => a.forEach(n => s.add(n[1]))); return s; };
  const TOOLS = [
    { id: 'chaos', n: 2, sel: '#chaosBtn', name: '«Уронить узел»', where: 'кнопка над схемой', an: 'Как учебная пожарная тревога: выключаем один сервер и смотрим, устоит ли система.',
      need: L => (L.goals || []).some(g => g.t === 'survive') || !!L.opsLvl || has(L, /уронить узел|урони[а-яё]*\s+(?:экземпляр|узел|сервер)|хаос|chaos|game ?day/i) },
    { id: 'share', n: 2, sel: '#shareBtn', more: true, name: '«Поделиться и экспорт»', where: 'в меню ⋯ над схемой', an: 'Как отправить фото чертежа: ссылка со схемой и выгрузка в Mermaid, C4 и ADR.', need: () => false },
    { id: 'wave', n: 3, sel: '#waveBtn', name: '«Волна»', where: 'кнопка над схемой', an: 'Как час пик в метро: нагрузка плавно вырастет втрое и спадёт — видно, кто не выдержит и как автомасштабирование добавляет серверы.',
      need: L => ['friday', 'k-hpa', 'o-k8s-peak'].includes(L.id) || solNodes(L).some(n => n[4] && n[4].autoscale) || has(L, /волн[аеуы]\b|«волн/i) },
    { id: 'presets', n: 3, sel: '#palette .p-presets', name: '«Готовые сервисы»', where: 'в палитре слева', an: 'Как готовые блюда из кулинарии: сервис авторизации, заказов, уведомлений — уже с ролью и настройками.',
      need: L => !!(L.archLvl || L.opsLvl) || solNodes(L).some(n => n[4] && n[4].role) },
    { id: 'trace', n: 3, sel: '#traceBtn', more: true, name: '«Проследить запрос»', where: 'в меню ⋯ над схемой', an: 'Как трекинг посылки: путь одного запроса по схеме и время в каждом узле.',
      need: L => L.id === 'o-traces' || L.id === 'cascade' || has(L, /проследи(?:ть)? запрос/i) },
    { id: 'lens', n: 4, sel: '.lens-ctl', name: '«Линзы»', where: 'кнопка над схемой', an: 'Как рентген: подсвечивают прямо на схеме паттерны, границы сервисов, ярусы и синхронные связи.',
      need: L => !!L.archLvl || ['micro', 'legacy', 'ddd', 'f-shareddb', 'f-distmono'].includes(L.id) || has(L, /линз/i) },
    { id: 'ops', n: 5, sel: '#palette .p-tools', name: 'инструменты эксплуатации', where: 'в палитре слева', an: 'Как приборная панель и камеры на заводе: метрики, логи, трейсы, алерты, Kubernetes. Ставь их, когда надо увидеть, что творится внутри.',
      need: L => !!L.opsLvl || L.id === 'monitoring' || [...typesIn(L)].some(t => SD.TYPES[t] && SD.TYPES[t].ops) }
  ];
  /* где открыто всё сразу: песочница, свободный режим, собеседование */
  const openAll = L => !!(L && (L.sandbox || L.free || L.interview));
  /* «рост» = пройденные уровни + темы, которые «Проверь меня» отметил знакомыми */
  const passed = () => { const S = A(), k = SD.path && SD.path.known ? Object.keys(SD.path.known()).length : 0; return (S ? Object.values(S.progress || {}).filter(p => p && p.stars).length : 0) + k; };
  /* в песочнице, свободном режиме и на собеседовании видно всё — но только там: вернулся на уровень — прежний набор */
  let ctxAll = false;
  const toolOn = id => !!(U.all || U.rv[id] || ctxAll);
  function syncCls() { const h = document.documentElement; TOOLS.forEach(t => h.classList.toggle('rv-no-' + t.id, !toolOn(t.id))); syncAllBtn(); }
  function syncAllBtn() { document.querySelectorAll('[data-rvall]').forEach(b => { b.setAttribute('aria-pressed', String(!!U.all)); const ck = b.querySelector('.ck'); if (ck) ck.textContent = U.all ? '✓' : ''; }); }
  /* необходимость инструмента на уровне — для проверок и отчёта */
  const needOf = L => TOOLS.filter(t => openAll(L) || safe(() => t.need(L), false)).map(t => t.id);
  const needStrict = (t, L) => !openAll(L) && safe(() => t.need(L), false);
  function reveal(L, quiet) {
    const S = A(); L = L || (S && S.level); if (!L) return;
    const p = passed(), fresh = [];
    ctxAll = openAll(L);
    TOOLS.forEach(t => { if (!U.rv[t.id] && (p >= t.n || needStrict(t, L))) { U.rv[t.id] = 1; fresh.push(t); } });
    if (fresh.length) save();
    syncCls();
    if (fresh.length && !quiet && !U.all) announce(fresh);
  }
  function setAll(v) {
    U.all = !!v; save(); syncCls();
    toast(v ? 'Все инструменты на виду: «Волна», «Уронить узел», «Линзы», приборы эксплуатации и всё в меню ⋯.' : 'Инструменты снова открываются по мере роста. Уже открытые остаются на месте.');
  }
  /* хаос-тест и «Волну» можно вызвать и через Ctrl+K: раз человек о них знает — показываем кнопку насовсем */
  function revealOnUse() {
    TOOLS.forEach(t => { const el = document.querySelector(t.sel.startsWith('#palette') ? '#nothing' : t.sel); if (el && !el.dataset.rvUse) { el.dataset.rvUse = '1'; el.addEventListener('click', () => { if (!toolOn(t.id)) { U.rv[t.id] = 1; save(); syncCls(); } }, true); } });
  }

  /* подсказка «Новое: …» у появившегося инструмента */
  const tipQ = [];
  let tipT = 0, tipEl = null;
  function tipBox() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div'); tipEl.className = 'rv-tip'; tipEl.id = 'rvTip'; tipEl.hidden = true; tipEl.setAttribute('role', 'status');
    document.body.appendChild(tipEl);
    tipEl.addEventListener('click', e => { if (e.target.closest('[data-rvok]')) hideTip(); if (e.target.closest('[data-rvallon]')) { hideTip(); setAll(true); } });
    return tipEl;
  }
  function hideTip() { if (!tipEl) return; tipEl.hidden = true; clearTimeout(tipT); document.querySelectorAll('.rv-pulse').forEach(x => x.classList.remove('rv-pulse')); if (tipQ.length) setTimeout(showTip, 700); }
  const busy = () => [...document.querySelectorAll('.modal')].some(m => !m.hidden) || ($('tourCard') && !$('tourCard').hidden) || ($('cmdk') && !$('cmdk').hidden);
  const shown = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function announce(list) { tipQ.push({ list }); setTimeout(showTip, 1200); }
  function note(item) { tipQ.push(item); setTimeout(showTip, 1200); }
  function showTip() {
    const box = tipBox(); if (!box.hidden || !tipQ.length) return;
    if (busy()) { setTimeout(showTip, 1500); return; }
    const q = tipQ.shift();
    let anchor = null, html = '';
    if (q.list) {
      const t0 = q.list[0];
      anchor = [t0.sel, t0.more ? '#tbMore' : null, '#palette', '.stage .toolbar'].map(s => s && document.querySelector(s)).find(shown) || null;
      if (t0.sel.startsWith('#palette')) { const p = document.querySelector(t0.sel); if (shown(p)) anchor = p; }
      html = `<div class="rv-h"><span class="rv-new">Новое</span><b>${q.list.length > 1 ? 'Открылись инструменты' : esc(t0.name)}</b></div>` + (q.list.length > 2 ? `<ul class="rv-list">${q.list.map(t => `<li><b>${esc(t.name)}</b> — ${esc(t.where)}</li>`).join('')}</ul><p>Что делает каждый — подскажет Арчи и поиск Ctrl+K.</p>` : q.list.map(t => `<p>${q.list.length > 1 ? `<b>${esc(t.name)}</b> — ` : ''}${esc(t.where[0].toUpperCase() + t.where.slice(1))}. ${esc(t.an)}</p>`).join(''));
    } else { anchor = q.anchor ? document.querySelector(q.anchor) : null; html = q.html; }
    html += `<div class="rv-acts"><button type="button" class="btn primary" data-rvok="1">Понятно</button>${q.list && !U.all ? '<button type="button" class="btn ghost" data-rvallon="1">Показать всё сразу</button>' : ''}</div>`;
    box.innerHTML = html; box.hidden = false;
    const w = Math.min(320, window.innerWidth - 24); box.style.width = w + 'px';
    const r = anchor && shown(anchor) ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2 - w / 2, right: window.innerWidth / 2 + w / 2, top: 80, bottom: 80, width: w };
    const h = box.offsetHeight; let x = r.left + r.width / 2 - w / 2, y = r.bottom + 10;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 10);
    x = Math.max(12, Math.min(window.innerWidth - w - 12, x));
    box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(y) + 'px';
    box.classList.toggle('below', y >= r.bottom);
    if (anchor) anchor.classList.add('rv-pulse');
    clearTimeout(tipT); tipT = setTimeout(hideTip, q.list ? 16000 : 14000);
  }
  /* в туре Арчи «Пульт» упоминает «Уронить узел» — пока кнопка не открылась, честно говорим, что она появится позже */
  function tourPatch() {
    const card = $('tourCard'); if (!card) return;
    new MutationObserver(() => {
      if (toolOn('chaos')) return;
      const p = card.querySelector('p'); if (!p || p.dataset.rvPatched) return;
      if (/«Уронить узел»/.test(p.textContent)) { p.dataset.rvPatched = '1'; p.textContent = p.textContent.replace(/«Уронить узел» — хаос-тест: проверка, переживёт ли система сбой\./, '«Уронить узел» (хаос-тест: переживёт ли система сбой) появится чуть позже — когда пригодится. «⋯» — отмена, эталон и вид.'); }
    }).observe(card, { childList: true, subtree: true });
  }

  /* ---------- «Дальше: <шаг> · почему» — один следующий шаг всегда на виду ---------- */
  let NX = null, nxSig = '';
  const nextCalc = () => (SD.path && SD.path.next ? safe(() => SD.path.next(), null) : null);
  function mountNext() {
    const lb = $('levelBtn'); if (!lb || $('nextWrap')) return;
    const w = document.createElement('div'); w.className = 'next-wrap'; w.id = 'nextWrap';
    w.innerHTML = `<button type="button" class="next-btn" id="nextBtn"><span class="nx-k">Дальше</span><span class="nx-t" id="nextT">…</span></button><button type="button" class="next-why" id="nextWhy" aria-expanded="false" aria-controls="nextPop" title="Почему этот шаг">почему</button><div class="next-pop" id="nextPop" role="dialog" aria-label="Почему этот шаг" hidden></div>`;
    lb.after(w);
    const pop = $('nextPop');
    const togglePop = open => { if (open) { pop.innerHTML = whyHtml(); pop.hidden = false; placePop(); } else pop.hidden = true; $('nextWhy').setAttribute('aria-expanded', String(!pop.hidden)); };
    $('nextBtn').addEventListener('click', () => {
      const it = NX && NX.item, S = A();
      if (!it) { if (SD.path) SD.path.open(); return; }
      if (S && S.level && it.key === S.level.id) { togglePop(pop.hidden); return; }
      togglePop(false); it.open();
    });
    $('nextWhy').addEventListener('click', e => { e.stopPropagation(); togglePop(pop.hidden); });
    pop.addEventListener('click', e => {
      const b = e.target.closest('[data-nx]'); if (!b) return;
      togglePop(false);
      if (b.dataset.nx === 'path' && SD.path) SD.path.open();
      if (b.dataset.nx === 'goal') goalOpen(true);
      if (b.dataset.nx === 'go' && NX && NX.item) NX.item.open();
    });
    document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest('#nextWrap')) togglePop(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) togglePop(false); });
    document.addEventListener('sd:path', () => { reveal(null, false); renderNext(true); });
    setInterval(() => { const s = nextSig(); if (s !== nxSig) renderNext(false); }, 1200);
    renderNext(false);
  }
  function placePop() {
    const pop = $('nextPop'), r = $('nextWrap').getBoundingClientRect(), w = Math.min(340, window.innerWidth - 24);
    Object.assign(pop.style, { width: w + 'px', left: Math.round(Math.max(12, Math.min(window.innerWidth - w - 12, r.left))) + 'px', top: Math.round(r.bottom + 8) + 'px' });
  }
  const nextSig = () => { const S = A(); if (!S) return ''; const lp = SD.labs && SD.labs.progress ? safe(() => Object.values(SD.labs.progress()).map(x => (x || []).length).join(','), '') : ''; return [S.level && S.level.id, JSON.stringify(S.progress), lp, SD.path && SD.path.role ? SD.path.role() : ''].join('|'); };
  function renderNext(pulse) {
    const S = A(), b = $('nextBtn'); if (!b || !S) return;
    nxSig = nextSig(); NX = nextCalc();
    if (!NX) { $('nextWrap').hidden = true; return; }
    $('nextWrap').hidden = false;
    const it = NX.item, here = !!(it && S.level && it.key === S.level.id);
    b.classList.toggle('here', here); b.classList.toggle('fin', !it);
    b.querySelector('.nx-k').textContent = !it ? 'Маршрут' : here ? 'Ты на маршруте' : 'Дальше';
    $('nextT').textContent = !it ? 'пройден целиком ✓' : here ? `шаг ${NX.idx}` : it.title;
    b.title = !it ? 'Все шаги маршрута пройдены — открыть «Мой путь»' : here ? 'Это и есть следующий шаг маршрута. Нажми, чтобы узнать почему' : `Перейти: ${it.title} (${it.kind})`;
    const pop = $('nextPop'); if (pop && !pop.hidden) pop.innerHTML = whyHtml();
    if (pulse && !here && it) { b.classList.add('rv-pulse'); setTimeout(() => b.classList.remove('rv-pulse'), 4200); }
  }
  function whyHtml() {
    const S = A(); if (!NX) return '';
    const it = NX.item, here = !!(it && S && S.level && it.key === S.level.id), goal = SD.path && SD.path.goal && SD.path.goal();
    const g = goal ? `Цель: <b>${esc(NX.role.name)}</b>.` : `Цель ещё не выбрана — веду по маршруту «${esc(NX.role.name)}».`;
    const body = !it ? 'Все шаги маршрута пройдены. Возьми другую цель или «Событие дня» в разделе «Путь».'
      : `${here ? 'Ты как раз на следующем шаге' : `Следующий непройденный шаг — <b>${esc(it.title)}</b> (${esc(it.kind.toLowerCase())})`}: ${esc(NX.why)}.${NX.skipped ? ` Знакомое по проверке пропускаю: шагов ${NX.skipped}.` : ''}`;
    return `<b class="np-h">${!it ? 'Маршрут пройден' : here ? 'Почему этот уровень' : 'Почему «' + esc(it.title) + '»'}</b><p>${g} ${body}</p><p class="np-an">Как навигатор: ведёт от простого к сложному, а свернуть можно в любой момент — пройденное не пропадёт.</p><div class="np-acts">${it && !here ? '<button type="button" class="btn primary" data-nx="go">Перейти</button>' : ''}<button type="button" class="btn" data-nx="path">Мой путь</button><button type="button" class="btn ghost" data-nx="goal">Сменить цель</button></div>`;
  }
  /* «Следующий уровень» после победы: если уровень на маршруте — ведём по маршруту, иначе по треку (как раньше) */
  function routeNext(L) {
    if (!L || !SD.path || !SD.path.route) return null;
    const keys = safe(() => SD.path.route(), []); if (!keys.includes(L.id)) return null;
    const n = nextCalc(); return n && n.item && n.item.key !== L.id ? n.item : null;
  }

  /* ---------- выбор цели при первом входе и «Проверь меня» ---------- */
  const GOALS = [
    ['sa', 'Учусь на системного аналитика', 'требования, данные, интеграции, надёжность'],
    ['be', 'Учусь на бэкенд-разработчика', 'масштаб, кэш, базы, очереди, отказы'],
    ['arc', 'Учусь на архитектора', 'всё понемногу: от расчёта нагрузки до границ сервисов'],
    ['int', 'Готовлюсь к собеседованию по системному дизайну', 'классика интервью: расчёт, масштаб, кэш, шарды, очереди'],
    ['look', 'Просто посмотреть', 'основные уровни по порядку, без спешки']
  ];
  /* вопросы «что будет, если…»: у каждого навык из «Моего пути»; верный ответ — тема знакома, её шаги пропустим */
  const QUIZ = [
    { sk: 'calc', q: 'К сервису приходит 4 млн запросов в сутки. Сколько это в секунду в среднем?', o: [['≈ 46', 1], ['≈ 460', 0], ['≈ 4 600', 0]], fb: 'В сутках около 86 400 секунд: 4 000 000 / 86 400 ≈ 46. В час пик бывает в 2–5 раз больше.' },
    { sk: 'scale', q: 'Один сервер держит 2 500 запросов в секунду, а приходит 3 000. Рядом поставили ещё два таких же. Что ещё нужно, чтобы нагрузка разошлась?', o: [['Балансировщик — он раздаёт запросы между серверами', 1], ['Ничего: запросы сами найдут свободный сервер', 0], ['Ничего, лучше один сервер помощнее', 0]], fb: 'Как три кассы и администратор у входа: без него вся очередь стоит к одной кассе — пользователи знают один адрес.' },
    { sk: 'cache', q: 'Карточку товара читают в 100 раз чаще, чем меняют, и база не справляется. Что снимет с неё нагрузку быстрее и дешевле всего?', o: [['Кэш в памяти перед базой', 1], ['Ещё одна такая же база-копия', 0], ['Сервер приложения помощнее', 0]], fb: 'Как холодильник у плиты: частое берём рядом, в кладовую (базу) ходим редко. Копия базы тоже помогает, но дороже.' },
    { sk: 'db', q: 'Поиск заказов клиента в таблице на 10 млн строк идёт 3 секунды. Что поможет первым делом?', o: [['Индекс по полю «клиент»', 1], ['Больше памяти серверу приложения', 0], ['Разбить таблицу на 10 баз', 0]], fb: 'Индекс — как алфавитный указатель в книге: не листаешь все страницы подряд, а сразу открываешь нужную.' },
    { sk: 'async', q: 'Письмо после регистрации отправляется прямо в запросе. Почтовый сервис лёг на час. Как сделать, чтобы регистрация не падала вместе с ним?', o: [['Положить задачу «отправь письмо» в очередь — обработчик отправит позже', 1], ['Повторять отправку в том же запросе, пока не получится', 0], ['Убрать письма совсем', 0]], fb: 'Как почтовый ящик: бросил письмо и пошёл дальше, почтальон доставит, когда сможет. Регистрация не ждёт почту.' },
    { sk: 'tx', q: 'Два человека одновременно покупают последнее место в зале. Система сначала проверяет «свободно?», потом записывает покупку. Что может случиться?', o: [['Оба купят одно и то же место', 1], ['Ничего: база сама всё разрулит', 0], ['Один запрос всегда упадёт с ошибкой', 0]], fb: 'Два кассира одновременно посмотрели в журнал — «свободно» — и оба продали. Нужна блокировка или проверка внутри одной транзакции.' },
    { sk: 'rel', q: 'Соседний сервис стал отвечать 30 секунд вместо 0,1, а наш ждёт его без таймаута. Что будет с нашим сервисом?', o: [['Тоже встанет: все его работники заняты ожиданием', 1], ['Ничего: медленный сосед — его проблема', 0], ['Станет быстрее: меньше работы', 0]], fb: 'Как очередь к кассиру, который ушёл звонить: очередь растёт у всех. Спасают таймаут, предохранитель и запасной ответ.' }
  ];
  let G = { step: 'goal', qi: 0, pick: null, known: {}, from: '' };
  function goalModal() {
    let m = $('goalModal'); if (m) return m;
    m = document.createElement('div'); m.className = 'modal gp-modal'; m.id = 'goalModal'; m.hidden = true;
    m.innerHTML = '<div class="sheet gp-sheet" role="dialog" aria-modal="true" aria-labelledby="gpTitle"><div class="gp-body" id="gpBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', onGoalClick);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) goalClose(G.step === 'goal' ? 'skip' : 'done'); });
    return m;
  }
  function goalOpen(again) {
    const m = goalModal(); G = { step: 'goal', qi: 0, pick: null, known: {}, from: again ? 'again' : 'first' };
    const mb = $('mBubble'); if (mb) mb.hidden = true;
    renderGoal(); m.hidden = false;
    /* фокус — на само окно, а не на первый вариант: иначе он выглядит уже выбранным */
    const sh = m.querySelector('.gp-sheet'); if (sh) { sh.tabIndex = -1; setTimeout(() => { try { sh.focus({ preventScroll: true }); } catch (e) { /* фокус не важен */ } }, 30); }
  }
  const roleName = id => { const r = SD.path && SD.path.ROLES.find(x => x.id === id); return r ? r.name : ''; };
  function renderGoal() {
    const b = $('gpBody'); let h = '';
    if (G.step === 'goal') {
      const cur = SD.path && SD.path.goal ? SD.path.goal() : null;
      h += `<span class="eyebrow">Маршрут</span><h2 id="gpTitle">Зачем ты здесь?</h2><p class="gp-lede">Как навигатор: скажи, куда едем, — проложу маршрут. От цели зависят порядок уровней и кнопка «Дальше» в шапке. Это не экзамен: сменить цель можно в любой момент в «Моём пути».</p>`;
      h += `<div class="gp-grid">${GOALS.map(([id, t, s]) => `<button type="button" class="gp-opt${cur === id ? ' on' : ''}" data-gp="${id}"><b>${esc(t)}</b><small>${esc(s)}</small></button>`).join('')}</div>`;
      h += `<p class="gp-more">Другая роль: <button type="button" class="linkish" data-gp="sre">DevOps / SRE</button> · <button type="button" class="linkish" data-gp="de">дата-инженер</button></p>`;
      h += `<div class="gp-foot"><label class="gp-all"><input type="checkbox" data-gpall="1" ${U.all ? 'checked' : ''}> Я опытный: показать все инструменты сразу</label><button type="button" class="btn ghost" data-gpskip="1">${G.from === 'again' ? 'Закрыть' : 'Пропустить'}</button></div>`;
    } else if (G.step === 'start') {
      const n = nextCalc(), it = n && n.item;
      h += `<span class="eyebrow">Маршрут готов</span><h2 id="gpTitle">С чего начнём?</h2><p class="gp-lede">Цель — <b>${esc(roleName(G.pick))}</b>: ${n ? n.total : 0} ${plural(n ? n.total : 0, "шаг", "шага", "шагов")} от простого к сложному.${it ? ` Первый непройденный — «${esc(it.title)}».` : ''} Если что-то уже знаешь — проверю за пару минут и пропущу знакомое.</p>`;
      h += `<div class="gp-acts"><button type="button" class="btn primary" data-gpgo="1">${it ? 'Начать: ' + esc(it.title) + ' →' : 'Начать'}</button><button type="button" class="btn" data-gpquiz="1">Проверь меня · 7 вопросов</button></div><p class="gp-note">Проверка ничего не оценивает и никуда не уходит: от ответов зависит только, какие шаги маршрута я пропущу.</p>`;
    } else if (G.step === 'quiz') {
      const Q = QUIZ[G.qi], ans = G.ans;
      h += `<span class="eyebrow">Проверь меня · ${G.qi + 1} из ${QUIZ.length}</span><div class="gp-prog" aria-hidden="true"><i style="width:${Math.round(G.qi / QUIZ.length * 100)}%"></i></div><h2 id="gpTitle" class="gp-q">${esc(Q.q)}</h2>`;
      h += `<div class="gp-opts">${Q.o.map(([t, ok], i) => `<button type="button" class="gp-a${ans != null ? (ok ? ' right' : i === ans ? ' wrong' : '') : ''}" data-gpa="${i}" ${ans != null ? 'disabled' : ''}>${esc(t)}</button>`).join('')}</div>`;
      if (ans != null) h += `<p class="gp-fb ${Q.o[ans] && Q.o[ans][1] ? 'ok' : ''}"><b>${ans < 0 ? 'Ничего страшного.' : Q.o[ans][1] ? 'Верно.' : 'Не совсем.'}</b> ${esc(Q.fb)}</p><div class="gp-acts"><button type="button" class="btn primary" data-gpnext="1">${G.qi < QUIZ.length - 1 ? 'Дальше →' : 'Итог'}</button></div>`;
      else h += `<div class="gp-acts"><button type="button" class="btn ghost" data-gpa="-1">Не знаю</button></div>`;
    } else if (G.step === 'result') {
      const SKN = id => { const s = SD.path && SD.path.SKILLS.find(x => x.id === id); return s ? s.name : id; };
      const yes = QUIZ.filter(x => G.known[x.sk]).map(x => x.sk), no = QUIZ.filter(x => !G.known[x.sk]).map(x => x.sk);
      const n = nextCalc(), it = n && n.item;
      h += `<span class="eyebrow">Итог проверки</span><h2 id="gpTitle">Знакомо: ${yes.length} из ${QUIZ.length}</h2>`;
      if (yes.length) h += `<p class="gp-lede">Отметил в «Моём пути» как знакомое — эти шаги пропущу (вернуться к ним можно в любой момент):</p><div class="gp-chips">${yes.map(id => `<span class="chip ok">✓ ${esc(SKN(id))}</span>`).join('')}</div>`;
      if (no.length) h += `<p class="gp-lede">С этого маршрут и начнётся:</p><div class="gp-chips">${no.map(id => `<span class="chip">${esc(SKN(id))}</span>`).join('')}</div>`;
      h += `<p class="gp-lede">${it ? `Начнём с «<b>${esc(it.title)}</b>» — ${esc(n.why)}.` : 'Маршрут уже пройден.'}</p><div class="gp-acts"><button type="button" class="btn primary" data-gpgo="1">${it ? 'Начать: ' + esc(it.title) + ' →' : 'Закрыть'}</button><button type="button" class="btn" data-gppath="1">Открыть «Мой путь»</button></div>`;
    }
    b.innerHTML = h;
  }
  function onGoalClick(e) {
    const m = $('goalModal');
    if (e.target === m) { goalClose(G.step === 'goal' ? 'skip' : 'done'); return; }
    const t = e.target.closest('button, input'); if (!t) return;
    if (t.dataset.gpall) { setAll(t.checked); return; }
    if (t.dataset.gpskip) { goalClose('skip'); return; }
    if (t.dataset.gp) {
      G.pick = t.dataset.gp; if (SD.path) SD.path.setGoal(G.pick);
      if (G.pick === 'look') { goalClose('go'); return; }
      G.step = 'start'; renderGoal(); return;
    }
    if (t.dataset.gpquiz) { G.step = 'quiz'; G.qi = 0; G.ans = null; G.known = {}; renderGoal(); return; }
    if (t.dataset.gpa != null && G.ans == null) { G.ans = +t.dataset.gpa; const Q = QUIZ[G.qi]; G.known[Q.sk] = !!(Q.o[G.ans] && Q.o[G.ans][1]); renderGoal(); return; }
    if (t.dataset.gpnext) {
      if (G.qi < QUIZ.length - 1) { G.qi++; G.ans = null; renderGoal(); return; }
      const known = {}; Object.keys(G.known).forEach(k => { if (G.known[k]) known[k] = true; });
      if (SD.path) SD.path.setKnown(known);
      G.step = 'result'; renderGoal(); return;
    }
    if (t.dataset.gpgo) { goalClose('go'); return; }
    if (t.dataset.gppath) { goalClose('done'); if (SD.path) SD.path.open(); }
  }
  function goalClose(how) {
    const m = $('goalModal'); if (!m) return;
    m.hidden = true; U.goalAsked = 1; save();
    const S = A(), n = nextCalc(), it = n && n.item;
    if (how === 'go' && it && S && S.level && it.key !== S.level.id) it.open();
    renderNext(how !== 'skip');
    /* знакомство с Арчи: если тур ещё не показан — предложить его, как раньше при первом входе */
    let tourDone = true; try { tourDone = !!JSON.parse(localStorage.getItem('amp-stroyka-mentor-v1') || '{}').tourDone; } catch (e) { tourDone = true; }
    if (G.from === 'first' && !tourDone && SD.mentor) setTimeout(() => SD.mentor.say(`${how === 'skip' ? 'Привет! Я <b>Арчи</b>, прораб этой стройплощадки. Здесь ты строишь системы, пускаешь на них нагрузку и смотришь, где ломается.' : 'Маршрут готов: <b>«Дальше»</b> в шапке всегда покажет следующий шаг. Я <b>Арчи</b>, прораб.'} Показать за минуту, что где?`, { force: true, mood: 'happy', acts: [['Покажи', 'tour', '', true], ['Сам разберусь', 'skiptour']] }), 450);
  }
  /* первый вход: прогресса нет, цель не выбрана, не открыта ссылка со схемой — спрашиваем цель */
  function firstRun() {
    if (U.goalAsked || (SD.path && SD.path.goal && SD.path.goal()) || U.oldUser) return;
    if (deepLink) return;
    const S = A(); if (!S || Object.keys(S.progress || {}).length) return;
    goalOpen(false);
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
    /* рядом открыта подсказка «Новое: …» — одна подсказка за раз */
    if (tipEl && !tipEl.hidden) { box.hidden = true; return; }
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

  /* ---------- Ctrl+K: новые пункты (цель, проверка, все инструменты, следующий шаг, лаборатории) ---------- */
  function cmdItems() {
    SD.cmdExtra = SD.cmdExtra || [];
    SD.cmdExtra.push(add => {
      add('Открыть', 'Выбрать цель и маршрут', 'аналитик, бэкенд, архитектор, собеседование, обзор', () => goalOpen(true), 'цель роль маршрут навигатор');
      add('Открыть', 'Проверь меня: 7 вопросов', 'отмечу знакомое и подберу, с чего начать', () => quiz(), 'тест проверка уровень знаний');
      add('Открыть', 'Лаборатории', 'опыты руками: шарды, кворум, выкладка, таблица', () => { if (SD.hub) SD.hub.open('labs'); }, 'лаборатория опыт');
      add('Вид', `Показать все инструменты сразу: ${U.all ? 'выключить' : 'включить'}`, '«Волна», «Уронить узел», «Линзы», приборы эксплуатации', () => setAll(!U.all), 'опытный всё сразу инструменты');
      const n = nextCalc(); if (n && n.item) add('Действие', `Дальше по маршруту: ${n.item.title}`, n.why, () => n.item.open(), 'дальше следующий шаг маршрут');
    });
  }

  /* ---------- хуки приложения (app.js) ---------- */
  function onLevel(L) {
    /* уровень открыли в обход окна цели (ссылка, тест, другой модуль) — окно не мешает; спросим в следующий раз */
    const gm = $('goalModal'); if (gm && !gm.hidden) gm.hidden = true;
    reveal(L, false);
    renderNext(false);
  }
  function onWin() { reveal(null, false); renderNext(true); }
  function quiz() { goalOpen(true); G.pick = SD.path && SD.path.role ? SD.path.role() : 'sa'; G.step = 'quiz'; G.qi = 0; G.ans = null; G.known = {}; renderGoal(); }

  /* модули шапки и холста монтируются раньше и позже нас — собираем всё, когда интерфейс готов */
  /* открыли по ссылке со схемой (#s=…, js/share.js стирает её из адреса сразу) — окно цели не показываем */
  let deepLink = false;
  function mount() {
    deepLink = /^#s=/.test(location.hash || '');
    /* вернувшийся ученик (есть прогресс или Арчи уже здоровался): инструменты, которые он видел, не прячем */
    if (!U.rvInit) {
      U.rvInit = 1;
      let old = false;
      try { const s = JSON.parse(localStorage.getItem('amp-stroyploshchadka-v1') || '{}'); old = !!(s.last || Object.keys(s.progress || {}).length); } catch (e) { old = false; }
      try { old = old || !!JSON.parse(localStorage.getItem('amp-stroyka-mentor-v1') || '{}').welcomed; } catch (e) { /* без хранилища */ }
      if (old) { U.oldUser = 1; TOOLS.forEach(t => { U.rv[t.id] = 1; }); }
      save();
    }
    syncCls();
    cmdItems();
    document.addEventListener('click', e => { if (e.target.closest('[data-rvall]')) setAll(!U.all); });
    setTimeout(() => {
      navGroups(); toolbar(); panels(); palette(); mentorPlace(); mountCoach(); mountNext(); tourPatch(); syncCls();
      setTimeout(() => { revealOnUse(); syncCls(); }, 500);
      setTimeout(firstRun, 120);
      /* вернувшимся — один раз рассказать про маршрут */
      if (U.oldUser && !U.routeNews && !(SD.path && SD.path.goal && SD.path.goal())) { U.routeNews = 1; save(); note({ anchor: '#nextWrap', html: '<div class="rv-h"><span class="rv-new">Новое</span><b>Маршрут и «Дальше»</b></div><p>Кнопка «Дальше» всегда показывает следующий шаг. Как навигатор: выбери цель — аналитик, бэкенд, архитектор или собеседование — и порядок уровней подстроится. Цель — в «Путь ▾ → Мой путь».</p>' }); }
    }, 0);
  }
  SD.ux = {
    mount, palOpen: id => !!U.pal[id], resetCoach: () => { U.coachOff = false; U.goalsSeen = false; save(); },
    onLevel, onWin, routeNext, goal: goalOpen, quiz, setAll, allOn: () => !!U.all,
    tools: () => TOOLS.map(t => ({ id: t.id, n: t.n, on: toolOn(t.id), name: t.name })), needOf, toolOn,
    /* служебное (проверки, показ наставником): снова спрятать открытые инструменты, как у новичка */
    resetReveal: () => { U.rv = {}; U.all = false; save(); syncCls(); }
  };
})();
