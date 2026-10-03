/* Режим собеседования: задача, семь этапов, таймер 45 минут, схема на площадке, самопроверка и интервьюер. */
(function () {
  const KEY = 'amp-stroyka-interview-v1';
  const DUR = 45 * 60 * 1000;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const ST = () => SD.INTERVIEW_STAGES;
  const P = id => SD.interviewById(id);
  const toast = m => SD.app && SD.app.toast(m);
  const S = { cur: null, hist: [] };
  const UI = { view: 'list', pick: null, rv: 0, busy: null };
  let sample = null;

  const load = () => { try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища */ } };
  let saveT = null;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 400); };

  const LVL = { L4: 'L4 · база', L5: 'L5 · средний', L6: 'L6 · продвинутый' };
  const WEIGHT = { req: 15, est: 10, api: 10, data: 15, hld: 25, deep: 15, trade: 10 };
  const LABS_FOR = { shortener: ['snowflake', 'estimate'], ratelimiter: ['bucket', 'estimate'], kvstore: ['ring', 'quorum', 'lsm', 'bloom'], chat: ['snowflake', 'estimate'], feed: ['estimate'], payments: ['estimate'], monitoring: ['lsm'], autocomplete: ['estimate', 'bloom'], adclicks: ['estimate'] };
  const PLACE = {
    req: 'Функциональные:\n- …\n\nНефункциональные (масштаб, задержка, доступность, согласованность):\n- …\n\nВне рамок:\n- …',
    est: 'Пользователи и действия в сутки → RPS средний и пиковый\nДоля чтений и записей\nОбъём одной записи × количество × срок хранения\nСколько серверов и памяти под кэш',
    api: 'POST /… {…} → 201 {…}\nGET /…?cursor=… → 200 {items, next}\nИдемпотентность, ошибки, лимиты',
    data: 'Сущности и ключи\nГлавные запросы (паттерны доступа)\nХранилище: … потому что …\nКлюч шардирования, индексы',
    hld: 'Как идёт запрос: клиент → … → хранилище\nЧто где кэшируется, что асинхронно\nГде резерв и что будет при падении узла',
    deep: 'Тема 1: как устроено, что может пойти не так, как защититься\nТема 2: …',
    trade: 'Выбрал …, заплатил …\nПри росте ×10 первым сломается …\nМетрики и алерты: …'
  };
  const FUP = {
    req: ['Что для этой системы важнее: согласованность или доступность? Почему?', 'Что ты сознательно оставил за рамками и почему это безопасно?', 'Какая задержка допустима для главного сценария и как ты её будешь измерять (p50, p99)?'],
    est: ['Сколько серверов приложений понадобится на пике? Из чего это следует?', 'Сколько данных накопится за весь срок с учётом реплик и индексов?', 'Как соотносятся чтения и записи, и что из этого следует для архитектуры?'],
    api: ['Что будет, если клиент повторит запрос из-за таймаута?', 'Как устроена пагинация и почему не OFFSET?', 'Какие коды ошибок вернёт API и в каких случаях?'],
    data: ['Почему именно это хранилище, а не другое?', 'Какой ключ шардирования и что будет с горячим ключом?', 'Какие индексы нужны под главные запросы и чем они заплатят?'],
    hld: ['Где в схеме единая точка отказа?', 'Что произойдёт, если кэш упадёт целиком?', 'Проведи один запрос через систему от клиента до хранилища.'],
    trade: ['Что сломается первым при росте нагрузки в 10 раз?', 'Какие метрики и алерты ты поставишь в первую очередь?', 'Что ты упростишь, если бюджет урежут вдвое?']
  };
  const VERDICT = { strong_hire: 'Сильный оффер', hire: 'Оффер', lean_hire: 'Пограничный результат', no_hire: 'Пока рано' };
  const DIMN = { req: 'Требования', est: 'Оценка нагрузки', api: 'API', data: 'Модель данных', hld: 'Схема', deep: 'Углубление', trade: 'Компромиссы', comm: 'Коммуникация' };

  /* ---------- время ---------- */
  const now = () => Date.now();
  const elapsed = c => (c.ended || c.pauseAt || now()) - c.t0 - c.paused;
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  function tick(c) { if (!c.pauseAt && !c.ended) { const id = ST()[c.stage].id; c.stageT[id] = (c.stageT[id] || 0) + (now() - c.enter); c.enter = now(); } }
  function timers() {
    const c = S.cur;
    document.querySelectorAll('[data-inttimer]').forEach(el => {
      if (!c) { el.hidden = true; return; }
      el.hidden = false;
      const e = elapsed(c);
      el.textContent = (c.pauseAt ? '⏸ ' : '') + mmss(e) + ' / 45:00';
      el.classList.toggle('over', e > DUR);
      el.classList.toggle('late', e > DUR * 0.8 && e <= DUR);
    });
    const st = document.querySelector('.int-stages li.on .tm');
    if (c && st) { const id = ST()[c.stage].id; st.textContent = mmss((c.stageT[id] || 0) + (c.pauseAt ? 0 : now() - c.enter)); }
  }

  /* ---------- сессия ---------- */
  function start(pid) {
    S.cur = { pid, t0: now(), paused: 0, pauseAt: null, stage: 0, enter: now(), stageT: {}, notes: {}, asked: [], fups: [], deepPick: [], hld: null, checks: {}, ai: null, ended: null };
    save(); UI.view = 'run'; render();
  }
  function go(i) {
    const c = S.cur; if (!c) return;
    tick(c); c.stage = Math.max(0, Math.min(ST().length - 1, i)); c.enter = now(); saveSoon(); render();
  }
  function pause() {
    const c = S.cur; if (!c) return;
    if (c.pauseAt) { c.paused += now() - c.pauseAt; c.pauseAt = null; c.enter = now(); }
    else { tick(c); c.pauseAt = now(); }
    save(); render();
  }
  function finish() {
    const c = S.cur; if (!c) return;
    if (c.pauseAt) { c.paused += now() - c.pauseAt; c.pauseAt = null; c.enter = now(); }
    tick(c); c.ended = now();
    const A = SD.app.A;
    if (A.level && A.level.interview === c.pid) c.hld = snapFrom(A);
    S.hist.unshift(c); S.hist = S.hist.slice(0, 20); S.cur = null;
    save(); UI.view = 'review'; UI.rv = 0; render();
  }
  const filled = (c, id) => id === 'hld' ? !!(c.hld || (c.notes.hld || '').trim().length > 10) : (c.notes[id] || '').trim().length > 10;

  /* ---------- схема на площадке ---------- */
  const specOf = g => JSON.parse(JSON.stringify({ nodes: g.nodes.map(n => [n.id, n.type, n.x, n.y, n.props, n.label]), edges: g.edges.map(e => [e.from, e.to, e.props]) }));
  function snapFrom(A) {
    const g = A.graph, r = A.res1 || A.res;
    const parts = g.nodes.filter(n => n.type !== 'client').map(n => {
      const t = SD.TYPES[n.type], k = n.props.count > 1 ? ` ×${n.props.count}` : '';
      return (n.label || t.name) + k;
    });
    return { spec: specOf(g), parts, goals: (A.goals || []).map(x => ({ ok: x.ok, text: x.text, detail: x.detail })), succ: r ? r.total.success : 0, lat: r ? r.total.lat : 0, cost: r ? r.cost : 0, at: now() };
  }
  function onRecompute(A) {
    const c = S.cur;
    if (!c || !A.level || A.level.interview !== c.pid) return;
    c.hld = snapFrom(A); saveSoon();
  }
  function specFor(L) {
    const c = S.cur && S.cur.pid === L.interview ? S.cur : S.hist.find(h => h.pid === L.interview);
    return c && c.hld ? c.hld.spec : undefined;
  }
  function build() {
    const c = S.cur; if (!c) return;
    const L = SD.interviewLevel(P(c.pid));
    go(ST().findIndex(s => s.id === 'hld'));
    $('intModal').hidden = true;
    if (SD.app.A.level !== L) SD.app.loadLevel(L, c.hld ? c.hld.spec : undefined);
    toast('Собирай схему: все компоненты открыты. Вернуться к этапам — кнопка во вкладке «Задание».');
  }
  function back() {
    if (S.cur) { UI.view = 'run'; const A = SD.app.A; if (A.level && A.level.interview === S.cur.pid) S.cur.hld = snapFrom(A); save(); }
    open();
  }

  /* ---------- интервьюер ---------- */
  function cannedFup(c, sid) {
    const p = P(c.pid);
    const bank = sid === 'deep' ? (c.deepPick.length ? c.deepPick : p.deep).map(t => `Расскажи подробнее про «${t}»: как это устроено и что может пойти не так?`) : FUP[sid] || [];
    const used = new Set(c.fups.filter(f => f.stage === sid).map(f => f.q));
    return bank.find(q => !used.has(q));
  }
  function stageContext(c, sid) {
    const p = P(c.pid), st = ST().find(s => s.id === sid);
    let t = `Ты — интервьюер на собеседовании по системному дизайну в крупной IT-компании. Задача кандидата: «${p.title}». Условие: ${p.prompt}\n`;
    t += `Сейчас этап «${st.title}». Что ожидается на этапе: ${st.hint}\n`;
    if (sid === 'hld' && c.hld) t += `Схема кандидата: ${c.hld.parts.join(', ')}. Симулятор: ${c.hld.goals.map(g => (g.ok ? '✓ ' : '✗ ') + g.text).join('; ')}.\n`;
    t += `Заметки кандидата на этом этапе:\n"""${(c.notes[sid] || '').slice(0, 3000) || '(пусто)'}"""\n`;
    const prev = c.fups.filter(f => f.stage === sid);
    if (prev.length) t += `Ты уже спрашивал: ${prev.map(f => `«${f.q}» — ответ: «${(f.a || '').slice(0, 400) || 'нет ответа'}»`).join('; ')}\n`;
    t += 'Задай ОДИН короткий уточняющий вопрос (1–2 предложения), который проверит глубину понимания: найди слабое или непродуманное место в заметках. Если заметки пустые, попроси начать с главного. Пиши по-русски, без вступлений и похвалы, только вопрос.';
    return t;
  }
  async function askFup() {
    const c = S.cur; if (!c) return;
    const sid = ST()[c.stage].id;
    if (!sample) {
      const q = cannedFup(c, sid);
      if (!q) { toast('Вопросы этого этапа закончились. Переходи дальше.'); return; }
      c.fups.push({ stage: sid, q, a: '' }); saveSoon(); render(); return;
    }
    if (UI.busy) return;
    const f = { stage: sid, q: '…', a: '', ai: true };
    c.fups.push(f); render();
    const k = c.fups.length - 1;
    UI.busy = new AbortController();
    try {
      const { text } = await sample(stageContext(c, sid), { modelTier: 'quick', cache: false, signal: UI.busy.signal, onText: ({ text }) => { const el = document.querySelector(`[data-ifq="${k}"]`); if (el) el.textContent = text; } });
      f.q = (text || '').trim() || cannedFup(c, sid) || 'Расскажи подробнее о самом рискованном месте твоего решения.';
    } catch (e) {
      if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) sample = null;
      const q = cannedFup(c, sid);
      if (q) f.q = q; else c.fups.splice(k, 1);
      if (e && e.code !== 'cancelled') toast('Интервьюер Claude недоступен, задаю вопрос из банка.');
    }
    UI.busy = null; save(); render();
  }

  function scorePrompt(c) {
    const p = P(c.pid);
    let t = `Ты — опытный интервьюер по системному дизайну (уровень крупных IT-компаний). Оцени кандидата строго и справедливо по рубрике.\n\nЗадача: «${p.title}», ожидаемый уровень ${p.lvl}. Условие: ${p.prompt}\n`;
    t += `Кандидат задал заказчику ${c.asked.length} уточняющих вопросов из ${p.asks.length} возможных${c.asked.length ? ': ' + c.asked.map(i => `«${p.asks[i][0]}» → «${p.asks[i][1]}»`).join('; ') : ''}.\n`;
    t += `Время: ${mmss(elapsed(c))} из 45:00.\n\nЭтапы и заметки кандидата:\n`;
    ST().forEach(s => {
      t += `\n## ${s.title}\n${(c.notes[s.id] || '').slice(0, 2500) || '(пусто)'}\n`;
      if (s.id === 'hld') t += c.hld ? `Схема собрана в симуляторе: ${c.hld.parts.join(', ')}. Цели симулятора: ${c.hld.goals.map(g => (g.ok ? '✓ ' : '✗ ') + g.text + ' (' + g.detail + ')').join('; ')}. Стоимость ${SD.fmt.usd(c.hld.cost)} в месяц.\n` : 'Схему в симуляторе кандидат не собрал.\n';
      if (s.id === 'deep' && c.deepPick.length) t += `Выбранные темы: ${c.deepPick.join(', ')}.\n`;
      c.fups.filter(f => f.stage === s.id).forEach(f => { t += `Вопрос интервьюера: ${f.q}\nОтвет кандидата: ${(f.a || '').slice(0, 1200) || '(не ответил)'}\n`; });
    });
    t += `\nОриентиры сильного ответа (для тебя, дословно не цитируй):\n${ST().map(s => `${s.title}: ${(p.keys[s.id] || []).join('; ')}`).join('\n')}\n`;
    t += `\nВерни только JSON без пояснений вида:\n{"dims":[{"id":"req","score":3,"comment":"…"}, …],"verdict":"hire","summary":"…","strengths":["…"],"gaps":["…"],"next":["…"]}\n`;
    t += 'dims — ровно восемь записей с id: req, est, api, data, hld, deep, trade, comm. score от 1 до 4: 1 — нет или ошибочно, 2 — поверхностно, 3 — хорошо, 4 — сильно и с компромиссами. comm — структура, вопросы заказчику, время, объяснение выбора. verdict: strong_hire, hire, lean_hire или no_hire с учётом уровня задачи. Комментарии по-русски, одно-два конкретных предложения по заметкам кандидата. strengths, gaps, next — по 2–4 пункта; next — что именно изучить или потренировать.';
    return t;
  }
  async function aiScore(c) {
    if (!sample || UI.busy) return;
    UI.busy = new AbortController();
    c.ai = { loading: true }; render();
    try {
      const r = await sample.json(scorePrompt(c), { modelTier: 'default', cache: false, signal: UI.busy.signal });
      const dims = Array.isArray(r && r.dims) ? r.dims.filter(d => DIMN[d.id]).map(d => ({ id: d.id, score: Math.max(1, Math.min(4, Math.round(+d.score) || 1)), comment: String(d.comment || '') })) : [];
      if (!dims.length) throw { code: 'shape', message: 'пустая оценка' };
      const arr = v => Array.isArray(v) ? v.map(String).slice(0, 5) : [];
      c.ai = { dims, verdict: VERDICT[r.verdict] ? r.verdict : 'lean_hire', summary: String(r.summary || ''), strengths: arr(r.strengths), gaps: arr(r.gaps), next: arr(r.next) };
    } catch (e) {
      if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) sample = null;
      c.ai = e && e.code === 'cancelled' ? null : { error: (e && e.message) || 'не получилось' };
    }
    UI.busy = null; save(); render();
  }

  /* ---------- оценка ---------- */
  const stems = s => (s.toLowerCase().match(/[a-zа-яё0-9]{4,}/g) || []).map(w => w.slice(0, 5));
  function mentioned(text, key) {
    const ks = [...new Set(stems(key))];
    if (!ks.length) return false;
    const have = new Set(stems(text));
    return ks.filter(k => have.has(k)).length / ks.length >= 0.5;
  }
  function score(c) {
    const p = P(c.pid), per = {};
    ST().forEach(s => {
      const keys = p.keys[s.id] || [], ch = c.checks[s.id] || [];
      let v = keys.length ? keys.filter((_, i) => ch[i]).length / keys.length : 0;
      if (s.id === 'hld') { const g = c.hld ? c.hld.goals : []; const sim = g.length ? g.filter(x => x.ok).length / g.length : 0; v = 0.5 * v + 0.5 * sim; }
      per[s.id] = v;
    });
    const tech = ST().reduce((a, s) => a + per[s.id] * WEIGHT[s.id], 0);
    const e = elapsed(c);
    const timeS = e <= DUR ? 1 : Math.max(0, 1 - (e - DUR) / (15 * 60 * 1000));
    const fu = c.fups.length ? c.fups.filter(f => (f.a || '').trim().length > 15).length / c.fups.length : 0.5;
    const comm = (Math.min(c.asked.length, 3) / 3 + timeS + fu) / 3;
    const total = Math.round(tech * 0.9 + comm * 10);
    const grade = total >= 80 ? 'strong_hire' : total >= 65 ? 'hire' : total >= 50 ? 'lean_hire' : 'no_hire';
    return { per, comm, total, grade, timeS };
  }

  /* ---------- отрисовка ---------- */
  function mount() {
    load();
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'intModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet int-sheet" role="dialog" aria-modal="true" aria-labelledby="intTitle"><div class="sheet-head"><h2 id="intTitle">Собеседование</h2><span class="int-clock" data-inttimer hidden></span><button class="btn ghost x" type="button" data-close>Закрыть</button></div><div class="sheet-body" id="intBody"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('input', onInput);
    m.addEventListener('change', onChange);
    setInterval(timers, 1000);
    (async () => {
      try { sample = window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch (e) { sample = null; }
      if (sample && !m.hidden) render();
    })();
  }
  function open(view) {
    if (view) UI.view = view;
    else if (S.cur) UI.view = 'run';
    render();
    $('intModal').hidden = false;
  }

  function render() {
    const body = $('intBody'); if (!body) return;
    if (UI.view === 'run' && !S.cur) UI.view = 'list';
    if (UI.view === 'review' && !S.hist[UI.rv]) UI.view = 'list';
    const h = UI.view === 'brief' ? viewBrief() : UI.view === 'run' ? viewRun() : UI.view === 'review' ? viewReview() : viewList();
    const keep = body.scrollTop;
    body.innerHTML = h;
    if (UI.view === 'run') body.scrollTop = keep;
    $('intTitle').textContent = UI.view === 'list' ? 'Собеседование' : (P((UI.view === 'review' ? S.hist[UI.rv] : UI.view === 'run' ? S.cur : { pid: UI.pick }).pid) || {}).title || 'Собеседование';
    timers();
  }

  function stageStrip() {
    return `<ol class="int-strip">${ST().map((s, i) => `<li><b>${i + 1}</b><span>${esc(s.title)}</span><small>${s.min} мин</small></li>`).join('')}</ol>`;
  }
  function viewList() {
    const best = {};
    S.hist.forEach(c => { const sc = score(c).total; best[c.pid] = Math.max(best[c.pid] || 0, sc); });
    let h = `<p class="lede">Как на настоящем собеседовании по системному дизайну: одна задача, 45 минут, семь этапов. Уточняешь требования у «заказчика», считаешь нагрузку, проектируешь API и данные, собираешь схему на площадке — симулятор проверит её под нагрузкой. Потом углубляешься и защищаешь компромиссы. В конце — самопроверка по ключевым пунктам${sample ? ' и оценка интервьюера Claude по рубрике' : ''}.</p>`;
    if (S.cur) {
      const p = P(S.cur.pid);
      h += `<div class="int-resume"><div><b>Идёт собеседование: ${esc(p.title)}</b><small>Этап «${esc(ST()[S.cur.stage].title)}», прошло ${mmss(elapsed(S.cur))}</small></div><button class="btn primary" type="button" data-iresume>Продолжить</button><button class="btn" type="button" data-ifinish>Завершить и оценить</button><button class="btn ghost danger" type="button" data-iabandon>Бросить</button></div>`;
    }
    h += `<h3>Как проходит</h3>${stageStrip()}`;
    h += `<h3>Задачи · ${SD.INTERVIEWS.length}</h3><div class="hub-grid">`;
    SD.INTERVIEWS.forEach(p => {
      h += `<button type="button" class="lvl" data-ipick="${p.id}"><span class="n">${esc(LVL[p.lvl] || p.lvl)}<span>${best[p.id] != null ? best[p.id] + ' %' : ''}</span></span><b>${esc(p.title)}</b><small>${esc(p.prompt.split(': ')[0].split('. ')[0])}.</small><span class="chips">${p.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</span></button>`;
    });
    h += `</div><div class="int-row"><button class="btn" type="button" data-irandom>Случайная задача</button></div>`;
    if (S.hist.length) {
      h += `<h3>История</h3><div class="int-hist">`;
      S.hist.forEach((c, i) => { const p = P(c.pid), sc = score(c); h += `<button type="button" data-ihist="${i}"><span>${new Date(c.t0).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span><b>${esc(p ? p.title : c.pid)}</b><span>${mmss(elapsed(c))}</span><span class="g-${sc.grade}">${sc.total} % · ${VERDICT[sc.grade]}</span></button>`; });
      h += `</div>`;
    }
    return h;
  }
  function viewBrief() {
    const p = P(UI.pick);
    let h = `<span class="eyebrow">${esc(LVL[p.lvl] || p.lvl)}</span><p class="int-task">${esc(p.prompt)}</p><div class="chips-row">${p.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
    h += `<h3>Этапы</h3>${stageStrip()}`;
    h += `<h3>Правила</h3><ul class="int-rules"><li>Таймер идёт с момента старта, его можно поставить на паузу. Укладываться в 45 минут — часть оценки.</li><li>Требования не даны полностью: задавай вопросы заказчику на первом этапе. Ответы появятся только на заданные вопросы.</li><li>Схему собираешь на площадке: нагрузка из условия, все компоненты открыты, подсказок нет. Симулятор проверяет успешность, задержку, отказоустойчивость и бюджет.</li><li>На каждом этапе можно попросить вопрос интервьюера и ответить на него письменно${sample ? ' — вопросы задаёт Claude по твоим заметкам' : ''}.</li><li>В конце сравниваешь свои заметки с ключевыми пунктами, видишь эталонную схему и разбор тем.</li></ul>`;
    h += `<div class="int-row">${S.cur ? '<span class="note">Сначала заверши или брось текущее собеседование.</span>' : `<button class="btn primary" type="button" data-istart="${p.id}">Начать · 45 минут</button>`}<button class="btn ghost" type="button" data-ilist>← К задачам</button></div>`;
    return h;
  }
  function viewRun() {
    const c = S.cur, p = P(c.pid), st = ST()[c.stage], sid = st.id;
    let h = `<div class="int-run"><aside class="int-side"><div class="int-timer"><span data-inttimer></span><button class="btn ghost" type="button" data-ipause>${c.pauseAt ? '▶ Продолжить' : '⏸ Пауза'}</button></div><ol class="int-stages">`;
    let cum = 0;
    ST().forEach((s, i) => {
      cum += s.min;
      const done = filled(c, s.id);
      h += `<li class="${i === c.stage ? 'on' : ''} ${done ? 'done' : ''}"><button type="button" data-istage="${i}"><i>${done ? '✓' : i + 1}</i><span>${esc(s.title)}<small>${s.min} мин · к ${cum}-й</small></span><em class="tm">${mmss(c.stageT[s.id] || 0)}</em></button></li>`;
    });
    h += `</ol><button class="btn" type="button" data-ifinish>Завершить и оценить</button><button class="btn ghost" type="button" data-ilist>Задачи</button></aside><section class="int-main">`;
    h += `<details class="int-prompt" ${c.stage < 2 ? 'open' : ''}><summary>Условие задачи</summary><p>${esc(p.prompt)}</p>${c.asked.length ? `<ul class="int-asked">${c.asked.map(i => `<li><b>${esc(p.asks[i][0])}</b> ${esc(p.asks[i][1])}</li>`).join('')}</ul>` : ''}</details>`;
    h += `<span class="eyebrow">Этап ${c.stage + 1} из ${ST().length} · ориентир ${st.min} мин</span><h2 class="int-h">${esc(st.title)}</h2><p class="int-hint">${esc(st.hint)}</p>`;
    if (sid === 'req') {
      h += `<div class="int-asks"><b>Спроси заказчика</b><small>Хорошая практика — 3–5 вопросов до того, как рисовать. Ответы попадут в условие задачи.</small><div class="opts">${p.asks.map((a, i) => c.asked.includes(i) ? `<div class="int-qa"><b>${esc(a[0])}</b><span>${esc(a[1])}</span></div>` : `<button type="button" class="opt" data-iask="${i}">${esc(a[0])}</button>`).join('')}</div></div>`;
    }
    if (sid === 'est') h += `<div class="int-cheat"><b>Шпаргалка</b><span>сутки ≈ 86 400 с ≈ 10⁵ с</span><span>1 млн в сутки ≈ 12 в секунду</span><span>пик ≈ ×2–3 от среднего</span><span>сервер приложения ≈ 1–3 тыс. RPS</span><span>Redis ≈ 100 тыс. оп/с на узел</span><span>PostgreSQL ≈ 5–10 тыс. простых запросов/с</span></div>`;
    if (sid === 'hld') {
      const L = SD.interviewLevel(p);
      const kinds = Object.entries(L.traffic).filter(([, v]) => v > 0);
      h += `<div class="int-build"><div class="int-build-head"><div><b>Схема на площадке</b><small>Нагрузка из условия: ${kinds.map(([k, v]) => `${esc(SD.KINDS[k].label.toLowerCase())} ${SD.fmt.num(v)}/с`).join(', ')}. Все компоненты открыты, подсказок нет.</small></div><button class="btn primary" type="button" data-ibuild>${c.hld ? 'Продолжить сборку →' : 'Собрать на площадке →'}</button></div>`;
      if (c.hld) h += snapHtml(c.hld);
      h += `</div>`;
    }
    if (sid === 'deep') h += `<div class="int-asks"><b>Выбери 2 темы для углубления</b><small>Интервьюер ждёт, что ты сам предложишь самое рискованное место.</small><div class="opts">${p.deep.map(t => `<button type="button" class="opt ${c.deepPick.includes(t) ? 'right' : ''}" data-ideep="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
    h += `<label class="int-notes"><span>Твой ответ</span><textarea data-inote="${sid}" rows="${sid === 'hld' ? 6 : 9}" placeholder="${esc(PLACE[sid])}">${esc(c.notes[sid] || '')}</textarea></label>`;
    const fs = c.fups.map((f, k) => [f, k]).filter(([f]) => f.stage === sid);
    if (fs.length) h += `<div class="int-fups">${fs.map(([f, k]) => `<div class="int-fup"><p><b>Интервьюер:</b> <span data-ifq="${k}">${esc(f.q)}</span></p><textarea data-ifans="${k}" rows="3" placeholder="Ответь так, как сказал бы вслух">${esc(f.a || '')}</textarea></div>`).join('')}</div>`;
    h += `<div class="int-nav"><button class="btn" type="button" data-inav="-1" ${c.stage ? '' : 'disabled'}>← Назад</button><button class="btn" type="button" data-ifup ${UI.busy ? 'disabled' : ''}>${sample ? 'Вопрос интервьюера · Claude' : 'Вопрос интервьюера'}</button>${c.stage < ST().length - 1 ? `<button class="btn primary" type="button" data-inav="1">Дальше: ${esc(ST()[c.stage + 1].title)} →</button>` : '<button class="btn primary" type="button" data-ifinish>Завершить и оценить</button>'}</div>`;
    h += `</section></div>`;
    return h;
  }
  function snapHtml(s) {
    const ok = s.goals.filter(g => g.ok).length;
    return `<div class="int-snap"><div class="int-parts">${s.parts.length ? s.parts.map(x => `<span class="chip">${esc(x)}</span>`).join('') : '<span class="note">Схема пустая</span>'}</div><div class="int-metrics"><span>Успешно <b>${SD.fmt.pct(s.succ)}</b></span><span>Задержка <b>${SD.fmt.ms(s.lat)}</b></span><span>Цена <b>${SD.fmt.usd(s.cost)}</b>/мес</span><span>Цели <b>${ok} из ${s.goals.length}</b></span></div><ul class="goals">${s.goals.map(g => `<li class="${g.ok ? 'ok' : 'bad'}"><span class="st">${g.ok ? '✓' : '·'}</span><span class="gt">${esc(g.text)}<span class="gd">${esc(g.detail)}</span></span></li>`).join('')}</ul></div>`;
  }
  function viewReview() {
    const c = S.hist[UI.rv], p = P(c.pid), sc = score(c), L = SD.interviewLevel(p);
    let h = `<div class="int-score"><div class="int-ring g-${sc.grade}" style="--v:${sc.total}"><b>${sc.total}</b><small>из 100</small></div><div><span class="eyebrow">${esc(LVL[p.lvl] || p.lvl)} · самопроверка</span><h2 class="int-h">${VERDICT[sc.grade]}</h2><p class="note">Время ${mmss(elapsed(c))} из 45:00 · этапов с ответом ${ST().filter(s => filled(c, s.id)).length} из ${ST().length} · вопросов заказчику ${c.asked.length} · ответов интервьюеру ${c.fups.filter(f => (f.a || '').trim()).length} из ${c.fups.length}</p><p class="note">Отметь ключевые пункты, которые ты действительно раскрыл. Подсказка «есть в ответе» — грубое совпадение слов, решаешь ты.</p></div></div>`;
    h += `<div class="int-bars">${ST().map(s => `<div><span>${esc(s.title)}</span><i><b style="width:${Math.round(sc.per[s.id] * 100)}%"></b></i><em>${Math.round(sc.per[s.id] * 100)} %</em></div>`).join('')}<div><span>Коммуникация</span><i><b style="width:${Math.round(sc.comm * 100)}%"></b></i><em>${Math.round(sc.comm * 100)} %</em></div></div>`;
    if (sample || (c.ai && !c.ai.error && !c.ai.loading)) h += aiHtml(c);
    ST().forEach(s => {
      const keys = p.keys[s.id] || [], ch = c.checks[s.id] || [];
      const text = (c.notes[s.id] || '') + ' ' + c.fups.filter(f => f.stage === s.id).map(f => f.a || '').join(' ');
      h += `<details class="int-rev" open><summary><b>${esc(s.title)}</b><span>${keys.filter((_, i) => ch[i]).length} из ${keys.length}${s.id === 'hld' && c.hld ? ` · симулятор ${c.hld.goals.filter(g => g.ok).length}/${c.hld.goals.length}` : ''} · ${mmss(c.stageT[s.id] || 0)}</span></summary><div class="int-rev-grid"><div><small>Твой ответ</small><pre class="int-mine">${esc((c.notes[s.id] || '').trim() || '— пусто —')}</pre>`;
      c.fups.filter(f => f.stage === s.id).forEach(f => { h += `<p class="int-fq"><b>Интервьюер:</b> ${esc(f.q)}<br><b>Ты:</b> ${esc(f.a || '— без ответа —')}</p>`; });
      if (s.id === 'deep' && c.deepPick.length) h += `<p class="note">Выбранные темы: ${c.deepPick.map(esc).join(', ')}</p>`;
      if (s.id === 'hld') h += c.hld ? snapHtml(c.hld) : '<p class="note">Схема на площадке не собрана: половина оценки этапа — проверка симулятором.</p>';
      h += `</div><div><small>Ключевые пункты сильного ответа</small><ul class="int-keys">${keys.map((k, i) => `<li><label><input type="checkbox" data-icheck="${s.id}:${i}" ${ch[i] ? 'checked' : ''}><span>${esc(k)}${mentioned(text, k) ? ' <em>есть в ответе</em>' : ''}</span></label></li>`).join('')}</ul>`;
      if (s.id === 'hld' && L.ref) h += `<p class="note">${esc(L.ref.note || '')}</p><button class="btn" type="button" data-iref>Открыть эталонную схему на площадке</button>`;
      h += `</div></div></details>`;
    });
    const labs = (LABS_FOR[p.id] || ['estimate']).filter(id => SD.LABS && SD.LABS.find(l => l.id === id));
    h += `<h3>Подтянуть темы</h3><div class="int-row">${(p.dives || []).filter(d => SD.DIVES && SD.DIVES[d]).map(d => `<button class="btn" type="button" data-idive="${d}">Разбор: ${esc(SD.DIVES[d].title)}</button>`).join('')}${labs.map(id => `<button class="btn" type="button" data-ilab="${id}">Лаборатория: ${esc(SD.LABS.find(l => l.id === id).title)}</button>`).join('')}</div>`;
    h += `<div class="int-row" style="margin-top:18px"><button class="btn primary" type="button" data-ipick="${p.id}">Пройти эту задачу ещё раз</button><button class="btn" type="button" data-ilist>К задачам</button></div>`;
    return h;
  }
  function aiHtml(c) {
    const a = c.ai;
    let h = `<div class="int-ai"><div class="int-ai-head"><b>Оценка интервьюера · Claude</b>`;
    if (!a || a.error) h += `<button class="btn primary" type="button" data-iai ${UI.busy ? 'disabled' : ''}>${a && a.error ? 'Попробовать ещё раз' : 'Получить оценку по рубрике'}</button>`;
    h += `</div>`;
    if (!a) return h + `<p class="note">Claude прочитает твои заметки, ответы и результат симулятора и оценит восемь измерений по шкале 1–4, как в рубриках крупных компаний.</p></div>`;
    if (a.loading) return h + `<p class="note">Интервьюер читает твои ответы…</p></div>`;
    if (a.error) return h + `<p class="note">Не получилось: ${esc(a.error)}</p></div>`;
    h += `<p><span class="int-verdict g-${a.verdict}">${VERDICT[a.verdict]}</span> ${esc(a.summary)}</p><div class="int-dims">`;
    a.dims.forEach(d => { h += `<div><span>${esc(DIMN[d.id])}</span><i>${[1, 2, 3, 4].map(n => `<b class="${n <= d.score ? 'on s' + d.score : ''}"></b>`).join('')}</i><small>${esc(d.comment)}</small></div>`; });
    h += `</div><div class="int-lists">`;
    [['Сильные стороны', a.strengths], ['Пробелы', a.gaps], ['Что потренировать', a.next]].forEach(([t, l]) => { if (l.length) h += `<div><small>${t}</small><ul>${l.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`; });
    return h + `</div><button class="btn ghost" type="button" data-iai>Оценить заново</button></div>`;
  }

  /* ---------- события ---------- */
  function onClick(e) {
    const m = $('intModal');
    if (e.target === m || e.target.closest('[data-close]')) { if (UI.busy) UI.busy.abort(); m.hidden = true; return; }
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset, c = S.cur;
    if (d.ipick) { UI.pick = d.ipick; UI.view = 'brief'; render(); $('intBody').scrollTop = 0; return; }
    if ('irandom' in d) { const l = SD.INTERVIEWS; UI.pick = l[Math.floor(Math.random() * l.length)].id; UI.view = 'brief'; render(); return; }
    if (d.istart) { start(d.istart); return; }
    if ('iresume' in d) { UI.view = 'run'; render(); return; }
    if ('iabandon' in d) { S.cur = null; save(); render(); return; }
    if ('ilist' in d) { UI.view = 'list'; render(); $('intBody').scrollTop = 0; return; }
    if ('ifinish' in d) { finish(); $('intBody').scrollTop = 0; return; }
    if (d.ihist) { UI.rv = +d.ihist; UI.view = 'review'; render(); $('intBody').scrollTop = 0; return; }
    if (d.istage) { go(+d.istage); return; }
    if (d.inav) { go(c.stage + +d.inav); $('intBody').scrollTop = 0; return; }
    if ('ipause' in d) { pause(); return; }
    if (d.iask) { const i = +d.iask; if (!c.asked.includes(i)) c.asked.push(i); saveSoon(); render(); return; }
    if (d.ideep) { const v = d.ideep, i = c.deepPick.indexOf(v); if (i >= 0) c.deepPick.splice(i, 1); else c.deepPick.push(v); saveSoon(); render(); return; }
    if ('ibuild' in d) { build(); return; }
    if ('ifup' in d) { askFup(); return; }
    if ('iai' in d) { aiScore(S.hist[UI.rv]); return; }
    if ('iref' in d) {
      const h = S.hist[UI.rv], L = SD.interviewLevel(P(h.pid));
      m.hidden = true; SD.app.loadLevel(L, L.ref); toast(L.ref.note || 'Эталонная схема на площадке.'); return;
    }
    if (d.idive) { if (SD.player.open(d.idive) && SD.mentor) SD.mentor.onEvent('dive', d.idive); return; }
    if (d.ilab) { m.hidden = true; SD.labs.open(d.ilab); }
  }
  function onInput(e) {
    const t = e.target, c = S.cur;
    if (!c) return;
    if (t.dataset.inote) { c.notes[t.dataset.inote] = t.value; saveSoon(); const li = document.querySelectorAll('.int-stages li')[c.stage]; if (li) li.classList.toggle('done', filled(c, t.dataset.inote)); }
    if (t.dataset.ifans != null && c.fups[+t.dataset.ifans]) { c.fups[+t.dataset.ifans].a = t.value; saveSoon(); }
  }
  function onChange(e) {
    const t = e.target;
    if (!t.dataset.icheck) return;
    const c = S.hist[UI.rv]; if (!c) return;
    const [sid, i] = t.dataset.icheck.split(':');
    c.checks[sid] = c.checks[sid] || [];
    c.checks[sid][+i] = t.checked;
    save();
    const keepY = $('intBody').scrollTop; render(); $('intBody').scrollTop = keepY;
  }

  /* ---------- блок во вкладке «Задание» ---------- */
  function paneBlock(A) {
    const c = S.cur;
    if (!c || c.pid !== A.level.interview) return `<div class="int-pane"><p>Собеседование по этой задаче сейчас не идёт. Схему можно собирать свободно, но в оценку она не попадёт.</p><button class="btn" type="button" data-act="intopen">Открыть собеседования</button></div>`;
    return `<div class="int-pane"><div class="int-pane-top"><b>Этап «Схема»</b><span class="int-clock" data-inttimer></span></div><p>Подсказок и эталона нет, как на настоящем собеседовании. Схема сохраняется в ответ автоматически. Когда закончишь — возвращайся к этапам: дальше углубление и компромиссы.</p><button class="btn primary" type="button" data-act="intback">← К этапам собеседования</button></div>`;
  }

  SD.interview = { mount, open, back, paneBlock, onRecompute, specFor, active: () => S.cur };
})();
