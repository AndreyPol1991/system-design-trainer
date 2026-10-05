/* Панели: задание, метрики (полоса и вкладка), карта уровней, справочник. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const F = () => SD.fmt;
  const $ = id => document.getElementById(id);
  const stars = n => '★'.repeat(n) + '☆'.repeat(3 - n);
  const tierLabel = id => (SD.TIERS.find(t => t.id === id) || { label: 'Песочница' }).label;

  /* ---------- полоса метрик под схемой ---------- */
  const PREV = {};
  function metrics(A) {
    const r = A.res; if (!r) return;
    const g = t => A.goals && A.goals.find(x => x.t === t);
    const empty = A.graph.nodes.every(n => n.type === 'client');
    const cls = t => { const x = g(t); return empty ? '' : x ? (x.ok ? 'ok' : 'bad') : ''; };
    const items = [
      ['Нагрузка', F().num(r.total.rps) + ' RPS', '', `×${A.mul.toFixed(2).replace('.', ',').replace(/0$/, '')}`],
      ['Успешно', empty ? '—' : F().pct(r.total.success), empty ? '' : r.total.success >= 0.999 ? 'ok' : r.total.success >= 0.99 ? 'warn' : 'bad', empty ? 'схема пока пустая' : r.total.degraded > 0.005 ? `упрощённо ${Math.round(r.total.degraded * 100)} %` : 'ответов'],
      ['Время ответа', empty ? '—' : F().ms(r.total.lat), cls('latency'), 'в среднем'],
      ['В месяц', F().usd(r.cost), cls('cost'), r.ai && r.ai.tokenCost > 1 ? `токены ${F().usd(r.ai.tokenCost)}` : 'инфраструктура']
    ];
    if (r.jobs.in > 0) items.push(['Очередь', F().num(A.backlog) + ' сообщ.', r.jobs.backlogRate > 0.5 ? 'bad' : 'ok', r.jobs.backlogRate > 0.5 ? `+${F().num(r.jobs.backlogRate)}/с` : `${F().num(r.jobs.in)}/с на входе`]);
    if (r.jobs.lostRate > 0.01) items.push(['Потери', F().num(r.jobs.lostRate * 60) + '/мин', 'bad', 'задач и событий']);
    if (r.jobs.dupRate > 0.01) items.push(['Дубли', F().num(r.jobs.dupRate * 60) + '/мин', 'warn', 'повторная обработка']);
    if (r.ai && r.ai.quality != null) items.push(['Качество AI', Math.round(r.ai.quality * 100) + ' %', cls('quality'), F().num(r.ai.tokensPerSec) + ' ток/с']);
    if (r.kinds.inject) items.push(['Атаки', Math.round(r.kinds.inject.passed * 100) + ' %', r.kinds.inject.passed > 0.15 ? 'bad' : 'ok', 'доходят до модели']);
    if (r.kinds.bot) items.push(['Боты', Math.round(r.kinds.bot.passed * 100) + ' %', r.kinds.bot.passed > 0.1 ? 'bad' : 'ok', 'доходят до сервисов']);
    const downN = Object.values(A.down).reduce((s, v) => s + v, 0);
    if (downN) items.push(['Хаос', `−${downN} экз.`, 'bad', 'упало']);
    const now = { 'Успешно': [r.total.success, true], 'Время ответа': [r.total.lat, false], 'В месяц': [r.cost, false] };
    const fx = a => { const v = now[a], p = PREV[a]; if (!v || p == null || Math.abs(v[0] - p) <= Math.max(1e-6, Math.abs(p) * 0.004)) return ''; return (v[0] > p) === v[1] ? ' flash-up' : ' flash-down'; };
    $('metrics').innerHTML = items.map(([a, b, c, d]) => `<div class="metric"><small>${a}</small><b class="${c}${fx(a)}">${b}</b><span>${esc(d)}</span></div>`).join('');
    Object.entries(now).forEach(([k, v]) => { PREV[k] = v[0]; });
  }

  /* ---------- вкладка «Задание» ---------- */
  function task(A) {
    const L = A.level, pane = $('paneTask');
    const idx = SD.LEVELS.indexOf(L);
    const kinds = Object.entries(L.traffic).filter(([, v]) => v > 0);
    const prog = A.progress[L.id] || {};
    let h = '';
    if (SD.walk && SD.walk.active()) h += SD.walk.paneHtml();
    h += `<span class="eyebrow">${L.free ? `Свободный режим · кейс «${esc(L.free.baseTitle)}»` : L.daily ? `Событие дня · по уровню «${esc(L.daily.baseTitle)}»` : L.sandbox ? 'Песочница' : L.interview ? 'Собеседование · этап «Схема»' : L.innerLvl ? 'Внутри сервиса · C4, уровень компонентов' : L.knobLvl ? 'Настройки на пальцах' : L.dataLvl ? 'Данные: от события до дашборда' : L.opsLvl ? 'Эксплуатация и инструменты' : L.archLvl ? 'Архитектура из сервисов' : L.practice ? 'Практикум паттернов' : L.fix ? 'Найди и перестрой · инцидент' : `Уровень ${idx + 1} · ${tierLabel(L.tier)}`}</span>`;
    h += `<h2>${esc(L.title)}</h2>`;
    h += `<p class="story" style="margin-top:8px">${esc(L.story)}</p>`;
    if (SD.free) h += SD.free.taskBlock(A);
    if (L.chips) h += `<div class="chips-row">${L.chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>`;
    if (L.interview && SD.interview) h += SD.interview.paneBlock(A);
    if (L.innerTarget && SD.innerUI) h += `<button type="button" class="dive-cta" data-act="inner" data-id="${L.innerTarget}">${SD.icon('app')}<span><b>Открыть сервис изнутри</b><small>Слои, порты, адаптеры, трасса и код. Двойной клик по сервису на схеме делает то же самое.</small></span></button>`;
    if (L.focus && SD.guide && A.graph.nodes.some(x => x.id === L.focus.node)) { const fn = A.graph.nodes.find(x => x.id === L.focus.node), fd = (SD.TYPES[fn.type].props || []).find(p => p.key === L.focus.prop); h += `<button type="button" class="dive-cta" data-act="guide" data-id="${fn.id}" data-key="${L.focus.prop}">${SD.icon(fn.type)}<span><b>«${esc(fd ? fd.label : L.focus.prop)}» на пальцах</b><small>Что это, как работает и сравнение всех вариантов на этой схеме</small></span></button>`; }
    if (SD.opsTaskCta) h += SD.opsTaskCta(L);
    if (SD.dataTaskCta) h += SD.dataTaskCta(L);
    if ((L.practice || L.innerLvl || L.knobLvl || L.archLvl || L.opsLvl || L.dataLvl) && L.pattern) h += `<button type="button" class="dive-cta" data-act="patcard">${SD.icon('app')}<span><b>Карточка паттерна</b><small>Проблема, решение, код и связанные паттерны</small></span></button>`;
    if (L.diagnose) {
      const pick = (A.diagPick || {})[L.id], ok = SD.DIAG[L.id];
      h += `<div class="q diag"><p>Шаг 1. Что сломано? Какой это антипаттерн?</p><div class="opts">`;
      L.diagnose.opts.forEach(id => { const p = SD.PATTERNS.find(x => x.id === id); if (!p) return; const cls = pick === id ? (id === L.diagnose.answer ? 'right' : 'wrong') : ok && id === L.diagnose.answer ? 'right' : ''; h += `<button type="button" class="opt ${cls}" data-diag="${id}">${esc(p.name)}</button>`; });
      h += '</div>';
      if (pick) { const p = SD.PATTERNS.find(x => x.id === L.diagnose.answer); h += pick === L.diagnose.answer ? `<div class="fb"><b>Верно.</b> ${esc(p.why)} Лечение: ${esc(p.fix)} <button class="linkish" type="button" data-pat="${p.id}">Карточка</button></div>` : '<div class="fb">Не то. Посмотри на метрики и советы прораба: где перегрузка и почему.</div>'; }
      h += `</div><p class="note" style="margin-top:8px">Шаг 2. Перестрой систему так, чтобы цели ниже выполнились.</p>`;
    }
    if (L.sandbox) h += sandboxControls(L);
    else {
      h += `<h3>Нагрузка${SD.calc && SD.calc.usable(L) && (!SD.free || SD.free.hintsOn()) ? ' <button type="button" class="linkish calc-open" data-calcopen>Как посчитать ›</button>' : ''}</h3><div class="traffic">${kinds.map(([k, v]) => `<div><small><i style="background:${SD.kindColor(k)}"></i>${esc(SD.KINDS[k].label)}</small><b>${F().num(v)} /с</b></div>`).join('')}</div>`;
      const extra = [];
      if (L.global) extra.push('пользователи по всему миру: пинг до дата-центра ≈ 140 мс');
      if (L.connections) extra.push(`${F().num(L.connections)} открытых соединений`);
      if (L.contention) extra.push(`конкуренция за одни строки ${Math.round(L.contention * 100)} %`);
      if (L.job) extra.push(`фоновая задача «${L.job.label}»: ${F().ms(L.job.ms)}`);
      if (L.ext) extra.push(`${L.ext.name}: ${F().ms(L.ext.ms)}, лимит ${F().num(L.ext.cap)}/с, ошибок ${Math.round(L.ext.fail * 100)} %`);
      if (extra.length) h += `<ul class="facts">${extra.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    }
    if (!L.sandbox) {
      h += `<h3>Цели ${A.mul !== 1 || Object.keys(A.down).length ? '<span class="note">проверяются при нагрузке ×1 без сбоев</span>' : ''}</h3><ul class="goals">`;
      const built = A.graph.nodes.some(n => n.type !== 'client' && !(L.preset || []).some(p => p[0] === n.id)), flowing = A.res1 && A.res1.total.success > 0.001;
      (A.goals || []).forEach((g, gi) => {
        const pend = !built || (!flowing && g.ok && (g.t === 'latency' || g.t === 'cost'));
        if (pend) { h += `<li class="pend"><span class="st">·</span><span class="gt">${esc(g.text)}<span class="gd">${!built ? 'ещё нечего проверять — собери систему' : 'проверим, когда пойдут успешные ответы'}</span></span></li>`; return; }
        h += `<li class="${g.ok ? 'ok' : 'bad'}"><span class="st">${g.ok ? '✓' : '·'}</span><span class="gt">${esc(g.text)}<span class="gd">${esc(g.detail)}</span>${SD.learn ? SD.learn.goalExtra(A, gi) : ''}</span></li>`;
      });
      h += `</ul>`;
      if (SD.walk) h += SD.walk.compareHtml(A);
      const all = A.goals && A.goals.length && A.goals.every(g => g.ok);
      const quizAll = L.decisions.every((_, i) => (A.quiz[L.id] || {})[i] === 'right');
      const cheap = L.stretch && A.res.cost <= L.stretch.cost;
      if (all && L.interview) h += `<div class="verdict win"><b>Схема выполняет все цели</b><span>Симулятор доволен. Вернись к этапам: интервьюер спросит про узкие места и компромиссы.</span><button class="btn primary" type="button" data-act="intback">← К этапам собеседования</button></div>`;
      else if (all) {
        const st = 1 + (quizAll ? 1 : 0) + (cheap ? 1 : 0);
        h += `<div class="verdict win"><b>Система держит нагрузку ${stars(st)}</b>`;
        h += `<span>${cheap ? 'Уложились в бюджет мастера.' : `Звезда за экономию: уложись в ${F().usd(L.stretch.cost)}.`} ${quizAll ? 'Все решения обоснованы.' : 'Ответь на вопросы ниже, чтобы получить звезду за решения.'}</span>`;
        if (SD.nextLevel(L)) h += `<button class="btn primary" type="button" data-act="next">${L.practice ? 'Следующий паттерн →' : 'Следующий уровень →'}</button>`;
        h += `</div>`;
      } else if (prog.stars) h += `<div class="verdict"><span>Лучший результат: ${stars(prog.stars)}</span></div>`;
    }
    if (SD.archLens && !L.interview && (!SD.free || SD.free.hintsOn())) h += SD.archLens.card(A);
    if (SD.free && !SD.free.hintsOn()) h += `<h3>Прораб видит</h3><p class="note">Скрыто: свободный режим. Нужна помощь — «Показать подсказки» вверху.</p>`;
    else if (A.advice && A.advice.length && A.graph.nodes.every(n => n.type === 'client')) h += `<h3>Прораб видит</h3><div class="advice"><div class="adv info"><span>Схема пока пустая: запросам некуда идти. Поставь первый узел из палитры и соедини его с «Пользователями».</span></div></div>`;
    else if (A.advice && A.advice.length) {
      h += `<h3>Прораб видит</h3><div class="advice">`;
      A.advice.slice(0, 7).forEach(a => {
        h += `<div class="adv ${a.sev}"><span>${esc(a.text)}${a.dive && SD.DIVES[a.dive] ? ` <button class="linkish" type="button" data-dive="${a.dive}">Как это работает</button>` : ''}${a.node ? ` <button class="linkish" type="button" data-sel="${a.node}">Показать</button>` : ''}${a.edge ? ` <button class="linkish" type="button" data-sele="${a.edge}">Показать связь</button>` : ''}</span></div>`;
      });
      if (A.advice.length > 7) h += `<div class="adv info"><span>И ещё ${A.advice.length - 7}. Исправь главное, и список обновится.</span></div>`;
      h += `</div>`;
    } else if (A.res && !L.sandbox) h += `<h3>Прораб видит</h3><div class="advice"><div class="adv good"><span>Перегрузок и явных ошибок нет.</span></div></div>`;
    if (L.hints && L.hints.length) {
      const shown = A.hintsShown[L.id] || 0;
      h += `<h3>Подсказки</h3><div class="hint-box">`;
      L.hints.slice(0, shown).forEach((x, i) => { h += `<div class="hint"><b>${i + 1}.</b> ${esc(x.text)}<span class="why">Почему: ${esc(x.why)}</span></div>`; });
      if (shown < L.hints.length) h += `<button class="btn" type="button" data-act="hint">${shown ? 'Ещё подсказка' : 'Показать подсказку'} (${shown + 1} из ${L.hints.length})</button>`;
      h += `</div>`;
    }
    if (L.decisions && L.decisions.length) {
      h += `<h3>Архитектурные решения</h3><div class="quiz">`;
      L.decisions.forEach((q, qi) => {
        const ans = (A.quiz[L.id] || {})[qi];
        const picked = (A.quizPick[L.id] || {})[qi];
        h += `<div class="q"><p>${esc(q.q)}</p><div class="opts">`;
        q.opts.forEach((o, oi) => {
          const c = picked === oi ? (o.v === 'right' ? 'right' : o.v === 'partial' ? 'partial' : 'wrong') : '';
          h += `<button type="button" class="opt ${c}" data-q="${qi}" data-o="${oi}">${esc(o.t)}</button>`;
        });
        h += `</div>`;
        if (picked != null) h += `<div class="fb">${esc(q.opts[picked].fb)}</div>`;
        h += `</div>`;
        void ans;
      });
      h += `</div>`;
    }
    if (L.solution) h += `<p class="solnote">Решений обычно несколько. Эталон — одно из них, его можно открыть кнопкой «Эталон» над схемой.</p>`;
    pane.innerHTML = h;
  }

  function sandboxControls(L) {
    let h = `<h3>Нагрузка, запросов в секунду</h3><div class="sb-grid">`;
    Object.keys(L.traffic).forEach(k => {
      h += `<label class="sb-field"><span><i style="background:${SD.kindColor(k)}"></i>${esc(SD.KINDS[k].label)}</span><input type="number" min="0" step="any" id="sb_${k}" data-sb="${k}" value="${L.traffic[k]}"></label>`;
    });
    h += `</div><h3>Условия</h3><div class="props">`;
    h += `<label class="switch"><input type="checkbox" id="sb_global" data-sbf="global" ${L.global ? 'checked' : ''}><span>Пользователи по всему миру (пинг 140 мс)</span></label>`;
    h += `<div class="prop"><label for="sb_cont">Конкуренция за одни строки <output>${Math.round((L.contention || 0) * 100)} %</output></label><input type="range" id="sb_cont" data-sbf="contention" min="0" max="1" step="0.05" value="${L.contention || 0}"></div>`;
    h += `<div class="prop"><label for="sb_hot">Горячие данные для кэша <output>${L.hotSetGb} ГБ</output></label><input type="range" id="sb_hot" data-sbf="hotSetGb" min="1" max="128" step="1" value="${L.hotSetGb}"></div>`;
    h += `<div class="prop"><label for="sb_conn">Открытых соединений (чат) <output>${F().num(L.connections)}</output></label><input type="range" id="sb_conn" data-sbf="connections" min="0" max="3000000" step="50000" value="${L.connections}"></div>`;
    h += `<div class="prop"><label for="sb_job">Фоновая задача после записи</label><select id="sb_job" data-sbf="jobTarget">
      <option value="external" ${L.job.target === 'external' ? 'selected' : ''}>Вызов внешнего сервиса (500 мс)</option>
      <option value="cache" ${L.job.target === 'cache' ? 'selected' : ''}>Раскладка в кэш (fan-out ×200)</option>
      <option value="nosql" ${L.job.target === 'nosql' ? 'selected' : ''}>Запись в витрину NoSQL</option>
      <option value="objstore" ${L.job.target === 'objstore' ? 'selected' : ''}>Обработка файла (CPU 20 с)</option>
      <option value="vectordb" ${L.job.target === 'vectordb' ? 'selected' : ''}>Индексация документа для RAG</option></select></div>`;
    h += `</div>`;
    return h;
  }

  /* ---------- вкладка «Метрики» ---------- */
  function stats(A) {
    const r = A.res, pane = $('paneStats');
    if (!r) { pane.innerHTML = '<p class="empty">Собери схему, и здесь появятся метрики.</p>'; return; }
    let h = `<h3 style="margin-top:0">По видам запросов</h3><div class="tbl"><table class="kind-table"><thead><tr><th>Вид</th><th>RPS</th><th>Время</th><th>Успешно</th></tr></thead><tbody>`;
    Object.entries(r.kinds).forEach(([k, v]) => {
      const special = k === 'bot' || k === 'inject';
      const s = special ? `${Math.round((v.passed || 0) * 100)} % прошло` : F().pct(v.success);
      const c = special ? ((v.passed || 0) > 0.15 ? 'bad' : 'ok') : v.success >= 0.999 ? 'ok' : v.success >= 0.99 ? 'warn' : 'bad';
      h += `<tr><td><i class="kdot" style="background:${SD.kindColor(k)}"></i>${esc(SD.KINDS[k].label)}</td><td>${F().num(v.rps)}</td><td>${special ? '—' : F().ms(v.lat)}</td><td class="${c}">${s}</td></tr>`;
    });
    h += `</tbody></table></div>`;
    h += `<h3>Во времени</h3>` + spark(A.history);
    if (r.ai) {
      h += `<h3>AI</h3><dl class="kv">`;
      if (r.ai.quality != null) h += `<dt>Качество ответов</dt><dd>${Math.round(r.ai.quality * 100)} %</dd>`;
      h += `<dt>Токенов в секунду</dt><dd>${F().num(r.ai.tokensPerSec)}</dd><dt>Токены и API в месяц</dt><dd>${F().usd(r.ai.tokenCost)}</dd>`;
      if (r.ai.fullAnswer) h += `<dt>Полный ответ модели</dt><dd>${F().ms(r.ai.fullAnswer)}</dd>`;
      h += `<dt>RAG</dt><dd>${r.ai.rag ? 'включён' : 'нет'}</dd>`;
      if (A.level.ai && A.level.ai.pii) h += `<dt>Утечка PII</dt><dd class="${r.ai.piiLeak ? 'bad' : 'ok'}">${r.ai.piiLeak ? 'да' : 'нет'}</dd>`;
      h += `</dl>`;
    }
    const an = A.anLive;
    if (an) {
      const block = (title, list, okText) => `<h3>${title}</h3><div class="advice">${list.length ? list.map(x => `<div class="adv warn"><span>${esc(x.text)}</span></div>`).join('') : `<div class="adv good"><span>${okText}</span></div>`}</div>`;
      h += block('Потери данных при сбое', an.durable, 'Подтверждённые записи переживают падение узла.');
      h += block('Свежесть чтений', an.fresh, 'Пользователь видит свои изменения сразу.');
      if (an.ordering.length || r.jobs.in > 0) h += block('Порядок событий', an.ordering, 'Порядок внутри ключа сохраняется.');
      const an2 = Object.entries(an.anomalies);
      if (an2.length) {
        h += `<h3>Аномалии конкурентного доступа</h3><div class="tbl"><table class="kind-table"><thead><tr><th>Аномалия</th>${an2.map(([id]) => `<th>${esc((SD.editor.node(id) || {}).label || 'БД')}</th>`).join('')}</tr></thead><tbody>`;
        Object.entries(SD.ANOMALIES).forEach(([k, v]) => {
          h += `<tr><td title="${esc(v.text)}">${esc(v.name)}</td>${an2.map(([, list]) => list.includes(k) ? '<td class="bad">возможна</td>' : '<td class="ok">нет</td>').join('')}</tr>`;
        });
        h += `</tbody></table></div><p class="note">Наведи на название, чтобы прочитать, что это. <button class="linkish" type="button" data-dive="isolation">Разбор уровней изоляции</button></p>`;
      }
    }
    const arch = SD.arch.analyze(A.graph, r);
    h += '<h3>Архитектура схемы</h3><div class="arch-list">';
    arch.styles.forEach(s => { h += `<div class="arch-item"><b>${esc(s.name)}</b>${esc(s.text)}${s.dive && SD.DIVES[s.dive] ? ` <button class="linkish" type="button" data-dive="${s.dive}">Как это работает</button>` : ''}</div>`; });
    arch.anti.forEach(s => { h += `<div class="arch-item anti"><b>Антипаттерн: ${esc(s.name)}</b>${esc(s.text)}${s.dive && SD.DIVES[s.dive] ? ` <button class="linkish" type="button" data-dive="${s.dive}">Разбор</button>` : ''}</div>`; });
    if (arch.good.length) h += `<div class="arch-item good"><b>Применённые приёмы</b>${arch.good.map(g => esc(g.name)).join(' · ')}</div>`;
    if (!arch.styles.length && !arch.anti.length) h += '<div class="arch-item">Схема пока слишком простая, чтобы назвать стиль.</div>';
    h += '</div>';
    if (r.data && r.data.fresh != null) h += `<dl class="kv" style="margin-top:10px"><dt>Свежесть отчётов</dt><dd>${!isFinite(r.data.fresh) ? 'данные не доходят' : r.data.fresh === 0 ? 'живая база' : r.data.fresh >= 3600 ? Math.round(r.data.fresh / 3600) + ' ч' : r.data.fresh >= 60 ? Math.round(r.data.fresh / 60) + ' мин' : Math.round(r.data.fresh) + ' с'}</dd></dl>`;
    if (r.jobs.in > 0) {
      h += `<h3>Очереди</h3><dl class="kv"><dt>На входе</dt><dd>${F().num(r.jobs.in)}/с</dd><dt>Накопилось</dt><dd>${F().num(A.backlog)}</dd><dt>Рост</dt><dd>${r.jobs.backlogRate > 0.5 ? '+' + F().num(r.jobs.backlogRate) + '/с' : 'нет'}</dd><dt>Потери</dt><dd>${F().num(r.jobs.lostRate * 60)}/мин</dd><dt>Дубли</dt><dd>${F().num(r.jobs.dupRate * 60)}/мин</dd></dl>`;
    }
    if (r.dist && (r.dist.inconsistent > 0.01 || r.dist.compensations > 0.01)) h += `<h3>Распределённые операции</h3><dl class="kv"><dt>Частичные операции</dt><dd>${F().num(r.dist.inconsistent * 60)}/мин</dd><dt>Компенсации саги</dt><dd>${F().num(r.dist.compensations * 60)}/мин</dd></dl>`;
    if (A.chaos && A.chaos.length) {
      h += `<h3>Хаос-тест: падает один экземпляр</h3><div class="tbl"><table class="kind-table"><tbody>`;
      A.chaos.forEach(c => { const n = SD.editor.node(c.id); if (!n) return; h += `<tr><td>${esc(n.label || SD.TYPES[n.type].name)}</td><td class="${c.ok ? 'ok' : 'bad'}">${F().pct(c.success)}</td></tr>`; });
      h += `</tbody></table></div>`;
    }
    const costs = A.graph.nodes.map(n => ({ n, c: (r.nodes[n.id] || {}).cost || 0 })).filter(x => x.c > 0).sort((a, b) => b.c - a.c);
    if (costs.length) {
      const max = costs[0].c;
      h += `<h3>Из чего складывается ${F().usd(r.cost)}</h3><div class="costs">`;
      costs.forEach(({ n, c }) => { h += `<div class="cost-row"><span>${esc(n.label || SD.TYPES[n.type].name)}</span><span class="cbar"><i style="width:${Math.max(2, c / max * 100)}%"></i></span><b>${F().usd(c)}</b></div>`; });
      h += `</div>`;
    }
    pane.innerHTML = h;
  }

  function spark(hist) {
    if (!hist || hist.length < 2) return '<p class="note">График появится через пару секунд работы симуляции.</p>';
    const W = 320, Hh = 70, n = hist.length;
    const x = i => 4 + i / (n - 1) * (W - 8);
    const ys = v => 8 + (1 - v) * (Hh - 20);
    const maxLat = Math.max(50, ...hist.map(p => Math.min(p.lat, 10000)));
    const yl = v => 8 + (1 - Math.min(v, 10000) / maxLat) * (Hh - 20);
    const pS = hist.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${ys(Math.max(0, (p.s - 0.9) / 0.1)).toFixed(1)}`).join(' ');
    const pL = hist.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yl(p.lat).toFixed(1)}`).join(' ');
    const last = hist[n - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-label="Успешность и задержка во времени">
      <line class="gl" x1="0" x2="${W}" y1="${ys(1)}" y2="${ys(1)}"></line><line class="gl" x1="0" x2="${W}" y1="${Hh - 12}" y2="${Hh - 12}"></line>
      <path class="ln" d="${pL}" style="stroke:var(--info)"></path>
      <path class="ln" d="${pS}" style="stroke:var(--ok)"></path>
      <circle cx="${x(n - 1)}" cy="${ys(Math.max(0, (last.s - 0.9) / 0.1))}" r="3" style="fill:var(--ok)"></circle>
      <text x="4" y="${Hh - 2}">успешно (90–100 %) · время ответа (до ${F().ms(maxLat)})</text></svg>
      <div class="legend-inline"><span><i style="background:var(--ok)"></i>успешно ${F().pct(last.s)}</span><span><i style="background:var(--info)"></i>время ${F().ms(last.lat)}</span></div>`;
  }

  /* ---------- карта уровней ---------- */
  function map(A) {
    let h = '<div class="tiers">';
    if (SD.daily) { try { h += SD.daily.mapHtml(A); } catch (e) { /* событие дня не собралось — карта без него */ } }
    SD.TIERS.forEach(t => {
      const ls = SD.LEVELS.filter(l => l.tier === t.id);
      h += `<section class="tier"><h3>${esc(t.label)} · <span>${esc(t.note)}</span></h3><div class="cards">`;
      ls.forEach(l => {
        const i = SD.LEVELS.indexOf(l), st = (A.progress[l.id] || {}).stars || 0;
        h += `<button type="button" class="lvl ${A.level === l ? 'cur' : ''}" data-level="${l.id}"><span class="n">УРОВЕНЬ ${i + 1}<span>${st ? stars(st) : ''}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small><span class="chips">${l.chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</span></button>`;
      });
      h += `</div></section>`;
    });
    h += `<section class="tier"><h3>Практикум паттернов · <span>короткие задачи: примени один паттерн, симулятор проверит</span></h3><div class="cards">`;
    SD.PRACTICE.forEach(l => { const st = (A.progress[l.id] || {}).stars || 0; const p = SD.PATTERNS.find(x => x.id === l.pattern); h += `<button type="button" class="lvl ${A.level === l ? 'cur' : ''}" data-level="${l.id}"><span class="n">ПАТТЕРН<span>${st ? '✓' : ''}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small><span class="chips">${p ? `<span class="chip">${esc(p.en || p.name)}</span>` : ''}</span></button>`; });
    h += `</div></section>`;
    h += `<section class="tier"><h3>Найди и перестрой · <span>инциденты: поставь диагноз и почини систему</span></h3><div class="cards">`;
    (SD.FIXES || []).forEach(l => { const st = (A.progress[l.id] || {}).stars || 0; h += `<button type="button" class="lvl ${A.level === l ? 'cur' : ''}" data-level="${l.id}"><span class="n">ИНЦИДЕНТ<span>${st ? '✓' : ''}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`; });
    h += `</div></section>`;
    const trk = (list, title, sub, tag) => { if (!list || !list.length) return; h += `<section class="tier"><h3>${title} · <span>${sub}</span></h3><div class="cards">`; list.forEach(l => { const st = (A.progress[l.id] || {}).stars || 0; h += `<button type="button" class="lvl ${A.level === l ? 'cur' : ''}" data-level="${l.id}"><span class="n">${tag}<span>${st ? '✓' : ''}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`; }); h += `</div></section>`; };
    trk(SD.KNOBS, 'Настройки на пальцах', 'одна настройка — один урок, со сравнением вариантов', 'НАСТРОЙКА');
    trk(SD.ARCHL, 'Архитектура из сервисов', 'сервисы с ролями: уведомления, заказы, каталог', 'АРХИТЕКТУРА');
    trk(SD.OPSL || [], 'Эксплуатация и инструменты', 'метрики, алерты, логи, трейсы, Kubernetes — и как они устроены внутри', 'ЭКСПЛУАТАЦИЯ');
    trk(SD.DATAL || [], 'Данные: от события до дашборда', 'DWH, поток событий, колоночная БД, озеро данных — финал трека: «Аналитика для бизнеса»', 'ДАННЫЕ');
    h += `<section class="tier"><h3>Внутри сервиса · <span>C4, уровень компонентов: проблема сидит в коде сервиса</span></h3><div class="cards">`;
    (SD.INNER || []).forEach(l => { const st = (A.progress[l.id] || {}).stars || 0; h += `<button type="button" class="lvl ${A.level === l ? 'cur' : ''}" data-level="${l.id}"><span class="n">КОМПОНЕНТЫ<span>${st ? '✓' : ''}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`; });
    h += `</div></section>`;
    h += `<section class="tier"><h3>Свободная сборка</h3><div class="cards"><button type="button" class="lvl" data-level="sandbox"><span class="n">ПЕСОЧНИЦА</span><b>Все компоненты открыты</b><small>Задай нагрузку сам и собери любую систему.</small></button></div></section></div>`;
    $('mapBody').innerHTML = h;
    if (SD.archLens) SD.archLens.decorateMap($('mapBody'));
  }

  /* ---------- справочник ---------- */
  function library(A) {
    const dives = Object.entries(SD.DIVES);
    const groups = [['Основы', ['estimate', 'request', 'lb', 'cache', 'cdn', 'objstore', 'ratelimit', 'websocket', 'search']], ['Базы данных', ['indexes', 'replication', 'sharding', 'isolation', 'polyglot', 'geo']], ['Распределённые транзакции и согласованность', ['cap', 'twopc', 'saga', 'cdc']], ['Распределённые системы глубже', ['consensus', 'quorum', 'locks', 'storage', 'ids']], ['Интеграции и надёжность', ['protocols', 'queue', 'delivery', 'resilience']], ['Архитектурные стили', ['archstyles', 'ddd', 'eda', 'cqrs', 'hexagonal', 'strangler']], ['Аналитика и инженерия данных', ['olap', 'etl']], ['AI', ['llm', 'rag', 'llmops', 'voice', 'agent']]];
    let h = `<p class="lede">Пошаговые разборы с анимацией и кодом. Открываются и из подсказок прораба, и из карточки любого узла.</p><button type="button" class="dive-cta" data-openpat="1">${SD.icon('app')}<span><b>Каталог паттернов и антипаттернов</b><small>${SD.PATTERNS.length} карточек: SOLID, GoF, отказоустойчивость, данные, интеграции, архитектура, AI. С тренировкой.</small></span></button>`;
    groups.forEach(([title, ids]) => {
      const list = ids.filter(id => SD.DIVES[id]);
      if (!list.length) return;
      h += `<h3>${title}</h3><div class="lib-grid">`;
      list.forEach(id => { const d = SD.DIVES[id]; h += `<button type="button" class="lib-card" data-dive="${id}">${SD.icon(d.icon || 'app')}<span><b>${esc(d.title)}</b><small>${esc(d.lede || '')}</small></span></button>`; });
      h += `</div>`;
    });
    const rest = dives.filter(([id]) => !groups.some(g => g[1].includes(id)));
    if (rest.length) { h += `<h3>Ещё</h3><div class="lib-grid">`; rest.forEach(([id, d]) => { h += `<button type="button" class="lib-card" data-dive="${id}">${SD.icon(d.icon || 'app')}<span><b>${esc(d.title)}</b><small>${esc(d.lede || '')}</small></span></button>`; }); h += `</div>`; }
    h += `<h3>Брокеры сообщений</h3><div class="tbl"><table class="kind-table cmp"><thead><tr><th>Движок</th><th>Масштаб</th><th>Порядок</th><th>Exactly-once</th><th>Повторное чтение</th></tr></thead><tbody>`;
    Object.values(SD.ENGINES).forEach(e => { h += `<tr><td>${esc(e.name)}</td><td>${e.cap === 'partitions' ? 'партиции × 20k/с' : F().num(e.perQueue) + '/с'}</td><td>${{ partition: 'в партиции', single: 'при одном потребителе', none: 'нет', group: 'в группе' }[e.order]}</td><td>${e.eos ? 'да' : 'нет'}</td><td>${e.replay ? 'да' : 'нет'}</td></tr>`; });
    h += `</tbody></table></div><h3>Протоколы между сервисами</h3><div class="tbl"><table class="kind-table cmp"><thead><tr><th>Протокол</th><th>CPU</th><th>Когда брать</th></tr></thead><tbody>`;
    Object.values(SD.PROTOCOLS).forEach(p => { h += `<tr><td>${esc(p.name)}</td><td>×${String(p.u).replace('.', ',')}</td><td>${esc(p.note)}</td></tr>`; });
    h += `</tbody></table></div><h3>Уровни изоляции</h3><div class="tbl"><table class="kind-table cmp"><thead><tr><th>Аномалия</th>${Object.values(SD.ISOLATION).map(i => `<th>${esc(i.name)}</th>`).join('')}</tr></thead><tbody>`;
    Object.entries(SD.ANOMALIES).forEach(([k, a]) => { h += `<tr><td title="${esc(a.text)}">${esc(a.name)}</td>${Object.values(SD.ISOLATION).map(i => i.prevents.includes(k) ? '<td class="ok">защищает</td>' : '<td class="bad">возможна</td>').join('')}</tr>`; });
    h += `</tbody></table></div><h3>Компоненты</h3><div class="lib-grid">`;
    Object.entries(SD.TYPES).filter(([, t]) => t.group).forEach(([k, t]) => { h += `<button type="button" class="lib-card" data-dive="${t.dive}">${SD.icon(k)}<span><b>${esc(t.name)}</b><small>${esc(t.info.what)}</small></span></button>`; });
    h += `</div><h3>Цифры, которые стоит помнить</h3><table class="numbers"><tbody>${SD.NUMBERS.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>`;
    $('libBody').innerHTML = h;
  }

  SD.panels = { metrics, task, stats, map, library, esc, stars };
})();
