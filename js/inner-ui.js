/* Внутри сервиса: редактор компонентов (C4, уровень 3), проверка, трасса запроса и код. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); if (parent) parent.appendChild(e); return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const F = () => SD.fmt;
  const CW = 200, CH = 58, GW = 160;
  const LANE = { caller: 20, in: 218, app: 446, dom: 674, infra: 902, outer: 1132 };
  const SEVL = { bad: 'Ошибка', warn: 'Риск', info: 'Заметка', good: 'Хорошо' };
  const U = { nodeId: null, sel: null, tab: 'comp', view: { x: 0, y: 0, k: 1 }, an: null, base: null, traceEntry: null, traceKind: 'read', file: null, confirm: null, synced: [] };
  const KEY = 'amp-stroyka-inner-v1';
  let seen = false;
  try { seen = !!JSON.parse(localStorage.getItem(KEY) || '{}').seen; } catch (e) { /* без хранилища */ }

  const A = () => SD.app.A;
  const svc = () => A().graph.nodes.find(n => n.id === U.nodeId);
  const I = () => svc().props.inner;
  const comp = id => I().nodes.find(c => c.id === id);
  const T = t => SD.CTYPES[t];
  const laneX = c => LANE[T(c.type).layer];
  const layerColor = l => (SD.CLAYERS.find(x => x.id === l) || {}).color || 'var(--text-muted)';
  const modColor = m => { if (!m) return null; let h = 0; for (const ch of m) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 70% 60%)`; };

  /* ---------- открыть и закрыть ---------- */
  function mount() {
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'innerModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet in-sheet" role="dialog" aria-modal="true" aria-labelledby="inTitle">
      <div class="sheet-head in-head"><nav class="in-crumbs"><button type="button" class="linkish" data-close>Площадка</button><span aria-hidden="true">›</span><h2 id="inTitle">Сервис</h2><span class="chip">C4 · компоненты</span></nav>
        <div class="in-acts"><span class="in-lbl">Собрать по схеме:</span><button type="button" class="btn" data-scaffold="layered">Слои</button><button type="button" class="btn" data-scaffold="hexagonal">Порты и адаптеры</button><button type="button" class="btn" data-scaffold="cqrs">CQRS</button><button type="button" class="btn ghost" data-in="clear">Очистить</button><button type="button" class="btn ghost x" data-close>Закрыть</button></div></div>
      <div class="in-body">
        <aside class="in-pal" id="inPal"></aside>
        <div class="in-stage" id="inStage">
          <svg id="inSvg" class="in-svg" role="application" aria-label="Компоненты сервиса"><defs>
            <marker id="inArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>
            <marker id="inArrImpl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--surface)" stroke="currentColor" stroke-width="1.4"/></marker>
          </defs><g id="inVp"><g id="inLanes"></g><g id="inBinds"></g><g id="inEdges"></g><g id="inNodes"></g><g id="inFxG"></g></g></svg>
          <div class="in-empty" id="inEmpty" hidden></div>
          <div class="in-wide" id="inWide" hidden></div>
          <div class="in-zoom"><button type="button" class="btn" data-in="zin" aria-label="Приблизить">+</button><button type="button" class="btn" data-in="zout" aria-label="Отдалить">−</button><button type="button" class="btn" data-in="fit">Вписать</button></div>
          <div class="in-fx" id="inFx"></div>
        </div>
        <section class="in-side"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="comp">Компонент</button><button type="button" role="tab" data-tab="check">Проверка</button><button type="button" role="tab" data-tab="trace">Трасса</button><button type="button" role="tab" data-tab="code">Код</button></div><div class="pane" id="inPane"></div></section>
      </div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('input', onInput);
    m.addEventListener('change', onInput);
    bindCanvas();
    bindPalette();
    window.addEventListener('keydown', onKey, true);
  }
  function open(id) {
    const n = A().graph.nodes.find(x => x.id === id);
    if (!n || !['app', 'worker'].includes(n.type)) return;
    U.nodeId = id; U.sel = null; U.tab = 'comp'; U.traceEntry = null; U.file = null; U.confirm = null; U.synced = [];
    SD.inner.ensure(n);
    const r = A().res1 || A().res;
    U.base = r ? { succ: r.total.success, lat: r.total.lat, cost: r.cost } : null;
    $('innerModal').hidden = false;
    renderPalette();
    render(true);
    requestAnimationFrame(fit);
    if (!seen && SD.mentor) {
      seen = true; try { localStorage.setItem(KEY, JSON.stringify({ seen: true })); } catch (e) { /* без хранилища */ }
      SD.mentor.say('Это <b>уровень компонентов</b> по модели C4: площадка — контейнеры, а здесь — что внутри одного сервиса. Слева тот, кто его вызывает, справа — куда он ходит. Посередине слои: вход → приложение → домен ← инфраструктура. Стрелка значит «зависит от». Главное правило: зависимости направлены к домену. Всё, что меняешь тут, симулятор учитывает на площадке.', { force: true, mood: 'happy', auto: 22000, acts: [['Понял', 'hide', '', true]] });
    }
  }
  function close() { $('innerModal').hidden = true; U.sel = null; }

  /* ---------- изменения ---------- */
  function commit() {
    const n = svc(); if (!n) return;
    const ch = SD.inner.syncFlags(n, A().graph);
    if (ch.length) U.synced = ch;
    SD.app.recompute(true);
    render(false);
  }
  function addComp(type, y) {
    const In = I(), t = T(type);
    const ys = In.nodes.filter(c => T(c.type).layer === t.layer).map(c => c.y);
    const yy = y != null ? Math.max(0, Math.round(y / 4) * 4) : (ys.length ? Math.max(...ys) + 86 : 30);
    const n = In.nodes.filter(c => c.type === type).length + 1;
    const c = { id: 'c' + In.seq++, type, y: yy, label: t.name + (n > 1 ? ' ' + n : ''), props: SD.cdefaults(type) };
    In.nodes.push(c);
    U.sel = { type: 'comp', id: c.id }; U.tab = 'comp';
    commit();
  }
  function addEdge(from, to) {
    const In = I();
    if (from === to || In.edges.some(e => e.from === from && e.to === to)) return false;
    In.edges.push({ id: 'k' + In.seq++, from, to });
    commit(); return true;
  }
  function removeSel() {
    if (!U.sel) return;
    const In = I();
    if (U.sel.type === 'comp') { In.nodes = In.nodes.filter(c => c.id !== U.sel.id); In.edges = In.edges.filter(e => e.from !== U.sel.id && e.to !== U.sel.id); }
    else In.edges = In.edges.filter(e => e.id !== U.sel.id);
    U.sel = null; commit();
  }
  function scaffold(style) {
    const n = svc();
    if (I().nodes.length && U.confirm !== style) { U.confirm = style; render(false); return; }
    U.confirm = null;
    n.props.inner = SD.inner.scaffold(n, A().graph, style, A().res1 || A().res);
    U.sel = null; U.file = null; U.traceEntry = null;
    commit();
    requestAnimationFrame(fit);
    SD.app.toast({ layered: 'Слоистая сборка: вход → сценарии → адаптеры.', hexagonal: 'Порты и адаптеры: сценарии знают только интерфейсы, адаптеры реализуют их.', cqrs: 'CQRS: команды через агрегат, чтения — плоским запросом.' }[style]);
  }

  /* ---------- холст ---------- */
  function toWorld(cx, cy) { const r = $('inSvg').getBoundingClientRect(); return { x: (cx - r.left - U.view.x) / U.view.k, y: (cy - r.top - U.view.y) / U.view.k }; }
  function applyView() { $('inVp').setAttribute('transform', `translate(${U.view.x},${U.view.y}) scale(${U.view.k})`); }
  function zoomAt(f) { const r = $('inSvg').getBoundingClientRect(); const px = r.width / 2, py = r.height / 2; const k = Math.max(0.3, Math.min(2, U.view.k * f)); U.view.x = px - (px - U.view.x) * k / U.view.k; U.view.y = py - (py - U.view.y) * k / U.view.k; U.view.k = k; applyView(); }
  function bounds() {
    const In = I(), out = ghosts();
    let y1 = 260;
    In.nodes.forEach(c => { y1 = Math.max(y1, c.y + CH); });
    out.forEach(g => { y1 = Math.max(y1, g.y + 50); });
    return { x0: LANE.caller - 10, y0: -70, x1: LANE.outer + GW + 10, y1: y1 + 30 };
  }
  function fit() {
    const r = $('inSvg').getBoundingClientRect(); if (!r.width) return;
    const b = bounds(), bw = b.x1 - b.x0 + 40, bh = b.y1 - b.y0 + 40;
    const k = Math.max(0.35, Math.min(1.1, Math.min(r.width / bw, (r.height - 50) / bh)));
    U.view.k = k; U.view.x = (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k; U.view.y = 20 - b.y0 * k; applyView();
  }
  function ghosts() {
    const n = svc(), g = A().graph;
    const o = SD.inner.outerOf(n, g);
    const list = [];
    o.callers.forEach((c, i) => list.push({ side: 'l', node: c.node, edge: c.edge, x: LANE.caller, y: 30 + i * 84 }));
    o.kids.forEach((c, i) => list.push({ side: 'r', node: c.node, edge: c.edge, x: LANE.outer, y: 30 + i * 84 }));
    return list;
  }
  function subOf(c) {
    const p = c.props;
    switch (c.type) {
      case 'rest': case 'grpc': case 'graphql': return `${{ both: 'чтение и запись', read: 'чтение', write: 'запись' }[p.kinds]} · ${(p.pipe || []).length} mw${c.type === 'graphql' && !p.dataloader ? ' · без DataLoader' : ''}`;
      case 'consumer': return `ack ${p.ack === 'after' ? 'после коммита' : 'сразу'}${p.inbox ? ' · inbox' : ''}${p.dlq !== 'none' ? ' · DLQ' : ''}`;
      case 'cron': return `${{ '1m': 'раз в минуту', '1h': 'раз в час', '1d': 'ночью' }[p.every]} · ${{ none: 'без блокировки', db: 'ShedLock', lease: 'лидер' }[p.lock]}`;
      case 'usecase': return `${{ both: 'чтение и запись', read: 'чтение', write: 'запись' }[p.kinds]}${p.tx === 'usecase' && p.kinds !== 'read' ? ' · транзакция' : ''}${p.calls === 'par' ? ' · параллельно' : ''}${p.cache === 'aside' ? ' · кэш' : ''}`;
      case 'query': return `чтение из ${{ replica: 'реплики', cache: 'кэша', primary: 'primary' }[p.from]}`;
      case 'saga': return `${p.steps} шага${p.compensate ? ' · компенсации' : ' · без компенсаций'}`;
      case 'aggregate': return `${p.rich ? 'богатая модель' : 'анемичная'}${p.events ? ' · события' : ''}`;
      case 'port': return '«interface» · ' + { repo: 'хранилище', gateway: 'сосед', publisher: 'события', cache: 'кэш', files: 'файлы', search: 'поиск' }[p.role];
      case 'repo': return `${{ join: 'JOIN', batch: 'пачкой', lazy: 'N+1' }[p.fetch]} · ${p.orm === 'orm' ? 'ORM' : 'SQL'}`;
      case 'cachecl': return `TTL ${p.ttl}${p.single ? ' · singleflight' : ''}`;
      case 'httpcl': return p.idemKey ? 'с ключом идемпотентности' : 'без ключа идемпотентности';
      case 'pub': return p.mode === 'outbox' ? 'через outbox' : 'напрямую в брокер';
      case 'outbox': return p.relay === 'cdc' ? 'CDC (Debezium)' : 'опрос таблицы';
      case 'objcl': return p.presigned ? 'подписанные ссылки' : 'через сервис';
      default: return T(c.type).short;
    }
  }
  const portR = c => ({ x: laneX(c) + CW, y: c.y + CH / 2 });
  const portL = c => ({ x: laneX(c), y: c.y + CH / 2 });
  function edgePath(a, b) {
    const ax = laneX(a), bx = laneX(b);
    if (bx > ax) { const p = portR(a), q = portL(b); const dx = Math.max(40, (q.x - p.x) / 2); return `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x - 3},${q.y}`; }
    if (bx < ax) { const p = portL(a), q = portR(b); const dx = Math.max(40, (p.x - q.x) / 2); return `M${p.x},${p.y} C${p.x - dx},${p.y} ${q.x + dx},${q.y} ${q.x + 3},${q.y}`; }
    const down = b.y > a.y;
    const p = { x: ax + CW / 2 + 30, y: down ? a.y + CH : a.y }, q = { x: ax + CW / 2 + 30, y: down ? b.y - 3 : b.y + CH + 3 };
    return `M${p.x},${p.y} C${p.x + 50},${(p.y + q.y) / 2} ${q.x + 50},${(p.y + q.y) / 2} ${q.x},${q.y}`;
  }

  function render(full) {
    const n = svc(); if (!n) return;
    U.an = SD.inner.analyze(n, A().graph, A().res1 || A().res);
    $('inTitle').textContent = n.label || SD.TYPES[n.type].name;
    renderCanvas();
    renderFx();
    renderTabs();
    renderPane();
    void full;
  }
  function flagsFor() {
    const bad = new Map(), edges = new Map();
    (U.an ? U.an.findings : []).forEach(f => {
      if (f.sev !== 'bad' && f.sev !== 'warn') return;
      (f.comps || []).forEach(id => { if (bad.get(id) !== 'bad') bad.set(id, f.sev); });
      (f.edges || []).forEach(id => { if (edges.get(id) !== 'bad') edges.set(id, f.sev); });
    });
    return { bad, edges };
  }
  function renderCanvas() {
    const In = I(), fl = flagsFor();
    const b = bounds();
    const gl = $('inLanes'); gl.textContent = '';
    const lanes = [['caller', 'Кто вызывает', 'площадка', 'var(--text-muted)', GW], ...SD.CLAYERS.map(l => [l.id, l.label, l.sub, l.color, CW]), ['outer', 'Куда ходит', 'площадка', 'var(--text-muted)', GW]];
    lanes.forEach(([id, label, sub, color, w]) => {
      const x = LANE[id] - 10;
      el('rect', { class: 'in-lane' + (id === 'caller' || id === 'outer' ? ' outer' : ''), x, y: -64, width: w + 20, height: b.y1 + 64, rx: 12 }, gl);
      el('rect', { x: x + 10, y: -54, width: 26, height: 4, rx: 2, style: `fill:${color}` }, gl);
      const t = el('text', { class: 'in-lane-t', x: x + 10, y: -34 }, gl); t.textContent = label;
      const s = el('text', { class: 'in-lane-s', x: x + 10, y: -20 }, gl); s.textContent = sub.length > 34 ? sub.slice(0, 33) + '…' : sub;
    });
    /* граница контейнера */
    el('rect', { class: 'in-boundary', x: LANE.in - 22, y: -74, width: LANE.infra + CW + 44 - LANE.in, height: b.y1 + 84, rx: 16 }, gl);
    const bt = el('text', { class: 'in-boundary-t', x: LANE.in - 10, y: b.y1 + 2 }, gl); bt.textContent = `граница сервиса «${svc().label || SD.TYPES[svc().type].name}»`;

    /* внешние узлы и привязки */
    const gb = $('inBinds'); gb.textContent = '';
    const gh = ghosts();
    const M = U.an.M;
    gh.forEach(g => {
      const grp = el('g', { class: 'in-ghost', transform: `translate(${g.x},${g.y})` }, gb);
      el('rect', { width: GW, height: 46, rx: 9 }, grp);
      const ic = el('g', { transform: 'translate(9,11)', class: 'in-ghost-ic' }, grp);
      ic.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${SD.iconInner(g.node.type)}</svg>`;
      const t = el('text', { class: 'in-ghost-t', x: 38, y: 21 }, grp); const nm = SD.inner.outerName(g.node); t.textContent = nm.length > 16 ? nm.slice(0, 15) + '…' : nm;
      const s = el('text', { class: 'in-ghost-s', x: 38, y: 35 }, grp); s.textContent = SD.TYPES[g.node.type].name.toLowerCase().slice(0, 20);
    });
    M.comps.forEach(c => {
      if (!c.bound) return;
      const g = gh.find(x => x.node.id === c.bound.node.id && (c.t.consumer ? x.side === 'l' : x.side === 'r'));
      if (!g) return;
      const a = c.t.consumer ? { x: g.x + GW, y: g.y + 23 } : portR(c);
      const z = c.t.consumer ? portL(c) : { x: g.x, y: g.y + 23 };
      const dx = Math.max(30, Math.abs(z.x - a.x) / 2);
      el('path', { class: 'in-bind', d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}` }, gb);
    });
    const callers = gh.filter(g => g.side === 'l' && g.node.type !== 'queue');
    M.comps.filter(c => c.t.entry && !c.t.consumer && c.type !== 'cron').forEach(c => callers.forEach(g => {
      const a = { x: g.x + GW, y: g.y + 23 }, z = portL(c), dx = Math.max(30, (z.x - a.x) / 2);
      el('path', { class: 'in-bind', d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}` }, gb);
    }));

    /* связи */
    const ge = $('inEdges'); ge.textContent = '';
    In.edges.forEach(e => {
      const a = comp(e.from), bb = comp(e.to); if (!a || !bb) return;
      const impl = T(a.type).layer === 'infra' && bb.type === 'port';
      const f = fl.edges.get(e.id);
      const sel = U.sel && U.sel.type === 'edge' && U.sel.id === e.id;
      const grp = el('g', { class: `in-edge${impl ? ' impl' : ''}${f ? ' ' + f : ''}${sel ? ' sel' : ''}`, 'data-edge': e.id }, ge);
      const d = edgePath(a, bb);
      el('path', { class: 'wire', d, 'marker-end': impl ? 'url(#inArrImpl)' : 'url(#inArr)' }, grp);
      el('path', { class: 'hit', d }, grp);
    });

    /* компоненты */
    const gn = $('inNodes'); gn.textContent = '';
    In.nodes.forEach(c => {
      const t = T(c.type); if (!t) return;
      const x = laneX(c);
      const sel = U.sel && U.sel.type === 'comp' && U.sel.id === c.id;
      const f = fl.bad.get(c.id);
      const grp = el('g', { class: `in-node${c.type === 'port' ? ' port' : ''}${sel ? ' sel' : ''}${f ? ' ' + f : ''}`, transform: `translate(${x},${c.y})`, 'data-id': c.id, tabindex: 0, role: 'button', 'aria-label': c.label || t.name }, gn);
      el('rect', { class: 'body', width: CW, height: CH, rx: 10 }, grp);
      const mc = modColor(c.module);
      el('rect', { x: 0, y: 8, width: 4, height: CH - 16, rx: 2, style: `fill:${mc || layerColor(t.layer)}` }, grp);
      el('rect', { class: 'mono-bg', x: 12, y: 12, width: 38, height: 20, rx: 5, style: `stroke:${layerColor(t.layer)}` }, grp);
      const mono = el('text', { class: 'mono', x: 31, y: 26, 'text-anchor': 'middle', style: `fill:${layerColor(t.layer)}` }, grp); mono.textContent = t.mono;
      const title = c.label || t.name;
      const tt = el('text', { class: 'title', x: 58, y: 25 }, grp); tt.textContent = title.length > 20 ? title.slice(0, 19) + '…' : title;
      const sb = subOf(c);
      const st = el('text', { class: 'sub', x: 12, y: 48 }, grp); st.textContent = sb.length > 34 ? sb.slice(0, 33) + '…' : sb;
      if (c.module) { const mt = el('text', { class: 'modt', x: CW - 8, y: 12, 'text-anchor': 'end', style: `fill:${mc}` }, grp); mt.textContent = c.module.slice(0, 14); }
      if (f) el('circle', { class: 'flag', cx: CW - 10, cy: CH - 12, r: 5 }, grp);
      el('circle', { class: 'port', cx: CW, cy: CH / 2, r: 6.5, 'data-port': c.id }, grp);
    });
    /* пусто или подтверждение */
    const em = $('inEmpty');
    if (!In.nodes.length) {
      em.hidden = false;
      em.innerHTML = `<b>Сервис пока «чёрный ящик»</b><p>Собери слои по его связям на площадке — или перетащи компоненты из палитры слева.</p><p><b>Слои</b> — классика: роуты (контроллеры) → сервисный слой → репозитории. <b>Порты и адаптеры</b> — домен в центре, база и соседи подключаются через интерфейсы. <b>CQRS</b> — чтение и запись разными путями.</p><div class="in-row"><button type="button" class="btn primary" data-scaffold="layered">Слои: роуты → сервисы → репозитории</button><button type="button" class="btn" data-scaffold="hexagonal">Порты и адаптеры</button><button type="button" class="btn" data-scaffold="cqrs">CQRS</button></div>`;
    } else if (U.confirm) {
      em.hidden = false;
      em.innerHTML = `<b>Заменить текущие компоненты?</b><p>Сборка по схеме создаст компоненты заново. Твои правки внутри пропадут.</p><div class="in-row"><button type="button" class="btn primary" data-scaffold="${U.confirm}">Заменить</button><button type="button" class="btn" data-in="noconfirm">Отмена</button></div>`;
    } else em.hidden = true;
  }

  function renderFx() {
    const n = svc(), fx = U.an.fx, r = A().res1 || A().res, R = r && r.nodes[n.id];
    const inst = R ? R.alive : (n.props.count || 1);
    const has = SD.inner.has(n);
    const x = v => '×' + v.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
    const cl = (v, good) => v === 1 ? '' : (good ? v < 1 : v > 1) ? 'ok' : 'bad';
    let h = `<span class="in-fx-t">Влияние на площадку</span>`;
    if (!has) h += `<span class="note">пока нет компонентов — сервис считается как обычно</span>`;
    else {
      h += `<span class="${cl(fx.cpu, true)}" title="Сколько CPU тратит один запрос относительно базового сервиса">CPU на запрос <b>${x(fx.cpu)}</b></span>`;
      h += `<span class="${cl(fx.wait, true)}" title="Сколько стоит ожидание базы и соседей: поток занят или свободен">цена ожидания <b>${x(fx.wait)}</b></span>`;
      h += `<span class="${fx.dbRead > 1 ? 'bad' : ''}" title="Сколько запросов к базе на одно чтение">запросов к БД на чтение <b>${x(fx.dbRead)}</b></span>`;
      const sql = A().graph.edges.filter(e => e.from === n.id).map(e => A().graph.nodes.find(z => z.id === e.to)).find(z => z && z.type === 'sql');
      if (sql) { const conns = inst * fx.pool; h += `<span class="${conns > 200 && !sql.props.pooler ? 'bad' : ''}" title="Экземпляры × пул соединений против лимита базы">соединений <b>${inst} × ${fx.pool} = ${conns}</b> из ${sql.props.pooler ? '10 000' : '200'}</span>`; }
    }
    if (r && U.base) {
      const d = (now, was, lower, fmt) => { if (fmt(now) === fmt(was)) return `<b>${fmt(now)}</b>`; const better = lower ? now < was : now > was; return `<b class="${better ? 'ok' : 'bad'}">${fmt(now)}</b><small>было ${fmt(was)}</small>`; };
      h += `<span class="in-fx-sep"></span><span>успешно ${d(r.total.success, U.base.succ, false, F().pct)}</span><span>задержка ${d(r.total.lat, U.base.lat, true, F().ms)}</span><span>цена ${d(r.cost, U.base.cost, true, F().usd)}</span>`;
    }
    if (U.synced.length) h += `<span class="in-fx-sync">узел на площадке: ${esc(U.synced.join(', '))}</span>`;
    $('inFx').innerHTML = h;
  }

  function renderTabs() {
    const c = U.an.counts;
    document.querySelectorAll('#innerModal [data-tab]').forEach(b => {
      b.setAttribute('aria-selected', b.dataset.tab === U.tab ? 'true' : 'false');
      if (b.dataset.tab === 'check') b.innerHTML = 'Проверка' + (c.bad ? `<span class="in-badge bad">${c.bad}</span>` : c.warn ? `<span class="in-badge warn">${c.warn}</span>` : '');
    });
  }

  /* ---------- боковая панель ---------- */
  function renderPane() {
    const p = $('inPane'), w = $('inWide');
    w.hidden = !(U.tab === 'trace' || U.tab === 'code');
    if (U.tab === 'check') p.innerHTML = paneCheck();
    else if (U.tab === 'trace') { p.innerHTML = paneTrace(); w.innerHTML = `<div class="in-wide-head"><b>Диаграмма последовательности</b><button type="button" class="btn ghost" data-tab="comp">← К схеме</button></div><div class="in-seq" id="inSeq"></div>`; drawTrace(); }
    else if (U.tab === 'code') { p.innerHTML = paneCode(); w.innerHTML = wideCode(); }
    else p.innerHTML = U.sel && U.sel.type === 'comp' && comp(U.sel.id) ? paneComp(comp(U.sel.id)) : U.sel && U.sel.type === 'edge' ? paneEdge() : paneService();
  }
  function control(d, v, attr, ctx) {
    if (d.showIf && !d.showIf(ctx)) return '';
    const id = 'in_' + attr + '_' + d.key;
    const help = d.help ? `<div class="help">${esc(d.help)}</div>` : '';
    if (d.type === 'range') return `<div class="prop"><label for="${id}">${esc(d.label)} <output>${v}</output></label><input type="range" id="${id}" data-${attr}="${d.key}" min="${d.min}" max="${d.max}" step="${d.step || 1}" value="${v}">${help}</div>`;
    if (d.type === 'select') return `<div class="prop"><label for="${id}">${esc(d.label)}</label><select id="${id}" data-${attr}="${d.key}">${d.options.map(([k, t]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${help}</div>`;
    if (d.type === 'toggle') return `<label class="switch"><input type="checkbox" id="${id}" data-${attr}="${d.key}" ${v ? 'checked' : ''}><span><b>${esc(d.label)}</b>${d.help ? `<small>${esc(d.help)}</small>` : ''}</span></label>`;
    if (d.type === 'multi') return `<div class="prop"><span class="plabel">${esc(d.label)}</span><div class="multi">${d.options.map(([k, t, hh]) => `<label class="switch"><input type="checkbox" data-${attr}="${d.key}" data-multi="${k}" ${(v || []).includes(k) ? 'checked' : ''}><span><b>${esc(t)}</b><small>${esc(hh)}</small></span></label>`).join('')}</div>${help}</div>`;
    return '';
  }
  function findingsFor(pred) {
    const list = (U.an ? U.an.findings : []).filter(pred);
    return list.length ? `<div class="advice">${list.map(f => `<div class="adv ${f.sev === 'warn' ? '' : f.sev}"><span><b>${esc(f.text)}.</b> ${esc(f.why)}${f.fix ? ` <i>${esc(f.fix)}</i>` : ''}${f.pat && SD.PATTERNS.find(x => x.id === f.pat) ? ` <button class="linkish" type="button" data-inpat="${f.pat}">Паттерн</button>` : ''}</span></div>`).join('')}</div>` : '';
  }
  function paneService() {
    const n = svc(), rt = I().rt, rti = SD.CRUNTIME[rt.rt];
    let h = `<div class="insp-head">${SD.icon(n.type)}<div><b>${esc(n.label || SD.TYPES[n.type].name)}</b><small>C4 · уровень компонентов</small></div></div>`;
    h += `<p>На площадке этот сервис — один прямоугольник (контейнер). Здесь видно, из чего он состоит. Стрелка значит «зависит от». Зависимости должны указывать к домену: вход → приложение → домен ← инфраструктура.</p>`;
    h += `<div class="in-legend">${SD.CLAYERS.map(l => `<span><i style="background:${l.color}"></i><b>${esc(l.label)}</b> ${esc(l.sub)}</span>`).join('')}<span><i class="impl"></i><b>Пунктир с пустой стрелкой</b> адаптер реализует порт</span></div>`;
    h += `<h3>Рантайм сервиса</h3><div class="props">${SD.CRT_PROPS.map(d => control(d, rt[d.key], 'inrt', null)).join('')}</div><p class="note" style="margin-top:8px">${esc(rti.note)}</p>`;
    const In = I();
    if (In.nodes.length) {
      h += `<h3>Компоненты · ${In.nodes.length}</h3><div class="mini-list">${In.nodes.slice().sort((a, b) => SD.CLAYER_IDX[T(a.type).layer] - SD.CLAYER_IDX[T(b.type).layer] || a.y - b.y).map(c => `<button type="button" class="mini" data-insel="${c.id}"><span class="in-mono" style="color:${layerColor(T(c.type).layer)}">${T(c.type).mono}</span><span>${esc(c.label || T(c.type).name)}</span><b></b></button>`).join('')}</div>`;
    }
    h += `<p class="note" style="margin-top:14px">Добавь компонент из палитры, протяни связь от кружка справа к другому компоненту. Delete — удалить выделенное.</p>`;
    return h;
  }
  function paneComp(c) {
    const t = T(c.type), M = U.an.M, mc = M.by.get(c.id);
    let h = `<div class="insp-head"><span class="in-mono big" style="color:${layerColor(t.layer)}">${t.mono}</span><div><input class="rename" data-inrename="1" value="${esc(c.label || t.name)}" aria-label="Название компонента"><small>${esc(t.name)} · ${esc(SD.CLAYERS.find(l => l.id === t.layer).label)}</small></div></div>`;
    const sim = SD.SIMPLE_CTYPES && SD.SIMPLE_CTYPES[c.type];
    if (sim) h += `<div class="simple sm"><span class="eyebrow">Простыми словами</span><span class="an">${esc(sim[1])}</span><span class="pl">${esc(sim[0])}</span></div>`;
    h += `<p>${esc(t.what)}</p>`;
    h += findingsFor(f => (f.comps || []).includes(c.id));
    const mods = [...new Set(I().nodes.map(x => x.module).filter(Boolean))];
    const auto = SD.innerCode ? SD.innerCode.names(M).get(c.id) : '';
    h += `<div class="props in-meta"><div class="prop"><label for="in_ident">Имя в коде</label><input class="in-input" id="in_ident" data-inident="1" value="${esc(c.ident || '')}" placeholder="${esc(auto)}"></div><div class="prop"><label for="in_mod">Модуль</label><input class="in-input" id="in_mod" data-inmod="1" list="in_mods" value="${esc(c.module || '')}" placeholder="без модуля"><datalist id="in_mods">${mods.map(m => `<option value="${esc(m)}">`).join('')}</datalist><div class="help">Модули — границы внутри сервиса (модульный монолит). Другие модули обращаются к модулю только через его публичный API.</div></div></div>`;
    if (t.binds || t.consumer) {
      const opts = t.consumer ? M.outer.callers.filter(x => x.node.type === 'queue') : M.outer.kids.filter(k => t.binds.includes(k.node.type));
      h += `<h3>Связь на площадке</h3>`;
      h += opts.length ? `<div class="prop"><select data-inbind="1">${opts.map(o => `<option value="${o.node.id}" ${mc.bound && mc.bound.node.id === o.node.id ? 'selected' : ''}>${esc(SD.inner.outerName(o.node))} · ${esc(SD.TYPES[o.node.type].name)}</option>`).join('')}</select><div class="help">Адаптер — это код, который делает вызов по стрелке на площадке.</div></div>` : `<p class="note">${t.consumer ? 'В сервис не входит ни один брокер.' : `У сервиса на площадке нет связи с ${t.binds.slice(0, 3).map(x => (SD.TYPES[x] || { name: x }).name.toLowerCase()).join(', ')}.`} Закрой это окно и проведи стрелку на площадке.</p>`;
    }
    const props = (t.props || []).map(d => control(d, c.props[d.key], 'inprop', c)).join('');
    if (props) h += `<h3>Настройки</h3><div class="props">${props}</div>`;
    if (t.edgeProps && mc.bound) {
      const p = Object.assign(SD.edgeDefaults(), mc.bound.edge.props || {});
      h += `<h3>Устойчивость вызова · общая со стрелкой на площадке</h3><div class="props">`;
      h += `<div class="prop"><label for="in_to">Таймаут</label><select id="in_to" data-ineprop="timeout">${SD.TIMEOUTS.map(([v, tt]) => `<option value="${v}" ${p.timeout === v ? 'selected' : ''}>${tt}</option>`).join('')}</select></div>`;
      h += `<div class="prop"><label for="in_rt">Повторы <output>${p.retries}</output></label><input type="range" id="in_rt" data-ineprop="retries" min="0" max="5" step="1" value="${p.retries}"></div>`;
      h += `<div class="prop"><label for="in_bo">Пауза между повторами</label><select id="in_bo" data-ineprop="backoff"><option value="none" ${p.backoff === 'none' ? 'selected' : ''}>Сразу</option><option value="exp" ${p.backoff === 'exp' ? 'selected' : ''}>Экспоненциальная с джиттером</option></select></div>`;
      h += `<label class="switch"><input type="checkbox" data-ineprop="cb" ${p.cb ? 'checked' : ''}><span><b>Circuit breaker</b><small>Отбивает вызовы сразу, пока сосед лежит.</small></span></label>`;
      h += `<label class="switch"><input type="checkbox" data-ineprop="fallback" ${p.fallback ? 'checked' : ''}><span><b>Fallback</b><small>Упрощённый ответ при отказе.</small></span></label></div>`;
    }
    h += `<h3>Зачем</h3><p>${esc(t.why)}</p>`;
    if (SD.innerCode) {
      const fl = SD.innerCode.files(svc(), A().graph).files.find(f => f.comp === c.id);
      if (fl) h += `<details class="lv-code" open><summary>Код компонента · ${esc(fl.path)}</summary>${codeHtml(fl.src, fl.lang)}</details>`;
    }
    h += `<div class="row-btns">${t.entry ? `<button type="button" class="btn" data-intrace="${c.id}">Трасса через этот вход</button>` : ''}<button type="button" class="btn ghost danger" data-in="del">Удалить компонент</button></div>`;
    return h;
  }
  function paneEdge() {
    const e = I().edges.find(x => x.id === U.sel.id);
    if (!e) return paneService();
    const a = comp(e.from), b = comp(e.to);
    const la = T(a.type).layer, lb = T(b.type).layer;
    const impl = la === 'infra' && b.type === 'port';
    const L = id => SD.CLAYERS.find(l => l.id === id).label;
    let h = `<div class="insp-head"><span class="edge-ico">→</span><div><b>${esc(a.label || T(a.type).name)} → ${esc(b.label || T(b.type).name)}</b><small>${impl ? 'реализация порта' : 'зависимость: первый вызывает второй'}</small></div></div>`;
    h += `<p>${impl ? 'Адаптер реализует интерфейс, который объявил бизнес-код. Стрелка смотрит внутрь — к домену. Это и есть инверсия зависимостей.' : `${L(la)} → ${L(lb)}. ${SD.CLAYER_IDX[lb] >= SD.CLAYER_IDX[la] && !(la === 'in' && lb === 'infra') ? 'Направление к центру — так и должно быть.' : 'Посмотри, что пишет проверка об этой связи.'}`}</p>`;
    h += findingsFor(f => (f.edges || []).includes(e.id));
    return h + `<div class="row-btns"><button type="button" class="btn ghost danger" data-in="del">Удалить связь</button></div>`;
  }
  function paneCheck() {
    const an = U.an, c = an.counts;
    let h = `<div class="in-score"><span class="bad">${c.bad}<small>ошибок</small></span><span class="warn">${c.warn}<small>рисков</small></span><span class="ok">${c.good}<small>хорошо</small></span></div>`;
    h += `<p class="note">Проверки смотрят на направление зависимостей, соответствие схеме площадки, надёжность вызовов, транзакции, консьюмеры и модули. Цифры берутся из симулятора.</p>`;
    if (!an.findings.length) h += `<div class="advice"><div class="adv good"><span>Замечаний нет.</span></div></div>`;
    h += `<div class="advice">${an.findings.map((f, i) => `<div class="adv ${f.sev === 'warn' ? '' : f.sev}"><span><small class="in-sev ${f.sev}">${SEVL[f.sev]}</small> <b>${esc(f.text)}.</b> ${esc(f.why)}${f.fix ? `<br><i>Как исправить: ${esc(f.fix)}</i>` : ''}<br>${(f.comps || []).length || (f.edges || []).length ? `<button class="linkish" type="button" data-inshow="${i}">Показать</button> ` : ''}${f.pat && SD.PATTERNS.find(x => x.id === f.pat) ? `<button class="linkish" type="button" data-inpat="${f.pat}">Паттерн «${esc(SD.PATTERNS.find(x => x.id === f.pat).name)}»</button>` : ''}</span></div>`).join('')}</div>`;
    return h;
  }

  /* ---------- трасса ---------- */
  function paneTrace() {
    const M = U.an.M;
    const ents = M.comps.filter(c => c.t.entry);
    if (!ents.length) return `<p class="empty">Нет входов: трассу строить не от чего. Добавь REST-контроллер или консьюмер.</p>`;
    if (!U.traceEntry || !M.by.get(U.traceEntry)) U.traceEntry = ents[0].id;
    const e = M.by.get(U.traceEntry);
    const kinds = e.t.consumer ? ['job'] : e.type === 'cron' ? ['write'] : e.props.kinds === 'both' ? ['read', 'write'] : [e.props.kinds];
    if (!kinds.includes(U.traceKind)) U.traceKind = kinds[0];
    let h = `<p class="note">Диаграмма последовательности строится из компонентов и связей. Время внешних вызовов — из симулятора площадки.</p>`;
    h += `<div class="in-pick">${ents.map(x => `<button type="button" class="chip-btn ${x.id === e.id ? 'on' : ''}" data-intrace="${x.id}">${esc(x.label || x.t.name)}</button>`).join('')}</div>`;
    if (kinds.length > 1) h += `<div class="in-pick">${kinds.map(k => `<button type="button" class="chip-btn ${k === U.traceKind ? 'on' : ''}" data-inkind="${k}">${{ read: 'Чтение', write: 'Запись', job: 'Сообщение' }[k]}</button>`).join('')}</div>`;
    h += `<div id="inSeqSum"></div>`;
    h += `<h3>Как читать</h3><p class="note">Колонки — участники: кто вызывает, компоненты сервиса и внешние узлы площадки. Стрелки сверху вниз — порядок вызовов. Рамки: <b>транзакция</b>, <b>loop</b> — повтор в цикле (N+1), <b>par</b> — параллельные вызовы. Время у стрелок к внешним узлам — из симулятора.</p>`;
    return h;
  }
  function drawTrace() {
    const box = $('inSeq'); if (!box) return;
    const tr = SD.inner.trace(svc(), A().graph, A().res1 || A().res, U.traceEntry, U.traceKind);
    if (!tr) { box.innerHTML = ''; return; }
    const COLW = 128, col = new Map(tr.parts.map((p, i) => [p.key, i])), X = i => 20 + i * COLW + COLW / 2;
    let y = 66; const els = [];
    const colsOf = items => { const s = []; items.forEach(it => { if (it.t === 'frag') s.push(...colsOf(it.items)); else ['from', 'to', 'at'].forEach(k => { if (it[k] !== undefined && col.has(it[k])) s.push(col.get(it[k])); }); }); return s; };
    const walk = (items, depth) => items.forEach(it => {
      if (it.t === 'frag') { const y0 = y; y += 24; walk(it.items, depth + 1); y += 6; const cs = colsOf(it.items); els.push({ t: 'frag', y0, y1: y, c0: Math.min(...cs), c1: Math.max(...cs), label: it.label, kind: it.kind, depth }); y += 8; }
      else if (it.t === 'msg') { els.push(Object.assign({}, it, { y })); y += 32; }
      else { els.push(Object.assign({}, it, { y })); y += 26; }
    });
    walk(tr.items, 0);
    const W = 40 + tr.parts.length * COLW, H = y + 16;
    const svg = el('svg', { class: 'in-seq-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const defs = el('defs', null, svg);
    defs.innerHTML = '<marker id="sqA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
    tr.parts.forEach((p, i) => {
      const x = X(i);
      el('line', { class: 'sq-life', x1: x, y1: 46, x2: x, y2: H - 6 }, svg);
      const g = el('g', { class: 'sq-part ' + p.kind }, svg);
      el('rect', { x: x - COLW / 2 + 6, y: 8, width: COLW - 12, height: 36, rx: 7, style: p.kind === 'outer' ? '' : `stroke:${layerColor(p.kind)}` }, g);
      const words = p.label.split(' '); let l1 = '', l2 = '';
      words.forEach(w => { if ((l1 + ' ' + w).trim().length <= 16 && !l2) l1 = (l1 + ' ' + w).trim(); else l2 = (l2 + ' ' + w).trim(); });
      if (l2.length > 16) l2 = l2.slice(0, 15) + '…';
      const t1 = el('text', { x, y: l2 ? 23 : 30, 'text-anchor': 'middle' }, g); t1.textContent = l1;
      if (l2) { const t2 = el('text', { x, y: 37, 'text-anchor': 'middle' }, g); t2.textContent = l2; }
    });
    els.filter(e => e.t === 'frag').forEach(f => {
      const x0 = X(f.c0) - COLW / 2 + 4 + f.depth * 5, x1 = X(f.c1) + COLW / 2 - 4 - f.depth * 5;
      const g = el('g', { class: 'sq-frag ' + f.kind }, svg);
      el('rect', { x: x0, y: f.y0 - 6, width: x1 - x0, height: f.y1 - f.y0, rx: 6 }, g);
      const tw = Math.min(x1 - x0 - 8, f.label.length * 6.2 + 14);
      el('path', { d: `M${x0},${f.y0 + 10} h${tw} l6,-8 v-8 h-${tw + 6}` }, g);
      const t = el('text', { x: x0 + 6, y: f.y0 + 6 }, g); t.textContent = f.label;
    });
    els.filter(e => e.t !== 'frag').forEach(m => {
      if (m.t === 'msg') {
        const a = X(col.get(m.from)), b = X(col.get(m.to));
        const g = el('g', { class: `sq-msg${m.ret ? ' ret' : ''}${m.outer ? ' outer' : ''}${m.bad ? ' bad' : ''}` }, svg);
        el('line', { x1: a, y1: m.y + 14, x2: b + (b > a ? -2 : 2), y2: m.y + 14, 'marker-end': 'url(#sqA)' }, g);
        const lab = m.label.length > 30 ? m.label.slice(0, 29) + '…' : m.label;
        const t = el('text', { x: (a + b) / 2, y: m.y + 9, 'text-anchor': 'middle' }, g); t.textContent = lab;
        if (m.ms >= 0.5) { const tm = el('text', { class: 'ms', x: Math.max(a, b) - 4, y: m.y + 26, 'text-anchor': 'end' }, g); tm.textContent = F().ms(m.ms); }
      } else if (m.t === 'self') {
        const x = X(col.get(m.at));
        const g = el('g', { class: 'sq-self' }, svg);
        el('path', { d: `M${x},${m.y + 4} h22 v12 h-20`, 'marker-end': 'url(#sqA)' }, g);
        const t = el('text', { x: x + 28, y: m.y + 14 }, g); t.textContent = m.label + (m.ms >= 1 ? ' · ' + F().ms(m.ms) : '');
      } else if (m.t === 'note') {
        const x = X(col.get(m.at));
        const g = el('g', { class: 'sq-note' }, svg);
        const w = Math.min(COLW * 2 - 10, m.label.length * 6 + 14);
        el('rect', { x: x + 6, y: m.y + 2, width: w, height: 18, rx: 4 }, g);
        const t = el('text', { x: x + 12, y: m.y + 15 }, g); t.textContent = m.label;
      }
    });
    box.innerHTML = ''; box.appendChild(svg);
    $('inSeqSum').innerHTML = `<dl class="kv" style="margin-top:12px"><dt>Внутри сервиса и его вызовов</dt><dd>${F().ms(tr.total)}</dd>${tr.e2e != null ? `<dt>Сквозная задержка на площадке</dt><dd>${F().ms(tr.e2e)}</dd>` : ''}</dl>${tr.notes.map(x => `<p class="note">${esc(x)}</p>`).join('')}<p class="note">Сквозная задержка включает сеть до сервиса, очереди при нагрузке и всех соседей. Трасса — путь одного запроса через компоненты.</p>`;
  }

  /* ---------- код ---------- */
  function codeHtml(src, lang) { return `<pre class="code pat-code">${src.replace(/\n$/, '').split('\n').map((l, k) => `<span class="ln" data-n="${k + 1}">${SD.player.highlight(l, lang) || ' '}</span>`).join('')}</pre>`; }
  function paneCode() {
    if (!SD.innerCode) return '';
    const { files } = SD.innerCode.files(svc(), A().graph);
    if (!files.length) return `<p class="empty">Компонентов нет — и кода нет. Собери сервис по схеме.</p>`;
    if (!U.file || !files.find(f => f.path === U.file)) U.file = (U.sel && U.sel.type === 'comp' && (files.find(f => f.comp === U.sel.id) || {}).path) || 'src/main.ts';
    const f = files.find(x => x.path === U.file) || files[0];
    const rt = SD.CRUNTIME[I().rt.rt];
    let h = `<p class="note">Каркас на TypeScript: так читается любая сервисная кодовая база. Рантайм на площадке — ${esc(rt.name)}, его настройки — в последнем файле. Код отдельного компонента виден и во вкладке «Компонент».</p>`;
    h += `<div class="in-files">${files.map(x => `<button type="button" class="${x.path === f.path ? 'on' : ''}" data-infile="${esc(x.path)}"><i style="background:${x.layer === 'main' || x.layer === 'rt' ? 'var(--text-muted)' : layerColor(x.layer)}"></i>${esc(x.path.replace(/^src\//, ''))}</button>`).join('')}</div>`;
    h += `<h3>Что смотреть</h3><p class="note">Порты — интерфейсы в domain/ports. Адаптеры в infra реализуют их через implements. Сценарии получают зависимости в конструктор, а связывает всё main.ts (composition root). Строки с ⚠ — то, на что ругается проверка.</p>`;
    return h;
  }
  function wideCode() {
    if (!SD.innerCode) return '';
    const { files } = SD.innerCode.files(svc(), A().graph);
    const f = files.find(x => x.path === U.file) || files[0];
    if (!f) return `<div class="in-wide-head"><b>Код</b><button type="button" class="btn ghost" data-tab="comp">← К схеме</button></div><p class="empty">Компонентов нет — и кода нет.</p>`;
    return `<div class="in-wide-head"><b>${esc(f.path)}</b><button type="button" class="btn ghost" data-tab="comp">← К схеме</button></div>${codeHtml(f.src, f.lang)}`;
  }

  /* ---------- палитра ---------- */
  function renderPalette() {
    let h = '';
    SD.CGROUPS.forEach(([lid, types]) => {
      const L = SD.CLAYERS.find(l => l.id === lid);
      h += `<div class="grp"><h4><i style="background:${L.color}"></i>${esc(L.label)}</h4>`;
      types.forEach(t => { const d = T(t); h += `<button type="button" class="in-part" data-ctype="${t}" title="${esc(SD.SIMPLE_CTYPES && SD.SIMPLE_CTYPES[t] ? SD.SIMPLE_CTYPES[t][1] : d.short)}"><span class="in-mono" style="color:${L.color}">${d.mono}</span><span class="t"><b>${esc(d.name)}</b><small>${esc(d.short)}</small></span></button>`; });
      h += `</div>`;
    });
    $('inPal').innerHTML = h;
  }
  function bindPalette() {
    $('inPal').addEventListener('pointerdown', ev => {
      const part = ev.target.closest('.in-part'); if (!part) return;
      const type = part.dataset.ctype;
      let ghost = null, moved = false; const sx = ev.clientX, sy = ev.clientY;
      const move = e2 => {
        if (!moved && Math.hypot(e2.clientX - sx, e2.clientY - sy) < 6) return;
        moved = true;
        if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost-part'; ghost.innerHTML = `<span class="in-mono">${T(type).mono}</span><span>${esc(T(type).name)}</span>`; document.body.appendChild(ghost); }
        ghost.style.left = e2.clientX + 'px'; ghost.style.top = e2.clientY + 'px';
      };
      const up = e2 => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        if (ghost) ghost.remove();
        const r = $('inSvg').getBoundingClientRect();
        if (moved && e2.clientX > r.left && e2.clientX < r.right && e2.clientY > r.top && e2.clientY < r.bottom) addComp(type, toWorld(e2.clientX, e2.clientY).y - CH / 2);
        else if (!moved) addComp(type);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }

  /* ---------- ввод на холсте ---------- */
  function bindCanvas() {
    const svg = $('inSvg');
    let drag = null;
    svg.addEventListener('pointerdown', ev => {
      const port = ev.target.closest('[data-port]'), nodeEl = ev.target.closest('.in-node'), edgeEl = ev.target.closest('.in-edge');
      const w = toWorld(ev.clientX, ev.clientY);
      svg.setPointerCapture(ev.pointerId);
      if (port) {
        const c = comp(port.dataset.port), p = portR(c);
        drag = { kind: 'connect', from: c.id, p, line: el('path', { class: 'rubber', d: `M${p.x},${p.y} L${w.x},${w.y}` }, $('inFxG')) };
      } else if (nodeEl) {
        const c = comp(nodeEl.dataset.id);
        drag = { kind: 'node', c, dy: w.y - c.y, moved: false, sy: ev.clientY, sx: ev.clientX };
      } else if (edgeEl) { U.sel = { type: 'edge', id: edgeEl.dataset.edge }; U.tab = 'comp'; render(false); drag = null; }
      else drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: U.view.x, vy: U.view.y, moved: false };
    });
    svg.addEventListener('pointermove', ev => {
      if (!drag) return;
      const w = toWorld(ev.clientX, ev.clientY);
      if (drag.kind === 'connect') drag.line.setAttribute('d', `M${drag.p.x},${drag.p.y} L${w.x},${w.y}`);
      else if (drag.kind === 'node') {
        if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
        drag.moved = true; drag.c.y = Math.max(0, Math.round((w.y - drag.dy) / 4) * 4); renderCanvas();
      } else if (drag.kind === 'pan') {
        const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        U.view.x = drag.vx + dx; U.view.y = drag.vy + dy; applyView();
      }
    });
    const end = ev => {
      if (!drag) return;
      if (drag.kind === 'connect') {
        drag.line.remove();
        const tEl = document.elementFromPoint(ev.clientX, ev.clientY);
        const nEl = tEl && tEl.closest && tEl.closest('.in-node');
        if (nEl && nEl.dataset.id !== drag.from) { if (!addEdge(drag.from, nEl.dataset.id)) SD.app.toast('Такая связь уже есть.'); }
        else { U.sel = { type: 'comp', id: drag.from }; U.tab = 'comp'; render(false); }
      } else if (drag.kind === 'node') {
        if (drag.moved) render(false); else { U.sel = { type: 'comp', id: drag.c.id }; if (U.tab !== 'code') U.tab = 'comp'; else U.file = null; render(false); }
      } else if (drag.kind === 'pan' && !drag.moved) { U.sel = null; render(false); }
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', ev => { ev.preventDefault(); const r = svg.getBoundingClientRect(); const px = ev.clientX - r.left, py = ev.clientY - r.top, f = ev.deltaY < 0 ? 1.1 : 1 / 1.1; const k = Math.max(0.3, Math.min(2, U.view.k * f)); U.view.x = px - (px - U.view.x) * k / U.view.k; U.view.y = py - (py - U.view.y) * k / U.view.k; U.view.k = k; applyView(); }, { passive: false });
  }
  function onKey(ev) {
    const m = $('innerModal');
    if (!m || m.hidden) return;
    if (ev.target.matches && ev.target.matches('input, select, textarea')) { if (ev.key === 'Escape') ev.target.blur(); ev.stopPropagation(); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); ev.stopPropagation(); removeSel(); }
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); if (U.sel) { U.sel = null; render(false); } else close(); }
  }

  /* ---------- события панели ---------- */
  function onClick(e) {
    const m = $('innerModal');
    if (e.target === m) { close(); return; }
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if ('close' in d) { close(); return; }
    if (d.scaffold) { scaffold(d.scaffold); return; }
    if (d.tab) { U.tab = d.tab; renderTabs(); renderPane(); return; }
    if (d.in === 'clear') { if (I().nodes.length && U.confirm !== 'clear') { U.confirm = 'clear'; SD.app.toast('Нажми «Очистить» ещё раз, чтобы удалить все компоненты.'); return; } U.confirm = null; I().nodes = []; I().edges = []; U.sel = null; commit(); return; }
    if (d.in === 'noconfirm') { U.confirm = null; render(false); return; }
    if (d.in === 'zin') { zoomAt(1.2); return; }
    if (d.in === 'zout') { zoomAt(1 / 1.2); return; }
    if (d.in === 'fit') { fit(); return; }
    if (d.in === 'del') { removeSel(); return; }
    if (d.insel) { U.sel = { type: 'comp', id: d.insel }; render(false); return; }
    if (d.inpat) { SD.patterns.open(d.inpat); return; }
    if (d.inshow) { const f = U.an.findings[+d.inshow]; if (f) { U.sel = (f.comps || [])[0] ? { type: 'comp', id: f.comps[0] } : f.edges && f.edges[0] ? { type: 'edge', id: f.edges[0] } : null; U.tab = 'comp'; render(false); } return; }
    if (d.intrace) { U.traceEntry = d.intrace; U.tab = 'trace'; renderTabs(); renderPane(); return; }
    if (d.inkind) { U.traceKind = d.inkind; renderPane(); return; }
    if (d.infile) { U.file = d.infile; renderPane(); return; }
  }
  let rtTimer = null;
  function onInput(e) {
    const t = e.target, d = t.dataset;
    if (d.inrename !== undefined && U.sel && U.sel.type === 'comp') { comp(U.sel.id).label = t.value; if (e.type === 'change') render(false); else renderCanvas(); return; }
    if (d.inident !== undefined && U.sel) { const v = t.value.replace(/[^A-Za-z0-9_]/g, ''); comp(U.sel.id).ident = v || undefined; if (e.type === 'change') renderPane(); return; }
    if (d.inmod !== undefined && U.sel) { comp(U.sel.id).module = t.value.trim() || undefined; if (e.type === 'change') commit(); else renderCanvas(); return; }
    if (d.inbind !== undefined && U.sel) { comp(U.sel.id).bind = t.value; commit(); return; }
    if (d.inprop !== undefined && U.sel) {
      const c = comp(U.sel.id), def = T(c.type).props.find(p => p.key === d.inprop);
      if (def.type === 'multi') { if (e.type === 'input') return; const s = new Set(c.props[def.key] || []); if (t.checked) s.add(d.multi); else s.delete(d.multi); c.props[def.key] = def.options.map(o => o[0]).filter(k => s.has(k)); }
      else if (def.type === 'toggle') { if (e.type === 'input') return; c.props[def.key] = t.checked; }
      else if (def.type === 'range') { c.props[def.key] = +t.value; const o = t.parentElement.querySelector('output'); if (o) o.textContent = t.value; if (e.type === 'input') { clearTimeout(rtTimer); rtTimer = setTimeout(commit, 250); return; } }
      else { if (e.type === 'input' && t.tagName === 'SELECT') return; c.props[def.key] = t.value; }
      commit(); return;
    }
    if (d.ineprop !== undefined && U.sel) {
      const c = U.an.M.by.get(U.sel.id); if (!c || !c.bound) return;
      const edge = A().graph.edges.find(x => x.id === c.bound.edge.id);
      edge.props = Object.assign(SD.edgeDefaults(), edge.props || {});
      const k = d.ineprop;
      if (t.type === 'checkbox') { if (e.type === 'input') return; edge.props[k] = t.checked; }
      else if (k === 'retries') { edge.props[k] = +t.value; const o = t.parentElement.querySelector('output'); if (o) o.textContent = t.value; if (e.type === 'input') { clearTimeout(rtTimer); rtTimer = setTimeout(commit, 250); return; } }
      else if (k === 'timeout') { if (e.type === 'input') return; edge.props[k] = +t.value; }
      else { if (e.type === 'input') return; edge.props[k] = t.value; }
      commit(); return;
    }
    if (d.inrt !== undefined) {
      const rt = I().rt, def = SD.CRT_PROPS.find(p => p.key === d.inrt);
      if (def.type === 'toggle') { if (e.type === 'input') return; rt[def.key] = t.checked; }
      else if (def.type === 'range') { rt[def.key] = +t.value; const o = t.parentElement.querySelector('output'); if (o) o.textContent = t.value; if (e.type === 'input') { clearTimeout(rtTimer); rtTimer = setTimeout(commit, 250); return; } }
      else { if (e.type === 'input') return; rt[def.key] = t.value; }
      commit();
    }
  }

  SD.innerUI = { mount, open, close, isOpen: () => !$('innerModal').hidden };
  SD.innerTag = n => n.props && n.props.inner && n.props.inner.nodes && n.props.inner.nodes.length ? ` · ⧉${n.props.inner.nodes.length}` : '';
})();
