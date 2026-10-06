/* «Изнутри» → виды «на данных» для брокера сообщений (queue), обработчиков (worker) и NoSQL (nosql).
   На конкретных сообщениях и ключах — заказы 1001, 1002… — видно, как каждая настройка узла меняет данные:
   брокер — ключ → партиция и порядок, группа потребителей, offset и лаг, подтверждения и дубли, хранение и DLQ;
   NoSQL — ключ партиции на кольце и горячий ключ, ключ сортировки и диапазон, реплики и ONE / QUORUM / ALL, вторичный индекс.
   Обёртка над SD.XRAY[type] по образцу js/xray-sqldata.js: виды добавляются к сцене, файлы сцен не меняются.
   Подключается после xray-sqldata.js и до xray-biz.js и xray-trend.js, поэтому её обёртка — внутренняя: «Бизнес» и
   мини-графики оборачивают уже её. В видах «на данных» stats() пустой — мини-графики прячутся сами, карточку «Бизнеса»
   сцены прячем классом .xmd-on у .xr-main: у видов своя карточка «Что это значит для магазина».
   Переключатель «Взгляд: Техника | Бизнес» общий: ключ localStorage 'amp-stroyka-lt-mode' и та же группа в #xrCtl —
   её ставит xray-biz.js; если группы нет, ставим такую же сами. Допущения «Бизнеса» — объект A из js/xray-biz.js
   (те же числа, что в «Таблице вживую»), цены узлов — из каталога. Новых допущений нет. */
