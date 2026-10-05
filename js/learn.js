/* Учимся на ошибках: «Почему красное?» у цели — виновники на схеме и правка, проверенная симулятором;
   прогноз перед проверкой. */
(function () {
  const T = () => SD.TYPES, F = () => SD.fmt;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const copy = g => JSON.parse(JSON.stringify(g));
  const isOps = n => !!(T()[n.type] && T()[n.type].ops);
  const scal = n => (((T()[n.type] || {}).props) || []).find(p => p.key === 'count' && p.type === 'range') || null;

  /* ---------- прогоны «что если» ---------- */
  function one(L, g, i) {
    const res = SD.sim.run(L, g, { mul: 1 }), lg = L.goals[i];
    const ch = lg.t === 'survive' ? SD.sim.chaos(L, g) : [];
    return { res, goal: SD.evalGoals(Object.assign({}, L, { goals: [lg] }), g, res, ch, SD.sim.analyze(L, g, res))[0] };
  }
  function every(L, g) {
    const res = SD.sim.run(L, g, { mul: 1 });
    return { res, goals: SD.evalGoals(L, g, res, SD.sim.chaos(L, g), SD.sim.analyze(L, g, res)) };
  }
  const latOf = lg => r => (!lg.kind || lg.kind === 'all') ? r.total.lat : (r.kinds[lg.kind] || { lat: Infinity }).lat;

  /* ---------- виновники ---------- */
  function hot(g, res) {
    return g.nodes.filter(n => n.type !== 'client' && !isOps(n) && res.nodes[n.id] && (res.nodes[n.id].dead || res.nodes[n.id].util > 1))
      .sort((a, b) => (res.nodes[b.id].dead ? 99 : res.nodes[b.id].util) - (res.nodes[a.id].dead ? 99 : res.nodes[a.id].util))
      .map(n => ({ id: n.id, tag: res.nodes[n.id].dead ? 'лежит' : `перегружен: ${Math.round(res.nodes[n.id].util * 100)} %` }));
  }
  function badEdges(g, res) {
    const out = [];
    g.edges.forEach(e => {
      const r = res.edges[e.id], inf = r && r.info; if (!inf || !(r.flow > 0.001)) return;
      if (inf.open) out.push({ id: e.id, tag: 'предохранитель разомкнут' });
      else if (inf.tf > 0.02) out.push({ id: e.id, tag: `таймаут обрывает ${F().pct(inf.tf)}` });
      else if (inf.amp > 1.3) out.push({ id: e.id, tag: `повторы: нагрузка ×${inf.amp.toFixed(1).replace('.', ',')}` });
    });
    return out.slice(0, 3);
  }
  /* сколько миллисекунд добавляет сам узел: убираем задержку его поддерева и вычитаем вклад детей */
  function slow(L, g, i, res) {
    const v = latOf(L.goals[i]), base = v(res);
    const cand = g.nodes.filter(n => n.type !== 'client' && !isOps(n) && res.nodes[n.id] && res.nodes[n.id].rps > 0.001);
    const sub = {};
    cand.forEach(n => { sub[n.id] = Math.max(0, base - v(SD.sim.run(L, g, { mul: 1, sick: { [n.id]: { slow: 1e-6 } } }))); });
    const stuck = base >= SD.sim.TIMEOUT * 0.95;
    return { base, list: cand.map(n => {
      const kids = g.edges.filter(e => e.from === n.id && sub[e.to] !== undefined && res.edges[e.id] && res.edges[e.id].flow > 0.001).reduce((s, e) => s + sub[e.to], 0);
      return { id: n.id, ms: Math.max(0, sub[n.id] - kids) };
    }).sort((a, b) => b.ms - a.ms).filter(x => x.ms >= Math.max(3, base * 0.08)).slice(0, 3).map(x => Object.assign(x, { tag: stuck ? 'здесь запросы застревают до таймаута' : `≈${F().ms(x.ms)} из ${F().ms(base)}` })) };
  }

  /* ---------- правки, которые проверяем симулятором ---------- */
  /* рычаги ёмкости: экземпляры, реплики, шарды, партиции, GPU, узлы */
  const CAP = ['count', 'replicas', 'shards', 'partitions', 'gpus', 'nodes'];
  const levers = n => (((T()[n.type] || {}).props) || []).filter(p => p.type === 'range' && CAP.includes(p.key));
  const valOf = (n, p) => n.props[p.key] !== undefined ? n.props[p.key] : (p.def !== undefined ? p.def : p.min);
  /* насколько цель далека от выполнения: меньше — лучше */
  function gap(L, i, r) {
    const lg = L.goals[i], over = Object.values(r.res.nodes).reduce((s, x) => s + Math.max(0, (x.util || 0) - 1), 0);
    if (r.goal.ok) return -1;
    if (lg.t === 'success') { const ks = Object.keys(L.traffic).filter(k => k !== 'bot' && L.traffic[k] > 0); return 1 - Math.min(...ks.map(k => r.res.kinds[k] ? r.res.kinds[k].success : 1)) + over * 1e-3; }
    if (lg.t === 'latency') return latOf(lg)(r.res) / Math.max(1, lg.max) + over * 1e-3;
    return over + 1e-3;
  }
  function scaleFix(L, G, i) {
    const g = copy(G), ch = {};
    let r = one(L, g, i), cur = gap(L, i, r);
    for (let it = 0; it < 14; it++) {
      if (r.goal.ok) return Object.keys(ch).length ? Object.values(ch) : null;
      /* кандидаты: три самых загруженных узла × их рычаги × шаг (+1, умеренный, по загрузке) */
      const hots = g.nodes.filter(n => n.type !== 'client' && !isOps(n) && r.res.nodes[n.id] && r.res.nodes[n.id].util > 0.85 && levers(n).some(p => valOf(n, p) < p.max))
        .sort((a, b) => r.res.nodes[b.id].util - r.res.nodes[a.id].util).slice(0, 3);
      let best = null;
      hots.forEach(h => {
        const u = r.res.nodes[h.id].util;
        levers(h).forEach(p => {
          const v0 = valOf(h, p); if (v0 >= p.max) return;
          const base = Math.max(v0, 1);
          const vals = [...new Set([v0 + 1, Math.ceil(base * Math.min(u, 2) / 0.75), Math.ceil(base * u / 0.75)].map(v => Math.min(p.max, Math.max(v0 + 1, v))))];
          vals.forEach(nv => {
            h.props[p.key] = nv;
            const t = one(L, g, i), gp = gap(L, i, t);
            h.props[p.key] = v0;
            const cand = { h, p, v0, nv, gp, t, cost: t.res.cost };
            if (gp < cur - 1e-6 && (!best || gp < best.gp - 1e-6 || (Math.abs(gp - best.gp) <= 1e-6 && cand.cost < best.cost))) best = cand;
          });
        });
      });
      if (!best) return null;
      const k = best.h.id + '|' + best.p.key;
      ch[k] = { id: best.h.id, key: best.p.key, label: best.p.label, from: ch[k] ? ch[k].from : best.v0, to: best.nv };
      best.h.props[best.p.key] = best.nv; r = best.t; cur = best.gp;
    }
    return null;
  }
  function surviveFix(L, G, i) {
    const g = copy(G), chs = [];
    const lg = L.goals[i], bad = SD.sim.chaos(L, g).filter(c => !c.ok && (lg.types === 'all' || (lg.types || []).includes(c.type)));
    for (const c of bad) {
      const n = g.nodes.find(x => x.id === c.id), d = n && scal(n); if (!d) continue;
      const from = n.props.count || 1;
      /* запасной должен ещё и выдержать нагрузку упавшего соседа */
      for (let v = Math.max(2, from + 1); v <= Math.min(d.max, from + 4); v++) {
        n.props.count = v;
        if (!SD.sim.chaos(L, g).some(x => x.id === n.id && !x.ok)) break;
      }
      if (n.props.count !== from) chs.push({ id: n.id, key: 'count', from, to: n.props.count });
      if (one(L, g, i).goal.ok) return chs;
    }
    return chs.length && one(L, g, i).goal.ok ? chs : null;
  }
  function costFix(L, G, i) {
    const g = copy(G), base = every(L, g), keep = base.goals.map((x, j) => j !== i && x.ok), chs = [];
    g.nodes.filter(n => scal(n) && (n.props.count || 1) > 1)
      .sort((a, b) => ((base.res.nodes[b.id] || {}).cost || 0) - ((base.res.nodes[a.id] || {}).cost || 0))
      .forEach(n => {
        /* меньше всего экземпляров, при которых остальные цели не краснеют: делим пополам */
        const from = n.props.count, fine = c => { n.props.count = c; return every(L, g).goals.every((x, j) => !keep[j] || x.ok); };
        let lo = 1, hi = from;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fine(mid)) hi = mid; else lo = mid + 1; }
        const best = lo < from && fine(lo) ? lo : from;
        n.props.count = best;
        if (best < from) chs.push({ id: n.id, key: 'count', from, to: best });
      });
    return chs.length ? chs : null;
  }

  const AN = {
    success: 'Как касса в магазине: если покупатели подходят быстрее, чем кассир пробивает, очередь растёт и часть уходит ни с чем. Здесь так теряются запросы:',
    latency: 'Время ответа — как дорога с остановками: складываются все остановки по пути. Дольше всего запрос стоит здесь:',
    cost: 'Как счёт за коммуналку: сначала смотрят, что тратит больше всего. Больше всего стоят:',
    survive: 'Как мост на одной опоре: убери её — и всё рухнет. Без запасного здесь:',
    jobs: 'Как гора посуды: если моют медленнее, чем пачкают, она только растёт. Не успевают:'
  };
  const REM = {
    sql: 'Поставь кэш между сервисом и базой или индекс под частый запрос: повторные чтения перестанут доходить до базы.',
    nosql: 'Кэш перед хранилищем или ключ, по которому запрос идёт в одну партицию, а не во все.',
    external: 'Внешний сервис не ускорить: кэшируй его ответы или вызывай асинхронно через очередь.',
    llm: 'Кэш ответов модели, модель поменьше или ответ потоком.',
    app: 'Больше экземпляров или меньше последовательных вызовов внутри одного запроса.',
    gateway: 'Больше экземпляров шлюза или меньше проверок на каждом запросе.',
    cache: 'Больше памяти кэша: больше попаданий, меньше походов дальше.'
  };

  /* ---------- разбор одной цели ---------- */
  function analyze(L, G, i) {
    const r0 = every(L, G), res = r0.res, goal = r0.goals[i], lg = L.goals[i];
    const out = { t: lg.t, ok: goal.ok, marks: [], emarks: [], an: AN[lg.t] || 'Где искать проблему:', lines: [], fix: null, rem: '' };
    if (goal.ok) return out;
    let t = lg.t;
    if (t === 'latency' && latOf(lg)(res) <= lg.max) t = 'success';
    if (t === 'latency') {
      const s = slow(L, G, i, res); out.marks = s.list;
      out.emarks = badEdges(G, res);
      const top = s.list[0] && G.nodes.find(n => n.id === s.list[0].id);
      if (top) out.rem = REM[top.type] || 'Двойной клик по узлу покажет, что у него внутри и где он тратит время.';
      out.fix = scaleFix(L, G, i);
    } else if (t === 'cost') {
      const total = res.cost || 1;
      out.marks = G.nodes.filter(n => (res.nodes[n.id] || {}).cost > 0).sort((a, b) => res.nodes[b.id].cost - res.nodes[a.id].cost).slice(0, 3)
        .map(n => ({ id: n.id, tag: `${F().usd(res.nodes[n.id].cost)} · ${Math.round(res.nodes[n.id].cost / total * 100)} %` }));
      out.fix = costFix(L, G, i);
      if (!out.fix) out.rem = 'Лишних экземпляров нет: ищи компоненты подешевле (управляемый сервис, меньше памяти) или убери то, без чего цели выполняются.';
    } else if (t === 'survive') {
      out.marks = SD.sim.chaos(L, G).filter(c => !c.ok && (lg.types === 'all' || (lg.types || []).includes(c.type))).slice(0, 3).map(c => ({ id: c.id, tag: `упадёт — успешно ${F().pct(c.success)}` }));
      out.fix = surviveFix(L, G, i);
      if (!out.fix) out.rem = 'Нужен запасной: второй экземпляр за балансировщиком, реплика базы с переключением или очередь, которая подождёт.';
    } else {
      out.marks = hot(G, res).slice(0, 3); out.emarks = badEdges(G, res);
      out.fix = scaleFix(L, G, i);
    }
    const adv = (SD.sim.advise(L, G, res, SD.sim.analyze(L, G, res)) || []).filter(a => a.sev === 'bad');
    const marked = new Set(out.marks.map(m => m.id));
    adv.filter(a => !a.node || marked.has(a.node) || !out.marks.length).slice(0, 2).forEach(a => {
      out.lines.push(a.text);
      if (a.node && !marked.has(a.node) && out.marks.length < 3) { out.marks.push({ id: a.node, tag: 'тут проблема' }); marked.add(a.node); }
    });
    if (!out.marks.length && !out.lines.length) out.lines.push(goal.detail);
    if (!out.fix && !out.rem) {
      const p = L.pattern && (SD.PATTERNS || []).find(x => x.id === L.pattern);
      out.rem = lg.t === 'diagnose' ? 'Сначала ответь на вопрос «Что сломано?» выше: эта цель про диагноз, а не про схему.'
        : p ? `Эта цель — про паттерн «${p.name}». Его карточка выше: что поставить, как соединить и почему.`
        : (L.hints && L.hints.length) ? 'Открой подсказку ниже: прораб скажет, с чего начать.' : 'Нажми на отмеченный узел — в настройках видно, что с ним не так.';
    }
    if (out.fix) {
      const g = copy(G); out.fix.forEach(c => { g.nodes.find(n => n.id === c.id).props[c.key] = c.to; });
      const after = every(L, g);
      out.fixInfo = { cost: [res.cost, after.res.cost], ok: after.goals[i].ok, broke: after.goals.filter((x, j) => !x.ok && r0.goals[j].ok).map(x => x.text) };
    }
    return out;
  }

  /* ---------- состояние открытого разбора ---------- */
  let cur = null, memo = { k: '', v: null };
  const sig = (A, i) => A.level.id + '|' + i + '|' + JSON.stringify(A.graph.nodes.map(n => [n.id, n.type, n.props])) + JSON.stringify(A.graph.edges.map(e => [e.from, e.to, e.props]));
  function get(A, i) {
    const k = sig(A, i);
    if (memo.k !== k) { let v = null; try { v = analyze(A.level, A.graph, i); } catch (e) { v = null; } memo = { k, v }; }
    return memo.v;
  }
  const isCur = (A, i) => cur && cur.lv === A.level.id && cur.i === i;

  /* кнопка у красной цели и блок разбора под ней (вызывает panels.task) */
  function goalExtra(A, i) {
    const g = A.goals && A.goals[i]; if (!g || g.ok || A.level.sandbox || (SD.free && !SD.free.hintsOn())) return '';
    const open = isCur(A, i);
    let h = `<button type="button" class="why-btn ${open ? 'on' : ''}" data-why="${i}" aria-expanded="${open}">${open ? 'Скрыть' : 'Почему?'}</button>`;
    if (!open) return h;
    const w = get(A, i);
    if (!w) return h + '<div class="why-box"><p>Не получилось разобрать эту цель автоматически — посмотри советы прораба ниже.</p></div>';
    h += `<div class="why-box"><p class="why-an">${esc(w.an)}</p>`;
    if (w.marks.length || w.emarks.length) {
      h += '<ul class="why-list">';
      w.marks.forEach(m => { const n = A.graph.nodes.find(x => x.id === m.id); if (n) h += `<li><button type="button" class="linkish" data-sel="${m.id}">«${esc(nm(n))}»</button> — ${esc(m.tag)}</li>`; });
      w.emarks.forEach(m => { const e = A.graph.edges.find(x => x.id === m.id); if (!e) return; const a = A.graph.nodes.find(x => x.id === e.from), b = A.graph.nodes.find(x => x.id === e.to); h += `<li><button type="button" class="linkish" data-sele="${m.id}">связь «${esc(nm(a))}» → «${esc(nm(b))}»</button> — ${esc(m.tag)}</li>`; });
      h += '</ul>';
    }
    w.lines.forEach(l => { h += `<p class="why-ln">${esc(l)}</p>`; });
    if (w.fix) {
      const fi = w.fixInfo || {};
      const lbl = w.fix.map(c => { const n = A.graph.nodes.find(x => x.id === c.id); return `«${esc(nm(n))}»${c.key === 'count' ? '' : ' · ' + esc((c.label || c.key).toLowerCase())}: ${c.from} → ${c.to}${c.key === 'count' ? ' экз.' : ''}`; }).join(', ');
      h += `<div class="why-fix"><b>Проверил на симуляторе:</b> <span>${lbl}</span>`;
      h += `<small>${fi.ok ? 'эта цель станет зелёной' : 'станет лучше, но не до конца'} · в месяц ${F().usd(fi.cost[0])} → ${F().usd(fi.cost[1])}${fi.broke && fi.broke.length ? ` · но покраснеет: ${esc(fi.broke.join('; ').toLowerCase())}` : ''}</small>`;
      h += `<button type="button" class="btn primary" data-whyfix="${i}">Применить</button></div>`;
    } else if (w.rem) h += `<div class="why-fix rem"><b>Что попробовать:</b> <span>${esc(w.rem)}</span></div>`;
    return h + '</div>';
  }

  /* ---------- отметки на холсте ---------- */
  function draw() {
    const wrap = document.getElementById('canvasWrap'), A = SD.app && SD.app.A; if (!wrap || !A) return;
    let lay = document.getElementById('whyLay');
    if (!lay) { lay = document.createElement('div'); lay.id = 'whyLay'; lay.className = 'why-lay'; wrap.appendChild(lay); }
    document.querySelectorAll('#edgesG .why-edge').forEach(x => x.classList.remove('why-edge'));
    const w = cur && cur.lv === A.level.id && A.goals && A.goals[cur.i] && !A.goals[cur.i].ok ? get(A, cur.i) : null;
    if (!w) { if (lay.childElementCount) lay.innerHTML = ''; return; }
    const wr = wrap.getBoundingClientRect();
    let h = '';
    w.marks.forEach(m => {
      const el = document.querySelector(`#nodesG .node[data-id="${m.id}"]`); if (!el || el.classList.contains('l-hide')) return;
      const q = (el.querySelector('.body') || el).getBoundingClientRect();
      h += `<div class="why-ring" style="left:${q.left - wr.left - 6}px;top:${q.top - wr.top - 6}px;width:${q.width + 12}px;height:${q.height + 12}px"><span>${esc(m.tag)}</span></div>`;
    });
    w.emarks.forEach(m => {
      const el = document.querySelector(`#edgesG [data-edge="${m.id}"]`); if (!el) return;
      el.classList.add('why-edge');
      const q = el.getBoundingClientRect();
      h += `<div class="why-etag" style="left:${q.left - wr.left + q.width / 2}px;top:${q.top - wr.top + q.height / 2}px">${esc(m.tag)}</div>`;
    });
    if (lay.innerHTML !== h) lay.innerHTML = h;
  }

  function rerender() { const A = SD.app && SD.app.A; if (A && A.tab === 'task') SD.panels.task(A); draw(); }
  function toggle(i) {
    const A = SD.app.A;
    cur = isCur(A, i) ? null : { lv: A.level.id, i };
    rerender();
  }
  function applyFix(i) {
    const A = SD.app.A, w = get(A, i); if (!w || !w.fix) return;
    w.fix.forEach(c => SD.app.setProp(c.id, c.key, c.to));
    const g = A.goals[i];
    SD.app.toast(g && g.ok ? 'Готово: цель выполнена. Посмотри в «Что изменилось», почему это сработало.' : 'Правка применена. Смотри, что ещё осталось красным.');
  }

  /* ---------- прогноз перед проверкой ---------- */
  const KEY = 'amp-stroyka-learn-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  U.pred = U.pred || { n: 0, hit: 0 }; U.tries = U.tries || {};
  let bypass = false, lastSig = '';
  const gsig = A => A.level.id + JSON.stringify(A.graph.nodes.map(n => [n.type, n.props])) + JSON.stringify(A.graph.edges.map(e => [e.from, e.to, e.props]));
  function shouldAsk(A) {
    if (U.predOff || A.level.sandbox || A.level.interview) return false;
    if (!A.graph.nodes.some(n => n.type !== 'client' && !(A.level.preset || []).some(p => p[0] === n.id))) return false;
    return gsig(A) !== lastSig;
  }
  function pop() {
    let p = document.getElementById('predPop');
    if (!p) { p = document.createElement('div'); p.id = 'predPop'; p.className = 'pred-pop'; p.hidden = true; document.body.appendChild(p); }
    const b = document.getElementById('checkBtn').getBoundingClientRect();
    p.style.top = (b.bottom + 8) + 'px'; p.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    return p;
  }
  let popT = 0;
  function ask() {
    const p = pop(); clearTimeout(popT);
    p.innerHTML = `<b>Сначала прогноз</b><span>Как думаешь, схема пройдёт все цели? Угадывать полезно: так видно, где интуиция расходится с системой.</span><div class="pred-act"><button type="button" class="btn primary" data-pred="1">Пройдёт</button><button type="button" class="btn" data-pred="0">Не пройдёт</button></div><div class="pred-sub"><button type="button" class="linkish" data-pred="skip">Проверить без прогноза</button><button type="button" class="linkish" data-pred="off">Не спрашивать</button></div>`;
    p.hidden = false;
  }
  function record(A) {
    const r = A.res1; if (!r) return;
    const t = U.tries[A.level.id] = (U.tries[A.level.id] || []).slice(-11);
    t.push({ c: Math.round(r.cost), l: Math.round(r.total.lat), s: +r.total.success.toFixed(4), ok: A.goals.every(x => x.ok) ? 1 : 0 });
    save();
    if (A.tab === 'task') SD.panels.task(A);
  }
  function runCheck(pred) {
    const A = SD.app.A, p = pop();
    lastSig = gsig(A); bypass = true; document.getElementById('checkBtn').click(); bypass = false;
    if (pred === null) { p.hidden = true; return; }
    const ok = A.goals.every(x => x.ok), hit = (pred === 1) === ok;
    U.pred.n++; if (hit) U.pred.hit++; save();
    const bad = A.goals.filter(x => !x.ok).length;
    p.innerHTML = `<b>${hit ? 'Прогноз верный ✓' : 'Прогноз не совпал'}</b><span>${ok ? (hit ? 'Схема выдержала, как ты и думал.' : 'Схема крепче, чем казалось: загляни в «Метрики» — какой там запас.') : (hit ? `Как и ожидал: красных целей ${bad}.` : `Красных целей: ${bad}.`) + ' Нажми «Почему?» у красной цели — покажу виновника на схеме.'}</span><small>Точность прогнозов: ${U.pred.hit} из ${U.pred.n}</small>`;
    p.hidden = false;
    clearTimeout(popT); popT = setTimeout(() => { p.hidden = true; }, 7000);
  }

  function mount() {
    document.addEventListener('click', e => {
      const w = e.target.closest('[data-why]'); if (w) { toggle(+w.dataset.why); return; }
      const f = e.target.closest('[data-whyfix]'); if (f) { applyFix(+f.dataset.whyfix); return; }
      const pr = e.target.closest('[data-pred]');
      if (pr) { const v = pr.dataset.pred; if (v === 'off') { U.predOff = true; save(); runCheck(null); } else runCheck(v === 'skip' ? null : +v); return; }
      const p = document.getElementById('predPop'); if (p && !p.hidden && !e.target.closest('#predPop') && !e.target.closest('#checkBtn')) p.hidden = true;
    });
    const cb = document.getElementById('checkBtn');
    if (cb) {
      cb.addEventListener('click', e => {
        const A = SD.app && SD.app.A; if (!A || bypass) return;
        if (shouldAsk(A)) { e.stopImmediatePropagation(); ask(); return; }
        const p = document.getElementById('predPop'); if (p) p.hidden = true;
      }, true);
      /* после обработчика проверки: цифры уже пересчитаны — запоминаем попытку */
      cb.addEventListener('click', () => { const A = SD.app && SD.app.A; if (A && !A.level.sandbox) record(A); });
    }
    setInterval(draw, 400);
    window.addEventListener('resize', () => setTimeout(draw, 60));
  }

  SD.learn = { mount, analyze, goalExtra, tries: id => (U.tries[id] || []).slice(), close: () => { cur = null; draw(); } };
})();
