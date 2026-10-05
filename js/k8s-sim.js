/* Kubernetes в симуляторе: лимит памяти, запрос CPU и проба готовности у сервисов и обработчиков,
   которые разворачивает Kubernetes (стрелка Kubernetes → сервис).
   Что моделируем — просто и честно:
   1. Память пода = 200 МБ на запуск + растёт с нагрузкой на под. Пробил лимит — OOMKilled, перезапуск по кругу (CrashLoopBackOff).
   2. Планировщик раскладывает поды по серверам (4 ядра и 16 ГБ каждый) по их брони: запрос CPU и лимит памяти. Не влез — Pending.
   3. Под тратит ядер по нагрузке. Тратят больше, чем есть на серверах, — делят остаток, медленнее работают (CPU throttling).
   4. Без readiness-пробы трафик идёт в поды, которые ещё стартуют (рост нагрузки, выкладка), — часть запросов падает.
   5. Упавший под Kubernetes поднимает сам за ≈ 1 минуту: проверка «пережить падение» мягче, чем у ручного запуска.
   Сервисы без Kubernetes ведут себя как раньше. Уровни — в трек «Эксплуатация» (SD.OPSL). */
(function () {
  const T = SD.TYPES;
  const NODE_CORES = 4, NODE_MB = 16384;  // сервер кластера: 4 ядра и 16 ГБ
  const BASE_MB = 200;                    // память пода на старте: код, рантайм, библиотеки
  const MB_PER_RPS = 0.2;                 // сервис: +20 МБ на каждые 100 запросов в секунду на под
  const WORKER_FULL_MB = 600;             // обработчик под полной нагрузкой: +600 МБ к стартовым
  const SPREAD = 0.25;                    // нагрузка по подам неровная: ±25 % от средней
  const OOM_LOSS = 0.1;                   // доля трафика падающих подов, которая обрывается при перезапуске
  const RESTART_SHARE = 0.1;              // с пробами упавший под в строю через ≈ 1 мин из 10-минутного окна проверки
  const SURGE = 0.25;                     // выкладка: одновременно стартует 25 % новых подов (maxSurge)
  const VCPU = { s: 1, m: 2, l: 4, xl: 8 };
  const DEF = { memLimit: 1024, cpuReq: 1 };
  const SVC = new Set(['app', 'worker']);
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const lbl = n => n.label || (T[n.type] ? T[n.type].name : n.type);
  const num = (v, d) => { const x = +v; return isFinite(x) && x > 0 ? x : d; };
  const dec = (v, k) => (Math.round(v * Math.pow(10, k == null ? 1 : k)) / Math.pow(10, k == null ? 1 : k)).toString().replace('.', ',');
  const cores = v => { const r = Math.round(v * 10) / 10, d = dec(v, v < 1 ? 2 : 1); if (r !== Math.round(r)) return d + ' ядра'; const a = Math.round(r) % 100, b = a % 10; return d + (a > 10 && a < 20 ? ' ядер' : b === 1 ? ' ядро' : b >= 2 && b <= 4 ? ' ядра' : ' ядер'); };
  const podsOf = k => { const a = Math.abs(k) % 100; return a % 10 === 1 && a !== 11 ? 'пода' : 'подов'; };
  const pods = k => { const a = Math.abs(k) % 100, b = a % 10; return a > 10 && a < 20 ? 'подов' : b === 1 ? 'под' : b >= 2 && b <= 4 ? 'пода' : 'подов'; };

  /* ---------- настройки узлов ---------- */
  const PROPS = [
    { key: 'memLimit', label: 'Лимит памяти пода', type: 'select', def: DEF.memLimit, feature: 'k8s',
      options: [[256, '256 МБ'], [512, '512 МБ'], [1024, '1 ГБ'], [2048, '2 ГБ']],
      help: 'Потолок памяти одной копии в Kubernetes. Память пода растёт с нагрузкой: ≈ 200 МБ на запуск и ≈ 20 МБ на каждые 100 запросов в секунду. Пробьёт потолок — под убивают (OOMKilled) и запускают заново. Лимит — это ещё и бронь памяти на сервере.' },
    { key: 'cpuReq', label: 'Запрос CPU пода (requests)', type: 'select', def: DEF.cpuReq, feature: 'k8s',
      options: [[0.25, '0,25 ядра'], [0.5, '0,5 ядра'], [1, '1 ядро'], [2, '2 ядра']],
      help: 'Сколько ядер планировщик бронирует поду на сервере (сервер — 4 ядра). Бронь больше реального расхода — место кончается, новые поды ждут (Pending). Меньше расхода — поды набиваются плотнее, чем серверы вытянут, и в пик отнимают ядра друг у друга.' },
    tog('readiness', 'Проба готовности (readiness)', true, 'Под получает трафик, только когда сам ответил «готов». Без пробы новые поды при масштабировании и выкладке получают запросы ещё на старте — эти запросы падают.', { feature: 'k8s' })
  ];
  ['app', 'worker'].forEach(t => {
    if (!T[t]) return;
    PROPS.forEach(p => { if (!(T[t].props || []).some(x => x.key === p.key)) T[t].props = (T[t].props || []).concat([Object.assign({}, p)]); });
  });
  if (T.k8s) (T.k8s.props || []).forEach(p => {
    if (p.key === 'nodes' && !/4 ядра/.test(p.help || '')) p.help = (p.help || '') + ' Каждый сервер — 4 ядра и 16 ГБ: поды раскладываются по их брони (запрос CPU и лимит памяти).';
  });
  if (SD.PROP_SIMPLE) ['app', 'worker'].forEach(t => {
    const o = SD.PROP_SIMPLE[t] = SD.PROP_SIMPLE[t] || {};
    o.memLimit = 'Как рюкзак: вещей больше, чем он вмещает, — молния рвётся. У пода в Kubernetes есть потолок памяти. Под набирает память с нагрузкой и, пробив потолок, падает (OOMKilled); его перезапускают, он снова набирает — и снова падает (CrashLoopBackOff).';
    o.cpuReq = 'Как бронь столиков в ресторане. Столик на шестерых для двоих — зал «полон», а гости ждут у входа: так поды висят в Pending. Столик на двоих для четверых — сядут, но в час пик стулья отберут: так поды с заниженным запросом отнимают ядра друг у друга.';
    o.readiness = 'Новичка не ставят на кассу, пока он не прошёл инструктаж. Readiness-проба — такой инструктаж: пока под не ответил «готов», Kubernetes не шлёт ему запросы. Без пробы под получает запросы, пока ещё запускается, и отвечает ошибками.';
  });
  if (SD.OPT_SIMPLE) ['app', 'worker'].forEach(t => {
    SD.OPT_SIMPLE[t + '.memLimit'] = { 256: '256 МБ: хватит только почти без нагрузки — под падает уже на паре сотен запросов в секунду.', 512: '512 МБ: около тысячи запросов в секунду на под, у самых нагруженных подов — меньше.', 1024: '1 ГБ: обычный запас для пода на 2 ядра под полной нагрузкой.', 2048: '2 ГБ: с большим запасом, но и бронь на сервере больше — меньше подов поместится.' };
    SD.OPT_SIMPLE[t + '.cpuReq'] = { 0.25: '0,25 ядра: на сервер влезет 16 подов, но если каждый тратит больше, в пик они будут драться за ядра.', 0.5: '0,5 ядра: 8 подов на сервер.', 1: '1 ядро: 4 пода на сервер — честно для пода, который тратит около ядра.', 2: '2 ядра: всего 2 пода на сервер. Если под тратит меньше, бронь пустует, а новые поды ждут места.' };
    SD.OPT_SIMPLE[t + '.readiness'] = { true: 'Проба есть: трафик идёт только в готовые поды.', false: 'Пробы нет: под получает запросы, пока ещё запускается.' };
  });

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

  /* до трафика: кто в кластере, сколько подов хочет и кто поместился на серверы */
  function prepare(ctx) {
    const H = H0();
    const K = { svc: new Map(), clusters: [], done: false };
    ctx.k8s = K;
    const ramp = +ctx.opts.k8sRamp || 0;
    for (const c of ctx.nodes.values()) {
      if (c.type !== 'k8s') continue;
      const list = H.kids(ctx, c.id).filter(n => SVC.has(n.type) && !K.svc.has(n.id));
      if (!list.length) continue;
      const cl = { id: c.id, n: c, nodes: Math.max(1, Math.round(num(c.props.nodes, 3))), probes: c.props.probes !== false, list: [] };
      list.forEach(n => {
        const p = n.props || {};
        const P = Math.max(1, Math.round(H.count(ctx, n)));
        const min = Math.max(1, p.count || 1);
        /* нагрузка растёт, пока новые поды стартуют: готовы только те, что HPA заказал минуту-две назад */
        const Pnow = p.autoscale && ramp > 0 && P > min ? Math.max(min, Math.round(P / (1 + ramp))) : P;
        const S = { id: n.id, n, cl, P, Pnow, min, req: num(p.cpuReq, DEF.cpuReq), lim: num(p.memLimit, DEF.memLimit), vcpu: vcpuOf(n), per: perPod(ctx, n),
          readyProbe: p.readiness !== false && cl.probes, autoscale: !!p.autoscale, sched: 0, surge: ctx.opts.k8sRollout ? Math.max(1, Math.ceil(P * SURGE)) : 0, surgeSched: 0 };
        cl.list.push(S); K.svc.set(n.id, S);
      });
      /* планировщик: по очереди по сервисам, каждому поду — первый сервер, где хватает брони ядер и памяти */
      const free = Array.from({ length: cl.nodes }, () => ({ cpu: NODE_CORES, mem: NODE_MB }));
      const place = S => { const k = free.find(f => f.cpu + 1e-9 >= S.req && f.mem >= S.lim); if (!k) return false; k.cpu -= S.req; k.mem -= S.lim; return true; };
      const maxP = Math.max(...cl.list.map(S => S.P));
      for (let i = 0; i < maxP; i++) cl.list.forEach(S => { if (i < S.P && place(S)) S.sched++; });
      const maxS = Math.max(0, ...cl.list.map(S => S.surge));
      for (let i = 0; i < maxS; i++) cl.list.forEach(S => { if (i < S.surge && place(S)) S.surgeSched++; });
      cl.list.forEach(S => { S.pending = S.P - S.sched; });
      cl.cores = cl.nodes * NODE_CORES; cl.memMb = cl.nodes * NODE_MB;
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
        const ready = Math.min(S.sched, S.Pnow);
        S.readyPods = ready; S.starting = S.sched - ready;
        const warm = S.starting + S.surgeSched;
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
        S.g = Math.min(S.use, S.req); S.b = S.use - S.g;
        G += used * S.g; B += used * S.b; D += used * S.use;
      });
      cl.demand = D; cl.rho = 1;
      if (D > cl.cores + 1e-9 && B > 0) cl.rho = Math.max(0, Math.min(1, (cl.cores - G) / B));
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
      });
    });
    return K;
  }
  const svcOf = (ctx, n) => (ctx.k8s && ctx.k8s.svc.get(n.id)) || null;

  function isDead(ctx, n) {
    const S = svcOf(ctx, n); if (!S) return undefined;
    if (S.sched === 0) return true;   // ни один под не поместился на серверы
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
      nr: S.nr, readiness: S.readyProbe, autoscale: S.autoscale, util: S.util, down: S.down, rps: S.rps };
  }
  function collect(ctx, res, level, H) {
    const K = ctx.k8s; if (!K || !K.svc.size) return;
    settle(ctx, H);
    const out = { svc: {}, clusters: {} };
    K.clusters.forEach(cl => {
      out.clusters[cl.id] = { nodes: cl.nodes, cores: cl.cores, memGb: cl.memMb / 1024, cpuAsked: cl.cpuAsked, memAskedGb: cl.memAsked / 1024, demand: cl.demand, rho: cl.rho,
        pending: cl.list.reduce((s, S) => s + S.pending, 0), probes: cl.probes, svc: cl.list.map(S => S.id) };
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
      if (pend.length) A.push({ sev: 'bad', node: pend[0].id, text: `Pending: ${pend.map(s => `«${s.name}» — ${s.pending} из ${s.pods} ${podsOf(s.pods)}`).join(', ')} не поместились на серверы. Просят ${cores(c.cpuAsked)} и ${dec(c.memAskedGb)} ГБ, а в кластере ${cores(c.cores)} и ${c.memGb} ГБ (${c.nodes} × 4 ядра, 16 ГБ). Уменьши «Запрос CPU» до реального расхода или добавь серверов Kubernetes.` });
      if (c.rho < 0.999) A.push({ sev: 'bad', node: cid, text: `Серверам кластера не хватает ядер: подам нужно ≈ ${cores(c.demand)}, а есть ${cores(c.cores)}. Поды тратят больше, чем бронируют, и отнимают ядра друг у друга (CPU throttling). Добавь серверов или подними «Запрос CPU» до реального расхода.` });
    });
    Object.values(K.svc).forEach(s => {
      if (s.crash > 0) A.push({ sev: 'bad', node: s.id, text: `OOMKilled: ${s.crash} из ${s.ready} ${podsOf(s.ready)} «${s.name}» перезапускаются по кругу (CrashLoopBackOff). Самым нагруженным нужно до ≈ ${Math.round(s.memMax)} МБ, а лимит ${s.lim} МБ. Подними «Лимит памяти пода» или добавь подов — каждому достанется меньше запросов.` });
      else if (s.memMax > s.lim * 0.85 && s.rps > 0) A.push({ sev: 'warn', node: s.id, text: `«${s.name}»: поды занимают до ≈ ${Math.round(s.memMax)} МБ из ${s.lim} МБ. Небольшой рост нагрузки — и начнутся OOMKilled.` });
      if (s.nr > 0.001) A.push({ sev: 'bad', node: s.id, text: `«${s.name}»: без readiness-пробы ${Math.round(s.nr * 100)} % запросов идёт в поды, которые ещё стартуют, — это ошибки у пользователей.` });
      else if (!s.readiness) A.push({ sev: 'warn', node: s.id, text: `«${s.name}» без readiness-пробы: при масштабировании и выкладке новые поды получат запросы ещё до того, как будут готовы.` });
      if (s.down > 0 && graph.nodes.some(n => n.id === s.cluster && n.props.probes !== false)) A.push({ sev: 'info', node: s.id, text: `Kubernetes перезапускает упавший под «${s.name}»: через ≈ 1 минуту он снова в строю. Пока он поднимается, остальные тянут нагрузку сами.` });
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
  const goals = {
    deployed: () => custom('Сервисы развёрнуты в Kubernetes', g => {
      const s = SD.opsState(g), svcs = s.svcs.filter(n => SVC.has(n.type)), miss = svcs.filter(n => !s.k8s.has(n.id)).map(lbl);
      return { ok: svcs.length > 0 && !miss.length, detail: !svcs.length ? 'сервисов нет' : miss.length ? 'не в кластере: ' + miss.join(', ') : 'все в кластере' };
    }),
    noOom: () => custom('Поды не падают по памяти (нет OOMKilled)', (g, res) => {
      const list = managed(res); if (!list.length) return { ok: false, detail: 'нет сервисов в Kubernetes' };
      const bad = list.filter(s => s.crash > 0);
      return { ok: !bad.length, detail: bad.length ? bad.map(s => `OOMKilled: ${s.crash} из ${s.ready} ${podsOf(s.ready)} «${s.name}» перезапускаются`).join('; ') : `память до ≈ ${Math.round(Math.max(...list.map(s => s.memMax)))} МБ — в лимите` };
    }),
    noPending: () => custom('Все поды поместились на серверы (нет Pending)', (g, res) => {
      const list = managed(res); if (!list.length) return { ok: false, detail: 'нет сервисов в Kubernetes' };
      const bad = list.filter(s => s.pending > 0);
      return { ok: !bad.length, detail: bad.length ? bad.map(s => `Pending: ${s.pending} ${pods(s.pending)} «${s.name}» не ${s.pending === 1 ? 'поместился' : 'поместились'}`).join('; ') : `запущено ${list.reduce((a, s) => a + s.sched, 0)} ${pods(list.reduce((a, s) => a + s.sched, 0))}` };
    }),
    honestReq: () => custom('Запрос CPU по делу: не меньше реального расхода и не больше двух', (g, res) => {
      const list = managed(res).filter(s => s.rps > 0); if (!list.length) return { ok: false, detail: 'нет сервисов в Kubernetes с нагрузкой' };
      const low = list.filter(s => s.req < s.usePlan * 0.95), high = list.filter(s => s.req > Math.max(s.usePlan * 2, 0.25));
      const s = low[0] || high[0];
      return { ok: !low.length && !high.length, detail: s ? `«${s.name}»: под тратит ≈ ${cores(s.usePlan)}, а бронирует ${cores(s.req)} — ${low.length ? 'в пик соседи отнимут недостающее' : 'бронь пустует, место на серверах пропадает'}` : list.map(x => `под тратит ≈ ${cores(x.usePlan)}, бронирует ${cores(x.req)}`).join('; ') };
    }),
    peak: (mul, ramp, min) => custom(`Утренний пик ×${String(mul).replace('.', ',')}: нагрузка растёт, пока поды стартуют (успешно ≥ ${Math.round(min * 100)} %)`, (g, res, L) => {
      const r = SD.sim.run(L, g, { mul, k8sRamp: ramp });
      const ok = r.total.success >= min, why = [];
      managed(r).forEach(s => {
        if (s.pending) why.push(`Pending: ${s.pending} ${pods(s.pending)}`);
        if (s.nr > 0.001) why.push(`${Math.round(s.nr * 100)} % запросов в неготовые поды`);
        if (s.crash) why.push(`OOMKilled: ${s.crash} из ${s.ready}`);
        if (s.throttle > 0.01) why.push('поды делят ядра (throttling)');
        if (s.util > 1) why.push(`готово ${s.ready} из ${s.pods} ${podsOf(s.pods)}, загрузка ${Math.round(s.util * 100)} %`);
      });
      return { ok, detail: `при ×${String(mul).replace('.', ',')} успешно ${SD.fmt.pct(r.total.success)}${!ok && why.length ? ': ' + why.join(', ') : ''}` };
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
    })
  ];
  if (SD.OPSL) LEVELS.forEach(L => { if (!SD.OPSL.some(x => x.id === L.id)) SD.OPSL.push(L); });

  SD.k8s = { NODE_CORES, NODE_MB, goals, advice: k8sAdvice, levels: LEVELS };
})();
