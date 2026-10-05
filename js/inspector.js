/* Инспектор: настройки и живые показатели выбранного узла или связи. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const F = () => SD.fmt;
  const $ = id => document.getElementById(id);

  function render(A) {
    const pane = $('paneNode');
    const sel = A.sel;
    if (!sel) { pane.innerHTML = overview(A); return; }
    if (sel.type === 'edge') { pane.innerHTML = edgeView(A, A.graph.edges.find(e => e.id === sel.id)); return; }
    const n = A.graph.nodes.find(x => x.id === sel.id);
    pane.innerHTML = n ? nodeView(A, n) : overview(A);
  }

  function overview(A) {
    let h = `<p class="empty">Выбери узел или связь на схеме, чтобы настроить их и увидеть, как они работают под нагрузкой.</p><h3>На площадке</h3><div class="mini-list">`;
    A.graph.nodes.forEach(n => {
      const r = A.res && A.res.nodes[n.id];
      h += `<button type="button" class="mini" data-sel="${n.id}">${SD.icon(n.type)}<span>${esc(n.label || SD.TYPES[n.type].name)}</span><b class="${r ? r.status : ''}">${r && n.type !== 'client' ? (r.dead ? 'лежит' : Math.round(r.util * 100) + ' %') : ''}</b></button>`;
    });
    return h + `</div><p class="note">Связь создаётся протягиванием от кружка на правом краю узла к другому узлу. Стрелка показывает, кто кого вызывает.</p>`;
  }

  function propControl(A, n, d) {
    if (d.feature && !(A.level.sandbox || (A.level.features || []).includes(d.feature))) return '';
    if (d.showIf && !d.showIf(n)) return '';
    const id = `p_${n.id}_${d.key}`;
    const v = n.props[d.key];
    const help = d.help ? `<div class="help">${esc(d.help)}</div>` : '';
    const q = SD.guide ? `<button type="button" class="qhelp" data-guide="${d.key}" title="На пальцах и сравнение вариантов" aria-label="Подробнее: ${esc(d.label)}">?</button>` : '';
    if (d.type === 'range') return `<div class="prop"><label for="${id}">${esc(d.label)} <output>${v}</output>${q}</label><input type="range" id="${id}" data-prop="${d.key}" min="${d.min}" max="${d.max}" step="1" value="${v}">${help}</div>`;
    if (d.type === 'select') return `<div class="prop"><label for="${id}">${esc(d.label)}${q}</label><select id="${id}" data-prop="${d.key}">${d.options.map(([k, t]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${help}</div>`;
    if (d.type === 'multi') return `<div class="prop"><span class="plabel">${esc(d.label)} ${q}</span><div class="multi">${d.options.map(([k, t, hh]) => `<label class="switch"><input type="checkbox" id="${id}_${k}" data-prop="${d.key}" data-multi="${k}" ${(v || []).includes(k) ? 'checked' : ''}><span><b>${esc(t)}</b><small>${esc(hh)}</small></span></label>`).join('')}</div>${help}</div>`;
    if (d.type === 'toggle') return `<label class="switch"><input type="checkbox" id="${id}" data-prop="${d.key}" ${v ? 'checked' : ''}><span><b>${esc(d.label)}</b>${d.help ? `<small>${esc(d.help)}</small>` : ''}</span>${q}</label>`;
    return '';
  }

  const TOP = ['Успешно', 'Время ответа', 'В месяц', 'Рост очереди', 'Потери', 'Дубли', 'Качество AI', 'Цели'];
  const chips = list => list.map(x => `<span class="lv-chip ${x.good === true ? 'good' : x.good === false ? 'bad' : ''}"><small>${esc(x.l)}</small>${esc(x.f)} → <b>${esc(x.t)}</b></span>`).join('');
  /* второй прогон «в плохой день»: без него опции надёжности и изоляции выглядят бесполезными */
  function stressOf(A, scope, target, d, lc) {
    if (lc.stress !== undefined) return lc.stress;
    lc.stress = null;
    try {
      const pct = v => SD.fmt.pct(v), x = v => '×' + v.toFixed(2).replace('.', ',');
      const ch = (l, a, b, f, better) => Math.abs(a - b) > 1e-3 ? { l, f: f(a), t: f(b), good: better(a, b) } : null;
      if (scope === 'edge' && SD.stressKey && SD.stressKey(d.key)) {
        const scn = SD.stressKey(d.key), S = SD.STRESS[scn];
        const run = v => { const g = JSON.parse(JSON.stringify(A.graph)); const m = g.edges.find(e => e.id === target.id); m.props = Object.assign(SD.edgeDefaults(), m.props, { [d.key]: v }); return SD.stressRun(A.level, g, target.id, scn, A.mul); };
        const a = run(lc.prev), b = run(lc.value); if (!a || !b) return null;
        const from = A.graph.nodes.find(n => n.id === target.from), nmF = from ? (from.label || SD.TYPES[from.type].name) : 'вызывающий';
        const list = [
          ch('Пользователи с ответом', a.s, b.s, pct, (p, q) => q > p),
          ch('Из них упрощённо', a.deg, b.deg, pct, () => null),
          ch('Ждут ответа', a.lat, b.lat, v => SD.fmt.ms(v), (p, q) => q < p),
          ch(`Загрузка «${nmF}»`, Math.min(a.caller, 9), Math.min(b.caller, 9), v => Math.round(v * 100) + ' %', (p, q) => q < p),
          ch('Давим на соседа', a.amp, b.amp, x, (p, q) => q < p)
        ].filter(Boolean);
        const why = { timeout: 'Без таймаута каждый поток висит, пока сосед тормозит, и потоки кончаются: падает уже вызывающий сервис.', retries: 'Повторы спасают от случайных сбоев, но каждый повтор — ещё один вызов больному соседу и ещё одно ожидание для потока.', backoff: 'Пауза между повторами даёт соседу передышку: повторы не бьют залпом.', cb: 'Предохранитель замечает, что больше половины вызовов падает, и отбивает их сразу: потоки свободны, сосед отдыхает.', fallback: 'Запасной ответ превращает ошибку в упрощённый результат: пользователь видит страницу, хоть и без части данных.' }[d.key];
        lc.stress = { title: `А если ${S.label.toLowerCase()} (${S.note})`, chips: list, note: (!list.length && (a.open || b.open) && d.key !== 'cb' ? 'Предохранитель в плохой день уже разомкнут: вызовы отбиваются сразу, поэтому эта настройка почти ни на что не влияет. ' : '') + why, calm: 'В обычный день цифры те же: эта опция работает в плохой день, когда сосед болеет. Смотри строку ниже.' };
      } else if (scope !== 'edge' && target.type === 'sql' && (d.key === 'isolation' || d.key === 'locking') && SD.isoStress) {
        const run = v => { const g = JSON.parse(JSON.stringify(A.graph)); g.nodes.find(n => n.id === target.id).props[d.key] = v; return SD.isoStress(A.level, g, target.id, A.mul); };
        const a = run(lc.prev), b = run(lc.value);
        const list = [
          ch('Откатов и повторов', a.abort, b.abort, pct, (p, q) => q < p),
          ch('Загрузка primary', Math.min(a.uW, 9), Math.min(b.uW, 9), v => Math.round(v * 100) + ' %', (p, q) => q < p),
          ch('Успешно', a.s, b.s, pct, (p, q) => q > p),
          ch('Время ответа', a.lat, b.lat, v => SD.fmt.ms(v), (p, q) => q < p)
        ].filter(Boolean);
        lc.stress = { title: 'А при толкучке (многие меняют одни и те же строки)', chips: list, note: d.key === 'isolation' ? 'Строже изоляция — меньше аномалий, но больше откатов: база отменяет конфликтующие транзакции, и они идут заново.' : 'Блокировки и версии важны, только когда за одну строку дерутся. Без толкучки разницы почти нет.', calm: 'На обычной нагрузке цифры почти те же: изоляция меняет, какие ошибки в данных возможны, а цену видно при толкучке. Смотри строки выше и ниже.' };
      }
    } catch (err) { lc.stress = null; }
    return lc.stress;
  }
  SD.changeStress = (A, lc, d) => {
    const tg = lc.kind === 'eprop' ? A.graph.edges.find(e => e.id === lc.id) : A.graph.nodes.find(n => n.id === lc.id);
    return tg && d ? stressOf(A, lc.kind === 'eprop' ? 'edge' : 'node', tg, d, lc) : null;
  };
  function changePanel(A, scope, target, d) {
    const lc = A.lastChange;
    if (!lc || lc.dismissed || !d || lc.id !== target.id || lc.key !== d.key || lc.kind !== (scope === 'edge' ? 'eprop' : 'prop')) return '';
    const type = scope === 'edge' ? 'edge' : target.type;
    const mean = SD.optSimple ? SD.optSimple(type, d.key, lc.value) : null;
    const eff = lc.effects || [], nodeEff = eff.filter(x => !TOP.includes(x.l)), topEff = eff.filter(x => TOP.includes(x.l));
    let h = `<div class="chg" role="status"><div class="chg-head"><span class="eyebrow">Что изменилось и почему</span><button type="button" class="chg-x" data-act="chgclose" aria-label="Скрыть">×</button></div><ol class="chg-chain">`;
    h += `<li><b>Ты поменял</b><span>${esc(d.label)}: ${esc(SD.valueLabel(d, lc.prev))} → <b>${esc(SD.valueLabel(d, lc.value))}</b></span></li>`;
    if (mean) h += `<li><b>Что это делает</b><span>${esc(mean)}</span></li>`;
    if (type === 'sql' && d.key === 'isolation' && SD.ISOLATION[lc.value]) {
      const pr = SD.ISOLATION[lc.value].prevents, all = Object.keys(SD.ANOMALIES);
      const yes = all.filter(k => pr.includes(k)).map(k => SD.ANOMALIES[k].name), no = all.filter(k => !pr.includes(k)).map(k => SD.ANOMALIES[k].name);
      h += `<li><b>Защита данных</b><span>Защищает от: ${esc(yes.join(', '))}.${no.length ? ` Ещё возможны: ${esc(no.join(', '))}.` : ' Возможных аномалий не осталось.'}${SD.ISOLATION[lc.value].cap < 1 ? ` Цена — откаты: база успевает примерно ${Math.round(SD.ISOLATION[lc.value].cap * 100)} % записей от Read committed.` : ''}</span></li>`;
    }
    const story = type === 'sql' && d.key === 'isolation' ? SD.ISO_STORY && SD.ISO_STORY[lc.value] : type === 'sql' && d.key === 'locking' ? SD.LOCK_STORY && SD.LOCK_STORY[lc.value] : null;
    if (story) h += `<li><b>Как это выглядит</b><span>${esc(story)}</span></li>`;
    h += `<li><b>На схеме</b><span>${nodeEff.length ? chips(nodeEff) : 'Загрузка узлов почти не изменилась.'}</span></li>`;
    const st = stressOf(A, scope, target, d, lc);
    h += `<li><b>Итог</b><span>${topEff.length ? chips(topEff) : st ? st.calm : 'Главные цифры не изменились. Эффект проявится при другой нагрузке, при падении узла или в надёжности данных — сравни все варианты.'}</span></li>`;
    if (st) h += `<li><b>${esc(st.title)}</b><span>${st.chips.length ? chips(st.chips) : 'И в этом случае разницы почти нет.'}${st.note ? `<small class="chg-note">${esc(st.note)}</small>` : ''}</span></li>`;
    h += '</ol>';
    const dive = lc.card && lc.card.dive && SD.DIVES[lc.card.dive] ? lc.card.dive : null;
    const live = scope === 'edge' && ['timeout', 'retries', 'backoff', 'cb', 'fallback'].includes(d.key);
    h += `<div class="chg-acts"><button type="button" class="btn" data-act="chgundo">↶ Вернуть как было</button>${SD.guide ? `<button type="button" class="btn" data-${scope === 'edge' ? 'eguide' : 'guide'}="${d.key}">Сравнить все варианты</button>` : ''}${live ? '<button type="button" class="btn" data-act="resil">Посмотреть вживую</button>' : dive ? `<button type="button" class="btn ghost" data-dive="${dive}">Как это выглядит</button>` : ''}</div></div>`;
    return h;
  }

  function liveStats(A, n) {
    const r = A.res && A.res.nodes[n.id];
    if (!r || n.type === 'client') return '';
    let rows = [];
    rows.push(['Загрузка', r.dead ? 'лежит' : Math.round(r.util * 100) + ' %', r.status]);
    rows.push(['Поток', F().num(r.rps) + ' /с']);
    if (isFinite(r.cap) && r.cap > 0 && r.cap < 1e6) rows.push(['Ёмкость', F().num(r.cap) + ' /с']);
    if (r.count > 1 || r.alive < r.count) rows.push(['Экземпляры', `${r.alive} из ${r.count}${r.used < r.alive ? `, работают ${r.used}` : ''}`]);
    const i = r.info || {};
    if (n.type === 'sql') {
      rows.push(['Primary (запись)', Math.round(i.uW * 100) + ' %', i.uW > 1 ? 'hot' : i.uW > 0.75 ? 'warn' : 'ok']);
      if (i.R > 0) rows.push(['Реплики (чтение)', Math.round(i.uR * 100) + ' %', i.uR > 1 ? 'hot' : i.uR > 0.75 ? 'warn' : 'ok'], ['Лаг реплик', F().ms(i.lag)]);
      rows.push(['Соединений', `${i.conns} из ${n.props.pooler ? '10 000 (PgBouncer)' : i.connLimit}`, i.connOk < 1 ? 'hot' : 'ok']);
      if (i.abort > 0.005) rows.push(['Откаты и повторы', Math.round(i.abort * 100) + ' %']);
      rows.push(['Индексов', i.nIdx]);
      if (i.needGb) rows.push(['Горячие данные + индексы', `${Math.round(i.needGb)} из ${i.ram} ГБ RAM`, i.spill > 1 ? 'warn' : 'ok']);
    }
    if (n.type === 'ws' && i.conns != null) rows.push(['Соединений', `${F().num(i.conns)} из ${F().num(i.connCap)}`]);
    if (n.type === 'llm' && i.ttft != null) rows.push(['До первого токена', F().ms(i.ttft)], ['Генерация ответа', F().ms(i.gen)]);
    if (n.type === 'vectordb' && i.mem) rows.push(['Индекс в памяти', `${Math.round(i.mem.needGb)} из ${i.mem.have} ГБ`, i.mem.ok ? 'ok' : 'warn']);
    const q = A.res.queues[n.id];
    if (q) rows.push(['Приходит', F().num(q.in) + ' /с'], ['Разбирается', F().num(q.drain) + ' /с'], ['Потребителей', q.consumers], ['Потери', F().num(q.lost * 60) + ' /мин', q.lost > 0.01 ? 'hot' : 'ok'], ['Дубли', F().num(q.dup * 60) + ' /мин', q.dup > 0.01 ? 'warn' : 'ok']);
    rows.push(['Стоимость', F().usd(r.cost || 0) + ' /мес']);
    const kinds = Object.entries(r.load).filter(([, v]) => v > 0.001).sort((a, b) => b[1] - a[1]).slice(0, 5);
    let h = `<h3>Сейчас</h3><dl class="kv">${rows.map(([a, b, c]) => `<dt>${a}</dt><dd class="${c || ''}">${b}</dd>`).join('')}</dl>`;
    if (kinds.length) h += `<div class="kind-pills">${kinds.map(([k, v]) => `<span class="chip"><i class="kdot" style="background:${SD.kindColor(k)}"></i>${esc((SD.KINDS[k] || SD.KINDS[SD.KIND_ALIAS[k]] || { label: k }).label)} ${F().num(v)}/с</span>`).join('')}</div>`;
    return h;
  }

  function nodeView(A, n) {
    const t = SD.TYPES[n.type], inf = t.info;
    let h = `<div class="insp-head">${SD.icon(n.type)}<div><input class="rename" id="rename_${n.id}" data-rename="1" value="${esc(n.label || t.name)}" aria-label="Название узла"><small>${esc(t.name)} · ${esc(t.short)}</small></div></div>`;
    const sim = SD.SIMPLE_TYPES && SD.SIMPLE_TYPES[n.type];
    if (sim) h += `<div class="simple sm"><span class="eyebrow">Простыми словами</span><span class="an">${esc(sim[1])}</span><span class="pl">${esc(sim[0])}</span></div>`;
    h += `<p>${esc(inf.what)}</p>`;
    if (SD.xray && SD.xray.has(n.type)) h += `<button type="button" class="dive-cta xr-cta" data-act="xray" data-id="${n.id}">${SD.icon(n.type)}<span><b>Провалиться внутрь — вживую</b><small>${esc(SD.XRAY[n.type].cta || 'Что происходит внутри узла прямо сейчас')}. Или двойной клик по узлу.</small></span></button>`;
    if (SD.guide && n.type !== 'client') h += `<button type="button" class="dive-cta" data-act="guide" data-id="${n.id}">${SD.icon(n.type)}<span><b>Как устроен и что дают настройки</b><small>На пальцах, по шагам, со сравнением вариантов на твоей схеме</small></span></button>`;
    h += liveStats(A, n);
    if (SD.calc && n.type !== 'client') { try { h += SD.calc.nodeBlock(A, n); } catch (e) { /* формула не посчиталась — без неё */ } }
    if (SD.archLens && n.type !== 'client') h += SD.archLens.nodeBlock(n.id, 'node');
    if ((n.type === 'app' || n.type === 'worker') && SD.innerUI) {
      const k = n.props.inner && n.props.inner.nodes ? n.props.inner.nodes.length : 0;
      const an = k ? SD.inner.analyze(n, A.graph, A.res1 || A.res).counts : null;
      h += `<button type="button" class="dive-cta" data-act="inner" data-id="${n.id}">${SD.icon('app')}<span><b>Слои кода: роуты, сервисный слой, репозитории</b><small>${k ? `${k} компонентов · ошибок ${an.bad}, рисков ${an.warn}` : 'Собрать и поменять свои слои (или порты и адаптеры, CQRS), посмотреть трассу запроса и код каждого компонента. Живьём слои видны в «Провалиться внутрь» → «Слои кода».'}</small></span></button>`;
    }
    const props = (t.props || []).map(d => propControl(A, n, d) + changePanel(A, 'node', n, d)).join('');
    if (props) h += `<h3>Настройки</h3><div class="props">${props}</div>`;
    if (n.type === 'queue') { const e = SD.ENGINES[n.props.engine]; h += `<p class="note">${esc(e.note)}</p>`; }
    h += `<h3>Зачем он нужен</h3><p>${esc(inf.why)}</p>`;
    if (inf.pros.length || inf.cons.length) h += `<div class="pc"><div class="plus"><b>Плюсы</b><ul>${inf.pros.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div><div class="minus"><b>Минусы</b><ul>${inf.cons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`;
    h += `<h3>В реальности</h3><p>${esc(inf.real)}</p>`;
    if (inf.numbers && inf.numbers.length) h += `<table class="numbers"><tbody>${inf.numbers.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>`;
    if (t.dive && SD.DIVES[t.dive]) h += `<button type="button" class="dive-cta" data-dive="${t.dive}">${SD.icon(n.type)}<span><b>Как это работает</b><small>${esc(SD.DIVES[t.dive].title)}: пошагово, с кодом</small></span></button>`;
    const chaosable = SD.sim.CHAOS_TYPES.has(n.type) || (SD.AI_TYPES_SET && SD.AI_TYPES_SET.has(n.type) && !['router', 'semcache'].includes(n.type));
    h += `<div class="row-btns">`;
    if (chaosable) h += `<button type="button" class="btn" data-act="kill" data-id="${n.id}">Уронить экземпляр</button>${A.down[n.id] ? `<button type="button" class="btn" data-act="heal" data-id="${n.id}">Поднять</button>` : ''}`;
    h += `<button type="button" class="btn" data-act="explainnode" data-id="${n.id}">Объяснить узел</button>`;
    if (!t.fixed) h += `<button type="button" class="btn ghost danger" data-act="delnode" data-id="${n.id}">Удалить узел</button>`;
    h += `</div>`;
    return h;
  }

  function edgeView(A, e) {
    if (!e) return overview(A);
    const a = A.graph.nodes.find(x => x.id === e.from), b = A.graph.nodes.find(x => x.id === e.to);
    const k = SD.edgeKind(a, b);
    const p = Object.assign(SD.edgeDefaults(), e.props);
    const er = A.res && A.res.edges[e.id];
    const nm = n => esc(n.label || SD.TYPES[n.type].name);
    if (k.ops) {
      const tool = SD.TYPES[b.type].ops ? b : a, other = tool === b ? a : b, ok = SD.TYPES[tool.type].ops;
      const WHAT = { metrics: ['отдаёт метрики', 'Prometheus каждые несколько секунд забирает у «' + nm(other) + '» счётчики: запросы, ошибки, задержку, CPU.'], logs: ['пишет логи', '«' + nm(other) + '» пишет логи в stdout, агент на сервере отправляет их в Elasticsearch — там их ищут в Kibana.'], traces: ['отправляет трейсы', '«' + nm(other) + '» отправляет отрезки каждого запроса (spans) с trace id — Jaeger собирает из них путь запроса.'], dash: ['рисует графики', 'Grafana берёт данные из Prometheus и строит дашборды.'], alerts: ['передаёт сработавшие правила', 'Prometheus проверяет правила и отправляет сработавшие в Alertmanager, тот — дежурному.'], k8s: ['разворачивает и лечит', 'Kubernetes запускает поды «' + nm(other) + '», раскладывает их по серверам и сам поднимает упавшие.'] }[ok] || ['связь', ''];
      let h2 = `<div class="insp-head"><span class="edge-ico">⇢</span><div><b>${nm(a)} → ${nm(b)}</b><small>${WHAT[0]} · трафик пользователей сюда не идёт</small></div></div>`;
      h2 += `<div class="simple sm"><span class="eyebrow">Что по ней идёт</span><span class="an">${WHAT[1]}</span></div>`;
      if (SD.xray && SD.xray.has(tool.type)) h2 += `<button type="button" class="dive-cta xr-cta" data-act="xray" data-id="${tool.id}">${SD.icon(tool.type)}<span><b>Открыть «${nm(tool)}» изнутри</b><small>Живые данные твоей схемы и как он устроен</small></span></button>`;
      return h2;
    }
    let h = `<div class="insp-head"><span class="edge-ico">→</span><div><b>${nm(a)} → ${nm(b)}</b><small>${er && er.async ? 'асинхронная доставка' : k.resil ? 'синхронный вызов' : 'поток данных'}</small></div></div>`;
    if (er) {
      const kinds = Object.entries(er.byKind).filter(([, v]) => v > 0.001);
      h += `<h3>Сейчас</h3><dl class="kv"><dt>Поток</dt><dd>${F().num(er.flow)} /с</dd>`;
      if (er.info) {
        h += `<dt>Время вызова</dt><dd>${F().ms(er.info.lat)}</dd><dt>Успешных вызовов</dt><dd class="${er.info.s < 0.99 ? 'bad' : 'ok'}">${F().pct(er.info.s)}</dd>`;
        if (er.info.amp > 1.01) h += `<dt>Раздувание повторами</dt><dd class="${er.info.amp > 1.3 ? 'bad' : 'warn'}">×${er.info.amp.toFixed(2).replace('.', ',')}</dd>`;
        if (er.info.tf > 0.001) h += `<dt>Обрывается таймаутом</dt><dd class="warn">${Math.round(er.info.tf * 100)} %</dd>`;
        if (p.cb) h += `<dt>Circuit breaker</dt><dd class="${er.info.open ? 'bad' : 'ok'}">${er.info.open ? 'разомкнут' : 'замкнут'}</dd>`;
      }
      h += `</dl>`;
      if (kinds.length) h += `<div class="kind-pills">${kinds.map(([kk, v]) => `<span class="chip"><i class="kdot" style="background:${SD.kindColor(kk)}"></i>${esc((SD.KINDS[kk] || SD.KINDS[SD.KIND_ALIAS[kk]] || { label: kk }).label)} ${F().num(v)}/с</span>`).join('')}</div>`;
    }
    const ED = key => (SD.EDGE_DEFS || []).find(x => x.key === key);
    const eq = key => SD.guide ? `<button type="button" class="qhelp" data-eguide="${key}" title="На пальцах и сравнение вариантов" aria-label="Подробнее">?</button>` : '';
    const cp = key => changePanel(A, 'edge', e, ED(key));
    if (k.resil && (SD.labs || SD.guide)) h += `<button type="button" class="dive-cta" data-act="resil">${SD.icon('external')}<span><b>Посмотреть вживую, как работает вызов</b><small>Сломай соседа и смотри на каждый запрос: таймаут, повторы, предохранитель, fallback</small></span></button>`;
    if (SD.archLens && k.resil) h += SD.archLens.nodeBlock(e.id, 'edge');
    if (k.proto) {
      h += `<h3>Протокол</h3><div class="props"><div class="prop"><label for="ep_proto">Формат и транспорт${eq('proto')}</label><select id="ep_proto" data-eprop="proto">${Object.entries(SD.PROTOCOLS).map(([kk, v]) => `<option value="${kk}" ${p.proto === kk ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select><div class="help">${esc(SD.PROTOCOLS[p.proto].note)}</div></div>${cp('proto')}</div>`;
    }
    if (k.resil) {
      h += `<h3>Устойчивость вызова</h3><div class="props">`;
      h += `<div class="prop"><label for="ep_to">Таймаут${eq('timeout')}</label><select id="ep_to" data-eprop="timeout">${SD.TIMEOUTS.map(([v, t]) => `<option value="${v}" ${p.timeout === v ? 'selected' : ''}>${t}</option>`).join('')}</select><div class="help">Сколько ждать ответа. Без таймаута поток сервиса ждёт медленную зависимость сколько угодно.</div></div>${cp('timeout')}`;
      h += `<div class="prop"><label for="ep_rt">Повторы при ошибке <output>${p.retries}</output>${eq('retries')}</label><input type="range" id="ep_rt" data-eprop="retries" min="0" max="5" step="1" value="${p.retries}"><div class="help">Спасают от случайных сбоев. При перегрузке добавляют нагрузку.</div></div>${cp('retries')}`;
      h += `<div class="prop"><label for="ep_bo">Пауза между повторами${eq('backoff')}</label><select id="ep_bo" data-eprop="backoff"><option value="none" ${p.backoff === 'none' ? 'selected' : ''}>Сразу</option><option value="exp" ${p.backoff === 'exp' ? 'selected' : ''}>Экспоненциальная с джиттером</option></select></div>${cp('backoff')}`;
      h += `<label class="switch"><input type="checkbox" id="ep_cb" data-eprop="cb" ${p.cb ? 'checked' : ''}><span><b>Circuit breaker</b><small>Если больше половины вызовов падает, предохранитель размыкается и запросы отбиваются сразу, не нагружая упавший сервис.</small></span>${eq('cb')}</label>${cp('cb')}`;
      h += `<label class="switch"><input type="checkbox" id="ep_fb" data-eprop="fallback" ${p.fallback ? 'checked' : ''}><span><b>Fallback</b><small>При отказе вернуть упрощённый ответ: страница без рекомендаций, цена из кэша.</small></span>${eq('fallback')}</label>${cp('fallback')}`;
      h += `</div>`;
    }
    if (!k.proto && !k.resil) h += `<p class="note">У этой связи нет настроек: протокол задаётся типом узла (SQL, RESP, протокол брокера).</p>`;
    h += `<div class="row-btns"><button type="button" class="btn primary" data-act="explainedge">Объяснить интеграцию</button>${SD.DIVES.resilience && k.resil ? '<button type="button" class="btn" data-dive="resilience">Разбор: повторы и предохранители</button>' : ''}${SD.DIVES.protocols && k.proto ? '<button type="button" class="btn" data-dive="protocols">Разбор: протоколы</button>' : ''}<button type="button" class="btn ghost danger" data-act="deledge">Удалить связь</button></div>`;
    return h;
  }

  SD.inspector = { render };
})();
