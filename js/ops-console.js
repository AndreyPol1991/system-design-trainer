/* Консоли наблюдаемости на живых данных площадки: Grafana, Kibana, Prometheus, Alertmanager, Jaeger.
   Раз в секунду снимаем «метрики» с текущего расчёта симулятора, пишем логи и трейсы, считаем правила алертов.
   Сбой устраивается прямо отсюда — так проверяют, что наблюдаемость действительно работает (game day). */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const A = () => SD.app.A;
  const lbl = n => n ? (n.label || SD.TYPES[n.type].name) : '';
  const SVC = new Set(['app', 'worker', 'ws', 'faas', 'gateway', 'agent', 'llm', 'router']);
  const N = 120, PAL = ['--k-read', '--k-write', '--k-job', '--k-events', '--k-search', '--k-geo'];
  const qf = u => 1 / (1 - Math.min(0.93, Math.max(0, u)));
  const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const clock = t => new Date(t).toTimeString().slice(0, 8);
  const ms = v => v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + ' с' : Math.round(v) + ' мс';

  const O = { series: {}, sys: [], logs: [], traces: [], rules: [], notes: [], acc: 0, t0: 0, gd: {}, q: '', lvl: 'ALL', svc: '', trace: null, prom: 'rps' };
  const ost = () => (SD.opsState ? SD.opsState(A().graph) : null);
  const canvas = () => { const s = ost(); return s && s.any ? s : null; };
  const caps = () => { const s = canvas(); if (s) return { logs: s.logs.size > 0, metrics: s.metrics.size > 0, alerts: s.alerts, traces: s.traces.size > 0 }; return SD.landscape ? SD.landscape.caps() : {}; };
  const wired = (kind, n) => { const s = canvas(); return !s || s[kind].has(n.id); };

  /* ---------- снимок метрик с симулятора ---------- */
  function svcs() { return A().graph.nodes.filter(n => SVC.has(n.type)).slice(0, 6); }
  function stores() { return A().graph.nodes.filter(n => ['sql', 'nosql', 'cache', 'queue', 'search', 'objstore'].includes(n.type)).slice(0, 4); }
  function down(n) { const d = (A().down || {})[n.id] || 0, r = (A().res || { nodes: {} }).nodes[n.id] || {}; return { d, all: d >= (r.count || n.props.count || 1) }; }
  function errOf(n) {
    const r = (A().res || { nodes: {} }).nodes[n.id] || {}, dn = down(n);
    if (r.dead || dn.all) return 1;
    let e = r.util > 1 ? 1 - 1 / r.util : 0.0008 + Math.random() * 0.0012;
    if (dn.d) e = Math.max(e, dn.d / (dn.d + (r.alive || 1)) * 0.6);
    return Math.min(1, e);
  }
  function latOf(n) { const r = (A().res || { nodes: {} }).nodes[n.id] || {}; return (SD.TYPES[n.type].lat || 5) * qf(r.util || 0) * (0.85 + Math.random() * 0.3); }
  function sample(now) {
    const res = A().res; if (!res) return;
    const list = svcs().concat(stores());
    list.forEach(n => {
      const r = res.nodes[n.id] || {};
      const s = O.series[n.id] = O.series[n.id] || [];
      s.push({ t: now, rps: (r.rps || 0) * (0.95 + Math.random() * 0.1), err: errOf(n), lat: latOf(n), cpu: Math.min(1.5, r.util || 0) * (0.95 + Math.random() * 0.1), up: !down(n).all });
      if (s.length > N) s.shift();
    });
    const p95 = (res.total.lat || 0) * 1.9 * (0.9 + Math.random() * 0.2);
    O.sys.push({ t: now, rps: res.total.rps, err: 1 - res.total.success, p95 });
    if (O.sys.length > N) O.sys.shift();
    logs(now); traces(now); alerts(now);
  }

  /* ---------- логи ---------- */
  const deps = n => A().graph.edges.filter(e => e.from === n.id).map(e => A().graph.nodes.find(x => x.id === e.to)).filter(Boolean);
  function line(now, n, lvl, msg, tid) { O.logs.push({ t: now, svc: lbl(n), lvl, msg, tid }); }
  function logs(now) {
    if (!caps().logs) return;
    svcs().filter(n => wired('logs', n)).forEach(n => {
      const r = (A().res || { nodes: {} }).nodes[n.id] || {}, e = errOf(n), k = Math.min(3, Math.max(1, Math.round((r.rps || 0) / 800)));
      for (let i = 0; i < k; i++) {
        const tid = hex(16), id = Math.floor(Math.random() * 90000) + 10000, l = Math.round(latOf(n));
        if (Math.random() < e * 4 + 0.01 && e > 0.003) {
          const d = deps(n).find(x => down(x).all || ((A().res.nodes[x.id] || {}).util || 0) > 1) || deps(n)[0];
          const msg = down(n).all ? 'pod terminated: OOMKilled, restarting (CrashLoopBackOff)' : d && down(d).all ? `connection refused ${lbl(d)}:5432 — dependency is down` : d ? `timeout after 1000ms calling «${lbl(d)}»` : '503 Service Unavailable: thread pool exhausted';
          line(now, n, 'ERROR', msg, tid);
        } else if (Math.random() < 0.15 && (r.util || 0) > 0.7) line(now, n, 'WARN', `slow request ${l * 6}ms on GET /orders/${id} (CPU ${Math.round((r.util || 0) * 100)} %)`, tid);
        else line(now, n, 'INFO', n.type === 'worker' ? `processed message order.created offset=${id} in ${l}ms` : Math.random() < 0.7 ? `GET /orders/${id} 200 ${l}ms` : `POST /orders 201 ${l + 8}ms`, tid);
      }
      const lost = deps(n).filter(x => down(x).d && !down(x).all);
      if (lost.length && Math.random() < 0.6) line(now, n, 'ERROR', `connection to «${lbl(lost[0])}» lost: instance down, reconnecting to another`, hex(16));
    });
    O.logs = O.logs.slice(-400);
  }

  /* ---------- трейсы: путь запроса по схеме ---------- */
  function buildTrace(now, tid) {
    const g = A().graph, res = A().res; if (!res) return null;
    const start = g.nodes.find(n => n.type === 'client'); if (!start) return null;
    const spans = [];
    let err = false;
    const walk = (n, t0, depth, seen) => {
      if (depth > 7 || seen.has(n.id)) return 0;
      seen.add(n.id);
      const own = n.type === 'client' ? 0 : latOf(n), dn = down(n).all;
      const sp = { svc: lbl(n), op: n.type === 'client' ? 'запрос пользователя' : n.type === 'sql' ? 'SELECT … FROM orders' : n.type === 'cache' ? 'GET order:42' : n.type === 'queue' ? 'publish order.created' : n.type === 'lb' ? 'proxy' : 'GET /orders/42', t: t0, d: 0, depth, err: dn };
      spans.push(sp);
      if (dn) { err = true; sp.d = 1000; sp.op += ' — нет ответа'; return sp.d; }
      let cur = t0 + own * 0.4;
      const kids = g.edges.filter(e => e.from === n.id && (((res.edges[e.id] || {}).byKind || {}).read > 0 || ['app', 'cache', 'sql', 'nosql', 'external', 'search'].includes((g.nodes.find(x => x.id === e.to) || {}).type))).map(e => g.nodes.find(x => x.id === e.to)).filter(Boolean);
      kids.filter(k => k.type !== 'queue' && k.type !== 'worker').slice(0, 3).forEach(k => { cur += walk(k, cur, depth + 1, seen) + 0.3; });
      sp.d = cur - t0 + own * 0.6;
      return sp.d;
    };
    walk(start, 0, 0, new Set());
    if (spans.length < 2) return null;
    const tot = Math.max(...spans.map(s => s.t + s.d));
    return { tid, t: now, spans, tot, err };
  }
  function traces(now) {
    if (!caps().traces) return;
    const t = buildTrace(now, hex(16)); if (t) O.traces.push(t);
    const tagged = O.logs.slice(-6).find(l => l.lvl === 'ERROR' && !O.traces.some(x => x.tid === l.tid));
    if (tagged) { const t2 = buildTrace(now, tagged.tid); if (t2) { t2.err = true; O.traces.push(t2); } }
    O.traces = O.traces.slice(-40);
  }

  /* ---------- правила алертов ---------- */
  const RULES = [
    { id: 'InstanceDown', sev: 'critical', expr: 'up == 0', for: 8, text: 'Экземпляр сервиса не отвечает', check: () => svcs().filter(n => wired('metrics', n)).concat(canvas() ? [] : stores()).filter(n => down(n).d).map(lbl) },
    { id: 'HighErrorRate', sev: 'critical', expr: 'ошибки / запросы > 1 % за 1 мин', for: 15, text: 'Доля ошибок выше 1 %', check: () => { const s = O.sys.slice(-5); return s.length && s.reduce((a, x) => a + x.err, 0) / s.length > 0.01 ? ['вся система'] : []; } },
    { id: 'HighLatency', sev: 'warning', expr: 'p95 > 500 мс за 1 мин', for: 20, text: 'Медленные ответы', check: () => { const s = O.sys.slice(-5); return s.length && s.reduce((a, x) => a + x.p95, 0) / s.length > 500 ? ['вся система'] : []; } },
    { id: 'HighCPU', sev: 'warning', expr: 'CPU > 85 % за 1 мин', for: 20, text: 'Сервис на пределе по CPU', check: () => svcs().filter(n => wired('metrics', n)).filter(n => { const s = (O.series[n.id] || []).slice(-5); return s.length && s.reduce((a, x) => a + x.cpu, 0) / s.length > 0.85; }).map(lbl) }
  ];
  function alerts(now) {
    if (!O.rules.length) O.rules = RULES.map(r => ({ r, st: 'ok', since: 0, who: [] }));
    const c = caps();
    O.rules.forEach(x => {
      const who = c.metrics ? x.r.check() : [];
      if (who.length) {
        if (x.st === 'ok') { x.st = 'pending'; x.since = now; }
        if (x.st === 'pending' && now - x.since >= x.r.for * 1000) {
          x.st = 'firing'; x.who = who;
          O.notes.unshift({ t: now, cls: 'bad', txt: c.alerts ? `📟 Дежурному в Telegram: [${x.r.sev.toUpperCase()}] ${x.r.id} — ${x.r.text}: ${who.join(', ')}` : `Правило ${x.r.id} сработало, но Alertmanager выключен — дежурный ничего не узнал` });
          if (c.alerts) O.gd.alert = true;
        }
      } else if (x.st !== 'ok') {
        if (x.st === 'firing') { O.notes.unshift({ t: now, cls: 'ok', txt: c.alerts ? `✅ RESOLVED: ${x.r.id} — снова в норме` : `${x.r.id} прошло само` }); if (c.alerts) O.gd.resolved = true; }
        x.st = 'ok'; x.who = [];
      }
    });
    O.notes = O.notes.slice(0, 30);
    if (Object.keys(A().down || {}).length) O.gd.chaos = true;
  }

  function tick(dt) {
    O.acc += dt;
    if (O.acc >= 1000) { O.acc = 0; sample(Date.now()); return true; }
    return false;
  }
  function reset() { O.series = {}; O.sys = []; O.logs = []; O.traces = []; O.rules = []; O.notes = []; O.acc = 1000; O.trace = null; }

  /* ---------- графики ---------- */
  function chart(title, unit, lines, opts) {
    const w = 460, h = 150, pad = 46;
    const all = lines.flatMap(l => l.pts.map(p => p.v));
    const max = Math.max(opts.min || 0, ...all, 0.0001) * 1.15;
    const t1 = Date.now(), t0 = t1 - N * 1000;
    const X = t => pad + (t - t0) / (t1 - t0) * (w - pad - 8), Y = v => h - 18 - v / max * (h - 40);
    let s = `<svg class="oc-chart" viewBox="0 0 ${w} ${h}"><text class="oc-ct" x="8" y="14">${esc(title)}</text>`;
    [0, 0.5, 1].forEach(f => { const y = Y(max / 1.15 * f); s += `<line class="oc-grid" x1="${pad}" x2="${w - 8}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="oc-ax" x="${pad - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${opts.fmt(max / 1.15 * f)}</text>`; });
    if (opts.thr != null) { const y = Y(opts.thr); s += `<line class="oc-thr" x1="${pad}" x2="${w - 8}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="oc-thrt" x="${w - 10}" y="${(y - 4).toFixed(1)}" text-anchor="end">порог алерта ${opts.fmt(opts.thr)}</text>`; }
    lines.forEach(l => { if (l.pts.length > 1) s += `<polyline class="oc-line" points="${l.pts.map(p => X(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ')}" style="stroke:var(${l.c})"/>`; });
    s += `<text class="oc-ax" x="${pad}" y="${h - 4}">−2 мин</text><text class="oc-ax" x="${w - 8}" y="${h - 4}" text-anchor="end">сейчас</text></svg>`;
    s += `<div class="oc-leg">${lines.map(l => `<span><i style="background:var(${l.c})"></i>${esc(l.name)} <b>${l.pts.length ? opts.fmt(l.pts[l.pts.length - 1].v) : '—'}</b></span>`).join('')}</div>`;
    return `<div class="oc-panel">${s}</div>`;
  }
  const pct = v => (v * 100 < 1 ? (v * 100).toFixed(2) : Math.round(v * 100)).toString().replace('.', ',') + ' %';
  const num = v => SD.fmt.num(v);
  const off = (what, cap) => `<div class="oc-off"><b>${what} выключены.</b> Включи галочку «${cap}» справа в списке «Что включено» — и данные пойдут.</div>`;

  function grafana() {
    if (!caps().metrics) return off('Метрики', 'Метрики (Prometheus + Grafana)');
    O.gd.grafana = true;
    const ss = svcs().filter(n => wired('metrics', n)), L = (key, f) => ss.map((n, i) => ({ name: lbl(n), c: PAL[i % PAL.length], pts: (O.series[n.id] || []).map(p => ({ t: p.t, v: f ? f(p[key]) : p[key] })) }));
    const sys = [{ name: 'вся система', c: '--accent', pts: O.sys.map(p => ({ t: p.t, v: p.err })) }];
    let h = `<div class="oc-grid2">`;
    h += chart('Запросы в секунду по сервисам', '/с', L('rps'), { fmt: num });
    h += chart('Доля ошибок', '%', sys.concat(L('err')), { fmt: pct, thr: 0.01, min: 0.02 });
    h += chart('Время ответа p95 (вся система)', 'мс', [{ name: 'p95', c: '--warn', pts: O.sys.map(p => ({ t: p.t, v: p.p95 })) }], { fmt: v => ms(v), thr: 500, min: 600 });
    h += chart('Загрузка CPU по сервисам', '%', L('cpu'), { fmt: pct, thr: 0.85, min: 1 });
    h += `</div><p class="oc-hint">Так выглядит обычный дашборд по методу RED: Rate — сколько запросов, Errors — сколько ошибок, Duration — как долго. Пунктир — порог, после которого сработает алерт. Нажми «Уронить экземпляр» сверху и смотри, что поменяется через несколько секунд.</p>`;
    return h;
  }
  function kibana() {
    if (!caps().logs) return off('Логи', 'Логи (Loki / ELK + Kibana)');
    const q = O.q.trim().toLowerCase();
    const match = l => (O.lvl === 'ALL' || l.lvl === O.lvl) && (!O.svc || l.svc === O.svc) && (!q || (l.msg + ' ' + l.svc + ' ' + l.tid + ' ' + l.lvl).toLowerCase().includes(q));
    const rows = O.logs.filter(match);
    if ((O.lvl === 'ERROR' || /error|timeout|refused/.test(q)) && rows.some(l => l.lvl === 'ERROR')) O.gd.kibana = true;
    const now = Date.now(), bins = Array(24).fill(0), errb = Array(24).fill(0);
    O.logs.forEach(l => { const k = 23 - Math.floor((now - l.t) / 5000); if (k >= 0 && k < 24) { bins[k]++; if (l.lvl === 'ERROR') errb[k]++; } });
    const mx = Math.max(1, ...bins);
    let h = `<div class="oc-bar"><input type="search" id="ocQ" placeholder="поиск: timeout, orders, trace id…" value="${esc(O.q)}"><div class="seg">${['ALL', 'INFO', 'WARN', 'ERROR'].map(l => `<button type="button" data-oclvl="${l}" aria-selected="${O.lvl === l}">${l === 'ALL' ? 'все' : l}</button>`).join('')}</div><select id="ocSvc"><option value="">все сервисы</option>${svcs().map(n => `<option ${O.svc === lbl(n) ? 'selected' : ''}>${esc(lbl(n))}</option>`).join('')}</select></div>`;
    h += `<svg class="oc-hist" viewBox="0 0 480 60">${bins.map((b, i) => `<rect x="${i * 20}" y="${56 - b / mx * 50}" width="16" height="${b / mx * 50}" class="oc-hb"/><rect x="${i * 20}" y="${56 - errb[i] / mx * 50}" width="16" height="${errb[i] / mx * 50}" class="oc-hbe"/>`).join('')}<text class="oc-ax" x="0" y="59">−2 мин</text><text class="oc-ax" x="478" y="59" text-anchor="end">сейчас</text></svg>`;
    h += `<p class="oc-hint">Найдено ${rows.length} из ${O.logs.length} записей. Красное на гистограмме — ошибки. Нажми на trace_id — откроется трейс этого запроса${caps().traces ? '' : ' (если включены трейсы)'}.</p>`;
    h += `<table class="oc-logs"><thead><tr><th>время</th><th>сервис</th><th>уровень</th><th>сообщение</th><th>trace_id</th></tr></thead><tbody>${rows.slice(-40).reverse().map(l => `<tr class="${l.lvl.toLowerCase()}"><td>${clock(l.t)}</td><td>${esc(l.svc)}</td><td><b>${l.lvl}</b></td><td>${esc(l.msg)}</td><td><button type="button" class="linkish" data-octid="${l.tid}">${l.tid.slice(0, 8)}…</button></td></tr>`).join('')}</tbody></table>`;
    return h;
  }
  function prom() {
    if (!caps().metrics) return off('Метрики', 'Метрики (Prometheus + Grafana)');
    const nodes = svcs().filter(n => wired('metrics', n)).concat(canvas() ? [] : stores()), res = A().res || { nodes: {} };
    let h = `<h4 class="oc-h">Targets — кого Prometheus опрашивает каждые 15 с</h4><table class="oc-logs"><thead><tr><th>цель</th><th>состояние</th><th>последний опрос</th></tr></thead><tbody>`;
    nodes.forEach(n => { const c = (res.nodes[n.id] || {}).count || n.props.count || 1, d = down(n).d; for (let i = 0; i < Math.min(c, 4); i++) { const dead = i < d; h += `<tr class="${dead ? 'error' : ''}"><td>${esc(lbl(n))}-${i + 1}:9100/metrics</td><td><b>${dead ? 'DOWN' : 'UP'}</b></td><td>${dead ? 'context deadline exceeded' : (2 + i * 3) + ' с назад'}</td></tr>`; } if (c > 4) h += `<tr><td colspan="3">… ещё ${c - 4}</td></tr>`; });
    h += `</tbody></table><h4 class="oc-h">Запрос (PromQL)</h4><div class="seg">${[['rps', 'sum by (service) (rate(http_requests_total[1m]))'], ['err', 'rate(http_requests_total{code=~"5.."}[1m]) / rate(http_requests_total[1m])'], ['cpu', 'avg by (service) (rate(container_cpu_usage_seconds_total[1m]))']].map(([k]) => `<button type="button" data-ocprom="${k}" aria-selected="${O.prom === k}">${{ rps: 'запросы/с', err: 'доля ошибок', cpu: 'CPU' }[k]}</button>`).join('')}</div>`;
    const Q = { rps: 'sum by (service) (rate(http_requests_total[1m]))', err: 'sum by (service) (rate(http_requests_total{code=~"5.."}[1m])) / sum by (service) (rate(http_requests_total[1m]))', cpu: 'avg by (service) (rate(container_cpu_usage_seconds_total[1m]))' }[O.prom];
    h += `<pre class="oc-code">${esc(Q)}</pre><table class="oc-logs"><tbody>${svcs().map(n => { const p = (O.series[n.id] || []).slice(-1)[0]; return `<tr><td>{service="${esc(lbl(n))}"}</td><td><b>${p ? (O.prom === 'rps' ? num(p.rps) : pct(p[O.prom])) : '—'}</b></td></tr>`; }).join('')}</tbody></table>`;
    h += `<p class="oc-hint">Как проверить в жизни: страница Status → Targets в Prometheus (все цели UP?), запрос <code>up == 0</code>, и <code>curl сервис:порт/metrics</code> — сервис отдаёт счётчики.</p>`;
    return h;
  }
  function alertsView() {
    if (!caps().metrics) return off('Метрики', 'Метрики (Prometheus + Grafana)') + '<p class="oc-hint">Алерты считаются по метрикам: без Prometheus правилам не на чем срабатывать.</p>';
    const c = caps();
    let h = `<h4 class="oc-h">Правила${c.alerts ? '' : ' · Alertmanager выключен: правила считаются, но уведомлений не будет'}</h4><table class="oc-logs"><thead><tr><th>правило</th><th>условие</th><th>ждём</th><th>состояние</th></tr></thead><tbody>`;
    O.rules.forEach(x => { h += `<tr class="${x.st === 'firing' ? 'error' : x.st === 'pending' ? 'warn' : ''}"><td><b>${x.r.id}</b><br><small>${esc(x.r.text)}</small></td><td><code>${esc(x.r.expr)}</code></td><td>${x.r.for} с</td><td><b>${{ ok: 'норма', pending: 'ждём ' + Math.max(0, Math.ceil(x.r.for - (Date.now() - x.since) / 1000)) + ' с', firing: 'ГОРИТ' }[x.st]}</b>${x.who.length ? `<br><small>${esc(x.who.join(', '))}</small>` : ''}</td></tr>`; });
    h += `</tbody></table><h4 class="oc-h">Уведомления</h4><ul class="oc-notes">${O.notes.length ? O.notes.map(n => `<li class="${n.cls}"><b>${clock(n.t)}</b> ${esc(n.txt)}</li>`).join('') : '<li>Пока тихо. Уронить экземпляр — и через несколько секунд правило перейдёт «норма → ждём → горит».</li>'}</ul>`;
    h += `<p class="oc-hint">Почему «ждём»: правило с <code>for: 1m</code> не будит дежурного из-за секундного всплеска. Как проверить в жизни: <code>amtool alert add test</code> — тестовый алерт должен дойти до телефона дежурного.</p>`;
    return h;
  }
  function jaeger() {
    if (!caps().traces) return off('Трейсы', 'Трейсы (OpenTelemetry + Jaeger)');
    const list = O.traces.slice().reverse();
    const cur = O.trace ? O.traces.find(t => t.tid === O.trace) || list[0] : list.slice().sort((a, b) => b.tot - a.tot)[0];
    if (cur && O.trace) O.gd.trace = true;
    let h = `<div class="oc-split"><div><h4 class="oc-h">Последние трейсы</h4><ul class="oc-tlist">${list.slice(0, 14).map(t => `<li><button type="button" data-octid="${t.tid}" class="${cur && cur.tid === t.tid ? 'on' : ''} ${t.err ? 'err' : ''}"><b>${ms(t.tot)}</b> ${clock(t.t)} · ${t.spans.length} шагов${t.err ? ' · ошибка' : ''}</button></li>`).join('')}</ul></div><div>`;
    if (cur) {
      /* виноват тот, у кого больше всего собственного времени — без вложенных вызовов */
      const self = s => s.d - cur.spans.filter(c => c.depth === s.depth + 1 && c.t >= s.t && c.t < s.t + s.d).reduce((a, c) => a + c.d, 0);
      const long = cur.spans.filter(s => s.depth > 0).reduce((m, s) => self(s) > self(m) ? s : m, cur.spans[1] || cur.spans[0]);
      h += `<h4 class="oc-h">Трейс ${cur.tid.slice(0, 12)}… · ${ms(cur.tot)}</h4><div class="oc-wf">${cur.spans.map(s => `<div class="oc-span ${s === long ? 'long' : ''} ${s.err ? 'err' : ''}" style="--l:${(s.t / cur.tot * 100).toFixed(1)}%;--w:${Math.max(0.8, s.d / cur.tot * 100).toFixed(1)}%;--d:${s.depth}"><span class="oc-sn">${esc(s.svc)} · ${esc(s.op)}</span><i></i><b>${ms(s.d)}</b></div>`).join('')}</div>`;
      h += `<p class="oc-hint"><b>Больше всего времени тратит сам:</b> ${esc(long.svc)} — ${ms(Math.max(0, self(long)))} из ${ms(cur.tot)}${long.err ? ', и он не ответил' : ''}. Родительские полосы длинные, потому что включают вложенные вызовы — смотри на собственное время. Водопад читается сверху вниз: каждая полоса — шаг запроса, вложенные — вызовы внутри. Нажми trace_id в Kibana — откроется именно этот запрос.</p>`;
    } else h += '<p class="oc-hint">Трейсы появятся через пару секунд.</p>';
    return h + '</div></div>';
  }

  /* ---------- проверка «работает ли наблюдаемость» ---------- */
  function gameday() {
    const c = caps(), g = O.gd;
    const T = [
      ['grafana', 'Открой Grafana и найди самый загруженный сервис', c.metrics ? '' : 'включи «Метрики»'],
      ['chaos', 'Устрой сбой: «Уронить экземпляр» в шапке консоли', ''],
      ['alert', 'Дождись, пока алерт дойдёт до дежурного', !c.metrics ? 'включи «Метрики»' : !c.alerts ? 'включи «Алерты»' : ''],
      ['kibana', 'Найди в Kibana ошибки этого сбоя (фильтр ERROR)', c.logs ? '' : 'включи «Логи»'],
      ['trace', 'Открой трейс упавшего или медленного запроса', c.traces ? '' : 'включи «Трейсы»'],
      ['resolved', '«Поднять всё» — и убедись, что пришло RESOLVED', !c.alerts ? 'включи «Алерты»' : '']
    ];
    const done = T.filter(t => g[t[0]]).length;
    return `<h3 class="xr-h">Проверь, что наблюдаемость работает · ${done} из ${T.length}</h3><ul class="lab-tasks">${T.map(([k, t, need]) => `<li class="${g[k] ? 'ok' : ''}"><span class="st">${g[k] ? '✓' : '·'}</span><span>${esc(t)}${need && !g[k] ? ` <small class="oc-need">— сначала ${esc(need)}</small>` : ''}</span></li>`).join('')}</ul><p class="xr-note">Так это проверяют в жизни: game day — учебный сбой в рабочее время. Если алерт не пришёл или в логах не нашлось ошибки — наблюдаемость не работает, даже если всё «настроено».</p>`;
  }

  SD.ops = {
    tick, reset, gameday, gd: () => Object.assign({}, O.gd), caps,
    render(tab) { return { grafana, kibana, prom, alert: alertsView, jaeger }[tab](); },
    setQuery(q) { O.q = q; }, setLvl(l) { O.lvl = l; }, setSvc(s) { O.svc = s; }, setProm(k) { O.prom = k; }, openTrace(t) { O.trace = t; }
  };
})();
