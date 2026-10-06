/* Один сервис — много клиентов (SaaS, мультиарендность). Трек SD.SAASL: платформа записи на тренировки
   для сети фитнес-франшиз. Как бизнес-центр: вход общий, а у каждой компании свой офис, свой пропуск и свой лимит
   на переговорки.
   Что моделируем — просто и честно:
   1. Клиенты (арендаторы): 40 мелких франшиз с разной нагрузкой, «Пульс» среди них устраивает рассылку (пик ×25),
      крупная сеть «Кедр» — отдельный клиент со своим договором.
   2. Метка клиента: из тела запроса (её впишет кто угодно) или из проверенного токена на входе (API-шлюз).
   3. Изоляция данных: общие таблицы с меткой (pool) + защита строк RLS, своя схема или своя база на общем сервере
      (bridge), отдельная ячейка — свой сервис и своя база (silo). Кэш без метки клиента в ключе смешивает ответы.
   4. Лимит на клиента на шлюзе: одинаковый или по тарифу. Сверх лимита — 429, пик одного не съедает общий ресурс.
   5. Ячейки: узлы «Сервис» за шлюзом с настройкой «Чьих клиентов обслуживает»; клиенты закреплены за ячейкой.
      Сбой ячейки задевает только её клиентов — это радиус аварии.
   Проверки уровней: утечки, шумный сосед, радиус аварии, требования крупного клиента. Стили — префикс .tn-. */
