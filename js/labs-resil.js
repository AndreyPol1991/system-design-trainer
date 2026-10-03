/* Лаборатория «Связь вживую»: каждый запрос к соседу — таймаут, повторы, предохранитель, fallback. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SCN = {
    ok: { name: 'Здоров', d: 120, fail: 0, note: 'отвечает за ~120 мс' },
    slow: { name: 'Тормозит', d: 2500, fail: 0, note: 'отвечает за 2,5 секунды' },
    flaky: { name: 'Сбоит', d: 120, fail: 0.5, note: 'половина ответов — ошибка 503' },
    down: { name: 'Лежит', d: 30, fail: 1, note: 'сразу отвечает ошибкой' },
    hang: { name: 'Завис', d: 1e9, fail: 0, note: 'принимает запрос и молчит' }
  };
  const NET = 140, CAP = 12, RATE = 3, WIN = 10, MINC = 5, COOL = 3000, X0 = 350, X1 = 650, YO = 118, YB = 162;

  SD.LABS.push({
    id: 'resil', title: 'Связь вживую', lede: 'Таймаут, повторы, предохранитель, fallback', dive: 'resilience',
    intro: 'Твой сервис зовёт соседа. Ломай соседа кнопками и смотри на каждый запрос: кто ждёт, кто повторяется, когда размыкается предохранитель и что получает пользователь. Настройки защиты — те же, что на стрелке площадки.',
    tasks: [
      { id: 'notimeout', text: 'Сосед завис, таймаута нет: посмотри, как забиваются потоки и падает уже твой сервис' },
      { id: 'timeout', text: 'Включи таймаут: зависший вызов обрывается, поток освобождается' },
      { id: 'storm', text: 'Повторы без паузы при сбоях: нагрузка на соседа вырастает почти вдвое' },
      { id: 'open', text: 'Предохранитель размыкается и отбивает запросы сразу, не трогая соседа' },
      { id: 'halfopen', text: 'Сосед ожил: пробный запрос замыкает предохранитель обратно' },
      { id: 'fallback', text: 'Fallback: пользователи получают упрощённый ответ вместо ошибки' }
    ],
    mount(body, api) {
      const ctx = SD.resilCtx || {}; SD.resilCtx = null;
      const A = SD.app && SD.app.A;
      const edge = ctx.edgeId && A ? A.graph.edges.find(e => e.id === ctx.edgeId) : null;
      const nm = id => { const n = A && A.graph.nodes.find(x => x.id === id); return n ? (n.label || SD.TYPES[n.type].name) : null; };
      const from = edge ? nm(edge.from) : 'Твой сервис', to = edge ? nm(edge.to) : 'Сосед (склад)';
      const P = Object.assign({ timeout: 0, retries: 0, backoff: 'none', cb: false, fallback: false }, edge ? Object.assign(SD.edgeDefaults(), edge.props) : {});
      const S = { t: 0, scn: 'ok', speed: 0.5, run: true, reqs: [], atts: [], waits: [], seq: 1, next: 0, cb: { st: 'closed', win: [], until: 0, probe: false }, ev: [], calls: [], log: [], fx: [], flash: {} };
      const setP = (k, v) => { P[k] = v; if (edge && SD.app.setEdgeProp) SD.app.setEdgeProp(edge.id, k, v); };

      body.innerHTML = `<div class="rs">
        <div class="rs-ctl"><div class="rs-grp"><b>Сосед</b><div class="seg" id="rsScn">${Object.entries(SCN).map(([k, s]) => `<button type="button" data-scn="${k}" aria-selected="${k === 'ok'}">${s.name}</button>`).join('')}</div></div>
          <div class="rs-grp"><b>Защита вызова${edge ? ` · стрелка «${esc(from)} → ${esc(to)}»` : ''}</b><div class="rs-set">
            <label>Таймаут <select data-rp="timeout">${SD.TIMEOUTS.map(([v, t]) => `<option value="${v}" ${P.timeout === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>Повторы <input type="range" min="0" max="5" value="${P.retries}" data-rp="retries"><output>${P.retries}</output></label>
            <label>Пауза <select data-rp="backoff"><option value="none" ${P.backoff === 'none' ? 'selected' : ''}>сразу</option><option value="exp" ${P.backoff === 'exp' ? 'selected' : ''}>экспоненциальная</option></select></label>
            <label class="rs-tg"><input type="checkbox" data-rp="cb" ${P.cb ? 'checked' : ''}> Circuit breaker</label>
            <label class="rs-tg"><input type="checkbox" data-rp="fallback" ${P.fallback ? 'checked' : ''}> Fallback</label></div></div>
          <div class="rs-grp"><b>Скорость</b><div class="seg" id="rsSpd">${[[0.25, '×¼'], [0.5, '×½'], [1, '×1']].map(([v, t]) => `<button type="button" data-spd="${v}" aria-selected="${v === 0.5}">${t}</button>`).join('')}<button type="button" data-rs="pause">Пауза</button></div></div></div>
        <svg class="rs-svg" viewBox="0 0 860 300" id="rsSvg"><g id="rsStatic"></g><g id="rsDyn"></g></svg>
        <div class="rs-bottom"><div class="rs-stats" id="rsStats"></div><div><div class="lab-card" id="rsNow"></div><ul class="lab-log" id="rsLog"></ul></div></div></div>`;
      const $ = id => body.querySelector('#' + id);

      /* ---------- модель ---------- */
      const busy = () => S.reqs.filter(r => !r.done).length;
      const logE = (txt, cls) => { S.log.unshift({ t: S.t, txt, cls }); S.log = S.log.slice(0, 8); };
      const flash = k => { S.flash[k] = performance.now(); };
      function cbTick(t) { if (P.cb && S.cb.st === 'open' && t >= S.cb.until) { S.cb.st = 'half'; S.cb.probe = false; logE('Предохранитель: пробный режим — пропускаю один запрос', 'warn'); } }
      function newReq(t) {
        if (busy() >= CAP) {
          S.ev.push({ t, k: 'reject', lat: 0 }); S.fx.push({ k: 'reject', born: performance.now() });
          logE('Новый запрос отклонён: все 12 потоков сервиса заняты ожиданием', 'bad');
          if (!P.timeout) api.done('notimeout');
          return;
        }
        const r = { id: S.seq++, t0: t, n: 0, done: false };
        S.reqs.push(r); S.ev.push({ t, k: 'arr' }); start(r, t);
      }
      function start(r, t) {
        r.n++; cbTick(t);
        const a = { r, ts: t, n: r.n };
        if (P.cb && (S.cb.st === 'open' || (S.cb.st === 'half' && S.cb.probe))) {
          a.k = 'cb'; a.te = t + 2; S.fx.push({ k: 'bounce', born: performance.now() }); flash('cb');
        } else {
          if (P.cb && S.cb.st === 'half') { S.cb.probe = true; a.probe = true; }
          const sc = SCN[S.scn];
          a.D = sc.d >= 1e9 ? 1e9 : sc.d * (0.8 + Math.random() * 0.4);
          const fail = Math.random() < sc.fail, tot = 2 * NET + a.D;
          if (P.timeout > 0 && tot > P.timeout) { a.k = 'timeout'; a.te = t + P.timeout; }
          else { a.k = fail ? 'error' : 'ok'; a.te = t + Math.min(tot, 30000); if (a.D >= 1e9) a.k = 'timeout'; }
          S.calls.push({ t });
        }
        S.atts.push(a);
      }
      function cbRecord(ok, t, a) {
        if (!P.cb) return;
        if (S.cb.st === 'half' && a.probe) {
          S.cb.probe = false;
          if (ok) { S.cb.st = 'closed'; S.cb.win = []; logE('Пробный запрос успешен — предохранитель замкнулся', 'ok'); api.done('halfopen'); flash('cb'); }
          else { S.cb.st = 'open'; S.cb.until = t + COOL; logE('Пробный запрос упал — снова разомкнут на 3 с', 'bad'); flash('cb'); }
          return;
        }
        if (S.cb.st !== 'closed') return;
        S.cb.win.push(ok); if (S.cb.win.length > WIN) S.cb.win.shift();
        const f = S.cb.win.filter(x => !x).length;
        if (S.cb.win.length >= MINC && f / S.cb.win.length >= 0.5) { const tot = S.cb.win.length; S.cb.st = 'open'; S.cb.until = t + COOL; S.cb.win = []; logE(`Упало ${f} из ${tot} последних вызовов — предохранитель РАЗОМКНУТ на 3 с`, 'bad'); api.done('open'); flash('cb'); }
      }
      function finish(r, k, t) {
        r.done = true; r.k = k;
        S.ev.push({ t, k, lat: t - r.t0 }); S.fx.push({ k, born: performance.now() });
        if (k === 'fallback') { flash('fb'); if (S.ev.filter(e => e.k === 'fallback' && e.t > S.t - 10000).length >= 5) api.done('fallback'); }
      }
      function resolve(a) {
        const r = a.r;
        if (a.k !== 'cb') cbRecord(a.k === 'ok', a.te, a);
        if (a.k === 'timeout' && P.timeout > 0) { flash('to'); api.done('timeout'); logE(`Запрос ${r.id}: ждал ${P.timeout >= 1000 ? P.timeout / 1000 + ' с' : P.timeout + ' мс'} — таймаут, поток свободен`, 'warn'); }
        if (a.k === 'ok') { finish(r, 'ok', a.te); return; }
        if (a.k === 'error') logE(`Запрос ${r.id}: сосед ответил ошибкой 503`, 'bad');
        if (a.k === 'timeout' && !P.timeout) logE(`Запрос ${r.id}: висел 30 с, пока не оборвалось соединение`, 'bad');
        if (a.k === 'cb' && r.n === 1) logE(`Запрос ${r.id}: отбит предохранителем за 1 мс — сосед не тронут`, 'warn');
        if (a.k !== 'cb' && r.n <= P.retries) {
          const delay = P.backoff === 'exp' ? 100 * Math.pow(2, r.n - 1) * (0.75 + Math.random() * 0.5) : 10;
          S.waits.push({ r, at: a.te + delay, from: a.te }); flash('rt');
          logE(`Запрос ${r.id}: повтор №${r.n} ${P.backoff === 'exp' ? 'через ' + Math.round(delay) + ' мс' : 'сразу'}`, '');
          return;
        }
        finish(r, P.fallback ? 'fallback' : a.k === 'cb' ? 'cb' : a.k, a.te);
        if (P.fallback) logE(`Запрос ${r.id}: fallback — пользователь получил упрощённый ответ`, 'ok');
      }
      function step(dt) {
        const end = S.t + dt;
        while (true) {
          const nextAtt = S.atts.reduce((m, a) => a.te < m ? a.te : m, Infinity);
          const nextW = S.waits.reduce((m, w) => w.at < m ? w.at : m, Infinity);
          const tn = Math.min(nextAtt, nextW, S.next);
          if (tn > end) break;
          S.t = tn;
          if (tn === S.next) { newReq(tn); S.next = tn + 1000 / RATE * (0.6 + Math.random() * 0.8); continue; }
          if (tn === nextW) { const w = S.waits.find(x => x.at === tn); S.waits.splice(S.waits.indexOf(w), 1); start(w.r, tn); continue; }
          const a = S.atts.find(x => x.te === tn); S.atts.splice(S.atts.indexOf(a), 1); resolve(a);
        }
        S.t = end; cbTick(S.t);
        const cut = S.t - 10000;
        S.ev = S.ev.filter(e => e.t > cut); S.calls = S.calls.filter(c => c.t > cut); S.reqs = S.reqs.filter(r => !r.done || r.t0 > cut);
        const arr5 = S.ev.filter(e => e.k === 'arr' && e.t > S.t - 5000).length, calls5 = S.calls.filter(c => c.t > S.t - 5000).length;
        if (arr5 >= 8 && calls5 / arr5 >= 1.8 && P.retries >= 2 && P.backoff === 'none') api.done('storm');
      }

      /* ---------- отрисовка ---------- */
      function drawStatic() {
        const busyN = busy();
        let s = `<rect class="rs-box" x="20" y="105" width="96" height="70" rx="10"/><text class="rs-t" x="68" y="136" text-anchor="middle">Пользователи</text><text class="rs-s" x="68" y="152" text-anchor="middle">${RATE} запроса/с</text>`;
        s += `<rect class="rs-box ${busyN >= CAP ? 'full' : ''}" x="150" y="60" width="200" height="170" rx="12"/><text class="rs-t" x="164" y="84">${esc(from.slice(0, 24))}</text><text class="rs-s" x="164" y="100">потоки: ${busyN} из ${CAP} заняты</text>`;
        for (let i = 0; i < CAP; i++) s += `<rect class="rs-th ${i < busyN ? (busyN >= CAP ? 'full' : 'on') : ''}" x="${164 + (i % 6) * 29}" y="${112 + Math.floor(i / 6) * 22}" width="24" height="16" rx="3"/>`;
        const sc = SCN[S.scn];
        s += `<rect class="rs-box nb ${S.scn}" x="${X1}" y="60" width="190" height="170" rx="12"/><text class="rs-t" x="${X1 + 14}" y="84">${esc(to.slice(0, 22))}</text><text class="rs-s" x="${X1 + 14}" y="100">${sc.name}: ${sc.note}</text>`;
        const c1 = S.calls.filter(c => c.t > S.t - 1000).length;
        s += `<text class="rs-s" x="${X1 + 14}" y="214">нагрузка: ${c1} вызов${c1 === 1 ? '' : c1 < 5 && c1 ? 'а' : 'ов'}/с</text>`;
        s += `<line class="rs-wire" x1="${X0}" y1="${YO}" x2="${X1}" y2="${YO}"/><line class="rs-wire back" x1="${X1}" y1="${YB}" x2="${X0}" y2="${YB}"/>`;
        s += `<text class="rs-s" x="${X0 + 12}" y="${YO - 10}">запрос →</text><text class="rs-s" x="${(X0 + X1) / 2}" y="${YB + 18}" text-anchor="middle">← ответ</text>`;
        const act = k => performance.now() - (S.flash[k] || 0) < 450 ? ' act' : '';
        s += `<g class="rs-badge ${P.timeout ? 'on' : 'off'}${act('to')}" transform="translate(${X0 + 14},${YO - 44})"><rect width="96" height="22" rx="11"/><text x="48" y="15" text-anchor="middle">⏱ ${P.timeout ? (P.timeout >= 1000 ? P.timeout / 1000 + ' с' : P.timeout + ' мс') : 'без таймаута'}</text></g>`;
        s += `<g class="rs-badge ${P.retries ? 'on' : 'off'}${act('rt')}" transform="translate(${X0 + 14},${YB + 26})"><rect width="118" height="22" rx="11"/><text x="59" y="15" text-anchor="middle">↻ ${P.retries ? P.retries + (P.backoff === 'exp' ? ' · с паузой' : ' · сразу') : 'без повторов'}</text></g>`;
        const st = P.cb ? S.cb.st : 'none', bx = 505, rot = st === 'open' ? -35 : st === 'half' ? -15 : 0;
        s += `<g class="rs-cb ${st}${act('cb')}"><circle cx="${bx - 18}" cy="${YO}" r="4"/><circle cx="${bx + 18}" cy="${YO}" r="4"/><line x1="${bx - 18}" y1="${YO}" x2="${bx + 18}" y2="${YO}" transform="rotate(${rot} ${bx - 18} ${YO})"/>`;
        s += `<text x="${bx}" y="${YO + 26}" text-anchor="middle">${!P.cb ? 'предохранителя нет' : st === 'open' ? 'РАЗОМКНУТ · ' + Math.max(0, Math.ceil((S.cb.until - S.t) / 1000)) + ' с' : st === 'half' ? 'пробный запрос' : 'замкнут'}</text></g>`;
        s += `<g class="rs-badge ${P.fallback ? 'on' : 'off'}${act('fb')}" transform="translate(150,240)"><rect width="200" height="22" rx="11"/><text x="100" y="15" text-anchor="middle">⤺ ${P.fallback ? 'fallback: упрощённый ответ' : 'без fallback — ошибка'}</text></g>`;
        $('rsStatic').innerHTML = s;
      }
      function drawDyn() {
        let s = '';
        S.atts.forEach(a => {
          if (a.k === 'cb') return;
          const t = S.t - a.ts, D = a.D, tEnd = a.te - a.ts;
          let x, y, cls = 'go';
          if (t < NET) { x = X0 + (X1 - X0) * (t / NET); y = YO; }
          else if (t < NET + D && t < tEnd) {
            x = X1 - 8; y = (YO + YB) / 2; cls = 'wait';
            const lim = P.timeout || 0;
            if (lim) { const f = Math.min(1, t / lim), r = 13, ang = f * 2 * Math.PI; s += `<path class="rs-clock" d="M${x},${y - r} A${r},${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x + r * Math.sin(ang)},${y - r * Math.cos(ang)}"/>`; }
          } else { const tb = t - NET - D; x = X1 - (X1 - X0) * Math.min(1, tb / NET); y = YB; cls = a.k === 'ok' ? 'ok' : 'err'; }
          s += `<circle class="rs-dot ${cls}${a.n > 1 ? ' retry' : ''}" cx="${x.toFixed(1)}" cy="${y}" r="6"/>`;
          if (a.n > 1) s += `<text class="rs-n" x="${x.toFixed(1)}" y="${y - 10}" text-anchor="middle">↻${a.n - 1}</text>`;
        });
        S.waits.forEach((w, i) => { const f = Math.min(1, (S.t - w.from) / Math.max(1, w.at - w.from)); s += `<circle class="rs-dot wait2" cx="${X0 + 10 + (i % 4) * 14}" cy="${YO + 22}" r="5"/><circle class="rs-ring" cx="${X0 + 10 + (i % 4) * 14}" cy="${YO + 22}" r="8" style="stroke-dasharray:${(f * 50).toFixed(1)} 60"/>`; });
        const now = performance.now();
        S.fx = S.fx.filter(f => now - f.born < 600);
        S.fx.forEach(f => {
          const p = (now - f.born) / 600;
          if (f.k === 'bounce') { const x = p < 0.5 ? X0 + (505 - 20 - X0) * (p * 2) : 505 - 20 - (505 - 20 - X0) * ((p - 0.5) * 2); s += `<circle class="rs-dot cbx" cx="${x.toFixed(1)}" cy="${YO}" r="6"/>`; return; }
          const x = 150 - (150 - 116) * p - 20 * p, lbl = { ok: '✓', fallback: 'упр.', error: '×', timeout: '×', cb: '×', reject: '×' }[f.k] || '';
          s += `<g class="rs-out ${f.k}" style="opacity:${(1 - p).toFixed(2)}"><circle cx="${x.toFixed(1)}" cy="200" r="9"/><text x="${x.toFixed(1)}" y="204" text-anchor="middle">${lbl}</text></g>`;
        });
        $('rsDyn').innerHTML = s;
      }
      function drawStats() {
        const ev = S.ev, fin = ev.filter(e => e.k !== 'arr'), n = fin.length || 1;
        const cnt = k => fin.filter(e => (Array.isArray(k) ? k.includes(e.k) : e.k === k)).length;
        const ok = cnt('ok'), fb = cnt('fallback'), bad = cnt(['error', 'timeout', 'cb', 'reject']);
        const lat = fin.filter(e => e.k !== 'reject'), avg = lat.length ? lat.reduce((s, e) => s + e.lat, 0) / lat.length : 0;
        const arr = ev.filter(e => e.k === 'arr').length, calls = S.calls.length, amp = arr ? calls / arr : 0;
        $('rsStats').innerHTML = `<div><small>Обычный ответ</small><b class="ok">${Math.round(ok / n * 100)} %</b><span>за последние 10 с</span></div>
          <div><small>Упрощённо</small><b class="${fb ? 'warn' : ''}">${Math.round(fb / n * 100)} %</b><span>fallback</span></div>
          <div><small>Ошибки</small><b class="${bad ? 'bad' : ''}">${Math.round(bad / n * 100)} %</b><span>таймауты, 503, отказы</span></div>
          <div><small>Среднее ожидание</small><b>${SD.fmt.ms(avg)}</b><span>с повторами</span></div>
          <div><small>Нагрузка на соседа</small><b class="${amp > 1.5 ? 'bad' : ''}">×${amp.toFixed(2).replace('.', ',')}</b><span>вызовов на запрос</span></div>`;
        let now = '';
        const sc = S.scn;
        if (busy() >= CAP) now = '<b>Потоки кончились.</b> Каждый запрос висит в ожидании соседа и держит поток. Новые запросы некому принять — упал уже твой сервис. Это каскадный отказ.';
        else if ((sc === 'hang' || sc === 'slow') && !P.timeout) now = '<b>Таймаута нет.</b> Запросы ждут соседа, сколько бы он ни молчал, и занимают потоки сервиса. Смотри на квадратики потоков слева.';
        else if (P.cb && S.cb.st === 'open') now = '<b>Предохранитель разомкнут.</b> Запросы отбиваются сразу, сосед отдыхает и может подняться. Через 3 с пройдёт один пробный запрос.';
        else if (P.cb && S.cb.st === 'half') now = '<b>Пробный режим.</b> Один запрос проверяет, жив ли сосед. Успех — замыкаемся, ошибка — снова ждём.';
        else if ((sc === 'flaky' || sc === 'down') && P.retries && P.backoff === 'none') now = '<b>Повторы без паузы.</b> Каждый сбой сразу отправляет ещё вызов — больной сосед получает больше нагрузки, чем от пользователей. Это шторм повторов.';
        else if (sc === 'flaky' && P.retries) now = '<b>Повторы спасают от случайных сбоев.</b> Ошибка 503 в половине случаев — второй-третий вызов обычно проходит.';
        else if (sc === 'down' && !P.cb) now = '<b>Сосед лежит, а мы продолжаем звонить.</b> Включи предохранитель: после нескольких ошибок он перестанет тревожить соседа.';
        else if (sc === 'ok') now = '<b>Всё спокойно.</b> Запрос уходит к соседу, ответ возвращается зелёной точкой. Сломай соседа кнопкой выше.';
        else now = 'Посмотри на точки: синие идут к соседу, зелёные возвращаются с ответом, красные — ошибки.';
        if (P.fallback && (sc === 'down' || sc === 'flaky' || sc === 'hang')) now += ' Fallback превращает ошибки в упрощённые ответы: страница открывается без этого блока.';
        $('rsNow').innerHTML = now;
        $('rsLog').innerHTML = S.log.map(l => `<li class="${l.cls}">${(l.t / 1000).toFixed(1).replace('.', ',')} с · ${esc(l.txt)}</li>`).join('');
      }

      let raf = 0, last = performance.now(), statT = 0;
      const loop = now => {
        const dtr = Math.min(100, now - last); last = now;
        if (S.run) step(dtr * S.speed);
        drawStatic(); drawDyn();
        if (now - statT > 300) { drawStats(); statT = now; }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      body.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.scn) { S.scn = b.dataset.scn; body.querySelectorAll('[data-scn]').forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false')); logE(`Сосед: ${SCN[S.scn].name.toLowerCase()} — ${SCN[S.scn].note}`, ''); }
        if (b.dataset.spd) { S.speed = +b.dataset.spd; body.querySelectorAll('[data-spd]').forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false')); }
        if (b.dataset.rs === 'pause') { S.run = !S.run; b.textContent = S.run ? 'Пауза' : 'Пуск'; last = performance.now(); }
      });
      body.addEventListener('change', e => {
        const t = e.target, k = t.dataset.rp; if (!k) return;
        const v = t.type === 'checkbox' ? t.checked : k === 'timeout' || k === 'retries' ? +t.value : t.value;
        setP(k, v);
        if (k === 'cb' && !v) { S.cb = { st: 'closed', win: [], until: 0, probe: false }; }
        logE(`Настройка: ${{ timeout: 'таймаут', retries: 'повторы', backoff: 'пауза между повторами', cb: 'circuit breaker', fallback: 'fallback' }[k]} → ${t.type === 'checkbox' ? (v ? 'включено' : 'выключено') : t.options ? t.options[t.selectedIndex].text : v}`, '');
      });
      body.addEventListener('input', e => { const t = e.target; if (t.dataset.rp === 'retries') { const o = t.parentElement.querySelector('output'); if (o) o.textContent = t.value; } });
      return () => cancelAnimationFrame(raf);
    }
  });
})();
