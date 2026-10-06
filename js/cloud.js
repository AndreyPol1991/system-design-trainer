/* Облако: зоны доступности, способ оплаты машин (резерв, spot), классы хранения файлов —
   как настройки узлов и расширение симулятора. Трек «Облако» SD.CLOUDL. */
(function () {
  const T = SD.TYPES;
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});

  /* ---------- настройки узлов ---------- */
  const AZ_HELP = {
    sql: 'Primary в одной зоне, реплики — в других. Упадёт зона primary — реплика станет главной. Без реплик разнести базу по зонам нельзя.',
    cache: 'Узлы кэша раскладываются по зонам. Один узел в двух зонах не бывает: нужно минимум столько узлов, сколько зон.',
    def: 'Экземпляры раскладываются по зонам доступности — отдельным дата-центрам региона. Упадёт одна зона — останутся остальные, но им придётся тянуть всю нагрузку.'
  };
  ['app', 'worker', 'cache', 'sql', 'nosql', 'ws', 'gateway', 'search', 'queue', 'faas'].forEach(t => {
    if (!T[t] || (T[t].props || []).some(p => p.key === 'az')) return;
    T[t].props = (T[t].props || []).concat([{ key: 'az', label: 'Зон доступности', type: 'range', min: 1, max: 3, def: 1, feature: 'cloud', help: AZ_HELP[t] || AZ_HELP.def }]);
  });
  ['app', 'worker'].forEach(t => {
    if ((T[t].props || []).some(p => p.key === 'pricing')) return;
    T[t].props = T[t].props.concat([{ key: 'pricing', label: 'Как платим за машины', type: 'select', def: 'od', feature: 'cloud',
      options: [['od', 'По требованию — полная цена'], ['ri', 'Резерв на год — на 40 % дешевле'], ['spot', 'Spot — на 70 % дешевле, облако может забрать']],
      help: 'Резерв — обещаешь облаку год и платишь меньше. Spot — свободные мощности облака за копейки, но их отбирают с предупреждением за 2 минуты: годится для того, что можно прервать и повторить.' }]);
  });
  if (T.objstore && !(T.objstore.props || []).some(p => p.key === 'sclass')) {
    T.objstore.props = (T.objstore.props || []).concat([
      { key: 'sclass', label: 'Класс хранения', type: 'select', def: 'std', feature: 'cloud',
        options: [['std', 'Стандарт — $23 за ТБ'], ['ia', 'Редкий доступ — $12,5 за ТБ, чтение дороже'], ['arch', 'Архив — $1 за ТБ, чтение через часы']],
        help: 'Чем холоднее класс, тем дешевле хранить и дороже и дольше доставать.' },
      tog('lifecycle', 'Правила жизненного цикла', false, 'Свежие файлы — в стандарте, старше 30 дней — в редком доступе, старше 180 — в архиве. Читают в основном свежее, поэтому почти не мешает.', { feature: 'cloud' })
    ]);
  }
  const PRICE = { od: 1, ri: 0.6, spot: 0.3 };

  /* ---------- симулятор: цена и поведение ---------- */
  function collect(ctx, res, level) {
    let add = 0;
    for (const n of ctx.nodes.values()) {
      const r = res.nodes[n.id]; if (!r) continue;
      const p = n.props || {};
      if ((n.type === 'app' || n.type === 'worker') && p.pricing && p.pricing !== 'od') { const d = r.cost * (PRICE[p.pricing] - 1); r.cost += d; add += d; }
      if ((p.az || 1) > 1 && r.cost) { const d = r.cost * 0.05 * ((p.az || 1) - 1); r.cost += d; add += d; }
      if (n.type === 'objstore' && level.storeTb) {
        const per = p.lifecycle ? 0.1 * 23 + 0.4 * 12.5 + 0.5 * 1 : ({ std: 23, ia: 12.5, arch: 1 }[p.sclass || 'std']);
        const reads = ((r.load || {}).static || 0) + ((r.load || {}).blob || 0);
        const fetch = p.lifecycle ? 0 : p.sclass === 'ia' ? reads * 2.63e6 * 0.2 / 1e6 * 10 : 0;
        const d = level.storeTb * per + fetch; r.cost += d; add += d;
      }
    }
    res.cost += add;
  }
  function state(ctx, n, ld, cap, H) {
    if (n.type !== 'objstore' || !ctx.level.storeTb) return undefined;
    const p = n.props || {}, arch = p.sclass === 'arch' && !p.lifecycle;
    const u = 0.01, lat = arch ? 4 * 3600 * 1000 : p.sclass === 'ia' && !p.lifecycle ? 45 : 30;
    return { util: u, lat: () => lat, ok: k => (arch && (k === 'static' || k === 'blob') ? 0 : 1), info: { arch } };
  }
  (SD.simExts = SD.simExts || []).push({ collect, state });

  /* ---------- проверки: падение зоны и отбор spot ---------- */
  const managed = n => { const t = T[n.type]; return !t || n.type === 'client' || t.managed || t.ops || (n.type === 'queue' && SD.ENGINES && SD.ENGINES[n.props.engine] && SD.ENGINES[n.props.engine].managed); };
  function zoneDown(level, graph) {
    const g = JSON.parse(JSON.stringify(graph)), down = {}, gone = [];
    g.nodes.forEach(n => {
      if (managed(n)) return;
      const az = n.props.az || 1;
      if (n.type === 'sql') { if (az >= 2 && (n.props.replicas || 0) >= 1) down[n.id] = 1; else gone.push(n); return; }
      if (az <= 1) { gone.push(n); return; }
      down[n.id] = Math.ceil((n.props.count || 1) / az);
    });
    const ids = new Set(gone.map(n => n.id));
    g.nodes = g.nodes.filter(n => !ids.has(n.id)); g.edges = g.edges.filter(e => !ids.has(e.from) && !ids.has(e.to));
    const r = SD.sim.run(level, g, { mul: 1, down });
    return { success: r.total.success, gone, r };
  }
  function spotDown(level, graph) {
    const down = {}, hit = [];
    graph.nodes.forEach(n => { if (n.props && n.props.pricing === 'spot') { down[n.id] = Math.ceil((n.props.count || 1) / 2); hit.push(n); } });
    const r = SD.sim.run(level, graph, { mul: 1, down });
    return { success: r.total.success, hit, r };
  }
  const lbl = n => n.label || T[n.type].name;
  const zoneGoal = { t: 'custom', text: 'Переживает падение одной зоны доступности', fn: (g, res, L) => {
    const z = zoneDown(L, g), ok = z.success >= 0.99;
    return { ok, detail: ok ? `при падении зоны A успешно ${SD.fmt.pct(z.success)}` : `при падении зоны A успешно ${SD.fmt.pct(z.success)}${z.gone.length ? ' · целиком в зоне A: ' + z.gone.slice(0, 3).map(lbl).join(', ') : ''}` };
  } };
  const spotGoal = { t: 'custom', text: 'Пользователи не замечают, когда облако забирает spot-машины', fn: (g, res, L) => {
    const s = spotDown(L, g), ok = s.success >= 0.99;
    return { ok, detail: !s.hit.length ? 'spot не используется' : ok ? `забрали половину spot — успешно ${SD.fmt.pct(s.success)}` : `забрали половину spot — успешно ${SD.fmt.pct(s.success)}: на spot стоит то, что обслуживает пользователей` };
  } };

  /* ---------- трек «Облако» ---------- */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const FEAT = () => [...new Set(Object.values(SD.TYPES).flatMap(t => (t.props || []).map(p => p.feature).filter(Boolean)))];
  const CL = o => Object.assign({ tier: 'cloud', cloudLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL(), features: FEAT() }, o);
  SD.CLOUDL = [
    CL({
      id: 'c-az', title: 'Упала зона доступности', pattern: 'healthcheck',
      chips: ['регион и зоны', 'multi-AZ', 'N+1 на зону'],
      story: 'В 03:40 в дата-центре зоны A пропало питание. Весь магазин стоял в одной зоне — и лёг целиком на два часа. Облачный регион — это три независимых дата-центра (зоны доступности) в паре километров друг от друга. Разнеси систему так, чтобы падение любой одной зоны пользователи не заметили.',
      traffic: { read: 6000, write: 600 }, hotSetGb: 8,
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 4 }], ['cache', 'cache', 660, 130], ['db', 'sql', 660, 360, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'cache'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 100 }, zoneGoal, { t: 'cost', max: 2900 }],
      hints: [
        { text: 'Нажми на «Сервис»: «Зон доступности» — 3. Падение зоны заберёт треть экземпляров — оставшиеся должны тянуть всё: добавь экземпляров.', why: 'Это N+1, только на уровне зон: каждая зона — запас для двух других.' },
        { text: 'Кэшу — 2 узла в 2 зонах, базе — реплика в другой зоне («Зон доступности» 2).', why: 'Один узел не может стоять в двух зонах сразу. Реплика базы в другой зоне станет главной, если зона primary упадёт.' }
      ],
      solution: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 6, az: 3 }], ['cache', 'cache', 660, 130, { count: 2, az: 2 }], ['db', 'sql', 660, 360, { replicas: 1, az: 2 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'cache'], ['app', 'db']],
        note: 'Сервис — 6 экземпляров в 3 зонах (падение зоны оставляет 4 — хватает), кэш — 2 узла в 2 зонах, у базы реплика в другой зоне. Балансировщик облака — сам многозонный.' }
    }),
    CL({
      id: 'c-spot', title: 'Счёт за серверы', pattern: 'queue-cc',
      chips: ['резерв на год', 'spot', 'фоновые задачи'],
      story: 'Финансы просят срезать счёт за облако вдвое. Сервис отвечает покупателям круглые сутки, а обработчики ночью пересчитывают рекомендации — эту работу можно прервать и повторить. Облако продаёт машины тремя способами: по требованию, в резерв на год со скидкой и spot за копейки, но их могут забрать в любой момент. Выбери, кому что.',
      traffic: { read: 5000, write: 250 }, hotSetGb: 8,
      job: { from: 'write', label: 'пересчёт рекомендаций', ms: 150, conc: 20, target: 'sql' },
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 200, { count: 4 }], ['cache', 'cache', 660, 80], ['db', 'sql', 660, 220, { replicas: 1 }], ['q', 'queue', 660, 380], ['w', 'worker', 880, 380, { count: 6 }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'cache'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'jobs' }, spotGoal, { t: 'cost', max: 1900 }],
      hints: [
        { text: 'Обработчикам — «Как платим» = Spot.', why: 'Если облако заберёт машину, задача вернётся в очередь и её доделает другой обработчик. Пользователь этого не видит.' },
        { text: 'Сервису — «Резерв на год», а не spot.', why: 'Сервис отвечает покупателям: если его заберут в пик, начнутся отказы. Резерв дешевле на 40 % и машины не отбирают.' }
      ],
      solution: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 200, { count: 4, pricing: 'ri' }], ['cache', 'cache', 660, 80], ['db', 'sql', 660, 220, { replicas: 1 }], ['q', 'queue', 660, 380], ['w', 'worker', 880, 380, { count: 6, pricing: 'spot' }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'cache'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'db']],
        note: 'Сервис — резерв на год (−40 %, не отбирают), обработчики — spot (−70 %): прерванная задача вернётся в очередь.' }
    }),
    CL({
      id: 'c-storage', title: 'Счёт за хранение растёт', pattern: 'cdn-p',
      chips: ['классы хранения', 'жизненный цикл', 'S3'],
      story: 'Фотохостинг хранит 400 ТБ снимков в стандартном классе S3 — это $9 200 в месяц, и каждый месяц больше. Смотрят почти только свежие фото: за последний месяц. Старые открывают редко, но удалять их нельзя. Сделай хранение дешевле, не сломав просмотр.',
      traffic: { static: 3000, read: 1500, write: 100, upload: 20 }, global: true, storeTb: 400, uploadMs: 300,
      start: { nodes: [['lb', 'lb', 220, 330], ['app', 'app', 420, 330, { count: 2 }], ['db', 'sql', 660, 400], ['cdn', 'cdn', 220, 130], ['s3', 'objstore', 660, 160]],
        edges: [['client', 'lb'], ['client', 'cdn'], ['cdn', 's3'], ['lb', 'app'], ['app', 'db'], ['app', 's3']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'static', max: 80 }, { t: 'cost', max: 4800 }],
      hints: [
        { text: 'Нажми на «Объектное хранилище»: включи «Правила жизненного цикла».', why: 'Свежее остаётся в стандарте, старое само переезжает в редкий доступ и в архив — платишь за ТБ в разы меньше.' },
        { text: 'Не переводи всё в «Архив».', why: 'Из архива файл достают часами — свежие фото перестанут открываться.' }
      ],
      solution: { nodes: [['lb', 'lb', 220, 330], ['app', 'app', 420, 330, { count: 2 }], ['db', 'sql', 660, 400], ['cdn', 'cdn', 220, 130], ['s3', 'objstore', 660, 160, { lifecycle: true }]],
        edges: [['client', 'lb'], ['client', 'cdn'], ['cdn', 's3'], ['lb', 'app'], ['app', 'db'], ['app', 's3']],
        note: 'Правила жизненного цикла: свежее в стандарте, старше 30 дней — в редком доступе, старше 180 — в архиве. Хранение дешевле в 3 раза, просмотр не страдает.' }
    }),
    CL({
      id: 'c-serverless', title: 'Платить только за вызовы', pattern: 'autoscaling',
      chips: ['serverless', 'холодный старт', 'неровная нагрузка'],
      story: 'Внутренний сервис отчётов: днём пара десятков запросов в секунду, ночью и в выходные — ноль. Два сервера по требованию работают круглые сутки и стоят больше, чем приносят. Сделай так, чтобы платить только за реальные вызовы.',
      traffic: { read: 30, write: 4 },
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 2 }], ['db', 'sql', 660, 250, { size: 's' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.99 }, { t: 'latency', kind: 'read', max: 400 }, { t: 'cost', max: 300 }],
      hints: [
        { text: 'Убери балансировщик и сервис, поставь «Serverless-функции»: Пользователи → Функции → БД.', why: 'Облако запускает функцию на каждый запрос: нет запросов — нет счёта.' },
        { text: 'Холодный старт добавляет сотни миллисекунд к первому запросу.', why: 'Для отчётов это допустимо; для оплаты в магазине держат прогретые функции (provisioned) или обычные серверы.' }
      ],
      solution: { nodes: [['fn', 'faas', 420, 250], ['db', 'sql', 660, 250, { size: 's' }]], edges: [['client', 'fn'], ['fn', 'db']],
        note: 'Функции вместо постоянных серверов: при такой нагрузке это копейки, а база маленькая (S).' }
    })
  ];
  /* ---------- «Счёт пришёл»: счёт за месяц по статьям (FinOps) ----------
     Как разбор банковской выписки: сначала — по статьям, куда уходят деньги, потом в каждой статье — что лишнее.
     Только на уровнях с level.bill: логи по объёму и сроку хранения, трафик между зонами, автомасштаб по суткам.
     Новые настройки (feature 'bill'): уровень логов и «ходить в свою зону» у сервисов и обработчиков. */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const LOG_KB = { debug: 0.8, info: 0.15, warn: 0.04 };          // КБ логов на один запрос
  const BILLP = { ingest: 0.1, store: 0.012, xaz: 0.02, usdRub: 90 }; // $ за ГБ принять, $ за ГБ в месяц хранить, $ за ГБ между зонами
  ['app', 'worker'].forEach(t => {
    if (!T[t] || (T[t].props || []).some(p => p.key === 'logLevel')) return;
    T[t].props = T[t].props.concat([
      { key: 'logLevel', label: 'Уровень логов', type: 'select', def: 'info', feature: 'bill',
        options: [['debug', 'Debug — всё подряд, ≈ 0,8 КБ на запрос'], ['info', 'Info — важные события, ≈ 0,15 КБ'], ['warn', 'Warn — только предупреждения и ошибки, ≈ 0,04 КБ']],
        help: 'Сколько сервис пишет в логи на каждый запрос. Debug нужен при поиске ошибки — на час, а не навсегда: логи принимают и хранят за деньги.' },
      tog('zoneLocal', 'Ходить к базе и кэшу в своей зоне', false, 'Читать из реплики и узла кэша в своей зоне доступности. Трафик между зонами платный — $0,02 за ГБ; запись в primary всё равно уходит в его зону.', { feature: 'bill' })
    ]);
  });
  if (T.kibana) { const r = (T.kibana.props || []).find(p => p.key === 'retention'); if (r && !r.options.some(o => +o[0] === 730)) r.options.push([365, 'Год'], [730, 'Без срока — всё с запуска (2 года)']); }
  if (SD.PROP_SIMPLE) ['app', 'worker'].forEach(t => {
    const o = SD.PROP_SIMPLE[t] = SD.PROP_SIMPLE[t] || {};
    o.logLevel = 'Как дневник: можно записывать каждую чашку чая (debug), а можно только важное (info) или только происшествия (warn). Логи принимают и хранят за деньги — подробный дневник на всю жизнь стоит дороже самого сервиса.';
    o.zoneLocal = 'Как ходить в магазин у дома, а не через весь город: сервис читает из кэша и реплики в своей зоне. Каждый ГБ между зонами облако берёт отдельно — мелочь на запрос, тысячи долларов за месяц.';
  });
  if (SD.OPT_SIMPLE) ['app', 'worker'].forEach(t => {
    SD.OPT_SIMPLE[t + '.logLevel'] = { debug: 'Debug: пишем всё — в 5 раз больше логов, чем info.', info: 'Info: важные события — обычный уровень для работы.', warn: 'Warn: только предупреждения и ошибки — дёшево, но расследовать сложнее.' };
    SD.OPT_SIMPLE[t + '.zoneLocal'] = { true: 'Читаем в своей зоне: между зонами ходит ≈ 10 % трафика.', false: 'Ходим куда придётся: при трёх зонах ≈ 2/3 обращений уходят в соседнюю зону.' };
  });
  const xazShare = (a, b) => { const z = Math.max((a.props || {}).az || 1, (b.props || {}).az || 1); return z <= 1 ? 0 : (a.props || {}).zoneLocal ? 0.1 : 1 - 1 / z; };
  function billCollect(ctx, res, level) {
    const B = level.bill; if (!B) return;
    let add = 0;
    /* автомасштаб: днём пик, ночью нагрузки в разы меньше — платим за среднее число машин за сутки */
    for (const n of ctx.nodes.values()) {
      const r = res.nodes[n.id], p = n.props || {};
      if (!r || !(n.type === 'app' || n.type === 'worker') || !p.autoscale || !r.count) continue;
      const peak = r.count, low = Math.max(p.count || 1, Math.ceil(peak * B.night)), avg = peak * B.dayShare + Math.min(peak, low) * (1 - B.dayShare);
      const d = r.cost * (avg / peak - 1); r.cost += d; add += d; r.dayAvg = avg;
    }
    /* логи: объём от запросов тех, кто пишет в узел логов, и срок хранения */
    let logsGb = 0;
    for (const n of ctx.nodes.values()) {
      if (n.type !== 'kibana' || !res.nodes[n.id]) continue;
      const gb = (ctx.inn.get(n.id) || []).map(id => ctx.nodes.get(id)).filter(s => s && (s.type === 'app' || s.type === 'worker'))
        .reduce((s, src) => { const rr = res.nodes[src.id] || {}; return s + (rr.rps || 0) * (LOG_KB[src.props.logLevel || 'info'] || 0.15) * 86400 / 1e6; }, 0);
      const ret = +n.props.retention || 14, c = 150 + gb * 30 * BILLP.ingest + gb * ret * BILLP.store;
      add += c - res.nodes[n.id].cost; res.nodes[n.id].cost = c; res.nodes[n.id].logs = { gbDay: gb, ret };
      logsGb += gb;
    }
    /* трафик между зонами доступности: сервисы и обработчики ходят в базы, кэш, очереди */
    let xaz = 0, xazGb = 0;
    ctx.edgeMap.forEach((e, key) => {
      const a = ctx.nodes.get(e.from), b = ctx.nodes.get(e.to);
      if (!a || !b || !(a.type === 'app' || a.type === 'worker') || !['sql', 'cache', 'nosql', 'queue', 'search'].includes(b.type)) return;
      const er = res.edges[e.id]; if (!er || !er.flow) return;
      const gb = er.flow * (B.kb || 16) * 2.63e6 / 1e6 * xazShare(a, b);
      xazGb += gb; xaz += gb * BILLP.xaz; er.xaz = gb * BILLP.xaz;
    });
    res.bill = { traffic: xaz, trafficTb: xazGb / 1000, logsGbDay: logsGb };
    res.cost += add + xaz;
  }
  (SD.simExts = SD.simExts || []).push({ collect: billCollect });

  /* ---------- счёт по статьям и подсказки «где переплачиваем» ---------- */
  const CATS = [
    ['compute', 'Машины: сервисы и обработчики', ['app', 'worker', 'faas', 'gateway', 'ws', 'k8s', 'agent']],
    ['db', 'Базы данных и кэш', ['sql', 'nosql', 'cache', 'search', 'vectordb', 'olap', 'tsdb']],
    ['storage', 'Хранение файлов', ['objstore', 'lake']],
    ['traffic', 'Трафик между зонами', []],
    ['logs', 'Логи и наблюдаемость', ['kibana', 'prometheus', 'grafana', 'alertmanager', 'jaeger']],
    ['ai', 'Модели и AI', ['llm', 'embed', 'guard', 'router', 'semcache', 'stt', 'tts']],
    ['other', 'Прочее: вход, очереди, CDN', []]
  ];
  const usd = v => SD.fmt.usd(v), pc = v => Math.round(v * 100) + ' %';
  const VCPU = { s: 1, m: 2, l: 4, xl: 8 };
  function billOf(L, g, res) {
    const items = CATS.map(([k, n]) => ({ k, n, v: 0, nodes: [], flags: [] })), by = k => items.find(x => x.k === k);
    const cat = t => (CATS.find(c => c[2].includes(t)) || ['other'])[0];
    g.nodes.forEach(n => {
      const r = res.nodes[n.id]; if (!r || n.type === 'client' || !r.cost) return;
      const it = by(cat(n.type)); it.v += r.cost; it.nodes.push({ n, r });
    });
    const tr = by('traffic'); tr.v = (res.bill && res.bill.traffic) || 0;
    const B = L.bill || {};
    /* где переплачиваем: только то, что видно по схеме и цифрам */
    g.nodes.forEach(n => {
      const r = res.nodes[n.id], p = n.props || {}; if (!r) return;
      const u = r.util || 0, name = `«${lbl(n)}»`;
      if (n.type === 'app' || n.type === 'worker') {
        const c = by('compute');
        if (n.type === 'app' && (p.size === 'xl' || p.size === 'l') && u < 0.35) c.flags.push(`${name}: ${p.count} × ${VCPU[p.size]} ядер загружены на ${pc(u)} — машины с большим запасом. Поменьше размер: ёмкость та же при меньшем числе ядер.`);
        else if (u < 0.3 && (p.count || 1) > 2) c.flags.push(`${name}: загрузка ${pc(u)} — экземпляров больше, чем нужно даже с запасом на падение зоны.`);
        if (n.type === 'app' && (p.pricing || 'od') === 'od' && !p.autoscale) c.flags.push(`${name} работает круглые сутки по полной цене. Резерв на год — на 40 % дешевле, машины не отбирают.`);
        if (n.type === 'worker' && p.pricing !== 'spot') c.flags.push(`${name}: проверку задания можно прервать и повторить — такие машины берут spot, на 70 % дешевле.`);
        if (n.type === 'app' && !p.autoscale && B.night) c.flags.push(`${name}: ночью нагрузка в ${Math.round(1 / B.night)} раза меньше, а машин столько же. Автомасштаб платит за пик только в пик.`);
        if ((LOG_KB[p.logLevel || 'info'] || 0) >= LOG_KB.debug && g.edges.some(e => e.from === n.id && (g.nodes.find(x => x.id === e.to) || {}).type === 'kibana')) by('logs').flags.push(`${name} пишет логи уровня debug — в 5 раз больше, чем info. Debug включают на время поиска ошибки.`);
      }
      if (n.type === 'sql' && (p.size === 'xl' || p.size === 'l') && u < 0.3) by('db').flags.push(`${name}: сервер ${p.size.toUpperCase()} загружен на ${pc(u)}. Размер M держит ≈ 5 000 операций в секунду.`);
      if (n.type === 'sql' && (p.replicas || 0) >= 2 && u < 0.5) by('db').flags.push(`${name}: ${p.replicas} реплики при загрузке ${pc(u)}. Для падения зоны хватит одной реплики в другой зоне.`);
      if (n.type === 'cache' && L.hotSetGb && (p.count || 1) * (p.mem || 8) > L.hotSetGb * 3) by('db').flags.push(`${name}: ${(p.count || 1) * (p.mem || 8)} ГБ памяти, а горячих данных ≈ ${L.hotSetGb} ГБ. Лишняя память не поднимает попадания.`);
      if (n.type === 'objstore' && L.storeTb && !p.lifecycle && (p.sclass || 'std') === 'std') by('storage').flags.push(`${name}: ${L.storeTb} ТБ в стандартном классе, а старые записи открывают редко. Правила жизненного цикла увозят их в дешёвые классы сами.`);
      if (n.type === 'kibana' && (+p.retention || 14) >= 90) by('logs').flags.push(`${name}: логи хранятся ${+p.retention >= 730 ? 'без срока — уже 2 года' : p.retention + ' дней'}, а аварии разбирают по последним двум неделям. Старое — в архив или удалить.`);
    });
    if (tr.v > 50) {
      const worst = g.edges.map(e => ({ e, a: g.nodes.find(n => n.id === e.from), b: g.nodes.find(n => n.id === e.to), x: (res.edges[e.id] || {}).xaz || 0 })).filter(x => x.x > 1).sort((p, q) => q.x - p.x)[0];
      if (worst && !(worst.a.props || {}).zoneLocal) tr.flags.push(`«${lbl(worst.a)}» → «${lbl(worst.b)}»: ${pc(xazShare(worst.a, worst.b))} обращений уходят в другую зону — ${usd(worst.x)} в месяц только за этот путь. Включи «Ходить к базе и кэшу в своей зоне».`);
    }
    const total = items.reduce((s, x) => s + x.v, 0);
    return { items, total, flags: items.reduce((s, x) => s + x.flags.length, 0) };
  }
  /* «было»: счёт стартовой схемы уровня */
  const START = {};
  function startBill(L) {
    const base = L.free ? SD.levelById(L.free.base) : L;
    if (!base || !base.start) return null;
    if (START[base.id]) return START[base.id];
    const nodes = [], edges = [];
    const addN = ([id, type, x, y, props, label]) => nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props || {}), label });
    (base.preset || []).forEach(addN); base.start.nodes.forEach(addN);
    base.start.edges.forEach(([a, b, p], i) => edges.push({ id: 'se' + i, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) }));
    const g = { nodes, edges }, r = SD.sim.run(base, g, { mul: 1 });
    return (START[base.id] = billOf(base, g, r));
  }
  const logsGoal = { t: 'custom', text: 'Логи для разбора аварий хранятся не меньше 14 дней', fn: g => {
    const ks = g.nodes.filter(n => n.type === 'kibana');
    if (!ks.length) return { ok: false, detail: 'узла логов нет: аварию будет не разобрать' };
    const k = ks.find(n => (+n.props.retention || 14) >= 14 && g.edges.some(e => e.to === n.id && ['app', 'worker'].includes((g.nodes.find(x => x.id === e.from) || {}).type)));
    return k ? { ok: true, detail: `храним ${+k.props.retention >= 730 ? 'без срока' : k.props.retention + ' дней'}` } : { ok: false, detail: 'логи хранятся меньше 14 дней или сервисы в них не пишут' };
  } };
  const BILL_E = [['client', 'lb'], ['client', 'cdn'], ['cdn', 's3'], ['lb', 'app'], ['app', 'cache'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'db'], ['app', 'logs'], ['w', 'logs']];
  const BILL_N = (o) => [['cdn', 'cdn', 220, 90, {}, 'CDN для видео'], ['lb', 'lb', 220, 280], ['app', 'app', 440, 280, Object.assign({ count: 6, size: 'xl', az: 3, logLevel: 'debug' }, o.app), 'Сайт и API школы'],
    ['cache', 'cache', 700, 110, Object.assign({ count: 3, mem: 64, az: 3 }, o.cache), 'Кэш уроков'], ['db', 'sql', 700, 280, Object.assign({ size: 'xl', replicas: 2, az: 3 }, o.db), 'База учеников'],
    ['s3', 'objstore', 940, 110, Object.assign({}, o.s3), 'Видеоуроки и записи'], ['q', 'queue', 700, 440, { engine: 'sqs' }, 'Очередь заданий'],
    ['w', 'worker', 940, 440, Object.assign({ count: 12, az: 2, logLevel: 'debug' }, o.w), 'Проверка домашних заданий'], ['logs', 'kibana', 440, 520, Object.assign({ retention: 730 }, o.logs), 'Логи: ELK + Kibana']];
  SD.CLOUDL.push(CL({
    id: 'c-bill', title: 'Счёт пришёл', pattern: 'autoscaling', bill: { kb: 16, dayShare: 0.45, night: 0.25, revenueRub: 18e6 },
    chips: ['FinOps', 'счёт по статьям', 'перерасход'],
    story: 'Онлайн-школа английского «Спик» переехала в облако полгода назад — «как удобно, потом разберёмся». Пришёл счёт за сентябрь — в три с лишним раза больше бюджета. Сайт при этом работает хорошо: 99,9 % ответов, страницы быстрее 120 мс, падение зоны переживает. Как разбор банковской выписки: сначала по статьям — куда уходят деньги, потом в каждой статье — что лишнее. Разбери счёт в задании, найди перерасход и перестрой схему так, чтобы уложиться в бюджет и не потерять ни одной цели.',
    traffic: { read: 4000, write: 300, static: 2500 }, hotSetGb: 6, storeTb: 150,
    job: { from: 'write', label: 'проверка домашних заданий', ms: 200, conc: 10, target: 'sql' },
    start: { nodes: BILL_N({}), edges: BILL_E },
    goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 120 }, zoneGoal, spotGoal, { t: 'jobs' }, logsGoal, { t: 'cost', max: 7000 }],
    stretch: { cost: 5000 },
    hints: [
      { text: 'Открой счёт в задании и разверни самую дорогую статью: «Что внутри» и «Где переплачиваем?».', why: 'Сначала крупное: две-три статьи обычно дают 80 % перерасхода. Мелочи потом.' },
      { text: 'Сервису — размер M вместо XL и «Резерв на год»; обработчикам — spot.', why: 'XL загружены на десятую часть. Сервис работает круглые сутки — резерв дешевле на 40 %. Проверку задания можно прервать и повторить — spot дешевле на 70 %.' },
      { text: 'Базе — размер M и одна реплика; кэшу — 2 узла по 8 ГБ.', why: 'Горячих данных ≈ 6 ГБ, база загружена на 10 %. Зоны не трогай: реплика в другой зоне нужна на случай аварии.' },
      { text: 'Логам — уровень info и срок 14 дней; видео — правила жизненного цикла; сервису — «Ходить к базе и кэшу в своей зоне».', why: 'Debug и «храним всё» раздувают логи в десятки раз. Старые уроки смотрят редко. Обращения в соседнюю зону облако берёт отдельно за каждый ГБ.' }
    ],
    decisions: [
      { q: 'С чего начинать разбор счёта?', opts: [
        { t: 'С самых дорогих статей: по каждой — что внутри, сколько загружено и как оплачено', v: 'right', fb: 'Да. Счёт — как выписка: сначала крупные траты. Три-четыре находки обычно дают большую часть экономии.' },
        { t: 'Сразу перевести всё на spot', v: 'wrong', fb: 'Spot отбирают с предупреждением за 2 минуты. Сервис, который отвечает ученикам, на spot начнёт отказывать.' },
        { t: 'Убрать вторую зону — она удваивает трафик', v: 'wrong', fb: 'Зона — это страховка от аварии дата-центра, SLO требует её пережить. Трафик между зонами режут по-другому: читают в своей зоне.' }
      ] },
      { q: 'Почему счёт за логи часто больше счёта за сервис?', opts: [
        { t: 'Логи растут с каждым запросом и копятся месяцами: debug × «храним всё» — это сотни терабайт', v: 'right', fb: 'Да. Уровень info, срок 14–30 дней в горячем хранилище, старое — в архив: так держат логи в разумных деньгах.' },
        { t: 'Kibana — дорогая программа', v: 'wrong', fb: 'Дорого не окно поиска, а объём: сколько принимаем и сколько храним.' }
      ] }
    ],
    solution: { nodes: BILL_N({ app: { count: 3, size: 'm', pricing: 'ri', autoscale: true, zoneLocal: true, logLevel: 'info' }, cache: { count: 2, mem: 8, az: 2 }, db: { size: 'm', replicas: 1, az: 2 }, s3: { lifecycle: true }, w: { pricing: 'spot', logLevel: 'info' }, logs: { retention: 14 } }), edges: BILL_E,
      note: 'Сервис — машины M: три в резерве на год, днём автомасштаб добавляет ещё; читает в своей зоне; обработчики — spot; база M с одной репликой в другой зоне; кэш 2 × 8 ГБ; логи info на 14 дней; видео — по классам хранения. Зоны и SLO на месте, счёт — в бюджете.' }
  }));

  /* ---------- блок «Счёт за месяц» в задании ---------- */
  const OPEN = new Set();
  function billPanel(L, A) {
    if (!L || !L.bill || !A || !A.graph || !A.res1) return '';
    const b = billOf(L, A.graph, A.res1), s0 = startBill(L), budget = ((L.goals || []).find(x => x.t === 'cost') || {}).max || 0;
    const max = Math.max(b.total, s0 ? s0.total : 0, budget, 1);
    let h = `<section class="bl-box" aria-label="Счёт за месяц"><div class="bl-head"><div><small>Счёт за месяц</small><b class="${budget && b.total > budget ? 'bad' : 'ok'}">${usd(b.total)}</b></div><div><small>Бюджет</small><b>${usd(budget)}</b></div>${s0 ? `<div><small>Было</small><b>${usd(s0.total)}</b></div>` : ''}</div>`;
    h += `<div class="bl-scale" aria-hidden="true"><i class="${budget && b.total > budget ? 'bad' : 'ok'}" style="width:${(b.total / max * 100).toFixed(1)}%"></i>${budget ? `<span style="left:${(budget / max * 100).toFixed(1)}%"></span>` : ''}</div>`;
    if (L.bill.revenueRub) { const rub = v => (v * BILLP.usdRub / 1e6).toFixed(1).replace('.', ',') + ' млн ₽'; h += `<p class="bl-biz"><b>Для бизнеса:</b> ${rub(b.total)} в месяц — ${pc(b.total * BILLP.usdRub / L.bill.revenueRub)} выручки школы${s0 ? ` (было ${pc(s0.total * BILLP.usdRub / L.bill.revenueRub)})` : ''}. Для онлайн-сервиса норма — 3–6 %. Допущения: выручка ≈ ${(L.bill.revenueRub / 1e6).toFixed(0)} млн ₽ в месяц, $1 = ${BILLP.usdRub} ₽.</p>`; }
    h += '<div class="bl-rows">';
    const rows = b.items.map((it, i) => ({ it, was: s0 ? s0.items[i].v : null })).filter(x => x.it.v > 0.5 || (x.was || 0) > 0.5).sort((p, q) => Math.max(q.it.v, q.was || 0) - Math.max(p.it.v, p.was || 0));
    rows.forEach(({ it, was }) => {
      const share = b.total ? it.v / b.total : 0;
      h += `<details class="bl-row" data-bl="${it.k}"${OPEN.has(it.k) ? ' open' : ''}><summary><span class="bl-n">${esc(it.n)}</span><span class="bl-bar"><i style="width:${(it.v / max * 100).toFixed(1)}%"></i>${was != null ? `<s style="left:${(was / max * 100).toFixed(1)}%"></s>` : ''}</span><b>${usd(it.v)}</b><small>${pc(share)}${was != null && Math.abs(was - it.v) > 1 ? ' · было ' + usd(was) : ''}</small></summary><div class="bl-in">`;
      if (it.k === 'traffic') {
        const tb = A.res1.bill ? A.res1.bill.trafficTb : 0;
        h += `<p class="bl-p">Сервисы и обработчики ходят в базу, кэш и очередь. Если они в разных зонах доступности, каждый ГБ облако берёт отдельно — $0,02. Сейчас между зонами ≈ ${Math.round(tb)} ТБ в месяц.</p>`;
      } else if (it.nodes.length) {
        h += `<ul class="bl-facts">${it.nodes.sort((p, q) => q.r.cost - p.r.cost).map(({ n, r }) => `<li><b>${esc(lbl(n))}</b> — ${usd(r.cost)}<small>${esc(facts(n, r, L))}</small></li>`).join('')}</ul>`;
      }
      h += `<details class="bl-hint" data-bl="h-${it.k}"${OPEN.has('h-' + it.k) ? ' open' : ''}><summary>Где переплачиваем?</summary>${it.flags.length ? `<ul>${it.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p>Здесь перерасхода не видно.</p>'}</details></div></details>`;
    });
    h += `</div><p class="bl-sum">${b.flags ? `На схеме ещё ${b.flags} ${b.flags === 1 ? 'место' : b.flags < 5 ? 'места' : 'мест'}, где можно платить меньше${s0 ? ` (в начале было ${s0.flags})` : ''}.` : 'Явного перерасхода не осталось.'} Цифры пересчитываются после каждой правки схемы.</p></section>`;
    return h;
  }
  function facts(n, r, L) {
    const p = n.props || {}, f = [];
    if (n.type === 'app') f.push(`${p.count} × ${VCPU[p.size || 'm']} ядра`);
    if (n.type === 'worker') f.push(`${p.count} шт.`);
    if (r.util != null && !['objstore', 'kibana', 'cdn', 'lb'].includes(n.type)) f.push(`загрузка ${pc(Math.min(r.util, 9))}`);
    if (p.pricing) f.push({ od: 'по требованию', ri: 'резерв на год', spot: 'spot' }[p.pricing]);
    if (p.autoscale) f.push('автомасштаб' + (r.dayAvg ? `: в среднем ${r.dayAvg.toFixed(1).replace('.', ',')} машины за сутки` : ''));
    if ((p.az || 1) > 1) f.push(`зон: ${p.az}`);
    if (n.type === 'sql') f.push(`сервер ${(p.size || 'm').toUpperCase()}, реплик ${p.replicas || 0}`);
    if (n.type === 'cache') f.push(`${p.count || 1} × ${p.mem} ГБ, горячих данных ≈ ${L.hotSetGb || 8} ГБ`);
    if (n.type === 'objstore' && L.storeTb) f.push(`${L.storeTb} ТБ, ${p.lifecycle ? 'по классам: жизненный цикл' : { std: 'стандарт', ia: 'редкий доступ', arch: 'архив' }[p.sclass || 'std']}`);
    if (n.type === 'kibana' && r.logs) f.push(`≈ ${Math.round(r.logs.gbDay)} ГБ логов в день × ${r.logs.ret} дней хранения`);
    if ((n.type === 'app' || n.type === 'worker') && p.logLevel) f.push('логи ' + p.logLevel);
    return f.join(' · ');
  }
  (SD.taskCtas = SD.taskCtas || []).push(billPanel);
  if (typeof document !== 'undefined') document.addEventListener('toggle', e => { const d = e.target; if (!d || !d.dataset || !d.dataset.bl) return; if (d.open) OPEN.add(d.dataset.bl); else OPEN.delete(d.dataset.bl); }, true);
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^c-/.test(id) ? SD.CLOUDL.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.cloudLvl ? 'Облако' : baseLabel(L);
  SD.nextLevel = L => { if (L.cloudLvl) { const i = SD.CLOUDL.indexOf(L); return i >= 0 && i < SD.CLOUDL.length - 1 ? SD.CLOUDL[i + 1] : null; } return baseNext(L); };

  SD.cloud = { zoneDown, spotDown };
  Object.assign(SD.cloud, { bill: billOf, startBill, logsGoal });
})();