(function () {
  'use strict';
  if (!window.SD) return;
  SD.XRAY = SD.XRAY || {};
  const MK = 'amp-stroyka-lt-mode';

  /* ---------- мелочи ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pl = (n, a, b, c) => { const m = Math.abs(Math.round(n)) % 100, k = m % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
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
  const pct = x => dec(x * 100, x > 0 && x * 100 < 10 ? 1 : 0) + ' %';
  const orders = v => { const n = Math.max(1, Math.round(v)); return v < 10 ? `${n} ${pl(n, 'заказ', 'заказа', 'заказов')}` : `${big(v)} заказов`; };
  const msec = ms => ms < 1000 ? Math.max(1, Math.round(ms)) + ' мс' : dec(ms / 1000, ms < 10000 ? 1 : 0) + ' с';
  const hsh = k => (k * 37 + 11) % 101;   // учебный хеш, как в сцене брокера: одинаковый ключ → одно и то же число
  /* хеш строки → точка 0…1 на кольце: FNV-1a и финальное перемешивание, как в Murmur3, — похожие ключи («user:501», «user:502») разлетаются по кольцу */
  const fnv = s => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const KC = ['--k-read', '--k-write', '--k-static', '--k-upload', '--k-search', '--k-msg', '--k-job', '--k-geo', '--k-graph', '--k-voice'];
  const kc = i => `var(${KC[((i % KC.length) + KC.length) % KC.length]})`;
  const $ = id => document.getElementById(id);
  const nodeNow = ctx => (ctx.nodeOf && ctx.nodeOf(ctx.node.id)) || ctx.node;
  const btn = (act, text, o) => `<button type="button" class="btn xmd-b${o && o.pri ? ' primary' : ''}" data-xmd="${act}"${o && o.dis ? ' disabled' : ''}${o && o.tip ? ` title="${esc(o.tip)}"` : ''}>${text}</button>`;
  const seg = (label, name, opts, val) => `<div class="xmd-grp"><b>${label}</b><div class="seg" role="group" aria-label="${esc(label)}">${opts.map(([v, t, tip]) => `<button type="button" data-xmd="${name}:${v}" aria-selected="${String(v) === String(val)}"${tip ? ` title="${esc(tip)}"` : ''}>${t}</button>`).join('')}</div></div>`;
  const box = (title, body, cls) => `<section class="xmd-box${cls ? ' ' + cls : ''}"><h4 class="xmd-h">${title}</h4>${body}</section>`;
  const life = (an, terms, biz) => `<p class="xmd-life"><span class="xmd-tag">Как в жизни</span>${an}</p>${terms ? `<p class="xmd-terms"><span class="xmd-tag ${biz ? 'b' : 't'}">${biz ? 'Для магазина' : 'Термины'}</span>${terms}</p>` : ''}`;
  const stat = (l, v, cls, note) => `<div class="xmd-st"><small>${l}</small><b class="${cls || ''}">${v}</b>${note ? `<span>${note}</span>` : ''}</div>`;

  /* ---------- допущения «Бизнеса»: объект A из js/xray-biz.js; копия на случай, если тот файл не подключён ---------- */
  const A0 = { check: 3000, conv: 0.02, peakX: 3, act: 20, actW: 30, usdRub: 90, days: 30, slow: 0.01, ticket: 0.3, ticketRub: 300, failover: 30, restoreH: 1, refP: 50 };
  const AS = () => Object.assign({}, A0, (SD.xrayBiz && SD.xrayBiz.A) || {});
  const USER_R = ['read', 'search', 'feed', 'graph', 'geo'], USER_W = ['write', 'upload', 'msg'];
  /* модель магазина — как shop() в js/xray-biz.js: средний магазин с пиком 50 запросов покупателей в секунду */
  function shop() {
    const a = AS(), L = (SD.app && SD.app.A && SD.app.A.level) || {}, tr = L.traffic || {};
    const sum = ks => ks.reduce((s, k) => s + (+tr[k] || 0), 0);
    const R = sum(USER_R), W = sum(USER_W), P = R + W || a.refP;
    const k = P > a.refP ? a.refP / P : 1, act = W > R ? a.actW : a.act, dau = P * k / a.peakX * 86400 / act;
    return { k, dau, ordersDay: dau * a.conv, ordersH: dau * a.conv / 24 * a.peakX, rubMonth: dau * a.conv * a.days * a.check };
  }
  const ASM = {
    shop: S => `средний магазин — ≈ ${big(S.ordersDay)} заказов в день, в час пик ≈ ${big(S.ordersH)} (≈ 20 запросов на посетителя в день, 2 % посетителей заказывают, пик втрое выше среднего)`,
    chk: 'чек 3 000 ₽',
    ticket: '30 % пострадавших пишут в поддержку, обращение — 300 ₽',
    fail: 'без запасного чинить ≈ 1 ч, на запасной переключиться ≈ 30 с',
    slow: '+100 мс к ответу — минус 1 % заказов',
    usd: '$1 = 90 ₽, цены узлов — из каталога площадки',
    month: 'месяц — 30 дней',
    model: 'доли «вразнобой», «дубли», «прочитано зря» — из модели этого вида на 10–40 записях, а не из реального потока'
  };
  const unitUsd = (type, props) => { try { const t = SD.TYPES[type]; return t && t.cost ? t.cost({ props: Object.assign({ count: 1, engine: 'kafka', partitions: 1 }, props || {}) }) : NaN; } catch (e) { return NaN; } };

  /* ---------- данные: поток событий заказов ---------- */
  const ST = ['создан', 'оплачен', 'собран', 'отправлен'];
  const MAIL = ['Заказ принят', 'Оплата получена', 'Заказ собран', 'Заказ в пути'];
  const USERS = [503, 501, 503, 504, 502, 503, 505, 506, 503, 507];   // покупатель 503 — оптовик: 4 заказа из 10
  const userOf = id => USERS[(id - 1001) % USERS.length];
  /* генератор: у каждого заказа события идут по порядку — создан → оплачен → собран → отправлен; заказы перемешаны */
  function stream(seed) {
    const r = rng(seed), act = [];
    let next = 1001, n = 0;
    return () => {
      let o;
      if (act.length < 2 || (act.length < 4 && r() < 0.42)) { o = { id: next++, st: -1 }; act.push(o); }
      else o = act[Math.floor(r() * act.length)];
      o.st++;
      if (o.st >= ST.length - 1) act.splice(act.indexOf(o), 1);
      return { n: ++n, id: o.id, u: userOf(o.id), st: o.st };
    };
  }
  const keyVal = (key, m) => key === 'order' ? m.id : key === 'user' ? m.u : null;
  const KEYN = { order: 'order_id', user: 'user_id', none: 'без ключа' };
  const mkey = m => m.id + ':' + ST[m.st];   // ключ идемпотентности: заказ + статус

  /* ---------- настройки брокера: у брокера — свои; у обработчика — брокера перед ним ---------- */
  function bcfg(ctx, type) {
    const G = SD.app.A.graph, me = nodeNow(ctx);
    const byId = id => G.nodes.find(x => x.id === id);
    const consOf = q => G.edges.filter(e => e.from === q.id).map(e => byId(e.to)).filter(n => n && (n.type === 'worker' || n.type === 'app'));
    let q = null, cons = [];
    if (type === 'queue') { q = me; cons = consOf(me); }
    else {
      const e = G.edges.find(x => x.to === me.id && (byId(x.from) || {}).type === 'queue');
      q = e ? byId(e.from) : null;
      cons = q ? consOf(q) : [];
      if (!cons.includes(me)) cons.push(me);
    }
    const qp = q ? q.props : {}, eng = SD.ENGINES[qp.engine || 'kafka'] || SD.ENGINES.kafka, kf = eng.cap === 'partitions';
    const wk = type === 'worker' ? me : cons.find(n => n.type === 'worker');
    const C = cons.reduce((s, n) => s + Math.max(1, +n.props.count || 1), 0);
    return {
      type, q, noQ: !q, eng, engId: qp.engine || 'kafka', kf, fifo: eng.order === 'group',
      P: kf ? clamp(+qp.partitions || 3, 1, 32) : 1, C: clamp(C, 0, 40), base: clamp(C, 0, 40),
      sem: qp.semantics || 'least', retries: !!qp.retries, acks: kf ? String(qp.acks == null ? '1' : qp.acks) : '',
      batch: wk ? Math.max(1, +wk.props.batch || 1) : 1, autoscale: !!(wk && wk.props.autoscale),
      dedup: type === 'worker' ? !!me.props.dedup : cons.length > 0 && cons.every(n => n.type === 'worker' && n.props.dedup),
      wkName: wk ? (wk.label || 'Обработчики') : 'Обработчики'
    };
  }
  const bsig = c => [c.engId, c.P, c.C, c.sem, c.retries, c.batch, c.autoscale, c.dedup, c.noQ].join('|');
  const SEMN = { most: 'at-most-once', least: 'at-least-once', exactly: 'exactly-once' };
  function bchips(c, key) {
    const ch = [];
    if (c.noQ) ch.push(['брокер', 'нет на схеме — взяли Kafka', 'warn']);
    else ch.push(['движок', c.eng.name, '']);
    if (c.kf) ch.push(['партиций', String(c.P), '']);
    ch.push(['обработчиков', String(c.C), c.C === 0 ? 'bad' : c.kf && c.C > c.P ? 'warn' : '']);
    if (key) ch.push(['ключ', KEYN[key], key === 'none' ? 'warn' : '']);
    ch.push(['доставка', SEMN[c.sem] || c.sem, c.sem === 'most' ? 'warn' : '']);
    ch.push(['повторы + DLQ', c.retries ? 'вкл.' : 'выкл.', c.retries ? 'ok' : '']);
    ch.push(['пачка', String(c.batch), '']);
    ch.push(['inbox', c.dedup ? 'вкл.' : 'выкл.', c.dedup ? 'ok' : '']);
    return chipRow(ch);
  }
  const chipRow = ch => `<div class="xmd-cfg" aria-label="Настройки узла, которые видны на этой картинке">${ch.map(([l, v, cls]) => `<span class="xmd-chip ${cls || ''}"><small>${esc(l)}</small><b>${esc(v)}</b></span>`).join('')}</div>`;

  /* ячейка сообщения: номер в журнале (offset), заказ, статус; цвет полоски — заказ */
  function cell(m, cls, top) {
    let c = cls || '';
    if (m.fresh) { m.fresh = false; c += ' xmd-in'; }
    const t = `сообщение №${m.n}: заказ ${m.id}, покупатель ${m.u}, «${ST[m.st]}»`;
    return `<span class="xmd-cell ${c}" style="--c:${kc(m.id - 1001)}" title="${esc(t)}">${top != null ? `<i class="xmd-off">${top}</i>` : ''}<b>${m.id}</b><small>${ST[m.st]}</small></span>`;
  }
  const mstate = m => m.lost || m.bad ? 'is-bad' : m.fly ? 'is-fly' : m.dlq ? 'is-bad' : m.poi && !m.done ? 'is-poi' : m.again ? 'is-again' : m.dup ? 'is-dup' : m.skip ? 'is-skip' : m.com ? 'is-com' : m.done ? 'is-done' : 'is-wait';

  /* =====================================================================================================
     Брокер: ключ → партиция и порядок
     ===================================================================================================== */
  const ROUTE = 320, GAP = 60, WORK = 640;
  const LF = [1, 2.4, 0.8, 1.6, 1.2, 2, 0.9, 1.4, 1.1, 1.7, 0.85, 1.3];   // темп читателей: ×1 — 0,64 с модели на сообщение
  const V = {};
  V['data-key'] = env => {
    const H = env.H;
    let c, S;
    const SHOW = 12;
    function reset() {
      c = env.cfg();
      S = { t: 0, gen: stream(11), rr: 0, todo: [], next: 200, cur: null, last: null, lanes: [], readers: [], done: [], maxSt: {}, inv: new Set(), seen: [] };
      S.lanes = Array.from({ length: c.kf ? c.P : 1 }, (_, p) => ({ p, q: [] }));
      if (c.kf) {
        const n = Math.min(c.C, c.P);
        S.readers = Array.from({ length: n }, (_, i) => ({ i, f: LF[i % LF.length], lanes: S.lanes.filter(l => l.p % n === i).map(l => l.p), rr: 0, busy: null }));
      } else S.readers = Array.from({ length: Math.min(c.C, 6) }, (_, i) => ({ i, f: LF[i % LF.length], lanes: [0], rr: 0, busy: null }));
      send(10);
    }
    function send(n) { for (let i = 0; i < n; i++) S.todo.push(S.gen()); }
    const part = m => { if (!c.kf) return 0; const k = keyVal(H.key, m); return k == null ? S.rr++ % c.P : hsh(k) % c.P; };
    function place(m) {
      const l = S.lanes[m.p]; m.off = l.q.length; m.fresh = true; l.q.push(m);
      if (!S.seen.includes(m.id)) S.seen.push(m.id);
    }
    const grp = m => { const k = keyVal(H.key, m); return k == null ? 'all' : String(k); };
    function pick(r) {
      if (c.kf) {
        for (let k = 0; k < r.lanes.length; k++) {
          const l = S.lanes[r.lanes[(r.rr + k) % r.lanes.length]], m = l.q.find(x => !x.taken);
          if (m) { r.rr = (r.rr + k + 1) % r.lanes.length; return m; }
        }
        return null;
      }
      const q = S.lanes[0].q;
      if (!(c.fifo)) return q.find(x => !x.taken) || null;
      const blocked = new Set();   // SQS FIFO: пока сообщение группы в работе, следующие этой группы не выдаются
      for (const m of q) { const g = grp(m); if (m.done) continue; if (blocked.has(g)) continue; if (m.taken) { blocked.add(g); continue; } return m; }
      return null;
    }
    function finish(m) {
      m.done = true; m.taken = true; S.done.push(m);
      const mx = S.maxSt[m.id] == null ? -1 : S.maxSt[m.id];
      if (m.st < mx) { m.bad = true; S.inv.add(m.id); }
      else if (m.st > mx + 1) { m.early = true; S.inv.add(m.id); }
      S.maxSt[m.id] = Math.max(mx, m.st);
    }
    function tick(dt) {
      S.t += dt;
      if (!S.cur && S.todo.length && S.t >= S.next) { const m = S.todo.shift(); m.p = part(m); S.cur = { m, t0: S.t, ph: 0 }; env.dirty(); }
      if (S.cur) {
        const f = (S.t - S.cur.t0) / ROUTE, ph = f < 0.34 ? 0 : f < 0.67 ? 1 : 2;
        if (ph !== S.cur.ph) { S.cur.ph = ph; env.dirty(); }
        if (f >= 1) { place(S.cur.m); S.last = S.cur; S.cur = null; S.next = S.t + GAP; env.dirty(); }
      }
      S.readers.forEach(r => {
        if (r.busy && S.t >= r.busy.end) { r.busy.m.fly = false; finish(r.busy.m); r.busy = null; env.dirty(); }
        if (!r.busy) { const m = pick(r); if (m) { m.taken = true; m.fly = true; r.busy = { m, end: S.t + WORK * r.f }; env.dirty(); } }
      });
    }
    /* ---------- картинка ---------- */
    function calc(biz) {
      const x = S.cur || S.last;
      if (!x) return `<p class="xmd-muted">Нажми «Отправить 10 сообщений» — каждое пройдёт через выбор партиции.</p>`;
      const m = x.m, k = keyVal(H.key, m), ph = S.cur ? S.cur.ph : 3, on = i => ph === i ? ' on' : ph > i ? ' did' : '';
      const head = `<p class="xmd-msg">${cell(Object.assign({}, m, { fresh: false }), S.cur ? 'is-fly' : 'is-wait')}<span>сообщение №${m.n}: ${biz ? `письмо «${MAIL[m.st]}» по заказу ${m.id}` : `заказ ${m.id}, покупатель ${m.u}, событие «${ST[m.st]}»`}</span></p>`;
      if (!c.kf) {
        return head + `<ol class="xmd-steps"><li class="xmd-step${on(0)}">${c.fifo ? `группа сообщений (MessageGroupId) = ${k == null ? 'одна на всех' : esc(k)}` : 'партиций нет — одна общая очередь'}</li><li class="xmd-step${on(1)}">${c.fifo ? 'пока сообщение группы в работе, следующее этой группы никому не выдаётся' : 'брокер выдаёт сообщения свободным обработчикам по кругу'}</li><li class="xmd-step${on(2)}">встало в конец очереди</li></ol>`;
      }
      const h = k == null ? null : hsh(k);
      return head + `<ol class="xmd-steps">
        <li class="xmd-step${on(0)}">${k == null ? 'ключа нет' : `ключ = ${KEYN[H.key]} = <b>${k}</b>`}</li>
        <li class="xmd-step${on(1)}">${k == null ? 'кладём по кругу: следующая партиция' : `hash(${k}) = <b>${h}</b> <small>учебный хеш; в Kafka — murmur2</small>`}</li>
        <li class="xmd-step${on(2)}">${k == null ? `→ <b>P${m.p}</b>` : `${h} mod ${c.P} = <b>${m.p}</b> → партиция <b>P${m.p}</b>`}</li></ol>`;
    }
    function lanes(biz) {
      if (!c.kf) {
        const q = S.lanes[0].q, wait = q.filter(m => !m.done);
        const rd = S.readers.map(r => `<span class="xmd-rd">Обработчик ${r.i + 1}<small>темп ×${dec(1 / r.f, 1)}</small>${r.busy ? cell(r.busy.m, 'is-fly') : '<em>свободен</em>'}</span>`).join('');
        return `<div class="xmd-lane"><div class="xmd-ll"><b>Очередь</b><small>${wait.length} ждут</small></div><div class="xmd-cells">${wait.filter(m => !m.taken).slice(0, 14).map(m => cell(m, 'is-wait')).join('') || '<em class="xmd-muted">пусто</em>'}</div></div><div class="xmd-rds">${rd || '<em class="xmd-muted">обработчиков нет — сообщения копятся</em>'}</div>`;
      }
      const tot = S.lanes.reduce((s, l) => s + l.q.length, 0) || 1;
      const row = l => {
        const r = S.readers.find(x => x.lanes.includes(l.p)), tail = l.q.slice(-10), more = l.q.length - tail.length;
        return `<div class="xmd-lane"><div class="xmd-ll"><b>P${l.p}</b><small>${r ? `читает обр. ${r.i + 1} · темп ×${dec(1 / r.f, 1)}` : 'никто не читает'}</small><small>${l.q.length} ${pl(l.q.length, 'сообщение', 'сообщения', 'сообщений')} · ${pct(l.q.length / tot)}</small></div><div class="xmd-cells">${more > 0 ? `<em class="xmd-more">…ещё ${more}</em>` : ''}${tail.map(m => cell(m, mstate(m), m.off)).join('') || '<em class="xmd-muted">пусто</em>'}</div></div>`;
      };
      const vis = S.lanes.slice(0, SHOW).map(row).join('');
      const rest = S.lanes.slice(SHOW), rn = rest.reduce((s, l) => s + l.q.length, 0);
      return vis + (rest.length ? `<p class="xmd-muted">Ещё ${rest.length} ${pl(rest.length, 'партиция', 'партиции', 'партиций')} (P${SHOW}–P${c.P - 1}) не показаны: в них ${rn} ${pl(rn, 'сообщение', 'сообщения', 'сообщений')}.</p>` : '');
    }
    function seen(biz) {
      const ids = S.seen.slice(-8);
      if (!ids.length) return '<p class="xmd-muted">Пока ничего не обработано.</p>';
      return `<ul class="xmd-orders">${ids.map(id => {
        const dn = S.done.filter(m => m.id === id), all = [].concat(...S.lanes.map(l => l.q)).filter(m => m.id === id && !m.done);
        const bad = S.inv.has(id);
        return `<li class="${bad ? 'bad' : ''}"><b style="--c:${kc(id - 1001)}">${id}</b>${dn.map(m => `<span class="xmd-ev ${m.bad ? 'bad' : m.early ? 'warn' : 'ok'}">${biz ? MAIL[m.st] : ST[m.st]}</span>`).join('<i>→</i>')}${all.length ? `${dn.length ? '<i>→</i>' : ''}<span class="xmd-ev wait">ждёт: ${all.map(m => biz ? MAIL[m.st] : ST[m.st]).join(', ')}</span>` : ''}${bad ? `<em>${biz ? 'письма пришли вразнобой' : 'порядок нарушен'}</em>` : ''}</li>`;
      }).join('')}</ul>`;
    }
    function hotLane() {
      if (!c.kf) return null;
      const tot = S.lanes.reduce((s, l) => s + l.q.length, 0); if (tot < 6) return null;
      const l = S.lanes.slice().sort((a, b) => b.q.length - a.q.length)[0];
      return { l, share: l.q.length / tot, ideal: 1 / c.P };
    }
    function say(biz) {
      const nOrd = S.seen.length, inv = S.inv.size, hl = hotLane();
      if (c.C === 0) return '<b>Сообщения никто не читает.</b> Они раскладываются и копятся. Проведи на площадке стрелку от брокера к обработчикам.';
      if (!c.kf) {
        if (c.fifo) return `<b>SQS FIFO: порядок держится внутри группы.</b> ${H.key === 'none' ? 'Группа одна на всех — сообщения идут строго по одному, параллельности нет.' : `Группа = ${KEYN[H.key]}: события одного ${H.key === 'user' ? 'покупателя' : 'заказа'} не выдаются двум обработчикам сразу.`} ${inv ? `Вразнобой: ${inv}.` : 'Вразнобой: ни одного.'}`;
        return `<b>${esc(c.eng.name)}: ${c.eng.replay ? 'один общий поток' : 'одна общая очередь'}, партиций нет.</b> Свободный обработчик берёт следующее сообщение. ${S.readers.length > 1 ? `Обработчиков ${S.readers.length}, темп у них разный — события одного заказа обгоняют друг друга: ${inv ? `вразнобой уже ${inv} ${pl(inv, 'заказ', 'заказа', 'заказов')}` : 'смотри, кто кого обгонит'}. Ключ здесь не помогает.` : 'Обработчик один — порядок сохраняется, но параллельности нет.'}`;
      }
      if (H.key === 'none') return `<b>Ключа нет — сообщения раскладываются по кругу.</b> События одного заказа попадают в разные партиции, а партиции читаются в своём темпе. ${inv ? `Вразнобой: ${inv} из ${nOrd} ${pl(nOrd, 'заказа', 'заказов', 'заказов')} — ${biz ? '«Заказ в пути» приходит раньше «Оплата получена»' : 'более позднее событие обработано раньше'}.` : 'Пока везёт — смотри на «Как увидел сервис писем».'}`;
      let h = `<b>Ключ — ${KEYN[H.key]}: hash(ключ) mod ${c.P}.</b> Все события ${H.key === 'user' ? 'покупателя' : 'заказа'} лежат в одной партиции и читаются строго по очереди: вразнобой — ${inv ? inv : 'ни одного'}.`;
      if (H.key === 'user' && hl && hl.share > hl.ideal * 1.4) h += ` Но оптовик 503 — горячий ключ: P${hl.l.p} получила ${pct(hl.share)} сообщений при ровной доле ${pct(hl.ideal)}.`;
      if (c.C < c.P) h += ` Обработчиков ${c.C} на ${c.P} ${pl(c.P, 'партицию', 'партиции', 'партиций')} — кто-то читает несколько.`;
      return h;
    }
    function biz() {
      const S0 = shop(), a = AS(), nOrd = S.seen.length, inv = S.inv.size, hl = hotLane();
      const per1 = S0.ordersDay * 0.01 * a.ticket * a.ticketRub * a.days;   // каждый 1 % заказов с письмами вразнобой
      const k = [
        ['Письма вразнобой', nOrd ? `${inv} из ${nOrd}` : '…', inv ? 'bad' : nOrd ? 'ok' : '', inv ? `заказов в модели; у среднего магазина каждый 1 % таких заказов — ≈ ${orders(S0.ordersDay * 0.01)} в день: покупатель видит «в пути» раньше «оплачено» и пишет в поддержку — ≈ ${rub(per1)} в месяц` : nOrd ? 'каждый получает письма по порядку — поддержке писать не о чем' : 'копим сообщения'],
        ['Одно письмо не по порядку', '≈ ' + rub(a.ticket * a.ticketRub), '', `${pct(a.ticket)} таких покупателей пишут в поддержку, обращение — ${rub(a.ticketRub)}`]
      ];
      if (hl) k.push(['Самая загруженная партиция', `P${hl.l.p}: ${pct(hl.share)}`, hl.share > hl.ideal * 1.4 ? 'warn' : 'ok', hl.share > hl.ideal * 1.4 ? `ровно было бы ${pct(hl.ideal)}: письма этой партиции ждут дольше — у оптовика и всех, кто попал к нему` : 'нагрузка делится ровно']);
      return { an: 'Почта по районам: письма одного адресата лежат в одном ящике и приходят по порядку. Разложили наугад — «Заказ в пути» приходит раньше «Оплата получена».', k, asm: ['shop', 'ticket', 'month', 'model'] };
    }
    return {
      reset, tick,
      sig: () => bsig(c) + '|' + H.key,
      top: bizOn => (bizOn
        ? life('Как <b>почта по районам</b>: письма одного адресата всегда кладут в ящик его района, и почтальон разносит их по порядку. Разложили наугад — письма приходят вразнобой.', 'Ключ сообщения — номер заказа или покупателя. По ключу брокер выбирает «ящик» — партицию. Один ключ — один ящик — письма по порядку.', true)
        : life('Как <b>почтовые ящики по районам</b>: письмо кладут в ящик района адресата, и почтальон этого района разносит их строго по порядку. Письма одному адресату всегда в одном ящике.', '<b>Ключ</b> сообщения превращается в число — <b>хеш</b>; остаток от деления на число <b>партиций</b> — номер партиции: <code>hash(key) mod N</code>. Внутри партиции порядок сохраняется, между партициями — нет. Без ключа сообщения ложатся по кругу.')) + bchips(c, H.key),
      ctl: () => (c.kf || c.fifo ? seg('Ключ сообщения', 'key', [['order', 'order_id', 'номер заказа'], ['user', 'user_id', 'номер покупателя'], ['none', 'без ключа', 'по кругу']], H.key) : '') + `<div class="xmd-grp">${btn('send', 'Отправить 10 сообщений', { pri: 1 })}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a.startsWith('key:')) { H.key = a.slice(4); reset(); env.log(`<b>Ключ сообщения: ${KEYN[H.key]}.</b> Те же сообщения разложены заново.`); return true; }
        if (a === 'send') { send(10); env.log('<b>Отправлено 10 сообщений.</b> Смотри, куда ляжет каждое.'); return false; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        const msgs = [].concat(...S.lanes.map(l => l.q)), keys = [...new Set(msgs.map(m => keyVal(H.key, m)).filter(x => x != null))];
        reset();
        if (k === 'partitions' && keys.length && c.kf) {
          const mv = keys.filter(x => hsh(x) % +prev !== hsh(x) % +v).length;
          return `На данных: ${mv} из ${keys.length} ${pl(keys.length, 'ключа', 'ключей', 'ключей')} сменили партицию (hash mod ${prev} → mod ${v}). Пока старые сообщения не дочитаны, порядок по таким ключам может нарушиться — поэтому партиции берут с запасом заранее.`;
        }
        if (k === 'engine') return c.kf ? 'На данных: появились партиции — ключ снова решает, куда ляжет сообщение.' : 'На данных: партиций нет, одна общая очередь — ключ больше не держит порядок.';
        return '';
      },
      stage: bizOn => `<div class="xmd-two">${box(bizOn ? '1. Куда положить письмо' : '1. Ключ → партиция', calc(bizOn))}${box(bizOn ? 'Ждут отправки' : 'Очередь продюсера', `<div class="xmd-cells">${S.todo.slice(0, 12).map(m => cell(m, 'is-wait')).join('') || '<em class="xmd-muted">всё отправлено</em>'}</div>`)}</div>`
        + box(c.kf ? (bizOn ? '2. Ящики (партиции) — по порядку прихода' : '2. Партиции — журналы, номер сверху — offset') : '2. Очередь и обработчики', `<div class="xmd-lanes">${lanes(bizOn)}</div>`)
        + box(bizOn ? '3. Какие письма получил покупатель — по порядку' : '3. Как увидел сервис писем — в порядке обработки', seen(bizOn)),
      say, biz
    };
  };

  /* =====================================================================================================
     Брокер: группа потребителей, offset и лаг, ребаланс
     ===================================================================================================== */
  V['data-group'] = env => {
    const H = env.H;
    let c, S;
    const WK = 650, DET = 1500, REB = 1100, SHOWC = 12, SHOWP = 12;
    const mkCon = isNew => ({ id: ++S.nid, alive: true, down: false, parts: [], busy: null, rr: 0, idle: false, isNew: !!isNew });
    function reset() {
      c = env.cfg();
      S = { t: 0, gen: stream(23), rr: 0, lanes: [], cons: [], reb: null, sendQ: 0, nextSend: 0, nid: 0, ev: { ok: 0, dup: 0, skip: 0 }, scaleT: 0, calmT: 0, auto: 0, crashN: 0 };
      S.lanes = Array.from({ length: c.kf ? c.P : 1 }, (_, p) => ({ p, log: [], com: 0, pos: 0, pend: 0, own: null }));
      for (let i = 0; i < Math.min(c.C, SHOWC); i++) S.cons.push(mkCon());
      const pre = clamp(S.lanes.length * 3, 9, 24);
      for (let i = 0; i < pre; i++) put(S.gen(), true);
      S.lanes.forEach(l => { const h = Math.floor(l.log.length / 2); l.log.slice(0, h).forEach(m => { m.done = true; m.com = true; m.acked = true; }); l.com = l.pos = h; });
      if (!c.kf) S.lanes[0].log.forEach(m => { m.taken = !!m.done; });
      assign();
      S.sendQ = 6; S.nextSend = 500;
    }
    const part = m => { if (!c.kf) return 0; const k = keyVal(H.key, m); return k == null ? S.rr++ % c.P : hsh(k) % c.P; };
    function put(m, quiet) { const l = S.lanes[part(m)]; m.p = l.p; m.off = l.log.length; m.fresh = !quiet; l.log.push(m); }
    function assign() {
      const al = S.cons.filter(x => x.alive);
      S.cons.forEach(x => { x.parts = []; x.idle = false; });
      S.lanes.forEach(l => { l.own = null; });
      if (!al.length) return;
      if (c.kf) {
        const act = al.slice(0, c.P);
        al.slice(c.P).forEach(x => { x.idle = true; });
        S.lanes.forEach(l => { const x = act[l.p % act.length]; x.parts.push(l.p); l.own = x.id; });
      } else al.forEach(x => { x.parts = [0]; });
    }
    function commit(l) { l.com = l.pos; l.pend = 0; l.log.forEach((m, i) => { if (i < l.com && m.done) m.com = true; }); }
    function fin(x) {
      const { m, l } = x.busy; x.busy = null; m.fly = false;
      if (m.done) { if (c.dedup) { S.ev.skip++; m.skip = true; } else { S.ev.dup++; m.dup = true; } }
      else S.ev.ok++;
      m.done = true; m.again = false;
      if (c.kf) { l.pend++; if (l.pend >= c.batch || l.pos >= l.log.length) commit(l); }
      else { m.acked = true; m.com = true; }
    }
    const lag = l => c.kf ? l.log.length - l.com : l.log.filter(m => !m.acked).length;
    const totalLag = () => S.lanes.reduce((s, l) => s + lag(l), 0);
    function startReb(why) {
      S.cons.forEach(x => { if (x.alive && x.busy) fin(x); });
      S.lanes.forEach(l => { const o = S.cons.find(x => x.id === l.own); if (o && o.alive && l.pos > l.com) commit(l); });
      S.reb = { ph: 'reb', until: S.t + REB, why };
      env.log(`<b>Ребаланс:</b> ${why}. Все отдают партиции, чтение стоит.`, 'warn');
    }
    function endReb() {
      let again = 0;
      S.lanes.forEach(l => { for (let i = l.com; i < l.pos; i++) if (l.log[i].done) { l.log[i].again = true; again++; } l.pos = l.com; l.pend = 0; });
      assign(); S.reb = null;
      S.cons.forEach(x => { x.isNew = false; });
      const idle = S.cons.filter(x => x.idle).length;
      env.log(`<b>Ребаланс закончен.</b> Партиции розданы заново${again ? `; ${again} ${pl(again, 'сообщение', 'сообщения', 'сообщений')} без коммита ${pl(again, 'придёт', 'придут', 'придут')} снова` : ''}${idle ? `; ${idle} ${pl(idle, 'обработчик ждёт', 'обработчика ждут', 'обработчиков ждут')} партицию` : ''}.`, again ? 'warn' : '');
    }
    function add(why) {
      if (S.cons.length >= SHOWC && !S.cons.some(x => x.down)) return false;
      const dn = S.cons.find(x => x.down);
      if (dn) { dn.alive = true; dn.down = false; dn.isNew = true; } else S.cons.push(mkCon(true));
      if (!c.kf) { assign(); return true; }
      if (S.reb && S.reb.ph === 'reb') S.reb.until = S.t + REB;
      else if (!S.reb) startReb(why || 'в группу вошёл новый обработчик');
      return true;
    }
    function crash() {
      const al = S.cons.filter(x => x.alive && (x.parts.length || !c.kf));
      const x = al.find(z => z.busy) || al[al.length - 1];
      if (!x) return false;
      x.alive = false; x.down = true; S.crashN++;
      if (x.busy) {   // обработал, но не успел отметить: эффект уже случился, коммита нет
        const { m, l } = x.busy; x.busy = null; m.fly = false;
        if (!m.done) S.ev.ok++;
        m.done = true;
        if (c.kf) l.pend++;
        else { m.taken = false; m.again = true; }
      }
      if (c.kf) S.reb = { ph: 'det', until: S.t + DET, lanes: x.parts.slice(), who: x.id };
      else assign();
      env.log(`<b>Обработчик ${x.id} упал.</b> ${c.kf ? 'Координатор ждёт его «я жив» — до таймаута его партиции никто не читает.' : 'Сообщение без подтверждения вернулось в очередь.'}`, 'bad');
      return true;
    }
    function tick(dt) {
      S.t += dt;
      if (S.sendQ > 0 && S.t >= S.nextSend) { put(S.gen()); S.sendQ--; S.nextSend = S.t + 170; env.dirty(); }
      if (S.reb && S.t >= S.reb.until) { if (S.reb.ph === 'det') startReb(`обработчик ${S.reb.who} не ответил за таймаут`); else endReb(); env.dirty(); }
      const stopAll = S.reb && S.reb.ph === 'reb';
      S.cons.forEach(x => {
        if (!x.alive || x.idle || stopAll) return;
        if (x.busy) { if (S.t >= x.busy.end) { fin(x); env.dirty(); } else return; }
        if (c.kf) {
          const ps = x.parts.filter(p => !(S.reb && S.reb.ph === 'det' && S.reb.lanes.includes(p)));
          for (let k = 0; k < ps.length; k++) {
            const l = S.lanes[ps[(x.rr + k) % ps.length]];
            if (l.pos < l.log.length) { x.rr = (x.rr + k + 1) % ps.length; const m = l.log[l.pos++]; m.fly = true; x.busy = { m, l, end: S.t + WK }; env.dirty(); break; }
          }
        } else {
          const l = S.lanes[0], m = l.log.find(z => !z.taken && !z.acked);
          if (m) { m.taken = true; m.fly = true; x.busy = { m, l, end: S.t + WK }; env.dirty(); }
        }
      });
      if (c.autoscale) {   // KEDA: обработчиков по лагу; больше, чем партиций, — лишние простаивают
        const lg = totalLag(), al = S.cons.filter(x => x.alive).length;
        if (!S.reb && lg > 8 && S.t - S.scaleT > 2600 && al < 40 && add(`KEDA увидел лаг ${lg} и добавил обработчика`)) { S.scaleT = S.t; S.auto++; env.dirty(); }
        if (lg === 0) { if (!S.calmT) S.calmT = S.t; } else S.calmT = 0;
        if (!S.reb && S.auto > 0 && S.calmT && S.t - S.calmT > 4000) {
          const x = S.cons.filter(z => z.alive && !z.busy).pop();
          if (x) { S.cons.splice(S.cons.indexOf(x), 1); S.auto--; S.calmT = S.t; if (c.kf) startReb('KEDA убрал лишнего обработчика: лаг ноль'); else assign(); env.dirty(); }
        }
      }
    }
    /* ---------- картинка ---------- */
    function lanes(biz) {
      if (!c.kf) {
        const l = S.lanes[0], wait = l.log.filter(m => !m.acked);
        return `<div class="xmd-lane"><div class="xmd-ll"><b>${c.eng.replay ? 'Поток' : 'Очередь'}</b><small>ждут: ${wait.length}</small><small>${c.eng.replay ? 'подтверждённые отмечены, не показаны' : 'подтверждённые удалены'}</small></div><div class="xmd-cells">${wait.slice(0, 16).map(m => cell(m, mstate(m))).join('') || '<em class="xmd-muted">пусто — всё подтверждено</em>'}</div></div>`;
      }
      const row = l => {
        const own = S.cons.find(x => x.id === l.own), lg = lag(l), from = Math.max(0, l.log.length - 11);
        const det = S.reb && S.reb.ph === 'det' && S.reb.lanes.includes(l.p);
        let cells = from ? `<em class="xmd-more">…${from} раньше</em>` : '';
        for (let i = from; i <= l.log.length; i++) {
          if (i === l.com) cells += `<span class="xmd-mark" title="Offset группы: следующее непрочитанное — №${l.com}"></span>`;
          if (i < l.log.length) cells += cell(l.log[i], mstate(l.log[i]), i);
        }
        const who = S.reb && S.reb.ph === 'reb' ? '<small class="warn">ребаланс</small>' : det ? `<small class="bad">обр. ${S.reb.who} молчит</small>` : own ? `<small>читает обр. ${own.id}</small>` : '<small class="bad">никто не читает</small>';
        return `<div class="xmd-lane"><div class="xmd-ll"><b>P${l.p}</b>${who}<small>${biz ? 'отмечено' : 'offset'} ${l.com} из ${l.log.length} · <span class="${lg > 6 ? 'bad' : lg > 2 ? 'warn' : 'ok'}">${biz ? 'ждут' : 'лаг'} ${lg}</span></small></div><div class="xmd-cells">${cells}</div></div>`;
      };
      const rest = S.lanes.slice(SHOWP), rl = rest.reduce((s, l) => s + lag(l), 0);
      return S.lanes.slice(0, SHOWP).map(row).join('') + (rest.length ? `<p class="xmd-muted">Ещё ${rest.length} ${pl(rest.length, 'партиция', 'партиции', 'партиций')} не показаны, лаг в них — ${rl}.</p>` : '');
    }
    function cons(biz) {
      if (!S.cons.length) return '<p class="xmd-muted">Обработчиков нет — читать некому. Проведи стрелку от брокера к обработчикам.</p>';
      const more = c.C > SHOWC ? `<p class="xmd-muted">Показаны ${SHOWC} из ${c.C} обработчиков${c.kf && c.C > c.P ? `: партиций ${c.P}, так что ${c.C - c.P} в любом случае простаивают` : ''}.</p>` : '';
      return more + `<div class="xmd-cons">${S.cons.map(x => {
        const st = x.down ? ['is-down', 'упал'] : S.reb && S.reb.ph === 'reb' ? ['is-reb', 'ждёт раздачи'] : x.idle ? ['is-idle', 'ждёт партицию — простаивает'] : x.busy ? ['', `обрабатывает №${x.busy.m.off} из P${x.busy.l.p}`] : ['', 'свободен'];
        return `<div class="xmd-con ${st[0]}${x.isNew ? ' is-new' : ''}"><b>Обработчик ${x.id}</b><small>${c.kf ? (x.parts.length ? 'партиции: ' + x.parts.map(p => 'P' + p).join(', ') : 'без партиций') : 'берёт из общей очереди'}</small><span>${st[1]}</span>${x.busy ? cell(x.busy.m, 'is-fly') : ''}</div>`;
      }).join('')}</div>`;
    }
    function say(biz) {
      const lg = totalLag(), al = S.cons.filter(x => x.alive), idle = S.cons.filter(x => x.idle).length;
      if (!S.cons.length) return '<b>Группа пустая.</b> Сообщения копятся, лаг растёт без конца.';
      if (!c.kf && c.eng.replay) return `<b>${esc(c.eng.name)}: партиций нет.</b> Все обработчики группы берут из одного потока по очереди — порядок между ними не держится. Подтверждённое отмечается, но остаётся в потоке до обрезки: историю можно перечитать. Упал обработчик — его неподтверждённое сообщение отдадут другому. Ждут: ${lg}.`;
      if (!c.kf) return `<b>${esc(c.eng.name)}: групп и партиций нет.</b> Все обработчики берут из одной очереди, подтверждённое сообщение удаляется — offset не нужен. Упал обработчик — его неподтверждённое сообщение сразу вернётся в очередь, и его возьмёт сосед. Ждут: ${lg}.`;
      if (S.reb && S.reb.ph === 'det') return `<b>Обработчик ${S.reb.who} молчит.</b> Координатор ждёт его сигнал «я жив». В модели — 1,5 с, в Kafka по умолчанию до 45 с (session.timeout.ms). Его партиции ${S.reb.lanes.map(p => 'P' + p).join(', ')} всё это время не читаются — лаг растёт.`;
      if (S.reb) return `<b>Ребаланс.</b> Все отдали партиции и ждут новую раздачу — чтение стоит у всей группы. После раздачи читают с offset группы: что обработали, но не закоммитили, придёт снова (жёлтая обводка).`;
      let h = `<b>Одну партицию читает один обработчик.</b> Offset группы — «закладка»: досюда дочитали и отметились. Лаг = конец журнала − offset, сейчас ${lg}. ${c.batch > 1 ? `Коммит раз в пачку из ${c.batch}: между коммитами обработанное ещё не отмечено.` : 'Коммит после каждого сообщения.'}`;
      if (idle) h += ` <b>${idle} ${pl(idle, 'обработчик простаивает', 'обработчика простаивают', 'обработчиков простаивают')}:</b> партиций ${c.P}, а обработчиков ${al.length}.`;
      if (c.autoscale) h += ` KEDA добавляет обработчиков, когда лаг больше 8${S.auto ? ` — уже добавил ${S.auto}` : ''}.`;
      return h;
    }
    function biz() {
      const S0 = shop(), a = AS(), lg = totalLag(), act = S.cons.filter(x => x.alive && !x.idle).length, rate = act * 1000 / WK, idle = S.cons.filter(x => x.idle).length;
      const wUsd = unitUsd('worker', { count: 1 });
      const k = [['Письмо о заказе придёт через', lg ? (rate ? '≈ ' + msec(lg / rate * 1000) : 'не придёт') : 'сразу', !rate && lg ? 'bad' : lg > 8 ? 'warn' : 'ok', rate ? `ждут ${lg}; разбирают ≈ ${dec(rate, 1)} в секунду модели` : 'разбирать некому — письма копятся']];
      if (c.kf) k.push(['Если обработчик упадёт', '≈ 45 с паузы', 'warn', `столько Kafka ждёт его «я жив», потом ребаланс; за 45 с у среднего магазина ≈ ${orders(S0.ordersH * 45 / 3600)} — их письма задержатся`]);
      else k.push(['Если обработчик упадёт', 'соседи подхватят', 'ok', 'неподтверждённое сообщение вернётся в очередь — его возьмёт другой']);
      k.push(['Лишние обработчики', idle ? `${idle} без дела` : 'нет', idle ? 'warn' : 'ok', idle ? `платим ≈ ${rub(idle * wUsd * a.usdRub)} в месяц за простой: партиций ${c.P}, больше обработчиков им не нужно` : `каждый при деле; обработчик — ≈ ${rub(wUsd * a.usdRub)} в месяц`]);
      k.push(['Повторных писем после сбоя', c.dedup ? '0' : `до ${c.batch}`, c.dedup ? 'ok' : 'warn', c.dedup ? 'inbox отсекает повтор по ключу заказ + статус' : `всё, что обработали после последнего коммита, придёт снова: ≈ ${rub(c.batch * a.ticket * a.ticketRub)} на поддержку за каждый сбой`]);
      return { an: 'Почтальоны и районы: у района один почтальон. Заболел — пока начальник заново делит районы, почту не носит никто. Лишние почтальоны сидят без дела, а зарплату получают.', k, asm: ['shop', 'ticket', 'usd', 'model'] };
    }
    return {
      reset, tick,
      sig: () => bsig(c) + '|' + H.key,
      top: bizOn => (bizOn
        ? life('Как <b>почтальоны и районы</b>: у каждого района один почтальон. Почтальон заболел — начальник заново делит районы, и пока делит, почту не носит никто. Почтальонов больше, чем районов, — лишние сидят без дела.', 'Чем больше писем ждут разноса (лаг), тем позже покупатель узнаёт, что заказ принят. Сбой обработчика — пауза для всех и повторные письма.', true)
        : life('Как <b>почтальоны и районы</b>: у каждого района ровно один почтальон. Почтальон заболел — начальник заново делит районы, и пока делит, почту не носит никто. Почтальонов больше, чем районов, — лишние сидят без дела.', '<b>Группа потребителей</b> делит партиции: одну читает один участник. <b>Offset</b> — номер следующего непрочитанного, «закладка» группы. <b>Лаг</b> = конец журнала − offset. Участник пропал — <b>ребаланс</b>: партиции раздают заново, чтение стоит.')) + bchips(c, c.kf ? H.key : null),
      ctl: () => `<div class="xmd-grp">${btn('send', 'Отправить 10 сообщений', { pri: 1 })}${btn('add', 'Добавить обработчика', { dis: S.cons.length >= SHOWC && !S.cons.some(x => x.down), tip: 'Новый участник группы — ребаланс' })}${btn('crash', 'Уронить обработчика', { dis: !S.cons.some(x => x.alive) })}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a === 'send') { S.sendQ += 10; env.log('<b>Отправлено 10 сообщений.</b> Смотри на лаг партиций.'); return false; }
        if (a === 'add') { if (add()) env.log('<b>Добавлен обработчик.</b>'); return true; }
        if (a === 'crash') { crash(); return true; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'partitions') return `На данных: партиций стало ${v} — ${c.C > c.P ? `обработчиков ${c.C}, лишние ${c.C - c.P} простаивают` : `у каждого обработчика ${c.C ? dec(c.P / Math.max(1, c.C), 1) : 0} партиции в среднем`}.`;
        if (k === 'count' && c.type === 'worker') return `На данных: обработчиков стало ${c.C}${c.kf && c.C > c.P ? ` при ${c.P} партициях — лишние простаивают` : ''}.`;
        if (k === 'batch') return `На данных: коммит раз в ${v} ${pl(+v, 'сообщение', 'сообщения', 'сообщений')} — при сбое повторится до ${v}.`;
        if (k === 'autoscale') return v ? 'На данных: KEDA будет добавлять обработчиков, когда лаг больше 8.' : '';
        return '';
      },
      stage: bizOn => box(c.kf ? (bizOn ? 'Ящики и сколько писем в них ждут' : 'Партиции: offset группы и лаг') : (bizOn ? 'Очередь писем' : c.eng.replay ? 'Поток: подтверждённое отмечается и остаётся' : 'Очередь: подтверждённое удаляется'), `<div class="xmd-lanes">${lanes(bizOn)}</div>`)
        + box(bizOn ? 'Почтальоны (обработчики)' : 'Группа «сервис писем»', cons(bizOn))
        + `<div class="xmd-sts">${stat(bizOn ? 'Ждут отправки' : 'Лаг всего', String(totalLag()), totalLag() > 8 ? 'bad' : totalLag() > 3 ? 'warn' : 'ok')}${stat('Обработано', String(S.ev.ok))}${stat(bizOn ? 'Письма дважды' : 'Дубли', String(S.ev.dup), S.ev.dup ? 'warn' : 'ok')}${stat('Пропущено inbox', String(S.ev.skip), S.ev.skip ? 'ok' : '')}</div>`,
      say, biz
    };
  };

  /* =====================================================================================================
     Брокер: подтверждения, семантика доставки, дубли и идемпотентность
     ===================================================================================================== */
  V['data-ack'] = env => {
    let c, S;
    const STEP = 360, RST = 1300;
    function reset() {
      c = env.cfg();
      S = { t: 0, gen: stream(5), log: [], com: 0, pos: 0, ph: 'idle', steps: [], si: 0, stT: 0, batch: null, armed: false, downTill: 0, mail: [], mailBy: {}, inbox: [], ev: { sent: 0, dup: 0, lost: 0, skip: 0 }, sendQ: 10, nextSend: 250, redo: false, lastB: null, crashN: 0 };
    }
    const B = () => Math.max(1, c.batch);
    function plan() {
      const n = Math.min(B(), S.log.length - S.pos); if (n <= 0) return false;
      const ms = S.log.slice(S.pos, S.pos + n), e = S.pos + n, st = [];
      S.batch = { s: S.pos, e, ms }; S.pos = e;
      if (c.sem === 'most') { st.push({ k: 'take', ms }); st.push({ k: 'commit', e }); ms.forEach(m => { if (c.dedup) st.push({ k: 'check', m }); st.push({ k: 'eff', m }); }); }
      else { ms.forEach(m => { st.push({ k: 'take', ms: [m] }); if (c.dedup) st.push({ k: 'check', m }); st.push({ k: 'eff', m }); }); st.push({ k: c.sem === 'exactly' ? 'txn' : 'commit', e }); }
      S.steps = st; S.si = 0; S.stT = S.t; S.ph = 'run';
      return true;
    }
    function exec(s) {
      if (s.k === 'take') s.ms.forEach(m => { m.fly = true; });
      else if (s.k === 'check') { s.m.skip = S.inbox.includes(mkey(s.m)); s.res = s.m.skip; }
      else if (s.k === 'eff') {
        const m = s.m; m.fly = false;
        if (m.skip) { S.ev.skip++; s.res = 'skip'; }
        else {
          const k = mkey(m), e = S.mailBy[k];
          if (e) { e.n++; S.ev.dup++; m.dup = true; s.res = 'dup'; S.mail.splice(S.mail.indexOf(e), 1); S.mail.push(e); }
          else { S.mailBy[k] = { m, n: 1 }; S.mail.push(S.mailBy[k]); s.res = 'ok'; }
          S.ev.sent++;
          if (c.dedup && !S.inbox.includes(k)) S.inbox.push(k);
        }
        m.done = true; m.again = false;
      } else { S.com = s.e; S.log.forEach((m, i) => { if (i < S.com) m.com = true; }); }
    }
    function crash() {
      S.ph = 'down'; S.downTill = S.t + RST; S.armed = false; S.crashN++;
      let lost = 0;
      if (S.batch) S.batch.ms.forEach(m => { m.fly = false; if (c.sem === 'most' && !m.done && S.com >= S.batch.e) { m.lost = true; lost++; } });
      S.ev.lost += lost;
      S.batch = null; S.steps = []; S.si = 0;
      env.log(c.sem === 'most'
        ? `<b>Обработчик упал после коммита, до писем.</b> Offset уже сдвинут — ${lost} ${pl(lost, 'сообщение потеряно', 'сообщения потеряны', 'сообщений потеряно')} навсегда.`
        : '<b>Обработчик упал после писем, до коммита.</b> Offset не сдвинут — после перезапуска брокер выдаст эти сообщения снова.', c.sem === 'most' ? 'bad' : 'warn');
      env.dirty();
    }
    function restart() {
      S.pos = S.com; let n = 0;
      S.log.forEach((m, i) => { if (i >= S.com && m.done && !m.lost) { m.again = true; m.dup = false; n++; } });
      S.ph = 'idle';
      env.log(`<b>Обработчик перезапущен.</b> Читает с offset ${S.com}${n ? ` — ${n} ${pl(n, 'сообщение придёт', 'сообщения придут', 'сообщений придут')} второй раз` : ''}.`);
      env.dirty();
    }
    function doRedo() {
      S.redo = false;
      if (!S.lastB) return;
      const b = S.lastB; S.com = b.s; S.pos = b.s;
      let n = 0;
      S.log.forEach((m, i) => { if (i >= b.s && i < b.e) { m.com = false; if (m.done && !m.lost) { m.again = true; m.dup = false; n++; } } });
      env.log(`<b>Подтверждение потерялось в сети.</b> Брокер не получил коммит и выдаёт №${b.s}${b.e - b.s > 1 ? '–' + (b.e - 1) : ''} снова — ${n} ${pl(n, 'сообщение', 'сообщения', 'сообщений')}.`, 'warn');
      env.dirty();
    }
    function tick(dt) {
      S.t += dt;
      if (S.sendQ > 0 && S.t >= S.nextSend) { const m = S.gen(); m.off = S.log.length; m.fresh = true; S.log.push(m); S.sendQ--; S.nextSend = S.t + 140; env.dirty(); }
      if (S.ph === 'down') { if (S.t >= S.downTill) restart(); return; }
      if (S.ph === 'idle') { if (S.redo) doRedo(); if (!plan()) return; env.dirty(); }
      if (S.ph === 'run' && S.t - S.stT >= STEP) {
        const s = S.steps[S.si];
        if (S.armed && c.sem !== 'most' && (s.k === 'commit' || s.k === 'txn')) { crash(); return; }
        exec(s); S.si++; S.stT = S.t; env.dirty();
        if (S.armed && c.sem === 'most' && s.k === 'commit') { crash(); return; }
        if (S.si >= S.steps.length) { S.lastB = S.batch; S.batch = null; S.ph = 'idle'; }
      }
    }
    /* ---------- картинка ---------- */
    const stepTxt = (s, biz) => s.k === 'take' ? (s.ms.length > 1 ? `взял пачку №${s.ms[0].off}–${s.ms[s.ms.length - 1].off}` : `взял №${s.ms[0].off} — заказ ${s.ms[0].id}, «${ST[s.ms[0].st]}»`)
      : s.k === 'check' ? `inbox: ${mkey(s.m)} — ${s.res == null ? 'уже был?' : s.res ? 'уже был, пропускаю' : 'нет, делаю'}`
      : s.k === 'eff' ? `письмо «${MAIL[s.m.st]}» по заказу ${s.m.id}${s.res === 'dup' ? ' — второй раз!' : s.res === 'skip' ? ' — пропущено' : ''}`
      : s.k === 'txn' ? `транзакция Kafka: результат в топик + offset → ${s.e}` : `коммит offset → ${s.e}${biz ? ' («досюда сделал»)' : ''}`;
    function steps(biz) {
      if (S.ph === 'down') return `<p class="xmd-crash">✕ Упал. Перезапуск через ${msec(Math.max(0, S.downTill - S.t))}.</p>`;
      if (!S.steps.length) return `<p class="xmd-muted">${S.pos >= S.log.length ? 'Ждёт новых сообщений.' : 'Берёт следующую пачку…'}</p>`;
      const from = Math.max(0, Math.min(S.si - 3, S.steps.length - 8));
      return `<ol class="xmd-steps">${S.steps.slice(from, from + 8).map((s, i) => { const j = from + i, cl = j < S.si ? (s.res === 'dup' ? ' did warn' : s.res === 'skip' || s.res === true ? ' did ok' : ' did') : j === S.si ? ' on' : ''; return `<li class="xmd-step${cl}${(s.k === 'commit' || s.k === 'txn') ? ' is-c' : ''}">${esc(stepTxt(s, biz))}</li>`; }).join('')}</ol>`;
    }
    function log() {
      const from = Math.max(0, S.log.length - 12);
      let h = from ? `<em class="xmd-more">…${from} раньше</em>` : '';
      for (let i = from; i <= S.log.length; i++) {
        if (i === S.com) h += `<span class="xmd-mark" title="Offset группы: следующее непрочитанное — №${S.com}"></span>`;
        if (i < S.log.length) h += cell(S.log[i], mstate(S.log[i]), i);
      }
      return h;
    }
    function mail(biz) {
      const lost = S.log.filter(m => m.lost).slice(-4);
      const li = S.mail.slice(-7).map(e => `<li class="${e.n > 1 ? 'warn' : ''}"><b style="--c:${kc(e.m.id - 1001)}">${e.m.id}</b>${MAIL[e.m.st]}${e.n > 1 ? `<em>× ${e.n} — дубль</em>` : ''}</li>`).join('') + lost.map(m => `<li class="bad"><b style="--c:${kc(m.id - 1001)}">${m.id}</b>${MAIL[m.st]}<em>не отправлено — потеряно</em></li>`).join('');
      return li ? `<ul class="xmd-mail">${li}</ul>` : '<p class="xmd-muted">Писем пока нет.</p>';
    }
    const order = () => c.sem === 'most' ? '<b>коммит → письмо</b>' : c.sem === 'exactly' ? '<b>письмо → транзакция (результат + offset)</b>' : '<b>письмо → коммит</b>';
    function say(biz) {
      const e = S.ev;
      let h = c.sem === 'most' ? `<b>At-most-once: сначала коммит, потом письмо.</b> Упал между ними — сообщение уже отмечено прочитанным и потеряно. Дублей не бывает, потери — бывают${e.lost ? `: уже ${e.lost}` : ''}.`
        : c.sem === 'exactly' ? `<b>Exactly-once: результат в Kafka и offset — одна транзакция.</b> Но письмо уходит наружу, транзакция его не отзовёт: упал до коммита — письмо уйдёт ещё раз${c.dedup ? ', если бы не inbox' : ''}.`
          : `<b>At-least-once: сначала письмо, потом коммит.</b> Упал между ними — брокер выдаст сообщение снова: потерь нет, зато дубль${c.dedup ? ' — его отсекает inbox' : ''}.`;
      if (c.batch > 1) h += ` Коммит раз в пачку из ${c.batch}: при сбое повторится вся пачка.`;
      h += c.dedup ? ` <b>Inbox включён:</b> ключ «заказ:статус» записан — второй раз письмо не уходит (пропущено: ${e.skip}).` : ` Inbox выключен — повтор = второе письмо (дублей: ${e.dup}).`;
      return h;
    }
    function biz() {
      const a = AS(), per = a.ticket * a.ticketRub, e = S.ev;
      return {
        an: 'Курьер расписывается в журнале «доставлено». Расписался до вручения и попал в пробку — заказ потерян. Расписался после, но журнал не дошёл до склада — посылку привезут второй раз.',
        k: [['Письма дважды', String(e.dup), e.dup ? 'warn' : 'ok', e.dup ? `≈ ${rub(e.dup * per)} на поддержку: ${pct(a.ticket)} получивших дубль пишут, обращение — ${rub(a.ticketRub)}` : c.dedup ? 'inbox отсекает повторы' : 'пока без сбоев — урони обработчика'],
          ['Письма потеряны', String(e.lost), e.lost ? 'bad' : 'ok', e.lost ? `покупатель не узнал о заказе: ≈ ${rub(e.lost * per)} на поддержку, а заказ на ${rub(a.check)} под угрозой` : c.sem === 'most' ? 'потеряются при сбое между коммитом и письмом' : 'при at-least-once не теряются'],
          ['Один сбой обработчика', c.sem === 'most' ? `до ${c.batch} ${pl(c.batch, 'потери', 'потерь', 'потерь')}` : c.dedup ? 'без последствий' : `до ${c.batch} ${pl(c.batch, 'дубля', 'дублей', 'дублей')}`, c.sem === 'most' ? 'bad' : c.dedup ? 'ok' : 'warn', c.sem === 'most' ? 'всё, что взяли после коммита, но не успели отправить' : c.dedup ? 'повтор доставки пропускается по ключу заказ + статус' : `всё после последнего коммита придёт снова — до ≈ ${rub(c.batch * per)}`]],
        asm: ['ticket', 'chk', 'model']
      };
    }
    return {
      reset, tick,
      sig: () => bsig(c),
      top: bizOn => (bizOn
        ? life('Как <b>курьер и журнал доставки</b>: расписался «доставлено» до вручения и попал в пробку — посылка потеряна. Расписался после, но журнал не дошёл до склада — привезут второй раз.', 'Режим доставки решает, что хуже для магазина при сбое: пропавшее письмо или письмо дважды. Защита от дублей — журнал отправленных писем (inbox).', true)
        : life('Как <b>отметка в журнале почтальона</b>: можно расписаться «доставлено» до того, как отдал письмо, или после. Упал по дороге — в первом случае письмо пропадёт, во втором его принесут ещё раз.', `Сейчас порядок: ${order()}. <b>At-most-once</b> — коммит offset до обработки: сбой → потеря. <b>At-least-once</b> — после: сбой → повтор и <b>дубль</b>. <b>Идемпотентность</b> — обработчик помнит ключ «заказ:статус» в таблице inbox и второй раз ничего не делает.`)) + bchips(c, null),
      ctl: () => `<div class="xmd-grp">${btn('send', 'Отправить 10 сообщений', { pri: 1 })}${btn('crash', S.armed ? 'Упадёт в опасном месте…' : 'Уронить обработчика', { dis: S.armed || S.ph === 'down', tip: 'Сбой в самом опасном месте: между письмом и коммитом' })}${btn('redo', 'Повторить доставку', { tip: 'Коммит не дошёл до брокера — он выдаст пачку снова' })}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a === 'send') { S.sendQ += 10; env.log('<b>Отправлено 10 сообщений.</b>'); return false; }
        if (a === 'crash') { S.armed = true; if (S.ph === 'idle' && S.pos >= S.log.length) S.sendQ += 3; env.log(`<b>Сбой взведён:</b> обработчик упадёт ${c.sem === 'most' ? 'сразу после коммита, до писем' : 'после писем, до коммита'}.`); return true; }
        if (a === 'redo') {
          if (c.sem === 'most') { env.log('<b>При at-most-once повторной доставки нет:</b> offset сдвинут до обработки, брокер считает всё прочитанным.'); return false; }
          if (!S.lastB) { env.log('Повторять пока нечего — дождись первой обработанной пачки.'); return false; }
          if (S.ph === 'idle') doRedo(); else { S.redo = true; env.log('Повтор доставки — сразу после текущей пачки.'); }
          return false;
        }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'semantics') return { most: 'На данных: коммит до письма — урони обработчика и увидишь потерю.', least: 'На данных: письмо до коммита — урони обработчика и увидишь дубль.', exactly: 'На данных: транзакция Kafka не отзовёт письмо — дубль останется без inbox.' }[v] || '';
        if (k === 'dedup') return v ? 'На данных: inbox включён — повтор того же «заказ:статус» будет пропущен.' : 'На данных: inbox выключен — повтор станет вторым письмом.';
        if (k === 'batch') return `На данных: коммит раз в ${v} — при сбое повторится до ${v} ${pl(+v, 'сообщения', 'сообщений', 'сообщений')}.`;
        return '';
      },
      stage: bizOn => box(bizOn ? 'Журнал заказов: отмечено «досюда сделано»' : 'Партиция: offset группы', `<p class="xmd-offl">${bizOn ? 'Отмечено «сделано» до' : 'Offset группы'} <b>${S.com}</b> — черта; ${bizOn ? 'обработчик читает' : 'читает'} №${Math.min(S.pos, S.log.length)}, конец журнала — ${S.log.length}.</p><div class="xmd-cells xmd-log">${log()}</div>`)
        + `<div class="xmd-two">${box(bizOn ? 'Что делает обработчик' : `Обработчик · ${SEMN[c.sem]}${c.batch > 1 ? ` · пачка ${c.batch}` : ''}`, steps(bizOn))}${box(bizOn ? 'Почтовый ящик покупателей' : 'Письма, которые ушли', mail(bizOn))}</div>`
        + (c.dedup ? box('Inbox — журнал сделанного (заказ:статус)', `<div class="xmd-keys">${S.inbox.slice(-12).map(k => `<code>${esc(k)}</code>`).join('') || '<em class="xmd-muted">пусто</em>'}</div>`) : '')
        + `<div class="xmd-sts">${stat('Писем ушло', String(S.ev.sent))}${stat('Дубли', String(S.ev.dup), S.ev.dup ? 'warn' : 'ok')}${stat('Потеряно', String(S.ev.lost), S.ev.lost ? 'bad' : 'ok')}${stat('Пропущено inbox', String(S.ev.skip), S.ev.skip ? 'ok' : '')}</div>`,
      say, biz
    };
  };

  /* =====================================================================================================
     Брокер: хранение (retention) и DLQ
     ===================================================================================================== */
  V['data-keep'] = env => {
    let c, D, R;
    const WK = 520, PAUSE = [800, 1600], RET = 7, SQSRET = 4;
    const LOG = () => c.kf || !!c.eng.replay;   // журнал (Kafka, NATS JetStream, Redis Streams): подтверждение не удаляет, старое убирают лимиты
    const PQ = () => c.kf ? 'партиция' : 'очередь';
    function resetD() {
      const g = stream(3), ms = [];
      for (let i = 0; i < 12; i++) ms.push(g());
      const poi = ms.find((m, i) => m.st === 1 && ms.slice(i + 1).some(x => x.id === m.id)) || ms[3];
      poi.poi = true;
      ms.forEach((m, i) => { m.off = i; });
      D = { t: 0, q: ms, pos: 0, busy: null, retry: [], dlq: [], loops: 0, viol: null, poi, fixed: false };
    }
    function resetR() {
      const g = stream(9);
      R = { day: 6, msgs: [], start: 0, g, letters: 0, ana: 0, anaRun: false, lost: 0, purged: 0 };
      for (let d = 1; d <= 6; d++) addDay(d);
      R.letters = R.msgs.length; R.ana = 6;
      if (!LOG()) purge();
    }
    function addDay(d) { for (let i = 0; i < 3; i++) { const m = R.g(); m.day = d; m.off = R.msgs.length; m.fresh = d > 6; R.msgs.push(m); } }
    function purge() {
      if (LOG()) {   // журнал: старше срока — удаляется, прочитано или нет
        const lim = R.day - RET; let st = R.start;
        while (st < R.msgs.length && R.msgs[st].day <= lim) st++;
        if (st > R.start) { R.purged += st - R.start; R.start = st; }
        if (R.ana < R.start && !R.anaRun) { /* аналитика ещё не знает, что потеряла */ }
      } else {      // очередь: подтверждённое удаляется сразу; неподтверждённое — по сроку очереди
        const lim = c.engId === 'sqs' || c.engId === 'sqsfifo' ? R.day - SQSRET : -1e9;
        R.msgs.forEach(m => { if (m.off < R.letters) m.gone = 'ack'; });
        R.msgs.forEach(m => { if (!m.gone2 && m.day <= lim && m.off >= R.ana) { m.gone2 = true; R.lost++; } });
      }
    }
    function reset() { c = env.cfg(); resetD(); resetR(); }
    function tick(dt) {
      D.t += dt;
      const t = D.t;
      if (D.busy && t >= D.busy.end) {
        const m = D.busy.m; D.busy = null; m.fly = false;
        if (m.poi && !D.fixed) {
          if (c.retries) { m.tries = 1; D.retry.push({ m, at: t + PAUSE[0] }); D.pos++; env.log(`<b>№${m.off} упало.</b> Ушло на повтор через ${msec(PAUSE[0])}, ${PQ()} едет дальше.`, 'warn'); }
          else if (c.sem === 'most') { m.lost = true; D.pos++; env.log(`<b>№${m.off} упало и потеряно:</b> at-most-once уже отметил его прочитанным.`, 'bad'); }
          else { D.loops++; if (D.loops === 1) env.log(`<b>№${m.off} упало.</b> Без DLQ его читают снова и снова — за ним стоит вся ${PQ()}.`, 'bad'); }
        } else {
          m.done = true; m.com = true; D.pos++;
          if (D.poi.id === m.id && m.st > D.poi.st && !D.poi.done && !D.viol) { m.bad = true; D.viol = m; env.log(`<b>Порядок нарушен:</b> заказ ${m.id} — «${ST[m.st]}» обработан, а «${ST[D.poi.st]}» ${D.poi.dlq ? 'лежит в DLQ' : 'ждёт повтора'}.`, 'warn'); }
        }
        env.dirty();
      }
      if (!D.busy && D.pos < D.q.length) { const m = D.q[D.pos]; m.fly = true; D.busy = { m, end: t + (m.poi && !c.retries && D.loops ? 620 : WK) }; env.dirty(); }
      D.retry.forEach(r => {
        if (r.busy && t >= r.busy) {
          r.busy = 0; r.m.tries++;
          if (r.m.tries >= 3) { r.m.dlq = true; r.done = true; D.dlq.push(r.m); env.log(`<b>№${r.m.off} — 3 попытки, все упали.</b> Ушло в DLQ с причиной «адрес доставки пустой».`, 'warn'); }
          else r.at = t + PAUSE[Math.min(PAUSE.length - 1, r.m.tries - 1)];
          env.dirty();
        } else if (!r.busy && !r.done && t >= r.at) { r.busy = t + 400; env.dirty(); }
      });
      D.retry = D.retry.filter(r => !r.done);
    }
    function newDay(n) {
      for (let i = 0; i < n; i++) { R.day++; addDay(R.day); R.letters = R.msgs.length; if (R.anaRun) R.ana = R.msgs.length; purge(); }
    }
    function anaOn() {
      if (LOG() && R.ana < R.start) { R.lost += R.start - R.ana; env.log(`<b>Аналитика включилась:</b> её offset ${R.ana} уже удалён по сроку хранения. Начнёт с самого старого из оставшихся (auto.offset.reset = earliest) — ${R.start - R.ana} ${pl(R.start - R.ana, 'событие пропущено', 'события пропущены', 'событий пропущено')} навсегда.`, 'bad'); }
      R.ana = R.msgs.length; R.anaRun = true;
    }
    /* ---------- картинка ---------- */
    function dlqBox(biz) {
      const from = Math.max(0, D.pos - 6), cells = D.q.slice(from, from + 12).map(m => cell(m, mstate(m), m.off)).join('');
      const stuck = !c.retries && c.sem !== 'most' && D.loops > 0;
      const rt = D.retry.map(r => `<li>${cell(r.m, 'is-poi')}<span>попытка ${r.m.tries + (r.busy ? 1 : 0)} из 3 · ${r.busy ? 'пробуем…' : `пауза ещё ${msec(Math.max(0, r.at - D.t))}`}</span></li>`).join('');
      const dl = D.dlq.map(m => `<li>${cell(m, 'is-bad')}<span>3 попытки · «адрес доставки пустой»</span></li>`).join('');
      return `<div class="xmd-lane"><div class="xmd-ll"><b>${c.kf ? 'P0' : 'Очередь'}</b><small class="${stuck ? 'bad' : ''}">${stuck ? `стоит: ${D.loops} ${pl(D.loops, 'повтор', 'повтора', 'повторов')}` : 'едет'}</small><small>ждут: ${D.q.length - D.pos}</small></div><div class="xmd-cells">${cells}</div></div>`
        + `<div class="xmd-two"><div><b class="xmd-sub">Повтор с паузой</b>${rt ? `<ul class="xmd-rl">${rt}</ul>` : `<p class="xmd-muted">${c.retries ? 'пусто' : 'выключено: «Повторы + DLQ» у брокера'}</p>`}</div><div><b class="xmd-sub">DLQ — «до востребования»</b>${dl ? `<ul class="xmd-rl">${dl}</ul>` : `<p class="xmd-muted">${c.retries ? 'пусто' : 'DLQ нет'}</p>`}${D.dlq.length && !D.fixed ? btn('fix', 'Починить адрес и отправить снова') : ''}</div></div>`;
    }
    function retBox(biz) {
      const days = []; for (let d = Math.max(1, R.day - 9); d <= R.day; d++) days.push(d);
      const cols = days.map(d => {
        const ms = R.msgs.filter(m => m.day === d), del = LOG() ? ms.length && ms[0].off < R.start : false;
        return `<div class="xmd-day${del ? ' is-del' : ''}"><b>день ${d}</b>${ms.map(m => { const g = LOG() ? m.off < R.start : m.gone2 || (m.gone && m.off < R.ana); const unread = m.off >= R.ana; return g ? `<span class="xmd-ghost" title="удалено">${m.id}</span>` : cell(m, unread ? 'is-wait' : 'is-com'); }).join('')}${del ? '<small>удалено по сроку</small>' : ''}</div>`;
      }).join('');
      const anaLost = LOG() && !R.anaRun && R.ana < R.start ? R.start - R.ana : 0;
      return `<div class="xmd-days">${cols}</div><div class="xmd-grps"><span class="xmd-chip ok"><small>группа «Письма»</small><b>offset ${R.letters} — всё прочитано</b></span><span class="xmd-chip ${anaLost ? 'bad' : R.anaRun ? 'ok' : 'warn'}"><small>группа «Аналитика»</small><b>${R.anaRun ? `offset ${R.ana} — читает` : `стоит на offset ${R.ana}`}${anaLost ? ` · ${anaLost} уже удалены` : ''}</b></span></div>`;
    }
    function say(biz) {
      let h;
      if (c.retries) h = `<b>Повторы с паузой и DLQ.</b> Битое сообщение не держит ${c.kf ? 'партицию' : 'очередь'}: ушло на повтор, после трёх попыток — в DLQ с причиной. ${D.viol ? `Но заказ ${D.viol.id}: «${ST[D.viol.st]}» обработан раньше «${ST[D.poi.st]}» — для упорядоченных потоков в DLQ паркуют все следующие события этого ключа.` : ''}`;
      else if (c.sem === 'most') h = `<b>DLQ выключен, at-most-once:</b> упавшее сообщение просто теряется — ${PQ()} свободна, данные пропали молча.`;
      else if (c.kf) h = `<b>DLQ выключен — партиция встала.</b> Битое сообщение читается по кругу, коммита нет, а за ним ждут ${D.q.length - D.pos - 1}. Включи «Повторы + DLQ» у брокера.`;
      else h = '<b>DLQ выключен — сообщение крутится по кругу:</b> брокер возвращает его в начало очереди, и его тут же берут снова. Включи «Повторы + DLQ».';
      h += c.kf ? ` <b>Хранение:</b> Kafka держит журнал ${RET} дней и удаляет старое, даже если его никто не прочитал (retention.ms; у узла на площадке такой настройки нет, взят срок по умолчанию).`
        : c.eng.replay ? ` <b>Хранение:</b> ${esc(c.eng.name)} — тоже журнал: подтверждение не удаляет сообщение, старое убирают лимиты потока (Redis — MAXLEN, NATS — max_age). На картинке — те же ${RET} дней, что у Kafka по умолчанию.${c.engId === 'redis' ? ' Redis держит поток в памяти: упадёт узел — пропадут последние сообщения.' : ''}`
        : c.engId === 'sqs' || c.engId === 'sqsfifo' ? ` <b>Хранение:</b> подтверждённое удаляется сразу; неподтверждённое SQS держит ${SQSRET} дня по умолчанию (максимум 14) и тоже удаляет.`
          : ' <b>Хранение:</b> подтверждённое сообщение удаляется сразу — перечитать историю нельзя. Второму получателю нужна своя очередь (fanout).';
      return h;
    }
    function biz() {
      const S0 = shop(), a = AS(), stuck = !c.retries && c.sem !== 'most' && D.loops > 0, lostD = D.q.filter(m => m.lost).length;
      const k = [];
      if (stuck) k.push(['Партиция встала', `≈ ${orders(S0.ordersH / (c.kf ? c.P : 1))} в час`, 'bad', `столько заказов в час пик попадает в эту ${c.kf ? 'партицию' : 'очередь'} — их письма не уйдут, пока битое сообщение не уберут руками`]);
      else if (c.retries) k.push(['Битое сообщение', D.dlq.length ? 'в DLQ' : 'на повторе', 'ok', 'один заказ ждёт ручного разбора, остальные письма идут вовремя']);
      else k.push(['Битое сообщение', lostD ? 'потеряно' : '…', lostD ? 'bad' : '', `покупатель не получил письмо: ${pct(a.ticket)} напишут в поддержку, ${rub(a.ticketRub)} за обращение`]);
      if (D.viol) k.push(['Письма вразнобой', `заказ ${D.viol.id}`, 'warn', `«${MAIL[D.viol.st]}» ушло раньше «${MAIL[D.poi.st]}» — ≈ ${rub(a.ticket * a.ticketRub)} на поддержку за такой заказ`]);
      if (LOG()) k.push(['Аналитика стояла дольше 7 дней', R.lost ? `−${R.lost} событий` : 'пока ничего', R.lost ? 'bad' : 'ok', R.lost ? 'дыра в отчётах: этих заказов нет в цифрах, и перечитать их неоткуда' : `журнал хранится ${RET} дней: успеет догнать — ничего не потеряет`]);
      else k.push(['Перечитать историю', 'нельзя', 'warn', 'подтверждённые письма удалены: новому сервису (аналитике) прошлых событий не достанется']);
      return { an: 'Почтовое отделение: письмо, которое никак не вручить, после трёх попыток кладут на полку «до востребования», а не носят по кругу. И почту там хранят 7 дней: кто не забрал — тот не получит.', k, asm: ['shop', 'ticket', 'model'] };
    }
    return {
      reset, tick,
      sig: () => bsig(c),
      top: bizOn => (bizOn
        ? life('Как <b>почтовое отделение</b>: письмо, которое никак не вручить, после трёх попыток кладут на полку «до востребования», а не носят по кругу. И почту хранят ограниченный срок: кто не забрал — тот не получит.', 'Одно битое письмо не должно останавливать все остальные. А отчёты, которые долго не забирали данные, могут их не досчитаться.', true)
        : life('Как <b>почтовое отделение</b>: письмо, которое никак не вручить, после трёх попыток кладут на полку «до востребования», а не носят по кругу. И само отделение хранит почту ограниченный срок: кто не забрал — тот не получит.', '<b>DLQ</b> (Dead Letter Queue) — отдельная очередь для сообщений, которые не обработались за N попыток. <b>Повтор с паузой</b> отличает временный сбой от битых данных. <b>Retention</b> — срок хранения журнала: в Kafka удаление не зависит от того, прочитано ли сообщение.')) + bchips(c, null),
      ctl: () => `<div class="xmd-grp">${btn('poison', 'Отправить 10 сообщений (одно битое)', { pri: 1 })}${btn('day', '+1 день')}${btn('week', '+7 дней')}${btn('ana', 'Включить аналитику', { dis: R.anaRun })}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a === 'poison') { resetD(); env.log('<b>Новая пачка:</b> одно сообщение с пустым адресом — оно не обработается никогда.'); return true; }
        if (a === 'day' || a === 'week') { const n = a === 'day' ? 1 : 7, before = R.purged; newDay(n); const del = R.purged - before; env.log(`<b>Прошло ${n} ${pl(n, 'день', 'дня', 'дней')}.</b> ${LOG() ? (del ? `По сроку удалено ${del} ${pl(del, 'сообщение', 'сообщения', 'сообщений')} — прочитанные и нет.` : 'Срок хранения ещё не вышел.') : 'Подтверждённые удалены сразу после чтения.'}`); return true; }
        if (a === 'ana') { anaOn(); return true; }
        if (a === 'fix') { D.fixed = true; const m = D.dlq.shift(); if (m) { m.dlq = false; m.done = true; m.com = true; m.poi = false; env.log(`<b>№${m.off} починили и отправили из DLQ.</b> Обработано — но позже следующих событий своего заказа.`, 'warn'); } return true; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'retries') return v ? 'На данных: битое сообщение уйдёт на повтор, после 3 попыток — в DLQ, партиция не встанет.' : 'На данных: без DLQ битое сообщение остановит партицию (или потеряется при at-most-once).';
        if (k === 'semantics') return v === 'most' ? 'На данных: при at-most-once упавшее сообщение просто потеряется.' : '';
        return '';
      },
      stage: bizOn => box(bizOn ? 'Битое письмо: повтор и полка «до востребования»' : 'DLQ на конкретных сообщениях', dlqBox(bizOn))
        + box(bizOn ? `Сколько хранится почта${LOG() ? ` — ${RET} дней` : ''}` : (LOG() ? `Хранение журнала: ${c.kf ? 'retention' : 'лимит потока'} ${RET} дней` : 'Хранение: подтверждённое удаляется'), retBox(bizOn)),
      say, biz
    };
  };

  /* =====================================================================================================
     NoSQL: общие данные — та же таблица заказов: документы или широкие строки
     ===================================================================================================== */
  const NST = ['создан', 'оплачен', 'собран', 'отправлен', 'доставлен'];
  function mkOrder(id) {
    const i = id - 1001, day = Math.min(14, 1 + Math.floor(i * 14 / 36));
    return { id, u: userOf(id), day, hh: 9 + (id * 7) % 12, mm: (id * 13) % 60, st: day <= 9 ? 4 : day <= 11 ? 3 : day === 12 ? 2 : day === 13 ? 1 : 0, sum: 900 + ((id * 37) % 41) * 100 };
  }
  const ORD0 = Array.from({ length: 36 }, (_, i) => mkOrder(1001 + i));
  const p2 = n => String(n).padStart(2, '0');
  const dstr = o => `${p2(o.day)}.10 ${p2(o.hh)}:${p2(o.mm)}`;
  const tsOf = o => o.day * 1440 + o.hh * 60 + o.mm;
  const VN = 8;   // виртуальных узлов на узел; токены узла i не зависят от числа узлов — новый узел только добавляет свои
  function ringOf(N) { const toks = []; for (let i = 0; i < N; i++) for (let v = 0; v < VN; v++) toks.push({ p: fnv(`узел ${i} / участок ${v}`), node: i }); toks.sort((a, b) => a.p - b.p); return toks; }
  const ownerIdx = (toks, p) => { for (let k = 0; k < toks.length; k++) if (toks[k].p >= p) return k; return 0; };
  function replicas(toks, p, rf) { const out = [], k0 = ownerIdx(toks, p); for (let j = 0; j < toks.length && out.length < rf; j++) { const nd = toks[(k0 + j) % toks.length].node; if (!out.includes(nd)) out.push(nd); } return out; }
  const NN = i => 'У' + (i + 1);
  const CLN = { one: 'ONE', quorum: 'QUORUM', all: 'ALL' };
  const MODN = { wide: 'wide-column', doc: 'документы', kv: 'ключ-значение' };
  function ncfg(ctx) {
    const p = nodeNow(ctx).props, N = clamp(+p.count || 3, 1, 20), RF = Math.min(N, +p.rf === 1 ? 1 : 3), CL = p.cl || 'quorum';
    return { N, RF, CL, need: CL === 'one' ? 1 : CL === 'all' ? RF : Math.floor(RF / 2) + 1, gsi: !!p.gsi, model: p.model || 'wide', rfSet: +p.rf === 1 ? 1 : 3 };
  }
  const nsig = c => [c.N, c.RF, c.CL, c.gsi, c.model].join('|');
  const nchips = (c, more) => chipRow([['модель', MODN[c.model] || c.model, ''], ['узлов', String(c.N), ''], ['копий (RF)', String(c.RF) + (c.RF < c.rfSet ? ` из ${c.rfSet}` : ''), c.RF === 1 ? 'warn' : ''], ['согласованность', CLN[c.CL], c.CL === 'one' ? 'warn' : ''], ['индекс', c.gsi ? 'вкл.' : 'выкл.', c.gsi ? 'ok' : '']].concat(more || []));
  const PK = {
    user: { name: 'user_id', key: o => 'user:' + o.u, label: o => 'user_id = ' + o.u },
    order: { name: 'order_id', key: o => 'order:' + o.id, label: o => 'order_id = ' + o.id },
    day: { name: 'дата заказа', key: o => 'day:' + o.day, label: o => 'дата = ' + p2(o.day) + '.10' }
  };
  function groupBy(ords, kf, lf, toks, rf) {
    const map = new Map();
    ords.forEach(o => { const k = kf(o); let p = map.get(k); if (!p) { p = { k, label: lf(o), rows: [], tok: fnv(k) }; map.set(k, p); } p.rows.push(o); });
    return [...map.values()].map(p => { p.rows.sort((a, b) => tsOf(b) - tsOf(a)); p.reps = replicas(toks, p.tok, rf); return p; });
  }
  const ocell = (o, cls, txt) => `<span class="xmd-cell ${cls || ''}" style="--c:${kc(o.u - 501)}" title="${esc(`заказ ${o.id}, покупатель ${o.u}, ${dstr(o)}, «${NST[o.st]}», ${dec(o.sum, 0)} ₽`)}"><b>${o.id}</b><small>${txt || o.u}</small></span>`;

  /* ---------- NoSQL: ключ партиции → узлы на кольце, горячий ключ ---------- */
  V['data-ring'] = env => {
    const H = env.H;
    let c, S;
    const ROUTE2 = 420, SHOWT = 9;
    function build() {
      S.toks = ringOf(c.N);
      S.parts = groupBy(S.ords, PK[H.pk].key, PK[H.pk].label, S.toks, c.RF);
    }
    function reset(moved) {
      const hot = S ? S.hot : false;
      c = env.cfg();
      S = { t: 0, ords: ORD0.slice(), todo: [], cur: null, last: null, hot, moved: moved || null, nextId: 1037, next: 0 };
      build();
    }
    function loads() {
      const n503 = S.ords.filter(o => o.u === 503).length, tot = S.ords.length;
      const sh = o => S.hot ? (o.u === 503 ? 0.7 / Math.max(1, n503) : 0.3 / Math.max(1, tot - n503)) : 1 / tot;
      const L = Array.from({ length: c.N }, () => ({ rows: 0, q: 0 }));
      S.parts.forEach(p => { p.q = p.rows.reduce((s, o) => s + sh(o), 0); p.reps.forEach(i => { L[i].rows += p.rows.length; L[i].q += p.q; }); });
      return L;
    }
    function tick(dt) {
      S.t += dt;
      if (!S.cur && S.todo.length && S.t >= S.next) { S.cur = { o: S.todo.shift(), t0: S.t, ph: 0 }; env.dirty(); }
      if (S.cur) {
        const f = (S.t - S.cur.t0) / ROUTE2, ph = f < 0.34 ? 0 : f < 0.67 ? 1 : 2;
        if (ph !== S.cur.ph) { S.cur.ph = ph; env.dirty(); }
        if (f >= 1) { S.ords.push(S.cur.o); build(); S.last = S.cur; S.cur = null; S.next = S.t + 80; env.dirty(); }
      }
    }
    function svg() {
      const cx = 150, cy = 150, R1 = 112, R2 = 84, ang = p => -Math.PI / 2 + p * 2 * Math.PI, pt = (p, r) => [cx + r * Math.cos(ang(p)), cy + r * Math.sin(ang(p))];
      const f = v => v.toFixed(1);
      let h = `<svg class="xmd-ring" viewBox="0 0 300 300" role="img" aria-label="Кольцо токенов: ${c.N} ${pl(c.N, 'узел', 'узла', 'узлов')}, ${S.parts.length} ${pl(S.parts.length, 'партиция', 'партиции', 'партиций')}"><circle class="xmd-rbase" cx="${cx}" cy="${cy}" r="${R1}"/>`;
      const T = S.toks, x = S.cur || S.last, reps = x ? replicas(T, fnv(PK[H.pk].key(x.o)), c.RF) : [];
      T.forEach((t, k) => {
        let a0 = T[(k - 1 + T.length) % T.length].p; const a1 = t.p; if (k === 0) a0 -= 1;
        const g = 0.004, [x0, y0] = pt(a0 + g, R1), [x1, y1] = pt(a1 - g, R1);
        h += `<path class="xmd-arc${reps.includes(t.node) ? ' on' : ''}" style="stroke:${kc(t.node)}" d="M${f(x0)} ${f(y0)} A${R1} ${R1} 0 ${a1 - a0 > 0.5 ? 1 : 0} 1 ${f(x1)} ${f(y1)}"/>`;
      });
      if (c.N <= 10) for (let i = 0; i < c.N; i++) {   // подпись узла — у его самого длинного участка
        let best = null;
        T.forEach((t, k) => { if (t.node !== i) return; let a0 = T[(k - 1 + T.length) % T.length].p; if (k === 0) a0 -= 1; if (!best || t.p - a0 > best.l) best = { l: t.p - a0, m: (a0 + t.p) / 2 }; });
        if (best) { const [lx, ly] = pt(best.m, R1 + 24); h += `<text class="xmd-rt${reps.includes(i) ? ' on' : ''}" x="${f(lx)}" y="${f(ly + 4)}" text-anchor="middle">${NN(i)}</text>`; }
      }
      const few = S.parts.length <= 10;
      let prevTok = -1, alt = false;   // близкие точки — подписи попеременно ближе и дальше от центра, чтобы не налезали
      S.parts.slice().sort((a2, b2) => a2.tok - b2.tok).forEach(p => {
        const [px, py] = pt(p.tok, R2), cur = x && PK[H.pk].key(x.o) === p.k;
        h += `<circle class="xmd-pdot${cur ? ' on' : ''}${S.hot && H.pk === 'user' && p.k === 'user:503' ? ' hot' : ''}" cx="${f(px)}" cy="${f(py)}" r="${cur ? 7 : 4.5}"/>`;
        alt = p.tok - prevTok < 0.05 ? !alt : false; prevTok = p.tok;
        if (few) { const [tx, ty] = pt(p.tok, R2 - (alt ? 40 : 20)); h += `<text class="xmd-rt sm" x="${f(tx)}" y="${f(ty + 4)}" text-anchor="middle">${esc(p.k.split(':')[1])}</text>`; }
      });
      return h + `<text class="xmd-rt c" x="${cx}" y="${cy - 2}" text-anchor="middle">кольцо</text><text class="xmd-rt c sm" x="${cx}" y="${cy + 16}" text-anchor="middle">0…1000</text></svg>`;
    }
    function calc(biz) {
      const x = S.cur || S.last;
      if (!x) return `<p class="xmd-muted">Нажми «Записать 10 заказов» — каждый пройдёт путь «ключ → точка на кольце → узлы».</p>`;
      const o = x.o, k = PK[H.pk].key(o), tk = fnv(k), reps = replicas(S.toks, tk, c.RF), ph = S.cur ? S.cur.ph : 3, on = i => ph === i ? ' on' : ph > i ? ' did' : '';
      return `<p class="xmd-msg">${ocell(o, S.cur ? 'is-fly' : 'is-wait')}<span>заказ ${o.id}, покупатель ${o.u}, ${dstr(o)}</span></p><ol class="xmd-steps"><li class="xmd-step${on(0)}">ключ партиции = ${PK[H.pk].name} → <code>${esc(k)}</code></li><li class="xmd-step${on(1)}">hash(ключ) → точка <b>${Math.floor(tk * 1000)}</b> из 1000 на кольце <small>в Cassandra — Murmur3</small></li><li class="xmd-step${on(2)}">участок узла <b>${NN(reps[0])}</b>${c.RF > 1 ? `, копии — следующие по кругу: <b>${reps.slice(1).map(NN).join(', ')}</b>` : ', копий нет (RF = 1)'}</li></ol>`;
    }
    function nodes(biz) {
      const L = loads(), ideal = c.RF / c.N, mx = Math.max(...L.map(l => l.q), 1e-9), x = S.cur || S.last, reps = x ? replicas(S.toks, fnv(PK[H.pk].key(x.o)), c.RF) : [];
      return `<ul class="xmd-nodes">${L.map((l, i) => { const hot = c.N > c.RF && l.q > ideal * 1.4; return `<li class="${hot ? 'bad' : ''}${reps.includes(i) ? ' on' : ''}"><i style="background:${kc(i)}"></i><b>${NN(i)}</b><span class="xmd-bar"><span style="width:${(l.q / mx * 100).toFixed(0)}%"></span></span><small>${l.rows} ${pl(l.rows, 'строка', 'строки', 'строк')} · ${pct(l.q)} ${biz ? 'обращений' : 'запросов'}</small></li>`; }).join('')}</ul><p class="xmd-muted">Ровно было бы ${pct(Math.min(1, ideal))} на узел: каждый запрос идёт на ${c.RF} ${pl(c.RF, 'копию', 'копии', 'копий')} из ${c.N}.</p>`;
    }
    function table() {
      const mv = S.moved ? new Set(S.moved.keys) : new Set();
      const ps = S.parts.slice().sort((a, b) => b.rows.length - a.rows.length || a.tok - b.tok), sh = ps.slice(0, SHOWT);
      return `<table class="xmd-tbl"><thead><tr><th>ключ партиции</th><th class="r">точка</th><th>узлы</th><th class="r">строк</th></tr></thead><tbody>${sh.map(p => `<tr class="${mv.has(p.k) ? 'moved' : ''}"><td><code>${esc(p.label)}</code>${mv.has(p.k) ? ' <em>переехала</em>' : ''}</td><td class="r">${Math.floor(p.tok * 1000)}</td><td>${p.reps.map(NN).join(', ')}</td><td class="r">${p.rows.length}</td></tr>`).join('')}</tbody></table>${ps.length > SHOWT ? `<p class="xmd-muted">Ещё ${ps.length - SHOWT} ${pl(ps.length - SHOWT, 'партиция', 'партиции', 'партиций')} по 1–2 строки.</p>` : ''}`;
    }
    function hotNode() { const L = loads(); let bi = 0; L.forEach((l, i) => { if (l.q > L[bi].q) bi = i; }); return { i: bi, q: L[bi].q, ideal: Math.min(1, c.RF / c.N) }; }
    function say(biz) {
      const n503 = S.ords.filter(o => o.u === 503).length, hn = hotNode();
      let h = c.N <= c.RF ? `<b>Узлов ${c.N}, копий ${c.RF} — каждый узел хранит всё.</b> Кольцо пока ничего не делит: добавь узлов, чтобы увидеть раскладку. ` : '';
      if (H.pk === 'user') h += `<b>Ключ — user_id:</b> все заказы покупателя — одна партиция на ${c.RF} ${pl(c.RF, 'узле', 'узлах', 'узлах')}. Оптовик 503 — ${n503} из ${S.ords.length} строк: горячий ключ. ${S.hot ? `Его запросы — 70 % всех — бьют в ${replicas(S.toks, fnv('user:503'), c.RF).map(NN).join(', ')}: ${NN(hn.i)} получает ${pct(hn.q)} запросов при ровной доле ${pct(hn.ideal)}. Добавлять узлы бесполезно — партиция не делится; лечат «солью»: ключ (user_id, месяц).` : 'Включи «Час пик у оптовика».'}`;
      else if (H.pk === 'order') h += '<b>Ключ — order_id:</b> каждый заказ — своя партиция, данные и нагрузка делятся ровно, горячих узлов нет. Цена: «все заказы покупателя» лежат по всему кластеру — такой запрос опросит каждый узел (вид «Вторичный индекс»).';
      else h += `<b>Ключ — дата:</b> всё, что пишется сегодня, ложится в одну партицию — она горячая на запись, вчерашние простаивают. ${S.ords.some(o => o.id >= 1037) ? 'Смотри: новые заказы ушли в «14.10».' : 'Нажми «Записать 10 заказов».'}`;
      if (S.moved) h += ` <b>Узлов было ${S.moved.from}, стало ${S.moved.to}:</b> переехали ${S.moved.copies} из ${S.moved.all} ${pl(S.moved.all, 'копии', 'копий', 'копий')} — ${S.moved.to > S.moved.from ? 'новые узлы забрали участки кольца у соседей' : 'участки ушедших узлов достались соседям'}, остальное на месте.`;
      return h;
    }
    function biz() {
      const S0 = shop(), a = AS(), hn = hotNode(), L = loads(), nUsd = unitUsd('nosql', { count: 1 }), skew = c.N > c.RF && hn.q > hn.ideal * 1.4;
      const k = [['Самый загруженный узел', `${NN(hn.i)}: ${pct(hn.q)}`, skew ? 'bad' : 'ok', skew ? `ровно было бы ${pct(hn.ideal)}: тормозит у всех, чьи заказы лежат на этом узле, а +100 мс к ответу стоят ${pct(a.slow)} заказов` : `ровно было бы ${pct(hn.ideal)} — перекоса нет`]];
      if (c.RF >= 2) k.push(['Если узел упадёт', 'покупатели не заметят', 'ok', `копии есть ещё на ${c.RF - 1} ${pl(c.RF - 1, 'узле', 'узлах', 'узлах')}`]);
      else { const sh = Math.max(...L.map(l => l.rows)) / Math.max(1, S.ords.length), o = S0.ordersH * sh; k.push(['Если узел упадёт', '−' + rub(o * a.check * a.restoreH) + ' в час', 'bad', `копий нет: ≈ ${pct(sh)} заказов не откроются и не запишутся ≈ ${a.restoreH} ч — это ≈ ${orders(o)} в час пик`]); }
      k.push(['Ещё один узел', `+${rub(nUsd * a.usdRub)} в мес.`, '', H.pk === 'user' && S.hot ? 'горячую партицию оптовика он не разгрузит — её держат те же узлы' : `переедет ≈ ${pct(1 / (c.N + 1))} данных, нагрузка на узел упадёт`]);
      return { an: 'Камера хранения из шкафов по кругу: номер квитанции говорит, в какой шкаф положить сумку, копии — в соседние. Если половина сумок — одного оптовика, у его шкафов очередь, а остальные пустуют.', k, asm: ['shop', 'chk', 'fail', 'slow', 'usd', 'model'] };
    }
    return {
      reset: () => reset(), tick,
      sig: () => nsig(c) + '|' + H.pk,
      top: bizOn => (bizOn
        ? life('Как <b>камера хранения из шкафов по кругу</b>: по номеру квитанции сразу видно, в какой шкаф положить сумку, а копии кладут ещё в соседние. Если все сдают сумки одному гардеробщику — у него очередь, остальные скучают.', 'От ключа зависит, равномерно ли загружены серверы базы. Перекос — медленно у части покупателей, а новые серверы не помогают.', true)
        : life('Как <b>камера хранения с ячейками по кругу</b>: номер квитанции говорит, в какую ячейку положить сумку, а копии кладут в соседние. Если все сдают сумки одному гардеробщику — у него очередь, остальные скучают.', '<b>Ключ партиции</b> хешируется в точку на <b>кольце</b>; узел, чей участок накрывает точку, и следующие RF − 1 узлов хранят копии. У каждого узла несколько участков (виртуальные узлы). <b>Горячий ключ</b> — партиция, на которую приходится непропорционально много запросов: её не разделить между узлами.')) + nchips(c, [['ключ партиции', PK[H.pk].name, H.pk === 'day' ? 'warn' : '']]),
      ctl: () => seg('Ключ партиции', 'pk', [['user', 'user_id', 'покупатель'], ['order', 'order_id', 'заказ'], ['day', 'дата заказа', 'день']], H.pk) + `<div class="xmd-grp">${btn('write', 'Записать 10 заказов', { pri: 1 })}${btn('hot', S.hot ? 'Обычный день' : 'Час пик у оптовика', { tip: '70 % запросов — заказы покупателя 503' })}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a.startsWith('pk:')) { H.pk = a.slice(3); reset(); env.log(`<b>Ключ партиции: ${PK[H.pk].name}.</b> Те же заказы разложены заново.`); return true; }
        if (a === 'write') { for (let i = 0; i < 10; i++) { const o = mkOrder(S.nextId); o.day = 14; o.st = 0; o.u = USERS[(S.nextId * 3) % USERS.length]; S.nextId++; S.todo.push(o); } env.log('<b>Записываем 10 новых заказов</b> — сегодняшних.'); return false; }
        if (a === 'hot') { S.hot = !S.hot; env.log(S.hot ? '<b>Час пик у оптовика:</b> 70 % запросов — его заказы.' : '<b>Обычный день:</b> запросы ко всем заказам поровну.'); return true; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        const old = new Map(S.parts.map(p => [p.k, p.reps.slice()])), oldN = c.N;
        reset();
        if (k === 'count' || k === 'rf') {
          let copies = 0;
          const keys = S.parts.filter(p => { const o = old.get(p.k); if (!o) return false; const mv = p.reps.filter(i => !o.includes(i)).length; copies += mv; return mv > 0; }).map(p => p.k);
          if (k === 'count') {
            const all = S.parts.length * c.RF;
            S.moved = { from: oldN, to: c.N, keys, of: S.parts.length, copies, all };
            return `На данных: узлов ${oldN} → ${c.N}, переехали ${copies} из ${all} ${pl(all, 'копии', 'копий', 'копий')} (${keys.length} из ${S.parts.length} ${pl(S.parts.length, 'партиции', 'партиций', 'партиций')}) — только участки кольца, которые забрал или отдал узел.`;
          }
          return c.RF === 1 ? 'На данных: копий больше нет — каждая партиция живёт на одном узле.' : `На данных: у каждой партиции ${c.RF} ${pl(c.RF, 'копия', 'копии', 'копий')} — на следующих по кругу узлах.`;
        }
        return '';
      },
      stage: bizOn => `<div class="xmd-two">${box(bizOn ? 'Шкафы по кругу (узлы базы)' : 'Кольцо токенов', svg() + nodes(bizOn), 'xmd-ringbox')}<div class="xmd-col">${box(bizOn ? 'Куда ляжет заказ' : 'Ключ → кольцо → узлы', calc(bizOn))}${box(bizOn ? 'Папки (партиции) и где лежат' : 'Партиции', table())}</div></div>`,
      say, biz
    };
  };

  /* ---------- NoSQL: ключ сортировки и запрос по диапазону против полного перебора ---------- */
  V['data-sort'] = env => {
    const H = env.H;
    let c, S;
    const Q = { range: 'Заказы покупателя 503 за 3–9 октября', last: 'Последние 3 заказа покупателя 503', scan: 'Все заказы за 3–9 октября' };
    const inR = o => o.day >= 3 && o.day <= 9;
    function reset() {
      c = env.cfg();
      const toks = ringOf(c.N), kv = c.model === 'kv';
      S = { t: 0, run: null, res: null, last: {}, vis: new Map(), cur: null };
      S.base = kv ? groupBy(ORD0, o => 'order:' + o.id, o => 'order:' + o.id, toks, c.RF).sort((a, b) => a.reps[0] - b.reps[0] || a.tok - b.tok)
        : groupBy(ORD0, o => 'user:' + o.u, o => 'user_id = ' + o.u, toks, c.RF).sort((a, b) => a.reps[0] - b.reps[0]);
      S.byUser = kv && c.gsi ? groupBy(ORD0, o => 'user:' + o.u, o => 'user_id = ' + o.u, toks, c.RF) : null;
      S.byDay = c.gsi ? groupBy(ORD0, o => 'day:' + p2(o.day), o => 'дата = ' + p2(o.day) + '.10', toks, c.RF).sort((a, b) => a.k.localeCompare(b.k)) : null;
      ['scan', 'range'].forEach(q => { if (q !== H.q) { start(q, true); } });
      start(H.q, false);
    }
    function plan(q) {
      const kv = c.model === 'kv', V2 = [];
      let tb = 'base', parts = S.base;
      const byKey = (ps, pk, pred, lim) => {
        const pi = ps.findIndex(p => p.k === pk); if (pi < 0) return;
        const rows = ps[pi].rows, i0 = rows.findIndex(pred); if (i0 < 0) return;
        V2.push({ pi, ri: i0, kind: 'seek' });
        for (let j = i0, n = 0; j < rows.length && pred(rows[j]) && (!lim || n < lim); j++, n++) V2.push({ pi, ri: j, kind: 'hit' });
      };
      if (q === 'scan' && S.byDay) { tb = 'byDay'; parts = S.byDay; parts.forEach((p, pi) => { const d = +p.k.split(':')[1]; if (d >= 3 && d <= 9) { V2.push({ pi, ri: 0, kind: 'seek' }); p.rows.forEach((o, ri) => V2.push({ pi, ri, kind: 'hit' })); } }); }
      else if (q !== 'scan' && (!kv || S.byUser)) {
        tb = kv ? 'byUser' : 'base'; parts = kv ? S.byUser : S.base;
        if (q === 'range') byKey(parts, 'user:503', inR); else byKey(parts, 'user:503', () => true, 3);
      } else {
        const pred = q === 'scan' ? inR : q === 'range' ? o => o.u === 503 && inR(o) : o => o.u === 503;
        parts.forEach((p, pi) => p.rows.forEach((o, ri) => V2.push({ pi, ri, kind: pred(o) ? 'hit' : 'miss' })));
      }
      /* перебор идёт по всем участкам кольца — опрошены все узлы, даже без нужных строк */
      const nodes = V2.some(v => v.kind === 'miss') ? new Set(Array.from({ length: c.N }, (_, i) => i)) : new Set(V2.map(v => parts[v.pi].reps[0]));
      return { q, tb, parts, visits: V2, nodes, i: 0, tt: 0 };
    }
    function start(q, quiet) {
      const r = plan(q);
      if (quiet) {   // сравнение «а как было бы» — без картинки
        const hits = r.visits.filter(v => v.kind === 'hit').length, read = r.visits.filter(v => v.kind !== 'seek').length;
        S.last[q] = { hits, read, nodes: r.nodes.size };
        return;
      }
      S.run = r; S.vis = new Map(); S.cur = null; S.res = null;
    }
    function finish() {
      const r = S.run, hits = r.visits.filter(v => v.kind === 'hit').length, read = r.visits.filter(v => v.kind !== 'seek').length;
      const scan = r.visits.some(v => v.kind === 'miss');
      S.res = { q: r.q, tb: r.tb, hits: r.q === 'last' && scan ? Math.min(3, hits) : hits, found: hits, read, nodes: r.nodes.size, scan };
      S.last[r.q] = S.res; S.cur = null;
    }
    function tick(dt) {
      S.t += dt;
      const r = S.run; if (!r || S.res) return;
      if (r.i >= r.visits.length) { finish(); env.dirty(); return; }
      const v = r.visits[r.i], scan = r.visits.length > 20, need = v.kind === 'seek' ? 260 : v.kind === 'hit' ? (scan ? 70 : 150) : 45;
      if (!r.tt) r.tt = S.t;
      if (S.t - r.tt >= need) { S.vis.set(v.pi + ':' + v.ri, v.kind); S.cur = v; r.i++; r.tt = S.t; if (r.i >= r.visits.length) finish(); env.dirty(); }
    }
    function code() {
      const m = c.model, q = H.q, idx = S.run && S.run.tb !== 'base';
      if (m === 'doc') return q === 'scan' ? (idx ? 'db.orders_by_day.find({ day: { $gte: "10-03", $lte: "10-09" } })' : 'db.orders.find({ created_at: { $gte: ISODate("2026-10-03"), $lt: ISODate("2026-10-10") } })   // нет user_id — опрос всех шардов')
        : q === 'range' ? 'db.orders.find({ user_id: 503, created_at: { $gte: ISODate("2026-10-03"), $lt: ISODate("2026-10-10") } })   // индекс { user_id: 1, created_at: -1 }' : 'db.orders.find({ user_id: 503 }).sort({ created_at: -1 }).limit(3)';
      if (m === 'kv') return idx ? (q === 'scan' ? 'Query orders_by_day: day = 10-03 … 10-09' : `Query orders_by_user: user_id = 503${q === 'range' ? ', created_at BETWEEN 10-03 AND 10-09' : ', Limit = 3, по убыванию даты'}`) : 'Scan orders   // только GET по точному ключу order:ID — диапазонов нет, перебор всех ключей';
      return q === 'scan' ? (idx ? "SELECT * FROM orders_by_day WHERE day IN ('10-03', …, '10-09');" : "SELECT * FROM orders_by_user WHERE created_at >= '2026-10-03' AND created_at < '2026-10-10' ALLOW FILTERING;")
        : q === 'range' ? "SELECT * FROM orders_by_user WHERE user_id = 503 AND created_at >= '2026-10-03' AND created_at < '2026-10-10';" : 'SELECT * FROM orders_by_user WHERE user_id = 503 LIMIT 3;   -- строки уже по убыванию даты';
    }
    function tables(biz) {
      const r = S.run; if (!r) return '';
      const kvb = r.tb === 'base' && c.model === 'kv';
      const st = (pi, ri) => { const k = S.vis.get(pi + ':' + ri), cur = S.cur && S.cur.pi === pi && S.cur.ri === ri; return (k === 'hit' ? 'is-hit' : k === 'miss' ? 'is-scan' : k === 'seek' ? 'is-seek' : 'is-wait') + (cur ? ' is-cur' : ''); };
      const name = r.tb === 'byDay' ? 'orders_by_day — таблица под запрос, ключ — дата' : r.tb === 'byUser' ? 'orders_by_user — таблица под запрос' : c.model === 'kv' ? 'orders — ключ order:ID, значение — весь заказ' : c.model === 'doc' ? 'orders — документы, шард по user_id, индекс по дате' : 'orders_by_user — партиция user_id, сортировка created_at ↓';
      if (kvb) {
        const byNode = new Map(); r.parts.forEach((p, pi) => { const n = p.reps[0]; if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push([p, pi]); });
        return `<p class="xmd-sub">${esc(name)}</p><div class="xmd-kvgrid">${[...byNode.entries()].sort((a, b) => a[0] - b[0]).map(([n, arr]) => `<div class="xmd-kvnode"><b>${NN(n)}</b><div class="xmd-cells">${arr.map(([p, pi]) => ocell(p.rows[0], st(pi, 0), 'покуп. ' + p.rows[0].u)).join('')}</div></div>`).join('')}</div>`;
      }
      const show = r.parts.map((p, pi) => [p, pi]).filter(([p]) => r.tb !== 'byDay' || (+p.k.split(':')[1] >= 2 && +p.k.split(':')[1] <= 10));
      return `<p class="xmd-sub">${esc(name)}</p><div class="xmd-parts">${show.map(([p, pi]) => `<div class="xmd-part${p.rows.some((o, ri) => S.vis.get(pi + ':' + ri) === 'hit') ? ' on' : ''}"><div class="xmd-ph"><code>${esc(p.label)}</code><small>${p.reps.map(NN).join(', ')}</small></div><ol class="xmd-rows">${p.rows.map((o, ri) => `<li class="${st(pi, ri)}" style="--c:${kc(o.u - 501)}"><span>${dstr(o)}</span><b>${o.id}</b><small>${r.tb === 'byDay' ? 'покуп. ' + o.u : NST[o.st]}</small></li>`).join('')}</ol></div>`).join('')}</div>`;
    }
    function result(biz) {
      const s = S.res, r = S.run;
      if (!s) return `<div class="xmd-sts">${stat('Идёт запрос', `прочитано ${r ? r.visits.slice(0, r.i).filter(v => v.kind !== 'seek').length : 0}`, '')}</div>`;
      const total = ORD0.length;
      return `<div class="xmd-sts">${stat('Найдено', String(s.hits), 'ok')}${stat(biz ? 'Перебрали строк' : 'Прочитано строк', `${s.read} из ${total}`, s.read > s.found * 2 ? 'bad' : 'ok')}${stat('Узлов опрошено', `${s.nodes} из ${c.N}`, s.nodes > 1 && s.nodes >= c.N ? 'warn' : 'ok')}${stat('Способ', s.scan ? 'полный перебор' : s.tb !== 'base' ? 'таблица под запрос' : 'одна партиция подряд', s.scan ? 'bad' : 'ok')}</div>`;
    }
    function say(biz) {
      const s = S.res, kv = c.model === 'kv';
      if (!s) return `<b>Запрос выполняется:</b> ${esc(Q[H.q])}. Подсвечено, что база уже прочитала.`;
      if (s.scan) return `<b>Полный перебор: ${s.read} строк на ${s.nodes} ${pl(s.nodes, 'узле', 'узлах', 'узлах')}, чтобы найти ${s.hits}.</b> ${kv ? 'Ключ-значение умеет только «дай по точному ключу» — ни партиций по покупателю, ни сортировки нет.' : 'В запросе нет ключа партиции — база не знает, где лежат строки, и опрашивает всех (ALLOW FILTERING).'} Время растёт с размером всей базы, а не ответа.${c.gsi ? '' : ' Нужна таблица под запрос — настройка «Вторичный индекс / таблица под запрос».'}`;
      if (s.tb === 'byDay') return `<b>Таблица под запрос orders_by_day:</b> ключ партиции — дата, «заказы за неделю» — 7 партиций подряд: ${s.read} строк, ни одной лишней. Цена — каждый заказ пишется ещё и сюда.`;
      const p503 = S.run.parts.find(p => p.k === 'user:503');
      return `<b>Ключ партиции + ключ сортировки.</b> Партиция покупателя 503 лежит на ${NN(p503.reps[0])}, строки внутри уже отсортированы по дате ↓: база прыгает к ${H.q === 'range' ? '9 октября' : 'началу'} и читает подряд ${s.read} ${pl(s.read, 'строку', 'строки', 'строк')}.${S.last.scan && S.last.scan.read > s.read ? ` Запрос по датам без покупателя прочитал бы ${S.last.scan.read}.` : ''}`;
    }
    function biz() {
      const S0 = shop(), a = AS(), s = S.res, month = S0.ordersDay * a.days;
      const k = [['Запрос читает', s ? `${s.read} ${pl(s.read, 'строку', 'строки', 'строк')}` : '…', s && s.scan ? 'bad' : 'ok', s && s.scan ? `перебор всей базы: у среднего магазина только за месяц ≈ ${big(month)} заказов — запрос всё медленнее, а +100 мс к ответу стоят ${pct(a.slow)} заказов` : 'одна партиция подряд — время не зависит от размера базы']];
      if (s) k.push(['Серверов базы занято запросом', `${s.nodes} из ${c.N}`, s.nodes >= c.N && c.N > 1 ? 'warn' : 'ok', s.nodes >= c.N && c.N > 1 ? 'один запрос нагружает весь кластер — покупателям достаётся меньше' : 'остальные серверы свободны для покупателей']);
      return { an: 'Папка покупателя, где чеки подшиты по дате: чеки за неделю — одна папка, открытая на нужной странице. Без папок — перебираешь все чеки магазина.', k, asm: ['shop', 'slow', 'month', 'model'] };
    }
    return {
      reset, tick,
      sig: () => nsig(c),
      top: bizOn => (bizOn
        ? life('Как <b>папка покупателя</b>, где чеки подшиты по дате: чеки за неделю — одна папка, открытая на нужной странице. Без папок — перебираешь все чеки магазина.', 'Страница «Мои заказы» и отчёты за период быстрые, только если данные заранее разложены под этот вопрос.', true)
        : life('Как <b>папка покупателя</b>, где чеки подшиты по дате: чтобы найти чеки за неделю, открываешь одну папку на нужной странице. Без папок — перебираешь все чеки магазина.', '<b>Ключ сортировки</b> (clustering key) задаёт порядок строк внутри партиции. Запрос «ключ партиции + диапазон по ключу сортировки» читает один кусок подряд. Без ключа партиции — <b>полный перебор</b> всех узлов (ALLOW FILTERING).')) + nchips(c),
      ctl: () => seg('Запрос', 'q', Object.entries(Q), H.q) + `<div class="xmd-grp">${btn('run', 'Выполнить запрос', { pri: 1 })}</div>`,
      act(a) {
        if (a.startsWith('q:')) { H.q = a.slice(2); start(H.q); env.log(`<b>Запрос:</b> ${esc(Q[H.q])}.`); return true; }
        if (a === 'run') { start(H.q); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'model') return { wide: 'На данных: широкие строки — партиция покупателя, строки по дате.', doc: 'На данных: документы, шард по user_id, составной индекс по дате.', kv: 'На данных: только ключ order:ID — диапазоны превращаются в перебор.' }[v] || '';
        if (k === 'gsi') return v ? 'На данных: появилась таблица под запрос — смотри «Все заказы за 3–9 октября».' : 'На данных: таблицы под запрос нет — запрос без ключа станет перебором.';
        if (k === 'count') return `На данных: узлов ${v} — перебор опросит их все.`;
        return '';
      },
      stage: bizOn => `<p class="xmd-code"><code>${esc(code())}</code></p>` + box(bizOn ? 'Что прочитала база' : 'Как идёт чтение', tables(bizOn)) + result(bizOn),
      say, biz
    };
  };

  /* ---------- NoSQL: реплики и уровни согласованности на одной записи ---------- */
  V['data-cl'] = env => {
    let c, S;
    const DL = [170, 240, 1500], RD = 120;   // подтверждение копий, мс модели: третья копия отстаёт (медленный диск)
    const REC = 1027, VAL = ['оплачен', 'собран', 'отправлен', 'доставлен'];
    function reset() {
      c = env.cfg();
      const reps = replicas(ringOf(c.N), fnv('order:' + REC), c.RF);
      S = { t: 0, reps: reps.map((nd, i) => ({ nd, d: DL[i] || 300, down: false, ver: 1, ack: null, pend: null, hint: false })), ver: 1, w: null, r: null, ev: [], auto: [[350, 'write'], [700, 'read']], stale: 0, fail: 0, writes: 0, reads: 0 };
    }
    const lagIdx = () => S.reps.length >= 3 ? 2 : -1;
    const ev = (txt, cls) => { S.ev.unshift({ t: S.w ? S.t - S.w.t0 : 0, txt, cls }); S.ev = S.ev.slice(0, 7); };
    const alive = () => S.reps.filter(r => !r.down);
    function write() {
      if (S.ver >= VAL.length) { S.ver = 1; S.reps.forEach(r => { r.ver = 1; r.pend = null; }); }
      const ver = S.ver + 1;
      S.w = { t0: S.t, ver, need: c.need, acks: [], res: null }; S.r = null; S.writes++; S.ev = [];   // хронология — от начала этой записи
      if (alive().length < c.need) {
        S.w.res = { ok: false }; S.fail++;
        ev(`Unavailable: для ${CLN[c.CL]} нужно ${c.need} ${pl(c.need, 'подтверждение', 'подтверждения', 'подтверждений')}, живы ${alive().length} ${pl(alive().length, 'копия', 'копии', 'копий')} — запись не начата`, 'bad');
        env.log(`<b>Запись «${VAL[ver - 1]}» отклонена:</b> Unavailable — для ${CLN[c.CL]} не хватает живых копий.`, 'bad');
        env.dirty(); return;
      }
      S.ver = ver;
      S.reps.forEach(r => { r.ack = null; if (r.down) r.hint = true; else r.pend = S.t + r.d; });
      ev(`координатор разослал «${VAL[ver - 1]}» всем ${S.reps.length} ${pl(S.reps.length, 'копии', 'копиям', 'копиям')}${S.reps.some(r => r.down) ? '; для упавшей сохранил подсказку — догонит, когда поднимется' : ''}`);
      env.dirty();
    }
    function read() {
      const al = alive(); S.reads++;
      S.r = { t0: S.t, res: null };
      if (al.length < c.need) { S.r.res = { ok: false }; S.fail++; ev(`чтение: Unavailable — нужно ${c.need}, живы ${al.length}`, 'bad'); env.dirty(); return; }
      const li = lagIdx(), ord = al.slice().sort((a, b) => (S.reps.indexOf(b) === li) - (S.reps.indexOf(a) === li));   // худший случай: отстающая копия — первая
      const ask = ord.slice(0, c.need), best = Math.max(...ask.map(r => r.ver)), stale = best < S.ver;
      S.r.ask = ask; S.r.res = { ok: true, ver: best, stale };
      const old = ask.filter(r => r.ver < best);
      if (stale) { S.stale++; ev(`чтение ${CLN[c.CL]}: спросили ${ask.map(r => NN(r.nd)).join(', ')} — вернули «${VAL[best - 1]}», а записано «${VAL[S.ver - 1]}»: старое!`, 'bad'); env.log(`<b>Устаревшее чтение:</b> ${CLN[c.CL]} спросил отстающую копию и вернул «${VAL[best - 1]}».`, 'bad'); }
      else ev(`чтение ${CLN[c.CL]}: спросили ${ask.map(r => NN(r.nd)).join(', ')} — свежее «${VAL[best - 1]}»${old.length ? `; у ${old.map(r => NN(r.nd)).join(', ')} было старое — исправили на лету (read repair)` : ''}`, 'ok');
      old.forEach(r => { r.ver = best; r.pend = null; });
      env.dirty();
    }
    function tick(dt) {
      S.t += dt;
      while (S.auto.length && S.t >= S.auto[0][0]) { const a = S.auto.shift()[1]; if (a === 'write') write(); else read(); }
      S.reps.forEach(r => {
        if (r.pend == null || S.t < r.pend) return;
        r.pend = null;
        if (S.w && r.ver < S.w.ver) { r.ver = S.w.ver; r.ack = S.t - S.w.t0; S.w.acks.push(r); ev(`${NN(r.nd)} записал и подтвердил`, 'ok'); }
        if (S.w && !S.w.res && S.w.acks.length >= S.w.need) { S.w.res = { ok: true, ms: S.t - S.w.t0 }; ev(`клиенту — «записано»: набралось ${S.w.need} из ${S.reps.length}`, 'ok'); }
        env.dirty();
      });
    }
    function downUp() {
      const r = S.reps[S.reps.length > 1 ? 1 : 0];
      r.down = !r.down;
      if (!r.down && r.hint) { r.hint = false; r.ver = S.ver; ev(`${NN(r.nd)} поднялся — координатор отдал подсказку, копия догнала`, 'ok'); }
      else if (r.down) { r.pend = null; ev(`${NN(r.nd)} упал`, 'bad'); }
      env.log(r.down ? `<b>Узел ${NN(r.nd)} упал.</b> Попробуй запись и чтение при ${CLN[c.CL]}.` : `<b>Узел ${NN(r.nd)} поднялся.</b>`, r.down ? 'bad' : '');
    }
    function repl() {
      return `<div class="xmd-reps">${S.reps.map((r, i) => {
        const lag = i === lagIdx(), st = r.down ? 'is-down' : r.ver < S.ver ? 'is-old' : 'is-ok';
        const now = r.down ? 'лежит' + (r.hint ? ' · для неё подсказка' : '') : r.pend != null ? `пишет… ещё ${msec(Math.max(0, r.pend - S.t))}` : r.ver < S.ver ? 'отстаёт — старое' : r.ack != null ? `подтвердил за ${msec(r.ack)}` : 'актуальна';
        return `<div class="xmd-rep ${st}"><b>${NN(r.nd)}</b><small>копия ${i + 1}${lag ? ' · медленный диск' : ''}</small><span class="xmd-val">«${VAL[r.ver - 1]}»<small>версия ${r.ver}</small></span><span>${now}</span></div>`;
      }).join('')}</div>`;
    }
    function formula() {
      const W = c.need, R = c.need, N = c.RF, ok = R + W > N;
      return `<p class="xmd-f ${ok ? 'ok' : 'bad'}"><b>N = ${N}</b> (RF) · <b>W = ${W}</b> (${CLN[c.CL]}) · <b>R = ${R}</b> → ${R} + ${W} ${ok ? '>' : '≤'} ${N}: ${ok ? 'чтение обязательно застанет последнюю запись' : 'чтение может вернуть старое'}</p>`;
    }
    function result(biz) {
      const w = S.w, r = S.r;
      const wt = !w ? 'ещё не было' : !w.res ? `ждём: ${w.acks.length} из ${w.need}` : w.res.ok ? `за ${msec(w.res.ms)}, ${w.need} из ${S.reps.length}` : 'Unavailable';
      const rt = !r ? 'ещё не было' : !r.res ? '…' : !r.res.ok ? 'Unavailable' : `«${VAL[r.res.ver - 1]}»${r.res.stale ? ' — старое' : ' — свежее'}`;
      return `<div class="xmd-sts">${stat(biz ? 'Сохранение статуса' : 'Запись', esc(wt), !w || !w.res ? '' : w.res.ok ? 'ok' : 'bad')}${stat(biz ? 'Что видит покупатель' : 'Чтение', esc(rt), !r || !r.res ? '' : !r.res.ok || r.res.stale ? 'bad' : 'ok')}${stat('Устаревших чтений', String(S.stale), S.stale ? 'warn' : 'ok')}${stat('Отказов', String(S.fail), S.fail ? 'bad' : 'ok')}</div>`;
    }
    function say() {
      const dn = S.reps.some(r => r.down), li = lagIdx();
      if (c.RF === 1) return `<b>RF = 1 — одна копия.</b> ONE, QUORUM и ALL одинаковы: спросить больше некого. Старого не прочитаешь, но упадёт ${NN(S.reps[0].nd)} — заказ ${REC} не прочитать и не записать.`;
      if (c.CL === 'one') return `<b>ONE: ответ после первой копии.</b> Быстро, но чтение спрашивает одну копию — какую повезёт. Здесь попалась отстающая ${li >= 0 ? NN(S.reps[li].nd) : ''}: записали «${VAL[S.ver - 1]}», а прочитать можно старое. 1 + 1 ≤ 3.${dn ? ' Упавший узел ONE переживает.' : ''}`;
      if (c.CL === 'all') return `<b>ALL: ждём все ${c.RF} копии.</b> Чтение всегда свежее, но запись ждёт самую медленную (${msec(Math.max(...S.reps.map(r => r.d)))}). ${dn ? 'Узел лежит — запись и чтение получают Unavailable: ALL не переживает падение одной копии.' : 'Урони узел — запись перестанет проходить.'}`;
      return `<b>QUORUM: большинство — ${c.need} из ${c.RF}.</b> Запись ждёт двух быстрых копий, отстающая догонит позже. Чтение спрашивает двоих — хоть одна видела последнюю запись: ${c.need} + ${c.need} > ${c.RF}, свежая версия побеждает по времени, отставшую чинят на лету. ${dn ? 'Узел лежит — кворум ещё набирается, но запись теперь ждёт медленную копию.' : 'Урони узел — QUORUM переживёт.'}`;
    }
    function biz() {
      const S0 = shop(), a = AS(), shareDown = c.N > 0 ? Math.min(1, c.RF / c.N) : 1, rv = S.r && S.r.res && S.r.res.ver ? S.r.res.ver : 1;
      const k = [['Покупатель видит старый статус', S.stale ? `${S.stale} из ${S.reads}` : '0', S.stale ? 'warn' : 'ok', S.stale ? `«${VAL[rv - 1]}», хотя заказ уже «${VAL[S.ver - 1]}»: ${pct(a.ticket)} напишут в поддержку — ≈ ${rub(a.ticket * a.ticketRub)} за такой показ` : 'каждый сразу видит свежий статус']];
      if (c.CL === 'all' || c.RF === 1) k.push(['Если один узел упадёт', `−${rub(S0.ordersH * shareDown * a.check * a.restoreH)} в час`, 'bad', `не сохранятся заказы, чьи копии на нём: ≈ ${pct(shareDown)} всех, ≈ ${orders(S0.ordersH * shareDown)} в час пик; чинить ≈ ${a.restoreH} ч`]);
      else k.push(['Если один узел упадёт', 'покупатели не заметят', 'ok', `${CLN[c.CL]} набирается и без него${c.CL === 'quorum' ? ', только запись ждёт медленную копию' : ''}`]);
      k.push(['Сохранение статуса', S.w && S.w.res ? (S.w.res.ok ? msec(S.w.res.ms) : 'отказ') : '…', S.w && S.w.res && !S.w.res.ok ? 'bad' : '', `в модели: ${CLN[c.CL]} ждёт ${c.need} из ${c.RF} — чем больше ждём, тем дольше и надёжнее`]);
      return { an: 'Три копии договора у трёх нотариусов: спросишь одного — можешь услышать старую редакцию. Спросишь двоих — хоть один видел последнюю правку. Ждать подписи всех — надёжно, пока все на месте.', k, asm: ['shop', 'chk', 'ticket', 'fail', 'model'] };
    }
    return {
      reset, tick,
      sig: () => nsig(c),
      top: bizOn => (bizOn
        ? life('Как <b>три копии договора у трёх нотариусов</b>: спросишь одного — можешь услышать старую редакцию. Спросишь двоих — хоть один видел последнюю правку. Ждать подписи всех — надёжно, пока все на месте.', `Заказ ${REC}: меняем статус и сразу открываем «Мои заказы». Что увидит покупатель и что будет, если упадёт сервер.`, true)
        : life('Как <b>три копии договора у трёх нотариусов</b>: чтобы считать договор изменённым, достаточно подписей двоих. Чтобы узнать, что в нём, спроси двоих — хотя бы один видел последнюю правку.', `<b>RF</b> — сколько копий. <b>W</b> и <b>R</b> — сколько копий должны ответить на запись и чтение: ONE = 1, QUORUM = большинство, ALL = все. <b>R + W > RF</b> — чтение застанет последнюю запись. Запись — заказ ${REC}, ключ <code>order:${REC}</code>.`)) + nchips(c),
      ctl: () => `<div class="xmd-grp">${btn('write', 'Записать новый статус', { pri: 1 })}${btn('read', 'Прочитать сразу')}${btn('down', S.reps.some(r => r.down) ? 'Поднять узел' : 'Уронить узел')}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a !== 'reset') S.auto = [];   // человек взялся сам — автопоказ «запись → чтение» больше не вмешивается
        if (a === 'write') { write(); return false; }
        if (a === 'read') { read(); return false; }
        if (a === 'down') { downUp(); return true; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'cl') return { one: 'На данных: запись ждёт 1 копию, чтение спрашивает 1 — смотри, вернёт ли старое.', quorum: 'На данных: 2 из 3 на запись и чтение — множества пересекаются, старого не будет.', all: 'На данных: ждём все копии — урони узел, и запись получит Unavailable.' }[v] || '';
        if (k === 'rf') return +v === 1 ? 'На данных: одна копия — спрашивать больше некого.' : 'На данных: три копии на трёх узлах по кругу.';
        return '';
      },
      stage: bizOn => formula() + `<div class="xmd-coord"><div class="xmd-co"><b>${bizOn ? 'Сервис заказов' : 'Клиент → координатор'}</b><small>${bizOn ? 'сохраняет статус и показывает его покупателю' : 'любой узел; рассылает запрос всем копиям'}</small></div><span class="xmd-arrow" aria-hidden="true">→</span>${repl()}</div>`
        + box(bizOn ? 'Что происходило' : 'Хронология, мс от начала записи', `<ul class="xmd-evs">${S.ev.map(e => `<li class="${e.cls || ''}"><i>+${Math.round(e.t)}</i>${esc(e.txt)}</li>`).join('') || '<li class="xmd-muted">ещё ничего</li>'}</ul>`) + result(bizOn),
      say, biz
    };
  };

  /* ---------- NoSQL: вторичный индекс и его цена ---------- */
  V['data-idx'] = env => {
    let c, S;
    const IDXLAG = 900;
    const local = () => c.model === 'doc';   // в MongoDB индекс лежит на каждом шарде рядом со своими документами
    function reset() {
      c = env.cfg();
      S = { t: 0, ords: ORD0.slice(), nextId: 1037, pend: [], run: null, vis: new Map(), cur: null, res: null, last: {}, w: 0 };
      build(); start(false);
    }
    function build() {
      S.toks = ringOf(c.N);
      S.base = groupBy(S.ords, o => 'order:' + o.id, o => 'order:' + o.id, S.toks, c.RF).sort((a, b) => a.reps[0] - b.reps[0] || a.tok - b.tok);
      const inIdx = S.ords.filter(o => !S.pend.some(p => p.o === o));
      S.idx = c.gsi ? groupBy(inIdx, o => 'user:' + o.u, o => 'user_id = ' + o.u, S.toks, c.RF) : null;
    }
    function plan() {
      const V2 = [];
      if (c.gsi && !local()) { const pi = S.idx.findIndex(p => p.k === 'user:503'); if (pi >= 0) { V2.push({ t: 'idx', pi, ri: 0, kind: 'seek' }); S.idx[pi].rows.forEach((o, ri) => V2.push({ t: 'idx', pi, ri, kind: 'hit' })); } }
      else S.base.forEach((p, pi) => p.rows.forEach((o, ri) => { const hit = o.u === 503; if (c.gsi && local() && !hit) return; V2.push({ t: 'base', pi, ri, kind: hit ? 'hit' : 'miss' }); }));
      const nodes = c.gsi && !local() ? new Set(S.idx.filter(p => p.k === 'user:503').map(p => p.reps[0])) : new Set(Array.from({ length: c.N }, (_, i) => i));
      return { visits: V2, i: 0, nodes, tt: 0 };
    }
    function start(instant) {
      S.run = plan(); S.vis = new Map(); S.cur = null; S.res = null;
      if (instant) { S.run.visits.forEach(v => S.vis.set(v.t + v.pi + ':' + v.ri, v.kind)); S.run.i = S.run.visits.length; finish(); }
    }
    function finish() {
      const r = S.run, hits = r.visits.filter(v => v.kind === 'hit').length, read = r.visits.filter(v => v.kind !== 'seek').length;
      S.res = { hits, read, nodes: r.nodes.size, miss: S.ords.filter(o => o.u === 503).length - hits };
      S.cur = null;
    }
    function write() {
      const o = mkOrder(S.nextId); o.u = 503; o.day = 14; o.st = 0; S.nextId++;
      S.ords.push(o); S.w++;
      if (c.gsi && !local()) S.pend.push({ o, at: S.t + IDXLAG });
      build(); start(true);
      env.log(`<b>Записан заказ ${o.id} покупателя 503.</b> ${c.gsi ? (local() ? 'Документ и запись индекса — на одном шарде, сразу.' : `Две записи: в orders и в индекс; индекс догонит через ${msec(IDXLAG)}.`) : 'Одна запись — в orders.'}`);
    }
    function tick(dt) {
      S.t += dt;
      if (S.pend.length && S.pend[0].at <= S.t) { S.pend.shift(); build(); start(true); env.dirty(); }
      const r = S.run; if (!r || S.res) return;
      if (r.i >= r.visits.length) { finish(); env.dirty(); return; }
      const v = r.visits[r.i], need = v.kind === 'seek' ? 260 : v.kind === 'hit' ? 140 : 45;
      if (!r.tt) r.tt = S.t;
      if (S.t - r.tt >= need) { S.vis.set(v.t + v.pi + ':' + v.ri, v.kind); S.cur = v; r.i++; r.tt = S.t; if (r.i >= r.visits.length) finish(); env.dirty(); }
    }
    const st = (t, pi, ri) => { const k = S.vis.get(t + pi + ':' + ri), cur = S.cur && S.cur.t === t && S.cur.pi === pi && S.cur.ri === ri; return (k === 'hit' ? 'is-hit' : k === 'miss' ? 'is-scan' : 'is-wait') + (cur ? ' is-cur' : ''); };
    function baseView() {
      const byNode = new Map(); S.base.forEach((p, pi) => { const n = p.reps[0]; if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push([p, pi]); });
      return `<div class="xmd-kvgrid">${[...byNode.entries()].sort((a, b) => a[0] - b[0]).map(([n, arr]) => `<div class="xmd-kvnode"><b>${NN(n)}</b><div class="xmd-cells">${arr.map(([p, pi]) => ocell(p.rows[0], st('base', pi, 0), 'покуп. ' + p.rows[0].u)).join('')}</div></div>`).join('')}</div>`;
    }
    function idxView() {
      if (!c.gsi) return '<p class="xmd-muted">Индекса нет. Включи «Вторичный индекс / таблица под запрос» в настройках справа.</p>';
      if (local()) return '<p class="xmd-muted">MongoDB: индекс { user_id: 1 } лежит на каждом шарде рядом со своими документами. Запрос всё равно опросит все шарды — данные разложены по order_id, — но каждый найдёт строки покупателя по индексу, без перебора.</p>';
      const pi = S.idx.findIndex(p => p.k === 'user:503'), p = S.idx[pi];
      if (!p) return '';
      return `<div class="xmd-part on"><div class="xmd-ph"><code>${esc(p.label)}</code><small>${p.reps.map(NN).join(', ')}</small></div><div class="xmd-cells">${p.rows.map((o, ri) => ocell(o, st('idx', pi, ri), dstr(o).slice(0, 5))).join('')}${S.pend.map(x => `<span class="xmd-ghost" title="ещё не в индексе">${x.o.id}</span>`).join('')}</div></div><p class="xmd-muted">Остальные покупатели — в своих партициях индекса: ещё ${S.idx.length - 1}.</p>`;
    }
    function result(biz) {
      const s = S.res;
      if (!s) return `<div class="xmd-sts">${stat('Идёт запрос', `прочитано ${S.run ? S.run.visits.slice(0, S.run.i).filter(v => v.kind !== 'seek').length : 0}`, '')}</div>`;
      const perW = c.gsi && !local() ? 2 * c.RF : c.RF;
      return `<div class="xmd-sts">${stat('Найдено заказов 503', String(s.hits) + (s.miss > 0 ? ` · ${s.miss} ещё не видно` : ''), s.miss > 0 ? 'warn' : 'ok')}${stat(biz ? 'Перебрали строк' : 'Прочитано строк', `${s.read} из ${S.ords.length}`, s.read > s.hits * 2 ? 'bad' : 'ok')}${stat('Узлов опрошено', `${s.nodes} из ${c.N}`, s.nodes > 1 && s.nodes >= c.N ? 'warn' : 'ok')}${stat(biz ? 'Записей на один заказ' : 'Записей на заказ с копиями', String(perW), c.gsi && !local() ? 'warn' : '')}</div>`;
    }
    function say() {
      const s = S.res;
      if (!c.gsi) return `<b>Индекса нет.</b> Таблица разложена по order_id, и узел не знает, где заказы покупателя 503: координатор опрашивает все ${c.N} ${pl(c.N, 'узел', 'узла', 'узлов')}, каждый перебирает свои строки — ${s ? s.read : '…'} прочитано ради ${s ? s.hits : '…'}. Зато каждый заказ пишется один раз.`;
      if (local()) return `<b>Локальный индекс на шардах.</b> Строки покупателя находятся без перебора (прочитано ${s ? s.read : '…'}), но опрошены все ${c.N} ${pl(c.N, 'шард', 'шарда', 'шардов')}: ключ шарда — order_id. Цена: индекс обновляется при каждой записи и занимает память на каждом шарде.`;
      const p = S.idx.find(x => x.k === 'user:503');
      return `<b>Глобальный индекс — отдельная таблица с ключом user_id.</b> «Мои заказы» — одна партиция на ${p ? NN(p.reps[0]) : '…'}: ${s ? s.read : '…'} ${pl(s ? s.read : 0, 'строка', 'строки', 'строк')}, без лишних. Цена: каждый заказ пишется дважды (${2 * c.RF} записей вместо ${c.RF} с копиями), место ×2, а индекс догоняет таблицу с задержкой${S.pend.length ? ` — новый заказ ${S.pend[0].o.id} ещё не виден в «Моих заказах»` : '. Запиши заказ и сразу открой «Мои заказы»'}.`;
    }
    function biz() {
      const a = AS(), s = S.res, nUsd = unitUsd('nosql', { count: 1 }), lagg = c.gsi && !local();
      const k = [['«Мои заказы» перебирает', s ? `${s.read} из ${S.ords.length}` : '…', s && s.read > s.hits * 2 ? 'bad' : 'ok', s && s.read > s.hits * 2 ? `весь магазин ради одного покупателя: страница всё медленнее по мере роста базы, а +100 мс стоят ${pct(a.slow)} заказов` : 'только свои заказы — быстро при любом размере базы'],
        ['Цена индекса', c.gsi ? 'записей ×2' : 'нет', c.gsi ? 'warn' : 'ok', c.gsi ? `каждый заказ пишется дважды, место ×2; если узлы заняты записью, понадобится ещё узел — ${rub(nUsd * a.usdRub)} в мес.` : 'зато «Мои заказы» — перебор всего кластера'],
        ['Новый заказ виден покупателю', lagg ? `через ≈ ${msec(IDXLAG)}` : 'сразу', lagg ? 'warn' : 'ok', lagg ? `индекс догоняет в фоне: оформил и не видит заказ — ${pct(a.ticket)} пишут в поддержку, ${rub(a.ticketRub)} за обращение` : 'отдельной копии нет — догонять нечего']];
      return { an: 'Архив разложен по номерам заказов. Картотека по покупателям рядом — все заказы Иванова одной карточкой. Но каждую новую папку записывают в два места, и картотека иногда отстаёт.', k, asm: ['ticket', 'slow', 'usd', 'model'] };
    }
    return {
      reset, tick,
      sig: () => nsig(c),
      top: bizOn => (bizOn
        ? life('Как <b>картотека по фамилиям</b> рядом с архивом, разложенным по номерам заказов: найти все заказы Иванова — одна карточка, а не обход всего архива. Но каждую новую папку записывают в два места.', 'Страница «Мои заказы» быстрая только с индексом. Индекс — это вторая запись на каждый заказ и небольшое отставание.', true)
        : life('Как <b>картотека по фамилиям</b> рядом с архивом, разложенным по номерам заказов: найти все заказы Иванова — одна карточка, а не обход всего архива. Но каждую новую папку теперь надо записать в два места.', '<b>Вторичный индекс</b> — копия данных с другим ключом партиции: GSI в DynamoDB, таблица под запрос в Cassandra; в MongoDB — индекс на каждом шарде. Чтение по нему — одна партиция вместо опроса всех узлов. Цена: две записи на заказ, место, а глобальный индекс догоняет таблицу с задержкой.')) + nchips(c),
      ctl: () => `<div class="xmd-grp">${btn('run', 'Открыть «Мои заказы» покупателя 503', { pri: 1 })}${btn('write', 'Записать заказ покупателя 503')}${btn('reset', 'Сначала')}</div>`,
      act(a) {
        if (a === 'run') { start(false); return true; }
        if (a === 'write') { write(); return true; }
        if (a === 'reset') { reset(); return true; }
        return false;
      },
      prop(k, prev, v) {
        reset();
        if (k === 'gsi') return v ? 'На данных: появилась таблица с ключом user_id — «Мои заказы» читают одну партицию.' : 'На данных: индекса нет — «Мои заказы» опрашивают все узлы.';
        if (k === 'model') return v === 'doc' ? 'На данных: в MongoDB индекс локальный — шарды опрашиваются все, но без перебора.' : '';
        if (k === 'count') return `На данных: узлов ${v} — без индекса запрос опросит их все.`;
        return '';
      },
      stage: bizOn => `<p class="xmd-code"><code>${esc(c.gsi ? (local() ? 'db.orders.find({ user_id: 503 })   // индекс { user_id: 1 } на каждом шарде' : c.model === 'kv' ? 'Query GSI orders_by_user: user_id = 503' : 'SELECT * FROM orders_by_user WHERE user_id = 503;') : (c.model === 'doc' ? 'db.orders.find({ user_id: 503 })   // без индекса — перебор коллекции на всех шардах' : c.model === 'kv' ? 'Scan orders, FilterExpression: user_id = 503' : 'SELECT * FROM orders WHERE user_id = 503 ALLOW FILTERING;'))}</code></p>`
        + `<div class="xmd-two">${box(bizOn ? 'Архив по номерам заказов' : 'orders — партиция order_id', baseView())}${box(bizOn ? 'Картотека по покупателям' : 'Индекс: user_id → заказы', idxView())}</div>` + result(bizOn),
      say, biz
    };
  };

  /* =====================================================================================================
     Встраивание в сцену: виды, переключатель «Взгляд», такт, настройки
     ===================================================================================================== */
  const CFG = {
    queue: { kind: 'b', views: [['data-key', 'Ключи на данных'], ['data-group', 'Группа и лаг'], ['data-ack', 'Доставка и дубли'], ['data-keep', 'Хранение и DLQ']] },
    worker: { kind: 'b', views: [['data-group', 'Группа и лаг'], ['data-ack', 'Доставка и дубли']] },
    nosql: { kind: 'n', views: [['data-ring', 'Ключи и узлы'], ['data-sort', 'Сортировка и диапазон'], ['data-cl', 'Реплики и согласованность'], ['data-idx', 'Вторичный индекс']] }
  };
  const LEG = {
    b: [['sq xmd-sw-wait', 'Сообщение: номер заказа и статус, цвет полоски — заказ'], ['sq xmd-sw-fly', 'Сейчас обрабатывается'], ['sq xmd-sw-done', 'Обработано, offset ещё не закоммичен'], ['sq xmd-sw-com', 'Обработано и закоммичено'], ['sq xmd-sw-again', 'Придёт снова: повторная доставка'], ['sq xmd-sw-dup', 'Обработано второй раз — дубль'], ['sq xmd-sw-bad', 'Потеряно, вразнобой или в DLQ'], ['xmd-sw-mark', 'Offset группы: «досюда дочитали»']],
    n: [['sq xmd-sw-wait', 'Строка заказа, цвет полоски — покупатель'], ['sq xmd-sw-hit', 'Подошла под запрос'], ['sq xmd-sw-scan', 'Прочитана зря — перебор'], ['ok', 'Копия свежая, подтвердила'], ['warn', 'Копия отстаёт — у неё старое'], ['bad', 'Узел лежит или отказ']]
  };
  function bizCard(o) {
    if (!o) return '';
    const S0 = shop(), asm = (o.asm || []).map(x => typeof ASM[x] === 'function' ? ASM[x](S0) : ASM[x]).filter(Boolean);
    return `<section class="xmd-biz" aria-label="Что это значит для магазина"><div class="xmd-bh"><span class="xmd-eye">Взгляд бизнеса</span><h4 class="xmd-bt">Что это значит для магазина</h4></div>`
      + `<p class="xmd-blife"><span class="xmd-tag">Как в жизни</span>${esc(o.an)}</p>`
      + `<ul class="xmd-kpis">${o.k.filter(Boolean).map(([l, v, cl, n]) => `<li class="xmd-kpi"><small>${esc(l)}</small><b class="${esc(cl || '')}">${esc(v)}</b>${n ? `<span>${esc(n)}</span>` : ''}</li>`).join('')}</ul>`
      + `<p class="xmd-basm"><b>Допущения</b> из «Таблицы вживую» и «Как посчитать»: ${esc(asm.join('; '))}.</p></section>`;
  }

  function attach(type) {
    const C = CFG[type], def = SD.XRAY[type];
    if (!C || !def || def.__xmd || typeof def.mount !== 'function') return;
    def.__xmd = 1;
    const ids = C.views.map(v => v[0]), isData = v => ids.includes(v);
    def.views = (def.views && def.views.length ? def.views : [{ id: 'engine', name: 'Как работает внутри' }]).concat(C.views.map(([id, name]) => ({ id, name, scenarios: [] })));
    const parts0 = def.parts, legend0 = def.legend;
    def.parts = v => isData(v) ? null : (typeof parts0 === 'function' ? parts0(v) : parts0);
    def.legend = v => isData(v) ? LEG[C.kind] : (typeof legend0 === 'function' ? legend0(v) : legend0);
    const mount0 = def.mount;
    def.mount = function (ctx) {
      const inner = mount0.call(this, ctx) || {};
      const H = { key: 'order', pk: 'user', q: 'range', id: null, cur: null, dirty: true, seen: {}, sigT: 0 };
      const el = ctx.html, ctl = $('xrCtl'), main = el ? el.closest('.xr-main') : null;
      let dead = false;
      const mode = () => { try { return localStorage.getItem(MK) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
      const env = { H, ctx, cfg: () => (C.kind === 'b' ? bcfg(ctx, type) : ncfg(ctx)), dirty: () => { H.dirty = true; }, log: (t, cls) => ctx.log(t, cls) };
      const hide = on => { ['xrStats', 'xrNow'].forEach(id => { const e = $(id); if (e) e.hidden = on; }); if (main) main.classList.toggle('xmd-on', on); };
      const set = (sel, html) => { const e = el.querySelector(sel); if (e && H.seen[sel] !== html) { e.innerHTML = html; H.seen[sel] = html; } };
      function paintTop() { const b = mode() === 'biz'; set('.xmd-top', H.cur.top(b)); const r = el.querySelector('.xmd'); if (r) r.dataset.mode = b ? 'biz' : 'tech'; }
      function paintCtl() {
        const f = document.activeElement, fa = f && el.contains(f) && f.dataset ? f.dataset.xmd : null;
        set('.xmd-ctl', H.cur.ctl());
        if (fa) { const nb = el.querySelector(`.xmd-ctl [data-xmd="${fa}"]`); if (nb && nb !== document.activeElement && !nb.disabled) nb.focus(); }
      }
      function paintStage() {
        const b = mode() === 'biz';
        H.dirty = false;
        paintCtl();   // кнопки зависят от состояния: «Упадёт…», «Поднять узел»
        set('.xmd-stage', H.cur.stage(b));
        set('.xmd-say', H.cur.say(b));
        set('.xmd-bizw', b ? bizCard(H.cur.biz()) : '');
      }
      const paintAll = () => { if (!H.cur) return; paintTop(); paintCtl(); paintStage(); };
      function enter(v) {
        if (H.cur && H.id === v) return;
        ctx.useHtml(true); hide(true);
        H.id = v; H.cur = V[v](env); H.cur.reset(); H.seen = {};
        el.innerHTML = `<div class="xmd" data-xmdv="${v}"><div class="xmd-top"></div><div class="xmd-ctl"></div><div class="xmd-stage"></div><p class="xmd-say"></p><div class="xmd-bizw"></div></div>`;
        paintAll();
      }
      function drop() {
        H.cur = null; H.id = null; H.seen = {};
        if (el) el.innerHTML = '';
        ctx.useHtml(false); hide(false);
      }
      const onAct = e => {
        const b = e.target.closest('[data-xmd]'); if (!b || !H.cur || !el.contains(b) || b.disabled) return;
        if (H.cur.act(b.dataset.xmd, b)) paintTop();
        paintCtl(); paintStage();
      };
      if (el) el.addEventListener('click', onAct);
      /* «Взгляд»: та же группа, что у xray-biz.js и xray-sqldata.js; своя — только если её никто не поставил */
      let mine = null;   // группа, которую поставили мы, — её и уберём при закрытии
      const inject = () => {
        if (dead || !ctl || ctl.querySelector('.xsd-mode, .xbz-mode')) return;
        const m = mode(), g = mine = document.createElement('div'); g.className = 'xr-grp xbz-mode';
        g.innerHTML = `<b>Взгляд</b><div class="seg"><button type="button" data-xbzmode="tech" aria-selected="${m === 'tech'}" title="Как устроено технически">Техника</button><button type="button" data-xbzmode="biz" aria-selected="${m === 'biz'}" title="Что это значит для бизнеса: секунды, заказы, рубли">Бизнес</button></div>`;
        const vv = ctl.querySelector('.xr-views'); if (vv && vv.nextSibling) ctl.insertBefore(g, vv.nextSibling); else ctl.appendChild(g);
      };
      const later = () => setTimeout(inject, 0);
      const mo = ctl ? new MutationObserver(later) : null; if (mo) mo.observe(ctl, { childList: true });
      const onMode = e => {
        const b = e.target.closest('[data-xbzmode],[data-xsdmode]'); if (!b) return;
        const m = (b.dataset.xbzmode || b.dataset.xsdmode) === 'biz' ? 'biz' : 'tech';
        try { localStorage.setItem(MK, m); } catch (err) { /* без хранилища */ }
        ctl.querySelectorAll('[data-xbzmode],[data-xsdmode]').forEach(x => x.setAttribute('aria-selected', String((x.dataset.xbzmode || x.dataset.xsdmode) === m)));
        if (H.cur) { H.seen = {}; paintAll(); }
      };
      if (ctl) ctl.addEventListener('click', onMode);
      later();
      if (isData(ctx.view())) enter(ctx.view());
      /* настройки поменяли не здесь — у брокера перед обработчиком, связи на площадке: вид начинается заново */
      const resync = () => {
        if (!H.cur) return;
        const c2 = env.cfg(), s1 = C.kind === 'b' ? bsig(c2) : nsig(c2);
        if (H.cur.sig().indexOf(s1) !== 0) { H.cur.reset(); H.seen = {}; paintAll(); }
      };
      return Object.assign({}, inner, {
        view(v) { if (isData(v)) enter(v); else if (H.cur) drop(); if (inner.view) inner.view(v); },
        tick(dt) { if (H.cur) H.cur.tick(dt); else if (inner.tick) inner.tick(dt); },
        draw() {
          if (!H.cur) { if (inner.draw) inner.draw(); return; }
          const now = performance.now();
          if (now - H.sigT > 400) { H.sigT = now; resync(); }
          if (H.dirty) paintStage();
        },
        onProp(k, prev, v) {
          const r = inner.onProp ? inner.onProp(k, prev, v) : '';
          if (!H.cur) return r;
          if (String(prev) === String(v)) return r;
          const msg = H.cur.prop(k, prev, v) || '';
          H.seen = {}; paintAll();
          return msg;
        },
        refresh() { if (inner.refresh) inner.refresh(); if (H.cur) resync(); },
        stats() { return H.cur ? [] : (inner.stats ? inner.stats() : []); },
        now() { return H.cur ? '' : (inner.now ? inner.now() : ''); },
        destroy() {
          dead = true;
          if (H.cur) drop();
          if (el) el.removeEventListener('click', onAct);
          if (mo) mo.disconnect();
          if (ctl) ctl.removeEventListener('click', onMode);
          if (mine && mine.parentNode) mine.remove();
          if (main) main.classList.remove('xmd-on');
          if (inner.destroy) inner.destroy();
        }
      });
    };
  }

  SD.xrayMoreData = { CFG, attach, views: Object.keys(V) };
  Object.keys(CFG).forEach(attach);   // сцена уже загружена
  (SD.XRAY_HOOKS = SD.XRAY_HOOKS || []).push(t => { if (CFG[t]) attach(t); });   // сцена загрузилась позже
})();
