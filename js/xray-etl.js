/* «Конвейер ETL/ELT изнутри»: граф задач как в Airflow (extract → load → transform → тесты → витрина), повторы,
   догрузка прошлых интервалов, свежесть и SLA; поток против батча; ETL против ELT; CDC из журнала базы и смена схемы. */
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
    return `<line class="xe-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xe-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const KW = /^(SELECT|FROM|WHERE|AND|OR|GROUP|BY|ORDER|AS|INSERT|INTO|OVERWRITE|PARTITION|TABLE|VALUES|ALTER|RENAME|COLUMN|TO|ADD|DROP|EXCHANGE|TABLES|DELETE|WITH|NOT|IN|IS|NULL|CASE|WHEN|THEN|END|select|from|where|and|as|group|by|if|endif|is_incremental|config|ref|source|def|with|for|import|return|true|false|True|False|INTERVAL|TUMBLE|DESCRIPTOR)$/;
  const hl = line => line.split(/('[^']*'|"[^"]*"|\{\{[^}]*\}\}|\s+|[(),=<>*;:{}[\]]+)/).filter(x => x !== '').map(tk => /^\{\{.*\}\}$/.test(tk) ? `<tspan class="xe-jj">${ES(tk)}</tspan>` : /^('.*'|".*")$/.test(tk) ? `<tspan class="xe-st">${ES(tk)}</tspan>` : KW.test(tk) ? `<tspan class="xe-kw">${tk}</tspan>` : /^\d[\d.:-]*$/.test(tk) ? `<tspan class="xe-nu">${tk}</tspan>` : tk.startsWith('--') || tk.startsWith('#') ? `<tspan class="xe-cm">${ES(tk)}</tspan>` : ES(tk)).join('');
  const CODE = (x, y, line, c) => {
    const i = line.indexOf('--') >= 0 ? line.indexOf('--') : line.indexOf(' #') >= 0 ? line.indexOf(' #') + 1 : -1;
    const body = i >= 0 ? hl(line.slice(0, i)) + `<tspan class="xe-cm">${ES(line.slice(i))}</tspan>` : line.trim().startsWith('#') ? `<tspan class="xe-cm">${ES(line)}</tspan>` : hl(line);
    return `<text class="xe-code${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${body}</text>`;
  };
  const MONO = (x, y, t, c, a) => `<text class="xe-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;

  /* ---------- задачи DAG: id, что делает, длительность (с), где работает ---------- */
  const TASKS = {
    elt: [['extract', 'из PostgreSQL', 300, 'conv'], ['load_raw', 'сырьё в DWH', 180, 'edge'], ['dbt_run', 'SQL: stg→fct', 720, 'dwh'], ['dbt_test', 'тесты', 180, 'dwh'], ['publish', 'подмена', 60, 'dwh']],
    etl: [['extract', 'из PostgreSQL', 300, 'conv'], ['transform', 'Spark: чистка', 900, 'conv'], ['load', 'итог в DWH', 240, 'edge'], ['checks', 'сверка', 120, 'dwh'], ['publish', 'подмена', 60, 'dwh']]
  };
  const ROWS_H = 48210;   // заказов за час
  const D0 = 13 * 86400;  // 14 июля 00:00 (секунды от 1 июля)
  const hm = w => { const s = ((w % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0'); };
  const dm = w => `${Math.floor(w / 86400) + 1} июля`;
  const dshort = w => `07-${String(Math.floor(w / 86400) + 1).padStart(2, '0')}`;
  const dur = s => s >= 86400 ? nf(s / 3600, 0) + ' ч' : s >= 3600 ? `${Math.floor(s / 3600)} ч ${String(Math.floor(s / 60) % 60).padStart(2, '0')} мин` : s >= 120 ? Math.round(s / 60) + ' мин' : nf(s, s < 10 ? 1 : 0) + ' с';

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const SRC1 = { x: 16, y: 52, w: 160, h: 118 }, SRC2 = { x: 16, y: 180, w: 160, h: 120 }, CLK = { x: 16, y: 310, w: 160, h: 242 };
  const DZ = { x: 188, y: 46, w: 540, h: 254 }, TGT = { x: 740, y: 46, w: 244, h: 118 }, FR = { x: 740, y: 174, w: 244, h: 126 };
  const GRID = { x: 188, y: 310, w: 404, h: 242 }, LOG = { x: 604, y: 310, w: 380, h: 242 };
  const BW = 92, BG = 14, BX0 = 200, BY = 96, BH = 64;
  const bx = i => BX0 + i * (BW + BG);

  SD.XRAY.etl = {
    viewBox: '0 0 1000 560',
    cta: 'Граф задач как в Airflow, повторы и догрузка, свежесть и SLA, поток против батча, ETL против ELT, CDC из журнала базы',
    dive: 'etl',
    simple: () => ({
      an: 'Как <b>служба доставки продуктов в ресторан по расписанию</b>: забрать на складе, привезти, помыть и нарезать, проверить, выставить на раздачу. Каждый шаг начинается, только когда закончился предыдущий. Машина сломалась — водитель ждёт и пробует снова, а шеф следит, чтобы к открытию всё было свежим.',
      pl: 'Конвейер забирает данные из боевых систем, переносит в хранилище и превращает в витрины для отчётов. Задачи идут цепочкой по расписанию, упавшую повторяют, пропущенные интервалы догружают, а за свежестью витрины следит SLA. Можно возить пачками раз в час или непрерывным потоком.'
    }),
    props: ['mode', 'approach'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Конвейер работает по расписанию из настройки «Режим»: раз в час, ночью или потоком.' },
      { id: 'fail', name: 'Задача упала', note: 'Источник не отвечает, а потом ломается модель. Повторы, upstream_failed, пропущенный SLA и перезапуск.' },
      { id: 'backfill', name: 'Догрузить прошлое', note: 'Логику выручки исправили — нужно пересчитать 8 прошлых интервалов, не задвоив строки.' },
      { id: 'cdc', name: 'CDC из базы', note: 'Источник — журнал PostgreSQL: сначала полный снимок таблицы, потом поток изменений через Debezium и Kafka.' },
      { id: 'schema', name: 'Сменили схему', note: 'Разработчики переименовали колонку в боевой базе. Что сломается в CDC и чем это опасно для самой базы?' }
    ],
    tries: [
      { id: 'retry', text: 'В «Задача упала» дождись, пока extract упадёт и пройдёт со второй попытки' },
      { id: 'sla', text: 'Там же дождись пропуска SLA и перезапуска упавшей модели' },
      { id: 'backfill', text: 'В «Догрузить прошлое» дождись, пока все 8 интервалов пересчитаются по два за раз' },
      { id: 'stream', text: 'Переключи режим на «Поток» и сравни свежесть: секунды вместо часа' },
      { id: 'elt', text: 'Переключи «Где преобразуем» и посмотри, как задача преобразования переехала через границу хранилища' },
      { id: 'cdc', text: 'В «CDC из базы» дождись конца полного снимка и первых изменений u и d' },
      { id: 'wal', text: 'В «Сменили схему» найди, где копится журнал WAL, пока коннектор стоит' },
      { id: 'ptests', text: 'Открой блок «Тесты данных» и посмотри, как упавший тест не пустил кривые данные в витрину' }
    ],
    parts: {
      dag: {
        name: 'Граф задач (DAG)', knobs: ['mode', 'approach'],
        an: 'Как <b>технологическая карта на кухне</b>: сначала помыть, потом нарезать, потом жарить. Повар не начнёт жарить, пока не нарезано, и каждое утро карту запускают заново.',
        pl: 'DAG — список задач и стрелок между ними: что после чего выполнять. Планировщик (Airflow) по расписанию создаёт запуск для интервала данных — например, «заказы с 11:00 до 12:00» — и выполняет задачи по порядку.',
        how: ['DAG описывают кодом на Python: задачи и стрелки extract >> load_raw >> dbt_run >> dbt_test >> publish.', 'Расписание @hourly: запуск за интервал 11:00–12:00 стартует в 12:00 — когда интервал закончился и данные за него есть.', 'Каждая задача получает границы интервала (data_interval_start/end) и берёт только свои строки.', 'Задача проходит состояния: scheduled → queued → running → success. Или up_for_retry, failed, upstream_failed.', 'Следующая задача стартует, только когда предыдущая успешна. Упала одна — дальше по цепочке ничего не запускается.', 'catchup=True: если DAG был выключен, планировщик сам создаст запуски за пропущенные интервалы.'],
        watch: 'Пять задач слева направо, стрелки — порядок. Цвет — состояние задачи сейчас. Фон делит картинку на «работу в конвейере» и «работу в хранилище». Строка под задачей — что она пишет и куда.',
        real: 'Apache Airflow (DAG на Python), Dagster, Prefect, Argo Workflows. Преобразования — dbt (SQL-модели с ref()), Spark. В Airflow 2.x интервал — data_interval_start/end, раньше — execution_date.'
      },
      retry: {
        name: 'Повторы', knobs: ['mode'],
        an: 'Как <b>звонок, когда занято</b>: перезваниваешь через пять минут, потом через десять. Но если ты каждый раз заново диктуешь заказ, повар не должен готовить его дважды.',
        pl: 'Задачи падают из-за временных сбоев: источник не ответил, сеть моргнула. Поэтому их повторяют с паузой. Но повтор безопасен только если задача идемпотентна: второй запуск перезаписывает свой кусок, а не дописывает его ещё раз.',
        how: ['retries = 3, retry_delay = 5 минут: упала — состояние up_for_retry, через 5 минут попытка 2.', 'Паузу часто увеличивают (exponential backoff): 5, 10, 20 минут — чтобы не добивать лежащий источник.', 'Все попытки неудачны — задача failed, дальше по цепочке upstream_failed, приходит алерт.', '<b>Идемпотентность</b>: задача пишет «свой интервал» целиком: INSERT OVERWRITE PARTITION (hr = 11) или DELETE + INSERT по интервалу.', 'Если задача просто дописывает (append), повтор после частичной записи задвоит строки — и выручка в отчёте вырастет на ровном месте.', 'Ошибки в логике (сломанный SQL) повтор не лечит — их видно по тому, что падают все попытки.'],
        watch: 'Шкала попыток: красная — упала, жёлтая — ждём паузу, зелёная — прошла. Ниже два способа записи при повторе: дописать (строк вдвое больше) или перезаписать свой интервал (строк столько, сколько надо).',
        real: 'Airflow: retries, retry_delay, retry_exponential_backoff, max_retry_delay; on_failure_callback шлёт алерт в Slack или PagerDuty. dbt incremental с unique_key и стратегией merge или delete+insert делает загрузку идемпотентной.'
      },
      backfill: {
        name: 'Догрузка прошлого', knobs: ['mode'],
        an: 'Как <b>перепечатать старые выпуски газеты</b> после найденной опечатки: каждый выпуск печатают заново целиком и кладут на место старого, а не рядом.',
        pl: 'Когда логику исправили или данные за какие-то часы не загрузились, прошлые интервалы пересчитывают заново. Каждый запуск отвечает за свой интервал и перезаписывает его — поэтому пересчёт можно делать сколько угодно раз.',
        how: ['Команда: airflow dags backfill orders_hourly -s 2026-07-14T02:00 -e 2026-07-14T10:00 --reset-dagruns.', 'Планировщик создаёт запуск на каждый интервал: 02:00, 03:00, … — каждый со своими data_interval_start/end.', 'max_active_runs = 2: одновременно идут два запуска, чтобы не задавить источник и хранилище.', 'Каждый запуск перезаписывает свою партицию: INSERT OVERWRITE … PARTITION (hr = \'03\'). Повтор не задвоит данные.', 'Обычное расписание при этом продолжает работать — новые интервалы встают в очередь.', 'Для потока «догрузка» — перемотать offset группы потребителей назад и переиграть сообщения (если Kafka ещё их хранит) или посчитать батчем по озеру.'],
        watch: 'Сетка запусков как в Airflow: столбец — интервал, строки — задачи. Догружаемые интервалы сначала серые, потом заполняются по два одновременно.',
        real: 'Airflow: catchup, backfill, max_active_runs, depends_on_past. Dagster и Prefect называют это так же — backfill по партициям. В dbt: dbt run --full-refresh или с переменными интервала.'
      },
      sla: {
        name: 'Свежесть и SLA', knobs: ['mode'],
        an: 'Как <b>дата на молоке</b>: важно не то, что магазин работает, а то, насколько свежий товар на полке прямо сейчас.',
        pl: 'Свежесть витрины — сколько времени прошло с последнего момента, по который в ней есть данные. SLA — обещание: «данные в отчёте не старше 2 часов». Если конвейер упал, свежесть растёт, и при нарушении обещания приходит алерт.',
        how: ['Свежесть = сейчас − max(updated_at) в витрине (или конец последнего загруженного интервала).', 'В батче свежесть — пила: падает после каждой загрузки и растёт до следующей. Раз в час — от ≈ 25 до ≈ 85 минут.', 'Ночной батч: утром данные «за вчера», к вечеру им уже почти двое суток.', 'Поток держит свежесть в секундах — пока не отстаёт потребитель (consumer lag).', 'SLA проверяют автоматически: dbt source freshness (warn_after, error_after) или датчик в Airflow.', 'Нарушение SLA — алерт дежурному и пометка «данные устарели» прямо на дашборде.'],
        watch: 'Большое число — свежесть витрины сейчас. Полоска — до черты SLA. График — как свежесть менялась: пила у батча, ровная линия у потока, горб при сбое.',
        real: 'dbt: freshness: {warn_after: {count: 90, period: minute}, error_after: {count: 2, period: hour}}. Airflow 2: SLA miss callback, в Airflow 3 — deadline-алерты. Для Kafka — мониторинг consumer lag (Burrow, Kafka Exporter).'
      },
      mode: {
        name: 'Поток или батч', knobs: ['mode'],
        an: 'Батч — как <b>мусоровоз раз в день</b>: дёшево, но всё копится. Поток — как <b>пневмопочта</b>: письмо долетает за секунды, но трубы надо держать под давлением круглые сутки.',
        pl: 'Батч забирает данные пачкой по расписанию: проще, дешевле и легко перезапустить, но отчёт отстаёт на интервал. Поток обрабатывает каждое событие сразу: свежесть в секундах, но кластер работает всегда, а логику сложнее менять и проверять.',
        how: ['<b>Батч</b>: каждые час или сутки берём интервал целиком, считаем и загружаем. Воркеры работают минуты, остальное время свободны.', '<b>Поток</b>: Flink или Kafka Streams читает события непрерывно, держит состояние (дедупликация, окна) и пишет результат сразу.', 'Поток делает чекпойнты: раз в N секунд сохраняет состояние и позиции чтения. Упал — продолжает с чекпойнта.', 'Опоздавшие события (пришли позже окна) — главная сложность потока: водяные знаки (watermark) и допуск опоздания.', 'Цена: батч ≈ $180 в месяц (воркеры минуты в час), поток ≈ $450 (кластер круглосуточно) — как в каталоге площадки.', 'Часто делают и то и другое: поток для свежих дашбордов, ночной батч — для точных итогов.'],
        watch: 'Слева батч: события копятся в корзине и раз в интервал уезжают пачкой. Справа поток: каждое событие проходит сразу. Внизу — свежесть и цена для каждого способа.',
        real: 'Батч: Airflow + dbt или Spark. Поток: Apache Flink, Kafka Streams, Spark Structured Streaming, ClickHouse Kafka engine. Задержка потока — 1–10 с, батча — интервал запуска плюс время работы.'
      },
      elt: {
        name: 'ETL или ELT', knobs: ['approach'],
        an: 'ETL — как <b>принести на кухню уже нарезанный салат</b>. ELT — <b>принести продукты целиком и резать на месте</b>: передумал рецепт — нарезал заново из тех же продуктов.',
        pl: 'ETL преобразует данные в конвейере (Spark, Python) и загружает в хранилище готовое. ELT сначала загружает сырьё как есть, а преобразует SQL-моделями внутри хранилища (dbt). Сырьё под рукой — значит, модель можно поменять и пересчитать.',
        how: ['<b>ETL</b>: extract → transform (в памяти Spark) → load. В хранилище — только итог.', '<b>ELT</b>: extract → load (сырьё в raw-схему) → transform SQL внутри ClickHouse, Snowflake или BigQuery.', 'ELT проще менять: логика — это SQL-файлы в git, их видят и аналитики. Ошибка — исправили модель и пересчитали из raw.', 'ETL разгружает хранилище и подходит, когда сырьё нельзя хранить: персональные данные маскируют до загрузки.', 'ELT нагружает хранилище преобразованиями (на площадке это +50 % нагрузки на аналитическую БД).', 'Сегодня чаще ELT: хранилища мощные, а dbt даёт тесты, документацию и граф зависимостей моделей.'],
        watch: 'Две дорожки с одинаковыми пятью строками заказов. В ETL чистка идёт до границы хранилища, в ELT — после неё. Ниже один и тот же расчёт: PySpark и dbt SQL.',
        real: 'ETL: Spark, Informatica, Talend, NiFi. ELT: Fivetran/Airbyte для загрузки + dbt внутри Snowflake, BigQuery, ClickHouse. На площадке ELT добавляет нагрузку хранилищу, ETL — нет.'
      },
      cdc: {
        name: 'CDC из журнала базы', knobs: ['mode'],
        an: 'Как <b>копия бортового журнала</b>: вместо того чтобы каждый час переписывать весь склад, читаешь журнал — «привезли», «продали», «списали» — и повторяешь у себя.',
        pl: 'CDC (change data capture) читает журнал изменений базы (WAL) и превращает каждую зафиксированную вставку, правку и удаление в сообщение. Debezium сначала делает полный снимок таблицы, потом шлёт поток изменений в Kafka, откуда их забирают в хранилище.',
        how: ['PostgreSQL пишет каждое изменение в журнал WAL с номером LSN.', 'Debezium подключается через слот логической репликации и читает журнал (плагин pgoutput).', 'Первый запуск — <b>снимок</b>: все 12 млн строк таблицы как сообщения op = r. Потом — только изменения: c (создано), u (изменено), d (удалено).', 'Каждое сообщение несёт before и after, номер LSN и время. Ключ — order_id, поэтому изменения одного заказа идут по порядку в одну партицию.', 'Загрузчик пишет изменения в хранилище: upsert по ключу (ReplacingMergeTree, MERGE) и пометка удаления.', 'Слот держит журнал на диске базы, пока коннектор не подтвердил чтение. Коннектор встал — WAL растёт и может заполнить диск боевой базы.'],
        watch: 'Слева направо: журнал базы → Debezium → топик Kafka → загрузчик. Точки — сообщения с операцией. Таблица снизу — последние сообщения в топике, справа — одно сообщение целиком, как его видит потребитель.',
        real: 'Debezium + Kafka Connect, AWS DMS, Fivetran. PostgreSQL: wal_level = logical, слот pg_replication_slots, его отставание — pg_wal_lsn_diff. Задержка доставки — 50–500 мс.'
      },
      tests: {
        name: 'Тесты данных', knobs: ['approach'],
        an: 'Как <b>ОТК на заводе</b>: партию проверяют до отгрузки. Брак — партия остаётся на складе, а в магазине пока лежит прошлая, проверенная.',
        pl: 'Перед публикацией витрины конвейер проверяет данные: ключи уникальны, обязательные поля заполнены, значения из допустимого списка, строк не меньше обычного. Упал тест — витрина не обновляется: лучше старая верная, чем свежая кривая.',
        how: ['<b>unique</b> и <b>not_null</b> на ключ: SELECT order_id FROM fct_orders GROUP BY 1 HAVING count(*) > 1 должен вернуть 0 строк.', '<b>accepted_values</b>: страна только из списка RU, KZ, BY, UZ, AM, GE.', '<b>relationships</b>: у каждого заказа покупатель есть в dim_user.', '<b>Объём</b>: строк за час не меньше 70 % от того же часа неделю назад.', 'Тест упал — задача publish не запускается (upstream_failed), старая витрина остаётся на месте, приходит алерт.', 'Публикация атомарная: новая таблица готовится рядом и подменяется одной командой (EXCHANGE TABLES).'],
        watch: 'Тесты выполняются по очереди. Один падает: видны строки, которые его сломали. Публикация витрины остаётся заблокированной, дашборд продолжает показывать прошлую проверенную версию.',
        real: 'dbt tests (generic и singular), dbt-expectations, Great Expectations, Soda. В ClickHouse подмена — EXCHANGE TABLES, в Snowflake — ALTER TABLE … SWAP WITH.'
      }
    },
    legend: [['ok', 'Задача успешна, ответ'], ['sq xe-swr', 'Задача выполняется'], ['sq xe-swy', 'Ждёт повтора (up_for_retry)'], ['sq xe-swf', 'Упала (failed)'], ['sq xe-swu', 'Не запускалась: упала предыдущая'], ['sq xe-swn', 'В очереди или очищена для догрузки'], ['write', 'Строки, сообщения CDC'], ['accent', 'Барьер чекпойнта в потоке']],
    live: (n, r, all) => {
      const l = r.load || {}, ev = l.events || 0;
      const out = [['Событий', SD.fmt.num(ev) + '/с', ''], ['Режим', { stream: 'поток', hourly: 'раз в час', daily: 'ночью' }[n.props.mode] || n.props.mode, ''], ['Преобразуем', n.props.approach === 'etl' ? 'ETL' : 'ELT', '']];
      const fr = all && all.data ? all.data.fresh : null;
      if (fr != null && isFinite(fr)) out.push(['Свежесть отчётов', fr < 120 ? Math.round(fr) + ' с' : fr < 7200 ? Math.round(fr / 60) + ' мин' : Math.round(fr / 3600) + ' ч', fr > 60 ? 'warn' : 'ok']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xeSt"></g><g id="xeDy" class="xe-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xeSt'), gDy = ctx.svg.querySelector('#xeDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const mode = () => P().mode || 'hourly';
      const elt = () => P().approach !== 'etl';
      const tasks = () => TASKS[elt() ? 'elt' : 'etl'];
      const isCdc = () => S.scn === 'cdc' || S.scn === 'schema';
      const isStream = () => mode() === 'stream' && !isCdc();
      const SLA = () => isCdc() || mode() === 'stream' ? 60 : mode() === 'daily' ? 30 * 3600 : 2 * 3600;
      const step = () => mode() === 'daily' ? 86400 : 3600;
      const runRate = () => mode() === 'daily' ? 600 : 360;
      const rate = () => isStream() || isCdc() ? 1 : mode() === 'daily' ? (S.runs.some(r => r.st === 'running') ? 600 : 7200) : 360;
      const realDur = i => tasks()[i][2] * (mode() === 'daily' ? 3 : 1);

      /* ---------- батч: запуски и задачи ---------- */
      let rid = 1;
      function mkRun(ivs, st) {
        return { id: rid++, ivs, ive: ivs + step(), st: st || 'queued', bf: false, plan: {}, tasks: tasks().map(() => ({ st: st === 'success' ? 'success' : 'none', tr: st === 'success' ? 1 : 0, t0: 0, dur: 0, log: [] })) };
      }
      function initBatch() {
        const sp = step(), m = mode();
        S.wall = m === 'daily' ? D0 + 3600 + 40 * 60 : D0 + 11 * 3600 + 52 * 60;
        const lastEnd = m === 'daily' ? D0 - 86400 : D0 + 11 * 3600;   // по какой момент данные уже в витрине
        S.runs = [];
        for (let k = 9; k >= 1; k--) S.runs.push(mkRun(lastEnd - k * sp, 'success'));
        S.wm = lastEnd; S.next = lastEnd + sp + (m === 'daily' ? 2 * 3600 : 0);   // когда создать следующий запуск
        S.maxAct = S.scn === 'backfill' ? 2 : 1;
        if (S.scn === 'backfill') {
          S.runs.slice(1).forEach(r => { r.st = 'queued'; r.bf = true; r.tasks.forEach(t => { t.st = 'none'; t.tr = 0; }); });
          S.bfN = 8;
        }
      }
      function startTask(r, i) {
        const t = r.tasks[i], fail = (r.plan[i] || 0) >= t.tr + 1;
        t.st = 'running'; t.tr++; t.t0 = S.t; t.dur = Math.max(r.bf ? 300 : 480, realDur(i) / runRate() * 1000 * (r.bf ? 0.5 : 1)); t.fail = fail; t.wall0 = S.wall;
        t.log.push(`[${hm(S.wall)}] запуск ${tasks()[i][0]}, попытка ${t.tr} из 3`);
      }
      function runStep(r) {
        const ts = r.tasks, n = ts.length;
        for (let i = 0; i < n; i++) {
          const t = ts[i];
          if (t.st === 'success') continue;
          if (t.st === 'running') {
            if (t.fail && S.t >= t.t0 + t.dur * 0.45) { failTask(r, i); return; }
            if (S.t >= t.t0 + t.dur) okTask(r, i);
            return;
          }
          if (t.st === 'retry') { if (S.t >= t.retryAt) startTask(r, i); return; }
          if (t.st === 'none' || t.st === 'queued') { startTask(r, i); return; }
          return;   // failed / upstream — запуск стоит
        }
      }
      function okTask(r, i) {
        const t = r.tasks[i], id = tasks()[i][0], rows = Math.round(ROWS_H * (mode() === 'daily' ? 24 : 1) * (1 + 0.04 * Math.sin(r.ivs / 3600)));
        t.st = 'success'; t.wall1 = S.wall;
        t.log.push(`[${hm(S.wall)}] ${i === 0 ? `${nf(rows)} строк за ${hm(r.ivs)}–${hm(r.ive)}` : i === tasks().length - 1 ? 'витрина подменена: EXCHANGE TABLES' : 'готово'} · SUCCESS`);
        if (i === tasks().length - 1) {
          r.st = 'success';
          if (r.ive > S.wm) S.wm = r.ive;
          S.pubT = S.t; S.lastRows = rows;
          if (r.bf) { S.bfDone = (S.bfDone || 0) + 1; if (S.bfDone >= S.bfN) { done('backfill'); note('bfd', `<b>Догрузка закончена:</b> ${S.bfN} интервалов пересчитаны, каждый перезаписал свою партицию — ни одной задвоенной строки.`, 'ok', 0); } }
        }
        if (S.scn === 'fail' && i === 0 && t.tr >= 2) { done('retry'); note('rok', `<b>extract прошёл с попытки ${t.tr}:</b> источник снова отвечает. Повтор безопасен: задача перезаписывает свой интервал целиком.`, 'ok', 0); }
        if (S.scn === 'fail' && r.fixed && i === r.failIdx) { done('sla'); note('fixok', '<b>Модель исправили и перезапустили</b> (Clear в Airflow): задача прошла, за ней тесты и публикация. Свежесть снова в норме.', 'ok', 0); }
      }
      function failTask(r, i) {
        const t = r.tasks[i], id = tasks()[i][0], err = i === 0 ? 'OperationalError: connection to replica timed out' : elt() ? 'Database Error in model fct_orders: Missing columns: \'amount\'' : 'AnalysisException: cannot resolve \'amount\'';
        t.log.push(`[${hm(S.wall)}] ERROR ${err}`);
        if (t.tr < 3) {
          const back = 300 * Math.pow(2, t.tr - 1);
          t.st = 'retry'; t.retryAt = S.t + Math.max(600, back / runRate() * 1000);
          t.log.push(`[${hm(S.wall)}] UP_FOR_RETRY: попытка ${t.tr + 1} через ${Math.round(back / 60)} мин`);
          note('rt' + i, `<b>${id} упал</b> (${ES(err.split(':')[0])}) — попытка ${t.tr} из 3. Ждём ${Math.round(back / 60)} мин и пробуем снова.`, 'warn', 2500);
        } else {
          t.st = 'failed'; r.st = 'failed'; r.failIdx = i; r.fixAt = S.wall + (mode() === 'daily' ? 5 * 3600 : 70 * 60);
          for (let k = i + 1; k < r.tasks.length; k++) r.tasks[k].st = 'upstream';
          t.log.push(`[${hm(S.wall)}] FAILED после 3 попыток · дальше upstream_failed`);
          note('fl' + i, `<b>${id} упал все 3 раза</b> — это не сбой сети, а ошибка в логике: ${ES(err)}. Тесты и публикация не запускались (upstream_failed), витрина устаревает.`, 'bad', 0);
        }
      }
      function batchStep() {
        const sp = step();
        if (S.wall >= S.next) {
          const ivs = mode() === 'daily' ? S.next - 2 * 3600 - sp : S.next - sp;
          const r = mkRun(ivs);
          if (S.scn === 'fail') { const nth = (S.failN = (S.failN || 0) + 1); if (nth === 1) r.plan[0] = 2; if (nth === 2) r.plan[2] = 3; }
          S.runs.push(r); S.next += sp;
          if (S.runs.length > 14) S.runs.splice(0, S.runs.length - 14);
        }
        // починка упавшего запуска (Clear)
        S.runs.forEach(r => {
          if (r.st === 'failed' && r.fixAt && S.wall >= r.fixAt) {
            r.st = 'running'; r.fixed = 1; const i = r.failIdx; r.plan[i] = 0;
            r.tasks[i].st = 'none'; r.tasks[i].tr = 0; r.tasks[i].log.push(`[${hm(S.wall)}] модель исправили, Clear → перезапуск`);
            for (let k = i + 1; k < r.tasks.length; k++) r.tasks[k].st = 'none';
            note('clr', '<b>Инженер исправил модель и нажал Clear</b> — упавшая задача и всё после неё запускаются заново.', '', 0);
          }
        });
        // обычные запуски — по одному и только после успеха предыдущего (depends_on_past), догрузка — отдельным пулом по два
        let actN = S.runs.filter(r => r.st === 'running' && !r.bf).length, actB = S.runs.filter(r => r.st === 'running' && r.bf).length;
        S.runs.filter(r => r.st === 'queued').sort((a, b) => a.ivs - b.ivs).forEach(r => {
          if (r.bf) { if (actB < 2) { r.st = 'running'; actB++; } return; }
          const blocked = S.runs.some(x => !x.bf && x.ivs < r.ivs && x.st !== 'success');
          if (actN < 1 && !blocked) { r.st = 'running'; actN++; }
        });
        S.runs.filter(r => r.st === 'running').forEach(runStep);
      }

      /* ---------- поток (Flink) ---------- */
      function initStream() { S.wall = D0 + 12 * 3600 + 47 * 60 + 10; S.fl = { dots: [], at: 0, ck: 1841, ckAt: 2500, bar: null, lag: 0.9, crash: null, replay: null, ev: null, evAt: 2500 }; S.wm = S.wall - 1; }
      function streamStep(dt) {
        const f = S.fl, stop = f.crash && f.crash.ph === 'down';
        if (!stop && S.t >= f.at) { f.at = S.t + (f.replay || (f.crash && f.crash.ph === 'up') ? 55 : 120); if (f.dots.length < 40) f.dots.push({ t0: S.t, d: 1700 }); }
        f.dots = f.dots.filter(d => S.t - d.t0 < d.d);
        if (!f.bar && S.t >= f.ckAt && !stop) f.bar = { t0: S.t };
        if (f.bar && S.t - f.bar.t0 > 1800) { f.ck++; f.ckT = S.t; f.bar = null; f.ckAt = S.t + 4200; }
        if (S.scn === 'fail' && !f.ev && S.t >= f.evAt) { f.ev = 1; f.crash = { ph: 'down', t0: S.t, ck: f.ck }; f.bar = null; note('tm', `<b>TaskManager упал</b> (закончилась память). Flink остановил задание и восстанавливает его из чекпойнта #${f.ck}: состояние и позиции чтения в Kafka возвращаются к моменту чекпойнта.`, 'bad', 0); }
        if (f.crash && f.crash.ph === 'down' && S.t - f.crash.t0 > 1800) { f.crash.ph = 'up'; f.crash.t1 = S.t; note('tmu', '<b>Задание поднялось</b> из чекпойнта и перечитывает сообщения после него. Дублей в витрине нет: sink коммитит транзакцию вместе с чекпойнтом (exactly-once).', 'ok', 0); }
        if (f.crash && f.crash.ph === 'up' && f.lag < 1.2) f.crash = null;
        if (S.scn === 'backfill' && !f.ev && S.t >= f.evAt) { f.ev = 1; f.replay = { t0: S.t, tot: 13 * 86400, left: 13 * 86400 }; note('rw', '<b>Перемотка offset назад на 1 июля:</b> группа потребителей перечитывает 13 дней событий, пока Kafka их ещё хранит (retention 7–14 дней). Пересчёт идёт на полной скорости.', '', 0); }
        if (f.replay) { f.replay.left = Math.max(0, f.replay.left - dt / 1000 * 160000); if (f.replay.left <= 0) { f.replay = null; done('backfill'); note('rwd', '<b>Догнали:</b> история пересчитана, задание вернулось к живым событиям. Альтернатива — батч-задача по озеру: дешевле и не трогает поток.', 'ok', 0); } }
        // отставание (секунды)
        let target = 0.9;
        if (f.crash) target = f.crash.ph === 'down' ? 0.9 + (S.t - f.crash.t0) / 1000 * 25 : 0.9;
        if (f.replay) target = f.replay.left;
        f.lag = f.crash && f.crash.ph === 'down' ? target : f.lag + (target - f.lag) * Math.min(1, dt / (f.replay ? 200 : 900));
        S.wm = S.wall - f.lag;
      }

      /* ---------- CDC ---------- */
      function initCdc() {
        S.wall = D0 + 12 * 3600 + 47 * 60;
        S.cd = { ph: S.scn === 'cdc' ? 'snap' : 'stream', snap: 0, msgs: [], dots: [], at: 0, lsn: 0x1A3F2B8, off: 81234, wal: 0.3, ev: null, evAt: 3000, failed: false, lag: 0.3 };
        S.wm = S.wall;
        if (S.scn === 'schema') for (let k = 0; k < 4; k++) pushMsg(true);
      }
      const ORD = [[10482931, 'paid', '1290.00'], [10482932, 'paid', '845.50'], [10482940, 'new', '5600.00'], [10471002, 'cancelled', '199.00'], [10482941, 'new', '2490.00'], [10482933, 'refunded', '3490.00']];
      function pushMsg(silent, opF) {
        const c = S.cd, r = Math.random(), op = opF || (r < 0.5 ? 'c' : r < 0.88 ? 'u' : 'd'), o = ORD[Math.floor(Math.random() * ORD.length)];
        c.lsn += 0x58 + Math.floor(Math.random() * 0x40); c.off++;
        const id = op === 'c' ? 10482942 + (c.off % 900) : o[0];
        const m = { op, id, st: op === 'u' ? 'paid' : o[1], prev: op === 'u' ? 'new' : null, amt: o[2], lsn: c.lsn, off: c.off, t0: S.t, wall: S.wall, ddl: opF === 'ddl' };
        c.msgs.push(m); if (c.msgs.length > 6) c.msgs.shift();
        if (!silent) c.dots.push({ t0: S.t, d: 1600, op, stopAt: c.failed || m.ddl ? 1 : 4, ddl: m.ddl });
        if (op === 'u') S.flags.u = 1; if (op === 'd') S.flags.d = 1;
      }
      function cdcStep(dt) {
        const c = S.cd;
        if (c.ph === 'snap') {
          c.snap = Math.min(12e6, c.snap + dt / 1000 * 2.4e6);
          if (S.t >= c.at) { c.at = S.t + 90; c.dots.push({ t0: S.t, d: 1500, op: 'r', stopAt: 4 }); c.off++; }
          if (c.snap >= 12e6) { c.ph = 'stream'; note('snapd', '<b>Снимок готов:</b> 12 млн строк orders отправлены как сообщения op = r. Дальше Debezium читает только изменения из журнала — с того LSN, на котором начинался снимок.', 'ok', 0); }
        } else if (S.t >= c.at) {
          c.at = S.t + (c.burst ? 90 : 420);
          if (!c.failed) pushMsg(false); else { c.lsn += 0x80; if (c.dots.filter(d => d.stopAt < 4).length < 12) c.dots.push({ t0: S.t, d: 900, op: 'u', stopAt: 1 }); }
          if (c.burst) c.burst--;
        }
        if (S.flags.u && S.flags.d && S.scn === 'cdc') done('cdc');
        c.dots = c.dots.filter(d => S.t - d.t0 < d.d + (d.stopAt < 4 ? 99999 : 0));
        if (S.scn === 'schema') {
          if (!c.ev && S.t >= c.evAt) {
            c.ev = 1; pushMsg(false, 'ddl');
            note('ddl', '<b>В боевой базе выполнили ALTER TABLE orders RENAME COLUMN amount TO total_amount.</b> Debezium увидел новую схему таблицы и пытается зарегистрировать её в реестре схем.', 'warn', 0);
            c.failAt = S.t + 1300;
          }
          if (c.failAt && !c.failed && S.t >= c.failAt) {
            c.failed = true; c.failT = S.t;
            note('cf', '<b>Коннектор упал:</b> реестр схем отклонил новую версию — переименование ломает обратную совместимость (поле amount исчезло для потребителей). Слот репликации при этом держит журнал WAL на диске базы.', 'bad', 0);
          }
          if (c.failed) { c.wal += dt / 1000 * 1.6; c.lag += dt / 1000 * 60; if (c.wal > 3) done('wal'); }
          if (c.failed && S.t - c.failT > 7500) {
            c.failed = false; c.fixed = 1; c.burst = 30; c.dots = c.dots.filter(d => d.stopAt === 4);
            note('cfix', '<b>Починили:</b> переименование откатили и сделали по-взрослому — ADD COLUMN total_amount, пишем в обе колонки, через месяц удаляем amount. Коннектор перезапущен, догоняет журнал, слот отпускает WAL.', 'ok', 0);
          }
          if (!c.failed && c.wal > 0.3) c.wal = Math.max(0.3, c.wal - dt / 1000 * 2.2);
          if (!c.failed && c.lag > 0.3) c.lag = Math.max(0.3, c.lag - dt / 1000 * 140);
        }
        S.wm = S.wall - (c.lag || 0.3);
      }

      /* ---------- свежесть ---------- */
      const fresh = () => Math.max(0, S.wall - S.wm);
      function reset() {
        Object.assign(S, { t: 0, fh: [], fhAt: 0, flags: {}, cfgT: 0, pubT: -1e9, bfDone: 0, failN: 0, slaT: null });
        S.runs = []; S.fl = null; S.cd = null;
        if (isCdc()) initCdc(); else if (isStream()) initStream(); else initBatch();
        S.cfg = cfgSig();
      }
      const cfgSig = () => [mode(), elt(), S.scn].join('|');

      /* ---------- отрисовка общей картинки ---------- */
      function badges() {
        const bs = [['mode', 'ПОТОК ИЛИ БАТЧ', { stream: 'поток · секунды', hourly: 'батч раз в час', daily: 'батч ночью' }[mode()], ''], ['elt', 'ETL ИЛИ ELT', elt() ? 'ELT: в хранилище' : 'ETL: в конвейере', ''],
          ['retry', 'ПОВТОРЫ', 'retries 3 · пауза 5 мин', ''], ['cdc', 'CDC ИЗ БАЗЫ', isCdc() ? 'Debezium → Kafka' : 'журнал вместо выгрузок', ''], ['tests', 'ТЕСТЫ ДАННЫХ', 'до публикации витрины', '']];
        const w = (984 - DZ.x - 4 * 8) / 5;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xe-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xe-go');
        bs.forEach(([k, t, v, c], i) => { const x = DZ.x + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xe-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s' + (c ? ' xe-' + c : ''))}</g>`; });
        return s;
      }
      function sources() {
        const ins = ctx.ins().map(x => x.n), q = ins.find(k => k.type === 'queue' || k.type === 'cdc') || ins[0], go = q && ctx.canGo(q.id), l = ctx.res.load || {};
        let s = `<g${go ? ` class="xr-go" data-xgo="${q.id}"` : ''}>${R(SRC1.x, SRC1.y, SRC1.w, SRC1.h, 'xr-box', 12)}`;
        s += T(SRC1.x + 12, SRC1.y + 22, ES(cut(q ? ctx.nm(q.id) : 'Брокер', 18)), 'xr-t') + T(SRC1.x + 12, SRC1.y + 42, 'события магазина', 'xr-s') + T(SRC1.x + 12, SRC1.y + 60, `≈ ${SD.fmt.num(l.events || 0)} в секунду`, 'xr-m acc');
        s += T(SRC1.x + 12, SRC1.y + 80, isStream() ? 'читаем непрерывно' : isCdc() ? 'топик pg.public.orders' : 'копятся до запуска', 'xr-s');
        if (go) s += T(SRC1.x + 12, SRC1.y + SRC1.h - 10, 'клик — внутрь ›', 'xr-s xe-go');
        s += '</g>';
        const c = S.cd, bad = c && c.failed;
        s += R(SRC2.x, SRC2.y, SRC2.w, SRC2.h, 'xr-box' + (bad && c.wal > 2 ? ' bad' : ''), 12) + T(SRC2.x + 12, SRC2.y + 22, 'PostgreSQL · orders', 'xr-t');
        if (isCdc()) {
          s += T(SRC2.x + 12, SRC2.y + 42, 'журнал WAL, слот', 'xr-s') + T(SRC2.x + 12, SRC2.y + 58, 'debezium_orders', 'xe-fn');
          s += T(SRC2.x + 12, SRC2.y + 80, 'держит WAL:', 'xr-s') + T(SRC2.x + 148, SRC2.y + 80, `${nf(c.wal, 1)} ГБ`, 'xr-m ' + (c.wal > 2 ? 'bad' : c.wal > 1 ? 'warn' : 'ok'), 'end');
          s += R(SRC2.x + 12, SRC2.y + 88, SRC2.w - 24, 7, 'xr-bar', 3) + R(SRC2.x + 12, SRC2.y + 88, (SRC2.w - 24) * clamp(c.wal / 12, 0, 1), 7, 'xr-bar-f' + (c.wal > 2 ? ' bad' : ''), 3);
          s += T(SRC2.x + 12, SRC2.y + 110, bad ? 'диск базы заполняется!' : 'коннектор подтверждает', 'xr-s' + (bad ? ' xe-bad' : ''));
        } else {
          s += T(SRC2.x + 12, SRC2.y + 42, 'боевая база заказов', 'xr-s') + T(SRC2.x + 12, SRC2.y + 62, isStream() ? 'события идут через Kafka' : 'extract читает реплику:', 'xr-s');
          s += T(SRC2.x + 12, SRC2.y + 80, isStream() ? '' : 'WHERE updated_at', 'xe-fn') + T(SRC2.x + 12, SRC2.y + 96, isStream() ? '' : 'в интервале запуска', 'xr-s');
        }
        return s;
      }
      function clock() {
        const b = CLK, m = mode();
        let s = `<g class="xr-part" data-xpart="mode">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, 'СЕЙЧАС', 'xr-m') + T(b.x + 12, b.y + 52, hm(S.wall), 'xe-big') + T(b.x + 12, b.y + 72, dm(S.wall), 'xr-s');
        const sched = isCdc() ? ['CDC: непрерывно', 'каждое изменение'] : m === 'stream' ? ['поток: непрерывно', 'Flink, чекпойнт 30 с'] : m === 'daily' ? ['расписание 0 2 * * *', 'каждую ночь в 02:00'] : ['расписание @hourly', 'в начале каждого часа'];
        s += T(b.x + 12, b.y + 100, sched[0], 'xe-fn') + T(b.x + 12, b.y + 116, sched[1], 'xr-s');
        const cur = S.runs && S.runs.find(r => r.st === 'running');
        if (cur) s += T(b.x + 12, b.y + 140, 'интервал данных:', 'xr-s') + T(b.x + 12, b.y + 156, m === 'daily' ? `${dshort(cur.ivs)} 00:00 → ${dshort(cur.ive)} 00:00` : `${hm(cur.ivs)} → ${hm(cur.ive)}`, 'xe-fn xe-acc');
        else s += T(b.x + 12, b.y + 140, isStream() || isCdc() ? 'интервала нет:' : 'следующий запуск:', 'xr-s') + T(b.x + 12, b.y + 156, isStream() || isCdc() ? 'событие за событием' : hm(S.next), 'xe-fn');
        const cost = isCdc() ? 150 : m === 'stream' ? 450 : 180, always = isCdc() || m === 'stream';
        s += Ln(b.x + 12, b.y + 172, b.x + b.w - 12, b.y + 172, 'xe-sep') + T(b.x + 12, b.y + 192, 'цена в месяц:', 'xr-s') + T(b.x + b.w - 12, b.y + 192, `≈ $${cost}`, 'xr-m ' + (always ? 'warn' : 'ok'), 'end');
        s += T(b.x + 12, b.y + 210, isCdc() ? 'коннектор + Kafka 24/7' : always ? 'кластер работает 24/7' : 'воркеры — минуты в час', 'xr-s') + T(b.x + 12, b.y + 228, 'клик — поток или батч ›', 'xr-s xe-go');
        return s + '</g>';
      }
      function taskCls(t) { return { success: 'ok', running: 'run', retry: 'retry', failed: 'fail', upstream: 'up', none: 'none', queued: 'none' }[t.st] || 'none'; }
      function curRun() { const rs = S.runs.filter(r => r.st === 'running' || r.st === 'failed'); return rs.length ? rs[rs.length - 1] : S.runs[S.runs.length - 1]; }
      function dagZone() {
        let s = `<g class="xr-part" data-xpart="dag">${R(DZ.x, DZ.y, DZ.w, DZ.h, 'xr-zone', 14)}`;
        if (isCdc()) return s + cdcZone() + '</g>';
        if (isStream()) return s + flinkZone() + '</g>';
        const ts = tasks(), r = curRun(), ei = ts.findIndex(t => t[3] === 'edge'), split = bx(ei) + BW / 2;
        s += R(DZ.x + 6, DZ.y + 30, split - DZ.x - 6, DZ.h - 36, 'xe-half conv', 10) + R(split, DZ.y + 30, DZ.x + DZ.w - 6 - split, DZ.h - 36, 'xe-half dwh', 10);
        s += T(DZ.x + 12, DZ.y + 18, `DAG orders_${mode() === 'daily' ? 'daily' : 'hourly'} · Airflow`, 'xr-m acc') + T(DZ.x + DZ.w - 12, DZ.y + 18, r && r.bf ? 'догрузка прошлого' : `запуск за ${mode() === 'daily' ? dshort(r.ivs) : hm(r.ivs) + '–' + hm(r.ive)}`, 'xr-s', 'end');
        s += T(DZ.x + 14, DZ.y + DZ.h - 12, 'в конвейере', 'xe-zl') + T(DZ.x + DZ.w - 14, DZ.y + DZ.h - 12, 'в хранилище ClickHouse', 'xe-zl', 'end');
        s += `<text class="xe-code sm" xml:space="preserve" x="${DZ.x + 14}" y="${DZ.y + 46}">${ES(ts.map(t => t[0]).join(' >> '))}</text>`;
        ts.forEach((tk, i) => {
          const t = r.tasks[i], x = bx(i), c = taskCls(t);
          if (i > 0) s += arrow(x - BG + 1, BY + BH / 2, x - 2, BY + BH / 2, r.tasks[i - 1].st === 'success' ? 'ok' : '');
          s += R(x, BY, BW, BH, 'xe-task ' + c, 8) + T(x + 8, BY + 18, tk[0], 'xe-fn');
          const st = t.st === 'running' ? `идёт · ${t.tr}/3` : t.st === 'retry' ? `повтор ${t.tr + 1}/3` : t.st === 'failed' ? 'failed' : t.st === 'upstream' ? 'после сбоя' : t.st === 'success' ? `успех${t.tr > 1 ? ` с ${t.tr}-й` : ''}` : 'ждёт';
          s += T(x + 8, BY + 36, st, 'xe-ms ' + ({ ok: 'xe-ok', run: 'xe-acc', retry: 'xe-warn', fail: 'xe-bad', up: 'xe-bad' }[c] || ''));
          s += T(x + 8, BY + 53, cut(tk[1], 15), 'xe-ms');
          if (t.st === 'running') { const k = clamp((S.t - t.t0) / t.dur, 0, 1); s += R(x + 4, BY + BH - 6, (BW - 8) * k, 3, 'xe-prog', 1.5); }
          if (t.st === 'retry') { const k = clamp(1 - (t.retryAt - S.t) / Math.max(1, t.retryAt - t.t0 - t.dur * 0.45), 0, 1); s += `<circle class="xe-ring" cx="${f1(x + BW - 12)}" cy="${f1(BY + 14)}" r="7" stroke-dasharray="${f1(k * 44)} 44" transform="rotate(-90 ${f1(x + BW - 12)} ${f1(BY + 14)})"/>`; }
        });
        // что лежит после каждой задачи
        const art = elt() ? [['s3://raw/', 'parquet'], ['raw.orders', 'сырые строки'], ['fct_orders', 'чистые факты'], ['тесты', '0 ошибок'], ['mart_revenue', 'для BI']]
          : [['память Spark', 'DataFrame'], ['s3://stage/', 'готовые суммы'], ['mart_new', 'загружено'], ['сверка', 'строк = строк'], ['mart_revenue', 'для BI']];
        art.forEach(([a, b2], i) => {
          const x = bx(i), t = r.tasks[i], on = t.st === 'success' || t.st === 'running';
          s += R(x, BY + BH + 26, BW, 38, 'xe-art' + (on ? ' on' : ''), 6) + T(x + 6, BY + BH + 41, cut(a, 15), 'xe-fn sm') + T(x + 6, BY + BH + 56, b2, 'xe-ms');
          s += Ln(x + BW / 2, BY + BH, x + BW / 2, BY + BH + 26, 'xe-sep');
        });
        return s + '</g>';
      }
      function flinkZone() {
        const f = S.fl, ops = elt() ? [['Kafka source', '3 партиции'], ['parse JSON', 'типы, ts'], ['ClickHouse sink', 'сырьё, exactly-once'], ['MV в ClickHouse', 'суммы по минутам']] : [['Kafka source', '3 партиции'], ['parse + dedup', 'состояние 1 ч'], ['окно 1 мин', 'TUMBLE по ts'], ['ClickHouse sink', 'exactly-once']];
        let s = T(DZ.x + 12, DZ.y + 18, 'Flink · задание orders_stream · parallelism 4', 'xr-m acc') + T(DZ.x + DZ.w - 12, DZ.y + 18, `чекпойнт #${f.ck}`, 'xr-s' + (S.t - (f.ckT || -1e9) < 900 ? ' xe-ok' : ''), 'end');
        const W = 112, G = (DZ.w - 24 - 4 * W) / 3, X = i => DZ.x + 12 + i * (W + G), Y = 104;
        ops.forEach(([a, b2], i) => {
          const down = f.crash && f.crash.ph === 'down' && i === 1, rec = f.crash && f.crash.ph === 'up';
          if (i > 0) s += arrow(X(i) - G + 2, Y + 30, X(i) - 3, Y + 30, '');
          s += R(X(i), Y, W, 70, 'xe-task ' + (down ? 'fail' : rec ? 'retry' : 'run'), 8) + T(X(i) + 8, Y + 17, cut(a, 16), 'xe-fn') + T(X(i) + 8, Y + 50, cut(b2, 17), 'xe-ms') + T(X(i) + 8, Y + 64, down ? 'упал!' : rec ? 'догоняет' : 'работает', 'xe-ms ' + (down ? 'xe-bad' : rec ? 'xe-warn' : 'xe-ok'));
        });
        s += T(DZ.x + 14, Y + 98, f.replay ? `переигрываем историю: осталось ${dur(f.replay.left)} событий` : f.crash ? (f.crash.ph === 'down' ? `восстановление из чекпойнта #${f.crash.ck}…` : 'перечитываем сообщения после чекпойнта') : 'каждое событие проходит за секунды', 'xr-s' + (f.crash || f.replay ? ' xe-warn' : ''));
        s += T(DZ.x + 14, Y + 118, elt() ? 'ELT в потоке: сырьё сразу в хранилище, суммы считает ClickHouse' : 'ETL в потоке: окна и суммы считает Flink, в хранилище — готовое', 'xe-ms');
        s += T(DZ.x + 14, Y + 138, 'состояние: 2,1 ГБ в RocksDB · чекпойнты → s3://ckpt/orders_stream/', 'xe-ms');
        s += T(DZ.x + 14, DZ.y + DZ.h - 12, 'опоздавшие события: watermark = max(ts) − 30 с, позже — отдельный поток', 'xe-zl');
        return s;
      }
      function cdcZone() {
        const c = S.cd, ops = [['PostgreSQL WAL', `LSN 0/${c.lsn.toString(16).toUpperCase()}`], ['Debezium', c.failed ? 'FAILED' : 'слот pgoutput'], ['Kafka', 'pg.public.orders'], ['загрузчик', 'upsert в ClickHouse']];
        let s = T(DZ.x + 12, DZ.y + 18, 'CDC · Debezium + Kafka Connect', 'xr-m acc') + T(DZ.x + DZ.w - 12, DZ.y + 18, c.ph === 'snap' ? 'этап 1: полный снимок' : 'этап 2: поток изменений', 'xr-s', 'end');
        const W = 112, G = (DZ.w - 24 - 4 * W) / 3, X = i => DZ.x + 12 + i * (W + G), Y = 96;
        ops.forEach(([a, b2], i) => {
          const bad = c.failed && i === 1;
          if (i > 0) s += arrow(X(i) - G + 2, Y + 30, X(i) - 3, Y + 30, bad || (c.failed && i === 2) ? 'bad' : '');
          s += R(X(i), Y, W, 64, 'xe-task ' + (bad ? 'fail' : 'run'), 8) + T(X(i) + 8, Y + 17, a, 'xe-fn') + T(X(i) + 8, Y + 52, ES(cut(b2, 17)), 'xe-ms' + (bad ? ' xe-bad' : ''));
        });
        if (c.ph === 'snap') {
          const k = c.snap / 12e6;
          s += T(DZ.x + 14, Y + 92, `снимок таблицы: ${nf(c.snap / 1e6, 1)} из 12 млн строк · op = r`, 'xr-s xe-acc') + R(DZ.x + 14, Y + 100, DZ.w - 28, 8, 'xr-bar', 4) + R(DZ.x + 14, Y + 100, (DZ.w - 28) * k, 8, 'xr-bar-f acc', 4);
          s += T(DZ.x + 14, Y + 128, 'запомнили LSN начала — изменения во время снимка не потеряются', 'xe-ms');
        } else if (S.scn === 'schema' && c.ev) {
          s += CODE(DZ.x + 14, Y + 92, 'ALTER TABLE orders RENAME COLUMN amount TO total_amount', 'sm');
          s += T(DZ.x + 14, Y + 114, c.failed ? 'реестр схем: новая версия несовместима → коннектор FAILED' : c.fixed ? 'исправлено: ADD COLUMN вместо RENAME, коннектор догоняет' : 'Debezium читает новую схему…', 'xr-s ' + (c.failed ? 'xe-bad' : c.fixed ? 'xe-ok' : 'xe-warn'));
          s += T(DZ.x + 14, Y + 134, c.failed ? `слот держит журнал: WAL ${nf(c.wal, 1)} ГБ и растёт` : 'слот отпускает журнал по мере чтения', 'xe-ms' + (c.failed ? ' xe-bad' : ''));
        } else {
          s += T(DZ.x + 14, Y + 92, 'каждая вставка, правка и удаление — сообщение с before и after', 'xr-s') + T(DZ.x + 14, Y + 112, 'ключ сообщения — order_id: изменения одного заказа идут по порядку', 'xe-ms');
        }
        const ops2 = { r: 'r · снимок', c: 'c · вставка', u: 'u · правка', d: 'd · удаление' };
        s += T(DZ.x + 14, DZ.y + DZ.h - 12, Object.values(ops2).join('   '), 'xe-zl');
        return s;
      }
      function target() {
        const outs = ctx.outs().map(x => x.n), d = outs.find(k => k.type === 'olap') || outs.find(k => k.type === 'lake') || outs[0], go = d && ctx.canGo(d.id);
        let s = `<g${go ? ` class="xr-go" data-xgo="${d.id}"` : ''}>${R(TGT.x, TGT.y, TGT.w, TGT.h, 'xr-box' + (S.t - S.pubT < 700 ? ' sel' : ''), 12)}`;
        s += T(TGT.x + 12, TGT.y + 22, ES(cut(d ? ctx.nm(d.id) : 'Хранилище', 22)), 'xr-t') + T(TGT.x + 12, TGT.y + 42, isCdc() ? 'orders (ReplacingMergeTree)' : 'витрина mart_revenue', 'xe-fn');
        const wm = S.wm;
        s += T(TGT.x + 12, TGT.y + 62, isStream() || isCdc() ? 'данные по' : 'данные по', 'xr-s') + T(TGT.x + 232, TGT.y + 62, isStream() || isCdc() ? hm(wm) + ':' + String(Math.floor(wm % 60)).padStart(2, '0') : (mode() === 'daily' ? `${dshort(wm)} 00:00` : hm(wm)), 'xr-m acc', 'end');
        s += T(TGT.x + 12, TGT.y + 82, S.t - S.pubT < 1500 ? 'витрина только что обновлена' : isStream() || isCdc() ? 'обновляется непрерывно' : 'ждёт следующей загрузки', 'xr-s' + (S.t - S.pubT < 1500 ? ' xe-ok' : ''));
        if (go) s += T(TGT.x + 12, TGT.y + TGT.h - 10, 'клик — внутрь ›', 'xr-s xe-go');
        return s + '</g>';
      }
      function freshPanel() {
        const b = FR, fr = fresh(), sla = SLA(), bad = fr > sla;
        let s = `<g class="xr-part" data-xpart="sla">${R(b.x, b.y, b.w, b.h, 'xr-box' + (bad ? ' bad' : ''), 12)}`;
        s += T(b.x + 12, b.y + 20, 'СВЕЖЕСТЬ ВИТРИНЫ', 'xr-m') + T(b.x + b.w - 12, b.y + 20, `SLA ${dur(sla)}`, 'xr-s', 'end');
        s += T(b.x + 12, b.y + 50, dur(fr), 'xe-big ' + (bad ? 'xe-bad' : fr > sla * 0.75 ? 'xe-warn' : 'xe-ok'));
        s += R(b.x + 12, b.y + 60, b.w - 24, 8, 'xr-bar', 4) + R(b.x + 12, b.y + 60, (b.w - 24) * clamp(fr / (sla * 1.3), 0, 1), 8, 'xr-bar-f ' + (bad ? 'bad' : fr > sla * 0.75 ? 'warn' : ''), 4) + Ln(b.x + 12 + (b.w - 24) / 1.3, b.y + 56, b.x + 12 + (b.w - 24) / 1.3, b.y + 72, 'xe-sla');
        // график
        const pts = S.fh, gx = b.x + 12, gy = b.y + 80, gw = b.w - 24, gh = 34, mx = Math.max(sla * 1.3, ...pts.map(p => p.v));
        if (pts.length > 1) s += `<polyline class="xe-spark${bad ? ' bad' : ''}" points="${pts.map((p, i) => `${f1(gx + gw * i / 59)},${f1(gy + gh - gh * p.v / mx)}`).join(' ')}"/>`;
        s += Ln(gx, gy + gh - gh * sla / mx, gx + gw, gy + gh - gh * sla / mx, 'xe-sla dash');
        return s + '</g>';
      }
      function gridPanel() {
        const b = GRID;
        let s = `<g class="xr-part" data-xpart="backfill">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        if (isCdc()) {
          const c = S.cd;
          s += T(b.x + 12, b.y + 20, 'СООБЩЕНИЯ В ТОПИКЕ pg.public.orders', 'xr-m');
          s += T(b.x + 12, b.y + 42, 'offset', 'xe-fn') + T(b.x + 76, b.y + 42, 'op', 'xe-fn') + T(b.x + 106, b.y + 42, 'key', 'xe-fn') + T(b.x + 180, b.y + 42, 'что изменилось', 'xe-fn');
          const list = c.ph === 'snap' ? [{ off: c.off, op: 'r', id: 10000000 + Math.floor(c.snap), st: 'paid', amt: '1290.00' }] : c.msgs.slice().reverse();
          list.slice(0, 6).forEach((m, j) => {
            const y = b.y + 64 + j * 22, fl = S.t - (m.t0 || 0) < 600;
            if (fl) s += R(b.x + 6, y - 15, b.w - 12, 21, 'xe-krow', 4);
            const what = m.ddl ? 'схема: amount → total_amount' : m.op === 'c' ? `новый заказ · ${m.amt} ₽` : m.op === 'u' ? `status: ${m.prev} → ${m.st}` : m.op === 'd' ? 'удалён (after = null)' : 'строка из снимка';
            s += T(b.x + 12, y, nf(m.off), 'xe-val') + T(b.x + 76, y, m.ddl ? '—' : m.op, 'xe-val op' + (m.op || '')) + T(b.x + 106, y, String(m.id), 'xe-val') + T(b.x + 180, y, ES(what), 'xe-ms' + (m.ddl ? ' xe-warn' : ''));
          });
          s += T(b.x + 12, b.y + b.h - 30, c.failed ? 'новых сообщений нет: коннектор стоит' : `отставание потребителя: ${dur(c.lag || 0.3)}`, 'xr-s' + (c.failed ? ' xe-bad' : ''));
          s += T(b.x + 12, b.y + b.h - 12, 'Kafka хранит сообщения 7 дней: потребитель может перечитать', 'xe-ms');
          return s + '</g>';
        }
        if (isStream()) {
          const f = S.fl;
          s += T(b.x + 12, b.y + 20, 'ЧЕКПОЙНТЫ И ОТСТАВАНИЕ', 'xr-m');
          for (let j = 0; j < 12; j++) { const id = f.ck - 11 + j, x = b.x + 12 + j * 31; s += R(x, b.y + 34, 26, 22, 'xe-cell ' + (f.crash && f.crash.ph === 'down' && j === 11 ? 'fail' : 'ok'), 4) + T(x + 13, b.y + 70, String(id % 100).padStart(2, '0'), 'xe-ms', 'middle'); }
          s += T(b.x + 12, b.y + 94, `чекпойнт #${f.ck}: состояние и offset сохранены в S3`, 'xr-s');
          s += T(b.x + 12, b.y + 122, 'отставание потребителя (consumer lag):', 'xr-s') + T(b.x + b.w - 12, b.y + 122, dur(f.lag), 'xr-m ' + (f.lag > 60 ? 'bad' : f.lag > 5 ? 'warn' : 'ok'), 'end');
          s += R(b.x + 12, b.y + 132, b.w - 24, 10, 'xr-bar', 4) + R(b.x + 12, b.y + 132, (b.w - 24) * clamp(Math.log10(1 + f.lag) / 6.1, 0, 1), 10, 'xr-bar-f ' + (f.lag > 60 ? 'bad' : f.lag > 5 ? 'warn' : ''), 4);
          s += T(b.x + 12, b.y + 166, f.replay ? 'перемотка: offset группы → 2026-07-01 00:00' : f.crash ? 'после падения — с последнего чекпойнта, без дублей' : 'шкала логарифмическая: секунды … дни', 'xe-ms' + (f.replay || f.crash ? ' xe-warn' : ''));
          s += T(b.x + 12, b.y + 190, 'Догрузка в потоке = перемотать offset назад', 'xe-ms') + T(b.x + 12, b.y + 206, 'и переиграть, пока Kafka хранит события.', 'xe-ms');
          return s + '</g>';
        }
        const ts = tasks(), runs = S.runs.slice(-10), LX = b.x + 12, CX = b.x + 96, CW = 28;
        s += T(LX, b.y + 20, 'ЗАПУСКИ (как Grid в Airflow)', 'xr-m') + T(b.x + b.w - 12, b.y + 20, S.scn === 'backfill' ? `догружено ${S.bfDone || 0} из ${S.bfN}` : 'столбец — интервал', 'xr-s' + (S.scn === 'backfill' ? ' xe-acc' : ''), 'end');
        runs.forEach((r, j) => {
          const x = CX + j * CW;
          s += T(x + 10, b.y + 40, mode() === 'daily' ? dshort(r.ivs).slice(3) : hm(r.ivs).slice(0, 2), 'xe-ms' + (r.bf ? ' xe-acc' : ''), 'middle');
          s += R(x, b.y + 46, 20, 6, 'xe-runbar ' + (r.st === 'success' ? 'ok' : r.st === 'failed' ? 'fail' : r.st === 'running' ? 'run' : 'none'), 2);
          r.tasks.forEach((t, i) => { s += R(x, b.y + 58 + i * 24, 20, 20, 'xe-cell ' + taskCls(t), 4); });
        });
        ts.forEach((tk, i) => { s += T(LX, b.y + 72 + i * 24, tk[0], 'xe-fn sm'); });
        s += T(LX, b.y + 196, mode() === 'daily' ? 'запуск за 13 июля стартует 14 июля в 02:00' : 'запуск за 11:00–12:00 стартует в 12:00:', 'xe-ms') + T(LX, b.y + 212, mode() === 'daily' ? 'когда день закончился и данные за него есть' : 'интервал закончился — данные за него есть', 'xe-ms');
        s += T(LX, b.y + 230, 'клик — догрузка прошлых интервалов ›', 'xr-s xe-go');
        return s + '</g>';
      }
      function logPanel() {
        const b = LOG;
        let s = R(b.x, b.y, b.w, b.h, 'xe-codebg', 12);
        let title = '', code = [], log = [];
        if (isCdc()) {
          const c = S.cd, m = c.msgs[c.msgs.length - 1];
          title = 'ОДНО СООБЩЕНИЕ DEBEZIUM (как видит потребитель)';
          if (c.ph === 'snap' || !m) code = ['{"op": "r",', ' "after": {"order_id": 10003211, "status": "paid",', '           "amount": 1290.00},', ' "source": {"snapshot": "true", "lsn": 27529912},', ' "ts_ms": 1784032010231}'];
          else if (m.ddl) code = ['-- новая схема значения, версия 2:', '{"fields": [{"field": "order_id", "type": "int64"},', '  {"field": "total_amount", "type": "bytes"}, …]}', '-- реестр: BACKWARD-совместимость нарушена:', '-- поле amount исчезло для старых потребителей'];
          else code = [`{"op": "${m.op}",`, ` "before": ${m.op === 'c' ? 'null' : `{"order_id": ${m.id}, "status": "${m.op === 'u' ? m.prev : m.st}"}`},`, m.op === 'd' ? ' "after": null,' : ` "after": {"order_id": ${m.id}, "status": "${m.st}",`, m.op === 'd' ? ` "source": {"table": "orders", "lsn": ${m.lsn}},` : `           "amount": ${m.amt}},`, m.op === 'd' ? ` "ts_ms": ${1784032000000 + Math.floor(S.t)}}` : ` "source": {"table": "orders", "lsn": ${m.lsn}}}`];
          log = c.failed ? [`[${hm(S.wall)}] ERROR Schema being registered is incompatible`, `[${hm(S.wall)}] Task debezium-orders-0 state: FAILED`] : [`[${hm(S.wall)}] slot debezium_orders: подтверждён LSN ${c.lsn}`];
        } else if (isStream()) {
          title = 'FLINK SQL ЗАДАНИЯ';
          code = elt() ? ['INSERT INTO ch_raw_orders', 'SELECT order_id, user_id, country, amount, ts', 'FROM kafka_orders;', '-- суммы по минутам считает MV в ClickHouse'] : ['INSERT INTO ch_revenue_1m', 'SELECT window_start, country, SUM(amount), COUNT(*)', 'FROM TABLE(TUMBLE(TABLE kafka_orders,', '       DESCRIPTOR(ts), INTERVAL \'1\' MINUTE))', 'GROUP BY window_start, window_end, country;'];
          const f = S.fl;
          log = [`[${hm(S.wall)}] checkpoint #${f.ck} completed (2,1 ГБ, 840 мс)`];
          if (f.crash) log.unshift(`[${hm(S.wall)}] ${f.crash.ph === 'down' ? 'TaskManager lost → restarting from checkpoint' : 'job RUNNING, replaying from saved offsets'}`);
        } else {
          const r = curRun(), i0 = r.tasks.findIndex(t => t.st !== 'success' && t.st !== 'upstream'), ai = i0 < 0 ? r.tasks.length - 1 : i0, id = tasks()[ai][0], t = r.tasks[ai];
          title = `КОД И ЛОГ ЗАДАЧИ ${id}`;
          const a = mode() === 'daily' ? `${dshort(r.ivs)}` : hm(r.ivs), e = mode() === 'daily' ? `${dshort(r.ive)}` : hm(r.ive);
          const C = {
            extract: ['SELECT order_id, user_id, country, amount, status', 'FROM orders', `WHERE updated_at >= '{{ data_interval_start }}' -- ${a}`, `  AND updated_at <  '{{ data_interval_end }}'   -- ${e}`],
            load_raw: ['INSERT INTO raw.orders', "SELECT * FROM s3('s3://raw/orders/dt=2026-07-14/'", `                  || 'hr=${a.slice(0, 2)}/*.parquet')`, '-- повтор перезапишет тот же час, а не допишет'],
            dbt_run: ['-- models/marts/fct_orders.sql', "{{ config(materialized='incremental',", "          unique_key='order_id') }}", 'select order_id, user_id, country, amount', "from {{ ref('stg_orders') }}", "where status != 'test'"],
            dbt_test: ['# models/marts/schema.yml', '- name: order_id', '  tests: [unique, not_null]', '- name: country', '  tests: [accepted_values: [RU, KZ, BY, UZ, AM, GE]]'],
            publish: ['-- новая витрина готовилась рядом,', '-- подмена атомарная: дашборд не видит полупустую', 'EXCHANGE TABLES mart_revenue_new AND mart_revenue'],
            transform: ['df = spark.read.parquet(f"s3://raw/orders/dt={ds}")', "clean = (df.filter(\"status != 'test'\")", '           .dropDuplicates(["order_id"]))', 'mart = clean.groupBy("country").agg(sum("amount"))', 'mart.write.mode("overwrite")', '    .parquet(f"s3://stage/mart/dt={ds}")'],
            load: ['INSERT INTO mart_revenue_new', "SELECT * FROM s3('s3://stage/mart/'", "                 || 'dt=2026-07-14/*.parquet')", '-- в хранилище — уже готовые суммы'],
            checks: ['assert rows_loaded == rows_extracted  # 48 210', 'assert revenue_today > 0.7 * revenue_week_ago', '# не прошло — publish не запустится']
          };
          code = C[id] || [];
          log = t.log.slice(-4);
        }
        s += T(b.x + 12, b.y + 20, ES(cut(title, 52)), 'xr-m');
        code.forEach((l, j) => { s += CODE(b.x + 12, b.y + 44 + j * 16, l, 'sm'); });
        s += Ln(b.x + 12, b.y + 132, b.x + b.w - 12, b.y + 132, 'xe-sep') + T(b.x + 12, b.y + 150, 'ЛОГ', 'xr-m');
        log.slice(-5).forEach((l, j) => { s += MONO(b.x + 12, b.y + 170 + j * 16, ES(cut(l, 58)), /ERROR|FAILED|lost/.test(l) ? 'bad' : /RETRY|restarting/.test(l) ? 'warn' : /SUCCESS|completed|подтверждён/.test(l) ? 'ok' : ''); });
        return s;
      }
      function dynSvg() {
        let s = '';
        const wc = SD.kindColor('write');
        if (isCdc()) {
          const c = S.cd, W = 112, G = (DZ.w - 24 - 4 * W) / 3, X = i => DZ.x + 12 + i * (W + G);
          c.dots.forEach(d => {
            const k = clamp((S.t - d.t0) / d.d, 0, 1), stop = d.stopAt < 4 ? (X(1) - 8) : null, px0 = SRC2.x + SRC2.w, pts = [[px0, SRC2.y + 40], [X(0), 126], [X(3) + W, 126], [TGT.x, TGT.y + 60]];
            let [x, y] = along(pts, ease(k));
            if (stop != null && x > stop) { x = stop - (d.t0 % 7) * 3; y = 126 + ((d.t0 / 7 | 0) % 5 - 2) * 5; }
            s += `<circle class="xr-dot" cx="${f1(x)}" cy="${f1(y)}" r="${d.ddl ? 6.5 : 4.5}" style="fill:${d.ddl ? 'var(--warn)' : d.op === 'd' ? 'var(--bad)' : d.op === 'r' ? 'var(--info)' : wc}"/>` + (d.ddl || k < 0.6 && k > 0.4 ? T(x, y - 9, d.ddl ? 'DDL' : d.op, 'xe-dl', 'middle') : '');
          });
          return s;
        }
        if (isStream()) {
          const f = S.fl, W = 112, G = (DZ.w - 24 - 4 * W) / 3, X = i => DZ.x + 12 + i * (W + G), Y = 134;
          f.dots.forEach(d => { const k = (S.t - d.t0) / d.d, [x, y] = along([[SRC1.x + SRC1.w, SRC1.y + 60], [X(0), Y], [X(3) + W, Y], [TGT.x, TGT.y + 60]], k); s += Dot(x, y, 4, '', `fill:${wc}`); });
          if (f.bar) { const k = clamp((S.t - f.bar.t0) / 1800, 0, 1), x = X(0) + (X(3) + W - X(0)) * k; s += Ln(x, 100, x, 168, 'xe-barrier') + T(x, 96, `барьер #${f.ck + 1}`, 'xe-dl', 'middle'); }
          return s;
        }
        // батч: строки текут между задачами
        const r = curRun(), i = r.tasks.findIndex(t => t.st === 'running');
        if (i >= 0) {
          const t = r.tasks[i], k = (S.t - t.t0) / t.dur, from = i === 0 ? [SRC2.x + SRC2.w, SRC2.y + 70] : [bx(i - 1) + BW, BY + BH / 2], to = [bx(i) + 6, BY + BH / 2];
          for (let j = 0; j < 4; j++) { const kk = (k * 3 + j / 4) % 1; s += Dot(...lerp(from, to, ease(kk)), 3.6, '', `fill:${wc}`); }
          if (t.fail && k > 0.3) s += T(bx(i) + BW / 2, BY - 6, 'ошибка…', 'xr-pop bad', 'middle');
        }
        if (S.t - S.pubT < 900) { const k = (S.t - S.pubT) / 900; s += Dot(...lerp([bx(4) + BW, BY + BH / 2], [TGT.x, TGT.y + 60], ease(k)), 6, 'ok'); }
        return s;
      }
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
      function drawMain() {
        gSt.innerHTML = badges() + sources() + clock() + dagZone() + target() + freshPanel() + gridPanel() + logPanel();
        gDy.innerHTML = dynSvg();
      }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 128, 26, 'xe-backb', 13)}${T(76, 27, '← весь конвейер', 'xr-s xe-back', 'middle')}</g>` + T(156, 27, t, 'xe-vt') + T(156, 46, sub, 'xr-s');
      function vDag() {
        const u = S.vt % 12000, sti = Math.floor(u / 1500) % 8;
        let s = head('Граф задач (DAG) и планировщик', 'код описывает задачи и порядок; планировщик создаёт запуск на каждый интервал данных');
        s += R(24, 60, 470, 250, 'xe-codebg', 10) + T(36, 80, 'dags/orders_hourly.py', 'xr-m');
        const py = ['with DAG("orders_hourly",', '         schedule="@hourly",', '         start_date=datetime(2026, 7, 1),', '         catchup=True,', '         default_args={"retries": 3,', '             "retry_delay": timedelta(minutes=5)}):', '    extract = PythonOperator(task_id="extract", …)', '    load    = S3ToClickHouse(task_id="load_raw", …)', '    run     = DbtRunOperator(task_id="dbt_run", …)', '    test    = DbtTestOperator(task_id="dbt_test", …)', '    publish = PythonOperator(task_id="publish", …)', '    extract >> load >> run >> test >> publish'];
        py.forEach((l, j) => { s += CODE(36, 100 + j * 16, l, 'sm' + (j === 11 ? ' hlt' : '')); });
        // интервалы
        s += R(510, 60, 466, 250, 'xe-panel', 10) + T(522, 80, 'ИНТЕРВАЛЫ ДАННЫХ И ЗАПУСКИ', 'xr-m');
        const X = h => 540 + (h - 8) * 70;
        s += Ln(530, 150, 960, 150, 'xe-axis');
        for (let h = 8; h <= 14; h++) s += Ln(X(h), 145, X(h), 155, 'xe-tick') + T(X(h), 172, `${h}:00`, 'xe-ms', 'middle');
        const cur = 8 + Math.floor((u / 12000) * 6);
        for (let h = 8; h < cur; h++) {
          s += R(X(h) + 3, 112, 64, 26, 'xe-iv' + (h === cur - 1 ? ' on' : ''), 5) + T(X(h) + 35, 129, `${h}–${h + 1}`, 'xe-ms', 'middle');
          s += arrow(X(h + 1), 186, X(h + 1), 158, h === cur - 1 ? 'acc' : '') ;
        }
        s += T(522, 208, `Запуск за ${cur - 1}:00–${cur}:00 стартует в ${cur}:00, когда интервал закончился.`, 'xr-s xe-acc') + T(522, 228, 'В задачу приходят data_interval_start и data_interval_end —', 'xe-ms') + T(522, 244, 'она берёт только строки своего интервала.', 'xe-ms');
        s += T(522, 272, 'catchup=True: DAG включили 14 июля, а start_date — 1 июля?', 'xe-ms') + T(522, 288, 'Планировщик создаст запуски за все пропущенные часы.', 'xe-ms');
        // состояния задачи
        s += R(24, 322, 952, 226, 'xe-panel', 10) + T(36, 342, 'ЖИЗНЬ ЗАДАЧИ: СОСТОЯНИЯ', 'xr-m');
        const ST = [['none', 'ещё не пора', 120, 398], ['scheduled', 'интервал прошёл', 290, 398], ['queued', 'ждёт воркера', 460, 398], ['running', 'выполняется', 630, 398], ['success', 'дальше по стрелке', 850, 362], ['up_for_retry', 'ждём паузу', 630, 476], ['failed', '3 попытки мимо', 850, 434], ['upstream_failed', 'упала предыдущая', 850, 494]];
        const path = [0, 1, 2, 3, 5, 3, 4, 4];
        const on = path[sti];
        ST.forEach(([n, d, x, y], j) => { const a = j === on; s += R(x - 72, y - 19, 144, 38, 'xe-stb ' + (a ? 'on' : '') + (j === 6 || j === 7 ? ' bad' : j === 4 ? ' ok' : j === 5 ? ' warn' : ''), 8) + T(x, y - 3, n, 'xe-fn', 'middle') + T(x, y + 12, d, 'xe-ms', 'middle'); });
        const edge = (a, b2, x1, y1, x2, y2) => arrow(x1, y1, x2, y2, path[sti] === b2 && path[(sti + 7) % 8] === a ? 'acc' : '');
        s += edge(0, 1, 192, 398, 218, 398) + edge(1, 2, 362, 398, 388, 398) + edge(2, 3, 532, 398, 558, 398) + edge(3, 4, 702, 390, 778, 366) + edge(3, 6, 702, 406, 778, 430);
        s += edge(3, 5, 620, 417, 620, 457) + edge(5, 3, 640, 457, 640, 417) + edge(6, 7, 850, 453, 850, 475);
        s += T(36, 536, 'Пример пути: none → scheduled → queued → running → up_for_retry → running → success. Упала все 3 раза — failed, а задачи после неё — upstream_failed.', 'xe-ms');
        return s;
      }
      function vRetry() {
        const u = S.vt % 11000;
        let s = head('Повторы и идемпотентность', 'временный сбой лечится повтором — если повтор не задваивает данные');
        s += R(24, 60, 952, 170, 'xe-panel', 10) + T(36, 80, 'ПОПЫТКИ ЗАДАЧИ extract · retries = 3 · пауза растёт: 5 → 10 мин', 'xr-m');
        const X = m => 60 + m * 30, steps = [[0, 1, 'fail', 'попытка 1', 'timeout к реплике'], [1, 6, 'wait', 'пауза 5 мин', 'up_for_retry'], [6, 7, 'fail', 'попытка 2', 'timeout'], [7, 17, 'wait', 'пауза 10 мин', 'up_for_retry'], [17, 22, 'ok', 'попытка 3', '48 210 строк · success']];
        const now = u / 9000 * 22;
        s += Ln(X(0), 150, X(29), 150, 'xe-axis');
        for (let m = 0; m <= 28; m += 2) s += T(X(m), 172, `12:${String(m).padStart(2, '0')}`, 'xe-ms', 'middle');
        let ab = 0;
        steps.forEach(([a, b2, c, t1, t2]) => {
          if (now < a) return;
          const w = (Math.min(now, b2) - a) * 30;
          s += R(X(a), 120, w, 22, 'xe-att ' + c, 4);
          if (c === 'wait') { if (now > a + 2) s += T(X(a) + w / 2, 135, `${t1} · ${t2}`, 'xe-ms xe-warn', 'middle'); return; }
          if (now > a + 0.3) { s += T(X(a), ab++ % 2 ? 104 : 112, t1, 'xr-m ' + (c === 'fail' ? 'bad' : 'ok')) + T(X(a), 196, t2, 'xe-ms' + (c === 'fail' ? ' xe-bad' : ' xe-ok')); }
        });
        s += `<polygon class="xe-cur" points="${f1(X(Math.min(now, 22)) - 6)},${108} ${f1(X(Math.min(now, 22)) + 6)},108 ${f1(X(Math.min(now, 22)))},116"/>`;
        s += T(36, 220, 'Сбой временный — повтор помогает. Если падают все 3 попытки, это ошибка в коде или данных: нужен человек.', 'xe-ms');
        // идемпотентность
        const k = clamp((u - 4000) / 4000, 0, 1);
        const box = (x, title, sub, rows, cls, msg) => { let t = R(x, 244, 466, 230, 'xe-panel ' + cls, 10) + T(x + 14, 266, title, 'xr-t') + CODE(x + 14, 288, sub, 'sm'); rows.forEach((rw, j) => { t += T(x + 14, 316 + j * 22, rw[0], 'xe-val' + (rw[1] ? ' ' + rw[1] : '')); }); return t + T(x + 14, 460, msg, 'xr-s ' + (cls === 'badb' ? 'xe-bad' : 'xe-ok')); };
        const a1 = [['raw.orders, час 11:00 — попытка 1 записала 30 000 строк и упала', ''], ['попытка 3 дописала ещё 48 210 строк', k > 0.3 ? 'warn' : ''], [k > 0.6 ? 'итого 78 210 строк: часть заказов дважды' : '…', k > 0.6 ? 'bad' : ''], [k > 0.8 ? 'выручка за час в отчёте выросла на 62 %' : '', 'bad']];
        const a2 = [['попытка 1 записала 30 000 строк в партицию hr=11 и упала', ''], ['попытка 3 перезаписала партицию hr=11 целиком', k > 0.3 ? 'on' : ''], [k > 0.6 ? 'итого 48 210 строк — ровно сколько заказов было' : '…', k > 0.6 ? 'on' : ''], [k > 0.8 ? 'можно повторять сколько угодно раз' : '', 'on']];
        s += box(24, 'Дописать (append) — опасно', 'INSERT INTO raw.orders SELECT …', a1, 'badb', 'повтор задвоил строки');
        s += box(510, 'Перезаписать свой интервал — безопасно', "INSERT OVERWRITE … PARTITION (hr = '11')", a2, 'okb', 'повтор идемпотентен');
        s += T(30, 500, 'Ещё способы: DELETE за интервал + INSERT в одной транзакции; MERGE по ключу (dbt incremental, unique_key); ReplacingMergeTree в ClickHouse.', 'xe-ms');
        s += T(30, 520, 'Алерт после последней попытки: on_failure_callback шлёт сообщение дежурному в Slack или PagerDuty.', 'xe-ms');
        return s;
      }
      function vBackfill() {
        const u = S.vt % 15000, k = clamp((u - 1500) / 11000, 0, 1), N = 8, doneN = Math.floor(k * N * 1.0001);
        let s = head('Догрузка прошлых интервалов (backfill)', 'логику выручки исправили — пересчитываем 8 прошлых часов, не задвоив ни строки');
        s += R(24, 60, 952, 70, 'xe-codebg', 10) + CODE(36, 84, 'airflow dags backfill orders_hourly -s 2026-07-14T02:00 -e 2026-07-14T10:00 --reset-dagruns', 'sm');
        s += CODE(36, 104, '# max_active_runs = 2: одновременно идут два запуска, остальные ждут в очереди', 'sm');
        s += R(24, 144, 952, 250, 'xe-panel', 10) + T(36, 166, 'СЕТКА ЗАПУСКОВ', 'xr-m');
        const ts = TASKS.elt, CX = 150, CW = 76;
        ts.forEach((t, i) => { s += T(36, 216 + i * 32, t[0], 'xe-fn'); });
        for (let j = 0; j < N; j++) {
          const x = CX + j * CW, start = j / N, fin = (j + 2) / (N + 1);
          const runK = clamp((k - start * 0.85) / 0.22, 0, 1);
          s += T(x + 26, 188, `${String(j + 2).padStart(2, '0')}:00`, 'xe-ms' + (runK > 0 && runK < 1 ? ' xe-acc' : ''), 'middle');
          ts.forEach((t, i) => { const st = runK >= (i + 1) / 5 ? 'ok' : runK > i / 5 ? 'run' : 'none'; s += R(x + 14, 200 + i * 32, 24, 24, 'xe-cell ' + st, 5); });
          if (runK > 0 && runK < 1) s += T(x + 26, 372, 'идёт', 'xe-ms xe-acc', 'middle');
          else if (runK >= 1) s += T(x + 26, 372, 'готово', 'xe-ms xe-ok', 'middle');
        }
        s += T(CX + N * CW + 10, 216, 'серое — очищено', 'xe-ms') + T(CX + N * CW + 10, 232, 'и ждёт пересчёта', 'xe-ms');
        // идемпотентность
        s += R(24, 406, 952, 142, 'xe-panel', 10) + T(36, 428, 'ПОЧЕМУ ЭТО БЕЗОПАСНО', 'xr-m');
        s += CODE(36, 452, "INSERT OVERWRITE TABLE fct_orders PARTITION (hr = '{{ data_interval_start.hour }}')", 'sm');
        s += T(36, 476, 'Каждый запуск отвечает только за свой час и перезаписывает его целиком. Пересчитали дважды — результат тот же.', 'xr-s');
        s += T(36, 498, 'Обычное расписание в это время не стоит: новые часы встают в очередь и выполняются, когда освободится слот.', 'xe-ms');
        s += T(36, 518, 'В потоке догрузка — перемотать offset группы назад и переиграть, пока Kafka хранит события; или посчитать батчем по озеру.', 'xe-ms');
        return s;
      }
      function vSla() {
        const u = S.vt % 14000, m = mode();
        let s = head('Свежесть витрины и SLA', 'важно не то, что конвейер «зелёный», а сколько лет данным на дашборде прямо сейчас');
        s += R(24, 60, 952, 300, 'xe-panel', 10) + T(36, 80, 'СВЕЖЕСТЬ ВИТРИНЫ ВО ВРЕМЕНИ: батч раз в час, поток и сбой', 'xr-m');
        const GX = 70, GY = 100, GW = 880, GH = 220, mx = 180, Y = v => GY + GH - GH * v / mx, X = h => GX + GW * h / 12;
        s += Ln(GX, GY + GH, GX + GW, GY + GH, 'xe-axis') + Ln(GX, GY, GX, GY + GH, 'xe-axis');
        [0, 60, 120, 180].forEach(v => { s += T(GX - 8, Y(v) + 4, `${v} мин`, 'xe-ms', 'end') + Ln(GX, Y(v), GX + GW, Y(v), 'xe-grid'); });
        for (let h = 0; h <= 12; h += 2) s += T(X(h), GY + GH + 18, `${String(h + 6).padStart(2, '0')}:00`, 'xe-ms', 'middle');
        s += Ln(GX, Y(120), GX + GW, Y(120), 'xe-sla dash') + T(GX + GW - 4, Y(120) - 6, 'SLA 2 ч', 'xr-m bad', 'end');
        const k = clamp(u / 11000, 0, 1), hmax = 12 * k;
        // пила батча со сбоем в 13:00 и 14:00
        const pts = [];
        for (let h = 0; h <= hmax + 1e-6; h += 0.05) {
          const hh = h + 6, fixed = hh >= 15.4;
          let v;
          if (hh < 13.4) v = ((hh % 1) + (hh % 1 < 0.4 ? 1 : 0)) * 60;   // 24 … 84 мин
          else if (!fixed) v = (hh - 12) * 60;   // запуски падают — свежесть растёт
          else v = ((hh % 1) + (hh % 1 < 0.4 ? 1 : 0)) * 60;
          pts.push(`${f1(X(h))},${f1(Y(Math.min(v, mx)))}`);
        }
        if (pts.length > 1) s += `<polyline class="xe-spark" points="${pts.join(' ')}"/>`;
        s += `<polyline class="xe-spark st" points="${f1(X(0))},${f1(Y(0.1))} ${f1(X(hmax))},${f1(Y(0.1))}"/>`;
        if (hmax > 7.4) s += T(X(7.6), Y(150), 'запуски 13:00 и 14:00 упали', 'xr-s xe-bad');
        if (hmax > 8.05) s += `<circle class="xe-alert" cx="${f1(X(8.05))}" cy="${f1(Y(121))}" r="7"/>` + T(X(8.05) + 10, Y(121) + 22, 'алерт: SLA пропущен', 'xr-m bad');
        if (hmax > 9.5) s += T(X(9.5), Y(40), 'починили — пила вернулась', 'xr-s xe-ok');
        s += T(X(0.3), Y(8), 'поток: несколько секунд, всегда у нуля', 'xe-ms xe-acc');
        s += T(X(0.3), Y(96), 'батч раз в час: пила 25…85 мин', 'xe-ms');
        // как проверять
        s += R(24, 372, 470, 176, 'xe-codebg', 10) + T(36, 392, 'dbt: проверка свежести источника', 'xr-m');
        ['sources:', '  - name: raw', '    loaded_at_field: _loaded_at', '    freshness:', '      warn_after: {count: 90, period: minute}', '      error_after: {count: 2, period: hour}'].forEach((l, j) => { s += CODE(36, 414 + j * 16, l, 'sm'); });
        s += R(510, 372, 466, 176, 'xe-panel', 10) + T(522, 392, 'ЧТО ДЕЛАТЬ ПРИ НАРУШЕНИИ', 'xr-m');
        ['· алерт дежурному (Slack, PagerDuty)', '· пометка «данные на 12:00» прямо на дашборде', '· не прятать: старые цифры без пометки хуже', '· разбор: почему упало и почему не заметили', `· сейчас в модели: ${m === 'stream' ? 'поток, SLA 60 с' : m === 'daily' ? 'ночной батч, SLA 30 ч' : 'батч раз в час, SLA 2 ч'}`].forEach((l, j) => { s += T(522, 418 + j * 22, l, 'xr-s'); });
        return s;
      }
      function vMode() {
        const u = S.vt % 10000;
        let s = head('Поток или батч', 'одни и те же события: копить и возить пачкой или обрабатывать каждое сразу');
        const lane = (x, title, on) => R(x, 60, 466, 300, 'xe-panel' + (on ? ' on' : ''), 10) + T(x + 14, 82, title, 'xr-t');
        const m = mode();
        s += lane(24, 'Батч: раз в интервал', m !== 'stream') + lane(510, 'Поток: каждое событие', m === 'stream');
        // батч
        const fill = (u % 5000) / 5000, flush = (u % 5000) > 4300;
        s += R(60, 120, 120, 150, 'xe-bucket', 8) + R(62, 268 - 146 * (flush ? 0 : fill), 116, 146 * (flush ? 0 : fill), 'xe-fill', 6) + T(120, 290, 'копится за час', 'xe-ms', 'middle');
        for (let j = 0; j < 5; j++) { const k = ((u / 900) + j / 5) % 1; s += Dot(30 + 30 * k, 100 + j * 30, 4, '', `fill:${SD.kindColor('write')}`); }
        if (flush) { const k = ((u % 5000) - 4300) / 700; s += R(200 + 200 * ease(k), 180, 40, 40, 'xe-batch', 6) + T(220 + 200 * ease(k), 206, '48k', 'xe-ms', 'middle'); }
        s += R(420, 150, 64, 90, 'xe-art on', 8) + T(452, 200, 'DWH', 'xe-fn', 'middle');
        s += T(40, 322, 'свежесть: от 25 до 85 минут (пила)', 'xr-s') + T(40, 342, 'перезапустить интервал — легко', 'xe-ms');
        // поток
        for (let j = 0; j < 8; j++) { const k = ((u / 1600) + j / 8) % 1; s += Dot(540 + 400 * k, 190 + Math.sin(j) * 8, 4, '', `fill:${SD.kindColor('write')}`); }
        s += R(640, 160, 110, 60, 'xe-task run', 8) + T(695, 186, 'Flink', 'xe-fn', 'middle') + T(695, 204, 'состояние', 'xe-ms', 'middle');
        s += R(900, 150, 64, 90, 'xe-art on', 8) + T(932, 200, 'DWH', 'xe-fn', 'middle');
        s += T(526, 322, 'свежесть: 1–10 секунд', 'xr-s') + T(526, 342, 'опоздавшие события, чекпойнты, состояние', 'xe-ms');
        // цена и сложность
        s += R(24, 372, 952, 176, 'xe-panel', 10) + T(36, 394, 'ЦЕНА И СЛОЖНОСТЬ (как в каталоге площадки)', 'xr-m');
        const rows = [['Свежесть', '25–85 мин (раз в час) · до 30 ч (ночью)', '1–10 с'], ['Цена', '≈ $180 в месяц: воркеры минуты в час', '≈ $450 в месяц: кластер 24/7'], ['Повторить расчёт', 'перезапуск интервала', 'перемотка offset, состояние'], ['Сложности', 'отчёты отстают на интервал', 'опоздавшие события, exactly-once']];
        s += T(220, 418, 'батч', 'xe-fn') + T(620, 418, 'поток', 'xe-fn');
        rows.forEach(([a, b2, c], j) => { const y = 442 + j * 24; s += T(36, y, a, 'xr-s') + T(220, y, b2, 'xr-s' + (m !== 'stream' ? ' xe-acc' : '')) + T(620, y, c, 'xr-s' + (m === 'stream' ? ' xe-acc' : '')); });
        s += T(36, 540, 'Часто совмещают: поток для живых дашбордов, ночной батч для точных итогов.', 'xe-ms');
        return s;
      }
      function vElt() {
        const u = S.vt % 9000, k = clamp(u / 7000, 0, 1), e = elt();
        let s = head('ETL или ELT: где преобразуем', e ? 'сейчас ELT: грузим сырьё, считаем SQL-моделями внутри хранилища' : 'сейчас ETL: считаем в конвейере, в хранилище кладём готовое');
        const lane = (y, title, steps, split, on) => {
          let t = R(24, y, 952, 150, 'xe-panel' + (on ? ' on' : ''), 10) + T(36, y + 22, title, 'xr-t');
          t += R(24 + split, y + 32, 952 - split - 6, 112, 'xe-half dwh', 8) + T(970, y + 140, 'хранилище', 'xe-zl', 'end');
          steps.forEach(([a, b2], i) => { const x = 40 + i * 230, act = k * 4 > i; t += R(x, y + 52, 200, 56, 'xe-task ' + (act ? 'ok' : 'none'), 8) + T(x + 10, y + 74, a, 'xe-fn') + T(x + 10, y + 92, b2, 'xe-ms'); if (i < 3) t += arrow(x + 202, y + 80, x + 228, y + 80, act ? 'ok' : ''); });
          return t;
        };
        s += lane(60, 'ETL: Extract → Transform → Load', [['extract', '5 строк из orders'], ['transform (Spark)', 'чистка, суммы — в памяти'], ['load', 'в хранилище — итог'], ['витрина', 'только суммы']], 2 * 230 + 20, !e);
        s += lane(222, 'ELT: Extract → Load → Transform', [['extract', '5 строк из orders'], ['load', 'сырьё как есть: raw.orders'], ['transform (dbt SQL)', 'внутри хранилища'], ['витрина', 'сырьё тоже лежит']], 230 + 20, e);
        s += R(24, 384, 470, 164, 'xe-codebg' + (!e ? ' on' : ''), 10) + T(36, 404, 'ETL · PySpark в конвейере', 'xr-m');
        ['clean = df.filter("status != \'test\'")', '           .dropDuplicates(["order_id"])', 'mart = clean.groupBy("country")', '            .agg(sum("amount").alias("revenue"))', 'mart.write.jdbc(clickhouse_url, "mart_revenue")'].forEach((l, j) => { s += CODE(36, 426 + j * 16, l, 'sm'); });
        s += T(36, 540, 'поменять логику — перезагрузить из источника', 'xe-ms');
        s += R(510, 384, 466, 164, 'xe-codebg' + (e ? ' on' : ''), 10) + T(522, 404, 'ELT · models/marts/mart_revenue.sql (dbt)', 'xr-m');
        ["select country, sum(amount) as revenue", "from {{ ref('fct_orders') }}", "where status != 'test'", 'group by country', '-- поменять логику: dbt run — пересчёт из raw'].forEach((l, j) => { s += CODE(522, 426 + j * 16, l, 'sm'); });
        s += T(522, 540, 'на площадке ELT нагружает аналитическую БД (+50 %)', 'xe-ms');
        return s;
      }
      function vCdc() {
        const u = S.vt % 14000;
        let s = head('CDC: журнал базы → Debezium → Kafka → хранилище', 'не выгружаем таблицу каждый час, а повторяем у себя каждое изменение из журнала');
        s += R(24, 60, 300, 260, 'xe-codebg', 10) + T(36, 80, 'ЖУРНАЛ WAL (PostgreSQL)', 'xr-m');
        const WAL = [['0/1A3F2B8', "INSERT orders (10482941, 'new', 2490.00)"], ['0/1A3F310', "UPDATE orders SET status='paid' WHERE 10482931"], ['0/1A3F3A0', 'DELETE FROM orders WHERE 10471002'], ['0/1A3F428', "UPDATE orders SET status='refunded' …"], ['0/1A3F4B0', "INSERT orders (10482942, 'new', 990.00)"]];
        const cur = Math.floor(u / 2200) % 5;
        WAL.forEach(([l, t], j) => { const y = 106 + j * 40; if (j === cur) s += R(30, y - 16, 288, 36, 'xe-krow', 4); s += MONO(36, y, l, j === cur ? 'on' : '') + T(36, y + 15, ES(cut(t, 44)), 'xe-ms'); });
        s += T(36, 312, 'LSN — номер места в журнале', 'xe-ms');
        // путь
        const X = [370, 540, 710], NM = [['Debezium', 'слот debezium_orders'], ['Kafka', 'pg.public.orders · 3 партиции'], ['загрузчик', 'upsert в ClickHouse']];
        NM.forEach(([a, b2], i) => { s += R(X[i], 120, 150, 70, 'xe-task run', 8) + T(X[i] + 10, 146, a, 'xe-fn') + T(X[i] + 10, 166, ES(cut(b2, 22)), 'xe-ms'); if (i < 2) s += arrow(X[i] + 152, 155, X[i + 1] - 2, 155, ''); });
        s += arrow(324, 155, 368, 155, '');
        s += R(880, 120, 96, 70, 'xe-art on', 8) + T(890, 146, 'ClickHouse', 'xe-fn') + T(890, 166, 'orders', 'xe-ms'); s += arrow(862, 155, 878, 155, '');
        const k = (u % 2200) / 2200, op = ['c', 'u', 'd', 'u', 'c'][cur];
        s += `<circle class="xr-dot" cx="${f1(330 + 600 * ease(k))}" cy="155" r="6" style="fill:${op === 'd' ? 'var(--bad)' : SD.kindColor('write')}"/>` + T(330 + 600 * ease(k), 144, op, 'xe-dl', 'middle');
        // сообщение
        s += R(340, 204, 636, 116, 'xe-codebg', 10) + T(352, 222, 'СООБЩЕНИЕ В KAFKA (ключ: order_id)', 'xr-m');
        const msg = op === 'c' ? ['{"op": "c", "before": null,', ' "after": {"order_id": 10482941, "status": "new", "amount": 2490.00},', ' "source": {"lsn": 27525816, "table": "orders"}}'] : op === 'u' ? ['{"op": "u", "before": {"order_id": 10482931, "status": "new"},', ' "after": {"order_id": 10482931, "status": "paid", "amount": 1290.00},', ' "source": {"lsn": 27525904, "table": "orders"}}'] : ['{"op": "d", "before": {"order_id": 10471002, "status": "cancelled"},', ' "after": null,', ' "source": {"lsn": 27526048, "table": "orders"}}'];
        msg.forEach((l, j) => { s += CODE(352, 244 + j * 18, l, 'sm'); });
        // этапы и опасности
        s += R(24, 334, 952, 214, 'xe-panel', 10) + T(36, 356, 'КАК ЭТО ЖИВЁТ', 'xr-m');
        const L2 = [['1. Снимок', 'первый запуск читает всю таблицу (12 млн строк, op = r), запомнив LSN начала'], ['2. Поток', 'дальше — только изменения из журнала, с того LSN: c, u, d'], ['3. Загрузка', 'upsert по order_id: ReplacingMergeTree по версии lsn, удаление — флаг is_deleted'], ['4. Порядок', 'ключ сообщения — order_id: изменения одного заказа в одной партиции, по порядку'], ['5. Опасность', 'коннектор встал — слот держит WAL, диск боевой базы заполняется. Мониторить отставание слота'], ['6. Схема', 'ALTER TABLE в базе меняет сообщения: переименование ломает потребителей — только ADD, потом DROP']];
        L2.forEach(([a, b2], j) => { s += T(36, 382 + j * 26, a, 'xr-m' + (j === 4 ? ' bad' : j === 5 ? ' warn' : '')) + T(150, 382 + j * 26, b2, 'xr-s'); });
        return s;
      }
      function vTests() {
        const u = S.vt % 12000, ix = Math.floor(clamp((u - 500) / 1100, 0, 7));
        if (ix >= 3) S.pv.testFail = 1;
        let s = head('Тесты данных перед публикацией', 'кривые данные не должны попасть в витрину — лучше показать вчерашние, но верные цифры');
        s += R(24, 60, 560, 300, 'xe-panel', 10) + T(36, 80, 'dbt test · модель fct_orders · час 11:00–12:00', 'xr-m');
        const TS = [['unique', 'order_id', 'ok', '0 повторов'], ['not_null', 'order_id, amount', 'ok', '0 пустых'], ['accepted_values', 'country ∈ {RU, KZ, BY, UZ, AM, GE}', 'fail', '12 строк с country = XX'], ['relationships', 'user_id → dim_user', 'ok', 'все покупатели есть'], ['row_count', '≥ 70 % от часа неделю назад', 'ok', '48 210 против 45 980'], ['freshness', 'max(updated_at) ≥ 11:55', 'ok', '11:59:58']];
        TS.forEach(([n, d, r, res], j) => {
          const y = 108 + j * 36, st = j < ix ? r : j === ix ? 'run' : 'none';
          s += R(36, y - 18, 536, 30, 'xe-trow ' + st, 6) + T(48, y + 2, n, 'xe-fn') + T(184, y + 2, ES(d), 'xe-ms') + T(560, y + 2, st === 'run' ? 'проверяем…' : st === 'none' ? '' : (r === 'ok' ? '✓ ' : '✕ ') + res, 'xr-s ' + (st === 'ok' ? 'xe-ok' : st === 'fail' ? 'xe-bad' : 'xe-acc'), 'end');
        });
        s += T(36, 340, ix >= 3 ? 'Итог: 1 тест упал — задача dbt_test failed, publish не запускается (upstream_failed).' : 'Тесты идут по очереди…', 'xr-s' + (ix >= 3 ? ' xe-bad' : ''));
        // строки, которые сломали тест
        s += R(600, 60, 376, 300, 'xe-codebg', 10) + T(612, 80, 'КАКИЕ СТРОКИ СЛОМАЛИ ТЕСТ', 'xr-m');
        s += CODE(612, 104, 'select order_id, country, amount', 'sm') + CODE(612, 120, "from fct_orders where country not in", 'sm') + CODE(612, 136, "  ('RU','KZ','BY','UZ','AM','GE')", 'sm');
        if (ix >= 3) [['10482977', 'XX', '1290.00'], ['10482981', 'XX', '845.50'], ['10483002', 'XX', '199.00'], ['… ещё 9', '', '']].forEach((r, j) => { s += T(612, 168 + j * 22, r[0], 'xe-val') + T(720, 168 + j * 22, r[1], 'xe-val bad') + T(800, 168 + j * 22, r[2], 'xe-val'); });
        if (ix >= 3) s += T(612, 270, 'причина: новый склад шлёт код страны XX', 'xe-ms') + T(612, 286, 'для «не знаю» — починить маппинг в stg_orders', 'xe-ms');
        // публикация
        s += R(24, 372, 952, 176, 'xe-panel ' + (ix >= 3 ? 'badb' : ''), 10) + T(36, 394, 'ПУБЛИКАЦИЯ ВИТРИНЫ', 'xr-m');
        s += R(60, 414, 260, 60, 'xe-art on', 8) + T(72, 438, 'mart_revenue', 'xe-fn') + T(72, 458, 'видит дашборд · данные по 11:00', 'xe-ms');
        s += R(420, 414, 260, 60, 'xe-art' + (ix >= 3 ? ' bad' : ''), 8) + T(432, 438, 'mart_revenue_new', 'xe-fn') + T(432, 458, ix >= 3 ? 'не прошла тесты — ждёт' : 'готовится рядом', 'xe-ms' + (ix >= 3 ? ' xe-bad' : ''));
        s += arrow(678, 444, 324, 444, ix >= 3 ? 'bad' : '') + T(500, 404, ix >= 3 ? 'EXCHANGE TABLES заблокирован' : 'EXCHANGE TABLES после тестов', 'xr-s' + (ix >= 3 ? ' xe-bad' : ''), 'middle');
        s += T(36, 500, 'Подмена атомарная: дашборд видит или старую витрину целиком, или новую целиком — никогда полупустую.', 'xr-s');
        s += T(36, 522, 'Упавший тест — алерт команде данных. На дашборде честно: «данные на 11:00, следующее обновление задерживается».', 'xe-ms');
        return s;
      }
      const VIEWS = { dag: vDag, retry: vRetry, backfill: vBackfill, sla: vSla, mode: vMode, elt: vElt, cdc: vCdc, tests: vTests };
      function partNow(k) {
        if (k === 'dag') return '<b>DAG</b> — задачи и стрелки. Планировщик создаёт запуск на каждый интервал: за 11:00–12:00 — в 12:00. Задача видит границы интервала и берёт только свои строки. Следующая стартует, только когда успешна предыдущая.';
        if (k === 'retry') return '<b>Повторы</b> лечат временные сбои: пауза 5, потом 10 минут. Но повтор безопасен только если задача перезаписывает свой интервал — дописывание задвоит строки, и выручка «вырастет» на ровном месте.';
        if (k === 'backfill') return '<b>Догрузка:</b> каждый прошлый интервал пересчитывается отдельным запуском, по два одновременно. Каждый перезаписывает свою партицию — пересчитай хоть десять раз, строк не прибавится.';
        if (k === 'sla') return `<b>Свежесть сейчас — ${dur(fresh())}</b>, обещание (SLA) — ${dur(SLA())}. У батча свежесть — пила, у потока — секунды. Сбой виден как горб, который пересекает черту SLA: в этот момент приходит алерт.`;
        if (k === 'mode') return mode() === 'stream' ? '<b>Сейчас поток:</b> свежесть в секундах, но кластер работает круглосуточно (≈ $450 в месяц), а опоздавшие события и чекпойнты — новая сложность.' : '<b>Сейчас батч:</b> дешевле (≈ $180 в месяц) и проще повторить, но отчёт отстаёт на интервал запуска.';
        if (k === 'elt') return elt() ? '<b>Сейчас ELT:</b> сырьё грузится как есть, а считают SQL-модели dbt внутри хранилища. Логику легко поменять и пересчитать из raw; плата — нагрузка на хранилище.' : '<b>Сейчас ETL:</b> Spark считает в конвейере, в хранилище попадает только итог. Хранилище разгружено, но поменять логику — значит перегружать из источника.';
        if (k === 'cdc') return '<b>CDC</b> повторяет у себя каждое изменение из журнала базы: сначала полный снимок, потом c, u, d по порядку LSN. Ничего не выгружаем целиком и не грузим боевую базу тяжёлыми SELECT.';
        if (k === 'tests') return '<b>Тесты перед публикацией:</b> один упал — новая витрина не подменяет старую. Дашборд показывает прошлые, но проверенные цифры, а команда получает алерт с конкретными строками.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (S.wall == null) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'tests' && S.pv.testFail) done('ptests'); }
        S.wall += dt / 1000 * rate();
        if (isCdc()) cdcStep(dt); else if (isStream()) streamStep(dt); else batchStep();
        if (S.t >= S.fhAt) { S.fhAt = S.t + 250; S.fh.push({ v: fresh() }); if (S.fh.length > 60) S.fh.shift(); }
        const fr = fresh(), sla = SLA();
        if (fr > sla && !S.slaT) { S.slaT = S.t; note('sla', `<b>SLA пропущен:</b> данным в витрине уже больше ${dur(sla)} — столько обещали максимум. Дежурному ушёл алерт, на дашборде — пометка «данные устарели».`, 'bad', 0); }
        if (fr <= sla) S.slaT = null;
        if (mode() !== 'stream') S.seenBatch = 1;
        if (mode() === 'stream' && S.seenBatch && S.cfgT > 2500 && !isCdc()) done('stream');
      }
      function draw() {
        if (S.wall == null) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { if (cfgSig() !== S.cfg) { const dn = S.dn; reset(); S.dn = dn; } },
        scenario(id) { S.scn = id; reset(); },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (cfgSig() !== S.cfg) reset();
          if (key === 'approach') { done('elt'); return v === 'etl' ? 'ETL: задача transform переехала влево — в конвейер (Spark). В хранилище теперь грузится только итог.' : 'ELT: сначала грузим сырьё (load_raw), а dbt_run считает уже внутри хранилища — граница сдвинулась.'; }
          if (key === 'mode') return v === 'stream' ? 'Поток: вместо графа задач — задание Flink, свежесть витрины падает до секунд. Смотри цену слева внизу.' : v === 'daily' ? 'Ночной батч: один запуск в 02:00 за вчерашний день. Свежесть утром — пара часов, к вечеру — почти сутки.' : 'Батч раз в час: запуск за прошедший час стартует в начале следующего. Свежесть — пила от ≈ 25 до ≈ 85 минут.';
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const fr = fresh(), sla = SLA();
          if (S.scn === 'cdc') { const c = S.cd; return c.ph === 'snap' ? `<b>Полный снимок таблицы:</b> Debezium читает все 12 млн строк orders и отправляет их как сообщения op = r (${nf(c.snap / 1e6, 1)} млн готово). LSN начала запомнен — изменения, случившиеся во время снимка, придут следом.` : '<b>Поток изменений:</b> каждая вставка (c), правка (u) и удаление (d) в боевой базе через доли секунды становится сообщением в Kafka и строкой в ClickHouse. Таблица снизу — последние сообщения, справа — одно целиком: before, after, LSN.'; }
          if (S.scn === 'schema') { const c = S.cd; return !c.ev ? '<b>CDC работает спокойно.</b> Скоро разработчики переименуют колонку в боевой базе — следи за коннектором и за слотом WAL слева.' : c.failed ? `<b>Коннектор стоит, а журнал копится.</b> Слот репликации не даёт PostgreSQL удалять WAL, пока Debezium не подтвердит чтение: уже ${nf(c.wal, 1)} ГБ. Если не починить, закончится диск боевой базы — и упадут продажи, а не отчёты.` : c.fixed ? '<b>Починили и догоняем:</b> коннектор перечитывает накопленный журнал, отставание падает, слот отпускает WAL. Урок: в базе с CDC колонки не переименовывают, а добавляют новые и удаляют старые позже.' : '<b>Debezium прочитал DDL</b> и пытается зарегистрировать новую схему сообщений…'; }
          if (isStream()) { const f = S.fl; return f.crash ? (f.crash.ph === 'down' ? `<b>Задание упало</b> и восстанавливается из чекпойнта #${f.crash.ck}: состояние и позиции чтения откатываются к нему. Отставание растёт — витрина на это время замирает.` : '<b>Задание поднялось</b> и перечитывает сообщения после чекпойнта на повышенной скорости. Дублей нет: запись в ClickHouse коммитится вместе с чекпойнтом.') : f.replay ? `<b>Переигрываем историю:</b> offset группы перемотан на 1 июля, задание пересчитывает 13 дней событий на полной скорости. Осталось ${dur(f.replay.left)}.` : `<b>Поток:</b> каждое событие проходит Flink за секунды, витрина отстаёт на ${dur(fr)}. Барьер чекпойнта (вертикальная черта) раз в 30 с проходит по заданию и сохраняет состояние. Цена — кластер круглосуточно.`; }
          const r = curRun(), run = r.tasks.findIndex(t => t.st === 'running' || t.st === 'retry'), id = run >= 0 ? tasks()[run][0] : '';
          if (S.scn === 'fail') {
            const f = S.runs.find(x => x.st === 'failed');
            if (f) return `<b>Запуск за ${hm(f.ivs)}–${hm(f.ive)} упал:</b> ${tasks()[f.failIdx][0]} не прошла три попытки — это ошибка в логике, а не сбой. Задачи после неё не запускались (upstream_failed), витрина устаревает: ${dur(fr)}${fr > sla ? ' — SLA уже нарушен' : ''}. Скоро инженер починит модель и нажмёт Clear.`;
            if (run >= 0 && r.tasks[run].st === 'retry') return `<b>${id} упал и ждёт повтора</b> (up_for_retry): пауза растёт — 5, потом 10 минут, чтобы не добивать лежащий источник. Повтор безопасен: задача перезаписывает свой интервал.`;
          }
          if (S.scn === 'backfill') return `<b>Догрузка:</b> 8 прошлых интервалов пересчитываются заново, по два запуска одновременно (max_active_runs = 2) — смотри сетку снизу. Каждый перезаписывает свою партицию, поэтому строки не задвоятся. Готово ${S.bfDone || 0} из ${S.bfN}.`;
          const where = elt() ? 'ELT: сырьё грузится в хранилище, а считает dbt внутри ClickHouse' : 'ETL: Spark считает в конвейере, в хранилище попадает итог';
          return run >= 0 ? `<b>Идёт запуск за ${mode() === 'daily' ? dshort(r.ivs) : hm(r.ivs) + '–' + hm(r.ive)}:</b> сейчас ${id}. Задачи идут по стрелкам, каждая начинается после успеха предыдущей. ${where}. Справа внизу — код задачи и её лог.` : `<b>Конвейер ждёт следующего запуска</b> в ${hm(S.next)}. Витрина отстаёт на ${dur(fr)} — для батча это норма: свежесть растёт до следующей загрузки. ${where}.`;
        },
        stats() {
          const fr = fresh(), sla = SLA();
          const out = [['Свежесть витрины', dur(fr), fr > sla ? 'bad' : fr > sla * 0.75 ? 'warn' : 'ok', `SLA ${dur(sla)}`]];
          if (isCdc()) { const c = S.cd; out.push(['Сообщений', nf(c.off), '', 'offset в топике'], ['WAL у слота', `${nf(c.wal, 1)} ГБ`, c.wal > 2 ? 'bad' : c.wal > 1 ? 'warn' : 'ok', 'держит журнал на диске базы'], ['Отставание', dur(c.lag || 0.3), (c.lag || 0) > 30 ? 'bad' : 'ok', 'от изменения до хранилища'], ['Этап', c.ph === 'snap' ? 'снимок' : c.failed ? 'стоит' : 'поток', c.failed ? 'bad' : '', c.ph === 'snap' ? `${nf(c.snap / 1e6, 1)} из 12 млн` : 'c / u / d']); return out; }
          if (isStream()) { const f = S.fl; out.push(['Отставание', dur(f.lag), f.lag > 60 ? 'bad' : f.lag > 5 ? 'warn' : 'ok', 'consumer lag'], ['Чекпойнт', '#' + f.ck, '', 'раз в 30 с'], ['Цена', '$450/мес', 'warn', 'кластер 24/7'], ['Сбоев', f.ev && S.scn === 'fail' ? '1' : '0', f.crash ? 'bad' : '', 'восстановление с чекпойнта']); return out; }
          const runs = S.runs.slice(-10), ok = runs.filter(r => r.st === 'success').length, failed = runs.filter(r => r.st === 'failed').length;
          const tries = S.runs.reduce((s2, r) => s2 + r.tasks.filter(t => t.tr > 1).length, 0);
          out.push(['Запусков успешно', `${ok} из ${runs.length}`, failed ? 'bad' : 'ok', 'последние 10 интервалов'], ['Повторов', String(tries), tries ? 'warn' : '', 'задач со 2-й попытки и позже'], ['Строк за запуск', nf(S.lastRows || ROWS_H * (mode() === 'daily' ? 24 : 1)), '', mode() === 'daily' ? 'за сутки' : 'за час']);
          out.push(S.scn === 'backfill' ? ['Догружено', `${S.bfDone || 0} из ${S.bfN}`, (S.bfDone || 0) >= S.bfN ? 'ok' : 'warn', 'по два запуска одновременно'] : ['Цена', '$180/мес', 'ok', 'воркеры минуты в час']);
          return out;
        },
        destroy() {}
      };
    }
  };
})();
