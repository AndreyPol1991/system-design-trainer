/* Эксплуатация на площадке: переключатель слоёв, инструменты изнутри (живые консоли и Kubernetes)
   и уровни «Эксплуатация и инструменты»: проблема → поставь инструмент → проверь сбоем → загляни внутрь. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const A = () => SD.app.A;
  const lbl = n => n ? (n.label || SD.TYPES[n.type].name) : '';
  const SVC = new Set(['app', 'worker', 'gateway', 'ws', 'faas', 'agent']);

  /* ---------- переключатель слоёв на холсте ---------- */
  let lastOps = -1, lastSig = '';
  function renderLayers() {
    const d = $('layerCtl'); if (!d || !SD.editor.getLayer || !SD.app || !SD.app.A || !SD.app.A.graph) return;
    const g = A().graph, cur = SD.editor.getLayer();
    const cnt = l => g.nodes.filter(n => SD.layerOf(n.type) === l).length;
    d.innerHTML = `<span class="lc-t">Слои</span>` + SD.LAYERS.map(([k, t]) => `<button type="button" data-layer="${k}" class="${cur === k ? 'on' : ''}" aria-pressed="${cur === k}" title="${k === 'all' ? 'Показать всё сразу' : k === 'product' ? 'Только продукт: то, через что идут запросы пользователей' : 'Продукт приглушён, слой «' + t + '» — ярко'}">${t}${k === 'all' ? '' : ` <small>${cnt(k)}</small>`}</button>`).join('');
  }
  function mountLayers() {
    const wrap = $('canvasWrap'); if (!wrap || $('layerCtl')) return;
    const d = document.createElement('div'); d.className = 'layer-ctl'; d.id = 'layerCtl';
    wrap.appendChild(d);
    d.addEventListener('click', e => { const b = e.target.closest('[data-layer]'); if (!b) return; SD.editor.setLayer(b.dataset.layer); renderLayers(); });
    renderLayers();
    setInterval(() => {
      if (!SD.app || !SD.app.A || !SD.app.A.graph) return;
      const g = A().graph, n = g.nodes.filter(x => SD.layerOf(x.type) !== 'product').length;
      if (lastOps >= 0 && n > lastOps && SD.editor.getLayer() === 'product') SD.editor.setLayer('all');
      const sig = g.nodes.map(x => SD.layerOf(x.type)).sort().join(',') + '|' + SD.editor.getLayer();
      lastOps = n;
      if (sig !== lastSig) { lastSig = sig; renderLayers(); }
    }, 800);
  }

  /* ---------- инструменты изнутри: живые консоли ---------- */
  const PARTS = {
    prometheus: {
      scrape: { name: 'Опрос /metrics', an: 'Медсестра обходит палаты и записывает пульс каждому пациенту.', pl: 'Prometheus сам ходит к каждому сервису за цифрами — сервису не надо никуда ничего слать.', how: ['Сервис отдаёт страницу /metrics: счётчики и гистограммы в текстовом формате.', 'Список целей Prometheus берёт из Kubernetes (service discovery): поднялся новый под — его начнут опрашивать сами.', 'Раз в 15 с забирает все числа и ставит метку времени.', 'Не ответил — up = 0: это само по себе сигнал «экземпляр недоступен».'], knobs: ['scrape'], real: 'Формат OpenMetrics; клиентские библиотеки есть для всех языков (Micrometer, prometheus-client).' },
      tsdb: { name: 'Хранилище временных рядов', an: 'Тетрадь, где каждая строка — один показатель, а в строке столбиком — значения по времени.', pl: 'Каждый набор меток (сервис, метод, код ответа) — отдельный ряд чисел во времени. Хранится сжатым блоками по 2 часа.', how: ['Свежие данные — в памяти и журнале (WAL).', 'Каждые 2 часа сбрасываются в блок на диск.', 'Старые блоки сливаются и удаляются по сроку хранения.', 'Много разных меток (например, id пользователя) взрывает число рядов — главная ошибка новичков.'], knobs: ['retention'], real: '1–2 байта на точку после сжатия; миллионы рядов на одном сервере.' },
      promql: { name: 'Запросы PromQL', an: 'Калькулятор, который считает не по одному числу, а по целой ленте значений.', pl: 'rate() превращает растущий счётчик в «сколько в секунду», sum by — складывает по сервисам, histogram_quantile — считает p95.', how: ['http_requests_total — счётчик, он только растёт.', 'rate(…[1m]) — скорость роста за минуту: запросов в секунду.', 'Отношение ошибок к запросам — доля ошибок.', 'Эти же запросы используются в дашбордах и в правилах алертов.'], real: 'Grafana отправляет в Prometheus именно PromQL-запросы.' },
      rules: { name: 'Правила алертов', an: 'Будильник с условием: «зазвони, если температура выше 38 дольше 10 минут».', pl: 'Prometheus регулярно проверяет условия. Условие держится дольше for — правило срабатывает и уходит в Alertmanager.', how: ['Правило: выражение PromQL + длительность for.', 'Сначала состояние pending — ждём, не всплеск ли это.', 'Держится дольше for — firing, отправка в Alertmanager.', 'Условие ушло — resolved.'], real: 'Правила хранят в Git рядом с кодом сервиса.' }
    },
    grafana: {
      ds: { name: 'Источники данных', an: 'Телевизор, к которому подключены разные антенны.', pl: 'Grafana не хранит данные сама — она спрашивает Prometheus, Loki, Elasticsearch, базы.', how: ['Подключаешь источник: адрес и доступ.', 'Каждая панель — запрос к источнику.', 'На одном дашборде могут быть метрики, логи и трейсы.'], real: 'Prometheus, Loki, Tempo, Elasticsearch, PostgreSQL, ClickHouse.' },
      panels: { name: 'Панели и дашборды', an: 'Приборная панель автомобиля: каждый прибор — своё число.', pl: 'Дашборд — набор графиков. Хороший дашборд отвечает на вопрос «всё ли в порядке» за 5 секунд.', how: ['Сверху — главное: запросы, ошибки, задержка (RED).', 'Ниже — насыщение: CPU, память, пулы, очереди.', 'Переменные: выбрать сервис или окружение из списка.', 'Дашборды хранят как код (JSON в Git).'], real: 'Готовые дашборды для Kubernetes, PostgreSQL, Kafka есть на grafana.com.' },
      jump: { name: 'Переходы к логам и трейсам', an: 'Из графика давления — сразу в историю болезни нужного дня.', pl: 'Нашёл всплеск ошибок на графике — один клик ведёт к логам и трейсам за ту же минуту.', how: ['Выделяешь участок графика.', 'Открываешь логи сервиса за это время.', 'Из лога по trace id — в трейс.'], real: 'Grafana Explore, exemplars в Prometheus.' }
    },
    alertmanager: {
      group: { name: 'Группировка', an: 'Вместо 50 звонков «горит кухня», «горит зал», «горит склад» — один: «пожар в ресторане».', pl: 'Похожие алерты склеиваются в одно уведомление, чтобы дежурного не завалило.', how: ['Алерты группируются по меткам (сервис, кластер).', 'Ждёт несколько секунд, собирая группу.', 'Повторяет напоминание, пока проблема не решена.'], real: 'group_by, group_wait, repeat_interval.' },
      route: { name: 'Маршруты и дежурства', an: 'Диспетчер решает: в пожарную, в скорую или в аварийку.', pl: 'Критичное — звонком дежурному, предупреждения — в чат команды, по метке сервиса — нужной команде.', knobs: ['channel'], how: ['Дерево маршрутов по меткам severity и team.', 'Получатели: PagerDuty, Opsgenie, Telegram, Slack, почта.', 'Расписание дежурств живёт в PagerDuty/Opsgenie.'], real: 'Ночью почту не читают: critical — только звонок.' },
      silence: { name: 'Тишина и подавление', an: 'Табличка «идёт ремонт, сигнализацию не включать».', pl: 'На время работ алерты глушат, а следствия главной аварии подавляют.', how: ['Silence — заглушить по меткам на время.', 'Inhibition — если упала база, не звонить про каждый сервис, которому она нужна.'], real: 'Шумные алерты быстро перестают читать — это главная беда алертинга.' }
    },
    kibana: {
      ship: { name: 'Сбор логов', an: 'Почтальон забирает письма из каждого ящика и везёт на сортировку.', pl: 'Сервис пишет в stdout, агент на каждом сервере читает логи контейнеров и отправляет в хранилище.', how: ['Лог лучше писать структурно — JSON с полями.', 'Агент (Fluent Bit, Filebeat) читает файлы логов контейнеров.', 'Добавляет метки: сервис, под, версия.', 'Отправляет пачками в Elasticsearch.'], real: 'Fluent Bit, Filebeat, Vector, OpenTelemetry Collector.' },
      index: { name: 'Поисковый индекс', an: 'Предметный указатель в конце книги: слово → страницы, где оно встречается.', pl: 'Elasticsearch строит обратный индекс: каждое слово знает, в каких записях оно есть. Поэтому поиск по миллиардам строк быстрый.', knobs: ['retention'], how: ['Каждая запись разбивается на слова (токены).', 'Для каждого слова — список записей, где оно есть.', 'Запрос «timeout AND orders» — пересечение двух списков.', 'Индексы делят по дням: старые удаляются по сроку хранения.'], real: 'Elasticsearch/OpenSearch; Loki индексирует только метки — дешевле, но поиск по тексту медленнее.' },
      shards: { name: 'Шарды и реплики', an: 'Огромный архив разделён на шкафы, у каждого шкафа есть копия.', pl: 'Индекс делится на шарды по разным серверам, у каждого шарда есть копия на случай падения.', how: ['Запрос рассылается во все шарды параллельно.', 'Каждый ищет у себя, результаты сливаются.', 'Упал сервер — работает копия шарда.'], real: 'Слишком много маленьких шардов — частая причина тормозов кластера.' },
      kql: { name: 'Поиск в Kibana', an: 'Поисковая строка как в почте: «от кого», «за какую дату», «со словом».', pl: 'Фильтры по полям (service, level), полнотекстовый поиск, гистограмма по времени.', how: ['level:ERROR and service:orders', 'Выбираешь период на гистограмме.', 'По trace_id — все записи одного запроса во всех сервисах.'], real: 'KQL и Lucene-синтаксис.' }
    },
    jaeger: {
      ctx: { name: 'trace id и контекст', an: 'Номер посылки, который ставят на каждый склад, через который она проходит.', pl: 'На входе запрос получает trace id. Каждый сервис передаёт его дальше в заголовке traceparent.', how: ['Первый сервис создаёт trace id.', 'При вызове соседа добавляет заголовок traceparent.', 'Сосед продолжает тот же трейс.', 'Тот же trace id пишется в логи — так их связывают.'], real: 'W3C Trace Context, OpenTelemetry SDK делает это автоматически.' },
      spans: { name: 'Отрезки (spans)', an: 'Отметки в маршрутном листе: пришёл, ушёл, сколько был.', pl: 'Каждый шаг — отрезок с началом, длительностью и родителем. Из них складывается водопад.', how: ['Отрезок: сервис, операция, время, длительность, ошибка.', 'Вложенный вызов — дочерний отрезок.', 'Водопад сразу показывает, где ждали.'], real: 'Jaeger, Grafana Tempo, Zipkin.' },
      sample: { name: 'Сэмплирование', an: 'Проверять не каждую посылку, а каждую десятую — и все повреждённые.', pl: 'Записывать все запросы дорого. Записывают долю обычных и все с ошибками.', knobs: ['sampling'], how: ['Head sampling — решаем на входе: 10 % запросов.', 'Tail sampling — решаем в конце: все медленные и с ошибками.'], real: 'OpenTelemetry Collector умеет tail sampling.' }
    }
  };
  const CON = { prometheus: 'prom', grafana: 'grafana', alertmanager: 'alert', kibana: 'kibana', jaeger: 'jaeger' };
  const SIMPLE = {
    prometheus: ['Медсестра, которая каждые 15 секунд обходит всех пациентов и записывает пульс.', 'Prometheus опрашивает сервисы и хранит числа во времени. Здесь — живые цифры твоей схемы.'],
    grafana: ['Приборная панель автомобиля: скорость, обороты, температура — на одном экране.', 'Графики по метрикам твоих сервисов. Пунктир — порог алерта.'],
    alertmanager: ['Пожарная сигнализация: сама звонит в часть, не ждёт, пока кто-то заметит дым.', 'Правила проверяются по метрикам; сработавшие уходят дежурному.'],
    kibana: ['Бортовой журнал всех кораблей флотилии в одной книге с поиском.', 'Логи подключённых сервисов в одном месте: ищи по тексту, уровню, trace id.'],
    jaeger: ['GPS-трекер посылки: видно каждый склад и сколько она там пролежала.', 'Трейсы запросов: какой шаг сколько занял и кто тормозит.']
  };
  function consoleScene(type) {
    SD.XRAY[type] = {
      cta: 'Живые данные твоей схемы и как инструмент устроен внутри',
      simple: () => ({ an: SIMPLE[type][0], pl: SIMPLE[type][1] }),
      props: (SD.TYPES[type].props || []).map(p => p.key),
      parts: PARTS[type],
      html: true,
      live: (n) => { const s = SD.opsState(A().graph), c = { prometheus: s.metrics.size, kibana: s.logs.size, jaeger: s.traces.size }[type]; return c != null ? [['Подключено сервисов', c + ' из ' + s.svcs.length, c && c === s.svcs.length ? 'ok' : 'warn']] : [['Подключён', type === 'grafana' ? (s.dash ? 'к Prometheus' : 'нет') : (s.alerts ? 'к Prometheus' : 'нет'), (type === 'grafana' ? s.dash : s.alerts) ? 'ok' : 'warn']]; },
      tries: [{ id: 'chaos', text: 'Нажми «Уронить экземпляр» и найди этот сбой здесь' }, { id: 'heal', text: '«Поднять всё» — и посмотри, как всё возвращается в норму' }],
      legend: [['ok', 'Норма'], ['warn', 'Предупреждение или ожидание'], ['bad', 'Ошибка, порог алерта, упавший экземпляр']],
      mount(ctx) {
        ctx.useHtml(true);
        const box = ctx.html, tab = CON[type];
        let last = performance.now(), qt = 0;
        SD.ops.reset();
        const st = () => SD.opsState(A().graph);
        const head = () => {
          const s = st(), conn = { prometheus: s.metrics.size, kibana: s.logs.size, jaeger: s.traces.size, grafana: s.dash ? 1 : 0, alertmanager: s.alerts ? 1 : 0 }[type];
          const warn = !conn ? `<div class="oc-off"><b>Пока ничего не подключено.</b> ${{ prometheus: 'Проведи стрелки от сервисов к Prometheus.', kibana: 'Проведи стрелки от сервисов к логам.', jaeger: 'Проведи стрелки от сервисов к Jaeger.', grafana: 'Соедини Prometheus и Grafana стрелкой.', alertmanager: 'Соедини Prometheus и Alertmanager стрелкой.' }[type]}</div>` : '';
          return `<div class="oc-head"><b class="oc-lbl">Сбой на площадке:</b><button type="button" class="btn" data-ocact="chaos">Уронить экземпляр</button><button type="button" class="btn" data-ocact="wave">Волна ×3</button><button type="button" class="btn ghost" data-ocact="heal">Поднять всё</button></div>${warn}`;
        };
        const render = force => {
          const ae = document.activeElement;
          if (!force && ae && box.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
          const top = box.scrollTop;
          box.innerHTML = head() + `<div class="oc-body">${SD.ops.render(tab)}</div>`;
          box.scrollTop = top;
        };
        const onClick = e => {
          const b = e.target.closest('button'); if (!b) return;
          if (b.dataset.ocact) { const id = { chaos: 'chaosBtn', wave: 'waveBtn', heal: 'healBtn' }[b.dataset.ocact]; if ($(id)) $(id).click(); if (b.dataset.ocact === 'chaos') ctx.done('chaos'); if (b.dataset.ocact === 'heal') ctx.done('heal'); }
          if (b.dataset.oclvl) { SD.ops.setLvl(b.dataset.oclvl); render(true); }
          if (b.dataset.ocprom) { SD.ops.setProm(b.dataset.ocprom); render(true); }
          if (b.dataset.octid) {
            SD.ops.openTrace(b.dataset.octid);
            const j = A().graph.nodes.find(n => n.type === 'jaeger');
            if (type !== 'jaeger' && j) ctx.go(j.id); else render(true);
          }
        };
        const onInput = e => { if (e.target.id === 'ocQ') { SD.ops.setQuery(e.target.value); clearTimeout(qt); qt = setTimeout(() => { render(true); const q = $('ocQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); } };
        const onChange = e => { if (e.target.id === 'ocSvc') { SD.ops.setSvc(e.target.value); render(true); } };
        box.addEventListener('click', onClick); box.addEventListener('input', onInput); box.addEventListener('change', onChange);
        render(true);
        return {
          tick() { const now = performance.now(); if (SD.ops.tick(now - last)) render(); last = now; },
          draw() {},
          refresh() { render(true); },
          now() {
            const p = ctx.part && ctx.part();
            if (p && PARTS[type][p]) return `<b>${esc(PARTS[type][p].name)}.</b> ${esc(PARTS[type][p].pl)}`;
            return { prometheus: '<b>Цели и запросы.</b> Сверху — кого Prometheus опрашивает и живы ли они. Урони экземпляр — цель станет DOWN.', grafana: '<b>Дашборд по методу RED.</b> Запросы, ошибки, задержка и CPU твоих сервисов. Урони экземпляр — график ошибок подскочит.', alertmanager: '<b>Правила и уведомления.</b> Урони экземпляр — правило пройдёт «норма → ждём → горит», дежурному придёт уведомление.', kibana: '<b>Логи подключённых сервисов.</b> Включи фильтр ERROR и урони экземпляр — увидишь ошибку. Нажми trace_id — откроется трейс.', jaeger: '<b>Трейсы.</b> Выбери трейс слева: водопад покажет, какой шаг занял больше всего собственного времени.' }[type];
          },
          stats() { return []; },
          destroy() { box.removeEventListener('click', onClick); box.removeEventListener('input', onInput); box.removeEventListener('change', onChange); clearTimeout(qt); }
        };
      }
    };
  }
  Object.keys(CON).forEach(consoleScene);

  /* ---------- Kubernetes изнутри ---------- */
  const SLOTS = 4;
  SD.XRAY.k8s = {
    cta: 'Серверы, поды, планировщик и контроллеры: как Kubernetes раскладывает сервисы и поднимает упавшие',
    simple: () => ({ an: 'Диспетчер такси: ты говоришь «на заказы нужно 3 машины», он сам находит водителей, следит, чтобы машин было три, и подменяет сломавшиеся.', pl: 'Kubernetes держит столько копий (подов) каждого сервиса, сколько ты попросил, раскладывает их по серверам и сам поднимает упавшие.' }),
    props: ['nodes', 'probes'],
    live: () => { const s = SD.opsState(A().graph); return [['Сервисов в кластере', s.k8s.size + ' из ' + s.svcs.length, s.k8s.size && s.k8s.size === s.svcs.length ? 'ok' : 'warn']]; },
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Поды твоих сервисов разложены по серверам.' },
      { id: 'hang', name: 'Под завис', note: 'Один под перестал отвечать, но процесс жив.' },
      { id: 'node', name: 'Сервер упал', note: 'Один сервер кластера выключился вместе со своими подами.' },
      { id: 'peak', name: 'Пик: реплик ×2', note: 'Автомасштабирование попросило вдвое больше подов.' },
      { id: 'deploy', name: 'Выкатка версии 2', note: 'Rolling update: новые поды заменяют старые по одному.' }
    ],
    parts: {
      api: { name: 'API-сервер и etcd', an: 'Журнал заказов диспетчерской: что хотим и что есть.', pl: 'Всё описание кластера хранится в etcd. Любой компонент читает и пишет его через API-сервер.', how: ['kubectl apply отправляет в API-сервер манифест: «Deployment заказов, 3 реплики».', 'API-сервер проверяет и сохраняет его в etcd.', 'Остальные компоненты подписаны на изменения и реагируют.'], real: 'etcd — согласованное хранилище на Raft; его теряют только один раз.' },
      sched: { name: 'Планировщик', an: 'Диспетчер, который решает, какая машина свободна для заказа.', pl: 'Берёт поды без сервера (Pending) и выбирает каждому сервер, где хватает CPU и памяти.', how: ['Отсекает серверы, где не хватает ресурсов.', 'Из оставшихся выбирает лучший: свободнее, без копии этого же сервиса.', 'Записывает решение в API — дальше работает kubelet сервера.', 'Мест нет — под остаётся Pending, пока не появится сервер.'], knobs: ['nodes'], real: 'Requests/limits подов — то, по чему планировщик считает место.' },
      ctrl: { name: 'Контроллеры', an: 'Завхоз, который каждые несколько секунд сверяет склад с описью.', pl: 'Контроллер постоянно сравнивает желаемое («нужно 3») с фактическим («работает 2») и исправляет разницу.', how: ['Deployment → ReplicaSet → поды.', 'Подов меньше нужного — создать новые.', 'Больше — удалить лишние.', 'Новая версия — заменять поды по одному (rolling update), не опуская число работающих ниже нужного.'], real: 'Тот же принцип «сверяй и чини» у Argo CD и операторов баз данных.' },
      kubelet: { name: 'kubelet и пробы', an: 'Смотритель на каждом этаже: проверяет, жив ли жилец, и вызывает помощь.', pl: 'На каждом сервере kubelet запускает контейнеры и проверяет их пробами: liveness — жив ли, readiness — готов ли принимать трафик.', how: ['Readiness не прошла — под убирают из раздачи трафика.', 'Liveness не прошла несколько раз — контейнер перезапускают.', 'Без проб зависший под остаётся «Running» и получает запросы.'], knobs: ['probes'], real: 'Частая ошибка: liveness проверяет базу — упала база, перезапускаются все поды.' },
      nodes: { name: 'Серверы (узлы)', an: 'Машины таксопарка.', pl: 'Обычные виртуальные машины. На каждой — kubelet и поды. Упал сервер — его поды пересоздаются на других.', how: ['Сервер перестал отвечать — помечается NotReady.', 'Через ≈ 1 минуту его поды считаются потерянными.', 'Контроллер создаёт замену, планировщик раскладывает её на живые серверы.'], knobs: ['nodes'], real: 'Cluster Autoscaler / Karpenter добавляют серверы, когда подам не хватает места.' }
    },
    tries: [
      { id: 'node', text: '«Сервер упал»: посмотри, как поды переезжают на другие серверы' },
      { id: 'noprobe', text: '«Под завис» без проб: трафик идёт в мёртвый под — ошибки у пользователей' },
      { id: 'probe', text: 'Включи пробы: kubelet сам перезапустит зависший под' },
      { id: 'pending', text: 'Поставь 1 сервер и включи «Пик»: поды ждут места (Pending)' },
      { id: 'rolling', text: '«Выкатка версии 2»: все поды заменены, и ни секунды без работающих' }
    ],
    legend: [['sq ok', 'Под работает (Running)'], ['sq warn', 'Создаётся или ждёт места'], ['sq bad', 'Завис, падает или потерян'], ['sq info', 'Новая версия (v2)']],
    mount(ctx) {
      const P = () => ctx.node.props;
      const S = { t: 0, pods: [], seq: 1, down: new Set(), log: [], arrow: null, err: 0, restarts: 0, scn: 'norm', ver: 1, tgt: 1, nextCtl: 0, nextSch: 0, nextProbe: 0, movedAfterDown: false };
      const deps = () => {
        let list = ctx.outs().filter(x => SVC.has(x.n.type));
        const demo = !list.length;
        if (demo) list = A().graph.nodes.filter(n => SVC.has(n.type)).map(n => ({ n, r: (ctx.all.nodes || {})[n.id] || {} }));
        return { demo, list: list.slice(0, 4).map((x, i) => ({ id: x.n.id, name: lbl(x.n), c: i, want: Math.min(6, Math.max(1, x.r.count || x.n.props.count || 1)) * (S.scn === 'peak' ? 2 : 1) })) };
      };
      const N = () => Math.min(6, Math.max(1, P().nodes || 3));
      const alive = d => S.pods.filter(p => p.dep === d && !['term', 'lost'].includes(p.st));
      const log = (txt, cls) => ctx.log(esc(txt), cls);
      function seed() {
        S.pods = []; S.down = new Set(); S.err = 0; S.restarts = 0; S.ver = 1; S.tgt = 1; S.movedAfterDown = false;
        let k = 0;
        deps().list.forEach(d => { for (let i = 0; i < d.want; i++) S.pods.push({ id: S.seq++, dep: d.id, node: k++ % N(), st: 'run', ver: 1, t: S.t }); });
      }
      function nodeLoad(i) { return S.pods.filter(p => p.node === i && !['lost'].includes(p.st)).length; }
      function tick(dt) {
        S.t += dt;
        const D = deps().list;
        if (S.t >= S.nextCtl) {
          S.nextCtl = S.t + 900;
          D.forEach(d => {
            const al = alive(d.id), tv = S.tgt;
            if (tv > 1 && al.some(p => p.ver < tv)) {
              /* rolling update: сначала новый под, потом убираем старый */
              const fresh = al.filter(p => p.ver === tv), freshUp = fresh.filter(p => p.st === 'run');
              if (fresh.length < d.want && fresh.length - freshUp.length === 0 && al.length <= d.want) { S.pods.push({ id: S.seq++, dep: d.id, node: -1, st: 'pend', ver: tv, t: S.t }); log(`Контроллер: выкатка ${d.name} — создаю под версии ${tv}`); }
              if (freshUp.length && al.length > d.want) { const old = al.find(p => p.ver < tv && p.st === 'run'); if (old) { old.st = 'term'; old.t = S.t; log(`Контроллер: новый под готов — убираю старый под версии ${old.ver}`); } }
              return;
            }
            if (al.length < d.want) { S.pods.push({ id: S.seq++, dep: d.id, node: -1, st: 'pend', ver: S.tgt, t: S.t }); log(`Контроллер: «${d.name}» нужно ${d.want}, есть ${al.length} → создаю под`); }
            else if (al.length > d.want) { const x = al.find(p => p.st !== 'run') || al[al.length - 1]; x.st = 'term'; x.t = S.t; log(`Контроллер: «${d.name}» подов больше нужного → убираю один`); }
          });
          if (S.tgt > 1 && D.every(d => alive(d.id).every(p => p.ver === S.tgt && p.st === 'run') && alive(d.id).length >= d.want)) { if (!S.rolled) { S.rolled = true; log('Выкатка завершена: все поды на версии 2, работающих ни разу не стало меньше нужного', 'ok'); ctx.done('rolling'); } }
        }
        if (S.t >= S.nextSch) {
          S.nextSch = S.t + 450;
          const p = S.pods.find(x => x.st === 'pend');
          if (p) {
            const cand = [...Array(N()).keys()].filter(i => !S.down.has(i) && nodeLoad(i) < SLOTS);
            if (cand.length) {
              cand.sort((a, b) => nodeLoad(a) - nodeLoad(b) || S.pods.filter(x => x.node === a && x.dep === p.dep).length - S.pods.filter(x => x.node === b && x.dep === p.dep).length);
              p.node = cand[0]; p.st = 'create'; p.t = S.t; S.arrow = { to: p.node, t: S.t };
              log(`Планировщик: под «${(D.find(d => d.id === p.dep) || {}).name}» → сервер ${p.node + 1} (там свободнее всего)`);
              if (S.down.size) S.movedAfterDown = true;
            } else if (!p.warned) { p.warned = true; log('Планировщик: места нет ни на одном сервере — под ждёт (Pending)', 'warn'); if (S.scn === 'peak') ctx.done('pending'); }
          }
        }
        S.pods.forEach(p => {
          if (p.st === 'create' && S.t - p.t > 1600) { p.st = 'run'; p.t = S.t; }
          if (p.st === 'term' && S.t - p.t > 1200) p.gone = true;
          if (p.st === 'lost' && S.t - p.t > 2000) p.gone = true;
          if (p.st === 'restart' && S.t - p.t > 1400) { p.st = 'run'; p.hung = false; p.fails = 0; p.t = S.t; }
        });
        S.pods = S.pods.filter(p => !p.gone);
        if (S.t >= S.nextProbe) {
          S.nextProbe = S.t + 1000;
          S.pods.filter(p => p.hung && p.st === 'run').forEach(p => {
            if (P().probes !== false) { p.fails = (p.fails || 0) + 1; if (p.fails >= 3) { p.st = 'restart'; p.t = S.t; S.restarts++; log('kubelet: liveness-проба не прошла 3 раза подряд → перезапускаю контейнер', 'ok'); ctx.done('probe'); } else log(`kubelet: проба не прошла (${p.fails} из 3), под убран из раздачи трафика`, 'warn'); }
            else { S.err += 3; if (S.err >= 6) ctx.done('noprobe'); }
          });
        }
        if (S.scn === 'node' && S.movedAfterDown && D.every(d => alive(d.id).filter(p => p.st === 'run').length >= d.want)) ctx.done('node');
      }
      function scenario(id) {
        S.scn = id; seed(); S.rolled = false;
        if (id === 'hang') { const p = S.pods.find(x => x.st === 'run'); if (p) { p.hung = true; log(`Под «${(deps().list.find(d => d.id === p.dep) || {}).name}» на сервере ${p.node + 1} завис: процесс жив, но не отвечает`, 'bad'); } }
        if (id === 'node') { const i = 0; S.down.add(i); S.pods.filter(p => p.node === i).forEach(p => { p.st = 'lost'; p.t = S.t; }); log('Сервер 1 перестал отвечать (NotReady). Его поды потеряны — контроллер создаст замену', 'bad'); }
        if (id === 'deploy') { S.tgt = 2; log('Новая версия 2: rolling update — по одному поду, не опуская число работающих', ''); }
      }
      const COLS = ['--k-read', '--k-write', '--k-job', '--k-events'];
      function draw() {
        const D = deps(), n = N();
        let s = '';
        /* управляющая часть */
        const cp = [['api', 'API-сервер + etcd', 'желаемое состояние'], ['sched', 'Планировщик', 'кому какой сервер'], ['ctrl', 'Контроллеры', 'нужно ↔ есть']];
        cp.forEach(([k, t, sub], i) => { const x = 300 + i * 230; s += `<g class="xr-part ${ctx.part() === k ? 'on' : ''}" data-xpart="${k}"><rect class="xr-box xk-cp" x="${x}" y="14" width="214" height="56" rx="10"/><text class="xr-t" x="${x + 12}" y="38">${t}</text><text class="xr-s" x="${x + 12}" y="56">${sub}</text></g>`; });
        s += `<text class="xr-m" x="300" y="88">управляющая часть кластера (control plane)</text>`;
        /* желаемое и фактическое */
        s += `<g class="xr-part ${ctx.part() === 'ctrl' ? 'on' : ''}" data-xpart="ctrl"><rect class="xr-zone" x="12" y="14" width="270" height="${30 + D.list.length * 46}" rx="10"/><text class="xr-t" x="24" y="36">Deployments</text>`;
        D.list.forEach((d, i) => { const al = alive(d.id), run = al.filter(p => p.st === 'run' && !p.hung).length, y = 50 + i * 46; s += `<rect x="24" y="${y}" width="10" height="10" rx="2" style="fill:var(${COLS[d.c % 4]})"/><text class="xr-m" x="40" y="${y + 9}">${esc(d.name.slice(0, 22))}</text><text class="xr-m ${run >= d.want ? 'ok' : 'warn'}" x="40" y="${y + 25}">нужно ${d.want} · работает ${run}${S.tgt > 1 ? ' · v2: ' + al.filter(p => p.ver === 2).length : ''}</text>`; });
        s += '</g>';
        if (D.demo) s += `<text class="xr-m warn" x="24" y="${70 + D.list.length * 46}">стрелок Kubernetes → сервис нет: показываю, как было бы</text>`;
        /* серверы */
        const cols = n > 3 ? 3 : n, rowH = n > 3 ? 168 : 230;
        for (let i = 0; i < n; i++) {
          const c = i % cols, r = Math.floor(i / cols), x = 300 + c * 232, y = 110 + r * (rowH + 8), dn = S.down.has(i), pods = S.pods.filter(p => p.node === i);
          s += `<g class="xr-part ${ctx.part() === 'nodes' || ctx.part() === 'kubelet' ? 'on' : ''}" data-xpart="nodes"><rect class="xr-box ${dn ? 'bad dead' : ''}" x="${x}" y="${y}" width="218" height="${rowH}" rx="12"/><text class="xr-t" x="${x + 12}" y="${y + 22}">Сервер ${i + 1}</text><text class="xr-s" x="${x + 12}" y="${y + 38}">${dn ? 'NotReady — не отвечает' : `kubelet · подов ${pods.filter(p => p.st !== 'lost').length} из ${SLOTS}`}</text></g>`;
          for (let k = 0; k < SLOTS; k++) {
            const p = pods[k], px = x + 12 + (k % 2) * 100, py = y + 50 + Math.floor(k / 2) * ((rowH - 60) / 2);
            const ph = (rowH - 70) / 2;
            s += `<rect class="xk-slot" x="${px}" y="${py}" width="94" height="${ph}" rx="8"/>`;
            if (!p) continue;
            const d = D.list.find(x2 => x2.id === p.dep) || { name: '?', c: 0 };
            const cls = p.st === 'run' ? (p.hung ? 'bad' : 'ok') : p.st === 'lost' || p.st === 'term' ? 'bad' : 'warn';
            const stt = p.st === 'run' ? (p.hung ? (P().probes !== false ? `завис · проба ${p.fails || 0}/3` : 'завис · трафик идёт!') : 'Running') : { create: 'создаётся', term: 'удаляется', lost: 'потерян', restart: 'перезапуск' }[p.st] || p.st;
            s += `<rect class="xk-pod ${cls} ${p.ver === 2 ? 'v2' : ''}" x="${px}" y="${py}" width="94" height="${ph}" rx="8"/><rect x="${px}" y="${py}" width="6" height="${ph}" rx="3" style="fill:var(${COLS[d.c % 4]})"/>`;
            s += `<text class="xr-m" x="${px + 12}" y="${py + 16}">${esc(d.name.split(' ').pop().slice(0, 10))} v${p.ver}</text>${ph > 38 ? `<text class="xr-s" x="${px + 12}" y="${py + 32}">${esc(stt)}</text>` : ''}`;
          }
        }
        /* ждут места */
        const pend = S.pods.filter(p => p.st === 'pend');
        s += `<text class="xr-m ${pend.length ? 'warn' : ''}" x="24" y="${Math.min(480, Math.max(300, 90 + D.list.length * 46 + 40))}">Ждут места (Pending): ${pend.length}</text>`;
        pend.slice(0, 8).forEach((p, i) => { const d = D.list.find(x2 => x2.id === p.dep) || { c: 0 }; s += `<rect class="xk-pod warn" x="${24 + (i % 4) * 62}" y="${Math.min(488, Math.max(308, 98 + D.list.length * 46 + 40)) + Math.floor(i / 4) * 26}" width="56" height="20" rx="5"/><rect x="${24 + (i % 4) * 62}" y="${Math.min(488, Math.max(308, 98 + D.list.length * 46 + 40)) + Math.floor(i / 4) * 26}" width="5" height="20" rx="2" style="fill:var(${COLS[d.c % 4]})"/>`; });
        /* стрелка планировщика */
        if (S.arrow && S.t - S.arrow.t < 700) { const c = S.arrow.to % cols, r = Math.floor(S.arrow.to / cols); s += `<line class="xr-wire act" x1="645" y1="70" x2="${300 + c * 232 + 109}" y2="${110 + r * (rowH + 8)}"/>`; }
        ctx.svg.innerHTML = s;
      }
      seed();
      return {
        tick, draw,
        refresh() { const keep = S.scn; scenario(keep); },
        scenario: id => scenario(id),
        onProp(k, prev, v) { if (k === 'probes') return v ? 'Пробы включены: зависший под уберут из трафика и перезапустят.' : 'Пробы выключены: зависший под останется «Running» и будет получать запросы.'; if (k === 'nodes') return `Серверов: ${v}. Меньше серверов — меньше места для подов и переездов.`; return ''; },
        now() {
          const pend = S.pods.filter(p => p.st === 'pend').length, hung = S.pods.find(p => p.hung && p.st === 'run');
          if (S.scn === 'hang') return hung ? (P().probes !== false ? '<b>Под завис.</b> kubelet проверяет его пробой раз в секунду. Readiness не прошла — под уже не получает трафик. Три неудачи liveness — перезапуск.' : `<b>Пробы выключены.</b> Под завис, но для Kubernetes он «Running»: трафик идёт в него, пользователи получают ошибки (${S.err}). Включи пробы справа.`) : '<b>Под снова работает.</b> kubelet перезапустил контейнер — без звонка админу.';
          if (S.scn === 'node') return pend ? `<b>Сервер 1 упал.</b> Его поды потеряны. Контроллер создал замену, планировщик раскладывает её по живым серверам${pend ? `, ждут места: ${pend}` : ''}.` : '<b>Поды переехали.</b> Нужное число работает на оставшихся серверах. В жизни это занимает около минуты.';
          if (S.scn === 'peak') return pend ? `<b>Подов нужно больше, чем мест.</b> ${pend} ждут (Pending). В жизни Cluster Autoscaler добавил бы серверы — здесь добавь их ползунком справа.` : '<b>Места хватило:</b> новые поды разложены по серверам.';
          if (S.scn === 'deploy') return S.rolled ? '<b>Выкатка завершена.</b> Каждый новый под сначала стал готовым, и только потом убирали старый — сервис ни секунды не работал меньшим числом подов.' : '<b>Rolling update.</b> Создаётся под версии 2, ждём, пока станет готов, затем удаляется один под версии 1. И так по одному.';
          return '<b>Kubernetes держит нужное число подов.</b> Слева — сколько подов нужно каждому сервису и сколько работает. Справа — серверы и поды на них. Выбери ситуацию сверху.';
        },
        stats() {
          const D = deps().list, want = D.reduce((a, d) => a + d.want, 0), run = S.pods.filter(p => p.st === 'run' && !p.hung).length;
          return [['Подов работает', `${run} из ${want}`, run >= want ? 'ok' : 'warn', 'нужно по Deployments'], ['Ждут места', String(S.pods.filter(p => p.st === 'pend').length), S.pods.some(p => p.st === 'pend') ? 'warn' : 'ok', 'Pending'], ['Перезапусков', String(S.restarts), '', 'kubelet по пробам'], ['Ошибок у пользователей', String(S.err), S.err ? 'bad' : 'ok', 'трафик в зависший под'], ['Серверов', `${N() - S.down.size} из ${N()}`, S.down.size ? 'warn' : 'ok', 'живых']];
        }
      };
    }
  };

  /* ---------- уровни «Эксплуатация и инструменты» ---------- */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const ALL = () => Object.keys(SD.TYPES).filter(t => SD.TYPES[t].group);
  const O = o => Object.assign({ tier: 'ops', opsLvl: true, decisions: [], stretch: { cost: Infinity }, preset: [C()], allow: ALL() }, o);
  const st = g => SD.opsState(g);
  const BASE = [['lb', 'lb', 220, 250], ['orders', 'app', 420, 170, { count: 3, role: 'orders' }, 'Сервис заказов'], ['catalog', 'app', 420, 340, { count: 2, role: 'catalog' }, 'Сервис каталога'], ['db', 'sql', 660, 170, { replicas: 1 }, 'База заказов'], ['cdb', 'sql', 660, 340, { replicas: 1 }, 'База каталога']];
  const BE = [['client', 'lb'], ['lb', 'orders'], ['lb', 'catalog'], ['orders', 'db'], ['catalog', 'cdb']];
  const PROM = [['prom', 'prometheus', 660, 520, {}, 'Prometheus'], ['graf', 'grafana', 900, 520, {}, 'Grafana']];
  const PE = [['orders', 'prom'], ['catalog', 'prom'], ['prom', 'graf']];
  const cover = (set, g) => { const s = st(g); const miss = s.svcs.filter(n => !s[set].has(n.id)).map(lbl); return { ok: s.svcs.length > 0 && !miss.length, detail: miss.length ? 'не подключены: ' + miss.join(', ') : 'все сервисы подключены' }; };
  SD.OPSL = [
    O({
      id: 'o-metrics', title: 'Не видно нагрузки', pattern: 'observability', tool: 'prometheus',
      chips: ['метрики', 'Prometheus', 'Grafana'],
      story: 'Сервис заказов иногда тормозит, но никто не знает когда и насколько: графиков нет, о проблемах узнают из жалоб. Поставь сбор метрик и дашборд.',
      traffic: { read: 4000, write: 400 },
      start: { nodes: BASE, edges: BE },
      goals: [{ t: 'success', min: 0.999 }, custom('Метрики со всех сервисов идут в Prometheus', (g) => cover('metrics', g)), custom('Есть дашборд: Prometheus → Grafana', g => ({ ok: st(g).dash, detail: st(g).dash ? 'графики есть' : 'Grafana не подключена к Prometheus' }))],
      hints: [{ text: 'В палитре «Наблюдаемость» → Prometheus. Проведи стрелки от каждого сервиса к Prometheus.', why: 'Стрелка «сервис → Prometheus» значит: Prometheus опрашивает этот сервис.' }, { text: 'Поставь Grafana и соедини Prometheus → Grafana. Потом дважды щёлкни по Grafana — увидишь живые графики.', why: 'Grafana рисует то, что хранит Prometheus.' }],
      solution: { nodes: BASE.concat(PROM), edges: BE.concat(PE) }
    }),
    O({
      id: 'o-alerts', title: 'Ночью упало — узнали утром', pattern: 'observability', tool: 'alertmanager',
      chips: ['алерты', 'дежурство', 'Alertmanager'],
      story: 'В 02:13 упала база каталога. Графики в Grafana были красными всю ночь, но смотреть на них было некому — узнали в 9 утра из жалоб. Сделай так, чтобы сбой будил дежурного.',
      traffic: { read: 4000, write: 400 },
      start: { nodes: BASE.concat(PROM), edges: BE.concat(PE) },
      goals: [{ t: 'success', min: 0.999 }, custom('О сбое узнаём за 2 минуты или быстрее', g => { const s = st(g); return { ok: s.mttd <= 2, detail: `сейчас ≈ ${s.mttd} мин${!s.alerts ? ': алерты не подключены' : s.mttd > 2 ? ': ночью чат и почту не читают — нужен звонок' : ''}` }; }), custom('Метрики со всех сервисов', g => cover('metrics', g))],
      hints: [{ text: 'Поставь Alertmanager и соедини Prometheus → Alertmanager.', why: 'Prometheus проверяет правила, Alertmanager доставляет сработавшие людям.' }, { text: 'В настройках Alertmanager выбери «Звонок и пуш дежурному». Проверь: дважды щёлкни по Alertmanager и нажми «Уронить экземпляр».', why: 'Ночью почту и чат не читают — критичное должно звонить.' }],
      solution: { nodes: BASE.concat(PROM, [['am', 'alertmanager', 900, 620, { channel: 'phone' }, 'Alertmanager']]), edges: BE.concat(PE, [['prom', 'am']]) }
    }),
    O({
      id: 'o-logs', title: 'Ошибка у части пользователей', pattern: 'observability', tool: 'kibana',
      chips: ['логи', 'ELK', 'Kibana'],
      story: 'У части пользователей не оформляется заказ, но где и почему — непонятно: логи остаются внутри подов и пропадают при перезапуске. Собери логи всех сервисов в одно место.',
      traffic: { read: 4000, write: 400 },
      start: { nodes: BASE.concat(PROM), edges: BE.concat(PE) },
      goals: [{ t: 'success', min: 0.999 }, custom('Логи всех сервисов в одном месте', g => cover('logs', g)), custom('Причину находим за 20 минут или быстрее', g => { const s = st(g); return { ok: s.diag <= 20, detail: `сейчас ≈ ${s.diag} мин` }; })],
      hints: [{ text: 'В палитре «Наблюдаемость» → «Логи: ELK + Kibana». Стрелки от каждого сервиса к логам.', why: 'Стрелка значит: агент на сервере отправляет логи этого сервиса в хранилище.' }, { text: 'Дважды щёлкни по логам, включи фильтр ERROR и урони экземпляр — найди ошибку.', why: 'Так проверяют, что логи действительно доходят.' }],
      solution: { nodes: BASE.concat(PROM, [['logs', 'kibana', 420, 560, {}, 'Логи: ELK + Kibana']]), edges: BE.concat(PE, [['orders', 'logs'], ['catalog', 'logs']]) }
    }),
    O({
      id: 'o-traces', title: 'Тормозит, но где?', pattern: 'observability', tool: 'jaeger',
      chips: ['трейсы', 'OpenTelemetry', 'Jaeger'],
      story: 'Оформление заказа идёт через три сервиса и иногда занимает 3 секунды. Метрики говорят «медленно», логи каждого сервиса — «всё нормально». Найди, где теряется время.',
      traffic: { read: 3000, write: 600 },
      start: { nodes: [['lb', 'lb', 220, 250], ['orders', 'app', 420, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['pay', 'app', 640, 170, { count: 2, role: 'payments' }, 'Сервис платежей'], ['stock', 'app', 640, 340, { count: 2, role: 'stock' }, 'Сервис склада'], ['db', 'sql', 860, 250, { replicas: 1 }, 'База заказов'], ['pdb', 'sql', 860, 110, {}, 'База платежей'], ['sdb', 'sql', 860, 390, {}, 'База склада']], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'pay'], ['orders', 'stock'], ['orders', 'db'], ['pay', 'pdb'], ['stock', 'sdb']] },
      goals: [{ t: 'success', min: 0.999 }, custom('Трейсы со всех сервисов', g => cover('traces', g)), custom('Логи со всех сервисов', g => cover('logs', g)), custom('Узкое место находим за 5 минут', g => { const s = st(g); return { ok: s.diag <= 5, detail: `сейчас ≈ ${s.diag} мин` }; })],
      hints: [{ text: 'Поставь Jaeger и логи. Стрелки от каждого из трёх сервисов к обоим.', why: 'Трейс показывает, где ждали; лог по тому же trace id — почему.' }, { text: 'Дважды щёлкни по Jaeger: в водопаде найди шаг с самым большим собственным временем.', why: 'Родительский шаг длинный, потому что включает вложенные — смотри на собственное время.' }],
      solution: { nodes: [['lb', 'lb', 220, 250], ['orders', 'app', 420, 250, { count: 3, role: 'orders' }, 'Сервис заказов'], ['pay', 'app', 640, 170, { count: 2, role: 'payments' }, 'Сервис платежей'], ['stock', 'app', 640, 340, { count: 2, role: 'stock' }, 'Сервис склада'], ['db', 'sql', 860, 250, { replicas: 1 }, 'База заказов'], ['pdb', 'sql', 860, 110, {}, 'База платежей'], ['sdb', 'sql', 860, 390, {}, 'База склада'], ['jg', 'jaeger', 520, 520, {}, 'Jaeger'], ['logs', 'kibana', 760, 520, {}, 'Логи: ELK + Kibana']], edges: [['client', 'lb'], ['lb', 'orders'], ['orders', 'pay'], ['orders', 'stock'], ['orders', 'db'], ['pay', 'pdb'], ['stock', 'sdb'], ['orders', 'jg'], ['pay', 'jg'], ['stock', 'jg'], ['orders', 'logs'], ['pay', 'logs'], ['stock', 'logs']] }
    }),
    O({
      id: 'o-k8s', title: 'Сервер упал — лежали час', pattern: 'healthcheck', tool: 'k8s',
      chips: ['Kubernetes', 'самолечение', 'пробы'],
      story: 'Сервисы запущены вручную на двух серверах. Ночью один сервер выключился — его экземпляры никто не поднял до утра, второй сервер захлебнулся. Разверни сервисы в Kubernetes, чтобы упавшее поднималось само.',
      traffic: { read: 4000, write: 400 },
      start: { nodes: BASE, edges: BE },
      goals: [{ t: 'success', min: 0.999 }, { t: 'survive', types: ['app'] }, custom('Все сервисы развёрнуты в Kubernetes', g => { const s = st(g); const miss = s.svcs.filter(n => !s.k8s.has(n.id)).map(lbl); return { ok: s.svcs.length > 0 && !miss.length, detail: miss.length ? 'не развёрнуты: ' + miss.join(', ') : 'все в кластере' }; }), custom('Упавшее поднимается само за ≈ 1 минуту', g => { const s = st(g); return { ok: s.restart <= 1, detail: `сейчас ≈ ${s.restart} мин${s.k8s.size && s.restart > 1 ? ': включи пробы здоровья' : ''}` }; })],
      hints: [{ text: 'В палитре «Платформа» → Kubernetes. Стрелки от Kubernetes к каждому сервису: «разворачивает».', why: 'Kubernetes следит, чтобы подов было столько, сколько нужно, и поднимает упавшие.' }, { text: 'Дважды щёлкни по Kubernetes и выбери «Сервер упал» — посмотри, как поды переезжают.', why: 'Самолечение не заменяет запаса: если экземпляр один, пока он переезжает, сервис лежит.' }],
      solution: { nodes: BASE.concat([['k8s', 'k8s', 420, 560, { nodes: 3, probes: true }, 'Kubernetes']]), edges: BE.concat([['k8s', 'orders'], ['k8s', 'catalog']]) }
    })
  ];
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  SD.levelById = id => (typeof id === 'string' && /^o-/.test(id) ? SD.OPSL.find(l => l.id === id) : null) || baseById(id);
  SD.levelLabel = L => L.opsLvl ? 'Эксплуатация и инструменты' : baseLabel(L);
  SD.nextLevel = L => { if (L.opsLvl) { const i = SD.OPSL.indexOf(L); return i >= 0 && i < SD.OPSL.length - 1 ? SD.OPSL[i + 1] : null; } return baseNext(L); };

  /* кнопка «загляни внутрь инструмента» в задании уровня */
  SD.opsTaskCta = L => {
    if (!L || !L.opsLvl || !L.tool) return '';
    const n = A().graph.nodes.find(x => x.type === L.tool);
    const T = SD.TYPES[L.tool];
    return n ? `<button type="button" class="dive-cta xr-cta" data-act="xray" data-id="${n.id}">${SD.icon(L.tool)}<span><b>Загляни внутрь: ${esc(T.name)}</b><small>Живые данные твоей схемы, учебный сбой и как инструмент устроен. Или двойной клик по нему на площадке.</small></span></button>`
      : `<div class="ops-cta-wait">${SD.icon(L.tool)}<span>Поставь «${esc(T.name)}» на площадку из палитры — и сможешь заглянуть внутрь него.</span></div>`;
  };

  SD.opsUI = { mount: mountLayers, renderLayers };
})();
