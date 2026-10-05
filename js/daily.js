/* Событие дня и коллекция паттернов.
   Событие дня: каждый день эталон одного из уровней попадает под испытание — распродажа, вирусный пост,
   массовый импорт, урезанный бюджет, чёрная пятница. Пару «уровень + событие» выбираем по дате и проверяем
   симулятором: эталон должен сломаться, а правка — найтись. Серия дней подряд.
   Коллекция: паттерны, которые ты применил на пройденных уровнях. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const EV = [
    { id: 'sale', title: 'вечерняя распродажа', chip: 'пик ×2,5', t: { all: 2.5 }, cost: 2.9,
      story: 'Вечером распродажа: пользователей в 2,5 раза больше обычного. Бюджет на вечер подняли почти втрое.',
      hint: 'Нагрузка выросла равномерно: найди, кто первым упирается в потолок. Часто это не сервис, а база за ним — сервис просто ждёт её.' },
    { id: 'viral', title: 'пост завирусился', chip: 'чтения ×4', t: { read: 4, static: 4, feed: 4, search: 4 }, cost: 3,
      story: 'Про ваш сервис написали блогеры: читают в 4 раза больше, пишут как обычно. Бюджет — ×3.',
      hint: 'Растут только чтения: им помогают кэш, реплики базы и больше экземпляров на пути чтения.' },
    { id: 'import', title: 'массовый импорт', chip: 'записи ×4', t: { write: 4, upload: 4 }, cost: 2.5,
      story: 'Крупный клиент заливает каталог: записей в 4 раза больше. Бюджет — ×2,5.',
      hint: 'Записи не кэшируются: их держат primary базы (шарды), брокер (партиции) и обработчики.' },
    { id: 'cut', title: 'урезали бюджет', chip: 'бюджет −30 %', t: {}, cost: 0.7,
      story: 'Финансовый директор урезал бюджет на 30 %. Нагрузка та же.',
      hint: 'Ищи узлы с низкой загрузкой: лишние экземпляры стоят денег, но не работают.' },
    { id: 'black', title: 'чёрная пятница', chip: 'пик ×4', t: { all: 4 }, cost: 4.6,
      story: 'Чёрная пятница: пользователей в 4 раза больше. Бюджет — ×4,6.',
      hint: 'Ищи самое узкое место, расширяй его и проверяй снова: после него упрётся следующее.' }
  ];
  const KEY = 'amp-stroyka-daily-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  U.done = U.done || {}; U.coll = U.coll || {};
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* ---------- уровень события ---------- */
  function derive(L, e, key) {
    const tr = {}; Object.entries(L.traffic).forEach(([k, v]) => { tr[k] = k === 'bot' ? v : v * (e.t[k] || e.t.all || 1); });
    return Object.assign({}, L, {
      id: 'daily-' + key, daily: { key, base: L.id, baseTitle: L.title, ev: e.id },
      title: 'Событие дня: ' + e.title,
      story: `${e.story} На площадке — эталон уровня «${L.title}». Под таким испытанием он ломается: перестрой, чтобы цели снова стали зелёными.`,
      chips: [e.chip].concat(L.chips || []).slice(0, 4),
      traffic: tr, decisions: [], stretch: undefined,
      goals: (L.goals || []).map(g => g.t === 'cost' ? Object.assign({}, g, { max: Math.round(g.max * e.cost) }) : g),
      hints: [e.hint].concat(L.hints || []).slice(0, 3),
      start: L.solution
    });
  }
  const graphOf = (L, spec) => { const o = SD.walk.orderOf(L, spec); return SD.walk.build(L, spec, o, o.length); };
  const every = (L, g) => { const res = SD.sim.run(L, g, { mul: 1 }); return SD.evalGoals(L, g, res, SD.sim.chaos(L, g), SD.sim.analyze(L, g, res)); };
  /* правка «как у прораба»: по одной красной цели, пока все не зелёные */
  function solve(L, g0) {
    const g = JSON.parse(JSON.stringify(g0)), steps = [];
    for (let it = 0; it < 8; it++) {
      const gs = every(L, g), bad = gs.findIndex(x => !x.ok);
      if (bad < 0) return { g, steps };
      const w = SD.learn.analyze(L, g, bad); if (!w || !w.fix) return null;
      w.fix.forEach(c => { const n = g.nodes.find(x => x.id === c.id); n.props[c.key] = c.to; steps.push(c); });
    }
    return null;
  }
  function specOf(L, g, steps) {
    const pre = new Set((L.preset || []).map(p => p[0]));
    const nm = id => { const n = g.nodes.find(x => x.id === id); return n ? (n.label || SD.TYPES[n.type].name) : id; };
    const seen = {}; steps.forEach(c => { const k = c.id + '|' + c.key; seen[k] = seen[k] ? Object.assign(seen[k], { to: c.to }) : Object.assign({}, c); });
    return {
      nodes: g.nodes.filter(n => !pre.has(n.id)).map(n => [n.id, n.type, n.x, n.y, n.props, n.label]),
      edges: g.edges.map(e => [e.from, e.to, e.props]),
      note: 'Эталон события: ' + Object.values(seen).map(c => `«${nm(c.id)}» ${c.key === 'count' ? '' : (c.label || c.key).toLowerCase() + ' '}${c.from} → ${c.to}`).join(', ') + '.'
    };
  }
  let cache = { key: '', L: null };
  function build(key, lv, ev) {
    const L = SD.LEVELS.find(x => x.id === lv), e = EV.find(x => x.id === ev); if (!L || !e || !L.solution) return null;
    const D = derive(L, e, key), g = graphOf(D, L.solution);
    if (every(D, g).every(x => x.ok)) return null;
    const s = solve(D, g); if (!s) return null;
    D.solution = specOf(D, s.g, s.steps);
    /* звезда за экономию — уложиться в цену найденной правки */
    D.stretch = { cost: Math.ceil(SD.sim.run(D, s.g, { mul: 1 }).cost / 10) * 10 };
    return D;
  }
  function today() {
    const key = dayKey();
    if (cache.key === key && cache.L) return cache.L;
    let D = null;
    if (U.pick && U.pick.key === key) D = build(key, U.pick.lv, U.pick.ev);
    if (!D) {
      let prog = {};
      try { prog = (SD.app && SD.app.A && SD.app.A.progress) || JSON.parse(localStorage.getItem('amp-stroyploshchadka-v1') || '{}').progress || {}; } catch (e) { prog = {}; }
      const r = rng(hash(key)), pool = SD.LEVELS.filter((L, i) => i > 0 && L.solution);
      const passed = shuffle(pool.filter(L => prog[L.id]), r), rest = shuffle(pool.filter(L => !prog[L.id]).slice(0, 12), r);
      let tries = 0;
      for (const L of passed.concat(rest)) {
        for (const e of shuffle(EV, r)) { if (++tries > 40) break; D = build(key, L.id, e.id); if (D) { U.pick = { key, lv: L.id, ev: e.id }; save(); break; } }
        if (D || tries > 40) break;
      }
    }
    cache = { key, L: D };
    return D;
  }
  function streak() {
    let n = 0; const d = new Date();
    if (!U.done[dayKey(d)]) d.setDate(d.getDate() - 1);
    while (U.done[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function open() {
    const D = today();
    if (!D) { SD.app.toast('Сегодня событие не нашлось — загляни завтра.'); return; }
    document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
    SD.app.loadLevel(D);
  }

  /* ---------- коллекция паттернов ---------- */
  const pname = id => ((SD.PATTERNS || []).find(p => p.id === id) || {}).name || id;
  function collect(A) {
    const L = A.level; if (L.sandbox || L.interview || (SD.walk && SD.walk.active())) return [];
    /* эталон, показанный целиком, — не твоя заслуга */
    const sigT = g => JSON.stringify(g.nodes.map(n => [n.id, n.type, n.props]).sort()) + JSON.stringify(g.edges.map(e => e.from + '>' + e.to).sort());
    if (L.solution) { try { if (sigT(graphOf(L, L.solution)) === sigT(A.graph)) return []; } catch (e) { /* сравнить не вышло — считаем своей */ } }
    let ids = [];
    try { ids = SD.archLens ? SD.archLens.detect(A.graph, A.res1).applied.map(p => p.id) : []; } catch (e) { ids = []; }
    if (L.pattern) ids.push(L.pattern);
    const fresh = [...new Set(ids)].filter(id => (SD.PATTERNS || []).some(p => p.id === id) && !U.coll[id]);
    fresh.forEach(id => { U.coll[id] = { lv: L.daily ? L.daily.base : L.id, d: dayKey() }; });
    if (fresh.length) save();
    return fresh;
  }
  function backfill() {
    if (U.filled) return;
    let prog = {};
    try { prog = JSON.parse(localStorage.getItem('amp-stroyploshchadka-v1') || '{}').progress || {}; } catch (e) { prog = {}; }
    (SD.PRACTICE || []).forEach(L => { if (prog[L.id] && L.pattern && !U.coll[L.pattern]) U.coll[L.pattern] = { lv: L.id, d: '' }; });
    U.filled = 1; save();
  }

  /* ---------- блоки на карте уровней ---------- */
  function mapHtml(A) {
    let h = '<div class="dly-row">';
    const D = today(), key = dayKey(), st = streak();
    if (D) {
      const e = EV.find(x => x.id === D.daily.ev), done = !!U.done[key];
      h += `<button type="button" class="lvl dly-card ${done ? 'done' : ''}" data-level="${D.id}"><span class="n">СОБЫТИЕ ДНЯ<span>${done ? '✓ выдержано' : esc(e.chip)}</span></span><b>${esc(e.title[0].toUpperCase() + e.title.slice(1))}</b><small>Эталон уровня «${esc(D.daily.baseTitle)}» под испытанием. ${st ? `Серия: ${st} ${st === 1 ? 'день' : st < 5 ? 'дня' : 'дней'} подряд.` : 'Выдержи — начнётся серия.'}</small></button>`;
    }
    const all = (SD.PATTERNS || []), got = all.filter(p => U.coll[p.id]);
    h += `<div class="dly-coll"><div class="dly-ch"><b>Коллекция паттернов</b><span>${got.length} из ${all.length}</span></div><div class="dly-bar"><i style="width:${all.length ? Math.round(got.length / all.length * 100) : 0}%"></i></div>`;
    h += got.length ? `<div class="dly-pats">${got.slice(-14).reverse().map(p => `<button type="button" class="chip dly-pat" data-openpat2="${p.id}" title="${esc(p.en || '')}">${esc(p.name)}</button>`).join('')}${got.length > 14 ? `<span class="dly-more">и ещё ${got.length - 14}</span>` : ''}</div>`
      : '<p class="dly-empty">Пройди уровень — паттерны, которые ты применил, попадут сюда.</p>';
    return h + '</div></div>';
  }

  /* ---------- слежение: событие выдержано, новые паттерны ---------- */
  let lastSig = '';
  function watch() {
    const A = SD.app && SD.app.A; if (!A || !A.goals || !A.goals.length) return;
    if (!A.goals.every(g => g.ok)) return;
    const sig = A.level.id + JSON.stringify(A.graph.nodes.map(n => [n.type, n.props])) + A.graph.edges.length;
    if (sig === lastSig) return; lastSig = sig;
    if (A.level.daily && !U.done[A.level.daily.key]) {
      U.done[A.level.daily.key] = 1; save();
      const n = streak();
      SD.app.toast(`Событие дня выдержано! Серия: ${n} ${n === 1 ? 'день' : n < 5 ? 'дня' : 'дней'} подряд. Завтра будет новое.`);
    }
    const fresh = collect(A);
    if (fresh.length) setTimeout(() => SD.app.toast(`В коллекции ${fresh.length === 1 ? 'новый паттерн' : 'новые паттерны'}: ${fresh.map(pname).join(', ')}.`), A.level.daily ? 3500 : 1200);
  }

  function mount() {
    backfill();
    setTimeout(() => {
      const hub = $('navHub'), menu = hub && hub.parentNode;
      if (menu && !$('navDaily')) {
        const b = document.createElement('button'); b.type = 'button'; b.id = 'navDaily'; b.className = hub.className;
        b.innerHTML = 'Событие дня' + (U.done[dayKey()] ? '' : ' <span class="dly-dot" aria-label="не пройдено"></span>');
        b.addEventListener('click', open);
        menu.insertBefore(b, hub);
      }
    }, 0);
    document.addEventListener('click', e => { const p = e.target.closest('[data-openpat2]'); if (p) { document.querySelectorAll('.modal').forEach(m => { m.hidden = true; }); SD.patterns.open(p.dataset.openpat2); } });
    setInterval(watch, 700);
  }

  /* уровень события находится по id — так он переживает перезагрузку страницы */
  const baseById = SD.levelById, baseLabel = SD.levelLabel;
  SD.levelById = id => (typeof id === 'string' && id.startsWith('daily-')) ? (id === 'daily-' + dayKey() ? today() : null) : baseById(id);
  SD.levelLabel = L => L.daily ? 'Событие дня' : baseLabel(L);

  SD.daily = { mount, open, today, mapHtml, streak, EV, collection: () => Object.assign({}, U.coll) };
})();
