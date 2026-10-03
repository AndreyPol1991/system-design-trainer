/* Практикум «Внутри сервиса»: проблема сидит в компонентах сервиса, чинится на уровне C4-компонентов. */
(function () {
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const IN = (rt, nodes, edges) => ({
    rt: Object.assign(SD.CRT_DEF(), rt || {}), seq: 200,
    nodes: nodes.map(([id, type, y, label, props, extra]) => Object.assign({ id, type, y, label, props: Object.assign(SD.cdefaults(type), props || {}) }, extra || {})),
    edges: edges.map(([a, b], i) => ({ id: 'k' + i + a + b, from: a, to: b }))
  });
  const svcOf = g => g.nodes.find(n => n.id === 'svc');
  const an = (g, res) => SD.inner.analyze(svcOf(g), g, res);
  const noFind = (ids, text, okText) => ({
    t: 'custom', text,
    fn: (g, res) => {
      const s = svcOf(g);
      if (!SD.inner.has(s)) return { ok: false, detail: 'внутри сервиса пусто' };
      const f = an(g, res).findings.filter(x => ids.includes(x.id) && (x.sev === 'bad' || x.sev === 'warn'));
      return { ok: !f.length, detail: f.length ? f[0].text : okText || 'замечаний нет' };
    }
  });
  const check = (text, fn) => ({ t: 'custom', text, fn: (g, res) => { const s = svcOf(g); if (!SD.inner.has(s)) return { ok: false, detail: 'внутри сервиса пусто' }; return fn(SD.inner.model(s, g), g, res); } });
  const L = o => Object.assign({ tier: 'inner', innerLvl: true, innerTarget: 'svc', decisions: [], stretch: { cost: Infinity }, preset: [C()] }, o);
  const lbApp = (count, extra, inner) => [['lb', 'lb', 230, 250], ['svc', 'app', 430, 250, Object.assign({ count, inner }, extra || {}), 'Сервис заказов']];

  /* общие внутренности */
  const ENTRY = ['api', 'rest', 30, 'API заказов', { kinds: 'both' }, { ident: 'OrdersController' }];
  const UC_R = ['get', 'usecase', 30, 'Получить заказ', { kinds: 'read' }, { ident: 'GetOrder' }];
  const UC_W = ['place', 'usecase', 116, 'Оформить заказ', { kinds: 'write' }, { ident: 'PlaceOrder' }];
  const AGG = ['order', 'aggregate', 30, 'Заказ', {}, { ident: 'Order' }];
  const P_REPO = ['store', 'port', 116, 'Хранилище заказов', { role: 'repo' }, { ident: 'OrderStore' }];
  const REPO = (fetch, bind) => ['pg', 'repo', 30, 'Репозиторий заказов', { fetch: fetch || 'join' }, { ident: 'PgOrderStore', bind: bind || 'db' }];

  SD.INNER = [
    L({
      id: 'i-layers', title: 'Толстый контроллер', pattern: 'layered',
      chips: ['слоистая архитектура', 'тонкий контроллер', 'use case'],
      story: 'Сервис заказов писали быстро: контроллер сам ходит в репозиторий, проверяет правила и считает скидки. Теперь заказы должны приходить ещё и из брокера — и всю логику придётся копировать в консьюмер. Открой сервис изнутри (двойной клик) и разложи его по слоям.',
      traffic: { read: 3000, write: 300 },
      start: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, REPO()], [['api', 'pg']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']] },
      goals: [
        { t: 'success', min: 0.999 },
        noFind(['dep-in>infra', 'dep-in>dom'], 'Вход не ходит в инфраструктуру и домен напрямую'),
        check('Между входом и хранилищем есть сценарии чтения и записи', M => {
          const r = SD.inner.reach(M, 'read').some(c => c.type === 'usecase' || c.type === 'query'), w = SD.inner.reach(M, 'write').some(c => c.type === 'usecase');
          return { ok: r && w, detail: !r ? 'нет сценария чтения' : !w ? 'нет сценария записи' : 'чтение и запись идут через сценарии' };
        })
      ],
      hints: [
        { text: 'Двойной клик по «Сервису заказов» откроет его компоненты. Красная стрелка «API → Репозиторий» — это и есть толстый контроллер.', why: 'Контроллер должен только принять запрос и передать его сценарию.' },
        { text: 'Добавь два сценария из группы «Приложение»: «Получить заказ» (чтение) и «Оформить заказ» (запись). Протяни: API → сценарии → репозиторий. Старую стрелку удали.', why: 'Тогда консьюмер из брокера вызовет тот же сценарий, что и HTTP.' },
        { text: 'Можно нажать «Собрать по схеме → Слои»: сборка сделает это автоматически.', why: 'Слоистая архитектура: вход → приложение → инфраструктура.' }
      ],
      solution: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, UC_R, UC_W, REPO()], [['api', 'get'], ['api', 'place'], ['get', 'pg'], ['place', 'pg']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']],
        note: 'Вход → сценарии → репозиторий. Логика живёт в сценариях, вход тонкий: его можно заменить или добавить второй.' }
    }),
    L({
      id: 'i-ports', title: 'Переезд базы без правок бизнес-кода', pattern: 'hexagonal',
      chips: ['порты и адаптеры', 'инверсия зависимостей', 'DIP'],
      story: 'Компания переезжает с PostgreSQL на DynamoDB. Пока идёт переезд, нужны два адаптера хранилища, а сценарии трогать нельзя: они протестированы и критичны. Сейчас сценарии зовут PostgreSQL-репозиторий напрямую.',
      traffic: { read: 2500, write: 400 },
      start: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, UC_R, UC_W, REPO()], [['api', 'get'], ['api', 'place'], ['get', 'pg'], ['place', 'pg']])), ['db', 'sql', 700, 160, { replicas: 1 }], ['ddb', 'nosql', 700, 360, { model: 'kv' }, 'DynamoDB']], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ddb']] },
      goals: [
        { t: 'success', min: 0.999 },
        check('Сценарии зависят от порта хранилища, а не от адаптеров', M => {
          const bad = M.edges.filter(e => M.by.get(e.from).t.layer === 'app' && M.by.get(e.to).t.layer === 'infra');
          const port = M.comps.find(c => c.type === 'port' && c.props.role === 'repo' && M.inn.get(c.id).some(x => x.t.layer === 'app'));
          return { ok: !bad.length && !!port, detail: bad.length ? `«${SD.inner.nameOf(M.by.get(bad[0].from))}» зовёт адаптер напрямую` : !port ? 'нет порта хранилища, который используют сценарии' : 'сценарии знают только порт' };
        }),
        check('Порт реализуют два адаптера: PostgreSQL и DynamoDB', M => {
          const port = M.comps.find(c => c.type === 'port' && c.props.role === 'repo');
          const impl = port ? M.inn.get(port.id).filter(x => x.type === 'repo' && x.bound) : [];
          const targets = new Set(impl.map(x => x.bound.node.type));
          return { ok: targets.has('sql') && targets.has('nosql'), detail: `реализаций привязано: ${impl.length}` };
        })
      ],
      hints: [
        { text: 'Добавь «Порт (интерфейс)» с ролью «Хранилище». Сценарии должны указывать на порт.', why: 'Сценарий знает только контракт: findById, save.' },
        { text: 'Добавь второй «Репозиторий БД» — он сам привяжется к DynamoDB. Стрелки от обоих репозиториев веди к порту: так адаптер реализует интерфейс.', why: 'Стрелки зависимостей смотрят внутрь, к домену. Это инверсия зависимостей.' },
        { text: 'Посмотри вкладку «Код»: оба адаптера implements OrderStore, а в main.ts выбирается, какой подставить.', why: 'Замена технологии — одна строка в composition root.' }
      ],
      solution: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, UC_R, UC_W, P_REPO, REPO(), ['dyn', 'repo', 116, 'Репозиторий DynamoDB', {}, { ident: 'DynamoOrderStore', bind: 'ddb' }]], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['pg', 'store'], ['dyn', 'store']])), ['db', 'sql', 700, 160, { replicas: 1 }], ['ddb', 'nosql', 700, 360, { model: 'kv' }, 'DynamoDB']], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ddb']],
        note: 'Сценарии → порт ← два адаптера. Переезд — это замена реализации в композиции, сценарии не тронуты.' }
    }),
    L({
      id: 'i-nplus1', title: 'N+1 в списке заказов', pattern: 'nplus1',
      chips: ['N+1', 'ORM', 'JOIN и батчинг'],
      story: 'После релиза «Мои заказы» база легла: 5 000 чтений в секунду превратились в десятки тысяч запросов. Площадка выглядит нормально — проблема внутри сервиса, в репозитории.',
      traffic: { read: 5000, write: 200 },
      start: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, UC_W, P_REPO, REPO('lazy')], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['pg', 'store']])), ['db', 'sql', 700, 250, { size: 'l', replicas: 2 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'read', max: 60 }, noFind(['nplus1', 'gql-n1'], 'Связанные данные грузятся без N+1')],
      hints: [
        { text: 'Открой сервис и выбери «Репозиторий заказов». Ленивая загрузка: на каждый заказ — отдельный запрос позиций.', why: '1 запрос списка + 10 запросов позиций = 11 запросов вместо одного.' },
        { text: 'Поставь загрузку «Одним запросом с JOIN» или «Пачкой». Посмотри вкладку «Трасса»: рамка loop × 10 исчезнет.', why: 'Нагрузка на базу упадёт в 6 раз — это видно в полосе «Влияние на площадку».' }
      ],
      solution: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, UC_W, P_REPO, REPO('join')], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['pg', 'store']])), ['db', 'sql', 700, 250, { size: 'l', replicas: 2 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']],
        note: 'Один запрос с JOIN вместо 1 + N. Масштабировать базу не пришлось.' }
    }),
    L({
      id: 'i-client', title: 'Надёжный клиент к соседу', pattern: 'retry',
      chips: ['таймаут', 'повторы', 'Idempotency-Key', 'транзакция и сеть'],
      story: 'При оформлении заказа сервис резервирует товар на складе. Склад отвечает за 200 мс и в 5 % случаев падает. Вызов сделан внутри транзакции, без таймаута и повторов — пул соединений тает, а заказы теряются.',
      traffic: { write: 400, read: 1500 },
      job: { from: 'write', label: 'резерв на складе', ms: 200, conc: 50, target: 'external' },
      ext: { name: 'Склад', ms: 200, cap: 2000, fail: 0.05 },
      preset: [C(), ['ext', 'external', 960, 380, {}, 'Склад']],
      start: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, ['place', 'usecase', 116, 'Оформить заказ', { kinds: 'write', extInTx: true }, { ident: 'PlaceOrder' }], P_REPO, ['gw', 'port', 202, 'Шлюз склада', { role: 'gateway' }, { ident: 'InventoryGateway' }], REPO(), ['inv', 'httpcl', 116, 'Клиент склада', { idemKey: false }, { ident: 'InventoryClient', bind: 'ext' }]], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['place', 'gw'], ['pg', 'store'], ['inv', 'gw']])), ['db', 'sql', 700, 160, { replicas: 1 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ext', { timeout: 0, retries: 0 }]] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'write', max: 600 }, noFind(['notimeout', 'retry-nobackoff', 'retry-noidem', 'ext-in-tx'], 'Клиент склада: таймаут, повторы с паузой, ключ идемпотентности, вызов вне транзакции')],
      hints: [
        { text: 'Выбери «Клиент склада»: у него те же таймаут и повторы, что у стрелки на площадке. Поставь таймаут и 2 повтора с экспоненциальной паузой.', why: '5 % отказов при двух повторах превращаются в 0,0125 %.' },
        { text: 'Повторяется запись — включи Idempotency-Key, иначе склад зарезервирует товар дважды.', why: 'Ответ мог потеряться по таймауту, хотя склад операцию выполнил.' },
        { text: 'У сценария «Оформить заказ» выключи «Внешние вызовы внутри транзакции».', why: 'Пока ждём склад, транзакция держит соединение из пула и блокировки.' }
      ],
      solution: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, ['place', 'usecase', 116, 'Оформить заказ', { kinds: 'write', extInTx: false }, { ident: 'PlaceOrder' }], P_REPO, ['gw', 'port', 202, 'Шлюз склада', { role: 'gateway' }, { ident: 'InventoryGateway' }], REPO(), ['inv', 'httpcl', 116, 'Клиент склада', { idemKey: true }, { ident: 'InventoryClient', bind: 'ext' }]], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['place', 'gw'], ['pg', 'store'], ['inv', 'gw']])), ['db', 'sql', 700, 160, { replicas: 1 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ext', { timeout: 500, retries: 2, backoff: 'exp' }]], note: 'Таймаут 500 мс, два повтора с паузой и ключом идемпотентности, вызов до транзакции.' }
    }),
    L({
      id: 'i-outbox', title: 'Двойная запись в коде', pattern: 'outbox',
      chips: ['dual write', 'outbox', 'реле'],
      story: 'Сценарий «Оформить заказ» сохраняет заказ и сразу публикует событие в Kafka. Иногда письмо клиенту не уходит: процесс падает между коммитом и публикацией. Почини это внутри сервиса — так, чтобы событие и данные писались одной транзакцией.',
      traffic: { write: 600, read: 1500 }, features: ['payments'],
      job: { from: 'write', label: 'письмо о заказе', ms: 100, conc: 50, target: 'external' },
      ext: { name: 'Почтовый сервис', ms: 100, cap: 3000, fail: 0 },
      preset: [C(), ['ext', 'external', 1180, 250, {}, 'Почтовый сервис']],
      start: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, UC_R, UC_W, AGG, P_REPO, ['evp', 'port', 202, 'События заказов', { role: 'publisher' }, { ident: 'OrderEvents' }], REPO(), ['pub', 'pub', 116, 'Публикатор событий', { mode: 'direct' }, { ident: 'KafkaOrderEvents', bind: 'q' }]], [['api', 'get'], ['api', 'place'], ['place', 'order'], ['get', 'store'], ['place', 'store'], ['place', 'evp'], ['pg', 'store'], ['pub', 'evp']])), ['db', 'sql', 700, 150, { replicas: 1, replMode: 'semisync' }], ['q', 'queue', 700, 360, { acks: 'all', count: 3, retries: true }], ['w', 'worker', 940, 360, { count: 2 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'q'], ['q', 'w'], ['w', 'ext']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'jobs' }, { t: 'durable' }, noFind(['dualwrite', 'outbox-norelay', 'outbox-norepo'], 'Событие пишется атомарно с данными, реле его публикует')],
      hints: [
        { text: 'У «Публикатора событий» поставь «Пишет в таблицу outbox в той же транзакции».', why: 'INSERT в outbox — часть той же транзакции, что и заказ: либо оба, либо ничего.' },
        { text: 'Добавь «Outbox-реле» из инфраструктуры — оно привяжется к брокеру и будет публиковать события из таблицы.', why: 'Без реле события останутся в таблице навсегда.' },
        { text: 'Узел на площадке сам получит флаг outbox — цель «Подтверждённые данные не теряются» загорится.', why: 'Площадка и код описывают одно и то же решение.' }
      ],
      solution: { nodes: [...lbApp(3, {}, IN({}, [ENTRY, UC_R, UC_W, AGG, P_REPO, ['evp', 'port', 202, 'События заказов', { role: 'publisher' }, { ident: 'OrderEvents' }], REPO(), ['pub', 'pub', 116, 'Публикатор событий', { mode: 'outbox' }, { ident: 'OutboxOrderEvents', bind: 'q' }], ['relay', 'outbox', 202, 'Outbox-реле', {}, { ident: 'OutboxRelay', bind: 'q' }]], [['api', 'get'], ['api', 'place'], ['place', 'order'], ['get', 'store'], ['place', 'store'], ['place', 'evp'], ['pg', 'store'], ['pub', 'evp'], ['relay', 'pg']])), ['db', 'sql', 700, 150, { replicas: 1, replMode: 'semisync' }], ['q', 'queue', 700, 360, { acks: 'all', count: 3, retries: true }], ['w', 'worker', 940, 360, { count: 2 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'q'], ['q', 'w'], ['w', 'ext']], note: 'Публикатор пишет в outbox той же транзакцией, реле публикует отдельно с повторами.' }
    }),
    L({
      id: 'i-consumer', title: 'Консьюмер теряет и дублирует', pattern: 'inbox', innerTarget: 'svc',
      chips: ['ack после коммита', 'inbox', 'DLQ'],
      story: 'Начисление бонусов работает через брокер. Консьюмер подтверждает сообщение сразу, как получил, дубли не отсекает, а битое сообщение повторяет бесконечно. Бонусы то теряются, то начисляются дважды.',
      traffic: { write: 800, read: 1000 },
      job: { from: 'write', label: 'начисление бонусов', ms: 20, conc: 20, target: 'sql' },
      start: { nodes: [['lb', 'lb', 230, 250], ['api', 'app', 430, 250, { count: 3 }, 'API заказов'], ['db', 'sql', 700, 120, { size: 'l', replicas: 1 }], ['q', 'queue', 640, 360, { acks: 'all', count: 3, semantics: 'most' }], ['svc', 'worker', 860, 360, { count: 2, inner: IN({}, [['cons', 'consumer', 30, 'Консьюмер бонусов', { ack: 'before', inbox: false, dlq: 'none' }, { ident: 'BonusConsumer', bind: 'q' }], ['acc', 'usecase', 30, 'Начислить бонусы', { kinds: 'write' }, { ident: 'AccrueBonus' }], ['bp', 'port', 30, 'Счета бонусов', { role: 'repo' }, { ident: 'BonusAccounts' }], ['pg', 'repo', 30, 'Репозиторий бонусов', {}, { ident: 'PgBonusAccounts', bind: 'db' }]], [['cons', 'acc'], ['acc', 'bp'], ['pg', 'bp']]) }, 'Начисление бонусов']],
        edges: [['client', 'lb'], ['lb', 'api'], ['api', 'db'], ['api', 'q'], ['q', 'svc'], ['svc', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'jobs' }, { t: 'nolost' }, { t: 'nodup' }, noFind(['ack-before', 'no-inbox', 'no-dlq'], 'Консьюмер: ack после коммита, inbox и DLQ')],
      hints: [
        { text: 'Открой «Начисление бонусов» (двойной клик) и выбери консьюмер. Подтверждение — «После коммита в БД».', why: 'Упал после ack, но до записи — сообщение потеряно навсегда.' },
        { text: 'Включи inbox: таблица обработанных id в той же транзакции отсечёт дубли.', why: 'At-least-once означает: дубль придёт обязательно.' },
        { text: 'Ядовитые сообщения — в DLQ после 3 попыток. На площадке у брокера сами включатся повторы и DLQ.', why: 'Одно битое сообщение не должно держать всю партицию.' }
      ],
      solution: { nodes: [['lb', 'lb', 230, 250], ['api', 'app', 430, 250, { count: 3 }, 'API заказов'], ['db', 'sql', 700, 120, { size: 'l', replicas: 1 }], ['q', 'queue', 640, 360, { acks: 'all', count: 3, semantics: 'least', retries: true }], ['svc', 'worker', 860, 360, { count: 2, dedup: true, inner: IN({}, [['cons', 'consumer', 30, 'Консьюмер бонусов', { ack: 'after', inbox: true, dlq: '3' }, { ident: 'BonusConsumer', bind: 'q' }], ['acc', 'usecase', 30, 'Начислить бонусы', { kinds: 'write' }, { ident: 'AccrueBonus' }], ['bp', 'port', 30, 'Счета бонусов', { role: 'repo' }, { ident: 'BonusAccounts' }], ['pg', 'repo', 30, 'Репозиторий бонусов', {}, { ident: 'PgBonusAccounts', bind: 'db' }]], [['cons', 'acc'], ['acc', 'bp'], ['pg', 'bp']]) }, 'Начисление бонусов']],
        edges: [['client', 'lb'], ['lb', 'api'], ['api', 'db'], ['api', 'q'], ['q', 'svc'], ['svc', 'db']], note: 'Ack после коммита, inbox в той же транзакции, DLQ после трёх попыток.' }
    }),
    L({
      id: 'i-threads', title: 'Потоки ждут соседа', pattern: 'connpool',
      chips: ['модель потоков', 'виртуальные потоки', 'пул соединений', 'закон Литтла'],
      story: 'Каждый заказ ждёт ответа платёжного шлюза 400 мс. Сервис на Java с пулом потоков: поток на запрос стоит и ждёт. Четырёх экземпляров не хватает, а если поднять больше — база получит больше соединений, чем выдерживает: пул по 40 на экземпляр.',
      traffic: { write: 1500, read: 1500 },
      job: { from: 'write', label: 'платёж в шлюзе', ms: 400, conc: 200, target: 'external' },
      ext: { name: 'Платёжный шлюз', ms: 400, cap: 6000, fail: 0 },
      preset: [C(), ['ext', 'external', 960, 380, {}, 'Платёжный шлюз']],
      start: { nodes: [...lbApp(4, {}, IN({ rt: 'java', pool: 40 }, [ENTRY, UC_R, UC_W, P_REPO, ['gw', 'port', 202, 'Шлюз платежей', { role: 'gateway' }, { ident: 'PaymentGateway' }], REPO(), ['pay', 'httpcl', 116, 'Клиент платежей', {}, { ident: 'PaymentsClient', bind: 'ext' }]], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['place', 'gw'], ['pg', 'store'], ['pay', 'gw']])), ['db', 'sql', 700, 160, { size: 'l', replicas: 1 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ext', { timeout: 1000 }]] },
      goals: [{ t: 'success', min: 0.999 }, { t: 'latency', kind: 'write', max: 700 }, noFind(['pool-max', 'thread-wait'], 'Потоки не простаивают, соединений хватает'), { t: 'cost', max: 2300 }],
      hints: [
        { text: 'Открой сервис, сними выделение и посмотри «Рантайм сервиса». Цена ожидания ×1: пока поток ждёт шлюз, он ничего не делает.', why: 'Сервису нужно в разы больше экземпляров, чем требует CPU.' },
        { text: 'Выбери «Java 21 · виртуальные потоки» (или Go, или асинхронную модель). Цена ожидания упадёт до ×0,15 — и лишние экземпляры можно убрать, чтобы уложиться в бюджет.', why: 'Виртуальный поток при ожидании освобождает системный поток.' },
        { text: 'Если всё же масштабируешь экземпляры, следи за строкой «соединений N × пул»: больше 200 — база начнёт отказывать. Уменьши пул или поставь PgBouncer.', why: 'Закон Литтла: соединений нужно ≈ запросов в секунду × время запроса.' }
      ],
      solution: { nodes: [...lbApp(3, {}, IN({ rt: 'vthreads', pool: 20 }, [ENTRY, UC_R, UC_W, P_REPO, ['gw', 'port', 202, 'Шлюз платежей', { role: 'gateway' }, { ident: 'PaymentGateway' }], REPO(), ['pay', 'httpcl', 116, 'Клиент платежей', {}, { ident: 'PaymentsClient', bind: 'ext' }]], [['api', 'get'], ['api', 'place'], ['get', 'store'], ['place', 'store'], ['place', 'gw'], ['pg', 'store'], ['pay', 'gw']])), ['db', 'sql', 700, 160, { size: 'l', replicas: 1 }]],
        edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db'], ['svc', 'ext', { timeout: 1000 }]], note: 'Виртуальные потоки: ожидание шлюза почти бесплатно, хватает трёх экземпляров, соединений 60 из 200.' }
    }),
    L({
      id: 'i-modular', title: 'Модульный монолит', pattern: 'modmono',
      chips: ['модули', 'публичный API', 'границы контекстов'],
      story: 'В одном сервисе живут «Заказы» и «Платежи». Заказы читают таблицы платежей напрямую, а платежи зовут внутренний сценарий заказов. Через полгода платежи нужно вынести в отдельный сервис — с такими связями это невозможно.',
      traffic: { read: 2000, write: 400 },
      start: { nodes: [...lbApp(3, {}, IN({}, [
        ['api', 'rest', 30, 'API заказов', {}, { ident: 'OrdersController', module: 'Заказы' }],
        ['place', 'usecase', 30, 'Оформить заказ', {}, { ident: 'PlaceOrder', module: 'Заказы' }],
        ['charge', 'usecase', 202, 'Списать оплату', { kinds: 'write' }, { ident: 'ChargePayment', module: 'Платежи' }],
        ['opay', 'repo', 30, 'Репозиторий заказов', {}, { ident: 'PgOrderStore', module: 'Заказы', bind: 'db' }],
        ['ppay', 'repo', 116, 'Репозиторий платежей', {}, { ident: 'PgPaymentStore', module: 'Платежи', bind: 'db' }]],
        [['api', 'place'], ['place', 'opay'], ['place', 'ppay'], ['charge', 'ppay'], ['charge', 'place']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, noFind(['mod-db', 'mod-private', 'mod-cycle'], 'Модули общаются только через публичный API, без циклов'),
        check('В сервисе два модуля и оба используются', M => { const mods = new Set(M.comps.map(c => c.module).filter(Boolean)); return { ok: mods.size >= 2, detail: `модулей: ${mods.size}` }; })],
      hints: [
        { text: 'Красная стрелка «Оформить заказ → Репозиторий платежей»: модуль заказов лезет в чужие таблицы. Пусть заказы зовут сценарий «Списать оплату».', why: 'Таблицы — внутреннее дело модуля, наружу — только API.' },
        { text: 'У сценария «Списать оплату» включи «Публичный API модуля».', why: 'Это фасад модуля: всё остальное внутри закрыто.' },
        { text: 'Удали стрелку «Списать оплату → Оформить заказ»: платежам не нужно знать о заказах. Если нужна реакция — событие.', why: 'Цикл модулей не даёт выделить ни один из них.' }
      ],
      solution: { nodes: [...lbApp(3, {}, IN({}, [
        ['api', 'rest', 30, 'API заказов', {}, { ident: 'OrdersController', module: 'Заказы' }],
        ['place', 'usecase', 30, 'Оформить заказ', {}, { ident: 'PlaceOrder', module: 'Заказы' }],
        ['charge', 'usecase', 202, 'Списать оплату', { kinds: 'write', api: true }, { ident: 'ChargePayment', module: 'Платежи' }],
        ['opay', 'repo', 30, 'Репозиторий заказов', {}, { ident: 'PgOrderStore', module: 'Заказы', bind: 'db' }],
        ['ppay', 'repo', 116, 'Репозиторий платежей', {}, { ident: 'PgPaymentStore', module: 'Платежи', bind: 'db' }]],
        [['api', 'place'], ['place', 'opay'], ['place', 'charge'], ['charge', 'ppay']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']],
        note: 'Заказы → публичный сценарий платежей → их репозиторий. Платежи можно вынести в сервис: граница уже есть.' }
    }),
    L({
      id: 'i-cron', title: 'Задача на каждом экземпляре', pattern: 'idempotency',
      chips: ['cron', 'распределённая блокировка', 'выбор лидера'],
      story: 'Раз в сутки сервис начисляет проценты по вкладам. После масштабирования до четырёх экземпляров клиенты получили проценты четыре раза.',
      traffic: { read: 2000, write: 200 },
      start: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, UC_W, ['job', 'cron', 116, 'Начисление процентов', { every: '1d', lock: 'none' }, { ident: 'AccrueInterestJob' }], ['acc', 'usecase', 202, 'Начислить проценты', { kinds: 'write' }, { ident: 'AccrueInterest' }], REPO()], [['api', 'get'], ['api', 'place'], ['get', 'pg'], ['place', 'pg'], ['job', 'acc'], ['acc', 'pg']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']] },
      goals: [{ t: 'success', min: 0.999 }, noFind(['cron-dup'], 'Задача выполняется ровно на одном экземпляре')],
      hints: [
        { text: 'Выбери «Начисление процентов» и поставь блокировку в БД (ShedLock) или выбор лидера.', why: 'Экземпляров N — без блокировки задача выполнится N раз.' },
        { text: 'Посмотри код: pg_try_advisory_lock — тот экземпляр, что взял блокировку, работает, остальные выходят.', why: 'Для денег добавь ещё и идемпотентность: «начислено за дату X» — уникальный ключ.' }
      ],
      solution: { nodes: [...lbApp(4, {}, IN({}, [ENTRY, UC_R, UC_W, ['job', 'cron', 116, 'Начисление процентов', { every: '1d', lock: 'db' }, { ident: 'AccrueInterestJob' }], ['acc', 'usecase', 202, 'Начислить проценты', { kinds: 'write' }, { ident: 'AccrueInterest' }], REPO()], [['api', 'get'], ['api', 'place'], ['get', 'pg'], ['place', 'pg'], ['job', 'acc'], ['acc', 'pg']])), ['db', 'sql', 700, 250, { replicas: 1 }]], edges: [['client', 'lb'], ['lb', 'svc'], ['svc', 'db']],
        note: 'Блокировка в базе: задачу выполняет тот экземпляр, который её взял.' }
    })
  ];
  SD.INNER.forEach(l => { l.allow = Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group); });

  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && id.startsWith('i-') ? SD.INNER.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.innerLvl ? 'Внутри сервиса' : baseLabel(L);
  SD.nextLevel = L => { if (L.innerLvl) { const i = SD.INNER.indexOf(L); return i >= 0 && i < SD.INNER.length - 1 ? SD.INNER[i + 1] : null; } return baseNext(L); };
})();
