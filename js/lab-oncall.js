/* Лаборатория «Дежурство и постмортем»: один ночной инцидент интернет-магазина. В 22:40 выкатили checkout v2.14 — новый расчёт
   промо делает 12 лишних запросов к базе и держит соединение в 6 раз дольше. Ночью незаметно, но в 03:00 начинается утро на
   Дальнем Востоке и рассылка с промокодом: пул соединений кончается, оформления падают. Алерт по burn rate, масштаб и роли,
   разбор по метрикам, логам и трейсу, действие (флаг, откат или неверные ходы), связь, постмортем без поиска виноватых.
   Часы инцидента идут только от действий: каждое стоит минут, а минуты — заказов. Переключатель «Техника | Бизнес».
   Стили — lab-oncall.css, префикс .loc-. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const pc = (x, d = 1) => { const k = Math.pow(10, d), v = Math.round(x * 100 * k) / k; return (Number.isInteger(v) ? String(v) : v.toFixed(d).replace('.', ',')) + ' %'; };
  const rub = v => nf(v) + ' ₽';
  const rubK = v => { const a = Math.abs(v); if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 1) + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const p2 = n => String(n).padStart(2, '0');
  const T = (h, m) => h * 60 + m;
  const hm = m => `${p2(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${p2(((m % 60) + 60) % 60)}`;
  const mins = n => { n = Math.round(n); return n + ' ' + plural(n, 'минута', 'минуты', 'минут'); };
  const ords = n => (n > 0 && n < 9.95 ? dec(n, 1) : nf(n)) + ' ' + plural(n, 'заказ', 'заказа', 'заказов');
  const f1 = v => (+v).toFixed(1);
  const tx = (x, y, t, c, a) => `<text class="${c || 'loc-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const rc = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 4 : rx}"/>`;
  const ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;

  /* ================= модель инцидента ================= */
  /* минуты от полуночи; график — 02:30…04:30. Нагрузка на checkout-service (запросов в секунду) растёт с 02:46:
     утро на Дальнем Востоке и рассылка с промокодом. Пул: 5 подов × 18 = 90 соединений (у базы лимит 100, 10 — другим сервисам).
     v2.14 держит соединение 0,6 с (12 запросов правил промо на заказ), v2.13 — 0,1 с. Нужно соединений = запросы/с × время удержания. */
  const M0 = T(2, 30), M1 = T(4, 30), RAMP = T(2, 46), CAP = 90, HOLD_NEW = 0.6, HOLD_OLD = 0.1, DEPLOY = T(22, 40);
  const rps = m => m < RAMP ? 60 : m > T(4, 10) ? Math.max(150, 200 - (m - T(4, 10)) * 2.5) : Math.min(200, 60 + (m - RAMP) * 4.5);
  /* бизнес: средний чек, сколько уходят после ошибки, ночной вызов, обращения в поддержку */
  const BIZ = { check: 3200, abandon: 0.6, abandonPost: 0.45, call: 4500, support: 350, callNo: 0.15, callYes: 0.04, uniq: 0.7, month: 1080000 };
  const ACT = {
    flag: { n: 'Выключить флаг promo_rules_v2', d: 'новый расчёт промо из v2.14 спрятан за флагом — выключается без выкладки', cost: 2, kind: 'fix' },
    rollback: { n: 'Откатить выкладку v2.14 → v2.13', d: 'rolling update обратно: 5 подов по очереди, ≈ 4 минуты', cost: 5, kind: 'fix' },
    scale: { n: 'Добавить серверы: 5 → 10 подов', d: 'больше подов — больше мощности для оформления', cost: 3, kind: 'bad' },
    restart: { n: 'Перезапустить все поды checkout', d: 'сбросить зависшие соединения одним махом', cost: 3, kind: 'bad' },
    pool: { n: 'Увеличить пул: 18 → 30 соединений на под', d: 'поменять настройку и перезапустить поды по очереди', cost: 5, kind: 'bad' },
    failover: { n: 'Переключить базу на реплику', d: 'вдруг основная база больна — сделать реплику главной', cost: 4, kind: 'bad' },
    wait: { n: 'Подождать 5 минут', d: 'посмотреть, не пройдёт ли само', cost: 5, kind: 'wait' }
  };
  const ACT_ORDER = ['flag', 'rollback', 'scale', 'restart', 'pool', 'failover', 'wait'];
  /* поминутный прогон с учётом действий: { at, k } — действие начато в минуту at */
  function simulate(acts) {
    const rows = [];
    for (let m = M0 - 60; m <= M1; m++) {
      let fNew = 1, mul = 1, cap = CAP, forced = 0, extra = 0, pods = 5, poolZero = false;
      acts.forEach(a => {
        const d = m - a.at; if (d < 0) return;
        if (a.k === 'flag' && d >= 1) fNew = 0;
        if (a.k === 'rollback') fNew = Math.min(fNew, 1 - clamp(d / 4, 0, 1));
        if (a.k === 'scale' && d >= 2) { mul *= 1.25; pods = 10; }
        if (a.k === 'restart') { if (d === 0) { forced = 1; poolZero = true; } else if (d === 1) forced = Math.max(forced, 0.7); else if (d === 2) extra += 0.15; }
        if (a.k === 'pool') { if (d >= 1 && d < 4) cap = Math.min(cap, CAP * 0.8); if (d >= 4) mul *= 1.15; }
        if (a.k === 'failover' && d <= 1) { forced = 1; poolZero = true; }
      });
      const r = rps(m), hold = HOLD_OLD + (HOLD_NEW - HOLD_OLD) * fNew, need = r * hold * mul, u = need / cap;
      let err = Math.max(0.001, u >= 1 ? 1 - 1 / u : 0.001) + extra;
      err = Math.min(1, Math.max(err, forced));
      const p99 = err >= 0.99 ? null : u >= 1 ? 3000 : Math.round(250 + hold * mul * 1000 * (u < 0.8 ? 1 : 1 + 4 * (u - 0.8)));
      const orders = r * 0.2;
      rows.push({ m, r, err, p99, pool: poolZero ? 0 : Math.min(1, u), qpo: 2 + 12 * fNew, fNew, orders, failed: orders * err, lost: orders * err * BIZ.abandon, pods });
    }
    return rows;
  }
  const rowAt = (rows, m) => rows[m - (M0 - 60)];
  /* правило алерта, как в лаборатории SLO: burn rate ≥ 14,4 за 1 час и за 5 минут; SLO оформлений 99,9 % */
  const SLO = 0.999, BURN = 14.4;
  const winErr = (rows, m, w) => { let a = 0, b = 0; for (let k = m - w + 1; k <= m; k++) { const x = rowAt(rows, k); a += x.failed; b += x.orders; } return a / b; };
  const BASE = simulate([]);
  const ONSET = (() => { for (let m = M0; m <= M1; m++) if (rowAt(BASE, m).err >= 0.005) return m; return M0; })();
  const ALERT = (() => { for (let m = M0; m <= M1; m++) if (winErr(BASE, m, 60) >= (1 - SLO) * BURN && winErr(BASE, m, 5) >= (1 - SLO) * BURN) return m; return ONSET + 5; })();
  const PEOPLE = [['me', 'Ты', 'дежурный по магазину'], ['oleg', 'Олег', 'второй дежурный, эксперт по базе'], ['marina', 'Марина', 'дежурный менеджер поддержки']];
  const PN = Object.fromEntries(PEOPLE.map(p => [p[0], p[1]]));
  const ROLES = [['ic', 'Ведущий', 'координирует, принимает решения, следит за временем; сам не копается в логах'], ['ops', 'Разбор', 'смотрит метрики, логи, трейсы, проверяет гипотезы, делает изменения'], ['comms', 'Связь', 'пишет на страницу статуса и поддержке, отвечает руководству']];

  /* ---------- общие кусочки разметки ---------- */
  const ana = (life, plain, term) => `<div class="loc-ana"><p class="loc-life"><span class="loc-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="loc-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const seg = (name, items, cur, label, dis) => `<div class="seg loc-seg" role="group" aria-label="${esc(label || name)}">${items.map(([v, t]) => `<button type="button" data-set="${name}:${v}" aria-selected="${String(v) === String(cur)}"${dis ? ' disabled' : ''}>${t}</button>`).join('')}</div>`;
  const tile = (label, val, sub, cls) => `<div class="loc-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const card = (cls, html) => `<div class="loc-card ${cls || ''}">${html}</div>`;
  const asm = list => `<details class="loc-asm" open><summary>Допущения для расчёта</summary><ul>${list.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul></details>`;
  const legend = items => `<div class="loc-legend">${items.map(([c, t]) => `<span><i class="loc-lg ${c}"></i>${t}</span>`).join('')}</div>`;

  /* ================= экземпляр ================= */
  const MODE_KEY = 'amp-stroyka-loc-mode';
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
  const TABS = [['alert', '1', 'Алерт'], ['dig', '2', 'Разбор'], ['act', '3', 'Действие'], ['comms', '4', 'Связь'], ['pm', '5', 'Постмортем'], ['memo', '✓', 'Итоги']];
  const NEXT = { alert: ['dig', 'разбор — метрики, логи, трейс'], dig: ['act', 'действие — остановить кровотечение'], act: ['comms', 'связь — статус и поддержка'], comms: ['pm', 'постмортем'], pm: ['memo', 'что запомнить'] };
  const nextBtn = k => NEXT[k] ? `<div class="loc-next"><button type="button" class="btn" data-go="${NEXT[k][0]}">Дальше: ${NEXT[k][1]} →</button></div>` : '';

  function makeLab(EL, doneFn) {
    let MODE = readMode();
    const fresh = () => ({ t: ALERT, acts: [], ev: [], ack: null, snooze: false, sev: null, sevOk: null, roles: { ic: 'me', ops: 'me', comms: 'me' }, declared: null, checks: {}, verdict: {}, wrong: {}, found: null, posts: [], draft: { what: null, since: true, doing: null, money: false, sorry: true, blame: false, eta: false, next: true }, sup: { retry: true, noeta: true, bank: false, promo: false, link: true }, cad: 30, trace: 'fail', logf: 'all', why: {}, tasks: {}, owners: {} });
    const U = { tab: 'alert', alive: true, I: fresh(), msg: null };
    const done = id => { try { doneFn(id); } catch (e) { /* задания не засчитываются — не страшно */ } };
    const isBiz = () => MODE === 'biz';
    const $ = s => EL.querySelector(s);
    let rows = BASE;
    const resim = () => { rows = simulate(U.I.acts); };
    const goodPost = () => { const g = U.I.posts.filter(p => p.score >= 4).map(p => p.t); return g.length ? Math.min(...g) : Infinity; };
    const lostAt = m => rowAt(rows, m).failed * (m >= goodPost() ? BIZ.abandonPost : BIZ.abandon);
    const now = () => rowAt(rows, U.I.t);

    /* ---------- часы и события ---------- */
    const log = (k, text, cls, t) => U.I.ev.push({ t: t == null ? U.I.t : t, k, text, cls: cls || '' });
    const spend = n => { U.I.t = Math.min(M1, U.I.t + n); };
    function recAt() {
      const I = U.I, fx = I.acts.filter(a => ACT[a.k].kind === 'fix'); if (!fx.length) return null;
      for (let m = Math.min(...fx.map(a => a.at)); m <= I.t; m++) if (rowAt(rows, m).err < 0.005) return m;
      return null;
    }
    const stats = () => {
      const I = U.I, rec = recAt(), end = rec != null ? rec : I.t;
      let failed = 0, lost = 0, lost0 = 0; for (let m = ONSET; m < end; m++) { const x = rowAt(rows, m); failed += x.failed; lost += lostAt(m); lost0 += x.lost; }
      return { rec, end, failed, lost, saved: lost0 - lost, rub: lost * BIZ.check, users: failed * BIZ.uniq, mttd: ALERT - ONSET, mtta: I.ack != null ? I.ack - ALERT : null, mttr: rec != null ? rec - ONSET : null, budget: failed / (BIZ.month * (1 - SLO)) };
    };
    const correctSev = err => err >= 0.25 ? ['SEV1'] : err >= 0.2 ? ['SEV1', 'SEV2'] : err >= 0.01 ? ['SEV2'] : ['SEV3'];
    const night = () => { const I = U.I, ps = new Set(Object.values(I.roles).filter(p => p !== 'me')); if (I.snooze) ps.add('oleg'); return [...ps]; };

    /* ---------- панель инцидента: часы, ошибки, потери ---------- */
    function barHTML() {
      const I = U.I, S = stats(), x = now(), B = isBiz(), state = S.rec != null ? ['ok', 'восстановлено в ' + hm(S.rec)] : I.declared != null ? ['bad', `идёт · ${I.sev || 'без уровня'}`] : I.ack != null ? ['warn', 'подтверждён, не объявлен'] : ['bad', 'алерт не подтверждён'];
      return `<div class="loc-bar" role="status"><span class="loc-clock">⏱ ${hm(I.t)}</span><span class="loc-chip ${state[0]}">${state[1]}</span>
        <span>${B ? 'Заказы с ошибкой' : 'Ошибки оформления'}: <b class="${x.err >= 0.01 ? 'bad' : 'ok'}">${pc(x.err)}</b></span>
        <span>${B ? 'Ушли без заказа' : 'Потеряно заказов'}: <b>${nf(S.lost)}</b> · <b>${rubK(S.rub)}</b></span>
        ${S.rec == null && I.ack != null ? `<span class="loc-muted">сейчас ≈ ${rub(lostAt(I.t) * BIZ.check)} в минуту</span>` : ''}
        <button type="button" class="btn ghost loc-reset" data-act="restart-lab">Начать заново</button></div>`;
    }

    /* ---------- графики ---------- */
    const CH = {
      err: { n: 'Ошибки оформления, %', nb: 'Заказы с ошибкой, %', v: x => x.err, max: v => [0.1, 0.3, 0.5, 1].find(k => k >= v) || 1, fmt: v => pc(v, 0), thr: (1 - SLO) * BURN, thrL: 'порог алерта', cls: 'err' },
      p99: { n: 'Задержка p99, мс', nb: 'Ожидание оформления (худшие 1 %), мс', v: x => x.p99 == null ? 3000 : x.p99, max: () => 3200, fmt: v => nf(v), thr: 2000, thrL: 'порог 2 000 мс', cls: 'lat' },
      pool: { n: 'Пул соединений к базе, занято', nb: 'Занято соединений с базой', v: x => x.pool, max: () => 1, fmt: v => pc(v, 0), thr: 0.8, thrL: '80 %', cls: 'pool' },
      lost: { n: 'Потеряно заказов, нарастающим итогом', nb: 'Потерянная выручка, нарастающим итогом', v: null, cum: true, max: v => Math.max(10, Math.ceil(v / 10) * 10 * 1.15), fmt: v => nf(v), cls: 'lost' }
    };
    function chartSVG(key, W, H) {
      const I = U.I, c = CH[key], B = isBiz(), x0 = T(2, 45), x1 = Math.min(M1, Math.max(T(3, 35), I.t + 8));
      const ml = 46, mr = 10, mt = 10, mb = 20, iw = W - ml - mr, ih = H - mt - mb, X = m => ml + iw * (m - x0) / (x1 - x0);
      const data = []; let cum = 0;
      for (let m = x0; m <= I.t; m++) { const r = rowAt(rows, m); if (c.cum) { if (m >= ONSET && (recAt() == null || m < recAt())) cum += B ? lostAt(m) * BIZ.check : lostAt(m); data.push(cum); } else data.push(c.v(r)); }
      const vmax = c.cum ? c.max(Math.max(...data, 1)) : c.max(Math.max(...data));
      const Y = v => mt + ih * (1 - Math.min(1, v / vmax));
      let h = `<svg class="loc-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(c.n)}">`;
      [0, vmax / 2, vmax].forEach(v => { h += ln(ml, Y(v), W - mr, Y(v), 'loc-grid') + tx(ml - 6, Y(v) + 4, c.cum && B ? rubK(v).replace(' ₽', '') : c.fmt(v), 'loc-ax', 'end'); });
      if (c.thr != null && c.thr < vmax) h += ln(ml, Y(c.thr), W - mr, Y(c.thr), 'loc-thr') + tx(W - mr - 2, Y(c.thr) - 4, c.thrL, 'loc-thrt', 'end');
      for (let m = Math.ceil(x0 / 15) * 15; m <= x1; m += 15) h += tx(X(m), H - 5, hm(m), 'loc-ax', 'middle');
      const marks = [{ m: ALERT, cls: 'warn', n: 'А' }].concat(I.acts.map((a, i) => ({ m: a.at, cls: ACT[a.k].kind === 'fix' ? 'ok' : ACT[a.k].kind === 'bad' ? 'bad' : '', n: i + 1 })));
      marks.forEach(k => { if (k.m < x0 || k.m > x1) return; h += ln(X(k.m), mt, X(k.m), mt + ih, 'loc-mark ' + k.cls) + `<circle class="loc-mkc ${k.cls}" cx="${f1(X(k.m))}" cy="${mt + 8}" r="8"/>` + tx(X(k.m), mt + 12, k.n, 'loc-mkn', 'middle'); });
      if (data.length > 1) h += `<path class="loc-line ${c.cls}" d="${data.map((v, i) => `${i ? 'L' : 'M'}${f1(X(x0 + i))} ${f1(Y(v))}`).join(' ')}"/>`;
      h += ln(X(I.t), mt, X(I.t), mt + ih, 'loc-now');
      return h + '</svg>';
    }
    function chartsHTML(keys, extra) {
      const B = isBiz(), x = now(), S = stats();
      return `<div class="loc-charts">${keys.map(k => { const c = CH[k], val = k === 'lost' ? (B ? rubK(S.rub) : nf(S.lost)) : k === 'err' ? pc(x.err) : k === 'p99' ? (x.p99 == null ? 'нет ответов' : nf(x.p99) + ' мс') : `${Math.round(x.pool * CAP)} из ${CAP}`; return `<div class="loc-ch"><div class="loc-ch-h"><b>${B ? c.nb : c.n}</b><span class="${(k === 'err' && x.err >= 0.01) || (k === 'pool' && x.pool >= 0.99) || (k === 'p99' && (x.p99 == null || x.p99 > 2000)) ? 'bad' : ''}">${val}</span></div><div class="loc-chbox" data-chart="${k}"></div></div>`; }).join('')}${extra || ''}</div>${legend([['warn', 'А — алерт'], ['ok', 'действие, которое чинит'], ['bad', 'действие, которое не помогло'], ['mut', 'подождать']])}`;
    }
    function fillCharts() { EL.querySelectorAll('[data-chart]').forEach(el => { const w = Math.max(300, Math.floor(el.clientWidth || 400)); el.innerHTML = chartSVG(el.dataset.chart, w, 132); }); }

    /* ---------- шапка и отрисовка ---------- */
    function setTab(k) {
      if (!TABS.some(t => t[0] === k)) return;
      U.tab = k; U.msg = null;
      EL.querySelectorAll('.loc-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.loc-tabs'), box = EL.closest('.lab-main');
      if (tabs && box && tabs.getBoundingClientRect().top < box.getBoundingClientRect().top) tabs.scrollIntoView({ block: 'start' });
    }
    function setMode(m) {
      MODE = m === 'biz' ? 'biz' : 'tech';
      try { localStorage.setItem(MODE_KEY, MODE); } catch (e) { /* без хранилища */ }
      EL.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === MODE)));
      render(true);
    }
    const VIEWS = {}, AFTER = {};
    function render(keep) {
      const v = $('#locView'); if (!v) return;
      const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0;
      v.innerHTML = VIEWS[U.tab] ? VIEWS[U.tab]() : card('', 'Раздел готовится.');
      fillCharts();
      if (AFTER[U.tab]) AFTER[U.tab]();
      if (keep !== false && box) box.scrollTop = y;
      checkTasks();
    }
    const CHECKS = [];
    function checkTasks() { CHECKS.forEach(f => { try { f(); } catch (e) { /* проверка задания не должна ломать лабораторию */ } }); }

    /* ================= вкладка 1: алерт ================= */
    const ALERT_TXT = {
      life: 'Пожарная сигнализация звенит не от «в подвале стало теплее на 3 градуса», а от дыма в коридоре — того, что угрожает людям. И если она звенит каждую ночь зря, однажды её просто выключат.',
      plain: 'Будить человека ночью стоит, только когда покупатели уже страдают и страдать будут быстро. Сработал такой сигнал — проснись, подтверди, что взял, оцени, насколько всё плохо, и собери людей с понятными ролями.',
      term: '<b>Алерт по симптому</b> (что видит пользователь), а не по причине (CPU, память). <b>Burn rate</b> — во сколько раз быстрее нормы сгорает бюджет ошибок SLO; правило «14,4 за 1 час и за 5 минут» значит: за час сгорит 2 % месячного бюджета. <b>Ack</b> — подтверждение «взял», иначе алерт эскалируется дальше. <b>SEV</b> — уровень серьёзности. <b>Incident commander</b> (ведущий), <b>communications</b> (связь), <b>ops</b> (разбор) — роли.'
    };
    const SEVS = [['SEV1', 'SEV1', 'оформление или оплата не работают у 25 % покупателей и больше, деньги, данные'], ['SEV2', 'SEV2', 'важная функция сломана у части покупателей (1–25 %), есть обход'], ['SEV3', 'SEV3', 'мелочь: покупатели почти не замечают, чиним днём']];
    function rolesFeedback(r) {
      const out = [];
      if (r.comms === r.ops) out.push(['warn', `Связь и разбор у одного человека (${PN[r.ops]}): каждое сообщение на страницу статуса отнимает у разбора ≈ 3 минуты.`]);
      else out.push(['ok', `Связь у ${r.comms === 'marina' ? 'Марины — она знает, что говорить покупателям' : PN[r.comms]}: разбор не отвлекается на сообщения.`]);
      if (r.ic === 'marina') out.push(['warn', 'Ведущей технического инцидента сделали менеджера поддержки: ей трудно оценивать технические решения. Пусть лучше ведёт связь.']);
      else if (r.ic === r.ops) out.push(['warn', `Ведущий сам копается в логах (${PN[r.ic]}): некому следить за временем и решениями. Ночью в маленькой команде допустимо, но разбор пойдёт медленнее (+1 мин на проверку).`]);
      else out.push(['ok', `Ведущий (${PN[r.ic]}) не чинит сам — следит за временем и решениями.`]);
      if (r.ops === 'oleg') out.push(['ok', 'Разбор у Олега — эксперта по базе: проверки быстрее на минуту. Цена — ночной вызов.']);
      return out;
    }
    VIEWS.alert = () => {
      const I = U.I, B = isBiz(), x = now(), S = stats();
      const page = `<div class="loc-phone" aria-label="Уведомление на телефоне дежурного"><div class="loc-ph-top"><span>${hm(ALERT)}</span><span>дежурство</span></div>
        <div class="loc-push ${I.ack != null ? 'acked' : ''}"><b>[P1] checkout: бюджет ошибок сгорает в ${dec(winErr(BASE, ALERT, 60) / (1 - SLO), 0)} раз быстрее нормы</b>
        <span>SLO оформления 99,9 % за 30 дней. За 5 минут ошибок ${pc(winErr(BASE, ALERT, 5))} (норма ≤ 0,1 %), за час — ${pc(winErr(BASE, ALERT, 60))}.</span>
        <span>Дашборд: checkout · Рунбук: «Растут ошибки оформления»</span><span class="loc-esc">${I.ack != null ? `подтверждено в ${hm(I.ack)}` : 'не подтвердишь за 5 минут — позвоним второму дежурному'}</span></div></div>`;
      const alt = `<div class="loc-alts"><b class="loc-h">${B ? 'Что могло бы прийти вместо' : 'Альтернативы, которые не стоит слать ночью'}</b>
        <div class="loc-alt bad"><b>«CPU 82 % на db-1»</b><span>Причина, а не симптом: за прошлый месяц сработал бы 37 раз, покупатели страдали 0 раз. Через неделю такие алерты перестают читать. А сегодня CPU базы — 45 %: этот алерт бы промолчал.</span></div>
        <div class="loc-alt bad"><b>«Под checkout-3 перезапустился»</b><span>Kubernetes перезапускает поды сам; один под из пяти — не повод будить. Покупатель этого не видит.</span></div>
        <div class="loc-alt ok"><b>«Сгорает бюджет ошибок оформления»</b><span>Симптом, который видит покупатель, плюс скорость: если ничего не делать, за час сгорит 2 % месячного бюджета. Есть ссылка на дашборд и рунбук.</span></div></div>`;
      let h = `${barHTML()}${ana(ALERT_TXT.life, ALERT_TXT.plain, B ? '' : ALERT_TXT.term)}<div class="loc-two">${page}${alt}</div>`;
      /* шаг 1 */
      h += `<div class="loc-step ${I.ack != null ? 'done' : 'on'}"><div class="loc-sh"><i>1</i><b>Проснуться и подтвердить</b>${I.ack != null ? `<span class="loc-chip ok">в ${hm(I.ack)}</span>` : ''}</div>`;
      if (I.ack == null) h += `<p class="loc-p">Сейчас ${hm(I.t)}. Телефон звонит. Пока алерт не подтверждён, он считается ничьим.</p><div class="loc-btns"><button type="button" class="btn primary" data-act="ack">Подтвердить и открыть ноутбук · 2 мин</button><button type="button" class="btn" data-act="snooze">Отложить на 10 минут — вдруг само пройдёт</button></div>`;
      else h += `<p class="loc-p">${I.snooze ? `Алерт отложили. В ${hm(ALERT + 5)} система позвонила второму дежурному (Олегу), в ${hm(I.ack)} ты всё-таки сел за ноутбук. Пока алерт лежал, ушло без заказа ≈ ${ords(lostBetween(ALERT, I.ack, true))} — ${rubK(lostBetween(ALERT, I.ack, true) * BIZ.check)}.` : `Подтвердил в ${hm(I.ack)} — через ${mins(I.ack - ALERT)} после алерта. Эскалации не было.`}</p>`;
      h += '</div>';
      /* шаг 2 */
      const sevOpen = I.ack != null;
      h += `<div class="loc-step ${!sevOpen ? 'off' : I.sev ? 'done' : 'on'}"><div class="loc-sh"><i>2</i><b>Оценить масштаб и уровень</b>${I.sev ? `<span class="loc-chip ${I.sevOk ? 'ok' : 'warn'}">${I.sev}</span>` : ''}</div>`;
      if (sevOpen) {
        h += `<div class="loc-kpis">${tile(B ? 'Заказы с ошибкой сейчас' : 'Ошибки оформления сейчас', pc(x.err), 'было 0,1 % до 03:07', 'bad')}${tile('Задето покупателей', nf(S.users), `с ${hm(ONSET)}, уникальных — примерно`, 'bad')}${tile(B ? 'Уходит заказов в минуту' : 'Потери в минуту', dec(lostAt(I.t), 1), `≈ ${rub(lostAt(I.t) * BIZ.check)} в минуту`, 'warn')}${tile('Что задето', 'оформление', 'каталог и корзина работают')}</div>
          <div class="loc-sevs">${SEVS.map(([k, n, d]) => `<button type="button" data-set="sev:${k}" aria-pressed="${I.sev === k}"><b>${n}</b><small>${d}</small></button>`).join('')}</div>`;
        if (I.sev) h += card(I.sevOk ? 'ok' : 'warn', I.sevOk ? `<b>${I.sev} — верно.</b> Ошибок ${pc(rowAt(rows, I.sevAt).err)}: ${I.sev === 'SEV1' ? 'четверть оформлений падает — это SEV1: будим всех, кого нужно, сразу.' : 'сломано у части покупателей, остальные оформляют. Если станет хуже 25 % — поднимем до SEV1.'}` : `<b>${I.sev}?</b> При ${pc(rowAt(rows, I.sevAt).err)} ошибок оформления верный уровень — ${correctSev(rowAt(rows, I.sevAt).err).join(' или ')}. ${+I.sev.slice(3) > +correctSev(rowAt(rows, I.sevAt).err)[0].slice(3) ? 'Занизить уровень — значит не позвать помощь, не написать покупателям и обновлять статус слишком редко.' : 'Завысить не страшно, но SEV1 будит руководство и всю команду.'} Выбери ещё раз.`);
      }
      h += '</div>';
      /* шаг 3 */
      const rOpen = !!I.sevOk;
      h += `<div class="loc-step ${!rOpen ? 'off' : I.declared != null ? 'done' : 'on'}"><div class="loc-sh"><i>3</i><b>Объявить инцидент и раздать роли</b>${I.declared != null ? `<span class="loc-chip ok">в ${hm(I.declared)}</span>` : ''}</div>`;
      if (rOpen) {
        h += `<div class="loc-roles">${ROLES.map(([k, n, d]) => `<div class="loc-role"><b>${n}</b><small>${d}</small>${seg('role-' + k, PEOPLE.map(p => [p[0], p[1]]), I.roles[k], n, I.declared != null)}</div>`).join('')}</div>
          <ul class="loc-fb">${rolesFeedback(I.roles).map(([c, t]) => `<li class="${c}">${t}</li>`).join('')}</ul>`;
        if (I.declared == null) h += `<div class="loc-btns"><button type="button" class="btn primary" data-act="declare">Объявить инцидент · 1 мин</button></div>`;
        else h += card('ok', `<b>Канал #inc-${hm(I.declared).replace(':', '')}-checkout создан.</b> Ведущий — ${PN[I.roles.ic]}, разбор — ${PN[I.roles.ops]}, связь — ${PN[I.roles.comms]}. ${night().length ? `Разбудили: ${night().map(p => PN[p]).join(', ')}.` : 'Никого не будили — всё на тебе.'} Дальше — разбор.`);
      }
      h += '</div>';
      if (B) {
        const calls = night().length;
        h += card('biz', `<b>Для бизнеса.</b> ${S.rec != null ? `Оформление работает с ${hm(S.rec)}; сбой обошёлся в ≈ ${rubK(S.rub)}.` : `Сейчас каждая минута — ≈ ${dec(lostAt(I.t), 1)} ${plural(lostAt(I.t), 'ушедший заказ', 'ушедших заказа', 'ушедших заказов')}, ≈ <b>${rub(lostAt(I.t) * BIZ.check)}</b>.`} Ночной вызов второго человека стоит ≈ ${rub(BIZ.call)} (доплата и отгул) — это меньше минуты сбоя${calls ? `; сегодня разбудили ${calls}: ${rub(calls * BIZ.call)}` : ''}. «Отложить на 10 минут» стоит ≈ ${rubK(lostBetween(ALERT, ALERT + 10) * BIZ.check)} — дороже десятка ночных вызовов.`)
          + asm([`средний чек ${rub(BIZ.check)}`, `из получивших ошибку ${pc(BIZ.abandon, 0)} уходят и не возвращаются`, `ночной вызов — ${rub(BIZ.call)}: доплата за выход и полдня отгула`, 'попыток оформления ночью — 12 в минуту, в утренний пик Дальнего Востока — 40']);
      }
      return h + nextBtn('alert');
    };
    /* потери за отрезок по базовому прогону (без действий) */
    function lostBetween(a, b, cur) { let s = 0; for (let m = a; m < b; m++) s += cur ? lostAt(m) : rowAt(BASE, m).lost; return s; }

    /* ================= вкладка «Итоги» ================= */
    VIEWS.memo = () => {
      const L = isBiz() ? MEMO_BIZ : MEMO;
      return `<b class="loc-h">Что запомнить</b><div class="loc-memo">${L.map(([t, xs]) => `<div class="loc-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>`;
    };

    /* ---------- события ---------- */
    const ACTIONS = {
      ack: () => { const I = U.I; if (I.ack != null) return; spend(2); I.ack = I.t; log('ack', 'Дежурный подтвердил алерт и сел за ноутбук', 'ok'); },
      snooze: () => { const I = U.I; if (I.ack != null) return; I.snooze = true; log('esc', 'Алерт отложен — через 5 минут система позвонила второму дежурному', 'bad', ALERT + 5); spend(10); I.ack = I.t; log('ack', 'Дежурный подтвердил алерт после откладывания', 'warn'); },
      declare: () => { const I = U.I; if (I.declared != null || !I.sevOk) return; spend(1); I.declared = I.t; log('decl', `Объявлен инцидент ${I.sev}: ведущий — ${PN[I.roles.ic]}, разбор — ${PN[I.roles.ops]}, связь — ${PN[I.roles.comms]}`, 'ok'); },
      'restart-lab': () => { U.I = fresh(); resim(); }
    };
    const PARAM = {
      logf: v => { U.I.logf = v; },
      trace: v => { U.I.trace = v; },
      sev: v => { const I = U.I; if (I.ack == null) return; I.sev = v; I.sevAt = I.t; I.sevOk = correctSev(now().err).includes(v); if (I.sevOk) log('sev', `Уровень ${v}: ошибок оформления ${pc(now().err)}`, ''); }
    };
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-go],[data-mode],[data-set],[data-act],[data-do],[data-hyp],[data-verdict]');
      if (!b || !EL.contains(b) || b.disabled) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.go) return setTab(d.go);
      if (d.mode) return setMode(d.mode);
      if (d.set) {
        const i = d.set.indexOf(':'), k = d.set.slice(0, i), v = d.set.slice(i + 1);
        if (k.startsWith('role-')) { if (U.I.declared == null) U.I.roles[k.slice(5)] = v; render(); return; }
        if (k.startsWith('own-')) { U.I.owners[k.slice(4)] = v; render(); return; }
        if (PARAM[k]) { PARAM[k](v, b); render(); }
        return;
      }
      if (d.do) { doAct(d.do); render(); return; }
      if (d.hyp) { doCheck(d.hyp); render(); return; }
      if (d.verdict) { const [id, v] = d.verdict.split(':'); doVerdict(id, v); render(); return; }
      if (d.act && ACTIONS[d.act]) { ACTIONS[d.act](b); resim(); render(); }
    }

    /* ---------- сборка ---------- */
    EL.innerHTML = `<div class="loc"><div class="loc-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}<div class="seg loc-mode" role="group" aria-label="Как объяснять">${[['tech', 'Техника'], ['biz', 'Бизнес']].map(([k, t]) => `<button type="button" data-mode="${k}" aria-selected="${MODE === k}">${t}</button>`).join('')}</div></div><div class="loc-view" id="locView"></div></div>`;
    EL.addEventListener('click', onClick);
    CHECKS.push(() => { const I = U.I; if (I.ack != null && I.sevOk && I.declared != null && I.roles.comms !== I.roles.ops) done('ack'); });
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { fillCharts(); if (AFTER[U.tab]) AFTER[U.tab](); }); }) : null;
    if (ro) ro.observe(EL);
    /* ================= вкладка 2: разбор ================= */
    const HYP = [
      { id: 'db', n: 'База данных упала или перегружена', chk: 'метрики базы', cost: 2, ok: false,
        ev: 'База жива: CPU 45 %, диск 30 %, реплика отстаёт на 0,2 с. Но соединений занято 100 из 100 — упираемся не в мощность базы, а в число соединений.',
        why: 'База быстрая и не перегружена — гипотеза не подтверждается. Но зацепка есть: соединения кончились.' },
      { id: 'bots', n: 'Наплыв ботов или атака', chk: 'трафик по источникам', cost: 2, ok: false,
        ev: 'Трафик втрое выше ночного, но так же было в прошлый вторник: утро на Дальнем Востоке, а в 03:00 ушла рассылка с промокодом. Ботов 3 % — как всегда.',
        why: 'Трафик вырос по расписанию — это спусковой крючок, а не причина: неделю назад такой же пик прошёл без ошибок.' },
      { id: 'pay', n: 'Тормозит платёжный провайдер', chk: 'трейс медленного оформления', cost: 3, ok: false,
        ev: 'Оплата в трейсе — 180 мс, как обычно. Почти всё время запрос ждёт свободное соединение с базой и через 3 с падает. В успешном ночном запросе — 12 одинаковых SELECT к promo_rules.',
        why: 'Оплата быстрая — не она. Зато трейс показал, где теряется время: ожидание соединения и 12 запросов правил промо.' },
      { id: 'rel', n: 'Новая версия v2.14 расходует соединения', chk: 'изменения за сутки и запросы к базе на заказ', cost: 2, ok: true,
        ev: 'В 22:40 выкатили checkout v2.14: новый расчёт промо за флагом promo_rules_v2, включён на 100 %. С тех пор на одно оформление 14 запросов к базе вместо 2, соединение занято 0,6 с вместо 0,1. Ночью при 60 запросах в секунду хватало 36 соединений из 90, в пик нужно 120. В логах — «too many clients».',
        why: 'Всё сходится: изменение (22:40), механизм (соединение держится в 6 раз дольше) и симптом (пул 90 из 90, «too many clients»).' },
      { id: 'net', n: 'Сеть между подами и базой', chk: 'задержку и потери в сети', cost: 2, ok: false,
        ev: 'Задержка до базы 0,4 мс, потерь пакетов нет — как вчера.', why: 'Сеть в норме — гипотеза не подтверждается.' }
    ];
    const checkCost = h => { const I = U.I, r = I.roles; return Math.max(1, h.cost - (I.declared != null && r.ops === 'oleg' ? 1 : 0) + (I.declared == null || r.ic === r.ops ? 1 : 0)); };
    const DIG_TXT = {
      life: 'Врач в приёмном покое не начинает с операции: сначала давление и пульс (метрики), потом расспросы (логи), потом снимок того места, где болит (трейс). И каждую догадку проверяет анализом, а не уверенностью.',
      plain: 'Смотрим, что болит и с какого момента, ищем, что менялось перед этим, и проверяем догадки по одной. Каждая проверка стоит минут — начинай с самой вероятной: чаще всего ломает то, что недавно выкатили.',
      term: '<b>Метрики</b> отвечают «что и когда», <b>логи</b> — «что именно пишет сервис», <b>трейс</b> (distributed tracing) — «на каком шаге запроса ушло время». <b>Пул соединений</b> (HikariCP) — ограниченный набор открытых соединений к базе; когда занят весь, запрос ждёт до таймаута. <b>N+1</b> — запрос в цикле: один на каждый товар вместо одного на всю корзину.'
    };
    const LOGF = [['all', 'Все'], ['checkout', 'checkout'], ['db', 'база'], ['other', 'прочие']];
    function logLines() {
      const I = U.I, out = [], sec = (m, k) => (m * 37 + k * 23) % 60;
      for (let m = Math.max(M0, I.t - 7); m <= I.t; m++) {
        const r = rowAt(rows, m), reqFail = Math.round(r.r * 60 * r.err);
        I.acts.filter(a => a.at === m).forEach(a => {
          const L = { flag: ['checkout', 'INFO', 'flag promo_rules_v2 → off (изменено вручную, распространено на 5 подов)'], rollback: ['k8s', 'INFO', 'deployment/checkout rolled back to revision 41 (v2.13), rolling update started'], scale: ['k8s', 'INFO', 'Scaled replica set checkout from 5 to 10'], restart: ['k8s', 'WARN', 'Killing 5 pods checkout-* (rollout restart); Readiness probe failed'], pool: ['k8s', 'INFO', 'ConfigMap checkout-config: maximumPoolSize 18 → 30; rolling restart'], failover: ['db', 'WARN', 'db-2 promoted to primary; db-1 fenced'], wait: null }[a.k];
          if (L) out.push({ m, s: 1, src: L[0], lvl: L[1], t: L[2] });
        });
        if (r.err >= 0.02 && r.err < 0.99) out.push({ m, s: sec(m, 1), src: 'checkout', lvl: 'ERROR', t: `HikariPool-1 — Connection is not available, request timed out after 3000ms (×${nf(reqFail)} за минуту)` });
        if (r.pool >= 0.99 && r.err < 0.99) out.push({ m, s: sec(m, 2), src: 'db', lvl: 'FATAL', t: `sorry, too many clients already (×${nf(Math.max(3, reqFail / (r.pods === 10 ? 4 : 20)))} за минуту)` });
        if (r.err >= 0.99) out.push({ m, s: sec(m, 3), src: 'checkout', lvl: 'ERROR', t: 'upstream connect error: no healthy upstream (503)' });
        if (r.p99 != null && r.p99 > 1500 && m % 2 === 0) out.push({ m, s: sec(m, 4), src: 'checkout', lvl: 'WARN', t: `slow request POST /api/checkout ${nf(Math.min(3000, r.p99 - 40))} ms` });
        if (m % 3 === 0) out.push({ m, s: sec(m, 5), src: 'payments', lvl: 'INFO', t: 'authorize ok, p50 172 ms' });
        if (m % 4 === 1) out.push({ m, s: sec(m, 6), src: 'recommendations', lvl: 'WARN', t: 'cache hit ratio 87 % (target 90 %)' });
        if (m % 5 === 2) out.push({ m, s: sec(m, 7), src: 'db', lvl: 'LOG', t: 'checkpoint complete: wrote 1 204 buffers (0,7 %)' });
      }
      const f = I.logf, keep = x => f === 'all' || (f === 'checkout' && x.src === 'checkout') || (f === 'db' && x.src === 'db') || (f === 'other' && x.src !== 'checkout' && x.src !== 'db');
      return out.filter(keep).sort((a, b) => a.m - b.m || a.s - b.s).slice(-14);
    }
    function logsHTML() {
      const xs = logLines();
      return xs.length ? xs.map(x => `<li class="${x.lvl === 'ERROR' || x.lvl === 'FATAL' ? 'bad' : x.lvl === 'WARN' ? 'warn' : ''}"><span class="loc-ft">${hm(x.m)}:${p2(x.s)}</span><span class="loc-src">${x.src}</span><span class="loc-lvl">${x.lvl}</span><span>${esc(x.t)}</span></li>`).join('') : '<li class="mut">Под этот фильтр за последние минуты ничего нет.</li>';
    }
    const TRACES = {
      fail: { n: `упавший запрос ${hm(ALERT + 1)}:41`, total: 3020, err: true, spans: [['POST /api/checkout', 0, 3020, 'root bad'], ['auth.verify', 2, 16, ''], ['SELECT cart (1 запрос)', 16, 44, 'db'], ['ожидание соединения из пула', 44, 3020, 'wait'], ['→ ошибка 500 через 3 с', 3020, 3020, 'bad']] },
      ok: { n: 'успешный запрос 01:52:10 (ночью)', total: 812, spans: [['POST /api/checkout', 0, 812, 'root'], ['auth.verify', 2, 15, ''], ['ожидание соединения из пула', 15, 17, ''], ['SELECT cart (1 запрос)', 17, 40, 'db'], ['SELECT promo_rules ×12 — по товару', 40, 582, 'db hot'], ['payment.authorize', 590, 770, 'pay'], ['INSERT order', 770, 805, 'db']] }
    };
    function traceSVG(W) {
      const tr = TRACES[U.I.trace], L = 290, R = 70, rowH = 24, H = tr.spans.length * rowH + 30, X = ms => L + (W - L - R) * ms / tr.total;
      let h = `<svg class="loc-trace" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Трейс запроса оформления">`;
      for (let k = 0; k <= 4; k++) { const ms = tr.total * k / 4, x = X(ms); h += ln(x, 4, x, H - 22, 'loc-grid') + tx(x, H - 6, nf(ms) + ' мс', 'loc-ax', k === 0 ? 'start' : k === 4 ? 'end' : 'middle'); }
      tr.spans.forEach(([n, a, b, cls], i) => {
        const y = 6 + i * rowH, ind = i === 0 ? 0 : 14;
        h += tx(8 + ind, y + 14, esc(n), 'loc-spn' + (cls.includes('bad') ? ' bad' : cls.includes('wait') ? ' warn' : cls.includes('hot') ? ' acc' : ''));
        if (n.startsWith('SELECT promo_rules')) { for (let k = 0; k < 12; k++) { const s = a + k * 45; h += rc(X(s), y + 4, Math.max(2, X(s + 40) - X(s)), 14, 'loc-span hot', 2); } }
        else if (b > a) h += rc(X(a), y + 4, Math.max(2, X(b) - X(a)), 14, 'loc-span ' + cls, 2);
        else h += `<circle class="loc-spdot" cx="${f1(X(a))}" cy="${y + 11}" r="5"/>`;
        if (b > a) h += tx(Math.min(W - 4, X(b) + 6), y + 15, nf(b - a) + ' мс', 'loc-ax');
      });
      return h + '</svg>';
    }
    function qpoSVG(W, H) {
      const I = U.I, a0 = T(21, 0), a1 = I.t + 1440, ml = 30, mr = 10, mt = 10, mb = 20, iw = W - ml - mr, ih = H - mt - mb, X = m => ml + iw * (m - a0) / (a1 - a0), Y = v => mt + ih * (1 - v / 16);
      const pts = [];
      for (let m = a0; m <= a1; m += 5) { const am = m >= 1440 ? m - 1440 : m; const v = m < DEPLOY ? 2 : am >= M0 - 60 && am <= M1 && m >= 1440 ? rowAt(rows, am).qpo : 14; pts.push([m, v]); }
      let h = `<svg class="loc-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Запросов к базе на одно оформление за ночь">`;
      [0, 8, 16].forEach(v => { h += ln(ml, Y(v), W - mr, Y(v), 'loc-grid') + tx(ml - 6, Y(v) + 4, String(v), 'loc-ax', 'end'); });
      [T(22, 0), T(24, 0), T(26, 0)].forEach(m => { if (m < a1) h += tx(X(m), H - 5, hm(m), 'loc-ax', 'middle'); });
      h += ln(X(DEPLOY), mt, X(DEPLOY), mt + ih, 'loc-mark warn') + tx(X(DEPLOY) + 4, mt + 12, 'v2.14 · 22:40', 'loc-thrt');
      h += `<path class="loc-line qpo" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${f1(X(p[0]))} ${f1(Y(p[1]))}`).join(' ')}"/>`;
      return h + '</svg>';
    }
    function hypHTML() {
      const I = U.I;
      return HYP.map(hh => {
        const ck = I.checks[hh.id], vd = I.verdict[hh.id], wr = I.wrong[hh.id];
        const chip = vd === 'yes' ? ['ok', 'подтверждена'] : vd === 'no' ? ['mut', 'отвергнута'] : ck != null ? ['warn', 'проверена — реши'] : ['', 'не проверена'];
        let h = `<div class="loc-hyp ${vd === 'yes' ? 'yes' : vd === 'no' ? 'no' : ''}"><div class="loc-hh"><b>${hh.n}</b><span class="loc-chip ${chip[0]}">${chip[1]}</span></div>`;
        if (ck == null) h += `<div class="loc-btns"><button type="button" class="btn" data-hyp="${hh.id}" ${I.ack == null || I.t >= M1 ? 'disabled' : ''}>Проверить ${hh.chk} · ${checkCost(hh)} мин</button></div>`;
        else {
          h += `<p class="loc-ev"><span class="loc-ft">${hm(ck)}</span> ${hh.ev}</p>`;
          if (!vd) h += `<div class="loc-btns"><button type="button" class="btn" data-verdict="${hh.id}:yes">Подтвердить</button><button type="button" class="btn" data-verdict="${hh.id}:no">Отвергнуть</button></div>${wr ? `<p class="loc-wr">${wr}</p>` : ''}`;
          else h += `<p class="loc-why">${hh.why}</p>`;
        }
        return h + '</div>';
      }).join('');
    }
    const quickHTML = () => { const I = U.I, dis = I.ack == null || recAt() != null || I.t >= M1; return `<div class="loc-quick"><b class="loc-h">${isBiz() ? 'Соблазн сделать хоть что-нибудь' : 'Быстрые ходы, пока причина неясна'}</b><p class="loc-p">Ночью руки тянутся «сделать хоть что-то». Эти ходы есть и на вкладке «Действие» — их след останется на графиках.</p><div class="loc-btns">${['restart', 'scale'].map(k => `<button type="button" class="btn" data-do="${k}" ${dis ? 'disabled' : ''}>${ACT[k].n} · ${ACT[k].cost} мин</button>`).join('')}</div></div>`; };
    VIEWS.dig = () => {
      const I = U.I, B = isBiz();
      let h = `${barHTML()}${ana(DIG_TXT.life, DIG_TXT.plain, B ? '' : DIG_TXT.term)}`;
      if (I.ack == null) h += card('warn', '<b>Алерт ещё не подтверждён.</b> Пока никто не взял инцидент, разбор не начинается. <button type="button" class="btn" data-go="alert">К алерту</button>');
      h += chartsHTML(['err', 'p99', 'pool'], `<div class="loc-ch"><div class="loc-ch-h"><b>${B ? 'Запросов к базе на один заказ, за ночь' : 'Запросов к базе на одно оформление (с 21:00)'}</b><span>${dec(now().qpo, 0)}</span></div><div class="loc-chbox" data-qpo></div></div>`);
      h += `<div class="loc-box"><div class="loc-boxh"><b class="loc-h">Логи · последние минуты</b>${seg('logf', LOGF, I.logf, 'Фильтр логов')}</div><ol class="loc-logs">${logsHTML()}</ol></div>
        <div class="loc-box"><div class="loc-boxh"><b class="loc-h">Трейс одного оформления</b>${seg('trace', [['fail', 'упавший сейчас'], ['ok', 'успешный ночью']], I.trace, 'Какой трейс')}</div><div class="loc-tracebox" id="locTrace"></div><small class="loc-sub">${I.trace === 'fail' ? 'Почти весь запрос — ожидание соединения из пула; через 3 с — ошибка.' : 'Ночью соединение дают сразу, но правила промо грузятся 12 раз — по запросу на каждый товар корзины.'}</small></div>`;
      h += `<b class="loc-h">${B ? 'Версии: почему не оформляются заказы' : 'Гипотезы — проверяй по одной'}</b><div class="loc-hyps">${hypHTML()}</div>`;
      if (I.found != null) h += card('ok', `<b>Причина найдена в ${hm(I.found)}</b> — через ${mins(I.found - ONSET)} от начала сбоя. Теперь — остановить кровотечение на вкладке «Действие». ${recAt() != null ? 'Ты его уже остановил — отлично: безопасный шаг можно делать и до полного доказательства.' : ''}`);
      h += quickHTML();
      if (B) { h += card('biz', `<b>Для бизнеса.</b> Каждая проверка — 2–3 минуты, сейчас минута стоит ≈ ${rub(lostAt(I.t) * BIZ.check)}. Поэтому сначала проверяют самое вероятное — то, что недавно меняли. Позвать эксперта по базе ночью (≈ ${rub(BIZ.call)}) окупается, если он сэкономит хотя бы минуту.`); }
      return h + nextBtn('dig');
    };
    AFTER.dig = () => {
      const tb = $('#locTrace'); if (tb) tb.innerHTML = traceSVG(Math.max(520, Math.floor(tb.clientWidth || 600)));
      const q = $('[data-qpo]'); if (q) q.innerHTML = qpoSVG(Math.max(300, Math.floor(q.clientWidth || 400)), 132);
    };

    /* ================= вкладка 3: действие ================= */
    const EFFECT = {
      flag: ['ok', 'Флаг выключен: новый расчёт промо больше не вызывается, соединение снова занято 0,1 с. Ошибки уходят за минуту — без выкладки.'],
      rollback: ['ok', 'Откат идёт: поды v2.13 сменяют v2.14 по одному, с каждым подом ошибок меньше. Через 4 минуты — норма.'],
      scale: ['bad', '10 подов × 18 = 180 соединений, а база даёт 90. Новые поды не получают соединений и долбят базу попытками подключиться — база тратит CPU, запросы держат соединение дольше. Стало хуже.'],
      restart: ['bad', 'Все пять подов перезапустились разом: минуту отвечать некому (ошибки 100 %), потом холодный старт и шторм подключений. Причина не ушла — через 3 минуты всё как было.'],
      pool: ['bad', 'База всё равно даёт не больше 90 соединений: лишние попытки получают «too many clients», а пока поды перезапускаются по очереди, мощности ещё меньше. Стало хуже.'],
      failover: ['bad', 'Две минуты база недоступна совсем — ошибки 100 %. На новой главной базе тот же лимит соединений: проблема вернулась.'],
      wait: ['', 'Прошло 5 минут. Само не проходит: пик Дальнего Востока только набирает силу.']
    };
    const ACT_TXT = {
      life: 'Прорвало трубу: сначала перекрывают вентиль, потом ищут, где треснуло, и меняют трубу. Никто не начинает со сварки, пока вода льётся на соседей.',
      plain: 'Сначала самый быстрый и безопасный шаг, который вернёт покупателям оформление: выключить новую функцию или вернуть прошлую версию. Чинить код — потом, днём и спокойно. Резкие «на всякий случай» шаги без понимания причины часто делают хуже.',
      term: '<b>Mitigation</b> (остановить кровотечение) раньше <b>remediation</b> (устранить причину). <b>MTTD</b> — время до обнаружения, <b>MTTA</b> — до подтверждения, <b>MTTR</b> — до восстановления. <b>Feature flag</b> и <b>rollback</b> — главные инструменты быстрой остановки.'
    };
    VIEWS.act = () => {
      const I = U.I, B = isBiz(), S = stats(), dis = I.ack == null || S.rec != null || I.t >= M1;
      let h = `${barHTML()}${ana(ACT_TXT.life, ACT_TXT.plain, B ? '' : ACT_TXT.term)}`;
      if (I.ack == null) h += card('warn', '<b>Алерт ещё не подтверждён.</b> <button type="button" class="btn" data-go="alert">К алерту</button>');
      h += `<div class="loc-acts">${ACT_ORDER.map(k => `<button type="button" data-do="${k}" ${dis ? 'disabled' : ''}><b>${ACT[k].n}</b><small>${ACT[k].d}</small><span>≈ ${ACT[k].cost} мин</span></button>`).join('')}</div>`;
      h += chartsHTML(['err', 'p99', 'pool', 'lost']);
      h += `<div class="loc-kpis">${tile('MTTD — обнаружили', mins(S.mttd), `сбой с ${hm(ONSET)}, алерт в ${hm(ALERT)}`, 'ok')}${tile('MTTA — подтвердили', S.mtta != null ? mins(S.mtta) : '—', S.mtta != null ? (I.snooze ? 'алерт откладывали' : 'без эскалации') : 'ещё не подтвердили', S.mtta != null && S.mtta > 5 ? 'bad' : S.mtta != null ? 'ok' : '')}${tile('MTTR — восстановили', S.mttr != null ? mins(S.mttr) : `идёт ${mins(I.t - ONSET)}`, S.rec != null ? `норма с ${hm(S.rec)}` : 'от начала сбоя', S.mttr != null ? (S.mttr < 30 ? 'ok' : 'warn') : 'bad')}${tile(B ? 'Потеряно выручки' : 'Потеряно заказов', B ? rubK(S.rub) : nf(S.lost), B ? `${nf(S.lost)} заказов` : `≈ ${rubK(S.rub)}`, 'bad')}</div>`;
      const acts = I.acts.map((a, i) => `<li class="${EFFECT[a.k][0]}"><span class="loc-ft">${hm(a.at)}</span><i class="loc-num ${ACT[a.k].kind}">${i + 1}</i><span><b>${ACT[a.k].n}.</b> ${EFFECT[a.k][1]}</span></li>`).join('');
      h += `<div class="loc-box"><b class="loc-h">Что сделали</b><ol class="loc-alog">${acts || '<li class="mut">Пока ничего. Номера действий — те же, что в кружках на графиках.</li>'}</ol></div>`;
      if (S.rec != null) {
        const byFlag = I.acts.some(a => a.k === 'flag' && a.at < S.rec), before = I.found == null || I.found > Math.min(...I.acts.filter(a => ACT[a.k].kind === 'fix').map(a => a.at));
        h += card('ok', `<b>Кровотечение остановлено в ${hm(S.rec)}</b> — MTTR ${mins(S.mttr)}. ${byFlag ? 'Флаг выключил только новую логику промо — остальное из v2.14 продолжает работать.' : 'Откатили весь релиз v2.14 — вместе с остальными его изменениями; флаг выключил бы только промо.'}${before ? ' Безопасный обратимый шаг сделали до того, как доказали причину, — это нормально; гипотезу всё равно проверь, чтобы постмортем был честным.' : ''}<p><b>Теперь — чинить, но не ночью:</b></p><ul><li>Флаг оставить выключенным до утра: промо считается по старым правилам.</li><li>Днём — переписать расчёт одним запросом на корзину и кэшировать правила.</li><li>Выкатить исправление канарейкой днём, следя за числом запросов к базе.</li></ul>`);
      } else if (I.t >= M1) h += card('bad', '<b>04:30 — инцидент всё ещё идёт.</b> Без флага или отката пик выдыхается сам только к утру. Начни заново и попробуй остановить раньше.');
      if (B) h += card('biz', `<b>Для бизнеса.</b> Сейчас ${S.rec != null ? 'оформление работает' : `уходит ≈ ${dec(lostAt(I.t), 1)} заказа в минуту — ≈ ${rub(lostAt(I.t) * BIZ.check)}`}. Флаг — минута работы и ноль риска; откат — 4–5 минут; «добавить серверов» стоит денег и, как видно на графике, не помогает: узкое место — соединения базы, а не мощность.`)
        + asm([`средний чек ${rub(BIZ.check)}, из получивших ошибку ${pc(BIZ.abandon, 0)} уходят`, 'попыток оформления в пик — 40 в минуту', 'потери считаем от начала сбоя до восстановления']);
      return h + nextBtn('act');
    };
    function doAct(k) {
      const I = U.I; if (I.ack == null || recAt() != null || I.t >= M1) return;
      I.acts.push({ k, at: I.t }); log('act', `${ACT[k].n}`, ACT[k].kind === 'fix' ? 'ok' : ACT[k].kind === 'bad' ? 'bad' : '');
      spend(ACT[k].cost); resim();
      const rec = recAt(); if (rec != null && !I.ev.some(e => e.k === 'rec')) log('rec', 'Ошибки оформления ниже 0,5 % — кровотечение остановлено', 'ok', rec);
    }
    function doCheck(id) {
      const I = U.I, hh = HYP.find(x => x.id === id); if (!hh || I.checks[id] != null || I.ack == null || I.t >= M1) return;
      spend(checkCost(hh)); I.checks[id] = I.t; log('chk', `Проверили ${hh.chk} (гипотеза «${hh.n}»)`, '');
      const rec = recAt(); if (rec != null && !I.ev.some(e => e.k === 'rec')) log('rec', 'Ошибки оформления ниже 0,5 % — кровотечение остановлено', 'ok', rec);
    }
    function doVerdict(id, v) {
      const I = U.I, hh = HYP.find(x => x.id === id); if (!hh || I.checks[id] == null || I.verdict[id]) return;
      if ((v === 'yes') !== hh.ok) { I.wrong[id] = v === 'yes' ? 'Данные этого не показывают — перечитай находку выше.' : 'Не торопись отвергать: данные как раз сходятся — изменение, механизм и симптом.'; return; }
      I.verdict[id] = v; delete I.wrong[id];
      log('hyp', `Гипотеза «${hh.n}» ${v === 'yes' ? 'подтверждена' : 'отвергнута'}`, v === 'yes' ? 'ok' : '');
      if (v === 'yes' && hh.id === 'rel') I.found = I.t;
    }
    CHECKS.push(() => { if (U.I.found != null) done('cause'); const S = stats(); if (S.rec != null) { done('stop'); if (S.mttr < 30) done('fast'); } });

    /* ================= вкладка 4: связь ================= */
    const ST_WHAT = [['part', 'Часть покупателей не может оформить заказ: при оформлении появляется ошибка.', 'Часть покупателей не могла оформить заказ: при оформлении появлялась ошибка.'], ['vague', 'Наблюдаются технические неполадки.'], ['tech', 'Исчерпан пул соединений PostgreSQL в checkout-service после релиза v2.14.'], ['lie', 'Сайт работает в штатном режиме, ведутся плановые работы.']];
    const ST_DOING = [['looking', 'Мы разбираемся в причинах.'], ['found', 'Мы нашли причину и устраняем её.'], ['fixed', 'Сбой устранён, оформление работает. Мы следим за ситуацией.']];
    const ST_TOG = [['since', `Сбой начался в ${hm(ONSET)} по московскому времени.`, 'ok'], ['money', 'Если заказ не оформился, деньги не списаны.', 'ok'], ['sorry', 'Приносим извинения.', 'ok'], ['eta', 'Всё заработает через 5 минут.', 'bad'], ['blame', 'Ошибку допустил разработчик, он уже наказан.', 'bad'], ['next', 'Следующее обновление — в {next}.', 'ok']];
    const SUP_TOG = [['retry', 'Если заказ не оформился, деньги не списаны: предложите повторить через 30 минут или оформить по телефону.', 'ok'], ['noeta', 'Не называйте сроков починки: говорите, что работаем, и давайте ссылку на страницу статуса.', 'ok'], ['link', 'Страница статуса: status.shop.example — там свежие новости.', 'ok'], ['bank', 'Скажите, что проблема на стороне банка.', 'bad'], ['promo', 'Пообещайте каждому скидку 20 %.', 'bad']];
    const CADS = [[15, '15 мин'], [30, '30 мин'], [60, '1 час'], [0, 'когда починим']];
    const COMMS_TXT = {
      life: 'Поезд встал в тоннеле. Машинист, который через минуту говорит «стоим из-за неисправности впереди, следующее сообщение через пять минут», спасает вагон от паники. Молчание — и все звонят в справочную; а «через минуту поедем», если не поедем, — хуже молчания.',
      plain: 'Покупателям не нужны подробности про базы данных. Им нужно знать: что сломано, с какого времени, что вы делаете и когда будет следующая новость. Поддержке — что отвечать людям и чего не обещать.',
      term: '<b>Страница статуса</b> (status page) — публичная, по компонентам; <b>сообщение для поддержки</b> — внутреннее. Правила: симптом, а не причина; время начала; честное «что делаем»; <b>время следующего обновления</b> вместо срока починки; без виноватых. Частота обновлений зависит от уровня: SEV1 — каждые 15–30 минут, SEV2 — каждые 30–60.'
    };
    const nextAt = () => U.I.cad ? hm(U.I.t + U.I.cad) : 'когда починим';
    const whatText = w => w[2] && recAt() != null ? w[2] : w[1];
    const togText = (k, t) => k === 'since' && recAt() != null ? `Сбой длился с ${hm(ONSET)} до ${hm(recAt())} по московскому времени.` : t.replace('{next}', nextAt());
    function stChecks() {
      const I = U.I, d = I.draft, rec = recAt() != null, sev1 = I.sev === 'SEV1';
      const c1 = d.what === 'part', c2 = rec ? d.doing === 'fixed' : I.found != null ? d.doing === 'found' || d.doing === 'looking' : d.doing === 'looking';
      const c4 = d.next && I.cad && I.cad <= (sev1 ? 30 : 60);
      return [
        ['Понятно, что сломано — словами покупателя', c1, d.what === 'tech' ? 'Внутренности (пул, PostgreSQL, v2.14) покупателю не нужны и звучат пугающе.' : d.what === 'lie' ? 'Неправда: люди видят ошибку — такое сообщение подорвёт доверие.' : d.what === 'vague' ? 'Слишком общо: непонятно, можно ли сейчас что-то купить.' : 'Выбери, что сообщить.'],
        ['Честно о том, что делаем', c2, rec ? 'Сбой устранён — так и напиши.' : d.doing === 'fixed' ? 'Рано: оформление ещё не работает.' : d.doing === 'found' ? 'Причину ещё не нашли — не обещай лишнего.' : 'Выбери, что делаете.'],
        ['С какого времени', !!d.since, 'Укажи время начала — люди поймут, касается ли их заказ.'],
        ['Когда следующее обновление', !!c4, !d.next ? 'Без времени следующего обновления люди будут обновлять страницу и звонить.' : !I.cad ? '«Когда починим» — это не время.' : `Для ${I.sev || 'этого уровня'} обновляйте не реже чем раз в ${sev1 ? 30 : 60} минут.`],
        ['Без обещаний сроков и без виноватых', !d.eta && !d.blame, d.eta ? 'Срок, которого не знаешь, — обещание, которое придётся нарушить.' : 'Виноватые не интересуют покупателей и вредят команде.']
      ];
    }
    function stText() {
      const d = U.I.draft, parts = [];
      const w = ST_WHAT.find(x => x[0] === d.what); if (w) parts.push(whatText(w));
      ST_TOG.forEach(([k, t]) => { if (k !== 'next' && k !== 'sorry' && d[k]) parts.push(togText(k, t)); });
      const g = ST_DOING.find(x => x[0] === d.doing); if (g) parts.push(g[1]);
      if (d.sorry) parts.push('Приносим извинения.');
      if (d.next) parts.push(`Следующее обновление — ${U.I.cad ? 'в ' + nextAt() : 'когда починим'}.`);
      return parts.join(' ');
    }
    const supOk = () => { const s = U.I.sup; return s.retry && s.noeta && s.link && !s.bank && !s.promo; };
    function supportCalls() {
      const I = U.I, S = stats(), good = I.posts.filter(p => p.score >= 4).map(p => p.t), first = good.length ? Math.min(...good) : Infinity;
      let a = 0, b = 0; for (let m = ONSET; m < S.end; m++) { const u = rowAt(rows, m).failed * BIZ.uniq; if (m < first) a += u; else b += u; }
      const calls = a * BIZ.callNo + b * BIZ.callYes, none = (a + b) * BIZ.callNo;
      return { calls, none, rub: calls * BIZ.support, saved: (none - calls) * BIZ.support, first };
    }
    const pubCost = () => { const c = U.I.roles.comms; return U.I.declared == null || c === 'me' ? 3 : c === 'oleg' ? 1 : 0; };
    VIEWS.comms = () => {
      const I = U.I, B = isBiz(), d = I.draft, ch = stChecks(), sc = ch.filter(x => x[1]).length, rec = recAt() != null, C = supportCalls(), S = stats();
      let h = `${barHTML()}${ana(COMMS_TXT.life, COMMS_TXT.plain, B ? '' : COMMS_TXT.term)}`;
      if (I.ack == null) h += card('warn', '<b>Алерт ещё не подтверждён.</b> <button type="button" class="btn" data-go="alert">К алерту</button>');
      h += `<div class="loc-two"><div class="loc-box"><b class="loc-h">Сообщение на странице статуса</b>
        <div class="loc-ctl"><b>Что сломано</b><div class="loc-picks">${ST_WHAT.map(w => `<button type="button" data-set="dw:${w[0]}" aria-pressed="${d.what === w[0]}"><small>${whatText(w)}</small></button>`).join('')}</div></div>
        <div class="loc-ctl"><b>Что делаем</b><div class="loc-picks">${ST_DOING.map(([k, t]) => `<button type="button" data-set="dd:${k}" aria-pressed="${d.doing === k}"><small>${t}</small></button>`).join('')}</div></div>
        <div class="loc-ctl"><b>Добавить или убрать</b><div class="loc-togs">${ST_TOG.map(([k, t]) => `<button type="button" data-set="dt:${k}" aria-pressed="${!!d[k]}">${d[k] ? '✓ ' : '+ '}${togText(k, t)}</button>`).join('')}</div></div>
        <div class="loc-ctl"><b>Как часто обновлять</b>${seg('cad', CADS, I.cad, 'Как часто обновлять')}</div></div>
        <div class="loc-box"><b class="loc-h">Так увидят покупатели</b>
        <div class="loc-status"><div class="loc-sth">Статус магазина <span>${hm(I.t)}</span></div>${[['Каталог и поиск', 'ok'], ['Корзина', 'ok'], ['Оформление заказа', rec ? 'ok' : 'warn'], ['Оплата', 'ok']].map(([n, s]) => `<div class="loc-comp"><span>${n}</span><b class="${s}">${s === 'ok' ? 'работает' : 'частичный сбой'}</b></div>`).join('')}<p class="loc-stmsg">${esc(stText()) || '<span class="loc-muted">Собери сообщение слева.</span>'}</p></div>
        <ul class="loc-fb">${ch.map(([n, ok, hint]) => `<li class="${ok ? 'ok' : 'warn'}"><b>${n}.</b>${ok ? '' : ' ' + hint}</li>`).join('')}</ul>
        <div class="loc-btns"><button type="button" class="btn primary" data-act="publish" ${I.ack == null || !d.what ? 'disabled' : ''}>Опубликовать · ${sc}/5${pubCost() ? ` · ${pubCost()} мин разбора` : ' · пишет Марина'}</button></div></div></div>`;
      h += `<div class="loc-two"><div class="loc-box"><b class="loc-h">Опубликовано</b><ol class="loc-alog">${I.posts.length ? I.posts.map(p => `<li class="${p.score >= 5 ? 'ok' : p.score >= 4 ? '' : 'bad'}"><span class="loc-ft">${hm(p.t)}</span><span><b>${p.score}/5.</b> ${esc(p.text)}</span></li>`).join('') : '<li class="mut">Пока ни одного сообщения. Покупатели видят «всё работает» и звонят в поддержку.</li>'}</ol></div>
        <div class="loc-box"><b class="loc-h">Сообщение для поддержки</b><div class="loc-togs">${SUP_TOG.map(([k, t]) => `<button type="button" data-set="sp:${k}" aria-pressed="${!!I.sup[k]}">${I.sup[k] ? '✓ ' : '+ '}${t}</button>`).join('')}</div>
        <ul class="loc-fb"><li class="${!I.sup.bank && !I.sup.promo ? 'ok' : 'bad'}">${I.sup.bank ? 'Неправда про банк — вскроется, и поддержка потеряет доверие.' : I.sup.promo ? 'Скидку без согласования обещать нельзя — это деньги и прецедент.' : 'Без лжи и без обещаний, которые не согласованы.'}</li><li class="${I.sup.retry && I.sup.link ? 'ok' : 'warn'}">${I.sup.retry && I.sup.link ? 'Есть что ответить человеку и куда его отправить.' : 'Дай поддержке ответ покупателю и ссылку на статус.'}</li></ul>
        <div class="loc-btns"><button type="button" class="btn" data-act="support" ${I.ack == null || I.supSent != null ? 'disabled' : ''}>${I.supSent != null ? `Отправлено в ${hm(I.supSent)}` : 'Отправить в чат поддержки'}</button></div></div></div>`;
      h += `<div class="loc-kpis">${tile('Сообщений на статусе', nf(I.posts.length), I.posts.length ? `первое в ${hm(Math.min(...I.posts.map(p => p.t)))}` : 'ещё не было', I.posts.length ? 'ok' : 'bad')}${tile('Звонков в поддержку', '≈ ' + nf(C.calls), C.first < Infinity ? (C.saved > 0 ? `без сообщения было бы ≈ ${nf(C.none)}` : 'сообщение вышло, когда звонки уже были') : 'никто не знает, что происходит', C.saved > 0 ? 'ok' : C.first < Infinity ? 'warn' : 'bad')}${tile('Стоимость звонков', rubK(C.rub), C.saved > 0 ? `сообщение сэкономило ≈ ${rubK(C.saved)}` : `по ${rub(BIZ.support)} за обращение`, C.saved > 0 ? 'ok' : 'warn')}${tile('Вернулись благодаря статусу', ords(S.saved), S.saved > 0 ? `≈ ${rubK(S.saved * BIZ.check)} выручки` : 'понятного сообщения ещё не было', S.saved > 0 ? 'ok' : 'warn')}</div>`;
      if (B) h += card('biz', `<b>Для бизнеса.</b> Пока на странице статуса «всё работает», покупатель с ошибкой уходит насовсем в ${pc(BIZ.abandon, 0)} случаев, а ${pc(BIZ.callNo, 0)} пишут в поддержку. После честного «деньги не списаны, повторите позже» уходят ${pc(BIZ.abandonPost, 0)}, пишут ${pc(BIZ.callYes, 0)}: сегодня сообщение вернуло ≈ ${ords(S.saved)} (${rubK(S.saved * BIZ.check)}). Каждое обращение ≈ ${rub(BIZ.support)}; сегодня это ${rubK(C.rub)}${C.first === Infinity ? ` — и это без отзывов «магазин молчит, а деньги?»` : ''}. Сообщение пишет человек на связи — разбор не останавливается.`)
        + asm([`задето покупателей — ${pc(BIZ.uniq, 0)} от неудачных попыток (остальное — повторы)`, `без сообщения обращаются ${pc(BIZ.callNo, 0)}, с сообщением — ${pc(BIZ.callYes, 0)}`, `обращение в поддержку — ${rub(BIZ.support)}`, 'сообщение на 4–5 из 5 проверок считается понятным', `после понятного сообщения уходят ${pc(BIZ.abandonPost, 0)} вместо ${pc(BIZ.abandon, 0)}: часть возвращается позже`]);
      return h + nextBtn('comms');
    };
    ACTIONS.publish = () => { const I = U.I; if (I.ack == null || !I.draft.what) return; const sc = stChecks().filter(x => x[1]).length; spend(pubCost()); I.posts.push({ t: I.t, text: stText(), score: sc }); log('post', `Сообщение на странице статуса (${sc}/5): «${stText().slice(0, 90)}${stText().length > 90 ? '…' : ''}»`, sc >= 5 ? 'ok' : sc >= 4 ? '' : 'bad'); if (sc >= 5) done('status'); };
    ACTIONS.support = () => { const I = U.I; if (I.ack == null || I.supSent != null) return; I.supSent = I.t; log('sup', `Сообщение поддержке${supOk() ? '' : ' (с ошибками: ' + [I.sup.bank ? 'неправда про банк' : '', I.sup.promo ? 'обещание скидки' : ''].filter(Boolean).join(', ') + ')'}`, supOk() ? 'ok' : 'bad'); };
    PARAM.dw = v => { U.I.draft.what = v; };
    PARAM.dd = v => { U.I.draft.doing = v; };
    PARAM.dt = v => { U.I.draft[v] = !U.I.draft[v]; };
    PARAM.sp = v => { if (U.I.supSent == null) U.I.sup[v] = !U.I.sup[v]; };
    PARAM.cad = v => { U.I.cad = +v; };

    /* ================= вкладка 5: постмортем ================= */
    const WHYS = [
      { q: 'Почему падали оформления заказа?', o: [['Сервис оформления не получал соединение с базой: пул 90 из 90 был занят', 'ok'], ['База данных упала', 'wrong'], ['Так совпало', 'shallow']] },
      { q: 'Почему пул был занят?', o: [['Версия v2.14 держит соединение 0,6 с вместо 0,1: 12 запросов правил промо на каждое оформление', 'ok'], ['Пришло слишком много покупателей', 'shallow'], ['Разработчик Илья написал плохой код', 'blame']] },
      { q: 'Почему код делает 12 запросов?', o: [['Правила промо загружаются в цикле по товарам корзины (N+1); на тестовой корзине из 1–2 товаров это незаметно', 'ok'], ['Илья невнимателен и не подумал о базе', 'blame'], ['ORM так работает, ничего не поделаешь', 'shallow']] },
      { q: 'Почему это не поймали до выкладки?', o: [['Нагрузочный тест гоняет корзины из 1–2 товаров и не следит за числом запросов к базе на оформление', 'ok'], ['Тестировщики плохо проверили', 'blame'], ['Всё поймать невозможно', 'shallow']] },
      { q: 'Почему сбой проявился только в 03:00?', o: [['Выкатили в 22:40 сразу на 100 %; ночью нагрузка низкая, первый пик — утро Дальнего Востока и рассылка в 03:00. Алерта на заполнение пула нет', 'ok'], ['Не повезло', 'shallow'], ['Маркетинг зря отправил рассылку ночью', 'blame']] }
    ];
    const WHY_NOTE = { wrong: 'не подтверждается данными разбора', shallow: 'останавливается на поверхности — дальше копать некуда', blame: 'ищет виноватого: в следующий раз ошибки будут прятать' };
    const OWNERS = [['orders', '«Заказы»'], ['sre', 'SRE'], ['qa', 'QA'], ['platform', 'платформа']];
    const PM_TASKS = [
      { id: 'n1', t: 'Переписать расчёт промо одним запросом на корзину и кэшировать правила на 5 минут', cat: 'cause', due: '13 октября', good: true },
      { id: 'ci', t: 'Нагрузочный тест с корзинами по 10–20 товаров и проверкой «не больше 3 запросов к базе на оформление»', cat: 'cause', due: '20 октября', good: true },
      { id: 'al', t: 'Алерт-тикет на заполнение пула соединений > 80 % дольше 5 минут', cat: 'detect', due: '10 октября', good: true },
      { id: 'rb', t: 'Рунбук «пул соединений исчерпан»: сначала флаги свежих релизов, потом откат; не масштабировать поды', cat: 'respond', due: '10 октября', good: true },
      { id: 'can', t: 'Вечерние выкладки — только канарейкой с анализом запросов к базе; новые функции — за флагом', cat: 'respond', due: '27 октября', good: true },
      { id: 'att', t: 'Быть внимательнее при написании запросов к базе', good: false, why: 'не действие: нельзя проверить, что сделано' },
      { id: 'pun', t: 'Лишить автора релиза премии', good: false, blame: true, why: 'поиск виноватого — ошибки начнут прятать' },
      { id: 'rew', t: 'Переписать весь сервис оформления', good: false, why: 'огромно и не про причину; сроки нереальны' },
      { id: 'pod', t: 'Держать 10 подов вместо 5 на всякий случай', good: false, why: 'не помогло бы: упираемся в лимит соединений базы' }
    ];
    const CATN = { cause: 'причина', detect: 'обнаружение', respond: 'реакция' };
    const PM_TXT = {
      life: 'Разбор полёта у лётчиков: после сложной посадки экипаж садится и восстанавливает минуту за минутой, что видели и что решали. Цель — не найти, кого наказать, а сделать так, чтобы следующий экипаж в той же ситуации справился лучше.',
      plain: 'После сбоя собираем, что произошло по минутам, сколько это стоило, почему так вышло на самом деле — до уровня процессов, а не людей — и какие изменения с владельцами и сроками не дадут этому повториться.',
      term: '<b>Blameless postmortem</b> — постмортем без поиска виноватых: люди действовали разумно с той информацией, что у них была; чинят систему. <b>5 почему</b> (5 whys) — спрашиваем «почему» до системной причины. <b>Action items</b> — задачи с владельцем и сроком: на причину, на обнаружение и на реакцию.'
    };
    function timeline() {
      const I = U.I, base = [{ t: DEPLOY - 1440, text: 'Выкатили checkout v2.14 сразу на 100 %: новый расчёт промо за флагом promo_rules_v2', cls: '' }, { t: T(3, 0), text: 'Утро на Дальнем Востоке и рассылка с промокодом: нагрузка на оформление растёт втрое', cls: '' }, { t: ONSET, text: `Начало влияния: ошибки оформления выше 0,5 % — пул соединений кончился`, cls: 'bad' }, { t: ALERT, text: 'Алерт: burn rate ≥ 14,4 за 1 час и за 5 минут — звонок дежурному', cls: 'warn' }];
      return base.concat(I.ev.map(e => ({ t: e.t, text: e.text, cls: e.cls }))).sort((a, b) => a.t - b.t);
    }
    function pmWorked() {
      const I = U.I, S = stats(), w = [], nw = [];
      w.push(`Алерт по скорости сгорания бюджета сработал через ${mins(S.mttd)} после начала — по симптому, а не по CPU.`);
      if (!I.snooze) w.push(`Дежурный подтвердил алерт за ${mins(S.mtta || 2)}.`); else nw.push(`Алерт отложили на 10 минут — эскалация разбудила второго дежурного, ушло ≈ ${ords(lostBetween(ALERT, I.ack, true))}.`);
      if (I.found != null) w.push(`Причину доказали данными за ${mins(I.found - ONSET)} от начала сбоя.`);
      if (I.acts.some(a => a.k === 'flag')) w.push('Новая логика была за флагом: выключили за минуту, без выкладки.');
      if (I.acts.some(a => a.k === 'rollback')) w.push('Откат вернул норму за ≈ 4 минуты.');
      if (I.declared != null && I.roles.comms !== I.roles.ops) w.push(`${{ me: 'Связь вёл ты сам', oleg: 'Связь вёл Олег', marina: 'Связь вела Марина' }[I.roles.comms]} — разбор не отвлекался на сообщения.`);
      I.acts.filter(a => ACT[a.k].kind === 'bad').forEach(a => nw.push(`${hm(a.at)} — «${ACT[a.k].n}»: ${a.k === 'restart' ? 'минута полного простоя и шторм подключений' : a.k === 'scale' ? 'не помогло — упираемся в лимит соединений базы, стало хуже' : a.k === 'pool' ? 'лимит базы не изменился, стало хуже' : 'две минуты полного простоя, причина не та'}.`));
      const C = supportCalls();
      if (!I.posts.length) nw.push(`Страница статуса молчала — ≈ ${nf(C.calls)} обращений в поддержку.`); else if (C.first - (I.declared || ALERT) > 15) nw.push(`Первое сообщение на странице статуса — только в ${hm(C.first)}.`);
      nw.push('Нагрузочный тест не поймал 12 запросов на оформление: корзины в тесте из 1–2 товаров.');
      nw.push('Нет алерта на заполнение пула соединений — узнали по ошибкам покупателей.');
      nw.push('Новую логику выкатили вечером сразу на 100 %, без канарейки.');
      return { w, nw };
    }
    function pmQuality() {
      const I = U.I, S = stats(), picks = WHYS.map((x, i) => I.why[i] != null ? x.o[I.why[i]][1] : null), sel = PM_TASKS.filter(x => I.tasks[x.id]), good = sel.filter(x => x.good);
      const cats = new Set(good.map(x => x.cat));
      return [
        ['Хронология и влияние посчитаны', S.rec != null, 'Инцидент ещё не закрыт — останови кровотечение на вкладке «Действие».'],
        ['«5 почему» доведены до системной причины', picks.every(p => p === 'ok'), picks.some(p => p == null) ? 'Ответь на все пять «почему».' : picks.every(p => p === 'ok') ? '' : `Ответ на «${WHYS[picks.findIndex(p => p !== 'ok')].q}» ${WHY_NOTE[picks.find(p => p !== 'ok')]}.`],
        ['Без поиска виноватых', !picks.includes('blame') && !I.tasks.pun, 'Убери ответы и задачи про конкретных людей — чиним систему.'],
        ['Хотя бы 3 задачи, у каждой владелец', good.length >= 3 && sel.every(x => I.owners[x.id]), good.length < 3 ? 'Выбери хотя бы три полезные задачи.' : 'Назначь владельца каждой выбранной задаче.'],
        ['Задачи закрывают причину, обнаружение и реакцию', ['cause', 'detect', 'respond'].every(c => cats.has(c)), `Не хватает: ${['cause', 'detect', 'respond'].filter(c => !cats.has(c)).map(c => CATN[c]).join(', ')}.`],
        ['Нет пустых задач', !sel.some(x => !x.good), `Убери: ${sel.filter(x => !x.good).map(x => `«${x.t}» — ${x.why}`).join('; ')}.`]
      ];
    }
    VIEWS.pm = () => {
      const I = U.I, B = isBiz(), S = stats(), Q = pmQuality(), sc = Q.filter(x => x[1]).length, W = pmWorked();
      let h = `${ana(PM_TXT.life, PM_TXT.plain, B ? '' : PM_TXT.term)}`;
      h += `<div class="loc-pmhead"><div><b class="loc-h">Постмортем: сбой оформления заказов</b><span class="loc-sub">ночь, ${hm(ONSET)}–${S.rec != null ? hm(S.rec) : 'идёт'} · ${I.sev || 'уровень не выбран'} · черновик</span></div><div class="loc-score ${sc === 6 ? 'ok' : sc >= 4 ? 'warn' : 'bad'}"><b>${sc}/6</b><span>качество</span></div></div>`;
      if (S.rec == null) h += card('warn', '<b>Инцидент ещё идёт.</b> Хронологию и влияние допишем, когда восстановим оформление. «5 почему» и задачи можно готовить уже сейчас.');
      h += `<div class="loc-kpis">${tile('Длительность', S.rec != null ? mins(S.rec - ONSET) : `идёт ${mins(I.t - ONSET)}`, `с ${hm(ONSET)}`)}${tile('Неудачных оформлений', nf(S.failed), `задето ≈ ${nf(S.users)} покупателей`, 'bad')}${tile('Потеряно', B ? rubK(S.rub) : ords(S.lost), B ? ords(S.lost) : '≈ ' + rubK(S.rub), 'bad')}${tile('Бюджет ошибок SLO', pc(S.budget, 0), 'месячного — за одну ночь', S.budget > 0.5 ? 'bad' : 'warn')}</div>`;
      h += `<div class="loc-two"><div class="loc-box"><b class="loc-h">Хронология</b><ol class="loc-alog">${timeline().map(e => `<li class="${e.cls}"><span class="loc-ft">${hm(e.t)}</span><span>${esc(e.text)}</span></li>`).join('')}</ol><small class="loc-sub">Собрана из твоих действий. Время — по часам инцидента.</small></div>
        <div class="loc-box"><b class="loc-h">Что сработало</b><ul class="loc-fb">${W.w.map(x => `<li class="ok">${x}</li>`).join('')}</ul><b class="loc-h">Что не сработало</b><ul class="loc-fb">${W.nw.map(x => `<li class="warn">${x}</li>`).join('')}</ul></div></div>`;
      h += `<b class="loc-h">Причина: 5 почему</b><div class="loc-whys">${WHYS.map((x, i) => { const p = I.why[i]; return `<div class="loc-why5"><b><i>${i + 1}</i>${x.q}</b><div class="loc-picks">${x.o.map(([t, k], j) => `<button type="button" data-set="why:${i}.${j}" aria-pressed="${p === j}" class="${p === j ? k : ''}"><small>${t}</small></button>`).join('')}</div>${p != null && x.o[p][1] !== 'ok' ? `<p class="loc-wr">Этот ответ ${WHY_NOTE[x.o[p][1]]}.</p>` : ''}</div>`; }).join('')}</div>`;
      h += `<b class="loc-h">Задачи</b><div class="loc-tasks">${PM_TASKS.map(x => `<div class="loc-task ${I.tasks[x.id] ? 'on' : ''}"><button type="button" class="loc-tck" data-set="task:${x.id}" aria-pressed="${!!I.tasks[x.id]}">${I.tasks[x.id] ? '✓' : ''}</button><div><span>${x.t}</span>${x.good ? `<small>${CATN[x.cat]} · срок ${x.due}</small>` : ''}${I.tasks[x.id] && !x.good ? `<small class="bad">${x.why}</small>` : ''}</div>${I.tasks[x.id] ? seg('own-' + x.id, OWNERS, I.owners[x.id], 'Владелец') : ''}</div>`).join('')}</div>`;
      h += `<div class="loc-box"><b class="loc-h">Проверка качества постмортема: ${sc} из 6</b><ul class="loc-fb">${Q.map(([n, ok, hint]) => `<li class="${ok ? 'ok' : 'warn'}"><b>${n}.</b>${ok ? '' : ' ' + hint}</li>`).join('')}</ul></div>`;
      if (B) h += card('biz', `<b>Для бизнеса.</b> Сбой стоил ≈ ${rubK(S.rub)} и ${pc(S.budget, 0)} месячного бюджета ошибок. Постмортем — 2 часа пяти человек (≈ 15 тыс. ₽) и ≈ 2 недели задач. Без него та же ошибка в следующий пик повторится — с той же ценой.`) + asm([`месячный бюджет ошибок SLO 99,9 % — ≈ ${nf(BIZ.month * (1 - SLO))} неудачных оформлений`, 'час работы инженера ≈ 1 500 ₽']);
      return h + nextBtn('pm');
    };
    PARAM.why = v => { const [i, j] = v.split('.').map(Number); U.I.why[i] = j; };
    PARAM.task = v => { U.I.tasks[v] = !U.I.tasks[v]; };
    CHECKS.push(() => { if (pmQuality().every(x => x[1])) done('pm'); });

    render(false);
    return {
      destroy() {
        U.alive = false;
        EL.removeEventListener('click', onClick);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      }
    };
  }

  /* ================= итоги ================= */
  const MEMO = [
    ['Алерт и начало', ['Будим по симптому и скорости сгорания бюджета, а не по CPU.', 'Подтверди алерт сразу — неподтверждённый эскалируется и считается ничьим.', 'Сначала масштаб и уровень (SEV), потом роли: ведущий, разбор, связь.']],
    ['Разбор', ['Метрики → логи → трейс: от «что болит» к «где именно».', 'Гипотезу подтверждают данными, а не уверенностью. Сначала проверяй то, что менялось недавно.', 'Перезапуск всего и добавление серверов без понимания причины часто делают хуже.']],
    ['Действие', ['Сначала остановить кровотечение (флаг, откат), потом чинить — днём и спокойно.', 'MTTD — до обнаружения, MTTA — до подтверждения, MTTR — до восстановления.', 'Флаг выключается за минуту, откат — за минуты; поэтому новое прячут за флагами.']],
    ['Связь и постмортем', ['Страница статуса: что сломано, с какого времени, что делаем, когда следующее обновление. Без внутренностей и без обещаний сроков.', 'Постмортем без поиска виноватых: «5 почему» ведут к системе, а не к человеку.', 'Задачи с владельцем и сроком закрывают причину, обнаружение и реакцию.']]
  ];
  const MEMO_BIZ = [
    ['Минуты — это деньги', ['Каждая минута сбоя в пик — ушедшие заказы; ночной вызов второго человека дешевле минуты сбоя.', '«Отложить алерт» почти всегда дороже, чем проснуться.']],
    ['Решения ночью', ['Быстрый безопасный шаг (выключить функцию, откатить) лучше героического ремонта.', 'Новые функции выпускают с выключателем — это страховка выручки.']],
    ['Покупатели и поддержка', ['Молчание на странице статуса превращается в звонки, жалобы и отзывы.', 'Честное короткое сообщение с временем следующего обновления снимает большую часть звонков.']],
    ['После', ['Постмортем — не поиск виноватого, а список изменений, чтобы сбой не повторился.', 'Задача без владельца и срока не будет сделана.']]
  ];

  /* ================= регистрация ================= */
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'oncall', title: 'Дежурство и постмортем', lede: 'Алерт, разбор, откат, статус, постмортем',
    intro: 'Ночь, 03:12. Телефон дежурного звонит: растут ошибки оформления заказа. Вечером выкатили новую версию сервиса оформления, а в 03:00 начался утренний пик на Дальнем Востоке. Подтверди алерт, оцени масштаб, раздай роли, найди причину по метрикам, логам и трейсу, останови кровотечение, напиши покупателям и собери постмортем. Часы идут только от твоих действий — и каждая минута стоит заказов. Переключатель «Техника | Бизнес» переводит всё в рубли и решения.',
    tasks: [
      { id: 'ack', text: 'Подтверди алерт, выбери верный уровень и объяви инцидент с ролями' },
      { id: 'cause', text: 'Найди причину: подтверди гипотезу проверкой данных' },
      { id: 'stop', text: 'Останови кровотечение: ошибки оформления ниже 0,5 %' },
      { id: 'fast', text: 'Восстанови оформление меньше чем за 30 минут от начала сбоя' },
      { id: 'status', text: 'Опубликуй сообщение на странице статуса, которое проходит все проверки' },
      { id: 'pm', text: 'Собери постмортем на 6 из 6: без виноватых, с задачами и владельцами' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
})();
