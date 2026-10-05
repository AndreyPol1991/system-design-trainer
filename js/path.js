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
    { id: 'arch', name: 'Архитектура и границы сервисов', an: 'Цеха завода и проходные между ними', items: ['lab:nfr', 'micro', 'legacy', 'ddd', 'a-dbper', 'a-gateway', 'a-split', 'f-shareddb', 'f-distmono', 'i-layers', 'i-ports', 'i-modular', 'i-nplus1'] },
    { id: 'ops', name: 'Наблюдаемость и эксплуатация', an: 'Приборная панель и дежурный', items: ['monitoring', 'o-metrics', 'o-alerts', 'o-logs', 'o-traces', 'o-k8s', 'lab:deploy', 'lab:slo'] },
    { id: 'data', name: 'Данные и аналитика', an: 'Склад отчётов отдельно от магазина', items: ['analytics', 'd-reports', 'd-clicks', 'd-columns', 'd-lake', 'f-oltpreports'] },
    { id: 'cloud', name: 'Облако и стоимость', an: 'Аренда вместо своего здания', items: ['c-az', 'c-spot', 'c-storage', 'c-serverless', 'photos', 'video', 'p-cdn', 'p-presigned'] },
    { id: 'rt', name: 'Realtime и особые хранилища', an: 'Рация вместо писем', items: ['chat', 'feed', 'social', 'geo'] },
    { id: 'ai', name: 'AI-системы', an: 'Умный помощник с правилами', items: ['support', 'voice', 'aiscale', 'agent', 'p-router'] }
  ];
  const ROLES = [
    { id: 'sa', name: 'Системный аналитик', skills: ['calc', 'db', 'tx', 'async', 'arch', 'data', 'rel'] },
    { id: 'be', name: 'Бэкенд-разработчик', skills: ['scale', 'cache', 'db', 'tx', 'async', 'rel', 'arch'] },
    { id: 'sre', name: 'DevOps / SRE', skills: ['calc', 'scale', 'rel', 'ops', 'cloud', 'cache'] },
    { id: 'de', name: 'Дата-инженер', skills: ['data', 'db', 'async', 'cloud', 'calc'] },
    { id: 'arc', name: 'Архитектор', skills: SK.map(s => s.id) }
  ];

  /* ---------- прогресс ---------- */
  const SHORT = { 'Практикум паттернов': 'Практикум', 'Настройки на пальцах': 'Настройка', 'Найди и перестрой': 'Инцидент', 'Архитектура из сервисов': 'Архитектура', 'Эксплуатация и инструменты': 'Эксплуатация', 'Данные: от события до дашборда': 'Данные', 'Внутри сервиса': 'Внутри сервиса', 'Облако': 'Облако' };
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
    const all = [].concat(SD.LEVELS, SD.PRACTICE || [], SD.FIXES || [], SD.INNER || [], SD.KNOBS || [], SD.ARCHL || [], SD.OPSL || [], SD.DATAL || [], SD.CLOUDL || []);
    all.forEach(L => { const t = SD.learn.tries(L.id); if (t.length && !t.some(x => x.ok) && !((A.progress[L.id] || {}).stars)) out.push({ L, n: t.length }); });
    return out.slice(0, 6);
  }

  /* ---------- окно ---------- */
  let cur = null;
  function render() {
    const role = ROLES.find(r => r.id === (U.role || 'sa')) || ROLES[0];
    const ss = role.skills.map(id => skillState(SK.find(s => s.id === id)));
    const total = ss.length ? Math.round(ss.reduce((a, x) => a + x.frac, 0) / ss.length * 100) : 0;
    const weakest = ss.filter(x => x.next).sort((a, b) => a.frac - b.frac)[0];
    cur = {};
    let h = `<div class="pt-roles seg">${ROLES.map(r => `<button type="button" data-ptrole="${r.id}" aria-selected="${r.id === role.id}">${esc(r.name)}</button>`).join('')}</div>`;
    h += `<div class="pt-top"><div class="pt-ring" style="--p:${total}"><b>${total}%</b><small>роль</small></div><div class="pt-sum"><b>${esc(role.name)}</b><span>Навыков освоено: ${ss.filter(x => x.frac >= 0.8).length} из ${ss.length}. Навык закрывают уровни и лаборатории — пройденный уровень считается целиком, лаборатория — когда сделана хотя бы половина заданий.</span>`;
    if (weakest && weakest.next) { cur.w = weakest.next; h += `<button type="button" class="btn primary" data-ptgo="w">Следующий шаг: ${esc(weakest.next.title)} <small>· ${esc(weakest.s.name.toLowerCase())}</small></button>`; }
    h += '</div></div><div class="pt-grid">';
    ss.forEach((x, i) => {
      const lvl = x.frac >= 0.8 ? 'ok' : x.frac > 0 ? 'mid' : '';
      h += `<section class="pt-sk ${lvl}"><div class="pt-h"><b>${esc(x.s.name)}</b><span>${x.done} / ${x.items.length}</span></div><small class="pt-an">${esc(x.s.an)}</small><div class="pt-bar"><i style="width:${Math.round(x.frac * 100)}%"></i></div><ul>`;
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
        const r = e.target.closest('[data-ptrole]'); if (r) { U.role = r.dataset.ptrole; save(); render(); return; }
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
  SD.path = { mount, open, SKILLS: SK, ROLES };
})();
