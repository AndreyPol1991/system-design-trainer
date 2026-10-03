/* «Кэш изнутри»: память кэша — сетка ячеек-ключей. Попадания и промахи, вытеснение (LRU/LFU), TTL,
   стратегии записи и инвалидация, шарды и падение узла, набег на базу (stampede). */
(function () {
  SD.XRAY = SD.XRAY || {};
  // имена подобраны так, чтобы по слотам Redis Cluster (CRC16) ключи ложились ровно при 2–6 узлах
  const HOT = ['product:42', 'user:2', 'cart:1', 'product:3', 'catalog:1', 'product:11', 'user:1', 'promo:52', 'product:15', 'user:3', 'product:10', 'product:13'];
  const WT = HOT.map((k, i) => Math.pow(i + 1, -1.15));   // популярность по Ципфу: первые ключи читают намного чаще
  const TTLM = { '10s': 4000, '1m': 12000, '10m': 30000, '1h': 60000 };   // TTL в модели: время сжато
  const TTL_F = { '10s': 0.75, '1m': 0.9, '10m': 0.98, '1h': 1 };        // как в sim.js (hitRatio)
  const TTLS = { '10s': '10 с', '1m': '1 мин', '10m': '10 мин', '1h': '1 ч' };
  const TTLD = { '10s': '10 секунд', '1m': 'минуты', '10m': '10 минут', '1h': 'часа' };
  const PRICES = [100, 90, 95, 85, 110, 99];
  const RATE = 7, MAXC = 18, GO = 480, BACK = 420, TODB = 560, DBT = 520, LANE_T = 1300, FLUSH = 3200, DOWN = 4500, CYCLE = 20000,
    BURST = 14, STTL = 6500, PRICE_T = 5200, FXT = 1300, TAU = 8000, SIMUL = 350, SWEEP = 1000;
  const SV = { x: 16, y: 130, w: 150, h: 170 }, DB = { x: 834, y: 130, w: 150, h: 170 }, Z = { x: 226, y: 44, w: 548, h: 340 }, AR = { x: 262, y: 80, w: 500, h: 280 };
  const YO = 204, YB = 222, LANE = 406, ZX = Z.x + Z.w, LX1 = SV.x + 44, LX2 = DB.x + DB.w - 44;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pc = v => Math.round(clamp(v || 0, 0, 1) * 100) + ' %';
  const sec = ms => (Math.max(0, ms) / 1000).toFixed(1).replace('.', ',') + ' с';
  const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
  const crc16 = s => { let c = 0; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; };   // как в Redis Cluster
  const slotOf = k => crc16(k) % 16384;
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h); };
  const price = v => PRICES[(v || 0) % PRICES.length];
  const fmt = v => SD.fmt ? SD.fmt.num(v) : String(Math.round(v));
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  function along(pts, f) {
    if (pts.length < 2) return pts[0];
    const seg = []; let L = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
    let x = clamp(f, 0, 1) * L;
    for (let i = 0; i < seg.length; i++) {
      if (x <= seg[i] || i === seg.length - 1) { const k = seg[i] ? Math.min(1, x / seg[i]) : 1; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
      x -= seg[i];
    }
    return pts[pts.length - 1];
  }
  /* раскладка ячеек: шире и выше, но не уже 92 px, чтобы влез ключ и кольцо */
  function grid(s, w, h) {
    let best = null;
    for (let cols = 1; cols <= s; cols++) {
      const rows = Math.ceil(s / cols), gap = 8;
      const cw = Math.min(150, (w - (cols - 1) * gap) / cols), ch = Math.min(58, (h - (rows - 1) * gap) / rows);
      if (ch < 20) continue;
      const sc = Math.min(cw, 120) * ch - (cw < 92 ? 5000 : 0) + cols;
      if (!best || sc > best.sc) best = { cols, rows, cw, ch, gap, sc };
    }
    return best || { cols: s, rows: 1, cw: w / s, ch: 20, gap: 0 };
  }

  SD.XRAY.cache = {
    cta: 'Ячейки памяти с ключами: попадания и промахи, вытеснение, TTL, запись и устаревшие данные',
    dive: 'cache',
    simple: () => ({
      an: 'Как <b>холодильник у плиты</b>: ходовое лежит под рукой, за остальным идёшь в кладовую. Холодильник маленький — чтобы положить новое, что-то приходится выложить.',
      pl: 'Кэш — быстрая память перед базой. Нашёл ключ — ответ за 1 мс. Не нашёл — сервис идёт в базу (в 20 раз дольше) и кладёт ответ в кэш на будущее. Каждый ключ живёт ограниченное время (TTL), потом гаснет.'
    }),
    props: ['count', 'cluster', 'mem', 'eviction', 'ttl', 'policy', 'invalidate', 'stampede'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Память, TTL и вытеснение — как настроено. Доля попаданий подстроена под площадку.' },
      { id: 'small', name: 'Мало памяти', note: 'Горячих ключей вчетверо больше, чем ячеек: ключи вытесняют друг друга по кругу.' },
      { id: 'stamp', name: 'Популярный ключ истёк', note: 'У product:42 кончается TTL, и толпа запросов разом идёт в базу (stampede).' },
      { id: 'price', name: 'Цена поменялась', note: 'Раз в 5 с меняется цена product:42. Смотри, какую цену отдаёт кэш после записи.' },
      { id: 'cold', name: 'Кэш упал', note: 'Узел кэша падает и поднимается пустым — холодный старт. Нагрузка уходит в базу.' }
    ],
    tries: [
      { id: 'evict', text: 'Уменьши память (или выбери «Мало памяти») и посмотри, как ключи вытесняют друг друга' },
      { id: 'lfu', text: 'В «Мало памяти» переключи вытеснение на LFU: популярный product:42 перестаёт вылетать' },
      { id: 'ttl', text: 'Поставь TTL 10 секунд и поймай момент, когда истёк популярный ключ' },
      { id: 'stamp', text: 'В «Популярный ключ истёк» включи защиту от stampede: в базу идёт один запрос вместо толпы' },
      { id: 'price', text: 'В «Цена поменялась» выключи, а потом включи удаление ключа при записи: сравни, какую цену видит пользователь' },
      { id: 'shard', text: 'В «Кэш упал» поставь 2–3 узла Redis Cluster: падает только часть ключей, а не всё' },
      { id: 'pevict', text: 'Открой блок «Вытеснение» (в «Мало памяти») и найди ключ, который вылетит следующим' },
      { id: 'pcluster', text: 'Открой блок «Кластер и слоты» и поставь 3 узла: 16 384 слота делятся на три диапазона' }
    ],
    parts: {
      hash: {
        name: 'Хеш-таблица ключей',
        an: 'Как <b>гардероб с номерками</b>: по номерку сразу идёшь к нужному крючку, а не перебираешь все пальто.',
        pl: 'Кэш не ищет ключ перебором. Он превращает ключ в число (хеш) и по нему сразу находит «корзину», где лежит значение. Поэтому поиск занимает доли миллисекунды даже при миллионе ключей.',
        how: ['Сервис присылает ключ — строку вроде <b>product:42</b>.', 'Хеш-функция превращает строку в большое число. Одинаковый ключ всегда даёт одно и то же число.', 'Остаток от деления на число корзин — номер корзины.', 'В одной корзине может оказаться несколько ключей (коллизия). Их проверяют по цепочке, сравнивая строки.', 'Нашёл — отдаёт значение (попадание). Не нашёл — отвечает «нет» (nil), и сервис идёт в базу.', 'Ключей стало больше, чем корзин, — таблица удваивается, ключи понемногу переезжают (рехеширование).'],
        watch: 'Ключ слева проходит через хеш-функцию и попадает в свою корзину. В цепочке ключи сравниваются по очереди: зелёный — нашёлся, красный — не тот.',
        knobs: ['mem', 'count'],
        real: 'Redis хранит ключи в словаре (dict) с хешем SipHash. Таблица растёт удвоением, а переезд ключей идёт понемногу при каждой операции, чтобы не замирать. Одна запись — ключ, значение и около 50–70 байт служебных данных. GET на одном узле — около 0,1 мс, до ~100 тыс. операций в секунду.'
      },
      evict: {
        name: 'Вытеснение',
        an: 'Как <b>полка в холодильнике</b>: место кончилось — выкладываешь то, что давно не трогал (LRU), или то, что берёшь реже всего (LFU).',
        pl: 'Память кэша ограничена. Когда она заполнена, а нужно положить новый ключ, кэш сам выбрасывает один из старых. Правило выбора и есть политика вытеснения.',
        how: ['Кэш следит, сколько памяти занято, и сравнивает с лимитом (maxmemory).', 'Пришёл новый ключ, а места нет — кого-то надо выбросить.', '<b>LRU</b>: для каждого ключа помнится время последнего чтения. Выбрасывается тот, кого не трогали дольше всех.', '<b>LFU</b>: у каждого ключа есть счётчик чтений, со временем он остывает. Выбрасывается самый «холодный».', 'Redis не сортирует все ключи: берёт 5 случайных и выбрасывает худшего из них. Почти так же точно, но дёшево.', 'Выброшенный ключ при следующем чтении — промах, сервис снова пойдёт в базу.'],
        watch: 'Слева — только что прочитанные (или самые читаемые), справа — кандидат на выброс. Когда памяти не хватает, крайний справа вылетает с подписью, почему именно он.',
        knobs: ['eviction', 'mem'],
        real: 'Redis: maxmemory-policy = allkeys-lru или allkeys-lfu. Есть volatile-* (выбирать только среди ключей с TTL) и noeviction (отказать в записи). maxmemory-samples = 5. Счётчик LFU логарифмический: новый ключ начинает с 5, счётчик остывает раз в минуту (lfu-decay-time).'
      },
      ttl: {
        name: 'TTL: срок жизни',
        an: 'Как <b>срок годности на йогурте</b>: просрочен — выбрасываешь, даже если место в холодильнике есть.',
        pl: 'Каждому ключу при записи дают срок жизни. Когда он кончился, ключ считается удалённым: следующий запрос пойдёт в базу и принесёт свежее значение.',
        how: ['При записи: SET product:42 … EX 600 — «живи 600 секунд».', 'Кэш запоминает момент, когда ключ истечёт.', '<b>Лениво</b>: если кто-то читает истёкший ключ, кэш удаляет его в этот момент и отвечает «нет».', '<b>Фоново</b>: 10 раз в секунду кэш берёт 20 случайных ключей со сроком и удаляет истёкшие. Истёкших больше четверти — сразу ещё круг.', 'Короткий TTL — данные свежее, но больше промахов. Длинный — больше попаданий, но устаревшее живёт дольше.', 'Чтобы популярные ключи не истекали разом, к TTL добавляют случайный разброс.'],
        watch: 'Полоски — сколько осталось жить каждому ключу, они тают. Надпись «срок вышел» — ключ ещё лежит: его уберёт фоновая чистка (пунктирная рамка вокруг проверенных) или первое чтение.',
        knobs: ['ttl', 'invalidate'],
        real: 'Redis: EXPIRE или SET … EX; активная чистка 10 раз в секунду (hz 10) по 20 ключей. Memcached удаляет истёкшее только лениво. В этой модели время сжато: TTL 10 минут ≈ 30 секунд.'
      },
      write: {
        name: 'Политика записи',
        an: 'Как <b>ценник на полке и цена в кассе</b>: поменял цену в кассе — меняй и ценник, иначе покупатель увидит старую.',
        pl: 'Данные меняются в базе, а в кэше лежит копия. Политика записи решает, в каком порядке обновлять базу и кэш, чтобы пользователь не видел старое и ничего не потерялось.',
        how: ['<b>Cache-aside</b>: сервис пишет в базу, потом удаляет ключ из кэша (DEL). Следующее чтение — промах, свежее значение подтянется из базы.', 'Без удаления ключа кэш отдаёт старое значение до конца TTL.', '<b>Write-through</b>: сервис пишет и в кэш, и в базу; отвечает, когда записали оба. Кэш всегда свежий, запись чуть медленнее.', '<b>Write-behind</b>: сервис пишет только в кэш и сразу отвечает; кэш позже отправляет изменения в базу пачкой.', 'Write-behind быстрый, но если кэш упадёт до отправки, изменения пропадут.', 'Ключ удаляют, а не перезаписывают: так меньше риск, что параллельный читатель положит в кэш устаревшее.'],
        watch: 'Три линии: сервис, кэш, база. Стрелки появляются по шагам — видно, кто кому что пишет и в каком порядке. Вверху — цена product:42 в кэше и в базе прямо сейчас.',
        knobs: ['policy', 'invalidate', 'ttl'],
        real: 'Чаще всего — cache-aside с удалением ключа (так работает memcache в Facebook и большинство сервисов на Redis). Write-behind — когда записей очень много (счётчики, лайки), а потеря последних секунд не страшна.'
      },
      stamp: {
        name: 'Набег на базу',
        an: 'Как <b>открытие распродажи</b>: двери открылись — и вся толпа разом бежит к одной полке.',
        pl: 'Когда истекает очень популярный ключ, сотни запросов одновременно его не находят — и все идут в базу за одним и тем же. База получает пик нагрузки на ровном месте.',
        how: ['Популярный ключ читают сотни раз в секунду.', 'Его TTL кончился — ключа нет.', 'Пока первый запрос 20 мс ходит в базу, приходят ещё сотни — и тоже промахиваются.', 'Без защиты все они идут в базу: нагрузка вырастает в сотни раз (stampede).', '<b>Одна загрузка с замком</b> (single-flight): первый ставит замок (SET lock NX) и идёт в базу, остальные ждут его ответ.', '<b>Ранний перезапрос</b>: незадолго до конца TTL один запрос обновляет ключ заранее. <b>Разброс TTL</b> не даёт ключам истечь разом.'],
        watch: 'Ключ истекает (кольцо дотаяло), прибегает толпа. Без защиты все точки летят в базу. С защитой одна идёт в базу с замком, остальные ждут у кэша и получают её ответ.',
        knobs: ['stampede', 'ttl'],
        real: 'Single-flight есть в Go (golang.org/x/sync/singleflight), в Java — в загружающих кэшах Caffeine и Guava. В Redis замок делают командой SET lock:key 1 NX PX 3000. Ранний перезапрос — алгоритм XFetch (вероятностный ранний пересчёт).'
      },
      cluster: {
        name: 'Кластер и слоты',
        an: 'Как <b>почтовые ящики по алфавиту</b>: фамилии на А–К — в один шкаф, Л–Я — в другой. По фамилии сразу понятно, к какому шкафу идти.',
        pl: 'Памяти одного сервера мало. Поэтому ключи раскладывают по нескольким узлам: по ключу считают номер слота, а каждый узел отвечает за свой диапазон слотов.',
        how: ['Всего 16 384 слота. Узлы делят их между собой диапазонами.', 'Номер слота = CRC16(ключ) mod 16384 — простая контрольная сумма строки.', 'Клиент знает карту «слот → узел» и сразу идёт к нужному узлу.', 'Добавили узел — часть слотов переезжает к нему вместе с ключами.', 'Упал узел — пропадают ключи только его слотов.', 'Режим «главный + реплики»: у всех одна копия. Память не складывается, зато падение узла ничего не теряет.'],
        watch: 'Ключ превращается в число CRC16, потом в номер слота. Метка встаёт на полоску из 16 384 слотов, и подсвечивается узел, который этот диапазон держит.',
        knobs: ['count', 'cluster', 'mem'],
        real: 'Redis Cluster: 16 384 слота. Если клиент ошибся узлом, тот отвечает MOVED, и клиент обновляет карту. Хештег в фигурных скобках ({user:42}) кладёт связанные ключи в один слот. Обычно у каждого главного узла есть реплика.'
      },
      miss: {
        name: 'Промах: путь в базу',
        an: 'Как <b>сходить в кладовую</b>: на кухне не нашёл — спускаешься в подвал, приносишь и оставляешь на кухне, чтобы в следующий раз не ходить.',
        pl: 'Если ключа в кэше нет, сервис сам идёт в базу, берёт данные и кладёт их в кэш с TTL. Это cache-aside: кэш ничего не знает о базе, всю работу делает сервис.',
        how: ['Сервис: GET product:42 — спрашивает кэш (≈1 мс).', 'Кэш: nil — такого ключа нет (промах).', 'Сервис: SELECT … WHERE id = 42 — идёт в базу (≈20 мс, под нагрузкой дольше).', 'Сервис: SET product:42 … EX 600 — кладёт ответ в кэш со сроком жизни.', 'Сервис отвечает пользователю. Следующие запросы за этим ключом — попадания.', 'Чем больше промахов, тем тяжелее базе: 90 % попаданий — в 10 раз меньше запросов в базу, чем без кэша.'],
        watch: 'Сравни две дорожки: попадание — короткая стрелка туда и обратно, промах — длинный круг через базу. Внизу — сколько запросов в секунду сейчас реально доходит до базы.',
        knobs: ['mem', 'ttl'],
        real: 'Попадание в Redis — 0,1–1 мс, запрос в PostgreSQL по индексу — 1–20 мс, под нагрузкой — сотни. Хорошо настроенный кэш даёт 90–99 % попаданий.'
      }
    },
    legend: [
      ['read', 'Запрос на чтение: GET ключа'], ['write', 'Запись: новая цена'], ['ok', 'Ответ пользователю'],
      ['sq xc-sw3', 'Ячейка с горячим ключом: читают часто'], ['sq xc-sw0', 'Ячейка с редким ключом'],
      ['ring xc-swr', 'Кольцо — сколько ключу осталось жить (TTL)'], ['sq xc-swst', 'Устарело: в базе уже другое значение'],
      ['sq xc-swd', 'Записано только в кэш, в базе ещё нет'], ['bad', 'Вытеснен, истёк или узел упал']
    ],
    live: (n, r, all) => {
      const g = SD.app.A.graph, pe = g.edges.filter(e => e.to === n.id).map(e => g.nodes.find(x => x.id === e.from)).filter(Boolean);
      const pa = pe.find(x => ['app', 'faas', 'worker'].includes(x.type)) || pe[0];
      const rt = pa && all && all.ctx && all.ctx.routeMemo ? all.ctx.routeMemo.get(pa.id + '|read') : null;
      const l = r.load || {}, rd = Object.keys(l).filter(k => k !== 'write').reduce((s, k) => s + l[k], 0);
      const out = [['Чтений', fmt(rd) + '/с', '']];
      if (rt && rt.hit != null) out.push(['Попаданий', pc(rt.hit), rt.hit >= 0.85 ? 'ok' : rt.hit >= 0.6 ? 'warn' : 'bad']);
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      out.push(['Узлов', (r.count || n.props.count || 1) + ' × ' + n.props.mem + ' ГБ', '']);
      return out;
    },

    mount(ctx) {
      const esc = ctx.esc;
      const P = () => ctx.node.props;
      const Lv = () => (SD.app && SD.app.A && SD.app.A.level) || {};
      const S = { scn: 'norm', dn: {}, nodes: [], reqs: [], fx: [], ev: [], dbA: [], t: 0, logT: {}, flags: {}, lay: [] };
      ctx.svg.innerHTML = '<g id="xcSt"></g><g id="xcDy"></g>';
      const gSt = ctx.svg.querySelector('#xcSt'), gDy = ctx.svg.querySelector('#xcDy');
      const resOf = id => (ctx.all && ctx.all.nodes && ctx.all.nodes[id]) || {};
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 2500 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const ev = (k, key) => S.ev.push({ t: S.t, k, key });
      const cap = (txt, cls, force) => { if (!force && S.cap && S.t - S.cap.t < 1500 && S.cap.t > 0) return; S.cap = { txt, cls: cls || '', t: S.t }; };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.k === 'pop' && f.txt === txt && S.t - f.t0 < 1000)) return; S.fx.push({ k: 'pop', x, y, txt, cls: cls || '', t0: S.t }); };
      const rep = () => P().cluster === 'replicated';
      const cnt = () => clamp(+P().count || 1, 1, 6);
      const nN = () => rep() ? 1 : cnt();
      const hotGb = () => Lv().hotSetGb || 8;
      const perReal = () => clamp(Math.ceil(HOT.length * (+P().mem || 8) / hotGb() - 0.05), 1, Math.floor(MAXC / nN()));
      const perN = () => S.scn === 'small' ? Math.max(1, Math.ceil((nN() * perReal() <= 4 ? 2 : 3) / nN())) : perReal();
      const memGb = () => (rep() ? 1 : cnt()) * (+P().mem || 8);
      const shard = k => Math.floor(slotOf(k) * Math.max(1, S.nodes.length) / 16384);   // слот → узел: узлы держат равные диапазоны слотов
      const ttlOf = k => { const t = TTLM[P().ttl] || 30000; return S.scn === 'stamp' && k === HOT[0] ? Math.min(t, STTL) : t; };
      const lfu = () => P().eviction === 'lfu';
      const formula = r => {
        const p = P(); let h = (Lv().cacheMax || 0.97) * (1 - Math.exp(-2.5 * r)) * (TTL_F[p.ttl] || 0.98);
        if (p.eviction === 'lfu') h += (1 - h) * 0.15;
        if (p.policy === 'through') h += (1 - h) * 0.2;
        return Math.min(0.995, h);
      };
      function parent() { const ins = ctx.ins(); const p = ins.find(x => ['app', 'faas', 'worker'].includes(x.n.type)) || ins[0]; return p ? p.n : null; }
      function dbNode() {
        const own = ctx.outs().map(x => x.n).find(k => k.type === 'sql' || k.type === 'nosql'); if (own) return own;
        const pa = parent(); if (!pa) return null;
        const ks = SD.app.A.graph.edges.filter(e => e.from === pa.id).map(e => ctx.nodeOf(e.to)).filter(Boolean);
        return ks.find(k => k.type === 'sql' || k.type === 'nosql') || ks.find(k => ['search', 'objstore', 'external'].includes(k.type)) || null;
      }
      function simHit() {
        const pa = S.pa, all = ctx.all;
        const rt = pa && all && all.ctx && all.ctx.routeMemo ? all.ctx.routeMemo.get(pa.id + '|read') : null;
        if (rt) { if (rt.hit != null) return rt.hit; if (rt.cacheDown) return 0; }
        return formula(memGb() / hotGb());
      }
      const slotsTotal = () => S.nodes.reduce((s, nd) => s + nd.slots.length, 0);
      const target = () => S.scn === 'small' ? formula(slotsTotal() / HOT.length) : simHit();
      const realRate = () => {
        const pl = S.pa ? (resOf(S.pa.id).load || {}) : {}, own = ctx.res.load || {};
        const a = (pl.read || 0) + (pl.write || 0), b = Object.keys(own).reduce((s, k) => s + own[k], 0);
        return a || b;
      };
      const wShare = () => { const t = Lv().traffic || {}, r = t.read || 0, w = t.write || 0; return clamp(r + w ? w / (r + w) : 0.04, 0.03, 0.2); };
      const pickHot = from => { let s = 0; for (let i = from; i < HOT.length; i++) s += WT[i]; let x = Math.random() * s; for (let i = from; i < HOT.length; i++) { x -= WT[i]; if (x <= 0) return HOT[i]; } return HOT[HOT.length - 1]; };
      const tail = () => 'product:' + (1000 + Math.floor(Math.random() * 9000));
      const pickKey = () => {
        const r = Math.random();
        if (S.scn === 'stamp' || S.scn === 'price') return r < (S.scn === 'stamp' ? 0.12 : 0.45) ? HOT[0] : r > 0.92 ? tail() : pickHot(1);
        return r < S.pHot ? pickHot(0) : tail();
      };
      const findC = (ni, key) => S.nodes[ni] ? S.nodes[ni].slots.find(c => c && c.key === key) : null;
      const door = ni => (S.lay[ni] || S.lay[0]).door;
      const cellPos = (ni, c) => {
        const nd = S.nodes[ni], b = S.lay[ni]; if (!nd || !b) return [ZX - 40, YO];
        const j = c ? nd.slots.indexOf(c) : -1; if (j < 0 || !b.cells[j]) return b.door;
        const g = b.cells[j]; return [g.x + g.w / 2, g.y + g.h / 2];
      };
      const cellGeo = (ni, j) => S.lay[ni] && S.lay[ni].cells[j];

      /* ---------- память: узлы, ячейки, раскладка ---------- */
      function layout() {
        const N = S.nodes.length, per = S.nodes[0].slots.length, cpy = rep() && cnt() > 1 ? Math.min(3, cnt() - 1) * 5 : 0;
        const need = Math.max(per, Math.min(Math.floor(MAXC / N), Math.ceil(HOT.length / N)));   // сколько ячеек нужно горячим ключам
        const cols = N === 4 ? 2 : Math.min(N, 3), rows = Math.ceil(N / cols), g = 10;
        const bw = (AR.w - cpy - (cols - 1) * g) / cols, bh = (AR.h - cpy - (rows - 1) * g) / rows;
        S.lay = S.nodes.map((nd, i) => {
          const b = { x: AR.x + (i % cols) * (bw + g), y: AR.y + Math.floor(i / cols) * (bh + g), w: bw, h: bh, cpy };
          const aw = b.w - 16, ah = b.h - 38, gr = grid(need, aw, ah);
          const tw = gr.cols * gr.cw + (gr.cols - 1) * gr.gap, th = gr.rows * gr.ch + (gr.rows - 1) * gr.gap;
          const ox = b.x + 8 + (aw - tw) / 2, oy = b.y + 30 + Math.max(0, (ah - th) / 2);
          b.cells = Array.from({ length: need }, (_, j) => ({ x: ox + (j % gr.cols) * (gr.cw + gr.gap), y: oy + Math.floor(j / gr.cols) * (gr.ch + gr.gap), w: gr.cw, h: gr.ch }));
          b.door = [b.x + b.w / 2, b.y + 14];
          return b;
        });
      }
      function rebuild() {
        const N = nN(), per = perN(), prev = S.nodes || [];
        const old = prev.flatMap(nd => nd.slots.filter(Boolean));
        S.nodes = Array.from({ length: N }, (_, i) => ({ slots: Array(per).fill(null), down: prev[i] ? prev[i].down : false, upAt: prev[i] ? prev[i].upAt : 0, cold: 0 }));
        old.sort((a, b) => b.h - a.h).forEach(c => { const nd = S.nodes[shard(c.key)]; if (nd.down) return; const j = nd.slots.indexOf(null); if (j >= 0) nd.slots[j] = c; });
        S.loading = {};
        S.reqs.forEach(r => { if (r.key) r.node = shard(r.key); r.cell = null; if (r.ph === 'wait') toBack(r, pos(r)); });
        S.N = N; S.per = per;
        layout();
      }
      function resize() {
        if (nN() !== S.N) { rebuild(); return; }
        const per = perN();
        if (per !== S.per) {
          S.nodes.forEach((nd, ni) => {
            while (nd.slots.length > per) {
              let j = nd.slots.lastIndexOf(null);
              if (j < 0) { j = victim(nd); if (j < 0) j = nd.slots.length - 1; evict(ni, j, null); }
              nd.slots.splice(j, 1);
            }
            while (nd.slots.length < per) nd.slots.push(null);
          });
          S.per = per;
        }
        layout();
      }
      const mk = (key, life) => ({ key, ver: S.db[key] || 0, exp: S.t + life, ttl: ttlOf(key), born: S.t, last: S.t, n: 1, h: 2, fl: -1e9, flk: 'set', dirty: false, inb: false, delp: false });
      function prewarm() {
        HOT.forEach((k, i) => {
          const nd = S.nodes[shard(k)]; if (nd.down) return;
          const j = nd.slots.indexOf(null); if (j < 0) return;
          const t = ttlOf(k), c = mk(k, i === 0 && S.scn === 'stamp' ? 2600 : i === 0 && S.scn === 'price' ? t : t * (0.3 + 0.7 * Math.random()));
          c.h = 14 / (i + 1) + 0.4; c.n = Math.round(c.h * 3); c.last = -Math.random() * 900 * (i + 1);
          nd.slots[j] = c;
        });
      }
      function victim(nd) {
        let bi = -1;
        nd.slots.forEach((c, i) => {
          if (!c) return;
          if (bi < 0) { bi = i; return; }
          const b = nd.slots[bi];
          const worse = lfu() ? (c.h < b.h - 1e-6 || (Math.abs(c.h - b.h) <= 1e-6 && c.last < b.last)) : c.last < b.last;
          if (worse) bi = i;
        });
        return bi;
      }
      function evict(ni, j, nk) {
        const nd = S.nodes[ni], c = nd.slots[j]; if (!c) return;
        const g = cellGeo(ni, j), L = lfu();
        if (g) S.fx.push({ k: 'ghost', x: g.x, y: g.y, w: g.w, h: g.h, ni, j, key: c.key, txt: 'вытеснен', cls: 'bad', t0: S.t });
        cap(`вытеснен ${c.key}: ${L ? `его читают реже всех (≈${Math.max(1, Math.round(c.h))}×), LFU` : `его дольше всех не читали (${sec(S.t - c.last)}), LRU`}${nk ? ` — место нужно ${nk}` : ''}`, 'bad');
        ev('evict', c.key); S.lastEv = { ni, key: c.key, nk, t: S.t, h: c.h, age: S.t - c.last, lfu: L };
        if (c.dirty) flushNow([c]);
        nd.slots[j] = null;
        const why = L ? `его читают реже всех (≈${Math.max(1, Math.round(c.h))} раз${Math.round(c.h) >= 2 && Math.round(c.h) <= 4 ? 'а' : ''} за последние секунды)` : `его дольше всех не читали (${sec(S.t - c.last)})`;
        note('evict', `<b>Вытеснен ${esc(c.key)}</b>: память полна${nk ? `, а ключу ${esc(nk)} нужно место` : ''}. ${L ? 'LFU' : 'LRU'} выбрал его, потому что ${why}.`, 'warn', 3000);
      }
      function setKey(ni, key, ver, reads) {   // SET после ответа базы: место занимаем только сейчас, как в Redis
        const nd = S.nodes[ni]; if (!nd || nd.down) return null;
        let c = findC(ni, key);
        if (!c || c.delp) {
          let j = c ? nd.slots.indexOf(c) : nd.slots.indexOf(null);
          if (j < 0) { const x = nd.slots.findIndex(dead); if (x >= 0) { drop(ni, x, 'sweep'); j = x; } }
          if (j < 0) { j = victim(nd); if (j < 0) return null; evict(ni, j, key); }
          else if (c) S.reqs.forEach(x => { if (x.k === 'del' && x.cell === c) { x.cell = null; x.repl = 1; } });   // старое значение удалять уже не нужно
          c = mk(key, ttlOf(key)); c.h = 2 + (reads || 0); c.n = 1 + (reads || 0);
          nd.slots[j] = c;
        }
        const p = P(), t = ttlOf(key);
        c.ver = p.policy === 'aside' && p.invalidate === false ? Math.max(c.ver, ver || 0) : Math.max(c.ver, S.db[key] || 0);
        c.exp = S.t + t; c.ttl = t; c.last = S.t; c.inb = true; c.delp = false;
        return c;
      }
      const touch = c => { c.last = S.t; c.n++; c.h += 1; c.fl = S.t; c.flk = 'hit'; };

      /* ---------- запросы ---------- */
      function spawnRead(key, burst) {
        const ni = shard(key), nd = S.nodes[ni], c = findC(ni, key);
        const tgt = c && !nd.down ? cellPos(ni, c) : door(ni);
        S.reqs.push({ id: S.seq++, k: 'read', key, node: ni, ph: 'go', p0: S.t, dur: GO * ((ctx.res.util || 0) > 1 ? 1.5 : 1), pts: [[SV.x + SV.w, YO], [Z.x, YO], tgt], burst });
        S.lastKey = key;
      }
      function spawnWrite(key) {
        const ver = S.wv[key] = Math.max(S.wv[key] || 0, S.db[key] || 0) + 1, p = P(), ni = shard(key), c = findC(ni, key);
        const toC = [[SV.x + SV.w, YO + 6], [Z.x, YO + 6], c ? cellPos(ni, c) : door(ni)];
        const lane = [[LX1, SV.y + SV.h], [LX1, LANE], [LX2, LANE], [LX2, DB.y + DB.h]];
        if (p.policy === 'behind') S.reqs.push({ id: S.seq++, k: 'wput', key, ver, node: ni, ph: 'go', p0: S.t, dur: GO, pts: toC });
        else {
          S.reqs.push({ id: S.seq++, k: 'wdb', key, ver, node: ni, ph: 'go', p0: S.t, dur: LANE_T, pts: lane });
          if (p.policy === 'through') S.reqs.push({ id: S.seq++, k: 'wput', key, ver, node: ni, ph: 'go', p0: S.t, dur: GO, pts: toC });
        }
        ev('write', key);
        if (key === HOT[0]) S.lastKey = 'SET ' + key;
      }
      function flushNow(cells) {
        const items = cells.map(c => [c.key, c.ver]); cells.forEach(c => { c.dirty = false; });
        S.reqs.push({ id: S.seq++, k: 'flush', items, ph: 'go', p0: S.t, dur: TODB, pts: [[ZX - 14, YO], [ZX, YO], [DB.x, YO], [DB.x + 16, YO + 8]] });
      }
      const toBack = (r, from) => { r.ph = 'back'; r.p0 = S.t; r.dur = BACK; r.pts = [from, [Z.x, YB], [SV.x + SV.w, YB]]; };
      function toDb(r, from, bypass) { r.ph = 'todb'; r.p0 = S.t; r.dur = TODB; r.bypass = bypass; r.pts = [from, [ZX, YO], [DB.x, YO], [DB.x + 16, YO + 8]]; }
      function dbArrive(r) {
        S.dbA.push(S.t); S.dbNew = (S.dbNew || 0) + 1;
        if (r.burst && S.burst) S.burst.n++;
        const k = S.dbA.filter(t => t > S.t - 500).length;
        if (k >= 5) pop(DB.x + DB.w / 2, DB.y - 8, `×${k} разом`, 'bad');
      }
      function lookup(r) {
        const ni = r.node, nd = S.nodes[ni], here = pos(r), hot = HOT.includes(r.key);
        if (!nd || nd.down) { r.res = 'down'; ev('down', r.key); pop(here[0], here[1] - 8, 'узел недоступен', 'bad'); toDb(r, here, true); return; }
        let c = findC(ni, r.key);
        if (dead(c)) { drop(ni, nd.slots.indexOf(c), 'lazy'); c = null; }
        S.tr.push({ key: r.key, ni, t: S.t, found: !!(c && !c.delp) }); if (S.tr.length > 12) S.tr.shift();
        if (c && c.inb) {   // значение уже записано (SET), его точка ещё летит к ячейке
          r.res = 'hit'; ev('hit', r.key); if (hot) S.hh += (1 - S.hh) * 0.04;
          c.last = S.t; c.n++; c.h += 1;
          r.ph = 'cwait'; r.cell = c; r.p0 = S.t; r.dur = Infinity; return;
        }
        if (c && !c.delp) {
          touch(c);
          const stale = !c.dirty && c.ver < (S.db[r.key] || 0);
          r.res = stale ? 'stale' : 'hit'; ev(r.res, r.key);
          if (hot) S.hh += (1 - S.hh) * 0.04;
          if (stale) {
            if (P().policy === 'aside' && P().invalidate === false) S.flags.stale = 1;
            pop(here[0], here[1] - 14, `${price(c.ver)} ₽ — старая цена`, 'bad');
            note('stale', `Пользователь получил <b>старую цену ${price(c.ver)} ₽</b> из кэша, а в базе уже ${price(S.db[r.key])} ₽.`, 'bad', 3500);
          }
          toBack(r, cellPos(ni, c));
          return;
        }
        const ld = S.loading[r.key], late = ld && S.t - ld.t > SIMUL && !r.burst;   // толпа из набега — всегда одновременная
        if (ld && (late || P().stampede)) {
          // ключ уже грузят. Пришёл позже 0,35 с — в реальном времени (база отвечает за 20 мс) он бы уже лежал в кэше: попадание.
          // Пришёл одновременно и включена защита — промах, но в базу не идёт: ждёт ответ первого (single-flight).
          r.res = late ? 'hit' : 'miss'; ev(r.res, r.key);
          if (hot) S.hh += late ? (1 - S.hh) * 0.04 : -S.hh * 0.04;
          ld.w++; r.ph = 'wait'; r.late = late; r.p0 = S.t; r.dur = Infinity;
          if (!late && r.burst && S.burst) S.burst.w++;
          return;
        }
        if (hot) S.hh -= S.hh * 0.04;
        r.res = 'miss'; ev('miss', r.key);
        if (!ld) S.loading[r.key] = { t: S.t, id: r.id, w: 0 };
        pop(here[0], here[1] + 10, 'промах', 'warn');
        toDb(r, here, false);
      }
      function gotValue(r) {
        const ld = S.loading[r.key], mine = ld && ld.id === r.id;
        if (mine) delete S.loading[r.key];
        r.ver = S.db[r.key] || 0;
        const ws = mine ? S.reqs.filter(x => x.ph === 'wait' && x.key === r.key) : [];
        ws.forEach(x => toBack(x, pos(x)));
        const sf = ws.filter(x => !x.late).length;
        if (sf >= 2) note('sf', `Single-flight: в базу за ${esc(r.key)} сходил <b>1 запрос</b>, ещё ${sf} получили его ответ.`, 'ok', 3000);
        if (sf >= 5 && r.burst) done('stamp');
        if (r.burst && S.burst && !S.burst.logged && S.burst.n >= 5 && !P().stampede) { S.burst.logged = 1; note('stmp', `<b>Набег (stampede):</b> ключ product:42 истёк, и ${S.burst.n} запросов разом пошли в базу за одним и тем же. В жизни их сотни.`, 'bad', 0); }
        const nd = S.nodes[r.node];
        if (r.bypass || !nd || nd.down) { r.ph = 'ret'; r.p0 = S.t; r.dur = 1000; r.pts = [pos(r), [DB.x, YB], [ZX, YB], [Z.x, YB], [SV.x + SV.w, YB]]; return; }
        const c = setKey(r.node, r.key, r.ver, ws.length);
        r.cell = c; r.ph = 'fromdb'; r.p0 = S.t; r.dur = TODB;
        r.pts = [pos(r), [DB.x, YB], [ZX, YB], c ? cellPos(r.node, c) : door(r.node)];
      }
      function setCell(r) {
        const nd = S.nodes[r.node], c = r.cell;
        if (!c || !nd || nd.down || !nd.slots.includes(c)) { toBack(r, pos(r)); return; }
        c.inb = false; c.fl = S.t; c.flk = 'set';
        S.reqs.forEach(x => { if (x.ph === 'cwait' && x.cell === c) toBack(x, pos(x)); });
        if (S.scn === 'price' && r.key === HOT[0] && S.flags.del) {
          S.flags.fresh = 1; S.flags.del = 0;
          note('fresh', `После удаления ключа промах сходил в базу и положил в кэш <b>свежую цену ${price(c.ver)} ₽</b>.`, 'ok', 0);
        }
        toBack(r, cellPos(r.node, c));
      }
      function putCell(r) {   // запись в кэш: write-through и write-behind
        const ni = r.node, nd = S.nodes[ni], p = P(), here = pos(r);
        if (!nd || nd.down) {
          if (p.policy === 'behind') { ev('lost', r.key); pop(here[0], here[1] - 10, 'кэш лежит — запись потеряна', 'bad'); note('wlost', 'Write-behind: кэш недоступен, <b>запись потеряна</b> — в базу она не попадёт.', 'bad', 3000); }
          r.gone = true; return;
        }
        let c = findC(ni, r.key);
        if (!c) {
          let j = nd.slots.indexOf(null);
          if (j < 0) { j = victim(nd); if (j >= 0) evict(ni, j, r.key); }
          if (j < 0) { r.gone = true; return; }
          c = mk(r.key, ttlOf(r.key)); nd.slots[j] = c;
        }
        c.inb = false; c.delp = false; c.ver = Math.max(c.ver, r.ver); c.exp = S.t + ttlOf(r.key); c.ttl = ttlOf(r.key); c.fl = S.t; c.flk = 'upd';
        if (p.policy === 'behind') {
          c.dirty = true;
          if (r.key === HOT[0]) note('wb', `Write-behind: цена <b>${price(c.ver)} ₽</b> записана только в кэш. В базу уйдёт пачкой позже.`, 'warn', 4000);
        } else if (r.key === HOT[0]) note('wt', `Write-through: цена <b>${price(c.ver)} ₽</b> записана в кэш и в базу одновременно — кэш сразу свежий.`, 'ok', 4000);
        r.gone = true;
      }
      function dbWrite(r) {
        S.db[r.key] = Math.max(S.db[r.key] || 0, r.ver); dbArrive(r);
        if (r.key === HOT[0]) pop(DB.x + DB.w / 2, DB.y - 8, `в базе: ${price(S.db[r.key])} ₽`, '');
        const p = P();
        if (p.policy === 'aside') {
          if (p.invalidate !== false) {
            const ni = shard(r.key), c = findC(ni, r.key);
            if (c) c.delp = true;
            S.reqs.push({ id: S.seq++, k: 'del', key: r.key, node: ni, cell: c || null, ph: 'go', p0: S.t, dur: 380, pts: [[SV.x + SV.w, YO - 6], [Z.x, YO - 6], c ? cellPos(ni, c) : door(ni)] });
          } else if (r.key === HOT[0] && findC(shard(r.key), r.key)) note('noinv', `Цена в базе стала ${price(S.db[r.key])} ₽, а ключ в кэше <b>не удалили</b>: там осталась старая.`, 'warn', 4000);
        }
        r.gone = true;
      }
      function delCell(r) {
        const ni = r.node, nd = S.nodes[ni], here = pos(r);
        r.gone = true;
        if (!nd || nd.down) { pop(here[0], here[1] - 10, 'кэш лежит', 'bad'); return; }
        const j = r.cell ? nd.slots.indexOf(r.cell) : -1;
        if (j < 0) { if (!r.repl) pop(here[0], here[1] - 10, 'ключа и так нет', ''); return; }
        const g = cellGeo(ni, j);
        if (g) S.fx.push({ k: 'ghost', x: g.x, y: g.y, w: g.w, h: g.h, ni, j, key: r.key, txt: 'удалён (DEL)', cls: 'acc', del: 1, t0: S.t });
        cap(`DEL ${r.key}: после записи в базу ключ удалён — следующее чтение возьмёт свежее`, 'acc', true);
        nd.slots[j] = null; ev('del', r.key);
        if (r.key === HOT[0]) { S.flags.del = 1; note('del', `Цена записана в базу, и сервис <b>удалил ключ ${esc(r.key)}</b> из кэша (DEL). Старую цену больше никто не увидит.`, 'ok', 3000); }
      }
      function flushed(r) {
        r.items.forEach(([k, v]) => { S.db[k] = Math.max(S.db[k] || 0, v); });
        dbArrive(r); r.gone = true;
        pop(DB.x + DB.w / 2, DB.y - 8, `пачка ×${r.items.length} записана`, 'ok');
        note('flush', `Write-behind: пачка из ${r.items.length} ${plural(r.items.length, 'записи', 'записей', 'записей')} ушла из кэша в базу.`, '', 6000);
      }
      function advance(r) {
        const at = r.p0 + r.dur;
        if (r.k === 'read') {
          if (r.ph === 'go') return lookup(r);
          if (r.ph === 'todb') { r.ph = 'indb'; r.p0 = at; r.dur = DBT * S.slow; dbArrive(r); return; }
          if (r.ph === 'indb') return gotValue(r);
          if (r.ph === 'fromdb') return setCell(r);
          if (r.ph === 'back' || r.ph === 'ret') { r.gone = true; S.lastRes = r.res; return; }
        }
        if (r.k === 'wdb') return dbWrite(r);
        if (r.k === 'wput') return putCell(r);
        if (r.k === 'del') return delCell(r);
        if (r.k === 'flush') return flushed(r);
        r.gone = true;
      }
      function index() {
        let a = 0, b = 0;
        S.reqs.forEach(r => { if (r.ph === 'indb') r.qi = a++; else if (r.ph === 'wait') r.qi = b++; });
        S.nIn = a; S.nWait = b;
      }
      function pos(r) {
        if (r.ph === 'indb') { const i = Math.min(r.qi || 0, 27); return [DB.x + 16 + (i % 7) * 18, 212 + Math.floor(i / 7) * 15]; }
        if (r.ph === 'wait') { const i = Math.min(r.qi || 0, 13); return [Z.x + 10 + (i % 2) * 14, YB + 30 + Math.floor(i / 2) * 12]; }
        if (r.ph === 'cwait') { const q = cellPos(r.node, r.cell), i = r.id % 5; return [q[0] - 24 + i * 12, q[1] + 2]; }
        return along(r.pts, (S.t - r.p0) / r.dur);
      }
      const dead = c => c && !c.inb && !c.dirty && c.exp <= S.t;   // срок вышел, но ключ ещё лежит
      function drop(ni, j, how) {   // удалить истёкший ключ: лениво при чтении или фоновой чисткой
        const c = S.nodes[ni].slots[j], g = cellGeo(ni, j); if (!c) return;
        if (g) S.fx.push({ k: 'gone', x: g.x, y: g.y, w: g.w, h: g.h, ni, j, key: c.key, txt: 'истёк TTL', cls: 'warn', t0: S.t });
        S.nodes[ni].slots[j] = null; ev('exp', c.key);
        if (how === 'lazy') S.lazy.push(S.t);
        cap(`истёк TTL у ${c.key}: ${how === 'lazy' ? 'удалён при чтении (лениво) — этот запрос пойдёт в базу' : 'убрала фоновая чистка'}`, 'warn');
        const rk = HOT.indexOf(c.key);
        if (rk >= 0 && rk < 3 && P().ttl === '10s') done('ttl');
        if (rk >= 0 && rk < 4) note('exp', `Ключ <b>${esc(c.key)}</b> истёк: кончился TTL. ${how === 'lazy' ? 'Его удалили прямо при чтении' : 'Его убрала фоновая чистка'} — следующий запрос пойдёт в базу.`, '', 3500);
      }
      function sweep() {   // как в Redis: берём 5 случайных ключей со сроком, удаляем истёкшие; много истёкших — ещё круг
        const cand = [], res = { t: S.t, keys: [], gone: 0 };
        S.nodes.forEach((nd, ni) => { if (!nd.down) nd.slots.forEach((c, j) => { if (c && !c.inb && !c.dirty) cand.push([ni, j, c]); }); });
        for (let loop = 0; loop < 4 && cand.length; loop++) {
          const smp = []; for (let i = 0; i < 5 && cand.length; i++) smp.push(cand.splice(Math.floor(Math.random() * cand.length), 1)[0]);
          let ex = 0;
          smp.forEach(([ni, j, c]) => { res.keys.push(c.key); if (dead(c) && S.nodes[ni].slots[j] === c) { drop(ni, j, 'sweep'); ex++; } });
          res.gone += ex;
          if (ex / smp.length < 0.25) break;
        }
        S.sw = res;
      }
      function startBurst() {
        S.burstAt = S.t + 9000; S.burstQ = BURST; S.burstNext = S.t; S.burst = { t: S.t, n: 0, w: 0 };
        const c = findC(shard(HOT[0]), HOT[0]);
        if (c && !c.inb) { c.bf = 1; if (c.exp > S.t) c.exp = S.t; }   // запасной таймер: ключ истекает принудительно
      }
      function crash() {
        const N = S.nodes.length;
        if (rep() && cnt() > 1) {
          S.fo = S.t + DOWN; cap('главный узел упал — реплика стала главной, у неё та же копия ключей', 'ok', true);
          note('fo', '<b>Главный узел упал.</b> Реплика стала главной: у неё та же копия ключей, попадания не упали.', 'ok', 0);
          return;
        }
        const ni = N === 1 ? 0 : shard(HOT[0]), nd = S.nodes[ni], b = S.lay[ni];
        const lost = nd.slots.filter(c => c && c.dirty).length;
        nd.slots = nd.slots.map(() => null); nd.down = true; nd.upAt = S.t + DOWN;
        S.reqs.forEach(r => { if (r.cell && r.node === ni) r.cell = null; });
        pop(b.x + b.w / 2, b.y + b.h / 2, N === 1 ? 'кэш упал — память стёрта' : `узел ${ni + 1} упал`, 'bad');
        cap(N === 1 ? 'кэш упал: память стёрта, все чтения идут прямо в базу' : `упал узел ${ni + 1}: его ключи пропали, остальные узлы отвечают`, 'bad', true);
        note('crash', N === 1 ? '<b>Кэш упал.</b> Память стёрта, все чтения пошли прямо в базу.' : `<b>Упал узел ${ni + 1} из ${N}.</b> Его ключи пропали, остальные узлы работают.`, 'bad', 0);
        if (lost) { for (let i = 0; i < lost; i++) ev('lost', ''); S.lost = (S.lost || 0) + lost; note('lost', `<b>Потеряно ${lost} ${plural(lost, 'запись', 'записи', 'записей')}</b>: write-behind держал их только в кэше, в базу они не успели.`, 'bad', 0); }
        if (N >= 2) done('shard');
      }
      function syncDown() {   // узлы, которые лежат на площадке (хаос)
        if (S.scn === 'cold') return;
        const r = ctx.res || {}, N = S.nodes.length;
        const k = r.dead ? N : rep() ? 0 : clamp((r.count || 0) - (r.alive != null ? r.alive : r.count || 0), 0, N);
        S.nodes.forEach((nd, i) => {
          if (i >= N - k) { if (!nd.down) { nd.down = true; nd.upAt = Infinity; nd.slots = nd.slots.map(() => null); } }
          else if (nd.down && nd.upAt === Infinity) { nd.down = false; nd.cold = S.t; }
        });
      }
      function reset() {
        Object.assign(S, { t: 0, next: 150, reqs: [], ev: [], fx: [], dbA: [], db: {}, wv: {}, seq: 1, loading: {}, logT: {}, flags: {}, cfgT: 0, lastKey: HOT[0], lastRes: null,
          burstQ: 0, burstNext: 0, burstAt: 4500, burst: null, priceAt: 1600, flushAt: FLUSH, crashAt: 1400, fo: -1, lost: 0, cap: null, tr: [], lazy: [], sw: null, swAt: SWEEP, vt: 0, pv: {}, lastEv: null, dbE: 0, slow: 1, hh: 0.85, pHot: 0.9, nIn: 0, nWait: 0 });
        S.nodes = []; S.N = 0;
        rebuild(); syncDown(); prewarm();
        S.pHot = clamp(target() / 0.85, 0.3, 1);
        S.dbR = (1 - target()) * RATE; S.dbNew = 0; S.dbE = S.dbR * realRate() / RATE;
      }
      function cache() { S.pa = parent(); S.db0 = dbNode(); S.dbCap = S.db0 ? (resOf(S.db0.id).cap || 0) : 0; }

      /* ---------- счёт ---------- */
      function counts() {
        const c = { hit: 0, stale: 0, miss: 0, down: 0, evict: 0, exp: 0, lost: 0, del: 0 };
        S.ev.forEach(e => { if (c[e.k] != null) c[e.k]++; });
        const tot = c.hit + c.stale + c.miss + c.down;
        c.tot = tot; c.hr = tot ? (c.hit + c.stale) / tot : 0; c.sr = tot ? c.stale / tot : 0; c.mr = tot ? (c.miss + c.down) / tot : 0;
        c.dbMs = Math.round(20 * S.slow);
        c.avg = tot ? ((c.hit + c.stale) * 1 + (c.miss + c.down) * (c.dbMs + 1)) / tot : 0;
        return c;
      }

      /* ---------- отрисовка ---------- */
      function cellSvg(c, g, ni, hush) {
        const r6 = `x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="6"`;
        const two = g.h >= 36 && g.w >= 92, cx = (g.x + 9).toFixed(1), ky = (two ? g.y + g.h / 2 - 2 : g.y + g.h / 2 + 4).toFixed(1), my = (g.y + g.h / 2 + 12).toFixed(1);
        const kmax = Math.max(6, Math.floor((g.w - 30) / 6.6));
        if (!c) return `<rect class="xc-cell free" ${r6}/>` + (g.w >= 70 && !hush ? `<text class="xc-ck free" x="${(g.x + g.w / 2).toFixed(1)}" y="${(g.y + g.h / 2 + 4).toFixed(1)}" text-anchor="middle">свободно</text>` : '');
        if (c.inb && hush) return `<rect class="xc-cell load" ${r6}/>`;
        if (c.inb) return `<rect class="xc-cell load" ${r6}/><text class="xc-ck" x="${cx}" y="${ky}">${esc(cut(c.key, kmax))}</text>` + (two ? `<text class="xc-cm" x="${cx}" y="${my}">несут из базы…</text>` : '');
        const heat = c.h >= 8 ? 3 : c.h >= 3.5 ? 2 : c.h >= 1.5 ? 1 : 0;
        const stale = !c.dirty && c.ver < (S.db[c.key] || 0), ex = dead(c);
        const fl = S.t - c.fl < 420 ? ' fl-' + c.flk : '';
        let s = `<rect class="xc-cell p${heat}${stale ? ' stale' : ''}${c.dirty ? ' dirty' : ''}${c.delp ? ' delp' : ''}${ex ? ' expd' : ''}${fl}" ${r6}/>`;
        s += `<text class="xc-ck" x="${cx}" y="${ky}">${esc(cut(c.key, kmax))}</text>`;
        const f = c.dirty ? 1 : clamp((c.exp - S.t) / c.ttl, 0, 1), rx = (g.x + g.w - 13).toFixed(1), ry = (g.y + g.h / 2).toFixed(1);
        s += `<circle class="xc-ring${f < 0.25 ? ' low' : ''}${c.dirty ? ' hold' : ''}" cx="${rx}" cy="${ry}" r="7" stroke-dasharray="${(f * 43.98).toFixed(1)} 44" transform="rotate(-90 ${rx} ${ry})"/>`;
        if (two) {
          let m, mc = '';
          if (ex) { m = 'срок вышел'; mc = ' warn'; }
          else if (c.delp) { m = 'удаляется (DEL)…'; mc = ' acc'; }
          else if (stale) { m = c.key === HOT[0] ? `устарело: ${price(c.ver)} ₽` : 'устарело'; mc = ' bad'; }
          else if (c.dirty) { m = 'ещё не в базе'; mc = ' warn'; }
          else if (c.key === HOT[0] && S.scn === 'price') m = `цена ${price(c.ver)} ₽`;
          else m = lfu() ? `читают ≈${Math.round(c.h)}×` : `${sec(S.t - c.last)} назад`;
          s += `<text class="xc-cm${mc}" x="${cx}" y="${my}">${m}</text>`;
        }
        return s;
      }
      function nodeSvg(b, ni) {
        const nd = S.nodes[ni], used = nd.slots.filter(Boolean).length, per = nd.slots.length, p = P(), N = S.nodes.length;
        let s = '';
        for (let k = b.cpy / 5; k >= 1; k--) s += `<rect class="xc-copy" x="${(b.x + k * 5).toFixed(1)}" y="${(b.y + k * 5).toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="10"/>`;
        const fo = S.fo > S.t;
        s += `<g class="xr-part" data-xpart="hash"><rect class="xr-box${nd.down ? ' bad' : fo ? ' hot' : ''}" x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="10"/>`;
        const ttl = rep() && cnt() > 1 ? `главный + ${cnt() - 1} ${plural(cnt() - 1, 'копия', 'копии', 'копий')}` : N > 1 ? `узел ${ni + 1}` : 'узел кэша';
        const gb = S.scn === 'small' ? `${per} ${plural(per, 'ячейка', 'ячейки', 'ячеек')}` : `${p.mem} ГБ`;
        s += `<text class="xr-t xc-nh" x="${(b.x + 10).toFixed(1)}" y="${(b.y + 19).toFixed(1)}">${ttl}<tspan class="xc-dim"> · ${gb}</tspan></text>`;
        s += `<text class="xr-m ${nd.down ? 'bad' : used >= per ? 'warn' : ''}" x="${(b.x + b.w - 10).toFixed(1)}" y="${(b.y + 19).toFixed(1)}" text-anchor="end">${nd.down ? 'УПАЛ' : `занято ${used}/${per}`}</text>`;
        nd.slots.forEach((c, j) => { s += cellSvg(c, b.cells[j], ni, S.fx.some(f => f.ni === ni && f.j === j && f.k !== 'pop' && S.t - f.t0 < 650)); });
        for (let j = per; j < b.cells.length; j++) { const g = b.cells[j]; s += `<rect class="xc-cell none" x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="6"/>` + (g.w >= 70 ? `<text class="xc-ck free" x="${(g.x + g.w / 2).toFixed(1)}" y="${(g.y + g.h / 2 + 4).toFixed(1)}" text-anchor="middle">нет памяти</text>` : ''); }
        const mx = (b.x + b.w / 2).toFixed(1), my = b.y + b.h - 12;
        if (nd.down) s += `<text class="xr-pop bad" x="${mx}" y="${(b.y + b.h / 2).toFixed(1)}" text-anchor="middle">недоступен${nd.upAt !== Infinity ? ' · поднимется через ' + sec(nd.upAt - S.t) : ''}</text>`;
        else if (nd.cold && S.t - nd.cold < 5000) s += `<text class="xr-pop warn" x="${mx}" y="${my.toFixed(1)}" text-anchor="middle">память пустая — холодный старт</text>`;
        else if (fo && ni === 0) s += `<text class="xr-pop ok" x="${mx}" y="${my.toFixed(1)}" text-anchor="middle">главный упал — реплика заменила, ключи на месте</text>`;
        return s + '</g>';
      }
      function badges(c) {   // механизмы кэша — каждый открывается отдельно
        const p = P(), N = S.nodes.length, w = (DB.x + DB.w - Z.x - 4 * 8) / 5;   // ряд значков — от памяти до правого края базы
        const bs = [['evict', 'ВЫТЕСНЕНИЕ', `${lfu() ? 'LFU' : 'LRU'} · ${c.evict} за 10 с`, c.evict ? 'warn' : ''],
          ['ttl', 'TTL', `${TTLS[p.ttl] || '?'} · истекло ${c.exp}`, ''],
          ['write', 'ЗАПИСЬ', p.policy === 'behind' ? 'write-behind' : p.policy === 'through' ? 'write-through' : p.invalidate !== false ? 'cache-aside + DEL' : 'cache-aside, без DEL', p.policy === 'aside' && p.invalidate === false ? 'bad' : ''],
          ['stamp', 'НАБЕГ', p.stampede ? 'защита есть' : 'защиты нет', p.stampede ? 'ok' : ''],
          ['cluster', 'КЛАСТЕР', rep() && cnt() > 1 ? `1 + ${cnt() - 1} ${plural(cnt() - 1, 'копия', 'копии', 'копий')}` : `${N} × ${p.mem} ГБ`, '']];
        let s = `<text class="xr-s xc-go" x="16" y="20">Нажми на блок —</text><text class="xr-s xc-go" x="16" y="35">разберём, как он работает →</text>`;
        bs.forEach(([k, t, v, cl], i) => {
          const x = Z.x + i * (w + 8);
          s += `<g class="xr-part" data-xpart="${k}"><rect class="xc-badge" x="${x.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="34" rx="9"/><text class="xr-m" x="${(x + 10).toFixed(1)}" y="18">${t}</text><text class="xr-s ${cl ? 'xc-' + cl : ''}" x="${(x + 10).toFixed(1)}" y="32">${esc(v)}</text></g>`;
        });
        return s;
      }
      function draw() {
        if (!S.lay.length) return;
        index();
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        const p = P(), c = counts(), pa = S.pa, db = S.db0, N = S.nodes.length;
        let s = badges(c);
        /* зона памяти */
        const st = slotsTotal(), hotTxt = S.scn === 'small' ? `нарочно мало: ${st} ${plural(st, 'ячейка', 'ячейки', 'ячеек')} на ${HOT.length} ключей` : `${memGb()} ГБ на ${hotGb()} ГБ горячих данных → ${st} ${plural(st, 'ячейка', 'ячейки', 'ячеек')}`;
        s += `<rect class="xr-zone" x="${Z.x}" y="${Z.y}" width="${Z.w}" height="${Z.h}" rx="14"/>`;
        s += `<text class="xr-m acc" x="${Z.x + 12}" y="${Z.y + 21}">ПАМЯТЬ КЭША</text><text class="xr-s" x="${Z.x + 104}" y="${Z.y + 21}">${esc(hotTxt)}</text>`;
        const u = ctx.res.util || 0, uc = u > 1 ? 'bad' : u > 0.75 ? 'warn' : '';
        s += `<text class="xr-s" x="${ZX - 150}" y="${Z.y + 21}" text-anchor="end">загрузка</text><rect class="xr-bar" x="${ZX - 142}" y="${Z.y + 14}" width="80" height="8" rx="4"/><rect class="xr-bar-f ${uc}" x="${ZX - 142}" y="${Z.y + 14}" width="${(80 * clamp(u, 0, 1)).toFixed(1)}" height="8" rx="4"/>`;
        s += `<text class="xr-m ${uc}" x="${ZX - 12}" y="${Z.y + 21}" text-anchor="end">${pc(u)}</text>`;
        S.lay.forEach((b, ni) => { s += nodeSvg(b, ni); });
        const live = S.cap && S.t - S.cap.t < 2600;
        const hint = rep() && cnt() > 1 ? 'у главного узла и копий одни и те же ключи: память не складывается, зато копия подменит упавшего'
          : N > 1 ? `ключ ложится на узел по хешу: ${HOT.slice(0, 3).map(k => `${k} → ${shard(k) + 1}`).join(', ')}`
          : `в ячейке: ключ, кольцо TTL (сколько жить) и ${lfu() ? 'сколько раз читали — для LFU' : 'когда читали — для LRU'}`;
        s += `<text class="xr-s xc-cap ${live ? 'xc-' + S.cap.cls : ''}" x="${Z.x + 12}" y="${Z.y + Z.h - 9}">${esc(live ? S.cap.txt : hint)}</text>`;
        /* провода */
        s += `<line class="xr-wire" x1="${SV.x + SV.w}" y1="${YO}" x2="${Z.x}" y2="${YO}"/><line class="xr-wire dash" x1="${Z.x}" y1="${YB}" x2="${SV.x + SV.w}" y2="${YB}"/>`;
        s += `<text class="xr-s" x="${(SV.x + SV.w + Z.x) / 2}" y="${YO - 8}" text-anchor="middle">GET →</text><text class="xr-s" x="${(SV.x + SV.w + Z.x) / 2}" y="${YB + 15}" text-anchor="middle">← ответ</text>`;
        s += `<g class="xr-part" data-xpart="miss"><rect class="xc-pf" x="${ZX + 2}" y="${YO - 24}" width="${DB.x - ZX - 4}" height="${YB - YO + 46}" rx="8"/><line class="xr-wire" x1="${ZX}" y1="${YO}" x2="${DB.x}" y2="${YO}"/><line class="xr-wire dash" x1="${DB.x}" y1="${YB}" x2="${ZX}" y2="${YB}"/>`;
        s += `<text class="xr-s" x="${(ZX + DB.x) / 2}" y="${YO - 8}" text-anchor="middle">промах →</text><text class="xr-s" x="${(ZX + DB.x) / 2}" y="${YB + 15}" text-anchor="middle">← значение</text></g>`;
        const lane = p.policy === 'behind' ? 'write-behind: запись только в кэш, в базу — пачкой из кэша' : p.policy === 'through' ? 'write-through: запись идёт в базу и в кэш одновременно'
          : p.invalidate !== false ? 'запись: сервис → база, потом DEL ключа в кэше' : 'запись: сервис → база; ключ в кэше НЕ удаляется';
        s += `<polyline class="xr-wire dash${p.policy === 'behind' ? ' xc-off' : ''}" points="${LX1},${SV.y + SV.h} ${LX1},${LANE} ${LX2},${LANE} ${LX2},${DB.y + DB.h}"/>`;
        s += `<text class="xr-s xc-lbl ${p.policy === 'aside' && p.invalidate === false ? 'xc-bad' : ''}" x="500" y="${LANE + 4}" text-anchor="middle">${lane}</text>`;
        /* сервис */
        const pg = pa && ctx.canGo(pa.id);
        const lr = S.lastRes, lat = lr === 'hit' ? ['≈ 1 мс · из кэша', 'ok'] : lr === 'stale' ? ['1 мс, но старое!', 'bad'] : lr ? [`≈ ${c.dbMs} мс · из базы`, c.dbMs > 30 ? 'warn' : ''] : ['—', ''];
        s += `<g${pg ? ` class="xr-go" data-xgo="${pa.id}"` : ''}><rect class="xr-box" x="${SV.x}" y="${SV.y}" width="${SV.w}" height="${SV.h}" rx="12"/>`;
        s += `<text class="xr-t" x="${SV.x + 12}" y="${SV.y + 24}">${esc(cut(pa ? ctx.nm(pa.id) : 'Сервис', 17))}</text>`;
        s += `<text class="xr-s" x="${SV.x + 12}" y="${SV.y + 44}">спрашивает ключ:</text><text class="xr-m acc" x="${SV.x + 12}" y="${SV.y + 61}">${esc(cut(S.lastKey.startsWith('SET') ? S.lastKey : 'GET ' + S.lastKey, 20))}</text>`;
        s += `<text class="xr-s" x="${SV.x + 12}" y="${SV.y + 108}">последний ответ:</text><text class="xr-m ${lat[1]}" x="${SV.x + 12}" y="${SV.y + 125}">${lat[0]}</text>`;
        s += `<text class="xr-s" x="${SV.x + 12}" y="${SV.y + 146}">≈ ${fmt(realRate())} запросов/с</text>`;
        if (pg) s += `<text class="xr-s xc-go" x="${SV.x + 12}" y="${SV.y + 162}">клик — внутрь ›</text>`;
        s += '</g>';
        /* база */
        const dg = db && ctx.canGo(db.id), dr = db ? resOf(db.id) : {}, cap = S.dbCap, fr = cap ? S.dbE / cap : 0;
        const dbP = price(S.db[HOT[0]]), c42 = findC(shard(HOT[0]), HOT[0]);
        s += `<g${dg ? ` class="xr-go" data-xgo="${db.id}"` : ''}><rect class="xr-box${fr > 1 ? ' bad' : fr > 0.75 ? ' hot' : ''}" x="${DB.x}" y="${DB.y}" width="${DB.w}" height="${DB.h}" rx="12"/>`;
        s += `<text class="xr-t" x="${DB.x + 12}" y="${DB.y + 24}">${esc(cut(db ? ctx.nm(db.id) : 'База данных', 17))}</text>`;
        s += `<text class="xr-s" x="${DB.x + 12}" y="${DB.y + 43}">в базе product:42 =</text><text class="xr-m acc" x="${DB.x + 12}" y="${DB.y + 60}">${dbP} ₽${c42 && c42.dirty ? ' (в кэше новее)' : ''}</text>`;
        s += `<text class="xr-s" x="${DB.x + 12}" y="${DB.y + 146}">${S.nIn ? `ищет на диске: ${S.nIn}` : 'ждёт запросов'}${S.slow > 1.05 ? ' · тонет' : ''}</text>`;
        s += `<text class="xr-m ${dr.util > 1 ? 'bad' : dr.util > 0.75 ? 'warn' : ''}" x="${DB.x + 12}" y="${DB.y + 162}">${db ? `на площадке ${Math.round(Math.min(dr.util || 0, 9) * 100)} %` : 'нет на схеме'}</text>`;
        s += '</g>';
        /* низ: откуда ответы и нагрузка на базу */
        const W = 470, by = 448, sim = simHit();
        s += `<text class="xr-m" x="16" y="438">ОТКУДА ОТВЕТЫ · ЗА 10 С</text>`;
        s += `<rect class="xr-bar" x="16" y="${by}" width="${W}" height="14" rx="4"/>`;
        if (c.tot) {
          const a = W * (c.hr - c.sr), b2 = W * c.sr;
          s += `<rect class="xr-bar-f" x="16" y="${by}" width="${a.toFixed(1)}" height="14" rx="3"/><rect class="xc-seg-st" x="${(16 + a).toFixed(1)}" y="${by}" width="${b2.toFixed(1)}" height="14"/><rect class="xc-seg-db" x="${(16 + a + b2).toFixed(1)}" y="${by}" width="${(W - a - b2).toFixed(1)}" height="14" rx="3"/>`;
        }
        s += `<line class="xc-mark" x1="${(16 + W * sim).toFixed(1)}" y1="${by - 4}" x2="${(16 + W * sim).toFixed(1)}" y2="${by + 18}"/>`;
        s += `<text class="xr-s" x="16" y="482">из кэша <tspan class="xc-ok">${pc(c.hr - c.sr)}</tspan>${c.stale ? ` · старых <tspan class="xc-warn">${pc(c.sr)}</tspan>` : ''} · из базы <tspan class="xc-info">${pc(c.mr)}</tspan> · черта — на площадке ${pc(sim)}</text>`;
        const bx = 514, full = cap ? clamp(S.dbE / (cap * 1.25), 0, 1) : clamp(c.mr, 0, 1);
        s += `<text class="xr-m" x="${bx}" y="438">НАГРУЗКА НА БАЗУ · ЗАПРОСОВ/С</text>`;
        s += `<rect class="xr-bar" x="${bx}" y="${by}" width="${W}" height="14" rx="4"/><rect class="xr-bar-f ${fr > 1 ? 'bad' : fr > 0.75 ? 'warn' : ''}" x="${bx}" y="${by}" width="${(W * full).toFixed(1)}" height="14" rx="4"/>`;
        if (cap) s += `<line class="xc-mark" x1="${bx + W * 0.8}" y1="${by - 4}" x2="${bx + W * 0.8}" y2="${by + 18}"/>`;
        s += `<text class="xr-s" x="${bx}" y="482">≈ <tspan class="${fr > 1 ? 'xc-bad' : fr > 0.75 ? 'xc-warn' : 'xc-ok'}">${fmt(S.dbE)}</tspan> в секунду — промахи и записи${cap ? ` · черта — база тянет ≈ ${fmt(cap)}` : ''}</text>`;
        gSt.innerHTML = s;
        gDy.innerHTML = dyn();
      }
      function dyn() {
        let s = '';
        const rc = SD.kindColor('read'), wc = SD.kindColor('write');
        S.reqs.forEach(r => {
          const [x, y] = pos(r), xs = x.toFixed(1), ys = y.toFixed(1);
          if (r.k === 'read') {
            if (r.ph === 'back' || r.ph === 'ret') s += `<circle class="xr-dot ${r.res === 'stale' ? 'err' : 'ok'}" cx="${xs}" cy="${ys}" r="5.5"/>`;
            else { const w = r.ph === 'wait' || r.ph === 'cwait'; s += `<circle class="xr-dot${w ? ' xc-wait' : ''}" cx="${xs}" cy="${ys}" r="${w ? 4.5 : 5.5}" style="fill:${rc}"/>`; }
          } else if (r.k === 'del') s += `<circle class="xr-dot xc-del" cx="${xs}" cy="${ys}" r="5"/><text class="xr-pop" x="${xs}" y="${(y - 9).toFixed(1)}" text-anchor="middle">DEL</text>`;
          else if (r.k === 'flush') s += `<circle class="xr-dot" cx="${xs}" cy="${ys}" r="7.5" style="fill:${wc}"/><text class="xr-pop warn" x="${xs}" y="${(y - 11).toFixed(1)}" text-anchor="middle">пачка ×${r.items.length}</text>`;
          else s += `<circle class="xr-dot" cx="${xs}" cy="${ys}" r="6" style="fill:${wc}"/>` + (r.key === HOT[0] && r.ph === 'go' ? `<text class="xr-pop" x="${xs}" y="${(y - 10).toFixed(1)}" text-anchor="middle">${price(r.ver)} ₽</text>` : '');
        });
        if (S.nWait) s += `<text class="xr-pop warn" x="${Z.x + 17}" y="${YB + 19}" text-anchor="middle">ждут</text><text class="xr-pop warn" x="${Z.x + 17}" y="${YB + 46 + Math.ceil(Math.min(S.nWait, 14) / 2) * 12}" text-anchor="middle">×${S.nWait}</text>`;
        if (S.nIn > 28) s += `<text class="xr-pop bad" x="${DB.x + DB.w / 2}" y="274" text-anchor="middle">+${S.nIn - 28}</text>`;
        const gh = S.fx.filter(f => f.k !== 'pop').slice(-3), fx = S.fx.filter(f => f.k === 'pop').slice(-6).concat(gh);
        fx.forEach(f => {
          const k = clamp((S.t - f.t0) / FXT, 0, 1), o = (f.k === 'pop' ? 1 - k : 1 - k * k).toFixed(2);
          if (f.k === 'pop') { s += `<text class="xr-pop ${f.cls}" x="${f.x.toFixed(1)}" y="${(f.y - 14 * k).toFixed(1)}" text-anchor="middle" opacity="${o}">${esc(f.txt)}</text>`; return; }
          // старый ключ сжимается и улетает вверх, открывая ячейку под собой
          const m = Math.sqrt(k), sc = f.k === 'gone' ? 1 - 0.25 * m : 1 - 0.55 * m, cx = f.x + f.w / 2, cy = f.y + f.h / 2 - (f.k === 'gone' ? 0 : 16 * m), two = f.h >= 36;
          s += `<g opacity="${o}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)}) scale(${sc.toFixed(3)}) translate(${(-f.w / 2 - f.x).toFixed(1)},${(-f.h / 2 - f.y).toFixed(1)})"><rect class="xc-cell ${f.del ? 'delx' : f.k}" x="${f.x.toFixed(1)}" y="${f.y.toFixed(1)}" width="${f.w.toFixed(1)}" height="${f.h.toFixed(1)}" rx="6"/>`;
          s += `<text class="xc-ck" x="${(f.x + 9).toFixed(1)}" y="${(f.y + f.h / 2 + (two ? -2 : 4)).toFixed(1)}">${esc(cut(f.key, Math.max(6, Math.floor((f.w - 12) / 6.6))))}</text>`;
          s += `<text class="xc-cm ${f.cls || ''}" x="${(f.x + (two ? 9 : f.w - 8)).toFixed(1)}" y="${(f.y + (two ? f.h / 2 + 12 : f.h / 2 + 4)).toFixed(1)}"${two ? '' : ' text-anchor="end"'}>${esc(f.txt)}</text></g>`;
        });
        return s;
      }

      /* ---------- блоки изнутри: увеличенная живая схема одного механизма ---------- */
      const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
      const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="${rx == null ? 8 : rx}"/>`;
      const fmtN = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      function arrow(x1, y1, x2, y2, c) {
        const a = Math.atan2(y2 - y1, x2 - x1), L = 8, p = (k, d) => `${(x2 - L * Math.cos(a + d)).toFixed(1)},${(y2 - L * Math.sin(a + d)).toFixed(1)}`;
        if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
        return `<line class="xc-ar ${c || ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/><polygon class="xc-ah ${c || ''}" points="${x2.toFixed(1)},${y2.toFixed(1)} ${p(0, 0.45)} ${p(0, -0.45)}"/>`;
      }
      const head = (title, sub) => `<g class="xr-part" data-xpart=""><rect class="xc-pf xc-backb" x="12" y="10" width="112" height="26" rx="13"/><text class="xr-s xc-back" x="68" y="27" text-anchor="middle">← весь кэш</text></g>`
        + T(140, 27, title, 'xc-vt') + T(140, 46, sub, 'xr-s');
      const ring = (x, y, r, f, c) => `<circle class="xc-ring ${c || ''}" cx="${x}" cy="${y}" r="${r}" stroke-dasharray="${(f * 2 * Math.PI * r).toFixed(1)} ${(2 * Math.PI * r + 1).toFixed(1)}" transform="rotate(-90 ${x} ${y})"/>`;

      function vHash() {
        const tr = S.pv;
        if (!tr.k || S.vt - tr.t0 > 3200) {
          const t = S.tr.length ? S.tr[S.tr.length - 1] : { key: HOT[0], ni: shard(HOT[0]), found: true };
          tr.k = t.key; tr.ni = Math.min(t.ni, S.nodes.length - 1); tr.found = t.found; tr.t0 = S.vt; tr.b = hash(t.key) % 16;
          const nd = S.nodes[tr.ni];
          tr.chain = nd ? nd.slots.filter(c => c && hash(c.key) % 16 === tr.b).map(c => c.key) : [];
          if (tr.found && !tr.chain.includes(tr.k)) tr.chain.push(tr.k);
          if (!tr.found) tr.chain = tr.chain.filter(k => k !== tr.k);
        }
        const u = S.vt - tr.t0, nd = S.nodes[tr.ni] || { slots: [] }, keys = nd.slots.filter(Boolean).map(c => c.key), hv = hash(tr.k);
        let s = head('Хеш-таблица ключей', S.nodes.length > 1 ? `у каждого узла своя таблица — сейчас смотрим узел ${tr.ni + 1}` : 'как кэш находит ключ за один шаг, без перебора');
        s += R(30, 66, 200, 70, 'xr-box' + (u < 450 ? ' sel' : ''), 10) + T(44, 90, 'запрос от сервиса', 'xr-s') + T(44, 116, 'GET ' + esc(tr.k), 'xr-m acc');
        s += arrow(232, 101, 266, 101, u < 450 ? 'on' : '');
        s += R(270, 62, 330, 80, 'xr-box' + (u >= 450 && u < 1250 ? ' sel' : ''), 10) + T(284, 84, 'хеш-функция: строка → число', 'xr-s');
        s += T(284, 106, `hash("${esc(tr.k)}") = ${u >= 450 ? fmtN(hv) : '…'}`, 'xr-m');
        if (u >= 900) s += T(284, 128, `остаток от деления на 16 = ${tr.b} → корзина ${tr.b}`, 'xr-m acc');
        const lens = Array.from({ length: 16 }, (_, b) => keys.filter(k => hash(k) % 16 === b).length);
        s += R(632, 62, 338, 80, 'xc-note', 10) + T(646, 84, `ключей: ${keys.length} · корзин: 16 · заполнено на ${(keys.length / 16).toFixed(2).replace('.', ',')}`, 'xr-s')
          + T(646, 104, `самая длинная цепочка: ${Math.max(0, ...lens)}`, 'xr-s') + T(646, 124, 'ключей станет больше корзин — таблица удвоится', 'xr-s');
        const step = u < 1250 ? -1 : Math.floor((u - 1250) / 420), idx = tr.chain.indexOf(tr.k), need = tr.found ? idx + 1 : tr.chain.length;
        for (let b = 0; b < 16; b++) {
          const x = 30 + (b % 8) * 120, y = 186 + Math.floor(b / 8) * 148, on = b === tr.b && u >= 900;
          s += R(x, y, 112, 24, 'xc-bk' + (on ? ' on' : ''), 6) + T(x + 56, y + 16, `корзина ${b}`, 'xr-m', 'middle');
          const ks = on ? tr.chain : keys.filter(k => hash(k) % 16 === b);
          ks.slice(0, 3).forEach((k, i) => {
            let c = 'xc-ent';
            if (on && i < Math.min(step, need)) c += k === tr.k ? ' hit' : ' no';
            else if (on && i === step && i < need) c += ' cmp';
            s += R(x + 4, y + 30 + i * 30, 104, 26, c, 5) + T(x + 10, y + 47 + i * 30, esc(cut(k, 14)), 'xc-ck');
          });
          if (ks.length > 3) s += T(x + 56, y + 132, `+ ещё ${ks.length - 3}`, 'xr-s', 'middle');
          if (on && !ks.length) s += T(x + 56, y + 50, 'пусто', 'xr-s', 'middle');
        }
        if (u >= 900) s += arrow(435, 142, 30 + (tr.b % 8) * 120 + 56, 186 + Math.floor(tr.b / 8) * 148 - 3, 'on');
        if (u >= 1250 + need * 420) s += T(30, 482, tr.found ? `Нашли за ${need} ${plural(need, 'сравнение', 'сравнения', 'сравнений')} — значение уходит сервису (≈0,1 мс). Сколько бы ключей ни было, до корзины — один шаг.` : `В корзине ${tr.b} ключа нет — кэш отвечает (nil). Это промах: сервис пойдёт в базу и потом положит ключ сюда.`, 'xr-s ' + (tr.found ? 'xc-ok' : 'xc-bad'));
        return s;
      }

      function vEvict() {
        const L = lfu(), le = S.lastEv && S.t - S.lastEv.t < 9000 ? S.lastEv : null, ni = le ? Math.min(le.ni, S.nodes.length - 1) : 0;
        const nd = S.nodes[ni], per = nd.slots.length, used = nd.slots.filter(Boolean).length, pv = S.pv;
        const ord = nd.slots.filter(Boolean).sort((a, b) => L ? (b.h - a.h) || (b.last - a.last) : b.last - a.last);
        let s = head(L ? 'Вытеснение: LFU — выбрасываем то, что читают реже' : 'Вытеснение: LRU — выбрасываем то, что давно не читали', `память заполнена → новому ключу нужно место → кэш выбрасывает одного${S.nodes.length > 1 ? ` · узел ${ni + 1}` : ''}`);
        s += T(30, 80, `память узла (maxmemory): занято ${used} из ${per} ${plural(per, 'ячейки', 'ячеек', 'ячеек')}${used < per ? ' — пока есть место, никого не выбрасываем' : ' — полна'}`, 'xr-s');
        s += R(30, 88, 940, 10, 'xr-bar', 5) + R(30, 88, 940 * used / Math.max(1, per), 10, 'xr-bar-f' + (used >= per ? ' warn' : ''), 5);
        const vis = ord.length > 9 ? ord.slice(0, 3).concat([null], ord.slice(-6)) : ord.slice();
        const nv = Math.max(1, vis.length), W = Math.min(150, (940 - (nv - 1) * 10) / nv), gap = nv > 1 ? (940 - nv * W) / (nv - 1) : 0, x0 = 30;   // список растянут на всю ширину
        pv.px = pv.px || {};
        if (le && le.t !== pv.let) { pv.let = le.t; pv.evt = S.vt; pv.samp = [le.key].concat(ord.slice().sort(() => Math.random() - 0.5).slice(0, 4).map(c => c.key)); pv.gx = pv.px[le.key] != null ? pv.px[le.key] : 970 - W; }
        const fresh = pv.evt != null && S.vt - pv.evt < 1400;
        s += T(30, 134, L ? '← читают часто (счётчик большой)' : '← только что читали', 'xr-s') + T(970, 134, L ? 'читают редко — вылетит первым →' : 'давно не читали — вылетит первым →', 'xr-s xc-bad', 'end');
        const base = 330;
        vis.forEach((c, i) => {
          const tx = x0 + i * (W + gap);
          if (!c) { s += T(tx + W / 2, L ? base - 30 : 196, '…', 'xc-vt', 'middle'); return; }
          const x = pv.px[c.key] = pv.px[c.key] == null ? tx : pv.px[c.key] + (tx - pv.px[c.key]) * 0.18, last = i === vis.length - 1 && used >= per;
          const samp = fresh && pv.samp && pv.samp.includes(c.key) ? ' xc-smp' : '', kc = Math.max(5, Math.floor((W - 12) / 6.6));
          if (L) {
            const h = 18 + 150 * Math.min(1, c.h / 16);
            s += R(x, base - h, W, h, 'xc-bar' + (last ? ' cand' : '') + samp, 5) + T(x + W / 2, base - h - 6, `≈${Math.round(c.h)}`, 'xr-m', 'middle') + T(x + W / 2, base + 16, esc(cut(c.key, kc)), 'xc-ck', 'middle');
          } else {
            s += R(x, 146, W, 64, 'xc-ent' + (last ? ' cand' : '') + samp, 8) + T(x + 8, 170, esc(cut(c.key, kc)), 'xc-ck') + T(x + 8, 190, c.inb ? 'только что из базы' : `${sec(S.t - c.last)} назад`, 'xc-cm');
            s += R(x + 8, 198, (W - 16) * Math.min(1, (S.t - c.last) / 6000), 4, 'xc-age', 2);
          }
          if (last) s += T(x + W / 2, L ? base + 34 : 230, 'кандидат', 'xr-m bad', 'middle');
        });
        if (fresh && le) {
          const k = (S.vt - pv.evt) / 1400, gy = L ? base - 60 - 80 * Math.sqrt(k) : 146 + 90 * Math.sqrt(k);   // LRU — вниз, LFU — вверх: подальше от подписей
          s += `<g opacity="${(1 - k * k).toFixed(2)}">` + R(pv.gx, gy, W, L ? 40 : 64, 'xc-cell ghost', 8) + T(pv.gx + 8, gy + 22, esc(cut(le.key, Math.floor((W - 12) / 6.6))), 'xc-ck') + T(pv.gx + W, L ? gy - 6 : gy + 80, le.lfu ? `вытеснен: читали ≈${Math.max(1, Math.round(le.h))}× — меньше всех` : `вытеснен: не читали ${sec(le.age)} — дольше всех`, 'xr-pop bad', 'end') + '</g>';
          if (le.nk) s += T(30, L ? base + 60 : 330, `→ на его место пришёл ${esc(le.nk)}${L ? ': новый ключ начинает с маленьким счётчиком' : ': он встаёт в начало списка'}`, 'xr-s xc-acc');
        }
        s += T(30, 430, 'Как выбирает Redis: не сортирует все ключи, а берёт 5 случайных (пунктир при вытеснении) и выбрасывает худшего из них — почти так же точно, но дёшево.', 'xr-s');
        s += T(30, 452, L ? 'Счётчик LFU остывает: перестали читать ключ — примерно за 5 секунд его счётчик падает вдвое.' : 'Каждое чтение переносит ключ в начало списка, поэтому популярные ключи держатся, а редкие уезжают вправо.', 'xr-s');
        s += T(30, 474, le ? `Последнее вытеснение: ${esc(le.key)} — ${le.lfu ? `его читали реже всех (≈${Math.max(1, Math.round(le.h))}×)` : `его не читали дольше всех (${sec(le.age)})`}.` : 'Пока вытеснений нет: памяти хватает. Уменьши память или выбери «Мало памяти».', 'xr-s ' + (le ? 'xc-bad' : ''));
        return s;
      }

      function vTtl() {
        const p = P(), all = [], sw = S.sw && S.t - S.sw.t < 750 ? S.sw : null;
        S.nodes.forEach(nd => nd.slots.forEach(c => { if (c && !c.inb) all.push(c); }));
        all.sort((a, b) => (a.dirty ? 1e12 : a.exp) - (b.dirty ? 1e12 : b.exp));
        let s = head(`TTL: срок жизни ключа — ${TTLS[p.ttl] || '?'}`, `в этой модели время сжато: ${TTLS[p.ttl] || '?'} ≈ ${sec(TTLM[p.ttl] || 0)} · полоска — сколько ключу осталось жить`);
        all.slice(0, 12).forEach((c, i) => {
          const y = 86 + i * 28, f = c.dirty ? 1 : clamp((c.exp - S.t) / c.ttl, 0, 1), dd = dead(c);
          if (sw && sw.keys.includes(c.key)) s += R(24, y - 17, 770, 25, 'xc-samp', 6);
          s += T(32, y, esc(cut(c.key, 16)), 'xc-ck') + R(160, y - 10, 470, 12, 'xr-bar', 4) + R(160, y - 10, 470 * f, 12, 'xr-bar-f' + (c.dirty ? ' warn' : f < 0.25 ? ' bad' : ''), 4);
          s += T(642, y, dd ? 'срок вышел — ждёт удаления' : c.dirty ? 'держится: не записан в базу' : `осталось ${sec(c.exp - S.t)}`, 'xr-s ' + (dd ? 'xc-warn' : ''));
        });
        if (!all.length) s += T(32, 100, 'Кэш пуст — сроков нет.', 'xr-s');
        if (all.length > 12) s += T(32, 428, `и ещё ${all.length - 12} ${plural(all.length - 12, 'ключ', 'ключа', 'ключей')} с большим запасом`, 'xr-s');
        const lz = S.lazy.filter(t => t > S.t - 10000).length, lf = S.lazy.length && S.t - S.lazy[S.lazy.length - 1] < 600;
        s += R(806, 66, 170, 118, 'xc-note' + (lf ? ' on' : ''), 10) + T(818, 88, 'Лениво — при чтении', 'xr-t xc-nh') + T(818, 108, 'читают истёкший ключ —', 'xr-s') + T(818, 124, 'удаляем сразу и', 'xr-s') + T(818, 140, 'отвечаем «нет» (nil)', 'xr-s') + T(818, 168, `за 10 с: ${lz}`, 'xr-m acc');
        const fs = clamp(1 - (S.swAt - S.t) / SWEEP, 0, 1);
        s += R(806, 196, 170, 166, 'xc-note' + (sw ? ' on' : ''), 10) + T(818, 218, 'Фоновая чистка', 'xr-t xc-nh') + ring(952, 214, 9, fs, 'ok') + T(818, 240, 'раз в 1 с (Redis: 10 раз/с)', 'xr-s') + T(818, 256, 'берёт 5 случайных ключей', 'xr-s') + T(818, 272, '(Redis: 20)', 'xr-s') + T(818, 288, 'истёкших больше 25 % —', 'xr-s') + T(818, 304, 'сразу ещё круг', 'xr-s');
        s += T(818, 340, S.sw ? `проверила ${S.sw.keys.length}, удалила ${S.sw.gone}` : 'ещё не запускалась', 'xr-m acc');
        s += R(806, 374, 170, 72, 'xc-note', 10) + T(818, 396, 'Разброс TTL', 'xr-t xc-nh') + T(818, 416, '±10 % случайно: ключи', 'xr-s') + T(818, 432, 'не истекают разом', 'xr-s');
        s += T(30, 476, `Короткий TTL — свежее, но больше промахов. Длинный — больше попаданий, но старое живёт дольше${p.invalidate === false ? ' (а ключ при записи не удаляется!)' : ''}.`, 'xr-s');
        return s;
      }

      function seq(cols, steps) {   // диаграмма последовательности: шаги появляются по очереди и повторяются
        const ST = 950, n = steps.length, cyc = n * ST + 2400, u = S.vt % cyc, cur = Math.floor(u / ST), f = (u % ST) / ST, dy = n > 9 ? 31 : 35, y0 = 150;
        let s = '';
        cols.forEach(c => { s += R(c.x - 110, 62, 220, 52, 'xr-box', 10) + T(c.x, 82, esc(c.name), 'xr-t', 'middle') + T(c.x, 102, esc(c.val || ''), 'xr-m ' + (c.cls || ''), 'middle') + `<line class="xc-life" x1="${c.x}" y1="114" x2="${c.x}" y2="${y0 + (n - 1) * dy + 14}"/>`; });
        steps.forEach((st, i) => {
          const y = y0 + i * dy, state = i < cur ? 'past' : i === cur ? 'now' : 'fut', xa = cols[st.a].x, bs = Array.isArray(st.b) ? st.b : [st.b];
          if (bs[0] === st.a) { s += R(xa - 150, y - 16, 300, 24, `xc-nt ${st.c || ''} ${state}`, 6) + T(xa, y, st.t, `xr-s xc-sl ${state}`, 'middle'); return; }
          let xm = xa;
          bs.forEach(b => {
            const xb = cols[b].x, k = state === 'now' ? Math.min(1, f * 1.4) : 1, xe = xa + (xb - xa) * k;
            s += arrow(xa, y, xe, y, `${st.c || ''} ${state}`);
            if (state === 'now' && k < 1) s += `<circle class="xr-dot" cx="${xe.toFixed(1)}" cy="${y}" r="5.5" style="fill:${SD.kindColor(st.k || 'read')}"/>`;
            if (Math.abs(xb - xa) > Math.abs(xm - xa)) xm = xb;
          });
          s += T((xa + xm) / 2, y - 7, st.t, `xr-s xc-sl ${st.c ? 'xc-' + st.c : ''} ${state}`, 'middle');
        });
        return s;
      }
      function vWrite() {
        const p = P(), k42 = HOT[0], c42 = findC(shard(k42), k42), dbv = S.db[k42] || 0;
        const cv = c42 ? `${price(c42.ver)} ₽${dead(c42) ? ' · истёк' : c42.dirty ? ' · ещё не в базе' : c42.ver < dbv ? ' · устарело' : ''}` : 'ключа нет';
        const cols = [{ x: 170, name: S.pa ? cut(ctx.nm(S.pa.id), 18) : 'Сервис', val: 'меняет цену product:42' },
          { x: 500, name: 'Кэш', val: 'сейчас: ' + cv, cls: c42 && !c42.dirty && c42.ver < dbv ? 'bad' : c42 && c42.dirty ? 'warn' : 'acc' },
          { x: 830, name: 'База', val: `сейчас: ${price(dbv)} ₽`, cls: 'acc' }];
        let title, sub, st;
        if (p.policy === 'behind') {
          title = 'Write-behind: пишем в кэш, в базу — потом пачкой'; sub = 'быстро, но изменения живут только в памяти кэша, пока не ушла пачка';
          st = [{ a: 0, b: 1, t: 'SET product:42 = 90 ₽', c: 'acc', k: 'write' }, { a: 1, b: 0, t: 'OK — сразу, база ещё не знает', c: 'ok' }, { a: 1, b: 1, t: 'ключ «грязный»: в кэше 90 ₽, в базе 100 ₽', c: 'warn' },
            { a: 0, b: 1, t: 'ещё записи — копятся в кэше', k: 'write' }, { a: 1, b: 2, t: 'пачка: UPDATE ×3 (раз в 3 с)', c: 'acc', k: 'write' }, { a: 2, b: 1, t: 'OK — записи больше не «грязные»', c: 'ok' }, { a: 1, b: 1, t: 'упади кэш до пачки — записи потеряны', c: 'bad' }];
        } else if (p.policy === 'through') {
          title = 'Write-through: пишем в кэш и в базу сразу'; sub = 'кэш всегда свежий; запись ждёт обоих, поэтому чуть медленнее';
          st = [{ a: 0, b: [1, 2], t: 'SET 90 ₽ в кэш и UPDATE 90 ₽ в базу — одновременно', c: 'acc', k: 'write' }, { a: 1, b: 0, t: 'OK от кэша', c: 'ok' }, { a: 2, b: 0, t: 'OK от базы', c: 'ok' },
            { a: 0, b: 0, t: 'отвечаем пользователю, когда оба OK' }, { a: 0, b: 1, t: 'GET product:42 — следующий читатель' }, { a: 1, b: 0, t: '90 ₽ — свежая цена, попадание', c: 'ok' }];
        } else if (p.invalidate === false) {
          title = 'Cache-aside без удаления ключа'; sub = `база обновилась, а копия в кэше — нет: старое живёт до конца TTL (${TTLS[p.ttl] || ''})`;
          st = [{ a: 0, b: 2, t: 'UPDATE products SET price = 90', k: 'write' }, { a: 2, b: 0, t: 'OK', c: 'ok' }, { a: 0, b: 0, t: 'ключ в кэше не трогаем', c: 'bad' }, { a: 0, b: 1, t: 'GET product:42' },
            { a: 1, b: 0, t: '100 ₽ — СТАРАЯ цена!', c: 'bad' }, { a: 0, b: 0, t: `и так до конца TTL — до ${TTLD[p.ttl] || '10 минут'}` }, { a: 0, b: 1, t: 'GET — срок вышел' }, { a: 1, b: 0, t: '(nil) — промах', c: 'warn' },
            { a: 0, b: 2, t: 'SELECT … WHERE id = 42' }, { a: 2, b: 0, t: '90 ₽ — наконец свежая', c: 'ok' }];
        } else {
          title = 'Cache-aside: пишем в базу, ключ в кэше удаляем'; sub = 'старую копию выбросили — следующий читатель возьмёт свежее из базы';
          st = [{ a: 0, b: 2, t: 'UPDATE products SET price = 90', k: 'write' }, { a: 2, b: 0, t: 'OK', c: 'ok' }, { a: 0, b: 1, t: 'DEL product:42', c: 'acc' }, { a: 1, b: 0, t: 'удалён', c: 'acc' },
            { a: 0, b: 1, t: 'GET product:42 — следующий читатель' }, { a: 1, b: 0, t: '(nil) — промах', c: 'warn' }, { a: 0, b: 2, t: 'SELECT … WHERE id = 42' }, { a: 2, b: 0, t: '90 ₽', c: 'ok' },
            { a: 0, b: 1, t: 'SET product:42 = 90 ₽ EX 600', c: 'acc' }];
        }
        return head(title, sub) + seq(cols, st) + T(30, 488, 'В примере цена меняется со 100 ₽ на 90 ₽. Строка под заголовками — что лежит в кэше и в базе в модели прямо сейчас.', 'xr-s');
      }
      function vMiss() {
        const c = counts(), fr = S.dbCap ? S.dbE / S.dbCap : 0;
        const cols = [{ x: 170, name: S.pa ? cut(ctx.nm(S.pa.id), 18) : 'Сервис', val: 'читает товары' }, { x: 500, name: 'Кэш', val: `из кэша ${pc(c.hr)}`, cls: 'ok' }, { x: 830, name: S.db0 ? cut(ctx.nm(S.db0.id), 18) : 'База', val: `≈ ${c.dbMs} мс на запрос`, cls: c.dbMs > 30 ? 'warn' : '' }];
        const st = [{ a: 0, b: 1, t: 'GET product:42' }, { a: 1, b: 0, t: '90 ₽ — попадание, ≈1 мс', c: 'ok' }, { a: 0, b: 0, t: 'другой ключ — его в кэше нет' }, { a: 0, b: 1, t: 'GET product:7' },
          { a: 1, b: 0, t: '(nil) — промах', c: 'warn' }, { a: 0, b: 2, t: `SELECT … WHERE id = 7 — ≈${c.dbMs} мс`, c: 'acc' }, { a: 2, b: 0, t: 'строка товара' }, { a: 0, b: 1, t: 'SET product:7 … EX 600 — на будущее', c: 'acc' },
          { a: 0, b: 0, t: `ответ пользователю: ≈${c.dbMs + 2} мс вместо 1` }];
        let s = head('Промах: путь в базу (cache-aside)', 'кэш ничего не знает о базе: при промахе сервис сам идёт в базу и кладёт ответ в кэш') + seq(cols, st);
        s += T(30, 470, `Сейчас промахов ${pc(c.mr)} → в базу ≈ ${fmt(S.dbE)} запросов/с${S.dbCap ? `, а она тянет ≈ ${fmt(S.dbCap)}` : ''}.`, 'xr-s ' + (fr > 1 ? 'xc-bad' : ''));
        s += T(30, 488, 'Каждый лишний процент промахов — это сотни запросов в секунду к базе.', 'xr-s');
        s += R(640, 459, 10, 10, 'xr-bar-f', 3) + T(656, 468, 'попадание ≈ 1 мс', 'xr-s') + R(780, 459, Math.min(190, 6 * (c.dbMs + 2)), 10, 'xc-seg-db', 3) + T(780, 486, `промах ≈ ${c.dbMs + 2} мс`, 'xr-s');
        return s;
      }

      function vStamp() {
        const p = P(), on = !!p.stampede, CY = 6400, u = S.vt % CY, M = 10, KX = 390, KY = 150, DX = 770;
        let s = head('Набег на базу (stampede) и защита', on ? 'защита включена: одна загрузка с замком — в базу идёт один запрос' : 'защиты нет: каждый промах идёт в базу сам');
        const exp = u >= 1600, set = u >= 3300, f = clamp(1 - u / 1600, 0, 1);
        s += R(KX, KY, 230, 130, 'xr-box', 12) + T(KX + 12, KY + 22, 'Кэш', 'xr-t');
        s += R(KX + 16, KY + 34, 198, 48, 'xc-cell ' + (set ? 'p3 fl-set' : exp ? 'expd' : 'p3'), 8) + T(KX + 28, KY + 56, 'product:42', 'xc-ck') + T(KX + 28, KY + 72, set ? 'снова в кэше' : exp ? 'TTL кончился — ключа нет' : 'популярный ключ · TTL тает', 'xc-cm' + (exp && !set ? ' warn' : '')) + (exp ? '' : ring(KX + 196, KY + 58, 9, f, f < 0.3 ? 'low' : ''));
        const spike = !on && u >= 2400 && u < 3700;
        s += R(DX, KY, 200, 130, 'xr-box' + (spike ? ' bad' : ''), 12) + T(DX + 12, KY + 22, 'База', 'xr-t');
        const inDb = !on ? (u >= 2400 && u < 3300 ? M : 0) : (u >= 2400 && u < 2900 ? 1 : 0);
        s += T(DX + 12, KY + 112, inDb ? `одинаковых SELECT: ${inDb}` : 'ждёт запросов', 'xr-m ' + (spike ? 'bad' : ''));
        if (spike) s += T(DX + 100, KY - 10, `×${M} разом — в жизни ×500`, 'xr-pop bad', 'middle');
        if (on && u >= 2100 && u < 3300) s += R(KX + 30, KY - 34, 170, 24, 'xc-lock', 12) + T(KX + 115, KY - 18, 'замок: SET lock NX', 'xr-m acc', 'middle');
        const door = [KX, KY + 100], dbp = i => [DX + 24 + (i % 5) * 30, KY + 50 + Math.floor(i / 5) * 26];
        const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        for (let i = 0; i < M; i++) {
          const home = [60 + (i % 2) * 26, 110 + Math.floor(i / 2) * 32], wait = [KX + 20 + (i - 1) * 21, KY + 116];
          let q = home, cls = '', col = SD.kindColor('read');
          if (u >= 1600 && u < 2100) q = lerp(home, door, (u - 1600) / 500);
          else if (u >= 2100) {
            if (!on || i === 0) {
              if (u < 2400) q = lerp(door, dbp(i), (u - 2100) / 300);
              else if (u < (on ? 2900 : 3300)) q = dbp(i);
              else if (u < (on ? 3300 : 3700)) q = lerp(dbp(i), [KX + 115, KY + 58], (u - (on ? 2900 : 3300)) / 400);
              else if (u < 4400) { q = lerp([KX + 115, KY + 58], home, (u - 3700) / 700); cls = 'ok'; }
              else { q = home; cls = 'ok'; }
            } else {
              if (u < 2400) q = lerp(door, wait, (u - 2100) / 300);
              else if (u < 3300) { q = wait; cls = 'xc-wait'; }
              else if (u < 4100) { q = lerp(wait, home, (u - 3300) / 800); cls = 'ok'; }
              else { q = home; cls = 'ok'; }
            }
          }
          s += `<circle class="xr-dot ${cls}" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="6"${cls === 'ok' ? '' : ` style="fill:${col}"`}/>`;
        }
        s += T(30, 96, u < 1600 ? 'запросы читают ключ — пока он жив, всё из кэша' : u < 2100 ? 'ключ истёк — толпа приходит одновременно' : u < 3300 ? (on ? 'один пошёл в базу с замком, остальные ждут' : 'все пошли в базу за одним и тем же') : 'ответ получен — ключ снова в кэше', 'xr-s' + (u >= 1600 && u < 3300 ? ' xc-warn' : ''));
        if (on && u >= 2400 && u < 3300) s += T(KX + 115, KY + 146, `${M - 1} ждут ответ первого`, 'xr-s xc-warn', 'middle');
        const cards = [['Одна загрузка с замком', on ? 'включено' : 'выключено', ['первый промах ставит замок и идёт', 'в базу, остальные ждут его ответ:', 'в базу один запрос вместо толпы']],
          ['Ранний перезапрос', 'идея', ['когда до конца TTL осталось ~10 %,', 'один запрос обновляет ключ заранее,', 'остальные пока читают старое']],
          ['Разброс TTL', 'идея', ['к TTL добавляют ±10 % случайно —', 'популярные ключи не истекают', 'в одну и ту же секунду']]];
        cards.forEach(([t, st2, lines], i) => {
          const x = 30 + i * 320;
          s += R(x, 318, 300, 124, 'xc-note' + (i === 0 && on ? ' on' : ''), 10) + T(x + 14, 342, t, 'xr-t xc-nh') + T(x + 286, 342, st2, 'xr-m ' + (i === 0 ? (on ? 'ok' : 'bad') : ''), 'end');
          lines.forEach((l, j) => { s += T(x + 14, 366 + j * 20, l, 'xr-s'); });
        });
        const b = S.burst;
        s += T(30, 476, b ? `В модели последний набег: ${b.n} ${plural(b.n, 'запрос', 'запроса', 'запросов')} ушли в базу, ${b.w} ждали ответ первого.` : 'Чтобы увидеть набег на общей картинке, выбери ситуацию «Популярный ключ истёк».', 'xr-s');
        return s;
      }

      function vCluster() {
        const N = S.nodes.length, rp = rep() && cnt() > 1, tr = S.pv;
        if (!tr.k || S.vt - tr.t0 > 2400) {
          const rec = S.tr.slice(-6).map(t => t.key).filter(k => k !== tr.k);
          tr.k = rec.length ? rec[rec.length - 1] : HOT[(tr.i = ((tr.i || 0) + 1) % HOT.length)];
          tr.t0 = S.vt;
        }
        const u = S.vt - tr.t0, cr = crc16(tr.k), sl = slotOf(tr.k), ni = shard(tr.k), BX = 40, BW = 920, BY = 166;
        let s = head('Кластер: 16 384 слота', rp ? `главный узел и ${cnt() - 1} ${plural(cnt() - 1, 'копия', 'копии', 'копий')}: у всех одни и те же ключи, слоты не делятся` : N > 1 ? `${N} ${plural(N, 'узел', 'узла', 'узлов')} делят слоты поровну — каждый ключ живёт ровно на одном узле` : 'один узел держит все слоты — упал он, упал весь кэш');
        const box = (x, w, t1, t2, on, show) => R(x, 62, w, 54, 'xr-box' + (on ? ' sel' : ''), 10) + T(x + 12, 82, t1, 'xr-s') + T(x + 12, 104, show ? t2 : '…', 'xr-m acc');
        s += box(30, 180, 'ключ', esc(tr.k), u < 400, true) + arrow(212, 89, 236, 89, u < 400 ? 'on' : '');
        s += box(240, 210, 'CRC16(ключ) — число', fmtN(cr), u >= 400 && u < 800, u >= 400) + arrow(452, 89, 476, 89, '');
        s += box(480, 230, 'остаток от деления на 16 384', `слот ${fmtN(sl)}`, u >= 800 && u < 1200, u >= 800) + arrow(712, 89, 736, 89, '');
        s += box(740, 230, rp ? 'кто отвечает' : 'кто держит этот слот', rp ? 'любой узел — копии' : `узел ${ni + 1}`, u >= 1200, u >= 1200);
        const rg = rp ? [[0, 16383]] : Array.from({ length: N }, (_, i) => [Math.floor(i * 16384 / N), Math.floor((i + 1) * 16384 / N) - 1]);
        rg.forEach(([a, b], i) => {
          const x = BX + BW * a / 16384, w = BW * (b - a + 1) / 16384, dn = !rp && S.nodes[i] && S.nodes[i].down;
          s += R(x, BY, w, 26, `xc-rg r${i % 2}${!rp && i === ni && u >= 1200 ? ' on' : ''}${dn ? ' dead' : ''}`, 0) + T(x + w / 2, BY + 44, rp ? 'все 16 384 слота — у главного и у каждой копии' : `узел ${i + 1}: ${fmtN(a)}–${fmtN(b)}`, 'xr-m' + (dn ? ' bad' : ''), 'middle');
        });
        s += T(BX, BY - 8, '0', 'xr-m') + T(BX + BW, BY - 8, '16 383', 'xr-m', 'end');
        const mx0 = BX + BW * sl / 16384; tr.mx = tr.mx == null ? mx0 : tr.mx + (mx0 - tr.mx) * 0.2;
        if (u >= 800) s += `<line class="xc-mk" x1="${tr.mx.toFixed(1)}" y1="${BY - 4}" x2="${tr.mx.toFixed(1)}" y2="${BY + 30}"/><polygon class="xc-mkh" points="${(tr.mx - 7).toFixed(1)},${BY - 14} ${(tr.mx + 7).toFixed(1)},${BY - 14} ${tr.mx.toFixed(1)},${BY - 3}"/>` + T(tr.mx, BY - 18, fmtN(sl), 'xr-m acc', 'middle');
        const M = rp ? cnt() : N, gw = (920 - (M - 1) * 12) / M, NY = 236;
        for (let i = 0; i < M; i++) {
          const x = 40 + i * (gw + 12), nd = rp ? S.nodes[0] : S.nodes[i], dn = !rp ? nd.down : i === 0 && S.fo > S.t;
          const on = u >= 1200 && (rp || i === ni);
          s += R(x, NY, gw, 196, 'xr-box' + (dn ? ' bad' : on ? ' sel' : ''), 10) + T(x + 12, NY + 22, rp ? (i === 0 ? 'главный' : `копия ${i}`) : `узел ${i + 1}`, 'xr-t xc-nh') + T(x + gw - 10, NY + 22, dn ? 'упал' : `${nd.slots.filter(Boolean).length} ${plural(nd.slots.filter(Boolean).length, 'ключ', 'ключа', 'ключей')}`, 'xr-m' + (dn ? ' bad' : ''), 'end');
          const ks = dn && !rp ? [] : nd.slots.filter(Boolean).map(c => c.key), kc = Math.max(1, Math.floor((gw - 16) / 122)), cap2 = kc * 7;
          ks.slice(0, cap2).forEach((k, j) => { s += T(x + 12 + Math.floor(j / 7) * 122, NY + 46 + (j % 7) * 20, esc(cut(k, Math.min(16, Math.floor((gw - 20) / 6.6)))), 'xc-ck' + (k === tr.k && on ? ' xc-acc' : '')); });
          if (ks.length > cap2) s += T(x + 12, NY + 188, `+ ещё ${ks.length - cap2}`, 'xr-s');
          if (rp && i > 0) s += arrow(40 + gw * 0.5 + (i - 1) * (gw + 12) + gw * 0.5 + 6, NY + 100, x - 2, NY + 100, 'acc');
        }
        if (rp) s += T(40 + gw + 6, NY - 6, 'главный копирует каждую запись в копии', 'xr-s xc-acc', 'middle');
        s += T(30, 458, 'Хештег: у ключей {user:42}:cart и {user:42}:profile слот считается только по части в скобках — они лягут на один узел.', 'xr-s');
        s += T(30, 478, 'Добавили узел — часть слотов вместе с ключами переезжает к нему. Клиент, пришедший не туда, получает ответ MOVED и обновляет карту.', 'xr-s');
        return s;
      }
      const VIEWS = { hash: vHash, evict: vEvict, ttl: vTtl, write: vWrite, stamp: vStamp, cluster: vCluster, miss: vMiss };
      function partNow(k) {
        const p = P(), c = counts();
        if (k === 'hash') { const t = S.pv; return t.k ? `<b>${esc(t.k)}</b> → хеш ${fmtN(hash(t.k))} → корзина ${t.b}. ${t.found ? 'Ключ нашёлся в цепочке — попадание.' : 'В корзине его нет — промах, сервис пойдёт в базу.'} Поиск не зависит от числа ключей: один шаг до корзины и 1–2 сравнения в ней.` : 'Ждём запрос…'; }
        if (k === 'evict') {
          const le = S.lastEv && S.t - S.lastEv.t < 9000 ? S.lastEv : null, nd = S.nodes[le ? Math.min(le.ni, S.nodes.length - 1) : 0], L = lfu(), ord = nd.slots.filter(Boolean).sort((a, b) => L ? (b.h - a.h) : b.last - a.last), cd = ord[ord.length - 1], full = nd.slots.every(Boolean);
          if (!full || !cd) return `<b>Память ещё не заполнена</b> (${nd.slots.filter(Boolean).length} из ${nd.slots.length}): новые ключи ложатся в свободные ячейки, вытеснять некого. Уменьши память или выбери «Мало памяти».`;
          return L ? `<b>Следующий на выброс — ${esc(cd.key)}</b>: его счётчик самый маленький (≈${Math.round(cd.h)}). Ключи, которые читают часто, держат высокий счётчик и остаются. Вытеснено за 10 с: ${c.evict}.` : `<b>Следующий на выброс — ${esc(cd.key)}</b>: его не читали ${sec(S.t - cd.last)}, дольше всех. Каждое чтение переносит ключ в начало списка. Вытеснено за 10 с: ${c.evict}.`;
        }
        if (k === 'ttl') {
          const all = []; S.nodes.forEach(nd => nd.slots.forEach(x => { if (x && !x.inb && !x.dirty) all.push(x); })); all.sort((a, b) => a.exp - b.exp);
          const f = all[0], lz = S.lazy.filter(t => t > S.t - 10000).length;
          return (f ? `<b>Ближе всех к концу — ${esc(f.key)}</b>: ${dead(f) ? 'срок уже вышел, ключ ждёт удаления' : `осталось ${sec(f.exp - S.t)}`}. ` : '') + `Фоновая чистка ${S.sw ? `последний раз проверила ${S.sw.keys.length} ${plural(S.sw.keys.length, 'ключ', 'ключа', 'ключей')} и удалила ${S.sw.gone}` : 'ещё не запускалась'}. Удалений при чтении за 10 с: ${lz}.`;
        }
        if (k === 'write') return p.policy === 'behind' ? '<b>Write-behind.</b> Запись сразу ложится в кэш, ответ мгновенный. В базу изменения уходят пачкой раз в 3 с — до этого они есть только в памяти кэша.' : p.policy === 'through' ? '<b>Write-through.</b> Запись идёт в кэш и в базу одновременно, ответ — когда оба подтвердили. Устаревших данных в кэше не бывает.' : p.invalidate === false ? `<b>Ключ при записи не удаляется.</b> База уже с новой ценой, а кэш отдаёт старую, пока не кончится TTL (${TTLS[p.ttl] || ''}). Старых ответов за 10 с: ${c.stale}.` : '<b>Cache-aside с удалением.</b> Сначала запись в базу, потом DEL ключа. Следующий читатель промахнётся и возьмёт свежую цену из базы.';
        if (k === 'stamp') { const b = S.burst; return (p.stampede ? '<b>Защита включена.</b> На промах по ключу в базу идёт один запрос с замком, остальные ждут его ответ. ' : '<b>Защиты нет.</b> Каждый промах идёт в базу сам: истёк популярный ключ — в базу летит толпа одинаковых запросов. ') + (b ? `Последний набег в модели: в базу ${b.n}, ждали ${b.w}.` : ''); }
        if (k === 'cluster') { const t = S.pv; if (!t.k) return 'Ждём ключ…'; const N = S.nodes.length, ni = shard(t.k), a = Math.floor(ni * 16384 / N), b2 = Math.floor((ni + 1) * 16384 / N) - 1; return rep() && cnt() > 1 ? `<b>${esc(t.k)}</b> → слот ${fmtN(slotOf(t.k))}. Но в режиме реплик слоты не делятся: этот ключ есть на главном и на всех ${cnt() - 1} копиях.` : `<b>${esc(t.k)}</b> → CRC16 = ${fmtN(crc16(t.k))} → слот ${fmtN(slotOf(t.k))} → узел ${ni + 1} (держит слоты ${fmtN(a)}–${fmtN(b2)}).${N === 1 ? ' Узел один — у него все слоты.' : ''}`; }
        if (k === 'miss') return `<b>Сейчас промахов ${pc(c.mr)}.</b> Каждый промах — поход в базу примерно за ${c.dbMs} мс вместо 1 мс. До базы доходит ≈ ${fmt(S.dbE)} запросов в секунду${S.dbCap ? `, а она тянет ≈ ${fmt(S.dbCap)}` : ''}${S.dbCap && S.dbE > S.dbCap ? ' — перегрузка' : ''}.`;
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.lay.length) return;
        const end = S.t + dt, p = P();
        S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) {
          S.vt += dt;
          if (pk === 'evict' && S.lastEv && S.lastEv.t > S.pvT0) done('pevict');
          if (pk === 'cluster' && !rep() && nN() >= 3) done('pcluster');
        }
        while (S.next <= end) {
          S.t = S.next;
          if (S.reqs.length < 60) {
            const w = S.scn === 'stamp' || S.scn === 'price' ? 0 : wShare();
            if (Math.random() < w) spawnWrite(pickHot(0)); else spawnRead(pickKey(), false);
          }
          S.next += 1000 / RATE * (0.4 + Math.random() * 1.2);
        }
        S.t = end;
        if (S.scn === 'stamp') {
          if (S.t >= S.burstAt) startBurst();
          while (S.burstQ > 0 && S.t >= S.burstNext) { spawnRead(HOT[0], true); S.burstQ--; S.burstNext += 22; }
        }
        if (S.scn === 'price' && S.t >= S.priceAt) { spawnWrite(HOT[0]); S.priceAt = S.t + PRICE_T; }
        if (S.scn === 'cold' && S.t >= S.crashAt) { crash(); S.crashAt = S.t + CYCLE; }
        syncDown();
        S.nodes.forEach((nd, i) => {
          if (nd.down && nd.upAt <= S.t) { nd.down = false; nd.cold = S.t; cap('узел поднялся пустым — холодный старт: всё мимо кэша, пока ячейки не заполнятся', 'warn', true); note('up', `${S.nodes.length > 1 ? `Узел ${i + 1} поднялся` : 'Кэш поднялся'}, но память пустая — <b>холодный старт</b>: первые запросы все промахиваются и идут в базу.`, 'warn', 0); }
        });
        if (p.policy === 'behind' && S.t >= S.flushAt) {
          S.flushAt = S.t + FLUSH;
          const d = S.nodes.filter(nd => !nd.down).flatMap(nd => nd.slots.filter(c => c && c.dirty));
          if (d.length) flushNow(d);
        }
        const k = Math.exp(-dt / TAU);
        S.nodes.forEach(nd => nd.slots.forEach(c => { if (c) c.h *= k; }));
        index();
        for (const r of S.reqs.slice()) { let g = 0; while (!r.gone && S.t >= r.p0 + r.dur && g++ < 5) { advance(r); index(); } }
        S.reqs = S.reqs.filter(r => !r.gone);
        if (S.t >= S.swAt) { S.swAt = S.t + SWEEP; sweep(); }
        if (S.scn === 'stamp') { const c42 = findC(shard(HOT[0]), HOT[0]); if (c42 && !c42.inb && c42.exp <= S.t && !c42.bf && S.t - (S.burst ? S.burst.t : -1e9) > 2500) startBurst(); }
        if (S.scn === 'norm') { const goal = clamp(target() / Math.max(S.hh, 0.05), 0.3, 1); S.pHot += (goal - S.pHot) * Math.min(1, dt / 1500); }
        else S.pHot = S.scn === 'small' ? 0.8 : 0.92;
        S.reqs.forEach(r => { if (r.ph === 'cwait' && !(S.nodes[r.node] && S.nodes[r.node].slots.includes(r.cell))) toBack(r, pos(r)); });
        S.dbR = S.dbR * Math.exp(-dt / 2500) + (S.dbNew || 0) / 2.5; S.dbNew = 0;   // запросов в базу за модельную секунду
        S.dbE = S.dbR * realRate() / RATE;
        const du = S.dbCap ? S.dbE / S.dbCap : 0;
        S.slow = du > 1 ? Math.min(2.6, 1 + (du - 1) * 1.5) : 1;
        const c10 = S.t - 10000;
        S.ev = S.ev.filter(e => e.t > c10); S.dbA = S.dbA.filter(t => t > S.t - 2000); S.fx = S.fx.filter(f => S.t - f.t0 < FXT);
        if (S.ev.filter(e => e.k === 'evict' && HOT.includes(e.key)).length >= 3) done('evict');
        if (S.scn === 'small' && lfu() && S.cfgT > 6000) done('lfu');
        if (S.flags.stale && S.flags.fresh) done('price');
      }

      cache(); reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; S.pvT0 = S.t; },
        refresh() { cache(); resize(); },
        scenario(id) { S.scn = id; cache(); reset(); },
        onProp(key, prev, v) {
          S.cfgT = 0; cache();
          const p = P();
          if (key === 'ttl') { const t = TTLM[v] || 30000; S.nodes.forEach(nd => nd.slots.forEach(c => { if (c) { c.exp = Math.min(c.exp, S.t + t); c.ttl = t; } })); }
          if (key === 'policy' && prev === 'behind') { const d = S.nodes.flatMap(nd => nd.slots.filter(c => c && c.dirty)); if (d.length) flushNow(d); }
          resize();
          switch (key) {
            case 'mem': return S.scn === 'small' ? 'В «Мало памяти» ячеек нарочно мало. Переключись на «Как на схеме», чтобы увидеть свою память.'
              : +v < +prev ? 'Ячеек стало меньше: смотри, какие ключи вылетели и почему. Попадания падают, полоска базы растёт.' : 'Ячеек больше: горячие ключи помещаются, вытеснений меньше, база отдыхает.';
            case 'count': return rep() ? 'В режиме реплик узлы держат одну копию: ячеек не прибавилось, зато падение узла ничего не теряет.'
              : +v > +prev ? 'Узлов больше: ключи разложились по узлам по хешу, ячеек стало больше.' : 'Узлов меньше: ключи переложены, часть не поместилась.';
            case 'cluster': return v === 'replicated' ? 'Теперь у всех узлов одна копия: памяти как у одного, но падение узла ничего не теряет. Проверь в «Кэш упал».' : 'Ключи делятся между узлами по хешу — память складывается. Падение узла уносит его часть ключей.';
            case 'eviction': return v === 'lfu' ? 'LFU выбрасывает то, что читают реже всех: смотри на «читают ≈N×» в ячейках. Лучше всего видно в «Мало памяти».' : 'LRU выбрасывает то, что дольше всех не читали: смотри на «N с назад» в ячейках.';
            case 'ttl': return (TTLM[v] || 0) < (TTLM[prev] || 0) ? `Кольца тают быстрее (TTL ${TTLS[v]}): ключи гаснут, промахов больше, зато данные свежее.` : `Кольца тают медленнее (TTL ${TTLS[v]}): попаданий больше, но устаревшее живёт дольше.`;
            case 'policy': return v === 'behind' ? 'Write-behind: запись ложится только в кэш (жёлтая рамка), в базу уходит пачкой. Смотри в «Цена поменялась» и «Кэш упал».'
              : v === 'through' ? 'Write-through: запись идёт в кэш и в базу сразу — кэш всегда свежий. Смотри в «Цена поменялась».' : 'Cache-aside: запись идёт в базу, а ключ в кэше удаляется (если включено удаление). Смотри в «Цена поменялась».';
            case 'invalidate': return v ? 'После записи сервис удаляет ключ: следующий читатель возьмёт свежее из базы.' : `Ключ после записи остаётся: кэш будет отдавать старое до конца TTL (${TTLS[p.ttl] || ''}). Смотри в «Цена поменялась».`;
            case 'stampede': return v ? 'Single-flight: при промахе по ключу в базу идёт один запрос, остальные ждут его ответ. Смотри в «Популярный ключ истёк».' : 'Без защиты каждый промах идёт в базу сам — при истечении популярного ключа это толпа.';
          }
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const p = P(), c = counts(), N = S.nodes.length, all = S.nodes.every(nd => nd.down), dn = S.nodes.findIndex(nd => nd.down), sim = simHit();
          const over = S.dbCap && S.dbE > S.dbCap, x = S.dbCap ? (S.dbE / Math.max(1, (1 - sim) * realRate())) : 0;
          const lost = S.lost ? ` Write-behind: при падении потеряно ${S.lost} ${plural(S.lost, 'запись', 'записи', 'записей')} — их не было в базе.` : '';
          if (all && S.scn !== 'cold') return `<b>Кэша нет — все чтения идут в базу.</b> На площадке кэш сейчас лежит. База получает всё${over ? ' и не справляется: смотри полоску внизу' : ''}. Поэтому кэш держат в нескольких узлах.`;
          if (S.scn === 'small') return `<b>Мало памяти: ${slotsTotal()} ${plural(slotsTotal(), 'ячейка', 'ячейки', 'ячеек')} на ${HOT.length} горячих ключей.</b> Как маленький холодильник: чтобы положить новое, надо что-то выложить. Каждый промах выталкивает ключ, который скоро понадобится снова, — и тот тоже промахнётся. Из кэша сейчас ${pc(c.hr)} ответов.`
            + (lfu() ? ' <b>LFU</b> выбрасывает тех, кого читают реже (бледные ячейки), — хит product:42 держится в памяти.' : ' <b>LRU</b> выбрасывает того, кого дольше всех не читали, — даже популярный ключ, если к нему чуть дольше не обращались. Сравни с LFU.')
            + ' Лечится памятью или узлами.';
          if (S.scn === 'stamp') {
            const b = S.burst, live = b && S.t - b.t < 3500;
            if (live && !p.stampede) return `<b>Набег на базу (stampede).</b> Популярный ключ product:42 истёк, и ${b.n || BURST} запросов одновременно его не нашли — все пошли в базу за одним и тем же. В жизни это сотни запросов за миллисекунды: база падает от пустяка. Включи «Защита от stampede».`;
            if (live && p.stampede) return `<b>Защита работает.</b> В базу за product:42 пошёл один запрос, остальные ${b.w} ждут его ответ у входа в кэш («ждут» слева). База получила 1 запрос вместо ${b.w + 1}.`;
            return `<b>Следи за кольцом у product:42.</b> Это самый популярный ключ. Когда кольцо дотает (кончится TTL), толпа запросов промахнётся разом. ${p.stampede ? 'Защита включена: в базу пойдёт только один, остальные подождут.' : 'Защиты нет: в базу пойдут все.'} Другие способы: <b>ранний перезапрос</b> — обновить ключ чуть раньше конца TTL, и <b>разброс TTL</b>, чтобы ключи не истекали одновременно.`;
          }
          if (S.scn === 'price') {
            const c42 = findC(shard(HOT[0]), HOT[0]), dbP = price(S.db[HOT[0]]), cP = c42 ? price(c42.ver) : null, stale = c42 && !c42.inb && !c42.dirty && c42.ver < (S.db[HOT[0]] || 0);
            if (p.policy === 'behind') return `<b>Write-behind:</b> новая цена пишется только в кэш (жёлтая рамка «ещё не в базе»), а в базу уходит пачкой раз в ${FLUSH / 1000 | 0} с. Пользователь сразу видит новую цену, запись быстрая. Риск: если кэш упадёт до отправки, изменения пропадут — проверь в «Кэш упал».${c42 && c42.dirty ? ` Сейчас в базе ${dbP} ₽, а в кэше уже ${cP} ₽.` : ''}`;
            if (p.policy === 'through') return `<b>Write-through:</b> новая цена пишется в кэш и в базу одновременно. Кэш всегда свежий, промаха после записи нет. Плата — запись чуть медленнее: ждём обоих. Сейчас цена ${dbP} ₽ и там, и там.`;
            if (p.invalidate === false) return stale ? `<b>Цена поменялась, а кэш не знает.</b> В базе ${dbP} ₽, в кэше — ${cP} ₽ (красная рамка «устарело»). Пользователи видят старую цену, пока ключ не истечёт по TTL — до ${TTLD[p.ttl] || '10 минут'}. Включи «Удалять ключ при записи».`
              : '<b>Ключ при записи не удаляется.</b> Пока цена не менялась, всё хорошо. Дождись записи (фиолетовая точка по нижней дорожке) — и кэш начнёт отдавать старую цену.';
            return `<b>Запись → база, потом ключ удаляется из кэша (DEL).</b> Следующее чтение промахнётся, сходит в базу и возьмёт свежую цену. Плата за свежесть — один промах. ${cP != null ? `Сейчас в кэше ${cP} ₽, в базе ${dbP} ₽.` : `Ключа сейчас нет в кэше — следующий запрос возьмёт ${dbP} ₽ из базы.`}`;
          }
          if (S.scn === 'cold') {
            if (rep() && cnt() > 1) return (S.fo > S.t ? '<b>Главный узел упал, реплика заняла его место.</b> У реплики та же копия ключей, поэтому попадания не упали.' : '<b>Режим «Primary + реплики».</b> Скоро упадёт главный узел — смотри, что будет.') + ' Реплики не складывают память, зато переживают падение узла. Redis Cluster наоборот: памяти больше, но упавший узел уносит свою часть ключей.' + lost;
            if (dn >= 0 && N === 1) return `<b>Кэш упал.</b> Все чтения идут прямо в базу: она получает ${x > 1.5 ? `в ${x.toFixed(1).replace('.', ',')} раза больше` : 'все'} запросов${over ? ' и не справляется — полоска внизу красная' : ''}. Один узел — единая точка отказа. Добавь узлы.` + lost;
            if (dn >= 0) return `<b>Упал узел ${dn + 1} из ${N}.</b> Ключи раскладываются по узлам по хешу, поэтому пропала только его часть (≈ 1/${N}). Эти запросы идут в базу, остальные узлы отвечают как обычно.` + lost;
            const cold = S.nodes.some(nd => nd.cold && S.t - nd.cold < 9000);
            if (cold) return `<b>Холодный старт.</b> Кэш поднялся, но память пустая: почти каждый запрос — промах, и база получает всё. Ячейки заполняются, из кэша уже ${pc(c.hr)} ответов. Поэтому кэш «прогревают» заранее.` + lost;
            return `<b>Кэш прогрет и работает.</b> Через ${sec(S.crashAt - S.t)} ${N === 1 ? 'он упадёт — один узел, значит, упадёт всё сразу' : 'упадёт один из узлов'}. Смотри на полоску нагрузки на базу.` + lost;
          }
          const ev10 = c.evict;
          return `<b>Сервис спрашивает ключ — кэш ищет его в памяти.</b> Нашёл (зелёная вспышка) — ответ за ~1 мс. Не нашёл — промах: запрос идёт в базу (~${c.dbMs} мс), а ответ кладётся в свободную ячейку на будущее. Из кэша сейчас ${pc(c.hr)} ответов, на площадке — ${pc(sim)}.`
            + (ev10 > 2 ? ` Памяти не хватает: новые ключи выталкивают старые (${lfu() ? 'LFU — тех, кого читают реже' : 'LRU — тех, кого дольше не читали'}).` : ' Памяти хватает: горячие ключи живут, пока не дотает кольцо TTL.')
            + (dn >= 0 ? ' Часть узлов на площадке лежит — их ключи недоступны.' : '');
        },
        stats() {
          const p = P(), c = counts(), sim = simHit(), fr = S.dbCap ? S.dbE / S.dbCap : 0;
          const out = [
            ['Из кэша', pc(c.hr), c.hr >= 0.85 ? 'ok' : c.hr >= 0.6 ? 'warn' : 'bad', S.scn === 'norm' ? `на площадке ${pc(sim)}` : `площадка ${pc(sim)}, ситуация своя`],
            ['Ответ в среднем', `${Math.round(c.avg)} мс`, c.avg > 15 ? 'warn' : '', `кэш ≈ 1 мс, база ≈ ${c.dbMs} мс`],
            ['Запросов в базу', `≈ ${fmt(S.dbE)}/с`, fr > 1 ? 'bad' : fr > 0.75 ? 'warn' : '', S.dbCap ? `база тянет ≈ ${fmt(S.dbCap)}/с` : 'промахи и записи'],
            ['Вытеснено', String(c.evict), c.evict ? 'warn' : '', lfu() ? 'LFU: кого читают реже' : 'LRU: кого давно не читали'],
            ['Истёк TTL', String(c.exp), '', `TTL ${TTLS[p.ttl] || '—'} (в модели ${sec(TTLM[p.ttl] || 0)})`]
          ];
          if (p.policy === 'behind') { const d = S.nodes.reduce((s, nd) => s + nd.slots.filter(x => x && x.dirty).length, 0); out.push(['Не в базе', String(d), S.lost ? 'bad' : d ? 'warn' : '', S.lost ? `потеряно ${S.lost}` : 'ждут пачку']); }
          else out.push(['Старых ответов', String(c.stale), c.stale ? 'bad' : 'ok', p.policy === 'through' ? 'кэш пишется вместе с базой' : p.invalidate !== false ? 'ключ удаляется при записи' : 'ключ при записи не удаляется']);
          return out;
        },
        destroy() {}
      };
    }
  };
})();
