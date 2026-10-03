/* Живой разбор: на каждое изменение схемы — карточка «что изменилось, как работает, как в коде, почему, цена». */
(function () {
  const X = SD.EXPLAIN;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nm = n => n.label || SD.TYPES[n.type].name;
  const F = () => SD.fmt;
  let A = null, H = {};

  /* ---------- настройки узлов ---------- */
  const P = X.prop;
  const idxSql = { btree: 'CREATE INDEX ON orders (user_id);', hash: 'CREATE INDEX ON orders USING HASH (id);', composite: 'CREATE INDEX ON orders (user_id, created_at DESC);', covering: 'CREATE INDEX ON orders (user_id, created_at DESC) INCLUDE (total, status);', clustered: 'CLUSTER orders USING orders_user_id_created_at_idx;', gin: "CREATE INDEX ON products USING GIN (to_tsvector('russian', title));", gist: 'CREATE INDEX ON drivers USING GIST (location);', brin: 'CREATE INDEX ON events USING BRIN (created_at);', partial: "CREATE INDEX ON orders (user_id) WHERE status = 'active';" };
  P['sql.idx'] = (n, v, prev) => { const added = v.filter(x => !(prev || []).includes(x)), removed = (prev || []).filter(x => !v.includes(x)); const opt = k => (SD.TYPES.sql.props.find(p => p.key === 'idx').options.find(o => o[0] === k) || [])[1]; return { title: added.length ? `Индекс: ${opt(added[0])}` : `Удалён индекс: ${opt(removed[0])}`, how: added.length ? SD.TYPES.sql.props.find(p => p.key === 'idx').options.find(o => o[0] === added[0])[2] : 'Запись стала дешевле, но запросы, которые им пользовались, теперь читают больше.', why: 'Индекс превращает перебор таблицы в поиск по дереву.', cost: 'Каждый индекс обновляется при каждой записи и занимает память.', code: { lang: 'sql', label: 'SQL', src: v.map(k => idxSql[k]).join('\n') || '-- индексов нет: каждое чтение — Seq Scan' }, dive: 'indexes', pattern: 'indexing' }; };
  P['sql.isolation'] = (n, v) => ({ title: `Изоляция: ${SD.ISOLATION[v].name}`, how: `Защищает от: ${SD.ISOLATION[v].prevents.map(a => SD.ANOMALIES[a].name.toLowerCase()).join(', ')}.`, why: v === 'ser' ? 'Ловит даже write skew: конфликтующая транзакция откатывается.' : v === 'rr' ? 'Транзакция видит снимок данных, потерянных обновлений нет.' : 'Самый быстрый уровень, но гонки ловит код.', cost: v === 'rc' ? 'Аномалии конкурентного доступа возможны.' : 'При конкуренции часть транзакций откатывается и повторяется.', code: { lang: 'sql', label: 'SQL', src: `BEGIN ISOLATION LEVEL ${({ rc: 'READ COMMITTED', rr: 'REPEATABLE READ', ser: 'SERIALIZABLE' })[v]};
UPDATE stock SET qty = qty - 1 WHERE sku = 'A1';
COMMIT;   ${v === 'rc' ? '' : '-- при конфликте: ERROR could not serialize → повторить'}` }, dive: 'isolation' });
  P['sql.locking'] = (n, v) => ({ title: `Блокировки: ${({ none: 'нет', optimistic: 'оптимистичные', pessimistic: 'пессимистичные' })[v]}`, how: v === 'optimistic' ? 'У строки колонка version: UPDATE проходит, только если версия не изменилась.' : v === 'pessimistic' ? 'SELECT … FOR UPDATE блокирует строку до конца транзакции, конкуренты ждут.' : 'Конкурентные изменения могут затирать друг друга.', why: 'Защищает от потерянного обновления.', cost: v === 'pessimistic' ? 'Ожидание при конкуренции и риск взаимных блокировок.' : v === 'optimistic' ? 'Проигравший повторяет транзакцию.' : '', code: { lang: 'sql', label: 'SQL', src: v === 'optimistic' ? `UPDATE stock SET qty = 4, version = version + 1
WHERE sku = 'A1' AND version = 17;    -- 0 строк → конфликт, перечитать` : v === 'pessimistic' ? `BEGIN;
SELECT qty FROM stock WHERE sku = 'A1' FOR UPDATE;   -- конкуренты ждут
UPDATE stock SET qty = qty - 1 WHERE sku = 'A1';
COMMIT;` : `UPDATE stock SET qty = 4 WHERE sku = 'A1';   -- последний пишущий побеждает` }, dive: 'isolation', pattern: 'optlock' });
  P['sql.replicas'] = (n, v, prev) => ({ title: `Реплики: ${prev} → ${v}`, how: v > (prev || 0) ? 'Новая реплика догоняет primary по WAL и начинает брать чтения.' : 'Чтения делятся между меньшим числом реплик.', why: 'Реплики масштабируют чтение и подменяют primary при падении.', cost: 'Полноценный сервер каждая. Запись реплики не ускоряют. Лаг даёт устаревшие чтения.', code: { lang: 'yaml', label: 'Patroni', src: `postgresql:
  parameters: { hot_standby: on, max_wal_senders: ${v + 5} }
# реплик: ${v}; при падении primary Patroni повысит самую свежую` }, dive: 'replication', pattern: 'readreplica' });
  P['sql.replMode'] = (n, v) => ({ title: `Репликация: ${({ async: 'асинхронная', semisync: 'полусинхронная', sync: 'синхронная' })[v]}`, how: v === 'async' ? 'Primary отвечает, не дожидаясь реплик.' : v === 'semisync' ? 'Primary ждёт подтверждения хотя бы одной реплики.' : 'Primary ждёт все реплики.', why: v === 'async' ? 'Самая быстрая запись.' : 'Подтверждённая транзакция не потеряется при падении primary.', cost: v === 'async' ? 'При падении primary пропадут последние транзакции.' : 'Каждая запись ждёт сеть до реплики.', code: { lang: 'yaml', label: 'postgresql.conf', src: `synchronous_commit = ${v === 'async' ? 'local' : 'on'}
synchronous_standby_names = '${v === 'async' ? '' : v === 'semisync' ? 'ANY 1 (*)' : 'FIRST ' + n.props.replicas + ' (*)'}'` }, dive: 'replication' });
  P['sql.ryw'] = (n, v) => ({ title: `Read-your-writes ${v ? 'включён' : 'выключен'}`, how: v ? 'После записи чтения этого пользователя несколько секунд идут на primary.' : 'Все чтения идут на реплики.', why: 'Пользователь сразу видит то, что сохранил.', cost: 'Часть чтений нагружает primary.', code: { lang: 'python', label: 'роутинг', src: `def db_for_read(session):
    return primary if time.time() - session.last_write < 5 else random.choice(replicas)` }, dive: 'replication' });
  P['sql.shards'] = (n, v, prev) => ({ title: `Шарды: ${prev} → ${v}`, how: `Данные делятся на ${v} частей по ключу. У каждой части свой primary и свои реплики.`, why: 'Запись и объём масштабируются числом шардов.', cost: 'Запросы без ключа идут во все шарды, транзакции между шардами сложны, перебалансировка дорогая.', code: { lang: 'python', label: 'роутинг', src: `def shard_for(user_id: int) -> Pool:
    return pools[${n.props.shardKey === 'hash' ? 'murmur3(user_id) % ' + v : 'month_index(created_at) % ' + v}]` }, dive: 'sharding', pattern: 'sharding' });
  P['sql.shardKey'] = (n, v) => ({ title: `Ключ шардирования: ${({ hash: 'hash(user_id)', range: 'created_at', geo: 'регион' })[v]}`, how: v === 'hash' ? 'Хэш раскладывает пользователей равномерно.' : v === 'range' ? 'Все новые записи попадают в последний шард — горячая точка.' : 'Крупный регион перегружает свой шард.', dive: 'sharding', pattern: v === 'hash' ? 'sharding' : 'hotpartition' });
  P['sql.pooler'] = (n, v) => ({ title: `PgBouncer ${v ? 'включён' : 'выключен'}`, how: v ? 'Тысячи клиентских соединений мультиплексируются в пару сотен серверных.' : 'Каждый экземпляр сервиса держит свои соединения к базе напрямую.', why: 'Соединение PostgreSQL — отдельный процесс с памятью, их мало.', code: { lang: 'yaml', label: 'pgbouncer.ini', src: `[pgbouncer]
pool_mode = transaction
max_client_conn = 10000
default_pool_size = 150` }, pattern: 'connpool' });
  P['sql.partition'] = (n, v) => ({ title: `Партиционирование: ${({ none: 'нет', month: 'по месяцам', hash: 'по хэшу' })[v]}`, how: v === 'month' ? 'Запрос за период читает только нужные партиции, старое удаляется целой партицией.' : v === 'hash' ? 'Таблица делится на равные части: меньше индексы и VACUUM.' : 'Одна большая таблица.', code: { lang: 'sql', label: 'SQL', src: v === 'month' ? `CREATE TABLE orders (...) PARTITION BY RANGE (created_at);
CREATE TABLE orders_2026_10 PARTITION OF orders FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
DROP TABLE orders_2023_10;   -- удаление старого за миллисекунды` : `CREATE TABLE orders (...) PARTITION BY HASH (user_id);` }, pattern: 'partitioning' });
  P['app.count'] = (n, v, prev) => ({ title: `«${nm(n)}»: экземпляров ${prev} → ${v}`, how: 'Новые экземпляры одинаковые: балансировщик сразу начинает слать им запросы.', why: 'Горизонтальное масштабирование и запас на падение (N+1).', cost: `${v} × $${({ s: 80, m: 150, l: 290, xl: 560 })[n.props.size || 'm']} в месяц и ${v * 10} соединений к базе.`, code: { lang: 'yaml', label: 'Kubernetes', src: `apiVersion: apps/v1
kind: Deployment
spec:
  replicas: ${v}
  template: { spec: { containers: [{ name: app, resources: { requests: { cpu: "${({ s: 1, m: 2, l: 4, xl: 8 })[n.props.size || 'm']}" } } }] } }` }, dive: 'lb', pattern: 'loadbalancing' });
  P['app.autoscale'] = (n, v) => ({ title: `Автомасштабирование ${v ? 'включено' : 'выключено'}`, how: v ? `Kubernetes добавляет экземпляры, когда средняя загрузка выше ${Math.round((+n.props.hpaTarget || 0.6) * 100)} %.` : 'Число экземпляров фиксировано.', cost: 'Автоскейлинг не спасает базу и общие ресурсы.', code: { lang: 'yaml', label: 'HPA', src: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  minReplicas: ${n.props.count}
  maxReplicas: 30
  metrics: [{ type: Resource, resource: { name: cpu, target: { type: Utilization, averageUtilization: ${Math.round((+n.props.hpaTarget || 0.6) * 100)} } } }]` }, pattern: 'autoscaling' });
  P['app.outbox'] = (n, v) => ({ title: `Transactional outbox ${v ? 'включён' : 'выключен'}`, how: 'Событие пишется в таблицу outbox в той же транзакции, что и данные. Ретранслятор публикует его в брокер.', why: 'Нет двойной записи: событие появится ровно тогда, когда данные зафиксированы.', code: { lang: 'sql', label: 'SQL', src: `BEGIN;
INSERT INTO payments (...) VALUES (...);
INSERT INTO outbox (aggregate_id, type, payload) VALUES (777, 'PaymentCaptured', '{...}');
COMMIT;` }, dive: 'cdc', pattern: 'outbox' });
  P['app.idempotency'] = (n, v) => ({ title: `Ключ идемпотентности ${v ? 'включён' : 'выключен'}`, how: 'Клиент передаёт Idempotency-Key, сервер хранит ответ по ключу и на повтор возвращает тот же.', why: 'Повтор после таймаута не списывает деньги дважды.', code: { lang: 'text', label: 'HTTP', src: `POST /payments
Idempotency-Key: 6f1c2e8a-…      ← тот же ключ при повторе → тот же ответ` }, pattern: 'idempotency' });
  P['app.txMode'] = (n, v) => ({ title: `Транзакция между сервисами: ${({ local: 'без координации', '2pc': '2PC', saga: 'сага' })[v]}`, how: v === 'saga' ? 'Шаги выполняются по очереди через брокер, при сбое — компенсации в обратном порядке.' : v === '2pc' ? 'Все участники готовятся, затем фиксируют вместе.' : 'Каждый сервис коммитит сам: при сбое остаются частичные изменения.', cost: v === '2pc' ? 'Падение участника блокирует операцию.' : v === 'saga' ? 'Согласованность в конечном счёте и компенсации надо проектировать.' : 'Несогласованные данные при сбоях.', dive: v === '2pc' ? 'twopc' : 'saga', pattern: 'saga-p' });
  P['app.persistence'] = (n, v) => ({ title: v === 'es' ? 'Event sourcing включён' : 'Хранение текущего состояния', how: v === 'es' ? 'Команды дописывают события в журнал. Состояние — свёртка событий, для чтения нужна проекция.' : 'Строки обновляются на месте.', dive: 'cqrs', pattern: 'eventsourcing' });
  P['cache.policy'] = (n, v) => ({ title: `Кэш: ${({ aside: 'cache-aside', through: 'write-through', behind: 'write-behind' })[v]}`, how: v === 'behind' ? 'Записи идут в кэш и пачками сбрасываются в базу.' : v === 'through' ? 'Запись идёт и в кэш, и в базу сразу.' : 'Кэш заполняется при чтении.', cost: v === 'behind' ? 'Несброшенные записи пропадут при падении кэша.' : '', dive: 'cache', pattern: 'writethrough' });
  P['cache.stampede'] = (n, v) => ({ title: `Защита от stampede ${v ? 'включена' : 'выключена'}`, how: 'На промах по ключу в базу идёт один запрос под замком, остальные ждут результат.', code: { lang: 'python', label: 'redis', src: `if r.set(f"lock:{key}", 1, nx=True, ex=5):   # только один пойдёт в базу
    value = db.load(key); r.set(key, value, ex=600); r.delete(f"lock:{key}")` }, dive: 'cache', pattern: 'stampede' });
  P['cache.geo'] = (n, v) => ({ title: `Redis GEO ${v ? 'включён' : 'выключен'}`, how: 'Позиции в sorted set по geohash: обновление одной командой, поиск в радиусе — миллисекунды.', code: { lang: 'text', label: 'Redis', src: `GEOADD drivers 37.6176 55.7558 driver:17
GEOSEARCH drivers FROMLONLAT 37.62 55.75 BYRADIUS 2 km ASC COUNT 10` }, dive: 'geo' });
  P['queue.partitions'] = (n, v, prev) => ({ title: `Партиций: ${prev} → ${v}`, how: `В группе потребителей одну партицию читает один обработчик: параллельность ограничена ${v}.`, cost: 'Партиции нельзя уменьшить, а при увеличении меняется маршрутизация ключей.', code: { lang: 'text', label: 'kafka-topics', src: `kafka-topics --alter --topic orders --partitions ${v}` }, dive: 'queue', pattern: 'queue-cc' });
  P['queue.acks'] = (n, v) => ({ title: `acks=${v}`, how: v === 'all' ? 'Продюсер ждёт записи лидером и синхронными репликами.' : v === '1' ? 'Ждёт только лидера: при его падении сообщение может пропасть.' : 'Не ждёт ничего: максимальная скорость, возможны потери.', code: { lang: 'yaml', label: 'producer', src: `acks: ${v}
enable.idempotence: ${v === 'all'}
min.insync.replicas: 2   # на топике` }, dive: 'queue' });
  P['queue.semantics'] = (n, v) => ({ title: `Семантика: ${({ most: 'at-most-once', least: 'at-least-once', exactly: 'exactly-once' })[v]}`, how: v === 'most' ? 'Смещение фиксируется до обработки.' : v === 'least' ? 'Смещение фиксируется после обработки.' : 'Транзакции Kafka связывают обработку и коммит.', cost: v === 'most' ? 'Потери при сбое.' : v === 'least' ? 'Дубли при сбое: нужен идемпотентный обработчик.' : 'Медленнее и работает только внутри Kafka.', dive: 'delivery', pattern: 'inbox' });
  P['queue.retries'] = (n, v) => ({ title: `Повторы и DLQ ${v ? 'включены' : 'выключены'}`, how: 'Упавшая задача повторяется с паузой, после N попыток уходит в Dead Letter Queue с причиной.', code: { lang: 'yaml', label: 'Spring Kafka', src: `@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000, multiplier = 2),
                dltTopicSuffix = ".DLQ")` }, dive: 'delivery', pattern: 'dlq' });
  P['queue.engine'] = (n, v) => ({ title: `Движок: ${SD.ENGINES[v].name}`, how: SD.ENGINES[v].note, dive: 'queue' });
  P['worker.dedup'] = (n, v) => ({ title: `Идемпотентный потребитель ${v ? 'включён' : 'выключен'}`, how: 'ID сообщения пишется в таблицу inbox в той же транзакции, что и результат.', code: { lang: 'sql', label: 'SQL', src: `CREATE TABLE inbox (msg_id text PRIMARY KEY, processed_at timestamptz DEFAULT now());
INSERT INTO inbox (msg_id) VALUES ($1) ON CONFLICT DO NOTHING;   -- 0 строк → повтор, пропускаем` }, dive: 'delivery', pattern: 'inbox' });
  P['lb.algo'] = (n, v) => ({ title: `Алгоритм: ${({ rr: 'round robin', wrr: 'weighted round robin', lc: 'least connections', lrt: 'least response time', p2c: 'power of two choices', hash: 'consistent hash', random: 'random' })[v]}`, how: SD.TYPES.lb.props[0].help, code: X.node.lb(n).code, dive: 'lb', pattern: 'loadbalancing' });
  P['gateway.rateLimit'] = (n, v) => ({ title: `Rate limiting ${v ? 'включён' : 'выключен'}`, how: 'Ведро токенов на клиента в Redis: лишние запросы получают 429 с Retry-After.', dive: 'ratelimit', pattern: 'ratelimit' });
  P['nosql.cl'] = (n, v) => ({ title: `Согласованность ${String(v).toUpperCase()}`, how: v === 'one' ? 'Ответ от одной реплики: быстро, но можно прочитать старое.' : v === 'quorum' ? 'Большинство реплик: при QUORUM на чтение и запись данные свежие.' : 'Все реплики: падение любой ломает запрос.', dive: 'cap' });
  P['llm.stream'] = (n, v) => ({ title: `Стриминг ${v ? 'включён' : 'выключен'}`, how: v ? 'Пользователь видит первые слова через время до первого токена.' : 'Пользователь ждёт генерацию всего ответа.', dive: 'llm' });
  P['llm.pcache'] = (n, v) => ({ title: `Prompt caching ${v ? 'включён' : 'выключен'}`, how: 'Неизменная часть промпта кэшируется у провайдера: вход дешевле в 10 раз, время до первого токена ниже.', dive: 'llm' });

  /* ---------- настройки связей ---------- */
  const EP = X.eprop;
  const edgeCard = (title, how, why, cost, dive, pattern) => (e, a, b) => ({ title: title(e.props, a, b), how: typeof how === 'function' ? how(e.props) : how, why, cost, code: X.edge['app>app'](a, b, e).code, dive, pattern });
  EP.proto = edgeCard(p => `Протокол: ${SD.PROTOCOLS[p.proto].name}`, p => SD.PROTOCOLS[p.proto].note, 'Формат влияет на CPU обеих сторон и на удобство контракта.', '', 'protocols');
  EP.timeout = edgeCard(p => p.timeout ? `Таймаут ${p.timeout} мс` : 'Таймаут снят', p => p.timeout ? 'Вызов, который не уложился, обрывается, и поток освобождается.' : 'Вызов ждёт сколько угодно.', 'Медленная зависимость не съест все потоки вызывающего.', 'Слишком короткий таймаут обрывает нормальные ответы.', 'resilience', 'timeout');
  EP.retries = edgeCard(p => `Повторов: ${p.retries}`, 'Упавший вызов повторяется.', 'Случайные сбои больше не видны пользователю.', 'При перегрузке повторы умножают нагрузку. Повторяют только идемпотентные операции.', 'resilience', 'retry');
  EP.backoff = edgeCard(p => p.backoff === 'exp' ? 'Пауза: экспоненциальная с джиттером' : 'Повторы без паузы', p => p.backoff === 'exp' ? 'Паузы 100, 200, 400 мс со случайным разбросом.' : 'Повтор летит сразу же.', 'Повторы не бьют в больной сервис синхронной толпой.', '', 'resilience', 'retry');
  EP.cb = edgeCard(p => `Circuit breaker ${p.cb ? 'включён' : 'выключен'}`, 'Когда больше половины вызовов падает, цепь размыкается и вызовы отбиваются сразу.', 'Упавший сервис получает передышку, вызывающий не ждёт таймаутов.', 'Нужен разумный fallback на время размыкания.', 'resilience', 'circuitbreaker');
  EP.fallback = edgeCard(p => `Fallback ${p.fallback ? 'включён' : 'выключен'}`, 'При отказе возвращается упрощённый ответ.', 'Отказ второстепенной функции не роняет весь экран.', 'Пользователь получает неполные данные.', 'resilience', 'fallback');

  /* ---------- эффект «было → стало» ---------- */
  function effects(before, after) {
    const out = [];
    if (!before || !before.res || !after) return out;
    const b = before.res, a = after;
    if (Math.abs(a.total.success - b.total.success) > 0.0005) out.push({ l: 'Успешно', f: F().pct(b.total.success), t: F().pct(a.total.success), good: a.total.success > b.total.success });
    const dl = a.total.lat - b.total.lat;
    if (Math.abs(dl) > Math.max(2, b.total.lat * 0.05)) out.push({ l: 'Время ответа', f: F().ms(b.total.lat), t: F().ms(a.total.lat), good: dl < 0 });
    if (Math.abs(a.cost - b.cost) >= 1) out.push({ l: 'В месяц', f: F().usd(b.cost), t: F().usd(a.cost), good: null });
    if (Math.abs(a.jobs.backlogRate - b.jobs.backlogRate) > 0.5) out.push({ l: 'Рост очереди', f: F().num(b.jobs.backlogRate) + '/с', t: F().num(a.jobs.backlogRate) + '/с', good: a.jobs.backlogRate < b.jobs.backlogRate });
    if (Math.abs(a.jobs.lostRate - b.jobs.lostRate) > 0.01) out.push({ l: 'Потери', f: F().num(b.jobs.lostRate * 60) + '/мин', t: F().num(a.jobs.lostRate * 60) + '/мин', good: a.jobs.lostRate < b.jobs.lostRate });
    if (Math.abs(a.jobs.dupRate - b.jobs.dupRate) > 0.01) out.push({ l: 'Дубли', f: F().num(b.jobs.dupRate * 60) + '/мин', t: F().num(a.jobs.dupRate * 60) + '/мин', good: a.jobs.dupRate < b.jobs.dupRate });
    if (a.ai && b.ai && a.ai.quality != null && b.ai.quality != null && Math.abs(a.ai.quality - b.ai.quality) > 0.005) out.push({ l: 'Качество AI', f: Math.round(b.ai.quality * 100) + ' %', t: Math.round(a.ai.quality * 100) + ' %', good: a.ai.quality > b.ai.quality });
    const gb = (before.goals || []).filter(g => g.ok).length, ga = (A.goals || []).filter(g => g.ok).length;
    if (gb !== ga && A.goals.length) out.push({ l: 'Цели', f: `${gb} из ${A.goals.length}`, t: `${ga} из ${A.goals.length}`, good: ga > gb });
    const nodes = Object.keys(a.nodes).map(id => {
      const na = a.nodes[id], nb = b.nodes[id];
      const n = A.graph.nodes.find(x => x.id === id);
      if (!n || n.type === 'client' || SD.TYPES[n.type].managed) return null;
      const ua = Math.min(na.util, 9), ub = nb ? Math.min(nb.util, 9) : null;
      if (ub === null) return na.rps > 0 ? { l: nm(n), f: 'новый', t: Math.round(ua * 100) + ' %', good: ua <= 0.75, d: 1 } : null;
      const d = Math.abs(ua - ub);
      return d > 0.05 ? { l: nm(n), f: Math.round(ub * 100) + ' %', t: Math.round(ua * 100) + ' %', good: ua < ub, d } : null;
    }).filter(Boolean).sort((x, y) => y.d - x.d).slice(0, 4);
    return out.concat(nodes);
  }

  /* ---------- построение карточки ---------- */
  function cardFor(change) {
    const g = A.graph;
    if (change.kind === 'add' && change.node) { const f = X.node[change.node.type]; return f ? Object.assign({ kind: 'Новый узел' }, f(change.node)) : null; }
    if (change.kind === 'edge' && change.edge) return edgeExplain(change.edge);
    if (change.kind === 'remove') return { kind: 'Удалено', title: change.node ? `Удалён узел «${nm(change.node)}»` : 'Удалена связь', how: 'Посмотри, куда теперь пошла нагрузка и какие цели изменились.' };
    if (change.kind === 'prop' && change.node) {
      const n = change.node, key = `${n.type}.${change.key}`;
      const f = P[key];
      if (f) return Object.assign({ kind: 'Настройка' }, f(n, change.value, change.prev));
      const d = (SD.TYPES[n.type].props || []).find(p => p.key === change.key);
      if (!d) return null;
      const lab = d.type === 'toggle' ? (change.value ? 'включено' : 'выключено') : d.type === 'select' ? ((d.options.find(o => String(o[0]) === String(change.value)) || [])[1] || change.value) : change.value;
      return { kind: 'Настройка', title: `«${nm(n)}»: ${d.label.toLowerCase()} — ${lab}`, how: d.help || '', dive: SD.TYPES[n.type].dive };
    }
    if (change.kind === 'eprop' && change.edge) {
      const e = change.edge, a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
      const f = EP[change.key];
      return f && a && b ? Object.assign({ kind: `Связь ${nm(a)} → ${nm(b)}` }, f(Object.assign({}, e, { props: Object.assign(SD.edgeDefaults(), e.props) }), a, b)) : null;
    }
    return null;
  }
  function edgeExplain(e) {
    const g = A.graph, a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
    if (!a || !b) return null;
    const f = X.edge[`${a.type}>${b.type}`];
    if (f) return Object.assign({ kind: 'Интеграция' }, f(a, b, e));
    return { kind: 'Интеграция', title: `${nm(a)} → ${nm(b)}`, how: `${nm(a)} передаёт данные в «${nm(b)}». Посмотри во вкладке «Метрики», идёт ли по связи поток: пунктир значит, что связь не используется.` };
  }

  function onChange(change, before) {
    const c = cardFor(change);
    const eff = effects(before, A.res1);
    A.lastChange = { kind: change.kind, id: change.node ? change.node.id : change.edge ? change.edge.id : null, key: change.key, value: change.value, prev: change.prev, effects: eff, card: c, at: Date.now() };
    if (!c) return;
    c.effects = eff;
    c.at = new Date();
    A.feed = A.feed || [];
    A.feed.unshift(c);
    if (A.feed.length > 40) A.feed.pop();
    if (H.notify) H.notify(c);
  }
  function explainNow(card) { if (!card) return; card.at = new Date(); card.effects = []; A.feed = A.feed || []; A.feed.unshift(card); if (H.notify) H.notify(card, true); }
  function forEdge(e) { explainNow(edgeExplain(e)); }
  function forNode(n) {
    const f = X.node[n.type];
    explainNow(f ? Object.assign({ kind: 'Узел' }, f(n)) : null);
  }

  function codeBlock(c) {
    return `<details class="lv-code" open><summary>Как это выглядит в коде · ${esc(c.label || c.lang)}</summary><pre class="code pat-code">${c.src.split('\n').map((l, k) => `<span class="ln" data-n="${k + 1}">${SD.player.highlight(l, c.lang) || ' '}</span>`).join('')}</pre></details>`;
  }
  function render() {
    const pane = document.getElementById('paneLive');
    const feed = A.feed || [];
    if (!feed.length) { pane.innerHTML = `<p class="empty">Поставь деталь, проведи связь или поменяй настройку — здесь появится разбор: что изменилось в цифрах, как это работает, как выглядит в коде и почему так лучше.</p><p class="note">Объяснить уже стоящий узел или связь можно кнопкой «Объяснить» в карточке узла.</p>`; return; }
    pane.innerHTML = feed.map((c, i) => `<article class="lv-card ${i === 0 ? 'new' : ''}">
      <header><span class="lv-kind">${esc(c.kind || '')}</span><time>${c.at.toLocaleTimeString('ru-RU')}</time></header>
      <h4 class="lv-title">${esc(c.title)}</h4>
      ${c.effects && c.effects.length ? `<div class="lv-eff">${c.effects.map(x => `<span class="lv-chip ${x.good === true ? 'good' : x.good === false ? 'bad' : ''}"><small>${esc(x.l)}</small>${esc(x.f)} → <b>${esc(x.t)}</b></span>`).join('')}</div>` : ''}
      ${c.how ? `<p><b>Как работает.</b> ${esc(c.how)}</p>` : ''}
      ${c.code && i < 6 ? codeBlock(c.code) : c.code ? `<details class="lv-code"><summary>Как это выглядит в коде · ${esc(c.code.label || '')}</summary><pre class="code pat-code">${c.code.src.split('\n').map((l, k) => `<span class="ln" data-n="${k + 1}">${SD.player.highlight(l, c.code.lang) || ' '}</span>`).join('')}</pre></details>` : ''}
      ${c.why ? `<p><b>Почему так.</b> ${esc(c.why)}</p>` : ''}
      ${c.cost ? `<p class="lv-cost"><b>Цена.</b> ${esc(c.cost)}</p>` : ''}
      ${(c.dive && SD.DIVES[c.dive]) || c.pattern ? `<div class="row-btns">${c.dive && SD.DIVES[c.dive] ? `<button type="button" class="btn" data-dive="${c.dive}">Разбор по шагам</button>` : ''}${c.pattern && SD.PATTERNS.some(p => p.id === c.pattern) ? `<button type="button" class="btn ghost" data-pat="${c.pattern}">Карточка паттерна</button>` : ''}</div>` : ''}
    </article>`).join('');
  }

  SD.explain = { init: (app, hooks) => { A = app; H = hooks || {}; }, onChange, forEdge, forNode, render };
})();
