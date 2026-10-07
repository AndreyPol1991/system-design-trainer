/* Мост к платформе AMP: протокол trainer/1 через postMessage.

   Тренажёр открыт внутри платформы (ampschool.ru, в рамке) — сообщает ей о пройденных
   заданиях, и они засчитываются в профиль навыков. Открыт сам по себе — моста как будто нет:
   некому отчитываться, ничего не показываем и ничего не отправляем.

   Задание платформы:
   · пройденный уровень любого трека — код равен id уровня (first, p-cacheaside, f-spof,
     k-hpa, a-notify, o-metrics, i-layers); уровень пройден, когда все цели зелёные;
   · схема на собеседовании — int-<задача> (это и есть id уровня этапа «Схема»);
   · задание лаборатории — lab:<лаборатория>:<задание>, как только оно выполнено. Раньше
     засчитывалась лаборатория целиком (lab-<id>), когда выполнены все задания; теперь каждое
     задание отдельно — у лаборатории задания про разные навыки. lab-<id> больше не шлём.
   Что задание подтверждает в графе навыков, решает манифест на стороне платформы:
   задание, о котором она не знает, молча не засчитывается.

   attempts — 1 + число неудачных «Проверить решение» на этом уровне за время, пока открыта
   страница (не больше 99). hints — сколько подсказок уровня раскрыто (не больше ступеней
   уровня и не больше 3). У лабораторий подсказок и проверок нет: 1 и 0.

   Эталон («Эталон», «Эталон по шагам») — подсмотренный ответ. Уровень, пройденный в том же
   заходе после показа эталона, не отправляется. Если эталоном уровень пройден впервые, это
   запоминается: такой уровень не догоняется при следующем входе, пока его не пройдут сами.

   Пройдено раньше вне платформы: после hello один раз отправляем solved по пройденным, но не
   зачтённым (attempts 1, hints 0) — чтобы прогресс не терялся.

   Расширения той же версии (docs/09-trainer-contract.md, раздел 3а). В ready объявляем, что
   умеем: events — события учёбы (их копит и отдаёт js/telemetry.js), skills — принимаем снимок
   уровней навыков. Пользуемся только тем, что платформа объявила в hello.features: старая
   платформа их не объявляет, и событий ей не шлём вовсе.

   Снимок уровней (kind: 'skills') — только чтение: уровни навыков графа по областям
   тренажёра, без имени и почты. «Мой путь» (js/path.js) показывает их у своих навыков с
   пометкой «по данным платформы»; соответствие навыков пути навыкам графа — SKILL_MAP ниже.

   В интерфейсе — значок «в профиле» у зачтённых уровней на карте уровней, у лабораторий и у
   заданий открытой лаборатории, и только после hello. */
