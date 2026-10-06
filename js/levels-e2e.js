/* Сквозная аналитика: откуда пришёл покупатель и сколько принёс каждый рубль рекламы. Трек «Данные», уровни d-e2e-*.
   Общая аналогия темы (та же, что в лаборатории «Сквозная аналитика вживую»):
     магазин раздаёт листовки с купонами в разных местах — рекламные ссылки с UTM-метками;
     кассир смотрит купон и записывает, откуда пришёл покупатель — сборщик событий и метка в сессии;
     карта постоянного покупателя связывает прошлые визиты — склейка анонимного id с id покупателя;
     в конце месяца бухгалтер складывает чеки по купонам и сравнивает со счетами за листовки —
     импорт оплат и расходов по расписанию → витрина ROMI и CAC.
   Что добавлено (ядро симулятора не меняется, всё через SD.simExts и обёртку советов):
   1. Узел «Сборщик событий» (collector): где собираем (в браузере / на сервере), метка рекламы в сессии,
      согласие (feature 'e2e-consent'), склейка id (feature 'e2e-id').
      В браузере события идут Пользователи → Сборщик, на сервере — Пользователи → … → Сервис → Сборщик.
   2. Настройка ETL «Расходы — как в счетах» (feature 'e2e-money'). Расписание — прежний «Режим» ETL:
      у рекламных кабинетов нет потока, «Поток» = опрос каждую минуту, и его режет лимит запросов API.
   3. Внешние системы уровня — узлы типа external с props.sys: 'ads' (рекламные кабинеты), 'pay' (платёжная система).
      Стрелка — по пути данных: система → ETL → аналитическая БД.
   4. Модель качества данных res.e2e: сколько событий потеряно, у скольких заказов верный источник, сколько лишних
      «людей», из чего собрана витрина, её свежесть и расхождение с деньгами. Считается только на уровнях с L.e2e
      или когда на схеме есть сборщик — старые уровни и схемы считаются ровно как раньше. */
