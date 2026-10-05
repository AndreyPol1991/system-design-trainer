/* «Проследить запрос»: один запрос под лупой прямо на площадке. Шаг за шагом по схеме:
   что делает узел, сколько миллисекунд запрос в нём проводит, какая доля запросов туда доходит.
   Время узла — из симулятора: «если бы поддерево узла работало мгновенно» минус вклад детей. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const T = () => SD.TYPES, F = () => SD.fmt;
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const DOES = {
    client: 'отправляет запрос', lb: 'выбирает живой экземпляр и передаёт запрос', gateway: 'проверяет токен и лимит частоты, маршрутизирует',
    app: 'выполняет логику: разбирает запрос, ходит в зависимости, собирает ответ', worker: 'берёт задачу из очереди и выполняет',
    cache: 'ищет ключ в памяти: нашёл — отвечает сразу, нет — сервис идёт дальше', sql: 'находит строки по индексу (или пишет: журнал WAL, строка, индексы)',
    nosql: 'по ключу партиции идёт на нужный узел и читает или пишет', queue: 'кладёт сообщение в журнал и сразу подтверждает', cdn: 'отдаёт файл из кэша ближайшей точки, при промахе — тянет из источника',
    objstore: 'отдаёт объект по ключу', search: 'ищет по обратному индексу', ws: 'держит соединение и доставляет сообщение', external: 'внешний сервис — его время мы не контролируем',
    olap: 'считает агрегат по колонкам', lake: 'читает файлы Parquet нужной папки', etl: 'везёт данные пачками', faas: 'облако поднимает функцию и выполняет её'
  };
  const skip = n => { const t = T()[n.type] || {}; return t.ops || n.type === 'cdc'; };

  /* ---------- модель: путь и время по узлам для одного вида запроса ---------- */
  function model(A, kind) {
    const L0 = A.level, g = A.graph;
    const L = Object.assign({}, L0, { traffic: { [kind]: L0.traffic[kind] } });
    const base = SD.sim.run(L, g, { mul: A.mul || 1, down: A.down || {} }), total = (base.kinds[kind] || {}).lat || 0;
    const v = r => (r.kinds[kind] || { lat: 0 }).lat;
    const cand = g.nodes.filter(n => n.type !== 'client' && !skip(n) && base.nodes[n.id] && base.nodes[n.id].rps > 0.001);
    const sub = {};
    cand.forEach(n => { sub[n.id] = Math.max(0, total - v(SD.sim.run(L, g, { mul: A.mul || 1, down: A.down || {}, sick: { [n.id]: { slow: 1e-6 } } }))); });
    const cl = g.nodes.find(n => n.type === 'client'), rps = (base.kinds[kind] || {}).rps || L.traffic[kind] || 1;
    const steps = [], seen = new Set();
    const walk = (id, depth) => {
      const kidsE = g.edges.filter(e => e.from === id && sub[e.to] !== undefined && base.edges[e.id] && ((base.edges[e.id].byKind || {})[kind] || 0) > 0.001);
      kidsE.forEach(e => {
        const n = g.nodes.find(x => x.id === e.to); if (!n || seen.has(n.id) || depth > 8) return;
        seen.add(n.id);
        const flow = (base.edges[e.id].byKind || {})[kind] || 0;
        const kidsSum = g.edges.filter(x => x.from === n.id && sub[x.to] !== undefined).reduce((s, x) => s + sub[x.to], 0);
        const share = Math.min(1, flow / rps), self = Math.max(0, sub[n.id] - kidsSum);
        steps.push({ n, depth, share, self: share > 0 ? self / share : 0, w: self, e, from: g.nodes.find(x => x.id === id) });
        walk(n.id, depth + 1);
      });
    };
    if (cl) walk(cl.id, 0);
    return { kind, total, steps, ok: (base.kinds[kind] || {}).success };
  }

  /* ---------- панель ---------- */
  let S = null, timer = 0;
  function open() {
    const A = SD.app.A;
    const kinds = Object.keys(A.level.traffic || {}).filter(k => A.level.traffic[k] > 0 && SD.KINDS[k] && !['bot', 'inject', 'job'].includes(k));
    if (!kinds.length || !A.graph.nodes.some(n => n.type !== 'client')) { SD.app.toast('Проследить нечего: поставь на площадку узлы и соедини их с «Пользователями».'); return; }
    S = { kinds, kind: kinds[0], i: 0, play: true, m: null, lv: A.level.id };
    S.m = model(A, S.kind);
    draw(); tick();
  }
  function close() { clearTimeout(timer); S = null; const p = $('trPanel'); if (p) p.hidden = true; const l = $('trLay'); if (l) l.innerHTML = ''; }
  function tick() { clearTimeout(timer); if (!S || !S.play) return; timer = setTimeout(() => { if (!S) return; if (S.i < S.m.steps.length) { S.i++; draw(); tick(); } else { S.play = false; draw(); } }, 1400); }
  function draw() {
    const wrap = $('canvasWrap'); if (!wrap || !S) return;
    let p = $('trPanel');
    if (!p) { p = document.createElement('div'); p.id = 'trPanel'; p.className = 'tr-panel'; wrap.appendChild(p); p.addEventListener('click', onClick); }
    const m = S.m, st = m.steps, cur = S.i > 0 ? st[S.i - 1] : null, A = SD.app.A;
    const sumSelf = st.reduce((s, x) => s + x.w, 0) || 1;
    let h = `<div class="tr-h"><b>Запрос под лупой</b><div class="seg">${S.kinds.map(k => `<button type="button" data-trk="${k}" aria-selected="${k === S.kind}">${esc(SD.KINDS[k].label)}</button>`).join('')}</div><button type="button" class="tr-x" data-trx title="Закрыть">×</button></div>`;
    h += `<div class="tr-step">${cur ? `<b>${S.i}. «${esc(nm(cur.n))}»</b><span>${esc(DOES[cur.n.type] || 'обрабатывает запрос')}.</span><small>${cur.share < 0.995 ? `Сюда доходит <b>${Math.round(cur.share * 100)} %</b> запросов${cur.from && cur.from.type === 'app' && cur.n.type === 'sql' && st.some(x => x.n.type === 'cache') ? ' — это промахи кэша' : ''}. ` : ''}В узле — ≈ <b>${F().ms(cur.self)}</b>${cur.share < 0.995 ? ` (в среднем на запрос — ${F().ms(cur.w)})` : ''}.</small>` : `<b>Старт</b><span>«Пользователи» отправляют ${esc(SD.KINDS[S.kind].label.toLowerCase())}. Дальше — по стрелкам схемы, шаг за шагом.</span>`}</div>`;
    h += '<div class="tr-wf">';
    let off = 0;
    st.forEach((x, i) => {
      const w = Math.max(1.5, x.w / sumSelf * 100);
      h += `<div class="tr-row ${i < S.i ? 'on' : ''} ${i === S.i - 1 ? 'cur' : ''}"><span class="tr-n" style="padding-left:${x.depth * 10}px">${esc(nm(x.n))}</span><span class="tr-bar"><i style="left:${off}%;width:${w}%"></i></span><span class="tr-ms">${F().ms(x.w)}</span></div>`;
      off = Math.min(98, off + w);
    });
    h += `</div><div class="tr-foot"><span>Всего ≈ <b>${F().ms(m.total)}</b> · успешно ${F().pct(m.ok || 0)}</span><span class="tr-btns"><button type="button" class="btn ghost" data-tr="prev" ${S.i ? '' : 'disabled'}>←</button><button type="button" class="btn ${S.play ? '' : 'primary'}" data-tr="play">${S.play ? 'Пауза' : S.i >= st.length ? 'Сначала' : 'Пуск'}</button><button type="button" class="btn ghost" data-tr="next" ${S.i < st.length ? '' : 'disabled'}>→</button></span></div>`;
    p.innerHTML = h; p.hidden = false;
    ring(cur);
  }
  function ring(cur) {
    const wrap = $('canvasWrap'); let l = $('trLay');
    if (!l) { l = document.createElement('div'); l.id = 'trLay'; l.className = 'why-lay'; wrap.appendChild(l); }
    if (!cur) { l.innerHTML = ''; return; }
    const el = document.querySelector(`#nodesG .node[data-id="${cur.n.id}"]`); if (!el) { l.innerHTML = ''; return; }
    const wr = wrap.getBoundingClientRect(), q = (el.querySelector('.body') || el).getBoundingClientRect();
    l.innerHTML = `<div class="why-ring tr-ring" style="left:${q.left - wr.left - 6}px;top:${q.top - wr.top - 6}px;width:${q.width + 12}px;height:${q.height + 12}px"><span>${S.i} · ${esc(F().ms(cur.self))}</span></div>`;
  }
  function onClick(e) {
    if (!S) return;
    if (e.target.closest('[data-trx]')) { close(); return; }
    const k = e.target.closest('[data-trk]'); if (k) { S.kind = k.dataset.trk; S.i = 0; S.play = true; S.m = model(SD.app.A, S.kind); draw(); tick(); return; }
    const b = e.target.closest('[data-tr]'); if (!b) return;
    const a = b.dataset.tr;
    if (a === 'prev' && S.i > 0) { S.i--; S.play = false; }
    else if (a === 'next' && S.i < S.m.steps.length) { S.i++; S.play = false; }
    else if (a === 'play') { if (S.play) S.play = false; else { if (S.i >= S.m.steps.length) S.i = 0; S.play = true; } }
    draw(); tick();
  }

  function mount() {
    setTimeout(() => {
      const menu = document.querySelector('.tb-menu');
      if (menu && !$('traceBtn')) { const b = document.createElement('button'); b.type = 'button'; b.id = 'traceBtn'; b.className = 'btn ghost tbm-it'; b.innerHTML = '<span>Проследить запрос</span>'; b.addEventListener('click', open); menu.insertBefore(b, menu.firstChild); }
    }, 0);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S) close(); });
    setInterval(() => { if (S && S.i > 0) ring(S.m.steps[S.i - 1]); }, 500);
    /* смена уровня — закрыть */
    setInterval(() => { const A = SD.app && SD.app.A; if (A && S && A.level.id !== S.lv) close(); }, 700);
  }
  SD.trace = { mount, open, close, model };
})();
