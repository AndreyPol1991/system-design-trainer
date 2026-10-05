/* Трек «Данные: от события до дашборда»: отчёты уходят с боевой базы в DWH, поток событий через очередь,
   колоночная БД изнутри (звезда, витрины, партиции), озеро данных (Parquet, разбивка по дате).
   Финал трека — уровень «Аналитика для бизнеса». */
(function () {
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const D = o => Object.assign({ tier: 'data', dataLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL() }, o);
  const lakeGot = (g, res) => { const ls = g.nodes.filter(n => n.type === 'lake'); const got = ls.some(l => ((res.nodes[l.id] || {}).load || {}).events > 0); return { ok: got, detail: got ? 'события пишутся в озеро' : 'в озеро ничего не приходит' }; };

  SD.DATAL = [
    D({
      id: 'd-reports', title: 'Отчёты на боевой базе', pattern: 'cqrs', inside: 'olap',
      chips: ['OLTP и OLAP', 'DWH', 'ETL раз в час'],
      story: 'Интернет-магазин: покупатели читают каталог и оформляют заказы, а отдел продаж открыл дашборды — 100 отчётов в секунду «выручка по категориям за месяц» считаются прямо по боевой PostgreSQL. Один такой отчёт перебирает миллионы строк, и база перестала успевать за покупателями. Отдели аналитику: события — в аналитическую базу, отчёты — оттуда. Отставание данных на час-полтора отдел продаж устраивает.',
      traffic: { read: 4000, write: 400, events: 4000, report: 100 },
      hotSetGb: 8,
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 3 }], ['db', 'sql', 660, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [
        { t: 'success', min: 0.999 },
        { t: 'latency', kind: 'read', max: 150 },
        { t: 'latency', kind: 'report', max: 1500 },
        { t: 'freshReports', max: 5400 },
        { t: 'arch', text: 'Отчёты не ходят в боевую базу', has: ['dwh'], not: ['oltpreports'] },
        { t: 'cost', max: 3200 }
      ],
      hints: [
        { text: 'Поставь «Аналитическую БД» и соедини Сервис → Аналитическая БД: отчёты пойдут туда, а не в PostgreSQL.', why: 'Сервис отправляет отчёт в аналитическую базу, если она подключена. Боевая база остаётся покупателям.' },
        { text: 'Данные в аналитическую базу везёт конвейер: Сервис → Брокер → ETL-конвейер (раз в час) → Аналитическая БД.', why: 'Без конвейера в аналитической базе пусто — отчёты «данные не доходят».' }
      ],
      solution: {
        nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 4 }], ['db', 'sql', 660, 140, { replicas: 1 }], ['q', 'queue', 660, 330], ['etl', 'etl', 880, 330, { mode: 'hourly' }], ['olap', 'olap', 1100, 250]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'olap'], ['app', 'olap']],
        note: 'Боевая база — для покупателей, аналитическая — для отчётов (это CQRS на уровне данных). События раз в час везёт ETL.'
      }
    }),
    D({
      id: 'd-clicks', title: '40 000 кликов в секунду', pattern: 'pubsub', inside: 'olap',
      chips: ['поток событий', 'ClickHouse', 'вставка пачками'],
      story: 'Маркетинг хочет видеть клики на сайте почти вживую — не позже минуты. Сейчас сервис пишет каждый клик прямо в ClickHouse отдельным INSERT: 40 000 вставок в секунду. Каждая вставка — новый кусок данных на диске, фоновое слияние не успевает, база отвечает «too many parts». Сделай поток, который выдержит нагрузку и даст свежесть в пределах минуты.',
      traffic: { read: 3000, write: 300, events: 40000, report: 100 },
      hotSetGb: 8,
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 4 }], ['db', 'sql', 660, 140, { replicas: 1 }], ['olap', 'olap', 900, 300, { insert: 'row' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'olap']] },
      goals: [
        { t: 'success', min: 0.999 },
        { t: 'latency', kind: 'report', max: 1000 },
        { t: 'freshReports', max: 60 },
        { t: 'cost', max: 4200 }
      ],
      hints: [
        { text: 'Клики — в брокер: Сервис → Брокер сообщений. Он примет 40 000 в секунду и подержит их.', why: 'Брокер развязывает «быстро пишем» и «аккуратно грузим пачками».' },
        { text: 'Брокер → ETL-конвейер в режиме «поток» → Аналитическая БД. Вставку в аналитической БД — пачками.', why: 'Поток грузит пачки каждые несколько секунд: свежесть в секундах, а кусков на диске мало. Батч раз в час свежесть не даст.' }
      ],
      solution: {
        nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 4 }], ['db', 'sql', 660, 140, { replicas: 1 }], ['q', 'queue', 660, 330, { partitions: 4 }], ['etl', 'etl', 880, 330, { mode: 'stream' }], ['olap', 'olap', 1100, 250, { insert: 'batch' }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'olap'], ['app', 'olap']],
        note: 'Клики идут в брокер, потоковый конвейер грузит их в ClickHouse пачками каждые несколько секунд: свежесть ≈ 10 секунд, кусков на диске мало.'
      }
    }),
    D({
      id: 'd-columns', title: 'Дашборды тормозят', pattern: 'partitioning', inside: 'olap', knobsOnly: true,
      chips: ['звезда', 'витрины (MV)', 'партиции по месяцам'],
      story: 'Аналитическая база уже есть, данные едут потоком. Но 1 500 дашбордов в секунду с автообновлением считают суммы по сырым фактам в «снежинке» без партиций — отчёт идёт секунды, база перегружена. Докупить шарды нельзя: бюджет. Настрой саму базу: модель данных, готовые агрегаты и партиции.',
      traffic: { read: 2000, write: 200, events: 20000, report: 1500 },
      hotSetGb: 8,
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 3 }], ['db', 'sql', 660, 140, { replicas: 1 }], ['q', 'queue', 660, 330, { partitions: 3 }], ['etl', 'etl', 880, 330, { mode: 'stream' }], ['olap', 'olap', 1100, 250, { count: 2, schema: 'snowflake', partition: false }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'olap'], ['app', 'olap']] },
      goals: [
        { t: 'success', min: 0.999 },
        { t: 'latency', kind: 'report', max: 120 },
        { t: 'freshReports', max: 60 },
        { t: 'cost', max: 3600 }
      ],
      hints: [
        { text: 'Нажми на «Аналитическую БД»: модель данных «Звезда» вместо «Снежинки» — меньше JOIN на каждый отчёт.', why: 'Снежинка нормализует измерения, и отчёт склеивает больше таблиц.' },
        { text: 'Включи «Материализованные представления» и «Партиции по месяцам».', why: 'Дашборд читает готовые суммы, а не сырые факты; запрос за месяц читает одну партицию, а не всю историю.' }
      ],
      solution: {
        nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 3 }], ['db', 'sql', 660, 140, { replicas: 1 }], ['q', 'queue', 660, 330, { partitions: 3 }], ['etl', 'etl', 880, 330, { mode: 'stream' }], ['olap', 'olap', 1100, 250, { count: 2, schema: 'star', mv: true, partition: true }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'olap'], ['app', 'olap']],
        note: 'Звезда, материализованные представления и партиции по месяцам: тот же сервер считает отчёты в десятки раз быстрее.'
      }
    }),
    D({
      id: 'd-lake', title: 'Хранить всё и дёшево', pattern: 'partitioning', inside: 'lake', knobsOnly: true,
      chips: ['озеро данных', 'Parquet', 'разбивка по дате'],
      story: 'Аналитикам нужны все сырые события за годы — для разовых исследований. Их складывают в озеро данных JSON-файлами в одну кучу: хранение дорожает, а запрос аналитика «клики за вчера» читает всё озеро и идёт полминуты. Настрой озеро: формат файлов, разбивку по дате и табличный формат.',
      traffic: { read: 1000, write: 100, events: 30000, report: 20 },
      hotSetGb: 8,
      start: { nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 3 }], ['db', 'sql', 660, 140], ['q', 'queue', 660, 330, { partitions: 3 }], ['etl', 'etl', 880, 330, { mode: 'hourly' }], ['lake', 'lake', 1100, 250, { format: 'json', partitioned: false, iceberg: false }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'lake'], ['app', 'lake']] },
      goals: [
        { t: 'success', min: 0.999 },
        { t: 'latency', kind: 'report', max: 3000 },
        { t: 'custom', text: 'Сырые события сохраняются в озеро данных', fn: lakeGot },
        { t: 'cost', max: 2000 }
      ],
      hints: [
        { text: 'Нажми на «Озеро данных»: формат Parquet вместо JSON.', why: 'Parquet хранит колонки отдельно и сжато: запрос читает только нужные колонки, а хранение дешевле в разы.' },
        { text: 'Включи «Партиции по дате».', why: 'Файлы лежат в папках dt=2026-10-03: запрос за день читает одну папку, а не всё озеро.' }
      ],
      solution: {
        nodes: [['lb', 'lb', 220, 250], ['app', 'app', 420, 250, { count: 3 }], ['db', 'sql', 660, 140], ['q', 'queue', 660, 330, { partitions: 3 }], ['etl', 'etl', 880, 330, { mode: 'hourly' }], ['lake', 'lake', 1100, 250, { format: 'parquet', partitioned: true, iceberg: true }]],
        edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'etl'], ['etl', 'lake'], ['app', 'lake']],
        note: 'Parquet, разбивка по дате и Iceberg: хранение дешевле в разы, запрос за день читает одну папку и только нужные колонки.'
      }
    })
  ];

  /* «Загляни внутрь» узла уровня — когда для него есть сцена изнутри */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  SD.dataTaskCta = L => {
    if (!L || !L.dataLvl || !L.inside || !SD.xray || !SD.xray.has(L.inside) || !SD.app) return '';
    const n = SD.app.A.graph.nodes.find(x => x.type === L.inside), T = SD.TYPES[L.inside];
    return n ? `<button type="button" class="dive-cta xr-cta" data-act="xray" data-id="${n.id}">${SD.icon(L.inside)}<span><b>Загляни внутрь: ${esc(T.name)}</b><small>Как данные лежат и как по ним считается отчёт — на настоящих таблицах и файлах</small></span></button>`
      : `<div class="ops-cta-wait">${SD.icon(L.inside)}<span>Поставь «${esc(T.name)}» на площадку — и сможешь заглянуть внутрь.</span></div>`;
  };
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^d-/.test(id) ? SD.DATAL.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.dataLvl ? 'Данные: от события до дашборда' : baseLabel(L);
  SD.nextLevel = L => {
    if (L.dataLvl) { const i = SD.DATAL.indexOf(L); return i >= 0 && i < SD.DATAL.length - 1 ? SD.DATAL[i + 1] : (SD.LEVELS.find(x => x.id === 'analytics') || null); }
    return baseNext(L);
  };
})();
