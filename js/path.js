/* «Мой путь»: карта навыков по ролям. Каждый навык закрывают уровни и лаборатории; видно, что уже освоено,
   где пробел и какой шаг следующий. Плюс «Вернуться»: уровни, где проверка не прошла. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KEY = 'amp-stroyka-path-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };

  /* навык → уровни и лаборатории (lab:id) */
  const SK = [
    { id: 'calc', name: 'Оценка нагрузки и ёмкости', an: 'Сколько касс открыть в магазине', items: ['first', 'scale', 'lab:estimate', 'k-size', 'k-hpa', 'friday'] },
    { id: 'scale', name: 'Масштабирование и балансировка', an: 'Больше касс и администратор у входа', items: ['scale', 'p-lb', 'k-sticky', 'k-hpa', 'lab:ring', 'c-serverless'] },
    { id: 'cache', name: 'Кэширование', an: 'Холодильник у плиты', items: ['cache', 'short', 'p-cacheaside', 'k-cache-mem', 'k-cache-ttl', 'f-stampede', 'bots'] },
    { id: 'db', name: 'Базы: индексы, реплики, шарды, партиции', an: 'Картотека, копии и филиалы архива', items: ['indexes', 'fresh', 'p-index', 'p-replicas', 'p-sharding', 'k-repl', 'k-cl', 'f-hotpartition', 'lab:table', 'lab:lsm', 'lab:bloom'] },
    { id: 'tx', name: 'Транзакции и согласованность', an: 'Два кассира и последнее место', items: ['booking', 'pay', 'ledger', 'p-isolation', 'p-saga', 'f-dualwrite', 'lab:quorum', 'lab:raft', 'lab:snowflake'] },
    { id: 'async', name: 'Очереди и асинхронность', an: 'Почта: отправил и занимаешься своим', items: ['email', 'order', 'p-outbox', 'p-dlq', 'p-workers', 'k-acks', 'k-batch', 'a-notify', 'a-events', 'i-outbox', 'i-consumer'] },
    { id: 'rel', name: 'Надёжность и отказоустойчивость', an: 'Запасной выход и предохранители', items: ['cascade', 'p-resilience', 'p-retry', 'p-ratelimit', 'f-retrystorm', 'f-spof', 'f-notimeout', 'k-health', 'k-rl', 'c-az', 'lab:resil', 'lab:bucket'] },
    { id: 'arch', name: 'Архитектура и границы сервисов', an: 'Цеха завода и проходные между ними', items: ['lab:nfr', 'lab:api', 'micro', 'legacy', 'ddd', 'a-dbper', 'a-gateway', 'a-split', 'f-shareddb', 'f-distmono', 'i-layers', 'i-ports', 'i-modular', 'i-nplus1'] },
    { id: 'ops', name: 'Наблюдаемость и эксплуатация', an: 'Приборная панель и дежурный', items: ['monitoring', 'o-metrics', 'o-alerts', 'o-logs', 'o-traces', 'o-k8s', 'aiobs', 'lab:deploy', 'lab:slo', 'lab:oncall'] },
    { id: 'data', name: 'Данные и аналитика', an: 'Склад отчётов отдельно от магазина', items: ['analytics', 'd-reports', 'd-clicks', 'd-columns', 'd-lake', 'f-oltpreports', 'lab:stream', 'lab:e2e'] },
    { id: 'cloud', name: 'Облако и стоимость', an: 'Аренда вместо своего здания', items: ['c-az', 'c-spot', 'c-storage', 'c-serverless', 'lab:cloudnet', 'photos', 'video', 'p-cdn', 'p-presigned'] },
    { id: 'rt', name: 'Realtime и особые хранилища', an: 'Рация вместо писем', items: ['chat', 'feed', 'social', 'geo'] },
    { id: 'front', name: 'Клиентская часть и сеть', an: 'От нажатия до готового экрана', items: ['lab:front', 'photos', 'video', 'p-cdn', 'p-presigned', 'chat'] },
    { id: 'ai', name: 'AI-системы', an: 'Умный помощник с правилами', items: ['support', 'ragfix', 'aiobs', 'voice', 'aiscale', 'agent', 'p-router', 'lab:deploy'] }
  ];
  /* много клиентов (SaaS), счёт за облако и учение по восстановлению: js/levels-tenant.js, js/cloud.js, js/lab-nfr.js */
  SK.splice(SK.findIndex(s => s.id === 'ai'), 0, { id: 'saas', name: 'Много клиентов в одном сервисе (SaaS)', an: 'Бизнес-центр: вход общий, офисы свои', items: ['t-leak', 't-noisy', 't-cells', 't-big'] });
  SK.find(s => s.id === 'rel').items.push('t-cells', 'lab:dr');
  SK.find(s => s.id === 'cloud').items.push('c-bill');
  const ROLES = [
    { id: 'sa', name: 'Системный аналитик', skills: ['calc', 'db', 'tx', 'async', 'arch', 'data', 'rel'] },
    { id: 'be', name: 'Бэкенд-разработчик', skills: ['scale', 'cache', 'db', 'tx', 'async', 'rel', 'arch', 'front'] },
    { id: 'sre', name: 'DevOps / SRE', skills: ['calc', 'scale', 'rel', 'ops', 'cloud', 'cache'] },
    { id: 'de', name: 'Дата-инженер', skills: ['data', 'db', 'async', 'cloud', 'calc'] },
    { id: 'arc', name: 'Архитектор', skills: SK.map(s => s.id) }
  ];
  ['sa', 'be'].forEach(id => { const r = ROLES.find(x => x.id === id); if (r && !r.skills.includes('saas')) r.skills.push('saas'); });
  /* цели первого входа (js/ux.js): собеседование — классика интервью; «обзор» — основные уровни по порядку */
  ROLES.push({ id: 'int', name: 'Собеседование по системному дизайну', skills: ['calc', 'scale', 'cache', 'db', 'async', 'rel', 'tx', 'rt'] });
  ROLES.push({ id: 'look', name: 'Обзор: уровни по порядку', skills: SK.map(s => s.id) });

  /* ---------- прогресс ---------- */
  const SHORT = { 'Практикум паттернов': 'Практикум', 'Настройки на пальцах': 'Настройка', 'Найди и перестрой': 'Инцидент', 'Архитектура из сервисов': 'Архитектура', 'Эксплуатация и инструменты': 'Эксплуатация', 'Данные: от события до дашборда': 'Данные', 'Внутри сервиса': 'Внутри сервиса', 'Облако': 'Облако' };
  SHORT['Много клиентов: SaaS'] = 'SaaS';
  const labDef = id => (SD.LABS || []).find(l => l.id === id);
  function itemOf(key) {
    const A = SD.app && SD.app.A;
    if (key.startsWith('lab:')) {
      const id = key.slice(4), L = labDef(id); if (!L) return null;
      const d = ((SD.labs && SD.labs.progress ? SD.labs.progress() : {})[id] || []).length, t = L.tasks.length || 1;
      return { key, title: L.title, kind: 'Лаборатория', done: d / t >= 0.5, part: d / t, open: () => SD.labs.open(id) };
    }
    const L = SD.levelById(key); if (!L) return null;
    const st = ((A && A.progress[key]) || {}).stars || 0;
    return { key, title: L.title, kind: SD.LEVELS.indexOf(L) >= 0 ? `Уровень ${SD.LEVELS.indexOf(L) + 1}` : (SHORT[SD.levelLabel(L)] || SD.levelLabel(L)), done: st > 0, part: st > 0 ? 1 : 0, open: () => { document.querySelectorAll('.modal').forEach(m => { m.hidden = true; }); SD.app.loadLevel(L); } };
  }
  function skillState(s) {
    const items = s.items.map(itemOf).filter(Boolean);
    const done = items.filter(i => i.done).length, frac = items.length ? items.reduce((a, i) => a + (i.done ? 1 : i.part * 0.5), 0) / items.length : 0;
    return { s, items, done, frac, next: items.find(i => !i.done) || null };
  }
  function retry() {
    const A = SD.app && SD.app.A, out = [];
    if (!A || !SD.learn) return out;
    const all = [].concat(SD.LEVELS, SD.PRACTICE || [], SD.FIXES || [], SD.INNER || [], SD.KNOBS || [], SD.ARCHL || [], SD.OPSL || [], SD.DATAL || [], SD.CLOUDL || [], SD.SAASL || []);
    all.forEach(L => { const t = SD.learn.tries(L.id); if (t.length && !t.some(x => x.ok) && !((A.progress[L.id] || {}).stars)) out.push({ L, n: t.length }); });
    return out.slice(0, 6);
  }

  /* ---------- маршрут: цель → порядок шагов и «Дальше» ----------
     Как навигатор: сказал, куда едем, — он строит дорогу. Основные уровни идут по номеру (от простого к сложному),
     а уровни треков и лаборатории своего навыка встают сразу за его основным уровнем. Фундамент (уровни 1–3) — всем. */
  const roleOf = id => ROLES.find(r => r.id === (id || U.role || 'sa')) || ROLES[0];
  const skillsOf = key => SK.filter(s => s.items.includes(key)).map(s => s.id);
  /* знакомое по «Проверь меня»: шаг пропускаем, если знакомы все его навыки — из тех, что входят в роль */
  const familiar = (key, role) => { const k = U.known || {}; let ss = skillsOf(key); if (role) { const rs = ss.filter(id => role.skills.includes(id)); if (rs.length) ss = rs; } return !!ss.length && ss.every(id => k[id]); };
  /* не раньше какого основного уровня (по номеру с нуля) идёт шаг трека: инциденты — после основ, архитектура и код — после микросервисов, эксплуатация — после мониторинга */
  const FLOOR = { 'f-': 7, 'a-': 16, 'i-': 16, 't-': 16, 'o-': 21, 'd-': 21, 'c-': 13 };
  const LAB_FLOOR = { estimate: 0, snowflake: 3, front: 4, ring: 9, lsm: 9, bloom: 9, table: 9, bucket: 12, resil: 15, quorum: 15, raft: 15, cloudnet: 15, nfr: 16, api: 16, dr: 18, deploy: 21, slo: 21, oncall: 21, stream: 23, e2e: 23 };
  const floorOf = k => k.startsWith('lab:') ? (LAB_FLOOR[k.slice(4)] != null ? LAB_FLOOR[k.slice(4)] : 9) : (FLOOR[k.slice(0, 2)] || 0);
  function route(roleId) {
    const role = roleOf(roleId), main = (SD.LEVELS || []).map(l => l.id);
    if (role.id === 'look') return main.slice();
    const rank = {};
    (SD.LEVELS || []).filter(l => l.tier === 'base').forEach(l => { rank[l.id] = main.indexOf(l.id); });
    role.skills.forEach(sid => {
      const s = SK.find(x => x.id === sid); if (!s) return;
      const firstMain = s.items.find(k => main.includes(k));
      let at = firstMain ? main.indexOf(firstMain) : main.length, sub = 0;
      s.items.forEach(k => {
        let r;
        if (main.includes(k)) { at = main.indexOf(k); sub = 0; r = at; } else { sub += 0.01; r = Math.max(at, floorOf(k)) + 0.1 + sub; }
        if (rank[k] === undefined || r < rank[k]) rank[k] = r;
      });
    });
    return Object.keys(rank).sort((a, b) => rank[a] - rank[b]);
  }
  /* следующий шаг маршрута: первый непройденный и незнакомый; если всё знакомое — первый непройденный */
  function next(roleId) {
    const role = roleOf(roleId), keys = route(role.id), items = keys.map(itemOf).filter(Boolean);
    const total = items.length, done = items.filter(i => i.done).length;
    let it = items.find(i => !i.done && !familiar(i.key, role)), skipped = 0;
    if (it) skipped = items.slice(0, items.indexOf(it)).filter(i => !i.done).length;
    else it = items.find(i => !i.done) || null;
    if (!it) return { item: null, role, total, done, idx: total, skipped: 0, why: 'Маршрут пройден целиком' };
    const sk = SK.find(s => s.items.includes(it.key) && role.skills.includes(s.id)) || SK.find(s => s.items.includes(it.key));
    const idx = items.indexOf(it) + 1;
    const why = role.id === 'look' ? `основные уровни по порядку · шаг ${idx} из ${total}` : `${sk ? 'навык «' + sk.name.toLowerCase() + '»' : 'фундамент'} · шаг ${idx} из ${total}`;
    return { item: it, role, skill: sk || null, total, done, idx, skipped, why };
  }
  function setGoal(id) { if (!ROLES.some(r => r.id === id)) return; U.role = id; U.goalSet = true; save(); changed(); }
  function setKnown(map) { U.known = Object.assign({}, map || {}); save(); changed(); }
  const changed = () => { try { document.dispatchEvent(new CustomEvent('sd:path')); } catch (e) { /* старый браузер */ } };

  /* ---------- навыки с платформы ----------
     Внутри платформы мост (js/bridge.js) получает снимок уровней навыков ученика — тех же, что в его
     профиле, — и сопоставляет навыки пути навыкам графа. Тогда у навыка показываем уровень платформы
     с пометкой «по данным платформы»: одна правда о навыках вместо двух. Свой учёт (пройденные
     уровни и лаборатории) остаётся рядом — это шаги, а не уровень. Без платформы строки нет. */
  function platformLine(s) {
    const p = SD.bridge && SD.bridge.pathLevel ? SD.bridge.pathLevel(s.id) : null;
    if (!p) return '';
    const parts = p.skills.map(k => `${k.name} — ${k.level}`).join(' · ');
    return `<small class="pt-plat" title="${esc(parts + (p.at ? ' · снимок от ' + p.at : ''))}">уровень ${p.level} из ${p.max} <span>· по данным платформы</span></small>`;
  }

  /* ---------- окно ---------- */
  let cur = null;
  function render() {
    const role = ROLES.find(r => r.id === (U.role || 'sa')) || ROLES[0];
    const ss = role.skills.map(id => skillState(SK.find(s => s.id === id)));
    const total = ss.length ? Math.round(ss.reduce((a, x) => a + x.frac, 0) / ss.length * 100) : 0;
    const nx = next(role.id), known = U.known || {};
    cur = {};
    let h = `<div class="pt-roles seg" aria-label="Цель">${ROLES.map(r => `<button type="button" data-ptrole="${r.id}" aria-selected="${r.id === role.id}">${esc(r.name)}</button>`).join('')}</div>`;
    h += `<div class="pt-top"><div class="pt-ring" style="--p:${total}"><b>${total}%</b><small>роль</small></div><div class="pt-sum"><b>${esc(role.name)}</b><span>Навыков освоено: ${ss.filter(x => x.frac >= 0.8).length} из ${ss.length}. Навык закрывают уровни и лаборатории — пройденный уровень считается целиком, лаборатория — когда сделана хотя бы половина заданий.</span>`;
    if (nx.item) { cur.w = nx.item; h += `<button type="button" class="btn primary" data-ptgo="w">Следующий шаг: ${esc(nx.item.title)} <small>· ${esc(nx.why)}</small></button>`; }
    else h += '<span class="pt-fin">Маршрут пройден целиком. Возьми другую цель выше или «Событие дня».</span>';
    h += '</div></div>';
    /* разминка дня (js/warmup.js): «К повторению сегодня: N» и кнопка */
    if (SD.warmup && SD.warmup.pathHtml) h += SD.warmup.pathHtml();
    /* цель и маршрут: что дальше по порядку, без давления */
    const keys = route(role.id), its = keys.map(itemOf).filter(Boolean), at = nx.item ? its.indexOf(nx.item) : its.length;
    const win = its.slice(Math.max(0, at - 1), Math.max(0, at - 1) + 6);
    h += `<div class="pt-goal"><p><b>Цель задаёт маршрут.</b> Как навигатор: сказал, куда едешь, — он строит дорогу; свернуть можно в любой момент, пройденное не пропадёт. От цели зависят порядок уровней и кнопка «Дальше» в шапке.${nx.skipped ? ` Знакомое по проверке пропускаю: шагов ${nx.skipped}.` : ''}</p><div class="pt-gbtns"><button type="button" class="btn" data-ptquiz="1">Проверь меня · 7 вопросов</button><button type="button" class="btn ghost" data-ptall="1" aria-pressed="${!!(SD.ux && SD.ux.allOn && SD.ux.allOn())}"><span class="ck" aria-hidden="true">${SD.ux && SD.ux.allOn && SD.ux.allOn() ? '✓' : ''}</span>Показать все инструменты сразу</button></div>`;
    if (win.length) h += `<ol class="pt-route" start="${Math.max(0, at - 1) + 1}">${win.map((it, j) => { const k = 'r' + j; cur[k] = it; const st = it.done ? 'done' : it === nx.item ? 'now' : familiar(it.key, role) ? 'skip' : ''; return `<li class="${st}"><i>${Math.max(0, at - 1) + j + 1}</i><button type="button" class="linkish" data-ptgo="${k}">${it.done ? '✓ ' : it === nx.item ? '→ ' : ''}${esc(it.title)}</button><small>${esc(it.kind)}${st === 'skip' ? ' · знакомо' : ''}</small></li>`; }).join('')}</ol>`;
    h += '</div><div class="pt-grid">';
    ss.forEach((x, i) => {
      const lvl = x.frac >= 0.8 ? 'ok' : x.frac > 0 ? 'mid' : '';
      h += `<section class="pt-sk ${lvl}"><div class="pt-h"><b>${esc(x.s.name)}${known[x.s.id] ? ' <em class="pt-known">знакомо</em>' : ''}</b><span>${x.done} / ${x.items.length}</span></div><small class="pt-an">${esc(x.s.an)}</small>${platformLine(x.s)}<div class="pt-bar"><i style="width:${Math.round(x.frac * 100)}%"></i></div><ul>`;
      x.items.forEach((it, j) => { const k = i + '.' + j; cur[k] = it; h += `<li class="${it.done ? 'done' : ''}"><button type="button" class="linkish" data-ptgo="${k}">${it.done ? '✓ ' : ''}${esc(it.title)}</button><small>${esc(it.kind)}</small></li>`; });
      h += '</ul></section>';
    });
    h += '</div>';
    const back = retry();
    if (back.length) {
      h += `<div class="pt-back"><b>Вернуться</b><span>Уровни, где проверка не прошла, а звезды пока нет: свежий взгляд через пару дней — лучший способ запомнить.</span><div class="pt-chips">${back.map((b, i) => { cur['b' + i] = { open: () => { document.querySelectorAll('.modal').forEach(m => { m.hidden = true; }); SD.app.loadLevel(b.L); } }; return `<button type="button" class="chip" data-ptgo="b${i}">${esc(b.L.title)} · попыток ${b.n}</button>`; }).join('')}</div></div>`;
    }
    $('ptBody').innerHTML = h;
  }
  function open() {
    let m = $('pathModal');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'pathModal'; m.hidden = true;
      m.innerHTML = '<div class="sheet pt-sheet" role="dialog" aria-modal="true" aria-labelledby="ptTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Мой путь</span><h2 id="ptTitle">Карта навыков</h2><button class="btn ghost x" type="button" data-ptx>Закрыть</button></div><div class="pt-body" id="ptBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', e => {
        if (e.target === m || e.target.closest('[data-ptx]')) { m.hidden = true; return; }
        const r = e.target.closest('[data-ptrole]'); if (r) { setGoal(r.dataset.ptrole); render(); return; }
        if (e.target.closest('[data-ptquiz]') && SD.ux && SD.ux.quiz) { m.hidden = true; SD.ux.quiz(); return; }
        if (e.target.closest('[data-ptall]') && SD.ux && SD.ux.setAll) { SD.ux.setAll(!SD.ux.allOn()); render(); return; }
        const g = e.target.closest('[data-ptgo]'); if (g && cur[g.dataset.ptgo]) { m.hidden = true; cur[g.dataset.ptgo].open(); }
      });
    }
    render(); m.hidden = false;
  }

  function mount() {
    setTimeout(() => {
      const hub = $('navHub'), menu = hub && hub.parentNode;
      if (menu && !$('navPath')) { const b = document.createElement('button'); b.type = 'button'; b.id = 'navPath'; b.className = hub.className; b.textContent = 'Мой путь'; b.addEventListener('click', open); menu.insertBefore(b, menu.firstChild); }
    }, 0);
    document.addEventListener('keydown', e => { const m = $('pathModal'); if (e.key === 'Escape' && m && !m.hidden) m.hidden = true; });
  }
  SD.path = { mount, open, SKILLS: SK, ROLES, route, next, itemOf, familiar, setGoal, setKnown, goal: () => (U.goalSet ? U.role : null), role: () => roleOf().id, known: () => Object.assign({}, U.known || {}) };
})();
