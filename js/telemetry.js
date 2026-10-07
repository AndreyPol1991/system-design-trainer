/* События учёбы для платформы AMP (расширение events протокола trainer/1, docs/09-trainer-contract.md).

   Зачем. Платформа знает о тренажёре только успех — засчитанное задание. Где человек застрял,
   сколько раз проверял и на каком уровне открыл эталон, видел только сам тренажёр, и только в
   своём хранилище. Владельцу школы нужно второе: по нему видно, какие уровни трудные.

   Что уходит (всё — с кодом задания: id уровня или lab:<лаборатория>[:<задание>]):
   · started — открыл задание: загрузил уровень или открыл лабораторию;
   · attempt — нажал «Проверить решение» (js/learn.js, record): ok, номер проверки, время;
   · passed  — прошёл уровень (мост, won) или выполнил задание лаборатории (мост, labTask);
   · gave_up — reason 'solution': открыл эталон (мост, peek); reason 'left': ушёл с уровня,
     не пройдя его, после хотя бы одной проверки или минуты работы — перешёл на другой уровень
     или закрыл страницу.
   Время (ms) — только пока страница на экране: вкладку, забытую на ночь, не считаем.

   Когда уходит. Только внутри платформы: страница в рамке, платформа ответила hello и объявила
   events (мост зовёт link). До ответа события копятся в очереди; не ответила за 15 секунд —
   значит, родитель не платформа, очередь выбрасываем и больше ничего не копим. Сама по себе
   страница (window.parent === window) не копит ничего и таймеров не заводит.

   Пачками: раз в 10 секунд, при 50 событиях и сразу при уходе со страницы или сворачивании —
   иначе последние события захода терялись бы вместе с вкладкой. Не на каждый клик.

   Чего здесь нет: схем, ответов, текста — только вид события, код задания, число проверок и
   время. */
(function () {
  const embedded = window.parent !== window;
  const FLUSH_MS = 10000, BATCH = 50, MAX_QUEUE = 200, WAIT_HELLO_MS = 15000, LEFT_MS = 60000, MAX_MS = 6 * 3600 * 1000;
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  const T = {
    on: false,      // платформа приняла events — можно отдавать
    dead: false,    // родитель не платформа: не копим
    queue: [],
    cur: null,      // текущий уровень: { task, ms, from, attempts, passed, peeked }
    labs: {}        // открытые лаборатории: lab → { ms, from }
  };

  function push(ev) {
    if (!embedded || T.dead) return;
    T.queue.push(ev);
    if (T.queue.length > MAX_QUEUE) T.queue.splice(0, T.queue.length - MAX_QUEUE);
    if (T.on && T.queue.length >= BATCH) flush();
  }
  function flush() {
    if (!T.on || !T.queue.length || !SD.bridge || !SD.bridge.post) return;
    while (T.queue.length) {
      const events = T.queue.splice(0, BATCH);
      if (!SD.bridge.post('events', { kind: 'events', events })) { T.queue = []; return; }
    }
  }

  /* ---------- время на задании: только пока страница видна ---------- */
  const clock = () => ({ ms: 0, from: document.hidden ? null : now() });
  const spent = c => Math.min(MAX_MS, Math.round(c.ms + (c.from != null ? now() - c.from : 0)));
  function pause(c) { if (c && c.from != null) { c.ms += now() - c.from; c.from = null; } }
  function resume(c) { if (c && c.from == null) c.from = now(); }

  /* ---------- уровень ---------- */
  function begin(task) {
    if (T.cur && T.cur.task === task) return T.cur;
    leave();
    T.cur = Object.assign(clock(), { task, attempts: 0, passed: false, peeked: false });
    push({ type: 'started', task });
    return T.cur;
  }
  /* ушёл с уровня, не пройдя его: сдался, если успел поработать */
  function leave() {
    const c = T.cur; if (!c) return;
    T.cur = null;
    if (c.passed || c.peeked) return;
    const ms = spent(c);
    if (c.attempts > 0 || ms >= LEFT_MS) push({ type: 'gave_up', task: c.task, reason: 'left', attempts: c.attempts, ms });
  }
  const own = id => (T.cur && T.cur.task === id ? T.cur : begin(id));

  /* какой уровень открыт: смотрим раз в секунду, а не перехватываем загрузку уровня — уровень
     грузят и карта, и «Мой путь», и Ctrl+K, и «Дальше», а текущий уровень один: SD.app.A.level */
  function watch() {
    const A = SD.app && SD.app.A, L = A && A.level;
    if (!L || L.sandbox || !L.id) { leave(); return; }
    begin(L.id);
  }

  /* ---------- вызовы из моста и learn.js ---------- */
  function attempt(L, ok) {
    if (!embedded || !L || L.sandbox || !L.id) return;
    const c = own(L.id);
    c.attempts += 1;
    push({ type: 'attempt', task: c.task, ok: !!ok, attempts: Math.min(999, c.attempts), ms: spent(c) });
  }
  function passed(id) {
    if (!embedded || !id) return;
    const c = own(id);
    if (c.passed || c.peeked) return;
    c.passed = true;
    push({ type: 'passed', task: id, attempts: Math.min(999, c.attempts), ms: spent(c) });
  }
  function gaveUp(id) {
    if (!embedded || !id) return;
    const c = own(id);
    if (c.passed || c.peeked) return;
    c.peeked = true;
    push({ type: 'gave_up', task: id, reason: 'solution', attempts: Math.min(999, c.attempts), ms: spent(c) });
  }
  function labStarted(lab) {
    if (!embedded) return;
    if (!T.labs[lab]) T.labs[lab] = clock(); else resume(T.labs[lab]);
    push({ type: 'started', task: 'lab:' + lab });
  }
  function labPassed(lab, task) {
    if (!embedded) return;
    const c = T.labs[lab] || (T.labs[lab] = clock());
    push({ type: 'passed', task: 'lab:' + lab + ':' + task, attempts: 0, ms: spent(c) });
  }
  /* мост получил hello: events принимаются — включаемся, нет — выбрасываем накопленное */
  function link(accepts) {
    T.on = !!accepts;
    T.dead = !accepts;
    if (accepts) flush(); else T.queue = [];
  }

  if (embedded) {
    setInterval(watch, 1000);
    setInterval(flush, FLUSH_MS);
    setTimeout(() => { if (!T.on) { T.dead = true; T.queue = []; } }, WAIT_HELLO_MS);
    document.addEventListener('visibilitychange', () => {
      const all = [T.cur].concat(Object.keys(T.labs).map(k => T.labs[k]));
      if (document.hidden) { all.forEach(pause); flush(); } else all.forEach(resume);
    });
    /* закрыли окно тренажёра или страницу: уход с уровня и последняя пачка */
    window.addEventListener('pagehide', () => { leave(); flush(); });
  }

  SD.telemetry = { attempt, passed, gaveUp, labStarted, labPassed, link, flush, state: T };
})();
