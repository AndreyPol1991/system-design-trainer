/* CI/CD на схеме и в симуляторе: ops-узел «Конвейер CI/CD» (тип cicd) со стрелкой «разворачивает» к сервисам
   (app, worker) — напрямую или через Kubernetes (конвейер → Kubernetes → сервисы).
   Что моделируем — просто и честно, цифры согласованы с лабораторией «Выкладка вживую»:
   1. Доля неудачных изменений (change failure rate): базово каждый 4-й релиз несёт баг до прода (25 %).
      Большой недельный релиз ломается чаще (×1,2), мелкие релизы много раз в день — реже (×0,7).
      Юнит-тесты ловят половину багов, юнит + интеграционные — 4 из 5.
   2. Учебное испытание «плохой релиз» (opts.badRelease, как opts.k8sRollout у Kubernetes): новая версия отвечает
      ошибкой. Какая доля запросов попадёт на неё и как долго — зависит от стратегии и того, кто заметит:
      автооткат по метрикам ≈ 1 мин (только если на схеме есть Prometheus или Alertmanager), алерт и дежурный ≈ 5 мин,
      графики ≈ 15 мин, жалобы покупателей ≈ 30 мин.
      · всё сразу — ≈ 30 с простоя на каждой выкладке, плохая версия у 100 % экземпляров, откат — ещё один простой;
      · rolling — экземпляры меняются по одному за ≈ 5 мин, откат идёт тем же порядком;
      · blue-green — 100 % трафика переключается разом, откат — переключение назад за секунду; серверов на время выкладки ×2;
      · канарейка — 5 → 25 → 50 → 100 % трафика, по ≈ 2 мин на шаг; откат — снять долю канарейки.
        Ровно 5 % — только если перед сервисом балансировщик L7 или API Gateway: они делят запросы по весам.
        Иначе (L4, нет балансировщика, обработчик очереди) канарейка — по экземплярам: один новый из N, доля 1/N.
      В режиме испытания плохие экземпляры отвечают ошибкой через opts.sick — тот же механизм, что «Сосед болеет».
      Фоновые задачи развёрнутых обработчиков падают с той же долей (routePost → случайные ошибки обработки):
      у очереди с «Повторы + DLQ» они повторятся после отката или лягут в DLQ, без них — теряются.
   3. Метрики DORA в результате (res.cicd.dora): частота выкладок, доля неудачных изменений, время восстановления (MTTR),
      время от коммита до прода и минуты простоя от релизов в месяц.
   Схемы без узла CI/CD считаются ровно как раньше. Уровни — в трек «Эксплуатация» (SD.OPSL). */
