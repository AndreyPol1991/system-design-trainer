/* Разборы, часть 2: данные и согласованность. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const D = SD.DIVES;

  D.replication = {
    title: 'Репликация, лаг и failover', icon: 'sql', lede: 'Как WAL доходит до реплик, откуда берётся «я сохранил, а вижу старое» и что происходит при падении primary.',
    actors: [
      { id: 'app', x: 20, y: 140, w: 130, label: 'Сервис' },
      { id: 'p', x: 230, y: 140, w: 160, label: 'Primary', sub: 'принимает запись' },
      { id: 'r1', x: 470, y: 40, w: 150, label: 'Реплика 1' },
      { id: 'r2', x: 470, y: 240, w: 150, label: 'Реплика 2' }
    ],
    code: [
      { label: 'postgresql.conf', lang: 'yaml', src: `
# primary
wal_level = replica
max_wal_senders = 10
synchronous_commit = on
synchronous_standby_names = 'ANY 1 (replica1, replica2)'   # полусинхронно

# отставание реплик смотрим на primary:
# SELECT client_addr, replay_lag FROM pg_stat_replication;` },
      { label: 'Python · маршрутизация', lang: 'python', src: `
class Router:
    def __init__(self, primary, replicas):
        self.primary, self.replicas = primary, replicas

    def for_write(self):
        return self.primary

    def for_read(self, session):
        # read-your-writes: недавно писал — читаем с primary
        if time.time() - session.last_write_at < 5:
            return self.primary
        return random.choice(self.replicas)

def save_profile(session, data):
    router.for_write().execute("UPDATE users SET avatar=%s WHERE id=%s", data.avatar, session.user_id)
    session.last_write_at = time.time()` }
    ],
    steps: [
      { title: 'Запись идёт на primary', text: 'Все изменения принимает один сервер. Сначала он записывает их в журнал WAL — это гарантия, что изменение переживёт перезапуск.', hl: ['p'], msgs: [{ from: 'app', to: 'p', label: 'UPDATE avatar' }], lines: { p: ['WAL #1042 UPDATE users'] }, c: { 0: [2], 1: [5, 6] } },
      { title: 'Журнал уходит на реплики', text: 'Primary отправляет WAL репликам, и те проигрывают его у себя. Реплика — точная копия базы, только с небольшой задержкой.', msgs: [{ from: 'p', to: 'r1', label: 'WAL #1042' }, { from: 'p', to: 'r2', label: 'WAL #1042' }], c: { 0: [1, 2, 3] } },
      { title: 'Синхронно или нет', text: 'Асинхронно primary отвечает «готово», не дожидаясь реплик: быстро, но при его падении последние транзакции пропадут. Полусинхронно ждём хотя бы одну реплику: чуть дольше, зато без потерь.', lines: { r1: ['применено #1042'], r2: ['применено #1039', 'лаг 40 мс'] }, c: { 0: [4, 5] } },
      { title: 'Чтения расходятся по репликам', text: 'Каждая реплика добавляет ≈ 5 000 чтений в секунду. Запись так не масштабируется: она всегда идёт на primary.', msgs: [{ from: 'app', to: 'r1', label: 'SELECT', color: 'read' }, { from: 'app', to: 'r2', label: 'SELECT', color: 'read' }], c: { 1: [8, 9, 12] } },
      { title: 'Лаг репликации', text: 'Пользователь сохранил аватар и сразу обновил страницу. Запрос попал на отстающую реплику, и вернулся старый аватар. Под нагрузкой лаг растёт от миллисекунд до секунд.', bad: ['r2'], badge: { r2: 'ЛАГ' }, msgs: [{ from: 'app', to: 'r2', label: 'SELECT avatar' }, { from: 'r2', to: 'app', label: 'старый аватар', color: 'bad', lane: 1 }], c: { 0: [7, 8] } },
      { title: 'Read-your-writes', text: 'Решение: несколько секунд после записи читать этого пользователя с primary. Остальные по-прежнему читают с реплик.', good: ['app'], msgs: [{ from: 'app', to: 'p', label: 'SELECT (писал 2 с назад)', color: 'ok' }], c: { 1: [9, 10, 11, 14, 15, 16] } },
      { title: 'Failover', text: 'Primary упал. Оркестратор (Patroni, облачный сервис) повышает самую свежую реплику до primary, и запись продолжается. При асинхронной репликации транзакции, которые не успели уйти, потеряны.', bad: ['p'], good: ['r1'], badge: { p: 'DOWN' }, msgs: [{ from: 'app', to: 'r1', label: 'запись', color: 'ok' }], lines: { r1: ['новый primary'] } }
    ]
  };

  D.sharding = {
    title: 'Шардирование и consistent hashing', icon: 'nosql', lede: 'Как делить данные по серверам и не переносить всё при добавлении нового.',
    actors: [
      { id: 'app', x: 20, y: 140, w: 120, label: 'Сервис' },
      { id: 'rt', x: 190, y: 140, w: 170, label: 'Маршрутизатор', sub: 'ключ → шард' },
      { id: 's0', x: 440, y: 20, w: 180, label: 'Шард 0' },
      { id: 's1', x: 440, y: 130, w: 180, label: 'Шард 1' },
      { id: 's2', x: 440, y: 240, w: 180, label: 'Шард 2' }
    ],
    code: [
      { label: 'JavaScript', lang: 'js', src: `
import crypto from 'crypto';
const h = s => parseInt(crypto.createHash('md5').update(s).digest('hex').slice(0, 8), 16);

// Наивно: номер шарда = hash % N
const naive = (key, n) => h(key) % n;

// Кольцо: у каждого сервера 100 виртуальных точек
class Ring {
  constructor(nodes) {
    this.points = nodes.flatMap(n => [...Array(100)].map((_, i) => [h(n + '#' + i), n]))
                       .sort((a, b) => a[0] - b[0]);
  }
  node(key) {                                    // первая точка по часовой стрелке
    const x = h(key);
    const p = this.points.find(([v]) => v >= x) || this.points[0];
    return p[1];
  }
}

const ring = new Ring(['shard0', 'shard1', 'shard2']);
ring.node('user:42');   // → 'shard1'` }
    ],
    steps: [
      { title: 'Зачем делить', text: 'Один primary упирается в запись и в объём диска. Шардирование делит данные по ключу: у каждого шарда своя часть пользователей, свой primary и свои реплики.', msgs: [{ from: 'app', to: 'rt', label: 'user:42 — где?' }] },
      { title: 'hash(key) % N', text: 'Простейший способ: хэш ключа по модулю числа шардов. Ключи распределяются равномерно.', msgs: [{ from: 'rt', to: 's1', label: 'hash(42) % 3 = 1' }], lines: { s0: ['user:3, user:9'], s1: ['user:42, user:7'], s2: ['user:5, user:11'] }, c: [4, 5] },
      { title: 'Добавили шард — переезжает всё', text: 'Шардов стало четыре. Остаток от деления меняется почти у всех ключей: ≈ 75 % данных едет на другие серверы. Это недели миграции.', bad: ['s0', 's1', 's2'], badge: { rt: 'ПЕРЕЕЗД' }, c: [5] },
      { title: 'Consistent hashing', text: 'Сервера и ключи кладутся на одно кольцо. Ключ принадлежит первому серверу по часовой стрелке. Новый сервер забирает только соседние отрезки: переезжает ≈ 1/N ключей. Виртуальные точки выравнивают нагрузку.', good: ['s1'], msgs: [{ from: 'rt', to: 's1', label: 'кольцо → shard1', color: 'ok' }], c: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21] },
      { title: 'Ключ шардирования', text: 'Ключ выбирают по главному запросу. user_id: все данные пользователя на одном шарде, запросы не ходят по кластеру. created_at: все новые записи летят в последний шард — горячая точка.', bad: ['s2'], badge: { s2: 'HOT' }, lines: { s2: ['все записи октября'] } },
      { title: 'Scatter-gather', text: 'Запрос без ключа шардирования (отчёт по всем пользователям) идёт на все шарды и собирается вместе. Такие запросы медленные и дорогие — их выносят в аналитическое хранилище.', msgs: [{ from: 'rt', to: 's0', label: 'SELECT …' }, { from: 'rt', to: 's1', label: 'SELECT …' }, { from: 'rt', to: 's2', label: 'SELECT …' }] }
    ]
  };

  D.isolation = {
    title: 'Уровни изоляции: двойная бронь', icon: 'sql', lede: 'Две транзакции бронируют одно место. Что видит каждая и как защититься.',
    actors: [
      { id: 'a', x: 20, y: 40, w: 160, label: 'Транзакция A', sub: 'пользователь 42' },
      { id: 'db', x: 250, y: 130, w: 170, label: 'PostgreSQL', sub: 'место 7' },
      { id: 'b', x: 20, y: 240, w: 160, label: 'Транзакция B', sub: 'пользователь 77' },
      { id: 'res', x: 480, y: 130, w: 140, label: 'Итог' }
    ],
    code: [
      { label: 'SQL', lang: 'sql', src: `
-- Read Committed (по умолчанию): обе транзакции видят «свободно»
BEGIN;
SELECT count(*) FROM bookings WHERE show_id = 1 AND seat = 7;   -- 0
INSERT INTO bookings (show_id, seat, user_id) VALUES (1, 7, 42);
COMMIT;

-- Вариант 1: Serializable — вторая транзакция получит ошибку
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM bookings WHERE show_id = 1 AND seat = 7;
INSERT INTO bookings (show_id, seat, user_id) VALUES (1, 7, 42);
COMMIT;   -- ERROR: could not serialize access → повторить

-- Вариант 2: блокировка строки места
BEGIN;
SELECT * FROM seats WHERE show_id = 1 AND seat = 7 FOR UPDATE;   -- B ждёт здесь
INSERT INTO bookings (show_id, seat, user_id) VALUES (1, 7, 42);
COMMIT;

-- Вариант 3: пусть решает база
CREATE UNIQUE INDEX ON bookings (show_id, seat);` }
    ],
    steps: [
      { title: 'A проверяет место', text: 'Транзакция A спрашивает, есть ли бронь на место 7. Броней нет.', msgs: [{ from: 'a', to: 'db', label: 'свободно?' }, { from: 'db', to: 'a', label: '0 броней', color: 'ok', lane: 1 }], lines: { db: ['брони места 7: нет'] }, c: [2, 3] },
      { title: 'B проверяет то же самое', text: 'Пока A не зафиксировала бронь, B читает то же состояние и тоже видит «свободно».', msgs: [{ from: 'b', to: 'db', label: 'свободно?' }, { from: 'db', to: 'b', label: '0 броней', color: 'ok', lane: 1 }], c: [3] },
      { title: 'Обе бронируют', text: 'Каждая транзакция корректна сама по себе, но вместе они нарушили правило «одно место — одна бронь». Это write skew. Read Committed его не видит.', bad: ['db', 'res'], badge: { db: 'ДУБЛЬ' }, msgs: [{ from: 'a', to: 'db', label: 'INSERT 42' }, { from: 'b', to: 'db', label: 'INSERT 77' }], lines: { db: ['бронь 42', 'бронь 77'], res: ['место продано дважды'] }, c: [4, 5] },
      { title: 'Serializable', text: 'SSI в PostgreSQL замечает, что данные, прочитанные B, изменились, и откатывает B при коммите. Приложение повторяет транзакцию и видит, что место занято. Цена — откаты и повторы при конкуренции.', good: ['a'], bad: ['b'], badge: { b: 'ROLLBACK' }, msgs: [{ from: 'b', to: 'db', label: 'COMMIT' }, { from: 'db', to: 'b', label: 'could not serialize', color: 'bad', lane: 1 }], lines: { db: ['бронь 42'], res: ['одна бронь'] }, c: [7, 8, 9, 10, 11] },
      { title: 'SELECT … FOR UPDATE', text: 'Пессимистичная блокировка: B ждёт, пока A закончит, и затем видит бронь. Цена — ожидание: при сотнях желающих на одно место очередь растёт.', badge: { b: 'ЖДЁТ' }, msgs: [{ from: 'a', to: 'db', label: 'FOR UPDATE' }, { from: 'b', to: 'db', label: 'FOR UPDATE (ждёт)', color: 'warn' }], c: [13, 14, 15, 16, 17] },
      { title: 'UNIQUE-ограничение', text: 'Самое надёжное — правило в самой базе: вторая вставка получит ошибку уникальности при любом уровне изоляции. Код может ошибаться, ограничение — нет.', good: ['db', 'res'], lines: { res: ['вторая вставка: duplicate key'] }, c: [19, 20] },
      { title: 'Что защищает каждый уровень', text: 'Read Committed: нет грязного чтения, но возможны неповторяющееся чтение, фантомы, потерянное обновление и write skew. Repeatable Read в PostgreSQL снимает всё, кроме write skew. Serializable — всё, ценой откатов.', hl: ['db'] }
    ]
  };

  D.twopc = {
    title: 'Двухфазный коммит (2PC)', icon: 'sql', lede: 'Атомарность между базами — и почему она блокирует систему.',
    actors: [
      { id: 'c', x: 220, y: 24, w: 200, label: 'Координатор', sub: 'сервис заказов' },
      { id: 'p1', x: 40, y: 230, w: 170, label: 'БД платежей' },
      { id: 'p2', x: 430, y: 230, w: 170, label: 'БД склада' }
    ],
    code: [
      { label: 'SQL', lang: 'sql', src: `
-- Фаза 1: prepare в каждой базе
BEGIN;
UPDATE accounts SET balance = balance - 990 WHERE id = 42;
PREPARE TRANSACTION 'order-777';        -- блокировки держатся!

BEGIN;
UPDATE stock SET reserved = reserved + 1 WHERE sku = 'A1';
PREPARE TRANSACTION 'order-777';

-- Фаза 2: все ответили «готов» → commit везде
COMMIT PREPARED 'order-777';

-- Если хоть один сказал «нет» → rollback везде
ROLLBACK PREPARED 'order-777';` }
    ],
    steps: [
      { title: 'Фаза 1: prepare', text: 'Координатор просит всех участников подготовиться: выполнить изменения и держать блокировки, но пока не фиксировать.', msgs: [{ from: 'c', to: 'p1', label: 'PREPARE' }, { from: 'c', to: 'p2', label: 'PREPARE' }], lines: { p1: ['−990 ₽, строка заблокирована'], p2: ['резерв A1, строка заблокирована'] }, c: [1, 2, 3, 4, 6, 7, 8] },
      { title: 'Голоса', text: 'Каждый участник отвечает «готов», только если он гарантированно сможет зафиксировать изменения.', msgs: [{ from: 'p1', to: 'c', label: 'готов', color: 'ok' }, { from: 'p2', to: 'c', label: 'готов', color: 'ok' }] },
      { title: 'Фаза 2: commit', text: 'Все готовы — координатор рассылает COMMIT. Изменения во всех базах фиксируются атомарно.', good: ['p1', 'p2'], msgs: [{ from: 'c', to: 'p1', label: 'COMMIT' }, { from: 'c', to: 'p2', label: 'COMMIT' }], c: [10, 11] },
      { title: 'Участник недоступен', text: 'Если склад не отвечает, операция не может завершиться: ни заказ, ни списание. Пока ждём, строки в платежах заблокированы. Доступность системы — произведение доступностей участников.', bad: ['p2'], badge: { p2: 'DOWN' }, msgs: [{ from: 'c', to: 'p2', label: 'PREPARE', color: 'bad' }], c: [13, 14] },
      { title: 'Координатор упал после prepare', text: 'Худший случай: участники проголосовали и ждут решения, а координатора нет. Фиксировать или откатывать, они не знают и держат блокировки до его возвращения. Поэтому в микросервисах выбирают саги.', bad: ['c'], badge: { c: 'DOWN' }, lines: { p1: ['prepared, ждёт решения'], p2: ['prepared, ждёт решения'] } }
    ]
  };

  D.saga = {
    title: 'Сага с компенсациями', icon: 'app', lede: 'Длинная операция из локальных транзакций, которая умеет откатываться.',
    actors: [
      { id: 'o', x: 220, y: 20, w: 200, label: 'Оркестратор', sub: 'сервис заказов' },
      { id: 'pay', x: 20, y: 210, w: 170, label: 'Платежи' },
      { id: 'inv', x: 235, y: 210, w: 170, label: 'Склад' },
      { id: 'ship', x: 450, y: 210, w: 170, label: 'Доставка' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
STEPS = [
    ("pay.charge",      "pay.refund"),
    ("stock.reserve",   "stock.release"),
    ("delivery.create", "delivery.cancel"),
]

def run_saga(order):
    done = []
    for action, compensate in STEPS:
        try:
            call(action, order, idempotency_key=f"{order.id}:{action}")
            done.append(compensate)
        except StepFailed:
            for comp in reversed(done):          # откат в обратном порядке
                call(comp, order, idempotency_key=f"{order.id}:{comp}")
            order.status = "cancelled"
            return
    order.status = "confirmed"` }
    ],
    steps: [
      { title: 'Шаг 1: списание', text: 'Каждый шаг — локальная транзакция в своём сервисе. Платежи списали деньги и зафиксировали это у себя.', msgs: [{ from: 'o', to: 'pay', label: 'списать 990 ₽' }, { from: 'pay', to: 'o', label: 'ok', color: 'ok', lane: 1 }], lines: { pay: ['списано 990'] }, c: [7, 8, 9, 10, 11, 12] },
      { title: 'Шаг 2: резерв', text: 'Склад резервирует товар.', msgs: [{ from: 'o', to: 'inv', label: 'резерв A1' }, { from: 'inv', to: 'o', label: 'ok', color: 'ok', lane: 1 }], lines: { inv: ['резерв A1'] } },
      { title: 'Шаг 3 упал', text: 'Доставка недоступна в этот регион. Шаг завершился ошибкой.', bad: ['ship'], badge: { ship: 'FAIL' }, msgs: [{ from: 'o', to: 'ship', label: 'создать доставку' }, { from: 'ship', to: 'o', label: 'ошибка', color: 'bad', lane: 1 }], c: [13] },
      { title: 'Компенсации', text: 'Сага откатывается в обратном порядке компенсирующими действиями. Это не rollback, а новые операции: снять резерв, вернуть деньги. Пользователь увидит отмену заказа.', msgs: [{ from: 'o', to: 'inv', label: 'release', color: 'warn' }, { from: 'o', to: 'pay', label: 'refund', color: 'warn' }], lines: { inv: ['резерв снят'], pay: ['возврат 990'] }, c: [14, 15, 16, 17] },
      { title: 'Идемпотентность и надёжность', text: 'Каждый шаг и компенсация идемпотентны: повтор после сбоя не спишет деньги дважды. Шаги идут через брокер, состояние саги хранится в базе оркестратора — упавший оркестратор продолжит с места.', hl: ['o'], c: [11, 15] },
      { title: 'Оркестрация или хореография', text: 'Здесь шагами управляет оркестратор. Альтернатива — хореография: сервисы реагируют на события друг друга без центра. Для 2–3 шагов это проще, для длинного процесса — сложнее отследить.' }
    ]
  };

  D.cdc = {
    title: 'Transactional outbox и CDC', icon: 'cdc', lede: 'Как опубликовать событие ровно тогда, когда транзакция зафиксирована.',
    actors: [
      { id: 'app', x: 20, y: 140, w: 150, label: 'Сервис заказов' },
      { id: 'db', x: 230, y: 30, w: 180, label: 'PostgreSQL' },
      { id: 'deb', x: 230, y: 240, w: 180, label: 'Debezium', sub: 'читает WAL' },
      { id: 'k', x: 470, y: 240, w: 150, label: 'Kafka' },
      { id: 'c', x: 470, y: 60, w: 150, label: 'Потребители' }
    ],
    code: [
      { label: 'Outbox · SQL', lang: 'sql', src: `
BEGIN;
INSERT INTO orders (id, user_id, total) VALUES (777, 42, 990);
-- событие пишется в ТУ ЖЕ транзакцию
INSERT INTO outbox (aggregate_id, type, payload)
  VALUES (777, 'OrderCreated', '{"total": 990}');
COMMIT;

-- Debezium читает WAL и публикует строки outbox в Kafka:
-- topic orders.events, key = aggregate_id` },
      { label: 'Так нельзя', lang: 'python', src: `
def create_order(o):
    db.execute("INSERT INTO orders ...", o)
    db.commit()
    kafka.send("orders.events", o)   # сервис упал здесь — события нет` }
    ],
    steps: [
      { title: 'Проблема двойной записи', text: 'Наивно: записать в базу, потом отправить в Kafka. Если сервис упадёт между шагами, заказ есть, а события нет. Поменять шаги местами — будет событие о заказе, которого нет.', bad: ['app'], badge: { app: 'УПАЛ' }, msgs: [{ from: 'app', to: 'db', label: 'INSERT order' }, { from: 'app', to: 'k', label: 'send — не дошло', color: 'bad' }], c: { 1: [1, 2, 3, 4] } },
      { title: 'Outbox в той же транзакции', text: 'Событие пишется в таблицу outbox в той же транзакции, что и заказ. Либо есть оба, либо ни одного.', good: ['db'], msgs: [{ from: 'app', to: 'db', label: 'INSERT order + outbox' }], lines: { db: ['orders: 777', 'outbox: OrderCreated'] }, c: { 0: [1, 2, 3, 4, 5, 6] } },
      { title: 'Debezium читает журнал', text: 'Коннектор читает WAL базы как реплика и видит только зафиксированные изменения. Код сервиса ничего не знает о Kafka.', msgs: [{ from: 'db', to: 'deb', label: 'WAL' }], c: { 0: [8, 9] } },
      { title: 'Публикация', text: 'Строка outbox превращается в сообщение с ключом aggregate_id: все события одного заказа попадут в одну партицию и сохранят порядок.', msgs: [{ from: 'deb', to: 'k', label: 'OrderCreated' }], lines: { k: ['orders.events: 777'] } },
      { title: 'Потребители', text: 'Потребители получают событие хотя бы один раз. Поэтому они идемпотентны: помнят ID обработанных событий.', msgs: [{ from: 'k', to: 'c', label: 'OrderCreated' }], good: ['c'] },
      { title: 'CDC без outbox', text: 'CDC можно повесить прямо на таблицу orders. Минус: события повторяют схему таблицы, а не бизнес-смысл, и ломаются при каждой миграции. Outbox даёт осмысленный контракт.' }
    ]
  };

  D.cap = {
    title: 'CAP и PACELC', icon: 'nosql', lede: 'Что выбирает распределённая база, когда сеть рвётся, и когда не рвётся.',
    actors: [
      { id: 'ca', x: 20, y: 40, w: 140, label: 'Клиент А' },
      { id: 'n1', x: 230, y: 40, w: 180, label: 'Узел 1', sub: 'Москва' },
      { id: 'n2', x: 230, y: 240, w: 180, label: 'Узел 2', sub: 'Новосибирск' },
      { id: 'cb', x: 20, y: 240, w: 140, label: 'Клиент Б' }
    ],
    code: [
      { label: 'Cassandra', lang: 'sql', src: `
-- Уровень согласованности выбирается на каждый запрос
CONSISTENCY ONE;
SELECT balance FROM wallets WHERE id = 42;   -- быстро, может быть старое

CONSISTENCY QUORUM;
SELECT balance FROM wallets WHERE id = 42;   -- свежо, если R + W > RF

-- PACELC: при разделе (P) — доступность (A) или согласованность (C),
-- иначе (E) — задержка (L) или согласованность (C)` }
    ],
    steps: [
      { title: 'Норма', text: 'Два узла хранят копии данных и реплицируют изменения друг другу.', msgs: [{ from: 'ca', to: 'n1', label: 'запись: 100' }, { from: 'n1', to: 'n2', label: 'репликация' }], lines: { n1: ['баланс 100'], n2: ['баланс 100'] } },
      { title: 'Раздел сети', text: 'Связь между дата-центрами пропала. Узлы живы, но не слышат друг друга. В распределённой системе это не «если», а «когда».', badge: { n2: 'РАЗДЕЛ' }, msgs: [{ from: 'n1', to: 'n2', label: '× нет связи', color: 'bad' }] },
      { title: 'Выбор доступности (AP)', text: 'Оба узла продолжают отвечать. А записал 50, а Б читает со своего узла и видит 100. Так работают Cassandra с ONE и DynamoDB по умолчанию.', msgs: [{ from: 'ca', to: 'n1', label: 'запись: 50' }, { from: 'n2', to: 'cb', label: '100 (старое)', color: 'warn' }], lines: { n1: ['баланс 50'], n2: ['баланс 100'] }, c: [2, 3] },
      { title: 'Выбор согласованности (CP)', text: 'Узел без кворума отказывает в ответе, чтобы не отдать устаревшее. Так поступают etcd, ZooKeeper, PostgreSQL с синхронной репликацией.', bad: ['n2'], msgs: [{ from: 'n2', to: 'cb', label: 'ошибка: нет кворума', color: 'bad' }], c: [5, 6] },
      { title: 'PACELC', text: 'Раздел случается редко. PACELC добавляет: даже без раздела выбираешь между задержкой и согласованностью. Синхронная репликация согласованна, но каждая запись ждёт ответа другого города.', c: [8, 9] }
    ]
  };
})();
