/* «NoSQL изнутри» (Cassandra / DynamoDB): ключ партиции и сортировки, кольцо токенов и виртуальные узлы, фактор репликации,
   уровни согласованности (R + W > N), горячая партиция, путь записи LSM, TTL и tombstones, запросы не по ключу, таблица под запрос. */
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
    return `<line class="xn-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xn-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const KW = /^(SELECT|FROM|WHERE|AND|INSERT|INTO|VALUES|CREATE|TABLE|PRIMARY|KEY|WITH|CLUSTERING|ORDER|BY|DESC|ASC|LIMIT|USING|TTL|DELETE|UPDATE|SET|ALLOW|FILTERING|IF|NOT|EXISTS|bigint|text|timeuuid|timestamp|int|counter|now)$/;
  const hl = line => line.split(/('[^']*'|"[^"]*"|\s+|[(),=<>*;:{}[\]]+)/).filter(x => x !== '').map(tk => /^('.*'|".*")$/.test(tk) ? `<tspan class="xn-st">${ES(tk)}</tspan>` : KW.test(tk) ? `<tspan class="xn-kw">${tk}</tspan>` : /^-?\d[\d.]*$/.test(tk) ? `<tspan class="xn-nu">${tk}</tspan>` : ES(tk)).join('');
  const CODE = (x, y, line, c) => { const i = line.indexOf('--'); const body = i >= 0 ? hl(line.slice(0, i)) + `<tspan class="xn-cm">${ES(line.slice(i))}</tspan>` : hl(line); return `<text class="xn-code${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${body}</text>`; };
  const MONO = (x, y, t, c, a) => `<text class="xn-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const fnv = s => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) / 4294967296; };
  const tokStr = f => { const v = (f * 2 - 1) * 9.223372036854776e18, s = Math.abs(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return (v < 0 ? '−' : '') + s; };
  const COLORS = ['--k-read', '--k-write', '--k-static', '--k-upload', '--k-search', '--k-msg', '--k-job', '--k-chat', '--k-voice', '--k-geo', '--k-graph', '--k-metrics', '--k-report', '--k-events'];
  const col = i => `var(${COLORS[i % COLORS.length]})`;

  /* ---------- данные примера: таблица сообщений чата ---------- */
  const CHATS = [
    { id: 7001, name: 'Семья', msgs: [['Мама', 'Купи хлеба по дороге'], ['Аня', 'Ок, после работы'], ['Папа', 'Я уже купил :)'], ['Аня', 'Тогда молоко'], ['Мама', 'И сыр!']] },
    { id: 42, name: 'Стрим «Финал»', hot: true, msgs: [['fan_77', 'ГОООЛ!!!'], ['Kirill', 'это было красиво'], ['sport_24', 'повтор покажут?'], ['Lena', 'офсайд же'], ['max', 'судья!!!']] },
    { id: 1550, name: 'Работа: релиз', msgs: [['Борис', 'деплой в 18:00'], ['Вера', 'тесты зелёные'], ['Гоша', 'миграцию проверил'], ['Борис', 'поехали']] },
    { id: 9310, name: 'Курс СА', msgs: [['Дина', 'где лекция 5?'], ['Егор', 'в канале'], ['Дина', 'спасибо!']] }];
  const T0 = 12 * 3600 + 31 * 60;   // 12:31 — время в модели
  const hms = s => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
  const tuuid = s => `${(0xe4b8c2a0 + Math.floor(s * 10000) % 0x0fffffff).toString(16)}-6f9d-11f1-8a2b-0242ac120002`;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const SRC = { x: 16, y: 52, w: 262, h: 112 }, KEY = { x: 16, y: 174, w: 262, h: 186 }, REP = { x: 16, y: 370, w: 262, h: 182 };
  const PART = { x: 748, y: 52, w: 236, h: 290 }, NODE = { x: 748, y: 352, w: 236, h: 200 };
  const CX = 516, CY = 304, R1 = 104, R2 = 196;

  SD.XRAY.nosql = {
    viewBox: '0 0 1000 560',
    cta: 'Кольцо токенов, реплики и уровни согласованности, горячая партиция, путь записи LSM, tombstones и таблицы под запрос — на сообщениях чата',
    dive: 'sharding',
    simple: () => ({
      an: 'Как <b>камера хранения из многих шкафов</b>: по номеру квитанции сразу понятно, в каком шкафу лежит сумка, а копии кладут ещё в два соседних шкафа. Найти сумку по номеру — мгновенно. Найти «все красные сумки» — придётся открыть каждый шкаф.',
      pl: 'NoSQL-база раскладывает данные по многим серверам по ключу: сообщения одного чата лежат вместе на нескольких узлах. Запись и чтение по ключу очень быстрые и масштабируются добавлением узлов. Запросы не по ключу и JOIN — дорогие, поэтому таблицы строят под конкретные запросы.'
    }),
    props: ['model', 'count', 'rf', 'cl', 'gsi'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Пользователи отправляют сообщения и листают историю чатов. Всё по настройкам узла.' },
      { id: 'hot', name: 'Горячая партиция', note: 'Финал чемпионата: в чате стрима 42 пишут все разом. Вся нагрузка ложится на три узла с его партицией.' },
      { id: 'down', name: 'Узел упал', note: 'Один узел кластера лёг. Что будет с записью и чтением при ONE, QUORUM и ALL?' },
      { id: 'stale', name: 'Записал и сразу читаю', note: 'Одна реплика отстаёт. Человек отправил сообщение и сразу открыл чат — увидит ли он его?' },
      { id: 'scan', name: 'Запрос не по ключу', note: 'Нужны все сообщения автора «Аня». Ключ партиции — chat_id, а не автор.' }
    ],
    tries: [
      { id: 'cl', text: 'Поставь согласованность ONE и посмотри, как запись отвечает после первого же подтверждения' },
      { id: 'all', text: 'В «Узел упал» выбери ALL: запись получает Unavailable, а QUORUM переживает падение' },
      { id: 'stale', text: 'В «Записал и сразу читаю» при ONE поймай устаревшее чтение, потом включи QUORUM' },
      { id: 'hot', text: 'В «Горячей партиции» добавь узлов и убедись, что три узла с чатом 42 всё равно перегружены' },
      { id: 'gsi', text: 'В «Запрос не по ключу» включи таблицу под запрос: опрос всех узлов сменяется одной партицией' },
      { id: 'pring', text: 'Открой блок «Кольцо токенов» и дождись, пока новый узел заберёт часть диапазонов' },
      { id: 'plsm', text: 'Открой блок «Путь записи (LSM)» и дождись сброса memtable в новый SSTable' }
    ],
    parts: {
      ring: {
        name: 'Кольцо токенов', knobs: ['count', 'rf'],
        an: 'Как <b>круглый стол, поделённый на сектора</b>: ключ превращается в точку на окружности, а сектор, куда она попала, принадлежит какому-то узлу. Добавили узел — он забирает себе несколько маленьких секторов у соседей, остальных не трогают.',
        pl: 'Все возможные значения хеша ключа образуют кольцо. Каждый узел владеет несколькими участками кольца (виртуальными узлами). Ключ хешируется в точку на кольце; владелец участка и следующие по кругу узлы хранят копии.',
        how: ['Хеш Murmur3 превращает chat_id в токен — число от −2⁶³ до 2⁶³ − 1. Это точка на кольце.', 'Кольцо поделено на участки. Каждый узел владеет несколькими участками — виртуальными узлами (num_tokens = 16).', 'Первая копия — у узла, чей участок содержит токен. Остальные RF − 1 копий — у следующих по кругу разных узлов.', 'Виртуальные узлы раскидывают каждого «соседа» по кольцу, поэтому нагрузка делится ровнее.', 'Добавили узел — он забирает понемногу участков у всех; переезжает ≈ 1/N данных, а не всё.', 'Клиент сам знает карту кольца (token-aware драйвер) и шлёт запрос сразу на узел с данными.'],
        watch: 'Цветные дуги — участки кольца, цвет — узел-владелец. Треугольник — токен ключа текущего запроса. Новый узел время от времени забирает несколько участков — видно, сколько данных переехало.',
        real: 'Cassandra и ScyllaDB: Murmur3Partitioner, num_tokens = 16 (в старых версиях 256). DynamoDB делит таблицу на партиции по хешу ключа сам и прячет это от вас. Ёмкость узла в площадке — ≈ 8 000 операций в секунду.'
      },
      key: {
        name: 'Ключ партиции и сортировки', knobs: ['model', 'gsi'],
        an: 'Как <b>папка на каждого клиента</b>: номер папки (ключ партиции) говорит, на какой полке она стоит, а листы внутри разложены по дате (ключ сортировки). Последние 50 листов достаются одним движением.',
        pl: 'Первичный ключ таблицы состоит из двух частей. Ключ партиции (chat_id) решает, на каких узлах лежат данные. Ключ сортировки (message_id) задаёт порядок строк внутри партиции. Хороший запрос всегда называет ключ партиции.',
        how: ['PRIMARY KEY ((chat_id), message_id): chat_id — ключ партиции, message_id — ключ сортировки.', 'Все сообщения одного чата лежат вместе, на одних и тех же RF узлах.', 'Внутри партиции строки отсортированы по message_id по убыванию: свежие — первыми.', 'message_id — timeuuid: уникальный идентификатор, в который зашито время. Сортировка по нему = сортировка по времени.', 'SELECT … WHERE chat_id = 7001 LIMIT 50 — один узел, один последовательный кусок диска.', 'WHERE created_at > … без chat_id — отказ: «используйте ALLOW FILTERING», то есть перебор всего кластера.'],
        watch: 'Слева — ключ текущего запроса, его токен и узлы-реплики. Справа — партиция этого чата: строки уже отсортированы, новые появляются сверху.',
        real: 'Cassandra/Scylla: partition key + clustering columns. DynamoDB: partition key (HASH) + sort key (RANGE). MongoDB: ключ шардирования + индекс. Партицию держат меньше ≈ 100 МБ.'
      },
      repl: {
        name: 'Реплики и согласованность', knobs: ['rf', 'cl'],
        an: 'Как <b>три копии договора у трёх нотариусов</b>: чтобы изменить договор, достаточно, чтобы его заверили двое. Чтобы узнать, что в нём, спроси двоих — хотя бы один точно видел последнюю правку.',
        pl: 'Каждая строка хранится на N = RF узлах. Запрос сам выбирает, сколько реплик должно ответить: ONE, QUORUM (большинство) или ALL. Если число ответивших на запись W и на чтение R вместе больше N, чтение обязательно застанет последнюю запись.',
        how: ['Координатор (любой узел) отправляет запись всем N репликам сразу.', 'Ответ клиенту — после W подтверждений: ONE = 1, QUORUM = 2 из 3, ALL = 3.', 'Остальные реплики догоняют в фоне; упавшему узлу координатор копит подсказки (hinted handoff).', 'Чтение спрашивает R реплик и берёт самую свежую версию по времени записи.', '<b>R + W > N</b>: множества пересекаются, свежая версия всегда попадёт в ответ. QUORUM + QUORUM: 2 + 2 > 3.', 'ALL не переживает падения одной реплики; ONE быстрый, но может вернуть старое.'],
        watch: 'Слева внизу — W, R и формула. На кольце координатор рассылает запрос репликам, зелёные точки — подтверждения. Ответ уходит, как только набралось нужное число.',
        real: 'Cassandra: CONSISTENCY ONE / LOCAL_QUORUM / ALL на каждый запрос. DynamoDB: eventually consistent чтение по умолчанию и ConsistentRead = true вдвое дороже. Расхождения чинят read repair и nodetool repair.'
      },
      lsm: {
        name: 'Путь записи (LSM)', knobs: ['model'],
        an: 'Как <b>черновик и чистовик</b>: новую запись сначала коротко заносят в журнал и в черновик на столе, а когда черновик заполнится, переписывают его целиком в новую тетрадь. Старые тетради иногда сшивают в одну.',
        pl: 'NoSQL-базы этого типа никогда не правят файлы на месте. Запись дописывается в журнал и в отсортированную таблицу в памяти — это очень быстро. Заполнилась память — она сбрасывается на диск новым неизменяемым файлом. В фоне файлы сливаются.',
        how: ['Запись дописывается в конец <b>commit log</b> на диске — защита от потери при падении.', 'И одновременно — в <b>memtable</b>: отсортированную таблицу в памяти.', 'Memtable заполнилась — сбрасывается на диск целиком новым файлом <b>SSTable</b>. Файл больше не меняется.', 'Чтение смотрит memtable и SSTable; фильтр Блума говорит «в этом файле ключа точно нет».', '<b>Компакция</b> в фоне сливает несколько SSTable в один и выбрасывает старые версии и истёкшие удаления.', 'Поэтому запись дешевле чтения: никакого поиска места на диске, только дописывание.'],
        watch: 'Лента — commit log, полоска — заполнение memtable, квадраты — SSTable на диске. Сброс создаёт новый квадрат, компакция склеивает несколько в один.',
        real: 'LSM-деревья: Cassandra, ScyllaDB, RocksDB, HBase, LevelDB. Компакция: SizeTiered, Leveled, TimeWindow (для временных рядов и чатов). memtable — сотни мегабайт.'
      },
      ttl: {
        name: 'TTL и tombstones', knobs: ['model'],
        an: 'Как <b>зачёркивание в тетради</b>: удалить строку из уже написанной страницы нельзя, поэтому пишут «вычеркнуто». Пока страницы не переписали начисто, читателю приходится пролистывать и зачёркнутое.',
        pl: 'Файлы на диске не меняются, поэтому удаление — это тоже запись: метка-надгробие (tombstone). Строка с TTL сама превращается в надгробие, когда срок истёк. Надгробия убирает компакция, но не раньше, чем пройдёт gc_grace_seconds.',
        how: ['INSERT … USING TTL 604800 — строка проживёт неделю и превратится в tombstone.', 'DELETE FROM messages WHERE chat_id = 7001 AND message_id = … — тоже запись: надгробие с отметкой времени.', 'Чтение собирает строки и надгробия из всех SSTable и скрывает удалённое.', 'Тысячи надгробий в одной партиции замедляют чтение; при 100 000 Cassandra прерывает запрос.', 'Компакция выкидывает надгробия, только когда прошли gc_grace_seconds (10 дней).', 'Зачем ждать: если реплика лежала и не знала об удалении, без надгробия она «воскресит» строку.'],
        watch: 'Шкала времени партиции: строки, строки с TTL, надгробия. Чтение пробегает по всему и показывает, сколько мусора пришлось пролистать. Компакция после срока чистит.',
        real: 'Cassandra: default_time_to_live, gc_grace_seconds = 864000, tombstone_failure_threshold = 100 000. DynamoDB TTL удаляет просроченные элементы в фоне в течение пары дней.'
      },
      hot: {
        name: 'Горячая партиция', knobs: ['count', 'rf'],
        an: 'Как <b>одна касса в супермаркете с акционным товаром</b>: касс двадцать, но очередь стоит к одной. Новые кассы не помогут, пока товар продают только в ней.',
        pl: 'Партиция живёт на RF узлах, и все запросы к ней идут туда. Если один ключ гораздо популярнее остальных — чат стрима, звезда в соцсети — эти узлы перегружены, а остальные простаивают. Лечится только сменой ключа.',
        how: ['Все сообщения чата 42 — одна партиция на трёх узлах.', 'Финал: в чате пишут 70 % всех пользователей — три узла получают 70 % нагрузки.', 'Добавить узлы бесполезно: партиция не делится между узлами.', 'Партиция растёт до гигабайтов: компакция и ремонт такой партиции мучительны.', '<b>Бакеты</b>: ключ ((chat_id, bucket)), где bucket — день или hash % 16. Один большой чат раскладывается на много партиций.', 'Цена: чтение истории теперь склеивает несколько партиций.'],
        watch: 'Столбики — размер и нагрузка партиций, узлы — их загрузка. После бакетов огромный столбик рассыпается на 16 маленьких по разным узлам.',
        real: 'В DynamoDB горячий ключ упирается в 3 000 RCU и 1 000 WCU на партицию — приходят ProvisionedThroughputExceeded. Discord делил сообщения по (channel_id, bucket) — бакет 10 дней.'
      },
      scatter: {
        name: 'Запрос не по ключу', knobs: ['gsi', 'count'],
        an: 'Как <b>искать все письма от Ани на почте</b>, где ящики разложены по адресам получателей: придётся открыть каждый ящик. Проще завести отдельную картотеку по отправителям.',
        pl: 'Узел, на который придёт запрос, не знает, где лежат сообщения автора: данные разложены по chat_id. Без отдельной таблицы ему приходится опросить все узлы и перебрать все партиции. JOIN в NoSQL нет совсем.',
        how: ['SELECT … WHERE author = \'Аня\' без ключа партиции — база отказывает без ALLOW FILTERING.', 'С ALLOW FILTERING координатор опрашивает все узлы, каждый читает все свои партиции.', 'Время растёт с размером кластера, а не с размером ответа.', 'Решение — <b>таблица под запрос</b>: messages_by_author с ключом партиции author. Каждая запись пишется в две таблицы.', 'Или вторичный индекс (GSI в DynamoDB) — та же копия данных, которую база ведёт сама.', 'JOIN нет: данные денормализуют заранее или склеивают в приложении двумя запросами по ключу.'],
        watch: 'Без таблицы под запрос координатор шлёт запрос всем узлам — веер стрелок и счётчик перебранных строк. С таблицей — три реплики одной партиции.',
        real: 'Cassandra: материализованные представления (экспериментальные), SAI-индексы, но чаще — своя таблица под запрос. DynamoDB: GSI с отдельной ёмкостью. На площадке без таблицы запросы «по другому полю» стоят в 20–50 раз дороже.'
      },
      model: {
        name: 'Таблица под запрос', knobs: ['model', 'gsi'],
        an: 'Как <b>расписание, распечатанное под каждую остановку</b>: одни и те же рейсы, но у каждой остановки свой лист. Повторов много, зато найти нужное — одним взглядом.',
        pl: 'В реляционной базе сначала таблицы, потом любые запросы. В NoSQL наоборот: сначала список запросов, под каждый — своя таблица с подходящим ключом. Одни и те же данные лежат в нескольких местах.',
        how: ['Выписываем запросы: Q1 — последние сообщения чата; Q2 — сообщения автора; Q3 — непрочитанные у пользователя.', 'Q1 → messages_by_chat: ключ chat_id, сортировка message_id.', 'Q2 → messages_by_author: ключ author, сортировка message_id.', 'Q3 → unread_by_user: ключ user_id, счётчики по чатам.', 'Отправка сообщения пишет во все таблицы (batch или по событию).', 'Модель зависит от базы: wide-column (Cassandra), документы (MongoDB), ключ-значение (DynamoDB — одна таблица с PK/SK).'],
        watch: 'Слева список запросов, справа таблицы под них. Модель на картинке меняется вместе с настройкой «Модель данных»: wide-column, документы или ключ-значение.',
        real: 'Методика Chebotko для Cassandra, single-table design для DynamoDB (Rick Houlihan). MongoDB: встраивать часто читаемое вместе (embedding) и ссылаться на редкое.'
      }
    },
    legend: [['write', 'Запись: отправка сообщения'], ['read', 'Чтение истории чата'], ['ok', 'Подтверждение реплики, ответ клиенту'], ['accent', 'Координатор запроса'], ['sq xn-swt', 'Токен ключа на кольце'], ['ring xn-swr', 'Реплика текущего ключа'], ['job', 'Подсказка (hint) для упавшего узла'], ['bad', 'Отказ: не хватило реплик, узел лежит']],
    live: (n, r) => {
      const l = r.load || {}, rps = Object.keys(l).reduce((s, k) => s + l[k], 0);
      const out = [['Поток', SD.fmt.num(rps) + '/с', '']];
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      out.push(['Узлы × RF', `${n.props.count} × ${n.props.rf || 3}`, '']);
      out.push(['Согласованность', String(n.props.cl || 'quorum').toUpperCase(), '']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xnSt"></g><g id="xnDy" class="xn-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xnSt'), gDy = ctx.svg.querySelector('#xnDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 8) S.fx.shift(); };
      const N = () => clamp(+P().count || 3, 1, 20);
      const RF = () => Math.min(N(), +P().rf === 1 ? 1 : 3);
      const CL = () => P().cl || 'quorum';
      const need = () => { const rf = RF(), c = CL(); return c === 'one' ? 1 : c === 'all' ? rf : Math.floor(rf / 2) + 1; };
      const util = () => ctx.res.util || 0;

      /* ---------- кольцо: токены узлов ---------- */
      const vnOf = n => n <= 3 ? 8 : n <= 6 ? 5 : n <= 10 ? 3 : 2;
      function buildRing(n, vnF) {   // токены узла i не зависят от числа узлов: новый узел только добавляет свои
        const vn = vnF || vnOf(n), toks = [];
        for (let i = 0; i < n; i++) { const r = rng(1000 + i * 7919); for (let v = 0; v < vn; v++) toks.push({ p: r(), node: i }); }
        toks.sort((a, b) => a.p - b.p);
        return toks;
      }
      function owner(toks, p) { for (let k = 0; k < toks.length; k++) if (toks[k].p >= p) return k; return 0; }
      function replicas(toks, p, rf) { const out = []; let k = owner(toks, p); for (let j = 0; j < toks.length && out.length < rf; j++) { const nd = toks[(k + j) % toks.length].node; if (!out.includes(nd)) out.push(nd); } return out; }
      const nodeXY = i => { const n = S.nodes.length, a = -Math.PI / 2 + i * 2 * Math.PI / n; return [CX + R2 * Math.cos(a), CY + R2 * Math.sin(a)]; };
      const ringXY = (p, r) => { const a = -Math.PI / 2 + p * 2 * Math.PI; return [CX + (r || R1) * Math.cos(a), CY + (r || R1) * Math.sin(a)]; };
      const nodeR = () => S.nodes.length <= 6 ? 20 : S.nodes.length <= 12 ? 15 : 11;

      function reset() {
        const n = N();
        S.toks = buildRing(n);
        S.nodes = Array.from({ length: n }, (_, i) => ({ i, dead: false, load: [], mem: 0.3 + 0.1 * (i % 3), sst: 3 + (i % 3), cl: 0, hints: 0, flushT: -1e9, cmpT: -1e9 }));
        S.chats = CHATS.map(c => ({ ...c, tok: fnv('chat:' + c.id), rows: c.msgs.slice(0, 3).map((m, k) => ({ a: m[0], x: m[1], ts: T0 - (3 - k) * 37 - 5, nid: k })), ver: 3, next: 3 }));
        S.chats.forEach(c => { c.reps = replicas(S.toks, c.tok, RF()); c.repVer = {}; c.reps.forEach(i => { c.repVer[i] = c.ver; }); });
        Object.assign(S, { t: 0, reqs: [], fx: [], at: 400, wall: T0, cur: S.chats[0], hist: [], fails: [], stale: [], hintDots: [], scanN: 0, lagNode: null, downAt: 1800, upAt: 9500, cfgT: 0 });
        if (S.scn === 'stale') { const c = S.chats[0]; S.lagNode = c.reps[c.reps.length - 1]; }
        S.cfg = cfgSig();
      }
      const cfgSig = () => [N(), RF(), S.scn].join('|');
      const pickChat = () => {
        if (S.scn === 'hot') return Math.random() < 0.72 ? S.chats[1] : S.chats[[0, 2, 3][Math.floor(Math.random() * 3)]];
        if (S.scn === 'stale') return S.chats[0];
        return S.chats[Math.floor(Math.random() * S.chats.length)];
      };
      const alive = () => S.nodes.filter(nd => !nd.dead).map(nd => nd.i);

      /* ---------- запросы ---------- */
      function spawn() {
        const live = alive(); if (!live.length) return;
        if (S.scn === 'scan' && Math.random() < 0.45) return spawnScan();
        const c = pickChat(), k = S.scn === 'stale' ? (S.stPh = !S.stPh) ? 'w' : 'r' : Math.random() < 0.58 ? 'w' : 'r';
        const coord = live[Math.floor(Math.random() * live.length)];
        const q = { id: (S.qid = (S.qid || 0) + 1), k, c, coord, ph: 'go', p0: S.t, dur: 420, need: need(), reps: c.reps.slice(), acks: [], sent: false };
        S.reqs.push(q); S.cur = c; S.curQ = q;
      }
      function spawnScan() {
        const live = alive(), coord = live[Math.floor(Math.random() * live.length)], gsi = !!P().gsi;
        const reps = gsi ? replicas(S.toks, fnv('author:Аня'), RF()) : S.nodes.map(nd => nd.i);
        const q = { id: (S.qid = (S.qid || 0) + 1), k: 'scan', gsi, coord, ph: 'go', p0: S.t, dur: 420, need: gsi ? need() : reps.length, reps, acks: [], sent: false };
        S.reqs.push(q); S.curQ = q;
      }
      function procMs(i, q) {
        const nd = S.nodes[i], ld = nd.load.length;
        let ms = q.k === 'scan' ? (q.gsi ? 160 : 1500 + 60 * S.nodes.length) : 130;
        if (ld > 9) ms += (ld - 9) * 70;
        ms *= 1 + Math.min(util(), 1.5) * 0.4;
        return ms + Math.random() * 90;
      }
      function fan(q) {
        q.sent = true; q.t1 = S.t; S.showQ = q;
        q.reps.forEach((i, j) => {
          const nd = S.nodes[i], go = 300 + Math.random() * 90, pr = procMs(i, q), lag = S.scn === 'stale' && i === S.lagNode && q.k === 'w' ? 2600 : 0, back = 300 + Math.random() * 60;
          nd.load.push(S.t);
          const a = { i, sendAt: S.t + go, done: S.t + go + pr + lag, ackAt: S.t + go + pr + lag + back, dead: nd.dead, ok: !nd.dead, applied: false };
          if (nd.dead && q.k === 'w') { const co = S.nodes[q.coord]; co.hints++; S.flags.hint = 1; }
          q.acks.push(a);
        });
        const live = q.acks.filter(a => !a.dead).length;
        if (live < q.need) { q.fail = true; q.failAt = S.t + 900; }
      }
      function step(q) {
        if (q.ph === 'go' && S.t >= q.p0 + q.dur) { q.ph = 'fan'; fan(q); }
        if (q.ph === 'fan') {
          q.acks.forEach(a => {
            if (!a.dead && !a.applied && S.t >= a.done) {
              a.applied = true;
              const nd = S.nodes[a.i];
              if (q.k === 'w') { q.c.repVer[a.i] = Math.max(q.c.repVer[a.i] || 0, q.ver || 0); nd.mem += 0.05; nd.cl++; }
            }
          });
          if (q.k === 'w' && q.ver == null) { q.ver = ++q.c.next; q.msg = q.c.msgs[(q.ver - 1) % q.c.msgs.length]; }
          const got = q.acks.filter(a => !a.dead && S.t >= a.ackAt);
          if (q.fail && S.t >= q.failAt) { q.ph = 'back'; q.p0 = S.t; q.dur = 420; q.res = 'fail'; finish(q); return; }
          if (!q.fail && got.length >= q.need) { q.ph = 'back'; q.p0 = S.t; q.dur = 420; q.res = 'ok'; q.ms = (S.t - q.t1) / 150; finish(q); }
        }
        if (q.ph === 'back' && S.t >= q.p0 + q.dur) { q.ph = 'tail'; }
        if (q.ph === 'tail') {
          q.acks.forEach(a => { if (!a.dead && !a.applied && S.t >= a.done) { a.applied = true; if (q.k === 'w') q.c.repVer[a.i] = Math.max(q.c.repVer[a.i] || 0, q.ver || 0); } });
          if (q.acks.every(a => a.dead || S.t >= a.ackAt)) q.gone = true;
        }
      }
      function finish(q) {
        if (q.res === 'fail') {
          S.fails.push(S.t);
          const liveN = q.acks.filter(a => !a.dead).length;
          pop(SRC.x + SRC.w - 60, SRC.y + SRC.h - 10, 'Unavailable', 'bad');
          note('un', `<b>Отказ: Unavailable.</b> Для ${CL().toUpperCase()} нужно ${q.need} ${pl(q.need, 'реплика', 'реплики', 'реплик')}, а живых ${liveN}. ${CL() === 'all' ? 'ALL не переживает падения даже одной копии — QUORUM бы ответил.' : ''}`, 'bad', 4000);
          if (S.scn === 'down' && CL() === 'all') S.flags.allFail = 1;
          return;
        }
        S.hist.push({ t: S.t, ms: q.ms, k: q.k });
        if (q.k === 'w') {
          const c = q.c, m = q.msg || c.msgs[0];
          c.ver = Math.max(c.ver, q.ver);
          c.rows.push({ a: m[0], x: m[1], ts: S.wall, nid: q.ver, t0: S.t }); if (c.rows.length > 6) c.rows.shift();
          if (CL() === 'one' && RF() > 1) done('cl');
        } else if (q.k === 'r') {
          const got = q.acks.filter(a => !a.dead && S.t >= a.ackAt).slice(0, q.need), best = Math.max(...got.map(a => q.c.repVer[a.i] || 0));
          if (best < q.c.ver) {
            q.stale = true; S.stale.push(S.t); S.flags.stale = 1;
            pop(SRC.x + SRC.w - 60, SRC.y + SRC.h - 10, 'старое сообщение!', 'bad');
            note('st', `<b>Устаревшее чтение:</b> ответила только отстающая реплика ${'n' + (got[0].i + 1)}, а последнего сообщения у неё ещё нет. Человек не видит то, что сам только что отправил. R + W = ${need() * 2} ≤ N = ${RF()}.`, 'bad', 4000);
          } else if (S.scn === 'stale' && CL() !== 'one') { if (S.flags.stale) done('stale'); note('stok', `<b>R + W > N:</b> чтение спросило ${q.need} ${pl(q.need, 'реплику', 'реплики', 'реплик')}, хотя бы одна уже с новым сообщением — ответ свежий${q.acks.some(a => (q.c.repVer[a.i] || 0) < best) ? ', а отстающую реплику тут же починил read repair' : ''}.`, 'ok', 5000); }
        } else if (q.k === 'scan') {
          S.scanN++;
          if (q.gsi) { done('gsi'); note('gsiok', '<b>Таблица под запрос:</b> messages_by_author — ключ партиции author. Запрос ушёл на три реплики одной партиции, как обычное чтение по ключу.', 'ok', 6000); }
          else note('scan', `<b>Перебор кластера:</b> запрос без ключа партиции опросил все ${S.nodes.length} ${pl(S.nodes.length, 'узел', 'узла', 'узлов')}, каждый перебрал все свои партиции. Отвечает самый медленный.`, 'warn', 6000);
        }
      }

      /* ---------- узел упал / поднялся ---------- */
      function downStep() {
        if (S.scn !== 'down') return;
        const c = S.chats[0], vic = c.reps[0];
        if (!S.nodes[vic].dead && S.t >= S.downAt && S.t < S.upAt) { S.nodes[vic].dead = true; note('dn', `<b>Узел n${vic + 1} упал.</b> Он хранит копию чата ${c.id}. ${CL() === 'all' ? 'При ALL запись и чтение этого чата будут получать отказ.' : CL() === 'quorum' ? 'QUORUM: две живые реплики из трёх — запросы проходят.' : 'ONE: хватает одной живой реплики.'} Записи для него координатор копит как подсказки (hints).`, 'bad', 0); }
        if (S.nodes[vic].dead && S.t >= S.upAt) {
          S.nodes[vic].dead = false;
          const hs = S.nodes.reduce((s, nd) => s + nd.hints, 0);
          S.nodes.forEach(nd => { if (nd.hints) { for (let k = 0; k < Math.min(nd.hints, 4); k++) S.hintDots.push({ from: nd.i, to: vic, t0: S.t + k * 140, d: 700 }); nd.hints = 0; } });
          Object.keys(c.repVer).forEach(k => { c.repVer[k] = c.ver; });
          note('up', `<b>n${vic + 1} вернулся.</b> Координаторы передали ему ${hs} ${pl(hs, 'подсказку', 'подсказки', 'подсказок')} — пропущенные записи (hinted handoff). Реплика снова догнала остальных.`, 'ok', 0);
          S.downAt = S.t + 4000; S.upAt = S.downAt + 7000;
        }
        if (CL() === 'quorum' && S.flags.allFail && S.nodes[vic].dead) done('all');
      }

      /* ---------- отрисовка ---------- */
      function badges() {
        const bs = [['ring', 'КОЛЬЦО ТОКЕНОВ', `${S.nodes.length} ${pl(S.nodes.length, 'узел', 'узла', 'узлов')} · ${S.toks.length} участков`], ['ttl', 'TTL И TOMBSTONES', 'удаление = запись'], ['hot', 'ГОРЯЧАЯ ПАРТИЦИЯ', S.scn === 'hot' ? 'чат 42: 72 % запросов' : 'один ключ на 3 узла'], ['scatter', 'ЗАПРОС НЕ ПО КЛЮЧУ', P().gsi ? 'есть таблица под запрос' : 'опрос всех узлов'], ['model', 'ТАБЛИЦА ПОД ЗАПРОС', { wide: 'wide-column', doc: 'документы', kv: 'ключ-значение' }[P().model || 'wide']]];
        const w = (984 - 290 - 4 * 8) / 5;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xn-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xn-go');
        bs.forEach(([k, t, v], i) => { const x = 290 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xn-badge', 9)}${T(x + 8, 18, t, 'xr-m')}${T(x + 8, 32, ES(cut(v, 22)), 'xr-s')}</g>`; });
        return s;
      }
      function srcBox() {
        const ins = ctx.ins().map(x => x.n), src = ins.find(k => k.type === 'ws') || ins.find(k => k.type === 'app') || ins[0], go = src && ctx.canGo(src.id), q = S.curQ;
        let s = `<g${go ? ` class="xr-go" data-xgo="${src.id}"` : ''}>${R(SRC.x, SRC.y, SRC.w, SRC.h, 'xr-box', 12)}`;
        s += T(SRC.x + 12, SRC.y + 20, ES(cut(src ? ctx.nm(src.id) : 'Сервис', 24)), 'xr-t') + T(SRC.x + SRC.w - 12, SRC.y + 20, go ? 'клик — внутрь ›' : '', 'xr-s xn-go', 'end');
        if (q && q.k === 'scan') { s += CODE(SRC.x + 12, SRC.y + 44, q.gsi ? 'SELECT * FROM messages_by_author' : 'SELECT * FROM messages', 'sm') + CODE(SRC.x + 12, SRC.y + 60, q.gsi ? "WHERE author = 'Аня' LIMIT 50" : "WHERE author = 'Аня' ALLOW FILTERING", 'sm'); }
        else if (q && q.k === 'w') { const m = q.msg || q.c.msgs[0]; s += CODE(SRC.x + 12, SRC.y + 44, `INSERT INTO messages VALUES (${q.c.id},`, 'sm') + CODE(SRC.x + 12, SRC.y + 60, `  now(), '${cut(m[0], 8)}', '${cut(m[1], 14)}')`, 'sm'); }
        else if (q) s += CODE(SRC.x + 12, SRC.y + 44, 'SELECT * FROM messages', 'sm') + CODE(SRC.x + 12, SRC.y + 60, `WHERE chat_id = ${q.c.id} LIMIT 50`, 'sm');
        const last = S.hist[S.hist.length - 1];
        s += T(SRC.x + 12, SRC.y + 84, `согласованность: ${CL().toUpperCase()} · ждём ${need()} из ${RF()}`, 'xr-s');
        s += T(SRC.x + 12, SRC.y + 102, last ? `последний ответ: ${nf(last.ms, 1)} мс` : 'ждём ответ…', 'xr-m ' + (last ? 'ok' : ''));
        return s + '</g>';
      }
      function keyPanel() {
        const b = KEY, q = S.curQ, scan = q && q.k === 'scan', c = q && q.c ? q.c : S.cur;
        let s = `<g class="xr-part" data-xpart="key">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, 'КЛЮЧ ПАРТИЦИИ → УЗЛЫ', 'xr-m');
        if (scan && !q.gsi) {
          s += T(b.x + 12, b.y + 44, 'в запросе нет chat_id —', 'xr-s xn-warn') + T(b.x + 12, b.y + 62, 'токен посчитать не из чего', 'xr-s xn-warn');
          s += T(b.x + 12, b.y + 90, 'координатор не знает, где', 'xr-s') + T(b.x + 12, b.y + 108, 'лежат сообщения Ани, и', 'xr-s') + T(b.x + 12, b.y + 126, `опрашивает все ${S.nodes.length} ${pl(S.nodes.length, 'узел', 'узла', 'узлов')}`, 'xr-s xn-bad');
          return s + '</g>';
        }
        const key = scan ? "author = 'Аня'" : `chat_id = ${c.id}`, tok = scan ? fnv('author:Аня') : c.tok, reps = scan ? q.reps : c.reps;
        s += MONO(b.x + 12, b.y + 44, key, 'on') + T(b.x + 12 + key.length * 6.3 + 8, b.y + 44, scan ? '' : `«${ES(cut(c.name, 14))}»`, 'xr-s');
        s += T(b.x + 12, b.y + 64, 'Murmur3(ключ) → токен на кольце:', 'xr-s') + MONO(b.x + 12, b.y + 82, tokStr(tok));
        s += T(b.x + 12, b.y + 104, `реплики (RF = ${RF()}), по часовой:`, 'xr-s');
        reps.forEach((i, j) => { const x = b.x + 12 + j * 52; s += R(x, b.y + 112, 44, 22, 'xn-chip' + (S.nodes[i].dead ? ' dead' : ''), 6) + `<rect class="xn-cbar" x="${x}" y="${b.y + 112}" width="4" height="22" rx="2" style="fill:${col(i)}"/>` + T(x + 25, b.y + 127, 'n' + (i + 1), 'xn-fn', 'middle') + (j < reps.length - 1 ? T(x + 48, b.y + 127, '→', 'xn-ms', 'middle') : ''); });
        s += T(b.x + 12, b.y + 156, scan ? 'таблица messages_by_author:' : 'внутри партиции строки', 'xr-s') + T(b.x + 12, b.y + 174, scan ? 'ключ партиции — author' : 'отсортированы по message_id', 'xr-s');
        return s + '</g>';
      }
      function replPanel() {
        const b = REP, q = S.showQ, n = need(), rf = RF(), ok = n + n > rf;
        let s = `<g class="xr-part" data-xpart="repl">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, 'РЕПЛИКИ И СОГЛАСОВАННОСТЬ', 'xr-m');
        s += T(b.x + 12, b.y + 44, `запись W = ${CL().toUpperCase()}: ${n} из ${rf}`, 'xr-s') + T(b.x + 12, b.y + 62, `чтение R = ${CL().toUpperCase()}: ${n} из ${rf}`, 'xr-s');
        s += T(b.x + 12, b.y + 86, `R + W = ${n * 2} ${ok ? '>' : '≤'} N = ${rf}`, 'xn-big ' + (ok ? 'xn-ok' : 'xn-warn')) + T(b.x + 12, b.y + 104, ok ? 'чтение всегда видит свежее' : 'чтение может вернуть старое', 'xr-s ' + (ok ? 'xn-ok' : 'xn-warn'));
        if (q && q.acks && q.acks.length && q.k !== 'scan') {
          s += T(b.x + 12, b.y + 128, `${q.k === 'w' ? 'запись' : 'чтение'} чата ${q.c.id} · ответы реплик:`, 'xr-s');
          q.acks.forEach((a, j) => { const st = a.dead ? 'dead' : S.t >= a.ackAt ? 'ok' : 'wait', x = b.x + 12 + j * 44; s += R(x, b.y + 136, 38, 22, 'xn-ack ' + st, 5) + T(x + 19, b.y + 151, 'n' + (a.i + 1) + (a.dead ? ' ✕' : st === 'ok' ? ' ✓' : ''), 'xn-fn', 'middle'); });
          const got = q.acks.filter(a => !a.dead && S.t >= a.ackAt).length;
          s += T(b.x + 12 + q.acks.length * 44 + 2, b.y + 151, q.res === 'fail' ? 'отказ' : got >= n ? 'ответ ушёл' : `ждём ${n - got}`, 'xr-s ' + (q.res === 'fail' ? 'xn-bad' : got >= n ? 'xn-ok' : ''));
        } else if (q && q.k === 'scan') s += T(b.x + 12, b.y + 132, q.gsi ? `ответили ${q.acks.filter(a => S.t >= a.ackAt).length} из ${q.reps.length}` : `ждём все ${q.reps.length} узлов`, 'xr-s' + (q.gsi ? '' : ' xn-warn'));
        s += T(b.x + 12, b.y + 174, CL() === 'all' ? 'ALL: упадёт реплика — отказ' : CL() === 'one' ? 'ONE: быстро, но без гарантий' : 'QUORUM: большинство из трёх', 'xn-ms');
        return s + '</g>';
      }
      function ringSvg() {
        const toks = S.toks, n = S.nodes.length;
        let s = `<g class="xr-part" data-xpart="ring">${R(CX - R1 - 18, CY - R1 - 18, 2 * R1 + 36, 2 * R1 + 36, 'xn-pf', R1 + 18)}`;
        toks.forEach((t, k) => {
          const p0 = toks[(k - 1 + toks.length) % toks.length].p, p1 = t.p, a0 = p0, a1 = p1 < p0 ? p1 + 1 : p1;
          const [x0, y0] = ringXY(a0), [x1, y1] = ringXY(a1), large = a1 - a0 > 0.5 ? 1 : 0;
          s += `<path class="xn-arc${S.nodes[t.node].dead ? ' dead' : ''}" d="M${f1(x0)},${f1(y0)} A${R1},${R1} 0 ${large} 1 ${f1(x1)},${f1(y1)}" style="stroke:${col(t.node)}"/>`;
        });
        s += T(CX, CY - 8, 'кольцо токенов', 'xn-ms', 'middle') + T(CX, CY + 8, '−2⁶³ … 2⁶³', 'xn-ms', 'middle');
        s += '</g>';
        // узлы
        const q = S.curQ, rr = nodeR();
        S.nodes.forEach(nd => {
          const [x, y] = nodeXY(nd.i), lc = nd.load.length, hot = lc > 10, rep = q && q.reps && q.reps.includes(nd.i), co = q && q.coord === nd.i;
          if (co) s += `<circle class="xn-coord" cx="${f1(x)}" cy="${f1(y)}" r="${rr + 6}"/>`;
          s += `<circle class="xn-node${nd.dead ? ' dead' : hot ? ' hot' : ''}${rep ? ' rep' : ''}" cx="${f1(x)}" cy="${f1(y)}" r="${rr}" style="stroke:${nd.dead ? 'var(--bad)' : col(nd.i)}"/>`;
          const fill = clamp(lc / 14, 0, 1);
          if (!nd.dead && fill > 0.05) s += `<circle class="xn-load${hot ? ' hot' : ''}" cx="${f1(x)}" cy="${f1(y)}" r="${f1(rr * 0.8 * fill)}"/>`;
          s += T(x, y + 4, 'n' + (nd.i + 1), 'xn-nl', 'middle');
          if (nd.dead) s += Ln(x - rr * 0.6, y - rr * 0.6, x + rr * 0.6, y + rr * 0.6, 'xn-x') + Ln(x + rr * 0.6, y - rr * 0.6, x - rr * 0.6, y + rr * 0.6, 'xn-x');
          if (nd.hints && n <= 12) s += T(x, y - rr - 6, `hints: ${nd.hints}`, 'xn-ms xn-job', 'middle');
        });
        // токен текущего ключа
        if (q && (q.k !== 'scan' || q.gsi)) {
          const tok = q.k === 'scan' ? fnv('author:Аня') : q.c.tok, [tx, ty] = ringXY(tok, R1 - 14), [ox, oy] = ringXY(tok, R1 + 13);
          s += `<polygon class="xn-tok" points="${f1(tx)},${f1(ty)} ${f1(ox + (ty - oy) * 0.35)},${f1(oy - (tx - ox) * 0.35)} ${f1(ox - (ty - oy) * 0.35)},${f1(oy + (tx - ox) * 0.35)}"/>`;
          const [lx, ly] = ringXY(tok, R1 - 30);
          s += T(lx, ly + 4, q.k === 'scan' ? 'Аня' : String(q.c.id), 'xn-fn xn-acc', 'middle');
        }
        return s;
      }
      function partPanel() {
        const b = PART, c = S.cur, q = S.curQ, scan = q && q.k === 'scan';
        let s = `<g class="xr-part" data-xpart="key">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        if (scan) {
          s += T(b.x + 12, b.y + 20, q.gsi ? 'messages_by_author' : 'ПЕРЕБОР ВСЕХ ПАРТИЦИЙ', 'xr-m' + (q.gsi ? ' acc' : ' warn'));
          s += T(b.x + 12, b.y + 38, q.gsi ? "партиция author = 'Аня'" : 'каждый узел читает всё подряд', 'xr-s');
          const rows = [['12:20:41', 'Семья', 'Ок, после работы'], ['12:31:07', 'Семья', 'Тогда молоко'], ['11:02:13', 'Курс СА', 'как сдать тест?'], ['09:47:55', 'Подруги', 'в 7 у кинотеатра']];
          rows.forEach((r, j) => { const y = b.y + 66 + j * 36; s += T(b.x + 12, y, `${r[0]} · ${ES(r[1])}`, 'xn-fn sm') + T(b.x + 12, y + 16, ES(cut(r[2], 30)), 'xn-val'); });
          s += T(b.x + 12, b.y + b.h - 30, q.gsi ? 'одна партиция, строки уже по времени' : `перебрано ≈ ${nf(S.nodes.length * 3.2, 1)} млн строк`, 'xr-s' + (q.gsi ? ' xn-ok' : ' xn-bad'));
          s += T(b.x + 12, b.y + b.h - 12, q.gsi ? 'цена: каждое сообщение пишем дважды' : 'чтобы найти несколько сообщений', 'xn-ms');
          return s + '</g>';
        }
        s += T(b.x + 12, b.y + 20, `ПАРТИЦИЯ chat_id = ${c.id}`, 'xr-m acc') + T(b.x + 12, b.y + 38, `«${ES(cut(c.name, 18))}» · ${c.hot && S.scn === 'hot' ? '2,1 ГБ, 38 млн строк' : 'новые сверху'}`, 'xr-s' + (c.hot && S.scn === 'hot' ? ' xn-bad' : ''));
        const rows = c.rows.slice().reverse().slice(0, 6);
        rows.forEach((r, j) => {
          const y = b.y + 62 + j * 36, fl = r.t0 && S.t - r.t0 < 900;
          if (fl) s += R(b.x + 6, y - 13, b.w - 12, 34, 'xn-krow', 5);
          s += T(b.x + 12, y, `${hms(r.ts)} · ${ES(r.a)}`, 'xn-fn sm' + (fl ? ' xn-acc' : '')) + T(b.x + 12, y + 16, ES(cut(r.x, 30)), 'xn-val');
        });
        s += T(b.x + 12, b.y + b.h - 12, `message_id: ${tuuid(rows[0] ? rows[0].ts : T0).slice(0, 18)}…`, 'xn-ms');
        return s + '</g>';
      }
      function nodePanel() {
        const b = NODE, c = S.cur, i = (c.reps.find(k => !S.nodes[k].dead) != null ? c.reps.find(k => !S.nodes[k].dead) : 0), nd = S.nodes[i];
        let s = `<g class="xr-part" data-xpart="lsm">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, `УЗЕЛ n${i + 1} · ПУТЬ ЗАПИСИ`, 'xr-m') + `<rect x="${b.x + b.w - 22}" y="${b.y + 10}" width="10" height="10" rx="2" style="fill:${col(i)}"/>`;
        s += T(b.x + 12, b.y + 42, 'commit log — дописываем в конец', 'xr-s');
        for (let k = 0; k < 18; k++) s += R(b.x + 12 + k * 11.5, b.y + 50, 9, 12, 'xn-cl' + (k >= 18 - Math.min(18, nd.cl % 19) ? ' on' : ''), 2);
        s += T(b.x + 12, b.y + 82, `memtable в памяти: ${Math.round(clamp(nd.mem, 0, 1) * 100)} %`, 'xr-s') + R(b.x + 12, b.y + 90, b.w - 24, 9, 'xr-bar', 4) + R(b.x + 12, b.y + 90, (b.w - 24) * clamp(nd.mem, 0, 1), 9, 'xr-bar-f' + (nd.mem > 0.85 ? ' warn' : ''), 4);
        s += T(b.x + 12, b.y + 120, `SSTable на диске: ${nd.sst}`, 'xr-s');
        for (let k = 0; k < nd.sst; k++) s += R(b.x + 12 + k * 22, b.y + 128, 18, 18, 'xn-sst' + (k === nd.sst - 1 && S.t - nd.flushT < 900 ? ' fl' : S.t - nd.cmpT < 900 && k === 0 ? ' cmp' : ''), 3);
        s += T(b.x + 12, b.y + 168, S.t - nd.flushT < 1400 ? 'memtable сброшена в новый SSTable' : S.t - nd.cmpT < 1400 ? 'компакция: 4 файла → 1' : 'файлы не меняются, только новые', 'xr-s' + (S.t - nd.flushT < 1400 || S.t - nd.cmpT < 1400 ? ' xn-acc' : ''));
        s += T(b.x + 12, b.y + 186, 'клик — разобрать путь записи ›', 'xr-s xn-go');
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const wc = SD.kindColor('write'), rc = SD.kindColor('read'), from = [SRC.x + SRC.w, SRC.y + 56];
        S.reqs.forEach(q => {
          const cc = q.k === 'w' ? wc : rc, co = nodeXY(q.coord);
          if (q.ph === 'go') s += Dot(...lerp(from, co, ease((S.t - q.p0) / q.dur)), 6, '', `fill:${cc}`);
          if (q.ph === 'fan' || q.ph === 'back' || q.ph === 'tail') q.acks.forEach(a => {
            const to = nodeXY(a.i);
            if (S.t < a.sendAt) { const k = (S.t - q.t1) / (a.sendAt - q.t1); s += Ln(co[0], co[1], to[0], to[1], 'xn-fanl') + Dot(...lerp(co, to, ease(k)), 4.2, '', `fill:${q.k === 'scan' ? 'var(--warn)' : cc}`); }
            else if (!a.dead && S.t < a.done) s += `<circle class="xn-proc" cx="${f1(to[0])}" cy="${f1(to[1])}" r="${nodeR() + 3}"/>`;
            else if (!a.dead && S.t < a.ackAt) { const k = (S.t - a.done) / (a.ackAt - a.done); s += Dot(...lerp(to, co, ease(k)), 4, 'ok'); }
            if (a.dead && S.t >= a.sendAt && S.t - a.sendAt < 800) s += T(to[0], to[1] - nodeR() - 4, 'нет ответа', 'xr-pop bad', 'middle');
          });
          if (q.ph === 'back') s += Dot(...lerp(co, from, ease((S.t - q.p0) / q.dur)), 6, q.res === 'fail' || q.stale ? 'err' : 'ok');
        });
        S.hintDots.forEach(h => { if (S.t < h.t0) return; const k = (S.t - h.t0) / h.d; if (k <= 1) s += Dot(...lerp(nodeXY(h.from), nodeXY(h.to), ease(k)), 4, '', 'fill:var(--k-job)'); });
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() {
        gSt.innerHTML = badges() + srcBox() + keyPanel() + replPanel() + ringSvg() + partPanel() + nodePanel();
        gDy.innerHTML = dynSvg();
      }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xn-backb', 13)}${T(68, 27, '← вся база', 'xr-s xn-back', 'middle')}</g>` + T(140, 27, t, 'xn-vt') + T(140, 46, sub, 'xr-s');
      function vRing() {
        const C = 9000, u = S.vt % C, n0 = S.nodes.length, add = u > 3500, n = add ? n0 + 1 : n0;
        const toks = add ? buildRing(n, vnOf(n0)) : S.toks, old = S.toks, cx = 330, cy = 300, r = 170;
        const XY = (p, rr) => { const a = -Math.PI / 2 + p * 2 * Math.PI; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; };
        let s = head('Кольцо токенов и виртуальные узлы', `ключ → хеш → точка на кольце; ${n0} ${pl(n0, 'узел', 'узла', 'узлов')}, у каждого несколько участков`);
        let moved = 0;
        toks.forEach((t, k) => {
          const p0 = toks[(k - 1 + toks.length) % toks.length].p, p1 = t.p, a1 = p1 < p0 ? p1 + 1 : p1, mid = ((p0 + a1) / 2) % 1;
          const prevOwner = old[owner(old, mid)].node, ch = add && prevOwner !== t.node;
          if (ch) moved += a1 - p0;
          const [x0, y0] = XY(p0, r), [x1, y1] = XY(a1, r);
          s += `<path class="xn-arc big${ch && u < 6500 ? ' moved' : ''}" d="M${f1(x0)},${f1(y0)} A${r},${r} 0 ${a1 - p0 > 0.5 ? 1 : 0} 1 ${f1(x1)},${f1(y1)}" style="stroke:${col(t.node)}"/>`;
        });
        for (let i = 0; i < n; i++) { const x = 600, y = 92 + i * Math.min(26, 360 / n); s += `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" style="fill:${col(i)}"/>` + T(x + 20, y, `n${i + 1}${add && i === n - 1 ? ' — новый узел' : ''}`, 'xn-fn' + (add && i === n - 1 ? ' xn-acc' : '')) + T(x + 130, y, `${toks.filter(t => t.node === i).length} ${pl(toks.filter(t => t.node === i).length, 'участок', 'участка', 'участков')}`, 'xn-ms'); }
        S.chats.slice(0, 3).forEach((c, j) => {
          const [tx, ty] = XY(c.tok, r - 22), [ox, oy] = XY(c.tok, r + 26), reps = replicas(toks, c.tok, RF());
          s += Ln(tx, ty, ox, oy, 'xn-tokl') + T(ox + (ox > cx ? 6 : -6), oy + 4, `${c.id} → ${reps.map(i => 'n' + (i + 1)).join(', ')}`, 'xn-fn sm', ox > cx ? '' : 'end');
        });
        s += T(cx, cy - 6, 'Murmur3', 'xn-fn', 'middle') + T(cx, cy + 12, '−2⁶³ … 2⁶³ − 1', 'xn-ms', 'middle');
        if (add) { S.pv.ringAdd = 1; s += T(600, 470, `добавили n${n}: к нему переехало ≈ ${Math.round(moved * 100)} % кольца`, 'xr-s xn-acc') + T(600, 490, `(в идеале 1/${n} ≈ ${Math.round(100 / n)} %) — остальное на месте`, 'xn-ms'); }
        else s += T(600, 470, 'через пару секунд добавим ещё один узел —', 'xr-s') + T(600, 490, 'смотри, какие участки он заберёт', 'xn-ms');
        s += T(30, 530, 'Подписи снаружи: ключ партиции (chat_id) → реплики по часовой стрелке. Без виртуальных узлов новый сосед забрал бы половину у одного узла.', 'xn-ms');
        return s;
      }
      function vKey() {
        const C = 12000, u = S.vt % C, ph = u < 4000 ? 0 : u < 8000 ? 1 : 2;
        let s = head('Ключ партиции и ключ сортировки', 'где лежат данные и в каком порядке — решает первичный ключ');
        s += R(24, 60, 470, 160, 'xn-codebg', 10);
        ['CREATE TABLE chat.messages (', '  chat_id    bigint,', '  message_id timeuuid,', '  author     text,', '  text       text,', '  created_at timestamp,', '  PRIMARY KEY ((chat_id), message_id)', ') WITH CLUSTERING ORDER BY (message_id DESC);'].forEach((l, j) => { s += CODE(36, 80 + j * 17, l, 'sm' + (j === 6 ? ' hlt' : '')); });
        s += R(506, 60, 470, 160, 'xn-panel', 10) + T(518, 80, 'timeuuid: время внутри идентификатора', 'xr-m');
        s += MONO(518, 106, 'e4b8c2a0-6f9d-11f1-8a2b-0242ac120002', 'on') + T(518, 128, 'e4b8c2a0-6f9d-11f1 — время (100-нс тики с 1582 года)', 'xn-ms') + T(518, 146, '8a2b — счётчик, 0242ac120002 — узел-автор', 'xn-ms') + T(518, 172, 'уникален без координации между серверами', 'xr-s') + T(518, 190, 'и сортируется по времени — свежие сверху', 'xr-s');
        const parts = S.chats.slice(0, 3);
        parts.forEach((c, j) => {
          const x = 24 + j * 320, y = 236, sel = c.id === 7001;
          s += R(x, y, 308, 196, 'xn-panel' + (sel && ph < 2 ? ' on' : ''), 10) + T(x + 12, y + 20, `партиция ${c.id}`, 'xr-m' + (sel ? ' acc' : '')) + T(x + 296, y + 20, c.reps.map(i => 'n' + (i + 1)).join(' · '), 'xn-ms', 'end');
          const rows = c.msgs.slice().reverse();
          rows.forEach((m, k) => {
            const yy = y + 44 + k * 28, hit = sel && ((ph === 0 && k < 3) || (ph === 1 && k >= 1 && k < 4));
            if (hit) s += R(x + 6, yy - 14, 296, 24, 'xn-krow', 4);
            s += T(x + 12, yy, hms(T0 - k * 41), 'xn-fn sm') + T(x + 80, yy, ES(cut(m[0], 9)), 'xn-val') + T(x + 150, yy, ES(cut(m[1], 22)), 'xn-val');
          });
        });
        const Q = [['SELECT * FROM messages WHERE chat_id = 7001 LIMIT 3;', 'один узел, первые 3 строки партиции — свежие', 'ok'], ["SELECT * FROM messages WHERE chat_id = 7001 AND message_id < maxTimeuuid('2026-07-14 12:30');", 'срез внутри партиции по ключу сортировки', 'ok'], ["SELECT * FROM messages WHERE created_at > '2026-07-14';", 'нет ключа партиции → InvalidRequest: ALLOW FILTERING', 'bad']];
        s += R(24, 444, 952, 104, 'xn-codebg', 10);
        Q.forEach(([q, d, c], j) => { const on = j === ph; s += CODE(36, 466 + j * 30, q, 'sm' + (on ? '' : ' dim')) + T(964, 480 + j * 30, d, 'xn-ms' + (on ? (c === 'ok' ? ' xn-ok' : ' xn-bad') : ''), 'end'); });
        return s;
      }
      function vRepl() {
        const C = 10000, u = S.vt % C, combos = [[1, 1], [2, 2], [3, 1], [3, 3]], n = need(), cur = [n, n], k = u / C;
        let s = head('Реплики и уровни согласованности', `N = RF = ${RF()} копии; W — сколько ждём на записи, R — на чтении. Сейчас W = R = ${CL().toUpperCase()}`);
        combos.forEach(([w, r], j) => {
          const x = 24 + j * 240, y = 64, ok = w + r > 3, isCur = w === cur[0] && r === cur[1];
          s += R(x, y, 228, 300, 'xn-panel' + (isCur ? ' on' : ''), 10) + T(x + 12, y + 22, `W = ${w}, R = ${r}`, 'xr-t') + T(x + 216, y + 22, isCur ? 'как в настройке' : '', 'xn-ms xn-acc', 'end');
          for (let i = 0; i < 3; i++) {
            const yy = y + 48 + i * 58, wrote = i < w, lag = !wrote && k > 0.55, read = (ok ? i >= 3 - r : i >= 3 - r);
            s += R(x + 14, yy, 200, 46, 'xn-rep' + (wrote ? ' w' : '') + (read && k > 0.35 ? ' r' : ''), 8) + T(x + 24, yy + 18, `реплика ${i + 1}`, 'xn-fn');
            s += T(x + 24, yy + 36, wrote ? 'новое: «Тогда молоко»' : lag ? 'догоняет…' : 'старое: без сообщения', 'xn-ms' + (wrote ? ' xn-ok' : ''));
            if (read && k > 0.35) s += T(x + 204, yy + 18, 'читаем', 'xn-ms xn-acc', 'end');
          }
          s += T(x + 12, y + 234, `${w} + ${r} = ${w + r} ${ok ? '> 3' : '≤ 3'}`, 'xn-big ' + (ok ? 'xn-ok' : 'xn-bad'));
          s += T(x + 12, y + 256, ok ? 'множества пересекаются —' : 'можно прочитать только', 'xr-s') + T(x + 12, y + 274, ok ? 'свежая копия попадёт в ответ' : 'реплики со старым', 'xr-s ' + (ok ? 'xn-ok' : 'xn-bad'));
        });
        s += R(24, 376, 952, 172, 'xn-panel', 10) + T(36, 398, 'ЧТО ЕЩЁ ПРОИСХОДИТ', 'xr-m');
        [['Hinted handoff', 'реплика лежит — координатор хранит её записи и передаст, когда она вернётся'], ['Read repair', 'чтение заметило старую копию — тут же дописывает ей свежую версию'], ['Anti-entropy repair', 'nodetool repair раз в неделю сверяет реплики по деревьям Меркла'], ['Last write wins', 'конфликты решает время записи: побеждает более поздняя метка'], ['Цена', `запись ×${RF()} по диску и сети; ALL ждёт самую медленную реплику`]].forEach(([a, b2], j) => { s += T(36, 424 + j * 24, a, 'xr-m') + T(220, 424 + j * 24, b2, 'xr-s'); });
        return s;
      }
      function lsmTick(dt) {
        const pv = S.pv.lsm || (S.pv.lsm = { log: [], mem: [], sst: [{ n: 41, k: 4 }, { n: 42, k: 4 }, { n: 43, k: 3 }], at: 300, seq: 0, flushT: -1e9, cmpT: -1e9, t: 0, flushes: 0 });
        pv.t += dt;
        while (pv.t >= pv.at) {
          pv.at += 520; pv.seq++;
          const c = S.chats[pv.seq % S.chats.length], m = c.msgs[pv.seq % c.msgs.length];
          const e = { key: `${c.id}:${hms(T0 + pv.seq * 3)}`, a: m[0], t0: pv.t, del: pv.seq % 9 === 0 };
          pv.log.push(e); if (pv.log.length > 9) pv.log.shift();
          pv.mem.push(e); pv.mem.sort((a, b) => a.key < b.key ? -1 : 1);
          if (pv.mem.length >= 7) { pv.sst.push({ n: 44 + pv.flushes, k: pv.mem.length, t0: pv.t }); pv.mem = []; pv.flushT = pv.t; pv.flushes++; S.flags.flush = 1; }
          if (pv.sst.length >= 6) { const take = pv.sst.splice(0, 4); pv.sst.unshift({ n: take[0].n, k: take.reduce((s2, x) => s2 + x.k, 0) - 2, big: true, t0: pv.t }); pv.cmpT = pv.t; }
        }
      }
      function vLsm() {
        const pv = S.pv.lsm; if (!pv) return head('Путь записи (LSM)', '…');
        let s = head('Путь записи: commit log → memtable → SSTable → компакция', 'запись никогда не правит файлы на месте — только дописывает и потом переписывает целиком');
        s += R(24, 60, 300, 300, 'xn-panel', 10) + T(36, 80, '1. COMMIT LOG (диск, в конец)', 'xr-m');
        pv.log.slice().reverse().forEach((e, j) => { const fl = pv.t - e.t0 < 500; s += R(36, 94 + j * 28, 276, 22, 'xn-log' + (fl ? ' on' : ''), 4) + MONO(44, 109 + j * 28, `${e.del ? 'DEL' : 'PUT'} ${e.key}`, fl ? 'on' : '') + T(304, 109 + j * 28, ES(cut(e.a, 8)), 'xn-ms', 'end'); });
        s += arrow(326, 210, 352, 210, 'acc');
        s += R(356, 60, 300, 300, 'xn-panel', 10) + T(368, 80, '2. MEMTABLE (память, отсортирована)', 'xr-m');
        pv.mem.forEach((e, j) => { s += R(368, 94 + j * 28, 276, 22, 'xn-log' + (e.del ? ' del' : ''), 4) + MONO(376, 109 + j * 28, `${e.key}`) + T(636, 109 + j * 28, e.del ? 'tombstone' : ES(cut(e.a, 8)), 'xn-ms' + (e.del ? ' xn-bad' : ''), 'end'); });
        s += T(368, 300, `заполнено ${pv.mem.length} из 7 — потом сброс на диск`, 'xr-s') + R(368, 310, 276, 10, 'xr-bar', 4) + R(368, 310, 276 * pv.mem.length / 7, 10, 'xr-bar-f' + (pv.mem.length >= 6 ? ' warn' : ''), 4);
        if (pv.t - pv.flushT < 900) s += T(512, 344, 'сброс: memtable → новый SSTable', 'xr-pop ok', 'middle');
        s += arrow(658, 210, 684, 210, 'acc');
        s += R(688, 60, 288, 300, 'xn-panel', 10) + T(700, 80, '3. SSTABLE (диск, неизменяемые)', 'xr-m');
        pv.sst.forEach((f, j) => { const fl = pv.t - (f.t0 || -1e9) < 900, y = 94 + j * 42; s += R(700, y, 264, 34, 'xn-sstf' + (f.big ? ' big' : '') + (fl ? ' fl' : ''), 6) + T(710, y + 15, `nb-${f.n}-big-Data.db`, 'xn-fn sm') + T(710, y + 29, `${f.k * 1000} строк · фильтр Блума, индекс`, 'xn-ms'); });
        if (pv.t - pv.cmpT < 1100) s += T(832, 350, 'компакция: 4 файла → 1', 'xr-pop warn', 'middle');
        s += R(24, 372, 952, 176, 'xn-panel', 10) + T(36, 394, 'ЧТЕНИЕ: SELECT … WHERE chat_id = 7001', 'xr-m');
        [['memtable', 'сначала свежие данные в памяти'], ['фильтр Блума', 'у каждого SSTable: «ключа 7001 тут точно нет» — файл не открываем'], ['SSTable', 'читаем только файлы, где ключ может быть; индекс → смещение'], ['слияние', 'версии одной строки из разных файлов: побеждает поздняя метка времени'], ['поэтому', 'запись — один дописанный байт, чтение — несколько файлов; компакция держит их число малым']].forEach(([a, b2], j) => { s += T(36, 420 + j * 24, a, 'xr-m') + T(180, 420 + j * 24, b2, 'xr-s'); });
        return s;
      }
      function vTtl() {
        const C = 14000, u = S.vt % C, day = clamp(u / 11000 * 14, 0, 14);
        let s = head('TTL и tombstones', 'удалить строку в неизменяемом файле нельзя — пишем метку удаления и ждём компакцию');
        const X = d => 120 + d * 58;
        s += Ln(X(0), 130, X(14), 130, 'xn-axis');
        for (let d = 0; d <= 14; d += 2) s += T(X(d), 152, d === 0 ? 'сегодня' : `+${d} дн`, 'xn-ms', 'middle');
        s += `<polygon class="xn-cur" points="${f1(X(day) - 6)},${118} ${f1(X(day) + 6)},118 ${f1(X(day))},126"/>`;
        const ev = [[0, 'INSERT … USING TTL 604800', 'строка живёт 7 дней', ''], [1, "DELETE … WHERE message_id = …", 'надгробие (tombstone)', 'bad'], [7, 'TTL истёк', 'строка стала надгробием', 'warn'], [11, 'gc_grace (10 дней) прошёл', 'компакция может выбросить', 'ok']];
        ev.forEach(([d, a, b2, c], j) => { const on = day >= d, an = j === 0 ? '' : 'middle', ax = j === 0 ? X(d) - 12 : X(d); s += `<circle class="xn-ev ${on ? c || 'on' : ''}" cx="${X(d)}" cy="130" r="7"/>` + T(ax, j % 2 ? 76 : 98, ES(a), 'xn-fn sm' + (on ? '' : ' dim'), an) + T(ax, 176 + (j % 2) * 16, b2, 'xn-ms', an); });
        // партиция с надгробиями
        s += R(24, 214, 600, 200, 'xn-panel', 10) + T(36, 236, 'ПАРТИЦИЯ chat_id = 42 при чтении', 'xr-m');
        const tomb = Math.round(clamp(day / 11, 0, 1) * 60), alive = 6;
        for (let j = 0; j < 72; j++) { const isT = j % 12 !== 0 && j < tomb + Math.floor(j / 12) + 1, x = 36 + (j % 24) * 24, y = 250 + Math.floor(j / 24) * 34; s += R(x, y, 20, 26, 'xn-cellt' + (j % 12 === 0 ? ' live' : isT ? ' tomb' : ''), 3); }
        s += T(36, 370, `живых строк ${alive}, надгробий ${tomb} — чтение пролистывает всё`, 'xr-s' + (tomb > 40 ? ' xn-warn' : ''));
        s += T(36, 392, day >= 11 ? 'компакция после gc_grace выбросила надгробия' : 'компакция их пока не трогает: ждём gc_grace', 'xn-ms' + (day >= 11 ? ' xn-ok' : ''));
        s += R(640, 214, 336, 200, 'xn-codebg', 10);
        ['-- сообщения живут неделю', "INSERT INTO messages (chat_id, message_id, text)", "VALUES (42, now(), 'ГОООЛ!') USING TTL 604800;", '', '-- таблица целиком:', 'ALTER TABLE messages WITH', '  default_time_to_live = 604800', '  AND gc_grace_seconds = 864000;'].forEach((l, j) => { s += CODE(652, 236 + j * 20, l, 'sm'); });
        s += R(24, 426, 952, 122, 'xn-panel', 10) + T(36, 448, 'ЗАЧЕМ ЖДАТЬ 10 ДНЕЙ', 'xr-m');
        s += T(36, 472, 'Реплика n3 лежала, пока сообщение удаляли. Если остальные выбросят надгробие раньше, чем n3 вернётся,', 'xr-s');
        s += T(36, 492, 'то при ремонте n3 покажет «живую» старую строку — и удалённое сообщение воскреснет («зомби»).', 'xr-s xn-bad');
        s += T(36, 516, 'Поэтому надгробия ждут gc_grace_seconds, а ремонт (repair) обязан проходить чаще этого срока.', 'xn-ms');
        s += T(36, 536, 'Чтение партиции с 100 000 надгробий Cassandra прерывает: TombstoneOverwhelmingException.', 'xn-ms');
        return s;
      }
      function vHot() {
        const C = 11000, u = S.vt % C, fix = u > 5500;
        let s = head('Горячая партиция', fix ? 'после бакетов: ключ ((chat_id, bucket)) раскладывает большой чат по многим узлам' : 'чат 42 — одна партиция на трёх узлах, и туда идёт 72 % всех запросов');
        const sizes = [['7001', 0.04], ['1550', 0.03], ['9310', 0.02], ['42', 0.72], ['8810', 0.05], ['3125', 0.04], ['5007', 0.06], ['2290', 0.04]];
        s += R(24, 60, 470, 300, 'xn-panel', 10) + T(36, 82, fix ? 'ПАРТИЦИИ ПОСЛЕ БАКЕТОВ (доля запросов)' : 'ПАРТИЦИИ (доля запросов)', 'xr-m');
        const items = fix ? sizes.flatMap(([id, v]) => id === '42' ? Array.from({ length: 8 }, (_, b) => [`42:${b}`, v / 8]) : [[id, v]]) : sizes;
        const bw = Math.min(46, 420 / items.length - 4);
        items.forEach(([id, v], j) => { const h = 220 * v / 0.72, x = 40 + j * (bw + 4), hot = v > 0.2; s += R(x, 320 - h, bw, Math.max(2, h), 'xn-pbar' + (hot ? ' hot' : String(id).startsWith('42:') ? ' sp' : ''), 3) + (bw > 26 || j % 2 === 0 ? T(x + bw / 2, 340, id, 'xn-ms', 'middle') : ''); });
        const n = S.nodes.length;
        s += R(506, 60, 470, 300, 'xn-panel', 10) + T(518, 82, `ЗАГРУЗКА УЗЛОВ (${n})`, 'xr-m');
        const hotReps = S.chats[1].reps;
        for (let i = 0; i < Math.min(n, 12); i++) {
          const v = fix ? 1 / n : hotReps.includes(i) ? 0.72 / hotReps.length + 0.28 / n : 0.28 / n, y = 100 + i * Math.min(20, 240 / Math.min(n, 12)), over = v > 0.2;
          s += T(518, y + 10, 'n' + (i + 1), 'xn-fn') + R(560, y, 380, 12, 'xr-bar', 3) + R(560, y, 380 * clamp(v / 0.3, 0, 1), 12, 'xr-bar-f' + (over ? ' bad' : ''), 3);
        }
        s += T(518, 346, fix ? 'нагрузка разошлась по всем узлам' : `добавь узлы — красные три так и останутся красными`, 'xr-s ' + (fix ? 'xn-ok' : 'xn-bad'));
        s += R(24, 372, 952, 176, 'xn-codebg', 10);
        const L = fix ? ['-- ключ партиции из двух полей: чат и бакет', 'CREATE TABLE messages_v2 (', '  chat_id bigint, bucket int, message_id timeuuid, …', '  PRIMARY KEY ((chat_id, bucket), message_id));', '-- bucket = день сообщения (или hash(message_id) % 8)', '-- чтение истории: сначала текущий бакет, если мало — предыдущий'] : ['PRIMARY KEY ((chat_id), message_id)', '-- все сообщения чата 42 — одна партиция:', '--   2,1 ГБ, 38 млн строк, 3 реплики', '-- рекомендация: партиция до ≈ 100 МБ и 100 тыс. строк', '-- компакция и ремонт такой партиции — часы,', '-- а три её узла тонут в запросах'];
        L.forEach((l, j) => { s += CODE(36, 396 + j * 22, l, 'sm'); });
        return s;
      }
      function vScatter() {
        const C = 9000, u = S.vt % C, k = clamp((u - 400) / 5000, 0, 1), n = S.nodes.length, gsi = !!P().gsi;
        let s = head('Запрос не по ключу', "все сообщения автора «Аня»: ключ партиции — chat_id, а не author");
        const lane = (x, title, on, nodes, slow, msg, cls) => {
          let t = R(x, 60, 466, 330, 'xn-panel' + (on ? ' on' : ''), 10) + T(x + 14, 82, title, 'xr-t');
          const co = [x + 233, 140];
          t += `<circle class="xn-node rep" cx="${co[0]}" cy="${co[1]}" r="18" style="stroke:var(--accent)"/>` + T(co[0], co[1] + 4, 'коорд.', 'xn-ms', 'middle');
          nodes.forEach((i, j) => {
            const a = Math.PI * (0.15 + 0.7 * j / Math.max(1, nodes.length - 1)), p = [co[0] - 170 * Math.cos(a), co[1] + 70 + 130 * Math.sin(a)], kk = clamp(k * (slow ? 1 : 2.4) - j * 0.02, 0, 1);
            t += Ln(co[0], co[1], p[0], p[1], 'xn-fanl') + `<circle class="xn-node${kk >= 1 ? ' rep' : ''}" cx="${f1(p[0])}" cy="${f1(p[1])}" r="12" style="stroke:${col(i)}"/>` + T(p[0], p[1] + 4, 'n' + (i + 1), 'xn-ms', 'middle');
            if (kk > 0 && kk < 1) t += Dot(...lerp(co, p, kk < 0.5 ? kk * 2 : 2 - kk * 2), 4, kk < 0.5 ? '' : 'ok', kk < 0.5 ? 'fill:var(--warn)' : '');
          });
          return t + T(x + 14, 360, msg, 'xr-s ' + cls) + T(x + 14, 380, slow ? `узлов опрошено: ${n} · ответ ждёт самого медленного` : 'узлов опрошено: 3 реплики одной партиции', 'xn-ms');
        };
        s += lane(24, 'Без таблицы: ALLOW FILTERING', !gsi, S.nodes.slice(0, Math.min(n, 12)).map(nd => nd.i), true, `каждый узел перебирает все партиции: ≈ ${nf(n * 3.2, 1)} млн строк`, 'xn-bad');
        s += lane(510, 'Таблица messages_by_author', gsi, replicas(S.toks, fnv('author:Аня'), RF()), false, 'одна партиция author = \'Аня\'', 'xn-ok');
        s += R(24, 402, 952, 146, 'xn-codebg', 10);
        ["CREATE TABLE messages_by_author (author text, message_id timeuuid, chat_id bigint, text text,", '  PRIMARY KEY ((author), message_id)) WITH CLUSTERING ORDER BY (message_id DESC);', "-- отправка сообщения пишет в обе таблицы:", "BEGIN BATCH INSERT INTO messages …; INSERT INTO messages_by_author …; APPLY BATCH;", '-- JOIN нет: «сообщения + профиль автора» — два запроса по ключу или профиль, скопированный в строку'].forEach((l, j) => { s += CODE(36, 426 + j * 22, l, 'sm'); });
        return s;
      }
      function vModel() {
        const m = P().model || 'wide';
        let s = head('Таблица под запрос', `сначала список запросов, потом таблицы · модель: ${{ wide: 'wide-column (Cassandra)', doc: 'документы (MongoDB)', kv: 'ключ-значение (DynamoDB)' }[m]}`);
        const Q = [['Q1', 'последние 50 сообщений чата'], ['Q2', 'все сообщения автора'], ['Q3', 'непрочитанные по чатам']];
        s += R(24, 60, 300, 488, 'xn-panel', 10) + T(36, 82, 'ЗАПРОСЫ ПРИЛОЖЕНИЯ', 'xr-m');
        const hi = Math.floor(S.vt / 2500) % 3;
        Q.forEach(([a, b2], j) => { const y = 108 + j * 80; s += R(36, y - 18, 276, 62, 'xn-qbox' + (j === hi ? ' on' : ''), 8) + T(48, y + 2, a, 'xr-m acc') + T(48, y + 22, b2, 'xr-s'); });
        s += T(36, 370, 'Правило: один запрос — одна', 'xr-s') + T(36, 388, 'партиция. Данные копируются в', 'xr-s') + T(36, 406, 'несколько таблиц, и это нормально:', 'xr-s') + T(36, 424, 'место дешёвое, чтение — главное.', 'xr-s');
        s += R(336, 60, 640, 488, 'xn-codebg', 10);
        let L;
        if (m === 'doc') L = ['// MongoDB: документ сообщения, реакции внутри', '{ "_id": ObjectId("66a3f1…"),', '  "chat_id": 7001, "author": "Аня",', '  "text": "Тогда молоко", "created_at": ISODate("2026-07-14T12:31:07Z"),', '  "reactions": [{ "user": "Мама", "type": "like" }] }', '', '// Q1: индекс под запрос', 'db.messages.createIndex({ chat_id: 1, created_at: -1 })', '// Q2: второй индекс — база ведёт его сама, запись дороже', 'db.messages.createIndex({ author: 1, created_at: -1 })', '// Q3: отдельная коллекция счётчиков', 'db.unread.updateOne({ user: 55120, chat: 7001 }, { $inc: { n: 1 } })'];
        else if (m === 'kv') L = ['// DynamoDB: одна таблица, ключи PK и SK', 'PK = CHAT#7001     SK = MSG#2026-07-14T12:31:07#e4b8   text, author', 'PK = CHAT#7001     SK = MSG#2026-07-14T12:30:41#d1a0   text, author', 'PK = USER#55120    SK = UNREAD#CHAT#7001               n = 3', 'PK = USER#55120    SK = PROFILE                       name, avatar', '', '// Q1: Query PK = CHAT#7001, SK begins_with MSG#, ScanIndexForward = false', '// Q2: GSI1 — GSI1PK = AUTHOR#Аня, GSI1SK = время', '// Q3: Query PK = USER#55120, SK begins_with UNREAD#', '// диапазон без ключа — только Scan всей таблицы: дорого', '// одна таблица на всё приложение: single-table design'];
        else L = ['-- Q1', 'CREATE TABLE messages_by_chat (chat_id bigint, message_id timeuuid,', '  author text, text text, PRIMARY KEY ((chat_id), message_id))', '  WITH CLUSTERING ORDER BY (message_id DESC);', '-- Q2', 'CREATE TABLE messages_by_author (author text, message_id timeuuid,', '  chat_id bigint, text text, PRIMARY KEY ((author), message_id));', '-- Q3', 'CREATE TABLE unread_by_user (user_id bigint, chat_id bigint,', '  unread counter, PRIMARY KEY ((user_id), chat_id));', '-- отправка: INSERT в обе таблицы + UPDATE unread = unread + 1'];
        L.forEach((l, j) => { const on = (hi === 0 && /Q1|chat_id: 1|CHAT#7001/.test(l)) || (hi === 1 && /Q2|author|AUTHOR/.test(l)) || (hi === 2 && /Q3|unread|UNREAD/.test(l)); s += CODE(348, 86 + j * 22, l, 'sm' + (on ? ' hlt' : '')); });
        s += T(348, 520, P().gsi ? 'Настройка «таблица под запрос» включена: Q2 читает одну партицию.' : 'Настройка «таблица под запрос» выключена: Q2 перебирает весь кластер.', 'xr-s ' + (P().gsi ? 'xn-ok' : 'xn-warn'));
        return s;
      }
      const VIEWS = { ring: vRing, key: vKey, repl: vRepl, lsm: vLsm, ttl: vTtl, hot: vHot, scatter: vScatter, model: vModel };
      function partNow(k) {
        if (k === 'ring') return `<b>Кольцо:</b> ${S.toks.length} участков у ${S.nodes.length} ${pl(S.nodes.length, 'узла', 'узлов', 'узлов')}. Ключ хешируется в точку, копии лежат у владельца участка и следующих по кругу. Новый узел забирает понемногу у всех — переезжает ≈ 1/N данных.`;
        if (k === 'key') return '<b>Первичный ключ</b> ((chat_id), message_id): chat_id выбирает узлы, message_id — порядок внутри партиции. Последние сообщения чата — один последовательный кусок на одном узле.';
        if (k === 'repl') return `<b>Сейчас W = R = ${CL().toUpperCase()}:</b> ждём ${need()} из ${RF()}. ${need() * 2 > RF() ? 'R + W > N — свежее значение всегда в ответе.' : 'R + W ≤ N — можно прочитать старое.'}`;
        if (k === 'lsm') return '<b>Путь записи:</b> commit log и memtable — сразу, сброс в SSTable — когда память заполнилась, компакция — в фоне. Файлы на диске никогда не меняются.';
        if (k === 'ttl') return '<b>Удаление — это запись:</b> tombstone с меткой времени. Истёкший TTL тоже становится надгробием. Компакция выбросит их только после gc_grace_seconds, иначе удалённое воскреснет.';
        if (k === 'hot') return '<b>Горячая партиция</b> живёт на трёх узлах, и новые узлы ей не помогают. Лечится ключом: ((chat_id, bucket)) раскладывает большой чат на много партиций.';
        if (k === 'scatter') return P().gsi ? '<b>Таблица под запрос включена:</b> сообщения автора — одна партиция, как обычное чтение по ключу.' : `<b>Без таблицы</b> запрос по автору опрашивает все ${S.nodes.length} ${pl(S.nodes.length, 'узел', 'узла', 'узлов')} и перебирает все партиции.`;
        if (k === 'model') return '<b>Сначала запросы, потом таблицы.</b> Под каждый запрос — таблица с подходящим ключом партиции. Данные повторяются, зато каждое чтение — одна партиция.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.nodes) return;
        S.t += dt; S.cfgT += dt; S.wall += dt / 1000;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'lsm') { lsmTick(dt); if (S.flags.flush) done('plsm'); } if (pk === 'ring' && S.pv.ringAdd) done('pring'); }
        const rate = S.scn === 'hot' ? 200 : S.scn === 'scan' ? 700 : S.scn === 'stale' ? 650 : 330;
        while (S.at <= S.t) { S.at += rate * (0.6 + Math.random() * 0.8); if (S.reqs.length < 26) spawn(); }
        downStep();
        S.reqs.forEach(step);
        S.reqs = S.reqs.filter(q => !q.gone);
        if (S.curQ && S.curQ.gone) S.curQ = S.reqs[S.reqs.length - 1] || S.curQ;
        S.nodes.forEach(nd => {
          nd.load = nd.load.filter(t => t > S.t - 2000);
          if (nd.mem >= 1) { nd.mem = 0.08; nd.sst++; nd.flushT = S.t; }
          if (nd.sst >= 7) { nd.sst = 3; nd.cmpT = S.t; }
        });
        S.hintDots = S.hintDots.filter(h => S.t - h.t0 < h.d);
        S.fx = S.fx.filter(f => S.t - f.t0 < 1300);
        S.hist = S.hist.filter(h => h.t > S.t - 10000); S.fails = S.fails.filter(t => t > S.t - 10000); S.stale = S.stale.filter(t => t > S.t - 10000);
        if (S.scn === 'hot') {
          const hotN = S.chats[1].reps, mx = Math.max(...S.nodes.map(nd => nd.load.length));
          if (S.nodes.length >= 6 && S.cfgT > 2500 && hotN.every(i => S.nodes[i].load.length > 6)) done('hot');
          if (mx > 10) note('hotn', `<b>Горячие узлы:</b> ${hotN.map(i => 'n' + (i + 1)).join(', ')} держат партицию чата 42 и получают львиную долю запросов — ответы замедляются, остальные узлы почти простаивают.`, 'warn', 8000);
        }
      }
      function draw() {
        if (!S.nodes) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { if (cfgSig() !== S.cfg) reset(); },
        scenario(id) { S.scn = id; reset(); },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (cfgSig() !== S.cfg) { const fl = S.flags; reset(); S.flags = fl; }
          if (key === 'cl') return v === 'one' ? 'ONE: ответ после первого подтверждения — быстро, но чтение может попасть на отстающую реплику.' : v === 'all' ? 'ALL: ждём все реплики — медленнее всех, и падение одной реплики даёт отказ. Проверь в «Узел упал».' : 'QUORUM: ждём большинство (2 из 3). R + W > N — чтение всегда свежее, падение одной реплики не страшно.';
          if (key === 'rf') return +v === 1 ? 'RF = 1: одна копия. Упал узел — его данные недоступны, согласованность ничего не решает.' : 'RF = 3: три копии на соседних по кольцу узлах.';
          if (key === 'count') return `Узлов ${v}: кольцо перестроилось — у каждого узла свои участки. Данные одного ключа всё равно лежат на ${RF()} ${pl(RF(), 'узле', 'узлах', 'узлах')}.`;
          if (key === 'gsi') return v ? 'Таблица под запрос: в «Запрос не по ключу» поиск по автору пойдёт в одну партицию.' : 'Без таблицы под запрос поиск по автору опрашивает весь кластер.';
          if (key === 'model') return 'Модель данных: открой блок «Таблица под запрос» — там то же самое в выбранной модели.';
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const n = need(), rf = RF();
          if (S.scn === 'hot') return `<b>Горячая партиция:</b> 72 % запросов — в чат стрима 42, а он целиком лежит на ${S.chats[1].reps.map(i => 'n' + (i + 1)).join(', ')}. Эти узлы залиты нагрузкой, остальные ${S.nodes.length - rf} почти простаивают. Добавление узлов не поможет — нужен другой ключ партиции (бакеты по дню).`;
          if (S.scn === 'down') { const d = S.nodes.find(nd => nd.dead); return d ? `<b>Узел n${d.i + 1} лежит.</b> ${CL() === 'all' ? 'ALL требует все три реплики — запросы к чату 7001 получают Unavailable.' : CL() === 'quorum' ? 'QUORUM: две живые реплики из трёх — запросы проходят как обычно.' : 'ONE: хватает одной живой реплики.'} Записи для лежащего узла координаторы копят как подсказки и передадут, когда он вернётся.` : '<b>Все узлы живы.</b> Скоро один из узлов с копией чата 7001 упадёт — смотри, что будет при твоём уровне согласованности.'; }
          if (S.scn === 'stale') return n * 2 > rf ? `<b>R + W > N (${n} + ${n} > ${rf}).</b> Реплика n${S.lagNode + 1} отстаёт на пару секунд, но чтение спрашивает ${n} ${pl(n, 'реплику', 'реплики', 'реплик')} — хотя бы одна уже знает про новое сообщение.` : `<b>ONE + ONE ≤ N.</b> Запись подтвердилась одной репликой, а чтение может попасть на отстающую n${S.lagNode + 1} — и человек не увидит своё же сообщение. Включи QUORUM.`;
          if (S.scn === 'scan') return P().gsi ? '<b>Есть таблица под запрос:</b> messages_by_author с ключом author. Поиск сообщений Ани — обычное чтение одной партиции с трёх реплик.' : `<b>Запрос без ключа партиции:</b> координатор не знает, где сообщения Ани, и рассылает запрос всем ${S.nodes.length} ${pl(S.nodes.length, 'узлу', 'узлам', 'узлам')}. Каждый перебирает все свои партиции. Включи «таблицу под запрос».`;
          return `<b>Запрос → координатор → реплики.</b> Любой узел принимает запрос, по ключу chat_id находит на кольце ${rf} ${pl(rf, 'реплику', 'реплики', 'реплик')} и рассылает им. Ответ клиенту — после ${n} ${pl(n, 'подтверждения', 'подтверждений', 'подтверждений')} (${CL().toUpperCase()}); остальные реплики догоняют в фоне. ${n * 2 > rf ? 'R + W > N — чтение видит свежее.' : 'R + W ≤ N — возможны старые чтения.'}`;
        },
        stats() {
          const ws = S.hist.filter(h => h.k === 'w'), rs = S.hist.filter(h => h.k === 'r'), avg = a => a.length ? a.reduce((s2, h) => s2 + h.ms, 0) / a.length : 0, n = need(), rf = RF();
          return [
            ['Запись', ws.length ? nf(avg(ws), 1) + ' мс' : '…', '', `ждём ${n} из ${rf}`],
            ['Чтение', rs.length ? nf(avg(rs), 1) + ' мс' : '…', '', `спрашиваем ${n} из ${rf}`],
            ['R + W > N', n * 2 > rf ? 'да' : 'нет', n * 2 > rf ? 'ok' : 'warn', `${n} + ${n} vs ${rf}`],
            ['Отказов', String(S.fails.length), S.fails.length ? 'bad' : 'ok', 'Unavailable за 10 с'],
            ['Старых чтений', String(S.stale.length), S.stale.length ? 'bad' : 'ok', 'за 10 с'],
            ['Загрузка', Math.round(Math.min(util(), 9) * 100) + ' %', util() > 1 ? 'bad' : util() > 0.75 ? 'warn' : 'ok', 'как на площадке']
          ];
        },
        destroy() {}
      };
    }
  };
})();
