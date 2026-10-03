/* Разборы, часть 3: оценка, протоколы, брокеры, доставка, устойчивость. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const D = SD.DIVES;

  D.estimate = {
    title: 'Оценка нагрузки на салфетке', icon: 'client', lede: 'От числа пользователей к RPS, объёму данных и числу серверов за пять минут.',
    actors: [
      { id: 'u', x: 20, y: 30, w: 180, label: 'Аудитория', sub: '10 млн активных в день' },
      { id: 'rps', x: 240, y: 30, w: 170, label: 'Запросы' },
      { id: 'w', x: 450, y: 30, w: 170, label: 'Записи' },
      { id: 'st', x: 240, y: 220, w: 170, label: 'Хранилище' },
      { id: 'srv', x: 450, y: 220, w: 170, label: 'Серверы' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
dau = 10_000_000              # активных в день
actions = 20                  # действий на пользователя в день
rps_avg = dau * actions / 86_400        # ≈ 2 300 RPS
rps_peak = rps_avg * 3                  # пик ≈ 7 000 RPS

writes_share = 0.1
write_rps = rps_peak * writes_share     # ≈ 700 записей/с

record = 1_000                          # байт на запись
per_day = dau * actions * writes_share * record   # ≈ 20 ГБ в сутки
per_5y = per_day * 365 * 5                         # ≈ 36 ТБ

servers = rps_peak / 2_500 * 1.5        # запас 50 % → 5 серверов` }
    ],
    steps: [
      { title: 'Сколько людей', text: 'Начинают с активных в день (DAU), а не со всех зарегистрированных. 10 млн DAU, каждый делает ≈ 20 действий.', hl: ['u'], c: [1, 2] },
      { title: 'Средний RPS', text: 'В сутках 86 400 секунд, для прикидки — 100 000. 200 млн действий в сутки — это ≈ 2 300 запросов в секунду в среднем.', msgs: [{ from: 'u', to: 'rps', label: '÷ 86 400' }], lines: { rps: ['среднее ≈ 2 300 RPS'] }, c: [3] },
      { title: 'Пик', text: 'Нагрузка неровная: вечером и в праздники в 2–5 раз выше средней. Систему считают на пик.', lines: { rps: ['среднее ≈ 2 300 RPS', 'пик ≈ 7 000 RPS'] }, c: [4] },
      { title: 'Записи', text: 'Обычно записей в 10–100 раз меньше, чем чтений. Здесь 10 % — около 700 записей в секунду. Это нагрузка на primary базы.', msgs: [{ from: 'rps', to: 'w', label: '× 10 %' }], lines: { w: ['≈ 700 записей/с'] }, c: [6, 7] },
      { title: 'Объём данных', text: 'Килобайт на запись даёт ≈ 20 ГБ в сутки и ≈ 36 ТБ за пять лет. Значит, шардирование или архив понадобятся заранее.', msgs: [{ from: 'w', to: 'st', label: '× 1 КБ × 5 лет' }], lines: { st: ['≈ 20 ГБ в сутки', '≈ 36 ТБ за 5 лет'] }, c: [9, 10, 11] },
      { title: 'Серверы', text: 'Один сервер держит ≈ 2 500 RPS. На пик нужно 3, с запасом 50 % — 5. Этого хватит, чтобы пережить падение одного.', msgs: [{ from: 'rps', to: 'srv', label: '÷ 2 500 × 1,5' }], lines: { srv: ['5 серверов'] }, c: [13] },
      { title: 'Порядок, а не точность', text: 'Цель — порядок величины. 7 000 и 70 000 RPS — разные архитектуры, 7 000 и 8 000 — одна и та же. Цифры для прикидок — в справочнике.', good: ['srv'] }
    ]
  };

  D.protocols = {
    title: 'Протоколы: REST, gRPC, GraphQL, вебхуки', icon: 'lb', lede: 'Чем отличаются способы общения систем и когда какой выбирать.',
    actors: [
      { id: 'cl', x: 20, y: 140, w: 130, label: 'Клиент', sub: 'браузер' },
      { id: 'api', x: 220, y: 140, w: 150, label: 'API / BFF' },
      { id: 's1', x: 450, y: 40, w: 170, label: 'Сервис заказов' },
      { id: 's2', x: 450, y: 240, w: 170, label: 'Сервис профилей' }
    ],
    code: [
      { label: 'REST', lang: 'text', src: `
GET /orders/777 HTTP/1.1
Accept: application/json

200 OK
{"id": 777, "status": "paid", "items": [...], "user": {"id": 42, "name": "Анна"}}` },
      { label: 'gRPC', lang: 'js', src: `
syntax = "proto3";
service Orders {
  rpc GetOrder (OrderId) returns (Order);
  rpc WatchOrders (UserId) returns (stream Order);   // стриминг
}
message OrderId { int64 id = 1; }
message Order { int64 id = 1; string status = 2; int64 total = 3; }` },
      { label: 'GraphQL', lang: 'yaml', src: `
query {
  order(id: 777) {
    status
    user { name }          # данные двух сервисов одним запросом
  }
}` },
      { label: 'Webhook', lang: 'text', src: `
POST https://shop.ru/hooks/payment
X-Signature: sha256=9f86d0…            ← проверяем подпись!
{"event": "payment.succeeded", "order_id": 777}` }
    ],
    steps: [
      { title: 'REST', text: 'Ресурсы и методы HTTP, текстовый JSON. Понятно всем, кэшируется средствами HTTP. Минусы: набор полей фиксирован, и для одного экрана часто нужно несколько запросов.', msgs: [{ from: 'cl', to: 'api', label: 'GET /orders/777' }, { from: 'api', to: 'cl', label: 'JSON целиком', color: 'ok', lane: 1 }], c: { 0: [1, 2, 3, 4, 5] } },
      { title: 'GraphQL', text: 'Клиент сам выбирает поля и одним запросом получает данные нескольких сервисов. Сервер тратит больше на резолверы, а кэшировать и ограничивать сложнее: один запрос может оказаться очень тяжёлым.', msgs: [{ from: 'cl', to: 'api', label: 'query { order, user }' }, { from: 'api', to: 's1', label: 'order' }, { from: 'api', to: 's2', label: 'user' }], c: { 2: [1, 2, 3, 4, 5, 6] } },
      { title: 'gRPC между сервисами', text: 'Бинарный Protobuf поверх HTTP/2, строгая схема .proto и генерация клиентов. На 30–40 % дешевле по CPU, чем JSON. Браузеру напрямую неудобен: нужен gRPC-Web или прокси.', msgs: [{ from: 'api', to: 's1', label: 'GetOrder (Protobuf)', color: 'ok' }], c: { 1: [1, 2, 3, 6, 7] } },
      { title: 'Потоки', text: 'Когда сервер должен сам присылать обновления: gRPC-стриминг между сервисами, WebSocket для двустороннего канала с браузером, SSE — простой односторонний поток событий поверх HTTP.', msgs: [{ from: 's1', to: 'api', label: 'stream Order' }, { from: 'api', to: 'cl', label: 'SSE / WebSocket', lane: 1 }], c: { 1: [4] } },
      { title: 'Вебхук', text: 'Обратный вызов: внешний сервис сам присылает событие на ваш URL. Подпись проверяют обязательно, а обработку делают идемпотентной: вебхук могут прислать повторно.', msgs: [{ from: 's2', to: 'api', label: 'POST /hooks/payment', color: 'warn' }], c: { 3: [1, 2, 3] } },
      { title: 'SOAP', text: 'XML-конверты по WSDL-контракту и WS-Security. Самый тяжёлый по разбору, но живёт в банках и госсистемах. Новые интеграции почти всегда делают на REST или gRPC.' }
    ]
  };

  D.queue = {
    title: 'Kafka изнутри: партиции и группы', icon: 'queue', lede: 'Ключи, партиции, acks, offset, группы потребителей, ребаланс и лаг.',
    actors: [
      { id: 'pr', x: 20, y: 140, w: 130, label: 'Продюсер' },
      { id: 'p0', x: 220, y: 30, w: 190, label: 'Партиция 0' },
      { id: 'p1', x: 220, y: 140, w: 190, label: 'Партиция 1' },
      { id: 'p2', x: 220, y: 250, w: 190, label: 'Партиция 2' },
      { id: 'c1', x: 470, y: 70, w: 150, label: 'Потребитель A' },
      { id: 'c2', x: 470, y: 230, w: 150, label: 'Потребитель B' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
from confluent_kafka import Producer, Consumer

p = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
p.produce("orders", key=str(order.user_id), value=json.dumps(order))   # ключ → партиция
p.flush()

c = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "billing",
              "enable.auto.commit": False})
c.subscribe(["orders"])
while True:
    msg = c.poll(1.0)
    if msg is None:
        continue
    handle(json.loads(msg.value()))      # сначала обработать
    c.commit(msg)                        # потом сдвинуть offset: at-least-once` }
    ],
    steps: [
      { title: 'Топик — это партиции', text: 'Топик делится на партиции — независимые журналы. Сообщение дописывается в конец партиции и получает номер (offset). Читать можно с любого места, сообщения не удаляются после чтения.', lines: { p0: ['0 1 2 3'], p1: ['0 1 2'], p2: ['0 1'] } },
      { title: 'Ключ выбирает партицию', text: 'Партиция = hash(key) % число партиций. Все события одного пользователя попадают в одну партицию и читаются строго по порядку. Между партициями порядка нет.', msgs: [{ from: 'pr', to: 'p1', label: 'key = user:42' }], lines: { p1: ['0 1 2 3 ← новое'] }, c: [4] },
      { title: 'acks=all', text: 'Продюсер ждёт, пока сообщение запишут лидер и все синхронные реплики (ISR). Падение брокера его не потеряет. Идемпотентный продюсер не создаст дубль, если отправка повторится.', hl: ['p1'], c: [3, 5] },
      { title: 'Группа потребителей', text: 'Группа billing делит партиции между участниками: одну партицию читает один потребитель. Потребителей больше, чем партиций, — лишние простаивают. Другая группа читает тот же топик независимо.', msgs: [{ from: 'p0', to: 'c1', label: 'P0' }, { from: 'p1', to: 'c1', label: 'P1' }, { from: 'p2', to: 'c2', label: 'P2' }], c: [7, 8, 9] },
      { title: 'Коммит offset', text: 'Потребитель обработал сообщение и фиксирует offset. Если он упадёт до коммита, после перезапуска прочитает сообщение снова: доставка «хотя бы один раз».', msgs: [{ from: 'c1', to: 'p0', label: 'commit offset 4', color: 'ok' }], c: [10, 11, 12, 13, 14, 15] },
      { title: 'Ребаланс', text: 'Потребитель B упал, и группа перераспределяет его партиции. Пока идёт ребаланс, чтение замирает на секунды. Частые ребалансы — частая причина роста лага.', bad: ['c2'], badge: { c2: 'DOWN' }, msgs: [{ from: 'p2', to: 'c1', label: 'P2 → A', color: 'warn' }] },
      { title: 'Лаг', text: 'Лаг — разница между концом партиции и offset группы. Растёт лаг — добавляй потребителей (до числа партиций) или ускоряй обработку пачками. Главная метрика брокера.', lines: { p2: ['конец: 9 120', 'группа на: 8 400', 'лаг 720'] } }
    ]
  };

  D.delivery = {
    title: 'Гарантии доставки, повторы и DLQ', icon: 'worker', lede: 'At-most-once, at-least-once, exactly-once, идемпотентный потребитель и Dead Letter Queue.',
    actors: [
      { id: 'k', x: 20, y: 140, w: 130, label: 'Брокер' },
      { id: 'w', x: 220, y: 140, w: 170, label: 'Обработчик' },
      { id: 'db', x: 460, y: 30, w: 160, label: 'БД', sub: 'таблица inbox' },
      { id: 'ext', x: 460, y: 150, w: 160, label: 'Платёжный API' },
      { id: 'dlq', x: 460, y: 260, w: 160, label: 'DLQ', sub: 'orders.DLQ' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
def handle(msg):
    with db.transaction():
        if db.exists("SELECT 1 FROM inbox WHERE msg_id = %s", msg.id):
            return                                  # дубль — уже обработали
        apply_business_logic(msg)
        db.execute("INSERT INTO inbox (msg_id) VALUES (%s)", msg.id)

def consume(msg):
    for attempt in range(5):
        try:
            handle(msg); return
        except TemporaryError:
            time.sleep(min(30, 2 ** attempt) + random.random())   # backoff + jitter
        except PoisonMessage:
            break
    publish("orders.DLQ", msg, reason=traceback.format_exc())   # парковка` }
    ],
    steps: [
      { title: 'At-most-once', text: 'Коммит offset до обработки. Упал обработчик — сообщение потеряно. Годится для метрик и логов, где потеря одной точки не страшна.', bad: ['w'], badge: { w: 'LOST' }, msgs: [{ from: 'k', to: 'w', label: 'msg 17' }] },
      { title: 'At-least-once', text: 'Коммит после обработки. Упал между обработкой и коммитом — сообщение придёт снова. Потерь нет, но возможны дубли. Это режим по умолчанию в большинстве систем.', msgs: [{ from: 'k', to: 'w', label: 'msg 17' }, { from: 'w', to: 'db', label: 'обработал' }, { from: 'w', to: 'k', label: 'commit', color: 'ok', lane: 1 }] },
      { title: 'Дубль', text: 'Без защиты повтор выполнит действие второй раз: спишет деньги или отправит письмо дважды.', bad: ['w'], badge: { w: 'ДУБЛЬ' }, msgs: [{ from: 'k', to: 'w', label: 'msg 17 (повтор)', color: 'bad' }] },
      { title: 'Идемпотентный потребитель', text: 'ID сообщения пишется в таблицу inbox в той же транзакции, что и результат. Повтор распознаётся и пропускается. Для внешних API тот же приём — ключ идемпотентности в запросе.', good: ['w'], msgs: [{ from: 'w', to: 'db', label: 'msg 17 уже есть?' }, { from: 'db', to: 'w', label: 'да — пропустить', color: 'ok', lane: 1 }], c: [1, 2, 3, 4, 5, 6] },
      { title: 'Повторы с паузой', text: 'Временная ошибка (таймаут, 503) лечится повтором. Паузу растят экспоненциально и добавляют случайный джиттер, чтобы тысячи обработчиков не били в сервис одновременно.', msgs: [{ from: 'w', to: 'ext', label: 'попытка 1: 503', color: 'bad' }, { from: 'w', to: 'ext', label: 'через 2 с: ok', color: 'ok', lane: 1 }], c: [8, 9, 10, 11, 12, 13] },
      { title: 'Dead Letter Queue', text: 'Ядовитое сообщение (битый JSON, нарушенный контракт) не пройдёт никогда. После N попыток его паркуют в DLQ вместе с причиной, чтобы оно не блокировало очередь. Потом разбирают и переотправляют.', badge: { dlq: 'DLQ' }, msgs: [{ from: 'w', to: 'dlq', label: 'msg 23 + причина', color: 'warn' }], lines: { dlq: ['msg 23: invalid JSON'] }, c: [14, 15, 16] },
      { title: 'Exactly-once', text: 'В Kafka exactly-once — это транзакции: чтение, запись в другие топики и коммит offset атомарны. На внешний мир (БД, почта, платежи) гарантия не распространяется. Там работает только идемпотентность.' }
    ]
  };

  D.resilience = {
    title: 'Устойчивость: таймауты, повторы, предохранители', icon: 'external', lede: 'Как медленная зависимость роняет всё и какие паттерны это останавливают.',
    actors: [
      { id: 'f', x: 20, y: 130, w: 170, label: 'Витрина', sub: '200 потоков' },
      { id: 'cat', x: 300, y: 30, w: 170, label: 'Каталог' },
      { id: 'recs', x: 300, y: 240, w: 170, label: 'Рекомендации' },
      { id: 'u', x: 520, y: 130, w: 100, label: 'Страница' }
    ],
    code: [
      { label: 'Java · Resilience4j', lang: 'java', src: `
@CircuitBreaker(name = "recs", fallbackMethod = "noRecs")
@Retry(name = "recs")
@Bulkhead(name = "recs", type = Bulkhead.Type.THREADPOOL)
@TimeLimiter(name = "recs")
public CompletableFuture<List<Item>> recommendations(long userId) {
    return CompletableFuture.supplyAsync(() -> recsClient.get(userId));
}

private CompletableFuture<List<Item>> noRecs(long userId, Throwable t) {
    return CompletableFuture.completedFuture(List.of());   // страница без блока
}` },
      { label: 'application.yml', lang: 'yaml', src: `
resilience4j:
  timelimiter.instances.recs.timeoutDuration: 300ms
  retry.instances.recs:
    maxAttempts: 2
    waitDuration: 100ms
    enableExponentialBackoff: true
    randomizedWaitFactor: 0.5          # джиттер
  circuitbreaker.instances.recs:
    failureRateThreshold: 50           # % ошибок, чтобы разомкнуть
    slidingWindowSize: 50
    waitDurationInOpenState: 10s       # потом half-open: пробные вызовы
  bulkhead.instances.recs.maxConcurrentCalls: 20   # не больше 20 потоков на рекомендации` }
    ],
    steps: [
      { title: 'Медленная зависимость', text: 'Рекомендации тормозят: отвечают за 4 секунды. Без таймаута каждый поток витрины ждёт. Потоки кончаются, и витрина перестаёт отвечать даже там, где рекомендации не нужны. Это каскадный отказ.', bad: ['f', 'recs'], msgs: [{ from: 'f', to: 'recs', label: 'запрос' }, { from: 'recs', to: 'f', label: '… 4 с', color: 'bad', lane: 1 }], lines: { f: ['свободных потоков: 0'] } },
      { title: 'Таймаут', text: 'Таймаут ограничивает ожидание. Его выбирают по p99 зависимости с небольшим запасом, а не «30 секунд на всякий случай».', msgs: [{ from: 'f', to: 'recs', label: 'таймаут 300 мс', color: 'warn' }], lines: { f: ['свободных потоков: 140'] }, c: { 0: [4], 1: [2] } },
      { title: 'Повторы и шторм', text: 'Повтор спасает от случайного сбоя, но при перегрузке утраивает нагрузку на и так больной сервис — retry storm. Повторяют мало, с экспоненциальной паузой и джиттером, и следят за долей повторов.', badge: { recs: '×3' }, msgs: [{ from: 'f', to: 'recs', label: 'попытка 1', color: 'bad', lane: -1 }, { from: 'f', to: 'recs', label: 'попытка 2', color: 'bad' }, { from: 'f', to: 'recs', label: 'попытка 3', color: 'bad', lane: 1 }], c: { 0: [2], 1: [3, 4, 5, 6, 7] } },
      { title: 'Circuit breaker', text: 'Когда больше половины вызовов падает, предохранитель размыкается: вызовы отбиваются сразу, не нагружая упавший сервис. Через 10 секунд он пропускает пробные вызовы (half-open) и замыкается, если те прошли.', badge: { f: 'CB OPEN' }, dim: ['recs'], lines: { f: ['вызовы отбиваются за 0 мс'] }, c: { 0: [1], 1: [8, 9, 10, 11] } },
      { title: 'Fallback', text: 'При отказе возвращаем упрощённый ответ: страницу без блока рекомендаций. Каталог и цена важнее. Пользователь почти не замечает сбоя.', good: ['u'], msgs: [{ from: 'f', to: 'cat', label: 'каталог', color: 'ok' }, { from: 'f', to: 'u', label: 'страница без рекомендаций', color: 'ok' }], c: { 0: [9, 10, 11] } },
      { title: 'Bulkhead', text: 'Переборки, как в корабле: отдельный пул из 20 потоков на рекомендации. Даже если все они зависнут, остальные 180 потоков витрины обслуживают каталог.', hl: ['f'], lines: { f: ['пул recs: 20 потоков', 'остальное: 180'] }, c: { 0: [3], 1: [12] } }
    ]
  };
})();
