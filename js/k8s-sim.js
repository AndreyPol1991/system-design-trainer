/* Kubernetes в симуляторе: лимит памяти, запрос CPU, проба готовности и правила выкладки у сервисов и обработчиков,
   которые разворачивает Kubernetes (стрелка Kubernetes → сервис), и автодобавление серверов у самого кластера.
   Что моделируем — просто и честно:
   1. Память пода = 200 МБ на запуск + растёт с нагрузкой на под. Пробил лимит — OOMKilled, перезапуск по кругу (CrashLoopBackOff).
   2. Планировщик раскладывает поды по серверам (4 ядра и 16 ГБ каждый) по их брони — запросу CPU и лимиту памяти —
      туда, где свободнее всего. Не влез — Pending.
   3. Под тратит ядер по нагрузке. Тратят больше, чем есть на серверах, — делят остаток, медленнее работают (CPU throttling).
   4. Без readiness-пробы трафик идёт в поды, которые ещё стартуют (рост нагрузки, выкладка, переезд), — эти запросы падают.
   5. Упавший под Kubernetes поднимает сам за ≈ 1 минуту: проверка «пережить падение» мягче, чем у ручного запуска.
   6. Серверов под бронь нужно: бронь всех подов / (4 ядра, 16 ГБ) с запасом 20 %. Автодобавление (Cluster Autoscaler)
      держит столько, от минимума до максимума, и платишь за них; новый сервер поднимается ≈ 2–3 мин — в пик поды его ждут.
   7. Выкладка (opts.k8sRollout): maxSurge — сколько новых подов поднять сверх нужного, maxUnavailable — сколько старых
      погасить сразу. Обслуживание сервера (opts.k8sDrain): с него выселяют поды; PodDisruptionBudget — по одному.
      Это механика стратегии Rolling внутри Kubernetes; стратегии и «плохой релиз» конвейера — в js/cicd-sim.js.
   Сервисы без Kubernetes и кластеры с настройками по умолчанию считаются как раньше. Уровни — в трек «Эксплуатация» (SD.OPSL). */
