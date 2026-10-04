/* Редактор схемы: узлы, связи, перетаскивание, соединение, панорама, частицы трафика. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 188, H0 = 64;
  /* слои схемы: продукт, наблюдаемость, платформа, данные */
  let layer = 'all';
  try { layer = localStorage.getItem('amp-stroyka-layer') || 'all'; } catch (e) { layer = 'all'; }
  const lyOf = t => (SD.layerOf ? SD.layerOf(t) : 'product');
  const vis = l => layer === 'all' ? 'show' : layer === 'product' ? (l === 'product' ? 'show' : 'hide') : l === layer ? 'show' : l === 'product' ? 'dim' : 'hide';
  const nodeVis = n => vis(lyOf(n.type));
  const edgeVis = (a, b) => { const x = nodeVis(a), y = nodeVis(b); return x === 'hide' || y === 'hide' ? 'hide' : x === 'dim' || y === 'dim' ? 'dim' : 'show'; };
  const isOps = n => !!(n && SD.TYPES[n.type] && SD.TYPES[n.type].ops);
  const opsKind = (a, b) => SD.TYPES[(isOps(b) ? b : a).type].ops;
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (parent) parent.appendChild(e);
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const FLEET = new Set(['app', 'gateway', 'cache', 'nosql', 'worker', 'ws', 'search', 'guard', 'agent', 'vectordb', 'olap', 'tsdb', 'graphdb', 'esb']);
  const GPU_TYPES = new Set(['llm', 'stt', 'tts', 'embed']);
  /* экземпляры рисуются мини-серверами: по 8 в ряд, до 16 видимых */
  const IW = 17, IH = 20, IG = 4, PER = 8, MAXV = 16, IY = 58;

  const E = {
    graph: { nodes: [], edges: [] }, sel: null, view: { x: 0, y: 0, k: 1 }, res: null,
    allowed: null, seq: 1, particles: [], paths: new Map(), running: true, cb: {},
    prev: new Map(), disp: new Map(), floats: new Map(), glow: new Map()
  };
  const isFleet = n => FLEET.has(n.type) || (GPU_TYPES.has(n.type) && n.props.hosting === 'self');
  function fleetCount(n) {
    if (GPU_TYPES.has(n.type)) return n.props.gpus || 1;
    const r = E.res && E.res.nodes[n.id];
    return r ? r.count : (n.props.count || 1);
  }
  const instPos = i => ({ x: 10 + (i % PER) * (IW + IG), y: IY + Math.floor(i / PER) * (IH + 4) });
  function sqlGeo(n) {
    const S = n.props.shards || 1, R = n.props.replicas || 0;
    return { S, R, cols: Math.min(S, 8), rows: Math.min(5, 1 + R), cw: 18, ch: 11, x0: 22, y0: 58 };
  }
  /* слоты балансировщика: по одному на экземпляр каждого сервиса за ним */
  function lbSlots(n) {
    const out = [];
    E.graph.edges.forEach(e => {
      if (e.from !== n.id) return;
      const k = node(e.to); if (!k || !isFleet(k)) return;
      const r = E.res && E.res.nodes[k.id];
      const used = r ? Math.max(1, Math.min(r.used || r.count, r.alive || r.count)) : (k.props.count || 1);
      for (let i = 0; i < Math.min(used, MAXV); i++) out.push({ kid: k.id, i });
    });
    return out.slice(0, 18);
  }
  function lbImbOf(n) {
    let g = 1;
    E.graph.edges.forEach(e => {
      if (e.to !== n.id) return;
      const p = node(e.from); if (!p) return;
      if (p.type === 'lb') g = Math.max(g, (SD.LB_IMB[p.props.algo] || 1.06) * (p.props.sticky ? 1.2 : 1));
      if (p.type === 'gateway') g = Math.max(g, SD.LB_IMB.lc || 1.02);
    });
    return g;
  }

  function init(svg, cb) {
    E.svg = svg; E.cb = cb || {};
    E.vp = svg.querySelector('#viewport');
    E.gEdges = svg.querySelector('#edgesG'); E.gParts = svg.querySelector('#partsG');
    E.gNodes = svg.querySelector('#nodesG'); E.gFx = svg.querySelector('#fxG');
    bindCanvas();
    requestAnimationFrame(tick);
  }

  /* ---------- координаты ---------- */
  function toWorld(cx, cy) {
    const r = E.svg.getBoundingClientRect();
    return { x: (cx - r.left - E.view.x) / E.view.k, y: (cy - r.top - E.view.y) / E.view.k };
  }
  function applyView() { E.vp.setAttribute('transform', `translate(${E.view.x},${E.view.y}) scale(${E.view.k})`); }
  function zoomAt(f, cx, cy) {
    const r = E.svg.getBoundingClientRect();
    const px = cx === undefined ? r.width / 2 : cx - r.left, py = cy === undefined ? r.height / 2 : cy - r.top;
    const k = Math.max(0.3, Math.min(2.2, E.view.k * f));
    E.view.x = px - (px - E.view.x) * k / E.view.k;
    E.view.y = py - (py - E.view.y) * k / E.view.k;
    E.view.k = k; applyView();
  }
  function fit() {
    const r = E.svg.getBoundingClientRect();
    if (!E.graph.nodes.length || !r.width) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    E.graph.nodes.forEach(n => { const s = size(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h); });
    const pad = 40, bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
    const k = Math.max(0.35, Math.min(1.15, Math.min(r.width / bw, r.height / bh)));
    E.view.k = k; E.view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k; E.view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k + 6;
    applyView();
  }

  /* ---------- геометрия узла ---------- */
  function size(n) {
    let h = H0;
    if (n.type === 'sql') { const g = sqlGeo(n); h = g.y0 + g.rows * (g.ch + 3) + 5; }
    else if (n.type === 'queue') h += 14;
    else if (isFleet(n)) { const v = Math.min(fleetCount(n), MAXV); h = IY + Math.ceil(v / PER) * (IH + 4) + 3; }
    else if (n.type === 'lb' && lbSlots(n).length) h += 12;
    return { w: W, h };
  }
  function portOut(n) { const s = size(n); return { x: n.x + s.w, y: n.y + s.h / 2 }; }
  function portIn(n) { const s = size(n); return { x: n.x, y: n.y + s.h / 2 }; }
  function edgePath(a, b) {
    const p = portOut(a), q = portIn(b);
    if (q.x < p.x + 20) {
      const s = size(b), up = b.y + s.h < a.y ? -1 : 1;
      const midY = up < 0 ? Math.min(p.y, q.y) - 40 : Math.max(p.y, q.y) + 40;
      return `M${p.x},${p.y} C${p.x + 60},${p.y} ${p.x + 60},${midY} ${(p.x + q.x) / 2},${midY} S${q.x - 60},${q.y} ${q.x - 2},${q.y}`;
    }
    const dx = Math.max(40, (q.x - p.x) / 2);
    return `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x - 2},${q.y}`;
  }

  function subtitle(n) {
    const p = n.props, r = E.res && E.res.nodes[n.id];
    const cnt = r ? r.count : (p.count || 1);
    switch (n.type) {
      case 'client': return 'интернет';
      case 'external': return 'чужой API';
      case 'app': return `×${cnt} ${(p.size || 'm').toUpperCase()}${p.persistence === 'es' ? ' · ES' : ''}${p.autoscale ? ' авто' : ''}${p.txMode && p.txMode !== 'local' ? ' · ' + (p.txMode === '2pc' ? '2PC' : 'сага') : ''}${SD.innerTag ? SD.innerTag(n) : ''}`;
      case 'gateway': return `×${cnt}${p.rateLimit ? ' · лимит' : ''}`;
      case 'lb': return ({ rr: 'round robin', wrr: 'weighted RR', lc: 'least conn', lrt: 'least time', p2c: 'P2C', hash: 'hash', random: 'random' }[p.algo] || p.algo) + ' · ' + (p.mode || 'l7').toUpperCase() + (p.sticky ? ' · sticky' : '');
      case 'cache': return `${cnt}×${p.mem} ГБ · ${{ aside: 'aside', through: 'through', behind: 'behind' }[p.policy]}${p.geo ? ' · GEO' : ''}${p.cluster === 'replicated' ? ' · репл.' : ''}`;
      case 'sql': return `${(p.size || 'm').toUpperCase()} · S${p.shards}×R${p.replicas} · ${{ rc: 'RC', rr: 'RR', ser: 'SER' }[p.isolation || 'rc']} · ${(p.idx || []).length} инд.${p.partition && p.partition !== 'none' ? ' · парт.' : ''}`;
      case 'nosql': return `${{ wide: 'wide', doc: 'doc', kv: 'kv' }[p.model || 'wide']} · ${cnt} узл. · RF${p.rf} · ${String(p.cl).toUpperCase()}`;
      case 'olap': return `${cnt} шард. · ${{ star: 'звезда', snowflake: 'снежинка', obt: 'OBT' }[p.schema]}${p.mv ? ' · MV' : ''}`;
      case 'etl': return `${{ stream: 'поток', hourly: 'раз в час', daily: 'ночью' }[p.mode]} · ${p.approach.toUpperCase()}`;
      case 'lake': return `${p.format}${p.iceberg ? ' · Iceberg' : ''}`;
      case 'tsdb': return `${cnt} узл. · ${p.retention}${p.downsample ? ' · даунсэмпл.' : ''}`;
      case 'graphdb': return `${cnt} узл.`;
      case 'esb': return `×${cnt}`;
      case 'faas': return `${p.mem} МБ · до ${p.conc}${p.provisioned ? ' · прогрев' : ''}`;
      case 'queue': { const e = SD.ENGINES[p.engine]; const short = { kafka: 'Kafka', rabbit: 'RabbitMQ', nats: 'NATS', sqs: 'SQS', sqsfifo: 'SQS FIFO', redis: 'Redis Str.' }[p.engine];
        return `${short}${p.engine === 'kafka' ? ' · ' + p.partitions + ' парт. · acks=' + p.acks : ''}${e && !e.managed ? ' · ' + p.count + ' бр.' : ''}`; }
      case 'worker': return `×${cnt}${p.dedup ? ' · inbox' : ''}${p.autoscale ? ' · KEDA' : ''}${SD.innerTag ? SD.innerTag(n) : ''}`;
      case 'ws': return `×${cnt} · до ${SD.fmt.num(cnt * 100000)} соед.`;
      case 'search': return `${cnt} узл.`;
      case 'cdn': return `TTL ${{ min: '1 мин', hour: '1 ч', day: '1 сут' }[p.ttl]}`;
      case 'objstore': return 'S3';
      case 'cdc': return 'WAL → брокер';
      case 'llm': return `${{ small: 'малая', medium: 'средняя', large: 'большая' }[p.size]} · ${p.hosting === 'api' ? 'API ' + p.tier : p.gpus + ' GPU'}${p.stream ? ' · stream' : ''}`;
      case 'stt': return `${{ tiny: 'tiny', base: 'small', large: 'large-v3' }[p.model]} · ${p.hosting === 'api' ? 'API' : p.gpus + ' GPU'}`;
      case 'tts': return `${p.model === 'neural' ? 'нейронный' : 'быстрый'} · ${p.hosting === 'api' ? 'API' : p.gpus + ' GPU'}`;
      case 'embed': return p.hosting === 'api' ? 'API' : p.gpus + ' GPU';
      case 'vectordb': return `${cnt} узл. · ${p.index.toUpperCase()}`;
      case 'semcache': return `порог ${p.threshold}`;
      case 'guard': return `×${cnt} · ${p.mode === 'both' ? 'вход+выход' : 'вход'}${p.pii ? ' · PII' : ''}`;
      case 'router': return { cost: 'по сложности', quality: 'в сильную', balance: 'поровну' }[p.strategy] + (p.failover ? ' · фолбэк' : '');
      case 'agent': return `×${cnt} · ≤ ${p.maxSteps} шагов${p.hitl ? ' · HITL' : ''}`;
      default: return '';
    }
  }

  /* ---------- отрисовка ---------- */
  function utilClass(u) { return u > 1 ? 'hot' : u > 0.75 ? 'warn' : 'ok'; }
  const fillFor = u => u > 1 ? 'var(--bad)' : u > 0.75 ? 'var(--warn)' : 'var(--ok)';

  function render(res) {
    if (res) E.res = res;
    renderEdges(); renderNodes();
  }

  function renderNodes() {
    const g = E.gNodes; g.textContent = '';
    E.graph.nodes.forEach(n => {
      const s = size(n), r = E.res && E.res.nodes[n.id];
      const st = r ? r.status : 'ok';
      const sel = E.sel && E.sel.type === 'node' && E.sel.id === n.id;
      const ch = changeOf(n, r);
      const gl = E.glow.get(n.id), glc = gl && gl.until > performance.now() ? ' ' + gl.cls : '';
      const nv = nodeVis(n);
      const grp = el('g', { class: `node ${st === 'ok' ? '' : st}${sel ? ' sel' : ''}${glc} ly-${lyOf(n.type)}${nv === 'hide' ? ' l-hide' : nv === 'dim' ? ' l-dim' : ''}${isOps(n) ? ' ops-node' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-id': n.id, tabindex: 0, role: 'button', 'aria-label': n.label || SD.TYPES[n.type].name }, g);
      if (n.type === 'sql' && n.props.shards > 1) {
        el('rect', { class: 'stack', x: 6, y: -6, width: s.w, height: s.h, rx: 10 }, grp);
        el('rect', { class: 'stack', x: 3, y: -3, width: s.w, height: s.h, rx: 10 }, grp);
      }
      el('rect', { class: 'body', width: s.w, height: s.h, rx: 10 }, grp);
      if (ch.pulse) el('rect', { class: 'pulse-ring', width: s.w, height: s.h, rx: 10 }, grp);
      el('rect', { class: 'ico-bg', x: 10, y: 11, width: 30, height: 30, rx: 7 }, grp);
      const ic = el('g', { class: 'ico', transform: 'translate(13,14)' }, grp);
      ic.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${SD.iconInner(n.type)}</svg>`;
      const title = n.label || SD.TYPES[n.type].name;
      const t = el('text', { class: 'title', x: 48, y: 24 }, grp); t.textContent = title.length > 19 ? title.slice(0, 18) + '…' : title;
      const sub = el('text', { class: 'sub', x: 48, y: 39 }, grp); const st2 = subtitle(n); sub.textContent = st2.length > 26 ? st2.slice(0, 25) + '…' : st2;
      if (r && n.type !== 'client') {
        const u = Math.min(r.util, 1.5);
        el('rect', { class: 'bar-bg', x: 10, y: 49, width: s.w - 58, height: 4, rx: 2 }, grp);
        el('rect', { class: 'bar', x: 10, y: 49, width: Math.max(2, (s.w - 58) * Math.min(u, 1)), height: 4, rx: 2 }, grp);
        const pct = el('text', { class: 'pct', x: s.w - 10, y: 54, 'text-anchor': 'end' }, grp);
        pct.textContent = r.dead ? 'лежит' : (n.type === 'external' || SD.TYPES[n.type].managed) && r.util < 0.01 ? '' : Math.round(r.util * 100) + ' %';
      }
      if (n.type === 'client' && E.res) {
        const pct = el('text', { class: 'pct', x: 10, y: 54 }, grp);
        pct.textContent = SD.fmt.num(E.res.total.rps) + ' RPS';
      }
      if (r && r.scaled) { const b = el('text', { class: 'badge', x: s.w - 10, y: 16, 'text-anchor': 'end', style: 'fill: var(--info)' }, grp); b.textContent = 'АВТО'; }
      if (r && r.alive < r.count && !r.dead) { const b = el('text', { class: 'badge', x: s.w - 10, y: 16, 'text-anchor': 'end', style: 'fill: var(--bad)' }, grp); b.textContent = `−${r.count - r.alive}`; }
      extras(n, grp, s, r, ch);
      if (n.type !== 'external') el('circle', { class: 'port', cx: s.w, cy: s.h / 2, r: 7, 'data-port': n.id }, grp);
    });
  }

  /* ---------- что изменилось с прошлой отрисовки: анимации роста и подписи ---------- */
  const plural = (n, a, b, c) => { const x = n % 10, y = n % 100; return x === 1 && y !== 11 ? a : x >= 2 && x <= 4 && (y < 10 || y >= 20) ? b : c; };
  function sigOf(n) { const p = Object.assign({}, n.props); delete p.inner; return JSON.stringify(p); }
  function changeOf(n, r) {
    const cur = { count: isFleet(n) ? fleetCount(n) : 0, alive: r ? r.alive : null, rep: n.props.replicas || 0, sh: n.props.shards || 0, parts: n.props.partitions || 0, sig: sigOf(n), scaled: !!(r && r.scaled) };
    const prev = E.prev.get(n.id);
    E.prev.set(n.id, cur);
    const ch = { popFrom: Infinity, goneTo: 0, crashFrom: Infinity, pulse: false, repFrom: Infinity, colFrom: Infinity };
    if (!prev) return ch;
    const d = cur.count - prev.count;
    if (d > 0) { ch.popFrom = prev.count; floatAt(n, `+${d} ${plural(d, 'экземпляр', 'экземпляра', 'экземпляров')}${cur.scaled && sigOf(n) === prev.sig ? ' · автомасштаб' : ''}`, 'up'); }
    if (d < 0) { ch.goneTo = prev.count; floatAt(n, `−${-d} ${plural(-d, 'экземпляр', 'экземпляра', 'экземпляров')}`, 'down'); }
    if (cur.alive != null && prev.alive != null && cur.alive < prev.alive && !d) { ch.crashFrom = cur.alive; floatAt(n, 'экземпляр упал', 'bad'); }
    if (cur.alive != null && prev.alive != null && cur.alive > prev.alive && !d) floatAt(n, 'экземпляр поднят', 'up');
    if (n.type === 'sql') {
      if (cur.rep > prev.rep) { ch.repFrom = 1 + prev.rep; floatAt(n, `+${cur.rep - prev.rep} ${plural(cur.rep - prev.rep, 'реплика', 'реплики', 'реплик')} · копирую данные`, 'up'); }
      if (cur.rep < prev.rep) floatAt(n, `−${prev.rep - cur.rep} ${plural(prev.rep - cur.rep, 'реплика', 'реплики', 'реплик')}`, 'down');
      if (cur.sh > prev.sh) { ch.colFrom = prev.sh; floatAt(n, `${cur.sh} ${plural(cur.sh, 'шард', 'шарда', 'шардов')} · данные делятся`, 'up'); }
      if (cur.sh < prev.sh) floatAt(n, `${cur.sh} ${plural(cur.sh, 'шард', 'шарда', 'шардов')}`, 'down');
    }
    if (n.type === 'queue' && cur.parts !== prev.parts && cur.parts && prev.parts) floatAt(n, `${cur.parts} ${plural(cur.parts, 'партиция', 'партиции', 'партиций')}`, cur.parts > prev.parts ? 'up' : 'down');
    if (cur.sig !== prev.sig) ch.pulse = true;
    return ch;
  }
  function floatAt(n, text, cls) {
    const now = performance.now(), f = E.floats.get(n.id) || { t: 0, k: 0 };
    f.k = now - f.t < 900 ? f.k + 1 : 0; f.t = now; E.floats.set(n.id, f);
    const t = el('text', { class: 'floaty ' + cls, x: n.x + W / 2, y: n.y - 10 - f.k * 15, 'text-anchor': 'middle' }, E.gFx);
    t.textContent = text;
    setTimeout(() => t.remove(), 1900);
  }
  function floatXY(x, y, text, cls) {
    const t = el('text', { class: 'floaty ' + cls, x, y, 'text-anchor': 'middle' }, E.gFx);
    t.textContent = text; setTimeout(() => t.remove(), 2600);
  }
  function markDeltas(prev, res) {
    if (!prev || !res) return;
    const now = performance.now(), list = [];
    E.graph.nodes.forEach(n => {
      if (n.type === 'client') return;
      const a = prev.nodes[n.id], b = res.nodes[n.id];
      if (!a || !b || (SD.TYPES[n.type].managed && b.util < 0.01)) return;
      const ua = Math.min(a.util, 9), ub = Math.min(b.util, 9);
      if (Math.abs(ub - ua) >= 0.05) list.push({ n, ua, ub, d: Math.abs(ub - ua) });
    });
    list.sort((x, y) => y.d - x.d).slice(0, 4).forEach(({ n, ua, ub }) => {
      const better = ub < ua;
      E.glow.set(n.id, { cls: better ? 'glow-good' : 'glow-bad', until: now + 2600 });
      const f = E.floats.get(n.id) || { t: 0, k: 0 };
      f.k = now - f.t < 900 ? f.k + 1 : 0; f.t = now; E.floats.set(n.id, f);
      floatXY(n.x + W / 2, n.y - 10 - f.k * 15, `загрузка ${Math.round(ua * 100)} % → ${Math.round(ub * 100)} %`, better ? 'up' : 'bad');
    });
    const elist = [];
    E.graph.edges.forEach(e => {
      const a = prev.edges[e.id], b = res.edges[e.id], p = E.paths.get(e.id);
      if (!a || !b || !a.info || !b.info || !p) return;
      const ds = b.info.s - a.info.s, dl = b.info.lat - a.info.lat;
      if (Math.abs(ds) >= 0.005) elist.push({ p, txt: `вызовы успешны ${SD.fmt.pct(a.info.s)} → ${SD.fmt.pct(b.info.s)}`, good: ds > 0, d: Math.abs(ds) * 10 });
      else if (Math.abs(dl) >= Math.max(5, a.info.lat * 0.25)) elist.push({ p, txt: `время вызова ${SD.fmt.ms(a.info.lat)} → ${SD.fmt.ms(b.info.lat)}`, good: dl < 0, d: Math.abs(dl) / Math.max(1, a.info.lat) });
      if (Math.abs((b.info.amp || 1) - (a.info.amp || 1)) >= 0.1) elist.push({ p, txt: `нагрузка на соседа ×${(a.info.amp || 1).toFixed(1).replace('.', ',')} → ×${(b.info.amp || 1).toFixed(1).replace('.', ',')}`, good: (b.info.amp || 1) < (a.info.amp || 1), d: 1 });
    });
    elist.sort((x, y) => y.d - x.d).slice(0, 2).forEach((x, i) => { const len = x.p.getTotalLength(), m = x.p.getPointAtLength(len / 2); floatXY(m.x, m.y + 22 + i * 14, x.txt, x.good ? 'up' : 'bad'); });
    renderNodes();
  }
  function flashEl(sel) {
    const x = E.gNodes.querySelector(sel); if (!x) return;
    x.classList.remove('hit'); void x.getBoundingClientRect(); x.classList.add('hit');
  }

  function extras(n, grp, s, r, ch) {
    if (n.type === 'sql') return sqlExtras(n, grp, s, r, ch);
    if (n.type === 'queue') return queueExtras(n, grp, s, r);
    if (n.type === 'lb') return lbExtras(n, grp);
    if (!isFleet(n)) return;
    const gpu = GPU_TYPES.has(n.type);
    const total = fleetCount(n), vis = Math.min(total, MAXV);
    const alive = r ? (gpu ? total - (r.count - r.alive) : r.alive) : total;
    const used = r ? (gpu ? alive : Math.min(r.used, alive)) : total;
    const g = used > 1 ? lbImbOf(n) : 1;
    const base = r ? r.util : 0;
    const autoFrom = r && r.scaled ? (n.props.count || 1) : Infinity;
    const upto = Math.max(vis, Math.min(ch.goneTo || 0, MAXV));
    for (let i = 0; i < upto; i++) {
      const p = instPos(i), gone = i >= vis;
      const dead = !gone && i >= alive, idle = !gone && !dead && i >= used;
      const u = dead || idle || gone ? 0 : Math.max(0, base / g * (1 + (g - 1) * Math.sin(i * 2.39 + 0.7)));
      const outer = el('g', { transform: `translate(${p.x},${p.y})` }, grp);
      const cls = ['inst', gpu ? 'gpu' : '', dead ? 'dead' : '', idle ? 'idle' : '', i >= autoFrom ? 'auto' : '', u > 1 ? 'hot' : '', i >= ch.popFrom && !gone ? 'pop' : '', gone ? 'gone' : '', dead && i >= ch.crashFrom ? 'crash' : ''].filter(Boolean).join(' ');
      const ig = el('g', { class: cls, 'data-inst': n.id + ':' + i }, outer);
      if (i >= ch.popFrom && !gone) ig.style.animationDelay = Math.min(600, (i - ch.popFrom) * 70) + 'ms';
      el('rect', { class: 'ib', width: IW, height: IH, rx: 3 }, ig);
      const fh = Math.min(1, u) * (IH - 5);
      if (fh > 0.4) el('rect', { class: 'if', x: 2, y: IH - 2 - fh, width: IW - 4, height: fh, rx: 1.5, style: `fill:${fillFor(u)}` }, ig);
      el('line', { class: 'il', x1: 3.5, y1: 5, x2: 9.5, y2: 5 }, ig);
      el('circle', { class: 'led', cx: IW - 4, cy: 5, r: 1.5 }, ig);
      if (dead) el('path', { class: 'ix', d: `M4,8 L${IW - 4},${IH - 3} M${IW - 4},8 L4,${IH - 3}` }, ig);
      const tt = el('title', null, ig);
      tt.textContent = gone ? '' : `${gpu ? 'GPU' : 'Экземпляр'} ${i + 1}: ${dead ? 'упал' : idle ? 'простаивает' : 'загрузка ' + Math.round(u * 100) + ' %'}${i >= autoFrom ? ' · добавлен автомасштабированием' : ''}`;
    }
    if (total > MAXV) { const t = el('text', { class: 'sub more', x: s.w - 8, y: s.h - 6, 'text-anchor': 'end' }, grp); t.textContent = `+${total - MAXV}`; }
  }
  function sqlExtras(n, grp, s, r, ch) {
    const G = sqlGeo(n), info = r && r.info;
    for (let k = 0; k < G.rows; k++) { const t = el('text', { class: 'sql-lbl', x: 9, y: G.y0 + k * (G.ch + 3) + 9 }, grp); t.textContent = k === 0 ? 'P' : 'R'; }
    for (let c = 0; c < G.cols; c++) {
      const x = G.x0 + c * (G.cw + 2);
      if (G.rows > 1) el('line', { class: 'repl' + (info && info.lag > 50 ? ' lag' : ''), x1: x + G.cw / 2, y1: G.y0 + G.ch + 1, x2: x + G.cw / 2, y2: G.y0 + (G.rows - 1) * (G.ch + 3) + 1 }, grp);
      for (let k = 0; k < G.rows; k++) {
        const y = G.y0 + k * (G.ch + 3);
        const u = info ? (k === 0 ? info.uW : info.uR) : 0;
        const dead = r && r.alive < r.count && c === 0 && k === 0;
        const pop = k >= ch.repFrom || c >= ch.colFrom;
        const outer = el('g', { transform: `translate(${x},${y})` }, grp);
        const cg = el('g', { class: `cyl${k === 0 ? ' prim' : ''}${dead ? ' dead' : ''}${pop ? ' pop sync' : ''}`, 'data-cell': `${n.id}:${c}:${k}` }, outer);
        if (pop) cg.style.animationDelay = Math.min(500, (c + k) * 60) + 'ms';
        el('path', { class: 'cb', d: `M0,2.5 V${G.ch - 2.5} A${G.cw / 2},2.5 0 0 0 ${G.cw},${G.ch - 2.5} V2.5`, style: `fill:${dead ? 'var(--bad-soft)' : fillFor(u)};fill-opacity:${k === 0 ? 0.95 : 0.6}` }, cg);
        el('ellipse', { class: 'ct', cx: G.cw / 2, cy: 2.5, rx: G.cw / 2, ry: 2.5 }, cg);
        const tt = el('title', null, cg);
        tt.textContent = `${k === 0 ? 'Primary — сюда идут записи' : 'Реплика ' + k + ' — отсюда читают'}${G.S > 1 ? ' · шард ' + (c + 1) : ''}: загрузка ${Math.round(u * 100)} %`;
      }
    }
    if (G.S > G.cols) { const t = el('text', { class: 'sub', x: s.w - 6, y: G.y0 + 9, 'text-anchor': 'end' }, grp); t.textContent = `+${G.S - G.cols}`; }
    if (1 + G.R > G.rows) { const t = el('text', { class: 'sub', x: s.w - 6, y: G.y0 + (G.rows - 1) * (G.ch + 3) + 9, 'text-anchor': 'end' }, grp); t.textContent = `+${1 + G.R - G.rows}`; }
    const lx = G.x0 + G.cols * (G.cw + 2) + 6;
    if (G.cols <= 4) {
      const t1 = el('text', { class: 'sql-hint', x: lx, y: G.y0 + 9 }, grp); t1.textContent = '← записи';
      if (G.rows > 1) { const t2 = el('text', { class: 'sql-hint' + (info && info.lag > 50 ? ' lagt' : ''), x: lx, y: G.y0 + (G.ch + 3) + 9 }, grp); t2.textContent = '← чтения' + (info && info.R > 0 && info.lag > 1 ? ' · лаг ' + SD.fmt.ms(info.lag) : ''); }
    }
  }
  function queueExtras(n, grp, s, r) {
    const y0 = 62, e = SD.ENGINES[n.props.engine];
    const parts = n.props.engine === 'kafka' ? n.props.partitions : 1;
    const shown = Math.min(parts, 16);
    const u = r ? Math.min(1, r.util) : 0;
    const q = E.res && E.res.queues[n.id];
    const w = Math.min(14, (s.w - 70 - (shown - 1) * 2) / shown);
    for (let i = 0; i < shown; i++) {
      const pg = el('g', { class: 'part-g', 'data-part': n.id + ':' + i }, grp);
      el('rect', { class: 'pb', x: 10 + i * (w + 2), y: y0, width: w, height: 8, rx: 1.5 }, pg);
      el('rect', { x: 10 + i * (w + 2), y: y0 + 8 - 8 * Math.max(0.1, u), width: w, height: 8 * Math.max(0.1, u), rx: 1.5, style: `fill:${q && q.growth > 0.5 ? 'var(--bad)' : 'var(--k-job)'}` }, pg);
    }
    const t = el('text', { class: 'sub', x: s.w - 10, y: y0 + 8, 'text-anchor': 'end' }, grp);
    t.textContent = q ? (q.growth > 0.5 ? 'лаг растёт' : 'лаг 0') : (e && e.managed ? 'managed' : '');
  }
  function lbExtras(n, grp) {
    const slots = lbSlots(n);
    let x = 13, prev = null;
    slots.forEach(sl => {
      if (prev && sl.kid !== prev) x += 7;
      const c = el('circle', { class: 'slot', cx: x, cy: 62, r: 3.3, 'data-slot': `${n.id}|${sl.kid}|${sl.i}` }, grp);
      const tt = el('title', null, c); tt.textContent = `Экземпляр ${sl.i + 1} сервиса «${(node(sl.kid) || {}).label || 'Сервис'}»`;
      x += 9.5; prev = sl.kid;
    });
  }

  function edgeChips(e) {
    const p = Object.assign(SD.edgeDefaults(), e.props), out = [];
    const from = node(e.from), to = node(e.to);
    const k = SD.edgeKind(from, to);
    if (k.proto && p.proto !== 'rest') out.push({ grpc: 'gRPC', graphql: 'GraphQL', soap: 'SOAP' }[p.proto]);
    return out;
  }

  function renderEdges() {
    const g = E.gEdges; g.textContent = '';
    E.paths.clear();
    E.graph.edges.forEach(e => {
      const a = node(e.from), b = node(e.to);
      if (!a || !b) return;
      const er = E.res && E.res.edges[e.id];
      const flow = er ? er.flow : 0;
      const info = er && er.info;
      const sel = E.sel && E.sel.type === 'edge' && E.sel.id === e.id;
      const fail = info && info.s < 0.98 && flow > 0.001;
      const ev = edgeVis(a, b), ops = isOps(a) || isOps(b);
      const cls = ['edge', ev === 'hide' ? 'l-hide' : ev === 'dim' ? 'l-dim' : '', ops ? 'ops ops-' + opsKind(a, b) : '', flow > 0.001 ? 'active' : (E.res ? 'idle' : ''), er && er.async ? 'async' : '', sel ? 'sel' : '', info && info.amp > 1.3 ? 'storm' : '', info && info.open ? 'cbopen' : '', fail ? 'fail' : ''].join(' ');
      const grp = el('g', { class: cls, 'data-edge': e.id }, g);
      if (flow > 0.001) grp.style.setProperty('--w', (1.4 + Math.min(3.4, Math.log10(flow + 1) * 0.85)).toFixed(2));
      const d = edgePath(a, b);
      const p = el('path', { class: 'wire', d, 'marker-end': sel ? 'url(#arrowS)' : flow > 0 ? 'url(#arrowA)' : 'url(#arrow)' }, grp);
      el('path', { class: 'hit', d }, grp);
      E.paths.set(e.id, p);
      const len = p.getTotalLength ? p.getTotalLength() : 0;
      if (!len) return;
      const mid = p.getPointAtLength(len / 2);
      const chips = edgeChips(e);
      let lbl = '';
      if (flow > 0.001) lbl = SD.fmt.num(flow) + '/с';
      if (chips.length) lbl += (lbl ? '  ' : '') + chips.join(' · ');
      if (lbl) { const t = el('text', { class: 'flow-lbl', x: mid.x, y: mid.y - 7, 'text-anchor': 'middle' }, grp); t.textContent = lbl; }
      const ep = Object.assign(SD.edgeDefaults(), e.props), kk = SD.edgeKind(a, b);
      if (kk.resil) {
        const g2 = [];
        if (ep.timeout) g2.push(['⏱ ' + (ep.timeout >= 1000 ? ep.timeout / 1000 + ' с' : ep.timeout + ' мс'), 'gto', 'Таймаут: столько ждём ответа, потом сдаёмся', '⏱' + (ep.timeout >= 1000 ? ep.timeout / 1000 + 'с' : ep.timeout)]);
        if (ep.retries) g2.push(['↻ ' + ep.retries + (ep.backoff === 'exp' ? ' · пауза' : ' · сразу'), info && info.amp > 1.3 ? 'grt storm' : 'grt', `Повторы: до ${ep.retries}${info && info.amp > 1.01 ? `, нагрузка на соседа ×${info.amp.toFixed(2).replace('.', ',')}` : ''}`, '↻' + ep.retries]);
        if (ep.cb) g2.push([info && info.open ? '⚡ разомкнут' : '⚡ CB', info && info.open ? 'gcb open' : 'gcb', info && info.open ? 'Предохранитель разомкнут: вызовы отбиваются сразу' : 'Предохранитель замкнут: вызовы идут', info && info.open ? '⚡ откл' : '⚡']);
        if (ep.fallback) g2.push(['⤺ fallback', 'gfb', 'Fallback: при сбое — упрощённый ответ', '⤺']);
        if (g2.length) {
          const wOf = t => t.length * 6.1 + 12 + (/[⏱↻⚡⤺]/.test(t) ? 3 : 0);
          const fw = g2.map(x => wOf(x[0])).reduce((s2, w) => s2 + w + 3, -3), compact = fw > len * 0.8;
          if (compact) g2.forEach(x => { x[0] = x[3]; });
          const p0 = p.getPointAtLength(compact ? len / 2 : Math.min(len * 0.3, 90));
          const ws = g2.map(x => wOf(x[0])), tw = ws.reduce((s2, w) => s2 + w + 3, -3), stack = compact && tw > len - 16;
          let x0 = p0.x - tw / 2;
          const gg = el('g', { class: 'eglyphs' }, grp);
          g2.forEach(([txt, cls, tip], i) => {
            const bx = el('g', { class: 'eglyph ' + cls, transform: stack ? `translate(${(p0.x - ws[i] / 2).toFixed(1)},${(p0.y + 8 + i * 17).toFixed(1)})` : `translate(${x0.toFixed(1)},${(p0.y + 8).toFixed(1)})` }, gg);
            el('rect', { width: ws[i], height: 15, rx: 7.5 }, bx);
            const t2 = el('text', { x: ws[i] / 2, y: 11, 'text-anchor': 'middle' }, bx); t2.textContent = txt;
            const tt = el('title', null, bx); tt.textContent = tip;
            x0 += ws[i] + 3;
          });
        }
      }
    });
  }

  /* ---------- частицы трафика ---------- */
  let lastT = 0, spawnAcc = new Map();
  /* выбор экземпляра так, как это делает алгоритм балансировщика */
  function pick(from, to, used) {
    let D = E.disp.get(to.id);
    if (!D) { D = { rr: 0, load: [] }; E.disp.set(to.id, D); }
    while (D.load.length < used) D.load.push(0);
    const algo = from && from.type === 'lb' ? (from.props.sticky ? 'hash' : from.props.algo) : from && from.type === 'gateway' ? 'lc' : 'random';
    const rnd = () => Math.floor(Math.random() * used);
    let i;
    if (algo === 'rr' || algo === 'wrr') i = D.rr++ % used;
    else if (algo === 'lc' || algo === 'lrt') {
      i = D.rr % used;
      for (let k = 0; k < used; k++) if (D.load[k] < D.load[i] - 0.05) i = k;
      D.rr++;
    } else if (algo === 'p2c') { const a = rnd(), b = rnd(); i = D.load[a] <= D.load[b] ? a : b; }
    else if (algo === 'hash') { const client = Math.floor(Math.random() * 10); i = ((client * 2654435761) >>> 0) % used; }
    else i = rnd();
    D.load[i] += 1;
    return i;
  }
  function usedOf(n) {
    const r = E.res && E.res.nodes[n.id], total = fleetCount(n);
    const v = r ? Math.min(r.used || total, r.alive || total) : total;
    return Math.max(1, Math.min(MAXV, v));
  }
  /* куда внутри узла попадает запрос: экземпляр, ячейка базы или партиция */
  function landing(pt, to) {
    if (to.type === 'sql') {
      const G = sqlGeo(to), write = /write|apply|append|metrics|events/.test(pt.kind);
      const c = Math.floor(Math.random() * G.cols), k = write || G.rows === 1 ? 0 : 1 + Math.floor(Math.random() * (G.rows - 1));
      return { x: to.x + G.x0 + c * (G.cw + 2) + G.cw / 2, y: to.y + G.y0 + k * (G.ch + 3) + G.ch / 2, flash: `[data-cell="${to.id}:${c}:${k}"]` };
    }
    if (to.type === 'queue') {
      const parts = Math.min(to.props.engine === 'kafka' ? to.props.partitions : 1, 16);
      const w = Math.min(14, (W - 70 - (parts - 1) * 2) / parts), i = Math.floor(Math.random() * parts);
      return { x: to.x + 10 + i * (w + 2) + w / 2, y: to.y + 66, flash: `[data-part="${to.id}:${i}"]` };
    }
    if (isFleet(to)) {
      const i = pt.inst != null ? pt.inst : Math.floor(Math.random() * usedOf(to));
      const p = instPos(i);
      return { x: to.x + p.x + IW / 2, y: to.y + p.y + IH / 2, flash: `[data-inst="${to.id}:${i}"]` };
    }
    return null;
  }
  function tick(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
    if (E.running && E.res && !document.hidden) {
      E.graph.edges.forEach(e => {
        const er = E.res.edges[e.id], p = E.paths.get(e.id);
        const a0 = node(e.from), b0 = node(e.to);
        if (!p || !a0 || !b0 || edgeVis(a0, b0) === 'hide') return;
        if (isOps(a0) || isOps(b0)) {
          const ok = opsKind(a0, b0), acc0 = (spawnAcc.get(e.id) || 0) + (ok === 'k8s' ? 0.35 : 0.9) * dt;
          let k = Math.floor(acc0); spawnAcc.set(e.id, acc0 - k);
          while (k-- > 0 && E.particles.length < 420) E.particles.push({ e: e.id, p, len: p.getTotalLength(), s: 0, kind: 'read', ops: ok, el: null, to: e.to });
          return;
        }
        if (!er || er.flow < 0.001) return;
        const rate = 1.2 + Math.log10(er.flow + 1) * 1.6;
        const acc = (spawnAcc.get(e.id) || 0) + rate * dt;
        let n = Math.floor(acc);
        spawnAcc.set(e.id, acc - n);
        const from = node(e.from), to = node(e.to);
        while (n-- > 0 && E.particles.length < 420) {
          const kinds = Object.entries(er.byKind);
          let x = Math.random() * er.flow, kind = kinds[0][0];
          for (const [k, v] of kinds) { x -= v; if (x <= 0) { kind = k; break; } }
          const pt = { e: e.id, p, len: p.getTotalLength(), s: 0, kind, async: er.async, el: null, to: e.to };
          const inf = er.info;
          if (inf && inf.open && Math.random() < 0.8) { pt.bounce = true; pt.turn = Math.min(pt.len * 0.3, 90); }
          else if (inf && inf.amp > 1.03 && Math.random() < (inf.amp - 1) / inf.amp) pt.retry = true;
          if (to && isFleet(to)) {
            pt.inst = pick(from, to, usedOf(to));
            if (from && from.type === 'lb') flashEl(`[data-slot="${from.id}|${to.id}|${pt.inst}"]`);
          }
          E.particles.push(pt);
        }
      });
      E.disp.forEach(D => { for (let k = 0; k < D.load.length; k++) D.load[k] *= Math.exp(-dt * 2.2); });
      E.graph.nodes.forEach(n => {
        const r = E.res.nodes[n.id];
        if (!r || !(r.status === 'hot' || r.dead) || r.rps < 0.01) return;
        if (Math.random() < dt * (r.dead ? 4 : 3 * Math.min(2, r.util - 1 + 0.3))) {
          const s = size(n);
          E.particles.push({ drop: true, x: n.x + s.w / 2 + (Math.random() - 0.5) * 60, y: n.y + s.h, vy: 20, life: 1, el: null });
        }
      });
    }
    const speed = 180, born = [];
    E.particles = E.particles.filter(pt => {
      if (pt.drop) {
        pt.life -= dt * 1.2; pt.vy += 160 * dt; pt.y += pt.vy * dt;
        if (!pt.el) pt.el = el('circle', { r: 3, class: 'drop' }, E.gParts);
        pt.el.setAttribute('cx', pt.x); pt.el.setAttribute('cy', pt.y); pt.el.setAttribute('opacity', Math.max(0, pt.life));
        if (pt.life <= 0) { pt.el.remove(); return false; }
        return true;
      }
      if (pt.hop) {
        pt.t += dt / 0.17;
        const k = Math.min(1, pt.t), e2 = 1 - Math.pow(1 - k, 2);
        const x = pt.x0 + (pt.x1 - pt.x0) * e2, y = pt.y0 + (pt.y1 - pt.y0) * e2;
        if (!pt.el) pt.el = el('circle', { r: 3, class: 'hop', style: `fill:${SD.kindColor(pt.kind)}` }, E.gParts);
        pt.el.setAttribute('cx', x); pt.el.setAttribute('cy', y);
        if (k >= 1) { pt.el.remove(); if (pt.flash) flashEl(pt.flash); return false; }
        return true;
      }
      if (!E.paths.has(pt.e) || E.paths.get(pt.e) !== pt.p) { if (pt.el) pt.el.remove(); return false; }
      if (pt.bounce) {
        pt.s += (pt.back ? -1 : 1) * speed * dt;
        if (!pt.back && pt.s >= pt.turn) pt.back = true;
        if (pt.back && pt.s <= 0) { if (pt.el) pt.el.remove(); return false; }
        const qb = pt.p.getPointAtLength(Math.max(0, pt.s));
        if (!pt.el) pt.el = el('circle', { r: 3.4, class: 'bounce' }, E.gParts);
        pt.el.setAttribute('cx', qb.x); pt.el.setAttribute('cy', qb.y);
        return true;
      }
      pt.s += speed * dt * (pt.async ? 0.6 : 1);
      if (pt.s >= pt.len) {
        if (pt.el) pt.el.remove();
        const to = node(pt.to);
        const land = to && landing(pt, to);
        if (land && !pt.ops) { const end = pt.p.getPointAtLength(pt.len); born.push({ hop: true, x0: end.x, y0: end.y, x1: land.x, y1: land.y, t: 0, kind: pt.kind, flash: land.flash, el: null }); }
        return false;
      }
      const q = pt.p.getPointAtLength(pt.s);
      if (!pt.el) {
        pt.el = pt.ops ? el('rect', { width: 5, height: 5, rx: 1, class: 'ops-p ' + pt.ops }, E.gParts) : pt.async ? el('rect', { width: 6, height: 6, rx: 1, style: `fill:${SD.kindColor(pt.kind)}` }, E.gParts)
          : el('circle', pt.retry ? { r: 3.6, class: 'retry-p', style: `stroke:${SD.kindColor(pt.kind)}` } : { r: 3.4, style: `fill:${SD.kindColor(pt.kind)}` }, E.gParts);
      }
      if (pt.ops) { pt.el.setAttribute('x', q.x - 2.5); pt.el.setAttribute('y', q.y - 2.5); }
      else if (pt.async) { pt.el.setAttribute('x', q.x - 3); pt.el.setAttribute('y', q.y - 3); }
      else { pt.el.setAttribute('cx', q.x); pt.el.setAttribute('cy', q.y); }
      return true;
    });
    if (born.length) E.particles.push(...born);
    requestAnimationFrame(tick);
  }
  function clearParticles() { E.particles.forEach(p => p.el && p.el.remove()); E.particles = []; }

  /* ---------- модель ---------- */
  const node = id => E.graph.nodes.find(n => n.id === id);
  function newId(type) { let id; do { id = type + (E.seq++); } while (node(id)); return id; }
  function addNode(type, x, y, props, label) {
    const n = { id: newId(type), type, x: Math.round(x), y: Math.round(y), props: Object.assign(SD.defaultsFor(type), props || {}), label };
    E.graph.nodes.push(n);
    select({ type: 'node', id: n.id });
    changed('add', { node: n });
    return n;
  }
  function addEdge(from, to) {
    if (from === to) return false;
    if (E.graph.edges.some(e => e.from === from && e.to === to)) return false;
    const a = node(from), b = node(to);
    if (!a || !b || b.type === 'client') return false;
    const e = { id: 'e' + (E.seq++) + '_' + Date.now().toString(36).slice(-3), from, to, props: SD.edgeDefaults() };
    E.graph.edges.push(e);
    changed('edge', { edge: e });
    return true;
  }
  function removeSel() {
    if (!E.sel) return;
    let detail = {};
    if (E.sel.type === 'node') {
      const n = node(E.sel.id);
      if (!n || SD.TYPES[n.type].fixed) return;
      detail = { node: n };
      E.graph.nodes = E.graph.nodes.filter(x => x.id !== n.id);
      E.graph.edges = E.graph.edges.filter(e => e.from !== n.id && e.to !== n.id);
    } else {
      detail = { edge: E.graph.edges.find(e => e.id === E.sel.id) };
      E.graph.edges = E.graph.edges.filter(e => e.id !== E.sel.id);
    }
    select(null);
    changed('remove', detail);
  }
  function select(sel) { E.sel = sel; renderEdges(); renderNodes(); if (E.cb.onSelect) E.cb.onSelect(sel); }
  function changed(why, detail) { if (E.cb.onChange) E.cb.onChange(why, detail || {}); }

  /* ---------- ввод ---------- */
  function bindCanvas() {
    const svg = E.svg;
    let drag = null;
    svg.addEventListener('pointerdown', ev => {
      const port = ev.target.closest('[data-port]');
      const nodeEl = ev.target.closest('.node');
      const edgeEl = ev.target.closest('.edge');
      const w = toWorld(ev.clientX, ev.clientY);
      svg.setPointerCapture(ev.pointerId);
      if (port) {
        const from = port.getAttribute('data-port');
        const n = node(from), p = portOut(n);
        const line = el('path', { class: 'rubber', d: `M${p.x},${p.y} L${w.x},${w.y}` }, E.gFx);
        drag = { kind: 'connect', from, line, p };
        svg.classList.add('connecting');
      } else if (nodeEl) {
        const n = node(nodeEl.getAttribute('data-id'));
        drag = { kind: 'node', n, dx: w.x - n.x, dy: w.y - n.y, moved: false, sx: ev.clientX, sy: ev.clientY };
      } else if (edgeEl) {
        select({ type: 'edge', id: edgeEl.getAttribute('data-edge') });
        drag = null;
      } else {
        drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: E.view.x, vy: E.view.y, moved: false };
      }
    });
    svg.addEventListener('pointermove', ev => {
      if (!drag) return;
      const w = toWorld(ev.clientX, ev.clientY);
      if (drag.kind === 'connect') drag.line.setAttribute('d', `M${drag.p.x},${drag.p.y} L${w.x},${w.y}`);
      else if (drag.kind === 'node') {
        if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
        drag.moved = true;
        drag.n.x = Math.round((w.x - drag.dx) / 4) * 4; drag.n.y = Math.round((w.y - drag.dy) / 4) * 4;
        renderEdges(); renderNodes();
      } else if (drag.kind === 'pan') {
        const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        E.view.x = drag.vx + dx; E.view.y = drag.vy + dy; applyView();
      }
    });
    const end = ev => {
      if (!drag) return;
      if (drag.kind === 'connect') {
        drag.line.remove(); svg.classList.remove('connecting');
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const tEl = target && target.closest && target.closest('.node');
        if (tEl) {
          const to = tEl.getAttribute('data-id');
          if (!addEdge(drag.from, to) && to !== drag.from && E.cb.onToast) E.cb.onToast('Такая связь уже есть или к пользователям вести стрелку нельзя.');
        } else select({ type: 'node', id: drag.from });
      } else if (drag.kind === 'node') {
        if (drag.moved) changed('move'); else select({ type: 'node', id: drag.n.id });
      } else if (drag.kind === 'pan' && !drag.moved) select(null);
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', ev => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY); }, { passive: false });
    svg.addEventListener('dblclick', ev => {
      const n = ev.target.closest('.node'); if (n && E.cb.onOpen) { E.cb.onOpen(n.getAttribute('data-id')); return; }
      const ed = ev.target.closest('[data-edge]'); if (ed && E.cb.onOpenEdge) E.cb.onOpenEdge(ed.getAttribute('data-edge'));
    });
    svg.addEventListener('keydown', ev => {
      const n = ev.target.closest && ev.target.closest('.node');
      if (n && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select({ type: 'node', id: n.getAttribute('data-id') }); }
    });
    document.addEventListener('keydown', ev => {
      if (ev.target.matches && ev.target.matches('input, select, textarea')) return;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && E.sel) { ev.preventDefault(); removeSel(); }
      if (ev.key === 'Escape') select(null);
    });
  }

  /* перетаскивание из палитры */
  function bindPalette(container) {
    container.addEventListener('pointerdown', ev => {
      const part = ev.target.closest('.part');
      if (!part || part.classList.contains('locked')) return;
      const type = part.getAttribute('data-type');
      const preset = part.dataset.preset && SD.SERVICE_PRESETS ? SD.SERVICE_PRESETS.find(p => p.id === part.dataset.preset) : null;
      const pprops = preset ? JSON.parse(JSON.stringify(preset.props)) : undefined, plabel = preset ? preset.label : undefined;
      let ghost = null, moved = false;
      const sx = ev.clientX, sy = ev.clientY;
      const move = e2 => {
        if (!moved && Math.hypot(e2.clientX - sx, e2.clientY - sy) < 6) return;
        moved = true;
        if (!ghost) {
          ghost = document.createElement('div');
          ghost.className = 'ghost-part';
          ghost.innerHTML = SD.icon(type) + `<span>${esc(plabel || SD.TYPES[type].name)}</span>`;
          document.body.appendChild(ghost);
        }
        ghost.style.left = e2.clientX + 'px'; ghost.style.top = e2.clientY + 'px';
      };
      const up = e2 => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        if (ghost) ghost.remove();
        const r = E.svg.getBoundingClientRect();
        if (moved && e2.clientX > r.left && e2.clientX < r.right && e2.clientY > r.top && e2.clientY < r.bottom) {
          const w = toWorld(e2.clientX, e2.clientY);
          addNode(type, w.x - W / 2, w.y - H0 / 2, pprops, plabel);
        } else if (!moved) {
          const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
          const off = (E.graph.nodes.length % 5) * 22;
          addNode(type, c.x - W / 2 + off, c.y - H0 / 2 + off, pprops, plabel);
        }
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }

  function setGraph(g) {
    clearParticles();
    E.prev.clear(); E.disp.clear();
    E.graph = g; E.sel = null; E.res = null;
    E.seq = g.nodes.length + g.edges.length + 1;
    renderEdges(); renderNodes();
  }

  SD.editor = {
    init, bindPalette, setGraph, render, fit, select, removeSel, addNode, addEdge, node, subtitle,
    getGraph: () => E.graph, getSel: () => E.sel, markDeltas,
    getLayer: () => layer, setLayer: l => { layer = l || 'all'; try { localStorage.setItem('amp-stroyka-layer', layer); } catch (e) { /* без хранилища */ } clearParticles(); render(); },
    zoomIn: () => zoomAt(1.2), zoomOut: () => zoomAt(1 / 1.2),
    setRunning: v => { E.running = v; if (!v) clearParticles(); },
    changed
  };
})();
