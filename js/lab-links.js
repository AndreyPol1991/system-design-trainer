/* «Разберись руками»: уровни ↔ лаборатории.
   В задании уровня — карточка: бытовая фраза, почему эта лаборатория про этот уровень, кнопка «открыть сразу
   на нужной вкладке» и прогресс заданий. Для уровней про шарды, партиции, индексы, изоляцию, реплики и кэш —
   свёрнутый мини-стенд «Посмотреть на данных»: живая таблица (SD.labTable.embed) с настройками узла текущей схемы.
   Подключение: SD.labLinks.card(L) в panels.js рядом с карточкой инцидента. Файлы лабораторий не меняются:
   нужная вкладка выбирается кликом по её переключателю после открытия. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const $ = id => document.getElementById(id);
  const labDef = id => (SD.LABS || []).find(l => l.id === id);

  /* ---------- подписи вкладок (для кнопки) и как их переключить ---------- */
  const TABN = {
    table: { table: 'Таблица', weight: 'Вес', idx: 'Индексы', part: 'Партиции', shard: 'Шарды', query: 'Запросы', reshard: 'Решардинг', hot: 'Горячий шард', iso: 'Изоляция', srv: 'Сервер', cache: 'Кэш', repl: 'Реплики' },
    cloudnet: { region: 'Регион и зоны', multi: 'Мультирегион', vpc: 'Сеть (VPC)', iam: 'Доступы (IAM)', iac: 'Инфраструктура как код' },
    deploy: { live: 'Выкладка', cmp: 'Сравнение', mig: 'Миграция базы' },
    front: { load: 'Открытие страницы', render: 'SSR, CSR, SSG', bff: 'BFF и вызовы', cache: 'Кэш на клиенте', offline: 'Офлайн' },
    oncall: { alert: 'Алерт', dig: 'Разбор', act: 'Действие', comms: 'Связь', pm: 'Постмортем' },
    slo: { sli: 'SLI и SLO', budget: 'Бюджет по дням', alerts: 'Алерты', nines: 'Девятки' },
    stream: { win: 'Окна', late: 'Опоздания', state: 'Ровно один раз', join: 'Соединение', lin: 'Происхождение' },
    e2e: { plain: 'Простыми словами', path: 'Путь покупателя', attr: 'Атрибуция', loss: 'Потери событий', stitch: 'Склейка', roi: 'Расходы и окупаемость', arch: 'Архитектура' },
    api: { pick: 'Выбор взаимодействия', contract: 'Контракты по схеме', check: 'Чек-лист API' },
    resil: { ok: 'сосед здоров', slow: 'сосед тормозит', flaky: 'сосед сбоит', down: 'сосед лежит', hang: 'сосед завис' }
  };
  /* у «API» свои вкладки, у «Связи вживую» — сценарии соседа; у остальных — стандартные role="tab" */
  const SW = { api: t => `[data-aptab="${t}"]`, resil: t => `[data-scn="${t}"]` };
  const swSel = (lab, t) => SW[lab] ? SW[lab](t) : `[role="tab"][data-tab="${t}"]`;

  /* «Таблица вживую»: 24 задания — считаем только задания своей вкладки */
  const TGRP = {
    weight: ['fit'], idx: ['idx-btree', 'idx-prefix', 'idx-only', 'idx-write'], part: ['prune', 'drop'], shard: ['byid', 'scatter', 'reshard'],
    query: ['byid', 'prune', 'scatter'], reshard: ['reshard'], hot: ['hot', 'email'], iso: ['iso-nonrep', 'iso-lost', 'iso-skew'], srv: ['srv-limit', 'srv-fit'],
    cache: ['cache-hit', 'cache-evict', 'cache-stale', 'cache-stampede'], repl: ['repl-ryw', 'repl-loss', 'repl-failover']
  };
  /* вкладки, которые имеет смысл показать мини-стендом прямо в задании */
  const STAND = new Set(['idx', 'part', 'shard', 'hot', 'iso', 'repl', 'cache', 'query', 'reshard']);

  /* что внутри лаборатории — термины, после бытовой фразы */
  const TERM = {
    'e2e': 'сквозная аналитика: метка источника → события → склейка → заказы → атрибуция → ROMI и CAC',
    'e2e:attr': 'модели атрибуции: первый клик, последний клик, линейная, с затуханием — и как они меняют бюджет',
    'e2e:loss': 'блокировщики и отказ от cookie: сбор в браузере против серверного, согласие и 152-ФЗ',
    'e2e:stitch': 'склейка анонимного посетителя с покупателем: правила, ложные склейки, точная конверсия',
    'e2e:roi': 'импорт расходов из рекламных кабинетов, курс валют, ROMI, CAC, LTV/CAC',
    'e2e:arch': 'трекер → сборщик → очередь → хранилище → витрины → дашборд, плюс CRM, оплаты и расходы',
    'table:idx': 'B-tree против полного перебора, составной и покрывающий индекс, цена индекса на запись',
    'table:weight': 'вес строк и индексов: поместятся ли горячие данные в память сервера',
    'table:part': 'партиции: запрос открывает один «ящик», старый квартал удаляется через DROP PARTITION',
    'table:shard': 'ключ шардирования: на какой сервер уходит строка и сколько шардов обходит запрос',
    'table:hot': 'горячий шард: при неудачном ключе один сервер получает почти всю нагрузку',
    'table:iso': 'неповторяемое чтение, потерянное обновление, перекос записи — и уровни изоляции, FOR UPDATE, версия',
    'table:repl': 'лаг репликации, read-your-writes, потеря записей при асинхронной репликации, failover',
    'table:cache': 'доля попаданий, TTL, вытеснение LRU/LFU, инвалидация и защита от лавины',
    'table:srv': 'CPU, память, диск и сеть: что кончается первым — и вертикально, репликами или шардами',
    estimate: 'средний и пиковый RPS, объём данных и число серверов — по порядку величины',
    ring: 'consistent hashing: сколько ключей переезжает при новом сервере — кольцо против hash % N',
    quorum: 'кворумы N, R, W: когда чтение видит последнюю запись (R + W > N), а когда запись отказывает',
    raft: 'Raft: выборы лидера, фиксация записи большинством, раздел сети',
    lsm: 'LSM-дерево: запись в память, сброс в файлы и компакция',
    bucket: 'token bucket: всплеск пропускаем, поток выше лимита отбиваем ответом 429',
    snowflake: 'Snowflake: уникальные ID на многих машинах без общей точки',
    resil: 'таймаут, повторы с паузой, предохранитель (circuit breaker) и fallback на одной связи',
    nfr: '99,9 % против 99,99 %, RPO и RTO — какие решения они диктуют',
    'api:pick': 'синхронный вызов (REST, gRPC), событие или WebSocket — для шести связей магазина',
    'deploy:live': 'всё сразу, rolling, blue-green, канарейка — простой и откат на графике ошибок',
    'deploy:mig': 'миграция базы через expand/contract: расширить схему, переключить код, убрать старое',
    'slo:sli': 'SLI и SLO: что измерять и сколько ошибок можно — бюджет в минутах',
    'slo:alerts': 'алерты по burn rate: будить, только когда бюджет ошибок тает быстро',
    'oncall:alert': 'подтвердить алерт, выбрать уровень инцидента, назначить роли',
    'oncall:dig': 'гипотеза → проверка по метрикам, логам и трейсам → причина',
    'front:load': 'водопад загрузки: DNS, TCP, TLS, расстояние и CDN в городе покупателя',
    'front:offline': 'ключ идемпотентности: запрос повторился, а заказ не задвоился',
    'stream:win': 'окна по времени: выручка за каждые 5 минут прямо на потоке событий',
    'stream:state': 'at-least-once даёт дубли после сбоя; контрольные точки и идемпотентная запись — нет',
    'stream:lin': 'происхождение данных: что сломается, если переименовать колонку в источнике',
    'cloudnet:region': 'три зоны доступности: магазин переживает падение одной'
  };
  const termOf = k => TERM[k.lab + ':' + k.tab] || TERM[k.lab] || '';

  /* ---------- карта: уровень → 1–2 лаборатории ---------- */
  const k = (lab, tab, life, x) => Object.assign({ lab, tab: tab || '', life }, x || {});
  const MAP = {
    /* основные уровни */
    first: [k('estimate', '', 'Прежде чем строить, прикинь, сколько придёт людей: 4 млн запросов в сутки — это сколько в секунду, а сколько в пике?', { task: 'one' })],
    scale: [k('estimate', '', 'Один кассир обслуживает 2 500 человек в секунду, а пришло 3 000. Сколько касс открыть, чтобы пережить пик и отпустить одну на перерыв?', { task: 'one' })],
    cache: [
      k('table', 'cache', 'База — склад, который отвечает медленно. Кассир записывает частые цены в блокнот под рукой — но блокнот маленький и записи в нём стареют.'),
      k('table', 'repl', 'Читать можно и из копий бухгалтерской книги в соседних офисах — только курьер с новыми записями едет не мгновенно.')
    ],
    short: [
      k('snowflake', '', 'Каждой короткой ссылке нужен свой номер, а выдают их несколько серверов сразу. Как кассам выдавать номера чеков, не созваниваясь друг с другом?', { task: 'machines' }),
      k('table', 'cache', 'По одной ссылке переходят тысячи раз — её адрес выгодно держать в блокноте под рукой, а не бегать каждый раз на склад.')
    ],
    photos: [k('front', 'load', 'Фотография едет из Франкфурта через полмира. Склад в городе покупателя — и посылка приходит сразу, а не через неделю.', { task: 'vitals' })],
    email: [
      k('api', 'pick', 'Письмо после регистрации — как открытка: человеку незачем стоять у окошка почты, пока её доставят.', { task: 'notify' }),
      k('resil', 'flaky', 'Почта иногда теряет конверты. Отправить заново можно, но если слать без паузы, очередь на почте только растёт.', { task: 'storm' })
    ],
    order: [k('stream', 'state', 'Если из-за сбоя кассир пробил чек дважды, баланс поедет. Нужно, чтобы каждая операция учлась ровно один раз.', { task: 'eo' })],
    fresh: [
      k('table', 'repl', 'Ты поменял имя в профиле, а соседний офис читает свою копию — курьер с изменением туда ещё не доехал.'),
      k('quorum', '', 'Спроси сразу несколько копий и возьми самую свежую. Сколько копий опросить, чтобы точно увидеть последнюю запись?', { task: 'fresh' })
    ],
    booking: [k('table', 'iso', 'Два кассира одновременно продают последнее место на концерт — и каждый видит в своей схеме зала «свободно».')],
    indexes: [
      k('table', 'idx', 'Искать заказ, листая всю книгу, долго. Алфавитный указатель в конце книги сразу говорит номер страницы.'),
      k('table', 'weight', 'Указатель тоже весит. Чтобы он лежал под рукой, а не в гараже на диске, ему нужно место в памяти.')
    ],
    feed: [
      k('estimate', '', 'Один пост автора разносят 200 подписчикам — как газету тиражом 200. Прикинь, сколько это записей в секунду.', { task: 'one' }),
      k('table', 'cache', 'Готовую ленту держат в блокноте под рукой: собирать её со склада 20 000 раз в секунду никто не успеет.')
    ],
    chat: [
      k('api', 'pick', 'Письма или рация? Для переписки вживую нужен открытый канал, а не письма по одному.', { task: 'all' }),
      k('lsm', '', 'Сообщения сыплются потоком: их быстро пишут в черновик, а потом аккуратно переписывают в архив. Так пишут NoSQL-базы.', { task: 'flush' })
    ],
    bots: [k('bucket', '', 'Охранник на входе выдаёт жетоны: кончились — подожди. Покупатель проходит, а толпа парсеров упирается в турникет.', { task: 'sustain' })],
    video: [k('front', 'load', 'Кусочки фильма должны лежать на складе в городе зрителя, а не ехать к нему с другого континента.', { task: 'vitals' })],
    catalog: [k('stream', 'lin', 'Чужая команда переименовала графу в своей картотеке — и поиск, который читает её изменения, молча сломался. Важно знать, кто от чего зависит.', { task: 'lineage' })],
    cascade: [k('resil', 'slow', 'Один медленный кассир — и стоит вся очередь. А если каждый покупатель трижды переспрашивает, очередь растёт втрое.', { task: 'timeout' })],
    micro: [k('api', 'pick', 'Отделам магазина надо договориться, как общаться: звонком, когда ответ нужен сейчас, или запиской, когда можно позже.', { task: 'all' })],
    legacy: [k('api', 'pick', 'Все письма банка идут через одну экспедицию, и она не успевает. Отделы могут говорить напрямую — но каким способом?', { task: 'all' })],
    friday: [
      k('estimate', '', 'Вечером распродажи придёт вдвое больше людей. Сколько касс открыть заранее, а не в панике в 20:01?', { task: 'one' }),
      k('table', 'srv', 'Кухня упирается в самое узкое место: повара, холодильник или окно выдачи. Найди, что кончится первым.')
    ],
    pay: [k('front', 'offline', 'Связь мигнула, когда ты нажал «Оплатить», и ты нажал ещё раз. Банк должен понять, что это та же оплата, а не вторая.', { task: 'idem' })],
    geo: [k('table', 'idx', 'Искать такси рядом, перебирая все машины города, долго. Карта, поделённая на квадраты, сразу говорит, кто в твоём квадрате.', { opts: { idx: ['gist'] } })],
    monitoring: [k('lsm', '', 'Полмиллиона показаний в секунду: их пишут в черновик в памяти и пачками сбрасывают в архив. Так устроены хранилища метрик.', { task: 'flush' })],
    analytics: [k('stream', 'win', 'Выручку считают не раз в год, а каждые 5 минут — прямо по ходу продаж и не мешая покупателям.', { task: 'tumble' })],
    ddd: [k('api', 'pick', 'Шесть команд в одном цеху мешают друг другу. Разделили цеха — теперь надо договориться, как они передают друг другу работу.', { task: 'all' })],
    ledger: [k('stream', 'state', 'В бухгалтерской книге ничего не стирают, только дописывают. Баланс по ней пересобрать можно — но каждую запись надо учесть ровно один раз.', { task: 'eo' })],
    aiscale: [
      k('bucket', '', 'У поставщика лимит: столько-то заказов в минуту. Свой турникет перед ним бережёт и бюджет, и квоту.', { task: 'fit' }),
      k('resil', 'down', 'Один поставщик сломался — магазин не закрывается, а берёт товар у запасного. Это fallback.', { task: 'fallback' })
    ],
    /* практикум паттернов */
    'p-cacheaside': [k('table', 'cache', 'Кассир сначала смотрит в блокнот, а если там пусто — звонит на склад и записывает ответ. Это и есть cache-aside.')],
    'p-replicas': [k('table', 'repl', 'Читать можно из копий в соседних офисах, но свои свежие правки человек должен видеть сразу.')],
    'p-sharding': [
      k('table', 'shard', 'Один шкаф не вмещает карточки — ставим несколько и делим по номеру. Главное, чтобы ни один шкаф не завалило.'),
      k('ring', '', 'Добавили шкаф: при правиле «номер по модулю» почти все карточки меняют адрес, а на кольце — только часть.', { task: 'ring' })
    ],
    'p-resilience': [k('resil', 'slow', 'Сосед тормозит — не жди его вечно: ограничь ожидание, а при частых сбоях на время перестань к нему ходить.', { task: 'open' })],
    'p-retry': [k('resil', 'flaky', 'Не дозвонился — перезвони, но не сразу и не все одновременно, а с паузой, которая растёт.', { task: 'storm' })],
    'p-workers': [k('estimate', '', 'Задач приходит 800 в секунду, а один работник делает 200. Сколько работников нанять и с каким запасом?', { task: 'one' })],
    'p-ratelimit': [k('bucket', '', 'Жетоны на входе: честные посетители проходят, а поток парсеров упирается в турникет, не доходя до кассы.', { task: 'fit' })],
    'p-index': [k('table', 'idx', 'Составной указатель «клиент → дата» сразу находит «мои заказы за период», без перелистывания всей книги.')],
    'p-isolation': [k('table', 'iso', 'Два менеджера правят один остаток, каждый — от своей старой копии. Последний молча затирает работу первого.')],
    'p-cdn': [k('front', 'load', 'Картинки едут из Франкфурта 170 мс. Склад в городе покупателя отдаёт их почти мгновенно.', { task: 'vitals' })],
    /* инциденты */
    'f-shareddb': [
      k('deploy', 'mig', 'Переименовать графу в общей картотеке можно без аварии: добавь новую, переведи всех на неё и только потом убери старую.', { task: 'expand' }),
      k('stream', 'lin', 'Прежде чем менять графу, узнай, кто ещё её читает и какие отчёты сломаются.', { task: 'lineage' })
    ],
    /* CI/CD на схеме (js/cicd-sim.js) */
    'o-cicd-bad': [k('deploy', 'live', 'Новое блюдо сначала дают попробовать одному столику: не понравилось — убрали из меню, пока не отравили весь зал.', { task: 'canary' })],
    'o-cicd-tests': [k('deploy', 'cmp', 'Один и тот же брак в пяти цехах с разными правилами приёмки: где его поймают раньше и во что он обойдётся.', { task: 'compare' })],
    'o-cicd-daily': [k('deploy', 'live', 'Кассы меняют по одной, пока магазин работает: если новая сломалась — её сразу возвращают, покупатели почти не замечают.', { task: 'rolling' })],
    'f-distmono': [
      k('deploy', 'live', 'Магазин не закрывают на ремонт целиком: кассы меняют по одной, и покупатели продолжают платить.', { task: 'down' }),
      k('api', 'pick', 'Если каждый отдел звонит следующему и ждёт, ремонт одного останавливает всех. Записку можно оставить и не ждать.', { task: 'all' })
    ],
    'f-retrystorm': [k('resil', 'flaky', 'Сервис поднялся, а на него разом обрушились все повторы — и он падает снова. Перезванивать надо с паузой, а при сбоях — притормозить.', { task: 'storm' })],
    'f-spof': [
      k('nfr', '', 'Ключ от магазина у одного человека: заболел — магазин закрыт. Требование «99,9 %» прямо говорит, сколько нужно запасных ключей.', { task: 'nines' }),
      k('table', 'repl', 'Сгорела главная бухгалтерская книга — работу продолжает копия. Но копию надо назначить главной: это failover.')
    ],
    'f-hotpartition': [k('table', 'hot', 'Карточки разложены по городам, а половина клиентов — из Москвы. Московскую комнату завалило, остальные скучают.')],
    'f-oltpreports': [k('table', 'srv', 'Каждый понедельник отдел продаж занимает всех поваров своими огромными заказами — и обычные гости ждут.')],
    'f-notimeout': [k('resil', 'hang', 'Сосед взял трубку и молчит. Без таймаута ты стоишь у телефона вечно, а за тобой — очередь из всех потоков сервиса.', { task: 'notimeout' })],
    'f-stampede': [k('table', 'cache', 'Кассир потерял блокнот — и все покупатели разом звонят на склад. Склад ложится, хотя обычно скучает.')],
    /* внутри сервиса */
    'i-client': [
      k('resil', 'slow', 'Звонишь на склад, держа кассу открытой: чем дольше ждёшь, тем дольше стоит очередь. Ограничь ожидание и перезванивай с паузой.', { task: 'timeout' }),
      k('front', 'offline', 'Перезвонил после обрыва — склад должен понять, что это тот же резерв, а не второй. Для этого номер на бланке — ключ идемпотентности.', { task: 'idem' })
    ],
    'i-consumer': [k('stream', 'state', 'Курьер расписался в получении, ещё не донеся посылку, — и уронил её. Расписываться надо после, а повторную доставку — узнавать.', { task: 'eo' })],
    'i-threads': [k('resil', 'hang', 'У кассы 12 окошек. Если каждое ждёт ответа соседа, новые покупатели упираются в закрытые окошки.', { task: 'notimeout' })],
    'i-cron': [k('raft', '', 'Если проценты начисляет каждый из четырёх кассиров, клиент получит их четыре раза. Нужен один старший — и честные выборы, если он заболел.', { task: 'reelect' })],
    /* настройки на пальцах */
    'k-cache-mem': [k('table', 'cache', 'Блокнот на 4 страницы, а частых цен — на 20. Записи всё время вычёркивают, и кассир снова бежит на склад.')],
    'k-cache-ttl': [k('table', 'cache', 'Записи в блокноте стираются через 10 секунд: свежо, но толку мало — почти каждый раз звонок на склад.')],
    'k-size': [k('table', 'srv', 'Одна огромная кухня или несколько поменьше? У огромной всё равно один вход: закрыли на ремонт — и ресторан стоит.')],
    'k-hpa': [k('estimate', '', 'Днём хватает трёх касс, вечером нужно семь. Прикинь пик — автомасштабирование будет открывать кассы само.', { task: 'one' })],
    'k-repl': [k('table', 'repl', 'Курьер везёт копию записей в соседний офис. Сгорит главная книга до его приезда — последние записи пропали. Можно дождаться курьера.')],
    'k-cl': [k('quorum', '', 'Запись хранится в трёх копиях. Сколько из них должны ответить, чтобы ничего не потерять и не прочитать старое?', { task: 'fresh' })],
    'k-acks': [k('quorum', '', 'Брокер говорит «принял», когда записал только у себя. Если ждать подтверждения нескольких копий, сообщение переживёт падение сервера.', { task: 'unavail' })],
    'k-rl': [k('bucket', '', 'Счётчик «в минуту» на стыке минут пропускает двойную порцию. Ведро с жетонами, которое пополняется равномерно, так не ошибается.', { task: 'burst' })],
    /* архитектура из сервисов */
    'a-notify': [k('api', 'pick', 'Заказ и письмо клиенту — разные дела. Кассе незачем ждать почтальона: достаточно оставить записку.', { task: 'notify' })],
    'a-dbper': [k('stream', 'lin', 'Одна картотека на два отдела: один добавил графу — у другого сломался отчёт. Сначала посмотри, кто от чего зависит.', { task: 'lineage' })],
    'a-gateway': [k('bucket', '', 'Один вход с охраной вместо трёх дверей: здесь проверяют пропуска и выдают жетоны, чтобы толпа не дошла до цехов.', { task: 'sustain' })],
    'a-events': [k('api', 'pick', 'Цепочка звонков рвётся на любом звене. Объявление по громкой связи слышат все, кому надо, — и никто не ждёт.', { task: 'all' })],
    'a-split': [k('api', 'pick', 'Большой цех разделили на несколько — теперь им надо договориться, как передавать работу: звонком или запиской.', { task: 'all' })],
    /* эксплуатация */
    'o-metrics': [k('slo', 'sli', 'Приборная панель нужна, чтобы отвечать на вопрос «хорошо ли покупателям». Сначала договорись, что считать хорошим.', { task: 'budget' })],
    'o-alerts': [
      k('oncall', 'alert', 'Пожарная сигнализация бесполезна, если в здании никого нет. Алерт должен разбудить дежурного — а тот должен знать, что делать.', { task: 'ack' }),
      k('slo', 'alerts', 'Сигнализация, которая воет от каждой искры, приучает её не слушать. Будить надо, только когда горит всерьёз.', { task: 'catch' })
    ],
    'o-logs': [k('oncall', 'dig', 'Жалобы есть, а где поломка — непонятно. Нужна гипотеза и проверка по записям, а не догадки.', { task: 'cause' })],
    'o-traces': [k('oncall', 'dig', 'Заказ идёт через три отдела, и где-то теряется время. Разбор: сначала гипотеза, потом проверка по данным.', { task: 'cause' })],
    'o-k8s-peak': [k('estimate', '', 'Утром нужно 12 касс, днём хватит шести. Прикинь пик — и станет ясно, до скольких касс разрешать открываться.', { task: 'one' })],
    /* данные */
    'd-reports': [k('stream', 'win', 'Бухгалтерия не роется в кассе посреди торговли: выручку считают отдельно, порциями по времени.', { task: 'tumble' })],
    'd-clicks': [k('stream', 'win', 'Клики сыплются потоком, а маркетингу нужна сумма за каждые несколько минут, а не каждый клик отдельной строкой.', { task: 'tumble' })],
    'd-columns': [k('table', 'part', 'Шкаф с документами разложен по ящикам-месяцам: отчёт за лето открывает только летние ящики, а не весь шкаф.', { fixed: true, opts: { partition: 'range', shards: 1 } })],
    'd-lake': [k('table', 'part', 'Если все бумаги свалены в одну кучу, за каждым отчётом перебирают всё. Разложи по папкам-датам — и читай только нужные.', { fixed: true, opts: { partition: 'range', shards: 1 } })],
    /* облако */
    'c-az': [k('cloudnet', 'region', 'Магазин в одном здании: отключили свет — закрыт весь. Три здания в разных районах переживают аварию одного.', { task: 'zone' })]
  };

  /* уровень → ссылки: свободный режим и событие дня берут ссылки своего базового уровня */
  function linksFor(L) {
    if (!L || L.sandbox || L.interview) return [];
    const base = (L.free && L.free.base) || (L.daily && L.daily.base) || L.id;
    return (MAP[base] || []).filter(x => labDef(x.lab));
  }
  /* лаборатория → уровни (обратная карта, пригодится «Моему пути» и хабу) */
  function levelsFor(labId) { return Object.keys(MAP).filter(id => MAP[id].some(x => x.lab === labId)); }

  /* ---------- прогресс ---------- */
  const plural = n => (n % 10 === 1 && n % 100 !== 11) ? 'задания' : 'заданий';
  function progOf(x) {
    const lab = labDef(x.lab); if (!lab) return null;
    const done = ((SD.labs && SD.labs.progress ? SD.labs.progress() : {})[x.lab]) || [];
    const all = lab.tasks.map(t => t.id);
    const ids = x.lab === 'table' && TGRP[x.tab] ? TGRP[x.tab].filter(id => all.includes(id)) : all;
    const d = ids.filter(id => done.includes(id)).length;
    const sid = x.task && all.includes(x.task) && !done.includes(x.task) ? x.task : ids.find(id => !done.includes(id));
    return { d, t: ids.length, ids, start: lab.tasks.find(t => t.id === sid) || null, scope: x.lab === 'table' && TGRP[x.tab] ? 'на этой вкладке' : '' };
  }
  function progHtml(x) {
    const p = progOf(x); if (!p) return '';
    const pct = p.t ? Math.round(p.d / p.t * 100) : 0;
    let h = `<div class="llk-prog"><span class="llk-bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span>сделано ${p.d} из ${p.t} ${plural(p.t)}${p.scope ? ' ' + p.scope : ''}${p.d === p.t && p.t ? ' ✓' : ''}</span></div>`;
    if (p.start) h += `<p class="llk-start">Начни с: «${esc(p.start.text)}»</p>`;
    return h;
  }

  /* ---------- мини-стенд: настройки узла текущей схемы → опции встроенной таблицы ---------- */
  const SKEY = { hash: 'id', range: 'created_at', geo: 'country' }, SPART = { none: 'none', month: 'range', hash: 'hash' };
  const sqlOpts = p => ({ shards: Math.max(1, Math.min(4, p.shards || 1)), key: SKEY[p.shardKey] || 'id', method: 'mod', partition: SPART[p.partition] || 'none', replicas: Math.min(2, p.replicas || 0),
    idx: Array.isArray(p.idx) ? p.idx.slice() : (p.indexes === false ? [] : ['btree']), isolation: p.isolation || 'rc', locking: p.locking || 'none', size: p.size || 'm',
    replMode: p.replMode || 'async', ryw: !!p.ryw });
  const cacheOpts = p => ({ cacheMem: p.mem || 32, cacheNodes: p.count || 1, ttl: p.ttl || '10m', eviction: p.eviction || 'lru', policy: p.policy || 'aside', invalidate: p.invalidate !== false, stampede: p.stampede || false });
  function optsFor(x) {
    if (x.fixed) { const o = Object.assign({}, x.opts); return { opts: o, sig: JSON.stringify(o), node: null }; }
    const A = SD.app && SD.app.A, isCache = x.tab === 'cache';
    const n = A && A.graph ? A.graph.nodes.find(m => m.type === (isCache ? 'cache' : 'sql')) : null;
    const o = Object.assign(isCache ? cacheOpts((n && n.props) || {}) : sqlOpts((n && n.props) || {}), x.opts || {});
    return { opts: o, sig: JSON.stringify(o), node: n };
  }
  const nodeName = n => n ? (n.label || (SD.TYPES[n.type] || {}).name || 'узел') : '';

  /* состояние стенда: один на панель задания, живёт между перерисовками панели */
  const ST = { level: null, open: false, x: null, host: null, emb: null, sig: '', h: 0, scr: null };
  let LINKS = [], queued = false, ro = null;
  function kill() {
    if (ST.emb) { try { ST.emb.destroy(); } catch (e) { /* стенд уже разобран */ } }
    if (ST.host) { if (ro) ro.unobserve(ST.host); ST.host.remove(); }
    ST.emb = null; ST.host = null; ST.sig = ''; ST.h = 0; ST.open = false; ST.scr = null;
  }
  /* узел стенда переносится в новую карточку при каждой перерисовке панели, а перенос сбрасывает прокрутку:
     запоминаем её до перерисовки и возвращаем после */
  function snap() {
    if (!ST.host || !ST.host.isConnected) return;
    const out = [];
    ST.host.querySelectorAll('*').forEach(el => { if (el.scrollLeft || el.scrollTop) out.push([el, el.scrollLeft, el.scrollTop]); });
    ST.scr = out;
  }
  function unsnap() {
    (ST.scr || []).forEach(([el, l, t]) => { if (ST.host && ST.host.contains(el)) { el.scrollLeft = l; el.scrollTop = t; } });
    ST.scr = null;
  }
  /* ряд вкладок в узкой панели прокручивается — показать активную */
  function showTab() {
    const tb = ST.host && ST.host.querySelector('.lt-tabs'), t = tb && tb.querySelector('[role="tab"][aria-selected="true"]');
    if (t) tb.scrollLeft += t.getBoundingClientRect().left - tb.getBoundingClientRect().left - 24;
  }
  /* клики и ввод внутри стенда не должны доходить до обработчиков панели и площадки */
  function guard(el) {
    const stop = e => e.stopPropagation();
    ['click', 'input', 'change'].forEach(t => el.addEventListener(t, stop));
    el.addEventListener('keydown', e => { if (!e.ctrlKey && !e.metaKey && e.key !== 'Escape') e.stopPropagation(); });
    el.addEventListener('click', () => setTimeout(updateProg, 80));
    el.addEventListener('change', () => setTimeout(updateProg, 80));
  }
  function ensure(slot) {
    const x = ST.x; if (!x || !slot) return;
    const o = optsFor(x);
    if (!ST.host) {
      ST.host = document.createElement('div'); ST.host.className = 'llk-host';
      guard(ST.host);
      slot.appendChild(ST.host);
      try { ST.emb = SD.labTable.embed(ST.host, Object.assign({}, o.opts, { tab: x.tab })); }
      catch (e) { ST.emb = null; ST.host.innerHTML = '<p class="llk-sl">Стенд не запустился — открой лабораторию кнопкой выше.</p>'; }
      ST.sig = o.sig;
      showTab();
      if (window.ResizeObserver) { if (!ro) ro = new ResizeObserver(() => { if (ST.host && ST.host.isConnected) ST.h = ST.host.offsetHeight; }); ro.observe(ST.host); }
    } else {
      if (ST.host.parentNode !== slot) { slot.appendChild(ST.host); unsnap(); }
      if (o.sig !== ST.sig && ST.emb && ST.emb.set) { ST.emb.set(o.opts); ST.sig = o.sig; }
    }
    slot.style.minHeight = '';
  }
  /* после перерисовки панели: вернуть живой стенд в новую карточку или разобрать его */
  function sync() {
    queued = false;
    const slot = document.querySelector('#paneTask [data-llk-slot]');
    if (!slot || !ST.open) { kill(); return; }
    ensure(slot);
  }
  const later = () => { if (queued) return; queued = true; (window.queueMicrotask || (f => Promise.resolve().then(f)))(sync); };

  /* ---------- карточка ---------- */
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.6 15h8.8"/></svg>';
  function card(L) {
    if (!L || (SD.free && !SD.free.hintsOn())) { later(); return ''; }
    const ks = linksFor(L);
    const lk = L.id;
    if (ST.level !== lk) { kill(); ST.level = lk; } else snap();
    LINKS = ks;
    if (!ks.length) { later(); return ''; }
    const sx = SD.labTable && SD.labTable.embed ? ks.find(x => x.lab === 'table' && STAND.has(x.tab)) : null;
    ST.x = sx || null;
    let h = `<section class="llk-card" aria-label="Разберись руками"><div class="llk-eb">${ICON}<span>Разберись руками</span></div>`;
    ks.forEach((x, i) => {
      const lab = labDef(x.lab), tn = x.tab && TABN[x.lab] ? TABN[x.lab][x.tab] : '';
      /* вторая и следующие ссылки — свёрнуты, чтобы цели уровня не уезжали вниз */
      if (i === 1) h += `<details class="llk-more"${ST.more ? ' open' : ''}><summary data-llk-more>Ещё ${ks.length - 1 === 1 ? 'одна лаборатория' : (ks.length - 1) + ' лаборатории'} к этому уровню</summary>`;
      h += `<div class="llk-item"><p class="llk-life">${esc(x.life)}</p>`;
      h += `<button type="button" class="llk-go" data-llk-go="${i}"><span class="llk-t"><b>${esc(lab.title)}${tn ? ` <span class="llk-tab">· ${esc(tn)}</span>` : ''}</b><small>${esc(termOf(x))}</small></span><span class="llk-arr" aria-hidden="true">→</span></button>`;
      h += `<div data-llk-prog="${i}">${progHtml(x)}</div></div>`;
    });
    if (ks.length > 1) h += '</details>';
    if (sx) {
      const o = optsFor(sx), nm = nodeName(o.node);
      const note = sx.fixed ? 'Условная таблица users на 48 строк, разложенная по месяцам — как витрина или озеро, разбитые по дате.'
        : o.node ? `Таблица users на 48 строк — с настройками узла «${esc(nm)}» с площадки. Поменяй их во вкладке «Узел» — картинка перестроится.`
          : `На схеме пока нет узла «${sx.tab === 'cache' ? 'Кэш' : 'База данных'}» — показываю настройки по умолчанию. Поставь узел, и стенд возьмёт его настройки.`;
      h += `<details class="llk-stand"${ST.open ? ' open' : ''}><summary data-llk-sum>Посмотреть на данных <small>${esc(TABN.table[sx.tab])}</small></summary><p class="llk-sl">${note}</p><div class="llk-slot" data-llk-slot${ST.open && ST.h ? ` style="min-height:${ST.h}px"` : ''}></div></details>`;
    }
    h += '</section>';
    later();
    return h;
  }
  function updateProg() {
    document.querySelectorAll('#paneTask [data-llk-prog]').forEach(el => { const x = LINKS[+el.dataset.llkProg]; if (x) el.innerHTML = progHtml(x); });
  }

  /* ---------- открыть лабораторию на нужной вкладке ---------- */
  let moTasks = null, moModal = null;
  function mark(x) {
    const lab = labDef(x.lab), ul = $('labTasks'); if (!lab || !ul) return;
    const p = progOf(x), ids = x.lab === 'table' && TGRP[x.tab] ? p.ids : (x.task ? [x.task] : []);
    const paint = () => { [...ul.children].forEach((li, i) => { const t = lab.tasks[i]; li.classList.toggle('llk-focus', !!t && ids.includes(t.id)); }); };
    paint();
    if (moTasks) moTasks.disconnect();
    moTasks = new MutationObserver(paint); moTasks.observe(ul, { childList: true });
    const hd = ul.closest('.lab-head'), A = SD.app && SD.app.A;
    if (hd && A && A.level && !hd.querySelector('.llk-from')) ul.insertAdjacentHTML('beforebegin', `<p class="llk-from">С уровня «${esc(A.level.title)}».${ids.length ? ' Задания по теме подсвечены.' : ''}</p>`);
  }
  function go(x) {
    if (!x || !SD.labs || !labDef(x.lab)) return;
    /* лаборатория может грузиться по требованию — вкладку выбираем, когда она открылась */
    Promise.resolve(SD.labs.open(x.lab)).then(() => opened(x));
  }
  function opened(x) {
    const m = $('labModal');
    if (m && !moModal) {
      /* закрыли лабораторию — обновить прогресс в карточке */
      moModal = new MutationObserver(() => { if (m.hidden) { if (moTasks) { moTasks.disconnect(); moTasks = null; } updateProg(); } });
      moModal.observe(m, { attributes: true, attributeFilter: ['hidden'] });
    }
    let tries = 0;
    const pick = () => {
      const body = $('labBody');
      if (x.tab) {
        const b = body && body.querySelector(swSel(x.lab, x.tab));
        if (!b) { if (tries++ < 12) { requestAnimationFrame(pick); return; } }
        else if (b.getAttribute('aria-selected') !== 'true') b.click();
      }
      mark(x);
    };
    pick();
  }

  /* ---------- события карточки ---------- */
  document.addEventListener('click', e => {
    /* «Ещё лаборатория» — помним, раскрыт ли блок: панель задания перерисовывается при каждом пересчёте */
    const mo = e.target.closest && e.target.closest('[data-llk-more]');
    if (mo && mo.closest('.llk-card')) { setTimeout(() => { const d = mo.closest('details'); ST.more = !!(d && d.open); }, 0); return; }
    const t = e.target.closest && e.target.closest('[data-llk-go], [data-llk-sum]');
    if (!t || !t.closest('.llk-card')) return;
    if (t.hasAttribute('data-llk-sum')) {
      e.preventDefault();
      const d = t.closest('details');
      if (ST.open) { kill(); d.open = false; return; }
      ST.open = true; d.open = true;
      ensure(d.querySelector('[data-llk-slot]'));
      /* показать начало стенда: заголовок — к верху видимой области (сам стенд бывает выше экрана) */
      requestAnimationFrame(() => { const sm = document.querySelector('#paneTask [data-llk-sum]'); if (sm) sm.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      return;
    }
    go(LINKS[+t.dataset.llkGo]);
  });

  /* Ctrl+K: лаборатории к открытому уровню */
  (SD.cmdExtra = SD.cmdExtra || []).push((add, S) => {
    const L = S && S.level; if (!L || (SD.free && !SD.free.hintsOn())) return;
    linksFor(L).forEach(x => { const lab = labDef(x.lab); if (!lab) return; const tn = x.tab && TABN[x.lab] ? TABN[x.lab][x.tab] : ''; add('Лаборатория', `Разобраться руками: ${lab.title}${tn ? ' · ' + tn : ''}`, 'к этому уровню', () => go(x), 'лаборатория практика ' + termOf(x)); });
  });
  SD.labLinks = { card, links: linksFor, levelsFor, open: go, MAP, state: () => ({ level: ST.level, open: ST.open, tab: ST.x && ST.x.tab, live: !!ST.emb }) };
})();
