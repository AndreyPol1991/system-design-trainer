/* «Провалиться внутрь»: брокер сообщений (партиции, группа потребителей, лаг, acks, семантика, DLQ)
   и обработчик (пачки, коммит offset, повторы, защита от дублей). */
(function () {
  SD.XRAY = SD.XRAY || {};
  const ENG = n => SD.ENGINES[(n && n.props.engine) || 'kafka'] || SD.ENGINES.kafka;
  const KJ = () => SD.kindColor('job');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => { const s = (Math.round(v * 10) / 10).toFixed(1); return (s.slice(-2) === '.0' ? s.slice(0, -2) : s).replace('.', ','); };
  const sec = ms => f1(Math.max(0, ms) / 1000) + ' с';
  const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const pl = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
  const hsh = k => (k * 37 + 11) % 101;           // учебный «хеш»: одинаковый ключ → одно и то же число
  const noun = () => { const l = ((SD.app.A.level || {}).job || {}).label || ''; return /просмотр|товар|статист/.test(l) ? 'товар' : 'заказ'; };
  const cnt10 = (ev, t, k) => ev.filter(e => e.t > t - 10000 && e.k === k).length;
  const gox = (ctx, id, inner) => id && ctx.canGo(id) ? `<g class="xr-go" data-xgo="${id}">${inner}</g>` : `<g>${inner}</g>`;
  const X1 = v => v.toFixed(1);
  const T = (x, y, str, cls, anc) => `<text class="${cls || 'xr-s'}" x="${X1(x)}" y="${X1(y)}"${anc ? ` text-anchor="${anc}"` : ''}>${str}</text>`;
  const R = (x, y, w, h, cls) => `<rect class="${cls || 'xr-box'}" x="${X1(x)}" y="${X1(y)}" width="${X1(w)}" height="${X1(h)}" rx="8"/>`;
  const KCOL = ['var(--k-read)', 'var(--k-search)', 'var(--k-geo)', 'var(--k-upload)', 'var(--k-write)', 'var(--k-events)'];
  const kcol = i => KCOL[((i % KCOL.length) + KCOL.length) % KCOL.length];
  const STEPS = ['создан', 'оплачен', 'собран', 'отправлен', 'доставлен'];
  const along = (pts, p) => {   // точка на ломаной: p от 0 до 1 по длине
    const seg = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])), tot = seg.reduce((s, v) => s + v, 0) || 1;
    let d = clamp(p, 0, 1) * tot;
    for (let i = 0; i < seg.length; i++) { if (d <= seg[i] || i === seg.length - 1) { const f = seg[i] ? Math.min(1, d / seg[i]) : 1; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; } d -= seg[i]; }
    return pts[pts.length - 1];
  };
  function drawFx(S) {
    const t = S.t;
    S.fx = S.fx.filter(f => t - f.born < (f.dur || 1300));
    return S.fx.slice(-16).map(f => {
      const p = (t - f.born) / (f.dur || 1300), a = X1(Math.max(0, 1 - p * p));
      if (f.k === 'x') return `<g style="opacity:${a}"><line class="xq-x" x1="${f.x - 6}" y1="${f.y - 6}" x2="${f.x + 6}" y2="${f.y + 6}"/><line class="xq-x" x1="${f.x + 6}" y1="${f.y - 6}" x2="${f.x - 6}" y2="${f.y + 6}"/></g>`;
      if (f.k === 'mv') { const q = Math.min(1, p * 1.6); return `<circle class="xr-dot" cx="${X1(f.x + (f.x2 - f.x) * q)}" cy="${X1(f.y + (f.y2 - f.y) * q)}" r="5" style="fill:${f.c}"/>`; }
      return `<text class="xr-pop ${f.cls || ''}" x="${X1(f.x)}" y="${X1(f.y - 12 * p)}" text-anchor="middle" style="opacity:${a}">${f.txt}</text>`;
    }).join('');
  }

  /* ================= брокер ================= */
  SD.XRAY.queue = {
    viewBox: '0 0 1000 500',
    cta: 'Партиции, группа потребителей, лаг, acks и DLQ — вживую',
    dive: 'queue',
    simple: n => ENG(n).cap === 'partitions'
      ? { an: 'Как <b>сортировочный цех с конвейерами</b>: посылку кладут на конвейер по номеру получателя, а в конце каждого конвейера стоит свой грузчик.', pl: 'Отправители кладут сообщения, брокер раскладывает их по дорожкам (партициям) и хранит. Обработчики забирают по порядку и в своём темпе. Пик просто копится на дорожках.' }
      : { an: 'Как <b>очередь в банке к нескольким окнам</b>: талончики в одной стопке, свободное окно берёт верхний.', pl: 'Отправитель кладёт сообщение и сразу свободен. Брокер хранит его, пока обработчик не скажет «готово» (ack), — тогда сообщение удаляется.' },
    props: ['engine', 'count', 'partitions', 'acks', 'semantics', 'retries'],
    parts: {
      log: {
        name: 'Журнал и offset',
        an: 'Как <b>бортовой журнал</b>: записи только дописываются в конец и нумеруются, а каждый читатель держит свою закладку.',
        pl: 'Партиция Kafka — это журнал. Новое сообщение встаёт в конец и получает номер — offset. После чтения оно не удаляется: группа просто передвигает свою закладку.',
        how: ['Продюсер присылает сообщение — брокер дописывает его <b>в конец</b> партиции.', 'Сообщение получает номер — <b>offset</b>. Номера идут подряд и не меняются.', 'Группа потребителей помнит свой offset — номер следующего непрочитанного.', '<b>Лаг</b> = конец журнала − offset группы: сколько ещё не прочитано.', 'Разные группы читают один журнал независимо, у каждой своя закладка.', 'Старое удаляет срок хранения (retention), а не чтение. Offset можно перемотать и перечитать.', 'В RabbitMQ и SQS иначе: сообщение удаляется после подтверждения (ack).'],
        watch: 'Новые брусочки появляются справа и получают номер. Два треугольника — две группы: первая читает в темпе записи, вторая то стоит, то догоняет. Её лаг растёт, но сообщения ждут её в журнале.',
        knobs: ['engine', 'partitions'],
        real: 'Kafka: retention.ms = 7 дней, сегменты по 1 ГБ. Offset группы хранится в служебном топике __consumer_offsets. Лаг смотрят через kafka-consumer-groups --describe, Burrow или Grafana.'
      },
      key: {
        name: 'Выбор партиции по ключу',
        an: 'Как <b>сортировка писем по первой букве фамилии</b>: все письма Иванову всегда попадают в ящик «И».',
        pl: 'У сообщения есть ключ, например номер заказа. По ключу считают номер партиции. Одинаковый ключ — всегда одна партиция, поэтому события одного заказа идут строго по порядку.',
        how: ['Продюсер берёт ключ сообщения — например, «заказ 17».', 'Считает хеш — число из ключа. Одинаковый ключ всегда даёт одно и то же число.', 'Берёт остаток от деления на число партиций: hash % N.', 'Остаток — номер партиции. Все события заказа 17 лягут туда.', 'Внутри партиции порядок сохраняется, между партициями — нет.', 'Без ключа сообщения раскладываются по кругу — порядка нет.', 'Добавили партиций — формула изменилась, ключи переехали. Поэтому число партиций берут с запасом заранее.'],
        watch: 'Сообщение проходит два окошка: хеш и остаток. Цвет квадратика — ключ: квадратики одного цвета всегда в одной колонке и идут по порядку. Справа вверху — куда уехал бы ключ, если добавить партицию.',
        knobs: ['partitions', 'engine'],
        real: 'Kafka по умолчанию: murmur2(key) % partitions. «Горячий» ключ (один огромный клиент) перегружает одну партицию — его дробят или добавляют «соль». SQS FIFO: порядок внутри MessageGroupId.'
      },
      group: {
        name: 'Группа и ребаланс',
        an: 'Как <b>бригада грузчиков у конвейеров</b>: у каждого конвейера ровно один грузчик. Один ушёл — бригадир переставляет людей, и на это время все стоят.',
        pl: 'Обработчики одного сервиса образуют группу. Брокер делит партиции между ними: одну партицию читает один участник. Участник упал — партиции раздают заново. Это ребаланс.',
        how: ['Каждый участник раз в несколько секунд шлёт координатору «я жив» (heartbeat).', 'Координатор делит партиции: одна партиция — одному участнику.', 'Участников больше, чем партиций, — лишние ждут без дела.', 'Участник молчит дольше таймаута — его считают упавшим.', '<b>Ребаланс</b>: все отдают партиции, координатор раздаёт заново. На это время чтение стоит.', 'Участник вернулся — снова ребаланс.', 'В RabbitMQ и SQS групп нет: все берут из одной очереди, кто свободен.'],
        watch: 'Зелёные точки — «я жив» координатору. Когда участник падает, вокруг него тикает таймаут, потом все линии гаснут (ребаланс), и его партиции переезжают к живым.',
        knobs: ['partitions'],
        real: 'Kafka: session.timeout.ms = 45 с, heartbeat.interval.ms = 3 с, max.poll.interval.ms = 5 мин. Cooperative sticky assignor и новый протокол KIP-848 (Kafka 4.0) убирают «остановку всех» при ребалансе.'
      },
      acks: {
        name: 'acks и копии',
        an: 'Как <b>нотариус с двумя помощниками</b>: сказать «принято» можно сразу, как записал сам, или когда записали и помощники.',
        pl: 'У каждой партиции есть главная копия (лидер) и запасные на других брокерах. Настройка acks решает, когда сказать продюсеру «принято»: не ждать, после записи лидером или после записи всеми копиями.',
        how: ['Продюсер отправляет сообщение лидеру партиции.', 'Лидер дописывает его в свой журнал.', 'Копии сами забирают новое у лидера — с небольшой задержкой.', 'acks=0 — продюсер не ждёт ответа. acks=1 — ответ после записи лидером. acks=all — после записи всеми синхронными копиями (ISR).', 'Потребители видят только то, что есть во всех копиях (high watermark).', 'Лидер упал — лидером становится копия. Чего у неё не было, то пропало: при acks=1 продюсер уже считал это доставленным.', 'acks=all + min.insync.replicas=2 — подтверждённое не теряется при падении брокера.'],
        watch: 'Пунктирные клетки — копия ещё не забрала сообщение. Смотри, когда продюсеру возвращается ✓. Раз в цикл лидер падает сразу после записи — сравни acks=1 и acks=all.',
        knobs: ['acks', 'count'],
        real: 'Kafka: replication.factor = 3, min.insync.replicas = 2, acks=all и enable.idempotence=true — стандарт для денег и заказов. С Kafka 3.0 acks=all стоит по умолчанию.'
      },
      sem: {
        name: 'Коммит и семантика доставки',
        an: 'Как <b>закладка в книге</b>: её можно переложить до того, как прочитал страницу, или после. От этого зависит, что будет, если тебя отвлекут.',
        pl: 'Коммит offset — отметка в брокере «досюда группа дочитала». Отметил до обработки и упал — сообщение потеряется. Отметил после — при падении его обработают второй раз.',
        how: ['Потребитель забирает сообщение №41.', '<b>At-most-once</b>: сначала коммит (дочитал до 42), потом обработка. Упал между ними — №41 потерян.', '<b>At-least-once</b>: сначала обработка, потом коммит. Упал между ними — №41 придёт снова, будет дубль.', '<b>Exactly-once</b>: результат и коммит в одной транзакции — либо оба, либо ничего.', 'Exactly-once работает, только если результат пишется в ту же Kafka. Письмо или платёж наружу транзакция не отменит.', 'На практике: at-least-once плюс идемпотентный обработчик.'],
        watch: 'Три дорожки — три способа, подсвечен твой. Раз в цикл потребитель падает в самом опасном месте и перезапускается. Справа итог: потеря, дубль или ровно один раз.',
        knobs: ['semantics'],
        real: 'Kafka: enable.auto.commit=false и ручной commitSync после обработки — типичный at-least-once. Exactly-once: transactional.id, sendOffsetsToTransaction и isolation.level=read_committed у читателей.'
      },
      dlq: {
        name: 'Повторы и DLQ',
        an: 'Как <b>почта с невручёнными письмами</b>: попробовали доставить три раза — кладут на полку «до востребования», а не носят по кругу.',
        pl: 'Если сообщение не обрабатывается, его пробуют ещё раз с паузой. Не помогло за несколько попыток — переносят в отдельную очередь DLQ, чтобы оно не мешало остальным.',
        how: ['Обработчик упал на сообщении.', 'Сообщение откладывают на паузу: 0,8 с, потом 1,6 с — пауза растёт.', 'Временный сбой (сеть моргнула) проходит со второй попытки.', 'Битые данные не пройдут никогда — это «ядовитое» сообщение.', 'После N попыток его кладут в <b>DLQ</b> вместе с причиной ошибки.', 'Без DLQ: в Kafka ядовитое сообщение держит партицию, в RabbitMQ крутится по кругу, при at-most-once просто теряется.', 'Из DLQ сообщения разбирают, чинят и отправляют снова.'],
        watch: 'Синие проходят сразу. Жёлтое падает один раз и проходит после паузы. Красное падает трижды и уходит в DLQ. Выключи «Повторы + DLQ» — и посмотри, что станет с красным.',
        knobs: ['retries', 'semantics'],
        real: 'Spring Kafka: DefaultErrorHandler и DeadLetterPublishingRecoverer, топики orders.retry и orders.DLT. RabbitMQ: dead-letter-exchange. SQS: redrive policy, maxReceiveCount = 3–5.'
      }
    },
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'поток и обработчики — как на площадке' },
      { id: 'peak', name: 'Пик', note: 'сообщений в 2,5 раза больше обычного — смотри на лаг' },
      { id: 'crash', name: 'Обработчик упал', note: 'потребитель падает после обработки, но до коммита' },
      { id: 'leader', name: 'Брокер-лидер упал', note: 'сервер брокера умирает сразу после записи сообщения' },
      { id: 'poison', name: 'Ядовитое сообщение', note: 'одно сообщение не обрабатывается никогда' }
    ],
    tries: [
      { id: 'idle', text: 'Сделай обработчиков больше, чем партиций: лишние станут серыми — «ждёт партицию»' },
      { id: 'lag', text: 'Включи «Пик» и добавь партиций и обработчиков, пока лаг не перестанет расти' },
      { id: 'acks', text: 'В «Брокер-лидер упал» поставь 3 брокера и acks=all — подтверждённые сообщения больше не теряются' },
      { id: 'dup', text: 'В «Обработчик упал» сравни at-least-once и at-most-once: дубль или потеря' },
      { id: 'dlq', text: 'В «Ядовитое сообщение» включи «Повторы + DLQ» — сообщение уйдёт в DLQ и отпустит партицию' },
      { id: 'engine', text: 'Переключи движок на RabbitMQ: вместо партиций — одна общая очередь' },
      { id: 'blk', text: 'Нажми на подпись «доставка: …» над потребителями и досмотри цикл: какой способ теряет сообщение?' }
    ],
    legend: [['job', 'Сообщение, на брусочке — номер ключа'], ['xq-hol', 'Записано только у лидера, копии ещё нет'], ['xq-again', 'Придёт второй раз: не было коммита'], ['ok', 'Обработано, offset закоммичен'], ['warn', 'Обработано второй раз — дубль'], ['bad', 'Потеряно'], ['xq-poi', 'Ядовитое сообщение'], ['xq-idle', 'Потребитель простаивает']],
    live(n, r, all) {
      const q = ((all && all.queues) || {})[n.id], A = SD.app.A;
      const ch = [['Поток', SD.fmt.num(q ? q.in : r.rps || 0) + '/с', '']];
      if (!q) return ch;
      const W = A.graph.edges.filter(e => e.from === n.id).map(e => A.graph.nodes.find(x => x.id === e.to)).filter(k => k && (k.type === 'worker' || k.type === 'app'))
        .reduce((s, k) => { const rr = (all.nodes || {})[k.id] || {}; return s + (rr.alive != null ? rr.alive : (k.props.count || 1)); }, 0);
      const used = Math.round(q.consumers);
      ch.push(['Лаг', q.growth > 0.5 ? 'растёт +' + SD.fmt.num(q.growth) + '/с' : 'не растёт', q.growth > 0.5 ? 'bad' : 'ok']);
      ch.push(['Читают', `${used} из ${W}`, used < W ? 'warn' : '']);
      ch.push(['Потери', SD.fmt.num(q.lost * 60) + '/мин', q.lost > 0.01 ? 'bad' : 'ok']);
      ch.push(['Дубли', SD.fmt.num(q.dup * 60) + '/мин', q.dup > 0.01 ? 'warn' : 'ok']);
      return ch;
    },
    mount(ctx) {
      const esc = ctx.esc, word = noun();
      const LX = 232, SX0 = 302, SX1 = 652, CX = 778, CW = 206, LY0 = 60, LYH = 290;
      const scn = () => ctx.scenario() || 'norm';
      const rate = () => ({ peak: 10 })[scn()] || 4;
      const KEY = m => `«${word} ${m.key}»`;
      const mbName = mb => `«${mb.name}» #${mb.i + 1}`;
      let G = derive(), S = fresh();
      function fresh() { return { t: 0, next: 200, seq: 0, lanes: [], mem: [], extra: 0, W: 0, fly: [], back: [], rep: [], fx: [], ev: [], retry: [], dlq: [], dlqN: 0, recent: [], keyPart: {}, hashFx: null, rebal: 0, bro: [], armCrash: false, crashAt: 2600, armLead: false, leadAt: 2400, leadFire: 0, poisonAt: 1500, saw: {}, svc: 800, orderLog: -1e9 }; }
      function derive() {
        const n = ctx.node, e = ENG(n), kf = e.cap === 'partitions';
        const Pn = kf ? Math.max(1, +n.props.partitions || 1) : 1, cnt = e.managed ? 3 : Math.max(1, +n.props.count || 1);
        const outs = ctx.outs().filter(o => o.n.type === 'worker' || o.n.type === 'app');
        let L = 0, C = 0;
        outs.forEach(o => { L += (o.r.load && o.r.load.job) || 0; C += o.r.cap || 0; });
        const job = (ctx.A.level || {}).job || null;
        return {
          e, kf, Pn, Pv: Math.min(Pn, 8), cnt, rf: e.managed ? 3 : Math.min(3, cnt), outs, ins: ctx.ins(),
          rho: C > 0 ? (L > 0 ? L / C : 0.5) : 0, acks: kf ? String(n.props.acks == null ? '1' : n.props.acks) : 'q',
          sem: n.props.semantics || 'least', retries: !!n.props.retries, ext: !!(job && job.target === 'external'),
          redis: n.props.engine === 'redis', quorum: !e.managed && !kf && cnt >= 3,
          dedup: outs.length > 0 && outs.every(o => o.n.type === 'worker' && o.n.props.dedup)
        };
      }
      const RD = () => G.rf < 2 || G.redis ? 0 : G.kf ? (scn() === 'leader' ? 1300 : 700) : G.e.managed ? 300 : 450;
      const fx = (x, y, txt, cls) => S.fx.push({ x, y, txt, cls, born: S.t });
      const okKey = k => !G.kf || hsh(k) % G.Pn < G.Pv;
      const partOf = k => G.kf ? hsh(k) % G.Pn % G.Pv : 0;
      const followers = l => { const out = [], nb = S.bro.length; for (let i = 1; i < nb && out.length < G.rf - 1; i++) out.push((l.lead + i) % nb); return out; };
      const totalLag = () => S.lanes.reduce((s, l) => s + l.q.length, 0) + S.mem.filter(m => m.cur && !m.dead).length;
      const sawCheck = () => { if (S.saw.dup && S.saw.lost) ctx.done('dup'); };

      /* ---------- геометрия ---------- */
      const geo = () => { const LH = Math.min(72, LYH / G.Pv); return { LH, y0: LY0 + (LYH - LH * G.Pv) / 2 }; };
      const yl = k => { const g = geo(); return g.y0 + g.LH * (k + 0.5); };
      const memGeo = () => { const n = Math.max(1, S.mem.length + (S.extra ? 1 : 0)), MH = Math.min(54, LYH / n - 6); return { n, MH, y0: LY0 + (LYH - n * (MH + 6) + 6) / 2 }; };
      const ym = k => { const g = memGeo(); return g.y0 + k * (g.MH + 6) + g.MH / 2; };
      const np = () => Math.max(1, Math.min(G.ins.length, 3));
      const prodY = i => 205 + (i - (np() - 1) / 2) * 78;
      const nS = () => G.Pv <= 4 ? 14 : 9;
      const pitch = () => (SX1 - SX0) / nS();
      const tailX = l => SX1 - Math.min(l.q.length + 0.5, nS() - 0.5) * pitch();

      /* ---------- построение ---------- */
      function mkBro() { return Array.from({ length: G.cnt }, () => ({ dead: 0 })); }
      function buildLanes(keep) {
        const old = keep ? S.lanes.flatMap(l => l.q) : [];
        S.lanes = Array.from({ length: G.Pv }, (_, k) => ({ q: [], end: 120 + k * 17, com: 120 + k * 17, lead: k % G.cnt, down: 0, hl: -1e9, own: null }));
        if (!S.bro.length || S.bro.length !== G.cnt) S.bro = mkBro();
        old.forEach(m => { m.part = partOf(m.key); const l = S.lanes[m.part]; m.off = l.end++; l.com = Math.min(l.com, m.off); l.q.push(m); });
      }
      function buildMembers() {
        const list = [];
        G.outs.forEach(o => { const c = Math.max(0, o.r.alive != null ? o.r.alive : (o.n.props.count || 1)); for (let i = 0; i < c; i++) list.push({ nid: o.n.id, i, name: ctx.nm(o.n.id), dedup: o.n.type === 'worker' && !!o.n.props.dedup }); });
        const show = list.length <= 8 ? list.length : 7, old = S.mem;
        S.mem = list.slice(0, show).map((m, k) => Object.assign(old.find(x => x.nid === m.nid && x.i === m.i) || { cur: null, dead: 0 }, m, { k }));
        old.filter(m => !S.mem.includes(m) && m.cur).forEach(m => requeue(m.cur.m));
        S.extra = list.length - show; S.W = list.length;
        const act = G.kf ? Math.min(show, G.Pn) : show;
        S.svc = clamp((G.rho || 0.5) * 1000 * Math.max(1, act) / 4, 260, 6000);
        assign();
      }
      function assign() {
        const alive = S.mem.filter(m => !m.dead);
        S.mem.forEach(m => { m.lanes = []; m.idle = false; });
        S.lanes.forEach(l => { l.own = null; });
        if (G.kf) {
          const act = alive.slice(0, G.Pn);
          alive.slice(G.Pn).forEach(m => { m.idle = true; });
          if (act.length) S.lanes.forEach((l, k) => { const m = act[k % act.length]; m.lanes.push(k); l.own = m; });
        } else alive.forEach(m => { m.lanes = [0]; });
      }
      function requeue(m) { const l = S.lanes[m.part] || S.lanes[0]; if (!l) return; if (!m.poison) m.again = true; l.q.unshift(m); }
      function lose(m, t, x, y) { S.ev.push({ t, k: 'lost' }); S.fx.push({ k: 'x', x, y, born: t, dur: 1600 }); }
      function commit(m) { if (G.kf) { const l = S.lanes[m.part]; if (l) l.com = Math.max(l.com, m.off + 1); } }

      /* ---------- продюсеры и запись ---------- */
      function pickKey() {
        const rc = S.recent.filter(okKey);
        if (rc.length && Math.random() < 0.3) return rc[Math.floor(Math.random() * rc.length)];
        for (let i = 0; i < 40; i++) { const k = 10 + Math.floor(Math.random() * 80); if (okKey(k)) return k; }
        for (let k = 10; k < 400; k++) if (okKey(k)) return k;
        return 10;
      }
      function poisonKey() { for (let k = 13; k < 400; k++) if (okKey(k) && !S.recent.includes(k)) return k; return 13; }
      function send(t, m) {
        if (!m) {
          const key = pickKey();
          m = { id: ++S.seq, key, p: Math.floor(Math.random() * np()), eff: 0 };
          S.recent = [key].concat(S.recent.filter(k => k !== key)).slice(0, 4);
          S.ev.push({ t, k: 'in' });
        }
        S.fly.push({ m, t0: t, t1: t + 650 });
      }
      function write(m, t) {
        m.part = partOf(m.key);
        const l = S.lanes[m.part]; if (!l) return;
        if (l.down > t) {
          if (G.acks === '0') {
            lose(m, t, SX0 + 10, yl(m.part));
            if (!S.saw.l0) { S.saw.l0 = 1; ctx.log(`${KEY(m)}: лидер партиции недоступен, а при acks=0 продюсер не ждёт ответа — сообщение пропало молча.`, 'bad'); }
            return;
          }
          S.back.push({ m, at: l.down + 150 }); fx(SX0 + 60, yl(m.part) - 8, 'не принято — отправит снова', 'warn');
          return;
        }
        m.off = l.end++; m.tw = t; m.rep = t + RD(); m.acked = false;
        m.ackAt = G.acks === '0' ? -1 : G.acks === '1' ? t : m.rep;
        l.q.push(m); l.hl = t;
        const same = S.keyPart[m.key] === m.part && !m.poison; S.keyPart[m.key] = m.part;
        S.hashFx = { m, part: m.part, born: t, same };
        if (RD() > 0) followers(l).forEach(b => S.rep.push({ a: l.lead, b, t0: t, t1: m.rep }));
        if (S.armLead && l.lead === S.victim) { S.armLead = false; S.leadFire = t + 260; }
      }

      /* ---------- потребители ---------- */
      function pick(mb, t) {
        if (G.kf) {
          for (let j = 0; j < mb.lanes.length; j++) {
            const k = mb.lanes[(j + (mb.rr || 0)) % mb.lanes.length], l = S.lanes[k];
            if (!l || l.down > t || !l.q.length || l.q[0].rep > t) continue;
            mb.rr = (mb.rr || 0) + j + 1;
            return l.q.shift();
          }
          return null;
        }
        const l = S.lanes[0]; if (!l || l.down > t) return null;
        const busy = G.e.order === 'group' ? new Set(S.mem.filter(x => x.cur).map(x => x.cur.m.key)) : null;
        const i = l.q.findIndex(h => h.rep <= t && !(busy && busy.has(h.key)));
        return i < 0 ? null : l.q.splice(i, 1)[0];
      }
      function dur(ph, c) { const s = S.svc; return ph === 'take' ? 0.15 * s : ph === 'proc' ? (c.skip ? 0.15 : 0.6) * s : ph === 'tx' ? 0.3 * s : 0.25 * s; }
      function phase(mb, t) { const c = mb.cur, ph = c.ph[c.i]; if (ph === 'proc') c.skip = mb.dedup && c.m.eff > 0 && !c.m.poison; c.t0 = t; c.t1 = t + dur(ph, c); }
      function start(mb, m, t) {
        if (!G.kf && G.e.order !== 'group' && S.mem.some(x => x !== mb && x.cur && x.cur.m.key === m.key) && t - S.orderLog > 8000) {
          S.orderLog = t;
          ctx.log(`<b>Порядок не гарантирован:</b> ${KEY(m)} сейчас у двух потребителей сразу — второе событие может закончиться раньше первого.`, 'warn');
        }
        mb.cur = { m, ph: G.sem === 'most' ? ['take', 'commit', 'proc'] : ['take', 'proc', G.sem === 'exactly' ? 'tx' : 'commit'], i: 0 };
        phase(mb, t);
      }
      function stepMember(mb, t) {
        for (let guard = 0; guard < 8; guard++) {
          if (mb.dead) {
            if (t < mb.dead) return;
            const td = mb.dead; mb.dead = 0; mb.free = td; if (G.kf) S.rebal = td + 1000; assign();
            ctx.log(`<b>${esc(mbName(mb))} поднялся</b> и вернулся в группу${G.kf ? ' — снова ребаланс: партиции делят заново' : ''}.`, 'ok');
            continue;
          }
          if (G.kf && t < S.rebal) return;
          const c = mb.cur;
          if (!c) {
            if (mb.idle) return;
            const m = pick(mb, t); if (!m) { mb.free = t; return; }
            start(mb, m, Math.min(t, Math.max(mb.free || 0, m.rep || 0, G.kf ? S.rebal : 0)));
            continue;
          }
          if (t < c.t1) return;
          const te = c.t1, ph = c.ph[c.i], m = c.m, y = ym(mb.k);
          if (ph === 'proc') {
            if (m.poison) { poisonFail(mb, m, te); continue; }
            if (S.armCrash && G.sem !== 'most') { crash(mb, te); continue; }
            if (c.skip) {
              S.ev.push({ t: te, k: 'skip' }); fx(CX + CW / 2, y - 16, '✓ дубль пропущен', 'ok');
              ctx.log(`${KEY(m)} пришло второй раз — обработчик нашёл его в таблице «уже обработано» и пропустил.`, 'ok');
              if (scn() === 'crash') { S.saw.dup = 1; sawCheck(); }
            } else if (++m.eff > 1) {
              S.ev.push({ t: te, k: 'dup' }); fx(CX + CW / 2, y - 16, 'второй раз!', 'warn');
              ctx.log(`<b>Дубль:</b> ${KEY(m)} обработан второй раз${G.ext ? ' — клиент получит два письма' : ''}. Защита — идемпотентный обработчик (настройка у обработчика).`, 'warn');
              if (scn() === 'crash') { S.saw.dup = 1; sawCheck(); }
            }
          }
          if (ph === 'commit' || ph === 'tx') commit(m);
          if (ph === 'commit' && G.sem === 'most' && S.armCrash) { crash(mb, te); continue; }
          if (++c.i >= c.ph.length) { mb.cur = null; mb.free = te; m.again = false; S.ev.push({ t: te, k: 'ok' }); continue; }
          phase(mb, te);
        }
      }
      function crash(mb, t) {
        const m = mb.cur.m, y = ym(mb.k), nm = esc(mbName(mb));
        mb.cur = null; mb.dead = t + 3000; S.armCrash = false; S.crashAt = t + 12000;
        if (G.sem === 'most') {
          lose(m, t, CX + CW - 22, y); S.saw.lost = 1;
          ctx.log(`<b>${nm} упал сразу после коммита.</b> Брокер уже считает ${KEY(m)} прочитанным, а обработать не успели — <b>потеряно</b> (at-most-once).`, 'bad');
        } else {
          if (G.sem === 'least' || G.ext) m.eff++;
          requeue(m); S.fx.push({ k: 'x', x: CX + CW - 22, y, born: t, dur: 1600 });
          ctx.log(G.sem === 'exactly'
            ? `<b>${nm} упал посреди транзакции.</b> Результат и offset откатились вместе — ${KEY(m)} обработают заново, и это не дубль.${G.ext ? ' Но внешний вызов (письмо) транзакция не отменит — он повторится.' : ''}`
            : `<b>${nm} упал после обработки, но до коммита.</b> Брокер не знает, что ${KEY(m)} готов, — его выдадут снова.`, 'warn');
        }
        if (G.kf) { S.rebal = t + 1000; ctx.log('Ребаланс: группа делит партиции упавшего между живыми — 1–2 с никто не читает.', ''); }
        assign(); sawCheck();
      }
      function poisonFail(mb, m, t) {
        m.tries = (m.tries || 0) + 1; S.ev.push({ t, k: 'err' });
        const y = ym(mb.k); fx(CX + CW / 2, y - 16, `ошибка · попытка ${m.tries}`, 'bad');
        if (G.retries) {
          commit(m); mb.cur = null;
          if (m.tries >= 3) {
            S.dlq.unshift(m); S.dlq = S.dlq.slice(0, 5); S.dlqN++; S.ev.push({ t, k: 'dlq' });
            S.fx.push({ k: 'mv', x: CX + 20, y, x2: 820, y2: 432, c: 'var(--bad)', born: t, dur: 900 });
            ctx.log(`<b>${KEY(m)} — в DLQ</b> после 3 попыток: битый JSON не починится сам. ${G.kf ? 'Партиция свободна' : 'Очередь свободна'}, сообщение ждёт разбора человеком.`, 'ok');
            ctx.done('dlq');
          } else {
            const d = 800 * Math.pow(2, m.tries - 1); S.retry.push({ m, at: t + d, from: t });
            ctx.log(`${KEY(m)} упало (попытка ${m.tries}) — повтор через ${sec(d)}. Остальные сообщения идут дальше.`, 'warn');
          }
        } else if (G.sem === 'most') {
          commit(m); mb.cur = null; lose(m, t, CX + CW - 22, y);
          ctx.log(`${KEY(m)} упало, но offset уже закоммичен (at-most-once) — сообщение пропало, и никто не узнает.`, 'bad');
        } else if (G.kf) {
          mb.cur = { m, ph: ['proc'], i: 0 }; phase(mb, t);
          if (m.tries <= 2 || m.tries % 25 === 0) ctx.log(`<b>${KEY(m)} падает снова (попытка ${m.tries}).</b> Закоммитить нельзя, пропустить нельзя — партиция P${m.part} стоит, лаг за ним растёт. Нужен DLQ.`, 'bad');
        } else {
          mb.cur = null; requeue(m);
          if (m.tries <= 2 || m.tries % 25 === 0) ctx.log(`${KEY(m)} вернулось в начало очереди и снова упало (попытка ${m.tries}) — крутится по кругу и жжёт ресурсы. Нужен DLQ.`, 'bad');
        }
      }
      const poisonAlive = () => S.lanes.some(l => l.q.some(m => m.poison)) || S.mem.some(m => m.cur && m.cur.m.poison) || S.retry.length > 0 || S.fly.some(f => f.m.poison) || S.back.some(b => b.m.poison);

      /* ---------- падение брокера ---------- */
      function leaderCrash(t) {
        S.leadFire = 0; S.leadAt = t + 10000;
        if (G.e.managed) { ctx.log('<b>Один из серверов облака упал</b> — SQS этого не заметил: копии в трёх зонах, переключение внутри AWS.', 'ok'); return; }
        const v = S.victim || 0, nb = S.bro.length, bn = v + 1, nl = (v + 1) % nb;
        const lanes = S.lanes.filter(l => l.lead === v), names = lanes.map(l => 'P' + S.lanes.indexOf(l)).join(', ');
        S.bro[v].dead = t + 4500;
        S.rep = S.rep.filter(r => r.a !== v && r.b !== v);
        let lost = 0, resent = 0;
        if (G.cnt === 1) {
          lanes.forEach(l => { l.down = t + 4500; l.q.splice(0).forEach((m, i) => { lose(m, t, SX1 - (i + 0.5) * pitch(), yl(S.lanes.indexOf(l))); lost++; }); });
          ctx.log(`<b>Брокер упал вместе с диском.</b> Копий нет — ${lost} ${pl(lost, 'сообщение', 'сообщения', 'сообщений')} в очереди пропали, новые не принимаются, пока сервер не вернётся. Поставь 3 брокера.`, 'bad');
          return;
        }
        if (!G.kf && !G.quorum && !G.redis) {
          lanes.forEach(l => { l.down = t + 4500; });
          ctx.log('<b>Узел упал, кворума нет:</b> узлов два, большинство — оба. Очередь не принимает сообщения, пока узел не вернётся. Нужно 3 узла.', 'bad');
          return;
        }
        lanes.forEach(l => {
          const k = S.lanes.indexOf(l);
          l.lead = nl; l.down = t + 900;
          const un = l.q.filter(m => m.rep > t || (G.redis && t - m.tw < 1000));
          un.forEach(m => {
            const i = l.q.indexOf(m), x = SX1 - (i + 0.5) * pitch();
            l.q.splice(i, 1);
            if ((G.kf && G.acks === 'all') || (!G.kf && !G.redis)) { m.acked = false; m.ackAt = -1; m.re = true; S.back.push({ m, at: t + 1000 }); fx(x, yl(k) - 12, '↻', 'warn'); resent++; }
            else { lose(m, t, x, yl(k)); lost++; }
          });
          if (un.length && G.kf) l.end = Math.min(...un.map(m => m.off));
        });
        if (G.redis) ctx.log(`<b>Узел Redis упал.</b> Данные в памяти сбрасываются на диск раз в секунду — ${lost ? `${lost} ${pl(lost, 'сообщение', 'сообщения', 'сообщений')} последней секунды пропали.` : 'на этот раз очередь была пуста, повезло. Будь в ней сообщения за последнюю секунду — они бы пропали.'}`, lost ? 'bad' : 'warn');
        else if (!G.kf) ctx.log(`<b>Узел ${bn} упал</b>, лидером очереди стал узел ${nl + 1}. Подтверждение приходит после записи на большинство узлов — ${resent ? `${resent} неподтверждённых продюсер отправит снова` : 'всё подтверждённое уже на других узлах'}. Потерь нет.`, 'ok');
        else if (G.acks === 'all') { ctx.log(`<b>Брокер ${bn} (лидер ${names}) упал</b>, лидером стал брокер ${nl + 1}. ${resent ? `${resent} нескопированных ещё не получили ✓ (acks=all) — продюсер отправил их снова.` : 'Всё подтверждённое уже было в копиях.'} Потерь нет.`, 'ok'); ctx.done('acks'); }
        else if (G.acks === '1') ctx.log(`<b>Брокер ${bn} (лидер ${names}) упал.</b> ${lost ? `${lost} ${pl(lost, 'сообщение было', 'сообщения были', 'сообщений было')} только у лидера. Продюсер уже услышал «принято» (acks=1), а ${lost === 1 ? 'его' : 'их'} больше нет — <b>тихая потеря</b>.` : 'На этот раз всё успело скопироваться.'}`, lost ? 'bad' : 'warn');
        else ctx.log(`<b>Брокер ${bn} (лидер ${names}) упал.</b> При acks=0 продюсер ничего не ждёт: ${lost} ${pl(lost, 'нескопированное', 'нескопированных', 'нескопированных')} и всё, что придёт во время выборов лидера, пропадёт молча.`, 'bad');
      }

      /* ---------- ход модели ---------- */
      function tick(dt) {
        const t = S.t += dt, s = scn();
        while (S.next <= t) { send(S.next); S.next += 1000 / rate() * (0.5 + Math.random()); }
        S.fly = S.fly.filter(f => { if (t < f.t1) return true; write(f.m, t); return false; });
        S.back = S.back.filter(b => { if (t < b.at) return true; b.m.re = true; send(t, b.m); return false; });
        S.lanes.forEach(l => l.q.forEach(m => { if (!m.acked && m.ackAt >= 0 && t >= m.ackAt) { m.acked = true; S.fx.push({ x: 176, y: prodY(m.p) - 14, txt: '✓', cls: 'ok', born: t, dur: 700 }); } }));
        S.rep = S.rep.filter(r => t < r.t1);
        S.bro.forEach((b, i) => { if (b.dead && t >= b.dead) { b.dead = 0; const back = []; S.lanes.forEach((l, k) => { if (k % S.bro.length === i && l.lead !== i && G.kf) { l.lead = i; back.push('P' + k); } }); ctx.log(`<b>${G.kf ? 'Брокер' : 'Узел'} ${i + 1} вернулся</b> и догнал копии.${back.length ? ` Снова лидер своих партиций: ${back.join(', ')}.` : ''}`, 'ok'); } });
        S.retry = S.retry.filter(r => { if (t < r.at) return true; (S.lanes[r.m.part] || S.lanes[0]).q.unshift(r.m); return false; });
        if (s === 'crash' && !S.armCrash && t >= S.crashAt && !S.mem.some(m => m.dead)) S.armCrash = true;
        if (s === 'leader' && !S.armLead && !S.leadFire && t >= S.leadAt && !S.bro.some(b => b.dead) && S.lanes[0]) { S.armLead = true; S.victim = S.lanes[0].lead; }
        if (S.leadFire && t >= S.leadFire) leaderCrash(t);
        if (s === 'poison' && t >= S.poisonAt && !poisonAlive()) { send(t, { id: ++S.seq, key: poisonKey(), p: 0, eff: 0, poison: true }); S.ev.push({ t, k: 'in' }); S.poisonAt = t + 12000; }
        S.mem.forEach(m => stepMember(m, t));
        S.ev = S.ev.filter(e => e.t > t - 10000);
        if (PV.k && QP[PV.k]) { PV.t += dt; QP[PV.k].tick(PV.t); }
      }

      /* ---------- отрисовка ---------- */
      const PG = (k, inner) => `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}">${inner}</g>`;
      const SEMN = { most: 'at-most-once', least: 'at-least-once', exactly: 'exactly-once' };
      function draw() {
        if (ctx.part() && QP[ctx.part()]) { const pv = QP[ctx.part()]; if (!PV.s.init) pv.tick(PV.t); ctx.svg.innerHTML = pv.draw(PV.t) + drawFx(PV); return; }
        const t = S.t, kc = KJ(), g = geo(), mg = memGeo(), ns = nS(), pt = pitch(), bh = Math.min(26, g.LH - 14), hf = S.hashFx;
        let h = `<text class="xq-h" x="16" y="30">Продюсеры</text><text class="xq-h" x="${LX}" y="30">${G.kf ? `Топик · ${G.Pn} ${pl(G.Pn, 'партиция', 'партиции', 'партиций')}${G.Pn > G.Pv ? ` · видно ${G.Pv}` : ''}` : 'Очередь'} · ${esc(G.e.name)}</text><text class="xq-h" x="${CX}" y="30">${G.outs.length ? 'Группа потребителей' : 'Потребителей нет'}</text>`;
        // продюсеры (соседи — вне блоков, чтобы клик вёл к ним)
        const ins = G.ins.slice(0, 3), yc = LY0 + LYH / 2;
        for (let i = 0; i < np(); i++) {
          const o = ins[i], y = prodY(i);
          const wait = S.lanes.reduce((s, l) => s + l.q.filter(m => m.p === i && !m.acked && m.ackAt >= 0).length, 0) + S.back.filter(b => b.m.p === i).length;
          const ak = G.kf ? (G.acks === '0' ? 'acks=0 · не ждёт ответа' : `acks=${G.acks} · ждут ✓: ${wait}`) : `ждут подтверждения: ${wait}`;
          h += `<path class="xr-wire dash" d="M168,${y} H214"/>`;
          h += gox(ctx, o && o.n.id, `<rect class="xr-box" x="16" y="${y - 30}" width="152" height="60" rx="10"/><text class="xr-t" x="28" y="${y - 10}">${esc(cut(o ? ctx.nm(o.n.id) : 'Продюсер', 18))}</text><text class="xr-s" x="28" y="${y + 6}">${o ? `шлёт ${SD.fmt.num(o.er.flow || 0)}/с` : 'отправитель'}</text><text class="xr-m ${wait > 2 ? 'warn' : ''}" x="28" y="${y + 21}">${ak}</text>`);
        }
        if (G.ins.length > 3) h += `<text class="xr-s" x="92" y="${prodY(2) + 46}" text-anchor="middle">и ещё ${G.ins.length - 3}</text>`;
        // блок «выбор партиции»: строка хеша и подписи дорожек
        let kh = `<rect class="xq-frame" x="${LX - 8}" y="${LY0 - 4}" width="${SX0 - LX - 4}" height="${LYH + 8}" rx="8"/>`;
        if (G.kf && hf && t - hf.born < 1800) kh += `<text class="xr-m acc" x="${LX}" y="48">hash(«${word} ${hf.m.key}») % ${G.Pn} = ${hf.part} → P${hf.part}, offset ${hf.m.off}${hf.same ? ' · тот же ключ — та же партиция' : ''}</text>`;
        else kh += `<text class="xr-s" x="${LX}" y="48">${G.kf ? `партицию выбирает ключ: hash(ключ) % ${G.Pn}` : G.e.order === 'group' ? 'FIFO: сообщения одного ключа выдаются по одному' : 'новое — в конец, свободный потребитель берёт первое'}</text>`;
        const ys = S.lanes.map((l, k) => yl(k)).concat(Array.from({ length: np() }, (_, i) => prodY(i)));
        h += `<path class="xr-wire dash" d="M214,${X1(Math.min(...ys))} V${X1(Math.max(...ys))}${S.lanes.map((l, k) => ` M214,${X1(yl(k))} H${SX0 - 6}`).join('')}"/>`;
        S.lanes.forEach((l, k) => {
          const y = yl(k);
          if (G.kf) kh += g.LH >= 50 ? `<text class="xr-t" x="${LX + 2}" y="${X1(y - 8)}">P${k}</text><text class="xr-s" x="${LX + 2}" y="${X1(y + 17)}">лидер: Б${l.lead + 1}</text>` : `<text class="xr-t" x="${LX + 2}" y="${X1(y - 6)}">P${k}</text><text class="xr-s" x="${LX + 28}" y="${X1(y - 6)}">Б${l.lead + 1}</text>`;
          else kh += `<text class="xr-t" x="${LX + 2}" y="${X1(y - 7)}">одна</text><text class="xr-s" x="${LX + 2}" y="${X1(y + 16)}">очередь</text>`;
        });
        h += PG('key', kh);
        // блок «журнал»: дорожки, брусочки, курсор, лаг
        let lh = `<rect class="xq-frame" x="${SX0 - 10}" y="${LY0 - 4}" width="${SX1 - SX0 + 80}" height="${LYH + 8}" rx="8"/>`;
        S.lanes.forEach((l, k) => {
          const y = yl(k), top = y - g.LH / 2 + 3, H = g.LH - 6, off = l.down > t;
          const lag = l.q.length + S.mem.filter(m => m.cur && !m.dead && m.cur.m.part === k).length;
          lh += `<rect class="xq-lane ${off ? 'off' : G.kf && hf && hf.part === k && t - hf.born < 900 ? 'hl' : ''}" x="${SX0 - 6}" y="${X1(top)}" width="${SX1 - SX0 + 14}" height="${X1(H)}" rx="6"/>`;
          const show = l.q.length > ns ? ns - 1 : l.q.length;
          for (let i = 0; i < show; i++) {
            const m = l.q[i], x = SX1 - (i + 1) * pt + 2, w = pt - 4, hol = m.rep > t;
            const st = m.poison ? '' : hol ? `stroke:${kc}` : `fill:${kc}`;
            lh += `<rect class="xq-b ${m.poison ? 'poi' : hol ? 'hol' : ''} ${m.again ? 'again' : ''}" x="${X1(x)}" y="${X1(y - bh / 2)}" width="${X1(w)}" height="${bh}" rx="3" style="${st}"/>`;
            if (G.Pv <= 4 && bh >= 16) lh += `<text class="xq-k ${hol || m.poison ? 'd' : ''}" x="${X1(x + w / 2)}" y="${X1(y + 3.5)}" text-anchor="middle">${m.poison ? '☠' : m.key}</text>`;
          }
          if (l.q.length > ns) lh += `<text class="xr-m warn" x="${X1(SX1 - ns * pt + pt / 2)}" y="${X1(y + 4)}" text-anchor="middle">+${l.q.length - ns + 1}</text>`;
          if (off) lh += `<text class="xr-m bad" x="${(SX0 + SX1) / 2}" y="${X1(y + 4)}" text-anchor="middle">${G.cnt === 1 || (!G.kf && !G.quorum && !G.redis) ? 'брокер недоступен' : 'выбирают нового лидера…'}</text>`;
          lh += `<line class="xq-cur" x1="${SX1 + 4}" y1="${X1(y - bh / 2 - 2)}" x2="${SX1 + 4}" y2="${X1(y + bh / 2 + 2)}"/>`;
          lh += `<text class="xr-m ${lag > 8 ? 'bad' : lag > 3 ? 'warn' : ''}" x="${SX1 + 12}" y="${X1(g.LH >= 34 ? y - 3 : y + 4)}">${G.kf ? 'лаг' : 'ждут'} ${lag}</text>`;
          if (g.LH >= 34) lh += `<text class="xr-s" x="${SX1 + 12}" y="${X1(y + 11)}">${G.kf ? 'offset ' + l.com : 'ack → удалит'}</text>`;
        });
        h += PG('log', lh);
        // блок «группа»: рамка и провода; сами карточки — соседи, кликаются отдельно
        let gh = `<rect class="xq-frame" x="${CX - 10}" y="${LY0 - 4}" width="${CW + 20}" height="${LYH + 8}" rx="10"/>`;
        S.lanes.forEach((l, k) => {
          const y = yl(k), owners = G.kf ? (l.own ? [l.own] : []) : S.mem.filter(m => !m.dead);
          owners.forEach(m => { const y2 = ym(m.k), act = m.cur && m.cur.ph[m.cur.i] === 'take' && m.cur.m.part === k; gh += `<path class="xr-wire ${act ? 'act' : ''}" d="M${SX1 + 90},${X1(y)} C${SX1 + 112},${X1(y)} ${CX - 22},${X1(y2)} ${CX},${X1(y2)}"/>`; });
        });
        h += PG('group', gh);
        h += PG('sem', `<rect class="xq-pill" x="${CX}" y="35" width="${CW}" height="19" rx="9.5"/><text class="xr-m" x="${CX + CW / 2}" y="48.5" text-anchor="middle">доставка: ${SEMN[G.sem]} ›</text>`);
        if (!S.mem.length) h += `<rect class="xr-box xq-idle" x="${CX}" y="${yc - 34}" width="${CW}" height="68" rx="10"/><text class="xr-t" x="${CX + 12}" y="${yc - 8}">Никто не читает</text><text class="xr-s" x="${CX + 12}" y="${yc + 10}">проведи стрелку к обработчику</text>`;
        S.mem.forEach(mb => {
          const y = ym(mb.k), H = mg.MH, top = y - H / 2, c = mb.cur, rebal = G.kf && t < S.rebal && !mb.dead;
          let st, bar = 0, bcls = 'acc', scls = '';
          if (mb.dead) { st = `упал · вернётся через ${sec(mb.dead - t)}`; scls = 'bad'; }
          else if (mb.idle) st = 'ждёт партицию — простаивает';
          else if (rebal) { st = 'ребаланс — чтение на паузе'; scls = 'warn'; }
          else if (c) {
            const ph = c.ph[c.i], m = c.m; bar = clamp((t - c.t0) / Math.max(1, c.t1 - c.t0), 0, 1);
            st = ph === 'take' ? `забирает ${word} ${m.key}` : ph === 'proc' ? (m.poison ? `${word} ${m.key}: битый JSON` : c.skip ? `${word} ${m.key}: уже было — пропуск` : `обрабатывает ${word} ${m.key}${m.eff > 0 ? ' — второй раз' : ''}`) : ph === 'tx' ? `транзакция: результат + ${G.kf ? 'offset' : 'ack'}` : G.kf ? `коммит offset ${m.off}` : 'ack — брокер удалит';
            bcls = ph === 'proc' ? (m.poison ? 'bad' : m.eff > 0 && !c.skip ? 'warn' : 'acc') : ph === 'take' ? '' : 'ok';
            if (ph === 'proc' && m.poison) scls = 'bad';
          } else st = G.kf && !mb.lanes.length ? 'читает скрытые партиции' : 'ждёт сообщений';
          const parts = G.kf && mb.lanes.length && !mb.dead ? mb.lanes.map(k => 'P' + k).join(' ') : '';
          let inner = `<rect class="xr-box ${mb.dead ? 'bad dead' : mb.idle ? 'xq-idle' : ''}" x="${CX}" y="${X1(top)}" width="${CW}" height="${X1(H)}" rx="8"/>`;
          inner += `<text class="xr-t xq-sm" x="${CX + 10}" y="${X1(top + 15)}">${esc(cut(mb.name, parts ? 14 : 20))} #${mb.i + 1}</text>`;
          if (parts) inner += `<text class="xr-m acc" x="${CX + CW - 8}" y="${X1(top + 15)}" text-anchor="end">${cut(parts, 9)}</text>`;
          inner += `<text class="xr-s ${scls ? 'xq-' + scls : ''}" x="${CX + 10}" y="${X1(top + 28)}">${esc(cut(st, 31))}</text>`;
          if (c && !mb.dead) { const by = H >= 40 ? top + H - 8 : top + H - 4; inner += `<rect class="xr-bar" x="${CX + 10}" y="${X1(by)}" width="${CW - 20}" height="3" rx="1.5"/><rect class="xr-bar-f ${bcls}" x="${CX + 10}" y="${X1(by)}" width="${X1((CW - 20) * bar)}" height="3" rx="1.5"/>`; }
          h += gox(ctx, mb.nid, inner);
        });
        if (S.extra) {
          const y = ym(S.mem.length), top = y - mg.MH / 2, idle = G.kf ? Math.max(0, S.W - G.Pn) : 0;
          h += `<rect class="xr-box xq-idle" x="${CX}" y="${X1(top)}" width="${CW}" height="${X1(mg.MH)}" rx="8"/><text class="xr-s" x="${CX + 10}" y="${X1(y + 4)}">и ещё ${S.extra}${idle ? ` · ${idle} ${pl(idle, 'ждёт', 'ждут', 'ждут')} партицию` : ''}</text>`;
        }
        // точки в пути
        S.fly.forEach(f => {
          const m = f.m, p = clamp((t - f.t0) / (f.t1 - f.t0), 0, 1), part = partOf(m.key), l = S.lanes[part]; if (!l) return;
          const [x, y] = along([[168, prodY(Math.min(m.p, np() - 1))], [214, prodY(Math.min(m.p, np() - 1))], [214, yl(part)], [tailX(l), yl(part)]], p);
          h += `<circle class="xr-dot ${m.re ? 'xq-re' : ''}" cx="${X1(x)}" cy="${X1(y)}" r="4.5" style="fill:${m.poison ? 'var(--bad)' : kc}"/>`;
        });
        S.mem.forEach(mb => {
          const c = mb.cur; if (!c || mb.dead || c.ph[c.i] !== 'take') return;
          const p = clamp((t - c.t0) / Math.max(1, c.t1 - c.t0), 0, 1), y0 = yl(c.m.part), y1 = ym(mb.k), x0 = SX1 - pt / 2, x1 = CX + CW - 16;
          h += `<circle class="xr-dot" cx="${X1(x0 + (x1 - x0) * p)}" cy="${X1(y0 + (y1 - y0) * p)}" r="5" style="fill:${c.m.poison ? 'var(--bad)' : kc}"/>`;
        });
        // блок «acks и копии»
        let ah = `<rect class="xr-zone" x="16" y="370" width="602" height="124" rx="10"/>`;
        const ttl = G.e.managed ? 'Облако хранит копии само' : G.kf ? `Брокеры и копии партиций · acks=${G.acks}` : `Узлы брокера · ${G.redis ? 'данные в памяти' : G.quorum ? 'кворум: подтверждает большинство' : G.cnt === 1 ? 'один узел — одна копия' : 'два узла — кворума нет'}`;
        ah += `<text class="xr-t" x="28" y="390">${ttl}</text><text class="xr-m acc" x="606" y="390" text-anchor="end">разобрать ›</text>`;
        const nb = S.bro.length, bw = Math.min(170, (578 - (nb - 1) * 10) / nb), bx = i => 28 + i * (bw + 10);
        S.bro.forEach((b, i) => {
          const x = bx(i), dead = b.dead > t;
          const lead = S.lanes.map((l, k) => l.lead === i ? k : -1).filter(k => k >= 0);
          const fol = G.kf ? S.lanes.map((l, k) => followers(l).includes(i) ? k : -1).filter(k => k >= 0) : [];
          const l1 = G.e.managed ? 'копия очереди' : G.kf ? 'лидер: ' + (lead.length ? lead.map(k => 'P' + k).join(' ') : '—') : lead.length ? 'лидер очереди' : 'копия очереди';
          ah += `<rect class="xr-box ${dead ? 'bad dead' : ''}" x="${X1(x)}" y="398" width="${X1(bw)}" height="52" rx="8"/><text class="xr-t xq-sm" x="${X1(x + 10)}" y="414">${G.e.managed ? 'Зона ' + 'ABC'[i] : G.kf ? 'Брокер ' + (i + 1) : 'Узел ' + (i + 1)}${dead ? ' · упал' : ''}</text>`;
          ah += `<text class="xr-s" x="${X1(x + 10)}" y="429">${esc(cut(l1, Math.floor(bw / 6.2)))}</text>`;
          if (G.kf && G.rf > 1) ah += `<text class="xr-s" x="${X1(x + 10)}" y="443">${esc(cut('копии: ' + (fol.length ? fol.map(k => 'P' + k).join(' ') : '—'), Math.floor(bw / 6.2)))}</text>`;
        });
        S.rep.slice(-12).forEach(r => { if (r.a >= nb || r.b >= nb) return; const p = clamp((t - r.t0) / Math.max(1, r.t1 - r.t0), 0, 1), xa = bx(r.a) + bw / 2, xb = bx(r.b) + bw / 2; ah += `<circle class="xr-dot" cx="${X1(xa + (xb - xa) * p)}" cy="459" r="3.5" style="fill:${kc}"/>`; });
        const tip = G.e.managed ? ['Копии лежат в трёх зонах — падение сервера ты не увидишь.', 'Подтверждение приходит, когда записали копии.']
          : G.kf ? [G.cnt === 1 ? 'Брокер один — у партиции одна копия. Упал сервер — пропало всё.' : G.acks === '0' ? 'acks=0: продюсер не ждёт ответа — быстро, но потерю не заметит.' : G.acks === '1' ? 'acks=1: ✓ сразу после записи у лидера. Пунктир — копии ещё нет.' : 'acks=all: ✓ только когда записали все копии. Пунктир — продюсер ждёт.', `У каждой партиции ${G.rf} ${pl(G.rf, 'копия', 'копии', 'копий')}${G.rf < 3 ? ' — для надёжности нужно 3 брокера.' : ' — падение брокера переживёт.'}`]
          : G.redis ? ['Redis Streams держит сообщения в памяти, на диск — раз в секунду.', 'Упадёт узел — пропадёт последняя секунда.'] : [`Подтверждение — когда записали ${G.quorum ? 'большинство узлов' : 'все узлы'}.`, G.quorum ? 'Один узел может упасть — очередь работает.' : 'Нужно 3 узла, чтобы пережить падение одного.'];
        ah += `<text class="xr-s" x="28" y="472">${tip[0]}</text><text class="xr-s" x="28" y="487">${tip[1]}</text>`;
        h += PG('acks', ah);
        // блок «повторы и DLQ»
        let dh = `<rect class="xr-zone" x="630" y="370" width="354" height="124" rx="10"/><text class="xr-t" x="642" y="390">Повторы и DLQ</text><text class="xr-m acc" x="972" y="390" text-anchor="end">разобрать ›</text>`;
        if (G.retries) {
          dh += `<rect class="xr-box" x="642" y="398" width="150" height="50" rx="8"/><text class="xr-s" x="652" y="413">пауза перед повтором</text>`;
          S.retry.slice(0, 4).forEach((r, i) => { const x = 656 + i * 32, f = clamp((t - r.from) / Math.max(1, r.at - r.from), 0, 1); dh += `<rect class="xq-b poi" x="${x}" y="422" width="24" height="16" rx="3"/><text class="xq-k d" x="${x + 12}" y="434" text-anchor="middle">☠</text><circle class="xq-ring" cx="${x + 12}" cy="430" r="14" style="stroke-dasharray:${X1(f * 88)} 90"/>`; });
          dh += `<rect class="xr-box ${S.dlqN ? 'hot' : ''}" x="804" y="398" width="168" height="50" rx="8"/><text class="xr-s" x="814" y="413">DLQ — ${S.dlqN} ${pl(S.dlqN, 'сообщение', 'сообщения', 'сообщений')}</text>`;
          S.dlq.slice(0, 5).forEach((m, i) => { const x = 814 + i * 30; dh += `<rect class="xq-b poi" x="${x}" y="422" width="26" height="16" rx="3"/><text class="xq-k d" x="${x + 13}" y="434" text-anchor="middle">${m.key}</text>`; });
          const d0 = S.dlq[0];
          dh += `<text class="xr-s" x="642" y="472">${d0 ? `«${word} ${d0.key}»: битый JSON, 3 попытки.` : 'Упало — пауза и ещё попытка. После 3 попыток —'}</text><text class="xr-s" x="642" y="487">${d0 ? 'Лежит в DLQ, пока человек не разберёт.' : 'в DLQ: отдельную очередь для разбора.'}</text>`;
        } else {
          const l2 = G.kf ? (G.sem === 'most' ? '— оно теряется: offset уже закоммичен;' : '— его читают снова и снова, партиция стоит;') : '— оно возвращается в очередь и крутится по кругу;';
          dh += `<text class="xr-s" x="642" y="414">Выключено. Если сообщение не обрабатывается:</text><text class="xr-s xq-bad" x="642" y="432">${l2}</text><text class="xr-s" x="642" y="456">Включи «Повторы + DLQ» в настройках справа:</text><text class="xr-s" x="642" y="472">пауза между попытками, после трёх — в DLQ,</text><text class="xr-s" x="642" y="487">отдельную очередь для разбора.</text>`;
        }
        h += PG('dlq', dh);
        h += drawFx(S);
        ctx.svg.innerHTML = h;
      }

      /* ================= блоки изнутри: у каждого своя маленькая модель ================= */
      const PV = { k: null, t: 0, s: {}, fx: [] };
      const pfx = (x, y, txt, cls) => PV.fx.push({ x, y, txt, cls, born: PV.t });
      const outName = () => G.outs.length ? ctx.nm(G.outs[0].n.id) : 'Обработчики';
      const QP = {};
      const PAT = [0, 1, 0, 2, 1, 0, 3, 2, 0, 1, 3, 2];
      const nextEv = s => {
        const j = PAT[s.i % PAT.length] % s.keys.length; s.i++;
        if ((s.st[s.keys[j]] || 0) >= STEPS.length) { const used = new Set(s.keys), nk = (s.pool || []).find(k => !used.has(k) && !(s.done || []).some(d => d.key === k)); if (nk != null) { s.pool = s.pool.filter(k => k !== nk).concat([s.keys[j]]); s.keys[j] = nk; s.col[nk] = s.nc++; } s.st[s.keys[j]] = 0; }
        const key = s.keys[j], n = s.st[key] || 0; s.st[key] = n + 1;
        if (s.col[key] == null) s.col[key] = s.nc++;
        return { key, n, ev: STEPS[n % STEPS.length], ci: s.col[key] };
      };

      /* журнал партиции и offset (Kafka) / очередь с ack (остальные) */
      QP.log = {
        tick(t) {
          const s = PV.s;
          if (!s.init) { Object.assign(s, { init: 1, end: 150, cells: [], gA: 148, gB: 141, nW: 300, nA: 700, nB: 0, fly: null, rd: [], q: [], inf: [], seq: 40, nT: 600, gone: [], back: -1e9 }); for (let o = 126; o < 150; o++) s.cells.push({ off: o, key: 10 + (o * 37) % 80 }); }
          if (G.kf) {
            if (t >= s.nW) { s.fly = { t0: t, key: 10 + Math.floor(Math.random() * 80) }; s.nW = t + 1000; }
            if (s.fly && t - s.fly.t0 >= 450) { s.cells.push({ off: s.end++, key: s.fly.key, born: t }); s.fly = null; if (s.cells.length > 30) s.cells.shift(); }
            if (t >= s.nA) { if (s.gA < s.end) { s.rd.push({ g: 0, off: s.gA, t0: t }); s.gA++; } s.nA = t + 850; }
            s.bStop = t % 14000 < 6000;
            if (!s.bStop && t >= s.nB) { if (s.gB < s.end) { s.rd.push({ g: 1, off: s.gB, t0: t }); s.gB++; } s.nB = t + 330; }
            s.rd = s.rd.filter(r => t - r.t0 < 500);
          } else {
            if (t >= s.nW) { if (s.q.length < 8) s.q.push({ id: ++s.seq }); s.nW = t + 1100; }
            if (t >= s.nT && s.inf.length < 2 && s.q.length) { const m = s.q.shift(); s.inf.push({ m, t0: t, silent: m.id % 4 === 0 && !m.again }); s.nT = t + 500; }
            s.inf = s.inf.filter(f => {
              if (!f.silent && t - f.t0 >= 1400) { s.gone.push({ m: f.m, t0: t }); return false; }
              if (f.silent && t - f.t0 >= 3200) { f.m.again = true; s.q.unshift(f.m); s.back = t; return false; }
              return true;
            });
            s.gone = s.gone.filter(x => t - x.t0 < 1000);
          }
        },
        draw(t) {
          const s = PV.s, kc = KJ();
          let h = '';
          if (G.kf) {
            const N = 16, x0 = 96, W = 52, base = s.end - N, cx = off => x0 + (off - base) * W;
            h += T(20, 30, 'Партиция P0 изнутри — журнал: сообщения только дописываются в конец и получают номер (offset)', 'xr-t');
            h += R(20, 62, 186, 62) + T(32, 86, 'Продюсер', 'xr-t xq-sm') + T(32, 106, 'дописывает ≈ 1 в секунду');
            h += T(x0, 140, '← старое удаляет срок хранения (retention), а не чтение') + T(x0 + N * W - 6, 140, `конец журнала: ${s.end}`, 'xr-m acc', 'end');
            s.cells.filter(c => c.off >= base).forEach(c => {
              const x = cx(c.off), w = W - 6;
              h += `<rect class="xq-b ${c.off < base + 3 ? 'xq-old' : ''}" x="${x}" y="150" width="${w}" height="46" rx="4" style="fill:${kc}"/>${T(x + w / 2, 178, String(c.key), 'xq-k lg', 'middle')}${T(x + w / 2, 214, String(c.off), 'xr-m', 'middle')}`;
              if (c.born && t - c.born < 700) h += `<rect class="xr-hl" x="${x - 3}" y="147" width="${W}" height="52" rx="6"/>`;
            });
            h += T(x0 - 8, 214, 'offset', 'xr-s', 'end');
            if (s.fly) { const p = clamp((t - s.fly.t0) / 450, 0, 1); h += `<circle class="xr-dot" cx="${X1(206 + (x0 + N * W - 30 - 206) * p)}" cy="${X1(94 + 79 * p)}" r="6" style="fill:${kc}"/>`; }
            [[s.gA, 238, 'группа 1', 'acc'], [s.gB, 268, 'группа 2', 'warn']].forEach(([off, y, nm, cl]) => {
              const raw = cx(off) + (W - 6) / 2, x = clamp(raw, x0 - 14, x0 + N * W - 10);
              h += `<path class="xq-tri ${cl}" d="M${X1(x)},${y - 16} l-7,12 h14 z"/>${T(x, y + 10, `${nm}: offset ${off}${raw < x0 ? ' ◀' : ''}`, 'xr-m ' + cl, 'middle')}`;
            });
            [[90, s.gA, outName(), 'читает в темпе записи', false], [530, s.gB, 'Аналитика (для примера)', s.bStop ? 'остановлена — сообщения ждут её в журнале' : 'догоняет со своего offset', s.bStop]].forEach(([x, off, name, st, hot]) => {
              const lag = s.end - off;
              h += R(x, 318, 380, 80, 'xr-box' + (hot ? ' hot' : '')) + T(x + 14, 340, `Группа «${esc(cut(name, 34))}»`, 'xr-t xq-sm') + T(x + 14, 362, `offset ${off} · лаг = ${s.end} − ${off} = ${lag}`, 'xr-m ' + (lag > 6 ? 'warn' : 'ok')) + T(x + 14, 384, st);
            });
            if (s.end - s.gB > 0) { const xa = clamp(cx(s.gB), x0, x0 + N * W), xb = x0 + N * W - 6; h += `<path class="xq-brace" d="M${X1(xa)},298 v6 H${X1(xb)} v-6"/>` + T((xa + xb) / 2, 296, `не прочитано группой 2: ${s.end - s.gB}`, 'xr-m warn', 'middle'); }
            s.rd.forEach(r => { const p = clamp((t - r.t0) / 500, 0, 1), xa = clamp(cx(r.off) + (W - 6) / 2, x0, x0 + N * W), xb = r.g ? 720 : 280; h += `<circle class="xr-dot" cx="${X1(xa + (xb - xa) * p)}" cy="${X1(198 + 120 * p)}" r="4.5" style="fill:${kc}"/>`; });
            h += T(20, 444, 'Прочитанное не удаляется: каждая группа помнит свой offset — номер следующего сообщения.') + T(20, 464, 'Лаг = конец журнала − offset группы. Offset можно перемотать назад и перечитать историю.');
            return h;
          }
          h += T(20, 30, `${esc(G.e.name)} изнутри: сообщение живёт, пока обработчик не подтвердит его (ack)`, 'xr-t');
          h += R(20, 126, 130, 58) + T(32, 150, 'Продюсер', 'xr-t xq-sm') + T(32, 168, 'кладёт в хвост');
          h += `<rect class="xq-lane" x="170" y="130" width="384" height="52" rx="6"/>` + T(170, 122, 'хвост') + T(554, 122, 'голова — выдаётся первой', 'xr-s', 'end');
          s.q.slice(0, 8).forEach((m, i) => { const x = 170 + 8 + (7 - i) * 46; h += `<rect class="xq-b ${m.again ? 'again' : ''}" x="${x}" y="140" width="40" height="32" rx="4" style="fill:${kc}"/>${T(x + 20, 161, '#' + m.id, 'xq-k', 'middle')}`; });
          h += R(600, 96, 380, 160) + T(614, 118, `В работе у «${esc(cut(outName(), 24))}» — ack ещё нет`, 'xr-t xq-sm');
          s.inf.forEach((f, i) => {
            const x = 620 + i * 180, el = t - f.t0, mute = f.silent && el > 1400;
            h += `<rect class="xq-b ${mute ? 'poi' : ''}" x="${x}" y="134" width="56" height="40" rx="5" style="${mute ? '' : 'fill:' + kc}"/>${T(x + 28, 158, '#' + f.m.id, mute ? 'xq-k d' : 'xq-k', 'middle')}`;
            h += T(x + 66, 150, mute ? 'молчит: ack нет' : 'обрабатывает…', 'xr-s' + (mute ? ' xq-warn' : '')) + T(x + 66, 168, f.silent ? `таймаут ${sec(Math.max(0, 3200 - el))}` : `ack через ${sec(Math.max(0, 1400 - el))}`, 'xr-m');
            if (f.silent) h += `<circle class="xq-ring" cx="${x + 28}" cy="154" r="26" style="stroke-dasharray:${X1(clamp(el / 3200, 0, 1) * 164)} 170"/>`;
          });
          h += T(614, 236, 'Таймер у молчащего — таймаут видимости: не успел — сообщение вернётся.', 'xr-s');
          h += R(600, 280, 380, 80, 'xq-frame') + T(614, 302, '✓ ack пришёл → брокер удалил сообщение навсегда', 'xr-s xq-okt');
          s.gone.forEach((g, i) => { const a = X1(Math.max(0, 1 - (t - g.t0) / 1000)); h += `<g style="opacity:${a}"><rect class="xq-b ok" x="${620 + i * 52}" y="316" width="44" height="28" rx="4"/>${T(642 + i * 52, 335, '#' + g.m.id, 'xq-k', 'middle')}</g>`; });
          if (t - s.back < 1600) h += T(362, 222, '↺ ack не пришёл вовремя — сообщение снова в очереди и придёт ещё раз', 'xr-pop warn', 'middle');
          h += T(20, 420, 'Подтверждённое удаляется: перечитать историю, как в Kafka, нельзя.');
          h += T(20, 440, G.e.managed ? 'SQS: пока идёт таймаут видимости, другие потребители сообщение не видят.' : 'Чтобы двум сервисам получить одно и то же, обменник (exchange) кладёт копию в очередь каждого.');
          h += T(20, 460, 'Потребитель упал, не подтвердив, — сообщение вернётся. Поэтому доставка «хотя бы один раз».');
          return h;
        },
        now() {
          const s = PV.s;
          if (G.kf) return `<b>Журнал партиции P0.</b> Конец журнала — ${s.end}. Группа «${esc(outName())}» на offset ${s.gA}, лаг ${s.end - s.gA}. Вторая группа на ${s.gB}, лаг ${s.end - s.gB}${s.bStop ? ' — она стоит, но сообщения ждут её в журнале: чтение их не удаляет' : ' — догоняет со своего места, первой группе не мешает'}.`;
          const sl = s.inf.find(f => f.silent);
          return `<b>Очередь с подтверждением.</b> Ждут: ${s.q.length}, в работе: ${s.inf.length}. ${sl ? `#${sl.m.id} взяли и молчат — через ${sec(Math.max(0, 3200 - (PV.t - sl.t0)))} брокер вернёт его в очередь.` : 'Подтвердил (ack) — брокер удалил сообщение навсегда.'}`;
        }
      };

      /* выбор партиции по ключу */
      QP.key = {
        tick(t) {
          const s = PV.s;
          if (!s.init) {
            const Pc = G.kf ? Math.min(G.Pn, 6) : 1;
            const all = [17, 42, 8, 23, 31, 56, 64, 77, 90, 12, 35, 49, 68, 81, 26, 53, 70, 94].filter(k => !G.kf || hsh(k) % G.Pn < Pc);
            const dist = all.filter((k, i) => all.findIndex(x => hsh(x) % Math.max(1, G.Pn) === hsh(k) % Math.max(1, G.Pn)) === i);
            const keys = dist.concat(all.filter(k => !dist.includes(k))).slice(0, 4);
            Object.assign(s, { init: 1, Pc, keys, pool: all.filter(k => !keys.includes(k)), col: {}, nc: 0, i: 0, t0: -1e9, cols: Array.from({ length: Pc }, () => []), st: {}, cur: null, q: [], c: [{ m: null, d: 1700 }, { m: null, d: 600 }], done: [], nA: 0 });
          }
          if (G.kf) {
            if (t - s.t0 >= 1800) {
              if (s.cur) { const col = s.cols[s.cur.part]; if (col) { col.push(s.cur); if (col.length > 7) col.shift(); } }
              const e = nextEv(s); e.h = hsh(e.key); e.part = e.h % G.Pn; s.cur = e; s.t0 = t;
            }
            return;
          }
          if (t >= s.nA) { if (s.q.length < 7) s.q.push(nextEv(s)); s.nA = t + 1000; }
          s.c.forEach((c, i) => {
            if (c.m && t >= c.until) { const m = c.m; m.late = s.done.some(d => d.key === m.key && d.n > m.n); m.by = i; s.done.unshift(m); s.done = s.done.slice(0, 11); c.m = null; }
            if (!c.m && s.q.length) { const busy = G.e.order === 'group' ? s.c.filter(x => x.m).map(x => x.m.key) : []; const j = s.q.findIndex(m => !busy.includes(m.key)); if (j >= 0) { c.m = s.q.splice(j, 1)[0]; c.t0 = t; c.until = t + c.d * (0.7 + Math.random() * 0.6); } }
          });
        },
        draw(t) {
          const s = PV.s;
          let h = '';
          if (G.kf) {
            const e = s.cur, p = clamp((t - s.t0) / 1800, 0, 1), ph = p < 0.22 ? 0 : p < 0.47 ? 1 : p < 0.72 ? 2 : 3;
            h += T(20, 30, 'Как сообщение выбирает партицию: ключ → хеш → остаток от деления', 'xr-t');
            if (e) {
              h += R(20, 50, 200, 96, 'xr-box sel') + `<rect x="34" y="64" width="14" height="14" rx="3" style="fill:${kcol(e.ci)}"/>` + T(56, 76, `ключ: ${word} ${e.key}`, 'xr-t xq-sm') + T(34, 100, `событие: ${e.ev}`) + T(34, 124, `${e.n + 1}-е событие этого ${word === 'товар' ? 'товара' : 'заказа'}`, 'xr-m');
              h += `<path class="xr-wire ${ph >= 1 ? 'act' : ''}" d="M220,98 H250"/>` + R(250, 50, 210, 96, 'xr-box' + (ph >= 1 ? ' sel' : '')) + T(264, 74, `hash(«${word} ${e.key}»)`, 'xr-m') + T(264, 108, ph >= 1 ? `= ${e.h}` : '= ?', 'xq-big') + T(264, 132, 'одинаковый ключ → одно число');
              h += `<path class="xr-wire ${ph >= 2 ? 'act' : ''}" d="M460,98 H490"/>` + R(490, 50, 210, 96, 'xr-box' + (ph >= 2 ? ' sel' : '')) + T(504, 74, `${e.h} % ${G.Pn} — партиций ${G.Pn}`, 'xr-m') + T(504, 108, ph >= 2 ? `= ${e.part} → P${e.part}` : '= ?', 'xq-big') + T(504, 132, 'остаток — номер партиции');
              const n2 = G.Pn + 1, p2 = e.h % n2, same = p2 === e.part;
              h += R(730, 50, 250, 96, 'xq-frame') + T(744, 72, `А если партиций станет ${n2}?`, 'xr-t xq-sm') + T(744, 96, `${e.h} % ${n2} = ${p2} → P${p2}`, 'xr-m ' + (same ? 'ok' : 'warn')) + T(744, 118, same ? 'повезло: та же партиция' : 'ключ переедет в другую', same ? 'xr-s' : 'xr-s xq-warn') + T(744, 136, same ? '' : 'партицию — порядок на стыке сломается', 'xr-s xq-warn');
            }
            const cw = 960 / s.Pc;
            s.cols.forEach((col, k) => {
              const x = 20 + k * cw, hot = e && e.part === k && ph >= 2;
              h += `<rect class="xq-lane ${hot ? 'hl' : ''}" x="${X1(x)}" y="170" width="${X1(cw - 10)}" height="268" rx="8"/>` + T(x + 12, 192, `P${k}`, 'xr-t');
              col.forEach((m, i) => { const y = 206 + i * 30; h += `<rect x="${X1(x + 12)}" y="${y}" width="12" height="12" rx="3" style="fill:${kcol(m.ci)}"/>${T(x + 30, y + 10.5, `${cw > 170 ? word + ' ' : ''}${m.key} · ${m.ev}`, 'xr-s')}`; });
            });
            if (e && ph === 3 && s.cols[e.part]) { const col = s.cols[e.part], q = (p - 0.72) / 0.28, xb = 20 + e.part * cw + 18, yb = 212 + col.length * 30; h += `<circle class="xr-dot" cx="${X1(600 + (xb - 600) * q)}" cy="${X1(146 + (yb - 146) * q)}" r="6" style="fill:${kcol(e.ci)}"/>`; }
            h += T(20, 462, `Цвет — ключ. Один цвет всегда в одной колонке, и внутри неё события идут по порядку.${G.Pn > s.Pc ? ` Показаны ${s.Pc} из ${G.Pn} партиций.` : ''}`);
            h += T(20, 482, 'Между партициями порядка нет: их читают разные потребители, каждый в своём темпе.');
            return h;
          }
          h += T(20, 30, `${esc(G.e.name)}: партиций нет — одна очередь, кто свободен, тот и берёт`, 'xr-t');
          h += `<rect class="xq-lane" x="20" y="74" width="444" height="60" rx="8"/>` + T(20, 66, 'очередь (голова справа)');
          s.q.slice(0, 7).forEach((m, i) => { const x = 20 + 444 - (i + 1) * 63; h += `<rect class="xq-b" x="${x + 4}" y="82" width="57" height="44" rx="5" style="fill:${kcol(m.ci)}"/>${T(x + 32, 101, String(m.key), 'xq-k', 'middle')}${T(x + 32, 117, m.ev.slice(0, 8), 'xq-k', 'middle')}`; });
          s.c.forEach((c, i) => {
            const y = 60 + i * 120, m = c.m;
            h += R(500, y, 260, 100) + T(514, y + 22, `Потребитель ${i + 1} · ${i ? 'быстрый' : 'медленный'}`, 'xr-t xq-sm');
            if (m) { const f = clamp((t - c.t0) / Math.max(1, c.until - c.t0), 0, 1); h += `<rect x="514" y="${y + 34}" width="12" height="12" rx="3" style="fill:${kcol(m.ci)}"/>` + T(532, y + 44, `${word} ${m.key} · ${m.ev}`) + `<rect class="xr-bar" x="514" y="${y + 70}" width="232" height="4" rx="2"/><rect class="xr-bar-f acc" x="514" y="${y + 70}" width="${X1(232 * f)}" height="4" rx="2"/>`; }
            else h += T(514, y + 50, 'свободен');
          });
          h += R(790, 50, 190, 400, 'xq-frame') + T(802, 72, 'Порядок готовности', 'xr-t xq-sm');
          s.done.forEach((m, i) => { const y = 88 + i * 32; h += `<rect x="802" y="${y}" width="12" height="12" rx="3" style="fill:${kcol(m.ci)}"/>${T(820, y + 10.5, `${m.key} · ${m.ev}`, 'xr-s' + (m.late ? ' xq-warn' : ''))}${m.late ? T(820, y + 24, '⚠ раньше него готово следующее', 'xr-s xq-warn') : ''}`; });
          h += T(20, 300, G.e.order === 'group' ? 'SQS FIFO: пока событие ключа в работе, следующее того же ключа' : 'Быстрый потребитель может закончить «оплачен»,');
          h += T(20, 320, G.e.order === 'group' ? 'никому не выдаётся. Порядок по ключу сохранён.' : 'пока медленный ещё делает «создан» того же заказа.');
          h += T(20, 340, G.e.order === 'group' ? '' : 'Порядок между потребителями не гарантирован.', 'xr-s xq-warn');
          return h;
        },
        now() {
          const s = PV.s, e = s.cur;
          if (G.kf) return e ? `<b>Ключ «${word} ${e.key}», событие «${e.ev}».</b> hash = ${e.h}, ${e.h} % ${G.Pn} = ${e.part} — значит, партиция P${e.part}. Все события этого ключа ложатся туда же и читаются по порядку.` : '';
          const late = s.done.filter(m => m.late).length;
          return G.e.order === 'group' ? '<b>FIFO по ключу.</b> Событие ключа не выдаётся, пока предыдущее того же ключа в работе — порядок цел, но параллельность по одному ключу пропадает.' : `<b>Партиций нет — нет и порядка.</b> Два потребителя берут из одной очереди. ${late ? `Уже ${late} раз событие закончилось позже следующего события того же ключа (⚠).` : 'Скоро быстрый обгонит медленного — смотри на ⚠ справа.'}`;
        }
      };

      /* группа потребителей и ребаланс */
      QP.group = {
        tick() { const s = PV.s; if (!s.init) { const ms = S.mem.slice(0, 6).map(m => `${m.name} #${m.i + 1}`); Object.assign(s, { init: 1, ms: ms.length ? ms : ['Обработчик #1', 'Обработчик #2'] }); } },
        draw(t) {
          const s = PV.s, ms = s.ms, M = ms.length, Pv = G.kf ? Math.min(G.Pn, 8) : 1, p = t % 14000;
          const dead0 = p >= 4000 && p < 11000, excl = G.kf ? p >= 7000 && p < 11000 : dead0, reb = G.kf && ((p >= 7000 && p < 8500) || (p >= 11000 && p < 12000));
          const inGroup = ms.map((_, i) => i).filter(i => !(i === 0 && excl)), act = G.kf ? inGroup.slice(0, G.Pn) : inGroup;
          const own = Array.from({ length: Pv }, (_, k) => act.length ? act[k % act.length] : -1);
          const py = k => 130 + (k + 0.5) * (310 / Pv), my = i => 130 + (i + 0.5) * (310 / M);
          let h = T(20, 30, G.kf ? 'Группа потребителей: одну партицию читает один участник' : 'Без групп: все берут из одной очереди, кто свободен', 'xr-t');
          const ct = p < 4000 ? 'все шлют «я жив» — порядок' : p < 7000 ? `#1 молчит ${sec(p - 4000)} из 3 с` : p < 8500 ? 'ребаланс: все отдают партиции' : p < 11000 ? 'партиции розданы живым' : p < 12000 ? '#1 вернулся — снова ребаланс' : 'прежняя раскладка';
          if (G.kf) h += R(350, 46, 300, 60, 'xr-box' + (reb ? ' hot' : '')) + T(500, 70, 'Координатор группы (на брокере)', 'xr-t xq-sm', 'middle') + T(500, 92, ct, 'xr-s' + (p >= 4000 && p < 8500 ? ' xq-warn' : ''), 'middle');
          for (let k = 0; k < Pv; k++) h += `<rect class="xq-lane" x="60" y="${X1(py(k) - 15)}" width="150" height="30" rx="6"/>` + T(74, py(k) + 5, G.kf ? `Партиция P${k}` : 'Очередь', 'xr-t xq-sm');
          for (let k = 0; k < Pv; k++) { const i = own[k]; if (i < 0) continue; const dead = i === 0 && dead0; h += `<path class="xr-wire ${reb ? 'dash' : dead ? 'xq-wbad' : 'act'}" d="M210,${X1(py(k))} C450,${X1(py(k))} 480,${X1(my(i))} 720,${X1(my(i))}"/>`; }
          if (G.kf && !act.length) h += T(300, 300, 'Никто не читает — лаг растёт, пока участник не вернётся', 'xr-pop bad');
          ms.forEach((nm, i) => {
            const y = my(i), dead = i === 0 && dead0, idle = G.kf && !own.includes(i) && !dead;
            const st = dead ? (G.kf ? (p < 7000 ? 'упал — сигналов нет' : 'исключён из группы') : 'упал — его сообщение вернётся по таймауту') : reb ? 'ребаланс: ждёт раскладку' : idle ? 'партиции не досталось — ждёт' : G.kf ? 'читает ' + own.map((o, k) => o === i ? 'P' + k : null).filter(Boolean).join(' ') : 'берёт из очереди';
            h += R(720, y - 22, 250, 44, 'xr-box' + (dead ? ' bad dead' : idle ? ' xq-idle' : '')) + T(732, y - 4, esc(cut(nm, 26)), 'xr-t xq-sm') + T(732, y + 13, st, 'xr-s' + (dead ? ' xq-bad' : reb ? ' xq-warn' : ''));
            if (G.kf && !dead) { const q = ((t + i * 170) % 1000) / 400; if (q < 1) h += `<circle class="xr-dot ok" cx="${X1(720 + (650 - 720) * q)}" cy="${X1(y + (90 - y) * q)}" r="3.5"/>`; }
            if (G.kf && i === 0 && p >= 4000 && p < 7000) h += `<circle class="xq-ring" cx="966" cy="${X1(y)}" r="14" style="stroke-dasharray:${X1((p - 4000) / 3000 * 88)} 90"/>`;
          });
          h += T(20, 470, G.kf ? `Партиций ${G.Pn}, участников ${S.W}${S.W > G.Pn ? ` — ${S.W - G.Pn} лишних ждут` : ''}. Зелёные точки — «я жив» координатору. Таймаут на схеме 3 с, в жизни 45 с.` : 'Ребаланса нет: упавший просто перестаёт брать сообщения, его неподтверждённое вернётся по таймауту.');
          h += T(20, 490, G.kf ? 'Пока идёт ребаланс, вся группа не читает: частые ребалансы — частая причина лага.' : 'Зато нет и порядка: два участника могут обрабатывать события одного заказа одновременно.');
          return h;
        },
        now() {
          const p = PV.t % 14000, nm = esc(PV.s.ms ? PV.s.ms[0] : '');
          if (!G.kf) return `<b>Конкурирующие потребители.</b> ${p >= 4000 && p < 11000 ? `«${nm}» упал — остальные продолжают брать сообщения, без паузы.` : 'Все берут из одной очереди: кто свободен, тот и взял.'}`;
          return p < 4000 ? '<b>Всё спокойно.</b> Каждый участник раз в секунду шлёт координатору «я жив», у каждой партиции — свой читатель.' : p < 7000 ? `<b>«${nm}» упал и замолчал.</b> Координатор ещё ждёт: вдруг это пауза. Его партиции сейчас никто не читает — лаг растёт.` : p < 8500 ? '<b>Ребаланс.</b> Таймаут вышел — участника исключили. Все отдают партиции, координатор раскладывает заново. Чтение стоит.' : p < 11000 ? '<b>Партиции упавшего переехали к живым</b>' + (S.W > G.Pn ? ' — и простаивавший участник наконец получил работу.' : '. Нагрузка на каждого выросла.') : `<b>«${nm}» вернулся</b> — и это снова ребаланс: раскладка меняется ещё раз.`;
        }
      };

      /* acks и копии партиции */
      QP.acks = {
        tick(t) {
          const s = PV.s, mode = G.kf ? G.acks : G.redis ? '1' : 'q';
          if (!s.init) { const rf = G.e.managed ? 3 : G.kf ? G.rf : Math.min(3, G.cnt); Object.assign(s, { init: 1, rf, logs: Array.from({ length: rf }, () => [52, 53, 54, 55, 56, 57, 58, 59]), lead: 0, dead: -1, end: 60, msgs: [], nS: 500, crashAt: 6500, armed: false, crashT: 0, revT: 0, lost: [], sent: 0, acked: 0, lostN: 0, resN: 0, last: '', trunc: -1e9 }); }
          if (!s.armed && !s.crashT && !s.revT && t >= s.crashAt) s.armed = true;
          if (t >= s.nS) { s.msgs.push({ t0: t, st: 'fly', acked: mode === '0' }); s.nS = t + 1500; s.sent++; if (mode === '0') s.acked++; }
          s.msgs.forEach(m => {
            if (m.st === 'fly' && t - m.t0 >= 350) {
              if (s.dead === s.lead) { if (mode === '0') { m.st = 'gone'; s.lostN++; s.last = 'acks=0: сообщение ушло к упавшему лидеру — пропало молча.'; } else { m.t0 = t + 400; m.re = true; } return; }
              m.off = s.end++; s.logs[s.lead].push(m.off); m.tl = t; m.st = 'lead'; m.lead = s.lead;
              m.fol = s.logs.map((_, b) => b).filter(b => b !== s.lead && b !== s.dead).map((b, j) => ({ b, at: t + 450 + j * 350 }));
              if (s.armed) { s.armed = false; s.crashT = t + 160; }
            }
            if (m.st === 'lead') m.fol.forEach(f => { if (!f.ok && t >= f.at && s.dead !== m.lead && s.dead !== f.b && s.logs[m.lead].includes(m.off)) { s.logs[f.b].push(m.off); f.ok = true; } });
            if (!m.acked && m.st === 'lead') {
              const copies = 1 + m.fol.filter(f => f.ok).length, need = mode === '1' ? 1 : mode === 'all' ? 1 + m.fol.length : Math.floor(s.rf / 2) + 1;
              if (copies >= need && s.dead !== m.lead) { m.acked = true; s.acked++; pfx(176, 210, '✓', 'ok'); }
            }
          });
          if (s.crashT && t >= s.crashT) {
            const old = s.lead; s.crashT = 0; s.dead = old; s.revT = t + 3600; s.lost = [];
            if (s.rf === 1) s.last = 'Копий нет: партиция недоступна, пока брокер не вернётся. Умрёт диск — пропадёт всё.';
            else {
              const cand = s.logs.map((_, b) => b).filter(b => b !== old), nl = cand.reduce((a, b) => s.logs[b].length > s.logs[a].length ? b : a, cand[0]);
              let res = 0;
              s.logs[old].filter(o => !s.logs[nl].includes(o)).forEach(o => {
                const m = s.msgs.find(x => x.off === o);
                if (m && m.acked) { s.lost.push(o); s.lostN++; } else if (m) { m.st = 'fly'; m.t0 = t + 500; m.re = true; res++; s.resN++; }
              });
              s.lead = nl; s.end = s.logs[nl][s.logs[nl].length - 1] + 1;
              s.logs.forEach((l, b) => { if (b !== old && b !== nl) s.logs[b] = s.logs[nl].slice(); });  // копии догоняют нового лидера
              s.last = s.lost.length ? `Сразу после записи ${s.lost.join(', ')} — копии не успели забрать, а ✓ уже ушёл: потеряно.` : res ? 'Номер без копий ещё не получил ✓ — продюсер отправил его снова. Потерь нет.' : 'Всё уже было в копиях — потерь нет.';
            }
          }
          if (s.revT && t >= s.revT) { const old = s.dead; s.dead = -1; s.revT = 0; if (s.rf > 1) s.logs[old] = s.logs[old].filter(o => s.logs[s.lead].includes(o)); s.trunc = t; s.truncB = old; s.lost = []; s.crashAt = t + 8000; }
          s.msgs = s.msgs.filter(m => m.st === 'fly' || t - m.t0 < 6000);
          s.logs = s.logs.map(l => l.slice(-14));
        },
        draw(t) {
          const s = PV.s, kc = KJ(), mode = G.kf ? G.acks : G.redis ? '1' : 'q';
          let h = T(20, 30, G.kf ? `Партиция P0: лидер и копии · acks=${G.acks}` : `${esc(G.e.name)}: копии очереди на узлах`, 'xr-t');
          const cur = s.msgs.filter(m => !m.acked && m.st !== 'gone').slice(-1)[0];
          h += R(20, 170, 150, 120) + T(32, 192, 'Продюсер', 'xr-t xq-sm') + T(32, 212, mode === '0' ? 'acks=0: не ждёт' : mode === '1' ? 'acks=1: ждёт лидера' : mode === 'all' ? 'acks=all: ждёт копии' : 'ждёт большинство', 'xr-m') + T(32, 234, cur ? `ждёт ✓ ${sec(Math.max(0, t - cur.t0))}` : mode === '0' ? 'отправил и забыл' : 'получил ✓', 'xr-s' + (cur ? ' xq-warn' : '')) + T(32, 256, `отправил ${s.sent}, ✓ ${s.acked}`) + T(32, 276, `потеряно ${s.lostN}`, 'xr-s' + (s.lostN ? ' xq-bad' : ''));
          const bw = 236, bx = b => 196 + b * 258, maxEnd = Math.max(...s.logs.map(l => l.length ? l[l.length - 1] + 1 : 0)), base = maxEnd - 8;
          const hw = Math.min(...s.logs.map((l, b) => b === s.dead ? Infinity : (l[l.length - 1] != null ? l[l.length - 1] : 0)));
          s.logs.forEach((l, b) => {
            const x = bx(b), lead = b === s.lead, dead = b === s.dead;
            h += R(x, 58, bw, 232, 'xr-box' + (dead ? ' bad dead' : lead ? ' sel' : '')) + T(x + 12, 80, `${G.e.managed ? 'Зона ' + 'ABC'[b] : G.kf ? 'Брокер ' + (b + 1) : 'Узел ' + (b + 1)} · ${dead ? 'упал' : lead ? 'лидер' : 'копия'}`, 'xr-t xq-sm') + T(x + 12, 98, lead ? 'принимает запись' : dead ? 'не отвечает' : 'забирает новое у лидера');
            for (let j = 0; j < 8; j++) {
              const o = base + j, has = l.includes(o), lost = has && dead && s.lost.includes(o), x1 = x + 12 + j * 27;
              h += `<rect class="${has ? 'xq-b' + (lost ? ' err' : '') : 'xq-cell'}" x="${x1}" y="114" width="23" height="36" rx="3" style="${has && !lost ? 'fill:' + kc : ''}"/>` + T(x1 + 11.5, 166, String(o), 'xr-m', 'middle');
              if (o === hw && b !== s.dead) h += `<line class="xq-hw" x1="${x1 + 25}" y1="108" x2="${x1 + 25}" y2="156"/>`;
            }
            h += T(x + 12, 194, `последний номер: ${l.length ? l[l.length - 1] : '—'}`, 'xr-m') + T(x + 12, 214, lead ? (mode === '1' ? 'записал → ✓ продюсеру' : 'записал, ждёт копии') : dead ? '' : 'пунктир — ещё не забрала');
            if (b === s.truncB && t - s.trunc < 2500) h += T(x + 12, 270, 'вернулся: отрезал лишнее', 'xr-s xq-warn');
          });
          for (let b = s.rf; b < 3 && !G.e.managed; b++) h += R(bx(b), 58, bw, 232, 'xr-box xq-idle') + T(bx(b) + 12, 80, `${G.kf ? 'Брокер' : 'Узел'} ${b + 1} — нет`, 'xr-t xq-sm') + T(bx(b) + 12, 100, 'здесь могла быть копия') + T(bx(b) + 12, 120, `брокеров: ${G.cnt} — поставь 3`, 'xr-s xq-warn');
          s.msgs.forEach(m => {
            if (m.st === 'fly' && t >= m.t0) { const q = clamp((t - m.t0) / 350, 0, 1), xb = bx(s.lead) + bw / 2; h += `<circle class="xr-dot ${m.re ? 'xq-re' : ''}" cx="${X1(170 + (xb - 170) * q)}" cy="${X1(230 + (132 - 230) * q)}" r="6" style="fill:${kc}"/>`; }
            if (m.st === 'lead') m.fol.forEach(f => { if (f.ok || s.dead === m.lead) return; const q = clamp((t - m.tl) / Math.max(1, f.at - m.tl), 0, 1), xa = bx(m.lead) + bw / 2, xb = bx(f.b) + bw / 2; h += `<circle class="xr-dot" cx="${X1(xa + (xb - xa) * q)}" cy="240" r="5" style="fill:${kc}"/>`; });
          });
          if (s.rf > 1) h += T(196, 314, `high watermark = ${isFinite(hw) ? hw : '—'}: потребители видят сообщения только до этого номера — он есть во всех живых копиях`, 'xr-s');
          if (s.dead >= 0 || t - s.trunc < 2500) h += T(590, 344, s.dead >= 0 ? (s.rf > 1 ? 'Лидер упал. ' : '') + s.last : 'Старый лидер вернулся, отрезал у себя то, чего нет у нового, и стал копией.', 'xr-pop ' + (s.lost.length || s.rf === 1 ? 'bad' : 'warn'), 'middle');
          const ex = { 0: ['acks=0: продюсер отправил и забыл — ✓ не ждёт вовсе.', 'Быстрее всего, но если лидер упал, сообщение пропало молча.', 'Годится для метрик и логов, где потеря точки не страшна.'], 1: ['acks=1: ✓ — как только лидер записал у себя. Копии догоняют чуть позже (пунктир).', 'Окно риска: лидер упал до копирования — сообщение пропало, а продюсер считает его доставленным.', 'Раз в цикл лидер падает сразу после записи — смотри на красное.'], all: ['acks=all: ✓ — только когда сообщение есть во всех синхронных копиях (ISR).', 'Дольше на время копирования, зато подтверждённое не теряется.', 'Неподтверждённое продюсер отправит снова; с enable.idempotence дубля не будет.'], q: ['Кворумная очередь: подтверждение, когда записали большинство узлов.', 'Один узел упал — большинство живо, очередь работает и ничего не теряет.', `Узлов сейчас: ${G.cnt}.${G.cnt < 3 ? ' Для кворума нужно 3.' : ''}`] }[mode];
          if (G.redis) ex.splice(0, 3, 'Redis Streams: запись — в память, копии догоняют без ожидания.', 'Подтверждение приходит сразу: упадёт узел — пропадёт то, что копии не успели забрать.', 'Для заказов и денег лучше брокер с кворумом или Kafka с acks=all.');
          h += T(20, 404, ex[0], 'xr-s') + T(20, 424, ex[1], 'xr-s') + T(20, 444, s.rf === 1 ? 'Брокер один — копий нет. Поставь 3 брокера (настройка справа).' : ex[2], 'xr-s' + (s.rf === 1 ? ' xq-warn' : ''));
          return h;
        },
        now() {
          const s = PV.s, mode = G.kf ? G.acks : G.redis ? '1' : 'q', last = s.msgs.filter(m => m.st === 'lead').slice(-1)[0];
          if (s.dead >= 0) return `<b>Лидер упал.</b> ${s.last}`;
          if (!last) return '<b>Продюсер отправляет сообщение лидеру.</b>';
          const cp = 1 + last.fol.filter(f => f.ok).length;
          return `<b>Сообщение ${last.off}: копий ${cp} из ${s.rf}.</b> ${last.acked ? (mode === '0' ? 'Продюсер ответа и не ждал.' : 'Продюсер уже получил ✓.') : 'Продюсер ждёт ✓.'} ${mode === '1' && cp < s.rf ? 'Если лидер упадёт сейчас — оно пропадёт, хотя ✓ уже был.' : mode === 'all' && cp < s.rf ? 'Если лидер упадёт сейчас — ✓ не было, продюсер повторит.' : ''}`;
        }
      };

      /* коммит offset и семантика доставки */
      QP.sem = {
        tick(t) { PV.s.init = 1; if (t >= 9000) ctx.done('blk'); },
        draw(t) {
          const p = t % 9000;
          const st = (id, i) => {
            if (p < 900) return i === 0 ? 'act' : '';
            if (p < 1800) return i === 0 ? 'done' : i === 1 ? (id === 'exactly' && p > 1500 ? 'bad' : 'act') : '';
            if (p < 2800) return i === 0 ? 'done' : i === 1 ? (id === 'exactly' ? 'bad' : 'done') : '';
            if (id === 'most') return i === 2 ? 'bad' : 'done';
            if (id === 'least') return i === 1 ? (G.dedup ? 'done' : 'warn') : i === 2 && p < 4200 ? 'act' : 'done';
            return i === 1 && p < 4200 ? 'act' : 'done';
          };
          let h = T(20, 30, 'Коммит offset — отметка «досюда дочитал». Когда её ставить: до обработки или после?', 'xr-t');
          [['most', 'At-most-once', '«отметился, потом сделал»'], ['least', 'At-least-once', '«сделал, потом отметился»'], ['exactly', 'Exactly-once', '«сделал и отметился разом»']].forEach(([id, name, phr], r) => {
            const y = 46 + r * 136, on = G.sem === id;
            const steps = id === 'most' ? [['взять #41', 150], ['коммит: дочитал до 42', 196], ['обработать #41', 150]] : id === 'least' ? [['взять #41', 150], ['обработать #41', 150], ['коммит: дочитал до 42', 196]] : [['взять #41', 150], ['обработать + коммит — одна транзакция', 368]];
            h += `<g class="${on ? '' : 'xq-dim'}">` + R(14, y, 972, 124, on ? 'xr-box sel' : 'xr-box') + T(28, y + 26, name, 'xr-t') + T(28, y + 46, phr) + T(28, y + 70, on ? '← так сейчас у брокера' : '', 'xr-m acc');
            let x = 236; const xs = [];
            steps.forEach(([lb, w], i) => { xs.push([x, w]); h += `<rect class="xq-step ${st(id, i)}" x="${x}" y="${y + 16}" width="${w}" height="44" rx="8"/>` + T(x + w / 2, y + 43, lb, 'xr-s', 'middle'); x += w + 22; });
            if (p >= 1800) { const cx = id === 'exactly' ? xs[1][0] + xs[1][1] * 0.66 : xs[2][0] - 11; h += T(cx, y + 12, '⚡ упал', 'xr-pop bad', 'middle'); }
            if (p >= 2800) h += T(236, y + 88, id === 'most' ? 'Перезапуск: брокер помнит «дочитал до 42» → выдаёт #42. А #41 так и не обработан.' : id === 'least' ? `Перезапуск: коммита не было → брокер снова выдаёт #41 → обработка второй раз${G.dedup ? ', но inbox узнал его' : ''}.` : 'Перезапуск: транзакция откатилась целиком → #41 обрабатывается заново, как впервые.', 'xr-s');
            if (p >= 5000) { const [txt, cls] = id === 'most' ? ['#41 потерян', 'bad'] : id === 'least' ? (G.dedup ? ['дубль пропущен', 'ok'] : ['#41 дважды', 'warn']) : (G.ext ? ['письмо — дважды', 'warn'] : ['ровно один раз', 'ok']); h += `<rect class="xq-res ${cls}" x="826" y="${y + 70}" width="150" height="40" rx="8"/>` + T(901, y + 95, txt, 'xr-t xq-sm', 'middle'); }
            h += '</g>';
          });
          h += T(20, 470, `Падение — после второго шага, в самом опасном месте. Сейчас у брокера: ${SEMN[G.sem]}.${G.sem === 'exactly' && G.ext ? ' Но письмо во внешний сервис транзакция Kafka не отменит.' : ''}`);
          h += T(20, 490, 'На практике выбирают at-least-once и делают обработчик идемпотентным: дубль приходит, но не вредит.');
          return h;
        },
        now() {
          const p = PV.t % 9000, out = { most: 'сообщение #41 потеряно', least: G.dedup ? '#41 пришло дважды, но inbox пропустил дубль' : '#41 обработано дважды', exactly: G.ext ? 'в Kafka — один раз, но письмо ушло дважды' : 'ровно один раз' }[G.sem];
          return (p < 1800 ? '<b>Потребитель берёт #41 и делает второй шаг.</b> На каждой дорожке свой порядок шагов.' : p < 2800 ? '<b>⚡ Упал после второго шага.</b> Что уже сделано — зависит от порядка: где-то отметка стоит, а работа нет, где-то наоборот.' : p < 5000 ? '<b>Перезапуск.</b> Брокер выдаёт сообщения с последнего коммита — смотри, с какого номера продолжает каждая дорожка.' : '<b>Итог справа.</b>') + ` У тебя ${SEMN[G.sem]}: ${out}.`;
        }
      };

      /* повторы и DLQ */
      QP.dlq = {
        tick(t) {
          const s = PV.s;
          if (!s.init) Object.assign(s, { init: 1, q: [], cur: null, seq: 100, nA: 200, ok: [], retry: [], dlq: [], lost: 0, loops: 0, over: 0 });
          if (t >= s.nA) { const ty = ['ok', 'ok', 'tr', 'ok', 'ok', 'poi'][s.seq % 6]; if (s.q.length < 8) s.q.push({ id: ++s.seq, ty, tries: 0 }); else { s.over++; s.seq++; } s.nA = t + 1000; }
          if (!s.cur && s.q.length) s.cur = { m: s.q.shift(), t0: t };
          if (s.cur && t - s.cur.t0 >= 700) {
            const m = s.cur.m, fail = m.ty === 'poi' || (m.ty === 'tr' && m.tries === 0); m.tries++; s.cur = null;
            if (!fail) { s.ok.unshift(m); s.ok = s.ok.slice(0, 7); pfx(485, 140, '✓', 'ok'); }
            else if (G.retries) { pfx(485, 140, '✕ ошибка', 'bad'); if (m.ty === 'poi' && m.tries >= 3) { s.dlq.unshift(m); s.dlq = s.dlq.slice(0, 4); } else s.retry.push({ m, at: t + 800 * Math.pow(2, m.tries - 1), from: t }); }
            else if (G.sem === 'most') { s.lost++; pfx(485, 140, '✕ потеряно', 'bad'); }
            else if (G.kf) { s.cur = { m, t0: t }; s.loops++; }
            else { s.q.unshift(m); s.loops++; }
          }
          s.retry = s.retry.filter(r => { if (t < r.at) return true; s.q.unshift(r.m); return false; });
        },
        draw(t) {
          const s = PV.s, kc = KJ(), TY = { ok: 'обычное', tr: 'временный сбой', poi: 'битые данные' };
          const chip = (m, x, y, w) => `<rect class="xq-b ${m.ty === 'poi' ? 'poi' : ''}" x="${x}" y="${y}" width="${w}" height="30" rx="4" style="${m.ty === 'poi' ? '' : m.ty === 'tr' ? 'fill:var(--warn)' : 'fill:' + kc}"/>` + T(x + w / 2, y + 19, '#' + m.id, m.ty === 'poi' ? 'xq-k d' : 'xq-k', 'middle');
          let h = T(20, 30, 'Повторы и DLQ: что делать с сообщением, которое не обрабатывается', 'xr-t');
          h += `<rect class="xq-lane" x="20" y="186" width="330" height="50" rx="8"/>` + T(20, 178, `ждут: ${s.q.length}${s.over ? ` · не влезло ${s.over}` : ''}`, 'xr-s' + (s.q.length >= 8 ? ' xq-bad' : ''));
          s.q.slice(0, 6).forEach((m, i) => { h += chip(m, 350 - (i + 1) * 54 + 4, 196, 48); });
          const c = s.cur;
          h += R(380, 140, 210, 150, 'xr-box' + (c && c.m.ty === 'poi' && c.m.tries ? ' hot' : '')) + T(394, 162, 'Обработчик', 'xr-t xq-sm');
          if (c) { const f = clamp((t - c.t0) / 700, 0, 1); h += chip(c.m, 394, 176, 60) + T(464, 188, TY[c.m.ty]) + T(464, 206, `попытка ${c.m.tries + 1}`, 'xr-m' + (c.m.tries ? ' warn' : '')) + `<rect class="xr-bar" x="394" y="268" width="182" height="4" rx="2"/><rect class="xr-bar-f ${c.m.ty === 'ok' ? 'acc' : 'warn'}" x="394" y="268" width="${X1(182 * f)}" height="4" rx="2"/>`; }
          else h += T(394, 210, 'ждёт сообщений');
          if (c && G.kf && !G.retries && G.sem !== 'most' && c.m.tries > 0) h += T(485, 312, `читает #${c.m.id} уже ${c.m.tries + 1}-й раз — дальше не идёт`, 'xr-pop bad', 'middle');
          h += R(640, 46, 340, 96) + T(654, 68, 'Обработано ✓', 'xr-t xq-sm');
          s.ok.forEach((m, i) => { h += chip(m, 654 + i * 46, 86, 40); });
          h += R(640, 162, 340, 112, 'xr-box' + (G.retries ? '' : ' xq-idle')) + T(654, 184, G.retries ? 'Пауза перед повтором' : 'Пауза перед повтором — выключено', 'xr-t xq-sm');
          s.retry.slice(0, 4).forEach((r, i) => { const x = 654 + i * 80, f = clamp((t - r.from) / Math.max(1, r.at - r.from), 0, 1); h += chip(r.m, x, 202, 48) + `<circle class="xq-ring" cx="${x + 24}" cy="217" r="24" style="stroke-dasharray:${X1(f * 151)} 160"/>` + T(x + 24, 260, `через ${sec(r.at - t)}`, 'xr-m', 'middle'); });
          h += R(640, 294, 340, 112, 'xr-box' + (G.retries ? (s.dlq.length ? ' hot' : '') : ' xq-idle')) + T(654, 316, G.retries ? 'DLQ — отдельная очередь для разбора' : 'DLQ — выключено', 'xr-t xq-sm');
          s.dlq.forEach((m, i) => { h += chip(m, 654 + i * 54, 330, 48); });
          if (s.dlq[0]) h += T(654, 384, `#${s.dlq[0].id}: битые данные, 3 попытки — ждёт человека`, 'xr-s') + T(654, 400, `всего в DLQ: ${s.dlq.length}`, 'xr-m');
          if (!G.retries && G.sem === 'most') h += T(654, 352, `потеряно: ${s.lost}`, 'xr-m bad');
          h += `<path class="xr-wire" d="M590,200 C615,200 615,94 640,94"/><path class="xr-wire ${G.retries ? '' : 'dash'}" d="M590,215 H640"/><path class="xr-wire ${G.retries ? '' : 'dash'}" d="M590,230 C615,230 615,350 640,350"/>`;
          const L = G.retries ? ['Синее проходит сразу. Жёлтое (временный сбой) падает один раз и проходит после паузы.', 'Красное (битые данные) падает трижды и уходит в DLQ. Остальные в это время идут дальше.']
            : G.sem === 'most' ? ['Повторов нет, коммит до обработки: упавшее сообщение просто теряется.', 'Даже временный сбой (жёлтое) превращается в потерю.']
            : G.kf ? [`Повторов нет: обработчик читает красное снова и снова (уже ${s.loops} раз). Закоммитить нельзя —`, 'партиция стоит, очередь слева растёт. Включи «Повторы + DLQ» справа.']
            : [`Повторов нет: брокер возвращает упавшее в начало очереди, его берут снова (уже ${s.loops} раз).`, 'Горячая петля жжёт ресурсы. Включи «Повторы + DLQ» справа.'];
          h += T(20, 450, L[0]) + T(20, 470, L[1]);
          return h;
        },
        now() {
          const s = PV.s, c = s.cur;
          if (!G.retries) return G.kf && G.sem !== 'most' ? `<b>DLQ выключен — партиция встала.</b> ${c && c.m.ty === 'poi' ? `#${c.m.id} с битыми данными читается по кругу, а за ним ждут уже ${s.q.length}.` : 'Скоро придёт сообщение с битыми данными — и всё остановится.'}` : G.sem === 'most' ? `<b>DLQ выключен.</b> Упавшие сообщения теряются: уже ${s.lost}.` : `<b>DLQ выключен.</b> Упавшее возвращается в очередь и крутится по кругу: ${s.loops} повторов.`;
          return `<b>Повторы с паузой и DLQ.</b> На паузе: ${s.retry.length}, в DLQ: ${s.dlq.length}. ${c && c.m.tries ? `#${c.m.id} — попытка ${c.m.tries + 1}.` : 'Очередь не стоит, пока упавшее ждёт повтора.'}`;
        }
      };

      function checks(o) {
        if (G.kf && S.mem.some(m => m.idle)) ctx.done('idle');
        if (scn() === 'peak' && G.outs.length && G.rho * 2.5 < 1 && (!o || o.rho * 2.5 >= 1)) ctx.done('lag');
      }
      buildLanes(false); buildMembers();

      return {
        tick, draw,
        refresh() {
          const o = G; G = derive();
          if (o.kf !== G.kf || o.Pv !== G.Pv || o.Pn !== G.Pn || o.cnt !== G.cnt) { if (o.cnt !== G.cnt) S.bro = mkBro(); buildLanes(true); }
          buildMembers(); checks(o);
          if (PV.k) { PV.s = {}; PV.fx = []; }
        },
        scenario() { const saw = S.saw; S = fresh(); S.saw = saw; buildLanes(false); buildMembers(); },
        focus(k) { PV.k = k && QP[k] ? k : null; PV.t = 0; PV.s = {}; PV.fx = []; },
        onProp(k, prev, v) {
          if (k === 'engine') { if (v !== 'kafka') ctx.done('engine'); return SD.ENGINES[v] && SD.ENGINES[v].cap === 'partitions' ? 'Смотри: появились дорожки-партиции, у каждой — свой потребитель.' : 'Смотри: партиций больше нет — одна общая очередь, свободный потребитель берёт первое сообщение.'; }
          if (k === 'partitions') return +v > +prev ? `Партиций больше — ключи пересчитались: hash(ключ) % ${v}. Смотри, кому из потребителей досталась новая дорожка.` : 'Партиций меньше — часть потребителей может остаться без работы.';
          if (k === 'count') return +v >= 3 ? 'Три брокера — у каждой партиции три копии. Пунктирные брусочки ждут копирования.' : +v === 1 ? 'Один брокер — одна копия. Упадёт сервер — пропадёт всё.' : 'Две копии: одно падение переживём, но кворума нет.';
          if (k === 'acks') return { 0: 'acks=0: продюсер не ждёт ответа — галочек ✓ у продюсеров не будет.', 1: 'acks=1: ✓ приходит, как только записал лидер, даже без копий (пунктир).', all: 'acks=all: ✓ — только после копирования. Смотри на «ждут ✓» у продюсеров.' }[v] || '';
          if (k === 'semantics') return { most: 'At-most-once: коммит до обработки. Открой «Обработчик упал» — сообщение потеряется.', least: 'At-least-once: коммит после обработки. При падении — дубль.', exactly: 'Exactly-once: результат и offset в одной транзакции — ни потерь, ни дублей.' }[v] || '';
          if (k === 'retries') return v ? 'Упавшие сообщения пойдут на паузу, после 3 попыток — в DLQ (справа внизу).' : 'Без DLQ упавшее сообщение либо теряется, либо держит партицию.';
          return '';
        },
        now() {
          if (PV.k && QP[PV.k] && PV.s.init) return QP[PV.k].now();
          const s = scn(), lag = totalLag(), idle = S.mem.filter(m => m.idle).length;
          if (!G.outs.length) return '<b>Очередь никто не читает.</b> Сообщения копятся, лаг растёт без конца. Добавь на площадке обработчиков и проведи к ним стрелку от брокера.';
          let h;
          if (s === 'peak') h = G.rho * 2.5 > 1 ? `<b>Пик: сообщений больше, чем успевают разобрать.</b> Лаг — сколько сообщений ждёт — растёт (сейчас ${lag}). Это не авария: брокер держит пик в себе, но ждать всё дольше. ${G.kf ? `Добавь обработчиков, но не больше, чем партиций (${G.Pn}): одну партицию читает один потребитель.` : 'Добавь обработчиков.'}` : '<b>Пик, но обработчики справляются.</b> Лаг вспыхивает и рассасывается: мощности хватает с запасом.';
          else if (s === 'crash') h = (G.sem === 'most' ? '<b>At-most-once: «отметился, потом сделал».</b> Потребитель коммитит offset до обработки. Упадёт между ними — сообщение потеряно навсегда (красный крестик).'
            : G.sem === 'exactly' ? `<b>Exactly-once: результат и offset — в одной транзакции.</b> Упал посередине — откатилось и то и другое, повтор не создаёт дубль.${G.ext ? ' Но письмо во внешний сервис транзакция не вернёт — там нужен ключ идемпотентности.' : ''}`
            : `<b>At-least-once: «сделал, потом отметился».</b> Потребитель упал после обработки, но до коммита — брокер выдаст сообщение снова (жёлтая обводка). ${G.dedup ? 'Обработчик идемпотентный — повтор пропустит.' : 'Без защиты это дубль: письмо уйдёт дважды.'}`) + (G.kf ? ' Пока идёт ребаланс, группа не читает ничего.' : '');
          else if (s === 'leader') h = G.e.managed ? '<b>Облачная очередь.</b> Серверы и копии — забота AWS: падение узла ты не увидишь. Платишь задержкой и меньшим контролем.'
            : G.cnt === 1 ? '<b>Брокер один — и копия одна.</b> Сервер умирает — всё, что лежало в его партициях, пропадает, а новые сообщения не принимаются. Поставь 3 брокера.'
            : !G.kf ? (G.redis ? '<b>Redis Streams быстрый, но держит данные в памяти.</b> Узел падает — сообщения последней секунды пропадают.' : G.quorum ? '<b>Кворумная очередь.</b> Подтверждение — когда записали большинство узлов. Узел упал — лидером станет другой, неподтверждённое продюсер отправит снова.' : '<b>Два узла — кворума нет.</b> Упал один — очередь недоступна. Нужно 3 узла.')
            : G.acks === '1' ? '<b>acks=1: «принято», как только записал лидер.</b> Копии отстают (пунктир). Лидер падает — нескопированные сообщения пропадают, хотя продюсер уже получил ✓. Поставь acks=all.'
            : G.acks === '0' ? '<b>acks=0: продюсер не ждёт ответа.</b> Пока выбирают нового лидера, сообщения улетают в пустоту, и никто не узнает о потере.'
            : '<b>acks=all: ✓ — только когда записали все копии.</b> Лидер упал — неподтверждённые сообщения продюсер отправит снова, новый лидер их примет. Потерь нет, цена — ожидание копий.';
          else if (s === 'poison') h = G.retries ? '<b>Ядовитое сообщение — битые данные.</b> Пауза и 3 попытки отличают случайный сбой от яда. После третьей сообщение уходит в DLQ — отдельную очередь для разбора, и остальные едут дальше.'
            : G.sem === 'most' ? '<b>At-most-once:</b> упавшее сообщение просто теряется. Партиция свободна, но данные пропали молча.'
            : G.kf ? '<b>Ядовитое сообщение держит партицию.</b> Обработка падает, закоммитить нельзя — потребитель читает его снова и снова, а всё, что за ним, ждёт. Включи «Повторы + DLQ».'
            : '<b>Сообщение крутится по кругу.</b> Брокер возвращает упавшее в начало очереди, и его тут же берут снова. Включи «Повторы + DLQ».';
          else h = G.kf ? `<b>Каждое сообщение — на свою дорожку.</b> Как сортировка писем по ящикам: партицию выбирают по ключу — hash(ключ) % ${G.Pn}. Все «${word} N» с одним номером попадают в одну партицию и читаются строго по порядку. Каждую партицию читает один потребитель группы.`
            : `<b>Одна общая очередь.</b> Как очередь в банке к нескольким окнам: свободный потребитель берёт первое сообщение, обрабатывает и подтверждает (ack) — тогда брокер его удаляет. ${G.e.order === 'group' ? 'SQS FIFO не выдаёт два сообщения одного ключа сразу — порядок по ключу сохранён.' : 'Порядок между потребителями не гарантирован.'}`;
          if (idle) h += ` <b>${idle} ${pl(idle, 'потребитель простаивает', 'потребителя простаивают', 'потребителей простаивают')}:</b> партиций ${G.Pn}, а потребителей ${S.W}.`;
          return h;
        },
        stats() {
          const t = S.t, c = k => cnt10(S.ev, t, k), lag = totalLag(), dup = c('dup'), skip = c('skip'), lost = c('lost');
          return [['Пришло', String(c('in')), '', 'сообщений за 10 с'], ['Обработано', String(c('ok')), 'ok', 'за 10 с'],
            ['Лаг', String(lag), lag > 12 ? 'bad' : lag > 5 ? 'warn' : 'ok', G.kf ? 'ждут во всех партициях' : 'ждут в очереди'],
            ['Потеряно', String(lost), lost ? 'bad' : 'ok', 'за 10 с'], ['Дубли', String(dup), dup ? 'warn' : 'ok', skip ? `ещё ${skip} пропущено защитой` : 'обработаны второй раз'],
            ['В DLQ', String(S.dlqN), S.dlqN ? 'warn' : '', G.retries ? 'с начала ситуации' : 'DLQ выключен']];
        },
        destroy() {}
      };
    }
  };

  /* ================= обработчик ================= */
  SD.XRAY.worker = {
    viewBox: '0 0 1000 500',
    cta: 'Пачки, коммит offset, повторы и защита от дублей — вживую',
    dive: 'delivery',
    simple: () => ({ an: 'Как <b>курьеры на складе</b>: каждый берёт из ящика пачку посылок, развозит по одной и отмечает в журнале «доставлено».', pl: 'Обработчик забирает сообщения из брокера, делает работу (пишет в базу, отправляет письмо) и сообщает брокеру «готово» — это коммит. Упадёт до коммита — те же сообщения придут снова.' }),
    props: ['count', 'batch', 'autoscale', 'dedup'],
    parts: {
      loop: {
        name: 'Цикл: забрал → сделал → отметил',
        an: 'Как <b>курьер</b>: забрать посылки на складе, развезти, отметиться в журнале. Можно ездить за каждой посылкой отдельно, а можно взять сумку.',
        pl: 'Обработчик крутится в цикле: забрать сообщения (poll), обработать по одному, записать результат, отметить в брокере (commit). Пачка делит дорогие шаги — забор, запись и отметку — на много сообщений.',
        how: ['<b>poll</b>: забрать у брокера до N сообщений.', 'Обработать каждое: разобрать, посчитать, подготовить запись.', 'Записать результат: в базу — одной пачкой, во внешний сервис — по вызову на сообщение.', '<b>commit</b>: отметить в брокере offset — «досюда готово».', 'Пачка 1: забор, запись и коммит — на каждое сообщение. Пачка 10: один раз на десять.', 'Цена пачки: первое сообщение ждёт всю пачку, а при падении переделывать всю пачку.'],
        watch: 'Две полосы — одни и те же 10 сообщений. Серое — забор, зелёное — работа, синее — запись или вызов, тёмно-зелёное — коммит. Пунктир — «сейчас»: сравни, сколько готово на каждой полосе.',
        knobs: ['batch', 'count'],
        real: 'Kafka: max.poll.records = 500, fetch.min.bytes и fetch.max.wait.ms. Если пачка обрабатывается дольше max.poll.interval.ms (5 мин) — потребителя выкинут из группы. Spring: @KafkaListener с batch = "true".'
      },
      retry: {
        name: 'Повторы с паузой',
        an: 'Как <b>звонок занятому другу</b>: перезвонишь через минуту, потом через две — а не будешь набирать без остановки.',
        pl: 'Ошибка бывает временной: сеть моргнула, сосед перегружен. Такую лечит повтор через паузу. Пауза растёт с каждой попыткой, чтобы не добивать больного соседа. Безнадёжное сообщение уходит в DLQ.',
        how: ['Попытка упала — сообщение откладывают, а не выбрасывают.', 'Пауза растёт: 0,7 с, 1,4 с, 2,8 с… плюс случайный разброс.', 'Временный сбой проходит со второй-третьей попытки.', 'Битые данные не пройдут — после лимита попыток сообщение уходит в DLQ.', 'Повторы без паузы — «шторм»: больной сосед получает в разы больше запросов и не встаёт.', 'Повторять можно только идемпотентные действия — иначе дубли.'],
        watch: 'Три дорожки: временный сбой, битые данные и повторы без паузы. Смотри, как растут жёлтые паузы и куда в итоге попадает каждое сообщение.',
        knobs: ['dedup'],
        real: 'Spring Retry и Resilience4j: экспоненциальная пауза с разбросом (jitter). Kafka: неблокирующие повторы через retry-топики (@RetryableTopic). Настройка «Повторы + DLQ» — у брокера.'
      },
      idem: {
        name: 'Защита от дублей (inbox)',
        an: 'Как <b>журнал выданных справок</b>: прежде чем выдать, смотришь, не выдавали ли уже по этому номеру.',
        pl: 'При at-least-once одно сообщение может прийти дважды. Идемпотентный обработчик записывает номер обработанного сообщения в таблицу inbox — в той же транзакции, что и результат. Повтор с тем же номером он пропускает.',
        how: ['Пришло сообщение #141.', 'Обработчик смотрит в таблицу inbox: такой номер уже был?', 'Нет — делает работу и в той же транзакции добавляет #141 в inbox.', 'Упал до коммита offset — брокер пришлёт #141 ещё раз.', 'Второй раз номер найден в inbox — работа пропускается, offset коммитится.', 'Без inbox второй раз — это второе письмо клиенту или второй платёж.'],
        watch: 'Первая доставка проходит всю цепочку и падает до коммита. Вторая — смотри шаг «есть в inbox?» и таблицу писем справа при включённой и выключенной защите.',
        knobs: ['dedup'],
        real: 'Таблица inbox(message_id PRIMARY KEY): INSERT … ON CONFLICT DO NOTHING в той же транзакции, что и результат. Для внешних API — ключ идемпотентности (заголовок Idempotency-Key, как у Stripe).'
      },
      call: {
        name: 'Внешний вызов',
        an: 'Как <b>звонок в справочную</b>: сам вопрос — секунда, а ждёшь ответа минуту, и всё это время линия занята.',
        pl: 'Большую часть времени обработчик не считает, а ждёт ответа соседа — базы или внешнего сервиса. Пока ждёт, экземпляр больше ничего не делает. Поэтому медленный сосед делает медленным и обработчик.',
        how: ['Экземпляр подготовил данные — это быстро.', 'Отправил запрос соседу и <b>ждёт</b> ответа.', 'Ответ пришёл — можно браться за следующее.', 'Скорость ≈ число экземпляров ÷ время одного цикла.', 'База принимает пачку одной записью — один вызов на много сообщений. Внешний API — обычно по одному.', 'Сосед тормозит — нужен таймаут, иначе экземпляры зависнут в ожидании.'],
        watch: 'Полосы — время каждого экземпляра за последние 5 секунд: зелёное — работает, синее — ждёт ответа. Включи «Внешний сервис тормозит» — синее растянется.',
        knobs: ['count', 'batch'],
        real: 'HTTP-клиент с таймаутом 1–3 с и пулом соединений, circuit breaker (Resilience4j). Асинхронные клиенты и виртуальные потоки Java 21 позволяют одному экземпляру ждать много ответов сразу.'
      }
    },
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'экземпляры и пачка — как на площадке' },
      { id: 'batch', name: 'Пачка 1 vs большая', note: 'два экземпляра рядом: по одному и пачками' },
      { id: 'crash', name: 'Упал посреди пачки', note: 'экземпляр падает до коммита — пачка придёт снова' },
      { id: 'slow', name: 'Внешний сервис тормозит', note: 'каждый вызов соседа в 3 раза дольше' },
      { id: 'error', name: 'Ошибка обработки', note: 'часть сообщений падает: повтор с паузой, затем DLQ' }
    ],
    tries: [
      { id: 'batch', text: 'Поставь пачку 10 или 100: запись и коммит делаются один раз на всю пачку' },
      { id: 'compare', text: 'Открой «Пачка 1 vs большая» и найди, у кого растёт очередь' },
      { id: 'dedup', text: 'В «Упал посреди пачки» включи идемпотентного потребителя — дубль будет пропущен' },
      { id: 'slow', text: 'В «Внешний сервис тормозит» добейся, чтобы очередь не росла: больше экземпляров, а для базы — ещё и пачка' },
      { id: 'dlq', text: 'В «Ошибка обработки» включи у брокера «Повторы + DLQ» (клик по брокеру слева)' },
      { id: 'blk', text: 'Нажми на строки экземпляров и досмотри цикл: где 10 сообщений готовы раньше — по одному или пачкой?' }
    ],
    legend: [['job', 'Сообщение в очереди или в пачке'], ['xq-hol', 'Место в пачке, ещё пустое'], ['ok', 'Обработано и закоммичено'], ['warn', 'Обработано второй раз — дубль'], ['xq-skip', 'Дубль пропущен: номер нашёлся в inbox'], ['bad', 'Ошибка или потеря'], ['xq-idle', 'Экземпляр без партиции простаивает']],
    live(n, r, all) {
      const A = SD.app.A, util = r.util || 0;
      const qe = A.graph.edges.find(e => e.to === n.id && (A.graph.nodes.find(x => x.id === e.from) || {}).type === 'queue');
      const q = qe ? ((all && all.queues) || {})[qe.from] : null, cnt = r.count || n.props.count || 1, used = r.used != null ? r.used : cnt;
      return [['Поток', SD.fmt.num((r.load && r.load.job) || 0) + '/с', ''], ['Загрузка', Math.round(Math.min(util, 9) * 100) + ' %', util > 1 ? 'bad' : util > 0.75 ? 'warn' : 'ok'],
        ['Работают', `${used} из ${cnt}${r.scaled ? ' · авто' : ''}`, used < cnt ? 'warn' : ''],
        ['Очередь', q ? (q.growth > 0.5 ? 'растёт +' + SD.fmt.num(q.growth) + '/с' : 'не растёт') : '—', q && q.growth > 0.5 ? 'bad' : 'ok']];
    },
    mount(ctx) {
      const esc = ctx.esc;
      const QX = 16, QW = 196, IX = 252, IW = 446, TX = 806, TW = 178, RY0 = 50, RYH = 306, LINGER = 500;
      const scn = () => ctx.scenario() || 'norm';
      let G = derive(), S = fresh();
      function derive() {
        const n = ctx.node, r = ctx.res || {};
        const qn = ctx.ins().find(o => o.n.type === 'queue') || null, src = qn || ctx.ins()[0] || null;
        const job = (ctx.A.level || {}).job || null, outs = ctx.outs();
        const tgt = (job && outs.find(o => o.n.type === job.target)) || outs[0] || null;
        const batchable = !!tgt && ['sql', 'nosql', 'cache', 'objstore', 'search', 'vectordb'].includes(tgt.n.type) && !(job && job.cpu);
        const b = +n.props.batch || 1, count = Math.max(1, r.count || n.props.count || 1), used = Math.max(0, r.used != null ? r.used : count);
        const kf = !!qn && ENG(qn.n).cap === 'partitions', bf = batchable ? ({ 1: 1, 10: 1.6, 100: 2.2 }[b] || 1) : 1;
        const showN = Math.min(count, 6), act = Math.min(used, showN), rho = r.util > 0 ? r.util : 0.5;
        return {
          n, r, qn, src, job, outs, tgt, batchable, b, count, used, showN, act, rho, kf, parts: kf ? +qn.n.props.partitions || 1 : 0,
          T1: clamp(rho * Math.max(1, act) * 1000 * bf / 4, 220, 5000), retries: !!(qn && qn.n.props.retries), dedup: !!n.props.dedup,
          ext: !!tgt && tgt.n.type === 'external', tn: tgt ? ctx.nm(tgt.n.id) : '', qs: qn ? ((ctx.all && ctx.all.queues) || {})[qn.n.id] || null : null
        };
      }
      function fresh() { return { t: 0, seq: 140, lines: [], fx: [], ev: [], inbox: [], inHl: {}, retry: [], dlq: [], dlqN: 0, armCrash: false, crashAt: 2500, failAt: 1600, failN: 0, dupLog: -1e9 }; }
      const mkI = k => ({ k, ph: 'idle', batch: [], j: 0, t0: 0, t1: 0, dead: 0, idle: false, last: null, per: 0 });
      const mkLine = (b, label, n, T1) => ({ b, label, T1, q: [], next: 250 + Math.random() * 300, ev: [], inst: Array.from({ length: n }, (_, k) => mkI(k)) });
      function build() {
        if (scn() === 'batch') { const bB = G.b > 1 ? G.b : 10; S.lines = [mkLine(1, 'По одному', 1, 300), mkLine(bB, 'Пачками по ' + bB, 1, 300)]; }
        else { S.lines = [mkLine(G.b, '', G.showN, G.T1)]; S.lines[0].inst.forEach(I => { I.idle = I.k >= G.act; }); }
      }
      const slow = () => scn() === 'slow' ? 3 : 1;
      const tW = L => (G.tgt && !G.batchable ? 0.25 : 0.4) * L.T1, tCall = L => 0.6 * L.T1 * slow();
      const tBCall = (L, n) => 0.45 * L.T1 * Math.pow(Math.max(1, n), 0.55) * slow();
      const tTake = (L, n) => Math.max(30, 0.06 * L.T1 * Math.pow(Math.max(1, n), 0.55));
      const tCommit = (L, n) => Math.max(30, 0.09 * L.T1 * Math.pow(Math.max(1, n), 0.55));
      const fx = (x, y, txt, cls) => S.fx.push({ x, y, txt, cls, born: S.t });
      const nIn = n => `${n} ${pl(n, 'сообщение', 'сообщения', 'сообщений')}`;

      /* ---------- геометрия ---------- */
      function rows() {
        const extra = scn() !== 'batch' && G.count > G.showN ? 1 : 0, out = [];
        const n = S.lines.reduce((s, L) => s + L.inst.length, 0) + extra, gap = n > 4 ? 8 : 12;
        const H = Math.min(80, (RYH - (n - 1) * gap) / Math.max(1, n)), y0 = RY0 + (RYH - (n * H + (n - 1) * gap)) / 2;
        let k = 0;
        S.lines.forEach((L, li) => L.inst.forEach(I => { out.push({ L, li, I, top: y0 + k * (H + gap), h: H }); k++; }));
        return { out, H, extraTop: extra ? y0 + k * (H + gap) : null };
      }
      const tgts = () => G.outs.slice(0, 3);
      const tY = i => 205 + (i - (tgts().length - 1) / 2) * 86;

      /* ---------- модель ---------- */
      function take(L, I, t) {
        I.batch = L.q.splice(0, L.b); I.batch.forEach(m => { m.st = 'take'; });
        if (!I.batch.length) { I.ph = 'idle'; return; }
        I.ph = 'take'; I.j = 0; I.t0 = t; I.t1 = t + tTake(L, I.batch.length); I.tb = t;
      }
      function next(L, I, t, first) {
        if (!first) I.j++;
        if (I.j < I.batch.length) {
          const m = I.batch[I.j]; m.st = 'cur'; m.skip = G.dedup && S.inbox.includes(m.id);
          I.ph = 'work'; I.t0 = t; I.t1 = t + (m.skip ? 0.08 * L.T1 : tW(L)); return;
        }
        const pend = I.batch.filter(x => x.st === 'pend').length;
        if (G.tgt && G.batchable && pend) { I.ph = 'bcall'; I.t0 = t; I.t1 = t + tBCall(L, pend); return; }
        I.ph = 'commit'; I.t0 = t; I.t1 = t + tCommit(L, I.batch.length);
      }
      function apply(m, t, L, row) {
        m.eff = (m.eff || 0) + 1;
        if (G.dedup && !S.inbox.includes(m.id)) { S.inbox.unshift(m.id); S.inbox = S.inbox.slice(0, 40); }
        if (m.eff > 1) {
          m.st = 'dup'; S.ev.push({ t, k: 'dup' }); L.ev.push({ t, k: 'dup' }); fx(IX + IW - 70, row - 12, 'второй раз!', 'warn');
          if (t - S.dupLog > 2500) { S.dupLog = t; ctx.log(`<b>Дубль:</b> сообщение #${m.id} обработано второй раз${G.ext ? ' — клиент получит письмо дважды' : ' — запись повторилась'}. Включи «Идемпотентный потребитель».`, 'warn'); }
        } else m.st = 'done1';
      }
      function failMsg(L, I, m, t, row) {
        m.st = 'err'; S.ev.push({ t, k: 'err' }); fx(IX + IW - 70, row - 12, m.fail === 2 ? 'ошибка: битые данные' : G.ext ? 'ошибка: ответ 500' : 'ошибка записи', 'bad');
        if (G.retries) {
          if (m.tries >= 3) {
            S.dlq.unshift(m); S.dlq = S.dlq.slice(0, 5); S.dlqN++; S.ev.push({ t, k: 'dlq' });
            S.fx.push({ k: 'mv', x: IX + 40, y: row, x2: 530, y2: 428, c: 'var(--bad)', born: t, dur: 900 });
            ctx.log(`<b>#${m.id} — в DLQ</b> после 3 попыток: ошибка не временная. Лежит отдельно и ждёт разбора, остальные сообщения идут дальше.`, 'ok'); ctx.done('dlq');
          } else {
            const d = 700 * Math.pow(2, m.tries - 1); S.retry.push({ m, at: t + d, from: t, L });
            ctx.log(`#${m.id}: ошибка (попытка ${m.tries}) — повтор через ${sec(d)}.${m.fail === 1 ? ' Сбой временный — со второго раза пройдёт.' : ''}`, 'warn');
          }
        } else { S.ev.push({ t, k: 'lost' }); S.fx.push({ k: 'x', x: IX + IW - 30, y: row, born: t, dur: 1500 }); ctx.log(`<b>#${m.id} потеряно:</b> обработка упала, а повторов и DLQ у брокера нет — сообщение выброшено. Включи «Повторы + DLQ» у брокера (клик по нему слева).`, 'bad'); }
      }
      const crashNow = (I, done, n) => scn() === 'crash' && S.armCrash && I.k === 0 && done >= Math.ceil(n / 2);
      function crash(L, I, t, row) {
        const n = I.batch.length, done = I.batch.filter(m => m.st === 'done1' || m.st === 'dup').length;
        const back = I.batch.filter(m => m.st !== 'err');
        back.forEach(m => { m.st = 'wait'; m.again = true; m.skip = false; });
        L.q.unshift(...back);
        I.batch = []; I.ph = 'idle'; I.dead = t + 2200; S.armCrash = false; S.crashAt = t + 8000;
        S.fx.push({ k: 'x', x: IX + IW - 30, y: row, born: t, dur: 1600 });
        ctx.log(`<b>Экземпляр #1 упал${n > 1 ? ` после ${done} ${pl(done, 'сообщения', 'сообщений', 'сообщений')} из ${n}` : ' после обработки'}, коммита не было.</b> Брокер выдаст ${n > 1 ? 'всю пачку' : 'сообщение'} заново — уже обработанное пройдёт ещё раз.${G.dedup ? ' Inbox узнает номера и пропустит.' : ' Без защиты это дубли.'}`, G.dedup ? 'warn' : 'bad');
      }
      function finish(L, I, t) {
        I.batch.forEach(m => {
          if (m.st === 'err') return;
          if (m.st !== 'dup' && m.st !== 'skip') m.st = 'ok';
          m.again = false; S.ev.push({ t, k: 'ok' }); L.ev.push({ t, k: 'ok', lat: t - m.t0 });
        });
        I.per = (t - I.tb) / Math.max(1, I.batch.length);
        I.last = { batch: I.batch, t, off: Math.max(...I.batch.map(m => m.id)) + 1 };
        I.batch = []; I.ph = 'idle';
      }
      function stepI(L, I, t, row) {
        for (let guard = 0; guard < 16; guard++) {
          if (I.dead) { if (t < I.dead) return; I.free = I.dead; I.dead = 0; ctx.log(`Экземпляр #${I.k + 1} перезапустился и читает с последнего коммита.`, 'ok'); continue; }
          if (I.idle) return;
          if (I.ph === 'idle') {
            if (!L.q.length) { I.free = t; return; }
            const t0 = Math.min(t, Math.max(I.free || 0, L.q[0].t0 || 0));
            if (L.b > 1 && L.q.length < L.b) { I.ph = 'fill'; I.t0 = t0; I.t1 = t0 + LINGER; continue; }
            take(L, I, t0); continue;
          }
          if (I.ph === 'fill') { if (L.q.length >= L.b) { take(L, I, t); continue; } if (t < I.t1) return; take(L, I, I.t1); continue; }
          if (t < I.t1) return;
          const te = I.t1, m = I.batch[I.j], n = I.batch.length;
          if (I.ph === 'take') { next(L, I, te, true); continue; }
          if (I.ph === 'work') {
            if (m.skip) {
              m.st = 'skip'; S.ev.push({ t: te, k: 'skip' }); S.inHl[m.id] = te; fx(IX + IW - 70, row - 12, '✓ дубль пропущен', 'ok'); ctx.done('dedup');
              if (te - S.dupLog > 2500) { S.dupLog = te; ctx.log(`#${m.id} пришло второй раз — номер нашёлся в inbox, сообщение пропущено без повторной работы.`, 'ok'); }
              next(L, I, te); continue;
            }
            if (m.fail === 2 || (m.fail === 1 && !m.tries)) { m.tries = (m.tries || 0) + 1; failMsg(L, I, m, te, row); next(L, I, te); continue; }
            if (G.tgt && !G.batchable) { I.ph = 'call'; I.t0 = te; I.t1 = te + tCall(L); continue; }
            if (G.tgt) m.st = 'pend'; else apply(m, te, L, row);
            if (!G.tgt && crashNow(I, I.j + 1, n)) { crash(L, I, te, row); continue; }
            next(L, I, te); continue;
          }
          if (I.ph === 'call') { apply(m, te, L, row); if (crashNow(I, I.j + 1, n)) { crash(L, I, te, row); continue; } next(L, I, te); continue; }
          if (I.ph === 'bcall') { I.batch.forEach(x => { if (x.st === 'pend') apply(x, te, L, row); }); if (crashNow(I, n, n)) { crash(L, I, te, row); continue; } I.ph = 'commit'; I.t0 = te; I.t1 = te + tCommit(L, n); continue; }
          if (I.ph === 'commit') { finish(L, I, te); I.free = te; continue; }
          return;
        }
      }
      function tick(dt) {
        const t = S.t += dt, s = scn();
        S.lines.forEach(L => {
          while (L.next <= t) {
            const m = { id: ++S.seq, t0: L.next, st: 'wait', eff: 0 };
            if (s === 'error' && L.next >= S.failAt) { m.fail = S.failN++ % 2 === 0 ? 1 : 2; S.failAt = L.next + 3200; }
            if (L.q.length < 400) L.q.push(m);
            S.ev.push({ t: L.next, k: 'in' }); L.ev.push({ t: L.next, k: 'in' });
            L.next += 250 * (0.5 + Math.random());
          }
        });
        S.retry = S.retry.filter(r => { if (t < r.at) return true; r.m.st = 'wait'; (S.lines.includes(r.L) ? r.L : S.lines[0]).q.unshift(r.m); return false; });
        if (s === 'crash' && !S.armCrash && t >= S.crashAt && S.lines[0].inst[0] && !S.lines[0].inst[0].dead) S.armCrash = true;
        const R = rows();
        R.out.forEach(r => stepI(r.L, r.I, t, r.top + r.h / 2));
        if (s === 'batch' && t > 6000) ctx.done('compare');
        S.ev = S.ev.filter(e => e.t > t - 10000); S.lines.forEach(L => { L.ev = L.ev.filter(e => e.t > t - 10000); });
        if (PV.k && WP[PV.k]) { PV.t += dt; WP[PV.k].tick(PV.t); }
      }

      /* ---------- отрисовка ---------- */
      function cellCls(m, kc) {
        if (!m) return ['xq-cell', ''];
        return { take: ['xq-b', `fill:${kc}`], wait: ['xq-b', `fill:${kc}`], cur: ['xq-b', `fill:${kc}`], pend: ['xq-b pend', `fill:${kc}`], done1: ['xq-b done', ''], ok: ['xq-b ok', ''], dup: ['xq-b dup', ''], skip: ['xq-b skip', ''], err: ['xq-b err', ''] }[m.st] || ['xq-b', `fill:${kc}`];
      }
      function draw() {
        if (ctx.part() && WP[ctx.part()]) { const pv = WP[ctx.part()]; if (!PV.s.init) pv.tick(PV.t); ctx.svg.innerHTML = pv.draw(PV.t) + drawFx(PV); return; }
        const t = S.t, kc = KJ(), R = rows(), cmp = scn() === 'batch';
        let h = `<text class="xq-h" x="${QX}" y="30">${cmp ? 'Две очереди' : 'Откуда'}</text><text class="xq-h" x="${IX}" y="30">${cmp ? 'Два экземпляра: одинаковая работа' : `Экземпляры · ${G.count} · ${G.b > 1 ? 'пачка до ' + G.b : 'по одному'}`}</text><text class="xq-h" x="${TX}" y="30">Куда пишет</text>`;
        // источник(и)
        const srcBox = (L, top, H, title) => {
          let s = `<rect class="xr-box ${L.q.length > 15 ? 'hot' : ''}" x="${QX}" y="${X1(top)}" width="${QW}" height="${X1(H)}" rx="10"/><text class="xr-t" x="${QX + 12}" y="${X1(top + 18)}">${esc(cut(title, 22))}</text><text class="xr-s ${L.q.length > 15 ? 'xq-bad' : ''}" x="${QX + 12}" y="${X1(top + 33)}">ждут: ${L.q.length}</text>`;
          const cols = 6, rowsN = Math.max(1, Math.floor((H - 44) / 15)), cap = cols * rowsN, show = L.q.length > cap ? cap - 1 : L.q.length;
          for (let i = 0; i < show; i++) { const m = L.q[i], x = QX + 12 + (i % cols) * 29, y = top + 40 + Math.floor(i / cols) * 15; s += `<rect class="xq-b ${m.again ? 'again' : ''} ${m.fail ? 'poi' : ''}" x="${x}" y="${X1(y)}" width="25" height="11" rx="2" style="${m.fail ? '' : 'fill:' + kc}"/>`; }
          if (L.q.length > cap) s += `<text class="xr-m warn" x="${QX + 12 + ((cap - 1) % cols) * 29 + 12}" y="${X1(top + 40 + Math.floor((cap - 1) / cols) * 15 + 10)}" text-anchor="middle">+${L.q.length - cap + 1}</text>`;
          return s;
        };
        if (cmp) R.out.forEach(r => { h += srcBox(r.L, r.top, r.h, r.li ? 'Очередь Б' : 'Очередь А'); });
        else h += gox(ctx, G.src && G.src.n.id, srcBox(S.lines[0], RY0, RYH, G.src ? ctx.nm(G.src.n.id) : 'Входящие задачи'));
        // экземпляры — блок «цикл»
        const tg = tgts(), ti = G.tgt ? Math.max(0, tg.indexOf(G.tgt)) : 0, h0 = h;
        h = `<rect class="xq-frame" x="${IX - 8}" y="${RY0 - 8}" width="${IW + 16}" height="${RYH + 16}" rx="12"/><text class="xr-m acc" x="${IX + IW}" y="30" text-anchor="end">цикл poll → commit — разобрать ›</text>`;
        R.out.forEach(r => {
          const { L, I, top, h: H } = r, y = top + H / 2, n = I.batch.length, ph = I.ph;
          h += `<line class="xr-wire ${ph === 'take' ? 'act' : ''}" x1="${QX + QW}" y1="${X1(y)}" x2="${IX}" y2="${X1(y)}"/>`;
          if (tg.length) h += `<path class="xr-wire ${ph === 'call' || ph === 'bcall' ? 'act' : ''}" d="M${IX + IW},${X1(y)} C${IX + IW + 50},${X1(y)} ${TX - 50},${X1(tY(ti))} ${TX},${X1(tY(ti))}"/>`;
          const m = I.batch[I.j];
          let st, bar = 0, bcls = 'acc';
          if (I.dead) st = `упал · перезапуск через ${sec(I.dead - t)}`;
          else if (I.idle) st = `ждёт партицию — партиций ${G.parts}`;
          else if (ph === 'idle') st = 'ждёт сообщений';
          else {
            bar = clamp((t - I.t0) / Math.max(1, I.t1 - I.t0), 0, 1);
            st = ph === 'fill' ? `собирает пачку: ${Math.min(L.q.length, L.b)} из ${L.b}` : ph === 'take' ? `берёт ${nIn(n)}` : ph === 'work' ? (m && m.skip ? `#${m.id} уже в inbox — пропуск` : `обрабатывает ${I.j + 1} из ${n}${m && m.again ? ' — второй раз' : ''}`)
              : ph === 'call' ? `вызов «${cut(G.tn, 16)}»: #${m ? m.id : ''}` : ph === 'bcall' ? (I.batch.length > 1 ? `пишет пачку из ${I.batch.filter(x => x.st === 'pend').length} в «${cut(G.tn, 14)}»` : `пишет в «${cut(G.tn, 18)}»`) : G.kf ? `коммит offset ${Math.max(...I.batch.map(x => x.id)) + 1}` : `подтверждает (ack) ${n}`;
            bcls = ph === 'work' ? 'acc' : ph === 'call' || ph === 'bcall' ? (slow() > 1 ? 'warn' : '') : ph === 'commit' ? 'ok' : '';
          }
          let s = `<rect class="xr-box ${I.dead ? 'bad dead' : I.idle ? 'xq-idle' : ''}" x="${IX}" y="${X1(top)}" width="${IW}" height="${X1(H)}" rx="10"/>`;
          s += `<text class="xr-t" x="${IX + 12}" y="${X1(top + 17)}">${cmp ? esc(L.label) : '#' + (I.k + 1)}</text><text class="xr-s ${I.dead ? 'xq-bad' : ''}" x="${IX + (cmp ? 130 : 44)}" y="${X1(top + 17)}">${esc(st)}</text>`;
          if (I.per && !I.idle) s += `<text class="xr-m" x="${IX + IW - 12}" y="${X1(top + 17)}" text-anchor="end">≈ ${sec(I.per)} / сообщ.</text>`;
          // клетки пачки
          const nb = Math.min(L.b, 10), grp = L.b > 10 ? Math.ceil(L.b / 10) : 1, tight = H < 50, cy = top + (tight ? 21 : 25), ch = tight ? Math.max(6, H - 29) : clamp(H - 38, 8, 20);
          const showB = n ? I.batch : (I.last && t - I.last.t < 600 ? I.last.batch : []);
          for (let c = 0; c < nb; c++) {
            const x = IX + 12 + c * 25;
            const ms = showB.slice(c * grp, (c + 1) * grp);
            if (ph === 'fill' && !n) { const on = c < Math.ceil(Math.min(L.q.length, L.b) / grp); s += `<rect class="${on ? 'xq-b hol' : 'xq-cell'}" x="${x}" y="${X1(cy)}" width="21" height="${X1(ch)}" rx="3" style="${on ? 'stroke:' + kc : ''}"/>`; continue; }
            const pick = ms.find(q => q.st === 'cur') || ms.find(q => q.st === 'dup') || ms.find(q => q.st === 'err') || ms.find(q => q.st === 'take' || q.st === 'pend') || ms[0];
            const [cls, sty] = cellCls(pick, kc);
            s += `<rect class="${cls}" x="${x}" y="${X1(cy)}" width="21" height="${X1(ch)}" rx="3" style="${sty}"/>`;
            if (pick && pick.st === 'cur') s += `<rect class="xr-hl" x="${x - 2}" y="${X1(cy - 2)}" width="25" height="${X1(ch + 4)}" rx="4"/>`;
            if (pick && pick.st === 'skip' && ch >= 12) s += `<text class="xq-k ok" x="${x + 10.5}" y="${X1(cy + ch / 2 + 3.5)}" text-anchor="middle">✓</text>`;
          }
          const lx = IX + 12 + nb * 25 + 8;
          if (L.b > 10 && !tight) s += `<text class="xr-m" x="${lx}" y="${X1(cy + ch / 2 + 4)}">в клетке по ${grp}</text>`;
          else if (!tight && m && (ph === 'work' || ph === 'call')) s += `<text class="xr-m ${m.again ? 'warn' : ''}" x="${lx}" y="${X1(cy + ch / 2 + 4)}">${word()} #${m.id}</text>`;
          if (ph !== 'idle' && !I.dead) { const by = top + H - (tight ? 5 : 8); s += `<rect class="xr-bar" x="${IX + 12}" y="${X1(by)}" width="${IW - 24}" height="3" rx="1.5"/><rect class="xr-bar-f ${bcls}" x="${IX + 12}" y="${X1(by)}" width="${X1((IW - 24) * bar)}" height="3" rx="1.5"/>`; }
          h += s;
          // точки: забор и вызов
          if (ph === 'take') { const p = clamp((t - I.t0) / Math.max(1, I.t1 - I.t0), 0, 1); for (let i = 0; i < Math.min(3, n); i++) { const q = clamp(p * 1.3 - i * 0.15, 0, 1); h += `<circle class="xr-dot" cx="${X1(QX + QW - 14 + (IX + 30 - QX - QW + 14) * q)}" cy="${X1(y)}" r="4.5" style="fill:${kc}"/>`; } }
          if ((ph === 'call' || ph === 'bcall') && tg.length) {
            const p = clamp((t - I.t0) / Math.max(1, I.t1 - I.t0), 0, 1), ty = tY(ti), go = p < 0.5, q = go ? p * 2 : (p - 0.5) * 2;
            const x0 = go ? IX + IW : TX, x1 = go ? TX : IX + IW, y0 = go ? y : ty, y1 = go ? ty : y, cx = x0 + (x1 - x0) * q, cyy = y0 + (y1 - y0) * q, k = I.batch.filter(x => x.st === 'pend').length;
            h += `<circle class="xr-dot ${go ? '' : 'ok'}" cx="${X1(cx)}" cy="${X1(cyy)}" r="${ph === 'bcall' ? 7 : 5}" style="${go ? 'fill:' + kc : ''}"/>`;
            if (ph === 'bcall' && k > 1) h += `<text class="xr-pop" x="${X1(cx)}" y="${X1(cyy - 11)}" text-anchor="middle">×${k}</text>`;
          }
        });
        if (R.extraTop != null) { const idle = G.kf ? Math.max(0, G.count - G.parts) : 0; h += `<rect class="xr-box xq-idle" x="${IX}" y="${X1(R.extraTop)}" width="${IW}" height="${X1(R.H)}" rx="10"/><text class="xr-s" x="${IX + 12}" y="${X1(R.extraTop + R.H / 2 + 4)}">и ещё ${G.count - G.showN} ${pl(G.count - G.showN, 'экземпляр', 'экземпляра', 'экземпляров')}${idle ? ` · ${idle} без партиции простаивают` : ''}${G.r.scaled ? ' · число задаёт автомасштаб' : ''}</text>`; }
        h = h0 + PG('loop', h);
        // куда пишет: рамка — блок «вызов», карточки соседей — снаружи
        h += PG('call', `<rect class="xq-frame" x="${TX - 8}" y="${RY0 - 8}" width="${TW + 16}" height="${RYH + 16}" rx="12"/><text class="xr-m acc" x="${TX + TW / 2}" y="${RY0 + RYH - 2}" text-anchor="middle">как идёт вызов — разобрать ›</text>`);
        if (!tg.length) h += `<rect class="xr-box xq-idle" x="${TX}" y="170" width="${TW}" height="70" rx="10"/><text class="xr-t" x="${TX + 12}" y="198">Никуда не пишет</text><text class="xr-s" x="${TX + 12}" y="216">нет стрелки к соседу</text>`;
        tg.forEach((o, i) => {
          const y = tY(i), main = o === G.tgt, sl = main && slow() > 1;
          const sub = SD.TYPES[o.n.type] ? SD.TYPES[o.n.type].name : '';
          const st = main ? (sl ? 'тормозит: ответ ×3' : G.batchable ? 'принимает пачкой' : 'один вызов на сообщение') : '';
          h += gox(ctx, o.n.id, `<rect class="xr-box ${sl ? 'hot' : main ? '' : ''}" x="${TX}" y="${y - 32}" width="${TW}" height="64" rx="10"/><text class="xr-t" x="${TX + 12}" y="${y - 12}">${esc(cut(ctx.nm(o.n.id), 19))}</text><text class="xr-s" x="${TX + 12}" y="${y + 4}">${esc(cut(sub, 26))}</text>${st ? `<text class="xr-m ${sl ? 'warn' : ''}" x="${TX + 12}" y="${y + 20}">${st}</text>` : ''}`);
        });
        // inbox — блок «защита от дублей»
        const h1 = h; h = `<rect class="xr-zone" x="16" y="370" width="322" height="124" rx="10"/><text class="xr-t" x="28" y="390">Inbox — «уже обработано»</text><text class="xr-m acc" x="326" y="390" text-anchor="end">разобрать ›</text>`;
        if (G.dedup) {
          S.inbox.slice(0, 8).forEach((id, i) => { const x = 28 + (i % 4) * 75, y = 400 + Math.floor(i / 4) * 28, hl = t - (S.inHl[id] || -1e9) < 900; h += `<rect class="xq-chip ${hl ? 'hl' : ''}" x="${x}" y="${y}" width="68" height="22" rx="6"/><text class="xr-m ${hl ? 'acc' : 'ok'}" x="${x + 34}" y="${y + 15}" text-anchor="middle">#${id} ✓</text>`; });
          if (!S.inbox.length) h += `<text class="xr-s" x="28" y="420">пока пусто</text>`;
          h += `<text class="xr-s" x="28" y="472">Номер пишется в той же транзакции, что и результат.</text><text class="xr-s" x="28" y="487">Повтор с тем же номером пропускается.</text>`;
        } else h += `<text class="xr-s" x="28" y="414">Выключено.</text><text class="xr-s xq-bad" x="28" y="432">Пришедшее второй раз сообщение</text><text class="xr-s xq-bad" x="28" y="448">обработается заново — это дубль.</text><text class="xr-s" x="28" y="472">Включи «Идемпотентный потребитель»</text><text class="xr-s" x="28" y="487">в настройках справа.</text>`;
        h = h1 + PG('idem', h);
        // повторы и DLQ — блок «повторы»
        const h2 = h; h = `<rect class="xr-zone" x="350" y="370" width="306" height="124" rx="10"/><text class="xr-t" x="362" y="390">Ошибки: повтор → DLQ</text><text class="xr-m acc" x="644" y="390" text-anchor="end">разобрать ›</text>`;
        if (G.retries) {
          h += `<rect class="xr-box" x="362" y="398" width="136" height="48" rx="8"/><text class="xr-s" x="372" y="413">ждут повтора: ${S.retry.length}</text>`;
          S.retry.slice(0, 3).forEach((r, i) => { const x = 376 + i * 36, f = clamp((t - r.from) / Math.max(1, r.at - r.from), 0, 1); h += `<rect class="xq-b poi" x="${x}" y="421" width="24" height="16" rx="3"/><circle class="xq-ring" cx="${x + 12}" cy="429" r="14" style="stroke-dasharray:${X1(f * 88)} 90"/>`; });
          h += `<rect class="xr-box ${S.dlqN ? 'hot' : ''}" x="508" y="398" width="136" height="48" rx="8"/><text class="xr-s" x="518" y="413">DLQ: ${S.dlqN}</text>`;
          S.dlq.slice(0, 4).forEach((m, i) => { h += `<rect class="xq-b poi" x="${518 + i * 30}" y="421" width="26" height="16" rx="3"/>`; });
          h += `<text class="xr-s" x="362" y="472">Пауза растёт: 0,7 с, потом 1,4 с.</text><text class="xr-s" x="362" y="487">После 3 попыток — в DLQ, на разбор.</text>`;
        } else h += `<text class="xr-s" x="362" y="414">Выключено у брокера:</text><text class="xr-s xq-bad" x="362" y="432">упавшее сообщение выбрасывается.</text><text class="xr-s" x="362" y="472">Включи «Повторы + DLQ» у брокера —</text><text class="xr-s" x="362" y="487">клик по нему слева.</text>`;
        h = h2 + PG('retry', h);
        // успеваем ли
        h += `<rect class="xr-zone" x="668" y="370" width="316" height="124" rx="10"/><text class="xr-t" x="680" y="390">Успеваем ли</text>`;
        const per = Math.min(10, Math.max(1, t / 1000));
        const bars = cmp ? S.lines.map(L => [L.label, L.ev.filter(e => e.k === 'ok').length / per, L.ev.filter(e => e.k === 'in').length / per]) : [['обрабатываем', S.lines[0].ev.filter(e => e.k === 'ok').length / per, S.lines[0].ev.filter(e => e.k === 'in').length / per]];
        const topV = Math.max(1, ...bars.map(b => Math.max(b[1], b[2])));
        const inR = bars[0][2];
        h += `<text class="xr-s" x="680" y="410">приходит</text><rect class="xr-bar" x="790" y="402" width="180" height="8" rx="4"/><rect class="xr-bar-f acc" x="790" y="402" width="${X1(180 * inR / topV)}" height="8" rx="4"/><text class="xr-m" x="970" y="${398}" text-anchor="end">${f1(inR)}/с</text>`;
        bars.forEach((b, i) => { const y = 428 + i * 22, ok = b[1] >= b[2] * 0.8; h += `<text class="xr-s" x="680" y="${y + 8}">${esc(cut(b[0].toLowerCase(), 16))}</text><rect class="xr-bar" x="790" y="${y}" width="180" height="8" rx="4"/><rect class="xr-bar-f ${ok ? '' : 'bad'}" x="790" y="${y}" width="${X1(180 * b[1] / topV)}" height="8" rx="4"/><text class="xr-m ${ok ? 'ok' : 'bad'}" x="970" y="${y - 4}" text-anchor="end">${f1(b[1])}/с</text>`; });
        const q = G.qs, pct = Math.round(Math.min(G.rho, 9) * 100);
        if (!cmp) h += `<text class="xr-s" x="680" y="472">На площадке: загрузка ${pct} %${q ? `, очередь ${q.growth > 0.5 ? 'растёт' : 'не растёт'}` : ''}.</text><text class="xr-s" x="680" y="487">${G.kf && G.count > G.parts ? `Партиций ${G.parts}: работают ${G.used} из ${G.count}.` : `Работают ${G.used} из ${G.count} экземпляров.`}</text>`;
        else h += `<text class="xr-s" x="680" y="487">Одинаковая работа, разная упаковка.</text>`;
        h += drawFx(S);
        ctx.svg.innerHTML = h;
      }
      /* ================= блоки изнутри: у каждого своя маленькая модель ================= */
      const PV = { k: null, t: 0, s: {}, fx: [] };
      const PG = (k, inner) => `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}">${inner}</g>`;
      const Lx = () => ({ T1: S.lines[0] ? S.lines[0].T1 : G.T1 });
      const WP = {};

      /* цикл poll → обработка → запись → commit: одни и те же 10 сообщений по одному и пачкой */
      function loopInfo(t) {
        const L = Lx(), bB = G.b > 1 ? G.b : 10, n = 10, callK = G.tgt ? (G.batchable ? 'write' : 'call') : null;
        const segs = b => {
          const o = [];
          if (b === 1) for (let i = 0; i < n; i++) { o.push(['poll', tTake(L, 1)], ['work', tW(L)]); if (callK) o.push([callK, G.batchable ? tBCall(L, 1) : tCall(L)]); o.push(['commit', tCommit(L, 1), 1]); }
          else { o.push(['poll', tTake(L, n)]); for (let i = 0; i < n; i++) { o.push(['work', tW(L)]); if (callK === 'call') o.push(['call', tCall(L)]); } if (callK === 'write') o.push(['write', tBCall(L, n)]); o.push(['commit', tCommit(L, n), n]); }
          return o;
        };
        const A = segs(1), B = segs(bB), tot = a => a.reduce((x, y) => x + y[1], 0), tA = tot(A), tB = tot(B), mx = Math.max(tA, tB), cyc = mx + 2500, play = t % cyc;
        const done = a => { let c = 0, d = 0; a.forEach(x => { c += x[1]; if (x[2] && c <= play) d += x[2]; }); return d; };
        const first = a => { let c = 0; for (const x of a) { c += x[1]; if (x[0] === 'commit') return c; } return c; };
        return { A, B, tA, tB, mx, cyc, play, bB, n, callK, dA: done(A), dB: done(B), fA: first(A) };
      }
      WP.loop = {
        tick(t) { PV.s.init = 1; const I = loopInfo(t); if (t > I.cyc) ctx.done('blk'); },
        draw(t) {
          const I = loopInfo(t), sc = 700 / I.mx;
          let h = T(20, 30, `Цикл обработчика: одни и те же 10 сообщений — по одному и ${I.bB > 10 ? 'пачкой до ' + I.bB : 'пачкой по ' + I.bB}`, 'xr-t');
          [[I.A, 'По одному', 94, G.b === 1, I.tA, I.dA], [I.B, I.bB > 10 ? `Пачкой до ${I.bB}` : `Пачкой по ${I.bB}`, 226, G.b > 1, I.tB, I.dB]].forEach(([a, name, y, on, tt, d]) => {
            h += R(14, y - 42, 972, 118, on ? 'xr-box sel' : 'xr-box') + T(28, y - 16, name, 'xr-t') + (on ? T(28, y + 4, '← у тебя сейчас', 'xr-m acc') : '') + T(28, y + 28, `готово: ${d} из 10`, 'xr-m' + (d === 10 ? ' ok' : ''));
            let x = 220;
            a.forEach(([k, dd]) => { const w = Math.max(1, dd * sc); h += `<rect class="xq-seg ${k}" x="${X1(x)}" y="${y - 20}" width="${X1(w)}" height="36"/>`; x += w; });
            h += T(x + 8, y + 4, sec(tt), 'xr-m');
          });
          const px = 220 + Math.min(I.play, I.mx) * sc;
          h += `<line class="xq-play" x1="${X1(px)}" y1="48" x2="${X1(px)}" y2="300"/>` + T(px, 318, sec(Math.min(I.play, I.mx)), 'xr-m', 'middle');
          [['poll', 'забрать (poll)'], ['work', 'обработать'], [I.callK === 'call' ? 'call' : 'write', I.callK === 'call' ? 'вызов соседа' : 'записать в базу'], ['commit', 'коммит offset']].forEach(([k, lb], i) => { h += `<rect class="xq-seg ${k}" x="${20 + i * 190}" y="336" width="14" height="14"/>` + T(40 + i * 190, 347, lb); });
          const r = I.tA / I.tB;
          h += T(20, 384, `На одно сообщение: по одному — ${sec(I.tA / I.n)}, пачкой — ${sec(I.tB / I.n)}. ${r > 1.08 ? `Пачка быстрее в ${f1(r)} раза.` : 'Почти без разницы.'}`, 'xr-t xq-sm');
          h += T(20, 406, `Первое сообщение готово: по одному — через ${sec(I.fA)}, пачкой — через ${sec(I.tB)}: вся пачка коммитится разом.`);
          h += T(20, 426, G.batchable ? 'Запись в базу пачкой стоит почти как одна запись — поэтому пачка выигрывает.' : I.callK ? 'Вызов внешнего сервиса — на каждое сообщение отдельно: пачка экономит только забор и коммит.' : 'Записи наружу нет: пачка экономит забор и коммит.');
          h += T(20, 446, `Упал посреди пачки — переделывать до ${I.bB} сообщений, а не одно.`);
          if (I.bB === 100) h += T(20, 466, 'При малом потоке пачка до 100 ждёт до 0,5 с и берёт сколько набралось.');
          return h;
        },
        now() {
          const I = loopInfo(PV.t);
          return `<b>Те же 10 сообщений.</b> По одному — ${sec(I.tA)}, пачкой — ${sec(I.tB)}. Сейчас готово: по одному ${I.dA}, пачкой ${I.dB}. ${I.dB < 10 && I.dA > I.dB ? 'Пачка пока ничего не отдала — она коммитится разом в конце.' : I.dB === 10 && I.dA < 10 ? 'Пачка уже закончила, а по одному ещё работает.' : ''}`;
        }
      };

      /* повторы с паузой */
      WP.retry = {
        tick() { PV.s.init = 1; },
        draw(t) {
          const play = (t % 7000) / 1000, X = v => 250 + v * 110, on = G.retries;
          let h = T(20, 30, 'Повтор с паузой: временный сбой лечится, битые данные уходят в DLQ', 'xr-t');
          h += `<line class="xr-wire" x1="250" y1="412" x2="${X(6)}" y2="412"/>`;
          for (let i = 0; i <= 6; i++) h += `<line class="xr-wire" x1="${X(i)}" y1="408" x2="${X(i)}" y2="416"/>` + T(X(i), 430, i + ' с', 'xr-m', 'middle');
          const rows = [
            ['Временный сбой', 'сеть моргнула, сосед перегружен', 88, on ? [[0, 0], [1.0, 1]] : [[0, 0]], on ? [[0.3, 1.0, 'пауза 0,7 с']] : [], on ? [1.4, '✓ прошло со второй попытки', 'okt'] : [0.4, '✕ выброшено — потеря', 'bad']],
            ['Битые данные', 'не пройдут никогда', 208, on ? [[0, 0], [1.0, 0], [2.7, 0]] : [[0, 0]], on ? [[0.3, 1.0, 'пауза 0,7 с'], [1.3, 2.7, 'пауза 1,4 с']] : [], on ? [3.1, '→ в DLQ после 3 попыток', 'warn'] : [0.4, '✕ выброшено — потеря', 'bad']],
            ['Без паузы', 'так делать нельзя', 328, [[0, 0], [0.35, 0], [0.7, 0], [1.05, 0], [1.4, 0], [1.75, 0]], [], [2.2, 'шторм: соседу в 6 раз больше запросов', 'bad']]
          ];
          rows.forEach(([name, sub, y, att, pauses, fin]) => {
            h += R(14, y - 38, 972, 98) + T(28, y - 8, name, 'xr-t xq-sm') + T(28, y + 12, sub);
            pauses.forEach(([a, b, lb]) => { if (play < a) return; h += `<rect class="xq-pause" x="${X1(X(a) + 2)}" y="${y - 3}" width="${X1(Math.max(0, X(Math.min(play, b)) - X(a) - 4))}" height="6" rx="3"/>`; if (play > a + 0.2) h += T((X(a) + X(b)) / 2, y - 26, lb, 'xr-m warn', 'middle'); });
            att.forEach(([s0, ok]) => { if (play < s0) return; const dn = play >= s0 + 0.3; h += `<rect class="xq-step ${dn ? (ok ? 'done' : 'bad') : 'act'}" x="${X1(X(s0))}" y="${y - 20}" width="33" height="40" rx="6"/>` + T(X(s0) + 16.5, y + 6, dn ? (ok ? '✓' : '✕') : '…', 'xr-t', 'middle'); });
            if (play >= fin[0]) h += T(X(fin[0]) + 10, y + 6, fin[1], 'xr-s xq-' + fin[2]);
          });
          h += `<line class="xq-play" x1="${X1(X(Math.min(play, 6)))}" y1="44" x2="${X1(X(Math.min(play, 6)))}" y2="404"/>`;
          h += T(20, 462, on ? 'Пауза растёт вдвое с каждой попыткой — плюс случайный разброс, чтобы повторы разных сообщений не шли хором.' : 'У брокера «Повторы + DLQ» выключены: первая же ошибка — потеря. Включи их у брокера (клик по нему на общей схеме).', 'xr-s' + (on ? '' : ' xq-warn'));
          h += T(20, 482, 'Повторять можно только то, что не навредит при повторе. Иначе нужен ключ идемпотентности.');
          return h;
        },
        now() {
          const p = (PV.t % 7000) / 1000;
          if (!G.retries) return '<b>Повторы выключены у брокера.</b> Любая ошибка — сразу потеря, даже если через секунду сосед бы ответил. Повторы и DLQ включаются в настройках брокера.';
          return p < 1 ? '<b>Обе попытки упали.</b> Сообщения не выбрасываются, а ждут паузу.' : p < 1.5 ? '<b>Вторая попытка.</b> Временный сбой прошёл — сосед ожил. Битые данные снова упали: ждём паузу вдвое длиннее.' : p < 3.2 ? '<b>Третья попытка битых данных.</b> Пауза выросла до 1,4 с — даём соседу прийти в себя.' : '<b>Итог.</b> Временный сбой вылечился повтором, битые данные ушли в DLQ и не держат очередь. А нижняя строка — повторы без паузы: добивают больного соседа.';
        }
      };

      /* защита от дублей: inbox */
      const IW_ = () => G.ext ? { res: 'письма клиенту', one: 'письмо по #141', two: 'ещё одно письмо по #141!', bad: 'клиент получил два письма', ok: 'письмо одно', job: 'письмо клиенту' } : { res: `записи в «${cut(G.tn || 'хранилище', 16)}»`, one: 'запись по #141', two: 'вторая запись по #141!', bad: 'запись задвоилась', ok: 'запись одна', job: 'запись результата' };
      WP.idem = {
        tick() { PV.s.init = 1; },
        draw(t) {
          const W_ = IW_(), p = t % 9000, dd = G.dedup, ph = p < 700 ? 0 : p < 1400 ? 1 : p < 2400 ? 2 : p < 3000 ? 3 : p < 3700 ? 4 : p < 4500 ? 5 : p < 5300 ? 6 : p < 6100 ? 7 : 8, two = ph >= 4;
          let h = T(20, 30, `Защита от дублей: таблица inbox ${dd ? 'включена' : 'выключена'}`, 'xr-t');
          h += R(20, 170, 180, 110) + T(32, 194, 'Брокер', 'xr-t xq-sm') + T(32, 216, 'сообщение #141', 'xr-m') + T(32, 238, two ? 'выдаёт ещё раз:' : 'выдаёт') + T(32, 258, two ? 'коммита не было' : '', 'xr-s xq-warn');
          if (ph === 0 || ph === 4) { const q = clamp((p - (ph ? 3000 : 0)) / 700, 0, 1); h += `<circle class="xr-dot" cx="${X1(200 + 40 * q)}" cy="225" r="6" style="fill:${KJ()}"/>`; }
          h += R(240, 46, 420, 398) + T(254, 70, `Обработчик · ${two ? 'вторая доставка #141' : 'первая доставка #141'}`, 'xr-t xq-sm');
          const S0 = [dd ? 'Есть #141 в inbox?' : 'Проверки нет', dd ? (two && ph >= 6 ? 'есть! → работу пропускаем' : ph >= 2 && !two ? 'нет → делаем работу' : 'смотрим в таблицу') : 'сразу к работе'];
          const S1 = ['Транзакция в базе', dd ? 'результат + запись #141 в inbox' : 'только результат: ' + W_.job];
          const S2 = ['Коммит offset 142', 'говорим брокеру: «досюда готово»'];
          const st = two ? [ph === 5 ? 'act' : ph >= 6 ? 'done' : '', ph === 6 ? (dd ? 'skip' : 'warn') : ph >= 7 ? (dd ? 'skip' : 'warn') : '', ph === 7 ? 'act' : ph >= 8 ? 'done' : '']
            : [ph === 1 ? 'act' : ph >= 2 ? 'done' : '', ph === 2 ? 'act' : ph >= 3 ? 'done' : '', ph === 3 ? 'bad' : ''];
          [S0, S1, S2].forEach(([a, b], i) => {
            const y = 88 + i * 104;
            h += `<rect class="xq-step ${st[i]}" x="260" y="${y}" width="380" height="84" rx="10"/>` + T(278, y + 32, `${i + 1}. ${a}`, 'xr-t xq-sm') + T(278, y + 56, st[i] === 'skip' ? 'пропущено: уже делали' : b, 'xr-s' + (st[i] === 'warn' ? ' xq-warn' : ''));
          });
          if (ph === 3) h += T(450, 312, '⚡ упал до коммита — брокер не знает, что #141 готово', 'xr-pop bad', 'middle');
          if (ph >= 8) h += `<rect class="xq-res ${dd ? 'ok' : 'bad'}" x="260" y="398" width="380" height="34" rx="8"/>` + T(450, 420, dd ? `Итог: ${W_.ok} — дубль пропущен` : `Итог: ${W_.bad}`, 'xr-t xq-sm', 'middle');
          h += R(690, 46, 290, 398) + T(704, 70, 'База данных', 'xr-t xq-sm') + T(704, 98, esc('Результат: ' + W_.res), 'xr-m');
          const rows1 = (ph >= 3 ? [[W_.one, 'ok']] : []).concat(!dd && ph >= 7 ? [[W_.two, 'bad']] : []);
          rows1.forEach(([tx, c], i) => { h += `<rect class="xq-res ${c}" x="704" y="${108 + i * 30}" width="262" height="24" rx="5"/>` + T(714, 124 + i * 30, tx, 'xr-s'); });
          if (!rows1.length) h += T(704, 124, 'пусто');
          h += T(704, 238, dd ? 'inbox: номера обработанных' : 'inbox: таблицы нет', 'xr-m');
          if (dd) ['#139', '#140'].concat(ph >= 3 ? ['#141'] : []).forEach((id, i) => { const hl = id === '#141' && ph === 5; h += `<rect class="xq-chip ${hl ? 'hl' : ''}" x="704" y="${248 + i * 30}" width="120" height="24" rx="5"/>` + T(764, 264 + i * 30, id + ' ✓', 'xr-m ' + (hl ? 'acc' : 'ok'), 'middle'); });
          else h += T(704, 264, 'повтор нечем узнать', 'xr-s xq-warn');
          h += T(20, 470, dd ? 'Номер пишется в той же транзакции, что и результат: либо оба, либо ничего. Поэтому упасть «между» нельзя.' : 'Без inbox повторная доставка — повторная работа. Включи «Идемпотентный потребитель» в настройках справа.', 'xr-s' + (dd ? '' : ' xq-warn'));
          h += T(20, 490, 'Для внешних API то же самое делает ключ идемпотентности: сервис сам узнаёт повтор.');
          return h;
        },
        now() {
          const p = PV.t % 9000, dd = G.dedup;
          return p < 1400 ? '<b>Первая доставка #141.</b> Обработчик ' + (dd ? 'смотрит в inbox — такого номера нет.' : 'сразу берётся за работу.') : p < 3000 ? `<b>Работа сделана (${IW_().job}) — и тут обработчик упал</b>, не успев сделать коммит offset.` : p < 4500 ? '<b>Брокер выдаёт #141 ещё раз:</b> коммита не было, он не знает, что сообщение обработано.' : dd ? `<b>Номер #141 уже в inbox</b> — работа пропускается, сразу коммит. Итог: ${IW_().ok}.` : `<b>Проверки нет — работа делается второй раз.</b> Итог: ${IW_().bad}. Это и есть дубль при at-least-once.`;
        }
      };

      /* внешний вызов: работа против ожидания */
      WP.call = {
        tick(t) {
          const s = PV.s, L = Lx();
          if (!s.init) { const K = clamp(G.act || 1, 1, 4); Object.assign(s, { init: 1, K, lanes: Array.from({ length: K }, (_, i) => ({ st: 'work', t0: 0, until: 1 + i * 260, hist: [] })) }); }
          const n = G.batchable ? Math.min(G.b, 10) : 1, wd = tW(L) * n, cd = G.tgt ? (G.batchable ? tBCall(L, n) : tCall(L)) : 0;
          Object.assign(s, { wd, cd, n });
          s.lanes.forEach(l => { let g = 0; while (t >= l.until && g++ < 30) { l.hist.push([l.st, l.t0, l.until]); const nx = l.st === 'work' && cd > 0 ? 'wait' : 'work'; l.t0 = l.until; l.st = nx; l.until = l.t0 + (nx === 'work' ? wd : cd); } l.hist = l.hist.filter(x => x[2] > t - 5000).slice(-40); });
        },
        draw(t) {
          const s = PV.s, x0 = 110, W = 580, sc = W / 5000;
          let h = T(20, 30, G.batchable ? `Запись в «${esc(cut(G.tn, 24))}»: экземпляр то считает, то ждёт записи пачки` : 'Внешний вызов: экземпляр больше ждёт ответа, чем работает', 'xr-t');
          if (!G.tgt) return h + T(20, 80, 'Обработчик никуда не пишет — проведи стрелку к базе или внешнему сервису.', 'xr-s xq-warn');
          const LH = Math.min(60, (276 - (s.K - 1) * 10) / s.K), ly = i => 66 + i * (LH + 10) + LH / 2, ty = 200, sl = slow() > 1;
          h += T(x0, 50, '← 5 секунд назад', 'xr-m') + T(x0 + W, 50, 'сейчас', 'xr-m', 'end');
          s.lanes.forEach((l, i) => {
            const y = ly(i);
            h += T(30, y + 5, `#${i + 1}`, 'xr-t') + `<rect class="xq-lane" x="${x0}" y="${X1(y - LH / 2)}" width="${W}" height="${X1(LH)}" rx="4"/>`;
            l.hist.concat([[l.st, l.t0, t]]).forEach(([k, a, b]) => { const xa = x0 + Math.max(0, a - (t - 5000)) * sc, xb = x0 + Math.max(0, b - (t - 5000)) * sc; if (xb - xa >= 0.5) h += `<rect class="xq-seg ${k === 'wait' ? 'wait' : 'work'}" x="${X1(xa)}" y="${X1(y - LH / 2 + 4)}" width="${X1(xb - xa)}" height="${X1(LH - 8)}"/>`; });
            if (l.st === 'wait') { const q = clamp((t - l.t0) / Math.max(1, l.until - l.t0), 0, 1), go = q < 0.5, r = go ? q * 2 : (q - 0.5) * 2, xa = go ? x0 + W : 790, xb = go ? 790 : x0 + W, ya = go ? y : ty, yb = go ? ty : y; h += `<circle class="xr-dot ${go ? '' : 'ok'}" cx="${X1(xa + (xb - xa) * r)}" cy="${X1(ya + (yb - ya) * r)}" r="5" style="${go ? 'fill:' + KJ() : ''}"/>`; }
          });
          const waiting = s.lanes.filter(l => l.st === 'wait').length, pw = s.wd / (s.wd + s.cd);
          h += R(790, ty - 74, 190, 148, 'xr-box' + (sl ? ' hot' : '')) + T(802, ty - 50, esc(cut(G.tn, 20)), 'xr-t xq-sm') + T(802, ty - 30, esc(cut((SD.TYPES[G.tgt.n.type] || {}).name || '', 24))) + T(802, ty - 6, `ответ ≈ ${sec(s.cd)}${sl ? ' (×3)' : ''}`, 'xr-m' + (sl ? ' warn' : '')) + T(802, ty + 16, `ждут ответа: ${waiting} из ${s.K}`) + T(802, ty + 36, G.batchable ? `пачка: ${s.n} за вызов` : 'вызов на сообщение');
          h += `<rect class="xq-seg work" x="20" y="366" width="14" height="14"/>` + T(40, 377, 'работает') + `<rect class="xq-seg wait" x="140" y="366" width="14" height="14"/>` + T(160, 377, 'ждёт ответа соседа');
          h += T(20, 410, `Экземпляр работает ${Math.round(pw * 100)} % времени и ждёт ${Math.round((1 - pw) * 100)} %.`, 'xr-t xq-sm');
          h += T(20, 432, `Один экземпляр: ${s.n} ${pl(s.n, 'сообщение', 'сообщения', 'сообщений')} за ${sec(s.wd + s.cd)}. Чтобы успевать, нужно больше экземпляров — они ждут параллельно.`);
          h += T(20, 454, G.batchable ? 'База принимает пачку одной записью: ждать приходится один раз на всю пачку.' : 'Внешний API — по вызову на сообщение: экземпляр ждёт на каждом, пачка не спасает.');
          h += T(20, 476, sl ? 'Сосед тормозит — синее растянулось. Без таймаута зависший ответ заберёт экземпляр навсегда.' : 'Включи ситуацию «Внешний сервис тормозит» — синее растянется втрое.');
          return h;
        },
        now() {
          const s = PV.s; if (!G.tgt) return '<b>Соседа нет.</b> Обработчику некуда писать результат.';
          const w = s.lanes.filter(l => l.st === 'wait').length, pw = Math.round(s.wd / (s.wd + s.cd) * 100);
          return `<b>Сейчас ждут ответа ${w} из ${s.K}.</b> Каждый экземпляр считает ${pw} % времени, остальное — ожидание «${esc(G.tn)}». ${slow() > 1 ? 'Сосед тормозит, и ожидание выросло втрое.' : 'Скорость упирается не в процессор, а в соседа.'}`;
        }
      };

      const word = () => (G.ext ? 'письмо' : 'сообщение');
      function slowOk() {
        const L = S.lines[0]; if (!L) return false;
        const b = G.b, perMsg = tW(L) + (G.tgt && !G.batchable ? 0.6 * L.T1 * 3 : 0) + ((G.tgt && G.batchable ? 0.45 * L.T1 * Math.pow(b, 0.55) * 3 : 0) + tCommit(L, b) + tTake(L, b)) / b;
        return 4 * perMsg / (Math.max(1, G.act) * 1000) < 1;
      }
      build();

      return {
        tick, draw,
        refresh() {
          const o = G; G = derive();
          if (PV.k) { PV.s = {}; PV.fx = []; }
          if (scn() === 'batch') { const B = S.lines[1]; if (B && G.b > 1 && B.b !== G.b) { B.b = G.b; B.label = 'Пачками по ' + G.b; } return; }
          const L = S.lines[0]; L.b = G.b; L.T1 = G.T1;
          if (L.inst.length !== G.showN) {
            L.inst.slice(G.showN).forEach(I => { const back = I.batch.filter(m => m.st !== 'err'); back.forEach(m => { m.st = 'wait'; m.again = true; }); L.q.unshift(...back); });
            const keep = L.inst.slice(0, G.showN); while (keep.length < G.showN) keep.push(mkI(keep.length)); L.inst = keep;
          }
          L.inst.forEach(I => { I.idle = I.k >= G.act; if (I.idle && I.batch.length) { const back = I.batch.filter(m => m.st !== 'err'); back.forEach(m => { m.st = 'wait'; m.again = true; }); L.q.unshift(...back); I.batch = []; I.ph = 'idle'; } });
          if (scn() === 'slow' && (o.count !== G.count || o.b !== G.b) && slowOk()) ctx.done('slow');
        },
        scenario() { S = fresh(); build(); },
        focus(k) { PV.k = k && WP[k] ? k : null; PV.t = 0; PV.s = {}; PV.fx = []; },
        onProp(k, prev, v) {
          if (k === 'batch') { if (+v > 1) ctx.done('batch'); return +v > 1 ? `Пачка ${v}: смотри на клетки в строке экземпляра — запись и коммит теперь один раз на пачку.` : 'По одному: каждое сообщение платит за свой вызов и свой коммит.'; }
          if (k === 'count') return +v > +prev ? 'Экземпляров больше — смотри, перестала ли расти очередь слева.' + (G.kf && +v > G.parts ? ` Но партиций ${G.parts}: лишние будут простаивать.` : '') : 'Экземпляров меньше — очередь может начать расти.';
          if (k === 'dedup') return v ? 'Номер каждого сообщения пишется в inbox. Повтор найдут и пропустят — открой «Упал посреди пачки».' : 'Inbox выключен: повторно доставленное сообщение обработается ещё раз.';
          if (k === 'autoscale') return v ? 'Число экземпляров растёт вместе с отставанием очереди, до 40.' : 'Число экземпляров фиксировано.';
          return '';
        },
        now() {
          if (PV.k && WP[PV.k] && PV.s.init) return WP[PV.k].now();
          const s = scn(), b = G.b, tn = esc(G.tn), pct = Math.round(Math.min(G.rho, 9) * 100);
          if (s === 'batch') { const B = S.lines[1]; return G.batchable || !G.tgt ? `<b>Сверху — по одному, снизу — пачками по ${B.b}.</b> Работа над каждым сообщением одинаковая. Но «по одному» на каждое сообщение делает свою запись${tn ? ` в «${tn}»` : ''} и свой коммит. Пачка платит эти накладные расходы один раз на всех — и успевает больше. Цена: первое сообщение ждёт, пока соберётся пачка (до ${sec(LINGER)}).` : `<b>Сверху — по одному, снизу — пачками по ${B.b}.</b> Но «${tn}» — внешний сервис: каждое сообщение всё равно отдельный вызов. Пачка экономит только на коммитах — разница маленькая. Здесь помогают больше экземпляров, а не пачка.`; }
          if (s === 'crash') return G.dedup ? '<b>Упал посреди пачки — пачка придёт снова.</b> Коммита не было, брокер выдаст всё с последнего отмеченного места. Inbox помнит номера обработанных — повторы пропускаются (зелёная обводка).' : `<b>Упал посреди пачки — пачка придёт снова.</b> Коммита не было, и уже обработанные сообщения пройдут второй раз (жёлтые). ${b > 1 ? `Чем больше пачка, тем больше переделывать — до ${b}. ` : ''}Защита — идемпотентный потребитель: таблица inbox с номерами обработанных.`;
          if (s === 'slow' && G.tgt && slowOk()) return `<b>«${tn}» отвечает в 3 раза дольше, но вы успеваете.</b> Экземпляров хватает, чтобы ждать ответы параллельно${G.batchable && b > 1 ? ', а пачка делает медленный вызов один раз на много сообщений' : ''}. Очередь слева не растёт. Таймаут на вызов всё равно нужен: «тормозит» легко превращается в «завис».`;
          if (s === 'slow') return !G.tgt ? '<b>Соседа нет</b> — тормозить некому. Проведи стрелку от обработчика к базе или внешнему сервису.' : G.batchable ? `<b>«${tn}» отвечает в 3 раза дольше.</b> Экземпляры стоят и ждут ответа — очередь растёт. Пачка помогает: один медленный вызов на всю пачку. Ещё — добавить экземпляры.` : `<b>«${tn}» отвечает в 3 раза дольше.</b> Каждый экземпляр стоит и ждёт ответа по каждому сообщению — очередь слева растёт. Пачка не поможет: вызовы всё равно по одному. Помогут больше экземпляров (ждать параллельно) и таймаут на вызов.${G.kf && G.count >= G.parts ? ` Но экземпляров уже не меньше, чем партиций (${G.parts}): новые будут простаивать — сначала добавь партиций у брокера.` : ''}`;
          if (s === 'error') return G.retries ? '<b>Ошибка — не повод выбрасывать сообщение.</b> Упавшее уходит на паузу и пробует снова: временный сбой проходит со второго раза. Безнадёжное после 3 попыток уходит в DLQ и не держит остальных.' : '<b>Ошибка — и сообщение выброшено.</b> У брокера выключены «Повторы + DLQ»: даже временный сбой превращается в потерю. Включи их у брокера — клик по нему слева.';
          let h = `<b>Каждый экземпляр берёт ${b > 1 ? 'пачку до ' + b + ' сообщений' : 'по одному сообщению'}</b>, обрабатывает по одному и в конце делает коммит — говорит брокеру «досюда готово». `;
          if (G.tgt) h += G.batchable ? (b > 1 ? `Запись в «${tn}» — одна на всю пачку: накладные расходы делятся на всех.` : `Каждое сообщение — отдельная запись в «${tn}» и отдельный коммит: много накладных расходов. Попробуй пачку 10.`) : `Каждое сообщение — отдельный вызов «${tn}»: точка уходит туда и возвращается с ответом.`;
          h += G.rho > 1 ? ` <b>Загрузка ${pct} %: не успевают</b> — очередь слева растёт.` : ` Загрузка ${pct} % — как на площадке.`;
          if (G.kf && G.count > G.parts) h += ` <b>${G.count - G.parts} ${pl(G.count - G.parts, 'экземпляр простаивает', 'экземпляра простаивают', 'экземпляров простаивают')}:</b> партиций у брокера ${G.parts}, а одну партицию читает один экземпляр.`;
          return h;
        },
        stats() {
          const t = S.t;
          if (scn() === 'batch') {
            const [A, B] = S.lines, ok = L => L.ev.filter(e => e.k === 'ok'), lat = L => { const o = ok(L); return o.length ? o.reduce((s, e) => s + e.lat, 0) / o.length : 0; };
            return [['По одному', String(ok(A).length), '', 'обработано за 10 с'], [B.label, String(ok(B).length), 'ok', 'обработано за 10 с'],
              ['Ждут: по одному', String(A.q.length), A.q.length > 10 ? 'bad' : '', 'в очереди'], ['Ждут: пачками', String(B.q.length), B.q.length > 10 ? 'bad' : '', 'в очереди'],
              ['Задержка: по одному', sec(lat(A)), '', 'от прихода до коммита'], ['Задержка: пачками', sec(lat(B)), '', 'вместе со сбором пачки']];
          }
          const L = S.lines[0], wait = L.q.length + L.inst.reduce((s, I) => s + I.batch.filter(m => m.st !== 'err').length, 0), c = k => cnt10(S.ev, t, k), o = L.ev.filter(e => e.k === 'ok'), lat = o.length ? o.reduce((s, e) => s + e.lat, 0) / o.length : 0, per = Math.min(10, Math.max(1, t / 1000));
          return [['Обработано', String(c('ok')), 'ok', 'за 10 с'], ['Скорость', f1(c('ok') / per) + '/с', '', `приходит ${f1(c('in') / per)}/с`],
            ['Ждут', String(wait), wait > 15 ? 'bad' : wait > 6 ? 'warn' : 'ok', 'в очереди и в пачках'], ['Ожидание', sec(lat), '', 'от прихода до коммита'],
            ['Дубли', String(c('dup')), c('dup') ? 'warn' : 'ok', c('skip') ? `пропущено защитой: ${c('skip')}` : 'обработаны второй раз'],
            ['Потеряно · DLQ', `${c('lost')} · ${S.dlqN}`, c('lost') ? 'bad' : '', 'потери за 10 с · в DLQ']];
        },
        destroy() {}
      };
    }
  };
})();
