/* «Сервис изнутри»: очередь на вход, потоки, ядра CPU, пул соединений к БД и вызовы соседей — по каждому запросу. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const K = 40, NET = 300, BL_MAX = 30, POOL = 10, HPA_DELAY = 5000, START = 4000, RESTART = 6000;
  const VCPU = { s: 1, m: 2, l: 4, xl: 8 };
  const DEPT = { cache: 150, sql: 520, nosql: 380, search: 600, queue: 200, app: 700, external: 1200, llm: 2800, vector: 500, s3: 600, ws: 300 };
  const ORDER = ['cache', 'nosql', 'sql', 'search', 'vector', 's3', 'app', 'external', 'llm', 'queue'];
  const POOLED = new Set(['sql', 'nosql']);
  const lerp = (a, b, f) => a + (b - a) * Math.max(0, Math.min(1, f));

  const RUN_PARTS = {
    inst: { name: 'Экземпляры', an: 'Несколько одинаковых касс в магазине: очередь делится между ними. Сломалась одна — работают остальные.', pl: 'Одинаковые копии сервиса. Балансировщик делит между ними запросы. Чем больше копий, тем больше запросов в секунду и тем спокойнее переживается падение одной.',
      how: ['Каждый экземпляр — отдельный процесс (контейнер) с тем же кодом.', 'Состояния в памяти нет: любой экземпляр обслужит любой запрос — поэтому их можно добавлять и убирать.', 'Автомасштабирование (HPA) каждые несколько секунд сравнивает загрузку CPU с целью.', 'Держится выше цели — запускает ещё экземпляр. Новому нужно время на старт и прогрев.', 'Нагрузка спала — лишние экземпляры гасятся, чтобы не платить за простой.'],
      watch: 'Ряд прямоугольников сверху: полоска — загрузка каждого. В «Всплеске ×3» с включённым HPA появляется «старт…» — новый экземпляр.', knobs: ['count', 'size', 'autoscale', 'hpaTarget'], real: 'Kubernetes HPA проверяет метрики раз в 15 с; новый под стартует от нескольких секунд до минуты (JVM дольше). В проде минимум 2–3 экземпляра в разных зонах.' },
    bl: { name: 'Очередь на вход', an: 'Очередь в гардероб: гардеробщики заняты — люди стоят и ждут. Если очередь упёрлась в дверь, новых не пускают.', pl: 'Запросы, которые уже пришли, но ещё не получили свободный поток. Пока они стоят, время ответа растёт, хотя никто их не обрабатывает.',
      how: ['Соединение от клиента принимает операционная система и кладёт в очередь (backlog).', 'Как только освобождается поток, он забирает следующий запрос из очереди.', 'Очередь ограничена. Переполнилась — новые запросы получают отказ (503) или обрыв соединения.', 'Ожидание в очереди входит в время ответа: пользователь ждёт, хотя сервер его ещё не начал обрабатывать.'],
      watch: 'Точки в левом верхнем углу экземпляра. В «Базе тормозит» и «Всплеске» очередь растёт, а при 30 — отказы 503.', knobs: ['count', 'size'], real: 'Tomcat: acceptCount = 100; Linux: net.core.somaxconn; балансировщик тоже держит свою очередь. Растущая очередь — первый признак, что не хватает экземпляров или что-то тормозит ниже.' },
    th: { name: 'Потоки', an: 'Повара на кухне: каждый ведёт свой заказ от начала до конца. Пока повар ждёт продукты со склада, он занят и новый заказ не берёт.', pl: 'Поток выполняет один запрос целиком: считает, ждёт базу, снова считает, отвечает. Пока поток ждёт, он занят, хотя процессор ему не нужен.',
      how: ['Свободный поток берёт запрос из очереди на вход.', 'Код выполняется на ядре CPU (синяя полоса).', 'Запрос в базу или к соседу — поток ждёт ответа (жёлтая полоса), ядро в это время отдано другим.', 'Ответ пришёл — поток досчитывает и отправляет ответ клиенту.', 'Только после этого поток свободен для следующего запроса.', 'Потоков фиксированное число: все ждут — новые запросы стоят в очереди, даже если CPU почти свободен.'],
      watch: 'Полосы посередине — по одной на поток. Цвет показывает, что поток делает прямо сейчас. «База тормозит» — почти все жёлтые.', knobs: ['size'], real: 'Tomcat/Spring: 200 потоков по умолчанию, каждый ≈ 1 МБ стека. Node.js — один поток и цикл событий: ожидание не держит поток. Java 21 — виртуальные потоки: ожидание почти бесплатно.' },
    cpu: { name: 'Ядра CPU', an: 'Плиты на кухне: готовить можно только на плите, а плит меньше, чем поваров. Повар, который ждёт продукты, плиту не занимает.', pl: 'Ядро в каждый момент выполняет код одного потока. Если считать хотят больше потоков, чем ядер, они ждут своей очереди к ядру.',
      how: ['Операционная система раздаёт ядра потокам маленькими кусочками времени.', 'Поток, который ждёт сеть или диск, ядро не занимает.', 'Если считающих потоков больше, чем ядер, появляется очередь к ядру (красные полосы «ждёт свободное ядро»).', 'Загрузка CPU 100 % — ядра заняты всё время, и любая лишняя работа удлиняет ответы.', 'Больше ядер (крупнее экземпляр) или больше экземпляров — единственное лекарство от тяжёлых вычислений.'],
      watch: 'Квадраты внизу экземпляра. В «Тяжёлых вычислениях» все ядра заняты, а потоки при этом есть свободные.', knobs: ['size', 'count'], real: '1 vCPU в облаке — это один гиперпоток физического ядра. HPA обычно смотрит именно на CPU. JSON, шифрование TLS, сжатие картинок — типичные пожиратели CPU.' },
    pool: { name: 'Пул соединений к БД', view: true, an: 'Такси у вокзала: машины стоят наготове с заведённым мотором. Пассажир сел и поехал — не нужно ждать, пока машину соберут.', pl: 'Открыть соединение с базой дорого: сетевое рукопожатие, шифрование, логин, а база запускает под него отдельный процесс. Пул открывает несколько соединений заранее и выдаёт их запросам по очереди.',
      how: ['При старте сервис открывает, например, 10 соединений к базе и держит их.', 'Запросу нужна база — он берёт свободное соединение из пула.', 'Запрос в базу выполнен — соединение возвращается в пул, а не закрывается.', 'Все заняты — запрос ждёт, пока кто-то вернёт соединение (или получает ошибку по таймауту пула).', 'У базы каждое соединение — процесс с памятью. Экземпляров × размер пула = сколько соединений держит база.'],
      watch: 'Нажми — откроется схема: сверху «без пула» каждый запрос проходит рукопожатие, снизу пул выдаёт готовые соединения. Внизу — сколько соединений набегает у базы.', knobs: ['count'], real: 'HikariCP (Java): maximumPoolSize = 10. PostgreSQL: max_connections = 100 по умолчанию, каждое соединение — процесс на 5–10 МБ. 30 экземпляров × 10 = 300 соединений — уже больше лимита: ставят PgBouncer.' },
    deps: { name: 'Соседи: БД, кэш, сервисы', an: 'Звонки поставщикам: пока поставщик не ответил, повар стоит у телефона.', pl: 'Всё, к чему сервис ходит по сети. Синхронный вызов держит поток, пока не придёт ответ. Медленный сосед делает медленным и тебя.',
      how: ['Сценарий решает, кого позвать: кэш, базу, другой сервис.', 'Вызов уходит по сети, поток ждёт ответа.', 'Таймаут ограничивает ожидание, повторы спасают от случайных сбоев, предохранитель — от лежащего соседа.', 'Асинхронные соседи (брокер) не держат поток: отправил событие — и дальше.'],
      watch: 'Прямоугольники справа. Нажми на любого — провалишься внутрь него. Двойной клик по стрелке на площадке — «Связь вживую».', knobs: [], real: 'Кэш — ≈ 1 мс, база — 2–10 мс, соседний сервис — 10–100 мс, внешний API — 100–1000 мс. Поэтому почти всё время запроса уходит на ожидание, а не на код.' }
  };
  const LAYER_PARTS = {
    in: { name: 'Роуты и контроллеры', an: 'Ресепшн в отеле: принимает гостя, проверяет паспорт, говорит, куда идти. Номера не убирает и цены не придумывает.', pl: '<b>Можно:</b> разобрать HTTP, проверить токен, проверить формат тела, выбрать код ответа. <b>Нельзя:</b> SQL и бизнес-правила — иначе их не переиспользовать для gRPC или очереди.',
      how: ['Роут сопоставляет адрес и метод (POST /orders) с обработчиком.', 'Middleware по цепочке: trace id для логов → проверка токена → лимит частоты.', 'Валидация тела: правильные поля и типы, иначе сразу 400.', 'Обработчик зовёт сценарий сервисного слоя и ждёт результат.', 'Результат превращается в JSON и код ответа: 200, 201, 404, 409.'],
      watch: 'Верхняя полоса. Шаги «trace id», «auth», «валидация» происходят здесь, до бизнес-логики.', real: 'Express Router, NestJS Controller, Spring @RestController, FastAPI router. Признак проблемы — в контроллере есть SQL или if про бизнес-правила.' },
    app: { name: 'Сервисный слой', an: 'Прораб на стройке: знает порядок работ и кому что поручить, но сам кирпичи не кладёт.', pl: '<b>Можно:</b> порядок шагов сценария, транзакция, вызовы репозиториев и клиентов, отправка событий. <b>Нельзя:</b> SQL-строки и HTTP-детали.',
      how: ['Один класс — одно действие пользователя: «Оформить заказ», «Получить заказ».', 'Открывает транзакцию, если надо записать несколько вещей атомарно.', 'Достаёт данные через репозиторий, просит домен проверить правила.', 'Сохраняет результат через репозиторий, отправляет событие через публикатор.', 'Возвращает результат роуту — без знания, что это был HTTP.'],
      watch: 'Вторая полоса. Отсюда стрелки идут вниз — к домену и репозиториям. Метка «идёт: транзакция» — сценарий держит транзакцию.', real: 'Spring @Service, NestJS Injectable service, Use Case / Application Service в чистой архитектуре. Раздутый сервисный слой с if-ами — сигнал вынести правила в домен.' },
    dom: { name: 'Домен', an: 'Правила игры в шахматы: «слон ходит по диагонали» — неважно, играют на доске, в телефоне или по переписке.', pl: '<b>Можно:</b> сущности, правила, инварианты («в заказе хотя бы одна позиция»), доменные события. <b>Нельзя:</b> знать про базу, HTTP, фреймворк.',
      how: ['Сущность (агрегат) хранит данные и сама следит за правилами.', 'Метод вроде order.place() проверяет инварианты и меняет состояние.', 'Нарушено правило — ошибка домена (роут превратит её в 409).', 'Порты — интерфейсы «мне нужно хранилище заказов»: домен говорит, ЧТО нужно, а инфраструктура — КАК.'],
      watch: 'Третья полоса. В типовой слоистой схеме она пустая — правила живут в сервисном слое. Собери «Порты и адаптеры», и здесь появятся агрегат и порты.', real: 'DDD: агрегаты, value objects, доменные сервисы. Домен тестируется обычными юнит-тестами без базы и HTTP — в этом его главная ценность.' },
    infra: { name: 'Репозитории и клиенты', an: 'Кладовщик: знает, на какой полке что лежит и как достать. Решать, кому продать товар, — не его дело.', pl: '<b>Можно:</b> SQL, перевод строк таблицы в объекты, HTTP-клиенты к соседям, Redis, брокер. <b>Нельзя:</b> бизнес-решения («можно ли оформить заказ»).',
      how: ['Репозиторий получает от сценария команду «сохрани заказ» или «найди по id».', 'Строит SQL, берёт соединение из пула, выполняет запрос.', 'Переводит строки таблицы в объекты домена (маппинг) и обратно.', 'Клиенты к соседям знают адрес, формат, таймауты и повторы.', 'Поменять базу или соседа — значит поменять только этот слой.'],
      watch: 'Нижняя полоса и пунктир к базе и соседям. Жёлтые подписи — сетевые вызовы: именно здесь уходит почти всё время запроса.', real: 'Spring Data Repository, TypeORM/Prisma, MyBatis; HTTP-клиенты Feign, axios; Redis-клиенты. Частые ошибки: N+1 запросов в цикле и SQL, размазанный по сервисному слою.' }
  };

  SD.XRAY.app = {
    cta: 'Очередь на вход, потоки, ядра CPU, пул соединений к БД: видно, где запрос считает, а где просто ждёт',
    dive: 'request',
    simple: () => ({ an: 'Кухня ресторана. Повара — потоки: каждый ведёт свой заказ от начала до конца. Плиты — ядра CPU: на них готовят, но плит меньше, чем поваров. Пока повар ждёт продукты со склада (база данных), плита свободна, но сам повар занят и новый заказ не возьмёт.', pl: 'Экземпляр сервиса принимает запрос в свободный поток. Поток то считает на ядре процессора, то ждёт ответа от базы, кэша или другого сервиса. Свободных потоков нет — запрос стоит в очереди на вход.' }),
    props: ['count', 'size', 'autoscale', 'hpaTarget', 'idempotency', 'outbox', 'txMode'],
    parts: v => v === 'layers' ? LAYER_PARTS : RUN_PARTS,
    views: [
      { id: 'run', name: 'Потоки и ядра' },
      { id: 'layers', name: 'Слои кода: роуты → сервисы → репозитории', scnLabel: 'Запросы', scenarios: [
        { id: 'auto', name: 'По очереди', note: 'Чтение и запись по очереди.' },
        { id: 'read', name: 'Чтение · GET', note: 'Только чтение: роут → сценарий → кэш или репозиторий → база.' },
        { id: 'write', name: 'Запись · POST', note: 'Только запись: роут → сценарий → домен → репозиторий → база.' },
        { id: 'step', name: 'По шагам', note: 'Каждый шаг — по кнопке «Следующий шаг» под картинкой.' }] }
    ],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Нагрузка и соседи — как на площадке.' },
      { id: 'spike', name: 'Всплеск ×3', note: 'Распродажа: запросов стало втрое больше.' },
      { id: 'slowdb', name: 'База тормозит', note: 'Ответы базы стали в 8 раз медленнее.' },
      { id: 'cpu', name: 'Тяжёлые вычисления', note: 'Каждый запрос долго считается на процессоре (генерация PDF, сжатие картинок).' },
      { id: 'crash', name: 'Экземпляр упал', note: 'Экземпляр №1 внезапно завершился (нехватка памяти).' }
    ],
    tries: [
      { id: 'io', text: '«База тормозит»: поймай момент, когда заняты все потоки, а CPU меньше 40 %' },
      { id: 'cpu', text: '«Тяжёлые вычисления»: ядра заняты на 100 %, хотя свободные потоки есть' },
      { id: 'size', text: 'Там же увеличь размер экземпляра — очередь на вход рассасывается' },
      { id: 'hpa', text: '«Всплеск ×3» с автомасштабированием: дождись, пока HPA добавит экземпляр' },
      { id: 'one', text: '«Экземпляр упал» при одном экземпляре: сервис недоступен целиком' },
      { id: 'two', text: 'Поставь 2+ экземпляра и урони снова: сервис продолжает отвечать' },
      { id: 'lread', text: '«Слои кода»: проследи чтение от роута до базы и обратно' },
      { id: 'lwrite', text: '«Слои кода»: проследи запись — где сервисный слой зовёт репозиторий' },
      { id: 'pool', text: 'Нажми на «пул к БД» и посмотри, сколько стоит соединение без пула' }
    ],
    legend: v => v === 'layers' ? [['read', 'Запрос идёт между компонентами'], ['sq accent', 'Компонент, который работает сейчас'], ['sq warn', 'Подпись жёлтым — вызов наружу: сеть и ожидание'], ['ring', 'Стрелка — «кто от кого зависит»']] : [['read', 'Запрос (цвет — вид: чтение, запись…)'], ['sq info', 'Поток считает на ядре CPU'], ['sq warn', 'Поток ждёт ответа соседа: ядро свободно, поток занят'], ['sq bad', 'Ждёт свободное соединение к БД или ядро'], ['ok', 'Ответ ушёл клиенту']],
    mount(ctx) {
      const R = runScene(ctx), Ls = layersScene(ctx), cur = () => ctx.view() === 'layers' ? Ls : R;
      return {
        tick: dt => cur().tick(dt), draw: () => cur().draw(),
        refresh() { R.refresh(); Ls.refresh(); },
        scenario: (id, init) => cur().scenario(id, init),
        onProp: (k, prev, v) => R.onProp(k, prev, v),
        now: () => cur().now(), stats: () => cur().stats(),
        destroy() { Ls.destroy(); }
      };
    }
  };

  /* ---------- вид «Потоки и ядра» ---------- */
  function runScene(ctx) {
    const esc = ctx.esc, P = () => ctx.node.props;
    const S = { t: 0, reqs: [], seq: 1, next: 0, bl: [], th: [], runq: [], coreBusy: 0, poolUsed: 0, poolQ: [], hist: [], rej: 0, crash: null, hpa: { n: 1, pend: [], over: 0, added: 0 }, scn: 'norm', sel: 0, peakBl: 0, calm: 0, deps: [], mix: [], lam: 3, C: 2, T: 8 };
    const kindsOf = () => { const ld = ctx.res.load || {}; const tot = Object.values(ld).reduce((s, v) => s + v, 0); return tot ? Object.entries(ld).filter(([, v]) => v > 0).map(([k, v]) => [k, v / tot]) : [['read', 1]]; };
    function build() {
      S.C = VCPU[P().size] || 2; S.T = Math.min(16, S.C * 4);
      if (S.th.length !== S.T) { S.reqs = []; S.bl = []; S.runq = []; S.poolQ = []; S.coreBusy = 0; S.poolUsed = 0; S.th = Array(S.T).fill(null); }
      const ld = ctx.res.load || {};
      S.deps = ctx.outs().map(x => ({ id: x.n.id, type: x.n.type, name: ctx.nm(x.n.id), byKind: x.er.byKind || {}, async: !!x.er.async, ld })).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
      S.mix = kindsOf();
      S.cnt = Math.max(1, ctx.res.count || P().count || 1);
      if (!S.hpaInit || !P().autoscale) { S.hpa.n = S.cnt; S.hpaInit = true; }
      rate();
    }
    const cpuT = () => (S.scn === 'cpu' ? 6 : 1) * 380;
    function rate() {
      const u = Math.max(0.2, Math.min(1.05, ctx.res.util || 0.5));
      if (S.scn === 'cpu' && !S.cpuDem) S.cpuDem = S.C * 1000 / cpuT() * 1.15;
      const per = S.scn === 'cpu' ? S.cpuDem : S.C * 1000 / cpuT() * u;
      let lam = Math.min(12, per);
      if (S.scn === 'spike') lam = Math.min(14, per * 3 * S.cnt / Math.max(1, S.hpa.n));
      if (S.scn === 'slowdb') lam = Math.min(12, S.T * 1000 / (cpuT() + 4200) * 1.3);
      if (S.crash && S.crash.multi && !S.crash.over) lam = Math.min(14, lam * S.cnt / Math.max(1, S.cnt - 1));
      S.lam = lam;
    }
    const depT = d => (DEPT[d.type] || 400) * (S.scn === 'slowdb' && POOLED.has(d.type) ? 8 : 1) * (0.7 + Math.random() * 0.6);
    function plan(kind) {
      const steps = [{ k: 'cpu', d: cpuT() * 0.6 }];
      S.deps.forEach(d => {
        if (d.async && d.type !== 'queue') return;
        const p = d.ld[kind] ? Math.min(1, (d.byKind[kind] || 0) / d.ld[kind]) : 0;
        if (Math.random() < p) steps.push({ k: 'io', dep: d, d: depT(d) });
      });
      steps.push({ k: 'cpu', d: cpuT() * 0.4 });
      return steps;
    }
    function pickKind() { let r = Math.random(), a = 0; for (const [k, w] of S.mix) { a += w; if (r <= a) return k; } return 'read'; }

    /* ---------- модель ---------- */
    function spawn() {
      if (S.crash && !S.crash.multi && S.t < S.crash.until) { S.rej++; S.hist.push({ err: true }); trim(); return; }
      S.reqs.push({ id: S.seq++, kind: pickKind(), t0: S.t, ph: 'arr', tE: S.t + NET });
    }
    const trim = () => { if (S.hist.length > 60) S.hist.shift(); };
    function fail(r, why) { r.ph = 'err'; r.tE = S.t + 800; r.why = why; S.hist.push({ err: true }); trim(); }
    function admit() {
      for (let i = 0; i < S.T && S.bl.length; i++) if (!S.th[i]) { const r = S.bl.shift(); S.th[i] = r; r.th = i; r.steps = plan(r.kind); r.si = 0; next(r); }
    }
    function next(r) {
      const st = r.steps[r.si];
      if (!st) { S.th[r.th] = null; r.ph = 'out'; r.tE = S.t + NET; S.hist.push({ lat: S.t - r.t0 + NET }); trim(); admit(); return; }
      if (st.k === 'cpu') { if (S.coreBusy < S.C) { S.coreBusy++; r.ph = 'cpu'; r.tS = S.t; r.tE = S.t + st.d; } else { r.ph = 'run'; S.runq.push(r); } return; }
      if (POOLED.has(st.dep.type)) { if (S.poolUsed < POOL) { S.poolUsed++; r.pool = true; } else { r.ph = 'pool'; S.poolQ.push(r); return; } }
      r.ph = 'io'; r.tS = S.t; r.tE = S.t + st.d; r.dep = st.dep;
    }
    function stepDone(r) {
      const st = r.steps[r.si];
      if (st.k === 'cpu') { S.coreBusy--; if (S.runq.length) { const q = S.runq.shift(); S.coreBusy++; q.ph = 'cpu'; q.tS = S.t; q.tE = S.t + q.steps[q.si].d; } }
      else if (r.pool) { r.pool = false; S.poolUsed--; if (S.poolQ.length) { const q = S.poolQ.shift(); S.poolUsed++; q.pool = true; const s2 = q.steps[q.si]; q.ph = 'io'; q.tS = S.t; q.tE = S.t + s2.d; q.dep = s2.dep; } }
      r.si++; next(r);
    }
    function crashNow() {
      const multi = S.cnt >= 2;
      S.th.forEach((r, i) => { if (r) { fail(r, 'экземпляр упал'); S.th[i] = null; } });
      S.bl.forEach(r => fail(r, 'экземпляр упал')); S.bl = []; S.runq = []; S.poolQ = []; S.coreBusy = 0; S.poolUsed = 0;
      S.crash = { at: S.t, until: S.t + RESTART, multi };
      ctx.log(multi ? `<b>Экземпляр №1 упал.</b> Запросы внутри него потеряны, новый трафик балансировщик отдаёт остальным ${S.cnt - 1}.` : '<b>Единственный экземпляр упал.</b> Сервис недоступен, пока Kubernetes его перезапускает.', 'bad');
      ctx.done(multi ? 'two' : 'one');
      rate();
    }
    function hpaTick() {
      if (!P().autoscale) return;
      const cpu = S.coreBusy / S.C, tgt = +P().hpaTarget || 0.6;
      S.hpa.over = cpu > tgt ? S.hpa.over + 1 : 0;
      if (S.hpa.over * 500 >= HPA_DELAY && !S.hpa.pend.length && S.hpa.n < 30) { S.hpa.pend.push({ at: S.t }); S.hpa.over = 0; ctx.log(`HPA: CPU ${Math.round(cpu * 100)} % выше цели ${Math.round(tgt * 100)} % уже 5 с — <b>запускаю ещё экземпляр</b>`, 'warn'); }
      S.hpa.pend = S.hpa.pend.filter(p => { if (S.t - p.at >= START) { S.hpa.n++; S.hpa.added++; ctx.log(`Новый экземпляр №${S.hpa.n} прогрелся и принял трафик — каждому достаётся меньше`, 'ok'); ctx.done('hpa'); rate(); return false; } return true; });
    }
    function tick(dt) {
      const end = S.t + dt;
      while (S.next <= end) { S.t = Math.max(S.t, S.next); spawn(); S.next += 1000 / S.lam * (0.5 + Math.random()); }
      S.t = end;
      if (S.scn === 'crash' && !S.crash && S.t > 2500) crashNow();
      if (S.crash && S.t >= S.crash.until) { ctx.log(S.crash.multi ? 'Экземпляр №1 перезапущен и вернулся в раздачу' : 'Экземпляр перезапущен — сервис снова отвечает', 'ok'); S.crash = { done: true, until: Infinity, multi: true, over: true }; rate(); }
      if (!S.hpaT || S.t - S.hpaT >= 500) { S.hpaT = S.t; hpaTick(); }
      S.reqs.forEach(r => {
        if (r.ph === 'arr' && S.t >= r.tE) {
          if (S.crash && !S.crash.over && S.t < S.crash.until) { fail(r, 'экземпляр перезапускается'); return; }
          if (S.bl.length >= BL_MAX) { S.rej++; fail(r, '503: очередь на вход переполнена'); return; }
          r.ph = 'bl'; S.bl.push(r);
        } else if ((r.ph === 'cpu' || r.ph === 'io') && S.t >= r.tE) stepDone(r);
      });
      admit();
      S.reqs = S.reqs.filter(r => !((r.ph === 'out' || r.ph === 'err') && S.t >= r.tE));
      S.peakBl = Math.max(S.peakBl, S.bl.length);
      const busyT = S.th.filter(Boolean).length, cpu = S.coreBusy / S.C;
      if (S.scn === 'slowdb' && busyT >= S.T && cpu < 0.4) ctx.done('io');
      if (S.scn === 'cpu' && S.coreBusy >= S.C && busyT < S.T) ctx.done('cpu');
      if (S.sizeUp && S.scn === 'cpu') { S.calm = S.bl.length === 0 ? S.calm + dt : 0; if (S.calm > 3000) ctx.done('size'); }
    }

    /* ---------- отрисовка ---------- */
    const IX = 170, IY = 80, IW = 590, IH = 410, LX = 340, LW = 300, DX = 790;
    const laneH = () => Math.min(22, 280 / S.T), laneY = i => IY + 58 + i * laneH();
    const depY = i => 100 + i * Math.min(78, 380 / Math.max(1, S.deps.length));
    const part = (k, x, y, w, h, inner) => `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}"><rect class="xa-pf" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${inner}</g>`;
    const LEGS = [['TCP: SYN →', 0.5, 'go'], ['← SYN-ACK, ACK', 0.5, 'back'], ['TLS: ключи', 2, 'go'], ['логин (SCRAM)', 3, 'back'], ['база: новый процесс', 10, 'db'], ['SELECT …', 2, 'go'], ['закрыть', 0.5, 'back']];
    function poolView() {
      const AX = 40, AW = 170, DBX = 780, DBW = 190, leg = 650, cyc = LEGS.length * leg + 500, t = S.t % cyc, li = Math.min(LEGS.length - 1, Math.floor(t / leg)), f = (t % leg) / leg;
      let s = `<text class="xr-t" x="20" y="24">Пул соединений: почему соединение берут готовым, а не открывают на каждый запрос</text>`;
      /* без пула */
      s += `<rect class="xr-zone" x="14" y="38" width="972" height="168" rx="12"/><text class="xr-m bad" x="28" y="58">БЕЗ ПУЛА: каждый запрос открывает соединение заново</text>`;
      s += `<rect class="xr-box" x="${AX}" y="80" width="${AW}" height="60" rx="10"/><text class="xr-t" x="${AX + 12}" y="104">Сервис</text><text class="xr-s" x="${AX + 12}" y="122">поток с запросом</text>`;
      s += `<rect class="xr-box ${LEGS[li][2] === 'db' ? 'hot' : ''}" x="${DBX}" y="80" width="${DBW}" height="60" rx="10"/><text class="xr-t" x="${DBX + 12}" y="104">База</text><text class="xr-s" x="${DBX + 12}" y="122">${li === 4 ? 'запускаю процесс…' : li >= 5 ? 'процесс готов' : 'ждёт рукопожатия'}</text>`;
      s += `<line class="xr-wire" x1="${AX + AW}" y1="110" x2="${DBX}" y2="110"/>`;
      const dir = LEGS[li][2], x = dir === 'back' ? DBX - (DBX - AX - AW) * f : dir === 'db' ? DBX + 20 : AX + AW + (DBX - AX - AW) * f;
      s += `<circle class="xr-dot ${li === 5 ? '' : 'wait'}" cx="${x.toFixed(1)}" cy="110" r="7" ${li === 5 ? 'style="fill:var(--k-read)"' : ''}/>`;
      let cx = 30, spent = 0, useful = 0;
      LEGS.forEach(([lb, ms], i) => { const w = lb.length * 6.4 + 22; s += `<g><rect class="xa-leg ${i === li ? 'on' : i < li ? 'done' : ''} ${i === 5 ? 'use' : ''}" x="${cx}" y="158" width="${w}" height="34" rx="8"/><text class="xr-m" x="${cx + 8}" y="172">${lb}</text><text class="xr-s" x="${cx + 8}" y="186">≈ ${String(ms).replace('.', ',')} мс</text></g>`; cx += w + 6; if (i === 5) useful += ms; else spent += ms; });
      s += `<text class="xr-m warn" x="${AX + AW + 20}" y="98">${LEGS[li][0]}</text>`;
      s += `<text class="xr-m bad" x="${DBX - 10}" y="72" text-anchor="end">подготовка ≈ ${String(spent).replace('.', ',')} мс на ${useful} мс полезной работы</text>`;
      /* с пулом */
      s += `<rect class="xr-zone" x="14" y="220" width="972" height="196" rx="12"/><text class="xr-m ok" x="28" y="240">С ПУЛОМ: соединения открыты заранее и переиспользуются</text>`;
      s += `<rect class="xr-box" x="${AX}" y="256" width="${AW}" height="146" rx="10"/><text class="xr-t" x="${AX + 12}" y="278">Экземпляр №1</text><text class="xr-s" x="${AX + 12}" y="295">ждут соединение: ${S.poolQ.length}</text>`;
      S.poolQ.slice(0, 12).forEach((r, k) => { s += `<circle class="xr-dot" cx="${AX + 20 + (k % 6) * 24}" cy="${318 + Math.floor(k / 6) * 24}" r="7" style="fill:${SD.kindColor(r.kind)}"/>`; });
      const busy = S.th.filter(r => r && r.pool), PX = 290, PW = 400;
      s += `<text class="xr-m" x="${PX}" y="258">пул: ${S.poolUsed} из ${POOL} заняты</text>`;
      for (let i = 0; i < POOL; i++) {
        const y = 268 + i * 13.5, r = busy[i], on = !!r;
        s += `<line class="xa-pipe ${on ? 'on' : ''}" x1="${PX}" y1="${y}" x2="${PX + PW}" y2="${y}"/>`;
        if (r) { const ff = Math.min(1, (S.t - r.tS) / Math.max(1, r.tE - r.tS)), xx = ff < 0.5 ? PX + PW * ff * 2 : PX + PW * (1 - (ff - 0.5) * 2); s += `<circle class="xr-dot ${ff >= 0.5 ? 'ok' : ''}" cx="${xx.toFixed(1)}" cy="${y}" r="5" ${ff >= 0.5 ? '' : `style="fill:${SD.kindColor(r.kind)}"`}/>`; }
        s += `<rect class="xa-proc ${on ? 'on' : ''}" x="${PX + PW + 14}" y="${y - 5}" width="60" height="10" rx="3"/>`;
      }
      s += `<rect class="xr-box" x="${DBX}" y="256" width="${DBW}" height="146" rx="10"/><text class="xr-t" x="${DBX + 12}" y="278">База</text><text class="xr-s" x="${DBX + 12}" y="296">процессы-соединения</text><text class="xr-s" x="${DBX + 12}" y="312">от этого экземпляра: ${POOL}</text><text class="xr-s" x="${DBX + 12}" y="328">каждый ≈ 10 МБ памяти</text>`;
      /* сколько соединений у базы */
      const n = Math.max(1, S.hpa.n || S.cnt), tot = n * POOL, lim = 200;
      s += `<text class="xr-m ${tot > lim ? 'bad' : 'ok'}" x="20" y="442">Всего у базы: ${n} экз. × пул ${POOL} = ${tot} соединений из max_connections ≈ ${lim}${tot > lim ? ' — не хватит!' : ''}</text>`;
      s += `<text class="xr-s" x="20" y="462">${tot > lim ? 'Больше лимита — новые соединения база отвергнет («too many connections»). Ставят PgBouncer: сотни клиентских соединений → 20 настоящих.' : 'Пока в лимите. Но каждый новый экземпляр добавляет ещё ' + POOL + ' соединений — при автомасштабировании легко упереться в лимит.'}</text>`;
      s += `<text class="xr-s" x="20" y="482">Ждать соединение из пула — тоже очередь: в «Базе тормозит» соединения заняты дольше, и запросы ждут уже не базу, а свободное соединение.</text>`;
      ctx.svg.innerHTML = s;
    }
    function draw() {
      if (ctx.part() === 'pool') { poolView(); return; }
      let s = '', g = '';
      /* экземпляры сверху */
      const n = Math.min(10, S.hpa.n), pend = S.hpa.pend.length;
      g += `<text class="xr-m" x="${IX}" y="16">экземпляры сервиса${P().autoscale ? ` · HPA: цель CPU ${Math.round((+P().hpaTarget || 0.6) * 100)} %` : ''}</text>`;
      for (let i = 0; i < n + pend; i++) {
        const x = IX + i * 58, isP = i >= n, dead = i === 0 && S.crash && !S.crash.over;
        const u = i === 0 ? S.coreBusy / S.C : Math.min(1, (ctx.res.util || 0.5) * (S.scn === 'spike' ? 3 * S.cnt / Math.max(1, S.hpa.n) : 1));
        g += `<rect class="xr-box ${i === 0 ? 'sel' : ''} ${isP ? 'dead' : ''} ${dead ? 'bad' : ''}" x="${x}" y="24" width="52" height="34" rx="7"/><text class="xr-m" x="${x + 26}" y="39" text-anchor="middle">${isP ? 'старт…' : dead ? 'упал' : '№' + (i + 1)}</text>`;
        if (!isP && !dead) g += `<rect class="xr-bar" x="${x + 6}" y="46" width="40" height="5" rx="2"/><rect class="xr-bar-f ${u > 0.9 ? 'bad' : u > 0.7 ? 'warn' : ''}" x="${x + 6}" y="46" width="${(40 * Math.min(1, u)).toFixed(1)}" height="5" rx="2"/>`;
      }
      if (S.hpa.n > 10) g += `<text class="xr-m" x="${IX + 10 * 58 + 4}" y="45">+${S.hpa.n - 10}</text>`;
      s += part('inst', IX - 6, 2, Math.min(640, (n + pend) * 58 + 10), 60, g); g = '';
      /* кто вызывает */
      const ins = ctx.ins();
      ins.slice(0, 4).forEach((x, i) => { const y = 110 + i * 64; s += `<g class="${ctx.canGo(x.n.id) ? 'xr-go' : ''}" data-xgo="${ctx.canGo(x.n.id) ? x.n.id : ''}"><rect class="xr-box" x="14" y="${y}" width="130" height="44" rx="9"/><text class="xr-t" x="24" y="${y + 19}">${esc(ctx.nm(x.n.id).slice(0, 15))}</text><text class="xr-s" x="24" y="${y + 34}">${SD.fmt.num(x.er.flow || 0)}/с сюда</text></g>`; });
      /* экземпляр */
      const dead = S.crash && !S.crash.over && S.t < S.crash.until;
      s += `<rect class="xr-box sel ${dead ? 'bad' : ''}" x="${IX}" y="${IY}" width="${IW}" height="${IH}" rx="14"/><text class="xr-t" x="${IX + 14}" y="${IY + 22}">Экземпляр №1 · ${S.C} vCPU · ${S.T} потоков</text>`;
      if (dead) s += `<text class="xr-pop bad" x="${IX + IW / 2}" y="${IY + IH / 2}" text-anchor="middle">${S.crash.multi ? 'упал — трафик ушёл на другие экземпляры' : 'упал — сервис недоступен'} · перезапуск ${Math.max(0, Math.ceil((S.crash.until - S.t) / 1000))} с</text>`;
      /* очередь на вход */
      g += `<text class="xr-m" x="${IX + 14}" y="${IY + 44}">очередь на вход: ${S.bl.length}${S.bl.length >= BL_MAX ? ' — полна, 503' : ''}</text>`;
      S.bl.slice(0, 30).forEach((r, k) => { g += `<circle class="xr-dot" cx="${IX + 22 + (k % 6) * 22}" cy="${IY + 64 + Math.floor(k / 6) * 22}" r="7" style="fill:${SD.kindColor(r.kind)}"/>`; });
      s += part('bl', IX + 6, IY + 30, 150, 150, g); g = '';
      /* потоки */
      g += `<text class="xr-m" x="${LX}" y="${IY + 44}">потоки: ${S.th.filter(Boolean).length} из ${S.T} заняты</text>`;
      S.th.forEach((r, i) => {
        const y = laneY(i), h = laneH() - 4;
        g += `<rect class="xa-lane" x="${LX}" y="${y}" width="${LW}" height="${h}" rx="3"/>`;
        if (!r) return;
        const st = r.steps[r.si] || {}, f = r.tE ? Math.min(1, (S.t - r.tS) / Math.max(1, r.tE - r.tS)) : 0;
        const cls = r.ph === 'cpu' ? 'cpu' : r.ph === 'io' ? 'io' : 'wait';
        const lbl = r.ph === 'cpu' ? 'считает на ядре' : r.ph === 'io' ? `ждёт: ${(st.dep || r.dep || {}).name || ''}` : r.ph === 'pool' ? 'ждёт соединение к БД' : r.ph === 'run' ? 'ждёт свободное ядро' : '';
        g += `<rect class="xa-ph ${cls}" x="${LX}" y="${y}" width="${(r.ph === 'cpu' || r.ph === 'io' ? LW * f : LW).toFixed(1)}" height="${h}" rx="3"/><circle cx="${LX - 9}" cy="${y + h / 2}" r="5" style="fill:${SD.kindColor(r.kind)}"/>`;
        if (h >= 12) g += `<text class="xa-lt" x="${LX + 6}" y="${y + h / 2 + 4}">${esc(lbl.slice(0, 40))}</text>`;
      });
      s += part('th', LX - 20, IY + 30, LW + 28, laneY(S.T) - IY - 26, g); g = '';
      /* ядра */
      const cy = IY + IH - 46;
      g += `<text class="xr-m" x="${LX}" y="${cy - 8}">ядра CPU: ${S.coreBusy} из ${S.C} считают${S.runq.length ? ` · ждут ядро: ${S.runq.length}` : ''}</text>`;
      for (let i = 0; i < S.C; i++) g += `<rect class="xr-slot xa-core ${i < S.coreBusy ? 'on' : ''}" x="${LX + i * 36}" y="${cy}" width="30" height="24" rx="5"/><text class="xa-ct ${i < S.coreBusy ? 'on' : ''}" x="${LX + i * 36 + 15}" y="${cy + 16}" text-anchor="middle">${i + 1}</text>`;
      s += part('cpu', LX - 8, cy - 24, Math.max(220, S.C * 36 + 12), 56, g); g = '';
      /* пул соединений */
      if (S.deps.some(d => POOLED.has(d.type))) {
        const px = IX + IW - 92;
        g += `<text class="xr-m" x="${px}" y="${IY + 44}">пул к БД</text><text class="xr-m ${S.poolUsed >= POOL ? 'bad' : ''}" x="${px}" y="${IY + 58}">${S.poolUsed} из ${POOL}</text>`;
        for (let i = 0; i < POOL; i++) g += `<rect class="xr-slot ${i < S.poolUsed ? (S.poolUsed >= POOL ? 'full' : 'on') : ''}" x="${px + (i % 2) * 22}" y="${IY + 68 + Math.floor(i / 2) * 22}" width="18" height="18" rx="4"/>`;
        if (S.poolQ.length) g += `<text class="xr-m bad" x="${px}" y="${IY + 192}">ждут: ${S.poolQ.length}</text>`;
        g += `<text class="xr-m acc" x="${px}" y="${IY + 210}">что это? ▸</text>`;
        s += part('pool', px - 8, IY + 30, 70, 188, g); g = '';
      }
      /* соседи */
      S.deps.slice(0, 5).forEach((d, i) => {
        const y = depY(i), slow = S.scn === 'slowdb' && POOLED.has(d.type), on = ctx.part() === 'deps';
        s += `<line class="xr-wire dash" x1="${IX + IW}" y1="${y + 20}" x2="${DX}" y2="${y + 20}"/>`;
        s += `<g class="${ctx.canGo(d.id) ? 'xr-go' : ''}" data-xgo="${ctx.canGo(d.id) ? d.id : ''}"><rect class="xr-box ${slow ? 'hot' : ''} ${on ? 'sel' : ''}" x="${DX}" y="${y}" width="190" height="42" rx="9"/><text class="xr-t" x="${DX + 10}" y="${y + 18}">${esc(d.name.slice(0, 20))}</text><text class="xr-s" x="${DX + 10}" y="${y + 33}">${d.async ? 'асинхронно' : '≈ ' + SD.fmt.ms((DEPT[d.type] || 400) / K * (slow ? 8 : 1)) + ' на вызов'}${slow ? ' · тормозит' : ''}</text></g>`;
      });
      /* точки: приход, вызовы, ответы */
      S.reqs.forEach(r => {
        if (r.ph === 'arr') { const f = 1 - (r.tE - S.t) / NET; s += `<circle class="xr-dot" cx="${lerp(150, IX + 20, f).toFixed(1)}" cy="${lerp(140, IY + 64, f).toFixed(1)}" r="6" style="fill:${SD.kindColor(r.kind)}"/>`; }
        else if (r.ph === 'io' && r.dep) {
          const i = S.deps.indexOf(r.dep); if (i < 0 || i > 4) return;
          const f = (S.t - r.tS) / Math.max(1, r.tE - r.tS), y0 = laneY(r.th) + laneH() / 2, y1 = depY(i) + 20;
          const x = f < 0.3 ? lerp(LX + LW, DX, f / 0.3) : f < 0.7 ? DX + 4 : lerp(DX, LX + LW, (f - 0.7) / 0.3), y = f < 0.3 ? lerp(y0, y1, f / 0.3) : f < 0.7 ? y1 : lerp(y1, y0, (f - 0.7) / 0.3);
          s += `<circle class="xr-dot ${f >= 0.7 ? 'ok' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" ${f >= 0.7 ? '' : `style="fill:${SD.kindColor(r.kind)}"`}/>`;
        } else if (r.ph === 'out') { const f = 1 - (r.tE - S.t) / NET; s += `<circle class="xr-dot ok" cx="${lerp(LX, 150, f).toFixed(1)}" cy="${lerp(laneY(r.th || 0), 140, f).toFixed(1)}" r="4.5"/>`; }
        else if (r.ph === 'err') { const f = 1 - (r.tE - S.t) / 800; s += `<text class="xr-pop bad" x="${IX + 60}" y="${(IY + 30 - f * 16).toFixed(1)}" style="opacity:${(1 - f).toFixed(2)}">✗ ${esc(r.why || '')}</text>`; }
      });
      ctx.svg.innerHTML = s;
    }

    build();
    return {
      tick, draw,
      refresh() { const prev = S.C; build(); if (S.C > prev && S.scn === 'cpu') S.sizeUp = true; },
      scenario(id) { S.scn = id; S.cpuDem = 0; S.crash = null; S.hpa.pend = []; S.hpa.over = 0; S.hpa.n = S.cnt; S.hist = []; S.rej = 0; S.peakBl = 0; S.sizeUp = false; rate(); },
      onProp(k, prev, v) {
        if (k === 'size') return `Ядер стало ${VCPU[v] || 2}, потоков ${Math.min(16, (VCPU[v] || 2) * 4)}. Смотри на ряд ядер внизу и очередь на вход.`;
        if (k === 'count') return S.scn === 'crash' ? 'Урони экземпляр ещё раз (переключи ситуацию) — посмотри, что изменилось.' : 'Экземпляров больше — каждому достаётся меньше запросов: полоски сверху короче.';
        if (k === 'autoscale') return v ? 'Теперь HPA следит за CPU и добавляет экземпляры. Попробуй «Всплеск ×3».' : 'Без автомасштабирования число экземпляров фиксировано.';
        if (k === 'hpaTarget') return 'Ниже цель — HPA реагирует раньше и держит запас, но платишь за простаивающие экземпляры.';
        return '';
      },
      now() {
        const busyT = S.th.filter(Boolean).length, cpu = Math.round(S.coreBusy / S.C * 100), io = S.th.filter(r => r && (r.ph === 'io' || r.ph === 'pool')).length;
        const pk = ctx.part();
        if (pk === 'pool') { ctx.done('pool'); return `<b>Пул прямо сейчас:</b> занято ${S.poolUsed} из ${POOL} соединений${S.poolQ.length ? `, ждут свободное — ${S.poolQ.length}` : ''}. Без пула каждый из этих запросов потратил бы ≈ 17 мс на рукопожатие, логин и запуск процесса в базе — дольше, чем сам запрос.`; }
        if (pk === 'th') return `<b>Потоки прямо сейчас:</b> заняты ${busyT} из ${S.T}. Считают на ядре — ${S.th.filter(r => r && r.ph === 'cpu').length}, ждут ответ соседа — ${io}, ждут свободное ядро — ${S.runq.length}. Свободных — ${S.T - busyT}.`;
        if (pk === 'cpu') return `<b>Ядра прямо сейчас:</b> считают ${S.coreBusy} из ${S.C}${S.runq.length ? `, ещё ${S.runq.length} потоков ждут свободное ядро` : ''}. Загрузка ${cpu} %.`;
        if (pk === 'bl') return `<b>Очередь на вход:</b> ${S.bl.length} запросов ждут свободный поток (пик ${S.peakBl}, лимит ${BL_MAX}). Отказов 503: ${S.rej}.`;
        if (pk === 'inst') return `<b>Экземпляров:</b> ${S.hpa.n}${S.hpa.pend.length ? ', ещё один стартует' : ''}. ${P().autoscale ? `HPA держит загрузку CPU около ${Math.round((+P().hpaTarget || 0.6) * 100)} %.` : 'Автомасштабирование выключено — число фиксировано.'}`;
        if (S.crash && !S.crash.over && S.t < S.crash.until) return S.crash.multi ? `<b>Экземпляр №1 упал.</b> Запросы, которые были внутри, потеряны (клиент повторит). Новый трафик балансировщик отдаёт остальным ${S.cnt - 1} экземплярам — им тяжелее, но сервис жив. Kubernetes перезапустит упавший.` : '<b>Экземпляр упал, а он один.</b> Все запросы получают ошибку, пока Kubernetes перезапускает его (десятки секунд). Поэтому в проде держат минимум 2–3 экземпляра в разных зонах.';
        if (S.scn === 'slowdb' && !S.deps.some(d => POOLED.has(d.type))) return '<b>У этого сервиса нет своей базы на схеме.</b> Тормозить нечему — выбери сервис, который ходит в БД, или соедини этот с базой.';
        if (S.scn === 'slowdb') return `<b>База тормозит — и сервис вместе с ней.</b> Потоков занято ${busyT} из ${S.T}, ${io} из них просто ждут ответа (жёлтые), а ядра загружены всего на ${cpu} %. ${busyT >= S.T ? 'Свободных потоков нет — новые запросы стоят в очереди на вход.' : 'Потоки один за другим застревают в ожидании — скоро свободных не останется.'}${S.poolUsed >= POOL ? ' Пул соединений к БД пуст: потоки ждут даже не базу, а свободное соединение.' : ''} Помогают таймауты, кэш, предохранитель и асинхронность.`;
        if (S.scn === 'cpu') return `<b>Каждый запрос долго считается на процессоре.</b> Ядер ${S.C} — больше ${S.C} запросов одновременно не посчитать, остальные ждут свободное ядро (красные). Потоки тут не помогают: нужен экземпляр крупнее (больше vCPU) или больше экземпляров.`;
        if (S.scn === 'spike') return P().autoscale ? `<b>Всплеск.</b> HPA сравнивает загрузку CPU с целью ${Math.round((+P().hpaTarget || 0.6) * 100)} %: держится выше 5 с — запускает ещё экземпляр. Новому нужно время на старт, пока он греется, очередь растёт. Сейчас экземпляров: ${S.hpa.n}${S.hpa.pend.length ? ', ещё один стартует' : ''}.` : `<b>Запросов втрое больше, а экземпляров столько же.</b> Ядра на пределе, очередь на вход растёт${S.rej ? `, уже ${S.rej} отказов 503` : ''}. Включи автомасштабирование справа или добавь экземпляры.`;
        return `<b>Как устроен запрос внутри.</b> Ждёт свободный поток (очередь слева) → считает на ядре (синее) → ждёт ответ соседа (жёлтое: поток занят, ядро свободно) → снова считает → отвечает. Сейчас заняты ${busyT} из ${S.T} потоков и ${S.coreBusy} из ${S.C} ядер.`;
      },
      stats() {
        const busyT = S.th.filter(Boolean).length, cpu = S.coreBusy / S.C, ok = S.hist.filter(h => !h.err).map(h => h.lat).sort((a, b) => a - b), err = S.hist.filter(h => h.err).length;
        const p95 = ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.95))] : 0;
        return [
          ['Потоки', `${busyT} из ${S.T}`, busyT >= S.T ? 'bad' : busyT > S.T * 0.75 ? 'warn' : 'ok', 'заняты сейчас'],
          ['CPU', Math.round(cpu * 100) + ' %', cpu >= 1 ? 'bad' : cpu > 0.75 ? 'warn' : 'ok', S.runq.length ? `ждут ядро: ${S.runq.length}` : 'ядра считают'],
          ['Очередь на вход', String(S.bl.length), S.bl.length > 10 ? 'bad' : S.bl.length ? 'warn' : 'ok', `пик ${S.peakBl}`],
          ['Пул к БД', `${S.poolUsed} из ${POOL}`, S.poolUsed >= POOL ? 'bad' : '', S.poolQ.length ? `ждут: ${S.poolQ.length}` : 'соединений занято'],
          ['p95 ответа', ok.length >= 5 ? SD.fmt.ms(p95 / K) : '…', p95 > 6000 ? 'bad' : p95 > 3000 ? 'warn' : 'ok', 'время замедлено ×' + K],
          ['Ошибки', String(err), err ? 'bad' : 'ok', 'из последних ' + S.hist.length]
        ];
      }
    };
  }

  /* ---------- вид «Слои кода»: запрос идёт роут → сервисный слой → домен → репозиторий → БД ---------- */
  const BAND = {
    in: ['Роуты и контроллеры', 'принимают запрос: HTTP, gRPC, сообщения'],
    app: ['Сервисный слой', 'сценарии: что сделать и в каком порядке'],
    dom: ['Домен', 'модель и бизнес-правила'],
    infra: ['Репозитории и клиенты', 'как достать данные и позвать соседей']
  };
  const BY = { in: 50, app: 132, dom: 214, infra: 296 }, BH = 76, CX = 214, CW = 985;
  const DUR = { msg: 800, self: 600, note: 900, frag: 600, end: 1100 };
  function layersScene(ctx) {
    const esc = ctx.esc;
    const L = { own: false, node: null, g: null, M: null, files: null, pos: {}, plan: [], si: 0, t: 0, mode: 'auto', turn: 0, wait: false, tr: null, k: 'read', last: null, done: 0 };
    function build() {
      const n = ctx.node, g = SD.app.A.graph;
      L.own = !!(n.props.inner && n.props.inner.nodes && n.props.inner.nodes.length);
      let node = n, gg = g;
      if (!L.own) {
        const I = SD.inner.scaffold(n, g, 'layered', ctx.all);
        node = Object.assign({}, n, { props: Object.assign({}, n.props, { inner: I }) });
        gg = Object.assign({}, g, { nodes: g.nodes.map(x => x.id === n.id ? node : x) });
      }
      L.node = node; L.g = gg; L.M = SD.inner.model(node, gg);
      try { L.files = SD.innerCode ? SD.innerCode.files(node, gg) : null; } catch (e) { L.files = null; }
      layout(); L.plan = [];
    }
    function layout() {
      const P = {};
      ['in', 'app', 'dom', 'infra'].forEach(l => {
        const cs = L.M.comps.filter(c => c.t.layer === l).sort((a, b) => (a.y || 0) - (b.y || 0)).slice(0, 4);
        const w = Math.min(230, (CW - CX - (cs.length - 1) * 12) / Math.max(1, cs.length));
        cs.forEach((c, i) => { P[c.id] = { x: CX + i * (w + 12), y: BY[l] + 14, w, h: 50, c }; });
      });
      const cl = L.M.outer.callers.slice(0, 3);
      cl.forEach((x, i) => { P[i ? 'caller' + i : 'caller'] = { x: CX + i * 200, y: 6, w: 184, h: 32, n: x.node }; });
      if (!cl.length) P.caller = { x: CX, y: 6, w: 184, h: 32, n: null };
      const ks = L.M.outer.kids.slice(0, 5), kw = Math.min(190, (CW - CX - (ks.length - 1) * 12) / Math.max(1, ks.length));
      ks.forEach((x, i) => { P['o:' + x.node.id] = { x: CX + i * (kw + 12), y: 384, w: kw, h: 40, n: x.node }; });
      L.pos = P;
    }
    const flat = (items, frag) => { const out = []; (items || []).forEach(it => { if (it.t === 'frag') { out.push({ t: 'frag', label: it.label, kind: it.kind }); out.push(...flat(it.items, it.label)); } else if (it.t !== 'par') out.push(Object.assign({}, it, { frag })); else out.push(...flat(it.items, frag)); }); return out; };
    function nextTrace() {
      const E = k => SD.inner.entriesFor(L.M, k);
      let k = L.mode === 'read' || L.mode === 'write' ? L.mode : null;
      if (!k) { const ld = ctx.res.load || {}, opts = ['read', 'write', 'job'].filter(x => E(x).length && (x === 'job' || !Object.keys(ld).length || Object.keys(ld).some(q => SD.inner.kindClass(q) === x))); const o = opts.length ? opts : ['read', 'write', 'job'].filter(x => E(x).length); k = o[L.turn++ % Math.max(1, o.length)] || 'read'; }
      const e = E(k)[0] || E('read')[0] || E('write')[0] || E('job')[0];
      if (!e) { L.plan = []; L.tr = null; return; }
      if (!E(k).length) k = E('read').length ? 'read' : E('write').length ? 'write' : 'job';
      L.tr = SD.inner.trace(L.node, L.g, ctx.all, e.id, k); L.k = k;
      L.plan = L.tr ? flat(L.tr.items).concat([{ t: 'end' }]) : [];
      L.si = 0; L.t = 0; L.wait = false;
      ctx.log(`<b>Новый запрос: ${k === 'read' ? 'чтение (GET)' : k === 'write' ? 'запись (POST)' : 'сообщение из брокера'}</b> — смотри, как он проходит слои.`);
    }
    function tick(dt) {
      if (!L.plan.length) { nextTrace(); return; }
      if (L.wait) return;
      L.t += dt;
      const st = L.plan[L.si];
      if (L.t < (DUR[st.t] || 500)) return;
      L.si++; L.t = 0;
      if (st.t === 'end') { L.done++; if (L.k === 'write') ctx.done('lwrite'); if (L.k === 'read') ctx.done('lread'); nextTrace(); return; }
      if (L.mode === 'step') L.wait = true;
    }
    const nm = c => SD.inner.nameOf(c);
    const ctr = p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
    function draw() {
      if (!L.M) return;
      const st = L.plan[L.si] || {}, P = L.pos;
      const actKey = st.t === 'msg' ? st.to : st.at;
      const actC = actKey && P[actKey] && P[actKey].c, actLayer = actC ? actC.t.layer : null;
      let s = `<defs><marker id="xaArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="xa-arr"/></marker></defs>`;
      ['in', 'app', 'dom', 'infra'].forEach(l => {
        const col = (SD.CLAYERS.find(x => x.id === l) || {}).color;
        s += `<g class="xr-part ${ctx.part() === l ? 'on' : ''}" data-xpart="${l}"><rect class="xa-band ${actLayer === l || ctx.part() === l ? 'on' : ''}" x="10" y="${BY[l]}" width="${CW + 6 - 10}" height="${BH}" rx="10"/><rect x="10" y="${BY[l]}" width="5" height="${BH}" rx="2" style="fill:${col}"/>`;
        s += `<text class="xr-t" x="26" y="${BY[l] + 26}">${BAND[l][0]} <tspan class="xa-q">?</tspan></text>`;
        const sub = BAND[l][1].length > 30 ? [BAND[l][1].slice(0, BAND[l][1].lastIndexOf(' ', 30)), BAND[l][1].slice(BAND[l][1].lastIndexOf(' ', 30) + 1)] : [BAND[l][1]];
        sub.forEach((t, i) => { s += `<text class="xr-s" x="26" y="${BY[l] + 44 + i * 14}">${esc(t)}</text>`; });
        s += '</g>';
        if (!L.M.comps.some(c => c.t.layer === l)) s += `<text class="xr-s" x="${CX + 6}" y="${BY[l] + 44}">${l === 'dom' ? 'в слоистой схеме правила часто живут прямо в сервисном слое — так проще, но хуже тестировать' : 'пусто'}</text>`;
      });
      /* зависимости между компонентами */
      L.M.edges.forEach(e => {
        const a = P[e.from], b = P[e.to]; if (!a || !b) return;
        const impl = a.c.t.layer === 'infra' && b.c.type === 'port';
        const x1 = a.x + a.w / 2, y1 = b.y > a.y ? a.y + a.h : b.y < a.y ? a.y : a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y > a.y ? b.y : b.y < a.y ? b.y + b.h : b.y + b.h / 2;
        s += `<line class="xa-dep ${impl ? 'impl' : ''}" x1="${x1.toFixed(1)}" y1="${y1}" x2="${x2.toFixed(1)}" y2="${y2}" marker-end="url(#xaArr)"/>`;
      });
      /* связи адаптеров с внешним миром */
      L.M.comps.forEach(c => { if (!c.bound || !P[c.id] || !P['o:' + c.bound.node.id]) return; const a = P[c.id], b = P['o:' + c.bound.node.id]; s += `<line class="xr-wire dash" x1="${a.x + a.w / 2}" y1="${a.y + a.h}" x2="${b.x + b.w / 2}" y2="${b.y}"/>`; });
      /* компоненты */
      const names = L.files ? L.files.names : null;
      Object.entries(P).forEach(([key, p]) => {
        if (p.c) {
          const on = key === actKey;
          s += `<g><rect class="xr-box ${on ? 'sel' : ''}" x="${p.x}" y="${p.y}" width="${p.w.toFixed(1)}" height="${p.h}" rx="8"/><text class="xr-t" x="${p.x + 10}" y="${p.y + 19}">${esc(nm(p.c).slice(0, Math.floor(p.w / 7.6)))}</text><text class="xr-m" x="${p.x + 10}" y="${p.y + 36}">${esc(((names && names.get(p.c.id)) || p.c.t.base).slice(0, Math.floor(p.w / 6.6)))}</text></g>`;
          if (on && st.t === 'self') s += `<rect class="xa-pulse" x="${p.x - 3}" y="${p.y - 3}" width="${(p.w + 6).toFixed(1)}" height="${p.h + 6}" rx="10"/>`;
        } else {
          const go = p.n && ctx.canGo(p.n.id);
          s += `<g class="${go ? 'xr-go' : ''}" data-xgo="${go ? p.n.id : ''}"><rect class="xr-box ${key === actKey ? 'sel' : ''}" x="${p.x}" y="${p.y}" width="${p.w.toFixed(1)}" height="${p.h}" rx="8"/><text class="xr-t" x="${p.x + 10}" y="${p.y + (p.h > 34 ? 17 : 21)}">${esc(p.n ? ctx.nm(p.n.id).slice(0, 22) : 'Клиент')}</text>${p.h > 34 ? `<text class="xr-s" x="${p.x + 10}" y="${p.y + 32}">${key.startsWith('o:') ? 'снаружи сервиса' : ''}</text>` : ''}</g>`;
        }
      });
      /* текущий шаг: точка летит между компонентами */
      if (st.t === 'msg') {
        const a = P[st.from] || P.caller, b = P[st.to] || P.caller;
        if (a && b) {
          const f = Math.min(1, L.t / DUR.msg), A = ctr(a), B = ctr(b), x = A.x + (B.x - A.x) * f, y = A.y + (B.y - A.y) * f;
          s += `<line class="xr-wire act" x1="${A.x.toFixed(1)}" y1="${A.y.toFixed(1)}" x2="${B.x.toFixed(1)}" y2="${B.y.toFixed(1)}"/><circle class="xr-dot ${st.ret ? 'ok' : st.bad ? 'err' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" ${st.ret || st.bad ? '' : `style="fill:${SD.kindColor(L.k === 'job' ? 'job' : L.k)}"`}/>`;
          const lx = (A.x + B.x) / 2 + 10, ly = (A.y + B.y) / 2 - 8;
          s += `<text class="xr-pop ${st.outer ? 'warn' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${esc(String(st.label).slice(0, 46))}${st.ms >= 0.5 ? ' · ' + esc(SD.fmt.ms(st.ms)) : ''}</text>`;
        }
      } else if ((st.t === 'self' || st.t === 'note') && P[st.at]) {
        const p = P[st.at];
        s += `<text class="xr-pop ${st.t === 'note' ? 'warn' : ''}" x="${p.x + p.w + 8}" y="${p.y + 20}">${esc(String(st.label).slice(0, 44))}${st.ms >= 0.3 ? ' · ' + esc(SD.fmt.ms(st.ms)) : ''}</text>`;
      }
      const fr = st.frag || (st.t === 'frag' ? st.label : null);
      if (fr) s += `<rect class="xa-frag" x="${CW - 230}" y="10" width="230" height="26" rx="13"/><text class="xr-m acc" x="${CW - 115}" y="27" text-anchor="middle">идёт: ${esc(fr)}</text>`;
      /* подпись снизу */
      const n = Math.max(0, L.plan.length - 1);
      s += `<text class="xr-m" x="14" y="452">${L.k === 'read' ? 'Чтение · GET' : L.k === 'write' ? 'Запись · POST' : 'Сообщение из брокера'} · шаг ${Math.min(L.si + 1, n)} из ${n}${L.own ? '' : ' · типовая раскладка слоёв'}</text>`;
      s += `<text class="xr-s" x="14" y="472">Стрелки — «кто от кого зависит». ${L.M.comps.some(c => c.type === 'port') ? 'Пунктир вверх — адаптер реализует порт домена: зависимость направлена к домену.' : 'В слоистой схеме вызовы идут сверху вниз: роут → сервис → репозиторий.'}</text>`;
      if (L.mode === 'step') s += `<g class="xa-next" data-xa="next"><rect x="${CW - 170}" y="440" width="176" height="34" rx="10"/><text x="${CW - 82}" y="462" text-anchor="middle">${L.wait ? 'Следующий шаг ▶' : 'идёт шаг…'}</text></g>`;
      ctx.svg.innerHTML = s;
    }
    const msF = v => v < 1 ? (v < 0.05 ? '< 0,1 мс' : v.toFixed(1).replace('.', ',') + ' мс') : SD.fmt.ms(v);
    function codeHtml(st) {
      if (!L.files || !st) return '';
      const key = st.t === 'msg' ? (st.from === 'caller' || String(st.from).startsWith('o:') ? st.to : st.from) : st.at;
      const f = L.files.files.find(x => x.comp === key); if (!f) return '';
      const lines = f.src.split('\n').filter(l => !/^import |^\s*$/.test(l));
      let tok = '', anchor = '';
      if (st.t === 'msg') { const lb = String(st.label); if (st.outer) anchor = /SELECT/.test(lb) ? (L.k === 'read' ? 'findById' : '') : /INSERT|UPDATE/.test(lb) ? 'save' : /GET key/.test(lb) ? 'getOrLoad' : '';
        tok = st.outer ? (/SELECT/.test(lb) ? 'query' : /INSERT|UPDATE|COMMIT/.test(lb) ? (/COMMIT/.test(lb) ? 'transaction' : 'query') : /GET key/.test(lb) ? 'get' : /publish/.test(lb) ? 'send' : 'fetch') : (lb.split('.').pop() || '').replace(/\(.*$/, ''); }
      if (st.t === 'self') tok = /auth/.test(st.label) ? 'jwt' : /валид/.test(st.label) ? 'parse' : /trace/.test(st.label) ? 'correlation' : /идемп/.test(st.label) ? 'idempot' : '';
      const a0 = anchor ? lines.findIndex(l => l.includes(anchor + '(')) : -1;
      let hit = tok ? lines.findIndex((l, i) => i >= Math.max(0, a0) && l.toLowerCase().includes(tok.toLowerCase())) : -1;
      if (hit < 0 && a0 >= 0) hit = a0;
      const from = Math.max(0, Math.min(lines.length - 14, (hit < 0 ? 0 : hit) - 5));
      const body = lines.slice(from, from + 14).map((l, i) => { const t = esc(l.length > 64 ? l.slice(0, 63) + '…' : l); return from + i === hit ? `<mark>${t}</mark>` : t; }).join('\n');
      return `<span class="xa-path">${esc(f.path)}</span><pre class="xa-code">${body}</pre>`;
    }
    function explain(st) {
      if (!st || !st.t) return '';
      if (st.t === 'end') return '<b>Запрос обработан.</b> Каждый слой сделал только своё: роут — HTTP, сервисный слой — порядок шагов, домен — правила, репозиторий — SQL. Поэтому базу можно поменять, не трогая правила, а правила — проверить тестом без HTTP и базы.';
      if (st.t === 'frag') return st.kind === 'tx' ? '<b>Начинается транзакция.</b> Всё внутри скобки либо сохранится целиком, либо откатится целиком.' : st.kind === 'loop' ? '<b>Цикл запросов (N+1).</b> Репозиторий ходит в базу по одному разу на каждую строку — медленно. Лечится одним запросом с JOIN или пачкой.' : `<b>${esc(st.label)}.</b>`;
      if (st.t === 'note') return `<b>Заметка:</b> ${esc(st.label)}.`;
      if (st.t === 'self') return `<b>Middleware в роуте: ${esc(st.label)}.</b> Общие проверки до бизнес-логики: кто ты (токен), правильный ли запрос (валидация), метка для логов (trace id).`;
      const to = L.pos[st.to], c = to && to.c;
      if (st.ret) return `<b>Ответ «${esc(st.label)}» уходит обратно.</b> Роут превращает результат сценария в HTTP-ответ (JSON и код статуса).`;
      if (st.outer) return `<b>Запрос ушёл за пределы сервиса: «${esc(st.label)}».</b> Это сеть и ожидание${st.ms >= 0.5 ? ` ≈ ${esc(SD.fmt.ms(st.ms))}` : ''}. Пока ответа нет, поток сервиса ждёт — поэтому почти всё время запроса тратится здесь, а не в коде.`;
      if (st.from === 'caller' && c) return `<b>Роут принял запрос.</b> «${esc(nm(c))}» разбирает HTTP: адрес, заголовки, тело. Бизнес-логики здесь нет — только «понять запрос и передать дальше».`;
      if (!c) return '';
      const T = { app: `<b>Сервисный слой: «${esc(nm(c))}».</b> Сценарий знает порядок шагов: прочитать данные, проверить правило, сохранить, отправить событие. Сам в базу не ходит — зовёт репозиторий.`, dom: `<b>Домен: «${esc(nm(c))}».</b> Здесь живут правила: «нельзя оформить пустой заказ», «сумма не может быть отрицательной». Домен не знает ни про HTTP, ни про базу — его легко проверить тестом.`, infra: { repo: `<b>Репозиторий: «${esc(nm(c))}».</b> Переводит «сохрани заказ» в SQL. Только он знает, какая база, какие таблицы и как строить запрос.`, cachecl: `<b>Клиент кэша: «${esc(nm(c))}».</b> Сначала спрашивает Redis; нет ключа — читает из базы и кладёт в кэш.`, httpcl: `<b>Клиент к соседу: «${esc(nm(c))}».</b> Знает адрес, формат и таймауты другого сервиса — сценарий просто зовёт метод.`, pub: `<b>Публикатор: «${esc(nm(c))}».</b> Отправляет событие в брокер, чтобы другие сервисы узнали о случившемся.` } };
      return c.t.layer === 'infra' ? (T.infra[c.type] || `<b>Адаптер: «${esc(nm(c))}».</b> Говорит с внешним миром за остальной код.`) : c.t.layer === 'in' ? `<b>Вход: «${esc(nm(c))}».</b>` : T[c.t.layer] || '';
    }
    const onSvg = e => { const b = e.target.closest('[data-xa="next"]'); if (b && L.wait) { L.wait = false; L.t = 0; } };
    ctx.svg.addEventListener('click', onSvg);
    build();
    return {
      tick, draw,
      refresh() { build(); },
      scenario(id) { L.mode = id; L.plan = []; L.wait = false; },
      now() {
        const st = L.plan[L.si], pk = ctx.part();
        if (pk && L.files) {
          const cs = L.M.comps.filter(c => c.t.layer === pk);
          if (!cs.length) return '<b>В этой раскладке слой пустой.</b> Правила живут прямо в сервисном слое. Собери «Порты и адаптеры» кнопкой «Собрать свои слои» — появятся агрегат и порты.';
          return `<b>Код слоя целиком.</b> Файлы этого слоя в твоём сервисе:` + cs.map(c => { const f = L.files.files.find(x => x.comp === c.id); return f ? `<span class="xa-path">${esc(f.path)}</span><pre class="xa-code">${esc(f.src.split('\n').filter(l => !/^import /.test(l)).slice(0, 40).join('\n'))}</pre>` : ''; }).join('');
        }
        let h = L.own ? '' : '<p class="xa-note">Это типовая раскладка слоёв для этого сервиса. Свою можно собрать и поменять кнопкой «Собрать свои слои» ниже — классические слои, порты и адаптеры или CQRS.</p>';
        h += explain(st) || '<b>Смотри, как запрос проходит слои сверху вниз и обратно.</b>';
        h += codeHtml(st && st.t !== 'end' && st.t !== 'frag' ? st : L.last);
        if (st && (st.t === 'msg' || st.t === 'self')) L.last = st;
        return h;
      },
      stats() {
        const tr = L.tr; if (!tr) return [];
        const items = flat(tr.items);
        let mw = 0, own = 0, out = 0;
        items.forEach(it => { if (it.t === 'self') mw += it.ms || 0; else if (it.t === 'msg') { if (it.outer) out += it.ms || 0; else own += it.ms || 0; } });
        const tot = mw + own + out || 1;
        return [
          ['Роут и middleware', msF(mw), '', Math.round(mw / tot * 100) + ' % времени'],
          ['Сервисный слой, домен, адаптеры', msF(own), '', Math.round(own / tot * 100) + ' % времени'],
          ['Ждём БД и соседей', SD.fmt.ms(out), out / tot > 0.8 ? 'warn' : '', Math.round(out / tot * 100) + ' % времени'],
          ['Весь запрос', SD.fmt.ms(tot), '', 'код быстрый — время уходит на ожидание'],
          ['Компонентов', String(L.M.comps.length), '', L.own ? 'своя раскладка' : 'типовая раскладка']
        ];
      },
      destroy() { ctx.svg.removeEventListener('click', onSvg); }
    };
  }
})();
