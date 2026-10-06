/* Лаборатория «Сквозная аналитика вживую» (id e2e): откуда пришёл покупатель и окупилась ли реклама.
   Сначала «на пальцах»: тезис, бытовая аналогия (листовки с купонами, кассир на входе, карта покупателя, чек,
   счёт за листовки, бухгалтер) и SVG-картинка цепочки — под каждым предметом его технический термин.
   Потом вкладки на одних и тех же данных (40 условных посетителей сентября, 14 заказов, 42 000 ₽):
   1) путь покупателя — касания из пяти каналов, каждое касание записывается событием с меткой;
   2) атрибуция — первый клик, последний клик, линейная, с затуханием: выручка и ROMI по каналам перестраиваются;
   3) потери событий — блокировщики и отказ от cookie, сбор в браузере против серверного, согласие и 152-ФЗ;
   4) склейка — анонимные id на устройствах, вход, ссылка из письма, телефон в заказе и ложная склейка по IP;
   5) расходы и окупаемость — импорт из рекламных кабинетов по расписанию, валюта, ROMI, CAC, LTV/CAC;
   6) архитектура — трекер → сборщик → очередь → поток / пакетная загрузка → озеро / хранилище → витрины → дашборд,
      плюс CRM, оплаты и кабинеты; узлы площадки queue, etl, lake, olap, cdc; диагноз поломки по цифрам.
   Допущения о деньгах — из js/xray-biz.js (объект A): чек 3 000 ₽, $1 = 90 ₽, конверсия 2 %. Свои — на экране.
   Стили — lab-e2e.css, префикс .e2e-. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const rub = v => nf(v) + ' ₽';
  const rubK = v => { const a = Math.abs(v); if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 2).replace(/,?0+$/, '') + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const sgn = v => v > 0 ? '+' : v < 0 ? '−' : '';
  const romiS = v => !isFinite(v) ? '∞' : Math.abs(v) < 0.005 ? '≈ 0 %' : sgn(v) + nf(Math.abs(v * 100)) + ' %';
  const pc = (x, d = 0) => dec(x * 100, d).replace(/,0+$/, '') + ' %';
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const cnt = (n, a, b, c) => nf(n) + ' ' + plural(n, a, b, c);
  const p2 = n => String(n).padStart(2, '0');
  const f1 = v => (+v).toFixed(1);
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  /* svg-кусочки */
  const tx = (x, y, t, c, a) => `<text class="${c || 'e2e-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const rc = (x, y, w, h, c, rx, at) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"${at || ''}/>`;
  const ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const cir = (x, y, r, c, at) => `<circle class="${c}" cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}"${at || ''}/>`;
  const head = (x2, y2, a, c) => { const L = 8, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`; return `<polygon class="${c || 'e2e-ah'}" points="${f1(x2)},${f1(y2)} ${p(0.42)} ${p(-0.42)}"/>`; };
  const wrap = (s, max) => { const out = []; let cur = ''; String(s).split(' ').forEach(w => { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }); if (cur) out.push(cur); return out; };

  /* ================= допущения ================= */
  /* из js/xray-biz.js, объект A: A.check = 3000, A.usdRub = 90, A.conv = 0.02 */
  const A = { check: 3000, usdRub: 90, conv: 0.02 };
  /* свои — показываются на экране: маржа 35 % — как в «Потоке событий» (закупка 65 % выручки); покупок за жизнь, расходы сентября */
  const OWN = { margin: 0.35, buys: 3, spend: { ads: 5200, soc: 3000 }, mailUsd: 15, loadH: 23 };
  const LTV = A.check * OWN.margin * OWN.buys;

  /* ================= каналы ================= */
  const CH = {
    ads: { n: 'Реклама', s: 'Яндекс Директ, поиск', utm: 'utm_source=yandex&utm_medium=cpc&utm_campaign=autumn', cid: '&yclid=73190…' },
    soc: { n: 'Соцсети', s: 'VK Реклама', utm: 'utm_source=vk&utm_medium=social&utm_campaign=autumn' },
    mail: { n: 'Рассылка', s: 'письмо подписчикам', utm: 'utm_source=newsletter&utm_medium=email&utm_campaign=sept' },
    seo: { n: 'Поиск', s: 'выдача Яндекса, бесплатно', utm: '', ref: 'yandex.ru' },
    dir: { n: 'Прямой заход', s: 'адрес набран сам, закладка', utm: '' }
  };
  const CHS = ['ads', 'soc', 'mail', 'seo', 'dir'], PAID = ['ads', 'soc', 'mail'];
  const DEV = { m: 'телефон', d: 'ноутбук', w: 'рабочий ПК' };
  const DEVG = { m: 'телефона', d: 'ноутбука', w: 'рабочего ПК' };
  const cdot = c => `<i class="e2e-cd e2e-c-${c}" aria-hidden="true"></i>`;
  const chip = c => `<span class="e2e-chip e2e-c-${c}">${cdot(c)}${CH[c].n}</span>`;

  /* ================= 40 условных посетителей сентября =================
     [имя, касания [день, канал, устройство], заказ [день, сумма, устройство, 'acc' — вошёл в аккаунт | 'guest' — гость с телефоном],
      на каких устройствах входил в аккаунт, вернувшийся покупатель] */
  const RAW = [
    ['Аня', [[2, 'soc', 'm'], [9, 'ads', 'd'], [12, 'mail', 'm']], [14, 3400, 'w', 'guest'], 'd'],
    ['Галина', [[5, 'soc', 'm']], [6, 2100, 'm', 'guest'], ''],
    ['Борис', [[3, 'soc', 'm'], [10, 'seo', 'd'], [16, 'ads', 'd']], [16, 4200, 'd', 'acc'], 'm'],
    ['Вика', [[4, 'soc', 'm'], [11, 'ads', 'm']], [11, 2600, 'm', 'acc'], ''],
    ['Глеб', [[6, 'soc', 'm'], [13, 'mail', 'd']], [13, 3000, 'd', 'acc'], 'm'],
    ['Дина', [[7, 'soc', 'm'], [8, 'ads', 'm']], [8, 1900, 'm', 'guest'], ''],
    ['Егор', [[9, 'ads', 'd'], [20, 'mail', 'd']], [20, 3600, 'd', 'acc'], ''],
    ['Жанна', [[12, 'seo', 'd'], [19, 'ads', 'm']], [19, 2800, 'm', 'acc'], 'd'],
    ['Зоя', [[15, 'seo', 'd']], [15, 2500, 'd', 'guest'], ''],
    ['Илья', [[17, 'ads', 'm']], [17, 4200, 'm', 'acc'], ''],
    ['Кира', [[18, 'soc', 'm'], [26, 'dir', 'd']], [26, 3100, 'd', 'acc'], 'm'],
    ['Лев', [[21, 'mail', 'd'], [27, 'dir', 'd']], [27, 2400, 'd', 'acc'], '', 1],
    ['Мира', [[22, 'seo', 'd'], [29, 'mail', 'm']], [30, 2900, 'm', 'guest', '08:47'], 'd', 1],
    ['Нина', [[8, 'soc', 'm'], [16, 'seo', 'd'], [23, 'ads', 'd'], [30, 'mail', 'm']], [30, 3300, 'm', 'acc', '09:32'], 'd'],
    ['Олег', [[4, 'ads', 'w']], null, ''], ['Ира', [[7, 'seo', 'w']], null, ''], ['Павел', [[1, 'soc', 'm']], null, ''],
    ['Рита', [[3, 'soc', 'm'], [15, 'soc', 'm']], null, ''], ['Семён', [[5, 'ads', 'd']], null, ''],
    ['Таня', [[6, 'soc', 'm'], [20, 'seo', 'd']], null, 'md'], ['Ульяна', [[8, 'dir', 'd']], null, ''],
    ['Фёдор', [[9, 'ads', 'm'], [10, 'ads', 'm']], null, ''], ['Юля', [[10, 'soc', 'm']], null, ''],
    ['Яна', [[12, 'mail', 'm'], [24, 'dir', 'd']], null, 'd'], ['Артём', [[11, 'seo', 'd']], null, ''],
    ['Белла', [[13, 'soc', 'm']], null, ''], ['Вадим', [[14, 'ads', 'd']], null, ''],
    ['Гоша', [[14, 'soc', 'm'], [22, 'ads', 'm']], null, ''], ['Денис', [[15, 'dir', 'd']], null, ''],
    ['Ева', [[17, 'soc', 'm']], null, ''], ['Захар', [[18, 'seo', 'd'], [25, 'ads', 'd']], null, ''],
    ['Инна', [[12, 'mail', 'd']], null, ''], ['Костя', [[19, 'soc', 'm']], null, ''],
    ['Лиза', [[20, 'ads', 'm'], [26, 'soc', 'd']], null, 'md'], ['Макс', [[21, 'seo', 'm']], null, ''],
    ['Ника', [[23, 'soc', 'm']], null, ''], ['Оля', [[24, 'ads', 'd']], null, ''],
    ['Петя', [[25, 'soc', 'm'], [28, 'seo', 'd']], null, 'md'], ['Роман', [[27, 'dir', 'd']], null, ''],
    ['Света', [[28, 'soc', 'm']], null, '']
  ];
  const usedId = new Set();
  const anonOf = (name, dev) => { let h = fnv(name + '/' + dev) & 0xfff, id; do { id = 'a-' + h.toString(16).padStart(3, '0'); h = (h + 0x9e7) & 0xfff; } while (usedId.has(id)); usedId.add(id); return id; };
  const hmOf = (name, day, k) => { const h = fnv(name + ':' + day + ':' + k); return p2(8 + h % 14) + ':' + p2((h >>> 8) % 60); };
  const PEOPLE = RAW.map((r, i) => {
    const [name, tt, ord, login, ret] = r;
    const touches = tt.map(([day, ch, dev], k) => ({ day, ch, dev, hm: hmOf(name, day, k) })).sort((a, b) => a.day - b.day || a.hm.localeCompare(b.hm));
    const order = ord ? { day: ord[0], amt: ord[1], dev: ord[2], how: ord[3], hm: ord[4] || hmOf(name, ord[0], 9), id: 10001 + i } : null;
    if (order) touches.forEach(t => { if (t.day === order.day && t.hm > order.hm) t.hm = order.hm.slice(0, 3) + p2(Math.max(0, +order.hm.slice(3) - 6)); });
    const devs = [...new Set(touches.map(t => t.dev).concat(order ? [order.dev] : []))];
    const anon = {}; devs.forEach(d => { anon[d] = anonOf(name, d); });
    return { i, name, touches, order, login: login || '', ret: !!ret, devs, anon, cid: 'c-' + (1001 + i) };
  });
  const BUYERS = PEOPLE.filter(p => p.order);
  const TOTAL = BUYERS.reduce((a, p) => a + p.order.amt, 0);
  const TOUCHES = PEOPLE.reduce((a, p) => a + p.touches.length, 0);
  const dateS = d => p2(d) + '.09';

  /* ================= атрибуция ================= */
  const MODELS = [['first', 'Первый клик'], ['last', 'Последний клик'], ['linear', 'Линейная'], ['decay', 'С затуханием']];
  const MNAME = Object.fromEntries(MODELS);
  const HLS = [[3, '3 дня'], [7, '7 дней'], [14, '14 дней']];
  function weightsOf(model, touches, od, hl) {
    const n = touches.length;
    if (!n) return [];
    if (model === 'first') return touches.map((t, i) => i === 0 ? 1 : 0);
    if (model === 'last') return touches.map((t, i) => i === n - 1 ? 1 : 0);
    if (model === 'linear') return touches.map(() => 1 / n);
    const w = touches.map(t => Math.pow(2, -(od - t.day) / hl)), s = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / s);
  }
  /* доли заказа в целых рублях: остатки раздаём по наибольшей дробной части — сумма долей ровно равна сумме заказа */
  function splitRub(amt, w) {
    const raw = w.map(x => x * amt), fl = raw.map(Math.floor);
    let rest = amt - fl.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - fl[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (rest > 0) { fl[i]++; rest--; } });
    return fl;
  }
  /* orders: [{ amt, day, touches, isNew }] — касания без заказа или заказ без касаний → «прямой заход» */
  function attribute(model, hl, orders) {
    const by = {}, nw = {}; CHS.forEach(c => { by[c] = 0; nw[c] = 0; });
    const parts = orders.map(o => {
      const ts = o.touches.length ? o.touches : [{ ch: 'dir', day: o.day, dev: o.dev, implicit: true }];
      const w = weightsOf(model, ts, o.day, hl), r = splitRub(o.amt, w);
      ts.forEach((t, i) => { by[t.ch] += r[i]; if (o.isNew) nw[t.ch] += w[i]; });
      return ts.map((t, i) => ({ ch: t.ch, day: t.day, dev: t.dev, w: w[i], rub: r[i], implicit: !!t.implicit }));
    });
    return { by, nw, parts, total: orders.reduce((a, o) => a + o.amt, 0) };
  }
  const TRUE_ORDERS = BUYERS.map(p => ({ p, amt: p.order.amt, day: p.order.day, dev: p.order.dev, touches: p.touches.filter(t => t.day <= p.order.day), isNew: !p.ret }));
  const attrTrue = (model, hl) => attribute(model, hl, TRUE_ORDERS);

  /* ================= склейка ================= */
  const RULES = [
    ['login', 'Вход в аккаунт', 'человек вошёл на сайте под своим логином — anon_id ↔ user_id'],
    ['mail', 'Ссылка из письма', 'в ссылке рассылки — id подписчика: устройство, где её открыли, — его'],
    ['phone', 'Телефон в заказе', 'гость оформил заказ с телефоном — CRM находит покупателя по номеру'],
    ['fuzzy', 'Тот же IP и модель', 'вероятностная: похожее устройство в той же сети — «наверное, тот же человек»']
  ];
  const RULE_C = { login: 'info', mail: 'warn', phone: 'acc', fuzzy: 'bad' };
  const DEVS = [];
  PEOPLE.forEach(p => p.devs.forEach(d => {
    const ev = [];
    if (p.login.includes(d) || (p.order && p.order.dev === d && p.order.how === 'acc')) ev.push('login');
    if (p.touches.some(t => t.ch === 'mail' && t.dev === d)) ev.push('mail');
    if (p.order && p.order.dev === d && p.order.how === 'guest') ev.push('phone');
    DEVS.push({ k: DEVS.length, p, dev: d, anon: p.anon[d], ev });
  }));
  const devOf = (name, d) => DEVS.find(x => x.p.name === name && x.dev === d);
  const FUZZY = [['Аня', 'm', 'Галина', 'm', 'домашний Wi-Fi и одинаковые телефоны'], ['Олег', 'w', 'Ира', 'w', 'один офис и одинаковые рабочие ноутбуки']];
  function stitch(on) {
    const par = DEVS.map((x, i) => i), P0 = DEVS.length, pp = {};
    const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    PEOPLE.forEach((p, i) => { pp[i] = P0 + i; par.push(P0 + i); });
    DEVS.forEach(d => { if (d.ev.some(e => on[e])) u(d.k, pp[d.p.i]); });
    if (on.fuzzy) FUZZY.forEach(([a, da, b, db]) => u(devOf(a, da).k, devOf(b, db).k));
    const comp = {}; DEVS.forEach(d => { const r = f(d.k); (comp[r] = comp[r] || []).push(d); });
    const comps = Object.values(comp);
    const ofDev = {}; comps.forEach((c, ci) => c.forEach(d => { ofDev[d.k] = ci; }));
    const buyers = comps.filter(c => c.some(d => d.p.order && d.p.order.dev === d.dev)).length;
    const falseN = comps.reduce((a, c) => a + new Set(c.map(d => d.p.i)).size - 1, 0);
    const missN = PEOPLE.reduce((a, p) => a + new Set(DEVS.filter(d => d.p === p).map(d => ofDev[d.k])).size - 1, 0);
    /* заказ видит касания всех устройств своей компоненты (и чужих людей, если склеили лишнее) */
    const orders = BUYERS.map(p => {
      const ci = ofDev[devOf(p.name, p.order.dev).k], ts = [];
      comps[ci].forEach(d => d.p.touches.forEach(t => { if (t.dev === d.dev && (t.day < p.order.day || (t.day === p.order.day && t.hm <= p.order.hm))) ts.push(t); }));
      ts.sort((a, b) => a.day - b.day || a.hm.localeCompare(b.hm));
      return { p, amt: p.order.amt, day: p.order.day, dev: p.order.dev, touches: ts, isNew: !p.ret };
    });
    return { comps, ofDev, vis: comps.length, buyers, conv: buyers / comps.length, falseN, missN, exact: falseN === 0 && missN === 0, orders };
  }

  /* ================= потери событий: 100 заказов недели ================= */
  const LOSS = (() => {
    const r = rng(930), chs = [];
    [['ads', 32], ['mail', 24], ['seo', 16], ['soc', 14], ['dir', 14]].forEach(([c, n]) => { for (let i = 0; i < n; i++) chs.push(c); });
    for (let i = chs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [chs[i], chs[j]] = [chs[j], chs[i]]; }
    return chs.map((ch, i) => ({ i, n: 20001 + i, ch, u1: r(), u2: r(), ev: 3 + Math.floor(r() * 7), dev: r() < 0.55 ? 'm' : 'd' }));
  })();
  const KEEP_BLOCKED = 0.2;   /* часть блокировщиков узнаёт и свой домен: из заблокированных сервер не вернёт каждого пятого */
  const lossOf = (o, mode, pB, pR) => o.u2 < pR ? 'refuse' : o.u1 < pB ? (mode === 'server' ? (o.u1 < pB * KEEP_BLOCKED ? 'block' : 'back') : 'block') : 'ok';
  function lossRun(mode, pB, pR) {
    const st = LOSS.map(o => lossOf(o, mode, pB, pR)), n = k => st.filter(s => s === k).length;
    const ev = LOSS.reduce((a, o) => a + o.ev, 0), evOk = LOSS.reduce((a, o, i) => a + (st[i] === 'ok' || st[i] === 'back' ? o.ev : 0), 0);
    const byCh = {}; CHS.forEach(c => { byCh[c] = { real: 0, seen: 0 }; });
    LOSS.forEach((o, i) => { byCh[o.ch].real++; if (st[i] === 'ok' || st[i] === 'back') byCh[o.ch].seen++; });
    return { st, ok: n('ok'), back: n('back'), block: n('block'), refuse: n('refuse'), lost: n('block') + n('refuse'), ev, evOk, byCh };
  }

  /* ================= расходы и окупаемость ================= */
  /* сейчас 30 сентября, почти полночь — закрываем месяц. Директ и VK тратят ровно каждый день, рассылка — абонентская плата $15, списана 1-го.
     Суточная загрузка в 06:00 забрала расходы по 29-е; часовая — по 23:00 30-го. В кабинетах — весь месяц. */
  function spendOf(ch, sched, cur) {
    if (ch === 'mail') { const usd = OWN.mailUsd; return { cab: '$' + usd, dwh: cur === 'rub' ? usd * A.usdRub : usd, now: usd * A.usdRub, raw: cur !== 'rub', today: 0, todayNow: 0 }; }
    const day = OWN.spend[ch] / 30, h = sched === 'hourly' ? OWN.loadH : 0;
    return { cab: rub(OWN.spend[ch]), dwh: day * (29 + h / 24), now: OWN.spend[ch], raw: false, today: day * h / 24, todayNow: day };
  }
  function roiRows(model, hl, sched, cur) {
    const at = attrTrue(model, hl);
    return PAID.map(ch => {
      const sp = spendOf(ch, sched, cur), rev = at.by[ch], romi = (rev * OWN.margin - sp.dwh) / sp.dwh, nw = at.nw[ch], cac = nw > 0.001 ? sp.dwh / nw : Infinity;
      return { ch, sp, rev, romi, romiTrue: (rev * OWN.margin - sp.now) / sp.now, nw, cac, lc: isFinite(cac) ? LTV / cac : 0 };
    });
  }

  /* ================= «Простыми словами»: шесть пар «аналогия ↔ термин» ================= */
  const PAIRS = [
    { k: 1, a: 'Листовка с купоном', t: 'UTM-метка, click id', term: 'Рекламный канал и метка: UTM, click id',
      shop: 'Листовки раздают у метро, в газете и через друзей. На каждой — купон со своим кодом: по коду видно, где человек взял листовку. Метро — как реклама в поиске, газета — как рассылка, друзья — как соцсети.',
      sys: 'Каждая рекламная ссылка помечена метками <b>UTM</b>: источник, тип рекламы, кампания. Рекламная система добавляет ещё <b>click id</b> — номер конкретного клика (yclid в Яндекс Директе, gclid в Google Ads): по нему клик потом сверяют с расходом.',
      ex: 'shop.ru/sale?utm_source=yandex&amp;utm_medium=cpc\n  &amp;utm_campaign=autumn&amp;yclid=73190…' },
    { k: 2, a: 'Кассир на входе', t: 'трекер и события', term: 'Трекер и сбор событий',
      shop: 'На входе кассир смотрит купон и ставит в журнале отметку: «пришёл от метро, 12 сентября, 14:05». Без купона пишет «сам пришёл».',
      sys: '<b>Трекер</b> — скрипт на сайте или SDK в приложении. На каждое действие — визит, просмотр товара, корзина — он отправляет <b>событие</b> на сборщик: что случилось, когда, анонимный id посетителя из cookie и метки из адреса. Нет меток и нет сайта, с которого пришёл, — это «прямой заход».',
      ex: '{ "event": "page_view", "ts": "2026-09-02 19:41",\n  "anon_id": "a-7f3", "utm_source": "vk", "utm_medium": "social" }' },
    { k: 3, a: 'Карта покупателя', t: 'склейка id', term: 'Склейка: identity resolution',
      shop: 'Карта постоянного покупателя связывает визиты: в первый раз человек только посмотрел, во второй — купил. Без карты кассир решил бы, что это два разных человека.',
      sys: 'У одного человека несколько анонимных id: на телефоне, ноутбуке, рабочем компьютере. Когда он входит в аккаунт, открывает ссылку из письма или оставляет телефон в заказе, его id <b>склеиваются</b> в один профиль покупателя.',
      ex: 'a-7f3 (телефон) + a-91c (ноутбук) + a-2d0 (работа)\n  → покупатель c-1001' },
    { k: 4, a: 'Чек', t: 'заказ и оплата', term: 'Заказ и оплата: CRM и платёжная система',
      shop: 'Чек — доказательство покупки: сумма, дата, что купили. Если товар вернули, чек аннулируют.',
      sys: 'Заказ и его статус живут в <b>CRM</b>, оплата и возврат — в <b>платёжной системе</b>. Выручку аналитика берёт оттуда, а не из события «спасибо за заказ» в браузере: оплата могла не пройти, заказ — вернуться.',
      ex: 'order 10001 · 3 400 ₽ · status: paid\n  utm из адреса первой страницы: vk / social' },
    { k: 5, a: 'Счёт за листовки', t: 'импорт расходов', term: 'Расходы: импорт из рекламных кабинетов',
      shop: 'Типография присылает счёт за листовки — отдельно за каждое место раздачи. Приходит он позже покупок, а зарубежная — выставляет в долларах.',
      sys: 'Расходы лежат в <b>рекламных кабинетах</b>. Их забирают по API <b>по расписанию</b> — раз в сутки или в час (ETL), переводят в рубли и раскладывают по тем же меткам UTM, что и визиты.',
      ex: '2026-09-29 · yandex / cpc / autumn\n  расход 173 ₽ · 412 показов · 9 кликов' },
    { k: 6, a: 'Бухгалтер', t: 'витрина: ROMI, CAC, LTV', term: 'Хранилище, витрина, атрибуция, ROMI, CAC, LTV',
      shop: 'В конце месяца бухгалтер раскладывает чеки по купонам, рядом кладёт счета и считает, сколько рублей принёс каждый рубль, потраченный на листовки.',
      sys: 'Всё сводится в <b>хранилище</b> (DWH или озеро данных). <b>Витрина</b> считает <b>атрибуцию</b> — какому каналу засчитать заказ, если касаний было несколько, — и показатели: <b>ROMI</b> (окупаемость рекламы), <b>CAC</b> (цена нового покупателя), <b>LTV</b> (сколько он принесёт за всё время).',
      ex: 'ROMI = (выручка × маржа − расход) ÷ расход\nCAC  = расход ÷ новых покупателей' }
  ];
  /* рисунки предметов — в коробке 140 × 108, только переменные темы */
  const flyer = (x, y, r, c, lab) => `<g transform="translate(${x},${y}) rotate(${r} 27 37)"><rect class="e2e-i-paper" x="0" y="0" width="54" height="74" rx="4"/><rect class="e2e-i-band e2e-c-${c}" x="0" y="0" width="54" height="21" rx="4"/><rect class="e2e-i-band e2e-c-${c}" x="0" y="12" width="54" height="9"/><text class="e2e-i-bt" x="27" y="15" text-anchor="middle">${lab}</text><path class="e2e-i-line" d="M9 30h36M9 38h26"/><path class="e2e-i-perf" d="M3 49h48"/><rect class="e2e-i-cpn e2e-c-${c}" x="6" y="53" width="42" height="16" rx="3"/><text class="e2e-i-ct e2e-c-${c}" x="27" y="65.5" text-anchor="middle">−10%</text></g>`;
  const DRAW = {
    1: () => flyer(-6, 26, -15, 'soc', 'ДРУГ') + flyer(91, 26, 13, 'mail', 'ГАЗЕТА') + flyer(43, 8, -1, 'ads', 'МЕТРО'),
    2: () => `<path class="e2e-i-awn" d="M6 8h128v10H6z"/><path class="e2e-i-awn2" d="M6 18q8 9 16 0q8 9 16 0q8 9 16 0q8 9 16 0q8 9 16 0q8 9 16 0q8 9 16 0q8 9 16 0z"/>
      <rect class="e2e-i-paper2" x="12" y="30" width="38" height="76" rx="3"/><rect class="e2e-i-glass" x="18" y="36" width="26" height="30" rx="2"/><circle class="e2e-i-knob" cx="42" cy="78" r="2.4"/>
      <circle class="e2e-i-skin" cx="100" cy="50" r="10"/><path class="e2e-i-body" d="M82 84c0-12 8-20 18-20s18 8 18 20z"/>
      <rect class="e2e-i-paper2" x="58" y="82" width="78" height="24" rx="3"/>
      <g transform="rotate(-6 76 76)"><rect class="e2e-i-paper" x="62" y="68" width="30" height="18" rx="2"/><circle class="e2e-i-dot e2e-c-ads" cx="68" cy="73" r="2.2"/><circle class="e2e-i-dot e2e-c-mail" cx="68" cy="78.5" r="2.2"/><circle class="e2e-i-dot e2e-c-soc" cx="68" cy="84" r="2.2"/><path class="e2e-i-line thin" d="M73 73h14M73 78.5h11M73 84h13"/></g>
      <circle class="e2e-i-lens" cx="124" cy="66" r="7"/><path class="e2e-i-line" d="M129 71l5 5"/>
      <path class="e2e-i-bub" d="M52 24h40a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H80l-4 6-2-6H52a5 5 0 0 1-5-5V29a5 5 0 0 1 5-5z"/><text class="e2e-i-tt" x="72" y="38.5" text-anchor="middle">Купон?</text>`,
    3: () => `<rect class="e2e-i-card" x="8" y="18" width="124" height="76" rx="10"/><rect class="e2e-i-stripe" x="8" y="18" width="124" height="16" rx="10"/><rect class="e2e-i-stripe" x="8" y="26" width="124" height="8"/>
      <rect class="e2e-i-chip" x="20" y="42" width="20" height="15" rx="3"/><path class="e2e-i-chipl" d="M20 49.5h20M30 42v15"/><text class="e2e-i-tt" x="48" y="54">№ 1001</text>
      <path class="e2e-i-link" d="M32 78H98"/><circle class="e2e-i-stamp" cx="32" cy="78" r="8"/><circle class="e2e-i-stamp" cx="65" cy="78" r="8"/><circle class="e2e-i-stamp on" cx="98" cy="78" r="8"/><path class="e2e-i-tick" d="M94 78l3 3 5-6"/>`,
    4: () => `<path class="e2e-i-paper" d="M36 6h68v86l-6 6-6-6-6 6-6-6-6 6-6-6-6 6-6-6-6 6-6-6-6 6z"/><path class="e2e-i-line" d="M46 20h36M46 30h48M46 40h28M46 50h40"/><path class="e2e-i-perf" d="M42 60h56"/>
      <text class="e2e-i-tt" x="70" y="80" text-anchor="middle">3 400 ₽</text>
      <circle class="e2e-i-okc" cx="106" cy="26" r="15"/><path class="e2e-i-okt" d="M99 26l5 5 9-10"/>`,
    5: () => `<path class="e2e-i-paper" d="M30 8h58l16 16v80H30z"/><path class="e2e-i-fold" d="M88 8v16h16"/><path class="e2e-i-clip" d="M40 2v20a5 5 0 0 0 10 0V6"/>
      <text class="e2e-i-tt" x="38" y="38">СЧЁТ</text>
      <rect class="e2e-i-sq e2e-c-ads" x="38" y="48" width="8" height="8" rx="1.5"/><path class="e2e-i-line thin" d="M50 52h40"/>
      <rect class="e2e-i-sq e2e-c-mail" x="38" y="60" width="8" height="8" rx="1.5"/><path class="e2e-i-line thin" d="M50 64h32"/>
      <rect class="e2e-i-sq e2e-c-soc" x="38" y="72" width="8" height="8" rx="1.5"/><path class="e2e-i-line thin" d="M50 76h36"/>
      <path class="e2e-i-line" d="M38 90h56"/>
      <g transform="translate(96 72)"><rect class="e2e-i-paper" x="0" y="0" width="34" height="32" rx="4"/><rect class="e2e-i-cal" x="0" y="0" width="34" height="10" rx="4"/><rect class="e2e-i-cal" x="0" y="5" width="34" height="5"/><text class="e2e-i-tt" x="17" y="27" text-anchor="middle">30</text></g>`,
    6: () => `<rect class="e2e-i-paper2" x="104" y="6" width="32" height="40" rx="4"/><rect class="e2e-i-bar e2e-c-ads" x="109" y="16" width="6" height="24" rx="1"/><rect class="e2e-i-bar e2e-c-mail" x="117" y="24" width="6" height="16" rx="1"/><rect class="e2e-i-bar e2e-c-soc" x="125" y="32" width="6" height="8" rx="1"/>
      <circle class="e2e-i-skin" cx="70" cy="30" r="11"/><path class="e2e-i-body" d="M50 68c0-14 9-22 20-22s20 8 20 22z"/>
      <rect class="e2e-i-paper2" x="4" y="30" width="26" height="34" rx="3"/><rect class="e2e-i-screen" x="8" y="34" width="18" height="7" rx="1"/><path class="e2e-i-keys" d="M9 47h3M15 47h3M21 47h3M9 52h3M15 52h3M21 52h3M9 57h3M15 57h3M21 57h3"/>
      <path class="e2e-i-desk" d="M2 68h136"/>
      <path class="e2e-i-paper" d="M24 72l46 4v26l-46-4z"/><path class="e2e-i-paper" d="M116 72l-46 4v26l46-4z"/>
      <path class="e2e-i-line thin" d="M31 79l32 3M31 86l32 3M31 93l24 2M77 82l32-3M77 89l32-3M77 96l20-2"/>`
  };

  /* ================= картинка «аналогия ↔ термин» ================= */
  const PIC_WIDE = 860;
  function picSVG(W, sel, seen) {
    const wide = W >= PIC_WIDE;
    let pos, H, h = '';
    if (wide) {
      const cw = W / 5, cx = i => cw * (i + 0.5), yA = 44, yB = 262, y6 = 153;
      pos = { 1: [cx(0) - 70, yA], 2: [cx(1) - 70, yA], 3: [cx(2) - 70, yA], 4: [cx(3) - 70, yA], 5: [cx(0) - 70, yB], 6: [cx(4) - 70, y6] };
      H = yB + 172;
      h += tx(12, 18, 'ПУТЬ ПОКУПАТЕЛЯ: ОТ КУПОНА ДО ЧЕКА', 'e2e-lane') + tx(cx(4), 126, 'ИТОГ МЕСЯЦА', 'e2e-lane', 'middle');
      for (let i = 0; i < 3; i++) { const y = yA + 54, a = cx(i) + 74, b = cx(i + 1) - 76; h += `<path class="e2e-flow" d="M${f1(a)} ${y}H${f1(b)}"/>` + head(b + 2, y, 0); }
      const a4 = cx(3) + 74, b4 = cx(4) - 76;
      h += `<path class="e2e-flow" d="M${f1(a4)} ${yA + 54}C${f1(a4 + 26)} ${yA + 54} ${f1(b4 - 26)} ${y6 + 40} ${f1(b4)} ${y6 + 40}"/>` + head(b4 + 2, y6 + 40, 0);
      h += `<path class="e2e-flow money" d="M${f1(cx(0))} ${yA + 164}V${yB - 22}"/>` + head(cx(0), yB - 20, Math.PI / 2, 'e2e-ah money') + tx(cx(0) + 12, yA + 192, 'печать листовок стоит денег', 'e2e-note');
      const yb = yB + 54, xe = cx(4) - 76;
      h += `<path class="e2e-flow money" d="M${f1(cx(0) + 74)} ${yb}H${f1(xe - 40)}C${f1(xe - 14)} ${yb} ${f1(xe - 14)} ${y6 + 82} ${f1(xe)} ${y6 + 82}"/>` + head(xe + 2, y6 + 82, 0, 'e2e-ah money') + tx((cx(0) + 74 + xe - 40) / 2, yb - 10, 'в конце месяца: счета за рекламу', 'e2e-note', 'middle');
    } else {
      const x0 = 22, rowH = 136, top = 18, yy = i => top + i * rowH;
      pos = {}; [1, 2, 3, 4, 5, 6].forEach((k, i) => { pos[k] = [x0, yy(i)]; });
      H = top + 6 * rowH;
      for (let i = 0; i < 3; i++) { const y1 = yy(i) + 112, y2 = yy(i + 1) - 6; h += `<path class="e2e-flow" d="M${x0 + 70} ${y1}V${y2 - 2}"/>` + head(x0 + 70, y2, Math.PI / 2); }
      const r = 7, ym4 = yy(3) + 54, ym5 = yy(4) + 54, ym6 = yy(5) + 54;
      h += `<path class="e2e-flow" d="M${x0 - 4} ${ym4}H${r}V${ym6}H${x0 - 6}"/>` + head(x0 - 4, ym6, 0);
      h += `<path class="e2e-flow money" d="M${x0 - 4} ${ym5}H${r}"/>` + cir(r, ym5, 3, 'e2e-joint');
    }
    PAIRS.forEach(p => {
      const [x, y] = pos[p.k], on = sel === p.k;
      h += `<g class="e2e-it${on ? ' on' : ''}${seen[p.k] ? ' seen' : ''}" data-pair="${p.k}" data-a="pair:${p.k}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(p.k + '. ' + p.a + ' — это ' + p.term)}" transform="translate(${f1(x)},${f1(y)})">`;
      h += wide ? rc(-10, -16, 160, 176, 'e2e-it-bg', 14) : rc(-12, -12, W - x - 8 + 12, 128, 'e2e-it-bg', 14);
      h += `<g class="e2e-ill">${DRAW[p.k]()}</g>`;
      h += cir(2, 0, 11, 'e2e-it-n') + tx(2, 4.5, p.k, 'e2e-it-nt', 'middle');
      if (wide) h += tx(70, 130, esc(p.a), 'e2e-it-a', 'middle') + tx(70, 150, esc(p.t), 'e2e-it-t', 'middle');
      else {
        const cx0 = 154, max = Math.max(14, Math.floor((W - x - cx0 - 10) / 6.7));
        h += tx(cx0, 30, esc(p.a), 'e2e-it-a') + tx(cx0, 50, esc(p.t), 'e2e-it-t');
        wrap(p.term, max).slice(0, 3).forEach((s, i) => { h += tx(cx0, 74 + i * 18, esc(s), 'e2e-it-l'); });
      }
      h += '</g>';
    });
    return `<svg class="e2e-svg e2e-picsvg" viewBox="0 0 ${f1(W)} ${H}" width="${f1(W)}" height="${H}" role="group" aria-label="Цепочка сквозной аналитики: шесть предметов магазина и их термины"><defs><linearGradient id="e2eBrand" x1="0" x2="1" y1="0" y2="0"><stop offset="0" style="stop-color:var(--k-chat)"/><stop offset=".5" style="stop-color:var(--k-write)"/><stop offset="1" style="stop-color:var(--k-voice)"/></linearGradient></defs>${h}</svg>`;
  }

  /* ================= экземпляр лаборатории ================= */
  const TABS = [['plain', '0', 'Простыми словами'], ['path', '1', 'Путь покупателя'], ['attr', '2', 'Атрибуция'], ['loss', '3', 'Потери событий'], ['stitch', '4', 'Склейка'], ['roi', '5', 'Расходы и окупаемость'], ['arch', '6', 'Архитектура'], ['memo', '✓', 'Итоги']];
  const NEXT = { plain: ['path', 'путь покупателя'], path: ['attr', 'атрибуция'], attr: ['loss', 'потери событий'], loss: ['stitch', 'склейка'], stitch: ['roi', 'расходы и окупаемость'], roi: ['arch', 'архитектура'], arch: ['memo', 'что запомнить'] };

  function makeLab(EL, doneFn) {
    const U = {
      tab: 'plain', alive: true, timer: 0,
      plain: { hl: null, sel: null, seen: {} },
      path: { day: 30, play: false, filter: 'buy', sel: 0 },
      model: 'last', hl: 7, abuyer: 13, aq: null,
      loss: { mode: 'browser', pB: 0.25, pR: 0.15, cell: null, q: null },
      st: { on: { login: false, mail: false, phone: false, fuzzy: false } },
      roi: { sched: 'daily', cur: 'raw', q: null },
      arch: { mode: 'look', sel: null, broken: null, sym: 0, solved: {}, pick: null }
    };
    const done = id => { try { doneFn(id); } catch (e) { /* задание не засчиталось — не страшно */ } };
    const $ = s => EL.querySelector(s);

    /* общие кусочки разметки */
    const ana = (life, plain, term) => `<div class="e2e-ana"><p class="e2e-life"><span class="e2e-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="e2e-tag t">Термины</span>${term}</p>` : ''}</div>`;
    const seg = (name, items, cur, label) => `<div class="seg e2e-seg" role="group" aria-label="${esc(label)}">${items.map(([v, t]) => `<button type="button" data-a="${name}:${v}" aria-selected="${String(v) === String(cur)}">${t}</button>`).join('')}</div>`;
    const ctl = (label, html) => `<div class="e2e-ctl"><b>${label}</b>${html}</div>`;
    const tile = (label, val, sub, cls) => `<div class="e2e-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const card = (cls, html) => `<div class="e2e-card ${cls || ''}">${html}</div>`;
    const asm = list => `<details class="e2e-asm"><summary>Допущения для расчёта</summary><ul>${list.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul></details>`;
    const legend = items => `<div class="e2e-legend">${items.map(([c, t]) => `<span><i class="e2e-lg ${c}"></i>${t}</span>`).join('')}</div>`;
    const nextBtn = k => NEXT[k] ? `<div class="e2e-next"><button type="button" class="btn" data-go="${NEXT[k][0]}">Дальше: ${NEXT[k][1]} →</button></div>` : '';
    const quiz = (name, q, opts, picked, fb) => `<div class="e2e-quiz"><b class="e2e-qh">${q}</b><div class="e2e-qopts">${opts.map(([v, t]) => `<button type="button" class="e2e-qo${picked === v ? ' on' : ''}" data-a="${name}:${v}" aria-pressed="${picked === v}">${t}</button>`).join('')}</div>${fb ? `<div class="e2e-qfb ${fb.ok ? 'ok' : 'bad'}">${fb.ok ? '✓ ' : '✗ '}${fb.h}</div>` : ''}</div>`;
    const W0 = (sel, min) => { const el = $(sel); return Math.max(min || 300, Math.floor((el && el.clientWidth) || 860)); };

    const VIEWS = {}, DRAWS = {}, ACTS = {}, INPUTS = {};
    function render() {
      const v = $('#e2eView'); if (!v) return;
      const fa = document.activeElement, key = fa && EL.contains(fa) ? fa.getAttribute('data-a') : null;
      v.innerHTML = VIEWS[U.tab] ? VIEWS[U.tab]() : card('', 'Раздел готовится.');
      if (DRAWS[U.tab]) DRAWS[U.tab]();
      if (key) { const n = [...EL.querySelectorAll('[data-a]')].find(x => x.getAttribute('data-a') === key); if (n) try { n.focus({ preventScroll: true }); } catch (e) { /* без фокуса */ } }
    }
    function setTab(k) {
      if (!TABS.some(t => t[0] === k)) return;
      U.path.play = false; stopTimer();
      U.tab = k;
      EL.querySelectorAll('.e2e-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.e2e-tabs'), box = EL.closest('.lab-main'), cur = tabs && tabs.querySelector(`[data-tab="${k}"]`);
      if (tabs && cur && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, cur.offsetLeft - 24);
      if (tabs && box && tabs.getBoundingClientRect().top < box.getBoundingClientRect().top) tabs.scrollIntoView({ block: 'start' });
    }
    function startTimer(fn, ms) { stopTimer(); U.timer = setInterval(() => { if (!U.alive) { stopTimer(); return; } fn(); }, ms); }
    function stopTimer() { if (U.timer) clearInterval(U.timer); U.timer = 0; }

    /* ================= 0. Простыми словами ================= */
    VIEWS.plain = () => `<section class="e2e-hero"><span class="e2e-eyebrow">Простыми словами</span>
        <p class="e2e-thesis">Сквозная аналитика связывает каждый рубль выручки с тем, <b>откуда пришёл покупатель</b>, и с тем, <b>сколько стоило его привести</b>. Так видно, какая реклама окупается, а какая только тратит деньги.</p></section>
      <div class="e2e-ana"><p class="e2e-life"><span class="e2e-tag">Как в магазине</span>Магазин раздаёт листовки с купонами в трёх местах: у метро, в газете и через друзей — у каждого места свой код. На входе кассир смотрит купон и записывает, откуда пришёл покупатель. Карта постоянного покупателя связывает его визиты: в первый раз он только посмотрел, во второй купил. Каждая покупка — это чек. В конце месяца бухгалтер раскладывает чеки по купонам, кладёт рядом счета за печать листовок и видит, какие листовки принесли больше, чем стоили, а какие — меньше.</p>
        <p><span class="e2e-tag t">В системе</span>Всё то же самое: вместо купонов — метки в ссылках, вместо кассира — трекер на сайте, вместо карты — склейка id, вместо чеков — заказы из CRM, вместо счетов — расходы из рекламных кабинетов, вместо бухгалтера — хранилище и витрина с отчётом.</p></div>
      <div class="e2e-picbox"><div class="e2e-pichead"><b>Цепочка целиком</b><span>Наведи или нажми на предмет — подсвечу пару «аналогия ↔ термин»</span></div><div class="e2e-pic" id="e2ePic"></div></div>
      <div class="e2e-pairwrap"><div class="e2e-pairs" id="e2ePairs"></div><div class="e2e-detwrap" id="e2eDetail"></div></div>
      ${nextBtn('plain')}`;
    function pairsHTML() {
      const P = U.plain, n = Object.keys(P.seen).length;
      return `<b class="e2e-h">Шесть пар <small>открыто ${n} из 6</small></b>` + PAIRS.map(p => `<button type="button" class="e2e-pair${P.sel === p.k ? ' on' : ''}${P.seen[p.k] ? ' seen' : ''}" data-pair="${p.k}" data-a="pair:${p.k}" aria-pressed="${P.sel === p.k}"><span class="e2e-pn">${p.k}</span><span class="e2e-pa">${esc(p.a)}</span><span class="e2e-px" aria-hidden="true">↔</span><span class="e2e-pt">${esc(p.term)}</span></button>`).join('');
    }
    function detailHTML() {
      const p = PAIRS.find(x => x.k === (U.plain.hl || U.plain.sel));
      if (!p) return card('e2e-detail mut', '<b>Начни с листовки.</b> Нажми на любой предмет на картинке или на строку слева — здесь появится, как он выглядит в магазине и как в системе, с примером из жизни данных.');
      return `<div class="e2e-detail"><b class="e2e-dh"><span class="e2e-pn">${p.k}</span>${esc(p.a)} ↔ ${esc(p.term)}</b>
        <p><span class="e2e-tag">В магазине</span>${p.shop}</p><p><span class="e2e-tag t">В системе</span>${p.sys}</p><pre class="e2e-code">${p.ex}</pre></div>`;
    }
    DRAWS.plain = () => {
      const pic = $('#e2ePic'); if (!pic) return;
      pic.innerHTML = picSVG(W0('#e2ePic', 280), U.plain.sel, U.plain.seen);
      $('#e2ePairs').innerHTML = pairsHTML();
      $('#e2eDetail').innerHTML = detailHTML();
      paintHl();
    };
    /* подсветка пары без перерисовки: все элементы с тем же data-pair */
    function paintHl() {
      const k = U.plain.hl;
      EL.querySelectorAll('[data-pair]').forEach(x => x.classList.toggle('hl', String(k) === x.getAttribute('data-pair')));
      const s = $('.e2e-picsvg'); if (s) s.classList.toggle('has-hl', !!k);
    }
    function hoverPair(k) {
      if (U.tab !== 'plain' || U.plain.hl === k) return;
      U.plain.hl = k; paintHl();
      const d = $('#e2eDetail'); if (d) d.innerHTML = detailHTML();
    }
    function pickPair(k) {
      U.plain.sel = U.plain.sel === k && U.plain.seen[k] ? null : k;
      U.plain.seen[k] = true;
      if (Object.keys(U.plain.seen).length >= 6) done('plain');
      DRAWS.plain();
    }

    /* ================= 1. Путь покупателя ================= */
    const pathList = () => U.path.filter === 'buy' ? BUYERS : U.path.filter === 'no' ? PEOPLE.filter(p => !p.order) : PEOPLE;
    VIEWS.path = () => `${ana('Кассир на входе ведёт журнал: кто зашёл, когда и по какому купону. Один человек может прийти трижды по разным купонам — у метро, из газеты, от друга, — прежде чем что-то купит. А кто-то зайдёт один раз и уйдёт.',
        'Каждый заход на сайт — <b>касание</b>. Трекер записывает его <b>событием</b>: что сделал человек, когда, с какого устройства и с какой меткой источника. Аналитика видит не имена, а анонимные id — имена здесь только для удобства.',
        '<b>Касание (touchpoint)</b> — визит из канала. <b>Событие</b> — запись <code>{event, ts, anon_id, utm_*}</code> в сборщике. <b>Путь покупателя (customer journey)</b> — все касания одного человека до заказа.')}
      <div class="e2e-play"><div class="e2e-btns" id="e2ePlay"></div>${seg('pf', [['buy', 'Купили · 14'], ['no', 'Не купили · 26'], ['all', 'Все 40']], U.path.filter, 'Кого показать')}</div>
      <div class="e2e-stage" id="e2eStage"></div>
      ${legend([['e2e-c-ads', 'Реклама'], ['e2e-c-soc', 'Соцсети'], ['e2e-c-mail', 'Рассылка'], ['e2e-c-seo', 'Поиск'], ['e2e-c-dir', 'Прямой заход'], ['dm', 'телефон'], ['dd', 'ноутбук'], ['dw', 'рабочий ПК'], ['ord', 'заказ']])}
      <div class="e2e-kpis" id="e2eKpis"></div>
      <div class="e2e-two"><div class="e2e-box"><b class="e2e-h">События трекера <small>сначала свежие</small></b><ol class="e2e-feed" id="e2eFeed"></ol></div><div class="e2e-box" id="e2ePerson"></div></div>
      ${card('mut', `Условные 40 человек: покупателей среди них больше, чем в жизни (в среднем магазине покупают ≈ ${pc(A.conv)} посетителей), — чтобы путь каждого был виден. Средний чек — ${rub(A.check)}, как во всём тренажёре.`)}
      ${nextBtn('path')}`;
    const shape = (x, y, dev, cls) => dev === 'm' ? cir(x, y, 5.6, cls) : dev === 'd' ? rc(x - 5, y - 5, 10, 10, cls, 2.5) : `<polygon class="${cls}" points="${f1(x)},${f1(y - 6.6)} ${f1(x + 6.6)},${f1(y)} ${f1(x)},${f1(y + 6.6)} ${f1(x - 6.6)},${f1(y)}"/>`;
    function pathSVG(W) {
      const list = pathList(), D = U.path.day, L = W < 520 ? 62 : 88, R = 14, top = 40, rowH = 24;
      const step = (W - L - R) / 30, X = d => L + (d - 0.5) * step, H = top + list.length * rowH + 6;
      let h = `<svg class="e2e-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Касания посетителей по дням сентября">`;
      h += tx(8, 24, 'Сентябрь', 'e2e-ax');
      [1, 5, 10, 15, 20, 25, 30].forEach(d => { h += ln(X(d), 29, X(d), 35, 'e2e-tick') + tx(X(d), 24, d, 'e2e-ax', 'middle'); });
      if (D < 30) h += rc(X(D) + step / 2, top - 4, W - R - X(D) - step / 2, H - top + 2, 'e2e-future', 4);
      list.forEach((p, r) => {
        const y = top + r * rowH, cy = y + rowH / 2, on = U.path.sel === p.i;
        const vis = p.touches.filter(t => t.day <= D), ord = p.order && p.order.day <= D ? p.order : null;
        h += `<g class="e2e-prow${on ? ' on' : ''}" data-a="person:${p.i}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(p.name)}: ${cnt(vis.length, 'касание', 'касания', 'касаний')}${ord ? ', заказ ' + rub(ord.amt) : ''}">`;
        h += rc(2, y + 1, W - 4, rowH - 2, 'e2e-rowbg', 5) + tx(10, cy + 4.5, esc(p.name), 'e2e-rn');
        const xs = vis.map(t => X(t.day)), ox = ord ? X(ord.day) + (vis.some(t => t.day === ord.day) ? 10 : 0) : null;
        if (xs.length + (ord ? 1 : 0) > 1) h += ln(Math.min(...xs, ox == null ? 1e9 : ox), cy, Math.max(...xs, ox == null ? -1e9 : ox), cy, 'e2e-pline');
        vis.forEach(t => { h += shape(X(t.day), cy, t.dev, `e2e-dot e2e-c-${t.ch}${U.path.play && t.day === D ? ' new' : ''}`); });
        if (ord) h += rc(ox - 9, cy - 8, 18, 16, 'e2e-ord' + (U.path.play && ord.day === D ? ' new' : ''), 4) + tx(ox, cy + 4.3, '₽', 'e2e-ordt', 'middle');
        h += '</g>';
      });
      if (D >= 1 && D < 30) h += ln(X(D) + step / 2, top - 6, X(D) + step / 2, H - 2, 'e2e-now');
      return h + '</svg>';
    }
    const evName = t => t.ch === 'dir' ? 'визит без метки' : t.ch === 'seo' ? 'визит из поиска' : 'визит по ссылке';
    const utmOf = t => t.ch === 'seo' ? 'referrer=yandex.ru' : t.ch === 'dir' ? 'нет меток и referrer' : CH[t.ch].utm.replace(/&/g, ' ');
    function eventsOf(p, D) {
      const out = p.touches.filter(t => t.day <= D).map(t => ({ day: t.day, hm: t.hm, ch: t.ch, dev: t.dev, anon: p.anon[t.dev], kind: 'touch', t }));
      if (p.order && p.order.day <= D) out.push({ day: p.order.day, hm: p.order.hm, dev: p.order.dev, anon: p.anon[p.order.dev], kind: 'order', o: p.order });
      return out.sort((a, b) => a.day - b.day || a.hm.localeCompare(b.hm));
    }
    function feedHTML() {
      const D = U.path.day, all = [];
      PEOPLE.forEach(p => eventsOf(p, D).forEach(e => all.push(Object.assign({ p }, e))));
      all.sort((a, b) => b.day - a.day || b.hm.localeCompare(a.hm));
      if (!all.length) return '<li class="mut">Пока тихо. Нажми «Пуск» — дни пойдут, и трекер начнёт записывать события.</li>';
      return all.slice(0, 9).map(e => `<li class="${e.kind === 'order' ? 'ord' : ''}"><span class="e2e-ft">${dateS(e.day)} ${e.hm}</span>${e.kind === 'order' ? '<i class="e2e-cd ord" aria-hidden="true"></i>' : cdot(e.ch)}<span><code>${e.anon}</code> ${e.kind === 'order' ? `покупка · ${rub(e.o.amt)}` : `${evName(e.t)} · ${CH[e.ch].n}`} <small>(${esc(e.p.name)}, ${DEV[e.dev]})</small></span></li>`).join('');
    }
    function personHTML() {
      const p = PEOPLE[U.path.sel], D = U.path.day;
      if (!p) return '<b class="e2e-h">Выбери строку</b><p class="e2e-mut">Нажми на человека на графике — покажу его события.</p>';
      const evs = eventsOf(p, D), ts = p.touches.filter(t => t.day <= (p.order ? p.order.day : 30));
      const path = ts.map(t => chip(t.ch)).join('<span class="e2e-arr">→</span>') + (p.order ? `<span class="e2e-arr">→</span><span class="e2e-chip ord">₽ ${rub(p.order.amt)}, ${dateS(p.order.day)}</span>` : '<span class="e2e-arr">→</span><span class="e2e-chip mut">не купил</span>');
      const last = evs[evs.length - 1];
      const json = !last ? '' : last.kind === 'order'
        ? `{ "event": "purchase", "ts": "2026-09-${p2(last.day)} ${last.hm}",\n  "anon_id": "${last.anon}", "order_id": ${p.order.id}, "amount": ${p.order.amt},\n  "user_id": ${p.order.how === 'acc' ? `"${p.cid}"` : 'null'}${p.order.how === 'guest' ? ', "phone": "+7 9** ***-**-' + p2(fnv(p.name) % 100) + '"' : ''} }`
        : `{ "event": "page_view", "ts": "2026-09-${p2(last.day)} ${last.hm}",\n  "anon_id": "${last.anon}", "device": "${DEV[last.dev]}",\n  ${last.ch === 'seo' ? '"referrer": "yandex.ru"' : last.ch === 'dir' ? '"referrer": null' : CH[last.ch].utm.split('&').map(kv => { const [k, v] = kv.split('='); return `"${k}": "${v}"`; }).join(', ')}${last.ch === 'ads' ? ', "yclid": "73190…"' : ''} }`;
      const multi = p.devs.length > 1, mix = ts.length > 1 && ts[0].ch !== ts[ts.length - 1].ch;
      return `<b class="e2e-h">${esc(p.name)} <small>${p.devs.map(d => `${DEV[d]} <code>${p.anon[d]}</code>`).join(', ')}</small></b>
        <div class="e2e-path">${path}</div>
        <ol class="e2e-evl">${evs.length ? evs.map(e => `<li><span class="e2e-ft">${dateS(e.day)} ${e.hm}</span><span>${e.kind === 'order' ? `<b>purchase</b> · заказ ${p.order.id}, ${rub(p.order.amt)}` : `<b>page_view</b> · ${esc(utmOf(e.t))}`} · <code>${e.anon}</code> · ${DEV[e.dev]}</span></li>`).join('') : '<li class="mut">До этого дня событий не было.</li>'}</ol>
        ${json ? `<pre class="e2e-code">${esc(json)}</pre>` : ''}
        ${multi ? `<p class="e2e-note2">${cnt(p.devs.length, 'устройство', 'устройства', 'устройств')} — для аналитики это ${cnt(p.devs.length, 'разный посетитель', 'разных посетителя', 'разных посетителей')}, пока их не склеят. Об этом — вкладка «Склейка».</p>` : ''}
        ${p.order && mix ? `<p class="e2e-note2 acc">Пришёл из «${CH[ts[0].ch].n}», купил после «${CH[ts[ts.length - 1].ch].n}». Какому каналу засчитать ${rub(p.order.amt)}? Это вопрос атрибуции — следующая вкладка.</p>` : ''}`;
    }
    function pathKpis() {
      const D = U.path.day, vis = PEOPLE.filter(p => p.touches.some(t => t.day <= D)).length, tc = PEOPLE.reduce((a, p) => a + p.touches.filter(t => t.day <= D).length, 0);
      const ords = BUYERS.filter(p => p.order.day <= D), rev = ords.reduce((a, p) => a + p.order.amt, 0), tb = ords.reduce((a, p) => a + p.touches.filter(t => t.day <= p.order.day).length, 0);
      return tile('Посетителей', vis, 'людей с хотя бы одним касанием') + tile('Событий-касаний', tc, 'каждое — с меткой источника') + tile('Покупателей', ords.length, vis ? pc(ords.length / vis) + ' от посетителей' : '') + tile('Выручка', rub(rev), 'средний чек ' + rub(ords.length ? rev / ords.length : 0)) + tile('Касаний до покупки', ords.length ? dec(tb / ords.length, 1) : '—', 'в среднем у покупателя', ords.length ? 'inf' : '');
    }
    function playBar() {
      const D = U.path.day, end = D >= 30, start = D <= 0;
      return `<button type="button" class="btn primary" data-a="play">${U.path.play ? 'Пауза' : end ? 'Прогнать месяц заново' : start ? 'Пуск' : 'Дальше'}</button><button type="button" class="btn" data-a="pstep" ${end ? 'disabled' : ''}>+1 день</button><button type="button" class="btn" data-a="pend" ${end ? 'disabled' : ''}>До конца</button><button type="button" class="btn ghost" data-a="preset" ${start ? 'disabled' : ''}>Сначала</button><span class="e2e-day">${D <= 0 ? 'до 1 сентября' : D >= 30 ? 'весь сентябрь' : 'по ' + D + ' сентября'}</span>`;
    }
    DRAWS.path = () => {
      const st = $('#e2eStage'); if (!st) return;
      st.innerHTML = pathSVG(W0('#e2eStage', 300));
      $('#e2eKpis').innerHTML = pathKpis(); $('#e2eFeed').innerHTML = feedHTML(); $('#e2ePerson').innerHTML = personHTML(); $('#e2ePlay').innerHTML = playBar();
    };
    function pathAct(a) {
      const P = U.path;
      if (a === 'play') {
        if (P.play) { P.play = false; stopTimer(); DRAWS.path(); return; }
        if (P.day >= 30) P.day = 0;
        if (isCalm()) { P.day = 30; DRAWS.path(); return; }
        P.play = true;
        startTimer(() => { P.day = Math.min(30, P.day + 1); if (P.day >= 30) { P.play = false; stopTimer(); } if (U.tab === 'path') DRAWS.path(); }, 260);
        DRAWS.path(); return;
      }
      P.play = false; stopTimer();
      if (a === 'pstep') P.day = Math.min(30, P.day + 1);
      else if (a === 'pend') P.day = 30;
      else if (a === 'preset') P.day = 0;
      DRAWS.path();
    }
    function pickPerson(i) {
      U.path.sel = i;
      const p = PEOPLE[i];
      if (p && p.order) { const ts = p.touches.filter(t => t.day <= p.order.day); if (ts.length > 1 && ts[0].ch !== ts[ts.length - 1].ch) done('path'); }
      DRAWS.path();
    }

    /* ================= 2. Атрибуция ================= */
    const SPEND_M = { ads: OWN.spend.ads, soc: OWN.spend.soc, mail: OWN.mailUsd * A.usdRub };
    const romiOf = (rev, ch) => (rev * OWN.margin - SPEND_M[ch]) / SPEND_M[ch];
    const rcls = v => v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : '';
    VIEWS.attr = () => `${ana('Гол в футболе: забил нападающий, но атаку начал защитник, а пас отдал полузащитник. Кого премировать? Если только нападающих — команда однажды продаст защиту.',
        'Перед заказом у человека часто несколько касаний из разных каналов. <b>Модель атрибуции</b> — договорённость, как поделить выручку заказа между ними. Деньги не появляются и не пропадают: сумма по каналам всегда равна выручке в CRM.',
        '<b>Первый клик</b> — всё первому касанию; <b>последний клик</b> — последнему; <b>линейная</b> — поровну; <b>с затуханием (time decay)</b> — свежие касания весят больше: вес = 2 в степени (−дней до заказа ÷ период полураспада). Бывают ещё позиционная (40 / 20 / 40) и data-driven — по статистике путей.')}
      <div class="e2e-ctls">${ctl('Модель атрибуции', seg('model', MODELS, U.model, 'Модель атрибуции'))}${U.model === 'decay' ? ctl('Период полураспада', seg('hl', HLS, U.hl, 'Период полураспада')) : ''}</div>
      <div class="e2e-tblw" id="e2eAttrT"></div>
      <div class="e2e-two"><div class="e2e-box" id="e2eMatrix"></div><div class="e2e-box" id="e2eSplit"></div></div>
      <div id="e2eAttrNote"></div>
      <div id="e2eAttrQ"></div>
      ${asm([`14 заказов сентября, ${rub(TOTAL)} выручки, средний чек ${rub(A.check)} — как во всём тренажёре`, `расходы за сентябрь: Реклама ${rub(SPEND_M.ads)}, Соцсети ${rub(SPEND_M.soc)}, Рассылка $${OWN.mailUsd} = ${rub(SPEND_M.mail)} по курсу ${A.usdRub} ₽ за $`, `маржа ${pc(OWN.margin)}: закупка — 65 % выручки, как в «Потоке событий»`, 'ROMI = (выручка канала × маржа − расход) ÷ расход', 'Поиск и прямой заход бесплатны — ROMI у них не считаем', 'доли заказа округлены до рубля так, что их сумма ровно равна заказу'])}
      ${nextBtn('attr')}`;
    function attrTable() {
      const at = attrTrue(U.model, U.hl), max = Math.max(1, ...CHS.map(c => at.by[c]));
      const paidRev = PAID.reduce((a, c) => a + at.by[c], 0), paidSp = PAID.reduce((a, c) => a + SPEND_M[c], 0), sum = CHS.reduce((a, c) => a + at.by[c], 0);
      return `<table class="e2e-tbl"><thead><tr><th>Канал</th><th class="hn">Выручка по модели «${MNAME[U.model]}»</th><th class="num">₽</th><th class="num hn">Доля</th><th class="num hn">Расход</th><th class="num">ROMI</th></tr></thead><tbody>
        ${CHS.map(c => { const paid = PAID.includes(c), r = paid ? romiOf(at.by[c], c) : null; return `<tr class="e2e-c-${c}"><td><span class="e2e-chn">${cdot(c)}${CH[c].n}</span><small>${CH[c].s}</small></td><td class="hn"><div class="e2e-bar"><i style="width:${f1(at.by[c] / max * 100)}%"></i></div></td><td class="num">${rub(at.by[c])}</td><td class="num hn">${pc(at.by[c] / TOTAL)}</td><td class="num hn">${paid ? rub(SPEND_M[c]) : '<small>бесплатно</small>'}</td><td class="num ${paid ? rcls(r) : ''}">${paid ? romiS(r) : '—'}</td></tr>`; }).join('')}
        </tbody><tfoot><tr><td>Итого${sum === TOTAL ? '<small class="pos">✓ = выручке в CRM</small>' : '<small class="neg">не сходится с CRM</small>'}</td><td class="hn">${sum === TOTAL ? '<span class="pos">✓ сумма по каналам = выручке в CRM</span>' : '<span class="neg">не сходится</span>'}</td><td class="num">${rub(sum)}</td><td class="num hn">100 %</td><td class="num hn">${rub(paidSp)}</td><td class="num ${rcls((paidRev * OWN.margin - paidSp) / paidSp)}">${romiS((paidRev * OWN.margin - paidSp) / paidSp)}</td></tr></tfoot></table>`;
    }
    function attrMatrix() {
      const R = MODELS.map(([m]) => ({ m, at: attrTrue(m, U.hl) }));
      return `<b class="e2e-h">ROMI по моделям <small>те же 14 заказов</small></b><div class="e2e-tblw"><table class="e2e-tbl"><thead><tr><th>Канал</th>${MODELS.map(([m, n]) => `<th class="num${m === U.model ? ' cur' : ''}">${n}</th>`).join('')}</tr></thead><tbody>
        ${PAID.map(c => `<tr><td><span class="e2e-chn">${cdot(c)}${CH[c].n}</span></td>${R.map(x => { const v = romiOf(x.at.by[c], c); return `<td class="num ${rcls(v)}${x.m === U.model ? ' cur' : ''}">${romiS(v)}</td>`; }).join('')}</tr>`).join('')}
        <tr><td><small>Урезать бюджет</small></td>${R.map(x => { const bad = PAID.filter(c => romiOf(x.at.by[c], c) < -0.005); return `<td class="num${x.m === U.model ? ' cur' : ''}"><small>${bad.length ? bad.map(c => CH[c].n).join(', ') : 'никому'}</small></td>`; }).join('')}</tr>
        </tbody></table></div>`;
    }
    function attrSplit() {
      const bi = BUYERS.findIndex(p => p.i === U.abuyer), p = BUYERS[bi] || BUYERS[0], at = attrTrue(U.model, U.hl), parts = at.parts[BUYERS.indexOf(p)];
      return `<b class="e2e-h">Как делится один заказ <small>выбери покупателя</small></b>
        <div class="e2e-split">${BUYERS.map(b => `<button type="button" class="e2e-buy" data-a="abuy:${b.i}" aria-pressed="${b === p}">${esc(b.name)} · ${b.touches.filter(t => t.day <= b.order.day).length}</button>`).join('')}</div>
        <div class="e2e-parts" role="img" aria-label="Доли заказа ${esc(p.name)} по каналам">${parts.filter(x => x.rub > 0).map(x => `<span class="e2e-c-${x.ch}" style="flex-grow:${x.rub}" title="${CH[x.ch].n}: ${rub(x.rub)}">${x.rub >= p.order.amt * 0.2 ? rub(x.rub) : ''}</span>`).join('')}</div>
        <ol class="e2e-evl">${parts.map(x => `<li><span class="e2e-ft">${dateS(x.day)}</span>${cdot(x.ch)}<span>${CH[x.ch].n} · ${DEV[x.dev]}</span><b>${pc(x.w, x.w < 0.1 && x.w > 0 ? 1 : 0)} → ${rub(x.rub)}</b></li>`).join('')}<li><span class="e2e-ft">${dateS(p.order.day)}</span><i class="e2e-cd ord" aria-hidden="true"></i><span>заказ ${esc(p.name)}</span><b>${rub(p.order.amt)}</b></li></ol>`;
    }
    function attrNote() {
      const F = attrTrue('first', U.hl).by, Lb = attrTrue('last', U.hl).by, firstSoc = TRUE_ORDERS.filter(o => o.touches[0] && o.touches[0].ch === 'soc').length;
      return card('info', `<b>Вывод.</b> По «последнему клику» соцсети дают ${rub(Lb.soc)} и ROMI ${romiS(romiOf(Lb.soc, 'soc'))} — их хочется выключить. Но ${firstSoc} из ${BUYERS.length} покупателей впервые пришли именно из соцсетей, и по «первому клику» у них ${rub(F.soc)} и ${romiS(romiOf(F.soc, 'soc'))}. Реклама в поиске, наоборот, хороша по последнему клику (${romiS(romiOf(Lb.ads, 'ads'))}) и убыточна по первому (${romiS(romiOf(F.ads, 'ads'))}). <b>Модель меняет решение о бюджете</b>: договоритесь о ней заранее и проверяйте решения на двух-трёх моделях сразу.`);
    }
    function attrQuiz() {
      const F = attrTrue('first', U.hl).by, Lb = attrTrue('last', U.hl).by, best = CHS.slice().sort((a, b) => (F[b] - Lb[b]) - (F[a] - Lb[a]))[0], q = U.aq;
      let fb = null;
      if (q) fb = q === best ? { ok: true, h: `Да. ${CH[q].n} знакомят людей с магазином, но редко закрывают продажу: по последнему клику — ${rub(Lb[q])}, по первому — ${rub(F[q])}. Разница ${rub(F[q] - Lb[q])} — это заказы, которые без них не начались бы.` }
        : { ok: false, h: `По последнему клику у канала «${CH[q].n}» — ${rub(Lb[q])}, по первому — ${rub(F[q])}. ${F[q] > Lb[q] ? 'Его тоже недооценивают, но меньше, чем другой канал.' : 'Последний клик его не недооценивает, а переоценивает: он чаще закрывает продажу, чем начинает путь.'} Сравни колонки «Первый клик» и «Последний клик» в таблице.` };
      return quiz('aq', 'Какой канал «последний клик» недооценивает сильнее всего?', CHS.map(c => [c, CH[c].n]), q, fb);
    }
    DRAWS.attr = () => {
      const t = $('#e2eAttrT'); if (!t) return;
      t.innerHTML = attrTable(); $('#e2eMatrix').innerHTML = attrMatrix(); $('#e2eSplit').innerHTML = attrSplit(); $('#e2eAttrNote').innerHTML = attrNote(); $('#e2eAttrQ').innerHTML = attrQuiz();
    };
    ACTS.model = v => { U.model = v; render(); };
    ACTS.hl = v => { U.hl = +v; render(); };
    ACTS.abuy = v => { U.abuyer = +v; DRAWS.attr(); };
    ACTS.aq = v => {
      U.aq = v;
      const F = attrTrue('first', U.hl).by, Lb = attrTrue('last', U.hl).by, best = CHS.slice().sort((a, b) => (F[b] - Lb[b]) - (F[a] - Lb[a]))[0];
      if (v === best) done('attr');
      DRAWS.attr();
    };

    /* ================= 3. Потери событий ================= */
    VIEWS.loss = () => {
      const L = U.loss;
      return `${ana('Часть покупателей заходит, а кассир их не видит: вход заслонила толпа — это блокировщик. А кто-то просит: «Не записывайте меня», — и кассир обязан не записывать. В обоих случаях чек будет, а откуда пришёл покупатель — неизвестно.',
          'Блокировщик рекламы не даёт загрузиться скрипту трекера — визиты и метки не доходят. Отказ от cookie — человек сам попросил не следить, и мы обязаны не связывать его визиты с заказом. Заказы в CRM есть, а источника у них нет.',
          '<b>Сбор в браузере</b> — скрипт отправляет события прямо в сервис аналитики; его режут блокировщики, а Safari стирает cookie, поставленные скриптом, через 7 дней. <b>Серверный сбор (server-side)</b> — события идут на свой домен, метки из адреса первой страницы сервер сам кладёт в заказ, cookie ставит сервер. <b>Баннер согласия (CMP)</b> спрашивает разрешение до запуска аналитики.')}
        <div class="e2e-ctls">${ctl('Как собираем события', seg('lmode', [['browser', 'Сбор в браузере'], ['server', 'Серверный сбор']], L.mode, 'Как собираем события'))}
          ${ctl('Блокировщик рекламы у посетителей', `<label class="e2e-range"><input type="range" data-r="pB" min="0" max="50" step="5" value="${Math.round(L.pB * 100)}" aria-label="Доля посетителей с блокировщиком"><output id="e2eOB">${pc(L.pB)}</output></label>`)}
          ${ctl('Отказались от cookie', `<label class="e2e-range"><input type="range" data-r="pR" min="0" max="50" step="5" value="${Math.round(L.pR * 100)}" aria-label="Доля отказавшихся от cookie"><output id="e2eOR">${pc(L.pR)}</output></label>`)}</div>
        <div class="e2e-lossw"><div class="e2e-box"><b class="e2e-h">100 заказов недели <small>цвет — источник, который увидела аналитика</small></b><div class="e2e-grid" id="e2eGrid"></div>
          ${legend([['e2e-c-ads', 'Реклама'], ['e2e-c-soc', 'Соцсети'], ['e2e-c-mail', 'Рассылка'], ['e2e-c-seo', 'Поиск'], ['e2e-c-dir', 'Прямой'], ['lost', 'без источника: блокировщик'], ['refuse', 'без источника: отказ'], ['back', 'вернул сервер']])}</div>
          <div class="e2e-view"><div class="e2e-kpis" id="e2eLossK"></div><div id="e2eCell"></div><div class="e2e-tblw" id="e2eLossT"></div></div></div>
        ${card('info', `<b>Что делает серверный сбор.</b> 1) События идут на свой домен (например, track.shop.ru), и блокировщики по спискам их чаще пропускают. 2) Метки UTM и click id из адреса первой страницы сервер сам кладёт в заказ — даже если скрипт в браузере не загрузился. 3) Cookie ставит сервер, и Safari не стирает её через 7 дней. <b>Чего он не делает:</b> не отменяет отказ человека. И часть блокировщиков узнаёт и свой домен — здесь не вернулся каждый пятый заблокированный заказ.`)}
        ${card('law', '<b>Согласие и закон — коротко и честно.</b> По 152-ФЗ персональные данные обрабатывают с согласия человека, а id посетителя и cookie вместе с другими данными о нём могут считаться персональными. С 1 сентября 2025 года согласие оформляют отдельным документом, а не строкой в оферте. Данные граждан России при сборе записывают и хранят в базах на территории России. Отсюда три правила: баннер с выбором — до запуска аналитики; отказ уважаем и в браузере, и на сервере; хранилище — в России. Точные формулировки согласуйте с юристом.')}
        <div id="e2eLossQ"></div>
        ${asm([`средний чек ${rub(A.check)} — как во всём тренажёре; выручка без источника = заказы × чек`, '100 заказов недели: Реклама 32, Рассылка 24, Поиск 16, Соцсети 14, Прямой заход 14', 'блокировщик и отказ — у случайных посетителей, независимо от канала; у каждого заказа 3–9 событий', `серверный сбор не возвращает каждый пятый заблокированный заказ: блокировщик узнал и свой домен`])}
        ${nextBtn('loss')}`;
    };
    const LOSS_TXT = {
      ok: () => 'Трекер загрузился, человек согласился на cookie — источник на месте.',
      block: m => m === 'server' ? 'Блокировщик узнал и свой домен — даже сервер не получил событий. Источник неизвестен.' : 'Блокировщик не дал загрузиться скрипту трекера: визитов и меток нет — источник неизвестен.',
      back: () => 'В браузере блокировщик отрезал трекер, но сервер увидел адрес первой страницы с метками и сохранил их в заказе — источник вернулся.',
      refuse: () => 'Человек отказался от cookie. Его визиты не связываем с заказом ни в браузере, ни на сервере — так и должно быть.'
    };
    function lossGrid(R) { return LOSS.map((o, i) => { const s = R.st[i], cls = s === 'block' ? 'lost' : s === 'refuse' ? 'refuse' : s === 'back' ? 'back' : ''; return `<button type="button" tabindex="-1" class="e2e-cell e2e-c-${o.ch} ${cls}${U.loss.cell === i ? ' on' : ''}" data-a="cell:${i}" aria-label="Заказ ${o.n}: ${s === 'ok' || s === 'back' ? CH[o.ch].n : 'без источника'}">${s === 'block' ? '?' : s === 'refuse' ? '×' : ''}</button>`; }).join(''); }
    function lossKpis(R) {
      const L = U.loss;
      return tile('Без источника', `${R.lost} из 100`, `≈ ${rubK(R.lost * A.check)} выручки не знает, откуда пришла`, R.lost > 15 ? 'bad' : R.lost > 5 ? 'warn' : 'ok')
        + tile('Событий дошло', pc(R.evOk / R.ev), `${nf(R.evOk)} из ${nf(R.ev)}`, R.evOk / R.ev < 0.85 ? 'warn' : '')
        + tile('Вернул сервер', L.mode === 'server' ? String(R.back) : '—', L.mode === 'server' ? 'заказов, которые браузер потерял' : 'включи серверный сбор', L.mode === 'server' && R.back ? 'ok' : '')
        + tile('Отказались', String(R.refuse), 'без источника при любом сборе — честно', R.refuse ? 'inf' : '');
    }
    function lossTable() {
      const L = U.loss, B = lossRun('browser', L.pB, L.pR), S = lossRun('server', L.pB, L.pR), cb = L.mode === 'browser' ? ' cur' : '', cs = L.mode === 'server' ? ' cur' : '';
      return `<table class="e2e-tbl"><thead><tr><th>Канал</th><th class="num">На самом деле</th><th class="num${cb}">Видно в браузере</th><th class="num${cs}">Видно с сервера</th></tr></thead><tbody>
        ${CHS.map(c => { const r = B.byCh[c].real; return `<tr><td><span class="e2e-chn">${cdot(c)}${CH[c].n}</span></td><td class="num">${r}</td><td class="num${cb}">${B.byCh[c].seen} <small>${r ? '−' + pc(1 - B.byCh[c].seen / r) : ''}</small></td><td class="num${cs}">${S.byCh[c].seen} <small>${r ? '−' + pc(1 - S.byCh[c].seen / r) : ''}</small></td></tr>`; }).join('')}
        </tbody><tfoot><tr><td>Без источника</td><td class="num">0</td><td class="num${cb}">${B.lost}</td><td class="num${cs}">${S.lost}</td></tr></tfoot></table>`;
    }
    function lossCell() {
      const i = U.loss.cell; if (i == null) return card('mut', 'Нажми на клетку — покажу, что случилось с этим заказом в браузере и на сервере.');
      const o = LOSS[i], b = lossOf(o, 'browser', U.loss.pB, U.loss.pR), s = lossOf(o, 'server', U.loss.pB, U.loss.pR);
      return card('', `<b>Заказ №${o.n}</b> · на самом деле — ${chip(o.ch)} · ${DEV[o.dev]} · ${o.ev} событий<p><b>В браузере:</b> ${LOSS_TXT[b]('browser')}</p><p><b>На сервере:</b> ${LOSS_TXT[s]('server')}</p>`);
    }
    function lossQuiz() {
      const q = U.loss.q, FB = {
        yes: { ok: false, h: 'Нет. Блокировщик — это техника, а отказ — воля человека и требование закона. Серверный сбор возвращает то, что потеряла техника, но не даёт права следить за тем, кто отказался.' },
        no: { ok: true, h: 'Верно. Отказ действует при любом способе сбора. Такие заказы честно остаются «без источника» или учитываются в общих цифрах без привязки к человеку.' },
        abroad: { ok: false, h: 'Наоборот: по 152-ФЗ данные граждан России при сборе записывают и хранят в базах на территории России. И отказ от этого не перестаёт действовать.' }
      };
      return quiz('lq', 'Покупатель нажал «Отказаться» в баннере cookie. Можно ли серверным сбором всё-таки связать его визиты с заказом?', [['yes', 'Да: сервер блокировщики не видят'], ['no', 'Нет: отказ действует при любом сборе'], ['abroad', 'Да, если хранить данные за рубежом']], q, q ? FB[q] : null);
    }
    DRAWS.loss = () => {
      const g = $('#e2eGrid'); if (!g) return;
      const L = U.loss, R = lossRun(L.mode, L.pB, L.pR);
      g.innerHTML = lossGrid(R); $('#e2eLossK').innerHTML = lossKpis(R); $('#e2eLossT').innerHTML = lossTable(); $('#e2eCell').innerHTML = lossCell(); $('#e2eLossQ').innerHTML = lossQuiz();
      const ob = $('#e2eOB'), or = $('#e2eOR'); if (ob) ob.textContent = pc(L.pB); if (or) or.textContent = pc(L.pR);
    };
    ACTS.lmode = v => { U.loss.mode = v === 'server' ? 'server' : 'browser'; if (U.loss.mode === 'server') done('server'); render(); };
    ACTS.cell = v => { U.loss.cell = U.loss.cell === +v ? null : +v; DRAWS.loss(); };
    ACTS.lq = v => { U.loss.q = v; if (v === 'no') done('consent'); DRAWS.loss(); };
    INPUTS.pB = v => { U.loss.pB = +v / 100; DRAWS.loss(); };
    INPUTS.pR = v => { U.loss.pR = +v / 100; DRAWS.loss(); };

    /* ================= 4. Склейка ================= */
    VIEWS.stitch = () => `${ana('Без карты постоянного покупателя кассир видит три разных лица: утром человек зашёл с телефона, вечером — с ноутбука, днём — с работы. С картой — один человек и три визита. А если кассир начнёт «узнавать» людей по похожей куртке, то склеит маму с дочкой.',
        'На каждом устройстве у человека свой анонимный id. Чтобы понять, что это один человек, нужен общий признак: вход в аккаунт, ссылка из письма, телефон в заказе. Пока id не склеены, посетителей больше, чем людей, конверсия ниже настоящей, а заказ не видит касаний с других устройств.',
        '<b>Identity resolution</b>: граф идентификаторов (anon_id, user_id, email, телефон); связанные части графа — профили покупателей. <b>Детерминированная</b> склейка — по точным признакам; <b>вероятностная</b> — по похожести (IP, модель устройства): склеивает больше, но ошибается.')}
      <b class="e2e-h">Правила склейки <small>включай по одному и смотри на цифры</small></b>
      <div class="e2e-rules">${RULES.map(([k, n, d]) => `<button type="button" class="e2e-rule e2e-r-${RULE_C[k]}" data-a="rule:${k}" aria-pressed="${!!U.st.on[k]}"><span class="bx" aria-hidden="true">✓</span><b>${n}</b><small>${d}</small></button>`).join('')}</div>
      <div class="e2e-stage" id="e2eId"></div>
      <div class="e2e-kpis" id="e2eStK"></div>
      <div id="e2eStNote"></div>
      <div class="e2e-tblw" id="e2eStT"></div>
      ${nextBtn('stitch')}`;
    const FEAT = [['Аня', 'd'], ['Аня', 'w'], ['Аня', 'm'], ['Галина', 'm'], ['Олег', 'w'], ['Ира', 'w']];
    function idSVG(W) {
      const S = stitch(U.st.on), on = U.st.on, wide = W >= 820, nodes = {};
      const ruleName = { login: 'вход в аккаунт', mail: 'ссылка из письма', phone: 'телефон в заказе' };
      const nh = wide ? 42 : 58, dw = wide ? 200 : Math.min(220, Math.floor(W * 0.52)), pw = wide ? 168 : Math.min(170, W - dw - 44), px = wide ? 440 : W - pw - 8;
      const ys = wide ? [40, 96, 152, 222] : [40, 110, 180, 270], ox = wide ? W - dw - 12 : 8, oy = wide ? [40, 150] : [374, 464], H = wide ? 280 : 536;
      FEAT.forEach(([n, d], i) => { nodes[n + d] = i < 4 ? { x: 8, y: ys[i], w: dw, h: nh } : { x: ox, y: oy[i - 4], w: dw, h: nh }; });
      const pY = n => { const c = FEAT.filter(f => f[0] === n).map(f => nodes[f[0] + f[1]].y + nh / 2); return c.reduce((a, b) => a + b, 0) / c.length - 21; };
      const prof = { 'Аня': { x: px, y: pY('Аня'), w: pw, h: 42 }, 'Галина': { x: px, y: pY('Галина'), w: pw, h: 42 } };
      const comp = {}; let ci = 0; FEAT.forEach(([n, d]) => { const k = S.ofDev[devOf(n, d).k]; if (comp[k] == null) comp[k] = ++ci; });
      const GEN = { 'Аня': 'Ани', 'Галина': 'Галины', 'Олег': 'Олега', 'Ира': 'Иры' };
      let h = `<svg class="e2e-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Граф идентификаторов: устройства и профили покупателей">`;
      h += tx(8, 22, 'СЕМЬЯ: АНЯ И ЕЁ МАМА ГАЛИНА', 'e2e-grp') + tx(ox, wide ? 22 : 356, 'ОФИС: ОЛЕГ И ИРА', 'e2e-grp');
      const lbl = (x, y, t, c, start) => { const w = t.length * 6.6 + 14, x0 = start ? x : x - w / 2; return rc(x0, y - 11, w, 20, 'e2e-idl', 10) + tx(x0 + w / 2, y + 4, t, 'e2e-idlt ' + c, 'middle'); };
      /* рёбра «устройство → профиль»: у каждого устройства свой точный признак */
      [['Аня', 'd'], ['Аня', 'w'], ['Аня', 'm'], ['Галина', 'm']].forEach(([n, d]) => {
        const D = devOf(n, d), r = D.ev[0], a = nodes[n + d], b = prof[n], x1 = a.x + a.w, y1 = a.y + nh / 2, x2 = b.x, y2 = b.y + 21, act = !!on[r], k = Math.max(12, (x2 - x1) * 0.45);
        h += `<path class="e2e-ide ${act ? RULE_C[r] : 'off'}" d="M${f1(x1)} ${f1(y1)}C${f1(x1 + k)} ${f1(y1)} ${f1(x2 - k)} ${f1(y2)} ${f1(x2)} ${f1(y2)}"/>`;
        if (wide) h += lbl((x1 + x2) / 2, (y1 + y2) / 2, ruleName[r], act ? RULE_C[r] : '');
      });
      /* вероятностные рёбра: похожие устройства разных людей */
      [['Аня', 'm', 'Галина', 'm'], ['Олег', 'w', 'Ира', 'w']].forEach(([a, da, b, db]) => {
        const A1 = nodes[a + da], B1 = nodes[b + db], x = A1.x + 26, y1 = A1.y + A1.h, y2 = B1.y;
        h += `<path class="e2e-ide ${on.fuzzy ? 'bad' : 'off'}" d="M${f1(x)} ${f1(y1)}V${f1(y2)}"/>` + lbl(x + 10, (y1 + y2) / 2, 'тот же IP и модель', on.fuzzy ? 'bad' : '', true);
      });
      Object.entries(prof).forEach(([n, b]) => {
        const p = PEOPLE.find(x => x.name === n), used = DEVS.some(D => D.p === p && D.ev.some(e => on[e]));
        h += `<g style="opacity:${used ? 1 : 0.5}">` + rc(b.x, b.y, b.w, b.h, 'e2e-idp', 21) + tx(b.x + 14, b.y + 18, b.w >= 150 ? `${p.cid} · ${n}` : p.cid, 'e2e-idt') + tx(b.x + 14, b.y + 34, b.w >= 150 ? 'профиль покупателя' : n, 'e2e-ids') + '</g>';
      });
      /* устройства: номер посетителя, которым их видит аналитика */
      FEAT.forEach(([n, d]) => {
        const a = nodes[n + d], D = devOf(n, d), k = comp[S.ofDev[D.k]], r = D.ev[0];
        h += rc(a.x, a.y, a.w, a.h, 'e2e-idn', 9) + tx(a.x + 10, a.y + 17, D.anon, 'e2e-idt') + tx(a.x + 10, a.y + 34, `${DEV[d]} ${GEN[n]}`, 'e2e-ids');
        if (!wide) h += tx(a.x + 10, a.y + 51, r ? '↳ ' + ruleName[r] : '↳ точных признаков нет', 'e2e-idlt ' + (r && on[r] ? RULE_C[r] : ''));
        h += rc(a.x + a.w - 40, a.y + 11, 30, 20, 'e2e-vb', 10) + tx(a.x + a.w - 25, a.y + 25, '#' + k, 'e2e-vbt', 'middle');
      });
      return h + '</svg>';
    }
    function stKpis(S) {
      return tile('Посетителей', String(S.vis), 'людей на самом деле — 40', S.vis === 40 ? (S.exact ? 'ok' : 'warn') : 'bad')
        + tile('Покупателей', String(S.buyers), 'на самом деле — 14', S.buyers === 14 ? '' : 'bad')
        + tile('Конверсия', pc(S.conv, 1), 'на самом деле — 35 %', Math.abs(S.conv - 0.35) < 0.001 ? (S.exact ? 'ok' : 'warn') : 'bad')
        + tile('Ложных склеек', String(S.falseN), 'разных людей в одном профиле', S.falseN ? 'bad' : 'ok')
        + tile('Не склеено', String(S.missN), cnt(S.missN, 'устройство', 'устройства', 'устройств') + ' отдельно от хозяина', S.missN ? 'warn' : 'ok');
    }
    function stNote(S) {
      const on = U.st.on;
      if (S.exact) return card('ok', '<b>Цифры сошлись.</b> 40 посетителей — это 40 людей, конверсия 35 %, и каждый заказ видит касания со всех устройств своего покупателя. Посмотри таблицу ниже: заказ Ани больше не «прямой заход», а соцсети получили свои заказы, начатые на телефоне.');
      if (S.vis === 40) return card('warn', `<b>Итог совпал, но склейка неверная:</b> ложных склеек — ${S.falseN}, не склеено — ${S.missN}. Телефон Ани приклеился к маме, а Олег — к Ире. Совпадение итогов не доказывает, что склеено правильно: проверяй на людях, про которых знаешь правду.`);
      if (on.fuzzy) return card('bad', `<b>Вероятностная склейка ошиблась:</b> Аня и её мама Галина сидят в одном домашнем Wi-Fi с одинаковыми телефонами, Олег и Ира — в одном офисе с одинаковыми ноутбуками. Правило «тот же IP и модель» склеило разных людей — посетителей стало меньше, чем людей. Такие склейки держат отдельно и помечают как оценку.`);
      if (!on.login && !on.mail && !on.phone) return card('', `<b>Без склейки</b> аналитика видит ${S.vis} посетителей вместо 40: у Ани три устройства — это три «человека», и её заказ на рабочем ПК не знает про рекламу и соцсети на других устройствах. Включи первое правило.`);
      return card('', `Склеено не всё: ${cnt(S.missN, 'устройство', 'устройства', 'устройств')} ещё отдельно от хозяина. Посмотри на Аню: какое правило связывает её рабочий ПК, а какое — телефон?`);
    }
    function stTable(S) {
      const none = stitch({}), A0 = attribute('first', U.hl, none.orders).by, A1 = attribute('first', U.hl, S.orders).by, AT = attrTrue('first', U.hl).by;
      const B0 = attribute('last', U.hl, none.orders).by, B1 = attribute('last', U.hl, S.orders).by, BT = attrTrue('last', U.hl).by;
      const cell = (v, t) => `<td class="num${v !== t ? ' warnv' : ''}">${rub(v)}</td>`;
      return `<table class="e2e-tbl"><thead><tr><th>Канал</th><th class="num">Первый клик: без склейки</th><th class="num cur">сейчас</th><th class="num">правда</th><th class="num hn">Последний клик: без склейки</th><th class="num hn">сейчас</th></tr></thead><tbody>
        ${CHS.map(c => `<tr><td><span class="e2e-chn">${cdot(c)}${CH[c].n}</span></td>${cell(A0[c], AT[c])}<td class="num cur${A1[c] !== AT[c] ? ' warnv' : ''}">${rub(A1[c])}</td><td class="num">${rub(AT[c])}</td><td class="num hn${B0[c] !== BT[c] ? ' warnv' : ''}">${rub(B0[c])}</td><td class="num hn${B1[c] !== BT[c] ? ' warnv' : ''}">${rub(B1[c])}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="6"><small>Выручка 14 заказов (${rub(TOTAL)}) по каналам. Оранжевым — где цифра расходится с правдой: без склейки заказ видит только касания со своего устройства, а заказ без касаний становится «прямым заходом».</small></td></tr></tfoot></table>`;
    }
    DRAWS.stitch = () => {
      const st = $('#e2eId'); if (!st) return;
      const S = stitch(U.st.on);
      st.innerHTML = idSVG(W0('#e2eId', 300)); $('#e2eStK').innerHTML = stKpis(S); $('#e2eStNote').innerHTML = stNote(S); $('#e2eStT').innerHTML = stTable(S);
    };
    ACTS.rule = v => { U.st.on[v] = !U.st.on[v]; if (stitch(U.st.on).exact) done('stitch'); render(); };

    /* ================= 5. Расходы и окупаемость ================= */
    const CABS = { ads: 'Яндекс Директ', soc: 'VK Реклама', mail: 'Сервис рассылок' };
    VIEWS.roi = () => `${ana('Счета за листовки приходят не в день раздачи, а позже, а зарубежная типография выставляет счёт в долларах. Если вечером 30-го сложить чеки за месяц, а сегодняшний счёт ещё не пришёл, листовки покажутся дешевле, чем есть. А если сложить доллары с рублями как одно и то же — газета окажется почти бесплатной.',
        'Расходы живут в рекламных кабинетах, не у нас. Их забирают по расписанию, и между тратой и её появлением в отчёте всегда есть задержка. Плюс валюты и НДС. Только когда выручка и расходы сведены правильно, видно, какой канал окупается.',
        '<b>ETL расходов</b>: коннектор к API кабинетов по расписанию → перевод в рубли по курсу на дату траты → раскладка по меткам UTM → таблица расходов в хранилище. <b>ROMI</b> = (выручка × маржа − расход) ÷ расход. <b>CAC</b> = расход ÷ новых покупателей. <b>LTV</b> = чек × маржа × покупок за жизнь; здоровое отношение LTV/CAC — от 3.')}
      ${card('', '<b>Сейчас 30 сентября, 23:30</b> — закрываем месяц и решаем, куда нести бюджет октября. Заказы приходят из CRM сразу, расходы — из кабинетов по расписанию.')}
      <div class="e2e-ctls">${ctl('Загрузка расходов', seg('sched', [['daily', 'Раз в сутки, в 06:00'], ['hourly', 'Каждый час']], U.roi.sched, 'Расписание загрузки'))}${ctl('Расходы рассылки', seg('cur', [['raw', 'Как в кабинете'], ['rub', 'В рубли по курсу']], U.roi.cur, 'Валюта'))}${ctl('Модель атрибуции', seg('model', MODELS, U.model, 'Модель атрибуции'))}</div>
      <div class="e2e-imp" id="e2eImp"></div>
      <div class="e2e-kpis" id="e2eRoiK"></div>
      <div class="e2e-tblw" id="e2eRoiT"></div>
      <div id="e2eRoiNote"></div>
      <div id="e2eRoiQ"></div>
      ${asm([`средний чек ${rub(A.check)}, $1 = ${A.usdRub} ₽ — как во всём тренажёре (js/xray-biz.js)`, `маржа ${pc(OWN.margin)} — как в «Потоке событий»; покупок за жизнь покупателя — ${OWN.buys} (своё допущение), LTV = ${rub(A.check)} × ${pc(OWN.margin)} × ${OWN.buys} = ${rub(LTV)}`, `в сентябре Директ тратит ${rub(OWN.spend.ads / 30)} в день, VK — ${rub(OWN.spend.soc / 30)}; рассылка — $${OWN.mailUsd} абонентской платы 1-го числа`, 'новые покупатели — 12 из 14: Лев и Мира покупали раньше; CAC делим по той же модели атрибуции', 'выручка — по выбранной модели атрибуции, как во вкладке «Атрибуция»'])}
      ${nextBtn('roi')}`;
    function roiImp() {
      const R = U.roi;
      return PAID.map(ch => {
        const sp = spendOf(ch, R.sched, R.cur), part = ch === 'mail' ? 1 : sp.dwh / sp.now;
        const st = ch === 'mail' ? (sp.raw ? ['bad', `⚠ в хранилище записано ${nf(sp.dwh)} ₽: доллары сложены с рублями`] : ['ok', `✓ ${rub(sp.dwh)} по курсу ${A.usdRub} ₽ за $`])
          : R.sched === 'daily' ? ['warn', `загружено по 29.09 — расход за 30-е (${rub(sp.todayNow)}) приедет завтра в 06:00`] : ['ok', `загружено по 30.09, 23:00 — не хватает последнего получаса`];
        return `<div class="e2e-cab ${st[0] === 'ok' ? '' : st[0]} e2e-c-${ch}"><b>${CABS[ch]} <small class="e2e-mut">→ ${CH[ch].n}</small></b><span>В кабинете: <b>${ch === 'mail' ? '$' + OWN.mailUsd + ' за месяц' : sp.cab + ' за сентябрь'}</b></span><div class="e2e-load" role="img" aria-label="Загружено ${pc(part)}"><i style="width:${f1(Math.min(1, part) * 100)}%"></i></div><span class="e2e-st ${st[0]}">${st[1]}</span></div>`;
      }).join('');
    }
    function roiKpis(rows) {
      const R = U.roi, sp = rows.reduce((a, r) => a + r.sp.dwh, 0), rev = rows.reduce((a, r) => a + r.rev, 0), spT = rows.reduce((a, r) => a + r.sp.now, 0);
      const romi = (rev * OWN.margin - sp) / sp, romiT = (rev * OWN.margin - spT) / spT, today = PAID.reduce((a, c) => a + spendOf(c, R.sched, R.cur).today, 0), todayT = PAID.reduce((a, c) => a + spendOf(c, R.sched, R.cur).todayNow, 0);
      const ok = Math.abs(romi - romiT) < 0.005;
      return tile('ROMI рекламы за сентябрь', romiS(romi), ok ? 'данные сведены верно' : `по верным данным — ${romiS(romiT)}`, ok ? (romi >= 0 ? 'ok' : 'bad') : 'warn')
        + tile('Расход за 30-е в отчёте', rub(today), `на самом деле — ${rub(todayT)}`, today < todayT * 0.5 ? 'warn' : '')
        + tile('LTV покупателя', rub(LTV), `${rub(A.check)} × ${pc(OWN.margin)} × ${OWN.buys} покупки`, 'inf')
        + tile('Новых покупателей', '12 из 14', 'на них делим расход в CAC');
    }
    function roiTable(rows) {
      return `<table class="e2e-tbl"><thead><tr><th>Канал</th><th class="num hn">В кабинете</th><th class="num">В хранилище</th><th class="num">Выручка · ${MNAME[U.model]}</th><th class="num">ROMI</th><th class="num hn">Новых</th><th class="num hn">CAC</th><th class="num">LTV / CAC</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><span class="e2e-chn">${cdot(r.ch)}${CH[r.ch].n}</span></td><td class="num hn">${r.ch === 'mail' ? '$' + OWN.mailUsd : rub(r.sp.now)}</td><td class="num${r.sp.raw ? ' neg' : r.sp.dwh < r.sp.now - 1 ? ' warnv' : ''}">${rub(r.sp.dwh)}</td><td class="num">${rub(r.rev)}</td><td class="num ${rcls(r.romi)}">${romiS(r.romi)}${Math.abs(r.romi - r.romiTrue) > 0.005 ? `<small>верно: ${romiS(r.romiTrue)}</small>` : ''}</td><td class="num hn">${dec(r.nw, 1)}</td><td class="num hn">${isFinite(r.cac) ? rub(r.cac) : '∞'}</td><td class="num ${r.lc >= 3 ? 'pos' : r.lc >= 1 ? 'warnv' : 'neg'}">${dec(r.lc, 1)}</td></tr>`).join('')}
        </tbody></table>`;
    }
    function roiNote(rows) {
      const R = U.roi, m = rows.find(r => r.ch === 'mail');
      if (R.cur === 'raw') return card('bad', `<b>Рассылка выглядит сверхприбыльной: ROMI ${romiS(m.romi)}.</b> Это не успех, а ошибка импорта: сервис рассылок выставляет счёт в долларах, и $${OWN.mailUsd} легли в хранилище как ${OWN.mailUsd} ₽. Переведи расходы в рубли — по курсу на дату траты.`);
      if (R.sched === 'daily') return card('warn', '<b>Расходы за 30-е ещё не загружены</b> — суточная загрузка заберёт их завтра в 06:00. Сегодня вечером ROMI месяца немного завышен, а ROMI «за сегодня» вообще бесконечный: заказы есть, расходов нет. Либо загружай чаще, либо ставь на отчёт плашку «расходы за сегодня неполные».');
      const bad = rows.filter(r => r.romi < -0.005).map(r => CH[r.ch].n);
      return card('ok', `<b>Данные сведены.</b> По модели «${MNAME[U.model]}» ${bad.length ? `не окупается: ${bad.join(', ')}` : 'окупаются все платные каналы'}. Посмотри на LTV/CAC: канал может не окупиться первой покупкой, но вернуть деньги повторными — если покупатель вернётся ${OWN.buys} раза.`);
    }
    function roiQuiz(rows) {
      const q = U.roi.q; let fb = null;
      if (q) {
        const r = rows.find(x => x.ch === q);
        if (U.roi.cur === 'raw') fb = { ok: false, h: `Сначала почини данные: расходы рассылки записаны в долларах как рубли, и по таким цифрам выводы делать нельзя. Переключи «В рубли по курсу».` };
        else if (r.romi < -0.005) fb = { ok: true, h: `Да. По модели «${MNAME[U.model]}» канал «${CH[q].n}» приносит ${rub(r.rev)} выручки — это ${rub(r.rev * OWN.margin)} маржи против ${rub(r.sp.dwh)} расхода: ROMI ${romiS(r.romi)}. LTV/CAC — ${dec(r.lc, 1)}: ${r.lc >= 3 ? 'за жизнь покупателя канал всё же окупится — резать осторожно' : r.lc >= 1 ? 'окупится только повторными покупками, и медленно' : 'не окупится даже повторными покупками'}. Переключи модель — ответ может стать другим.` };
        else fb = { ok: false, h: `Нет: по модели «${MNAME[U.model]}» канал «${CH[q].n}» окупается — ROMI ${romiS(r.romi)}. Ищи красный ROMI в таблице.` };
      }
      return quiz('rq', `Какой канал на самом деле не окупается по модели «${MNAME[U.model]}»?`, PAID.map(c => [c, CH[c].n]), q, fb);
    }
    DRAWS.roi = () => {
      const im = $('#e2eImp'); if (!im) return;
      const rows = roiRows(U.model, U.hl, U.roi.sched, U.roi.cur);
      im.innerHTML = roiImp(); $('#e2eRoiK').innerHTML = roiKpis(rows); $('#e2eRoiT').innerHTML = roiTable(rows); $('#e2eRoiNote').innerHTML = roiNote(rows); $('#e2eRoiQ').innerHTML = roiQuiz(rows);
    };
    ACTS.sched = v => { U.roi.sched = v === 'hourly' ? 'hourly' : 'daily'; render(); };
    ACTS.cur = v => { U.roi.cur = v === 'rub' ? 'rub' : 'raw'; render(); };
    ACTS.rq = v => {
      U.roi.q = v;
      const r = roiRows(U.model, U.hl, U.roi.sched, U.roi.cur).find(x => x.ch === v);
      if (U.roi.cur === 'rub' && r && r.romi < -0.005) done('roi');
      DRAWS.roi();
    };

    /* ================= 6. Архитектура ================= */
    const BLK = {
      site: { t: ['Сайт и', 'приложение'], s: 'трекер, SDK', main: 0, type: 'client', what: 'Трекер читает метки UTM и click id из адреса, ставит cookie с анонимным id, показывает баннер согласия и отправляет события: визит, просмотр товара, корзина, заказ.', brk: 'Новую страницу выкатили без трекера; метки теряются при редиректе; блокировщики режут скрипт.', num: 'Растёт доля заказов «без источника» и «прямого захода», визитов меньше, а заказов в CRM столько же.' },
      coll: { t: ['Сборщик', 'событий'], s: 'свой домен', main: 1, type: 'app', what: 'Принимает события по HTTP на своём домене, проверяет схему, добавляет время сервера и кладёт в очередь. Это и есть точка серверного сбора.', brk: 'В распродажу не справляется с потоком и отвечает ошибкой — трекер теряет события; схему события поменяли без версии.', num: 'Провалы в графике визитов в часы пик; события с пустыми полями.' },
      queue: { t: ['Очередь'], s: 'Kafka', main: 2, type: 'queue', what: 'Принимает все события и изменения заказов, хранит их несколько дней и раздаёт потоку и озеру. Пики копятся здесь и не роняют обработку.', brk: 'Потребитель отстал — отставание (lag) растёт; кончился диск; после сбоя часть сообщений читают повторно.', num: 'Дашборд «замирает» на 20–30 минут назад; последние заказы появляются с опозданием.' },
      stream: { t: ['Поток'], s: 'Flink', main: 3, type: 'etl', lab: 'stream', what: 'Собирает события в визиты, находит источник визита, связывает заказ с визитом и пишет в хранилище — цифры за минуты.', brk: 'После перезапуска посчитал хвост ещё раз (нет «ровно один раз»); опоздавшие события отброшены.', num: 'Заказов и выручки в отчёте больше, чем в CRM; провал в последних минутах.' },
      dwh: { t: ['Хранилище'], s: 'ClickHouse', main: 4, type: 'olap', what: 'Таблицы фактов — события, визиты, заказы, расходы — и справочники: каналы, кампании, покупатели. Здесь встречаются выручка и расходы.', brk: 'Мелкие вставки по строке («too many parts»); JOIN по кампании без нормализации: «autumn» и «Autumn» — разные.', num: 'Кампаний в отчёте вдвое больше, расход и выручка по кампании не сходятся.' },
      mart: { t: ['Витрины'], s: 'dbt', main: 5, type: 'etl', what: 'Склеивают id покупателей, раскладывают заказы по каналам по модели атрибуции, считают ROMI, CAC, LTV. Тесты данных сверяют итоги с CRM.', brk: 'Сломалось правило склейки — один человек снова считается тремя; поменяли модель атрибуции — история пересчиталась без предупреждения.', num: 'Посетителей стало на 40 % больше, конверсия «упала»; выручка по каналам не равна выручке в CRM.' },
      bi: { t: ['Дашборд'], s: 'DataLens', main: 6, type: null, what: 'Показывает ROMI, CAC, LTV по каналам и кампаниям и плашку свежести данных: когда что загружено.', brk: 'Нет плашки свежести — решения принимают по вчерашним цифрам; два отчёта считают по разным моделям.', num: 'Маркетинг и финансы спорят: у каждого своя выручка по каналу.' },
      crm: { t: ['CRM: заказы'], s: 'PostgreSQL', side: 0, type: 'sql', what: 'Главный источник правды о заказах: сумма, статус, покупатель, телефон. Сюда же форма заказа кладёт метки UTM из адреса первой страницы.', brk: 'Форма заказа перестала сохранять метки; заказы по телефону заводят без источника.', num: 'Заказы есть, а источника у них нет — при этом визиты в норме.' },
      cdc: { t: ['CDC'], s: 'Debezium', side: 1, type: 'cdc', what: 'Читает журнал изменений базы заказов и отправляет каждое изменение — создан, оплачен, отменён — в очередь.', brk: 'Отстал или остановился после переключения базы на реплику.', num: 'Заказов за последний час в отчёте меньше, чем в CRM, потом догоняет.' },
      pay: { t: ['Платёжная', 'система'], s: 'вебхуки', side: 2, type: 'external', what: 'Сообщает об оплатах, отменах и возвратах вебхуками — HTTP-запросами на наш адрес.', brk: 'Вебхуки о возвратах падают с ошибкой и не повторяются.', num: 'Выручка в дашборде больше, чем в бухгалтерии, а заказов поровну.' },
      lake: { t: ['Озеро данных'], s: 'S3, Iceberg', side: 3, type: 'lake', what: 'Хранит сырые события за годы дёшево. Из них можно пересчитать всё заново — если поменяли модель атрибуции или нашли ошибку в склейке.', brk: 'Нет партиций по дате — запрос читает всё; без табличного формата — «болото» из файлов.', num: 'Пересчёт истории идёт сутки; старые отчёты расходятся с витриной.' },
      batch: { t: ['Пакетная', 'загрузка'], s: 'Airflow', side: 4, type: 'etl', what: 'По расписанию забирает расходы из кабинетов, переводит валюту, раскладывает по меткам UTM и грузит в хранилище.', brk: 'Запуск раз в сутки — сегодняшних расходов ещё нет; упал запуск — дыра за день; курс не применили.', num: 'Вечером реклама «бесплатная», ROMI за сегодня — бесконечность.' },
      cab: { t: ['Рекламные', 'кабинеты'], s: 'Директ, VK', side: 5, type: 'external', what: 'Хранят расходы, показы и клики по кампаниям и отдают их по API.', brk: 'Истёк токен доступа; кабинет досчитывает расходы задним числом; валюта — не рубли.', num: 'Расходы за несколько дней — ноль, в журнале загрузки ошибка 401.' }
    };
    const EDGES = [['site', 'coll'], ['coll', 'queue'], ['queue', 'stream'], ['stream', 'dwh'], ['dwh', 'mart'], ['mart', 'bi'], ['crm', 'cdc'], ['cdc', 'queue'], ['pay', 'queue'], ['queue', 'lake'], ['lake', 'dwh'], ['batch', 'dwh'], ['cab', 'batch']];
    const DASH0 = { ordRep: 1400, ordCrm: 1400, revRep: 4.2e6, revBuh: 4.2e6, noSrc: 0.08, vis: 70000, spY: 27300, spT: 26200, spNote: 'загрузка каждый час', fresh: '5 мин назад', camp: '7 кампаний, расходы сведены' };
    const BRK = {
      site: { noSrc: 0.35, vis: 49000 }, coll: { noSrc: 0.14, vis: 57400 }, crm: { noSrc: 0.30 },
      cdc: { ordRep: 1310, revRep: 3.93e6, fresh: 'заказы — 1 ч назад' }, pay: { revBuh: 3.7e6 },
      cab: { spY: 0, spT: 0, spNote: 'ошибка 401: токен истёк 3 дня назад' }, batch: { spT: 0, spNote: 'загрузка раз в сутки, в 06:00' },
      queue: { ordRep: 1380, revRep: 4.14e6, fresh: '25 мин назад, отставание растёт' }, stream: { ordRep: 1530, revRep: 4.59e6 },
      lake: { fresh: 'пересчёт истории — 26 ч' }, dwh: { camp: '14 кампаний: autumn ≠ Autumn' }, mart: { vis: 98000 }, bi: { fresh: 'данным 14 ч, плашки нет' }
    };
    const SYMS = [
      { id: 'batch', txt: 'Вечер 30 сентября. В дашборде расход на рекламу за сегодня — 0 ₽, а заказы с рекламы идут весь день; ROMI за сегодня — «бесконечность». Вчерашние расходы на месте.', hint: { cab: 'Кабинеты в порядке: вчерашние расходы приехали — значит, доступ работает. Сегодняшние просто ещё не забрали.', dwh: 'Хранилище хранит то, что ему привезли. Вопрос — кто и когда привозит расходы.' }, why: 'Пакетная загрузка расходов идёт раз в сутки в 06:00: сегодняшние траты появятся завтра утром. Лечение — загрузка каждый час или плашка «расходы за сегодня неполные».' },
      { id: 'site', txt: 'После выкладки новой страницы оформления доля заказов «без источника» выросла с 8 до 35 %, а визитов в отчёте стало на 30 % меньше. В CRM заказов столько же.', hint: { crm: 'Если бы форма заказа перестала сохранять метки, визиты бы не просели. Просели и визиты — значит, не срабатывает трекер на страницах.', coll: 'Сборщик теряет события под нагрузкой — провалы были бы в часы пик, а не ровно после выкладки страницы.' }, why: 'На новой странице забыли подключить трекер, и метки теряются. Лечение — автотест на выкладке: событие с метками доходит до сборщика.' },
      { id: 'stream', txt: 'Заказов в отчёте за вчера — 1 530, а в CRM — 1 400. Выручка в отчёте тоже больше бухгалтерской. Ночью перезапускали обработку.', hint: { queue: 'Очередь хранит и раздаёт события, но не считает. Дубли рождаются, когда поток после перезапуска повторно обрабатывает хвост.', cdc: 'CDC может прислать изменение повторно, но витрина по ключу заказа его бы не задвоила. Двоит подсчёт в потоке.' }, why: 'После перезапуска поток перечитал события с последнего чекпойнта и записал их ещё раз: at-least-once без записи по ключу. Лечение — exactly-once или запись по order_id.' },
      { id: 'mart', txt: 'Посетителей в отчёте на 40 % больше, чем в прошлом месяце, а заказов — столько же; конверсия «упала» с 2 до 1,4 %. Трекер и сборщик в порядке.', hint: { site: 'Трекер в порядке — так сказано в симптоме. «Людей» стало больше, потому что одного человека снова считают по каждому устройству.', bi: 'Дашборд показывает то, что посчитала витрина. Ищи, где считают посетителей.' }, why: 'Сломалась склейка в витрине: anon_id перестали связываться с покупателями, и каждое устройство снова стало «человеком». Лечение — тест данных: посетителей не больше, чем вчера × 1,2.' },
      { id: 'pay', txt: 'Выручка в дашборде за сентябрь — 4,2 млн ₽, в бухгалтерии — 3,7 млн ₽. Заказов везде поровну.', hint: { crm: 'Статусы заказов в CRM верные. Деньги возвращает платёжная система — проверь, доходят ли её сообщения о возвратах.', stream: 'Если бы поток двоил, расходилось бы и число заказов. А заказов поровну.' }, why: 'Вебхуки о возвратах из платёжной системы падают с ошибкой и не повторяются — возвраты на 500 тыс. ₽ не вычтены. Лечение — повтор вебхуков и ежедневная сверка с выгрузкой платёжной системы.' }
    ];
    VIEWS.arch = () => {
      const R = U.arch;
      return `${ana('Бухгалтерия большого магазина: кассиры у входа, курьер, который каждый вечер возит журналы в контору, сейф с архивом, бухгалтер и доска с итогами для директора. Сломается любое звено — и директор увидит неверную цифру, хотя никто ничего не украл.',
          'Сквозная аналитика — это конвейер: события с сайта, заказы из CRM, оплаты и расходы из кабинетов съезжаются в хранилище, там их сводят и показывают в дашборде. Каждый блок ломается по-своему, и у каждой поломки свой след в цифрах.',
          'Трекер → сборщик → очередь (Kafka) → поток (Flink) или пакетная загрузка (Airflow) → озеро данных (S3 + Iceberg) и хранилище (ClickHouse) → витрины (dbt) → дашборд. Сбоку — CRM через CDC, платёжная система вебхуками, рекламные кабинеты по API.')}
        <div class="e2e-ctls">${ctl('Режим', seg('amode', [['look', 'Изучить схему'], ['diag', 'Диагноз по цифрам']], R.mode, 'Режим'))}</div>
        ${R.mode === 'diag' ? '<div id="e2eSym"></div>' : ''}
        <div class="e2e-stage" id="e2eArch"></div>
        <div id="e2eBlk"></div>
        <div class="e2e-dash"><b class="e2e-h">Дашборд маркетолога <small>сентябрь, ${R.mode === 'diag' ? 'что видит аналитик сейчас' : R.broken ? 'с поломкой в блоке «' + BLK[R.broken].t.join(' ') + '»' : 'всё исправно'}</small></b><div class="e2e-kpis" id="e2eDash"></div></div>
        ${nextBtn('arch')}`;
    };
    function archGeo(W) {
      const wide = W >= 840, bh = 64, P = {};
      if (wide) {
        const cw = W / 7, bw = Math.min(150, cw - 14), y0 = 18, y1 = y0 + bh + 54;
        Object.entries(BLK).forEach(([id, b]) => { const k = b.main != null ? b.main : b.side; P[id] = { x: cw * k + (cw - bw) / 2, y: b.main != null ? y0 : y1, w: bw, h: bh }; });
        return { P, H: y1 + bh + 16, wide };
      }
      const bw = W / 2 - 14;
      Object.entries(BLK).forEach(([id, b]) => { const k = b.main != null ? b.main : b.side; P[id] = { x: b.main != null ? 8 : W / 2 + 6, y: 12 + k * 92, w: bw, h: bh }; });
      return { P, H: 12 + 7 * 92, wide };
    }
    const edgePt = (a, b) => { const cx = a.x + a.w / 2, cy = a.y + a.h / 2, dx = b.x + b.w / 2 - cx, dy = b.y + b.h / 2 - cy, t = Math.min(dx ? (a.w / 2 + 3) / Math.abs(dx) : 1e9, dy ? (a.h / 2 + 3) / Math.abs(dy) : 1e9); return [cx + dx * t, cy + dy * t]; };
    function archSVG(W) {
      const R = U.arch, { P, H } = archGeo(W), sym = R.mode === 'diag' ? SYMS[R.sym] : null, solved = sym && R.pick === sym.id;
      const broken = R.mode === 'look' ? R.broken : solved ? sym.id : null;
      let h = `<svg class="e2e-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="Схема конвейера сквозной аналитики">`;
      EDGES.forEach(([a, b]) => {
        const [x1, y1] = edgePt(P[a], P[b]), [x2, y2] = edgePt(P[b], P[a]), cut = broken && (a === broken || b === broken), ang = Math.atan2(y2 - y1, x2 - x1);
        h += `<path class="e2e-edge ${cut ? 'cut' : 'live'}" d="M${f1(x1)} ${f1(y1)}L${f1(x2 - 6 * Math.cos(ang))} ${f1(y2 - 6 * Math.sin(ang))}"/>` + head(x2, y2, ang, cut ? 'e2e-ah cut' : 'e2e-ah');
      });
      Object.entries(BLK).forEach(([id, b]) => {
        const p = P[id], st = [b.main == null ? 'src' : '', R.sel === id && R.mode === 'look' ? 'on' : '', broken === id ? 'broken' : '', sym && R.pick === id ? (solved ? 'right' : 'wrong') : ''].join(' ');
        h += `<g class="e2e-blk ${st}" data-a="blk:${id}" tabindex="0" role="button" aria-label="${esc(b.t.join(' '))}: ${esc(b.s)}">` + rc(p.x, p.y, p.w, p.h, 'e2e-blkr', 10);
        b.t.forEach((line, i) => { h += tx(p.x + 10, p.y + (b.t.length > 1 ? 21 : 27) + i * 16, esc(line), 'e2e-blkt'); });
        h += tx(p.x + 10, p.y + p.h - 10, esc(b.s), 'e2e-blks');
        if (broken === id) h += cir(p.x + p.w - 12, p.y + 12, 9, 'e2e-bolt') + tx(p.x + p.w - 12, p.y + 16.5, '!', 'e2e-boltt', 'middle');
        h += '</g>';
      });
      return h + '</svg>';
    }
    function blkCard() {
      const R = U.arch;
      if (R.mode === 'diag') return '';
      const id = R.sel, b = BLK[id];
      if (!b) return card('mut', 'Нажми на блок схемы — расскажу, что он делает, что в нём ломается и как поломку видно в цифрах. Кнопка «Сломать» покажет это на дашборде ниже.');
      const T = b.type && SD.TYPES && SD.TYPES[b.type], dv = T && T.dive && SD.DIVES && SD.DIVES[T.dive];
      return `<div class="e2e-card"><b class="e2e-h">${esc(b.t.join(' '))} <small>${esc(b.s)}</small></b>
        <div class="e2e-blkd"><div><b>ЧТО ДЕЛАЕТ</b>${b.what}</div><div class="brk"><b>ЧТО ЛОМАЕТСЯ</b>${b.brk}</div><div class="num"><b>КАК ВИДНО В ЦИФРАХ</b>${b.num}</div></div>
        ${T ? `<div class="e2e-node">${SD.icon ? SD.icon(b.type) : ''}<span><b>На площадке — узел «${esc(T.name)}» (${b.type})</b>${esc(T.short || '')}${T.info && T.info.what ? ' · ' + esc(T.info.what) : ''}</span></div>` : '<p class="e2e-mut">Отдельного узла на площадке нет: отчёты читают из «Аналитической БД» (olap).</p>'}
        <div class="row-btns" style="margin-top:8px"><button type="button" class="btn ${R.broken === id ? '' : 'danger'}" data-a="break:${id}">${R.broken === id ? 'Починить' : 'Сломать этот блок'}</button>${dv ? `<button type="button" class="btn ghost" data-a="dive:${T.dive}">Пошаговый разбор: ${esc(SD.DIVES[T.dive].title)}</button>` : ''}${b.lab ? `<button type="button" class="btn ghost" data-a="olab:${b.lab}">Лаборатория «Поток событий вживую»</button>` : ''}</div></div>`;
    }
    function symCard() {
      const R = U.arch, s = SYMS[R.sym], n = Object.keys(R.solved).length;
      let v = '';
      if (R.pick) {
        if (R.pick === s.id) v = `<div class="e2e-qfb ok">✓ Верно: «${esc(BLK[s.id].t.join(' '))}». ${s.why}</div>`;
        else v = `<div class="e2e-qfb bad">✗ Не «${esc(BLK[R.pick].t.join(' '))}». ${s.hint[R.pick] || 'Посмотри на дашборд: какая цифра расходится и с чем? Найди блок, который отвечает именно за неё.'}</div>`;
      }
      return `<div class="e2e-sym"><b>СИМПТОМ ${R.sym + 1} ИЗ ${SYMS.length} · РЕШЕНО ${n} · ДЛЯ ЗАДАНИЯ НУЖНО 3</b><span>${s.txt}</span><span class="e2e-mut">Нажми на блок схемы, который сломан.</span>${v}<div class="e2e-btns"><button type="button" class="btn" data-a="symnext">Следующий симптом →</button></div></div>`;
    }
    function dashTiles() {
      const R = U.arch, id = R.mode === 'diag' ? SYMS[R.sym].id : R.broken, D = Object.assign({}, DASH0, id ? BRK[id] : {});
      const diff = (a, b) => Math.abs(a - b) > 1;
      return tile('Заказы в отчёте', nf(D.ordRep), `в CRM — ${nf(D.ordCrm)}`, diff(D.ordRep, D.ordCrm) ? 'bad' : '')
        + tile('Выручка в отчёте', rubK(D.revRep), `в бухгалтерии — ${rubK(D.revBuh)}`, diff(D.revRep, D.revBuh) ? 'bad' : '')
        + tile('Без источника', pc(D.noSrc), 'обычно ≈ 8 %', D.noSrc > 0.1 ? 'bad' : '')
        + tile('Посетители', nf(D.vis), `конверсия ${pc(D.ordCrm / D.vis, 1)}`, D.vis !== DASH0.vis ? 'bad' : '')
        + tile('Расход вчера / сегодня', `${rubK(D.spY)} / ${rubK(D.spT)}`, D.spNote, D.spY === 0 ? 'bad' : D.spT === 0 ? 'warn' : '')
        + tile('Свежесть', D.fresh, 'когда обновлялись данные', D.fresh !== DASH0.fresh ? 'warn' : '')
        + tile('Кампании', D.camp, 'расход и выручка по меткам', D.camp !== DASH0.camp ? 'bad' : '');
    }
    DRAWS.arch = () => {
      const st = $('#e2eArch'); if (!st) return;
      st.innerHTML = archSVG(W0('#e2eArch', 300));
      $('#e2eBlk').innerHTML = blkCard(); $('#e2eDash').innerHTML = dashTiles();
      const sy = $('#e2eSym'); if (sy) sy.innerHTML = symCard();
    };
    ACTS.amode = v => { U.arch.mode = v === 'diag' ? 'diag' : 'look'; U.arch.pick = null; render(); };
    ACTS.blk = v => {
      const R = U.arch;
      if (R.mode === 'diag') {
        R.pick = v;
        if (v === SYMS[R.sym].id) { R.solved[v] = true; if (Object.keys(R.solved).length >= 3) done('arch'); }
      } else R.sel = R.sel === v ? null : v;
      render();
    };
    ACTS.break = v => { U.arch.broken = U.arch.broken === v ? null : v; render(); };
    ACTS.symnext = () => { const R = U.arch; R.sym = (R.sym + 1) % SYMS.length; R.pick = null; render(); };
    ACTS.dive = v => { if (SD.player && SD.DIVES && SD.DIVES[v]) SD.player.open(v); };
    ACTS.olab = v => { if (SD.labs) SD.labs.open(v); };

    /* ================= итоги ================= */
    VIEWS.memo = () => `<b class="e2e-h">Что запомнить</b><div class="e2e-memo">${MEMO.map(([t, xs]) => `<div class="e2e-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>
      ${card('info', `<b>Чек-лист требований для аналитика.</b> Прежде чем строить сквозную аналитику, договоритесь и запишите:<ol>${CHECK.map(x => `<li>${x}</li>`).join('')}</ol>`)}`;

    /* ================= события ================= */
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-go],[data-a]');
      if (!b || !EL.contains(b) || b.disabled) return;
      if (b.dataset.tab) return setTab(b.dataset.tab);
      if (b.dataset.go) return setTab(b.dataset.go);
      const a = b.getAttribute('data-a'), i = a.indexOf(':'), k = i < 0 ? a : a.slice(0, i), v = i < 0 ? '' : a.slice(i + 1);
      if (k === 'pair') return pickPair(+v);
      if (k === 'person') return pickPerson(+v);
      if (k === 'pf') { U.path.filter = v; render(); return; }
      if (k === 'play' || k === 'pstep' || k === 'pend' || k === 'preset') return pathAct(k);
      if (ACTS[k]) ACTS[k](v, b);
    }
    const pairOf = n => n && n.closest ? n.closest('[data-pair]') : null;
    function onOver(e) { const t = pairOf(e.target); if (t && EL.contains(t)) hoverPair(+t.getAttribute('data-pair')); }
    function onOut(e) {
      const t = pairOf(e.target); if (!t) return;
      const to = pairOf(e.relatedTarget);
      if (!to || to.getAttribute('data-pair') !== t.getAttribute('data-pair')) hoverPair(to && EL.contains(to) ? +to.getAttribute('data-pair') : null);
    }
    function onFocusIn(e) { const t = pairOf(e.target); if (t && EL.contains(t)) hoverPair(+t.getAttribute('data-pair')); }
    function onFocusOut(e) { if (pairOf(e.target) && !pairOf(e.relatedTarget)) hoverPair(null); }
    function onKey(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target;
      if (!t || !t.getAttribute || t.tagName === 'BUTTON' || t.tagName === 'INPUT' || !t.getAttribute('data-a')) return;
      e.preventDefault(); onClick({ target: t });
    }
    function onInput(e) { const t = e.target; if (t && t.dataset && t.dataset.r && INPUTS[t.dataset.r]) INPUTS[t.dataset.r](t.value, t); }

    /* ================= сборка ================= */
    EL.innerHTML = `<div class="e2e"><div class="e2e-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}</div><div class="e2e-view" id="e2eView"></div></div>`;
    EL.addEventListener('click', onClick); EL.addEventListener('keydown', onKey); EL.addEventListener('input', onInput);
    EL.addEventListener('pointerover', onOver); EL.addEventListener('pointerout', onOut);
    EL.addEventListener('focusin', onFocusIn); EL.addEventListener('focusout', onFocusOut);
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (U.alive && DRAWS[U.tab]) DRAWS[U.tab](); }); }) : null;
    if (ro) ro.observe(EL);
    render();
    return {
      destroy() {
        U.alive = false; stopTimer();
        EL.removeEventListener('click', onClick); EL.removeEventListener('keydown', onKey); EL.removeEventListener('input', onInput);
        EL.removeEventListener('pointerover', onOver); EL.removeEventListener('pointerout', onOut);
        EL.removeEventListener('focusin', onFocusIn); EL.removeEventListener('focusout', onFocusOut);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      },
      _U: U, setTab
    };
  }

  /* ================= итоги ================= */
  const MEMO = [
    ['Цепочка', ['Метка в ссылке (UTM, click id) → событие трекера → склейка id → заказ из CRM и оплата → расход из кабинета → витрина и дашборд.', 'Выручку берут из CRM и платёжной системы, а не из события «спасибо за заказ» в браузере.', 'Звенья связаны ключами: метка, anon_id, user_id, order_id, кампания.']],
    ['Атрибуция', ['Модель — договорённость, а не правда: сумма по каналам всегда равна выручке.', 'Последний клик переоценивает каналы, которые закрывают продажу, первый — те, что знакомят с магазином.', 'Решения о бюджете проверяют на двух-трёх моделях сразу.']],
    ['Потери и согласие', ['Блокировщики, отказ от cookie и Safari съедают часть событий браузера.', 'Серверный сбор возвращает потерянное техникой, но не отменяет отказ человека.', '152-ФЗ: согласие — отдельным документом, данные граждан России — в базах в России.']],
    ['Деньги', ['Расходы приходят по расписанию и с задержкой — у отчёта нужна плашка свежести.', 'Валюта — в рубли по курсу на дату траты; НДС — договориться, с ним или без.', 'ROMI — по марже, CAC — на новых покупателей, LTV/CAC от 3 — здоровый канал.']]
  ];
  const CHECK = ['Какие метки обязательны в рекламных ссылках и кто проверяет их до запуска кампании', 'Где форма заказа сохраняет UTM и click id и что делать с заказами по телефону', 'Правило склейки: какие признаки точные и держим ли вероятностную склейку отдельно', 'Модель атрибуции по умолчанию и окно: на сколько дней назад смотрим', 'Расписание импорта расходов, допустимая задержка, валюта и курс, НДС', 'Свежесть дашборда и плашка «данные неполные»', 'Сверка с CRM и бухгалтерией: какое расхождение допустимо', 'Согласие, отказ и место хранения — по 152-ФЗ, вместе с юристом'];

  /* ================= регистрация ================= */
  /* чистые функции — для проверок и для других модулей */
  SD.labE2E = { attrTrue, attribute, splitRub, stitch, lossRun, roiRows, spendOf, TOTAL, TOUCHES, PEOPLE, BUYERS, MODELS, PAIRS, A, OWN, LTV };
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'e2e', title: 'Сквозная аналитика вживую', lede: 'UTM, склейка, атрибуция, ROMI, потери событий',
    intro: 'Откуда пришёл покупатель и окупилась ли реклама. Сначала — на пальцах: листовки с купонами, кассир, карта покупателя, чек, счёт за листовки и бухгалтер, и под каждым предметом его термин. Потом руками на 40 посетителях сентября: путь покупателя по событиям, модели атрибуции и ROMI, потери событий от блокировщиков и отказа от cookie, склейка устройств, импорт расходов и окупаемость, архитектура конвейера и диагноз поломки по цифрам.',
    tasks: [
      { id: 'plain', text: 'Простыми словами: открой на картинке все шесть пар «аналогия ↔ термин»' },
      { id: 'path', text: 'Найди покупателя, который пришёл из одного канала, а купил после другого' },
      { id: 'attr', text: 'Найди канал, который «последний клик» недооценивает сильнее всего' },
      { id: 'server', text: 'Переключи сбор на серверный и посмотри, какие заказы вернулись, а какие нет' },
      { id: 'consent', text: 'Ответь, можно ли сервером вернуть тех, кто отказался от cookie' },
      { id: 'stitch', text: 'Склей посетителей так, чтобы их стало столько, сколько людей, — без ложных склеек' },
      { id: 'roi', text: 'Почини импорт расходов и найди канал, который не окупается' },
      { id: 'arch', text: 'Поставь диагноз трём симптомам: найди на схеме сломанный блок' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
  (SD.cmdExtra = SD.cmdExtra || []).push(add => add('Открыть', 'Сквозная аналитика вживую', 'UTM, атрибуция, склейка, ROMI, потери событий', () => SD.labs.open('e2e'), 'сквозная аналитика utm метка атрибуция romi cac ltv склейка identity cookie 152-фз реклама маркетинг расходы'));
})();
