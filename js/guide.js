/* «Как устроен компонент»: работа узла или связи по шагам, настройки на пальцах,
   «сначала угадай» и сравнение вариантов на текущей схеме. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const F = () => SD.fmt;
  const G = { id: null, edge: null, key: null, job: 0, guess: null, show: false, rows: null, stress: null };
  const A = () => SD.app.A;
  const nodeOf = () => A().graph.nodes.find(n => n.id === G.id);
  const edgeOf = () => A().graph.edges.find(e => e.id === G.edge);
  const nm = n => n ? (n.label || SD.TYPES[n.type].name) : '';
  const visibleProps = n => (SD.TYPES[n.type].props || []).filter(d => !(d.feature && !(A().level.sandbox || (A().level.features || []).includes(d.feature))));
  function edgeDefs(e) {
    const g = A().graph, a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
    const k = a && b ? SD.edgeKind(a, b) : {};
    return (SD.EDGE_DEFS || []).filter(d => (d.need === 'proto' && k.proto) || (d.need === 'resil' && k.resil));
  }

  function mount() {
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'guideModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="gdTitle" style="height: min(900px, calc(100vh - 32px));">
      <div class="sheet-head"><span class="eyebrow" style="margin:0" id="gdEyebrow">Как устроен компонент</span><h2 id="gdTitle">…</h2><button class="btn ghost x" type="button" data-close>Закрыть</button></div>
      <div class="lab-wrap"><nav class="lab-list" id="gdList" aria-label="Настройки"></nav><div class="lab-main" id="gdMain"></div></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
  }
  function open(id, key) { G.id = id; G.edge = null; select(key); $('guideModal').hidden = false; render(); }
  function openEdge(eid, key) { G.edge = eid; G.id = null; select(key); $('guideModal').hidden = false; render(); }
  function select(key) { G.key = key || null; G.guess = null; G.show = false; G.rows = null; }

  /* ---------- варианты ---------- */
  function variants(props, d) {
    const cur = props[d.key];
    if (d.type === 'select') return d.options.map(([v, t]) => ({ v, label: t, cur: String(v) === String(cur) }));
    if (d.type === 'toggle') return [{ v: false, label: 'Выключено', cur: !cur }, { v: true, label: 'Включено', cur: !!cur }];
    if (d.type === 'range') {
      let arr = [...new Set([d.min, cur - 2, cur - 1, cur, cur + 1, cur + 2, cur * 2, Math.ceil(cur * 1.5), d.max].map(x => Math.max(d.min, Math.min(d.max, Math.round(x)))))];
      arr = arr.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b).slice(0, 7).sort((a, b) => a - b);
      return arr.map(v => ({ v, label: String(v), cur: v === cur }));
    }
    if (d.type === 'multi') {
      const c = cur || [];
      return [{ v: c.slice(), label: 'Как сейчас', cur: true }].concat(d.options.map(([k, t]) => {
        const has = c.includes(k);
        return { v: has ? c.filter(x => x !== k) : d.options.map(o => o[0]).filter(x => c.includes(x) || x === k), label: (has ? 'Убрать: ' : 'Добавить: ') + t, cur: false };
      }));
    }
    return [];
  }
  const pc = v => Math.round(v * 100) + ' %';
  function nodeCols(n) {
    switch (n.type) {
      case 'cache': return ['Попаданий в кэш', 'Нагрузка на базу'];
      case 'sql': return ['Primary (записи)', 'Реплики (чтения)'];
      case 'queue': return ['Очередь растёт', 'Потери'];
      case 'lb': case 'gateway': return ['Самый загруженный за ним', n.type === 'gateway' ? 'Ботов проходит' : 'Экземпляров за ним'];
      case 'nosql': return ['Загрузка узлов', 'Данные в сохранности'];
      default: return ['Загрузка узла', 'Экземпляров'];
    }
  }
  function nodeVals(n, g, res) {
    const r = res.nodes[n.id] || {};
    const kids = g.edges.filter(e => e.from === n.id).map(e => g.nodes.find(x => x.id === e.to)).filter(Boolean);
    const parents = g.edges.filter(e => e.to === n.id).map(e => g.nodes.find(x => x.id === e.from)).filter(Boolean);
    const stores = g.nodes.filter(x => x.type === 'sql' || x.type === 'nosql');
    switch (n.type) {
      case 'cache': {
        const hs = parents.map(p => res.ctx.routeMemo.get(p.id + '|read')).filter(rt => rt && rt.hit != null).map(rt => rt.hit);
        const hit = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
        const db = stores.length ? Math.max(...stores.map(s => (res.nodes[s.id] || {}).util || 0)) : 0;
        return [[hit == null ? '—' : pc(hit), hit || 0, 'hi'], [pc(db), db, 'util']];
      }
      case 'sql': { const i = r.info || {}; return [[pc(i.uW || 0), i.uW || 0, 'util'], [i.R ? pc(i.uR || 0) + (i.lag > 1 ? ' · лаг ' + F().ms(i.lag) : '') : 'нет реплик', i.R ? i.uR : 0, 'util']]; }
      case 'queue': { const q = res.queues[n.id] || {}; return [[q.growth > 0.5 ? '+' + F().num(q.growth) + '/с' : 'нет', q.growth > 0.5 ? 2 : 0, 'util'], [q.lost > 0.01 ? F().num(q.lost * 60) + '/мин' : 'нет', q.lost > 0.01 ? 2 : 0, 'util']]; }
      case 'lb': case 'gateway': {
        const mx = kids.length ? Math.max(...kids.map(k => (res.nodes[k.id] || {}).util || 0)) : 0;
        if (n.type === 'gateway') { const b = res.kinds.bot; return [[pc(mx), mx, 'util'], [b && b.passed != null ? pc(b.passed) : '—', b && b.passed != null ? b.passed * 3 : 0, 'util']]; }
        return [[pc(mx), mx, 'util'], [String(kids.reduce((s, k) => s + ((res.nodes[k.id] || {}).count || 0), 0)), 0, '']];
      }
      case 'nosql': { const an = SD.sim.analyze(A().level, g, res); const bad = an.durable.some(x => x.node === n.id); return [[pc(r.util || 0), r.util || 0, 'util'], [bad ? 'риск потери' : 'да', bad ? 2 : 0, 'util']]; }
      default: return [[pc(r.util || 0), r.util || 0, 'util'], [String(r.count || n.props.count || 1), 0, '']];
    }
  }
  const edgeCols = () => G.stress ? ['Сбой: с ответом', 'Сбой: ждут', 'Сбой: вызывающий', 'Сбой: на соседа'] : ['Вызовы успешны', 'Нагрузка на соседа', 'Раздувание повторами'];
  const stressVals = scn => (e, g, res) => {
    const st = SD.stressRun(A().level, g, e.id, scn, A().mul);
    const arr = [
      [F().pct(st.s) + (st.deg > 0.005 ? ` · ${pc(st.deg)} упрощ.` : ''), st.s >= 0.99 ? 0.5 : st.s >= 0.7 ? 0.8 : 2, 'util'],
      [F().ms(st.lat), st.lat > 1000 ? 2 : st.lat > 300 ? 0.8 : 0.3, 'util'],
      [pc(Math.min(st.caller, 9)), st.caller, 'util'],
      ['×' + st.amp.toFixed(2).replace('.', ','), st.amp > 1.3 ? 2 : st.amp > 1.05 ? 0.8 : 0.3, 'util']];
    arr.sk = st; return arr;
  };
  function edgeVals(e, g, res) {
    const er = res.edges[e.id] || {}, info = er.info || {}, to = res.nodes[e.to] || {};
    return [[info.s != null ? F().pct(info.s) : '—', info.s != null ? (info.s >= 0.999 ? 0.5 : info.s >= 0.99 ? 0.8 : 2) : 0, 'util'], [pc(to.util || 0), to.util || 0, 'util'], [info.amp ? '×' + info.amp.toFixed(2).replace('.', ',') : '×1', info.amp > 1.3 ? 2 : info.amp > 1.05 ? 0.8 : 0.3, 'util']];
  }
  function evaluate(mutate, vals) {
    const S = A(), L = S.level;
    const g = JSON.parse(JSON.stringify(S.graph));
    const target = mutate(g);
    const res = SD.sim.run(L, g, { mul: S.mul, down: S.down });
    const res1 = S.mul === 1 && !Object.keys(S.down).length ? res : SD.sim.run(L, g, { mul: 1 });
    let goals = null;
    if (!L.sandbox && L.goals && L.goals.length) { try { goals = SD.evalGoals(L, g, res1, SD.sim.chaos(L, g), SD.sim.analyze(L, g, res1)); } catch (err) { goals = null; } }
    return { succ: res.total.success, lat: res.total.lat, cost: res.cost, ex: vals(target, g, res), goals };
  }

  /* ---------- отрисовка ---------- */
  function render() {
    if (G.edge) return renderEdge();
    const n = nodeOf(); if (!n) { $('guideModal').hidden = true; return; }
    G.stress = null;
    const t = SD.TYPES[n.type];
    $('gdEyebrow').textContent = 'Как устроен компонент';
    $('gdTitle').textContent = nm(n);
    const props = visibleProps(n);
    $('gdList').innerHTML = listHtml('Как он устроен', props, n.props);
    const d = props.find(x => x.key === G.key);
    $('gdMain').innerHTML = d ? propView(d, n.props, (SD.PROP_SIMPLE[n.type] || {})[d.key], n.type, `← Как устроен «${esc(nm(n))}»`) : howView(n);
    $('gdMain').scrollTop = 0;
    if (d) runCompare(d, variants(n.props, d), nodeCols(n), v => evaluate(g => { const m = g.nodes.find(x => x.id === n.id); m.props[d.key] = Array.isArray(v) ? v.slice() : v; return m; }, nodeVals));
    void t;
  }
  function renderEdge() {
    const e = edgeOf(); if (!e) { $('guideModal').hidden = true; return; }
    const g = A().graph, a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
    const props = Object.assign(SD.edgeDefaults(), e.props);
    const defs = edgeDefs(e);
    $('gdEyebrow').textContent = 'Как работает связь';
    $('gdTitle').textContent = `${nm(a)} → ${nm(b)}`;
    $('gdList').innerHTML = listHtml('Как работает вызов', defs, props);
    const d = defs.find(x => x.key === G.key);
    G.stress = d && SD.stressKey && SD.edgeKind(a, b).resil ? SD.stressKey(d.key) : null;
    $('gdMain').innerHTML = d ? propView(d, props, (SD.EDGE_SIMPLE || {})[d.key], 'edge', '← Как работает вызов') : howEdge(e, a, b, defs, props);
    $('gdMain').scrollTop = 0;
    if (d) runCompare(d, variants(props, d), edgeCols(), v => evaluate(gg => { const m = gg.edges.find(x => x.id === e.id); m.props = Object.assign(SD.edgeDefaults(), m.props, { [d.key]: v }); return m; }, G.stress ? stressVals(G.stress) : edgeVals));
  }
  function listHtml(first, defs, props) {
    const val = d => { const v = props[d.key]; if (d.type === 'toggle') return v ? 'вкл' : 'выкл'; if (d.type === 'multi') return (v || []).length + ' шт.'; if (d.type === 'select') { const o = d.options.find(o2 => String(o2[0]) === String(v)); return o ? String(o[1]).split(' — ')[0].split(' (')[0] : v; } return v; };
    return `<button type="button" class="lab-item ${!G.key ? 'on' : ''}" data-gk=""><b>${first}</b><small>по шагам и простыми словами</small></button>` +
      defs.map(d => `<button type="button" class="lab-item ${G.key === d.key ? 'on' : ''}" data-gk="${d.key}"><b>${esc(d.label)}</b><small>сейчас: ${esc(String(val(d)).slice(0, 40))}</small></button>`).join('');
  }
  function howView(n) {
    const t = SD.TYPES[n.type], inf = t.info || {}, sim = SD.SIMPLE_TYPES && SD.SIMPLE_TYPES[n.type];
    let h = `<div class="insp-head">${SD.icon(n.type)}<div><b>${esc(nm(n))}</b><small>${esc(t.name)} · ${esc(t.short || '')}</small></div></div>`;
    if (sim) h += `<div class="simple"><span class="eyebrow">Простыми словами</span><span class="an">${esc(sim[1])}</span><span class="pl">${esc(sim[0])}</span></div>`;
    const steps = SD.TYPE_GUIDE && SD.TYPE_GUIDE[n.type];
    if (steps) h += `<h3 class="gd-h">Как он работает</h3><ol class="gd-steps">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
    if (inf.why) h += `<h3 class="gd-h">Зачем он нужен</h3><p>${esc(inf.why)}</p>`;
    if ((inf.pros || []).length || (inf.cons || []).length) h += `<div class="pc"><div class="plus"><b>Плюсы</b><ul>${(inf.pros || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div><div class="minus"><b>Минусы</b><ul>${(inf.cons || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`;
    if (inf.real) h += `<h3 class="gd-h">В реальной жизни</h3><p>${esc(inf.real)}</p>`;
    if (inf.numbers && inf.numbers.length) h += `<table class="numbers"><tbody>${inf.numbers.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>`;
    const props = visibleProps(n);
    if (props.length) h += `<h3 class="gd-h">Настройки: что каждая меняет</h3><div class="gd-props">${props.map(d => `<button type="button" class="gd-prop" data-gk="${d.key}"><b>${esc(d.label)}</b><span>${esc(((SD.PROP_SIMPLE[n.type] || {})[d.key] || d.help || '').split('. ')[0])}.</span><em>Угадать и сравнить →</em></button>`).join('')}</div>`;
    if (t.dive && SD.DIVES[t.dive]) h += `<button type="button" class="dive-cta" data-gdive="${t.dive}">${SD.icon(n.type)}<span><b>Пошаговая анимация</b><small>${esc(SD.DIVES[t.dive].title)}: каждый шаг с кодом</small></span></button>`;
    return h;
  }
  function howEdge(e, a, b, defs, props) {
    const k = SD.edgeKind(a, b);
    let h = `<div class="insp-head"><span class="edge-ico">→</span><div><b>${esc(nm(a))} → ${esc(nm(b))}</b><small>${k.resil ? 'синхронный вызов: вызывающий ждёт ответа' : 'поток данных'}</small></div></div>`;
    h += `<div class="simple"><span class="eyebrow">Простыми словами</span><span class="an">Звонок соседу: ты набираешь номер и ждёшь. Пока ждёшь, линия занята. Если сосед не берёт трубку — нужно решить, сколько ждать, перезванивать ли и что сказать клиенту.</span></div>`;
    if (k.resil) h += `<h3 class="gd-h">Как работает вызов</h3><ol class="gd-steps">${SD.EDGE_STEPS.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
    if (defs.length) h += `<h3 class="gd-h">Опции связи: что каждая меняет</h3><div class="gd-props">${defs.map(d => `<button type="button" class="gd-prop" data-gk="${d.key}"><b>${esc(d.label)}</b><span>${esc((SD.EDGE_SIMPLE[d.key] || '').split('. ')[0])}.</span><em>Сейчас: ${esc(SD.valueLabel(d, props[d.key]))} · угадать и сравнить →</em></button>`).join('')}</div>`;
    if (k.resil && SD.labs) h += `<button type="button" class="dive-cta" data-gresil="1">${SD.icon('external')}<span><b>Посмотреть вживую</b><small>Сломай соседа и смотри на каждый запрос: таймаут, повторы, предохранитель, fallback</small></span></button>`;
    if (k.resil && SD.DIVES.resilience) h += `<button type="button" class="dive-cta" data-gdive="resilience">${SD.icon('app')}<span><b>Пошаговая анимация</b><small>${esc(SD.DIVES.resilience.title)}</small></span></button>`;
    return h;
  }
  function propView(d, props, text, scope, back) {
    text = text || d.help || '';
    let h = `<button type="button" class="btn ghost" data-gk="">${back}</button><h2 class="gd-title">${esc(d.label)}</h2>`;
    h += `<div class="simple"><span class="eyebrow">На пальцах</span><span class="an">${esc(text)}</span>${d.help && d.help !== text ? `<span class="pl">${esc(d.help)}</span>` : ''}</div>`;
    if (d.type === 'select' && d.options.length) h += `<ul class="gd-opts">${d.options.map(([v, t]) => { const m = SD.optSimple ? SD.optSimple(scope, d.key, v) : null; return `<li class="${String(v) === String(props[d.key]) ? 'cur' : ''}"><b>${esc(t)}</b>${m && m !== t ? ` — ${esc(m)}` : ''}</li>`; }).join('')}</ul>`;
    else if (d.type === 'toggle' && SD.optSimple) { const on = SD.optSimple(scope, d.key, true), off = SD.optSimple(scope, d.key, false); if (on || off) h += `<ul class="gd-opts"><li class="${!props[d.key] ? 'cur' : ''}"><b>Выключено</b>${off ? ' — ' + esc(off) : ''}</li><li class="${props[d.key] ? 'cur' : ''}"><b>Включено</b>${on ? ' — ' + esc(on) : ''}</li></ul>`; }
    h += `<h3 class="gd-h">Сравнение вариантов на твоей схеме</h3>`;
    h += `<div class="gd-guess" id="gdGuess"><b>Сначала угадай:</b> какой вариант лучше для этой схемы? Выбери — и симулятор покажет, прав ли ты.<div class="gd-gopts" id="gdGopts"></div><button type="button" class="linkish" data-gshow="1">Не гадать, показать сразу</button></div>`;
    const ss = G.stress && SD.STRESS[G.stress];
    h += `<div id="gdCmpWrap" hidden><p class="note">Симулятор прогоняет твою текущую схему с каждым вариантом этой настройки${A().mul !== 1 ? ` при нагрузке ×${A().mul.toFixed(2).replace('.', ',')}` : ''}. Остальное не меняется.${ss ? ` Прогонов два: обычный день и плохой день — «${esc(ss.label.toLowerCase())}: ${esc(ss.note)}». Колонки «Сбой» — плохой день: в обычный день опции надёжности почти не видны, они работают именно тогда.` : ''}</p><div class="gd-cmp" id="gdCmp"><p class="note">Считаю…</p></div></div><div id="gdVerdict"></div>`;
    return h;
  }
  function runCompare(d, vs, cols, evalFn) {
    const job = ++G.job, rows = [];
    $('gdGopts').innerHTML = vs.map((v, k) => `<button type="button" class="chip-btn" data-gguess="${k}">${esc(String(v.label).split(' — ')[0].slice(0, 40))}${v.cur ? ' · сейчас' : ''}</button>`).join('');
    let i = 0;
    const step = () => {
      if (job !== G.job || $('guideModal').hidden) return;
      if (i < vs.length) { rows.push(Object.assign({}, vs[i], evalFn(vs[i].v))); i++; G.rows = rows; draw(rows, cols, i < vs.length); setTimeout(step, 0); }
    };
    step();
  }
  function bestOf(rows) {
    const good = rows.filter(r => r.goals ? r.goals.every(g => g.ok) : r.succ >= 0.999);
    if (rows[0] && rows[0].ex && rows[0].ex.sk) {
      const sk = r => r.ex.sk, pool = good.length ? good : rows;
      return pool.slice().sort((a, b) => Math.round(sk(b).s * 200) - Math.round(sk(a).s * 200) || Math.round(Math.min(sk(a).caller, 9) * 20) - Math.round(Math.min(sk(b).caller, 9) * 20) || sk(a).amp - sk(b).amp || sk(a).lat - sk(b).lat || a.cost - b.cost)[0];
    }
    const okOf = r => r.goals ? r.goals.filter(g => g.ok).length : 0;
    if (good.length) return good.slice().sort((a, b) => a.cost - b.cost)[0];
    return rows.slice().sort((a, b) => okOf(b) - okOf(a) || b.succ - a.succ || a.lat - b.lat)[0];
  }
  function draw(rows, cols, more) {
    const box = $('gdCmp'); if (!box) return;
    const shown = G.guess != null || G.show;
    $('gdCmpWrap').hidden = !shown;
    if (shown) $('gdGuess').hidden = true;
    const maxLat = Math.max(...rows.map(r => Math.min(r.lat, 5000)), 1), maxCost = Math.max(...rows.map(r => r.cost), 1);
    const okOf = r => r.goals ? r.goals.filter(g => g.ok).length : null, tot = rows[0] && rows[0].goals ? rows[0].goals.length : 0;
    const best = bestOf(rows);
    const lbl = s => { const t = String(s); return t.length > 46 ? t.slice(0, 45) + '…' : t; };
    const exCls = (val, kind) => kind === 'util' ? (val > 1 ? 'bad' : val > 0.75 ? 'warn' : 'ok') : kind === 'hi' ? (val > 0.9 ? 'ok' : val > 0.7 ? 'warn' : 'bad') : '';
    let h = `<table class="gd-table"><thead><tr><th>Вариант</th><th>Успешно</th><th>Задержка</th><th>Цена в месяц</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}${tot ? '<th>Цели</th>' : ''}<th></th></tr></thead><tbody>`;
    rows.forEach((r, k) => {
      h += `<tr class="${r.cur ? 'cur' : ''} ${r === best && !more ? 'best' : ''} ${G.guess === k ? 'guess' : ''}"><td>${esc(lbl(r.label))}${r.cur ? '<small>сейчас</small>' : ''}${G.guess === k ? '<small class="gss">твой выбор</small>' : ''}${r === best && !more && !r.cur ? '<small class="bst">лучше всего</small>' : ''}</td>`;
      h += `<td class="${r.succ >= 0.999 ? 'ok' : r.succ >= 0.99 ? 'warn' : 'bad'}">${F().pct(r.succ)}</td>`;
      h += `<td><span class="gd-bar"><i style="width:${Math.round(Math.min(r.lat, 5000) / maxLat * 100)}%"></i></span>${F().ms(r.lat)}</td>`;
      h += `<td><span class="gd-bar c"><i style="width:${Math.round(r.cost / maxCost * 100)}%"></i></span>${F().usd(r.cost)}</td>`;
      r.ex.forEach(([txt, val, kind]) => { h += `<td class="${exCls(val, kind)}">${esc(txt)}</td>`; });
      if (tot) h += `<td class="${okOf(r) === tot ? 'ok' : 'bad'}">${okOf(r)} из ${tot}</td>`;
      h += `<td>${r.cur ? '' : `<button type="button" class="btn" data-gpick="${k}">Выбрать</button>`}</td></tr>`;
    });
    h += `</tbody></table>${more ? '<p class="note">Считаю остальные варианты…</p>' : ''}`;
    box.innerHTML = h;
    if (more || !shown) { $('gdVerdict').innerHTML = ''; return; }
    const cur = rows.find(r => r.cur);
    let v = '';
    if (G.guess != null) {
      const g = rows[G.guess];
      v += g === best ? `<div class="lab-card okc"><b>Угадал!</b> «${esc(lbl(g.label))}» — лучший вариант для этой схемы.</div>`
        : `<div class="lab-card badc"><b>Ты выбрал «${esc(lbl(g.label))}», а лучше «${esc(lbl(best.label))}».</b> Сравни строки: ${g.ex && g.ex.sk ? skWhy(g.ex.sk, best.ex.sk) : g.succ < best.succ - 1e-4 ? `успешность ${F().pct(g.succ)} против ${F().pct(best.succ)}` : g.cost > best.cost ? `дороже на ${F().usd(g.cost - best.cost)} при тех же целях` : g.goals && best.goals && okOf(g) < okOf(best) ? `целей ${okOf(g)} против ${okOf(best)}` : `задержка ${F().ms(g.lat)} против ${F().ms(best.lat)}`}.</div>`;
    }
    if (best && cur && best !== cur && best.ex && best.ex.sk) v += `<div class="lab-card"><b>В плохой день лучше всего: «${esc(lbl(best.label))}».</b> Сравни с текущим: ${skWhy(cur.ex.sk, best.ex.sk)}. <button type="button" class="btn primary" data-gpick="${rows.indexOf(best)}">Выбрать его</button></div>`;
    else if (best && cur && best !== cur) v += `<div class="lab-card"><b>На твоей схеме лучше всего: «${esc(lbl(best.label))}».</b> ${best.goals ? (best.goals.every(g => g.ok) ? 'Все цели выполняются' : `Выполняется больше целей (${okOf(best)} из ${tot})`) : `Успешно ${F().pct(best.succ)}`}, цена ${F().usd(best.cost)} в месяц. <button type="button" class="btn primary" data-gpick="${rows.indexOf(best)}">Выбрать его</button></div>`;
    else if (cur && cur.ex && cur.ex.sk) v += `<div class="lab-card"><b>В плохой день текущий вариант лучший из этих.</b> ${esc(stressTip())}</div>`;
    else if (cur) v += `<div class="lab-card">Текущий вариант уже лучший для этой настройки${tot && cur.goals && !cur.goals.every(g => g.ok) ? ', но целей это не закрывает: дело в другой настройке или в другом узле' : ''}.</div>`;
    const flat = rows.length > 1 && Math.max(...rows.map(r => r.cost)) === Math.min(...rows.map(r => r.cost)) && Math.max(...rows.map(r => r.lat)) - Math.min(...rows.map(r => r.lat)) < 1 && Math.max(...rows.map(r => r.succ)) - Math.min(...rows.map(r => r.succ)) < 1e-4;
    if (flat && !(rows[0].ex && rows[0].ex.sk)) v += `<p class="note">На этой схеме варианты почти не отличаются по цифрам: эффект проявится при другой нагрузке, при падении узла или в надёжности данных.</p>`;
    $('gdVerdict').innerHTML = v;
  }

  function stressTip() {
    const e = edgeOf(), p = Object.assign(SD.edgeDefaults(), e && e.props);
    if (G.key === 'retries' && p.backoff !== 'exp') return 'Повторы без паузы в плохой день добивают и соседа, и твой сервис: смотри колонку «Сбой: вызывающий». Включи «Паузу между повторами» и сравни ещё раз.';
    if (G.key === 'backoff' && !p.retries) return 'Пауза влияет, только когда есть повторы: сначала поставь 1–3 повтора.';
    if (G.key === 'cb' && !p.fallback) return 'Предохранитель защищает сервис, но пользователь всё равно видит ошибку. Добавь fallback, чтобы вместо ошибки был упрощённый ответ.';
    return 'Опции надёжности работают вместе: таймаут, пара повторов с паузой, предохранитель и fallback.';
  }
  function skWhy(a, b) {
    const p = [];
    if (Math.abs(a.s - b.s) > 0.004) p.push(`при сбое ответ получают ${F().pct(a.s)} против ${F().pct(b.s)} пользователей`);
    if (Math.abs(Math.min(a.caller, 9) - Math.min(b.caller, 9)) > 0.04) p.push(`вызывающий сервис загружен ${pc(Math.min(a.caller, 9))} против ${pc(Math.min(b.caller, 9))}${a.caller > 1 ? ' — потоки кончились, он сам падает' : ''}`);
    if (Math.abs(a.amp - b.amp) > 0.04) p.push(`на соседа давим ×${a.amp.toFixed(2).replace('.', ',')} против ×${b.amp.toFixed(2).replace('.', ',')}`);
    if (!p.length && Math.abs(a.lat - b.lat) > 1) p.push(`ждут ${F().ms(a.lat)} против ${F().ms(b.lat)}`);
    return p.length ? p.join(', ') : 'разница минимальная';
  }
  function onClick(e) {
    const m = $('guideModal');
    if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; G.job++; return; }
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.gk !== undefined) { select(t.dataset.gk); render(); return; }
    if (t.dataset.gdive) { SD.player.open(t.dataset.gdive); return; }
    if (t.dataset.gresil) { m.hidden = true; SD.resilCtx = { edgeId: G.edge }; SD.labs.open('resil'); return; }
    if (t.dataset.gguess !== undefined) { G.guess = +t.dataset.gguess; if (G.rows) draw(G.rows, G.edge ? edgeCols() : nodeCols(nodeOf()), G.rows.length < $('gdGopts').children.length); return; }
    if (t.dataset.gshow) { G.show = true; if (G.rows) draw(G.rows, G.edge ? edgeCols() : nodeCols(nodeOf()), G.rows.length < $('gdGopts').children.length); return; }
    if (t.dataset.gpick !== undefined) {
      const r = G.rows && G.rows[+t.dataset.gpick]; if (!r) return;
      const v = Array.isArray(r.v) ? r.v.slice() : r.v;
      if (G.edge) SD.app.setEdgeProp(G.edge, G.key, v); else SD.app.setProp(G.id, G.key, v);
      SD.app.toast('Готово: применено на площадке. Под настройкой в инспекторе — что изменилось.');
      const key = G.key; select(key); G.show = true; render();
    }
  }

  SD.guide = { mount, open, openEdge };
})();
