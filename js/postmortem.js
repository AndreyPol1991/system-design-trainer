/* Разбор аварии (постмортем) после «События дня».
   Как разбор матча после игры: не кто виноват, а что изменить. После проверки решения в событии дня — при успехе,
   при провале и когда открыл эталон — появляется кнопка «Разобрать, как разбирают аварии». Разбор по шагам:
   что случилось (прогон стартовой схемы под испытанием), хронология, корневая причина, что сработало в твоей схеме,
   действия с владельцем и сроком. Без поиска виноватых (blameless). Термины и структура — как в лаборатории
   «Дежурство и постмортем» (lab-oncall.js); саму лабораторию не трогаем.
   Подключение: daily.js вызывает SD.postmortem.offer(ctx) и SD.postmortem.cardLink() на карточке события.
   Хранение: localStorage 'amp-stroyka-postmortem-v1'. Стили — классы .pm2-*. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt, T = () => SD.TYPES;
  const KEY = 'amp-stroyka-postmortem-v1';
  const copy = o => JSON.parse(JSON.stringify(o));
  const nm = n => n ? (n.label || (T()[n.type] || {}).name || n.id) : '';
  const isOps = n => !!((T()[n.type] || {}).ops);
  const cap1 = s => s ? s[0].toUpperCase() + s.slice(1) : '';
  /* загрузка: проценты, а сверх ×3 — «в N раз выше потолка», так понятнее */
  const pu = u => {
    u = u || 0; if (u < 3) return Math.round(u * 100) + ' %';
    if (u >= 1000) return 'более чем в 1000 раз выше потолка';
    const n = u < 10 ? Math.round(u * 10) / 10 : Math.round(u), i = Math.floor(n);
    return `в ${String(n).replace('.', ',')} ${n !== i || (i % 10 >= 2 && i % 10 <= 4 && !(i % 100 >= 12 && i % 100 <= 14)) ? 'раза' : 'раз'} выше потолка`;
  };
  /* симулятор при шторме даёт «610092225 %» — такие числа переводим в «в N раз выше потолка» */
  const big = s => String(s == null ? '' : s).replace(/(\d{4,}) %/g, (m, d) => pu(+d / 100));
  const usd = v => F().usd(v), pct = v => F().pct(v), ms = v => F().ms(v), num = v => F().num(v);
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const dayTxt = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const keyDate = k => { const s = String(k || ''); return s.length === 8 ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : new Date(); };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

  /* ---------- хранилище ---------- */
  let S = { list: [] };
  try { S = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { S = {}; }
  if (!S || !Array.isArray(S.list)) S = { list: [] };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); return true; } catch (e) { return false; } };

  /* ---------- словари ---------- */
  /* что говорит каждое испытание: короткая формула, «поверхностный» и «обвиняющий» ответы, проверка на будущее */
  const EVX = {
    sale: { load: 'пользователей в 2,5 раза больше', shallow: 'Покупателей пришло слишком много — от распродажи не защититься', blame: 'Тот, кто собирал схему, не подумал о распродажах', test: 'Нагрузочный тест ×3 перед каждой распродажей: прогнать пик на копии схемы', testOwn: 'qa', inc: 'aws2021', incWhy: 'Тоже пик нагрузки: упёрлись в узкое место, а повторы клиентов добили систему.' },
    viral: { load: 'чтений в 4 раза больше', shallow: 'Так совпало: про сервис написали блогеры', blame: 'Маркетинг не предупредил о публикации — их недосмотр', test: 'Рунбук «вирусный пик»: как за 15 минут поднять кэш и реплики на чтение', testOwn: 'sre', inc: 'fb2010', incWhy: 'Тоже лавина чтений: всё, что не нашлось в кэше, разом пошло в базу.' },
    import: { load: 'записей в 4 раза больше', shallow: 'Клиент залил слишком большой каталог — такое не предусмотреть', blame: 'Менеджер клиента не согласовал импорт — его ошибка', test: 'Импорт крупных клиентов — через очередь с ограничением скорости, ночью', testOwn: 'backend', inc: '', incWhy: '' },
    cut: { load: 'бюджет на 30 % меньше', shallow: 'Денег стало меньше — ничего не поделаешь', blame: 'Финансовый директор урезал бюджет, не спросив инженеров', test: 'Раз в месяц пересматривать загрузку: узлы ниже 30 % — кандидаты на сокращение', testOwn: 'fin', inc: 'aws2011', incWhy: 'Урезая бюджет, легко срезать и запас. Эта авария показала, что бывает, когда запаса нет.' },
    black: { load: 'пользователей в 4 раза больше', shallow: 'Чёрная пятница бывает раз в год — так бывает', blame: 'Архитектор ошибся при расчёте запаса', test: 'Нагрузочный тест ×5 за месяц до чёрной пятницы и план расширения по нему', testOwn: 'qa', inc: 'aws2021', incWhy: 'Тоже пик нагрузки: упёрлись в узкое место, а повторы клиентов добили систему.' }
  };
  const NOTE = { wrong: 'не подтверждается данными разбора', shallow: 'останавливается на поверхности: испытание — это условие задачи, а не причина. Причина — место в схеме, которое не выдержало', blame: 'ищет виноватого: в следующий раз ошибки будут прятать. Разбор чинит систему, а не человека' };
  const OWN = [['backend', 'Бэкенд'], ['data', 'Данные и БД'], ['platform', 'Платформа'], ['sre', 'SRE и дежурные'], ['qa', 'Тестирование'], ['fin', 'Финансы']];
  const DUE = [['3d', '3 дня', 3], ['1w', '1 неделя', 7], ['2w', '2 недели', 14], ['1m', '1 месяц', 30], ['1q', 'квартал', 91]];
  const CAT = [['cause', 'причина'], ['detect', 'обнаружение'], ['respond', 'реакция']];
  const label = (list, v) => (list.find(x => x[0] === v) || [, '—'])[1];
  const dueDate = v => { const d = new Date(), x = DUE.find(q => q[0] === v); d.setDate(d.getDate() + (x ? x[2] : 7)); return dayTxt(d); };
  const ownerOf = t => ['sql', 'nosql', 'cache', 'search', 'vectordb', 'olap', 'lake', 'tsdb', 'graphdb', 'cdc', 'etl'].includes(t) ? 'data'
    : ['lb', 'cdn', 'objstore', 'queue', 'worker', 'k8s', 'llm', 'embed', 'stt', 'tts', 'semcache'].includes(t) ? 'platform' : 'backend';
  const PRI = { success: 0, jobs: 1, latency: 2, survive: 3, cost: 4 };
  const pri = t => (t in PRI ? PRI[t] : 5);
  const SYMPT = ['nolost', 'nodup', 'ordered', 'durable', 'fresh', 'consistent', 'quality'];
  const epv = (k, v) => k === 'backoff' ? (v === 'exp' ? 'экспоненциальная' : 'сразу') : (k === 'cb' || k === 'fallback') ? (v ? 'вкл' : 'выкл') : k === 'timeout' ? (v ? v + ' мс' : 'нет') : String(v);
  const EP = { proto: 'протокол', timeout: 'таймаут', retries: 'повторы', backoff: 'пауза между повторами', cb: 'предохранитель', fallback: 'запасной ответ' };

  /* без поиска виноватых: слова, которые ищут человека, а не причину */
  const W0 = '(?<![а-яёa-z])', W1 = '(?![а-яёa-z])';
  const BLAME = new RegExp(W0 + '(винов[а-яё]*|вин[аеуы]' + W1 + '|накосяч[а-яё]*|наказ[а-яё]*|уволи[а-яё]*|выговор[а-яё]*|преми[июяей]' + W1 + '|премию|премии|халатн[а-яё]*|криворук[а-яё]*|ошибс[яь]|ошиблас[ья]|ошиблис[ья]|недосмотр[а-яё]*|не\\s+подумал[а-яё]*|не\\s+доглядел[а-яё]*|из-за\\s+(него|неё|нее|них)' + W1 + '|кто\\s+(собирал|настраивал|делал|придумал))', 'iu');
  const blameOf = s => { const m = String(s || '').match(BLAME); return m ? m[0] : ''; };

  /* ---------- прогоны ---------- */
  function run(L, g) {
    const res = SD.sim.run(L, g, { mul: 1 }), ch = SD.sim.chaos(L, g), an = SD.sim.analyze(L, g, res);
    let adv = []; try { adv = SD.sim.advise(L, g, res, an) || []; } catch (e) { adv = []; }
    return { res, ch, goals: SD.evalGoals(L, g, res, ch, an), adv };
  }
  /* правка для шторма повторов: экспоненциальная пауза и предохранитель на этой связи — проверяем прогоном */
  function stormFix(D, start, edId, gi) {
    const g = copy(start), e = g.edges.find(x => x.id === edId); if (!e) return null;
    Object.assign(e.props, { backoff: 'exp', cb: true });
    let r; try { r = run(D, g); } catch (err) { return null; }
    const inf = (r.res.edges[edId] || {}).info || {}, ok = !!(r.goals[gi] && r.goals[gi].ok);
    /* если одной паузы мало — сколько мощности нужно уже со спокойными повторами */
    let more = '', moreOk = false;
    if (!ok) { try { const w = SD.learn.analyze(D, g, gi); if (w && w.fix) { more = fixText(g, w.fix); moreOk = !!(w.fixInfo && w.fixInfo.ok); } } catch (err) { more = ''; } }
    return { amp: inf.amp || 1, util: (r.res.nodes[e.to] || {}).util || 0, ok, more, moreOk, red: r.goals.filter(x => !x.ok).length };
  }
  const gsig = g => JSON.stringify(g.nodes.map(n => [n.id, n.type, n.props]).sort()) + JSON.stringify(g.edges.map(e => e.from + '>' + e.to + JSON.stringify(e.props)).sort());
  const fixText = (g, fix) => (fix || []).map(c => { const n = g.nodes.find(x => x.id === c.id); return `«${nm(n)}»${c.key === 'count' ? '' : ' · ' + String(c.label || c.key).toLowerCase()}: ${c.from} → ${c.to}${c.key === 'count' ? ' экз.' : ''}`; }).join(', ');
  const worst = (L, res) => Object.keys(L.traffic || {}).filter(k => k !== 'bot' && L.traffic[k] > 0 && res.kinds[k]).reduce((m, k) => res.kinds[k].success < m.v ? { k, v: res.kinds[k].success } : m, { k: null, v: 1 });

  /* ---------- что поменял человек: правки схемы относительно стартовой ---------- */
  const optTxt = (p, v) => {
    if (p.type === 'toggle') return v ? 'вкл' : 'выкл';
    if (p.type === 'select') { const o = (p.options || []).find(x => x[0] === v); return o ? String(o[1]).split(' — ')[0] : String(v); }
    return String(v);
  };
  function changes(start, mine) {
    const S0 = new Map(start.nodes.map(n => [n.id, n])), M = new Map(mine.nodes.map(n => [n.id, n]));
    const same = (a, b) => a && b && a.type === b.type;
    const ek = e => e.from + '>' + e.to, E0 = new Map(start.edges.map(e => [ek(e), e])), E1 = new Map(mine.edges.map(e => [ek(e), e]));
    const added = new Set(mine.nodes.filter(n => !same(S0.get(n.id), n)).map(n => n.id)), removed = new Set(start.nodes.filter(n => !same(M.get(n.id), n)).map(n => n.id));
    const out = [];
    mine.nodes.forEach(n => {
      if (added.has(n.id)) { out.push({ k: 'add', id: n.id, text: `добавлен «${nm(n)}»` }); return; }
      const o = S0.get(n.id), props = (T()[n.type] || {}).props || [];
      const list = props.filter(p => JSON.stringify(o.props[p.key]) !== JSON.stringify(n.props[p.key]) && !(o.props[p.key] === undefined && n.props[p.key] === p.def))
        .map(p => ({ key: p.key, label: p.label, from: optTxt(p, o.props[p.key] !== undefined ? o.props[p.key] : p.def), to: optTxt(p, n.props[p.key]) }));
      if (list.length) out.push({ k: 'prop', id: n.id, list, text: `«${nm(n)}»: ${list.map(c => `${c.label.toLowerCase()} ${c.from} → ${c.to}`).join(', ')}` });
    });
    start.nodes.forEach(o => { if (removed.has(o.id)) out.push({ k: 'del', id: o.id, text: `убран «${nm(o)}»` }); });
    const nmOf = (g, id) => nm(g.nodes.find(n => n.id === id));
    mine.edges.forEach(e => {
      if (added.has(e.from) || added.has(e.to)) return;
      const o = E0.get(ek(e));
      if (!o) { out.push({ k: 'eadd', from: e.from, to: e.to, text: `новая связь «${nmOf(mine, e.from)}» → «${nmOf(mine, e.to)}»` }); return; }
      const keys = Object.keys(EP).filter(k => JSON.stringify((o.props || {})[k]) !== JSON.stringify((e.props || {})[k]));
      if (keys.length) out.push({ k: 'eprop', from: e.from, to: e.to, keys, text: `связь «${nmOf(mine, e.from)}» → «${nmOf(mine, e.to)}»: ${keys.map(k => EP[k] + ' ' + epv(k, (o.props || {})[k]) + ' → ' + epv(k, (e.props || {})[k])).join(', ')}` });
    });
    start.edges.forEach(o => { if (removed.has(o.from) || removed.has(o.to) || E1.has(ek(o))) return; out.push({ k: 'edel', from: o.from, to: o.to, text: `убрана связь «${nmOf(start, o.from)}» → «${nmOf(start, o.to)}»` }); });
    return out;
  }
  /* откатить одну правку в схеме человека: так видно, какую цель держит именно она */
  function revert(c, start, mine) {
    const g = copy(mine), ek = e => e.from + '>' + e.to;
    if (c.k === 'prop') { const n = g.nodes.find(x => x.id === c.id), o = start.nodes.find(x => x.id === c.id); c.list.forEach(p => { if (o.props[p.key] === undefined) delete n.props[p.key]; else n.props[p.key] = copy(o.props[p.key]); }); }
    else if (c.k === 'add') { g.nodes = g.nodes.filter(n => n.id !== c.id); g.edges = g.edges.filter(e => e.from !== c.id && e.to !== c.id); }
    else if (c.k === 'del') { g.nodes.push(copy(start.nodes.find(n => n.id === c.id))); const have = new Set(g.nodes.map(n => n.id)); start.edges.filter(e => (e.from === c.id || e.to === c.id) && have.has(e.from) && have.has(e.to)).forEach(e => g.edges.push(copy(e))); }
    else if (c.k === 'eadd') g.edges = g.edges.filter(e => ek(e) !== c.from + '>' + c.to);
    else if (c.k === 'edel') g.edges.push(copy(start.edges.find(e => ek(e) === c.from + '>' + c.to)));
    else if (c.k === 'eprop') { const e = g.edges.find(x => ek(x) === c.from + '>' + c.to), o = start.edges.find(x => ek(x) === c.from + '>' + c.to); c.keys.forEach(k => { e.props[k] = copy((o.props || {})[k]); }); }
    return g;
  }

  /* ---------- разбор: всё считается прогоном симулятора ---------- */
  function analyze(ctx) {
    const D = ctx.L, B = ctx.base || D, e = ctx.ev || { id: '', title: 'испытание', chip: '' }, X = EVX[e.id] || EVX.sale;
    const start = copy(ctx.start), mine = copy(ctx.graph || ctx.start);
    const b0 = run(B, start), r0 = run(D, start), r1 = run(D, mine);
    const gave = ctx.how === 'gave' || (!!ctx.sol && gsig(ctx.sol) === gsig(mine));
    const outcome = gave ? 'gave' : r1.goals.every(x => x.ok) ? 'ok' : 'fail';
    const P = { ctx, D, B, e, X, start, mine, b0, r0, r1, outcome, key: ctx.key || (D.daily && D.daily.key) || '' };

    /* цифры «обычный день → под испытанием» */
    const costG = i => (D.goals[i] || {}).t === 'cost';
    const ci = D.goals.findIndex(g => g.t === 'cost');
    const top = g => g.nodes.filter(n => n.type !== 'client' && !isOps(n) && r0.res.nodes[n.id] && r0.res.nodes[n.id].rps > 0).sort((a, b) => r0.res.nodes[b.id].util - r0.res.nodes[a.id].util)[0];
    const tn = top(start);
    P.kpis = [
      ['Запросов в секунду', num(b0.res.total.rps), num(r0.res.total.rps)],
      ['Успешных ответов', pct(b0.res.total.success), pct(r0.res.total.success)],
      ['Среднее время ответа', ms(b0.res.total.lat), ms(r0.res.total.lat)],
      ['Цена в месяц', usd(b0.res.cost), usd(r0.res.cost)]
    ];
    if (ci >= 0) P.kpis.push(['Бюджет в месяц', usd((B.goals[ci] || D.goals[ci]).max), usd(D.goals[ci].max)]);
    if (tn) P.kpis.push([`Загрузка «${nm(tn)}»`, pu((b0.res.nodes[tn.id] || {}).util), pu(r0.res.nodes[tn.id].util)]);
    P.goals = D.goals.map((g, i) => ({ text: r0.goals[i].text, b: b0.goals[i] ? b0.goals[i].ok : true, bd: b0.goals[i] ? (costG(i) ? `сейчас ${usd(b0.res.cost)}` : b0.goals[i].detail) : '', a: r0.goals[i].ok, ad: r0.goals[i].detail, m: r1.goals[i].ok, md: r1.goals[i].detail }));

    /* виновники красных целей — тот же разбор, что у кнопки «Почему?» */
    const red = r0.goals.map((g, i) => ({ g, i, lg: D.goals[i] })).filter(o => !o.g.ok).sort((a, b) => pri(a.lg.t) - pri(b.lg.t));
    const why = red.slice(0, 3).map(o => { let w = null; try { w = SD.learn.analyze(D, start, o.i); } catch (err) { w = null; } return Object.assign({}, o, { w: w || { marks: [], emarks: [], lines: [], fix: null, rem: '' } }); });
    P.red = red; P.why = why;
    root(P); chrono(P); diff(P); suggest(P); incident(P);
    P.chrono = P.chrono.map(big); P.worked = P.worked.map(big); P.notWorked = P.notWorked.map(big);
    P.root.right = big(P.root.right); P.root.explain = big(P.root.explain); P.root.opts.forEach(o => { o.t = big(o.t); o.why = big(o.why); });
    return P;
  }

  /* корневая причина и три неверных ответа: «не то место», «на поверхности», «ищет виноватого» */
  function root(P) {
    const { start, b0, r0, why, X, D } = P, m = why[0];
    const R = { kind: 'other', node: null, opts: [], right: '', explain: '' };
    P.root = R;
    if (!m) return;
    const w = m.w, t = m.lg.t;
    let mk = w.marks.find(x => start.nodes.some(n => n.id === x.id));
    /* шторм повторов: связь без паузы между повторами бьёт по узлу, который и так в беде, — это и есть корень */
    const storm = t === 'cost' || t === 'survive' ? null : (w.emarks || []).map(x => ({ x, ed: start.edges.find(q => q.id === x.id) }))
      .filter(o => o.ed && /^повтор/.test(o.x.tag) && (!mk || w.marks.some(q => q.id === o.ed.to)))
      .sort((a, b) => (((r0.res.edges[b.ed.id] || {}).info || {}).amp || 0) - (((r0.res.edges[a.ed.id] || {}).info || {}).amp || 0))[0];
    if (storm) mk = w.marks.find(q => q.id === storm.ed.to) || { id: storm.ed.to, tag: '' };
    const n = mk ? start.nodes.find(x => x.id === mk.id) : null;
    const nr = n ? r0.res.nodes[n.id] || {} : {}, nb = n ? b0.res.nodes[n.id] || {} : {};
    const adv = n ? (r0.adv.find(a => a.node === n.id && a.sev === 'bad') || r0.adv.find(a => a.node === n.id)) : null;
    const fix = w.fix ? fixText(start, w.fix) : '', fixOk = w.fixInfo && w.fixInfo.ok;
    const em = storm ? storm.x : w.emarks && w.emarks[0], ed = em && start.edges.find(x => x.id === em.id);
    const ename = ed ? `«${nm(start.nodes.find(q => q.id === ed.from))}» → «${nm(start.nodes.find(q => q.id === ed.to))}»` : '';
    let kind = 'other';
    if (t === 'cost') kind = 'cost';
    else if (t === 'survive') kind = 'survive';
    else if (storm) kind = 'edge';
    else if (n && nr.dead) kind = 'dead';
    else if (n && nr.util > 1) kind = 'hot';
    else if (n && t === 'latency') kind = 'slow';
    else if (ed) kind = 'edge';
    else if (n) kind = 'hot';
    R.kind = kind; R.node = n ? n.id : null; R.name = n ? nm(n) : ''; R.u0 = nb.util || 0; R.u1 = nr.util || 0; R.tag = mk ? mk.tag : ''; R.fix = fix; R.fixOk = fixOk; R.ename = ename; R.etag = em ? em.tag : '';
    R.edge = ed ? { id: ed.id, from: nm(start.nodes.find(q => q.id === ed.from)), to: nm(start.nodes.find(q => q.id === ed.to)), amp: (((r0.res.edges[ed.id] || {}).info || {}).amp || 1) } : null;
    /* запас на отказ: был ли он в обычный день — проверяем, а не предполагаем */
    const gi = m.i, b0ok = b0.goals[gi] ? b0.goals[gi].ok : true;
    const N = R.name, ci = D.goals.findIndex(g => g.t === 'cost'), max = ci >= 0 ? D.goals[ci].max : 0, gap = Math.max(0, r0.res.cost - max);
    const fixLine = fix ? `Проверил на симуляторе: ${fix} — ${fixOk ? 'цель станет зелёной' : 'станет лучше, но не до конца'}.` : (w.rem ? `Что попробовать: ${w.rem}` : '');
    const marked = new Set(why.flatMap(o => o.w.marks.map(x => x.id)));
    const live = start.nodes.filter(q => q.type !== 'client' && !isOps(q) && r0.res.nodes[q.id] && r0.res.nodes[q.id].rps > 0 && !r0.res.nodes[q.id].dead);
    /* неверный ответ правдоподобен, когда узел заметно загружен, но запас у него есть */
    const calm = live.filter(q => !marked.has(q.id) && r0.res.nodes[q.id].util < 0.8).sort((a, b) => r0.res.nodes[b.id].util - r0.res.nodes[a.id].util);
    const byU = live.filter(q => q.id !== R.node).sort((a, b) => r0.res.nodes[b.id].util - r0.res.nodes[a.id].util), uq = q => `«${nm(q)}» — ${pu(r0.res.nodes[q.id].util)}`;
    const hotOthers = byU.filter(q => r0.res.nodes[q.id].util > 1).slice(0, 2).map(uq).join(', '), others = byU.filter(q => r0.res.nodes[q.id].util <= 0.9).slice(0, 2).map(uq).join(', ');
    if (kind === 'hot') {
      R.right = `«${N}» — узкое место: мощность рассчитана на обычный день, а под испытанием загрузка ${pu(R.u0)} → ${pu(R.u1)}`;
      R.explain = `${adv ? adv.text + ' ' : ''}${hotOthers ? `Следом перегружаются: ${hotOthers} — это следующие остановки, когда расширишь первое место. ` : ''}${others ? `С запасом: ${others}. ` : ''}${fixLine}`;
    } else if (kind === 'dead') {
      R.right = `«${N}» не выдерживает и падает — всё, что шло через него, получает ошибки`;
      R.explain = `${adv ? adv.text + ' ' : ''}${fixLine}`;
    } else if (kind === 'slow') {
      R.right = `Запрос дольше всего стоит в «${N}»: ${R.tag}`;
      R.explain = `Время ответа складывается из остановок по пути, и самая долгая — «${N}» (загрузка ${pu(R.u1)}). ${fixLine}`;
    } else if (kind === 'survive') {
      R.right = `У «${N}» не осталось запаса на отказ: под новой нагрузкой без одного экземпляра оставшиеся не вытянут`;
      R.explain = `Проверка отказом: ${R.tag ? `если упадёт один экземпляр «${N}», ${R.tag.replace(/^упадёт — /, '')}` : `без одного экземпляра «${N}» цель не держится`}. ${b0ok ? 'В обычный день запаса хватало' : 'Запаса не было и в обычный день'}: загрузка ${pu(R.u0)} → ${pu(R.u1)}. Пока все экземпляры живы, пользователи ошибок не видят — авария ждёт первого отказа. ${fixLine}`;
    } else if (kind === 'edge' && R.edge && /^повтор/.test(R.etag)) {
      const sf = stormFix(D, start, R.edge.id, gi), advE = r0.adv.find(a => a.edge === R.edge.id && /Повтор/.test(a.text));
      R.stormFix = sf;
      R.right = `Повторы на связи ${ename} без паузы раздувают нагрузку ×${R.edge.amp.toFixed(1).replace('.', ',')}: перегруженный «${N}» получает ещё больше запросов`;
      R.explain = `${advE ? advE.text + ' ' : ''}Когда «${N}» отвечает медленно, «${R.edge.from}» сразу повторяет запрос — и нагрузка растёт сама, хотя пользователей больше не стало. `
        + (sf ? `Проверил на симуляторе: экспоненциальная пауза между повторами и предохранитель на этой связи — раздувание ×${R.edge.amp.toFixed(1).replace('.', ',')} → ×${sf.amp.toFixed(1).replace('.', ',')}, загрузка «${N}» ${pu(R.u1)} → ${pu(sf.util)}${sf.ok ? ', цель станет зелёной.' : '. Одной паузы мало: под пиком нужна ещё мощность.'}` : '')
        + (sf && !sf.ok && sf.more ? ` Вместе с паузой: ${sf.more} — ${sf.moreOk ? 'цель станет зелёной' : 'станет лучше, но не до конца'}.` : sf && !sf.ok && fix ? ` Без паузы понадобилось бы: ${fix.replace(/\.$/, '')}.` : '');
    } else if (kind === 'cost') {
      /* причина — экземпляры сверх нужного (их нашла проверенная правка), а не просто «самый дорогой» */
      const fx = (w.fix || []).map(c => start.nodes.find(q => q.id === c.id)).filter(Boolean).slice(0, 2);
      if (fx.length) { R.node = fx[0].id; R.name = nm(fx[0]); R.u1 = (r0.res.nodes[fx[0].id] || {}).util || 0; R.u0 = (b0.res.nodes[fx[0].id] || {}).util || 0; }
      R.right = fx.length ? `Схема держит экземпляры сверх нужного: ${fx.map(q => `«${nm(q)}» — ${q.props.count || 1} экз. при загрузке ${pu((r0.res.nodes[q.id] || {}).util)}`).join(', ')}`
        : n ? `Запас схемы рассчитан на старый бюджет: дороже всего «${N}» — ${usd(nr.cost || 0)} в месяц при загрузке ${pu(R.u1)}` : 'Запас схемы рассчитан на старый бюджет';
      R.explain = `Новый бюджет ${usd(max)}, схема стоит ${usd(r0.res.cost)} — не хватает ${usd(gap)}. ${fix ? `Без вреда для остальных целей можно урезать: ${fix.replace(/\.$/, '')}.` : (w.rem || '')}`;
    } else if (kind === 'edge') {
      R.right = `Связь ${ename}: ${R.etag} — нагрузка растёт сама`;
      R.explain = `${(w.lines || [])[0] || ''} ${fixLine}`;
    } else {
      R.right = cap1(m.g.detail || m.g.text);
      R.explain = `${(w.lines || []).join(' ')} ${fixLine}`;
    }
    /* неверный, но правдоподобный: узел, который на самом деле держит */
    let wrong = null;
    if (kind === 'cost') {
      const fxs = new Set((w.fix || []).map(c => c.id));
      const busy = start.nodes.filter(q => (r0.res.nodes[q.id] || {}).cost > 0 && !fxs.has(q.id) && r0.res.nodes[q.id].util > 0.5).sort((a, b) => r0.res.nodes[b.id].cost - r0.res.nodes[a.id].cost)[0];
      if (busy) wrong = { t: `Урезать надо «${nm(busy)}» — это одна из самых дорогих частей схемы`, why: `${NOTE.wrong}: загрузка «${nm(busy)}» — ${pu(r0.res.nodes[busy.id].util)}, урежешь — и узел перегрузится` };
      const cheap = start.nodes.filter(q => (r0.res.nodes[q.id] || {}).cost > 0 && q.id !== R.node).sort((a, b) => r0.res.nodes[a.id].cost - r0.res.nodes[b.id].cost)[0];
      if (cheap && !wrong) wrong = { t: `Дороже всего обходится «${nm(cheap)}» — урезать надо его`, why: `${NOTE.wrong}: «${nm(cheap)}» — всего ${Math.round(r0.res.nodes[cheap.id].cost / Math.max(1, r0.res.cost) * 100)} % счёта` };
    } else if (kind === 'survive') {
      const okc = r0.ch.filter(c => c.ok && c.id !== R.node).map(c => start.nodes.find(q => q.id === c.id)).filter(Boolean)[0];
      if (okc) { const c = r0.ch.find(x => x.id === okc.id); wrong = { t: `«${nm(okc)}» — единственная опора без запаса`, why: `${NOTE.wrong}: при падении «${nm(okc)}» система держит ${pct(c.success)}` }; }
    }
    if (!wrong && calm[0]) wrong = { t: `«${nm(calm[0])}» — узкое место: не хватает мощности`, why: `${NOTE.wrong}: под испытанием загрузка «${nm(calm[0])}» — ${pu(r0.res.nodes[calm[0].id].util)}, запас ещё есть` };
    if (!wrong) wrong = { t: 'Медленная сеть между узлами', why: `${NOTE.wrong}: в симуляторе время складывается из работы узлов, а сеть не упирается в потолок` };
    const opts = [{ t: R.right, k: 'ok', why: R.explain }, { t: wrong.t, k: 'wrong', why: wrong.why }, { t: X.shallow, k: 'shallow', why: NOTE.shallow }, { t: X.blame, k: 'blame', why: NOTE.blame }];
    /* порядок — свой на каждый день, но один и тот же при повторном открытии */
    let h = hash(P.key + (P.e.id || ''));
    R.opts = opts.map(o => { h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; return { o, r: h }; }).sort((a, b) => a.r - b.r).map(x => x.o);
  }

  /* хронология: от толчка до того, что увидели пользователи — 3–5 строк */
  function chrono(P) {
    const { e, X, b0, r0, start, R = P.root, why, D, B } = P, out = [];
    const ci = D.goals.findIndex(g => g.t === 'cost');
    if (e.id === 'cut' && ci >= 0) out.push(`${cap1(e.title)}: бюджет ${usd((B.goals[ci] || D.goals[ci]).max)} → ${usd(D.goals[ci].max)} в месяц, нагрузка та же`);
    else out.push(`${cap1(e.title || 'испытание')} (${e.chip || ''}): ${X.load} — ${num(b0.res.total.rps)} → ${num(r0.res.total.rps)} запросов в секунду`);
    const N = R.name;
    if (R.kind === 'cost') {
      out.push(`Схема прежняя: стоит ${usd(r0.res.cost)} в месяц — запас в ней рассчитан на старый бюджет`);
      const idle = start.nodes.filter(n => r0.res.nodes[n.id] && r0.res.nodes[n.id].rps > 0 && r0.res.nodes[n.id].util < 0.35 && (n.props.count || 1) > 1).slice(0, 2);
      if (idle.length) out.push(`Простаивают: ${idle.map(n => `«${nm(n)}» (${n.props.count} экз., загрузка ${pu(r0.res.nodes[n.id].util)})`).join(', ')} — платим за экземпляры, которые почти не работают`);
      else if (N) out.push(`Больше всего тратит «${N}»: ${usd((r0.res.nodes[R.node] || {}).cost || 0)} в месяц`);
      if (ci >= 0) out.push(`Счёт ${usd(r0.res.cost)} не помещается в новый бюджет ${usd(D.goals[ci].max)}: не хватает ${usd(Math.max(0, r0.res.cost - D.goals[ci].max))}`);
    } else if (R.kind === 'survive') {
      out.push(`Нагрузка на «${N}» растёт: ${pu(R.u0)} → ${pu(R.u1)} — экземпляров хватает только впритык`);
      out.push(`Проверка отказом: без одного экземпляра «${N}» оставшиеся не вытягивают — ${String(R.tag || '').replace(/^упадёт — /, '') || 'цель краснеет'}`);
      out.push(`Пока все экземпляры живы, ошибок нет — но первый же отказ «${N}» ударит по пользователям`);
    } else if (R.kind === 'edge' && R.edge && /^повтор/.test(R.etag)) {
      out.push(`«${N}» не успевает: загрузка ${pu(R.u0)} → ${pu(R.u1)}, ответы замедляются`);
      out.push(`«${R.edge.from}» повторяет запросы к «${N}» без паузы: нагрузка ×${R.edge.amp.toFixed(1).replace('.', ',')} — перегрузка растёт сама`);
      const m2 = why.flatMap(o => o.w.marks).find(x => x.id !== R.node && start.nodes.some(q => q.id === x.id));
      if (m2 && /^перегружен/.test(m2.tag || '')) out.push(`Следом перегружается «${nm(start.nodes.find(q => q.id === m2.id))}»: ${pu(+String(m2.tag).replace(/\D/g, '') / 100)}`);
    } else if (R.node || R.kind === 'edge') {
      if (R.kind === 'dead') out.push(`«${N}» не выдерживает и перестаёт отвечать`);
      else if (R.kind === 'slow') out.push(`Запросы застревают в «${N}»: ${R.tag}`);
      else if (R.kind === 'hot') out.push(`«${N}» упирается в потолок: загрузка ${pu(R.u0)} → ${pu(R.u1)}, запросы встают в очередь`);
      /* как беда расходится выше по схеме */
      const em = (why[0].w.emarks || []).map(m => start.edges.find(x => x.id === m.id) && Object.assign({ ed: start.edges.find(x => x.id === m.id) }, m)).filter(Boolean)[0];
      if (em) {
        const a = nm(start.nodes.find(q => q.id === em.ed.from)), b = nm(start.nodes.find(q => q.id === em.ed.to));
        out.push(/таймаут/.test(em.tag) ? `Таймауты: на связи «${a}» → «${b}» ${em.tag.replace(/^таймаут /, '')} вызовов` : /повтор/.test(em.tag) ? `Повторы на связи «${a}» → «${b}» раздувают нагрузку: ${em.tag.replace(/^повторы: /, '')}` : `Связь «${a}» → «${b}»: ${em.tag}`);
      } else if (R.node) {
        const up = start.edges.filter(x => x.to === R.node).map(x => ({ x, f: start.nodes.find(q => q.id === x.from) })).filter(o => o.f && o.f.type !== 'client' && !isOps(o.f) && r0.res.edges[o.x.id] && r0.res.edges[o.x.id].flow > 0.001)[0];
        if (up) out.push(`«${nm(up.f)}» ждёт ответа «${N}» — очередь растёт, время ответа ${ms(b0.res.total.lat)} → ${ms(r0.res.total.lat)}`);
        else if (r0.res.total.lat > b0.res.total.lat * 1.3) out.push(`Время ответа растёт: ${ms(b0.res.total.lat)} → ${ms(r0.res.total.lat)}`);
      }
      const m2 = why.flatMap(o => o.w.marks).find(x => x.id !== R.node && start.nodes.some(q => q.id === x.id));
      if (m2 && out.length < 4) {
        const n2 = nm(start.nodes.find(q => q.id === m2.id)), t2 = String(m2.tag || '');
        out.push(/^перегружен/.test(t2) ? `Следом перегружается «${n2}»: ${pu(+t2.replace(/\D/g, '') / 100)}` : t2 === 'лежит' ? `Следом падает «${n2}»` : /^упадёт/.test(t2) ? `Запаса нет и у «${n2}»: при падении одного экземпляра ${t2.replace(/^упадёт — /, '')}` : /^≈/.test(t2) ? `Ещё одна долгая остановка — «${n2}»: ${t2}` : `Следом не выдерживает «${n2}»: ${t2}`);
      }
    }
    /* что увидели пользователи */
    const sym = [];
    P.red.forEach(o => {
      if (o.lg.t === 'success') { const wv = worst(D, r0.res); sym.push(`пользователи видят ошибки: успешных ответов ${pct(wv.v)} при цели не меньше ${pct(o.lg.min)}`); }
      else if (o.lg.t === 'latency') sym.push(`ответа ждут ${String(o.g.detail).replace(/^сейчас /, '')} при цели до ${o.lg.max} мс`);
      else if (o.lg.t === 'jobs') sym.push(`фоновые задачи не успевают: ${o.g.detail}`);
      /* в симптомы — только то, что видят пользователи; диагноз, бюджет и запас на отказ — не симптомы */
      else if (SYMPT.includes(o.lg.t)) sym.push(`краснеет цель «${o.g.text}»: ${o.g.detail}`);
    });
    if (sym.length) out.push(cap1(sym.slice(0, 2).join('; ')));
    else if (out.length < 3) out.push(`Краснеет цель «${P.red[0] ? P.red[0].g.text : 'испытания'}»`);
    while (out.length > 5) out.splice(out.length - 2, 1);
    if (out.length < 3) out.push(`Покраснели цели: ${P.red.length} из ${D.goals.length}`);
    P.chrono = out;
  }

  /* что сработало и что нет: правки человека, и какую цель держит каждая */
  function diff(P) {
    const { start, mine, r0, r1, D } = P;
    const ch = changes(start, mine);
    const okM = r1.goals.map(g => g.ok), ok0 = r0.goals.map(g => g.ok);
    ch.slice(0, 10).forEach(c => {
      let r; try { r = run(D, revert(c, start, mine)); } catch (err) { r = null; }
      if (!r) return;
      c.closes = r.goals.map((g, j) => (okM[j] && !g.ok && !ok0[j] ? j : -1)).filter(j => j >= 0);
      c.holds = r.goals.map((g, j) => (okM[j] && !g.ok && ok0[j] ? j : -1)).filter(j => j >= 0);
      c.breaks = r.goals.map((g, j) => (!okM[j] && g.ok ? j : -1)).filter(j => j >= 0);
      c.dc = r1.res.cost - r.res.cost;
    });
    const gt = j => r1.goals[j].text;
    const money = v => v > 0.5 ? ` (+${usd(v)} в месяц)` : v < -0.5 ? ` (−${usd(-v)} в месяц)` : '';
    const worked = [], nw = [];
    if (P.outcome === 'gave') nw.push('Ты открыл эталон события — ниже, что в нём поменяли и что это закрыло. В следующий раз попробуй сам: «Почему?» у красной цели покажет виновника.');
    if (!ch.length) nw.push('Схему не меняли: стартовая схема под испытанием не выдержала.');
    ch.forEach(c => {
      if (c.closes && c.closes.length) worked.push(`${cap1(c.text)} — закрыло цель ${c.closes.map(j => `«${gt(j)}»`).join(', ')}${money(c.dc)}`);
      else if (c.holds && c.holds.length) worked.push(`${cap1(c.text)} — без этого покраснеет ${c.holds.map(j => `«${gt(j)}»`).join(', ')}${money(c.dc)}`);
    });
    /* цели, которые закрыли правки вместе — по одной ни одна не справляется */
    const credited = new Set(ch.flatMap(c => (c.closes || [])));
    r1.goals.forEach((g, j) => {
      if (!g.ok || ok0[j] || credited.has(j) || !ch.length) return;
      const grp = ((D.goals[j] || {}).t === 'cost' ? ch.filter(c => c.dc < -0.5) : ch).slice(0, 4);
      worked.push(`Цель «${g.text}» закрыли правки вместе — ${(grp.length ? grp : ch.slice(0, 4)).map(c => c.text).join('; ')}. По одной ни одна не справляется.`);
    });
    if (P.outcome !== 'fail' && r1.goals.every(g => g.ok)) worked.push(`Все цели зелёные: схема выдержала испытание. Цена в месяц ${usd(r0.res.cost)} → ${usd(r1.res.cost)}.`);
    /* что осталось красным и почему */
    r1.goals.forEach((g, j) => {
      if (g.ok) return;
      let tail = '';
      if (j === r1.goals.findIndex(x => !x.ok)) {
        try {
          const w = SD.learn.analyze(D, mine, j), mk = w && w.marks[0], n = mk && mine.nodes.find(q => q.id === mk.id);
          if (w && w.fix && (D.goals[j] || {}).t === 'cost') tail = `. Можно урезать: ${fixText(mine, w.fix)}`;
          else if (n) tail = `. Виновник — «${nm(n)}»${mk.tag === 'тут проблема' && w.lines[0] ? `: ${w.lines[0].replace(/\.$/, '')}` : ` (${tagTxt(mk.tag)})`}${w.fix ? `; проверенная правка: ${fixText(mine, w.fix)}` : ''}`;
        } catch (err) { tail = ''; }
      }
      const by = ch.filter(c => (c.breaks || []).includes(j));
      nw.push(ok0[j] ? `Сломалась цель «${g.text}»: ${g.detail}${by.length ? `. Дело в правке: ${by.map(c => c.text).join('; ')}` : ''}${tail}` : `Ещё красная: «${g.text}» — ${g.detail}${by.length ? `. Мешает правка: ${by.map(c => c.text).join('; ')}` : ''}${tail}`);
    });
    ch.forEach(c => {
      if (c.closes === undefined) return;
      if (!c.closes.length && !c.holds.length && !c.breaks.length && c.dc > 0.5) nw.push(`${cap1(c.text)} — ни одну цель не закрыло, а стоит +${usd(c.dc)} в месяц`);
    });
    P.changes = ch; P.worked = worked; P.notWorked = nw;
  }

  /* подсказки действий по тому, что нашёл анализ, и две «ловушки» */
  function suggest(P) {
    const { R = P.root, X, e, start } = P, n = R.node ? start.nodes.find(q => q.id === R.node) : null, own = n ? ownerOf(n.type) : 'backend', N = R.name;
    const L = [];
    const storm = R.kind === 'edge' && R.edge && /^повтор/.test(R.etag), cnt = n ? (n.props.count || 1) : 1;
    if (storm && R.stormFix) L.push({ id: 'fix', t: `Экспоненциальная пауза между повторами и предохранитель на связи ${R.ename}${R.stormFix.ok ? '' : ` и запас мощности: ${R.stormFix.more || R.fix}`} (проверено на симуляторе)`, cat: 'cause', own: 'backend', due: '1w', good: true });
    else if (R.fix) L.push({ id: 'fix', t: R.kind === 'cost' ? `Урезать лишнее: ${R.fix} — остальные цели не краснеют (проверено на симуляторе)` : R.kind === 'survive' ? `Добавить запас на отказ: ${R.fix} (проверено на симуляторе)` : `Расширить узкое место: ${R.fix} (проверено на симуляторе)`, cat: 'cause', own, due: '1w', good: true });
    const t = n ? n.type : '';
    const pat = R.kind === 'survive' ? (cnt > 1 ? `Считать запас по правилу N+1: «${N}» должен держать пик без одного из ${cnt} экземпляров` : `Запас на отказ: второй экземпляр «${N}» за балансировщиком, в другой зоне`)
      : storm ? `Лимит повторов (не больше 2) и бюджет повторов на всю связь ${R.ename}, чтобы повторы не били залпом`
      : R.kind === 'cost' ? 'Запас держать только там, где цель требует пережить падение; остальное — по фактической загрузке и с автомасштабированием'
      : R.kind === 'edge' ? `Повторы с экспоненциальной паузой и предохранитель на связи ${R.ename}`
      : t === 'sql' ? (e.id === 'import' ? 'Шарды под записи и загрузка импорта пачками через очередь' : e.id === 'viral' ? 'Кэш перед базой для частых чтений и реплики для остального' : 'Кэш для чтений и реплики базы; записи — пачками через очередь')
      : t === 'nosql' ? 'Больше узлов кластера и ключ, по которому запрос идёт в одну партицию'
      : t === 'cache' ? 'Больше узлов кэша и защита от лавины промахов (single flight)'
      : t === 'queue' ? 'Больше партиций брокера и обработчиков под пик'
      : t === 'worker' ? 'Автомасштабирование обработчиков по длине очереди'
      : t === 'external' ? 'Вызовы внешнего сервиса — через очередь с ограничением скорости и кэш ответов'
      : ['llm', 'router', 'agent'].includes(t) ? 'Кэш ответов модели и запасной провайдер через роутер'
      : n ? `Автомасштабирование «${N}» по загрузке с потолком под пик ${e.chip ? e.chip.replace(/^пик /, '') : ''}`.trim() : 'Запас мощности под пик на самом загруженном узле';
    L.push({ id: 'pat', t: pat, cat: 'cause', own: R.kind === 'cost' ? 'platform' : own, due: '2w', good: true });
    L.push(R.kind === 'cost'
      ? { id: 'alert', t: 'Ежемесячный отчёт о загрузке и цене каждого узла; сигнал, когда счёт выше 90 % бюджета', cat: 'detect', own: 'fin', due: '1w', good: true }
      : R.kind === 'survive' && cnt > 1 ? { id: 'alert', t: `Алерт: загрузка «${N}» выше ${Math.round((cnt - 1) / cnt * 100)} % — дальше без одного экземпляра пик не вытянуть`, cat: 'detect', own: 'sre', due: '3d', good: true }
      : storm ? { id: 'alert', t: `Алерт: доля повторных вызовов на связи ${R.ename} выше 10 % дольше 5 минут`, cat: 'detect', own: 'sre', due: '3d', good: true }
      : { id: 'alert', t: `Алерт: загрузка «${N || 'узла'}» выше 75 % дольше 5 минут — узнаём раньше пользователей`, cat: 'detect', own: 'sre', due: '3d', good: true });
    L.push({ id: 'test', t: X.test, cat: 'respond', own: X.testOwn || 'sre', due: '1m', good: true });
    L.push({ id: 'att', t: 'Быть внимательнее при расчёте нагрузки', cat: 'cause', own: 'backend', due: '1w', good: false, why: 'не действие: нельзя проверить, что сделано' });
    L.push({ id: 'pun', t: 'Найти, кто собирал схему, и разобрать его ошибку на планёрке', cat: 'cause', own: 'backend', due: '3d', good: false, blame: true, why: 'поиск виноватого — ошибки начнут прятать' });
    let h = hash('s' + P.key + e.id);
    P.sug = L.map(o => { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; return { o, r: h }; }).sort((a, b) => a.r - b.r).map(x => x.o);
  }

  /* похожая настоящая авария. Подбираем по механизму корневой причины и честно говорим, чем она похожа:
     тот же механизм («mech»), только риск («risk» — для бюджета), тема уровня («level») или само испытание («event»).
     incidents.js не трогаем — берём из него только тексты аварий. */
  const REL = { mech: 'Похожая по механизму авария', risk: 'Не по механизму, а про риск', level: 'Авария к теме уровня', event: 'Авария к этому испытанию' };
  const DBT = ['sql', 'nosql', 'cache', 'search'];
  function incident(P) {
    const I = SD.incidents; P.inc = null;
    if (!I || !I.INC) return;
    const R = P.root, base = P.D.daily ? P.D.daily.base : P.D.id, lvl = I.BY_LEVEL && I.BY_LEVEL[base];
    const n = R.node ? P.start.nodes.find(q => q.id === R.node) : null, N = R.name, peak = P.e.chip || 'под испытанием';
    let pick = null;
    if (R.kind === 'edge' && R.edge && /^повтор/.test(R.etag)) pick = ['aws2021', 'mech', `Повторы без паузы раздули перегрузку в лавину. У тебя то же на связи ${R.ename}: нагрузка ×${R.edge.amp.toFixed(1).replace('.', ',')}.`];
    else if (R.kind === 'edge') pick = ['aws2021', 'mech', `Задержки и обрывы на связи между сервисами расползлись по системе. У тебя это связь ${R.ename}: ${R.etag}.`];
    else if (R.kind === 'survive') pick = ['aws2011', 'mech', `Не хватило запаса, когда отказала часть системы. У тебя без одного экземпляра «${N}» оставшиеся не вытягивают.`];
    else if (R.kind === 'dead') pick = ['aws2011', 'mech', `Всё, что шло только через одно место, легло вместе с ним. У тебя так с «${N}».`];
    else if ((R.kind === 'hot' || R.kind === 'slow') && n && DBT.includes(n.type)) pick = ['fb2010', 'mech', `Хранилище получило больше запросов, чем может обработать, и перестало отвечать. У Facebook поток создали промахи кэша, у тебя — испытание (${peak}) на «${N}».`];
    else if (R.kind === 'hot') pick = ['aws2021', 'mech', `Всплеск нагрузки упёрся в одно звено, задержки выросли, а повторы клиентов добили систему. У тебя первый шаг тот же: «${N}» упёрся в потолок (${peak}).`];
    else if (R.kind === 'slow') pick = ['aws2021', 'mech', `Задержка в одном звене расползлась на всех, кто его ждёт. У тебя дольше всего запрос стоит в «${N}».`];
    else if (R.kind === 'cost') pick = ['aws2011', 'risk', 'Урезая бюджет, легко срезать и запас на отказ. Эта авария показала, что бывает, когда запаса нет: режь простаивающее, а не резерв.'];
    else if (lvl) pick = [lvl, 'level', `Уровень «${P.B.title}» — про ту же проблему.`];
    else if (P.X.inc) pick = [P.X.inc, 'event', P.X.incWhy];
    if (pick && pick[0] === lvl && pick[1] === 'mech') pick[2] += ` Уровень «${P.B.title}» тоже про неё.`;
    if (pick && I.INC[pick[0]]) P.inc = { id: pick[0], rel: pick[1], why: pick[2], x: I.INC[pick[0]] };
  }

  /* ---------- рабочая копия разбора ---------- */
  let C = null, P = null, W = null, view = 'pm', busy = false;
  function fresh() { return { tab: 'what', chrono: P.chrono.slice(), pick: null, tried: 0, acts: [] }; }

  /* ---------- черновик: несохранённый разбор события переживает повторную проверку и перезагрузку ----------
     Лежит в том же ключе хранилища (S.draft), один на браузер: id = день + событие. saved — совпадает с сохранённой записью. */
  const idOf = ctx => (ctx && ctx.key ? ctx.key : '') + '-' + (ctx && ctx.ev ? ctx.ev.id : '');
  const pid = () => P.key + '-' + (P.e.id || '');
  const draftFor = id => (S.draft && S.draft.id === id && !S.draft.saved ? S.draft : null);
  const edited = () => !!(P && W) && (W.pick != null || W.acts.length > 0 || JSON.stringify(W.chrono) !== JSON.stringify(P.chrono));
  const wsig = () => JSON.stringify([W.chrono, W.pick != null && P.root.opts[W.pick] ? P.root.opts[W.pick].k : null, W.acts]);
  const hm = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${dayTxt(d)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  let dT = 0;
  function keepDraft() { clearTimeout(dT); dT = setTimeout(writeDraft, 250); }
  function writeDraft() {
    clearTimeout(dT);
    if (!P || !W) return;
    const id = pid(), prev = S.draft && S.draft.id === id ? S.draft : null;
    if (!edited()) { if (prev && !prev.saved) { S.draft = null; save(); } return; }
    const pick = W.pick != null ? P.root.opts[W.pick] : null;
    S.draft = { id, key: P.key, ev: P.e.id, evTitle: P.e.title, baseTitle: P.B.title, at: new Date().toISOString(), tab: W.tab, chrono: W.chrono.slice(), pickK: pick ? pick.k : null, acts: copy(W.acts), savedSig: prev ? prev.savedSig || '' : '' };
    S.draft.saved = S.draft.savedSig === wsig();
    save();
  }
  function restore(d) {
    const i = d.pickK ? P.root.opts.findIndex(o => o.k === d.pickK) : -1;
    return { tab: !d.saved && STEPS.some(s => s[0] === d.tab) ? d.tab : 'what', chrono: (d.chrono && d.chrono.length ? d.chrono : P.chrono).slice(), pick: i >= 0 ? i : null, tried: 0, acts: (d.acts || []).map(a => Object.assign({}, a)),
      noteTag: d.saved ? 'Сохранено' : 'Черновик', note: `${d.saved ? 'Это сохранённый разбор' : 'Продолжаешь черновик'} от ${hm(d.at)}: твои строки, ответ и действия на месте. Цифры пересчитаны по схеме на момент последней проверки.` };
  }
  /* «new» — начать заново и выбросить черновик; иначе — продолжить, если он есть */
  function startW(mode) {
    const d = S.draft && S.draft.id === pid() ? S.draft : null;
    if (mode === 'new') { if (d) { S.draft = null; save(); } return fresh(); }
    return d ? restore(d) : fresh();
  }
  /* контекст события из открытого уровня — чтобы продолжить черновик из списка без новой проверки */
  function ctxFromApp() {
    const A = SD.app && SD.app.A, L = A && A.level; if (!L || !L.daily || !L.start || !SD.walk) return null;
    const G = s => { const o = SD.walk.orderOf(L, s); return SD.walk.build(L, s, o, o.length); };
    return { how: 'check', key: L.daily.key, L, ev: ((SD.daily && SD.daily.EV) || []).find(x => x.id === L.daily.ev), base: SD.LEVELS.find(x => x.id === L.daily.base), start: G(L.start), sol: L.solution ? G(L.solution) : null, graph: copy(A.graph), goals: A.goals };
  }
  function draftCtx(d) { if (!d) return null; if (C && idOf(C) === d.id) return C; const c = ctxFromApp(); return c && idOf(c) === d.id ? c : null; }
  const outTxt = o => o === 'ok' ? 'выдержал' : o === 'gave' ? 'открыт эталон' : 'не выдержал';
  function quality() {
    const lines = W.chrono.map(s => s.trim()).filter(Boolean), acts = W.acts.filter(a => a.t.trim());
    const pick = W.pick != null ? P.root.opts[W.pick] : null;
    const blameIn = [...W.chrono, ...W.acts.map(a => a.t)].map(blameOf).find(Boolean);
    const badSug = W.acts.filter(a => a.sug && (P.sug.find(s => s.id === a.sug) || {}).good === false);
    const cats = new Set(acts.map(a => a.cat));
    return [
      ['Хронология: 3–5 строк, от толчка до того, что увидели пользователи', lines.length >= 3 && lines.length <= 5, lines.length < 3 ? 'Допиши: нужно хотя бы 3 строки.' : 'Сократи до 5 строк: суть, а не протокол.'],
      ['Корневая причина подтверждена данными', !!pick && pick.k === 'ok', pick ? `Выбранный ответ ${NOTE[pick.k]}.` : 'Выбери причину на шаге 3.'],
      ['2–4 действия, у каждого владелец и срок', acts.length >= 2 && acts.length <= 4 && acts.every(a => a.own && a.due), acts.length < 2 ? 'Добавь хотя бы два действия.' : acts.length > 4 ? 'Оставь 2–4 главных: длинный список не сделают.' : 'Укажи владельца и срок у каждого.'],
      ['Есть действие на причину и на обнаружение', cats.has('cause') && cats.has('detect'), `Не хватает: ${['cause', 'detect'].filter(c => !cats.has(c)).map(c => label(CAT, c)).join(', ')}.`],
      ['Без поиска виноватых и без пустых обещаний', !blameIn && !badSug.length, blameIn ? `Убери «${blameIn}»: пишем, что изменить в системе, а не кто ошибся.` : `Убери: ${badSug.map(a => `«${a.t}» — ${(P.sug.find(s => s.id === a.sug) || {}).why}`).join('; ')}.`]
    ];
  }

  /* запись для хранилища и экспорта */
  function recOf() {
    const pick = W.pick != null ? P.root.opts[W.pick] : null, Q = quality();
    return {
      id: P.key + '-' + (P.e.id || ''), key: P.key, at: new Date().toISOString(), ev: P.e.id, evTitle: P.e.title, chip: P.e.chip, story: P.e.story || '',
      base: P.B.id, baseTitle: P.B.title, outcome: P.outcome,
      kpis: P.kpis, goals: P.goals.map(g => [g.text, g.b, g.bd, g.a, g.ad, g.m, g.md]),
      chrono: W.chrono.map(s => s.trim()).filter(Boolean),
      root: { right: P.root.right, explain: P.root.explain, pick: pick ? pick.t : '', ok: !!pick && pick.k === 'ok' },
      worked: P.worked, notWorked: P.notWorked,
      acts: W.acts.filter(a => a.t.trim()).map(a => ({ t: a.t.trim(), cat: a.cat, own: a.own, due: a.due, date: a.date || dueDate(a.due) })),
      q: [Q.filter(x => x[1]).length, Q.length],
      inc: P.inc ? { who: P.inc.x.who, when: P.inc.x.when, what: P.inc.x.what, lesson: P.inc.x.lesson, why: P.inc.why, rel: P.inc.rel } : null
    };
  }
  const mdc = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  function toMd(r) {
    const d = keyDate(r.key), L = [];
    L.push(`# Разбор аварии: ${cap1(r.evTitle)} — «${r.baseTitle}»`, '');
    L.push(`Дата: ${dayTxt(d)} ${d.getFullYear()} · Событие дня: ${r.evTitle} (${r.chip}) · Итог: ${outTxt(r.outcome)}`);
    L.push('Формат: без поиска виноватых (blameless) — как разбор матча после игры: не кто виноват, а что изменить.', '');
    L.push('## Что случилось', '');
    if (r.story) L.push(r.story, '');
    L.push('| Показатель | Обычный день | Под испытанием |', '|---|---|---|');
    r.kpis.forEach(k => L.push(`| ${mdc(k[0])} | ${mdc(k[1])} | ${mdc(k[2])} |`));
    L.push('', '| Цель | Обычный день | Старт под испытанием | Моя схема |', '|---|---|---|---|');
    r.goals.forEach(g => L.push(`| ${mdc(g[0])} | ${g[1] ? '✓' : '✗'} ${mdc(g[2])} | ${g[3] ? '✓' : '✗'} ${mdc(g[4])} | ${g[5] ? '✓' : '✗'} ${mdc(g[6])} |`));
    L.push('', '## Хронология', '');
    r.chrono.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push('', '## Корневая причина', '', `**${r.root.right}.**`, '', r.root.explain.trim());
    if (r.root.pick) L.push('', `Мой ответ: «${r.root.pick}» — ${r.root.ok ? 'совпал с анализом' : 'не совпал с анализом'}.`);
    L.push('', '## Что сработало и что нет', '', '### Сработало', '');
    (r.worked.length ? r.worked : ['Пока нечего отметить.']).forEach(s => L.push(`- ${s}`));
    L.push('', '### Не сработало', '');
    (r.notWorked.length ? r.notWorked : ['Замечаний нет.']).forEach(s => L.push(`- ${s}`));
    L.push('', '## Действия', '');
    if (r.acts.length) { L.push('| # | Действие | Тип | Владелец | Срок |', '|---|---|---|---|---|'); r.acts.forEach((a, i) => L.push(`| ${i + 1} | ${mdc(a.t)} | ${label(CAT, a.cat)} | ${label(OWN, a.own)} | ${mdc(a.date)} |`)); }
    else L.push('Действий пока нет.');
    L.push('', `Качество разбора: ${r.q[0]} из ${r.q[1]}.`);
    if (r.inc) L.push('', '## Как это было в жизни', '', `**${r.inc.who} · ${r.inc.when}.** ${r.inc.rel && REL[r.inc.rel] ? `_${REL[r.inc.rel]}._ ` : ''}${r.inc.why}`, '', r.inc.what, '', `Урок: ${r.inc.lesson}`, '', '_По публичному разбору компании, пересказ._');
    L.push('', '---', '_AMP Стройплощадка · разбор события дня_');
    return L.join('\n');
  }

  /* ---------- экспорт ---------- */
  function copyMd(md) {
    const done = () => toast('Markdown скопирован — вставь в заметки или в задачу.');
    const fallback = () => {
      const ta = document.createElement('textarea'); ta.value = md; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove();
      toast(ok ? 'Markdown скопирован — вставь в заметки или в задачу.' : 'Не получилось скопировать: открой «Посмотреть Markdown» и скопируй вручную.');
    };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md).then(done, fallback); else fallback(); } catch (e) { fallback(); }
  }
  function download(md, r) {
    const name = `postmortem-${r.key || 'day'}-${r.ev || 'event'}.md`;
    try {
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
      toast(`Файл ${name} сохранён в загрузки.`);
    } catch (e) { toast('Не получилось скачать файл — скопируй Markdown.'); }
  }
  const toast = m => { if (SD.app && SD.app.toast) SD.app.toast(m); };

  /* ---------- окно ---------- */
  const STEPS = [['what', '1', 'Что случилось'], ['chrono', '2', 'Хронология'], ['root', '3', 'Причина'], ['diff', '4', 'Что сработало'], ['act', '5', 'Действия'], ['sum', '✓', 'Итог']];
  function modal() {
    let m = $('pm2Modal');
    if (m) return m;
    m = document.createElement('div'); m.className = 'modal pm2-modal'; m.id = 'pm2Modal'; m.hidden = true;
    m.innerHTML = '<div class="sheet pm2-sheet" role="dialog" aria-modal="true" aria-labelledby="pm2Title"><div class="sheet-head pm2-head"><span class="pm2-eyebrow">Разбор аварии</span><h2 id="pm2Title"></h2><button type="button" class="btn ghost pm2-hbtn" data-pm2-list>Прошлые разборы</button><button class="btn ghost x" type="button" data-pm2-x>Закрыть</button></div><div class="pm2-body" id="pm2Body"></div></div>';
    document.body.appendChild(m);
    const after = () => { if (P && W && view === 'pm') keepDraft(); };
    m.addEventListener('click', e => { onClick(e); after(); });
    m.addEventListener('input', e => { onInput(e); after(); });
    m.addEventListener('change', e => { onChange(e); after(); });
    return m;
  }
  function close() {
    const m = $('pm2Modal'); if (!m || m.hidden) return;
    m.hidden = true;
    if (P && W) { writeDraft(); if (draftFor(pid())) toast('Черновик разбора сохранён в браузере: продолжить можно после следующей проверки или из «Прошлых разборов».'); }
  }
  function open(ctx, mode) {
    if (ctx) { if (P && W) writeDraft(); C = ctx; P = null; W = null; }
    if (!C) { openList(); return; }
    hideOffer();
    document.querySelectorAll('.modal').forEach(x => { if (x.id !== 'pm2Modal') x.hidden = true; });
    const m = modal(); m.hidden = false; view = 'pm';
    if (!P) {
      busy = true; $('pm2Title').textContent = 'Собираю разбор…';
      $('pm2Body').innerHTML = '<div class="pm2-wait"><span class="pm2-spin" aria-hidden="true"></span>Гоняю стартовую схему через испытание и ищу виновников — пара секунд.</div>';
      setTimeout(() => {
        try { P = analyze(C); W = startW(mode); } catch (err) { P = null; busy = false; $('pm2Body').innerHTML = `<div class="pm2-wait">Не получилось собрать разбор: ${esc(err && err.message)}</div>`; return; }
        busy = false; render();
      }, 30);
      return;
    }
    if (mode === 'new') W = startW('new');
    render();
  }
  function openList() {
    document.querySelectorAll('.modal').forEach(x => { if (x.id !== 'pm2Modal') x.hidden = true; });
    const m = modal(); m.hidden = false; view = 'list'; render();
  }

  const ana = () => `<div class="pm2-ana"><p class="pm2-life"><span class="pm2-tag">Как в жизни</span><b>Как разбор матча после игры:</b> команда пересматривает запись не чтобы найти, кто виноват в пропущенном голе, а чтобы понять, что изменить к следующей игре.</p><p>Здесь так же: смотрим, что испытание сделало со стартовой схемой, собираем цепочку событий, находим настоящую причину и записываем, что изменить — с владельцем и сроком.</p><p><span class="pm2-tag t">Термин</span><b>Постмортем</b> (postmortem) — разбор аварии без поиска виноватых (blameless): хронология, корневая причина (root cause) и действия (action items).</p></div>`;
  const hint = (tag, html) => `<p class="pm2-hint"><span class="pm2-tag t">${tag}</span>${html}</p>`;
  const badge = o => `<span class="pm2-out ${o === 'ok' ? 'ok' : o === 'gave' ? 'warn' : 'bad'}">${o === 'ok' ? '✓ выдержал' : o === 'gave' ? 'открыт эталон' : '✗ не выдержал'}</span>`;
  const mark = ok => `<i class="pm2-mk ${ok ? 'ok' : 'bad'}" aria-label="${ok ? 'выполнена' : 'не выполнена'}">${ok ? '✓' : '✗'}</i>`;

  function render() {
    const m = modal(), body = $('pm2Body'); if (!body) return;
    const n = S.list.length;
    const lb = m.querySelector('.pm2-hbtn');
    if (lb) lb.outerHTML = view === 'pm' ? `<button type="button" class="btn ghost pm2-hbtn" data-pm2-list>Прошлые разборы${n ? ' (' + n + ')' : ''}</button>`
      : P && W ? '<button type="button" class="btn ghost pm2-hbtn" data-pm2-cur>← К текущему разбору</button>' : '<span class="pm2-hbtn" hidden></span>';
    if (view === 'list') { $('pm2Title').textContent = 'Прошлые разборы'; body.innerHTML = listHtml(); return; }
    if (view.startsWith('saved:')) { const r = S.list.find(x => x.id === view.slice(6)); if (!r) { view = 'list'; render(); return; } $('pm2Title').textContent = `${cap1(r.evTitle)} · ${dayTxt(keyDate(r.key))}`; body.innerHTML = savedHtml(r); return; }
    if (!P || !W) return;
    $('pm2Title').textContent = `${cap1(P.e.title)} · «${P.B.title}»`;
    const i = STEPS.findIndex(s => s[0] === W.tab);
    let h = `<nav class="pm2-steps" aria-label="Шаги разбора">${STEPS.map(([id, num0, t], j) => `<button type="button" data-pm2-tab="${id}" class="${id === W.tab ? 'on' : ''} ${j < i ? 'done' : ''}" aria-current="${id === W.tab ? 'step' : 'false'}"><i>${num0}</i>${t}</button>`).join('')}</nav>`;
    h += `<div class="pm2-pane">${W.note ? hint(W.noteTag || 'Черновик', esc(W.note)) : ''}${VIEWS[W.tab]()}</div>`;
    if (i < STEPS.length - 1) h += `<div class="pm2-nav">${i > 0 ? `<button type="button" class="btn" data-pm2-tab="${STEPS[i - 1][0]}">← ${STEPS[i - 1][2]}</button>` : ''}<button type="button" class="btn primary" data-pm2-tab="${STEPS[i + 1][0]}">Дальше: ${STEPS[i + 1][2].toLowerCase()} →</button></div>`;
    else h += `<div class="pm2-nav"><button type="button" class="btn" data-pm2-tab="${STEPS[i - 1][0]}">← ${STEPS[i - 1][2]}</button></div>`;
    body.innerHTML = h;
    body.scrollTop = 0;
    body.querySelectorAll('.pm2-in').forEach(fit);
    const on = body.querySelector('.pm2-steps .on'); if (on) on.parentNode.scrollLeft = Math.max(0, on.offsetLeft - on.parentNode.offsetLeft - 16);
  }

  const VIEWS = {
    what() {
      let h = ana();
      h += `<div class="pm2-top">${badge(P.outcome)}<span>Эталон уровня «${esc(P.B.title)}» под испытанием «${esc(P.e.title)}» (${esc(P.e.chip)}).</span></div>`;
      if (P.e.story) h += `<p class="pm2-lede">${esc(P.e.story)}</p>`;
      h += `<h3 class="pm2-h">Цифры: обычный день и испытание</h3><div class="pm2-tw"><table class="pm2-t"><thead><tr><th>Показатель</th><th>Обычный день</th><th>Под испытанием</th></tr></thead><tbody>${P.kpis.map(k => `<tr><td>${esc(k[0])}</td><td>${esc(k[1])}</td><td><b>${esc(k[2])}</b></td></tr>`).join('')}</tbody></table></div>`;
      h += `<h3 class="pm2-h">Цели: какие покраснели</h3><ul class="pm2-goals">${P.goals.map(g => `<li class="${g.a ? '' : 'bad'}"><span class="pm2-gt">${esc(g.text)}</span><span class="pm2-gv">${mark(g.b)}<small>${esc(g.bd)}</small></span><span class="pm2-arr" aria-hidden="true">→</span><span class="pm2-gv">${mark(g.a)}<small>${esc(g.ad)}</small></span></li>`).join('')}</ul>`;
      h += `<p class="pm2-small">Цифры — прогон симулятора: стартовая схема (эталон уровня) в обычный день и под испытанием. Слева — до, справа — после.</p>`;
      return h;
    },
    chrono() {
      let h = hint('Хронология (timeline)', 'цепочка «что за чем случилось»: от толчка до того, что увидели пользователи. Собрал её из прогона и разбора виновников — поправь текст или порядок, если видишь иначе.');
      const n = W.chrono.filter(s => s.trim()).length;
      h += `<ol class="pm2-lines">${W.chrono.map((s, i) => { const b = blameOf(s); return `<li class="pm2-line ${b ? 'pm2-blame' : ''}"><span class="pm2-ln">${i + 1}</span><div class="pm2-lf"><textarea class="pm2-in" rows="1" data-pm2-line="${i}" aria-label="Строка хронологии ${i + 1}">${esc(s)}</textarea><small class="pm2-bn">${b ? blameMsg(b) : ''}</small></div><span class="pm2-lb"><button type="button" class="pm2-ib" data-pm2-up="${i}" aria-label="Выше" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="pm2-ib" data-pm2-down="${i}" aria-label="Ниже" ${i === W.chrono.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="pm2-ib" data-pm2-del="${i}" aria-label="Убрать строку">✕</button></span></li>`; }).join('')}</ol>`;
      h += `<div class="pm2-row"><button type="button" class="btn" data-pm2-addline ${W.chrono.length >= 6 ? 'disabled' : ''}>+ Строка</button><button type="button" class="btn ghost" data-pm2-reset>Вернуть как собрал анализ</button><span class="pm2-cnt ${n >= 3 && n <= 5 ? 'ok' : 'warn'}" id="pm2Cnt">${cntTxt(n)}</span></div>`;
      h += `<p class="pm2-chain" aria-label="Коротко">${P.chrono.map(s => `<span>${esc(short(s))}</span>`).join('<i aria-hidden="true">→</i>')}</p>`;
      return h;
    },
    root() {
      const R = P.root;
      let h = hint('Корневая причина (root cause)', 'то, что надо изменить, чтобы авария не повторилась. Не «кто», а «что в системе». Выбери ответ, который подтверждают цифры разбора.');
      if (!R.opts.length) return h + '<p class="pm2-lede">Стартовая схема выдержала испытание — разбирать нечего.</p>';
      h += `<b class="pm2-q">Почему испытание сломало стартовую схему?</b><div class="pm2-picks">${R.opts.map((o, j) => `<button type="button" data-pm2-pick="${j}" aria-pressed="${W.pick === j}" class="${W.pick === j ? o.k : ''}">${esc(o.t)}</button>`).join('')}</div>`;
      if (W.pick != null) {
        const o = R.opts[W.pick];
        h += o.k === 'ok' ? `<div class="pm2-verdict ok"><b>Верно — это подтверждают цифры.</b><p>${esc(R.explain.trim())}</p></div>`
          : `<div class="pm2-verdict warn"><b>Этот ответ ${esc(o.why)}.</b><p>Подсказка: загляни в шаг «Хронология» — где загрузка выше 100 % или где запрос стоит дольше всего? Выбери другой ответ.</p></div>`;
      }
      const more = P.why.slice(1).map(o => { const mk = o.w.marks[0], n = mk && P.start.nodes.find(q => q.id === mk.id); return n ? `«${esc(o.g.text)}»: виновник «${esc(nm(n))}» — ${esc(tagTxt(mk.tag))}` : ''; }).filter(Boolean);
      if (more.length) h += `<div class="pm2-box"><b>Что ещё нашёл анализ</b><ul>${more.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
      return h;
    },
    diff() {
      let h = hint('Сравнение', 'твоя схема против стартовой. Каждую правку я по очереди откатывал и перепроверял: так видно, какую цель держит именно она.');
      h += `<div class="pm2-top">${badge(P.outcome)}<span>Цена в месяц: старт ${usd(P.r0.res.cost)} → твоя схема ${usd(P.r1.res.cost)}.</span></div>`;
      h += `<div class="pm2-tw"><table class="pm2-t"><thead><tr><th>Цель</th><th>Старт под испытанием</th><th>Твоя схема</th></tr></thead><tbody>${P.goals.map(g => `<tr><td>${esc(g.text)}</td><td>${mark(g.a)} <small>${esc(g.ad)}</small></td><td>${mark(g.m)} <small>${esc(g.md)}</small></td></tr>`).join('')}</tbody></table></div>`;
      h += `<div class="pm2-two"><section class="pm2-box ok"><b>Что сработало</b>${P.worked.length ? `<ul>${P.worked.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Пока ни одна правка не закрыла красную цель.</p>'}</section><section class="pm2-box warn"><b>Что не сработало</b>${P.notWorked.length ? `<ul>${P.notWorked.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Замечаний нет: лишних правок не нашёл.</p>'}</section></div>`;
      if (P.changes.length) h += `<details class="pm2-det"><summary>Все правки (${P.changes.length})</summary><ul>${P.changes.map(c => `<li>${esc(cap1(c.text))}</li>`).join('')}</ul></details>`;
      return h;
    },
    act() {
      let h = hint('Действия (action items)', 'задачи с владельцем и сроком: на причину, на обнаружение и на реакцию. Владелец — команда или роль, не человек: так разбор остаётся без обвинений.');
      h += `<p class="pm2-rule"><b>Правило разбора:</b> без имён и обвинений — пишем, что изменить в системе. Слова вроде «виноват» подсвечу.</p>`;
      h += `<h3 class="pm2-h">Подсказки из анализа</h3><div class="pm2-sugs">${P.sug.map(s => { const on = W.acts.some(a => a.sug === s.id); return `<div class="pm2-sug ${on ? 'on' : ''}"><span>${esc(s.t)}</span><small>${label(CAT, s.cat)} · ${label(OWN, s.own)}</small><button type="button" class="btn ${on ? 'ghost' : ''}" data-pm2-sug="${s.id}" ${on ? 'disabled' : ''}>${on ? 'В списке' : '+ Добавить'}</button></div>`; }).join('')}</div>`;
      h += `<h3 class="pm2-h">Твои действия <span class="pm2-cnt ${W.acts.length >= 2 && W.acts.length <= 4 ? 'ok' : 'warn'}">${W.acts.length} из 2–4</span></h3>`;
      h += W.acts.length ? `<div class="pm2-acts">${W.acts.map((a, i) => actRow(a, i)).join('')}</div>` : '<p class="pm2-small">Добавь 2–4 пункта из подсказок или напиши свои.</p>';
      h += `<div class="pm2-row"><button type="button" class="btn" data-pm2-addact ${W.acts.length >= 6 ? 'disabled' : ''}>+ Своё действие</button></div>`;
      return h;
    },
    sum() {
      const Q = quality(), sc = Q.filter(x => x[1]).length, r = recOf();
      const saved = S.list.find(x => x.id === r.id);
      let h = `<div class="pm2-sumhead"><div><b>Разбор: ${esc(P.e.title)} — «${esc(P.B.title)}»</b><span>${dayTxt(keyDate(P.key))} · ${outTxt(P.outcome)} · ${saved ? 'сохранён' : 'черновик'}</span></div><div class="pm2-score ${sc === Q.length ? 'ok' : sc >= 3 ? 'warn' : 'bad'}"><b>${sc}/${Q.length}</b><span>качество</span></div></div>`;
      h += `<ul class="pm2-q5">${Q.map(([t, ok, tip]) => `<li class="${ok ? 'ok' : 'warn'}"><b>${esc(t)}.</b>${ok ? '' : ' ' + esc(tip)}</li>`).join('')}</ul>`;
      h += `<div class="pm2-row"><button type="button" class="btn primary" data-pm2-save>${saved ? 'Сохранить заново' : 'Сохранить разбор'}</button><button type="button" class="btn" data-pm2-copy>Скопировать Markdown</button><button type="button" class="btn" data-pm2-dl>Скачать .md</button><button type="button" class="btn ghost" data-pm2-list>Прошлые разборы (${S.list.length})</button></div>`;
      h += `<details class="pm2-det"><summary>Посмотреть Markdown</summary><pre class="pm2-md" id="pm2Md">${esc(toMd(r))}</pre></details>`;
      h += incHtml(P.inc && { who: P.inc.x.who, when: P.inc.x.when, what: P.inc.x.what, lesson: P.inc.x.lesson, why: P.inc.why, rel: P.inc.rel });
      return h;
    }
  };
  /* поле растёт под текст: на узком экране строка хронологии не прячется за прокруткой */
  const fit = el => { if (!el || !el.scrollHeight) return; el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; };
  /* метки виновников из «Почему?» — в обычные фразы */
  const tagTxt = t => { t = String(t || ''); return /^упадёт — /.test(t) ? 'при падении одного экземпляра ' + t.replace(/^упадёт — /, '') : /^перегружен: /.test(t) ? 'загрузка ' + pu(+t.replace(/\D/g, '') / 100) : t; };
  const short = s => { const t = String(s).split(/[:—]/)[0].trim(); return t.length > 42 ? t.slice(0, 40) + '…' : t; };
  const cntTxt = n => `Строк: ${n}${n >= 3 && n <= 5 ? ' — хорошо' : n < 3 ? ' — нужно хотя бы 3' : ' — сократи до 5'}`;
  const blameMsg = b => `Похоже на поиск виноватого: «${esc(b)}». Опиши, что изменить в системе — процесс, проверку, схему.`;
  function actRow(a, i) {
    const b = blameOf(a.t), sg = a.sug && P.sug.find(s => s.id === a.sug), bad = sg && !sg.good;
    const sel = (name, list, v, lab) => `<label class="pm2-sel"><span>${lab}</span><select data-pm2-${name}="${i}">${name === 'own' && !v ? '<option value="">— выбери —</option>' : ''}${list.map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
    return `<div class="pm2-act ${b ? 'pm2-blame' : ''} ${bad ? 'bad' : ''}"><div class="pm2-lf"><textarea class="pm2-in" rows="1" data-pm2-act="${i}" aria-label="Действие ${i + 1}" placeholder="Что изменить в системе">${esc(a.t)}</textarea><small class="pm2-bn">${b ? blameMsg(b) : bad ? esc('Ловушка: ' + sg.why + '.') : ''}</small></div><div class="pm2-acf">${sel('cat', CAT, a.cat, 'Тип')}${sel('own', OWN, a.own, 'Владелец')}${sel('due', DUE.map(d => [d[0], `${d[1]} · до ${dueDate(d[0])}`]), a.due, 'Срок')}<button type="button" class="pm2-ib" data-pm2-rmact="${i}" aria-label="Убрать действие">✕</button></div></div>`;
  }
  function incHtml(x) {
    if (!x) return '';
    return `<section class="pm2-inc"><span class="pm2-tag">Как это было в жизни</span><b>${esc(x.who)} · ${esc(x.when)}</b>${x.why ? `<p class="pm2-incwhy">${x.rel && REL[x.rel] ? `<b>${esc(REL[x.rel])}.</b> ` : ''}${esc(x.why)}</p>` : ''}<p>${esc(x.what)}</p><p><b>Урок:</b> ${esc(x.lesson)}</p><small>По публичному разбору компании, пересказ.</small></section>`;
  }

  /* ---------- прошлые разборы ---------- */
  function draftRow() {
    const d = S.draft; if (!d || d.saved) return '';
    const can = !!draftCtx(d);
    return `<div class="pm2-box warn"><b>Несохранённый черновик</b><p>${esc(cap1(d.evTitle))} · «${esc(d.baseTitle)}» — изменён ${esc(hm(d.at))}.</p><div class="pm2-row">${can ? '<button type="button" class="btn primary" data-pm2-draft>Продолжить</button>' : '<span class="pm2-small">Продолжить можно в «Событии дня» того же дня: открой событие и проверь решение — появится кнопка.</span>'}<button type="button" class="btn ghost" data-pm2-dropdraft>Удалить черновик</button></div></div>`;
  }
  function listHtml() {
    if (!S.list.length) return `<div class="pm2-pane">${draftRow()}${ana()}<p class="pm2-lede">Сохранённых разборов пока нет. Проверь решение в «Событии дня» — появится кнопка «Разобрать, как разбирают аварии».</p></div>`;
    const rows = S.list.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return `<div class="pm2-pane">${draftRow()}<p class="pm2-small">Хранятся в этом браузере. Открой разбор, чтобы перечитать, скопировать или скачать Markdown.</p><ul class="pm2-list">${rows.map(r => `<li><div class="pm2-li"><b>${esc(cap1(r.evTitle))} · «${esc(r.baseTitle)}»</b><span>${dayTxt(keyDate(r.key))} ${keyDate(r.key).getFullYear()} · ${badge(r.outcome)} · качество ${r.q[0]} из ${r.q[1]}</span><small>${esc(r.root.right)}</small></div><div class="pm2-lia"><button type="button" class="btn" data-pm2-view="${esc(r.id)}">Открыть</button><button type="button" class="btn ghost" data-pm2-rm="${esc(r.id)}">Удалить</button></div></li>`).join('')}</ul></div>`;
  }
  function savedHtml(r) {
    let h = `<div class="pm2-pane"><div class="pm2-top">${badge(r.outcome)}<span>Эталон уровня «${esc(r.baseTitle)}» под испытанием «${esc(r.evTitle)}» (${esc(r.chip)}). Качество разбора: ${r.q[0]} из ${r.q[1]}.</span></div>`;
    h += `<div class="pm2-row"><button type="button" class="btn" data-pm2-back>← К списку</button><button type="button" class="btn" data-pm2-copy="${esc(r.id)}">Скопировать Markdown</button><button type="button" class="btn" data-pm2-dl="${esc(r.id)}">Скачать .md</button></div>`;
    h += `<h3 class="pm2-h">Что случилось</h3><div class="pm2-tw"><table class="pm2-t"><thead><tr><th>Показатель</th><th>Обычный день</th><th>Под испытанием</th></tr></thead><tbody>${r.kpis.map(k => `<tr><td>${esc(k[0])}</td><td>${esc(k[1])}</td><td><b>${esc(k[2])}</b></td></tr>`).join('')}</tbody></table></div>`;
    h += `<h3 class="pm2-h">Хронология</h3><ol class="pm2-ro">${r.chrono.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
    h += `<h3 class="pm2-h">Корневая причина</h3><div class="pm2-verdict ok"><b>${esc(r.root.right)}.</b><p>${esc(r.root.explain)}</p></div>`;
    h += `<div class="pm2-two"><section class="pm2-box ok"><b>Что сработало</b><ul>${(r.worked.length ? r.worked : ['—']).map(x => `<li>${esc(x)}</li>`).join('')}</ul></section><section class="pm2-box warn"><b>Что не сработало</b><ul>${(r.notWorked.length ? r.notWorked : ['—']).map(x => `<li>${esc(x)}</li>`).join('')}</ul></section></div>`;
    h += `<h3 class="pm2-h">Действия</h3>${r.acts.length ? `<div class="pm2-tw"><table class="pm2-t"><thead><tr><th>Действие</th><th>Тип</th><th>Владелец</th><th>Срок</th></tr></thead><tbody>${r.acts.map(a => `<tr><td>${esc(a.t)}</td><td>${label(CAT, a.cat)}</td><td>${label(OWN, a.own)}</td><td>${esc(a.date)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="pm2-small">Действий не записали.</p>'}`;
    return h + incHtml(r.inc) + '</div>';
  }

  /* ---------- события в окне ---------- */
  function onClick(e) {
    const m = $('pm2Modal'), t = e.target;
    if (t === m || t.closest('[data-pm2-x]')) { close(); return; }
    const q = sel => t.closest(sel);
    let b;
    if ((b = q('[data-pm2-back]'))) { view = 'list'; render(); return; }
    if ((b = q('[data-pm2-cur]'))) { view = P && W ? 'pm' : 'list'; render(); return; }
    if ((b = q('[data-pm2-list]'))) { view = 'list'; render(); return; }
    if (q('[data-pm2-draft]')) { const c = draftCtx(S.draft); if (c) open(c, 'draft'); return; }
    if (q('[data-pm2-dropdraft]')) { const id = S.draft && S.draft.id; S.draft = null; save(); if (P && W && id === pid()) W = fresh(); render(); toast('Черновик удалён.'); return; }
    if ((b = q('[data-pm2-view]'))) { view = 'saved:' + b.dataset.pm2View; render(); return; }
    if ((b = q('[data-pm2-rm]'))) { const id = b.dataset.pm2Rm; S.list = S.list.filter(x => x.id !== id); save(); render(); refreshCard(); toast('Разбор удалён.'); return; }
    if ((b = q('[data-pm2-copy]'))) { const r = b.dataset.pm2Copy ? S.list.find(x => x.id === b.dataset.pm2Copy) : recOf(); if (r) copyMd(toMd(r)); return; }
    if ((b = q('[data-pm2-dl]'))) { const r = b.dataset.pm2Dl ? S.list.find(x => x.id === b.dataset.pm2Dl) : recOf(); if (r) download(toMd(r), r); return; }
    if (!P || !W || busy) return;
    if ((b = q('[data-pm2-tab]'))) { W.tab = b.dataset.pm2Tab; W.note = ''; render(); return; }
    if ((b = q('[data-pm2-up]'))) { const i = +b.dataset.pm2Up; if (i > 0) { [W.chrono[i - 1], W.chrono[i]] = [W.chrono[i], W.chrono[i - 1]]; render(); } return; }
    if ((b = q('[data-pm2-down]'))) { const i = +b.dataset.pm2Down; if (i < W.chrono.length - 1) { [W.chrono[i + 1], W.chrono[i]] = [W.chrono[i], W.chrono[i + 1]]; render(); } return; }
    if ((b = q('[data-pm2-del]'))) { W.chrono.splice(+b.dataset.pm2Del, 1); render(); return; }
    if (q('[data-pm2-addline]')) { if (W.chrono.length < 6) { W.chrono.push(''); render(); const all = document.querySelectorAll('#pm2Body [data-pm2-line]'); if (all.length) all[all.length - 1].focus(); } return; }
    if (q('[data-pm2-reset]')) { W.chrono = P.chrono.slice(); render(); return; }
    if ((b = q('[data-pm2-pick]'))) { W.pick = +b.dataset.pm2Pick; W.tried++; render(); return; }
    if ((b = q('[data-pm2-sug]'))) { const s = P.sug.find(x => x.id === b.dataset.pm2Sug); if (s && !W.acts.some(a => a.sug === s.id)) { W.acts.push({ t: s.t, cat: s.cat, own: s.own, due: s.due, sug: s.id }); render(); } return; }
    if (q('[data-pm2-addact]')) { W.acts.push({ t: '', cat: 'cause', own: '', due: '2w', sug: null }); render(); const all = document.querySelectorAll('#pm2Body [data-pm2-act]'); if (all.length) all[all.length - 1].focus(); return; }
    if ((b = q('[data-pm2-rmact]'))) { W.acts.splice(+b.dataset.pm2Rmact, 1); render(); return; }
    if (q('[data-pm2-save]')) {
      const r = recOf(), i = S.list.findIndex(x => x.id === r.id);
      if (i >= 0) S.list[i] = r; else S.list.push(r);
      if (S.list.length > 60) S.list = S.list.slice(-60);
      writeDraft(); if (S.draft && S.draft.id === r.id) { S.draft.savedSig = wsig(); S.draft.saved = true; }
      toast(save() ? 'Разбор сохранён. Прошлые разборы — на карточке «Событие дня» в «Уровнях».' : 'Хранилище браузера недоступно — скопируй или скачай Markdown.');
      render(); refreshCard();
    }
  }
  function onInput(e) {
    const t = e.target; if (!W) return;
    let row = null;
    if (t.matches('[data-pm2-line]')) { W.chrono[+t.dataset.pm2Line] = t.value; row = t.closest('.pm2-line'); const n = W.chrono.filter(s => s.trim()).length, c = $('pm2Cnt'); if (c) { c.textContent = cntTxt(n); c.className = 'pm2-cnt ' + (n >= 3 && n <= 5 ? 'ok' : 'warn'); } }
    else if (t.matches('[data-pm2-act]')) { const a = W.acts[+t.dataset.pm2Act]; a.t = t.value; if (a.sug && a.t !== (P.sug.find(s => s.id === a.sug) || {}).t) a.sug = null; row = t.closest('.pm2-act'); }
    if (!row) return;
    fit(t);
    const b = blameOf(t.value);
    row.classList.toggle('pm2-blame', !!b);
    const note = row.querySelector('.pm2-bn'); if (note) note.innerHTML = b ? blameMsg(b) : '';
  }
  function onChange(e) {
    const t = e.target; if (!W) return;
    ['cat', 'own', 'due'].forEach(k => { const v = t.getAttribute('data-pm2-' + k); if (v != null) { W.acts[+v][k] = t.value; if (k === 'due') W.acts[+v].date = dueDate(t.value); } });
  }

  /* ---------- кнопка после проверки ---------- */
  function offer(ctx) {
    if (!ctx || !ctx.L) return;
    if (P && W) writeDraft();
    C = ctx; P = null; W = null;
    const d = draftFor(idOf(ctx)), stepT = d ? (STEPS.find(s => s[0] === d.tab) || STEPS[0])[2] : '';
    let o = $('pm2Offer');
    if (!o) { o = document.createElement('div'); o.id = 'pm2Offer'; o.className = 'pm2-offer'; o.setAttribute('role', 'status'); document.body.appendChild(o); }
    const goals = (SD.app && SD.app.A && SD.app.A.goals) || ctx.goals || [], bad = goals.filter(g => !g.ok).length;
    const sol = ctx.how === 'gave' || (!!ctx.sol && !!ctx.graph && gsig(ctx.sol) === gsig(ctx.graph));
    const head = sol ? 'Ты открыл эталон события' : bad ? `Схема не выдержала: красных целей ${bad} из ${goals.length}` : 'Событие выдержано ✓';
    const sub = sol ? 'Разбери, что в нём поменяли и почему это помогло.' : bad ? 'Самое время для разбора: что случилось и что изменить.' : 'Разбери, что именно сработало, — так это запомнится.';
    o.innerHTML = d
      ? `<b>${esc(head)}</b><span>${esc(sub)}</span><span class="pm2-small">Есть несохранённый разбор этого события: изменён ${esc(hm(d.at))}, шаг «${esc(stepT)}». Продолжить его или начать заново?</span><div class="pm2-oa"><button type="button" class="btn primary" data-pm2-open="draft">Продолжить разбор</button><button type="button" class="btn" data-pm2-open="new">Начать заново</button><button type="button" class="btn ghost" data-pm2-hide>Позже</button></div>`
      : `<b>${esc(head)}</b><span>${esc(sub)} Как разбор матча после игры: не кто виноват, а что изменить.</span><div class="pm2-oa"><button type="button" class="btn primary" data-pm2-open>Разобрать, как разбирают аварии</button><button type="button" class="btn ghost" data-pm2-hide>Позже</button></div>`;
    o.hidden = false;
  }
  function hideOffer() { const o = $('pm2Offer'); if (o) o.hidden = true; }

  /* ссылка на прошлые разборы под карточкой события (зовёт daily.js в карте уровней) */
  function cardLink() {
    const n = S.list.length;
    return `<div class="pm2-cardlink">${n ? `<button type="button" class="linkish" data-pm2-openlist>Прошлые разборы аварий: ${n}</button>` : '<span>После проверки — разбор аварии, как у инженеров.</span>'}</div>`;
  }
  function refreshCard() { document.querySelectorAll('.pm2-cardlink').forEach(el => { el.outerHTML = cardLink(); }); }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', e => {
      const op = e.target.closest('[data-pm2-open]'); if (op) { open(null, op.getAttribute('data-pm2-open') || ''); return; }
      if (e.target.closest('[data-pm2-hide]')) { hideOffer(); return; }
      if (e.target.closest('[data-pm2-openlist]')) { openList(); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { const m = $('pm2Modal'); if (m && !m.hidden) { e.stopPropagation(); close(); } } }, true);
    /* закрыл вкладку посреди разбора — черновик не теряется */
    window.addEventListener('pagehide', () => { if (P && W) writeDraft(); });
    /* ушёл с уровня события — кнопка разбора больше не к месту */
    setInterval(() => { const o = $('pm2Offer'), A = SD.app && SD.app.A; if (o && !o.hidden && C && A && A.level && A.level.id !== C.L.id) o.hidden = true; }, 800);
  }

  /* Ctrl+K: прошлые разборы аварий */
  (SD.cmdExtra = SD.cmdExtra || []).push(add => add('Учиться', 'Прошлые разборы аварий', 'постмортемы после «События дня»', () => openList(), 'постмортем postmortem авария разбор инцидент blameless'));
  SD.postmortem = { offer, open, openList, close, cardLink, analyze, toMd, markdown: () => (P && W ? toMd(recOf()) : ''), list: () => S.list.slice(), draft: () => (S.draft ? copy(S.draft) : null), KEY };
})();
