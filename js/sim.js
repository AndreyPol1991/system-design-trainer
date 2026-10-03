/* Движок симуляции.
   1. Трафик линейно растекается от «Пользователей» по графу: каждый тип узла решает, куда отправить запрос (route).
   2. По накопленной нагрузке считаем загрузку каждого узла и задержку на нём (state).
   3. По дереву маршрутов считаем задержку и долю успешных ответов (evalReq), учитывая настройки связей:
      протокол, таймаут, повторы, circuit breaker, fallback.
   4. Повторы раздувают нагрузку, ожидание медленных зависимостей занимает потоки. Это обратная связь,
      поэтому шаги 1–3 повторяются несколько раз, пока картина не устоится. */
(function () {
  const TIMEOUT = 10000;
  const ITER = 7;
  const T = () => SD.TYPES;
  const MANAGED = new Set(['client', 'lb', 'cdn', 'objstore', 'external', 'cdc']);
  const CHAOS_TYPES = new Set(['app', 'gateway', 'cache', 'sql', 'nosql', 'queue', 'worker', 'ws', 'search']);
  const THREADED = new Set(['app', 'ws', 'agent']);
  const AI_TYPES = new Set(['llm', 'router', 'semcache', 'guard', 'embed', 'vectordb', 'stt', 'tts', 'agent']);
  let XC = null;
  const X = () => XC || (XC = (() => {
    const list = SD.simExts || [];
    const first = name => (...a) => { for (const e of list) if (e[name]) { const r = e[name](...a); if (r !== undefined) return r; } return undefined; };
    return {
      canHandle: first('canHandle'), capacity: first('capacity'), state: first('state'), isDead: first('isDead'), sqlExtra: first('sqlExtra'),
      waitMul: first('waitMul'), poolSize: first('poolSize'),
      routePost: (...a) => list.forEach(e => e.routePost && e.routePost(...a)),
      route: (...a) => list.some(e => e.route && e.route(...a)),
      prepare: (...a) => list.forEach(e => e.prepare && e.prepare(...a)),
      collect: (...a) => list.forEach(e => e.collect && e.collect(...a))
    };
  })());
  const IDX_GB = { btree: 0.15, hash: 0.12, composite: 0.2, covering: 0.3, clustered: 0, gin: 0.38, gist: 0.22, brin: 0.002, partial: 0.05 };
  const RAM = { s: 8, m: 32, l: 64, xl: 128 };
  function sqlW(p, L) {
    const I = new Set(p.idx || (p.indexes === false ? [] : ['btree']));
    const has = k => I.has(k);
    const key = has('btree') || has('hash') || has('clustered');
    let read = key ? 1 : 15;
    if (has('hash')) read *= 0.88;
    if (has('covering')) read *= 0.7;
    if (has('clustered')) read *= 0.9;
    if (has('partial')) read *= 0.95;
    let range = has('composite') ? 4 : has('brin') ? 9 : key ? 12 : 40;
    if (has('clustered')) range *= 0.6;
    if (has('covering') && has('composite')) range *= 0.75;
    if (p.partition === 'month') range *= 0.6;
    let feed = has('composite') ? 6 : key ? 12 : 40;
    if (has('clustered')) feed *= 0.7;
    const search = has('gin') ? 3 : 30;
    const geo = has('gist') ? 3 : 50;
    let write = 3.6 + 0.4 * I.size + (has('gin') ? 0.8 : 0) + (has('gist') ? 0.4 : 0) + (has('clustered') ? 0.3 : 0) - (has('partial') ? 0.2 : 0);
    if (p.partition && p.partition !== 'none') write *= 1.03;
    const dataGb = (L && L.dataGb) || 0;
    const idxGb = [...I].reduce((s, k) => s + (IDX_GB[k] || 0) * dataGb, 0);
    const needGb = dataGb * 0.3 + idxGb;
    const ram = RAM[p.size || 'm'];
    const spill = dataGb > 0 && needGb > ram ? Math.min(2.5, 1 + (needGb - ram) / ram) : 1;
    return { read: read * spill, range: range * spill, feed: feed * spill, search: search * spill, geo: geo * spill, write: write * (spill > 1 ? 1 + (spill - 1) * 0.5 : 1), bot: read * 1.5 * spill, report: 200, spill, idxGb, needGb, ram, n: I.size };
  }
  const NOSQL_M = { wide: { r: 1, w: 1, lat: 0 }, doc: { r: 0.9, w: 1.6, lat: 1 }, kv: { r: 0.7, w: 0.8, lat: -1 } };
  const CDN_HIT = { min: 0.8, hour: 0.93, day: 0.97 };
  const TTL_F = { '10s': 0.75, '1m': 0.9, '10m': 0.98, '1h': 1 };
  const qf = u => 1 + Math.pow(Math.max(u, 0), 3) / (1 - Math.min(u, 0.95));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ENG = n => SD.ENGINES[(n.props && n.props.engine) || 'kafka'] || SD.ENGINES.kafka;

  function build(level, graph, opts, fb) {
    const ctx = {
      level, opts, fb, nodes: new Map(), out: new Map(), inn: new Map(), edgeMap: new Map(),
      routeMemo: new Map(), canMemo: new Map(), evalMemo: new Map(), stateMemo: new Map(),
      load: new Map(), units: new Map(), edgeFlow: new Map(), jobsMissing: 0,
      newAmp: new Map(), newWait: new Map(), edgeInfo: new Map(), degraded: new Map(), twopc: new Set()
    };
    graph.nodes.forEach(n => { ctx.nodes.set(n.id, n); ctx.out.set(n.id, []); ctx.inn.set(n.id, []); });
    graph.edges.forEach(e => {
      if (ctx.nodes.has(e.from) && ctx.nodes.has(e.to) && e.from !== e.to && !ctx.out.get(e.from).includes(e.to)) {
        ctx.out.get(e.from).push(e.to); ctx.inn.get(e.to).push(e.from); ctx.edgeMap.set(e.from + '>' + e.to, e);
      }
    });
    return ctx;
  }

  const kids = (ctx, id) => ctx.out.get(id).map(k => ctx.nodes.get(k));
  const parents = (ctx, id) => ctx.inn.get(id).map(k => ctx.nodes.get(k));
  const kidOf = (ctx, id, types) => kids(ctx, id).find(n => types.includes(n.type));
  const count = (ctx, n) => (ctx.fb.scaled.get(n.id)) || (n.props && n.props.count) || 1;
  const down = (ctx, n) => (ctx.opts.down && ctx.opts.down[n.id]) || 0;
  const alive = (ctx, n) => Math.max(0, count(ctx, n) - down(ctx, n));
  const edgeProps = (ctx, a, b) => { const e = ctx.edgeMap.get(a + '>' + b); return Object.assign(SD.edgeDefaults(), e && e.props); };

  function isDead(ctx, n) {
    if (X().isDead) { const d = X().isDead(ctx, n, H); if (d !== undefined) return d; }
    if (MANAGED.has(n.type)) return false;
    if (n.type === 'sql') return down(ctx, n) > 0 && n.props.replicas === 0 && n.props.shards === 1;
    if (n.type === 'queue') return !ENG(n).managed && down(ctx, n) > 0 && count(ctx, n) < 3;
    return alive(ctx, n) === 0;
  }
  const lbNoHealth = (ctx, n) => parents(ctx, n.id).some(p => p.type === 'lb' && p.props.health === false);
  const lbSticky = (ctx, n) => parents(ctx, n.id).some(p => p.type === 'lb' && p.props.sticky);

  /* сколько экземпляров реально получают трафик */
  function usedInstances(ctx, n) {
    const a = alive(ctx, n);
    if ((n.type === 'app' || n.type === 'ws') && a > 1 && parents(ctx, n.id).some(p => p.type === 'client')) return 1;
    if (n.type === 'worker' || n.type === 'app') {
      const qs = parents(ctx, n.id).filter(p => p.type === 'queue' && ENG(p).parallel === 'partitions');
      if (n.type === 'worker' && qs.length) return Math.min(a, qs.reduce((s, q) => s + q.props.partitions, 0));
    }
    return a;
  }
  function capacity(ctx, n) {
    const L = ctx.level, d = T()[n.type];
    if (X().capacity) { const c = X().capacity(ctx, n, H); if (c !== undefined) return c; }
    switch (n.type) {
      case 'external': return (L.ext && L.ext.cap) || 1000;
      case 'worker': { const j = L.job || { ms: 100, conc: 20 }; const bf = j.target === 'external' || j.cpu ? 1 : ({ 1: 1, 10: 1.6, 100: 2.2 }[n.props.batch || 1] || 1); return usedInstances(ctx, n) * j.conc * 1000 / j.ms * bf; }
      case 'queue': {
        if (isDead(ctx, n)) return 0;
        const e = ENG(n);
        if (e.cap === 'partitions') {
          let c = n.props.partitions * e.perPart;
          if (n.props.acks === 'all') c *= 0.8;
          if (n.props.semantics === 'exactly') c *= 0.7;
          return c;
        }
        return e.perQueue;
      }
      case 'sql': return 5000 * (SD.SQL_SIZE_F[n.props.size] || 1) * n.props.shards * (1 + n.props.replicas);
      case 'nosql': return alive(ctx, n) * d.perCap;
      case 'app': return usedInstances(ctx, n) * d.perCap * (SD.SIZE_F[n.props.size] || 1);
      default: return MANAGED.has(n.type) ? d.perCap : usedInstances(ctx, n) * d.perCap;
    }
  }

  function fanoutPipeline(ctx) {
    for (const n of ctx.nodes.values()) {
      if (n.type !== 'app') continue;
      const src = [n, ...kids(ctx, n.id).filter(k => k.type === 'sql' || k.type === 'nosql').flatMap(s => kids(ctx, s.id).filter(c => c.type === 'cdc'))];
      for (const s of src) for (const q of kids(ctx, s.id)) {
        if (q.type !== 'queue') continue;
        if (kids(ctx, q.id).some(w => w.type === 'worker' && kids(ctx, w.id).some(c => c.type === 'cache'))) return true;
      }
    }
    return false;
  }
  function hitRatio(ctx, cache, kind) {
    const L = ctx.level;
    if (kind === 'bot') return 0.02;
    let h;
    if (L.feed) h = fanoutPipeline(ctx) ? 0.97 : 0.25;
    else {
      const mem = cache.props.cluster === 'replicated' ? (alive(ctx, cache) > 0 ? cache.props.mem : 0) : alive(ctx, cache) * cache.props.mem;
      const r = mem / (L.hotSetGb || 8);
      h = (L.cacheMax || 0.97) * (1 - Math.exp(-2.5 * r));
      h *= TTL_F[cache.props.ttl] || 0.98;
    }
    if (cache.props.eviction === 'lfu') h += (1 - h) * 0.15;
    if (cache.props.policy === 'through') h += (1 - h) * 0.2;
    return Math.min(0.995, h);
  }

  function canHandle(ctx, id, kind, seen) {
    const key = id + '|' + kind;
    if (ctx.canMemo.has(key)) return ctx.canMemo.get(key);
    seen = seen || new Set();
    if (seen.has(id)) return false;
    seen.add(id);
    const n = ctx.nodes.get(id);
    const viaKids = () => ctx.out.get(id).some(k => canHandle(ctx, k, kind, seen));
    let ok = X().canHandle ? X().canHandle(ctx, n, kind, viaKids) : undefined;
    if (ok !== undefined) { ctx.canMemo.set(key, ok); return ok; }
    switch (n.type) {
      case 'app': case 'faas': ok = ['read', 'write', 'static', 'upload', 'search', 'bot', 'job', 'geo'].includes(kind); break;
      case 'lb': case 'gateway': ok = viaKids(); break;
      case 'cdn': ok = kind === 'static' || viaKids(); break;
      case 'objstore': ok = ['static', 'upload', 'blob'].includes(kind); break;
      case 'ws': ok = kind === 'msg'; break;
      case 'sql': case 'nosql': ok = ['read', 'write', 'apply', 'search', 'bot', 'feed', 'range', 'geo', 'report', 'append', 'replay', 'graph', 'metrics', 'events'].includes(kind); break;
      case 'queue': ok = kind === 'job' || kind === 'msg'; break;
      case 'worker': case 'external': case 'cdc': ok = kind === 'job'; break;
      case 'search': ok = kind === 'search'; break;
      default: ok = false;
    }
    ctx.canMemo.set(key, ok);
    return ok;
  }

  const CAP_ALGOS = new Set(['wrr', 'lc', 'lrt', 'p2c']);
  const weightOf = (ctx, n, algo) => {
    if (MANAGED.has(n.type) || n.type === 'sql' || n.type === 'queue') return 1;
    const inst = Math.max(lbNoHealth(ctx, n) ? count(ctx, n) : usedInstances(ctx, n), 0);
    if (algo && CAP_ALGOS.has(algo) && n.type === 'app') return inst * (SD.SIZE_F[n.props.size] || 1);
    return inst;
  };
  function spread(ctx, cands, kind, mode, net, algo) {
    const live = cands.filter(c => !isDead(ctx, c));
    const pool = live.length ? live : cands;
    const tot = pool.reduce((s, c) => s + (weightOf(ctx, c, algo) || 1), 0);
    return pool.map(c => ({ to: c.id, kind, f: (weightOf(ctx, c, algo) || 1) / tot, mode, net: net ? net(c) : 0 }));
  }
  function lbImb(ctx, n) {
    let f = 1;
    parents(ctx, n.id).forEach(p => {
      if (p.type !== 'lb') return;
      let g = usedInstances(ctx, n) > 1 ? (SD.LB_IMB[p.props.algo] || 1.06) : 1;
      if (p.props.sticky) g *= 1.2;
      if (p.props.algo === 'rr' || p.props.algo === 'random' || p.props.algo === 'hash') {
        const sibs = kids(ctx, p.id).filter(k => k.type === n.type && k.type === 'app');
        const sizes = new Set(sibs.map(k => k.props.size || 'm'));
        if (sizes.size > 1) { const fN = SD.SIZE_F[n.props.size || 'm']; const avg = sibs.reduce((s, k) => s + SD.SIZE_F[k.props.size || 'm'], 0) / sibs.length; g *= Math.max(1, avg / fN); }
      }
      f = Math.max(f, g);
    });
    return f;
  }
  function pickStore(ctx, id) {
    const pref = ctx.level.storePref === 'nosql' ? ['nosql', 'sql'] : ['sql', 'nosql'];
    for (const t of pref) { const s = kidOf(ctx, id, [t]); if (s) return s; }
    return null;
  }
  function jobForward(ctx, src, r) {
    const job = ctx.level.job;
    if (src.type === 'app') {
      const st = pickStore(ctx, src.id);
      if (st && kidOf(ctx, st.id, ['cdc'])) { r.viaCdc = true; return; }
    }
    const q = kidOf(ctx, src.id, ['queue']);
    if (q) {
      if (isDead(ctx, q) && src.props && src.props.outbox) { r.outboxBuffer = true; return; }
      r.fwd.push({ to: q.id, kind: 'job', f: 1, mode: 'seq' });
      return;
    }
    const target = kidOf(ctx, src.id, [job.target]);
    if (!target) { r.jobMissing = true; return; }
    r.syncJob = true;
    if (job.target !== 'external') {
      if (job.cpu) { r.u += job.ms / 2.5; r.lat += job.ms; } else { r.u += job.ms / 40; r.lat += job.ms; }
    }
    const fan = job.fanout || 1;
    r.fwd.push({ to: target.id, kind: job.target === 'cache' ? 'fanout' : job.target === 'objstore' ? 'blob' : 'job', f: fan, mode: 'seq', latMul: fan > 1 ? 0.3 : undefined });
  }

  function route(ctx, id, kind) {
    const key = id + '|' + kind;
    if (ctx.routeMemo.has(key)) return ctx.routeMemo.get(key);
    const n = ctx.nodes.get(id), L = ctx.level;
    const r = { u: 1, lat: 0, fwd: [], fail: 0, rand: 0 };
    const ks = kids(ctx, id);
    const rtt = L.global ? 140 : 25;
    if (X().route && X().route(ctx, n, kind, r, H)) { ctx.routeMemo.set(key, r); return r; }
    switch (n.type) {
      case 'client': {
        r.u = 0;
        let c = ks.filter(k => canHandle(ctx, k.id, kind));
        if (kind === 'static') { const p = c.filter(k => k.type === 'cdn'); if (p.length) c = p; else { const o = c.filter(k => k.type === 'objstore'); if (o.length) c = o; } }
        else if (kind === 'upload') { const o = c.filter(k => k.type === 'objstore'); if (o.length) c = o; }
        else { const dyn = c.filter(k => k.type !== 'cdn' && k.type !== 'objstore'); if (dyn.length) c = dyn; }
        if (kind === 'metrics' || kind === 'events') { const d = c.filter(k => ['tsdb', 'queue', 'olap', 'lake'].includes(k.type)); if (d.length) c = d; }
        if (!c.length) { r.fail = 1; r.noPath = true; break; }
        r.fwd = spread(ctx, c, kind, 'alt', k => k.type === 'cdn' ? 12 : rtt);
        break;
      }
      case 'lb': case 'gateway': {
        let share = 1;
        if (n.type === 'gateway' && kind === 'bot' && n.props.rateLimit) share = { token: 0.03, sliding: 0.02, fixed: 0.08 }[n.props.rlAlgo || 'token'];
        const c = ks.filter(k => canHandle(ctx, k.id, kind));
        if (!c.length) { r.fail = 1; r.noPath = true; break; }
        r.fwd = spread(ctx, c, kind, 'alt', null, n.type === 'lb' ? n.props.algo : 'lc').map(f => ({ ...f, f: f.f * share }));
        if (share < 1) r.blocked = 1 - share;
        if (n.type === 'lb') r.u = 1;
        break;
      }
      case 'cdn': {
        if (kind === 'static') {
          const h = CDN_HIT[n.props.ttl] || 0.93;
          r.hit = h;
          const origin = ks.filter(k => canHandle(ctx, k.id, 'static'));
          const pref = origin.filter(k => k.type === 'objstore');
          const o = pref.length ? pref : origin;
          if (!o.length) { r.fail = 1 - h; break; }
          const sh = n.props.shield ? 0.4 : 1;
          r.fwd = spread(ctx, o, 'static', 'alt', () => (L.global ? 90 : 15) + (n.props.shield ? 5 : 0)).map(f => ({ ...f, f: f.f * (1 - h) * sh }));
        } else {
          const c = ks.filter(k => canHandle(ctx, k.id, kind));
          if (!c.length) { r.fail = 1; break; }
          r.fwd = spread(ctx, c, kind, 'alt', () => (L.global ? 90 : 8));
        }
        break;
      }
      case 'app': case 'faas': {
        const store = pickStore(ctx, id);
        let cache = kidOf(ctx, id, ['cache']);
        if (cache && isDead(ctx, cache)) { r.cacheDown = cache.id; cache = null; }
        const svc = ks.filter(k => k.type === 'app');
        const tx = n.props.txMode || 'local';
        if (kind === 'read' || kind === 'bot') {
          const h = cache ? hitRatio(ctx, cache, kind) : 0;
          r.hit = cache ? h : undefined;
          let missF = 1 - h;
          if (r.cacheDown) {
            const dc = ctx.nodes.get(r.cacheDown);
            if (dc.props.stampede) missF *= 0.6;
          }
          if (cache) r.fwd.push({ to: cache.id, kind, f: 1, mode: 'seq' });
          const rs = kind === 'read' && L.rangeShare ? L.rangeShare : 0;
          if (store && rs) {
            const hr = cache ? Math.min(1, h * 0.6) : 0;
            r.fwd.push({ to: store.id, kind: 'read', f: (1 - h) * (1 - rs), mode: 'seq' });
            r.fwd.push({ to: store.id, kind: 'range', f: (1 - hr) * rs, mode: 'seq' });
          } else if (store) r.fwd.push({ to: store.id, kind: (L.feed && kind === 'read') ? 'feed' : kind, f: missF, mode: 'seq' });
          else if (!svc.length) { r.fail = missF; r.noStore = true; }
          if (!store) svc.forEach(s => r.fwd.push({ to: s.id, kind: 'read', f: 1, mode: 'seq' }));
        } else if (kind === 'geo') {
          if (cache && cache.props.geo) r.fwd.push({ to: cache.id, kind: 'geo', f: 1, mode: 'seq' });
          else if (store) r.fwd.push({ to: store.id, kind: 'geo', f: 1, mode: 'seq' });
          else { r.fail = 1; r.noStore = true; }
        } else if (kind === 'write' && L.geoWrites && cache && cache.props.geo) {
          r.fwd.push({ to: cache.id, kind: 'write', f: 1, mode: 'seq' });
          if (store) r.fwd.push({ to: store.id, kind: 'write', f: 0.02, mode: 'async' });
          r.geoWrites = true;
        } else if (kind === 'write') {
          const behind = cache && cache.props.policy === 'behind';
          if (store) {
            if (behind) { r.fwd.push({ to: cache.id, kind: 'write', f: 1, mode: 'seq' }); r.fwd.push({ to: store.id, kind: 'write', f: 0.35, mode: 'async' }); r.writeBehind = true; }
            else {
              r.fwd.push({ to: store.id, kind: 'write', f: 1, mode: 'seq' });
              if (cache && cache.props.policy === 'through') r.fwd.push({ to: cache.id, kind: 'write', f: 1, mode: 'seq' });
              else if (cache && cache.props.invalidate !== false) r.fwd.push({ to: cache.id, kind: 'write', f: 1, mode: 'seq', latMul: 0.3 });
            }
          } else if (!svc.length) { r.fail = 1; r.noStore = true; }
          if (L.job && L.job.from === 'write') jobForward(ctx, n, r);
          svc.forEach(s => {
            if (tx === 'saga') r.fwd.push({ to: s.id, kind: 'write', f: 1, mode: 'async', saga: true });
            else r.fwd.push({ to: s.id, kind: 'write', f: 1, mode: 'seq', twopc: tx === '2pc' });
          });
          if (tx === '2pc' && svc.length) { r.lat += 6; }
        } else if (kind === 'job') {
          if (store) r.fwd.push({ to: store.id, kind: 'apply', f: 1, mode: 'seq' }); else r.noStore = true;
        } else if (kind === 'static') {
          r.u = 3;
          const o = kidOf(ctx, id, ['objstore']);
          if (o) r.fwd.push({ to: o.id, kind: 'static', f: 1, mode: 'seq' }); else r.lat += 10;
          r.servesStatic = true;
        } else if (kind === 'upload') {
          r.u = 25;
          const o = kidOf(ctx, id, ['objstore']);
          if (o) r.fwd.push({ to: o.id, kind: 'blob', f: 1, mode: 'seq' }); else { r.fail = 1; r.noObj = true; }
          if (L.job && L.job.from === 'upload') jobForward(ctx, n, r);
        } else if (kind === 'search') {
          const s = kidOf(ctx, id, ['search']);
          if (s) r.fwd.push({ to: s.id, kind: 'search', f: 1, mode: 'seq' });
          else if (store) r.fwd.push({ to: store.id, kind: 'search', f: 1, mode: 'seq' });
          else { r.fail = 1; r.noStore = true; }
        } else { r.fail = 1; }
        break;
      }
      case 'sql': case 'nosql': {
        if (kind === 'write' && L.job && L.job.from === 'write') {
          const c = kidOf(ctx, id, ['cdc']);
          if (c) r.fwd.push({ to: c.id, kind: 'job', f: 1, mode: 'async' });
        }
        if (kind === 'write' || kind === 'append') {
          const etl = kidOf(ctx, id, ['etl']);
          if (etl) r.fwd.push({ to: etl.id, kind: 'events', f: 1, mode: 'async' });
        }
        break;
      }
      case 'cdc': {
        const q = ks.filter(k => k.type === 'queue');
        if (q.length) r.fwd = spread(ctx, q, 'job', 'async'); else r.noQueue = true;
        break;
      }
      case 'objstore': {
        r.lat = kind === 'static' ? 0 : (L.uploadMs || 120) - 30;
        if (kind === 'upload' && L.job && L.job.from === 'upload') jobForward(ctx, n, r);
        break;
      }
      case 'queue': {
        if (kind === 'job') {
          const w = ks.filter(k => k.type === 'worker' || k.type === 'app');
          if (w.length) r.fwd = spread(ctx, w, 'job', 'async');
          else r.noConsumer = true;
        } else if (kind === 'msg') {
          ks.filter(k => k.type === 'ws').forEach(k => r.fwd.push({ to: k.id, kind: 'msg', f: 1, mode: 'seq', visual: true }));
        }
        break;
      }
      case 'worker': {
        const job = L.job;
        if (!job) break;
        const t = ks.filter(k => k.type === job.target);
        ks.filter(k => k.type === 'search').forEach(k => r.fwd.push({ to: k.id, kind: 'job', f: 1, mode: 'seq', visual: true }));
        if (!t.length) { r.fail = 1; r.noTarget = true; break; }
        const fan = job.fanout || 1;
        const k2 = job.target === 'cache' ? 'fanout' : job.target === 'objstore' ? 'blob' : job.target === 'sql' || job.target === 'nosql' ? 'apply' : 'job';
        const bf = job.target === 'external' ? 1 : ({ 1: 1, 10: 0.6, 100: 0.4 }[n.props.batch || 1] || 1);
        spread(ctx, t, k2, 'alt').forEach(f => r.fwd.push({ ...f, f: f.f * fan * bf, latMul: fan > 1 ? 0.3 : undefined }));
        break;
      }
      case 'ws': {
        if (kind !== 'msg') { r.fail = 1; break; }
        const store = pickStore(ctx, id);
        if (store) r.fwd.push({ to: store.id, kind: 'write', f: 1, mode: 'seq' }); else r.noStore = true;
        const pub = kidOf(ctx, id, ['queue', 'cache']);
        if (pub) { r.fwd.push({ to: pub.id, kind: 'msg', f: 1, mode: 'seq' }); r.pubsub = true; }
        break;
      }
      case 'external': r.rand = (L.ext && L.ext.fail) || 0; break;
      default: break;
    }
    X().routePost(ctx, n, kind, r, H);
    ctx.routeMemo.set(key, r);
    return r;
  }

  function addTo(map, id, kind, amt) {
    let m = map.get(id);
    if (!m) { m = {}; map.set(id, m); }
    m[kind] = (m[kind] || 0) + amt;
  }
  function protoMul(ctx, via, n) {
    if (!via || !['app', 'gateway', 'ws'].includes(n.type)) return 1;
    const e = ctx.edgeMap.get(via + '>' + n.id);
    const p = SD.PROTOCOLS[(e && e.props && e.props.proto) || 'rest'];
    return p ? p.u : 1;
  }
  function push(ctx, id, kind, amt, depth, via, twopc) {
    if (amt < 1e-6 || depth > 18) return;
    const n = ctx.nodes.get(id);
    const r = route(ctx, id, kind);
    addTo(ctx.load, id, kind, amt);
    if (twopc && (n.type === 'sql')) ctx.twopc.add(id);
    const wait = ctx.fb.wait.get(id + '|' + kind) || 0;
    ctx.units.set(id, (ctx.units.get(id) || 0) + amt * (r.u * protoMul(ctx, via, n) + wait));
    if (r.jobMissing) ctx.jobsMissing += amt;
    for (const f of r.fwd) {
      const amp = f.visual ? 1 : (ctx.fb.amp.get(id + '>' + f.to + '|' + f.kind) || 1);
      const a = amt * f.f * amp;
      addTo(ctx.edgeFlow, id + '>' + f.to, f.kind, a);
      if (!f.visual) push(ctx, f.to, f.kind, a, depth + 1, id, twopc || f.twopc);
    }
  }

  function trafficOf(level, mul) {
    const t = {};
    Object.entries(level.traffic).forEach(([k, v]) => { if (v > 0) t[k] = v * mul; });
    return t;
  }

  /* ---------- загрузка узла и задержка на нём ---------- */
  function sqlState(ctx, n, ld) {
    const L = ctx.level, p = n.props;
    const S = p.shards; let R = p.replicas;
    const failed = down(ctx, n) > 0;
    if (failed && R > 0) R -= 1;
    const w = sqlW(p, L);
    const cap1 = 5000 * (SD.SQL_SIZE_F[p.size] || 1);
    const iso = SD.ISOLATION[p.isolation || 'rc'];
    const cont = L.contention || 0;
    const abort = p.isolation === 'rr' ? cont * 0.08 : p.isolation === 'ser' ? cont * 0.2 : 0;
    const optRetry = p.locking === 'optimistic' ? cont * 0.15 : 0;
    const pessF = p.locking === 'pessimistic' ? 1 - 0.3 * cont : 1;
    const twopc = ctx.twopc.has(n.id) ? 1.3 : 1;
    const writes = (ld.write || 0) + (ld.apply || 0) + (ld.append || 0) * 0.5 + (ld.metrics || 0) * 0.4 + (ld.events || 0);
    let W = writes * w.write * twopc * (1 + abort + optRetry) / (iso.cap * pessF);
    const Rd = (ld.read || 0) * w.read + (ld.bot || 0) * w.bot + (ld.feed || 0) * w.feed + (ld.search || 0) * w.search + (ld.range || 0) * w.range + (ld.geo || 0) * w.geo + (ld.report || 0) * w.report + (ld.replay || 0) * 6 * w.read + (ld.graph || 0) * 80 + ((X().sqlExtra && X().sqlExtra(ctx, n, ld)) || 0);
    const ryw = R > 0 && p.ryw ? Math.min(0.5, writes / ((ld.read || 0) + 1) * 3) : 0;
    let wS = W / S, rS = Rd / S;
    if (S > 1 && p.shardKey === 'range') wS = W;
    if (S > 1 && p.shardKey === 'geo') { wS = W * 0.45; rS = Rd * 0.45; }
    const uW = (wS + (R === 0 ? rS : rS * ryw)) / cap1;
    const uR = R > 0 ? (rS * (1 - ryw) / R + wS * 0.3) / cap1 : uW;
    const mode = p.replMode || 'async';
    const lag = R > 0 ? (mode === 'sync' ? 0 : 3 * Math.pow(qf(uR), 2)) : 0;
    let conns = 0;
    parents(ctx, n.id).forEach(q => { const ps = X().poolSize(ctx, q); if (q.type === 'app') conns += alive(ctx, q) * (ps === undefined ? 10 : ps); else if (q.type === 'worker' || q.type === 'ws') conns += alive(ctx, q) * (ps === undefined ? 5 : ps); });
    const connLimit = 200;
    const connOk = (!p.pooler && conns > connLimit) ? connLimit / conns : 1;
    const info = { uW, uR, R, S, lag, mode, conns, connLimit, connOk, abort: abort + optRetry, hot: S > 1 && p.shardKey !== 'hash', ryw, spill: w.spill, idxGb: w.idxGb, needGb: w.needGb, ram: w.ram, nIdx: w.n, noKey: w.read >= 15 };
    const util = Math.max(uW, uR);
    const lat = k => {
      if (k === 'write' || k === 'apply') {
        let l = 10 * qf(uW);
        if (R > 0 && mode === 'semisync') l += 2 * qf(uR);
        if (R > 0 && mode === 'sync') l += 4 * qf(uR) * (1 + 0.15 * (R - 1));
        if (p.locking === 'pessimistic') l += cont * 40 * qf(uW);
        if (twopc > 1) l += 8;
        return l;
      }
      if (k === 'append') return 6 * qf(uW);
      if (k === 'metrics') return 8 * qf(uW);
      const b = k === 'replay' ? 40 : k === 'graph' ? 800 : k === 'feed' ? (w.feed <= 8 ? 12 : 25) : k === 'search' ? (w.search < 10 ? 15 : 300) : k === 'geo' ? (w.geo < 10 ? 10 : 400) : k === 'range' ? 2 * w.range : k === 'report' ? 2500 : 6 * Math.max(0.7, w.read);
      return b * qf(uR) * (w.spill > 1 ? 1.5 : 1);
    };
    const ok = k => {
      const u = (k === 'write' || k === 'apply' || k === 'append' || k === 'metrics') ? uW : uR;
      return (u > 1 ? 1 / u : 1) * connOk;
    };
    return { util, utilFor: k => (k === 'write' || k === 'apply' || k === 'append' || k === 'metrics') ? uW : uR, lat, ok, info };
  }

  function state(ctx, n) {
    if (ctx.stateMemo.has(n.id)) return ctx.stateMemo.get(n.id);
    const L = ctx.level, d = T()[n.type];
    const ld = ctx.load.get(n.id) || {};
    const dead = isDead(ctx, n);
    const cap = capacity(ctx, n);
    let st = X().state ? X().state(ctx, n, ld, cap, H) : undefined;
    if (st) {
      /* состояние посчитал AI-модуль */
    } else if (n.type === 'sql') {
      st = sqlState(ctx, n, ld);
    } else {
      let util = 0, base = d.lat || 0, info = null;
      if (n.type === 'nosql') {
        const rf = n.props.rf || 3, cl = n.props.cl || 'quorum';
        const M = NOSQL_M[n.props.model || 'wide'];
        const gsi = !!n.props.gsi;
        const rw = (rf === 1 ? 0.6 : { one: 0.6, quorum: 1.2, all: 1.8 }[cl]) * M.r;
        const ww = 0.25 * rf * M.w * (gsi ? 1.3 : 1);
        const u = (ld.read || 0) * rw + (ld.bot || 0) * rw + (ld.write || 0) * ww + (ld.apply || 0) * ww + (ld.feed || 0) * (gsi ? 4 : 20) + (ld.search || 0) * (n.props.model === 'doc' ? 15 : 40)
          + (ld.range || 0) * (gsi ? 3 : n.props.model === 'kv' ? 60 : 20) + (ld.geo || 0) * (gsi ? 4 : 50) + (ld.report || 0) * 300
          + (ld.append || 0) * ww * 0.8 + (ld.replay || 0) * 4 + (ld.graph || 0) * 100 + (ld.metrics || 0) * ww * 0.5;
        util = cap ? u / cap : (u ? 9 : 0);
        base = Math.max(1, (rf === 1 ? 3 : { one: 3, quorum: 4, all: 6 }[cl]) + M.lat);
      } else if (n.type === 'ws') {
        const totalMsg = (L.traffic.msg || 0) * (ctx.opts.mul || 1);
        const conns = totalMsg ? (L.connections || 0) * (ctx.opts.mul || 1) * (ld.msg || 0) / totalMsg : 0;
        const connCap = usedInstances(ctx, n) * d.perConn;
        const uMsg = cap ? (ctx.units.get(n.id) || 0) / cap : 0;
        const uConn = connCap ? conns / connCap : (conns ? 9 : 0);
        util = Math.max(uMsg, uConn);
        info = { conns, connCap, uMsg, uConn };
      } else if (n.type === 'queue') {
        const u = Object.values(ld).reduce((s, v) => s + v, 0);
        util = cap ? u / cap : (u ? 9 : 0);
        const e = ENG(n);
        base = e.cap === 'partitions' ? ({ '0': 1, '1': 3, all: 6 }[n.props.acks || '1'] + (n.props.semantics === 'exactly' ? 3 : 0)) : e.lat;
      } else if (n.type !== 'client') {
        const u = ctx.units.get(n.id) || 0;
        util = cap ? u / cap : (u ? 9 : 0);
      }
      util *= lbImb(ctx, n);
      if (n.type === 'lb') base = n.props.mode === 'l4' ? 0.3 : 1;
      if (n.type === 'external') base = (L.ext && L.ext.ms) || 500;
      if (n.type === 'worker') base = (L.job && L.job.ms) || 100;
      if (n.type === 'objstore') base = 30;
      if (n.type === 'cdc') base = 120;
      st = { util, lat: () => base * qf(util), ok: () => util > 1 ? 1 / util : 1, info };
    }
    st.cap = cap; st.dead = dead; st.load = ld;
    ctx.stateMemo.set(n.id, st);
    return st;
  }

  function wsDelivery(ctx, n) {
    const a = usedInstances(ctx, n);
    const r = route(ctx, n.id, 'msg');
    if (r.pubsub || a <= 1) return 1;
    return 1 / a;
  }
  function availability(ctx, n) {
    const dn = down(ctx, n);
    if (!dn) return 1;
    if (n.type === 'sql' && n.props.replicas === 0) return 1 - 1 / n.props.shards;
    if (n.type === 'nosql') {
      const c = count(ctx, n), rf = n.props.rf || 3;
      if (rf === 1) return 1 - 1 / c;
      if (n.props.cl === 'all') return Math.max(0, 1 - rf / c);
    }
    if (lbNoHealth(ctx, n) && ['app', 'ws', 'gateway'].includes(n.type)) return alive(ctx, n) / count(ctx, n);
    return 1;
  }

  /* ---------- задержка и успешность запроса ---------- */
  function evalReq(ctx, id, kind, depth) {
    const key = id + '|' + kind;
    if (ctx.evalMemo.has(key)) return ctx.evalMemo.get(key);
    if (depth > 18) return { lat: 0, s: 1, r: 1 };
    const n = ctx.nodes.get(id);
    if (isDead(ctx, n)) { const z = { lat: 0, s: 0, r: 1 }; ctx.evalMemo.set(key, z); return z; }
    ctx.evalMemo.set(key, { lat: 0, s: 1, r: 1 });
    const rt = route(ctx, id, kind), st = state(ctx, n);
    let lat = (n.type === 'client' ? 0 : st.lat(kind)) + (rt.lat || 0);
    let s = st.ok(kind) * (1 - (rt.fail || 0)) * availability(ctx, n), rr = 1 - (rt.rand || 0);
    let altFail = 0, altRand = 0, wait = 0, degraded = 0;
    const altList = [];
    for (const f of rt.fwd) {
      if (f.mode === 'async' || f.visual) continue;
      const ep = edgeProps(ctx, id, f.to);
      const child = ctx.nodes.get(f.to);
      const c0 = evalReq(ctx, f.to, f.kind, depth + 1), sk = ctx.opts.sick && ctx.opts.sick[f.to];
      const c = sk ? { lat: c0.lat * (sk.slow || 1) + (sk.add || 0), s: c0.s * (1 - (sk.fail || 0)), r: c0.r } : c0;
      const ek = SD.edgeKind(n, child);
      const pl = ek.proto ? (SD.PROTOCOLS[ep.proto] || SD.PROTOCOLS.rest).lat : 0;
      const cl = Math.max(0.2, c.lat + pl);
      const useResil = ek.resil;
      const to = useResil ? ep.timeout : 0;
      const tf = to > 0 ? clamp((cl * 1.5 - to) / cl, 0, 1) : 0;
      let sC = c.s * (1 - tf), rC = c.r;
      let latCall = to > 0 ? Math.min(cl, to) : cl;
      const nR = useResil ? ep.retries : 0;
      const open = useResil && ep.cb && sC < 0.5;
      const pf = 1 - sC * rC;
      let A = 1;
      for (let i = 1; i <= nR; i++) A += Math.pow(pf, i);
      let sF = 1 - Math.pow(1 - sC, nR + 1), rF = 1 - Math.pow(1 - rC, nR + 1);
      if (open) {
        A = 1 + (nR ? (1 - rC) : 0);
        sF = sC;
        latCall = sC * latCall + (1 - sC) * 1;
      }
      const ampLoad = ep.backoff === 'exp' ? 1 + (A - 1) * 0.4 : A;
      const latTotal = latCall * A + (A - 1) * (ep.backoff === 'exp' ? 80 : 3);
      if (useResil) ctx.newAmp.set(id + '>' + f.to + '|' + f.kind, ampLoad);
      ctx.edgeInfo.set(id + '>' + f.to, { open, tf, amp: ampLoad, retries: nR, lat: latTotal, s: sF * rF });
      const pf1 = Math.min(f.f, 1);
      const w = f.latMul !== undefined ? f.latMul : (f.mode === 'alt' ? f.f : pf1);
      if (THREADED.has(n.type)) wait += (f.mode === 'alt' ? f.f : pf1) * Math.max(0, latTotal - 30) / (AI_TYPES.has(child.type) ? 600 : 80);
      lat += (f.mode === 'alt' ? f.f : pf1) * (f.net || 0) + w * latTotal;
      if (useResil && ep.fallback) {
        degraded += pf1 * (1 - sF * rF);
        sF = 1; rF = 1;
      }
      if (f.mode === 'alt') { altFail += f.f * (1 - sF); altRand += f.f * (1 - rF); altList.push({ f: f.f, s: sF * rF }); }
      else { s *= 1 - pf1 * (1 - sF); rr *= 1 - pf1 * (1 - rF); }
    }
    if (rt.failover && altList.length > 1) {
      altFail = altList.reduce((acc, x, i) => acc + x.f * (1 - x.s) * (1 - Math.max(...altList.filter((_, j) => j !== i).map(y => y.s))), 0);
      altRand = 0;
    }
    if (THREADED.has(n.type)) { const wm = X().waitMul(ctx, n); ctx.newWait.set(key, wait * (wm === undefined ? 1 : wm)); }
    if (degraded > 0) ctx.degraded.set(key, degraded);
    if (rt.blocked) s = 1;
    s *= Math.max(0, 1 - altFail); rr *= Math.max(0, 1 - altRand);
    if (n.type === 'ws') s *= wsDelivery(ctx, n);
    const res = { lat, s: clamp(s, 0, 1), r: clamp(rr, 0, 1) };
    ctx.evalMemo.set(key, res);
    return res;
  }

  function evaluateAll(ctx, traffic, client) {
    const kinds = {};
    Object.keys(traffic).forEach(k => {
      kinds[k] = client ? evalReq(ctx, client.id, k, 0) : { lat: 0, s: 0, r: 1 };
    });
    /* обработчики очередей тоже ждут зависимости */
    for (const n of ctx.nodes.values()) {
      if ((n.type === 'worker' || n.type === 'app') && ((ctx.load.get(n.id) || {}).job)) evalReq(ctx, n.id, 'job', 0);
    }
    return kinds;
  }

  function run(level, graph, opts) {
    opts = Object.assign({ mul: 1, down: {} }, opts || {});
    const client = graph.nodes.find(n => n.type === 'client');
    const traffic = trafficOf(level, opts.mul);
    const fb = { amp: new Map(), wait: new Map(), scaled: new Map() };
    let ctx, ev;
    for (let it = 0; it < ITER; it++) {
      ctx = build(level, graph, opts, fb);
      if (X().prepare) X().prepare(ctx);
      if (client) Object.entries(traffic).forEach(([k, a]) => push(ctx, client.id, k, a, 0, null, false));
      ev = evaluateAll(ctx, traffic, client);
      if (it === ITER - 1) break;
      const mix = it === 0 ? 1 : 0.5;
      ctx.newAmp.forEach((v, k) => fb.amp.set(k, (fb.amp.get(k) || 1) * (1 - mix) + v * mix));
      ctx.newWait.forEach((v, k) => fb.wait.set(k, (fb.wait.get(k) || 0) * (1 - mix) + v * mix));
      for (const n of ctx.nodes.values()) {
        if (n.type === 'app' && n.props.autoscale) {
          const need = Math.ceil((ctx.units.get(n.id) || 0) / (T().app.perCap * (SD.SIZE_F[n.props.size] || 1) * (+n.props.hpaTarget || 0.6)));
          fb.scaled.set(n.id, clamp(need, n.props.count, 30));
        }
        if (n.type === 'worker' && n.props.autoscale && level.job) {
          const per = level.job.conc * 1000 / level.job.ms;
          const need = Math.ceil(((ctx.load.get(n.id) || {}).job || 0) / (per * 0.7));
          fb.scaled.set(n.id, clamp(need, n.props.count, 40));
        }
      }
    }
    return collect(level, graph, opts, ctx, ev, traffic);
  }

  function collect(level, graph, opts, ctx, ev, traffic) {
    const res = { kinds: {}, nodes: {}, edges: {}, queues: {}, cost: 0, ctx, mul: opts.mul };
    let tot = 0, okSum = 0, latSum = 0, degSum = 0;
    const client = graph.nodes.find(n => n.type === 'client');
    Object.entries(traffic).forEach(([k, a]) => {
      const e = ev[k];
      let success = e.s * e.r;
      const timeout = e.lat > (level.timeoutMs || TIMEOUT);
      if (timeout) success = 0;
      const deg = client ? degradedFrom(ctx, client.id, k, 0) : 0;
      res.kinds[k] = { rps: a, lat: e.lat, success, timeout, capOk: e.s, degraded: deg };
      if (k !== 'bot' && k !== 'inject') { tot += a; okSum += a * success; latSum += a * Math.min(e.lat, level.timeoutMs || TIMEOUT); degSum += a * deg; }
    });
    if (traffic.bot) {
      let botIn = 0;
      for (const n of ctx.nodes.values()) if (n.type === 'app') botIn += (ctx.load.get(n.id) || {}).bot || 0;
      res.kinds.bot.passed = botIn / traffic.bot;
    }
    res.total = { rps: tot, success: tot ? okSum / tot : 1, lat: tot ? latSum / tot : 0, degraded: tot ? degSum / tot : 0 };

    for (const n of ctx.nodes.values()) {
      const st = state(ctx, n);
      const ld = ctx.load.get(n.id) || {};
      const rps = Object.values(ld).reduce((s, v) => s + v, 0);
      const cnt = count(ctx, n);
      res.nodes[n.id] = {
        util: st.util, cap: st.cap, dead: st.dead, rps, load: ld, info: st.info || null,
        used: usedInstances(ctx, n), alive: alive(ctx, n), count: cnt, scaled: ctx.fb.scaled.has(n.id) && cnt !== (n.props.count || 1),
        status: st.dead ? 'dead' : st.util > 1 ? 'hot' : st.util > 0.75 ? 'warn' : 'ok'
      };
      const sc = ctx.fb.scaled.get(n.id);
      const c = T()[n.type].cost(sc ? Object.assign({}, n, { props: Object.assign({}, n.props, { count: sc }) }) : n, res.nodes[n.id], level);
      res.nodes[n.id].cost = c;
      res.cost += c;
    }
    graph.edges.forEach(e => {
      const f = ctx.edgeFlow.get(e.from + '>' + e.to) || {};
      const total = Object.values(f).reduce((s, v) => s + v, 0);
      const from = ctx.nodes.get(e.from);
      const info = ctx.edgeInfo.get(e.from + '>' + e.to) || null;
      const isAsync = !!(from && ((from.type === 'queue' && f.job) || from.type === 'cdc' || (from.type === 'sql' && f.job)));
      res.edges[e.id] = { flow: total, byKind: f, async: isAsync, info };
    });

    /* очереди: приход, разбор, потери, дубли */
    let backlogRate = 0, lostRate = 0, dupRate = 0, jobsIn = 0;
    const randFail = (level.ext && level.ext.fail) || 0;
    for (const n of ctx.nodes.values()) {
      if (n.type !== 'queue') continue;
      const J = (ctx.load.get(n.id) || {}).job || 0;
      if (!J) continue;
      jobsIn += J;
      let drain = 0, rand = 0, spare = 0, consumers = 0, dedupAll = true;
      kids(ctx, n.id).filter(k => k.type === 'worker' || k.type === 'app').forEach(w => {
        const amt = ((ctx.edgeFlow.get(n.id + '>' + w.id) || {}).job) || 0;
        const e2 = evalReq(ctx, w.id, 'job', 0);
        drain += amt * e2.s; rand += amt * e2.s * (1 - e2.r);
        spare += Math.max(0, capacity(ctx, w) - amt);
        consumers += usedInstances(ctx, w);
        if (!(w.type === 'worker' && w.props.dedup)) dedupAll = false;
      });
      const growth = Math.max(0, J - drain);
      const sem = n.props.semantics || 'least';
      let lost = n.props.retries ? 0 : rand;
      if (sem === 'most') lost = J * 0.002 + rand;
      let dup = 0;
      if (sem === 'least') dup = J * 0.002 + (n.props.retries ? J * randFail * 0.5 : 0);
      if (sem === 'exactly') dup = level.job && level.job.target === 'external' ? J * randFail * 0.5 : 0;
      if (dedupAll && consumers > 0) dup = 0;
      res.queues[n.id] = { in: J, drain, growth, lost, dup, spare, consumers, sem };
      backlogRate += growth; lostRate += lost; dupRate += dup;
    }
    lostRate += ctx.jobsMissing;
    res.jobs = { in: jobsIn + ctx.jobsMissing, backlogRate, lostRate, dupRate, missing: ctx.jobsMissing };

    /* распределённые транзакции: частичные записи и компенсации */
    let inconsistent = 0, compensations = 0, sagaNoBroker = false;
    for (const n of ctx.nodes.values()) {
      if (n.type !== 'app') continue;
      const svc = kids(ctx, n.id).filter(k => k.type === 'app');
      const wl = (ctx.load.get(n.id) || {}).write || 0;
      if (!svc.length || !wl) continue;
      const pOk = svc.reduce((p, s) => { const e = evalReq(ctx, s.id, 'write', 0); return p * e.s * e.r; }, 1);
      const tx = n.props.txMode || 'local';
      if (tx === 'local') inconsistent += wl * (1 - pOk);
      if (tx === 'saga') { compensations += wl * (1 - pOk); if (!kidOf(ctx, n.id, ['queue'])) sagaNoBroker = true; }
    }
    res.dist = { inconsistent, compensations, sagaNoBroker };
    if (X().collect) X().collect(ctx, res, level, H);
    return res;
  }

  function degradedFrom(ctx, id, kind, depth) {
    if (depth > 18) return 0;
    let d = ctx.degraded.get(id + '|' + kind) || 0;
    const rt = ctx.routeMemo.get(id + '|' + kind);
    if (!rt) return d;
    for (const f of rt.fwd) {
      if (f.mode === 'async' || f.visual) continue;
      d += Math.min(f.f, 1) * degradedFrom(ctx, f.to, f.kind, depth + 1);
    }
    return Math.min(1, d);
  }

  const H = { kids, parents, kidOf, pickStore, isDead, ENG, alive, count, down, usedInstances, spread, canHandle, jobForward, edgeProps, sqlW, MANAGED, hitRatio,
    capacity: (ctx, n) => capacity(ctx, n), state: (ctx, n) => state(ctx, n), evalReq: (ctx, id, k) => evalReq(ctx, id, k, 0), qf, clamp };
  SD.sim = { run, TIMEOUT, CHAOS_TYPES, MANAGED, AI_TYPES, internals: H };
})();
