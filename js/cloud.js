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
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^c-/.test(id) ? SD.CLOUDL.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.cloudLvl ? 'Облако' : baseLabel(L);
  SD.nextLevel = L => { if (L.cloudLvl) { const i = SD.CLOUDL.indexOf(L); return i >= 0 && i < SD.CLOUDL.length - 1 ? SD.CLOUDL[i + 1] : null; } return baseNext(L); };

  SD.cloud = { zoneDown, spotDown };
})();