(function () {
  const T = SD.TYPES;
  const HAS_DOM = typeof document !== 'undefined';
  const NODE_CORES = 4, NODE_MB = 16384;  // сервер кластера: 4 ядра и 16 ГБ
  const BASE_MB = 200;                    // память пода на старте: код, рантайм, библиотеки
  const MB_PER_RPS = 0.2;                 // сервис: +20 МБ на каждые 100 запросов в секунду на под
  const WORKER_FULL_MB = 600;             // обработчик под полной нагрузкой: +600 МБ к стартовым
  const SPREAD = 0.25;                    // нагрузка по подам неровная: ±25 % от средней
  const OOM_LOSS = 0.1;                   // доля трафика падающих подов, которая обрывается при перезапуске
  const RESTART_SHARE = 0.1;              // с пробами упавший под в строю через ≈ 1 мин из 10-минутного окна проверки
  const FILL = 0.8;                       // серверов держат с запасом: бронь занимает не больше 80 % их ядер и памяти
  const CA_SLOW = 2.5;                    // новый сервер поднимается ≈ 2–3 мин — в 2,5 раза дольше нового пода
  const VCPU = { s: 1, m: 2, l: 4, xl: 8 };
  const REQS = [0.25, 0.5, 1, 2];
  const DEF = { memLimit: 1024, cpuReq: 1, maxSurge: 0.25, maxUnavailable: 0.25, caMin: 2, caMax: 12 };
  const SVC = new Set(['app', 'worker']);
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const lbl = n => n.label || (T[n.type] ? T[n.type].name : n.type);
  const num = (v, d) => { const x = +v; return isFinite(x) && x > 0 ? x : d; };
  const num0 = (v, d) => { const x = +v; return isFinite(x) && x >= 0 ? x : d; };
  const dec = (v, k) => (Math.round(v * Math.pow(10, k == null ? 1 : k)) / Math.pow(10, k == null ? 1 : k)).toString().replace('.', ',');
  const plural = (v, a, b, c) => { const x = Math.abs(Math.round(v)) % 100, y = x % 10; return x > 10 && x < 20 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };
  const cores = v => { const r = Math.round(v * 10) / 10, d = dec(v, v < 1 ? 2 : 1); if (r !== Math.round(r)) return d + ' ядра'; return d + ' ' + plural(r, 'ядро', 'ядра', 'ядер'); };
  const podsOf = k => { const a = Math.abs(k) % 100; return a % 10 === 1 && a !== 11 ? 'пода' : 'подов'; };
  const pods = k => plural(k, 'под', 'пода', 'подов');
  const servW = k => `${dec(k, 1)} ${Math.abs(k - Math.round(k)) > 0.05 ? 'сервера' : plural(k, 'сервер', 'сервера', 'серверов')}`;
  const usd = v => SD.fmt ? SD.fmt.usd(v) : '$' + Math.round(v);
  const pct = v => Math.round(v * 100) + ' %';
  const k8sOn = L => !!(L && (L.sandbox || (L.features || []).includes('k8s')));

  /* ---------- настройки узлов ---------- */
  const PROPS = [
    { key: 'memLimit', label: 'Лимит памяти пода', type: 'select', def: DEF.memLimit, feature: 'k8s',
      options: [[256, '256 МБ'], [512, '512 МБ'], [1024, '1 ГБ'], [2048, '2 ГБ']],
      help: 'Потолок памяти одной копии в Kubernetes. Память пода растёт с нагрузкой: ≈ 200 МБ на запуск и ≈ 20 МБ на каждые 100 запросов в секунду. Пробьёт потолок — под убивают (OOMKilled) и запускают заново. Лимит — это ещё и бронь памяти на сервере.' },
    { key: 'cpuReq', label: 'Запрос CPU пода (requests)', type: 'select', def: DEF.cpuReq, feature: 'k8s',
      options: [[0.25, '0,25 ядра'], [0.5, '0,5 ядра'], [1, '1 ядро'], [2, '2 ядра']],
      help: 'Сколько ядер планировщик бронирует поду на сервере (сервер — 4 ядра). Бронь больше реального расхода — место кончается, новые поды ждут (Pending), а за серверы под пустую бронь платишь. Меньше расхода — поды набиваются плотнее, чем серверы вытянут, и в пик отнимают ядра друг у друга.' },
    tog('readiness', 'Проба готовности (readiness)', true, 'Под получает трафик, только когда сам ответил «готов». Без пробы новые поды при масштабировании, выкладке и переезде получают запросы ещё на старте — эти запросы падают.', { feature: 'k8s' }),
    { key: 'maxSurge', label: 'Выкладка: новых подов сверх нужного (maxSurge)', type: 'select', def: DEF.maxSurge, feature: 'k8s',
      options: [[0, '0 — лишних подов не поднимать'], [0.25, '25 % — по умолчанию'], [1, '100 % — сразу полный новый комплект']],
      help: 'Сколько подов новой версии Kubernetes поднимает сверх нужного числа, пока старые ещё работают. Им нужно свободное место на серверах. Это механика стратегии Rolling внутри Kubernetes.' },
    { key: 'maxUnavailable', label: 'Выкладка: можно погасить сразу (maxUnavailable)', type: 'select', def: DEF.maxUnavailable, feature: 'k8s',
      options: [[0, '0 — ни одного пода меньше нужного'], [0.25, '25 % — по умолчанию'], [1, '100 % — погасить все разом']],
      help: 'Сколько старых подов можно погасить, не дожидаясь, пока новые станут готовы. 100 % — то же, что выкладка «всё сразу» в конвейере CI/CD: на время старта новых подов сервис пуст.' },
    tog('pdb', 'PodDisruptionBudget: выселять по одному', false, 'Когда сервер обслуживают или автодобавление его убирает, Kubernetes выселяет с него поды. С бюджетом — не больше одного пода сервиса за раз и только когда замена готова. Без бюджета — все поды с сервера разом.', { feature: 'k8s' })
  ];
  ['app', 'worker'].forEach(t => {
    if (!T[t]) return;
    PROPS.forEach(p => { if (!(T[t].props || []).some(x => x.key === p.key)) T[t].props = (T[t].props || []).concat([Object.assign({}, p)]); });
  });
  const CA_PROPS = [
    tog('ca', 'Автодобавление серверов (Cluster Autoscaler)', false, 'Поды ждут места (Pending) — кластер сам добавляет сервер, ≈ 2–3 минуты. Бронь стала меньше — убирает лишний. Серверов столько, сколько нужно под бронь подов с запасом 20 %, от минимума до максимума, и платишь за них.', { feature: 'k8s' }),
    { key: 'caMin', label: 'Серверов не меньше', type: 'range', min: 1, max: 10, def: DEF.caMin, feature: 'k8s', showIf: n => !!n.props.ca, help: 'Сколько серверов кластер держит всегда. Запас на резкий рост: новый сервер поднимается 2–3 минуты, и поды его ждут.' },
    { key: 'caMax', label: 'Серверов не больше', type: 'range', min: 2, max: 30, def: DEF.caMax, feature: 'k8s', showIf: n => !!n.props.ca, help: 'Потолок, чтобы ошибка в настройках не раздула счёт. Упрётся в потолок — поды останутся в Pending.' }
  ];
  if (T.k8s) {
    (T.k8s.props || []).forEach(p => {
      if (p.key === 'nodes' && !/4 ядра/.test(p.help || '')) p.help = (p.help || '') + ' Каждый сервер — 4 ядра и 16 ГБ: поды раскладываются по их брони (запрос CPU и лимит памяти).';
      if (p.key === 'nodes' && !p.showIf) p.showIf = n => !(n.props && n.props.ca);
    });
    CA_PROPS.forEach(p => { if (!(T.k8s.props || []).some(x => x.key === p.key)) T.k8s.props = (T.k8s.props || []).concat([p]); });
  }
  if (SD.PROP_SIMPLE) {
    ['app', 'worker'].forEach(t => {
      const o = SD.PROP_SIMPLE[t] = SD.PROP_SIMPLE[t] || {};
      o.memLimit = 'Как рюкзак: вещей больше, чем он вмещает, — молния рвётся. У пода в Kubernetes есть потолок памяти. Под набирает память с нагрузкой и, пробив потолок, падает (OOMKilled); его перезапускают, он снова набирает — и снова падает (CrashLoopBackOff).';
      o.cpuReq = 'Как бронь столиков в ресторане. Столик на шестерых для двоих — зал «полон», гости ждут у входа (Pending), а за пустые стулья ресторан всё равно платит аренду. Столик на двоих для четверых — сядут, но в час пик стулья отберут: так поды с заниженным запросом отнимают ядра друг у друга.';
      o.readiness = 'Новичка не ставят на кассу, пока он не прошёл инструктаж. Readiness-проба — такой инструктаж: пока под не ответил «готов», Kubernetes не шлёт ему запросы. Без пробы под получает запросы, пока ещё запускается, и отвечает ошибками.';
      o.maxSurge = 'Смена караула: сначала новый часовой встаёт рядом со старым, и только потом старый уходит. maxSurge — сколько новых часовых может стоять на посту сверх нужного числа. Им нужно место: свободные ядра и память на серверах.';
      o.maxUnavailable = 'Смена караула: сколько старых часовых можно отпустить, не дожидаясь, пока новые займут пост. 0 — пост ни минуты не пустует. 100 % — все уходят разом, и пока новые переодеваются, пост пуст: это выкладка «всё сразу».';
      o.pdb = 'Ремонт в общежитии: комендант переселяет жильцов из ремонтируемой комнаты по одному, и следующего — только когда предыдущий устроился на новом месте. Без правила выселяют всех разом. PodDisruptionBudget — такое правило для подов, когда сервер обслуживают или убирают.';
    });
    const k = SD.PROP_SIMPLE.k8s = SD.PROP_SIMPLE.k8s || {};
    k.ca = 'Склад, который сам арендует ещё один отсек, когда товар не помещается, и сдаёт пустой отсек обратно. Отсек открывают 2–3 минуты. Cluster Autoscaler так же добавляет и убирает серверы по брони подов — и платишь ты за то, что бронируешь, а не за то, что тратишь.';
    k.caMin = 'Сколько отсеков склад держит всегда, даже ночью. Запас на резкий наплыв: новый отсек открывается не мгновенно.';
    k.caMax = 'Сколько отсеков склад может арендовать самое большее. Защита от счёта, раздутого ошибкой в брони.';
  }
  if (SD.OPT_SIMPLE) {
    ['app', 'worker'].forEach(t => {
      SD.OPT_SIMPLE[t + '.memLimit'] = { 256: '256 МБ: хватит только почти без нагрузки — под падает уже на паре сотен запросов в секунду.', 512: '512 МБ: около тысячи запросов в секунду на под, у самых нагруженных подов — меньше.', 1024: '1 ГБ: обычный запас для пода на 2 ядра под полной нагрузкой.', 2048: '2 ГБ: с большим запасом, но и бронь на сервере больше — меньше подов поместится.' };
      SD.OPT_SIMPLE[t + '.cpuReq'] = { 0.25: '0,25 ядра: на сервер влезет 16 подов, но если каждый тратит больше, в пик они будут драться за ядра.', 0.5: '0,5 ядра: 8 подов на сервер.', 1: '1 ядро: 4 пода на сервер — честно для пода, который тратит около ядра.', 2: '2 ядра: всего 2 пода на сервер. Если под тратит меньше, бронь пустует: новые поды ждут места, а серверы под пустую бронь стоят денег.' };
      SD.OPT_SIMPLE[t + '.readiness'] = { true: 'Проба есть: трафик идёт только в готовые поды.', false: 'Пробы нет: под получает запросы, пока ещё запускается.' };
      SD.OPT_SIMPLE[t + '.maxSurge'] = { 0: 'Лишних подов не поднимает: место на серверах не нужно, но тогда выкладке придётся гасить старые поды раньше, чем готовы новые.', 0.25: 'Четверть подов новой версии сверх нужного: немного места на серверах — и замена без провала.', 1: 'Сразу полный комплект новой версии: выкладка быстрая, но на время выкладки нужно вдвое больше места.' };
      SD.OPT_SIMPLE[t + '.maxUnavailable'] = { 0: 'Ни одного пода меньше нужного: старый гаснет, только когда новый готов. Нужно место под новые поды (maxSurge).', 0.25: 'Четверть подов гаснет сразу: на время выкладки сервису должно хватать трёх четвертей мощности.', 1: 'Все старые поды гаснут разом: пока новые стартуют, отвечать некому — как «всё сразу» в конвейере.' };
      SD.OPT_SIMPLE[t + '.pdb'] = { true: 'При обслуживании сервера поды сервиса выселяют по одному.', false: 'При обслуживании сервера все поды сервиса с него выселяют разом.' };
    });
    SD.OPT_SIMPLE['k8s.ca'] = { true: 'Серверов столько, сколько нужно под бронь подов: завышенная бронь — больше серверов и счёт.', false: 'Серверов столько, сколько задано руками: не хватит — поды ждут, лишние — простаивают за деньги.' };
  }

  /* ---------- модель ---------- */
  const H0 = () => SD.sim.internals;
  const vcpuOf = n => n.type === 'app' ? (VCPU[n.props.size || 'm'] || 2) : 1;
  function perPod(ctx, n) {
    if (n.type === 'app') return T.app.perCap * (SD.SIZE_F[n.props.size] || 1);
    const j = ctx.level.job || { ms: 100, conc: 20 };
    const bf = j.target === 'external' || j.cpu ? 1 : ({ 1: 1, 10: 1.6, 100: 2.2 }[n.props.batch || 1] || 1);
    return j.conc * 1000 / j.ms * bf;
  }
  /* сколько подов реально получает работу по устройству схемы: без балансировщика — один, у Kafka — не больше партиций */
  function structural(ctx, n, x, H) {
    if (n.type === 'app' && x > 1 && H.parents(ctx, n.id).some(p => p.type === 'client')) return 1;
    if (n.type === 'worker') {
      const qs = H.parents(ctx, n.id).filter(p => p.type === 'queue' && H.ENG(p).parallel === 'partitions');
      if (qs.length) return Math.min(x, qs.reduce((s, q) => s + q.props.partitions, 0));
    }
    return x;
  }
  function lbImb(ctx, n, used, H) {
    let f = 1;
    H.parents(ctx, n.id).forEach(p => {
      if (p.type !== 'lb') return;
      let g = used > 1 ? ((SD.LB_IMB || {})[p.props.algo] || 1.06) : 1;
      if (p.props.sticky) g *= 1.2;
      if (n.type === 'app' && (p.props.algo === 'rr' || p.props.algo === 'random' || p.props.algo === 'hash')) {
        const sibs = H.kids(ctx, p.id).filter(k => k.type === 'app');
        const sizes = new Set(sibs.map(k => k.props.size || 'm'));
        if (sizes.size > 1) { const fN = SD.SIZE_F[n.props.size || 'm']; const avg = sibs.reduce((s, k) => s + SD.SIZE_F[k.props.size || 'm'], 0) / sibs.length; g *= Math.max(1, avg / fN); }
      }
      f = Math.max(f, g);
    });
    return f;
  }
  /* сколько серверов нужно под бронь: ядра и память всех подов, с запасом */
  function serversFor(items) {
    const cpu = items.reduce((s, x) => s + x.k * x.S.req, 0), mem = items.reduce((s, x) => s + x.k * x.S.lim, 0);
    return Math.max(1, Math.ceil(Math.max(cpu / NODE_CORES, mem / NODE_MB) / FILL - 1e-9));
  }
  /* цена кластера с заданным числом серверов — по тарифу узла Kubernetes */
  const clusterCost = (n, servers) => T.k8s.cost(Object.assign({}, n, { props: Object.assign({}, n.props, { nodes: servers }) }));
  const perServer = n => clusterCost(n, 2) - clusterCost(n, 1);
  /* планировщик: по очереди по сервисам, каждому поду — сервер, где свободнее всего и хватает брони ядер и памяти */
  function place(cl, servers) {
    const free = Array.from({ length: servers }, () => ({ cpu: NODE_CORES, mem: NODE_MB, by: {} }));
    const put = S => {
      let best = null;
      for (const f of free) if (f.cpu + 1e-9 >= S.req && f.mem >= S.lim && (!best || f.cpu > best.cpu + 1e-9 || (Math.abs(f.cpu - best.cpu) < 1e-9 && f.mem > best.mem))) best = f;
      if (!best) return false;
      best.cpu -= S.req; best.mem -= S.lim; best.by[S.id] = (best.by[S.id] || 0) + 1;
      return true;
    };
    cl.list.forEach(S => { S.sched = 0; S.surgeSched = 0; });
    const maxP = Math.max(...cl.list.map(S => S.P));
    for (let i = 0; i < maxP; i++) cl.list.forEach(S => { if (i < S.P && put(S)) S.sched++; });
    const maxS = Math.max(0, ...cl.list.map(S => S.surge));
    for (let i = 0; i < maxS; i++) cl.list.forEach(S => { if (i < S.surge && put(S)) S.surgeSched++; });
    cl.list.forEach(S => { S.pending = S.P - S.sched; });
    cl.free = free; cl.servers = servers;
    return put;
  }

  /* до трафика: кто в кластере, сколько подов хочет, сколько серверов и кто поместился */
  function prepare(ctx) {
    const H = H0(), o = ctx.opts;
    const K = { svc: new Map(), clusters: [], done: false };
    ctx.k8s = K;
    const ramp = +o.k8sRamp || 0, mul = +o.mul || 1;
    for (const c of ctx.nodes.values()) {
      if (c.type !== 'k8s') continue;
      const list = H.kids(ctx, c.id).filter(n => SVC.has(n.type) && !K.svc.has(n.id));
      if (!list.length) continue;
      const cp = c.props || {};
      const caMin = Math.max(1, Math.round(num(cp.caMin, DEF.caMin))), caMax = Math.max(caMin, Math.round(num(cp.caMax, DEF.caMax)));
      const cl = { id: c.id, n: c, nodes: Math.max(1, Math.round(num(cp.nodes, 3))), probes: cp.probes !== false, ca: !!cp.ca, caMin, caMax, list: [] };
      list.forEach(n => {
        const p = n.props || {};
        const P = Math.max(1, Math.round(H.count(ctx, n)));
        const min = Math.max(1, p.count || 1);
        /* нагрузка растёт, пока новые поды стартуют: готовы только те, что HPA заказал минуту-две назад */
        const Pnow = p.autoscale && ramp > 0 && P > min ? Math.max(min, Math.round(P / (1 + ramp))) : P;
        /* а серверы автодобавление поднимает ещё дольше: они рассчитаны на поды, заказанные 2–3 минуты назад */
        const Pca = p.autoscale && ramp > 0 && P > min ? Math.max(min, Math.round(P / mul), Math.round(P / (1 + ramp * CA_SLOW))) : P;
        const ms = num0(p.maxSurge, DEF.maxSurge), mu = num0(p.maxUnavailable, DEF.maxUnavailable);
        let surge = 0, unav = 0;
        if (o.k8sRollout) { surge = Math.ceil(P * ms - 1e-9); unav = Math.floor(P * mu + 1e-9); if (!surge && !unav) unav = 1; }
        const S = { id: n.id, n, cl, P, Pnow, Pca, min, req: num(p.cpuReq, DEF.cpuReq), lim: num(p.memLimit, DEF.memLimit), vcpu: vcpuOf(n), per: perPod(ctx, n),
          readyProbe: p.readiness !== false && cl.probes, autoscale: !!p.autoscale, pdb: !!p.pdb, maxSurge: ms, maxUnav: mu,
          sched: 0, surge, unav, surgeSched: 0, evict: 0, evictPlaced: 0 };
        cl.list.push(S); K.svc.set(n.id, S);
      });
      /* сколько серверов: вручную или автодобавлением по брони */
      cl.need = serversFor(cl.list.map(S => ({ S, k: S.P + S.surge })));
      let servers = cl.nodes;
      if (cl.ca) {
        const want = ramp > 0 ? serversFor(cl.list.map(S => ({ S, k: S.Pca + S.surge }))) : cl.need;
        servers = Math.min(caMax, Math.max(caMin, want));
      }
      place(cl, servers);
      /* автодобавление видит Pending и добавляет сервер — кроме пика, где новый сервер ещё поднимается */
      if (cl.ca && !(ramp > 0)) while (cl.list.some(S => S.pending > 0 || S.surgeSched < S.surge) && servers < caMax) place(cl, ++servers);
      cl.caLag = cl.ca && ramp > 0 && cl.list.some(S => S.pending > 0) && servers < caMax;
      /* выкладка застряла: гасить старые нельзя, а новым подам нет места */
      cl.list.forEach(S => { S.stuck = !!o.k8sRollout && S.surge > 0 && S.surgeSched === 0 && S.unav === 0; });
      /* обслуживание сервера: выселяем поды с самого занятого; с бюджетом — по одному */
      if (o.k8sDrain && cl.free.length) {
        let di = 0, best = -1;
        cl.free.forEach((f, i) => { const k = Object.values(f.by).reduce((s, v) => s + v, 0); if (k > best) { best = k; di = i; } });
        const drained = cl.free[di], rest = cl.free.filter((_, i) => i !== di);
        cl.drained = di;
        cl.list.forEach(S => {
          const on = drained.by[S.id] || 0;
          S.onDrained = on;
          S.evict = S.pdb ? Math.min(on, 1) : on;
          for (let i = 0; i < S.evict; i++) {
            let f = null;
            for (const x of rest) if (x.cpu + 1e-9 >= S.req && x.mem >= S.lim && (!f || x.cpu > f.cpu)) f = x;
            if (f) { f.cpu -= S.req; f.mem -= S.lim; S.evictPlaced++; }
          }
        });
      }
      cl.list.forEach(S => { S.noEndpoints = S.readyProbe && Math.min(S.sched, S.Pnow) - S.unav - S.evict <= 0; });
      cl.cores = servers * NODE_CORES; cl.memMb = servers * NODE_MB;
      cl.cpuAsked = cl.list.reduce((s, S) => s + S.P * S.req, 0);
      cl.memAsked = cl.list.reduce((s, S) => s + S.P * S.lim, 0);
      K.clusters.push(cl);
    }
  }

  /* после трафика: память, падения, борьба за ядра, ёмкость */
  function settle(ctx, H) {
    const K = ctx.k8s;
    if (!K || K.done) return K;
    K.done = true;
    K.clusters.forEach(cl => {
      let G = 0, B = 0, D = 0;
      cl.list.forEach(S => {
        const n = S.n, ld = ctx.load.get(n.id) || {};
        const rps = n.type === 'worker' ? (ld.job || 0) : Object.values(ld).reduce((s, v) => s + v, 0);
        const ready0 = Math.min(S.sched, S.Pnow);
        S.starting = S.sched - ready0;
        const ready = Math.max(0, ready0 - S.unav - S.evict);   // гасим при выкладке, выселяем при обслуживании сервера
        S.readyPods = ready;
        const warm = S.starting + S.surgeSched + S.unav + S.evictPlaced;
        S.nr = !S.readyProbe && warm > 0 ? warm / (ready + warm) : 0;
        S.rps = rps;
        const rpsPod = ready ? rps * (1 - S.nr) / ready : 0;
        const dyn = n.type === 'worker' ? WORKER_FULL_MB * Math.min(1, rpsPod / S.per) : MB_PER_RPS * rpsPod;   // обработчик берёт в работу не больше своей параллельности
        let f = 0;
        if (ready > 0 && dyn > 0) {
          if (S.lim <= BASE_MB) f = 1;
          else { const t0 = ((S.lim - BASE_MB) / dyn - 1) / SPREAD; f = Math.max(0, Math.min(1, (1 - t0) / 2)); }
        }
        if (f < 0.02) f = 0;
        S.f = f; S.memAvg = BASE_MB + dyn; S.memMax = BASE_MB + dyn * (1 + SPREAD);
        S.crash = f ? Math.min(ready, Math.max(1, Math.round(ready * f))) : 0;
        S.W = ready * (1 - f);
        S.units = (ctx.units.get(n.id) || 0) * (1 - S.nr);
        const used = structural(ctx, n, S.W, H);
        const utilPod = used > 0 ? S.units / (used * S.per) : 0;
        S.use = Math.min(1, utilPod) * S.vcpu;
        const plan = structural(ctx, n, S.P, H);
        S.usePlan = plan > 0 ? Math.min(1, (ctx.units.get(n.id) || 0) / (plan * S.per)) * S.vcpu : 0;   // расход на под, когда работают все заказанные поды
        S.fit = REQS.find(v => v >= S.usePlan * 0.95) || REQS[REQS.length - 1];   // самый скромный вариант брони, который покрывает расход
        S.waste = S.rps > 0 ? S.P * Math.max(0, S.req - S.fit) : 0;   // лишние ядра брони сверх него
        S.g = Math.min(S.use, S.req); S.b = S.use - S.g;
        G += used * S.g; B += used * S.b; D += used * S.use;
      });
      cl.demand = D; cl.rho = 1;
      if (D > cl.cores + 1e-9 && B > 0) cl.rho = Math.max(0, Math.min(1, (cl.cores - G) / B));
      cl.waste = cl.list.reduce((s, S) => s + S.waste, 0);
      cl.perServer = perServer(cl.n);
      cl.wasteServers = cl.waste / (NODE_CORES * FILL);
      cl.wasteUsd = cl.wasteServers * cl.perServer;
      cl.list.forEach(S => {
        let perEff = S.per;
        if (cl.rho < 1 && S.b > 0) {
          const avail = S.g + cl.rho * S.b;
          perEff = S.per * Math.min(1, Math.max(avail, Math.min(S.req, S.vcpu)) / S.vcpu);
        }
        S.perEff = perEff; S.throttle = perEff < S.per - 1e-9 ? 1 - perEff / S.per : 0;
        S.capFull = structural(ctx, S.n, S.W, H) * perEff;
        S.down = H.down(ctx, S.n);
        S.Wdown = Math.max(0, S.W - S.down);
        S.capDown = structural(ctx, S.n, S.Wdown, H) * perEff;
        S.w = S.down > 0 ? (cl.probes ? RESTART_SHARE : 1) : 0;
        S.wasteUsd = S.waste / (NODE_CORES * FILL) * cl.perServer;
      });
    });
    return K;
  }
  const svcOf = (ctx, n) => (ctx.k8s && ctx.k8s.svc.get(n.id)) || null;

  function isDead(ctx, n) {
    const S = svcOf(ctx, n); if (!S) return undefined;
    if (S.sched === 0) return true;   // ни один под не поместился на серверы
    if (S.noEndpoints) return true;   // все поды гаснут или переезжают, готовых нет — трафик некому отдать
    if (S.cl.probes) return false;    // упавший под Kubernetes поднимет сам
    return undefined;
  }
  function capacity(ctx, n, H) {
    const S = svcOf(ctx, n); if (!S) return undefined;
    settle(ctx, H);
    return S.w >= 1 ? S.capDown : S.capFull;
  }
  function state(ctx, n, ld, cap, H) {
    const S = svcOf(ctx, n); if (!S) return undefined;
    settle(ctx, H);
    const base = n.type === 'worker' ? ((ctx.level.job && ctx.level.job.ms) || 100) : (T.app.lat || 12);
    const imbF = lbImb(ctx, n, structural(ctx, n, S.W, H), H), imbD = lbImb(ctx, n, structural(ctx, n, S.Wdown, H), H);
    const uF = S.capFull > 0 ? S.units / S.capFull * imbF : (S.units ? 9 : 0);
    const uD = S.capDown > 0 ? S.units / S.capDown * imbD : (S.units ? 9 : 0);
    const w = S.w, okC = x => x > 1 ? 1 / x : 1;
    const loss = (1 - S.nr) * (1 - S.f * OOM_LOSS);
    const latF = base * H.qf(uF), latD = S.Wdown > 0 ? base * H.qf(uD) : base;
    S.util = (1 - w) * uF + w * uD;
    return {
      util: S.util,
      lat: () => (1 - w) * latF + w * latD,
      ok: () => ((1 - w) * okC(uF) + w * (S.Wdown > 0 ? okC(uD) : 0)) * loss,
      info: { k8s: snap(S) }
    };
  }
  function snap(S) {
    return { id: S.id, name: lbl(S.n), cluster: S.cl.id, pods: S.P, ready: S.readyPods, sched: S.sched, pending: S.pending, starting: S.starting,
      crash: S.crash, oom: S.f, memAvg: S.memAvg, memMax: S.memMax, lim: S.lim, req: S.req, use: S.use, usePlan: S.usePlan, vcpu: S.vcpu, throttle: S.throttle,
      nr: S.nr, readiness: S.readyProbe, autoscale: S.autoscale, util: S.util, down: S.down, rps: S.rps,
      waste: S.waste, wasteUsd: S.wasteUsd, fit: S.fit, surge: S.surge, surgeSched: S.surgeSched, unav: S.unav, stuck: S.stuck, maxSurge: S.maxSurge, maxUnav: S.maxUnav,
      pdb: S.pdb, evict: S.evict, onDrained: S.onDrained || 0, caLag: !!S.cl.caLag };
  }
  function collect(ctx, res, level, H) {
    const K = ctx.k8s; if (!K || !K.svc.size) return;
    settle(ctx, H);
    const out = { svc: {}, clusters: {} };
    K.clusters.forEach(cl => {
      /* автодобавление: платишь за серверы, которые держит кластер, — их число задаёт бронь подов */
      if (cl.ca && res.nodes[cl.id]) {
        const r = res.nodes[cl.id], c = clusterCost(cl.n, cl.servers), d = c - (r.cost || 0);
        r.cost = c; res.cost += d;
      }
      out.clusters[cl.id] = { nodes: cl.nodes, cores: cl.cores, memGb: cl.memMb / 1024, cpuAsked: cl.cpuAsked, memAskedGb: cl.memAsked / 1024, demand: cl.demand, rho: cl.rho,
        pending: cl.list.reduce((s, S) => s + S.pending, 0), probes: cl.probes, svc: cl.list.map(S => S.id),
        servers: cl.servers, need: cl.need, ca: cl.ca, caMin: cl.caMin, caMax: cl.caMax, caLag: !!cl.caLag, waste: cl.waste, wasteServers: cl.wasteServers, wasteUsd: cl.wasteUsd,
        perServer: cl.perServer, cost: res.nodes[cl.id] ? res.nodes[cl.id].cost : 0, drained: cl.drained };
    });
    K.svc.forEach(S => { out.svc[S.id] = snap(S); });
    res.k8s = out;
  }
  (SD.simExts = SD.simExts || []).push({ prepare, isDead, capacity, state, collect });

  /* ---------- советы прораба ---------- */
  const baseAdvise = SD.sim.advise;
  function k8sAdvice(level, graph, res) {
    const A = [], K = res && res.k8s; if (!K) return A;
    Object.entries(K.clusters).forEach(([cid, c]) => {
      const pend = c.svc.map(id => K.svc[id]).filter(s => s.pending > 0);
      if (pend.length) A.push({ sev: 'bad', node: pend[0].id, text: c.ca && c.servers >= c.caMax
        ? `Pending: ${pend.map(s => `«${s.name}» — ${s.pending} из ${s.pods} ${podsOf(s.pods)}`).join(', ')}. Автодобавление упёрлось в потолок: ${servW(c.servers)}, а под бронь нужно ${c.need}. Подними «Серверов не больше» или сократи бронь.`
        : c.caLag ? `Pending: ${pend.map(s => `«${s.name}» — ${s.pending} из ${s.pods} ${podsOf(s.pods)}`).join(', ')} ждут нового сервера: автодобавление поднимает его 2–3 минуты. Держи запас — «Серверов не меньше».`
        : `Pending: ${pend.map(s => `«${s.name}» — ${s.pending} из ${s.pods} ${podsOf(s.pods)}`).join(', ')} не поместились на серверы. Просят ${cores(c.cpuAsked)} и ${dec(c.memAskedGb)} ГБ, а в кластере ${cores(c.cores)} и ${c.memGb} ГБ (${c.nodes} × 4 ядра, 16 ГБ). Уменьши «Запрос CPU» до реального расхода или добавь серверов Kubernetes.` });
      if (c.rho < 0.999) A.push({ sev: 'bad', node: cid, text: `Серверам кластера не хватает ядер: подам нужно ≈ ${cores(c.demand)}, а есть ${cores(c.cores)}. Поды тратят больше, чем бронируют, и отнимают ядра друг у друга (CPU throttling). Добавь серверов или подними «Запрос CPU» до реального расхода.` });
      if (c.ca) A.push({ sev: 'info', node: cid, text: `Автодобавление держит ${servW(c.servers)} (от ${c.caMin} до ${c.caMax}): под бронь ${cores(c.cpuAsked)} и ${dec(c.memAskedGb)} ГБ с запасом 20 % — ${usd(c.cost)} в месяц.` });
      else if (k8sOn(level) && c.need < c.nodes && !pend.length) A.push({ sev: 'info', node: cid, text: `Сейчас под бронь подов хватит ${servW(c.need)}, а в кластере ${c.nodes}: остальные ждут пика или простаивают — ${usd((c.nodes - c.need) * c.perServer)} в месяц. Автодобавление серверов держало бы столько, сколько нужно сейчас, и добавляло бы к пику.` });
    });
    Object.values(K.svc).forEach(s => {
      if (s.crash > 0) A.push({ sev: 'bad', node: s.id, text: `OOMKilled: ${s.crash} из ${s.ready} ${podsOf(s.ready)} «${s.name}» перезапускаются по кругу (CrashLoopBackOff). Самым нагруженным нужно до ≈ ${Math.round(s.memMax)} МБ, а лимит ${s.lim} МБ. Подними «Лимит памяти пода» или добавь подов — каждому достанется меньше запросов.` });
      else if (s.memMax > s.lim * 0.85 && s.rps > 0) A.push({ sev: 'warn', node: s.id, text: `«${s.name}»: поды занимают до ≈ ${Math.round(s.memMax)} МБ из ${s.lim} МБ. Небольшой рост нагрузки — и начнутся OOMKilled.` });
      if (s.nr > 0.001) A.push({ sev: 'bad', node: s.id, text: `«${s.name}»: без readiness-пробы ${Math.round(s.nr * 100)} % запросов идёт в поды, которые ещё стартуют, — это ошибки у пользователей.` });
      else if (!s.readiness) A.push({ sev: 'warn', node: s.id, text: `«${s.name}» без readiness-пробы: при масштабировании и выкладке новые поды получат запросы ещё до того, как будут готовы.` });
      if (s.down > 0 && graph.nodes.some(n => n.id === s.cluster && n.props.probes !== false)) A.push({ sev: 'info', node: s.id, text: `Kubernetes перезапускает упавший под «${s.name}»: через ≈ 1 минуту он снова в строю. Пока он поднимается, остальные тянут нагрузку сами.` });
      if (s.waste >= 2) A.push({ sev: 'warn', node: s.id, text: `«${s.name}»: бронь ${cores(s.req)} на под, а под тратит ≈ ${cores(s.usePlan)} — хватило бы ${cores(s.fit).replace(/ядро$/, 'ядра')}. ${s.pods} ${pods(s.pods)} держат ≈ ${cores(s.waste)} лишней брони: платишь за ≈ ${servW(s.waste / (NODE_CORES * FILL))} — ${usd(s.wasteUsd)} в месяц. Сократи «Запрос CPU пода».` });
      if (k8sOn(level) && s.maxUnav >= 1 && s.pods > 1) A.push({ sev: 'warn', node: s.id, text: `«${s.name}»: maxUnavailable 100 % — на выкладке Kubernetes погасит все старые поды разом, как «всё сразу» в конвейере. Пока новые стартуют, отвечать некому.` });
      if (k8sOn(level) && !s.pdb && s.pods > 1) A.push({ sev: 'info', node: s.id, text: `«${s.name}» без PodDisruptionBudget: когда сервер обслуживают или автодобавление его убирает, все поды сервиса с этого сервера выселят разом.` });
    });
    return A;
  }
  if (baseAdvise) SD.sim.advise = function (level, graph, res, an) {
    const A = baseAdvise.apply(this, arguments) || [];
    try { k8sAdvice(level, graph, res).forEach(a => A.push(a)); } catch (e) { /* без советов по Kubernetes */ }
    return A;
  };

  /* ---------- проверки для уровней ---------- */
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const managed = res => Object.values((res && res.k8s && res.k8s.svc) || {});
  const noSvc = { ok: false, detail: 'нет сервисов в Kubernetes' };
  const goals = {
    deployed: () => custom('Сервисы развёрнуты в Kubernetes', g => {
      const s = SD.opsState(g), svcs = s.svcs.filter(n => SVC.has(n.type)), miss = svcs.filter(n => !s.k8s.has(n.id)).map(lbl);
      return { ok: svcs.length > 0 && !miss.length, detail: !svcs.length ? 'сервисов нет' : miss.length ? 'не в кластере: ' + miss.join(', ') : 'все в кластере' };
    }),
    noOom: () => custom('Поды не падают по памяти (нет OOMKilled)', (g, res) => {
      const list = managed(res); if (!list.length) return noSvc;
      const bad = list.filter(s => s.crash > 0);
      return { ok: !bad.length, detail: bad.length ? bad.map(s => `OOMKilled: ${s.crash} из ${s.ready} ${podsOf(s.ready)} «${s.name}» перезапускаются`).join('; ') : `память до ≈ ${Math.round(Math.max(...list.map(s => s.memMax)))} МБ — в лимите` };
    }),
    noPending: () => custom('Все поды поместились на серверы (нет Pending)', (g, res) => {
      const list = managed(res); if (!list.length) return noSvc;
      const bad = list.filter(s => s.pending > 0);
      return { ok: !bad.length, detail: bad.length ? bad.map(s => `Pending: ${s.pending} ${pods(s.pending)} «${s.name}» не ${s.pending === 1 ? 'поместился' : 'поместились'}`).join('; ') : `запущено ${list.reduce((a, s) => a + s.sched, 0)} ${pods(list.reduce((a, s) => a + s.sched, 0))}` };
    }),
    honestReq: () => custom('Запрос CPU по делу: не меньше реального расхода и не больше двух', (g, res) => {
      const list = managed(res).filter(s => s.rps > 0); if (!list.length) return { ok: false, detail: 'нет сервисов в Kubernetes с нагрузкой' };
      const low = list.filter(s => s.req < s.usePlan * 0.95), high = list.filter(s => s.req > Math.max(s.usePlan * 2, 0.25));
      const s = low[0] || high[0];
      return { ok: !low.length && !high.length, detail: s ? `«${s.name}»: под тратит ≈ ${cores(s.usePlan)}, а бронирует ${cores(s.req)} — ${low.length ? 'в пик соседи отнимут недостающее' : 'бронь пустует, место на серверах пропадает'}` : list.map(x => `под тратит ≈ ${cores(x.usePlan)}, бронирует ${cores(x.req)}`).join('; ') };
    }),
    peak: (mul, ramp, min, title) => custom(`${title || 'Утренний пик'} ×${String(mul).replace('.', ',')}: нагрузка растёт, пока поды стартуют (успешно ≥ ${Math.round(min * 100)} %)`, (g, res, L) => {
      const r = SD.sim.run(L, g, { mul, k8sRamp: ramp });
      const ok = r.total.success >= min, why = [];
      managed(r).forEach(s => {
        if (s.pending) why.push(`Pending: ${s.pending} ${pods(s.pending)}${s.caLag ? (s.pending === 1 ? ' ждёт' : ' ждут') + ' нового сервера' : ''}`);
        if (s.nr > 0.001) why.push(`${Math.round(s.nr * 100)} % запросов в неготовые поды`);
        if (s.crash) why.push(`OOMKilled: ${s.crash} из ${s.ready}`);
        if (s.throttle > 0.01) why.push('поды делят ядра (throttling)');
        if (s.util > 1) why.push(`готово ${s.ready} из ${s.pods} ${podsOf(s.pods)}, загрузка ${Math.round(s.util * 100)} %`);
      });
      return { ok, detail: `при ×${String(mul).replace('.', ',')} успешно ${SD.fmt.pct(r.total.success)}${!ok && why.length ? ': ' + why.join(', ') : ''}` };
    }),
    /* выкладка новой (исправной) версии: худший момент rolling update внутри Kubernetes */
    rollout: min => custom(`Выкладка новой версии не роняет сервис (в худший момент успешно ≥ ${Math.round(min * 100)} %)`, (g, res, L) => {
      if (!managed(res).length) return noSvc;
      const r = SD.sim.run(L, g, { mul: 1, k8sRollout: true }), list = managed(r);
      const stuck = list.filter(s => s.stuck), ok = r.total.success >= min && !stuck.length;
      const s = list.reduce((a, x) => (x.ready / x.pods < a.ready / a.pods ? x : a), list[0]);
      const why = stuck.length ? `выкладка «${stuck[0].name}» застряла: гасить старые поды нельзя (maxUnavailable 0), а новым нет места на серверах`
        : `работают ${s.ready} из ${s.pods} ${podsOf(s.pods)} «${s.name}», стартуют ${s.surgeSched + s.unav}${s.nr > 0.001 ? `, ${pct(s.nr)} запросов уходит в неготовые поды` : ''}${s.surgeSched < s.surge ? `, новым подам не хватило места: ${s.surge - s.surgeSched}` : ''}`;
      return { ok, detail: `в худший момент успешно ${SD.fmt.pct(r.total.success)}: ${why}` };
    }),
    /* обслуживание сервера: с него выселяют поды (обновление серверов, автодобавление убирает лишний) */
    drain: min => custom(`Обслуживание сервера не роняет сервис (успешно ≥ ${Math.round(min * 100)} %)`, (g, res, L) => {
      if (!managed(res).length) return noSvc;
      const r = SD.sim.run(L, g, { mul: 1, k8sDrain: true }), list = managed(r);
      const ok = r.total.success >= min;
      const s = list.reduce((a, x) => (x.evict > a.evict ? x : a), list[0]);
      return { ok, detail: `успешно ${SD.fmt.pct(r.total.success)}: с сервера выселяют ${s.evict} из ${s.onDrained} ${podsOf(s.onDrained)} «${s.name}» ${s.pdb ? 'по одному (PodDisruptionBudget)' : 'разом'}, работают ${s.ready} из ${s.pods}${s.nr > 0.001 ? `, ${pct(s.nr)} запросов в неготовые поды` : ''}` };
    })
  };

  /* ---------- уровни «Эксплуатация»: Kubernetes под нагрузкой ---------- */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const O = o => Object.assign({ tier: 'ops', opsLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL(), features: ['k8s'], tool: 'k8s' }, o);
  const K8 = (props, x = 420, y = 470) => ['k8s', 'k8s', x, y, props, 'Kubernetes'];

  const OOM_E = [['client', 'lb'], ['lb', 'cat'], ['cat', 'cache'], ['cat', 'db'], ['k8s', 'cat']];
  const OOM_N = (app, k8s) => [['lb', 'lb', 220, 250], ['cat', 'app', 420, 250, Object.assign({ count: 4, memLimit: 512 }, app), 'Сервис каталога'], ['cache', 'cache', 660, 130, { mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { replicas: 1 }, 'База каталога'], K8(Object.assign({ nodes: 3 }, k8s))];

  const PEND_E = [['client', 'lb'], ['lb', 'api'], ['api', 'cache'], ['api', 'db'], ['k8s', 'api']];
  const PEND_N = (app, k8s) => [['lb', 'lb', 220, 250], ['api', 'app', 420, 250, Object.assign({ count: 10, cpuReq: 2 }, app), 'API заказов'], ['cache', 'cache', 660, 130, { count: 2, mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { size: 'l', replicas: 2 }, 'База заказов'], K8(Object.assign({ nodes: 2 }, k8s))];

  const PEAK_E = [['client', 'lb'], ['lb', 'book'], ['book', 'cache'], ['book', 'db'], ['k8s', 'book']];
  const PEAK_N = (app, k8s) => [['lb', 'lb', 220, 250], ['book', 'app', 420, 250, Object.assign({ count: 6, readiness: false }, app), 'Сервис бронирования'], ['cache', 'cache', 660, 130, { count: 2, mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { size: 'l', replicas: 1 }, 'База бронирований'], K8(Object.assign({ nodes: 3 }, k8s))];

  const BILL_E = [['client', 'lb'], ['lb', 'feed'], ['feed', 'cache'], ['feed', 'db'], ['k8s', 'feed']];
  const BILL_N = (app, k8s) => [['lb', 'lb', 220, 250], ['feed', 'app', 420, 250, Object.assign({ count: 4, size: 's', autoscale: true, hpaTarget: 0.6, cpuReq: 2 }, app), 'Сервис ленты'], ['cache', 'cache', 660, 130, { count: 2, mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { size: 'l', replicas: 1, pooler: true }, 'База ленты'], K8(Object.assign({ ca: true, caMin: 2, caMax: 20 }, k8s))];

  const ROLL_E = [['client', 'lb'], ['lb', 'pay'], ['pay', 'cache'], ['pay', 'db'], ['k8s', 'pay']];
  const ROLL_N = (app, k8s) => [['lb', 'lb', 220, 250], ['pay', 'app', 420, 250, Object.assign({ count: 8, size: 's', readiness: false, maxUnavailable: 1, maxSurge: 0.25, pdb: false }, app), 'Сервис оплаты'], ['cache', 'cache', 660, 130, { count: 2, mem: 16 }, 'Кэш'], ['db', 'sql', 660, 360, { size: 'l', replicas: 1 }, 'База платежей'], K8(Object.assign({ nodes: 3 }, k8s))];

  const LEVELS = [
    O({
      id: 'o-k8s-oom', title: 'Поды падают по памяти', pattern: 'bulkhead',
      chips: ['лимит памяти', 'OOMKilled', 'CrashLoopBackOff'],
      story: 'Рюкзак, в который пихают больше, чем он вмещает, рвётся. У пода в Kubernetes тоже есть потолок памяти — лимит. Под набирает память вместе с нагрузкой и, пробив лимит, падает (OOMKilled); Kubernetes запускает его заново, он снова набирает — и снова падает (CrashLoopBackOff). Каталог развёрнут в Kubernetes: 4 пода по 512 МБ. После запуска новой витрины пришло 6 000 запросов в секунду — и половина подов падает по кругу. Почини, не раздувая счёт.',
      traffic: { read: 5400, write: 600 }, hotSetGb: 8,
      start: { nodes: OOM_N({}, {}), edges: OOM_E },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, goals.noOom(), goals.deployed(), { t: 'survive', types: ['app'] }, { t: 'cost', max: 2300 }],
      hints: [
        { text: 'Нажми на «Сервис каталога» → «Лимит памяти пода»: поставь 1 ГБ.', why: 'Как рюкзак побольше: вещи те же, молния цела. Память пода — ≈ 200 МБ на запуск и ≈ 20 МБ на каждые 100 запросов в секунду. 6 000 запросов на 4 пода — по 1 500 на под, это ≈ 500 МБ, а у самых нагруженных подов — до ≈ 575 МБ. Лимит 512 МБ они пробивают.' },
        { text: 'Другой путь — добавить подов: нагрузка разделится, и каждому понадобится меньше памяти.', why: 'Как разложить вещи по двум рюкзакам. 6 подов — по 1 000 запросов в секунду, это ≈ 450 МБ даже у самых нагруженных. Но каждый под стоит денег — следи за бюджетом.' },
        { text: 'Не убирай поды ради экономии: оставь запас на падение одного.', why: 'Kubernetes поднимет упавший под примерно за минуту, но эту минуту оставшиеся тянут всю нагрузку сами. Самолечение не заменяет запаса.' }
      ],
      solution: { nodes: OOM_N({ memLimit: 1024 }, {}), edges: OOM_E,
        note: 'Лимит памяти 1 ГБ: под под нагрузкой занимает до ≈ 575 МБ — запас есть, OOMKilled нет. Подов по-прежнему 4: падение одного остальные переживут.' }
    }),
    O({
      id: 'o-k8s-pending', title: 'Поды не помещаются', pattern: 'autoscaling',
      chips: ['requests', 'Pending', 'планировщик'],
      story: 'Столик на шестерых для двоих гостей — и зал «полон», а люди ждут у входа. Планировщик Kubernetes раскладывает поды по серверам по их брони — запросу CPU (requests), а не по тому, сколько под тратит на самом деле. Перед распродажей API заказов подняли до 10 подов, и каждый попросил 2 ядра «на всякий случай», хотя тратит меньше одного. В кластере 2 сервера по 4 ядра — 6 подов висят в Pending, остальные не справляются. Сделай так, чтобы все поды работали, и не переплати за серверы.',
      traffic: { read: 10000, write: 1250 }, hotSetGb: 8,
      start: { nodes: PEND_N({}, {}), edges: PEND_E },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, goals.noPending(), goals.honestReq(), goals.deployed(), { t: 'cost', max: 4800 }],
      hints: [
        { text: 'Нажми на «API заказов» → «Запрос CPU пода»: под тратит ≈ 0,9 ядра — проси 1 ядро, а не 2.', why: 'Бронь по числу гостей: столик на двоих для двоих. Планировщик смотрит только на бронь — завышенная бронь съедает место на серверах, и поды ждут (Pending).' },
        { text: 'Посчитай место: 10 подов × 1 ядро = 10 ядер, а сервер — 4 ядра. Нажми на Kubernetes и поставь 3 сервера.', why: '2 сервера × 4 ядра = 8 ядер — двум подам места не хватит. Три сервера — 12 ядер, с запасом на рост.' },
        { text: 'Не проси меньше, чем под тратит.', why: 'Бронь на двоих, когда пришло четверо: сядут, но в час пик стулья отберут. Поды с заниженным запросом набиваются на серверы плотнее, чем те вытянут, и отнимают ядра друг у друга (CPU throttling) — всё тормозит.' }
      ],
      solution: { nodes: PEND_N({ cpuReq: 1 }, { nodes: 3 }), edges: PEND_E,
        note: 'Запрос CPU 1 ядро — как раз по расходу (≈ 0,9 ядра на под). 10 подов просят 10 ядер, в кластере 3 сервера — 12 ядер: всем хватает места, и запас есть.' }
    }),
    O({
      id: 'o-k8s-peak', title: 'Пик утром', pattern: 'autoscaling',
      chips: ['HPA', 'целевая загрузка', 'readiness'],
      story: 'В супермаркете утром открывают больше касс, а днём закрывают лишние: держать 12 касс весь день дорого, а с шестью утром очередь до улицы. Сервис бронирования переговорок: в 9:00 весь офис открывает приложение, и за несколько минут нагрузка утраивается. Сейчас 6 подов круглые сутки — днём они скучают, утром захлёбываются. Держать пиковое число подов весь день бюджет не даёт. Пусть Kubernetes сам добавляет поды к утру и убирает днём.',
      traffic: { read: 5000, write: 500 }, hotSetGb: 6,
      start: { nodes: PEAK_N({}, {}), edges: PEAK_E },
      goals: [{ t: 'success', min: 0.999 }, goals.peak(3, 0.4, 0.99), goals.deployed(), { t: 'cost', max: 3150 }],
      hints: [
        { text: 'Нажми на «Сервис бронирования»: включи «Автомасштабирование (HPA)», минимум — 3 пода.', why: 'Как кассы по расписанию очереди: подов столько, сколько нужно сейчас. Днём платишь за 3–4 пода, утром HPA сам добавит ещё.' },
        { text: '«Целевая загрузка HPA» — 60 %, не 80 %.', why: 'Новый под поднимается минуту-две, а утром нагрузка за это время растёт ещё почти наполовину. При цели 80 % старые поды к приходу подмоги уже перегружены; при 60 % запаса как раз хватает. 40 % — надёжно, но днём держишь лишние поды.' },
        { text: 'Включи «Пробу готовности (readiness)».', why: 'Новичка не ставят на кассу, пока он не прошёл инструктаж. Без readiness-пробы новый под получает запросы, пока ещё запускается, и отвечает ошибками — а утром новых подов много.' },
        { text: 'Дай Kubernetes 4 сервера.', why: 'Утром подов втрое больше, и каждый тратит больше ядра. Трёх серверов (12 ядер) не хватит — поды начнут отнимать ядра друг у друга или ждать места (Pending).' }
      ],
      solution: { nodes: PEAK_N({ count: 3, autoscale: true, hpaTarget: 0.6, readiness: true }, { nodes: 4 }), edges: PEAK_E,
        note: 'HPA с целью 60 %: днём 4 пода, утром — до 11. Запаса 40 % хватает, пока новые поды стартуют, а readiness-проба не пускает к ним трафик раньше времени. 4 сервера — место для утренних подов.' }
    }),
    O({
      id: 'o-k8s-bill', title: 'Счёт за кластер вырос', pattern: 'autoscaling',
      chips: ['requests', 'Cluster Autoscaler', 'цена брони'],
      story: 'Склад, где каждый арендатор бронирует полки «с запасом»: полки пустуют, а склад достраивает новые отсеки — и счёт за аренду растёт за пустоту. В Kubernetes так же: автодобавление серверов (Cluster Autoscaler) держит столько серверов, сколько нужно под бронь подов, а не под их реальный расход. Сервис ленты сам масштабируется по нагрузке (HPA), но каждый под бронирует 2 ядра, хотя тратит около половины ядра. Кластер раздулся, и финансы спрашивают, за что такой счёт. Сократи счёт за кластер — и не урони вечерний пик.',
      traffic: { read: 9500, write: 500 }, hotSetGb: 8,
      start: { nodes: BILL_N({}, {}), edges: BILL_E },
      goals: [{ t: 'success', min: 0.999 }, goals.peak(2.5, 0.15, 0.99, 'Вечерний пик'), goals.honestReq(), goals.deployed(), { t: 'cost', max: 3730 }],
      hints: [
        { text: 'Нажми на «Сервис ленты» → «Запрос CPU пода»: под тратит ≈ 0,6 ядра — проси 1 ядро, а не 2.', why: 'Бронируй полки под товар, а не «на всякий случай». Автодобавление считает серверы по брони: 14 подов × 2 ядра — это 28 ядер и 9 серверов, а по 1 ядру — 14 ядер и 5 серверов. Разница — прямо в счёте.' },
        { text: 'Не выключай автодобавление серверов: вечером нагрузка в 2,5 раза больше, и HPA поднимет до 30 подов.', why: 'Склад сам арендует отсек на вечерний наплыв и сдаёт его ночью. Если задать серверы руками, придётся держать вечернее число круглые сутки — или вечером поды будут ждать места (Pending). Новый сервер поднимается 2–3 минуты, поэтому вечер растёт плавно — автодобавление успевает.' },
        { text: 'Не проси меньше, чем под тратит.', why: 'Бронь 0,5 ядра при расходе 0,6: автодобавление поставит серверов меньше, чем поды на деле тратят, — и в пик они отнимут ядра друг у друга.' }
      ],
      solution: { nodes: BILL_N({ cpuReq: 1 }, {}), edges: BILL_E,
        note: 'Запрос CPU 1 ядро — по расходу (≈ 0,6 ядра на под с запасом). Автодобавление держит 5 серверов днём вместо 9 и само добавляет их к вечеру. Счёт за кластер — почти вдвое меньше.' }
    }),
    O({
      id: 'o-k8s-rollout', title: 'Выкладка уронила поды', pattern: 'healthcheck',
      chips: ['maxSurge', 'maxUnavailable', 'PodDisruptionBudget'],
      story: 'Смена караула: новый часовой сначала встаёт на пост рядом со старым, и только потом старый уходит. Если отпустить всех старых разом, пока новые переодеваются, пост пустой. В Kubernetes выкладка новой версии меняет поды так же (rolling update): maxSurge — сколько новых подов поднять сверх нужного, maxUnavailable — сколько старых погасить, не дожидаясь новых. У сервиса оплаты maxUnavailable 100 % и нет readiness-пробы: на каждой выкладке Kubernetes гасит все 8 подов разом, а новые получают платежи, пока ещё запускаются. А ночью, когда серверы кластера обновляют по одному, Kubernetes выселяет с сервера все поды оплаты разом. Сделай так, чтобы ни выкладка, ни обслуживание серверов не роняли оплату.',
      traffic: { read: 6000, write: 500 }, hotSetGb: 8,
      start: { nodes: ROLL_N({}, {}), edges: ROLL_E },
      goals: [{ t: 'success', min: 0.999 }, goals.rollout(0.99), goals.drain(0.99), goals.deployed(), { t: 'cost', max: 3070 }],
      hints: [
        { text: 'Нажми на «Сервис оплаты» → «Выкладка: можно погасить сразу (maxUnavailable)»: 0. «Новых подов сверх нужного (maxSurge)» оставь 25 %.', why: 'Новый часовой встаёт рядом, старый уходит после: сначала поднимаются 2 новых пода, и только когда они готовы, гаснут 2 старых. Мощность сервиса на выкладке не проседает. Нужно место под 2 лишних пода — на серверах есть 4 свободных ядра.' },
        { text: 'Включи «Пробу готовности (readiness)».', why: 'Без пробы Kubernetes считает новый под готовым, как только тот запустился, и шлёт ему платежи, пока он ещё прогревается. С пробой — только после ответа «готов».' },
        { text: 'Включи «PodDisruptionBudget: выселять по одному».', why: 'Ремонт в общежитии: жильцов переселяют по одному, и следующего — когда предыдущий устроился. Без бюджета с обслуживаемого сервера выселяют все 3 пода оплаты разом — оставшимся 5 платёжный поток не вытянуть.' }
      ],
      solution: { nodes: ROLL_N({ readiness: true, maxUnavailable: 0, maxSurge: 0.25, pdb: true }, {}), edges: ROLL_E,
        note: 'maxUnavailable 0 и maxSurge 25 %: новые поды поднимаются рядом, старые гаснут, только когда новые готовы, — 8 работающих подов на всей выкладке. Readiness-проба не пускает платежи в неготовые поды. PodDisruptionBudget выселяет поды с обслуживаемого сервера по одному.' }
    })
  ];
  if (SD.OPSL) LEVELS.forEach(L => { if (!SD.OPSL.some(x => x.id === L.id)) SD.OPSL.push(L); });

  /* ---------- интерфейс: всё ниже работает только в браузере ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* инспектор: у кластера — серверы, бронь и её цена; у сервиса в кластере — поды, память и лишняя бронь */
  function inspRows(n, K) {
    if (n.type === 'k8s') {
      const c = K.clusters[n.id]; if (!c) return null;
      return [
        ['Серверов', c.ca ? `${c.servers} · автодобавление ${c.caMin}–${c.caMax}` : `${c.nodes} · заданы вручную`, c.ca && c.servers >= c.caMax && c.pending ? 'bad' : ''],
        ['Бронь подов', `${cores(c.cpuAsked)} · ${dec(c.memAskedGb)} ГБ из ${cores(c.cores)} · ${c.memGb} ГБ`, c.cpuAsked > c.cores || c.memAskedGb > c.memGb ? 'bad' : c.cpuAsked > c.cores * FILL ? 'warn' : 'ok'],
        ['Под бронь нужно', `${servW(c.need)} (запас 20 %)`, !c.ca && c.need > c.nodes ? 'warn' : ''],
        ['Поды тратят', `≈ ${cores(c.demand)}`, c.rho < 0.999 ? 'bad' : 'ok'],
        ['Лишняя бронь', c.waste > 0 ? `≈ ${cores(c.waste)} — ≈ ${usd(c.wasteUsd)}/мес` : 'нет', c.waste >= 1 ? 'warn' : 'ok'],
        ['Ждут места (Pending)', String(c.pending), c.pending ? 'bad' : 'ok'],
        ['Цена кластера', `${usd(c.cost)}/мес · ${usd(c.perServer)} за сервер`]
      ];
    }
    const s = K.svc[n.id]; if (!s) return null;
    const rows = [
      ['Поды в кластере', `работают ${s.ready} из ${s.pods}${s.pending ? ` · Pending ${s.pending}` : ''}${s.crash ? ` · OOMKilled ${s.crash}` : ''}`, s.pending || s.crash ? 'bad' : 'ok'],
      ['Память пода', `до ≈ ${Math.round(s.memMax)} из ${s.lim} МБ`, s.crash ? 'bad' : s.memMax > s.lim * 0.85 ? 'warn' : 'ok'],
      ['Бронь CPU', `${cores(s.req)} · тратит ≈ ${cores(s.usePlan)}`, s.rps > 0 && (s.req > Math.max(s.usePlan * 2, 0.25) || s.req < s.usePlan * 0.95) ? 'warn' : 'ok']
    ];
    if (s.waste > 0) rows.push(['Лишняя бронь', `≈ ${cores(s.waste)} — ≈ ${usd(s.wasteUsd)}/мес`, s.waste >= 1 ? 'warn' : '']);
    rows.push(['Выкладка', `+${pct(s.maxSurge)} новых, гасим до ${pct(s.maxUnav)}${s.pdb ? ' · PDB' : ''}`, s.maxUnav >= 1 ? 'bad' : '']);
    return rows;
  }
  function patchInspector(A) {
    const pane = document.getElementById('paneNode'); if (!pane || !A || !A.sel || A.sel.type !== 'node') return;
    const n = A.graph.nodes.find(x => x.id === A.sel.id), K = A.res && A.res.k8s;
    if (!n || !K) return;
    const rows = inspRows(n, K); if (!rows) return;
    const h3 = [...pane.querySelectorAll('h3')].find(x => /^Сейчас/.test(x.textContent)), dl = h3 && h3.nextElementSibling;
    if (!dl || !dl.classList.contains('kv') || dl.querySelector('[data-k8s]')) return;
    dl.insertAdjacentHTML('beforeend', rows.map(([k, v, c]) => `<dt data-k8s="1">${esc(k)}</dt><dd class="${c || ''}">${esc(v)}</dd>`).join(''));
  }
  if (HAS_DOM && SD.inspector && SD.inspector.render) {
    const baseRender = SD.inspector.render;
    SD.inspector.render = function (A) { baseRender.apply(this, arguments); try { patchInspector(A); } catch (e) { /* инспектор как был */ } };
  }

  /* справка «?»: в обычный день maxSurge, maxUnavailable и бюджет выселения не меняют цифры — показываем выкладку и обслуживание сервера */
  const ROLL_KEYS = ['maxSurge', 'maxUnavailable', 'pdb'];
  let guideNode = null, gObs = null;
  function k8sGuide() {
    const m = document.getElementById('guideModal'), main = document.getElementById('gdMain');
    if (!m || m.hidden || !main || !guideNode || !SD.app || !SD.app.A) return;
    const A = SD.app.A, n = A.graph.nodes.find(x => x.id === guideNode);
    if (!n || !SVC.has(n.type)) return;
    const wrap = document.getElementById('gdCmpWrap'), on = document.querySelector('#gdList .lab-item.on[data-gk]');
    const key = on && on.getAttribute('data-gk'), d = key && ROLL_KEYS.includes(key) && (T[n.type].props || []).find(p => p.key === key);
    if (!wrap || !d || wrap.querySelector('.k8s-cmp')) return;
    const vals = d.type === 'toggle' ? [false, true] : d.options.map(o => o[0]);
    const name = v => d.type === 'toggle' ? (v ? 'Включено' : 'Выключено') : String((d.options.find(o => o[0] === v) || [v, v])[1]).split(' — ')[0];
    const rows = vals.map(v => {
      const g = JSON.parse(JSON.stringify(A.graph)); g.nodes.find(x => x.id === n.id).props[key] = v;
      const ro = SD.sim.run(A.level, g, { mul: 1, k8sRollout: true }), dr = SD.sim.run(A.level, g, { mul: 1, k8sDrain: true });
      return { v, ro, dr, s: ro.k8s && ro.k8s.svc[n.id], t: dr.k8s && dr.k8s.svc[n.id] };
    }).filter(r => r.s);
    if (!rows.length) return;
    const cls = v => v >= 0.999 ? 'ok' : v >= 0.99 ? 'warn' : 'bad', cur = n.props[key];
    let h = `<div class="k8s-cmp"><h3 class="gd-h">Во время выкладки и обслуживания сервера</h3><p class="note">В обычный день эти варианты не отличаются: они работают, когда Kubernetes меняет поды на новую версию или выселяет их с сервера. Худший момент — как в целях уровня.</p>`;
    h += `<table class="gd-table"><thead><tr><th>Вариант</th><th>Выкладка: работают подов</th><th>Выкладка: успешно</th><th>Обслуживание: работают</th><th>Обслуживание: успешно</th></tr></thead><tbody>`;
    rows.forEach(r => {
      const isCur = String(r.v) === String(cur);
      h += `<tr class="${isCur ? 'cur' : ''}"><td>${esc(name(r.v))}${isCur ? '<small>сейчас</small>' : ''}</td><td>${r.s.stuck ? 'застряла: нет места' : `${r.s.ready} из ${r.s.pods}`}</td><td class="${cls(r.ro.total.success)}">${SD.fmt.pct(r.ro.total.success)}</td><td>${r.t ? `${r.t.ready} из ${r.t.pods}` : '—'}</td><td class="${cls(r.dr.total.success)}">${SD.fmt.pct(r.dr.total.success)}</td></tr>`;
    });
    wrap.insertAdjacentHTML('beforeend', h + '</tbody></table></div>');
  }
  if (HAS_DOM && SD.guide && SD.guide.open) {
    const baseOpen = SD.guide.open, baseOpenEdge = SD.guide.openEdge;
    SD.guide.open = function (id) {
      guideNode = id;
      const out = baseOpen.apply(this, arguments);
      try {
        const main = document.getElementById('gdMain');
        if (main && !gObs && typeof MutationObserver !== 'undefined') { gObs = new MutationObserver(() => { try { k8sGuide(); } catch (e) { /* справка как была */ } }); gObs.observe(main, { childList: true }); }
        k8sGuide();
      } catch (e) { /* справка как была */ }
      return out;
    };
    if (baseOpenEdge) SD.guide.openEdge = function () { guideNode = null; return baseOpenEdge.apply(this, arguments); };
  }

  SD.k8s = { NODE_CORES, NODE_MB, FILL, CA_SLOW, goals, advice: k8sAdvice, levels: LEVELS, serversFor, clusterCost };
})();
