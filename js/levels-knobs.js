/* Два трека уровней: «Настройки на пальцах» (одна настройка — один урок) и «Архитектура из сервисов». */
(function () {
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const node = (g, id) => g.nodes.find(n => n.id === id);
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const K = o => Object.assign({ tier: 'knobs', knobLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()] }, o);
  const AR = o => Object.assign({ tier: 'archsvc', archLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()] }, o);
  const peak = (mul, min) => custom(`Выдерживает пик ×${String(mul).replace('.', ',')} (успешно ≥ ${Math.round(min * 100)} %)`, (g, res, L) => {
    const r = SD.sim.run(L, g, { mul });
    return { ok: r.total.success >= min, detail: `при ×${String(mul).replace('.', ',')} успешно ${SD.fmt.pct(r.total.success)}` };
  });

  SD.KNOBS = [
    K({
      id: 'k-cache-mem', title: 'Сколько памяти кэшу', focus: { node: 'c', prop: 'mem' }, pattern: 'cacheaside',
      chips: ['память кэша', 'горячие данные', 'hit ratio'],
      story: 'Читают 12 000 раз в секунду, а «горячих» данных — тех, что читают постоянно, — около 20 ГБ. В кэше всего 4 ГБ: он выбрасывает нужное, промахивается, и база тонет. Найди, сколько памяти достаточно — и не переплати.',
      traffic: { read: 12000, write: 300 }, hotSetGb: 20, allow: ['lb', 'app', 'cache', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 7 }], ['c', 'cache', 680, 140, { count: 1, mem: 4 }], ['db', 'sql', 680, 360, {}]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 80 }, { t: 'cost', max: 2100 }],
      hints: [
        { text: 'Выбери кэш и нажми «?» у «Память на узел»: откроется сравнение 4–64 ГБ на твоей схеме.', why: 'Попадания растут, пока горячие данные не влезут в память. Дальше память почти ничего не даёт.' },
        { text: 'Горячих данных 20 ГБ. Нужно примерно столько же памяти — одним узлом на 32 ГБ или двумя по 16.', why: 'Два узла заодно страхуют: упал один — пропала только половина ключей.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 7 }], ['c', 'cache', 680, 140, { count: 1, mem: 32 }], ['db', 'sql', 680, 360, {}]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']], note: '32 ГБ вмещают горячие 20 ГБ: попаданий больше 90 %, база отдыхает. 64 ГБ дали бы пару процентов за лишние деньги.' }
    }),
    K({
      id: 'k-cache-ttl', title: 'TTL: свежесть или попадания', focus: { node: 'c', prop: 'ttl' }, pattern: 'cacheaside',
      chips: ['TTL', 'инвалидация', 'устаревшие данные'],
      story: 'Цены в кэше живут 10 секунд — боятся показать старую цену. Из-за этого кэш постоянно промахивается и база перегружена. Требование бизнеса: новая цена видна не позже чем через минуту.',
      traffic: { read: 14000, write: 600 }, hotSetGb: 8, allow: ['lb', 'app', 'cache', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 8 }], ['c', 'cache', 680, 140, { count: 2, mem: 16, ttl: '10s', invalidate: false }], ['db', 'sql', 680, 360, {}]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 70 },
        custom('Новая цена видна не позже чем через минуту', g => { const c = g.nodes.find(n => n.type === 'cache'); const ok = !!c && (c.props.invalidate || ['10s', '1m'].includes(c.props.ttl)); return { ok, detail: !c ? 'кэша нет' : c.props.invalidate ? 'ключ сбрасывается при изменении' : `TTL ${c.props.ttl}` }; }),
        { t: 'cost', max: 2200 }],
      hints: [
        { text: 'Короткий TTL — частые промахи. Открой сравнение «TTL ключей»: при 10 секундах до базы доходит каждый четвёртый запрос.', why: 'Каждый промах — поход в базу.' },
        { text: 'Свежесть можно получить иначе: включи «Сбрасывать ключ при записи» — тогда TTL можно поставить длинным.', why: 'Изменилась цена — старый ключ удалён, следующее чтение возьмёт новую из базы.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 8 }], ['c', 'cache', 680, 140, { count: 2, mem: 16, ttl: '1h', invalidate: true }], ['db', 'sql', 680, 360, {}]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']], note: 'TTL час и сброс ключа при изменении: и свежо, и почти все ответы из кэша.' }
    }),
    K({
      id: 'k-size', title: 'Один большой или несколько поменьше', focus: { node: 'app', prop: 'size' }, pattern: 'spof',
      chips: ['вертикальное масштабирование', 'горизонтальное', 'единая точка отказа'],
      story: 'Сервис работает на одном огромном сервере на 8 ядер: мощности с запасом. Но когда его перезагрузили для обновления, магазин лежал. Сделай так, чтобы падение одного экземпляра ничего не ломало — и не удвоить счёт.',
      traffic: { read: 6000, write: 400 }, allow: ['lb', 'app', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 1, size: 'xl' }], ['db', 'sql', 680, 250, { size: 'l', replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'survive', types: ['app'] }, { t: 'cost', max: 2400 }],
      hints: [
        { text: 'Один экземпляр — единая точка отказа. Два огромных переживут падение, но это вдвое дороже.', why: 'Открой сравнение «Размер экземпляра» и «Экземпляры».' },
        { text: 'Несколько средних серверов: падение одного отнимает небольшую долю мощности.', why: 'Четыре по 2 ядра: упал один — остались три четверти.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 4, size: 'm' }], ['db', 'sql', 680, 250, { size: 'l', replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']], note: 'Четыре средних экземпляра: дешевле двух огромных и переживают падение любого.' }
    }),
    K({
      id: 'k-hpa', title: 'Автомасштабирование', focus: { node: 'app', prop: 'autoscale' }, pattern: 'autoscaling',
      chips: ['HPA', 'пики нагрузки', 'целевая загрузка'],
      story: 'Днём обычная нагрузка, а вечером — пик в два с половиной раза. Держать серверы под пик круглые сутки дорого, а без них вечером всё падает.',
      traffic: { read: 5000, write: 300 }, hotSetGb: 8, allow: ['lb', 'app', 'cache', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 3 }], ['c', 'cache', 680, 140, { mem: 16 }], ['db', 'sql', 680, 360, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, peak(2.5, 0.99), { t: 'cost', max: 1800 }],
      hints: [
        { text: 'Нажми «Волна ↗» и посмотри, что происходит с сервисом на пике.', why: 'Без автомасштабирования копий столько же, сколько днём.' },
        { text: 'Включи «Автомасштабирование (HPA)» у сервиса. Число экземпляров станет минимумом, а на пике Kubernetes добавит копии сам.', why: 'Платишь за пик только во время пика.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 3, autoscale: true }], ['c', 'cache', 680, 140, { mem: 16 }], ['db', 'sql', 680, 360, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']], note: 'Три копии днём, на пике HPA добавляет ещё. Цена в обычное время не выросла.' }
    }),
    K({
      id: 'k-health', title: 'Проверки здоровья', focus: { node: 'lb', prop: 'health' }, pattern: 'healthcheck',
      chips: ['health check', 'балансировщик', 'отказ экземпляра'],
      story: 'Экземпляров три, а при падении одного треть пользователей всё равно видит ошибки. Балансировщик не знает, что сервер умер, и продолжает слать ему запросы.',
      traffic: { read: 4000, write: 300 }, allow: ['lb', 'app', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250, { health: false }], ['app', 'app', 430, 250, { count: 3 }], ['db', 'sql', 680, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'survive', types: ['app'] }],
      hints: [
        { text: 'Нажми «Уронить узел» и посмотри на огоньки балансировщика: запросы продолжают лететь в упавший экземпляр.', why: 'Балансировщик не проверяет, жив ли сервер.' },
        { text: 'Включи «Health checks» у балансировщика.', why: 'Он будет каждые пару секунд спрашивать «ты жив?» и исключит упавшего.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250, { health: true }], ['app', 'app', 430, 250, { count: 3 }], ['db', 'sql', 680, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']], note: 'С проверками здоровья упавший экземпляр исключается за секунды, остальные берут его долю.' }
    }),
    K({
      id: 'k-sticky', title: 'Липкие сессии', focus: { node: 'lb', prop: 'sticky' }, pattern: 'loadbalancing',
      chips: ['sticky sessions', 'сессии в Redis', 'неравномерная нагрузка'],
      story: 'Корзина пользователя хранится в памяти экземпляра, поэтому балансировщик «приклеивает» пользователя к одному серверу. Нагрузка распределяется неровно, а когда сервер падает, люди теряют корзины.',
      traffic: { read: 7000, write: 700 }, hotSetGb: 4, allow: ['lb', 'app', 'cache', 'sql'],
      start: { nodes: [['lb', 'lb', 230, 250, { sticky: true }], ['app', 'app', 430, 250, { count: 4 }], ['db', 'sql', 680, 250, { size: 'l', replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 80 },
        custom('Корзины не теряются при падении экземпляра', g => { const lb = g.nodes.find(n => n.type === 'lb'); const app = g.nodes.find(n => n.type === 'app'); const store = app && g.edges.some(e => e.from === app.id && (g.nodes.find(n => n.id === e.to) || {}).type === 'cache'); const ok = !!lb && !lb.props.sticky && store; return { ok, detail: lb && lb.props.sticky ? 'сессии привязаны к экземпляру' : !store ? 'сессиям негде жить, кроме памяти экземпляра' : 'сессии в Redis' }; }),
        { t: 'cost', max: 2500 }],
      hints: [
        { text: 'Сессию нужно вынести из памяти экземпляра. Добавь кэш (Redis) и подключи к нему сервис.', why: 'Тогда любой экземпляр найдёт корзину любого пользователя.' },
        { text: 'Теперь отключи sticky у балансировщика: привязка больше не нужна, нагрузка ляжет ровно.', why: 'Посмотри на мини-серверы: заливка выровняется.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250, { sticky: false, algo: 'lc' }], ['app', 'app', 430, 250, { count: 4 }], ['c', 'cache', 680, 140, { mem: 8 }], ['db', 'sql', 680, 360, { size: 'l', replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'c'], ['app', 'db']], note: 'Сессии в Redis, балансировка без привязки: нагрузка ровная, падение экземпляра никого не разлогинивает.' }
    }),
    K({
      id: 'k-repl', title: 'Как реплика получает записи', focus: { node: 'db', prop: 'replMode' }, pattern: 'readreplica',
      chips: ['асинхронная репликация', 'полусинхронная', 'потеря данных'],
      story: 'У базы две реплики, и они получают изменения «когда-нибудь потом». Если primary упадёт, последние оплаченные заказы пропадут. Нужно не терять подтверждённые записи и не замедлить оформление.',
      traffic: { write: 800, read: 5000 }, features: ['payments'], allow: ['lb', 'app', 'sql', 'cache'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 3 }], ['db', 'sql', 680, 250, { size: 'l', replicas: 2, replMode: 'async' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'durable' }, { t: 'latency', kind: 'write', max: 120 }],
      hints: [
        { text: 'Открой «Режим репликации» у базы. Асинхронно — быстро, но последние записи могут пропасть.', why: 'Primary подтвердил запись и упал, не успев отдать её репликам.' },
        { text: 'Полусинхронно: ждём подтверждения одной реплики. Данные в двух местах, а ждать всех не нужно.', why: 'Синхронно тоже надёжно, но медленнее: ждём каждую реплику.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 3 }], ['db', 'sql', 680, 250, { size: 'l', replicas: 2, replMode: 'semisync' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']], note: 'Полусинхронная репликация: запись подтверждается, когда она есть ещё на одной реплике.' }
    }),
    K({
      id: 'k-cl', title: 'Сколько копий должны ответить', focus: { node: 'db', prop: 'cl' }, pattern: 'sharding',
      chips: ['NoSQL', 'ONE, QUORUM, ALL', 'репликация'],
      story: 'Лента активности хранится в Cassandra: шесть узлов, у каждой записи три копии. Запись подтверждает одна копия — быстро, но если она упадёт до копирования, событие исчезнет.',
      traffic: { write: 6000, read: 9000 }, storePref: 'nosql', allow: ['lb', 'app', 'nosql', 'cache'],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 7 }], ['db', 'nosql', 680, 250, { count: 6, rf: 3, cl: 'one' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'durable' }, { t: 'survive', types: ['nosql'] }, { t: 'cost', max: 3600 }],
      hints: [
        { text: 'ONE — ответила одна копия. ALL — ответили все три, но упавший узел ломает операции.', why: 'Сравни варианты «Уровня согласованности».' },
        { text: 'QUORUM — большинство: две из трёх. И не теряет запись, и переживает падение узла.', why: 'Если и пишем, и читаем кворумом, 2 + 2 > 3 — чтение всегда видит последнюю запись.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 7 }], ['db', 'nosql', 680, 250, { count: 6, rf: 3, cl: 'quorum' }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db']], note: 'QUORUM: две копии из трёх подтверждают запись. Узел может упасть, данные на месте.' }
    }),
    K({
      id: 'k-acks', title: 'Когда брокер говорит «принял»', focus: { node: 'q', prop: 'acks' }, pattern: 'outbox',
      chips: ['Kafka acks', 'реплики брокера', 'потеря сообщений'],
      story: 'Заказы уходят в Kafka, а оттуда — в учётную систему. Брокер один, и он подтверждает приём, как только записал у себя. Если сервер брокера умрёт, часть заказов не дойдёт до учёта.',
      traffic: { write: 600, read: 1500 }, allow: ['lb', 'app', 'sql', 'queue', 'worker'],
      job: { from: 'write', label: 'передача заказа в учёт', ms: 100, conc: 50, target: 'external' },
      ext: { name: 'Учётная система', ms: 100, cap: 3000, fail: 0 },
      preset: [C(), ['ext', 'external', 1100, 250, {}, 'Учётная система']],
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 2, outbox: true }], ['db', 'sql', 680, 120, { replicas: 1, replMode: 'semisync' }], ['q', 'queue', 680, 360, { engine: 'kafka', count: 1, acks: '1' }], ['w', 'worker', 900, 360, { count: 2 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'ext']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'jobs' }, { t: 'durable' }, { t: 'nolost' }],
      hints: [
        { text: 'Три брокера — каждое сообщение хранится в трёх копиях.', why: 'Один брокер — единственная копия.' },
        { text: 'acks = all: брокер говорит «принял», когда сообщение записали все копии.', why: 'acks = 1 подтверждает до копирования — и при падении сообщение пропадёт.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 2, outbox: true }], ['db', 'sql', 680, 120, { replicas: 1, replMode: 'semisync' }], ['q', 'queue', 680, 360, { engine: 'kafka', count: 3, acks: 'all' }], ['w', 'worker', 900, 360, { count: 2 }]], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'ext']], note: 'Три брокера и acks = all: подтверждённое сообщение есть в трёх копиях.' }
    }),
    K({
      id: 'k-rl', title: 'Как считать лимит запросов', focus: { node: 'gw', prop: 'rlAlgo' }, pattern: 'ratelimit',
      chips: ['rate limit', 'token bucket', 'fixed window'],
      story: 'Боты шлют 40 000 запросов в секунду. Шлюз ограничивает частоту окном «в минуту», но на стыке минут пропускает двойную порцию, и сервисы задыхаются.',
      traffic: { read: 5000, write: 300, bot: 40000 }, hotSetGb: 8, allow: ['gateway', 'lb', 'app', 'cache', 'sql'],
      start: { nodes: [['gw', 'gateway', 230, 250, { count: 2, rateLimit: true, rlAlgo: 'fixed' }], ['app', 'app', 430, 250, { count: 4 }], ['c', 'cache', 680, 140, { mem: 16 }], ['db', 'sql', 680, 360, { replicas: 1 }]], edges: [['client', 'gw'], ['gw', 'app'], ['app', 'c'], ['app', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 80 },
        custom('До сервисов доходит не больше 4 % ботов', (g, res) => { const b = res.kinds.bot; return { ok: !!b && b.passed <= 0.04, detail: b ? `доходит ${Math.round(b.passed * 100)} %` : 'ботов нет' }; }),
        { t: 'cost', max: 2000 }],
      hints: [
        { text: 'Открой сравнение «Алгоритм лимита» у шлюза.', why: 'Fixed window на стыке окон пропускает до двух лимитов.' },
        { text: 'Token bucket или sliding window считают честнее.', why: 'Ведро жетонов: можно потратить накопленное, но не больше.' }
      ],
      solution: { nodes: [['gw', 'gateway', 230, 250, { count: 2, rateLimit: true, rlAlgo: 'token' }], ['app', 'app', 430, 250, { count: 4 }], ['c', 'cache', 680, 140, { mem: 16 }], ['db', 'sql', 680, 360, { replicas: 1 }]], edges: [['client', 'gw'], ['gw', 'app'], ['app', 'c'], ['app', 'db']], note: 'Token bucket: боты упираются в лимит, сервисы работают спокойно.' }
    }),
    K({
      id: 'k-batch', title: 'Пачками быстрее', focus: { node: 'w', prop: 'batch' }, pattern: 'queue-cc',
      chips: ['batch', 'обработчики', 'накладные расходы'],
      story: 'Каждое событие о просмотре товара обработчик записывает в базу отдельно. Очередь растёт, а добавлять обработчиков дорого.',
      traffic: { write: 2000, read: 1000 }, allow: ['lb', 'app', 'sql', 'nosql', 'queue', 'worker'],
      job: { from: 'write', label: 'запись просмотра в статистику', ms: 40, conc: 20, target: 'nosql' },
      start: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 2 }], ['db', 'sql', 680, 120, { size: 'l', replicas: 1 }], ['q', 'queue', 680, 360, { engine: 'kafka', partitions: 6, count: 3 }], ['w', 'worker', 880, 360, { count: 3, batch: 1 }], ['st', 'nosql', 1080, 360, { count: 3 }, 'Статистика']], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'st']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'jobs' }, { t: 'cost', max: 3800 }],
      hints: [
        { text: 'Открой «Пачка за раз» у обработчиков и сравни 1, 10 и 100.', why: 'Каждая отдельная запись платит накладные расходы: сеть, транзакция, подтверждение.' },
        { text: 'Пачка из 100 событий записывается почти так же быстро, как одно.', why: 'Цена — событие ждёт, пока соберётся пачка: для статистики это нормально.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['app', 'app', 430, 250, { count: 2 }], ['db', 'sql', 680, 120, { size: 'l', replicas: 1 }], ['q', 'queue', 680, 360, { engine: 'kafka', partitions: 6, count: 3 }], ['w', 'worker', 880, 360, { count: 3, batch: 100 }], ['st', 'nosql', 1080, 360, { count: 3 }, 'Статистика']], edges: [['client', 'lb'], ['lb', 'app'], ['app', 'db'], ['app', 'q'], ['q', 'w'], ['w', 'st']], note: 'Пачки по 100: те же три обработчика успевают с запасом.' }
    })
  ];

  /* ---------- архитектура из сервисов ---------- */
  const roleOf = (g, role) => g.nodes.filter(n => (n.type === 'app' || n.type === 'worker') && n.props.role === role);
  const anti = (g, res, id) => (SD.arch.analyze(g, res).anti || []).filter(a => a.id === id);
  SD.ARCHL = [
    AR({
      id: 'a-notify', title: 'Выдели сервис уведомлений', pattern: 'queue-cc',
      chips: ['сервис уведомлений', 'брокер', 'асинхронность'],
      story: 'Сервис заказов сам отправляет письмо клиенту и ждёт почтового провайдера по 700 мс. Оформление заказа тормозит, а когда провайдер сбоит, заказы падают. Вынеси письма в отдельный «Сервис уведомлений», который получает задачи из брокера.',
      traffic: { write: 500, read: 2000 }, allow: ALL(),
      job: { from: 'write', label: 'письмо о заказе', ms: 700, conc: 100, target: 'external' },
      ext: { name: 'Почтовый провайдер', ms: 700, cap: 2500, fail: 0.02 },
      preset: [C(), ['ext', 'external', 1120, 250, {}, 'Почтовый провайдер']],
      start: { nodes: [['lb', 'lb', 230, 250], ['orders', 'app', 430, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['db', 'sql', 700, 120, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'db'], ['orders', 'ext']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'write', max: 150 }, { t: 'jobs' }, { t: 'nolost' },
        custom('Письма отправляет «Сервис уведомлений» из очереди', g => { const ns = roleOf(g, 'notify'); const ok = ns.some(n => g.edges.some(e => e.to === n.id && (node(g, e.from) || {}).type === 'queue') && g.edges.some(e => e.from === n.id && (node(g, e.to) || {}).type === 'external')); return { ok, detail: !ns.length ? 'нет сервиса с ролью «Уведомления»' : ok ? 'брокер → уведомления → провайдер' : 'уведомления должны получать задачи из брокера и ходить к провайдеру' }; })],
      hints: [
        { text: 'В палитре есть «Готовые сервисы» → «Сервис уведомлений». Поставь его и брокер между заказами и уведомлениями.', why: 'Заказ кладёт задачу в брокер и сразу отвечает клиенту.' },
        { text: 'Связи: Сервис заказов → Брокер → Сервис уведомлений → Почтовый провайдер. Прямую стрелку заказов к провайдеру удали.', why: 'У брокера включи «Повторы + DLQ»: сбои провайдера не потеряют письма.' },
        { text: 'Письмо идёт 700 мс, писем 500 в секунду: нужно 4–5 обработчиков. Но в Kafka один обработчик на партицию — партиций должно быть не меньше, чем обработчиков.', why: 'Иначе лишние обработчики простаивают, а очередь растёт.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['orders', 'app', 430, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['db', 'sql', 700, 120, { replicas: 1 }], ['q', 'queue', 700, 380, { retries: true, count: 3, acks: 'all', partitions: 8 }], ['notify', 'worker', 900, 380, { count: 4, role: 'notify' }, 'Сервис уведомлений']], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'db'], ['orders', 'q'], ['q', 'notify'], ['notify', 'ext']], note: 'Заказ кладёт задачу в брокер и отвечает за миллисекунды. Уведомления отправляют письма в своём темпе, с повторами.' }
    }),
    AR({
      id: 'a-dbper', title: 'Каждому сервису — своя база', pattern: 'dbpersvc',
      chips: ['база на сервис', 'общая база', 'независимость'],
      story: 'Сервис заказов и сервис каталога ходят в одну базу. Команда каталога добавила колонку — у заказов упал отчёт. Тяжёлый запрос каталога тормозит оформление. Разведи данные.',
      traffic: { read: 6000, write: 800 }, allow: ALL(),
      start: { nodes: [['lb', 'lb', 230, 250], ['orders', 'app', 430, 150, { count: 2, role: 'orders' }, 'Сервис заказов'], ['catalog', 'app', 430, 360, { count: 2, role: 'catalog' }, 'Сервис каталога'], ['db', 'sql', 700, 250, { size: 'l', replicas: 1 }, 'Общая база']], edges: [['client', 'lb'], ['lb', 'orders'], ['lb', 'catalog'], ['orders', 'db'], ['catalog', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, custom('У каждого сервиса своя база', (g, res) => { const a = anti(g, res, 'shareddb'); return { ok: !a.length, detail: a.length ? a[0].text.split('.')[0] : 'данные разведены' }; }), { t: 'cost', max: 2500 }],
      hints: [
        { text: 'Добавь вторую базу и переключи на неё сервис каталога. Стрелку каталога к общей базе удали.', why: 'Своя база — своя схема, свой темп изменений и своя нагрузка.' },
        { text: 'Если заказам нужны данные каталога, пусть спрашивают сервис каталога или подписываются на его события — но не лезут в его таблицы.', why: 'Иначе сервисы снова связаны через схему.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['orders', 'app', 430, 150, { count: 2, role: 'orders' }, 'Сервис заказов'], ['catalog', 'app', 430, 360, { count: 2, role: 'catalog' }, 'Сервис каталога'], ['db', 'sql', 700, 150, { replicas: 1 }, 'База заказов'], ['db2', 'sql', 700, 360, { replicas: 1 }, 'База каталога']], edges: [['client', 'lb'], ['lb', 'orders'], ['lb', 'catalog'], ['orders', 'db'], ['catalog', 'db2']], note: 'Две базы поменьше вместо одной большой: каждая команда меняет свою схему без страха.' }
    }),
    AR({
      id: 'a-gateway', title: 'Единый вход для клиентов', pattern: 'apigw',
      chips: ['API Gateway', 'авторизация', 'лимиты'],
      story: 'Мобильное приложение и сайт ходят напрямую в три сервиса. Каждый сам проверяет токены, а боты бьют во все сразу. Поставь единый вход.',
      traffic: { read: 5000, write: 300, bot: 30000 }, hotSetGb: 4, allow: ALL(),
      start: { nodes: [['orders', 'app', 330, 120, { count: 3, role: 'orders' }, 'Сервис заказов'], ['catalog', 'app', 330, 260, { count: 3, role: 'catalog' }, 'Сервис каталога'], ['users', 'app', 330, 400, { count: 3, role: 'users' }, 'Сервис пользователей'], ['db1', 'sql', 620, 120, {}, 'База заказов'], ['db2', 'sql', 620, 260, {}, 'База каталога'], ['db3', 'sql', 620, 400, {}, 'База пользователей']], edges: [['client', 'orders'], ['client', 'catalog'], ['client', 'users'], ['orders', 'db1'], ['catalog', 'db2'], ['users', 'db3']] },
      goals: [{ t: 'success', min: 0.999 },
        custom('Клиенты идут через API Gateway, сервисы не торчат наружу', g => { const direct = g.edges.some(e => (node(g, e.from) || {}).type === 'client' && (node(g, e.to) || {}).type === 'app'); const gw = g.nodes.find(n => n.type === 'gateway' && n.props.auth); return { ok: !direct && !!gw, detail: direct ? 'клиенты ходят в сервисы напрямую' : !gw ? 'нет шлюза с проверкой токена' : 'один вход с авторизацией' }; }),
        custom('До сервисов доходит не больше 5 % ботов', (g, res) => { const b = res.kinds.bot; return { ok: !!b && b.passed <= 0.05, detail: b ? `доходит ${Math.round(b.passed * 100)} %` : '' }; }),
        { t: 'cost', max: 2700 }],
      hints: [
        { text: 'Поставь API Gateway, клиента соедини только с ним, а шлюз — с тремя сервисами.', why: 'Один вход: проверка токена и лимиты в одном месте.' },
        { text: 'У шлюза включи ограничение частоты и проверку токена, две копии.', why: 'Боты отсекаются до сервисов.' }
      ],
      solution: { nodes: [['gw', 'gateway', 180, 260, { count: 2, rateLimit: true, rlAlgo: 'token', auth: true }], ['orders', 'app', 400, 120, { count: 2, role: 'orders' }, 'Сервис заказов'], ['catalog', 'app', 400, 260, { count: 2, role: 'catalog' }, 'Сервис каталога'], ['users', 'app', 400, 400, { count: 2, role: 'users' }, 'Сервис пользователей'], ['db1', 'sql', 660, 120, {}, 'База заказов'], ['db2', 'sql', 660, 260, {}, 'База каталога'], ['db3', 'sql', 660, 400, {}, 'База пользователей']], edges: [['client', 'gw'], ['gw', 'orders'], ['gw', 'catalog'], ['gw', 'users'], ['orders', 'db1'], ['catalog', 'db2'], ['users', 'db3']], note: 'Шлюз проверяет токены и режет ботов. Сервисов можно держать меньше копий.' }
    }),
    AR({
      id: 'a-events', title: 'События вместо цепочки вызовов', pattern: 'eda',
      chips: ['событийная архитектура', 'распределённый монолит', 'брокер'],
      story: 'Оформление заказа синхронно вызывает склад, тот — платежи, те — уведомления. Задержки складываются, а падение любого звена ломает заказ. Пусть заказ публикует событие, а остальные реагируют сами.',
      traffic: { write: 600, read: 2000 }, allow: ALL(), features: ['distributed'],
      job: { from: 'write', label: 'событие «заказ оформлен»', ms: 20, conc: 50, target: 'sql' },
      start: { nodes: [['lb', 'lb', 200, 250], ['orders', 'app', 380, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['inv', 'app', 580, 120, { count: 2, role: 'inventory' }, 'Сервис склада'], ['pay', 'app', 780, 120, { count: 2, role: 'payments' }, 'Сервис платежей'], ['ntf', 'app', 980, 120, { count: 2, role: 'notify' }, 'Сервис уведомлений'], ['db', 'sql', 580, 380, { replicas: 1 }, 'База заказов']], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'db'], ['orders', 'inv'], ['inv', 'pay'], ['pay', 'ntf']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'write', max: 120 },
        custom('Нет цепочки синхронных вызовов между сервисами', (g, res) => { const a = anti(g, res, 'distmono'); return { ok: !a.length, detail: a.length ? a[0].text.split('.')[0] : 'цепочки нет' }; }),
        custom('Сервисы реагируют на события из брокера', (g, res) => { const ok = (SD.arch.analyze(g, res).styles || []).some(s => s.id === 'eda'); return { ok, detail: ok ? 'событийная архитектура' : 'нет связи сервис → брокер → потребитель' }; }),
        { t: 'jobs' }],
      hints: [
        { text: 'Поставь брокер после сервиса заказов. Склад, платежи и уведомления сделай обработчиками (worker) с ролями — они будут читать события.', why: 'Заказ публикует «заказ оформлен» и сразу отвечает клиенту.' },
        { text: 'Каждому потребителю — своя база. Синхронные стрелки между сервисами удали.', why: 'Падение уведомлений больше не ломает оформление.' }
      ],
      solution: { nodes: [['lb', 'lb', 200, 250], ['orders', 'app', 380, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['db', 'sql', 600, 120, { replicas: 1 }, 'База заказов'], ['q', 'queue', 600, 380, { count: 3, acks: 'all', retries: true }], ['inv', 'worker', 820, 260, { count: 2, role: 'inventory', dedup: true }, 'Сервис склада'], ['pay', 'worker', 820, 400, { count: 2, role: 'payments', dedup: true }, 'Сервис платежей'], ['ntf', 'worker', 820, 540, { count: 2, role: 'notify', dedup: true }, 'Сервис уведомлений'], ['dbi', 'sql', 1060, 260, {}, 'База склада'], ['dbp', 'sql', 1060, 400, {}, 'База платежей'], ['dbn', 'sql', 1060, 540, {}, 'База уведомлений']], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'db'], ['orders', 'q'], ['q', 'inv'], ['q', 'pay'], ['q', 'ntf'], ['inv', 'dbi'], ['pay', 'dbp'], ['ntf', 'dbn']], note: 'Заказ публикует событие и отвечает. Склад, платежи и уведомления реагируют независимо и могут падать, не ломая оформление.' }
    }),
    AR({
      id: 'a-split', title: 'Распил монолита по доменам', pattern: 'microservices',
      chips: ['монолит', 'домены', 'микросервисы'],
      story: 'Один большой монолит и одна огромная база: каталог, заказы и профили. Команды мешают друг другу, любой релиз — общий. Разделите систему на три сервиса по доменам, у каждого — свои данные.',
      traffic: { read: 9000, write: 900 }, hotSetGb: 8, allow: ALL(),
      start: { nodes: [['lb', 'lb', 230, 250], ['mono', 'app', 430, 250, { count: 6 }, 'Монолит'], ['db', 'sql', 680, 250, { size: 'xl', replicas: 1 }, 'Одна большая база']], edges: [['client', 'lb'], ['lb', 'mono'], ['mono', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 80 },
        custom('Три сервиса с разными ролями', g => { const roles = new Set(g.nodes.filter(n => (n.type === 'app' || n.type === 'worker') && n.props.role).map(n => n.props.role)); return { ok: roles.size >= 3, detail: `ролей: ${roles.size}` }; }),
        custom('У каждого сервиса своя база', (g, res) => { const a = anti(g, res, 'shareddb'); return { ok: !a.length, detail: a.length ? a[0].text.split('.')[0] : 'данные разведены' }; }),
        { t: 'cost', max: 3800 }],
      hints: [
        { text: 'Из «Готовых сервисов» поставь каталог, заказы и пользователей. Балансировщик соедини со всеми тремя.', why: 'Каждый сервис — свой домен и своя команда.' },
        { text: 'Каждому сервису — своя база поменьше. Каталогу добавь кэш: его читают чаще всего.', why: 'Монолит и огромную базу удали.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['catalog', 'app', 450, 110, { count: 2, role: 'catalog' }, 'Сервис каталога'], ['orders', 'app', 450, 260, { count: 2, role: 'orders' }, 'Сервис заказов'], ['users', 'app', 450, 410, { count: 2, role: 'users' }, 'Сервис пользователей'], ['c', 'cache', 720, 40, { mem: 8 }], ['db1', 'sql', 720, 160, { replicas: 1 }, 'База каталога'], ['db2', 'sql', 720, 300, { replicas: 1 }, 'База заказов'], ['db3', 'sql', 720, 440, { replicas: 1 }, 'База пользователей']], edges: [['client', 'lb'], ['lb', 'catalog'], ['lb', 'orders'], ['lb', 'users'], ['catalog', 'c'], ['catalog', 'db1'], ['orders', 'db2'], ['users', 'db3']], note: 'Три сервиса по доменам, у каждого своя база. Каталогу — кэш: его читают чаще всего.' }
    })
  ];

  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^(k|a)-/.test(id) ? SD.KNOBS.concat(SD.ARCHL).find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.knobLvl ? 'Настройки на пальцах' : L.archLvl ? 'Архитектура из сервисов' : baseLabel(L);
  SD.nextLevel = L => {
    const list = L.knobLvl ? SD.KNOBS : L.archLvl ? SD.ARCHL : null;
    if (list) { const i = list.indexOf(L); return i >= 0 && i < list.length - 1 ? list[i + 1] : null; }
    return baseNext(L);
  };
})();
