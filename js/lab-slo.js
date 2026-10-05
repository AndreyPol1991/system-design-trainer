/* Лаборатория «SLO и бюджет ошибок»: SLI (доля успешных и быстрых запросов), SLO за 30 дней и бюджет ошибок,
   сгорание бюджета по дням и политика заморозки, алерты по скорости сгорания (burn rate 14,4 / 6 / 1) против «алерта на каждый всплеск»,
   сравнение девяток в минутах простоя и цене надёжности. Переключатель «Техника | Бизнес» — как в «Таблице вживую».
   Префикс стилей .lo- (префикс .ls- занят ландшафтом). */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const mulberry = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const pc = (x, d) => { const v = x * 100; if (d != null) return dec(v, d).replace('-', '−') + ' %'; return ((v === 0 ? '0' : Math.abs(v) < 1 ? dec(v, 2) : Math.abs(v) < 10 ? dec(v, 1) : nf(v)) + ' %').replace(/^-/, '−'); };
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const p2 = n => String(n).padStart(2, '0');
  /* минуты по-человечески: 43 мин 12 с, 7 ч 12 мин, 3 дня 15 ч */
  const mins = m => { if (m < 0) return '−' + mins(-m); const s = Math.round(m * 60); if (s < 60) return s + ' с'; if (m < 10) { const mm = Math.floor(s / 60), ss = s % 60; return mm + ' мин' + (ss ? ' ' + ss + ' с' : ''); } if (m < 59.5) return Math.round(m) + ' мин'; const h = Math.floor(m / 60), r = Math.round(m % 60); if (h < 48) return h + ' ч' + (r ? ' ' + r + ' мин' : ''); const d = Math.floor(h / 24), hh = h % 24; return d + ' ' + plural(d, 'день', 'дня', 'дней') + (hh ? ' ' + hh + ' ч' : ''); };
  const rub = v => { const a = Math.abs(v); if (a >= 1e9) return dec(v / 1e9, 1) + ' млрд ₽'; if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 1) + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const SLOT = { 0.99: '99 %', 0.995: '99,5 %', 0.999: '99,9 %', 0.9995: '99,95 %', 0.9999: '99,99 %', 0.99999: '99,999 %' };
  const sloT = s => SLOT[s] || dec(s * 100, 3) + ' %';

  /* ---------- константы ---------- */
  const MONTH = 30 * 24 * 60; /* минут в окне 30 дней */
  const SLOS = [0.99, 0.995, 0.999, 0.9995, 0.9999];
  const budgetMin = s => (1 - s) * MONTH;
  const REQ_DAY = 1e6;
  const REVS = [[12e6, '12 млн ₽'], [120e6, '120 млн ₽'], [1.2e9, '1,2 млрд ₽']];
  const BIZ = { back: 0.3, engH: 3500, team: 8 };
  const rubMin = rev => rev / MONTH;

  /* ================= 1. минута жизни сервиса: 600 запросов ================= */
  const MINUTES = {
    norm: { n: 'Обычная минута', e5: 0.0006, e4: 0.02, mu: 4.6, sg: 0.45, tail: 0.01 },
    spike: { n: 'Минута со всплеском', e5: 0.03, e4: 0.02, mu: 4.6, sg: 0.45, tail: 0.01 },
    slow: { n: 'Медленная минута', e5: 0.004, e4: 0.02, mu: 5.3, sg: 0.5, tail: 0.04 }
  };
  function genMinute(kind, seed) {
    const M = MINUTES[kind], R = mulberry(seed);
    const g = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return Array.from({ length: 600 }, () => {
      const x = R(), st = x < M.e5 ? 5 : x < M.e5 + M.e4 ? 4 : 2;
      let ms = Math.exp(M.mu + M.sg * g()); if (R() < M.tail) ms *= 4 + R() * 6;
      return { st, ms: Math.round(Math.min(ms, 5000)) };
    });
  }
  function sliOf(reqs, thr) {
    const valid = reqs.filter(r => r.st !== 4), ok = valid.filter(r => r.st !== 5), fast = ok.filter(r => r.ms <= thr);
    const lat = ok.map(r => r.ms).sort((a, b) => a - b), p99 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))] : 0;
    return { all: reqs.length, valid: valid.length, c4: reqs.length - valid.length, c5: valid.length - ok.length, slow: ok.length - fast.length, good: fast.length, avail: ok.length / valid.length, speed: fast.length / ok.length, both: fast.length / valid.length, p99 };
  }

  /* ================= 2. бюджет по дням ================= */
  const KINDS = {
    blip: { n: 'Всплеск ошибок', d: '3 мин × 10 % запросов', len: 3, rate: 0.1 },
    release: { n: 'Плохой релиз', d: '20 мин × 30 % запросов', len: 20, rate: 0.3 },
    db: { n: 'Падение базы', d: '25 мин × 100 % запросов', len: 25, rate: 1 },
    slow: { n: 'Медленные ответы', d: '3 ч × 5 % медленнее порога', len: 180, rate: 0.05 }
  };
  const BG_RATE = 0.0001; /* фоновые ошибки: 0,01 % запросов всегда */
  const PRESETS_B = {
    calm: [['blip', 4], ['blip', 11], ['release', 17], ['blip', 24]],
    hard: [['release', 3], ['blip', 6], ['slow', 9], ['db', 13], ['blip', 16], ['release', 21], ['blip', 26]]
  };
  const costMin = k => KINDS[k].len * KINDS[k].rate;
  /* остаток бюджета по дням: [0..30], доля от бюджета (может уйти ниже нуля) */
  function burnDown(incs, slo) {
    const B = budgetMin(slo), bgDay = BG_RATE * 1440, out = [1];
    let used = 0;
    for (let d = 1; d <= 30; d++) { used += bgDay; incs.filter(x => x.day === d).forEach(x => { used += costMin(x.k); }); out.push(1 - used / B); }
    return { rem: out, used, B, freeze: out.findIndex(v => v <= 0) };
  }
  const POLICY = [
    { min: 0.5, k: 'ok', n: 'Больше половины', t: 'Релизы как обычно, можно рисковать: эксперименты, крупные переезды.', b: 'Работаем в обычном темпе, новые функции выходят по плану.' },
    { min: 0.25, k: 'warn', n: '25–50 %', t: 'Релизы только через канарейку, крупные изменения — с планом отката, разбор каждого инцидента.', b: 'Функции выходят, но осторожнее: часть времени команды — на причины сбоев.' },
    { min: 0, k: 'warn', n: '0–25 %', t: 'Только важные релизы, половина команды — на надёжность, ревью изменений строже.', b: 'Половина команды чинит надёжность, новые функции сдвигаются.' },
    { min: -Infinity, k: 'bad', n: 'Бюджет кончился', t: 'Заморозка фич до конца окна: выходят только исправления надёжности и безопасности. Решение заранее подписано продуктом и разработкой.', b: 'Заморозка: новые функции ждут, вся команда чинит надёжность. Так договорились заранее — без споров в моменте.' }
  ];
  const policyOf = rem => POLICY.find(p => rem > p.min) || POLICY[3];

  /* ================= 3. неделя ошибок и алерты ================= */
  const WEEK = 7 * 1440, DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const INC = [
    { k: 'A', n: 'Падение после релиза', s: 1 * 1440 + 14 * 60 + 20, len: 30, rate: 0.2, d: 'новая версия отдаёт 500 на каждый пятый запрос' },
    { k: 'B', n: 'Деградация кэша', s: 2 * 1440 + 2 * 60, len: 600, rate: 0.008, d: 'кэш перезапустился, база не справляется с частью запросов' },
    { k: 'C', n: 'Медленная утечка', s: 3 * 1440 + 8 * 60, len: 60 * 60, rate: 0.004, d: 'у одного партнёра истёк сертификат, его запросы падают' },
    { k: 'E', n: 'Сбой балансировщика', s: 5 * 1440 + 23 * 60 + 10, len: 4, rate: 1, d: 'балансировщик перезапустился с ошибкой в конфиге' }
  ];
  INC.forEach(x => { x.e = x.s + x.len; x.cost = x.len * x.rate; x.burn = x.rate / 0.001; });
  const RULES = [
    { k: 'r1', n: 'Burn rate 14,4 за 1 ч', sub: 'и за 5 мин', long: 60, short: 5, thr: 14.4, page: true },
    { k: 'r6', n: 'Burn rate 6 за 6 ч', sub: 'и за 30 мин', long: 360, short: 30, thr: 6, page: true },
    { k: 'r3', n: 'Burn rate 1 за 3 дня', sub: 'и за 6 ч → тикет', long: 4320, short: 360, thr: 1, page: false }
  ];
  const NAIVE = [0.005, 0.01, 0.02, 0.05];
  let WK = null;
  function week() {
    if (WK) return WK;
    const R = mulberry(77), err = new Float32Array(WEEK), blips = [];
    for (let t = 0; t < WEEK; t++) err[t] = 0.0002 + R() * 0.0004;
    const busy = t => INC.some(x => t >= x.s - 30 && t <= x.e + 30);
    while (blips.length < 26) {
      const s = Math.floor(R() * (WEEK - 10)), len = 1 + Math.floor(R() * 3), rate = 0.02 + R() * 0.06;
      if (busy(s) || blips.some(b => Math.abs(b.s - s) < 90)) continue;
      blips.push({ s, len, rate }); for (let t = s; t < s + len; t++) err[t] += rate;
    }
    INC.forEach(x => { for (let t = x.s; t < x.e && t < WEEK; t++) err[t] += x.rate; });
    for (let t = 0; t < WEEK; t++) err[t] = Math.min(1, err[t]);
    const P = new Float64Array(WEEK + 1); for (let t = 0; t < WEEK; t++) P[t + 1] = P[t] + err[t];
    const sum = (a, b) => { /* сумма ошибок за минуты [a, b), до начала недели — обычный фон 0,04 % */ const pre = a < 0 ? Math.min(-a, b - a) * 0.0004 : 0; return pre + P[Math.max(0, b)] - P[Math.max(0, a)]; };
    const avg = (t, w) => sum(t + 1 - w, t + 1) / w;
    WK = { err, blips, avg };
    return WK;
  }
  /* эпизоды срабатывания: пока условие держится; разрыв короче gap минут — тот же эпизод */
  function episodes(fire, gap) {
    const out = []; let cur = null, last = -1e9;
    for (let t = 0; t < WEEK; t++) {
      if (!fire(t)) continue;
      if (cur && t - last <= gap) cur.e = t; else { cur = { s: t, e: t }; out.push(cur); }
      last = t;
    }
    return out;
  }
  const incAt = t => INC.find(x => t >= x.s && t <= x.e + 60) || null;
  const night = t => (t % 1440) < 7 * 60;
  function alerts(cfg) {
    const W = week(), res = { rows: [], pages: [], tickets: [], det: {} };
    const fireR = r => t => W.avg(t, r.long) >= r.thr * 0.001 && W.avg(t, r.short) >= r.thr * 0.001;
    const tag = list => list.map(e => ({ s: e.s, e: e.e, inc: incAt(e.s) }));
    if (cfg.naive) { const ep = tag(episodes(t => W.err[t] > cfg.thr, 10)); res.rows.push({ k: 'naive', n: `Алерт на всплеск > ${pc(cfg.thr)}`, sub: 'за 1 мин', ep, page: true }); res.pages.push(...ep.map(e => Object.assign({ by: 'naive' }, e))); }
    const pg = RULES.filter(r => r.page && cfg[r.k]);
    RULES.forEach(r => { if (cfg[r.k]) res.rows.push({ k: r.k, n: r.n, sub: r.sub, ep: tag(episodes(fireR(r), 30)), page: r.page }); });
    if (pg.length) { const f = pg.map(fireR); res.pages.push(...tag(episodes(t => f.some(g => g(t)), 30)).map(e => Object.assign({ by: 'burn' }, e))); }
    if (cfg.r3) res.tickets.push(...res.rows.find(r => r.k === 'r3').ep);
    INC.forEach(x => {
      const d = {};
      res.rows.forEach(r => { const e = r.ep.find(q => q.inc === x); d[r.k] = e ? e.s - x.s : null; });
      const all = [...res.pages, ...res.tickets].filter(e => e.inc === x).map(e => e.s - x.s);
      d.first = all.length ? Math.min(...all) : null; d.missed = !all.length;
      res.det[x.k] = d;
    });
    res.nPages = res.pages.length; res.nNight = res.pages.filter(e => night(e.s)).length; res.nFalse = res.pages.filter(e => !e.inc).length;
    res.missed = INC.filter(x => res.det[x.k].missed);
    return res;
  }
  const wkTime = t => `${DAYS[Math.floor(t / 1440) % 7]} ${p2(Math.floor((t % 1440) / 60))}:${p2(t % 60)}`;

  /* ================= 4. девятки ================= */
  const NINES = [
    { s: 0.99, n: '99 %', cost: 150e3, eng: 10, need: 'Один сервер, ручной перезапуск, ежедневные бэкапы. Сбой ночью чинят утром.', life: 'Можно лежать целый рабочий день в месяц.' },
    { s: 0.995, n: '99,5 %', cost: 250e3, eng: 30, need: 'Две копии приложения за балансировщиком, мониторинг, дежурный в рабочее время.', life: 'Полдня простоя в месяц.' },
    { s: 0.999, n: '99,9 %', cost: 450e3, eng: 80, need: 'Реплика базы с автоматическим переключением, rolling и канарейки, дежурный 24/7 с реакцией 15 минут.', life: 'Один сериал в месяц: 43 минуты.' },
    { s: 0.9995, n: '99,95 %', cost: 560e3, eng: 140, need: 'Две зоны доступности, автоматический откат релизов, отрепетированные инструкции на сбои.', life: '22 минуты в месяц — одна встреча.' },
    { s: 0.9999, n: '99,99 %', cost: 1.4e6, eng: 400, need: 'Человек не успевает даже проснуться: всё автоматически — несколько регионов, active-active, хаос-тесты, ни одной единой точки отказа.', life: '4 минуты в месяц — сварить яйцо.' },
    { s: 0.99999, n: '99,999 %', cost: 4e6, eng: 1000, need: 'Уровень телефонных станций и ядра платёжных систем: особая архитектура и годы инженерной работы.', life: '26 секунд в месяц.' }
  ];
  const DEPS = [['База данных', 0.9995], ['Платёжный провайдер', 0.999], ['Кэш', 0.999], ['Сервис доставки', 0.999]];
  function ninesBiz(rev) {
    const f = Math.pow(rev / 120e6, 0.4);
    return NINES.map(x => { const down = budgetMin(x.s), loss = down * rubMin(rev) * (1 - BIZ.back), cost = x.cost * f; return { x, down, loss, cost, eng: x.eng, total: loss + cost }; });
  }

  /* ================= тексты ================= */
  const ana = (life, plain, term) => `<div class="lo-ana"><p class="lo-life"><span class="lo-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="lo-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const LIFE = {
    sli: ['Автобус по расписанию. Перевозчик обещает: 999 рейсов из 1000 придут вовремя. Сколько рейсов реально пришли вовремя — это измерение; «999 из 1000» — обещание; а одно опоздание из тысячи — запас, который можно «потратить» за месяц.',
      'Сначала решаем, что для пользователя значит «сервис работает»: например, «страница открылась без ошибки и быстрее 300 мс». Считаем долю таких запросов. Обещаем, какой эта доля будет за месяц. Всё, что не дотягивает до 100 %, — разрешённый запас на сбои.',
      '<b>SLI</b> (service level indicator) — измерение: хорошие запросы / все запросы. <b>SLO</b> (objective) — цель для SLI за окно, обычно скользящие 30 дней: например, 99,9 %. <b>Бюджет ошибок</b> = 1 − SLO — сколько плохих запросов или минут можно себе позволить. <b>SLA</b> — договор с клиентом и компенсацией, его ставят мягче SLO. Ошибки клиента (4xx) в SLI обычно не считают.'],
    budget: ['Лимит мобильного интернета: 30 ГБ на месяц. Посмотрел сериал в первый день — к середине месяца лимит кончился, дальше только мессенджеры. Ровный расход — по гигабайту в день.',
      'Каждый сбой съедает часть разрешённого запаса. Кончился запас раньше конца месяца — новые функции ждут, команда чинит надёжность. Правило договорено заранее, чтобы не спорить в момент аварии.',
      '<b>Сгорание бюджета</b> (burn-down) — сколько бюджета осталось к каждому дню окна. <b>Скорость сгорания</b> (burn rate) = доля ошибок / (1 − SLO): при 1 бюджет кончится ровно к концу 30 дней, при 10 — за 3 дня, при 1000 — за 43 минуты. <b>Политика бюджета</b> (error budget policy) — что делаем на каждом уровне остатка, вплоть до заморозки фич.'],
    alerts: ['Пожарная сигнализация, которая воет от каждого подгоревшего тоста: через неделю её выдёргивают из розетки — и настоящий пожар уже никто не услышит. А медленную утечку газа она не замечает вовсе.',
      'Будить человека стоит, только когда сбой быстро съедает бюджет. Короткий всплеск, который съел крошку бюджета, подождёт до утра. Медленная утечка, которая за три дня съест треть, — повод для задачи днём, а не для будильника ночью.',
      '<b>Алерты по скорости сгорания</b> (multi-window burn rate, книга Google SRE Workbook): будим (page), если за 1 час сгорело 2 % месячного бюджета — burn rate 14,4, или за 6 часов 5 % — burn rate 6; заводим тикет, если за 3 дня сгорело 10 % — burn rate 1. Второе, короткое окно (5 мин, 30 мин, 6 ч) гасит алерт, как только сбой закончился.'],
    nines: ['Замки на двери. Первый замок дешёвый и отпугивает почти всех. Второй — заметно дороже. Пятый стоит как сама квартира, а вор и так давно не лезет.',
      'Каждая девятка уменьшает разрешённый простой в 10 раз, а стоит в разы дороже предыдущей. Нужна та, после которой лишние деньги на надёжность уже не окупаются потерями от простоя.',
      '<b>Девятки</b> — запись доступности: 99,9 % — «три девятки». Простой в месяц = (1 − SLO) × 30 × 24 × 60 мин. SLO не может быть выше, чем у обязательных зависимостей вместе: 99,9 % × 99,9 % ≈ 99,8 %. 100 % — неправильная цель: её не достичь, и она запрещает любые изменения.']
  };
  const MEMO = [
    ['SLI и SLO', ['SLI — доля хороших запросов глазами пользователя: успешно и быстрее порога.', 'SLO — цель за скользящие 30 дней; бюджет ошибок = 1 − SLO.', '99,9 % за 30 дней — 43 минуты, или 1 плохой запрос из 1 000.', 'Ошибки клиента (4xx) в SLI не считают; задержку меряют по p99, а не по среднему.']],
    ['Бюджет и политика', ['Бюджет — не враг, а разрешение рисковать: пока он есть, выкатываем смело.', 'Кончился — заморозка фич до восстановления, только надёжность. Правило подписано заранее.', 'Фоновые ошибки тоже едят бюджет: при 99,99 % их одних может хватить.']],
    ['Алерты', ['Будим по скорости сгорания: 14,4 за час и 6 за 6 часов; burn rate 1 за 3 дня — тикет.', 'Короткое окно гасит алерт после конца сбоя.', 'Алерт на каждый всплеск будит зря и всё равно пропускает медленные утечки.']],
    ['Девятки', ['Каждая девятка — простой в 10 раз меньше и цена в разы больше.', 'На 99,99 % человек не успевает среагировать — только автоматика.', 'Своё SLO не выше, чем у зависимостей вместе.']]
  ];
  const MEMO_BIZ = [
    ['Обещание клиентам', ['SLO — это обещание, сколько магазин может «лежать»: 99,9 % — 43 минуты в месяц.', 'Бюджет ошибок — разрешённый риск: пока он есть, новые функции выходят быстро.']],
    ['Деньги и люди', ['Минута простоя стоит выручки этой минуты; лишняя девятка — серверов и дежурств.', 'Правильная девятка — где сумма потерь и цены надёжности минимальна, и она зависит от размера бизнеса.', 'Будильник по каждому всплеску сжигает часы инженеров и всё равно пропускает тихие утечки.']],
    ['Решения', ['Заморозка фич при пустом бюджете — заранее согласованное правило продукта и разработки.', 'Надёжность — продуктовая характеристика: её выбирают, а не «делают максимальной».']]
  ];

  /* ================= экземпляр лаборатории ================= */
  const MODE_KEY = 'amp-stroyka-lo-mode';
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
  const TABS = [['sli', '1', 'SLI и SLO'], ['budget', '2', 'Бюджет по дням'], ['alerts', '3', 'Алерты'], ['nines', '4', 'Девятки'], ['memo', '✓', 'Итоги']];

  function makeLab(EL, doneFn) {
    let MODE = readMode();
    const U = {
      tab: 'sli', slo: 0.99, minute: 'norm', mseed: 5, thr: 300, sorted: false, quiz: '', quizOk: null,
      incs: [], day: 13, cursor: 30, btimer: 0,
      cfg: { naive: true, thr: 0.01, r1: false, r6: false, r3: false }, inc: null,
      nine: null, seen: new Set(), rev: 120e6, pick: null, alive: true
    };
    const done = id => { try { doneFn(id); } catch (e) { /* задания не засчитываются — не страшно */ } };
    const isBiz = () => MODE === 'biz';
    const $ = s => EL.querySelector(s);
    const seg = (name, items, cur, cls) => `<div class="seg lo-seg ${cls || ''}" role="group" aria-label="${esc(name)}">${items.map(([v, t]) => `<button type="button" data-set="${name}:${v}" aria-selected="${String(v) === String(cur)}">${t}</button>`).join('')}</div>`;
    const tile = (label, val, sub, cls) => `<div class="lo-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const sloSeg = () => seg('slo', SLOS.map(s => [s, sloT(s)]), U.slo);

    /* ---------- вкладка 1: SLI и SLO ---------- */
    function sliHTML() {
      const B = isBiz(), reqs = genMinute(U.minute, U.mseed), S = sliOf(reqs, U.thr);
      const cls = r => r.st === 4 ? 'c' : r.st === 5 ? 'e' : r.ms > U.thr ? 's' : 'g';
      const order = { g: 0, s: 1, e: 2, c: 3 };
      const list = U.sorted ? reqs.slice().sort((a, b) => order[cls(a)] - order[cls(b)]) : reqs;
      const L = LIFE.sli, bm = budgetMin(U.slo);
      let h = ana(L[0], L[1], B ? '' : L[2]);
      h += `<div class="lo-sli"><div class="lo-minute">
          <div class="lo-mhead"><b class="lo-h">${B ? 'Минута магазина: 600 действий покупателей' : 'Минута жизни сервиса: 600 запросов'}</b>${seg('minute', Object.entries(MINUTES).map(([k, m]) => [k, m.n]), U.minute)}</div>
          <div class="lo-ctl"><b>${B ? 'Сколько покупатель готов ждать' : 'Порог «быстро» для SLI задержки'}</b>${seg('thr', [100, 200, 300, 500, 1000].map(v => [v, v + ' мс']), U.thr)}</div>
          <div class="lo-grid${U.sorted ? ' sorted' : ''}" role="img" aria-label="600 запросов за минуту: хорошие, медленные, ошибки сервера и ошибки клиента">${list.map(r => `<i class="${cls(r)}" title="${r.st === 5 ? '500' : r.st === 4 ? '404' : '200'} · ${r.ms} мс"></i>`).join('')}</div>
          <div class="lo-legend"><span><i class="g"></i>${B ? 'всё хорошо' : 'успешно и быстро'} · ${S.good}</span><span><i class="s"></i>${B ? 'открылось, но долго' : 'успешно, но медленнее порога'} · ${S.slow}</span><span><i class="e"></i>${B ? 'ошибка магазина' : 'ошибка сервера 5xx'} · ${S.c5}</span><span><i class="c"></i>${B ? 'ошибка покупателя (неверный промокод)' : 'ошибка клиента 4xx — не считаем'} · ${S.c4}</span></div>
          <div class="lo-btns"><button type="button" class="btn" data-act="sort">${U.sorted ? 'Вернуть по времени' : 'Разложить по видам'}</button><button type="button" class="btn ghost" data-act="reroll">Другая минута</button></div></div>
        <div class="lo-side">
          ${tile(B ? 'Без ошибки' : 'SLI доступности', pc(S.avail, 2), `${S.valid - S.c5} из ${S.valid} (без ${S.c4} ошибок клиента)`, S.avail >= U.slo ? 'ok' : 'bad')}
          ${tile(B ? 'Быстрее ' + U.thr + ' мс' : 'SLI задержки', pc(S.speed, 2), `${S.good} из ${S.valid - S.c5} успешных быстрее ${U.thr} мс · цель 99 %`, S.speed >= 0.99 ? 'ok' : 'bad')}
          ${tile(B ? 'Самые медленные 1 %' : 'p99', nf(S.p99) + ' мс', B ? '99 покупателей из 100 ждут меньше' : '99 % успешных запросов быстрее', S.p99 > U.thr ? 'warn' : 'ok')}
          ${(() => { const bad = 1 - S.avail, br = bad / (1 - U.slo), lb = (1 - S.speed) / 0.01; const k = Math.max(br, lb) <= 1 ? 'ok' : Math.max(br, lb) <= 6 ? 'warn' : 'bad'; return `<div class="lo-card ${k}"><b>${B ? 'Если весь месяц будет как эта минута' : 'Если весь месяц будет как эта минута — burn rate'}.</b> ${B ? 'Ошибок' : 'Доступность'}: ${pc(bad, 2)} при запасе ${pc(1 - U.slo, 2)} → ${B ? 'запас тратится в' : 'burn rate'} <b>${dec(br, 1)}</b>${B ? ' раза быстрее ровного' : ''}: ${br <= 1 ? 'бюджет доживёт до конца месяца' : `бюджет ${sloT(U.slo)} кончится за ${mins(MONTH / br)}`}. ${B ? 'Медленных' : 'Задержка'}: ${pc(1 - S.speed, 2)} при цели «99 % быстрее ${U.thr} мс» → <b>${dec(lb, 1)}</b>${lb <= 1 ? ' — в норме' : ' — цель не держится'}. ${U.minute === 'slow' ? 'Сервис не падал, но покупатели ждали — SLI задержки ловит то, чего не видит доступность.' : U.minute === 'spike' ? 'Всплеск ошибок — так выглядит начало инцидента: такой темп сжигает месячный бюджет за часы.' : ''}</div>`; })()}
        </div></div>`;
      h += `<b class="lo-h">${B ? 'Обещание: сколько магазин может «лежать» за 30 дней' : 'SLO и бюджет ошибок за 30 дней'}</b>${sloSeg()}
        <div class="lo-kpis">${tile('Бюджет в месяц', mins(bm), `${B ? 'магазин может лежать' : 'полного простоя'} за 30 дней`, '')}${tile('В неделю', mins(bm / 30 * 7), 'если тратить ровно', '')}${tile('В день', mins(bm / 30), 'если тратить ровно', '')}${tile('В запросах', nf((1 - U.slo) * REQ_DAY * 30), `плохих из ${nf(REQ_DAY * 30)} за месяц (1 млн в день)`, '')}</div>
        <pre class="lo-code">бюджет = (1 − ${dec(U.slo * 100, U.slo >= 0.9995 ? 2 : 1).replace(/,0$/, '')} %) × 30 дней × 24 ч × 60 мин
       = ${dec((1 - U.slo) * 100, 2)} % × 43 200 мин = ${dec(bm, bm < 10 ? 2 : 1)} мин ≈ ${mins(bm)}</pre>
        ${B ? `<div class="lo-card biz"><b>В деньгах.</b> Магазин с выручкой ${rub(U.rev)} в месяц теряет ≈ <b>${rub(rubMin(U.rev))}</b> за минуту простоя. Весь бюджет ${sloT(U.slo)} — это ${mins(bm)}, или до ${rub(bm * rubMin(U.rev) * (1 - BIZ.back))} потерянной выручки, если сжечь его целиком (часть покупателей вернётся позже).</div>` : ''}
        <div class="lo-quiz ${U.quizOk === true ? 'ok' : U.quizOk === false ? 'bad' : ''}"><label for="loQuiz"><b>Проверь себя.</b> SLO 99,9 % за 30 дней — сколько минут можно быть недоступным?</label><div class="lo-btns"><input id="loQuiz" class="lab-input" inputmode="decimal" autocomplete="off" placeholder="минут" value="${esc(U.quiz)}"><button type="button" class="btn primary" data-act="quiz">Проверить</button></div>${U.quizOk === true ? '<p>Верно: 0,1 % × 43 200 мин = 43,2 мин. Запомни пару: <b>99,9 % — 43 минуты, 99,99 % — 4 минуты</b>.</p>' : U.quizOk === false ? '<p>Не то. Подсказка: 30 дней = 43 200 минут, а 99,9 % оставляет на ошибки 0,1 %.</p>' : ''}</div>`;
      return h;
    }

    /* ---------- вкладка 2: бюджет по дням ---------- */
    function budgetChart(W, bd) {
      const H = 270, ml = 54, mr = 14, mt = 14, mb = 26, iw = W - ml - mr, ih = H - mt - mb;
      const lo = Math.max(-1, Math.min(-0.2, Math.floor((Math.min(...bd.rem) - 0.05) * 4) / 4));
      const X = d => ml + iw * d / 30, Y = v => mt + ih * (1 - (Math.max(lo, v) - lo) / (1 - lo));
      const cur = U.cursor;
      let h = `<svg class="lo-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Остаток бюджета ошибок по дням">`;
      h += `<rect class="lo-redzone" x="${ml}" y="${Y(0)}" width="${iw}" height="${(Y(lo) - Y(0)).toFixed(1)}"/>`;
      const ticks = [1, 0.5, 0]; for (let v = -0.5; v >= lo; v -= 0.5) ticks.push(v);
      ticks.forEach(v => { h += `<line class="lo-grid ${v === 0 ? 'zero' : ''}" x1="${ml}" x2="${W - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="lo-ax" x="${ml - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${pc(v)}</text>`; });
      for (let d = 0; d <= 30; d += 5) h += `<text class="lo-ax" x="${X(d).toFixed(1)}" y="${H - 8}" text-anchor="${d === 30 ? 'end' : d ? 'middle' : 'start'}">${d ? 'день ' + d : 'день 0'}</text>`;
      h += `<line class="lo-ideal" x1="${X(0)}" y1="${Y(1)}" x2="${X(30)}" y2="${Y(0)}"/><text class="lo-idealt" x="${X(30) - 4}" y="${(Y(0) - 8).toFixed(1)}" text-anchor="end">ровный расход</text>`;
      let d0 = `M${X(0)} ${Y(1)}`; for (let d = 1; d <= cur; d++) d0 += ` L${X(d).toFixed(1)} ${Y(bd.rem[d]).toFixed(1)}`;
      const zy = Y(0).toFixed(1), area = `${d0} L${X(cur).toFixed(1)} ${zy} L${X(0)} ${zy} Z`;
      h += `<defs><clipPath id="loClipUp"><rect x="0" y="0" width="${W}" height="${zy}"/></clipPath><clipPath id="loClipDn"><rect x="0" y="${zy}" width="${W}" height="${H}"/></clipPath></defs>`
        + `<path class="lo-area" clip-path="url(#loClipUp)" d="${area}"/><path class="lo-area bad" clip-path="url(#loClipDn)" d="${area}"/><path class="lo-rem" clip-path="url(#loClipUp)" d="${d0}"/><path class="lo-rem bad" clip-path="url(#loClipDn)" d="${d0}"/>`;
      U.incs.filter(x => x.day <= cur).forEach(x => { const k = KINDS[x.k]; h += `<g class="lo-incm ${x.k}"><line x1="${X(x.day).toFixed(1)}" x2="${X(x.day).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/><circle cx="${X(x.day).toFixed(1)}" cy="${(Y(bd.rem[x.day]) ).toFixed(1)}" r="4"/></g>`; void k; });
      if (bd.freeze > 0 && bd.freeze <= cur) h += `<line class="lo-frz" x1="${X(bd.freeze).toFixed(1)}" x2="${X(bd.freeze).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/><text class="lo-frzt" x="${(X(bd.freeze) + 6).toFixed(1)}" y="${mt + 14}">заморозка с дня ${bd.freeze}</text>`;
      if (cur < 30) h += `<line class="lo-cur" x1="${X(cur).toFixed(1)}" x2="${X(cur).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/>`;
      return h + '</svg>';
    }
    function budgetHTML() {
      const B = isBiz(), L = LIFE.budget, bd = burnDown(U.incs, U.slo), rem = bd.rem[U.cursor], pol = policyOf(rem);
      if (bd.freeze > 0) done('freeze');
      let h = ana(L[0], L[1], B ? '' : L[2]);
      const big = U.incs.length ? U.incs.reduce((a, x) => costMin(x.k) > costMin(a.k) ? x : a) : null;
      h += `<div class="lo-bwork"><div class="lo-panel">
          <div class="lo-ctl"><b>SLO</b>${sloSeg()}<small class="lo-sub">бюджет ${mins(bd.B)} за 30 дней; фоновые ошибки 0,01 % съедают ${mins(BG_RATE * 1440)} в день</small></div>
          <div class="lo-ctl"><div class="lo-rl"><span>День инцидента</span><output id="loDayOut">${U.day}</output></div><input type="range" class="lo-range" id="loDay" min="1" max="30" value="${U.day}" aria-label="День инцидента"></div>
          <div class="lo-addinc">${Object.entries(KINDS).map(([k, x]) => `<button type="button" class="btn" data-add="${k}"><b>+ ${x.n}</b><small>${x.d} = ${mins(costMin(k))} · ${pc(costMin(k) / bd.B)} бюджета</small></button>`).join('')}</div>
          <div class="lo-btns"><button type="button" class="btn" data-preset="calm">Спокойный месяц</button><button type="button" class="btn" data-preset="hard">Тяжёлый месяц</button><button type="button" class="btn ghost" data-act="clear" ${U.incs.length ? '' : 'disabled'}>Очистить</button></div>
          ${U.incs.length ? `<ul class="lo-inclist">${U.incs.slice().sort((a, b) => a.day - b.day).map(x => `<li><span>день ${x.day}</span><b>${KINDS[x.k].n}</b><span>−${pc(costMin(x.k) / bd.B)}</span><button type="button" class="lo-x" data-del="${x.id}" aria-label="Убрать инцидент">×</button></li>`).join('')}</ul>` : '<p class="lo-sub">Инцидентов нет — бюджет тратят только фоновые ошибки. Добавь сбои кнопками выше.</p>'}
        </div><div class="lo-bstage">
          <div class="lo-chartbox" id="loBChart">${budgetChart(Math.max(360, ($('#loBChart') || {}).clientWidth || 620), bd)}</div>
          <div class="lo-btns"><button type="button" class="btn primary" data-act="play">▶ Прожить месяц по дням</button><span class="lo-sub">${U.cursor < 30 ? 'день ' + U.cursor + ' из 30' : ''}</span></div>
          <div class="lo-kpis">${tile('Сожжено за 30 дней', mins(bd.used), `${pc(bd.used / bd.B)} бюджета ${mins(bd.B)}`, bd.used > bd.B ? 'bad' : bd.used > bd.B / 2 ? 'warn' : 'ok')}${tile(`Осталось на день ${U.cursor}`, pc(rem), rem > 0 ? mins(rem * bd.B) : 'бюджета нет', rem <= 0 ? 'bad' : rem < 0.25 ? 'warn' : 'ok')}${big ? tile('Самый дорогой сбой', KINDS[big.k].n, `${pc(costMin(big.k) / bd.B)} бюджета · burn rate ${nf(KINDS[big.k].rate / (1 - U.slo))}`, '') : ''}${B ? tile('Потеряно выручки', rub(bd.used * rubMin(U.rev) * (1 - BIZ.back)), `магазин ${rub(U.rev)} в месяц`, bd.used ? 'warn' : '') : ''}</div>
          <div class="lo-policy"><b class="lo-h">${B ? 'Что делаем при таком остатке' : 'Политика бюджета ошибок'}</b>${POLICY.map(p => `<div class="lo-pol ${p === pol ? 'on ' + p.k : ''}"><span>${p.n}</span><p>${B ? p.b : p.t}</p></div>`).join('')}</div>
          ${bd.freeze > 0 ? `<div class="lo-card bad"><b>День ${bd.freeze}: бюджет кончился — заморозка фич на ${30 - bd.freeze + 1} ${plural(30 - bd.freeze + 1, 'день', 'дня', 'дней')}.</b> ${B ? `Команда из ${BIZ.team} разработчиков ≈ ${nf((30 - bd.freeze + 1) * 5 / 7 * BIZ.team * 8)} часов работает на надёжность вместо новых функций — это ≈ ${rub((30 - bd.freeze + 1) * 5 / 7 * BIZ.team * 8 * BIZ.engH)} зарплаты, отложенные запуски и маркетинг.` : 'Выходят только исправления надёжности и безопасности. Окно скользящее: бюджет вернётся, когда старые сбои выпадут из последних 30 дней.'}</div>` : ''}
        </div></div>`;
      return h;
    }
    function playMonth() {
      if (U.btimer) clearInterval(U.btimer);
      if (isCalm()) { U.cursor = 30; render(); return; }
      U.cursor = 0; render();
      U.btimer = setInterval(() => { if (!U.alive) { clearInterval(U.btimer); return; } U.cursor++; if (U.cursor >= 30) { U.cursor = 30; clearInterval(U.btimer); U.btimer = 0; } const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0; render(); if (box) box.scrollTop = y; }, 90);
    }

    /* ---------- вкладка 3: алерты ---------- */
    function alertChart(W, A) {
      const wk = week(), lw = 176, mr = 12, mt = 22, ch = 150, rowH = 30, rows = [{ k: 'naive' }, ...RULES], H = mt + ch + 22 + rows.length * rowH + 4;
      const iw = W - lw - mr, X = t => lw + iw * t / WEEK, top = 0.03, Y = v => mt + ch * (1 - Math.min(1, v / top));
      let h = `<svg class="lo-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Неделя ошибок и срабатывания алертов">`;
      for (let d = 0; d < 7; d++) h += `<rect class="lo-night" x="${X(d * 1440).toFixed(1)}" y="${mt}" width="${(iw * 420 / WEEK).toFixed(1)}" height="${H - mt - 4}"/>`;
      INC.forEach(x => { const on = U.inc === x.k; h += `<g class="lo-incband ${on ? 'on' : ''}" data-inc="${x.k}"><rect x="${X(x.s).toFixed(1)}" y="${mt}" width="${Math.max(6, X(x.e) - X(x.s)).toFixed(1)}" height="${ch}"/><text x="${(X(x.s) + 3).toFixed(1)}" y="${mt - 6}">${x.k}</text></g>`; });
      [0, 0.01, 0.02, 0.03].forEach(v => { h += `<line class="lo-grid" x1="${lw}" x2="${W - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="lo-ax" x="${lw - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${pc(v)}</text>`; });
      h += `<text class="lo-ax" x="8" y="${mt + 14}">ошибок, %</text><text class="lo-ax" x="8" y="${mt + 30}">(макс. за 10 мин)</text>`;
      if (U.cfg.naive) h += `<line class="lo-thr" x1="${lw}" x2="${W - mr}" y1="${Y(U.cfg.thr).toFixed(1)}" y2="${Y(U.cfg.thr).toFixed(1)}"/>`;
      let d = ''; for (let i = 0; i < WEEK; i += 10) { let m = 0; for (let j = i; j < i + 10; j++) m = Math.max(m, wk.err[j]); d += `${i ? ' L' : 'M'}${X(i + 5).toFixed(1)} ${Y(m).toFixed(1)}`; }
      h += `<path class="lo-errline" d="${d}"/>`;
      for (let dd = 0; dd < 7; dd++) h += `<text class="lo-ax" x="${X(dd * 1440 + 720).toFixed(1)}" y="${mt + ch + 16}" text-anchor="middle">${DAYS[dd]}</text>`;
      rows.forEach((r, i) => {
        const y = mt + ch + 26 + i * rowH, row = A.rows.find(q => q.k === r.k), on = !!row;
        const name = r.k === 'naive' ? `Всплеск > ${pc(U.cfg.thr)}` : r.n;
        h += `<line class="lo-rowline" x1="${lw}" x2="${W - mr}" y1="${y + rowH / 2}" y2="${y + rowH / 2}"/><text class="lo-rowt ${on ? '' : 'off'}" x="8" y="${y + rowH / 2 + 4}">${esc(name)}${on ? '' : ' · выкл.'}</text>`;
        if (row) row.ep.forEach(e => { const x = X(e.s); h += `<rect class="lo-tick ${e.inc ? 'hit' : 'false'} ${row.page ? '' : 'ticket'}" x="${(x - 3).toFixed(1)}" y="${y + 6}" width="${Math.max(6, X(e.e) - x + 6).toFixed(1)}" height="${rowH - 12}" rx="3"><title>${wkTime(e.s)} — ${e.inc ? e.inc.n : 'ложная тревога'}</title></rect>`; });
      });
      return h + '</svg>';
    }
    function alertsHTML() {
      const B = isBiz(), L = LIFE.alerts, A = alerts(U.cfg), c = U.cfg;
      if (A.missed.length === 0 && A.nPages <= 4) done('quiet');
      let h = ana(L[0], L[1], B ? '' : L[2]);
      h += `<div class="lo-card info"><b>Откуда 14,4 и 6.</b> За 30 дней 720 часов. Сжечь 2 % бюджета за 1 час — значит гореть в 2 % × 720 / 1 = <b>14,4</b> раза быстрее ровного расхода. 5 % за 6 часов: 5 % × 720 / 6 = <b>6</b>. 10 % за 3 дня: 10 % × 720 / 72 = <b>1</b>. При SLO 99,9 % burn rate 14,4 — это 1,44 % ошибок, 6 — 0,6 %, 1 — 0,1 %.</div>`;
      h += `<div class="lo-acfg"><div class="lo-ctl"><label class="lo-chk"><input type="checkbox" data-cfg="naive" ${c.naive ? 'checked' : ''}> <b>Алерт на каждый всплеск</b></label>${seg('nthr', NAIVE.map(v => [v, '> ' + pc(v)]), c.thr)}<small class="lo-sub">будит, если за минуту ошибок больше порога</small></div>
        <div class="lo-ctl"><b>Алерты по скорости сгорания (SLO 99,9 %)</b>${RULES.map(r => `<label class="lo-chk"><input type="checkbox" data-cfg="${r.k}" ${c[r.k] ? 'checked' : ''}> ${r.n} <small>${r.sub}</small></label>`).join('')}</div></div>`;
      h += `<div class="lo-chartbox" id="loAChart">${alertChart(Math.max(560, ($('#loAChart') || {}).clientWidth || 900), A)}</div>
        <div class="lo-legend"><span><i class="night"></i>ночь 00–07</span><span><i class="hit"></i>сработал на настоящий инцидент</span><span><i class="false"></i>ложная тревога</span><span><i class="ticket"></i>тикет — без будильника</span><span>пики выше 3 % обрезаны · буквы A–E — инциденты, кликни</span></div>`;
      const hrs = A.pages.reduce((a, e) => a + (night(e.s) ? 2 : 0.5), 0) + A.tickets.length * 1;
      h += `<div class="lo-kpis">${tile('Будильников за неделю', A.nPages, `${A.nNight} ночью`, A.nPages > 4 ? 'bad' : 'ok')}${tile('Ложных', A.nFalse, A.nPages ? pc(A.nFalse / A.nPages) + ' от всех' : 'нет', A.nFalse ? 'bad' : 'ok')}${tile('Пропущено серьёзных', A.missed.length, A.missed.length ? A.missed.map(x => x.k + ' — ' + x.n.toLowerCase()).join(', ') : 'все пойманы', A.missed.length ? 'bad' : 'ok')}${tile('Тикетов', A.tickets.length, 'разобрать днём', '')}${B ? tile('Часов инженеров', dec(hrs, 1), `≈ ${rub(hrs * BIZ.engH)} в неделю`, hrs > 10 ? 'bad' : '') : ''}</div>`;
      h += `<div class="lo-incs">${INC.map(x => { const d = A.det[x.k], nv = d.naive, br = ['r1', 'r6', 'r3'].filter(k => d[k] != null); return `<button type="button" class="lo-inc ${U.inc === x.k ? 'on' : ''} ${d.missed ? 'miss' : ''}" data-inc="${x.k}"><span class="lo-inck">${x.k}</span><b>${x.n}</b><small>${wkTime(x.s)} · ${mins(x.len)} × ${pc(x.rate)} ошибок · burn rate ${nf(x.burn)} · съел ${pc(x.cost / 43.2)} бюджета</small><small class="${d.missed ? 'bad' : 'ok'}">${d.missed ? 'никто не поймал' : `заметили через ${mins(d.first)}`}${c.naive ? (nv != null ? ' · всплеск: да' : ' · всплеск: пропустил') : ''}${br.length ? ' · burn rate: ' + br.map(k => RULES.find(r => r.k === k).n.replace('Burn rate ', '')).join(', ') : ''}</small></button>`; }).join('')}</div>`;
      if (U.inc) {
        const x = INC.find(q => q.k === U.inc), d = A.det[x.k], caught = ['r1', 'r6', 'r3'].some(k => d[k] != null);
        if (c.naive && d.naive == null && caught) done('catch');
        h += `<div class="lo-card ${d.missed ? 'bad' : 'ok'}"><b>${x.k}. ${x.n}:</b> ${x.d}. ${pc(x.rate)} ошибок ${mins(x.len)} — burn rate ${nf(x.burn)}: ${x.burn >= 14.4 ? 'бюджет горит так быстро, что за час сгорит больше 2 % — будим сразу' : x.burn >= 6 ? 'медленнее порога часа, но за 6 часов сгорит больше 5 % — будим' : 'медленно, но долго: за 3 дня съест треть бюджета — это задача на день, а не будильник'}. ${c.naive ? (d.naive == null ? `Алерт на всплеск его <b>пропустил</b>: ${pc(x.rate)} меньше порога ${pc(c.thr)}.` : `Алерт на всплеск поймал через ${mins(d.naive)}.`) : ''} ${B ? `Потери: ≈ ${rub(x.cost * rubMin(U.rev) * (1 - BIZ.back))} выручки.` : ''}</div>`;
      }
      h += `<div class="lo-card ${A.missed.length === 0 && A.nPages <= 4 ? 'ok' : ''}"><b>Цель:</b> ни одного пропущенного серьёзного инцидента и не больше 4 будильников за неделю. Сейчас: пропущено ${A.missed.length}, будильников ${A.nPages}${A.nNight ? `, из них ${A.nNight} ночью` : ''}. ${B ? `Каждый ночной будильник — ≈ 2 часа инженера (сон, разбор, разбитое утро), дневной — полчаса. ${c.naive ? 'Сигнализация «на тост» приучает не верить алертам.' : ''}` : ''}</div>`;
      return h;
    }

    /* ---------- вкладка 4: девятки ---------- */
    function ninesHTML() {
      const B = isBiz(), L = LIFE.nines, NB = ninesBiz(U.rev), mx = Math.log10(budgetMin(0.99)), mn = Math.log10(budgetMin(0.99999));
      let h = ana(L[0], L[1], B ? '' : L[2]);
      if (B) h += `<div class="lo-ctl"><b>Выручка магазина в месяц</b>${seg('rev', REVS, U.rev)}<small class="lo-sub">минута простоя ≈ ${rub(rubMin(U.rev))}; 3 из 10 покупателей вернутся позже</small></div>`;
      h += `<div class="lo-tablewrap"><table class="lo-table lo-nines"><thead><tr><th>SLO</th><th>Простой в месяц</th>${B ? '<th>Потери в месяц</th><th>Цена надёжности</th><th>Часов инженеров</th><th>Итого</th>' : '<th>В неделю</th><th>В день</th><th>В год</th><th>Инцидент 30 мин съест</th>'}<th class="lo-barcol">Простой в месяц (шкала ×10)</th></tr></thead><tbody>
        ${NB.map(r => { const x = r.x, on = U.nine === x.s, w = (Math.log10(r.down) - mn + 0.15) / (mx - mn + 0.15) * 100, eat = 30 / r.down; return `<tr class="lo-nrow ${on ? 'on' : ''} ${B && U.pick === x.s ? (r === NB.reduce((a, q) => q.total < a.total ? q : a) ? 'best' : 'worse') : ''}" data-nine="${x.s}" tabindex="0"><th>${x.n}</th><td>${mins(r.down)}</td>${B ? `<td>${rub(r.loss)}</td><td>${rub(r.cost)}</td><td>${nf(r.eng)}</td><td><b>${rub(r.total)}</b></td>` : `<td>${mins(r.down / 30 * 7)}</td><td>${mins(r.down / 30)}</td><td>${mins(r.down * 365 / 30)}</td><td class="${eat > 1 ? 'bad' : eat > 0.5 ? 'warn' : ''}">${pc(eat)}</td>`}<td class="lo-barcol"><div class="lo-btrack"><i class="on ${eat > 1 ? 'bad' : ''}" style="--w:${w.toFixed(1)}%"></i></div></td></tr>`; }).join('')}</tbody></table></div>`;
      if (U.nine != null) {
        const r = NB.find(q => q.x.s === U.nine), x = r.x;
        h += `<div class="lo-card ${x.s >= 0.9999 ? 'warn' : 'info'}"><b>${x.n}: ${mins(r.down)} в месяц.</b> ${x.life} <b>Что нужно:</b> ${x.need} ${B ? `<p>Потери от простоя ≈ ${rub(r.loss)} в месяц, цена надёжности ≈ ${rub(r.cost)} (серверы, зоны, дежурства), ≈ ${nf(r.eng)} часов инженеров в месяц. Итого ${rub(r.total)}.</p>` : `<p>Один ночной инцидент на 30 минут (дежурный проснулся, разобрался, откатил) съедает ${pc(30 / r.down)} месячного бюджета${30 / r.down > 1 ? ' — с людьми в цепочке такую цель не удержать' : ''}.</p>`}</div>`;
      } else h += `<div class="lo-card">Кликни по строке — увидишь, что значит эта девятка и что для неё нужно.</div>`;
      if (B) {
        if (U.pick != null) { const best = NB.reduce((a, q) => q.total < a.total ? q : a), p = NB.find(q => q.x.s === U.pick); h += `<div class="lo-card ${p === best ? 'ok' : 'warn'}">${p === best ? `<b>Да, ${p.x.n} — самая выгодная</b> для выручки ${REVS.find(v => v[0] === U.rev)[1]} в месяц: потери и цена надёжности вместе — ${rub(p.total)}. Меньше девяток — дороже простои, больше — дороже надёжность. Поменяй выручку: у маленького магазина выгоднее меньше девяток, у маркетплейса — больше.` : `<b>Есть выгоднее.</b> У ${p.x.n} сумма ${rub(p.total)}, а минимум — ${rub(best.total)}. Сравни колонку «Итого».`}</div>`; }
        else h += `<div class="lo-card info"><b>Задача:</b> найди самую выгодную девятку для этого магазина — кликни по строке с минимальной суммой «Итого».</div>`;
      }
      const prod = DEPS.reduce((a, d) => a * d[1], 1);
      h += `<div class="lo-card"><b>${B ? 'Обещать больше, чем партнёры, нельзя.' : 'Зависимости ограничивают SLO.'}</b> Оформление заказа зовёт ${DEPS.map(d => `${d[0].toLowerCase()} (${sloT(d[1])})`).join(', ')}. Если любой из них лежит — лежим и мы: ${DEPS.map(d => sloT(d[1])).join(' × ')} ≈ <b>${pc(prod, 2)}</b>, то есть ≈ ${mins(budgetMin(prod))} простоя в месяц. Обещать 99,9 % можно, только если обернуть зависимости в таймауты, повторы и запасной вариант (fallback) — тогда их сбой не роняет наш запрос.</div>`;
      return h;
    }

    /* ---------- вкладка «Итоги» ---------- */
    function memoHTML() {
      const L = isBiz() ? MEMO_BIZ : MEMO;
      return `<b class="lo-h">Что запомнить</b><div class="lo-memo">${L.map(([t, xs]) => `<div class="lo-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>
        <div class="lo-card info"><b>Как говорить об этом на собеседовании.</b> ${isBiz() ? 'Спроси, сколько стоит минута простоя и что обещано клиентам. От этого выбирается девятка, а от девятки — архитектура: реплики, зоны, регионы, дежурства.' : 'Назови SLI глазами пользователя (успешно и быстрее порога), SLO на 30 дней, посчитай бюджет в минутах и запросах, предложи алерты по burn rate 14,4 / 6 / 1 и политику заморозки. Проверь, что зависимости не ниже твоего SLO.'}</div>`;
    }

    /* ---------- общее ---------- */
    function render() {
      const v = $('#loView'); if (!v) return;
      if (U.tab !== 'budget' && U.btimer) { clearInterval(U.btimer); U.btimer = 0; U.cursor = 30; }
      v.innerHTML = U.tab === 'sli' ? sliHTML() : U.tab === 'budget' ? budgetHTML() : U.tab === 'alerts' ? alertsHTML() : U.tab === 'nines' ? ninesHTML() : memoHTML();
      fit();
    }
    /* графики рисуются в настоящую ширину контейнера — текст в SVG всегда 12px */
    function fit() {
      const cb = $('#loBChart'); if (cb && U.tab === 'budget') cb.innerHTML = budgetChart(Math.max(360, cb.clientWidth), burnDown(U.incs, U.slo));
      const ca = $('#loAChart'); if (ca && U.tab === 'alerts') ca.innerHTML = alertChart(Math.max(560, ca.clientWidth), alerts(U.cfg));
    }
    function setTab(k) {
      U.tab = k;
      EL.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.lo-tabs'), box = EL.closest('.lab-main');
      if (tabs && box && tabs.getBoundingClientRect().top < box.getBoundingClientRect().top) tabs.scrollIntoView({ block: 'start' });
    }
    function keep(f) { const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0; f(); if (box) box.scrollTop = y; }
    function setMode(m) {
      MODE = m === 'biz' ? 'biz' : 'tech';
      try { localStorage.setItem(MODE_KEY, MODE); } catch (e) { /* без хранилища */ }
      EL.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === MODE)));
      keep(render);
    }
    let nid = 1;
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-mode],[data-set],[data-act],[data-add],[data-del],[data-preset],[data-inc],[data-nine]');
      if (!b || !EL.contains(b) || b.disabled) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.mode) return setMode(d.mode);
      if (d.set) {
        const i = d.set.indexOf(':'), k = d.set.slice(0, i), v = d.set.slice(i + 1);
        if (k === 'slo') U.slo = +v; else if (k === 'minute') U.minute = v; else if (k === 'thr') U.thr = +v; else if (k === 'nthr') U.cfg.thr = +v; else if (k === 'rev') { U.rev = +v; U.pick = null; }
        keep(render); return;
      }
      if (d.add) { U.incs.push({ id: nid++, k: d.add, day: U.day }); U.cursor = 30; keep(render); return; }
      if (d.del) { U.incs = U.incs.filter(x => x.id !== +d.del); keep(render); return; }
      if (d.preset) { U.incs = PRESETS_B[d.preset].map(([k, day]) => ({ id: nid++, k, day })); U.cursor = 30; keep(render); return; }
      if (d.inc) { U.inc = U.inc === d.inc ? null : d.inc; keep(render); return; }
      if (d.nine) { pickNine(+d.nine); return; }
      const a = d.act;
      if (a === 'sort') { U.sorted = !U.sorted; keep(render); }
      else if (a === 'reroll') { U.mseed++; keep(render); }
      else if (a === 'quiz') checkQuiz();
      else if (a === 'clear') { U.incs = []; keep(render); }
      else if (a === 'play') playMonth();
    }
    function pickNine(s) {
      U.nine = s; U.seen.add(s);
      if ([0.99, 0.999, 0.9999].every(x => U.seen.has(x))) done('nines');
      if (isBiz()) { U.pick = s; const NB = ninesBiz(U.rev), best = NB.reduce((a, q) => q.total < a.total ? q : a); if (best.x.s === s) done('best'); }
      keep(render);
    }
    function checkQuiz() {
      const v = parseFloat(String(U.quiz).replace(',', '.').replace(/[^\d.]/g, ''));
      U.quizOk = isFinite(v) && v >= 42.5 && v <= 43.5;
      if (U.quizOk) done('budget');
      keep(render);
      const q = $('#loQuiz'); if (q && !U.quizOk) q.focus();
    }
    function onInput(e) {
      const t = e.target;
      if (t.id === 'loQuiz') { U.quiz = t.value; return; }
      if (t.id === 'loDay') { U.day = +t.value; const o = $('#loDayOut'); if (o) o.textContent = U.day; return; }
      if (t.dataset && t.dataset.cfg && e.type === 'change') { U.cfg[t.dataset.cfg] = t.checked; keep(render); }
    }
    function onKey(e) {
      if (e.key === 'Enter' && e.target.id === 'loQuiz') { e.preventDefault(); checkQuiz(); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.nine) { e.preventDefault(); pickNine(+e.target.dataset.nine); }
    }

    /* ---------- сборка ---------- */
    EL.innerHTML = `<div class="lo"><div class="lo-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}<div class="seg lo-mode" role="group" aria-label="Как объяснять">${[['tech', 'Техника'], ['biz', 'Бизнес']].map(([k, t]) => `<button type="button" data-mode="${k}" aria-selected="${MODE === k}">${t}</button>`).join('')}</div></div><div class="lo-view" id="loView"></div></div>`;
    EL.addEventListener('click', onClick); EL.addEventListener('input', onInput); EL.addEventListener('change', onInput); EL.addEventListener('keydown', onKey);
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); }) : null;
    if (ro) ro.observe(EL);
    render();
    return {
      destroy() {
        U.alive = false; if (U.btimer) clearInterval(U.btimer);
        EL.removeEventListener('click', onClick); EL.removeEventListener('input', onInput); EL.removeEventListener('change', onInput); EL.removeEventListener('keydown', onKey);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      }
    };
  }

  /* ================= регистрация ================= */
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'slo', title: 'SLO и бюджет ошибок', lede: 'SLI, бюджет, burn rate, девятки',
    intro: 'Что значит «сервис работает» в цифрах: SLI — доля хороших запросов, SLO — обещание на 30 дней, бюджет ошибок — сколько можно «лежать». Смотри, как инциденты сжигают бюджет по дням и когда включается заморозка фич, сравни алерты по скорости сгорания с «алертом на каждый всплеск» и пойми, во что обходится каждая девятка. Переключатель «Техника | Бизнес» переводит всё в рубли и часы инженеров.',
    tasks: [
      { id: 'budget', text: 'Посчитай бюджет ошибок для SLO 99,9 % за 30 дней — впиши минуты' },
      { id: 'freeze', text: 'Добавь инциденты так, чтобы бюджет кончился, и посмотри, что включает политика' },
      { id: 'catch', text: 'Найди инцидент, который «алерт на каждый всплеск» пропустил, а burn rate поймал' },
      { id: 'quiet', text: 'Настрой алерты: ни одного пропуска и не больше 4 будильников за неделю' },
      { id: 'nines', text: 'Сравни 99 %, 99,9 % и 99,99 % — открой каждую' },
      { id: 'best', text: 'В бизнес-режиме найди самую выгодную девятку для магазина' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
})();
