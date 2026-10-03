/* Разборы: базы данных, гео, аналитика и инженерия данных. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const D = SD.DIVES;

  D.indexes = {
    title: 'Индексы: от seq scan до покрывающего', icon: 'sql', lede: 'B-tree, составной, покрывающий, частичный, GIN, GiST, BRIN — что ускоряют и чем платим.',
    actors: [
      { id: 'q', x: 20, y: 40, w: 150, label: 'Запрос', sub: 'мои заказы, 20 новых' },
      { id: 'idx', x: 230, y: 40, w: 190, label: 'Индекс' },
      { id: 'heap', x: 480, y: 40, w: 140, label: 'Таблица', sub: '40 млн строк' },
      { id: 'plan', x: 230, y: 230, w: 390, label: 'EXPLAIN ANALYZE' }
    ],
    code: [
      { label: 'SQL · PostgreSQL', lang: 'sql', src: `
-- Без индекса: Seq Scan по 40 млн строк
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20;

-- B-tree по user_id: найдёт строки, но отсортирует сам
CREATE INDEX ON orders (user_id);

-- Составной: равенство, потом диапазон — порядок уже готов
CREATE INDEX ON orders (user_id, created_at DESC);

-- Покрывающий: всё нужное в индексе → Index Only Scan
CREATE INDEX ON orders (user_id, created_at DESC) INCLUDE (total, status);

-- Частичный: только активные
CREATE INDEX ON orders (user_id) WHERE status = 'active';

-- Полнотекстовый поиск и гео
CREATE INDEX ON products USING GIN (to_tsvector('russian', title));
CREATE INDEX ON drivers USING GIST (location);

-- Огромная таблица событий по времени
CREATE INDEX ON events USING BRIN (created_at);` }
    ],
    steps: [
      { title: 'Seq Scan', text: 'Без подходящего индекса база читает всю таблицу и проверяет каждую строку. На 40 млн строк это секунды на запрос.', bad: ['heap'], msgs: [{ from: 'q', to: 'heap', label: 'читаю всё', color: 'bad' }], lines: { plan: ['Seq Scan on orders', 'rows = 40 000 000 · 2 300 мс'] }, c: [1, 2] },
      { title: 'B-tree', text: 'Сбалансированное дерево: поиск занимает 3–4 чтения страниц даже на миллиардах строк. Строки пользователя найдены, но сортировку по дате база делает сама.', msgs: [{ from: 'q', to: 'idx', label: 'user_id = 42' }, { from: 'idx', to: 'heap', label: '1 200 строк' }], lines: { idx: ['корень → ветка → лист', '3–4 страницы'], plan: ['Index Scan + Sort', 'rows = 1 200 · 12 мс'] }, c: [4, 5] },
      { title: 'Составной индекс', text: 'Сначала колонка равенства, потом диапазон или сортировка. Индекс отдаёт ровно 20 нужных строк уже в правильном порядке. Индекс (created_at, user_id) этому запросу почти не помог бы.', good: ['idx'], lines: { idx: ['(user_id, created_at DESC)', 'порядок уже готов'], plan: ['Index Scan · LIMIT 20', 'rows = 20 · 0,4 мс'] }, c: [7, 8] },
      { title: 'Покрывающий индекс', text: 'INCLUDE кладёт в индекс колонки, которые запрос возвращает. Базе не нужно ходить в таблицу: Index Only Scan.', dim: ['heap'], lines: { plan: ['Index Only Scan', 'в таблицу не ходим · 0,2 мс'] }, c: [10, 11] },
      { title: 'Цена индексов', text: 'Каждый индекс обновляется при каждом INSERT и UPDATE и занимает память. Если индексы не помещаются в RAM, они читаются с диска и всё замедляется. Неиспользуемые ищут в pg_stat_user_indexes, где idx_scan = 0.', badge: { idx: '+ к записи' }, bad: ['idx'] },
      { title: 'Особые индексы', text: 'GIN — обратный индекс для полнотекстового поиска и JSONB. GiST — R-дерево для гео и диапазонов. BRIN — крошечный индекс по блокам для таблиц, куда пишут по времени. Hash — только равенство. Частичный индексирует нужное подмножество строк.', c: [13, 14, 16, 17, 18, 20, 21] }
    ]
  };

  D.polyglot = {
    title: 'Какие бывают базы данных', icon: 'nosql', lede: 'Реляционные, документные, ключ-значение, wide-column, графовые, временные ряды, колоночные, поиск и векторы.',
    actors: [
      { id: 'sql', x: 20, y: 40, w: 140, label: 'PostgreSQL', sub: 'реляционная' },
      { id: 'doc', x: 175, y: 40, w: 140, label: 'MongoDB', sub: 'документная' },
      { id: 'kv', x: 330, y: 40, w: 140, label: 'Redis, DynamoDB', sub: 'ключ-значение' },
      { id: 'wide', x: 485, y: 40, w: 140, label: 'Cassandra', sub: 'wide-column' },
      { id: 'graph', x: 20, y: 200, w: 140, label: 'Neo4j', sub: 'графовая' },
      { id: 'ts', x: 175, y: 200, w: 140, label: 'TimescaleDB', sub: 'временные ряды' },
      { id: 'olap', x: 330, y: 200, w: 140, label: 'ClickHouse', sub: 'колоночная' },
      { id: 'vec', x: 485, y: 200, w: 140, label: 'Elastic, Qdrant', sub: 'поиск и векторы' }
    ],
    code: [
      { label: 'SQL', lang: 'sql', src: `
SELECT o.id, sum(i.price) FROM orders o
JOIN items i ON i.order_id = o.id
WHERE o.user_id = 42 GROUP BY o.id;` },
      { label: 'MongoDB', lang: 'js', src: `
db.orders.insertOne({ _id: 777, user: { id: 42, name: "Анна" },
  items: [{ sku: "A1", price: 990 }] });          // заказ целиком в одном документе
db.orders.find({ "user.id": 42 }).sort({ _id: -1 });` },
      { label: 'Cassandra', lang: 'sql', src: `
CREATE TABLE messages_by_chat (
  chat_id bigint, ts timeuuid, author bigint, text text,
  PRIMARY KEY ((chat_id), ts)            -- партиция = чат, сортировка по времени
) WITH CLUSTERING ORDER BY (ts DESC);` },
      { label: 'Neo4j', lang: 'sql', src: `
MATCH (me:User {id: 42})-[:FRIEND]->()-[:FRIEND]->(fof)
WHERE NOT (me)-[:FRIEND]->(fof) AND fof <> me
RETURN fof.name, count(*) AS mutual ORDER BY mutual DESC LIMIT 10;` }
    ],
    steps: [
      { title: 'Реляционная', text: 'Таблицы, связи, JOIN, транзакции ACID. Выбор по умолчанию для деловых данных: заказы, деньги, пользователи. Масштабируется репликами и шардами.', hl: ['sql'], c: { 0: [1, 2, 3] } },
      { title: 'Документная', text: 'Заказ со строками и адресом хранится одним документом и читается одним запросом. Гибкая схема и вторичные индексы. Транзакции между документами дороже.', hl: ['doc'], c: { 1: [1, 2, 3] } },
      { title: 'Ключ-значение', text: 'Самые быстрые операции по ключу: сессии, корзины, счётчики, кэш. Запросов «найди по значению» нет — нужна отдельная таблица под каждый запрос.', hl: ['kv'] },
      { title: 'Wide-column', text: 'Огромный поток записей и чтение по ключу партиции: сообщения, события, логи. Таблицу проектируют под конкретный запрос, данные дублируют под разные запросы.', hl: ['wide'], c: { 2: [1, 2, 3, 4] } },
      { title: 'Графовая', text: 'Связи — главное: друзья друзей, антифрод, рекомендации. Обход на три уровня — миллисекунды, тогда как в SQL это рекурсивный JOIN.', hl: ['graph'], c: { 3: [1, 2, 3] } },
      { title: 'Временные ряды', text: 'Метрики серверов, датчики, котировки: только дописывание и запросы по интервалам времени. Сжатие в 10–20 раз, ретеншн и даунсэмплинг из коробки.', hl: ['ts'] },
      { title: 'Колоночная', text: 'Агрегаты по миллиардам строк: отчёты, дашборды, продуктовая аналитика. Плохо переносит точечные изменения и мелкие вставки.', hl: ['olap'] },
      { title: 'Поиск и векторы', text: 'Поисковый движок ищет по словам, векторная база — по смыслу (для RAG). Обычно это вторая копия данных рядом с основной базой.', hl: ['vec'] },
      { title: 'Polyglot persistence', text: 'В живой системе баз несколько: каждая задача хранится там, где ей удобнее. Цена — синхронизация копий через события и больше эксплуатации. Начинают с одной PostgreSQL и добавляют базу, когда есть конкретная боль.', good: ['sql'] }
    ]
  };

  D.geo = {
    title: 'Гео-поиск: geohash, Redis GEO, PostGIS, H3', icon: 'cache', lede: 'Как быстро найти машины в радиусе двух километров.',
    actors: [
      { id: 'map', x: 20, y: 30, w: 270, label: 'Карта', sub: 'geohash-клетки' },
      { id: 'redis', x: 380, y: 30, w: 240, label: 'Redis GEO', sub: 'позиции машин' },
      { id: 'pg', x: 380, y: 220, w: 240, label: 'PostGIS', sub: 'зоны и маршруты' },
      { id: 'u', x: 20, y: 240, w: 180, label: 'Пассажир' }
    ],
    code: [
      { label: 'Redis', lang: 'text', src: `
GEOADD drivers 37.6176 55.7558 driver:17        ← позиция каждые 3 секунды
GEOSEARCH drivers FROMLONLAT 37.62 55.75 BYRADIUS 2 km ASC COUNT 10 WITHDIST` },
      { label: 'PostGIS', lang: 'sql', src: `
CREATE INDEX ON zones USING GIST (area);
SELECT name FROM zones
WHERE ST_Contains(area, ST_SetSRID(ST_Point(37.62, 55.75), 4326));   -- в какой зоне точка

SELECT id FROM drivers
WHERE ST_DWithin(location::geography, ST_Point(37.62, 55.75)::geography, 2000);` },
      { label: 'H3', lang: 'python', src: `
import h3
cell = h3.latlng_to_cell(55.75, 37.62, 9)       # шестиугольник ≈ 0,1 км²
near = h3.grid_disk(cell, 2)                    # клетка + 2 кольца соседей
# ключ партиции = клетка: «водители в клетке» — одно чтение` }
    ],
    steps: [
      { title: 'Перебор не работает', text: 'Найти машины рядом перебором — 90 000 расчётов расстояния на каждый запрос, а запросов тысячи в секунду. Нужен пространственный индекс.', bad: ['u'], msgs: [{ from: 'u', to: 'map', label: 'кто в 2 км?' }] },
      { title: 'Geohash', text: 'Geohash кодирует координаты в строку: чем длиннее общий префикс, тем ближе точки. Поиск рядом превращается в несколько диапазонов ключей — то, что базы делают быстро.', hl: ['map'], lines: { map: ['ucfv0 ucfv1 ucfv2', 'ucfuz ucfv3 ucfv6', 'соседи = общий префикс'] } },
      { title: 'Redis GEO', text: 'Позиции лежат в sorted set по geohash. Обновление позиции — одна команда, поиск в радиусе — миллисекунды. Идеально для быстро меняющихся координат.', good: ['redis'], msgs: [{ from: 'u', to: 'redis', label: 'GEOSEARCH 2 km' }, { from: 'redis', to: 'u', label: '10 машин · 2 мс', color: 'ok', lane: 1 }], c: { 0: [1, 2] } },
      { title: 'PostGIS', text: 'PostGIS с GiST-индексом (R-дерево) хорош для полигонов, зон тарифов, маршрутов и аналитики. Но 30 000 обновлений позиций в секунду с перестройкой дерева — дорого.', msgs: [{ from: 'u', to: 'pg', label: 'в какой я зоне?' }], c: { 1: [1, 2, 3, 5, 6] } },
      { title: 'H3: шестиугольники', text: 'Uber H3 делит мир на шестиугольники разных размеров. Клетка становится ключом партиции и шарда: «водители в клетке» читаются одним запросом, а горячий центр города делится на мелкие клетки.', hl: ['map'], lines: { map: ['⬡ ⬡ ⬡', '⬡ ● ⬡', '⬡ ⬡ ⬡'] }, c: { 2: [1, 2, 3, 4] } }
    ]
  };

  D.olap = {
    title: 'Колоночная аналитика и схема «звезда»', icon: 'olap', lede: 'Факты, измерения, колоночное хранение, партиции и материализованные представления.',
    actors: [
      { id: 'f', x: 225, y: 120, w: 190, label: 'fact_orders', sub: 'факты: заказы' },
      { id: 'd1', x: 20, y: 30, w: 150, label: 'dim_date' },
      { id: 'd2', x: 20, y: 230, w: 150, label: 'dim_product' },
      { id: 'd3', x: 470, y: 30, w: 150, label: 'dim_customer' },
      { id: 'd4', x: 470, y: 230, w: 150, label: 'dim_store' }
    ],
    code: [
      { label: 'ClickHouse', lang: 'sql', src: `
-- Таблица фактов: одна строка = один заказ
CREATE TABLE fact_orders (
  date_id UInt32, product_id UInt32, customer_id UInt64, store_id UInt16,
  qty UInt16, revenue Decimal(12, 2)
) ENGINE = MergeTree PARTITION BY toYYYYMM(toDate(date_id)) ORDER BY (date_id, store_id);

-- Отчёт: выручка по категориям за квартал
SELECT p.category, sum(f.revenue)
FROM fact_orders f JOIN dim_product p USING (product_id)
WHERE f.date_id BETWEEN 20260701 AND 20260930
GROUP BY p.category ORDER BY 2 DESC;

-- Материализованное представление: суммы по дням считаются при вставке
CREATE MATERIALIZED VIEW daily_revenue ENGINE = SummingMergeTree ORDER BY (date_id, product_id)
AS SELECT date_id, product_id, sum(revenue) AS revenue FROM fact_orders GROUP BY date_id, product_id;` }
    ],
    steps: [
      { title: 'Звезда', text: 'В центре — таблица фактов: события с числами (заказы, клики). Вокруг — измерения: когда, что, кто, где. Отчёт — это JOIN факта с парой измерений и GROUP BY.', hl: ['f'], c: [1, 2, 3, 4, 5] },
      { title: 'Колонки, а не строки', text: 'Колоночная база хранит каждую колонку отдельно и сжато. «Сумма выручки» читает одну колонку, а не все строки целиком: в 10–100 раз меньше чтения с диска.', lines: { f: ['revenue ▮▮▮▮▮▮ (сжато ×8)', 'qty ▮▮▮', 'date_id ▮▮'] } },
      { title: 'Партиции и порядок', text: 'Партиция по месяцу: отчёт за квартал читает три партиции из сотни. ORDER BY задаёт физический порядок и разреженный индекс по нему.', c: [5] },
      { title: 'Запрос к звезде', text: 'Факт соединяется с измерением товаров (категория) и фильтруется по датам. Миллиарды строк — за секунду-две.', msgs: [{ from: 'd2', to: 'f', label: 'category' }, { from: 'd1', to: 'f', label: 'квартал' }], c: [7, 8, 9, 10, 11] },
      { title: 'Материализованное представление', text: 'Суммы по дням считаются в момент вставки. Дашборд читает тысячи готовых строк вместо миллиардов фактов и отвечает за миллисекунды.', good: ['f'], c: [13, 14, 15] },
      { title: 'Снежинка и одна широкая таблица', text: 'Снежинка нормализует измерения (категория отдельно от товара): меньше дублей, больше JOIN. Одна широкая таблица — наоборот: читается быстрее всего, но дублирует данные и тяжело меняется.' }
    ]
  };

  D.etl = {
    title: 'ETL, ELT, батч и поток', icon: 'etl', lede: 'Как данные попадают из боевых систем в хранилище и озеро.',
    actors: [
      { id: 'pg', x: 20, y: 40, w: 160, label: 'PostgreSQL', sub: 'реплика' },
      { id: 'k', x: 20, y: 240, w: 160, label: 'Kafka', sub: 'события' },
      { id: 'etl', x: 240, y: 140, w: 160, label: 'Конвейер', sub: 'Airflow, dbt, Flink' },
      { id: 'dwh', x: 460, y: 40, w: 160, label: 'ClickHouse', sub: 'витрины' },
      { id: 'lake', x: 460, y: 240, w: 160, label: 'S3 + Iceberg', sub: 'сырьё навсегда' }
    ],
    code: [
      { label: 'dbt (ELT)', lang: 'sql', src: `
-- models/marts/fct_orders.sql  (ELT: сырьё уже в хранилище)
{{ config(materialized='incremental', unique_key='order_id') }}
SELECT o.id AS order_id, o.created_at::date AS date_id, o.total, c.segment
FROM {{ ref('stg_orders') }} o
JOIN {{ ref('dim_customer') }} c ON c.customer_id = o.user_id
{% if is_incremental() %}
WHERE o.updated_at > (SELECT max(updated_at) FROM {{ this }})   -- только новое
{% endif %}` },
      { label: 'Airflow', lang: 'python', src: `
with DAG("orders_hourly", schedule="@hourly", catchup=False) as dag:
    extract = PostgresToS3Operator(task_id="extract",
        sql="SELECT * FROM orders WHERE updated_at > '{{ prev_ds }}'",
        conn_id="pg_replica")                   # читаем с реплики!
    load = S3ToClickHouseOperator(task_id="load")
    transform = DbtRunOperator(task_id="dbt_run", models="marts")
    extract >> load >> transform` }
    ],
    steps: [
      { title: 'Зачем конвейер', text: 'Отчёты по боевой базе мешают покупателям, а данные из разных систем нужно свести вместе. Конвейер переносит их в хранилище, где считать удобно и безопасно.', hl: ['etl'] },
      { title: 'Батч по расписанию', text: 'Раз в час выгружаем изменённые строки по updated_at. Читаем с реплики, чтобы не нагружать primary. Отчёты отстают на интервал запуска.', msgs: [{ from: 'pg', to: 'etl', label: 'изменения за час' }, { from: 'etl', to: 'dwh', label: 'load' }], c: { 1: [1, 2, 3, 4, 5, 7] } },
      { title: 'Поток', text: 'События идут из Kafka (или из CDC базы) и попадают в хранилище за секунды. Дороже и сложнее, зато дашборды живые.', msgs: [{ from: 'k', to: 'etl', label: 'события онлайн', color: 'var(--k-events)' }, { from: 'etl', to: 'dwh', label: 'секунды' }] },
      { title: 'ELT и dbt', text: 'Сначала грузим сырьё, потом преобразуем SQL-моделями прямо в хранилище. Логика лежит в git и тестируется как код, модели пересчитываются при изменениях. Инкрементальная модель берёт только новое.', hl: ['dwh'], c: { 0: [1, 2, 3, 4, 5, 6, 7, 8], 1: [6, 7] } },
      { title: 'Озеро данных', text: 'Сырьё за годы лежит в S3 в Parquet под табличным форматом Iceberg: дёшево, с транзакциями и эволюцией схемы. Горячие витрины — в ClickHouse.', msgs: [{ from: 'etl', to: 'lake', label: 'сырые события' }] },
      { title: 'Качество данных', text: 'Конвейер — место проверок: схема, дубли, пропуски, свежесть. Сломанный источник не должен тихо испортить отчёт для директора.', good: ['etl'] }
    ]
  };
})();
