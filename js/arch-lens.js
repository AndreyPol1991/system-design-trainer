/* Архитектура и паттерны прямо на схеме: какой стиль сейчас и в эталоне, какие паттерны применены,
   где нужен паттерн (с правкой в один клик) и линзы на холсте: паттерны, границы сервисов, ярусы, синхронные связи. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const A = () => SD.app.A;
  const NS = 'http://www.w3.org/2000/svg';
  const CAT = {
    resilience: ['Устойчивость', '--info'], scale: ['Масштаб', '--ok'], data: ['Данные', '--k-write'],
    integration: ['Интеграция', '--k-job'], architecture: ['Архитектура', '--accent'], anti: ['Проблема', '--bad']
  };
  const STYLE_PAT = { micro: 'microservices', eda: 'eda', cqrs: 'cqrs', es: 'eventsourcing', monolith: null, serverless: null, soa: null, polyglot: null, dwh: null, split: 'microservices' };
  const ANTI_FIX = { shareddb: 'dbpersvc', distmono: 'eda', oltpreports: 'cqrs', esbhub: 'eda', replay: 'cqrs' };
  const ANTI_PAT = { shareddb: 'shareddb', distmono: 'distmono', oltpreports: 'oltpreports' };
  const NET = new Set(['external', 'app', 'llm', 'faas', 'agent', 'router', 'esb', 'ws']);
  const STORE = new Set(['sql', 'nosql', 'olap', 'tsdb', 'graphdb', 'search', 'vectordb']);
  const pat = id => (SD.PATTERNS || []).find(p => p.id === id);
  const pname = id => (pat(id) || {}).name || id;
  const lbl = n => n ? (n.label || SD.TYPES[n.type].name) : '';

  /* ---------- распознать стиль и паттерны на схеме ---------- */
  function detect(g, res) {
    const by = id => g.nodes.find(n => n.id === id);
    const kids = id => g.edges.filter(e => e.from === id).map(e => by(e.to)).filter(Boolean);
    const parents = id => g.edges.filter(e => e.to === id).map(e => by(e.from)).filter(Boolean);
    const an = SD.arch.analyze(g, res);
    const out = { styles: an.styles, anti: [], applied: [], needed: [] };
    const ap = (id, cat, at) => { if (!out.applied.some(x => x.id === id && JSON.stringify(x.at) === JSON.stringify(at))) out.applied.push({ id, cat, at }); };
    const nd = (id, cat, at, why, fix) => out.needed.push({ id, cat, at, why, fix });
    g.nodes.forEach(n => {
      const p = n.props || {}, r = (res && res.nodes[n.id]) || {}, at = { node: n.id };
      if (n.type === 'lb') {
        ap('loadbalancing', 'scale', at);
        if (p.health) ap('healthcheck', 'resilience', at);
        else nd('healthcheck', 'resilience', at, 'Без проверок здоровья упавший экземпляр продолжит получать запросы, и часть пользователей увидит ошибки.', { node: n.id, key: 'health', value: true });
      }
      if (n.type === 'gateway') { ap('apigw', 'integration', at); if (p.rateLimit) ap('ratelimit', 'resilience', at); }
      if (n.type === 'cdn') ap('cdn-p', 'scale', at);
      if (n.type === 'cache') ap(!p.policy || p.policy === 'aside' ? 'cacheaside' : 'writethrough', 'data', at);
      if ((n.type === 'app' || n.type === 'worker') && p.autoscale) ap('autoscaling', 'scale', at);
      if (n.type === 'app') {
        if (p.idempotency) ap('idempotency', 'resilience', at);
        if (p.outbox) ap('outbox', 'data', at);
        if (p.txMode === 'saga') ap('saga-p', 'data', at);
        if (p.inner && p.inner.nodes && p.inner.nodes.some(c => c.type === 'port')) ap('hexagonal', 'architecture', at);
        else if (p.inner && p.inner.nodes && p.inner.nodes.length) ap('layered', 'architecture', at);
        const cnt = r.count || p.count || 1;
        if (cnt > 1 && parents(n.id).some(q => q.type === 'lb' || q.type === 'gateway')) ap('loadbalancing', 'scale', at);
        if (cnt < 2 && !p.autoscale && parents(n.id).some(q => ['lb', 'gateway', 'client'].includes(q.type))) nd('spof', 'anti', at, `«${lbl(n)}» работает в одном экземпляре: упадёт он — упадёт сервис. Нужно минимум два за балансировщиком.`, { node: n.id, key: 'count', value: 2 });
      }
      if (n.type === 'worker') {
        if (p.dedup) ap('inbox', 'data', at);
        if ((r.count || p.count || 1) > 1) ap('queue-cc', 'integration', at);
        if (!p.dedup && res && res.jobs && res.jobs.dupRate > 0.01) nd('inbox', 'data', at, 'Брокер доставляет «хотя бы раз», и часть сообщений обрабатывается дважды. Таблица «уже обработано» отсечёт дубли.', { node: n.id, key: 'dedup', value: true });
      }
      if (n.type === 'cdc') ap('cdc-p', 'data', at);
      if (n.type === 'queue') {
        ap('queue-cc', 'integration', at);
        if (p.retries) ap('dlq', 'resilience', at);
        else if (res && res.jobs && res.jobs.lostRate > 0.01) nd('dlq', 'resilience', at, 'Сообщения, которые не удалось обработать, теряются. Повторы и очередь «мёртвых» сообщений их сохранят.', { node: n.id, key: 'retries', value: true });
        if (kids(n.id).filter(k => ['app', 'worker', 'faas'].includes(k.type)).length >= 2) ap('pubsub', 'integration', at);
      }
      if (n.type === 'sql') {
        const i = r.info || {};
        if (p.replicas > 0) ap('readreplica', 'scale', at);
        if (p.shards > 1) ap('sharding', 'scale', at);
        if (p.partition && p.partition !== 'none') ap('partitioning', 'data', at);
        if ((p.idx || []).length) ap('indexing', 'data', at);
        if (p.pooler) ap('connpool', 'scale', at);
        if (p.locking === 'optimistic') ap('optlock', 'data', at);
        if (i.noKey && !(p.idx || []).length) nd('indexing', 'data', at, 'Индексов нет: каждое чтение перебирает всю таблицу.', { node: n.id, key: 'idx', value: ['btree'] });
        else if (i.uR > 0.85 && !(p.replicas > 0) && !parents(n.id).some(q => q.type === 'cache')) nd('readreplica', 'scale', at, `Чтения грузят базу на ${Math.round(i.uR * 100)} %. Реплика заберёт чтения на себя (а кэш — самые частые).`, { node: n.id, key: 'replicas', value: 1 });
        if (i.connOk < 1 && !p.pooler) nd('connpool', 'scale', at, `Соединений ${i.conns} при лимите ${i.connLimit}: база отказывает новым. PgBouncer сожмёт их в несколько настоящих.`, { node: n.id, key: 'pooler', value: true });
      }
    });
    g.edges.forEach(e => {
      const a = by(e.from), b = by(e.to); if (!a || !b) return;
      if (!SD.edgeKind(a, b).resil) return;
      const p = Object.assign(SD.edgeDefaults(), e.props), at = { edge: e.id };
      if (p.timeout) ap('timeout', 'resilience', at);
      if (p.retries) ap('retry', 'resilience', at);
      if (p.cb) ap('circuitbreaker', 'resilience', at);
      if (p.fallback) ap('fallback', 'resilience', at);
      if (NET.has(b.type)) {
        if (!p.timeout) nd('timeout', 'resilience', at, `Вызов «${lbl(a)} → ${lbl(b)}» идёт по сети без таймаута: зависнет сосед — зависнут и потоки «${lbl(a)}».`, { edge: e.id, key: 'timeout', value: 1000 });
        else if (b.type === 'external' && !p.cb) nd('circuitbreaker', 'resilience', at, `Внешний «${lbl(b)}» может лечь. Предохранитель перестанет его дёргать и сразу вернёт ошибку или fallback.`, { edge: e.id, key: 'cb', value: true });
      }
      if (p.retries >= 2 && p.backoff !== 'exp') nd('retrystorm', 'anti', at, 'Повторы без паузы при сбое бьют залпом и добивают больного соседа.', { edge: e.id, key: 'backoff', value: 'exp' });
    });
    an.anti.forEach(x => out.anti.push(Object.assign({}, x, { pat: ANTI_PAT[x.id] || null, fixPat: ANTI_FIX[x.id] || null, at: x.node ? { node: x.node } : null })));
    an.styles.forEach(s => { const id = STYLE_PAT[s.id]; if (id) ap(id, 'architecture', null); });
    const svcs = g.nodes.filter(n => n.type === 'app');
    if (svcs.length >= 2 && !an.anti.some(a => a.id === 'shareddb') && svcs.every(s => kids(s.id).some(k => STORE.has(k.type)))) ap('dbpersvc', 'architecture', null);
    return out;
  }

  /* эталон уровня: тот же анализ на схеме-решении */
  const memo = new Map();
  function target(L) {
    if (!L || !L.solution || L.sandbox) return null;
    if (memo.has(L.id)) return memo.get(L.id);
    let t = null;
    try {
      const nodes = [], edges = [];
      const add = ([id, type, x, y, props, label]) => { if (!nodes.some(n => n.id === id)) nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props ? JSON.parse(JSON.stringify(props)) : {}), label }); };
      (L.preset || []).forEach(add); L.solution.nodes.forEach(add);
      L.solution.edges.forEach(([a, b, p], i) => edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) }));
      const g = { nodes, edges };
      if (SD.inner) g.nodes.forEach(n => SD.inner.syncFlags(n, g));
      t = detect(g, SD.sim.run(L, g, { mul: 1 }));
    } catch (err) { t = null; }
    memo.set(L.id, t);
    return t;
  }
  const uniq = list => [...new Set(list)];

  /* ---------- карточка в «Задании» ---------- */
  const chipS = (s, cls) => `<span class="ac-style ${cls || ''}">${esc(s.name)}</span>`;
  const chipP = (id, cat, extra) => `<button type="button" class="ac-pat" data-patopen="${id}" style="--c:var(${(CAT[cat] || CAT.architecture)[1]})">${esc(pname(id))}${extra || ''}</button>`;
  function card(S) {
    const L = S.level, r = S.res1 || S.res; if (!r) return '';
    const cur = detect(S.graph, r), tg = target(L);
    let h = '<div class="arch-card">';
    h += `<div class="ac-row"><small>Твоя схема</small><div>${cur.styles.length ? cur.styles.map(s => chipS(s)).join('') : '<span class="note">слишком простая, чтобы назвать стиль</span>'}</div></div>`;
    if (tg) {
      const need = tg.styles.filter(s => !cur.styles.some(c => c.id === s.id));
      h += `<div class="ac-row"><small>В эталоне</small><div>${tg.styles.map(s => chipS(s, cur.styles.some(c => c.id === s.id) ? 'ok' : 'todo')).join('')}</div></div>`;
      if (!need.length && cur.styles[0]) h += `<p class="ac-idea"><b>${esc(cur.styles[0].name)}.</b> ${esc(cur.styles[0].text)}</p>`;
      if (need.length) h += `<p class="ac-idea"><b>Куда двигаться: ${esc(need.map(s => s.name).join(', '))}.</b> ${esc(need[0].text)}${need[0].dive && SD.DIVES[need[0].dive] ? ` <button class="linkish" type="button" data-dive="${need[0].dive}">Как это работает</button>` : ''}</p>`;
    }
    const ids = uniq(cur.applied.map(x => x.id));
    h += `<div class="ac-sec"><small>Паттерны на твоей схеме · ${ids.length}</small><div class="ac-pats">${ids.length ? ids.map(id => chipP(id, cur.applied.find(x => x.id === id).cat)).join('') : '<span class="note">пока ни одного</span>'}</div></div>`;
    const needs = cur.needed.slice(0, 6);
    if (needs.length) h += `<div class="ac-sec"><small>Где не хватает паттерна · ${cur.needed.length}</small><ul class="ac-need">${needs.map((x, i) => `<li><span><b>${esc(pname(x.id))}</b> ${esc(x.why)}</span><span class="ac-btns">${x.fix ? `<button type="button" class="btn" data-patfix="${i}">Применить</button>` : ''}<button type="button" class="linkish" data-patopen="${x.id}">карточка</button></span></li>`).join('')}</ul></div>`;
    if (cur.anti.length) h += `<div class="ac-sec"><small>Антипаттерны</small><ul class="ac-need anti">${cur.anti.map(x => `<li><span><b>${esc(x.name)}</b> ${esc(x.text)}</span><span class="ac-btns">${x.fixPat ? `<button type="button" class="linkish" data-patopen="${x.fixPat}">лечение: ${esc(pname(x.fixPat))}</button>` : ''}</span></li>`).join('')}</ul></div>`;
    if (tg) {
      const tids = uniq(tg.applied.map(x => x.id)), have = new Set(ids);
      const done = tids.filter(id => have.has(id)).length;
      h += `<details class="ac-hint"><summary>Подсказка: какие паттерны использует эталон (${done} из ${tids.length} уже у тебя)</summary><div class="ac-pats">${tids.map(id => chipP(id, tg.applied.find(x => x.id === id).cat, have.has(id) ? ' ✓' : '')).join('')}</div></details>`;
    }
    h += `<div class="ac-lens"><small>Показать на схеме:</small>${LENSES.map(([k, t]) => `<button type="button" class="chip-btn ${on(k) ? 'on' : ''}" data-lens="${k}" aria-pressed="${on(k)}">${t}</button>`).join('')}<span class="note">можно несколько сразу</span></div>`;
    if (SD.landscape) h += `<button type="button" class="dive-cta" data-landopen="1">${SD.icon('app')}<span><b>Ландшафт: вся система вокруг схемы</b><small>CI/CD и GitOps, Kubernetes, логи, метрики, трейсы, алерты, данные и аналитика — и как они вместе работают в инциденте</small></span></button>`;
    h += '</div>';
    /* на уровнях, где архитектура не тема, карточка свёрнута в одну строку */
    let acOpen = false; try { acOpen = localStorage.getItem('amp-stroyka-ac-open') === '1'; } catch (e) { acOpen = false; }
    const open = L.archLvl || L.opsLvl || L.practice || L.sandbox || acOpen;
    h = `<details class="ac-det" ${open ? 'open' : ''}><summary><span class="ac-st">Архитектура и паттерны</span><span class="ac-sum">${esc(cur.styles.map(s => s.name).join(' · ') || 'стиль пока не виден')} · паттернов ${ids.length}${cur.needed.length ? ' · подсказок ' + cur.needed.length : ''}</span></summary>${h}</details>`;
    lastNeeded = cur.needed.slice(0, 6);
    return h;
  }
  let lastNeeded = [];

  /* ---------- линзы на холсте ---------- */
  const LENSES = [['pat', 'Паттерны', 'ярлыки на узлах и стрелках: что применено, чего не хватает'], ['ctx', 'Границы сервисов', 'кто какими данными владеет, где общая база'], ['tier', 'Ярусы', 'вход, логика, асинхронная часть, данные'], ['sync', 'Синхронно / асинхронно', 'где ждут ответа, а где «отправил и забыл»']];
  const CATS = ['resilience', 'scale', 'data', 'integration', 'architecture', 'anti'];
  let lenses = new Set(), cats = new Set(CATS), raf = 0, sig = '', back = null, front = null, cur = null;
  const on = k => lenses.has(k);
  const svgEl = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v)); if (parent) parent.appendChild(e); return e; };
  function nodeBox(n) {
    const g = document.querySelector(`#nodesG .node[data-id="${n.id}"]`), b = g && g.querySelector('.body');
    if (!b) return null;
    const w = +b.getAttribute('width'), h = +b.getAttribute('height');
    return { x: n.x, y: n.y, w, h, cx: n.x + w / 2, cy: n.y + h / 2 };
  }
  function edgeMid(id, f) {
    const p = document.querySelector(`#edgesG [data-edge="${id}"] path`);
    if (!p) return null;
    const len = p.getTotalLength();
    return p.getPointAtLength(len * (f == null ? 0.5 : f));
  }
  function ensureGroups() {
    const vp = $('viewport'); if (!vp) return false;
    if (!back || !back.isConnected) { back = svgEl('g', { id: 'archBack', class: 'arch-back' }); vp.insertBefore(back, vp.firstChild); }
    if (!front || !front.isConnected) { front = svgEl('g', { id: 'archFront', class: 'arch-front' }); vp.appendChild(front); }
    return true;
  }
  const pill = (parent, x, y, text, cls, color, data) => {
    const w = text.length * 6.2 + 16;
    const g = svgEl('g', Object.assign({ class: 'al-pill ' + cls, transform: `translate(${(x - w / 2).toFixed(1)},${y.toFixed(1)})` }, data || {}), parent);
    svgEl('rect', { width: w, height: 17, rx: 8.5, style: color ? `--c:var(${color})` : '' }, g);
    const t = svgEl('text', { x: w / 2, y: 12, 'text-anchor': 'middle' }, g); t.textContent = text;
    return g;
  };
  function draw() {
    if (!ensureGroups()) return;
    back.innerHTML = ''; front.innerHTML = '';
    const S = A(), g = S.graph, r = S.res1 || S.res;
    if (!lenses.size || !r) { renderChips(null); return; }
    cur = detect(g, r);
    renderChips(cur);
    const by = id => g.nodes.find(n => n.id === id);
    if (on('tier')) drawTier(g);
    if (on('ctx')) drawCtx(g, by);
    if (on('sync')) drawSync(g, by);
    if (on('pat')) {
      const at = new Map();
      const push = (key, item) => { if (!at.has(key)) at.set(key, []); at.get(key).push(item); };
      cur.applied.forEach(x => { if (x.at && cats.has(x.cat)) push(x.at.node ? 'n:' + x.at.node : 'e:' + x.at.edge, { k: 'ok', x }); });
      cur.needed.forEach((x, i) => { if (x.at && cats.has(x.cat)) push(x.at.node ? 'n:' + x.at.node : 'e:' + x.at.edge, { k: 'need', x, i }); });
      if (cats.has('anti')) cur.anti.forEach(x => { if (x.at) push('n:' + x.at.node, { k: 'anti', x }); });
      at.forEach((list, key) => {
        const isN = key.startsWith('n:'), id = key.slice(2);
        let x0, y0, dy = 19;
        if (isN) { const n = by(id), b = n && nodeBox(n); if (!b) return; x0 = b.cx; y0 = b.y + b.h + 6; }
        else { const m = edgeMid(id, 0.5); if (!m) return; x0 = m.x; y0 = m.y + 14; }
        const ok = list.filter(i => i.k === 'ok'), bad = list.filter(i => i.k !== 'ok');
        bad.concat(ok).slice(0, isN ? 4 : 3).forEach((it, k) => {
          const y = y0 + k * dy;
          if (it.k === 'ok') pill(front, x0, y, '✓ ' + pname(it.x.id), 'ok', CAT[it.x.cat] ? CAT[it.x.cat][1] : '--accent', { 'data-patopen': it.x.id });
          else if (it.k === 'need') pill(front, x0, y, (it.x.cat === 'anti' ? '⚠ ' : '+ нужен: ') + (it.x.cat === 'anti' ? pname(it.x.id) : pname(it.x.id)), 'need', '--warn', { 'data-patneed': it.i });
          else pill(front, x0, y, '⚠ ' + it.x.name, 'anti', '--bad', { 'data-patopen': it.x.pat || it.x.fixPat || '' });
        });
        if (list.length > (isN ? 4 : 3)) pill(front, x0, y0 + (isN ? 4 : 3) * dy, `ещё ${list.length - (isN ? 4 : 3)}`, 'more', null);
      });
    }
  }
  const PAL = ['--k-read', '--k-write', '--k-job', '--k-events', '--k-search', '--k-geo', '--k-chat'];
  function hull(list, pad) {
    const bs = list.filter(Boolean); if (!bs.length) return null;
    const x1 = Math.min(...bs.map(b => b.x)) - pad, y1 = Math.min(...bs.map(b => b.y)) - pad - 16, x2 = Math.max(...bs.map(b => b.x + b.w)) + pad, y2 = Math.max(...bs.map(b => b.y + b.h)) + pad;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function drawCtx(g, by) {
    const svcs = g.nodes.filter(n => n.type === 'app' || n.type === 'faas' || n.type === 'worker');
    const kids = id => g.edges.filter(e => e.from === id).map(e => by(e.to)).filter(Boolean);
    const owners = s => g.edges.filter(e => e.to === s.id).map(e => by(e.from)).filter(n => n && (n.type === 'app' || n.type === 'faas' || n.type === 'worker'));
    const apps = svcs.filter(n => n.type === 'app');
    if (apps.length === 1 && !g.nodes.some(n => n.type === 'worker' && owners(n).length === 0)) {
      const mem = [apps[0]].concat(g.nodes.filter(n => STORE.has(n.type) || n.type === 'cache')).map(nodeBox);
      const hb = hull(mem, 18); if (hb) { svgEl('rect', { class: 'al-hull', x: hb.x, y: hb.y, width: hb.w, height: hb.h, rx: 18, style: '--c:var(--accent)' }, back); const t = svgEl('text', { class: 'al-hl', x: hb.x + 12, y: hb.y + 14, style: '--c:var(--accent)' }, back); t.textContent = 'Монолит: одно приложение, общая база, один деплой'; }
      return;
    }
    svcs.forEach((s, i) => {
      const own = kids(s.id).filter(k => (STORE.has(k.type) || k.type === 'cache') && owners(k).length === 1);
      const hb = hull([s].concat(own).map(nodeBox), 14); if (!hb) return;
      const c = PAL[i % PAL.length];
      svgEl('rect', { class: 'al-hull', x: hb.x, y: hb.y, width: hb.w, height: hb.h, rx: 16, style: `--c:var(${c})` }, back);
      const t = svgEl('text', { class: 'al-hl', x: hb.x + 10, y: hb.y + 13, style: `--c:var(${c})` }, back);
      t.textContent = `контекст «${lbl(s)}»${own.length ? ': сервис + свои данные' : ': своих данных нет'}`;
    });
    g.nodes.filter(n => STORE.has(n.type) && owners(n).filter(o => o.type === 'app' || o.type === 'faas').length >= 2).forEach(n => {
      const b = nodeBox(n); if (!b) return;
      svgEl('rect', { class: 'al-shared', x: b.x - 8, y: b.y - 8, width: b.w + 16, height: b.h + 16, rx: 14 }, front);
      pill(front, b.cx, b.y - 30, `⚠ общая база: ${owners(n).filter(o => o.type === 'app').length} сервиса связаны через таблицы`, 'anti', '--bad', { 'data-patopen': 'shareddb' });
    });
  }
  const TIER = n => ['client'].includes(n.type) ? 0 : ['cdn', 'lb', 'gateway', 'dns', 'waf'].includes(n.type) ? 1 : ['queue', 'cdc', 'etl', 'esb', 'stream'].includes(n.type) ? 3 : STORE.has(n.type) || ['cache', 'lake', 'objstore', 's3'].includes(n.type) ? 4 : 2;
  const TIERS = [['Клиенты', '--text-muted'], ['Вход: CDN, балансировщик, шлюз', '--k-read'], ['Логика: сервисы и обработчики', '--accent'], ['Асинхронно: брокеры и потоки данных', '--k-job'], ['Данные: базы, кэши, хранилища', '--k-write']];
  function drawTier(g) {
    g.nodes.forEach(n => {
      const b = nodeBox(n); if (!b) return;
      const [name, c] = TIERS[TIER(n)];
      svgEl('rect', { class: 'al-tier', x: b.x - 7, y: b.y - 20, width: b.w + 14, height: b.h + 27, rx: 13, style: `--c:var(${c})` }, back);
      const t = svgEl('text', { class: 'al-hl', x: b.x - 1, y: b.y - 7, style: `--c:var(${c})` }, back); t.textContent = name.split(':')[0].toLowerCase();
    });
  }
  function drawSync(g, by) {
    const isAsync = (a, b) => a.type === 'queue' || b.type === 'queue' || a.type === 'cdc' || b.type === 'cdc' || a.type === 'etl';
    const chain = [];
    g.edges.forEach(e => {
      const a = by(e.from), b = by(e.to), p = document.querySelector(`#edgesG [data-edge="${e.id}"] path`); if (!a || !b || !p || a.type === 'client') return;
      const as = isAsync(a, b);
      svgEl('path', { class: 'al-link ' + (as ? 'async' : 'sync'), d: p.getAttribute('d') }, front);
      if (!as && a.type === 'app' && b.type === 'app') chain.push(e);
    });
    const m = (SD.arch.analyze(g, A().res1).anti || []).find(x => x.id === 'distmono');
    if (m && chain.length) { const mp = edgeMid(chain[0].id); if (mp) pill(front, mp.x, mp.y - 30, '⚠ ' + m.name + ': вызовы ждут друг друга', 'anti', '--bad', { 'data-patopen': 'distmono' }); }
  }
  function renderChips(c) {
    const box = $('archChips'); if (!box) return;
    if (!lenses.size || !c) { box.hidden = true; return; }
    box.hidden = false;
    const lg = [];
    if (on('pat')) lg.push('<span class="al-k ok">✓ применён</span><span class="al-k need">+ нужен</span><span class="al-k anti">⚠ антипаттерн</span>');
    if (on('sync')) lg.push('<span class="al-k sync">синхронно: ждёт ответа</span><span class="al-k async">асинхронно: отправил и забыл</span>');
    if (on('tier')) lg.push(TIERS.slice(1).map(([t, cc]) => `<span class="al-k" style="--c:var(${cc})">${esc(t.split(':')[0])}</span>`).join(''));
    if (on('ctx')) lg.push('<span class="note">рамка — сервис и его данные; красная — общая база</span>');
    box.innerHTML = `<b>${esc(LENSES.filter(l => on(l[0])).map(l => l[1]).join(' + '))}</b>${c.styles.map(s => `<span class="ac-style">${esc(s.name)}</span>`).join('')}${lg.join('<span class="al-sep"></span>')}<button type="button" class="btn ghost" data-lens="" title="Выключить все линзы">×</button>`;
  }
  function loop() {
    raf = 0;
    if (!lenses.size) return;
    const S = A();
    const s2 = S.graph.nodes.map(n => n.id + n.x + ',' + n.y).join('|') + '#' + S.graph.edges.length + '#' + (S.res1 ? S.res1.cost : 0) + '#' + JSON.stringify(S.graph.edges.map(e => e.props)).length;
    if (s2 !== sig) { sig = s2; draw(); }
    raf = requestAnimationFrame(loop);
  }
  /* k: '' — выключить всё; ключ — переключить; force — только включить */
  function setLens(k, force) {
    if (!k) lenses.clear(); else if (force || !lenses.has(k)) lenses.add(k); else lenses.delete(k);
    apply();
  }
  function apply() {
    sig = '';
    try { localStorage.setItem('amp-stroyka-lens2', JSON.stringify({ l: [...lenses], c: [...cats] })); } catch (e) { /* без хранилища */ }
    hidePop();
    if (raf) cancelAnimationFrame(raf), raf = 0;
    draw();
    if (lenses.size) raf = requestAnimationFrame(loop);
    document.querySelectorAll('[data-lens]').forEach(b => { if (b.dataset.lens) { b.classList.toggle('on', on(b.dataset.lens)); b.setAttribute('aria-pressed', on(b.dataset.lens)); } });
    document.querySelectorAll('[data-lensck]').forEach(c => { c.checked = on(c.dataset.lensck); });
    document.querySelectorAll('[data-catck]').forEach(c => { c.checked = cats.has(c.dataset.catck); c.disabled = !on('pat'); });
    const btn = $('lensBtn'); if (btn) btn.innerHTML = `Линзы${lenses.size ? ` <b>${lenses.size}</b>` : ''} ▾`;
  }

  /* ---------- всплывашка паттерна ---------- */
  function hidePop() { const p = $('patPop'); if (p) p.hidden = true; }
  function showPop(target, id, need) {
    const p = $('patPop'), wrap = $('canvasWrap'); if (!p || !wrap) return;
    const pt = pat(id) || {}, cat = need ? need.cat : ((cur && cur.applied.find(x => x.id === id)) || {}).cat;
    let h = `<div class="pp-head"><span class="eyebrow">${esc((CAT[cat] || CAT.architecture)[0])}</span><button type="button" class="chg-x" data-pphide="1" aria-label="Закрыть">×</button></div><b class="pp-name">${esc(pt.name || id)}${pt.en ? ` <small>${esc(pt.en)}</small>` : ''}</b>`;
    if (need) h += `<p class="pp-why">${esc(need.why)}</p>`;
    if (pt.problem) h += `<p><b>Проблема:</b> ${esc(pt.problem)}</p>`;
    if (pt.solution) h += `<p><b>Решение:</b> ${esc(pt.solution)}</p>`;
    h += `<div class="pp-btns">${need && need.fix ? `<button type="button" class="btn primary" data-ppfix="1">Применить</button>` : ''}${pt.id ? `<button type="button" class="btn" data-ppcard="${pt.id}">Карточка паттерна</button>` : ''}</div>`;
    p.innerHTML = h; p.hidden = false; p._need = need;
    const wr = wrap.getBoundingClientRect(), tr = target.getBoundingClientRect();
    const x = Math.min(wr.width - 330, Math.max(8, tr.left - wr.left + tr.width / 2 - 160)), y = Math.min(wr.height - p.offsetHeight - 8, tr.bottom - wr.top + 8);
    p.style.left = x + 'px'; p.style.top = Math.max(8, y) + 'px';
  }
  function applyFix(f) {
    if (!f) return;
    if (f.edge) SD.app.setEdgeProp(f.edge, f.key, f.value); else SD.app.setProp(f.node, f.key, f.value);
    SD.app.toast('Паттерн применён. Под настройкой в инспекторе — что изменилось и почему.');
    if (f.edge) SD.editor.select({ type: 'edge', id: f.edge }); else SD.editor.select({ type: 'node', id: f.node });
  }

  function mount() {
    document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('ac-det')) { try { localStorage.setItem('amp-stroyka-ac-open', e.target.open ? '1' : '0'); } catch (err) { /* без хранилища */ } } }, true);
    const tb = document.querySelector('.stage .toolbar'), wave = $('waveBtn');
    if (tb && wave && !$('lensBtn')) {
      const l = document.createElement('div'); l.className = 'lens-ctl';
      l.innerHTML = `<button type="button" class="btn" id="lensBtn" aria-expanded="false" aria-controls="lensPanel" title="Подсветить на схеме архитектуру и паттерны">Линзы ▾</button>
        <div class="lens-panel" id="lensPanel" hidden>
          <div class="lp-h"><b>Что подсветить на схеме</b><small>можно несколько сразу</small></div>
          ${LENSES.map(([k, t, d]) => `<label class="lp-row"><input type="checkbox" data-lensck="${k}"><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
          <div class="lp-h"><b>Какие паттерны показывать</b><small>для линзы «Паттерны»</small></div>
          <div class="lp-cats">${CATS.map(c => `<label><input type="checkbox" data-catck="${c}"><i style="background:var(${CAT[c][1]})"></i>${c === 'anti' ? 'Проблемы и антипаттерны' : CAT[c][0]}</label>`).join('')}</div>
          <div class="lp-btns"><button type="button" class="btn" data-lpall="1">Включить всё</button><button type="button" class="btn ghost" data-lpnone="1">Выключить всё</button></div>
        </div>`;
      wave.after(l);
      const pn = l.querySelector('#lensPanel'), bt = l.querySelector('#lensBtn');
      bt.addEventListener('click', () => { pn.hidden = !pn.hidden; bt.setAttribute('aria-expanded', String(!pn.hidden)); });
      pn.addEventListener('change', e => {
        const t = e.target;
        if (t.dataset.lensck) { if (t.checked) lenses.add(t.dataset.lensck); else lenses.delete(t.dataset.lensck); apply(); }
        if (t.dataset.catck) { if (t.checked) cats.add(t.dataset.catck); else cats.delete(t.dataset.catck); apply(); }
      });
      pn.addEventListener('click', e => {
        if (e.target.closest('[data-lpall]')) { LENSES.forEach(x => lenses.add(x[0])); CATS.forEach(c => cats.add(c)); apply(); }
        if (e.target.closest('[data-lpnone]')) { lenses.clear(); apply(); }
      });
      document.addEventListener('pointerdown', e => { if (!pn.hidden && !l.contains(e.target)) { pn.hidden = true; bt.setAttribute('aria-expanded', 'false'); } });
    }
    const wrap = $('canvasWrap');
    if (wrap && !$('archChips')) {
      const c = document.createElement('div'); c.className = 'arch-chips'; c.id = 'archChips'; c.hidden = true; wrap.appendChild(c);
      const p = document.createElement('div'); p.className = 'pat-pop'; p.id = 'patPop'; p.hidden = true; wrap.appendChild(p);
      p.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.pphide) hidePop();
        if (b.dataset.ppfix) { applyFix(p._need && p._need.fix); hidePop(); }
        if (b.dataset.ppcard) { hidePop(); SD.patterns.open(b.dataset.ppcard); }
      });
    }
    /* клики по ярлыкам на холсте (capture: раньше, чем редактор выделит узел) */
    const svg = $('canvas');
    if (svg) svg.addEventListener('pointerdown', e => {
      const t = e.target.closest('[data-patopen],[data-patneed]'); if (!t) { hidePop(); return; }
      e.stopPropagation(); e.preventDefault();
      if (t.dataset.patneed != null) { const nd = cur && cur.needed[+t.dataset.patneed]; if (nd) showPop(t, nd.id, nd); }
      else if (t.dataset.patopen) showPop(t, t.dataset.patopen, null);
    }, true);
    /* карточка в «Задании» и чипы над холстом */
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-lens],[data-patopen],[data-patfix],[data-patfixn],[data-archgo],[data-landopen]'); if (!b || b.closest('#canvas')) return;
      if (b.dataset.landopen) { SD.landscape.open(); return; }
      if (b.dataset.archgo) { goArch(); return; }
      if (b.dataset.patfixn != null) { applyFix((lastNode[+b.dataset.patfixn] || {}).fix); return; }
      if (b.dataset.lens != null) { if (b.closest('#xrModal')) SD.xray.close(); setLens(b.dataset.lens, !!b.dataset.lensforce); return; }
      if (b.dataset.patfix != null) { applyFix((lastNeeded[+b.dataset.patfix] || {}).fix); return; }
      if (b.dataset.patopen) SD.patterns.open(b.dataset.patopen);
    });
    let saved = null; try { saved = JSON.parse(localStorage.getItem('amp-stroyka-lens2') || 'null'); } catch (e) { saved = null; }
    if (saved) { lenses = new Set((saved.l || []).filter(k => LENSES.some(x => x[0] === k))); cats = new Set((saved.c || CATS).filter(c => CATS.includes(c))); }
    setTimeout(apply, 300);
    let seen = false; try { seen = !!localStorage.getItem('amp-stroyka-arch-intro'); } catch (e) { seen = true; }
    if (!seen && SD.mentor) setTimeout(() => {
      try { localStorage.setItem('amp-stroyka-arch-intro', '1'); } catch (e) { /* без хранилища */ }
      if (!SD.app || !SD.app.A || !Object.keys(SD.app.A.progress || {}).length) return;
      SD.mentor.say('<b>Новое: архитектура и паттерны.</b> Где искать: 1) вкладка «Задание» → блок «Архитектура и паттерны» — стиль твоей схемы против эталона уровня и чего не хватает; 2) «Линза» над холстом — паттерны, границы сервисов, ярусы, синхронные связи прямо на схеме; 3) у каждого узла и стрелки в инспекторе — «Паттерны на этом узле» с кнопкой «Применить».', { force: true, mood: 'happy', auto: 26000, acts: [['Понял', 'hide', '', true]] });
    }, 2500);
  }

  /* блок «Паттерны на этом узле»: в инспекторе и внутри узла — там, где человек их ищет */
  let detMemo = { res: null, sig: '', out: null }, lastNode = [];
  function curDetect() {
    const S = A(), r = S.res1 || S.res; if (!r) return null;
    const sig = JSON.stringify(S.graph.edges.map(e => [e.from, e.to, e.props])) + '|' + JSON.stringify(S.graph.nodes.map(n => n.props));
    if (detMemo.res === r && detMemo.sig === sig) return detMemo.out;
    detMemo = { res: r, sig, out: detect(S.graph, r) };
    return detMemo.out;
  }
  function nodeBlock(id, kind, compact) {
    const c = curDetect(); if (!c) return '';
    const hit = x => x.at && (kind === 'edge' ? x.at.edge === id : x.at.node === id);
    const ap = c.applied.filter(hit), nd = c.needed.filter(hit), an = c.anti.filter(hit), ids = uniq(ap.map(x => x.id));
    lastNode = nd;
    let h = `<h3 class="${compact ? 'xr-h' : ''}">Паттерны ${kind === 'edge' ? 'на этом вызове' : 'на этом узле'}</h3><div class="arch-card sm">`;
    h += ids.length ? `<div class="ac-pats">${ids.map(i => chipP(i, ap.find(x => x.id === i).cat)).join('')}</div>` : '<span class="note">Здесь паттернов пока нет.</span>';
    if (nd.length) h += `<ul class="ac-need">${nd.map((x, i) => `<li><span><b>${esc(pname(x.id))}</b> ${esc(x.why)}</span><span class="ac-btns">${x.fix ? `<button type="button" class="btn" data-patfixn="${i}">Применить</button>` : ''}<button type="button" class="linkish" data-patopen="${x.id}">карточка</button></span></li>`).join('')}</ul>`;
    if (an.length) h += `<ul class="ac-need anti">${an.map(x => `<li><span><b>${esc(x.name)}</b> ${esc(x.text)}</span>${x.fixPat ? `<span class="ac-btns"><button type="button" class="linkish" data-patopen="${x.fixPat}">лечение</button></span>` : ''}</li>`).join('')}</ul>`;
    const st = c.styles.map(s => s.name).join(' · ');
    h += `<p class="ac-where">Архитектура всей схемы${st ? `: <b>${esc(st)}</b>` : ''}. Целиком и в сравнении с эталоном уровня — <button type="button" class="linkish" data-archgo="1">вкладка «Задание» → «Архитектура и паттерны»</button>. На холсте — <button type="button" class="linkish" data-lens="pat" data-lensforce="1">линза «Паттерны»</button>.</p>`;
    return h + '</div>';
  }
  function goArch() {
    if (SD.xray && $('xrModal') && !$('xrModal').hidden) SD.xray.close();
    const t = $('tabTask'); if (t) t.click();
    setTimeout(() => { const c = document.querySelector('#paneTask .arch-card'); if (c) { c.scrollIntoView({ block: 'start', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); } }, 60);
  }
  /* карта уровней: какая архитектура в эталоне каждого уровня (считаем понемногу, чтобы не тормозить) */
  function decorateMap(root) {
    const btns = [...root.querySelectorAll('.lvl[data-level]')].filter(b => b.dataset.level !== 'sandbox');
    const job = ++mapJob;
    const step = () => {
      if (job !== mapJob) return;
      const t0 = performance.now();
      while (btns.length && performance.now() - t0 < 12) {
        const b = btns.shift(), L = SD.levelById(b.dataset.level), t = L ? target(L) : null;
        if (!t || !t.styles.length || b.querySelector('.lvl-arch')) continue;
        const s = document.createElement('span'); s.className = 'lvl-arch';
        s.textContent = t.styles.map(x => x.name).join(' · ');
        b.appendChild(s);
      }
      if (btns.length) setTimeout(step, 16);
    };
    setTimeout(step, 30);
  }
  let mapJob = 0;
  SD.archLens = { mount, detect, target, card, setLens, decorateMap, nodeBlock, lenses: () => [...lenses] };
})();
