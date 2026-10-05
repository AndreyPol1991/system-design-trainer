/* «Озеро данных изнутри»: объектное хранилище и пути файлов, JSON против Parquet (колонки и статистика в футере),
   разбивка по дате, мелкие файлы и уплотнение, Iceberg (метаданные, манифесты, снимки, атомарный коммит, схема), слои bronze → silver → gold. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const byt = b => b >= 1e12 ? nf(b / 1e12, b >= 1e13 ? 0 : 1) + ' ТБ' : b >= 1e9 ? nf(b / 1e9, b >= 1e11 ? 0 : 1) + ' ГБ' : b >= 1e6 ? nf(b / 1e6, b >= 1e7 ? 0 : 1) + ' МБ' : b >= 1e3 ? nf(b / 1e3) + ' КБ' : nf(b) + ' Б';
  const tms = ms => ms >= 3.6e6 ? nf(ms / 3.6e6, ms >= 3.6e7 ? 0 : 1) + ' ч' : ms >= 6e4 ? nf(ms / 6e4, ms >= 6e5 ? 0 : 1) + ' мин' : ms >= 1000 ? nf(ms / 1000, ms >= 1e4 ? 0 : 1) + ' с' : nf(ms) + ' мс';
  const usd = v => v >= 100 ? '$' + nf(v) : v >= 1 ? '$' + nf(v, 2) : '$' + nf(v, v >= 0.01 ? 2 : 3);
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
  function arrow(x1, y1, x2, y2, c) {
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
    const a = Math.atan2(y2 - y1, x2 - x1), L = 8, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`;
    return `<line class="xk2-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xk2-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const KW = /^(SELECT|FROM|WHERE|AND|GROUP|BY|ORDER|AS|OF|FOR|TIMESTAMP|DATE|VERSION|ALTER|TABLE|ADD|COLUMN|RENAME|TO|DROP|CALL|CREATE|INSERT|INTO|USING|PARTITIONED|WITH|MERGE|ON|WHEN|MATCHED|THEN|UPDATE|SET|NOT|NULL|IS|DISTINCT|LIMIT)$/;
  const FN = /^(sum|count|max|min|days|rewrite_data_files|rollback_to_snapshot|expire_snapshots|row_number|cast|date)$/;
  const hl = line => line.split(/('[^']*'|\s+|[(),=<>*;]+)/).filter(x => x !== '').map(tk => /^'.*'$/.test(tk) ? `<tspan class="xk2-st">${ES(tk)}</tspan>` : KW.test(tk) ? `<tspan class="xk2-kw">${tk}</tspan>` : FN.test(tk) ? `<tspan class="xk2-fx">${tk}</tspan>` : /^\d[\d.]*$/.test(tk) ? `<tspan class="xk2-nu">${tk}</tspan>` : ES(tk)).join('');
  const SQL = (x, y, line, c) => `<text class="xk2-sql${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${hl(line)}</text>`;
  const MONO = (x, y, t, c, a) => `<text class="xk2-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;

  /* ---------- данные примера: события магазина за начало июля 2026 ---------- */
  const DAYS = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
  const QDAY = 2, TODAY = 4;
  const DAY_EV = 3.46e9, PQ_FILES = 540, JS_FILES = 4050, LAKE_DAYS = 730;
  const ORD = [3291004, 3318260, 3354120, 3402877, 1488310], REVD = [6.11, 6.17, 6.24, 6.33, 2.77];   // заказов и выручка (млрд ₽) за день
  const EV_JSON = ['{"event_id":"e-7f3a91","ts":"2026-07-03T12:31:07Z","user_id":55120,', '  "event_type":"purchase","product_id":3071,"amount":1290.00}',
    '{"event_id":"e-7f3a92","ts":"2026-07-03T12:31:08Z","user_id":80441,', '  "event_type":"view","product_id":118,"amount":null}',
    '{"event_id":"e-7f3a93","ts":"2026-07-03T12:31:09Z","user_id":80441,', '  "event_type":"purchase","product_id":118,"amount":845.50}',
    '{"event_id":"e-7f3a94","ts":"2026-07-03T12:31:15Z","user_id":23878,', '  "event_type":"cart","product_id":9012,"amount":null}'];

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const SRC = { x: 16, y: 52, w: 150, h: 150 }, BZ = { x: 182, y: 46, w: 518, h: 340 }, LBX = 190, FX0 = 336, FXW = 356;
  const RY0 = 82, RH = 52, RG = 6, ICE = { x: 712, y: 46, w: 272, h: 196 }, ENG = { x: 712, y: 250, w: 272, h: 136 };
  const SQB = { x: 16, y: 396, w: 424, h: 156 }, LAY = { x: 452, y: 396, w: 532, h: 156 };
  const rowY = i => RY0 + (TODAY - i) * (RH + RG);   // сегодняшняя папка сверху

  SD.XRAY.lake = {
    viewBox: '0 0 1000 560',
    cta: 'Пути файлов в S3, JSON против Parquet, папки по дате, мелкие файлы, Iceberg со снимками и атомарным коммитом, слои bronze → silver → gold',
    dive: 'etl',
    simple: () => ({
      an: 'Как <b>огромный склад-ангар с коробками</b>: место почти бесплатное, класть можно что угодно и сколько угодно. Но чтобы быстро найти нужное, коробки подписывают, раскладывают по полкам с датами, а у входа держат журнал: что лежит, где и с какого дня.',
      pl: 'Озеро — это файлы в дешёвом объектном хранилище (S3): сырые события за годы. Чтобы запросы не перебирали всё подряд, файлы пишут в колоночном формате Parquet, раскладывают по папкам дат, а табличный формат Iceberg ведёт журнал: какие файлы сейчас составляют таблицу.'
    }),
    props: ['format', 'partitioned', 'iceberg'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Конвейер дописывает файлы событий, аналитик считает выручку за 3 июля.' },
      { id: 'small', name: 'Мелкие файлы', note: 'Потоковая запись коммитит файлы каждые пару секунд: папка дня забивается тысячами крошечных файлов.' },
      { id: 'travel', name: 'Как было вчера', note: 'Ночной пересчёт с ошибкой перезаписал данные за 3 июля. Нужно увидеть, как было до него, и откатить.' },
      { id: 'schema', name: 'Новая колонка', note: 'Источник добавил поле coupon и переименовал amount в amount_rub. Что станет со старыми файлами и отчётом?' },
      { id: 'commit', name: 'Запись и чтение разом', note: 'Конвейер пишет пачку из 4 файлов, а аналитик в это время читает папку.' }
    ],
    tries: [
      { id: 'fmt', text: 'Переключи формат на JSON и сравни, сколько байт и долларов стоит один и тот же запрос' },
      { id: 'part', text: 'Выключи партиции по дате при выключенном Iceberg: запрос перебирает файлы за два года' },
      { id: 'hidden', text: 'Выключи партиции, но включи Iceberg: статистика в манифестах снова находит один день' },
      { id: 'compact', text: 'В «Мелкие файлы» дождись уплотнения: тысячи файлов склеиваются в один' },
      { id: 'travel', text: 'В «Как было вчера» сравни запрос «как было» с Iceberg и без него' },
      { id: 'commit', text: 'В «Запись и чтение разом» выключи Iceberg: читатель видит половину пачки' },
      { id: 'pfmt', text: 'Открой блок «JSON и Parquet» и посмотри, какие группы строк пропущены по футеру' },
      { id: 'pice', text: 'Открой блок «Iceberg» и дождись конфликта двух писателей' }
    ],
    parts: {
      store: {
        name: 'Объектное хранилище', knobs: ['partitioned'],
        an: 'Как <b>камера хранения с ячейками по номерам</b>: сдал сумку — получил номер, по номеру сумку и выдадут. Переложить что-то внутри нельзя — только сдать сумку целиком заново.',
        pl: 'S3 хранит объекты по ключу — длинной строке вроде events/dt=2026-07-03/part-00012.parquet. Папок на самом деле нет, это просто часть ключа. Объект пишут целиком и не меняют, зато читать можно любой кусок байт.',
        how: ['<b>PUT</b> кладёт объект целиком. Дописать в конец нельзя — только записать новый объект.', '<b>GET</b> с заголовком Range: bytes=… читает любой кусок файла. Так Parquet-читатель берёт только футер и нужные колонки.', '<b>LIST</b> с префиксом events/dt=2026-07-03/ отдаёт ключи страницами по 1 000 — «папка» это просто общее начало ключей.', 'Первый байт приходит через ≈ 20–50 мс, зато параллельно можно делать сотни запросов.', 'Хранение стоит ≈ $23 за ТБ в месяц, каждые 1 000 GET — ещё доли цента. Поэтому в озере держат всё сырьё за годы.', 'Объекты не меняются, поэтому «изменить строку» в озере — это записать новый файл и забыть старый. Это и делает Iceberg.'],
        watch: 'Слева — настоящие ключи объектов: видно, что «папки» — это просто начало строки. Справа — диалог движка запросов с S3: LIST, GET футера по диапазону байт, GET колонок, PUT нового файла.',
        real: 'AWS S3, Google Cloud Storage, Azure Blob, а у себя — MinIO или Ceph. S3 с 2020 года отдаёт LIST сразу после записи (strong consistency). Лимит — около 5 500 GET в секунду на префикс, поэтому большие таблицы раскладывают по многим префиксам.'
      },
      fmt: {
        name: 'JSON и Parquet', knobs: ['format'],
        an: 'JSON — как <b>пачка анкет</b>: чтобы узнать все суммы, листаешь каждую анкету целиком. Parquet — как <b>таблица в тетради по столбцам</b> с оглавлением в конце: открыл оглавление, нашёл нужный столбец нужных страниц — и читаешь только его.',
        pl: 'JSON хранит каждое событие строкой текста с названиями полей. Чтобы сложить суммы, надо прочитать и разобрать весь файл. Parquet раскладывает данные по колонкам и группам строк, сжимает их и в конце файла пишет футер: схему и min/max каждой колонки в каждой группе.',
        how: ['JSON-строка повторяет имена полей в каждом событии и хранит числа текстом: ≈ 300 байт на событие.', 'Parquet делит файл на группы строк (row group) по ≈ 128 МБ, внутри каждой — отдельный кусок на каждую колонку.', 'В конце файла — <b>футер</b>: схема, где лежит каждый кусок, и статистика min/max/число NULL по каждой колонке каждой группы.', 'Читатель сначала берёт последние байты файла — длину футера, потом сам футер (десятки КБ).', 'По min/max он пропускает группы, где точно нет нужного часа, а из оставшихся читает только нужные колонки.', 'Итог: из файла 256 МБ читается ≈ 2 МБ. Тот же объём в JSON — 1,9 ГБ, и его надо прочитать весь.'],
        watch: 'Слева JSON-файл: курсор вынужден пройти каждую строку. Справа устройство Parquet-файла: шаги чтения подсвечиваются по очереди — хвост, футер со статистикой, выбор группы строк, три куска колонок. Внизу — сколько байт прочитано в каждом случае.',
        real: 'Parquet и ORC — колоночные форматы, Avro — построчный двоичный. Сжатие Snappy или ZSTD, кодирование словарём и RLE. Размер группы строк — параметр parquet.block.size (128 МБ), страница внутри куска — ≈ 1 МБ. В Athena запрос стоит $5 за ТБ прочитанного — Parquet удешевляет его в десятки раз.'
      },
      part: {
        name: 'Папки по дате', knobs: ['partitioned', 'iceberg'],
        an: 'Как <b>архив, разложенный по дням</b>: нужен 3 июля — идёшь к одной полке и не трогаешь остальные 729.',
        pl: 'Файлы кладут в «папки» с датой в пути: events/dt=2026-07-03/. Запрос с условием на дату смотрит только одну папку. Без этого движок должен перебрать файлы за два года, чтобы найти нужный день.',
        how: ['Писатель кладёт файл в папку по дате события: events/dt=2026-07-03/part-00012.parquet.', 'Запрос WHERE dt = \'2026-07-03\' превращается в LIST одного префикса — 540 ключей, одна страница.', 'Без партиций движок делает LIST всей таблицы (≈ 394 тыс. ключей, 395 страниц) и открывает футер каждого файла, чтобы по min/max понять, есть ли там 3 июля.', 'Iceberg умеет «скрытые партиции»: в манифестах записаны min/max колонок каждого файла, и лишние файлы отбрасываются без LIST и без открытия.', 'Слишком мелкая разбивка (по часу и по пользователю) рождает миллионы крошечных папок — тоже плохо.', 'Обычно делят по дню или по месяцу, а внутри сортируют по часто используемому полю.'],
        watch: 'Дерево папок озера. Запрос за 3 июля подсвечивает путь, по которому идёт движок: одна папка или перебор всех. Счётчики справа — запросов LIST, открытых файлов и времени.',
        real: 'Hive-стиль путей key=value понимают Spark, Trino, Athena и Hive. В Iceberg партиции объявляют выражением: PARTITIONED BY (days(ts)) — и папка считается сама, а запрос пишут по ts, а не по dt. Delta Lake и Hudi устроены похоже.'
      },
      small: {
        name: 'Мелкие файлы', knobs: ['format', 'iceberg'],
        an: 'Как <b>тысяча чеков в кармане вместо одного отчёта</b>: денег столько же, но чтобы посчитать, придётся развернуть каждую бумажку.',
        pl: 'Потоковая запись каждые несколько секунд выкладывает новый маленький файл. Данных столько же, но открыть 18 000 файлов по 2 МБ гораздо дольше, чем 140 файлов по 256 МБ: на каждый уходит несколько запросов к S3 по десятки миллисекунд.',
        how: ['Поток (Flink, Spark Streaming) коммитит данные раз в 1–60 с — в каждый коммит получается новый файл.', 'Каждый файл — это LIST, GET футера и GET колонок: ≈ 3 запроса по 20–50 мс.', '18 000 файлов × 3 запроса — десятки тысяч запросов даже ради маленького отчёта.', '<b>Уплотнение (compaction)</b> — фоновая задача: берёт мелкие файлы одной папки и переписывает в один большой ≈ 256–512 МБ.', 'В Iceberg это один коммит replace: новый снимок ссылается на большой файл вместо мелких, читатели переключаются атомарно.', 'Старые мелкие файлы удаляются позже — когда истекут снимки, которые на них ссылаются.'],
        watch: 'Слева папка, забитая крошечными файлами, справа та же папка после уплотнения. Полоски внизу — сколько времени уходит только на открытие файлов. Уплотнение склеивает мелкие файлы пачками.',
        real: 'Iceberg: CALL system.rewrite_data_files(\'lake.events\'), цель — write.target-file-size-bytes = 512 МБ. Delta Lake: OPTIMIZE, Hudi: clustering. В S3 каждые 1 000 GET стоят ≈ $0,0004 — при миллионах файлов это заметные деньги.'
      },
      ice: {
        name: 'Iceberg: метаданные', knobs: ['iceberg', 'format'],
        an: 'Как <b>опись библиотеки</b>: книги стоят на полках как попало, но в описи сказано, какие книги сейчас входят в собрание. Новое издание — это новая опись, а сменить опись на стене можно одним движением.',
        pl: 'Iceberg — табличный формат поверх файлов. Он хранит дерево метаданных: какие файлы составляют таблицу сейчас и какая у неё схема. Запись меняет таблицу атомарно: пока новая опись не повешена, читатели видят старую.',
        how: ['<b>Каталог</b> хранит один указатель: таблица events → events/metadata/v12.metadata.json.', '<b>metadata.json</b>: схема, партиции, список снимков и какой из них текущий.', '<b>Список манифестов</b> (snap-12.avro) — какие манифесты входят в снимок.', '<b>Манифест</b> (m-…avro) — список файлов данных с числом строк и min/max каждой колонки.', 'Запись: положить новые файлы → новый манифест → новый список → новый metadata.json → <b>подменить указатель</b> в каталоге (compare-and-swap).', 'Если два писателя успели одновременно, подмена у второго не пройдёт (указатель уже не тот): он перечитает новую версию и повторит коммит.'],
        watch: 'Сверху вниз: каталог → metadata.json → список манифестов → манифесты → файлы. Писатель A строит новую ветку справа и подменяет указатель. Писатель B опаздывает: его подмена не проходит, и он повторяет поверх новой версии.',
        real: 'Каталоги: Hive Metastore, AWS Glue, Nessie, REST-каталог (Polaris, Unity). Движки: Spark, Trino, Flink, Snowflake, ClickHouse. Похожие форматы — Delta Lake (журнал _delta_log) и Apache Hudi.'
      },
      snap: {
        name: 'Снимки и time travel', knobs: ['iceberg'],
        an: 'Как <b>история версий в облачном документе</b>: каждое сохранение — новая версия, можно открыть «как было вчера в 9 утра» или вернуть её целиком.',
        pl: 'Каждый коммит Iceberg — снимок: какие файлы входили в таблицу в этот момент. Старые файлы не удаляются сразу, поэтому можно прочитать таблицу на любой момент из истории и откатиться, если пересчёт всё испортил.',
        how: ['Снимок = номер, время, операция (append, overwrite, delete, replace) и список манифестов.', 'Запрос FOR TIMESTAMP AS OF \'2026-07-04 09:00\' берёт последний снимок до этого времени и читает его файлы.', 'Ошибочный пересчёт перезаписал 3 июля — это просто новый снимок. Старые файлы на месте, на них ссылается прошлый снимок.', 'Откат: CALL rollback_to_snapshot(\'events\', 11) — указатель «текущий снимок» возвращается на 11. Мгновенно, без копирования данных.', 'Снимки копятся вечно, поэтому их чистят: expire_snapshots старше 7 дней. После этого «как было» дальше недели уже не посмотреть.', 'Без Iceberg (просто папки) перезапись стирает старые файлы — вернуть можно только из бэкапа или пересчётом из источника.'],
        watch: 'Шкала снимков: точки — коммиты, у каждого подписана операция. Под шкалой — какие файлы видит каждый снимок. Запрос «как было» прыгает к нужной точке, откат переносит отметку «текущий».',
        real: 'Iceberg: snapshot-id, FOR VERSION AS OF / FOR TIMESTAMP AS OF в Spark и Trino, rollback_to_snapshot, expire_snapshots (по умолчанию держит 5 дней). Delta Lake: VERSION AS OF и RESTORE. Время хранения истории — компромисс между ценой хранения и глубиной отката.'
      },
      schema: {
        name: 'Эволюция схемы', knobs: ['iceberg', 'format'],
        an: 'Как <b>анкета с номерами вопросов</b>: переименовали вопрос «сумма» в «сумма в рублях» — но номер у него прежний, и старые анкеты читаются правильно.',
        pl: 'Источник добавил поле и переименовал другое. Старые файлы уже лежат и не меняются. Iceberg помнит каждую колонку по номеру (id), а не по имени, поэтому старые и новые файлы читаются вместе без ошибок. Без него поиск идёт по имени, и переименование ломает отчёт.',
        how: ['В Iceberg у каждой колонки есть id: event_id = 1, ts = 2, user_id = 3, event_type = 4, amount = 5.', 'ALTER TABLE events ADD COLUMN coupon string — новая колонка получает id 6. В старых файлах её нет — читается NULL.', 'ALTER TABLE events RENAME COLUMN amount TO amount_rub — id остаётся 5. Старые файлы, где колонка называлась amount, читаются по id.', 'Удалённую колонку просто перестают показывать — файлы не переписываются.', 'Без Iceberg (Hive, JSON) колонки ищут по имени: в старых файлах amount_rub нет — сумма за старые дни внезапно NULL.', 'Схемы событий согласуют заранее: реестр схем (Schema Registry) и правила совместимости.'],
        watch: 'Слева таблица колонок с id до и после изменений. Справа два файла — старый и новый — и как каждый читается: по номеру колонки или по имени. Внизу — что увидит отчёт по выручке.',
        real: 'Iceberg: ADD, DROP, RENAME, повышение типа (int → bigint, float → double) — без перезаписи файлов. Parquet хранит field_id в схеме файла. В Hive и при чтении JSON по имени переименование ломает старые данные, и их приходится переписывать.'
      },
      layers: {
        name: 'Слои bronze → silver → gold', knobs: ['format'],
        an: 'Как <b>кухня ресторана</b>: в холодильнике — продукты как привезли (bronze), на столе — помытые и нарезанные (silver), на раздаче — готовые блюда (gold).',
        pl: 'В озере хранят данные в три слоя. Bronze — сырьё как пришло, ничего не выбрасываем. Silver — очищено: правильные типы, без дублей и тестовых событий. Gold — готовые агрегаты и витрины для отчётов.',
        how: ['<b>Bronze</b>: события JSON как прислал источник. Хранится долго — из него всегда можно всё пересчитать.', '<b>Silver</b>: приводим типы ("55120" → 55120), убираем дубли по event_id (повторная отправка), выкидываем тестовые события.', 'Silver — уже Iceberg-таблица в Parquet с понятной схемой. Её читают аналитики и модели.', '<b>Gold</b>: агрегаты под задачи — выручка по дням и странам, воронка, когорты.', 'Каждый слой пересчитывается задачами конвейера (dbt, Spark) по расписанию или потоком.', 'Ошибка в логике silver? Исправили код — пересчитали из bronze. Поэтому сырьё не удаляют.'],
        watch: 'Три таблицы с настоящими строками. Строки сырья проходят чистку: дубль и тестовое событие отбрасываются с пометкой, типы исправляются. Потом из чистых строк считается агрегат.',
        real: 'Название «медальонная архитектура» придумали в Databricks. На практике: bronze — Kafka → S3 как есть, silver — Spark или dbt в Iceberg/Delta, gold — витрины в том же озере или в ClickHouse и Snowflake.'
      }
    },
    legend: [['write', 'Новый файл от конвейера'], ['read', 'Запрос аналитика'], ['ok', 'Ответ, файл прочитан'], ['sq xk2-swf', 'Файл Parquet в папке дня'], ['sq xk2-swj', 'Файл JSON'], ['sq xk2-swr', 'Файл читается запросом'],
      ['sq xk2-sws', 'Мелкий файл (поток)'], ['accent', 'Метаданные Iceberg: подмена указателя'], ['bad', 'Испорчено, перезаписано, конфликт']],
    live: (n, r) => {
      const l = r.load || {}, ev = l.events || 0;
      const out = [['Событий', SD.fmt.num(ev) + '/с', '']];
      out.push(['Формат', n.props.format === 'json' ? 'JSON' : 'Parquet', n.props.format === 'json' ? 'warn' : 'ok']);
      if (r.cost != null) out.push(['Хранение', '$' + nf(r.cost) + '/мес', '']);
      out.push(['Iceberg', n.props.iceberg !== false && n.props.format !== 'json' ? 'да' : 'нет', n.props.iceberg !== false && n.props.format !== 'json' ? 'ok' : 'warn']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xk2St"></g><g id="xk2Dy" class="xk2-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xk2St'), gDy = ctx.svg.querySelector('#xk2Dy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 8) S.fx.shift(); };
      const js = () => P().format === 'json';
      const pt = () => P().partitioned !== false;
      const iceW = () => P().iceberg !== false;
      const ice = () => iceW() && !js();
      const ext = () => js() ? '.json' : '.parquet';
      const fpd = () => js() ? JS_FILES : PQ_FILES;

      /* ---------- папки и файлы ---------- */
      let fid = 1;
      const mkf = (d, n, mb, st) => ({ id: fid++, d, n, mb, st: st || '', t0: -1e9 });
      const fname = (d, n) => pt() ? `part-${String(n).padStart(5, '0')}` : `${DAYS[d].replace(/-/g, '').slice(4)}-${String(n).padStart(5, '0')}`;
      function initDays() {
        S.days = DAYS.map((dt, i) => {
          const sm = i === TODAY && S.scn === 'small', cnt = sm ? 9000 : i === TODAY ? (js() ? 1590 : 212) : fpd();
          const files = [];
          const first = i === TODAY ? cnt - 3 : 0;
          if (!sm) for (let k = 0; k < 3; k++) files.push(mkf(i, first + k, 256));
          const day = { dt, i, cnt, files, bad: false, v2: 0, gone: [], small: sm ? 9000 : 0 };
          day.vol0 = vol(day);
          return day;
        });
        S.ver = 12; S.snap = 12; S.snaps = [{ id: 10, op: 'append', at: 'вчера 23:00' }, { id: 11, op: 'append', at: '06:00' }, { id: 12, op: 'append', at: '09:58' }];
      }
      function reset() {
        Object.assign(S, { t: 0, fx: [], ws: [], q: null, qAt: 900, wAt: 300, cmpAt: 3500, cmp: null, swapT: -1e9, conflictT: -1e9, ev: null, evAt: 1600, batch: null, hist: [], last: null, flags: {}, cfgT: 0 });
        initDays();
        S.cfg = cfgSig();
      }
      const cfgSig = () => [P().format, pt(), iceW(), S.scn].join('|');

      /* ---------- цена запроса (в настоящих единицах) ---------- */
      function cost(d) {
        const day = S.days[d], j = js(), p = pt(), ic = ice();
        const files = p || ic ? day.cnt : fpd() * LAKE_DAYS;
        const listed = ic ? 0 : p ? day.cnt : fpd() * LAKE_DAYS;
        const listMs = Math.ceil(listed / 1000) * 45, metaMs = ic ? 150 + (p ? 0 : 60) : 0;
        const scale = d === TODAY ? vol(day) / (fpd() * 256e6) : 1;
        let bytes = j ? DAY_EV * 300 * scale * (p || ic ? 1 : LAKE_DAYS) : DAY_EV * 2.5 * scale + files * 65536;
        const openMs = files * 3 * 25 / 160, readMs = bytes / 4e9 * 1000;
        return { files, listed, bytes, ms: listMs + metaMs + openMs + readMs + 300, cost: bytes / 1e12 * 5, listMs, metaMs, openMs, readMs };
      }
      const vol = day => (day.cnt - (day.small || 0)) * 256e6 + (day.small || 0) * 2e6;   // байт в папке (Parquet-эквивалент)
      const frac = day => day.i === TODAY ? vol(day) / day.vol0 * (S.scn === 'small' ? 0.45 : 1) : 1;   // сколько уже набралось за сегодня
      const qDay = () => S.scn === 'small' || S.scn === 'schema' || S.scn === 'commit' ? TODAY : QDAY;

      /* ---------- запись файлов ---------- */
      const chipW = () => 94;
      function fileXY(d, k) { const y = rowY(d); return [FX0 + 4 + k * (chipW() + 6) + chipW() / 2, y + RH / 2]; }
      function writeFile(opt) {
        const day = S.days[TODAY], o = opt || {}, small = !!o.small;
        const w = { k: small ? 'small' : 'file', ph: 'go', p0: S.t, dur: 650, small, v2: !!o.v2, batch: o.batch, pts: [[SRC.x + SRC.w, SRC.y + 60], [BZ.x + 8, SRC.y + 60], [BZ.x + 8, rowY(TODAY) + 8], [FX0 + 40, rowY(TODAY) + 8]] };
        S.ws.push(w);
      }
      function landFile(w) {
        const day = S.days[TODAY];
        day.cnt++;
        if (w.small) { day.small = (day.small || 0) + 1; }
        else { const f = mkf(TODAY, day.cnt - 1, 256, w.v2 ? 'v2' : w.batch ? 'unc' : 'new'); f.t0 = S.t; f.batch = w.batch; day.files.push(f); if (day.files.length > 3) day.files.shift(); }
        if (w.v2) day.v2 = (day.v2 || 0) + 1;
        if (ice() && !w.batch && !w.small) commit('append');
        if (ice() && w.small && Math.random() < 0.5) commit('append');
        w.gone = true;
      }
      function commit(op) {
        S.ver++; S.snap = S.ver; S.swapT = S.t;
        const now = new Date(2026, 6, 4, 10, 0 + Math.floor(S.t / 4000));
        S.snaps.push({ id: S.ver, op, at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
        if (S.snaps.length > 6) S.snaps.shift();
      }

      /* ---------- запрос аналитика ---------- */
      function newQuery() {
        const d = qDay(), c = cost(d), tt = S.scn === 'travel' && S.ev && S.ev.ph === 'bad' && S.q2 === 'now' ? 'past' : 'now';
        if (S.scn === 'travel') S.q2 = tt;
        const q = { d, c, ph: ice() ? 'meta' : 'list', p0: S.t, tt: S.scn === 'travel' ? tt : 'now' };
        q.durs = { meta: 700, list: pt() || ice() ? 700 : 1600, open: clamp(500 + c.openMs / 60, 500, 2600), read: clamp(700 + c.readMs / 40, 700, 2600), back: 450 };
        if (S.scn === 'commit' && S.batch) q.seen = S.batch.n;   // сколько файлов пачки уже лежит
        S.q = q;
        if (js()) S.flags.json = 1; else if (S.flags.json) done('fmt');
        if (!pt() && !ice()) { done('part'); note('np', `<b>Без партиций и без Iceberg:</b> LIST ≈ ${nf(c.listed)} ключей и ${nf(c.files)} открытых футеров ради одного дня. Запрос ≈ ${tms(c.ms)}.`, 'bad', 9000); }
        if (!pt() && ice()) { done('hidden'); note('hid', '<b>Скрытые партиции:</b> папок по дате нет, но в манифестах Iceberg записан min/max ts каждого файла — движок сразу берёт файлы одного дня, без LIST.', 'ok', 9000); }
      }
      function qStep() {
        const q = S.q; if (!q) { if (S.t >= S.qAt) newQuery(); return; }
        const dur = q.durs[q.ph];
        if (S.t < q.p0 + dur) return;
        const nx = { meta: 'open', list: 'open', open: 'read', read: 'back' }[q.ph];
        if (nx) { q.ph = nx; q.p0 = S.t; return; }
        finish(q);
      }
      function finish(q) {
        const day = S.days[q.d], c = q.c;
        let ord = Math.round(ORD[q.d] * frac(day)), rev = REVD[q.d] * frac(day), msg = '', cls = 'ok';
        if (S.scn === 'travel' && day.bad) {
          if (q.tt === 'past') { if (ice()) { msg = `как было до пересчёта (снимок ${S.ev.prev})`; } else { ord = 0; rev = 0; msg = 'старых файлов нет — смотреть не на что'; cls = 'bad'; } }
          else { ord = Math.round(ORD[q.d] * 0.21); rev = REVD[q.d] * 0.21; msg = 'после ошибочного пересчёта'; cls = 'bad'; }
        }
        if (S.scn === 'schema' && day.v2 && !ice()) { rev *= 1 - clamp(day.v2 * 0.035, 0, 0.6); msg = `в ${day.v2} новых файлах нет колонки amount — там NULL`; cls = 'bad'; }
        if (S.scn === 'commit' && q.seen != null && !ice()) { msg = `видна часть пачки: ${q.seen} из 4 новых файлов`; cls = q.seen > 0 && q.seen < 4 ? 'bad' : 'ok'; if (cls === 'bad') { done('commit'); note('half', `<b>Читатель увидел половину пачки:</b> ${q.seen} ${pl(q.seen, 'файл', 'файла', 'файлов')} из 4 уже ${q.seen === 1 ? 'лежит' : 'лежат'} в папке, остальные ещё пишутся. Отчёт посчитан по неполным данным.`, 'bad', 5000); } }
        if (S.scn === 'commit' && ice()) msg = `снимок ${S.snap}: пачка видна целиком или не видна вовсе`;
        S.last = { d: q.d, ord, rev, msg, cls, c, tt: q.tt, t: S.t };
        S.hist.push({ t: S.t, ms: c.ms }); S.q = null; S.qAt = S.t + (S.scn === 'commit' ? 2600 : S.scn === 'travel' ? 1200 : 2200);
        if (js()) note('js', `<b>JSON:</b> чтобы найти покупки за день, движок прочитал ${byt(c.bytes)} — каждую строку целиком. Запрос стоит ≈ ${usd(c.cost)}.`, 'warn', 9000);
        if (S.scn === 'travel' && q.tt === 'past') { if (ice()) S.flags.tti = 1; else S.flags.tth = 1; if (S.flags.tti && S.flags.tth) done('travel'); }
      }

      /* ---------- события ситуаций ---------- */
      function scnStep() {
        const today = S.days[TODAY];
        if (S.scn === 'small') {
          if (S.t >= S.wAt) { writeFile({ small: true }); S.wAt = S.t + 260; }
          if (!S.cmp && S.t >= S.cmpAt && (today.small || 0) >= 300) {
            S.cmp = { t0: S.t, n: Math.min(today.small, 2000) }; note('cmp0', `<b>Уплотнение:</b> берём ${nf(S.cmp.n)} мелких файлов папки dt=2026-07-05 (≈ ${byt(S.cmp.n * 2e6)}) и переписываем в ${Math.ceil(S.cmp.n * 2 / 256)} файлов по 256 МБ.`, '', 0);
          }
          if (S.cmp && S.t - S.cmp.t0 > 1400) {
            const n = S.cmp.n, big = Math.ceil(n * 2 / 256); today.small -= n; today.cnt -= n - big;
            const f = mkf(TODAY, (S.cmpN = (S.cmpN || 0) + 1), 256, 'cmp'); f.t0 = S.t; f.cmp = 1; today.files.push(f); if (today.files.length > 3) today.files.shift();
            if (ice()) commit('replace');
            done('compact');
            note('cmp1', `<b>Готово:</b> ${nf(n)} файлов по 2 МБ → ${big} файлов по 256 МБ. В папке осталось ${nf(today.cnt)} ${pl(today.cnt, 'файл', 'файла', 'файлов')}${ice() ? '. Iceberg закоммитил снимок replace — читатели переключились атомарно' : ''}.`, 'ok', 0);
            S.cmp = null; S.cmpAt = S.t + 6500;
          }
          return;
        }
        if (S.scn === 'commit') {
          const b = S.batch;
          if (!b && S.t >= S.wAt) { S.batch = { n: 0, t0: S.t, next: S.t, id: S.ver + 1 }; }
          if (S.batch) {
            const bb = S.batch;
            if (bb.n < 4 && S.t >= bb.next) { writeFile({ batch: bb.id }); bb.n++; bb.next = S.t + 700; }
            if (bb.n >= 4 && S.t >= bb.next + 600 && !bb.done) {
              bb.done = 1;
              if (ice()) { commit('append'); note('cm', `<b>Коммит пачки:</b> 4 файла записаны, новый metadata.json готов — указатель каталога подменён на v${S.ver}. Читатели увидели всю пачку разом.`, 'ok', 5000); }
              today.files.forEach(f => { if (f.st === 'unc') f.st = 'new'; });
            }
            if (bb.done && S.t >= bb.next + 3200) { S.batch = null; S.wAt = S.t + 300; if (ice()) S.conflictT = S.t + 400; }
          }
          return;
        }
        if (S.t >= S.wAt) { writeFile({ v2: S.scn === 'schema' && S.ev && S.ev.ph === 'v2' }); S.wAt = S.t + (S.scn === 'schema' ? 1300 : 1700); }
        if (S.scn === 'travel') {
          if (!S.ev && S.t >= S.evAt) {
            S.ev = { ph: 'bad', t0: S.t, prev: S.snap }; const d = S.days[QDAY]; d.bad = true; d.files.forEach(f => { f.old = f.st; f.st = 'bad'; f.t0 = S.t; });
            if (ice()) commit('overwrite');
            note('bad', `<b>Ночной пересчёт с ошибкой</b> перезаписал папку dt=2026-07-03: в новых файлах потеряна часть заказов. ${ice() ? 'Iceberg записал это как новый снимок, старые файлы на месте.' : 'Без Iceberg старые файлы стёрты.'}`, 'bad', 0);
          }
          if (S.ev && S.ev.ph === 'bad' && S.t - S.ev.t0 > 11000) {
            const d = S.days[QDAY];
            if (ice()) { const pv = S.ev.prev; S.ver++; S.snap = pv; S.swapT = S.t; note('rb', `<b>Откат:</b> CALL rollback_to_snapshot('events', ${pv}) — отметка «текущий снимок» вернулась на ${pv}, данные 3 июля снова верные. Ничего не копировалось.`, 'ok', 0); }
            else note('rl', '<b>Без Iceberg</b> откатиться нечем: данные 3 июля перегружают заново из Kafka или бэкапа — часы работы.', 'warn', 0);
            d.bad = false; d.files.forEach(f => { f.st = f.old || ''; f.t0 = S.t; });
            S.ev = { ph: 'fixed', t0: S.t };
          }
          if (S.ev && S.ev.ph === 'fixed' && S.t - S.ev.t0 > 5000) { S.ev = null; S.evAt = S.t + 1500; }
        }
        if (S.scn === 'schema' && !S.ev && S.t >= S.evAt) {
          S.ev = { ph: 'v2', t0: S.t };
          if (ice()) commit('schema');
          note('sch', `<b>Источник сменил схему:</b> добавил coupon и переименовал amount → amount_rub. ${ice() ? 'Iceberg: ALTER TABLE … RENAME COLUMN — номер колонки прежний, старые файлы читаются как раньше.' : 'Без Iceberg движок ищет колонку по имени — в новых файлах amount больше нет.'}`, ice() ? 'ok' : 'warn', 0);
        }
      }

      /* ---------- отрисовка общей картинки ---------- */
      function badges() {
        const td = S.days[TODAY];
        const bs = [['fmt', 'JSON И PARQUET', js() ? 'JSON: читаем всё' : 'Parquet + футер', js() ? 'warn' : ''], ['small', 'МЕЛКИЕ ФАЙЛЫ', `в папке дня ${nf(td.cnt)}`, td.small > 30 ? 'warn' : ''],
          ['snap', 'СНИМКИ', ice() ? `текущий снимок ${S.snap}` : 'нет: без Iceberg', ice() ? '' : 'warn'], ['schema', 'СХЕМА', ice() ? 'колонки по id' : 'колонки по имени', ice() ? '' : 'warn']];
        const w = (BZ.w + 12 + ICE.w - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xk2-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xk2-go');
        bs.forEach(([k, t, v, c], i) => { const x = BZ.x + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xk2-badge', 9)}${T(x + 10, 18, t, 'xr-m')}${T(x + 10, 32, ES(v), 'xr-s' + (c ? ' xk2-' + c : ''))}</g>`; });
        return s;
      }
      function srcBox() {
        const ins = ctx.ins().map(x => x.n), src = ins.find(k => k.type === 'etl') || ins.find(k => k.type === 'queue') || ins[0], go = src && ctx.canGo(src.id), l = ctx.res.load || {};
        let s = `<g${go ? ` class="xr-go" data-xgo="${src.id}"` : ''}>${R(SRC.x, SRC.y, SRC.w, SRC.h, 'xr-box', 12)}`;
        s += T(SRC.x + 12, SRC.y + 22, ES(cut(src ? ctx.nm(src.id) : 'Конвейер', 18)), 'xr-t') + T(SRC.x + 12, SRC.y + 42, 'пишет события:', 'xr-s');
        s += T(SRC.x + 12, SRC.y + 60, js() ? 'файлы JSON' : 'файлы Parquet', 'xr-m ' + (js() ? 'warn' : 'acc'));
        s += T(SRC.x + 12, SRC.y + 78, `≈ ${SD.fmt.num(l.events || 0)} событий/с`, 'xr-s');
        const how = S.scn === 'small' ? 'файл каждые 2 с' : S.scn === 'commit' ? 'пачка из 4 файлов' : 'файл ≈ 256 МБ';
        s += T(SRC.x + 12, SRC.y + 100, how, 'xr-s' + (S.scn === 'small' ? ' xk2-warn' : ''));
        if (S.scn === 'schema' && S.ev) s += T(SRC.x + 12, SRC.y + 118, 'схема v2: +coupon', 'xr-s xk2-warn');
        if (go) s += T(SRC.x + 12, SRC.y + SRC.h - 10, 'клик — внутрь ›', 'xr-s xk2-go');
        return s + '</g>';
      }
      function chipCls(f, d) {
        const q = S.q, rd = q && q.d === d && (q.ph === 'open' || q.ph === 'read');
        let c = 'xk2-file ' + (js() ? 'j' : 'p');
        if (f.st === 'new' && S.t - f.t0 < 900) c += ' fl';
        if (f.st === 'bad') c += ' bad'; if (f.st === 'v2') c += ' v2'; if (f.st === 'unc') c += ' unc'; if (f.cmp && S.t - f.t0 < 2500) c += ' cmp';
        if (rd && !(f.st === 'unc' && ice())) c += ' rd';
        return c;
      }
      function scnMsg() {
        if (S.scn === 'small' && S.cmp) { const k = clamp((S.t - S.cmp.t0) / 1400, 0, 1); return [`уплотнение: ${nf(S.cmp.n)} мелких → ${Math.ceil(S.cmp.n * 2 / 256)} больших · ${Math.round(k * 100)} %`, 'acc']; }
        if (S.scn === 'travel' && S.ev && S.ev.ph === 'bad') return [ice() ? '3 июля перезаписано новым снимком — старые файлы на месте' : '3 июля перезаписано — старые файлы стёрты', 'bad'];
        if (S.scn === 'commit' && S.batch && !S.batch.done) return [`пишется пачка: ${S.batch.n} из 4${ice() ? ' · читатели её пока не видят' : ' · уже видна читателям!'}`, ice() ? 'ok' : 'warn'];
        return null;
      }
      function bucket() {
        const td = S.days[TODAY], q = S.q, tot = S.days.reduce((s, d) => s + d.cnt, 0);
        const m = scnMsg();
        let s = `<g class="xr-part" data-xpart="store">${R(BZ.x, BZ.y, BZ.w, BZ.h, 'xr-zone', 14)}${T(BZ.x + 12, BZ.y + 18, 's3://lake/events/', 'xr-m acc')}${T(BZ.x + BZ.w - 12, BZ.y + 18, m ? m[0] : `объектов за 5 дней: ${nf(tot)} · хранится 2 года`, m ? 'xr-s xk2-' + m[1] : 'xr-s', 'end')}</g>`;
        const cw = chipW();
        S.days.forEach((day, i) => {
          const y = rowY(i), rd = q && q.d === i, scanAll = q && !pt() && !ice() && (q.ph === 'list' || q.ph === 'open');
          s += R(BZ.x + 6, y, BZ.w - 12, RH, 'xk2-row' + (rd ? ' rd' : scanAll ? ' sc' : '') + (day.bad ? ' bad' : ''), 8);
          // ярлык папки
          s += `<g class="xr-part" data-xpart="part">${R(LBX - 2, y + 2, FX0 - LBX - 4, RH - 4, 'xk2-pf', 6)}`;
          s += T(LBX + 4, y + 21, pt() ? `dt=${day.dt}/` : `…/${day.dt.slice(5)}`, 'xk2-path' + (rd ? ' on' : ''));
          s += T(LBX + 4, y + 39, `${nf(day.cnt)} ${ext()} · ${byt(vol(day))}`, 'xk2-ms');
          s += '</g>';
          // файлы
          day.files.forEach((f, k) => {
            const past = q && q.d === i && q.tt === 'past' && f.st === 'bad', x = FX0 + 4 + k * (cw + 6), c = past ? (ice() ? 'xk2-file p' + (q.ph === 'open' || q.ph === 'read' ? ' rd' : '') : 'xk2-file p ghost') : chipCls(f, i);
            if (past) { s += R(x, y + 8, cw, RH - 16, c, 5) + T(x + 6, y + 23, ES(fname(i, f.n)), 'xk2-fn') + T(x + 6, y + 37, ice() ? `снимок ${S.ev.prev}` : 'старого нет', 'xk2-ms ' + (ice() ? 'xk2-ok' : 'xk2-bad')); return; }
            s += R(x, y + 8, cw, RH - 16, c, 5) + T(x + 6, y + 23, ES(cut(f.cmp ? `big-${String(f.n).padStart(4, '0')}` : fname(i, f.n), Math.floor((cw - 10) / 6.1))), 'xk2-fn') + T(x + 6, y + 37, f.st === 'bad' ? 'перезаписан' : f.st === 'v2' ? 'схема v2' : f.st === 'unc' ? (ice() ? 'не закоммичен' : 'уже виден!') : f.cmp ? 'уплотнён' : '256 МБ', 'xk2-ms' + (f.st === 'bad' ? ' xk2-bad' : f.st === 'v2' ? (ice() ? ' xk2-acc' : ' xk2-warn') : f.st === 'unc' ? (ice() ? '' : ' xk2-bad') : ''));
            if (rd && q.ph === 'read' && !(f.st === 'unc' && ice())) { const k2 = clamp((S.t - q.p0) / q.durs.read, 0, 1); s += R(x, y + RH - 12, cw * k2, 3, 'xk2-rdbar', 1); }
          });
          const more = day.cnt - day.files.length - (day.small || 0);
          const mx = FX0 + 4 + day.files.length * (cw + 6);
          if (i === TODAY && day.small) {
            const per = Math.max(1, Math.floor((BZ.x + BZ.w - 64 - mx) / 9)), rows = Math.floor((RH - 8) / 9), shown = Math.min(day.small, per * rows), cn = S.cmp ? Math.round(shown * S.cmp.n / Math.max(1, day.small)) : 0;
            for (let j = 0; j < shown; j++) s += R(mx + (j % per) * 9, y + 6 + Math.floor(j / per) * 9, 7, 7, 'xk2-sm' + (j < cn ? ' cmp' : '') + (q && q.d === i && q.ph !== 'meta' && q.ph !== 'list' ? ' rd' : ''), 1.5);
            if (day.small > shown) s += T(BZ.x + BZ.w - 14, y + 23, `+${nf(day.small - shown)}`, 'xk2-fn xk2-warn', 'end') + T(BZ.x + BZ.w - 14, y + 37, 'мелких', 'xk2-ms', 'end');
          } else if (more > 0) s += T(mx + 4, y + 23, `+${nf(more)}`, 'xk2-fn') + T(mx + 4, y + 37, pl(more, 'файл', 'файла', 'файлов'), 'xk2-ms');
        });
        if (!pt()) s += T(BZ.x + 12, BZ.y + BZ.h - 8, ice() ? 'папок по дате нет, но Iceberg знает min/max ts каждого файла' : 'папок по дате нет: все файлы в events/ вперемешку', 'xr-s' + (ice() ? '' : ' xk2-warn'));
        return s;
      }
      function icePanel() {
        const b = ICE, on = ice(), sw = S.t - S.swapT < 900, cf = S.conflictT > 0 && S.t - S.conflictT > 0 && S.t - S.conflictT < 1800;
        let s = `<g class="xr-part" data-xpart="ice">${R(b.x, b.y, b.w, b.h, 'xr-box' + (on ? (sw ? ' sel' : '') : ' xk2-off'), 12)}`;
        s += T(b.x + 12, b.y + 18, 'ICEBERG · МЕТАДАННЫЕ', 'xr-m' + (on ? ' acc' : ''));
        if (!on) {
          s += T(b.x + 12, b.y + 42, iceW() && js() ? 'JSON в Iceberg не кладут:' : 'Табличного формата нет —', 'xr-s xk2-warn') + T(b.x + 12, b.y + 60, iceW() && js() ? 'Iceberg хранит Parquet, ORC' : 'это просто папки (Hive):', 'xr-s') + T(b.x + 12, b.y + 78, iceW() && js() ? 'или Avro. Здесь — папки JSON.' : 'файлы ищут через LIST,', 'xr-s');
          s += T(b.x + 12, b.y + 102, '· нет атомарных коммитов', 'xr-s') + T(b.x + 12, b.y + 120, '· нет снимков и «как было»', 'xr-s') + T(b.x + 12, b.y + 138, '· колонки ищут по имени', 'xr-s') + T(b.x + 12, b.y + 156, '· статистики файлов нет', 'xr-s');
          return s + '</g>';
        }
        const X = b.x + 14, W = b.w - 28, q = S.q, qm = q && q.ph === 'meta', k = qm ? clamp((S.t - q.p0) / q.durs.meta, 0, 1) : 0, st = j => qm && k >= j / 4;
        s += R(X, b.y + 28, W, 22, 'xk2-meta' + (sw || st(0) ? ' on' : ''), 5) + T(X + 8, b.y + 43, `каталог: events → v${S.ver}.metadata.json`, 'xk2-fn');
        s += R(X + 10, b.y + 58, W - 10, 22, 'xk2-meta' + (sw ? ' fl' : st(1) ? ' on' : ''), 5) + T(X + 18, b.y + 73, `v${S.ver}.metadata.json · снимок ${S.snap}`, 'xk2-fn');
        s += R(X + 20, b.y + 88, W - 20, 22, 'xk2-meta' + (st(2) ? ' on' : ''), 5) + T(X + 28, b.y + 103, `snap-${S.snap}.avro · список манифестов`, 'xk2-fn');
        s += R(X + 30, b.y + 118, (W - 36) / 2, 22, 'xk2-meta' + (st(3) ? ' on' : ''), 5) + T(X + 36, b.y + 133, 'm-a1.avro', 'xk2-fn');
        s += R(X + 36 + (W - 36) / 2, b.y + 118, (W - 36) / 2, 22, 'xk2-meta' + (st(3) ? ' on' : ''), 5) + T(X + 42 + (W - 36) / 2, b.y + 133, 'm-b7.avro', 'xk2-fn');
        [[X + 4, 50, 58], [X + 14, 80, 88], [X + 24, 110, 118]].forEach(([x, y1, y2]) => { s += Ln(x, b.y + y1, x, b.y + y2 + 11, 'xk2-tree') + Ln(x, b.y + y2 + 11, x + 6, b.y + y2 + 11, 'xk2-tree'); });
        const last = S.snaps[S.snaps.length - 1];
        s += T(X, b.y + 160, `снимков: ${S.ver} · последний: ${last.op}`, 'xk2-ms');
        s += T(X, b.y + 178, cf ? 'писатель B: подмена не прошла → повтор' : sw ? `указатель подменён → v${S.ver}` : 'запись = подмена указателя', 'xk2-ms ' + (cf ? 'xk2-bad' : sw ? 'xk2-acc' : ''));
        return s + '</g>';
      }
      function engPanel() {
        const b = ENG, q = S.q, L = S.last;
        let s = R(b.x, b.y, b.w, b.h, 'xr-box' + (q ? ' sel' : ''), 12) + T(b.x + 12, b.y + 18, 'TRINO · ДВИЖОК ЗАПРОСОВ', 'xr-m') + T(b.x + b.w - 12, b.y + 18, '10 воркеров', 'xk2-ms', 'end');
        const c = q ? q.c : L ? L.c : cost(qDay());
        const steps = [[ice() ? 'meta' : 'list', ice() ? `метаданные: ${pt() ? 'папка' : 'min/max'} дня` : `LIST: ${nf(c.listed)} ключей`], ['open', `${js() ? 'открыть' : 'футеры'}: ${nf(c.files)} ${pl(c.files, 'файл', 'файла', 'файлов')}`], ['read', `читаем ${byt(c.bytes)}`], ['back', `ответ: ${tms(c.ms)} · ${usd(c.cost)}`]];
        const order = ['meta', 'list', 'open', 'read', 'back'], cur = q ? order.indexOf(q.ph) : 99;
        steps.forEach(([ph, t], j) => {
          const y = b.y + 38 + j * 23, i = order.indexOf(ph), on = q && q.ph === ph, past = q ? cur > i : !!L;
          s += R(b.x + 12, y - 12, b.w - 24, 19, 'xk2-step' + (on ? ' on' : past ? ' done' : ''), 4) + T(b.x + 20, y + 2, `${j + 1}. ${t}`, 'xr-s' + (on ? ' xk2-acc' : ''));
          if (on) { const k = clamp((S.t - q.p0) / q.durs[ph], 0, 1); s += R(b.x + 12, y + 5, (b.w - 24) * k, 2, 'xk2-rdbar', 1); }
        });
        return s;
      }
      function sqlPanel() {
        const b = SQB, q = S.q, L = S.last, d = qDay(), cur = q || L, tt = S.scn === 'travel' && !!cur && cur.tt === 'past';
        let s = R(b.x, b.y, b.w, b.h, 'xk2-code', 10) + T(b.x + 12, b.y + 18, tt ? 'ЗАПРОС «КАК БЫЛО ВЧЕРА»' : 'ЗАПРОС АНАЛИТИКА', 'xr-m' + (tt ? ' acc' : ''));
        const amt = S.scn === 'schema' && S.ev && ice() ? 'amount_rub' : 'amount';
        const L1 = ['SELECT count(*) AS orders, sum(' + amt + ') AS revenue', tt ? "FROM events FOR TIMESTAMP AS OF '2026-07-04 09:00'" : 'FROM lake.events', pt() ? `WHERE dt = DATE '${DAYS[d]}'` : `WHERE ts >= '${DAYS[d]}' AND ts < '${DAYS[d + 1] || '2026-07-06'}'`, "  AND event_type = 'purchase'"];
        L1.forEach((l, j) => { s += SQL(b.x + 12, b.y + 38 + j * 17, l, 'sm'); });
        if (L && !q && S.t - L.t < 9000) {
          s += T(b.x + 12, b.y + 116, L.ord ? `заказов ${nf(L.ord)} · выручка ${nf(L.rev, 2)} млрд ₽` : 'результата нет', 'xr-m ' + (L.cls === 'bad' ? 'bad' : 'ok'));
          s += T(b.x + 12, b.y + 134, L.msg || `открыто ${nf(L.c.files)} ${pl(L.c.files, 'файл', 'файла', 'файлов')} · прочитано ${byt(L.c.bytes)}`, 'xk2-ms' + (L.cls === 'bad' ? ' xk2-bad' : ''));
          s += T(b.x + 12, b.y + 149, `${tms(L.c.ms)} · ${usd(L.c.cost)} за запрос (Athena: $5 за ТБ)`, 'xk2-ms');
        } else s += T(b.x + 12, b.y + 120, q ? 'считаем…' : 'ждём запрос…', 'xr-s');
        return s;
      }
      function layersPanel() {
        const b = LAY, k = (S.t % 4200) / 4200;
        let s = `<g class="xr-part" data-xpart="layers">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}`;
        s += T(b.x + 12, b.y + 18, 'СЛОИ ОЗЕРА', 'xr-m') + T(b.x + b.w - 12, b.y + 18, 'пересчёт: dbt / Spark', 'xk2-ms', 'end');
        const L = [['bronze', 'bronze.events_raw', 'JSON как пришло', js() ? '1,0 ТБ в день' : '1,0 ТБ в день', 'br'], ['silver', 'silver.events', 'типы, без дублей', '138 ГБ в день', 'si'], ['gold', 'gold.revenue_daily', 'выручка по дням', '6 строк в день', 'go']];
        const w = (b.w - 24 - 2 * 34) / 3;
        L.forEach(([t, n, d1, d2, c], j) => {
          const x = b.x + 12 + j * (w + 34), y = b.y + 30;
          s += R(x, y, w, 112, 'xk2-layer ' + c, 8) + T(x + 10, y + 20, t.toUpperCase(), 'xr-m') + T(x + 10, y + 40, n, 'xk2-fn') + T(x + 10, y + 62, d1, 'xk2-ms') + T(x + 10, y + 80, d2, 'xk2-ms');
          if (j < 2) { s += arrow(x + w + 4, y + 56, x + w + 30, y + 56, ''); }
        });
        [0, 1].forEach(j => { const x0 = b.x + 12 + j * (w + 34) + w + 4, kk = clamp(k * 2 - j, 0, 1); if (kk > 0 && kk < 1) s += Dot(x0 + 26 * ease(kk), b.y + 86, 5, '', `fill:${SD.kindColor('write')}`); });
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const wc = SD.kindColor('write'), rc = SD.kindColor('read');
        S.ws.forEach(w => { const [x, y] = along(w.pts, (S.t - w.p0) / w.dur); s += w.small ? R(x - 3, y - 3, 6, 6, 'xk2-sm', 1) : R(x - 7, y - 6, 14, 12, 'xk2-fdot', 2) + (w.v2 ? T(x, y - 10, 'v2', 'xk2-fn xk2-warn', 'middle') : ''); });
        const q = S.q;
        if (q) {
          const k = (S.t - q.p0) / q.durs[q.ph], E = [ENG.x, ENG.y + 50], row = rowY(q.d), F = [BZ.x + BZ.w - 4, row + RH / 2];
          if (q.ph === 'meta') s += Dot(...lerp([ENG.x + 40, ENG.y], [ICE.x + 40, ICE.y + ICE.h - 6], ease(k)), 5, '', `fill:${rc}`);
          if (q.ph === 'list') {
            if (pt()) s += Dot(...lerp(E, [LBX + 120, row + 21], ease(k)), 5, '', `fill:${rc}`);
            else S.days.forEach((d, i) => { s += Dot(...lerp(E, [LBX + 120, rowY(i) + 21], ease(clamp(k * 1.4 - i * 0.1, 0, 1))), 4, '', `fill:${rc}`); });
          }
          if (q.ph === 'open') { for (let j = 0; j < 3; j++) s += Dot(...lerp(E, [FX0 + 60 + j * 118, row + 26], ease(clamp(k * 1.5 - j * 0.2, 0, 1))), 4, '', `fill:${rc}`); }
          if (q.ph === 'back') s += Dot(...lerp(F, [ENG.x + 30, ENG.y + ENG.h - 20], ease(k)), 6, 'ok');
        }
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() {
        gSt.innerHTML = badges() + srcBox() + bucket() + icePanel() + engPanel() + sqlPanel() + layersPanel();
        gDy.innerHTML = dynSvg();
      }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xk2-backb', 13)}${T(68, 27, '← всё озеро', 'xr-s xk2-back', 'middle')}</g>` + T(140, 27, t, 'xk2-vt') + T(140, 46, sub, 'xr-s');
      function seq(x1, x2, y0, names, steps, cyc) {   // диаграмма последовательности: два участника, шаги по очереди
        const ST = 1000, n = steps.length, len = n * ST + 2000, u = cyc % len, cur = Math.floor(u / ST), f = (u % ST) / ST, dy = 34;
        let s = R(x1 - 70, y0, 140, 30, 'xr-box', 8) + T(x1, y0 + 20, names[0], 'xr-t', 'middle') + R(x2 - 70, y0, 140, 30, 'xr-box', 8) + T(x2, y0 + 20, names[1], 'xr-t', 'middle');
        s += Ln(x1, y0 + 30, x1, y0 + 44 + n * dy, 'xk2-life') + Ln(x2, y0 + 30, x2, y0 + 44 + n * dy, 'xk2-life');
        steps.forEach((st, i) => {
          const y = y0 + 56 + i * dy, state = i < cur ? 'past' : i === cur ? 'now' : 'fut', a = st.r ? x2 : x1, b = st.r ? x1 : x2, k = state === 'now' ? Math.min(1, f * 1.4) : 1;
          s += arrow(a, y, a + (b - a) * k, y, `${st.c || ''} ${state}`);
          if (state === 'now' && k < 1) s += Dot(a + (b - a) * k, y, 5, '', `fill:${SD.kindColor(st.r ? 'job' : 'read')}`);
          s += `<text class="xk2-sl ${state}${st.c ? ' xk2-' + st.c : ''}" xml:space="preserve" x="${f1((x1 + x2) / 2)}" y="${f1(y - 7)}" text-anchor="middle">${ES(st.t)}</text>`;
        });
        return s;
      }
      function vStore() {
        let s = head('Объектное хранилище S3', 'никаких папок: только ключи-строки, объекты пишутся целиком и читаются кусками');
        s += R(24, 60, 400, 300, 'xk2-code', 10) + T(36, 80, 'КЛЮЧИ ОБЪЕКТОВ В БАКЕТЕ lake', 'xr-m');
        const keys = [['events/dt=2026-07-03/part-00000.parquet', '241 МБ'], ['events/dt=2026-07-03/part-00001.parquet', '256 МБ'], ['events/dt=2026-07-03/part-00002.parquet', '249 МБ'], ['…ещё 537 ключей с тем же началом', ''],
          ['events/dt=2026-07-04/part-00000.parquet', '238 МБ'], ['events/metadata/v12.metadata.json', '14 КБ'], ['events/metadata/snap-12-4f1c.avro', '6 КБ'], ['events/metadata/m-a1.avro', '38 КБ'], ['raw/events/2026/07/03/12/e-0001.json.gz', '61 МБ']];
        const hi = Math.floor(S.vt / 1600) % 3;
        keys.forEach(([k, sz], j) => {
          const y = 104 + j * 26, on = j === hi;
          if (on) s += R(30, y - 15, 388, 22, 'xk2-krow', 4);
          s += MONO(38, y, ES(cut(k, 46)), on ? 'on' : k.startsWith('…') ? 'dim' : '') + T(410, y, sz, 'xk2-ms', 'end');
        });
        s += T(36, 346, '«Папка» dt=2026-07-03/ — просто общее начало строк.', 'xk2-ms');
        const steps = [{ t: 'LIST prefix=events/dt=2026-07-03/' }, { t: '540 ключей (до 1 000 на страницу)', r: 1, c: 'ok' }, { t: 'GET part-00001 Range: bytes=-8' }, { t: 'длина футера: 48 213 байт', r: 1 }, { t: 'GET Range: bytes=255951787-256000000' }, { t: 'футер: схема, min/max, смещения', r: 1, c: 'ok' }, { t: 'GET Range: bytes=88104960-90202111' }, { t: '2 МБ — кусок колонки amount', r: 1, c: 'ok' }, { t: 'PUT part-00540.parquet (256 МБ целиком)', c: 'acc' }, { t: '200 OK — объект появился сразу', r: 1, c: 'ok' }];
        s += seq(530, 880, 60, ['Trino', 'S3'], steps, S.vt);
        s += R(24, 372, 952, 176, 'xk2-panel', 10);
        const facts = [['$23 за ТБ в месяц', 'хранить годы сырья дёшево'], ['20–50 мс до первого байта', 'зато сотни запросов параллельно'], ['дописать нельзя', 'изменение = новый объект'], ['Range-запросы', 'читаем только нужные байты файла']];
        facts.forEach(([a, b2], j) => { const x = 40 + j * 236; s += T(x, 400, a, 'xr-t') + T(x, 420, b2, 'xk2-ms'); });
        s += T(40, 456, 'Отсюда всё устройство озера: файлы не меняют, а пишут новые; читают кусками по диапазонам байт; «папки» — это префиксы ключей,', 'xr-s');
        s += T(40, 476, 'а знать, какие файлы сейчас составляют таблицу, должен кто-то ещё — каталог Hive или табличный формат Iceberg.', 'xr-s');
        s += T(40, 506, 'В жизни: AWS S3, GCS, Azure Blob, MinIO. Лимит ≈ 5 500 GET/с на префикс — поэтому большие таблицы раскладывают по многим префиксам.', 'xk2-ms');
        return s;
      }
      function vFmt() {
        const C = 12000, u = S.vt % C, kj = clamp((u - 400) / 9000, 0, 1), st = clamp(Math.floor((u - 400) / 1300), -1, 6);
        if (st >= 3) S.pv.fmtSkip = 1;
        let s = head('JSON против Parquet', 'один и тот же час событий: 256 МБ в Parquet и 1,9 ГБ в JSON. Сколько байт нужно прочитать?');
        s += SQL(30, 72, "SELECT sum(amount) FROM events WHERE event_type = 'purchase'") + SQL(30, 89, "  AND ts >= '2026-07-03 12:00' AND ts < '2026-07-03 13:00'");
        // JSON
        s += R(24, 100, 470, 350, 'xk2-panel' + (js() ? ' on' : ''), 10) + T(36, 120, 'JSON · events-0703-0012.json · 1,9 ГБ', 'xr-m') + T(36, 138, 'каждое событие — строка текста с именами полей; разбирать нужно всё', 'xk2-ms');
        const lines = Math.floor(kj * 8);
        EV_JSON.forEach((l, j) => {
          const y = 162 + j * 17, rd = j < lines || kj >= 1, on = j === lines && kj < 1;
          if (on) s += R(30, y - 12, 458, 16, 'xk2-krow', 3);
          const hlv = ES(l).replace(/(&quot;(?:ts|event_type|amount)&quot;:)(&quot;[^&]*&quot;|[\d.]+|null)/g, '$1<tspan class="xk2-need">$2</tspan>');
          s += `<text class="xk2-mono${rd ? '' : ' dim'}" xml:space="preserve" x="36" y="${y}">${hlv}</text>`;
        });
        for (let j = 0; j < 96; j++) s += R(36 + (j % 32) * 14, 312 + Math.floor(j / 32) * 14, 10, 10, 'xk2-pg' + (j < kj * 96 ? ' rd' : ''), 2);
        s += T(36, 370, '…и так ещё 6,4 млн строк: каждая клетка ≈ 20 МБ текста', 'xk2-ms');
        s += T(36, 400, `прочитано ${byt(1.9e9 * kj)} из 1,9 ГБ`, 'xr-m ' + (kj >= 1 ? 'warn' : '')) + T(36, 420, 'нужны 3 поля из 6, но читать приходится всё: в JSON нет «оглавления»', 'xk2-ms');
        // Parquet
        const PX = 512, PW = 464;
        s += R(PX - 6, 100, PW + 10, 350, 'xk2-panel' + (!js() ? ' on' : ''), 10) + T(PX + 6, 120, 'PARQUET · part-00012.parquet · 256 МБ', 'xr-m') + T(PX + 6, 138, 'группы строк, в каждой — кусок на колонку: id, ts, user, type, amt…', 'xk2-ms');
        const BX = PX + 6, BW = 280, steps = [['GET последних 8 байт', '→ длина футера'], ['GET футера (48 КБ):', 'схема, смещения, min/max'], ['по min/max ts нужна', 'только группа 3'], ['GET трёх кусков:', 'ts, event_type, amount'], ['готово: ≈ 2 МБ', 'вместо 256 МБ']];
        let y = 150;
        s += R(BX, y, BW, 14, 'xk2-pq m', 2) + T(BX + 6, y + 11, 'PAR1', 'xk2-fn'); y += 18;
        const RG = [['группа 1', '00:00…06:10'], ['группа 2', '06:10…11:58'], ['группа 3', '11:58…17:30'], ['группа 4', '17:30…23:59']];
        const colw = [['id', 0.2, 'event_id'], ['ts', 0.1, 'ts'], ['user', 0.12, 'user_id'], ['type', 0.12, 'event_type'], ['amt', 0.1, 'amount'], ['prod', 0.11, 'product_id'], ['sess', 0.25, 'session']];
        RG.forEach(([g, rng], i) => {
          const sk = st >= 2 && i !== 2, sel = st >= 2 && i === 2;
          s += `<g opacity="${sk ? 0.32 : 1}">`;
          s += R(BX, y, BW, 44, 'xk2-pq g' + (sk ? ' sk' : '') + (sel ? ' sel' : ''), 3) + T(BX + 6, y + 13, `${g} · ${rng}`, 'xk2-fn' + (sel ? ' xk2-acc' : ''));
          let cx = BX + 4;
          colw.forEach(([c, w, full]) => { const ww = (BW - 8) * w, need = sel && st >= 3 && ['ts', 'event_type', 'amount'].includes(full); s += R(cx, y + 19, ww - 2, 20, 'xk2-pq c' + (need ? ' rd' : ''), 2) + T(cx + 4, y + 33, c, 'xk2-fn sm' + (need ? ' xk2-acc' : '')); cx += ww; });
          s += '</g>';
          y += 48;
        });
        s += R(BX, y, BW, 42, 'xk2-pq f' + (st >= 0 && st <= 1 ? ' on' : st > 1 ? ' rd' : ''), 3) + T(BX + 6, y + 15, 'ФУТЕР: схема, смещения, min/max', 'xk2-fn') + T(BX + 6, y + 31, 'ts: г1 00:00–06:10 · г3 11:58–17:30 …', 'xk2-fn sm'); y += 46;
        s += R(BX, y, BW, 14, 'xk2-pq m' + (st === 0 ? ' on' : ''), 2) + T(BX + 6, y + 11, 'длина футера + PAR1', 'xk2-fn');
        steps.forEach(([a, b2], j) => { const c = j === st ? ' xk2-acc' : ''; s += T(PX + 296, 172 + j * 44, `${j + 1}.`, 'xr-m' + (j === st ? ' acc' : j < st ? ' ok' : '')) + T(PX + 314, 172 + j * 44, a, 'xk2-ms' + c) + T(PX + 314, 188 + j * 44, b2, 'xk2-ms' + c); });
        const pb = st < 0 ? 0 : st === 0 ? 8 : st === 1 ? 48e3 : st === 2 ? 48e3 : st === 3 ? 48e3 + 1.6e6 * clamp((u - 400 - 3 * 1300) / 1300, 0, 1) : 1.65e6;
        s += T(PX + 6, 432, `прочитано ${byt(pb)} из 256 МБ`, 'xr-m ok');
        // итог
        s += T(30, 478, 'СКОЛЬКО БАЙТ ПРОЧИТАЛ ЗАПРОС ЗА ЧАС', 'xr-m');
        s += T(30, 500, 'JSON', 'xr-s') + R(110, 490, 700, 12, 'xr-bar', 3) + R(110, 490, 700 * kj, 12, 'xr-bar-f warn', 3) + T(820, 500, byt(1.9e9 * kj), 'xr-m warn');
        s += T(30, 522, 'Parquet', 'xr-s') + R(110, 512, 700, 12, 'xr-bar', 3) + R(110, 512, Math.max(2, 700 * pb / 1.9e9), 12, 'xr-bar-f acc', 3) + T(820, 522, byt(pb), 'xr-m acc');
        s += T(30, 546, 'В тысячу раз меньше байт — и в тысячу раз дешевле: Athena берёт $5 за прочитанный терабайт.', 'xk2-ms');
        return s;
      }
      function vPart() {
        const C = 9000, u = S.vt % C, on = pt(), ic = ice(), k = clamp((u - 500) / 5200, 0, 1);
        let s = head('Папки по дате (партиции)', on ? 'запрос за 3 июля смотрит одну папку' : ic ? 'папок нет, но Iceberg знает min/max каждого файла' : 'папок нет: движок перебирает файлы за два года');
        s += SQL(30, 72, pt() ? "SELECT … FROM events WHERE dt = DATE '2026-07-03'" : "SELECT … FROM events WHERE ts >= '2026-07-03' AND ts < '2026-07-04'");
        s += R(24, 86, 520, 380, 'xk2-code', 10) + T(36, 106, 's3://lake/events/', 'xr-m acc');
        const tree = [];
        if (on) {
          ['2024-07-04', '…', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].forEach(d => tree.push([d === '…' ? '… ещё 723 папки' : `dt=${d}/`, d === '…' ? '' : d === '2026-07-05' ? '214 файлов' : '540 файлов', d === '2026-07-03']));
        } else ['20240704-00000' + ext(), '20240704-00001' + ext(), '… ≈ 394 тыс. файлов подряд', '20260703-00000' + ext(), '20260703-00001' + ext(), '…', '20260705-00213' + ext()].forEach(f => tree.push([f, f.startsWith('…') ? '' : '256 МБ', f.startsWith('20260703')]));
        tree.forEach(([n, info, tgt], j) => {
          const y = 132 + j * 32, hit = tgt && k > 0.3, scan = !on && !ic && k > 0 && !n.startsWith('…');
          s += R(40, y - 16, 490, 26, 'xk2-fold' + (hit ? ' rd' : scan ? ' sc' : ''), 5) + MONO(52, y, ES(n), hit ? 'on' : '') + T(518, y, info, 'xk2-ms', 'end');
        });
        if (!on && !ic) s += R(40, 132 - 16 + 6 * 32 * k, 490, 4, 'xk2-rdbar', 2);
        // сравнение
        const c = cost(QDAY), X = 566;
        s += R(X - 6, 86, 416, 380, 'xk2-panel', 10) + T(X + 6, 106, 'ЧТО СДЕЛАЕТ ДВИЖОК', 'xr-m');
        const rows2 = [['Запросов LIST', ic ? '0 — файлы из манифестов' : `${nf(Math.ceil(c.listed / 1000))} (по 1 000 ключей)`], ['Файлов открыть', nf(c.files)], ['Прочитать', byt(c.bytes)], ['Время', tms(c.ms)], ['Цена (Athena)', usd(c.cost)]];
        rows2.forEach(([a, b2], j) => { const y = 140 + j * 44; s += T(X + 6, y, a, 'xr-s') + T(X + 400, y, b2, 'xr-m ' + (j === 3 && c.ms > 6e4 ? 'bad' : j === 3 ? 'ok' : ''), 'end') + Ln(X + 6, y + 14, X + 400, y + 14, 'xk2-sep'); });
        s += T(X + 6, 372, on ? 'Путь dt=… сам говорит, что внутри. Одна страница LIST —' : ic ? 'Iceberg: манифесты хранят min/max ts каждого файла.' : 'Чтобы найти 3 июля, нужно открыть футер каждого файла', 'xr-s') + T(X + 6, 392, on ? 'и движок знает все файлы дня.' : ic ? 'Лишние файлы отбрасываются, даже не открываясь.' : 'и посмотреть его min/max ts. Это минуты и тысячи долларов.', 'xr-s');
        s += T(X + 6, 424, 'Iceberg: PARTITIONED BY (days(ts)) — папки', 'xk2-ms') + T(X + 6, 442, 'строятся сами, а запрос пишут по ts.', 'xk2-ms');
        s += T(30, 492, 'Не дробите слишком мелко: по часу и по пользователю — миллионы крошечных папок, и LIST снова становится узким местом.', 'xk2-ms');
        s += T(30, 512, 'Обычно делят по дню или месяцу, а внутри файлы сортируют по полю, по которому чаще фильтруют.', 'xk2-ms');
        return s;
      }
      function vSmall() {
        const C = 11000, u = S.vt % C, k = clamp((u - 2500) / 5500, 0, 1), merged = Math.floor(k * 4);
        let s = head('Мелкие файлы и уплотнение', 'данных одинаково, а открывать в 130 раз больше файлов');
        s += R(24, 60, 470, 300, 'xk2-panel', 10) + T(36, 80, 'dt=2026-07-05/ после потоковой записи', 'xr-m') + T(36, 98, '18 000 файлов по ≈ 2 МБ (на картинке 300 штук)', 'xk2-ms');
        for (let j = 0; j < 300; j++) {
          const grp = Math.floor(j / 75), gone = grp < merged, cmp = grp === merged && k > 0 && k < 1;
          s += R(36 + (j % 25) * 18, 112 + Math.floor(j / 25) * 19, 13, 13, 'xk2-sm' + (gone ? ' gone' : cmp ? ' cmp' : ''), 2);
        }
        s += R(510, 60, 466, 300, 'xk2-panel', 10) + T(522, 80, 'та же папка после уплотнения', 'xr-m') + T(522, 98, '140 файлов по ≈ 256 МБ — уплотняем четырьмя пачками', 'xk2-ms');
        for (let j = 0; j < 4; j++) { const on = j < merged, fl = j === merged - 1 && (u - 2500) % 1375 < 500; s += R(522, 112 + j * 58, 440, 48, 'xk2-file p' + (on ? '' : ' ghost') + (fl ? ' fl' : ''), 6) + T(534, 132 + j * 58, on ? `пачка ${j + 1}: big-${String(j * 35 + 1).padStart(4, '0')} … big-${String(j * 35 + 35).padStart(4, '0')}.parquet` : `пачка ${j + 1}: ещё не уплотнена`, 'xk2-fn') + T(534, 148 + j * 58, on ? '4 500 мелких по 2 МБ → 35 файлов по 256 МБ' : '4 500 мелких файлов ждут', 'xk2-ms'); }
        s += T(522, 352, ice() ? 'Iceberg: один коммит replace — читатели переключаются разом' : 'без Iceberg читатель может застать половину замены', 'xk2-ms' + (ice() ? ' xk2-ok' : ' xk2-warn'));
        // цена открытия
        const B = 380;
        s += T(30, B, 'СКОЛЬКО ВРЕМЕНИ УХОДИТ ТОЛЬКО НА ОТКРЫТИЕ ФАЙЛОВ (3 запроса к S3 по ≈ 25 мс, 160 параллельно)', 'xr-m');
        const a = 18000 * 3 * 25 / 160, b2 = 140 * 3 * 25 / 160;
        s += T(30, B + 26, '18 000 мелких', 'xr-s') + R(160, B + 16, 700, 12, 'xr-bar', 3) + R(160, B + 16, 700, 12, 'xr-bar-f warn', 3) + T(870, B + 26, tms(a), 'xr-m warn');
        s += T(30, B + 50, '140 больших', 'xr-s') + R(160, B + 40, 700, 12, 'xr-bar', 3) + R(160, B + 40, 700 * b2 / a, 12, 'xr-bar-f acc', 3) + T(870, B + 50, tms(b2), 'xr-m acc');
        s += T(30, B + 80, 'Плюс за каждый GET платят: миллионы мелких файлов — заметные деньги. И каждый файл тянет свой футер и свою статистику в память движка.', 'xk2-ms');
        s += SQL(30, B + 108, "CALL system.rewrite_data_files(table => 'lake.events', options => map('target-file-size-bytes', '268435456'))", 'sm');
        s += T(30, B + 130, `Уплотнение идёт пачками: ${merged} из 4 пачек готово. Старые мелкие файлы удалит expire_snapshots, когда истекут снимки, которые на них ссылаются.`, 'xk2-ms');
        return s;
      }
      function vIce() {
        const C = 14000, u = S.vt % C, on = ice();
        let s = head('Iceberg: дерево метаданных и атомарный коммит', on ? 'запись не трогает то, что видят читатели, пока не подменён один указатель' : 'сейчас Iceberg выключен (или формат JSON) — здесь показано, как он работает');
        const col = (x, y, w, t, sub, c) => R(x, y, w, 40, 'xk2-meta ' + (c || ''), 6) + T(x + 10, y + 17, t, 'xk2-fn') + T(x + 10, y + 32, sub, 'xk2-ms');
        const A = u > 1000, B = u > 2000, Cc = u > 3000, D = u > 4000, swap = u > 5200, bTry = u > 6200, bFail = u > 7000, bRe = u > 8200, bOk = u > 9800;
        const v = swap ? 13 : 12, v2 = bOk ? 14 : v;
        s += R(390, 64, 220, 46, 'xk2-cat' + (swap && u < 6000 ? ' fl' : bOk && u < 10600 ? ' fl' : ''), 8) + T(500, 84, 'КАТАЛОГ (REST / Glue)', 'xr-m', 'middle') + T(500, 101, `events → v${v2}.metadata.json`, 'xk2-fn xk2-acc', 'middle');
        // старая ветка
        const L0 = 120, R0 = 620;
        s += col(L0, 140, 260, 'v12.metadata.json', 'схема, снимки 10–12, текущий 12', swap ? 'old' : 'on');
        s += col(L0 + 20, 196, 240, 'snap-12.avro', 'список манифестов', swap ? 'old' : '');
        s += col(L0 + 40, 252, 104, 'm-a1.avro', '07-01…07-03', swap ? 'old' : '') + col(L0 + 156, 252, 104, 'm-b7.avro', '07-04…07-05', swap ? 'old' : '');
        // новая ветка писателя A
        if (A) s += col(R0 + 40, 308, 220, 'part-00541.parquet', 'новый файл данных', 'new');
        if (B) s += col(R0 + 40, 252, 104, 'm-c3.avro', '+ part-00541', 'new');
        if (Cc) s += col(R0 + 20, 196, 240, 'snap-13.avro', 'a1 + b7 + c3', 'new');
        if (D) s += col(R0, 140, 260, 'v13.metadata.json', 'снимки 10–13, текущий 13', swap ? 'on' : 'new');
        s += arrow(500, 110, swap ? R0 + 130 : L0 + 130, 140, swap ? 'acc' : '');
        if (B) s += arrow(R0 + 40, 272, L0 + 260 + 6, 272, 'dim');
        s += T(R0 - 20, 380, 'старые манифесты переиспользуются — ничего не копируется', 'xk2-ms');
        // файлы данных
        for (let j = 0; j < 6; j++) s += R(L0 + 40 + j * 40, 320, 34, 26, 'xk2-file p', 4);
        s += T(L0 + 40, 364, 'файлы данных (Parquet): их не трогаем', 'xk2-ms');
        // писатель B
        const bx = 30, by = 410;
        s += R(bx - 6, by - 20, 952, 140, 'xk2-panel', 10) + T(bx + 6, by, 'ДВА ПИСАТЕЛЯ ОДНОВРЕМЕННО', 'xr-m');
        const lineB = [['A: файлы → манифест → v13.metadata.json → подмена v12 → v13', swap ? 'ok' : '', swap ? 'прошла' : 'готовит'], ['B: тоже собрал свою v13 поверх v12 и пробует подмену v12 → v13', bFail ? 'bad' : '', bFail ? 'не прошла: указатель уже v13' : bTry ? 'пробует…' : 'ждёт'], ['B: перечитал v13, применил свои файлы заново → v14', bRe ? 'acc' : '', bRe ? 'собирает v14' : ''], ['B: подмена v13 → v14', bOk ? 'ok' : '', bOk ? 'прошла' : '']];
        lineB.forEach(([t, c, st], j) => { const y = by + 26 + j * 24; s += T(bx + 6, y, t, 'xr-s' + (c ? ' xk2-' + c : '')) + T(bx + 930, y, st, 'xr-m ' + (c === 'bad' ? 'bad' : c === 'ok' ? 'ok' : ''), 'end'); });
        if (bFail) S.pv.conflict = 1;
        s += T(bx + 6, by + 124, 'Подмена — это compare-and-swap: «поставь v13, только если сейчас v12». Читатели всегда видят целую версию — старую или новую, но никогда половину.', 'xk2-ms');
        return s;
      }
      function vSnap() {
        const on = ice(), C = 13000, u = S.vt % C;
        let s = head('Снимки и запрос «как было»', on ? 'каждый коммит — снимок; старые файлы живут, пока снимок не истёк' : 'без Iceberg снимков нет: перезапись стирает прошлое — здесь показано, как было бы с ним');
        const SN = [[10, 'append', '03.07 23:00', 'данные за 3 июля'], [11, 'append', '04.07 06:00', '+ ночь 4 июля'], [12, 'append', '04.07 09:58', '+ утро'], [13, 'overwrite', '04.07 10:15', 'пересчёт 3 июля с ошибкой'], [14, 'append', '04.07 12:00', '+ день']];
        const X = i => 90 + i * 200, Y = 130;
        s += Ln(60, Y, 960, Y, 'xk2-axis');
        const curI = u > 9000 ? 2 : 4, qI = u > 4000 && u <= 9000 ? 2 : -1;
        SN.forEach(([id, op, at, d], i) => {
          const bad = op === 'overwrite';
          s += `<circle class="xk2-snap${bad ? ' bad' : ''}${i === curI ? ' cur' : ''}" cx="${X(i)}" cy="${Y}" r="${i === curI ? 11 : 8}"/>` + T(X(i), Y - 22, `снимок ${id}`, 'xr-m' + (bad ? ' bad' : ''), 'middle') + T(X(i), Y + 30, op, 'xk2-fn' + (bad ? ' xk2-bad' : ''), 'middle') + T(X(i), Y + 46, at, 'xk2-ms', 'middle') + T(X(i), Y + 62, d, 'xk2-ms', 'middle');
        });
        s += `<polygon class="xk2-curm" points="${X(curI) - 8},${Y - 46} ${X(curI) + 8},${Y - 46} ${X(curI)},${Y - 36}"/>` + T(X(curI), Y - 52, 'текущий', 'xr-m acc', 'middle');
        if (qI >= 0) s += Ln(X(qI), Y + 70, X(qI), 230, 'xk2-q') + T(X(qI) + 8, 222, 'FOR TIMESTAMP AS OF 04.07 09:00 → снимок 12', 'xr-s xk2-acc');
        // какие файлы видит снимок
        s += R(24, 246, 952, 150, 'xk2-panel', 10) + T(36, 266, 'КАКИЕ ФАЙЛЫ ПАПКИ dt=2026-07-03 ВИДИТ СНИМОК', 'xr-m');
        const show = qI >= 0 ? 12 : curI === 2 ? 12 : 14;
        const good = ['part-00000', 'part-00001', 'part-00002', '… ещё 537'], bad = ['part-00000-r', 'part-00001-r', '… ещё 98'];
        good.forEach((f, j) => { const vis = show <= 12; s += R(40 + j * 132, 282, 122, 40, 'xk2-file p' + (vis ? ' rd' : ' ghost'), 5) + T(48 + j * 132, 300, f, 'xk2-fn') + T(48 + j * 132, 314, vis ? 'видим' : on ? 'лежит, но не в снимке' : 'стёрт', 'xk2-ms' + (vis ? ' xk2-ok' : on ? '' : ' xk2-bad')); });
        bad.forEach((f, j) => { const vis = show > 12; s += R(580 + j * 132, 282, 122, 40, 'xk2-file p bad' + (vis ? '' : ' ghost'), 5) + T(588 + j * 132, 300, f, 'xk2-fn') + T(588 + j * 132, 314, vis ? 'видим' : 'не в снимке', 'xk2-ms' + (vis ? ' xk2-bad' : '')); });
        s += T(40, 346, show > 12 ? 'Текущий снимок 14 видит перезаписанные файлы: выручка за 3 июля — 1,31 млрд ₽ вместо 6,24.' : qI >= 0 ? 'Запрос «как было» читает снимок 12: выручка за 3 июля — 6,24 млрд ₽. Старые файлы на месте.' : 'После отката текущий — снова снимок 12: данные верные, ничего не копировали.', 'xr-s ' + (show > 12 ? 'xk2-bad' : 'xk2-ok'));
        s += T(40, 370, on ? 'Старые файлы удалит expire_snapshots — после этого «как было» глубже недели не посмотреть.' : 'Без Iceberg перезапись удаляет старые файлы — «как было» не посмотреть, только пересчёт из bronze или бэкап.', 'xk2-ms' + (on ? '' : ' xk2-warn'));
        // команды
        s += R(24, 410, 952, 138, 'xk2-code', 10);
        const cmds = ["SELECT sum(amount) FROM events FOR TIMESTAMP AS OF '2026-07-04 09:00' WHERE dt = '2026-07-03'", "SELECT snapshot_id, committed_at, operation FROM lake.\"events$snapshots\"", "CALL system.rollback_to_snapshot('lake.events', 12)", "CALL system.expire_snapshots(table => 'lake.events', older_than => TIMESTAMP '2026-06-27 00:00')"];
        const ci = u < 4000 ? 1 : u <= 9000 ? 0 : 2;
        cmds.forEach((c, j) => { const y = 436 + j * 28; if (j === ci) s += R(30, y - 15, 940, 22, 'xk2-krow', 4); s += SQL(40, y, c, 'sm'); });
        return s;
      }
      function vSchema() {
        const on = ice(), C = 12000, u = S.vt % C, a1 = u > 1500, a2 = u > 3500;
        let s = head('Эволюция схемы', on ? 'Iceberg помнит колонки по номеру — переименование ничего не ломает' : 'без Iceberg колонки ищут по имени — смотри, что станет с отчётом');
        const cols = [[1, 'event_id', 'string'], [2, 'ts', 'timestamptz'], [3, 'user_id', 'long'], [4, 'event_type', 'string'], [5, a2 ? 'amount_rub' : 'amount', 'decimal(12,2)'], [6, 'coupon', 'string']];
        s += R(24, 60, 330, 250, 'xk2-panel', 10) + T(36, 80, 'СХЕМА ТАБЛИЦЫ events', 'xr-m') + T(342, 80, a2 ? 'версия 3' : a1 ? 'версия 2' : 'версия 1', 'xk2-ms', 'end');
        s += T(36, 102, on ? 'id' : '', 'xk2-fn') + T(76, 102, 'колонка', 'xk2-fn') + T(220, 102, 'тип', 'xk2-fn');
        cols.forEach(([id, n, t], j) => {
          if (id === 6 && !a1) return;
          const y = 126 + j * 26, nw = (id === 6 && a1 && u < 3000) || (id === 5 && a2 && u < 5000);
          if (nw) s += R(30, y - 16, 318, 22, 'xk2-krow', 4);
          s += T(36, y, on ? String(id) : '·', 'xr-m' + (on ? ' acc' : '')) + T(76, y, n, 'xk2-fn' + (nw ? ' xk2-acc' : '')) + T(220, y, t, 'xk2-ms');
        });
        s += SQL(36, 278, a1 ? 'ALTER TABLE events' : '-- исходная схема', 'sm') + (a1 ? SQL(36, 296, a2 ? 'RENAME COLUMN amount TO amount_rub' : 'ADD COLUMN coupon string', 'sm') : '');
        // два файла
        const F = (x, title, fields, sub) => { let t = R(x, 60, 300, 250, 'xk2-panel', 10) + T(x + 12, 80, title, 'xr-m') + T(x + 12, 98, sub, 'xk2-ms'); fields.forEach(([id, n, v, c], j) => { const y = 124 + j * 26; t += T(x + 12, y, on ? `id ${id}` : '', 'xk2-ms') + T(x + 60, y, n, 'xk2-fn') + T(x + 288, y, v, 'xk2-val ' + (c || ''), 'end'); }); return t; };
        const oldRead = on ? [[1, 'event_id', 'e-7f3a91'], [2, 'ts', '07-03 12:31'], [3, 'user_id', '55120'], [4, 'event_type', 'purchase'], [5, a2 ? 'amount_rub' : 'amount', '1290.00', 'on'], [6, 'coupon', a1 ? 'NULL' : '—', a1 ? 'mut' : '']]
          : [[1, 'event_id', 'e-7f3a91'], [2, 'ts', '07-03 12:31'], [3, 'user_id', '55120'], [4, 'event_type', 'purchase'], [5, a2 ? 'amount_rub' : 'amount', a2 ? 'NULL' : '1290.00', a2 ? 'bad' : 'on'], [6, 'coupon', a1 ? 'NULL' : '—', a1 ? 'mut' : '']];
        const newRead = [[1, 'event_id', 'e-9c0b17'], [2, 'ts', '07-05 10:02'], [3, 'user_id', '80441'], [4, 'event_type', 'purchase'], [5, a2 ? 'amount_rub' : 'amount', a2 ? '845.50' : '845.50', 'on'], [6, 'coupon', a1 ? 'SUMMER10' : '—']];
        s += F(370, 'СТАРЫЙ ФАЙЛ · 3 июля', oldRead, on ? 'записан со схемой 1: читаем по id' : 'записан с колонкой «amount»: ищем по имени');
        s += F(684, 'НОВЫЙ ФАЙЛ · 5 июля', newRead, a2 ? 'записан уже с «amount_rub» и coupon' : 'записан с той же схемой');
        // отчёт
        const R2 = 330;
        s += R(24, R2, 952, 120, 'xk2-panel' + (a2 && !on ? ' badb' : ' okb'), 10) + T(36, R2 + 22, 'ОТЧЁТ: SELECT dt, sum(amount_rub) FROM events GROUP BY dt', 'xr-m');
        const days = [['07-03', 6.24], ['07-04', 6.33], ['07-05', 2.77]];
        days.forEach(([d, v], j) => { const broken = a2 && !on && j < 2, y = R2 + 48 + j * 24; s += T(36, y + 10, d, 'xr-m') + R(100, y, 600, 13, 'xr-bar', 3) + R(100, y, broken ? 0 : 600 * v / 6.5, 13, 'xr-bar-f' + (broken ? ' bad' : ''), 3) + T(712, y + 10, broken ? 'NULL — в старых файлах нет amount_rub' : `${nf(v, 2)} млрд ₽`, 'xr-m ' + (broken ? 'bad' : 'ok')); });
        s += T(36, R2 + 140, on ? 'Iceberg: колонка 5 одна и та же, как её ни назови. Старые файлы не переписывали. coupon в старых файлах — NULL.' : 'Hive / JSON: в старых файлах колонка называется amount — по новому имени её не найти. Придётся переписать годы файлов или городить COALESCE.', 'xr-s ' + (on ? 'xk2-ok' : 'xk2-bad'));
        s += T(36, R2 + 160, 'Схемы событий согласуют заранее: реестр схем (Schema Registry) с правилами совместимости не пропустит переименование без договорённости.', 'xk2-ms');
        return s;
      }
      function vLayers() {
        const C = 10000, u = S.vt % C, k1 = clamp((u - 600) / 3200, 0, 1), k2 = clamp((u - 4400) / 2600, 0, 1);
        let s = head('Слои bronze → silver → gold', 'сырьё храним как есть, чистим в silver, считаем витрины в gold');
        const BR = [['{"event_id":"e-7f3a91","user_id":"55120","type":"purchase","amount":"1290.00"}', 'типы строкой', 'fix'], ['{"event_id":"e-7f3a91","user_id":"55120","type":"purchase","amount":"1290.00"}', 'дубль: повторная отправка', 'dup'],
          ['{"event_id":"e-7f3a93","user_id":80441,"type":"purchase","amount":845.5}', '', 'ok'], ['{"event_id":"e-test01","user_id":1,"type":"purchase","amount":1}', 'тестовое событие', 'test'], ['{"event_id":"e-7f3a95","user_id":12008,"type":"view"}', 'просмотр', 'ok']];
        s += R(24, 60, 952, 170, 'xk2-panel br', 10) + T(36, 80, 'BRONZE · bronze.events_raw', 'xr-m') + T(964, 80, 'JSON как пришло из Kafka · хранится годами', 'xk2-ms', 'end');
        BR.forEach(([l, why, c], j) => {
          const y = 104 + j * 24, done2 = k1 * 5 > j, cls = done2 ? (c === 'dup' || c === 'test' ? 'drop' : 'pass') : '';
          s += MONO(36, y, ES(cut(l, 86)), cls === 'drop' ? 'strike' : '') + (done2 && why ? T(964, y, (c === 'dup' || c === 'test' ? '✕ ' : '→ ') + why, 'xk2-ms ' + (c === 'dup' || c === 'test' ? 'xk2-bad' : 'xk2-acc'), 'end') : '');
        });
        s += arrow(500, 232, 500, 254, k1 > 0 ? 'acc' : '') + T(512, 248, 'чистка: типы, дубли по event_id, тестовые — прочь', 'xk2-ms');
        s += R(24, 258, 952, 136, 'xk2-panel si', 10) + T(36, 278, 'SILVER · silver.events (Iceberg, Parquet)', 'xr-m') + T(964, 278, 'event_id string · ts timestamptz · user_id bigint · event_type string · amount decimal(12,2)', 'xk2-ms', 'end');
        const SI = [['e-7f3a91', '2026-07-03 12:31:07', '55120', 'purchase', '1290.00'], ['e-7f3a93', '2026-07-03 12:31:09', '80441', 'purchase', '845.50'], ['e-7f3a95', '2026-07-03 12:31:20', '12008', 'view', 'NULL']];
        const sx = [36, 160, 330, 430, 560];
        ['event_id', 'ts', 'user_id', 'event_type', 'amount'].forEach((h, j) => { s += T(sx[j], 302, h, 'xk2-fn'); });
        SI.forEach((r, j) => { if (k1 * 3 > j) r.forEach((v, i) => { s += T(sx[i], 326 + j * 22, v, 'xk2-val' + (i === 2 || i === 4 ? ' on' : '')); }); });
        s += arrow(500, 396, 500, 418, k2 > 0 ? 'acc' : '') + T(512, 412, 'агрегат: GROUP BY day, country', 'xk2-ms');
        s += R(24, 422, 952, 126, 'xk2-panel go', 10) + T(36, 442, 'GOLD · gold.revenue_daily', 'xr-m') + T(964, 442, 'готово для дашбордов и ClickHouse', 'xk2-ms', 'end');
        const GO = [['2026-07-03', 'RU', '3 618 990 210,00', '1 945 380'], ['2026-07-03', 'KZ', '936 120 550,00', '503 118'], ['2026-07-03', 'BY', '624 080 300,00', '335 412']];
        const gx = [36, 160, 400, 560];
        ['day', 'country', 'revenue', 'orders'].forEach((h, j) => { s += T(gx[j], 466, h, 'xk2-fn'); });
        GO.forEach((r, j) => { if (k2 * 3 > j) r.forEach((v, i) => { s += T(gx[i], 490 + j * 20, v, 'xk2-val' + (i >= 2 ? ' on' : '')); }); });
        return s;
      }
      const VIEWS = { store: vStore, fmt: vFmt, part: vPart, small: vSmall, ice: vIce, snap: vSnap, schema: vSchema, layers: vLayers };
      function partNow(k) {
        const c = cost(QDAY);
        if (k === 'store') return '<b>S3 — это ключи и байты.</b> «Папка» — общее начало ключей, LIST отдаёт их страницами по 1 000. Файл пишут целиком (PUT), а читают кусками по диапазону байт (GET Range): так читатель берёт только футер и нужные колонки.';
        if (k === 'fmt') return '<b>JSON разбирают целиком</b>, даже если нужно 3 поля из 7. <b>Parquet</b> начинают читать с конца: длина футера → футер со схемой и min/max → только группа строк нужного часа → только 3 куска колонок. ≈ 2 МБ вместо 1,9 ГБ.';
        if (k === 'part') return pt() ? `<b>Папка по дате:</b> запрос за 3 июля — это LIST одного префикса и ${nf(c.files)} файлов. Остальные 729 дней не трогаются.` : ice() ? '<b>Скрытые партиции Iceberg:</b> папок нет, но в манифестах записан min/max ts каждого файла — лишние файлы отброшены без открытия.' : `<b>Без папок и без Iceberg</b> движок перечисляет ≈ ${nf(c.listed)} ключей и открывает каждый футер. Запрос ≈ ${tms(c.ms)}.`;
        if (k === 'small') return '<b>Мелкие файлы:</b> данных столько же, но каждый файл — несколько запросов к S3 по десятки миллисекунд. Уплотнение переписывает мелкие файлы пачками в большие — и открывать нужно в 130 раз меньше.';
        if (k === 'ice') return '<b>Коммит Iceberg</b> строит новую ветку метаданных рядом со старой и в конце подменяет один указатель в каталоге. Писатель, который опоздал, получает отказ подмены и повторяет коммит поверх новой версии.';
        if (k === 'snap') return '<b>Снимки:</b> ошибочный пересчёт — это просто снимок 13. Запрос «как было» читает снимок 12, откат возвращает указатель на него. Старые файлы удалит expire_snapshots по сроку.';
        if (k === 'schema') return ice() ? '<b>Колонки по номеру:</b> amount и amount_rub — это колонка 5. Старые файлы читаются как раньше, новой колонке coupon в них соответствует NULL.' : '<b>Колонки по имени:</b> после переименования в старых файлах нет amount_rub — выручка за прошлые дни в отчёте превращается в NULL.';
        if (k === 'layers') return '<b>Слои:</b> bronze хранит всё как пришло, silver чистит (типы, дубли, тестовые события), gold считает агрегаты. Ошибка в чистке? Исправили — и пересчитали silver из bronze.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.days) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'fmt' && S.pv.fmtSkip) done('pfmt'); if (pk === 'ice' && S.pv.conflict) done('pice'); }
        scnStep();
        for (const w of S.ws) if (!w.gone && S.t >= w.p0 + w.dur) landFile(w);
        S.ws = S.ws.filter(w => !w.gone);
        if (S.scn === 'commit' && ice() && S.conflictT > 0 && S.t >= S.conflictT && S.cfLog !== S.conflictT) S.cfLog = S.conflictT, note('cf', '<b>Конфликт писателей:</b> второй писатель пытался подменить указатель с той же старой версии — подмена не прошла, он перечитал метаданные и повторил коммит.', 'warn', 5000);
        qStep();
        S.fx = S.fx.filter(f => S.t - f.t0 < 1300); S.hist = S.hist.filter(h => h.t > S.t - 15000);
      }
      function draw() {
        if (!S.days) return;
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
          if (cfgSig() !== S.cfg) { const keepDn = S.dn, keepF = S.flags; reset(); S.dn = keepDn; S.flags = Object.assign(S.flags, keepF); }
          if (key === 'format') return v === 'json' ? 'JSON: файлы в 7 раз больше, запрос читает всё подряд — смотри байты и цену в окне запроса. Iceberg с JSON не работает.' : 'Parquet: колонки и футер со статистикой — запрос читает только нужное.';
          if (key === 'partitioned') return v ? 'Папки по дате: запрос за день смотрит один префикс.' : ice() ? 'Папок нет, но Iceberg найдёт файлы дня по min/max в манифестах — сравни время.' : 'Папок нет и Iceberg выключен: LIST всей таблицы и футер каждого файла за два года.';
          if (key === 'iceberg') return v ? (js() ? 'Iceberg включён, но с JSON он не работает — переключи формат на Parquet.' : 'Iceberg: метаданные справа сверху, каждая запись — подмена указателя, есть снимки и «как было».') : 'Без Iceberg: файлы ищут через LIST папок, нет снимков, атомарных коммитов и колонок по номеру.';
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const c = cost(qDay()), td = S.days[TODAY];
          if (S.scn === 'small') return `<b>Мелкие файлы:</b> поток кладёт файл каждые пару секунд, и в папке dt=2026-07-05 уже ${nf(td.cnt)} файлов. Запрос за этот день открывает каждый: ≈ ${tms(c.openMs)} уходит только на открытие. ${S.cmp ? '<b>Идёт уплотнение</b> — мелкие файлы склеиваются в один большой.' : 'Скоро придёт уплотнение (compaction) и склеит их.'}`;
          if (S.scn === 'travel') {
            const e = S.ev;
            if (!e) return '<b>Скоро ночной пересчёт</b> перезапишет папку dt=2026-07-03, и в нём будет ошибка. Смотри, что можно сделать после.';
            if (e.ph === 'bad') return ice() ? '<b>Данные за 3 июля испорчены</b>, но Iceberg хранит снимки: запрос FOR TIMESTAMP AS OF \'2026-07-04 09:00\' читает старые файлы — они ещё лежат. Скоро откатим: rollback_to_snapshot.' : '<b>Данные за 3 июля испорчены, а старые файлы стёрты.</b> Без табличного формата нет снимков: «как было» не посмотреть, откатить нечем — только пересчёт из bronze или бэкапа.';
            return ice() ? '<b>Откатили одной командой:</b> указатель «текущий снимок» вернулся на 12, ничего не копировали.' : '<b>Данные перезалили заново</b> — в жизни это часы работы.';
          }
          if (S.scn === 'schema') return !S.ev ? '<b>Скоро источник сменит схему:</b> добавит coupon и переименует amount в amount_rub.' : ice() ? '<b>Схема сменилась, отчёт цел.</b> Iceberg помнит колонку по номеру: amount_rub — это та же колонка 5, старые файлы читаются как раньше, coupon в них — NULL.' : '<b>Схема сменилась — отчёт поехал.</b> Движок ищет amount по имени, а в новых файлах её нет: там NULL, и выручка за 5 июля «падает». Включи Iceberg и Parquet.';
          if (S.scn === 'commit') return ice() ? '<b>Атомарный коммит.</b> Пока пачка пишется, её файлы лежат в бакете, но ни один снимок на них не ссылается — читатель их не видит. В конце указатель подменяется, и вся пачка появляется разом. Второй писатель, опоздавший с подменой, повторяет коммит.' : '<b>Без табличного формата</b> читатель делает LIST папки и видит файлы пачки по мере записи — может посчитать по половине данных. А если писатель упадёт посередине, недописанная пачка так и останется видна.';
          const head = js() ? `<b>JSON:</b> чтобы посчитать выручку за день, движок читает ${byt(c.bytes)} текста — ≈ ${usd(c.cost)} за запрос.` : `<b>Parquet:</b> из дня ≈ ${byt(c.bytes)} — только колонки event_type и amount, ≈ ${usd(c.cost)} за запрос.`;
          const part = pt() ? ` Папки по дате: движок смотрит одну папку из ${LAKE_DAYS}.` : ice() ? ' Папок по дате нет, но Iceberg находит файлы дня по min/max в манифестах.' : ` <b>Папок по дате нет и Iceberg выключен</b> — перебор ≈ ${nf(c.listed)} файлов за два года, ≈ ${tms(c.ms)}.`;
          return head + part + (ice() ? ' Каждый новый файл конвейера — новый снимок: указатель в каталоге подменяется (вспышка справа сверху).' : '');
        },
        stats() {
          const L = S.last, c = L ? L.c : cost(qDay()), td = S.days[TODAY];
          return [
            ['Запрос за день', tms(c.ms), c.ms > 6e4 ? 'bad' : c.ms > 8000 ? 'warn' : 'ok', S.scn === 'small' ? 'день с мелкими файлами' : `${js() ? 'JSON' : 'Parquet'}${pt() ? ' · папки по дате' : ' · без папок'}`],
            ['Прочитано', byt(c.bytes), c.bytes > 1e11 ? 'bad' : c.bytes > 2e10 ? 'warn' : '', 'за один запрос'],
            ['Цена запроса', usd(c.cost), c.cost > 1 ? 'bad' : c.cost > 0.2 ? 'warn' : 'ok', 'Athena: $5 за ТБ'],
            ['Файлов открыто', nf(c.files), c.files > 5000 ? 'warn' : '', ice() ? 'список из манифестов' : 'через LIST'],
            ['В папке дня', nf(td.cnt), (td.small || 0) > 30 ? 'warn' : '', td.small ? `из них мелких ${nf(td.small)}` : 'файлов на 5 июля'],
            ['Снимков', ice() ? String(S.ver) : 'нет', ice() ? 'ok' : 'warn', ice() ? `текущий ${S.snap}` : 'без Iceberg']
          ];
        },
        destroy() {}
      };
    }
  };
})();
