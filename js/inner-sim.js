/* Внутри сервиса: модель компонентов, влияние на площадку, проверки архитектуры, сборка по схеме, трасса запроса. */
(function () {
  const T = () => SD.CTYPES;
  const LI = SD.CLAYER_IDX;
  const SVC = new Set(['app', 'worker']);
  const READ = new Set(['read', 'bot', 'search', 'geo', 'static', 'feed', 'range']);
  const WRITE = new Set(['write', 'upload']);
  const kindClass = k => READ.has(k) ? 'read' : WRITE.has(k) ? 'write' : k === 'job' ? 'job' : null;
  const has = n => !!(n && n.props && n.props.inner && n.props.inner.nodes && n.props.inner.nodes.length);
  const nameOf = c => c.label || T()[c.type].name;
  const outerName = o => o.label || (SD.TYPES[o.type] ? SD.TYPES[o.type].name : o.type);
  const ADAPTER_FOR = { sql: 'repo', nosql: 'repo', graphdb: 'repo', tsdb: 'repo', olap: 'repo', cache: 'cachecl', queue: 'pub', objstore: 'objcl', search: 'searchcl', vectordb: 'searchcl', app: 'httpcl', external: 'httpcl', faas: 'httpcl', llm: 'httpcl', router: 'httpcl', agent: 'httpcl', esb: 'httpcl', gateway: 'httpcl', semcache: 'httpcl', guard: 'httpcl' };
  const OUTER_LAT = { sql: 6, nosql: 4, cache: 1, queue: 3, external: 300, app: 25, objstore: 30, search: 15, vectordb: 8, llm: 600 };

  function ensure(n) {
    if (!n.props.inner) n.props.inner = { rt: SD.CRT_DEF(), nodes: [], edges: [], seq: 1 };
    const I = n.props.inner;
    I.rt = Object.assign(SD.CRT_DEF(), I.rt || {});
    I.nodes = I.nodes || []; I.edges = I.edges || [];
    I.seq = I.seq || (I.nodes.length + I.edges.length + 1);
    I.nodes.forEach(c => { c.props = Object.assign(SD.cdefaults(c.type), c.props || {}); });
    return I;
  }

  function outerOf(n, g) {
    const by = id => g.nodes.find(x => x.id === id);
    return {
      kids: g.edges.filter(e => e.from === n.id).map(e => ({ node: by(e.to), edge: e })).filter(x => x.node),
      callers: g.edges.filter(e => e.to === n.id).map(e => ({ node: by(e.from), edge: e })).filter(x => x.node)
    };
  }

  function model(n, g) {
    const I = n.props.inner || { nodes: [], edges: [], rt: SD.CRT_DEF() };
    const comps = I.nodes.filter(c => T()[c.type]).map(c => Object.assign({}, c, { props: Object.assign(SD.cdefaults(c.type), c.props || {}), t: T()[c.type] }));
    const by = new Map(comps.map(c => [c.id, c]));
    const out = new Map(comps.map(c => [c.id, []])), inn = new Map(comps.map(c => [c.id, []]));
    const edges = I.edges.filter(e => by.has(e.from) && by.has(e.to) && e.from !== e.to);
    edges.forEach(e => { out.get(e.from).push(by.get(e.to)); inn.get(e.to).push(by.get(e.from)); });
    const M = { n, g, I, rt: Object.assign(SD.CRT_DEF(), I.rt || {}), comps, by, out, inn, edges, outer: g ? outerOf(n, g) : { kids: [], callers: [] } };
    const taken = new Map();
    comps.forEach(c => {
      const t = c.t;
      if (t.consumer) { const q = M.outer.callers.filter(x => x.node.type === 'queue'); c.bound = q.find(x => x.node.id === c.bind) || q[0] || null; return; }
      if (!t.binds) { c.bound = null; return; }
      const ok = M.outer.kids.filter(k => t.binds.includes(k.node.type));
      let b = ok.find(k => k.node.id === c.bind);
      if (!b) { const used = taken.get(c.type) || new Set(); b = ok.find(k => !used.has(k.node.id)) || ok[0] || null; }
      if (b) { if (!taken.has(c.type)) taken.set(c.type, new Set()); taken.get(c.type).add(b.node.id); }
      c.bound = b || null;
    });
    return M;
  }

  /* ---------- пути запросов ---------- */
  const handles = (c, k) => { const v = c.props.kinds || 'both'; return v === 'both' || v === k; };
  function entriesFor(M, k) {
    if (k === 'job') return M.comps.filter(c => c.t.consumer);
    return M.comps.filter(c => c.t.entry && !c.t.consumer && c.type !== 'cron' && handles(c, k));
  }
  const isImpl = (a, b) => a.t.layer === 'infra' && b.type === 'port';
  function next(M, c, k) {
    let list = M.out.get(c.id).filter(x => !isImpl(c, x));
    if (c.type === 'port') list = M.inn.get(c.id).filter(a => a.t.layer === 'infra');
    list = list.filter(x => !(x.type === 'usecase' && (k === 'read' || k === 'write') && !handles(x, k)) && !(x.type === 'query' && k === 'write'));
    return list.slice().sort((a, b) => (a.y || 0) - (b.y || 0));
  }
  function reachFrom(M, starts, k) {
    const seen = new Set(), st = starts.slice();
    while (st.length) { const c = st.pop(); if (seen.has(c.id)) continue; seen.add(c.id); next(M, c, k).forEach(x => st.push(x)); }
    return [...seen].map(id => M.by.get(id));
  }
  const reach = (M, k) => reachFrom(M, entriesFor(M, k), k);

  /* ---------- влияние на площадку ---------- */
  function effectsOf(M) {
    const rt = SD.CRUNTIME[M.rt.rt] || SD.CRUNTIME.java;
    let cpu = rt.cpu * (SD.CLOG[M.rt.log] || 1) * (SD.CTRACE[M.rt.trace] || 1);
    const lat = { read: 0, write: 0 };
    let dbRead = 1, dbReadLat = 1;
    let introspect = false;
    ['read', 'write'].forEach(k => {
      const ents = entriesFor(M, k);
      let pl = 0;
      ents.forEach(e => {
        const p = e.props.pipe || []; let l = 0;
        if (p.includes('auth') && e.props.auth === 'introspect') { l += 15; introspect = true; }
        if (p.includes('rl')) l += 1;
        if (k === 'write' && p.includes('idem')) l += 2;
        pl = Math.max(pl, l);
      });
      lat[k] = pl;
      if (k === 'read') {
        reach(M, 'read').forEach(c => { if (c.type === 'repo') { const f = SD.CFETCH[c.props.fetch] || SD.CFETCH.join; dbRead = Math.max(dbRead, f.db); dbReadLat = Math.max(dbReadLat, f.lat); } });
        ents.forEach(e => { if (e.type === 'graphql' && !e.props.dataloader) { dbRead = Math.max(dbRead, 6); dbReadLat = Math.max(dbReadLat, 6); } });
      }
    });
    if (introspect) cpu *= 1.04;
    return { cpu, wait: rt.wait, pool: M.rt.pool, dbRead, dbReadLat, lat, rt };
  }
  const memo = new WeakMap();
  function effects(n) {
    const I = n.props.inner, sig = JSON.stringify(I);
    const m = memo.get(I);
    if (m && m.sig === sig) return m.fx;
    const fx = effectsOf(model(n, null));
    memo.set(I, { sig, fx });
    return fx;
  }

  SD.simExts = SD.simExts || [];
  SD.simExts.push({
    routePost(ctx, n, kind, r) {
      if (!SVC.has(n.type) || !has(n)) return;
      const fx = effects(n);
      r.u *= fx.cpu;
      const cls = kindClass(kind);
      if (cls === 'read' && fx.dbRead !== 1) r.fwd.forEach(f => {
        const t = ctx.nodes.get(f.to);
        if (t && (t.type === 'sql' || t.type === 'nosql') && f.mode === 'seq') { const b = Math.min(f.f, 1); f.f *= fx.dbRead; f.latMul = b * fx.dbReadLat; }
      });
      if (cls && fx.lat[cls]) r.lat += fx.lat[cls];
    },
    waitMul(ctx, n) { return SVC.has(n.type) && has(n) ? effects(n).wait : undefined; },
    poolSize(ctx, n) { return SVC.has(n.type) && has(n) ? effects(n).pool : undefined; }
  });

  /* признаки, которые узел площадки берёт из устройства сервиса */
  function syncFlags(n, g) {
    if (!has(n)) return [];
    const M = model(n, null), ch = [];
    const set = (k, v, label) => { if (!!n.props[k] !== v) { n.props[k] = v; ch.push(label + (v ? ' включён' : ' выключен')); } };
    if (n.type === 'app') {
      set('outbox', M.comps.some(c => c.type === 'outbox'), 'Outbox');
      set('idempotency', entriesFor(M, 'write').some(e => (e.props.pipe || []).includes('idem')), 'Ключ идемпотентности');
    }
    if (n.type === 'worker') set('dedup', M.comps.some(c => c.t.consumer && c.props.inbox), 'Inbox');
    if (g) M.comps.filter(c => c.t.consumer).forEach(c => {
      const qs = g.edges.filter(e => e.to === n.id).map(e => g.nodes.find(x => x.id === e.from)).filter(x => x && x.type === 'queue');
      const q = qs.find(x => x.id === c.bind) || qs[0];
      if (!q) return;
      const sem = c.props.ack === 'before' ? 'most' : q.props.semantics === 'most' ? 'least' : (q.props.semantics || 'least');
      if ((q.props.semantics || 'least') !== sem) { q.props.semantics = sem; ch.push('«' + outerName(q) + '»: ' + (sem === 'most' ? 'at-most-once' : 'at-least-once')); }
      const rt = c.props.dlq !== 'none';
      if (!!q.props.retries !== rt) { q.props.retries = rt; ch.push('«' + outerName(q) + '»: повторы и DLQ ' + (rt ? 'включены' : 'выключены')); }
    });
    return ch;
  }

  /* ---------- проверки архитектуры ---------- */
  const DEP = {
    'in>infra': { sev: 'bad', pat: 'layered', text: (a, b) => `«${nameOf(a)}» ходит в «${nameOf(b)}» напрямую, мимо сценария`, why: 'Бизнес-логика оседает в контроллере: её нельзя вызвать из консьюмера или теста без HTTP. Это «толстый контроллер».', fix: 'Вставь сценарий (use case) между входом и адаптером.' },
    'in>dom': { sev: 'warn', pat: 'layered', text: (a, b) => `«${nameOf(a)}» управляет доменом «${nameOf(b)}» сам`, why: 'Кто-то должен держать транзакцию и порядок шагов. Это работа сценария, а не контроллера.', fix: 'Пусть вход вызывает сценарий, а сценарий — домен.' },
    'app>in': { sev: 'bad', pat: 'hexagonal', text: (a, b) => `Сценарий «${nameOf(a)}» вызывает входной адаптер «${nameOf(b)}»`, why: 'Зависимость направлена наружу: сценарий не должен знать, как его вызывают.', fix: 'Убери связь: вход зовёт сценарий, а не наоборот.' },
    'dom>infra': { sev: 'bad', pat: 'hexagonal', text: (a, b) => `Домен «${nameOf(a)}» знает про «${nameOf(b)}»`, why: 'Модель зависит от базы или брокера: её не протестировать без инфраструктуры. Зависимости должны указывать к домену.', fix: 'Домен объявляет порт, адаптер реализует его стрелкой к порту.' },
    'dom>app': { sev: 'bad', pat: 'hexagonal', text: (a, b) => `Домен «${nameOf(a)}» вызывает сценарий «${nameOf(b)}»`, why: 'Домен — центр системы. Он не знает о сценариях, транзакциях и вызовах.', fix: 'Пусть домен порождает событие, а сценарий на него реагирует.' },
    'dom>in': { sev: 'bad', pat: 'hexagonal', text: (a, b) => `Домен «${nameOf(a)}» вызывает вход «${nameOf(b)}»`, why: 'Зависимость направлена наружу.', fix: 'Убери связь.' },
    'infra>in': { sev: 'bad', pat: 'hexagonal', text: (a, b) => `Адаптер «${nameOf(a)}» вызывает вход «${nameOf(b)}»`, why: 'Адаптеры выхода не управляют входом.', fix: 'Убери связь.' },
    'infra>app': { sev: 'warn', pat: 'hexagonal', text: (a, b) => `Адаптер «${nameOf(a)}» запускает сценарий «${nameOf(b)}»`, why: 'Адаптер выхода не должен запускать бизнес-логику. Если он обрабатывает сообщения — это консьюмер на входе.', fix: 'Перенеси обработку во входной адаптер (консьюмер).' }
  };
  const SEV = { bad: 0, warn: 1, info: 2, good: 3 };

  function analyze(n, g, res) {
    const M = model(n, g), F = [];
    const fx = effectsOf(M);
    const add = (sev, id, text, why, o) => F.push(Object.assign({ sev, id, text, why }, o || {}));
    const q = c => `«${nameOf(c)}»`;
    const R = res && res.nodes && res.nodes[n.id];
    const inst = R ? Math.max(1, R.alive || R.count || 1) : (n.props.count || 1);
    if (!M.comps.length) {
      add('info', 'empty', 'Внутри сервиса пока пусто.', 'Нажми «Собрать по схеме» — компоненты появятся из связей сервиса на площадке. Или перетащи их из палитры.');
      return { M, findings: F, fx, counts: { bad: 0, warn: 0, good: 0 } };
    }
    const hasPorts = M.comps.some(c => c.type === 'port');

    /* направление зависимостей */
    let layerBad = 0;
    M.edges.forEach(e => {
      const a = M.by.get(e.from), b = M.by.get(e.to);
      if (isImpl(a, b)) return;
      const key = a.t.layer + '>' + b.t.layer;
      if (key === 'app>infra') {
        if (hasPorts) add('warn', 'dep-app-infra', `Сценарий «${nameOf(a)}» зависит от адаптера «${nameOf(b)}» мимо порта`, 'Сценарий привязан к конкретной технологии. Тест без базы и замена хранилища потребуют правок сценария.', { comps: [a.id, b.id], edges: [e.id], pat: 'dip', fix: 'Направь сценарий в порт, а адаптер — стрелкой к порту.' });
        else add('info', 'dep-app-infra', `Слоистая архитектура: «${nameOf(a)}» зовёт «${nameOf(b)}» напрямую`, 'Для простого сервиса это нормально. Порты понадобятся, когда захочешь тестировать сценарии без базы или менять технологии.', { comps: [a.id, b.id], edges: [e.id], pat: 'layered' });
        return;
      }
      const r = DEP[key];
      if (!r) return;
      if (r.sev === 'bad') layerBad++;
      add(r.sev, 'dep-' + key, r.text(a, b), r.why, { comps: [a.id, b.id], edges: [e.id], pat: r.pat, fix: r.fix });
    });

    /* циклы */
    const color = new Map(), cycles = [];
    const dfs = (c, stack) => {
      color.set(c.id, 1); stack.push(c);
      M.out.get(c.id).forEach(x => {
        if (isImpl(c, x)) return;
        if (color.get(x.id) === 1) { const i = stack.findIndex(s => s.id === x.id); cycles.push(stack.slice(i)); }
        else if (!color.get(x.id)) dfs(x, stack);
      });
      stack.pop(); color.set(c.id, 2);
    };
    M.comps.forEach(c => { if (!color.get(c.id)) dfs(c, []); });
    cycles.slice(0, 2).forEach(cy => add('bad', 'cycle', `Цикл зависимостей: ${cy.map(q).join(' → ')} → ${q(cy[0])}`, 'Компоненты нельзя собрать, протестировать и изменить по отдельности. Изменение в одном расходится кругами.', { comps: cy.map(c => c.id), pat: 'spaghetti', fix: 'Разверни одну зависимость через порт или событие.' }));

    /* порты */
    M.comps.filter(c => c.type === 'port').forEach(p => {
      const impl = M.inn.get(p.id).filter(x => x.t.layer === 'infra');
      const users = M.inn.get(p.id).filter(x => x.t.layer !== 'infra');
      if (!impl.length) add('bad', 'port-noimpl', `Порт ${q(p)} никто не реализует`, 'Контейнер зависимостей не найдёт реализацию — сервис не стартует. Нужен адаптер со стрелкой к порту.', { comps: [p.id], pat: 'di', fix: 'Добавь адаптер в инфраструктуре и протяни стрелку от него к порту.' });
      if (!users.length) add('warn', 'port-unused', `Порт ${q(p)} никем не используется`, 'Интерфейс без потребителя — лишний код.', { comps: [p.id], pat: 'yagni' });
      impl.forEach(a => { if (a.t.role && a.t.role !== p.props.role) add('warn', 'port-role', `${q(a)} реализует порт ${q(p)} другого назначения`, 'Адаптер кэша не может быть реализацией репозитория: контракт не совпадает.', { comps: [a.id, p.id], pat: 'lsp' }); });
    });

    /* сироты и тупики */
    M.comps.forEach(c => {
      const io = M.out.get(c.id).length + M.inn.get(c.id).length;
      if (!io) add('warn', 'orphan', `${q(c)} ни с чем не связан`, 'Компонент без связей — мёртвый код или забытая связь.', { comps: [c.id] });
      else if (c.t.entry && !M.out.get(c.id).length) add('warn', 'entry-dead', `Вход ${q(c)} никого не вызывает`, 'Запрос дойдёт до входа и дальше никуда не пойдёт.', { comps: [c.id], fix: 'Протяни связь от входа к сценарию.' });
      if ((c.type === 'usecase' || c.type === 'dservice') && M.out.get(c.id).length >= 6) add('warn', 'god', `${q(c)} зависит от ${M.out.get(c.id).length} компонентов`, 'Сценарий делает слишком много: его трудно понять и тестировать. Признак божественного объекта.', { comps: [c.id], pat: 'godobject', fix: 'Раздели на несколько сценариев или вынеси правило в доменный сервис.' });
    });

    /* соответствие схеме контейнеров (C4) */
    M.comps.forEach(c => {
      if (c.t.binds && !c.bound) add('bad', 'bind-missing', `${q(c)}: на площадке у сервиса нет связи с ${c.t.binds.slice(0, 2).map(t => (SD.TYPES[t] || { name: t }).name.toLowerCase()).join(' или ')}`, 'Код ходит туда, куда на схеме контейнеров стрелки нет: схема врёт или адаптер лишний.', { comps: [c.id], fix: 'Проведи связь на площадке или удали адаптер.' });
      if (c.t.consumer && !c.bound) add('warn', 'bind-missing', `${q(c)}: на площадке в сервис не входит ни один брокер`, 'Консьюмеру нечего читать.', { comps: [c.id] });
    });
    M.outer.kids.forEach(k => {
      const need = ADAPTER_FOR[k.node.type];
      if (!need) return;
      const backed = M.comps.some(c => c.bound && c.bound.node.id === k.node.id);
      if (!backed) add('warn', 'outer-unbacked', `На площадке сервис ходит в «${outerName(k.node)}», а в коде нет адаптера`, `Нужен «${T()[need].name}»: иначе непонятно, кто и как делает этот вызов.`, { fix: `Добавь «${T()[need].name}» — он сам привяжется к «${outerName(k.node)}».` });
    });
    if (R && R.load) {
      const cls = new Set(Object.entries(R.load).filter(([, v]) => v > 0.5).map(([k]) => kindClass(k)).filter(Boolean));
      if (cls.has('read') && !entriesFor(M, 'read').length) add('warn', 'entry-missing', 'Сервис получает чтения, но ни один вход их не принимает', 'Запросы GET дойдут до сервиса и упрутся в отсутствие обработчика.', { fix: 'Добавь вход или поставь «Чтение и запись» у существующего.' });
      if (cls.has('write') && !entriesFor(M, 'write').length) add('warn', 'entry-missing', 'Сервис получает записи, но ни один вход их не принимает', 'Запросы POST останутся без обработчика.');
      if (cls.has('job') && !entriesFor(M, 'job').length) add('warn', 'entry-missing', 'Из брокера приходят сообщения, но консьюмера нет', 'Сообщения будут копиться в очереди.', { fix: 'Добавь консьюмер на входе.' });
    }

    /* N+1 */
    const readSet = reach(M, 'read');
    const dbFlow = c => { if (!res || !c.bound) return null; const er = res.edges[c.bound.edge.id]; return er ? er.flow : null; };
    readSet.filter(c => c.type === 'repo' && c.props.fetch === 'lazy').forEach(c => {
      const fl = dbFlow(c);
      add('bad', 'nplus1', `${q(c)} грузит связанные данные лениво: N+1`, `Список из 10 строк превращается в 11 запросов к базе.${fl != null ? ` Сейчас в «${outerName(c.bound.node)}» летит ${SD.fmt.num(fl)} запросов в секунду.` : ''}`, { comps: [c.id], pat: 'nplus1', fix: 'Загружай связанные данные одним JOIN или пачкой WHERE id = ANY(…).' });
    });
    if (readSet.some(c => c.type === 'repo') && !readSet.some(c => c.type === 'repo' && c.props.fetch === 'lazy') && !entriesFor(M, 'read').some(e => e.type === 'graphql' && !e.props.dataloader)) add('good', 'n1-ok', 'Чтение без N+1: связанные данные грузятся одним запросом или пачкой', 'База получает столько запросов, сколько нужно, а не в 10 раз больше.');
    M.comps.filter(c => c.type === 'graphql').forEach(c => {
      if (!c.props.dataloader) add('bad', 'gql-n1', `${q(c)} без DataLoader: N+1 на вложенных полях`, 'Резолвер вложенного поля вызывается для каждого элемента списка.', { comps: [c.id], pat: 'nplus1', fix: 'Включи DataLoader: он соберёт id в пачку.' });
      if (!c.props.depth) add('warn', 'gql-depth', `${q(c)} без лимита глубины`, 'Один злой запрос с глубокой вложенностью положит базу.', { comps: [c.id], pat: 'ratelimit' });
    });

    /* клиенты к соседям */
    const writeSet = reach(M, 'write');
    M.comps.filter(c => c.type === 'httpcl' && c.bound).forEach(c => {
      const p = Object.assign(SD.edgeDefaults(), c.bound.edge.props || {});
      if (!p.timeout) add('bad', 'notimeout', `${q(c)} без таймаута`, `Если «${outerName(c.bound.node)}» зависнет, потоки сервиса будут ждать вечно и сервис ляжет следом.`, { comps: [c.id], pat: 'notimeout', fix: 'Поставь таймаут в инспекторе клиента — он совпадает со стрелкой на площадке.' });
      if (p.retries && p.backoff !== 'exp') add('warn', 'retry-nobackoff', `${q(c)} повторяет сразу, без паузы`, 'При перегрузке соседа мгновенные повторы умножают нагрузку — шторм повторов.', { comps: [c.id], pat: 'retrystorm', fix: 'Экспоненциальная пауза с джиттером.' });
      if (p.retries && writeSet.includes(c) && !c.props.idemKey) add('warn', 'retry-noidem', `${q(c)} повторяет запись без ключа идемпотентности`, 'Ответ потерялся по таймауту, а сосед операцию выполнил. Повтор создаст дубль.', { comps: [c.id], pat: 'idempotency' });
      if (c.bound.node.type === 'external' && !p.cb) add('info', 'no-cb', `${q(c)} без предохранителя`, 'Когда внешний API лежит, предохранитель сразу отбивает вызовы и не тратит потоки на ожидание.', { comps: [c.id], pat: 'circuitbreaker' });
    });

    /* двойная запись и outbox */
    const hasOutbox = M.comps.some(c => c.type === 'outbox');
    M.comps.filter(c => c.type === 'usecase' && handles(c, 'write')).forEach(u => {
      const r = reachFrom(M, [u], 'write');
      const repo = r.some(c => c.type === 'repo');
      const direct = r.filter(c => c.type === 'pub' && c.props.mode === 'direct');
      if (repo && direct.length && !hasOutbox) add('bad', 'dualwrite', `${q(u)} пишет в базу и отдельно публикует событие`, 'Двойная запись: если процесс упадёт между коммитом и отправкой, событие потеряется. Если отправить до коммита — уйдёт событие без данных.', { comps: [u.id, ...direct.map(c => c.id)], pat: 'dualwrite', fix: 'Публикатор в режиме outbox и Outbox-реле: событие пишется в той же транзакции.' });
      if (u.props.tx === 'usecase' && u.props.extInTx && r.some(c => c.type === 'httpcl')) add('warn', 'ext-in-tx', `${q(u)} зовёт соседа внутри транзакции`, 'Пока ждём ответа, транзакция держит соединение из пула и блокировки строк. Медленный сосед выедает пул.', { comps: [u.id], pat: 'uow', fix: 'Сначала вызов, потом короткая транзакция. Или событие после коммита.' });
      if (u.props.tx === 'none' && r.filter(c => c.type === 'repo' || (c.type === 'pub' && c.props.mode === 'outbox')).length >= 2) add('warn', 'no-tx', `${q(u)} пишет несколько раз без транзакции`, 'Падение посередине оставит половину изменений.', { comps: [u.id], pat: 'uow' });
    });
    M.comps.filter(c => c.type === 'pub' && c.props.mode === 'outbox').forEach(c => { if (!hasOutbox) add('bad', 'outbox-norelay', `${q(c)} пишет в outbox, но реле нет`, 'События лягут в таблицу и останутся там навсегда.', { comps: [c.id], pat: 'outbox', fix: 'Добавь Outbox-реле, привязанное к брокеру.' }); });
    if (hasOutbox) {
      if (!M.comps.some(c => c.type === 'repo')) add('warn', 'outbox-norepo', 'Outbox-реле есть, а репозитория нет', 'Outbox — таблица в той же базе, что и данные. Без базы ему нечего читать.', { pat: 'outbox' });
      else if (!F.some(f => f.id === 'dualwrite')) add('good', 'outbox-ok', 'Событие и данные пишутся одной транзакцией (outbox)', 'Ни потерянных событий, ни событий без данных.', { pat: 'outbox' });
    }

    /* консьюмер */
    M.comps.filter(c => c.t.consumer).forEach(c => {
      if (c.props.ack === 'before') add('bad', 'ack-before', `${q(c)} подтверждает сообщение до записи`, 'Процесс упал после ack, но до коммита — сообщение потеряно навсегда.', { comps: [c.id], pat: 'inbox', fix: 'Подтверждать после коммита.' });
      if (!c.props.inbox) add('warn', 'no-inbox', `${q(c)} не защищён от дублей`, 'Брокер доставляет хотя бы один раз: после ребаланса или таймаута сообщение придёт снова.', { comps: [c.id], pat: 'inbox', fix: 'Inbox: таблица обработанных id в той же транзакции.' });
      if (c.props.dlq === 'none') add('warn', 'no-dlq', `${q(c)} повторяет битые сообщения бесконечно`, 'Одно ядовитое сообщение блокирует партицию: всё, что за ним, стоит.', { comps: [c.id], pat: 'dlq' });
      if (c.props.ack === 'after' && c.props.inbox && c.props.dlq !== 'none') add('good', 'consumer-ok', `${q(c)}: ack после коммита, inbox и DLQ`, 'Ни потерь, ни дублей, ни застрявшей очереди.', { pat: 'inbox' });
    });
    M.comps.filter(c => c.type === 'cron').forEach(c => {
      if (c.props.lock === 'none' && inst > 1) add('bad', 'cron-dup', `${q(c)} запустится на каждом из ${inst} экземпляров`, `Начисление пройдёт ${inst} раза, письмо уйдёт ${inst} раза.`, { comps: [c.id], fix: 'Блокировка в БД (ShedLock) или выбор лидера.' });
    });

    /* вход: аутентификация, идемпотентность, наблюдаемость */
    const entries = M.comps.filter(c => c.t.entry && !c.t.consumer && c.type !== 'cron');
    entries.forEach(e => {
      const p = e.props.pipe || [];
      if (p.includes('auth') && e.props.auth === 'introspect') add('warn', 'introspect', `${q(e)} проверяет токен запросом в auth-сервис`, '+15 мс к каждому запросу и жёсткая зависимость: лёг auth — лёг сервис.', { comps: [e.id], fix: 'JWT с проверкой подписи локально и коротким сроком жизни.' });
      if (e.type === 'rest' && !e.props.dto) add('info', 'no-dto', `${q(e)} отдаёт сущности наружу`, 'Любое изменение модели ломает клиентов, а наружу утекают лишние поля.', { comps: [e.id] });
    });
    const upstreamRetries = M.outer.callers.some(c => c.edge.props && c.edge.props.retries > 0);
    entriesFor(M, 'write').forEach(e => {
      if (!(e.props.pipe || []).includes('idem') && (upstreamRetries || writeSet.some(c => c.type === 'httpcl'))) add('warn', 'idem-missing', `${q(e)} принимает записи без ключа идемпотентности`, 'Клиент повторит запрос после таймаута, и операция выполнится дважды.', { comps: [e.id], pat: 'idempotency' });
    });
    if (!entries.some(e => (e.props.pipe || []).includes('trace')) && M.rt.trace === 'off' && entries.length) add('warn', 'no-trace', 'Нет ни correlation id, ни трассировки', 'Когда запрос тормозит, не найти, в каком сервисе и на каком шаге теряется время.', { pat: 'correlation' });
    if (M.rt.log === 'debug') add('warn', 'debug-log', 'Логи DEBUG в продакшене', 'Форматирование и запись логов съедают CPU: на площадке это видно как +25 % к цене запроса.', { pat: 'observability' });
    if (!M.rt.health) add('warn', 'no-health', 'Нет liveness и readiness проб', 'Балансировщик шлёт трафик в экземпляр, который ещё не подключился к базе или завис.', { pat: 'healthcheck' });
    if (!M.rt.graceful) add('warn', 'no-graceful', 'Нет плавной остановки', 'Каждый деплой обрывает запросы на лету — пользователи видят ошибки.');

    /* домен */
    const writers = M.comps.filter(c => c.type === 'usecase' && handles(c, 'write'));
    if (writers.length && !M.comps.some(c => c.type === 'aggregate' || c.type === 'dservice')) add('info', 'anemic', 'Правила живут в сценариях: доменной модели нет', 'Для CRUD это нормально. Когда правил станет много, они расползутся по сценариям и начнут дублироваться.', { pat: 'anemic' });
    M.comps.filter(c => c.type === 'aggregate' && !c.props.rich).forEach(c => add('warn', 'anemic', `${q(c)} — анемичная модель`, 'Сущность только хранит поля, а проверки разбросаны по сервисам. Инварианты легко нарушить.', { comps: [c.id], pat: 'anemic' }));
    M.comps.filter(c => c.type === 'query').forEach(c => { if (reachFrom(M, [c], 'read').some(x => x.type === 'aggregate')) add('info', 'query-agg', `${q(c)} читает через агрегат`, 'Для чтения не нужны инварианты: плоский запрос в read-модель быстрее.', { comps: [c.id], pat: 'cqrs' }); });
    M.comps.filter(c => c.type === 'saga').forEach(c => {
      if (!c.props.compensate) add('bad', 'saga-nocomp', `${q(c)} без компенсаций`, 'Если третий шаг упадёт, деньги списаны, а заказа нет.', { comps: [c.id], pat: 'saga-p' });
      if (!c.props.persist) add('warn', 'saga-mem', `${q(c)} держит состояние в памяти`, 'Рестарт посреди саги — и никто не знает, на каком она шаге.', { comps: [c.id], pat: 'saga-p' });
    });
    M.comps.filter(c => c.type === 'cachecl').forEach(c => { if (!c.props.single) add('info', 'stampede', `${q(c)} без защиты от stampede`, 'Популярный ключ истёк — и тысяча запросов одновременно идут в базу.', { comps: [c.id], pat: 'stampede' }); });
    M.comps.filter(c => c.type === 'usecase' && c.props.cache === 'aside').forEach(u => { if (!reachFrom(M, [u], 'read').some(c => c.type === 'cachecl')) add('warn', 'cache-noclient', `${q(u)} читает через кэш, но клиента кэша у него нет`, 'Сценарий должен вызывать порт кэша, а адаптер — ходить в Redis.', { comps: [u.id], pat: 'cacheaside' }); });

    /* модули */
    const mods = new Set(M.comps.map(c => c.module).filter(Boolean));
    if (mods.size) {
      const mg = new Map();
      M.edges.forEach(e => {
        const a = M.by.get(e.from), b = M.by.get(e.to);
        if (!a.module || !b.module || a.module === b.module) return;
        if (!mg.has(a.module)) mg.set(a.module, new Set());
        mg.get(a.module).add(b.module);
        if (b.type === 'repo' || (b.type === 'port' && b.props.role === 'repo')) add('bad', 'mod-db', `Модуль «${a.module}» лезет в хранилище модуля «${b.module}»`, 'Модули связаны через таблицы: изменить схему одного нельзя, не сломав другой. Выделить модуль в сервис не получится.', { comps: [a.id, b.id], edges: [e.id], pat: 'shareddb', fix: `Вызывай публичный API модуля «${b.module}» или подпишись на его события.` });
        else if (!b.props.api) add('warn', 'mod-private', `«${nameOf(a)}» обходит публичный API модуля «${b.module}»`, 'Внутренности модуля стали частью чужого кода. Модуль больше нельзя менять свободно.', { comps: [a.id, b.id], edges: [e.id], pat: 'modmono', fix: `Отметь у модуля «${b.module}» компонент как публичный API и ходи только через него.` });
      });
      [...mg.entries()].forEach(([a, set]) => set.forEach(b => { if (a < b && mg.has(b) && mg.get(b).has(a)) add('bad', 'mod-cycle', `Модули «${a}» и «${b}» зависят друг от друга`, 'Циклическая зависимость модулей: их нельзя развивать и выделять по отдельности.', { pat: 'modmono', fix: 'Одну из зависимостей замени событием.' }); }));
      if (!F.some(f => f.id.startsWith('mod-'))) add('good', 'mod-ok', `Модули (${[...mods].join(', ')}) общаются только через публичный API`, 'Границы модулей держатся: любой модуль можно выделить в отдельный сервис.', { pat: 'modmono' });
    }

    /* пул соединений и потоки */
    if (R) {
      M.outer.kids.filter(k => k.node.type === 'sql').forEach(k => {
        const conns = inst * M.rt.pool;
        if (conns > 200 && !k.node.props.pooler) add('bad', 'pool-max', `${inst} экз. × пул ${M.rt.pool} = ${conns} соединений, а база держит 200`, 'Лишние соединения получают отказ: «too many connections». На площадке это видно как ошибки базы.', { pat: 'connpool', fix: 'Уменьши пул, поставь PgBouncer у базы или переходи на асинхронную модель.' });
        const er = res.edges[k.edge.id];
        if (er && er.info && R.used) {
          const need = er.flow / Math.max(1, R.used) * er.info.lat / 1000;
          if (need > M.rt.pool * 0.85) add('warn', 'pool-small', `Пул мал: по закону Литтла нужно ≈ ${Math.ceil(need)} соединений, а в пуле ${M.rt.pool}`, `${SD.fmt.num(er.flow / Math.max(1, R.used))} запросов в БД в секунду на экземпляр × ${SD.fmt.ms(er.info.lat)} на запрос. Запросы стоят в очереди за соединением.`, { pat: 'connpool' });
        }
      });
      if (fx.wait >= 1) {
        const slow = M.outer.kids.map(k => ({ k, er: res.edges[k.edge.id] })).filter(x => x.er && x.er.info && x.er.info.lat >= 150 && !x.er.async).sort((a, b) => b.er.info.lat - a.er.info.lat)[0];
        if (slow) add('warn', 'thread-wait', `Потоки стоят в ожидании «${outerName(slow.k.node)}» по ${SD.fmt.ms(slow.er.info.lat)}`, `${fx.rt.name}: пока запрос ждёт, поток занят и ничего не делает. Сервису нужно в несколько раз больше экземпляров, чем требует CPU.`, { fix: 'Виртуальные потоки Java 21, Go или асинхронная модель: ожидание станет почти бесплатным.' });
      }
      if (M.rt.rt === 'node' && (R.load.upload || 0) > 0) add('warn', 'node-cpu', 'Node.js обрабатывает тяжёлые загрузки в event loop', 'Пока один запрос занимает CPU, остальные запросы процесса ждут.', {});
    }

    if (!layerBad && hasPorts && M.comps.filter(c => c.type === 'port').every(p => M.inn.get(p.id).some(x => x.t.layer === 'infra')) && !F.some(f => f.id === 'dep-app-infra' && f.sev === 'warn')) add('good', 'deps-ok', 'Зависимости направлены к домену', 'Бизнес-код знает только порты. Адаптеры можно заменить, а сценарии протестировать без базы.', { pat: 'hexagonal' });
    F.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
    const counts = { bad: F.filter(f => f.sev === 'bad').length, warn: F.filter(f => f.sev === 'warn').length, good: F.filter(f => f.sev === 'good').length };
    return { M, findings: F, fx, counts };
  }

  /* ---------- сборка по схеме контейнеров ---------- */
  function scaffold(n, g, style, res) {
    const outer = outerOf(n, g);
    const old = n.props.inner;
    const I = { rt: old && old.rt ? Object.assign({}, old.rt) : SD.CRT_DEF(), nodes: [], edges: [], seq: 1 };
    const yNext = { in: 30, app: 30, dom: 30, infra: 30 };
    const add = (type, label, props, extra) => {
      const L = T()[type].layer;
      const c = Object.assign({ id: 'c' + I.seq++, type, y: yNext[L], label, props: Object.assign(SD.cdefaults(type), props || {}) }, extra || {});
      yNext[L] += 86;
      I.nodes.push(c); return c;
    };
    const link = (a, b) => { if (a && b) I.edges.push({ id: 'k' + I.seq++, from: a.id, to: b.id }); };
    const ld = res && res.nodes[n.id] ? res.nodes[n.id].load : {};
    const kinds = new Set(Object.entries(ld).filter(([, v]) => v > 0.01).map(([k]) => kindClass(k)).filter(Boolean));
    const qIn = outer.callers.filter(c => c.node.type === 'queue');
    if (!kinds.size) { if (n.type === 'worker' || qIn.length) kinds.add('job'); else { kinds.add('read'); kinds.add('write'); } }
    const rd = kinds.has('read'), wr = kinds.has('write');
    const ents = [];
    if (rd || wr) ents.push(add('rest', 'API заказов', { kinds: rd && wr ? 'both' : rd ? 'read' : 'write', pipe: ['trace', 'auth', 'valid'].concat(n.props.idempotency && wr ? ['idem'] : []) }, { ident: 'OrdersController' }));
    let cons = null;
    if (kinds.has('job') || qIn.length) cons = add('consumer', 'Консьюмер заказов', { inbox: n.type === 'worker' ? !!n.props.dedup : true }, { bind: qIn[0] && qIn[0].node.id, ident: 'OrderMessagesConsumer' });

    /* адаптеры под каждую связь сервиса */
    const ad = [];
    outer.kids.forEach(k => {
      const type = ADAPTER_FOR[k.node.type];
      if (!type) return;
      const nm = outerName(k.node);
      const label = { repo: `Репозиторий заказов · ${nm}`, cachecl: `Кэш заказов · ${nm}`, httpcl: `Клиент · ${nm}`, pub: 'Публикатор событий', objcl: 'Файлы · S3', searchcl: `Поиск · ${nm}` }[type];
      const props = type === 'pub' && n.props.outbox ? { mode: 'outbox' } : {};
      const px = SD.innerCode ? SD.innerCode.pascal(nm) : 'Remote';
      const sameType = ad.filter(a => a.kind === type).length;
      const ident = { repo: (k.node.type === 'nosql' ? 'Dynamo' : k.node.type === 'sql' ? 'Pg' : px) + 'OrderStore', cachecl: 'RedisOrderCache', httpcl: (px || 'Remote') + 'Client', pub: n.props.outbox ? 'OutboxOrderEvents' : 'KafkaOrderEvents', objcl: 'S3Files', searchcl: 'ProductSearch' }[type] + (sameType && type !== 'httpcl' ? sameType + 1 : '');
      ad.push({ c: add(type, label, props, { bind: k.node.id, ident }), kind: type, outer: k.node });
    });
    if (n.props.outbox && ad.some(a => a.kind === 'pub')) ad.push({ c: add('outbox', 'Outbox-реле', {}, { bind: ad.find(a => a.kind === 'pub').outer.id, ident: 'OutboxRelay' }), kind: 'outbox' });
    const byKind = k => ad.filter(a => a.kind === k).map(a => a.c);
    const ROLE = { repo: 'repo', cachecl: 'cache', httpcl: 'gateway', pub: 'publisher', objcl: 'files', searchcl: 'search' };
    const PORTN = { repo: 'Хранилище заказов', cachecl: 'Кэш заказов', httpcl: 'Шлюз', pub: 'События заказов', objcl: 'Файлы', searchcl: 'Поиск' };
    const PORTI = { repo: 'OrderStore', cachecl: 'OrderCachePort', httpcl: 'Gateway', pub: 'OrderEvents', objcl: 'FileStore', searchcl: 'SearchPort' };
    const ucs = [];
    const mkUc = (label, k, props, ident) => { const u = add('usecase', label, Object.assign({ kinds: k }, props || {}), { ident }); ucs.push(u); return u; };
    let ucR = null, ucW = null, qry = null, ucJ = null;
    if (style === 'cqrs') {
      if (rd) qry = add('query', 'Запрос: заказ', { from: 'replica' }, { ident: 'GetOrderQuery' });
      if (wr) ucW = mkUc('Команда: оформить заказ', 'write', {}, 'PlaceOrderHandler');
    } else {
      if (rd) ucR = mkUc('Получить заказ', 'read', { cache: byKind('cachecl').length ? 'aside' : 'none' }, 'GetOrder');
      if (wr) ucW = mkUc('Оформить заказ', 'write', {}, 'PlaceOrder');
    }
    if (cons) ucJ = mkUc('Обработать сообщение', 'write', {}, 'HandleOrderMessage');
    ents.forEach(e => { [ucR, ucW, qry].forEach(u => link(e, u)); });
    link(cons, ucJ);
    const writers = [ucW, ucJ].filter(Boolean);
    const readers = [ucR, qry].filter(Boolean);
    if (style === 'layered') {
      ad.forEach(a => {
        if (a.kind === 'outbox') return;
        if (a.kind === 'repo') { readers.concat(writers).forEach(u => link(u, a.c)); return; }
        if (a.kind === 'cachecl') { readers.forEach(u => link(u, a.c)); return; }
        if (a.kind === 'pub' || a.kind === 'httpcl') { writers.forEach(u => link(u, a.c)); if (!writers.length) readers.forEach(u => link(u, a.c)); return; }
        readers.concat(writers).forEach(u => link(u, a.c));
      });
    } else {
      const agg = writers.length ? add('aggregate', 'Заказ', {}, { ident: 'Order' }) : null;
      writers.forEach(u => link(u, agg));
      const ports = {};
      ad.forEach(a => {
        if (a.kind === 'outbox') return;
        const key = a.kind + (a.kind === 'httpcl' || a.kind === 'repo' ? ':' + a.outer.id : '');
        const multi = a.kind === 'httpcl' || ad.filter(x => x.kind === a.kind).length > 1;
        if (!ports[key]) ports[key] = add('port', `${PORTN[a.kind]}${multi ? ' · ' + outerName(a.outer) : ''}`, { role: ROLE[a.kind] }, { ident: a.kind === 'httpcl' ? (SD.innerCode ? SD.innerCode.pascal(outerName(a.outer)) : 'Remote') + 'Gateway' : PORTI[a.kind] + (multi ? Object.keys(ports).length + 1 : '') });
        link(a.c, ports[key]);
        const p = ports[key];
        if (a.kind === 'repo') readers.concat(writers).forEach(u => link(u, p));
        else if (a.kind === 'cachecl') readers.forEach(u => link(u, p));
        else if (a.kind === 'pub' || a.kind === 'httpcl') (writers.length ? writers : readers).forEach(u => link(u, p));
        else readers.concat(writers).forEach(u => link(u, p));
      });
    }
    const ob = ad.find(a => a.kind === 'outbox');
    if (ob) link(ob.c, byKind('repo')[0]);
    return I;
  }

  /* ---------- трасса запроса: последовательность вызовов ---------- */
  const METHOD = { usecase: 'execute()', query: 'handle()', saga: 'start()', aggregate: 'apply()', dservice: 'decide()' };
  function outerLat(M, res, b) {
    if (!b) return 0;
    const er = res && res.edges[b.edge.id];
    if (er && er.info && er.info.lat) return er.info.lat;
    return OUTER_LAT[b.node.type] || 5;
  }
  function trace(n, g, res, entryId, k) {
    const M = model(n, g);
    const e = M.by.get(entryId);
    if (!e) return null;
    const parts = [], idx = new Map();
    const P = (key, label, kind) => { if (!idx.has(key)) { idx.set(key, parts.length); parts.push({ key, label, kind }); } return key; };
    const callerNode = e.t.consumer ? (e.bound && e.bound.node) : (M.outer.callers.find(c => c.node.type !== 'queue') || {}).node;
    P('caller', e.type === 'cron' ? 'Расписание' : callerNode ? outerName(callerNode) : 'Клиент', 'outer');
    P(e.id, nameOf(e), e.t.layer);
    const items = [];
    const op = e.t.consumer ? 'сообщение' : e.type === 'cron' ? 'запуск' : k === 'read' ? 'GET /…' : 'POST /…';
    items.push({ t: 'msg', from: 'caller', to: e.id, label: op, ms: 0 });
    let total = 0;
    const pipe = e.props.pipe || [];
    const MW = { trace: ['trace id', 0.05], rl: ['rate limit (Redis)', 1], auth: [e.props.auth === 'introspect' ? 'auth: запрос в auth-сервис' : 'auth: подпись JWT', e.props.auth === 'introspect' ? 15 : 0.3], valid: ['валидация', 0.1], idem: ['ключ идемпотентности (Redis)', 2] };
    pipe.forEach(p => { if (p === 'idem' && k !== 'write') return; const m = MW[p]; if (m) { items.push({ t: 'self', at: e.id, label: m[0], ms: m[1] }); total += m[1]; } });
    if (e.t.consumer && e.props.inbox) { items.push({ t: 'self', at: e.id, label: 'inbox: уже обрабатывали?', ms: 1 }); total += 1; }
    const seen = new Set([e.id]);
    const notes = [];
    function outerCall(from, c, label, items2) {
      if (!c.bound) { items2.push({ t: 'note', at: from, label: `${nameOf(c)}: нет связи на площадке` }); return 0; }
      const ok = P('o:' + c.bound.node.id, outerName(c.bound.node), 'outer');
      const ms = outerLat(M, res, c.bound);
      items2.push({ t: 'msg', from: c.id, to: ok, label, ms, outer: true });
      return ms;
    }
    function visit(c, out, depth) {
      let ms = 0;
      if (depth > 8) return 0;
      let kids = next(M, c, k === 'job' ? 'write' : k);
      const par = c.type === 'usecase' && c.props.calls === 'par';
      const tx = c.type === 'usecase' && c.props.tx === 'usecase' && (k === 'write' || k === 'job') && reachFrom(M, [c], 'write').some(x => x.type === 'repo');
      const body = [];
      kids.forEach(x => {
        if (seen.has(x.id) && x.type !== 'port') return;
        const target = x.type === 'port' ? (next(M, x, k).find(a => a.bound) || next(M, x, k)[0]) : x;
        if (!target || seen.has(target.id)) { if (x.type === 'port' && !target) body.push({ t: 'note', at: c.id, label: `${nameOf(x)}: нет реализации` }); return; }
        seen.add(target.id);
        P(target.id, nameOf(target), target.t.layer);
        const viaPort = x.type === 'port' ? nameOf(x) : null;
        const sub = [];
        let m = 0.05;
        const PM = { repo: k === 'read' ? 'findById()' : 'save()', gateway: k === 'read' ? 'fetch()' : 'reserve()', publisher: 'publish()', cache: k === 'read' ? 'getOrLoad()' : 'invalidate()', files: 'uploadUrl()', search: 'search()' };
        const pm = PM[x.type === 'port' ? x.props.role : target.t.role] || 'call()';
        const lbl = target.t.layer === 'infra' ? (viaPort ? `${viaPort}.${pm}` : `${nameOf(target)}.${pm}`) : (METHOD[target.type] || 'call()');
        sub.push({ t: 'msg', from: c.id, to: target.id, label: target.t.layer === 'infra' ? lbl : lbl, ms: 0.05 });
        if (target.type === 'repo') {
          const rd = k === 'read';
          if (rd && target.props.fetch === 'lazy') {
            const one = outerLat(M, res, target.bound) / (target.bound ? (effects(n).dbReadLat || 1) : 1);
            m += outerCall(target.id, target, 'SELECT заказы', sub);
            const loop = [];
            const per = target.bound ? one : 0;
            if (target.bound) loop.push({ t: 'msg', from: target.id, to: 'o:' + target.bound.node.id, label: 'SELECT … WHERE id = ?', ms: per, outer: true });
            sub.push({ t: 'frag', kind: 'loop', label: 'loop × 10 строк (N+1)', items: loop });
            m += per * 10;
          } else if (rd && target.props.fetch === 'batch') {
            m += outerCall(target.id, target, 'SELECT …', sub);
            m += outerCall(target.id, target, 'SELECT … WHERE id = ANY($1)', sub);
          } else m += outerCall(target.id, target, rd ? 'SELECT … JOIN …' : 'INSERT / UPDATE', sub);
        } else if (target.type === 'cachecl') {
          m += outerCall(target.id, target, 'GET key', sub);
        } else if (target.type === 'httpcl') {
          const p = target.bound ? Object.assign(SD.edgeDefaults(), target.bound.edge.props || {}) : {};
          const ms0 = outerCall(target.id, target, `${(p.proto || 'rest').toUpperCase()} вызов${p.timeout ? ` · таймаут ${SD.fmt.ms(p.timeout)}` : ' · без таймаута'}`, sub);
          m += ms0;
          if (p.retries) sub.push({ t: 'note', at: target.id, label: `повторов до ${p.retries}${p.backoff === 'exp' ? ', exp backoff' : ''}${p.cb ? ', CB' : ''}` });
        } else if (target.type === 'pub') {
          if (target.props.mode === 'outbox') {
            const repo = M.comps.find(r => r.type === 'repo' && r.bound);
            if (repo) { P(repo.id, nameOf(repo), 'infra'); sub.push({ t: 'msg', from: target.id, to: repo.id, label: 'INSERT INTO outbox', ms: 0.05 }); m += outerCall(repo.id, repo, 'INSERT outbox (та же транзакция)', sub); }
            notes.push('Outbox-реле опубликует событие в брокер отдельно, после коммита.');
          } else m += outerCall(target.id, target, 'publish(событие)', sub);
        } else if (target.type === 'objcl') m += outerCall(target.id, target, target.props.presigned ? 'подписать ссылку' : 'PUT объект', sub);
        else if (target.type === 'searchcl') m += outerCall(target.id, target, 'search(query)', sub);
        else if (target.t.layer !== 'infra') m += visit(target, sub, depth + 1);
        if (target.type === 'httpcl' && par) { body.push({ t: 'par', items: sub, ms: m }); }
        else { body.push(...sub); ms += m; }
      });
      const parItems = body.filter(b => b.t === 'par');
      if (parItems.length) {
        const pm = Math.max(...parItems.map(b => b.ms));
        ms += parItems.length > 1 ? pm : parItems[0].ms;
        const rest = body.filter(b => b.t !== 'par');
        const frag = parItems.length > 1 ? [{ t: 'frag', kind: 'par', label: `par: ${parItems.length} вызова параллельно`, items: parItems.flatMap(b => b.items) }] : parItems[0].items;
        body.length = 0; body.push(...rest, ...frag);
      }
      if (tx) {
        const repo = reachFrom(M, [c], 'write').find(x => x.type === 'repo' && x.bound);
        const txItems = body.slice();
        if (repo) { txItems.push({ t: 'msg', from: repo.id, to: 'o:' + repo.bound.node.id, label: 'COMMIT', ms: 2, outer: true }); ms += 2; }
        out.push({ t: 'frag', kind: 'tx', label: 'транзакция', items: txItems });
      } else out.push(...body);
      return ms;
    }
    total += visit(e, items, 0);
    items.push({ t: 'msg', from: e.id, to: 'caller', label: e.t.consumer ? (e.props.ack === 'after' ? 'ack после коммита' : 'ack') : '200 OK', ms: 0, ret: true });
    if (e.t.consumer && e.props.ack === 'before') items.splice(1, 0, { t: 'msg', from: e.id, to: 'caller', label: 'ack сразу (до записи!)', ms: 0, ret: true, bad: true });
    const kindRes = res && res.kinds ? res.kinds[k === 'job' ? 'write' : k] : null;
    return { parts, items, total, e2e: kindRes ? kindRes.lat : null, notes };
  }

  SD.inner = { ensure, model, effects, effectsOf, analyze, scaffold, trace, syncFlags, outerOf, has, kindClass, nameOf, outerName, ADAPTER_FOR, entriesFor, reach };
})();
