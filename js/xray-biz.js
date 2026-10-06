/* «Изнутри» → взгляд «Бизнес» во всех сценах, кроме sql и cache (у них свой — во «встроенной таблице», js/xray-sqldata.js).
   В верхней панели сцены — «Взгляд: Техника | Бизнес», выбор общий для всех сцен (тот же ключ, что у базы и кэша).
   В режиме «Бизнес» под картинкой появляется карточка «Что это значит для магазина»: бытовая аналогия, 3–5 показателей
   в секундах, заказах и рублях из живых цифр сцены и настроек узла, строка допущений. Сцена и анимация остаются.
   Допущения — те же, что в бизнес-режиме «Таблицы вживую» (js/lab-table.js) и в блоке «Для бизнеса» (js/calc.js).
   Масштаб — средний интернет-магазин: пик 50 запросов покупателей в секунду, как в первом уровне. Уровни площадки бывают
   в десятки и сотни раз крупнее — тогда объёмы и рубли из сцены приводим к среднему магазину (коэффициент k в shop()). */
(function () {
  if (!window.SD || !SD.XRAY) return;
  const MK = 'amp-stroyka-lt-mode';
  const SKIP = new Set(['sql', 'cache']);

  /* ---------- допущения: числа скопированы из lab-table.js (BIZ, EVENTS) и calc.js (RUB, PEAK, «Для бизнеса») ---------- */
  const A = {
    check: 3000,      // средний чек, ₽ — BIZ.check и calc.js
    conv: 0.02,       // 2 % посетителей оформляют заказ в день — calc.js (BIZ.orderRate)
    peakX: 3,         // пик = 3 × среднего; среднее за месяц = пик ÷ 3 — calc.js PEAK, BIZ.peakX
    act: 20,          // ≈ 20 запросов на посетителя в день — calc.js act, BIZ.hits
    actW: 30,         // 30, если запись преобладает — calc.js act
    usdRub: 90,       // $1 = 90 ₽ — calc.js RUB, BIZ.usdRub
    days: 30,         // месяц — 30 дней, как в calc.js
    slow: 0.01,       // «+100 мс к оформлению — минус 1 % конверсии» — lab-table.js, допущение к репликам
    ticket: 0.3,      // 30 % пострадавших пишут в поддержку — BIZ.ticket
    ticketRub: 300,   // обращение в поддержку стоит 300 ₽ — BIZ.ticketRub
    failover: 30,     // с запасным переключение ≈ 30 с — BIZ.failover
    restoreH: 1,      // без запасного чинят ≈ 1 ч — BIZ.restoreH
    aiMonth: 2.63e6,  // секунд в месяце — как в цене токенов на площадке (sim-ai.js MONTH)
    refP: 50          // средний магазин: пик 50 запросов покупателей в секунду — нагрузка первого уровня «Первый запуск»
  };
  const EVENTS = [[2, 'Распродажа ×2'], [4, 'Чёрная пятница ×4']];   // lab-table.js EVENTS
  /* запросы покупателей — как READ и WRITE в calc.js, но без ботов, картинок (static), телеметрии (events, metrics) и внутренних отчётов:
     одна страница тянет десятки картинок и событий, и с ними «посетителей» выходило в десятки раз больше */
  const USER_R = ['read', 'search', 'feed', 'graph', 'geo'], USER_W = ['write', 'upload', 'msg'];
  const ASM = {
    shop: S => `средний магазин — ≈ ${big(S.dau)} посетителей и ≈ ${big(S.ordersDay)} заказов в день, ≈ ${rub(S.rubMonth)} в месяц (≈ 20 запросов на посетителя в день, пик втрое выше среднего)` + (S.k < 1 ? `; на площадке поток в ${times(1 / S.k)} больше — объёмы и рубли пересчитаны на средний магазин` : ''),
    conv: '2 % посетителей заказывают в день',
    chk: 'чек 3 000 ₽',
    usd: '$1 = 90 ₽',
    slow: '+100 мс к ответу — минус 1 % заказов',
    fail: 'без запасного чинить ≈ 1 ч, на запасной переключиться ≈ 30 с',
    ticket: '30 % пострадавших пишут в поддержку, обращение — 300 ₽',
    event: 'распродажа ×2, чёрная пятница ×4',
    month: 'месяц — 30 дней',
    ai: 'обращений в месяц — поток × 2,63 млн с, как на площадке',
    per1k: 'деньги — на тысячу обращений',
    model: 'счётчики «за 10 с» — из модели сцены'
  };

  /* ---------- форматирование ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const dec = (v, d) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const big = v => {
    const a = Math.abs(v);
    if (!isFinite(v)) return '∞';
    if (a >= 1e9) return dec(v / 1e9, a >= 1e10 ? 0 : 1) + ' млрд';
    if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 1) + ' млн';
    if (a >= 1e4) return dec(v / 1e3, 0) + ' тыс.';
    if (a >= 10) return dec(v, 0);
    if (a >= 1) return dec(v, 1);
    return a > 0 ? dec(v, 2) : '0';
  };
  const rub = v => big(v) + ' ₽';
  const cnt = v => v > 0 && v < 1 ? 'меньше 1' : big(v);
  const pct = x => dec(x * 100, x * 100 < 1 ? 1 : 0) + ' %';
  const pctS = x => x * 100 < 0.01 ? 'меньше 0,01 %' : dec(x * 100, x * 100 < 0.1 ? 2 : x * 100 < 1 ? 1 : 0) + ' %';
  const dur = ms => !isFinite(ms) ? '∞' : ms < 1000 ? Math.max(1, Math.round(ms)) + ' мс' : ms < 60000 ? dec(ms / 1000, ms < 10000 ? 1 : 0) + ' с' : ms < 5400000 ? Math.round(ms / 60000) + ' мин' : dec(ms / 3600000, 1) + ' ч';
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const word = (o, a, b, c) => { const t = big(o); return t + ' ' + (o >= 1e4 ? c : t.includes(',') ? b : plural(Math.round(o), a, b, c)); };
  const buyers = o => o < 1 ? 'меньше одного покупателя' : '≈ ' + word(o, 'покупатель', 'покупателя', 'покупателей');
  const orders = o => o > 0 && o < 1 ? 'меньше одного заказа' : word(o, 'заказ', 'заказа', 'заказов');
  const cheaper = (one, base) => base / one < 100 ? `, дешевле в ${times(base / one)}` : '';
  const times = v => { const r = v < 10 ? Math.round(v * 10) / 10 : Math.round(v); return dec(r, 1) + ' ' + (r % 1 ? 'раза' : plural(r, 'раз', 'раза', 'раз')); };

  /* ---------- чтение строк stats(): [подпись, значение, класс, пояснение] ---------- */
  const norm = s => String(s == null ? '' : s).replace(/[\u00a0\u202f\u2009]/g, ' ');
  const num = s0 => {
    const s = norm(s0), m = s.match(/-?\d[\d ]*(?:[.,]\d+)?/);
    if (!m) return NaN;
    let v = parseFloat(m[0].replace(/ /g, '').replace(',', '.'));
    if (/\dk|\d\s?k\b/.test(s)) v *= 1e3;
    if (/млрд/.test(s)) v *= 1e9; else if (/млн/.test(s)) v *= 1e6; else if (/тыс/.test(s)) v *= 1e3;
    return v;
  };
  const msOf = s0 => {
    const s = norm(s0), v = num(s);
    if (!isFinite(v)) return NaN;
    if (/мс/.test(s)) return v;
    if (/мин/.test(s)) return v * 60000;
    if (/\d\s*ч/.test(s)) return v * 3600000;
    if (/\d\s*с/.test(s)) return v * 1000;
    return v;
  };
  const BU = { 'Б': 1, 'КБ': 1e3, 'МБ': 1e6, 'ГБ': 1e9, 'ТБ': 1e12, 'ПБ': 1e15 };
  const bytesOf = s0 => { const s = norm(s0), m = s.match(/(\d[\d ]*(?:[.,]\d+)?)\s*(ПБ|ТБ|ГБ|МБ|КБ|Б)/); return m ? parseFloat(m[1].replace(/ /g, '').replace(',', '.')) * BU[m[2]] : NaN; };
  const byt = v => { const u = [['ПБ', 1e15], ['ТБ', 1e12], ['ГБ', 1e9], ['МБ', 1e6], ['КБ', 1e3]].find(([, f]) => v >= f); return u ? dec(v / u[1], v / u[1] < 10 ? 1 : 0) + ' ' + u[0] : Math.round(v) + ' Б'; };
  const pair = s0 => { const m = norm(s0).match(/(\d[\d ]*)\s*из\s*(\d[\d ]*)/); return m ? [+m[1].replace(/ /g, ''), +m[2].replace(/ /g, '')] : null; };
  const reader = rows => {
    const list = Array.isArray(rows) ? rows.filter(r => Array.isArray(r)) : [];
    return re => { const r = list.find(x => re.test(String(x[0]))); return r ? { s: norm(r[1]), c: r[2] || '', h: norm(r[3]), n: num(r[1]) } : null; };
  };
  const ready = st => !!(st && !/…/.test(st.s));

  /* ---------- модель магазина: как «Для бизнеса» в calc.js ---------- */
  function shop() {
    const L = (SD.app && SD.app.A && SD.app.A.level) || {}, tr = L.traffic || {};
    const sum = ks => ks.reduce((s, k) => s + (+tr[k] || 0), 0);
    const R = sum(USER_R), W = sum(USER_W), P = R + W;
    const k = P > A.refP ? A.refP / P : 1;                            // во сколько раз средний магазин меньше уровня
    const act = W > R ? A.actW : A.act, dau = P * k / A.peakX * 86400 / act;
    const ordersH = dau * A.conv / 24 * A.peakX;                    // заказов в пиковый час
    return { P, k, dau, ordersDay: dau * A.conv, ordersH, rubH: ordersH * A.check, rubMonth: dau * A.conv * A.days * A.check };
  }
  const latGoal = () => { const L = (SD.app && SD.app.A && SD.app.A.level) || {}; const g = (L.goals || []).find(x => x && x.t === 'latency' && x.max); return g ? g.max : 0; };

  /* ---------- общие плитки: [подпись, значение, класс, пояснение] ---------- */
  function waitTile(c, ms, st, label, note, err) {
    const g = c.goal, has = isFinite(ms) && ms > 0;
    if (!has && err && err.n > 0) return [label, 'без ответа', 'bad', 'успешных ответов почти нет — запросы падают с ошибкой'];
    const cls = st && st.c ? st.c : has && g ? (ms > g * 1.5 ? 'bad' : ms > g ? 'warn' : 'ok') : '';
    return [label, has ? dur(ms) : '…', has ? cls : '', has ? note + (g ? `; цель уровня — до ${g} мс` : '') : 'копим ответы — цифра появится через пару секунд'];
  }
  /* сколько заказов теряем сейчас: ошибки и перегруз + медленный ответ (−1 % заказов за каждые +100 мс сверх цели) */
  function lossTile(c, err, lat, label) {
    if (!(c.S.ordersH > 0)) return null;
    const e = errOf(err), g = c.goal, ov = c.res.util > 1 ? 1 - 1 / c.res.util : 0, bad = Math.max(e.sh, ov);
    const slowSh = g && isFinite(lat) && lat > g ? Math.min(1, (lat - g) / 100 * A.slow) : 0;
    const sh = Math.min(1, bad + slowSh), o = c.S.ordersH * c.share * sh;
    if (!(o > 0) && e.early) return [label || 'Теряем заказов', '…', 'warn', `первые ошибки: ${e.early.n} из ${e.early.N} ответов — копим ещё, чтобы посчитать долю`];
    if (!(o > 0)) return [label || 'Теряем заказов', '0', 'ok', `в час пик через узел ≈ ${orders(c.S.ordersH * c.share)} — все обслужены${g ? ', ответ в пределах цели' : ''}`];
    const why = [];
    if (bad > 0) why.push(`без ответа ${pct(bad)} запросов`);
    if (slowSh > 0) why.push(`ответ медленнее цели на ${dur(lat - g)} — ещё −${pct(slowSh)}`);
    return [label || 'Теряем заказов', '−' + cnt(o) + ' в час', sh >= 0.05 ? 'bad' : 'warn', `≈ ${rub(o * A.check)} в час пик (${why.join('; ')}); весь месяц так — ${rub(o * A.check * 24 * A.days / A.peakX)}`];
  }
  function downTile(c, share, redundant, what, calm) {
    if (!(share > 0)) return ['Если ' + what + ' упадёт', 'покупатели не заметят', 'ok', calm || 'соседи подхватят работу сразу'];
    const sec = redundant ? A.failover : A.restoreH * 3600, o = c.S.ordersH * share * sec / 3600;
    const val = c.S.ordersH > 0 ? '−' + rub(o * A.check) : redundant ? '≈ 30 с' : '≈ 1 ч';
    const note = (redundant ? `запасной подхватит за ≈ 30 с` : `запасного нет — чинить ≈ 1 ч`) + (c.S.ordersH > 0 && share > 0 ? `: без заказа останется ${buyers(o)}` : '');
    return ['Если ' + what + ' упадёт', val, redundant ? 'ok' : 'warn', note];
  }
  function costTile(c, usd, note) {
    const r = (usd != null ? usd : (c.res.cost || 0)) * A.usdRub;
    const share = c.S.rubMonth > 0 ? r / c.S.rubMonth : 0;
    return ['Узел обходится', rub(r) + ' в мес.', '', note || (c.S.k < 1 ? `как на площадке, где поток в ${times(1 / c.S.k)} больше, чем у среднего магазина` : share > 0 ? `это ${pctS(share)} выручки магазина за месяц (${rub(c.S.rubMonth)})` : 'как на площадке, по курсу $1 = 90 ₽')];
  }
  function peakTile(c) {
    const u = c.res.util || 0;
    if (!(u > 0.005)) return null;
    const hit = EVENTS.find(([x]) => u * x > 1);
    if (!hit) return ['Чёрная пятница ×4', 'выдержит', 'ok', `загрузка станет ${pct(u * 4)} — запас есть`];
    const [x, name] = hit, ux = u * x, lost = 1 - 1 / ux, o = c.S.ordersH * c.share * x * lost;
    if (c.p.autoscale) return [name, 'добавит мощности сам', 'warn', `без этого загрузка была бы ${pct(ux)}; пока новые экземпляры запускаются, часть ответов медленнее`];
    return [name, o > 0 ? '−' + orders(o) + ' в час' : 'не выдержит', 'bad', `загрузка станет ${pct(ux)}: ${pct(lost)} запросов без ответа${o > 0 ? ` ≈ ${rub(o * A.check)} в час` : ''}`];
  }
  /* очередь: сколько писем пропадёт или придёт дважды в час пик и во что это обойдётся поддержке */
  function lossDup(c, inn, lost, dup, dlq) {
    const i = inn && inn.n > 0 ? inn.n : 0, l = lost ? lost.n || 0 : 0, d = dup ? dup.n || 0 : 0, q = dlq ? dlq.n || 0 : 0;
    const val = `${l} и ${d}`, cls = l ? 'bad' : d ? 'warn' : 'ok';
    if (!i) return ['Пропало и дубли', val, cls, 'копим сообщения — счётчики за 10 с'];
    const msgH = (c.res.rps || 0) * c.S.k * 3600, lh = msgH * Math.min(1, l / i), dh = msgH * Math.min(1, d / i), sup = (lh + dh) * A.ticket * A.ticketRub;
    return ['Пропало и дубли', val, cls, l || d ? `за 10 с из ${i}; в час пик ≈ ${cnt(lh)} сообщений пропадёт и ${cnt(dh)} придёт дважды → ≈ ${rub(sup)} в час на поддержку` : `за 10 с из ${i} — каждое ровно один раз${q ? `; отложено на ручной разбор: ${q}` : ''}`];
  }
  /* очередь при распродаже ×2: успевают ли обработчики (из итогов площадки по очередям) */
  function surgeTile(c) {
    const Q = ((c.ctx.all || {}).queues || {})[c.ctx.node.id];
    if (!Q || !(Q.in > 0)) return peakTile(c);
    const cap = (Q.drain || 0) + (Q.spare || 0), in2 = Q.in * 2;
    const head = cap / Q.in;
    if (cap >= in2) return ['Распродажа ×2', 'письма вовремя', 'ok', `обработчики успевают ${dec(head, 1)} × обычного потока — двойной им по силам`];
    const back = (in2 - cap) * 3600, delay = cap > 0 ? back / cap * 1000 : Infinity;
    return ['Распродажа ×2', isFinite(delay) ? 'опоздают на ' + dur(delay) : 'встанут', 'bad', `обработчики успевают только ${dec(head, 1)} × обычного потока: за час пика накопится ≈ ${big(back * c.S.k)} сообщений`];
  }
  /* обработчик при распродаже ×2: письма не теряются, а копятся — насколько опоздают к концу часа */
  function workerPeak(c) {
    const u = c.res.util || 0, rps = c.res.rps || 0;
    if (!(u > 0.005) || !(rps > 0)) return null;
    const cap = rps / u, in2 = rps * 2;
    if (cap >= in2) return ['Распродажа ×2', 'письма вовремя', 'ok', `загрузка станет ${pct(u * 2)} — запас есть`];
    if (c.p.autoscale) return ['Распродажа ×2', 'добавит обработчиков сам', 'warn', `без этого загрузка была бы ${pct(u * 2)}; пока новые запускаются, письма чуть опаздывают`];
    const back = (in2 - cap) * 3600;
    return ['Распродажа ×2', 'опоздают на ' + dur(back / cap * 1000), 'bad', `загрузка станет ${pct(u * 2)}: за час пика накопится ≈ ${big(back * c.S.k)} сообщений — последние придут с таким опозданием`];
  }
  const cntOf = c => Math.max(+(c.res.alive || 0), +(c.res.count || 0), +(c.p.count || 0), 1);
  /* доля ошибок из строки «Ошибки: n · из последних N»; меньше 3 ответов — рано делать вывод */
  function errOf(x) {
    if (typeof x === 'number') return { sh: x || 0 };
    if (!x || !(x.n > 0)) return { sh: 0 };
    const m = norm(x.h).match(/из последних\s+(\d+)/), N = m ? +m[1] : 0;
    return N >= 3 ? { sh: clamp(x.n / N, 0, 1) } : { sh: 0, early: { n: x.n, N: Math.max(N, x.n) } };
  }
  const usdOf = st => st ? num(String(st.s).replace(/^[^$\d]*\$/, '')) : NaN;
  const aiRps = c => (c.res && c.res.rps) || (((SD.app.A.level || {}).traffic) || {}).chat || 0;

  /* ---------- сцены: аналогия, плитки, допущения ---------- */
  const M = {
    lb(c) {
      const p95 = c.g(/^p95/), err = c.g(/^Ошибки/), rel = c.g(/^Входили заново/), q = c.g(/длинная очередь/), lat = ready(p95) ? msOf(p95.s) : NaN;
      const k = [waitTile(c, lat, p95, 'Покупатель ждёт ответа', '95 из 100 ответов не дольше этого (p95)', err), lossTile(c, err, lat)];
      if (rel) k.push(['Входили заново', rel.s, rel.c, 'столько раз покупателя выкинуло из кабинета: вход заново, корзина под угрозой']);
      else if (q) k.push(['Очередь у одной кассы', q.s, q.c, `${q.h}; соседние экземпляры в это время могут простаивать`]);
      k.push(downTile(c, 1, true, 'балансировщик'), costTile(c));
      return { an: 'Администратор у входа в магазин разводит покупателей по кассам. Отправит всех к одной — там очередь, соседние кассы скучают, и часть людей уходит без покупки.', k, asm: ['shop', 'conv', 'chk', 'slow', 'fail', 'usd'] };
    },
    app(c) {
      if (c.view === 'layers') {
        const all = c.g(/^Весь запрос/), wt = c.g(/^Ждём БД/), lat = ready(all) ? msOf(all.s) : NaN;
        return {
          an: 'Повар на кухне почти не готовит сам — он ждёт продукты со склада. Ускорять его руки бесполезно, если склад отвечает медленно.',
          k: [waitTile(c, lat, null, 'Покупатель ждёт ответа', 'один запрос через все слои кода'),
            wt ? ['Из них ждём базу и соседей', wt.h.replace(/ времени/, ''), wt.c, 'ускорять свой код почти бесполезно — выигрыш даёт кэш или запрос короче'] : null,
            lossTile(c, 0, lat), costTile(c)],
          asm: ['shop', 'conv', 'chk', 'slow', 'usd']
        };
      }
      const p95 = c.g(/^p95/), err = c.g(/^Ошибки/), lat = ready(p95) ? msOf(p95.s) : NaN, n = cntOf(c);
      return {
        an: 'Кухня кафе: повара готовят заказы одновременно. Поваров или плит не хватает — у раздачи очередь, и часть гостей уходит, не дождавшись.',
        k: [waitTile(c, lat, p95, 'Покупатель ждёт ответа', '95 из 100 ответов не дольше этого (p95)', err), lossTile(c, err, lat), peakTile(c),
          downTile(c, n > 1 ? c.share / n : c.share, n > 1, n > 1 ? 'один экземпляр' : 'сервис'), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'slow', 'event', 'fail', 'usd']
      };
    },
    queue(c) {
      const inn = c.g(/^Пришло/), ok = c.g(/^Обработано/), lag = c.g(/^Лаг/), lost = c.g(/^Потеряно/), dup = c.g(/^Дубли/), dlq = c.g(/^В DLQ/);
      const rate = ok && ok.n > 0 ? ok.n / 10 : 0, waitS = lag && lag.n > 0 ? (rate > 0 ? lag.n / rate : Infinity) : 0, early = !(inn && inn.n >= 10) && !rate;
      const k = [early ? ['Письмо о заказе придёт через', '…', '', 'копим сообщения — цифра появится через пару секунд']
        : ['Письмо о заказе придёт через', waitS === Infinity ? 'не придёт' : waitS > 0 ? '≈ ' + dur(waitS * 1000) : 'сразу', waitS === Infinity ? 'bad' : lag ? lag.c : '', waitS === Infinity ? 'разбор стоит — подтверждения копятся в очереди' : `ждут разбора: ${lag ? lag.s : 0}; заказ уже принят — покупатель свободен`]];
      k.push(lossDup(c, inn, lost, dup, dlq));
      k.push(surgeTile(c));
      const n = cntOf(c), msgH = (c.res.rps || 0) * c.S.k * 3600 * (n > 1 ? A.failover / 3600 : A.restoreH);
      k.push(['Если брокер упадёт', n > 1 ? '≈ 30 с' : '≈ 1 ч', n > 1 ? 'ok' : 'warn', `${n > 1 ? 'соседний брокер подхватит' : 'запасного нет'}: задержатся ≈ ${cnt(msgH)} сообщений: письма, подтверждения`]);
      k.push(costTile(c));
      return { an: 'Ящик для заказов между кассой и складом: касса бросает заказ в ящик и сразу отпускает покупателя, а склад разбирает ящик в своём темпе.', k, asm: ['shop', 'ticket', 'event', 'fail', 'usd', 'model'] };
    },
    worker(c) {
      const batch = c.scn === 'batch';
      const wt = batch ? c.g(/^Задержка: пачками/) : c.g(/^Ожидание/), spd = c.g(/^Скорость/), wait = c.g(/^Ждут/), ok = c.g(/^Обработано/) || c.g(/^Пачками|^Пачка/);
      const dup = c.g(/^Дубли/), lost = c.g(/^Потеряно/);
      const k = [['Подтверждение придёт через', ready(wt) ? '≈ ' + wt.s : '…', wt && wt.c, batch ? 'пачками: дольше ждём сбор пачки, зато разбираем быстрее' : 'от заказа до письма или записи на складе']];
      if (spd && ok && ok.n >= 3) { const inR = num((spd.h.match(/приходит\s+([\d.,\s]+)/) || [])[1]), wc = wait ? wait.c : '', lag = wc === 'bad', mid = wc === 'warn';
        k.push(['Успевают разбирать', lag ? 'нет' : mid ? 'на пределе' : 'да', lag ? 'bad' : mid ? 'warn' : 'ok', `разбирают ${spd.s}${isFinite(inR) ? `, приходит ${dec(inR, 1)}/с` : ''}; ждут ${wait ? wait.s : 0}` + (lag ? ' — очередь растёт, письма опаздывают всё сильнее' : '')]); }
      const lostN = lost ? num(lost.s) : 0, dupN = dup ? dup.n || 0 : 0, base = ok && ok.n > 0 ? ok.n : 0;
      if (lost || dup) {
        const msgH = (c.res.rps || 0) * c.S.k * 3600, sh = base ? (lostN + dupN) / Math.max(base, lostN + dupN) : 0, hurt = msgH * sh;
        k.push(['Потери и дубли', `${lostN || 0} и ${dupN}`, lostN ? 'bad' : dupN ? 'warn' : 'ok', sh > 0 ? `в час пик ≈ ${cnt(hurt)} сообщений пропадут или придут дважды → ≈ ${rub(hurt * A.ticket * A.ticketRub)} на поддержку` : 'каждое сообщение — ровно один раз']);
      }
      else if (spd) k.push(['Успевают разбирать', '…', '', 'копим сообщения — цифра появится через пару секунд']);
      k.push(workerPeak(c), costTile(c));
      return { an: 'Кладовщики разбирают ящик с заказами: берут по одному или сразу охапкой и отмечают в журнале, что сделано.', k, asm: ['shop', 'ticket', 'event', 'usd', 'model'] };
    },
    olap(c) {
      const rep = c.g(/^Отчёт/), rej = c.g(/^Отказов вставки/), rd = c.g(/^Прочитано/), rp = +(c.p.replicas || 0);
      return {
        an: 'Отдельный архив для бухгалтерии: итоги считают там, а не у кассы, поэтому покупатели не ждут, пока менеджер строит график.',
        k: [['Менеджер ждёт отчёт', ready(rep) ? rep.s : '…', rep && rep.c, (rep && rep.s0 ? rep.s0.toLowerCase() : 'отчёт') + (rd && ready(rd) ? `: прочитано ${rd.s} — ${rd.h}` : ' пересчитывается')],
          rej && rej.n > 0 ? ['Продажи выпадают из отчёта', `${rej.s} за 10 с`, 'bad', 'база отказала во вставке: этих заказов не будет в цифрах, пока их не дошлют'] : ['Продажи в отчётах', 'все на месте', 'ok', 'вставки проходят, цифры полные'],
          ['Если аналитика упадёт', 'покупатели не заметят', 'ok', `заказы идут как обычно; отчёты встанут на ${rp ? '≈ 30 с — есть реплика' : '≈ 1 ч — реплики нет'}`],
          costTile(c)],
        asm: ['shop', 'conv', 'chk', 'fail', 'usd', 'model']
      };
    },
    lake(c) {
      const q = c.g(/^Запрос за день/), rd = c.g(/^Прочитано/), pr = c.g(/^Цена запроса/), sn = c.g(/^Снимков/), ice = sn && !/нет/.test(sn.s);
      const one = usdOf(pr) * A.usdRub * c.S.k, rb = rd ? bytesOf(rd.s) * c.S.k : NaN;
      return {
        an: 'Архив коробок с чеками: если коробки подписаны по дням, нужный день находят сразу; если свалены в кучу — перебирают всё и платят грузчикам за каждую коробку.',
        k: [['Аналитик ждёт ответ', q ? q.s : '…', q && q.c, 'выручка за один день'],
          ['Один такой запрос стоит', isFinite(one) ? rub(one) : '…', pr && pr.c, isFinite(rb) ? `платим за прочитанное: ${byt(rb)}` + (c.S.k < 1 ? ' — у среднего магазина данных меньше' : '') : 'платим за прочитанные гигабайты'],
          ['Если данные испортили', ice ? 'откатим за минуты' : 'вернуть нечем', ice ? 'ok' : 'bad', ice ? `есть снимки (${sn.s}): можно посмотреть и вернуть «как было вчера»` : 'снимков нет — придётся пересчитывать заново из источников'],
          costTile(c)],
        asm: ['shop', 'usd', 'month']
      };
    },
    etl(c) {
      const fr = c.g(/^Свежесть/), runs = c.g(/^Запусков успешно/), fail = c.g(/^Сбоев/), price = c.g(/^Цена/), pr = runs ? pair(runs.s) : null;
      const k = [['Цифры в отчётах отстают на', fr ? fr.s : '…', fr && fr.c, fr ? `договорились: ${fr.h}` : '']];
      if (pr) k.push(['Сорвалось обновлений', `${pr[1] - pr[0]} из ${pr[1]}`, pr[1] - pr[0] ? 'bad' : 'ok', pr[1] - pr[0] ? 'в эти часы менеджеры смотрят на неполные цифры' : 'все обновления прошли']);
      else if (fail) k.push(['Сбоев конвейера', fail.s, fail.c, 'после сбоя поток продолжит с последней отметки']);
      const usd = usdOf(price);
      k.push(costTile(c, isFinite(usd) ? usd : null, isFinite(usd) ? 'цена конвейера из сцены, по курсу $1 = 90 ₽' : null));
      k.push(['Если конвейер встанет', c.S.ordersH > 0 ? rub(c.S.rubH) + ' в час' : 'продажи идут', 'warn', c.S.ordersH > 0 ? `столько выручки в час пик (≈ ${orders(c.S.ordersH)}) не попадёт в отчёты, пока его не починят; покупатели не заметят` : 'покупатели не заметят, а отчёты замрут']);
      return { an: 'Утренняя развозка газет: пока машина не приехала, в киосках вчерашние новости. Опоздала — люди решают по старым цифрам.', k, asm: ['shop', 'conv', 'chk', 'usd'] };
    },
    nosql(c) {
      const w = c.g(/^Запись/), r = c.g(/^Чтение/), fails = c.g(/^Отказов/), st = c.g(/^Старых чтений/);
      const rf = +(c.p.rf || 3), cl = c.p.cl || 'quorum', need = cl === 'one' ? 1 : cl === 'all' ? rf : Math.floor(rf / 2) + 1, survive = rf - 1 >= need && cntOf(c) > 1;
      return {
        an: 'Журнал сообщений лежит в трёх комнатах сразу: можно ждать подтверждения от одной комнаты — быстро, или от большинства — надёжнее.',
        k: [['Сообщение сохраняется за', ready(w) ? w.s : '…', w && w.c, ready(r) ? `открыть чат — ${r.s}` : 'копим ответы'],
          ['Не сохранилось', fails ? `${fails.s} за 10 с` : '0', fails && fails.n ? 'bad' : 'ok', fails && fails.n ? 'каждый такой человек видит ошибку и отправляет заново или уходит' : 'все записи прошли'],
          ['Видят старое', st ? `${st.s} за 10 с` : '0', st && st.n ? 'warn' : 'ok', st && st.n ? 'человек не видит своё сообщение — 30 % пишут в поддержку, это 300 ₽ за обращение' : 'каждый сразу видит своё'],
          downTile(c, survive ? 0 : c.share, survive, 'один узел', `копии есть ещё в ${rf - 1} ${plural(rf - 1, 'узле', 'узлах', 'узлах')}, хватает для «${cl}» — запись и чтение продолжатся`), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'ticket', 'fail', 'usd', 'model']
      };
    },
    objstore(c) {
      const fb = c.g(/^Первый байт|^Из архива/), sto = c.g(/^Хранение/), eg = c.g(/^Трафик наружу/), th = c.g(/^Потоки сервиса/);
      const k1 = c.S.k, sR = usdOf(sto) * A.usdRub * k1, eR = usdOf(eg) * A.usdRub * k1, sb = sto ? bytesOf(sto.h) * k1 : NaN;
      const noCdn = eg && /без CDN/.test(eg.h) ? usdOf({ s: eg.h.slice(eg.h.indexOf('без CDN')) }) * k1 : NaN;
      const k = [['Фото начинает грузиться через', fb ? fb.s : '…', fb && fb.c, fb && fb.c === 'bad' ? 'файл в архиве — покупатель его не дождётся' : 'файл рядом, отдаётся сразу'],
        ['Хранение файлов', isFinite(sR) ? rub(sR) + ' в мес.' : '…', '', isFinite(sb) ? `лежит ${byt(sb)} фотографий` : ''],
        ['Отдача покупателям', isFinite(eR) ? rub(eR) + ' в мес.' : '…', eg && eg.c, isFinite(noCdn) && /без CDN/.test(eg.h) ? `без CDN было бы ${rub(noCdn * A.usdRub)} — экономим ${rub(Math.max(0, noCdn * A.usdRub - eR))}` : 'трафик наружу, $0,09 за ГБ']];
      if (th) k.push(['Сервис занят файлами', th.s, th.c, th.c === 'bad' ? 'потоки сервиса возят файлы — покупатели ждут свои ответы в очереди' : 'файлы идут мимо сервиса по подписанной ссылке']);
      return { an: 'Камера хранения: вещи лежат дёшево и надёжно, а выдают их по номерку. Чем чаще забирают и чем дальше везти — тем дороже.', k, asm: ['shop', 'usd', 'model'] };
    },
    cdn(c) {
      const hr = c.g(/^Попаданий/), avg = c.g(/^Ответ в среднем/), e502 = c.g(/^Ошибок 502/), old = c.g(/^Старый/), sv = c.g(/^Экономия/);
      const save = usdOf(sv) * A.usdRub * c.S.k, own = (c.res.cost || 0) * A.usdRub, broken = (e502 ? e502.n || 0 : 0) + (old ? old.n || 0 : 0);
      return {
        an: 'Пункты выдачи рядом с домом: товар везут со склада один раз, а потом соседи забирают его за пару минут, а не ждут доставку через всю страну.',
        k: [['Картинка открывается за', avg && avg.n > 0 ? avg.s : '…', avg && avg.c, 'в среднем по стране, в модели сцены'],
          (() => { const warm = avg && avg.n > 0, pl = hr ? num((hr.h.match(/на площадке\s+(\d+)/) || [])[1]) : NaN, v = warm || !isFinite(pl) ? (hr ? hr.n : NaN) : pl;
            return ['Ближний пункт отдаёт', isFinite(v) ? dec(v, 0) + ' из 100' : '…', !isFinite(v) ? '' : v >= 85 ? 'ok' : v >= 60 ? 'warn' : 'bad', (warm ? 'в модели за 10 с' : 'как на площадке, модель ещё прогревается') + '; остальные картинки едут с главного склада — дольше']; })(),
          ['Экономим на трафике', isFinite(save) ? rub(save) + ' в мес.' : '…', 'ok', isFinite(save) && own > 0 && c.S.k >= 1 && save / own < 100 ? `CDN стоит ${rub(own)} в мес. — окупается в ${times(save / own)}` : 'столько стоил бы трафик с главного склада без пунктов выдачи'],
          ['Сломанные страницы', String(broken), broken ? 'bad' : 'ok', broken ? 'за 10 с: ошибка 502 или старая версия сайта — покупатель видит поломку' : 'все видят рабочую и свежую версию']],
        asm: ['shop', 'usd', 'model']
      };
    },
    search(c) {
      const q = c.g(/^Запрос/), f = c.g(/^Найдено/), dr = c.g(/^Рассинхрон/), down = f && /503/.test(f.s), o = c.S.ordersH * c.share;
      return {
        an: 'Алфавитный указатель в конце каталога: товар по слову находят за секунду, а не листают все страницы.',
        k: [waitTile(c, q && q.n > 0 ? msOf(q.s) : NaN, q, 'Покупатель ждёт результаты', 'поиск по слову'),
          down ? ['Поиск не отвечает', '−' + cnt(o) + ' в час', 'bad', `≈ ${rub(o * A.check)} в час: покупатели, которые ищут, не найдут товар`] : ['Нашлось товаров', f ? f.s : '…', f && f.c, o > 0 ? `через поиск в час пик ≈ ${orders(o)}` : 'по запросу «кроссовки»'],
          ['Неверные результаты', dr ? dr.s : '0', dr && dr.n ? 'bad' : 'ok', dr && dr.n ? 'товар в поиске с неверной ценой или его уже нет — покупатель уходит' : 'поиск совпадает с базой'],
          peakTile(c), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'event', 'usd']
      };
    },
    gateway(c) {
      const ok = c.g(/^200/), r429 = c.g(/^429/), r401 = c.g(/^401/), r5 = c.g(/^5xx/), hang = c.g(/^Висят/), bots = c.g(/^Боты/);
      const v = x => x && x.n > 0 ? x.n : 0, tot = v(ok) + v(r429) + v(r401) + v(r5) + v(hang), badSh = tot ? (v(r5) + v(hang)) / tot : 0;
      return {
        an: 'Охранник на входе в торговый центр: проверяет пропуск, не пускает толпу ботов и показывает, в какой отдел идти.',
        k: [['Ответили без ошибки', tot ? pct(v(ok) / tot) : '…', tot ? (v(ok) / tot >= 0.95 ? 'ok' : 'warn') : '', `за 10 с: «подождите» (429) — ${v(r429)}, «войдите» (401) — ${v(r401)}`],
          lossTile(c, badSh, NaN, 'Теряем заказов') || ['Сбои сервисов', String(v(r5) + v(hang)), v(r5) + v(hang) ? 'bad' : 'ok', 'ошибки и зависшие ответы'],
          ['Боты до сервисов', bots ? bots.s : '—', bots && bots.c, bots && bots.c === 'bad' ? 'платим серверами за обслуживание ботов, а покупателям достаётся меньше' : 'ботов отсекает шлюз'],
          downTile(c, 1, cntOf(c) > 1, 'шлюз'), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'fail', 'usd', 'model']
      };
    },
    ws(c) {
      const del = c.g(/^Доставлено/), rej = c.g(/^Отказы/), per = c.g(/^На экземпляр/), n = cntOf(c);
      const perN = per ? per.n : NaN, x3 = isFinite(perN) ? perN * 3 : NaN, cap = 100000;
      return {
        an: 'Телефонная линия, которая всё время открыта: сообщение приходит сразу, без перезвона. Но у каждого оператора ограничено число линий.',
        k: [['Сообщения доходят', del && del.n >= 0 && ready(del) ? del.s.replace(' %', '') + ' из 100' : '…', del && del.c, 'участникам чата, которые в сети'],
          ['Не смогли подключиться', rej ? `${rej.s} за 10 с` : '0', rej && rej.n ? 'bad' : 'ok', rej && rej.n ? 'человек открыл чат, а он не работает' : 'линий хватает'],
          isFinite(x3) ? ['Вечером втрое больше людей', x3 > cap ? 'не хватит линий' : 'хватит', x3 > cap ? 'bad' : 'ok', x3 > cap ? `на экземпляр придётся ${big(x3)} соединений при пределе 100 тыс. — ${pct(1 - cap / x3)} останутся без чата` : `на экземпляр придётся ${big(x3)} из 100 тыс.`] : null,
          downTile(c, n > 1 ? 0 : c.share, n > 1, 'один экземпляр', 'люди переподключатся к соседним экземплярам за секунды и догонят пропущенное'), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'fail', 'usd', 'model']
      };
    },
    llm(c) {
      const t1 = c.g(/^До 1-го токена/), full = c.g(/^Полный ответ/), price = c.g(/^Цена ответа/), r429 = c.g(/^429/), q = c.g(/^Очередь/), hit = c.g(/^Из кэша/);
      const one = price ? num(price.s) : NaN, month = (c.res.cost || 0) * A.usdRub, perM = aiRps(c) * A.aiMonth;
      const k = [['Клиент видит первые слова через', ready(t1) ? t1.s : '…', t1 && t1.c, full ? `весь ответ — ${full.s}` : ''],
        ['Одно обращение стоит', isFinite(one) ? rub(one) : '…', '', isFinite(one) && one > 0 ? `у оператора-человека — 300 ₽${cheaper(one, A.ticketRub)}` : 'свои видеокарты'],
        ['В месяц', rub(month), '', `≈ ${big(perM)} обращений, цена как на площадке`]];
      if (r429) k.push(['Отказано клиентам', `${r429.s} за 10 с`, r429.n ? 'bad' : 'ok', r429.n ? 'лимит поставщика: каждый такой клиент уйдёт к оператору (300 ₽)' : 'лимит поставщика не мешает']);
      else if (q) k.push(['Ждут в очереди', q.s, q.c, q.n ? 'видеокарты заняты — клиенты ждут первые слова дольше' : 'видеокарты успевают']);
      if (hit && hit.n > 0) k.push(['Из кэша', hit.s, 'ok', 'ответов без вызова модели за 10 с — бесплатно и сразу']);
      return { an: 'Консультант, который читает вопрос и пишет ответ по словам: первое слово появляется быстро, весь ответ — дольше. Чем длиннее вопрос и ответ, тем дороже его время.', k, asm: ['ticket', 'ai', 'usd', 'model'] };
    },
    vectordb(c) {
      const s = c.g(/^Поиск/), rc = c.g(/^Recall/), mem = c.g(/^Память/), ans = c.g(/^Ответы/);
      const m = ans ? norm(ans.s).match(/(\d+)\s*✓\s*·\s*(\d+)\s*✕/) : null, ok = m ? +m[1] : 0, bad = m ? +m[2] : 0, sh = ok + bad ? bad / (ok + bad) : 0;
      const calls = 1000 * sh * A.ticket, loss = calls * A.ticketRub;
      return {
        an: 'Библиотекарь, который ищет не по точному названию, а по смыслу вопроса, и приносит несколько подходящих страниц.',
        k: [['Неверных ответов', ok + bad ? `${bad} из ${ok + bad}` : '…', bad ? 'bad' : ok ? 'ok' : '', ok + bad ? (bad ? `на каждую 1 000 ответов ≈ ${big(calls)} звонков в поддержку — ${rub(loss)}` : 'клиенты получают верные ответы со ссылками') : 'копим ответы'],
          ['Находит нужные страницы', rc ? rc.s.replace(' %', '') + ' из 100' : '…', rc && rc.c, 'остальные лучшие куски поиск пропускает'],
          ['Ищет за', s ? s.s : '…', s && s.c, s && msOf(s.s) > 100 ? 'заметная добавка ко времени ответа клиенту' : 'к ответу модели это почти незаметно'],
          ['Память', mem ? mem.s : '…', mem && mem.c, mem && mem.c === 'bad' ? 'индекс не влезает — поиск пойдёт с диска, ответы замедлятся' : `влезает; узел — ${rub((c.res.cost || 0) * A.usdRub)} в мес.`]],
        asm: ['ticket', 'per1k', 'usd', 'model']
      };
    },
    agent(c) {
      const step = c.g(/^Шаг/), stT = c.g(/^Время шага/), pr = c.g(/^Цена задачи/), paid = c.g(/^Выплачено/), done = c.g(/^Решено/);
      const d = done ? pair(done.s) : null, rate = d && d[1] ? d[0] / d[1] : NaN, st = step ? pair(step.s) : null, gpu = !!(pr && /GPU/.test(pr.s));
      const llmUsd = (c.ctx.outs ? c.ctx.outs() : []).filter(x => x.n && x.n.type === 'llm').reduce((s2, x) => s2 + ((x.r && x.r.cost) || 0), 0);
      const perTask = aiRps(c) * A.aiMonth, one = gpu ? (perTask > 0 ? ((c.res.cost || 0) + llmUsd) * A.usdRub / perTask : NaN) : pr && num(pr.s) > 0 ? num(pr.s) : NaN;
      const save = isFinite(rate) && isFinite(one) ? 1000 * rate * Math.max(0, A.ticketRub - one) : NaN;
      const over = paid && paid.c === 'bad';
      return {
        an: 'Стажёр с инструкцией: сам находит заказ, проверяет правила и оформляет возврат, а спорное отдаёт старшему.',
        k: [['Решено без человека', isFinite(rate) ? `${d[0]} из ${d[1]}` : '…', done && done.c, isFinite(save) ? `на каждую 1 000 обращений экономим ≈ ${rub(save)} на операторах` : 'копим обращения'],
          ['Клиент ждёт ответ', st && st[0] > 0 && stT ? '≈ ' + dur(st[0] * msOf(stT.s)) : '…', '', stT ? `шагов ${st && st[0] > 0 ? st[0] : '…'} из ${st ? st[1] : '…'}, каждый — ${stT.s} (вызов модели)` : ''],
          ['Одно обращение стоит', isFinite(one) ? rub(one) : '…', '', isFinite(one) && one > 0 ? `у оператора-человека — 300 ₽${cheaper(one, A.ticketRub)}${gpu ? '; свои видеокарты: агент и модель за месяц ÷ обращения' : ''}` : 'копим шаги обращения'],
          ['Ошибочная выплата', over ? paid.s : 'нет', over ? 'bad' : 'ok', over ? `вернули больше оплаченного (${paid.h}) — прямой убыток` : c.p.hitl ? 'спорные суммы подтверждает человек' : 'проверка человеком выключена — следи за суммами']],
        asm: ['ticket', 'per1k', 'usd']
      };
    },
    k8s(c) {
      const pods = c.g(/^Подов работает/), err = c.g(/^Ошибок у пользователей/), pr = pods ? pair(pods.s) : null, n = +(c.p.nodes || 1);
      return {
        an: 'Диспетчер такси: говоришь «нужно пять машин» — он сам находит водителей и подменяет сломавшиеся.',
        k: [['Работает сервисов', pr ? `${pr[0]} из ${pr[1]}` : '…', pods && pods.c, pr && pr[0] < pr[1] ? 'часть мощности не работает — покупателям достаётся меньше' : 'всё, что нужно, запущено'],
          ['Ошибок у покупателей', err ? err.s : '0', err && err.c, err && err.n ? 'запросы попали в зависший или убитый экземпляр' : 'никто не заметил сбоя'],
          downTile(c, n > 1 ? 0 : 1, n > 1, 'один сервер', 'экземпляры переедут на соседние серверы; пока переезжают, ответы чуть медленнее'), costTile(c)],
        asm: ['shop', 'conv', 'chk', 'fail', 'usd']
      };
    }
  };
  /* мониторинг и логи: сам на пути заказа не стоит, но решает, как быстро узнаем о сбое */
  const OPS = {
    prometheus: 'Медсестра обходит всех пациентов и записывает пульс — так видно, кому плохо, раньше, чем он упадёт.',
    grafana: 'Приборная панель машины: скорость, топливо и температура — на одном экране.',
    alertmanager: 'Пожарная сигнализация: сама звонит в часть, не ждёт, пока кто-то заметит дым.',
    kibana: 'Общий журнал всех смен: что случилось, когда и у кого — с поиском.',
    jaeger: 'Трекер посылки: видно, на каком складе она застряла и сколько там пролежала.'
  };
  function generic(c) {
    const chip = c.live && c.live[0];
    const k = [];
    if (chip) k.push([chip[0], chip[1], chip[2] || '', 'как на площадке']);
    if (c.S.ordersH > 0) k.push(['Час сбоя в пик', rub(c.S.rubH), 'warn', `≈ ${orders(c.S.ordersH)} не состоится — столько стоит каждый час, пока сбой не заметили`]);
    k.push(costTile(c));
    const cost = (c.res.cost || 0) * A.usdRub;
    if (c.S.rubH > 0 && cost > 0) k.push(['Окупится, если заметим сбой раньше на', '≈ ' + dur(cost / c.S.rubH * 3600 * 1000), 'ok', 'за месяц: столько простоя в час пик стоит столько же, сколько этот узел']);
    return { an: OPS[c.type] || 'Служебный узел: сам заказы не обслуживает, но без него магазин работает вслепую.', k, asm: ['shop', 'conv', 'chk', 'usd'] };
  }

  /* ---------- карточка ---------- */
  const DOM_BANK = new Set(['support', 'voice']);
  const domain = type => type === 'vectordb' || (type === 'llm' && DOM_BANK.has(((SD.app && SD.app.A && SD.app.A.level) || {}).id)) ? 'банка' : 'магазина';
  function build(type, ctx, inner, live) {
    const rows = inner && typeof inner.stats === 'function' ? inner.stats() : [];
    const g0 = reader(rows), g = re => { const r = g0(re); if (r) { const row = rows.find(x => Array.isArray(x) && re.test(String(x[0]))); r.s0 = row ? String(row[0]) : ''; } return r; };
    const S = shop(), res = ctx.res || {}, p = (ctx.node && ctx.node.props) || {};
    const c = { type, g, S, res, p, ctx, view: ctx.view ? ctx.view() : null, scn: ctx.scenario ? ctx.scenario() : null, goal: latGoal(), live, share: S.P > 0 ? clamp((res.rps || 0) / S.P, 0, 1) : 1 };
    const out = (M[type] || generic)(c);
    const k = out.k.filter(Boolean).slice(0, 5);
    const asm = out.asm.map(x => typeof ASM[x] === 'function' ? ASM[x](S) : ASM[x]).filter(Boolean);
    return `<div class="xbz-head"><span class="xbz-eye">Взгляд бизнеса</span><h3 class="xbz-title">Что это значит для ${domain(type)}</h3></div>
      <p class="xbz-life"><span class="xbz-tag">Как в жизни</span>${esc(out.an)}</p>
      <ul class="xbz-kpis">${k.map(([l, v, cl, n]) => `<li class="xbz-kpi"><small>${esc(l)}</small><b class="${esc(cl || '')}">${esc(v)}</b>${n ? `<span>${esc(n)}</span>` : ''}</li>`).join('')}</ul>
      <p class="xbz-asm"><b>Допущения</b> из «Таблицы вживую» и «Как посчитать»: ${esc(asm.join('; '))}.</p>`;
  }

  const API = SD.xrayBiz = { A, errs: [], build: null };
  function attach(type, def) {
    const mount0 = def && def.mount;
    if (typeof mount0 !== 'function' || mount0.__xbz) return;
    const mount = function (ctx) {
      const inner = mount0.call(this, ctx) || {};
      const ctl = document.getElementById('xrCtl'), stats = document.getElementById('xrStats');
      const main = stats ? stats.closest('.xr-main') : null;
      if (ctl && ctl.querySelector('.xsd-mode')) return inner;   // у сцены свой переключатель — не трогаем
      let card = null, lastHtml = '', lastT = 0, alive = true;
      const mode = () => { try { return localStorage.getItem(MK) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
      const liveChips = () => { try { return def.live ? def.live(ctx.node, ctx.res || {}, ctx.all) : null; } catch (e) { return null; } };
      const render = () => {
        lastT = performance.now();
        if (!alive) return;
        if (mode() !== 'biz') { if (card) { card.remove(); card = null; lastHtml = ''; } if (main) main.classList.remove('xbz-on'); return; }
        if (!card) {
          document.querySelectorAll('#xrModal .xbz-card').forEach(x => x.remove());
          card = document.createElement('section'); card.className = 'xbz-card'; card.setAttribute('aria-label', 'Что это значит для бизнеса');
          if (stats && stats.parentNode) stats.parentNode.insertBefore(card, stats); else if (main) main.appendChild(card);
          lastHtml = '';
        }
        if (main) main.classList.add('xbz-on');
        let h;
        try { h = build(type, ctx, inner, liveChips()); } catch (e) { API.errs.push(type + ': ' + (e && e.message)); h = '<p class="xbz-asm">Не получилось посчитать бизнес-цифры для этой сцены.</p>'; }
        if (h !== lastHtml) { card.innerHTML = h; lastHtml = h; }
      };
      const inject = () => {
        if (!alive || !ctl || ctl.querySelector('.xsd-mode, .xbz-mode')) return;
        const m = mode(), g = document.createElement('div'); g.className = 'xr-grp xbz-mode';
        g.innerHTML = `<b>Взгляд</b><div class="seg"><button type="button" data-xbzmode="tech" aria-selected="${m === 'tech'}" title="Как устроено технически">Техника</button><button type="button" data-xbzmode="biz" aria-selected="${m === 'biz'}" title="Что это значит для бизнеса: секунды, заказы, рубли">Бизнес</button></div>`;
        const vv = ctl.querySelector('.xr-views'); if (vv && vv.nextSibling) ctl.insertBefore(g, vv.nextSibling); else ctl.appendChild(g);
      };
      const mo = ctl ? new MutationObserver(inject) : null; if (mo) mo.observe(ctl, { childList: true });
      const onMode = e => {
        const b = e.target.closest('[data-xbzmode]'); if (!b) return;
        const m = b.dataset.xbzmode;
        try { localStorage.setItem(MK, m); } catch (err) { /* без хранилища */ }
        ctl.querySelectorAll('[data-xbzmode]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.xbzmode === m)));
        render();
      };
      if (ctl) ctl.addEventListener('click', onMode);
      inject();
      render();
      const after = (fn, args) => { const r = fn ? fn.apply(inner, args) : undefined; render(); return r; };
      const over = {
        view(...a) { lastHtml = ''; return after(inner.view, a); },
        onProp(...a) { return after(inner.onProp, a); },
        refresh(...a) { return after(inner.refresh, a); },
        draw(...a) { const r = inner.draw ? inner.draw.apply(inner, a) : undefined; if (performance.now() - lastT > 500) render(); return r; },
        destroy(...a) {
          alive = false;
          if (mo) mo.disconnect();
          if (ctl) { ctl.removeEventListener('click', onMode); ctl.querySelectorAll('.xbz-mode').forEach(x => x.remove()); }
          if (card) card.remove(); card = null;
          if (main) main.classList.remove('xbz-on');
          return inner.destroy ? inner.destroy.apply(inner, a) : undefined;
        }
      };
      if (typeof inner.scenario === 'function') over.scenario = (...a) => after(inner.scenario, a);
      return Object.assign({}, inner, over);
    };
    mount.__xbz = true;
    def.mount = mount;
  }
  API.build = build;
  API.attached = [];
  Object.keys(SD.XRAY).forEach(t => { if (!SKIP.has(t)) { attach(t, SD.XRAY[t]); API.attached.push(t); } });
})();