(function () {
  const T = SD.TYPES;
  const HAS_DOM = typeof document !== 'undefined';

  /* ---------- модель: цифры ---------- */
  const MONTH_MIN = 30 * 24 * 60;
  const PER_MONTH = { week: 4, day: 20, many: 100 };      // релизов в месяц: по рабочим дням, «много» — ≈ 5 в день
  const SIZE = { week: 1.2, day: 1, many: 0.7 };          // большой релиз копит больше изменений — ломается чаще
  const BUG = 0.25;                                       // без тестов каждый 4-й ежедневный релиз несёт баг до прода
  const CATCH = { none: 0, unit: 0.5, int: 0.8 };         // какую долю багов ловят автотесты до выкладки
  const DETECT = { auto: 1, alerts: 5, metrics: 15, none: 30 };   // минут до решения «откатываем»
  const DOWN_RC = 0.5;                                    // всё сразу: ≈ 30 с никто не отвечает
  const ROLL_MIN = 5;                                     // rolling: все экземпляры заменяются за ≈ 5 мин
  const STEPS = [0.05, 0.25, 0.5, 1], STEP_MIN = 2;       // канарейка: доли трафика и минуты на шаг
  const BG_WIN = 10;                                      // blue-green: оба окружения работают ≈ 10 мин на выкладку
  const COST = { base: 40, fix: { none: 0, unit: 10, int: 120 }, run: { none: 0, unit: 0.5, int: 2 } };
  const SVC = new Set(['app', 'worker']);
  const STRATS = ['recreate', 'rolling', 'bg', 'canary'], TESTS = ['none', 'unit', 'int'], FREQS = ['week', 'day', 'many'];
  const S_NAME = { recreate: 'всё сразу', rolling: 'rolling', bg: 'blue-green', canary: 'канарейка' };
  const S_TITLE = { recreate: '«Всё сразу»', rolling: 'Rolling', bg: 'Blue-green', canary: 'Канарейка' };
  const F_NAME = { week: 'раз в неделю', day: 'каждый день', many: 'много раз в день' };
  const T_NAME = { none: 'без автотестов', unit: 'юнит-тесты', int: 'юнит + интеграционные' };
  const HOW = {
    auto: ['автооткат', 'автооткат по метрикам сравнит ошибки новой версии со старой'],
    alerts: ['дежурный по алерту', 'сработает алерт, дежурный разберётся и откатит'],
    metrics: ['кто-то на графиках', 'кто-нибудь увидит рост ошибок на графиках'],
    none: ['поддержка по жалобам', 'о беде узнают из жалоб покупателей в поддержку']
  };
  const LEAD = { week: 'до недели', day: '≈ 1 день', many: '≈ 1 час' };
  const LEAD_T = { none: '', unit: ' + 5 мин тестов', int: ' + 20 мин тестов' };

  const dec = (v, k) => { const p = Math.pow(10, k == null ? 1 : k); return (Math.round(v * p) / p).toString().replace('.', ','); };
  const pc = v => { const x = v * 100; return (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : dec(x, 1)) + ' %'; };
  const mins = v => v < 1 ? Math.max(1, Math.round(v * 60)) + ' с' : dec(v, v < 10 ? 1 : 0) + ' мин';
  const usd = v => SD.fmt ? SD.fmt.usd(v) : '$' + Math.round(v);
  const lbl = n => n ? (n.label || (T[n.type] ? T[n.type].name : n.type)) : '';
  const plural = (n, a, b, c) => { const x = Math.abs(Math.round(n)) % 100, y = x % 10; return x > 10 && x < 20 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };
  const cnt = (v, a, b, c) => Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)} ${plural(v, a, b, c)}` : `${dec(v, 1)} ${b}`;
  const nth = cfr => cfr > 0 ? Math.max(1, Math.round(1 / cfr)) : 0;
  const pick = (v, list, d) => list.includes(v) ? v : d;
  const tog = (key, label, def, help) => ({ key, label, type: 'toggle', def, help });

  /* ---------- узел «Конвейер CI/CD» ---------- */
  /* порядок вариантов — от надёжного к простому: при равенстве целей справка «?» объявляет лучшим первый вариант */
  const PROPS = [
    { key: 'strategy', label: 'Стратегия выкладки', type: 'select', def: 'rolling',
      options: [['canary', 'Канарейка — сначала 5 % трафика'], ['bg', 'Blue-green — второе окружение и переключение'], ['rolling', 'Rolling — менять экземпляры по одному'], ['recreate', 'Всё сразу — остановить старые, запустить новые']],
      help: 'Как новая версия заменяет старую. Канарейка — новая версия получает 5 %, потом 25, 50 и 100 % трафика; ровно 5 % — если балансировщик L7 или API Gateway делит запросы по весам, иначе доля по числу экземпляров (из 2 один новый — половина). Blue-green — рядом поднимается второе окружение, трафик переключается целиком, откат — за секунду, но серверов на время выкладки вдвое больше. Rolling — без простоя, экземпляры меняются по одному за ≈ 5 мин. Всё сразу — ≈ 30 с простоя на каждой выкладке.' },
    { key: 'tests', label: 'Автотесты перед выкладкой', type: 'select', def: 'unit',
      options: [['int', 'Юнит + интеграционные — ловят ≈ 4 из 5'], ['unit', 'Юнит-тесты — ловят ≈ половину багов'], ['none', 'Нет — что собралось, то и выкладываем']],
      help: 'Сборка, которая не прошла тесты, в прод не попадает. Юнит-тесты проверяют функции по отдельности — быстро и дёшево. Интеграционные запускают сервис с настоящей базой и соседями на тестовом стенде — ловят ошибки на стыках, но стенд и прогоны стоят денег.' },
    tog('autoRollback', 'Автооткат по метрикам', false, 'Конвейер сам сравнивает ошибки новой версии со старой и возвращает старую за ≈ 1 минуту. Работает, только если на схеме есть мониторинг: Prometheus или Alertmanager.'),
    { key: 'freq', label: 'Частота релизов', type: 'select', def: 'week',
      options: [['week', 'Раз в неделю — один большой релиз'], ['day', 'Каждый день'], ['many', 'Много раз в день — маленькими порциями']],
      help: 'Чем реже релиз, тем больше в нём изменений: он чаще ломается, и причину искать дольше. Частые мелкие релизы безопаснее, если выкладка без простоя, а откат быстрый.' }
  ];
  if (!T.cicd) {
    T.cicd = {
      name: 'Конвейер CI/CD', short: 'собирает, тестирует и выкладывает версии', group: 'platform', layer: 'platform', ops: 'cicd', managed: true, perCap: 1e9, lat: 0,
      props: PROPS,
      cost: n => { const p = n.props || {}, t = pick(p.tests, TESTS, 'unit'), f = pick(p.freq, FREQS, 'week'); return COST.base + COST.fix[t] + COST.run[t] * PER_MONTH[f]; },
      info: {
        what: 'Конвейер выкладки (CI/CD): сам собирает каждую новую версию сервиса, прогоняет автотесты и выкладывает её по выбранной стратегии. Стрелка от конвейера к сервису — «разворачивает».',
        why: 'Ручная выкладка — это вечер нервов и ошибки на каждом шаге. Конвейер делает одно и то же каждый раз: не пускает в прод сборку с упавшими тестами, выкатывает без простоя и сам откатывает плохую версию по метрикам.',
        pros: ['Каждая выкладка одинаковая и повторяемая', 'Тесты останавливают баги до покупателей', 'Выкладка без простоя и автооткат'],
        cons: ['Тесты и тестовый стенд стоят денег и времени', 'Канарейке и автооткату нужен мониторинг'],
        real: 'GitLab CI, GitHub Actions, Jenkins — сборка и тесты; Argo CD, Argo Rollouts, Flagger, Spinnaker — выкладка, канарейка и автооткат',
        numbers: [['Сборка и юнит-тесты', '≈ 5 мин'], ['Интеграционные тесты', '≈ 20 мин'], ['Автооткат по метрикам', '≈ 1 мин']]
      }
    };
    const prevInner = SD.iconInner;
    SD.iconInner = t => t === 'cicd' ? '<path d="M6.5 8C4.5 8 3 9.8 3 12s1.5 4 3.5 4c3.2 0 7.8-8 11-8 2 0 3.5 1.8 3.5 4s-1.5 4-3.5 4c-3.2 0-7.8-8-11-8z"/><path d="M15.5 5.5L18 8l-2.5 2.5"/>' : prevInner(t);
  }

  /* ---------- справка «?»: на пальцах и что значит каждый вариант ---------- */
  if (SD.SIMPLE_TYPES) SD.SIMPLE_TYPES.cicd = ['Сам собирает, тестирует и выкладывает новые версии сервисов.', 'Конвейер на заводе: каждая деталь проходит контроль качества, прежде чем попасть на полку магазина.'];
  if (SD.TYPE_GUIDE) SD.TYPE_GUIDE.cicd = [
    'Разработчик отправляет код в Git — конвейер (CI) сам собирает сервис в образ контейнера.',
    'Прогоняет автотесты. Упал хоть один — сборка дальше не идёт: баг остановлен до покупателей.',
    'Выкладка (CD) по выбранной стратегии: всё сразу, по одному экземпляру, вторым окружением или канарейкой.',
    'Автооткат смотрит на метрики новой версии: ошибок больше, чем у старой, — возвращает старую сам. Без мониторинга ему не на что смотреть.',
    'Метрики DORA показывают, как работает доставка: как часто релизы, какая доля ломается и как быстро чинится.'
  ];
  if (SD.PROP_SIMPLE) SD.PROP_SIMPLE.cicd = {
    strategy: 'Как поменять меню в ресторане. Всё сразу — закрыть зал, поменять меню, открыть. Rolling — менять меню по одному столику. Blue-green — открыть второй зал с новым меню и пересадить всех гостей разом: не понравилось — пересадить обратно. Канарейка — сначала дать новое блюдо одному столику из двадцати. Но если столиков всего два, «один столик» — это уже половина зала: нужен официант, который сам даёт новое блюдо каждому двадцатому гостю, — балансировщик, который делит запросы по весам.',
    tests: 'Повар пробует суп перед подачей. Юнит-тесты — пробует каждый ингредиент отдельно. Интеграционные — пробует готовое блюдо целиком. Чем больше проб, тем реже недовольный гость, но каждая проба — время и деньги.',
    autoRollback: 'Дегустатор на кухне: если новое блюдо пошло назад с жалобами, он сам снимает его с меню, не дожидаясь шефа. Автооткат сравнивает ошибки новой версии со старой и возвращает старую за минуту. Но дегустатор должен видеть тарелки: без мониторинга он слепой.',
    freq: 'Маленькие порции весь день или огромный банкет раз в неделю. Подгорела маленькая порция — выбросил одну сковородку. Большой релиз копит много изменений: ломается чаще, и найти, что именно сломалось, труднее.'
  };
  if (SD.OPT_SIMPLE) {
    SD.OPT_SIMPLE['cicd.strategy'] = {
      recreate: 'Все экземпляры останавливаются разом — ≈ 30 с никто не отвечает. Плохая версия сразу у всех, откат — ещё один простой.',
      rolling: 'Экземпляры меняются по одному за ≈ 5 мин, без простоя. Плохая версия расползается на всех, и откат такой же долгий.',
      bg: 'Новая версия поднимается рядом, трафик переключается целиком. Откат — переключить обратно за секунду, но до отката плохую версию видят все. На время выкладки серверов вдвое больше.',
      canary: 'Новая версия сначала получает 5 % запросов, потом 25, 50 и 100 %. Плохую версию видит малая доля, откат — убрать канарейку. 5 % по весам делит балансировщик L7 или API Gateway; без них канарейка — один экземпляр из N: при 2 экземплярах это половина трафика.'
    };
    SD.OPT_SIMPLE['cicd.tests'] = {
      none: 'Без тестов каждый 4-й ежедневный релиз ломает прод.',
      unit: 'Юнит-тесты ловят ≈ половину багов. Дёшево и быстро: ≈ 5 минут на прогон.',
      int: 'Юнит + интеграционные ловят ≈ 4 из 5 багов. Нужен тестовый стенд с базой: дороже и ≈ 20 минут на прогон.'
    };
    SD.OPT_SIMPLE['cicd.autoRollback'] = {
      true: 'Автомат замечает плохую версию за ≈ 1 минуту и откатывает сам — если на схеме есть мониторинг.',
      false: 'Откатывает человек, когда заметит: по алерту ≈ 5 мин, по графикам ≈ 15, по жалобам ≈ 30.'
    };
    SD.OPT_SIMPLE['cicd.freq'] = {
      week: '≈ 4 больших релиза в месяц: каждый ломается на 20 % чаще ежедневного.',
      day: '≈ 20 релизов в месяц — по рабочим дням.',
      many: '≈ 100 маленьких релизов в месяц: каждый ломается на 30 % реже ежедневного, но релизов в 5 раз больше — всё решает скорость отката.'
    };
  }

  /* ---------- модель: плохой релиз и DORA ---------- */
  /* td — через сколько минут решили откатывать. Возвращает: пик доли запросов на плохой версии, «минуты полного простоя»
     (доля × время), время восстановления и простой самой выкладки */
  /* first — доля трафика у канарейки на первом шаге: 5 % по весам или 1/N, если делить можно только экземплярами */
  function incident(st, td, first) {
    if (st === 'recreate') return { peak: 1, E: DOWN_RC + td + DOWN_RC, D: DOWN_RC + td + DOWN_RC, deployDown: DOWN_RC };
    if (st === 'rolling') {
      const sd = Math.min(1, td / ROLL_MIN);
      const before = td <= ROLL_MIN ? td * td / (2 * ROLL_MIN) : ROLL_MIN / 2 + (td - ROLL_MIN);
      const rb = sd * ROLL_MIN;                           // откат идёт тем же порядком, по одному экземпляру
      return { peak: sd, E: before + sd * rb / 2, D: td + rb, deployDown: 0 };
    }
    if (st === 'bg') return { peak: 1, E: td, D: td, deployDown: 0 };
    const steps = STEPS.map(x => Math.max(x, first || STEPS[0]));
    let E = 0, t = 0, peak = 0;
    for (let i = 0; i < steps.length && t < td; i++) {
      const dt = Math.min(i < steps.length - 1 ? STEP_MIN : Infinity, td - t);
      E += steps[i] * dt; peak = steps[i]; t += dt;
    }
    const full = td >= STEP_MIN * (STEPS.length - 1);     // канарейка уже стала 100 % — откатываем rolling'ом
    return { peak, E: E + (full ? ROLL_MIN / 2 : 0), D: td + (full ? ROLL_MIN : 0), deployDown: 0 };
  }
  const cfrOf = (freq, tests) => BUG * SIZE[freq] * (1 - CATCH[tests]);
  const hasMon = g => g.nodes.some(n => n.type === 'prometheus' || n.type === 'alertmanager');
  function humanHow(g) {
    const s = SD.opsState ? SD.opsState(g) : null;
    if (s && s.alerts) return 'alerts';
    if (g.nodes.some(n => n.type === 'prometheus')) return 'metrics';
    return 'none';
  }
  /* разбор схемы без симуляции: кого какой конвейер выкладывает и что будет при плохом релизе */
  function analyze(g) {
    const by = id => g.nodes.find(n => n.id === id);
    const kidsOf = id => g.edges.filter(e => e.from === id).map(e => by(e.to)).filter(Boolean);
    const parentsOf = id => g.edges.filter(e => e.to === id).map(e => by(e.from)).filter(Boolean);
    /* делить трафик по весам умеют балансировщик L7 и API Gateway; L4 видит только соединения */
    const splitOf = x => {
      const routers = parentsOf(x.id).filter(p => p.type === 'lb' || p.type === 'gateway');
      const l4 = routers.find(p => p.type === 'lb' && (p.props || {}).mode === 'l4');
      return { weighted: x.type === 'app' && routers.length > 0 && !l4, router: routers[0] || null, l4: l4 || null };
    };
    const owner = {}, pipes = [];
    g.nodes.filter(n => n.type === 'cicd').forEach(c => {
      const list = [];
      kidsOf(c.id).forEach(k => {
        if (SVC.has(k.type)) list.push(k);
        else if (k.type === 'k8s') kidsOf(k.id).filter(x => SVC.has(x.type)).forEach(x => list.push(x));
      });
      const svc = list.filter((x, i) => list.indexOf(x) === i && !owner[x.id]);
      svc.forEach(x => { owner[x.id] = c.id; });
      const p = c.props || {};
      const strategy = pick(p.strategy, STRATS, 'rolling'), tests = pick(p.tests, TESTS, 'unit'), freq = pick(p.freq, FREQS, 'week');
      const mon = hasMon(g), autoWanted = !!p.autoRollback, auto = autoWanted && mon;
      const how = auto ? 'auto' : humanHow(g), td = DETECT[how];
      /* каждый развёрнутый сервис отдельно: у канарейки доля зависит от того, чем делят трафик */
      const units = svc.map(x => {
        const N = Math.max(1, Math.round(+(x.props || {}).count || 1)), sp = splitOf(x);
        const first = strategy === 'canary' ? (sp.weighted ? STEPS[0] : Math.max(STEPS[0], 1 / N)) : null;
        const inc = incident(strategy, td, first);
        const qs = parentsOf(x.id).filter(q => q.type === 'queue');
        return { id: x.id, name: lbl(x), type: x.type, N, weighted: sp.weighted, router: sp.router ? lbl(sp.router) : null, l4: sp.l4 ? lbl(sp.l4) : null, first,
          peak: inc.peak, E: inc.E, mttr: inc.D, queues: qs.map(q => q.id), retries: qs.length > 0 && qs.every(q => !!(q.props || {}).retries) };
      });
      const users = units.filter(u => u.type === 'app'), jobs = units.filter(u => u.type === 'worker'), main = users.length ? users : units;
      const inc = incident(strategy, td, STEPS[0]);
      const mx = (arr, k, d) => arr.length ? Math.max(...arr.map(u => u[k])) : d;
      const peak = mx(main, 'peak', inc.peak), E = mx(main, 'E', inc.E), mttr = mx(units, 'mttr', inc.D);
      const R = PER_MONTH[freq], cfr = cfrOf(freq, tests), bad = R * cfr;
      pipes.push({
        id: c.id, name: lbl(c), svc: svc.map(x => x.id), svcNames: svc.map(lbl), units, strategy, tests, freq, mon, autoWanted, auto, how, td,
        peak, E, mttr, jobPeak: mx(jobs, 'peak', 0), deployDown: inc.deployDown, R, cfr, bad, downMonth: R * inc.deployDown + bad * E,
        lead: LEAD[freq] + LEAD_T[tests]
      });
    });
    const reverse = g.edges.filter(e => { const a = by(e.from), b = by(e.to); return a && b && b.type === 'cicd' && SVC.has(a.type); }).map(e => e.from);
    const manual = pipes.length ? g.nodes.filter(n => SVC.has(n.type) && !owner[n.id]).map(n => n.id) : [];
    return { pipes, owner, reverse, manual };
  }
  /* сводка DORA по всем конвейерам: частота — сумма, доля неудач — средняя по релизам, восстановление — худшее */
  function dora(pipes) {
    const live = pipes.filter(P => P.svc.length);
    if (!live.length) return null;
    const R = live.reduce((s, P) => s + P.R, 0);
    const worst = live.reduce((a, P) => P.mttr > a.mttr ? P : a, live[0]);
    return {
      perMonth: R, freq: live.length === 1 ? live[0].freq : null, freqText: live.length === 1 ? F_NAME[live[0].freq] : `${R} в месяц`,
      cfr: live.reduce((s, P) => s + P.R * P.cfr, 0) / R, mttr: worst.mttr, how: worst.how,
      lead: live.length === 1 ? live[0].lead : null, downMonth: live.reduce((s, P) => s + P.downMonth, 0), badPerMonth: live.reduce((s, P) => s + P.bad, 0)
    };
  }

  /* ---------- симулятор ---------- */
  const memo = new WeakMap();
  function graphOfCtx(ctx) { return { nodes: [...ctx.nodes.values()], edges: [...ctx.edgeMap.values()] }; }
  function prepare(ctx) {
    let has = false;
    for (const n of ctx.nodes.values()) if (n.type === 'cicd') { has = true; break; }
    if (!has) { ctx.cicd = null; return; }
    let M = memo.get(ctx.opts);
    if (!M) {
      M = analyze(graphOfCtx(ctx));
      memo.set(ctx.opts, M);
      /* испытание «плохой релиз»: новая версия отвечает ошибкой — на той доле запросов, что успела на неё попасть */
      if (ctx.opts.badRelease) {
        const sick = Object.assign({}, ctx.opts.sick || {});
        M.badJob = {};
        M.pipes.forEach(P => P.units.forEach(u => {
          if (u.type === 'app') { const s0 = sick[u.id] || {}; sick[u.id] = Object.assign({}, s0, { fail: 1 - (1 - (s0.fail || 0)) * (1 - u.peak) }); }
          M.badJob[u.id] = u.peak;   // задачи из очереди обработчик считает сам (корень расчёта) — им ошибки задаём в routePost
        }));
        ctx.opts.sick = sick;
      }
    }
    ctx.cicd = M;
  }
  /* плохой релиз у обработчика: часть задач падает при обработке. Это случайный отказ (rand), поэтому дальше считает
     сам симулятор: у очереди с «Повторы + DLQ» задача повторится (после отката — успешно) или ляжет в DLQ, без них — потеряна */
  function routePost(ctx, n, kind, r) {
    const M = ctx.cicd, f = M && M.badJob && kind === 'job' ? M.badJob[n.id] : 0;
    if (f > 0) r.rand = 1 - (1 - (r.rand || 0)) * (1 - f);
  }
  function collect(ctx, res) {
    const M = ctx.cicd; if (!M) return;
    const bad = !!ctx.opts.badRelease;
    M.pipes.forEach(P => {
      let now = 0, avg = 0, inst = 0;
      P.svc.forEach(id => {
        const r = res.nodes[id]; if (!r || !r.cost) return;
        const cnt = Math.max(1, r.count || 1), per = r.cost / cnt;
        const extra = { recreate: 0, rolling: 1, canary: Math.max(1, Math.ceil(cnt * STEPS[0])), bg: cnt }[P.strategy];
        const win = { recreate: 0, rolling: ROLL_MIN, canary: STEP_MIN * (STEPS.length - 1), bg: BG_WIN }[P.strategy];
        now += per * extra; avg += per * extra * P.R * win / MONTH_MIN; inst += extra;
      });
      P.extraNow = now; P.extraAvg = avg; P.extraInst = inst;
      P.svcCost = P.svc.reduce((s, id) => s + ((res.nodes[id] || {}).cost || 0), 0);
      const add = bad ? now : avg;   // во время выкладки — все лишние серверы; в обычном месяце — в среднем за окна выкладок
      if (add > 0) { res.cost += add; if (res.nodes[P.id]) res.nodes[P.id].cost = (res.nodes[P.id].cost || 0) + add; }
      /* фоновые задачи: сколько их упадёт за один плохой релиз и что с ними будет */
      P.jobs = P.units.filter(u => u.type === 'worker').map(u => {
        const rate = ((res.nodes[u.id] || {}).load || {}).job || 0;
        return { id: u.id, name: u.name, rate, peak: u.peak, perIncident: rate * 60 * u.E, retries: u.retries, queues: u.queues };
      });
    });
    res.cicd = { pipes: M.pipes, dora: dora(M.pipes), reverse: M.reverse, manual: M.manual, badRelease: bad, jobsLost: bad ? res.jobs.lostRate : null };
  }
  (SD.simExts = SD.simExts || []).push({ prepare, routePost, collect });

  /* ---------- советы прораба ---------- */
  function cicdAdvice(level, graph, res) {
    const A = [], C = res && res.cicd; if (!C) return A;
    const name = id => lbl(graph.nodes.find(n => n.id === id));
    C.pipes.forEach(P => {
      if (!P.svc.length) { A.push({ sev: 'warn', node: P.id, text: `«${P.name}» ничего не выкладывает. Проведи стрелку от конвейера к сервису — «разворачивает». Можно и через Kubernetes: конвейер → Kubernetes → сервисы.` }); return; }
      const who = P.svcNames.length === 1 ? `«${P.svcNames[0]}»` : P.svcNames.map(x => `«${x}»`).join(', ');
      if (P.autoWanted && !P.mon) A.push({ sev: 'bad', node: P.id, text: `Автооткат включён, но смотреть ему не на что: на схеме нет мониторинга (Prometheus или Alertmanager). Плохую версию ${who} поймают по-старому: ${HOW[P.how][1]} — это ≈ ${mins(P.td)}.` });
      if (P.strategy === 'recreate') A.push({ sev: P.R >= 20 ? 'bad' : 'warn', node: P.id, text: `«Всё сразу»: на каждой выкладке ≈ 30 с никто не отвечает. ${cnt(P.R, 'выкладка', 'выкладки', 'выкладок')} в месяц — ≈ ${mins(P.R * DOWN_RC)} простоя ещё до всяких багов. Rolling, blue-green и канарейка выкладывают без простоя.` });
      if (!P.auto) A.push({ sev: P.mttr > 10 ? 'bad' : 'warn', node: P.id, text: `Откат вручную: ${HOW[P.how][1]} — это ≈ ${mins(P.td)}. До отката плохую версию ${who} видят до ${pc(P.peak)} запросов, восстановление ≈ ${mins(P.mttr)}. Автооткат по метрикам справится за ≈ 1 мин.` });
      else if (P.strategy === 'bg') A.push({ sev: 'info', node: P.id, text: `Blue-green: откат за секунду, но до него плохую версию видят все запросы — ≈ 1 мин. Во время выкладки работают оба окружения: серверов ${who} вдвое больше (+${usd(P.extraNow)} в месяц, если держать так постоянно; за ${cnt(P.R, 'выкладку', 'выкладки', 'выкладок')} по ≈ ${BG_WIN} мин — +${usd(P.extraAvg)}).` });
      else if (P.strategy === 'rolling') A.push({ sev: 'info', node: P.id, text: `Rolling с автооткатом: пока автомат замечает ошибки, новая версия успевает занять ≈ ${pc(P.peak)} экземпляров, и откат идёт тем же порядком — ≈ ${mins(P.mttr)} до восстановления. Канарейка с делением по весам ограничила бы долю пятью процентами.` });
      if (P.strategy === 'canary') P.units.filter(u => u.type === 'app' && !u.weighted && u.first > STEPS[0] + 1e-9).forEach(u => A.push({ sev: u.first >= 0.25 ? 'bad' : 'warn', node: u.id,
        text: `Канарейка по экземплярам: ${u.l4 ? `балансировщик «${u.l4}» работает на L4 и не умеет делить запросы по весам` : `перед «${u.name}» нет балансировщика L7 или API Gateway`}, поэтому новая версия получает долю по числу экземпляров — один из ${u.N}, это ${u.N === 2 ? 'половина' : pc(u.first)} трафика. Нужна канарейка по доле запросов — через балансировщик L7 или API Gateway, они делят запросы по весам, — или больше экземпляров.` }));
      (P.jobs || []).filter(j => j.rate > 0).forEach(j => {
        const many = SD.fmt ? SD.fmt.num(j.perIncident) : String(Math.round(j.perIncident));
        const how = P.strategy === 'canary' ? ` (у обработчика очереди весов нет: канарейка — один экземпляр из ${(P.units.find(u => u.id === j.id) || {}).N}, ${pc(j.peak)} задач)` : '';
        A.push(j.retries
          ? { sev: 'info', node: j.id, text: `Плохой релиз «${j.name}» роняет часть фоновых задач${how}: ≈ ${many} за одну аварию. У очереди включены «Повторы + DLQ»: задачи повторятся после отката, а безнадёжные лягут в DLQ — ничего не потеряется.` }
          : { sev: 'warn', node: j.id, text: `Плохой релиз «${j.name}» роняет фоновые задачи${how}: ≈ ${many} за одну аварию, и без «Повторы + DLQ» у очереди они теряются. Включи повторы: упавшие задачи повторятся после отката, безнадёжные лягут в DLQ.` });
      });
      if (P.tests === 'none') A.push({ sev: P.cfr > 0.2 ? 'bad' : 'warn', node: P.id, text: `Без автотестов каждый ${nth(P.cfr)}-й релиз ломает прод (доля неудачных изменений ${pc(P.cfr)}): ≈ ${cnt(P.bad, 'авария', 'аварии', 'аварий')} в месяц. Юнит-тесты отсекут половину багов, юнит + интеграционные — 4 из 5.` });
      A.push({ sev: 'info', node: P.id, text: `DORA «${P.name}»: релизы ${F_NAME[P.freq]} (≈ ${P.R} в месяц), неудачных ${pc(P.cfr)}, восстановление ≈ ${mins(P.mttr)}, простой от релизов ≈ ${mins(P.downMonth)} в месяц.` });
    });
    C.reverse.forEach(id => A.push({ sev: 'warn', node: id, text: `Стрелка идёт от «${name(id)}» к конвейеру. Конвейер разворачивает сервис — стрелка нужна от конвейера к сервису.` }));
    C.manual.forEach(id => A.push({ sev: 'info', node: id, text: `«${name(id)}» выкладывают вручную: конвейер к нему не подключён.` }));
    return A;
  }
  const baseAdvise = SD.sim.advise;
  if (baseAdvise) SD.sim.advise = function (level, graph, res) {
    const A = baseAdvise.apply(this, arguments) || [];
    try { cicdAdvice(level, graph, res).forEach(a => A.push(a)); } catch (e) { /* без советов по CI/CD */ }
    return A;
  };

  /* ---------- проверки для уровней ---------- */
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const pipesOf = res => ((res && res.cicd && res.cicd.pipes) || []).filter(P => P.svc.length);
  const noPipe = { ok: false, detail: 'нет конвейера CI/CD со стрелкой к сервису' };
  const worstBy = (list, f) => list.reduce((a, P) => f(P) > f(a) ? P : a, list[0]);
  const goals = {
    deployed: () => custom('Сервисы выкладывает конвейер CI/CD', (g, res) => {
      const svcs = g.nodes.filter(n => SVC.has(n.type)), A = analyze(g), miss = svcs.filter(n => !A.owner[n.id]).map(lbl);
      return { ok: svcs.length > 0 && !miss.length, detail: !svcs.length ? 'сервисов нет' : !A.pipes.length ? 'конвейера на схеме нет' : miss.length ? 'вручную: ' + miss.join(', ') : 'все сервисы — через конвейер' };
    }),
    badShare: max => custom(`Плохой релиз задевает не больше ${pc(max)} запросов`, (g, res, L) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const r = SD.sim.run(L, g, { mul: 1, badRelease: true });
      const share = Math.max(0, res.total.success - r.total.success), P = worstBy(list, x => x.peak);
      const byInst = P.strategy === 'canary' ? P.units.find(u => u.type === 'app' && !u.weighted && u.first > STEPS[0] + 1e-9) : null;
      return { ok: share <= max + 1e-9, detail: `при плохом релизе ошибку получают ${pc(share)} запросов (${byInst ? `канарейка по экземплярам: один из ${byInst.N}` : S_NAME[P.strategy]}, заметит ${HOW[P.how][0]} через ≈ ${mins(P.td)})` };
    }),
    badJobs: () => custom('Плохой релиз не теряет фоновые задачи', (g, res, L) => {
      const list = pipesOf(res).filter(P => (P.jobs || []).some(j => j.rate > 0)); if (!list.length) return { ok: false, detail: 'конвейер не выкладывает обработчиков с задачами' };
      const r = SD.sim.run(L, g, { mul: 1, badRelease: true }), lost = r.jobs.lostRate - res.jobs.lostRate;
      const n = list.reduce((s, P) => s + P.jobs.reduce((a, j) => a + j.perIncident, 0), 0), many = SD.fmt ? SD.fmt.num(n) : String(Math.round(n));
      return { ok: lost < 0.01, detail: lost < 0.01 ? `≈ ${many} задач за аварию упадут, но повторятся после отката или лягут в DLQ` : `≈ ${many} задач за аварию теряются: у очереди нет «Повторы + DLQ»` };
    }),
    mttr: max => custom(`Плохой релиз откатывается за ${dec(max)} мин или быстрее (MTTR)`, (g, res) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const P = worstBy(list, x => x.mttr);
      return { ok: P.mttr <= max + 1e-9, detail: `восстановление ≈ ${mins(P.mttr)}: ${P.auto ? 'автооткат' : HOW[P.how][0] + ' ≈ ' + mins(P.td)}${P.mttr > P.td + 1e-9 ? ' + откат ' + mins(P.mttr - P.td) : ''}${P.autoWanted && !P.mon ? ' — автооткату не на что смотреть: нет мониторинга' : ''}` };
    }),
    cfr: max => custom(`Доля неудачных изменений не больше ${pc(max)} (change failure rate)`, (g, res) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const P = worstBy(list, x => x.cfr);
      return { ok: P.cfr <= max + 1e-9, detail: `сейчас ${pc(P.cfr)} — ломается каждый ${nth(P.cfr)}-й релиз (${T_NAME[P.tests]}, релизы ${F_NAME[P.freq]})` };
    }),
    freq: () => custom('Релизы не реже раза в день', (g, res) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const slow = list.filter(P => P.freq === 'week');
      return { ok: !slow.length, detail: slow.length ? `«${slow[0].name}»: раз в неделю — бизнес ждёт новые функции неделями` : 'релизы ' + list.map(P => F_NAME[P.freq]).join(', ') };
    }),
    loss: max => custom(`Потери от неудачных релизов не больше ${usd(max)} в месяц`, (g, res, L) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const per = L.lossPerMin || 0, down = list.reduce((s, P) => s + P.downMonth, 0), bad = list.reduce((s, P) => s + P.bad, 0), v = down * per;
      return { ok: v <= max + 1e-9, detail: `≈ ${cnt(bad, 'авария', 'аварии', 'аварий')} в месяц × ≈ ${mins(bad ? down / bad : 0)} полного простоя × ${usd(per)} в минуту = ${usd(v)}` };
    }),
    downtime: max => custom(`Релизы и их откаты съедают не больше ${dec(max)} мин простоя в месяц`, (g, res) => {
      const list = pipesOf(res); if (!list.length) return noPipe;
      const dep = list.reduce((s, P) => s + P.R * P.deployDown, 0), all = list.reduce((s, P) => s + P.downMonth, 0);
      return { ok: all <= max + 1e-9, detail: `≈ ${mins(all)} в месяц${dep > 0 ? `: выкладки «всё сразу» — ${mins(dep)}, плохие релизы — ${mins(all - dep)}` : ''} (бюджет SLO 99,9 % — 43 мин на всё)` };
    })
  };

  /* ---------- уровни «Эксплуатация»: выкладка ---------- */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const O = o => Object.assign({ tier: 'ops', opsLvl: true, cicdLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL(), features: [] }, o);
  const CD = (props, x = 420, y = 480) => ['cicd', 'cicd', x, y, props, 'Конвейер CI/CD'];
  const PROM = (x = 700, y = 560) => ['prom', 'prometheus', x, y, {}, 'Prometheus'];
  const AM = (x = 940, y = 560) => ['am', 'alertmanager', x, y, { channel: 'phone' }, 'Alertmanager'];

  /* 1. плохой релиз */
  const BAD_E = [['client', 'lb'], ['lb', 'shop'], ['shop', 'cache'], ['shop', 'db'], ['cicd', 'shop']];
  const BAD_N = (cd, extra) => [['lb', 'lb', 220, 250], ['shop', 'app', 420, 250, { count: 4 }, 'Сервис магазина'], ['cache', 'cache', 660, 130, { mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { replicas: 1 }, 'База заказов'],
    CD(Object.assign({ strategy: 'recreate', tests: 'unit', autoRollback: false, freq: 'week' }, cd))].concat(extra || []);
  /* 2. тесты */
  const TST_E = [['client', 'lb'], ['lb', 'orders'], ['orders', 'cache'], ['orders', 'db'], ['orders', 'prom'], ['prom', 'am'], ['cicd', 'orders']];
  const TST_N = cd => [['lb', 'lb', 220, 250], ['orders', 'app', 420, 250, { count: 4 }, 'Сервис заказов'], ['cache', 'cache', 660, 130, { mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { replicas: 1 }, 'База заказов'],
    CD(Object.assign({ strategy: 'rolling', tests: 'none', autoRollback: false, freq: 'day' }, cd)), PROM(), AM()];
  /* 3. релизы каждый день */
  const DAY_E = [['client', 'lb'], ['lb', 'api'], ['api', 'cache'], ['api', 'db'], ['api', 'prom'], ['prom', 'am'], ['cicd', 'api']];
  const DAY_N = cd => [['lb', 'lb', 220, 250], ['api', 'app', 420, 250, { count: 4 }, 'API доставки'], ['cache', 'cache', 660, 130, { mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { replicas: 1 }, 'База доставок'],
    CD(Object.assign({ strategy: 'recreate', tests: 'unit', autoRollback: false, freq: 'week' }, cd)), PROM(), AM()];

  const LEVELS = [
    O({
      id: 'o-cicd-bad', title: 'Плохой релиз уронил всё', pattern: 'canary',
      chips: ['CI/CD', 'канарейка', 'автооткат'],
      story: 'Новое блюдо в ресторане сначала дают попробовать одному столику, а не всему залу: невкусно — расстроится один стол, а не сто. В выкладке это называется канареечным релизом. Интернет-магазин выкладывает новые версии «всё сразу»: конвейер CI/CD останавливает все экземпляры и запускает новые. В пятницу вечером новая версия сломала оформление заказа — полчаса ошибку видели все покупатели, пока поддержка не забила тревогу. Сделай так, чтобы плохой релиз задевал горстку покупателей и откатывался сам за минуту-две.',
      traffic: { read: 5000, write: 500 }, hotSetGb: 8,
      start: { nodes: BAD_N({}), edges: BAD_E },
      goals: [{ t: 'success', min: 0.999 }, goals.deployed(), goals.badShare(0.1), goals.mttr(2), { t: 'cost', max: 2400 }],
      hints: [
        { text: 'Нажми на «Конвейер CI/CD» → «Стратегия выкладки»: канарейка 5 %.', why: 'Как новое блюдо одному столику из двадцати: новая версия сначала получает 5 % запросов. Плохую версию увидит каждый двадцатый покупатель, а не все. «Всё сразу» — подать новое блюдо всему залу разом.' },
        { text: 'Включи «Автооткат по метрикам» и поставь мониторинг: Prometheus из палитры «Наблюдаемость», стрелка от сервиса к нему.', why: 'Как дегустатор, который сам снимает блюдо с меню. Автооткат сравнивает ошибки новой версии со старой и возвращает старую за ≈ 1 минуту. Без метрик ему не на что смотреть — откатывать будет человек, когда заметит.' },
        { text: 'Blue-green и rolling здесь не спасут — сравни их в «?» у стратегии.', why: 'Blue-green откатывается за секунду, но до отката плохую версию видят все 100 % покупателей. Rolling меняет экземпляры по одному: пока автомат заметит ошибки, плохих уже ≈ 20 %, и откат идёт тем же порядком.' }
      ],
      solution: { nodes: BAD_N({ strategy: 'canary', autoRollback: true }, [PROM()]), edges: BAD_E.concat([['shop', 'prom']]),
        note: 'Канарейка: новая версия сначала получает 5 % запросов. Prometheus снимает метрики, автооткат за ≈ 1 минуту видит, что у новой версии ошибок больше, и убирает её. Плохой релиз задел 5 % запросов на минуту вместо всех на полчаса.' }
    }),
    O({
      id: 'o-cicd-tests', title: 'Тесты дешевле аварий', pattern: 'failfast',
      chips: ['автотесты', 'change failure rate', 'DORA'],
      story: 'Повар пробует суп перед подачей: ложка — это секунда, а вылитая кастрюля и недовольный зал — дорого. Автотесты — такая ложка для кода: конвейер прогоняет их перед каждой выкладкой и не пускает в прод сборку, которая их не прошла. Сервис заказов выкладывается каждый день, автотестов нет — ломается каждый 4-й релиз (доля неудачных изменений 25 %). Алерты будят дежурного, откат вручную: каждая авария — ≈ 10 минут ошибок и $1 500 потерь, плюс полдня команды на разбор. Сократи аварии, не замедляя релизы.',
      traffic: { read: 5000, write: 500 }, hotSetGb: 8, lossPerMin: 300,
      start: { nodes: TST_N({}), edges: TST_E },
      goals: [{ t: 'success', min: 0.999 }, goals.freq(), goals.cfr(0.1), goals.loss(2000), { t: 'cost', max: 2500 }],
      hints: [
        { text: 'Нажми на «Конвейер CI/CD» → «Автотесты перед выкладкой»: юнит + интеграционные.', why: 'Как попробовать и каждый ингредиент, и готовое блюдо. Юнит-тесты проверяют функции по отдельности и ловят ≈ половину багов. Интеграционные запускают сервис с настоящей базой на тестовом стенде и ловят ошибки на стыках — вместе ≈ 4 из 5. Ломался каждый 4-й релиз — станет каждый 20-й.' },
        { text: 'Посчитай: юнит + интеграционные стоят ≈ $160 в месяц сверх нынешнего, а каждая авария — $1 500.', why: 'Тестовый стенд и прогоны — это деньги, но 5 аварий в месяц — $7 500 потерь и пять разборов. Тесты окупаются с первой же пойманной ошибки.' },
        { text: 'Реже выкладывать — не выход.', why: 'Недельный релиз больше: в нём копится больше изменений, и ломается он чаще. Бизнес ждёт новые функции каждый день.' }
      ],
      solution: { nodes: TST_N({ tests: 'int' }), edges: TST_E,
        note: 'Юнит + интеграционные тесты ловят 4 из 5 багов: неудачных релизов 5 % вместо 25 % — одна авария в месяц вместо пяти. Тесты стоят ≈ $160 в месяц, а экономят ≈ $6 000.' }
    }),
    O({
      id: 'o-cicd-daily', title: 'Релизы каждый день без страха', pattern: 'featureflags',
      chips: ['частые релизы', 'MTTR', 'бюджет ошибок'],
      story: 'Пирожки из маленькой печи можно печь весь день и сразу пробовать — подгорит один противень, а не весь банкет. С релизами так же: маленькие и частые безопаснее больших и редких, если выкладка не останавливает сервис, а плохая версия откатывается сама. Сейчас команда выкладывает раз в неделю большой релиз «всё сразу»: каждая выкладка — простой, ломается каждый 7-й релиз, откатывают вручную. Бизнес хочет новые функции каждый день, а бюджет ошибок (SLO 99,9 %) — 43 минуты простоя в месяц на всё. Сделай релизы ежедневными и спокойными.',
      traffic: { read: 6000, write: 600 }, hotSetGb: 8,
      start: { nodes: DAY_N({}), edges: DAY_E },
      goals: [{ t: 'success', min: 0.999 }, goals.freq(), goals.downtime(5), goals.mttr(3), goals.cfr(0.1), { t: 'cost', max: 2400 }],
      hints: [
        { text: 'Нажми на «Конвейер CI/CD»: «Частота релизов» — каждый день, «Стратегия» — канарейка, «Автооткат по метрикам» — включить.', why: 'Как печь маленькими противнями: «всё сразу» при ежедневных релизах — 20 простоев в месяц по ≈ 30 секунд, и каждый плохой релиз видят все. Канарейка выкладывает без простоя, а плохую версию автомат снимает за минуту, пока её видят 5 % запросов.' },
        { text: 'Неудачных изменений должно быть не больше 10 %: при ежедневных релизах нужны юнит + интеграционные тесты.', why: 'С одними юнит-тестами ломается каждый 8-й ежедневный релиз (12,5 %). Другой путь — релизы много раз в день: они мельче, и юнит-тестов хватает (≈ 9 %).' },
        { text: 'Blue-green тоже откатывается за секунду, но смотри на бюджет простоя.', why: 'До отката плохую версию blue-green видят все запросы, ≈ 1 минуту. При частых релизах эти минуты складываются — спасают только строгие тесты.' }
      ],
      solution: { nodes: DAY_N({ strategy: 'canary', autoRollback: true, freq: 'day', tests: 'int' }), edges: DAY_E,
        note: 'Релизы каждый день, канарейка с автооткатом и юнит + интеграционные тесты. Выкладка без простоя, ломается каждый 20-й релиз, а плохую версию автомат снимает за минуту, пока её видят 5 % запросов: релизы почти не тратят бюджет ошибок.' }
    })
  ];
  if (SD.OPSL) LEVELS.forEach(L => { if (!SD.OPSL.some(x => x.id === L.id)) SD.OPSL.push(L); });

  /* ---------- интерфейс: всё ниже работает только в браузере ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cfrCls = v => v <= 0.05 ? 'ok' : v <= 0.15 ? 'warn' : 'bad';
  const mttrCls = v => v <= 3 ? 'ok' : v <= 15 ? 'warn' : 'bad';
  const labCta = () => `<button type="button" class="dive-cta" data-cicdlab="1">${SD.icon('cicd')}<span><b>Посмотреть вживую: «Выкладка вживую»</b><small>Те же стратегии на 10 подах под живым трафиком: всё сразу, rolling, blue-green, канарейка и флаги</small></span></button>`;

  /* инспектор: у конвейера вместо «загрузки» — метрики DORA; у стрелки «разворачивает» — что по ней идёт */
  function patchInspector(A) {
    const pane = document.getElementById('paneNode'); if (!pane || !A || !A.sel) return;
    const g = A.graph;
    if (A.sel.type === 'edge') {
      const e = g.edges.find(x => x.id === A.sel.id); if (!e) return;
      const a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
      if (!a || !b || (a.type !== 'cicd' && b.type !== 'cicd')) return;
      const other = a.type === 'cicd' ? b : a, ok = a.type === 'cicd' && (SVC.has(b.type) || b.type === 'k8s');
      const sm = pane.querySelector('.insp-head small'); if (sm) sm.textContent = (ok ? 'разворачивает новые версии' : 'стрелка развёрнута не туда') + ' · трафик пользователей сюда не идёт';
      const an = pane.querySelector('.simple .an');
      if (an) an.textContent = !ok ? `Конвейер разворачивает сервис, поэтому стрелка нужна от конвейера к «${lbl(other)}», а не наоборот.`
        : b.type === 'k8s' ? 'Конвейер собирает новые версии, прогоняет тесты и отдаёт их Kubernetes, а тот выкладывает поды всех своих сервисов по выбранной стратегии.'
        : `Конвейер собирает новую версию «${lbl(other)}», прогоняет автотесты и выкладывает её по выбранной стратегии. По этой стрелке идут релизы, а не запросы.`;
      return;
    }
    const n = g.nodes.find(x => x.id === A.sel.id); if (!n || n.type !== 'cicd') return;
    const C = A.res && A.res.cicd, P = C && C.pipes.find(x => x.id === n.id), r = A.res && A.res.nodes[n.id];
    const h3 = [...pane.querySelectorAll('h3')].find(x => x.textContent === 'Сейчас'), dl = h3 && h3.nextElementSibling;
    if (!h3 || !dl || !dl.classList.contains('kv') || !P) return;
    h3.textContent = 'Сейчас: метрики DORA';
    const rows = !P.svc.length ? [['Выкладывает', 'ничего — проведи стрелку к сервису', 'warn']] : [
      ['Выкладывает', esc(P.svcNames.join(', '))],
      ['Частота выкладок', `${F_NAME[P.freq]} · ${P.R}/мес`, P.freq === 'week' ? 'warn' : 'ok'],
      ['Неудачных изменений', `${pc(P.cfr)} · каждый ${nth(P.cfr)}-й`, cfrCls(P.cfr)],
      ['Плохой релиз заметит', `${HOW[P.how][0]} · ≈ ${mins(P.td)}`, P.auto ? 'ok' : P.how === 'alerts' ? 'warn' : 'bad'],
      ['Восстановление (MTTR)', '≈ ' + mins(P.mttr), mttrCls(P.mttr)],
      ['Плохую версию видят', pc(P.peak) + ' запросов', P.peak <= 0.1 ? 'ok' : P.peak < 1 ? 'warn' : 'bad'],
      ['Простой от релизов', `≈ ${mins(P.downMonth)} в месяц`, P.downMonth <= 5 ? 'ok' : P.downMonth <= 20 ? 'warn' : 'bad'],
      ['От коммита до прода', P.lead]
    ];
    if (P.svc.length && P.strategy === 'canary') {
      const u = P.units.find(x => x.type === 'app' && !x.weighted && x.first > STEPS[0] + 1e-9);
      rows.splice(6, 0, ['Канарейка делит', u ? `по экземплярам: 1 из ${u.N} — ${pc(u.first)}` : 'по весам: 5 % запросов', u ? (u.first >= 0.25 ? 'bad' : 'warn') : 'ok']);
    }
    (P.jobs || []).filter(j => j.rate > 0).forEach(j => rows.push([`Задачи «${esc(j.name)}» за аварию`, `≈ ${SD.fmt ? SD.fmt.num(j.perIncident) : Math.round(j.perIncident)} ${j.retries ? '— повторы и DLQ' : '— теряются'}`, j.retries ? 'ok' : 'bad']));
    if (P.svc.length) rows.push(['Во время выкладки', { recreate: ['простой ≈ 30 с', 'bad'], rolling: [`+${P.extraInst || 1} сервер на ≈ ${ROLL_MIN} мин`, ''], canary: [`+${P.extraInst || 1} сервер на ≈ ${STEP_MIN * (STEPS.length - 1)} мин`, ''], bg: [`×2 серверов на ≈ ${BG_WIN} мин`, 'warn'] }[P.strategy][0], { recreate: 'bad', bg: 'warn' }[P.strategy] || '']);
    if (r) rows.push(['Стоимость', usd(r.cost || 0) + ' /мес']);
    dl.innerHTML = rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c || ''}">${v}</dd>`).join('');
    if (SD.labs && !pane.querySelector('[data-cicdlab]')) dl.insertAdjacentHTML('afterend', labCta());
  }
  if (HAS_DOM && SD.inspector && SD.inspector.render) {
    const baseRender = SD.inspector.render;
    SD.inspector.render = function (A) { baseRender.apply(this, arguments); try { patchInspector(A); } catch (e) { /* инспектор как был */ } };
  }

  /* полоса метрик: плитка «Релизы», только если на схеме есть конвейер.
     Плитку держит ensureTile: её зовёт обёртка над SD.panels.metrics (быстрый путь) и наблюдатель за #metrics —
     если полосу перерисовал кто угодно другой, плитка вернётся сама. Повторный вызов ничего не меняет, когда плитка
     уже свежая, поэтому собственные правки наблюдателя не зацикливают. Лишние копии удаляются */
  let mBox = null, mObs = null;
  function watchMetrics(box) {
    if (mBox === box || typeof MutationObserver === 'undefined') return;
    if (mObs) mObs.disconnect();
    mBox = box; mObs = new MutationObserver(() => { try { ensureTile(); } catch (e) { /* без плитки */ } });
    mObs.observe(box, { childList: true });
  }
  function ensureTile(A) {
    const box = document.getElementById('metrics'); if (!box) return;
    watchMetrics(box);
    A = A || (SD.app && SD.app.A);
    const D = A && A.res && A.res.cicd && A.res.cicd.dora, tiles = box.querySelectorAll('.cicd-metric');
    if (!D) { tiles.forEach(t => t.remove()); return; }
    for (let i = 1; i < tiles.length; i++) tiles[i].remove();
    const sig = `${pc(D.cfr)}|${mins(D.mttr)}|${cfrCls(D.cfr)}`;
    let t = tiles[0];
    if (!t) { t = document.createElement('div'); t.className = 'metric cicd-metric'; t.title = 'Метрики DORA: доля неудачных изменений, время восстановления, частота выкладок'; box.appendChild(t); }
    if (t.getAttribute('data-sig') !== sig) { t.setAttribute('data-sig', sig); t.innerHTML = `<small>Релизы</small><b class="${cfrCls(D.cfr)}">${pc(D.cfr)}</b><span>неудачных · MTTR ≈ ${mins(D.mttr)}</span>`; }
  }
  if (HAS_DOM && SD.panels && SD.panels.metrics) {
    const baseMetrics = SD.panels.metrics;
    SD.panels.metrics = function (A) {
      const out = baseMetrics.apply(this, arguments);
      try { ensureTile(A); } catch (e) { /* без плитки */ }
      return out;
    };
  }
  if (HAS_DOM) { const b0 = document.getElementById('metrics'); if (b0) watchMetrics(b0); }

  /* подпись узла на холсте: стратегия и кто откатывает */
  function subOf(n) { const p = n.props || {}; return `${S_NAME[pick(p.strategy, STRATS, 'rolling')]} · ${p.autoRollback ? 'автооткат' : 'откат вручную'}`; }
  let obs = null;
  function fixSubs() {
    const gN = document.getElementById('nodesG'), gr = SD.editor && SD.editor.getGraph && SD.editor.getGraph();
    if (!gN || !gr) return;
    gr.nodes.forEach(n => {
      if (n.type !== 'cicd') return;
      const t = gN.querySelector(`.node[data-id="${n.id}"] text.sub`);
      if (t && t.textContent !== subOf(n)) t.textContent = subOf(n);
    });
  }
  if (HAS_DOM && SD.editor && SD.editor.render) {
    const baseEdRender = SD.editor.render;
    SD.editor.render = function () {
      const out = baseEdRender.apply(this, arguments);
      try {
        const gN = document.getElementById('nodesG');
        if (gN && !obs && typeof MutationObserver !== 'undefined') { obs = new MutationObserver(fixSubs); obs.observe(gN, { childList: true }); }
        fixSubs();
        ensureTile();   // на случай, если #metrics заменили целиком: наблюдатель переедет на новый элемент
      } catch (e) { /* подпись по умолчанию */ }
      return out;
    };
  }

  /* справка «?»: в обычный день стратегия, тесты и автооткат почти не меняют цифры — показываем, что меняется,
     когда релиз плохой, и за месяц. Блок живёт внутри #gdCmpWrap: виден после «угадай», как и основное сравнение */
  let guideNode = null, gObs = null;
  function cicdGuide() {
    const m = document.getElementById('guideModal'), main = document.getElementById('gdMain');
    if (!m || m.hidden || !main || !guideNode || !SD.app || !SD.app.A) return;
    const A = SD.app.A, n = A.graph.nodes.find(x => x.id === guideNode);
    if (!n || n.type !== 'cicd') return;
    const wrap = document.getElementById('gdCmpWrap'), on = document.querySelector('#gdList .lab-item.on[data-gk]');
    const d = on && PROPS.find(p => p.key === on.getAttribute('data-gk'));
    if (!wrap || !d || wrap.querySelector('.cicd-cmp')) return;
    const vals = d.type === 'toggle' ? [false, true] : d.options.map(o => o[0]);
    const name = v => d.type === 'toggle' ? (v ? 'Включено' : 'Выключено') : String((d.options.find(o => o[0] === v) || [v, v])[1]).split(' — ')[0];
    const cur = n.props[d.key];
    const rows = vals.map(v => {
      const g = JSON.parse(JSON.stringify(A.graph)); g.nodes.find(x => x.id === n.id).props[d.key] = v;
      return { v, P: analyze(g).pipes.find(p => p.id === n.id) };
    }).filter(r => r.P);
    if (!rows.length || !rows[0].P.svc.length) return;
    const td = (txt, cls) => `<td class="${cls || ''}">${txt}</td>`;
    let h = `<div class="cicd-cmp"><h3 class="gd-h">Если релиз окажется плохим — и за месяц</h3><p class="note">В обычный день эти варианты почти не отличаются: стратегия, тесты и автооткат работают, когда новая версия сломана. Модель та же, что в целях уровня.</p>`;
    h += `<table class="gd-table"><thead><tr><th>Вариант</th><th>Плохую версию видят</th><th>Восстановление</th><th>Неудачных релизов</th><th>Простой от релизов в месяц</th></tr></thead><tbody>`;
    rows.forEach(({ v, P }) => {
      const isCur = String(v) === String(cur);
      h += `<tr class="${isCur ? 'cur' : ''}">${td(esc(name(v)) + (isCur ? '<small>сейчас</small>' : ''))}${td(pc(P.peak), P.peak <= 0.1 ? 'ok' : P.peak < 1 ? 'warn' : 'bad')}${td('≈ ' + mins(P.mttr) + (P.auto ? ' · автооткат' : ''), mttrCls(P.mttr))}${td(`${pc(P.cfr)} · каждый ${nth(P.cfr)}-й`, cfrCls(P.cfr))}${td('≈ ' + mins(P.downMonth), P.downMonth <= 5 ? 'ok' : P.downMonth <= 20 ? 'warn' : 'bad')}</tr>`;
    });
    h += `</tbody></table>`;
    if (d.key === 'autoRollback' && !rows[0].P.mon) h += `<p class="note">Автооткату не на что смотреть: на схеме нет мониторинга (Prometheus или Alertmanager), поэтому «включено» и «выключено» сейчас одинаковы.</p>`;
    const can = rows.map(r => r.P).find(P => P.strategy === 'canary'), byInst = can && can.units.find(u => u.type === 'app' && !u.weighted && u.first > STEPS[0] + 1e-9);
    if (byInst) h += `<p class="note">Канарейка здесь — по экземплярам: ${byInst.l4 ? `балансировщик «${esc(byInst.l4)}» на L4 не делит запросы по весам` : `перед «${esc(byInst.name)}» нет балансировщика L7 или API Gateway`}, и один новый экземпляр из ${byInst.N} получает ${byInst.N === 2 ? 'половину' : pc(byInst.first)} трафика. Нужна канарейка по доле запросов через балансировщик L7 или шлюз — или больше экземпляров.</p>`;
    wrap.insertAdjacentHTML('beforeend', h + '</div>');
  }
  if (HAS_DOM && SD.guide && SD.guide.open) {
    const baseOpen = SD.guide.open, baseOpenEdge = SD.guide.openEdge;
    SD.guide.open = function (id) {
      guideNode = id;
      const out = baseOpen.apply(this, arguments);
      try {
        const main = document.getElementById('gdMain');
        if (main && !gObs && typeof MutationObserver !== 'undefined') { gObs = new MutationObserver(() => { try { cicdGuide(); } catch (e) { /* справка как была */ } }); gObs.observe(main, { childList: true }); }
        cicdGuide();
      } catch (e) { /* справка как была */ }
      return out;
    };
    if (baseOpenEdge) SD.guide.openEdge = function () { guideNode = null; return baseOpenEdge.apply(this, arguments); };
  }

  /* задание уровня: вместо «загляни внутрь» — лаборатория «Выкладка вживую» */
  if (SD.opsTaskCta) {
    const baseCta = SD.opsTaskCta;
    SD.opsTaskCta = L => {
      if (!L || !L.cicdLvl) return baseCta(L);
      const has = SD.app && SD.app.A && SD.app.A.graph && SD.app.A.graph.nodes.some(n => n.type === 'cicd');
      return (has ? '' : `<div class="ops-cta-wait">${SD.icon('cicd')}<span>Поставь «Конвейер CI/CD» на площадку из палитры («Инструменты эксплуатации» → «Платформа») и проведи стрелку к сервису.</span></div>`) + (SD.labs ? labCta() : '');
    };
  }
  if (HAS_DOM) document.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('[data-cicdlab]');
    if (!b || !SD.labs || !SD.labs.open) return;
    const p = SD.labs.open('deploy');   // лаборатория грузится по требованию (labs-lazy.js): open возвращает Promise
    if (p && typeof p.catch === 'function') p.catch(() => { /* не загрузилась — окно лабораторий само скажет */ });
  });

  SD.cicd = { analyze, incident, dora, goals, advice: cicdAdvice, levels: LEVELS, consts: { PER_MONTH, SIZE, BUG, CATCH, DETECT, DOWN_RC, ROLL_MIN, STEPS, STEP_MIN, BG_WIN, COST } };
})();
