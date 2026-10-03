/* «Балансировщик изнутри»: каждый клиент своего цвета, видно, к какому экземпляру уходит его запрос и почему. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const T = 350, K = 40, SLOTS = 3, MAXI = 6, HC = 1000;
  const CL = [['Аня', '--k-read', 'Ани'], ['Боря', '--k-write', 'Бори'], ['Вика', '--k-job', 'Вики'], ['Гоша', '--k-events', 'Гоши'], ['Даша', '--k-search', 'Даши'], ['Егор', '--k-geo', 'Егора']];
  const ALGO = {
    rr: ['Round robin', 'по кругу: 1 → 2 → 3 → 1…'], wrr: ['Weighted round robin', 'по кругу, но мощным — чаще'], lc: ['Least connections', 'туда, где меньше открытых запросов'],
    lrt: ['Least response time', 'кто быстрее отвечает и меньше занят'], p2c: ['Power of two choices', 'два случайных — берём менее занятого'], hash: ['Consistent hash', 'клиент всегда к «своему» серверу'], random: ['Random', 'наугад']
  };
  const SMART = ['lc', 'lrt', 'p2c'];
  const SHORT = { rr: 'RR', wrr: 'WRR', lc: 'LC', lrt: 'LRT', p2c: 'P2C', hash: 'Hash', random: 'Random' };
  const hsh = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const fleet = n => n && (SD.TYPES[n.type].props || []).some(p => p.key === 'count') && n.type !== 'sql' && n.type !== 'nosql' && n.type !== 'cache' && n.type !== 'queue';
  const ms = v => SD.fmt.ms(v / K);
  const wrap = (s, n) => { const out = []; let cur = ''; String(s).split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > n) { out.push(cur.trim()); cur = w; } else cur += ' ' + w; }); if (cur.trim()) out.push(cur.trim()); return out; };

  const LB_PARTS = {
    algo: { name: 'Алгоритм выбора', an: 'Администратор у входа в банк: на каждого посетителя решает, к какому окошку отправить. Правило может быть простым («по очереди») или умным («где короче очередь»).', pl: 'На каждый запрос балансировщик выбирает один экземпляр. Алгоритм — правило выбора. Пока запросы и серверы одинаковые, разницы почти нет; она видна, когда запросы разной тяжести или серверы разной силы.',
      how: ['<b>Round robin</b>: по кругу 1, 2, 3, 1… Не смотрит, кто занят.', '<b>Weighted round robin</b>: по кругу, но мощным серверам чаще — по заранее заданным весам.', '<b>Least connections</b>: считает открытые запросы у каждого и шлёт туда, где их меньше.', '<b>Least response time</b>: учитывает и время ответа, и открытые запросы — обходит тормозящих.', '<b>Power of two choices</b>: берёт два случайных и выбирает менее занятого — почти так же хорошо, но без опроса всех.', '<b>Consistent hash</b>: по ключу клиента всегда один и тот же сервер; при добавлении сервера переезжает мало клиентов.', '<b>Random</b>: наугад — в среднем ровно, но бывают перекосы.'],
      watch: 'Блок посередине балансировщика: стрелка, полоски, кубики или кольцо — и рамка «почему туда» под ними для каждого запроса.', knobs: ['algo', 'sticky'], real: 'Nginx: round-robin по умолчанию, least_conn, ip_hash, hash; HAProxy: roundrobin, leastconn, source; Envoy: LEAST_REQUEST — это power of two choices; AWS ALB: round robin или least outstanding requests.' },
    health: { name: 'Health checks', an: 'Администратор раз в минуту заглядывает в каждое окошко: «работаете?». Не ответили дважды — табличка «закрыто», посетителей туда не шлют.', pl: 'Балансировщик сам регулярно опрашивает каждый экземпляр. Кто не отвечает — исключается из раздачи, ожил — возвращается.',
      how: ['Каждые N секунд балансировщик отправляет запрос на /health каждому экземпляру.', 'Ответ 200 — экземпляр жив. Нет ответа или ошибка — счётчик неудач +1.', 'Неудач подряд больше порога (обычно 2–3) — экземпляр исключают.', 'Пока порог не набран, часть запросов успевает уйти в мёртвый экземпляр.', 'Исключённый продолжают проверять: несколько успехов подряд — возвращают в раздачу.'],
      watch: 'Строка внизу балансировщика: «✓ жив», «? молчит», «✗ исключён». Зелёные точки по проводам — сами проверки. Ситуация «Сервер упал».', knobs: ['health'], real: 'Типично: интервал 5–10 с, 2–3 неудачи до исключения, 2 успеха до возврата. В Kubernetes это readinessProbe. /health должен проверять и зависимости, но не тяжело.' },
    clients: { name: 'Клиенты и сессии', an: 'Постоянный клиент любит своего менеджера: тот помнит его историю. Отправишь к другому — придётся всё рассказывать заново.', pl: 'Если сервис хранит что-то о пользователе в памяти экземпляра (сессию, корзину), запрос к другому экземпляру этого не найдёт. Тогда нужно, чтобы клиент всегда попадал к «своему».',
      how: ['Каждый клиент на картинке — свой цвет, так видно, куда уходят его запросы.', 'Sticky sessions: балансировщик ставит cookie «сервер №2» и дальше шлёт клиента туда.', 'Consistent hash: сервер выбирается по ключу клиента — тот же результат без cookie.', 'Минус «прилипания»: нагрузка распределяется неровно, а падение экземпляра всё равно теряет его сессии.', 'Лучше вообще не хранить сессию в памяти сервиса: Redis или JWT — и подойдёт любой алгоритм.'],
      watch: 'Слева под именами — «сессия: №…» или «cookie: №…». В ситуации «Сессия в памяти» красные «вход заново», если клиент попал к чужому экземпляру.', knobs: ['sticky', 'algo'], real: 'HAProxy: cookie SERVERID insert; AWS ALB: stickiness cookie AWSALB; Nginx: ip_hash или sticky. 12-factor: «процессы без состояния» — сессии в Redis.' },
    inst: { name: 'Экземпляры и их слоты', an: 'Окошки в банке: в каждом одновременно обслуживают не больше трёх посетителей, остальные ждут перед ним.', pl: 'Каждый экземпляр сервиса одновременно обрабатывает ограниченное число запросов. Лишние стоят в очереди перед ним — и именно эти очереди алгоритм должен не допускать.',
      how: ['Запрос приходит к экземпляру и занимает свободный слот (квадрат).', 'Тяжёлый запрос (большая точка) держит слот дольше.', 'Слоты заняты — запрос ждёт в очереди слева от экземпляра.', 'Справа: сколько у экземпляра открытых запросов, какая доля всех досталась ему и как быстро он отвечает.', 'Нажми на экземпляр — провалишься внутрь самого сервиса.'],
      watch: 'Прямоугольники справа: квадраты-слоты с точками цветов клиентов, очередь слева от прямоугольника, цифры «откр.» и «% запросов».', knobs: [], real: 'Перекос в «доле запросов» и очереди перед одним экземпляром — первый признак, что алгоритм не подходит под вашу нагрузку.' },
    mode: { name: 'L4 и L7', an: 'L4 — почтальон, который видит только адрес на конверте. L7 — секретарь, который открывает письмо и читает, о чём оно.', pl: 'L4-балансировщик раздаёт TCP-соединения и не знает, что внутри. L7 читает HTTP: адрес страницы, заголовки, cookie — и может принимать решения по ним.',
      how: ['L4: смотрит только IP и порт, пересылает байты — очень быстро и дёшево.', 'L4 не может развести /orders и /catalog по разным сервисам и не повторит неудачный HTTP-запрос.', 'L7: завершает TLS, читает HTTP-запрос, может выбрать сервис по пути и экземпляр по cookie.', 'L7 умеет повторы, таймауты, переписывание заголовков — но тратит чуть больше времени и CPU.'],
      watch: 'Подпись под названием балансировщика. Если за ним несколько сервисов, L7 сначала выбирает сервис по пути запроса.', knobs: ['mode'], real: 'AWS NLB — L4, AWS ALB — L7; Nginx stream (L4) и http (L7); HAProxy mode tcp / mode http. L4 добавляет ≈ 0,1–0,3 мс, L7 — около 1 мс.' }
  };

  SD.XRAY.lb = {
    cta: 'Каждый клиент своего цвета: видно, к какому экземпляру уходит запрос, почему туда и где копится очередь',
    dive: 'lb',
    simple: () => ({ an: 'Администратор в банке у входа: смотрит на окошки и решает, к какому отправить следующего посетителя. Правила бывают разные: по очереди, туда, где короче очередь, или «вы всегда к своему менеджеру».', pl: 'Балансировщик принимает все запросы на один адрес и раздаёт их экземплярам сервиса. Алгоритм — это правило выбора экземпляра.' }),
    props: ['algo', 'health', 'sticky', 'mode'],
    parts: LB_PARTS,
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Одинаковые запросы, нагрузка как на площадке.' },
      { id: 'mixed', name: 'Тяжёлые и лёгкие', note: 'Каждый седьмой запрос — тяжёлый отчёт, он в 8 раз дольше.' },
      { id: 'weak', name: 'Один сервер слабее', note: 'Экземпляр №1 вдвое слабее остальных (старая машина).' },
      { id: 'slow', name: 'Сервер тормозит', note: 'Экземпляр №2 внезапно стал отвечать в 5 раз медленнее (сборка мусора, шумный сосед).' },
      { id: 'session', name: 'Сессия в памяти', note: 'Сервис хранит вход пользователя в памяти экземпляра. Попал на другой — вход заново.' },
      { id: 'down', name: 'Сервер упал', note: 'Последний экземпляр перестал отвечать.' }
    ],
    tries: [
      { id: 'rrq', text: '«Тяжёлые и лёгкие» + Round robin: дождись, когда у одного экземпляра очередь станет 3 и больше' },
      { id: 'lcq', text: 'Там же переключи на Least connections или P2C: очередь рассасывается, p95 падает' },
      { id: 'wrr', text: '«Один сервер слабее» + Weighted round robin: слабому достаётся вдвое меньше' },
      { id: 'ewma', text: '«Сервер тормозит» + Least response time: балансировщик сам обходит тормозящий' },
      { id: 'sess', text: '«Сессия в памяти»: добейся 15 запросов подряд без повторного входа (hash или sticky)' },
      { id: 'health', text: '«Сервер упал»: посмотри, как health checks исключают мёртвый экземпляр' },
      { id: 'algoPart', text: 'Нажми на блок решения в балансировщике и прочитай, чем отличаются алгоритмы' }
    ],
    legend: [['read', 'Клиент: у каждого свой цвет — так видно, куда попадают его запросы'], ['ring', 'Большая точка — тяжёлый запрос (отчёт)'], ['sq warn', 'Слот экземпляра: одновременно обрабатывает 3 запроса'], ['ok', 'Ответ возвращается клиенту'], ['bad', 'Ошибка: запрос ушёл на мёртвый экземпляр']],
    live: (n, r, all) => {
      const kids = SD.app.A.graph.edges.filter(e => e.from === n.id).map(e => SD.app.A.graph.nodes.find(x => x.id === e.to)).filter(fleet);
      const ut = kids.length ? Math.max(...kids.map(k => ((all && all.nodes[k.id]) || {}).util || 0)) : 0;
      const cnt = kids.reduce((s, k) => s + ((((all && all.nodes[k.id]) || {}).count) || k.props.count || 1), 0);
      return [['Поток', SD.fmt.num(r.rps || 0) + '/с', ''], ['За ним экземпляров', String(cnt), ''], ['Загрузка за ним', Math.round(Math.min(ut, 9) * 100) + ' %', ut > 1 ? 'bad' : ut > 0.75 ? 'warn' : 'ok']];
    },
    mount(ctx) {
      const esc = ctx.esc;
      const S = { t: 0, reqs: [], insts: [], seq: 1, next: 0, last: null, rr: 0, hist: [], sess: {}, cookie: {}, hcT: 0, pops: [], streak: 0, peakQ: 0, mem: {}, flash: 0, scn: 'norm', u: 0.6, L: 700, lam: 6, real: 1, svcs: [], note: '' };
      const P = () => ctx.node.props;

      /* ---------- кого раздаём: экземпляры сервисов за балансировщиком ---------- */
      function build() {
        const outs = ctx.outs().filter(x => fleet(x.n));
        const tot = outs.reduce((s, x) => s + (x.er.flow || 0), 0) || 1;
        S.svcs = outs.map(x => ({ id: x.n.id, name: ctx.nm(x.n.id), share: (x.er.flow || 0) / tot || 1 / outs.length, count: Math.max(1, Math.min(x.r.used || x.r.count || x.n.props.count || 1, x.r.alive || 99)), util: x.r.util || 0 }));
        S.real = S.svcs.reduce((s, v) => s + v.count, 0);
        let left = MAXI;
        S.svcs.forEach((v, i) => { v.show = Math.max(1, Math.min(v.count < 2 && S.svcs.length === 1 ? 3 : v.count, i === S.svcs.length - 1 ? left : Math.max(1, Math.round(MAXI * v.share)))); left -= v.show; });
        const old = S.insts;
        S.insts = [];
        S.svcs.forEach(v => { for (let i = 0; i < Math.max(1, v.show); i++) { const o = old.find(x => x.svc === v.id && x.k === i); S.insts.push(o || { svc: v.id, k: i, act: [], q: [], open: 0, ewma: 0, slow: 1, power: 1, dead: false, down: false, fails: 0, sent: 0, cw: 0 }); } });
        S.insts.forEach((it, i) => { it.i = i; });
        const ut = S.svcs.length ? S.svcs.reduce((s, v) => s + v.util * v.share, 0) : 0.5;
        S.uSim = ut;
        applyScn();
      }
      function applyScn() {
        const sc = S.scn, N = S.insts.length;
        S.insts.forEach(it => { it.slow = 1; it.power = 1; it.dead = false; });
        if (sc === 'weak') { S.insts[0].slow = 2; S.insts[0].power = 0.5; }
        if (sc === 'slow' && N > 1) S.insts[1].slow = 5;
        if (sc === 'down' && N > 1) S.insts[N - 1].dead = true;
        S.u = sc === 'norm' ? Math.max(0.25, Math.min(1.05, S.uSim || 0.5)) : Math.max(0.72, Math.min(0.9, S.uSim || 0.8));
        const mix = sc === 'mixed' ? 1 + (1 / 7) * 7 : 1;
        const cap = S.insts.filter(it => !it.dead).reduce((s, it) => s + SLOTS / it.slow, 0);
        S.lam = Math.min(9, S.u * cap / (0.7 * mix));
        S.L = S.u * cap / (S.lam * mix) * 1000;
        S.insts.forEach(it => { if (!it.ewma) it.ewma = S.L; });
      }
      const pickSvc = () => { if (S.svcs.length < 2) return S.svcs[0] ? S.svcs[0].id : null; let r = Math.random(), acc = 0; for (const v of S.svcs) { acc += v.share; if (r <= acc) return v.id; } return S.svcs[S.svcs.length - 1].id; };

      /* ---------- решение балансировщика ---------- */
      function choose(req) {
        const svc = pickSvc(), all = S.insts.filter(it => it.svc === svc);
        const cands = P().health ? all.filter(it => !it.down) : all;
        const d = { req, svc, algo: P().algo, cands: cands.map(c => c.i), why: '', pick: null, extra: null };
        if (!cands.length) { d.why = 'живых экземпляров нет — ответить некому'; return d; }
        const c = req.c, name = CL[c][0];
        if (P().sticky && P().algo !== 'hash' && S.cookie[c] != null && cands.some(x => x.i === S.cookie[c])) { d.pick = S.insts[S.cookie[c]]; d.why = `у ${CL[c][2]} cookie «сервер №${d.pick.i + 1}» — sticky: туда же`; d.sticky = true; return d; }
        const a = P().algo, rnd = () => cands[Math.floor(Math.random() * cands.length)];
        if (a === 'rr') { d.pick = cands[S.rr % cands.length]; S.rr++; d.why = `следующий по кругу: №${d.pick.i + 1}`; }
        else if (a === 'wrr') {
          const tot = cands.reduce((s, it) => s + wOf(it), 0);
          cands.forEach(it => { it.cw += wOf(it); });
          d.pick = cands.reduce((m, it) => it.cw > m.cw ? it : m, cands[0]);
          d.extra = cands.map(it => [it.i, it.cw]);
          d.pick.cw -= tot;
          d.why = `у №${d.pick.i + 1} самый большой счётчик веса (вес ${wOf(d.pick)})`;
        } else if (a === 'lc') {
          d.extra = cands.map(it => [it.i, it.open]);
          const mn = Math.min(...cands.map(it => it.open)), best = cands.filter(it => it.open === mn);
          d.pick = best[S.rr++ % best.length];
          d.why = `у №${d.pick.i + 1} меньше всех открытых запросов (${mn})`;
        } else if (a === 'lrt') {
          const sc = it => it.ewma * (it.open + 1);
          d.extra = cands.map(it => [it.i, sc(it), it.ewma, it.open]);
          d.pick = cands.reduce((m, it) => sc(it) < sc(m) ? it : m, cands[0]);
          d.why = `№${d.pick.i + 1}: среднее время ${ms(d.pick.ewma)} × (открытых ${d.pick.open} + 1) — меньше всех`;
        } else if (a === 'p2c') {
          const x = rnd(); let y = rnd(), g = 0; while (y === x && cands.length > 1 && g++ < 9) y = rnd();
          d.pick = x.open <= y.open ? x : y; d.extra = [x.i, y.i, x.open, y.open];
          d.why = cands.length > 1 ? `кубики выбрали №${x.i + 1} (${x.open}) и №${y.i + 1} (${y.open}) — беру менее занятого` : 'выбирать не из кого';
        } else if (a === 'hash') {
          const ang = hsh(name) % 360, pts = [];
          cands.forEach(it => { for (let v = 0; v < 3; v++) pts.push({ it, a: hsh(it.svc + '#' + it.k + '#' + v) % 360 }); });
          pts.sort((p, q) => p.a - q.a);
          const hit = pts.find(p => p.a >= ang) || pts[0];
          d.pick = hit.it; d.extra = { ang, pts };
          d.why = `hash(«${name}») = ${ang}° на кольце → ближайший по часовой — №${d.pick.i + 1}. Всегда туда же`;
        } else { d.pick = rnd(); d.why = `кубик выпал на №${d.pick.i + 1}`; }
        return d;
      }
      const wOf = it => it.power < 1 ? 1 : 2;

      /* ---------- модель ---------- */
      function spawn() {
        const c = Math.floor(Math.random() * CL.length), heavy = S.scn === 'mixed' && Math.random() < 1 / 7;
        S.reqs.push({ id: S.seq++, c, heavy, t0: S.t, ph: 'in', tE: S.t + T });
      }
      function arrive(r) {
        const it = S.insts[r.inst];
        if (it.dead) { r.ph = 'err'; r.tE = S.t + 700; it.open--; rec(r, true); S.pops.push({ x: IX + IW / 2, y: rowY(it.i) + rowH() / 2 + 4, txt: '✗ запрос улетел в мёртвый экземпляр', cls: 'bad', born: S.t }); return; }
        if (S.scn === 'session') {
          const s = S.sess[r.c];
          if (s == null) S.sess[r.c] = it.i;
          else if (s !== it.i) { S.lost = (S.lost || 0) + 1; S.streak = 0; S.sess[r.c] = it.i; S.pops.push({ x: 780, y: rowY(it.i) + 12, txt: `${CL[r.c][0]}: вход заново`, cls: 'bad', born: S.t }); ctx.log(`Запрос ${CL[r.c][2]} ушёл на №${it.i + 1}, а сессия была на №${s + 1} — <b>пришлось входить заново</b>`, 'bad'); }
          else { S.streak++; if (S.streak >= 15) ctx.done('sess'); }
        }
        if (it.act.length < SLOTS) start(r, it); else { r.ph = 'q'; it.q.push(r); }
      }
      function start(r, it) { r.ph = 'svc'; r.ts = S.t; r.svcT = S.L * (r.heavy ? 8 : 1) * it.slow * (0.75 + Math.random() * 0.5); r.tE = S.t + r.svcT; it.act.push(r); }
      function rec(r, err) {
        const lat = S.t - r.t0 + (err ? 0 : 2 * T);
        S.hist.push({ lat, inst: r.inst, err }); if (S.hist.length > 60) S.hist.shift();
      }
      function finish(r) {
        const it = S.insts[r.inst];
        it.act.splice(it.act.indexOf(r), 1); it.open--;
        const lat = S.t - r.tLB;
        it.ewma = it.ewma * 0.7 + lat * 0.3;
        rec(r, false);
        r.ph = 'back'; r.tB = S.t; r.tE = S.t + 2 * T;
        if (it.q.length) start(it.q.shift(), it);
      }
      function health() {
        S.insts.forEach(it => {
          if (it.dead) {
            it.fails++;
            if (P().health && it.fails >= 2 && !it.down) { it.down = true; ctx.log(`Health check: №${it.i + 1} дважды не ответил на /health — <b>исключён из раздачи</b>`, 'warn'); ctx.done('health'); }
          } else { if (it.down) ctx.log(`№${it.i + 1} снова отвечает — вернулся в раздачу`, 'ok'); it.fails = 0; it.down = false; }
        });
        S.hcT = S.t;
      }
      function tick(dt) {
        const end = S.t + dt;
        while (S.next <= end) { S.t = Math.max(S.t, S.next); spawn(); S.next += 1000 / S.lam * (0.5 + Math.random()); }
        S.t = end;
        if (S.t - S.hcT >= HC) health();
        S.reqs.forEach(r => {
          if (r.ph === 'in' && S.t >= r.tE) {
            const d = choose(r); S.last = d; S.flash = S.t;
            if (!d.pick) { r.ph = 'err'; r.tE = S.t + 700; rec(r, true); return; }
            r.inst = d.pick.i; r.tLB = S.t; d.pick.open++; d.pick.sent++; r.ph = 'out'; r.tE = S.t + T;
            if (P().sticky && S.cookie[r.c] == null) S.cookie[r.c] = d.pick.i;
          } else if (r.ph === 'out' && S.t >= r.tE) arrive(r);
          else if (r.ph === 'svc' && S.t >= r.tE) finish(r);
        });
        S.reqs = S.reqs.filter(r => !((r.ph === 'back' || r.ph === 'err') && S.t >= r.tE));
        S.pops = S.pops.filter(p => S.t - p.born < 1400);
        const mq = Math.max(0, ...S.insts.map(it => it.q.length));
        S.peakQ = Math.max(S.peakQ, mq);
        checkTries(mq);
      }
      function p95() { const a = S.hist.filter(h => !h.err).map(h => h.lat).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0; }
      function shares() { const fin = S.hist.filter(h => h.inst != null); return S.insts.map(it => fin.length ? fin.filter(h => h.inst === it.i).length / fin.length : 0); }
      function checkTries(mq) {
        const a = P().algo, sh = shares(), n = S.hist.length, fair = 1 / Math.max(1, S.insts.filter(it => it.svc === S.insts[0].svc).length);
        if (S.scn === 'mixed' && (a === 'rr' || a === 'random') && mq >= 3) ctx.done('rrq');
        if (n >= 30) {
          const key = S.scn + '|' + a + (P().sticky ? '+s' : '');
          S.mem[key] = p95();
          if (S.scn === 'mixed' && SMART.includes(a)) { const rr = S.mem['mixed|rr'] || S.mem['mixed|random']; if ((rr && S.mem[key] < rr * 0.85) || S.peakQ <= 1) ctx.done('lcq'); }
          if (S.scn === 'weak' && a === 'wrr' && sh[0] < fair * 0.8) ctx.done('wrr');
          if (S.scn === 'slow' && S.insts.length > 1 && (a === 'lrt' || a === 'p2c' || a === 'lc') && sh[1] < fair * 0.5) ctx.done('ewma');
        }
      }
      function reset() { S.hist = []; S.peakQ = 0; S.streak = 0; S.lost = 0; S.sess = {}; S.cookie = {}; S.insts.forEach(it => { it.cw = 0; }); }

      /* ---------- отрисовка ---------- */
      const rowH = () => Math.min(76, 440 / Math.max(1, S.insts.length));
      const rowY = i => 30 + i * rowH() + Math.max(0, (440 - S.insts.length * rowH()) / 2);
      const cY = c => 62 + c * 70;
      const col = c => `var(${CL[c][1]})`;
      const LBX = 200, LBW = 250, IX = 600, IW = 370;
      const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));
      function brain() {
        const d = S.last, a = P().algo, cx = 325, cy = 205, R = 62;
        let s = `<text class="xr-m acc" x="${LBX + 16}" y="96">${esc(ALGO[a][0])}</text><text class="xr-s" x="${LBX + 16}" y="112">${esc(ALGO[a][1])}</text>`;
        const cands = S.insts.filter(it => !d || it.svc === d.svc), hot = performance.now() - S.flashP < 500;
        const pk = d && d.pick ? d.pick.i : -1;
        if (a === 'rr' || a === 'random') {
          cands.forEach((it, k) => { const ang = -Math.PI / 2 + k / cands.length * 2 * Math.PI, x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang); s += `<circle class="xl-n ${it.i === pk ? 'pick' : ''} ${it.down ? 'off' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14"/><text class="xl-nt" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${it.i + 1}</text>`; });
          if (a === 'rr') { const k = cands.length ? S.rr % cands.length : 0, ang = -Math.PI / 2 + k / Math.max(1, cands.length) * 2 * Math.PI; s += `<line class="xl-ptr" x1="${cx}" y1="${cy}" x2="${(cx + (R - 20) * Math.cos(ang)).toFixed(1)}" y2="${(cy + (R - 20) * Math.sin(ang)).toFixed(1)}"/><circle class="xl-hub" cx="${cx}" cy="${cy}" r="5"/><text class="xr-s" x="${cx}" y="${cy + R + 30}" text-anchor="middle">стрелка — кто следующий</text>`; }
          else s += `<rect class="xl-die" x="${cx - 18}" y="${cy - 18}" width="36" height="36" rx="7"/><text class="xl-nt big" x="${cx}" y="${cy + 6}" text-anchor="middle">${pk >= 0 ? pk + 1 : '?'}</text>`;
        } else if (a === 'lc' || a === 'wrr' || a === 'lrt') {
          const rows = cands.slice(0, 6), mx = Math.max(1, ...rows.map(it => a === 'lc' ? it.open : a === 'wrr' ? Math.abs(it.cw) + wOf(it) : it.ewma * (it.open + 1)));
          rows.forEach((it, k) => {
            const y = 132 + k * 27, v = a === 'lc' ? it.open : a === 'wrr' ? it.cw : it.ewma * (it.open + 1), w = Math.max(2, Math.abs(v) / mx * 120);
            s += `<text class="xr-m ${it.i === pk ? 'acc' : ''}" x="${LBX + 16}" y="${y + 12}">№${it.i + 1}</text><rect class="xr-bar" x="${LBX + 50}" y="${y + 2}" width="120" height="13" rx="3"/><rect class="xr-bar-f ${it.i === pk ? 'acc' : v === mx && a !== 'wrr' ? 'warn' : ''}" x="${LBX + 50}" y="${y + 2}" width="${w.toFixed(1)}" height="13" rx="3"/>`;
            s += `<text class="xr-m" x="${LBX + 176}" y="${y + 12}">${a === 'lc' ? it.open + ' откр.' : a === 'wrr' ? 'вес ' + wOf(it) + ' · ' + (it.cw > 0 ? '+' : '') + it.cw : ms(it.ewma) + '×' + (it.open + 1)}</text>`;
          });
          if (a === 'wrr' && rows.length < 6) s += `<text class="xr-s" x="${LBX + 16}" y="${132 + rows.length * 27 + 12}">каждый шаг: +вес; берём наибольший; у него −сумма весов</text>`;
        } else if (a === 'p2c') {
          const e = d && d.extra;
          [0, 1].forEach(k => { const x = cx - 46 + k * 92, n = e ? e[k] : null, win = n != null && n === pk; s += `<rect class="xl-die ${win ? 'pick' : ''}" x="${x - 22}" y="${cy - 34}" width="44" height="44" rx="8"/><text class="xl-nt big" x="${x}" y="${cy - 5}" text-anchor="middle">${n != null ? n + 1 : '?'}</text><text class="xr-m ${win ? 'acc' : ''}" x="${x}" y="${cy + 28}" text-anchor="middle">${e ? e[k + 2] + ' откр.' : ''}</text>`; });
          s += `<text class="xr-s" x="${cx}" y="${cy + 56}" text-anchor="middle">два случайных → менее занятый</text>`;
        } else if (a === 'hash') {
          s += `<circle class="xl-ring" cx="${cx}" cy="${cy}" r="${R}"/>`;
          const pts = []; cands.forEach(it => { for (let v = 0; v < 3; v++) pts.push({ it, a: hsh(it.svc + '#' + it.k + '#' + v) % 360 }); });
          pts.forEach(p => { const an = (p.a - 90) * Math.PI / 180, x = cx + R * Math.cos(an), y = cy + R * Math.sin(an); s += `<rect class="xl-tick ${p.it.i === pk ? 'pick' : ''}" x="${(x - 9).toFixed(1)}" y="${(y - 8).toFixed(1)}" width="18" height="16" rx="4"/><text class="xl-nt sm" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${p.it.i + 1}</text>`; });
          CL.forEach(([nmC], c) => { const an = (hsh(nmC) % 360 - 90) * Math.PI / 180, x = cx + (R - 20) * Math.cos(an), y = cy + (R - 20) * Math.sin(an); s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${d && d.req.c === c ? 7 : 4.5}" style="fill:${col(c)}"/>`; });
          s += `<text class="xr-s" x="${cx}" y="${cy + R + 30}" text-anchor="middle">клиент на кольце → ближайший сервер по часовой</text>`;
        }
        if (d) {
          const lines = wrap(`Запрос ${CL[d.req.c][2]}${d.req.heavy ? ' (тяжёлый)' : ''} → ${d.pick ? '№' + (d.pick.i + 1) : 'некуда'}: ${d.why}`, 36).slice(0, 4);
          s += `<rect class="xl-why ${hot ? 'hot' : ''}" x="${LBX + 10}" y="300" width="${LBW - 20}" height="${18 + lines.length * 15}" rx="8"/>` + lines.map((l, k) => `<text class="xr-m" x="${LBX + 20}" y="${318 + k * 15}">${esc(l)}</text>`).join('');
        }
        return s;
      }
      const part = (k, x, y, w, h, inner) => `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}"><rect class="xl-pf" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${inner}</g>`;
      function draw() {
        S.flashP = S.flash === S.t ? performance.now() : (S.flashP || 0);
        let s = '', g = '';
        /* клиенты */
        CL.forEach(([n0], c) => {
          const y = cY(c), sess = S.scn === 'session' && S.sess[c] != null ? `сессия: №${S.sess[c] + 1}` : P().sticky && S.cookie[c] != null ? `cookie: №${S.cookie[c] + 1}` : '';
          g += `<circle cx="70" cy="${y}" r="15" style="fill:${col(c)}"/><text class="xl-ini" x="70" y="${y + 4}" text-anchor="middle">${n0[0]}</text><text class="xr-s" x="92" y="${y - 2}">${n0}</text>${sess ? `<text class="xr-m" x="92" y="${y + 12}">${sess}</text>` : ''}`;
          s += `<line class="xr-wire dash" x1="86" y1="${y}" x2="${LBX}" y2="250"/>`;
        });
        s += part('clients', 44, 38, 120, 424, g); g = '';
        /* балансировщик */
        s += `<rect class="xr-box" x="${LBX}" y="30" width="${LBW}" height="440" rx="14"/><text class="xr-t" x="${LBX + 16}" y="56">${esc(ctx.nm(ctx.node.id))}</text>`;
        s += part('mode', LBX + 8, 61, LBW - 16, 18, `<text class="xr-s" x="${LBX + 16}" y="73">${P().mode === 'l4' ? 'L4: видит только соединения' : 'L7: видит HTTP-запрос'}${P().sticky ? ' · sticky' : ''}</text>`);
        s += part('algo', LBX + 8, 82, LBW - 16, 300, brain());
        if (S.svcs.length > 1) s += `<text class="xr-s" x="${LBX + 16}" y="${300 - 8}">${P().mode === 'l7' ? 'сначала маршрут по пути запроса → сервис' : 'L4 не видит путь: маршрутов нет'}</text>`;
        const hp = (S.t - S.hcT) / HC;
        g += `<text class="xr-m" x="${LBX + 16}" y="${428}">${P().health ? `♥ health checks раз в 1 с` : 'health checks выключены'}</text>`;
        S.insts.forEach((it, k) => { g += `<text class="xr-m ${it.down ? 'bad' : it.dead && P().health ? 'warn' : it.dead ? 'bad' : 'ok'}" x="${LBX + 16 + (k % 3) * 76}" y="${446 + Math.floor(k / 3) * 14}">№${it.i + 1} ${it.down ? '✗ исключён' : it.dead ? (P().health ? '? молчит' : '? не знаю') : '✓ жив'}</text>`; });
        s += part('health', LBX + 8, 414, LBW - 16, 52, g); g = '';
        /* провода и экземпляры */
        S.insts.forEach(it => {
          const y = rowY(it.i), h = rowH() - 8, cyI = y + h / 2, act = S.last && S.last.pick === it && performance.now() - S.flashP < 500;
          s += `<line class="xr-wire ${act ? 'act' : ''}" x1="${LBX + LBW}" y1="250" x2="${IX - 12}" y2="${cyI.toFixed(1)}"/>`;
          if (P().health && hp < 0.4) { const f = hp / 0.4; s += `<circle class="xl-hc ${it.dead ? 'bad' : ''}" cx="${lerp(LBX + LBW, IX - 12, f).toFixed(1)}" cy="${lerp(250, cyI, f).toFixed(1)}" r="3"/>`; }
          const st = it.dead ? (it.down ? 'dead' : 'bad') : it.act.length >= SLOTS && it.q.length ? 'hot' : '';
          const svcN = S.svcs.length > 1 ? (S.svcs.find(v => v.id === it.svc) || {}).name : '';
          s += `<g class="${ctx.canGo(it.svc) ? 'xr-go' : ''}" data-xgo="${ctx.canGo(it.svc) ? it.svc : ''}"><rect class="xr-box ${st} ${ctx.part() === 'inst' ? 'sel' : ''}" x="${IX}" y="${y}" width="${IW}" height="${h}" rx="10"/>`;
          s += `<text class="xr-t" x="${IX + 12}" y="${y + 19}">№${it.i + 1}</text><text class="xr-s" x="${IX + 42}" y="${y + 19}">${esc((svcN || '').slice(0, 18))}${it.slow > 1 ? (it.power < 1 ? ' · слабее ×½' : ' · тормозит ×' + it.slow) : ''}${it.dead ? (it.down ? ' · исключён' : ' · не отвечает') : ''}</text>`;
          for (let k = 0; k < SLOTS; k++) {
            const r = it.act[k], x = IX + 14 + k * 30, yy = y + Math.min(26, h - 26);
            s += `<rect class="xr-slot ${r ? 'on' : ''}" x="${x}" y="${yy}" width="24" height="20" rx="4"/>`;
            if (r) { const f = Math.min(1, (S.t - r.ts) / r.svcT); s += `<circle cx="${x + 12}" cy="${yy + 10}" r="${r.heavy ? 8 : 5.5}" style="fill:${col(r.c)}"/><rect class="xl-prog" x="${x}" y="${yy + 21}" width="${(24 * f).toFixed(1)}" height="2.5"/>`; }
          }
          it.q.slice(0, 8).forEach((r, k) => { s += `<circle class="xl-q" cx="${IX - 22 - k * 13}" cy="${(cyI + 12).toFixed(1)}" r="${r.heavy ? 7 : 5}" style="fill:${col(r.c)}"/>`; });
          if (it.q.length) s += `<text class="xr-m warn" x="${IX - 18}" y="${(cyI - 2).toFixed(1)}" text-anchor="end">очередь ${it.q.length}</text>`;
          const sh = shares()[it.i] || 0;
          s += `<text class="xr-m" x="${IX + IW - 12}" y="${y + 19}" text-anchor="end">${it.open} откр. · ${Math.round(sh * 100)} % запросов</text>`;
          if (h > 50) s += `<text class="xr-s" x="${IX + IW - 12}" y="${y + 36}" text-anchor="end">отвечает ≈ ${ms(it.ewma)}${P().algo === 'wrr' ? ' · вес ' + wOf(it) : ''}</text>`;
          s += '</g>';
        });
        /* запросы в пути */
        S.reqs.forEach(r => {
          let x, y, cls = '', rr = r.heavy ? 8 : 5;
          if (r.ph === 'in') { const f = 1 - (r.tE - S.t) / T; x = lerp(86, LBX, f); y = lerp(cY(r.c), 250, f); }
          else if (r.ph === 'out') { const f = 1 - (r.tE - S.t) / T, yy = rowY(r.inst) + (rowH() - 8) / 2; x = lerp(LBX + LBW, IX - 12, f); y = lerp(250, yy, f); }
          else if (r.ph === 'back') {
            const f = (S.t - r.tB) / (2 * T), yy = rowY(r.inst) + (rowH() - 8) / 2;
            if (f < 0.5) { x = lerp(IX - 12, LBX + LBW, f * 2); y = lerp(yy, 250, f * 2); } else { x = lerp(LBX, 86, (f - 0.5) * 2); y = lerp(250, cY(r.c), (f - 0.5) * 2); }
            cls = 'ok'; rr = 3.5;
          } else return;
          s += `<circle class="xr-dot ${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr}" ${cls ? '' : `style="fill:${col(r.c)}"`}/>`;
        });
        S.pops.forEach(p => { const f = (S.t - p.born) / 1400; s += `<text class="xr-pop ${p.cls}" x="${p.x}" y="${(p.y - f * 18).toFixed(1)}" text-anchor="middle" style="opacity:${(1 - f).toFixed(2)}">${esc(p.txt)}</text>`; });
        if (S.note) s += `<text class="xr-s" x="${IX}" y="490">${esc(S.note)}</text>`;
        ctx.svg.innerHTML = s;
      }

      build(); reset();
      return {
        tick,
        draw,
        refresh() { build(); },
        scenario(id) { S.scn = id; applyScn(); reset(); S.insts.forEach(it => { it.down = false; it.fails = 0; it.ewma = S.L; }); },
        onProp(k, prev, v) {
          reset();
          if (k === 'algo') return ({ rr: 'Смотри на стрелку: она просто идёт по кругу и не смотрит, кто занят.', wrr: 'Смотри на счётчики: мощный экземпляр набирает вес быстрее и выбирается чаще.', lc: 'Смотри на полоски «открыто»: новый запрос идёт к самой короткой.', lrt: 'Смотри на «среднее время × открытые»: тормозящий получает высокий балл, и его обходят.', p2c: 'Смотри на два кубика: из двух случайных берётся менее занятый — почти как least connections, но без опроса всех.', hash: 'Смотри на кольцо: у каждого клиента своё место, его запросы всегда идут к одному экземпляру.', random: 'Кубик: в среднем ровно, но вспышки неравномерности видны глазом.' })[v] || '';
          if (k === 'health') return v ? 'Проверки /health раз в секунду: мёртвый экземпляр исключат после двух неудач.' : 'Без проверок мёртвый экземпляр остаётся в раздаче: часть запросов улетает в никуда.';
          if (k === 'sticky') return v ? 'Первый запрос клиента выбирается алгоритмом, дальше — по cookie к тому же экземпляру.' : 'Каждый запрос выбирается заново.';
          if (k === 'mode') return v === 'l4' ? 'L4 видит только TCP-соединения: быстрее, но не умеет маршрутизировать по пути и повторять HTTP-запросы.' : 'L7 читает HTTP: может разводить пути по разным сервисам и повторять неудачные запросы.';
          return '';
        },
        now() {
          const a = P().algo, sc = S.scn, nm1 = ALGO[a][0], N = S.insts.length;
          if (ctx.part() === 'algo') { ctx.done('algoPart'); const d = S.last; return d ? `<b>Последнее решение (${esc(nm1)}):</b> запрос ${esc(CL[d.req.c][2])} → ${d.pick ? '№' + (d.pick.i + 1) : 'некуда'}, потому что ${esc(d.why)}.` : '<b>Ждём первый запрос…</b>'; }
          if (ctx.part() === 'health') return `<b>Проверки:</b> ${S.insts.map(it => `№${it.i + 1} — ${it.down ? 'исключён' : it.dead ? `не отвечает (${it.fails} из 2)` : 'жив'}`).join(', ')}. ${P().health ? 'Проверки идут раз в секунду.' : 'Проверки выключены — балансировщик не узнает о падении.'}`;
          if (ctx.part() === 'inst') return `<b>Экземпляры сейчас:</b> ${S.insts.map(it => `№${it.i + 1}: ${it.act.length}/${SLOTS} слотов, очередь ${it.q.length}`).join('; ')}.`;
          if (S.real < 2 && S.svcs.length === 1) S.note = `На площадке у сервиса ${S.real} экземпляр — раздавать некому. Для наглядности в модели ${N}.`; else if (S.real > N) S.note = `В модели ${N} из ${S.real} экземпляров — остальные ведут себя так же.`; else S.note = '';
          if (!S.svcs.length) return '<b>За балансировщиком нет сервисов.</b> Соедини его стрелкой с сервисом на площадке.';
          const mq = Math.max(0, ...S.insts.map(it => it.q.length));
          if (sc === 'norm') return `<b>Все запросы одинаковые, и почти любой алгоритм раздаёт ровно.</b> Смотри: у каждого экземпляра примерно равная доля. Разница между алгоритмами видна, когда запросы или серверы разные — выбери ситуацию выше.`;
          if (sc === 'mixed') return SMART.includes(a) ? `<b>${nm1} видит, кто занят.</b> Тяжёлый отчёт держит слот долго, у этого экземпляра больше открытых запросов, и новые идут к соседям. Очереди короткие.` : a === 'hash' ? `<b>Hash не смотрит на занятость.</b> Клиент привязан к своему экземпляру, даже если там застрял тяжёлый отчёт.` : `<b>${nm1} не смотрит, кто занят.</b> Тяжёлый отчёт (большая точка) застрял на экземпляре, а запросы всё равно приходят туда по очереди${mq >= 2 ? ' — видишь очередь слева от экземпляра?' : '. Подожди пару тяжёлых — появится очередь.'} Переключи на Least connections.`;
          if (sc === 'weak') return a === 'wrr' ? '<b>Веса учитывают мощность.</b> У слабого №1 вес 1, у остальных 2, поэтому ему достаётся вдвое меньше запросов. Веса задают заранее, по мощности машин.' : SMART.includes(a) ? `<b>${nm1} подстраивается сам:</b> слабый №1 дольше держит запросы, у него больше открытых — и ему дают меньше.` : `<b>№1 вдвое слабее, а получает столько же.</b> Его слоты заняты дольше, растёт очередь. Лечится Weighted round robin (веса по мощности) или Least connections.`;
          if (sc === 'slow') return a === 'lrt' ? '<b>Least response time следит за временем ответа.</b> Среднее время №2 выросло в 5 раз — его балл стал большим, и запросы обходят его. Когда он оживёт, время снова упадёт.' : a === 'wrr' ? '<b>Веса не помогают:</b> они заданы заранее, а №2 затормозил внезапно. Нужен алгоритм, который смотрит на живые цифры: Least response time или Least connections.' : SMART.includes(a) ? `<b>${nm1} частично спасает:</b> медленные запросы дольше открыты, поэтому №2 получает меньше. Least response time реагирует ещё точнее.` : `<b>№2 тормозит, а ${nm1} шлёт ему наравне со всеми.</b> Каждый ${N > 1 ? N + '-й' : ''} запрос ждёт в 5 раз дольше — это и есть хвост p95.`;
          if (sc === 'session') return a === 'hash' || P().sticky ? `<b>Каждый клиент всегда попадает к своему экземпляру</b> — ${a === 'hash' ? 'по месту на кольце' : 'по cookie'}. Сессия не теряется. Минус: если экземпляр упадёт, его клиенты всё равно войдут заново. Надёжнее хранить сессию снаружи (Redis) — тогда подойдёт любой алгоритм.` : `<b>Запросы одного клиента попадают на разные экземпляры</b>, а сессия лежит в памяти только одного — пользователю приходится входить заново (${S.lost || 0} раз). Включи sticky sessions или Consistent hash. Лучшее решение — не хранить сессию в памяти сервиса.`;
          if (sc === 'down') { const dd = S.insts.find(it => it.dead); if (!dd) return '<b>Нужно хотя бы 2 экземпляра,</b> чтобы было куда переключиться.'; return dd.down ? `<b>№${dd.i + 1} исключён.</b> Health check дважды не получил ответа от /health, и балансировщик перестал слать туда запросы. Ошибки прекратились.` : P().health ? `<b>№${dd.i + 1} упал.</b> Балансировщик пока не знает: ждёт двух неудачных проверок /health. Пара запросов успеет улететь в никуда.` : `<b>Health checks выключены.</b> Балансировщик не знает, что №${dd.i + 1} мёртв, и продолжает слать туда каждый ${N}-й запрос — это ошибки у пользователей. Включи health checks справа.`; }
          return '';
        },
        stats() {
          const fin = S.hist, ok = fin.filter(h => !h.err), sh = shares(), mx = Math.max(0, ...sh), fair = 1 / Math.max(1, S.insts.length);
          const err = fin.filter(h => h.err).length, p = p95();
          const tried = Object.entries(S.mem).filter(([k]) => k.startsWith(S.scn + '|')).map(([k, v]) => `${SHORT[k.split('|')[1].replace('+s', '')]}${k.endsWith('+s') ? '+sticky' : ''} ${ms(v)}`);
          const out = [
            ['p95 ответа', fin.length >= 8 ? ms(p) : '…', p > S.L * 3 ? 'bad' : p > S.L * 1.8 ? 'warn' : 'ok', '95 % запросов быстрее'],
            ['Самая длинная очередь', String(Math.max(0, ...S.insts.map(it => it.q.length))), S.peakQ >= 3 ? 'bad' : S.peakQ >= 1 ? 'warn' : 'ok', `пик ${S.peakQ}`],
            ['Самому загруженному', Math.round(mx * 100) + ' %', mx > fair * 1.5 ? 'warn' : '', 'запросов; доли: ' + sh.map(v => Math.round(v * 100)).join(' / ') + ' %'],
            ['Время замедлено', '×' + K, '', 'чтобы было видно каждый запрос']
          ];
          if (S.scn === 'down') out.splice(2, 0, ['Ошибки', String(err), err ? 'bad' : 'ok', 'из последних ' + fin.length]);
          if (S.scn === 'session') out.splice(2, 0, ['Входили заново', String(S.lost || 0), S.lost ? 'bad' : 'ok', `подряд без потерь: ${S.streak}`]);
          if (tried.length) out.push(['Уже пробовал здесь', tried.length + ' алг.', '', 'p95: ' + tried.join(' · ')]);
          void ok;
          return out;
        }
      };
    }
  };
})();
