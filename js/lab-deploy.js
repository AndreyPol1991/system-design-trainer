/* Лаборатория «Выкладка вживую»: 10 подов под живым трафиком, выкатываем v2 с возможным багом пятью способами —
   всё сразу (recreate), rolling update, blue-green, канарейка, фича-флаг. Графики ошибок, задержки и доли трафика на v2,
   сколько покупателей увидели ошибку, время отката; сравнение стратегий; миграция базы expand/contract.
   Переключатель «Техника | Бизнес» — как в «Таблице вживую»: в бизнес-режиме те же прогоны в заказах и рублях. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isCalm = () => document.documentElement.classList.contains('calm');
  const mulberry = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const nf = v => Math.round(v).toLocaleString('ru-RU');
  const dec = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',');
  const pc = (x, d) => { const v = x * 100; if (d != null) return dec(v, d) + ' %'; return (v === 0 ? '0' : v < 1 ? dec(v, 2) : v < 10 ? dec(v, 1) : nf(v)) + ' %'; };
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const p2 = n => String(n).padStart(2, '0');
  const clock = s => `${p2(Math.floor(s / 60))}:${p2(Math.floor(s % 60))}`;
  const dur = s => { s = Math.round(s); if (s < 60) return s + ' с'; const m = Math.floor(s / 60), r = s % 60; if (m < 60) return m + ' мин' + (r ? ' ' + r + ' с' : ''); const h = Math.floor(m / 60); return h + ' ч' + (m % 60 ? ' ' + (m % 60) + ' мин' : ''); };
  const rub = v => { const a = Math.abs(v); if (a >= 1e9) return dec(v / 1e9, 1) + ' млрд ₽'; if (a >= 1e6) return dec(v / 1e6, a >= 1e7 ? 0 : 1) + ' млн ₽'; if (a >= 1e4) return nf(v / 1e3) + ' тыс. ₽'; return nf(v) + ' ₽'; };
  const people = n => nf(n) + ' ' + plural(n, 'покупатель', 'покупателя', 'покупателей');
  const ordN = n => n > 0 && n < 9.95 ? dec(n, 1) : nf(n);
  const orders = n => n > 0 && n < 9.95 ? dec(n, 1) + ' заказа' : nf(n) + ' ' + plural(n, 'заказ', 'заказа', 'заказов');

  /* ---------- модель: сервис, поды, трафик ---------- */
  const RPS = 200, USERS = 6000, CAP = 28, N = 10, START = 20, DRAIN = 5, BASE_ERR = 0.001, BASE_P99 = 120, RHO0 = RPS / (N * CAP);
  const WIN = 60, A_ERR = 0.02, A_P99 = 400, HUMAN = 180, STEPS = [0.01, 0.1, 0.5, 1], PAUSE = 60, HOLD = 300, T0 = 15, TAIL = 60, TMAX = 1500, TIMEOUT = 2000;
  const STRATS = [
    { k: 'recreate', n: 'Всё сразу', en: 'recreate' },
    { k: 'rolling', n: 'Rolling update', en: 'по одному поду' },
    { k: 'bg', n: 'Blue-green', en: 'два окружения' },
    { k: 'canary', n: 'Канарейка', en: '1 → 10 → 50 → 100 %' },
    { k: 'flag', n: 'Фича-флаг', en: 'выключатель функции' }
  ];
  const SN = Object.fromEntries(STRATS.map(s => [s.k, s.n]));
  /* бизнес: интернет-магазин в вечерний час */
  const SCALES = [
    { k: 1, n: 'Небольшой магазин', ordH: 1200 },
    { k: 10, n: 'Крупный магазин', ordH: 12000 },
    { k: 100, n: 'Маркетплейс', ordH: 120000 }
  ];
  const BIZ = { check: 3200, abandon: 0.6, latPer100: 0.01, podMonth: 9000, engH: 3500 };
  const podHour = () => BIZ.podMonth / 720;

  /* очередь: пока загрузка подов обычная — задержка обычная; ближе к 100 % растёт как 1 / (1 − загрузка) */
  const qf = rho => rho <= RHO0 ? 1 : (1 - RHO0) / Math.max(0.02, 1 - Math.min(rho, 0.98));
  /* p99 смеси групп с разной задержкой: ищем x, при котором медленнее x — ровно 1 % запросов (хвост ~ экспонента) */
  function p99mix(parts) {
    const ps = parts.filter(g => g.s > 1e-6 && g.p > 0); if (!ps.length) return null;
    const L = Math.log(100), ex = x => ps.reduce((a, g) => a + g.s * Math.exp(-x * L / g.p), 0);
    let lo = 0, hi = Math.max(...ps.map(g => g.p)) * 1.5;
    for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (ex(m) > 0.01) lo = m; else hi = m; }
    return Math.min(TIMEOUT, (lo + hi) / 2);
  }

  function mkRun(strat, P, seed) {
    const R = mulberry(seed || 2026);
    const uh = new Float32Array(USERS); for (let i = 0; i < USERS; i++) uh[i] = R();
    const S = {
      strat, P: Object.assign({}, P), R, uh, hit: new Uint8Array(USERS), t: 0, pods: [], seq: 0, mk: 0,
      ph: 'base', pt: 0, tv: 2, w: 0, active: 'blue', flag: 0, stepI: -1,
      rb: false, rbAt: null, alertAt: null, humanAt: null, badFrom: null, badTo: null, liveAt: null, deployAt: null, fin: null, done: false,
      ev: [], ser: { err: [], p99: [], v2: [], pods: [], down: [] }, win: [], cw: [],
      reqs: 0, errs: 0, depErrs: 0, users: 0, down: 0, podSec: 0, peak: N, lost: 0, latLost: 0, smp: [], flash: {}, ld: {}
    };
    if (!S.P.surge && !S.P.unav) S.P.surge = 1;
    for (let i = 0; i < N; i++) { const p = add(S, 1, 'blue'); p.st = 'ready'; }
    return S;
  }
  const bugOn = P => P.err >= 0.005 || P.lat >= 80;
  const live = S => S.pods.filter(p => p.st !== 'drain');
  const ready = (S, f) => S.pods.filter(p => p.st === 'ready' && (!f || f(p)));
  function add(S, v, env) { const p = { id: ++S.seq, v, env: env || (v === 2 ? 'green' : 'blue'), st: 'start', at: S.t }; S.pods.push(p); return p; }
  const drain = (S, p) => { p.st = 'drain'; p.at = S.t; };
  const log = (S, text, cls, mark) => { const e = { t: S.t, text, cls: cls || '' }; if (mark) e.n = ++S.mk; S.ev.push(e); };

  /* rolling: держим не меньше N − maxUnavailable готовых подов и не больше N + maxSurge всего */
  function rollStep(S, tv, surge, unav) {
    const old = live(S).filter(p => p.v !== tv);
    old.filter(p => p.st === 'start').forEach(p => drain(S, p));
    let rd = live(S).filter(p => p.st === 'ready').length;
    old.forEach(p => { if (p.st === 'ready' && rd - 1 >= N - unav) { drain(S, p); rd--; } });
    let L = live(S).length, nw = live(S).filter(p => p.v === tv).length;
    while (L < N + surge && nw < N) { add(S, tv); L++; nw++; }
    const all = live(S);
    return all.length === N && all.every(p => p.v === tv && p.st === 'ready');
  }

  function begin(S) {
    const t = S.t; S.deployAt = t;
    if (S.strat === 'recreate') { live(S).forEach(p => drain(S, p)); S.ph = 'kill'; log(S, 'Старт «всё сразу»: останавливаем все 10 подов v1 разом', 'warn', true); }
    if (S.strat === 'rolling') { S.ph = 'roll'; S.tv = 2; log(S, `Старт rolling update: maxSurge ${S.P.surge}, maxUnavailable ${S.P.unav} — меняем поды порциями`, '', true); }
    if (S.strat === 'bg') { for (let i = 0; i < N; i++) add(S, 2, 'green'); S.ph = 'green'; log(S, 'Поднимаем зелёное окружение: 10 подов v2 рядом с синим. Весь трафик пока на синем (v1)', '', true); }
    if (S.strat === 'canary') { add(S, 2); S.ph = 'cup'; log(S, 'Запускаем один под-канарейку v2. Трафик на него пойдёт, когда он станет готов', '', true); }
    if (S.strat === 'flag') { S.ph = 'code'; S.tv = 2; log(S, 'Выкатываем код v2 rolling update’ом, но функция за флагом выключена — покупатели видят старое поведение', '', true); }
  }

  function rollback(S, why) {
    const t = S.t; S.rb = true; S.rbAt = t; S.fin = null;
    if (S.strat === 'recreate') { S.tv = 1; live(S).forEach(p => drain(S, p)); S.ph = 'kill'; log(S, `${why} Откат «всё сразу»: снова гасим все поды — второй простой`, 'bad', true); }
    if (S.strat === 'rolling') { S.tv = 1; S.ph = 'roll'; log(S, `${why} Откат: rolling update обратно на v1 — поды меняются тем же порядком, по одному`, 'warn', true); }
    if (S.strat === 'bg' && !live(S).some(p => p.env === 'blue')) { for (let i = 0; i < N; i++) add(S, 1, 'blue'); S.ph = 'reblue'; log(S, `${why} Синее уже выключено — поднимаем его заново, это ещё ${START} с на v2`, 'warn', true); return; }
    if (S.strat === 'bg') { S.active = 'blue'; live(S).filter(p => p.env === 'green').forEach(p => drain(S, p)); S.ph = 'live'; S.fin = t; log(S, `${why} Откат: балансировщик переключён обратно на синее — за 1 секунду`, 'ok', true); }
    if (S.strat === 'canary' && !live(S).some(p => p.v === 1)) { S.w = null; S.tv = 1; S.ph = 'roll1'; log(S, `${why} Канарейка уже стала 100 % — откатываем rolling update’ом на v1`, 'warn', true); return; }
    if (S.strat === 'canary') { S.w = 0; live(S).filter(p => p.v === 2).forEach(p => drain(S, p)); S.ph = 'live'; S.fin = t; log(S, `${why} Автоматический откат: вес канарейки 0 %, под v2 удалён`, 'ok', true); }
    if (S.strat === 'flag') { S.flag = 0; S.ph = 'live'; S.fin = t; log(S, `${why} Флаг выключен за 1 секунду — без новой выкатки, код v2 остаётся на подах`, 'ok', true); }
  }

  /* канарейка и флаг: каждые 10 с сравниваем новую группу со старой за последние 30 с */
  function guard(S, who) {
    if ((S.t - S.pt) % 10 || S.t - S.pt < 10) return false;
    const w = S.cw.slice(-30), r1 = w.reduce((a, x) => a + x.r1, 0), e1 = w.reduce((a, x) => a + x.e1, 0), r2 = w.reduce((a, x) => a + x.r2, 0), e2 = w.reduce((a, x) => a + x.e2, 0);
    if (r2 < 30) return false;
    const x1 = e1 / Math.max(1, r1), x2 = e2 / r2, l1 = w.reduce((a, x) => a + x.p1, 0) / w.length, l2 = w.reduce((a, x) => a + x.p2, 0) / w.length;
    if (x2 - x1 > 0.01 && e2 >= 3) { rollback(S, `Анализ ${who}: ошибок ${pc(x2)} против ${pc(x1)} у остальных (порог +1 п. п., не меньше 3 ошибок) — ${nf(e2)} из ${nf(r2)} запросов.`); return true; }
    if (l2 - l1 > 100) { rollback(S, `Анализ ${who}: p99 ${nf(l2)} мс против ${nf(l1)} мс у остальных (порог +100 мс).`); return true; }
    return false;
  }

  function control(S) {
    const t = S.t, P = S.P;
    if (S.ph === 'base') { if (t >= T0) begin(S); return; }
    if (S.strat === 'recreate') {
      if (S.ph === 'kill' && !S.pods.length) { for (let i = 0; i < N; i++) add(S, S.tv); S.ph = 'up'; log(S, S.tv === 2 ? `Все поды v1 остановлены — отвечать некому, покупатели получают 503. Поднимаем 10 подов v2 (≈ ${START} с)` : 'Поды v2 остановлены, поднимаем v1 — снова никто не отвечает', 'bad'); }
      else if (S.ph === 'up' && ready(S).length === N) { S.ph = 'live'; S.fin = t; log(S, S.tv === 2 ? 'Все 10 подов v2 готовы — сервис снова отвечает' : 'v1 снова на всех подах', S.tv === 2 ? '' : 'ok', true); }
    }
    if (S.strat === 'rolling' && S.ph === 'roll' && rollStep(S, S.tv, P.surge, P.unav)) { S.ph = 'live'; S.fin = t; log(S, S.tv === 2 ? 'Rolling update закончен: все 10 подов — v2' : 'Откат закончен: все 10 подов снова v1', S.tv === 2 ? '' : 'ok', true); }
    if (S.strat === 'bg') {
      if (S.ph === 'green' && ready(S, p => p.env === 'green').length === N) { S.ph = 'smoke'; S.pt = t; log(S, 'Зелёное готово. Смоук-тесты на зелёном: десяток проверочных запросов прошёл — баг на них не проявился'); }
      else if (S.ph === 'smoke' && t - S.pt >= 20) { S.active = 'green'; S.ph = 'hold'; S.pt = t; log(S, 'Балансировщик переключён: весь трафик на зелёное (v2) за 1 секунду. Синее держим ещё 5 минут на случай отката', '', true); }
      else if (S.ph === 'reblue' && ready(S, p => p.env === 'blue').length === N) { S.active = 'blue'; live(S).filter(p => p.env === 'green').forEach(p => drain(S, p)); S.ph = 'live'; S.fin = t; log(S, 'Синее поднято, балансировщик переключён обратно', 'ok', true); }
      else if (S.ph === 'hold' && t - S.pt >= HOLD) { live(S).filter(p => p.env === 'blue').forEach(p => drain(S, p)); S.ph = 'live'; S.fin = t; log(S, 'Окно отката прошло — синее выключено, снова 10 подов вместо 20'); }
    }
    if (S.strat === 'canary') {
      if (S.ph === 'roll1' && rollStep(S, 1, 1, 0)) { S.ph = 'live'; S.fin = t; log(S, 'Откат закончен: все 10 подов снова v1', 'ok', true); }
      else if (S.ph === 'cup' && ready(S, p => p.v === 2).length) { S.stepI = 0; S.w = STEPS[0]; S.ph = 'step'; S.pt = t; log(S, 'Канарейка готова: на v2 идёт 1 % запросов', '', true); }
      else if (S.ph === 'step') {
        if (!guard(S, 'канарейки') && t - S.pt >= PAUSE) {
          S.stepI++; const w = STEPS[S.stepI], need = Math.ceil(N * w);
          let n2 = live(S).filter(p => p.v === 2).length; while (n2 < need) { add(S, 2); n2++; }
          S.ph = 'scale'; log(S, `Метрики v2 в норме минуту — расширяем до ${pc(w)}: подов v2 нужно ${need}`);
        }
      } else if (S.ph === 'scale') {
        const w = STEPS[S.stepI];
        if (ready(S, p => p.v === 2).length >= Math.ceil(N * w)) {
          S.w = w; S.pt = t;
          if (w >= 1) { live(S).filter(p => p.v === 1).forEach(p => drain(S, p)); S.ph = 'live'; S.fin = t; log(S, 'Канарейка прошла все шаги: 100 % на v2, поды v1 удалены', '', true); }
          else { S.ph = 'step'; log(S, `На v2 идёт ${pc(w)} запросов`, '', true); }
        }
      }
    }
    if (S.strat === 'flag') {
      if (S.ph === 'code' && rollStep(S, 2, 1, 0)) { S.ph = 'fstep'; S.stepI = 0; S.flag = STEPS[0]; S.pt = t; log(S, 'Код v2 на всех подах. Включаем флаг для 1 % покупателей — всегда одних и тех же', '', true); }
      else if (S.ph === 'fstep' && !guard(S, 'флага') && t - S.pt >= PAUSE) {
        S.stepI++; S.flag = STEPS[S.stepI]; S.pt = t;
        if (S.flag >= 1) { S.ph = 'live'; S.fin = t; log(S, 'Функция включена для всех покупателей', '', true); }
        else log(S, `Метрики в норме — флаг на ${pc(S.flag)} покупателей`, '', true);
      }
    }
  }

  function routes(S) {
    const rd = ready(S);
    if (S.strat === 'bg') { const ps = rd.filter(p => p.env === S.active); return ps.length ? [{ v: S.active === 'green' ? 2 : 1, pods: ps, s: 1 }] : []; }
    const p1 = rd.filter(p => p.v === 1), p2 = rd.filter(p => p.v === 2);
    if (S.strat === 'canary' && S.w != null) {
      const w = !p2.length ? 0 : !p1.length ? 1 : S.w;
      return [{ v: 1, pods: p1, s: 1 - w }, { v: 2, pods: p2, s: w }].filter(g => g.pods.length && g.s > 0);
    }
    const n = rd.length;
    return [{ v: 1, pods: p1, s: p1.length / n }, { v: 2, pods: p2, s: p2.length / n }].filter(g => g.pods.length);
  }

  function traffic(S) {
    const P = S.P, R = S.R, G = routes(S), t = S.t, isFlag = S.strat === 'flag';
    S.flash = {}; S.smp = []; S.ld = {};
    let err = 0, dep = 0, bugReq = 0, r1 = 0, e1 = 0, r2 = 0, e2 = 0;
    const smpEvery = Math.max(1, Math.round(RPS / 8));
    if (!G.length) {
      for (let i = 0; i < RPS; i++) { const u = (R() * USERS) | 0; if (!S.hit[u]) { S.hit[u] = 1; S.users++; } if (i % smpEvery === 0) S.smp.push({ pid: 0, v: 0, fail: 1 }); }
      err = dep = RPS; S.down++;
    } else {
      G.forEach(g => { g.rho = RPS * g.s / (g.pods.length * CAP); g.drop = g.rho > 1 ? 1 - 1 / g.rho : 0; g.q = qf(g.rho); g.pods.forEach(p => { S.ld[p.id] = g.rho; }); });
      for (let i = 0; i < RPS; i++) {
        const u = (R() * USERS) | 0;
        let x = R(), g = G[0];
        for (let k = 0; k < G.length; k++) { if (x < G[k].s || k === G.length - 1) { g = G[k]; break; } x -= G[k].s; }
        const bug = g.v === 2 && (!isFlag || S.uh[u] < S.flag);
        const pod = g.pods[(R() * g.pods.length) | 0], y = R();
        let fail = 0;
        if (y < BASE_ERR) fail = 1; else if (y < BASE_ERR + g.drop + (bug ? P.err : 0)) fail = 2;
        if (bug) bugReq++;
        if (fail) { err++; S.flash[pod.id] = 1; }
        if (fail === 2) { dep++; if (!S.hit[u]) { S.hit[u] = 1; S.users++; } }
        const grpNew = isFlag ? bug : g.v === 2;
        if (grpNew) { r2++; if (fail) e2++; } else { r1++; if (fail) e1++; }
        if (i % smpEvery === 0) S.smp.push({ pid: pod.id, v: bug || (!isFlag && g.v === 2) ? 2 : 1, fail: fail ? 1 : 0 });
      }
    }
    const shareBug = bugReq / RPS;
    /* задержка: старая группа, новая без бага, новая с багом */
    const parts = [];
    let pOld = 0, pNew = 0;
    G.forEach(g => {
      const base = BASE_P99 * g.q, sb = g.v === 2 ? (isFlag ? g.s * S.flag : g.s) : 0;
      parts.push({ s: g.s - sb, p: base }); if (sb > 0) parts.push({ s: sb, p: (BASE_P99 + P.lat) * g.q });
      if (g.v === 2) pNew = Math.max(pNew, (BASE_P99 + (isFlag && S.flag === 0 ? 0 : P.lat)) * g.q); else pOld = Math.max(pOld, base);
    });
    const p99 = G.length ? p99mix(parts) : null;
    if (isFlag && G.length) { pOld = BASE_P99 * Math.max(...G.map(g => g.q)); pNew = S.flag > 0 ? (BASE_P99 + P.lat) * Math.max(...G.map(g => g.q)) : pOld; }
    S.cw.push({ r1, e1, r2, e2, p1: pOld, p2: pNew }); if (S.cw.length > 60) S.cw.shift();
    S.reqs += RPS; S.errs += err; S.depErrs += dep;
    const ef = err / RPS, ordS = 1 / 3600;
    S.lost += ordS * (dep / RPS) * BIZ.abandon; S.latLost += ordS * shareBug * (P.lat / 100) * BIZ.latPer100;
    const v2s = isFlag ? shareBug : G.filter(g => g.v === 2).reduce((a, g) => a + g.s, 0);
    S.ser.err.push(ef); S.ser.p99.push(p99); S.ser.v2.push(v2s); S.ser.down.push(G.length ? 0 : 1);
    const nl = live(S).length + S.pods.filter(p => p.st === 'drain').length; S.ser.pods.push(nl); S.podSec += nl; S.peak = Math.max(S.peak, nl);
    if (bugOn(P) && shareBug > 0 && S.badFrom == null) S.badFrom = t;
    if (S.badFrom != null && S.badTo == null && shareBug === 0 && S.rb && G.length) S.badTo = t;
    if (S.liveAt == null && v2s >= 0.999 && !S.rb) S.liveAt = t;
    S.win.push({ r: RPS, e: err, p: p99, dn: G.length ? 0 : 1 }); if (S.win.length > WIN) S.win.shift();
  }

  function monitor(S) {
    const t = S.t, P = S.P;
    if (S.alertAt == null && S.ph !== 'base') {
      const w = S.win.filter(x => !x.dn);
      if (w.length >= 20) {
        const er = w.reduce((a, x) => a + x.e, 0) / w.reduce((a, x) => a + x.r, 0), pp = w.reduce((a, x) => a + x.p, 0) / w.length;
        if (er > A_ERR || pp > A_P99) { S.alertAt = t; S.humanAt = t + HUMAN; log(S, `Алерт: за минуту ${er > A_ERR ? `ошибок ${pc(er)} (порог 2 %)` : `p99 ${nf(pp)} мс (порог 400 мс)`}. Дежурный просыпается, открывает графики…`, 'bad', true); }
      }
    }
    if (S.humanAt === t) {
      if (S.rb) log(S, 'Дежурный открыл графики: откат уже сделан автоматически, будить никого не пришлось бы', 'ok');
      else if (bugOn(P) && (S.ph !== 'base')) { S.byHuman = true; rollback(S, `Через ${dur(HUMAN)} после алерта дежурный нашёл причину — v2.`); }
      else log(S, 'Дежурный разобрался: ошибки не от v2, а от нехватки подов во время замены. Выкатка идёт дальше', 'warn');
    }
  }

  function step(S) {
    if (S.done) return;
    S.t++;
    const t = S.t;
    S.pods.forEach(p => { if (p.st === 'start' && t - p.at >= START) { p.st = 'ready'; p.at = t; } });
    S.pods = S.pods.filter(p => !(p.st === 'drain' && t - p.at >= DRAIN));
    control(S); traffic(S); monitor(S);
    const waitHuman = S.humanAt != null && t <= S.humanAt;
    if (S.fin != null && t >= S.fin + TAIL && !waitHuman) S.done = true;
    if (t >= TMAX) S.done = true;
  }
  function runAll(strat, P, seed) { const S = mkRun(strat, P, seed); while (!S.done) step(S); return S; }

  /* итог прогона: числа для плиток, таблицы сравнения и бизнес-режима */
  function summary(S, scale) {
    const k = scale || 1, ordS = 1200 * k / 3600, extraPodSec = Math.max(0, S.podSec - N * S.t);
    const lostOrd = (S.lost + S.latLost) * 1200 * k;
    return {
      users: S.users, share: S.users / USERS, depErrs: S.depErrs, down: S.down,
      bad: S.badFrom != null ? (S.badTo != null ? Math.max(1, S.badTo - S.badFrom) : null) : 0,
      detect: S.rbAt != null && S.badFrom != null ? S.rbAt - S.badFrom : null,
      undo: S.rbAt != null && S.badTo != null ? Math.max(1, S.badTo - S.rbAt) : null,
      rollout: S.liveAt != null && S.deployAt != null ? S.liveAt - S.deployAt : null,
      rb: S.rb, stuck: bugOn(S.P) && !S.rb && S.badFrom != null, peak: S.peak,
      extraPodH: extraPodSec / 3600 * k, extraRub: extraPodSec / 3600 * k * podHour(),
      lostOrd, lostRub: lostOrd * BIZ.check, ordS, human: !!S.byHuman, alert: S.alertAt != null
    };
  }

  /* ================= сцена: покупатели → балансировщик → поды ================= */
  const GRP = {
    recreate: ['v1 — старая версия', 'v2 — новая версия'],
    rolling: ['v1 — старая версия', 'v2 — новая версия'],
    bg: ['Синее окружение · v1', 'Зелёное окружение · v2'],
    canary: ['Основные поды · v1', 'Канарейка · v2'],
    flag: ['v1 — старый код', 'v2 — новый код, функция за флагом']
  };
  const SH = 250;
  function stageLayout(S, W) {
    const x0 = Math.max(282, Math.min(336, W * 0.34)), gw = W - x0 - 8, gh = 100, gy = [16, SH - gh - 14];
    const inA = p => S.strat === 'bg' ? p.env === 'blue' : p.v === 1;
    const A = S.pods.filter(inA), B = S.pods.filter(p => !inA(p));
    const pos = {}, cells = [];
    [A, B].forEach((list, gi) => {
      const cols = Math.max(5, Math.ceil(list.length / 2)), pw = Math.min(66, (gw - 20 - (cols - 1) * 6) / cols), ph = 30;
      list.forEach((p, i) => {
        const c = i % cols, r = Math.floor(i / cols), x = x0 + 10 + c * (pw + 6), y = gy[gi] + 26 + r * (ph + 8);
        pos[p.id] = { x: x + pw / 2, y: y + ph / 2 }; cells.push({ p, x, y, w: pw, h: ph, gi });
      });
    });
    return { x0, gw, gh, gy, pos, cells, ub: { x: 8, y: SH / 2 - 48, w: 116, h: 96 }, lb: { x: 138, y: SH / 2 - 48, w: Math.min(140, x0 - 156), h: 96 } };
  }
  function stageSVG(S, W, dots, mem, isBiz) {
    const L = stageLayout(S, W), G = routes(S), t = S.t, rd = ready(S).length;
    Object.assign(mem, L.pos);
    const shareA = G.filter(g => g.v === 1).reduce((a, g) => a + g.s, 0);
    const shareB = G.length ? 1 - shareA : 0;
    const lbx = L.lb.x + L.lb.w, cy = SH / 2;
    let h = `<svg class="ld-svg" viewBox="0 0 ${W} ${SH}" width="${W}" height="${SH}" role="img" aria-label="Схема: покупатели, балансировщик и поды двух версий">`;
    /* провода */
    h += `<line class="ld-wire" x1="${L.ub.x + L.ub.w}" y1="${cy}" x2="${L.lb.x}" y2="${cy}"/>`;
    [shareA, shareB].forEach((s, gi) => {
      const ty = L.gy[gi] + L.gh / 2, mx = (lbx + L.x0) / 2;
      h += `<path class="ld-wire ${gi ? 'b' : 'a'} ${s > 0 ? 'on' : 'off'}" style="stroke-width:${s > 0 ? (1.5 + 5 * s).toFixed(1) : 1.2}" d="M${lbx} ${cy} C ${mx} ${cy}, ${mx} ${ty}, ${L.x0} ${ty}"/>`;
    });
    /* покупатели */
    const isFlag = S.strat === 'flag';
    h += `<rect class="ld-box" x="${L.ub.x}" y="${L.ub.y}" width="${L.ub.w}" height="${L.ub.h}" rx="10"/>
      <text class="ld-bt" x="${L.ub.x + 10}" y="${L.ub.y + 22}">Покупатели</text>
      <text class="ld-bs" x="${L.ub.x + 10}" y="${L.ub.y + 42}">${nf(USERS)} онлайн</text>
      <text class="ld-bs" x="${L.ub.x + 10}" y="${L.ub.y + 60}">${RPS} запросов/с</text>
      <text class="ld-bs ${S.users ? 'bad' : ''}" x="${L.ub.x + 10}" y="${L.ub.y + 80}">с ошибкой: ${nf(S.users)}</text>`;
    /* балансировщик */
    const lbLines = !G.length ? [['некому отдать', 'bad'], ['→ ошибка 503', 'bad']]
      : S.strat === 'bg' ? [['весь трафик', ''], [S.active === 'green' ? '→ зелёное' : '→ синее', S.active === 'green' ? 'acc' : 'inf']]
      : S.strat === 'canary' && S.w != null ? [['по весам', ''], [`v2: ${pc(shareB)}`, shareB ? 'acc' : '']]
      : isFlag ? [['поровну на поды', ''], [`флаг: ${pc(S.flag)}`, S.flag ? 'acc' : '']]
      : [['поровну на', ''], [`${rd} ${plural(rd, 'готовый под', 'готовых пода', 'готовых подов')}`, '']];
    h += `<rect class="ld-box ${G.length ? '' : 'bad'}" x="${L.lb.x}" y="${L.lb.y}" width="${L.lb.w}" height="${L.lb.h}" rx="10"/>
      <text class="ld-bt" x="${L.lb.x + 10}" y="${L.lb.y + 22}">Балансировщик</text>
      ${lbLines.map((l, i) => `<text class="ld-bs ${l[1]}" x="${L.lb.x + 10}" y="${L.lb.y + 46 + i * 20}">${esc(l[0])}</text>`).join('')}`;
    /* группы подов */
    const names = GRP[S.strat];
    [0, 1].forEach(gi => {
      const act = gi ? shareB > 0 : shareA > 0;
      h += `<rect class="ld-grp ${gi ? 'b' : 'a'} ${act ? 'on' : ''}" x="${L.x0}" y="${L.gy[gi]}" width="${L.gw}" height="${L.gh}" rx="10"/>
        <text class="ld-gt ${gi ? 'b' : 'a'}" x="${L.x0 + 10}" y="${L.gy[gi] + 18}">${esc(names[gi])}</text><text class="ld-wl ${act ? '' : 'mut'}" x="${L.x0 + L.gw - 10}" y="${L.gy[gi] + 18}" text-anchor="end">${G.length ? pc(gi ? shareB : shareA) + ' трафика' : 'нет трафика'}</text>`;
    });
    L.cells.forEach(c => {
      const p = c.p, v2 = p.v === 2, rho = S.ld[p.id] || 0, fl = S.flash[p.id] && p.st === 'ready';
      const cls = ['ld-pod', v2 ? 'v2' : 'v1', p.st, fl ? 'err' : '', rho > 0.95 ? 'hot' : ''].join(' ');
      const lab = p.st === 'start' ? 'старт' : p.st === 'drain' ? 'стоп' : 'v' + p.v;
      h += `<g class="${cls}"><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="6"/><text x="${c.x + c.w / 2}" y="${c.y + c.h / 2 + 4}" text-anchor="middle">${lab}</text>`;
      if (p.st === 'start') h += `<rect class="ld-prog" x="${c.x + 3}" y="${c.y + c.h - 5}" width="${Math.max(1, (c.w - 6) * Math.min(1, (t - p.at) / START)).toFixed(1)}" height="3" rx="1.5"/>`;
      if (p.st === 'ready' && rho) h += `<rect class="ld-load ${rho > 1 ? 'over' : rho > 0.85 ? 'high' : ''}" x="${c.x + 3}" y="${c.y + c.h - 5}" width="${((c.w - 6) * Math.min(1, rho)).toFixed(1)}" height="3" rx="1.5"/>`;
      if (fl) h += `<circle class="ld-errdot" cx="${c.x + c.w - 5}" cy="${c.y + 5}" r="3.5"/>`;
      h += '</g>';
    });
    /* точки запросов */
    const now = performance.now();
    dots.forEach(d => {
      const k = Math.min(1, (now - d.b) / 750), tg = mem[d.pid];
      let x, y;
      if (k < 0.45 || !tg) { const q = Math.min(1, k / 0.45); x = L.ub.x + L.ub.w + (L.lb.x - 4 - L.ub.x - L.ub.w) * q; y = cy + d.j * 14 * (1 - q); }
      else { const q = (k - 0.45) / 0.55; x = lbx + (tg.x - lbx) * q; y = cy + (tg.y - cy) * q; }
      const red = d.fail && (k > 0.85 || !tg);
      h += `<circle class="ld-dot ${red ? 'f' : d.v === 2 ? 'v2' : 'v1'}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${red ? 4.5 : 3.5}"/>`;
    });
    h += `<text class="ld-clock" x="${L.ub.x}" y="16">${S.t ? '⏱ ' + clock(S.t) : ''}</text>`;
    return h + '</svg>';
  }

  /* ================= графики по времени ================= */
  function series(arr, from, to, b) {
    const out = [];
    for (let i = from; i < to; i += b) { let s = 0, n = 0; for (let j = i; j < Math.min(to, i + b); j++) if (arr[j] != null) { s += arr[j]; n++; } out.push(n ? s / n : null); }
    return out;
  }
  function chartSVG(W, H, o) {
    const ml = 46, mr = 10, mt = 8, mb = o.axis ? 20 : 6, iw = W - ml - mr, ih = H - mt - mb;
    const X = s => ml + iw * s / o.T, Y = v => mt + ih * (1 - Math.min(1, v / o.max));
    let h = `<svg class="ld-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria)}">`;
    (o.down || []).forEach(([a, b]) => { h += `<rect class="ld-downband" x="${X(a).toFixed(1)}" y="${mt}" width="${Math.max(2, X(b) - X(a)).toFixed(1)}" height="${ih}"/>`; if (X(b) - X(a) > 46) h += `<text class="ld-downt" x="${((X(a) + X(b)) / 2).toFixed(1)}" y="${mt + 14}" text-anchor="middle">простой</text>`; });
    o.ticks.forEach(v => { h += `<line class="ld-grid" x1="${ml}" x2="${W - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ld-ax" x="${ml - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${o.fmt(v)}</text>`; });
    if (o.thr != null) h += `<line class="ld-thr" x1="${ml}" x2="${W - mr}" y1="${Y(o.thr).toFixed(1)}" y2="${Y(o.thr).toFixed(1)}"/><text class="ld-thrt" x="${W - mr - 2}" y="${(Y(o.thr) - 4).toFixed(1)}" text-anchor="end">${esc(o.thrLabel)}</text>`;
    (o.marks || []).forEach(m => { h += `<line class="ld-mark ${m.cls}" x1="${X(m.t).toFixed(1)}" x2="${X(m.t).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/>`; if (o.markNums) h += `<circle class="ld-mkc ${m.cls}" cx="${X(m.t).toFixed(1)}" cy="${mt + 8}" r="8"/><text class="ld-mkn" x="${X(m.t).toFixed(1)}" y="${mt + 12}" text-anchor="middle">${m.n}</text>`; });
    const pts = []; let seg = '';
    o.data.forEach((v, i) => { const x = X((i + 0.5) * o.b); if (v == null) { if (seg) { pts.push(seg); seg = ''; } return; } seg += `${seg ? ' L' : 'M'}${x.toFixed(1)} ${Y(v).toFixed(1)}`; });
    if (seg) pts.push(seg);
    if (o.area && o.data.length) { const last = o.data.length; h += `<path class="ld-area ${o.cls}" d="M${X(0.5 * o.b).toFixed(1)} ${Y(0)} ${o.data.map((v, i) => `L${X((i + 0.5) * o.b).toFixed(1)} ${Y(v || 0).toFixed(1)}`).join(' ')} L${X((last - 0.5) * o.b).toFixed(1)} ${Y(0)} Z"/>`; }
    pts.forEach(d => { h += `<path class="ld-line ${o.cls}" d="${d}"/>`; });
    if (o.axis) { const step = o.T <= 360 ? 60 : o.T <= 900 ? 120 : 300; for (let s = 0; s <= o.T; s += step) if (X(s) < W - 22) h += `<text class="ld-ax" x="${X(s).toFixed(1)}" y="${H - 5}" text-anchor="middle">${clock(s)}</text>`; }
    if (o.empty) h += `<text class="ld-ax" x="${ml + iw / 2}" y="${mt + ih / 2 + 4}" text-anchor="middle">${esc(o.empty)}</text>`;
    return h + '</svg>';
  }
  function chartsHTML(S, W, isBiz) {
    const T = Math.max(360, Math.ceil((S.t + 20) / 60) * 60), b = T <= 600 ? 3 : 5, n = S.t;
    const err = series(S.ser.err.map((v, i) => S.ser.down[i] ? null : v), 0, n, b), p99 = series(S.ser.p99, 0, n, b), v2 = series(S.ser.v2, 0, n, b);
    const down = []; let a = null;
    S.ser.down.forEach((d, i) => { if (d && a == null) a = i; if (!d && a != null) { down.push([a, i]); a = null; } }); if (a != null) down.push([a, n]);
    const mx = Math.max(0.0001, ...err.filter(v => v != null)), emax = [0.05, 0.1, 0.2, 0.3].find(v => v >= mx) || 0.3;
    const pmx = Math.max(1, ...p99.filter(v => v != null)), pmax = [500, 1000, 2000].find(v => v >= pmx) || 2000;
    const marks = S.ev.filter(e => e.n).map(e => ({ t: e.t, n: e.n, cls: e.cls }));
    const empty = n ? '' : 'нажми «Выкатить v2» — график пойдёт по времени';
    const cur = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    const ce = S.ser.down[n - 1] ? 1 : cur(S.ser.err), cp = cur(S.ser.p99), cv = cur(S.ser.v2);
    const lab = (t, v, cls) => `<div class="ld-ch-h"><b>${t}</b><span class="${cls || ''}">${v}</span></div>`;
    return `<div class="ld-ch">${lab(isBiz ? 'Ошибки у покупателей, % запросов' : 'Ошибки, % запросов (5xx и таймауты)', n ? (ce === 1 ? 'сейчас 100 % — простой' : 'сейчас ' + pc(ce || 0)) : '', ce > A_ERR ? 'bad' : '')}${chartSVG(W, 104, { T, b, data: err, max: emax, ticks: [0, emax / 2, emax], fmt: v => pc(v), thr: A_ERR, thrLabel: 'алерт 2 %', cls: 'err', down, marks, markNums: true, aria: 'График ошибок по времени', empty })}</div>
      <div class="ld-ch">${lab(isBiz ? 'Скорость ответа: самые медленные 1 %, мс' : 'Задержка p99, мс', n && cp != null ? 'сейчас ' + nf(cp) + ' мс' : '', cp > A_P99 ? 'bad' : '')}${chartSVG(W, 90, { T, b, data: p99, max: pmax, ticks: [0, pmax / 2, pmax], fmt: v => nf(v), thr: A_P99, thrLabel: 'алерт 400 мс', cls: 'lat', down, marks, aria: 'График задержки p99 по времени' })}</div>
      <div class="ld-ch">${lab(S.strat === 'flag' ? (isBiz ? 'Покупатели с новой функцией, % запросов' : 'Запросы с включённой функцией, %') : (isBiz ? 'Покупатели на новой версии, % запросов' : 'Трафик на v2, %'), n ? 'сейчас ' + pc(cv || 0) : '')}${chartSVG(W, 96, { T, b, data: v2, max: 1, ticks: [0, 0.5, 1], fmt: v => pc(v), cls: 'v2', area: true, down, marks, axis: true, aria: 'Доля трафика на новой версии по времени' })}</div>`;
  }

  /* ================= тексты: аналогия → фраза без терминов → термин ================= */
  const ana = (life, plain, term) => `<div class="ld-ana"><p class="ld-life"><span class="ld-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="ld-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const INFO = {
    recreate: {
      life: 'Магазин закрывается на переучёт: вешают табличку «закрыто», меняют всю витрину и открываются. Просто — но пока табличка висит, покупатели стоят у закрытой двери.',
      plain: 'Сначала выключаем всё старое, потом включаем всё новое. Между ними сервис не отвечает никому.',
      term: '<b>Recreate</b> — все экземпляры старой версии останавливаются до запуска новой. Простой = остановка + старт и прогрев новой версии. Годится, когда две версии не могут работать одновременно и простой допустим — ночью, в окно обслуживания.',
      how: ['Гасим все 10 подов v1 (≈ 5 с)', `Поднимаем 10 подов v2 и ждём готовности (≈ ${START} с) — всё это время ошибка 503`, 'Баг нашли — откат тем же способом: ещё один простой'],
      biz: 'Каждая выкатка — плановый простой: покупатели видят ошибку, корзины теряются. Подходит для внутренних систем ночью, но не для магазина в рабочее время.'
    },
    rolling: {
      life: 'Кассиров меняют по одному: один уходит, на его место садится сменщик — касса не закрывается ни на минуту. Но если сменщик путает сдачу, это замечают не сразу, а за это время сменилась уже половина смены.',
      plain: 'Новые копии запускаются по одной-две, старые выключаются, когда новые готовы. Сервис работает всё время, но какое-то время работают обе версии сразу.',
      term: '<b>Rolling update</b> — стратегия по умолчанию в Kubernetes. <b>maxSurge</b> — сколько подов можно добавить сверх нормы (быстрее, но дороже), <b>maxUnavailable</b> — на сколько можно опустить число готовых (быстрее и бесплатно, но меньше мощности). Kubernetes смотрит только на готовность пода (readiness probe): баг, который не роняет под, он докатит до конца.',
      how: ['Поднимаем maxSurge новых подов, ждём готовности', 'Убираем старые, не опуская готовых ниже 10 − maxUnavailable', 'Повторяем, пока все 10 не станут v2', 'Откат — такой же rolling назад, тоже минуты'],
      biz: 'Без простоя и без лишних затрат — поэтому стоит по умолчанию. Но плохая версия доходит до всех покупателей, а откат занимает столько же, сколько выкатка.'
    },
    bg: {
      life: 'Два одинаковых зала в ресторане: в соседнем накрыли новое меню, проверили и открыли туда дверь. Гостям не понравилось — ведём обратно за секунду. Но пока держим оба зала, платим за два.',
      plain: 'Рядом со старой копией сервиса поднимаем полную новую. Переключаем весь поток разом, а старую держим включённой, чтобы вернуться за секунду.',
      term: '<b>Blue-green</b>: синее окружение — текущая версия, зелёное — новая; балансировщик (ingress, DNS) переключается целиком. <b>Откат мгновенный</b>, но баг сразу задевает 100 % трафика, а на время окна отката нужна двойная мощность. База обычно общая — схема должна подходить обеим версиям.',
      how: ['Поднимаем 10 подов v2 рядом с 10 подами v1', 'Смоук-тесты на зелёном, пока трафик на синем', 'Переключаем балансировщик — весь трафик на v2', 'Плохо — обратно за 1 с; хорошо — через 5 минут гасим синее'],
      biz: 'Откат за секунду — но пока дежурный не заметил проблему, её видят все покупатели. Двойная мощность на время выкатки стоит копейки; держать второе окружение постоянно — уже ощутимо.'
    },
    canary: {
      life: 'Новое блюдо сначала подают одному столику из ста. Всё хорошо — десяти, потом половине зала, потом всем. Гостю за первым столиком не понравилось — блюдо снимают: задело одного гостя, а не весь зал.',
      plain: 'Новая версия сначала получает крошечную долю запросов. Автомат сравнивает её ошибки и скорость со старой. Хуже — сам откатывает; не хуже — прибавляет долю.',
      term: '<b>Canary release</b> (канареечный релиз): трафик делится по весам (service mesh, Argo Rollouts, Flagger). <b>Анализ канарейки</b> сравнивает метрики новой и старой версии; порог превышен — автоматический откат без человека. Цена — медленная выкатка и обязательная хорошая наблюдаемость.',
      how: ['Один под v2, на него 1 % запросов', 'Каждые 10 с автомат сравнивает ошибки и p99 у v2 и v1', 'Минута в норме → 10 % → 50 % → 100 %', 'Хуже порога → вес 0 % сразу, человек не нужен'],
      biz: 'Баг видят единицы покупателей и несколько секунд, будить никого не надо. Платим временем: выкатка идёт минуты вместо секунд, и нужны метрики, которым можно доверять.'
    },
    flag: {
      life: 'Проводку провели заранее, а свет включают выключателем — сначала в одной комнате. Заискрило — щёлкнул выключатель, электрика вызывать не нужно.',
      plain: 'Новый код выкатываем выключенным. Потом включаем функцию части покупателей — всегда одним и тем же. Плохо — выключаем кнопкой, без новой выкатки.',
      term: '<b>Feature flag</b> (фича-флаг): условие в коде <code>if (flags.on("new-checkout", user))</code>, значение меняют в сервисе флагов (Unleash, LaunchDarkly, своя таблица) без выкатки. Доля считается по пользователю — один покупатель всегда видит одно поведение. <b>Kill switch</b> — выключить за секунду. Цена — старые флаги надо вычищать из кода.',
      how: ['Выкатываем код v2 rolling’ом, функция выключена — поведение старое', 'Флаг на 1 % покупателей, автомат следит за их ошибками', '10 % → 50 % → 100 %', 'Хуже порога — флаг выключен за 1 с, код остаётся'],
      biz: 'Выкладку кода и запуск функции развели: релиз делаем днём, а функцию включаем по готовности — хоть только сотрудникам. Выключатель спасает за секунду.'
    }
  };
  const LIFE = {
    live: 'Выкладка — как замена двигателя у автобуса, который везёт пассажиров: останавливать автобус нельзя, а новый двигатель может оказаться с браком.',
    cmp: 'Пять способов заменить двигатель — проверяем на одном и том же браке: сколько пассажиров пострадало, сколько ехали стоя и сколько стоила замена.',
    mig: 'Переезд на новый номер телефона: сначала подключаешь новый, пару недель работают оба, всем сообщаешь новый, а старый отключаешь, только когда на него перестали звонить.'
  };
  const MEMO = [
    ['Стратегии', ['Всё сразу — простой на каждой выкатке и на каждом откате.', 'Rolling — без простоя, но баг доходит до всех, а откат такой же долгий.', 'Blue-green — откат за секунду, но баг сразу у 100 % и двойная мощность на время окна.', 'Канарейка — баг видит 1 % на секунды, откат автоматический; платим скоростью выкатки.', 'Фича-флаг — выкладка кода отдельно от включения функции, kill switch за секунду.']],
    ['Обнаружение важнее отката', ['Время до восстановления = обнаружить + решить + откатить. Человек по алерту — минуты, автомат по метрикам — секунды.', 'Kubernetes проверяет только готовность пода: баг в логике он не видит.', 'Порог анализа задаёт, какие баги проскочат: маленькая доля ошибок проходит любую канарейку.']],
    ['Настройки rolling', ['maxSurge — быстрее за счёт лишних подов.', 'maxUnavailable — быстрее за счёт мощности: под нагрузкой это ошибки и тормоза.']],
    ['База при выкладке', ['Две версии работают одновременно почти при любой стратегии — схема базы должна подходить обеим.', 'Expand/contract: сначала добавить, потом переключить, удалить старое — в самом конце.', 'Переименование колонки за один шаг ломает старую версию и отрезает путь отката.']]
  ];
  const MEMO_BIZ = [
    ['Деньги и покупатели', ['Цена выкатки — не серверы, а покупатели, которые увидели ошибку и ушли.', 'Двойное окружение на 5 минут стоит копейки; постоянное — как вторая зарплата сервиса.', 'Простой при выкатке «всё сразу» повторяется при каждом релизе и каждом откате.']],
    ['Скорость против риска', ['Канарейка и флаги медленнее выкатывают, но баг задевает единицы покупателей.', 'Автоматический откат не будит людей ночью: дежурный нужен реже.']],
    ['Миграции', ['Схему базы меняют в несколько релизов — это дни работы, а не минуты, но без единой ошибки у покупателей.', 'Сломанная за один шаг схема — простой оплаты и невозможный откат.']]
  ];

  /* ================= миграция базы: два пути ================= */
  const CUST = [
    [101, '8 (912) 345-67-89', '+79123456789'], [102, '+7 903 111-22-33', '+79031112233'], [103, '89161234567', '+79161234567'],
    [104, '8-926-000-11-22', '+79260001122'], [105, '+7 (999) 765-43-21', '+79997654321'], [106, '8 915 222 33 44', '+79152223344']
  ];
  /* шаг: sql, текст, колонки, какие версии на подах (10 штук), работает ли каждая версия, можно ли откатиться, ошибки оформления */
  const MIG = {
    brk: [
      { t: 'Исходно', sql: '-- v1 читает и пишет customers.phone', cols: ['phone'], fill: 0, pods: [10, 0, 0], ok: { 1: true }, back: true, err: 0, txt: 'Все 10 подов — v1. Телефон покупателя лежит в колонке <code>phone</code> в свободном формате.', biz: 'Магазин работает, телефон нужен при оформлении заказа — на него приходит СМС о доставке.' },
      { t: 'Переименовали колонку', sql: 'ALTER TABLE customers\n  RENAME COLUMN phone TO phone_e164;', cols: ['phone_e164'], fill: 1, pods: [10, 0, 0], ok: { 1: false }, back: false, err: 1, txt: 'Миграция прошла за миллисекунды — и все 10 подов v1 падают: <code>ERROR: column "phone" does not exist</code>. Код ещё старый, а колонка уже новая.', biz: 'Оформить заказ не может никто: каждое оформление — ошибка 500. Поддержка получает первые звонки.' },
      { t: 'Срочно катим v2', sql: '-- rolling update v1 → v2, ≈ 3 минуты', cols: ['phone_e164'], fill: 1, pods: [5, 5, 0], ok: { 1: false, 2: true }, back: false, err: 0.5, txt: 'v2 знает новую колонку и работает. Но половина подов ещё v1 — половина оформлений падает, пока rolling не закончится.', biz: 'Ошибки идут ещё ≈ 3 минуты: доля падающих заказов снижается по мере замены подов.' },
      { t: 'В v2 нашли баг — откат?', sql: 'kubectl rollout undo deploy/shop\n-- v1 снова ищет колонку phone', cols: ['phone_e164'], fill: 1, pods: [0, 10, 0], ok: { 1: false, 2: true }, back: false, err: 0, txt: 'Откатиться на v1 нельзя: v1 снова упадёт на отсутствующей колонке. Нужна обратная миграция, а её никто не писал. Чиним только вперёд, под давлением.', biz: 'Любой следующий баг в v2 — без пути назад: команда пишет исправление в спешке, пока покупатели ждут.' }
    ],
    ec: [
      { t: 'Исходно', sql: '-- v1 читает и пишет customers.phone', cols: ['phone'], fill: 0, pods: [10, 0, 0], ok: { 1: true }, back: true, err: 0, txt: 'Все 10 подов — v1. Хотим хранить телефон в едином формате E.164 в новой колонке <code>phone_e164</code>.', biz: 'Магазин работает. Цель — СМС о доставке без ошибок в номере.' },
      { t: '1. Expand: добавили колонку', sql: 'ALTER TABLE customers\n  ADD COLUMN phone_e164 text NULL;', cols: ['phone', 'phone_e164'], fill: 0, pods: [10, 0, 0], ok: { 1: true }, back: true, err: 0, txt: 'Новая колонка пустая и необязательная. v1 о ней не знает и спокойно работает — добавление колонки без значения по умолчанию в PostgreSQL мгновенное.', biz: 'Покупатели ничего не замечают. Это отдельный маленький релиз.' },
      { t: '2. Выкатили v2: пишет в обе', sql: '-- v2: при записи — в phone И в phone_e164\n-- при чтении — phone_e164, если пусто — phone', cols: ['phone', 'phone_e164'], fill: 0.34, pods: [5, 5, 0], ok: { 1: true, 2: true }, back: true, err: 0, txt: 'Rolling идёт, v1 и v2 работают одновременно — обе понимают схему. Новые и изменённые записи сразу попадают в обе колонки. Откат на v1 безопасен: <code>phone</code> по-прежнему заполнен.', biz: 'Ни одной ошибки у покупателей, даже если v2 придётся откатить.' },
      { t: '3. Перенос старых данных', sql: 'UPDATE customers SET phone_e164 = normalize(phone)\n WHERE phone_e164 IS NULL AND id BETWEEN $1 AND $2;\n-- пачками по 1 000 строк, с паузами', cols: ['phone', 'phone_e164'], fill: 1, pods: [0, 10, 0], ok: { 2: true }, back: true, err: 0, txt: 'Старые строки дозаполняем небольшими пачками: одна огромная UPDATE держала бы блокировки и раздула бы журнал. Теперь новая колонка полная.', biz: 'Фоновая работа на ночь, нагрузка на базу небольшая, покупатели не замечают.' },
      { t: '4. v3 читает только новое', sql: '-- v3: читает и пишет только phone_e164\n-- phone больше никто не трогает', cols: ['phone', 'phone_e164'], fill: 1, pods: [0, 3, 7], ok: { 2: true, 3: true }, back: true, err: 0, txt: 'v1 нигде не осталось, окно отката на v1 закрыто. v3 работает только с новой колонкой; откат на v2 по-прежнему безопасен — v2 тоже читает <code>phone_e164</code>.', biz: 'Ещё один спокойный релиз. Старую колонку пока не трогаем — на всякий случай.' },
      { t: '5. Contract: удалили старое', sql: '-- через неделю, когда phone никто не читает:\nALTER TABLE customers DROP COLUMN phone;', cols: ['phone_e164'], fill: 1, pods: [0, 0, 10], ok: { 3: true }, back: true, err: 0, txt: 'Удаляем старую колонку в самом конце, когда её точно никто не читает. Пять шагов, ноль ошибок, на каждом шаге можно было остановиться или откатиться.', biz: 'Итог: три релиза и неделя вместо одного вечера, ≈ 1–2 дня работы разработчика — и ни одного потерянного заказа.' }
    ]
  };

  /* ================= экземпляр лаборатории ================= */
  const MODE_KEY = 'amp-stroyka-ld-mode';
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
  const TABS = [['live', '1', 'Выкладка'], ['cmp', '2', 'Сравнение'], ['mig', '3', 'Миграция базы'], ['memo', '✓', 'Итоги']];
  const PRESETS = [['Без бага', 0, 0], ['Мелкий баг 1 %', 0.01, 0], ['Баг 10 %', 0.1, 0], ['Тормоза +300 мс', 0, 300]];

  function makeLab(EL, doneFn) {
    let MODE = readMode();
    const U = { tab: 'live', strat: 'rolling', P: { err: 0.1, lat: 0, surge: 1, unav: 0 }, spd: 3, scale: 1, run: null, timer: 0, paused: false, dots: [], mem: {}, logN: -1, cmp: null, mig: { path: 'brk', i: 0 }, alive: true };
    const done = id => { try { doneFn(id); } catch (e) { /* задания не засчитываются — не страшно */ } };
    const isBiz = () => MODE === 'biz';
    const $ = s => EL.querySelector(s);
    const sc = () => SCALES.find(x => x.k === U.scale) || SCALES[0];

    /* ---------- прогон ---------- */
    function stopTimer() { if (U.timer) clearInterval(U.timer); U.timer = 0; }
    function resetRun() { stopTimer(); U.run = null; U.dots = []; U.paused = false; U.logN = -1; U.mem = {}; }
    function deploy() {
      resetRun();
      U.run = mkRun(U.strat, U.P);
      if (isCalm()) { while (!U.run.done) step(U.run); finish(); return; }
      U.timer = setInterval(frame, 50);
      drawLive();
    }
    function frame() {
      if (!U.alive || !U.run) { stopTimer(); return; }
      if (U.paused) return;
      const S = U.run;
      for (let k = 0; k < U.spd && !S.done; k++) step(S);
      const now = performance.now();
      U.dots = U.dots.filter(d => now - d.b < 760);
      if (S.smp.length && U.dots.length < 40) for (let k = 0; k < 2; k++) { const s = S.smp[Math.floor(Math.random() * S.smp.length)]; U.dots.push({ pid: s.pid, v: s.v, fail: s.fail, b: now - k * 120, j: Math.random() * 2 - 1 }); }
      drawLive();
      if (S.done) { stopTimer(); finish(); }
    }
    function toEnd() { if (!U.run) U.run = mkRun(U.strat, U.P); stopTimer(); while (!U.run.done) step(U.run); finish(); }
    function finish() {
      const S = U.run; if (!S) return;
      U.dots = [];
      const m = summary(S, U.scale);
      if (S.strat === 'recreate' && S.down > 0 && S.liveAt != null) done('down');
      if (S.strat === 'rolling' && S.P.err >= 0.1 && S.rb) done('rolling');
      if (S.strat === 'bg' && S.rb) done('bg');
      if (S.strat === 'canary' && S.rb && m.share < 0.02) done('canary');
      drawLive();
    }

    /* ---------- шапка: вкладки и режим ---------- */
    function setTab(k) {
      U.tab = k;
      EL.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      render();
      const tabs = $('.ld-tabs'), box = EL.closest('.lab-main');
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
      const v = $('#ldView'); if (!v) return;
      U.logN = -1;
      if (U.tab === 'live') v.innerHTML = liveHTML();
      else if (U.tab === 'cmp') v.innerHTML = cmpHTML();
      else if (U.tab === 'mig') v.innerHTML = migHTML();
      else v.innerHTML = memoHTML();
      if (U.tab === 'live') drawLive();
      if (U.tab === 'cmp') growBars();
    }

    /* ---------- вкладка «Выкладка» ---------- */
    const seg = (name, items, cur, cls) => `<div class="seg ld-seg ${cls || ''}" role="group" aria-label="${esc(name)}">${items.map(([v, t]) => `<button type="button" data-set="${name}:${v}" aria-selected="${String(v) === String(cur)}">${t}</button>`).join('')}</div>`;
    function bugCtl() {
      const B = isBiz();
      return `<div class="ld-ctl"><div class="ld-rl"><span>${B ? 'Сколько оформлений ломает новая версия' : 'Доля ошибок в v2'}</span><output id="ldErrOut">${pc(U.P.err)}</output></div><input type="range" class="ld-range" id="ldErr" min="0" max="30" step="1" value="${Math.round(U.P.err * 100)}" aria-label="Доля ошибок в v2, процентов"></div>
        <div class="ld-ctl"><div class="ld-rl"><span>${B ? 'Насколько медленнее отвечает новая версия' : 'Рост задержки в v2'}</span><output id="ldLatOut">+${U.P.lat} мс</output></div><input type="range" class="ld-range" id="ldLat" min="0" max="500" step="50" value="${U.P.lat}" aria-label="Рост задержки в v2, миллисекунд"></div>
        <div class="ld-presets">${PRESETS.map(([t, e, l], i) => `<button type="button" class="btn ${U.P.err === e && U.P.lat === l ? 'on' : ''}" data-pre="${i}">${t}</button>`).join('')}</div>`;
    }
    function panelHTML() {
      const B = isBiz(), I = INFO[U.strat];
      let h = bugCtl() + `<div class="ld-btns"><button type="button" class="btn primary" data-act="go">${U.run ? 'Выкатить заново' : 'Выкатить v2'}</button><button type="button" class="btn" data-act="pause" ${U.run && !U.run.done ? '' : 'disabled'}>${U.paused ? 'Дальше' : 'Пауза'}</button><button type="button" class="btn" data-act="end" ${U.run && U.run.done ? 'disabled' : ''}>До конца</button><button type="button" class="btn ghost" data-act="reset" ${U.run ? '' : 'disabled'}>Сначала</button></div>
        <div class="ld-ctl"><b>Скорость показа</b>${seg('spd', [[1, 'Медленно'], [3, 'Обычно'], [10, 'Быстро']], U.spd)}</div>`;
      if (U.strat === 'rolling') h += `<div class="ld-ctl"><b>maxSurge — сколько подов можно добавить сверх 10</b>${seg('surge', [0, 1, 2, 3].map(v => [v, v]), U.P.surge)}</div>
        <div class="ld-ctl"><b>maxUnavailable — на сколько можно опустить число готовых</b>${seg('unav', [0, 1, 2, 3].map(v => [v, v]), U.P.unav)}</div>
        ${!U.P.surge && !U.P.unav ? '<p class="ld-note">Оба нуля — Kubernetes не сможет сделать ни шага; при выкатке maxSurge станет 1.</p>' : ''}`;
      if (B) h += `<div class="ld-ctl"><b>Масштаб бизнеса</b>${seg('scale', SCALES.map(s => [s.k, s.n]), U.scale)}<small class="ld-sub">${nf(sc().ordH)} заказов в час · средний чек ${nf(BIZ.check)} ₽</small></div>`;
      return h;
    }
    function liveHTML() {
      const I = INFO[U.strat], B = isBiz();
      return `<div class="ld-strats" role="group" aria-label="Стратегия выкладки">${STRATS.map(s => `<button type="button" data-strat="${s.k}" aria-pressed="${s.k === U.strat}"><b>${s.n}</b><small>${s.en}</small></button>`).join('')}</div>
        ${ana(I.life, I.plain, B ? '' : I.term)}${B ? `<div class="ld-card biz"><b>Для бизнеса.</b> ${I.biz}</div>` : ''}
        <div class="ld-work"><div class="ld-panel" id="ldPanel">${panelHTML()}</div>
          <div class="ld-stagecol"><div class="ld-stage" id="ldStage"></div><div class="ld-kpis" id="ldKpis"></div><div class="ld-card"><b>${B ? 'Что происходит по шагам' : 'Как идёт выкатка'}</b><ol>${I.how.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div></div></div>
        <div class="ld-charts" id="ldCharts"></div>
        <div class="ld-bottom"><div class="ld-logbox"><b class="ld-h">Журнал выкладки</b><ol class="ld-log" id="ldLog"></ol></div><div id="ldResult"></div></div>`;
    }
    const tile = (label, val, sub, cls) => `<div class="ld-kpi ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    function kpisHTML(S) {
      const m = summary(S, U.scale), B = isBiz(), running = S.t > 0 && !S.done, bug = bugOn(S.P);
      const rec = S.rbAt != null ? (m.bad != null ? dur(m.bad) : 'идёт откат') : bug && S.badFrom != null ? (running ? 'ещё нет' : 'не откатили') : '—';
      const recSub = S.rbAt != null ? `заметили за ${dur(S.rbAt - S.badFrom)}${m.undo != null ? ` · откат ${dur(m.undo)}` : ''}` : bug && S.badFrom != null && !running ? 'баг остался в проде' : 'от первой ошибки v2 до конца';
      const roll = m.rollout != null ? dur(m.rollout) : S.rb ? 'не дошла' : S.t && S.deployAt != null ? 'идёт…' : '—';
      if (!B) return tile('Покупателей увидели ошибку', nf(m.users), `из ${nf(USERS)} онлайн · ${pc(m.share)}`, m.users ? 'bad' : 'ok')
        + tile('Полный простой', dur(m.down), m.down ? 'никто не мог купить' : 'ни секунды', m.down ? 'bad' : 'ok')
        + tile('До отката', rec, recSub, S.rbAt != null ? (m.bad <= 60 ? 'ok' : 'warn') : bug && S.badFrom != null && !running ? 'bad' : '')
        + tile('Выкатка до 100 %', roll, 'от старта до всего трафика на v2', '')
        + tile('Подов в пике', S.peak, `норма ${N}${S.peak > N ? ` · +${S.peak - N} на время выкатки` : ''}`, S.peak > N ? 'warn' : '');
      return tile('Потеряно заказов', ordN(m.lostOrd), rub(m.lostRub), m.lostOrd >= 0.5 ? 'bad' : 'ok')
        + tile('Покупателей увидели ошибку', nf(m.users * U.scale), `из ${nf(USERS * U.scale)} онлайн`, m.users ? 'bad' : 'ok')
        + tile('Магазин лежал', dur(m.down), m.down ? 'оформить заказ нельзя' : 'ни секунды', m.down ? 'bad' : 'ok')
        + tile('Восстановление', rec, recSub, S.rbAt != null ? (m.bad <= 60 ? 'ok' : 'warn') : '')
        + tile('Лишние серверы', rub(m.extraRub), `${dec(m.extraPodH, 1)} под-часа · под ≈ ${nf(BIZ.podMonth)} ₽/мес`, '')
        + tile('Дежурный', m.alert ? 'разбудили' : 'не нужен', m.human ? `≈ 1 ч работы, ${rub(BIZ.engH)}` : m.alert ? 'алерт был, откатывать не пришлось' : 'автомат справился сам', m.alert ? 'warn' : 'ok');
    }
    function resultHTML(S) {
      if (!S.done) return `<div class="ld-card"><b>${S.t ? 'Идёт выкатка…' : 'Готов к выкатке.'}</b> ${S.t ? 'Смотри на точки: синие идут на v1, зелёные — на v2, красные — ошибки. Номера в кружках на графике — события журнала.' : 'Выбери стратегию и баг, нажми «Выкатить v2». Синие точки — запросы на v1, зелёные — на v2, красные — ошибки.'}</div>`;
      const m = summary(S, U.scale), B = isBiz(), P = S.P, bug = bugOn(P), nm = SN[S.strat];
      let h = `<b>Итог: ${nm}.</b> `;
      if (!bug) h += `v2 без бага. Выкатка до 100 % — ${m.rollout != null ? dur(m.rollout) : '—'}${m.down ? `, но сервис лежал ${dur(m.down)}: ${people(m.users * (B ? U.scale : 1))} получили ошибку` : m.users ? `, но ${people(m.users)} получили ошибки от перегрузки — мощности не хватило на время замены` : ', ни одной ошибки у покупателей'}.`;
      else if (S.rb) h += `Баг (${P.err ? 'ошибок ' + pc(P.err) : ''}${P.err && P.lat ? ', ' : ''}${P.lat ? '+' + P.lat + ' мс' : ''}) задел ${people(m.users * (B ? U.scale : 1))} — ${pc(m.share)} онлайн. От первой ошибки до восстановления — ${m.bad != null ? dur(m.bad) : '—'}: ${m.human ? `алерт и дежурный — ${dur(S.rbAt - S.badFrom)}` : `автомат заметил за ${dur(S.rbAt - S.badFrom)}`}, сам откат — ${m.undo != null ? dur(m.undo) : '—'}.`;
      else h += `Баг остался в проде: ${P.err < 0.02 && P.lat < 100 ? 'он меньше порогов (алерт — 2 % ошибок, анализ — +1 п. п. и +100 мс)' : 'его не успели поймать'}. Такие баги находят по жалобам — или по SLO и бюджету ошибок.`;
      if (B) h += `<p>Потеряно ≈ <b>${orders(m.lostOrd)}</b> на <b>${rub(m.lostRub)}</b>${m.extraRub >= 1 ? `, лишние серверы на время выкатки — ${rub(m.extraRub)}` : ''}${m.human ? `, плюс час дежурного ≈ ${rub(BIZ.engH)}` : ''}.</p><p class="ld-sub">Допущения: ${nf(sc().ordH)} заказов в час, средний чек ${nf(BIZ.check)} ₽; 6 из 10 покупателей после ошибки уходят; каждые +100 мс ответа — минус 1 % заказов.</p>`;
      else h += `<p class="ld-sub">${INFO[S.strat].biz}</p>`;
      return `<div class="ld-card ${!bug ? (m.users ? 'warn' : 'ok') : S.rb ? (m.share < 0.02 ? 'ok' : 'warn') : 'bad'}">${h}</div>`;
    }
    function drawLive() {
      if (U.tab !== 'live' || !U.alive) return;
      const S = U.run || mkRun(U.strat, U.P), B = isBiz();
      const st = $('#ldStage'), ch = $('#ldCharts'), kp = $('#ldKpis'), lg = $('#ldLog'), rs = $('#ldResult');
      if (!st) return;
      st.innerHTML = stageSVG(S, Math.max(420, st.clientWidth || 600), U.dots, U.mem, B);
      if (ch) ch.innerHTML = chartsHTML(S, Math.max(360, ch.clientWidth || 800), B);
      if (kp) kp.innerHTML = kpisHTML(S);
      if (lg && U.logN !== S.ev.length) {
        U.logN = S.ev.length;
        lg.innerHTML = S.ev.length ? S.ev.map(e => `<li class="${e.cls}"><span class="ld-lt">${clock(e.t)}</span>${e.n ? `<i class="ld-ln ${e.cls}">${e.n}</i>` : ''}<span>${esc(e.text)}</span></li>`).join('') : '<li class="mut"><span class="ld-lt">00:00</span><span>10 подов v1 работают, 200 запросов в секунду. Ждём выкатку.</span></li>';
        lg.scrollTop = lg.scrollHeight;
      }
      if (rs) { const k = S.done ? 'd' + S.t + MODE + U.scale : S.t ? 'r' : 'i'; if (rs.dataset.k !== k) { rs.dataset.k = k; rs.innerHTML = resultHTML(S); } }
      const pa = EL.querySelector('[data-act="pause"]'); if (pa) { pa.disabled = !(U.run && !U.run.done); pa.textContent = U.paused ? 'Дальше' : 'Пауза'; }
      const en = EL.querySelector('[data-act="end"]'); if (en) en.disabled = !!(U.run && U.run.done);
      const rr = EL.querySelector('[data-act="reset"]'); if (rr) rr.disabled = !U.run;
      const go = EL.querySelector('[data-act="go"]'); if (go) go.textContent = U.run ? 'Выкатить заново' : 'Выкатить v2';
    }
    function rePanel() { const p = $('#ldPanel'); if (p) p.innerHTML = panelHTML(); }

    /* ---------- вкладка «Сравнение» ---------- */
    function runCmp() {
      const P = Object.assign({}, U.P), P0 = Object.assign({}, U.P, { err: 0, lat: 0 });
      U.cmp = { P, rows: STRATS.map(s => ({ k: s.k, a: summary(runAll(s.k, P), U.scale), b: summary(runAll(s.k, P0), U.scale), sa: null })) };
      if (bugOn(P)) done('compare');
      render();
    }
    function bars(rows, val, fmt, cls) {
      const mx = Math.max(1e-9, ...rows.map(val));
      return rows.map(r => { const v = val(r); return `<div class="ld-bar ${cls || ''}"><span class="ld-bn">${SN[r.k]}</span><div class="ld-btrack"><i style="--w:${(v / mx * 100).toFixed(1)}%"></i></div><b>${fmt(v, r)}</b></div>`; }).join('');
    }
    function growBars() { const bs = EL.querySelectorAll('.ld-btrack i'); if (!bs.length) return; if (isCalm()) { bs.forEach(i => i.classList.add('on')); return; } requestAnimationFrame(() => requestAnimationFrame(() => bs.forEach(i => i.classList.add('on')))); }
    function cmpHTML() {
      const B = isBiz();
      let h = ana(LIFE.cmp, 'Один и тот же баг прогоняем через все пять способов и сравниваем: сколько покупателей задело, сколько длилась беда и во что обошлась сама выкатка.', B ? '' : '<b>MTTR</b> (mean time to recovery) — время от начала проблемы до восстановления: обнаружить + решить + откатить. <b>Blast radius</b> — радиус поражения: какую долю пользователей задевает плохая версия.');
      h += `<div class="ld-cmpctl"><div class="ld-cmpbug">${bugCtl()}</div><div class="ld-cmpside">${B ? `<div class="ld-ctl"><b>Масштаб бизнеса</b>${seg('scale', SCALES.map(s => [s.k, s.n]), U.scale)}</div>` : ''}<div class="ld-btns"><button type="button" class="btn primary" data-act="cmp">Прогнать все пять</button></div>${U.cmp ? `<small class="ld-sub">Последний прогон: ошибок в v2 ${pc(U.cmp.P.err)}, задержка +${U.cmp.P.lat} мс${U.cmp.P.err !== U.P.err || U.cmp.P.lat !== U.P.lat ? ' — баг поменялся, прогони снова' : ''}. Rolling: maxSurge ${U.cmp.P.surge || 1}, maxUnavailable ${U.cmp.P.unav}.</small>` : ''}</div></div>`;
      if (!U.cmp) return h + `<div class="ld-card">Нажми «Прогнать все пять»: каждая стратегия выкатит v2 дважды — с этим багом и без бага. Прогоны те же, что на вкладке «Выкладка», только без показа.</div>`;
      const R = U.cmp.rows, bug = bugOn(U.cmp.P), k = U.scale;
      const rec = r => r.a.rb ? dur(r.a.bad) : bug && r.a.stuck ? 'не откатили' : '—';
      if (!B) {
        h += `<div class="ld-tablewrap"><table class="ld-table"><thead><tr><th>Стратегия</th><th>Покупателей с ошибкой</th><th>Простой</th><th>До восстановления</th><th>Кто заметил</th><th>Выкатка без бага</th><th>Подов в пике</th></tr></thead><tbody>
          ${R.map(r => `<tr><th>${SN[r.k]}</th><td class="${r.a.users ? 'bad' : 'ok'}">${nf(r.a.users)} <small>${pc(r.a.share)}</small></td><td class="${r.a.down ? 'bad' : ''}">${dur(r.a.down)}</td><td>${rec(r)}${r.a.rb && r.a.undo != null ? `<small>откат ${dur(r.a.undo)}</small>` : ''}</td><td>${r.a.rb ? (r.a.human ? 'алерт + дежурный' : 'автомат') : '—'}</td><td>${r.b.rollout != null ? dur(r.b.rollout) : '—'}${r.b.down ? `<small>простой ${dur(r.b.down)}</small>` : ''}</td><td>${r.b.peak}</td></tr>`).join('')}</tbody></table></div>`;
        h += `<div class="ld-cmpbars"><div class="ld-card"><b>Покупателей с ошибкой — с багом</b>${bars(R, r => r.a.users, v => nf(v), 'bad')}</div><div class="ld-card"><b>Время выкатки без бага</b>${bars(R, r => r.b.rollout || 0, v => dur(v), 'acc')}</div></div>`;
      } else {
        h += `<div class="ld-tablewrap"><table class="ld-table"><thead><tr><th>Стратегия</th><th>Потеряно заказов</th><th>Потеряно выручки</th><th>Магазин лежал</th><th>Дежурный</th><th>Выкатка без бага</th><th>Лишние серверы</th></tr></thead><tbody>
          ${R.map(r => `<tr><th>${SN[r.k]}</th><td class="${r.a.lostOrd >= 0.5 ? 'bad' : 'ok'}">${ordN(r.a.lostOrd)}</td><td class="${r.a.lostOrd >= 0.5 ? 'bad' : 'ok'}">${rub(r.a.lostRub)}</td><td class="${r.a.down ? 'bad' : ''}">${dur(r.a.down)}</td><td>${r.a.alert ? 'разбудили' : 'не нужен'}</td><td>${r.b.rollout != null ? dur(r.b.rollout) : '—'}</td><td>${rub(r.b.extraRub)}</td></tr>`).join('')}</tbody></table></div>`;
        h += `<div class="ld-cmpbars"><div class="ld-card"><b>Потеряно выручки — с багом</b>${bars(R, r => r.a.lostRub, v => rub(v), 'bad')}</div><div class="ld-card"><b>Лишние серверы на одну выкатку</b>${bars(R, r => r.b.extraRub, v => rub(v), 'acc')}</div></div>`;
      }
      /* вывод из чисел */
      const by = (f, dir) => R.slice().sort((x, y) => dir * (f(x) - f(y)))[0];
      const best = by(r => r.a.users, 1), worst = by(r => r.a.users, -1), fast = by(r => r.b.rollout || 1e9, 1), slow = by(r => r.b.rollout || 0, -1);
      const bg = R.find(r => r.k === 'bg');
      let c = '';
      if (!bug) c = `Бага нет — видно только цену и скорость самой выкатки. Быстрее всех — ${SN[fast.k]} (${dur(fast.b.rollout)}), медленнее всех — ${SN[slow.k]} (${dur(slow.b.rollout)}). ${R.find(r => r.k === 'recreate').b.down ? `«Всё сразу» даже без бага кладёт сервис на ${dur(R.find(r => r.k === 'recreate').b.down)}.` : ''} Поставь баг — и сравни откаты.`;
      else if (!B) c = `Меньше всего задело: <b>${SN[best.k]}</b> — ${people(best.a.users)}. Больше всего: <b>${SN[worst.k]}</b> — ${people(worst.a.users)}${best.a.users ? ` (в ${nf(worst.a.users / Math.max(1, best.a.users))} раз больше)` : ''}. Без бага быстрее всех выкатывает ${SN[fast.k]} (${dur(fast.b.rollout)}), медленнее — ${SN[slow.k]} (${dur(slow.b.rollout)}): за безопасность платим временем. Blue-green откатывается за секунду, но ждёт человека, поэтому задевает почти столько же, сколько rolling.`;
      else c = `Дешевле всего баг обошёлся с <b>${SN[best.k]}</b> — ${rub(best.a.lostRub)}; дороже всего с <b>${SN[worst.k]}</b> — ${rub(worst.a.lostRub)}. Двойное окружение blue-green на время выкатки стоило ${rub(bg.b.extraRub)} — ${bg.b.extraRub < BIZ.check ? 'меньше одного среднего чека' : 'заметно, но меньше потерь от бага'}. Канарейка и флаг выкатывают дольше (${dur(R.find(r => r.k === 'canary').b.rollout || 0)} и ${dur(R.find(r => r.k === 'flag').b.rollout || 0)}), зато не будят дежурного.`;
      return h + `<div class="ld-card ${bug ? 'info' : ''}"><b>Что видно.</b> ${c}</div>`;
    }

    /* ---------- вкладка «Миграция базы» ---------- */
    function migHTML() {
      const B = isBiz(), M = U.mig, L = MIG[M.path], s = L[M.i], prev = M.i ? L[M.i - 1] : null, last = M.i === L.length - 1;
      let h = ana(LIFE.mig, 'Код и база меняются не одновременно: пока идёт выкатка, старая и новая версии работают с одной и той же базой. Значит, схема на каждом шаге должна подходить обеим.', B ? '' : '<b>Expand/contract</b> (parallel change): <b>expand</b> — добавить новое, не ломая старое; переключить код; <b>contract</b> — удалить старое, когда им никто не пользуется. Каждая миграция обратно совместима — и откат возможен на любом шаге.');
      h += `<div class="ld-migtop">${seg('path', [['brk', 'Сломать за один шаг'], ['ec', 'Expand / contract']], M.path, 'ld-pathseg')}<ol class="ld-steps">${L.map((x, i) => `<li><button type="button" data-mi="${i}" class="${i === M.i ? 'on' : i < M.i ? 'past' : ''} ${x.err ? 'bad' : ''}">${esc(x.t)}</button></li>`).join('')}</ol></div>`;
      /* таблица customers */
      const rows = CUST.length, nFill = Math.round(s.fill * rows), pFill = prev ? Math.round(prev.fill * rows) : 0;
      const newCol = c => prev && !prev.cols.includes(c);
      const cell = (c, r, i) => {
        if (c === 'phone') return `<td>${esc(r[1])}</td>`;
        const val = M.path === 'brk' ? r[1] : i < nFill ? r[2] : null, isNew = M.path === 'ec' && i < nFill && i >= pFill;
        return `<td class="${val == null ? 'null' : ''} ${isNew ? 'new' : ''}" style="${isNew ? `--d:${(i - pFill) * 90}ms` : ''}">${val == null ? 'NULL' : esc(val)}</td>`;
      };
      const tbl = `<div class="ld-tablewrap"><table class="ld-table ld-db"><caption>Таблица <code>customers</code></caption><thead><tr><th>id</th>${s.cols.map(c => `<th class="${newCol(c) ? 'new' : ''}">${c}</th>`).join('')}</tr></thead><tbody>${CUST.map((r, i) => `<tr><th>${r[0]}</th>${s.cols.map(c => cell(c, r, i)).join('')}</tr>`).join('')}</tbody></table></div>`;
      const pods = []; [1, 2, 3].forEach((v, k) => { for (let j = 0; j < s.pods[k]; j++) pods.push(v); });
      const vers = [1, 2, 3].filter((v, k) => s.pods[k] > 0);
      const podsH = `<div class="ld-mpods" aria-label="Поды приложения">${pods.map(v => `<span class="ld-mpod v${v} ${s.ok[v] === false ? 'bad' : ''}">v${v}${s.ok[v] === false ? ' ✗' : ''}</span>`).join('')}</div>`;
      const st = `<div class="ld-mstat">${vers.map(v => `<span class="ld-chip ${s.ok[v] === false ? 'bad' : 'ok'}">v${v} ${s.ok[v] === false ? 'падает' : 'работает'}</span>`).join('')}<span class="ld-chip ${s.back ? 'ok' : 'bad'}">${s.back ? 'откат возможен' : 'откат невозможен'}</span></div>
        <div class="ld-meter"><span>${B ? 'Оформления заказов с ошибкой' : 'Ошибок при оформлении заказа'}</span><div class="ld-btrack"><i class="on ${s.err ? 'bad' : ''}" style="--w:${s.err * 100}%"></i></div><b>${pc(s.err)}</b></div>`;
      const ordMin = sc().ordH / 60, lost = ordMin * (1 * 1 + 0.5 * 3) * BIZ.abandon;
      const loss = M.path === 'brk' && M.i >= 2 ? `<div class="ld-card bad"><b>${B ? 'Цена ошибки' : 'Итог одного шага'}:</b> ≈ 1 минута, пока заметили, и ≈ 3 минуты rolling — ${B ? `потеряно ≈ <b>${orders(lost)}</b> на <b>${rub(lost * BIZ.check)}</b> (${nf(sc().ordH)} заказов в час), а следующий баг в v2 придётся чинить без отката` : `≈ ${nf(ordMin * 2.5)} неудачных оформлений при ${nf(sc().ordH)} заказах в час. Правило: переименование и удаление колонок — только последним шагом, когда старый код уже нигде не работает`}.</div>` : '';
      const fin = M.path === 'ec' && last ? `<div class="ld-card ok"><b>Ноль ошибок.</b> ${B ? 'Цена — три спокойных релиза и неделя ожидания вместо одного вечера.' : 'Пять шагов, и на любом можно было остановиться. Так же меняют тип колонки, делят таблицу, переносят данные в другую базу.'}</div>` : '';
      h += `<div class="ld-mig"><div class="ld-migl"><pre class="ld-code">${esc(s.sql)}</pre><div class="ld-card ${s.err ? 'bad' : ''}"><b>${esc(s.t)}.</b> ${B ? s.biz : s.txt}</div>${loss}${fin}
          <div class="ld-btns"><button type="button" class="btn" data-act="mprev" ${M.i ? '' : 'disabled'}>← Назад</button><button type="button" class="btn primary" data-act="mnext" ${last ? 'disabled' : ''}>Дальше →</button><button type="button" class="btn ghost" data-act="mreset" ${M.i ? '' : 'disabled'}>Сначала</button>${last && M.path === 'brk' ? '<button type="button" class="btn" data-path="ec">Попробовать expand / contract</button>' : ''}</div></div>
        <div class="ld-migr">${tbl}<b class="ld-h">Поды приложения</b>${podsH}${st}</div></div>`;
      return h;
    }
    function migGo(i) { const L = MIG[U.mig.path]; U.mig.i = Math.max(0, Math.min(L.length - 1, i)); if (U.mig.path === 'ec' && U.mig.i === L.length - 1) done('expand'); render(); }

    /* ---------- вкладка «Итоги» ---------- */
    function memoHTML() {
      const L = isBiz() ? MEMO_BIZ : MEMO;
      return `<b class="ld-h">Что запомнить</b><div class="ld-memo">${L.map(([t, xs]) => `<div class="ld-card"><b>${t}</b><ul>${xs.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')}</div>
        <div class="ld-card info"><b>Как выбрать.</b> ${isBiz() ? 'Внутренний сервис, ночь, простой не страшен — «всё сразу». Обычный сервис — rolling. Платежи и оформление заказа — канарейка с автоматическим анализом. Новая функция для покупателей — флаг. Нужен откат за секунду любой ценой — blue-green.' : 'Простой допустим — recreate. По умолчанию — rolling с maxUnavailable 0. Критичный путь (оплата) — canary с анализом метрик. Новая функция — за флагом. Мгновенный откат важнее денег — blue-green. И всегда: схема базы совместима с двумя версиями.'}</div>`;
    }

    /* ---------- события ---------- */
    const markSeg = b => b.parentNode.querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    function afterParam() {
      if (U.tab === 'live') { resetRun(); rePanel(); drawLive(); }
      else render();
    }
    function onClick(e) {
      const b = e.target.closest('[data-tab],[data-mode],[data-strat],[data-set],[data-act],[data-pre],[data-mi],[data-path]');
      if (!b || !EL.contains(b) || b.disabled) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.mode) return setMode(d.mode);
      if (d.strat) { U.strat = d.strat; resetRun(); render(); return; }
      if (d.pre != null) { const p = PRESETS[+d.pre]; U.P.err = p[1]; U.P.lat = p[2]; afterParam(); return; }
      if (d.path) { U.mig = { path: d.path, i: 0 }; render(); return; }
      if (d.mi != null) { migGo(+d.mi); return; }
      if (d.set) {
        const i = d.set.indexOf(':'), k = d.set.slice(0, i), v = +d.set.slice(i + 1);
        if (k === 'path') { U.mig = { path: d.set.slice(i + 1), i: 0 }; render(); return; }
        if (k === 'spd') { U.spd = v; markSeg(b); return; }
        if (k === 'scale') { U.scale = v; const box = EL.closest('.lab-main'), y = box ? box.scrollTop : 0; if (U.tab === 'cmp' && U.cmp) runCmp(); else render(); if (box) box.scrollTop = y; return; }
        U.P[k] = v; afterParam(); return;
      }
      const a = d.act;
      if (a === 'go') deploy();
      else if (a === 'pause') { U.paused = !U.paused; drawLive(); }
      else if (a === 'end') toEnd();
      else if (a === 'reset') { resetRun(); drawLive(); }
      else if (a === 'cmp') runCmp();
      else if (a === 'mnext') migGo(U.mig.i + 1);
      else if (a === 'mprev') migGo(U.mig.i - 1);
      else if (a === 'mreset') migGo(0);
    }
    function onInput(e) {
      const t = e.target; if (t.id !== 'ldErr' && t.id !== 'ldLat') return;
      if (t.id === 'ldErr') { U.P.err = +t.value / 100; const o = $('#ldErrOut'); if (o) o.textContent = pc(U.P.err); }
      else { U.P.lat = +t.value; const o = $('#ldLatOut'); if (o) o.textContent = '+' + U.P.lat + ' мс'; }
      EL.querySelectorAll('[data-pre]').forEach(x => { const p = PRESETS[+x.dataset.pre]; x.classList.toggle('on', p[1] === U.P.err && p[2] === U.P.lat); });
      if (U.tab === 'live' && U.run) { resetRun(); drawLive(); }
    }

    /* ---------- сборка ---------- */
    EL.innerHTML = `<div class="ld"><div class="ld-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}<div class="seg ld-mode" role="group" aria-label="Как объяснять">${[['tech', 'Техника'], ['biz', 'Бизнес']].map(([k, t]) => `<button type="button" data-mode="${k}" aria-selected="${MODE === k}">${t}</button>`).join('')}</div></div><div class="ld-view" id="ldView"></div></div>`;
    EL.addEventListener('click', onClick); EL.addEventListener('input', onInput);
    let raf = 0, lastW = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { const w = EL.clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (U.tab === 'live') drawLive(); }); }) : null;
    if (ro) ro.observe(EL);
    render();
    return {
      destroy() {
        U.alive = false; stopTimer();
        EL.removeEventListener('click', onClick); EL.removeEventListener('input', onInput);
        if (ro) ro.disconnect(); cancelAnimationFrame(raf);
      }
    };
  }

  /* ================= регистрация ================= */
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'deploy', title: 'Выкладка вживую', lede: 'Всё сразу, rolling, blue-green, канарейка, флаги',
    intro: 'Сервис из 10 подов версии v1 работает под живым трафиком: 6 000 покупателей, 200 запросов в секунду. Выкатываем v2, в которой может быть баг — ползунками задаёшь долю ошибок и рост задержки. Пять стратегий, графики ошибок и задержки, сколько покупателей увидели ошибку и сколько длился откат. Переключатель «Техника | Бизнес» переводит всё в заказы и рубли.',
    tasks: [
      { id: 'down', text: 'Выкати v2 «всё сразу» и найди простой на графике ошибок' },
      { id: 'rolling', text: 'Rolling update с багом от 10 %: дождись алерта и ручного отката' },
      { id: 'bg', text: 'Blue-green: откати плохую версию одним переключением балансировщика' },
      { id: 'canary', text: 'Канарейка сама откатывает баг, пока он задел меньше 2 % покупателей' },
      { id: 'compare', text: 'Сравни пять стратегий на одном баге' },
      { id: 'expand', text: 'Проведи миграцию базы через expand/contract без единой ошибки' }
    ],
    mount(el, api) {
      const inst = makeLab(el, tid => api && api.done(tid));
      return () => inst.destroy();
    }
  });
})();