(function () {
  const PROTOCOL = 'trainer/1', TRAINER = 'stroyka', KEY = 'amp-stroyka-bridge-v1';
  /* обычный код или задание лаборатории; то же правило, что в манифесте платформы */
  const TASK_ID = /^(?:[a-z0-9][a-z0-9-]{1,40}|lab:[a-z0-9][a-z0-9-]{0,30}:[a-z0-9][a-z0-9-]{0,30})$/;
  const FEATURES = ['events', 'skills', 'open'];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(+v) || 0));
  const labCode = (lab, task) => 'lab:' + lab + ':' + task;

  /* ref: уровни, впервые пройденные эталоном, — их не догоняем */
  const store = { ref: {} };
  try { Object.assign(store, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* без хранилища */ } };

  const B = {
    embedded: window.parent !== window,
    target: '*',
    linked: false,          // пришёл hello: мы внутри платформы
    features: [],           // что платформа объявила в hello
    skills: null,           // снимок уровней с платформы: { at, max, domains }
    credited: new Set(),    // зачтено платформой: hello.solved и accepted
    sent: new Set(),        // отправлено в этом заходе
    queue: new Map(),       // решено до hello — отправим, когда платформа ответит
    misses: {},             // неудачные проверки по уровню
    peeked: new Set()       // эталон открыт в этом заходе
  };
  const tel = () => (B.embedded && SD.telemetry) || null;

  function send(message) {
    if (!B.embedded) return;
    try { window.parent.postMessage(Object.assign({ protocol: PROTOCOL, trainer: TRAINER }, message), B.target); } catch (e) { /* рамка закрылась */ }
  }
  /* сообщение по расширению: только внутри платформы и только если она его объявила */
  function post(feature, message) {
    if (!B.linked || !B.features.includes(feature)) return false;
    send(message);
    return true;
  }
  function offer(task, attempts, hints) {
    if (!B.embedded || !TASK_ID.test(task) || B.credited.has(task) || B.sent.has(task)) return;
    const a = clamp(attempts, 1, 99), h = clamp(hints, 0, 3);
    if (!B.linked) { if (!B.queue.has(task)) B.queue.set(task, { a, h }); return; }
    B.sent.add(task);
    send({ kind: 'solved', task, attempts: a, hints: h });
  }

  /* ---------- вызовы из ядра ---------- */
  /* все цели уровня зелёные (app.js, award) — вызывается до записи звёзд */
  function won(L, A) {
    if (!L || L.sandbox || !L.id) return;
    const id = L.id;
    if (B.peeked.has(id)) {
      if (!L.interview && !((A.progress[id] || {}).stars)) { store.ref[id] = 1; persist(); }
      return;
    }
    if (store.ref[id]) { delete store.ref[id]; persist(); }
    const steps = Math.min((L.hints || []).length, 3);
    offer(id, 1 + (B.misses[id] || 0), Math.min((A.hintsShown || {})[id] || 0, steps));
    if (tel()) tel().passed(id);
  }
  /* «Проверить решение» нашло невыполненные цели */
  function miss(L) { if (L && L.id) B.misses[L.id] = (B.misses[L.id] || 0) + 1; }
  /* показан эталон: кнопка «Эталон» (app.js) или «Эталон по шагам» (walk.js, start — и с кнопки, и из Ctrl+K) */
  function peek(L) {
    if (!L || !L.id) return;
    B.peeked.add(L.id);
    if (tel()) tel().gaveUp(L.id);
  }
  /* лаборатория: выполнены все задания. Прежний зачёт целиком — теперь засчитывается каждое
     задание (labTask); оставлено, чтобы старые вызовы (labs-1.js, lab-table.js) не ломались */
  function labDone() { /* задания уже ушли по одному */ }
  /* лаборатория: выполнено одно задание (labs-1.js, done; lab-table.js, встроенная таблица) */
  function labTask(lab, task) {
    if (!lab || !task) return;
    offer(labCode(lab, task), 1, 0);
    if (tel()) tel().labPassed(lab, task);
  }
  /* лаборатория открыта (labs-1.js, open) — для событий учёбы */
  function labOpen(lab) { if (lab && tel()) tel().labStarted(lab); }

  /* ---------- ответ платформы ---------- */
  function whenApp(fn, tries) {
    const A = SD.app && SD.app.A;
    if (A && A.level) { fn(A); return; }
    if ((tries || 0) < 150) setTimeout(() => whenApp(fn, (tries || 0) + 1), 100);
  }
  function catchUp(A) {
    B.queue.forEach((v, task) => offer(task, v.a, v.h));
    B.queue.clear();
    Object.keys(A.progress || {}).forEach(id => {
      const L = SD.levelById(id);
      if (!L || L.sandbox || !(A.progress[id] || {}).stars || store.ref[id]) return;
      offer(id, 1, 0);
    });
    /* лаборатории — по заданиям: и то, что сделано до моста, и то, что было до перехода на коды заданий */
    const labs = SD.labs && SD.labs.progress ? SD.labs.progress() : {};
    (SD.LABS || []).forEach(l => (labs[l.id] || []).forEach(t => { if (l.tasks.some(x => x.id === t)) offer(labCode(l.id, t), 1, 0); }));
  }

  /* снимок уровней: берём только то, что описано в протоколе, и только разумных размеров */
  function readSkills(data) {
    if (!Array.isArray(data.domains) || data.domains.length > 20) return null;
    const lvl = v => (Number.isInteger(v) && v >= 0 && v <= 4 ? v : null);
    const domains = [];
    for (const d of data.domains) {
      if (!d || typeof d.id !== 'string' || !Array.isArray(d.skills) || d.skills.length > 60) return null;
      const skills = [];
      for (const s of d.skills) {
        if (!s || typeof s.id !== 'string' || lvl(s.level) === null) return null;
        skills.push({ id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 120) : s.id, level: s.level });
      }
      domains.push({ id: d.id, name: typeof d.name === 'string' ? d.name.slice(0, 120) : d.id, skills });
    }
    return { at: typeof data.at === 'string' ? data.at.slice(0, 10) : '', max: 4, domains };
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!B.embedded || event.source !== window.parent || typeof data !== 'object' || data === null || data.protocol !== PROTOCOL) return;
    if (data.kind === 'hello') {
      B.target = event.origin && event.origin !== 'null' ? event.origin : '*';
      B.linked = true;
      B.features = Array.isArray(data.features) ? FEATURES.filter(f => data.features.includes(f)) : [];
      (Array.isArray(data.solved) ? data.solved : []).forEach(t => { if (typeof t === 'string') B.credited.add(t); });
      if (tel()) tel().link(B.features.includes('events'));
      mountLabs();
      whenApp(A => { catchUp(A); paint(); });
      paint();
      /* «Следующий шаг» платформы: открыть присланное задание (open). Подсказка, а не замок — дальше человек ходит где хочет */
      if (B.features.includes('open') && typeof data.task === 'string') whenApp(() => openTask(data.task));
      /* окно «Зачем ты здесь?» внутри платформы лишнее: цель и шаг задаёт она */
      [0, 400, 1500].forEach(t => setTimeout(() => { const g = document.getElementById('goalModal'); if (g && !g.hidden) g.hidden = true; }, t));
    }
    if (data.kind === 'accepted' && typeof data.task === 'string') {
      B.credited.add(data.task);
      paint();
    }
    if (data.kind === 'skills' && B.linked) {
      const snap = readSkills(data);
      if (!snap) return;
      B.skills = snap;
      css();
      /* «Мой путь» открыт — перерисовываем, чтобы уровни появились сразу */
      const m = document.getElementById('pathModal');
      if (m && !m.hidden && SD.path && SD.path.open) SD.path.open();
    }
  });

  /* ---------- навыки «Моего пути» ↔ навыки графа платформы ----------
     Навык пути шире навыка графа: «Транзакции и согласованность» — это и транзакции в базе (D3),
     и модели согласованности, и распределённые транзакции (D12). Поэтому навыку пути
     соответствует несколько навыков графа, а показываем лучший подтверждённый уровень среди них
     и рядом — каждый. Области: D2 интеграции, D3 данные, D4 архитектурный контекст,
     D12 архитектура и качества, D15 аналитический контур, D16 функции на ИИ. */
  const SKILL_MAP = {
    calc: ['SA-D12-02', 'SA-D4-06'],
    scale: ['SA-D12-02'],
    cache: ['SA-D4-05'],
    db: ['SA-D3-02', 'SA-D3-04'],
    tx: ['SA-D3-06', 'SA-D12-03', 'SA-D12-06'],
    async: ['SA-D2-06', 'SA-D2-07', 'SA-D2-08', 'SA-D4-03'],
    rel: ['SA-D12-04', 'SA-D2-09', 'SA-D2-16'],
    arch: ['SA-D12-01', 'SA-D12-05', 'SA-D4-01', 'SA-D4-02', 'SA-D4-04'],
    ops: ['SA-D12-07', 'SA-D12-09'],
    data: ['SA-D15-01', 'SA-D15-02', 'SA-D15-04', 'SA-D15-06'],
    cloud: ['SA-D12-02', 'SA-D3-04'],
    rt: ['SA-D2-14', 'SA-D3-04'],
    front: ['SA-D2-01', 'SA-D4-05'],
    saas: ['SA-D12-05', 'SA-D12-02'],
    ai: ['SA-D16-01', 'SA-D16-02', 'SA-D16-03', 'SA-D16-04', 'SA-D16-05']
  };
  /* уровень навыка пути по снимку: null — снимка нет или его навыков в снимке нет */
  function pathLevel(skId) {
    if (!B.skills) return null;
    const ids = SKILL_MAP[skId] || [], all = {};
    B.skills.domains.forEach(d => d.skills.forEach(s => { all[s.id] = s; }));
    const found = ids.map(id => all[id]).filter(Boolean);
    if (!found.length) return null;
    return { level: Math.max(...found.map(s => s.level)), max: B.skills.max, at: B.skills.at, skills: found.map(s => ({ name: s.name, level: s.level })) };
  }

  /* ---------- значок «в профиле» ---------- */
  const BADGE = 'amp-prof';
  function css() {
    if (document.getElementById('ampProfCss')) return;
    const s = document.createElement('style');
    s.id = 'ampProfCss';
    s.textContent = `.${BADGE}{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid currentColor;border-radius:999px;font:600 10.5px/15px var(--f-mono, monospace);letter-spacing:0;color:var(--ok);white-space:nowrap;vertical-align:1px}
.lvl .n .${BADGE}{color:var(--ok);letter-spacing:0}
.pt-plat{display:block;margin:2px 0 4px;color:var(--ok);font:600 11.5px/1.4 var(--f-mono, monospace)}
.pt-plat span{color:var(--muted, inherit);font-weight:400}`;
    document.head.appendChild(s);
  }
  function badge(host, on) {
    if (!host) return;
    let tag = host.querySelector('.' + BADGE);
    if (on && !tag) {
      tag = document.createElement('span');
      tag.className = BADGE; tag.textContent = 'в профиле'; tag.title = 'Засчитано в профиль навыков AMP';
      host.appendChild(tag);
    }
    if (!on && tag) tag.remove();
  }
  function paintMap() {
    const body = document.getElementById('mapBody'); if (!body) return;
    body.querySelectorAll('button[data-level]').forEach(b => {
      const n = b.querySelector('.n');
      badge(n ? (n.querySelector('span') || n) : b, B.credited.has(b.getAttribute('data-level')));
    });
  }
  /* лаборатория в профиле: прежний зачёт целиком или все её задания по отдельности */
  const labCredited = l => B.credited.has('lab-' + l.id) || (l.tasks.length > 0 && l.tasks.every(t => B.credited.has(labCode(l.id, t.id))));
  function paintLabs() {
    const list = document.getElementById('labList'); if (!list) return;
    list.querySelectorAll('[data-lab]').forEach(b => {
      const l = (SD.LABS || []).find(x => x.id === b.getAttribute('data-lab'));
      badge(b.querySelector('.lab-prog') || b, !!l && labCredited(l));
    });
    /* задания открытой лаборатории: список заданий идёт в том же порядке, что l.tasks */
    const on = list.querySelector('.lab-item.on[data-lab]'), lab = on && (SD.LABS || []).find(x => x.id === on.getAttribute('data-lab'));
    const items = document.querySelectorAll('#labTasks > li');
    if (lab && items.length === lab.tasks.length) items.forEach((li, i) => badge(li, B.credited.has(labCode(lab.id, lab.tasks[i].id))));
  }
  function paint() { if (!B.linked) return; css(); paintMap(); paintLabs(); }
  let labsObs = null, tasksObs = null, watched = null;
  /* список заданий (#labTasks) пересоздаётся при открытии лаборатории и перерисовывается при каждом
     выполненном задании. Следим только за ним, а не за всей лабораторией: в лаборатории живая
     анимация, и наблюдатель на всё её дерево срабатывал бы каждый кадр */
  function watchTasks() {
    const t = document.getElementById('labTasks');
    if (!tasksObs || !t || t === watched) return;
    watched = t; tasksObs.disconnect(); tasksObs.observe(t, { childList: true });
  }
  function mountLabs() {
    const list = document.getElementById('labList'), main = document.getElementById('labMain');
    if (labsObs || !list || !window.MutationObserver) return;
    labsObs = new MutationObserver(() => { if (!B.linked) return; watchTasks(); paintLabs(); });
    tasksObs = new MutationObserver(() => { if (B.linked) paintLabs(); });
    labsObs.observe(list, { childList: true });
    if (main) labsObs.observe(main, { childList: true });
    watchTasks();
  }
  /* карта уровней перерисовывается целиком — после неё дорисовываем значки */
  if (SD.panels && SD.panels.map) {
    const baseMap = SD.panels.map;
    SD.panels.map = function () { const r = baseMap.apply(this, arguments); paint(); return r; };
  }

  SD.bridge = { won, miss, peek, labDone, labTask, labOpen, post, pathLevel, skills: () => B.skills, state: B, PROTOCOL, TRAINER, FEATURES };

  /* ready — когда страница собрана и площадка запущена */
  /* код задания: уровень (cache) или задание лаборатории (lab:<лаборатория>:<задание>, lab:<лаборатория>) */
  function openTask(task) {
    const lab = /^lab:([a-z0-9-]+)(?::[a-z0-9-]+)?$/.exec(task);
    if (lab) { if (SD.labs && SD.labs.open && (SD.LABS || []).some(l => l.id === lab[1])) SD.labs.open(lab[1]); return; }
    const L = SD.levelById && SD.levelById(task);
    if (!L || !SD.app || !SD.app.loadLevel) return;
    document.querySelectorAll('.modal').forEach(m => { if (m.id !== 'labModal') m.hidden = true; });
    SD.app.loadLevel(L);
  }
  const ready = () => send({ kind: 'ready', features: FEATURES });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else setTimeout(ready, 0);
})();
