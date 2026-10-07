/* Свободный режим: кейс уровня без эталона и без подсказок на холсте — собираешь как хочешь.
   «Оценить решение» разбирает любую схему: требования, запас на рост, надёжность, цена, архитектура,
   сильные стороны и что улучшить. Подсказки — только по запросу. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt, T = () => SD.TYPES;
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const KEY = 'amp-stroyka-free-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  U.best = U.best || {};

  /* ---------- кейсы ---------- */
  const casesOf = () => SD.LEVELS.filter((L, i) => i > 0 && L.solution && !L.ai).concat((SD.DATAL || []).filter(L => L.solution), (SD.CLOUDL || []).filter(L => L.solution));
  const memo = {};
  function derive(L) {
    if (memo[L.id]) return memo[L.id];
    const D = Object.assign({}, L, {
      id: 'free-' + L.id, free: { base: L.id, baseTitle: L.title },
      title: 'Свободно: ' + L.title,
      story: L.story + ' Собери систему сам — как считаешь правильным. Палитра полная, эталона перед глазами нет, подсказки — только если попросишь. Когда готово — «Оценить решение».',
      start: null, allow: ALL(), decisions: [],
      /* все настройки узлов открыты — как в песочнице */
      features: [...new Set(Object.values(SD.TYPES).flatMap(t => (t.props || []).map(p => p.feature).filter(Boolean)).concat(L.features || []))]
    });
    memo[L.id] = D;
    return D;
  }
  const baseOf = L => L && L.free ? SD.levelById(L.free.base) : null;
  /* подсказки скрыты только в свободном режиме без запроса; пока уровень ещё не записан (первая отрисовка) — показываем */
  const hintsOn = () => { const A = SD.app && SD.app.A; if (!A || !A.level) return true; return !A.level.free || !!A.freeHints; };

  /* ---------- оценка ---------- */
  function refGraph(L) { const o = SD.walk.orderOf(L, L.solution), g = SD.walk.build(L, L.solution, o, o.length); return g; }
  function stats(L, g) {
    const r = SD.sim.run(L, g, { mul: 1 }), ch = SD.sim.chaos(L, g), an = SD.sim.analyze(L, g, r);
    const goals = SD.evalGoals(L, g, r, ch, an);
    const sMin = ((L.goals || []).find(x => x.t === 'success') || { min: 0.999 }).min;
    const at = m => { const x = SD.sim.run(L, g, { mul: m }); return x.total.success; };
    const s12 = at(1.2), s15 = at(1.5), s2 = at(2);
    let det = { applied: [], needed: [], anti: [] };
    try { if (SD.archLens) det = SD.archLens.detect(g, r); } catch (e) { /* без линзы */ }
    return { r, ch, goals, sMin, s12, s15, s2, det };
  }
  function evaluate(A) {
    const L = A.level, g = A.graph, B = baseOf(L) || L;
    const me = stats(L, g);
    let ref = null; try { if (B.solution && SD.walk) ref = stats(L, refGraph(L)); } catch (e) { ref = null; }
    const built = g.nodes.some(n => n.type !== 'client');
    const goalsOk = me.goals.filter(x => x.ok).length, gN = me.goals.length || 1;
    const sc = {};
    sc.req = goalsOk / gN;
    sc.head = me.s15 >= me.sMin ? 1 : me.s12 >= me.sMin ? 0.7 : me.r.total.success >= me.sMin ? 0.4 : 0;
    const chOk = me.ch.filter(c => c.ok).length;
    /* надёжность: если кейс требует пережить падение — строго, иначе это бонус */
    const survReq = (L.goals || []).some(x => x.t === 'survive');
    const relR = me.ch.length ? chOk / me.ch.length : 0;
    sc.rel = !built ? 0 : survReq ? relR : 0.6 + 0.4 * relR;
    const budget = (L.goals || []).find(x => x.t === 'cost'), cost = me.r.cost, rc = ref ? ref.r.cost : null;
    sc.cost = !built ? 0 : budget && cost > budget.max ? 0.2 : rc && cost <= rc * 1.05 ? 1 : rc && cost <= rc * 1.4 ? 0.75 : 0.5;
    const pats = [...new Set(me.det.applied.map(p => p.id))], need = me.det.needed || [], anti = me.det.anti || [];
    sc.arch = Math.max(0, Math.min(1, 0.6 + 0.08 * Math.min(5, pats.length) - 0.15 * need.length - 0.3 * anti.length));
    const W = { req: 0.4, head: 0.15, rel: 0.15, cost: 0.15, arch: 0.15 };
    const total = built ? Math.round(Object.entries(W).reduce((s, [k, w]) => s + w * sc[k], 0) * 100) : 0;
    /* сильные стороны и что улучшить */
    const good = [], fix = [];
    if (goalsOk === gN) good.push('Все требования кейса выполнены.');
    if (me.s2 >= me.sMin) good.push('Выдерживает двукратный рост нагрузки без потерь.');
    else if (sc.head === 1) good.push('Выдерживает рост нагрузки в полтора раза.');
    else if (sc.head >= 0.7) good.push('Выдерживает рост нагрузки на 20 %.');
    if (me.ch.length && chOk === me.ch.length) good.push('Переживает падение любого одного узла.');
    if (rc && cost < rc * 0.95 && goalsOk === gN) good.push(`Дешевле эталона на ${F().usd(rc - cost)} в месяц.`);
    if (pats.length) good.push('Паттерны: ' + pats.slice(0, 6).map(id => pname(id)).join(', ') + '.');
    me.goals.forEach((x, i) => {
      if (x.ok) return;
      let w = null; try { w = SD.learn ? SD.learn.analyze(L, g, i) : null; } catch (e) { w = null; }
      const who = w && w.marks && w.marks.length ? ' Узкое место: ' + w.marks.slice(0, 2).map(m => `«${nm(g.nodes.find(n => n.id === m.id))}» (${m.tag})`).join(', ') + '.' : '';
      fix.push(`Не выполнено: ${x.text.toLowerCase()} — ${x.detail}.${who}`);
    });
    const spof = me.ch.filter(c => !c.ok).map(c => g.nodes.find(n => n.id === c.id)).filter(Boolean);
    if (spof.length) fix.push(`Единая точка отказа: ${spof.slice(0, 4).map(n => `«${nm(n)}»`).join(', ')} — упадёт один экземпляр, и пользователи это заметят.`);
    if (sc.head < 0.7 && goalsOk === gN) fix.push('Нет запаса: уже при росте нагрузки на 20 % начнутся отказы. Посмотри, кто загружен сильнее 75 %.');
    need.slice(0, 4).forEach(p => fix.push(`Не хватает: ${pname(p.id)}${p.why ? ' — ' + p.why : ''}.`));
    anti.slice(0, 3).forEach(a => fix.push(`Антипаттерн: ${a.name || pname(a.id)}${a.text ? ' — ' + a.text : ''}.`));
    if (rc && cost > rc * 1.4) {
      const idle = g.nodes.filter(n => { const x = me.r.nodes[n.id]; return x && (n.props.count || 1) > 1 && x.util < 0.3; });
      fix.push(`Дороже эталона на ${F().usd(cost - rc)} в месяц.${idle.length ? ' Мало загружены: ' + idle.slice(0, 3).map(n => `«${nm(n)}» (${Math.round(me.r.nodes[n.id].util * 100)} %)`).join(', ') + ' — можно убавить.' : ''}`);
    }
    return { L, me, ref, sc, total, good, fix, cost, rc, pats, built };
  }
  const pname = id => ((SD.PATTERNS || []).find(p => p.id === id) || {}).name || id;
  const label = t => t >= 90 ? 'Отлично: решение уровня сеньора' : t >= 75 ? 'Хорошо: держит требования с запасом' : t >= 55 ? 'Работает, но есть риски' : t > 0 ? 'Пока не выдерживает требования' : 'Схема пустая';

  /* ---------- окно разбора ---------- */
  function report() {
    const A = SD.app.A, E = evaluate(A), L = A.level;
    const best = U.best[L.id] || 0; if (E.total > best) { U.best[L.id] = E.total; save(); }
    let m = $('freeModal');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'freeModal'; m.hidden = true;
      m.innerHTML = '<div class="sheet fr-sheet" role="dialog" aria-modal="true" aria-labelledby="frTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Разбор решения</span><h2 id="frTitle"></h2><button class="btn ghost x" type="button" data-frx>Закрыть</button></div><div class="fr-body" id="frBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-frx]')) m.hidden = true; if (e.target.closest('[data-frref]')) { const r = $('frRef'); if (r) r.hidden = !r.hidden; } if (e.target.closest('[data-frwalk]')) { m.hidden = true; if (SD.walk) SD.walk.start(); } });
    }
    $('frTitle').textContent = (L.free ? L.free.baseTitle : L.title);
    const row = (k, t, v, d) => `<div class="fr-row"><span class="fr-k">${esc(t)}</span><span class="fr-bar"><i style="width:${Math.round(v * 100)}%" class="${v >= 0.8 ? 'ok' : v >= 0.5 ? 'warn' : 'bad'}"></i></span><span class="fr-v">${Math.round(v * 100)}</span><small>${esc(d)}</small></div>`;
    const me = E.me;
    let h = `<div class="fr-top"><div class="fr-score ${E.total >= 75 ? 'ok' : E.total >= 55 ? 'warn' : 'bad'}"><b>${E.total}</b><span>из 100</span></div><div class="fr-lbl"><b>${esc(label(E.total))}</b><span>Лучший результат в этом кейсе: ${Math.max(best, E.total)}. Оценка — по симулятору этой площадки: требования, запас, надёжность, цена и архитектура.</span></div></div>`;
    h += '<div class="fr-rows">';
    h += row('req', 'Требования кейса', E.sc.req, `${me.goals.filter(x => x.ok).length} из ${me.goals.length} целей`);
    h += row('head', 'Запас на рост', E.sc.head, `×1,2 — успешно ${F().pct(me.s12)}, ×1,5 — ${F().pct(me.s15)}, ×2 — ${F().pct(me.s2)}`);
    h += row('rel', 'Надёжность', E.sc.rel, (me.ch.length ? `переживает ${me.ch.filter(c => c.ok).length} из ${me.ch.length} одиночных падений` : 'нечего ронять') + ((L.goals || []).some(x => x.t === 'survive') ? ' · кейс это требует' : ' · кейс не требует — бонус'));
    h += row('cost', 'Цена', E.sc.cost, `${F().usd(E.cost)}/мес${E.rc ? ` · эталон ${F().usd(E.rc)}` : ''}`);
    h += row('arch', 'Архитектура', E.sc.arch, `паттернов ${E.pats.length}, упущено ${(me.det.needed || []).length}, антипаттернов ${(me.det.anti || []).length}`);
    h += '</div>';
    h += `<div class="fr-cols"><section class="fr-good"><h3>Сильные стороны</h3>${E.good.length ? '<ul>' + E.good.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<p>Пока нечем похвастаться — собери систему, которая обслуживает пользователей.</p>'}</section>`;
    h += `<section class="fr-fix"><h3>Что улучшить</h3>${E.fix.length ? '<ul>' + E.fix.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<p>Замечаний нет. Попробуй сделать дешевле или с бо́льшим запасом.</p>'}</section></div>`;
    h += `<p class="fr-goals">${me.goals.map(x => `<span class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✗'} ${esc(x.text)}</span>`).join('')}</p>`;
    if (E.ref) {
      const rr = E.ref, rp = [...new Set(rr.det.applied.map(p => p.id))], miss = rp.filter(id => !E.pats.includes(id)), extra = E.pats.filter(id => !rp.includes(id));
      h += `<div class="row-btns"><button type="button" class="btn" data-frref>Сравнить с эталоном</button><button type="button" class="btn ghost" data-frwalk>Эталон по шагам</button></div>`;
      h += `<div id="frRef" class="fr-ref" hidden><table><tr><th></th><th>Твоё</th><th>Эталон</th></tr>
        <tr><td>Цена в месяц</td><td>${F().usd(E.cost)}</td><td>${F().usd(rr.r.cost)}</td></tr>
        <tr><td>Время ответа</td><td>${F().ms(me.r.total.lat)}</td><td>${F().ms(rr.r.total.lat)}</td></tr>
        <tr><td>При ×2 нагрузки</td><td>${F().pct(me.s2)}</td><td>${F().pct(rr.s2)}</td></tr>
        <tr><td>Переживает падений</td><td>${me.ch.filter(c => c.ok).length} из ${me.ch.length}</td><td>${rr.ch.filter(c => c.ok).length} из ${rr.ch.length}</td></tr></table>
        <p>${miss.length ? 'В эталоне есть, у тебя нет: ' + miss.map(pname).join(', ') + '. ' : ''}${extra.length ? 'У тебя есть, в эталоне нет: ' + extra.map(pname).join(', ') + '. ' : ''}Эталон — не единственно верный ответ: если твоё решение выполняет требования, оно имеет право на жизнь.</p></div>`;
    }
    $('frBody').innerHTML = h;
    m.hidden = false;
  }

  /* ---------- выбор кейса ---------- */
  function picker() {
    let m = $('freePick');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'freePick'; m.hidden = true;
      m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="fpTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Свободный режим</span><h2 id="fpTitle">Выбери кейс — собери сам</h2><button class="btn ghost x" type="button" data-fpx>Закрыть</button></div><div class="fr-pick" id="fpBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-fpx]')) { m.hidden = true; return; } const b = e.target.closest('[data-freecase]'); if (b) { m.hidden = true; open(b.dataset.freecase); } });
    }
    $('fpBody').innerHTML = `<p class="fr-lede">Тот же кейс, что на уровне: история, нагрузка и требования. Но площадка пустая, палитра полная, эталона и подсказок на холсте нет — собираешь как считаешь правильным. Подсказки можно попросить в задании. «Оценить решение» разберёт любую схему: требования, запас, надёжность, цену и архитектуру.</p><div class="cards">${casesOf().map(L => { const b = U.best[derive(L).id]; return `<button type="button" class="lvl" data-freecase="${L.id}"><span class="n">${esc(SD.levelLabel(L).toUpperCase())}<span>${b ? b + ' / 100' : ''}</span></span><b>${esc(L.title)}</b><small>${esc(L.story.split('. ')[0])}.</small></button>`; }).join('')}</div>`;
    m.hidden = false;
  }
  function open(baseId) {
    const L = SD.levelById(baseId); if (!L) return;
    document.querySelectorAll('.modal').forEach(x => { x.hidden = true; });
    SD.app.A.freeHints = false;
    SD.app.loadLevel(derive(L));
  }

  /* ---------- блок в задании ---------- */
  function taskBlock(A) {
    const L = A.level; if (!L.free) return '';
    return `<div class="fr-cta"><button type="button" class="btn primary" data-freeeval>Оценить решение</button><button type="button" class="btn ghost" data-freehints>${A.freeHints ? 'Спрятать подсказки' : 'Показать подсказки'}</button><small>${A.freeHints ? 'Подсказки включены: советы прораба, «Почему?» и расчёт нагрузки.' : 'Подсказки скрыты — собираешь сам. Требования ниже — то, что проверит оценка.'}</small></div>`;
  }

  function mount() {
    document.addEventListener('click', e => {
      if (e.target.closest('[data-freeeval]')) { report(); return; }
      if (e.target.closest('[data-freehints]')) { const A = SD.app.A; A.freeHints = !A.freeHints; SD.panels.task(A); return; }
      if (e.target.closest('[data-freeopen]')) { picker(); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') ['freeModal', 'freePick'].forEach(id => { const m = $(id); if (m && !m.hidden) m.hidden = true; }); });
    setTimeout(() => {
      const hub = $('navHub'), menu = hub && hub.parentNode;
      if (menu && !$('navFree')) {
        const b = document.createElement('button'); b.type = 'button'; b.id = 'navFree'; b.className = hub.className; b.textContent = 'Свободный режим';
        b.setAttribute('data-freeopen', '1');
        menu.insertBefore(b, hub.nextSibling);
      }
    }, 0);
    /* «Проверить решение» в свободном режиме — сразу с разбором */
    const cb = $('checkBtn');
    if (cb) cb.addEventListener('click', () => { const A = SD.app && SD.app.A; if (A && A.level && A.level.free) setTimeout(report, 50); });
  }

  /* уровни свободного режима находятся по id — переживают перезагрузку */
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && id.startsWith('free-')) ? (() => { const b = baseById(id.slice(5)); return b ? derive(b) : null; })() : baseById(id);
  SD.levelLabel = L => L.free ? 'Свободный режим' : baseLabel(L);
  SD.nextLevel = L => L.free ? null : baseNext(L);

  SD.free = { mount, open, picker, evaluate, report, taskBlock, hintsOn, cases: casesOf };
})();