(function () {
  const T = SD.TYPES;
  const HAS_DOM = typeof document !== 'undefined';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const dec = (v, k) => { const p = Math.pow(10, k == null ? 1 : k); return (Math.round(v * p) / p).toString().replace('.', ','); };
  const pc = v => Math.round(v * 100) + ' %';
  const pc1 = v => dec(v * 100, v < 0.1 ? 1 : 0) + ' %';
  const lbl = n => n ? (n.label || (T[n.type] ? T[n.type].name : n.type)) : '';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dur = s => s == null || !isFinite(s) ? '—' : s >= 86400 ? Math.round(s / 86400) + ' сут' : s >= 3600 ? dec(s / 3600, s % 3600 ? 1 : 0) + ' ч' : s >= 60 ? Math.round(s / 60) + ' мин' : Math.max(1, Math.round(s)) + ' с';

  /* ---------- мир магазина: доли, на которых держится модель ---------- */
  const W0 = {
    adblock: 0.3,     // у трети посетителей блокировщик режет запросы к адресу трекера
    close: 0.02,      // события, не успевшие уйти при закрытии вкладки
    server: 0.005,    // серверный сбор: сетевые сбои
    decline: 0.15,    // не дали согласия на cookies
    sameVisit: 0.4,   // купили в тот же визит, в который пришли по рекламе
    cross: 0.3,       // пришли по рекламе с одного устройства, купили с другого
    fpWrong: 0.07,    // склейка по отпечатку путает разных людей за одним IP (офис, мобильный оператор)
    dup: { none: 0.45, fp: 0.3, login: 0.06 },   // лишних «людей» на одного настоящего
    refunds: 0.04,    // возвраты: видны только в платёжной системе
    unpaid: 0.07,     // заказы, которые не оплатили или отменили (выручка из заказов расходится на неоплаченные и возвраты)
    pay: 0.003,       // оплаты: расхождение на границе периода
    vat: 0.12,        // расходы как в кабинетах: где-то без НДС, где-то бонусами
    spendOk: 0.005,   // расходы, приведённые к счетам
    quota: 0.35       // опрос кабинетов каждую минуту: часть выгрузок отбита лимитом API
  };
  const world = L => Object.assign({}, W0, (L && L.e2e) || {});
  const COL_CAP = 20000;     // событий в секунду на экземпляр сборщика
  const SRV_U = 0.5;         // сервис принимает событие, дописывает id и метку и пересылает: полработы обычного запроса
  const ETL_D = { stream: 5, hourly: 3600, daily: 86400 };
  const SINK = new Set(['olap', 'lake']);
  const isCol = n => !!n && n.type === 'collector';

  /* =====================================================================
     1. Узел и настройки
     ===================================================================== */
  if (!T.collector) T.collector = {
    name: 'Сборщик событий', short: 'трекер и приёмник: Snowplow, RudderStack', group: 'analytics', perCap: COL_CAP, lat: 3,
    props: [
      { key: 'count', label: 'Экземпляры', type: 'range', min: 1, max: 6, def: 1, help: 'Каждый принимает ≈ 20 000 событий в секунду.' },
      { key: 'where', label: 'Где собираем события', type: 'select', def: 'browser',
        options: [['browser', 'В браузере — JS-трекер шлёт прямо в сборщик'], ['server', 'На сервере — сайт сам пересылает события']],
        help: 'В браузере: стрелка Пользователи → Сборщик. Просто подключить, но блокировщики рекламы режут запросы к адресам трекеров — у трети посетителей события пропадают. На сервере: браузер шлёт события на адрес твоего сайта, сервис пересылает их в сборщик (стрелка Сервис → Сборщик). Почти ничего не теряется, но каждое событие — работа для твоих серверов.' },
      tog('utm', 'Метка рекламы — в сессию', false, 'При первом заходе сохранить utm_source, utm_campaign и click id (yclid, gclid) в сессии на 30 дней и прикреплять ко всем событиям и к заказу. Без этого метка живёт только в адресе первой страницы.'),
      tog('consent', 'Спрашивать согласие (баннер cookies)', false, 'id посетителя — персональные данные. С баннером: кто согласился — пишем с id; кто отказался — только обезличенно (сколько визитов, но не кто). В браузере трекер без согласия вообще не запускается.', { feature: 'e2e-consent' }),
      { key: 'stitch', label: 'Склейка id', type: 'select', def: 'none', feature: 'e2e-id',
        options: [['none', 'Нет — каждый браузер считается отдельным человеком'], ['fp', 'По отпечатку браузера (IP + браузер)'], ['login', 'По входу и заказу: анонимный id ↔ id покупателя']],
        help: 'Без склейки телефон, ноутбук и рабочий компьютер одного человека — три посетителя, а заказ с ноутбука не связан с рекламой, по которой он пришёл с телефона. По входу и заказу: когда человек назвался, все его анонимные визиты привязываются к id покупателя. Отпечаток браузера не связывает разные устройства и путает разных людей за одним IP.' }
    ],
    cost: n => 90 * ((n.props && n.props.count) || 1) * (n.props && n.props.stitch === 'login' ? 1.25 : 1),
    info: {
      what: 'Принимает события сайта — просмотры, клики, добавления в корзину, заказы — с id посетителя и меткой рекламы и передаёт их в брокер и хранилище.',
      why: 'Чтобы понять, какая реклама приводит покупателей, нужна цепочка: рекламная ссылка с меткой → визит → события → заказ, и всё с одним id. Отчёты рекламных кабинетов не годятся: каждый приписывает заказ себе. Свой сборщик видит весь путь покупателя.',
      pros: ['Весь путь покупателя в своём хранилище', 'Метка рекламы доживает до заказа', 'Данные не зависят от чужих отчётов'],
      cons: ['В браузере часть событий режут блокировщики', 'id посетителя — персональные данные: нужно согласие', 'Без склейки один человек — несколько посетителей'],
      real: 'Snowplow, RudderStack, Segment, Matomo, Яндекс Метрика (Logs API)', numbers: [['Экземпляр', '≈ 20 000 событий/с'], ['Блокировщики', 'режут 20–40 % событий браузерного трекера']]
    }, dive: 'etl'
  };
  const hasP = (t, k) => T[t] && (T[t].props || []).some(p => p.key === k);
  if (T.etl && !hasP('etl', 'spendFix')) T.etl.props = T.etl.props.concat([
    tog('spendFix', 'Расходы — как в счетах: НДС, валюта, бонусы', false, 'Только для выгрузки из рекламных кабинетов. В одном кабинете расходы без НДС, в другом с НДС, часть оплачена бонусами. Конвейер приводит всё к сумме из счёта — иначе расходы в отчёте не сойдутся со счетами на ≈ 12 %.', { feature: 'e2e-money' })
  ]);

  SD.INNER_ICONS = SD.INNER_ICONS || {};
  SD.INNER_ICONS.collector = '<path d="M4 4h10l3 3v6"/><path d="M14 4v3h3"/><path d="M7 9h5M7 12h4"/><path d="M4 4v15h8"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="M17.5 15.8v1.9l1.2.9"/>';
  if (SD.iconInner && !SD.iconInner.__e2e) {
    const prevIcon = SD.iconInner;
    SD.iconInner = t => t === 'collector' ? SD.INNER_ICONS.collector : prevIcon(t);
    SD.iconInner.__e2e = true;
  }
  if (SD.SIMPLE_TYPES) SD.SIMPLE_TYPES.collector = ['Принимает от сайта события — кто что открыл, откуда пришёл, что купил — и передаёт их в хранилище.', 'Кассир, который смотрит купон и записывает, откуда пришёл покупатель.'];
  if (SD.TYPE_GUIDE) SD.TYPE_GUIDE.collector = [
    'Покупатель приходит по рекламной ссылке с меткой: utm_source=vk, utm_campaign=autumn, yclid=… .',
    'Трекер на странице (или сам сайт — при сборе на сервере) отправляет событие: «просмотр», «в корзину», «заказ» — с id посетителя и меткой.',
    'Сборщик проверяет событие, дописывает время и метку из сессии и кладёт в брокер.',
    'Конвейер грузит события в аналитическую БД. Там к заказу находится визит с меткой — и видно, какая реклама его привела.'
  ];
  if (SD.PROP_SIMPLE) {
    const o = SD.PROP_SIMPLE.collector = SD.PROP_SIMPLE.collector || {};
    o.where = 'Кассир на входе и купон на кассе. Кассир у входа видит не всех: треть покупателей заслоняет толпа. На кассе купон видят у каждого, кто платит. Трекер в браузере — кассир у входа: блокировщики режут его запросы. Сбор на сервере — проверка на кассе: события идут на адрес твоего сайта.';
    o.utm = 'Кассир подкалывает купон к чеку — и через день видно, по какой листовке пришёл покупатель. Без этого метка живёт только в адресе первой страницы.';
    o.consent = 'Записать телефон покупателя можно, только если он разрешил. Без согласия — обезличенно: сколько было визитов, но не кто.';
    o.stitch = 'Карта постоянного покупателя: по её номеру три визита одного человека сводятся в одну историю. Узнавать «по лицу» в толпе — как отпечаток браузера: похожих путает.';
    const e = SD.PROP_SIMPLE.etl = SD.PROP_SIMPLE.etl || {};
    e.spendFix = 'Бухгалтер приводит счета к одному виду: где-то сумма без НДС, где-то со скидкой бонусами. Без этого расходы в отчёте не сойдутся со счетами.';
  }
  if (SD.OPT_SIMPLE) {
    SD.OPT_SIMPLE['collector.where'] = { browser: 'В браузере: быстро подключить, но ≈ 30 % событий режут блокировщики.', server: 'На сервере: теряется ≈ 0,5 %, но сервис пересылает каждое событие — нагрузка на него растёт.' };
    SD.OPT_SIMPLE['collector.utm'] = { true: 'Метка живёт в сессии 30 дней и доезжает до заказа.', false: 'Метка видна только на первой странице: источник известен лишь у купивших сразу.' };
    SD.OPT_SIMPLE['collector.consent'] = { true: 'Кто отказался — обезличенно: в отчётах есть, а связать с покупателем нельзя.', false: 'id пишется у всех без спроса — нарушение закона о персональных данных.' };
    SD.OPT_SIMPLE['collector.stitch'] = { none: 'Каждый браузер — отдельный человек: людей больше, конверсия ниже, заказ с другого устройства — «без источника».', fp: 'Склеивает визиты одного браузера, но разные устройства не связывает и путает людей за одним IP.', login: 'Вход и заказ связывают все визиты человека: один человек — один профиль.' };
    SD.OPT_SIMPLE['etl.spendFix'] = { true: 'Расходы равны счетам: без разницы в НДС и бонусах.', false: 'Расходы как в кабинетах: с отчётом бухгалтерии разойдутся на ≈ 12 %.' };
  }

  /* =====================================================================
     2. Симуляция: маршруты событий и сборщик
     ===================================================================== */
  function canHandle(ctx, n, kind) {
    if (n.type === 'collector') return kind === 'events';
    return undefined;
  }
  function route(ctx, n, kind, r, H) {
    if (n.type === 'collector') {
      const ks = H.kids(ctx, n.id);
      const t = ks.find(k => k.type === 'queue') || ks.find(k => k.type === 'etl') || ks.find(k => SINK.has(k.type));
      if (t) r.fwd.push({ to: t.id, kind: 'events', f: 1, mode: t.type === 'queue' ? 'seq' : 'async' }); else { r.fail = 1; r.noSink = true; }
      r.u = 1; return true;
    }
    if (kind !== 'events') return false;
    if (n.type === 'client') {
      const ks = H.kids(ctx, n.id), cols = ks.filter(isCol);
      if (!cols.length) return false;
      const rtt = ctx.level.global ? 140 : 25;
      r.u = 0;
      const br = cols.filter(c => (c.props.where || 'browser') === 'browser');
      if (br.length) { r.fwd = H.spread(ctx, br, 'events', 'alt', () => rtt); r.e2eBrowser = true; return true; }
      /* сборщик «на сервере» от браузера напрямую не принимает: события идут на сайт */
      let c = ks.filter(k => !isCol(k) && H.canHandle(ctx, k.id, 'events'));
      const dyn = c.filter(k => k.type !== 'cdn' && k.type !== 'objstore'); if (dyn.length) c = dyn;
      const d = c.filter(k => ['tsdb', 'queue', 'olap', 'lake'].includes(k.type)); if (d.length) c = d;
      if (!c.length) { r.fail = 1; r.noPath = true; return true; }
      r.fwd = H.spread(ctx, c, 'events', 'alt', k => k.type === 'cdn' ? 12 : rtt);
      return true;
    }
    if (n.type === 'app' || n.type === 'faas') {
      const ks = H.kids(ctx, n.id);
      const sv = ks.filter(k => isCol(k) && k.props.where === 'server');
      if (sv.length) { r.fwd = H.spread(ctx, sv, 'events', 'alt'); r.u = SRV_U; r.e2eServer = true; return true; }
      /* на уровнях сквозной аналитики без сборщика и без своего пути в брокер сайт событий не записывает */
      if (ctx.level.e2e && !ks.some(k => k.type === 'queue' || SINK.has(k.type))) { r.u = 0; r.untracked = true; return true; }
    }
    return false;
  }
  function capacity(ctx, n, H) { return n.type === 'collector' ? H.alive(ctx, n) * COL_CAP : undefined; }
  function state(ctx, n, ld, cap, H) {
    if (n.type !== 'collector') return undefined;
    const u = (ld.events || 0) / (cap || 1);
    return { util: u, lat: () => 3 * H.qf(Math.min(u, 1.2)), ok: () => (u > 1 ? 1 / u : 1), info: { e2e: true } };
  }

  /* ---------- куда доходят данные: аналитическая БД и озеро через брокеры и конвейеры ---------- */
  function sinksFrom(ctx, id, H, direct) {
    const out = new Map();
    const walk = (nid, d, dep, seen) => {
      if (dep > 6) return;
      H.kids(ctx, nid).forEach(k => {
        if (seen.has(k.id)) return;
        if (SINK.has(k.type)) { const v = d + (k.type === 'lake' ? 60 : 0) + (dep === 0 && direct ? direct : 0); if (!out.has(k.id) || out.get(k.id) > v) out.set(k.id, v); return; }
        if (k.type === 'queue') walk(k.id, d + 2, dep + 1, new Set(seen).add(k.id));
        else if (k.type === 'etl') walk(k.id, d + (ETL_D[k.props.mode] || 3600), dep + 1, new Set(seen).add(k.id));
      });
    };
    walk(id, 0, 0, new Set([id]));
    return out;
  }
  /* источник вне потока событий (кабинеты, платёжка, база заказов): только через ETL */
  function viaEtl(ctx, src, H, fn) {
    H.kids(ctx, src.id).filter(k => k.type === 'etl').forEach(e => {
      const d0 = src.props && src.props.sys === 'ads' && e.props.mode === 'stream' ? 60 : (ETL_D[e.props.mode] || 3600);
      sinksFrom(ctx, e.id, H).forEach((d, sid) => fn(sid, d0 + d, e));
    });
  }

  /* ---------- модель качества данных ---------- */
  function collect(ctx, res, level, H) {
    const nodes = [...ctx.nodes.values()], cols = nodes.filter(isCol);
    if (!level.e2e && !cols.length) return;
    const W = world(level), E = ((level.traffic || {}).events || 0) * (ctx.opts.mul || 1);
    const flow = (a, b) => ((ctx.edgeFlow.get(a + '>' + b) || {}).events || 0);
    const okEv = res.kinds.events ? res.kinds.events.success : 1;
    let deliv = 0, attr = 0, dupW = 0, dupN = 0, browser = 0, server = 0, blocked = 0, noSink = 0;
    const per = cols.map(c => {
      const p = c.props || {}, ins = H.parents(ctx, c.id);
      const fromClient = ins.filter(x => x.type === 'client').reduce((s, x) => s + flow(x.id, c.id), 0);
      const fromSrv = ins.filter(x => x.type === 'app' || x.type === 'faas').reduce((s, x) => s + flow(x.id, c.id), 0);
      const sinks = sinksFrom(ctx, c.id, H, 30), reach = sinks.size ? 1 : 0;
      const seenB = (1 - W.adblock) * (1 - W.close) * (p.consent ? 1 - W.decline : 1), seenS = 1 - W.server;
      const linkS = seenS * (p.consent ? 1 - W.decline : 1);
      const st = p.stitch || 'none';
      const idF = p.utm ? (st === 'login' ? 1 : st === 'fp' ? (1 - W.cross) * (1 - W.fpWrong) : 1 - W.cross) : W.sameVisit * (st === 'fp' ? 1 - W.fpWrong : 1);
      const fl = fromClient + fromSrv;
      deliv += (fromClient * seenB + fromSrv * seenS) * reach;
      attr += (fromClient * seenB + fromSrv * linkS) * reach * idF;
      blocked += fromClient * (1 - seenB) + fromSrv * (1 - seenS);
      if (!reach) noSink += fromClient * seenB + fromSrv * seenS;
      browser += fromClient; server += fromSrv;
      if (reach && fl > 0) { dupW += fl * (W.dup[st] == null ? W.dup.none : W.dup[st]); dupN += fl; }
      return { id: c.id, name: lbl(c), where: p.where || 'browser', utm: !!p.utm, consent: !!p.consent, stitch: st, fromClient, fromSrv, flow: fl, reach, sinks,
        seen: fromClient > 0 ? seenB : seenS, clientEdge: ins.some(x => x.type === 'client'), appEdge: ins.some(x => x.type === 'app' || x.type === 'faas') };
    });
    /* события, которые сервис сам пишет в брокер или хранилище, без сборщика: без метки в сессии и без склейки */
    let own = 0; const ownSinks = new Map();
    nodes.forEach(n => {
      if (n.type !== 'app' && n.type !== 'faas') return;
      H.kids(ctx, n.id).forEach(k => {
        if (k.type !== 'queue' && !SINK.has(k.type)) return;
        const f = flow(n.id, k.id); if (!f) return;
        own += f;
        const sk = SINK.has(k.type) ? new Map([[k.id, k.type === 'lake' ? 60 : 0]]) : new Map([...sinksFrom(ctx, k.id, H)].map(([id, d]) => [id, d + 2]));
        if (sk.size) { deliv += f * (1 - W.server); attr += f * (1 - W.server) * W.sameVisit; sk.forEach((d, id) => { if (!ownSinks.has(id) || ownSinks.get(id) > d) ownSinks.set(id, d); }); }
        else noSink += f;
      });
    });
    deliv *= okEv; attr *= okEv;
    const tracked = browser + server + own;
    const X = {
      E, W, deliv, lost: E > 0 ? clamp(1 - deliv / E, 0, 1) : 0, attr: E > 0 ? clamp(attr / E, 0, 1) : 0,
      dup: dupN ? dupW / dupN : null, browser: E ? browser / E : 0, server: E ? server / E : 0, own: E ? own / E : 0,
      untracked: E ? clamp(1 - tracked / E, 0, 1) : 0, blocked: E ? blocked / E : 0, noSink: E ? noSink / E : 0, overload: 1 - okEv,
      cols: per
    };
    const act = per.filter(c => c.flow > 0 && c.reach);
    X.active = act.length > 0;
    X.utmOn = act.some(c => c.utm);
    X.consentOk = act.length > 0 && act.every(c => c.consent) && own <= 0;
    X.stitch = act.length ? (act.every(c => c.stitch === 'login') ? 'login' : act.some(c => c.stitch === 'fp') ? 'fp' : 'none') : null;

    /* витрина: в одном хранилище клики с метками, расходы на рекламу и выручка */
    const mart = new Map();
    const M = id => { if (!mart.has(id)) mart.set(id, { id, name: lbl(ctx.nodes.get(id)), ev: null, utm: false, spend: null, rev: null }); return mart.get(id); };
    act.forEach(c => c.sinks.forEach((d, sid) => { const m = M(sid); if (m.ev == null || d < m.ev) m.ev = d; if (c.utm) m.utm = true; }));
    ownSinks.forEach((d, sid) => { const m = M(sid); if (m.ev == null || d < m.ev) m.ev = d; });
    const better = (a, b) => !a || b.gap < a.gap - 1e-9 || (Math.abs(b.gap - a.gap) < 1e-9 && b.delay < a.delay);
    nodes.forEach(n => {
      const sys = n.type === 'external' && n.props ? n.props.sys : null;
      if (sys === 'ads') viaEtl(ctx, n, H, (sid, d, e) => {
        const gap = (e.props.spendFix ? W.spendOk : W.vat) + (e.props.mode === 'stream' ? W.quota : 0);
        const v = { gap, delay: d, etl: e.id, stream: e.props.mode === 'stream', fix: !!e.props.spendFix, src: n.id };
        const m = M(sid); if (better(m.spend, v)) m.spend = v;
      });
      if (sys === 'pay') viaEtl(ctx, n, H, (sid, d, e) => { const v = { src: 'pay', gap: W.pay, delay: d, node: n.id }; const m = M(sid); if (better(m.rev, v)) m.rev = v; });
      if ((n.type === 'sql' || n.type === 'nosql') && ((ctx.load.get(n.id) || {}).write || 0) > 0)
        viaEtl(ctx, n, H, (sid, d) => { const v = { src: 'orders', gap: W.unpaid + W.refunds, delay: d, node: n.id }; const m = M(sid); if (better(m.rev, v)) m.rev = v; });
    });
    mart.forEach(m => { if (m.ev != null) { const v = { src: 'events', gap: clamp(X.lost + W.unpaid + W.refunds, 0, 1), delay: m.ev }; if (better(m.rev, v)) m.rev = v; } });
    const score = m => (m.ev != null && m.utm ? 1 : 0) + (m.spend ? 1 : 0) + (m.rev ? 1 : 0);
    const best = [...mart.values()].sort((a, b) => score(b) - score(a) || ((a.rev || { gap: 9 }).gap - (b.rev || { gap: 9 }).gap))[0] || null;
    X.mart = best;
    if (best) {
      const ds = [best.ev, best.spend && best.spend.delay, best.rev && best.rev.delay].filter(v => v != null);
      X.fresh = ds.length ? Math.max(...ds) : null;
      X.gap = best.spend && best.rev ? Math.max(best.spend.gap, best.rev.gap) : null;
    } else { X.fresh = null; X.gap = null; }
    res.e2e = X;
  }
  (SD.simExts = SD.simExts || []).unshift({ canHandle, route, capacity, state, collect });

  /* =====================================================================
     3. Советы прораба по сквозной аналитике (к общим советам, только при res.e2e)
     ===================================================================== */
  function advice(L, g, res) {
    const X = res && res.e2e, out = [];
    if (!X) return out;
    const feat = f => !!(L.sandbox || (L.features || []).includes(f));
    if (X.E > 0 && X.untracked > 0.5 && !X.cols.length) out.push({ sev: 'bad', text: 'Сайт не записывает, что делают покупатели: событиям некуда идти. Поставь «Сборщик событий» и проведи путь: сборщик → брокер → ETL-конвейер → аналитическая БД.', dive: 'etl' });
    X.cols.forEach(c => {
      const nm = `«${c.name}»`;
      if (c.where === 'browser' && !c.clientEdge) out.push({ sev: 'bad', node: c.id, text: `${nm} собирает события в браузере, но от «Пользователей» к нему нет стрелки. Проведи Пользователи → ${nm} — или переключи «Где собираем» на сервер и соедини Сервис → ${nm}.` });
      if (c.where === 'server' && !c.appEdge) out.push({ sev: 'bad', node: c.id, text: `${nm} собирает события на сервере: их пересылает сервис. Соедини Сервис → ${nm}.` });
      if (c.where === 'server' && c.clientEdge && c.appEdge) out.push({ sev: 'info', node: c.id, text: `Стрелка «Пользователи → ${nm}» не используется: при сборе на сервере браузер шлёт события на сайт, а сервис пересылает их в сборщик.` });
      if (c.where === 'browser' && c.appEdge && c.clientEdge) out.push({ sev: 'info', node: c.id, text: `Стрелка «Сервис → ${nm}» не используется: при сборе в браузере события идут прямо от пользователей. Чтобы их пересылал сервис, переключи «Где собираем» на сервер.` });
      if (c.flow > 0 && !c.reach) out.push({ sev: 'bad', node: c.id, text: `У ${nm} нет пути до хранилища: события принимаются и пропадают. Соедини сборщик с брокером, брокер — с ETL-конвейером, конвейер — с аналитической БД или озером.`, dive: 'etl' });
      if (c.flow <= 0) return;
      if (c.fromClient > 0 && L.e2e) out.push({ sev: feat('e2e-consent') ? 'warn' : 'info', node: c.id, text: `Трекер в браузере теряет ≈ ${pc(1 - c.seen)} событий: блокировщики рекламы режут запросы к адресу трекера${c.consent ? ', без согласия трекер вообще не запускается' : ''}, часть событий не успевает уйти при закрытии вкладки. Сбор на сервере теряет ≈ 0,5 %.` });
      if (!c.utm) out.push({ sev: 'warn', node: c.id, text: `Метка рекламы видна только в адресе первой страницы: ${nm} её не сохраняет. Источник известен лишь у тех, кто купил в тот же визит. Включи «Метка рекламы — в сессию».` });
      if (feat('e2e-consent') && !c.consent) out.push({ sev: 'warn', node: c.id, text: `${nm} записывает id посетителя без согласия. id и история визитов — персональные данные: включи «Спрашивать согласие». Кто откажется, останется в отчётах обезличенно.` });
      if (feat('e2e-id') && c.stitch === 'fp') out.push({ sev: 'warn', node: c.id, text: `Склейка по отпечатку браузера не связывает телефон с ноутбуком и путает людей за одним IP — офис, мобильный оператор. Надёжная склейка — по входу и заказу: человек сам назвался.` });
      else if (feat('e2e-id') && c.stitch === 'none') out.push({ sev: 'info', node: c.id, text: `Каждый браузер считается отдельным человеком: «людей» на ≈ ${pc(X.W.dup.none)} больше, чем на самом деле, а заказ с другого устройства остаётся «без источника». Включи склейку id по входу и заказу.` });
    });
    if (L.e2e && L.e2e.money) {
      const ads = g.nodes.filter(n => n.type === 'external' && n.props && n.props.sys === 'ads'), pay = g.nodes.filter(n => n.type === 'external' && n.props && n.props.sys === 'pay');
      const m = X.mart || {};
      const etlKid = n => g.edges.some(e => e.from === n.id && (g.nodes.find(x => x.id === e.to) || {}).type === 'etl');
      const backward = n => g.edges.some(e => e.to === n.id);
      [...ads, ...pay].forEach(n => { if (backward(n) && !etlKid(n)) out.push({ sev: 'info', node: n.id, text: `Стрелки на этой схеме — по пути данных: «${lbl(n)}» → ETL-конвейер → аналитическая БД. Конвейер сам забирает данные по расписанию, но стрелка рисуется от источника.` }); });
      if (!m.spend) out.push({ sev: 'bad', node: ads[0] && ads[0].id, text: 'Расходов на рекламу в хранилище нет: маркетолог сводит Excel руками раз в неделю. Соедини «Рекламные кабинеты» → ETL-конвейер → аналитическая БД.', dive: 'etl' });
      else {
        if (m.spend.stream) out.push({ sev: 'warn', node: m.spend.etl, text: `Кабинеты не отдают поток: «Поток» у конвейера — это опрос API каждую минуту, и лимит запросов отбивает ≈ ${pc(X.W.quota)} выгрузок. Раз в час хватает: кабинеты сами пересчитывают расходы примерно так.` });
        if (!m.spend.fix) out.push({ sev: 'warn', node: m.spend.etl, text: 'Расходы взяты как в кабинетах: в одном без НДС, в другом с НДС, часть оплачена бонусами — со счетами расходится на ≈ 12 %. Включи у конвейера «Расходы — как в счетах».' });
      }
      if (!m.rev) out.push({ sev: 'bad', node: pay[0] && pay[0].id, text: 'Выручки в хранилище нет — окупаемость считать не из чего. Соедини «Платёжную систему» → ETL-конвейер → аналитическая БД.' });
      else if (m.rev.src === 'orders') out.push({ sev: 'warn', node: m.rev.node, text: `Выручка взята из заказов: ≈ ${pc(X.W.unpaid)} из них не оплачены или отменены, а возвраты (≈ ${pc(X.W.refunds)}) в заказах не видны. Деньги — в платёжной системе.` });
      else if (m.rev.src === 'events') out.push({ sev: 'warn', node: pay[0] && pay[0].id, text: 'Выручка считается по событиям «покупка» от трекера: в них и неоплаченные заказы, а возвраты не видны. Деньги — в платёжной системе.' });
    }
    return out;
  }
  if (SD.sim && SD.sim.advise && !SD.sim.advise.__e2e) {
    const baseAdvise = SD.sim.advise;
    const ORDER = { bad: 0, warn: 1, info: 2 };
    SD.sim.advise = function (L, g, res, an) {
      let a = baseAdvise.apply(this, arguments);
      if (!res || !res.e2e) return a;
      /* конвейер, который забирает данные из внешней системы по расписанию, трафика пользователей не получает — это не ошибка */
      const fedByExt = id => g.edges.some(e => e.to === id && (g.nodes.find(x => x.id === e.from) || {}).type === 'external');
      a = a.filter(x => !(x.node && x.sev === 'info' && /не получает трафика/.test(x.text) && (g.nodes.find(n => n.id === x.node) || {}).type === 'etl' && fedByExt(x.node)));
      let add = [];
      try { add = advice(L, g, res); } catch (e) { add = []; }
      if (!add.length) return a;
      const seen = new Set(a.map(x => x.text));
      return a.concat(add.filter(x => !seen.has(x.text))).sort((p, q) => ORDER[p.sev] - ORDER[q.sev]);
    };
    SD.sim.advise.__e2e = true;
  }

  /* =====================================================================
     4. Цели
     ===================================================================== */
  const none = { ok: false, detail: 'нет данных о событиях' };
  const reachGoal = min => ({ t: 'custom', text: `До аналитического хранилища доходит не меньше ${pc(min)} событий сайта`, fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    const got = X.E ? X.deliv / X.E : 0;
    if (got <= 0) return { ok: false, detail: X.untracked > 0.5 ? 'сайт ничего не записывает: событиям некуда идти' : 'события не доходят до аналитической БД или озера' };
    return { ok: got >= min, detail: `доходит ${pc1(got)}${X.browser > 0.01 ? ' — часть режут блокировщики в браузере' : ''}` };
  } });
  const utmGoal = { t: 'custom', text: 'Метка рекламы доживает до заказа', fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    if (!X.active) return { ok: false, detail: 'сборщика нет или от него ничего не доходит до хранилища' };
    if (!X.utmOn) return { ok: false, detail: `метка теряется после первой страницы: источник известен только у купивших сразу — ${pc(X.attr)} заказов` };
    return { ok: X.attr > 0.01, detail: `источник известен у ${pc(X.attr)} заказов` };
  } };
  const lostGoal = max => ({ t: 'custom', text: `Теряется не больше ${pc(max)} событий`, fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    const why = X.untracked > 0.3 ? 'большую часть событий никто не принимает' : X.noSink > 0.05 ? 'у сборщика нет пути до хранилища' : X.blocked > max ? `${pc(X.blocked)} режут блокировщики и закрытые вкладки` : X.overload > 0.01 ? 'сборщик или брокер перегружены' : '';
    return { ok: X.lost <= max, detail: `потеряно ${pc1(X.lost)}${why ? ': ' + why : ''}` };
  } });
  const consentGoal = { t: 'custom', text: 'Данные о человеке — только с его согласия', fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    if (!X.active) return { ok: false, detail: 'сборщика, от которого данные доходят до хранилища, нет' };
    const bad = X.cols.find(c => c.flow > 0 && c.reach && !c.consent);
    if (bad) return { ok: false, detail: `«${bad.name}» пишет id посетителя без согласия` };
    if (X.own > 0.001) return { ok: false, detail: 'сервис сам пишет события с id в брокер — без баннера согласия' };
    return { ok: true, detail: `согласие спрашивается: кто отказался (≈ ${pc(X.W.decline)}) — обезличенно` };
  } };
  const dupGoal = max => ({ t: 'custom', text: `Один покупатель — один человек: лишних «людей» не больше ${pc(max)}`, fn: (g, res) => {
    const X = res.e2e; if (!X || X.dup == null) return { ok: false, detail: 'считать некого: события не доходят до хранилища' };
    const w = { none: 'каждый браузер считается отдельным человеком', fp: 'отпечаток не связывает разные устройства', login: 'визиты связаны входом и заказом' }[X.stitch] || '';
    return { ok: X.dup <= max, detail: `лишних ≈ ${pc(X.dup)}${w ? ': ' + w : ''}` };
  } });
  const attrGoal = min => ({ t: 'custom', text: `Верный источник у ${pc(min)} заказов и больше`, fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    const w = !X.active ? 'события не доходят до хранилища' : !X.utmOn ? 'метка рекламы не сохраняется в сессии' : X.browser > 0.01 ? 'в браузере часть покупателей не видна' : X.stitch !== 'login' ? 'заказы с другого устройства — «без источника»' : '';
    return { ok: X.attr >= min, detail: `сейчас ${pc(X.attr)}${X.attr < min && w ? ': ' + w : ''}` };
  } });
  const romiGoal = { t: 'custom', text: 'Витрина ROMI и CAC по каналам собирается сама', fn: (g, res) => {
    const X = res.e2e; if (!X) return none;
    const m = X.mart; if (!m) return { ok: false, detail: 'в аналитическое хранилище ничего не приходит' };
    const miss = [];
    if (m.ev == null || !m.utm) miss.push('клики с метками рекламы');
    else if (X.attr < 0.8) miss.push(`верного источника у 80 % заказов (сейчас ${pc(X.attr)}) — по каналам не разложить`);
    if (!m.spend) miss.push('расходы из кабинетов');
    if (!m.rev) miss.push('выручка');
    return miss.length ? { ok: false, detail: `в хранилище «${m.name}» нет: ${miss.join(', ')}` } : { ok: true, detail: `в хранилище «${m.name}»: клики с метками, расходы и ${m.rev.src === 'pay' ? 'оплаты' : m.rev.src === 'orders' ? 'заказы' : 'покупки из трекера'}` };
  } };
  const freshGoal = max => ({ t: 'custom', text: `Витрина отстаёт от жизни не больше чем на ${dur(max)}`, fn: (g, res) => {
    const X = res.e2e, m = X && X.mart; if (!m || X.fresh == null) return { ok: false, detail: 'витрины нет' };
    const parts = [];
    if (m.ev != null) parts.push('клики ' + dur(m.ev));
    if (m.spend) parts.push('расходы ' + dur(m.spend.delay));
    if (m.rev) parts.push((m.rev.src === 'pay' ? 'оплаты ' : m.rev.src === 'orders' ? 'заказы ' : 'покупки ') + dur(m.rev.delay));
    if (!m.spend) parts.push('расходы не загружаются');
    if (!m.rev) parts.push('выручки нет');
    return { ok: X.fresh <= max && !!m.spend && !!m.rev, detail: parts.join(' · ') };
  } });
  const gapGoal = max => ({ t: 'custom', text: `Сходится с деньгами: расхождение не больше ${pc(max)}`, fn: (g, res) => {
    const X = res.e2e, m = X && X.mart; if (!m) return { ok: false, detail: 'витрины нет' };
    if (!m.rev || !m.spend) return { ok: false, detail: !m.spend ? 'расходов нет — сверять не с чем' : 'выручки нет — сверять не с чем' };
    const rv = m.rev.src === 'pay' ? `выручка = оплатам (${pc1(m.rev.gap)})` : m.rev.src === 'orders' ? `выручка из заказов: ${pc1(m.rev.gap)} — неоплаченные, отменённые и возвраты` : `выручка по событиям трекера: ${pc1(m.rev.gap)}`;
    const sp = m.spend.stream ? `расходы: ${pc1(m.spend.gap)} — лимит API режет выгрузки` : !m.spend.fix ? `расходы: ${pc1(m.spend.gap)} — НДС и бонусы` : `расходы = счетам (${pc1(m.spend.gap)})`;
    return { ok: X.gap <= max, detail: rv + '; ' + sp };
  } });

  /* =====================================================================
     5. Картинки «На пальцах»: одна аналогия на всю тему
     Карточка-предмет: значок, подпись-аналогия и термин. data-lf-k — номер пары в fingers.map.
     ===================================================================== */
  const ICO = {
    flyer: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 10h7M8 13h8"/><rect x="8" y="16" width="8" height="3" rx=".5" stroke-dasharray="1.6 1.4"/>',
    person: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 20c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2"/>',
    cashier: '<rect x="3" y="11" width="18" height="9" rx="1.5"/><path d="M6 11V6h12v5"/><path d="M8.5 8.5h7"/><path d="M7 15h2M11 15h2M15 15h2"/>',
    clip: '<rect x="4" y="7" width="11" height="14" rx="1"/><rect x="11" y="3" width="9" height="6" rx="1" stroke-dasharray="1.6 1.4"/><path d="M7 12h5M7 15h5M7 18h3"/>',
    receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11.5h6M9 15h3"/>',
    notebook: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 3v18"/><path d="M12 8h4M12 12h4M12 16h3"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="1.5"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M14 13.5h3v3h-3z"/>',
    crowd: '<circle cx="7" cy="8" r="2.4"/><circle cx="17" cy="8" r="2.4"/><circle cx="12" cy="6.5" r="2.6"/><path d="M2.5 19c0-2.8 2-4.8 4.5-4.8M21.5 19c0-2.8-2-4.8-4.5-4.8M7 20c0-3.3 2.2-5.6 5-5.6s5 2.3 5 5.6"/>',
    ask: '<path d="M4 5h16v11H10l-4 3v-3H4z"/><path d="M10.4 9a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M12 13.6h.01"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M3 18h18l-1.5-3h-15z"/>',
    desk: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M9 20h6M12 16v4"/>',
    card: '<rect x="2.5" y="6" width="19" height="12.5" rx="2"/><path d="M2.5 10h19"/><path d="M6 14.5h5"/>',
    profile: '<circle cx="8" cy="8" r="2.6"/><path d="M3.5 17.5c0-2.7 2-4.6 4.5-4.6s4.5 1.9 4.5 4.6"/><path d="M15 7h6M15 11h6M15 15h4"/>',
    face: '<circle cx="12" cy="12" r="8"/><path d="M9 10h.01M15 10h.01"/><path d="M9 15.5c1.8 1.2 4.2 1.2 6 0"/><path d="M4 4l16 16" stroke-dasharray="2 2"/>',
    calc: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><rect x="8" y="5.5" width="8" height="4" rx=".5"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 17h.01"/>',
    bill: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3"/><path d="M9 10h6M9 13h6M9 16.5h3"/>',
    table: '<path d="M4 20h16"/><rect x="5.5" y="12" width="3" height="8"/><rect x="10.5" y="7" width="3" height="13"/><rect x="15.5" y="10" width="3" height="10"/>',
    scales: '<path d="M12 4v16M7.5 20h9M5 7.5h14"/><path d="M5 7.5l-2.5 6h5zM19 7.5l-2.5 6h5z"/>'
  };
  const VW = 300, CW = 141, CH = 48;
  /* примерная ширина подписи: если не влезает в рамку — чуть сжать буквы, но не шрифт (текст не меньше 12 px) */
  const wid = (s, px) => [...s].reduce((w, c) => w + px * (/[\s.,:;!'«»()→↔≤−-]/.test(c) ? 0.3 : /[A-ZА-ЯЁ]/.test(c) ? 0.66 : /[шщмжюыфШЩМЖЮЫФ]/.test(c) ? 0.74 : 0.56), 0);
  const fit = (cls, x, y, s, px, avail) => `<text class="${cls}" x="${x}" y="${y}"${wid(s, px) > avail ? ` textLength="${avail}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(s)}</text>`;
  /* предмет: значок и подпись-аналогия сверху, термин снизу */
  const item = (k, x, y, ico, a, t, cls, w) => { w = w || CW; return `<g class="lf-fg-it${cls ? ' ' + cls : ''}" data-lf-k="${k}"><rect class="lf-fg-box" x="${x}" y="${y}" width="${w}" height="${CH}" rx="9"/><g class="lf-fg-ico" transform="translate(${x + 7} ${y + 6}) scale(.75)">${ICO[ico] || ''}</g>${fit('lf-fg-ta', x + 30, y + 19, a, 13, w - 35)}${fit('lf-fg-tt', x + 9, y + 39, t, 12.5, w - 14)}</g>`; };
  /* стрелка с наконечником; c — дополнительный класс (lf-fg-bad, lf-fg-dash) */
  function arr(x1, y1, x2, y2, c) {
    const a = Math.atan2(y2 - y1, x2 - x1), s = 6;
    const p1 = [x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45)], p2 = [x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45)];
    const f = v => Math.round(v * 10) / 10;
    return `<g class="lf-fg-ar${c ? ' ' + c : ''}"><path d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}"/><path class="lf-fg-ah" d="M${f(x2)} ${f(y2)}L${f(p1[0])} ${f(p1[1])}L${f(p2[0])} ${f(p2[1])}Z"/></g>`;
  }
  const tag = (x, y, t, c, anchor) => `<text class="lf-fg-tag${c ? ' ' + c : ''}" x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(t)}</text>`;
  const svg = (h, label, body) => `<svg class="lf-fg-svg" viewBox="0 0 ${VW} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
  const L_ = 2, R_ = 157, MID = (VW - CW) / 2;   // левая, правая и средняя колонка
  const cx = x => x + CW / 2;

  const PIC = {
    utm: () => svg(206, 'Листовки с купонами → покупатель с купоном → кассир отмечает в журнале, откуда он, и подкалывает купон к чеку', [
      item(0, L_, 6, 'flyer', 'Листовки', 'utm_source=metro'),
      item(1, R_, 6, 'person', 'С купоном', 'визит по рекламе'),
      item(2, R_, 80, 'cashier', 'Кассир', 'сборщик событий'),
      item(3, L_, 80, 'clip', 'Купон к чеку', 'метка в сессии'),
      item(4, L_, 154, 'calendar', 'Купил назавтра', 'заказ через день'),
      item(5, R_, 154, 'notebook', 'Журнал кассира', 'брокер и БД'),
      arr(L_ + CW + 1, 30, R_ - 2, 30), arr(cx(R_), 6 + CH + 1, cx(R_), 78), arr(R_ - 1, 104, L_ + CW + 2, 104),
      arr(cx(L_), 80 + CH + 1, cx(L_), 152, 'lf-fg-dash'), arr(cx(R_), 80 + CH + 1, cx(R_), 152)
    ].join('')),
    block: () => svg(214, 'Кассир у входа не видит покупателей за толпой; купон, проверенный на кассе, виден у каждого, кто платит', [
      `<path class="lf-fg-wall" d="M${VW / 2} 4V196"/>`, tag(cx(L_), 14, 'вход = браузер', 'lf-fg-zone', 'middle'), tag(cx(R_), 14, 'касса = сервер', 'lf-fg-zone', 'middle'),
      item(0, L_, 22, 'cashier', 'Кассир у входа', 'трекер в браузере'),
      item(1, L_, 96, 'crowd', 'Толпа у входа', 'блокировщик'),
      item(2, R_, 22, 'receipt', 'Купон на кассе', 'сбор на сервере'),
      item(3, R_, 96, 'ask', '«Не пишите»', 'согласие, баннер'),
      item(4, R_, 160, 'notebook', 'Журнал', 'хранилище событий'),
      arr(cx(L_), 22 + CH + 1, cx(L_), 94, 'lf-fg-bad lf-fg-dash'), tag(cx(L_) + 6, 86, '≈ −30 %', 'lf-fg-bad'),
      arr(cx(L_), 96 + CH + 1, R_ - 2, 184, 'lf-fg-dash'), tag(L_ + 4, 206, 'дошло ≈ 68 %', 'lf-fg-bad'),
      arr(cx(R_), 22 + CH + 1, cx(R_), 94), arr(cx(R_), 96 + CH + 1, cx(R_), 158), tag(cx(R_) + 6, 155, '≈ 99,5 %', 'lf-fg-ok')
    ].join('')),
    id: () => svg(232, 'Три визита одного человека без карты — три незнакомца; карта постоянного покупателя сводит их в одну историю', [
      tag(VW / 2, 14, 'три визита — три «незнакомца»', 'lf-fg-zone', 'middle'),
      item(0, 2, 22, 'phone', 'Метро', 'id A', '', 92),
      item(1, 104, 22, 'laptop', 'Работа', 'id B', '', 92),
      item(2, 206, 22, 'desk', 'Дом', 'id C', '', 92),
      item(3, MID, 104, 'card', 'Карта покупателя', 'id покупателя'),
      item(4, L_, 182, 'profile', 'Одна история', 'склейка id'),
      item(5, R_, 182, 'face', '«Похож лицом»', 'отпечаток', 'lf-fg-weak'),
      arr(48, 22 + CH + 1, MID + 26, 102), arr(150, 22 + CH + 1, 150, 102), arr(252, 22 + CH + 1, MID + CW - 26, 102),
      arr(MID + 34, 104 + CH + 1, cx(L_) + 6, 180), arr(cx(R_) - 6, 181, MID + CW - 34, 104 + CH + 2, 'lf-fg-bad lf-fg-dash'), tag(cx(R_) + 2, 172, 'путает', 'lf-fg-bad')
    ].join('')),
    romi: () => svg(232, 'Бухгалтер раскладывает чеки по купонам, кладёт рядом счета за листовки и сверяет с кассой', [
      item(0, L_, 6, 'receipt', 'Чеки', 'оплаты (платёжка)'),
      item(1, R_, 6, 'bill', 'Счёт за листовки', 'расходы кабинетов'),
      item(2, MID, 80, 'calc', 'Бухгалтер', 'ETL по расписанию'),
      item(3, L_, 154, 'table', 'Что окупилось', 'витрина ROMI, CAC'),
      item(4, R_, 154, 'scales', 'Сверка', 'расхождение ≤ 2 %'),
      arr(cx(L_), 6 + CH + 1, MID + 30, 78), arr(cx(R_), 6 + CH + 1, MID + CW - 30, 78), arr(MID + 40, 80 + CH + 1, cx(L_) + 10, 152), arr(L_ + CW + 1, 178, R_ - 2, 178),
      tag(VW / 2, 226, 'ROMI = (выручка − расходы) / расходы', 'lf-fg-zone', 'middle')
    ].join(''))
  };

  /* =====================================================================
     6. Уровни
     ===================================================================== */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const D = o => Object.assign({ tier: 'data', dataLvl: true, e2eLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL() }, o);
  const TR = { read: 3000, write: 150, events: 8000 };
  const SHOP = (app, x) => [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: app || 3 }], ['db', 'sql', 640, 110, { replicas: 1 }]].concat(x || []);
  const PIPE = [['q', 'queue', 840, 300], ['etl', 'etl', 1040, 300, { mode: 'hourly' }, 'Конвейер событий'], ['olap', 'olap', 1240, 300]];
  const PIPE_S = [['q', 'queue', 840, 300], ['etl', 'etl', 1040, 300, { mode: 'stream' }, 'Конвейер событий'], ['olap', 'olap', 1240, 300]];
  const BE = [['client', 'lb'], ['lb', 'app'], ['app', 'db']];
  const PE = [['col', 'q'], ['q', 'etl'], ['etl', 'olap']];
  const COL_B = p => ['col', 'collector', 420, 450, Object.assign({ where: 'browser' }, p)];
  const COL_S = p => ['col', 'collector', 640, 300, Object.assign({ where: 'server' }, p)];
  const ADS = ['ads', 'external', 840, 470, { sys: 'ads' }, 'Рекламные кабинеты: Директ, VK'];
  const PAY = ['pay', 'external', 840, 590, { sys: 'pay' }, 'Платёжная система'];

  const E2E = [
    D({
      id: 'd-e2e-utm', title: 'Откуда пришли покупатели', pattern: 'pubsub', inside: 'etl', e2e: {}, features: ['e2e'],
      chips: ['UTM-метки', 'трекер и сборщик событий', 'метка в сессии'],
      story: 'Магазин настольных игр «Фишка» тратит на рекламу 1,2 млн ₽ в месяц: Директ, VK Реклама, рассылка. Ссылки в рекламе помечены метками — utm_source=vk, utm_campaign=autumn, — но сайт их нигде не сохраняет: метка живёт в адресе первой страницы и пропадает на второй. Человек приходит по рекламе, а покупает назавтра — в заказе про рекламу ни слова. Кабинеты же каждый приписывают заказ себе: по их отчётам заказов в полтора раза больше, чем было. Поставь сборщик событий, проведи события через брокер в аналитическое хранилище и сохрани метку в сессии до заказа.',
      traffic: TR, hotSetGb: 8,
      start: { nodes: SHOP(3), edges: BE },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 150 }, reachGoal(0.5), utmGoal, { t: 'cost', max: 2800 }],
      hints: [
        { text: 'Поставь «Сборщик событий» и соедини Пользователи → Сборщик: трекер в браузере шлёт клики и просмотры прямо в него.', why: 'Кассир на входе должен увидеть купон: пока сайт ничего не записывает, о визитах по рекламе никто не знает.' },
        { text: 'Дальше по пути данных: Сборщик → Брокер → ETL-конвейер → Аналитическая БД.', why: 'Брокер держит поток в 8 000 событий в секунду, конвейер грузит их пачками — отчётам не мешает.' },
        { text: 'В настройках сборщика включи «Метка рекламы — в сессию».', why: 'Купон подкалывают к чеку: метка доезжает до заказа, даже если покупатель купил назавтра.' }
      ],
      decisions: [{ q: 'Почему не взять источники заказов из отчётов рекламных кабинетов?', opts: [
        { t: 'Каждый кабинет приписывает заказ себе: сумма по кабинетам больше настоящих заказов', v: 'right', fb: 'Да. Человек видел рекламу в VK и кликнул в Директе — оба кабинета посчитают заказ своим. Свой сборщик видит путь целиком и отдаёт заказ одному каналу по понятному правилу.' },
        { t: 'Кабинеты показывают данные с опозданием на месяц', v: 'wrong', fb: 'Кабинеты обновляются за часы. Беда не в скорости, а в том, что каждый считает по-своему и видит только свою рекламу.' },
        { t: 'Можно, если реклама только в одном месте', v: 'partial', fb: 'С одним каналом спорить некому, но и тогда кабинет не видит заказы, сделанные позже и с другого устройства.' }
      ] }],
      solution: {
        nodes: SHOP(3, [COL_B({ utm: true })].concat(PIPE)), edges: BE.concat([['client', 'col']], PE),
        note: 'Трекер в браузере шлёт события в сборщик, сборщик — в брокер, конвейер раз в час грузит их в аналитическую БД. Метка рекламы живёт в сессии и доезжает до заказа.'
      },
      fingers: {
        title: 'метка рекламы и сборщик событий',
        thesis: 'Чтобы понять, какая реклама приводит покупателей, сайт должен запомнить, по какой рекламе пришёл человек, и донести эту пометку до заказа — даже если купит он только завтра.',
        analogy: 'Магазин раздаёт листовки с купонами у метро, в газете и через друзей — на каждой свой код. Кассир на входе смотрит купон и ставит в журнале отметку: «пришёл от метро, 12 сентября». Подколет купон к чеку — и через день видно, по какой листовке человек купил. Выбросил купон или кассир не спросил — откуда покупатель, уже не узнать.',
        picture: PIC.utm,
        map: [
          ['Листовки «Метро», «Газета», «Друг»', 'реклама с UTM-меткой', 'utm_source=metro, utm_campaign=autumn и click id в ссылке: у каждого места свой код'],
          ['Пришёл с купоном', 'визит по рекламной ссылке', 'первая страница, в адресе которой есть метка'],
          ['Кассир на входе', 'трекер и сборщик событий', 'принимает просмотры, клики и заказы с id посетителя'],
          ['Купон подколот к чеку', 'метка в сессии', 'метка живёт 30 дней и прикрепляется ко всем событиям'],
          ['Купил назавтра', 'заказ в другой визит', 'без метки в сессии такой заказ — «без источника»'],
          ['Журнал кассира', 'брокер и аналитическое хранилище', 'брокер держит поток, конвейер грузит в аналитическую БД']
        ]
      }
    }),
    D({
      id: 'd-e2e-block', title: 'Блокировщики съели треть событий', pattern: 'bff', e2e: {}, features: ['e2e', 'e2e-consent'],
      chips: ['блокировщики', 'сбор на сервере', 'согласие на cookies'],
      story: 'Источники заказов появились, но цифры странные: событий на треть меньше, чем визитов в логах сайта. У трети покупателей стоят блокировщики рекламы — они режут запросы к известным адресам трекеров. А юрист напомнил: id посетителя и история визитов — персональные данные, собирать их без согласия нельзя. Сделай так, чтобы терялось не больше 5 % событий, а данные о человеке собирались только с согласия.',
      traffic: TR, hotSetGb: 8,
      start: { nodes: SHOP(3, [COL_B({ utm: true })].concat(PIPE)), edges: BE.concat([['client', 'col']], PE) },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 150 }, lostGoal(0.05), consentGoal, utmGoal, { t: 'cost', max: 2950 }],
      hints: [
        { text: 'У сборщика: «Где собираем» — на сервере. Убери стрелку Пользователи → Сборщик и проведи Сервис → Сборщик.', why: 'Браузер шлёт события на адрес твоего сайта — блокировщикам не за что зацепиться. Как купон, проверенный на кассе: его видно у каждого, кто платит.' },
        { text: 'Теперь каждое событие проходит через сервис — добавь ему экземпляров с запасом.', why: '8 000 событий в секунду — это ещё работа для серверов. Без запаса сервис перегреется, и упадут уже покупки.' },
        { text: 'Включи «Спрашивать согласие».', why: 'Кто отказался, остаётся в отчётах обезличенно: визиты считаются, но не связываются с человеком.' }
      ],
      decisions: [{ q: 'Почему сбор на сервере почти не теряет события?', opts: [
        { t: 'Браузер шлёт события на адрес твоего сайта, а не трекера — блокировщикам не за что зацепиться', v: 'right', fb: 'Да. Блокировщики режут запросы по спискам адресов трекеров. Свой адрес в списки не попадает, а запрос к сайту нужен самому сайту.' },
        { t: 'Сервер быстрее браузера и успевает отправить всё', v: 'wrong', fb: 'Скорость тут ни при чём: события пропадают, потому что их режут по адресу, а не потому что не успели.' },
        { t: 'На сервере согласие посетителя больше не нужно', v: 'wrong', fb: 'Нужно. Закон о персональных данных одинаков для браузера и сервера: без согласия — только обезличенно.' }
      ] }],
      solution: {
        nodes: SHOP(5, [COL_S({ utm: true, consent: true })].concat(PIPE)), edges: BE.concat([['app', 'col']], PE),
        note: 'Сбор на сервере: браузер шлёт события на сайт, сервис пересылает их в сборщик — теряется ≈ 0,5 %. Сервису добавлены экземпляры под пересылку — с запасом. Согласие спрашивается: кто отказался — обезличенно.'
      },
      fingers: {
        title: 'сбор в браузере и на сервере',
        thesis: 'Часть браузеров не даёт счётчикам отправлять данные — их режут по адресу счётчика. Если данные пересылает сам сайт, их не режут. А записывать, кто именно пришёл, можно только с разрешения человека.',
        analogy: 'Кассир на входе видит не всех: треть покупателей заслоняет толпа — они зашли, а отметки в журнале нет. Если купон проверять прямо на кассе, где каждый платит, его увидят у всех, кто дошёл до покупки. А кто просит «не записывайте меня», того кассир отмечает просто «был покупатель» — без имени.',
        picture: PIC.block,
        map: [
          ['Кассир у входа', 'трекер в браузере', 'JS-код на странице шлёт события на адрес трекера'],
          ['Толпа у входа', 'блокировщик рекламы', 'режет запросы к известным адресам трекеров — у трети посетителей'],
          ['Купон проверяют на кассе', 'сбор на сервере', 'браузер шлёт события на сайт, сервис пересылает в сборщик'],
          ['«Не записывайте меня»', 'согласие на cookies', 'без согласия — только обезличенные события'],
          ['Журнал кассира', 'хранилище событий', 'брокер → конвейер → аналитическая БД']
        ]
      }
    }),
    D({
      id: 'd-e2e-id', title: 'Один покупатель — три человека', pattern: 'correlation', e2e: {}, features: ['e2e', 'e2e-consent', 'e2e-id'],
      chips: ['анонимный id', 'склейка с покупателем', 'конверсия по людям'],
      story: 'Отчёт говорит: посетителей 480 тысяч в месяц, конверсия 1,1 %. Но покупатель листает каталог с телефона в метро, сравнивает цены с рабочего ноутбука, а заказывает с домашнего компьютера — и аналитика видит трёх незнакомцев. Людей на самом деле меньше, конверсия выше, а заказ приписан «прямому заходу», хотя человека привела реклама. Свяжи визиты одного человека.',
      traffic: TR, hotSetGb: 8,
      start: { nodes: SHOP(5, [COL_S({ utm: true, consent: true })].concat(PIPE)), edges: BE.concat([['app', 'col']], PE) },
      goals: [{ t: 'success', min: 0.999 }, lostGoal(0.05), consentGoal, dupGoal(0.1), attrGoal(0.8), { t: 'cost', max: 3000 }],
      hints: [
        { text: 'У сборщика: «Склейка id» — по входу и заказу.', why: 'Когда человек вошёл в аккаунт или оформил заказ с телефоном, все его анонимные визиты привязываются к id покупателя — как по карте постоянного покупателя.' },
        { text: 'Склейку по отпечатку браузера не бери.', why: 'Отпечаток не связывает телефон с ноутбуком и путает разных людей за одним IP — офис, мобильный оператор.' }
      ],
      decisions: [{ q: 'Когда анонимного посетителя можно связать с покупателем?', opts: [
        { t: 'Когда он сам назвался: вошёл в аккаунт или оформил заказ с телефоном и почтой', v: 'right', fb: 'Да. Это детерминированная склейка: связь подтверждена самим человеком. Все прошлые визиты этого браузера и других его устройств получают id покупателя.' },
        { t: 'По IP и браузеру: одинаковые — значит, тот же человек', v: 'wrong', fb: 'За одним IP бывают сотни людей — офис, мобильный оператор. А телефон и ноутбук одного человека отличаются и IP, и браузером.' },
        { t: 'Никогда — это нарушает закон', v: 'partial', fb: 'С согласием можно. Без согласия визиты остаются обезличенными и не склеиваются.' }
      ] }],
      solution: {
        nodes: SHOP(5, [COL_S({ utm: true, consent: true, stitch: 'login' })].concat(PIPE)), edges: BE.concat([['app', 'col']], PE),
        note: 'Склейка по входу и заказу: анонимные визиты человека с разных устройств привязываются к id покупателя. Лишних «людей» ≈ 6 %, у заказа виден путь от рекламы.'
      },
      fingers: {
        title: 'склейка анонимных визитов',
        thesis: 'Один человек заходит с телефона, ноутбука и рабочего компьютера — и выглядит как три незнакомца. Связать их можно в тот момент, когда он сам назвался: вошёл или оформил заказ.',
        analogy: 'Покупатель приходил трижды: с листовкой у метро, без купона в обед с работы и на выходных из дома. Кассир не знает, что это один человек, — пока тот не покажет карту постоянного покупателя. По номеру карты все визиты сводятся в одну историю, и видно, что первым его привёл купон у метро. Узнавать «по лицу» ненадёжно: похожих легко спутать.',
        picture: PIC.id,
        map: [
          ['Визит из метро', 'анонимный id A', 'cookie на телефоне: пришёл по рекламе'],
          ['Визит с работы', 'анонимный id B', 'другой компьютер и браузер — другой id'],
          ['Заказ из дома', 'анонимный id C', 'без склейки заказ — «без источника»'],
          ['Карта покупателя', 'id покупателя', 'появляется при входе в аккаунт или заказе'],
          ['Одна история', 'склейка id', 'A, B и C привязаны к одному покупателю'],
          ['«Похож по лицу»', 'отпечаток браузера', 'не связывает разные устройства и путает людей за одним IP']
        ]
      }
    }),
    D({
      id: 'd-e2e-romi', title: 'Сколько принёс каждый рубль рекламы', pattern: 'cqrs', inside: 'olap', e2e: { money: true }, features: ['e2e', 'e2e-consent', 'e2e-id', 'e2e-money'],
      chips: ['ROMI и CAC', 'импорт расходов', 'сверка с деньгами'],
      story: 'Директор спрашивает: «Сколько принёс каждый рубль рекламы?» Сейчас маркетолог раз в неделю выгружает расходы из кабинетов в Excel, а выручку берёт из заказов ночным батчем — и цифры расходятся с бухгалтерией на 15 %: в заказах есть неоплаченные и отменённые, в кабинетах часть расходов без НДС. Собери витрину окупаемости (ROMI) и цены покупателя (CAC) по каналам: обновляется сама не реже раза в час и сходится с деньгами до 2 %.',
      traffic: Object.assign({ report: 30 }, TR), hotSetGb: 8,
      preset: [C(), ADS, PAY],
      start: {
        nodes: SHOP(5, [COL_S({ utm: true, consent: true, stitch: 'login' })].concat(PIPE_S, [['etlo', 'etl', 840, 110, { mode: 'daily' }, 'Ночная выгрузка заказов']])),
        edges: BE.concat([['app', 'col']], PE, [['app', 'olap'], ['db', 'etlo'], ['etlo', 'olap']])
      },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'report', max: 1500 }, consentGoal, romiGoal, freshGoal(3600), gapGoal(0.02), { t: 'cost', max: 3700 }],
      hints: [
        { text: 'Поставь ETL-конвейер и соедини: Рекламные кабинеты → Конвейер → Аналитическая БД. Режим — раз в час.', why: 'Бухгалтер раз в час забирает счета за листовки. Кабинеты не отдают поток: опрос каждую минуту упрётся в лимит запросов API.' },
        { text: 'У этого конвейера включи «Расходы — как в счетах».', why: 'В одном кабинете суммы без НДС, в другом с НДС, часть оплачена бонусами — без приведения расходы разойдутся со счетами.' },
        { text: 'Выручку бери из платёжной системы: Платёжная система → Конвейер → Аналитическая БД. Ночную выгрузку заказов можно убрать.', why: 'Чеки, а не обещания: в заказах есть неоплаченные и отменённые, а возвраты видны только в платёжке.' }
      ],
      decisions: [{ q: 'Откуда брать выручку для окупаемости рекламы?', opts: [
        { t: 'Из платёжной системы: оплаты минус возвраты', v: 'right', fb: 'Да. Это деньги, которые реально пришли. К оплате находится заказ, к заказу — визит с меткой рекламы.' },
        { t: 'Из событий «покупка» от трекера', v: 'wrong', fb: 'Часть событий теряется, а возвраты трекер не видит. Для денег нужен источник денег.' },
        { t: 'Из заказов в базе магазина', v: 'partial', fb: 'Ближе, но ≈ 7 % заказов не оплачены или отменены, а возвраты в заказах не видны — со счётом в банке не сойдётся.' }
      ] }],
      solution: {
        nodes: SHOP(5, [COL_S({ utm: true, consent: true, stitch: 'login' })].concat(PIPE_S, [['etlm', 'etl', 1040, 530, { mode: 'hourly', spendFix: true }, 'Выгрузка расходов и оплат']])),
        edges: BE.concat([['app', 'col']], PE, [['app', 'olap'], ['ads', 'etlm'], ['pay', 'etlm'], ['etlm', 'olap']]),
        note: 'Конвейер раз в час забирает расходы из кабинетов (приведённые к счетам) и оплаты из платёжной системы. Клики с метками идут потоком. В аналитической БД к оплате находится заказ, к заказу — визит с меткой: витрина ROMI и CAC по каналам, свежесть ≤ 1 ч, расхождение с деньгами < 1 %.'
      },
      fingers: {
        title: 'окупаемость рекламы',
        thesis: 'Окупаемость рекламы — сколько денег вернулось на каждый потраченный рубль. Для неё в одном месте нужны три вещи: откуда пришёл каждый заказ, сколько за него реально заплатили и сколько стоила реклама, — и всё это должно обновляться само.',
        analogy: 'В конце месяца бухгалтер раскладывает чеки по купонам: «Метро», «Газета», «Друг». Рядом кладёт счета типографии за листовки — отдельно за каждое место раздачи, — делит выручку на расходы и видит, какие листовки окупились. Если вместо чеков взять обещания «зайду куплю» или забыть про НДС в счетах, цифры не сойдутся с кассой.',
        picture: PIC.romi,
        map: [
          ['Чеки с купонами', 'оплаты из платёжной системы', 'реальные деньги: оплаты минус возвраты; вернули товар — чек аннулируют'],
          ['Счета за листовки', 'расходы из рекламных кабинетов', 'по API, приведённые к счетам: НДС, бонусы'],
          ['Бухгалтер', 'ETL по расписанию', 'сам забирает данные раз в час; чаще кабинеты не отдают — лимит API'],
          ['Таблица «что окупилось»', 'витрина ROMI и CAC', 'ROMI — окупаемость рекламы, CAC — цена одного покупателя'],
          ['Сверка с кассой', 'расхождение с деньгами ≤ 2 %', 'выручка сходится с оплатами, расходы — со счетами']
        ]
      }
    })
  ];
  /* в конец трека «Данные»: после озера данных, перед финалом «Аналитика для бизнеса» */
  if (SD.DATAL && !SD.DATAL.some(l => l.id === E2E[0].id)) SD.DATAL.push(...E2E);
  SD.e2e = { levels: E2E, world, goals: { reachGoal, utmGoal, lostGoal, consentGoal, dupGoal, attrGoal, romiGoal, freshGoal, gapGoal }, advice };

  /* «Разберись руками»: лаборатория «Сквозная аналитика вживую» (js/lab-e2e.js, id 'e2e') — с той же аналогией.
     Вкладки: path — путь покупателя, loss — потери событий, stitch — склейка, roi — расходы и окупаемость.
     lab-links.js грузится позже — пункты добавляются, когда он появится; без лаборатории на странице карточка их не покажет. */
  const LINKS = {
    'd-e2e-utm': [{ lab: 'e2e', tab: 'path', life: 'Листовки с купонами раздают у метро, в газете и через друзей. Кассир на входе смотрит купон и записывает в журнал, откуда пришёл покупатель.', task: '' }],
    'd-e2e-block': [{ lab: 'e2e', tab: 'loss', life: 'Кассир на входе не видит покупателей за толпой — а купон, проверенный на кассе, виден у каждого, кто платит.', task: '' }],
    'd-e2e-id': [{ lab: 'e2e', tab: 'stitch', life: 'Один и тот же человек приходит трижды — и только карта постоянного покупателя показывает, что это он.', task: '' }],
    'd-e2e-romi': [{ lab: 'e2e', tab: 'roi', life: 'В конце месяца бухгалтер раскладывает чеки по купонам и сравнивает со счетами за листовки: какие окупились?', task: '' }]
  };
  function linkLabs() {
    const M = SD.labLinks && SD.labLinks.MAP;
    if (!M) return false;
    Object.keys(LINKS).forEach(id => { if (!M[id]) M[id] = LINKS[id]; });
    return true;
  }
  if (!linkLabs() && HAS_DOM) {
    const late = () => {
      if (!linkLabs()) return;
      /* первая отрисовка задания прошла до lab-links.js — перерисовать, если открыт уровень этой темы */
      const A = SD.app && SD.app.A;
      if (A && A.level && A.tab === 'task' && SD.panels && LINKS[(A.level.free && A.level.free.base) || A.level.id]) { try { SD.panels.task(A); } catch (e) { /* панель перерисуется при следующем пересчёте */ } }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', late); else setTimeout(late, 0);
  }
})();
