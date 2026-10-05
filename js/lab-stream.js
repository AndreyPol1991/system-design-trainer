/* Лаборатория «Поток событий вживую»: поток покупок в магазине — у каждой время покупки (event time), время прихода на сервер,
   сумма и город. Окна (tumbling, sliding, session); время события против времени обработки, watermark и опоздавшие;
   состояние оператора, чекпойнты и «ровно один раз»; соединение заказов с оплатами; происхождение данных и контракты.
   Переключатель «Техника | Бизнес» — как в «Выкладке вживую»: в бизнес-режиме те же прогоны в рублях и решениях.
   Стили — lab-stream.css, префикс .lsv-. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const rub = v => nf(v) + ' ₽';
  const rubK = v => { const a = Math.abs(v); if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 1) + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const pc = (x, d = 1) => { const k = Math.pow(10, d), v = Math.round(x * 100 * k) / k; return (Number.isInteger(v) ? String(v) : v.toFixed(d).replace('.', ',')) + ' %'; };
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const pcs = n => nf(n) + ' ' + plural(n, 'покупка', 'покупки', 'покупок');
  const p2 = n => String(n).padStart(2, '0');
  const T = (h, m, s) => h * 3600 + m * 60 + (s || 0);
  const hms = x => { x = Math.round(x); return `${p2(Math.floor(x / 3600) % 24)}:${p2(Math.floor(x / 60) % 60)}:${p2(x % 60)}`; };
  const hm = x => hms(x).slice(0, 5);
  const dur = s => { s = Math.round(s); if (s < 60) return s + ' с'; const m = Math.floor(s / 60), r = s % 60; if (m < 60) return m + ' мин' + (r ? ' ' + r + ' с' : ''); const h = Math.floor(m / 60); return h + ' ч' + (m % 60 ? ' ' + (m % 60) + ' мин' : ''); };
  /* svg-кусочки */
  const f1 = v => (+v).toFixed(1);
  const tx = (x, y, t, c, a) => `<text class="${c || 'lsv-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const rc = (x, y, w, h, c, rx, at) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"${at || ''}/>`;
  const ln = (x1, y1, x2, y2, c, at) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"${at || ''}/>`;
  const cir = (x, y, r, c, at) => `<circle class="${c}" cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}"${at || ''}/>`;
  const arrow = (x1, y1, x2, y2, c) => { if (Math.hypot(x2 - x1, y2 - y1) < 2) return ''; const a = Math.atan2(y2 - y1, x2 - x1), L = 7, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`; return ln(x1, y1, x2, y2, 'lsv-ar ' + (c || '')) + `<polygon class="lsv-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`; };

  /* ---------- данные: покупки в сети магазинов в трёх городах, 12:00–12:26 ---------- */
  const CITY = { M: 'Москва', K: 'Казань', S: 'Самара' };
  const CITIES = ['M', 'K', 'S'];
  /* [минута, секунда, через сколько секунд покупка дошла до сервера, сумма ₽, город, покупатель, почему опоздала] */
  const RAW = [
    [0, 20, 1, 1250, 'M', 'Аня'], [0, 55, 1, 640, 'K', 'Борис'], [1, 40, 2, 2300, 'M', 'Вика'], [2, 10, 1, 890, 'S', 'Глеб'],
    [3, 5, 370, 1190, 'K', 'Дина', 'телефон был без сети в метро'], [3, 30, 1, 1120, 'M', 'Егор'], [4, 15, 40, 760, 'S', 'Жанна', 'слабая связь'],
    [4, 50, 25, 1980, 'M', 'Аня', 'приложение повторило отправку'], [5, 5, 1, 540, 'K', 'Зоя'], [6, 0, 2, 2750, 'M', 'Илья'], [6, 45, 1, 1300, 'S', 'Кира'],
    [7, 20, 90, 980, 'M', 'Лев', 'приложение было свёрнуто'], [8, 5, 1, 1640, 'K', 'Борис'], [8, 40, 1, 450, 'M', 'Вика'], [9, 30, 2, 2100, 'S', 'Глеб'],
    [10, 15, 1, 1870, 'M', 'Егор'], [11, 0, 1, 720, 'K', 'Зоя'], [11, 50, 1, 3150, 'M', 'Илья'], [12, 40, 190, 1260, 'S', 'Кира', 'в лифте без связи'],
    [13, 30, 1, 980, 'M', 'Аня'], [14, 20, 1, 1540, 'K', 'Дина'], [15, 30, 1, 2200, 'M', 'Лев'], [17, 10, 1, 860, 'S', 'Жанна'], [18, 40, 2, 1430, 'K', 'Борис'],
    [19, 35, 1, 1090, 'M', 'Вика'], [20, 30, 1, 1610, 'M', 'Егор'], [22, 10, 1, 830, 'K', 'Зоя'], [24, 0, 1, 1150, 'S', 'Глеб'], [25, 40, 1, 2040, 'M', 'Илья']
  ];
  const EV = RAW.map((r, i) => ({ i, n: 101 + i, et: T(12, r[0], r[1]), at: T(12, r[0], r[1]) + r[2], amt: r[3], city: r[4], user: r[5], why: r[6] || '', tail: r[0] >= 20 }));
  const EV20 = EV.filter(e => !e.tail);
  const sumOf = list => list.reduce((a, e) => a + e.amt, 0);
  const rad = a => 4 + Math.sqrt(a) / 14;
  /* бизнес: сеть магазинов у дома с онлайн-заказами */
  const BIZ = { day: 1500000, hours: 14, cost: 0.65, miss: 0.5, bonus: 0.01, acct: 1500, support: 350 };

  /* ---------- общие кусочки разметки: аналогия → фраза без терминов → термин ---------- */
  const ana = (life, plain, term) => `<div class="lsv-ana"><p class="lsv-life"><span class="lsv-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="lsv-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const seg = (name, items, cur, label) => `<div class="seg lsv-seg" role="group" aria-label="${esc(label || name)}">${items.map(([v, t]) => `<button type="button" data-set="${name}:${v}" aria-selected="${String(v) === String(cur)}">${t}</button>`).join('')}</div>`;
  const ctl = (label, html) => `<div class="lsv-ctl"><b>${label}</b>${html}</div>`;
  const tile = (label, val, sub, cls) => `<div class="lsv-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const card = (cls, html) => `<div class="lsv-card ${cls || ''}">${html}</div>`;
  const asm = list => `<details class="lsv-asm" open><summary>Допущения для расчёта</summary><ul>${list.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul></details>`;
  const cdot = c => `<i class="lsv-cd ${c}" aria-hidden="true"></i>`;
  const legend = items => `<div class="lsv-legend">${items.map(([c, t]) => `<span><i class="lsv-lg ${c}"></i>${t}</span>`).join('')}</div>`;

  /* ================= 1. Окна ================= */
  const WT0 = T(12, 0), WT1 = T(12, 20);
  const TUMB = [0, 1, 2, 3].map(k => ({ id: 't' + k, s: WT0 + k * 300, e: WT0 + (k + 1) * 300, row: 0 }));
  const SLID = []; for (let m = 0; m <= 15; m++) SLID.push({ id: 'h' + m, s: WT0 + m * 60, e: WT0 + m * 60 + 300, row: m % 5 });
  const inW = (w, e) => e.et >= w.s && e.et < w.e;
  const ST0 = T(10, 0), ST1 = T(14, 10), GAP = 1800;
  const SESS_U = [
    ['Аня', 'M', [[10, 5, 450], [10, 20, 1200], [10, 41, 300], [12, 30, 2100], [12, 52, 640]]],
    ['Борис', 'K', [[10, 30, 3200], [11, 50, 900], [12, 15, 1500], [12, 40, 700], [13, 5, 400]]],
    ['Вика', 'M', [[11, 10, 1800], [11, 38, 250], [13, 30, 5400]]],
    ['Глеб', 'S', [[10, 50, 600], [11, 25, 990], [11, 40, 320]]]
  ];
  const SEV = []; SESS_U.forEach((u, ui) => u[2].forEach(([h, m, a]) => SEV.push({ i: SEV.length, ui, user: u[0], city: u[1], et: T(h, m), amt: a })));
  const SESS = [];
  SESS_U.forEach((u, ui) => { let cur = null; SEV.filter(e => e.ui === ui).forEach(e => { if (cur && e.et - cur.last <= GAP) { cur.evs.push(e); cur.last = e.et; } else { cur = { ui, user: u[0], evs: [e], first: e.et, last: e.et }; SESS.push(cur); } }); });
  SESS.forEach(s => { s.close = s.last + GAP; s.sum = sumOf(s.evs); });
  const KINDS = [['tumble', 'Окна подряд', 'tumbling · по 5 минут'], ['slide', 'Скользящие окна', 'sliding · 5 мин, шаг 1 мин'], ['session', 'Сессии', 'session · пауза 30 минут']];
  const WINFO = {
    tumble: {
      life: 'Кассир снимает кассу каждые 5 минут: пересчитал, записал итог, начал новый отрезок с нуля. Каждый чек попадает ровно в один отрезок.',
      plain: 'Время режем на одинаковые куски без промежутков. Каждая покупка — ровно в одном куске. Кусок кончился — сразу выдаём его сумму.',
      term: '<b>Tumbling window</b> — неперекрывающееся окно фиксированной длины: <code>TUMBLE(event_time, INTERVAL \'5\' MINUTE)</code>. Один результат на окно, в момент его конца; между концами окон нового результата нет.'
    },
    slide: {
      life: 'Табло «выручка за последние 5 минут» обновляется каждую минуту: в 12:06 показывает 12:01–12:06, в 12:07 — 12:02–12:07. Один и тот же чек виден на табло пять раз подряд.',
      plain: 'Окна той же длины, но новое начинается каждую минуту — и они накладываются. Каждая покупка попадает в пять окон, график получается плавным, без ступенек.',
      term: '<b>Sliding (hopping) window</b> — размер 5 минут, шаг 1 минута: <code>HOP(event_time, INTERVAL \'1\' MINUTE, INTERVAL \'5\' MINUTE)</code>. Окон и пересчётов в размер ÷ шаг = 5 раз больше, чем у tumbling.'
    },
    session: {
      life: 'Визит в магазин: покупатель ходит между полками и кладёт товары в корзину. Если 30 минут ничего не берёт — считаем, что он ушёл, и пробиваем чек за визит.',
      plain: 'Окно не по часам, а по паузам: пока человек покупает чаще, чем раз в 30 минут, — это один визит. Пауза дольше — визит кончился, считаем его сумму.',
      term: '<b>Session window</b> с паузой (gap) 30 минут, у каждого покупателя свои окна: <code>SESSION(event_time, INTERVAL \'30\' MINUTE)</code> с ключом user_id. Длина окна заранее неизвестна, результат выходит через 30 минут после последней покупки.'
    }
  };
  /* скользящие окна, в которые попадает покупка: начала кратны минуте, s ≤ et < s + 5 мин */
  const slidesOf = e => { const b = Math.floor(e.et / 60) * 60, out = []; for (let j = 4; j >= 0; j--) { const s = b - j * 60; out.push({ s, e: s + 300, shown: s >= WT0 && s <= WT0 + 15 * 60 }); } return out; };

  /* ================= 2. Время события и опоздания ================= */
  const LT0 = T(12, 0), LT1 = T(12, 27), LATENESS = 600;
  const LWIN = [0, 1, 2, 3, 4, 5].map(k => ({ k, s: LT0 + k * 300, e: LT0 + (k + 1) * 300 }));
  const DS = [[0, 'Не ждать'], [30, '30 секунд'], [120, '2 минуты'], [300, '5 минут']];
  const POLS = [['drop', 'Отбросить', 'окно уже выдано — покупка теряется'], ['recalc', 'Пересчитать окно', 'allowed lateness 10 мин — поправка'], ['side', 'В отдельный поток', 'side output — досчитаем позже']];
  /* прогон: покупки по времени прихода; watermark = max(время события) − задержка; окно закрывается, когда watermark прошёл его конец */
  function lateRun(D, pol) {
    const evs = EV.slice().sort((a, b) => a.at - b.at || a.et - b.et);
    let maxEt = -Infinity;
    const W = LWIN.map(w => Object.assign({}, w, { fireAt: null, wmFire: null, first: 0, firstN: 0, cur: 0, n: 0, upd: [] }));
    const R = { st: {}, wm: [], side: [], drop: [], upd: [], W, D, pol };
    evs.forEach(e => {
      const t = e.at, wm = maxEt - D, w = W.find(x => e.et >= x.s && e.et < x.e);
      let st;
      if (w.fireAt == null) { st = 'ok'; w.cur += e.amt; w.n++; }
      else if (pol === 'recalc' && wm < w.e + LATENESS) { st = 'upd'; w.cur += e.amt; w.n++; const u = { t, e, amt: e.amt, w: w.k, total: w.cur }; w.upd.push(u); R.upd.push(u); }
      else if (pol === 'side') { st = 'side'; R.side.push({ t, e, amt: e.amt, w: w.k }); }
      else { st = 'drop'; R.drop.push({ t, e, amt: e.amt, w: w.k }); }
      R.st[e.i] = { st, w: w.k, late: st !== 'ok', ooo: st === 'ok' && e.et < maxEt };
      if (e.et > maxEt) { maxEt = e.et; R.wm.push([t, maxEt - D]); }
      W.forEach(x => { if (x.fireAt == null && maxEt - D >= x.e) { x.fireAt = t; x.wmFire = maxEt - D; x.first = x.cur; x.firstN = x.n; } });
    });
    W.forEach(x => { x.truth = sumOf(EV.filter(e => e.et >= x.s && e.et < x.e)); });
    return R;
  }
  const wmAt = (R, t) => { let v = null; for (const [a, w] of R.wm) { if (a <= t) v = w; else break; } return v; };
  /* итог по окнам 12:00–12:20: они закрываются при любой задержке */
  function lateSum(R) {
    const W4 = R.W.slice(0, 4), truth = sumOf(W4.map(w => ({ amt: w.truth }))), first = sumOf(W4.map(w => ({ amt: w.first }))), fin = sumOf(W4.map(w => ({ amt: w.cur })));
    return { delay: W4.reduce((a, w) => a + w.fireAt - w.e, 0) / 4, truth, first, fin, acc1: first / truth, accF: fin / truth, lost: sumOf(R.drop.filter(x => x.w < 4)), side: sumOf(R.side.filter(x => x.w < 4)), nLate: R.drop.concat(R.side, R.upd).filter(x => x.w < 4).length };
  }
  const TRADE = DS.map(([D, n]) => ({ D, n, s: lateSum(lateRun(D, 'drop')) }));
  const LATE_TXT = {
    life: 'Фото из отпуска: телефон был без сети, и снимки, сделанные в 12:03, загрузились в облако только в 12:09. Альбом по дате съёмки получается правильным, лента по дате загрузки — перепутанной. А собрать альбом «за день» можно, только когда уверен, что все снимки этого дня уже доехали.',
    plain: 'У каждой покупки два времени: когда её сделали и когда она дошла до сервера. Выручку за 12:00–12:05 считаем по первому. Но покупки приходят не по порядку — и система решает, сколько ещё ждать отставших, прежде чем выдать итог окна.',
    term: '<b>Event time</b> — время события, <b>processing time</b> — время обработки. <b>Watermark</b> — отметка «всё, что раньше, уже пришло»; здесь <code>max(event_time) − задержка</code>. Окно закрывается, когда watermark проходит его конец. Событие, пришедшее позже, — <b>опоздавшее (late)</b>: его отбрасывают, пересчитывают окно в пределах <b>allowed lateness</b> или отправляют в <b>side output</b>.'
  };

  /* ================= 3. Состояние и «ровно один раз» ================= */
  const SEVQ = EV20.slice().sort((a, b) => a.at - b.at || a.et - b.et);   /* порядок в топике = порядок прихода */
  const zero = () => ({ M: 0, K: 0, S: 0 });
  const GUAR = [['alo', 'At-least-once', 'пишем сразу — после падения повтор'], ['eo', 'Exactly-once', 'транзакция фиксируется с чекпойнтом'], ['idem', 'Идемпотентный приёмник', 'повтор того же id не добавляется']];
  const EVERY = [[3, 'каждые 3 покупки'], [5, 'каждые 5'], [10, 'каждые 10']];
  const CRASH = [[13, 'после 13-й покупки'], [0, 'только вручную']];
  const SINK_SQL = {
    alo: '-- после каждой покупки, сразу:\nUPDATE city_revenue SET revenue = revenue + :amount\n WHERE city = :city;          -- повтор прибавит ещё раз',
    eo: '-- покупки копятся в открытой транзакции:\nBEGIN; UPDATE city_revenue SET revenue = revenue + :amount ...;\n-- чекпойнт завершён → COMMIT; упали до него → ROLLBACK',
    idem: 'INSERT INTO purchase_revenue (purchase_id, city, amount)\nVALUES (:id, :city, :amount)\nON CONFLICT (purchase_id) DO NOTHING;   -- повтор ничего не меняет'
  };
  const ST_TXT = {
    life: 'Кассир считает выручку по городам на калькуляторе — это состояние. Каждые 5 чеков он переписывает итоги в тетрадь и кладёт закладку в ленту чеков — это чекпойнт. Калькулятор сломался — берём итоги из тетради, перематываем ленту к закладке и досчитываем. Но если после каждого чека кассир ещё и звонил в бухгалтерию, то чеки после закладки бухгалтерия услышит дважды.',
    plain: 'Поток помнит промежуточные суммы и регулярно сохраняет их вместе с местом, где остановился. После падения он возвращается к сохранённому месту и перечитывает хвост. Чтобы приёмник не посчитал хвост второй раз, запись в него либо фиксируют вместе с сохранением, либо приёмник сам узнаёт повторы.',
    term: '<b>Состояние</b> оператора (keyed state — здесь сумма по городу) живёт в памяти или RocksDB. <b>Чекпойнт</b>: источник вставляет в поток <b>барьер</b>; когда барьер доходит до оператора, его состояние и <b>offset</b> в Kafka сохраняются в S3. После падения — откат к последнему чекпойнту и повтор событий после него. <b>At-least-once</b>: приёмник получает повторы — дубли. <b>Exactly-once</b>: приёмник пишет транзакцией и фиксирует её, когда чекпойнт завершён (two-phase commit). <b>Идемпотентный приёмник</b>: запись по ключу события, повтор ничего не меняет.'
  };
  function stNew(mode, every, auto) {
    return { mode, every, auto, off: 0, state: zero(), ck: [{ n: 0, off: 0, state: zero() }], sink: zero(), pend: [], seen: {}, writes: {}, phase: 'run', crashed: 0, crashOff: null, rFrom: null, maxOff: 0, log: [], dup: 0, dupN: 0, skip: 0, replay: 0, last: null, lastCk: null, ev: null, end: false };
  }
  function stCrash(S) {
    if (S.phase !== 'run' || S.end || S.off === 0) return false;
    S.phase = 'down'; S.crashed++; S.crashOff = S.off; S.state = null; S.last = null; S.lastCk = null; S.ev = 'crash';
    S.log.push({ cls: 'bad', h: `<b>Оператор упал</b> после offset ${S.off - 1}: суммы в памяти потеряны${S.mode === 'alo' ? `, а витрина уже получила покупки до offset ${S.off - 1} включительно` : S.mode === 'eo' ? `; в открытой транзакции ${S.pend.length} ${plural(S.pend.length, 'запись', 'записи', 'записей')} — их ещё никто не видел` : ''}` });
    return true;
  }
  function stStep(S) {
    if (S.end) return;
    S.last = null; S.lastCk = null; S.ev = null;
    const N = SEVQ.length, lg = (cls, h) => S.log.push({ cls, h });
    if (S.phase === 'down') {
      const c = S.ck[S.ck.length - 1], lost = S.pend.length;
      S.state = Object.assign({}, c.state); S.pend = []; S.rFrom = c.off; S.off = c.off; S.phase = 'run'; S.ev = 'restore';
      lg('warn', `<b>Перезапуск</b>: суммы взяли из чекпойнта #${c.n}, offset в топике отмотали к ${c.off} — покупки ${c.off}…${S.crashOff - 1} прочитаем ещё раз${S.mode === 'eo' && lost ? `. Открытую транзакцию (${lost} ${plural(lost, 'запись', 'записи', 'записей')}) отменили — в витрину она не попала` : ''}`);
      return;
    }
    if (S.off >= N) { S.end = true; lg('ok', S.mode === 'eo' ? 'Топик прочитан до конца, все транзакции зафиксированы' : 'Топик прочитан до конца'); return; }
    const e = SEVQ[S.off], o = S.off, re = o < S.maxOff;
    S.state[e.city] += e.amt;
    if (re) S.replay++;
    if (S.mode === 'alo') { S.sink[e.city] += e.amt; S.writes[o] = (S.writes[o] || 0) + 1; if (S.writes[o] > 1) { S.dup += e.amt; S.dupN++; } }
    else if (S.mode === 'eo') S.pend.push({ o, city: e.city, amt: e.amt });
    else if (S.seen[e.n]) S.skip++;
    else { S.seen[e.n] = 1; S.sink[e.city] += e.amt; }
    lg(re ? (S.mode === 'alo' ? 'bad' : 'inf') : '', `offset ${o}: №${e.n} ${CITY[e.city]} +${rub(e.amt)}${re ? (S.mode === 'alo' ? ' — <b>повтор</b>: витрина прибавила её второй раз' : S.mode === 'eo' ? ' — повтор, но прошлая запись была в отменённой транзакции' : ' — повтор: id уже записан, приёмник пропустил') : S.mode === 'eo' ? ' — в открытую транзакцию' : ''}`);
    S.off++; S.maxOff = Math.max(S.maxOff, S.off); S.last = o;
    if (S.off % S.every === 0 || S.off === N) {
      const n = S.ck.length;
      S.ck.push({ n, off: S.off, state: Object.assign({}, S.state) }); S.lastCk = n;
      let extra = '';
      if (S.mode === 'eo') { const k = S.pend.length; S.pend.forEach(p => { S.sink[p.city] += p.amt; }); S.pend = []; extra = ` и транзакция (${k} ${plural(k, 'запись', 'записи', 'записей')}) зафиксирована в витрине`; }
      lg('ok', `Барьер дошёл до оператора — <b>чекпойнт #${n}</b>: суммы и offset ${S.off} сохранены в S3${extra}`);
    }
    if (S.auto && !S.crashed && S.off === S.auto) stCrash(S);
  }
  const stTruth = S => { const r = zero(); SEVQ.slice(0, S.maxOff).forEach(e => { r[e.city] += e.amt; }); return r; };
  const tot = o => o.M + o.K + o.S;

  /* ================= 4. Соединение потоков: заказы JOIN оплаты ================= */
  const JT0 = T(12, 0), JT1 = T(12, 50), PWAIT = 600;
  /* заказ: [номер, минута создания, задержка прихода в поток (с), сумма, город] */
  const ORD = [[1001, 1, 0, 2300, 'M'], [1002, 4, 0, 640, 'K'], [1003, 6, 0, 1980, 'M'], [1004, 9, 0, 890, 'S'], [1005, 11, 0, 1120, 'M'], [1006, 14, 0, 2750, 'K'], [1007, 17, 120, 1300, 'S'], [1008, 20, 0, 980, 'M'], [1009, 26, 0, 1640, 'K'], [1010, 30, 0, 450, 'M'], [1012, 33, 0, 2100, 'S']]
    .map(([id, m, d, amt, city]) => ({ id, et: T(12, m), at: T(12, m) + d, amt, city }));
  /* оплата: [номер заказа, минута, секунда]; у №1011 заказа нет совсем */
  const PAY = [[1001, 3, 0], [1002, 5, 10], [1005, 12, 20], [1006, 15, 30], [1007, 18, 0], [1008, 21, 40], [1003, 22, 0], [1011, 25, 0], [1009, 27, 10], [1010, 31, 0], [1012, 39, 0]]
    .map(([id, m, s]) => { const o = ORD.find(x => x.id === id); return { id, t: T(12, m, s), amt: o ? o.amt : 3400, city: o ? o.city : 'K' }; });
  const JIDS = [...new Set(ORD.map(o => o.id).concat(PAY.map(p => p.id)))].sort((a, b) => a - b);
  const JWS = [[300, '5 минут'], [900, '15 минут'], [1800, '30 минут']];
  const JPOL = [['drop', 'Отбросить', 'заказа нет — оплату выкидываем'], ['wait', 'Подождать заказ', '10 минут, потом выкинуть'], ['side', 'Подождать, потом на сверку', '10 минут, потом — отдельный поток']];
  /* прогон: события по времени прихода; заказ ждёт оплату W после создания, оплата без заказа ждёт PWAIT (если не «отбросить») */
  function joinRun(W, pol) {
    const R = { W, pol, rows: {}, st: [], maxSt: 0 };
    JIDS.forEach(id => { R.rows[id] = { id, o: ORD.find(x => x.id === id) || null, p: PAY.find(x => x.id === id) || null, match: null, unpaid: null, pdrop: null, side: null, pwait: null }; });
    const Q = ORD.map(o => ({ t: o.at, k: 'o', id: o.id })).concat(PAY.map(p => ({ t: p.t, k: 'p', id: p.id }))).sort((a, b) => a.t - b.t || (a.k === 'o' ? -1 : 1));
    const os = new Map(), ps = new Map();
    const snap = t => { R.st.push([t, os.size, ps.size]); R.maxSt = Math.max(R.maxSt, os.size + ps.size); };
    const expire = t => {
      const xs = [];
      os.forEach((dl, id) => { if (dl < t) xs.push({ t: dl, k: 'o', id }); });
      ps.forEach((dl, id) => { if (dl < t) xs.push({ t: dl, k: 'p', id }); });
      xs.sort((a, b) => a.t - b.t).forEach(x => {
        if (x.k === 'o') { os.delete(x.id); R.rows[x.id].unpaid = x.t; }
        else { ps.delete(x.id); if (pol === 'side') R.rows[x.id].side = x.t; else R.rows[x.id].pdrop = x.t; }
        snap(x.t);
      });
    };
    Q.forEach(q => {
      expire(q.t);
      const r = R.rows[q.id];
      if (q.k === 'o') {
        if (ps.has(q.id) && r.p.t >= r.o.et && r.p.t <= r.o.et + W) { ps.delete(q.id); r.match = q.t; }
        else os.set(q.id, r.o.et + W);
      } else if (os.has(q.id)) { os.delete(q.id); r.match = q.t; }
      else { r.orph = q.t; if (pol === 'drop') r.pdrop = q.t; else { r.pwait = q.t; ps.set(q.id, q.t + PWAIT); } }
      snap(q.t);
    });
    expire(JT1 + 1e6);
    return R;
  }
  function joinSum(R, t) {
    const rows = JIDS.map(id => R.rows[id]), at = x => x != null && x <= t;
    const m = rows.filter(r => at(r.match)), paid = r => r.p && r.p.t <= t, unp = rows.filter(r => at(r.unpaid) && !paid(r)), bad = rows.filter(r => at(r.unpaid) && paid(r));
    const lost = rows.filter(r => at(r.pdrop)), side = rows.filter(r => at(r.side));
    const cur = R.st.filter(s => s[0] <= t).pop() || [0, 0, 0];
    return { m, unp, bad, lost, side, mSum: m.reduce((a, r) => a + r.o.amt, 0), badSum: bad.reduce((a, r) => a + r.o.amt, 0), lostSum: lost.reduce((a, r) => a + r.p.amt, 0), sideSum: side.reduce((a, r) => a + r.p.amt, 0), cur: cur[1] + cur[2], curO: cur[1], curP: cur[2] };
  }
  const JOIN_TXT = {
    life: 'Кафе: официант записывает заказ в блокнот, касса присылает чек об оплате с номером заказа. Чтобы понять, что заказ оплачен, официант ищет номер в блокноте. Блокнот не бесконечный: заказ без оплаты через 15 минут вычёркивают как брошенный. А если чек пришёл раньше, чем официант дописал заказ, — чек нельзя выбрасывать: отложи и проверь через минуту.',
    plain: 'Два потока — заказы и оплаты — сводим по номеру заказа. Каждую сторону приходится помнить, пока не придёт пара, но не дольше окна, иначе кончится память. Всё, что не нашло пару в окне, требует решения: отменить заказ, подождать, отправить на сверку.',
    term: '<b>Stream-stream join</b> (здесь — interval join): заказ и оплата с одним order_id, если оплата не позже чем через окно после создания заказа. Обе стороны лежат в <b>состоянии</b> оператора, пока окно открыто: окно больше — больше памяти и позже вывод «не оплачен». Событие без пары — <b>unmatched</b>: его отбрасывают или отправляют в <b>side output</b> (dead letter) на сверку.'
  };

  /* ================= 5. Происхождение данных и контракты ================= */
  const LN = [
    { id: 'src', col: 0, t: 'orders', k: 'PostgreSQL' },
    { id: 'cdc', col: 1, t: 'CDC', k: 'Debezium' },
    { id: 'topic', col: 2, t: 'shop.orders', k: 'Kafka-топик' },
    { id: 'flow', col: 3, t: 'revenue_stream', k: 'Flink-поток' },
    { id: 'mart', col: 4, t: 'mart_revenue', k: 'ClickHouse' },
    { id: 'd1', col: 5, t: 'Выручка по городам', k: 'управляющие' },
    { id: 'd2', col: 5, t: 'Средний чек', k: 'маркетинг' },
    { id: 'd3', col: 5, t: 'План закупок', k: 'автозаказ поставщикам' }
  ];
  const LE = [['src', 'cdc'], ['cdc', 'topic'], ['topic', 'flow'], ['flow', 'mart'], ['mart', 'd1'], ['mart', 'd2'], ['mart', 'd3']];
  const SRC_COLS = ['order_id', 'created_at', 'amount', 'city', 'status', 'user_id'];
  const FLOW_COLS = ['created_at', 'amount', 'city', 'status'];
  const MART_COLS = ['window_start', 'city', 'revenue', 'orders_cnt'];
  const GUARDS = [['none', 'Без защиты', 'заметят люди по дашбордам'], ['test', 'Тесты данных', 'проверка витрины перед публикацией'], ['contract', 'Контракт данных', 'проверка схемы в CI команды «Заказы»']];
  /* статусы: ok — цел, warn — изменился, но работает, bad — сломан или врёт, stop — остановлен защитой, stale — показывает старые верные данные */
  const CHG = {
    rename: {
      n: 'Переименовать amount → total', d: 'RENAME COLUMN', col: 'amount', breaks: true, test: 'выручка за 5 минут > 0 и в пределах ×0,3…×3 от прошлой недели',
      sql: 'ALTER TABLE orders RENAME COLUMN amount TO total;',
      hit: {
        src: ['warn', 'колонка amount теперь называется total', 'разработчики заказов сделали «косметическое» переименование'],
        cdc: ['ok', 'Debezium передаёт как есть: в сообщениях вместо amount — total', 'перенос изменений работает'],
        topic: ['warn', 'в топике новая схема: поля amount больше нет', 'в канале данных пропало поле суммы'],
        flow: ['bad', 'поток читает amount → NULL, SUM(NULL) = 0. Задание не падает — ошибка тихая', 'подсчёт выручки молча считает нули'],
        mart: ['bad', 'выручка 0 ₽ во всех окнах после 14:05', 'в витрине выручка 0 ₽'],
        d1: ['bad', 'все три города — 0 ₽', 'управляющие видят «продаж нет»'],
        d2: ['bad', 'средний чек 0 ₽ (или деление на ноль)', 'маркетинг видит обвал среднего чека'],
        d3: ['bad', 'план закупок: заказать 0 — автозаказ не уйдёт', 'завтра пустые полки']
      }
    },
    add: {
      n: 'Добавить поле promo_code', d: 'ADD COLUMN … NULL', col: null, breaks: false, test: '',
      sql: 'ALTER TABLE orders ADD COLUMN promo_code text NULL;',
      hit: {
        src: ['ok', 'новое необязательное поле', 'добавили поле для промокода'], cdc: ['ok', 'поле появилось в сообщениях', 'перенос работает'],
        topic: ['ok', 'схема v1.4 совместима: поле необязательное', 'канал данных совместим'], flow: ['ok', 'поток это поле не читает — ничего не меняется', 'подсчёт выручки не заметил'],
        mart: ['ok', 'без изменений', 'без изменений'], d1: ['ok', 'цел', 'цифры верные'], d2: ['ok', 'цел', 'цифры верные'], d3: ['ok', 'цел', 'автозаказ верный']
      }
    },
    drop: {
      n: 'Удалить колонку city', d: 'DROP COLUMN', col: 'city', breaks: true, test: 'city не пустой у 99 % строк',
      sql: 'ALTER TABLE orders DROP COLUMN city;  -- город теперь в таблице stores',
      hit: {
        src: ['warn', 'колонки city больше нет', 'город перенесли в другую таблицу'], cdc: ['ok', 'передаёт как есть', 'перенос работает'],
        topic: ['warn', 'в сообщениях нет city', 'в канале пропал город'], flow: ['bad', 'GROUP BY city → все продажи в группе NULL', 'выручка больше не делится по городам'],
        mart: ['bad', 'вся выручка в городе «неизвестно»', 'город «неизвестно» — 100 % выручки'], d1: ['bad', 'вместо трёх городов — один «неизвестно»', 'управляющие городов не видят свои продажи'],
        d2: ['ok', 'средний чек от города не зависит — цел', 'средний чек верный'], d3: ['bad', 'план по городам пустой: склад не знает, куда везти', 'склад не знает, куда везти товар']
      }
    },
    type: {
      n: 'Хранить amount в копейках', d: 'ALTER COLUMN TYPE', col: 'amount', breaks: true, test: 'выручка за 5 минут в пределах ×0,3…×3 от прошлой недели',
      sql: 'ALTER TABLE orders ALTER COLUMN amount TYPE bigint\n  USING (amount * 100)::bigint;  -- теперь в копейках',
      hit: {
        src: ['warn', 'amount теперь в копейках (bigint)', 'суммы теперь в копейках'], cdc: ['ok', 'передаёт как есть', 'перенос работает'],
        topic: ['warn', 'тип поля сменился: decimal → int64', 'в канале суммы стали в 100 раз больше'], flow: ['bad', 'суммирует как раньше — числа в 100 раз больше; тихо', 'подсчёт выручки ошибается в 100 раз'],
        mart: ['bad', 'выручка 3,5 млн ₽ за 20 минут вместо 35 тыс.', 'выручка в 100 раз больше настоящей'], d1: ['bad', 'выручка ×100', 'рекордная выручка, которой нет'],
        d2: ['bad', 'средний чек 140 000 ₽ вместо 1 400 ₽', 'средний чек 140 000 ₽'], d3: ['bad', 'автозаказ в 100 раз больше обычного', 'автозаказ на склад в 100 раз больше']
      }
    }
  };
  const CHG_ORDER = ['rename', 'add', 'drop', 'type'];
  const DTESTS = [['revenue_positive', 'выручка за 5 минут > 0'], ['revenue_range', 'выручка в пределах ×0,3…×3 от той же пятиминутки неделю назад'], ['city_not_null', 'city заполнен у 99 % строк'], ['freshness', 'последнее окно не старше 10 минут']];
  const TEST_FAIL = { rename: ['revenue_positive', 'revenue_range'], drop: ['city_not_null'], type: ['revenue_range'], add: [] };
  /* итоговые статусы узлов с учётом защиты */
  function linStatus(chg, guard) {
    const C = CHG[chg], out = {};
    LN.forEach(n => { out[n.id] = C ? C.hit[n.id].slice() : ['idle', '', '']; });
    if (!C || !C.breaks) return out;
    if (guard === 'contract') {
      LN.forEach(n => { out[n.id] = n.id === 'src' ? ['stop', 'сборка остановлена: изменение несовместимо с контрактом shop.orders v1', 'изменение не прошло проверку ещё у разработчиков'] : ['ok', 'не затронут — изменение не вышло из сборки', 'цифры верные']; });
    } else if (guard === 'test') {
      out.mart = ['stop', `тест упал (${TEST_FAIL[chg].join(', ')}) — новая версия витрины не опубликована`, 'проверка не пустила неверные цифры в витрину'];
      ['d1', 'd2', 'd3'].forEach(k => { out[k] = ['stale', 'показывает данные на 14:05 с плашкой «данные задерживаются»', 'старые, но верные цифры с плашкой «обновление задерживается»']; });
    }
    return out;
  }
  const LIN_TXT = {
    life: 'Водопровод в доме: если в подвале переделать трубу, вода пропадёт на всех этажах выше — и жильцы узнают об этом последними. Схема труб — это происхождение данных, табличка на вентиле «кто отвечает и что можно трогать» — контракт, датчик давления на этаже — тест данных.',
    plain: 'Данные текут от базы заказов через несколько систем к дашбордам, по которым люди принимают решения. Карта этого пути показывает, что сломается, если поменять что-то в начале. Договор между владельцем данных и потребителями задаёт, что менять можно, а что — только через новую версию. Проверки перед публикацией не дают ошибке дойти до людей.',
    term: '<b>Data lineage</b> — граф происхождения данных до уровня колонок: таблица → CDC → топик → поток → витрина → дашборды. <b>Data contract</b> — схема, владелец, SLA свежести и правила изменений; проверяется в CI производителя и в Schema Registry (совместимость BACKWARD). <b>Эволюция схемы</b>: добавить необязательное поле можно; удалить, переименовать, сменить тип — только через новую версию и период параллельной публикации. <b>Тест данных</b> (dbt test, Great Expectations) останавливает публикацию витрины до дашборда.'
  };
  const CONTRACT = `contract: shop.orders          <span class="lsv-cm"># версия 1.3.0</span>
owner: команда «Заказы» · дежурный @orders-oncall
consumers: revenue_stream, antifraud
schema:
  order_id:   string, обязательно, уникально
  created_at: timestamp, обязательно
  amount:     decimal(12,2), рубли, обязательно, ≥ 0
  city:       string, обязательно
  status:     enum [new, paid, cancelled]
freshness: событие в топике ≤ 5 мин после записи в базу
compatibility: BACKWARD    <span class="lsv-cm"># добавлять можно, ломать — только в v2</span>`;
  const EVOL = [['Добавить необязательное поле', 'можно', 'старые читатели его просто не видят', 'ok'], ['Добавить обязательное поле', 'через значение по умолчанию', 'иначе старые сообщения не прочитать', 'warn'], ['Переименовать поле', 'через версию', 'добавить новое, публиковать оба, удалить старое после перехода всех потребителей', 'bad'], ['Удалить поле', 'через версию', 'v2 + период параллельной публикации (например, 30 дней)', 'bad'], ['Сменить тип или единицы', 'через новое поле', 'amount_kop рядом с amount, потом миграция потребителей', 'bad']];

  /* ================= экземпляр лаборатории ================= */
  const MODE_KEY = 'amp-stroyka-lsv-mode';
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
  const TABS = [['win', '1', 'Окна'], ['late', '2', 'Опоздания'], ['state', '3', 'Ровно один раз'], ['join', '4', 'Соединение'], ['lin', '5', 'Происхождение'], ['memo', '✓', 'Итоги']];
  const NEXT = { win: ['late', 'время события и опоздания'], late: ['state', 'состояние и «ровно один раз»'], state: ['join', 'соединение потоков'], join: ['lin', 'происхождение данных и контракты'], lin: ['memo', 'что запомнить'] };
  const nextBtn = k => NEXT[k] ? `<div class="lsv-next"><button type="button" class="btn" data-go="${NEXT[k][0]}">Дальше: ${NEXT[k][1]} →</button></div>` : '';

  function makeLab(EL, doneFn) {
    let MODE = readMode();
    const U = {
      tab: 'win', alive: true, timer: 0, spd: 1, last: 0, sig: {},
      win: { kind: 'tumble', t: WT0, play: false, sel: null },
      late: { D: 0, pol: 'drop', t: 0, play: false },
      st: { mode: 'alo', every: 5, auto: 13, S: null, play: false, acc: 0, saw: {} },
      join: { W: 900, pol: 'drop', t: 0, play: false },
      lin: { chg: null, guard: 'none', at: 0 }
    };
    const done = id => { try { doneFn(id); } catch (e) { /* задания не засчитываются — не страшно */ } };
    const isBiz = () => MODE === 'biz';
    const $ = s => EL.querySelector(s);

    /* ---------- часы вкладок ---------- */
    const CLK = {
      win: () => U.win.kind === 'session' ? { s: ST0, e: T(14, 5), rate: 600, step: 600 } : { s: WT0, e: WT1 + 5, rate: 60, step: 60 }
    };
    const P = () => U[U.tab] && CLK[U.tab] ? U[U.tab] : null;
    const animOn = p => p && p.play && !isCalm();
    function startTimer() { if (!U.timer) { U.last = performance.now(); U.timer = setInterval(tick, 50); } }
    function stopTimer() { if (U.timer) clearInterval(U.timer); U.timer = 0; }
    function tick() {
      if (!U.alive) { stopTimer(); return; }
      const now = performance.now(), dt = Math.min(0.25, (now - U.last) / 1000); U.last = now;
      if (U.tab === 'state' && U.st.play && TICKS.state) { TICKS.state(dt); return; }
      if (U.tab === 'lin' && TICKS.lin) { if (!TICKS.lin()) stopTimer(); return; }
      const p = P();
      if (!p || !p.play) { stopTimer(); draw(); return; }
      const c = CLK[U.tab]();
      p.t = Math.min(c.e, p.t + c.rate * U.spd * dt);
      if (p.t >= c.e) { p.play = false; stopTimer(); }
      clockMoved(); draw();
    }
    const TICKS = {};
    function resetClock(k) { const p = U[k], c = CLK[k](); p.t = c.s; p.play = false; }
    function act(a) {
      if (U.tab === 'state' && ACTS.state) { ACTS.state(a); return; }
      const p = P(); if (!p) return;
      const c = CLK[U.tab]();
      if (a === 'play') {
        if (p.play) { p.play = false; stopTimer(); draw(); return; }
        if (p.t >= c.e) p.t = c.s;
        if (isCalm()) { p.t = c.e; clockMoved(); draw(); return; }
        p.play = true; startTimer(); draw(); return;
      }
      if (a === 'step') { p.play = false; stopTimer(); p.t = Math.min(c.e, p.t + c.step); }
      else if (a === 'end') { p.play = false; stopTimer(); p.t = c.e; }
      else if (a === 'reset') { p.play = false; stopTimer(); p.t = c.s; }
      clockMoved(); draw();
    }
    const ACTS = {};
    function clockMoved() {
      if (U.tab === 'win' && U.win.kind === 'tumble' && U.win.t >= TUMB[3].e) done('tumble');
      if (CHECKS[U.tab]) CHECKS[U.tab]();
    }
    const CHECKS = {};
    function playBar() {
      const p = P(); if (!p) return '';
      const c = CLK[U.tab](), end = p.t >= c.e, start = p.t <= c.s;
      return `<button type="button" class="btn primary" data-act="play">${p.play ? 'Пауза' : end ? 'Ещё раз' : start ? 'Пуск' : 'Дальше'}</button><button type="button" class="btn" data-act="step" ${end ? 'disabled' : ''}>+${dur(c.step)}</button><button type="button" class="btn" data-act="end" ${end ? 'disabled' : ''}>До конца</button><button type="button" class="btn ghost" data-act="reset" ${start ? 'disabled' : ''}>Сначала</button>`;
    }
    const playCtl = () => `<div class="lsv-play"><div class="lsv-btns" id="lsvPlay">${playBar()}</div>${seg('spd', [[0.5, 'Медленно'], [1, 'Обычно'], [3, 'Быстро']], U.spd, 'Скорость показа')}</div>`;
    /* перерисовать кусок, только если поменялась подпись */
    function put(sel, key, fn) { const el = $(sel); if (!el) return; if (U.sig[sel] === key && el.firstChild) return; U.sig[sel] = key; el.innerHTML = fn(); }
    const stageW = (el, min) => Math.max(min || 620, Math.floor((el && el.clientWidth) || 860));

    /* ---------- шапка ---------- */
    function setTab(k) {
      if (!TABS.some(t => t[0] === k)) return;
      const p = P(); if (p) p.play = false;
      if (U.st.play) U.st.play = false;
      stopTimer();
      U.tab = k;
      EL.querySelectorAll('.lsv-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.lsv-tabs'), box = EL.closest('.lab-main');
      if (tabs && box && tabs.getBoundingClientRect().top < box.getBoundingClientRect().top) tabs.scrollIntoView({ block: 'start' });
    }
    function setMode(m) {
      MODE = m === 'biz' ? 'biz' : 'tech';
      try { localStorage.setItem(MODE_KEY, MODE); } catch (e) { /* без хранилища */ }
      EL.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === MODE)));
      const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0;
      render(); if (box) box.scrollTop = y;
    }
    const VIEWS = {}, DRAWS = {};
    function render() {
      const v = $('#lsvView'); if (!v) return;
      U.sig = {};
      v.innerHTML = VIEWS[U.tab] ? VIEWS[U.tab]() : card('', 'Раздел готовится.');
      draw();
    }
    function draw() {
      if (!U.alive) return;
      if (DRAWS[U.tab]) DRAWS[U.tab]();
      const pb = $('#lsvPlay'); if (pb && P()) { const p = P(), c = CLK[U.tab](); const k = [p.play, p.t >= c.e, p.t <= c.s].join(); if (pb.dataset.k !== k) { pb.dataset.k = k; pb.innerHTML = playBar(); } }
    }

    /* ================= вкладка 1: окна ================= */
    VIEWS.win = () => {
      const k = U.win.kind, I = WINFO[k], B = isBiz();
      return `<div class="lsv-kinds" role="group" aria-label="Вид окон">${KINDS.map(([v, n, s]) => `<button type="button" data-set="wkind:${v}" aria-pressed="${v === k}"><b>${n}</b><small>${s}</small></button>`).join('')}</div>
        ${ana(I.life, I.plain, B ? '' : I.term)}
        ${playCtl()}
        <div class="lsv-stage" id="lsvStage"></div>
        ${legend(k === 'session' ? [['M', 'Москва'], ['K', 'Казань'], ['S', 'Самара'], ['sess', 'визит идёт'], ['wait', 'ждём 30 минут тишины'], ['done', 'визит закрыт — итог']] : [['M', 'Москва'], ['K', 'Казань'], ['S', 'Самара'], ['open', 'окно копит'], ['done', 'окно закрыто — итог выдан']])}
        <div class="lsv-kpis" id="lsvKpis"></div>
        <div class="lsv-two"><div class="lsv-box"><b class="lsv-h">Лента покупок${k === 'session' ? '' : ' · нажми — покажу её окна'}</b><ol class="lsv-feed" id="lsvFeed"></ol></div><div class="lsv-box"><b class="lsv-h">${k === 'session' ? 'Закрытые визиты' : 'Результаты окон'}</b><ol class="lsv-res" id="lsvRes"></ol></div></div>
        <div id="lsvNote"></div>
        ${nextBtn('win')}`;
    };
    function winSVG(W) {
      const p = U.win, t = p.t, slide = p.kind === 'slide', wins = slide ? SLID : TUMB, sel = p.sel != null ? EV20[p.sel] : null;
      const L = 16, R = 16, X = s => L + (s - WT0) / (WT1 - WT0) * (W - L - R);
      const an = animOn(p), span = 60 * U.spd * 0.5, ak = age => an ? clamp(age / span, 0, 1) : 1;
      const laneY = 48, laneH = 48, wy = 114, rowH = slide ? 30 : 80, H = slide ? wy + 5 * rowH + 8 : wy + rowH + 56;
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Поток покупок и окна по времени события">`;
      h += tx(L, 16, 'Поток покупок · по времени события →', 'lsv-st') + tx(W - R, 16, '⏱ ' + hms(Math.min(t, WT1)), 'lsv-clock', 'end');
      for (let m = 0; m <= 20; m++) { const x = X(WT0 + m * 60), big = m % 5 === 0; h += ln(x, 40, x, big ? 47 : 44, 'lsv-tick'); if (big) h += tx(x, 35, hm(WT0 + m * 60), 'lsv-ax', m === 0 ? 'start' : m === 20 ? 'end' : 'middle'); }
      h += rc(L, laneY, W - L - R, laneH, 'lsv-lane', 8);
      const xn = X(clamp(t, WT0, WT1));
      if (t < WT1) h += rc(xn, laneY + 1, W - R - xn - 1, laneH - 2, 'lsv-future', 7);
      /* окна */
      wins.forEach(w => {
        const x1 = X(w.s) + 1.5, x2 = X(w.e) - 1.5, y = wy + w.row * rowH, hh = slide ? rowH - 6 : rowH;
        const evs = EV20.filter(e => inW(w, e) && e.et <= t), sum = sumOf(evs), closed = t >= w.e, open = t >= w.s && !closed;
        const fl = closed && an && t - w.e < span * 1.6, hit = sel && inW(w, sel);
        h += rc(x1, y, x2 - x1, hh, `lsv-win ${closed ? 'closed' : open ? 'open' : 'fut'}${fl ? ' flash' : ''}${hit ? ' hit' : ''}`, slide ? 5 : 8);
        if (!slide) {
          h += tx(x1 + 9, y + 18, `${hm(w.s)}–${hm(w.e)}`, 'lsv-wt');
          h += tx(x1 + 9, y + hh - 10, closed ? `✓ итог ${rub(sum)}` : open ? `копит: ${rub(sum)}` : 'ещё не началось', closed ? 'lsv-wv ok' : open ? 'lsv-wv' : 'lsv-wv mut');
          evs.forEach(e => {
            const k = ak(t - e.et), y0 = laneY + laneH / 2 + (e.i % 2 ? 9 : -9), y1 = y + 40 + ((e.i % 3) - 1) * 7;
            h += cir(X(e.et), y0 + (y1 - y0) * k, rad(e.amt) * 0.8, `lsv-dot ${e.city}${sel === e ? ' sel' : ''}`);
          });
          if (closed) {
            const op = an ? clamp((t - w.e) / span, 0, 1) : 1, cx = (x1 + x2) / 2, cy = y + hh + 26;
            h += `<g style="opacity:${op.toFixed(2)}">` + arrow(cx, y + hh + 2, cx, cy - 12, 'out') + rc(cx - 66, cy - 11, 132, 24, 'lsv-chip', 12) + tx(cx, cy + 5, '→ ' + rub(sum), 'lsv-chipt', 'middle') + '</g>';
          }
        } else {
          const lab = closed ? `✓ ${rub(sum)}` : open ? rub(sum) : '';
          if (lab) h += tx(x1 + 8, y + hh / 2 + 4.5, (x2 - x1 > 176 ? `${hm(w.s)}–${hm(w.e)} · ` : '') + lab, closed ? 'lsv-wv ok' : 'lsv-wv');
        }
      });
      /* поток: точки по времени события */
      EV20.forEach(e => {
        if (e.et > t) return;
        const x = X(e.et), y = laneY + laneH / 2 + (e.i % 2 ? 9 : -9), k = ak(t - e.et);
        h += `<g class="lsv-evg" data-ev="${e.i}">` + cir(x, y, 12, 'lsv-hit') + cir(x, y, rad(e.amt) * (0.4 + 0.6 * k), `lsv-dot ${e.city}${sel === e ? ' sel' : ''}`) + '</g>';
      });
      if (sel && sel.et <= t) h += ln(X(sel.et), laneY - 4, X(sel.et), H - 4, 'lsv-selln');
      if (t <= WT1) h += ln(xn, 40, xn, H - 4, 'lsv-now');
      return h + '</svg>';
    }
    function sessSVG(W) {
      const p = U.win, t = p.t, L = 118, R = 16, X = s => L + (s - ST0) / (ST1 - ST0) * (W - L - R);
      const an = animOn(p), span = 600 * U.spd * 0.5, ak = age => an ? clamp(age / span, 0, 1) : 1;
      const rowH = 56, y0 = 52, H = y0 + 4 * rowH + 4;
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Визиты четырёх покупателей: сессии с паузой 30 минут">`;
      h += tx(8, 16, 'Покупки четырёх покупателей · по времени события →', 'lsv-st') + tx(W - R, 16, '⏱ ' + hm(t), 'lsv-clock', 'end');
      for (let m = 0; m <= 250; m += 10) { const x = X(ST0 + m * 60), big = m % 30 === 0; h += ln(x, 41, x, big ? 48 : 45, 'lsv-tick'); if (big) h += tx(x, 36, hm(ST0 + m * 60), 'lsv-ax', 'middle'); }
      const xn = X(clamp(t, ST0, ST1));
      SESS_U.forEach((u, ui) => {
        const y = y0 + ui * rowH, hh = rowH - 10, cy = y + hh / 2;
        h += rc(L, y, W - L - R, hh, 'lsv-lane', 8) + tx(8, y + 19, u[0], 'lsv-bt') + tx(8, y + 37, CITY[u[1]], 'lsv-bs');
        if (t < ST1) h += rc(xn, y + 1, W - R - xn - 1, hh - 2, 'lsv-future', 7);
        SESS.filter(s => s.ui === ui && s.first <= t).forEach(s => {
          const vis = s.evs.filter(e => e.et <= t), lastV = vis[vis.length - 1].et, closed = t >= s.close;
          const xa = X(s.first) - 9, xb = X(lastV) + 9;
          h += rc(xa, y + 7, xb - xa, hh - 14, 'lsv-sess' + (closed ? ' closed' : ''), 9);
          if (!closed) {
            const xw = X(Math.min(t, s.close));
            h += rc(xb, y + 7, Math.max(0, xw - xb), hh - 14, 'lsv-swait', 0);
            if (xw - xb > 64) h += tx(xb + 6, cy + 4.5, `тихо ${Math.round((t - lastV) / 60)} мин`, 'lsv-wv mut');
          } else {
            const xc = X(s.close), fl = an && t - s.close < span * 1.6;
            h += rc(xb, y + 7, xc - xb, hh - 14, 'lsv-sdone' + (fl ? ' flash' : ''), 0) + tx(xb + 6, cy + 4.5, `✓ ${rub(s.sum)}`, 'lsv-wv ok');
          }
        });
        SEV.filter(e => e.ui === ui && e.et <= t).forEach(e => { h += cir(X(e.et), cy, rad(e.amt) * (0.4 + 0.6 * ak(t - e.et)), `lsv-dot ${e.city}`); });
      });
      if (t <= ST1) h += ln(xn, 41, xn, H - 2, 'lsv-now');
      return h + '</svg>';
    }
    function winKpis() {
      const p = U.win, t = p.t, B = isBiz();
      if (p.kind === 'session') {
        const cl = SESS.filter(s => t >= s.close), avg = cl.length ? sumOf(cl.map(s => ({ amt: s.sum }))) / cl.length : 0, one = cl.filter(s => s.evs.length === 1).length;
        const open = SESS.filter(s => s.first <= t && t < s.close).length;
        if (B) return tile('Визитов закрыто', `${cl.length} из ${SESS.length}`, open ? `${open} ещё идут` : 'все посчитаны') + tile('Средний чек за визит', cl.length ? rub(avg) : '—', 'сумма покупок одного визита') + tile('Визитов с одной покупкой', cl.length ? `${one} из ${cl.length}` : '—', 'кандидаты на «второй товар со скидкой»', one ? 'warn' : '') + tile('Итог визита готов', 'через 30 мин', 'после последней покупки — раньше нельзя');
        return tile('Сессий закрыто', `${cl.length} из ${SESS.length}`, open ? `${open} открыты — ждут 30 минут тишины` : 'все закрыты') + tile('Длина окна', 'разная', 'от одной покупки до 75 минут у Бориса') + tile('Окна у каждого', 'свои', 'ключ — покупатель (user_id)') + tile('Результат через', '30 мин', 'после последнего события сессии', 'warn');
      }
      const wins = p.kind === 'slide' ? SLID : TUMB, cl = wins.filter(w => t >= w.e), sums = cl.map(w => sumOf(EV20.filter(e => inW(w, e))));
      const open = wins.filter(w => t >= w.s && t < w.e), cur = open.length ? sumOf(EV20.filter(e => inW(open[open.length - 1], e) && e.et <= t)) : 0;
      if (p.kind === 'slide') {
        if (B) return tile('Табло обновилось', `${cl.length} ${plural(cl.length, 'раз', 'раза', 'раз')}`, 'раз в минуту вместо раза в 5 минут') + tile('Последнее значение', cl.length ? rub(sums[sums.length - 1]) : '—', cl.length ? `за ${hm(cl[cl.length - 1].s)}–${hm(cl[cl.length - 1].e)}` : 'первое — в 12:05') + tile('Пересчётов', '×5', 'каждая покупка считается 5 раз — дороже');
        return tile('Окон закрыто', `${cl.length} из ${SLID.length}`, 'на тех же 20 минутах у tumbling — 4') + tile('Покупка попадает', 'в 5 окон', 'размер 5 мин ÷ шаг 1 мин') + tile('Свежесть', 'раз в минуту', 'вместо раза в 5 минут') + tile('Состояние', '5 окон', 'одновременно открыты и копят суммы', 'warn');
      }
      if (B) {
        const best = sums.length ? Math.max(...sums) : 0, worst = sums.length ? Math.min(...sums) : 0;
        return tile('Выручка в закрытых окнах', rub(sumOf(sums.map(v => ({ amt: v })))), `${cl.length} из 4 окон`) + tile('Лучшее окно', sums.length ? rub(best) : '—', '') + tile('Худшее окно', sums.length ? rub(worst) : '—', sums.length === 4 ? 'последнее — провал?' : '', sums.length === 4 ? 'bad' : '') + tile('Табло обновляется', 'раз в 5 мин', 'итог окна — в момент его конца');
      }
      return tile('Окон закрыто', `${cl.length} из 4`, cl.length ? `последнее — ${hm(cl[cl.length - 1].s)}–${hm(cl[cl.length - 1].e)}` : 'первое закроется в 12:05') + tile('Выдано итогов', rub(sumOf(sums.map(v => ({ amt: v })))), 'каждая покупка — в одном окне') + tile('Копит сейчас', open.length ? rub(cur) : '—', open.length ? `окно ${hm(open[0].s)}–${hm(open[0].e)}` : 'поток закончился') + tile('Итог ждёт', 'до 5 мин', 'покупка в 12:00:20 попадёт в итог в 12:05', 'warn');
    }
    function winFeed() {
      const p = U.win, t = p.t;
      if (p.kind === 'session') { const xs = SEV.filter(e => e.et <= t).sort((a, b) => b.et - a.et).slice(0, 7); return xs.length ? xs.map(e => `<li><span class="lsv-ft">${hm(e.et)}</span>${cdot(e.city)}<span>${e.user} · ${CITY[e.city]}</span><b>${rub(e.amt)}</b></li>`).join('') : '<li class="mut"><span>Пока тихо. Нажми «Пуск» — покупки пойдут по времени.</span></li>'; }
      const xs = EV20.filter(e => e.et <= t).sort((a, b) => b.et - a.et).slice(0, 7);
      return xs.length ? xs.map(e => `<li class="lsv-fi${p.sel === e.i ? ' on' : ''}" data-ev="${e.i}" tabindex="0" role="button" aria-pressed="${p.sel === e.i}"><span class="lsv-ft">${hms(e.et)}</span>${cdot(e.city)}<span>№${e.n} · ${e.user} · ${CITY[e.city]}</span><b>${rub(e.amt)}</b></li>`).join('') : '<li class="mut"><span>Пока тихо. Нажми «Пуск» — покупки пойдут по времени.</span></li>';
    }
    function winRes() {
      const p = U.win, t = p.t;
      if (p.kind === 'session') {
        const cl = SESS.filter(s => t >= s.close).sort((a, b) => b.close - a.close);
        return cl.length ? cl.map(s => `<li class="ok"><span class="lsv-ft">${hm(s.close)}</span>${cdot(SESS_U[s.ui][1])}<span>${s.user}: визит ${s.evs.length > 1 ? hm(s.first) + '–' + hm(s.last) : 'в ' + hm(s.first)} · ${pcs(s.evs.length)}</span><b>${rub(s.sum)}</b></li>`).join('') : '<li class="mut"><span>Визит закроется через 30 минут после последней покупки — первый в 11:00.</span></li>';
      }
      const wins = p.kind === 'slide' ? SLID : TUMB, cl = wins.filter(w => t >= w.e).sort((a, b) => b.e - a.e);
      return cl.length ? cl.map(w => { const xs = EV20.filter(e => inW(w, e)); return `<li class="ok"><span class="lsv-ft">${hm(w.e)}</span><span>окно ${hm(w.s)}–${hm(w.e)} · ${pcs(xs.length)}</span><b>${rub(sumOf(xs))}</b></li>`; }).join('') : `<li class="mut"><span>Первое окно закроется в 12:05 — тогда и выйдет первый итог.</span></li>`;
    }
    function winNote() {
      const p = U.win, t = p.t, B = isBiz();
      let h = '';
      if (p.kind !== 'session') {
        const e = p.sel != null ? EV20[p.sel] : null;
        if (e) {
          const tw = TUMB.find(w => inW(w, e)), sl = slidesOf(e), shown = sl.filter(x => x.shown).length;
          h += card('info', `<b>Покупка №${e.n}:</b> ${e.user}, ${CITY[e.city]}, ${rub(e.amt)}, время события ${hms(e.et)}. ${p.kind === 'tumble' ? `В окнах подряд она лежит ровно в одном: <b>${hm(tw.s)}–${hm(tw.e)}</b> — и попадёт в итог в ${hm(tw.e)}.` : `В скользящих окнах — сразу в пяти: ${sl.map(x => `<b class="${x.shown ? '' : 'mut'}">${hm(x.s)}–${hm(x.e)}</b>`).join(', ')}.${shown < 5 ? ` На схеме ${shown} из 5: окна, которые начинаются до 12:00 или кончаются после 12:20, не показаны — найди покупку в середине потока.` : ' Все пять на схеме — подсвечены.'}`}`);
        } else if (p.kind === 'slide') h += card('', 'Нажми на точку покупки или на строку в ленте — подсвечу все окна, в которые она попала.');
      } else {
        h += card('', `<b>Посмотри на Глеба:</b> покупки в 10:50 и 11:25 — пауза 35 минут, больше 30. Это два визита, хотя он, может быть, просто долго стоял в очереди. Порог паузы — решение бизнеса, а не техники.`);
      }
      if (B) {
        if (p.kind === 'tumble') {
          const s = TUMB.map(w => sumOf(EV20.filter(e => inW(w, e)))), avg = (s[0] + s[1] + s[2]) / 3, drop = 1 - s[3] / avg, perMin = (avg - s[3]) / 5;
          h += card('biz', `<b>Для бизнеса.</b> Окно 12:15–12:20 дало ${rub(s[3])} — на ${pc(drop, 0)} меньше трёх прошлых (в среднем ${rub(avg)}). С окнами по 5 минут управляющий видит провал в 12:20, с часовым отчётом — только в 13:00. Если провал — зависшая онлайн-касса, 40 минут разницы стоят ≈ ${rub(perMin)} в минуту × 40 = <b>${rubK(perMin * 40)}</b> недобора.`)
            + asm(['выручка трёх первых окон — норма для этого часа', 'провал в последнем окне — неисправность, а не случайность', 'недобор = (норма − факт) ÷ 5 минут × время, пока никто не заметил']);
        } else if (p.kind === 'slide') h += card('biz', '<b>Для бизнеса.</b> Скользящее окно сглаживает картину: вместо 4 точек за 20 минут — 16. Решение «вызвать второго курьера» принимают по плавной линии, а не по ступенькам раз в 5 минут. Цена — в 5 раз больше пересчётов: для одного табло это копейки, для тысячи магазинов × 50 показателей — отдельный кластер.');
        else {
          const avg = sumOf(SESS.map(s => ({ amt: s.sum }))) / SESS.length, one = SESS.filter(s => s.evs.length === 1);
          h += card('biz', `<b>Для бизнеса.</b> Средний чек за визит — ${rub(avg)}; визитов с одной покупкой — ${one.length} из ${SESS.length} (${one.map(s => s.user).join(', ')}). Решение: акция «второй товар −30 % в течение визита» нацелена на одиночные визиты. Если бы считали по часам, визит Бориса 11:50–13:05 разрезался бы на два часа — и средний чек за визит было бы не посчитать.`)
            + asm(['визит — покупки одного человека с паузами не больше 30 минут', 'итог визита готов через 30 минут после последней покупки']);
        }
      }
      return h;
    }
    DRAWS.win = () => {
      const st = $('#lsvStage'); if (!st) return;
      st.innerHTML = U.win.kind === 'session' ? sessSVG(stageW(st)) : winSVG(stageW(st));
      const p = U.win, kind = p.kind, n = kind === 'session' ? SEV.filter(e => e.et <= p.t).length + ':' + SESS.filter(s => p.t >= s.close).length : EV20.filter(e => e.et <= p.t).length + ':' + (kind === 'slide' ? SLID : TUMB).filter(w => p.t >= w.e).length;
      const key = [kind, n, p.sel, MODE].join('|');
      put('#lsvKpis', key + (kind === 'tumble' ? '|' + Math.floor(p.t / 60) : ''), winKpis);
      put('#lsvFeed', key, winFeed);
      put('#lsvRes', key, winRes);
      put('#lsvNote', [kind, p.sel, MODE].join('|'), winNote);
    };
    function selEv(i) {
      if (U.tab !== 'win' || U.win.kind === 'session') return;
      U.win.sel = U.win.sel === i ? null : i;
      const e = U.win.sel != null ? EV20[U.win.sel] : null;
      if (e && U.win.kind === 'slide' && slidesOf(e).every(x => x.shown)) done('slide');
      draw();
    }

    /* ================= вкладка «Итоги» ================= */
    VIEWS.memo = () => {
      const L = isBiz() ? MEMO_BIZ : MEMO;
      return `<b class="lsv-h">Что запомнить</b><div class="lsv-memo">${L.map(([t, xs]) => `<div class="lsv-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>
        ${card('info', isBiz() ? '<b>Как говорить с командой.</b> Спрашивай не «у нас Kafka?», а: за сколько минут цифра должна появиться на табло, сколько процентов опоздавших покупок можно не учесть, что будет, если покупку посчитать дважды, и кто отвечает за схему данных, на которую смотрят дашборды.' : '<b>Как выбрать.</b> Окно — от вопроса бизнеса: «за 5 минут» — tumbling, «за последние 5 минут, свежо» — sliding, «за визит» — session. Задержку watermark — от того, насколько опаздывают события и сколько можно ждать. Деньги и счётчики — exactly-once или идемпотентный приёмник. Любой поток, на который смотрят люди, — с контрактом и тестами данных.')}`;
    };

    /* ---------- события ---------- */
    const markSeg = b => b.parentNode.querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    const PARAMS = {};
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-go],[data-mode],[data-set],[data-act],[data-ev]');
      if (!b || !EL.contains(b) || b.disabled) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.go) return setTab(d.go);
      if (d.mode) return setMode(d.mode);
      if (d.ev != null) return selEv(+d.ev);
      if (d.set) {
        const i = d.set.indexOf(':'), k = d.set.slice(0, i), v = d.set.slice(i + 1);
        if (k === 'spd') { U.spd = +v; markSeg(b); return; }
        if (k === 'wkind') { U.win.kind = v; U.win.sel = null; resetClock('win'); stopTimer(); render(); return; }
        if (PARAMS[k]) { PARAMS[k](v, b); return; }
        return;
      }
      if (d.act) act(d.act);
    }

    /* ---------- сборка ---------- */
    EL.innerHTML = `<div class="lsv"><div class="lsv-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}<div class="seg lsv-mode" role="group" aria-label="Как объяснять">${[['tech', 'Техника'], ['biz', 'Бизнес']].map(([k, t]) => `<button type="button" data-mode="${k}" aria-selected="${MODE === k}">${t}</button>`).join('')}</div></div><div class="lsv-view" id="lsvView"></div></div>`;
    const onKey = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('li[data-ev]')) { e.preventDefault(); selEv(+e.target.dataset.ev); const el = EL.querySelector(`li[data-ev="${e.target.dataset.ev}"]`); if (el) el.focus(); } };
    EL.addEventListener('click', onClick); EL.addEventListener('keydown', onKey);
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { U.sig = {}; draw(); }); }) : null;
    if (ro) ro.observe(EL);
    /* ================= вкладка 2: время события и опоздания ================= */
    CLK.late = () => ({ s: LT0, e: LT1, rate: 70, step: 60 });
    U.late.t = LT0;
    const lateR = () => { const L = U.late, k = L.D + '|' + L.pol; if (!L.run || L.run.key !== k) { L.run = lateRun(L.D, L.pol); L.run.key = k; } return L.run; };
    PARAMS.D = v => { U.late.D = +v; U.late.play = false; stopTimer(); render(); clockMoved(); };
    PARAMS.pol = v => { U.late.pol = v; U.late.play = false; stopTimer(); render(); clockMoved(); };
    CHECKS.late = () => { const R = lateR(), t = U.late.t; if (R.pol !== 'drop' && R.upd.concat(R.side).some(x => x.t <= t)) done('late'); };
    const lateCfg = () => {
      const L = U.late;
      return `<pre class="lsv-code">purchases
  .assignTimestampsAndWatermarks(WatermarkStrategy
    .forBoundedOutOfOrderness(Duration.ofSeconds(${L.D})))   <span class="lsv-cm">// ждём опоздавших ${L.D ? dur(L.D) : '0 с'}</span>
  .windowAll(TumblingEventTimeWindows.of(Time.minutes(5)))${L.pol === 'recalc' ? `
  .allowedLateness(Time.minutes(10))                   <span class="lsv-cm">// опоздавшая — поправка окна</span>` : ''}${L.pol === 'side' ? `
  .sideOutputLateData(latePurchases)                   <span class="lsv-cm">// опоздавшая — в отдельный поток</span>` : ''}
  .sum("amount");${L.pol === 'drop' ? '                                    <span class="lsv-cm">// опоздавшие молча отбрасываются</span>' : ''}</pre>`;
    };
    VIEWS.late = () => {
      const L = U.late, B = isBiz();
      return `${ana(LATE_TXT.life, LATE_TXT.plain, B ? '' : LATE_TXT.term)}
        <div class="lsv-ctls">${ctl(B ? 'Сколько ждать отставшие покупки, прежде чем выдать итог окна' : 'Задержка watermark — сколько ждём отставших', seg('D', DS, L.D, 'Задержка watermark'))}</div>
        <div class="lsv-ctl"><b>${B ? 'Что делать с покупкой, которая пришла после итога' : 'Что делать с опоздавшим событием'}</b><div class="lsv-kinds" role="group" aria-label="Что делать с опоздавшими">${POLS.map(([v, n, s]) => `<button type="button" data-set="pol:${v}" aria-pressed="${v === L.pol}"><b>${n}</b><small>${s}</small></button>`).join('')}</div></div>
        ${B ? '' : lateCfg()}
        ${playCtl()}
        <div class="lsv-stage" id="lsvStage"></div>
        ${legend([['inf', 'пришла вовремя'], ['acc', 'не по порядку, но успела'], ['bad', 'опоздала — отброшена'], ['warn', 'опоздала — поправка окна'], ['side', 'опоздала — в отдельный поток'], ['wm', 'watermark']])}
        <div class="lsv-kpis" id="lsvKpis"></div>
        <div class="lsv-two"><div class="lsv-box"><b class="lsv-h">Журнал потока</b><ol class="lsv-log" id="lsvLog"></ol></div><div class="lsv-box"><b class="lsv-h">${B ? 'Свежесть табло против точности' : 'Цена ожидания против точности'}</b><div id="lsvTrade"></div><small class="lsv-sub">Каждая точка — прогон этого же потока с политикой «отбросить». Кольцо — текущая задержка.</small></div></div>
        <div class="lsv-tablewrap" id="lsvTable"></div>
        <div id="lsvNote"></div>
        ${nextBtn('late')}`;
    };
    function lateSVG(W, R, t) {
      const L = 136, Rr = 14, X = s => L + (s - LT0) / (LT1 - LT0) * (W - L - Rr);
      const an = animOn(U.late), span = 70 * U.spd * 0.5, ak = age => an ? clamp(age / span, 0, 1) : 1;
      const ty = 50, th = 96, by = 184, bh = 36, H = by + bh + 32;
      const wm = wmAt(R, t);
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Покупки по времени события и по времени прихода, окна и watermark">`;
      h += tx(8, 16, 'Покупки: когда сделали и когда дошли до сервера', 'lsv-st') + tx(W - Rr, 16, `⏱ на сервере ${hms(t)}`, 'lsv-clock', 'end');
      for (let m = 0; m <= 27; m++) {
        const x = X(LT0 + m * 60), big = m % 5 === 0;
        h += ln(x, ty - 6, x, big ? ty : ty - 3, 'lsv-tick') + ln(x, by + bh, x, by + bh + (big ? 6 : 3), 'lsv-tick');
        if (big) h += tx(x, ty - 10, hm(LT0 + m * 60), 'lsv-ax', 'middle') + tx(x, by + bh + 20, hm(LT0 + m * 60), 'lsv-ax', 'middle');
      }
      h += tx(8, ty + 40, 'Когда купили', 'lsv-bt') + tx(8, ty + 58, 'время события', 'lsv-bs');
      h += tx(8, by + 16, 'Когда дошла', 'lsv-bt') + tx(8, by + 32, 'время обработки', 'lsv-bs');
      /* окна по времени события */
      R.W.forEach(w => {
        const x1 = X(w.s) + 1.5, x2 = X(Math.min(w.e, LT1)) - 1.5, wd = x2 - x1;
        if (wd <= 4) return;
        const fired = w.fireAt != null && w.fireAt <= t, open = !fired && t >= w.s;
        const ups = w.upd.filter(u => u.t <= t), shown = w.first + sumOf(ups);
        const okSum = sumOf(EV.filter(e => e.et >= w.s && e.et < w.e && e.at <= t && R.st[e.i].st === 'ok'));
        const fl = fired && an && t - w.fireAt < span * 1.6;
        h += rc(x1, ty, wd, th, `lsv-win ${fired ? 'closed' : open ? 'open' : 'fut'}${fl ? ' flash' : ''}`, 8);
        if (wd > 84) {
          h += tx(x1 + 8, ty + 17, `${hm(w.s)}–${hm(w.e)}`, 'lsv-wt');
          if (fired) { h += tx(x1 + 8, ty + th - (ups.length ? 24 : 9), `✓ ${rub(w.first)}`, 'lsv-wv ok'); if (ups.length) h += tx(x1 + 8, ty + th - 8, `↻ ${rub(shown)}`, 'lsv-wv warn'); }
          else if (open) h += tx(x1 + 8, ty + th - 9, `копит ${rub(okSum)}`, 'lsv-wv');
        }
      });
      /* нижняя дорожка: время прихода */
      h += rc(L, by, W - L - Rr, bh, 'lsv-lane', 8);
      const xt = X(clamp(t, LT0, LT1));
      if (t < LT1) h += rc(xt, by + 1, W - Rr - xt - 1, bh - 2, 'lsv-future', 7);
      /* покупки: сверху — время события, снизу — время прихода */
      const lab = [];
      EV.forEach(e => {
        if (e.et > t) return;
        const S = R.st[e.i], yT = ty + 46 + (e.i % 2 ? 9 : -9), yB = by + bh / 2, xe = X(e.et), xa = X(e.at);
        if (e.at > t) { h += cir(xe, yT, rad(e.amt) * 0.8, 'lsv-ld ghost'); if (t - e.et > 50) lab.push(tx(xe + 10, yT + 4, 'в пути', 'lsv-wv mut lsv-halo')); return; }
        const cls = S.st === 'ok' ? (S.ooo ? 'ooo' : 'ok') : S.st, k = ak(t - e.at);
        h += ln(xa + (xe - xa) * k, yB + (yT - yB) * k, xa, yB, 'lsv-con ' + cls) + cir(xa, yB, 4, 'lsv-ld ' + cls);
        h += cir(xa + (xe - xa) * k, yB + (yT - yB) * k, rad(e.amt) * 0.8, 'lsv-ld ' + cls);
        if (S.late) lab.push(tx(xa + 7, yB - 12, S.st === 'drop' ? '✗ отброшена' : S.st === 'upd' ? '↻ поправка' : '→ в отдельный поток', 'lsv-wv lsv-halo ' + (S.st === 'drop' ? 'bad' : S.st === 'upd' ? 'warn' : 'mut')));
      });
      /* watermark */
      if (wm != null && wm >= LT0 - 60) {
        const xw = X(clamp(wm, LT0, LT1)), right = xw > W - 190;
        h += ln(xw, ty - 2, xw, ty + th + 6, 'lsv-wm') + `<polygon class="lsv-wmf" points="${f1(xw)},${f1(ty + th + 4)} ${f1(xw - 6)},${f1(ty + th + 14)} ${f1(xw + 6)},${f1(ty + th + 14)}"/>`;
        h += tx(right ? xw - 10 : xw + 10, ty + th + 18, `watermark ${hms(wm)}`, 'lsv-wml lsv-halo', right ? 'end' : 'start');
      } else h += tx(L + 4, ty + th + 18, 'watermark появится с первой покупкой', 'lsv-wv mut');
      if (t <= LT1) h += ln(xt, by - 6, xt, by + bh + 4, 'lsv-now');
      return h + lab.join('') + '</svg>';
    }
    function lateKpis(R, t) {
      const B = isBiz(), W4 = R.W.slice(0, 4), fired = W4.filter(w => w.fireAt != null && w.fireAt <= t);
      const delay = fired.length ? fired.reduce((a, w) => a + w.fireAt - w.e, 0) / fired.length : null;
      const truth = sumOf(fired.map(w => ({ amt: w.truth }))), first = sumOf(fired.map(w => ({ amt: w.first }))), cur = sumOf(fired.map(w => ({ amt: w.first + sumOf(w.upd.filter(u => u.t <= t)) })));
      const lateN = EV.filter(e => R.st[e.i].late && e.at <= t && R.st[e.i].w < 4), lateSumV = sumOf(lateN);
      const shown = R.pol === 'recalc' ? cur : first, miss = truth ? (truth - shown) / truth : 0;
      if (B) {
        return tile('Табло отстаёт', delay != null ? dur(delay) : '—', 'итог окна после его конца, в среднем', delay > 120 ? 'warn' : '')
          + tile('Дашборд недосчитал', fired.length ? pc(miss) : '—', fired.length ? `${rub(truth - shown)} из ${rub(truth)}` : 'ещё нет итогов', miss > 0 ? 'bad' : fired.length ? 'ok' : '')
          + tile('Недозакупка на завтра', fired.length ? rubK(BIZ.day * miss * BIZ.cost) : '—', 'если закупку считать по этим цифрам', miss > 0 ? 'bad' : '')
          + tile('Упущено продаж завтра', fired.length ? rubK(BIZ.day * miss * BIZ.miss) : '—', 'товара не хватит на полках', miss > 0 ? 'bad' : '');
      }
      const pol = R.pol === 'drop' ? tile('Потеряно навсегда', rub(lateSumV), `${pcs(lateN.length)} отброшено`, lateN.length ? 'bad' : 'ok')
        : R.pol === 'recalc' ? tile('Итог после поправок', fired.length ? pc(cur / truth) : '—', `${lateN.length} ${plural(lateN.length, 'поправка', 'поправки', 'поправок')} выдано`, fired.length && cur === truth ? 'ok' : 'warn')
        : tile('В отдельном потоке', rub(lateSumV), `${pcs(lateN.length)} ждут досчёта`, lateN.length ? 'warn' : 'ok');
      return tile('Ждём итог окна', delay != null ? dur(delay) : '—', 'после конца окна, в среднем', delay > 120 ? 'warn' : '')
        + tile('Точность первого итога', fired.length ? pc(first / truth) : '—', fired.length ? `${rub(first)} из ${rub(truth)}` : 'окна ещё не закрылись', fired.length ? (first < truth ? 'bad' : 'ok') : '')
        + pol + tile('Опоздавших покупок', nf(lateN.length), 'пришли после итога своего окна', lateN.length ? 'warn' : '');
    }
    function lateLog(R, t) {
      const items = [];
      R.W.forEach(w => { if (w.fireAt != null && w.k < 5) items.push({ t: w.fireAt, o: 1, cls: 'ok', h: `watermark ${hms(w.wmFire)} прошёл ${hm(w.e)} — окно ${hm(w.s)}–${hm(w.e)} закрыто, выдано <b>${rub(w.first)}</b> (${pcs(w.firstN)})` }); });
      EV.forEach(e => {
        const S = R.st[e.i], w = R.W[S.w];
        if (S.late) {
          const u = R.upd.find(x => x.e === e);
          items.push({ t: e.at, o: 0, cls: S.st === 'drop' ? 'bad' : S.st === 'upd' ? 'warn' : 'mut', h: `№${e.n} (${e.user}, ${rub(e.amt)}) куплена в ${hms(e.et)}, дошла через ${dur(e.at - e.et)}: ${e.why}. Окно ${hm(w.s)}–${hm(w.e)} уже выдано — ${S.st === 'drop' ? '<b>отброшена</b>' : S.st === 'upd' ? `<b>поправка</b>: окно теперь ${rub(u.total)}` : '<b>ушла в поток late_purchases</b>'}` });
        } else if (S.ooo) items.push({ t: e.at, o: 0, cls: 'inf', h: `№${e.n} куплена в ${hms(e.et)}, дошла через ${dur(e.at - e.et)} не по порядку — окно ${hm(w.s)}–${hm(w.e)} ещё открыто, успела` });
      });
      const xs = items.filter(x => x.t <= t).sort((a, b) => a.t - b.t || a.o - b.o);
      return xs.length ? xs.map(x => `<li class="${x.cls}"><span class="lsv-ft">${hms(x.t)}</span><span>${x.h}</span></li>`).join('') : '<li class="mut">Нажми «Пуск»: внизу покупки приходят на сервер, вверху встают на своё время покупки. Watermark — зелёная черта.</li>';
    }
    function tradeSVG(R) {
      const W = 330, H = 200, ml = 46, mr = 14, mt = 14, mb = 36, iw = W - ml - mr, ih = H - mt - mb, B = isBiz();
      const X = s => ml + iw * Math.min(s, 360) / 360, Y = a => mt + ih * (1 - (Math.max(a, 0.85) - 0.85) / 0.15);
      let h = `<svg class="lsv-svg lsv-trade" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Задержка итога против точности для четырёх задержек watermark">`;
      [0.85, 0.9, 0.95, 1].forEach(a => { h += ln(ml, Y(a), W - mr, Y(a), 'lsv-grid') + tx(ml - 6, Y(a) + 4, pc(a, 0), 'lsv-ax', 'end'); });
      [0, 120, 240, 360].forEach(s => { h += tx(X(s), H - mb + 16, s / 60 + ' мин', 'lsv-ax', s === 360 ? 'end' : 'middle'); });
      h += tx(ml + iw / 2, H - 4, B ? 'на сколько табло отстаёт →' : 'ждём итог окна →', 'lsv-bs', 'middle');
      h += `<path class="lsv-tline" d="${TRADE.map((p, i) => `${i ? 'L' : 'M'}${f1(X(p.s.delay))} ${f1(Y(p.s.acc1))}`).join(' ')}"/>`;
      TRADE.forEach((p, i) => {
        const on = p.D === R.D, x = X(p.s.delay), y = Y(p.s.acc1);
        h += cir(x, y, on ? 7 : 4.5, 'lsv-tp' + (on ? ' on' : ''));
        h += tx(x + (i === 3 ? -12 : 10), y + (i === 3 ? 5 : 17), `${p.n.toLowerCase()} · ${pc(p.s.acc1)}`, 'lsv-wv lsv-halo', i === 3 ? 'end' : 'start');
      });
      if (R.pol === 'recalc' && R.D < 300) { const p = TRADE.find(q => q.D === R.D), x = X(p.s.delay); h += arrow(x, Y(p.s.acc1) - 9, x, Y(1) + 3, 'warn') + tx(x + 8, Y(1) + 30, 'после поправок — 100 %', 'lsv-wv warn lsv-halo'); }
      return h + '</svg>';
    }
    function lateTable(R, t) {
      const B = isBiz();
      const rows = R.W.slice(0, 4).map(w => {
        const fired = w.fireAt != null && w.fireAt <= t, ups = w.upd.filter(u => u.t <= t), cur = w.first + sumOf(ups), miss = fired ? w.truth - cur : null;
        const sideW = R.side.filter(x => x.w === w.k && x.t <= t);
        return `<tr><th>${hm(w.s)}–${hm(w.e)}</th><td>${fired ? hms(w.fireAt) : '<span class="mut">ещё открыто</span>'}</td><td>${fired ? dur(w.fireAt - w.e) : '—'}</td><td>${fired ? rub(w.first) : '—'}</td><td>${ups.length ? ups.map(u => `+${rub(u.amt)} в ${hms(u.t)}`).join('<br>') : sideW.length ? sideW.map(x => `в отдельный поток: ${rub(x.amt)}`).join('<br>') : '—'}</td><td>${rub(w.truth)}</td><td class="${miss > 0 ? 'bad' : miss === 0 ? 'ok' : ''}">${miss == null ? '—' : miss > 0 ? '−' + rub(miss) : '✓ точно'}</td></tr>`;
      });
      return `<table class="lsv-table"><thead><tr><th>Окно</th><th>${B ? 'Итог на табло в' : 'Закрыто в'}</th><th>Ждали после конца</th><th>Первый итог</th><th>${B ? 'Что было потом' : 'Поправки и отдельный поток'}</th><th>На самом деле</th><th>Не хватает</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    function lateNote(R, t) {
      const B = isBiz(), S = lateSum(R), end = t >= LT1, miss = (S.truth - (R.pol === 'recalc' ? S.fin : S.first)) / S.truth;
      let h = '';
      if (!B && end) {
        if (R.pol === 'drop') h += card(S.lost ? 'bad' : 'ok', `<b>Итог прогона.</b> Ждали итог окна в среднем ${dur(S.delay)}, первые итоги точны на ${pc(S.acc1)}${S.lost ? `, потеряно навсегда ${rub(S.lost)}` : ''}. ${R.D ? 'Ждали дольше заданной задержки: watermark двигается, только когда приходят новые покупки. ' : ''}${R.D < 300 ? 'Подними задержку до 5 минут — успеют все покупки, но каждый итог будет приходить через 5+ минут после конца окна. Или оставь задержку и выбери «Пересчитать окно».' : 'Все покупки успели, но каждый итог пришёл через 5+ минут после конца окна: точность купили временем.'}`);
        else if (R.pol === 'recalc') h += card('ok', `<b>Итог прогона.</b> Первый итог — через ${dur(S.delay)} после конца окна, точность ${pc(S.acc1)}; поправки догнали — итоговые цифры точные (${pc(S.accF)}). Цена: каждое окно живёт ещё 10 минут после закрытия (память), а приёмник должен <b>заменять</b> значение окна, а не дописывать второе.`);
        else h += card('warn', `<b>Итог прогона.</b> Табло недосчитало ${rub(S.truth - S.first)}, но опоздавшие покупки не потеряны: лежат в потоке late_purchases. Их досчитает ночной пакетный пересчёт или сверка. Днём на табло одна цифра, утром в отчёте — другая: об этом надо договориться заранее.`);
      }
      if (B) {
        const under = BIZ.day * miss;
        if (R.pol === 'drop' && miss > 0) h += card('bad', `<b>Для бизнеса.</b> Дашборд показал выручку на <b>${pc(miss)}</b> меньше, чем было на самом деле. Закупку на завтра считают от сегодняшней выручки: при ${rubK(BIZ.day)} в день это недосчёт ≈ ${rubK(under)} — закупим меньше на ≈ <b>${rubK(under * BIZ.cost)}</b>, и завтра на полках не хватит товара на ≈ ${rubK(under * BIZ.miss)} продаж. Ждать отставших 5 минут — и цифры точные.`);
        else if (R.pol === 'drop') h += card('ok', `<b>Для бизнеса.</b> Все покупки успели — цифры точные. Цена: итог окна появляется на табло через ≈ ${dur(S.delay)} после его конца. Для закупки на завтра это бесплатно. Для сигнала «онлайн-касса не работает» — ${dur(S.delay)} лишнего простоя: ≈ ${rubK(BIZ.day / BIZ.hours / 60 * S.delay / 60)} недобора на каждую такую аварию.`);
        else if (R.pol === 'recalc') h += card('ok', `<b>Для бизнеса.</b> Быстрая цифра на табло — через ${dur(S.delay)} после конца окна, а через несколько минут приходит поправка: к расчёту закупки цифры точные. Цена: система держит окна дольше (больше памяти), а дашборд и выгрузки должны уметь заменять цифру задним числом.`);
        else h += card('warn', `<b>Для бизнеса.</b> Днём табло недосчитывает ${pc((S.truth - S.first) / S.truth)}, но ни одна покупка не потеряна: ночная сверка досчитает их до расчёта закупки. Цена — две цифры за день (быстрая и точная) и объяснения для управляющих.`);
        h += asm([`выручка сети ${rubK(BIZ.day)} в день, ${BIZ.hours} часов работы`, 'закупка на завтра = 65 % сегодняшней выручки', 'из недостающего на полке товара половину продаж потеряем', 'опоздавших в этой выборке нарочно много; в жизни их обычно 1–5 %']);
      }
      return h;
    }
    DRAWS.late = () => {
      const st = $('#lsvStage'); if (!st) return;
      const R = lateR(), t = U.late.t;
      st.innerHTML = lateSVG(stageW(st, 640), R, t);
      const nArr = EV.filter(e => e.at <= t).length, nF = R.W.filter(w => w.fireAt != null && w.fireAt <= t).length;
      const key = [R.key, nArr, nF, MODE].join('|');
      put('#lsvKpis', key, () => lateKpis(R, t));
      const lg = $('#lsvLog'), before = U.sig['#lsvLog'];
      put('#lsvLog', key, () => lateLog(R, t));
      if (lg && before !== U.sig['#lsvLog']) lg.scrollTop = lg.scrollHeight;
      put('#lsvTrade', [R.key, MODE].join('|'), () => tradeSVG(R));
      put('#lsvTable', key, () => lateTable(R, t));
      put('#lsvNote', [R.key, MODE, t >= LT1].join('|'), () => lateNote(R, t));
    };

    /* ================= вкладка 3: состояние и «ровно один раз» ================= */
    const stS = () => { const s = U.st; if (!s.S) s.S = stNew(s.mode, s.every, s.auto); return s.S; };
    const stReset = () => { U.st.S = null; U.st.play = false; stopTimer(); };
    PARAMS.gm = v => { U.st.mode = v; stReset(); render(); };
    PARAMS.every = v => { U.st.every = +v; stReset(); render(); };
    PARAMS.auto = v => { U.st.auto = +v; stReset(); render(); };
    function stFinish() {
      const S = stS(); if (!S.end || !S.crashed) return;
      const tr = tot(stTruth(S)), sk = tot(S.sink);
      if (S.mode === 'alo' && S.dup > 0) U.st.saw.alo = 1;
      if (S.mode !== 'alo' && sk === tr) U.st.saw.ok = 1;
      if (U.st.saw.alo && U.st.saw.ok) done('eo');
    }
    function stepState() { const S = stS(); stStep(S); if (S.end) { U.st.play = false; stopTimer(); stFinish(); } draw(); }
    TICKS.state = dt => { U.st.acc += dt * U.spd; let n = 0; while (U.st.acc >= 0.6 && n < 3 && U.st.play) { U.st.acc -= 0.6; stepState(); n++; } };
    ACTS.state = a => {
      let S = stS();
      if (a === 'play') {
        if (U.st.play) { U.st.play = false; stopTimer(); draw(); return; }
        if (S.end) { stReset(); S = stS(); }
        if (isCalm()) { while (!S.end) stStep(S); stFinish(); draw(); return; }
        U.st.play = true; U.st.acc = 0.6; startTimer(); draw(); return;
      }
      if (a === 'step') { U.st.play = false; stopTimer(); stepState(); return; }
      if (a === 'end') { U.st.play = false; stopTimer(); while (!S.end) stStep(S); stFinish(); }
      else if (a === 'reset') stReset();
      else if (a === 'crash') { if (!stCrash(S)) return; }
      draw();
    };
    function stPlayBar() {
      const S = stS(), start = S.off === 0 && !S.crashed && S.phase === 'run';
      return `<button type="button" class="btn primary" data-act="play">${U.st.play ? 'Пауза' : S.end ? 'Ещё раз' : start ? 'Пуск' : 'Дальше'}</button><button type="button" class="btn" data-act="step" ${S.end ? 'disabled' : ''}>Шаг</button><button type="button" class="btn" data-act="end" ${S.end ? 'disabled' : ''}>До конца</button><button type="button" class="btn ghost" data-act="reset" ${start ? 'disabled' : ''}>Сначала</button><button type="button" class="btn danger" data-act="crash" ${S.phase !== 'run' || S.end || S.off === 0 ? 'disabled' : ''}>Уронить оператор</button>`;
    }
    VIEWS.state = () => {
      const s = U.st, B = isBiz();
      return `${ana(ST_TXT.life, ST_TXT.plain, B ? '' : ST_TXT.term)}
        <div class="lsv-ctl"><b>${B ? 'Как поток пишет итоги в отчёт' : 'Гарантия доставки в приёмник'}</b><div class="lsv-kinds" role="group" aria-label="Гарантия доставки">${GUAR.map(([v, n, d]) => `<button type="button" data-set="gm:${v}" aria-pressed="${v === s.mode}"><b>${n}</b><small>${d}</small></button>`).join('')}</div></div>
        <div class="lsv-ctls">${ctl(B ? 'Как часто сохранять итоги (чекпойнт)' : 'Чекпойнт', seg('every', EVERY, s.every, 'Как часто чекпойнт'))}${ctl('Авария', seg('auto', CRASH, s.auto, 'Когда упасть'))}</div>
        ${B ? '' : `<pre class="lsv-code">${esc(SINK_SQL[s.mode])}</pre>`}
        <div class="lsv-play"><div class="lsv-btns" id="lsvPlay"></div>${seg('spd', [[0.5, 'Медленно'], [1, 'Обычно'], [3, 'Быстро']], U.spd, 'Скорость показа')}</div>
        <div class="lsv-stage" id="lsvStage"></div>
        ${legend([['M', 'Москва'], ['K', 'Казань'], ['S', 'Самара'], ['wm', 'барьер чекпойнта'], ['ln', 'сохранено в чекпойнте'], ['bad', 'записано в витрину дважды']])}
        <div class="lsv-kpis" id="lsvKpis"></div>
        <div class="lsv-box"><b class="lsv-h">Журнал оператора</b><ol class="lsv-log" id="lsvLog"></ol></div>
        <div id="lsvNote"></div>
        ${nextBtn('state')}`;
    };
    function stSVG(W, S) {
      const N = SEVQ.length, L = 16, cw = (W - 2 * L) / N, cy = 40, ch = 50, by = 140, bh = 196, gap = 64, bw = (W - 2 * L - 2 * gap) / 3, H = by + bh + 8;
      const xs = [L, L + bw + gap, L + 2 * (bw + gap)], [xStore, xOp, xSink] = xs;
      const ckOff = S.ck[S.ck.length - 1].off, tr = stTruth(S);
      const st = S.phase === 'down' ? 'оператор упал' : S.end ? 'топик прочитан до конца' : `читаем offset ${S.off}`;
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Топик, оператор с состоянием, чекпойнты и витрина">`;
      h += tx(L, 16, 'Топик purchases · партиция 0 · покупки по порядку прихода', 'lsv-st') + tx(W - L, 16, st, 'lsv-clock' + (S.phase === 'down' ? ' bad' : ''), 'end');
      /* ячейки топика */
      SEVQ.forEach((e, o) => {
        const x = L + o * cw, read = o < S.off, dupd = S.mode === 'alo' && (S.writes[o] || 0) > 1, rep = S.rFrom != null && o >= S.rFrom && o < S.crashOff && read;
        h += rc(x + 1.5, cy, cw - 3, ch, `lsv-cell ${read ? 'rd ' + e.city : 'todo'}${dupd ? ' dup' : ''}${S.last === o ? ' new' : ''}`, 5);
        h += tx(x + cw / 2, cy + 14, String(o), 'lsv-co', 'middle') + tx(x + cw / 2, cy + 30, CITY[e.city][0], 'lsv-cc ' + e.city, 'middle');
        if (cw >= 33) h += tx(x + cw / 2, cy + 45, String(e.amt), 'lsv-ca', 'middle');
        if (rep) h += tx(x + cw / 2, cy - 4, '↻', 'lsv-wv ' + (S.mode === 'alo' ? 'bad' : 'warn'), 'middle');
      });
      /* барьеры чекпойнтов */
      for (let p = S.every, k = 1; p <= N; p += S.every, k++) {
        const x = L + p * cw, on = p <= ckOff || S.ck.some(c => c.off === p);
        h += ln(x, cy - 10, x, cy + ch + 6, 'lsv-bar' + (on ? ' on' : ''));
      }
      if (N % S.every) { const x = L + N * cw; h += ln(x, cy - 10, x, cy + ch + 6, 'lsv-bar' + (S.end ? ' on' : '')); }
      if (ckOff > 0) h += rc(L + 1.5, cy + ch + 4, ckOff * cw - 3, 5, 'lsv-ckbar', 2) + (ckOff * cw > 140 ? tx(L + 4, cy + ch + 22, `в чекпойнте #${S.ck.length - 1}: 0…${ckOff - 1}`, 'lsv-wv ok') : '');
      /* указатель чтения → оператор */
      const opCx = xOp + bw / 2;
      if (S.phase === 'run' && !S.end) {
        const xc = L + (S.off + 0.5) * cw;
        h += `<polygon class="lsv-ptr" points="${f1(xc)},${f1(cy + ch + 12)} ${f1(xc - 6)},${f1(cy + ch + 22)} ${f1(xc + 6)},${f1(cy + ch + 22)}"/>`;
        h += arrow(xc, cy + ch + 26, opCx, by - 4, 'inf');
      }
      /* хранилище чекпойнтов */
      const restore = S.ev === 'restore', crash = S.phase === 'down';
      h += rc(xStore, by, bw, bh, 'lsv-box2' + (restore ? ' warn' : ''), 10) + tx(xStore + 12, by + 22, 'Чекпойнты · хранилище S3', 'lsv-bt') + tx(xStore + 12, by + 40, 'суммы + offset, каждые ' + pcs(S.every), 'lsv-bs');
      S.ck.slice(-3).reverse().forEach((c, i) => {
        const y = by + 72 + i * 38, cur = c.n === S.lastCk;
        h += rc(xStore + 8, y - 17, bw - 16, 34, 'lsv-ckrow' + (cur ? ' new' : '') + (restore && i === 0 ? ' rest' : ''), 6);
        h += tx(xStore + 16, y - 2, `#${c.n} · offset ${c.off}`, 'lsv-wv' + (i === 0 ? ' ok' : ' mut'));
        h += tx(xStore + 16, y + 13, `М ${nf(c.state.M)} · К ${nf(c.state.K)} · С ${nf(c.state.S)}`, 'lsv-ca');
      });
      /* оператор */
      h += rc(xOp, by, bw, bh, 'lsv-box2' + (crash ? ' bad' : restore ? ' warn' : ' on'), 10) + tx(xOp + 12, by + 22, 'Оператор «сумма по городу»', 'lsv-bt');
      h += tx(xOp + 12, by + 40, crash ? 'упал — память пуста' : restore ? `восстановлен из чекпойнта #${S.ck.length - 1}` : S.end ? 'готово' : 'работает · суммы в памяти', 'lsv-bs' + (crash ? ' bad' : restore ? ' warn' : ''));
      CITIES.forEach((c, i) => {
        const y = by + 70 + i * 36;
        h += cir(xOp + 18, y - 4, 5, 'lsv-dot ' + c) + tx(xOp + 30, y, CITY[c], 'lsv-s') + tx(xOp + bw - 12, y, S.state ? rub(S.state[c]) : '—', 'lsv-num' + (crash ? ' bad' : ''), 'end');
      });
      h += tx(xOp + 12, by + bh - 14, `прочитано ${pcs(S.maxOff)}${S.replay ? ` · повторно ${S.replay}` : ''}`, 'lsv-bs');
      h += arrow(xOp - 4, by + bh / 2, xStore + bw + 4, by + bh / 2, restore ? 'warn' : 'acc') + tx(xOp - gap / 2, by + bh / 2 - 8, restore ? '←' : 'снимок', 'lsv-wv mut', 'middle');
      /* витрина */
      const dupSink = S.mode === 'alo' && S.dup > 0;
      h += rc(xSink, by, bw, bh, 'lsv-box2' + (dupSink ? ' bad' : ''), 10) + tx(xSink + 12, by + 22, 'Витрина city_revenue', 'lsv-bt');
      h += tx(xSink + 12, by + 40, S.mode === 'alo' ? 'пишем каждую покупку сразу' : S.mode === 'eo' ? 'видно только после COMMIT' : 'ключ — id покупки', 'lsv-bs');
      CITIES.forEach((c, i) => {
        const y = by + 70 + i * 36, d = S.sink[c] - tr[c] + (S.mode === 'eo' ? S.pend.filter(p => p.city === c).reduce((a, p) => a + p.amt, 0) : 0);
        h += cir(xSink + 18, y - 4, 5, 'lsv-dot ' + c) + tx(xSink + 30, y, CITY[c], 'lsv-s') + tx(xSink + bw - 12, y, rub(S.sink[c]), 'lsv-num' + (S.sink[c] > tr[c] ? ' bad' : ''), 'end');
        if (S.sink[c] > tr[c]) h += tx(xSink + bw - 12, y + 15, `+${rub(S.sink[c] - tr[c])} дубль`, 'lsv-wv bad', 'end');
        else if (d === 0 && S.mode === 'eo' && S.pend.some(p => p.city === c)) h += tx(xSink + bw - 12, y + 15, `+${rub(S.pend.filter(p => p.city === c).reduce((a, p) => a + p.amt, 0))} ждёт COMMIT`, 'lsv-wv mut', 'end');
      });
      h += tx(xSink + 12, by + bh - 14, S.mode === 'eo' ? (S.pend.length ? `открытая транзакция: ${S.pend.length} ${plural(S.pend.length, 'запись', 'записи', 'записей')}` : 'транзакций в работе нет') : S.mode === 'idem' ? `повторов пропущено: ${S.skip}` : `дублей: ${S.dupN}`, 'lsv-bs' + (dupSink ? ' bad' : ''));
      h += arrow(xOp + bw + 4, by + bh / 2, xSink - 4, by + bh / 2, crash ? '' : 'ok') + tx(xOp + bw + gap / 2, by + bh / 2 - 8, 'запись', 'lsv-wv mut', 'middle');
      return h + '</svg>';
    }
    function stKpis(S) {
      const B = isBiz(), tr = tot(stTruth(S)), sk = tot(S.sink), pend = S.pend.reduce((a, p) => a + p.amt, 0), extra = Math.max(0, sk - tr);
      const vis = S.mode === 'eo' ? `≈ ${dur(S.every * 48)}` : 'сразу';
      if (B) {
        const perCk = BIZ.day / BIZ.hours / 60 * S.every * 0.8;
        return tile('Выручка в отчёте', rub(sk), pend ? `ещё ${rub(pend)} ждут фиксации` : 'то, что видят управляющие', extra ? 'bad' : '')
          + tile('На самом деле', rub(tr), `${pcs(S.maxOff)} — каждая один раз`)
          + tile('Лишнее в отчёте', rub(extra), extra ? `${pc(extra / tr)} выручки — покупки посчитаны дважды` : 'дублей нет', extra ? 'bad' : 'ok')
          + tile('Одна авария в масштабе сети', S.mode === 'alo' ? `до ${rubK(perCk)}` : '0 ₽', S.mode === 'alo' ? 'несуществующей выручки в отчёте' : 'лишней выручки', S.mode === 'alo' ? 'bad' : 'ok')
          + tile('Отчёт видит покупку', vis, S.mode === 'eo' ? 'после ближайшего чекпойнта' : 'сразу после записи', S.mode === 'eo' ? 'warn' : '');
      }
      return tile('В витрине', rub(sk), pend ? `+${rub(pend)} в открытой транзакции` : 'сумма по трём городам', extra ? 'bad' : '')
        + tile('Правда', rub(tr), `каждая из ${pcs(S.maxOff)} — один раз`)
        + tile(S.mode === 'idem' ? 'Повторов пропущено' : 'Дубли в витрине', S.mode === 'idem' ? nf(S.skip) : rub(extra), S.mode === 'idem' ? 'приёмник узнал id и не прибавил' : extra ? `${S.dupN} ${plural(S.dupN, 'покупка', 'покупки', 'покупок')} записаны дважды` : 'нет', extra ? 'bad' : 'ok')
        + tile('Перечитано после падения', nf(S.replay), S.crashed && S.rFrom != null ? `с offset ${S.rFrom} — от чекпойнта #${(S.ck.find(c => c.off === S.rFrom) || { n: 0 }).n}` : S.crashed ? 'идёт восстановление' : 'падений не было', S.replay ? 'warn' : '')
        + tile('Видно в витрине', vis, S.mode === 'eo' ? `при чекпойнте: каждые ${pcs(S.every)}` : 'сразу после записи', S.mode === 'eo' ? 'warn' : '');
    }
    function stNote(S) {
      const B = isBiz(), tr = tot(stTruth(S)), sk = tot(S.sink), extra = sk - tr;
      let h = '';
      if (!S.crashed && !S.end) h += card('', S.auto ? `Поток упадёт сам после 13-й покупки. Следи за суммами в витрине: что будет с покупками, которые прочитаны после последнего чекпойнта?` : 'Нажми «Уронить оператор» в любой момент — лучше через пару покупок после чекпойнта.');
      if (S.end && S.crashed) {
        if (S.mode === 'alo') h += card(extra ? 'bad' : 'ok', extra ? `<b>Дубли: +${rub(extra)}.</b> Покупки между последним чекпойнтом и падением витрина получила дважды: первый раз до падения, второй — при повторном чтении. Состояние оператора при этом правильное — сломался только приёмник. Переключи гарантию на exactly-once или идемпотентный приёмник и урони ещё раз.` : '<b>Дублей нет:</b> упали ровно на чекпойнте — повторять было нечего. Урони между чекпойнтами.');
        else if (S.mode === 'eo') h += card('ok', `<b>Ровно один раз.</b> Повторно прочитано ${pcs(S.replay)}, но их первая запись была в транзакции, которую отменили при падении. В витрине ${rub(sk)} — ровно правда. Цена: покупка видна в витрине только после чекпойнта — каждые ${pcs(S.every)}.`);
        else h += card('ok', `<b>Повтор безвреден.</b> Приёмник узнал ${S.skip} ${plural(S.skip, 'покупку', 'покупки', 'покупок')} по id и не прибавил второй раз. В витрине ${rub(sk)} — правда, и видно сразу. Цена: приёмник хранит id всех покупок (или их ключи) и умеет upsert — не каждое хранилище так может.`);
      } else if (S.end) h += card('', 'Прогон без падения: все три гарантии дают одинаковый итог. Разница видна только при аварии — поставь «после 13-й покупки» или урони оператор вручную.');
      if (B) {
        const perCk = BIZ.day / BIZ.hours / 60 * S.every * 0.8;
        h += card('biz', S.mode === 'alo' ? `<b>Для бизнеса.</b> После аварии отчёт показывает больше денег, чем было: в этом прогоне +${rub(Math.max(0, extra))}. В масштабе сети между чекпойнтами ≈ ${rubK(perCk)} продаж — столько несуществующей выручки может добавить каждая авария. Дальше — премии управляющим от завышенной выручки, расхождение с кассой и ≈ 2 часа бухгалтера на сверку (≈ ${rub(BIZ.acct * 2)}).`
          : S.mode === 'eo' ? `<b>Для бизнеса.</b> Деньги в отчёте сходятся с кассой при любой аварии. Платим свежестью: покупка попадает в отчёт только при чекпойнте — раз в ≈ ${dur(S.every * 48)}. Для отчёта о выручке это незаметно; для табло «прямо сейчас» — заметно.`
          : `<b>Для бизнеса.</b> Деньги сходятся и видны сразу. Цена — доработка приёмника: у каждой покупки должен быть уникальный номер, и база должна уметь «записать, если такого ещё нет». Для денег это стандарт.`)
          + asm([`выручка сети ${rubK(BIZ.day)} в день, ${BIZ.hours} часов работы`, `между чекпойнтами ${pcs(S.every)} ≈ ${dur(S.every * 48)} продаж`, 'авария — раз в неделю: перезапуск узла, обновление, нехватка памяти', `сверка с кассой — 2 часа бухгалтера по ${rub(BIZ.acct)}`]);
      }
      return h;
    }
    DRAWS.state = () => {
      const st = $('#lsvStage'); if (!st) return;
      const S = stS();
      st.innerHTML = stSVG(stageW(st, 820), S);
      const key = [S.mode, S.every, S.auto, S.off, S.phase, S.end, S.log.length, MODE, U.st.play].join('|');
      put('#lsvPlay', key, stPlayBar);
      put('#lsvKpis', key, () => stKpis(S));
      const lg = $('#lsvLog'), before = U.sig['#lsvLog'];
      put('#lsvLog', key, () => S.log.length ? S.log.slice(-60).map(x => `<li class="${x.cls}"><span>${x.h}</span></li>`).join('') : '<li class="mut">Нажми «Пуск»: оператор читает покупки из топика, копит суммы по городам, на барьерах сохраняет чекпойнт и пишет в витрину.</li>');
      if (lg && before !== U.sig['#lsvLog']) lg.scrollTop = lg.scrollHeight;
      put('#lsvNote', [S.mode, S.every, S.auto, S.end, S.crashed, MODE].join('|'), () => stNote(S));
    };

    /* ================= вкладка 4: соединение потоков ================= */
    CLK.join = () => ({ s: JT0, e: JT1, rate: 120, step: 300 });
    U.join.t = JT0;
    const joinR = () => { const J = U.join, k = J.W + '|' + J.pol; if (!J.run || J.run.key !== k) { J.run = joinRun(J.W, J.pol); J.run.key = k; } return J.run; };
    PARAMS.jw = v => { U.join.W = +v; U.join.play = false; stopTimer(); render(); clockMoved(); };
    PARAMS.jpol = v => { U.join.pol = v; U.join.play = false; stopTimer(); render(); clockMoved(); };
    CHECKS.join = () => { const R = joinR(), t = U.join.t; if (t >= JT1 && R.pol !== 'drop' && !joinSum(R, t).lost.length) done('join'); };
    const joinSql = () => `<pre class="lsv-code">SELECT o.order_id, o.amount, p.paid_at
FROM orders o JOIN payments p
  ON p.order_id = o.order_id
 AND p.paid_at BETWEEN o.created_at AND o.created_at + INTERVAL '${U.join.W / 60}' MINUTE   <span class="lsv-cm">-- окно сведения</span>
<span class="lsv-cm">-- без пары: заказ → «не оплачен» через ${U.join.W / 60} мин; оплата → ${U.join.pol === 'drop' ? 'сразу выбрасываем' : U.join.pol === 'wait' ? 'ждём заказ 10 мин, потом выбрасываем' : 'ждём заказ 10 мин, потом в поток unmatched_payments'}</span></pre>`;
    VIEWS.join = () => {
      const J = U.join, B = isBiz();
      return `${ana(JOIN_TXT.life, JOIN_TXT.plain, B ? '' : JOIN_TXT.term)}
        <div class="lsv-ctls">${ctl(B ? 'Сколько ждать оплату после заказа' : 'Окно сведения: оплата не позже чем через', seg('jw', JWS, J.W, 'Окно сведения'))}</div>
        <div class="lsv-ctl"><b>${B ? 'Что делать с оплатой, для которой нет заказа' : 'Оплата без заказа (нет пары в состоянии)'}</b><div class="lsv-kinds" role="group" aria-label="Оплата без заказа">${JPOL.map(([v, n, s]) => `<button type="button" data-set="jpol:${v}" aria-pressed="${v === J.pol}"><b>${n}</b><small>${s}</small></button>`).join('')}</div></div>
        ${B ? '' : joinSql()}
        ${playCtl()}
        <div class="lsv-stage" id="lsvStage"></div>
        ${legend([['inf', 'заказ пришёл'], ['open', 'заказ ждёт оплату (окно)'], ['ok', 'оплата сведена с заказом'], ['wait', 'оплата ждёт заказ'], ['bad', 'потеряна или отменён оплаченный'], ['side', 'на сверку']])}
        <div class="lsv-kpis" id="lsvKpis"></div>
        <div class="lsv-three" id="lsvJout"></div>
        <div id="lsvNote"></div>
        ${nextBtn('join')}`;
    };
    function joinStatus(r, t) {
      const at = x => x != null && x <= t;
      if (at(r.match)) return ['✓', 'ok', 'оплачен'];
      if (r.o && at(r.unpaid)) return r.p && r.p.t <= t ? ['!', 'bad', 'отменён, хотя оплачен'] : ['✗', 'warn', 'не оплачен — отмена'];
      if (r.p && at(r.pdrop)) return ['✗', 'bad', 'оплата потеряна'];
      if (r.p && at(r.side)) return ['→', 'mut', 'оплата на сверке'];
      if (r.p && at(r.pwait)) return ['?', 'warn', 'оплата ждёт заказ'];
      if (r.o && r.o.at <= t) return ['…', 'mut', 'ждёт оплату'];
      return ['', 'mut', ''];
    }
    function joinSVG(W, R, t) {
      const L = 196, Rr = 14, X = s => L + (s - JT0) / (JT1 - JT0) * (W - L - Rr);
      const rowH = 24, y0 = 56, H = y0 + JIDS.length * rowH + 8, xt = X(clamp(t, JT0, JT1)), at = x => x != null && x <= t;
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Заказы и оплаты по времени: окно сведения и пары">`;
      h += tx(8, 16, `Заказы и оплаты · окно сведения ${R.W / 60} мин`, 'lsv-st') + tx(W - Rr, 16, '⏱ ' + hms(t), 'lsv-clock', 'end');
      for (let m = 0; m <= 50; m++) { const x = X(JT0 + m * 60), big = m % 5 === 0; h += ln(x, 41, x, big ? 48 : 45, 'lsv-tick'); if (big) h += tx(x, 36, hm(JT0 + m * 60), 'lsv-ax', m === 50 ? 'end' : 'middle'); }
      JIDS.forEach((id, i) => {
        const r = R.rows[id], y = y0 + i * rowH, cy = y + rowH / 2 - 1, [ic, cls] = joinStatus(r, t);
        h += rc(L, y + 1, W - L - Rr, rowH - 4, 'lsv-lane', 5);
        h += tx(10, cy + 4.5, ic, 'lsv-wv ' + cls) + tx(26, cy + 4.5, '№' + id, 'lsv-wt') + tx(76, cy + 4.5, r.o ? rub(r.o.amt) : 'заказа нет', 'lsv-ca' + (r.o ? '' : ' bad')) + (r.o ? cir(150, cy, 4.5, 'lsv-dot ' + r.o.city) + tx(158, cy + 4.5, CITY[r.o.city].slice(0, 3), 'lsv-bs') : '');
        if (r.o && r.o.at <= t) {
          const end = at(r.match) ? r.match : at(r.unpaid) ? r.unpaid : Math.min(t, r.o.et + R.W);
          h += rc(X(r.o.et), cy - 7, Math.max(2, X(end) - X(r.o.et)), 14, 'lsv-jwin' + (at(r.match) ? ' ok' : at(r.unpaid) ? (r.p && r.p.t <= t ? ' bad' : ' cut') : ''), 3);
          if (r.o.at > r.o.et) h += ln(X(r.o.et), cy, X(r.o.at), cy, 'lsv-jlate');
          h += rc(X(r.o.at) - 5, cy - 5, 10, 10, 'lsv-jo', 2);
          if (at(r.unpaid)) h += tx(X(r.unpaid) + 6, cy + 4.5, r.p && r.p.t <= t ? 'отменён!' : 'отмена', 'lsv-wv lsv-halo ' + (r.p && r.p.t <= t ? 'bad' : 'warn'));
        }
        if (r.p && r.p.t <= t) {
          const xp = X(r.p.t);
          if (r.pwait != null) { const e2 = at(r.match) ? r.match : at(r.pdrop) ? r.pdrop : at(r.side) ? r.side : Math.min(t, r.pwait + PWAIT); h += rc(xp, cy - 4, Math.max(2, X(e2) - xp), 8, 'lsv-pwait', 2); }
          if (at(r.match) && r.o) h += ln(X(r.o.at), cy, xp, cy, 'lsv-jlink');
          const pc2 = at(r.match) ? 'ok' : at(r.pdrop) ? 'bad' : at(r.side) ? 'side' : 'wait';
          h += `<polygon class="lsv-jp ${pc2}" points="${f1(xp)},${f1(cy - 7)} ${f1(xp + 7)},${f1(cy)} ${f1(xp)},${f1(cy + 7)} ${f1(xp - 7)},${f1(cy)}"/>`;
          const lx = Math.max(xp, at(r.pdrop) ? X(r.pdrop) : at(r.side) ? X(r.side) : xp) + 10;
          if (at(r.pdrop)) h += tx(lx, cy + 4.5, 'оплата потеряна', 'lsv-wv bad lsv-halo');
          else if (at(r.side)) h += tx(lx, cy + 4.5, '→ на сверку', 'lsv-wv mut lsv-halo');
          else if (!r.o && at(r.pwait)) h += tx(xp + 10, cy + 4.5, 'ждёт заказ…', 'lsv-wv warn lsv-halo');
        }
      });
      if (t < JT1) h += rc(xt, y0, W - Rr - xt, JIDS.length * rowH, 'lsv-future', 0);
      if (t <= JT1) h += ln(xt, 41, xt, H - 4, 'lsv-now');
      return h + '</svg>';
    }
    function joinKpis(R, t) {
      const B = isBiz(), S = joinSum(R, t);
      if (B) {
        return tile('Выручка в отчёте', rub(S.mSum), `${S.m.length} оплаченных заказов`)
          + tile('Отменили оплаченные', nf(S.bad.length), S.bad.length ? `${rub(S.badSum)} — клиент заплатил, заказ отменён` : 'таких нет', S.bad.length ? 'bad' : 'ok')
          + tile('Деньги без заказа', rub(S.lostSum + S.sideSum), S.lostSum ? `${rub(S.lostSum)} выпали из отчётов` : S.sideSum ? 'всё на сверке у финансов' : 'нет', S.lostSum ? 'bad' : S.sideSum ? 'warn' : 'ok')
          + tile('Обращений в поддержку', nf(S.bad.length + S.lost.length), `≈ ${rub((S.bad.length + S.lost.length) * BIZ.support)} на разбор`, S.bad.length + S.lost.length ? 'bad' : 'ok');
      }
      return tile('Сведено пар', nf(S.m.length), rub(S.mSum), 'ok')
        + tile('Не оплачено → отмена', nf(S.unp.length + S.bad.length), S.bad.length ? `из них ${S.bad.length} уже оплачены!` : 'оплата не пришла в окне', S.bad.length ? 'bad' : '')
        + tile('Оплаты без заказа', nf(S.lost.length + S.side.length), S.lost.length ? `${S.lost.length} потеряно` : S.side.length ? `${S.side.length} на сверке` : 'нет', S.lost.length ? 'bad' : S.side.length ? 'warn' : 'ok')
        + tile('В памяти джойна', nf(S.cur), `сейчас: заказов ${S.curO}, оплат ${S.curP} · пик ${R.maxSt}`, R.maxSt > 6 ? 'warn' : '');
    }
    function joinOut(R, t) {
      const S = joinSum(R, t), it = (r, txt, amt, cls) => `<li class="${cls || ''}"><span class="lsv-ft">${txt}</span><span>№${r.id}</span><b>${rub(amt)}</b></li>`;
      const box = (title, items, empty) => `<div class="lsv-box"><b class="lsv-h">${title}</b><ol class="lsv-res">${items.length ? items.join('') : `<li class="mut">${empty}</li>`}</ol></div>`;
      return box('Оплаченные заказы → в витрину выручки', S.m.map(r => it(r, hm(r.match), r.o.amt, 'ok')), 'пока ни одной пары')
        + box('Не оплачены в окне → автоотмена', S.unp.map(r => it(r, hm(r.unpaid), r.o.amt, 'warn')).concat(S.bad.map(r => it(r, hm(r.unpaid) + ' оплачен!', r.o.amt, 'bad'))), 'пока никого не отменили')
        + box('Оплаты без заказа', S.lost.map(r => it(r, hm(r.pdrop) + ' потеряна', r.p.amt, 'bad')).concat(S.side.map(r => it(r, hm(r.side) + ' сверка', r.p.amt, 'warn'))), 'таких пока нет');
    }
    function joinNote(R, t) {
      const B = isBiz(), S = joinSum(R, JT1), end = t >= JT1;
      let h = '';
      if (!end) h += card('', '<b>Следи за тремя строками.</b> №1003 оплатят через 16 минут — дольше, чем окно 15 минут. №1007 создан в 12:17, но дошёл до потока только в 12:19 — уже после оплаты (12:18): сервис заказов притормозил. №1011 — оплата есть, заказа нет совсем.');
      if (end && !B) {
        const parts = [];
        if (S.bad.length) parts.push(`${S.bad.length} ${plural(S.bad.length, 'заказ отменён', 'заказа отменены', 'заказов отменены')}, хотя оплата пришла: ${S.bad.map(r => r.orph != null && r.orph < r.o.at ? `у №${r.id} оплата пришла раньше заказа и была выброшена` : `№${r.id} оплатили через ${dur(r.p.t - r.o.et)} — дольше окна`).join(', ')}`);
        if (S.lost.length) parts.push(`${S.lost.length} ${plural(S.lost.length, 'оплата потеряна', 'оплаты потеряны', 'оплат потеряно')} на ${rub(S.lostSum)}`);
        if (S.side.length) parts.push(`${S.side.length} ${plural(S.side.length, 'оплата ушла', 'оплаты ушли', 'оплат ушло')} на сверку — их разберут люди`);
        h += card(S.lost.length || S.bad.length ? 'bad' : 'ok', `<b>Итог прогона.</b> Сведено ${S.m.length} из ${ORD.length} заказов. ${parts.length ? parts.join('; ') + '.' : 'Без потерь.'} В памяти джойна в пике — ${R.maxSt} ${plural(R.maxSt, 'запись', 'записи', 'записей')}${R.W === 1800 ? ': окно 30 минут ловит поздние оплаты, но держит неоплаченные заказы вдвое дольше — брошенный №1004 висел в резерве 30 минут. При тысячах заказов в час это вдвое больше памяти джойна' : ''}.`);
      }
      if (B) {
        h += card('biz', `<b>Для бизнеса.</b> Короткое окно отменяет заказы, за которые люди уже заплатили: возврат денег, звонок в поддержку (≈ ${rub(BIZ.support)}) и, возможно, потерянный клиент. Длинное окно держит товар в резерве дольше: брошенный заказ №1004 на ${rub(890)} полчаса недоступен другим покупателям. Оплату без заказа выбрасывать нельзя никогда: это деньги клиента — её отправляют на сверку финансам.`)
          + asm([`обращение в поддержку — ≈ ${rub(BIZ.support)}`, 'оплата без заказа: сбой в сервисе заказов или заказ пришёл позже оплаты', 'люди платят через 1–20 минут после заказа; 95 % — в первые 15 минут']);
      }
      return h;
    }
    DRAWS.join = () => {
      const st = $('#lsvStage'); if (!st) return;
      const R = joinR(), t = U.join.t;
      st.innerHTML = joinSVG(stageW(st), R, t);
      const S = joinSum(R, t), key = [R.key, S.m.length, S.unp.length, S.bad.length, S.lost.length, S.side.length, S.cur, MODE].join('|');
      put('#lsvKpis', key, () => joinKpis(R, t));
      put('#lsvJout', key, () => joinOut(R, t));
      put('#lsvNote', [R.key, MODE, t >= JT1].join('|'), () => joinNote(R, t));
    };

    /* ================= вкладка 5: происхождение данных и контракты ================= */
    const LIN_STEP = 380;
    const STW = { ok: '✓ цел', warn: '△ изменился', bad: '✗ сломан', stop: '⊘ остановлено', stale: '◷ старые данные', idle: '' };
    const STC = { ok: 'ok', warn: 'warn', bad: 'bad', stop: 'inf', stale: 'mut', idle: 'mut' };
    function linCheck() { const c = U.lin.chg; if (c === 'rename' && U.lin.guard === 'none') done('lineage'); if (c && CHG[c].breaks && U.lin.guard !== 'none') done('test'); }
    const linShown = col => isCalm() || performance.now() - U.lin.at >= col * LIN_STEP;
    const linDone = () => linShown(5);
    PARAMS.chg = v => { U.lin.chg = v === 'none' ? null : v; U.lin.at = performance.now(); render(); if (!isCalm() && U.lin.chg) startTimer(); linCheck(); };
    PARAMS.guard = v => { U.lin.guard = v; U.lin.at = performance.now(); render(); if (!isCalm() && U.lin.chg) startTimer(); linCheck(); };
    TICKS.lin = () => { draw(); return !linDone(); };
    VIEWS.lin = () => {
      const B = isBiz(), chg = U.lin.chg;
      return `${ana(LIN_TXT.life, LIN_TXT.plain, B ? '' : LIN_TXT.term)}
        <div class="lsv-ctl"><b>${B ? 'Что разработчики поменяли в базе заказов' : 'Изменение в источнике — таблице orders'}</b><div class="lsv-kinds lsv-k4" role="group" aria-label="Изменение в источнике">${CHG_ORDER.map(k => `<button type="button" data-set="chg:${k}" aria-pressed="${k === chg}"><b>${CHG[k].n}</b><small>${CHG[k].d}</small></button>`).join('')}</div></div>
        <div class="lsv-ctls">${ctl(B ? 'Чем защищены данные' : 'Защита', seg('guard', GUARDS.map(g => [g[0], g[1]]), U.lin.guard, 'Защита'))}${chg ? `<div class="lsv-ctl"><b>&nbsp;</b><button type="button" class="btn ghost" data-set="chg:none">Отменить изменение</button></div>` : ''}</div>
        ${chg && !B ? `<pre class="lsv-code">${esc(CHG[chg].sql)}</pre>` : ''}
        <div class="lsv-stage" id="lsvStage"></div>
        ${legend([['ok', 'цел'], ['warn', 'изменился, но работает'], ['bad', 'сломан или врёт'], ['inf', 'остановлено защитой'], ['side', 'показывает старые верные данные']])}
        <div class="lsv-kpis" id="lsvKpis"></div>
        <div class="lsv-two"><div class="lsv-box"><b class="lsv-h">${B ? 'Что почувствуют люди' : 'Что сломается — по пути данных'}</b><ol class="lsv-impact" id="lsvImpact"></ol></div><div class="lsv-box"><b class="lsv-h">${B ? 'Договор о данных' : 'Контракт данных shop.orders'}</b>${B ? '<p class="lsv-p">Команда «Заказы» владеет данными и отвечает за них. Записано, кто пользуется данными (подсчёт выручки, антифрод), какие поля обязательны и в каком виде, и как быстро данные должны доезжать — не дольше 5 минут. Добавлять новое можно когда угодно; убрать или переименовать — только через новую версию, когда все потребители перешли.</p>' : `<pre class="lsv-code">${CONTRACT}</pre>`}</div></div>
        <div id="lsvNote"></div>
        ${B ? '' : `<div class="lsv-tablewrap"><table class="lsv-table txt"><caption>Эволюция схемы: что можно менять без новой версии</caption><thead><tr><th>Изменение</th><th>Можно?</th><th>Как правильно</th></tr></thead><tbody>${EVOL.map(([a, b, c2, cls]) => `<tr><th>${a}</th><td class="${cls}">${b}</td><td>${c2}</td></tr>`).join('')}</tbody></table></div>`}
        ${nextBtn('lin')}`;
    };
    function linSVG(W) {
      const chg = U.lin.chg, C = CHG[chg], S = linStatus(chg, U.lin.guard), guard = U.lin.guard;
      const L = 12, Rr = 12, dashW = 186, gapX = 24, colW = (W - L - Rr - dashW) / 5, nw = colW - gapX, nh = 62, H = 280;
      const pos = {};
      LN.forEach(n => { const d = ['d1', 'd2', 'd3'].indexOf(n.id), cy = d < 0 ? 116 : 42 + d * 74; pos[n.id] = { x: L + n.col * colW, y: cy - nh / 2, w: d < 0 ? nw : dashW, h: nh, cy }; });
      const st = id => { const n = LN.find(x => x.id === id); return chg && linShown(n.col) ? S[id][0] : 'idle'; };
      let h = `<svg class="lsv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Граф происхождения данных: от таблицы заказов до трёх дашбордов">`;
      LE.forEach(([a, b]) => {
        const A = pos[a], Bp = pos[b], sb = st(b), sa = st(a), cls = sa === 'stop' ? 'cut' : sb === 'bad' || sb === 'stop' ? 'bad' : sb === 'warn' ? 'warn' : sb === 'stale' ? 'cut' : '';
        h += arrow(A.x + A.w + 3, A.cy, Bp.x - 4, Bp.cy, 'lin ' + cls);
      });
      LN.forEach(n => {
        const p = pos[n.id], s = st(n.id);
        h += rc(p.x, p.y, p.w, p.h, 'lsv-node ' + s, 9) + tx(p.x + 10, p.y + 20, esc(n.t), n.col < 5 ? 'lsv-nt' : 'lsv-ntd') + tx(p.x + 10, p.y + 37, n.k, 'lsv-bs');
        if (s !== 'idle') h += tx(p.x + 10, p.y + 54, STW[s], 'lsv-wv ' + STC[s]);
      });
      /* защита — метки над узлами */
      const tag = (id, t2, cls) => { const p = pos[id], w = t2.length * 7 + 16; return rc(p.x, p.y - 24, w, 19, 'lsv-tagr ' + cls, 9) + tx(p.x + 8, p.y - 10, t2, 'lsv-wv ' + (cls === 'inf' ? 'inf' : 'ok')); };
      if (guard === 'contract') h += tag('src', 'контракт v1.3 · CI', 'inf') + tag('topic', 'Schema Registry', 'inf');
      if (guard === 'test') h += tag('mart', 'тесты ×4', 'inf');
      /* колонки: какие поля есть и какие читает поток */
      const shownSrc = chg && linShown(0), shownFlow = chg && linShown(3), shownMart = chg && linShown(4);
      const colList = (id, title, rows) => { const p = pos[id]; let s = tx(p.x + 2, 172, title, 'lsv-bs'); rows.forEach((r, i) => { s += tx(p.x + 2, 190 + i * 16, r[0], 'lsv-col ' + (r[1] || '')); }); return s; };
      const srcRows = SRC_COLS.map(c => {
        if (!shownSrc || !C || c !== C.col) return [c];
        if (chg === 'rename') return ['amount → total', guard === 'contract' ? 'inf' : 'bad'];
        if (chg === 'drop') return ['city — удалена', guard === 'contract' ? 'inf' : 'bad'];
        if (chg === 'type') return ['amount: ₽ → коп.', guard === 'contract' ? 'inf' : 'warn'];
        return [c];
      });
      if (shownSrc && chg === 'add') srcRows.push(['+ promo_code', 'ok']);
      h += colList('src', 'колонки:', srcRows);
      const brk = C && C.breaks && guard !== 'contract';
      h += colList('flow', 'читает:', FLOW_COLS.map(c => shownFlow && brk && c === C.col ? [c + (chg === 'type' ? ' ×100' : ' → NULL'), 'bad'] : [c]));
      h += colList('mart', 'пишет:', MART_COLS.map(c => shownMart && brk && ((chg === 'drop' && c === 'city') || (chg !== 'drop' && c === 'revenue')) ? [c + (chg === 'drop' ? ' = NULL' : chg === 'type' ? ' ×100' : ' = 0'), guard === 'test' ? 'inf' : 'bad'] : [c]));
      if (!chg) h += tx(pos.cdc.x + 2, 172, 'выбери изменение выше —', 'lsv-bs') + tx(pos.cdc.x + 2, 190, 'покажу, что сломается', 'lsv-bs');
      return h + '</svg>';
    }
    function linImpact() {
      const chg = U.lin.chg, B = isBiz();
      if (!chg) return '<li class="mut">Пока ничего не меняли. Граф показывает путь данных: кто от кого зависит.</li>';
      const S = linStatus(chg, U.lin.guard);
      const vis = LN.filter(n => linShown(n.col)), lastCol = vis.length ? vis[vis.length - 1].col : -1, wave = !linDone() || performance.now() - U.lin.at < 5 * LIN_STEP + 450;
      return vis.map(n => { const [s, t1, t2] = S[n.id]; return `<li class="${s}${wave && n.col === lastCol ? ' new' : ''}"><span class="lsv-chip2 ${s}">${STW[s]}</span><span><b>${esc(n.t)}</b> — ${B ? t2 : t1}</span></li>`; }).join('');
    }
    function linDamage() {
      const chg = U.lin.chg, guard = U.lin.guard;
      if (!chg) return null;
      if (!CHG[chg].breaks) return { cls: 'ok', rub: 0, h: 'Ничего не сломалось: новое необязательное поле совместимо со всеми потребителями. Такие изменения можно делать без согласований.' };
      if (guard === 'contract') return { cls: 'ok', rub: 0, h: 'Поломка не вышла из сборки команды «Заказы»: разработчик видит ошибку проверки контракта и делает изменение через версию. Ущерб — 0 ₽. Цена — вести контракт и версии: день работы на старте и минуты на каждое изменение.' };
      if (guard === 'test') return { cls: 'warn', rub: 0, h: 'Тест данных не пустил неверные цифры в витрину. Дашборды показывают данные на 14:05 с плашкой «обновление задерживается»: решения откладываются на час, но по неверным цифрам их никто не принимает. Дежурный потока получил алерт за 5 минут; починка ≈ 1 час.' };
      const hrs = 6, under = BIZ.day * hrs / BIZ.hours;
      if (chg === 'rename') { const r = under * BIZ.miss + 2 * 3 * BIZ.acct; return { cls: 'bad', rub: r, h: `${hrs} часов дашборды показывают 0 ₽ — пока утром кто-то не спросит «почему нет продаж». Автозакупка на завтра занижена на ≈ <b>${rubK(under * BIZ.cost)}</b>: полкам не хватит товара на ≈ ${rubK(under * BIZ.miss)} продаж. Плюс 2 аналитика × 3 часа на поиск причины.` }; }
      if (chg === 'drop') return { cls: 'bad', rub: 6000 + under * 0.1, h: `${hrs} часов управляющие не видят свои города, склад не знает, куда везти завтрашний товар. Распределение вручную — день логиста (≈ 6 000 ₽) и перекос остатков: ≈ 10 % товара уедет не в тот город — ≈ ${rubK(under * 0.1)} продаж.` };
      return { cls: 'bad', rub: BIZ.day * BIZ.cost * 99 * 0.01, h: `Автозаказ на завтра — в 100 раз больше обычного (≈ ${rubK(BIZ.day * BIZ.cost * 100)} вместо ${rubK(BIZ.day * BIZ.cost)}). Если лимит у поставщика пропустит хотя бы 1 % лишнего — это ≈ <b>${rubK(BIZ.day * BIZ.cost * 99 * 0.01)}</b> товара, который некуда деть. А ${hrs} часов маркетинг празднует рекорд, которого нет.` };
    }
    function linKpis() {
      const chg = U.lin.chg, B = isBiz(), guard = U.lin.guard, S = linStatus(chg, guard), full = linDone();
      if (!chg) return tile('Узлов в графе', '8', 'таблица → CDC → топик → поток → витрина → 3 дашборда') + tile('Владелец источника', '«Заказы»', 'а дашбордами пользуются другие отделы') + tile('Потребителей у топика', '2', 'revenue_stream и antifraud');
      const badD = ['d1', 'd2', 'd3'].filter(k => S[k][0] === 'bad').length, hurt = LN.filter(n => S[n.id][0] !== 'ok').length;
      const where = !CHG[chg].breaks ? 'не нужно' : guard === 'contract' ? 'в сборке' : guard === 'test' ? 'перед витриной' : 'нигде';
      const who = !CHG[chg].breaks ? '—' : guard === 'contract' ? 'разработчик' : guard === 'test' ? 'дежурный' : 'люди, утром';
      const whoSub = !CHG[chg].breaks ? 'нечего замечать' : guard === 'contract' ? 'до выкладки, в CI' : guard === 'test' ? 'алерт за 5 минут' : '≈ через 6 часов, по жалобе';
      const D = linDamage();
      if (B) return tile('Дашбордов врут', full ? `${badD} из 3` : '…', badD ? 'по ним принимают решения' : 'цифры верные или явно помечены', full && badD ? 'bad' : full ? 'ok' : '')
        + tile('Кто заметит', who, whoSub, guard === 'none' && CHG[chg].breaks ? 'bad' : 'ok')
        + tile('Ущерб', full ? (D.rub ? '≈ ' + rubK(D.rub) : '0 ₽') : '…', D.rub ? 'если заметят через 6 часов' : 'неверных решений нет', full && D.rub ? 'bad' : full ? 'ok' : '');
      return tile('Сломано дашбордов', full ? `${badD} из 3` : '…', full ? (badD ? 'показывают неверные цифры' : 'неверных цифр нет') : 'волна идёт по графу', full && badD ? 'bad' : full ? 'ok' : '')
        + tile('Затронуто узлов', full ? `${hurt} из 8` : '…', 'всё, что не «цел»', full && hurt > 1 ? 'warn' : '')
        + tile('Где остановили', where, guard === 'contract' ? 'проверка контракта в CI' : guard === 'test' ? 'тест данных не пустил версию' : CHG[chg].breaks ? 'ошибка дошла до людей' : 'изменение совместимо', CHG[chg].breaks && guard === 'none' ? 'bad' : 'ok')
        + tile('Кто заметит', who, whoSub, guard === 'none' && CHG[chg].breaks ? 'bad' : 'ok');
    }
    function linNote() {
      const chg = U.lin.chg, B = isBiz(), guard = U.lin.guard;
      let h = '';
      if (!chg) return card('', `Начни с «${CHG.rename.n}» без защиты — это частое «безобидное» переименование. Потом включи тесты данных или контракт и повтори.`);
      if (!B && guard === 'test') h += card('info', `<b>Тесты витрины mart_revenue</b> (запускаются перед публикацией каждой новой версии):<ul>${DTESTS.map(([k, d]) => { const f = (TEST_FAIL[chg] || []).includes(k); return `<li><code>${k}</code> — ${d}: <b class="${f ? 'bad' : 'ok'}">${f ? 'упал' : 'прошёл'}</b></li>`; }).join('')}</ul>`);
      if (!B && guard === 'contract' && CHG[chg].breaks) h += card('info', `<b>Проверка в CI сервиса заказов:</b> <code>contract check shop.orders</code> → «несовместимое изменение: ${chg === 'rename' ? 'поле amount удалено, появилось total' : chg === 'drop' ? 'удалено обязательное поле city' : 'тип поля amount изменён: decimal → int64'}. Потребители: revenue_stream, antifraud». Правильный путь: ${chg === 'type' ? 'новое поле amount_kop рядом со старым' : chg === 'rename' ? 'добавить total, публиковать оба поля, перевести потребителей, потом удалить amount в v2' : 'выпустить v2 без city, 30 дней публиковать v1 и v2 параллельно'}.`);
      if (!B && guard === 'none' && CHG[chg].breaks) h += card('warn', '<b>Почему это опасно:</b> ни одна система не упала. CDC, Kafka, Flink и ClickHouse работают «зелёными» — мониторинг инфраструктуры молчит. Сломались только цифры, и узнают об этом люди. Защита — контракт на источнике и тесты на витрине.');
      if (B) { const D = linDamage(); if (D) h += card('biz ' + D.cls, `<b>Для бизнеса.</b> ${D.h}`) + (CHG[chg].breaks && guard === 'none' ? asm([`выручка сети ${rubK(BIZ.day)} в день, ${BIZ.hours} часов работы`, 'поломку без защиты замечают через ≈ 6 часов работы магазинов', chg === 'rename' ? 'закупка на завтра = 65 % выручки; из недостающего товара теряем половину продаж' : chg === 'drop' ? 'без разбивки по городам ≈ 10 % товара уезжает не туда' : 'лимит поставщика пропускает 1 % лишнего заказа', `час аналитика ≈ ${rub(BIZ.acct)}`]) : ''); }
      return h;
    }
    DRAWS.lin = () => {
      const st = $('#lsvStage'); if (!st) return;
      st.innerHTML = linSVG(stageW(st, 820));
      const prog = U.lin.chg ? LN.filter(n => linShown(n.col)).length : 0, key = [U.lin.chg, U.lin.guard, prog, MODE].join('|');
      put('#lsvImpact', key, linImpact);
      put('#lsvKpis', key + linDone(), linKpis);
      put('#lsvNote', [U.lin.chg, U.lin.guard, MODE].join('|'), linNote);
    };

    render();
    return {
      destroy() {
        U.alive = false; stopTimer();
        EL.removeEventListener('click', onClick); EL.removeEventListener('keydown', onKey);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      }
    };
  }

  /* ================= итоги ================= */
  const MEMO = [
    ['Окна', ['Tumbling — куски подряд: каждое событие в одном окне, итог в конце окна.', 'Sliding — окна накладываются: событие в «размер ÷ шаг» окнах, график плавный, вычислений больше.', 'Session — окно по паузе в действиях, у каждого ключа своё; длина заранее неизвестна.']],
    ['Время', ['Время события — когда случилось; время обработки — когда дошло. Считать надо по времени события.', 'Watermark — «часы потока»: всё раньше него считаем пришедшим. Окно закрывается по watermark, а не по часам на стене.', 'Чем дольше ждём опоздавших, тем точнее и тем позже результат.', 'Опоздавшее событие: отбросить, пересчитать окно (allowed lateness) или отправить в отдельный поток.']],
    ['Состояние и гарантии', ['Оператор держит состояние (суммы, окна); чекпойнт сохраняет его вместе с позицией чтения.', 'После падения поток перечитывает события после чекпойнта — без защиты приёмник получит дубли (at-least-once).', 'Exactly-once — запись в приёмник транзакцией, которая фиксируется вместе с чекпойнтом; цена — задержка видимости.', 'Идемпотентный приёмник (ключ события, upsert) — повтор безвреден.']],
    ['Соединение и данные', ['Join двух потоков держит события в памяти в пределах окна: окно больше — больше памяти и позже решение «не оплачен».', 'Событие без пары — не мусор: подождать, потом в отдельный поток на сверку.', 'Происхождение данных (lineage) показывает, что сломает изменение в источнике.', 'Контракт данных: схема, владелец, SLA свежести; добавить поле можно, удалить и переименовать — через новую версию. Тест данных останавливает плохую витрину до дашборда.']]
  ];
  const MEMO_BIZ = [
    ['Свежесть против точности', ['Табло «каждые 5 минут» замечает провал за минуты, часовой отчёт — за час.', 'Ждать опоздавшие покупки 5 минут — бесплатно для закупки на завтра и дорого для сигнала «касса упала».', 'Отброшенные опоздавшие — это заниженная выручка в отчёте и заниженная закупка.']],
    ['Деньги не должны двоиться', ['Дубли после аварии — несуществующая выручка в отчётах, переплаченные премии, часы сверки.', '«Ровно один раз» стоит задержки отчёта на интервал чекпойнта — для денег это почти всегда того стоит.']],
    ['Заказы и оплаты', ['Окно сведения слишком короткое — отменяем заказы, за которые уже заплатили.', 'Оплату без заказа нельзя выбрасывать: это деньги клиента и будущая жалоба.']],
    ['Кто отвечает за данные', ['Переименование колонки в базе заказов может обнулить три дашборда и автозакупку.', 'Контракт данных называет владельца и правила изменений; тесты данных ловят ошибку до того, как по ней примут решение.']]
  ];

  /* ================= регистрация ================= */
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'stream', title: 'Поток событий вживую', lede: 'Окна, watermark, exactly-once, join, контракты',
    intro: 'Поток покупок в сети магазинов в трёх городах: у каждой покупки есть время, когда её сделали, время, когда она дошла до сервера, сумма и город. Режем поток на окна и считаем выручку, ловим опоздавшие покупки, роняем оператор и ищем дубли, сводим заказы с оплатами и смотрим, какие дашборды сломает переименованная колонка. Переключатель «Техника | Бизнес» переводит всё в рубли и решения.',
    tasks: [
      { id: 'tumble', text: 'Прогони поток через окна по 5 минут до конца и получи выручку за каждое окно' },
      { id: 'slide', text: 'Найди покупку, которая попала сразу в пять скользящих окон' },
      { id: 'late', text: 'Спаси опоздавшую покупку: пересчитай окно или отправь её в отдельный поток' },
      { id: 'eo', text: 'Урони оператор с at-least-once и найди дубли, потом — без дублей' },
      { id: 'join', text: 'Сведи заказы с оплатами так, чтобы ни одна оплата не потерялась' },
      { id: 'lineage', text: 'Переименуй колонку в источнике и найди, какие дашборды сломаются' },
      { id: 'test', text: 'Поймай ту же поломку тестом данных или контрактом до дашборда' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
})();
