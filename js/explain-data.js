/* Живой разбор: шаблоны объяснений для узлов и связей.
   Каждый шаблон получает реальные узлы и настройки и возвращает {title, how, why, cost, code:{lang,label,src}, dive, pattern}. */
(function () {
  const nm = n => n.label || SD.TYPES[n.type].name;
  const X = SD.EXPLAIN = { node: {}, edge: {}, prop: {}, eprop: {} };

  /* ---------- узлы ---------- */
  Object.assign(X.node, {
    app: n => ({ title: `Сервис «${nm(n)}»`, how: 'Обычный HTTP-сервис без состояния: принимает запрос, ходит в свои зависимости и отвечает. Состояние хранится снаружи — в базе, кэше, хранилище, — поэтому экземпляры одинаковые и их можно копировать.', why: 'Stateless-сервис масштабируется добавлением экземпляров за балансировщиком и переживает падение любого из них.', cost: 'Каждый экземпляр — деньги, а каждый синхронный вызов наружу держит поток.', code: { lang: 'python', label: 'FastAPI', src: `@app.get("/items/{item_id}")
async def get_item(item_id: int, repo: ItemRepo = Depends()):
    item = await repo.by_id(item_id)          # зависимость внедряется снаружи
    if item is None:
        raise HTTPException(404)
    return item` }, dive: 'request' }),
    lb: n => ({ title: 'Балансировщик', how: `Держит единый адрес и раздаёт запросы экземплярам по алгоритму «${({ rr: 'round robin', wrr: 'weighted round robin', lc: 'least connections', lrt: 'least response time', p2c: 'power of two choices', hash: 'consistent hash', random: 'random' })[n.props.algo]}». Health checks убирают упавшие экземпляры.`, why: 'Без него из интернета работает только один экземпляр сервиса.', cost: 'Ещё один хоп (≈ 1 мс). Сам балансировщик тоже резервируют.', code: { lang: 'yaml', label: 'nginx', src: `upstream app {
    ${({ lc: 'least_conn;', hash: 'hash $remote_addr consistent;', random: 'random two least_conn;' })[n.props.algo] || '# round robin по умолчанию'}
    server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.1.12:8080 max_fails=3 fail_timeout=10s;
}
server { listen 443 ssl http2; location / { proxy_pass http://app; } }` }, dive: 'lb', pattern: 'loadbalancing' }),
    gateway: n => ({ title: 'API Gateway', how: `Единая точка входа: проверяет JWT${n.props.rateLimit ? ', ограничивает частоту запросов (' + n.props.rlAlgo + ')' : ''} и маршрутизирует к сервисам.`, why: 'Сквозная логика живёт в одном месте, а не в каждом сервисе.', cost: 'Хоп в 2–5 мс и ещё один компонент, который нельзя ронять.', code: { lang: 'yaml', label: 'Kong', src: `services:
  - name: orders
    url: http://orders:8080
    routes: [{ paths: ["/api/orders"] }]
plugins:
  - name: jwt
  - name: rate-limiting
    config: { second: 20, policy: redis }` }, dive: 'ratelimit', pattern: 'apigw' }),
    cache: n => ({ title: 'Кэш Redis', how: `Хранит горячие данные в памяти (${n.props.count} × ${n.props.mem} ГБ). Сервис сначала смотрит сюда, при промахе идёт в базу и кладёт результат с TTL ${n.props.ttl}.`, why: 'Снимает с базы большую часть повторяющихся чтений и отвечает за доли миллисекунды.', cost: 'Устаревшие данные, инвалидация, а при падении кэша вся нагрузка разом идёт в базу.', code: { lang: 'python', label: 'redis-py', src: `def get_product(pid):
    if (hit := r.get(f"product:{pid}")):
        return json.loads(hit)
    row = db.fetch_product(pid)
    r.set(f"product:{pid}", json.dumps(row), ex=${({ '10s': 10, '1m': 60, '10m': 600, '1h': 3600 })[n.props.ttl] || 600})
    return row` }, dive: 'cache', pattern: 'cacheaside' }),
    sql: n => ({ title: 'PostgreSQL', how: `Таблицы, транзакции, индексы. Сейчас: ${n.props.shards} шард(а), ${n.props.replicas} реплик(и) на шард, изоляция ${SD.ISOLATION[n.props.isolation].name}.`, why: 'Надёжный источник правды для денег, заказов и пользователей.', cost: 'Запись упирается в один primary. Соединения — дефицитный ресурс.', code: { lang: 'sql', label: 'SQL', src: `CREATE TABLE orders (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL,
  total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
${(n.props.idx || []).includes('composite') ? 'CREATE INDEX ON orders (user_id, created_at DESC);' : '-- индекс по user_id ещё не создан'}` }, dive: 'replication' }),
    nosql: n => ({ title: `NoSQL (${({ wide: 'Cassandra', doc: 'MongoDB', kv: 'DynamoDB' })[n.props.model || 'wide']})`, how: `Данные раскладываются по ${n.props.count} узлам по хэшу ключа партиции и хранятся в ${n.props.rf} копиях. Уровень согласованности — ${String(n.props.cl).toUpperCase()}.`, why: 'Линейно масштабирует записи и переживает падение узлов.', cost: 'Нет JOIN, таблица проектируется под конкретный запрос.', code: { lang: 'sql', label: 'CQL', src: `CREATE TABLE messages_by_chat (
  chat_id bigint, ts timeuuid, author bigint, text text,
  PRIMARY KEY ((chat_id), ts)
) WITH CLUSTERING ORDER BY (ts DESC);` }, dive: 'polyglot' }),
    objstore: () => ({ title: 'Объектное хранилище S3', how: 'Хранит файлы как объекты по ключу и раздаёт их по HTTP.', why: 'Дёшево, надёжно и не нагружает серверы приложений.', cost: 'Десятки миллисекунд на первый байт: для частой раздачи нужен CDN.', code: { lang: 'python', label: 'boto3', src: `s3.put_object(Bucket="media", Key=f"photos/{uid}/{name}", Body=data,
              ContentType="image/webp", CacheControl="public, max-age=31536000, immutable")` }, dive: 'objstore' }),
    cdn: n => ({ title: 'CDN', how: `Края сети в городах пользователей держат копии статики ${({ min: 'минуту', hour: 'час', day: 'сутки' })[n.props.ttl]}. Промах уходит в источник${n.props.shield ? ' через origin shield' : ''}.`, why: 'Статика отдаётся за 10–20 мс вместо 140 и не нагружает источник.', cost: 'Обновление требует сброса кэша или новой версии файла.', code: { lang: 'text', label: 'HTTP', src: `Cache-Control: public, max-age=${({ min: 60, hour: 3600, day: 86400 })[n.props.ttl]}, immutable
<img src="https://cdn.shop.ru/img/7.3f9a1c.webp">   ← хэш версии в имени` }, dive: 'cdn', pattern: 'cdn-p' }),
    queue: n => { const e = SD.ENGINES[n.props.engine]; return { title: `Брокер ${e.name}`, how: `${e.note}${n.props.engine === 'kafka' ? ` Топик на ${n.props.partitions} партиций, acks=${n.props.acks}.` : ''}`, why: 'Развязывает отправителя и получателя по времени: пики копятся в очереди, отправитель отвечает сразу.', cost: 'Согласованность в конечном счёте, дубли или потери в зависимости от семантики, лаг нужно мониторить.', code: n.props.engine === 'kafka' ? { lang: 'text', label: 'kafka-topics', src: `kafka-topics --create --topic orders \\
  --partitions ${n.props.partitions} --replication-factor ${Math.min(3, n.props.count)} \\
  --config min.insync.replicas=${n.props.count >= 3 ? 2 : 1}` } : { lang: 'python', label: 'RabbitMQ', src: `ch.queue_declare("orders", durable=True, arguments={"x-queue-type": "quorum",
    "x-dead-letter-exchange": "orders.dlx"})` }, dive: 'queue' }; },
    worker: n => ({ title: 'Обработчики', how: `${n.props.count} процессов забирают задачи из брокера${n.props.batch > 1 ? ` пачками по ${n.props.batch}` : ''}${n.props.dedup ? ' и пропускают повторы через таблицу inbox' : ''}.`, why: 'Долгая работа уходит из пути запроса пользователя и масштабируется отдельно.', cost: 'Задача может прийти дважды, нужен мониторинг отставания.', code: { lang: 'python', label: 'consumer', src: `for msg in consumer:                          # группа "${n.label || 'workers'}"
    with db.transaction():
        ${n.props.dedup ? 'if inbox.seen(msg.id): continue' : '# повтор выполнится второй раз!'}
        handle(msg)
        ${n.props.dedup ? 'inbox.mark(msg.id)' : ''}
    consumer.commit(msg)` }, dive: 'delivery' }),
    ws: n => ({ title: 'Realtime-шлюз', how: `${n.props.count} серверов держат постоянные WebSocket-соединения и пересылают сообщения через pub/sub.`, why: 'Сервер сам доставляет сообщение получателю без опросов.', cost: 'Долгие соединения сложнее балансировать и выкатывать.', code: { lang: 'js', label: 'ws', src: `wss.on('connection', ws => ws.on('message', m => pub.publish('chat:' + JSON.parse(m).to, m)));` }, dive: 'websocket' }),
    search: () => ({ title: 'Поисковый движок', how: 'Обратный индекс: слово → список документов. Ищет по словам и формам, ранжирует по релевантности.', why: 'Полнотекстовый поиск за миллисекунды вместо LIKE по всей таблице.', cost: 'Отдельная копия данных, которую надо наполнять индексатором.', code: { lang: 'js', label: 'Elasticsearch', src: `GET /products/_search
{ "query": { "multi_match": { "query": "зимний пуховик", "fields": ["title^3", "description"] } } }` }, dive: 'search' }),
    cdc: () => ({ title: 'CDC Debezium', how: 'Читает журнал транзакций базы (WAL) как реплика и публикует каждое изменение в брокер.', why: 'События появляются ровно тогда, когда транзакция зафиксирована, и без правок кода сервиса.', cost: 'Задержка до сотен миллисекунд, события повторяют схему таблиц.', code: { lang: 'js', label: 'connector.json', src: `{ "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "pg-primary", "table.include.list": "public.orders",
  "topic.prefix": "shop", "plugin.name": "pgoutput" }` }, dive: 'cdc', pattern: 'cdc-p' }),
    external: n => ({ title: `Внешний сервис «${nm(n)}»`, how: 'Чужой API: медленный, иногда отвечает ошибкой и ограничивает частоту запросов.', why: 'Его нельзя починить и масштабировать, поэтому к нему ходят с таймаутами, повторами и через очередь.', cost: 'Задержка и сбои, которые вы не контролируете.', dive: 'resilience' }),
    olap: n => ({ title: 'ClickHouse', how: `Колоночное хранилище, ${n.props.count} шард(а). Модель: ${({ star: 'звезда', snowflake: 'снежинка', obt: 'одна широкая таблица' })[n.props.schema]}${n.props.mv ? ', с материализованными представлениями' : ''}.`, why: 'Агрегаты по миллиардам строк за секунды и без нагрузки на боевую базу.', cost: 'Данные отстают, точечные изменения дорогие.', code: { lang: 'sql', label: 'ClickHouse', src: `SELECT toStartOfDay(ts) AS d, sum(revenue) FROM fact_orders
WHERE ts >= now() - INTERVAL 30 DAY GROUP BY d ORDER BY d;` }, dive: 'olap' }),
    etl: n => ({ title: 'Конвейер данных', how: `Режим: ${({ stream: 'поток, секунды', hourly: 'батч раз в час', daily: 'ночной батч' })[n.props.mode]}, подход ${n.props.approach.toUpperCase()}.`, why: 'Переносит данные из боевых систем в хранилище, где считать отчёты безопасно.', cost: 'Отчёты отстают на интервал, конвейер ломается при изменении схемы источника.', dive: 'etl' }),
    lake: () => ({ title: 'Озеро данных', how: 'Сырые события в S3 в формате Parquet под таблицами Iceberg. Запросы — через Trino или Spark.', why: 'Хранит всё сырьё годами за копейки.', cost: 'Запросы идут секунды и минуты.', dive: 'etl' }),
    tsdb: () => ({ title: 'База временных рядов', how: 'Дописывает точки «время → значение» пачками и сжимает их в 10–20 раз.', why: 'Миллионы метрик в секунду и быстрые графики по интервалам.', cost: 'Не для транзакций. Метки с высокой кардинальностью её убивают.', code: { lang: 'text', label: 'PromQL', src: `sum by (service) (rate(http_requests_total{code=~"5.."}[5m]))` }, dive: 'polyglot' }),
    graphdb: () => ({ title: 'Neo4j', how: 'Вершины и рёбра: переход по связи — указатель, а не JOIN.', why: 'Обходы на несколько уровней за миллисекунды.', cost: 'Плохо шардируется, нужна синхронизация с основной базой.', code: { lang: 'sql', label: 'Cypher', src: `MATCH (me:User {id: $id})-[:FRIEND]->()-[:FRIEND]->(fof) WHERE NOT (me)-[:FRIEND]->(fof)
RETURN fof, count(*) AS mutual ORDER BY mutual DESC LIMIT 10` }, dive: 'polyglot' }),
    esb: () => ({ title: 'Шина ESB', how: 'Центральный посредник: маршрутизирует, преобразует форматы и оркестрирует вызовы.', why: 'Удобна, чтобы склеить разнородные легаси-системы.', cost: 'Центр связности и узкое место: логика интеграций у одной команды.', code: { lang: 'java', label: 'Apache Camel', src: `from("cxf:bean:accountsSoap").unmarshal().jacksonXml()
    .choice().when(simple("\${body.type} == 'CARD'")).to("http://cards/api")
    .otherwise().to("http://accounts/api");` }, dive: 'archstyles' }),
    faas: n => ({ title: 'Serverless-функция', how: `Облако запускает функцию на каждый запрос (до ${n.props.conc} параллельно, ${n.props.mem} МБ).`, why: 'Масштабируется само и ничего не стоит без трафика.', cost: 'Холодные старты и высокая цена при постоянной нагрузке.', code: { lang: 'js', label: 'Lambda', src: `export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify(await work(event)) });` }, dive: 'archstyles' }),
    llm: n => ({ title: 'LLM', how: `${SD.LLM_SIZES[n.props.size].name}, ${n.props.hosting === 'api' ? 'облачный API' : n.props.gpus + ' своих GPU'}${n.props.stream ? ', стриминг' : ''}${n.props.pcache ? ', prompt caching' : ''}.`, why: 'Отвечает на вопросы на естественном языке.', cost: 'Секунды на ответ и цена за каждый токен.', dive: 'llm' }),
    router: () => ({ title: 'Роутер моделей', how: 'Выбирает модель под запрос и переключается на другого провайдера при сбое.', why: 'Простые вопросы отвечает дешёвая модель.', cost: 'Ошибки классификатора.', code: { lang: 'yaml', label: 'LiteLLM', src: `router_settings: { routing_strategy: cost-based-routing }
model_list:
  - { model_name: chat, litellm_params: { model: claude-haiku-4-5-20251001 } }
  - { model_name: chat, litellm_params: { model: claude-sonnet-5-5 } }
fallbacks: [{ chat: [chat-backup] }]` }, dive: 'llmops', pattern: 'modelrouter' })
  });
  ['semcache', 'guard', 'embed', 'vectordb', 'stt', 'tts', 'agent'].forEach(t => {
    X.node[t] = n => ({ title: SD.TYPES[t].name, how: SD.TYPES[t].info.what, why: SD.TYPES[t].info.why, cost: (SD.TYPES[t].info.cons || []).join('. ') + '.', dive: SD.TYPES[t].dive });
  });

  /* ---------- связи: интеграции ---------- */
  const callCode = (from, to, e) => {
    const p = Object.assign(SD.edgeDefaults(), e.props);
    if (p.proto === 'grpc') return { lang: 'go', label: 'gRPC', src: `ctx, cancel := context.WithTimeout(ctx, ${p.timeout || 1000}*time.Millisecond)   // deadline
defer cancel()
resp, err := ${(to.label || 'svc').replace(/[^A-Za-zА-Яа-я]/g, '') || 'svc'}Client.Get(ctx, &pb.Req{Id: id})${p.retries ? `  // + ${p.retries} повтора через interceptor` : ''}` };
    if (p.proto === 'graphql') return { lang: 'js', label: 'GraphQL', src: `const { data } = await client.query({ query: gql\`{ order(id: 777) { status user { name } } }\` });` };
    if (p.proto === 'soap') return { lang: 'text', label: 'SOAP', src: `POST /AccountService HTTP/1.1
Content-Type: text/xml
<soap:Envelope><soap:Body><GetBalance><Id>42</Id></GetBalance></soap:Body></soap:Envelope>` };
    const lines = [];
    if (p.cb) lines.push(`const breaker = new CircuitBreaker(callRemote, { errorThresholdPercentage: 50, resetTimeout: 10000 });`);
    if (p.fallback) lines.push(`breaker.fallback(() => ({ items: [] }));            // упрощённый ответ`);
    lines.push(`async function callRemote(id) {`);
    lines.push(`  const res = await fetch(\`http://${(to.label || to.type).toLowerCase().replace(/\s+/g, '-')}/api/items/\${id}\`${p.timeout ? `, { signal: AbortSignal.timeout(${p.timeout}) }` : ''});`);
    lines.push(`  if (!res.ok) throw new Error(res.status);`);
    lines.push(`  return res.json();`);
    lines.push(`}`);
    if (p.retries) lines.push(`const data = await retry(() => ${p.cb ? 'breaker.fire' : 'callRemote'}(id), { retries: ${p.retries}, ${p.backoff === 'exp' ? 'factor: 2, randomize: true' : 'minTimeout: 0'} });`);
    else lines.push(`const data = await ${p.cb ? 'breaker.fire' : 'callRemote'}(id);`);
    return { lang: 'js', label: 'Node.js', src: lines.join('\n') };
  };
  const E = X.edge;
  E['client>lb'] = E['client>gateway'] = E['client>esb'] = (a, b) => ({ title: `Пользователи → ${nm(b)}`, how: 'Браузер находит IP через DNS, открывает TLS-соединение и шлёт HTTPS-запросы на единый адрес.', why: 'Пользователи не знают, сколько серверов за адресом.', dive: 'request' });
  E['client>app'] = (a, b) => ({ title: `Пользователи → ${nm(b)} напрямую`, how: 'Запросы из интернета приходят на адрес одного сервера.', why: 'Работает, пока экземпляр один.', cost: b.props.count > 1 ? `У сервиса ${b.props.count} экземпляра, но работает только один: нужен балансировщик.` : 'Нельзя добавить второй экземпляр без балансировщика.', dive: 'lb' });
  E['client>cdn'] = () => ({ title: 'Статика через CDN', how: 'Ссылки на картинки и скрипты указывают на домен CDN. Браузер получает файл с ближайшего края.', code: { lang: 'text', label: 'HTML', src: `<img src="https://cdn.shop.ru/img/7.3f9a1c.webp" loading="lazy">` }, dive: 'cdn', pattern: 'cdn-p' });
  E['client>objstore'] = () => ({ title: 'Прямая загрузка в хранилище', how: 'Браузер получает от сервиса подписанную ссылку и отправляет файл прямо в S3.', why: 'Мегабайты не проходят через сервис и не занимают его потоки.', code: { lang: 'js', label: 'браузер', src: `const { url } = await api.post('/uploads', { name: file.name });   // сервис подписал ссылку
await fetch(url, { method: 'PUT', body: file });                    // байты — прямо в S3` }, dive: 'objstore', pattern: 'valetkey' });
  E['client>tsdb'] = () => ({ title: 'Агенты пишут метрики напрямую', how: 'Агент на сервере собирает метрики и отправляет их пачками в базу временных рядов.', why: 'Телеметрия не проходит через бизнес-API.', code: { lang: 'yaml', label: 'vmagent', src: `remote_write:
  - url: http://victoria:8428/api/v1/write
    queue_config: { max_samples_per_send: 10000 }` } });
  E['client>ws'] = () => ({ title: 'WebSocket напрямую', how: 'Клиенты подключаются к одному серверу.', cost: 'Без балансировщика не масштабируется.', dive: 'websocket' });
  ['lb', 'gateway', 'esb'].forEach(f => { E[f + '>app'] = (a, b, e) => ({ title: `${nm(a)} → ${nm(b)}`, how: `${nm(a)} проксирует запросы экземплярам сервиса${SD.PROTOCOLS[(e.props || {}).proto || 'rest'] ? ' по ' + SD.PROTOCOLS[(e.props || {}).proto || 'rest'].name : ''}.`, why: 'Запросы распределяются, упавшие экземпляры исключаются.', code: callCode(a, b, e), dive: 'protocols' }); });
  E['lb>ws'] = () => ({ title: 'Балансировщик → WebSocket', how: 'Балансировщик поднимает WebSocket-соединение (Upgrade) и держит его открытым.', code: { lang: 'yaml', label: 'nginx', src: `location /ws { proxy_pass http://ws; proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 1h; }` }, dive: 'websocket' });
  E['app>app'] = (a, b, e) => ({ title: `Синхронный вызов ${nm(a)} → ${nm(b)}`, how: `${nm(a)} вызывает ${nm(b)} и ждёт ответа. ${a.props.txMode === 'saga' ? 'Запись идёт шагом саги через брокер, с компенсацией при сбое.' : a.props.txMode === '2pc' ? 'Запись координируется двухфазным коммитом.' : ''}`, why: 'Просто и сразу видно результат.', cost: 'Задержки складываются, а отказ вызываемого бьёт по вызывающему. Нужны таймаут, повтор с паузой и предохранитель — их настраивают на этой связи.', code: callCode(a, b, e), dive: 'resilience' });
  E['app>cache'] = (a, b) => ({ title: `${nm(a)} читает через кэш`, how: `Cache-aside: сначала Redis, при промахе база, потом запись в кэш с TTL. ${b.props.invalidate !== false ? 'При записи ключ удаляется.' : 'Ключи при записи не удаляются, и старые данные живут до конца TTL.'}`, why: 'Большая часть чтений не доходит до базы.', cost: 'Устаревшие данные и риск stampede.', code: X.node.cache(b).code, dive: 'cache', pattern: 'cacheaside' });
  E['app>sql'] = (a, b) => ({ title: `${nm(a)} → PostgreSQL`, how: `Пул из 10 соединений на экземпляр${b.props.pooler ? ' через PgBouncer' : ''}. ${b.props.replicas ? `Записи идут на primary, чтения — на ${b.props.replicas} реплик(и)${b.props.ryw ? ', недавно писавшие читают с primary' : ''}.` : 'Всё идёт на один primary.'}`, why: 'Транзакции и согласованность для важных данных.', cost: `${(a.props.count || 1) * 10} соединений от этого сервиса при лимите ≈ 200 на сервер.`, code: { lang: 'python', label: 'asyncpg', src: `pool = await asyncpg.create_pool(dsn=${b.props.pooler ? '"postgres://pgbouncer:6432/shop"' : '"postgres://pg-primary:5432/shop"'}, max_size=10)
async with pool.acquire() as c:
    async with c.transaction(isolation=${JSON.stringify({ rc: 'read_committed', rr: 'repeatable_read', ser: 'serializable' }[b.props.isolation])}):
        row = await c.fetchrow("SELECT * FROM orders WHERE id = $1${b.props.locking === 'pessimistic' ? ' FOR UPDATE' : ''}", oid)` }, dive: 'replication' });
  E['app>nosql'] = E['ws>nosql'] = E['worker>nosql'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: `Драйвер считает хэш ключа партиции и идёт сразу к узлам-владельцам. Согласованность ${String(b.props.cl).toUpperCase()}.`, why: 'Запись и чтение по ключу масштабируются числом узлов.', code: { lang: 'python', label: 'cassandra-driver', src: `stmt = SimpleStatement("INSERT INTO messages_by_chat (chat_id, ts, author, text) VALUES (%s, now(), %s, %s)",
                       consistency_level=ConsistencyLevel.${String(b.props.cl).toUpperCase()})
session.execute(stmt, (chat_id, author, text))` }, dive: 'polyglot' });
  E['app>queue'] = (a, b) => ({ title: `${nm(a)} публикует в брокер`, how: `Сервис кладёт событие и сразу отвечает пользователю.${a.props.outbox ? ' Через outbox: событие пишется в ту же транзакцию, что и данные.' : ' Запись в базу и публикация не атомарны (dual write).'}`, why: 'Пользователь не ждёт долгую работу, пики копятся в очереди.', cost: a.props.outbox ? 'Нужен процесс-ретранслятор outbox.' : 'Если сервис упадёт между записью в базу и публикацией, событие потеряется.', code: b.props.engine === 'kafka' ? { lang: 'python', label: 'producer', src: `producer = Producer({"acks": "${b.props.acks}", "enable.idempotence": True})
producer.produce("orders", key=str(order.user_id), value=order.json())   # ключ → партиция` } : { lang: 'python', label: 'publish', src: `channel.basic_publish("", "orders", body=order.json(), properties=BasicProperties(delivery_mode=2))` }, dive: 'queue', pattern: a.props.outbox ? 'outbox' : 'pubsub' });
  E['queue>worker'] = E['queue>app'] = (a, b) => ({ title: `${nm(b)} читают из брокера`, how: `Группа потребителей делит ${a.props.engine === 'kafka' ? a.props.partitions + ' партиций' : 'очередь'} между ${b.props.count || 1} экземплярами. Семантика: ${({ most: 'at-most-once', least: 'at-least-once', exactly: 'exactly-once' })[a.props.semantics]}.${a.props.retries ? ' Ошибки повторяются, безнадёжные уходят в DLQ.' : ''}`, why: 'Конкурирующие потребители масштабируют обработку.', cost: a.props.semantics === 'most' ? 'Упавший обработчик теряет сообщение.' : 'Повторная доставка: обработчик должен быть идемпотентным.', code: { lang: 'python', label: 'consumer', src: `consumer = Consumer({"group.id": "${(b.label || 'workers').toLowerCase()}", "enable.auto.commit": False})
consumer.subscribe(["orders"])
while (msg := consumer.poll(1.0)) is not None:
    ${a.props.semantics === 'most' ? 'consumer.commit(msg)   # сначала коммит — потеря при сбое\n    handle(msg)' : 'handle(msg)\n    consumer.commit(msg)   # после обработки — at-least-once'}` }, dive: 'queue', pattern: 'queue-cc' });
  E['worker>external'] = E['app>external'] = E['agent>external'] = (a, b, e) => ({ title: `${nm(a)} → ${nm(b)}`, how: `HTTP-вызов чужого API.${a.type === 'app' ? ' Прямо в запросе пользователя: он ждёт ответа провайдера.' : ' Из фоновой задачи: пользователь не ждёт.'}`, why: a.type === 'app' ? 'Просто, но пользователь ждёт, а сбои провайдера становятся вашими ошибками.' : 'Сбои провайдера не задевают пользователя, их можно повторить.', cost: 'Нужны таймаут, повторы с паузой и ключ идемпотентности.', code: { lang: 'python', label: 'httpx', src: `resp = await http.post(PROVIDER_URL, json=payload,
                       headers={"Idempotency-Key": task.id},          # повтор не задвоит
                       timeout=${(((e.props || {}).timeout) || 3000) / 1000})` }, dive: 'resilience', pattern: 'retry' });
  E['app>objstore'] = (a) => ({ title: `${nm(a)} → S3`, how: 'Сервис сам читает и пишет файлы в хранилище и пропускает байты через себя.', cost: 'Каждый файл занимает поток и канал сервиса. Лучше presigned URL для загрузки и CDN для раздачи.', dive: 'objstore', pattern: 'valetkey' });
  E['worker>objstore'] = () => ({ title: 'Обработчик пишет результат в S3', how: 'Например, перекодированное видео или превью.', code: { lang: 'python', label: 'boto3', src: `s3.upload_file("/tmp/out_720p.mp4", "media", f"hls/{video_id}/720p.mp4")` } });
  E['objstore>queue'] = () => ({ title: 'Событие S3 → очередь', how: 'Хранилище само публикует событие ObjectCreated о каждом новом файле.', why: 'Никто не опрашивает бакет в цикле.', code: { lang: 'js', label: 'S3 notification', src: `{ "QueueConfigurations": [{ "QueueArn": "arn:aws:sqs:...:uploads",
  "Events": ["s3:ObjectCreated:*"], "Filter": { "Key": { "FilterRules": [{ "Name": "prefix", "Value": "raw/" }] } } }] }` }, dive: 'objstore' });
  E['cdn>objstore'] = E['cdn>lb'] = (a, b) => ({ title: `CDN → источник (${nm(b)})`, how: 'При промахе край идёт в источник и кладёт ответ в свой кэш.', code: { lang: 'yaml', label: 'origin', src: `origins: [{ domain: media.s3.amazonaws.com, shield: ${a.props.shield ? 'frankfurt' : 'none'} }]` }, dive: 'cdn' });
  E['sql>cdc'] = () => ({ title: 'База → CDC', how: 'Debezium подключается к логической репликации PostgreSQL и читает WAL.', code: X.node.cdc().code, dive: 'cdc', pattern: 'cdc-p' });
  E['cdc>queue'] = () => ({ title: 'CDC → брокер', how: 'Каждое изменение строки становится сообщением в топике shop.public.orders с ключом = первичный ключ.', why: 'Порядок изменений одной строки сохраняется в партиции.', dive: 'cdc' });
  E['sql>etl'] = (a, b) => ({ title: 'Конвейер забирает изменения', how: b.props.mode === 'stream' ? 'Потоково, через логическую репликацию.' : `Раз в ${b.props.mode === 'hourly' ? 'час' : 'сутки'} выгружает строки, изменённые с прошлого запуска.`, cost: a.props.replicas ? 'Читает с реплики — primary не страдает.' : 'Реплик нет: выгрузка нагружает primary.', code: { lang: 'sql', label: 'выгрузка', src: `SELECT * FROM orders WHERE updated_at > :last_run ORDER BY updated_at;` }, dive: 'etl' });
  E['app>search'] = () => ({ title: 'Запросы к поиску', how: 'Сервис отправляет запрос в индекс и получает ID найденных документов с оценкой релевантности.', code: X.node.search().code, dive: 'search' });
  E['worker>search'] = E['queue>search'] = E['cdc>search'] = () => ({ title: 'Индексатор наполняет поиск', how: 'Изменения из очереди пачками отправляются в индекс через bulk API.', code: { lang: 'js', label: 'bulk', src: `POST /_bulk
{ "index": { "_index": "products", "_id": "7" } }
{ "title": "Пуховик зимний", "price": 9990 }` }, dive: 'search' });
  E['worker>cache'] = () => ({ title: 'Обработчик пишет в кэш', how: 'Например, раскладывает новый пост в ленты подписчиков (fan-out on write).', code: { lang: 'python', label: 'redis', src: `pipe = r.pipeline()
for follower in followers(author):
    pipe.lpush(f"feed:{follower}", post_id); pipe.ltrim(f"feed:{follower}", 0, 499)
pipe.execute()` }, dive: 'cache' });
  E['ws>queue'] = E['ws>cache'] = () => ({ title: 'Шлюз ↔ pub/sub', how: 'Сервер отправителя публикует сообщение в канал получателя, сервер получателя доставляет его в сокет.', dive: 'websocket', code: X.node.ws({ props: { count: 2 } }).code });
  E['app>olap'] = () => ({ title: 'Дашборды читают ClickHouse', how: 'Отчёты идут в аналитическое хранилище, а не в боевую базу.', code: X.node.olap({ props: { count: 1, schema: 'star', mv: false } }).code, dive: 'olap' });
  E['queue>etl'] = E['etl>olap'] = E['etl>lake'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: b.type === 'lake' ? 'Сырые события пишутся в Parquet по партициям дат.' : b.type === 'olap' ? 'События вставляются пачками в таблицу фактов.' : 'Конвейер читает события из брокера.', dive: 'etl' });
  E['app>tsdb'] = () => ({ title: 'Дашборды по метрикам', how: 'Запросы PromQL по агрегатам.', code: X.node.tsdb().code });
  E['app>graphdb'] = () => ({ title: 'Обход графа', how: 'Запрос Cypher идёт по связям от вершины пользователя.', code: X.node.graphdb().code, dive: 'polyglot' });
  E['app>llm'] = E['router>llm'] = E['agent>llm'] = E['stt>llm'] = (a, b) => ({ title: `${nm(a)} → LLM`, how: `Вызов модели${b.props.stream ? ' со стримингом токенов' : ''}${b.props.pcache ? ' и кэшированием промпта' : ''}.`, code: { lang: 'python', label: 'Anthropic SDK', src: `with client.messages.stream(model="claude-sonnet-5-5", max_tokens=${b.props.maxOut},
        system=[{"type": "text", "text": POLICY${b.props.pcache ? ', "cache_control": {"type": "ephemeral"}' : ''}}],
        messages=[{"role": "user", "content": q}]) as s:
    for t in s.text_stream: send(t)` }, dive: 'llm' });
  E['app>router'] = () => ({ title: 'Сервис → роутер моделей', how: 'Все вызовы моделей идут через одну точку с учётом лимитов, бюджета и фолбэков.', code: X.node.router().code, dive: 'llmops' });
  E['app>vectordb'] = E['app>embed'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: b.type === 'embed' ? 'Вопрос превращается в вектор.' : 'Поиск ближайших кусков документов к вектору вопроса.', code: { lang: 'python', label: 'Qdrant', src: `hits = qdrant.search("docs", query_vector=embed(question), limit=5)` }, dive: 'rag' });
  E['worker>embed'] = E['worker>vectordb'] = () => ({ title: 'Индексация документов', how: 'Документы режутся на куски, превращаются в векторы и кладутся в векторную базу.', dive: 'rag' });
  E['app>guard'] = E['app>semcache'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: SD.TYPES[b.type].info.what, dive: 'llmops' });
  E['app>stt'] = E['llm>tts'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: b.type === 'stt' ? 'Аудио передаётся потоком, текст приходит по мере распознавания.' : 'Ответ синтезируется по предложениям, звук начинает играть сразу.', dive: 'voice' });
  E['app>agent'] = E['agent>app'] = E['agent>search'] = E['agent>vectordb'] = (a, b) => ({ title: `${nm(a)} → ${nm(b)}`, how: a.type === 'agent' ? `«${nm(b)}» — инструмент агента: модель решает, когда его вызвать.` : 'Сервис передаёт задачу агенту.', dive: 'agent' });
})();