(function () {
  if (!window.SD || !SD.TYPES) return;
  const T = SD.TYPES;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const nm = n => n ? (n.label || (T[n.type] ? T[n.type].name : n.type)) : '';
  const F = () => SD.fmt;
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const fr = n => n + ' ' + plural(n, 'франшиза', 'франшизы', 'франшиз');
  const QUOTA = { flat: { small: 400, big: 400 }, plan: { small: 400, big: 3000 } };
  const SILO_DB = 440;   // своя база на клиента: сервер S + реплика, $ в месяц

  /* ---------- настройки узлов ---------- */
  const add = (t, list) => { if (!T[t]) return; list.forEach(p => { if (!(T[t].props || []).some(x => x.key === p.key)) T[t].props = (T[t].props || []).concat([p]); }); };
  add('gateway', [
    { key: 'tenantFrom', label: 'Откуда метка клиента', type: 'select', def: 'token', feature: 'tenant',
      options: [['body', 'Из тела запроса (club_id в JSON)'], ['token', 'Из проверенного токена на входе']],
      help: 'Метка клиента решает, чьи данные увидит запрос. В теле запроса её впишет кто угодно. Шлюз берёт метку из проверенного токена и передаёт сервису заголовком — что прислал клиент, не важно.' },
    { key: 'tenantQuota', label: 'Лимит на клиента', type: 'select', def: 'none', feature: 'tenant',
      options: [['none', 'Нет — каждый берёт сколько хочет'], ['flat', 'Одинаковый: 400 запросов/с на клиента'], ['plan', 'По тарифу: мелким 400/с, крупным по договору 3 000/с']],
      help: 'Сверх лимита шлюз отвечает 429 «Слишком много запросов» — пик одного клиента не съедает общий сервис и базу. Одинаковый лимит режет крупного клиента: ему нужен свой, по договору.' }
  ]);
  add('app', [
    { key: 'serves', label: 'Чьих клиентов обслуживает', type: 'select', def: 'all', feature: 'tenant',
      options: [['all', 'Всех клиентов'], ['small', 'Мелких клиентов (общий пул)'], ['big', 'Только крупного клиента']],
      help: 'Ячейка — отдельная копия системы для части клиентов: свой сервис, своя база. Шлюз закрепляет каждого клиента за ячейкой. Два узла «мелких» — две ячейки, франшизы делятся между ними.' }
  ]);
  add('sql', [
    { key: 'tenancy', label: 'Как клиенты разделены в базе', type: 'select', def: 'pool', feature: 'tenant',
      options: [['pool', 'Общие таблицы, у строк метка клиента'], ['schema', 'Своя схема на клиента'], ['dbper', 'Своя база на клиента на общем сервере']],
      help: 'Общие таблицы — дёшево, но один забытый фильтр показывает чужое. Своя схема или база — фильтр не нужен, зато миграции идут по каждому клиенту и база тяжелее. Сервер всё равно общий: пик соседа его нагружает.' },
    tog('rls', 'Защита строк в базе (RLS)', false, 'Row-Level Security: база сама отдаёт только строки клиента из текущей сессии. Страховка, если в каком-то запросе забыли WHERE club_id = …', { feature: 'tenant', showIf: n => (n.props.tenancy || 'pool') === 'pool' })
  ]);
  add('cache', [tog('tenantKey', 'Метка клиента в ключе кэша', false, 'Ключ club:17:schedule:2026-10-06 вместо schedule:2026-10-06 — у каждого клиента свой ответ в кэше.', { feature: 'tenant' })]);

  if (SD.PROP_SIMPLE) {
    const P = k => (SD.PROP_SIMPLE[k] = SD.PROP_SIMPLE[k] || {});
    P('gateway').tenantFrom = 'Как пропуск в бизнес-центре: охранник смотрит на твой пропуск, а не на то, что ты сам сказал. Метка клиента (club_id) должна приходить из проверенного токена. Если сервис верит телу запроса, администратор одного клуба впишет id соседа и увидит его клиентов.';
    P('gateway').tenantQuota = 'Как лимит на переговорки в бизнес-центре: одна компания не может занять все комнаты разом. Сверх лимита шлюз вежливо отвечает «подождите» (429), и пик одного клиента не роняет остальных. Крупному арендатору лимит больше — по договору.';
    P('app').serves = 'Ячейка — как отдельный корпус бизнес-центра: свой вход в лифты, своя котельная. Пожар в одном корпусе не трогает другой. Каждый клиент закреплён за своей ячейкой, поэтому сбой или пик в ячейке задевает только её клиентов.';
    P('sql').tenancy = 'Общие таблицы — общий open space с табличками на столах: дёшево, но можно сесть за чужой стол. Своя схема или база — отдельный кабинет на общем этаже: чужого не увидишь, но этаж (сервер) общий. Свой сервер для клиента — это уже отдельная ячейка.';
    P('sql').rls = 'Второй замок на двери: даже если программист забыл в запросе условие «только мой клуб», база сама отдаст только строки клуба из текущей сессии.';
    P('cache').tenantKey = 'Как ячейки в камере хранения с номером клиента. Без метки ключ «расписание на 6 октября» один на всех: первый клуб положил своё расписание — остальным достанется чужое.';
  }
  if (SD.OPT_SIMPLE) {
    SD.OPT_SIMPLE['gateway.tenantFrom'] = { body: 'Метка из тела запроса: сервис верит тому, что прислал клиент, — подменить чужой club_id проще простого.', token: 'Метка из токена: шлюз проверил вход и сам сказал сервису, чей это запрос.' };
    SD.OPT_SIMPLE['gateway.tenantQuota'] = { none: 'Без лимитов: пик одного клиента достаётся всем.', flat: 'Всем по 400 запросов в секунду: мелким хватает с запасом, крупному — мало.', plan: 'По тарифу: мелким 400, крупному 3 000 по договору.' };
    SD.OPT_SIMPLE['app.serves'] = { all: 'Сервис обслуживает всех клиентов.', small: 'Сервис — ячейка для мелких франшиз.', big: 'Сервис — отдельная ячейка крупного клиента.' };
    SD.OPT_SIMPLE['sql.tenancy'] = { pool: 'Все клиенты в одних таблицах, строки помечены club_id.', schema: 'У каждого клиента своя схема: таблицы отдельно, сервер общий.', dbper: 'У каждого клиента своя база на общем сервере.' };
    SD.OPT_SIMPLE['sql.rls'] = { true: 'База сама фильтрует строки по клиенту.', false: 'Фильтр по клиенту — только на совести кода.' };
    SD.OPT_SIMPLE['cache.tenantKey'] = { true: 'В ключе кэша есть клиент: ответы не смешиваются.', false: 'Ключ без клиента: ответ одного клуба отдаётся другому.' };
  }

  /* ---------- кто клиенты и сколько запросов у каждого ---------- */
  const MEMO = new WeakMap();
  const weights = n => { const w = Array.from({ length: n }, (_, i) => 1 / (1 + 0.1 * i)), s = w.reduce((a, b) => a + b, 0); return w.map(x => x / s); };
  function demand(L) {
    if (MEMO.has(L)) return MEMO.get(L);
    const TN = L.tenants, base = L.tnBase || L.traffic;
    const kinds = Object.keys(base).filter(k => base[k] > 0);
    const tot = kinds.reduce((s, k) => s + base[k], 0);
    const sBig = TN.big ? TN.big.share : 0, n = TN.small.n, w = weights(n);
    const list = w.map((x, i) => {
      const d = {}; kinds.forEach(k => { d[k] = base[k] * (1 - sBig) * x; });
      return { i, seg: 'small', name: TN.noisy && TN.noisy.idx === i ? TN.noisy.name : 'Франшиза ' + (i + 1), noisy: !!(TN.noisy && TN.noisy.idx === i), d, D: tot * (1 - sBig) * x };
    });
    if (L.tnSurge && TN.noisy) {
      const t = list[TN.noisy.idx], extra = t.D * (TN.noisy.surge - 1), mix = TN.noisy.mix || { read: 1 };
      Object.keys(mix).forEach(k => { t.d[k] = (t.d[k] || 0) + extra * mix[k]; });
      t.D += extra;
    }
    if (TN.big) { const d = {}; kinds.forEach(k => { d[k] = base[k] * sBig; }); list.push({ i: n, seg: 'big', name: TN.big.name, d, D: tot * sBig }); }
    const out = { list, n, tot, noisyIdx: TN.noisy ? TN.noisy.idx : -1, bigIdx: TN.big ? n : -1 };
    MEMO.set(L, out);
    return out;
  }
  /* пик «шумного соседа»: та же схема, к нагрузке добавлена рассылка */
  const SURGE = new WeakMap();
  function surgeLevel(L) {
    if (!L.tenants || !L.tenants.noisy) return null;
    if (SURGE.has(L)) return SURGE.get(L);
    const nz = L.tenants.noisy, d0 = demand(L).list[nz.idx], extra = d0.D * (nz.surge - 1), traffic = Object.assign({}, L.traffic);
    Object.entries(nz.mix || { read: 1 }).forEach(([k, v]) => { traffic[k] = (traffic[k] || 0) + extra * v; });
    const S = Object.assign({}, L, { tnSurge: true, tnBase: L.traffic, traffic });
    SURGE.set(L, S);
    return S;
  }
  const servesOf = n => (n.props && n.props.serves) || 'all';
  function targetsOf(kids, seg) { const sp = kids.filter(k => servesOf(k) === seg); return sp.length ? sp : kids.filter(k => servesOf(k) === 'all'); }
  const quotaOf = gw => gw && gw.type === 'gateway' && QUOTA[gw.props.tenantQuota] ? QUOTA[gw.props.tenantQuota] : null;

  /* ---------- симулятор: шлюз раскладывает клиентов по ячейкам ---------- */
  function gwAbove(ctx, n, H) {
    const seen = new Set(); let cur = [n];
    while (cur.length) {
      const g = cur.find(x => x.type === 'gateway'); if (g) return g;
      const nx = [];
      cur.forEach(x => H.parents(ctx, x.id).forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); nx.push(p); } }));
      cur = nx;
    }
    return null;
  }
  function route(ctx, n, kind, r, H) {
    const L = ctx.level;
    if (!L.tenants || (n.type !== 'gateway' && n.type !== 'lb')) return false;
    const kids = H.kids(ctx, n.id).filter(k => (k.type === 'app' || k.type === 'faas') && H.canHandle(ctx, k.id, kind));
    if (!kids.length) return false;
    const D = demand(L), mul = ctx.opts.mul || 1, Q = quotaOf(gwAbove(ctx, n, H));
    const tg = { small: targetsOf(kids, 'small'), big: targetsOf(kids, 'big') };
    const to = new Map(); let total = 0, fail = 0;
    const tn = ctx.tn || (ctx.tn = { router: n.id, cell: [], alpha: [] });
    D.list.forEach(t => {
      const a = Q ? Math.min(1, Q[t.seg] / Math.max(1e-9, t.D * mul)) : 1, list = tg[t.seg];
      const c = list.length ? list[t.seg === 'big' ? 0 : t.i % list.length] : null;
      if (tn.router === n.id) { tn.cell[t.i] = c ? c.id : null; tn.alpha[t.i] = a; }
      const dk = (t.d[kind] || 0) * mul; if (!dk) return;
      total += dk;
      if (!c) { fail += dk; return; }
      to.set(c.id, (to.get(c.id) || 0) + dk * a); fail += dk * (1 - a);
    });
    if (!total) return false;
    r.u = 1;
    r.fwd = [...to.entries()].map(([id, x]) => ({ to: id, kind, f: x / total, mode: 'alt', net: 0 }));
    r.fail = fail / total;
    if (!r.fwd.length) r.noPath = true;
    return true;
  }
  /* отдельная схема или база на клиента — база чуть тяжелее; RLS — ещё одно условие в каждом запросе */
  function sqlExtra(ctx, n, ld) {
    if (!ctx.level.tenants) return undefined;
    const p = n.props || {}, f = p.tenancy === 'schema' ? 0.05 : p.tenancy === 'dbper' ? 0.15 : p.rls ? 0.02 : 0;
    return f ? ((ld.read || 0) + (ld.write || 0) * 4) * f : undefined;
  }
  (SD.simExts = SD.simExts || []).push({ route, sqlExtra });

  /* ---------- раскладка по графу: где живёт каждый клиент ---------- */
  function layout(L, g) {
    const byId = new Map(g.nodes.map(n => [n.id, n])), out = new Map(g.nodes.map(n => [n.id, []])), inn = new Map(g.nodes.map(n => [n.id, []]));
    g.edges.forEach(e => { if (byId.has(e.from) && byId.has(e.to) && e.from !== e.to && !out.get(e.from).includes(e.to)) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); } });
    const D = demand(L), client = g.nodes.find(n => n.type === 'client');
    const isOps = n => !!(T[n.type] && T[n.type].ops);
    let router = null; const seen = new Set();
    let cur = client ? [client.id] : [];
    while (cur.length && !router) {
      const nx = [];
      cur.forEach(id => (out.get(id) || []).forEach(k => {
        if (seen.has(k)) return; seen.add(k);
        const n = byId.get(k);
        if (!router && (n.type === 'gateway' || n.type === 'lb') && out.get(k).some(x => ['app', 'faas'].includes(byId.get(x).type))) router = n;
        nx.push(k);
      }));
      cur = nx;
    }
    let gw = null;
    if (router) { const up = new Set([router.id]); let c2 = [router.id]; while (c2.length && !gw) { const nx = []; c2.forEach(id => { const n = byId.get(id); if (n.type === 'gateway') gw = gw || n; (inn.get(id) || []).forEach(p => { if (!up.has(p)) { up.add(p); nx.push(p); } }); }); c2 = nx; } }
    const cells = router ? out.get(router.id).map(id => byId.get(id)).filter(n => ['app', 'faas'].includes(n.type)) : (client ? out.get(client.id).map(id => byId.get(id)).filter(n => n.type !== 'cdn' && n.type !== 'objstore') : []);
    const tg = { small: targetsOf(cells, 'small'), big: targetsOf(cells, 'big') };
    const cellOf = D.list.map(t => { const l = router ? tg[t.seg] : cells; return l.length ? l[router ? (t.seg === 'big' ? 0 : t.i % l.length) : 0] : null; });
    /* что ниже каждой ячейки и какие клиенты туда попадают */
    const down = (id, acc) => { (out.get(id) || []).forEach(k => { const n = byId.get(k); if (acc.has(k) || n === router || isOps(n)) return; acc.add(k); down(k, acc); }); return acc; };
    const ten = new Map();
    const cellDown = new Map();
    cells.forEach(c => { const acc = down(c.id, new Set([c.id])); cellDown.set(c.id, acc); });
    D.list.forEach((t, i) => { const c = cellOf[i]; if (!c) return; cellDown.get(c.id).forEach(id => { if (!ten.has(id)) ten.set(id, new Set()); ten.get(id).add(i); }); });
    return { byId, router, gw, cells, cellOf, ten, cellDown, D };
  }

  /* ---------- проверки ---------- */
  function leaks(L, g) {
    const Y = layout(L, g), outL = [];
    const k = Y.D.bigIdx;
    if (!Y.gw) outL.push({ k: 'entry', text: 'На входе нет API-шлюза: сервис берёт club_id из тела запроса — любой может вписать чужой.' });
    else if ((Y.gw.props.tenantFrom || 'token') === 'body') outL.push({ k: 'body', node: Y.gw.id, text: `«${nm(Y.gw)}»: метка клиента берётся из тела запроса — администратор одного клуба вписывает id соседа и видит его записи.` });
    Y.ten.forEach((set, id) => {
      const n = Y.byId.get(id); if (!n) return;
      const many = [...set].filter(i => i !== k).length + (set.has(k) ? 1 : 0);
      if (many < 2) return;
      if (n.type === 'sql' && (n.props.tenancy || 'pool') === 'pool' && !n.props.rls) outL.push({ k: 'where', node: id, text: `«${nm(n)}»: общие таблицы без RLS — в отчёте «Посещаемость» забыли WHERE club_id = …, и база отдаёт строки всех клубов.` });
      if (n.type === 'cache' && !n.props.tenantKey) outL.push({ k: 'cache', node: id, text: `«${nm(n)}»: ключ schedule:2026-10-06 один на все клубы — расписание первого спросившего достаётся остальным.` });
    });
    return outL;
  }
  /* успешность у каждого клиента по прогону симулятора */
  function statsOf(L, g, r) {
    const D = demand(L), ctx = r.ctx, H = SD.sim.internals, tn = ctx && ctx.tn;
    const kinds = Object.keys(L.traffic).filter(k => L.traffic[k] > 0);
    const memo = {};
    const cellS = (id, k) => { const key = id + '|' + k; if (memo[key] === undefined) { const e = H.evalReq(ctx, id, k); memo[key] = e.s * e.r; } return memo[key]; };
    const list = D.list.map(t => {
      let s;
      if (!tn) s = r.total.success;
      else {
        const c = tn.cell[t.i], a = tn.alpha[t.i] == null ? 1 : tn.alpha[t.i];
        s = !c ? 0 : kinds.reduce((acc, k) => acc + (t.d[k] || 0) / Math.max(1e-9, t.D) * a * cellS(c, k), 0);
      }
      return { t, s, cell: tn ? tn.cell[t.i] : null, alpha: tn ? (tn.alpha[t.i] == null ? 1 : tn.alpha[t.i]) : 1 };
    });
    const avg = arr => { const w = arr.reduce((a, x) => a + x.t.D, 0); return w ? arr.reduce((a, x) => a + x.s * x.t.D, 0) / w : 1; };
    const others = list.filter(x => !x.t.noisy);
    return { r, list, others: avg(others), small: avg(list.filter(x => x.t.seg === 'small' && !x.t.noisy)), noisy: D.noisyIdx >= 0 ? list[D.noisyIdx] : null, big: D.bigIdx >= 0 ? list[D.bigIdx] : null };
  }
  const stats = (L, g, opts) => statsOf(L, g, SD.sim.run(L, g, Object.assign({ mul: 1 }, opts || {})));
  const hottest = (g, r) => g.nodes.filter(n => n.type !== 'client' && r.nodes[n.id] && (r.nodes[n.id].dead || r.nodes[n.id].util > 1)).sort((a, b) => (b.type === 'sql') - (a.type === 'sql') || r.nodes[b.id].util - r.nodes[a.id].util).slice(0, 2).map(h => `«${nm(h)}» ${r.nodes[h.id].dead ? 'лежит' : '— перегрузка ' + Math.round(r.nodes[h.id].util * 100) + ' %'}`).join(', ');
  function surge(L, g) { const S = surgeLevel(L); return S ? stats(S, g) : null; }
  /* сбой одного узла ячейки: какая доля клиентов остаётся без записи */
  function radius(L, g) {
    const Y = layout(L, g), D = Y.D, cand = new Set();
    Y.cells.forEach(c => Y.cellDown.get(c.id).forEach(id => { const n = Y.byId.get(id); if (['app', 'faas', 'sql', 'nosql', 'cache'].includes(n.type)) cand.add(id); }));
    let worst = { share: 0, hit: 0, node: null, big: false };
    cand.forEach(id => {
      const g2 = { nodes: g.nodes.filter(n => n.id !== id), edges: g.edges.filter(e => e.from !== id && e.to !== id) };
      const st = stats(L, g2), hit = st.list.filter(x => x.s < 0.99);
      const share = hit.length / D.list.length;
      if (share > worst.share) worst = { share, hit: hit.filter(x => x.t.seg === 'small').length, node: Y.byId.get(id), big: hit.some(x => x.t.seg === 'big') };
    });
    return worst;
  }
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const pctS = v => F().pct(v);
  const goals = {
    leaks: () => custom('Утечек между клиентами: 0', (g, res, L) => {
      const x = leaks(L, g);
      return { ok: !x.length, detail: x.length ? `источников утечки: ${x.length} · ${x[0].text}` : 'метка из токена, строки и кэш разделены по клиентам' };
    }),
    noisy: min => custom('Рассылка «Пульса» (пик ×25) не задевает остальных: успешно ≥ ' + pctS(min), (g, res, L) => {
      const st = surge(L, g); if (!st) return { ok: false, detail: 'нет рассылки' };
      const nz = st.noisy, got = nz ? nz.t.D * nz.alpha : 0, ok = st.others >= min;
      return { ok, detail: `остальные — ${pctS(st.others)}; «Пульс» получает ${F().num(got)} из ${F().num(nz ? nz.t.D : 0)} запросов/с${!ok ? ' · ' + (hottest(g, st.r) || 'общий ресурс не выдерживает') : ''}` };
    }),
    radius: max => custom(`Сбой одной ячейки задевает не больше ${Math.round(max * 100)} % франшиз`, (g, res, L) => {
      const w = radius(L, g), n = L.tenants.small.n, ok = w.share <= max + 1e-9;
      return { ok, detail: !w.node ? 'сбой любого узла никого не задевает' : `хуже всего — сбой «${nm(w.node)}»: без записи ${w.hit} из ${fr(n)}${w.big ? ' и «Кедр»' : ''} (${Math.round(w.share * 100)} %)` };
    }),
    bigData: () => custom('«Кедр»: данные на отдельном сервере базы', (g, res, L) => {
      const Y = layout(L, g), k = Y.D.bigIdx, c = Y.cellOf[k];
      if (!c) return { ok: false, detail: 'запросам «Кедра» некуда идти' };
      const dbs = [...Y.cellDown.get(c.id)].map(id => Y.byId.get(id)).filter(n => n.type === 'sql' || n.type === 'nosql');
      if (!dbs.length) return { ok: false, detail: `у ячейки «${nm(c)}» нет базы` };
      const shared = dbs.filter(n => [...(Y.ten.get(n.id) || [])].some(i => i !== k));
      return { ok: !shared.length, detail: shared.length ? `«${nm(shared[0])}» общая с мелкими франшизами — служба безопасности «Кедра» против` : `«${nm(c)}» → «${dbs.map(nm).join('», «')}»: там только его данные` };
    }),
    bigCell: () => custom('«Кедр» в своей ячейке: сбои и пики соседей его не задевают', (g, res, L) => {
      const Y = layout(L, g), k = Y.D.bigIdx, c = Y.cellOf[k];
      if (!c) return { ok: false, detail: 'запросам «Кедра» некуда идти' };
      const sharedIds = [...Y.cellDown.get(c.id)].filter(id => [...(Y.ten.get(id) || [])].some(i => i !== k));
      if (sharedIds.length) return { ok: false, detail: `общее с мелкими франшизами: «${sharedIds.slice(0, 3).map(id => nm(Y.byId.get(id))).join('», «')}»` };
      const st = surge(L, g), s = st && st.big ? st.big.s : 1;
      return { ok: s >= 0.999, detail: s >= 0.999 ? `«${nm(c)}» ни с кем не делится; в рассылку «Пульса» у «Кедра» ${pctS(s)}` : `в рассылку «Пульса» у «Кедра» только ${pctS(s)}` };
    })
  };

  /* ---------- советы прораба ---------- */
  const baseAdvise = SD.sim.advise;
  if (baseAdvise) SD.sim.advise = function (level, graph, res) {
    const A = baseAdvise.apply(this, arguments) || [];
    if (!level || !level.tenants) return A;
    try {
      leaks(level, graph).forEach(x => A.unshift({ sev: 'bad', node: x.node, text: 'Утечка между клиентами. ' + x.text }));
      const tn = res && res.ctx && res.ctx.tn, D = demand(level);
      if (tn && D.bigIdx >= 0 && tn.alpha[D.bigIdx] < 0.999) A.unshift({ sev: 'bad', node: tn.router, text: `«${level.tenants.big.name}» упирается в лимит на клиента: шлюз отбивает ${Math.round((1 - tn.alpha[D.bigIdx]) * 100)} % его запросов. Крупному клиенту нужен свой лимит — по тарифу.` });
      if (tn && tn.cell.some(c => !c)) A.unshift({ sev: 'bad', node: tn.router, text: 'Часть клиентов не закреплена ни за одной ячейкой: им некуда идти. Проверь «Чьих клиентов обслуживает» у сервисов за шлюзом.' });
    } catch (e) { /* без советов про клиентов */ }
    return A;
  };

  /* ---------- уровни ---------- */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const TL = o => Object.assign({ tier: 'saas', saasLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL(), features: ['tenant'] }, o);
  const GW = (p, x = 220, y = 250) => ['gw', 'gateway', x, y, Object.assign({ count: 2, tenantFrom: 'token', tenantQuota: 'none' }, p), 'Вход: API-шлюз'];
  const NOISY = { idx: 3, name: '«Пульс»', gen: '«Пульса»', surge: 25, mix: { read: 0.6, write: 0.4 } };
  const POOL_E = [['client', 'gw'], ['gw', 'app'], ['app', 'cache'], ['app', 'db']];

  SD.SAASL = [
    TL({
      id: 't-leak', title: 'Чужие записи', pattern: null,
      chips: ['мультиарендность', 'метка клиента', 'RLS'],
      story: 'Платформа записи на тренировки для 40 фитнес-франшиз: один сервис и одна база на всех, как бизнес-центр с общим входом. Вчера администратор франшизы «Север» открыл отчёт и увидел клиентов «Юга». Разбор показал три дыры: club_id сервис берёт из тела запроса, в одном отчёте забыли фильтр по клубу, а расписание в кэше лежит под общим ключом. Закрой утечки, не раздавая каждой франшизе свою базу.',
      traffic: { read: 3600, write: 400 }, hotSetGb: 6,
      tenants: { small: { n: 40 } },
      start: { nodes: [GW({ tenantFrom: 'body' }), ['app', 'app', 440, 250, { count: 3 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 8, tenantKey: false }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { replicas: 1, tenancy: 'pool', rls: false }, 'База записей']], edges: POOL_E },
      goals: [goals.leaks(), { t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, { t: 'cost', max: 1800 }],
      stretch: { cost: 1700 },
      hints: [
        { text: 'Нажми на «Вход: API-шлюз» → «Откуда метка клиента» → из проверенного токена.', why: 'Как пропуск в бизнес-центре: охранник смотрит на пропуск, а не на то, что ты о себе сказал. Метка клиента из тела запроса — это «я из офиса 17, пустите».' },
        { text: 'Нажми на «База записей» → включи «Защита строк в базе (RLS)».', why: 'Второй замок: если в каком-то запросе забыли WHERE club_id = …, база всё равно отдаст только строки клуба из сессии.' },
        { text: 'Нажми на «Кэш расписаний» → включи «Метка клиента в ключе кэша».', why: 'Ключ schedule:2026-10-06 одинаков у всех клубов. Ключ club:17:schedule:2026-10-06 — у каждого свой.' }
      ],
      decisions: [
        { q: 'Администратор «Севера» шлёт запрос с club_id = 17 — это id «Юга». Как сервис узнаёт, чей это запрос?', opts: [
          { t: 'Из проверенного токена: шлюз кладёт club_id из токена в заголовок, а что прислал клиент — не важно', v: 'right', fb: 'Да. Метку ставит тот, кто проверил вход. Всё, что пришло в теле запроса, — просто слова клиента.' },
          { t: 'Из тела запроса, но проверить, что клуб с таким id существует', v: 'wrong', fb: 'Клуб 17 существует — он просто чужой. Проверка существования не отвечает на вопрос «твой ли это клуб».' },
          { t: 'Из поддомена sever.booking.ru', v: 'partial', fb: 'Поддомен удобен, чтобы показать нужный клуб, но доверять можно только проверенному токену: поддомен и заголовок легко подставить вручную.' }
        ] },
        { q: 'Зачем RLS в базе, если в коде везде есть WHERE club_id = …?', opts: [
          { t: 'Это страховка: забытый фильтр в одном отчёте не превратится в утечку', v: 'right', fb: 'Именно. Сотни запросов пишут разные люди годами — когда-нибудь фильтр забудут. RLS — второй замок, который не зависит от внимательности.' },
          { t: 'RLS ускоряет запросы', v: 'wrong', fb: 'Наоборот, это ещё одно условие в каждом запросе — немного дороже. Платим за безопасность.' },
          { t: 'Чтобы вообще не писать WHERE в коде', v: 'partial', fb: 'Фильтр в коде всё равно полезен — для индексов и понятности. RLS не заменяет его, а страхует.' }
        ] },
        { q: 'Почему не дать каждой франшизе свою базу прямо сейчас?', opts: [
          { t: '40 баз — 40 серверов, копий, миграций и обновлений: дорого и тяжело; мелким хватает общих таблиц с меткой и RLS', v: 'right', fb: 'Да. Своя база на клиента — это ×40 к счёту за базы и к работе. Её дают тем, кто за это платит и этого требует (дальше — уровень про крупного клиента).' },
          { t: 'Свои базы небезопасны', v: 'wrong', fb: 'Наоборот, своя база изолирует лучше всего. Вопрос в цене и в обслуживании.' },
          { t: 'Так никто не делает', v: 'wrong', fb: 'Делают — для крупных клиентов с требованиями безопасности. Это модель silo.' }
        ] }
      ],
      solution: { nodes: [GW({ tenantFrom: 'token' }), ['app', 'app', 440, 250, { count: 3 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 8, tenantKey: true }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { replicas: 1, tenancy: 'pool', rls: true }, 'База записей']], edges: POOL_E,
        note: 'Метку клиента ставит шлюз из проверенного токена, база страхует фильтр защитой строк (RLS), в ключах кэша есть club_id. Общая база осталась — и это нормально для мелких клиентов.' }
    }),
    TL({
      id: 't-noisy', title: 'Шумный сосед', pattern: 'ratelimit',
      chips: ['noisy neighbor', 'квота на клиента', '429'],
      story: 'Франшиза «Пульс» запустила марафон и в 19:00 разослала пуш 200 тысячам подписчиков. За минуту её запросов стало в 25 раз больше: все открывают расписание и записываются. Общая база захлебнулась — и 39 других франшиз не могут записать клиентов на вечерние тренировки. Как в бизнес-центре, где одна компания заняла все переговорки. Сделай так, чтобы пик одного клиента не ронял остальных, и не раздувай счёт: завтра «Пульс» устроит рассылку вдвое больше.',
      traffic: { read: 4500, write: 500 }, hotSetGb: 6,
      tenants: { small: { n: 40 }, noisy: NOISY },
      start: { nodes: [GW({}), ['app', 'app', 440, 250, { count: 4 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 8, tenantKey: true }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { replicas: 1, rls: true }, 'База записей']], edges: POOL_E },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, goals.noisy(0.999), goals.leaks(), { t: 'cost', max: 2000 }],
      hints: [
        { text: 'Нажми на «Вход: API-шлюз» → «Лимит на клиента» → одинаковый, 400 запросов/с.', why: 'Как лимит на переговорки: одна компания не займёт все комнаты. «Пульс» получит свои 400 запросов в секунду, остальное — ответ 429 «подождите», а соседи работают как обычно.' },
        { text: 'Не покупай базу больше ради чужого пика.', why: 'Запас под рассылку «Пульса» оплачивают все клиенты, а завтра рассылка будет ×50 — и запаса снова не хватит. Лимит защищает при любом размере пика.' }
      ],
      decisions: [
        { q: 'Что делать с запросами «Пульса» сверх лимита?', opts: [
          { t: 'Отвечать 429 «Слишком много запросов» с подсказкой, через сколько повторить', v: 'right', fb: 'Да. Приложение подождёт и повторит, пользователь увидит «много желающих, повторяем…». Остальные клубы не страдают.' },
          { t: 'Молча держать запросы в очереди, пока не освободится место', v: 'partial', fb: 'Очередь годится для фоновой работы. Для записи на тренировку пользователь ждёт ответа: лучше честно сказать «подождите», чем висеть минуту.' },
          { t: 'Заблокировать «Пульс» до конца рассылки', v: 'wrong', fb: 'Это его клиенты и его деньги. Лимит должен ограничить, а не выключить клиента.' }
        ] },
        { q: 'Почему не добавить серверов базы на время рассылок?', opts: [
          { t: 'Рассылку клиент запускает когда хочет и какого угодно размера: запас под чужой пик никогда не угадаешь, а платят за него все', v: 'right', fb: 'Да. Лимит на клиента защищает от любого пика, а запас — только от того, который ты угадал.' },
          { t: 'Базу нельзя масштабировать', v: 'wrong', fb: 'Можно — вертикально и шардами. Просто это дорого и всё равно не спасает от пика побольше.' }
        ] }
      ],
      solution: { nodes: [GW({ tenantQuota: 'flat' }), ['app', 'app', 440, 250, { count: 4 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 8, tenantKey: true }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { replicas: 1, rls: true }, 'База записей']], edges: POOL_E,
        note: 'Лимит 400 запросов в секунду на клиента: «Пульс» получает свою долю, сверх неё — 429 «подождите». Общая база не перегружается, остальные франшизы записывают клиентов как обычно.' }
    }),
    TL({
      id: 't-cells', title: 'Радиус аварии', pattern: 'bulkhead',
      chips: ['ячейки', 'blast radius', 'выкладка по ячейкам'],
      story: 'Во вторник в 14:00 миграция добавила индекс в общую таблицу записей и заблокировала её на 40 минут. Все 40 франшиз разом не могли записать ни одного клиента. Ячейки — как корпуса бизнес-центра: у каждого свой лифт и своя котельная, и авария в одном корпусе не трогает другой. Раздели платформу на ячейки — у каждой свой сервис и своя база, франшизы закреплены за ячейками — так, чтобы сбой одной ячейки задевал не больше половины франшиз.',
      traffic: { read: 4000, write: 450 }, hotSetGb: 6,
      tenants: { small: { n: 40 }, noisy: NOISY },
      start: { nodes: [GW({ tenantQuota: 'flat' }), ['app', 'app', 440, 250, { count: 4 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 8, tenantKey: true }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { replicas: 1, rls: true }, 'База записей']], edges: POOL_E },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, goals.radius(0.5), goals.leaks(), { t: 'cost', max: 2100 }],
      hints: [
        { text: 'Поставь второй «Сервис» и вторую «Реляционную БД» и соедини: Шлюз → Сервис 2 → БД 2. У обоих сервисов «Чьих клиентов обслуживает» — мелких.', why: 'Шлюз закрепит за каждой ячейкой половину франшиз. Сбой одной базы заденет только её половину.' },
        { text: 'Ячейке нужна половина мощности: обоим сервисам по 2 экземпляра, базам — размер S с репликой.', why: 'Ячейки меньше — и серверы меньше. Счёт почти не растёт, а радиус аварии уменьшается вдвое.' },
        { text: 'В новой базе включи RLS, в новом кэше — метку клиента. Без них появится утечка.', why: 'Новая ячейка — те же правила безопасности. Их забывают чаще всего.' }
      ],
      decisions: [
        { q: 'Чем ячейки отличаются от двух копий сервиса за балансировщиком?', opts: [
          { t: 'У ячейки всё своё — сервис, база, кэш, а клиент закреплён за ячейкой; копии сервиса с общей базой падают вместе с базой', v: 'right', fb: 'Да. Копии сервиса защищают от падения сервера. Ячейки защищают от падения всего: базы, плохой миграции, неудачной выкладки.' },
          { t: 'Ничем, это одно и то же', v: 'wrong', fb: 'Две копии за балансировщиком делят одну базу — её сбой задевает всех.' }
        ] },
        { q: 'Что ещё дают ячейки, кроме изоляции сбоев?', opts: [
          { t: 'Выкладку по ячейкам: новая версия сначала уходит в одну ячейку — ошибка заденет половину, а не всех', v: 'right', fb: 'Да, и ещё — простой рост: новая партия клиентов — новая ячейка, без огромной базы на всех.' },
          { t: 'Они делают каждый запрос быстрее', v: 'wrong', fb: 'Скорость почти та же. Ячейки — про радиус аварии и рост.' }
        ] }
      ],
      solution: {
        nodes: [GW({ tenantQuota: 'flat' }),
          ['app', 'app', 440, 170, { count: 2, serves: 'small' }, 'Сервис · ячейка 1'], ['cache', 'cache', 680, 60, { mem: 8, tenantKey: true }, 'Кэш · ячейка 1'], ['db', 'sql', 680, 200, { size: 's', replicas: 1, rls: true }, 'База · ячейка 1'],
          ['app2', 'app', 440, 380, { count: 2, serves: 'small' }, 'Сервис · ячейка 2'], ['cache2', 'cache', 680, 330, { mem: 8, tenantKey: true }, 'Кэш · ячейка 2'], ['db2', 'sql', 680, 470, { size: 's', replicas: 1, rls: true }, 'База · ячейка 2']],
        edges: [['client', 'gw'], ['gw', 'app'], ['app', 'cache'], ['app', 'db'], ['gw', 'app2'], ['app2', 'cache2'], ['app2', 'db2']],
        note: 'Две ячейки: у каждой свой сервис, кэш и база размера S с репликой. Шлюз закрепил за каждой по 20 франшиз. Плохая миграция или упавшая база заденет только половину.' }
    }),
    TL({
      id: 't-big', title: 'Крупный клиент', pattern: 'bulkhead',
      chips: ['pool, bridge, silo', 'квота по тарифу', 'своя ячейка'],
      story: 'Сеть «Кедр» — 120 клубов, нагрузки у неё как у половины мелких франшиз вместе. Договор подпишут, если: данные «Кедра» лежат на отдельном сервере базы (так требует их служба безопасности) и ни сбой, ни пик у соседей их не задевает. Мелкие франшизы остаются в общем пуле — дать своей базой каждой выйдет в десятки раз дороже. Сейчас «Кедр» живёт со всеми, и одинаковый лимит на шлюзе режет его запросы. Собери смешанную модель: мелкие — вместе, крупный — отдельно.',
      traffic: { read: 6300, write: 700 }, hotSetGb: 8,
      tenants: { small: { n: 40 }, big: { share: 0.4, name: '«Кедр»' }, noisy: NOISY },
      start: { nodes: [GW({ tenantQuota: 'flat' }), ['app', 'app', 440, 250, { count: 5 }, 'Сервис записи'], ['cache', 'cache', 680, 130, { mem: 16, tenantKey: true }, 'Кэш расписаний'], ['db', 'sql', 680, 370, { size: 'l', replicas: 1, rls: true }, 'База записей']], edges: POOL_E },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 70 }, goals.bigData(), goals.bigCell(), goals.noisy(0.999), goals.leaks(), { t: 'cost', max: 2700 }],
      hints: [
        { text: 'Нажми на «Вход: API-шлюз» → «Лимит на клиента» → по тарифу.', why: '«Кедру» нужно ≈ 2 800 запросов в секунду, а одинаковый лимит — 400. По договору у него 3 000, у мелких — те же 400.' },
        { text: 'Поставь ячейку «Кедра»: Шлюз → новый «Сервис» (обслуживает только крупного клиента) → своя «Реляционная БД».', why: 'Отдельный корпус для крупного арендатора: свой вход, свои стены. Сбой или пик в общем пуле его не касается.' },
        { text: 'Общему сервису поставь «мелких клиентов» и уменьши мощность: «Кедр» ушёл — нагрузки стало меньше.', why: 'Иначе счёт вырастет на целую ячейку. Общей базе хватит размера M, ячейке «Кедра» — своей базы S с репликой.' }
      ],
      decisions: [
        { q: 'Почему не перевести на свою базу всех 41 клиента — так ведь безопаснее всего?', opts: [
          { t: 'Своя база каждой мелкой франшизе — ×40 к счёту и работе, а платят они немного; отдельно держат тех, кто этого требует и оплачивает', v: 'right', fb: 'Да. Обычно смешивают: мелкие — в общем пуле (pool), средние — своя схема (bridge), крупные — своя ячейка (silo).' },
          { t: 'Общий пул надёжнее отдельных баз', v: 'wrong', fb: 'Нет: общий пул дешевле, но сбой задевает всех. Отдельная ячейка надёжнее для клиента — и дороже.' }
        ] },
        { q: 'Почему одинаковый лимит для всех — плохая идея?', opts: [
          { t: 'Клиенты разного размера: лимит, удобный мелким, душит крупного, а удобный крупному не защищает от шумного мелкого', v: 'right', fb: 'Да. Лимит — часть тарифа: сколько клиент купил, столько и получает.' },
          { t: 'Лимиты вообще не нужны, если есть ячейки', v: 'partial', fb: 'Ячейки ограничивают, кого заденет пик, а лимит — сам пик. Внутри общей ячейки шумный сосед всё равно мешает соседям по ячейке.' }
        ] }
      ],
      solution: {
        nodes: [GW({ tenantQuota: 'plan' }),
          ['app', 'app', 440, 170, { count: 3, serves: 'small' }, 'Сервис записи · общий пул'], ['cache', 'cache', 680, 60, { mem: 8, tenantKey: true }, 'Кэш · общий пул'], ['db', 'sql', 680, 200, { replicas: 1, rls: true }, 'База · общий пул'],
          ['kapp', 'app', 440, 400, { count: 2, serves: 'big' }, 'Сервис · ячейка «Кедр»'], ['kcache', 'cache', 680, 340, { mem: 8 }, 'Кэш · «Кедр»'], ['kdb', 'sql', 680, 480, { size: 's', replicas: 1 }, 'База · «Кедр»']],
        edges: [['client', 'gw'], ['gw', 'app'], ['app', 'cache'], ['app', 'db'], ['gw', 'kapp'], ['kapp', 'kcache'], ['kapp', 'kdb']],
        note: 'Смешанная модель: 40 франшиз — в общем пуле с меткой клиента и RLS, «Кедр» — в своей ячейке со своим сервисом, кэшем и базой. Лимит по тарифу: мелким 400 запросов в секунду, «Кедру» — 3 000.' }
    })
  ];

  /* ---------- трек ---------- */
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^t-/.test(id) ? SD.SAASL.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.saasLvl ? 'Много клиентов: SaaS' : baseLabel(L);
  SD.nextLevel = L => { if (L.saasLvl) { const i = SD.SAASL.indexOf(L); return i >= 0 && i < SD.SAASL.length - 1 ? SD.SAASL[i + 1] : null; } return baseNext(L); };

  /* ---------- блок «Клиенты на схеме» в задании ---------- */
  const UI = { view: 'day', key: null, cache: null };
  const sig = (L, g) => L.id + '|' + JSON.stringify(g.nodes.map(n => [n.id, n.type, n.props])) + JSON.stringify(g.edges.map(e => [e.from, e.to]));
  function viewStats(L, g) {
    if (UI.lvl !== L.id) { UI.lvl = L.id; UI.view = 'day'; }
    const k = sig(L, g) + '|' + UI.view;
    if (UI.key === k) return UI.cache;
    let st = null, label = '';
    if (UI.view === 'surge' && surgeLevel(L)) { st = surge(L, g); label = `Рассылка ${L.tenants.noisy.gen || L.tenants.noisy.name}: его запросов ×${L.tenants.noisy.surge}`; }
    else if (/^fail:/.test(UI.view)) {
      const id = UI.view.slice(5), n = g.nodes.find(x => x.id === id);
      if (n) { st = stats(L, { nodes: g.nodes.filter(x => x.id !== id), edges: g.edges.filter(e => e.from !== id && e.to !== id) }); label = `Сбой «${nm(n)}»: база легла целиком`; }
    }
    if (!st) { UI.view = 'day'; st = stats(L, g); label = 'Обычный вечер'; }
    UI.key = k; UI.cache = { st, label };
    return UI.cache;
  }
  function panel(L, A) {
    if (!L || !L.tenants || !A || !A.graph) return '';
    const g = A.graph, Y = layout(L, g), D = Y.D, V = viewStats(L, g), st = V.st;
    const ci = id => Math.max(0, Y.cells.findIndex(c => c.id === id));
    let h = `<section class="tn-box" aria-label="Клиенты на схеме"><div class="tn-head"><b>Клиенты на схеме</b><small>Каждый квадрат — клиент; цвет — его ячейка, рамка — беда у клиента. Меняй схему — картина обновится.</small></div>`;
    const dbs = g.nodes.filter(n => n.type === 'sql' && Y.ten.has(n.id));
    h += `<div class="seg tn-views" role="group" aria-label="Что проиграть">`;
    const vb = (v, t) => `<button type="button" data-tnview="${v}" aria-selected="${UI.view === v}">${esc(t)}</button>`;
    h += vb('day', 'Обычный вечер');
    if (L.tenants.noisy) h += vb('surge', 'Рассылка ' + (L.tenants.noisy.gen || L.tenants.noisy.name));
    dbs.slice(0, 3).forEach(n => { h += vb('fail:' + n.id, 'Сбой: ' + nm(n)); });
    h += `</div><div class="tn-grid" role="img" aria-label="${esc(V.label)}">`;
    st.list.forEach(x => {
      const t = x.t, c = x.cell ? ci(x.cell) : -1, bad = x.s < 0.99, cut = x.alpha < 0.999;
      const tip = `${t.name} · ${x.cell ? 'ячейка «' + nm(Y.byId.get(x.cell)) + '»' : 'нет ячейки'} · успешно ${F().pct(x.s)}${cut ? ' · лимит пропускает ' + Math.round(x.alpha * 100) + ' %' : ''}`;
      h += `<span class="tn-t c${c < 0 ? 'x' : c % 4}${t.seg === 'big' ? ' big' : ''}${t.noisy ? ' noisy' : ''}${bad ? ' bad' : ''}" title="${esc(tip)}">${t.seg === 'big' ? esc(t.name) : t.noisy ? 'П' : ''}</span>`;
    });
    h += `</div><p class="tn-cap">${esc(V.label)}. ${Y.cells.length > 1 ? 'Ячеек: ' + Y.cells.length + ' — ' + Y.cells.map((c, i) => `<i class="tn-dot c${i % 4}"></i>${esc(nm(c))}`).join(', ') + '.' : 'Ячейка одна — все клиенты живут вместе.'}</p>`;
    const row = (who, x, extra) => `<tr><th>${who}</th><td class="${x >= 0.999 ? 'ok' : x >= 0.99 ? 'warn' : 'bad'}">${F().pct(x)}</td><td>${extra}</td></tr>`;
    h += `<div class="tbl"><table class="kind-table tn-tbl"><thead><tr><th>Кто</th><th>Успешно</th><th>Что видно</th></tr></thead><tbody>`;
    h += row(`${fr(D.n - (D.noisyIdx >= 0 ? 1 : 0))}`, st.small, Y.gw && quotaOf(Y.gw) ? `лимит ${quotaOf(Y.gw).small}/с на клиента` : 'лимитов нет');
    if (st.noisy) h += row(esc(st.noisy.t.name), st.noisy.s, `${F().num(st.noisy.t.D)} запросов/с${st.noisy.alpha < 0.999 ? ', пропущено ' + F().num(st.noisy.t.D * st.noisy.alpha) + ', остальное — 429' : ''}`);
    if (st.big) h += row(esc(st.big.t.name), st.big.s, `${F().num(st.big.t.D)} запросов/с${st.big.alpha < 0.999 ? ', лимит пропускает только ' + Math.round(st.big.alpha * 100) + ' %' : ''}${st.big.cell ? ' · «' + esc(nm(Y.byId.get(st.big.cell))) + '»' : ''}`);
    h += `</tbody></table></div>`;
    const lk = leaks(L, g);
    h += lk.length ? `<div class="tn-leaks bad"><b>Утечек: ${lk.length}</b><ul>${lk.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></div>` : `<div class="tn-leaks ok"><b>Утечек: 0</b> — метка клиента из токена, строки и ключи кэша разделены.</div>`;
    const pool = dbs.reduce((s, n) => s + ((A.res1 && A.res1.nodes[n.id] && A.res1.nodes[n.id].cost) || 0), 0);
    h += `<p class="tn-cap">Для сравнения: своя база каждому клиенту (silo для всех) — ${D.list.length} × ${F().usd(SILO_DB)} ≈ <b>${F().usd(D.list.length * SILO_DB)}</b> в месяц против ${F().usd(pool)} за базы на схеме.</p>`;
    return h + '</section>';
  }
  (SD.taskCtas = SD.taskCtas || []).push(panel);
  if (typeof document !== 'undefined') document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-tnview]'); if (!b) return;
    UI.view = b.dataset.tnview;
    if (SD.app && SD.app.A && SD.panels) SD.panels.task(SD.app.A);
  });

  SD.tenant = { layout, leaks, stats, surge, surgeLevel, radius, demand, goals, levels: SD.SAASL, panel };
})();
