/* «Realtime-шлюз изнутри» (WebSocket): постоянные соединения по экземплярам, сообщение в чат через pub/sub на все экземпляры с участниками,
   heartbeat и обрыв, переподключение и догон пропущенного по номеру сообщения, липкость соединения, предел соединений на экземпляр. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
  function arrow(x1, y1, x2, y2, c) {
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
    const a = Math.atan2(y2 - y1, x2 - x1), L = 7, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`;
    return `<line class="xwz-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xwz-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const MONO = (x, y, t, c, a) => `<text class="xwz-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const PER_CONN = 100000;

  /* ---------- чат и его участники ---------- */
  const MEMBERS = [['Аня', 0], ['Борис', 1], ['Вера', 1], ['Гоша', 2], ['Дина', 3], ['Егор', 4]];
  const TEXTS = ['Купи хлеба по дороге', 'Ок, после работы', 'Я уже купил :)', 'Тогда молоко', 'И сыр!', 'Кто сегодня готовит?', 'Я!', 'В 7 у подъезда'];
  const COLORS = ['--k-read', '--k-write', '--k-static', '--k-upload', '--k-search', '--k-msg'];
  const col = i => `var(${COLORS[i % COLORS.length]})`;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const CL = { x: 16, y: 46, w: 214, h: 346 }, LB = { x: 240, y: 46, w: 40, h: 346 }, IN = { x: 292, y: 46, w: 286, h: 346 };
  const BR = { x: 592, y: 46, w: 184, h: 200 }, DB = { x: 592, y: 256, w: 184, h: 136 }, CH = { x: 788, y: 46, w: 196, h: 346 };
  const LG = { x: 16, y: 402, w: 560, h: 150 }, HB = { x: 588, y: 402, w: 396, h: 150 };

  SD.XRAY.ws = {
    viewBox: '0 0 1000 560',
    cta: 'Тысячи постоянных соединений по экземплярам, сообщение через pub/sub на все экземпляры с участниками, heartbeat, переподключение и догон пропущенного',
    dive: 'websocket',
    simple: () => ({
      an: 'Как <b>телефонная станция с операторами</b>: каждый абонент держит открытую линию к своему оператору. Когда Аня говорит в общий чат, её оператор кричит в общий коридор «сообщение для чата 7001», и каждый оператор, у которого на линии участник этого чата, передаёт его своему абоненту.',
      pl: 'Realtime-шлюз держит постоянные соединения с телефонами и браузерами, чтобы сервер сам присылал новое сразу. Соединений миллионы, они разложены по многим экземплярам. Чтобы сообщение дошло до участников на других экземплярах, экземпляры обмениваются им через брокер (pub/sub).'
    }),
    props: ['count'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Участники чата 7001 сидят на разных экземплярах и переписываются.' },
      { id: 'nopub', name: 'Без pub/sub', note: 'Экземпляры не связаны брокером: каждый знает только своих клиентов.' },
      { id: 'crash', name: 'Экземпляр упал', note: 'Экземпляр ws-2 падает. Его клиенты переподключаются и догоняют пропущенное.' },
      { id: 'surge', name: 'Наплыв вечером', note: 'Вечером онлайн втрое больше. Хватит ли экземпляров на все соединения?' },
      { id: 'deploy', name: 'Выкатка', note: 'Выкатываем новую версию: экземпляры перезапускаются по одному.' }
    ],
    tries: [
      { id: 'pub', text: 'В «Без pub/sub» найди участника на другом экземпляре, который не получил сообщение' },
      { id: 'crash', text: 'В «Экземпляр упал» дождись, пока клиенты переподключатся и догонят пропущенные сообщения' },
      { id: 'surge', text: 'В «Наплыве вечером» добавь экземпляров, чтобы новых соединений больше не отбивали' },
      { id: 'deploy', text: 'В «Выкатке» посмотри, как после перезапуска соединения распределены неровно' },
      { id: 'phb', text: 'Открой блок «Heartbeat» и дождись, пока сервер закроет соединение без ответа на ping' },
      { id: 'pcon', text: 'Открой блок «Соединение» и найди ответ 101 Switching Protocols' }
    ],
    parts: {
      conn: {
        name: 'Соединение',
        an: 'Как <b>звонок, который не кладут</b>: один раз дозвонились — и дальше говорят обе стороны, когда захотят, без новых звонков.',
        pl: 'Обычный HTTP — «спросил, получил, положил трубку». WebSocket начинается как HTTP-запрос с просьбой «переключиться», после чего то же TCP-соединение остаётся открытым, и сервер может сам слать сообщения клиенту в любой момент.',
        how: ['Клиент: GET /ws с заголовками Upgrade: websocket, Connection: Upgrade, Sec-WebSocket-Key.', 'Сервер: 101 Switching Protocols и Sec-WebSocket-Accept — дальше по этому соединению идут кадры (frames), а не HTTP.', 'Кадр — это несколько байт заголовка и данные: текст (JSON), бинарные данные, ping, pong, close.', 'Сначала клиент авторизуется: токен в первом сообщении или в параметре, сервер запоминает user_id соединения.', 'Клиент подписывается на свои чаты: {"op": "sub", "chat": 7001}.', 'Каждое открытое соединение держит память (десятки КБ) и файловый дескриптор — поэтому на сервер ≈ 100 000 соединений.'],
        watch: 'Слева — клиенты, цвет — экземпляр, к которому подключён клиент. Внутри блока — рукопожатие Upgrade и кадры, которые идут по уже открытому соединению.',
        real: 'RFC 6455. Сервера: Node.js ws / uWebSockets, Go gorilla/websocket, Centrifugo, Phoenix Channels, Socket.IO. Альтернативы: Server-Sent Events (только от сервера), long polling.'
      },
      pubsub: {
        name: 'Pub/Sub между экземплярами',
        an: 'Как <b>громкая связь в офисе</b>: оператор не знает, у кого на линии Борис, поэтому объявляет в общий канал «для чата 7001», а нужные операторы сами подхватывают.',
        pl: 'Аня сидит на ws-1, Борис — на ws-2. Экземпляр Ани не может напрямую писать в сокет Бориса. Поэтому он публикует сообщение в брокер в канал чата, а все экземпляры, у которых есть участники этого чата, подписаны на канал и доставляют сообщение своим клиентам.',
        how: ['Подключился участник чата 7001 — экземпляр подписывается на канал chat:7001 (если ещё не подписан).', 'Аня отправляет сообщение → ws-1 сохраняет его в базу и получает номер (message_id = 1044).', 'ws-1 публикует {chat: 7001, id: 1044, text} в канал chat:7001.', 'Брокер рассылает сообщение всем подписанным экземплярам — ws-1, ws-2, ws-3.', 'Каждый экземпляр отправляет его своим клиентам — участникам чата.', 'Без брокера сообщение увидят только участники на том же экземпляре, что и Аня.'],
        watch: 'Посередине — брокер: канал chat:7001 и список подписанных экземпляров. Сообщение идёт от экземпляра Ани в брокер и расходится веером. В «Без pub/sub» часть участников остаётся без сообщения (красный крестик).',
        real: 'Redis Pub/Sub, NATS, Kafka (с группой на каждый экземпляр), встроенный брокер Centrifugo. На площадке без pub/sub доля доставленных сообщений = 1 / число экземпляров.'
      },
      heartbeat: {
        name: 'Heartbeat',
        an: 'Как <b>«алло, ты тут?»</b> в долгой тишине: если собеседник не отвечает пару раз подряд, понимаешь, что связь оборвалась, и кладёшь трубку.',
        pl: 'Телефон может уехать в тоннель, и соединение «умрёт» без всякого сообщения о закрытии. Сервер и клиент периодически шлют ping и ждут pong. Нет ответа дважды — соединение считается мёртвым и закрывается, а клиент переподключится, когда сеть вернётся.',
        how: ['Раз в 25 с сервер шлёт кадр ping, клиент отвечает pong.', 'Пропущено 2 pong подряд — сервер закрывает сокет и освобождает память.', 'Клиент тоже следит: не было ни сообщений, ни ping 60 с — сам рвёт и переподключается.', 'Ping нужен и для того, чтобы NAT и прокси не закрыли «молчащее» соединение по таймауту (часто 60–120 с).', 'Слишком частый ping — лишний трафик и разряд батареи на миллионах телефонов.', 'Мёртвые соединения без heartbeat копятся и съедают предел соединений экземпляра.'],
        watch: 'Справа внизу — пульс соединений: ping уходит, pong возвращается. Один телефон молчит (тоннель), счётчик пропусков растёт, и сервер закрывает сокет.',
        real: 'Socket.IO: pingInterval 25 с, pingTimeout 20 с. Centrifugo: ping каждые 25 с. AWS ALB закрывает простаивающее соединение через 60 с по умолчанию.'
      },
      reconnect: {
        name: 'Переподключение и догон',
        an: 'Как <b>вернуться в беседу после отлучки</b>: «последнее, что я слышал, — про молоко; что было дальше?» — и тебе пересказывают только пропущенное.',
        pl: 'Соединение может оборваться: упал экземпляр, пропала сеть, выкатка. Клиент переподключается с паузой и случайным разбросом, попадает на любой живой экземпляр и просит всё, что пришло после последнего полученного номера сообщения.',
        how: ['Клиент помнит номер последнего полученного сообщения в каждом чате: last_id = 1043.', 'Обрыв → пауза 1 с, 2 с, 4 с … плюс случайный разброс (jitter), чтобы миллион клиентов не ломился в одну секунду.', 'Балансировщик отправляет новое соединение на живой экземпляр.', 'Клиент: {"op": "resume", "chat": 7001, "after": 1043}.', 'Сервер достаёт из базы сообщения с id > 1043 и присылает их, потом — новые в реальном времени.', 'Номера на стороне сервера, а не время клиента: часы телефонов не совпадают.'],
        watch: 'В «Экземпляр упал» клиенты упавшего ws-2 становятся серыми, через паузу перекрашиваются в цвет нового экземпляра, а справа внизу — запрос догона after=… и сколько сообщений пришло из истории.',
        real: 'Centrifugo recovery по offset, Phoenix Presence, Slack и Discord — догон по последнему id. Без jitter после падения получается «громоподобное стадо» (thundering herd) переподключений.'
      },
      sticky: {
        name: 'Балансировка долгих соединений',
        an: 'Как <b>очередь к кассам, где покупатель стоит часами</b>: новых раскидываешь по свободным кассам, но тех, кто уже стоит, не переставишь — ровно бывает только после того, как все ушли.',
        pl: 'Соединение живёт часами и всё это время привязано к одному экземпляру. Балансировщик распределяет только новые соединения. Добавили экземпляр — он пустой, пока клиенты не переподключатся. Выкатка перезапускает экземпляры и перемешивает клиентов.',
        how: ['Балансировщик L4 (TCP) или L7 с поддержкой Upgrade выбирает экземпляр для нового соединения — обычно по наименьшему числу соединений.', 'Дальше все кадры этого соединения идут на тот же экземпляр — «липкость» получается сама собой.', 'Новый экземпляр получает только новые соединения — перекос держится долго.', 'Выкатка: экземпляр перестаёт принимать новые, шлёт клиентам close 1012 (Service Restart) и ждёт, пока они уйдут.', 'Клиенты переподключаются с jitter на остальные экземпляры — нагрузка там растёт.', 'После выкатки последний перезапущенный экземпляр почти пустой: перекос — норма, его выравнивают постепенно.'],
        watch: 'Полоски у экземпляров — сколько соединений на каждом. В «Выкатке» видно, как ws-1 отдаёт клиентов остальным, перезапускается пустым и долго остаётся недогруженным.',
        real: 'Nginx и HAProxy: proxy_read_timeout побольше и заголовки Upgrade; AWS ALB и NLB, Kubernetes Ingress. При выкатке — preStop и graceful shutdown с close 1012.'
      },
      limit: {
        name: 'Предел соединений', knobs: ['count'],
        an: 'Как <b>число линий у оператора</b>: у каждого 100 000 линий. Абонентов больше — новым звонкам отвечают «все линии заняты».',
        pl: 'Каждое соединение занимает память и файловый дескриптор, поэтому на экземпляр держат ≈ 100 000 соединений. Соединений в системе больше, чем помещается на всех экземплярах, — новые отбиваются, и люди сидят без мгновенной доставки.',
        how: ['Память: ≈ 10–50 КБ на соединение (буферы, подписки, состояние) → 100 000 соединений ≈ 2–5 ГБ.', 'Файловые дескрипторы: ulimit -n поднимают до 1 000 000.', 'Порты: у одного IP-адреса клиента к одному серверу ≈ 64 000 портов — балансировщику нужны несколько адресов.', 'Предел достигнут — новые соединения получают 503 или закрытие 1013 (Try Again Later), клиенты пробуют позже.', 'Число экземпляров = пик онлайна / 100 000 + запас на падение одного.', 'Сообщения тоже стоят: на экземпляр ≈ 20 000 сообщений в секунду.'],
        watch: 'Полоски у экземпляров: заполнение до предела 100 000. В «Наплыве вечером» они краснеют, а в журнале появляются отказы новых соединений — добавь экземпляров.',
        real: `Площадка: на экземпляр 100 000 соединений и 20 000 сообщений в секунду. Уровень «Мессенджер»: 1,2 млн онлайн и 40 000 сообщений в секунду.`
      }
    },
    legend: [['sq xwz-swc', 'Клиент: цвет — его экземпляр'], ['xwz-swm', 'Сообщение в чат'], ['ok', 'Доставлено участнику'], ['accent', 'Через брокер (pub/sub)'], ['sq xwz-swh', 'Ping / pong'], ['bad', 'Не доставлено, отказ, обрыв']],
    live: (n, r, all) => {
      const i = r.info || {}, L = (SD.app && SD.app.A && SD.app.A.level) || {}, l = r.load || {};
      const out = [['Сообщений', SD.fmt.num(l.msg || 0) + '/с', '']];
      if (i.conns != null) out.push(['Соединений', `${SD.fmt.num(i.conns)} из ${SD.fmt.num(i.connCap || 0)}`, i.uConn > 1 ? 'bad' : i.uConn > 0.75 ? 'warn' : 'ok']);
      out.push(['Экземпляров', String(n.props.count || 1), '']);
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xwzSt"></g><g id="xwzDy" class="xwz-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xwzSt'), gDy = ctx.svg.querySelector('#xwzDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 8) S.fx.shift(); };
      const L = () => (SD.app && SD.app.A && SD.app.A.level) || {};
      const N = () => clamp(+P().count || 1, 1, 40);
      const NS = () => Math.min(N(), 6);   // сколько экземпляров рисуем
      const nbr = () => { const os = ctx.outs().map(x => x.n); return { pub: os.find(k => k.type === 'queue' || k.type === 'cache') || null, db: os.find(k => k.type === 'nosql' || k.type === 'sql') || null }; };
      const hasPub = () => S.scn !== 'nopub' && !!nbr().pub;
      const surgeK = () => S.scn === 'surge' ? 3 : 1;
      const totalConns = () => { const i = ctx.res.info || {}; const base = i.conns || L().connections || 120000; return base * surgeK(); };
      const capAll = () => N() * PER_CONN;
      const instY = i => IN.y + 32 + i * (IN.h - 40) / NS();
      const instH = () => (IN.h - 40) / NS() - 6;

      /* ---------- клиенты ---------- */
      function reset() {
        const ns = NS();
        S.cli = [];
        for (let k = 0; k < 30; k++) { const m = k < MEMBERS.length ? MEMBERS[k] : null; S.cli.push({ k, name: m ? m[0] : null, inst: m ? m[1] % ns : k % ns, st: 'on', last: 1043, miss: 0, hbMiss: 0, x: CL.x + 18 + (k % 5) * 40, y: CL.y + 40 + Math.floor(k / 5) * 48 }); }
        Object.assign(S, { t: 0, depN: 0, msgs: [], fx: [], log: [], msgId: 1043, msgAt: 900, ev: [], hist: [{ id: 1041, a: 'Мама', x: 'Купи хлеба по дороге' }, { id: 1042, a: 'Аня', x: 'Ок, после работы' }, { id: 1043, a: 'Папа', x: 'Я уже купил :)' }], hb: { t0: 0, dead: 25, miss: 0 }, crashAt: 2600, crashed: -1, upAt: 0, dep: null, depAt: 2000, rejT: [], resumes: [], cfgT: 0 });
        S.instDown = Array(ns).fill(false);
        S.loadW = Array(ns).fill(1);   // доля соединений экземпляра (для перекоса после выкатки)
        S.cfg = cfgSig();
      }
      const cfgSig = () => [NS(), S.scn].join('|');
      const members = () => S.cli.filter(c => c.name);
      const subs = () => [...new Set(members().filter(c => c.st === 'on').map(c => c.inst))].sort();
      const cliPt = c => [c.x, c.y];
      const instPt = (i, side) => [side === 'r' ? IN.x + IN.w - 8 : IN.x + 8, instY(i) + instH() / 2];

      /* ---------- сообщения ---------- */
      function send() {
        const on = members().filter(c => c.st === 'on'); if (!on.length) return;
        const from = on[Math.floor(Math.random() * on.length)], id = ++S.msgId, text = TEXTS[id % TEXTS.length];
        const m = { id, from, text, t0: S.t, ph: 'up', deliv: [] };
        S.msgs.push(m); if (S.msgs.length > 6) S.msgs.shift();
        S.hist.push({ id, a: from.name, x: text }); if (S.hist.length > 9) S.hist.shift();
      }
      function msgStep(m) {
        const u = S.t - m.t0;
        if (m.ph === 'up' && u > 500) { m.ph = 'pub'; m.t1 = S.t; }
        if (m.ph === 'pub' && S.t - m.t1 > (hasPub() ? 700 : 300)) {
          m.ph = 'fan'; m.t2 = S.t;
          const targets = hasPub() ? subs() : [m.from.inst];
          m.deliv = members().filter(c => c !== m.from).map(c => {
            const ok = c.st === 'on' && targets.includes(c.inst) && !S.instDown[c.inst];
            return { c, ok, gone: c.st !== 'on', t: S.t + 200 + Math.random() * 300 };
          });
          m.deliv.forEach(d => { if (d.ok) { d.c.last = Math.max(d.c.last, m.id); } });
          const lost = m.deliv.filter(d => !d.ok && !d.gone);
          S.ev.push({ t: S.t, ok: m.deliv.filter(d => d.ok).length, lost: lost.length });
          S.log.unshift({ t: S.t, id: m.id, a: m.from.name, i: m.from.inst, ok: m.deliv.filter(d => d.ok).map(d => d.c.name), lost: lost.map(d => d.c.name), off: m.deliv.filter(d => d.gone).map(d => d.c.name) }); if (S.log.length > 5) S.log.pop();
          if (lost.length && !hasPub()) { S.flags.pubLost = 1; done('pub'); note('nopub', `<b>Сообщение ${m.id} не дошло до ${lost.map(d => d.c.name).join(', ')}:</b> ${m.from.name} сидит на ws-${m.from.inst + 1}, а они — на других экземплярах. Без pub/sub экземпляр знает только своих клиентов.`, 'bad', 5000); }
        }
        if (m.ph === 'fan' && S.t - m.t2 > 1400) m.ph = 'done';
      }

      /* ---------- падение, выкатка, наплыв ---------- */
      function crashStep() {
        if (S.scn !== 'crash' || NS() < 2) return;
        if (S.crashed < 0 && S.t >= S.crashAt) {
          const i = 1; S.crashed = i; S.instDown[i] = true; S.upAt = S.t + 9000;
          S.cli.forEach(c => { if (c.inst === i) { c.st = 'off'; c.offAt = S.t; c.back = 1000 + Math.random() * 2500; } });
          note('cr', `<b>ws-2 упал.</b> Его ${nf(totalConns() / N())} соединений оборвались разом. Клиенты переподключатся с паузой и разбросом (jitter) и попросят пропущенное.`, 'bad', 0);
        }
        S.cli.forEach(c => {
          if (c.st === 'off' && S.t - c.offAt > c.back) {
            const alive = Array.from({ length: NS() }, (_, i) => i).filter(i => !S.instDown[i]);
            c.inst = alive[c.k % alive.length]; c.st = 'on';
            if (c.name) {
              const missed = S.hist.filter(h => h.id > c.last).length;
              S.resumes.push({ t: S.t, name: c.name, after: c.last, n: missed, inst: c.inst }); if (S.resumes.length > 3) S.resumes.shift();
              c.last = S.msgId;
              if (missed) { S.flags.resumed = 1; done('crash'); note('rs' + c.k, `<b>${c.name} переподключилась к ws-${c.inst + 1}</b> и попросила after=${S.resumes[S.resumes.length - 1].after}: сервер прислал ${missed} ${pl(missed, 'пропущенное сообщение', 'пропущенных сообщения', 'пропущенных сообщений')} из истории.`, 'ok', 2500); }
            }
          }
        });
        if (S.crashed >= 0 && S.t >= S.upAt) { S.instDown[S.crashed] = false; S.crashed = -1; S.crashAt = S.t + 6000; note('up', 'ws-2 снова в строю, но пустой: старые клиенты уже сидят на других экземплярах. Новые соединения будут попадать на него.', '', 0); }
      }
      function deployStep() {
        if (S.scn !== 'deploy' || NS() < 2) return;
        const d = S.dep;
        if (!d && S.t >= S.depAt) { const i = (S.depN || 0) % NS(); S.depN = (S.depN || 0) + 1; S.dep = { i, ph: 'drain', t0: S.t }; note('dp0', `<b>Выкатка: ws-${i + 1} перестаёт принимать новые соединения</b> и шлёт клиентам close 1012 (Service Restart). Они переподключаются к остальным экземплярам.`, '', 0); return; }
        if (!d) return;
        if (d.ph === 'drain') {
          S.cli.forEach(c => { if (c.inst === d.i && c.st === 'on' && Math.random() < 0.06) { c.st = 'off'; c.offAt = S.t; c.back = 400 + Math.random() * 900; } });
          S.cli.forEach(c => { if (c.st === 'off' && S.t - c.offAt > c.back) { const others = Array.from({ length: NS() }, (_, i) => i).filter(i => i !== d.i); c.inst = others[c.k % others.length]; c.st = 'on'; } });
          S.loadW[d.i] = Math.max(0, S.loadW[d.i] - 0.02);
          if (!S.cli.some(c => c.inst === d.i) && S.cli.every(c => c.st === 'on')) { d.ph = 'restart'; d.t0 = S.t; S.instDown[d.i] = true; }
        } else if (d.ph === 'restart' && S.t - d.t0 > 1500) {
          S.instDown[d.i] = false; d.ph = 'after'; d.t0 = S.t; S.loadW[d.i] = 0.05;
          for (let j = 0; j < NS(); j++) if (j !== d.i) S.loadW[j] = 1 + 1 / (NS() - 1);
          S.flags.skew = 1; done('deploy');
          note('dp1', `<b>ws-${d.i + 1} перезапущен с новой версией — и он почти пустой.</b> Старые соединения уже сидят на других экземплярах и сами не вернутся. Балансировщик будет отдавать ему новые, и выровняется это не скоро.`, 'warn', 0);
        } else if (d.ph === 'after') {
          S.loadW[d.i] = Math.min(1, S.loadW[d.i] + 0.0015);
          if (S.t - d.t0 > 9000) { S.dep = null; S.depAt = S.t + 3000; S.loadW = Array(NS()).fill(1); }
        }
      }
      function surgeStep() {
        const over = totalConns() > capAll();
        if (over && Math.random() < 0.05) { S.rejT.push(S.t); note('rej', `<b>Новые соединения отбиваются:</b> онлайн ${nf(totalConns())}, а ${N()} ${pl(N(), 'экземпляр держит', 'экземпляра держат', 'экземпляров держат')} не больше ${nf(capAll())}. Клиент получает 503 и пробует позже — сообщения к нему не приходят.`, 'bad', 5000); }
        if (S.scn === 'surge' && S.flags.over && !over && S.cfgT > 1500) done('surge');
        if (S.scn === 'surge' && over) S.flags.over = 1;
      }

      /* ---------- heartbeat ---------- */
      function hbStep() {
        const h = S.hb;
        if (S.t - h.t0 > 2400) { h.t0 = S.t; const c = S.cli[h.dead]; if (c.st === 'on' && c.tunnel) { h.miss++; if (h.miss >= 2) { c.st = 'off'; c.offAt = S.t; c.back = 3000; h.miss = 0; c.tunnel = false; S.flags.hbClose = 1; note('hb', `<b>Сервер закрыл соединение клиента #${h.dead}:</b> два ping подряд без pong — телефон в тоннеле. Память и дескриптор освобождены; клиент переподключится, когда вернётся сеть.`, 'warn', 6000); } } }
        if (!S.cli[h.dead].tunnel && S.cli[h.dead].st === 'on' && Math.random() < 0.002) S.cli[h.dead].tunnel = true;
        S.cli.forEach(c => { if (c.st === 'off' && !c.name && S.t - c.offAt > c.back && S.scn !== 'crash' && S.scn !== 'deploy') c.st = 'on'; });
      }

      /* ---------- отрисовка ---------- */
      function badges() {
        const bs = [['conn', 'СОЕДИНЕНИЕ', 'Upgrade → 101'], ['pubsub', 'PUB/SUB', hasPub() ? `через ${cut(ctx.nm(nbr().pub.id), 16)}` : 'нет — сообщения теряются'], ['reconnect', 'ДОГОН', 'after = last_id'], ['sticky', 'БАЛАНСИРОВКА', 'соединение живёт часами']];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xwz-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xwz-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xwz-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s' + (k === 'pubsub' && !hasPub() ? ' xwz-bad' : ''))}</g>`; });
        return s;
      }
      function clientsSvg() {
        let s = `<g class="xr-part" data-xpart="conn">${R(CL.x, CL.y, CL.w, CL.h, 'xr-zone', 12)}${T(CL.x + 10, CL.y + 18, 'КЛИЕНТЫ', 'xr-m')}${T(CL.x + CL.w - 10, CL.y + 18, `онлайн ${nf(totalConns())}`, 'xwz-ms', 'end')}`;
        S.cli.forEach(c => {
          const [x, y] = cliPt(c), off = c.st !== 'on';
          s += `<rect class="xwz-phone${off ? ' off' : ''}${c.tunnel ? ' tun' : ''}" x="${f1(x - 7)}" y="${f1(y - 11)}" width="14" height="22" rx="3" style="${off ? '' : `stroke:${col(c.inst)}`}"/>`;
          if (!off) s += `<circle cx="${f1(x)}" cy="${f1(y + 6)}" r="2.2" style="fill:${col(c.inst)}"/>`;
          if (c.name) s += T(x, y + 24, c.name, 'xwz-nm' + (off ? ' off' : ''), 'middle');
        });
        s += T(CL.x + 10, CL.y + CL.h - 22, `на картинке 30 из ${nf(totalConns())}`, 'xwz-ms') + T(CL.x + 10, CL.y + CL.h - 8, 'цвет рамки — экземпляр шлюза', 'xwz-ms');
        return s + '</g>';
      }
      function lbSvg() {
        let s = `<g class="xr-part" data-xpart="sticky">${R(LB.x, LB.y, LB.w, LB.h, 'xr-box', 10)}`;
        s += `<text class="xwz-vtext" x="${LB.x + LB.w / 2 + 4}" y="${LB.y + LB.h / 2}" text-anchor="middle" transform="rotate(-90 ${LB.x + LB.w / 2 + 4} ${LB.y + LB.h / 2})">балансировщик L4 · соединение закреплено за экземпляром</text>`;
        return s + '</g>';
      }
      function instSvg() {
        const ns = NS(), tot = totalConns(), wsum = S.loadW.reduce((a, b, i) => a + (S.instDown[i] ? 0 : b), 0) || 1;
        let s = `<g class="xr-part" data-xpart="limit">${R(IN.x, IN.y, IN.w, IN.h, 'xr-zone', 12)}${T(IN.x + 10, IN.y + 18, `ЭКЗЕМПЛЯРЫ · ${N()}`, 'xr-m acc')}${T(IN.x + IN.w - 10, IN.y + 18, `предел ${nf(PER_CONN)} на каждом`, 'xwz-ms', 'end')}`;
        for (let i = 0; i < ns; i++) {
          const y = instY(i), h = instH(), down = S.instDown[i], conns = down ? 0 : tot / N() * (S.loadW[i] / (wsum / ns)), f = conns / PER_CONN, drain = S.dep && S.dep.i === i && S.dep.ph === 'drain';
          s += R(IN.x + 8, y, IN.w - 16, h, 'xwz-inst' + (down ? ' down' : f > 1 ? ' over' : drain ? ' drain' : ''), 8) + `<rect x="${IN.x + 8}" y="${f1(y)}" width="5" height="${f1(h)}" rx="2" style="fill:${col(i)}"/>`;
          s += T(IN.x + 20, y + 15, `ws-${i + 1}`, 'xwz-fn') + T(IN.x + 66, y + 15, down ? (S.dep && S.dep.i === i ? 'перезапуск…' : 'упал') : drain ? 'не принимает новых, отдаёт клиентов' : f > 1 ? `${nf(PER_CONN)} — полон` : `${nf(conns)} соединений`, 'xwz-ms' + (down ? ' xwz-bad' : f > 1 ? ' xwz-bad' : drain ? ' xwz-warn' : ''));
          if (h > 34) { s += R(IN.x + 20, y + h - 13, IN.w - 44, 6, 'xr-bar', 3) + R(IN.x + 20, y + h - 13, (IN.w - 44) * clamp(f, 0, 1), 6, 'xr-bar-f' + (f > 1 ? ' bad' : f > 0.8 ? ' warn' : ''), 3); }
          const mm = members().filter(c => c.inst === i && c.st === 'on').map(c => c.name);
          if (mm.length && h > 26) s += T(IN.x + IN.w - 14, y + 15, ES(cut(mm.join(', '), 18)), 'xwz-ms xwz-acc', 'end');
        }
        if (N() > ns) s += T(IN.x + 10, IN.y + IN.h - 4, `+ ещё ${N() - ns} ${pl(N() - ns, 'экземпляр', 'экземпляра', 'экземпляров')}`, 'xwz-ms');
        return s + '</g>';
      }
      function brokerSvg() {
        const b = BR, p = nbr().pub, on = hasPub(), sb = subs(), go = p && ctx.canGo(p.id);
        let s = `<g class="xr-part" data-xpart="pubsub">${R(b.x, b.y, b.w, b.h, 'xr-box' + (on ? '' : ' bad'), 12)}`;
        s += T(b.x + 10, b.y + 20, on ? ES(cut(ctx.nm(p.id), 20)) : 'PUB/SUB НЕТ', 'xr-t' + (on ? '' : ' xwz-bad'));
        if (on) {
          s += T(b.x + 10, b.y + 40, 'канал', 'xwz-ms') + MONO(b.x + 54, b.y + 40, 'chat:7001', 'on');
          s += T(b.x + 10, b.y + 62, 'подписаны экземпляры:', 'xwz-ms');
          sb.forEach((i, j) => { const sx = b.x + 10 + (j % 4) * 41, sy = b.y + 70 + Math.floor(j / 4) * 24; s += R(sx, sy, 37, 20, 'xwz-sub', 5) + `<rect x="${sx}" y="${sy}" width="4" height="20" rx="2" style="fill:${col(i)}"/>` + T(sx + 21, sy + 14, `ws-${i + 1}`, 'xwz-pn', 'middle'); });
          s += T(b.x + 10, b.y + 136, 'сообщение приходит в канал —', 'xwz-ms') + T(b.x + 10, b.y + 152, 'брокер копирует его каждому', 'xwz-ms') + T(b.x + 10, b.y + 168, 'подписанному экземпляру', 'xwz-ms');
        } else s += T(b.x + 10, b.y + 44, S.scn === 'nopub' ? 'ситуация: брокера будто нет' : 'на схеме нет очереди или кэша', 'xwz-ms') + T(b.x + 10, b.y + 62, 'экземпляр знает только', 'xwz-ms') + T(b.x + 10, b.y + 78, 'своих клиентов', 'xwz-ms');
        if (go && on) s += T(b.x + 10, b.y + b.h - 10, 'клик — внутрь ›', 'xwz-ms xwz-go');
        s += '</g>';
        return go && on ? `<g class="xr-go" data-xgo="${p.id}">${s}</g>` : s;
      }
      function dbSvg() {
        const b = DB, d = nbr().db, go = d && ctx.canGo(d.id);
        let s = `<g${go ? ` class="xr-go" data-xgo="${d.id}"` : ''}>${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 10, b.y + 20, ES(cut(d ? ctx.nm(d.id) : 'История', 20)), 'xr-t')}`;
        s += T(b.x + 10, b.y + 38, 'messages: chat_id, id', 'xwz-pn');
        S.hist.slice(-4).forEach((h, j) => { s += T(b.x + 10, b.y + 58 + j * 17, `${h.id} · ${ES(cut(h.a, 6))}: ${ES(cut(h.x, 12))}`, 'xwz-ms'); });
        if (go) s += T(b.x + b.w - 10, b.y + b.h - 8, 'внутрь ›', 'xwz-ms xwz-go', 'end');
        return s + '</g>';
      }
      function chatSvg() {
        const b = CH;
        let s = `<g class="xr-part" data-xpart="reconnect">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 10, b.y + 20, 'ЧАТ 7001 «Семья»', 'xr-m')}`;
        S.hist.slice(-6).forEach((h, j) => { const y = b.y + 44 + j * 38, fl = S.msgs.some(m => m.id === h.id && S.t - m.t0 < 1500); if (fl) s += R(b.x + 6, y - 14, b.w - 12, 34, 'xwz-krow', 5); s += T(b.x + 12, y, `${h.id} · ${ES(h.a)}`, 'xwz-fn') + T(b.x + 12, y + 15, ES(cut(h.x, 26)), 'xwz-ms'); });
        const r = S.resumes[S.resumes.length - 1];
        if (r && S.t - r.t < 5000) s += R(b.x + 6, b.y + b.h - 66, b.w - 12, 58, 'xwz-resume', 6) + MONO(b.x + 12, b.y + b.h - 48, `resume after=${r.after}`, 'on') + T(b.x + 12, b.y + b.h - 30, `${r.name} → ws-${r.inst + 1}`, 'xwz-ms') + T(b.x + 12, b.y + b.h - 14, `догнали ${r.n} из истории`, 'xwz-ms xwz-ok');
        else s += T(b.x + 10, b.y + b.h - 12, 'у каждого клиента — last_id', 'xwz-ms');
        return s + '</g>';
      }
      function logSvg() {
        const b = LG;
        let s = R(b.x, b.y, b.w, b.h, 'xr-box', 10) + T(b.x + 12, b.y + 18, 'ДОСТАВКА СООБЩЕНИЙ', 'xr-m') + T(b.x + b.w - 12, b.y + 18, hasPub() ? 'через pub/sub на все экземпляры с участниками' : 'без pub/sub — только свой экземпляр', 'xwz-ms' + (hasPub() ? '' : ' xwz-bad'), 'end');
        S.log.forEach((l, j) => {
          const y = b.y + 42 + j * 22;
          s += T(b.x + 12, y, `#${l.id} ${ES(l.a)} (ws-${l.i + 1}) →`, 'xwz-fn') + T(b.x + 170, y, l.ok.length ? '✓ ' + l.ok.join(', ') : '', 'xwz-ms xwz-ok') + T(b.x + 380, y, l.lost.length ? '✕ ' + l.lost.join(', ') : l.off.length ? `нет в сети: ${l.off.join(', ')}` : '', 'xwz-ms' + (l.lost.length ? ' xwz-bad' : ''));
        });
        if (!S.log.length) s += T(b.x + 12, b.y + 44, 'ждём первое сообщение…', 'xr-s');
        return s;
      }
      function hbSvg() {
        const b = HB, h = S.hb, c = S.cli[h.dead], k = (S.t - h.t0) / 2400;
        let s = `<g class="xr-part" data-xpart="heartbeat">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}${T(b.x + 12, b.y + 18, 'HEARTBEAT · PING / PONG', 'xr-m')}${T(b.x + b.w - 12, b.y + 18, 'раз в 25 с (в модели 2,4 с)', 'xwz-ms', 'end')}`;
        const rows = [[S.cli[1], 'Борис'], [c, `клиент #${h.dead}${c.tunnel ? ' — в тоннеле' : ''}`]];
        rows.forEach(([cc, nm], j) => {
          const y = b.y + 48 + j * 36, dead = cc.tunnel, off = cc.st !== 'on';
          s += T(b.x + 12, y + 4, ES(nm), 'xwz-ms' + (dead ? ' xwz-warn' : '')) + (off ? '' : Ln(b.x + 150, y, b.x + b.w - 20, y, 'xwz-hbl'));
          if (!off) { const x = b.x + 150 + (b.w - 170) * clamp(k * 2, 0, 1), back = k > 0.5; s += Dot(back ? b.x + b.w - 20 - (b.w - 170) * clamp((k - 0.5) * 2, 0, 1) : x, y, 4, '', dead && back ? 'fill:var(--bad);opacity:.3' : back ? 'fill:var(--ok)' : 'fill:var(--accent)') + T(b.x + b.w - 20, y - 8, back ? (dead ? 'pong нет' : 'pong') : 'ping', 'xwz-pn' + (dead && back ? ' xwz-bad' : ''), 'end'); }
          else s += T(b.x + 150, y + 4, 'соединение закрыто — ждёт сеть', 'xwz-ms xwz-bad');
        });
        s += T(b.x + 12, b.y + b.h - 26, `пропусков pong подряд: ${h.miss} из 2 · после 2 сервер закрывает сокет`, 'xwz-ms' + (h.miss ? ' xwz-warn' : ''));
        s += T(b.x + 12, b.y + b.h - 10, 'без heartbeat мёртвые соединения копятся до предела экземпляра', 'xwz-ms');
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const mc = SD.kindColor('msg');
        S.msgs.forEach(m => {
          const u = S.t - m.t0, fromC = cliPt(m.from), fi = m.from.inst, ip = instPt(fi, 'l'), ipr = instPt(fi, 'r'), bp = [BR.x, BR.y + 80];
          if (m.ph === 'up') s += Dot(...lerp(fromC, ip, ease(u / 500)), 5, '', `fill:${mc}`);
          if (m.ph === 'pub') { const k = (S.t - m.t1) / (hasPub() ? 700 : 300); if (hasPub()) { s += Dot(...lerp(ipr, bp, ease(k)), 5, '', `fill:${mc}`); s += Dot(...lerp(ipr, [DB.x, DB.y + 40], ease(k)), 3.5, '', 'fill:var(--k-write)'); } else s += T(ipr[0] - 30, ipr[1] - 10, 'только своим', 'xr-pop warn', 'middle'); }
          if (m.ph === 'fan') {
            const k = (S.t - m.t2) / 1400;
            if (hasPub()) subs().forEach(i => { if (k < 0.45) s += Dot(...lerp(bp, instPt(i, 'r'), ease(k / 0.45)), 4, '', 'fill:var(--accent)'); });
            m.deliv.forEach(d => {
              if (k < 0.4) return;
              const kk = (k - 0.4) / 0.6, from = instPt(d.c.inst, 'l'), to = cliPt(d.c);
              if (d.ok) { if (kk < 1) s += Dot(...lerp(from, to, ease(kk)), 3.8, 'ok'); else if (kk < 1.3) s += `<circle class="xwz-flash" cx="${f1(to[0])}" cy="${f1(to[1])}" r="12"/>`; }
              else if (!d.gone && kk < 1.2) s += T(to[0], to[1] - 16, '✕', 'xr-pop bad', 'middle');
            });
          }
        });
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() { gSt.innerHTML = badges() + clientsSvg() + lbSvg() + instSvg() + brokerSvg() + dbSvg() + chatSvg() + logSvg() + hbSvg(); gDy.innerHTML = dynSvg(); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 128, 26, 'xwz-backb', 13)}${T(76, 27, '← весь шлюз', 'xr-s xwz-back', 'middle')}</g>` + T(156, 27, t, 'xwz-vt') + T(156, 46, sub, 'xr-s');
      function seq(x1, x2, y0, names, steps, cyc) {
        const ST = 900, n = steps.length, len = n * ST + 2000, u = cyc % len, cur = Math.floor(u / ST), f = (u % ST) / ST, dy = 30;
        let s = R(x1 - 80, y0, 160, 30, 'xr-box', 8) + T(x1, y0 + 20, names[0], 'xr-t', 'middle') + R(x2 - 80, y0, 160, 30, 'xr-box', 8) + T(x2, y0 + 20, names[1], 'xr-t', 'middle');
        s += Ln(x1, y0 + 30, x1, y0 + 44 + n * dy, 'xwz-life') + Ln(x2, y0 + 30, x2, y0 + 44 + n * dy, 'xwz-life');
        steps.forEach((st, i) => {
          const y = y0 + 56 + i * dy, state = i < cur ? 'past' : i === cur ? 'now' : 'fut', a = st.r ? x2 : x1, b = st.r ? x1 : x2, k = state === 'now' ? Math.min(1, f * 1.4) : 1;
          s += arrow(a, y, a + (b - a) * k, y, `${st.c || ''} ${state}`) + `<text class="xwz-sl ${state}${st.c ? ' xwz-' + st.c : ''}" xml:space="preserve" x="${f1((x1 + x2) / 2)}" y="${f1(y - 7)}" text-anchor="middle">${ES(st.t)}</text>`;
        });
        return { s, cur };
      }
      function vConn() {
        const steps = [{ t: 'GET /ws?v=5  Upgrade: websocket  Sec-WebSocket-Key: dGhlIHNh…' }, { t: '101 Switching Protocols  Sec-WebSocket-Accept: s3pPLMBi…', r: 1, c: 'ok' }, { t: '{"op":"auth","token":"eyJhbGciOi…"}' }, { t: '{"op":"ok","user":55120}', r: 1, c: 'ok' }, { t: '{"op":"sub","chats":[7001,1550]}' }, { t: '{"op":"msg","chat":7001,"id":1044,"from":"Борис","text":"Я!"}', r: 1, c: 'acc' }, { t: '{"op":"send","chat":7001,"text":"В 7 у подъезда"}' }, { t: 'ping', r: 1 }, { t: 'pong' }];
        const q = seq(250, 760, 60, ['Телефон Ани', 'ws-1'], steps, S.vt);
        if (q.cur >= 1) S.pv.s101 = 1;
        let s = head('Соединение WebSocket', 'один HTTP-запрос «переключиться» — и дальше по тому же TCP-соединению ходят кадры в обе стороны');
        s += q.s;
        s += R(24, 400, 470, 148, 'xwz-panel', 10) + T(36, 422, 'КАДР (FRAME)', 'xr-m');
        [['FIN · opcode', '1 · 0x1 (текст), 0x2 (бинарный), 0x9 ping, 0xA pong, 0x8 close'], ['длина', '7 бит, 16 или 64 бита'], ['маска', 'от клиента к серверу — обязательна'], ['данные', 'наш JSON: {"op":"msg", …}']].forEach(([a, b2], j) => { s += T(36, 448 + j * 24, a, 'xwz-fn') + T(150, 448 + j * 24, b2, 'xwz-ms'); });
        s += R(506, 400, 470, 148, 'xwz-panel', 10) + T(518, 422, 'ЦЕНА ОТКРЫТОГО СОЕДИНЕНИЯ', 'xr-m');
        ['память: буферы чтения и записи, подписки — 10–50 КБ', 'файловый дескриптор: ulimit -n до 1 000 000', 'ничего не передаётся — почти ничего не стоит по CPU', 'поэтому предел — ≈ 100 000 соединений на экземпляр'].forEach((l, j) => { s += T(518, 448 + j * 24, '· ' + l, 'xr-s'); });
        return s;
      }
      function vPubsub() {
        const C = 6500, u = S.vt % C, k0 = clamp(u / 600, 0, 1), k1 = clamp((u - 700) / 800, 0, 1), k2 = clamp((u - 1600) / 1000, 0, 1), k3 = clamp((u - 2700) / 1200, 0, 1);
        let s = head('Pub/Sub между экземплярами', 'Аня на ws-1, Борис и Вера на ws-2, Гоша на ws-3, Дина на ws-4 — как сообщение Ани найдёт их всех?');
        const IY = [120, 220, 320, 420], IX0 = 220, IX1 = 380, BX = 510, BY = 270, mc = SD.kindColor('msg');
        const who = [['Аня'], ['Борис', 'Вера'], ['Гоша'], ['Дина']];
        const memPt = (i, j) => [104, IY[i] + (who[i].length > 1 ? (j ? 14 : -14) : 0)];
        s += T(104, 76, 'участники чата', 'xwz-ms', 'middle') + T((IX0 + IX1) / 2, 76, 'экземпляры шлюза', 'xwz-ms', 'middle') + T(BX, 76, 'брокер', 'xwz-ms', 'middle');
        IY.forEach((y, i) => {
          s += Ln(IX1, y, BX - 80, BY, 'xwz-subl');
          who[i].forEach((n, j) => { const [cx, cy] = memPt(i, j); s += Ln(IX0, y, cx + 36, cy, 'xwz-fanl'); });
          s += R(IX0, y - 30, IX1 - IX0, 60, 'xwz-inst', 8) + `<rect x="${IX0}" y="${y - 30}" width="5" height="60" rx="2" style="fill:${col(i)}"/>` + T(IX0 + 16, y - 8, `ws-${i + 1}`, 'xwz-fn') + T(IX0 + 16, y + 12, 'SUBSCRIBE chat:7001', 'xwz-pn');
          who[i].forEach((n, j) => { const [cx, cy] = memPt(i, j), src = n === 'Аня'; s += R(cx - 36, cy - 11, 72, 22, 'xwz-mem' + (src ? ' src' : k3 >= 1 ? ' got' : ''), 6) + T(cx, cy + 4, n, 'xwz-pn', 'middle'); });
        });
        s += T(104, IY[0] - 22, 'пишет', 'xwz-ms xwz-acc', 'middle');
        s += R(BX - 80, BY - 50, 160, 100, 'xwz-panel on', 12) + T(BX, BY - 24, 'брокер', 'xr-t', 'middle') + MONO(BX, BY - 2, 'PUBLISH chat:7001', 'on', 'middle') + T(BX, BY + 22, '4 подписчика', 'xwz-ms', 'middle');
        if (k0 > 0 && k0 < 1) s += Dot(...lerp([140, IY[0]], [IX0, IY[0]], ease(k0)), 6, '', `fill:${mc}`);
        if (k1 > 0 && k1 < 1) s += Dot(...lerp([IX1, IY[0]], [BX - 80, BY], ease(k1)), 6, '', `fill:${mc}`);
        if (k2 > 0 && k2 < 1) IY.forEach(y => { s += Dot(...lerp([BX - 80, BY], [IX1, y], ease(k2)), 5, '', 'fill:var(--accent)'); });
        if (k3 > 0 && k3 < 1) IY.forEach((y, i) => who[i].forEach((n, j) => { if (n !== 'Аня') { const [cx, cy] = memPt(i, j); s += Dot(...lerp([IX0, y], [cx + 36, cy], ease(k3)), 4, 'ok'); } }));
        s += R(620, 80, 356, 300, 'xwz-codebg', 10) + T(632, 100, 'ЧТО ДЕЛАЕТ КАЖДЫЙ ЭКЗЕМПЛЯР', 'xr-m');
        ['// при подключении участника', 'redis.subscribe("chat:7001")', '', '// Аня отправила сообщение', 'id = db.insert(chat=7001, text) // 1044', 'redis.publish("chat:7001",', '  {id: 1044, from: "Аня", text})', '', '// пришло из канала', 'for (sock of localMembers(7001))', '  sock.send({op: "msg", id: 1044, …})'].forEach((l, j) => { s += MONO(632, 124 + j * 22, ES(l), l.startsWith('//') ? 'dim' : ''); });
        s += T(620, 410, 'Без брокера ws-1 доставит только своим — Аня', 'xr-s xwz-bad') + T(620, 430, 'увидит своё сообщение, остальные — нет.', 'xr-s xwz-bad');
        s += T(620, 460, 'Большой чат (100 000 участников) — веер на все', 'xwz-ms') + T(620, 478, 'экземпляры: брокер и сеть — узкое место.', 'xwz-ms');
        s += T(620, 506, 'Подписки по чатам, а не по пользователям:', 'xwz-ms') + T(620, 524, 'один канал на экземпляр, а не на сокет.', 'xwz-ms');
        return s;
      }
      function vHeartbeat() {
        const C = 12000, u = S.vt % C, X = t => 160 + t / 12000 * 780, beats = [0, 2400, 4800, 7200, 9600];
        let s = head('Heartbeat: ping, pong и мёртвые соединения', 'телефон в тоннеле не говорит «пока» — соединение надо распознать как мёртвое');
        const lane = (y, title, deadFrom) => {
          let t = R(24, y, 952, 150, 'xwz-panel', 10) + T(36, y + 22, title, 'xr-t') + Ln(X(0), y + 80, X(12000), y + 80, 'xwz-hbl');
          let miss = 0, closed = -1;
          beats.forEach(b => {
            if (b > u || (closed >= 0 && b >= closed)) return;
            const dead = deadFrom != null && b >= deadFrom;
            t += Ln(X(b), y + 50, X(b), y + 80, 'xwz-tickl') + T(X(b), y + 46, 'ping', 'xwz-pn', 'middle');
            if (!dead) t += Ln(X(b + 300), y + 80, X(b + 300), y + 110, 'xwz-tickl ok') + T(X(b + 300), y + 124, 'pong', 'xwz-pn xwz-ok', 'middle');
            else { miss++; t += T(X(b + 300), y + 124, '…нет', 'xwz-pn xwz-bad', 'middle'); if (miss >= 2 && closed < 0) closed = b + 600; }
          });
          if (closed >= 0 && u > closed) { t += R(X(closed), y + 66, 120, 28, 'xwz-close', 6) + T(X(closed) + 60, y + 85, 'close: таймаут', 'xwz-pn xwz-bad', 'middle'); if (deadFrom != null) S.pv.hbClosed = 1; }
          if (deadFrom != null) t += R(X(deadFrom), y + 132, X(12000) - X(deadFrom), 8, 'xwz-tunnel', 3) + T(X(deadFrom), y + 22, '▼ с этого момента телефон в тоннеле', 'xwz-ms xwz-warn');
          return t;
        };
        s += lane(60, 'Борис: связь в порядке', null);
        s += lane(222, 'Клиент #25: тоннель, сеть пропала молча', 3500);
        s += R(24, 384, 952, 164, 'xwz-panel', 10) + T(36, 406, 'ЗАЧЕМ И КАК', 'xr-m');
        ['· без ping сервер не узнает, что клиента нет: соединение «висит», занимает память и место в пределе экземпляра', '· два ping без pong подряд → сервер закрывает сокет; клиент без ping 60 с → сам переподключается', '· ping держит соединение «живым» для NAT и прокси, которые рвут молчащие соединения через 60–120 с', '· частота — компромисс: чаще — быстрее замечаем обрыв, реже — меньше трафика и разряда батареи', '· в модели 25 с сжаты до 2,4 с'].forEach((l, j) => { s += T(36, 432 + j * 22, l, 'xr-s'); });
        return s;
      }
      function vReconnect() {
        const C = 13000, u = S.vt % C;
        let s = head('Переподключение и догон пропущенного', 'обрыв → пауза с разбросом → любой живой экземпляр → «пришли всё после 1043»');
        const steps = [[0, 'обрыв', 'ws-2 упал, сокет закрыт', 'bad'], [1500, 'пауза 1 с + jitter', 'не все клиенты разом', 'warn'], [3500, 'новое соединение', 'балансировщик → ws-3', ''], [5000, 'resume after=1043', 'last_id из памяти клиента', 'acc'], [6500, 'догон из истории', '1044, 1045, 1046 из базы', 'ok'], [8500, 'в реальном времени', 'подписка на chat:7001', 'ok']];
        steps.forEach(([t, a, b2, c], j) => { const on = u >= t, x = 24 + j * 160; s += R(x, 70, 150, 80, 'xwz-panel' + (on ? (c === 'bad' ? ' badb' : ' on') : ''), 10) + T(x + 10, 94, a, 'xwz-fn' + (on ? '' : ' dim')) + T(x + 10, 114, b2, 'xwz-ms'); if (j < 5) s += arrow(x + 150, 110, x + 160, 110, on ? 'acc' : ''); });
        // гром стада
        s += R(24, 166, 952, 190, 'xwz-panel', 10) + T(36, 188, 'ПЕРЕПОДКЛЮЧЕНИЯ 80 000 КЛИЕНТОВ УПАВШЕГО ЭКЗЕМПЛЯРА ПО СЕКУНДАМ', 'xr-m');
        const bars = (y, title, f, c) => { let t = T(36, y + 30, title, 'xwz-ms'); for (let i = 0; i < 20; i++) { const v = f(i), h = 60 * v; t += R(220 + i * 36, y + 60 - h, 28, h, 'xwz-rc ' + c, 3); } return t; };
        s += bars(196, 'без jitter: все в первую секунду', i => i === 0 ? 1 : 0, 'bad') + bars(272, 'с паузой и jitter: волна размазана', i => Math.exp(-i / 4) * (1 - Math.exp(-(i + 1))) * 1.3, 'ok');
        s += R(24, 368, 952, 180, 'xwz-codebg', 10);
        ['// клиент', 'let lastId = {7001: 1043}, attempt = 0', 'ws.onclose = () => {', '  const delay = Math.min(30000, 1000 * 2 ** attempt++) * (0.5 + Math.random())', '  setTimeout(connect, delay)', '}', 'ws.onopen = () => { attempt = 0; ws.send({op: "resume", chat: 7001, after: lastId[7001]}) }', 'ws.onmessage = m => { lastId[m.chat] = Math.max(lastId[m.chat], m.id); render(m) }'].forEach((l, j) => { s += MONO(36, 390 + j * 20, ES(l), l.startsWith('//') ? 'dim' : ''); });
        return s;
      }
      function vSticky() {
        const C = 14000, u = S.vt % C, ph = u < 3000 ? 0 : u < 7000 ? 1 : u < 8500 ? 2 : 3;
        let s = head('Балансировка долгих соединений', 'балансировщик решает только при подключении; дальше соединение часами живёт на одном экземпляре');
        const base = [60, 60, 60, 60], k = clamp((u - 3000) / 4000, 0, 1);
        const load = ph === 0 ? base : ph === 1 ? [60 * (1 - k), 60 + 20 * k, 60 + 20 * k, 60 + 20 * k] : ph === 2 ? [0, 80, 80, 80] : [Math.min(60, 2 + (u - 8500) / 5500 * 12), 80 - (u - 8500) / 5500 * 2, 79 - (u - 8500) / 5500 * 2, 80 - (u - 8500) / 5500 * 1];
        load.forEach((v, i) => { const x = 60 + i * 230, h = v * 2; s += R(x, 360 - h, 160, h, 'xwz-bar' + (i === 0 && ph >= 1 ? ' hl' : ''), 6) + T(x + 80, 380, `ws-${i + 1}`, 'xwz-fn', 'middle') + T(x + 80, 352 - h, `${nf(v)}k`, 'xr-m', 'middle'); });
        s += Ln(40, 160, 960, 160, 'xwz-capl') + T(960, 154, 'предел 100k на экземпляр', 'xwz-ms xwz-bad', 'end');
        const msg = ['все экземпляры ровно загружены', 'ws-1 на выкатке: шлёт close 1012, клиенты уходят на остальные', 'ws-1 перезапускается с новой версией', 'ws-1 вернулся пустым: старые соединения не вернутся сами'][ph];
        s += T(60, 100, msg, 'xr-t' + (ph === 3 ? ' xwz-warn' : ''));
        if (ph === 3) { S.pv.skew = 1; s += T(60, 124, 'новые соединения балансировщик отдаёт ws-1 (наименьшее число соединений) — выравнивание займёт часы', 'xwz-ms'); }
        s += R(24, 400, 952, 148, 'xwz-panel', 10) + T(36, 422, 'КАК С ЭТИМ ЖИВУТ', 'xr-m');
        ['· балансировщик L4 или L7 с поддержкой Upgrade: алгоритм least connections для новых соединений', '· выкатка по одному экземпляру: перестать принимать новые → close 1012 → дождаться ухода → перезапуск', '· клиенты переподключаются с jitter, иначе остальные экземпляры получают удар разом', '· перекос после выкатки — норма; иногда сервер сам просит часть клиентов переподключиться, чтобы выровнять'].forEach((l, j) => { s += T(36, 448 + j * 24, l, 'xr-s'); });
        return s;
      }
      function vLimit() {
        const tot = totalConns(), n = N(), need = Math.ceil(tot / PER_CONN), per = tot / n;
        let s = head('Предел соединений на экземпляр', `сейчас онлайн ${nf(tot)}, экземпляров ${n} → по ${nf(per)} на каждом (предел ${nf(PER_CONN)})`);
        s += R(24, 60, 952, 214, 'xwz-panel', 10) + T(36, 82, 'ЭКЗЕМПЛЯРЫ И ИХ ЗАПОЛНЕНИЕ', 'xr-m');
        const shown = Math.min(n, 20), w = (920 - (shown - 1) * 6) / shown;
        for (let i = 0; i < shown; i++) { const f = per / PER_CONN, x = 40 + i * (w + 6), h = 130 * clamp(f, 0, 1.2); s += R(x, 240 - 130, w, 130, 'xwz-slot', 4) + R(x, 240 - h, w, h, 'xwz-fill' + (f > 1 ? ' over' : f > 0.8 ? ' warn' : ''), 4); }
        s += Ln(40, 110, 960, 110, 'xwz-capl') + T(960, 104, '100 000', 'xwz-ms xwz-bad', 'end');
        s += T(36, 262, n >= need ? `хватает: нужно минимум ${need}, есть ${n}${n >= need + 1 ? ' — и запас на падение одного' : ' — но падение одного уже не переживём'}` : `не хватает: нужно минимум ${need}, есть ${n} — ${nf(tot - n * PER_CONN)} соединений отбиваются`, 'xr-s ' + (n > need ? 'xwz-ok' : n === need ? 'xwz-warn' : 'xwz-bad'));
        s += R(24, 284, 470, 264, 'xwz-panel', 10) + T(36, 306, 'ИЗ ЧЕГО СКЛАДЫВАЕТСЯ ПРЕДЕЛ', 'xr-m');
        [['память', '≈ 20–50 КБ × 100 000 ≈ 2–5 ГБ'], ['дескрипторы', 'ulimit -n 1 000 000'], ['порты', '≈ 64 000 на пару IP — нужно несколько'], ['сообщения', '≈ 20 000 в секунду на экземпляр'], ['пик', 'вечер буднего дня ×2–3 от среднего']].forEach(([a, b2], j) => { s += T(36, 334 + j * 40, a, 'xwz-fn') + T(150, 334 + j * 40, b2, 'xr-s'); });
        s += R(506, 284, 470, 264, 'xwz-codebg', 10) + T(518, 306, 'СЧИТАЕМ ДЛЯ «МЕССЕНДЖЕРА»', 'xr-m');
        [`онлайн в пик:          ${nf(tot)}`, `на экземпляр:          ${nf(PER_CONN)}`, `минимум экземпляров:   ${need}`, `+1 на падение:         ${need + 1}`, `сообщений в секунду:   ${nf((L().traffic || {}).msg || 40000)}`, `на экземпляр:          ${nf(((L().traffic || {}).msg || 40000) / n)} (предел 20 000)`].forEach((l, j) => { s += MONO(518, 336 + j * 30, ES(l), j === 3 ? 'on' : ''); });
        return s;
      }
      const VIEWS = { conn: vConn, pubsub: vPubsub, heartbeat: vHeartbeat, reconnect: vReconnect, sticky: vSticky, limit: vLimit };
      function partNow(k) {
        if (k === 'conn') return '<b>WebSocket</b> начинается с HTTP-запроса Upgrade и ответа 101 Switching Protocols. Дальше по тому же соединению идут кадры в обе стороны: авторизация, подписка, сообщения, ping/pong.';
        if (k === 'pubsub') return '<b>Pub/Sub</b>: экземпляр Ани публикует сообщение в канал chat:7001, брокер копирует его всем подписанным экземплярам, а те — своим участникам чата.';
        if (k === 'heartbeat') return '<b>Heartbeat</b>: ping раз в 25 с; два ping без pong — сервер закрывает сокет и освобождает память. Иначе мёртвые соединения копятся.';
        if (k === 'reconnect') return '<b>Переподключение</b> с паузой и разбросом, затем resume after=last_id — сервер присылает пропущенное из истории, дальше всё идёт в реальном времени.';
        if (k === 'sticky') return '<b>Долгие соединения</b> не перераспределяются сами: балансировщик решает только при подключении. После выкатки перезапущенный экземпляр долго остаётся недогруженным.';
        if (k === 'limit') { const need = Math.ceil(totalConns() / PER_CONN); return `<b>Предел:</b> онлайн ${nf(totalConns())} / 100 000 на экземпляр = минимум ${need}, плюс один на падение. Сейчас экземпляров ${N()}.`; }
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.cli) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'heartbeat' && S.pv.hbClosed) done('phb'); if (pk === 'conn' && S.pv.s101) done('pcon'); }
        if (S.t >= S.msgAt) { S.msgAt = S.t + 1600 + Math.random() * 800; send(); }
        S.msgs.forEach(msgStep); S.msgs = S.msgs.filter(m => m.ph !== 'done' || S.t - m.t0 < 4000);
        crashStep(); deployStep(); surgeStep(); hbStep();
        S.ev = S.ev.filter(e => e.t > S.t - 10000); S.rejT = S.rejT.filter(t => t > S.t - 10000); S.fx = S.fx.filter(f => S.t - f.t0 < 1300);
      }
      function draw() {
        if (!S.cli) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { if (cfgSig() !== S.cfg) { const fl = S.flags; reset(); S.flags = fl; } },
        scenario(id) { const fl = S.flags; S.scn = id; reset(); S.flags = fl; },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (key === 'count') { const need = Math.ceil(totalConns() / PER_CONN); return +v >= need ? `Экземпляров ${v}: на каждом ≈ ${nf(totalConns() / +v)} соединений — в пределах ${nf(PER_CONN)}.` : `Экземпляров ${v}: на каждый пришлось бы ${nf(totalConns() / +v)} — больше предела, новые соединения отбиваются. Нужно хотя бы ${need}.`; }
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const tot = totalConns(), over = tot > capAll();
          if (S.scn === 'nopub' || !hasPub()) return `<b>Без pub/sub</b> экземпляр знает только своих клиентов: сообщение Ани с ws-1 видят только участники на ws-1, остальные — нет (красные крестики). ${S.scn === 'nopub' ? 'В жизни это лечат брокером: Redis Pub/Sub, NATS, Kafka.' : 'Соедини шлюз с очередью или кэшем на схеме.'}`;
          if (S.scn === 'crash') return S.crashed >= 0 ? '<b>ws-2 упал.</b> Его клиенты (серые) переподключаются с паузой и разбросом к живым экземплярам и присылают resume с номером последнего полученного сообщения — сервер досылает пропущенное из истории.' : '<b>Все экземпляры работают.</b> Скоро ws-2 упадёт — следи за его клиентами и за окном чата справа.';
          if (S.scn === 'surge') return over ? `<b>Наплыв: онлайн ${nf(tot)}, а ${N()} ${pl(N(), 'экземпляр держит', 'экземпляра держат', 'экземпляров держат')} не больше ${nf(capAll())}.</b> Новые соединения отбиваются — люди сидят без мгновенных сообщений. Нужно минимум ${Math.ceil(tot / PER_CONN)} экземпляров.` : `<b>Наплыв выдерживаем:</b> онлайн ${nf(tot)} при пределе ${nf(capAll())}. Хорошо бы держать ещё один экземпляр в запасе на падение.`;
          if (S.scn === 'deploy') { const d = S.dep; const w = d ? `ws-${d.i + 1}` : `ws-${(S.depN % NS()) + 1}`; return !d ? `<b>Скоро выкатка:</b> следующим перезапустится ${w}. Смотри на полоски соединений.` : d.ph === 'drain' ? `<b>${w} освобождается:</b> не принимает новых и просит клиентов переподключиться (close 1012). Они уходят на остальные экземпляры — у тех растёт число соединений.` : d.ph === 'restart' ? `<b>${w} перезапускается</b> с новой версией.` : `<b>${w} вернулся почти пустым.</b> Соединения долгие и сами не перераспределяются: перекос держится, пока клиенты не переподключатся по своим причинам.`; }
          return `<b>Сообщение идёт через брокер.</b> Клиент шлёт его по своему соединению на свой экземпляр; экземпляр сохраняет в историю, публикует в канал chat:7001, брокер рассылает всем экземплярам с участниками, они — своим клиентам. Онлайн ${nf(tot)} на ${N()} ${pl(N(), 'экземпляре', 'экземплярах', 'экземплярах')}.`;
        },
        stats() {
          const tot = totalConns(), per = tot / Math.max(1, N() - S.instDown.filter(Boolean).length), ok = S.ev.reduce((a, e) => a + e.ok, 0), lost = S.ev.reduce((a, e) => a + e.lost, 0);
          return [
            ['Соединений', nf(tot), tot > capAll() ? 'bad' : '', `${N()} × до 100k`],
            ['На экземпляр', nf(per), per > PER_CONN ? 'bad' : per > 0.8 * PER_CONN ? 'warn' : 'ok', per > PER_CONN ? 'просится; держит до 100 000' : 'предел 100 000'],
            ['Доставлено', ok + lost ? Math.round(ok / (ok + lost) * 100) + ' %' : '…', lost ? 'bad' : 'ok', 'участникам в сети, за 10 с'],
            ['Pub/Sub', hasPub() ? 'есть' : 'нет', hasPub() ? 'ok' : 'bad', hasPub() ? 'канал chat:7001' : 'только свой экземпляр'],
            ['Отказы', String(S.rejT.length), S.rejT.length ? 'bad' : 'ok', 'новых соединений за 10 с'],
            ['Догнали', String(S.resumes.reduce((a, r) => a + r.n, 0)), '', 'сообщений из истории']
          ];
        },
        destroy() {}
      };
    }
  };
})();
