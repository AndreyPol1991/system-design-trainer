/* Арчи — прораб-наставник: тур, миссии «сделай — проверю», реакции на события, вопросы. */
(function () {
  const KEY = 'amp-stroyka-mentor-v1';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  let A = null, H = {};
  const M = { seenTypes: [], seenDives: [], tourDone: false, welcomed: false, quiet: false };
  const run = { level: null, mission: null, step: 0, flags: {}, lastSay: 0, queue: null, hotSeen: new Set(), won: false, chat: [], busy: null, sample: null, lastProgress: Date.now() };

  function load() { try { Object.assign(M, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(M)); } catch (e) { /* без хранилища */ } }

  /* ---------- лицо Арчи ---------- */
  function face(mood) {
    const mouth = { happy: 'M17 32 Q24 39 31 32', worried: 'M17 35 Q24 30 31 35', think: 'M18 34 L30 33', idle: 'M18 33 Q24 37 30 33' }[mood || 'idle'];
    const eyes = mood === 'think' ? '<circle cx="18" cy="23" r="2.2"/><circle cx="30" cy="22" r="2.2"/>' : '<circle cx="18" cy="24" r="2.4"/><circle cx="30" cy="24" r="2.4"/>';
    const sweat = mood === 'worried' ? '<path d="M37 17 q2 4 0 5 q-2 -1 0 -5z" fill="#74a6ff"/>' : '';
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="hatg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ee7ff"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#f0abfc"/></linearGradient></defs>
      <rect x="6" y="12" width="36" height="32" rx="11" class="m-face"/>
      <path d="M8 16 Q8 4 24 4 Q40 4 40 16 Z" fill="url(#hatg)"/><rect x="4" y="14" width="40" height="5" rx="2.5" fill="url(#hatg)"/><rect x="22" y="2" width="4" height="9" rx="2" fill="#0a0a12" opacity=".35"/>
      <g fill="currentColor">${eyes}</g><path d="${mouth}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>${sweat}</svg>`;
  }

  /* ---------- разметка ---------- */
  function mount() {
    const wrap = $('canvasWrap');
    const el = document.createElement('div');
    el.className = 'mentor'; el.id = 'mentor';
    el.innerHTML = `<div class="m-bubble" id="mBubble" role="dialog" aria-live="polite" hidden>
        <div class="m-head"><b>Арчи</b><span class="m-role">прораб</span><span class="m-step" id="mStep"></span><button type="button" class="m-x" id="mClose" aria-label="Свернуть">×</button></div>
        <div class="m-text" id="mText"></div>
        <div class="m-acts" id="mActs"></div>
        <form class="m-ask" id="mAsk" hidden><input id="mAskIn" autocomplete="off" placeholder="Спроси своими словами…" aria-label="Вопрос Арчи"><button type="submit" class="btn primary">Спросить</button></form>
      </div>
      <button type="button" class="m-ava" id="mAva" aria-label="Арчи, наставник: открыть">${face('idle')}<span class="m-dot" id="mDot" hidden></span></button>`;
    wrap.appendChild(el);
    const spot = document.createElement('div'); spot.className = 'spot'; spot.id = 'spot'; spot.hidden = true; document.body.appendChild(spot);
    const card = document.createElement('div'); card.className = 'tour-card'; card.id = 'tourCard'; card.hidden = true; document.body.appendChild(card);
    $('mAva').addEventListener('click', () => { if ($('mBubble').hidden) menu(); else hide(); });
    $('mClose').addEventListener('click', hide);
    $('mActs').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) act(b.getAttribute('data-m'), b.getAttribute('data-arg')); });
    $('mAsk').addEventListener('submit', e => { e.preventDefault(); const q = $('mAskIn').value.trim(); if (q) askClaude(q); });
    card.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) tourAct(b.getAttribute('data-t')); });
  }

  function setMood(m) { $('mAva').innerHTML = face(m) + '<span class="m-dot" id="mDot" hidden></span>'; }
  function hide() { $('mBubble').hidden = true; }
  function say(html, opts) {
    opts = opts || {};
    const now = Date.now();
    if (!opts.force && now - run.lastSay < 6000 && !$('mBubble').hidden && run.mission) { run.queue = [html, opts]; return; }
    run.lastSay = now;
    setMood(opts.mood || 'idle');
    $('mText').innerHTML = html;
    $('mStep').textContent = opts.step || '';
    const acts = (opts.acts || []).map(([label, cmd, arg, primary]) => `<button type="button" class="btn ${primary ? 'primary' : 'ghost'}" data-m="${cmd}" data-arg="${esc(arg || '')}">${esc(label)}</button>`).join('');
    $('mActs').innerHTML = acts;
    $('mAsk').hidden = !opts.ask || !run.sample;
    $('mBubble').hidden = false;
    if (opts.focus) pulse(opts.focus);
    clearTimeout(run.autoHide);
    if (opts.auto) run.autoHide = setTimeout(() => { if (!document.activeElement || !$('mentor').contains(document.activeElement)) hide(); }, opts.auto);
  }
  function pulse(sel) {
    const t = document.querySelector(sel);
    if (!t) return;
    t.classList.add('m-pulse');
    setTimeout(() => t.classList.remove('m-pulse'), 4200);
  }

  /* ---------- тур по интерфейсу (5 шагов) ---------- */
  const TOUR = [
    { sel: '#palette', title: 'Склад деталей', text: 'Здесь компоненты: серверы, базы, брокеры, нейросети. Перетащи деталь на площадку или просто нажми на неё. Серые детали откроются на следующих уровнях.' },
    { sel: '#canvasWrap', title: 'Площадка', text: 'Тут ты строишь систему. Тяни связь от кружка справа у узла к другому узлу: стрелка значит «кто кого вызывает». Цветные точки — живые запросы, красные капли — отказы.' },
    { sel: '.toolbar', title: 'Пульт', text: '«Проверить решение» сверяет систему с целями уровня. «Уронить узел» — хаос-тест: проверка, переживёт ли система сбой. Ползунок «Нагрузка» имитирует пик.' },
    { sel: '.panel', title: 'Прораб справа', text: '«Задание» — легенда, цели и подсказки. «Узел» — настройки выбранной детали и кнопка «Как это работает» с пошаговым разбором и кодом. «Метрики» — цифры, хаос-тест и стиль архитектуры.' },
    { sel: '#metrics', title: 'Приборы', text: 'Сколько запросов проходит, сколько успешно, сколько ждать ответа и сколько стоит инфраструктура в месяц. Цвет подсказывает, где плохо.' }
  ];
  let tourI = 0;
  function tour(i) {
    tourI = i;
    const step = TOUR[i];
    const t = document.querySelector(step.sel);
    hide();
    if (!t) { endTour(); return; }
    const r = t.getBoundingClientRect();
    const spot = $('spot'); spot.hidden = false;
    Object.assign(spot.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: r.height + 12 + 'px' });
    const card = $('tourCard'); card.hidden = false;
    card.innerHTML = `<div class="tc-head">${face('happy')}<div><small>ЗНАКОМСТВО · ${i + 1} ИЗ ${TOUR.length}</small><b>${esc(step.title)}</b></div></div><p>${esc(step.text)}</p><div class="tc-acts"><button type="button" class="btn ghost" data-t="skip">Пропустить</button>${i ? '<button type="button" class="btn" data-t="prev">Назад</button>' : ''}<button type="button" class="btn primary" data-t="next">${i === TOUR.length - 1 ? 'Поехали' : 'Дальше'}</button></div>`;
    const cw = Math.min(340, window.innerWidth - 32);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    let x = r.right + 16, y = r.top;
    if (x + cw > window.innerWidth - 16) x = r.left - cw - 16;
    if (x < 16) { x = Math.max(16, Math.min(window.innerWidth - cw - 16, r.left + r.width / 2 - cw / 2)); y = r.bottom + 16; if (y + ch > window.innerHeight - 16) y = Math.max(16, r.top - ch - 16); }
    y = Math.max(16, Math.min(window.innerHeight - ch - 16, y));
    card.style.left = x + 'px'; card.style.top = y + 'px';
    card.querySelector('[data-t="next"]').focus();
  }
  function tourAct(a) {
    if (a === 'next') { if (tourI < TOUR.length - 1) tour(tourI + 1); else endTour(); }
    if (a === 'prev') tour(Math.max(0, tourI - 1));
    if (a === 'skip') endTour();
  }
  function endTour() {
    $('spot').hidden = true; $('tourCard').hidden = true;
    M.tourDone = true; save();
    startMission(true);
  }

  /* ---------- миссии: учимся действием ---------- */
  const G = () => A.graph;
  const has = t => G().nodes.some(n => n.type === t);
  const edge = (ta, tb) => G().edges.some(e => { const a = G().nodes.find(n => n.id === e.from), b = G().nodes.find(n => n.id === e.to); return a && b && a.type === ta && b.type === tb; });
  const nodeOf = t => G().nodes.find(n => n.type === t);
  const MISSIONS = {
    first: [
      { say: 'Задача — сервис заметок. Перетащи <b>«Сервис»</b> со склада слева на площадку.', focus: '.part[data-type="app"]', check: () => has('app') },
      { say: 'Теперь проведи связь: потяни от <b>кружка справа у «Пользователей»</b> к сервису. Стрелка значит «кто кого вызывает».', check: () => edge('client', 'app') },
      { say: 'Запросы дошли, но заметки негде хранить, и прораб справа ругается. Добавь <b>«Реляционную БД»</b>.', focus: '.part[data-type="sql"]', check: () => has('sql') },
      { say: 'Соедини сервис с базой: от кружка сервиса к БД.', check: () => edge('app', 'sql') },
      { say: 'Посмотри на приборы внизу: успешность, время ответа, цена. Теперь нажми <b>«Проверить решение»</b>.', focus: '#checkBtn', check: () => run.flags.check },
      { done: 'Готово! Это классическая трёхзвенка: клиент, сервер, база. Выдели базу и нажми «Как это работает» — там путь одного запроса по шагам, с кодом.' }
    ],
    scale: [
      { say: 'Нагрузка почти 3 000 RPS, а один сервис тянет 2 500. Видишь красные капли? Это отказы. Выдели сервис и подними <b>«Экземпляры»</b> до 3.', check: () => (nodeOf('app') || { props: {} }).props.count >= 3 },
      { say: 'Экземпляров три, а работает один: пользователи стучатся на один адрес. Добавь <b>«Балансировщик»</b>.', focus: '.part[data-type="lb"]', check: () => has('lb') },
      { say: 'Перестрой связи: Пользователи → Балансировщик → Сервис. Старую стрелку Пользователи → Сервис выдели и удали клавишей Delete.', check: () => edge('client', 'lb') && edge('lb', 'app') && !edge('client', 'app') },
      { say: 'Проверим надёжность. Нажми <b>«Уронить узел»</b> — это хаос-тест, как Chaos Monkey в Netflix.', focus: '#chaosBtn', check: () => run.flags.chaos },
      { say: 'Посмотри на успешность внизу. С тремя серверами два оставшихся держат нагрузку: это правило N+1. Нажми «Поднять всё», затем «Проверить решение».', focus: '#checkBtn', check: () => run.flags.check && !Object.keys(A.down).length },
      { done: 'Отлично. Ты масштабировал stateless-сервис горизонтально и проверил отказ. Ответь на вопросы в «Задании» — это звезда за решения.' }
    ],
    cache: [
      { say: 'База перегружена больше чем втрое. Выдели её и посмотри в карточке, чем она занята.', check: () => A.sel && A.sel.type === 'node' && (G().nodes.find(n => n.id === A.sel.id) || {}).type === 'sql' },
      { say: 'Почти всё — чтения, причём одни и те же товары. Поставь <b>«Кэш»</b> и связь Сервис → Кэш.', focus: '.part[data-type="cache"]', check: () => edge('app', 'cache') },
      { say: 'Горячих данных 24 ГБ. Чем больше их влезает в память, тем выше hit ratio. Выбери у кэша 32 ГБ.', check: () => { const c = nodeOf('cache'); return c && c.props.mem * c.props.count >= 24; } },
      { say: 'Нажми «Проверить решение». А потом попробуй без кэша, на репликах, и сравни цену.', focus: '#checkBtn', check: () => run.flags.check },
      { done: 'Кэш снял с базы больше 90 % чтений. Загляни в разбор кэша: там cache-aside, инвалидация и cache stampede.' }
    ],
    email: [
      { say: 'Письмо отправляется прямо в запросе: пользователь ждёт 650 мс, а сбои провайдера роняют регистрацию. Удали связь Сервис → Почтовый провайдер.', check: () => !edge('app', 'external') },
      { say: 'Поставь <b>«Брокер сообщений»</b> и <b>«Обработчики»</b>. Связи: Сервис → Брокер → Обработчики → Провайдер.', check: () => edge('app', 'queue') && edge('queue', 'worker') && edge('worker', 'external') },
      { say: 'Смотри метрику «Очередь» внизу. Растёт? Добавь обработчиков, а у брокера — партиций: одну партицию читает один потребитель.', check: () => A.res && A.res.jobs.backlogRate < 0.5 && A.res.jobs.in > 0 },
      { say: 'Провайдер иногда отвечает ошибкой, и письма теряются. Включи у брокера «Повторы + DLQ».', check: () => (nodeOf('queue') || { props: {} }).props.retries },
      { done: 'Теперь регистрация не ждёт почту и не падает вместе с ней. Это и есть асинхронная интеграция.' }
    ]
  };

  function startMission(fromTour) {
    const L = run.level;
    const m = MISSIONS[L.id];
    if (m && !(A.progress[L.id] || {}).stars) {
      run.mission = m; run.step = 0;
      showStep(true);
      return;
    }
    run.mission = null;
    brief(fromTour);
  }
  function showStep(force) {
    const m = run.mission, s = m[run.step];
    if (!s) return;
    if (s.done) { say(s.done, { mood: 'happy', force: true, step: 'миссия выполнена', acts: [['Спасибо', 'hide', '', true]], ask: true }); run.mission = null; return; }
    say(s.say, { force, step: `шаг ${run.step + 1} из ${m.length - 1}`, focus: s.focus, acts: [['Не получается', 'hintstep'], ['Дальше я сам', 'skipm']] });
  }
  function checkMission() {
    if (!run.mission) return;
    const s = run.mission[run.step];
    if (s && !s.done && s.check()) {
      run.step++;
      run.flags = {};
      run.lastProgress = Date.now();
      const next = run.mission[run.step];
      if (next && !next.done) setTimeout(() => showStep(true), 350);
      else showStep(true);
    }
  }

  function brief(fromTour) {
    const L = run.level;
    if (L.interview) { say('<b>Собеседование, этап «Схема».</b> Собери систему под требования: симулятор проверит нагрузку, задержку, отказоустойчивость и бюджет. Подсказок нет, как на настоящем интервью, но спросить меня своими словами можно.', { force: true, auto: 12000, acts: [['Понял', 'hide', '', true]], ask: true }); return; }
    if (L.sandbox) { say('Песочница: все детали открыты, нагрузку задаёшь во вкладке «Задание». Собери что угодно и смотри, где сломается.', { force: true, acts: [['Понял', 'hide', '', true]], ask: true }); return; }
    const h = (L.hints || [])[0];
    say(`<b>${esc(SD.levelLabel(L))}: ${esc(L.title)}.</b> Сегодня учимся: ${esc((L.chips || []).join(', '))}. ${h ? esc(h.why) : ''}`, {
      force: true, step: fromTour ? '' : 'брифинг', auto: 16000,
      acts: [['Подскажи, с чего начать', 'hint', '', true], ['Сам разберусь', 'hide']], ask: true
    });
  }

  /* ---------- быстрые ответы ---------- */
  function menu() {
    const sel = A.sel && A.sel.type === 'node' ? G().nodes.find(n => n.id === A.sel.id) : null;
    const acts = [['Что сейчас не так?', 'whatswrong', '', true], ['Что сделать дальше?', 'hint']];
    if (sel) acts.push([`Объясни «${sel.label || SD.TYPES[sel.type].name}»`, 'explain', sel.id]);
    acts.push(['Паттерны и антипаттерны', 'patterns'], ['Тур по интерфейсу', 'tour'], ['Мой прогресс', 'progress']);
    if (run.mission) acts.unshift(['Текущее задание', 'curstep', '', true]);
    say('Чем помочь? Можно спросить и своими словами.', { force: true, acts, ask: true, mood: 'idle' });
  }
  function act(cmd, arg) {
    if (cmd === 'hide') hide();
    if (cmd === 'skipm') { run.mission = null; hide(); }
    if (cmd === 'curstep') showStep(true);
    if (cmd === 'tour') tour(0);
    if (cmd === 'patterns') { hide(); SD.patterns.open(); }
    if (cmd === 'chgcmp' && A.lastChange && SD.guide) { hide(); const lc = A.lastChange; if (lc.kind === 'eprop') SD.guide.openEdge(lc.id, lc.key); else SD.guide.open(lc.id, lc.key); }
    if (cmd === 'intback') { hide(); if (SD.interview) SD.interview.back(); }
    if (cmd === 'live') { hide(); document.getElementById('tabLive').click(); }
    if (cmd === 'hintstep') {
      const L = run.level, h = (L.hints || [])[Math.min(run.step, (L.hints || []).length - 1)];
      say(`${h ? esc(h.text) + ' <i>' + esc(h.why) + '</i>' : 'Посмотри советы прораба во вкладке «Задание».'}`, { force: true, acts: [['Вернуться к заданию', 'curstep', '', true]], ask: true, mood: 'think' });
    }
    if (cmd === 'hint') {
      const L = run.level, n = A.hintsShown[L.id] || 0, hs = L.hints || [];
      if (!hs.length) { say(L.interview ? 'На собеседовании подсказок нет. Посмотри, что видит прораб во вкладке «Задание», или спроси меня своими словами.' : 'Подсказок тут нет: это песочница. Спроси меня своими словами.', { force: true, ask: true }); return; }
      const i = Math.min(n, hs.length - 1);
      if (n < hs.length && H.revealHint) H.revealHint();
      say(`<b>Подсказка ${i + 1} из ${hs.length}.</b> ${esc(hs[i].text)}<br><i>Почему: ${esc(hs[i].why)}</i>`, { force: true, mood: 'think', acts: i < hs.length - 1 ? [['Ещё подсказку', 'hint', '', true]] : [['Показать эталон', 'solution']], ask: true });
    }
    if (cmd === 'solution' && H.solution) { hide(); H.solution(); }
    if (cmd === 'whatswrong') {
      const bad = (A.advice || []).filter(a => a.sev !== 'info').slice(0, 2);
      const goals = (A.goals || []).filter(g => !g.ok);
      if (!bad.length && !goals.length) { say('Всё хорошо: целей не провалено, перегрузок нет. Попробуй сократить стоимость ради третьей звезды или ответь на вопросы.', { force: true, mood: 'happy', ask: true }); return; }
      let h = '';
      if (goals.length) h += `Не выполнено целей: ${goals.length}. Главное: <b>${esc(goals[0].text.toLowerCase())}</b> (${esc(goals[0].detail)}).<br>`;
      if (bad.length) h += bad.map(b => '• ' + esc(b.text)).join('<br>');
      const dv = bad.find(b => b.dive && SD.DIVES[b.dive]);
      say(h, { force: true, mood: 'worried', acts: dv ? [['Разобраться, как это работает', 'dive', dv.dive, true], ['Подсказку', 'hint']] : [['Подсказку', 'hint', '', true]], ask: true });
    }
    if (cmd === 'explain') {
      const n = G().nodes.find(x => x.id === arg); if (!n) return;
      const t = SD.TYPES[n.type];
      say(`<b>${esc(t.name)}.</b> ${esc(t.info.what)} ${esc(t.info.why.split('. ').slice(0, 2).join('. '))}.`, { force: true, acts: t.dive && SD.DIVES[t.dive] ? [['Как это работает', 'dive', t.dive, true]] : [], ask: true });
    }
    if (cmd === 'dive' && H.openDive) { hide(); H.openDive(arg); }
    if (cmd === 'next' && H.next) { hide(); H.next(); }
    if (cmd === 'progress') {
      const types = Object.keys(SD.TYPES).filter(k => SD.TYPES[k].group);
      const dives = Object.keys(SD.DIVES);
      const done = SD.LEVELS.filter(l => (A.progress[l.id] || {}).stars).length;
      const stars = SD.LEVELS.reduce((s, l) => s + ((A.progress[l.id] || {}).stars || 0), 0);
      say(`<div class="m-prog"><span><b>${done}</b> из ${SD.LEVELS.length}<small>уровней</small></span><span><b>${stars}</b> из ${SD.LEVELS.length * 3}<small>звёзд</small></span><span><b>${M.seenTypes.filter(t => types.includes(t)).length}</b> из ${types.length}<small>деталей в деле</small></span><span><b>${M.seenDives.filter(d => dives.includes(d)).length}</b> из ${dives.length}<small>разборов</small></span></div>`, { force: true, mood: 'happy', ask: true });
    }
  }

  /* ---------- вопрос своими словами (Claude) ---------- */
  function context() {
    const L = run.level, r = A.res;
    const nodes = G().nodes.map(n => {
      const nr = r && r.nodes[n.id];
      const props = Object.entries(n.props || {}).filter(([, v]) => v !== false && v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ');
      return `- ${n.id}: ${SD.TYPES[n.type].name}${n.label ? ' «' + n.label + '»' : ''} (${props})${nr ? `, загрузка ${Math.round(nr.util * 100)}%${nr.dead ? ', ЛЕЖИТ' : ''}` : ''}`;
    }).join('\n');
    const edges = G().edges.map(e => `- ${e.from} → ${e.to}${e.props && (e.props.retries || e.props.timeout || e.props.cb) ? ` [timeout=${e.props.timeout} retries=${e.props.retries} cb=${e.props.cb}]` : ''}`).join('\n');
    const goals = (A.goals || []).map(g => `- ${g.ok ? 'OK' : 'НЕТ'}: ${g.text} (${g.detail})`).join('\n');
    const adv = (A.advice || []).slice(0, 6).map(a => '- ' + a.text).join('\n');
    return `Уровень: ${L.title}. Легенда: ${L.story}\nНагрузка: ${JSON.stringify(L.traffic)}\nУзлы:\n${nodes}\nСвязи:\n${edges}\nЦели:\n${goals || '- нет'}\nСоветы симулятора:\n${adv || '- нет'}\nМетрики: успешно ${r ? (r.total.success * 100).toFixed(2) : '?'}%, время ${r ? Math.round(r.total.lat) : '?'} мс, стоимость $${r ? Math.round(r.cost) : '?'}/мес.`;
  }
  const RULES = 'Ты — Арчи, прораб-наставник в учебном тренажёре системного дизайна школы AMP. Ученик может быть новичком. Отвечай по-русски, простыми словами, коротко: до 120 слов, без заголовков и таблиц. Объясняй «почему», опирайся на то, что сейчас на схеме ученика и в метриках. Если ученик просит решение, сначала наведи на него вопросом или подсказкой, а готовое решение давай, только если он настаивает. Термины расшифровывай при первом упоминании.';
  async function askClaude(q) {
    if (!run.sample) return;
    if (run.busy) run.busy.abort();
    const ctl = new AbortController(); run.busy = ctl;
    $('mAskIn').value = '';
    run.chat.push({ role: 'user', content: q });
    if (run.chat.length > 6) run.chat = run.chat.slice(-6);
    $('mText').innerHTML = `<span class="m-q">${esc(q)}</span><span class="m-a">Думаю…</span>`;
    $('mActs').innerHTML = '<button type="button" class="btn ghost" data-m="stop">Остановить</button>';
    $('mActs').querySelector('[data-m="stop"]').onclick = () => ctl.abort();
    setMood('think');
    const turns = [{ role: 'user', content: RULES + '\n\nСостояние тренажёра сейчас:\n' + context() }, { role: 'assistant', content: 'Понял, вижу схему и метрики. Жду вопрос.' }, ...run.chat];
    try {
      const { text } = await run.sample(turns, { cache: false, modelTier: 'quick', signal: ctl.signal, onText: ({ text }) => { const a = $('mText').querySelector('.m-a'); if (a) a.textContent = text; } });
      run.chat.push({ role: 'assistant', content: text });
      setMood('happy');
      $('mActs').innerHTML = '';
    } catch (e) {
      const a = $('mText').querySelector('.m-a');
      if (a) a.textContent = e.text || (e.code === 'cancelled' ? 'Остановил.' : e.code === 'rate_limited' ? 'Слишком много вопросов подряд. Попробуй через минуту.' : e.code === 'not_granted' || e.code === 'sampling_disabled' ? 'Спрашивать Claude на этой странице не разрешено. Быстрые ответы в меню работают и так.' : 'Не получилось ответить. Попробуй ещё раз.');
      if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) { run.sample = null; $('mAsk').hidden = true; }
      run.chat.pop();
      setMood('idle');
      $('mActs').innerHTML = '';
    } finally { if (run.busy === ctl) run.busy = null; }
  }

  /* ---------- события тренажёра ---------- */
  function onLevel(level) {
    run.level = level; run.flags = {}; run.hotSeen = new Set(); run.won = !!(A.progress[level.id] || {}).stars; run.chat = []; run.lastProgress = Date.now();
    if (!M.welcomed) {
      M.welcomed = true; save();
      say('Привет! Я <b>Арчи</b>, прораб этой стройплощадки. Здесь ты строишь системы, пускаешь на них нагрузку и смотришь, где ломается. Показать за минуту, что где?', { force: true, mood: 'happy', acts: [['Покажи', 'tour', '', true], ['Сам разберусь', 'skiptour']] });
      return;
    }
    startMission(false);
  }
  function onEvent(name, data) {
    if (name === 'check') run.flags.check = true;
    if (name === 'chaos') {
      run.flags.chaos = true;
      if (!run.mission) say(`Хаос-тест: упал экземпляр «${esc(data && data.name)}». Смотри на «Успешно» внизу. Упала успешность — значит, у этого узла нет резерва или остальным не хватает мощности.`, { mood: 'worried', acts: [['Поднять всё', 'heal'], ['Что не так?', 'whatswrong', '', true]] });
    }
    if (name === 'win' && !run.won && run.level && run.level.interview) {
      run.won = true;
      say('Схема держит нагрузку. На собеседовании это половина дела: вернись к этапам и расскажи, где узкие места и чем ты заплатил за решения.', { force: true, mood: 'happy', acts: [['К этапам', 'intback', '', true], ['Остаться', 'hide']] });
    }
    if (name === 'win' && !run.won) {
      run.won = true;
      say(`Уровень пройден! ${'★'.repeat(data.stars)}${'☆'.repeat(3 - data.stars)}. ${data.stars < 3 ? 'Ещё звёзды дают обоснованные решения в вопросах и экономия бюджета.' : 'Все три звезды — чисто сработано.'}`, { force: true, mood: 'happy', acts: [['Следующий уровень', 'next', '', true], ['Остаться', 'hide']] });
      confetti();
    }
    if (name === 'dive' && data && !M.seenDives.includes(data)) { M.seenDives.push(data); save(); }
    checkMission();
  }
  function onUpdate() {
    if (!run.level) return;
    G().nodes.forEach(n => {
      if (n.type === 'client' || n.type === 'external' || M.seenTypes.includes(n.type)) return;
      M.seenTypes.push(n.type); save();
      if (run.mission || !M.tourDone) return;
      const t = SD.TYPES[n.type];
      say(`Новая деталь: <b>${esc(t.name)}</b>. ${esc(t.info.what)}`, { auto: 12000, acts: t.dive && SD.DIVES[t.dive] ? [['Как это работает', 'dive', t.dive, true], ['Понял', 'hide']] : [['Понял', 'hide', '', true]] });
    });
    checkMission();
    if (run.mission || !M.tourDone) return;
    const r = A.res; if (!r) return;
    const hot = G().nodes.find(n => r.nodes[n.id] && r.nodes[n.id].status === 'hot' && !run.hotSeen.has(n.id));
    if (hot) {
      run.hotSeen.add(hot.id);
      const adv = (A.advice || []).find(a => a.node === hot.id && a.sev === 'bad');
      if (Date.now() - run.lastSay > 15000) say(`«${esc(hot.label || SD.TYPES[hot.type].name)}» перегрелся: красные капли под ним — отказы. ${adv ? esc(adv.text) : ''}`, { mood: 'worried', auto: 14000, acts: adv && adv.dive && SD.DIVES[adv.dive] ? [['Почему так?', 'dive', adv.dive, true], ['Понял', 'hide']] : [['Понял', 'hide', '', true]] });
    }
    const storm = Object.values(r.edges).some(e => e.info && e.info.amp > 1.3);
    if (storm && !run.flags.stormSaid) { run.flags.stormSaid = true; say('Красная пунктирная связь — это шторм повторов: каждый отказ рождает ещё запросы к уже перегруженному узлу. Нужны таймаут, пауза между повторами и circuit breaker.', { mood: 'worried', acts: [['Как это работает', 'dive', 'resilience', true]] }); }
    const stuck = Date.now() - run.lastProgress > 120000 && (A.goals || []).some(g => !g.ok);
    if (stuck && !run.flags.stuckSaid && $('mBubble').hidden) { run.flags.stuckSaid = true; say('Давно бьёмся над этим уровнем. Подсказать следующий шаг?', { mood: 'think', acts: [['Подскажи', 'hint', '', true], ['Сам', 'hide']] }); }
    if ((A.goals || []).filter(g => g.ok).length > (run.flags.okCount || 0)) { run.flags.okCount = (A.goals || []).filter(g => g.ok).length; run.lastProgress = Date.now(); }
  }
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div'); box.className = 'confetti';
    const colors = ['#6ee7ff', '#a78bfa', '#f0abfc', '#17d07c', '#fbbf24'];
    for (let i = 0; i < 40; i++) { const s = document.createElement('i'); s.style.left = Math.random() * 100 + '%'; s.style.background = colors[i % colors.length]; s.style.animationDelay = Math.random() * 0.4 + 's'; s.style.transform = `rotate(${Math.random() * 360}deg)`; box.appendChild(s); }
    $('canvasWrap').appendChild(box);
    setTimeout(() => box.remove(), 2600);
  }

  const origAct = act;
  act = function (cmd, arg) {
    if (cmd === 'skiptour') { M.tourDone = true; save(); startMission(false); return; }
    if (cmd === 'heal' && H.heal) { H.heal(); hide(); return; }
    origAct(cmd, arg);
  };

  async function init(app, hooks) {
    A = app; H = hooks || {}; load(); mount();
    try {
      const s = window.claude && window.claude.use ? await window.claude.use('sample') : null;
      run.sample = s || null;
      if (run.sample && !$('mBubble').hidden && !$('mActs').querySelector('[data-m="stop"]')) $('mAsk').hidden = false;
    } catch (e) { run.sample = null; }
  }

  let liveCount = 0;
  function liveHint(card) {
    const lc = A.lastChange;
    if (!run.mission && lc && (lc.kind === 'prop' || lc.kind === 'eprop') && Date.now() - lc.at < 4000) {
      let d = null, type = 'edge';
      if (lc.kind === 'prop') { const n = A.graph.nodes.find(x => x.id === lc.id); if (n) { type = n.type; d = (SD.TYPES[n.type].props || []).find(p => p.key === lc.key); } }
      else d = (SD.EDGE_DEFS || []).find(p => p.key === lc.key);
      if (d) {
        const mean = SD.optSimple ? SD.optSimple(type, d.key, lc.value) : '';
        const eff = (lc.effects || []).slice(0, 3);
        const st = !eff.length && SD.changeStress ? SD.changeStress(A, lc, d) : null, stc = st && st.chips.length ? st.chips.slice(0, 3) : null;
        const good = (stc || eff).filter(x => x.good === true).length, bad = (stc || eff).filter(x => x.good === false).length;
        const tail = eff.length ? '<br>На схеме: ' + eff.map(x => `${esc(x.l)} ${esc(x.f)} → <b>${esc(x.t)}</b>`).join(', ') + '.' : stc ? `<br>В обычный день цифры те же. ${esc(st.title)}: ` + stc.map(x => `${esc(x.l)} ${esc(x.f)} → <b>${esc(x.t)}</b>`).join(', ') + '.' : '<br>Цифры на этой схеме почти не изменились — эффект проявится при другой нагрузке или сбое.';
        say(`<b>${esc(d.label)}: ${esc(SD.valueLabel(d, lc.prev))} → ${esc(SD.valueLabel(d, lc.value))}.</b> ${mean ? esc(mean) + ' ' : ''}${tail}`, { auto: 16000, mood: bad > good ? 'worried' : good ? 'happy' : 'think', acts: [['Сравнить все варианты', 'chgcmp', '', true], ['Понятно', 'hide']] });
        return;
      }
    }
    if (run.mission || !M.tourDone || !card) return;
    liveCount++;
    if (liveCount > 3 && !(card.effects || []).some(e => e.l === 'Цели')) return;
    if (Date.now() - run.lastSay < 8000 && !$('mBubble').hidden) return;
    say(`Разобрал: <b>${esc(card.title)}</b>. Что изменилось в цифрах, как это работает и как выглядит в коде — во вкладке «Разбор».`, { auto: 9000, acts: [['Показать разбор', 'live', '', true]] });
  }
  SD.mentor = { init, onLevel, onEvent, onUpdate, say, menu, liveHint, tour: () => tour(0) };
})();
