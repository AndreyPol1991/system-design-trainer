/* Как посчитать: расчёт нагрузки уровня «на салфетке» — от пользователей до серверов, кэша, реплик и шардов.
   Каждый шаг сначала угадываешь сам, потом видишь формулу. Итог проверяется на симуляторе.
   И формула на узле: почему здесь столько экземпляров. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt, T = () => SD.TYPES;
  const READ = ['read', 'search', 'bot', 'feed', 'graph', 'geo', 'report'], WRITE = ['write', 'upload', 'msg', 'events', 'metrics'];
  const TARGET = 0.75, PEAK = 3, DAY = 86400;
  const APP1 = 2500, SQL1 = 5000, SQLW = 4, NOSQL1 = 8000, CACHE_MEM = 32, HIT = 0.92;
  const num = v => { v = Math.round(v); return v >= 1e7 ? F().num(v) : v.toLocaleString('ru-RU'); };
  const nice = v => { if (!(v > 0)) return 0; const p = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
  const big = v => v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',').replace(',0', '') + ' млрд' : v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' млн' : num(v);
  const gb = v => v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' ТБ' : (v >= 10 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + ' ГБ';
  const sum = (tr, ks) => ks.reduce((s, k) => s + (tr[k] || 0), 0);
  const solTypes = L => new Set(((L.solution && L.solution.nodes) || []).map(n => n[1]));
  const usable = L => !!(L && !L.sandbox && !L.ai && L.traffic && (sum(L.traffic, READ) + sum(L.traffic, WRITE)) > 0);

  /* ---------- модель: все числа уровня ----------
     Маршрут нагрузки (сколько доходит до каждого узла) берём из симулятора на эталонной схеме уровня,
     а сколько узлов нужно — считаем формулами на салфетке. */
  const nm = n => n.label || T()[n.type].name;
  const lever = n => ((T()[n.type] || {}).props || []).find(p => p.key === 'count' && p.type === 'range');
  const eff = r => { const u = r.util || 0, c = r.count || 1; return u > 0.005 ? r.rps / (u * c) : r.cap / c; };
  const refGraph = L => { const o = SD.walk.orderOf(L, L.solution), g = SD.walk.build(L, L.solution, o, o.length); return g; };
  function model(L) {
    const tr = L.traffic, R = sum(tr, READ), W = sum(tr, WRITE), S = tr.static || 0, P = R + W + S;
    const act = W > R ? 30 : 20, avg = P / PEAK, dau = nice(avg * DAY / act);
    const g = refGraph(L), res = SD.sim.run(L, g, { mul: 1 }), rn = id => res.nodes[id] || {};
    const surv = (L.goals || []).filter(x => x.t === 'survive').map(x => x.types), survives = t => surv.some(x => x === 'all' || (x || []).includes(t));
    /* сервисы */
    const apps = g.nodes.filter(n => n.type === 'app' && rn(n.id).rps > 0.5).map(n => {
      const r = rn(n.id), c1 = eff(r), x = r.rps / (c1 * TARGET);
      return { n, rps: r.rps, c1, x, need: Math.max(1, Math.ceil(x - 1e-9)) };
    }).sort((a, b) => b.rps - a.rps);
    const app = apps[0] || null;
    /* кэш */
    const cache = g.nodes.find(n => n.type === 'cache'), hot = L.hotSetGb || 8;
    const mem = cache ? (cache.props.mem || CACHE_MEM) : CACHE_MEM;
    const cacheN = cache ? Math.max(survives('cache') ? 2 : 1, Math.ceil(hot / (mem * 0.8))) : 0;
    /* база */
    const sqls = g.nodes.filter(n => n.type === 'sql').sort((a, b) => (rn(b.id).util || 0) - (rn(a.id).util || 0)), db = sqls[0] || null;
    let units = 0, wU = 0, readsDb = 0, wDb = 0, kinds = [], plans = [], plan = null, refK = null;
    if (db) {
      const ld = rn(db.id).load || {}, w = SD.sim.internals.sqlW(db.props, L);
      const rk = { read: w.read, bot: w.bot, feed: w.feed, search: w.search, range: w.range, geo: w.geo, report: w.report, graph: w.feed };
      Object.entries(rk).forEach(([k, wt]) => { if (ld[k] > 0.5) { kinds.push([k, ld[k], wt]); units += ld[k] * wt; readsDb += ld[k]; } });
      wDb = (ld.write || 0) + (ld.apply || 0) + (ld.events || 0) + (ld.append || 0) * 0.5 + (ld.metrics || 0) * 0.4;
      wU = wDb * w.write; units += wU; kinds.push(['write', wDb, w.write]);
      refK = db.props.shards > 1 ? 'shard' : db.props.replicas > 0 ? 'repl' : 'vert';
      const sqlCost = p => T().sql.cost({ props: Object.assign({}, db.props, p) }, {});
      const sizes = Object.entries(SD.SQL_SIZE_F || { s: 0.5, m: 1, l: 1.8, xl: 3.2 });
      const minRep = survives('sql') ? 1 : 0;
      const v = sizes.find(([, f]) => units <= SQL1 * f * TARGET);
      if (v) plans.push({ k: 'vert', props: { size: v[0], replicas: minRep, shards: 1 }, text: `один сервер ${v[0].toUpperCase()}${minRep ? ' + реплика на случай падения' : ''}`, why: `${num(units)} ед/с ≤ 75 % от ${num(SQL1 * v[1])}` });
      const per = SQL1 * TARGET - 0.3 * wU;
      if (wU <= SQL1 * TARGET * 0.85 && per > 0) {
        const rep = Math.max(1, minRep, Math.ceil((units - wU) / per));
        if (rep <= 6) plans.push({ k: 'repl', props: { size: 'm', replicas: rep, shards: 1 }, text: `primary M + ${rep} ${rep === 1 ? 'реплика' : rep < 5 ? 'реплики' : 'реплик'}`, why: `записи ${num(wU)} ед/с держит primary; чтения ${num(units - wU)} ед/с делят реплики, каждая ещё повторяет записи (+30 %)` });
      }
      const sh = Math.max(2, Math.ceil(units / (SQL1 * TARGET)));
      if (sh <= 16) plans.push({ k: 'shard', props: { size: 'm', replicas: minRep, shards: sh }, text: `${sh} ${sh < 5 ? 'шарда' : 'шардов'} M${minRep ? ' (у каждого реплика)' : ''}`, why: `делится всё: ${num(units)} ÷ ${sh} = ${num(units / sh)} ед/с на шард` });
      plans.forEach(p => { p.cost = sqlCost(p.props); });
      /* рекомендуем тот способ, которым устроен эталон уровня, если он проходит; иначе — самый дешёвый */
      plan = plans.find(p => p.k === refK) || plans.slice().sort((a, b) => a.cost - b.cost)[0] || null;
    }
    const hit = cache && R ? Math.max(0, Math.min(0.99, 1 - (kinds.filter(([k]) => k === 'read').reduce((s2, [, v2]) => s2 + v2, 0)) / Math.max(1, tr.read || 0))) : 0;
    /* остальные узлы — та же формула */
    const others = g.nodes.filter(n => !['client', 'app', 'cache', 'sql', 'lb'].includes(n.type) && !T()[n.type].ops && lever(n) && rn(n.id).rps > 0.5 && rn(n.id).cap > 0 && isFinite(rn(n.id).cap)).map(n => {
      const r = rn(n.id), c1 = eff(r);
      let need = Math.ceil(r.rps / (c1 * TARGET) - 1e-9), conn = 0;
      if (n.type === 'ws' && L.connections && T().ws.perConn) { conn = Math.ceil(L.connections / (T().ws.perConn * TARGET)); need = Math.max(need, conn); }
      need = Math.min(lever(n).max, Math.max(survives(n.type) ? 2 : 1, need));
      return { n, rps: r.rps, c1, need, conn };
    });
    /* объём и сеть */
    const wAvg = (tr.write || 0) / PEAK, rowsDay = wAvg * DAY, gbYear = rowsDay * 365 / 1e6, upGbDay = (tr.upload || 0) / PEAK * DAY * 2 / 1000;
    const outMBs = (R * 5 + S * 200) / 1000, gbit = outMBs * 8 / 1000;
    /* цена — по схеме уровня с числами из расчёта */
    const m = { L, tr, R, W, S, P, act, avg, dau, apps, app, cache, mem, hot, cacheN, hit, db, kinds, units, wU, readsDb, wDb, plans, plan, refK, others, wAvg, rowsDay, gbYear, upGbDay, outMBs, gbit, survives };
    const g2 = refGraph(L); planGraph(m, g2).forEach(([n, k, v2]) => { n.props[k] = v2; });
    m.g2 = g2; m.res2 = SD.sim.run(L, g2, { mul: 1 }); m.total = m.res2.cost;
    m.budget = (L.goals || []).find(x => x.t === 'cost');
    return m;
  }
  /* расчёт → схема: какие настройки поставить узлам */
  function planGraph(m, g) {
    const ch = [], byId = id => g.nodes.find(n => n.id === id);
    const res1 = m.survives('app') ? 1 : 0;
    m.apps.forEach(a => { const n = byId(a.n.id); if (n) ch.push([n, 'count', Math.min(30, Math.max(res1 ? 2 : 1, a.need + res1))]); });
    if (m.cache) { const n = byId(m.cache.id); if (n) ch.push([n, 'count', m.cacheN]); }
    if (m.db && m.plan) { const n = byId(m.db.id); if (n) Object.entries(m.plan.props).forEach(([k, v]) => ch.push([n, k, v])); }
    m.others.forEach(o => { const n = byId(o.n.id); if (n) ch.push([n, 'count', o.need]); });
    return ch;
  }

  /* ---------- шаги ---------- */
  const fx = v => v < 10 ? v.toFixed(1).replace('.', ',') : num(v);
  function steps(m) {
    const out = [];
    out.push({ id: 'avg', title: 'Сколько это в секунду', unit: 'запросов/с',
      an: 'Как касса в магазине: за день приходит много покупателей, но считать кассы надо по часу пик.',
      q: `Пусть у сервиса ${big(m.dau)} пользователей в день (DAU), каждый делает ≈ ${m.act} действий. Сколько это запросов в секунду в среднем?`,
      ans: m.dau * m.act / DAY,
      how: [`${big(m.dau)} × ${m.act} = ${big(m.dau * m.act)} запросов в сутки`, 'в сутках 86 400 секунд (на салфетке — ≈ 100 000)', `${big(m.dau * m.act)} ÷ 86 400 ≈ <b>${num(m.dau * m.act / DAY)}/с</b> в среднем`] });
    out.push({ id: 'peak', title: 'Час пик', unit: 'запросов/с',
      an: 'Вечером людей втрое больше, чем в среднем за сутки. Систему строят под пик, а не под среднее.',
      q: `Пик обычно в 2–5 раз выше среднего. Возьмём ×${PEAK}. Сколько запросов в секунду в пик?`,
      ans: m.dau * m.act / DAY * PEAK,
      how: [`${num(m.dau * m.act / DAY)} × ${PEAK} ≈ <b>${num(m.dau * m.act / DAY * PEAK)}/с</b>`, `В задании уровня — ${num(m.P)}/с: ${Object.entries(m.tr).filter(([k, v]) => v > 0 && SD.KINDS[k]).map(([k, v]) => `${SD.KINDS[k].label.toLowerCase()} ${num(v)}`).join(', ')}. Дальше считаем от этих чисел.`] });
    if (m.W) out.push({ id: 'ratio', title: 'Чтения или записи', unit: 'чтений на запись',
      an: 'Библиотека: книги берут читать в сто раз чаще, чем привозят новые. Читателям помогают копии и полка у входа, привозу — второй склад.',
      q: `Чтений ${num(m.R)}/с, записей ${num(m.W)}/с. Сколько чтений приходится на одну запись?`,
      ans: m.R / m.W, so: m.R / m.W >= 10 ? 'Читают намного чаще: окупятся кэш и реплики базы.' : 'Записей много: кэш поможет мало, думать о primary базы, шардах и очереди.',
      how: [`${num(m.R)} ÷ ${num(m.W)} ≈ <b>${fx(m.R / m.W)}</b>`] });
    if (m.app) {
      const a = m.app, more = m.apps.length > 1;
      out.push({ id: 'app', title: more ? `Серверы приложения: «${nm(a.n)}»` : 'Серверы приложения', unit: 'экземпляров',
        an: 'Сколько касс открыть: поток покупателей делим на то, сколько пробивает один кассир, и оставляем запас, чтобы очередь не росла.',
        q: `До «${nm(a.n)}» доходит ${num(a.rps)} запросов/с${m.S ? ' (картинки и видео отдаёт CDN)' : ''}. Один экземпляр на такой смеси запросов тянет ≈ ${num(a.c1)}/с. Держим загрузку не выше 75 %. Сколько экземпляров?`,
        ans: a.need,
        how: [`${num(a.rps)} ÷ ${num(a.c1)} = ${fx(a.rps / a.c1)} экземпляра на пределе`, `÷ 0,75 (запас) = ${fx(a.x)} → <b>${a.need}</b>`, m.survives('app') ? `цель уровня — пережить падение, поэтому +1 запасной: <b>${Math.max(2, a.need + 1)}</b>` : 'Если нужно пережить падение одного экземпляра — ставят ещё +1 (N+1).'].concat(a.c1 > APP1 * 1.3 ? [`Почему больше ${num(APP1)}/с: часть запросов лёгкие (например, события), и в среднем экземпляр успевает больше.`] : []).concat(more ? [`Остальные сервисы так же: ${m.apps.slice(1).map(b => `«${nm(b.n)}» ${num(b.rps)}/с → ${b.need}+1`).join(', ')}.`] : []),
        so: 'Почему 75 %, а не 100 %: ближе к пределу очередь растёт резко, и время ответа взлетает.' });
    }
    if (m.cache) out.push({ id: 'cache', title: 'Кэш и что дойдёт до базы', unit: 'узлов кэша',
      an: 'Холодильник у плиты: ходовое лежит под рукой, в кладовку (базу) ходят только за редким. Холодильник маленький — чаще бегаешь в кладовку.',
      q: `Горячих данных ≈ ${m.hot} ГБ (то, что читают постоянно). Узел кэша — ${m.mem} ГБ, полезно ≈ 80 %. Сколько узлов кэша нужно?${m.survives('cache') ? ' Цель уровня — пережить падение кэша.' : ''}`,
      ans: m.cacheN,
      how: [`${m.hot} ГБ ÷ (${m.mem} ГБ × 0,8) → <b>${Math.ceil(m.hot / (m.mem * 0.8))}</b>${m.survives('cache') && m.cacheN > Math.ceil(m.hot / (m.mem * 0.8)) ? `, но чтобы пережить падение — минимум <b>${m.cacheN}</b>` : ''}`, `Доля попаданий растёт с памятью: ≈ 97 % × (1 − e^(−2,5 × память ÷ горячее)). На эталоне кэш отвечает на ≈ ${Math.round(m.hit * 100)} % чтений.`, `До базы доходит ≈ ${num(m.readsDb)} чтений/с из ${num(m.R)}.`],
      so: 'Горячее не влезло — доля попаданий падает, и база получает в разы больше.' });
    if (m.db) {
      out.push({ id: 'db', title: 'База: условные единицы нагрузки', unit: 'единиц/с',
        an: 'Архив: найти папку по каталогу — одно действие, перебрать полку — десятки, положить новую — записать в журнал, вложить, обновить каталоги.',
        q: `В «${nm(m.db)}» приходит: ${m.kinds.map(([k, v]) => `${SD.KINDS[k] ? SD.KINDS[k].label.toLowerCase() : k} ${num(v)}/с`).join(', ')}. Цена одной операции: ${m.kinds.map(([k, , wt]) => `${SD.KINDS[k] ? SD.KINDS[k].label.toLowerCase() : k} ≈ ${fx(wt)}`).join(', ')}. Сколько единиц в секунду?`,
        ans: m.units,
        how: [m.kinds.map(([, v, wt]) => `${num(v)} × ${fx(wt)}`).join(' + ') + ` = <b>${num(m.units)} ед/с</b>`, `Запись дороже чтения: журнал WAL, сама строка и все индексы. Поиск и диапазоны без подходящего индекса — дороже всего.`, `Сервер M тянет ≈ ${num(SQL1)} ед/с, S — вдвое меньше, L — ×1,8, XL — ×3,2.`] });
      out.push({ id: 'plan', title: 'Больше сервер, реплики или шарды', unit: m.plan && m.plan.k === 'shard' ? 'шардов' : m.plan && m.plan.k === 'repl' ? 'реплик' : 'серверов',
        an: 'Не справляется один повар: можно взять повара сильнее (больше сервер), поставить помощников раздавать готовое (реплики — только чтения) или открыть вторую кухню со своими заказами (шарды — и чтения, и записи).',
        q: m.plan ? `Нагрузка ${num(m.units)} ед/с, из них записи — ${num(m.wU)}: их принимает только primary. ${m.plan.k === 'shard' ? 'Сколько шардов размера M нужно?' : m.plan.k === 'repl' ? 'Сколько реплик нужно, если primary — M?' : 'Сколько серверов базы нужно?'}` : 'Нагрузка не помещается даже в 16 шардов — нужен другой подход (очередь, другое хранилище).',
        ans: m.plan ? (m.plan.k === 'shard' ? m.plan.props.shards : m.plan.k === 'repl' ? m.plan.props.replicas : 1) : 0,
        how: m.plans.map(p => `${p === m.plan ? '<b>' : ''}${p.text}${p === m.plan ? '</b>' : ''} — ${p.why}; ${F().usd(p.cost)}/мес`).concat([m.plan ? `Берём: <b>${m.plan.text}</b>${m.plan.k === m.refK ? ' — так устроен и эталон уровня' : ''}.` : '']),
        so: 'Правило: пока влезает — больше сервер, это проще всего. Много чтений — реплики. Много записей или данных — шарды: только они делят и запись. Подробно, как таблица делится, — в «Таблице вживую».' });
    }
    if (m.others.length) out.push({ id: 'other', title: 'Остальные узлы — та же формула', unit: m.others.length === 1 ? 'узлов' : 'узлов всего',
      an: 'Любой узел считается одинаково: сколько к нему приходит ÷ сколько тянет один экземпляр ÷ 0,75.',
      q: m.others.length === 1 ? `До «${nm(m.others[0].n)}» доходит ${num(m.others[0].rps)}/с, один экземпляр тянет ≈ ${num(m.others[0].c1)}/с. Сколько экземпляров?` : `Посчитай для каждого и сложи: ${m.others.map(o => `«${nm(o.n)}» — ${num(o.rps)}/с при ${num(o.c1)}/с на экземпляр`).join('; ')}.`,
      ans: m.others.reduce((s2, o) => s2 + o.need, 0),
      how: m.others.map(o => o.conn ? `«${nm(o.n)}»: держит соединения — ${big(m.L.connections)} ÷ (${big(T().ws.perConn)} на шлюз × 0,75) → <b>${o.need}</b>` : `«${nm(o.n)}»: ${num(o.rps)} ÷ (${num(o.c1)} × 0,75) → <b>${o.need}</b>${m.survives(o.n.type) ? ' (минимум 2 — цель пережить падение)' : ''}`) });
    if (m.wAvg > 0) out.push({ id: 'vol', title: 'Сколько данных копится', unit: 'ГБ в год',
      an: 'Как фотографии в телефоне: каждая маленькая, но за год память кончается.',
      q: `Записей в среднем ${num(m.wAvg)}/с (пик ÷ ${PEAK}), строка с индексами ≈ 1 КБ. Сколько гигабайт за год?`,
      ans: m.gbYear,
      how: [`${num(m.wAvg)} × 86 400 = ${big(m.rowsDay)} строк в день`, `× 365 × 1 КБ ≈ <b>${gb(m.gbYear)}</b> в год`, m.upGbDay ? `Файлы отдельно: ${num(m.tr.upload)}/с в пик × 2 МБ → ≈ ${gb(m.upGbDay)} в день — это объектное хранилище, не база.` : ''],
      so: m.gbYear > 1500 ? 'Больше 1–2 ТБ на сервер — тяжело: бэкапы и индексы растут. Помогают партиции по дате (старое — в архив или DROP PARTITION) и шарды по объёму.' : 'На один сервер помещается несколько лет. Старое всё равно удобно резать на партиции по дате.' });
    if (m.S || m.gbit > 0.05) out.push({ id: 'net', title: 'Сеть', unit: 'Гбит/с',
      an: 'Как трубы в доме: даже если насос справляется, узкая труба не пропустит воду.',
      q: `Ответ страницы ≈ 5 КБ${m.S ? `, картинка или кусок видео ≈ 200 КБ (их ${num(m.S)}/с)` : ''}. Сколько гигабит в секунду уходит пользователям?`,
      ans: m.gbit,
      how: [`(${num(m.R)} × 5 КБ${m.S ? ` + ${num(m.S)} × 200 КБ` : ''}) ≈ ${num(m.outMBs)} МБ/с`, `× 8 ≈ <b>${fx(m.gbit)} Гбит/с</b>`],
      so: m.gbit > 1 ? 'Больше гигабита — тяжёлое отдают с CDN: ближе к людям и дешевле, чем из своего сервера.' : 'Сеть не узкое место.' });
    return out;
  }

  /* ---------- проверка ---------- */
  const KEY = 'amp-stroyka-calc-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  function parse(s) {
    s = String(s || '').trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
    const m = s.match(/^([0-9.]+)(к|k|тыс|млн|m|млрд|b)?/); if (!m) return NaN;
    const v = parseFloat(m[1]), mul = { 'к': 1e3, k: 1e3, 'тыс': 1e3, 'млн': 1e6, m: 1e6, 'млрд': 1e9, b: 1e9 }[m[2]] || 1;
    return v * mul;
  }
  function grade(g, a) {
    if (!(g > 0) || !(a > 0)) return 'miss';
    const d = Math.abs(Math.log10(g / a));
    return d <= 0.1 ? 'exact' : d <= 0.48 ? 'order' : 'miss';
  }
  const GL = { exact: '✓ точно', order: '≈ порядок верный', miss: '✗ мимо', shown: 'ответ открыт' };
  const fmtAns = v => v >= 100 ? num(v) : v >= 10 ? Math.round(v) : (Math.round(v * 10) / 10).toString().replace('.', ',');
  const PL = { 'экземпляров': ['экземпляр', 'экземпляра', 'экземпляров'], 'узлов кэша': ['узел кэша', 'узла кэша', 'узлов кэша'], 'серверов': ['сервер', 'сервера', 'серверов'], 'реплик': ['реплика', 'реплики', 'реплик'], 'шардов': ['шард', 'шарда', 'шардов'], 'узлов': ['узел', 'узла', 'узлов'], 'узлов всего': ['узел', 'узла', 'узлов'] };
  const unitOf = (u, v) => { const f = PL[u]; if (!f || v !== Math.round(v)) return u; const a = v % 10, b = v % 100; return a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? f[1] : f[2]; };

  /* ---------- окно ---------- */
  let M = null, S = [];
  const HINT = new Set();
  function open(L) {
    const A = SD.app && SD.app.A; L = L || (A && A.level);
    if (!usable(L)) { SD.app.toast(L && L.ai ? 'Для уровней с AI расчёт по токенам появится позже.' : 'Здесь нечего считать: нет нагрузки.'); return; }
    M = model(L); S = steps(M); HINT.clear();
    let m = $('calcModal');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'calcModal'; m.hidden = true;
      m.innerHTML = '<div class="sheet calc-sheet" role="dialog" aria-modal="true" aria-labelledby="calcTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Как посчитать</span><h2 id="calcTitle"></h2><button class="btn ghost x" type="button" data-calcx>Закрыть</button></div><div class="calc-wrap"><div class="calc-steps" id="calcSteps"></div><aside class="calc-side" id="calcSide"></aside></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', onClick);
      m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-calcin]')) { e.preventDefault(); check(e.target.dataset.calcin); } });
    }
    $('calcTitle').textContent = 'Расчёт на салфетке: ' + L.title;
    render(); m.hidden = false;
    const f = m.querySelector('[data-calcin]'); if (f) f.focus();
  }
  const st = id => ((U[M.L.id] || {})[id]);
  function render() {
    const done = S.filter(s => st(s.id)).length;
    $('calcSteps').innerHTML = `<p class="calc-lede">Так считают на собеседовании и в начале проекта: грубо, по порядку величины, но каждое число — с причиной. Впиши свою оценку и нажми «Проверить» (Enter). «Точно» — в пределах ±25 %, «порядок верный» — в пределах ×3. Можно писать «15к», «2,5 млн». Пройдено: ${done} из ${S.length}.</p>` + S.map((s, i) => {
      const g = st(s.id), open = !!g;
      return `<section class="calc-step ${g || ''}" data-step="${s.id}"><div class="cs-h"><span class="cs-n">${i + 1}</span><b>${esc(s.title)}</b>${g ? `<span class="cs-st">${GL[g]}</span>` : ''}</div>
        <p class="cs-an">${esc(s.an)}</p><p class="cs-q">${esc(s.q)}</p>
        <div class="cs-in"><input type="text" inputmode="decimal" autocomplete="off" data-calcin="${s.id}" placeholder="твоя оценка" aria-label="${esc(s.title)}: твоя оценка"><span>${esc(s.unit)}</span><button type="button" class="btn" data-calcck="${s.id}">Проверить</button><button type="button" class="linkish" data-calchint="${s.id}">${HINT.has(s.id) ? 'Скрыть подсказку' : 'Подсказка: как считать'}</button><button type="button" class="linkish" data-calcshow="${s.id}">Показать ответ</button></div>
        ${HINT.has(s.id) && !open ? `<div class="cs-hint"><b>Как считать:</b><ul>${s.how.filter(Boolean).map(x => `<li>${x.replace(/<b>[^<]*<\/b>/g, '<b>?</b>').replace(/(=|≈) ?(\d[\d   ,.]*)/g, '$1 ?')}</li>`).join('')}</ul><p>Посчитай то, что под «?», и впиши ответ.</p></div>` : ''}
        <div class="cs-ans" ${open ? '' : 'hidden'}><b class="cs-a">Ответ: ${fmtAns(s.ans)} ${esc(unitOf(s.unit, Math.round(s.ans) === s.ans ? s.ans : 0.5))}</b><ul>${s.how.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul>${s.so ? `<p class="cs-so">${esc(s.so)}</p>` : ''}</div></section>`;
    }).join('');
    side();
  }
  function side() {
    const m = M, rows = [], cost = id => ((m.res2.nodes[id] || {}).cost) || 0;
    const res1 = m.survives('app') ? 1 : 0;
    m.apps.forEach(a => rows.push([nm(a.n), `×${Math.min(30, Math.max(res1 ? 2 : 1, a.need + res1))}${res1 ? ' (с запасным)' : ''}`, cost(a.n.id)]));
    if (m.cache) rows.push([nm(m.cache), `×${m.cacheN} по ${m.mem} ГБ`, cost(m.cache.id)]);
    if (m.db && m.plan) rows.push([nm(m.db), m.plan.text, cost(m.db.id)]);
    m.others.forEach(o => rows.push([nm(o.n), `×${o.need}`, cost(o.n.id)]));
    const listed = rows.reduce((a, r) => a + r[2], 0);
    if (m.total - listed > 1) rows.push(['Остальное на схеме', 'как в эталоне', m.total - listed]);
    let h = `<h3>Итог для схемы</h3><table class="calc-sum">${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(F().usd(c))}</td></tr>`).join('')}<tr class="tot"><td>В месяц</td><td></td><td>${F().usd(m.total)}</td></tr></table>`;
    if (m.budget) h += `<p class="calc-bud ${m.total <= m.budget.max ? 'ok' : 'bad'}">Бюджет уровня ${F().usd(m.budget.max)}: ${m.total <= m.budget.max ? 'укладываемся' : 'не укладываемся — ищи, где сэкономить'}.</p>`;
    if (m.S) h += `<p class="calc-note">Картинки и видео (${num(m.S)}/с) — через CDN и объектное хранилище, сервис их не касается.</p>`;
    h += `<div class="calc-act"><button type="button" class="btn primary" data-calcsim>Проверить расчёт на симуляторе</button><button type="button" class="btn" data-calcapply>Поставить эти числа на мою схему</button></div><div id="calcRes"></div>`;
    if (SD.LABS && SD.LABS.find(l => l.id === 'table')) h += `<button type="button" class="linkish calc-lab" data-calclab>Как таблица делится на партиции и шарды — «Таблица вживую»</button>`;
    h += `<p class="calc-note">Сколько доходит до каждого узла — из симулятора на схеме уровня (кэш, CDN и очереди забирают часть). Сколько узлов нужно — по формуле: нагрузка ÷ ёмкость одного ÷ 0,75.</p>`;
    $('calcSide').innerHTML = h;
  }
  function check(id) {
    const s = S.find(x => x.id === id), inp = document.querySelector(`[data-calcin="${id}"]`); if (!s || !inp) return;
    const g = grade(parse(inp.value), s.ans);
    U[M.L.id] = Object.assign({}, U[M.L.id], { [id]: g }); save();
    const val = inp.value; render();
    const ni = document.querySelector(`[data-calcin="${id}"]`); if (ni) ni.value = val;
    const next = S[S.findIndex(x => x.id === id) + 1]; if (next) { const n2 = document.querySelector(`[data-calcin="${next.id}"]`); if (n2) n2.focus({ preventScroll: true }); }
  }
  function simCheck() {
    const L = M.L, g = refGraph(L);
    planGraph(M, g).forEach(([n, k, v]) => { n.props[k] = v; });
    const res = SD.sim.run(L, g, { mul: 1 }), goals = SD.evalGoals(L, g, res, SD.sim.chaos(L, g), SD.sim.analyze(L, g, res));
    const ok = goals.filter(x => x.ok).length;
    $('calcRes').innerHTML = `<div class="calc-res ${ok === goals.length ? 'ok' : ''}"><b>Схема уровня с числами из расчёта:</b><span>успешно ${F().pct(res.total.success)} · ${F().ms(res.total.lat)} · ${F().usd(res.cost)}/мес</span><ul>${goals.map(x => `<li class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✗'} ${esc(x.text)} <small>${esc(x.detail)}</small></li>`).join('')}</ul><p>${ok === goals.length ? 'Расчёт на салфетке выдерживает все цели.' : 'Расчёт грубый: где не хватило — смотри красное. Обычно добирают запас или меняют устройство схемы (паттерн уровня).'}</p></div>`;
  }
  /* на схему пользователя: тот же узел (по id) или единственный узел того же типа */
  function apply() {
    const A = SD.app.A, ch = [];
    planGraph(M, refGraph(M.L)).forEach(([rn2, k, v]) => {
      const same = A.graph.nodes.find(n => n.id === rn2.id && n.type === rn2.type);
      const ofType = A.graph.nodes.filter(n => n.type === rn2.type), refOfType = M.g2.nodes.filter(n => n.type === rn2.type);
      const n = same || (ofType.length === 1 && refOfType.length === 1 ? ofType[0] : null);
      if (n && n.props[k] !== v) ch.push([n, k, v]);
    });
    if (!ch.length) { SD.app.toast('На твоей схеме нечего менять: подходящих узлов нет или числа уже такие.'); return; }
    ch.forEach(([n, k, v]) => SD.app.setProp(n.id, k, v));
    $('calcModal').hidden = true;
    const lbl = { count: '×', replicas: 'реплик ', shards: 'шардов ', size: 'размер ' };
    SD.app.toast(`Расчёт поставлен на схему: ${ch.map(([n, k, v]) => `«${nm(n)}» ${lbl[k] || k + ' '}${typeof v === 'string' ? v.toUpperCase() : v}`).join(', ')}.`);
  }
  function onClick(e) {
    const m = $('calcModal');
    if (e.target === m || e.target.closest('[data-calcx]')) { m.hidden = true; return; }
    const c = e.target.closest('[data-calcck]'); if (c) { check(c.dataset.calcck); return; }
    const hb = e.target.closest('[data-calchint]'); if (hb) { const id = hb.dataset.calchint, val = (document.querySelector(`[data-calcin="${id}"]`) || {}).value; if (HINT.has(id)) HINT.delete(id); else HINT.add(id); render(); const ni = document.querySelector(`[data-calcin="${id}"]`); if (ni && val) ni.value = val; return; }
    const s = e.target.closest('[data-calcshow]');
    if (s) { const id = s.dataset.calcshow; if (!st(id)) { U[M.L.id] = Object.assign({}, U[M.L.id], { [id]: 'shown' }); save(); } render(); return; }
    if (e.target.closest('[data-calcsim]')) { simCheck(); return; }
    if (e.target.closest('[data-calcapply]')) { apply(); return; }
    if (e.target.closest('[data-calclab]')) { m.hidden = true; SD.labs.open('table'); }
  }

  /* ---------- формула на узле ---------- */
  function nodeBlock(A, n) {
    const r = A.res && A.res.nodes[n.id], t = T()[n.type];
    if (!r || !t || n.type === 'client' || t.ops || !(r.rps > 0.5)) return '';
    const cnt = r.count || n.props.count || 1, u = r.util || 0;
    let h = '';
    if (n.type === 'sql') {
      const ld = r.load || {}, w = SD.sim.internals.sqlW(n.props, A.level), rd = READ.reduce((s, k) => s + (ld[k] || 0), 0), wr = (ld.write || 0) + (ld.apply || 0) + (ld.events || 0);
      const f = (SD.SQL_SIZE_F || {})[n.props.size] || 1, un = READ.reduce((s, k) => s + (ld[k] || 0) * (w[k] || w.read), 0) + wr * w.write;
      h = `<p>Сюда приходит ${num(rd)} чтений/с и ${num(wr)} записей/с. Чтение по индексу ≈ ${fx(w.read)} единицы, запись ≈ ${fx(w.write)}: всего ≈ ${num(un)} ед/с. Сервер ${String(n.props.size || 'm').toUpperCase()} тянет ≈ ${num(SQL1 * f)} ед/с${n.props.replicas ? `, реплик ${n.props.replicas} — чтения делятся между ними` : ''}${n.props.shards > 1 ? `, шардов ${n.props.shards} — делится всё` : ''}.</p><p>Самый загруженный сервер базы — <b>${Math.round(u * 100)} %</b>. ${u > 1 ? 'Перегружен: больше сервер, реплики (если много чтений) или шарды (если много записей).' : u > TARGET ? 'Близко к пределу: под пиком начнёт тормозить.' : 'Запас есть.'}</p>`;
    } else if (r.cap > 0 && isFinite(r.cap)) {
      const c1 = eff(r), x = r.rps / c1, need = Math.max(1, Math.ceil(x / TARGET - 1e-9));
      h = `<p>Сюда приходит <b>${num(r.rps)}/с</b>. Один экземпляр тянет ≈ ${num(c1)}/с.</p><p>${num(r.rps)} ÷ ${num(c1)} = ${fx(x)} → с запасом до 75 % нужно <b>${need}</b>. Сейчас ${cnt}: загрузка ${Math.round(u * 100)} %.</p><p class="cf-v ${u > 1 ? 'bad' : u > TARGET ? 'warn' : cnt > need * 1.6 && cnt - need >= 2 ? 'warn' : 'ok'}">${u > 1 ? `Перегружен: нужно не меньше ${need}.` : u > TARGET ? `Работает на пределе: под пиком начнёт тормозить. По правилу 75 % — ${need}.` : cnt > need * 1.6 && cnt - need >= 2 ? `С большим запасом: хватит ${need}, остальное — лишние деньги (или запас на рост).` : 'В самый раз.'}</p>`;
    } else return '';
    return `<details class="calc-node"><summary>Почему столько — формула</summary>${h}${usable(A.level) ? '<button type="button" class="linkish" data-calcopen>Как посчитать весь уровень ›</button>' : ''}</details>`;
  }

  function mount() {
    document.addEventListener('click', e => { if (e.target.closest('[data-calcopen]')) open(); });
    document.addEventListener('keydown', e => { const m = $('calcModal'); if (e.key === 'Escape' && m && !m.hidden) m.hidden = true; });
  }

  SD.calc = { mount, open, model, steps, nodeBlock, usable, planGraph, refGraph };
})();
