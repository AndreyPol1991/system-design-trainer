/* AI-модуль симуляции: подключается к движку через SD.simExt.
   Любой узел, у которого есть AI-потомки (сервис, STT), сам собирает конвейер:
   семантический кэш → guardrails → RAG (эмбеддинг + векторный поиск) → агент / роутер / LLM → синтез речи. */
(function () {
  const AI = new Set(['llm', 'router', 'semcache', 'guard', 'embed', 'vectordb', 'stt', 'tts', 'agent']);
  const CHATLIKE = ['chat', 'vchat', 'agentllm', 'inject'];
  const SEM = { '0.98': { hit: 0.45, wrong: 0.002 }, '0.95': { hit: 0.75, wrong: 0.015 }, '0.90': { hit: 0.92, wrong: 0.06 } };
  const VDB = { hnsw: { qps: 1500, lat: 6, recall: 0.97, kb: 7 }, ivf: { qps: 2500, lat: 10, recall: 0.92, kb: 1 }, flat: { qps: 40, lat: 250, recall: 1, kb: 6 } };
  const MONTH = 2.63e6;
  const ai = L => Object.assign({ inTok: 800, outTok: 300, ragTok: 2500, repeat: 0.3, audioSec: 5, steps: 4, agentOut: 150, simple: 0.7, factual: false, chunks: 40 }, L.ai || {});
  const gpusAlive = (ctx, n, H) => Math.max(0, (n.props.gpus || 1) - H.down(ctx, n));
  const isApi = n => n.props.hosting === 'api';

  function semHit(ctx, sc) { const a = ai(ctx.level); return a.repeat * (SEM[sc.props.threshold] || SEM['0.95']).hit; }
  function guardBlock(g) { return g.props.mode === 'both' ? 0.97 : 0.9; }

  function canHandle(ctx, n, kind, viaKids) {
    const isAiKind = SD.AI_KINDS.includes(kind) || ['vchat', 'speak', 'embq', 'vsearch', 'upsert', 'agentllm'].includes(kind);
    if (!AI.has(n.type)) {
      if (n.type === 'app' && isAiKind) return ['chat', 'voice', 'inject', 'docs', 'vchat'].includes(kind);
      return undefined;
    }
    switch (n.type) {
      case 'llm': return CHATLIKE.includes(kind);
      case 'router': return CHATLIKE.includes(kind) && viaKids();
      case 'semcache': return kind === 'chat' || kind === 'vchat';
      case 'guard': return kind === 'chat' || kind === 'vchat' || kind === 'inject';
      case 'embed': return kind === 'embq';
      case 'vectordb': return kind === 'vsearch' || kind === 'upsert';
      case 'stt': return kind === 'voice';
      case 'tts': return kind === 'speak';
      case 'agent': return kind === 'chat' || kind === 'vchat' || kind === 'inject';
    }
    return false;
  }

  /* конвейер ответа ассистента, который собирает узел-оркестратор */
  function chatPipeline(ctx, n, kind, r, H, f0) {
    const ks = H.kids(ctx, n.id);
    const find = t => ks.find(k => k.type === t);
    let miss = f0;
    const sc = find('semcache');
    if (sc && kind !== 'inject') { r.fwd.push({ to: sc.id, kind, f: f0, mode: 'seq' }); miss = f0 * (1 - semHit(ctx, sc)); r.semcache = sc.id; }
    const g = find('guard');
    let pass = 1;
    if (g) { r.fwd.push({ to: g.id, kind, f: miss, mode: 'seq' }); if (kind === 'inject') pass = 1 - guardBlock(g); r.guard = g.id; }
    const vdb = find('vectordb'), emb = find('embed');
    if (vdb && kind !== 'inject') {
      if (emb) r.fwd.push({ to: emb.id, kind: 'embq', f: miss * pass, mode: 'seq' });
      else r.noEmbed = true;
      r.fwd.push({ to: vdb.id, kind: 'vsearch', f: miss * pass, mode: 'seq' });
      r.rag = true;
    }
    const model = find('agent') || find('router') || find('llm');
    if (model) r.fwd.push({ to: model.id, kind, f: miss * pass, mode: 'seq' });
    else { r.fail = Math.max(r.fail, miss / f0); r.noModel = true; }
    if (kind === 'vchat') {
      const chained = model && H.kids(ctx, model.id).some(k => k.type === 'tts');
      const tts = find('tts');
      if (tts && !chained) r.fwd.push({ to: tts.id, kind: 'speak', f: f0, mode: 'seq' });
      else if (!tts && !chained) { r.noTts = true; r.fail = 1; }
    }
  }

  function route(ctx, n, kind, r, H) {
    const L = ctx.level, a = ai(L);
    const ks = H.kids(ctx, n.id);
    if (n.type === 'app') {
      if (kind === 'chat' || kind === 'inject' || kind === 'vchat') { r.u = 1; chatPipeline(ctx, n, kind, r, H, 1); return true; }
      if (kind === 'voice') {
        const stt = ks.find(k => k.type === 'stt');
        if (!stt) { r.fail = 1; r.noStt = true; return true; }
        r.fwd.push({ to: stt.id, kind: 'voice', f: 1, mode: 'seq' });
        const chain = H.kids(ctx, stt.id).some(k => AI.has(k.type) && k.type !== 'stt');
        if (!chain) chatPipeline(ctx, n, 'vchat', r, H, 1);
        return true;
      }
      if (kind === 'docs') {
        r.u = 2;
        const st = H.pickStore(ctx, n.id);
        if (st) r.fwd.push({ to: st.id, kind: 'write', f: 1, mode: 'seq' });
        const o = ks.find(k => k.type === 'objstore');
        if (o) r.fwd.push({ to: o.id, kind: 'blob', f: 1, mode: 'seq' });
        if (ks.some(k => k.type === 'queue')) H.jobForward(ctx, n, r);
        else {
          const v = ks.find(k => k.type === 'vectordb'), e = ks.find(k => k.type === 'embed');
          if (v && e) { r.syncJob = true; r.fwd.push({ to: e.id, kind: 'embq', f: a.chunks, mode: 'seq', latMul: a.chunks * 0.2 }); r.fwd.push({ to: v.id, kind: 'upsert', f: a.chunks, mode: 'seq', latMul: a.chunks * 0.1 }); }
          else r.jobMissing = true;
        }
        return true;
      }
      return false;
    }
    if (n.type === 'worker' && L.job && L.job.target === 'vectordb') {
      const v = ks.filter(k => k.type === 'vectordb'), e = ks.find(k => k.type === 'embed');
      if (!v.length || !e) { r.fail = 1; r.noTarget = true; return true; }
      r.fwd.push({ to: e.id, kind: 'embq', f: a.chunks, mode: 'seq', latMul: 0.2 * a.chunks });
      H.spread(ctx, v, 'upsert', 'alt').forEach(f => r.fwd.push({ ...f, f: f.f * a.chunks, latMul: 0.1 * a.chunks }));
      return true;
    }
    if (!AI.has(n.type)) return false;
    switch (n.type) {
      case 'stt': {
        const chain = ks.some(k => AI.has(k.type));
        if (chain) chatPipeline(ctx, n, 'vchat', r, H, 1);
        break;
      }
      case 'llm': {
        if (kind === 'vchat') { const t = ks.find(k => k.type === 'tts'); if (t) r.fwd.push({ to: t.id, kind: 'speak', f: 1, mode: 'seq' }); }
        break;
      }
      case 'router': {
        const llms = ks.filter(k => H.canHandle(ctx, k.id, kind));
        if (!llms.length) { r.fail = 1; r.noModel = true; break; }
        const live = llms.filter(k => !H.isDead(ctx, k));
        const pool = n.props.failover && live.length ? live : llms;
        const order = ['small', 'medium', 'large'];
        const sorted = pool.slice().sort((x, y) => order.indexOf(x.props.size) - order.indexOf(y.props.size));
        const st = n.props.strategy;
        const lo = sorted[0].props.size, hi = sorted[sorted.length - 1].props.size;
        const small = sorted.filter(k => k.props.size === lo), big = sorted.filter(k => k.props.size === hi);
        const even = list => list.forEach(k => r.fwd.push({ to: k.id, kind, f: 1 / list.length, mode: 'alt' }));
        if (st === 'quality') even(big);
        else if (st === 'cost' && lo !== hi) {
          small.forEach(k => r.fwd.push({ to: k.id, kind, f: a.simple / small.length, mode: 'alt' }));
          big.forEach(k => r.fwd.push({ to: k.id, kind, f: (1 - a.simple) / big.length, mode: 'alt' }));
        } else even(sorted);
        r.failover = !!n.props.failover;
        if (r.failover) r.altPool = pool.map(k => k.id);
        break;
      }
      case 'guard': {
        if (kind !== 'inject') r.fail = 0.0005;
        break;
      }
      case 'agent': {
        const model = ks.find(k => k.type === 'router') || ks.find(k => k.type === 'llm');
        const calls = a.steps <= n.props.maxSteps ? a.steps + 0.08 * (n.props.maxSteps - a.steps) : n.props.maxSteps;
        r.calls = calls;
        if (!model) { r.fail = 1; r.noModel = true; break; }
        r.fwd.push({ to: model.id, kind: 'agentllm', f: calls, mode: 'seq', latMul: calls });
        const tools = ks.filter(k => ['app', 'search', 'vectordb', 'sql', 'nosql', 'external'].includes(k.type));
        r.tools = tools.length;
        const tk = { app: 'read', search: 'search', vectordb: 'vsearch', sql: 'read', nosql: 'read', external: 'job' };
        const per = Math.max(0, calls - 1) / Math.max(1, tools.length);
        tools.forEach(t => r.fwd.push({ to: t.id, kind: tk[t.type], f: per, mode: 'seq', latMul: per }));
        if (kind === 'vchat') { const t = ks.find(k => k.type === 'tts'); if (t) r.fwd.push({ to: t.id, kind: 'speak', f: 1, mode: 'seq' }); }
        break;
      }
      default: break;
    }
    return true;
  }

  function isDead(ctx, n, H) {
    if (!AI.has(n.type)) return undefined;
    if (n.type === 'router' || n.type === 'semcache') return false;
    const d = H.down(ctx, n);
    if (['llm', 'stt', 'tts', 'embed'].includes(n.type)) {
      if (isApi(n)) return d > 0;
      const g = gpusAlive(ctx, n, H);
      const min = n.type === 'llm' ? (SD.LLM_SIZES[n.props.size] || SD.LLM_SIZES.medium).minGpu : 1;
      return g < min;
    }
    return H.alive(ctx, n) === 0;
  }

  function capacity(ctx, n, H) {
    if (!AI.has(n.type)) return undefined;
    const a = ai(ctx.level);
    switch (n.type) {
      case 'llm': {
        if (isApi(n)) return (SD.API_TIERS[n.props.tier] || SD.API_TIERS.pro).rps;
        const m = SD.LLM_SIZES[n.props.size] || SD.LLM_SIZES.medium;
        const g = gpusAlive(ctx, n, H);
        if (g < m.minGpu) return 0;
        const tok = Math.min(n.props.maxOut, a.outTok) + (a.inTok + (ctx.ragActive ? a.ragTok : 0)) * 0.08;
        return g * m.gpuTok / tok;
      }
      case 'stt': return isApi(n) ? (SD.API_TIERS[n.props.tier] || SD.API_TIERS.pro).rps * 2 : gpusAlive(ctx, n, H) * SD.STT_MODELS[n.props.model].streams / a.audioSec;
      case 'tts': return isApi(n) ? (SD.API_TIERS[n.props.tier] || SD.API_TIERS.pro).rps * 2 : gpusAlive(ctx, n, H) * SD.TTS_MODELS[n.props.model].streams / (a.outTok * 0.05);
      case 'embed': return isApi(n) ? 3000 : gpusAlive(ctx, n, H) * 3000;
      case 'vectordb': return H.alive(ctx, n) * VDB[n.props.index].qps;
      case 'semcache': return 20000;
      case 'guard': return H.alive(ctx, n) * 400;
      case 'router': return 50000;
      case 'agent': return H.alive(ctx, n) * 300;
    }
    return undefined;
  }

  function vdbMemOk(ctx, n, H) {
    const a = ai(ctx.level);
    const needGb = (a.corpusM || 2) * 1e6 * VDB[n.props.index].kb / 1e6;
    const have = H.alive(ctx, n) * 64;
    return { needGb, have, ok: needGb <= have };
  }

  function state(ctx, n, ld, cap, H) {
    if (!AI.has(n.type)) return undefined;
    const a = ai(ctx.level);
    const sum = ks => ks.reduce((s, k) => s + (ld[k] || 0), 0);
    let units = 0, info = {}, lat = () => 0;
    const qf = H.qf;
    switch (n.type) {
      case 'llm': {
        const m = SD.LLM_SIZES[n.props.size] || SD.LLM_SIZES.medium;
        units = sum(CHATLIKE);
        const util = cap ? units / cap : (units ? 9 : 0);
        const rag = ctx.ragActive ? 1.3 : 1;
        const net = isApi(n) ? 60 : 0;
        const ttft = (m.ttft * (n.props.pcache ? 0.6 : 1) * rag + net) * (isApi(n) ? 1 : qf(Math.min(util, 1.2)));
        const outT = Math.min(n.props.maxOut, a.outTok);
        const gen = outT / m.speed * 1000;
        const agentGen = Math.min(n.props.maxOut, a.agentOut) / m.speed * 1000;
        info = { ttft, gen, outT, truncated: n.props.maxOut < a.outTok, util };
        lat = k => k === 'agentllm' ? ttft + agentGen : (n.props.stream ? ttft : ttft + gen);
        return mk(util, lat, info);
      }
      case 'stt': {
        const m = SD.STT_MODELS[n.props.model];
        units = ld.voice || 0;
        const util = cap ? units / cap : (units ? 9 : 0);
        const base = (n.props.stream ? 250 : a.audioSec * 1000 * m.rtf + 200) + (isApi(n) ? 100 : 0);
        return mk(util, () => base * qf(util), { wer: m.wer });
      }
      case 'tts': {
        const m = SD.TTS_MODELS[n.props.model];
        units = ld.speak || 0;
        const util = cap ? units / cap : (units ? 9 : 0);
        const base = (n.props.stream ? m.first : m.first + a.outTok / 100 * m.per100) + (isApi(n) ? 80 : 0);
        return mk(util, () => base * qf(util), {});
      }
      case 'embed': {
        units = sum(['embq']);
        const util = cap ? units / cap : (units ? 9 : 0);
        return mk(util, () => (isApi(n) ? 60 : 15) * qf(util), {});
      }
      case 'vectordb': {
        units = (ld.vsearch || 0) + (ld.upsert || 0) * 0.3;
        const util = cap ? units / cap : (units ? 9 : 0);
        const mem = vdbMemOk(ctx, n, H);
        const pen = n.props.index === 'hnsw' && !mem.ok ? 6 : 1;
        return mk(util, () => VDB[n.props.index].lat * pen * qf(util), { mem, recall: VDB[n.props.index].recall });
      }
      case 'semcache': units = sum(['chat', 'vchat']); return mk(cap ? units / cap : 0, u => 20, {});
      case 'guard': {
        units = sum(['chat', 'vchat', 'inject']);
        const util = cap ? units / cap : (units ? 9 : 0);
        return mk(util, () => (n.props.mode === 'both' ? 100 : 40) * qf(util), {});
      }
      case 'router': units = sum(CHATLIKE); return mk(units / cap, () => 3, {});
      case 'agent': {
        units = sum(['chat', 'vchat', 'inject']);
        const util = cap ? units / cap : (units ? 9 : 0);
        return mk(util, () => 5 * qf(util), {});
      }
    }
    return undefined;
    function mk(util, latFn, inf) {
      return { util, lat: latFn, ok: () => util > 1 ? 1 / util : 1, info: inf };
    }
  }

  /* метрики AI: стоимость токенов, качество ответов, атаки, утечки */
  function collect(ctx, res, level, H) {
    const a = ai(level);
    const nodes = [...ctx.nodes.values()];
    const llms = nodes.filter(n => n.type === 'llm');
    const anyAi = nodes.some(n => AI.has(n.type));
    const aiTraffic = SD.AI_KINDS.some(k => (level.traffic[k] || 0) > 0);
    if (!anyAi && !aiTraffic) return;
    const out = { tokenCost: 0, quality: null, tokensPerSec: 0, rag: !!ctx.ragActive, piiLeak: false, details: [] };
    const routerOf = id => H.parents(ctx, id).find(p => p.type === 'router');
    let qSum = 0, qW = 0;
    llms.forEach(n => {
      const ld = ctx.load.get(n.id) || {};
      const m = SD.LLM_SIZES[n.props.size] || SD.LLM_SIZES.medium;
      const chat = (ld.chat || 0) + (ld.vchat || 0) + (ld.inject || 0);
      const ag = ld.agentllm || 0;
      const inTok = a.inTok + (ctx.ragActive ? a.ragTok : 0);
      const outT = Math.min(n.props.maxOut, a.outTok);
      const cacheF = n.props.pcache ? 0.37 : 1;
      const tps = chat * (inTok + outT) + ag * (inTok * 1.5 + a.agentOut);
      out.tokensPerSec += tps;
      if (isApi(n)) {
        const usd = MONTH * (chat * (inTok * m.pIn * cacheF + outT * m.pOut) + ag * (inTok * 1.5 * m.pIn * cacheF + a.agentOut * m.pOut)) / 1e6;
        out.tokenCost += usd;
        res.nodes[n.id].cost += usd;
        res.cost += usd;
      }
      const r = routerOf(n.id);
      const easy = Math.min(0.99, m.quality + 0.2);
      let q = a.simple * easy + (1 - a.simple) * m.quality;
      if (r && r.props.strategy === 'cost') {
        const sibs = H.kids(ctx, r.id).filter(k => k.type === 'llm');
        const order = ['small', 'medium', 'large'];
        const minS = Math.min(...sibs.map(s => order.indexOf(s.props.size)));
        const maxS = Math.max(...sibs.map(s => order.indexOf(s.props.size)));
        if (minS !== maxS) {
          if (order.indexOf(n.props.size) === minS) q = 0.9 * easy + 0.1 * m.quality;
          else if (order.indexOf(n.props.size) === maxS) q = 0.9 * m.quality + 0.1 * easy;
        }
      }
      if (n.props.maxOut < a.outTok) q *= 0.85;
      const w = chat + ag;
      qSum += q * w; qW += w;
    });
    let quality = qW ? qSum / qW : 0;
    if (qW) {
      if (a.factual) {
        const vdbs = nodes.filter(n => n.type === 'vectordb' && ((ctx.load.get(n.id) || {}).vsearch || 0) > 0);
        const recall = vdbs.length ? Math.min(...vdbs.map(v => VDB[v.props.index].recall)) : 0;
        const fed = vdbs.length && level.job && level.job.target === 'vectordb' ? (res.jobs.backlogRate < 0.5 && res.jobs.missing < 0.5 ? 1 : 0.6) : 1;
        quality *= vdbs.length ? (0.7 + 0.3 * recall * fed) : 0.7;
      }
      nodes.filter(n => n.type === 'semcache').forEach(sc => {
        const hit = semHit(ctx, sc); const wr = (SEM[sc.props.threshold] || SEM['0.95']).wrong;
        quality *= 1 - hit * wr * 10;
      });
      const voiceShare = (level.traffic.voice || 0) / ((level.traffic.voice || 0) + (level.traffic.chat || 0) || 1);
      const stts = nodes.filter(n => n.type === 'stt' && ((ctx.load.get(n.id) || {}).voice || 0) > 0);
      if (stts.length && voiceShare) { const wer = Math.max(...stts.map(s => SD.STT_MODELS[s.props.model].wer)); quality *= 1 - voiceShare * wer * 1.5; }
      nodes.filter(n => n.type === 'agent').forEach(ag => {
        const ok = Math.min(1, ag.props.maxSteps / a.steps);
        const rt = ctx.routeMemo.get(ag.id + '|chat');
        const tools = rt && rt.tools ? 1 : 0.4;
        quality *= ok * tools;
      });
    }
    out.quality = qW ? quality : null;

    nodes.forEach(n => {
      const ld = ctx.load.get(n.id) || {};
      if (n.type === 'stt' && isApi(n)) { const usd = MONTH * (ld.voice || 0) * a.audioSec / 60 * 0.006; out.tokenCost += usd; res.nodes[n.id].cost += usd; res.cost += usd; }
      if (n.type === 'tts' && isApi(n)) { const usd = MONTH * (ld.speak || 0) * a.outTok * 4 * 15 / 1e6; out.tokenCost += usd; res.nodes[n.id].cost += usd; res.cost += usd; }
      if (n.type === 'embed' && isApi(n)) { const usd = MONTH * ((ld.embq || 0) * 600) * 0.02 / 1e6; out.tokenCost += usd; res.nodes[n.id].cost += usd; res.cost += usd; }
    });

    if (level.traffic.inject) {
      const reached = llms.reduce((s, n) => s + ((ctx.load.get(n.id) || {}).inject || 0), 0);
      res.kinds.inject.passed = reached / (level.traffic.inject * (res.mul || 1));
    }
    if (a.pii) {
      const piiGuard = nodes.some(n => n.type === 'guard' && n.props.pii && ((ctx.load.get(n.id) || {}).chat || (ctx.load.get(n.id) || {}).vchat));
      const apiLlm = llms.some(n => isApi(n) && Object.keys(ctx.load.get(n.id) || {}).length);
      out.piiLeak = apiLlm && !piiGuard;
    }
    const ag = nodes.filter(n => n.type === 'agent');
    out.agentHitl = ag.length ? ag.every(n => n.props.hitl) : null;
    out.fullAnswer = llms.length ? Math.max(...llms.map(n => { const st = res.ctx.stateMemo.get(n.id); return st && st.info ? st.info.ttft + st.info.gen : 0; })) : 0;
    res.ai = out;
  }

  (SD.simExts = SD.simExts || []).push({
    canHandle, route, capacity, state, collect, isDead,
    prepare(ctx) { ctx.ragActive = [...ctx.nodes.values()].some(n => n.type === 'vectordb' && SD.sim.internals.parents(ctx, n.id).some(p => p.type === 'app' || p.type === 'stt')); }
  });
  SD.AI_TYPES_SET = AI;
})();
