/* «Провалиться внутрь» реляционной БД: соединения, планировщик, буферный кэш, журнал WAL, коммит, реплики, шарды, блокировки. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const FR = 40, K = 12, TAPE = 9, LSN0 = 1041;
  const RAM = { s: 8, m: 32, l: 64, xl: 128 };
  const USERS = ['Аня', 'Борис', 'Вера', 'Гоша', 'Дина', 'Егор', 'Жанна', 'Зоя', 'Илья', 'Кира'];
  const SEATS = ['7A', '7B', '7C', '7D', '8A', '8B', '8C', '8D', '9A', '9B', '9C'];
  const ISO = { rc: 'Read Committed', rr: 'Repeatable Read', ser: 'Serializable' };
  const LOCK = { none: 'блокировок в коде нет', optimistic: 'оптимистичная (version)', pessimistic: 'SELECT … FOR UPDATE' };
  const qf = u => 1 + Math.pow(Math.max(u, 0), 3) / (1 - Math.min(u, 0.95));
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const pc = v => Math.round((v || 0) * 100) + ' %';
  const ms = v => SD.fmt.ms(v);
  const rnd = n => Math.floor(Math.random() * n);
  const pl = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const Z = { x: 198, y: 66, w: 544, h: 486 };
  const CB = { x: 212, y: 110, w: 132, h: 174 }, PB = { x: 356, y: 110, w: 120, h: 174 }, BB = { x: 492, y: 110, w: 238, h: 190 };
  const DK = { x: 492, y: 314, w: 238, h: 62 }, LK = { x: 212, y: 322, w: 264, h: 108 }, WB = { x: 212, y: 440, w: 518, h: 104 };
  const RX = 772, RW = 214, DOOR = [206, 196], LANE = 58, BUSX = 750, LANEX = 760, ROUTER = [158, 31];
  const slotR = k => [226 + (k % 4) * 28, 166 + Math.floor(k / 4) * 28];
  const slotC = k => { const [x, y] = slotR(k); return [x + 11, y + 11]; };
  const cellR = i => [502 + (i % 8) * 28, 156 + Math.floor(i / 8) * 21];
  const cellC = i => { const [x, y] = cellR(i); return [x + 12, y + 8.5]; };
  const qPos = i => [224 + i * 15, 299];
  const tapeX = i => 226 + i * 46;
  const GATE = [685, 487];
  const ROOT = [414, 171], BR = [[386, 199], [442, 199]], LEAF = [[372, 227], [400, 227], [428, 227], [456, 227]];
  const ROW = [300, 402];
  const thinkPos = k => [240 + (k % 8) * 22, 405];
  const lqPos = i => [422 + i * 22, 376];
  const diskPos = i => [690 + i * 22, 337];
  const dqPos = i => [684 + i * 12, 360];
  const cwPos = i => [660 + i * 12, 531];
  const serp = k => { const row = k >> 3, c = row % 2 ? 7 - (k & 7) : (k & 7); return row * 8 + c; };

  function plen(pts) { const seg = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); tot += d; } return { seg, tot }; }
  function along(pts, L, f) {
    let d = cl(f, 0, 1) * L.tot;
    for (let i = 0; i < L.seg.length; i++) {
      if (d <= L.seg[i] || i === L.seg.length - 1) { const k = L.seg[i] ? Math.min(1, d / L.seg[i]) : 1; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
      d -= L.seg[i];
    }
    return pts[pts.length - 1];
  }

  SD.XRAY.sql = {
    viewBox: '0 0 1000 560',
    cta: 'Соединения, планировщик, кэш страниц, журнал WAL, реплики и блокировки — вживую',
    dive: 'replication',
    simple: () => ({
      an: 'База — как <b>архив с картотекой</b>. У входа несколько окошек приёма (соединения). Архивариус решает: найти папку по каталогу (индекс) или перебрать все полки. Ходовые папки лежат на столе (память), остальные — в подвале (диск). Каждую правку он сначала записывает в журнал под номером, а копии журнала везут в филиалы (реплики).',
      pl: 'Синяя точка — запрос «прочитать», фиолетовая — «записать». Смотри, где точка ждёт, где ныряет на диск и как журнал течёт к репликам.'
    }),
    props: ['size', 'idx', 'replicas', 'replMode', 'ryw', 'shards', 'shardKey', 'isolation', 'locking', 'pooler'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Нагрузка и настройки — как на площадке.' },
      { id: 'hot', name: 'Толкучка за одну строку', note: 'Трое одновременно бронируют одно последнее место.' },
      { id: 'spill', name: 'Данные не влезают в память', note: 'Таблица с индексами весит ≈ 120 ГБ — больше памяти сервера. Чтения здесь идут на primary, чтобы было видно его память; у реплик всё так же.' },
      { id: 'ryw', name: 'Запись и сразу чтение', note: 'Пользователь оформил заказ и сразу открыл «Мои заказы». Реплики нагружены и отстают на пару секунд.' },
      { id: 'fail', name: 'Primary упал', note: 'Главный сервер падает каждые ~10 секунд. Реплики отстают ≈ на секунду.' },
      { id: 'conns', name: 'Много клиентов', note: 'Сервис раздули до 34 экземпляров, каждый держит пул из 10 соединений.' }
    ],
    tries: [
      { id: 'sync', text: 'Поставь репликацию «Синхронная» и посмотри, как запись ждёт реплику у коммита' },
      { id: 'ser', text: 'В «Толкучке» переключи изоляцию на Serializable: двойная бронь пропадает, зато появляются откаты' },
      { id: 'lost', text: 'В «Primary упал» при асинхронной репликации посчитай, сколько подтверждённых записей потерялось' },
      { id: 'ryw', text: 'В «Запись и сразу чтение» включи «Читать свои записи с primary»: заказ виден сразу' },
      { id: 'idx', text: 'Убери индекс (кнопка под планировщиком или в его разборе): каждое чтение пробегает всю таблицу и дольше держит соединение' },
      { id: 'pool', text: 'Открой блок «Соединения» и выключи пул: каждый запрос сначала тратит время на рукопожатие' },
      { id: 'clock', text: 'В ситуации «Данные не влезают» открой блок «Буферный кэш»: посмотри, как стрелка часов выбирает страницу на вытеснение' },
      { id: 'walrec', text: 'Открой блок «Журнал WAL» и урони сервер: память пропадёт, а журнал вернёт все подтверждённые записи' }
    ],
    parts: {
      conn: {
        name: 'Соединения', view: true, knobs: ['pooler'],
        an: 'Как <b>телефонные линии в справочную</b>: линий мало, а дозвониться заново долго. Поэтому сервис держит несколько линий открытыми и передаёт трубку тому запросу, кто сейчас говорит.',
        pl: 'Чтобы что-то спросить у базы, нужно соединение. На каждое база заводит отдельный процесс со своей памятью, поэтому соединений немного — обычно 100–200 на сервер.',
        how: ['<b>Открыть</b> соединение дорого: сетевое рукопожатие (TCP), шифрование (TLS), проверка пароля и запуск процесса — несколько миллисекунд.',
          'Поэтому у каждого экземпляра сервиса есть <b>пул</b>: например, 10 соединений открыты заранее и ждут.',
          'Запрос <b>берёт</b> свободное соединение, выполняет SQL и <b>возвращает</b> его — за доли миллисекунды.',
          'Свободных нет — запрос <b>ждёт в очереди</b> пула. Здесь первой растёт задержка под нагрузкой.',
          'База держит не больше <b>max_connections</b>. Экземпляров стало много — каждому свой пул — и новые получают «too many clients».',
          '<b>PgBouncer</b> стоит между сервисами и базой: принимает сотни клиентских соединений, а в базу держит пару десятков и выдаёт их только на время транзакции.'],
        watch: 'Квадратики в экземплярах — соединения пула: цветной занят запросом. Справа — процессы базы, по одному на соединение. Кнопка «выключить пул» показывает, сколько времени уходит на рукопожатие, если подключаться каждый раз заново.',
        real: 'PostgreSQL: max_connections по умолчанию 100, на практике 200–500; процесс на соединение — ≈ 5–10 МБ. HikariCP (Java) по умолчанию держит 10 соединений. PgBouncer в режиме transaction: 1 000+ клиентов → 20–50 серверных соединений.'
      },
      plan: {
        name: 'Планировщик', view: true, knobs: ['idx'],
        an: 'Как <b>библиотекарь</b>: прежде чем искать книгу, прикидывает — пойти по каталогу (индекс) или обойти все полки подряд — и выбирает, что быстрее.',
        pl: 'Запрос — это текст. База сначала понимает его, потом придумывает несколько способов найти данные, оценивает цену каждого и выполняет самый дешёвый.',
        how: ['<b>Разбор</b>: база читает текст SQL, проверяет синтаксис, находит таблицу и колонки.',
          '<b>Варианты</b>: перебрать всю таблицу (Seq Scan) или пройти по индексу (Index Scan) — если индекс по нужной колонке есть.',
          '<b>Цена</b> считается по статистике: сколько страниц прочитать и сколько строк проверить.',
          '<b>Выбор</b>: побеждает самый дешёвый план. Без индекса выбирать не из чего — только перебор.',
          '<b>Index Scan</b>: спуск по B-дереву — корень → ветка → лист (3–4 шага даже для миллиона строк) → страница со строкой.',
          '<b>Seq Scan</b>: чтение всех страниц подряд с проверкой каждой строки. На большой таблице — в тысячи раз дольше.'],
        watch: 'Сверху текст запроса, ниже две карточки-варианта с ценой. Внизу — выполнение: спуск по дереву или пробег по всем страницам. Строка EXPLAIN — то, что база показала бы на самом деле. Кнопка «убрать индекс» под блоком на общей картинке меняет настройку узла.',
        real: 'EXPLAIN ANALYZE покажет выбранный план и время. B-дерево на 1 млн строк — 3 уровня; таблица 100 МБ — ≈ 12 500 страниц по 8 КБ. Планировщик опирается на статистику ANALYZE: устарела — может выбрать плохой план.'
      },
      buf: {
        name: 'Буферный кэш', view: true, knobs: ['size'],
        an: 'Как <b>рабочий стол</b> архивариуса: на столе помещается 30 папок, остальные — в подвале. Нужную папку ищут сначала на столе. Нет — несут из подвала, а со стола убирают ту, что давно не открывали.',
        pl: 'База хранит данные страницами по 8 КБ и держит часть страниц в оперативной памяти. Нашлась в памяти — ответ мгновенный, нет — читаем с диска.',
        how: ['Запрос просит <b>страницу №N</b> таблицы или индекса.',
          'База ищет её в <b>хеш-таблице</b> буферов: номер страницы → ячейка памяти. Это быстрая проверка «есть или нет».',
          '<b>Попадание</b>: страница в памяти, её счётчик использования растёт.',
          '<b>Промах</b>: нужна свободная ячейка. «Стрелка часов» идёт по кругу и уменьшает счётчики; первая ячейка со счётчиком 0 освобождается.',
          'Если вытесняемая страница <b>изменена</b> («грязная»), её сначала записывают на диск.',
          'Нужную страницу читают с диска в освободившуюся ячейку. <b>Checkpoint</b> время от времени сбрасывает все грязные страницы на диск.'],
        watch: 'Каждая ячейка — страница в памяти, точки — счётчик использования. Треугольник — стрелка часов. Зелёная вспышка — попадание, красная — вытеснение, оранжевая — страница пришла с диска, фиолетовая рамка — изменённая страница. В ситуации «Данные не влезают» стрелка крутится постоянно.',
        real: 'PostgreSQL: shared_buffers обычно ≈ 25 % памяти сервера, страница 8 КБ, вытеснение — clock-sweep со счётчиком usage_count до 5. Доля попаданий у здоровой базы — 99 % и выше. Часть данных ещё кэширует операционная система.'
      },
      disk: {
        name: 'Диск', view: true, knobs: ['size'],
        an: 'Как <b>подвал архива</b>: там лежит всё, но спуститься туда в сотни раз дольше, чем взять папку со стола.',
        pl: 'Всё, что хранит база, в итоге лежит на диске: файлы таблиц и индексов страницами по 8 КБ и файлы журнала. Диск переживает выключение, память — нет.',
        how: ['Таблица — это <b>файл</b>, разбитый на страницы по 8 КБ. Индекс — отдельный файл.',
          '<b>Случайное чтение</b> страницы с SSD — ≈ 0,1 мс: в сотни раз дольше, чем из памяти.',
          '<b>Последовательные</b> чтение и запись (журнал, Seq Scan) идут намного быстрее, чем вразнобой.',
          'У диска есть предел операций в секунду (<b>IOPS</b>). Запросов больше — растёт очередь.',
          '<b>Журнал WAL</b> только дописывается в конец и подтверждается fsync при каждом коммите.',
          '<b>Checkpoint</b> пачками записывает изменённые страницы из памяти в файлы таблиц.'],
        watch: 'Сверху — сравнение скоростей. Ниже — файл таблицы по страницам и файл журнала. Внизу очередь к диску: оранжевые — случайные чтения, фиолетовые — дописывание журнала, голубые — checkpoint.',
        real: 'NVMe SSD: сотни тысяч IOPS, случайное чтение ≈ 0,1 мс. Облачный диск AWS gp3 по умолчанию — 3 000 IOPS. HDD — ≈ 100–200 IOPS. Файлы PostgreSQL лежат в каталоге base/, журнал — в pg_wal/ сегментами по 16 МБ.'
      },
      lock: {
        name: 'Блокировки и изоляция', view: true, knobs: ['isolation', 'locking'],
        an: 'Как <b>бронирование последнего места</b> двумя кассирами одновременно: оба видят «свободно» и оба продают. Нужно правило, кто ждёт, а кто перепроверяет.',
        pl: 'Транзакции идут одновременно. Уровень изоляции решает, что каждая видит, а блокировки — кому ждать. Без правил два изменения одной строки могут затереть друг друга.',
        how: ['Каждая транзакция работает со <b>снимком</b> данных: UPDATE не стирает строку, а создаёт её <b>новую версию</b> (MVCC).',
          '<b>Read Committed</b>: каждый запрос видит последние подтверждённые версии. Двое могут прочитать «свободно» и оба записать — второй затрёт первого.',
          '<b>Repeatable Read</b>: строку изменили после моего снимка — моя запись получает ошибку, транзакция откатывается и повторяется.',
          '<b>Serializable</b>: то же, плюс ловит конфликты между разными строками (write skew). Откатов больше всего.',
          '<b>FOR UPDATE</b> (пессимистично): первая запирает строку, вторая ждёт в очереди и потом видит свежие данные.',
          '<b>Version</b> (оптимистично): запись «если версия всё ещё 1»; опоздавший получает 0 строк и повторяет.'],
        watch: 'Две дорожки — транзакции Ани и Бориса во времени. Вертикальная линия бежит слева направо: смотри, кто что видит, где ожидание (красная полоса), откат или затирание. Сверху — версии строки. Поменяй изоляцию или блокировки справа — сценарий перестроится.',
        real: 'PostgreSQL по умолчанию — Read Committed. Ошибка сериализации — SQLSTATE 40001 «could not serialize access», приложение должно повторить транзакцию. Старые версии строк потом убирает VACUUM.'
      },
      wal: {
        name: 'Журнал WAL', view: true, knobs: ['replMode'],
        an: 'Как <b>бортовой журнал</b>: прежде чем что-то менять, записываешь «собираюсь сделать вот это». Случилась авария — открываешь журнал и доделываешь записанное.',
        pl: 'Каждое изменение сначала дописывается в журнал на диске, и только потом база говорит «готово». Сами таблицы на диске можно обновить позже — по журналу всё восстановится.',
        how: ['Изменение идёт в память: страница становится «грязной», а в <b>буфер журнала</b> добавляется запись с номером (LSN).',
          'При <b>COMMIT</b> буфер журнала сбрасывается в файл на диске и подтверждается <b>fsync</b>. Теперь запись не потеряется.',
          'Только после этого клиент получает «готово».',
          '<b>Checkpoint</b> время от времени пишет грязные страницы в файлы таблиц и отмечает: «до номера X всё уже в таблицах».',
          '<b>Падение</b>: память пропала. При старте база читает журнал от последнего checkpoint и заново применяет записи.',
          'Тот же журнал по сети получают <b>реплики</b> — так они повторяют все изменения.'],
        watch: 'Верх — память, низ — диск. Запись появляется в буфере журнала и в странице, при коммите опускается в файл журнала. Нажми «Уронить сервер»: память очистится, потом база восстановит страницы по журналу.',
        real: 'PostgreSQL: каталог pg_wal, сегменты по 16 МБ, позиция — LSN (например, 0/16B3A28). synchronous_commit = on — ждать fsync при коммите. Checkpoint — раз в checkpoint_timeout (5 минут) или по объёму max_wal_size.'
      },
      repl: {
        name: 'Реплики', view: true, knobs: ['replicas', 'replMode', 'ryw'],
        an: 'Как <b>филиалы архива</b>: им рассылают копии журнала, и они повторяют у себя все правки. Почта идёт с задержкой — филиал может ещё не знать о последней правке.',
        pl: 'Реплика — копия базы на другом сервере. Она получает журнал главного сервера и применяет его. С неё можно читать, но данные могут немного отставать.',
        how: ['Primary дописывает журнал и потоком отправляет его репликам (<b>walsender → walreceiver</b>).',
          'Реплика сохраняет полученное (<b>получено до №…</b>) и применяет к своим таблицам (<b>применено до №…</b>).',
          'Читатель реплики видит только <b>применённое</b>. Разница с primary — это <b>лаг</b>.',
          '<b>Асинхронно</b>: primary говорит «готово», не дожидаясь реплик. Быстро, но упадёт primary — хвост журнала пропадёт.',
          '<b>Полусинхронно / синхронно</b>: коммит ждёт подтверждения одной или всех реплик. Надёжнее, но каждая запись дольше.',
          'Primary упал — самую свежую реплику повышают до primary (<b>failover</b>).'],
        watch: 'Слева журнал primary, по проводам едут записи, справа у каждой реплики две отметки: получено и применено. Зелёные точки обратно — подтверждения. Внизу — текущий режим и чего ждёт коммит.',
        real: 'PostgreSQL streaming replication: режимы задаются synchronous_commit и synchronous_standby_names (ANY 1 — «полусинхронно»). Лаг видно в pg_stat_replication (replay_lag). Failover делают Patroni или облачный сервис.'
      },
      shard: {
        name: 'Шарды', view: true, knobs: ['shards', 'shardKey'],
        an: 'Как <b>архив, разделённый по буквам фамилий</b>: А–Ж в одном здании, З–О в другом. Чтобы найти дело, сначала смотрят на букву и идут в нужное здание.',
        pl: 'Когда один сервер не справляется с записью или объёмом, данные делят на части по ключу. Каждая часть — шард — живёт на своём сервере со своими репликами.',
        how: ['У каждой строки есть <b>ключ шардирования</b>, например user_id.',
          '<b>Роутер</b> вычисляет шард по ключу: hash(user_id) % N — поровну; по датам или регионам — диапазонами.',
          'Запрос с ключом идёт <b>в один шард</b> — быстро и дёшево.',
          'Запрос без ключа (отчёт по всем) идёт <b>во все шарды</b>, ответы склеиваются — медленно.',
          'Неудачный ключ даёт <b>горячий шард</b>: по датам все новые записи летят в последний.',
          'JOIN и транзакции между шардами сложны — данные одного пользователя держат в одном шарде.'],
        watch: 'Слева роутер считает шард по ключу запроса. Справа шарды с долей нагрузки: при ключе по датам один из них красный. Каждый пятый запрос — без ключа, он расходится во все шарды.',
        real: 'Citus для PostgreSQL, Vitess для MySQL или шардирование в коде сервиса. Добавить шард — долгая миграция данных; consistent hashing уменьшает объём переезда.'
      }
    },
    legend: [['read', 'Чтение — SELECT'], ['write', 'Запись — INSERT / UPDATE'], ['ok', 'Ответ вернулся сервису'], ['sq ok', 'Страница нашлась в памяти'],
      ['sq warn', 'Промах: страницу везут с диска'], ['sq bad', 'Старую страницу вытесняют из памяти'], ['sq info', 'Seq Scan: перебор страниц подряд'], ['sq write', 'Строка журнала WAL, изменённая страница'],
      ['ring', 'Ждёт: соединение, диск, замок или реплику'], ['bad', 'Ошибка, отказ, потерянная запись']],
    live: (n, r) => {
      const i = r.info || {}, c = [['Поток', SD.fmt.num(r.rps || 0) + '/с', '']];
      const st = u => u > 1 ? 'bad' : u > 0.75 ? 'warn' : 'ok';
      c.push(['Primary', pc(Math.min(i.uW || 0, 9)), st(i.uW || 0)]);
      if (i.R > 0) c.push(['Реплики', pc(Math.min(i.uR || 0, 9)), st(i.uR || 0)]);
      c.push(['Соединений', `${Math.round(i.conns || 0)} из ${i.connLimit || 200}`, i.connOk < 1 ? 'bad' : '']);
      if (i.R > 0) c.push(['Лаг реплик', ms(i.lag || 0), (i.lag || 0) > 200 ? 'warn' : '']);
      return c;
    },
    mount(ctx) {
      const svg = ctx.svg, esc = ctx.esc;
      svg.innerHTML = '<g class="xs-base"></g><g class="xs-live"></g><g class="xs-dyn"></g>';
      const [gB, gL, gD] = svg.children;
      let scn = ctx.scenario() || 'norm', C = {}, S = null, baseKey = '', topo = '';

      /* ---------- параметры узла ---------- */
      function cfg() {
        const p = ctx.node.props, r = ctx.res || {}, i = r.info || {}, ld = r.load || {};
        const R = Math.max(0, i.R != null ? i.R : (p.replicas || 0)), Sh = Math.max(1, p.shards || 1);
        const ram = i.ram || RAM[p.size || 'm'];
        const need = scn === 'spill' ? 120 : (i.needGb || 0);
        const conns = scn === 'conns' ? Math.max(i.conns || 0, 340) : (i.conns || 0), lim = i.connLimit || 200;
        const lagReal = i.lag || 0;
        const w = (ld.write || 0) + (ld.apply || 0) + (ld.append || 0), all = Object.values(ld).reduce((s, v) => s + v, 0);
        const I = p.idx || (p.indexes === false ? [] : ['btree']);
        const cs = ctx.ins().map(x => ({ id: x.n.id, name: ctx.nm(x.n.id), type: x.n.type, cnt: x.r.alive != null ? x.r.alive : (x.n.props.count || 1), can: ctx.canGo(x.n.id) }));
        cs.forEach(c => { c.pool = c.type === 'app' ? 10 : (c.type === 'worker' || c.type === 'ws') ? 5 : 0; });
        if (scn === 'conns' && cs.length) cs[0].cnt = Math.max(cs[0].cnt, 34);
        const wsum = cs.reduce((s, c) => s + c.cnt * c.pool, 0);
        cs.forEach(c => { c.conns = wsum ? Math.round(conns * c.cnt * c.pool / wsum) : 0; });
        C = {
          p, i, R, Sh, D: Sh > 1 && p.shardKey === 'range' ? Sh - 1 : 0, key: p.shardKey || 'hash', ram, need,
          pages: need > 0 ? cl(Math.round(FR * need / ram), 12, 200) : 30, conns, lim, pooler: !!p.pooler, srv: Math.min(conns, 20),
          rej: p.pooler ? 0 : conns > lim ? 1 - lim / conns : 0, lagReal,
          lag: scn === 'ryw' ? Math.max(lagReal, 2500) : scn === 'fail' ? Math.max(lagReal, 1200) : Math.min(lagReal, 3000),
          mode: p.replMode || 'async', ryw: !!p.ryw && R > 0, iso: p.isolation || 'rc', lock: p.locking || 'none',
          idx: ['btree', 'hash', 'clustered'].some(k => I.includes(k)), I,
          uW: i.uW != null ? i.uW : (r.util || 0), uR: i.uR != null ? i.uR : (r.util || 0), util: r.util || 0,
          wsh: scn === 'fail' ? 0.55 : cl(all ? w / all : 0, 0.25, 0.6), cs, rywShare: i.ryw || 0
        };
        C.fP = cl(qf(C.uW), 1, 3.5); C.fR = cl(qf(C.uR), 1, 3.5);
        C.hotAbort = i.abort || 0;
        if (scn === 'hot' && SD.isoStress && ctx.A && ctx.A.level) { try { C.hotAbort = SD.isoStress(ctx.A.level, ctx.A.graph, ctx.node.id, 1).abort; } catch (e) { /* без оценки */ } }
        C.rate = cl(3 + 4 * Math.min(C.util, 1.5), 3, 9);
      }

      /* ---------- модель ---------- */
      function reset() {
        S = { t: 0, next: 250, q: [], reqs: [], fx: [], ev: [], rid: 1, slots: Array(K).fill(null), wq: [], disk: [], dq: [], cw: [],
          frames: [], where: new Map(), tape: [], lsn: LSN0, chips: [], acks: [], reps: [], shFl: {}, logT: {}, rr: 0,
          H: null, think: 0, userI: 0, seatI: 0, fl: { ph: 'up', t: 0 }, np: -1, lostTot: 0, planFl: -9999, ckptLog: false, npW: 0 };
        for (let k = 0; k < FR; k++) { const pg = k < C.pages ? k : null; S.frames.push({ pg, used: -k, fl: null, d: false, res: false }); if (pg != null) S.where.set(pg, k); }
        for (let k = 0; k < 6; k++) S.tape.push({ n: S.lsn++, op: k % 2 ? 'UPDATE' : 'INSERT', st: 'ok', t: -9999 });
        syncReps();
        topo = topoKey();
        every(7000, checkpoint);
        if (scn === 'hot') at(500, wave);
        if (scn === 'ryw') { at(300, pair); every(1800, pair); }
        if (scn === 'fail') at(4500, crash);
      }
      const topoKey = () => [C.R, C.Sh, C.pooler].join('|');
      function syncReps() { while (S.reps.length < C.R) S.reps.push({ lsn: S.lsn - 1, ack: S.lsn - 1, n: 0, fl: -9999, cell: null, seq: -9999 }); if (S.reps.length > C.R) S.reps.length = C.R; }
      const at = (dt, f) => S.q.push({ t: S.t + Math.max(0, dt), f });
      const every = (dt, f) => { const go = () => { f(); at(dt, go); }; at(dt, go); };
      const later = (r, dt, f) => at(dt, () => { if (!r.gone) f(); });
      const ev = k => S.ev.push({ t: S.t, k });
      const cnt = k => S.ev.filter(e => e.k === k).length;
      const fx = (k, x, y, txt, cls) => { S.fx.push({ k, x, y, txt, cls, t: S.t }); if (S.fx.length > 24) S.fx.shift(); };
      const logT = (k, gap, txt, cls) => { if (S.t - (S.logT[k] || -1e9) < gap) return; S.logT[k] = S.t; ctx.log(txt, cls); };
      const pDown = () => S.fl.ph !== 'up';
      const need = () => (!S.reps.length || S.np >= 0) ? 0 : C.mode === 'sync' ? S.reps.length : C.mode === 'semisync' ? 1 : 0;
      const acked = n => S.reps.filter(x => x.ack >= n).length;
      const hitP = () => C.pages <= FR ? 0.99 : Math.pow(FR / C.pages, 1 / 2.2);
      const pickPage = () => Math.floor(C.pages * Math.pow(Math.random(), 2.2));
      const pickCaller = () => C.cs.length ? rnd(Math.min(3, C.cs.length)) : 0;
      const callerY = i => { const n = Math.max(1, Math.min(3, C.cs.length)); return 196 + (i - (n - 1) / 2) * 72; };
      const callerOut = i => [112, callerY(i)];
      const inPath = i => C.pooler ? [callerOut(i), [122, 196], [188, 196], DOOR] : [callerOut(i), [150, 196], DOOR];
      const lanePre = i => C.pooler ? [callerOut(i), [122, 196], [155, 196], [155, LANE]] : [callerOut(i), [150, LANE]];
      function repBox(i) { const n = Math.max(1, Math.min(4, C.R)), h = n <= 3 ? 104 : 96; return { y: 98 + i * (h + 12), h }; }
      const sitPos = (i, k) => { const b = repBox(Math.min(i, 3)); return [RX + 20 + (k % 6) * 13, b.y + 62]; };
      const repPath = (ci, ri, k) => { const b = repBox(Math.min(ri, 3)); return lanePre(ci).concat([[LANEX, LANE], [LANEX, b.y + 62], [RX + 4, b.y + 62], sitPos(ri, k)]); };
      const busPath = ri => { const b = repBox(Math.min(ri, 3)); return [[744, 503], [BUSX, 503], [BUSX, b.y + b.h - 14], [RX, b.y + b.h - 14]]; };
      const shW = () => Math.min(70, (Z.w - (C.Sh - 1) * 4) / C.Sh);
      const shC = k => [Z.x + k * (shW() + 4) + shW() / 2, 31];
      function shShare() {
        const n = C.Sh, a = Array(n).fill(1 / n);
        if (C.key === 'range') { const w = C.wsh; for (let k = 0; k < n; k++) a[k] = (1 - w) / n + (k === n - 1 ? w : 0); }
        if (C.key === 'geo') { a.fill(0.55 / (n - 1)); a[0] = 0.45; }
        return a;
      }
      function pickShard(kind) {
        if (C.key === 'range') return kind === 'write' ? C.Sh - 1 : rnd(C.Sh);
        if (C.key === 'geo') return Math.random() < 0.45 ? 0 : 1 + rnd(C.Sh - 1);
        return rnd(C.Sh);
      }

      function mv(r, pts, dur, then) { r.path = pts; r.L = plen(pts); r.a = S.t; r.b = S.t + Math.max(1, dur); r.wait = null; if (then) later(r, dur, then); }
      function hold(r, p, w) { r.path = [p]; r.a = r.b = S.t; r.wait = w || null; r.w0 = S.t; }
      function slide(r, p) { const w = r.wait, w0 = r.w0; mv(r, [cur(r), p], 160, null); r.wait = w; r.w0 = w0; }
      function cur(r) { if (!r.path) return callerOut(r.ci || 0); if (r.path.length === 1 || S.t >= r.b) return r.path[r.path.length - 1]; return along(r.path, r.L, (S.t - r.a) / (r.b - r.a)); }

      function arrive() {
        S.next = S.t + 1000 / C.rate * (0.6 + Math.random() * 0.8);
        if (scn === 'hot' || scn === 'ryw') { if (Math.random() < 0.5) newReq('read'); return; }
        newReq(Math.random() < C.wsh ? 'write' : 'read');
      }
      function newReq(kind, o) {
        const r = Object.assign({ id: S.rid++, kind, ci: pickCaller(), t0: S.t, tries: 0 }, o || {});
        S.reqs.push(r);
        r.rej = Math.random() < C.rej;
        if (C.Sh > 1 && !r.hot && r.own == null && !r.ownW && ['norm', 'spill', 'conns'].includes(scn)) {
          const sh = pickShard(kind);
          if (sh !== C.D) { r.sh = sh; mv(r, lanePre(r.ci).slice(0, -1).concat([ROUTER, shC(sh)]), 650, () => { S.shFl[sh] = S.t; r.gone = true; }); return r; }
        }
        if (kind === 'read' && toRep(r)) return r;
        if (kind === 'write' && S.fl.ph === 'prom') { toNew(r); return r; }
        mv(r, inPath(r.ci), 380, () => door(r));
        return r;
      }
      function toRep(r) {
        const live = S.reps.map((x, i) => i).filter(i => i !== S.np && i < 4);
        if (!live.length) { if (S.np >= 0) { toNew(r); return true; } return false; }
        if (scn === 'spill') return false;
        if (r.own != null && C.ryw) return false;
        if (r.own == null && scn === 'norm' && Math.random() < C.rywShare) return false;
        const ri = live[S.rr++ % live.length];
        r.ri = ri; mv(r, repPath(r.ci, ri, S.reps[ri].n), 760, () => repServe(r));
        return true;
      }
      function repServe(r) {
        const rep = S.reps[r.ri]; if (!rep) { r.gone = true; return; }
        if (r.rej) return die(r, 'rej');
        rep.n++;
        const seq = !C.idx, hit = Math.random() < hitP();
        ev(hit ? 'hit' : 'miss'); rep.cell = { i: rnd(8), k: hit ? 'hit' : 'miss', t: S.t };
        if (seq) { ev('seq'); rep.seq = S.t; ctx.done('idx'); }
        hold(r, cur(r));
        later(r, (240 + (seq ? 900 : 0) + (hit ? 0 : 450)) * C.fR, () => {
          rep.n = Math.max(0, rep.n - 1);
          if (r.own != null) own(r, rep.lsn >= r.own, r.ri, rep.lsn);
          done(r);
        });
      }
      function toNew(r) {
        const ri = S.np; r.ri = ri; r.toNp = true;
        mv(r, repPath(r.ci, ri, rnd(4)), 760, () => {
          const rep = S.reps[ri]; if (!rep) { r.gone = true; return; }
          if (r.kind === 'write') { later(r, 320, () => { rep.lsn = S.lsn++; rep.ack = rep.lsn; S.npW++; rep.fl = S.t; done(r); }); }
          else later(r, 260 * C.fR, () => done(r));
        });
      }

      /* вход: соединение, очередь */
      function door(r) {
        if (pDown()) return die(r, 'down');
        if (r.rej) return die(r, 'rej');
        r.inP = true;
        const k = S.slots.indexOf(null);
        if (k >= 0) return take(r, k);
        if (S.wq.length >= 8) return die(r, 'full');
        S.wq.push(r); hold(r, qPos(S.wq.length - 1), 'conn'); ev('wait');
      }
      function take(r, k) { S.slots[k] = r; r.slot = k; mv(r, [cur(r), slotC(k)], 140, () => plan(r)); }
      function free(r) {
        if (r.slot == null) return;
        const k = r.slot; r.slot = null; if (S.slots[k] === r) S.slots[k] = null;
        const nx = S.wq.shift();
        if (nx) { S.wq.forEach((x, i) => slide(x, qPos(i))); take(nx, k); }
      }

      /* планировщик: индекс или полный перебор */
      function plan(r) {
        r.plan = C.idx ? 'idx' : 'seq';
        const nx = () => {
          if (r.kind === 'write') return r.plan === 'seq' ? scan(r, () => r.hot ? rowGo(r) : wal(r)) : r.hot ? rowGo(r) : wal(r);
          return r.plan === 'seq' ? scan(r, () => readEnd(r)) : page(r, pickPage(), () => readEnd(r));
        };
        if (r.plan === 'idx') { const l = r.id % 4; mv(r, [cur(r), ROOT, BR[l >> 1], LEAF[l]], 160 + 300 * C.fP, nx); }
        else { S.planFl = S.t; mv(r, [cur(r), [PB.x + 62, 246]], 200 + 120 * C.fP, nx); }
      }
      function scan(r, then) {
        const pts = [cur(r)]; for (let k = 0; k < FR; k++) pts.push(cellC(serp(k)));
        r.scan = true;
        mv(r, pts, FR * 24 * C.fP, () => {
          r.scan = false; ev('seq'); S.frames.forEach(f => { if (f.pg != null) f.used = S.t; });
          if (r.kind === 'read' && !C.idx) ctx.done('idx');
          if (C.pages > FR) { S.dnote = { t: S.t, txt: `Seq Scan: ещё ${C.pages - FR} стр. не в памяти — с диска` }; ev('miss'); toDisk(r, cur(r), Math.min(1600, (C.pages - FR) * 14), then); }
          else then();
        });
      }
      function victim() {
        let best = -1, bu = Infinity;
        S.frames.forEach((f, i) => { if (f.res) return; const u = f.pg == null ? -1e12 : f.used; if (u < bu) { bu = u; best = i; } });
        return best < 0 ? 0 : best;
      }
      function page(r, pg, then) {
        const fi = S.where.get(pg);
        if (fi != null) {
          mv(r, [cur(r), cellC(fi)], 200, () => { const f = S.frames[fi]; f.used = S.t; f.fl = { k: 'hit', t: S.t }; ev('hit'); r.fi = fi; later(r, 90 * C.fP, then); });
          return;
        }
        const vi = victim(), f = S.frames[vi]; f.res = true;
        mv(r, [cur(r), cellC(vi)], 200, () => {
          ev('miss'); f.fl = { k: f.pg != null ? 'ev' : 'miss', t: S.t };
          toDisk(r, cellC(vi), 420, () => {
            f.res = false;
            if (S.where.has(pg)) { r.fi = S.where.get(pg); then(); return; }
            if (f.pg != null) { S.where.delete(f.pg); ev('evict'); if (scn === 'spill' || C.pages > FR) logT('evict', 9000, `Страницу №${f.pg} вытеснили из памяти, чтобы освободить место для №${pg}. Если её снова спросят — опять поедем на диск.`, 'warn'); }
            f.pg = pg; f.used = S.t; f.fl = { k: 'load', t: S.t }; f.d = false; S.where.set(pg, vi); r.fi = vi;
            then();
          });
        });
      }
      function toDisk(r, back, dwell, then) {
        const [x] = cur(r);
        mv(r, [cur(r), [x, DK.y + 8], [672, DK.y + 22]], 300, () => disk(r, dwell, () => mv(r, [cur(r), [back[0], DK.y + 8], back], 300, then)));
      }
      function disk(r, dwell, then) {
        if (S.disk.length < 2) {
          S.disk.push(r); hold(r, diskPos(S.disk.length - 1), 'disk');
          later(r, dwell * (scn === 'spill' ? 1.3 : 1), () => { S.disk = S.disk.filter(x => x !== r); pump(); then(); });
        } else { S.dq.push({ r, dwell, then }); hold(r, dqPos(Math.min(3, S.dq.length - 1)), 'disk'); ev('dq'); }
      }
      function pump() {
        while (S.disk.length < 2 && S.dq.length) { const o = S.dq.shift(); if (!o.r.gone) disk(o.r, o.dwell, o.then); }
        S.dq.forEach((o, i) => slide(o.r, dqPos(Math.min(3, i))));
      }
      function readEnd(r) { if (r.own != null) own(r, true, -1, 0); done(r); }

      /* запись: журнал → коммит → страница */
      function wal(r) {
        const tx = tapeX(TAPE - 1) + 21, [x0, y0] = cur(r);
        mv(r, [[x0, y0], [484, y0], [484, 482], [tx, 482], [tx, 496]], 420, () => {
          if (pDown()) return die(r, 'down');
          const n = S.lsn++; r.lsn = n;
          r.rec = { n, op: r.hot ? 'UPDATE' : r.op || (Math.random() < 0.5 ? 'INSERT' : 'UPDATE'), st: 'wal', t: S.t };
          S.tape.push(r.rec); if (S.tape.length > 40) S.tape.shift();
          ev('wal'); ship(r.rec);
          later(r, 80 * C.fP, () => mv(r, [cur(r), GATE], 160, () => later(r, 110 * C.fP, () => commitWait(r))));
        });
      }
      function ship(rec) {
        if (pDown()) return;
        S.reps.forEach((rep, i) => {
          if (i === S.np) return;
          const tt = (420 + C.lag) * (1 + 0.3 * i), c = { n: rec.n, ri: i, t0: S.t, t1: S.t + tt };
          S.chips.push(c); at(tt, () => chipIn(c));
        });
      }
      function chipIn(c) {
        if (c.dead) return;
        S.chips = S.chips.filter(x => x !== c);
        const rep = S.reps[c.ri]; if (!rep) return;
        rep.lsn = Math.max(rep.lsn, c.n); rep.fl = S.t;
        if (C.mode === 'async') { rep.ack = rep.lsn; return; }
        const a = { n: c.n, ri: c.ri, t0: S.t, t1: S.t + 300 };
        S.acks.push(a);
        at(300, () => { S.acks = S.acks.filter(x => x !== a); if (a.dead) return; const rp = S.reps[a.ri]; if (rp) rp.ack = Math.max(rp.ack, a.n); checkCW(); });
      }
      function commitWait(r) {
        if (pDown()) return die(r, 'down');
        if (acked(r.lsn) >= need()) return commit(r, 0);
        S.cw.push(r); hold(r, cwPos(Math.min(5, S.cw.length - 1)), 'repl');
      }
      function checkCW() {
        const ready = S.cw.filter(r => !r.gone && acked(r.lsn) >= need());
        if (!ready.length) return;
        S.cw = S.cw.filter(r => !ready.includes(r));
        S.cw.forEach((x, i) => slide(x, cwPos(Math.min(5, i))));
        ready.forEach(r => commit(r, S.t - r.w0));
      }
      function commit(r, waited) {
        r.rec.st = 'ok'; r.rec.tc = S.t; ev('commit');
        if (waited > 30) {
          ev('replw');
          if (C.mode === 'sync') ctx.done('sync');
          logT('replw', 6000, `Запись №${r.lsn} ждала у коммита ${C.mode === 'sync' ? 'все реплики' : 'одну реплику'} ${ms(waited)} (на картинке). Зато она уже есть ${C.mode === 'sync' ? 'на всех репликах' : 'минимум в двух местах'}.`, '');
        }
        if (r.hot) unlock(r);
        page(r, r.hot ? 2 : pickPage(), () => { const f = S.frames[r.fi]; if (f) f.d = true; done(r); });
      }
      function checkpoint() {
        const d = S.frames.filter(f => f.d);
        if (!d.length || pDown()) return;
        d.forEach(f => { f.d = false; });
        S.ckpt = { t: S.t, n: d.length };
        if (!S.ckptLog) { S.ckptLog = true; ctx.log('<b>Checkpoint.</b> Изменённые страницы (фиолетовая рамка) фоном сбрасываются из памяти на диск. Спешить не нужно: всё уже записано в журнале WAL.', ''); }
      }
      function done(r) {
        free(r); r.inP = false; r.resp = true; r.wait = null; r.scan = false;
        mv(r, [cur(r), callerOut(r.ci)], 380, () => { r.gone = true; ev(r.kind === 'write' ? 'okw' : 'okr'); if (r.after) r.after(r); });
      }
      function detach(r) {
        S.wq = S.wq.filter(x => x !== r); S.cw = S.cw.filter(x => x !== r);
        const dl = S.disk.length; S.disk = S.disk.filter(x => x !== r); S.dq = S.dq.filter(o => o.r !== r); if (S.disk.length < dl) pump();
        if (S.H) { S.H.lq = S.H.lq.filter(x => x !== r); if (S.H.lock === r) unlock(r); }
      }
      function die(r, k) {
        const [x, y] = cur(r); fx('x', x, y);
        ev(k); r.gone = true; r.inP = false; free(r); detach(r);
        if (k === 'rej') logT('rej', 4000, `Соединений нужно ${C.conns}, а база держит ${C.lim}: новый клиент получил «too many clients».`, 'bad');
        if (k === 'full') logT('full', 4000, 'Все окошки заняты, в очереди 8 запросов — новый не дождался соединения.', 'bad');
        if (k === 'down') logT('down', 3000, 'Запрос пришёл к упавшему primary и получил ошибку.', 'bad');
        if (r.after) r.after(r);
      }

      /* ситуация «толкучка»: три транзакции за одну строку */
      function wave() {
        if (S.reqs.some(r => r.hot && !r.gone)) { at(400, wave); return; }
        const seat = SEATS[S.seatI++ % SEATS.length];
        S.H = { seat, owner: null, ver: 1, lock: null, lq: [], lost: [], booked: [], aborts: 0, waited: 0, fl: -9999, txs: [], sum: false };
        S.think = 0;
        [0, 110, 240].forEach(d => at(d + rnd(60), () => { const u = USERS[S.userI++ % USERS.length]; S.H.txs.push(newReq('write', { hot: true, user: u, after: waveEnd })); }));
      }
      function msg(txt, cls) { if (S.H) S.H.msg = { txt, cls, t: S.t }; }
      function rowGo(r) { mv(r, [cur(r), ROW], 200, () => rowRead(r)); }
      function rowRead(r) {
        const H = S.H; if (!H) return done(r);
        if (C.lock === 'pessimistic') {
          if (H.lock && H.lock !== r) { H.lq.push(r); hold(r, lqPos(Math.min(2, H.lq.length - 1)), 'lock'); msg(`${r.user} ждёт замок 🔒 — строку держит ${H.lock.user}`, ''); return; }
          H.lock = r;
        }
        r.seen = { owner: H.owner, ver: H.ver };
        hold(r, thinkPos(S.think++), 'think');
        later(r, 520, () => decide(r));
      }
      function unlock(r) {
        const H = S.H; if (!H || H.lock !== r) return;
        H.lock = null;
        const nx = H.lq.shift();
        H.lq.forEach((x, i) => slide(x, lqPos(Math.min(2, i))));
        if (nx) { H.waited++; ev('lockw'); mv(nx, [cur(nx), ROW], 160, () => rowRead(nx)); }
      }
      function decide(r) {
        const H = S.H;
        if (r.seen.owner) { r.out = 'busy'; msg(`${r.user}: место занято — ответ «мест нет»`, 'ok'); unlock(r); done(r); return; }
        const conflict = H.ver !== r.seen.ver;
        if (C.lock === 'optimistic' && conflict) return retry(r, 'версия уже другая');
        if (C.lock === 'none' && C.iso !== 'rc' && conflict) return retry(r, 'could not serialize');
        const prev = H.owner;
        if (prev) { H.lost.push(prev); ev('dbl'); H.fl = S.t; }
        H.owner = r.user; H.ver++; H.booked.push(r.user); r.out = 'booked';
        msg(prev ? `ДВОЙНАЯ БРОНЬ: было «${prev}», стало «${r.user}»` : `${r.user}: место свободно — пишу бронь (v${H.ver})`, prev ? 'bad' : '');
        wal(r);
      }
      function retry(r, why) {
        r.tries++; ev('abort'); S.H.aborts++; S.H.why = why;
        msg(`${r.user}: ↺ ${why} → повтор`, 'warn');
        if (C.iso === 'ser' && C.lock === 'none') ctx.done('ser');
        mv(r, [cur(r), ROW], 260, () => rowRead(r));
      }
      function waveEnd() {
        const H = S.H;
        if (!H || H.sum || H.txs.length < 3 || H.txs.some(r => !r.gone)) return;
        H.sum = true;
        if (H.lost.length) ctx.log(`<b>Место ${H.seat}:</b> «забронировано» ответили ${H.booked.join(', ')}, а в базе осталась одна бронь — на имя «${H.owner}». <b>Двойная бронь</b>: остальные обновления потерялись.`, 'bad');
        else ctx.log(`<b>Место ${H.seat}</b> досталось ${H.owner || 'никому'}. Остальным — «занято»${H.aborts ? `, перед этим ${H.aborts} ${pl(H.aborts, 'откат', 'отката', 'откатов')} («${H.why}») и повтор` : ''}${H.waited ? `; ${H.waited} ${pl(H.waited, 'ждал', 'ждали', 'ждали')} замок 🔒` : ''}.`, 'ok');
        at(1000, wave);
      }

      /* ситуация «записал и сразу читаю» */
      function pair() {
        const u = USERS[S.userI++ % USERS.length];
        newReq('write', { ownW: true, user: u, op: 'INSERT', after: w => { if (w.lsn && w.resp) at(90, () => newReq('read', { own: w.lsn, user: u, ci: w.ci })); } });
      }
      function own(r, fresh, ri, have) {
        const [x, y] = cur(r);
        if (fresh) {
          ev('fresh');
          if (ri < 0) { if (C.ryw) ctx.done('ryw'); logT('fresh', 5000, `<b>${r.user}, заказ №${r.own}:</b> «Мои заказы» читаются с primary — заказ на месте.`, 'ok'); }
          else logT('fresh', 5000, `<b>${r.user}, заказ №${r.own}:</b> «Мои заказы» открылись с реплики ${ri + 1}, она уже получила эту запись — заказ на месте.`, 'ok');
          return;
        }
        ev('stale'); r.err = true; if (S.reps[ri]) S.reps[ri].stale = { t: S.t, n: r.own };
        ctx.log(`<b>${r.user}, заказ №${r.own}:</b> «Мои заказы» открылись с реплики ${ri + 1}, а у неё журнал только до №${have}. <b>Заказа не видно</b> — человек думает, что заказ пропал.`, 'bad');
      }

      /* ситуация «primary упал» */
      function crash() {
        S.fl = { ph: 'down', t: S.t };
        S.reqs.forEach(r => { if (r.gone || !r.inP) return; const [x, y] = cur(r); fx('x', x, y); r.gone = true; ev('down'); });
        S.slots.fill(null); S.wq = []; S.cw = []; S.disk = []; S.dq = []; if (S.H) { S.H.lock = null; S.H.lq = []; }
        S.chips.forEach(c => { c.dead = true; const p = along(busPath(c.ri), plen(busPath(c.ri)), (S.t - c.t0) / (c.t1 - c.t0)); fx('x', p[0], p[1]); });
        S.chips = []; S.acks.forEach(a => { a.dead = true; }); S.acks = [];
        S.tape.forEach(x => { if (x.st === 'wal') x.st = 'rb'; });
        ctx.log(`<b>Primary упал.</b> Запросы внутри него оборвались. ${S.reps.length ? 'Записи журнала, которые ехали к репликам, не доехали. Сейчас выберут новый primary.' : 'Реплик нет — база недоступна, пока сервер не перезапустится.'}`, 'bad');
        at(1700, S.reps.length ? promote : recover);
      }
      function promote() {
        if (!S.reps.length) return recover();
        let np = 0; S.reps.forEach((x, i) => { if (x.lsn > S.reps[np].lsn) np = i; });
        S.np = np; S.fl = { ph: 'prom', t: S.t };
        const have = S.reps[np].lsn, lost = S.tape.filter(x => x.st === 'ok' && x.n > have);
        lost.forEach(x => { x.st = 'lost'; });
        S.lostTot += lost.length; lost.forEach(() => ev('lost'));
        if (lost.length) {
          ctx.log(`<b>Реплика ${np + 1} стала новым primary</b>, у неё журнал до №${have}. Потеряно ${lost.length} ${pl(lost.length, 'подтверждённая запись', 'подтверждённые записи', 'подтверждённых записей')} (№${lost[0].n}${lost.length > 1 ? '–' + lost[lost.length - 1].n : ''}): клиенты услышали «готово», а данных нет.`, 'bad');
          if (C.mode === 'async') ctx.done('lost');
        } else ctx.log(`<b>Реплика ${np + 1} стала новым primary.</b> ${C.mode === 'async' ? 'Повезло: всё успело доехать.' : 'Потерь нет: коммит ждал реплику, поэтому всё подтверждённое у неё есть.'}`, 'ok');
        S.reps.forEach((x, i) => { if (i !== np) { x.lsn = Math.min(x.lsn, have); x.ack = x.lsn; } });
        at(6000, restore);
      }
      function restore() {
        S.fl = { ph: 'up', t: S.t }; S.np = -1;
        const top = S.lsn - 1; S.reps.forEach(x => { x.lsn = top; x.ack = top; });
        ctx.log('Старый primary починили и вернули. Для наглядности роли снова как в начале. Через 4,5 с — новое падение.', '');
        at(4500, crash);
      }
      function recover() {
        S.fl = { ph: 'rec', t: S.t };
        ctx.log('Перезапуск: база читает журнал WAL и заново применяет все подтверждённые записи (crash recovery).', '');
        at(1800, () => {
          S.fl = { ph: 'up', t: S.t };
          ctx.log('<b>База снова работает.</b> Подтверждённые записи на месте — их восстановили по журналу. Неподтверждённые откатились, их клиенты получили ошибку. Но несколько секунд база была недоступна: реплик нет.', 'ok');
          at(5000, crash);
        });
      }

      function step(dt) {
        const end = S.t + dt;
        for (let g = 0; g < 3000; g++) {
          let mi = -1, mt = Infinity;
          for (let i = 0; i < S.q.length; i++) if (S.q[i].t < mt) { mt = S.q[i].t; mi = i; }
          const tn = Math.min(mt, S.next);
          if (tn > end) break;
          S.t = tn;
          if (S.next <= mt) { arrive(); continue; }
          S.q.splice(mi, 1)[0].f();
        }
        S.t = end;
        S.reqs = S.reqs.filter(r => !r.gone);
        S.reqs.forEach(r => { if (r.scan && r.path) { const k = cl(Math.floor((S.t - r.a) / (r.b - r.a) * FR), 0, FR - 1); S.frames[serp(k)].fl = { k: 'scan', t: S.t }; } });
        if (S.ev.length > 600 || (S.ev[0] && S.ev[0].t < S.t - 10000)) S.ev = S.ev.filter(e => e.t > S.t - 10000);
        S.fx = S.fx.filter(f => S.t - f.t < 1100);
      }

      /* ---------- отрисовка: неподвижная часть ---------- */
      function drawBase() {
        const key = [scn, C.R, C.Sh, C.D, C.key, C.pooler, C.idx, C.conns, C.ram, C.need, C.cs.map(c => c.id + ':' + c.cnt).join(','), Math.round(C.uW * 100), Math.round(C.uR * 100), S.fl.ph, S.np, C.iso, C.lock, C.mode].join('|');
        if (key === baseKey) return;
        baseKey = key;
        let s = '';
        /* вызывающие */
        s += `<text class="xr-s" x="10" y="86">Кто обращается</text>`;
        const cs = C.cs.slice(0, 3);
        if (!cs.length) s += `<rect class="xr-box" x="10" y="167" width="102" height="58" rx="10"/><text class="xr-t" x="20" y="191">Сервисы</text><text class="xr-s" x="20" y="207">нет входящих связей</text>`;
        cs.forEach((c, i) => {
          const y = callerY(i);
          const inner = `<rect class="xr-box" x="10" y="${y - 29}" width="102" height="58" rx="10"/><text class="xr-t" x="20" y="${y - 9}">${esc(cut(c.name, 12))}</text><text class="xr-s" x="20" y="${y + 7}">${c.cnt} экз.${c.pool ? ' × пул ' + c.pool : ''}</text><text class="xr-m" x="20" y="${y + 21}">≈ ${c.conns} соед.</text>`;
          s += c.can ? `<g class="xr-go" data-xgo="${esc(c.id)}"><title>Провалиться в «${esc(c.name)}»</title>${inner}</g>` : `<g>${inner}</g>`;
        });
        if (C.cs.length > 3) s += `<text class="xr-s" x="10" y="${callerY(2) + 46}">и ещё ${C.cs.length - 3}</text>`;
        /* провода */
        const pts = a => a.map(p => p.join(',')).join(' ');
        (cs.length ? cs : [0]).forEach((c, i) => {
          s += `<polyline class="xr-wire" points="${pts(inPath(i))}"/>`;
          if (C.R > 0) s += `<polyline class="xs-lane" points="${pts(lanePre(i))}"/>`;
          if (C.Sh > 1) s += `<polyline class="xr-wire dash" points="${pts(lanePre(i).slice(0, -1).concat([ROUTER]))}"/>`;
        });
        if (C.R > 0) {
          const nb = Math.min(4, C.R), last = repBox(nb - 1);
          s += `<polyline class="xs-lane" points="${(C.pooler ? 155 : 150)},${LANE} ${LANEX},${LANE} ${LANEX},${last.y + 62}"/>`;
          s += `<line class="xs-bus" x1="726" y1="503" x2="744" y2="503"/>`;
          for (let i = 0; i < nb; i++) { const b = repBox(i); s += `<line class="xs-lane" x1="${LANEX}" y1="${b.y + 62}" x2="${RX}" y2="${b.y + 62}"/><polyline class="xs-bus" points="${pts(busPath(i))}"/>`; }
          s += `<text class="xr-m" x="${(Z.x + 300)}" y="${LANE - 5}" text-anchor="middle" style="fill:var(--k-read)">чтения → реплики</text>`;
        }
        /* пулер */
        if (C.pooler) {
          s += `<rect class="xs-pb" x="122" y="138" width="66" height="116" rx="9"/><text class="xs-pbt" x="155" y="156">PgBouncer</text>`;
          s += `<text class="xr-s" x="155" y="176" text-anchor="middle">клиентов</text><text class="xr-m" x="155" y="190" text-anchor="middle">${C.conns}</text><text class="xr-s" x="155" y="206" text-anchor="middle">↓</text><text class="xr-s" x="155" y="222" text-anchor="middle">в базу</text><text class="xr-m acc" x="155" y="236" text-anchor="middle">${C.srv}</text>`;
          for (let k = 0; k < 7; k++) { const yy = 150 + k * 14; s += `<path class="xs-fan" d="M112,${callerY(k % Math.max(1, cs.length))} C118,${yy} 118,${yy} 122,${yy}"/>`; }
        }
        /* шарды */
        if (C.Sh > 1) {
          const sh = shShare(), mx = Math.max(...sh), w = shW();
          s += `<g class="xr-part" data-xpart="shard"><rect class="xs-pf" x="${Z.x - 6}" y="16" width="${Z.w + 12}" height="30" rx="8"/>`;
          s += `<path class="xs-rt" d="M${ROUTER[0]},${ROUTER[1] - 9} l9,9 l-9,9 l-9,-9 z"/><text class="xr-s" x="${ROUTER[0]}" y="13" text-anchor="middle">роутер</text>`;
          s += `<text class="xr-s" x="${Z.x}" y="13">Шарды — ключ ${esc({ hash: 'hash(user_id): поровну', range: 'created_at: новые записи в последний шард', geo: 'регион: крупная страна перевешивает' }[C.key] || C.key)}</text>`;
          for (let k = 0; k < C.Sh; k++) {
            const x = Z.x + k * (w + 4), hot = (C.key !== 'hash') && sh[k] === mx, h = 20 * sh[k] / mx;
            s += `<rect class="xs-sh ${k === C.D ? 'sel' : ''} ${hot ? 'hot' : ''}" x="${r1(x)}" y="20" width="${r1(w)}" height="22" rx="4"/><rect class="xs-shf ${hot ? 'hot' : ''}" x="${r1(x + 1)}" y="${r1(41 - h)}" width="${r1(w - 2)}" height="${r1(h)}"/>`;
            if (w >= 22) s += `<text class="xs-sht" x="${r1(x + w / 2)}" y="35">${w >= 40 ? 'шард ' : ''}${k + 1}</text>`;
          }
          s += '</g>';
        }
        /* primary */
        const loadCls = C.uW > 1 ? 'bad' : C.uW > 0.75 ? 'warn' : 'ok';
        s += `<rect class="xr-zone" x="${Z.x}" y="${Z.y}" width="${Z.w}" height="${Z.h}" rx="14"/>`;
        s += `<text class="xr-t" x="212" y="90">Primary — главный сервер${C.Sh > 1 ? ` · шард ${C.D + 1} из ${C.Sh}` : ''}</text><text class="xr-m ${loadCls}" x="730" y="90" text-anchor="end">загрузка ${pc(Math.min(C.uW, 9))}</text>`;
        /* соединения */
        const cf = C.pooler ? C.srv / C.lim : C.conns / C.lim;
        s += prt('conn', box(CB, 'Соединения', C.pooler ? `в базу ${C.srv} из ${C.lim}` : `открыто ${C.conns} из ${C.lim}`) + `<rect class="xr-bar" x="226" y="152" width="104" height="5" rx="2"/><rect class="xr-bar-f ${cf > 1 ? 'bad' : cf > 0.75 ? 'warn' : ''}" x="226" y="152" width="${r1(104 * Math.min(1, cf))}" height="5" rx="2"/>`);
        /* планировщик */
        let pp = box(PB, 'Планировщик', 'как найти строку?');
        const off = C.idx ? '' : ' off';
        LEAF.forEach((l, k) => { const b = BR[k >> 1]; pp += `<line class="xs-tl${off}" x1="${b[0]}" y1="${b[1]}" x2="${l[0]}" y2="${l[1]}"/>`; });
        BR.forEach(b => { pp += `<line class="xs-tl${off}" x1="${ROOT[0]}" y1="${ROOT[1]}" x2="${b[0]}" y2="${b[1]}"/>`; });
        [ROOT].concat(BR, LEAF).forEach((p, k) => { const w = k ? 16 : 22; pp += `<rect class="xs-tree${off}" x="${p[0] - w / 2}" y="${p[1] - 5}" width="${w}" height="10" rx="2"/>`; });
        if (!C.idx) pp += `<text class="xr-m bad" x="414" y="203" text-anchor="middle">индекса нет</text>`;
        s += prt('plan', pp + `<text class="xs-plan ${C.idx ? 'ok' : 'warn'}" x="370" y="258">${C.idx ? 'Index Scan' : 'Seq Scan'}</text><text class="xr-s" x="370" y="273">${C.idx ? 'прямо к строке' : 'читаю всё подряд'}</text>`);
        s += `<g class="xs-btn" data-xsidx="1" tabindex="0" role="button" aria-label="${C.idx ? 'Убрать индекс' : 'Вернуть индекс'}"><rect x="356" y="290" width="120" height="20" rx="10"/><text x="416" y="304">${C.idx ? '✕ убрать индекс' : '＋ вернуть индекс'}</text></g>`;
        /* память и диск */
        s += prt('buf', box(BB, 'Буферный кэш — память', `RAM ${C.ram} ГБ · ${C.need > 0 ? `данных с индексами ${C.need} ГБ` : 'данные влезают целиком'}`, C.need > C.ram ? 'hot' : ''));
        s += prt('disk', box(DK, 'Диск (SSD)', 'в сотни раз медленнее памяти'));
        /* блокировки */
        s += prt('lock', box(LK, 'Блокировки и изоляция', `${ISO[C.iso]} · ${LOCK[C.lock]}`));
        /* журнал */
        s += prt('wal', box(WB, 'Журнал WAL — сначала запись идёт сюда', 'по нему база восстановится после падения; его же получают реплики'));
        /* реплики */
        const rb = C.R ? repBox(Math.min(4, C.R) - 1) : { y: 102, h: 118 };
        s += `<g class="xr-part" data-xpart="repl"><rect class="xs-pf" x="${RX - 6}" y="72" width="${RW + 12}" height="${rb.y + rb.h + 6 - 72}" rx="12"/>`;
        s += `<text class="xr-t" x="${RX}" y="90">${C.R ? (C.Sh > 1 ? 'Реплики этого шарда' : 'Реплики — копии для чтения') : 'Реплики'}</text>`;
        if (!C.R) {
          s += `<rect class="xr-zone" x="${RX}" y="102" width="${RW}" height="118" rx="12"/>`;
          ['Реплик нет.', 'Все чтения идут на primary.', 'Упадёт primary — база', 'недоступна, пока не поднимут.'].forEach((t, k) => { s += `<text class="${k ? 'xr-s' : 'xr-t'}" x="${RX + 14}" y="${128 + k * 20}">${t}</text>`; });
        }
        for (let i = 0; i < Math.min(4, C.R); i++) {
          const b = repBox(i), np = i === S.np;
          s += `<rect class="xr-box ${np ? 'sel' : ''}" x="${RX}" y="${b.y}" width="${RW}" height="${b.h}" rx="10"/>`;
          s += `<rect class="xr-bar" x="${RX + 12}" y="${b.y + 44}" width="${RW - 24}" height="5" rx="2"/><rect class="xr-bar-f ${C.uR > 1 ? 'bad' : C.uR > 0.75 ? 'warn' : ''}" x="${RX + 12}" y="${b.y + 44}" width="${r1((RW - 24) * Math.min(1, C.uR))}" height="5" rx="2"/>`;
        }
        s += '</g>';
        if (C.R > 4) s += `<text class="xr-s" x="${RX}" y="${repBox(3).y + repBox(3).h + 22}">и ещё ${C.R - 4} — устроены так же</text>`;
        gB.innerHTML = s;
      }
      const prt = (k, inner) => `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}">${inner}</g>`;
      function box(b, t, sub, cls) { return `<rect class="xr-box ${cls || ''}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"/><text class="xr-t" x="${b.x + 14}" y="${b.y + 20}">${esc(t)}</text><text class="xr-s" x="${b.x + 14}" y="${b.y + 35}">${esc(sub)}</text>`; }

      /* ---------- отрисовка: живая часть ---------- */
      const age = (o, d) => o ? 1 - (S.t - o.t) / d : 0;
      function drawLive() {
        let s = '';
        /* окошки-соединения и очередь */
        s += '<g data-xpart="conn">';
        S.slots.forEach((r, k) => { const [x, y] = slotR(k); s += `<rect class="xr-slot${r ? ' xs-on' : ''}" x="${x}" y="${y}" width="22" height="22" rx="4"${r ? ` style="fill:${SD.kindColor(r.kind)};stroke:${SD.kindColor(r.kind)}"` : ''}/>`; });
        const busy = S.slots.filter(Boolean).length;
        s += `<text class="xr-s" x="226" y="262">работают: <tspan class="xs-v ${busy === K ? 'bad' : ''}">${busy} из ${K}</tspan></text>${C.rej > 0 ? `<text class="xr-s" x="226" y="276">отказ: <tspan class="xs-v bad">${pc(C.rej)}</tspan></text>` : `<text class="xr-s" x="226" y="276">ждут: <tspan class="xs-v ${S.wq.length ? 'warn' : ''}">${S.wq.length}</tspan></text>`}`;
        s += '</g><g data-xpart="buf">';
        /* страницы в памяти */
        S.frames.forEach((f, i) => {
          const [x, y] = cellR(i);
          s += `<rect class="xs-cell${f.pg == null ? ' e' : ''}${f.d ? ' d' : ''}" x="${x}" y="${y}" width="24" height="17" rx="3"/>`;
          const a = f.fl ? age(f.fl, f.fl.k === 'scan' ? 350 : 700) : 0;
          if (a > 0) s += `<rect class="xs-fl ${f.fl.k}" x="${x}" y="${y}" width="24" height="17" rx="3" style="opacity:${r1(a)}"/>`;
        });
        const hits = cnt('hit'), miss = cnt('miss'), hr = hits + miss ? hits / (hits + miss) : 1;
        s += `<text class="xr-s" x="506" y="276">в памяти ${Math.min(FR, C.pages)} из ${C.pages} страниц таблицы</text>`;
        s += `<text class="xr-m ${hr < 0.8 ? 'bad' : hr < 0.95 ? 'warn' : 'ok'}" x="506" y="291">попаданий ${pc(hr)} · с диска ${pc(1 - hr)}</text>`;
        if (S.t - S.planFl < 500) s += `<rect class="xr-hl" x="${PB.x + 6}" y="242" width="${PB.w - 12}" height="36" rx="6" style="opacity:${r1(1 - (S.t - S.planFl) / 500)}"/>`;
        s += '</g><g data-xpart="disk">';
        /* диск */
        s += S.ckpt && S.t - S.ckpt.t < 1600 ? `<text class="xr-s" x="506" y="366" style="fill:var(--k-write)">checkpoint: ${S.ckpt.n} стр. из памяти → сюда</text>` : S.dnote && S.t - S.dnote.t < 1600 ? `<text class="xr-s" x="506" y="366" style="fill:var(--warn)">${S.dnote.txt}</text>` : `<text class="xr-s" x="506" y="366">сейчас читают: ${S.disk.length}${S.dq.length ? ` · ждут диск: ${S.dq.length}` : ''}</text>`;
        /* блокировки */
        s += '</g><g data-xpart="lock">' + drawLocks() + '</g><g data-xpart="wal">';
        /* журнал */
        const vis = S.tape.slice(-TAPE), off = TAPE - vis.length, rp = S.fl.ph === 'rec' ? Math.floor((S.t - S.fl.t) / 1800 * TAPE) : -1;
        for (let k = 0; k < TAPE; k++) {
          const rec = vis[k - off], x = tapeX(k);
          if (!rec) { s += `<rect class="xs-tape e" x="${x}" y="486" width="42" height="34" rx="4"/>`; continue; }
          const cls = k <= rp && rec.st === 'ok' ? 'rp' : rec.st === 'ok' && S.t - (rec.tc || rec.t) < 500 ? 'new' : rec.st;
          s += `<rect class="xs-tape ${cls}" x="${x}" y="486" width="42" height="34" rx="4"/><text class="xs-tn ${rec.st}" x="${x + 21}" y="500">№${rec.n}</text><text class="xs-to" x="${x + 21}" y="513">${rec.st === 'lost' ? 'ПОТЕРЯ' : rec.st === 'rb' ? 'откат' : rec.st === 'wal' ? 'жду…' : rec.op}</text>`;
        }
        const gw = S.cw.length;
        s += `<rect class="xs-gate ${pDown() ? 'dead' : gw ? 'wait' : ''}" x="644" y="486" width="82" height="34" rx="6"/><text class="xs-tn" x="685" y="503">КОММИТ</text><text class="xs-to" x="685" y="515">${gw ? `ждут реплику: ${gw}` : need() ? (C.mode === 'sync' ? 'ждём реплики' : 'ждём 1 реплику') : 'fsync → готово'}</text>`;
        if (S.np < 0 && S.fl.ph === 'up') {
          const first = vis[0] ? vis[0].n : S.lsn;
          const mk = {};
          S.reps.slice(0, 4).forEach((rep, i) => {
            const k = vis.findIndex(x => x.n === rep.lsn) + off, x = rep.lsn < first ? 232 : k >= off ? tapeX(k) + 21 : tapeX(TAPE - 1) + 21;
            (mk[x] = mk[x] || []).push(i + 1);
          });
          Object.entries(mk).forEach(([x, a]) => { x = +x; s += `<path class="xs-mk" d="M${x},523 l4,6 h-8 z"/><text class="xs-mkt" x="${x}" y="538">${x === 232 ? '← ' : ''}${a.map(i => 'Р' + i).join(' ')}</text>`; });
        }
        s += '</g><g data-xpart="repl">';
        /* реплики: живые цифры */
        S.reps.slice(0, 4).forEach((rep, i) => {
          const b = repBox(i), np = i === S.np, behind = Math.max(0, S.lsn - 1 - rep.lsn);
          const lagTxt = np ? '' : S.fl.ph === 'prom' ? 'переподключается' : C.lag >= 100 ? `лаг ≈ ${ms(C.lag * (1 + 0.3 * i))}` : `лаг ${ms(C.lagReal)}`;
          s += `<text class="xr-t" x="${RX + 12}" y="${b.y + 20}">${np ? 'Новый primary' : 'Реплика ' + (i + 1)}</text><text class="xr-m ${np ? 'acc' : C.lag > 200 ? 'warn' : ''}" x="${RX + RW - 12}" y="${b.y + 20}" text-anchor="end">${lagTxt}</text>`;
          s += `<text class="xr-s" x="${RX + 12}" y="${b.y + 37}">${np ? `пишет сюда · журнал до №${rep.lsn}` : `журнал до №${rep.lsn} · ${behind ? 'отстаёт на ' + behind : 'не отстаёт'}`}</text>`;
          for (let k = 0; k < 8; k++) {
            const c = rep.cell && rep.cell.i === k && age(rep.cell, 600) > 0 ? rep.cell : null;
            const cx = RX + RW - 114 + k * 13;
            s += `<rect class="xs-cell" x="${cx}" y="${b.y + 57}" width="10" height="10" rx="2"/>${c ? `<rect class="xs-fl ${c.k}" x="${cx}" y="${b.y + 57}" width="10" height="10" rx="2" style="opacity:${r1(age(c, 600))}"/>` : ''}`;
          }
          const stl = rep.stale && S.t - rep.stale.t < 1600;
          if (stl) s += `<rect class="xs-badhl" x="${RX}" y="${b.y}" width="${RW}" height="${b.h}" rx="10" style="opacity:${r1(1 - (S.t - rep.stale.t) / 1600)}"/>`;
          s += `<text class="xs-sm ${stl ? 'bad' : S.t - rep.seq < 900 ? 'warn' : ''}" x="${RX + 12}" y="${b.y + 84}">${stl ? `нет заказа №${rep.stale.n}!` : S.t - rep.seq < 900 ? 'Seq Scan…' : `читают: ${rep.n}`}</text><text class="xs-sm" x="${RX + RW - 12}" y="${b.y + 84}" text-anchor="end">кэш страниц</text>`;
          if (S.t - rep.fl < 300) s += `<rect class="xr-hl" x="${RX}" y="${b.y}" width="${RW}" height="${b.h}" rx="10" style="opacity:${r1(1 - (S.t - rep.fl) / 300)}"/>`;
        });
        s += '</g><g data-xpart="shard">';
        /* шарды: вспышки */
        Object.entries(S.shFl).forEach(([k, t]) => { const a = 1 - (S.t - t) / 400; if (a > 0) { const w = shW(), x = Z.x + k * (w + 4); s += `<rect class="xr-hl" x="${r1(x)}" y="20" width="${r1(w)}" height="22" rx="4" style="opacity:${r1(a)}"/>`; } });
        s += '</g>';
        /* падение primary */
        if (S.fl.ph !== 'up') {
          const txt = { down: '✕ PRIMARY УПАЛ', prom: '✕ СТАРЫЙ PRIMARY ЛЕЖИТ', rec: '↻ ПЕРЕЗАПУСК ПО ЖУРНАЛУ' }[S.fl.ph];
          s += `<rect class="xs-dim" x="${Z.x}" y="${Z.y}" width="${Z.w}" height="${WB.y - Z.y - 6}" rx="14"/><text class="xs-big ${S.fl.ph === 'rec' ? 'ok' : ''}" x="${Z.x + Z.w / 2}" y="232">${txt}</text>`;
          s += `<text class="xr-pop" x="${Z.x + Z.w / 2}" y="258" text-anchor="middle">${S.fl.ph === 'down' ? (S.reps.length ? 'выбираем, какая реплика свежее…' : 'реплик нет — запросы получают ошибку') : S.fl.ph === 'prom' ? `записи принимает реплика ${S.np + 1}` : 'применяю подтверждённые записи из WAL'}</text>`;
        }
        gL.innerHTML = s;
      }
      function drawLocks() {
        const H = S.H;
        if (scn !== 'hot' || !H) {
          return `<text class="xr-s" x="226" y="384">Каждая запись меняет свою строку —</text><text class="xr-s" x="226" y="400">спорить не о чем, замки не нужны.</text><text class="xr-m" x="226" y="420">Открой «Толкучку за одну строку».</text>`;
        }
        const dbl = H.lost.length, a = 1 - (S.t - H.fl) / 900;
        let s = `<rect class="xs-row ${dbl ? 'dbl' : H.owner ? 'taken' : ''} ${H.lock ? 'lock' : ''}" x="226" y="364" width="160" height="24" rx="5"/>`;
        s += `<text class="xr-m ${dbl ? 'bad' : H.owner ? 'ok' : ''}" x="234" y="380">место ${H.seat}: ${H.owner ? cut(H.owner, 6) : 'свободно'} · v${H.ver}</text>`;
        if (a > 0) s += `<rect class="xs-row dbl" x="226" y="364" width="160" height="24" rx="5" style="opacity:${r1(a)}"/>`;
        if (H.lock) s += `<rect class="xs-lkb" x="394" y="373" width="12" height="9" rx="2"/><path class="xs-lk" d="M396.5,373 v-3 a3.5,3.5 0 0 1 7,0 v3"/>`;
        if (H.msg) s += `<text class="xs-sm ${H.msg.cls}" x="226" y="426" style="opacity:${r1(Math.max(0.45, 1 - (S.t - H.msg.t) / 2500))}">${esc(H.msg.txt)}</text>`;
        return s;
      }

      /* ---------- отрисовка: точки ---------- */
      function drawDyn() {
        let s = '';
        S.chips.forEach(c => {
          const bp = busPath(c.ri), p = along(bp, plen(bp), (S.t - c.t0) / (c.t1 - c.t0));
          s += `<rect class="xs-chip" x="${r1(p[0] - 13)}" y="${r1(p[1] - 6)}" width="26" height="12" rx="3"/><text class="xs-chipt" x="${r1(p[0])}" y="${r1(p[1] + 3)}">${c.n}</text>`;
        });
        S.acks.forEach(a => { const bp = busPath(a.ri).slice().reverse(), p = along(bp, plen(bp), (S.t - a.t0) / (a.t1 - a.t0)); s += `<circle class="xs-ack" cx="${r1(p[0])}" cy="${r1(p[1])}" r="3.5"/>`; });
        S.reqs.forEach(r => {
          if (r.gone || !r.path) return;
          const [x, y] = cur(r);
          if (r.wait) s += `<circle class="xs-ring ${r.wait}" cx="${r1(x)}" cy="${r1(y)}" r="${r.hot || r.own != null ? 10 : r.wait === 'conn' ? 7 : 9}"/>`;
          const big = r.user && !r.resp && (r.hot || r.own != null);
          s += r.resp ? `<circle class="xr-dot ${r.err ? 'err' : 'ok'}" cx="${r1(x)}" cy="${r1(y)}" r="5"/>` : `<circle class="xr-dot" cx="${r1(x)}" cy="${r1(y)}" r="${big ? 7 : 5}" style="fill:${SD.kindColor(r.kind)}"/>`;
          if (big) s += `<text class="xs-ul" x="${r1(x)}" y="${r1(y + 3)}">${esc(r.user[0])}</text>`;
          if (r.hot && r.tries && !r.resp) s += `<text class="xs-u" x="${r1(x + 9)}" y="${r1(y - 7)}">↺</text>`;
        });
        S.fx.forEach(f => {
          const a = r1(1 - (S.t - f.t) / 1100);
          if (f.k === 'x') s += `<g style="opacity:${a}"><path class="xs-x" d="M${r1(f.x - 6)},${r1(f.y - 6)} l12,12 M${r1(f.x + 6)},${r1(f.y - 6)} l-12,12"/></g>`;
          else s += `<text class="xr-pop ${f.cls || ''}" x="${r1(f.x)}" y="${r1(f.y - (S.t - f.t) / 60)}" text-anchor="middle" style="opacity:${a}">${esc(f.txt)}</text>`;
        });
        gD.innerHTML = s;
      }

      /* ================= провал в блок: живая схема логики одного блока ================= */
      let V = null, vKey = '';
      const tx = (x, y, t, cls, a) => `<text class="${cls || 'xr-s'}" x="${r1(x)}" y="${r1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
      const rc = (x, y, w, h, cls, rx, st) => `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx == null ? 8 : rx}"${st ? ` style="${st}"` : ''}/>`;
      const dot = (p, kind, cls, r) => `<circle class="xr-dot ${cls || ''}" cx="${r1(p[0])}" cy="${r1(p[1])}" r="${r || 6}"${kind ? ` style="fill:${SD.kindColor(kind)}"` : ''}/>`;
      const rng = (p, cls, r) => `<circle class="xs-ring ${cls || ''}" cx="${r1(p[0])}" cy="${r1(p[1])}" r="${r || 10}"/>`;
      const ln = (a, b, cls) => `<line class="${cls || 'xr-wire'}" x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}"/>`;
      const head = (t, sub) => tx(24, 30, t, 'xs-h1') + tx(24, 49, sub, 'xr-s');
      const kbtn = (x, y, w, k, label) => `<g class="xs-btn" data-xsk="${k}" tabindex="0" role="button"><rect x="${x}" y="${y}" width="${w}" height="22" rx="11"/><text x="${x + w / 2}" y="${y + 15}">${label}</text></g>`;
      const wrap = (t, n) => { const out = []; let line = ''; String(t).split(' ').forEach(w => { if ((line + ' ' + w).trim().length > n && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); }); if (line) out.push(line); return out; };
      const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * cl(f, 0, 1), a[1] + (b[1] - a[1]) * cl(f, 0, 1)];
      const vat = (d, f) => V.q.push({ t: V.t + Math.max(0, d), f });
      const vevery = (d, f, first) => { const my = V; const go = () => { if (V !== my) return; f(); vat(typeof d === 'function' ? d() : d, go); }; vat(first == null ? 200 : first, go); };
      const vmv = (o, pts, dur, then) => { o.pts = pts; o.L = plen(pts); o.a = V.t; o.b = V.t + Math.max(1, dur); if (then) vat(dur, () => { if (!o.gone) then(); }); };
      const vhold = (o, p) => { o.pts = [p]; o.a = o.b = V.t; };
      const vpos = o => !o.pts ? [-20, -20] : o.pts.length === 1 || V.t >= o.b ? o.pts[o.pts.length - 1] : along(o.pts, o.L, (V.t - o.a) / (o.b - o.a));
      const vev = k => V.ev.push({ t: V.t, k });
      const vcnt = k => V.ev.filter(e => e.k === k).length;
      const vfl = (k, d) => V.fl[k] != null && V.t - V.fl[k] < (d || 600) ? 1 - (V.t - V.fl[k]) / (d || 600) : 0;
      const vitem = o => { o.id = V.id++; V.items.push(o); return o; };
      function vstep(d) {
        const end = V.t + d;
        for (let g = 0; g < 2000; g++) {
          let mi = -1, mt = Infinity;
          for (let i = 0; i < V.q.length; i++) if (V.q[i].t < mt) { mt = V.q[i].t; mi = i; }
          if (mi < 0 || mt > end) break;
          V.t = mt; V.q.splice(mi, 1)[0].f();
        }
        V.t = end;
        if (V.ev.length > 400 || (V.ev[0] && V.ev[0].t < V.t - 10000)) V.ev = V.ev.filter(e => e.t > V.t - 10000);
        V.items = V.items.filter(o => !o.gone);
        if (PV[V.k].tick) PV[V.k].tick();
      }
      function focusPart(k, arg) {
        gB.innerHTML = gL.innerHTML = gD.innerHTML = ''; baseKey = ''; vKey = '';
        V = k && PV[k] ? { k, t: 0, q: [], ev: [], fl: {}, items: [], id: 1, msg: '' } : null;
        if (V) { Object.assign(V, PV[k].init(arg)); V.sig = PV[k].sig(); }
      }
      function drawPart() {
        const pv = PV[V.k];
        const [key, base] = pv.base();
        if (key !== vKey) { vKey = key; gB.innerHTML = base; }
        gL.innerHTML = pv.live();
        let d = '';
        V.items.forEach(o => {
          if (!o.pts || o.hide) return;
          const p = vpos(o);
          if (o.wait) d += rng(p, o.wait, 10);
          d += o.resp ? dot(p, null, o.err ? 'err' : 'ok') : dot(p, o.cls ? null : (o.kind || 'read'), o.cls || '');
          if (o.tag) d += tx(p[0] + 10, p[1] - 9, esc(o.tag), 'xr-pop' + (o.tagc ? ' ' + o.tagc : ''));
        });
        gD.innerHTML = d;
      }
      const PV = {};

      /* ---------- Соединения ---------- */
      const CN = { ix: 60, iw: 220, top: i => 84 + i * 124 };
      const sqR = (i, j) => [CN.ix + 14 + (j % 5) * 40, CN.top(i) + 48 + Math.floor(j / 5) * 28];
      const sqC = (i, j) => { const [x, y] = sqR(i, j); return [x + 15, y + 11]; };
      const pcR = k => [514 + (k % 10) * 46, 214 + Math.floor(k / 10) * 40];
      const pcC = k => { const [x, y] = pcR(k); return [x + 20, y + 16]; };
      const CEN = i => [CN.ix, CN.top(i) + 60], COUT = i => [-10, CN.top(i) + 60];
      const PM = [607, 160], HS = [472, 200], BXC = [390, 250];
      PV.conn = {
        sig: () => [C.pooler, C.conns, scn].join('|'),
        init(nopool) {
          const ap = C.cs.filter(c => c.pool), insts = ap.reduce((s2, c) => s2 + c.cnt, 0) || 1, pool = (ap[0] && ap[0].pool) || 10, show = Math.min(3, insts);
          vevery(() => 1000 / 3.4 * (0.6 + Math.random() * 0.8), () => PV.conn.arrive(), 300);
          return { insts, pool, show, nopool: !!nopool && !C.pooler, pools: [0, 1, 2].slice(0, show).map(() => Array(pool).fill(null)), srv: Array(C.pooler || nopool ? 20 : Math.min(30, show * pool)).fill(null), wq: [[], [], []], bq: [] };
        },
        arrive() {
          const i = rnd(V.show), r = vitem({ i, kind: Math.random() < 0.3 ? 'write' : 'read' });
          vmv(r, [COUT(i), CEN(i)], 260, () => PV.conn.inst(r));
        },
        inst(r) {
          if (scn === 'conns' && !C.pooler && Math.random() < C.rej) {
            vmv(r, [vpos(r), [CN.ix + CN.iw, CN.top(r.i) + 60], [PM[0] - 60, PM[1]]], 600, () => { V.fl.pm = V.t; vev('rej'); r.gone = true; V.msg = `Запрос №${r.id}: экземпляров ${V.insts}, им нужно ${C.conns} соединений, а база держит ${C.lim}. Новому — «too many clients».`; });
            return;
          }
          if (V.nopool) return PV.conn.handshake(r);
          const j = V.pools[r.i].indexOf(null);
          if (j < 0) { V.wq[r.i].push(r); r.wait = 'conn'; vhold(r, [CN.ix - 16, CN.top(r.i) + 24 + Math.min(3, V.wq[r.i].length - 1) * 22]); vev('wait'); V.msg = `Запрос №${r.id} ждёт: все ${V.pool} соединений пула экземпляра ${r.i + 1} заняты.`; return; }
          PV.conn.take(r, j);
        },
        take(r, j) {
          V.pools[r.i][j] = r; r.j = j; r.wait = null;
          const free = V.pools.reduce((s2, p) => s2 + p.filter(x => !x).length, 0);
          V.msg = `Запрос №${r.id} взял соединение №${j + 1} из пула экземпляра ${r.i + 1}: оно уже открыто, ждать не нужно. Свободно в пулах ${free} из ${V.show * V.pool}.`;
          vmv(r, [vpos(r), sqC(r.i, j)], 160, () => {
            if (C.pooler) return vmv(r, [vpos(r), [CN.ix + CN.iw, sqC(r.i, j)[1]], [330, BXC[1] - 40 + r.i * 30], BXC], 420, () => PV.conn.bouncer(r));
            const k = (r.i * V.pool + j) % V.srv.length;
            PV.conn.exec(r, k, [[CN.ix + CN.iw, sqC(r.i, j)[1]], [490, sqC(r.i, j)[1]]]);
          });
        },
        bouncer(r) {
          const k = V.srv.indexOf(null);
          if (k < 0) { V.bq.push(r); r.wait = 'conn'; vhold(r, [348 + (V.bq.length - 1) % 4 * 24, 330]); vev('bwait'); V.msg = `Запрос №${r.id} ждёт в PgBouncer: все ${V.srv.length} серверных соединений заняты другими транзакциями.`; return; }
          V.msg = `PgBouncer отдал запросу №${r.id} серверное соединение №${k + 1}. После транзакции оно вернётся в общий пул.`;
          PV.conn.exec(r, k, [[450, BXC[1]]]);
        },
        exec(r, k, via) {
          V.srv[k] = r; r.k = k; r.wait = null;
          vmv(r, [vpos(r)].concat(via || [], [pcC(k)]), 380, () => { V.fl['p' + k] = V.t; vev('q'); vat(650, () => { if (!r.gone) PV.conn.release(r); }); });
        },
        release(r) {
          if (V.srv[r.k] === r) V.srv[r.k] = null;
          if (C.pooler) { const nx = V.bq.shift(); V.bq.forEach((x, n) => vmv(x, [vpos(x), [348 + n % 4 * 24, 330]], 150)); if (nx) PV.conn.exec(nx, r.k, [[450, BXC[1]]]); }
          r.resp = true;
          if (r.j == null) { V.fl['c' + r.k] = V.t; vev('close'); vmv(r, [vpos(r), HS, COUT(r.i)], 700, () => { r.gone = true; vev('ok'); }); return; }
          vmv(r, [vpos(r), sqC(r.i, r.j)], 380, () => {
            V.pools[r.i][r.j] = null;
            const nx = V.wq[r.i].shift(); V.wq[r.i].forEach((x, n) => vmv(x, [vpos(x), [CN.ix - 16, CN.top(r.i) + 24 + Math.min(3, n) * 22]], 150));
            if (nx) PV.conn.take(nx, r.j);
            vmv(r, [vpos(r), COUT(r.i)], 300, () => { r.gone = true; vev('ok'); });
          });
        },
        handshake(r) {
          vmv(r, [vpos(r), [CN.ix + CN.iw, CN.top(r.i) + 60], HS], 520, () => {
            let acc = 0;
            [['TCP-рукопожатие', 200], ['TLS-шифрование', 380], ['проверка пароля', 260], ['запуск процесса', 340]].forEach(([s2, d]) => { vat(acc, () => { if (r.gone) return; V.items.forEach(x => { if (x !== r) x.tag = ''; }); r.tag = s2; r.tagc = 'warn'; V.fl.pm = V.t; }); acc += d; });
            vat(acc, () => {
              if (r.gone) return;
              r.tag = '';
              const k = V.srv.indexOf(null);
              if (k < 0) { r.gone = true; vev('rej'); return; }
              V.fl['s' + k] = V.t; vev('hs');
              if (vcnt('hs') >= 2) ctx.done('pool');
              V.msg = `Запрос №${r.id}: пула нет, поэтому сначала рукопожатие ≈ 5 мс (TCP, TLS, пароль, новый процесс) — и только потом сам запрос ≈ 1 мс. Закончит — соединение закроется.`;
              PV.conn.exec(r, k);
            });
          });
        },
        base() {
          const key = ['conn', V.show, V.nopool, C.pooler, C.conns, V.srv.length, scn].join('|');
          let s = head('Соединения: как запрос получает «линию» к базе', 'Каждое соединение — отдельный процесс PostgreSQL со своей памятью. Открыть новое — дорого, поэтому их держат открытыми в пуле.');
          for (let i = 0; i < V.show; i++) {
            const y = CN.top(i);
            s += rc(CN.ix, y, CN.iw, 108, 'xr-box', 10) + tx(CN.ix + 14, y + 20, V.insts > V.show ? `Экземпляр ${i + 1} из ${V.insts}` : `Экземпляр ${i + 1} сервиса`, 'xr-t');
            if (V.nopool) s += tx(CN.ix + 14, y + 38, 'пула нет: на каждый запрос', 'xr-s') + tx(CN.ix + 14, y + 52, 'новое соединение', 'xr-s');
            if (!C.pooler) s += ln([CN.ix + CN.iw, y + 60], [500, y + 60], 'xr-wire dash');
          }
          if (C.pooler) {
            s += rc(300, 110, 180, 260, 'xs-pb', 12) + tx(390, 134, 'PgBouncer', 'xs-pbt', 'middle') + tx(390, 154, `клиентских: ${C.conns}`, 'xr-s', 'middle') + tx(390, 172, `в базу: ${V.srv.length}`, 'xr-m acc', 'middle');
            s += tx(390, 360, 'ждут серверное соединение', 'xr-s', 'middle');
            for (let i = 0; i < V.show; i++) s += ln([CN.ix + CN.iw, CN.top(i) + 60], [300, BXC[1] - 40 + i * 30], 'xr-wire');
            s += ln([480, BXC[1]], [500, BXC[1]], 'xr-wire');
          }
          s += rc(500, 66, 476, 384, 'xr-box', 12) + tx(514, 88, 'PostgreSQL — сервер базы', 'xr-t');
          const over = !C.pooler && C.conns > C.lim;
          s += tx(514, 106, `max_connections = ${C.lim} · ${V.nopool ? 'процессы живут только пока идёт запрос' : `открыто: ${C.pooler ? V.srv.length : Math.min(C.conns, C.lim)}`}`, over ? 'xr-m bad' : 'xr-m');
          s += rc(514, 132, 186, 52, 'xs-pm', 8) + tx(524, 152, 'postmaster', 'xr-t') + tx(524, 170, 'встречает новых', 'xr-s');
          s += tx(712, 146, 'Ниже — процессы: на каждое', 'xr-s') + tx(712, 162, 'соединение свой, ≈ 10 МБ памяти.', 'xr-s') + tx(712, 178, 'Цветной — сейчас выполняет SQL.', 'xr-s');
          if (over) s += tx(514, 400, `Нужно ${C.conns} соединений, а предел ${C.lim}: лишним ${C.conns - C.lim} отказ.`, 'xr-m bad');
          /* сравнение: с пулом и без */
          s += tx(24, 476, 'Сколько стоит получить соединение:', 'xr-t');
          const bar = (y, parts) => { let x = 140, h = ''; parts.forEach(([t, ms2, cls]) => { const w = ms2 * 64; h += rc(x, y, w - 2, 18, 'xs-seg ' + cls, 3) + (w > 40 ? tx(x + w / 2 - 1, y + 13, t, 'xs-segt', 'middle') : ''); x += w; }); return h; };
          s += tx(24, 500, 'с пулом', 'xr-m') + bar(487, [['взял', 0.35, 'ok'], ['запрос 1 мс', 1, 'q']]) + tx(140 + 1.35 * 64 + 8, 500, '≈ 1 мс', 'xr-m ok');
          s += tx(24, 528, 'без пула', 'xr-m') + bar(515, [['TCP', 0.5, 'w'], ['TLS 2 мс', 2, 'w'], ['пароль', 1, 'w'], ['процесс 2 мс', 2, 'w'], ['запрос', 1, 'q']]) + tx(140 + 6.5 * 64 + 8, 528, '≈ 6,5 мс', 'xr-m warn');
          if (!C.pooler) s += kbtn(830, 466, 146, 'nopool', V.nopool ? '↺ вернуть пул' : '✕ выключить пул');
          return [key, s];
        },
        live() {
          let s = '';
          for (let i = 0; i < V.show; i++) {
            const y = CN.top(i), busy = V.pools[i].filter(Boolean).length;
            if (!V.nopool) {
              s += tx(CN.ix + 14, y + 38, `пул: ${V.pool} · занято ${busy}${V.wq[i].length ? ` · ждут ${V.wq[i].length}` : ''}`, V.wq[i].length ? 'xr-m warn' : 'xr-m');
              V.pools[i].forEach((r, j) => { const [x, yy] = sqR(i, j); s += rc(x, yy, 30, 22, 'xr-slot' + (r ? ' xs-on' : ''), 4, r ? `fill:${SD.kindColor(r.kind)};stroke:${SD.kindColor(r.kind)}` : ''); });
            }
          }
          if (C.pooler) { const b = V.srv.filter(Boolean).length; s += tx(390, 196, `серверных занято ${b} из ${V.srv.length}`, 'xr-m', 'middle'); }
          V.srv.forEach((r, k) => {
            const [x, y] = pcR(k), sp = vfl('s' + k, 500), cz = vfl('c' + k, 500);
            if (V.nopool && !r && !cz) { s += rc(x, y, 40, 32, 'xs-proc e', 5); return; }
            s += rc(x, y, 40, 32, 'xs-proc' + (r ? ' on' : ''), 5, r ? `stroke:${SD.kindColor(r.kind)}` : '');
            if (sp) s += rc(x, y, 40, 32, 'xs-fl load', 5, `opacity:${r1(sp)}`);
            if (cz) s += rc(x, y, 40, 32, 'xs-fl ev', 5, `opacity:${r1(cz)}`);
          });
          const open = V.nopool ? V.srv.filter(Boolean).length : C.pooler ? V.srv.length : Math.min(C.conns, C.lim);
          s += tx(514, 380, `память процессов: ${open} × ≈ 10 МБ = ${open * 10} МБ`, 'xr-s');
          const a = vfl('pm', 500); if (a) s += rc(514, 132, 186, 52, 'xr-hl', 8, `opacity:${r1(a)}`);
          return s;
        },
        now() {
          const intro = V.nopool ? '<b>Пул выключен.</b> Каждый запрос сначала договаривается с базой (оранжевые подписи у точки) и запускает процесс — это в разы дольше самого запроса.' : C.pooler ? '<b>PgBouncer</b> держит в базе 20 соединений и выдаёт их запросам только на время транзакции.' : '<b>Пул соединений.</b> Квадратики — заранее открытые соединения: запрос берёт свободное и возвращает.';
          return `${intro} ${V.msg || ''}`;
        },
        stats() {
          const open = V.nopool ? V.srv.filter(Boolean).length : C.pooler ? V.srv.length : Math.min(C.conns, C.lim);
          return [['Процессов у базы', String(open), '', `предел max_connections = ${C.lim}`], ['Память на них', `${open * 10} МБ`, '', '≈ 10 МБ на соединение'],
            ['Ждали соединение', String(vcnt('wait') + vcnt('bwait')), vcnt('wait') + vcnt('bwait') ? 'warn' : 'ok', 'за 10 с'], ['Рукопожатий', String(vcnt('hs')), vcnt('hs') ? 'warn' : 'ok', V.nopool ? '≈ 5 мс каждое' : 'с пулом их нет'],
            ['Отказы', String(vcnt('rej')), vcnt('rej') ? 'bad' : 'ok', 'too many clients, за 10 с']];
        }
      };

      /* ---------- Планировщик ---------- */
      const TREE = { root: [430, 330, 140], br: [[150, 384, 140], [430, 384, 140], [710, 384, 140]] };
      PV.plan = {
        sig: () => String(C.idx),
        init() { vat(80, () => PV.plan.next()); return { ph: 'parse', p0: 0, pd: 1, qn: 0, uid: 42, idx: C.idx, seen: 0 }; },
        next() {
          V.qn++; V.uid = 1 + rnd(999999); V.idx = C.idx;
          const st = [['parse', 900], ['cost', 1200], ['choose', 800], ['exec', V.idx ? 2000 : 3200], ['done', 1400]];
          let acc = 0;
          st.forEach(([ph, d]) => { vat(acc, () => { V.ph = ph; V.p0 = V.t; V.pd = d; if (ph === 'exec') { vev(V.idx ? 'idx' : 'seq'); if (!V.idx) ctx.done('idx'); } }); acc += d; });
          vat(acc, () => PV.plan.next());
        },
        f: () => cl((V.t - V.p0) / V.pd, 0, 1),
        path() {
          const b = Math.min(2, Math.floor((V.uid - 1) / 333334)), lf = Math.min(2, Math.floor(((V.uid - 1) % 333334) / 111112));
          const bc = TREE.br[b], lx = cl(bc[0] + 70 + (lf - 1) * 150, 90, 830);
          return { b, lf, pts: [[500, 296], [500, 343], [bc[0] + 70, 397], [lx, 451], [900, 451]] };
        },
        base() {
          const key = ['plan', V.idx, V.qn].join('|');
          let s = head('Планировщик: как база решает, где искать строку', 'Запрос — это текст. База разбирает его, придумывает способы найти данные, считает цену каждого и выполняет самый дешёвый.');
          s += `<g class="xs-btn" data-xsidx="1" tabindex="0" role="button"><rect x="812" y="16" width="164" height="22" rx="11"/><text x="894" y="31">${V.idx ? '✕ убрать индекс' : '＋ вернуть индекс'}</text></g>`;
          s += rc(24, 62, 952, 42, 'xs-code', 8) + tx(40, 89, `SELECT * FROM orders WHERE user_id = ${V.uid.toLocaleString('ru-RU')};`, 'xs-sql');
          s += rc(24, 152, 464, 128, 'xs-card' + (V.idx ? '' : ''), 10) + rc(512, 152, 464, 128, 'xs-card' + (V.idx ? '' : ' off'), 10);
          s += tx(40, 176, 'Seq Scan — перебрать всю таблицу', 'xr-t') + tx(40, 196, 'прочитать все 12 500 страниц по 8 КБ', 'xr-s') + tx(40, 213, 'и проверить каждую из 1 000 000 строк', 'xr-s');
          if (V.idx) s += tx(528, 176, 'Index Scan по индексу orders_user_idx', 'xr-t') + tx(528, 196, 'спуститься по B-дереву: 3 шага', 'xr-s') + tx(528, 213, 'и прочитать 1 страницу с нужной строкой', 'xr-s');
          else s += tx(528, 176, 'Index Scan — невозможен', 'xr-t') + tx(528, 196, 'индекса по user_id нет: искать по каталогу', 'xr-s') + tx(528, 213, 'нечем, остаётся только перебор', 'xr-s');
          s += rc(24, 292, 952, 178, 'xr-box', 10) + tx(40, 312, 'Выполнение', 'xr-t');
          if (V.idx) {
            const P = PV.plan.path();
            s += tx(40, 330, 'B-дерево индекса: в каждом узле — границы ключей', 'xr-s');
            s += rc(TREE.root[0], TREE.root[1], TREE.root[2], 26, 'xs-tree', 4) + tx(500, TREE.root[1] + 17, '333 334 | 666 667', 'xs-tk', 'middle');
            TREE.br.forEach((b, k) => { s += ln([500, 356], [b[0] + 70, b[1]], 'xs-tl' + (k === P.b ? '' : ' off')) + rc(b[0], b[1], b[2], 26, 'xs-tree' + (k === P.b ? '' : ' off'), 4) + tx(b[0] + 70, b[1] + 17, ['1 … 333 333', '333 334 … 666 666', '666 667 … 1 000 000'][k], 'xs-tk', 'middle'); });
            const bc = TREE.br[P.b];
            for (let l = 0; l < 3; l++) { const lx = cl(bc[0] + 70 + (l - 1) * 150, 90, 830), a = 1 + P.b * 333333 + l * 111111; s += ln([bc[0] + 70, 410], [lx, 438], 'xs-tl' + (l === P.lf ? '' : ' off')) + rc(lx - 62, 438, 124, 26, 'xs-tree' + (l === P.lf ? '' : ' off'), 4) + tx(lx, 455, `лист: ${Math.round(a / 1000)}k…${Math.round((a + 111110) / 1000)}k`, 'xs-tk', 'middle'); }
            s += rc(850, 432, 116, 36, 'xs-heap', 6) + tx(908, 447, `стр. ${Math.floor(V.uid / 80)}`, 'xs-tk', 'middle') + tx(908, 461, `user_id = ${V.uid}`, 'xs-tk', 'middle');
          } else {
            s += tx(40, 330, 'Страницы таблицы (показаны 30 из 12 500) — читаются подряд, каждая строка проверяется', 'xr-s');
            for (let k = 0; k < 30; k++) s += rc(40 + (k % 15) * 61, 344 + Math.floor(k / 15) * 44, 54, 34, 'xs-cell', 4);
          }
          s += rc(24, 480, 952, 64, 'xs-code', 8);
          return [key, s];
        },
        live() {
          let s = '';
          const f = PV.plan.f(), ph = V.ph, ord = ['parse', 'cost', 'choose', 'exec', 'done'], at2 = ord.indexOf(ph);
          ['1 · разбор текста', '2 · варианты и цена', '3 · выбор плана', '4 · выполнение', '5 · ответ'].forEach((t, k) => { s += rc(24 + k * 192, 116, 184, 26, 'xs-stage' + (k === at2 ? ' on' : k < at2 ? ' done' : ''), 13) + tx(24 + k * 192 + 92, 133, t, 'xs-stt', 'middle'); });
          if (ph === 'parse') s += rc(36, 68, 20 + f * 560, 30, 'xs-scan', 4);
          else s += tx(960, 89, `✓ синтаксис верен · таблица orders · условие user_id = …`, 'xr-m ok', 'end');
          const cf = ph === 'cost' ? f : at2 > 1 ? 1 : 0;
          if (cf > 0) {
            s += tx(40, 250, `цена ≈ ${Math.round(25000 * cf).toLocaleString('ru-RU')}`, 'xs-cost');
            if (V.idx) s += tx(528, 250, `цена ≈ ${(8.4 * cf).toFixed(1).replace('.', ',')}`, 'xs-cost');
          }
          if (at2 >= 2) {
            s += tx(40, 270, V.idx ? '✗ дороже в ≈ 3 000 раз' : '✓ выбран: другого варианта нет', V.idx ? 'xr-m bad' : 'xr-m warn');
            if (V.idx) s += tx(528, 270, '✓ выбран: самый дешёвый', 'xr-m ok');
            s += rc(V.idx ? 512 : 24, 152, 464, 128, 'xs-win', 10);
          }
          if (ph === 'exec' || ph === 'done') {
            const ff = ph === 'done' ? 1 : f;
            if (V.idx) {
              const P = PV.plan.path(), steps = [`корень: ${V.uid} → ветка ${P.b + 1}`, `ветка → лист ${P.lf + 1}`, `лист → страница ${Math.floor(V.uid / 80)}`];
              s += tx(960, 330, steps.slice(0, Math.min(3, 1 + Math.floor(ff * 3.2))).join(' · '), 'xr-m acc', 'end');
              if (ph === 'exec') { const p = along(P.pts, plen(P.pts), ff); s += dot(p, 'read', '', 7); }
              else s += rc(850, 432, 116, 36, 'xs-fl hit', 6, 'opacity:.35');
            } else {
              const k = Math.min(29, Math.floor(ff * 30));
              for (let j = 0; j <= k; j++) s += rc(40 + (j % 15) * 61, 344 + Math.floor(j / 15) * 44, 54, 34, 'xs-fl scan', 4, `opacity:${j === k && ph === 'exec' ? 0.9 : 0.3}`);
              if (ph === 'exec') s += dot([67 + (k % 15) * 61, 361 + Math.floor(k / 15) * 44], null, 'xs-op rand', 7);
              s += tx(40, 452, `проверено строк: ${Math.round(ff * 1000000).toLocaleString('ru-RU')} из 1 000 000 · подходит 1`, 'xr-m warn');
            }
          }
          if (at2 >= 2) {
            s += tx(40, 504, V.idx ? 'Index Scan using orders_user_idx on orders  (cost=0.42..8.44 rows=1)' : 'Seq Scan on orders  (cost=0.00..25000.00 rows=1)', 'xs-sql sm');
            s += tx(40, 528, V.idx ? `  Index Cond: (user_id = ${V.uid})${ph === 'done' ? '   → 1 строка за ≈ 0,05 мс' : ''}` : `  Filter: (user_id = ${V.uid})   Rows Removed by Filter: 999 999${ph === 'done' ? '   → ≈ 85 мс' : ''}`, 'xs-sql sm' + (ph === 'done' ? (V.idx ? ' ok' : ' warn') : ''));
          } else s += tx(40, 516, 'EXPLAIN покажет здесь выбранный план после шага 3', 'xr-s');
          return s;
        },
        now() {
          const ph = V.ph;
          if (ph === 'parse') return `<b>Шаг 1. Разбор.</b> База читает текст запроса №${V.qn}, проверяет синтаксис и находит таблицу orders и колонку user_id.`;
          if (ph === 'cost') return V.idx ? '<b>Шаг 2. Цена вариантов.</b> По статистике таблицы планировщик оценивает: перебор — 12 500 страниц и миллион проверок; индекс — 3 шага по дереву и одна страница.' : '<b>Шаг 2. Цена.</b> Индекса по user_id нет — вариант всего один: перебрать всю таблицу.';
          if (ph === 'choose') return V.idx ? '<b>Шаг 3. Выбор.</b> Index Scan дешевле в тысячи раз — берём его.' : '<b>Шаг 3. Выбор.</b> Выбирать не из чего: Seq Scan.';
          if (ph === 'exec') return V.idx ? `<b>Шаг 4. Спуск по B-дереву.</b> В каждом узле база сравнивает ${V.uid} с границами и идёт в нужную ветку. Три шага — и мы на странице с нужной строкой.` : '<b>Шаг 4. Полный перебор.</b> База читает страницу за страницей и проверяет каждую строку. Пока перебирает — держит соединение и место в памяти.';
          return V.idx ? '<b>Готово за доли миллисекунды.</b> Убери индекс кнопкой справа вверху картинки — увидишь, как тот же запрос превращается в перебор.' : '<b>Готово, но в тысячи раз дольше.</b> Верни индекс кнопкой справа вверху — запрос снова пойдёт по дереву.';
        },
        stats() { return [['План', V.idx ? 'Index Scan' : 'Seq Scan', V.idx ? 'ok' : 'warn', `запрос №${V.qn}`], ['Страниц прочитать', V.idx ? '≈ 4' : '12 500', V.idx ? 'ok' : 'bad', V.idx ? '3 узла дерева + 1' : 'вся таблица'], ['Время', V.idx ? '≈ 0,05 мс' : '≈ 85 мс', V.idx ? 'ok' : 'bad', 'оценка для 1 млн строк'], ['Через индекс', String(vcnt('idx')), '', 'запросов за 10 с'], ['Перебором', String(vcnt('seq')), vcnt('seq') ? 'warn' : 'ok', 'запросов за 10 с']]; }
      };

      /* ---------- Буферный кэш ---------- */
      const BF = { x: c => 324 + c * 82, y: r => 92 + r * 68 };
      const bfC = i => [BF.x(i % 8) + 38, BF.y(Math.floor(i / 8)) + 31];
      const REQ = [286, 102];
      PV.buf = {
        sig: () => [C.pages, scn].join('|'),
        init() {
          const P = cl(Math.round(32 * C.pages / FR), 20, 400), fr = [];
          for (let k = 0; k < 32; k++) fr.push({ pg: k < P ? k : null, use: k < P ? 1 + rnd(3) : 0, d: false });
          vevery(1300, () => PV.buf.req(), 300);
          vevery(9000, () => PV.buf.ckpt(), 9000);
          return { P, fr, hand: 0, busy: false, step: '', bucket: -1, pg: null };
        },
        nd: () => Math.min(40, V.P),
        dc: pg => Math.min(PV.buf.nd() - 1, Math.floor(pg * PV.buf.nd() / V.P)),
        dC: pg => [24 + (PV.buf.dc(pg) + 0.5) * 952 / PV.buf.nd(), 424],
        req() {
          if (V.busy) return;
          V.busy = true;
          const pg = Math.floor(V.P * Math.pow(Math.random(), 2.2)), w = Math.random() < 0.3, r = vitem({ kind: w ? 'write' : 'read', pg, w });
          V.pg = pg; V.step = 'look'; V.bucket = pg % 8; V.cur = r;
          V.msg = `Нужна страница №${pg} (8 КБ). Ищу в хеш-таблице: ${pg} → корзина ${pg % 8}…`;
          vmv(r, [[-10, REQ[1]], REQ], 300);
          vat(700, () => {
            const fi = V.fr.findIndex(f => f.pg === pg);
            if (fi >= 0) return PV.buf.hit(r, fi);
            PV.buf.miss(r);
          });
        },
        hit(r, fi) {
          V.step = 'hit'; vev('hit');
          V.msg = `<b>Попадание.</b> Страница №${r.pg} уже в ячейке ${fi + 1} — читаю из памяти за доли микросекунды. Счётчик использования +1.`;
          vmv(r, [vpos(r), bfC(fi)], 320, () => { const f = V.fr[fi]; f.use = Math.min(3, f.use + 1); if (r.w) f.d = true; V.fl['h' + fi] = V.t; vat(500, () => PV.buf.fin(r)); });
        },
        miss(r) {
          V.step = 'sweep'; vev('miss');
          V.msg = `<b>Промах.</b> Страницы №${r.pg} в памяти нет. Стрелка часов ищет ячейку со счётчиком 0: у кого не 0 — уменьшает на 1 и идёт дальше.`;
          const sw = n => {
            const i = V.hand, f = V.fr[i];
            if (f.pg == null || f.use === 0 || n > 96) return PV.buf.evict(r, i);
            f.use--; V.fl['u' + i] = V.t; V.hand = (i + 1) % 32;
            vat(150, () => sw(n + 1));
          };
          vat(150, () => sw(0));
        },
        evict(r, i) {
          const f = V.fr[i]; V.hand = (i + 1) % 32;
          const go = () => {
            const old = f.pg;
            if (old != null) { V.fl['e' + i] = V.t; vev('evict'); ctx.done('clock'); }
            V.step = 'read';
            V.msg = `${old != null ? `Вытесняю страницу №${old} из ячейки ${i + 1} (счётчик 0 — её давно не читали). ` : `Ячейка ${i + 1} свободна. `}Читаю №${r.pg} с диска — это в сотни раз дольше попадания.`;
            f.pg = null;
            vmv(r, [vpos(r), [vpos(r)[0], 400], PV.buf.dC(r.pg)], 450, () => { V.fl['d' + PV.buf.dc(r.pg)] = V.t; vmv(r, [vpos(r), [bfC(i)[0], 400], bfC(i)], 600, () => { f.pg = r.pg; f.use = 1; f.d = !!r.w; V.fl['l' + i] = V.t; vev('load'); vat(500, () => PV.buf.fin(r)); }); });
          };
          if (f.d) {
            V.step = 'flush';
            V.msg = `Ячейка ${i + 1}: страница №${f.pg} изменена («грязная»). Сначала записываю её на диск, иначе изменение пропадёт.`;
            const wdot = vitem({ kind: 'write' }); vmv(wdot, [bfC(i), [bfC(i)[0], 400], PV.buf.dC(f.pg)], 500, () => { wdot.gone = true; V.fl['d' + PV.buf.dc(f.pg)] = V.t; f.d = false; go(); });
          } else go();
        },
        fin(r) { r.resp = true; vmv(r, [vpos(r), [-10, REQ[1]]], 450, () => { r.gone = true; }); V.busy = false; V.step = ''; V.bucket = -1; },
        ckpt() {
          const d = V.fr.map((f, i) => f.d ? i : -1).filter(i => i >= 0);
          if (!d.length) return;
          d.forEach(i => { const f = V.fr[i], w = vitem({ kind: 'write' }); vmv(w, [bfC(i), [bfC(i)[0], 400], PV.buf.dC(f.pg)], 700, () => { w.gone = true; f.d = false; V.fl['d' + PV.buf.dc(f.pg)] = V.t; }); });
          vev('ckpt');
          V.msg = `<b>Checkpoint:</b> ${d.length} изменённых ${pl(d.length, 'страница записывается', 'страницы записываются', 'страниц записываются')} на диск пачкой. После этого их можно спокойно вытеснять.`;
        },
        base() {
          const key = ['buf', V.P].join('|');
          let s = head('Буферный кэш: страницы по 8 КБ в памяти', 'Сначала ищем страницу в памяти. Нет — читаем с диска, а место освобождаем у давно не нужной страницы (алгоритм «часы»).');
          s += rc(24, 66, 280, 158, 'xr-box', 10) + tx(38, 88, 'Запрос', 'xr-t');
          s += rc(24, 232, 280, 158, 'xr-box', 10) + tx(38, 252, 'Хеш-таблица: страница → ячейка', 'xr-t');
          s += tx(324, 80, `Память: 32 ячейки (shared_buffers), таблица — ${V.P} страниц`, 'xr-t');
          s += tx(24, 404, `Диск: таблица — ${V.P} ${pl(V.P, 'страница', 'страницы', 'страниц')}${V.P > 40 ? ' (клетка — несколько страниц)' : ''}; голубые — сейчас и в памяти`, 'xr-t');
          s += tx(24, 482, 'Точки в ячейке — счётчик использования: +1 при каждом чтении (на схеме до 3, в PostgreSQL до 5).', 'xr-s');
          s += tx(24, 500, 'Стрелка часов идёт по кругу и уменьшает счётчик на 1; где 0 — ту страницу и вытесняем.', 'xr-s');
          s += tx(24, 518, 'Так страницы, которые читают часто, остаются в памяти, а случайные уходят первыми.', 'xr-s');
          return [key, s];
        },
        live() {
          let s = '';
          s += tx(38, 116, V.pg != null && V.busy ? `нужна стр. №${V.pg}` : 'ждёт следующий запрос', 'xs-big2');
          [['look', '1 · ищу в хеш-таблице'], ['hit', '2 · нашлась → читаю из памяти'], ['sweep', '2 · нет → стрелка ищет, кого убрать'], ['flush', '3 · грязную сначала на диск'], ['read', '4 · читаю с диска в ячейку']].forEach(([k, t], n) => { s += tx(38, 140 + n * 17, t, 'xs-step' + (V.step === k ? ' on' : '')); });
          for (let b = 0; b < 8; b++) {
            const pgs = V.fr.map((f, i) => f.pg != null && f.pg % 8 === b ? `${f.pg}→${i + 1}` : null).filter(Boolean);
            s += tx(38, 272 + b * 15, `${b}: ${pgs.slice(0, 4).join('  ')}${pgs.length > 4 ? ' …' : ''}`, 'xs-hrow' + (V.bucket === b ? ' on' : ''));
          }
          V.fr.forEach((f, i) => {
            const x = BF.x(i % 8), y = BF.y(Math.floor(i / 8));
            s += rc(x, y, 76, 62, 'xs-frame' + (f.pg == null ? ' e' : '') + (f.d ? ' d' : ''), 6);
            s += tx(x + 38, y + 28, f.pg == null ? 'пусто' : `№${f.pg}`, 'xs-fpg', 'middle') + (f.pg != null ? tx(x + 38, y + 48, '●'.repeat(f.use) + '○'.repeat(3 - f.use), 'xs-pip', 'middle') : '');
            [['h', 'hit'], ['l', 'load'], ['e', 'ev'], ['u', 'scan']].forEach(([k, c]) => { const a = vfl(k + i, k === 'u' ? 300 : 700); if (a) s += rc(x, y, 76, 62, 'xs-fl ' + c, 6, `opacity:${r1(a * (k === 'u' ? 0.5 : 0.85))}`); });
          });
          const hx = BF.x(V.hand % 8) + 38, hy = BF.y(Math.floor(V.hand / 8));
          s += `<path class="xs-hand" d="M${hx - 7},${hy - 9} h14 l-7,8 z"/>` + rc(BF.x(V.hand % 8), hy, 76, 62, 'xs-handr', 6);
          const inMem = new Set(V.fr.filter(f => f.pg != null).map(f => PV.buf.dc(f.pg)));
          const nd = PV.buf.nd(), cw = 952 / nd;
          for (let k = 0; k < nd; k++) { s += rc(24 + k * cw, 412, cw - 3, 24, 'xs-cell' + (inMem.has(k) ? ' m' : ''), 3); const a = vfl('d' + k, 700); if (a) s += rc(24 + k * cw, 412, cw - 3, 24, 'xs-fl load', 3, `opacity:${r1(a)}`); }
          const h = vcnt('hit'), m = vcnt('miss');
          s += tx(976, 404, `попаданий за 10 с: ${h + m ? Math.round(h / (h + m) * 100) : 100} %`, h + m && h / (h + m) < 0.8 ? 'xr-m bad' : 'xr-m ok', 'end');
          return s;
        },
        now() { return (V.msg || 'Жду запрос страницы…') + (V.P <= 32 ? ' <br>Сейчас вся таблица влезает в память — промахов почти нет. Открой ситуацию «Данные не влезают в память», чтобы увидеть работу стрелки часов.' : ''); },
        stats() { const h = vcnt('hit'), m = vcnt('miss'); return [['Попадания', `${h + m ? Math.round(h / (h + m) * 100) : 100} %`, h + m && h / (h + m) < 0.8 ? 'bad' : 'ok', `${h} из ${h + m} за 10 с`], ['Промахи → диск', String(m), m ? 'warn' : 'ok', 'за 10 с'], ['Вытеснено', String(vcnt('evict')), vcnt('evict') ? 'warn' : 'ok', 'страниц за 10 с'], ['Изменённых', String(V.fr.filter(f => f.d).length), '', 'ждут checkpoint'], ['Влезает', `${Math.min(32, V.P)} из ${V.P}`, V.P > 32 ? 'warn' : 'ok', 'страниц таблицы']]; }
      };

      /* ---------- Диск ---------- */
      const DF = { c: k => [24 + (k % 16) * 36, 222 + Math.floor(k / 16) * 36], w: k => [630 + (k % 6) * 58, 222 + Math.floor(k / 6) * 36] };
      PV.disk = {
        sig: () => [C.pages, scn].join('|'),
        init() {
          vevery(() => 1000 / (0.9 + 3.5 * (1 - hitP())) * (0.6 + Math.random() * 0.8), () => PV.disk.add('rand'), 300);
          vevery(() => 1100 * (0.7 + Math.random() * 0.6), () => PV.disk.add('wal'), 500);
          vevery(8000, () => { for (let k = 0; k < 5; k++) PV.disk.add('ckpt'); }, 4000);
          return { dq: [], busy: null, wp: 0, wal: [] };
        },
        add(type) {
          const o = vitem({ type, kind: type === 'rand' ? 'read' : 'write', cls: 'xs-op ' + type, page: rnd(80) });
          if (V.dq.length >= 16) { o.gone = true; vev('drop'); return; }
          V.dq.push(o); vmv(o, [[-10, 488], PV.disk.qp(V.dq.length - 1)], 300); o.wait = 'disk';
          PV.disk.pump();
        },
        qp: n => [60 + n * 24, 488],
        pump() {
          if (V.busy || !V.dq.length) return;
          const o = V.dq.shift(); V.busy = o; o.wait = null;
          V.dq.forEach((x, n) => vmv(x, [vpos(x), PV.disk.qp(n)], 150));
          let tgt, dur;
          if (o.type === 'wal') { tgt = DF.w(V.wp); o.wcell = V.wp; dur = 80; } else { const [x, y] = DF.c(o.page); tgt = [x + 16, y + 15]; dur = o.type === 'rand' ? 300 * (scn === 'spill' ? 1.4 : 1) : 160; }
          if (o.type === 'wal') tgt = [tgt[0] + 26, tgt[1] + 15];
          V.msg = o.type === 'rand' ? `Случайное чтение страницы №${o.page}: головка (или контроллер SSD) прыгает к нужному месту — ≈ 0,1 мс.` : o.type === 'wal' ? 'Дописываю запись в конец журнала — последовательная запись, это быстро. Коммит ждёт fsync.' : `Checkpoint пишет изменённую страницу №${o.page} в файл таблицы.`;
          vmv(o, [vpos(o), [o.type === 'wal' ? 800 : 300, 456], tgt], 170, () => {
            vat(dur, () => {
              if (o.type === 'wal') { V.wal[o.wcell] = V.t; V.wp = (V.wp + 1) % 18; } else V.fl['c' + o.page] = V.t;
              vev(o.type); o.gone = true; V.busy = null; PV.disk.pump();
            });
          });
        },
        base() {
          let s = head('Диск: где база хранит всё на самом деле', 'Таблицы и индексы — файлы из страниц по 8 КБ. Журнал WAL — отдельные файлы, в которые только дописывают. Диск переживает выключение, память — нет.');
          const rows = [['Память (RAM) — страница из кэша', 100, '≈ 0,1 мкс', 'ok'], ['SSD, подряд (журнал, Seq Scan)', 8000, '≈ 8 мкс на страницу', ''], ['SSD, вразнобой (промах кэша)', 100000, '≈ 100 мкс', 'warn'], ['Обычный жёсткий диск (HDD)', 8000000, '≈ 8 мс', 'bad']];
          rows.forEach(([t, ns, lab, c], k) => { const y = 72 + k * 30, w = (Math.log10(ns) - 1.5) * 92; s += tx(24, y + 14, t, 'xr-s') + rc(300, y + 2, w, 16, 'xs-lat ' + c, 3) + tx(308 + w, y + 15, lab, 'xr-m'); });
          s += tx(24, 205, 'base/16384/orders — файл таблицы (показаны 80 страниц)', 'xr-t');
          for (let k = 0; k < 80; k++) { const [x, y] = DF.c(k); s += rc(x, y, 32, 30, 'xs-cell', 3); }
          s += tx(630, 205, 'pg_wal — журнал: только в конец', 'xr-t');
          for (let k = 0; k < 18; k++) { const [x, y] = DF.w(k); s += rc(x, y, 52, 30, 'xs-tape e', 3); }
          s += tx(24, 446, 'Очередь к диску', 'xr-t') + tx(170, 446, 'у диска есть предел операций в секунду (IOPS) — лишние ждут', 'xr-s');
          s += tx(24, 530, 'Оранжевые — случайные чтения страниц (промахи кэша), фиолетовые — дописывание журнала, голубые — запись checkpoint.', 'xr-s');
          return ['disk', s];
        },
        live() {
          let s = '';
          for (let k = 0; k < 80; k++) { const a = vfl('c' + k, 900); if (a) { const [x, y] = DF.c(k); s += rc(x, y, 32, 30, 'xs-fl load', 3, `opacity:${r1(a)}`); } }
          for (let k = 0; k < 18; k++) { const [x, y] = DF.w(k), t = V.wal[k]; if (t != null) s += rc(x, y, 52, 30, 'xs-tape wr', 3, `opacity:${r1(Math.max(0.35, 1 - (V.t - t) / 6000))}`); }
          const [wx, wy] = DF.w(V.wp); s += rc(wx, wy, 52, 30, 'xs-handr', 3) + tx(wx + 26, wy + 44, '▲ конец', 'xs-mkt', 'middle');
          s += tx(976, 446, `в очереди: ${V.dq.length}`, V.dq.length > 6 ? 'xr-m bad' : V.dq.length > 2 ? 'xr-m warn' : 'xr-m', 'end');
          return s;
        },
        now() { return (V.msg || '') + (scn === 'spill' ? ' <b>Данные не влезают в память:</b> промахов больше, случайных чтений больше — очередь к диску растёт.' : ' Включи ситуацию «Данные не влезают в память» — случайных чтений станет больше.'); },
        stats() { return [['Случайные чтения', String(vcnt('rand')), vcnt('rand') > 20 ? 'warn' : '', 'за 10 с, по ≈ 0,1 мс'], ['Запись журнала', String(vcnt('wal')), '', 'за 10 с, подряд'], ['Checkpoint', String(vcnt('ckpt')), '', 'страниц за 10 с'], ['Очередь', String(V.dq.length), V.dq.length > 6 ? 'bad' : V.dq.length > 2 ? 'warn' : 'ok', 'операций ждут диск']]; }
      };

      /* ---------- Блокировки и изоляция ---------- */
      const LX = t => 170 + t / 5600 * 790, LANE_Y = { A: 250, B: 370 };
      PV.lock = {
        sig: () => [C.iso, C.lock].join('|'),
        init() { vevery(7800, () => { V.T0 = V.t; V.sc = PV.lock.build(); V.seen = 0; V.cyc++; }, 0); return { T0: 0, sc: null, seen: 0, cyc: 0 }; },
        build() {
          const L = C.lock, I = C.iso, ev = [], vers = [{ t: 0, who: 'свободно', tx: 100 }], waits = [];
          const A = (t, txt, c) => ev.push({ l: 'A', t, txt, c: c || '' }), B = (t, txt, c) => ev.push({ l: 'B', t, txt, c: c || '' });
          let res;
          if (L === 'pessimistic') {
            A(0, 'BEGIN'); A(500, 'SELECT … FOR UPDATE: замок 🔒 взят, видит v1 «свободно»'); A(2200, 'UPDATE → v2 «Аня»'); A(3200, 'COMMIT, замок снят', 'ok');
            B(300, 'BEGIN'); B(1000, 'SELECT … FOR UPDATE: строка заперта — жду', 'warn'); waits.push([1000, 3200]); B(3500, 'замок получен, видит v2 «Аня»: занято'); B(4400, 'ROLLBACK → «мест нет»', 'ok');
            vers.push({ t: 2200, who: 'Аня', tx: 101 });
            res = ['ok', 'Бронь у Ани. Борис подождал замок и честно получил «мест нет». Откатов нет, но B стоял в очереди 2,2 с.'];
          } else if (L === 'optimistic') {
            A(0, 'BEGIN'); A(500, 'SELECT: v1 «свободно», version = 1'); A(2200, 'UPDATE … WHERE version = 1 → 1 строка'); A(3000, 'COMMIT', 'ok');
            B(300, 'BEGIN'); B(1000, 'SELECT: v1 «свободно», version = 1'); B(3300, 'UPDATE … WHERE version = 1 → 0 строк: опоздал', 'bad'); B(4100, 'повтор: SELECT → v2 «Аня», занято', 'warn'); B(4900, '«мест нет»', 'ok');
            vers.push({ t: 2200, who: 'Аня', tx: 101 });
            res = ['ok', 'Бронь у Ани. У Бориса проверка версии не прошла — он перечитал строку и получил «мест нет». Двойной брони нет.'];
          } else if (I === 'rc') {
            A(0, 'BEGIN'); A(500, 'SELECT: видит v1 «свободно»'); A(2200, 'UPDATE → v2 «Аня»'); A(3000, 'COMMIT — «забронировано»', 'ok');
            B(300, 'BEGIN'); B(1000, 'SELECT: видит v1 «свободно»'); B(3300, 'UPDATE → v3 «Борис»: затирает Аню', 'bad'); B(4100, 'COMMIT — тоже «забронировано»', 'bad');
            vers.push({ t: 2200, who: 'Аня', tx: 101 }, { t: 3300, who: 'Борис', tx: 102 });
            res = ['bad', 'Обоим ответили «забронировано», а в базе — Борис. Бронь Ани потеряна: это потерянное обновление. Read Committed такого не ловит.'];
          } else {
            A(0, 'BEGIN'); A(500, 'SELECT: снимок, видит v1 «свободно»'); A(2200, 'UPDATE → v2 «Аня»'); A(3000, 'COMMIT', 'ok');
            B(300, 'BEGIN'); B(1000, 'SELECT: снимок, видит v1 «свободно»'); B(3300, 'UPDATE → ERROR: could not serialize', 'bad'); B(3900, 'ROLLBACK', 'warn'); B(4500, 'повтор: новый снимок, v2 «Аня» — занято'); B(5100, '«мест нет»', 'ok');
            vers.push({ t: 2200, who: 'Аня', tx: 101 });
            res = ['ok', `Бронь у Ани. Строку изменили после снимка Бориса — его запись получила ошибку, транзакция откатилась и повторилась.${I === 'ser' ? ' Serializable поймал бы и конфликт между разными строками (write skew).' : ''}`];
          }
          return { ev, vers, waits, res, end: Math.max(...ev.map(e => e.t)) };
        },
        tick() {
          if (!V.sc) return;
          const now = V.t - V.T0;
          V.sc.ev.forEach((e, n) => { if (e.t <= now && !(V.seen & (1 << n))) { V.seen |= 1 << n; if (e.c === 'bad') vev(e.txt.includes('serialize') || e.txt.includes('0 строк') ? 'abort' : 'lost'); if (e.txt.startsWith('повтор')) vev('retry'); if (e.c === 'warn' && e.txt.includes('жду')) vev('waitlock'); V.msg = `<b>${e.l === 'A' ? 'Аня (A)' : 'Борис (B)'}:</b> ${esc(e.txt)}`; } });
        },
        base() {
          const key = ['lock', C.iso, C.lock, V.cyc].join('|');
          let s = head('Блокировки и изоляция: две транзакции за одно место', `Сейчас: ${ISO[C.iso]} · ${LOCK[C.lock]}. Поменяй справа — сценарий перестроится.`);
          s += tx(24, 82, 'Строка «место 7A» — её версии (MVCC: UPDATE не стирает строку, а добавляет новую версию)', 'xr-t');
          ['A', 'B'].forEach(l => { const y = LANE_Y[l]; s += ln([170, y], [960, y], 'xs-lane2') + tx(24, y + 4, l === 'A' ? 'A · Аня' : 'B · Борис', 'xr-t') + tx(24, y + 21, l === 'A' ? 'транзакция 101' : 'транзакция 102', 'xr-s'); });
          s += ln([170, 432], [960, 432], 'xr-wire') + tx(960, 446, 'время →', 'xr-s', 'end');
          if (V.sc) V.sc.ev.forEach(e => { s += `<circle class="xs-evd" cx="${r1(LX(e.t))}" cy="${LANE_Y[e.l]}" r="4"/>`; });
          s += rc(24, 452, 580, 92, 'xr-box', 10) + tx(38, 472, 'Итог', 'xr-t');
          s += rc(620, 452, 356, 92, 'xr-box', 10) + tx(634, 472, `${ISO[C.iso]} защищает от:`, 'xr-t');
          const pr = SD.ISOLATION[C.iso].prevents;
          Object.entries(SD.ANOMALIES).forEach(([k, a], n) => { const ok = pr.includes(k) || (C.lock !== 'none' && k === 'lost'); s += tx(634 + (n % 2) * 172, 492 + Math.floor(n / 2) * 17, `${ok ? '✓' : '✗'} ${a.name.toLowerCase()}`, ok ? 'xs-an ok' : 'xs-an bad'); });
          return [key, s];
        },
        live() {
          if (!V.sc) return '';
          let s = '';
          const now = V.t - V.T0, sc = V.sc;
          sc.vers.forEach((v, n) => {
            const x = 24 + n * 250, on = v.t <= now, last = on && !sc.vers.slice(n + 1).some(w => w.t <= now);
            s += rc(x, 92, 236, 48, 'xs-ver' + (!on ? ' e' : last ? ' cur' : ' old'), 8) + tx(x + 12, 112, on ? `v${n + 1} · ${v.who}` : `v${n + 1} · ещё нет`, on ? 'xr-t' : 'xr-s') + tx(x + 12, 130, on ? `создала tx ${v.tx} · ${last ? 'актуальная' : 'старая версия'}` : '', 'xr-s');
            if (n && on) s += tx(x - 7, 120, '→', 'xr-m', 'middle');
          });
          sc.waits.forEach(([a, b]) => { if (now > a) s += rc(LX(a), LANE_Y.B - 5, LX(Math.min(now, b)) - LX(a), 10, 'xs-wait', 3) + tx(LX(a) + 6, LANE_Y.B + 22, 'ждёт замок 🔒', 'xr-m bad'); });
          const per = { A: 0, B: 0 };
          sc.ev.forEach(e => {
            const k = per[e.l]++, up = k % 2 === 0, y = LANE_Y[e.l], x = LX(e.t);
            if (e.t > now) return;
            const lines = wrap(e.txt, 24), a = Math.min(1, (now - e.t) / 300);
            s += `<circle class="xs-evc ${e.c}" cx="${r1(x)}" cy="${y}" r="7"/>`;
            lines.forEach((t, j) => { s += `<text class="xs-evt ${e.c}" x="${r1(x)}" y="${up ? y - 14 - (lines.length - 1 - j) * 13 : y + 24 + j * 13}" text-anchor="middle" style="opacity:${r1(a)}">${esc(t)}</text>`; });
          });
          if (now <= sc.end + 400) s += ln([LX(Math.min(now, 5600)), 176], [LX(Math.min(now, 5600)), 430], 'xs-cursor');
          if (now > sc.end) wrap(sc.res[1], 86).forEach((t, j) => { s += tx(38, 494 + j * 16, esc(t), j ? 'xr-s' : 'xr-s ' + (sc.res[0] === 'bad' ? 'xs-badt' : 'xs-okt')); });
          else s += tx(38, 494, 'Смотри, как двигается линия времени…', 'xr-s');
          return s;
        },
        now() { return (V.msg || 'Две транзакции начинают почти одновременно…') + ` <br>${C.lock === 'pessimistic' ? 'FOR UPDATE: второй ждёт, пока первый закончит.' : C.lock === 'optimistic' ? 'Проверка версии: опоздавший перечитывает.' : C.iso === 'rc' ? 'Read Committed без блокировок: второй затирает первого.' : 'Снимок: опоздавший получает ошибку и повторяет.'}`; },
        stats() { return [['Потерянные обновления', String(vcnt('lost') ? 1 : 0), vcnt('lost') ? 'bad' : 'ok', 'в последнем прогоне'], ['Откаты', String(vcnt('abort')), vcnt('abort') ? 'warn' : 'ok', 'за 10 с'], ['Ожидание замка', String(vcnt('waitlock')), vcnt('waitlock') ? 'warn' : 'ok', 'за 10 с'], ['Изоляция', { rc: 'RC', rr: 'RR', ser: 'SER' }[C.iso], '', `${ISO[C.iso]} · ${LOCK[C.lock]}`]]; }
      };

      /* ---------- Журнал WAL ---------- */
      const WL = { buf: k => [40 + k * 54, 118], file: k => [40 + k * 54, 304], mem: k => [520 + k * 74, 112], disk: k => [520 + k * 74, 300] };
      PV.wal = {
        sig: () => scn,
        init() {
          vevery(() => 1500 * (0.7 + Math.random() * 0.6), () => PV.wal.tx(), 400);
          vevery(7000, () => PV.wal.ckpt(), 5000);
          if (scn === 'fail') vevery(15000, () => PV.wal.crash(), 10000);
          const pg = SEATS.slice(0, 6).map(s2 => ({ seat: s2, mem: 'свободно', disk: 'свободно', d: false })), file = [];
          for (let k = 0; k < 5; k++) { const p2 = rnd(6), who = USERS[rnd(USERS.length)]; file.push({ n: S.lsn - 5 + k, p: p2, who, st: 'file' }); pg[p2].mem = pg[p2].disk = who; }
          return { ph: 'up', lsn: S.lsn, buf: [], file, ck: S.lsn - 1, pg, rp: -1 };
        },
        tx() {
          if (V.ph !== 'up') return;
          const p = rnd(6), who = USERS[rnd(USERS.length)], r = vitem({ kind: 'write' });
          vmv(r, [[40, 500], WL.buf(Math.min(7, V.buf.length))], 450, () => {
            if (V.ph !== 'up') { r.gone = true; return; }
            const rec = { n: V.lsn++, p, who, st: 'buf' }; V.buf.push(rec); r.rec = rec;
            V.pg[p].mem = who; V.pg[p].d = true; V.fl['m' + p] = V.t;
            V.msg = `Запись №${rec.n}: «место ${V.pg[p].seat} → ${who}». Страница в памяти изменилась (грязная), запись легла в буфер журнала. Клиенту ещё рано говорить «готово».`;
            vat(500, () => {
              if (V.ph !== 'up' || r.gone) return;
              V.fl.flush = V.t;
              V.buf.forEach(x => { x.st = 'file'; V.file.push(x); }); V.buf = []; if (V.file.length > 30) V.file.shift();
              vev('commit');
              V.msg = `COMMIT №${rec.n}: буфер журнала сброшен в файл на диске и подтверждён fsync. Теперь «готово» — даже если сервер сейчас упадёт, запись восстановится.`;
              r.resp = true; vmv(r, [vpos(r), [vpos(r)[0], 340], [40, 500]], 600, () => { r.gone = true; });
            });
          });
        },
        ckpt() {
          if (V.ph !== 'up') return;
          const d = V.pg.filter(p => p.d); if (!d.length) return;
          d.forEach(p => { p.disk = p.mem; p.d = false; V.fl['k' + V.pg.indexOf(p)] = V.t; });
          V.ck = V.file.length ? V.file[V.file.length - 1].n : V.ck; vev('ckpt');
          V.msg = `<b>Checkpoint:</b> изменённые страницы записаны в файл таблицы. Отметка: «всё до №${V.ck} уже в таблицах» — при падении журнал старше читать не нужно.`;
        },
        crash() {
          if (V.ph !== 'up') return;
          V.ph = 'down'; V.fl.crash = V.t; vev('crash');
          V.items.forEach(o => { o.gone = true; });
          const lostN = V.buf.length; V.buf = [];
          V.pg.forEach(p => { p.mem = null; p.d = false; });
          V.msg = `<b>Сервер упал.</b> Память пропала: страницы и ${lostN ? `${lostN} ${pl(lostN, 'запись', 'записи', 'записей')} в буфере журнала (их транзакции не получили «готово»)` : 'буфер журнала'}. На диске остались файл журнала и файлы таблиц.`;
          vat(1500, () => {
            V.ph = 'rec';
            const todo = V.file.filter(x => x.n > V.ck);
            V.msg = `<b>Перезапуск.</b> Читаю страницы с диска и проигрываю журнал после checkpoint №${V.ck}: ${todo.length} ${pl(todo.length, 'запись', 'записи', 'записей')}.`;
            V.pg.forEach(p => { p.mem = p.disk; });
            todo.forEach((x, n) => vat(500 * (n + 1), () => { V.rp = x.n; V.pg[x.p].mem = x.who; V.pg[x.p].d = true; V.fl['m' + x.p] = V.t; V.msg = `Проигрываю №${x.n}: место ${V.pg[x.p].seat} → ${x.who}.`; }));
            vat(500 * (todo.length + 1) + 300, () => { V.ph = 'up'; V.rp = -1; ctx.done('walrec'); V.msg = '<b>Восстановлено.</b> Все подтверждённые изменения на месте — их вернул журнал. Неподтверждённые пропали, но их клиенты и не слышали «готово».'; });
          });
        },
        base() {
          let s = head('Журнал WAL: сначала записать, что собираешься сделать', 'Write-Ahead Log. Коммит = запись журнала надёжно на диске. Файлы таблиц можно обновить потом — по журналу всё восстановится.');
          s += rc(24, 62, 952, 172, 'xs-zone2 mem', 12) + tx(40, 82, 'ПАМЯТЬ — пропадёт при падении', 'xr-m warn');
          s += tx(40, 106, 'Буфер журнала (wal_buffers)', 'xr-t') + tx(520, 100, 'Страницы таблицы в памяти', 'xr-t');
          s += rc(24, 246, 952, 172, 'xs-zone2 disk', 12) + tx(40, 266, 'ДИСК — переживёт падение', 'xr-m ok');
          s += tx(40, 292, 'Файл журнала pg_wal: только дописываем', 'xr-t') + tx(520, 288, 'Файл таблицы на диске', 'xr-t');
          s += rc(24, 470, 140, 60, 'xr-box', 10) + tx(94, 497, 'Сервис', 'xr-t', 'middle') + tx(94, 514, 'шлёт UPDATE', 'xr-s', 'middle');
          s += kbtn(806, 470, 170, 'crash', '💥 Уронить сервер');
          return ['wal', s];
        },
        live() {
          let s = '';
          const ca = vfl('crash', 1200);
          for (let k = 0; k < 8; k++) { const [x, y] = WL.buf(k), r = V.buf[k]; s += rc(x, y, 50, 46, 'xs-tape ' + (r ? 'wal' : 'e'), 4) + (r ? tx(x + 25, y + 20, `№${r.n}`, 'xs-tn', 'middle') + tx(x + 25, y + 35, r.p != null ? V.pg[r.p].seat : '', 'xs-to', 'middle') : ''); }
          const vis = V.file.slice(-8);
          for (let k = 0; k < 8; k++) {
            const [x, y] = WL.file(k), r = vis[k];
            s += rc(x, y, 50, 46, 'xs-tape ' + (!r ? 'e' : r.n === V.rp ? 'rp' : V.t - (V.fl.flush || -1e9) < 500 && k >= vis.length - 2 ? 'new' : ''), 4);
            if (r) s += tx(x + 25, y + 20, `№${r.n}`, 'xs-tn', 'middle') + tx(x + 25, y + 35, `${V.pg[r.p].seat}: ${cut(r.who, 5)}`, 'xs-to', 'middle');
            if (r && r.n === V.ck) s += tx(x + 25, y + 62, '▲ checkpoint', 'xs-mkt', 'middle');
          }
          if (vis.length && vis[0].n > V.ck) s += tx(40, 380, `← checkpoint №${V.ck} левее`, 'xr-m acc');
          V.pg.forEach((p, k) => {
            const [x, y] = WL.mem(k), [dx, dy] = WL.disk(k);
            s += rc(x, y, 68, 96, 'xs-page' + (p.d ? ' d' : '') + (p.mem == null ? ' e' : ''), 6) + tx(x + 34, y + 20, `стр. ${p.seat}`, 'xs-to', 'middle') + tx(x + 34, y + 54, p.mem == null ? '—' : cut(p.mem, 8), 'xs-pv', 'middle') + (p.d ? tx(x + 34, y + 84, 'изменена', 'xs-to', 'middle') : '');
            s += rc(dx, dy, 68, 96, 'xs-page', 6) + tx(dx + 34, dy + 20, `стр. ${p.seat}`, 'xs-to', 'middle') + tx(dx + 34, dy + 54, cut(p.disk, 8), 'xs-pv', 'middle');
            const m = vfl('m' + k, 700), kk = vfl('k' + k, 900);
            if (m) s += rc(x, y, 68, 96, 'xs-fl load', 6, `opacity:${r1(m * 0.6)}`);
            if (kk) s += rc(dx, dy, 68, 96, 'xs-fl hit', 6, `opacity:${r1(kk * 0.6)}`) + ln([x + 34, y + 96], [dx + 34, dy], 'xs-ckl');
          });
          if (V.t - (V.fl.flush || -1e9) < 600) s += tx(255, 244, '↓ fsync: журнал на диск', 'xr-m acc', 'middle');
          if (ca) s += rc(24, 62, 952, 172, 'xs-fl ev', 12, `opacity:${r1(ca * 0.5)}`);
          if (V.ph !== 'up') s += tx(500, 160, V.ph === 'down' ? '✕ СЕРВЕР УПАЛ — ПАМЯТЬ ПУСТА' : '↻ ВОССТАНОВЛЕНИЕ ПО ЖУРНАЛУ', 'xs-big' + (V.ph === 'rec' ? ' ok' : ''));
          s += tx(186, 490, V.ph === 'up' ? 'UPDATE → запись в буфер журнала и в страницу' : V.ph === 'down' ? 'база недоступна' : 'проигрываю журнал…', 'xr-s');
          s += tx(186, 508, V.ph === 'up' ? 'COMMIT → fsync журнала → «готово» клиенту' : '', 'xr-s');
          s += tx(186, 526, 'Checkpoint → страницы в файл таблицы, отметка в журнале', 'xr-s');
          return s;
        },
        now() { return V.msg || 'Жду первую транзакцию…'; },
        stats() { return [['Номер журнала', '№' + (V.lsn - 1), '', 'LSN — позиция в журнале'], ['Коммитов', String(vcnt('commit')), '', 'за 10 с, каждый с fsync'], ['Не в таблицах', String(V.file.filter(x => x.n > V.ck).length), '', 'записей после checkpoint'], ['Падений', String(vcnt('crash')), vcnt('crash') ? 'warn' : '', 'за 10 с']]; }
      };

      /* ---------- Реплики ---------- */
      PV.repl = {
        sig: () => [C.R, C.mode, scn].join('|'),
        init() {
          const hypo = C.R === 0, n = hypo ? 1 : Math.min(3, C.R);
          vevery(() => 850 * (0.7 + Math.random() * 0.6), () => PV.repl.write(), 300);
          vevery(1700, () => PV.repl.read(), 1200);
          return { hypo, n, lsn: S.lsn, recs: [], chips: [], acks: [], reps: [...Array(n)].map(() => ({ recv: S.lsn - 1, appl: S.lsn - 1, ack: S.lsn - 1, apq: [], busy: false })) };
        },
        lag: () => Math.max(C.lag, 0),
        ry: i => { const h = V.n === 1 ? 220 : V.n === 2 ? 172 : 118; return { y: 66 + i * (h + 12), h }; },
        need: () => V.hypo ? 0 : C.mode === 'sync' ? V.n : C.mode === 'semisync' ? 1 : 0,
        write() {
          const n = V.lsn++, rec = { n, t: V.t, st: PV.repl.need() ? 'wait' : 'ok' }; V.recs.push(rec); if (V.recs.length > 12) V.recs.shift();
          vev('w');
          V.reps.forEach((rp, i) => {
            const c = { n, i, t0: V.t, t1: V.t + (380 + PV.repl.lag()) * (1 + 0.3 * i) }; V.chips.push(c);
            vat(c.t1 - V.t, () => {
              V.chips = V.chips.filter(x => x !== c); rp.recv = Math.max(rp.recv, n); rp.apq.push(n); PV.repl.apply(i);
              if (C.mode !== 'async' && !V.hypo) { const a = { n, i, t0: V.t, t1: V.t + 260 }; V.acks.push(a); vat(260, () => { V.acks = V.acks.filter(x => x !== a); rp.ack = Math.max(rp.ack, n); PV.repl.check(); }); }
            });
          });
          V.msg = PV.repl.need() ? `Запись №${n} в журнале primary. Коммит ждёт подтверждения ${C.mode === 'sync' ? 'всех реплик' : 'одной реплики'}.` : `Запись №${n}: primary сразу ответил «готово», журнал поехал к репликам${V.hypo ? '' : ' — они догонят'}.`;
        },
        check() { V.recs.forEach(r2 => { if (r2.st === 'wait' && V.reps.filter(x => x.ack >= r2.n).length >= PV.repl.need()) { r2.st = 'ok'; vev('cw'); if (C.mode === 'sync') ctx.done('sync'); } }); },
        apply(i) {
          const rp = V.reps[i]; if (rp.busy || !rp.apq.length) return;
          rp.busy = true; const n = rp.apq.shift();
          vat(260 * C.fR, () => { rp.appl = Math.max(rp.appl, n); rp.busy = false; V.fl['a' + i] = V.t; PV.repl.apply(i); });
        },
        read() {
          const i = rnd(V.n), b = PV.repl.ry(i), r = vitem({ kind: 'read' });
          vmv(r, [[980, b.y + b.h - 20], [940, b.y + b.h - 20]], 300, () => { const rp = V.reps[i], beh = V.lsn - 1 - rp.appl; rp.rd = { t: V.t, appl: rp.appl, beh }; V.msg = `Чтение с реплики ${i + 1}: видит данные до №${rp.appl}${beh ? ` — на ${beh} ${pl(beh, 'запись', 'записи', 'записей')} отстаёт от primary` : ', самые свежие'}.`; if (beh) vev('stale'); r.resp = true; r.err = beh > 0; vat(500, () => vmv(r, [vpos(r), [980, b.y + b.h - 20]], 300, () => { r.gone = true; })); });
        },
        base() {
          const key = ['repl', V.n, V.hypo, C.mode].join('|');
          let s = head('Реплики: копия получает журнал и проигрывает его у себя', V.hypo ? 'Реплик сейчас нет — ниже показано, как было бы с одной. Добавь реплики в настройках справа.' : `Режим: ${{ async: 'асинхронный', semisync: 'полусинхронный', sync: 'синхронный' }[C.mode]}. Реплик: ${C.R}${C.R > 3 ? ' (показаны 3)' : ''}.`);
          s += rc(24, 66, 270, 380, 'xr-box', 12) + tx(38, 88, 'Primary', 'xr-t') + tx(38, 105, 'журнал: последние записи', 'xr-s');
          for (let i = 0; i < V.n; i++) {
            const b = PV.repl.ry(i);
            s += ln([294, b.y + b.h / 2], [560, b.y + b.h / 2], 'xs-bus');
            s += rc(560, b.y, 416, b.h, 'xr-box' + (V.hypo ? ' xs-hypo' : ''), 12) + tx(574, b.y + 20, `Реплика ${i + 1}${V.hypo ? ' — так было бы' : ''}`, 'xr-t');
          }
          s += tx(300, 60, 'walsender → сеть → walreceiver', 'xr-s');
          const modes = [['async', 'асинхронно', 'коммит не ждёт реплик: быстро, при падении primary хвост журнала теряется'], ['semisync', 'полусинхронно', 'коммит ждёт одну реплику: запись есть минимум в двух местах'], ['sync', 'синхронно', 'коммит ждёт все реплики: ничего не теряется, но каждая запись ждёт самую медленную']];
          modes.forEach(([k, t, d], n) => { const on = k === C.mode; s += tx(24, 478 + n * 22, `${on ? '▶' : '·'} ${t}`, on ? 'xr-m acc' : 'xr-m') + tx(150, 478 + n * 22, d, on ? 'xr-s xs-cur' : 'xr-s'); });
          return [key, s];
        },
        live() {
          let s = '';
          V.recs.slice(-10).forEach((r2, k) => { const y = 120 + k * 31; s += rc(38, y, 242, 26, 'xs-tape ' + (r2.st === 'wait' ? 'wal' : ''), 4) + tx(48, y + 17, `№${r2.n}`, 'xs-tn') + tx(270, y + 17, r2.st === 'wait' ? `ждёт ${V.reps.filter(x => x.ack >= r2.n).length}/${PV.repl.need()} подтв.` : '«готово» клиенту', r2.st === 'wait' ? 'xr-m warn' : 'xr-m ok', 'end'); });
          V.reps.forEach((rp, i) => {
            const b = PV.repl.ry(i), behR = V.lsn - 1 - rp.recv, behA = V.lsn - 1 - rp.appl;
            s += tx(574, b.y + 40, `получено (walreceiver) до №${rp.recv}`, 'xr-s') + tx(574, b.y + 57, `применено (startup) до №${rp.appl}${rp.apq.length ? ` · в очереди ${rp.apq.length}` : ''}`, 'xr-s');
            s += tx(962, b.y + 20, behA ? `отстаёт на ${behA}` : 'не отстаёт', behA > 2 ? 'xr-m warn' : 'xr-m ok', 'end');
            if (b.h >= 118) for (let k = 0; k < 10; k++) { const n = V.lsn - 10 + k, x = 574 + k * 37; s += rc(x, b.y + 68, 33, 24, 'xs-rr' + (n <= rp.appl ? ' ap' : n <= rp.recv ? ' rv' : ''), 3) + tx(x + 16.5, b.y + 84, String(n % 1000).padStart(3, '0'), 'xs-to', 'middle'); }
            if (rp.rd && V.t - rp.rd.t < 1800) s += tx(574, b.y + b.h - 15, `читатель видит данные до №${rp.rd.appl}${rp.rd.beh ? ` — отстаёт на ${rp.rd.beh}` : ' — свежие'}`, rp.rd.beh ? 'xr-m warn' : 'xr-m ok');
            const a = vfl('a' + i, 300); if (a) s += rc(560, b.y, 416, b.h, 'xr-hl', 12, `opacity:${r1(a * 0.6)}`);
          });
          V.chips.forEach(c => { const b = PV.repl.ry(c.i), p = lerp([294, b.y + b.h / 2], [560, b.y + b.h / 2], (V.t - c.t0) / (c.t1 - c.t0)); s += rc(p[0] - 15, p[1] - 7, 30, 14, 'xs-chip', 3) + tx(p[0], p[1] + 4, String(c.n % 1000).padStart(3, '0'), 'xs-chipt', 'middle'); });
          V.acks.forEach(a => { const b = PV.repl.ry(a.i), p = lerp([560, b.y + b.h / 2 + 12], [294, b.y + b.h / 2 + 12], (V.t - a.t0) / (a.t1 - a.t0)); s += `<circle class="xs-ack" cx="${r1(p[0])}" cy="${r1(p[1])}" r="4"/>`; });
          return s;
        },
        now() { return `${V.msg || ''} <br>Квадратики у реплики: голубая рамка — запись получена, зелёная заливка — уже применена. Читатель реплики видит только применённое.`; },
        stats() { const beh = V.reps.map(rp => V.lsn - 1 - rp.appl); return [['Отставание', `${Math.max(0, ...beh)} зап.`, Math.max(0, ...beh) > 2 ? 'warn' : 'ok', `≈ ${ms(PV.repl.lag() + 380)} на картинке`], ['Ждали подтверждения', String(vcnt('cw')), '', 'коммитов за 10 с'], ['Устаревшие чтения', String(vcnt('stale')), vcnt('stale') ? 'warn' : 'ok', 'за 10 с'], ['Записей', String(vcnt('w')), '', 'за 10 с']]; }
      };

      /* ---------- Шарды ---------- */
      const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'], REG = ['RU', 'KZ', 'BY', 'UZ', 'AM', 'GE', 'KG', 'AZ'];
      PV.shard = {
        sig: () => [C.Sh, C.key].join('|'),
        init() { const hypo = C.Sh === 1, N = hypo ? 4 : C.Sh; vevery(1150, () => PV.shard.req(), 300); return { hypo, N, show: Math.min(8, N), cnt: Array(N).fill(0), rt: null, qn: 0 }; },
        box(k) { const n = V.show, cols = n <= 4 ? 2 : 4, w = cols === 2 ? 274 : 134, h = 150; return { x: 410 + (k % cols) * (w + 8), y: 66 + Math.floor(k / cols) * (h + 10), w, h }; },
        desc(k) {
          if (C.key === 'range') { const m = Math.floor(10 * (k + 1) / V.N) - 1, m0 = Math.max(0, Math.floor(10 * k / V.N)); return k === V.N - 1 ? `${MONTHS[m0]}–сейчас 2026` : `${MONTHS[m0]}–${MONTHS[Math.max(m0, m)]} 2026`; }
          if (C.key === 'geo') return k === 0 ? 'RU (крупная страна)' : REG[k % REG.length];
          return `hash % ${V.N} = ${k}`;
        },
        req() {
          V.qn++;
          if (V.qn % 5 === 0) return PV.shard.scatter();
          const w = Math.random() < 0.4, r = vitem({ kind: w ? 'write' : 'read' });
          let sh, lines;
          if (C.key === 'range') { const d = w ? 'сегодня, 03.10' : `${1 + rnd(28)}.${String(1 + rnd(10)).padStart(2, '0')}`; sh = w ? V.N - 1 : rnd(V.N); lines = [`${w ? 'INSERT заказ' : 'SELECT заказ'}: created_at = ${d}`, w ? 'новая запись — всегда последний диапазон' : 'ищу диапазон дат', `→ шард ${sh + 1}`]; }
          else if (C.key === 'geo') { sh = Math.random() < 0.45 ? 0 : 1 + rnd(V.N - 1); lines = [`${w ? 'INSERT' : 'SELECT'}: регион = ${sh === 0 ? 'RU' : REG[sh % REG.length]}`, 'регион → свой шард', `→ шард ${sh + 1}`]; }
          else { const u = 1 + rnd(999999), h = (u * 2654435761) >>> 0; sh = h % V.N; lines = [`${w ? 'UPDATE' : 'SELECT'}: user_id = ${u}`, `hash(${u}) = ${h.toLocaleString('ru-RU')}`, `${h.toLocaleString('ru-RU')} % ${V.N} = ${sh} → шард ${sh + 1}`]; }
          V.rt = { lines, t0: V.t, sh };
          V.msg = `Роутер: ${lines.join(' · ')}.`;
          vmv(r, [[-10, 130], [200, 130]], 300, () => vat(900, () => { const b = PV.shard.box(Math.min(sh, V.show - 1)); vmv(r, [vpos(r), [380, 300], [b.x + b.w / 2, b.y + b.h / 2]], 600, () => { V.cnt[sh]++; V.fl['s' + sh] = V.t; vev('one'); r.gone = true; }); }));
        },
        scatter() {
          V.rt = { lines: ['SELECT count(*) за день — без user_id', 'ключа нет: не знаю, где лежат строки', `→ спрашиваю все ${V.N} шардов и склеиваю`], t0: V.t, sh: -1 };
          V.msg = 'Запрос без ключа шардирования: роутер не знает, где данные, и рассылает его во все шарды. Ответы склеиваются — медленно и дорого.';
          vev('all');
          for (let k = 0; k < V.show; k++) { const r = vitem({ kind: 'job' }), b = PV.shard.box(k); vmv(r, [[200, 130], [380, 300], [b.x + b.w / 2, b.y + b.h / 2], [380, 300], [200, 470]], 2200, () => { r.gone = true; }); vat(1100, () => { V.fl['s' + k] = V.t; }); }
        },
        base() {
          const key = ['shard', V.N, V.show, C.key].join('|');
          let s = head('Шарды: данные разложены по разным серверам по ключу', V.hypo ? 'Сейчас шард один — ниже показано, как было бы при 4. Поменяй «Шарды» в настройках.' : `Ключ: ${{ hash: 'hash(user_id) — поровну', range: 'created_at — по диапазонам дат', geo: 'регион — по странам' }[C.key]}.`);
          s += rc(24, 66, 370, 380, 'xr-box', 12) + tx(38, 88, 'Роутер', 'xr-t') + tx(38, 105, 'по ключу запроса решает, в какой шард идти', 'xr-s');
          const sh = shShareN(V.N), mx = Math.max(...sh);
          for (let k = 0; k < V.show; k++) {
            const b = PV.shard.box(k), hot = C.key !== 'hash' && sh[k] === mx && !V.hypo;
            s += rc(b.x, b.y, b.w, b.h, 'xr-box' + (hot ? ' bad' : '') + (V.hypo ? ' xs-hypo' : ''), 10) + tx(b.x + 12, b.y + 20, `Шард ${k + 1}${hot ? ' · горячий' : ''}`, 'xr-t') + tx(b.x + 12, b.y + 37, esc(PV.shard.desc(k)), 'xr-s');
            s += rc(b.x + 12, b.y + 50, b.w - 24, 6, 'xr-bar', 3) + rc(b.x + 12, b.y + 50, (b.w - 24) * sh[k] / mx, 6, 'xr-bar-f' + (hot ? ' bad' : ''), 3) + tx(b.x + 12, b.y + 74, `доля нагрузки ${Math.round(sh[k] * 100)} %`, 'xr-s');
            s += tx(b.x + 12, b.y + 136, `свой primary${C.R ? ` + ${C.R} ${pl(C.R, 'реплика', 'реплики', 'реплик')}` : ''}`, 'xs-sm');
          }
          if (V.N > V.show) s += tx(410, 414, `и ещё ${V.N - V.show} ${pl(V.N - V.show, 'шард', 'шарда', 'шардов')}`, 'xr-s');
          s += tx(24, 476, 'Запрос с ключом идёт в один шард — быстро. Запрос без ключа (каждый 5-й здесь, жёлтые точки) идёт во все шарды.', 'xr-s');
          s += tx(24, 494, 'Неудачный ключ даёт горячий шард: по датам все новые записи летят в последний.', 'xr-s');
          s += tx(24, 512, 'JOIN и транзакции между шардами сложны — данные одного пользователя держат в одном шарде.', 'xr-s');
          return [key, s];
        },
        live() {
          let s = '';
          if (V.rt) { const f = (V.t - V.rt.t0) / 300; V.rt.lines.forEach((t, j) => { if (f > j) s += tx(38, 160 + j * 30, esc(t), j === 2 ? 'xs-rtl on' : 'xs-rtl'); }); }
          for (let k = 0; k < V.show; k++) { const b = PV.shard.box(k), a = vfl('s' + k, 500); s += tx(b.x + 12, b.y + 96, `запросов: ${V.cnt[k]}`, 'xr-m'); if (a) s += rc(b.x, b.y, b.w, b.h, 'xr-hl', 10, `opacity:${r1(a)}`); }
          return s;
        },
        now() { return `${V.msg || ''}${C.key === 'range' && !V.hypo ? ' <br><b>Горячий шард:</b> все новые записи идут в последний — он перегружен, остальные отдыхают.' : ''}`; },
        stats() { const tot = V.cnt.reduce((a, b) => a + b, 0) || 1, mx = Math.max(...V.cnt); return [['Шардов', String(V.N), '', V.hypo ? 'для примера' : 'по ключу ' + C.key], ['Самый загруженный', `${Math.round(mx / tot * 100)} %`, mx / tot > 1.6 / V.N ? 'bad' : 'ok', 'доля запросов'], ['В один шард', String(vcnt('one')), 'ok', 'за 10 с'], ['Во все шарды', String(vcnt('all')), vcnt('all') ? 'warn' : '', 'за 10 с, без ключа']]; }
      };
      function shShareN(n) {
        const a = Array(n).fill(1 / n);
        if (n > 1 && C.key === 'range') { const w = C.wsh; for (let k = 0; k < n; k++) a[k] = (1 - w) / n + (k === n - 1 ? w : 0); }
        if (n > 1 && C.key === 'geo') { a.fill(0.55 / (n - 1)); a[0] = 0.45; }
        return a;
      }

      /* кнопка индекса на картинке */
      function toggleIdx() {
        const I = (C.I || []).slice(), had = C.idx;
        const nx = had ? I.filter(k => !['btree', 'hash', 'clustered'].includes(k)) : I.concat(['btree']);
        ctx.setProp('idx', nx);
        ctx.log(had ? '<b>Ты убрал индекс.</b> Планировщик больше не знает, где лежит строка: каждое чтение — Seq Scan по всем страницам, соединение занято дольше.' : '<b>Индекс B-tree вернулся.</b> Чтение снова идёт по дереву прямо к нужной странице.', 'chg');
      }
      function svgAct(t) {
        if (t.closest('[data-xsidx]')) return toggleIdx(), true;
        const b = t.closest('[data-xsk]'); if (!b || !V) return false;
        if (b.dataset.xsk === 'nopool' && V.k === 'conn') { const np = !V.nopool; focusPart('conn', np); ctx.log(np ? '<b>Пул выключен.</b> Теперь каждый запрос открывает соединение заново: TCP, TLS, пароль, новый процесс.' : '<b>Пул снова включён.</b> Соединения открыты заранее, запрос просто берёт свободное.', 'chg'); }
        if (b.dataset.xsk === 'crash' && V.k === 'wal') PV.wal.crash();
        return true;
      }
      const onClick = e => { svgAct(e.target); };
      const onKey = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && svgAct(e.target)) e.preventDefault(); };
      svg.addEventListener('click', onClick); svg.addEventListener('keydown', onKey);

      cfg(); reset();

      return {
        tick(dt) {
          const k = ctx.part();
          if (k && PV[k]) { if (!V || V.k !== k) focusPart(k); vstep(dt); } else step(dt);
        },
        draw() {
          const k = ctx.part();
          if (k && PV[k]) { if (!V || V.k !== k) focusPart(k); drawPart(); return; }
          if (V) focusPart(null);
          drawBase(); drawLive(); drawDyn();
        },
        focus(k) { focusPart(k && PV[k] ? k : null); },
        refresh() {
          cfg();
          if (topoKey() !== topo) {
            topo = topoKey();
            if (scn === 'fail') { reset(); return; }
            syncReps();
            S.reqs.forEach(r => { if (r.ri != null && r.ri >= S.reps.length && !r.resp) { r.gone = true; } if (r.sh != null && r.sh >= C.Sh) r.gone = true; });
          }
          checkCW();
          if (V && PV[V.k].sig() !== V.sig) focusPart(V.k, V.k === 'conn' ? V.nopool : undefined);
        },
        scenario(id) { scn = id; cfg(); reset(); baseKey = ''; if (V) focusPart(V.k, V.k === 'conn' ? V.nopool : undefined); },
        onProp(k, prev, v) {
          if (k === 'size') return `Память сервера теперь ${RAM[v]} ГБ — смотри подпись буферного кэша${scn === 'spill' ? ' и долю попаданий' : '. В ситуации «Данные не влезают» это решает, сколько страниц едет с диска'}.`;
          if (k === 'replicas') return +v ? 'Справа реплики: чтения уходят туда, а журнал течёт к ним по фиолетовому проводу.' : 'Реплик нет: все чтения идут на primary, а его падение кладёт базу.';
          if (k === 'replMode') return v === 'sync' ? 'Смотри на коммит: запись стоит с кольцом, пока все реплики не подтвердят (зелёные точки обратно).' : v === 'semisync' ? 'Коммит ждёт подтверждения одной, самой быстрой реплики.' : 'Коммит больше не ждёт реплик: быстрее, но при падении хвост журнала может не доехать.';
          if (k === 'ryw') return v ? 'Чтения сразу после своей записи идут на primary — там всё свежее.' : 'Все чтения снова на репликах — свежую запись можно не увидеть.';
          if (k === 'shards') return +v > 1 ? 'Сверху полоска шардов: роутер раскладывает запросы по ключу, внутри показан один из них.' : 'Шард один: все данные на одном primary.';
          if (k === 'shardKey') return v === 'range' ? 'Все новые записи летят в последний шард — он подсвечен красным, внутри показан именно он.' : v === 'geo' ? 'Первый шард (крупная страна) получает почти половину запросов.' : 'Хэш раскладывает запросы поровну.';
          if (k === 'isolation' || k === 'locking') return scn === 'hot' ? 'Смотри на строку с местом: кто ждёт, кто откатывается, есть ли двойная бронь.' : 'Разница видна, когда строки спорят: открой «Толкучку за одну строку».';
          if (k === 'pooler') return v ? 'Слева PgBouncer: сотни клиентских соединений превращаются в пару десятков серверных.' : 'Каждый экземпляр сервиса снова держит свои 10 соединений прямо к базе.';
          return '';
        },
        now() {
          if (V) return PV[V.k].now();
          const nm = ISO[C.iso];
          if (scn === 'fail') {
            if (S.fl.ph === 'down') return `<b>Primary упал.</b> Всё, что было внутри, оборвалось. ${S.reps.length ? 'Оркестратор выбирает реплику, у которой журнал дальше всех.' : 'Реплик нет: база недоступна, все запросы получают ошибку.'}`;
            if (S.fl.ph === 'rec') return '<b>Перезапуск.</b> База читает журнал WAL и заново применяет подтверждённые записи — поэтому после падения они не теряются. Но пока идёт восстановление, база недоступна.';
            if (S.fl.ph === 'prom') return `<b>Реплика ${S.np + 1} стала primary.</b> Записи идут к ней. ${C.mode === 'async' ? 'Красные ячейки журнала — записи, которые primary подтвердил клиентам, но не успел отправить. Их больше нет.' : 'Коммит ждал реплику, поэтому всё подтверждённое у неё есть — потерь нет.'}`;
            return S.reps.length ? `<b>Сейчас всё работает.</b> Следи за метками Р1, Р2 под журналом: это докуда дошли реплики. ${C.mode === 'async' ? 'Асинхронно они отстают — всё правее метки пропадёт, если primary упадёт сейчас.' : 'Коммит ждёт реплику, поэтому подтверждённое не обгоняет метку.'}` : '<b>Реплик нет.</b> Когда primary упадёт, база будет недоступна, пока он не перезапустится и не восстановит данные по журналу.';
          }
          if (scn === 'hot') {
            if (C.lock === 'pessimistic') return '<b>SELECT … FOR UPDATE.</b> Первая транзакция запирает строку 🔒, остальные стоят в очереди с красным кольцом. Потом они читают уже «занято». Ни откатов, ни двойной брони — но все ждут.';
            if (C.lock === 'optimistic') return '<b>Оптимистичная блокировка.</b> В строке номер версии (v). Запись проходит, только если версия не изменилась с момента чтения. Опоздавший получает «0 строк обновлено», откатывается (↺) и перечитывает.';
            if (C.iso === 'rc') return `<b>${nm} без блокировок.</b> Все трое прочитали «свободно», подумали и записали. Каждая следующая запись затирает предыдущую: «забронировано» услышали все, а место одно — <b>двойная бронь</b>. Поставь Serializable или блокировку в коде.`;
            return `<b>${nm}.</b> Первая запись побеждает. Остальные при записи получают «could not serialize» — откат и повтор (↺), а при повторе видят «занято». Двойной брони нет, цена — откаты.${C.iso === 'rr' ? ' Serializable ловит ещё и write skew — когда спорят разные строки.' : ''}`;
          }
          if (scn === 'spill') return C.pages <= FR ? `<b>Теперь всё влезает.</b> ${C.ram} ГБ памяти хватает на ${C.need} ГБ данных с индексами: страницы читаются из памяти, на диск почти не ездим.` : `<b>Данные (${C.need} ГБ) не влезают в память (${C.ram} ГБ).</b> В кэше помещается только часть страниц: остальные везут с диска (точки ныряют вниз), а чтобы освободить место, вытесняют давно не нужные. Помогает сервер с большей памятью, меньше лишних индексов или кэш перед базой.`;
          if (scn === 'ryw') {
            if (!C.R) return '<b>Реплик нет.</b> И запись, и чтение идут на primary — пользователь всегда видит свой заказ. Добавь реплики, чтобы увидеть проблему.';
            if (C.ryw) return '<b>Свои записи читаем с primary.</b> Несколько секунд после записи чтения этого пользователя идут на главный сервер — заказ на месте. Остальные чтения по-прежнему на репликах.';
            if (C.mode === 'sync') return '<b>Синхронная реплика.</b> Коммит ждёт все реплики, поэтому к моменту ответа «готово» заказ уже на них. Свежо — но каждая запись ждёт самую медленную реплику.';
            return `<b>${C.mode === 'semisync' ? 'Полусинхронно: коммит ждёт одну реплику.' : 'Асинхронная реплика отстаёт.'}</b> Пользователь оформил заказ и сразу открыл «Мои заказы». Чтение ушло на реплику, а запись журнала с заказом ещё едет по проводу — заказа не видно (красная вспышка). Включи «Читать свои записи с primary».`;
          }
          let t = '';
          if (C.rej > 0) t = `<b>Соединения кончились.</b> ${C.cs[0] ? C.cs[0].cnt + ' экз. × пул 10' : 'Клиенты'} — это ${C.conns} соединений, а PostgreSQL держит ≈ ${C.lim}: каждое соединение — отдельный процесс со своей памятью. Лишние получают «too many clients» (крестик у входа). Включи PgBouncer: он сжимает сотни клиентских соединений в пару десятков серверных.`;
          else if (C.pooler && scn === 'conns') t = `<b>PgBouncer держит удар.</b> Он принимает ${C.conns} клиентских соединений, а в базу открывает ${C.srv}: запрос берёт серверное соединение только на время работы и сразу отдаёт.`;
          else if (!C.idx) t = '<b>Индекса нет.</b> Планировщик не знает, где строка, и перебирает таблицу целиком (Seq Scan): точка пробегает каждую страницу и долго держит соединение. Окошки забиваются, растёт очередь. Верни индекс кнопкой под планировщиком.';
          else if (C.uW > 1) t = `<b>Primary перегружен (${pc(C.uW)}).</b> Работы приходит больше, чем он успевает: всё медленнее, окошки заняты, копится очередь.`;
          else if (C.Sh > 1 && C.key !== 'hash') t = `<b>Горячий шард.</b> ${C.key === 'range' ? 'Ключ created_at отправляет все новые записи в последний шард' : 'Ключ «регион» отправляет почти половину запросов в шард крупной страны'} — он перегружен, остальные отдыхают. Поставь hash(user_id).`;
          else t = `<b>${scn === 'conns' ? 'Много клиентов.' : 'Как на схеме.'}</b> Чтение: окошко-соединение → планировщик идёт по индексу → страница в памяти (зелёная вспышка — нашлась). Запись: сначала строка в журнал WAL, потом коммит, потом страница в памяти.${C.R ? ' Чтения уходят на реплики справа, журнал течёт к ним по проводу.' : ''}${C.Sh > 1 ? ' Роутер раскладывает запросы по шардам: внутри показан один.' : ''}`;
          return t;
        },
        stats() {
          if (V) return PV[V.k].stats();
          const hits = cnt('hit'), miss = cnt('miss'), hr = hits + miss ? hits / (hits + miss) : 1, k = ctx.all && ctx.all.kinds;
          const out = [['Попадания в память', pc(hr), hr < 0.8 ? 'bad' : hr < 0.95 ? 'warn' : 'ok', `с диска: ${miss} за 10 с`]];
          const rej = cnt('rej') + cnt('full') + cnt('down');
          out.push(rej ? ['Отказы', String(rej), 'bad', 'за 10 с: нет соединения или primary'] : ['Ждали окошко', String(cnt('wait')), cnt('wait') ? 'warn' : 'ok', 'запросов за 10 с']);
          out.push(C.pooler ? ['Соединений в базу', `${C.srv} из ${C.lim}`, 'ok', `клиентов ${C.conns} → PgBouncer`] : ['Соединений', `${C.conns} из ${C.lim}`, C.rej ? 'bad' : C.conns > C.lim * 0.75 ? 'warn' : '', C.rej ? 'лишним — отказ' : 'открыто сейчас']);
          if (scn === 'hot') {
            out.push(['Двойные брони', String(cnt('dbl')), cnt('dbl') ? 'bad' : 'ok', 'за 10 с']);
            const ab = cnt('abort'); out.push(['Откаты и повторы', String(ab), ab ? 'warn' : 'ok', C.iso === 'rc' && C.lock === 'none' ? 'RC не откатывает — затирает' : `на площадке в толкучке ≈ ${pc(C.hotAbort)} записей`]);
          } else if (scn === 'fail') out.push(['Потеряно записей', String(S.lostTot), S.lostTot ? 'bad' : 'ok', 'подтверждённых, за всё время']);
          else if (scn === 'ryw') { const st = cnt('stale'), fr = cnt('fresh'); out.push(['Не увидел свой заказ', String(st), st ? 'bad' : 'ok', `из ${st + fr} за 10 с`]); }
          else if (scn === 'spill' || (!C.R && C.idx)) out.push(['Вытеснено страниц', String(cnt('evict')), cnt('evict') ? 'warn' : 'ok', 'из памяти за 10 с, чтобы освободить место']);
          else if (C.R && C.idx) out.push(['Лаг реплик', ms(C.lagReal), C.lagReal > 200 ? 'warn' : 'ok', `${C.mode === 'async' ? 'асинхронно' : C.mode === 'sync' ? 'синхронно' : 'полусинхронно'} · на площадке`]);
          else out.push(['Полных переборов', String(cnt('seq')), cnt('seq') ? 'warn' : 'ok', 'Seq Scan за 10 с']);
          out.push(['Журнал WAL', '№' + (S.lsn - 1), '', `${cnt('wal')} записей за 10 с${k && k.write ? ' · запись ' + ms(k.write.lat) : ''}`]);
          return out;
        },
        destroy() { svg.removeEventListener('click', onClick); svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
