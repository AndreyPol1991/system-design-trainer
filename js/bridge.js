/* Мост к платформе AMP: протокол trainer/1 через postMessage.

   Тренажёр открыт внутри платформы (ampschool.ru, в рамке) — сообщает ей о пройденных
   заданиях, и они засчитываются в профиль навыков. Открыт сам по себе — моста как будто нет:
   некому отчитываться, ничего не показываем.

   Задание платформы:
   · пройденный уровень любого трека — код равен id уровня (first, p-cacheaside, f-spof,
     k-hpa, a-notify, o-metrics, i-layers); уровень пройден, когда все цели зелёные;
   · схема на собеседовании — int-<задача> (это и есть id уровня этапа «Схема»);
   · лаборатория целиком — lab-<id>, когда выполнены все её задания.
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

   В интерфейсе — только значок «в профиле» у зачтённых уровней на карте уровней и у
   лабораторий, и только после hello. */
(function () {
  const PROTOCOL = 'trainer/1', TRAINER = 'stroyka', KEY = 'amp-stroyka-bridge-v1';
  const TASK_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(+v) || 0));

  /* ref: уровни, впервые пройденные эталоном, — их не догоняем */
  const store = { ref: {} };
  try { Object.assign(store, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* без хранилища */ } };

  const B = {
    embedded: window.parent !== window,
    target: '*',
    linked: false,          // пришёл hello: мы внутри платформы
    credited: new Set(),    // зачтено платформой: hello.solved и accepted
    sent: new Set(),        // отправлено в этом заходе
    queue: new Map(),       // решено до hello — отправим, когда платформа ответит
    misses: {},             // неудачные проверки по уровню
    peeked: new Set()       // эталон открыт в этом заходе
  };

  function send(message) {
    if (!B.embedded) return;
    try { window.parent.postMessage(Object.assign({ protocol: PROTOCOL, trainer: TRAINER }, message), B.target); } catch (e) { /* рамка закрылась */ }
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
  }
  /* «Проверить решение» нашло невыполненные цели */
  function miss(L) { if (L && L.id) B.misses[L.id] = (B.misses[L.id] || 0) + 1; }
  /* показан эталон */
  function peek(L) { if (L && L.id) B.peeked.add(L.id); }
  /* лаборатория: выполнены все задания */
  function labDone(id) { offer('lab-' + id, 1, 0); }

  /* «Эталон по шагам» строит эталон прямо на площадке — тоже подсмотренный ответ */
  document.addEventListener('click', e => {
    if (!e.target || !e.target.closest || !e.target.closest('#walkBtn')) return;
    const A = SD.app && SD.app.A;
    if (A && A.level) peek(A.level);
  }, true);

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
    const labs = SD.labs && SD.labs.progress ? SD.labs.progress() : {};
    (SD.LABS || []).forEach(l => {
      const d = labs[l.id] || [];
      if (l.tasks.length && l.tasks.every(t => d.includes(t.id))) offer('lab-' + l.id, 1, 0);
    });
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window.parent || typeof data !== 'object' || data === null || data.protocol !== PROTOCOL) return;
    if (data.kind === 'hello') {
      B.target = event.origin && event.origin !== 'null' ? event.origin : '*';
      B.linked = true;
      (Array.isArray(data.solved) ? data.solved : []).forEach(t => { if (typeof t === 'string') B.credited.add(t); });
      mountLabs();
      whenApp(A => { catchUp(A); paint(); });
      paint();
    }
    if (data.kind === 'accepted' && typeof data.task === 'string') {
      B.credited.add(data.task);
      paint();
    }
  });

  /* ---------- значок «в профиле» ---------- */
  const BADGE = 'amp-prof';
  function css() {
    if (document.getElementById('ampProfCss')) return;
    const s = document.createElement('style');
    s.id = 'ampProfCss';
    s.textContent = `.${BADGE}{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid currentColor;border-radius:999px;font:600 10.5px/15px var(--f-mono, monospace);letter-spacing:0;color:var(--ok);white-space:nowrap;vertical-align:1px}
.lvl .n .${BADGE}{color:var(--ok);letter-spacing:0}`;
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
  function paintLabs() {
    const list = document.getElementById('labList'); if (!list) return;
    list.querySelectorAll('[data-lab]').forEach(b => badge(b.querySelector('.lab-prog') || b, B.credited.has('lab-' + b.getAttribute('data-lab'))));
  }
  function paint() { if (!B.linked) return; css(); paintMap(); paintLabs(); }
  let labsObs = null;
  function mountLabs() {
    const list = document.getElementById('labList');
    if (labsObs || !list || !window.MutationObserver) return;
    labsObs = new MutationObserver(() => { if (B.linked) paintLabs(); });
    labsObs.observe(list, { childList: true });
  }
  /* карта уровней перерисовывается целиком — после неё дорисовываем значки */
  if (SD.panels && SD.panels.map) {
    const baseMap = SD.panels.map;
    SD.panels.map = function () { const r = baseMap.apply(this, arguments); paint(); return r; };
  }

  SD.bridge = { won, miss, peek, labDone, state: B, PROTOCOL, TRAINER };

  /* ready — когда страница собрана и площадка запущена */
  const ready = () => send({ kind: 'ready' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else setTimeout(ready, 0);
})();
