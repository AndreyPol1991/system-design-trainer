/* Эталон по шагам: решение собирается на площадке по одному узлу; у каждого шага — что это, зачем
   и что поменялось в цифрах. В любой момент можно «Достроить сам» или вернуть свою схему.
   И график «Твои попытки и эталон»: цена против времени ответа. */
(function () {
  const T = () => SD.TYPES, F = () => SD.fmt;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const nm = n => n ? (n.label || T()[n.type].name) : '';

  /* ---------- схема на шаге k ---------- */
  function orderOf(L, spec) {
    const placed = new Set((L.preset || []).map(p => p[0]));
    const rest = spec.nodes.filter(n => !placed.has(n[0])), out = [];
    while (rest.length) {
      /* сначала тот, к кому ведёт стрелка от уже поставленного, потом тот, кто сам их вызывает */
      let i = rest.findIndex(n => spec.edges.some(([a, b]) => b === n[0] && placed.has(a)));
      if (i < 0) i = rest.findIndex(n => spec.edges.some(([a, b]) => a === n[0] && placed.has(b)));
      if (i < 0) i = 0;
      const n = rest.splice(i, 1)[0]; out.push(n); placed.add(n[0]);
    }
    return out;
  }
  function build(L, spec, order, k) {
    const nodes = [], edges = [];
    const add = ([id, type, x, y, props, label]) => {
      if (nodes.some(n => n.id === id)) return;
      nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props ? JSON.parse(JSON.stringify(props)) : {}), label: label || (type === 'external' && L.ext ? L.ext.name : undefined) });
    };
    (L.preset || []).forEach(add);
    order.slice(0, k).forEach(add);
    const have = new Set(nodes.map(n => n.id));
    spec.edges.forEach(([a, b, p], i) => { if (have.has(a) && have.has(b)) edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) }); });
    const g = { nodes, edges };
    if (SD.inner) g.nodes.forEach(n => SD.inner.syncFlags(n, g));
    return g;
  }
  function measure(L, g) {
    const res = SD.sim.run(L, g, { mul: 1 }), an = SD.sim.analyze(L, g, res);
    const goals = SD.evalGoals(L, g, res, SD.sim.chaos(L, g), an);
    let pats = [];
    try { pats = SD.archLens ? [...new Set(SD.archLens.detect(g, res).applied.map(p => p.id))] : []; } catch (e) { pats = []; }
    return { g, res, goals, pats };
  }

  /* ---------- что объясняем на шаге ---------- */
  function propsText(n) {
    const t = T()[n.type], d = SD.defaultsFor(n.type), out = [];
    (t.props || []).forEach(p => {
      const v = n.props[p.key]; if (v === undefined || JSON.stringify(v) === JSON.stringify(d[p.key])) return;
      if (p.type === 'range') out.push(`${p.label}: ${v}`);
      else if (p.type === 'select') { const o = (p.options || []).find(x => String(x[0]) === String(v)); out.push(`${p.label}: ${o ? o[1] : v}`); }
      else if (p.type === 'toggle') out.push(`${p.label}: ${v ? 'да' : 'нет'}`);
    });
    return out;
  }
  const pname = id => ((SD.PATTERNS || []).find(p => p.id === id) || {}).name || id;
  function stepHtml(W, k) {
    const s = W.steps[k], K = W.order.length;
    if (k === 0) {
      const bad = s.goals.filter(x => !x.ok).length;
      return `<b class="walk-t">Старт: только то, что дано в задании</b><p>Целей не выполнено: ${bad} из ${s.goals.length}. Дальше эталон соберётся по одному узлу — смотри, что меняет каждый.</p>`;
    }
    const p = W.steps[k - 1], spec = W.order[k - 1], n = s.g.nodes.find(x => x.id === spec[0]), t = T()[n.type];
    let h = `<b class="walk-t">«${esc(nm(n))}»</b><p class="walk-s">${esc(t.short || '')}</p>`;
    const pr = propsText(n); if (pr.length) h += `<p class="walk-p">Настройки: ${esc(pr.join(' · '))}</p>`;
    const newE = s.g.edges.filter(e => !p.g.edges.some(x => x.id === e.id)).map(e => `«${nm(s.g.nodes.find(x => x.id === e.from))}» → «${nm(s.g.nodes.find(x => x.id === e.to))}»`);
    if (newE.length) h += `<p class="walk-p">Связи: ${esc(newE.join(', '))}</p>`;
    /* цифры до и после */
    const a = p.res.total, b = s.res.total, ch = [];
    if (Math.abs(b.success - a.success) > 0.002) ch.push(`успешно ${F().pct(a.success)} → <b>${F().pct(b.success)}</b>`);
    if (a.success > 0.01 && b.success > 0.01 && Math.abs(b.lat - a.lat) > Math.max(2, a.lat * 0.05)) ch.push(`время ${F().ms(a.lat)} → <b>${F().ms(b.lat)}</b>`);
    if (Math.abs(s.res.cost - p.res.cost) > 1) ch.push(`в месяц ${F().usd(p.res.cost)} → <b>${F().usd(s.res.cost)}</b>`);
    if (ch.length) h += `<p class="walk-num">${ch.join(' · ')}</p>`;
    const won = s.goals.filter((x, j) => x.ok && !p.goals[j].ok).map(x => x.text), lost = s.goals.filter((x, j) => !x.ok && p.goals[j].ok).map(x => x.text);
    const pats = s.pats.filter(x => !p.pats.includes(x)).map(pname);
    let why;
    if (a.success < 0.01 && b.success > 0.01) why = 'Без него запросам было некуда идти: путь замкнулся.';
    else if (a.success < 0.01 && b.success < 0.01 && k < K) why = 'Запросам пока некуда идти дальше: это подготовка к следующему шагу.';
    else if (b.success - a.success > 0.002) why = 'Без него часть запросов терялась.';
    else if (a.success > 0.01 && b.lat < a.lat * 0.8) why = 'С ним ответ заметно быстрее.';
    else if (won.length) why = 'Цифры почти те же, но закрылась цель.';
    else if (!ch.length) why = k < K ? 'Пока цифры не изменились: это подготовка к следующему шагу.' : 'На цифры не влияет, но без него эталон не полный.';
    else why = '';
    if (why) h += `<p class="walk-why">${esc(why)}</p>`;
    if (won.length) h += `<p class="walk-ok">✓ ${esc(won.join('; '))}</p>`;
    if (lost.length) h += `<p class="walk-bad">· пока красное: ${esc(lost.join('; ').toLowerCase())}</p>`;
    if (pats.length) h += `<p class="walk-pat">Появился паттерн: ${esc(pats.join(', '))}</p>`;
    if (k === K && W.L.solution.note) h += `<p class="walk-note">${esc(W.L.solution.note)}</p>`;
    return h;
  }

  /* ---------- режим ---------- */
  let W = null;
  function start() {
    const A = SD.app && SD.app.A; if (!A) return;
    const L = A.level;
    if (!L.solution) { SD.app.toast(L.interview ? 'На собеседовании эталона нет: он откроется в разборе после завершения.' : 'В песочнице эталона нет.'); return; }
    if (SD.bridge) SD.bridge.peek(L);
    const order = orderOf(L, L.solution);
    W = { L, order, k: 0, snap: JSON.parse(JSON.stringify(A.graph)), steps: [] };
    for (let k = 0; k <= order.length; k++) W.steps.push(measure(L, build(L, L.solution, order, k)));
    const bub = $('mBubble'); if (bub) bub.hidden = true;
    show(order.length, true); show(0);
  }
  function show(k, fitOnly) {
    const A = SD.app.A;
    A.graph = build(W.L, W.L.solution, W.order, k);
    A.down = {}; A.sel = null; A.pending = null;
    SD.editor.setGraph(A.graph);
    if (fitOnly) { SD.editor.fit(); return; }
    W.k = k;
    if (A.tab !== 'task') $('tabTask').click();
    SD.app.recompute(true);
    const c = document.querySelector('#paneTask .walk-pane'); if (c) c.scrollIntoView({ block: 'nearest' });
  }
  /* карточка шага — сверху вкладки «Задание»: схема остаётся открытой, цели видны прямо под ней */
  function paneHtml() {
    if (!W) return '';
    const K = W.order.length, last = W.k === K;
    return `<div class="walk-card walk-pane"><div class="walk-h"><span class="walk-e">Эталон по шагам</span><span class="walk-n">шаг ${W.k} из ${K}</span><button type="button" class="walk-x" data-walk="restore" title="Вернуть мою схему">×</button></div>
      <div class="walk-dots">${W.steps.map((_, i) => `<button type="button" class="${i === W.k ? 'on' : i < W.k ? 'past' : ''}" data-walk="go" data-k="${i}" aria-label="Шаг ${i}"></button>`).join('')}</div>
      <div class="walk-b">${stepHtml(W, W.k)}</div>
      <div class="walk-act"><button type="button" class="btn" data-walk="prev" ${W.k ? '' : 'disabled'}>←</button>${last ? '<button type="button" class="btn primary" data-walk="keep">Оставить эталон</button>' : '<button type="button" class="btn primary" data-walk="next">Дальше →</button>'}${last ? '' : '<button type="button" class="btn ghost" data-walk="self" title="Оставить то, что уже собрано, и доделать самому">Достроить сам</button>'}<button type="button" class="btn ghost" data-walk="restore">Вернуть мою схему</button></div></div>`;
  }
  function end(how) {
    if (!W) return;
    const A = SD.app.A, w = W; W = null;
    const lay = $('walkLay'); if (lay) lay.innerHTML = '';
    if (A.tab === 'task') SD.panels.task(A);
    if (how === 'restore' && A.level.id === w.L.id) {
      A.graph = w.snap; A.down = {}; A.sel = null; A.pending = null;
      SD.editor.setGraph(A.graph); SD.app.recompute(true);
      requestAnimationFrame(() => SD.editor.fit());
      SD.app.toast('Твоя схема вернулась.');
    } else if (how === 'self') SD.app.toast('Дальше сам: добавь то, чего не хватает. Красные цели подскажут, а «Почему?» покажет виновника.');
    else if (how === 'keep') SD.app.toast('Эталон на площадке. Попробуй его улучшить: дешевле или быстрее.');
  }
  function onClick(e) {
    const b = e.target.closest('[data-walk]'); if (!b || !W) return;
    const a = b.dataset.walk, K = W.order.length;
    if (a === 'next' && W.k < K) show(W.k + 1);
    else if (a === 'prev' && W.k > 0) show(W.k - 1);
    else if (a === 'go') show(Math.max(0, Math.min(K, +b.dataset.k)));
    else end(a);
  }

  /* новый узел шага — в зелёной рамке */
  function draw() {
    const wrap = $('canvasWrap'); if (!wrap) return;
    let lay = $('walkLay');
    if (!W) { if (lay && lay.childElementCount) lay.innerHTML = ''; return; }
    const A = SD.app.A;
    if (A.level.id !== W.L.id) { W = null; if (lay) lay.innerHTML = ''; return; }
    const bub = $('mBubble'); if (bub && !bub.hidden) bub.hidden = true;
    if (!lay) { lay = document.createElement('div'); lay.id = 'walkLay'; lay.className = 'why-lay'; wrap.appendChild(lay); }
    const spec = W.k ? W.order[W.k - 1] : null, el = spec && document.querySelector(`#nodesG .node[data-id="${spec[0]}"]`);
    let h = '';
    if (el) {
      const wr = wrap.getBoundingClientRect(), q = (el.querySelector('.body') || el).getBoundingClientRect();
      h = `<div class="why-ring walk-ring" style="left:${q.left - wr.left - 6}px;top:${q.top - wr.top - 6}px;width:${q.width + 12}px;height:${q.height + 12}px"><span>шаг ${W.k}</span></div>`;
    }
    if (lay.innerHTML !== h) lay.innerHTML = h;
  }

  /* ---------- график «Твои попытки и эталон» ---------- */
  const refMemo = {};
  function refStats(L) {
    if (!refMemo[L.id]) { const o = orderOf(L, L.solution), r = SD.sim.run(L, build(L, L.solution, o, o.length), { mul: 1 }); refMemo[L.id] = { c: r.cost, l: r.total.lat }; }
    return refMemo[L.id];
  }
  function compareHtml(A) {
    const L = A.level; if (!L.solution || L.sandbox || L.interview || !SD.learn) return '';
    const tries = SD.learn.tries(L.id); if (!tries.length) return '';
    const ref = refStats(L), gc = (L.goals || []).find(g => g.t === 'cost'), gl = (L.goals || []).find(g => g.t === 'latency');
    const cap = Math.max(gl ? gl.max * 3 : 0, ref.l * 4, 60);
    const W0 = 300, H0 = 176, pl = 46, pr = 12, pt = 12, pb = 30;
    const x1 = Math.max(...tries.map(t => t.c), ref.c, gc ? gc.max : 0, 1) * 1.12;
    const y1 = Math.max(...tries.map(t => Math.min(t.l, cap)), ref.l, gl ? gl.max : 0, 1) * 1.15;
    const X = v => pl + v / x1 * (W0 - pl - pr), Y = v => H0 - pb - Math.min(v, y1) / y1 * (H0 - pb - pt);
    let s = `<svg class="cmp-svg" viewBox="0 0 ${W0} ${H0}" role="img" aria-label="Цена и время ответа: твои попытки и эталон">`;
    s += `<rect class="cmp-zone" x="${X(0)}" y="${Y(gl ? gl.max : y1)}" width="${X(gc ? gc.max : x1) - X(0)}" height="${Y(0) - Y(gl ? gl.max : y1)}"/>`;
    s += `<line class="cmp-ax" x1="${X(0)}" y1="${Y(0)}" x2="${W0 - pr}" y2="${Y(0)}"/><line class="cmp-ax" x1="${X(0)}" y1="${Y(0)}" x2="${X(0)}" y2="${pt}"/>`;
    if (gc) s += `<line class="cmp-goal" x1="${X(gc.max)}" y1="${pt}" x2="${X(gc.max)}" y2="${Y(0)}"/>`;
    if (gl) s += `<line class="cmp-goal" x1="${X(0)}" y1="${Y(gl.max)}" x2="${W0 - pr}" y2="${Y(gl.max)}"/>`;
    s += `<text class="cmp-lb" x="${X(0)}" y="${H0 - 8}">$0</text><text class="cmp-lb" x="${W0 - pr}" y="${H0 - 8}" text-anchor="end">${esc(F().usd(x1))} в месяц →</text>`;
    s += `<text class="cmp-lb" x="${pl - 6}" y="${Y(0)}" text-anchor="end">0</text><text class="cmp-lb" x="${pl - 6}" y="${pt + 8}" text-anchor="end">${esc(F().ms(y1))}</text>`;
    tries.forEach((t, i) => {
      const last = i === tries.length - 1;
      s += `<circle class="cmp-pt ${t.ok ? 'ok' : ''} ${last ? 'last' : ''}" cx="${X(t.c)}" cy="${Y(t.l)}" r="${last ? 6 : 4}"><title>попытка ${i + 1}: ${esc(F().usd(t.c))}, ${esc(F().ms(t.l))}</title></circle>`;
      if (t.l > y1) s += `<text class="cmp-lb" x="${X(t.c)}" y="${pt + 2}" text-anchor="middle">↑</text>`;
    });
    const lt = tries[tries.length - 1];
    s += `<text class="cmp-me" x="${X(lt.c) + 9}" y="${Y(lt.l) + 4}">ты</text>`;
    s += `<rect class="cmp-ref" x="${X(ref.c) - 5}" y="${Y(ref.l) - 5}" width="10" height="10" transform="rotate(45 ${X(ref.c)} ${Y(ref.l)})"/><text class="cmp-reft" x="${X(ref.c) + 9}" y="${Y(ref.l) - 6}">эталон</text>`;
    s += '</svg>';
    const dc = lt.c - ref.c, dl = lt.l - ref.l;
    const cap2 = `${Math.abs(dc) < 1 ? 'По цене — как эталон' : dc < 0 ? `Дешевле эталона на ${F().usd(-dc)}` : `Дороже эталона на ${F().usd(dc)}`}, ${Math.abs(dl) < 2 ? 'по времени — так же' : dl < 0 ? `быстрее на ${F().ms(-dl)}` : `медленнее на ${F().ms(dl)}`}. Зелёная зона — где выполнены цели по цене и времени.`;
    return `<details class="cmp-det" ${lt.ok ? 'open' : ''}><summary>Твои попытки и эталон · ${tries.length}</summary>${s}<p class="cmp-cap">${esc(cap2)}</p></details>`;
  }

  function mount() {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', e => {
      if (!W || e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight' && W.k < W.order.length) show(W.k + 1);
      else if (e.key === 'ArrowLeft' && W.k > 0) show(W.k - 1);
    });
    /* пункт в меню «⋯» рядом с «Показать эталон» */
    setTimeout(() => {
      const sol = $('solBtn'); if (!sol || $('walkBtn')) return;
      const b = document.createElement('button'); b.type = 'button'; b.id = 'walkBtn'; b.className = sol.className; b.textContent = 'Эталон по шагам';
      b.title = 'Эталон соберётся по одному узлу: что это, зачем и что поменялось. Твоя схема сохранится.';
      b.addEventListener('click', start);
      sol.parentNode.insertBefore(b, sol);
    }, 0);
    setInterval(draw, 400);
  }

  SD.walk = { mount, start, active: () => !!W, paneHtml, compareHtml, orderOf, build };
})();
