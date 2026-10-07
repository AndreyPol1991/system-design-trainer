/* Разминка дня: пять минут повторения пройденного — по науке интервальных повторений.
   Как зарядка: пять минут, но каждый день. Карточки берутся только из пройденных уровней, а верный ответ всегда
   проверяемый: прогон симулятора на эталоне (как в js/daily.js и js/learn.js) или данные самого уровня.
   Типы карточек:
     ld — прогноз: эталон уровня под нагрузкой ×1,5 / ×2 / ×3 — выдержит, просядет или ляжет (SD.sim.run);
     fl — прогноз: упал один экземпляр узла — устоит ли система (SD.sim.chaos, порог 99 %, как у хаос-теста);
     bn — узкое место: какой узел первым упрётся в потолок при росте нагрузки (SD.sim.run, порог ищем делением пополам);
     pt — какой паттерн нужен: задача из карточки паттерна (SD.PATTERNS[].problem) → его название; паттерн взят из уровня
          (L.pattern) или распознан на эталоне основного уровня (SD.archLens.detect);
     fg — верно ли утверждение: пара «предмет ↔ термин» из «На пальцах» уровня (L.fingers.map), иногда с подменённым термином.
   Расписание — лесенка Лейтнера: вспомнил — карточка вернётся через 1 → 3 → 7 → 16 → 35 дней, забыл — снова завтра.
   В разминке 5–7 карточек: сначала те, что пора повторить, потом новые; уровни и типы вперемешку.
   Серия дней мягкая: день засчитан за 3 карточки или 1 пройденный уровень, одна «заморозка» в неделю закрывает пропуск.
   Хранение — localStorage 'amp-stroyka-warmup-v1'. Вход: «Путь ▾ → Разминка» (место в меню задаёт js/ux.js),
   Ctrl+K (SD.cmdExtra), строка «К повторению сегодня» в «Моём пути» (SD.warmup.pathHtml в js/path.js).
   Стили — warmup.css (классы .wu-*, только переменные :root). Подключение: <script src="js/warmup.js"> перед js/app.js;
   модуль монтируется сам, когда приложение готово. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KEY = 'amp-stroyka-warmup-v1';
  const STEPS = [1, 3, 7, 16, 35];
  const MIN = 5, MAX = 7;
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { U = {}; }
  const norm = () => { U.v = 1; U.cards = U.cards || {}; U.days = U.days || {}; };
  norm();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища — до перезагрузки */ } };
  const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
  const cardsW = n => n + ' ' + plural(n, 'карточка', 'карточки', 'карточек');
  const daysW = n => n + ' ' + plural(n, 'день', 'дня', 'дней');
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  /* ---------- дни: ключ YYYYMMDD по местному времени ---------- */
  let shift = 0; /* только для проверок: «сегодня» на N дней вперёд */
  const dayKey = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const parse = k => new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), 12);
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return dayKey(d); };
  const today = () => addDays(dayKey(new Date()), shift);
  const between = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const weekOf = k => addDays(k, -((parse(k).getDay() + 6) % 7));
  const whenW = n => n <= 0 ? 'сегодня' : n === 1 ? 'завтра' : n === 2 ? 'послезавтра' : `через ${daysW(n)}`;
  const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  /* ---------- уровни и схемы ---------- */
  const LISTS = () => [SD.LEVELS, SD.PRACTICE, SD.FIXES, SD.INNER, SD.KNOBS, SD.ARCHL, SD.OPSL, SD.DATAL, SD.CLOUDL, SD.SAASL];
  function allLevels() {
    const seen = new Set(), out = [];
    LISTS().forEach(l => (l || []).forEach(L => { if (L && L.id && !seen.has(L.id)) { seen.add(L.id); out.push(L); } }));
    return out;
  }
  const prog = () => (SD.app && SD.app.A && SD.app.A.progress) || {};
  const passed = () => { const p = prog(); return allLevels().filter(L => L.solution && !L.sandbox && !L.interview && ((p[L.id] || {}).stars || 0) > 0); };
  const lvById = id => allLevels().find(L => L.id === id) || null;
  /* граф эталона — так же, как его строит app.js */
  function graphOf(L, spec) {
    const nodes = [], edges = [];
    const add = ([id, type, x, y, props, label]) => {
      if (nodes.some(n => n.id === id)) return;
      nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props ? JSON.parse(JSON.stringify(props)) : {}), label: label || (type === 'external' && L.ext ? L.ext.name : undefined) });
    };
    (L.preset || []).forEach(add);
    if (spec) {
      spec.nodes.forEach(add);
      spec.edges.forEach(([a, b, p], i) => edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) }));
    }
    const g = { nodes, edges };
    if (SD.inner) g.nodes.forEach(n => SD.inner.syncFlags(n, g));
    return g;
  }
  const T = t => (SD.TYPES && SD.TYPES[t]) || {};
  const nm = n => n ? (n.label || T(n.type).name || n.type) : '';
  const isOps = n => !!T(n.type).ops;
  const countOf = n => { const p = (T(n.type).props || []).find(x => x.key === 'count' && x.type === 'range'); return p ? (n.props.count || 1) : 0; };
  const pct = v => SD.fmt ? SD.fmt.pct(v) : Math.round(v * 100) + ' %';
  const ms = v => SD.fmt ? SD.fmt.ms(v) : Math.round(v) + ' мс';
  const mulW = m => '×' + (Math.ceil(m * 100) / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
  const timesW = m => 'в ' + String(m).replace('.', ',') + ' раза';
  const kindOf = L => { const i = (SD.LEVELS || []).indexOf(L); return i >= 0 ? `Уровень ${i + 1}` : (SD.levelLabel ? SD.levelLabel(L) : 'Уровень'); };
  const topicOf = L => { const s = SD.path && SD.path.SKILLS ? SD.path.SKILLS.find(x => x.items.includes(L.id)) : null; return s ? s.name : ''; };

  /* ---------- карточки ---------- */
  const TAG = { ld: 'Прогноз: нагрузка', fl: 'Прогноз: отказ', bn: 'Узкое место', pt: 'Какой паттерн', fg: 'Верно ли' };
  const MULS = [1.5, 2, 3];
  /* «Прогноз»: эталон под нагрузкой ×N — ответ даёт прогон симулятора */
  function bLoad(L, dk) {
    const g = graphOf(L, L.solution), m = MULS[hash(dk + '|ld|' + L.id) % MULS.length];
    const r = SD.sim.run(L, g, { mul: m }), s = r.total.success;
    if (!(r.total.rps > 0)) return null;
    const cat = s >= 0.99 ? 0 : s >= 0.5 ? 1 : 2;
    const top = g.nodes.filter(n => n.type !== 'client' && !isOps(n) && r.nodes[n.id]).sort((a, b) => (r.nodes[b.id].util || 0) - (r.nodes[a.id].util || 0))[0];
    const u = top ? r.nodes[top.id].util || 0 : 0;
    let fb = `Проверил симулятором на эталоне: при нагрузке ${mulW(m)} успешно ${pct(s)}, среднее время ответа ${ms(r.total.lat)}.`;
    if (top) fb += u > 1 ? ` Первым в потолок упирается «${esc(nm(top))}»: загрузка ${Math.round(u * 100)} %.` : ` Самый загруженный узел — «${esc(nm(top))}»: ${Math.round(u * 100)} %, запас ещё есть.`;
    fb += cat === 0 ? ' Запаса эталона хватило.' : ` Эталон собран под нагрузку уровня, а не под ${mulW(m)}: перед ростом расширяют самое узкое место и проверяют снова.`;
    return {
      q: `Нагрузка на эталон уровня «${esc(L.title)}» выросла ${timesW(m)}. Что будет с запросами?`, g, pre: {}, post: top && u > 1 ? { [top.id]: 'wu-hot' } : {},
      opts: [['Выдержит: потерь почти нет — успешно не меньше 99 %', 0], ['Просядет: теряется заметная часть — успешно от 50 до 99 %', 1], ['Ляжет: теряется больше половины запросов', 2]].map(([t, c]) => ({ t, ok: c === cat })),
      fb
    };
  }
  /* «Прогноз»: упал один экземпляр узла — ответ даёт хаос-тест симулятора */
  function bFail(L, dk) {
    const g = graphOf(L, L.solution), ch = SD.sim.chaos(L, g); if (!ch.length) return null;
    const c = ch[hash(dk + '|fl|' + L.id) % ch.length], n = g.nodes.find(x => x.id === c.id); if (!n) return null;
    const cnt = countOf(n);
    let fb = `Проверил симулятором: без одного экземпляра «${esc(nm(n))}» успешно ${pct(c.success)}.`;
    if (!c.ok && cnt === 1) fb += ' Экземпляр был один, запасного нет — это единая точка отказа. Нужен запасной: второй экземпляр за балансировщиком, реплика с переключением или очередь, которая подождёт.';
    else if (!c.ok && cnt > 1) fb += ` Оставшихся экземпляров (${cnt - 1}) не хватило, чтобы удержать 99 %.`;
    else if (c.ok && cnt > 1) fb += ` Оставшиеся ${cnt - 1} подхватили нагрузку.`;
    else if (c.ok) fb += ' Система пережила его падение.';
    else fb += ' Пережить такое падение помогают запасной экземпляр, реплика с переключением или очередь, которая подождёт.';
    return {
      q: `На эталоне уровня «${esc(L.title)}» упал один экземпляр «${esc(nm(n))}»${cnt > 1 ? ` (всего их ${cnt})` : ''}. Что будет с запросами?`, g, pre: { [n.id]: 'wu-down' }, post: { [n.id]: 'wu-down' },
      opts: [{ t: 'Устоит: потеряется меньше 1 % запросов', ok: !!c.ok }, { t: 'Пострадает: потеряется больше 1 % запросов', ok: !c.ok }],
      fb
    };
  }
  /* «Узкое место»: нагрузка растёт — кто первым переходит 100 % загрузки; порог ищем делением пополам */
  function bBottle(L, dk) {
    const g = graphOf(L, L.solution), cand = g.nodes.filter(n => n.type !== 'client' && !isOps(n));
    const at = m => { const r = SD.sim.run(L, g, { mul: m }); return { r, hot: cand.filter(n => r.nodes[n.id] && r.nodes[n.id].util > 1) }; };
    if (at(1).hot.length) return null; /* узел перегружен уже на нагрузке уровня — так задумано эталоном, вопрос был бы нечестным */
    let lo = 1, hi = 0, H = null;
    for (const m of [1.25, 1.5, 2, 2.5, 3, 4, 6, 8, 12]) { const x = at(m); if (x.hot.length) { hi = m; H = x; break; } lo = m; }
    if (!H) return null;
    for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2, x = at(mid); if (x.hot.length) { hi = mid; H = x; } else lo = mid; }
    if (H.hot.length !== 1) return null; /* двое упираются одновременно — ответ неоднозначен */
    const ans = H.hot[0], cnt = {};
    cand.forEach(n => { cnt[nm(n)] = (cnt[nm(n)] || 0) + 1; });
    if (cnt[nm(ans)] > 1) return null;
    const ut = n => (H.r.nodes[n.id] || {}).util || 0;
    const others = cand.filter(n => n !== ans && cnt[nm(n)] === 1 && H.r.nodes[n.id]).sort((a, b) => ut(b) - ut(a)).slice(0, 2);
    if (!others.length) return null;
    const opts = [ans].concat(others).map(n => ({ t: '«' + nm(n) + '»', ok: n === ans })).sort((a, b) => hash(L.id + a.t) - hash(L.id + b.t));
    return {
      q: `Нагрузка на эталон уровня «${esc(L.title)}» растёт. Какой узел первым упрётся в потолок?`, g, pre: {}, post: { [ans.id]: 'wu-hot' }, opts,
      fb: `Проверил симулятором: при нагрузке ${mulW(hi)} загрузка «${esc(nm(ans))}» переходит 100 %, а ${others.map(n => `«${esc(nm(n))}» — ${Math.round(ut(n) * 100)} %`).join(', ')}. Такой узел и расширяют первым, а потом проверяют снова: упрётся следующий.`
    };
  }
  /* «Какой паттерн»: задача — из карточки паттерна, отвлекающие — из других категорий и не «соседи» по смыслу */
  const SYS = new Set(['data', 'integration', 'architecture', 'resilience', 'delivery', 'ai']);
  const NEAR = [['loadbalancing', 'autoscaling'], ['cacheaside', 'readreplica'], ['cacheaside', 'cdn-p'], ['readreplica', 'sharding'], ['readreplica', 'cqrs'], ['queue-cc', 'autoscaling'],
    ['circuitbreaker', 'retry'], ['circuitbreaker', 'bulkhead'], ['circuitbreaker', 'ratelimit'], ['outbox', 'saga-p'], ['outbox', 'inbox'], ['inbox', 'idempotency'], ['eda', 'pubsub'],
    ['microservices', 'dbpersvc'], ['microservices', 'modmono'], ['apigw', 'bff'], ['observability', 'correlation'], ['partitioning', 'sharding'], ['healthcheck', 'loadbalancing'], ['layered', 'hexagonal']];
  const near = (a, b) => NEAR.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const pat = id => (SD.PATTERNS || []).find(p => p.id === id) || null;
  /* задача не должна подсказывать ответ: ни название целиком, ни основа первого слова («индексы» в задаче про индексы) */
  const leaks = p => {
    const t = String(p.problem || '').toLowerCase();
    if ([p.name, p.en].filter(Boolean).some(w => t.includes(String(w).toLowerCase()))) return true;
    const w0 = String(p.name).toLowerCase().split(/[^a-zа-яё]+/i).find(w => w.length >= 3);
    return !!w0 && t.includes(w0.slice(0, 5));
  };
  const patOk = p => !!(p && p.kind === 'pattern' && SYS.has(p.cat) && p.problem && p.name && !leaks(p));
  function bPat(pid, L, dk) {
    const p = pat(pid); if (!patOk(p)) return null;
    const all = (SD.PATTERNS || []).filter(x => patOk(x) && x.id !== pid && x.cat !== p.cat && !near(x.id, pid) && x.name.toLowerCase() !== p.name.toLowerCase());
    const mine = new Set(patEntries().map(e => e.pid));
    const ord = (list, salt) => list.slice().sort((a, b) => hash(dk + salt + a.id) - hash(dk + salt + b.id));
    /* один отвлекающий — из тех, что ты уже видел на других уровнях, второй — любой из других категорий */
    const ds = [], names = new Set([p.name.toLowerCase()]);
    const put = x => { if (x && ds.length < 2 && !names.has(x.name.toLowerCase()) && !ds.some(d => near(d.id, x.id))) { names.add(x.name.toLowerCase()); ds.push(x); } };
    put(ord(all.filter(x => mine.has(x.id)), 'm')[0]);
    ord(all, 'r').forEach(put);
    if (ds.length < 2) return null;
    const opts = [p].concat(ds).map(x => ({ t: x.name, ok: x.id === pid })).sort((a, b) => hash(dk + pid + a.t) - hash(dk + pid + b.t));
    return {
      q: `Задача: «${esc(p.problem)}» Какой паттерн здесь нужен?`, g: null, opts,
      fb: `«${esc(p.name)}»${p.en && p.en !== p.name ? ` (${esc(p.en)})` : ''}: ${esc(p.solution || '')}`,
      after: `Ты применял его на уровне «${esc(L.title)}».`
    };
  }
  /* «Верно ли»: пара «предмет ↔ термин» из «На пальцах»; в половине случаев термин подменён другим из той же карточки */
  function bFing(L, dk) {
    const F = L.fingers; if (!F || !Array.isArray(F.map)) return null;
    const map = F.map.filter(m => Array.isArray(m) && m[0] && m[1]); if (map.length < 2) return null;
    const low = s => String(s).toLowerCase();
    const h = hash(dk + '|fg|' + L.id), i = h % map.length;
    let truth = ((h >>> 9) & 1) === 0;
    const alt = map.map((m, j) => j).filter(j => j !== i && !low(map[j][1]).includes(low(map[i][1])) && !low(map[i][1]).includes(low(map[j][1])));
    if (!truth && !alt.length) truth = true;
    const j = truth ? i : alt[(h >>> 4) % alt.length];
    const pair = `«${esc(map[i][0])}» ↔ «${esc(map[i][1])}»${map[i][2] ? `: ${esc(map[i][2])}` : ''}.`;
    let pic = '';
    try { const s = typeof F.picture === 'function' ? F.picture(L) : (F.picture || ''); if (s) pic = `<details class="wu-pic"><summary>Картинка из «На пальцах»</summary><div class="wu-pic-in">${s}</div></details>`; } catch (e) { pic = ''; }
    return {
      q: `В «На пальцах» уровня «${esc(L.title)}»: «${esc(map[i][0])}» — это «${esc(map[j][1])}». Верно?`, g: null,
      opts: [{ t: 'Верно', ok: truth }, { t: 'Неверно', ok: !truth }],
      fb: (truth ? 'Так и есть: ' : `В этой аналогии «${esc(map[j][1])}» — это «${esc(map[j][0])}», а `) + pair + (F.thesis ? ` Суть темы: ${esc(F.thesis)}` : ''),
      pic
    };
  }

  /* ---------- колода: что можно повторять ---------- */
  const detMemo = {};
  function detected(L) {
    if (detMemo[L.id]) return detMemo[L.id];
    let ids = [];
    try { if (SD.archLens && SD.archLens.detect) { const g = graphOf(L, L.solution); ids = SD.archLens.detect(g, SD.sim.run(L, g, { mul: 1 })).applied.map(x => x.id); } } catch (e) { ids = []; }
    return (detMemo[L.id] = [...new Set(ids)]);
  }
  function patEntries() {
    const out = {}, main = SD.LEVELS || [];
    passed().forEach(L => {
      const ps = L.pattern ? [L.pattern] : main.includes(L) ? detected(L) : [];
      ps.forEach(pid => { if (!out[pid] && patOk(pat(pid))) out[pid] = { id: 'pt:' + pid, t: 'pt', lv: L.id, pid }; });
    });
    return Object.values(out);
  }
  const BAD = new Set();
  function pool() {
    const out = [];
    passed().forEach(L => {
      ['ld', 'fl', 'bn'].forEach(t => out.push({ id: t + ':' + L.id, t, lv: L.id }));
      if (L.fingers && Array.isArray(L.fingers.map) && L.fingers.map.length >= 2) out.push({ id: 'fg:' + L.id, t: 'fg', lv: L.id });
    });
    return out.concat(patEntries()).filter(c => !BAD.has(c.id));
  }
  const memo = new Map();
  function build(e, dk) {
    const k = e.id + '|' + dk;
    if (memo.has(k)) return memo.get(k);
    const L = lvById(e.lv);
    let c = null;
    try {
      if (L && L.solution) c = e.t === 'ld' ? bLoad(L, dk) : e.t === 'fl' ? bFail(L, dk) : e.t === 'bn' ? bBottle(L, dk) : e.t === 'pt' ? bPat(e.pid, L, dk) : e.t === 'fg' ? bFing(L, dk) : null;
    } catch (err) { c = null; }
    if (c) Object.assign(c, { id: e.id, t: e.t, lv: e.lv, L, topic: topicOf(L), kind: kindOf(L) });
    else BAD.add(e.id);
    memo.set(k, c);
    return c;
  }

  /* ---------- план на день: сначала «пора повторить», потом новые; вперемешку ---------- */
  function take(list, chosen) {
    const lvs = new Set(chosen.map(c => c.lv)), ts = {};
    chosen.forEach(c => { ts[c.t] = (ts[c.t] || 0) + 1; });
    let i = list.findIndex(c => !lvs.has(c.lv) && (ts[c.t] || 0) < 2);
    if (i < 0) i = list.findIndex(c => !lvs.has(c.lv));
    if (i < 0) i = list.findIndex(c => (ts[c.t] || 0) < 2);
    if (i < 0) i = 0;
    return list.splice(i, 1)[0];
  }
  function interleave(list) {
    const rest = list.slice(), out = [];
    while (rest.length) {
      const p = out[out.length - 1];
      let i = rest.findIndex(c => !p || (c.lv !== p.lv && c.t !== p.t));
      if (i < 0) i = rest.findIndex(c => c.lv !== p.lv);
      if (i < 0) i = 0;
      out.push(rest.splice(i, 1)[0]);
    }
    return out;
  }
  function planIds() {
    const k = today();
    if (U.plan && U.plan.k === k && U.plan.ids.length) return U.plan.ids;
    const P = pool();
    if (!P.length) { U.plan = { k, ids: [] }; return []; }
    const due = P.filter(c => U.cards[c.id] && U.cards[c.id].due <= k).sort((a, b) => U.cards[a.id].due.localeCompare(U.cards[b.id].due) || hash(k + a.id) - hash(k + b.id));
    const fresh = P.filter(c => !U.cards[c.id]).sort((a, b) => hash(k + a.id) - hash(k + b.id));
    const pick = [];
    const grab = list => { while (list.length) { const c = take(list, pick); if (build(c, k)) return c; } return null; };
    while (pick.length < MAX && due.length) { const c = grab(due); if (c) pick.push(c); }
    const target = Math.max(MIN, pick.length);
    while (pick.length < target && fresh.length) { const c = grab(fresh); if (c) pick.push(c); }
    U.plan = { k, ids: interleave(pick).map(c => c.id) };
    save();
    return U.plan.ids;
  }
  const entryOf = id => pool().find(c => c.id === id) || null;
  function remaining() { const k = today(); return planIds().filter(id => !(U.cards[id] && U.cards[id].last === k)); }
  function dueLater() {
    const k = today(), ds = Object.values(U.cards).map(c => c.due).filter(d => d > k).sort();
    if (!ds.length) return null;
    return { k: ds[0], n: ds.filter(d => d === ds[0]).length, in: between(k, ds[0]) };
  }
  function status() {
    const none = !passed().length;
    if (none) return { none: true, left: 0, plan: 0, next: null };
    const ids = planIds(), left = remaining().length;
    return { none: false, left, plan: ids.length, next: dueLater() };
  }

  /* ---------- оценка ответа и интервал ---------- */
  function grade(id, ok, lv, t) {
    const k = today(), c = U.cards[id] || { s: -1, n: 0, ok: 0, lapse: 0, first: k };
    c.n++; c.lv = lv; c.last = k;
    if (ok) { c.ok++; c.s = Math.min(c.s + 1, STEPS.length - 1); } else { c.lapse++; c.s = 0; }
    c.due = addDays(k, STEPS[c.s]);
    U.cards[id] = c;
    const d = U.days[k] = U.days[k] || { c: 0, ok: 0, l: 0 };
    d.c++; if (ok) d.ok++;
    if (!U.res || U.res.k !== k) U.res = { k, list: [] };
    U.res.list = U.res.list.filter(x => x.id !== id).concat([{ id, ok: !!ok, lv, t }]);
    /* дни старше 70 — не нужны даже для серии с заморозками */
    const old = addDays(k, -70);
    Object.keys(U.days).forEach(x => { if (x < old) delete U.days[x]; });
    save(); refresh();
    return c;
  }

  /* ---------- серия: мягкая, с одной заморозкой в неделю ---------- */
  const counted = k => { const d = U.days[k]; return !!d && (d.c >= 3 || d.l >= 1); };
  function streak() {
    const k0 = today(), first = Object.keys(U.days).sort()[0];
    let k = counted(k0) ? k0 : addDays(k0, -1), n = 0;
    const frozen = [], used = {};
    let pend = [];
    for (let i = 0; i < 400 && first && k >= first; i++) {
      if (counted(k)) { n++; frozen.push(...pend); pend = []; k = addDays(k, -1); continue; }
      const w = weekOf(k);
      if (!used[w]) { used[w] = 1; pend.push(k); k = addDays(k, -1); continue; }
      break;
    }
    const wk = weekOf(k0), d = U.days[k0] || { c: 0, l: 0 };
    return { n, frozen, todayDone: counted(k0), weekFree: !frozen.some(f => weekOf(f) === wk), today: { c: d.c || 0, l: d.l || 0 } };
  }
  function streakHtml() {
    const s = streak(), t = s.today;
    const fr = s.frozen.length ? `заморозка закрыла ${s.frozen.map(f => DOW[parse(f).getDay()] + ' ' + (+f.slice(6, 8))).join(', ')}` : '';
    let h = `<div class="wu-streak"><div class="wu-sn"><b>${s.n}</b><small>${plural(s.n, 'день', 'дня', 'дней')}<br>подряд</small></div><div class="wu-st">`;
    h += `<p>${s.todayDone ? '<b>Сегодня засчитан ✓</b>' : `<b>Сегодня:</b> карточек ${t.c} из 3${t.l ? `, уровней ${t.l}` : ''}`}. День засчитывается за 3 карточки или 1 пройденный уровень.</p>`;
    h += `<p class="wu-soft">Без давления: пропустил день — его закроет заморозка, одна в неделю. ${s.weekFree ? 'На этой неделе заморозка свободна.' : 'На этой неделе заморозка уже потрачена.'}${fr ? ' ' + esc(fr[0].toUpperCase() + fr.slice(1)) + '.' : ''}</p></div></div>`;
    return h;
  }

  /* ---------- уровни, пройденные сегодня, тоже засчитывают день ---------- */
  function watchLevels() {
    const p = prog(), ids = Object.keys(p).filter(id => ((p[id] || {}).stars || 0) > 0);
    if (!Array.isArray(U.seen)) { U.seen = ids; save(); return; }
    const fresh = ids.filter(id => !U.seen.includes(id));
    if (!fresh.length) return;
    const k = today(), d = U.days[k] = U.days[k] || { c: 0, ok: 0, l: 0 };
    d.l += fresh.length; U.seen = ids;
    /* план на сегодня был пуст (ничего не пройдено) — теперь появятся первые карточки */
    if (U.plan && !U.plan.ids.length) U.plan = null;
    save(); refresh();
  }

  /* ---------- окно ---------- */
  let V = { scr: 'start', list: [], i: 0, res: [], ans: null };
  const head = (eb, closeLbl) => `<div class="wu-head"><span class="eyebrow">${eb}</span><button type="button" class="btn ghost wu-x" data-wux="1">${closeLbl || 'Закрыть'}</button></div>`;
  /* картинка-схема «аналогия ↔ термин» */
  const MAP = [
    ['Пять минут зарядки утром', 'разминка: 5–7 карточек в день'],
    ['Упражнение', 'карточка: вопрос по пройденному уровню'],
    ['Получилось легко — это упражнение реже', 'вспомнил — карточка вернётся позже'],
    ['Не вышло — повторить завтра', 'забыл — карточка вернётся завтра'],
    ['Разные упражнения вперемешку', 'темы вперемешку: учишься узнавать задачу']
  ];
  function howHtml() {
    let h = `<div class="wu-map" aria-label="Аналогия и термины">${MAP.map(([a, b]) => `<div class="wu-mi"><span class="wu-ma">${esc(a)}</span><span class="wu-eq" aria-hidden="true">↔</span><span class="wu-mt">${esc(b)}</span></div>`).join('')}</div>`;
    h += `<div class="wu-ladder" aria-label="Интервалы повторения"><span class="wu-lk">вспомнил:</span>${STEPS.map((d, i) => `${i ? '<span class="wu-la" aria-hidden="true">→</span>' : ''}<span class="wu-step" style="--i:${i}">${d === 1 ? 'через день' : daysW(d)}</span>`).join('')}<span class="wu-back"><span aria-hidden="true">↺</span> забыл — снова завтра, лесенка с начала</span></div>`;
    h += `<p class="wu-lede"><b>Как работает интервальное повторение.</b> Каждый раз, когда достаёшь знание из памяти с усилием, оно закрепляется крепче, чем от перечитывания. Поэтому карточка возвращается тогда, когда почти забылась: вспомнил — промежуток растёт, забыл — начинаешь лесенку заново. Темы идут вперемешку: так тренируешь ещё и умение понять, какая задача перед тобой.</p>`;
    h += `<details class="wu-why"><summary>Откуда это</summary><p>В обзоре Dunlosky и соавторов (2013) из десяти техник учёбы «высокую полезность» получили только две: самопроверка и распределённая практика — повторение с интервалами. Перемешанные задачи на отложенном тесте дали 61 % против 38 % у задач, решённых блоками по одной теме (Rohrer, 2020). Правильные ответы здесь не выдуманы: прогнозы и узкие места проверяет симулятор на эталоне уровня, остальное взято из карточек уровня и паттерна.</p></details>`;
    return h;
  }
  function noneHtml() {
    const n = SD.path && SD.path.next ? SD.path.next() : null, it = n && n.item;
    let h = head('Разминка дня') + `<h2 id="wuTitle">Сначала — первое упражнение</h2>`;
    h += `<p class="wu-lede">Разминка — это повторение пройденного, а пройденного пока нет. Как с зарядкой: сначала разучивают упражнения, потом повторяют их по пять минут каждый день. Пройди первый уровень — и здесь появятся карточки по нему: прогноз «что будет, если…», узкое место на схеме, паттерн, аналогия.</p>`;
    h += `<div class="wu-acts wu-foot">${it ? `<button type="button" class="btn primary" data-wufirst="1">К первому шагу: ${esc(it.title)} →</button>` : ''}<button type="button" class="btn ghost" data-wux="1">Закрыть</button></div>`;
    return h;
  }
  function startHtml() {
    const ids = remaining(), P = pool(), es = ids.map(id => P.find(c => c.id === id)).filter(Boolean);
    const nNew = es.filter(c => !U.cards[c.id]).length, lvs = [...new Set(es.map(c => c.lv))];
    const topics = [...new Set(es.map(c => { const L = lvById(c.lv); return (L && topicOf(L)) || (L ? kindOf(L) : ''); }).filter(Boolean))];
    let h = head('Разминка дня') + `<h2 id="wuTitle">Пять минут на пройденное</h2>`;
    h += `<p class="wu-lede"><b>Как зарядка: пять минут, но каждый день.</b> Мышцы крепнут не от одной долгой тренировки раз в месяц, а от коротких и регулярных — с памятью так же. Сегодня ${cardsW(es.length)} из пройденного${nNew === es.length ? ', все новые' : nNew ? `, из них новых ${nNew}` : ''}: ${lvs.length > 1 ? `${lvs.length} ${plural(lvs.length, 'уровень', 'уровня', 'уровней')} вперемешку` : 'один уровень'}.</p>`;
    if (topics.length) h += `<div class="wu-topics">${topics.slice(0, 8).map(t => `<span class="wu-chip">${esc(t)}</span>`).join('')}</div>`;
    h += U.introSeen ? `<details class="wu-how"><summary>Как это работает</summary>${howHtml()}</details>` : howHtml();
    h += streakHtml();
    h += `<div class="wu-acts wu-foot"><button type="button" class="btn primary" data-wugo="1">Начать разминку · ${cardsW(es.length)}</button><button type="button" class="btn ghost" data-wux="1">Позже</button></div>`;
    return h;
  }
  function schemeHtml(g, marks) {
    marks = marks || {};
    const ns = g.nodes.filter(n => !isOps(n)).slice().sort((a, b) => a.x - b.x || a.y - b.y), cols = [];
    ns.forEach(n => { const c = cols[cols.length - 1]; if (c && n.x - c.x0 < 100) c.list.push(n); else cols.push({ x0: n.x, list: [n] }); });
    const chip = n => { const c = countOf(n), mk = marks[n.id] || ''; return `<span class="wu-nd${mk ? ' ' + mk : ''}">${SD.icon ? SD.icon(n.type) : ''}<span>${esc(nm(n))}${c > 1 ? ` <i>×${c}</i>` : ''}${mk === 'wu-down' ? ' <em>упал</em>' : mk === 'wu-hot' ? ' <em>потолок</em>' : ''}</span></span>`; };
    return `<div class="wu-sch" role="img" aria-label="Схема эталона: ${esc(ns.map(nm).join(', '))}">${cols.map(c => `<div class="wu-col">${c.list.sort((a, b) => a.y - b.y).map(chip).join('')}</div>`).join('<span class="wu-arr" aria-hidden="true">→</span>')}</div>`;
  }
  function cardHtml() {
    const c = V.list[V.i], ans = V.ans, done = ans != null, n = V.list.length;
    let h = head(`Разминка · ${V.i + 1} из ${n}`);
    h += `<div class="wu-prog" aria-hidden="true"><i style="width:${Math.round((V.i + (done ? 1 : 0)) / n * 100)}%"></i></div>`;
    h += `<div class="wu-meta"><span class="wu-tag wu-t-${c.t}">${TAG[c.t]}</span>${c.topic ? `<span class="wu-chip">${esc(c.topic)}</span>` : ''}<span class="wu-src">${c.t !== 'pt' || done ? `${esc(c.kind)} · «${esc(c.L.title)}»` : 'из пройденного'}</span></div>`;
    h += `<h2 id="wuTitle" class="wu-q">${c.q}</h2>`;
    if (c.g) h += schemeHtml(c.g, done ? c.post : c.pre);
    h += `<div class="wu-opts" role="group" aria-label="Варианты ответа">${c.opts.map((o, i) => `<button type="button" class="wu-a${done ? (o.ok ? ' right' : i === ans ? ' wrong' : '') : ''}" data-wua="${i}" ${done ? 'disabled' : ''}><kbd aria-hidden="true">${i + 1}</kbd><span>${esc(o.t)}</span></button>`).join('')}</div>`;
    if (!done) { h += `<div class="wu-acts"><button type="button" class="btn ghost" data-wua="-1">Не помню</button></div>`; return h; }
    const ok = ans >= 0 && !!c.opts[ans].ok, st = U.cards[c.id] || { s: 0 };
    h += `<div class="wu-fb${ok ? ' ok' : ''}" role="status"><b>${ok ? 'Вспомнил ✓' : ans < 0 ? 'Ничего страшного — для этого разминка и нужна.' : 'Не совсем.'}</b> ${c.fb}${c.after ? ' ' + c.after : ''}<small>${ok ? `Карточка вернётся ${whenW(STEPS[st.s])}.` : 'Карточка вернётся завтра: свежий повтор закрепит лучше всего.'}</small></div>`;
    if (c.pic) h += c.pic;
    h += `<div class="wu-acts wu-foot"><button type="button" class="btn primary" data-wunext="1">${V.i < n - 1 ? 'Дальше →' : 'Итог разминки →'}</button></div>`;
    return h;
  }
  /* итог: что вспомнил, что забыл; у забытого — «Вернуться к уровню» и «Разберись руками» */
  function resList(list) {
    const k = today(), back = new Set();
    const bad = list.filter(x => !x.ok), good = list.filter(x => x.ok);
    const line = x => {
      const L = lvById(x.lv), c = U.cards[x.id], when = c ? whenW(between(k, c.due)) : '';
      let acts = '';
      if (!x.ok && L && !back.has(L.id)) {
        back.add(L.id);
        const lk = SD.labLinks && SD.labLinks.links ? SD.labLinks.links(L) : [], lab = lk[0] && (SD.LABS || []).find(l => l.id === lk[0].lab);
        acts = `<span class="wu-ra"><button type="button" class="btn" data-wulv="${esc(L.id)}">Вернуться к уровню</button>${lab ? `<button type="button" class="btn ghost" data-wulab="${esc(L.id)}">Разберись руками: ${esc(lab.title)} →</button>` : ''}</span>`;
      }
      return `<li class="wu-ri ${x.ok ? 'ok' : 'bad'}"><span class="wu-rk" aria-hidden="true">${x.ok ? '✓' : '↺'}</span><span class="wu-rt"><b>${TAG[x.t] || 'Карточка'}</b> · ${L ? '«' + esc(L.title) + '»' : ''}<small>вернётся ${when}</small></span>${acts}</li>`;
    };
    let h = '<div class="wu-res">';
    h += `<section class="wu-rc"><h3>Вспомнил · ${good.length}</h3>${good.length ? `<ul>${good.map(line).join('')}</ul>` : '<p class="wu-soft">В этот раз ничего — бывает. Завтра те же карточки придут снова, и станет легче.</p>'}</section>`;
    h += `<section class="wu-rc bad"><h3>Забыл · ${bad.length}</h3>${bad.length ? `<ul>${bad.map(line).join('')}</ul>` : '<p class="wu-soft">Всё вспомнил. Карточки вернутся позже — промежутки растут.</p>'}</section>`;
    return h + '</div>';
  }
  function resultHtml() {
    const ok = V.res.filter(x => x.ok).length, nx = dueLater();
    let h = head('Итог разминки') + `<h2 id="wuTitle">Вспомнил ${ok} из ${V.res.length}</h2>`;
    h += `<p class="wu-lede">${ok === V.res.length ? 'Отлично: всё на месте. ' : ''}Забытое вернётся завтра — это не провал, а самое полезное в разминке: вспомнить с усилием и есть тренировка. Вспомненное придёт реже: промежуток растёт по лесенке 1 → 3 → 7 → 16 → 35 дней.</p>`;
    h += resList(V.res) + streakHtml();
    h += `<p class="wu-soft">${nx ? `Следующая разминка ${whenW(nx.in)}: ${cardsW(nx.n)}${nx.in > 1 ? ' — а пока можно пройти новый уровень' : ''}.` : ''}</p>`;
    h += `<div class="wu-acts wu-foot"><button type="button" class="btn primary" data-wux="1">Готово</button>${SD.path ? '<button type="button" class="btn ghost" data-wupath="1">Мой путь</button>' : ''}</div>`;
    return h;
  }
  function doneHtml() {
    const k = today(), r = U.res && U.res.k === k ? U.res.list : [], nx = dueLater();
    let h = head('Разминка дня') + `<h2 id="wuTitle">На сегодня всё ✓</h2>`;
    h += `<p class="wu-lede">Зарядка сделана. ${nx ? `Следующая разминка ${whenW(nx.in)}: ${cardsW(nx.n)}.` : ''} Ниже — что было сегодня.</p>`;
    if (r.length) h += resList(r);
    h += streakHtml();
    h += `<div class="wu-acts wu-foot"><button type="button" class="btn primary" data-wux="1">Закрыть</button>${SD.path ? '<button type="button" class="btn ghost" data-wupath="1">Мой путь</button>' : ''}</div>`;
    return h;
  }
  function render() {
    const b = $('wuBody'); if (!b) return;
    const st = status();
    if (V.scr === 'card' && V.list[V.i]) b.innerHTML = cardHtml();
    else if (V.scr === 'result') b.innerHTML = resultHtml();
    else if (st.none) b.innerHTML = noneHtml();
    else if (!st.left) b.innerHTML = doneHtml();
    else b.innerHTML = startHtml();
    b.scrollTop = 0;
  }
  function begin() {
    const k = today(), P = pool();
    V = { scr: 'card', list: remaining().map(id => { const e = P.find(c => c.id === id); return e ? build(e, k) : null; }).filter(Boolean), i: 0, res: [], ans: null };
    if (!U.introSeen) { U.introSeen = 1; save(); }
    if (!V.list.length) V.scr = 'start';
    render();
  }
  function answer(i) {
    const c = V.list[V.i]; if (!c || V.ans != null) return;
    V.ans = i;
    const ok = i >= 0 && !!(c.opts[i] && c.opts[i].ok);
    grade(c.id, ok, c.lv, c.t);
    V.res.push({ id: c.id, ok, lv: c.lv, t: c.t });
    render();
    const nb = document.querySelector('#wuBody [data-wunext]'); if (nb) { try { nb.focus({ preventScroll: true }); } catch (e) { /* фокус не важен */ } }
  }
  function next() {
    if (V.i < V.list.length - 1) { V.i++; V.ans = null; render(); } else { V.scr = 'result'; render(); }
  }
  function close() { const m = $('wuModal'); if (m) m.hidden = true; }
  function modal() {
    let m = $('wuModal'); if (m) return m;
    m = document.createElement('div'); m.className = 'modal wu-modal'; m.id = 'wuModal'; m.hidden = true;
    m.innerHTML = '<div class="sheet wu-sheet" role="dialog" aria-modal="true" aria-labelledby="wuTitle"><div class="wu-body" id="wuBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-wux]')) { close(); return; }
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.wugo) { begin(); return; }
      if (t.dataset.wua != null) { answer(+t.dataset.wua); return; }
      if (t.dataset.wunext) { next(); return; }
      if (t.dataset.wulv) { const L = lvById(t.dataset.wulv); close(); if (L) { document.querySelectorAll('.modal').forEach(x => { x.hidden = true; }); SD.app.loadLevel(L); } return; }
      if (t.dataset.wulab) { const L = lvById(t.dataset.wulab), lk = L && SD.labLinks ? SD.labLinks.links(L) : []; close(); if (lk[0]) { if (SD.app.A.level !== L) SD.app.loadLevel(L); SD.labLinks.open(lk[0]); } return; }
      if (t.dataset.wupath) { close(); if (SD.path) SD.path.open(); return; }
      if (t.dataset.wufirst) { close(); const n = SD.path && SD.path.next ? SD.path.next() : null; if (n && n.item) n.item.open(); }
    });
    return m;
  }
  function open() {
    const m = modal();
    document.querySelectorAll('.modal').forEach(x => { if (x !== m) x.hidden = true; });
    /* новая разминка — с начального экрана; незаконченная — продолжаем с тех карточек, что остались */
    if (V.scr !== 'card' || !V.list[V.i] || V.ans != null) V = { scr: 'start', list: [], i: 0, res: [], ans: null };
    render(); m.hidden = false;
    const sh = m.querySelector('.wu-sheet'); if (sh) { sh.tabIndex = -1; setTimeout(() => { try { sh.focus({ preventScroll: true }); } catch (e) { /* фокус не важен */ } }, 30); }
  }

  /* ---------- кнопка в меню «Путь», строка в «Моём пути», Ctrl+K ---------- */
  function navLabel() {
    const b = $('navWarm'); if (!b) return;
    let st; try { st = status(); } catch (e) { return; }
    const sp = b.querySelector('.wu-navn'), dot = b.querySelector('.wu-dot');
    if (sp) sp.textContent = st.none ? ' · после первого уровня' : st.left ? ` · ${cardsW(st.left)}` : ' · готово ✓';
    if (dot) dot.hidden = !st.left;
    b.title = st.none ? 'Повторение пройденного появится после первого уровня' : '5 минут повторения пройденного: прогнозы, узкие места, паттерны, аналогии';
  }
  function refresh() { navLabel(); }
  function putButton() {
    if ($('navWarm')) return true;
    const daily = $('navDaily'), hub = $('navHub'), ref = daily || hub; if (!ref || !ref.parentNode) return false;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'navWarm'; b.className = ref.className;
    b.innerHTML = 'Разминка<span class="wu-navn"></span><span class="wu-dot" aria-label="есть карточки на сегодня" hidden></span>';
    b.addEventListener('click', open);
    if (daily) daily.after(b); else ref.parentNode.insertBefore(b, ref);
    navLabel();
    return true;
  }
  function pathHtml() {
    let st; try { st = status(); } catch (e) { return ''; }
    if (st.none) return `<div class="wu-pt"><span><b>Разминка</b> появится после первого пройденного уровня. Как с зарядкой: сначала разучивают упражнение, потом повторяют его по пять минут каждый день.</span></div>`;
    const s = streak();
    if (st.left) return `<div class="wu-pt on"><span><b>К повторению сегодня: ${st.left}</b> — пять минут, вперемешку из пройденных тем.${s.n ? ` Серия: ${daysW(s.n)}.` : ''}</span><button type="button" class="btn primary" data-wuopen="1">Разминка · ${cardsW(st.left)}</button></div>`;
    return `<div class="wu-pt"><span><b>К повторению сегодня: 0</b> — разминка сделана ✓${st.next ? ` Следующая ${whenW(st.next.in)}: ${cardsW(st.next.n)}.` : ''}${s.n ? ` Серия: ${daysW(s.n)}.` : ''}</span><button type="button" class="btn ghost" data-wuopen="1">Итог разминки</button></div>`;
  }
  (SD.cmdExtra = SD.cmdExtra || []).push(add => {
    let st; try { st = status(); } catch (e) { return; }
    add('Учиться', st.none ? 'Разминка дня — после первого уровня' : st.left ? `Разминка дня · ${cardsW(st.left)}` : 'Разминка дня: на сегодня готово ✓', '5 минут повторения пройденного: прогнозы, узкие места, паттерны', open, 'разминка повторение повторить вспомнить карточки интервальное зарядка spaced repetition warmup');
  });

  let mounted = false, lastDay = '';
  function mount() {
    if (mounted) return; mounted = true;
    /* кнопка встаёт рядом с «Событием дня»; разложить её в меню «Путь» помогает js/ux.js (navWarm в списке NAV) */
    [0, 80, 600, 1700].forEach(t => setTimeout(putButton, t));
    document.addEventListener('click', e => { const t = e.target.closest && e.target.closest('[data-wuopen]'); if (t) { e.preventDefault(); open(); } });
    document.addEventListener('keydown', e => {
      const m = $('wuModal'); if (!m || m.hidden) return;
      if (e.key === 'Escape') { close(); return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (V.scr === 'card' && V.ans == null && /^[1-9]$/.test(e.key)) { const i = +e.key - 1; if (V.list[V.i] && i < V.list[V.i].opts.length) { e.preventDefault(); answer(i); } }
    });
    setTimeout(() => { watchLevels(); lastDay = today(); refresh(); }, 1200);
    setInterval(() => { watchLevels(); const k = today(); if (k !== lastDay) { lastDay = k; refresh(); } }, 2000);
  }
  /* app.js не знает про разминку: ждём, пока приложение загрузит уровень, и монтируемся сами */
  const boot = () => { if (SD.app && SD.app.A && SD.app.A.level) mount(); else setTimeout(boot, 150); };
  if (typeof document !== 'undefined') setTimeout(boot, 0);

  SD.warmup = {
    mount, open, close, status, pathHtml, streak, pool, plan: planIds, remaining, build: (id, dk) => { const e = entryOf(id); return e ? build(e, dk || today()) : null; },
    grade, STEPS,
    /* служебное — для проверок: сдвиг «сегодня», состояние, сброс */
    _t: { shift: n => { shift = n; memo.clear(); refresh(); }, state: () => JSON.parse(JSON.stringify(U)), reset: () => { U = {}; norm(); memo.clear(); BAD.clear(); save(); refresh(); }, today, answer, next, view: () => V }
  };
})();
