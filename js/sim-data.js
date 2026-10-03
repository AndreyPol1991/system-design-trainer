/* Модуль данных и архитектуры: аналитический контур, разные БД, ESB, serverless, event sourcing,
   свежесть отчётов, распознавание стилей и антипаттернов. Подключается через SD.simExts. */
(function () {
  const DT = new Set(['olap', 'etl', 'lake', 'tsdb', 'graphdb', 'esb', 'faas']);
  const MONTH = 2.63e6;
  const faasMs = n => 20 * ({ 128: 2.5, 512: 1, 2048: 0.6 }[n.props.mem] || 1);
  const ETL_DELAY = { stream: 5, hourly: 3600, daily: 86400 };

  function canHandle(ctx, n, kind, viaKids) {
    switch (n.type) {
      case 'app': case 'faas':
        return ['events', 'report', 'metrics', 'graph'].includes(kind) ? true : undefined;
      case 'queue': return kind === 'events' || kind === 'metrics' ? true : undefined;
      case 'etl': return kind === 'events';
      case 'olap': case 'lake': return kind === 'events' || kind === 'report';
      case 'tsdb': return kind === 'metrics' || kind === 'report';
      case 'graphdb': return kind === 'graph';
      case 'esb': return viaKids();
    }
    return undefined;
  }

  function route(ctx, n, kind, r, H) {
    const L = ctx.level, ks = H.kids(ctx, n.id);
    const find = t => ks.find(k => k.type === t);
    if (n.type === 'app' || n.type === 'faas') {
      if (kind === 'report') {
        const t = find('olap') || find('tsdb') || find('lake') || H.pickStore(ctx, n.id);
        if (t) r.fwd.push({ to: t.id, kind: 'report', f: 1, mode: 'seq' }); else { r.fail = 1; r.noStore = true; }
        r.u = 1; return true;
      }
      if (kind === 'events') {
        const t = find('queue') || find('olap') || find('lake') || H.pickStore(ctx, n.id);
        if (t) r.fwd.push({ to: t.id, kind: 'events', f: 1, mode: 'seq' }); else { r.fail = 1; r.noSink = true; }
        r.u = 0.1; return true;
      }
      if (kind === 'metrics') {
        const t = find('queue') || find('tsdb') || H.pickStore(ctx, n.id);
        if (t) r.fwd.push({ to: t.id, kind: 'metrics', f: 1, mode: 'seq' }); else { r.fail = 1; r.noSink = true; }
        r.u = 0.2; return true;
      }
      if (kind === 'graph') {
        const t = find('graphdb') || H.pickStore(ctx, n.id);
        if (t) r.fwd.push({ to: t.id, kind: 'graph', f: 1, mode: 'seq' }); else { r.fail = 1; r.noStore = true; }
        return true;
      }
      if (n.props.persistence === 'es' && (kind === 'read' || kind === 'write')) {
        const store = H.pickStore(ctx, n.id);
        if (!store) { r.fail = 1; r.noStore = true; return true; }
        r.es = true;
        if (kind === 'write') {
          r.fwd.push({ to: store.id, kind: 'append', f: 1, mode: 'seq' });
          if (L.job && L.job.from === 'write') H.jobForward(ctx, n, r);
          return true;
        }
        let cache = find('cache'); if (cache && H.isDead(ctx, cache)) cache = null;
        const h = cache ? H.hitRatio(ctx, cache, 'read') : 0;
        if (cache) r.fwd.push({ to: cache.id, kind: 'read', f: 1, mode: 'seq' });
        const proj = ks.find(k => (k.type === 'nosql' || k.type === 'search' || k.type === 'sql') && k.id !== store.id);
        if (proj) { r.fwd.push({ to: proj.id, kind: proj.type === 'search' ? 'search' : 'read', f: 1 - h, mode: 'seq' }); r.projection = proj.id; }
        else { r.fwd.push({ to: store.id, kind: 'replay', f: 1 - h, mode: 'seq' }); r.replay = true; }
        return true;
      }
      return false;
    }
    if (n.type === 'queue' && (kind === 'events' || kind === 'metrics')) {
      const c = ks.filter(k => k.type !== 'queue' && H.canHandle(ctx, k.id, kind));
      if (c.length) r.fwd = H.spread(ctx, c, kind, 'async'); else r.noConsumer = true;
      return true;
    }
    if (n.type === 'etl') {
      ks.filter(k => k.type === 'olap' || k.type === 'lake').forEach(k => r.fwd.push({ to: k.id, kind: 'events', f: 1, mode: 'async' }));
      if (!r.fwd.length) r.noSink = true;
      r.u = 1; return true;
    }
    if (n.type === 'esb') {
      const c = ks.filter(k => H.canHandle(ctx, k.id, kind));
      if (!c.length) { r.fail = 1; r.noPath = true; return true; }
      r.fwd = H.spread(ctx, c, kind, 'alt', null, 'lc');
      r.u = 1.4; return true;
    }
    if (DT.has(n.type) && n.type !== 'faas') return true;
    return false;
  }

  function isDead(ctx, n, H) {
    if (n.type === 'faas' || n.type === 'etl' || n.type === 'lake') return false;
    return undefined;
  }

  function capacity(ctx, n, H) {
    switch (n.type) {
      case 'olap': return H.alive(ctx, n) * (1 + n.props.replicas) * 1000;
      case 'lake': return 1e6;
      case 'etl': return n.props.mode === 'stream' ? 200000 : 1e7;
      case 'tsdb': return H.alive(ctx, n) * 1000;
      case 'graphdb': return H.alive(ctx, n) * 3000;
      case 'esb': return H.alive(ctx, n) * 8000;
      case 'faas': return (+n.props.conc || 1000) * 1000 / faasMs(n);
    }
    return undefined;
  }

  function state(ctx, n, ld, cap, H) {
    if (!DT.has(n.type)) return undefined;
    const qf = H.qf;
    const mk = (u, lat, info) => ({ util: u, lat, ok: () => (u > 1 ? 1 / u : 1), info });
    const p = n.props;
    switch (n.type) {
      case 'olap': {
        const sch = { star: 1, snowflake: 1.4, obt: 0.6 }[p.schema] || 1;
        const repW = sch * (p.mv ? 0.15 : 1) * (p.partition ? 0.7 : 1);
        const rep = (ld.report || 0) * 4 * repW;
        const ev = ld.events || 0;
        const directRow = p.insert === 'row' && H.parents(ctx, n.id).some(q => q.type === 'app' || q.type === 'faas');
        let evU = ev * 0.0004 * (1 + p.replicas) * (p.mv ? 1.5 : 1);
        let parts = 1;
        if (directRow) { evU = ev * 0.02; const per = ev / Math.max(1, H.alive(ctx, n)); if (per > 1000) parts = per / 1000; }
        if (H.parents(ctx, n.id).some(q => q.type === 'etl' && q.props.approach === 'elt')) evU *= 1.5;
        const u = (rep + evU) / (cap || 1) * parts;
        return mk(u, k => (k === 'report' ? 250 * repW : 5) * qf(Math.min(u, 1.2)), { repW, parts, directRow });
      }
      case 'lake': {
        const f = (p.format === 'json' ? 6 : 1) * (p.partitioned ? 0.5 : 1) * (p.iceberg ? 0.8 : 1);
        const u = ((ld.events || 0) * 0.00001 + (ld.report || 0) * 0.01 * f) / cap;
        return mk(u, k => (k === 'report' ? 4000 * f : 30), { f });
      }
      case 'etl': return mk((ld.events || 0) / cap, () => 0, {});
      case 'tsdb': {
        const u = ((ld.metrics || 0) * 0.002 + (ld.report || 0) * 2 * (p.downsample ? 0.3 : 1)) / (cap || 1);
        return mk(u, k => (k === 'report' ? 80 * (p.downsample ? 0.4 : 1) : 2) * qf(u), {});
      }
      case 'graphdb': { const u = (ld.graph || 0) / (cap || 1); return mk(u, () => 15 * qf(u), {}); }
      case 'esb': { const u = (ctx.units.get(n.id) || 0) / (cap || 1); return mk(u, () => 8 * qf(u), {}); }
      case 'faas': {
        const u = (ctx.units.get(n.id) || 0) / (cap || 1);
        const cold = p.provisioned ? 0 : 0.01;
        return mk(u, () => faasMs(n) + 10 + cold * 400, { cold });
      }
    }
    return undefined;
  }

  /* батч-ETL читает изменения из источника */
  function sqlExtra(ctx, n, ld) {
    const etl = SD.sim.internals.kids(ctx, n.id).find(k => k.type === 'etl');
    if (!etl) return undefined;
    const w = (ld.write || 0) + (ld.apply || 0) + (ld.append || 0);
    return w * ({ stream: 0.3, hourly: 1.2, daily: 0.6 }[etl.props.mode] || 1);
  }

  function collect(ctx, res, level, H) {
    const nodes = [...ctx.nodes.values()];
    let faasCost = 0, lakeCost = 0;
    nodes.forEach(n => {
      const ld = ctx.load.get(n.id) || {};
      const rps = Object.values(ld).reduce((s, v) => s + v, 0);
      if (n.type === 'faas') {
        const gbs = (+n.props.mem / 1024) * (faasMs(n) / 1000);
        let c = MONTH * rps * (0.2 / 1e6 + gbs * 0.0000166667);
        if (n.props.provisioned) c += (+n.props.conc) * 0.1 * (+n.props.mem / 1024) * MONTH * 0.0000041667;
        faasCost += c; res.nodes[n.id].cost += c; res.cost += c;
      }
      if (n.type === 'lake') {
        const c = (ld.events || 0) * MONTH * 1e-9 * 23 * (n.props.format === 'json' ? 1 : 0.15);
        lakeCost += c; res.nodes[n.id].cost += c; res.cost += c;
      }
    });
    /* свежесть данных в отчётах */
    const flow = (a, b, k) => ((ctx.edgeFlow.get(a + '>' + b) || {})[k] || 0);
    const up = (node, depth) => {
      if (depth > 6) return 0;
      if (node.type === 'queue') return 2 + (H.parents(ctx, node.id).some(p => p.type === 'cdc') ? 2 : 0);
      if (node.type === 'etl') return ETL_DELAY[node.props.mode] || 3600;
      return 0;
    };
    const freshOf = node => {
      if (node.type === 'sql' || node.type === 'nosql') return 0;
      const ps = H.parents(ctx, node.id).filter(p => flow(p.id, node.id, 'events') > 0 || flow(p.id, node.id, 'metrics') > 0);
      if (!ps.length) return Infinity;
      const best = Math.min(...ps.map(p => {
        if (p.type === 'app' || p.type === 'faas') return node.type === 'olap' && node.props.insert === 'row' ? 1 : 5;
        let d = up(p, 0);
        if (p.type === 'etl') { const qs = H.parents(ctx, p.id).filter(q => q.type === 'queue'); if (qs.length) d += up(qs[0], 1); }
        return d;
      }));
      return best + (node.type === 'lake' ? 60 : 0);
    };
    const reportNodes = nodes.filter(n => ['olap', 'lake', 'tsdb', 'sql', 'nosql'].includes(n.type) && ((ctx.load.get(n.id) || {}).report || 0) > 0);
    const fresh = reportNodes.length ? Math.max(...reportNodes.map(freshOf)) : null;
    res.data = { fresh, reportsOn: reportNodes.map(n => n.type), faasCost, lakeCost };
  }

  (SD.simExts = SD.simExts || []).push({ canHandle, route, isDead, capacity, state, sqlExtra, collect });

  /* ---------- архитектурный анализ схемы ---------- */
  const label = n => n.label || SD.TYPES[n.type].name;
  SD.arch = {
    analyze(graph, res) {
      const nodes = graph.nodes, edges = graph.edges;
      const by = id => nodes.find(n => n.id === id);
      const kids = id => edges.filter(e => e.from === id).map(e => by(e.to)).filter(Boolean);
      const parents = id => edges.filter(e => e.to === id).map(e => by(e.from)).filter(Boolean);
      const svc = nodes.filter(n => n.type === 'app' || n.type === 'faas');
      const stores = nodes.filter(n => ['sql', 'nosql', 'olap', 'tsdb', 'graphdb'].includes(n.type));
      const out = { styles: [], good: [], anti: [] };
      const st = (id, name, text, dive) => out.styles.push({ id, name, text, dive });
      if (svc.length === 1) st('monolith', 'Монолит', 'Одно приложение и общая база. Просто разрабатывать, тестировать и выкатывать, пока команда и домен небольшие.', 'archstyles');
      if (svc.length === 2) st('split', 'Несколько сервисов', 'Система начала делиться на сервисы.', 'archstyles');
      if (svc.length >= 3) st('micro', 'Микросервисы', `${svc.length} сервиса с отдельной ответственностью. Выкатываются и масштабируются независимо, если у каждого свои данные.`, 'archstyles');
      if (nodes.some(n => n.type === 'esb')) st('soa', 'SOA с шиной', 'Сервисы общаются через центральную шину, которая маршрутизирует и преобразует сообщения.', 'archstyles');
      if (nodes.some(n => n.type === 'faas')) st('serverless', 'Serverless', 'Часть логики выполняют функции, которые облако запускает по запросу.', 'archstyles');
      const eda = svc.some(a => kids(a.id).some(q => q.type === 'queue' && kids(q.id).some(c => ['app', 'worker', 'faas'].includes(c.type))));
      if (eda) st('eda', 'Событийная архитектура', 'Сервисы публикуют события в брокер, другие на них реагируют. Отправитель не ждёт и не знает получателей.', 'eda');
      const projections = nodes.filter(n => ['nosql', 'search', 'cache', 'olap', 'sql'].includes(n.type) && parents(n.id).some(p => p.type === 'worker' || p.type === 'etl' || p.type === 'queue'));
      const cqrs = svc.some(a => projections.some(pj => kids(a.id).includes(pj)) && kids(a.id).some(s => (s.type === 'sql' || s.type === 'nosql') && !projections.includes(s)));
      if (cqrs) st('cqrs', 'CQRS', 'Запись идёт в одну модель, чтение — из отдельной проекции, которую обновляют события.', 'cqrs');
      if (svc.some(a => a.props.persistence === 'es')) st('es', 'Event sourcing', 'Состояние хранится как журнал событий и восстанавливается из него.', 'cqrs');
      if (nodes.some(n => n.type === 'olap' || n.type === 'lake')) st('dwh', 'Аналитический контур', 'Транзакции и аналитика живут в разных хранилищах.', 'olap');
      if (nodes.filter(n => ['sql', 'nosql', 'olap', 'tsdb', 'graphdb', 'search', 'vectordb'].includes(n.type)).map(n => n.type).filter((v, i, a) => a.indexOf(v) === i).length >= 2)
        st('polyglot', 'Polyglot persistence', 'Каждая задача хранится в подходящей базе: транзакции, документы, поиск, аналитика.', 'polyglot');

      stores.forEach(s => {
        const owners = parents(s.id).filter(p => p.type === 'app' || p.type === 'faas');
        if (owners.length >= 2) out.anti.push({ id: 'shareddb', node: s.id, name: 'Общая база', text: `«${label(s)}» используют ${owners.length} сервиса: ${owners.map(label).join(', ')}. Они связаны через схему — изменение таблицы ломает соседей, нагрузка одного тормозит другого.`, dive: 'ddd' });
      });
      const depth = (id, seen) => {
        if (seen.has(id)) return 0;
        seen.add(id);
        const n = by(id);
        if (n && n.props && n.props.txMode === 'saga') return 1;
        const ks = kids(id).filter(k => k.type === 'app');
        return ks.length ? 1 + Math.max(...ks.map(k => depth(k.id, new Set(seen)))) : 1;
      };
      const maxDepth = svc.length ? Math.max(...svc.map(s => depth(s.id, new Set()))) : 0;
      if (maxDepth >= 3) out.anti.push({ id: 'distmono', name: 'Распределённый монолит', text: `Цепочка из ${maxDepth} синхронных вызовов между сервисами. Их нельзя выкатить и уронить независимо, задержки складываются, доступность перемножается.`, dive: 'eda' });
      if (res && res.data && res.data.reportsOn.some(t => t === 'sql' || t === 'nosql')) out.anti.push({ id: 'oltpreports', name: 'Аналитика на боевой базе', text: 'Тяжёлые отчёты идут в ту же базу, что и покупки. Агрегат по году блокирует ресурсы, нужные транзакциям.', dive: 'olap' });
      if (nodes.some(n => n.type === 'esb') && svc.length >= 4) out.anti.push({ id: 'esbhub', name: 'Всё через шину', text: 'Шина стала центром связности: любой новый поток требует её изменения и её команды.', dive: 'archstyles' });
      if (svc.some(a => a.props.persistence === 'es') && res && [...res.ctx.routeMemo.values()].some(r => r.replay)) out.anti.push({ id: 'replay', name: 'Чтение проигрыванием журнала', text: 'Каждое чтение восстанавливает состояние из всех событий. Нужна проекция (CQRS) или снимки.', dive: 'cqrs' });

      const good = (name, text, dive) => out.good.push({ name, text, dive });
      if (nodes.some(n => n.type === 'gateway')) good('API Gateway', 'Единая точка входа: авторизация и лимиты в одном месте.', 'ratelimit');
      if (nodes.some(n => n.type === 'queue' && n.props.retries)) good('Повторы и DLQ', 'Сбойные сообщения повторяются и паркуются, а не теряются.', 'delivery');
      if (svc.some(a => a.props.outbox) || nodes.some(n => n.type === 'cdc')) good('Outbox / CDC', 'Событие публикуется тогда и только тогда, когда транзакция зафиксирована.', 'cdc');
      if (edges.some(e => e.props && e.props.cb)) good('Circuit breaker', 'Упавшая зависимость не утягивает вызывающего.', 'resilience');
      if (nodes.some(n => n.type === 'worker' && n.props.dedup)) good('Идемпотентный потребитель', 'Повторная доставка не меняет результат.', 'delivery');
      if (svc.some(a => a.props.txMode === 'saga')) good('Сага', 'Распределённая операция из локальных транзакций с компенсациями.', 'saga');
      if (nodes.some(n => n.type === 'cache')) good('Кэш', 'Горячие чтения не доходят до базы.', 'cache');
      return out;
    }
  };
})();
