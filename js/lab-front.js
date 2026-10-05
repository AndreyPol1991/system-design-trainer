/* Лаборатория «От экрана до сервера»: что происходит между нажатием на ссылку и готовым экраном.
   1) водопад загрузки страницы (DNS, TCP, TLS, HTML, CSS, JS, шрифты, картинки, API) и метрики TTFB, LCP, INP, CLS;
   2) SSR, CSR и SSG на странице каталога; 3) BFF против шести вызовов из мобильного приложения, overfetching, GraphQL;
   4) кэш на клиенте: Cache-Control, ETag и 304, хеш в имени файла, service worker, кэш ответов API и инвалидация;
   5) офлайн-очередь в мобильном приложении, конфликты (LWW против слияния) и идемпотентность повторной отправки.
   Переключатель «Техника | Бизнес» — как в «Выкладке вживую»: те же расчёты в секундах, конверсии и рублях. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const sec = (ms, d) => ms < 1000 ? nf(ms) + ' мс' : dec(ms / 1000, d != null ? d : ms < 10000 ? 2 : 1) + ' с';
  const sec1 = ms => sec(ms, 1);
  const kbf = v => v >= 1000 ? dec(v / 1024, 1) + ' МБ' : (v < 10 && v % 1 ? dec(v, 1) : nf(v)) + ' КБ';
  const pc = (x, d) => dec(x * 100, d != null ? d : x * 100 < 10 ? 1 : 0) + ' %';
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const rub = v => { const a = Math.abs(v); if (a >= 1e9) return dec(v / 1e9, 1) + ' млрд ₽'; if (a >= 1e6) return dec(v / 1e6, a >= 1e8 ? 0 : 1) + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ================= общие допущения о сети ================= */
  const NETS = {
    wifi: { n: 'Wi-Fi', rtt: 8, kbs: 5000, sub: 'дома: 40 Мбит/с, 8 мс до провайдера' },
    g4: { n: '4G', rtt: 45, kbs: 1000, sub: '8 Мбит/с, 45 мс до вышки и обратно' },
    g3: { n: '3G', rtt: 150, kbs: 200, sub: '1,6 Мбит/с, 150 мс до вышки и обратно' }
  };
  const NET_ORDER = ['wifi', 'g4', 'g3'];
  const PLACES = [[20, 'тот же город'], [700, 'Москва — Санкт-Петербург'], [1800, 'Москва — Екатеринбург'], [2800, 'Москва — Новосибирск'], [6400, 'Москва — Владивосток']];
  const kmRtt = km => km * 0.02;            /* свет в кабеле ≈ 200 км за 1 мс, кабель не по прямой, плюс маршрутизаторы: ≈ 2 мс туда-обратно на 100 км */
  const EDGE_KM = 30;                       /* сервер CDN — в городе покупателя */
  const CPU_JS = 2.5;                       /* мс на 1 КБ сжатого JS: разобрать и выполнить на телефоне среднего класса */
  const INITCWND = 14;                      /* КБ: первое «окно» TCP — 10 пакетов, дальше удваивается каждый RTT */
  const SRV_HTML = 200;                     /* мс: сервер собирает страницу каталога: запрос в базу + шаблон */

  /* ================= движок водопада =================
     spec: { k, at(T) → когда браузер узнал о файле (или null), wait — мс от запроса до первого байта, kb, w — приоритет в общем канале,
             exec — мс выполнения на телефоне, execAfter — чего ждать перед выполнением }
     Одно соединение HTTP/2: все файлы делят канал по приоритетам, канал разгоняется как TCP slow start. */
  function simulate(conn, specs) {
    const T = {}, st = specs.map(s => { const x = { s, req: null, fb: null, got: 0, end: null, ex0: null, ex1: null }; T[s.k] = x; return x; });
    const ready = conn.dns + 2 * conn.rtt, dt = 2;
    let cwnd = INITCWND, acc = 0;
    for (let t = 0; t < 90000; t += dt) {
      st.forEach(x => { if (x.req == null) { const a = x.s.at(T); if (a != null && t >= a) { x.req = Math.max(a, ready); x.fb = x.req + x.s.wait; } } });
      const dl = st.filter(x => x.fb != null && t >= x.fb && x.end == null);
      if (dl.length) {
        const cap = Math.min(conn.kbs, cwnd / conn.rtt * 1000) / 1000 * dt, W = dl.reduce((a, x) => a + x.s.w, 0);
        dl.forEach(x => { x.got += cap * x.s.w / W; if (x.got >= x.s.kb) { x.got = x.s.kb; x.end = t + dt; } });
        acc += dt; if (acc >= conn.rtt) { acc -= conn.rtt; cwnd = Math.min(cwnd * 2, 4096); }
      }
      st.forEach(x => {
        if (!x.s.exec || x.ex0 != null || x.end == null) return;
        const deps = (x.s.execAfter || []).map(k => T[k] && T[k].end);
        if (deps.some(v => v == null)) return;
        x.ex0 = Math.max(x.end, ...deps); x.ex1 = x.ex0 + x.s.exec;
      });
      if (st.every(x => x.end != null && (!x.s.exec || x.ex1 != null))) break;
    }
    return T;
  }

  /* ---------- вкладка 1: страница каталога (собирается на сервере), первый заход ---------- */
  const SIZES = { html: 40, css: 50, hero: 120, heroOpt: 45, thumbs: 90, font: 60, cart: 2, recs: 25 };
  function pageModel(P) {
    const N = NETS[P.net], rO = N.rtt + kmRtt(P.km), rE = N.rtt + kmRtt(EDGE_KM);
    const rC = P.cdn ? rE : rO, stat = rC + 5, dyn = P.cdn ? rE + kmRtt(P.km) : rO;
    const conn = { dns: N.rtt + 20, rtt: rC, kbs: N.kbs };
    const head = T => T.html.fb != null ? T.html.fb + 10 : null;
    const specs = [
      { k: 'html', at: () => 0, wait: dyn + SRV_HTML, kb: SIZES.html, w: 3 },
      { k: 'css', at: head, wait: stat, kb: SIZES.css, w: 6 },
      { k: 'js', at: head, wait: stat, kb: P.js, w: 3, exec: P.js * CPU_JS, execAfter: ['css', 'html'] },
      { k: 'hero', at: P.img ? head : T => T.html.end, wait: stat, kb: P.img ? SIZES.heroOpt : SIZES.hero, w: P.img ? 4 : 1 },
      { k: 'thumbs', at: T => T.html.end, wait: stat, kb: SIZES.thumbs, w: 1 },
      { k: 'font', at: T => T.css.end, wait: stat, kb: SIZES.font, w: 2 },
      { k: 'cart', at: T => T.js.ex1, wait: dyn + 40, kb: SIZES.cart, w: 3 },
      { k: 'recs', at: T => T.js.ex1, wait: dyn + 120, kb: SIZES.recs, w: 2 }
    ];
    const T = simulate(conn, specs);
    const dns = conn.dns, tcp = dns + rC, tls = tcp + rC;
    const ttfb = T.html.fb, fcp = Math.max(T.css.end, T.html.end) + 16, lcp = Math.max(fcp, T.hero.end + 16), ready = T.js.ex1;
    /* INP: нажатие ждёт, пока телефон доделает текущую длинную задачу JS (в среднем половину), плюс сам обработчик и перерисовка */
    const longTask = P.js * CPU_JS * 0.6, inp = longTask / 2 + 40 + P.js * 0.05, click = lcp + 1000, dead = Math.max(0, ready - lcp);
    const shifts = [{ t: T.font.end, v: P.sizes ? 0.01 : 0.02, what: 'шрифт заменил запасной — строки чуть сдвинулись' }];
    if (!P.sizes) shifts.push({ t: T.hero.end + 16, v: 0.16, what: 'главная картинка без размеров раздвинула страницу' }, { t: T.thumbs.end + 16, v: 0.06, what: 'картинки товаров без размеров сдвинули карточки' }, { t: T.recs.end + 30, v: 0.09, what: 'блок рекомендаций вставился без зарезервированного места' });
    const cls = shifts.reduce((a, s) => a + s.v, 0);
    const end = Math.max(...Object.values(T).map(x => Math.max(x.end || 0, x.ex1 || 0)));
    const kbTotal = specs.reduce((a, s) => a + s.kb, 0);
    return { P, N, rO, rE, rC, conn, T, dns, tcp, tls, ttfb, fcp, lcp, ready, click, inp, longTask, dead, cls, shifts, end, kbTotal, reqs: specs.length, statKB: specs.filter(s => !['html', 'cart', 'recs'].includes(s.k)).reduce((a, s) => a + s.kb, 0) };
  }
  /* пороги Core Web Vitals: хорошо / нужно улучшить / плохо */
  const VITALS = {
    ttfb: { good: 800, poor: 1800 }, lcp: { good: 2500, poor: 4000 }, inp: { good: 200, poor: 500 }, cls: { good: 0.1, poor: 0.25 }
  };
  const grade = (k, v) => v <= VITALS[k].good ? 'ok' : v <= VITALS[k].poor ? 'warn' : 'bad';
  const GRADE_T = { ok: 'хорошо', warn: 'нужно улучшить', bad: 'плохо' };

  /* бизнес: интернет-магазин, заходы с телефонов */
  const SHOP = { conv: 0.025, check: 3200, perSec: 0.07, cdnGb: 2, srvMonth: 15000, callRub: 80 };
  const TRAFFIC = [[5000, 'Малый'], [50000, 'Крупный'], [500000, 'Маркетплейс']];
  const convK = m => clamp(1 - SHOP.perSec * Math.max(0, m.lcp / 1000 - 1), 0.3, 1) * (m.inp > 500 ? 0.96 : m.inp > 200 ? 0.98 : 1) * (m.cls > 0.25 ? 0.98 : m.cls > 0.1 ? 0.99 : 1);

  /* ---------- вкладка 2: SSR, CSR, SSG на той же странице каталога ---------- */
  const RKINDS = [['ssg', 'SSG', 'собрана заранее'], ['ssr', 'SSR', 'собирает сервер'], ['csr', 'CSR', 'собирает телефон']];
  const SSR_MS = 250;   /* сервер: запрос в базу + сборка HTML на 24 товара */
  function renderModel(kind, P) {
    const N = NETS[P.net], rE = N.rtt + kmRtt(EDGE_KM), stat = rE + 5, dyn = rE + kmRtt(P.km);
    const conn = { dns: N.rtt + 20, rtt: rE, kbs: N.kbs };
    const head = T => T.html.fb != null ? T.html.fb + 10 : null;
    const specs = [
      kind === 'csr' ? { k: 'html', at: () => 0, wait: stat, kb: 3, w: 3 } : { k: 'html', at: () => 0, wait: kind === 'ssg' ? stat : dyn + SSR_MS, kb: 60, w: 3 },
      { k: 'css', at: head, wait: stat, kb: SIZES.css, w: 6 },
      { k: 'js', at: head, wait: stat, kb: P.js, w: 3, exec: P.js * CPU_JS, execAfter: ['css', 'html'] },
      { k: 'font', at: T => T.css.end, wait: stat, kb: SIZES.font, w: 2 }
    ];
    if (kind === 'csr') specs.push({ k: 'api', at: T => T.js.ex1, wait: dyn + 60, kb: 30, w: 3 });
    const imgAt = kind === 'csr' ? T => T.api.end != null ? T.api.end + 30 : null : T => T.html.end;
    specs.push({ k: 'hero', at: imgAt, wait: stat, kb: SIZES.hero, w: 1 }, { k: 'thumbs', at: imgAt, wait: stat, kb: SIZES.thumbs, w: 1 });
    const T = simulate(conn, specs);
    const shell = Math.max(T.css.end, T.html.end) + 16;
    const see = kind === 'csr' ? T.api.end + 30 + 16 : shell;
    const lcp = Math.max(see, T.hero.end + 16);
    const tap = kind === 'csr' ? Math.max(T.js.ex1, see) : T.js.ex1;
    const end = Math.max(...Object.values(T).map(x => Math.max(x.end || 0, x.ex1 || 0)));
    return { kind, T, shell, see, lcp, tap, end, ttfb: T.html.fb, kb: specs.reduce((a, s) => a + s.kb, 0) };
  }
  /* нагрузка на сервер: просмотров каталога в секунду в пик → ядра → серверы по 8 ядер с запасом до 70 % */
  const RPS = [[30, '30/с'], [300, '300/с'], [3000, '3 000/с']];
  function serverLoad(kind, rps, personal) {
    const cores = ms => rps * ms / 1000, srv = c => c <= 0 ? 0 : Math.max(1, Math.ceil(c / (8 * 0.7)));
    if (kind === 'ssr') { const hit = personal ? 0 : 0.95, c = cores(120) * (1 - hit) + cores(5); return { cores: c, srv: srv(c), hit, note: personal ? 'персональные цены: каждую страницу собираем заново' : 'CDN держит страницу 60 с — сервер собирает ≈ 5 % просмотров' }; }
    if (kind === 'csr') { const hit = personal ? 0 : 0.9, c = cores(15) * (1 - hit) + cores(2); return { cores: c, srv: srv(c), hit, note: personal ? 'ответ API с персональными ценами в CDN не кэшируется' : 'заготовка и JS — с CDN, ответ API кэшируется на 60 с' }; }
    const c = personal ? cores(4) : 0; return { cores: c, srv: srv(c), hit: 1, note: personal ? 'страница с CDN, персональные цены — отдельным маленьким запросом' : 'страницы лежат на CDN, сервер при просмотре не нужен' };
  }

  /* ---------- вкладка 3: карточка заказа из шести сервисов ---------- */
  const SVCS = [
    { k: 'orders', n: 'Заказы', ms: 40, full: 14, need: 2, wave: 1, what: 'состав и статус заказа', extra: 'вся история статусов, служебные поля склада' },
    { k: 'customers', n: 'Покупатели', ms: 25, full: 9, need: 0.5, wave: 1, what: 'имя и адрес', extra: 'все адреса, настройки рассылок, согласия' },
    { k: 'loyalty', n: 'Бонусы', ms: 30, full: 6, need: 0.3, wave: 1, what: 'баллы за заказ', extra: 'вся история начислений' },
    { k: 'catalog', n: 'Каталог', ms: 35, full: 48, need: 1.5, wave: 2, what: 'названия и фото товаров', extra: 'полные описания, характеристики, все фото', dep: 'нужны id товаров из заказа' },
    { k: 'delivery', n: 'Доставка', ms: 60, full: 8, need: 0.6, wave: 2, what: 'курьер и время', extra: 'маршрут курьера по точкам', dep: 'нужен id доставки из заказа' },
    { k: 'payments', n: 'Оплата', ms: 45, full: 5, need: 0.4, wave: 2, what: 'способ оплаты и чек', extra: 'служебные коды банка', dep: 'нужен id платежа из заказа' }
  ];
  const BMODES = [['seq', 'По очереди', '6 вызовов из приложения один за другим'], ['par', 'Параллельно', '6 вызовов из приложения, двумя волнами'], ['bff', 'Через BFF', '1 вызов, сервер собирает рядом с сервисами'], ['gql', 'GraphQL', '1 запрос, клиент сам выбирает поля']];
  const BFF_KM = 700, DC_RTT = 1, APP_MS = 8, BFF_MS = 10, GQL_MS = 6;
  function bffModel(mode, net) {
    const N = NETS[net], rtt = N.rtt + kmRtt(BFF_KM), bw = N.kbs / 1000;   /* КБ в мс */
    const calls = [];
    let total = 0, mobReq = 0, mobKB = 0;
    const byK = k => SVCS.find(s => s.k === k);
    if (mode === 'seq') {
      let t = 0;
      SVCS.forEach(s => { const c = { s, t0: t, t1: t + rtt / 2, t2: t + rtt / 2 + s.ms }; c.t3 = c.t2 + rtt / 2 + s.full / bw; calls.push(c); t = c.t3 + APP_MS; });
      total = t; mobReq = 6; mobKB = SVCS.reduce((a, s) => a + s.full, 0);
    } else if (mode === 'par') {
      let t = 0;
      [1, 2].forEach(w => {
        const ws = SVCS.filter(s => s.wave === w), kbW = ws.reduce((a, s) => a + s.full, 0);
        const cs = ws.map(s => ({ s, t0: t, t1: t + rtt / 2, t2: t + rtt / 2 + s.ms }));
        /* ответы делят канал: каждый ждёт свою долю, итого вся волна — kbW / bw */
        cs.forEach(c => { c.t3 = c.t2 + rtt / 2 + c.s.full / bw * Math.min(ws.length, kbW / c.s.full); });
        const last = Math.max(...cs.map(c => c.t3));
        cs.forEach(c => { c.t3 = Math.min(c.t3, last); calls.push(c); });
        const o = cs.find(c => c.s.k === 'orders');
        t = w === 1 ? (o ? o.t3 : last) + APP_MS : t;
        if (w === 2) total = last + APP_MS;
      });
      total = Math.max(total, ...calls.map(c => c.t3)) + APP_MS; mobReq = 6; mobKB = SVCS.reduce((a, s) => a + s.full, 0);
    } else {
      const gql = mode === 'gql', arrive = rtt / 2 + (gql ? GQL_MS : 2);
      let t = arrive;
      [1, 2].forEach(w => {
        const ws = SVCS.filter(s => s.wave === w);
        const cs = ws.map(s => ({ s, inner: true, t0: t, t1: t + DC_RTT / 2, t2: t + DC_RTT / 2 + s.ms, t3: t + DC_RTT + s.ms + s.full / 125 }));
        cs.forEach(c => calls.push(c));
        const o = cs.find(c => c.s.k === 'orders');
        t = w === 1 ? o.t3 : Math.max(...cs.map(c => c.t3));
      });
      const outKB = SVCS.reduce((a, s) => a + s.need, 0) + (gql ? 0.4 : 0.8);
      const back = t + (gql ? GQL_MS : BFF_MS);
      const front = { s: { k: mode, n: gql ? 'GraphQL' : 'BFF', full: outKB }, front: true, t0: 0, t1: arrive, t2: back, t3: back + rtt / 2 + outKB / bw };
      calls.unshift(front);
      total = front.t3 + APP_MS; mobReq = 1; mobKB = outKB;
    }
    const needKB = SVCS.reduce((a, s) => a + s.need, 0);
    return { mode, net, rtt, calls, total, mobReq, mobKB, needKB, extraKB: Math.max(0, mobKB - needKB - 0.8), radio: mode === 'seq' ? total : total };
  }

  /* ---------- вкладка 4: кэш в браузере — неделя из жизни одного покупателя ---------- */
  const VISITS = [
    { k: 'a', d: 'Пн 10:00', n: 'Первый заход', h: 0 },
    { k: 'b', d: 'Пн 18:00', n: 'Вернулся вечером', h: 8 },
    { k: 'dep', d: 'Вт 09:00', n: 'Выкатили версию 2: новые цены и новая кнопка', h: 23, deploy: true },
    { k: 'c', d: 'Вт 09:30', n: 'Зашёл после выкладки', h: 23.5 },
    { k: 'd', d: 'Вт 09:31', n: 'Нажал «Обновить»', h: 23.52, reload: true },
    { k: 'e', d: 'Ср 13:00', n: 'Зашёл на следующий день', h: 51 },
    { k: 'f', d: 'Чт 08:30', n: 'В метро, без сети', h: 70.5, offline: true },
    { k: 'g', d: 'Пн 10:00', n: 'Через неделю', h: 168 }
  ];
  const DEPLOY_H = 23;
  const CRES = [['html', 'HTML', 8], ['app', 'JS и CSS', 350], ['img', 'Картинки', 200]];
  const CC = { 'no-store': 'no-store', 'no-cache': 'no-cache', day: 'max-age=86400', year: 'max-age=31536000, immutable' };
  const ageH = { 'no-store': -1, 'no-cache': 0, day: 24, year: 8760 };
  const HASH = { 1: '3f9a1c', 2: '8b27e0' };
  const CNET = { rtt: 60, kbs: 1000 };   /* 4G в своём городе */
  function cacheModel(C) {
    const cost = kb => CNET.rtt + kb / CNET.kbs * 1000;
    const http = {}, sw = { on: C.sw !== 'off', has: false, ver: 0, pend: 0 };
    const name = v => C.hash ? `app.${HASH[v]}.js` : 'app.js';
    const rows = [];
    let sumKB = 0, stale = 0, broken = 0;
    VISITS.forEach(V => {
      const sv = V.h >= DEPLOY_H ? 2 : 1;
      if (V.deploy) { rows.push({ V, deploy: true, sv }); return; }
      const cells = {}, row = { V, cells, kb: 0, ms: 0, sv, bg: 0 };
      const fresh = (e, maxH) => e && maxH > 0 && V.h - e.t < maxH;
      /* обычные правила HTTP-кэша браузера */
      const httpGet = (key, ver, kb, maxH, force) => {
        const e = http[key];
        if (maxH >= 0 && !force && fresh(e, maxH)) return { how: 'cache', ver: e.ver, ms: 0, kb: 0, age: V.h - e.t };
        if (maxH < 0) return { how: 'dl', ver, ms: cost(kb), kb };
        if (e && e.ver === ver) { e.t = V.h; return { how: '304', ver, ms: cost(0.3), kb: 0.3 }; }
        http[key] = { ver, t: V.h }; return { how: 'dl', ver, ms: cost(kb), kb, upd: !!e };
      };
      const fail = () => ({ how: 'fail', ver: 0, ms: 0, kb: 0 });
      let html, app, img;
      /* service worker «сначала кэш»: новая версия ждёт, пока закроют все вкладки, — «Обновить» не помогает */
      if (sw.on && sw.pend && !V.reload) { sw.ver = sw.pend; sw.pend = 0; }
      const swServe = sw.on && sw.has && (C.sw === 'cache' || C.sw === 'swr' || V.offline);
      if (swServe) {
        html = { how: 'sw', ver: sw.ver, ms: 5, kb: 0 }; app = { how: 'sw', ver: sw.ver, ms: 5, kb: 0 }; img = { how: 'sw', ver: 1, ms: 5, kb: 0 };
        if (!V.offline && C.sw !== 'net') {
          const nv = sw.pend || sw.ver;
          if (nv !== sv) { row.bg = CRES[0][2] + CRES[1][2]; if (C.sw === 'swr') sw.ver = sv; else sw.pend = sv; }
          else row.bg = 0.6;
        }
      } else if (V.offline) {
        html = fail(); app = fail(); img = fail();
      } else {
        html = httpGet('html', sv, CRES[0][2], ageH[C.html], V.reload);
        /* HTML ссылается на файл: с хешем — на файл своей версии, без хеша — на app.js, который сервер уже заменил */
        const nm = name(html.ver), fileVer = C.hash ? html.ver : sv;
        app = httpGet(nm, fileVer, CRES[1][2], ageH[C.app], false);
        app.file = nm;
        img = httpGet('img', 1, CRES[2][2], 720, false);
        if (sw.on && html.ver === app.ver) { sw.has = true; sw.ver = html.ver; }
      }
      if (app.how !== 'fail' && !app.file) app.file = sw.ver ? name(sw.ver) : name(sv);
      cells.html = html; cells.app = app; cells.img = img;
      row.kb = [html, app, img].reduce((a, c) => a + c.kb, 0) + row.bg;
      row.ms = html.how === 'fail' ? 0 : html.ms + Math.max(app.ms, img.ms) + 120;
      row.fail = html.how === 'fail';
      row.shown = row.fail ? 0 : html.ver === app.ver ? html.ver : -1;
      if (!row.fail && row.shown === -1) broken++;
      else if (!row.fail && sv === 2 && row.shown === 1) stale++;
      sumKB += row.kb;
      rows.push(row);
    });
    const after = rows.filter(r => !r.deploy && r.sv === 2 && !r.V.offline);
    const b = rows.find(r => r.V.k === 'b');
    const ok = after.every(r => r.shown === 2) && b.cells.app.how === 'cache' && b.kb < 1;
    return { rows, sumKB, stale, broken, ok, offlineOk: !rows.find(r => r.V.offline).fail };
  }
  const CPRESETS = [
    ['Ничего не кэшировать', { html: 'no-store', app: 'no-store', hash: false, sw: 'off' }],
    ['Всё на сутки', { html: 'day', app: 'day', hash: false, sw: 'off' }],
    ['Файлы на год без хеша', { html: 'no-cache', app: 'year', hash: false, sw: 'off' }],
    ['Service worker «сначала кэш»', { html: 'no-cache', app: 'year', hash: true, sw: 'cache' }],
    ['Как надо', { html: 'no-cache', app: 'year', hash: true, sw: 'off' }]
  ];

  /* ---------- вкладка 5: общий список покупок для ремонта на двух устройствах ---------- */
  const PRICE = { tile: 890, paint: 1450, roller: 390, grout: 320, putty: 540 };
  const LIST0 = [
    { id: 'tile', n: 'Плитка 20×30', q: 12, u: 'уп.', note: 'белая' },
    { id: 'paint', n: 'Краска для потолка', q: 2, u: 'банки', note: 'белая матовая' },
    { id: 'roller', n: 'Валик', q: 1, u: 'шт.', note: '' },
    { id: 'grout', n: 'Затирка', q: 3, u: 'уп.', note: 'серая' }
  ];
  const PACT = [
    { k: 'p-add', n: '+ Шпаклёвка, 2 мешка', op: { type: 'add', item: { id: 'putty', n: 'Шпаклёвка', q: 2, u: 'мешка', note: '' } } },
    { k: 'p-paint', n: 'Краска: 3 банки', op: { type: 'set', id: 'paint', f: 'q', v: 3 } },
    { k: 'p-roller', n: 'Валик: 2 шт.', op: { type: 'set', id: 'roller', f: 'q', v: 2 } },
    { k: 'p-order', n: 'Оформить заказ', op: { type: 'order' } }
  ];
  const LACT = [
    { k: 'l-paint', n: 'Краска: 4 банки', op: { type: 'set', id: 'paint', f: 'q', v: 4 } },
    { k: 'l-note', n: 'Краска: «белая глянцевая»', op: { type: 'set', id: 'paint', f: 'note', v: 'белая глянцевая' } },
    { k: 'l-del', n: 'Удалить «Валик»', op: { type: 'del', id: 'roller' } }
  ];
  const FIELD_T = { q: 'количество', note: 'примечание' };
  const p2 = n => String(n).padStart(2, '0');
  const hm = m => `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;
  const cp = o => JSON.parse(JSON.stringify(o));
  const sumList = L => L.reduce((a, x) => a + (PRICE[x.id.split('-')[0]] || 0) * x.q, 0);
  function offNew() {
    const L = cp(LIST0).map(x => Object.assign(x, { ts: 8 * 60 }));
    return { clock: 8 * 60 + 30, seq: 0, srv: { items: L, tomb: {}, orders: [], keys: {} }, ph: { items: cp(LIST0), online: false, queue: [], used: {} }, lp: { used: {} }, conf: [], log: [], lost: [], dups: [], dedup: 0, retries: 0, resolved: 0, hot: {} };
  }
  function offLog(S, who, text, cls) { S.log.push({ t: S.clock, who, text, cls: cls || '' }); }
  function phoneAct(S, a) {
    S.clock += 5;
    const op = { n: ++S.seq, key: 'idem-' + (0x5a3c + S.seq * 0x2f1).toString(16), type: a.op.type, ts: S.clock, label: a.n, tries: 0 };
    if (op.type === 'add') { op.item = cp(a.op.item); S.ph.items.push(cp(a.op.item)); }
    if (op.type === 'set') {
      const it = S.ph.items.find(x => x.id === a.op.id); if (!it) return null;
      op.id = a.op.id; op.f = a.op.f; op.v = a.op.v; op.base = it[op.f]; op.baseRow = cp(it); it[op.f] = op.v; op.row = cp(it);
    }
    if (op.type === 'order') { op.sum = sumList(S.ph.items); op.label = `Оформить заказ на ${nf(op.sum)} ₽`; }
    S.ph.used[a.k] = 1; S.ph.queue.push(op);
    offLog(S, 'phone', `${op.label} — ${S.ph.online ? 'сразу отправляем' : 'сети нет, кладём в очередь'}`, '');
    return op;
  }
  function laptopAct(S, a) {
    S.clock += 5; S.lp.used[a.k] = 1;
    const row = S.srv.items.find(x => x.id === a.op.id);
    if (!row) { offLog(S, 'laptop', `${a.n}: товара уже нет в списке`, 'mut'); return; }
    if (a.op.type === 'del') { S.srv.items = S.srv.items.filter(x => x !== row); S.srv.tomb[row.id] = S.clock; }
    else { row[a.op.f] = a.op.v; row.ts = S.clock; }
    S.hot[a.op.id] = 'lp';
    offLog(S, 'laptop', `${a.n} — сохранено на сервере в ${hm(S.clock)}`, '');
  }
  /* сервер применяет операцию с телефона */
  function srvApply(S, op, strat, idem) {
    const K = S.srv.keys;
    if (idem && K[op.key]) { S.dedup++; return { res: 'dedup', text: `ключ ${op.key} уже был — второй раз не выполняем, возвращаем сохранённый ответ` }; }
    let r;
    if (op.type === 'add') {
      const has = S.srv.items.find(x => x.id === op.item.id);
      if (has) { const d = Object.assign(cp(op.item), { id: op.item.id + '-2', n: op.item.n + ' (дубль)', ts: S.clock, dup: true }); S.srv.items.push(d); S.dups.push(`${op.item.n} добавлена второй раз`); r = { res: 'dup', text: `повтор без ключа: «${op.item.n}» добавлена ещё раз — в списке два одинаковых товара` }; }
      else { S.srv.items.push(Object.assign(cp(op.item), { ts: op.ts })); r = { res: 'ok', text: `добавлена «${op.item.n}»` }; }
      S.hot[op.item.id] = 'ph';
    } else if (op.type === 'order') {
      const again = S.srv.orders.some(o => o.op === op.n);
      S.srv.orders.push({ op: op.n, sum: op.sum, no: 4810 + S.srv.orders.length, dup: again });
      if (again) { S.dups.push(`второй заказ на ${nf(op.sum)} ₽ — деньги списаны дважды`); r = { res: 'dup', text: `повтор без ключа: создан ещё один заказ и ещё раз списано ${nf(op.sum)} ₽` }; }
      else r = { res: 'ok', text: `заказ №${4810 + S.srv.orders.length - 1} на ${nf(op.sum)} ₽ создан, деньги списаны` };
    } else {
      const row = S.srv.items.find(x => x.id === op.id), what = `${op.row.n}: ${FIELD_T[op.f]} ${op.f === 'q' ? op.v : '«' + op.v + '»'}`;
      if (strat === 'lww') {
        if (!row) {
          const del = S.srv.tomb[op.id] || 0;
          if (op.ts > del) { S.srv.items.push(Object.assign(cp(op.row), { ts: op.ts })); delete S.srv.tomb[op.id]; S.lost.push(`удаление «${op.row.n}» с ноутбука: товар воскрес`); r = { res: 'warn', text: `${what}: правка с телефона (${hm(op.ts)}) новее удаления — удалённый товар вернулся в список` }; }
          else { S.lost.push(`${what} с телефона — товар удалили позже`); r = { res: 'lost', text: `${what}: товар удалён на ноутбуке позже (${hm(del)}) — правка телефона молча выброшена` }; }
        } else if (op.ts >= row.ts) {
          const gone = ['q', 'note'].filter(f => row[f] !== op.baseRow[f] && row[f] !== op.row[f]);
          gone.forEach(f => S.lost.push(`${op.row.n}: ${FIELD_T[f]} ${f === 'q' ? row[f] : '«' + row[f] + '»'} с ноутбука затёрто`));
          Object.assign(row, cp(op.row), { ts: op.ts });
          r = { res: gone.length ? 'warn' : 'ok', text: gone.length ? `${what}: телефон прислал строку целиком — правки ноутбука в этой строке затёрты` : `${what} — сохранено` };
        } else {
          S.lost.push(`${what} с телефона — правка с ноутбука новее`);
          r = { res: 'lost', text: `${what}: на сервере строка новее (${hm(row.ts)} против ${hm(op.ts)}) — правка телефона молча выброшена` };
        }
      } else {
        if (!row) { S.conf.push({ kind: 'del', op }); r = { res: 'conf', text: `${what}: товар удалён на ноутбуке — конфликт «изменили и удалили», решает человек` }; }
        else if (row[op.f] === op.v) r = { res: 'ok', text: `${what} — уже так, ничего не меняем` };
        else if (row[op.f] === op.base) { row[op.f] = op.v; row.ts = op.ts; r = { res: 'ok', text: `${what} — поле не меняли с другого устройства, сливаем` }; }
        else { S.conf.push({ kind: 'field', op, theirs: row[op.f] }); r = { res: 'conf', text: `${what}: то же поле поменяли на ноутбуке (${op.f === 'q' ? row[op.f] : '«' + row[op.f] + '»'}) — конфликт, решает человек` }; }
      }
      if (r.res === 'ok' || r.res === 'warn') S.hot[op.id] = 'ph';
    }
    if (idem) K[op.key] = r.res;
    return r;
  }
  function resolveConf(S, i, mine) {
    const c = S.conf[i]; if (!c || c.done) return;
    const op = c.op;
    if (c.kind === 'field') { const row = S.srv.items.find(x => x.id === op.id); if (row && mine) { row[op.f] = op.v; row.ts = S.clock; } }
    else if (mine) S.srv.items.push(Object.assign(cp(op.row), { ts: S.clock }));
    c.done = mine ? 'mine' : 'theirs'; S.resolved++;
    S.ph.items = cp(S.srv.items);
    offLog(S, 'srv', `Конфликт решён: ${c.kind === 'field' ? `${op.row.n} — ${FIELD_T[op.f]} ${mine ? (op.f === 'q' ? op.v : '«' + op.v + '»') + ' (как на телефоне)' : (op.f === 'q' ? c.theirs : '«' + c.theirs + '»') + ' (как на ноутбуке)'}` : mine ? `«${op.row.n}» вернули в список` : `«${op.row.n}» остаётся удалённым`}`, 'ok');
  }

  /* ================= тексты ================= */
  const ana = (life, plain, term) => `<div class="lf-ana"><p class="lf-life"><span class="lf-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="lf-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const LIFE = {
    load: ['Открыть страницу — как собрать шкаф из интернет-магазина. Сначала узнаёшь адрес склада, договариваешься о доставке и получаешь коробку с инструкцией. Из инструкции видно, каких деталей ещё не хватает, — дозаказываешь их. Шкаф уже стоит, но дверцы не открываются, пока не привезли петли.',
      'Браузер получает страницу не одним куском. Он находит сервер, договаривается о защищённом соединении, получает HTML и только из него узнаёт, что ещё скачать. Каждый шаг — поездка по сети туда и обратно, поэтому расстояние и медленная сеть часто важнее мощности сервера.',
      '<b>Водопад</b> (waterfall) — вкладка Network в инструментах разработчика: каждый запрос — полоска во времени. <b>RTT</b> — время туда-обратно. <b>DNS</b> — узнать адрес по имени сайта, <b>TCP</b> и <b>TLS</b> — открыть соединение и договориться о шифровании (по одному RTT в TLS 1.3). Метрики Core Web Vitals: <b>LCP</b> — главное на экране, хорошо до 2,5 с; <b>INP</b> — отклик на нажатие, хорошо до 200 мс; <b>CLS</b> — прыжки вёрстки, хорошо до 0,1. <b>TTFB</b> — первый байт, хорошо до 0,8 с.'],
    render: ['Обед можно получить тремя способами. <b>SSG</b> — готовые обеды на витрине: взял и поел, быстро, но приготовлено утром. <b>SSR</b> — повар готовит под твой заказ: ждёшь кухню, зато свежее. <b>CSR</b> — приносят продукты и рецепт, готовишь сам за столом: кухне легко, а ты ждёшь, и на слабой плитке — долго. И везде мелочь: блюдо уже на столе, а вилку приносят позже.',
      'Вопрос один: кто и когда собирает HTML со списком товаров — заранее при сборке сайта, сервер на каждый просмотр или телефон покупателя. От ответа зависят скорость, нагрузка на серверы и то, что увидит поисковик.',
      '<b>SSG</b> (static site generation) — страницы собраны заранее и лежат на CDN. <b>SSR</b> (server-side rendering) — сервер собирает HTML на каждый запрос. <b>CSR</b> (client-side rendering) — сервер отдаёт пустую заготовку и JS, страницу собирает браузер. <b>Гидратация</b> — JS «оживляет» готовый HTML: навешивает обработчики на кнопки. Гибриды: ISR (пересборка по таймеру), потоковый SSR, «острова».'],
    bff: ['Чтобы узнать всё про заказ, можно самому обзвонить шесть отделов: склад, доставку, бухгалтерию… — и каждый звонок через плохую связь. А можно позвонить одному менеджеру: он сидит в том же офисе, за минуту обойдёт отделы и перескажет только то, что нужно тебе.',
      'Мобильная сеть медленная и далёкая, а внутри дата-центра сервисы отвечают друг другу за миллисекунды. Выгодно сделать один вызов по мобильной сети, а остальные — рядом с сервисами.',
      '<b>BFF</b> (Backend for Frontend) — серверный слой под конкретный клиент: собирает данные из сервисов и отдаёт ровно то, что нужно экрану. <b>Overfetching</b> — сервис отдаёт больше полей, чем нужно экрану; <b>underfetching</b> — данных не хватает, нужен ещё вызов. <b>GraphQL</b> — язык запросов: клиент сам перечисляет нужные поля, сервер собирает их из сервисов.'],
    cache: ['Холодильник дома. На продуктах срок годности: пока не вышел — в магазин не ходишь. Вышел — звонишь в магазин: «у меня молоко от 5 октября, есть новее?» — «нет, твоё в порядке» — и не тащишь пакет заново. А если на упаковке номер партии, новую партию со старой не перепутаешь.',
      'Браузер хранит скачанные файлы и сам решает, спрашивать ли сервер снова. Правила задаёт сервер в заголовках ответа. Ошибка в правилах — и покупатель сутки видит старые цены или новую страницу со старым кодом.',
      '<b>Cache-Control: max-age=N</b> — N секунд брать из кэша, не спрашивая. <b>no-cache</b> — хранить, но каждый раз сверяться. <b>no-store</b> — не хранить. <b>ETag</b> — отпечаток версии: браузер шлёт <code>If-None-Match</code>, сервер отвечает <b>304 Not Modified</b> без тела. <b>Хеш в имени</b> (<code>app.3f9a1c.js</code>) + <code>max-age=31536000, immutable</code> — файл хранится год, новая версия = новое имя. <b>Service worker</b> — скрипт-посредник между страницей и сетью со своим кэшем.'],
    offline: ['Курьер в подвале без связи записывает отметки в блокнот, а поднявшись наверх, передаёт их диспетчеру по порядку. Если за это время диспетчер поменял тот же адрес — нужно решить, чья запись главнее. А если связь оборвалась на полуслове, повторить так, чтобы диспетчер не записал одно и то же дважды.',
      'Приложение не ждёт сеть: действие сразу видно на экране и ложится в очередь. Появилась сеть — очередь уходит на сервер. Трудности две: одно и то же поменяли на двух устройствах, и повторная отправка не должна создать дубль.',
      '<b>Offline-first</b> — локальная база на устройстве и <b>очередь исходящих операций</b> (outbox). <b>LWW</b> (last write wins) — побеждает запись с более поздним временем, остальное молча теряется. <b>Слияние</b> — сравниваем с исходной версией по полям: разные поля объединяем, одно и то же поле — конфликт (дальше — CRDT). <b>Ключ идемпотентности</b> — уникальный id операции: повтор с тем же ключом сервер не выполняет, а возвращает сохранённый ответ.']
  };
  const MEMO = [
    ['Открытие страницы', ['До первого байта — три поездки туда-обратно: DNS, TCP, TLS. На 3G за 6 400 км это почти секунда впустую.', 'CDN сокращает рукопожатия и раздачу файлов. Динамика (HTML, API) всё равно едет до основного сервера.', 'Большой JS бьёт дважды: качается вместе с главной картинкой (LCP) и долго выполняется на слабом телефоне (INP).', 'Размеры у картинок и место под блоки — и CLS почти ноль.']],
    ['SSR, CSR, SSG', ['Товары в HTML (SSR, SSG) видны раньше и видны поисковику. CSR показывает пустую заготовку до выполнения JS и запроса данных.', '«Видно» ≠ «можно нажать»: между ними гидратация, её цена — размер JS.', 'SSG дешевле всего и кэшируется целиком, но свежесть = частота пересборки. Персональное — отдельным запросом.', 'SSR свеж и персонален, но платим серверами. Без персонализации кэшируй на CDN хотя бы на минуту.']],
    ['BFF и вызовы', ['Считай поездки по мобильной сети, а не вызовы вообще: внутри дата-центра RTT ≈ 1 мс.', 'Зависимые вызовы идут друг за другом — параллелить можно только независимые.', 'BFF отдаёт ровно поля экрана: меньше трафика и батареи. Цена — ещё один сервис и его команда.', 'GraphQL — гибкий BFF: клиент выбирает поля. Следи за N+1, сложностью запросов и кэшированием.']],
    ['Кэш на клиенте', ['HTML — <code>no-cache</code>: всегда сверяться, ETag → 304. Файлы с хешем в имени — <code>max-age</code> на год и <code>immutable</code>.', 'Старая версия у пользователя = длинный кэш HTML или service worker «сначала кэш».', 'Новый HTML + старый JS = сломанная страница: без хеша в имени длинный max-age ставить нельзя.', 'Кэш данных в приложении сбрасывай после своих изменений и обновляй при возвращении на экран.']],
    ['Офлайн', ['Действие сразу на экране и в очереди — на сервер уйдёт, когда появится сеть.', 'LWW прост, но молча теряет чужие правки. Слияние по полям + явный конфликт для одного и того же поля.', 'Любая повторная отправка — с ключом идемпотентности. Особенно заказ и оплата.']]
  ];
  const MEMO_BIZ = [
    ['Скорость — это выручка', ['Каждая лишняя секунда до появления товаров — минус ≈ 7 % заказов (наше допущение; крупные магазины публиковали похожие цифры).', 'CDN стоит тысячи рублей в месяц и окупается за день у далёких покупателей.', 'Тяжёлый JS — «мёртвые» кнопки: покупатель жмёт «В корзину», а ничего не происходит.']],
    ['Как собирать страницы', ['SSG — почти бесплатно и быстро, но цены обновляются пересборкой.', 'SSR — свежие и персональные цены, но серверы растут вместе с трафиком.', 'CSR — дёшево для серверов, но медленнее на слабых телефонах и рискованно для поиска.']],
    ['Мобильное приложение', ['BFF — одна поездка по мобильной сети вместо шести: экран заказа в несколько раз быстрее на 3G, меньше звонков «где мой заказ».', 'Цена BFF — отдельный сервис и команда; окупается, когда экранов и клиентов много.']],
    ['Кэш и выкладка', ['Неправильный кэш — после выкладки покупатели сутки видят старые цены или сломанную страницу.', 'Правильный кэш — повторный заход почти без трафика: дешевле CDN и быстрее для покупателя.']],
    ['Плохая связь', ['Офлайн-очередь — покупатель не теряет действия в метро.', 'Без идемпотентности плохая сеть превращается в двойные списания, возвраты и звонки в поддержку.']]
  ];

  /* ================= экземпляр лаборатории ================= */
  const MODE_KEY = 'amp-stroyka-lf-mode';
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
  const TABS = [['load', '1', 'Открытие страницы'], ['render', '2', 'SSR, CSR, SSG'], ['bff', '3', 'BFF и вызовы'], ['cache', '4', 'Кэш на клиенте'], ['offline', '5', 'Офлайн'], ['memo', '✓', 'Итоги']];
  const NEXT = { load: 'render', render: 'bff', bff: 'cache', cache: 'offline', offline: 'memo' };
  const P0 = { net: 'g4', km: 2800, js: 600, cdn: false, img: false, sizes: false };
  const SEGT = {
    dns: 'DNS: узнать адрес сервера', tcp: 'TCP: открыть соединение', tls: 'TLS: договориться о шифровании', wait: 'Ожидание: запрос по сети + сервер думает',
    dl: 'Скачивание', exec: 'Выполнение JS на телефоне', srv: 'Сервис думает', net: 'В пути по сети'
  };
  const niceMax = v => { const s = [500, 1000, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000, 30000]; return s.find(x => x >= v) || Math.ceil(v / 10000) * 10000; };
  const tickStep = max => max <= 1000 ? 100 : max <= 2500 ? 250 : max <= 5000 ? 500 : max <= 12000 ? 1000 : 2000;
  const pct = (v, max) => (clamp(v / max, 0, 1) * 100).toFixed(2) + '%';

  function makeLab(EL, doneFn) {
    let MODE = readMode();
    const U = {
      tab: 'load', P: Object.assign({}, P0), scale: 50000, alive: true,
      t1: null, t2: null, t3: null,
      r: { pick: 'csr', robot: false, seen: {}, personal: false, rps: 300 },
      b: { mode: 'seq', seen: {} },
      c: { C: { html: 'day', app: 'day', hash: false, sw: 'off' }, api: null },
      o: null, oset: { strat: 'lww', idem: false, flaky: false }, obusy: false
    };
    const done = id => { try { doneFn(id); } catch (e) { /* задания не засчитываются — не страшно */ } };
    const isBiz = () => MODE === 'biz';
    const $ = s => EL.querySelector(s);
    const timers = new Set();
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (U.alive) fn(); }, ms); timers.add(id); return id; };

    /* ---------- проигрыватель: время бежит от 0 до конца ---------- */
    const PL = { timer: 0, key: null };
    function stopPlay() { if (PL.timer) clearInterval(PL.timer); PL.timer = 0; PL.key = null; EL.querySelectorAll('[data-play]').forEach(b => { b.textContent = b.dataset.lbl || b.textContent; }); }
    function play(key, max, draw) {
      stopPlay();
      if (isCalm()) { draw(max); return; }
      const dur = clamp(max * 0.9, 2600, 6500), t0 = performance.now();
      PL.key = key;
      const b = EL.querySelector(`[data-play="${key}"]`); if (b) b.textContent = '■ Стоп';
      draw(0);
      PL.timer = setInterval(() => {
        if (!U.alive) { stopPlay(); return; }
        const k = Math.min(1, (performance.now() - t0) / dur);
        draw(k * max);
        if (k >= 1) stopPlay();
      }, 40);
    }
    const scrub = (key, label) => `<div class="lf-scrub"><button type="button" class="btn primary" data-play="${key}" data-lbl="${esc(label)}">${esc(label)}</button><input type="range" class="lf-range" id="lfScrub${key}" min="0" max="1000" step="1" value="1000" aria-label="Момент времени"><output id="lfScrubOut${key}">конец</output></div>`;
    function setScrub(key, t, max) { const r = $('#lfScrub' + key), o = $('#lfScrubOut' + key); if (r) r.value = Math.round(t / max * 1000); if (o) o.textContent = t >= max ? `${sec(max)} · конец` : sec(t); }

    /* ---------- общие кусочки разметки ---------- */
    const seg = (name, items, cur, cls) => `<div class="seg lf-seg ${cls || ''}" role="group" aria-label="${esc(name)}">${items.map(([v, t]) => `<button type="button" data-set="${name}:${v}" aria-selected="${String(v) === String(cur)}">${t}</button>`).join('')}</div>`;
    const tile = (label, val, sub, cls, badge) => `<div class="lf-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${badge ? `<em class="lf-badge ${cls || ''}">${badge}</em>` : ''}${sub ? `<small>${sub}</small>` : ''}</div>`;
    const asm = list => `<details class="lf-asm" open><summary>Допущения для расчёта</summary><ul>${list.map(x => `<li>${x}</li>`).join('')}</ul></details>`;
    const nextBtn = k => NEXT[k] ? `<div class="lf-next"><button type="button" class="btn primary" data-go="${NEXT[k]}">Дальше: ${esc(TABS.find(t => t[0] === NEXT[k])[2])} →</button></div>` : '';
    const scaleSeg = () => `<div class="lf-ctl"><b>Масштаб магазина</b>${seg('scale', TRAFFIC.map(([v, n]) => [v, n]), U.scale)}<small class="lf-sub">${nf(U.scale)} заходов в день с телефонов · средний чек ${nf(SHOP.check)} ₽</small></div>`;
    const netCtl = () => `<div class="lf-ctl"><b>Сеть покупателя</b>${seg('net', NET_ORDER.map(k => [k, NETS[k].n]), U.P.net)}<small class="lf-sub">${NETS[U.P.net].sub}</small></div>`;
    const kmIdx = () => Math.max(0, PLACES.findIndex(p => p[0] === U.P.km));
    const kmCtl = () => `<div class="lf-ctl"><div class="lf-rl"><span>Расстояние до сервера</span><output id="lfKmOut">${nf(U.P.km)} км</output></div><input type="range" class="lf-range" id="lfKm" min="0" max="${PLACES.length - 1}" step="1" value="${kmIdx()}" aria-label="Расстояние до сервера"><small class="lf-sub" id="lfKmSub">${PLACES[kmIdx()][1]} · +${nf(kmRtt(U.P.km))} мс на каждую поездку туда-обратно</small></div>`;
    const jsCtl = () => `<div class="lf-ctl"><div class="lf-rl"><span>Размер JS (сжатый)</span><output id="lfJsOut">${kbf(U.P.js)}</output></div><input type="range" class="lf-range" id="lfJs" min="50" max="2000" step="50" value="${U.P.js}" aria-label="Размер JS в килобайтах"><small class="lf-sub" id="lfJsSub">телефон выполняет его ≈ ${sec1(U.P.js * CPU_JS)}</small></div>`;

    /* ---------- водопад: строим один раз, дальше только двигаем полоски (так они плавно перестраиваются) ---------- */
    function wfDraw(el, rows, max, marks, key) {
      if (!el) return;
      const sig = key + ':' + rows.map(r => r.k + r.segs.length).join(',') + ':' + marks.map(m => m.k).join(',');
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = `<div class="lf-wax"><span class="lf-wl0">Запрос</span><div class="lf-wticks"></div><span class="lf-wd0">Длится</span></div>`
          + rows.map(r => `<div class="lf-wrow" data-r="${r.k}"><div class="lf-wl"><b></b><small></small></div><div class="lf-wt">${r.segs.map((s, i) => `<i class="lf-sg ${s[0]}" data-i="${i}"></i>`).join('')}</div><div class="lf-wd"></div></div>`).join('')
          + `<div class="lf-wfoot"></div><div class="lf-wov"><div class="lf-wmask"></div>${marks.map(m => `<div class="lf-wmk ${m.cls}" data-mk="${m.k}"><span></span></div>`).join('')}<div class="lf-wcur"></div></div>`;
      }
      const tk = el.querySelector('.lf-wticks'), st = tickStep(max);
      const lab = v => v === 0 ? '0' : max < 1000 ? nf(v) : dec(v / 1000, st % 1000 === 0 ? 0 : st % 100 === 0 ? 1 : 2);
      let th = ''; for (let v = 0; v <= max + 1; v += st) th += `<span style="left:${pct(v, max)}" class="${v + st > max + 1 ? 'last' : ''}">${lab(v)}</span>`;
      tk.innerHTML = th + `<em>${max < 1000 ? 'мс' : 'с'}</em>`;
      rows.forEach(r => {
        const row = el.querySelector(`[data-r="${r.k}"]`); if (!row) return;
        row.querySelector('b').textContent = r.n; row.querySelector('small').textContent = r.sub || '';
        row.querySelector('.lf-wd').textContent = r.dur != null ? sec1(r.dur) : '';
        row.className = 'lf-wrow' + (r.cls ? ' ' + r.cls : '');
        r.segs.forEach((s, i) => { const e = row.querySelector(`[data-i="${i}"]`); if (!e) return; e.style.left = pct(s[1], max); e.style.width = pct(Math.max(0, s[2] - s[1]), max); e.title = `${s[3] || SEGT[s[0]] || ''}: ${sec(Math.max(0, s[2] - s[1]))}`; });
      });
      marks.forEach((m, i) => { const e = el.querySelector(`[data-mk="${m.k}"]`); if (!e) return; e.style.left = pct(m.t, max); e.style.setProperty('--lv', i % 3); const s = e.querySelector('span'); s.textContent = `${m.n} ${sec(m.t)}`; e.classList.toggle('flip', m.t / max > 0.7); });
      el.dataset.max = max;
    }
    function wfCursor(el, t, max) {
      if (!el) return;
      const c = el.querySelector('.lf-wcur'), k = el.querySelector('.lf-wmask'), end = t == null || t >= max;
      if (c) { c.style.left = pct(end ? max : t, max); c.hidden = end; }
      if (k) { k.style.left = pct(end ? max : t, max); k.hidden = end; }
    }

    /* ================= вкладка 1: открытие страницы ================= */
    function loadRows(m) {
      const T = m.T, R = (k, n, sub, extra) => { const x = T[k]; const segs = [['wait', x.req, x.fb], ['dl', x.fb, x.end]]; if (x.s.exec) segs.push(['exec', x.ex0, x.ex1]); return Object.assign({ k, n, sub, segs, dur: (x.ex1 || x.end) - x.req }, extra || {}); };
      return [
        { k: 'dns', n: 'DNS', sub: 'узнать адрес сервера', segs: [['dns', 0, m.dns]], dur: m.dns },
        { k: 'tcp', n: 'TCP', sub: 'открыть соединение', segs: [['tcp', m.dns, m.tcp]], dur: m.tcp - m.dns },
        { k: 'tls', n: 'TLS', sub: 'шифрование, сертификат', segs: [['tls', m.tcp, m.tls]], dur: m.tls - m.tcp },
        R('html', 'HTML страницы', `${SIZES.html} КБ · сервер собирает ${SRV_HTML} мс`),
        R('css', 'style.css', `${SIZES.css} КБ · без него экран белый`),
        R('js', 'app.js', `${kbf(m.P.js)} · + выполнение`),
        R('hero', m.P.img ? 'hero.webp' : 'hero.jpg', `${m.P.img ? SIZES.heroOpt : SIZES.hero} КБ · главная картинка`, { cls: 'lcp' }),
        R('thumbs', 'Картинки товаров', `${SIZES.thumbs} КБ · 6 штук`),
        R('font', 'Шрифты', `${SIZES.font} КБ · узнаём из CSS`),
        R('cart', 'GET /api/cart', `${SIZES.cart} КБ · счётчик корзины`),
        R('recs', 'GET /api/recs', `${SIZES.recs} КБ · рекомендации`)
      ];
    }
    function loadHTML() {
      const B = isBiz(), P = U.P;
      return ana(LIFE.load[0], LIFE.load[1], B ? '' : LIFE.load[2])
        + `<div class="lf-ctls">${netCtl()}${kmCtl()}${jsCtl()}
          <div class="lf-ctl"><b>CDN — раздача из города покупателя</b>${seg('cdn', [[0, 'Выключен'], [1, 'Включён']], +P.cdn)}<small class="lf-sub">${P.cdn ? 'сервер-раздатчик в 30 км, HTML и API — через него' : 'всё едет с основного сервера'}</small></div>
          <div class="lf-ctl"><b>Главная картинка</b>${seg('img', [[0, 'JPEG 120 КБ'], [1, 'WebP 45 КБ']], +P.img)}<small class="lf-sub">${P.img ? 'сжатая, с preload и fetchpriority="high": качается сразу' : 'обычная: браузер узнаёт о ней в конце HTML'}</small></div>
          <div class="lf-ctl"><b>Размеры картинок и место под блоки</b>${seg('sizes', [[0, 'Не заданы'], [1, 'Заданы']], +P.sizes)}<small class="lf-sub">${P.sizes ? 'width/height и min-height — место занято заранее' : 'место появляется, когда картинка пришла'}</small></div>
          ${B ? scaleSeg() : ''}</div>
        <div class="lf-btns"><button type="button" class="btn" data-act="vlad">Покупатель во Владивостоке на 3G</button><button type="button" class="btn ghost" data-act="p0">Как было</button></div>
        <div class="lf-kpis" id="lfKpis1"></div>
        <div class="lf-wfwrap"><div class="lf-wfcol"><div class="lf-wf" id="lfWf1"></div>
          <div class="lf-leg">${['dns', 'tcp', 'tls', 'wait', 'dl', 'exec'].map(k => `<span><i class="lf-sg ${k}"></i>${SEGT[k].split(':')[0]}</span>`).join('')}</div></div>
          <div class="lf-phcol"><div class="lf-phone" id="lfPh1"></div><p class="lf-phcap" id="lfCap1"></p></div></div>
        ${scrub('1', '▶ Проиграть загрузку')}
        <div class="lf-two"><div class="lf-card" id="lfWhy1"></div><div id="lfBiz1"></div></div>${nextBtn('load')}`;
    }
    function drawLoad() {
      const m = U.m1 = pageModel(U.P), max = niceMax(m.end * 1.03);
      U.max1 = max;
      wfDraw($('#lfWf1'), loadRows(m), max, [{ k: 'ttfb', n: 'TTFB', t: m.ttfb, cls: 'inf' }, { k: 'lcp', n: 'LCP', t: m.lcp, cls: 'acc' }, { k: 'rdy', n: 'Кнопки ожили', t: m.ready, cls: 'wrn' }], 'load');
      const k = $('#lfKpis1'); if (k) k.innerHTML = kpis1(m);
      const w = $('#lfWhy1'); if (w) w.innerHTML = whyLoad(m);
      const b = $('#lfBiz1'); if (b) b.innerHTML = isBiz() ? bizLoad(m) : `<div class="lf-card"><b>Как читать водопад.</b> Каждая строка — запрос. Полоска начинается, когда браузер узнал о файле: картинки — только из HTML, шрифты — только из CSS, запросы к API — только после выполнения JS. Отсюда «ступеньки». Перемотай время ползунком или нажми «Проиграть» — справа то, что в этот момент видит покупатель.</div>`;
      setT1(U.t1);
      if (U.P.net === 'g3' && U.P.km === 6400 && m.lcp <= VITALS.lcp.good && m.inp <= VITALS.inp.good && m.cls <= VITALS.cls.good && m.ttfb < 1000) done('vitals');
    }
    function kpis1(m) {
      const B = isBiz(), g = { ttfb: grade('ttfb', m.ttfb), lcp: grade('lcp', m.lcp), inp: grade('inp', m.inp), cls: grade('cls', m.cls) };
      return tile(B ? 'Сервер начал отвечать' : 'TTFB · первый байт', sec(m.ttfb), 'сколько ждали, пока сервер начнёт отвечать', g.ttfb, GRADE_T[g.ttfb])
        + tile(B ? 'Товар на экране' : 'LCP · главное на экране', sec(m.lcp), 'когда появилась главная картинка', g.lcp, GRADE_T[g.lcp])
        + tile(B ? 'Отклик кнопки' : 'INP · отклик на нажатие', nf(m.inp) + ' мс', `нажатие ждёт, пока телефон доделает JS`, g.inp, GRADE_T[g.inp])
        + tile(B ? 'Прыжки страницы' : 'CLS · прыжки вёрстки', dec(m.cls, 2), m.cls > 0.1 ? 'содержимое съезжает из-под пальца' : 'почти ничего не прыгает', g.cls, GRADE_T[g.cls])
        + tile('Всё скачано', kbf(m.kbTotal), `${m.reqs} запросов · готово за ${sec1(m.end)}`, '');
    }
    function whyLoad(m) {
      const P = m.P, B = isBiz(), L = [];
      L.push(`До первого байта — <b>${sec(m.ttfb)}</b>: ${sec(m.tls)} уходит на DNS, TCP и TLS (две поездки по ${nf(m.rC)} мс и запрос адреса), ещё ${sec(m.ttfb - m.tls)} — запрос до сервера за ${nf(P.km)} км и сборка страницы (${SRV_HTML} мс).`);
      if (!P.cdn && kmRtt(P.km) >= 14) L.push(`<b>CDN</b> сократит каждую поездку для рукопожатий и файлов с ${nf(m.rO)} до ${nf(m.rE)} мс: сервер-раздатчик стоит в городе покупателя. HTML и API всё равно поедут до основного сервера.`);
      if (!P.img) L.push(`Главная картинка весит ${SIZES.hero} КБ, браузер узнаёт о ней только в конце HTML и качает её вместе с JS. <b>WebP и приоритет</b> — и товар появляется почти вместе со стилями.`);
      if (P.js > 200) L.push(`JS ${kbf(P.js)}: телефон выполняет его ${sec1(P.js * CPU_JS)}. Нажатие, попавшее в эту работу, ждёт — отсюда INP ${nf(m.inp)} мс. Кнопка «мертва» ${sec1(m.dead)} после появления товара. Режь бандл: разделение кода, меньше библиотек.`);
      if (!P.sizes) L.push(`CLS ${dec(m.cls, 2)}: ${m.shifts.filter(s => s.v > 0.05).map(s => s.what).join('; ')}. Лечится <code>width</code>/<code>height</code> у картинок и <code>min-height</code> у блоков.`);
      if (L.length === 1) L.push(`Узких мест почти не осталось. ${P.net === 'g3' ? 'Остаток — сама сеть 3G: 150 мс на каждую поездку.' : 'Дальше помогает кэш на повторных заходах — вкладка 4.'}`);
      return `<b>${B ? 'Где теряем время' : 'Что тормозит сейчас'}</b><ul>${L.map(x => `<li>${x}</li>`).join('')}</ul>`;
    }
    function bizLoad(m) {
      const v = U.scale, k = convK(m), ideal = v * SHOP.conv, now = ideal * k, lost = (ideal - now) * SHOP.check;
      const gb = v * 30 * m.statKB / 1024 / 1024, cdnRub = gb * SHOP.cdnGb;
      return `<div class="lf-card biz"><b>Для бизнеса.</b> Из ${nf(v)} заходов в день покупают ${nf(now)} — ${pc(SHOP.conv * k, 2)} вместо ${pc(SHOP.conv, 1)} у быстрой страницы. Недополучено ≈ <b>${rub(lost)}</b> в день, <b>${rub(lost * 30)}</b> в месяц.${m.P.cdn ? ` CDN для статики обходится ≈ ${rub(cdnRub)} в месяц (${nf(gb)} ГБ).` : ` CDN для статики стоил бы ≈ ${rub(cdnRub)} в месяц (${nf(gb)} ГБ).`}
        <div class="lf-kpis sm">${tile('Заказов в день', nf(now), `из ${nf(ideal)} у быстрой страницы`, k > 0.97 ? 'ok' : k > 0.85 ? 'warn' : 'bad')}${tile('Потеря выручки', rub(lost * 30), 'в месяц', lost > 0 ? 'bad' : 'ok')}</div>
        ${asm([`Базовая конверсия ${pc(SHOP.conv, 1)}, если товар на экране за 1 с; средний чек ${nf(SHOP.check)} ₽`, 'Каждая секунда LCP сверх первой — минус 7 % заказов (не больше −70 %)', 'INP хуже 200 мс — минус 2 %, хуже 500 мс — минус 4 %: «мёртвые» кнопки', 'CLS хуже 0,1 — минус 1 %, хуже 0,25 — минус 2 %: промахи мимо кнопок', `CDN ≈ ${SHOP.cdnGb} ₽ за ГБ; со CDN раздаётся статика — ${kbf(m.statKB)} на заход`, 'Первый заход без кэша, телефон среднего класса', 'Все заходы — в тех же условиях, что на ползунках; в жизни это смесь сетей и городов'])}</div>`;
    }
    /* что видит покупатель в момент t */
    function phone1(m, t) {
      const T = m.T, P = m.P, end = t == null; if (end) t = m.end + 1000;
      const hdr = `<div class="lf-ph-top"><span>shop.ru/drills</span>${t < m.end ? '<i class="lf-spin"></i>' : ''}</div>`;
      if (t < m.fcp) return { h: hdr + `<div class="lf-ph-blank"><b>${t < m.dns ? 'Ищем адрес…' : t < m.tls ? 'Подключаемся…' : t < m.ttfb ? 'Ждём сервер…' : 'HTML пришёл, ждём стили'}</b><small>экран пока белый</small></div>`, cap: t < m.ttfb ? `${sec(t)}: сервер ещё не ответил — экран белый.` : `${sec(t)}: HTML уже пришёл, но без CSS браузер не рисует — экран всё ещё белый.` };
      const fontOk = t >= T.font.end, heroOk = t >= T.hero.end + 16, thOk = t >= T.thumbs.end + 16, recOk = t >= T.recs.end + 30, cartOk = t >= T.cart.end, rdy = t >= m.ready;
      const flash = s => s && t >= s.t && t < s.t + 500;
      const sh = m.shifts, shHero = !P.sizes && flash(sh.find(s => s.v === 0.16)), shRec = !P.sizes && flash(sh.find(s => s.v === 0.09));
      const clicked = t >= m.click;
      const btn = !clicked ? `<span class="lf-ph-btn ${rdy ? 'on' : ''}">В корзину</span>` : rdy ? `<span class="lf-ph-btn ok">В корзине ✓</span>` : `<span class="lf-ph-btn dead">Нажали — не реагирует</span>`;
      const recs = recOk ? `<div class="lf-ph-recs ${shRec ? 'shift' : ''}">С этим покупают: биты, кейс, аккумулятор</div>` : P.sizes ? '<div class="lf-ph-recs ph"></div>' : '';
      const body = `<div class="lf-ph-scr ${fontOk ? '' : 'fb'}"><div class="lf-ph-nav"><b>СтройДом</b><span>${cartOk ? 'Корзина · 2' : 'Корзина'}</span></div>
        ${P.sizes || !recOk ? '' : recs}
        ${heroOk ? `<div class="lf-ph-img on ${shHero ? 'shift' : ''}"></div>` : P.sizes ? '<div class="lf-ph-img ph"></div>' : ''}
        <div class="lf-ph-tt">Дрель-шуруповёрт 18 В</div><div class="lf-ph-pr">7 490 ₽</div>${btn}
        <div class="lf-ph-th">${[0, 1, 2].map(() => thOk ? '<i class="on"></i>' : P.sizes ? '<i></i>' : '').join('')}</div>
        ${P.sizes ? recs : ''}</div>`;
      let cap;
      if (!heroOk) cap = `${sec(t)}: стили есть, текст виден${fontOk ? '' : ' запасным шрифтом'}, главной картинки ещё нет.`;
      else if (!rdy) cap = `${sec(t)}: товар виден (LCP ${sec(m.lcp)}), но JS ещё ${t < m.T.js.end ? 'качается' : 'выполняется'} — кнопка «В корзину» не работает${clicked ? ', покупатель уже нажал' : ''}.`;
      else if (t < m.end) cap = `${sec(t)}: кнопки ожили, догружаются ${!recOk ? 'рекомендации' : 'картинки и шрифты'}.`;
      else cap = `Страница готова за ${sec(m.end)}. Покупатель нажал «В корзину» через секунду после появления товара: ${m.ready > m.click ? `ждал ${sec(m.ready - m.click)}, пока кнопка оживёт` : 'кнопка уже работала'}.`;
      if (shHero || shRec) cap += ' Страница прыгнула — это CLS.';
      return { h: hdr + body, cap };
    }
    function setT1(t) {
      U.t1 = t;
      const m = U.m1; if (!m) return;
      wfCursor($('#lfWf1'), t, U.max1);
      const r = phone1(m, t), ph = $('#lfPh1'), cp1 = $('#lfCap1');
      if (ph) ph.innerHTML = r.h; if (cp1) cp1.textContent = r.cap;
      setScrub('1', t == null ? U.max1 : t, U.max1);
    }

    /* ================= вкладка 2: SSR, CSR, SSG ================= */
    const KN = Object.fromEntries(RKINDS.map(([k, n, s]) => [k, { n, s }]));
    const PRODUCTS = [['Дрель-шуруповёрт 18 В', 7490, 6990], ['Перфоратор SDS+ 800 Вт', 9990, 9490], ['Ударная дрель 650 Вт', 4290, 3990]];
    const FIRST = {
      ssg: `<!-- /catalog/drills · собрано при сборке сайта в 03:00, лежит на CDN -->
<html><head><link rel="stylesheet" href="/s.8c1f.css"></head>
<body>
  <h1>Дрели</h1>
  <ul class="products">
    <li><a href="/p/1841">Дрель-шуруповёрт 18 В</a> <b>7 490 ₽</b>
        <button>В корзину</button></li>
    <li><a href="/p/2207">Перфоратор SDS+ 800 Вт</a> <b>9 990 ₽</b> …</li>
    … ещё 22 товара
  </ul>
  <script src="/app.3f9a.js" defer></script>
</body></html>`,
      ssr: `<!-- /catalog/drills · собрано сервером для этого запроса за ${SSR_MS} мс -->
<html><head><link rel="stylesheet" href="/s.8c1f.css"></head>
<body>
  <h1>Дрели</h1>
  <ul class="products">
    <li><a href="/p/1841">Дрель-шуруповёрт 18 В</a> <b>7 490 ₽</b>
        <button>В корзину</button></li>
    … ещё 23 товара, цены — на эту секунду
  </ul>
  <script>window.__DATA__ = {…}</script>  <!-- данные для гидратации -->
  <script src="/app.3f9a.js" defer></script>
</body></html>`,
      csr: `<!-- /catalog/drills · одна и та же заготовка для всех страниц -->
<html><head><link rel="stylesheet" href="/s.8c1f.css"></head>
<body>
  <div id="root"></div>   <!-- пусто: товары появятся, когда
                               выполнится JS и придёт ответ API -->
  <script src="/app.3f9a.js" defer></script>
</body></html>`
    };
    function renderHTML() {
      const B = isBiz(), R = U.r;
      return ana(LIFE.render[0], LIFE.render[1], B ? '' : LIFE.render[2])
        + `<div class="lf-ctls">${netCtl()}${jsCtl()}
          <div class="lf-ctl"><b>Цены</b>${seg('personal', [[0, 'Общие для всех'], [1, 'Персональные']], +R.personal)}<small class="lf-sub">${R.personal ? 'у вошедшего покупателя — своя скидка' : 'одна страница для всех покупателей'}</small></div>
          <div class="lf-ctl"><b>Пик: просмотров каталога в секунду</b>${seg('rps', RPS.map(([v, n]) => [v, n]), R.rps)}<small class="lf-sub">сервер: 8 ядер, загружаем до 70 %</small></div>
          ${B ? scaleSeg() : ''}</div>
        <p class="lf-note">Расстояние до сервера — ${nf(U.P.km)} км, как на вкладке «Открытие страницы»; статика во всех трёх способах раздаётся через CDN.</p>
        <div class="lf-r3" id="lfR3"></div>
        ${scrub('2', '▶ Открыть каталог')}
        <div class="lf-wfs" id="lfWf2"></div>
        <div class="lf-tablewrap" id="lfRtab"></div>
        <div class="lf-robot" id="lfRobot"></div>
        <div id="lfBiz2"></div>${nextBtn('render')}`;
    }
    function renderRows(r) {
      const T = r.T, img0 = Math.min(T.hero.req, T.thumbs.req), imgFb = Math.min(T.hero.fb, T.thumbs.fb), imgEnd = Math.max(T.hero.end, T.thumbs.end);
      const P = U.P, N = NETS[P.net], c = { dns: N.rtt + 20, rtt: N.rtt + kmRtt(EDGE_KM) };
      const rows = [
        { k: 'conn', n: 'Соединение', sub: 'DNS, TCP, TLS до CDN', segs: [['dns', 0, c.dns], ['tcp', c.dns, c.dns + c.rtt], ['tls', c.dns + c.rtt, c.dns + 2 * c.rtt]], dur: c.dns + 2 * c.rtt },
        { k: 'html', n: 'HTML', sub: r.kind === 'csr' ? '3 КБ · пустая заготовка' : r.kind === 'ssg' ? '60 КБ · готовый, с CDN' : `60 КБ · сервер собирает ${SSR_MS} мс`, segs: [['wait', T.html.req, T.html.fb], ['dl', T.html.fb, T.html.end]], dur: T.html.end - T.html.req },
        { k: 'js', n: 'app.js', sub: r.kind === 'csr' ? 'качаем и строим страницу' : 'качаем и гидратируем', segs: [['wait', T.js.req, T.js.fb], ['dl', T.js.fb, T.js.end], ['exec', T.js.ex0, T.js.ex1, r.kind === 'csr' ? 'Телефон строит страницу' : 'Гидратация: JS оживляет кнопки']], dur: T.js.ex1 - T.js.req }
      ];
      if (r.kind === 'csr') rows.push({ k: 'api', n: 'GET /api/products', sub: '30 КБ · товары', segs: [['wait', T.api.req, T.api.fb], ['dl', T.api.fb, T.api.end]], dur: T.api.end - T.api.req });
      rows.push({ k: 'img', n: 'Картинки', sub: `${SIZES.hero + SIZES.thumbs} КБ`, segs: [['wait', img0, imgFb], ['dl', imgFb, imgEnd]], dur: imgEnd - img0 });
      return rows;
    }
    function drawRender() {
      const R = U.r, ms = Object.fromEntries(RKINDS.map(([k]) => [k, renderModel(k, U.P)]));
      U.m2 = ms;
      const max = U.max2 = niceMax(Math.max(...Object.values(ms).map(r => r.end)) * 1.03);
      const box = $('#lfWf2');
      if (box) {
        if (box.dataset.sig !== 'r3') { box.dataset.sig = 'r3'; box.innerHTML = RKINDS.map(([k, n, s]) => `<div class="lf-wfk"><b class="lf-h">${n} <small>${s}</small></b><div class="lf-wf sm" id="lfWf2${k}"></div></div>`).join('') + `<div class="lf-leg">${['dns', 'tcp', 'tls', 'wait', 'dl', 'exec'].map(k => `<span><i class="lf-sg ${k}"></i>${k === 'exec' ? 'Выполнение JS: гидратация или сборка' : SEGT[k].split(':')[0]}</span>`).join('')}</div>`; }
        RKINDS.forEach(([k]) => wfDraw($('#lfWf2' + k), renderRows(ms[k]), max, [{ k: 'see', n: 'Видно товары', t: ms[k].see, cls: 'acc' }, { k: 'tap', n: 'Можно нажать', t: ms[k].tap, cls: 'wrn' }], 'r-' + k));
      }
      const tb = $('#lfRtab'); if (tb) tb.innerHTML = rtable(ms);
      drawRobot();
      const bz = $('#lfBiz2'); if (bz) bz.innerHTML = isBiz() ? bizRender(ms) : renderWhy(ms);
      setT2(U.t2);
    }
    function renderWhy(ms) {
      const a = ms.ssg, b = ms.ssr, c = ms.csr;
      return `<div class="lf-card info"><b>Что видно.</b> Товары раньше всех показывает SSG — ${sec(a.see)}: готовый HTML лежит на CDN рядом с покупателем. SSR отстаёт на ${sec(b.see - a.see)} — это поездка до основного сервера и ${SSR_MS} мс сборки. CSR показывает товары только через ${sec(c.see)}: сначала скачать и выполнить ${kbf(U.P.js)} JS, потом спросить API, потом картинки. Зато у CSR кнопки работают сразу, как появились товары, а у SSR и SSG между «видно» и «можно нажать» — гидратация: ${sec(a.tap - a.see)}${a.tap > c.tap ? '. JS у них делит канал с картинками, поэтому оживает даже позже, чем у CSR' : ''}.</div>`;
    }
    function rtable(ms) {
      const R = U.r, B = isBiz(), L = Object.fromEntries(RKINDS.map(([k]) => [k, serverLoad(k, R.rps, R.personal)]));
      const best = (f, k) => { const v = RKINDS.map(([x]) => f(x)); const mn = Math.min(...v), mx = Math.max(...v); const x = f(k); return mn === mx ? '' : x === mn ? 'ok' : x === mx ? 'bad' : ''; };
      const cdn = { ssg: R.personal ? 'вся страница; персональная цена — отдельным запросом' : 'вся страница, надолго', ssr: R.personal ? 'нельзя: у каждого своя страница' : 'страница на 60 с (s-maxage=60)', csr: R.personal ? 'заготовка и JS; ответ API — нет' : 'заготовка и JS; ответ API на 60 с' };
      const fresh = { ssg: 'на момент сборки: пересобрать 2 000 страниц ≈ 4 мин', ssr: 'всегда свежие', csr: 'всегда свежие' };
      const first = { ssg: 'готовый HTML с товарами, 60 КБ', ssr: 'HTML с товарами, собран под запрос', csr: 'пустая заготовка, 3 КБ' };
      const robot = { ssg: 'товары и ссылки', ssr: 'товары и ссылки', csr: 'пустую страницу' };
      const row = (n, f, cls) => `<tr><th>${n}</th>${RKINDS.map(([k]) => `<td class="${cls ? cls(k) : ''}">${f(k)}</td>`).join('')}</tr>`;
      let h = `<table class="lf-table"><thead><tr><th></th>${RKINDS.map(([k, n, s]) => `<th>${n}<small>${s}</small></th>`).join('')}</tr></thead><tbody>`;
      h += row('Первый ответ', k => first[k]);
      h += row('Первый байт', k => sec(ms[k].ttfb), k => best(x => ms[x].ttfb, k));
      h += row(B ? 'Покупатель видит товары' : 'Видно товары', k => sec(ms[k].see), k => best(x => ms[x].see, k));
      h += row('Можно нажать «В корзину»', k => `${sec(ms[k].tap)}${ms[k].tap > ms[k].see + 50 ? `<small>гидратация ${sec(ms[k].tap - ms[k].see)} после появления</small>` : '<small>сразу, как появились товары</small>'}`, k => best(x => ms[x].tap, k));
      h += row('Поисковый робот видит', k => robot[k], k => k === 'csr' ? 'bad' : 'ok');
      h += row(`Серверы в пик (${nf(R.rps)} просмотров/с)`, k => `${L[k].srv ? nf(L[k].srv) + ' ' + plural(L[k].srv, 'сервер', 'сервера', 'серверов') : 'не нужны'}${B ? ` · ${rub(L[k].srv * SHOP.srvMonth)}/мес` : ''}<small>${L[k].note}</small>`, k => best(x => L[x].srv, k));
      h += row('Кэш на CDN', k => cdn[k]);
      h += row('Свежесть цен', k => fresh[k], k => k === 'ssg' ? 'warn' : '');
      return h + '</tbody></table>';
    }
    function drawRobot() {
      const el = $('#lfRobot'); if (!el) return;
      const R = U.r, k = R.pick, rob = R.robot;
      if (rob) { R.seen[k] = 1; if (RKINDS.every(([x]) => R.seen[x])) done('robot'); }
      const snippet = k === 'csr'
        ? `<div class="lf-serp bad"><span class="lf-serp-u">shop.ru › catalog › drills</span><b>СтройДом</b><p>Загрузка…</p></div><p class="lf-sub">Робот получил пустой <code>&lt;div id="root"&gt;</code>: ни товаров, ни цен, ни ссылок на карточки. Выполнить JS он может, но позже — в отдельной очереди, и не всегда. Новые товары попадут в поиск на дни позже — или не попадут.</p>`
        : `<div class="lf-serp"><span class="lf-serp-u">shop.ru › catalog › drills</span><b>Дрели — купить в СтройДом, 24 модели</b><p>Дрель-шуруповёрт 18 В — 7 490 ₽ · Перфоратор SDS+ 800 Вт — 9 990 ₽ · Ударная дрель 650 Вт — 4 290 ₽ …</p></div><p class="lf-sub">Робот сразу видит заголовок, 24 товара с ценами и ссылки на карточки — страница попадает в поиск по запросу «купить дрель»${k === 'ssg' ? '. Цены — на момент последней сборки' : ''}.</p>`;
      el.innerHTML = `<div class="lf-robot-h"><b class="lf-h">Первый ответ сервера</b>${seg('pick', RKINDS.map(([x, n]) => [x, n + (R.seen[x] ? ' ✓' : '')]), k)}${seg('robot', [[0, 'Что получил браузер'], [1, 'Глазами поискового робота']], +rob)}</div>
        ${rob ? snippet : `<pre class="lf-code">${esc(FIRST[k])}</pre>`}
        <small class="lf-sub">${RKINDS.filter(([x]) => R.seen[x]).length} из 3 способов просмотрено глазами робота.</small>`;
    }
    function bizRender(ms) {
      const R = U.r, v = U.scale, L = Object.fromEntries(RKINDS.map(([k]) => [k, serverLoad(k, R.rps, R.personal)]));
      const k = x => clamp(1 - SHOP.perSec * Math.max(0, ms[x].see / 1000 - 1), 0.3, 1) * (x === 'csr' ? 1 - 0.4 * 0.1 : 1);
      const rev = x => v * SHOP.conv * k(x) * SHOP.check * 30;
      const best = Math.max(...RKINDS.map(([x]) => rev(x) - L[x].srv * SHOP.srvMonth));
      return `<div class="lf-card biz"><b>Для бизнеса.</b> Выручка с каталога за месяц минус серверы под него:
        <div class="lf-bars">${RKINDS.map(([x, n]) => { const val = rev(x) - L[x].srv * SHOP.srvMonth; return `<div class="lf-bar"><span>${n}</span><div class="lf-btrack"><i class="on" style="--w:${(val / best * 100).toFixed(1)}%"></i></div><b>${rub(val)}</b></div>`; }).join('')}</div>
        <p>Разница между лучшим и худшим — <b>${rub(best - Math.min(...RKINDS.map(([x]) => rev(x) - L[x].srv * SHOP.srvMonth)))}</b> в месяц. SSR дорожает с трафиком${R.personal ? ' и персональными ценами' : ''}: ${nf(L.ssr.srv)} ${plural(L.ssr.srv, 'сервер', 'сервера', 'серверов')} ≈ ${rub(L.ssr.srv * SHOP.srvMonth)} в месяц. SSG почти бесплатен, но цену нельзя поменять мгновенно — только пересборкой.</p>
        ${asm([`${nf(v)} заходов в день, конверсия ${pc(SHOP.conv, 1)}, средний чек ${nf(SHOP.check)} ₽`, 'Каждая секунда до появления товаров сверх первой — минус 7 % заказов', '40 % покупателей приходят из поиска; при CSR условно теряем 10 % из них — новые товары индексируются позже', `Сервер на 8 ядер ≈ ${nf(SHOP.srvMonth)} ₽ в месяц; сборка страницы — 120 мс процессора, ответ API — 15 мс`])}</div>`;
    }
    function phone2(k, r, t) {
      const T = r.T, end = t == null; if (end) t = r.end + 1000;
      const hdr = `<div class="lf-ph-top"><span>shop.ru/drills</span>${t < r.end ? '<i class="lf-spin"></i>' : ''}</div>`;
      if (t < r.shell) return { h: hdr + `<div class="lf-ph-blank"><b>${t < T.html.fb ? (k === 'ssr' && t > T.html.req + (T.html.fb - T.html.req) * 0.3 ? 'Сервер собирает страницу…' : 'Ждём ответ…') : 'Ждём стили…'}</b><small>белый экран</small></div>`, cap: 'белый экран', cls: '' };
      if (t < r.see) return { h: hdr + `<div class="lf-ph-scr"><div class="lf-ph-nav"><b>СтройДом</b><span>Корзина</span></div><div class="lf-ph-load"><i class="lf-spin"></i>Загрузка…</div>${[0, 1, 2].map(() => '<div class="lf-ph-sk"></div>').join('')}</div>`, cap: t < T.js.end ? 'заготовка: качается JS' : t < T.js.ex1 ? 'заготовка: телефон выполняет JS' : 'заготовка: ждём ответ API', cls: 'warn' };
      const imgOk = t >= T.hero.end, tap = t >= r.tap, pers = U.r.personal;
      const items = PRODUCTS.map(([n, p, pp], i) => `<div class="lf-ph-row"><i class="${imgOk || (i && t >= T.thumbs.end) ? 'on' : ''}"></i><div><span>${n}</span><b>${nf(pers && k !== 'ssg' ? pp : p)} ₽</b></div><em class="${tap ? 'on' : ''}">В корзину</em></div>`).join('');
      return { h: hdr + `<div class="lf-ph-scr"><div class="lf-ph-nav"><b>СтройДом</b><span>Корзина</span></div><div class="lf-ph-tt">Дрели · 24 товара</div>${items}</div>`, cap: tap ? (imgOk ? 'готово: товары, картинки, кнопки работают' : 'кнопки работают, картинки догружаются') : 'товары видно, кнопки ещё не работают', cls: tap ? 'ok' : 'warn' };
    }
    function setT2(t) {
      U.t2 = t;
      const ms = U.m2; if (!ms) return;
      const box = $('#lfR3');
      if (box) {
        if (box.dataset.sig !== 'r3') { box.dataset.sig = 'r3'; box.innerHTML = RKINDS.map(([k, n, s]) => `<div class="lf-r3c"><b class="lf-h">${n} <small>${s}</small></b><div class="lf-phone sm" id="lfPh2${k}"></div><p class="lf-phcap" id="lfCap2${k}"></p><div class="lf-r3k" id="lfK2${k}"></div></div>`).join(''); }
        RKINDS.forEach(([k]) => {
          const r = ms[k], p = phone2(k, r, t), ph = $('#lfPh2' + k), cp2 = $('#lfCap2' + k), kk = $('#lfK2' + k);
          if (ph) ph.innerHTML = p.h; if (cp2) { cp2.textContent = (t == null ? '' : sec(t) + ': ') + p.cap; cp2.className = 'lf-phcap ' + p.cls; }
          if (kk) { const tt = t == null ? Infinity : t; kk.innerHTML = `<span class="${tt >= r.see ? 'on' : ''}">Видно товары <b>${sec(r.see)}</b></span><span class="${tt >= r.tap ? 'on' : ''}">Можно нажать <b>${sec(r.tap)}</b></span>`; }
        });
      }
      RKINDS.forEach(([k]) => wfCursor($('#lfWf2' + k), t, U.max2));
      setScrub('2', t == null ? U.max2 : t, U.max2);
    }

    /* ================= вкладка 3: BFF и количество вызовов ================= */
    function bffHTML() {
      const B = isBiz(), b = U.b;
      return ana(LIFE.bff[0], LIFE.bff[1], B ? '' : LIFE.bff[2])
        + `<div class="lf-modes" role="group" aria-label="Как собрать экран">${BMODES.map(([k, n, s]) => `<button type="button" data-bmode="${k}" aria-pressed="${k === b.mode}"><b>${n}</b><small>${s}</small></button>`).join('')}</div>
        <div class="lf-ctls">${netCtl()}${B ? scaleSeg() : ''}</div>
        <div class="lf-bwork"><div class="lf-scheme" id="lfScheme"></div><div class="lf-kpis col" id="lfKpis3"></div></div>
        ${scrub('3', '▶ Открыть экран заказа')}
        <div class="lf-wf" id="lfWf3"></div>
        <div class="lf-leg">${[['net', 'Запрос в пути'], ['srv', 'Сервис думает'], ['dl', 'Ответ в пути и скачивание']].map(([k, n]) => `<span><i class="lf-sg ${k}"></i>${n}</span>`).join('')}</div>
        <div class="lf-two"><div class="lf-card" id="lfBcmp"></div><div class="lf-card" id="lfOver"></div></div>
        <div id="lfBffMore"></div><div id="lfBiz3"></div>${nextBtn('bff')}`;
    }
    function bffRows(m) {
      const rows = [];
      m.calls.forEach(c => {
        if (c.front) rows.push({ k: 'front', n: `${c.s.n}: один вызов`, sub: `${dec(c.s.full, 1)} КБ по мобильной сети`, segs: [['net', c.t0, c.t1], ['srv', c.t1, c.t2, `${c.s.n} собирает данные из 6 сервисов`], ['dl', c.t2, c.t3]], dur: c.t3 - c.t0, cls: 'lcp' });
        else rows.push({ k: c.s.k, n: (c.inner ? '↳ ' : '') + c.s.n, sub: c.inner ? `внутри дата-центра · ${c.s.full} КБ` : `${c.s.full} КБ · ${c.s.wave === 2 ? 'ждёт id из заказа' : 'сразу'}`, segs: [['net', c.t0, c.t1], ['srv', c.t1, c.t2, `${c.s.n} думает`], ['dl', c.t2, c.t3]], dur: c.t3 - c.t0, cls: c.inner ? 'inner' : '' });
      });
      return rows;
    }
    function drawBff() {
      const b = U.b, m = U.m3 = bffModel(b.mode, U.P.net), all = BMODES.map(([k]) => bffModel(k, U.P.net));
      const max = U.max3 = niceMax(Math.max(...all.map(x => x.total)) * 1.04);
      if (U.P.net === 'g3') { b.seen[b.mode] = 1; if ((b.seen.seq || b.seen.par) && (b.seen.bff || b.seen.gql)) done('bff'); }
      wfDraw($('#lfWf3'), bffRows(m), max, [{ k: 'done', n: 'Экран готов', t: m.total, cls: 'acc' }], 'bff-' + b.mode);
      const kp = $('#lfKpis3'), B = isBiz(), seq = all[0];
      if (kp) kp.innerHTML = tile(B ? 'Покупатель ждёт экран' : 'Экран готов через', sec(m.total), b.mode === 'seq' ? 'шесть поездок по мобильной сети подряд' : `в ${dec(seq.total / m.total, 1)} раза быстрее, чем по очереди`, m.total < 400 ? 'ok' : m.total < 1000 ? 'warn' : 'bad')
        + tile('Запросов по мобильной сети', m.mobReq, m.mobReq > 1 ? `каждый — поездка ${nf(m.rtt)} мс туда-обратно` : 'остальное — внутри дата-центра, ≈ 1 мс', m.mobReq > 1 ? 'warn' : 'ok')
        + tile('Скачано телефоном', kbf(m.mobKB), m.extraKB > 1 ? `${kbf(m.extraKB)} — лишние поля` : 'только нужные поля', m.extraKB > 1 ? 'bad' : 'ok');
      const cp = $('#lfBcmp');
      if (cp) cp.innerHTML = `<b>Все способы на ${NETS[U.P.net].n}</b><div class="lf-bars">${all.map((x, i) => `<div class="lf-bar ${x.mode === b.mode ? 'cur' : ''}"><span>${BMODES[i][1]}</span><div class="lf-btrack"><i class="on ${x.total > 1000 ? 'bad' : ''}" style="--w:${(x.total / max * 100).toFixed(1)}%"></i></div><b>${sec(x.total)}</b></div>`).join('')}</div><small class="lf-sub">${U.P.net === 'g3' ? `На 3G каждая поездка по сети — ${nf(m.rtt)} мс: шесть последовательных вызовов дают ${sec(seq.total)}, один через BFF — ${sec(all[2].total)}.` : 'Переключи сеть на 3G — разница станет огромной.'}</small>`;
      const ov = $('#lfOver');
      if (ov) { const sum = SVCS.reduce((a, s) => a + s.full, 0), need = SVCS.reduce((a, s) => a + s.need, 0); ov.innerHTML = `<b>Лишние данные (overfetching)</b><table class="lf-table sm"><thead><tr><th>Сервис</th><th>Экрану нужно</th><th>Отдаёт</th><th>Нужно</th></tr></thead><tbody>${SVCS.map(s => `<tr><th>${s.n}</th><td>${s.what}<small>лишнее: ${s.extra}</small></td><td class="bad">${s.full} КБ</td><td class="ok">${dec(s.need, 1)} КБ</td></tr>`).join('')}<tr><th>Итого</th><td></td><td class="bad">${sum} КБ</td><td class="ok">${dec(need, 1)} КБ</td></tr></tbody></table><small class="lf-sub">${m.mobReq > 1 ? `Прямые вызовы тащат на телефон ${kbf(sum)} — в ${nf(sum / need)} раз больше нужного.` : `${m.mode === 'gql' ? 'GraphQL' : 'BFF'} отдаёт телефону ${dec(m.mobKB, 1)} КБ: ровно поля экрана.`}</small>`; }
      const more = $('#lfBffMore');
      if (more) more.innerHTML = b.mode === 'gql' ? `<div class="lf-two"><pre class="lf-code">query OrderCard($id: ID!) {
  order(id: $id) {
    number status total
    items { qty product { title thumb } }
    delivery { courier eta }
    payment { method receiptUrl }
    customer { name address }
    loyalty { pointsEarned }
  }
}</pre><div class="lf-card"><b>GraphQL — BFF, где поля выбирает клиент.</b><ul><li>Плюс: один запрос, ровно нужные поля, новый экран не требует нового эндпоинта.</li><li>Риск N+1: резолвер товара может сходить в каталог за каждым товаром отдельно — нужен батчинг (DataLoader): одна пачка вместо трёх вызовов.</li><li>Кэшировать сложнее: запросы обычно POST, на CDN не ложатся без хранимых запросов.</li><li>Нужен лимит сложности: клиент может попросить слишком много.</li></ul></div></div>`
        : b.mode === 'bff' ? `<div class="lf-card"><b>BFF — сервер под конкретный экран.</b> Обычно его пишет команда мобильного приложения: сама решает, какие поля нужны, и выкатывает вместе с приложением. Плюс: одна поездка по мобильной сети, независимые вызовы — параллельно внутри дата-центра, ответ без лишнего. Цена: ещё один сервис — выкладки, мониторинг, дежурства; и соблазн сложить в него бизнес-логику.</div>`
          : `<div class="lf-card"><b>Почему ${b.mode === 'seq' ? 'по очереди' : 'даже параллельно'} медленно.</b> ${b.mode === 'seq' ? 'Каждый вызов ждёт предыдущего: шесть поездок по мобильной сети подряд.' : 'Три вызова каталога, доставки и оплаты не могут стартовать, пока не пришёл заказ: в нём id товаров, доставки и платежа. Значит, минимум две поездки по мобильной сети.'} И каждый сервис отдаёт всё, что умеет, — телефон качает ${kbf(m.mobKB)} вместо ${dec(m.needKB, 1)} КБ.</div>`;
      const bz = $('#lfBiz3'); if (bz) bz.innerHTML = isBiz() ? bizBff(all) : '';
      setT3(U.t3);
    }
    function bizBff(all) {
      const opens = U.scale * 4, calls = x => opens * 0.003 * Math.max(0, x.total / 1000 - 1), gb = x => opens * x.mobKB / 1024 / 1024;
      const cur = all.find(x => x.mode === U.b.mode), seq = all[0];
      return `<div class="lf-card biz"><b>Для бизнеса.</b> Экран заказа открывают ${nf(opens)} раз в день. Сейчас покупатели суммарно ждут его <b>${nf(opens * cur.total / 3.6e6)} ч</b> в день${cur.mode !== 'seq' ? ` против ${nf(opens * seq.total / 3.6e6)} ч при вызовах по очереди` : ''}. Звонков «где мой заказ» из-за долгой загрузки — ${nf(calls(cur))} в день (${rub(calls(cur) * SHOP.callRub * 30)} в месяц). Мобильный трафик покупателей — ${dec(gb(cur), 1)} ГБ в день.
        <div class="lf-kpis sm">${all.map((x, i) => tile(BMODES[i][1], sec(x.total), `звонков ${nf(calls(x))}/день · ${dec(gb(x), 1)} ГБ/день`, x.mode === U.b.mode ? 'cur' : '')).join('')}</div>
        <p>Цена BFF: ещё один сервис — 2 сервера ≈ ${rub(2 * SHOP.srvMonth)} в месяц и время команды на выкладки и дежурства.</p>
        ${asm([`Экран открывают ${nf(opens)} раз в день, все — на сети ${NETS[U.P.net].n}`, 'Каждая секунда ожидания сверх первой — 0,3 % покупателей звонят в поддержку', `Звонок в поддержку ≈ ${SHOP.callRub} ₽`, `Сервер до покупателя — ${nf(BFF_KM)} км, соединение уже открыто`])}</div>`;
    }
    /* схема: телефон — мобильная сеть — дата-центр (BFF и шесть сервисов); точки летят по времени t */
    function schemeSVG(m, t, W) {
      const H = 300, ph = { x: 14, y: 70, w: 86, h: 160 }, dcX = Math.round(W * 0.5), sx = W - 150, sw = 136, sh = 30, gap = 12, top = 36;
      const sy = i => top + i * (sh + gap), mid = i => sy(i) + sh / 2;
      const front = m.calls.find(c => c.front), bff = !!front, bx = dcX + 18, bw = 92, by = H / 2 - 26, bh = 52;
      const end = t == null; if (end) t = m.total + 1;
      const lerp = (a, b, k) => a + (b - a) * clamp(k, 0, 1);
      const P0 = [ph.x + ph.w, ph.y + ph.h / 2];
      let h = `<svg class="lf-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Схема вызовов">`;
      h += `<rect class="lf-zone" x="${ph.x + ph.w + 12}" y="14" width="${dcX - ph.x - ph.w - 24}" height="${H - 28}" rx="10"/><text class="lf-zt" x="${ph.x + ph.w + 24}" y="34">мобильная сеть</text><text class="lf-zt" x="${ph.x + ph.w + 24}" y="50">${nf(m.rtt)} мс туда-обратно</text>`;
      h += `<rect class="lf-zone dc" x="${dcX}" y="14" width="${W - dcX - 6}" height="${H - 28}" rx="10"/><text class="lf-zt" x="${dcX + 12}" y="${H - 24}">дата-центр · 1 мс</text>`;
      const svcOn = {}, lines = [], dots = [];
      m.calls.forEach(c => {
        if (c.front) return;
        const i = SVCS.indexOf(c.s), to = [sx, mid(i)], from = c.inner ? [bx + bw, H / 2] : P0;
        const st = t >= c.t3 ? 'ok' : t >= c.t0 ? 'on' : '';
        lines.push(`<path class="lf-ln ${st}" d="M${from[0]},${from[1]} C${(from[0] + to[0]) / 2},${from[1]} ${(from[0] + to[0]) / 2},${to[1]} ${to[0]},${to[1]}"/>`);
        const pt = k => { const u = clamp(k, 0, 1), a = 1 - u; const cx = (from[0] + to[0]) / 2; return [a * a * a * from[0] + 3 * a * a * u * cx + 3 * a * u * u * cx + u * u * u * to[0], a * a * a * from[1] + 3 * a * a * u * from[1] + 3 * a * u * u * to[1] + u * u * u * to[1]]; };
        if (t >= c.t0 && t < c.t1) { const p = pt((t - c.t0) / Math.max(1, c.t1 - c.t0)); dots.push(`<circle class="lf-dot q" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"/>`); }
        if (t >= c.t1 && t < c.t2) svcOn[c.s.k] = 1;
        if (t >= c.t2 && t < c.t3) { const p = pt(1 - (t - c.t2) / Math.max(1, c.t3 - c.t2)); dots.push(`<circle class="lf-dot a" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(3 + Math.sqrt(c.s.full) * (c.inner ? 0.6 : 1)).toFixed(1)}"/>`); }
      });
      if (bff) {
        const st = t >= front.t3 ? 'ok' : t >= front.t0 ? 'on' : '', B0 = [bx, H / 2];
        lines.push(`<path class="lf-ln thick ${st}" d="M${P0[0]},${P0[1]} L${B0[0]},${B0[1]}"/>`);
        if (t >= front.t0 && t < front.t1) { const k = (t - front.t0) / (front.t1 - front.t0); dots.push(`<circle class="lf-dot q" cx="${lerp(P0[0], B0[0], k).toFixed(1)}" cy="${lerp(P0[1], B0[1], k).toFixed(1)}" r="4"/>`); }
        if (t >= front.t2 && t < front.t3) { const k = (t - front.t2) / (front.t3 - front.t2); dots.push(`<circle class="lf-dot a" cx="${lerp(B0[0], P0[0], k).toFixed(1)}" cy="${lerp(B0[1], P0[1], k).toFixed(1)}" r="5"/>`); }
      }
      h += lines.join('');
      SVCS.forEach((s, i) => { const c = m.calls.find(x => x.s === s), dn = c && t >= c.t3; h += `<rect class="lf-box ${svcOn[s.k] ? 'busy' : dn ? 'done' : ''}" x="${sx}" y="${sy(i)}" width="${sw}" height="${sh}" rx="7"/><text class="lf-bt" x="${sx + 10}" y="${sy(i) + 19}">${s.n}</text><text class="lf-bs" x="${sx + sw - 8}" y="${sy(i) + 19}" text-anchor="end">${svcOn[s.k] ? 'думает' : s.full + ' КБ'}</text>`; });
      if (bff) { const busy = t >= front.t1 && t < front.t2, dn = t >= front.t3; h += `<rect class="lf-box bff ${busy ? 'busy' : dn ? 'done' : ''}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="9"/><text class="lf-bt" x="${bx + bw / 2}" y="${by + 22}" text-anchor="middle">${m.mode === 'gql' ? 'GraphQL' : 'BFF'}</text><text class="lf-bs" x="${bx + bw / 2}" y="${by + 40}" text-anchor="middle">${busy ? 'собирает' : 'у сервисов'}</text>`; }
      const ready = t >= m.total;
      h += `<rect class="lf-box ph ${ready ? 'done' : ''}" x="${ph.x}" y="${ph.y}" width="${ph.w}" height="${ph.h}" rx="14"/><text class="lf-bt" x="${ph.x + ph.w / 2}" y="${ph.y + 24}" text-anchor="middle">Телефон</text>`;
      h += `<text class="lf-bs" x="${ph.x + ph.w / 2}" y="${ph.y + 44}" text-anchor="middle">Заказ №4810</text>`;
      h += ready ? `<text class="lf-bs ok" x="${ph.x + ph.w / 2}" y="${ph.y + 90}" text-anchor="middle">экран готов</text><text class="lf-bs" x="${ph.x + ph.w / 2}" y="${ph.y + 108}" text-anchor="middle">${sec(m.total)}</text>` : `<text class="lf-bs" x="${ph.x + ph.w / 2}" y="${ph.y + 90}" text-anchor="middle">${t > 0 ? 'загрузка…' : 'нажали'}</text>`;
      h += dots.join('');
      if (!end) h += `<text class="lf-clock" x="${ph.x + ph.w + 24}" y="${H - 24}">прошло ${sec(Math.min(t, m.total))}</text>`;
      return h + '</svg>';
    }
    function setT3(t) {
      U.t3 = t;
      const m = U.m3; if (!m) return;
      const el = $('#lfScheme'); if (el) el.innerHTML = schemeSVG(m, t, Math.max(560, Math.min(980, el.clientWidth || 720)));
      wfCursor($('#lfWf3'), t, U.max3);
      setScrub('3', t == null ? U.max3 : t, U.max3);
    }

    /* ================= вкладка 4: кэш на клиенте ================= */
    const HOW = { cache: ['из кэша', 'ok'], '304': ['304 · сверились', 'info'], dl: ['скачал', 'warn'], sw: ['service worker', 'acc'], fail: ['нет сети', 'bad'] };
    function cacheHTML() {
      const B = isBiz();
      return ana(LIFE.cache[0], LIFE.cache[1], B ? '' : LIFE.cache[2])
        + `<div class="lf-presets">${CPRESETS.map(([n], i) => `<button type="button" class="btn" data-cpre="${i}">${n}</button>`).join('')}</div>
        <div class="lf-ctls w" id="lfCtl4"></div>
        <pre class="lf-code lf-hdrs" id="lfHdrs"></pre>
        <div class="lf-kpis" id="lfKpis4"></div>
        ${`<div class="lf-scrub"><button type="button" class="btn primary" data-play="4" data-lbl="▶ Прожить неделю">▶ Прожить неделю</button><span class="lf-sub">одна неделя одного покупателя: заходы, выкладка версии 2, метро</span></div>`}
        <div class="lf-tablewrap" id="lfCtab"></div>
        <div class="lf-card" id="lfWhy4"></div>
        <div class="lf-api" id="lfApi"></div>
        <div id="lfBiz4"></div>${nextBtn('cache')}`;
    }
    function ctls4() {
      const C = U.c.C;
      return `<div class="lf-ctl"><b>HTML страницы</b>${seg('html', [['no-store', 'no-store'], ['no-cache', 'no-cache'], ['day', 'на сутки']], C.html)}<small class="lf-sub">${C.html === 'day' ? 'сутки не спрашивать сервер' : C.html === 'no-cache' ? 'хранить, но каждый раз сверяться' : 'не хранить вообще'}</small></div>
        <div class="lf-ctl"><b>JS и CSS</b>${seg('app', [['no-store', 'no-store'], ['no-cache', 'no-cache'], ['day', 'на сутки'], ['year', 'на год']], C.app)}<small class="lf-sub">${CC[C.app]}</small></div>
        <div class="lf-ctl"><b>Имя файла</b>${seg('hash', [[0, 'app.js'], [1, 'app.3f9a1c.js']], +C.hash)}<small class="lf-sub">${C.hash ? 'хеш содержимого: новая версия — новое имя' : 'одно имя на все версии'}</small></div>
        <div class="lf-ctl"><b>Service worker</b>${seg('sw', [['off', 'Нет'], ['cache', 'Сначала кэш'], ['swr', 'Кэш + обновить'], ['net', 'Сначала сеть']], C.sw)}<small class="lf-sub">${{ off: 'страница работает только с сетью', cache: 'отдаёт сохранённое, новое — после закрытия вкладок', swr: 'отдаёт сохранённое и тут же обновляет его в фоне', net: 'идёт в сеть, без сети — сохранённое' }[C.sw]}</small></div>`;
    }
    function drawCache() {
      const C = U.c.C, r = U.c.res = cacheModel(C), B = isBiz();
      const ct = $('#lfCtl4'); if (ct) ct.innerHTML = ctls4();
      EL.querySelectorAll('[data-cpre]').forEach(b => { const p = CPRESETS[+b.dataset.cpre][1]; b.classList.toggle('on', Object.keys(p).every(k => p[k] === C[k])); });
      const hd = $('#lfHdrs');
      if (hd) { const ln = (a, b) => a.padEnd(28) + '→ ' + b; hd.textContent = [ln('GET /catalog/drills', `Cache-Control: ${CC[C.html]}   ETag: "v1-8c1f"`), ln('GET /' + (C.hash ? 'app.3f9a1c.js' : 'app.js'), `Cache-Control: ${CC[C.app]}`), ln('GET /img/drill-1841.webp', 'Cache-Control: max-age=2592000 (картинки — на месяц)')].concat(C.sw !== 'off' ? [ln('service worker sw.js', `стратегия «${{ cache: 'сначала кэш', swr: 'кэш, потом обновить', net: 'сначала сеть' }[C.sw]}»`)] : []).join('\n'); }
      const after = r.rows.filter(x => !x.deploy && x.sv === 2 && !x.V.offline).length;
      const kp = $('#lfKpis4');
      if (kp) kp.innerHTML = tile('Скачано за неделю', kbf(r.sumKB), `${r.rows.filter(x => !x.deploy).length} заходов`, r.sumKB > 1500 ? 'warn' : '')
        + tile('Старая версия после выкладки', `${r.stale} из ${after}`, r.stale ? 'покупатель видит старые цены' : 'сразу новая версия', r.stale ? 'warn' : 'ok')
        + tile('Сломанная страница', `${r.broken} из ${after}`, r.broken ? 'новый HTML + старый JS' : 'версии HTML и JS совпадают', r.broken ? 'bad' : 'ok')
        + tile('В метро без сети', r.offlineOk ? 'открылась' : 'не открылась', r.offlineOk ? 'из кэша service worker' : 'нужен service worker', r.offlineOk ? 'ok' : 'warn');
      drawCtab();
      const w = $('#lfWhy4'); if (w) w.innerHTML = whyCache(r);
      drawApi();
      const bz = $('#lfBiz4'); if (bz) bz.innerHTML = B ? bizCache(r) : '';
      if (r.ok) done('cache');
    }
    function drawCtab() {
      const el = $('#lfCtab'), r = U.c.res; if (!el || !r) return;
      const lim = U.c.shown == null ? Infinity : U.c.shown;
      const cell = c => { const [t, cls] = HOW[c.how]; return `<td><span class="lf-chip ${cls}">${t}${c.how === 'dl' ? ' ' + kbf(c.kb) : ''}${c.how === 'cache' || c.how === 'sw' ? ` · v${c.ver}` : c.how === 'fail' ? '' : ` · v${c.ver}`}</span>${c.file ? `<small>${c.file}</small>` : ''}</td>`; };
      el.innerHTML = `<table class="lf-table lf-ctab"><thead><tr><th>Когда</th><th>Что делает покупатель</th>${CRES.map(([k, n]) => `<th>${n}</th>`).join('')}<th>Скачано</th><th>Что видит</th></tr></thead><tbody>${r.rows.map((x, i) => {
        const fut = i >= lim ? 'fut' : i === lim - 1 && !isCalm() ? 'fresh' : '';
        if (x.deploy) return `<tr class="lf-dep ${fut}"><th>${x.V.d}</th><td colspan="${CRES.length + 3}"><b>${x.V.n}</b> — на сервере новый HTML и новый JS${U.c.C.hash ? ' (app.8b27e0.js)' : ' под тем же именем app.js'}</td></tr>`;
        const sh = x.fail ? ['Нет сети — страница не открылась', 'bad'] : x.shown === -1 ? ['Сломано: новый HTML + старый JS', 'bad'] : x.sv === 2 && x.shown === 1 ? ['Старая версия: старые цены', 'warn'] : [`Версия ${x.shown}`, 'ok'];
        return `<tr class="${fut}"><th>${x.V.d}</th><td>${x.V.n}</td>${CRES.map(([k]) => cell(x.cells[k])).join('')}<td class="num">${kbf(x.kb)}${x.bg > 1 ? '<small>в фоне</small>' : ''}${x.ms ? `<small>${sec(x.ms)}</small>` : ''}</td><td><span class="lf-chip ${sh[1]}">${sh[0]}</span></td></tr>`;
      }).join('')}</tbody></table>`;
    }
    function whyCache(r) {
      const C = U.c.C, L = [];
      if (C.html === 'day') L.push('<b>HTML на сутки.</b> Через полчаса после выкладки браузер даже не спрашивает сервер — покупатель видит старые цены до конца суток. А «Обновить» заставляет перепроверить только HTML: приходит новый HTML со старым JS из кэша.');
      if (!C.hash && (C.app === 'day' || C.app === 'year')) L.push(`<b>app.js без хеша с долгим кэшем.</b> Новый HTML ссылается на то же имя — браузер берёт старый файл из кэша и не спрашивает сервер. ${C.app === 'year' ? 'Сломано на год — пока покупатель сам не почистит кэш.' : 'Сломано до конца суток.'}`);
      if (C.app === 'no-store' || C.app === 'no-cache') L.push(`<b>JS без долгого кэша.</b> Каждый заход — ${C.app === 'no-store' ? `заново ${kbf(CRES[1][2])}` : 'лишний запрос-сверка на каждый файл'}. С хешем в имени можно хранить файл год.`);
      if (C.html === 'no-store') L.push('<b>HTML no-store.</b> Свежо, но каждый заход качает HTML целиком и не работает 304. Обычно ставят no-cache: браузер хранит и сверяется по ETag.');
      if (C.sw === 'cache') L.push('<b>Service worker «сначала кэш».</b> Отдаёт сохранённую версию мгновенно, новую качает в фоне, но включает, только когда закрыты все вкладки сайта: «Обновить» не помогает. Нужна кнопка «Доступна новая версия — обновить».');
      if (C.sw === 'swr') L.push('<b>«Кэш, потом обновить».</b> Этот заход — сохранённая версия, следующий — новая. Хорошо для картинок и справочников, рискованно для цен.');
      if (C.sw === 'net') L.push('<b>«Сначала сеть».</b> Онлайн — всегда свежая версия, в метро — сохранённая. Цена — без сети ждём таймаут, прежде чем отдать кэш.');
      if (!r.offlineOk) L.push('<b>В метро страница не открылась:</b> HTTP-кэш без сети не работает для HTML, который надо сверять. Офлайн даёт только service worker.');
      if (r.ok) L.push(`<b>Так и делают:</b> HTML — no-cache и ETag (сверка за ${nf(CNET.rtt)} мс и 0,3 КБ), файлы с хешем — на год. Выкладка видна сразу, повторный заход почти ничего не качает.${r.offlineOk ? ' И даже в метро страница открывается.' : ''}`);
      return `<b>${r.ok ? 'Почему это работает' : 'Почему покупатель видит не то'}</b><ul>${L.map(x => `<li>${x}</li>`).join('')}</ul>`;
    }
    function bizCache(r) {
      const v = U.scale, real = r.rows.filter(x => !x.deploy), after = real.filter(x => x.sv === 2 && !x.V.offline);
      const avgKB = r.sumKB / real.length, gbM = v * 30 * avgKB / 1024 / 1024;
      const badShare = after.filter(x => x.shown === -1).length / after.length, oldShare = after.filter(x => x.shown === 1).length / after.length;
      const lostDay = v * SHOP.conv * SHOP.check * badShare;
      return `<div class="lf-card biz"><b>Для бизнеса.</b> В день выкладки ${pc(oldShare)} заходов видят старые цены${badShare ? `, ${pc(badShare)} — сломанную страницу: ≈ <b>${rub(lostDay)}</b> потерянной выручки за день` : ''}. Трафик с CDN — ≈ ${nf(gbM)} ГБ в месяц, ${rub(gbM * SHOP.cdnGb)}.
        ${asm([`${nf(v)} заходов в день, у каждого покупателя — такая же неделя, как в таблице`, `Конверсия ${pc(SHOP.conv, 1)}, средний чек ${nf(SHOP.check)} ₽; на сломанной странице заказ не оформить`, `CDN ≈ ${SHOP.cdnGb} ₽ за ГБ`, 'Старые цены — спорные заказы и звонки: «на сайте было дешевле»'])}</div>`;
    }
    /* кэш ответов API в приложении: счётчик корзины */
    const apiNew = () => ({ srv: 2, view: 2, at: 0, now: 0, req: 1, mode: '5m', inv: false, log: ['Открыли каталог: GET /api/cart → 2 товара'], fixed: false });
    function drawApi() {
      const el = $('#lfApi'); if (!el) return;
      const A = U.c.api = U.c.api || apiNew(), lie = A.view !== A.srv;
      el.innerHTML = `<b class="lf-h">Кэш данных в приложении: счётчик корзины</b>
        <p class="lf-sub">Приложение запоминает ответ <code>GET /api/cart</code>, чтобы не спрашивать сервер на каждом экране. Вопрос — когда этот ответ устаревает.</p>
        <div class="lf-apiw"><div class="lf-phone sm"><div class="lf-ph-top"><span>Приложение</span></div><div class="lf-ph-scr"><div class="lf-ph-nav"><b>СтройДом</b><span class="${lie ? 'lie' : ''}">Корзина · ${A.view}</span></div><div class="lf-ph-tt">Дрель-шуруповёрт 18 В</div><div class="lf-ph-pr">7 490 ₽</div><span class="lf-ph-btn on">В корзину</span></div></div>
          <div class="lf-apic"><div class="lf-ctls one">
            <div class="lf-ctl"><b>Хранить ответ корзины</b>${seg('amode', [['none', 'Не хранить'], ['5m', '5 минут']], A.mode)}</div>
            <div class="lf-ctl"><b>После своего изменения</b>${seg('ainv', [[0, 'Ничего'], [1, 'Сбросить кэш корзины']], +A.inv)}</div></div>
            <div class="lf-btns"><button type="button" class="btn primary" data-capi="add">В корзину</button><button type="button" class="btn" data-capi="nav">Ушёл на другой экран и вернулся</button><button type="button" class="btn" data-capi="other">С ноутбука добавили товар</button><button type="button" class="btn" data-capi="wait">Прошло 5 минут</button><button type="button" class="btn ghost" data-capi="reset">Сначала</button></div>
            <div class="lf-kpis sm">${tile('На экране', A.view, 'из кэша приложения', lie ? 'bad' : 'ok')}${tile('На сервере', A.srv, 'правда', '')}${tile('Запросов к /api/cart', A.req, `за ${A.now} мин`, '')}</div>
            <div class="lf-card ${lie ? 'bad' : 'ok'}">${lie ? `<b>Экран врёт:</b> в корзине ${A.srv}, а на экране ${A.view}. ${A.last === 'add' ? 'Покупатель решит, что товар не добавился, и нажмёт ещё раз — получит лишний. Лечится инвалидацией: после своего изменения сбросить кэш корзины и спросить сервер заново.' : 'Изменение пришло с другого устройства — приложение о нём не знает. Лечится коротким сроком хранения, обновлением при возвращении в приложение или push-уведомлением.'}` : A.fixed ? '<b>Счётчик честный:</b> после своего изменения приложение сбросило кэш и спросило сервер. Свои изменения — всегда инвалидация, чужие — короткий срок или обновление при возвращении на экран.' : A.mode === 'none' ? `<b>Честно, но дорого:</b> каждый экран — новый запрос (${A.req} за сессию). Под нагрузкой это тысячи лишних запросов в секунду.` : '<b>Пока честно.</b> Нажми «В корзину» и посмотри на счётчик.'}</div>
            <ol class="lf-log sm">${A.log.slice(-5).map(x => `<li>${esc(x)}</li>`).join('')}</ol></div></div>`;
    }
    function apiAct(a) {
      const A = U.c.api = U.c.api || apiNew();
      const fetch = why => { A.view = A.srv; A.at = A.now; A.req++; A.log.push(`${why}: GET /api/cart → ${A.srv}`); };
      if (a === 'reset') { U.c.api = Object.assign(apiNew(), { mode: A.mode, inv: A.inv }); drawApi(); return; }
      A.last = a;
      if (a === 'add') { A.srv++; A.req++; A.log.push(`POST /api/cart → в корзине ${A.srv}`); if (A.mode === 'none') fetch('Экран перерисовался'); else if (A.inv) { fetch('Кэш корзины сброшен'); if (A.mode === '5m') { A.fixed = true; done('inval'); } } else A.log.push(`Экран берёт корзину из кэша: ${A.view}`); }
      if (a === 'nav') { if (A.mode === 'none' || A.now - A.at >= 5) fetch(A.mode === 'none' ? 'Новый экран' : 'Кэш устарел'); else A.log.push(`Новый экран: корзина из кэша (${A.now - A.at} мин) → ${A.view}`); }
      if (a === 'other') { A.srv++; A.log.push(`С ноутбука добавили товар: на сервере ${A.srv}, телефон не знает`); }
      if (a === 'wait') { A.now += 5; A.log.push(`Прошло 5 минут (${A.now} мин с начала)`); }
      drawApi();
    }

    /* ================= вкладка 5: офлайн и синхронизация ================= */
    function offHTML() {
      const B = isBiz();
      return ana(LIFE.offline[0], LIFE.offline[1], B ? '' : LIFE.offline[2])
        + `<div class="lf-ctls w" id="lfCtl5"></div><div class="lf-off" id="lfOff"></div>
        <div class="lf-two"><div class="lf-logbox"><b class="lf-h">Журнал синхронизации</b><ol class="lf-log" id="lfOlog"></ol></div><div id="lfOres"></div></div>
        <div id="lfBiz5"></div>${nextBtn('offline')}`;
    }
    function ctls5() {
      const S = U.oset;
      return `<div class="lf-ctl"><b>Если одно и то же поменяли на двух устройствах</b>${seg('strat', [['lww', 'Последняя запись побеждает'], ['merge', 'Слияние по полям']], S.strat)}<small class="lf-sub">${S.strat === 'lww' ? 'LWW: строка целиком, побеждает более позднее время' : 'сравниваем с исходной версией: разные поля — объединяем, одно поле — конфликт'}</small></div>
        <div class="lf-ctl"><b>Ключ идемпотентности</b>${seg('idem', [[0, 'Нет'], [1, 'Есть']], +S.idem)}<small class="lf-sub">${S.idem ? 'у каждой операции свой id: повтор не выполняется' : 'сервер не отличит повтор от новой операции'}</small></div>
        <div class="lf-ctl"><b>Сеть при отправке</b>${seg('flaky', [[0, 'Стабильная'], [1, 'Мигает']], +S.flaky)}<small class="lf-sub">${S.flaky ? 'сервер всё сделал, а ответ потерялся — телефон повторит' : 'ответы доходят с первого раза'}</small></div>
        <div class="lf-btns"><button type="button" class="btn ghost" data-oact="reset">Сначала</button></div>`;
    }
    const itemRow = (x, hot, tag) => `<li class="${hot ? 'hot ' + hot : ''} ${x.dup ? 'dup' : ''}"><span>${esc(x.n)}</span><b>${x.q} ${esc(x.u)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ''}${tag || ''}</li>`;
    function drawOff() {
      const o = U.o = U.o || offNew(), S = U.oset, busy = U.obusy;
      const ct = $('#lfCtl5'); if (ct && !ct.dataset.ok) { ct.innerHTML = ctls5(); ct.dataset.ok = 1; }
      const el = $('#lfOff'); if (!el) return;
      const pend = {}; o.ph.queue.forEach(op => { pend[op.type === 'add' ? op.item.id : op.id] = 1; });
      const sending = o.ph.queue.find(op => op.st === 'send' || op.st === 'lost');
      const phone = `<div class="lf-dev ${o.ph.online ? '' : 'off'}"><div class="lf-dev-h"><b>Телефон Ани</b><span class="lf-chip ${o.ph.online ? 'ok' : 'bad'}">${o.ph.online ? 'сеть есть' : 'в метро · нет сети'}</span></div>
        <button type="button" class="btn ${o.ph.online ? '' : 'primary'}" data-oact="net" ${busy ? 'disabled' : ''}>${o.ph.online ? 'Зайти в метро' : 'Выйти из метро — сеть появилась'}</button>
        <ul class="lf-list">${o.ph.items.map(x => itemRow(x, pend[x.id] ? 'ph' : '', pend[x.id] ? '<em>ждёт отправки</em>' : '')).join('')}</ul>
        <div class="lf-acts">${PACT.map(a => { const miss = a.op.type === 'set' && !o.ph.items.find(x => x.id === a.op.id); return `<button type="button" class="btn" data-pact="${a.k}" ${o.ph.used[a.k] || miss || busy ? 'disabled' : ''}>${a.op.type === 'order' ? `Оформить заказ · ${nf(sumList(o.ph.items))} ₽` : a.n}</button>`; }).join('')}</div>
        <div class="lf-queue"><b>Очередь на отправку · ${o.ph.queue.length}</b>${o.ph.queue.length ? `<ol>${o.ph.queue.map(op => `<li class="${op.st || ''}"><span>${esc(op.label)}</span><small>${op.st === 'send' ? 'отправляется →' : op.st === 'lost' ? 'ответ потерялся ✕' : op.st === 'ack' ? 'сервер ответил ✓' : `ждёт сети · ${hm(op.ts)}`}${S.idem ? ` · ${op.key}` : ''}</small></li>`).join('')}</ol>` : '<p class="lf-sub">пусто</p>'}</div>
        ${sending ? `<div class="lf-flyrow"><span class="lf-fly ${sending.st === 'lost' ? 'lost' : ''}">${esc(sending.label)}</span></div>` : ''}</div>`;
      const conf = o.conf.map((c, i) => c.done ? '' : `<div class="lf-conf"><b>Конфликт: ${esc(c.op.row.n)}</b>${c.kind === 'field' ? `<p>${FIELD_T[c.op.f]}: на телефоне <b>${c.op.f === 'q' ? c.op.v : '«' + esc(c.op.v) + '»'}</b>, на ноутбуке <b>${c.op.f === 'q' ? c.theirs : '«' + esc(c.theirs) + '»'}</b>, было ${c.op.f === 'q' ? c.op.base : '«' + esc(c.op.base) + '»'}.</p><div class="lf-btns"><button type="button" class="btn" data-cres="${i}:1">Как на телефоне</button><button type="button" class="btn" data-cres="${i}:0">Как на ноутбуке</button></div>` : `<p>На телефоне изменили, на ноутбуке удалили.</p><div class="lf-btns"><button type="button" class="btn" data-cres="${i}:1">Вернуть в список</button><button type="button" class="btn" data-cres="${i}:0">Оставить удалённым</button></div>`}</div>`).join('');
      const server = `<div class="lf-dev srv"><div class="lf-dev-h"><b>Сервер</b><span class="lf-chip">${hm(o.clock)}</span></div>
        <ul class="lf-list">${o.srv.items.map(x => itemRow(x, o.hot[x.id.split('-')[0]] || '')).join('')}</ul>
        ${o.srv.orders.length ? `<div class="lf-orders">${o.srv.orders.map(z => `<span class="lf-chip ${z.dup ? 'bad' : 'ok'}">Заказ №${z.no} · ${nf(z.sum)} ₽${z.dup ? ' · дубль' : ''}</span>`).join('')}</div>` : ''}
        ${conf}</div>`;
      const laptop = `<div class="lf-dev"><div class="lf-dev-h"><b>Ноутбук Игоря</b><span class="lf-chip ok">дома · онлайн</span></div>
        <ul class="lf-list">${o.srv.items.map(x => itemRow(x, o.hot[x.id.split('-')[0]] === 'lp' ? 'lp' : '')).join('')}</ul>
        <div class="lf-acts">${LACT.map(a => `<button type="button" class="btn" data-lact="${a.k}" ${o.lp.used[a.k] || busy || !o.srv.items.find(x => x.id === a.op.id) ? 'disabled' : ''}>${a.n}</button>`).join('')}</div>
        <p class="lf-sub">Ноутбук всегда онлайн: его правки сразу на сервере.</p></div>`;
      el.innerHTML = phone + server + laptop;
      const lg = $('#lfOlog');
      if (lg) { lg.innerHTML = o.log.length ? o.log.map(e => `<li class="${e.cls}"><span class="lf-lt">${hm(e.t)}</span><i class="lf-who ${e.who}">${{ phone: 'телефон', laptop: 'ноутбук', srv: 'сервер' }[e.who]}</i><span>${esc(e.text)}</span></li>`).join('') : '<li class="mut"><span class="lf-lt">08:30</span><span>Аня спускается в метро со списком покупок для ремонта. Игорь дома за ноутбуком. Сделай пару правок на обоих устройствах, потом выведи Аню из метро.</span></li>'; lg.scrollTop = lg.scrollHeight; }
      const rs = $('#lfOres'); if (rs) rs.innerHTML = offResult(o);
      const bz = $('#lfBiz5'); if (bz) bz.innerHTML = isBiz() ? bizOff(o) : '';
    }
    function offResult(o) {
      const S = U.oset, open = o.conf.filter(c => !c.done).length, any = o.log.some(e => e.who === 'srv');
      if (!any) return `<div class="lf-card"><b>Попробуй так.</b> <ol><li>На телефоне (в метро): «Краска: 3 банки», «+ Шпаклёвка», «Оформить заказ».</li><li>На ноутбуке: «Краска: 4 банки» и «Удалить «Валик»».</li><li>Выведи Аню из метро и посмотри, что осталось на сервере. Потом — «Сначала», другая стратегия, ключ идемпотентности и «мигающая» сеть.</li></ol></div>`;
      const L = [];
      if (o.lost.length) L.push(`<b class="bad">Молча потеряно (${o.lost.length}):</b> ${o.lost.map(esc).join('; ')}. Никто не узнал — ни Аня, ни Игорь.`);
      if (o.conf.length) L.push(`<b>Конфликтов: ${o.conf.length}</b>, решено ${o.conf.length - open}${open ? ' — реши их на сервере' : ''}. Ничего не потеряно молча: спорное решает человек.`);
      if (o.dups.length) L.push(`<b class="bad">Дубли (${o.dups.length}):</b> ${o.dups.map(esc).join('; ')}. Сервер не отличил повтор от новой операции.`);
      if (o.dedup) L.push(`<b class="ok">Повторов узнано по ключу: ${o.dedup}.</b> Сеть мигала, телефон отправлял снова, а сервер выполнил каждую операцию ровно один раз.`);
      if (!L.length) L.push('Пока всё сошлось без потерь. Чтобы увидеть конфликт, поменяй одно и то же на обоих устройствах, пока телефон в метро.');
      return `<div class="lf-card ${o.lost.length || o.dups.length ? 'bad' : open ? 'warn' : 'ok'}"><b>Итог синхронизации · ${S.strat === 'lww' ? 'последняя запись побеждает' : 'слияние'}</b><ul>${L.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
    }
    function bizOff(o) {
      const orders = U.scale * 0.6, retry = orders * 0.02, caseRub = 250;
      return `<div class="lf-card biz"><b>Для бизнеса.</b> Из приложения оформляют ≈ ${nf(orders)} заказов в день. Около 2 % отправляются повторно из-за плохой сети — ${nf(retry)} в день. ${U.oset.idem ? `С ключом идемпотентности это ${nf(retry)} спокойных повторов: сервер узнаёт их и не списывает деньги второй раз.` : `Без ключа идемпотентности каждый — второй заказ и двойное списание: ≈ <b>${rub(retry * caseRub * 30)}</b> в месяц на разборы, плюс злые отзывы.`} Молча потерянная правка в общем списке — неверное количество в заказе: довоз или возврат ≈ 390 ₽.
        ${asm([`Заказов из приложения — ${nf(orders)} в день`, '2 % заказов отправляются повторно: таймаут, ответ потерялся', `Разбор двойного списания ≈ ${caseRub} ₽: звонок в поддержку, возврат, комиссия банка`])}</div>`;
    }
    function offFlush() {
      const o = U.o, S = U.oset;
      if (U.obusy || !o.ph.online) return;
      const q = o.ph.queue.slice();
      const steps = [];
      q.forEach(op => {
        steps.push(() => { op.st = 'send'; });
        steps.push(() => {
          const r = srvApply(o, op, S.strat, S.idem); op.tries++;
          offLog(o, 'srv', r.text, r.res === 'ok' ? '' : r.res === 'conf' || r.res === 'warn' ? 'warn' : 'bad');
          if (S.flaky && op.tries === 1) { op.st = 'lost'; offLog(o, 'phone', `Ответ на «${op.label}» не дошёл — сеть мигнула. Отправляем ещё раз${S.idem ? ` с тем же ключом ${op.key}` : ''}`, 'warn'); }
          else op.st = 'ack';
        });
        if (S.flaky) {
          steps.push(() => { op.st = 'send'; o.retries++; });
          steps.push(() => {
            const r = srvApply(o, op, S.strat, S.idem); op.tries++; op.st = 'ack';
            offLog(o, 'srv', 'Повтор: ' + r.text, r.res === 'dedup' ? 'ok' : r.res === 'dup' ? 'bad' : r.res === 'ok' ? '' : 'warn');
            if (r.res === 'dedup' && (op.type === 'add' || op.type === 'order')) done('idem');
          });
        }
        steps.push(() => { o.ph.queue = o.ph.queue.filter(x => x !== op); });
      });
      steps.push(() => { o.ph.items = cp(o.srv.items); if (q.length) offLog(o, 'phone', 'Очередь пуста — телефон забрал с сервера актуальный список', 'ok'); U.obusy = false; });
      U.obusy = true;
      const run = i => { if (!U.alive) return; if (i >= steps.length) { U.obusy = false; drawOff(); return; } steps[i](); drawOff(); if (isCalm()) run(i + 1); else later(() => run(i + 1), 520); };
      if (isCalm()) { steps.forEach(f => f()); U.obusy = false; drawOff(); } else run(0);
    }
    function offAct(kind, k) {
      const o = U.o = U.o || offNew();
      if (kind === 'net') {
        o.ph.online = !o.ph.online; o.clock += 5;
        offLog(o, 'phone', o.ph.online ? `Сеть появилась — отправляем очередь (${o.ph.queue.length}) по порядку` : 'Аня зашла в метро — сети нет', o.ph.online ? 'ok' : 'mut');
        drawOff(); if (o.ph.online) offFlush(); return;
      }
      if (kind === 'pact') { const a = PACT.find(x => x.k === k); if (a && phoneAct(o, a)) { drawOff(); if (o.ph.online) offFlush(); } return; }
      if (kind === 'lact') { const a = LACT.find(x => x.k === k); if (a) laptopAct(o, a); drawOff(); return; }
    }

    /* ================= итоги ================= */
    function memoHTML() {
      const L = isBiz() ? MEMO_BIZ : MEMO;
      return `<b class="lf-h">Что запомнить</b><div class="lf-memo">${L.map(([t, xs]) => `<div class="lf-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>
        <div class="lf-card info"><b>Порядок разбора на собеседовании.</b> ${isBiz() ? 'Где покупатель и какая у него сеть → сколько поездок по сети до готового экрана → что можно отдать заранее (CDN, SSG, кэш) → что собрать рядом с сервисами (BFF) → что будет без сети и при повторе (очередь, идемпотентность).' : 'Сеть и расстояние (RTT) → число последовательных поездок (DNS, TCP, TLS, зависимые вызовы) → байты на критическом пути (JS, картинки) → кто рисует (SSG, SSR, CSR) → кэш на каждом уровне и его сброс → офлайн, конфликты и идемпотентность.'}</div>`;
    }

    /* ================= шапка, вкладки, события ================= */
    function setTab(k) {
      stopPlay(); U.tab = k;
      EL.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.lf-tabs'), box = EL.closest('.lab-main');
      if (tabs && box && tabs.getBoundingClientRect().top < box.getBoundingClientRect().top) tabs.scrollIntoView({ block: 'start' });
    }
    function setMode(m) {
      MODE = m === 'biz' ? 'biz' : 'tech';
      try { localStorage.setItem(MODE_KEY, MODE); } catch (e) { /* без хранилища */ }
      EL.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === MODE)));
      const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0;
      render(); if (box) box.scrollTop = y;
    }
    function render() {
      const v = $('#lfView'); if (!v) return;
      stopPlay();
      const T = U.tab;
      if (T === 'load') { v.innerHTML = loadHTML(); drawLoad(); }
      else if (T === 'render') { v.innerHTML = renderHTML(); drawRender(); }
      else if (T === 'bff') { v.innerHTML = bffHTML(); drawBff(); }
      else if (T === 'cache') { v.innerHTML = cacheHTML(); drawCache(); }
      else if (T === 'offline') { v.innerHTML = offHTML(); drawOff(); }
      else v.innerHTML = memoHTML();
    }
    /* перерисовать панель управления вкладки, не трогая водопад (чтобы полоски плавно переехали) */
    function refreshCtl() {
      const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0;
      if (U.tab === 'load') { const c = $('.lf-ctls'); if (c) { const t = document.createElement('div'); t.innerHTML = loadHTML(); const n = t.querySelector('.lf-ctls'); if (n) c.innerHTML = n.innerHTML; } drawLoad(); }
      else if (U.tab === 'render') { const c = $('.lf-ctls'); if (c) { const t = document.createElement('div'); t.innerHTML = renderHTML(); const n = t.querySelector('.lf-ctls'); if (n) c.innerHTML = n.innerHTML; const nt = t.querySelector('.lf-note'), ot = $('.lf-note'); if (nt && ot) ot.innerHTML = nt.innerHTML; } drawRender(); }
      else if (U.tab === 'bff') { const c = $('.lf-ctls'); if (c) c.innerHTML = netCtl() + (isBiz() ? scaleSeg() : ''); drawBff(); }
      else if (U.tab === 'cache') drawCache();
      else if (U.tab === 'offline') { const c = $('#lfCtl5'); if (c) c.innerHTML = ctls5(); drawOff(); }
      if (box) box.scrollTop = y;
    }
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-go],[data-mode],[data-set],[data-act],[data-play],[data-bmode],[data-cpre],[data-capi],[data-oact],[data-pact],[data-lact],[data-cres]');
      if (!b || !EL.contains(b) || b.disabled) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.go) return setTab(d.go);
      if (d.mode) return setMode(d.mode);
      if (d.play) {
        if (PL.key === d.play) { stopPlay(); return; }
        if (d.play === '1') play('1', U.max1, t => setT1(t >= U.max1 ? null : t));
        else if (d.play === '2') play('2', U.max2, t => setT2(t >= U.max2 ? null : t));
        else if (d.play === '3') play('3', U.max3, t => setT3(t >= U.max3 ? null : t));
        else if (d.play === '4') { const n = VISITS.length; play('4', n * 700, t => { const k = Math.min(n, Math.floor(t / 700) + 1); U.c.shown = t >= n * 700 ? null : k; drawCtab(); }); }
        return;
      }
      if (d.bmode) { U.b.mode = d.bmode; EL.querySelectorAll('[data-bmode]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); stopPlay(); U.t3 = null; drawBff(); return; }
      if (d.cpre != null) { U.c.C = Object.assign({}, CPRESETS[+d.cpre][1]); U.c.shown = null; drawCache(); return; }
      if (d.capi) { apiAct(d.capi); return; }
      if (d.oact) { if (d.oact === 'reset') { U.o = offNew(); U.obusy = false; timers.forEach(clearTimeout); timers.clear(); drawOff(); return; } offAct('net'); return; }
      if (d.pact) { offAct('pact', d.pact); return; }
      if (d.lact) { offAct('lact', d.lact); return; }
      if (d.cres) { const [i, m] = d.cres.split(':'); resolveConf(U.o, +i, m === '1'); if (U.oset.strat === 'merge') done('conflict'); drawOff(); return; }
      if (d.act === 'vlad') { Object.assign(U.P, { net: 'g3', km: 6400 }); refreshCtl(); return; }
      if (d.act === 'p0') { U.P = Object.assign({}, P0); refreshCtl(); return; }
      if (d.set) {
        const i = d.set.indexOf(':'), k = d.set.slice(0, i), raw = d.set.slice(i + 1), v = isNaN(+raw) ? raw : +raw;
        stopPlay();
        if (k === 'net') U.P.net = raw;
        else if (k === 'cdn' || k === 'img' || k === 'sizes') U.P[k] = !!v;
        else if (k === 'scale') U.scale = v;
        else if (k === 'personal') U.r.personal = !!v;
        else if (k === 'rps') U.r.rps = v;
        else if (k === 'pick') { U.r.pick = raw; drawRobot(); return; }
        else if (k === 'robot') { U.r.robot = !!v; drawRobot(); return; }
        else if (k === 'html' || k === 'app' || k === 'sw') { U.c.C[k] = raw; U.c.shown = null; }
        else if (k === 'hash') { U.c.C.hash = !!v; U.c.shown = null; }
        else if (k === 'amode') { U.c.api.mode = raw; drawApi(); return; }
        else if (k === 'ainv') { U.c.api.inv = !!v; drawApi(); return; }
        else if (k === 'strat' || k === 'idem' || k === 'flaky') { U.oset[k] = k === 'strat' ? raw : !!v; }
        refreshCtl(); return;
      }
    }
    function onInput(e) {
      const t = e.target, id = t.id;
      if (id === 'lfKm') { stopPlay(); U.P.km = PLACES[+t.value][0]; const o = $('#lfKmOut'), s = $('#lfKmSub'); if (o) o.textContent = nf(U.P.km) + ' км'; if (s) s.textContent = `${PLACES[+t.value][1]} · +${nf(kmRtt(U.P.km))} мс на каждую поездку туда-обратно`; if (U.tab === 'load') drawLoad(); else if (U.tab === 'render') drawRender(); return; }
      if (id === 'lfJs') { stopPlay(); U.P.js = +t.value; const o = $('#lfJsOut'), s = $('#lfJsSub'); if (o) o.textContent = kbf(U.P.js); if (s) s.textContent = `телефон выполняет его ≈ ${sec1(U.P.js * CPU_JS)}`; if (U.tab === 'load') drawLoad(); else if (U.tab === 'render') drawRender(); return; }
      const sm = /^lfScrub(\d)$/.exec(id);
      if (sm) {
        stopPlay();
        const k = sm[1], v = +t.value, max = k === '1' ? U.max1 : k === '2' ? U.max2 : U.max3, tt = v >= 1000 ? null : v / 1000 * max;
        if (k === '1') setT1(tt); else if (k === '2') setT2(tt); else setT3(tt);
      }
    }

    /* ---------- сборка ---------- */
    EL.innerHTML = `<div class="lf"><div class="lf-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}<div class="seg lf-mode" role="group" aria-label="Как объяснять">${[['tech', 'Техника'], ['biz', 'Бизнес']].map(([k, t]) => `<button type="button" data-mode="${k}" aria-selected="${MODE === k}">${t}</button>`).join('')}</div></div><div class="lf-view" id="lfView"></div></div>`;
    EL.addEventListener('click', onClick); EL.addEventListener('input', onInput);
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (U.tab === 'bff' && U.alive) setT3(U.t3); }); }) : null;
    if (ro) ro.observe(EL);
    render();
    return {
      destroy() {
        U.alive = false; stopPlay(); timers.forEach(clearTimeout); timers.clear();
        EL.removeEventListener('click', onClick); EL.removeEventListener('input', onInput);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      },
      _U: U
    };
  }

  /* ================= регистрация ================= */
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'front', title: 'От экрана до сервера', lede: 'Водопад загрузки, SSR/CSR/SSG, BFF, кэш, офлайн',
    intro: 'Что происходит между нажатием на ссылку и готовым экраном. Водопад загрузки страницы с метриками TTFB, LCP, INP и CLS; три способа собрать каталог — SSR, CSR и SSG; карточка заказа из шести сервисов — напрямую или через BFF; кэш в браузере и приложении; офлайн-очередь в метро, конфликты и повторная отправка. Переключатель «Техника | Бизнес» переводит всё в секунды, заказы и рубли.',
    tasks: [
      { id: 'vitals', text: 'Покупатель во Владивостоке на 3G: LCP, INP и CLS — в зелёной зоне, TTFB — меньше секунды' },
      { id: 'robot', text: 'Посмотри страницу каталога глазами поискового робота при SSG, SSR и CSR' },
      { id: 'bff', text: 'Карточка заказа на 3G: сравни шесть вызовов из приложения с одним вызовом BFF' },
      { id: 'cache', text: 'Настрой кэш: после выкладки сразу новая версия, а повторный заход не качает JS' },
      { id: 'inval', text: 'Найди, почему счётчик корзины врёт, и почини инвалидацией кэша' },
      { id: 'conflict', text: 'Поменяй одно и то же на двух устройствах и реши конфликт слиянием' },
      { id: 'idem', text: 'Сеть мигнула при отправке — с ключом идемпотентности заказ не задвоился' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
  SD.labFront = { pageModel, renderModel, bffModel, cacheModel };
})();
