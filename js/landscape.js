/* «Ландшафт системы»: твоя схема в центре, вокруг — всё, что её строит, запускает, наблюдает и анализирует:
   CI/CD и GitOps, Kubernetes, наблюдаемость (логи, метрики, трейсы, алерты), данные и аналитика.
   Инструменты включаются и выключаются; видно, как это меняет DORA-метрики и ход инцидентов. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const A = () => SD.app.A;
  const KEY = 'amp-stroyka-landscape-v1';
  const lbl = n => n ? (n.label || SD.TYPES[n.type].name) : '';
  const COMPUTE = new Set(['app', 'worker', 'ws', 'faas', 'agent', 'router', 'gateway', 'llm', 'guard', 'embed', 'stt', 'tts', 'esb']);
  const EDGE_IN = new Set(['lb', 'cdn']);

  /* ---------- возможности, которые можно включать ---------- */
  const CAPS = [
    ['delivery', 'Доставка кода', [['ci', 'CI: сборка и тесты', true, 200], ['gitops', 'GitOps (Argo CD)', true, 0], ['canary', 'Канареечный релиз', false, 0], ['iac', 'Инфраструктура как код (Terraform)', true, 0]]],
    ['platform', 'Платформа', [['hpa', 'Автомасштабирование (HPA)', true, 0], ['mesh', 'Service mesh (Istio)', false, 250], ['secrets', 'Секреты в Vault', true, 100]]],
    ['obs', 'Наблюдаемость', [['logs', 'Логи (Loki / ELK + Kibana)', true, 600], ['metrics', 'Метрики (Prometheus + Grafana)', true, 150], ['alerts', 'Алерты и дежурства', true, 20], ['traces', 'Трейсы (OpenTelemetry + Jaeger)', false, 300]]],
    ['data', 'Данные и аналитика', [['cdc', 'CDC: изменения из базы (Debezium)', false, 150], ['stream', 'Потоковая обработка (Flink)', false, 800], ['lake', 'Озеро данных (S3 + Iceberg)', true, 200], ['elt', 'ELT: Airflow + dbt', true, 300], ['dwh', 'Хранилище (ClickHouse)', true, 1000], ['bi', 'BI-дашборды (Superset)', true, 100]]]
  ];
  const CAP = {}; CAPS.forEach(([, , list]) => list.forEach(([k, name, def, cost]) => { CAP[k] = { name, def, cost }; }));
  let on = {};
  const load = () => { try { on = Object.assign({}, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { on = {}; } Object.keys(CAP).forEach(k => { if (on[k] === undefined) on[k] = CAP[k].def; }); };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(on)); } catch (e) { /* без хранилища */ } };

  /* ---------- элементы ландшафта: что это и зачем ---------- */
  const EL = {
    dev: { name: 'Разработчик', lane: 'cd', an: 'Повар, который придумал новое блюдо.', pl: 'Пишет код и отправляет изменения в Git через pull request.', how: ['Делает ветку, пишет код и тесты.', 'Открывает pull request — коллеги смотрят код.', 'После одобрения изменения сливаются в основную ветку.'], tools: 'GitHub, GitLab, Bitbucket', gives: 'Каждое изменение видно, обсуждено и его можно откатить.' },
    git: { name: 'Git-репозиторий', lane: 'cd', an: 'Книга рецептов с историей правок: видно, кто, что и когда поменял.', pl: 'Хранит код и историю всех изменений. Отсюда начинается любая выкатка.', how: ['Код и манифесты Kubernetes лежат в репозитории.', 'Слияние в main запускает CI.', 'В GitOps репозиторий — единственный источник правды: что в Git, то и в кластере.'], tools: 'GitHub, GitLab', gives: 'Откат — это git revert.' },
    ci: { name: 'CI: сборка и тесты', lane: 'cd', cap: 'ci', an: 'ОТК на заводе: каждую деталь проверяют, прежде чем отправить на склад.', pl: 'На каждое изменение автоматически собирает приложение, гоняет тесты и проверки безопасности.', how: ['Собирает код и Docker-образ.', 'Гоняет юнит- и интеграционные тесты.', 'Сканирует зависимости и образ на уязвимости.', 'Упало хоть что-то — дальше не пускает.'], tools: 'GitHub Actions, GitLab CI, Jenkins, Trivy, SonarQube', gives: 'Большинство ошибок ловится до пользователей; релизы можно делать часто.', without: 'Сборка и проверка вручную: релизы редкие, большие и страшные, ошибки чаще доходят до прода.' },
    reg: { name: 'Реестр образов', lane: 'cd', cap: 'ci', an: 'Склад готовой продукции с номерами партий.', pl: 'Хранит собранные Docker-образы с версиями. Кластер берёт образы отсюда.', how: ['CI кладёт образ с тегом версии (например, orders:1.42.0).', 'Kubernetes скачивает нужную версию на узлы.', 'Старые версии лежат — откатиться можно на любую.'], tools: 'Docker Hub, ECR, GCR, Harbor', gives: 'Один и тот же проверенный образ идёт на тест и в прод.' },
    argo: { name: 'GitOps: Argo CD', lane: 'cd', cap: 'gitops', an: 'Завхоз, который сверяет склад с описью и сам расставляет всё по местам.', pl: 'Следит, чтобы кластер совпадал с тем, что описано в Git, и сам применяет изменения.', how: ['Сравнивает манифесты в Git с тем, что запущено в кластере.', 'Нашёл разницу — применяет: новая версия, другие настройки.', 'Откат — вернуть коммит в Git, Argo CD вернёт кластер сам.', 'Ручные правки в кластере он заметит и откатит.'], tools: 'Argo CD, Flux', gives: 'Выкатка и откат за минуты, и всегда понятно, что сейчас запущено.', without: 'Выкатывают руками через kubectl или скрипты: долго, легко ошибиться, откат — полчаса.' },
    canary: { name: 'Канареечный релиз', lane: 'cd', cap: 'canary', an: 'Шахтёры брали канарейку: если ей плохо — уходили, пока не плохо людям.', pl: 'Новая версия сначала получает 5 % трафика. Метрики в норме — 25 %, 50 %, 100 %. Плохо — автоматический откат.', how: ['Запускается немного подов новой версии.', 'Им отдают малую долю запросов.', 'Анализ сравнивает ошибки и задержку старой и новой версии.', 'Всё хорошо — доля растёт; плохо — откат, задело только 5 %.'], tools: 'Argo Rollouts, Flagger, Istio', gives: 'Плохой релиз задевает 5 % пользователей на несколько минут, а не всех.', without: 'Новая версия сразу на 100 %: ошибка задевает всех.' },
    tf: { name: 'Terraform (IaC)', lane: 'cd', cap: 'iac', an: 'Чертёж дома: по нему можно построить такой же дом где угодно.', pl: 'Облачные ресурсы — кластер, базы, сети — описаны кодом и создаются из него.', how: ['Ресурсы описаны в файлах .tf и лежат в Git.', 'terraform plan показывает, что изменится.', 'terraform apply создаёт или меняет ресурсы.', 'Новое окружение — тот же код с другими параметрами.'], tools: 'Terraform, OpenTofu, Pulumi', gives: 'Окружения одинаковые, изменения инфраструктуры проходят ревью.', without: 'Ресурсы создают кликами в консоли: никто не помнит, как это настроено.' },
    users: { name: 'Пользователи', lane: 'prod', an: 'Гости ресторана.', pl: 'Те, ради кого всё работает. Их опыт — главная метрика.', how: ['Браузер находит адрес через DNS.', 'Статику отдаёт CDN, запросы идут во вход кластера.'], tools: 'Браузеры, мобильные приложения', gives: '' },
    ingress: { name: 'Ingress / балансировщик', lane: 'k8s', an: 'Ресепшн в бизнес-центре: по табличке направляет к нужному офису.', pl: 'Вход в кластер: принимает HTTPS, снимает шифрование и по адресу запроса отправляет в нужный сервис.', how: ['Облачный балансировщик принимает трафик из интернета.', 'Ingress-контроллер читает правила: /orders → сервис заказов.', 'Сертификаты выпускает cert-manager (Let’s Encrypt).'], tools: 'NGINX Ingress, Traefik, AWS ALB, Gateway API', gives: 'Одна точка входа и автоматические сертификаты.' },
    k8s: { name: 'Kubernetes-кластер', lane: 'k8s', an: 'Диспетчер такси: ты говоришь «нужно 3 машины», он сам находит водителей и подменяет сломавшиеся.', pl: 'Запускает контейнеры на серверах, следит, чтобы их было сколько надо, перезапускает упавшие и раздаёт им адреса.', how: ['Ты описываешь желаемое: «сервис заказов, 3 копии, 2 vCPU».', 'Планировщик раскладывает поды по узлам (серверам).', 'Упал под или узел — Kubernetes поднимет замену.', 'Service даёт подам один постоянный адрес внутри кластера.', 'readiness/liveness-пробы решают, кому слать трафик и кого перезапустить.'], tools: 'EKS, GKE, AKS, k3s', gives: 'Самолечение, масштабирование, одинаковый запуск везде.' },
    hpa: { name: 'HPA: автомасштабирование', lane: 'k8s', cap: 'hpa', an: 'Менеджер смены: очередь растёт — вызывает ещё кассиров.', pl: 'Смотрит на загрузку CPU или другие метрики и меняет число подов.', how: ['Каждые 15 с берёт метрики подов.', 'Выше цели — добавляет поды, ниже — убирает.', 'Если места на узлах нет, Cluster Autoscaler добавляет серверы.'], tools: 'HPA, KEDA, Cluster Autoscaler, Karpenter', gives: 'Пик держится без ручного вмешательства, ночью не платишь за лишнее.', without: 'Число подов фиксировано: в пик тормозит, ночью простаивает.' },
    mesh: { name: 'Service mesh', lane: 'k8s', cap: 'mesh', an: 'Персональный курьер у каждого офиса: шифрует письма, повторяет доставку и ведёт журнал.', pl: 'Рядом с каждым подом — прокси-сосед (sidecar). Он шифрует трафик между сервисами, делает повторы, таймауты, считает метрики.', how: ['В каждый под добавляется контейнер Envoy.', 'Все вызовы между сервисами идут через эти прокси.', 'mTLS: сервисы проверяют друг друга по сертификатам.', 'Повторы, таймауты, канарейки — настройками, без кода.'], tools: 'Istio, Linkerd, Cilium', gives: 'Шифрование и устойчивость для всех сервисов одинаково, метрики «кто кого вызывает».', without: 'Каждый сервис сам реализует таймауты, повторы и TLS — по-разному.' },
    secrets: { name: 'Секреты (Vault)', lane: 'k8s', cap: 'secrets', an: 'Сейф с ключами: ключ выдают на время и под роспись.', pl: 'Пароли к базам, API-ключи и сертификаты хранятся отдельно от кода и выдаются сервисам при старте.', how: ['Сервис при запуске доказывает, кто он (через Kubernetes).', 'Vault выдаёт пароль — часто временный, на часы.', 'Доступы видны в журнале; пароль можно сменить без релиза.'], tools: 'HashiCorp Vault, AWS Secrets Manager, External Secrets', gives: 'Пароль не утечёт вместе с кодом, его легко сменить.', without: 'Пароли лежат в коде или переменных окружения: утёк репозиторий — утёк доступ к базе.' },
    managed: { name: 'Базы и брокеры', lane: 'prod', an: 'Склады и почта ресторана.', pl: 'Данные и очереди. Часто это управляемые сервисы облака: бэкапы, реплики и обновления делает провайдер.', how: ['Базы с состоянием обычно держат вне кластера или в операторах.', 'Бэкапы, реплики и мониторинг настраиваются здесь.'], tools: 'RDS / Cloud SQL, ElastiCache, MSK, Atlas', gives: '' },
    col: { name: 'Сборщик телеметрии', lane: 'obs', an: 'Почтальон, который обходит все офисы и собирает отчёты в один мешок.', pl: 'Агент на каждом узле кластера собирает логи, метрики и трейсы всех подов и отправляет дальше.', how: ['Запущен на каждом узле (DaemonSet).', 'Читает логи контейнеров (stdout) и добавляет метки: сервис, под, версия.', 'Принимает трейсы и метрики по протоколу OpenTelemetry.', 'Фильтрует, сжимает и раскладывает по хранилищам.'], tools: 'OpenTelemetry Collector, Fluent Bit, Vector', gives: 'Сервисы просто пишут в stdout и отдают метрики — доставку берёт на себя агент.' },
    logs: { name: 'Логи', lane: 'obs', cap: 'logs', an: 'Бортовой журнал корабля: кто, что и когда сделал.', pl: 'Текстовые записи событий из всех сервисов в одном месте с поиском. Ищешь по trace id, ошибке или пользователю.', how: ['Сервис пишет структурированный лог (JSON) в stdout.', 'Сборщик отправляет его в хранилище логов.', 'Индекс по полям: время, сервис, уровень, trace id.', 'В Kibana или Grafana ищешь «все ошибки заказов за 10 минут».'], tools: 'Loki + Grafana, Elasticsearch/OpenSearch + Kibana', gives: 'Причину ошибки видно за минуты, а не после захода по SSH на каждый сервер.', without: 'Логи разбросаны по подам и пропадают при перезапуске. Разбор инцидента — часами.' },
    kibana: { name: 'Kibana / поиск по логам', lane: 'obs', cap: 'logs', an: 'Библиотекарь с каталогом: найдёт нужную запись среди миллионов.', pl: 'Интерфейс поиска и анализа логов: фильтры, графики «сколько ошибок в минуту».', how: ['Запрос вида service:orders AND level:error.', 'Гистограмма ошибок по времени.', 'Переход по trace id к связанным логам.'], tools: 'Kibana, Grafana Explore, OpenSearch Dashboards', gives: '' },
    prom: { name: 'Метрики: Prometheus', lane: 'obs', cap: 'metrics', an: 'Медсестра, которая каждые 15 минут меряет пульс и давление всем пациентам.', pl: 'Каждые несколько секунд опрашивает сервисы и хранит числа во времени: запросы в секунду, ошибки, задержка, CPU.', how: ['Сервис отдаёт /metrics — счётчики и гистограммы.', 'Prometheus опрашивает все цели каждые 15 с.', 'Хранит временные ряды и считает по ним (PromQL).', 'Главное: RED — Rate, Errors, Duration — для каждого сервиса.'], tools: 'Prometheus, VictoriaMetrics, Mimir, Datadog', gives: 'Видно, что и когда пошло не так, задолго до жалоб.', without: 'Нет цифр — о проблеме узнаёшь от пользователей.' },
    grafana: { name: 'Grafana: дашборды', lane: 'obs', cap: 'metrics', an: 'Приборная панель автомобиля.', pl: 'Графики по метрикам, логам и трейсам на одном экране: загрузка, ошибки, задержка по сервисам.', how: ['Подключается к Prometheus, Loki, Tempo, базам.', 'Панели: RPS, доля ошибок, p95, насыщение.', 'Один клик от графика к логам и трейсам за тот же период.'], tools: 'Grafana', gives: 'Общая картина здоровья системы за секунды.' },
    alert: { name: 'Алерты и дежурный', lane: 'obs', cap: 'alerts', an: 'Пожарная сигнализация: сама звонит в часть, не ждёт, пока кто-то заметит дым.', pl: 'Правила по метрикам («ошибок больше 2 % дольше 5 минут») будят дежурного звонком.', how: ['Alertmanager получает сработавшие правила от Prometheus.', 'Группирует похожие, отсекает шум.', 'Отправляет дежурному: звонок, Telegram, PagerDuty.', 'В алерте — ссылка на дашборд и инструкцию (runbook).'], tools: 'Alertmanager, PagerDuty, Opsgenie, Grafana OnCall', gives: 'Узнаёшь о проблеме через минуту, а не утром.', without: 'О ночном сбое узнают утром из жалоб.' },
    trace: { name: 'Трейсы', lane: 'obs', cap: 'traces', an: 'GPS-трекер посылки: видно каждый склад, через который она прошла, и сколько там пролежала.', pl: 'Путь одного запроса через все сервисы с временем каждого шага. Сразу видно, кто тормозит.', how: ['На входе запрос получает trace id.', 'Каждый сервис пишет «отрезок» (span): кто, что, сколько мс.', 'trace id передаётся дальше в заголовках.', 'Jaeger собирает отрезки в дерево — водопад вызовов.'], tools: 'OpenTelemetry, Jaeger, Tempo, Zipkin', gives: 'В цепочке из 10 сервисов видно, какой отнял 900 мс из 1000.', without: '«Тормозит, но непонятно где» — гадание по логам каждого сервиса.' },
    cdc: { name: 'CDC: изменения из базы', lane: 'data', cap: 'cdc', an: 'Стенографист, который записывает каждое изменение в протоколе заседания.', pl: 'Читает журнал базы и превращает каждую вставку и изменение в событие в Kafka — без нагрузки на запросы.', how: ['Подключается к журналу WAL/binlog.', 'Каждое изменение строки → событие в топик.', 'Аналитика и поиск получают данные почти сразу.'], tools: 'Debezium, Kafka Connect', gives: 'Свежие данные для аналитики без тяжёлых выгрузок.', without: 'Данные выгружают раз в сутки запросом к боевой базе.' },
    stream: { name: 'Потоковая обработка', lane: 'data', cap: 'stream', an: 'Конвейер, который сортирует посылки на ходу, не складывая их в кучу.', pl: 'Считает агрегаты на лету: «заказов за последнюю минуту», «подозрительная активность».', how: ['Читает события из Kafka.', 'Окна времени: 1 минута, 1 час.', 'Пишет результаты в хранилище или обратно в Kafka.'], tools: 'Apache Flink, Kafka Streams, Spark Streaming', gives: 'Аналитика и реакции за секунды, а не на следующий день.' },
    lake: { name: 'Озеро данных', lane: 'data', cap: 'lake', an: 'Огромный склад, куда свозят всё «как есть» — разберут потом.', pl: 'Дешёвое хранилище сырых данных в файлах (Parquet) на S3. Хранит годами.', how: ['События и выгрузки складываются по датам.', 'Формат таблиц (Iceberg, Delta) даёт версии и транзакции.', 'Отсюда данные берут ELT, ML и разовые исследования.'], tools: 'S3 + Iceberg / Delta Lake, HDFS', gives: 'Ничего не теряется, хранить дёшево.' },
    elt: { name: 'ELT: Airflow + dbt', lane: 'data', cap: 'elt', an: 'Шеф-повар, который по расписанию готовит заготовки из сырых продуктов.', pl: 'По расписанию превращает сырые данные в чистые таблицы для отчётов.', how: ['Airflow запускает задачи по расписанию и по зависимостям (DAG).', 'dbt — SQL-модели: из сырых событий в «заказы по дням».', 'Тесты данных: нет пустых id, суммы сходятся.'], tools: 'Apache Airflow, Dagster, dbt', gives: 'Отчёты строятся из проверенных таблиц, а не из сырья.' },
    dwh: { name: 'Хранилище (DWH)', lane: 'data', cap: 'dwh', an: 'Архив с удобными папками: всё разложено для ответов на вопросы бизнеса.', pl: 'Колоночная база для аналитики: агрегаты по миллиардам строк за секунды.', how: ['Хранит данные по колонкам — читает только нужные.', 'Сжимает в разы.', 'Тяжёлые отчёты идут сюда, а не в боевую базу.'], tools: 'ClickHouse, BigQuery, Snowflake, Redshift', gives: 'Отчёт «выручка по регионам за год» за секунды и без вреда для покупок.' },
    bi: { name: 'BI-дашборды', lane: 'data', cap: 'bi', an: 'Табло с итогами матча для руководства.', pl: 'Графики и отчёты для бизнеса: выручка, воронка, удержание.', how: ['Подключаются к хранилищу.', 'Аналитики собирают дашборды из SQL-запросов.', 'Обновляются по расписанию.'], tools: 'Superset, Metabase, Tableau, DataLens', gives: 'Решения на цифрах, а не на ощущениях.' }
  };

  const SHORT = { ingress: 'Ingress (вход)', hpa: 'HPA', mesh: 'Service mesh', secrets: 'Секреты: Vault', col: 'Сборщик телеметрии', argo: 'GitOps: Argo CD', canary: 'Канарейка', cdc: 'CDC из базы', stream: 'Поток: Flink', prom: 'Prometheus', kibana: 'Kibana: поиск', grafana: 'Grafana', alert: 'Алерты → дежурный', logs: 'Логи', trace: 'Трейсы', elt: 'Airflow + dbt', dwh: 'Хранилище DWH', bi: 'BI-дашборды', lake: 'Озеро данных', tf: 'Terraform (IaC)', reg: 'Реестр образов', git: 'Git', dev: 'Разработчик', ci: 'CI: сборка, тесты', users: 'Пользователи' };
  /* ---------- метрики DORA и готовность к инцидентам ---------- */
  function score() {
    const det = on.metrics && on.alerts ? 2 : on.metrics ? 15 : 45;
    const dia = on.logs && on.traces ? 5 : on.logs ? 20 : on.traces ? 25 : 60;
    const fix = on.gitops ? 3 : 25;
    const cfr = on.ci ? (on.canary ? 4 : 10) : 25;
    const freq = on.ci && on.gitops ? 'несколько раз в день' : on.ci ? 'раз в неделю' : 'раз в месяц';
    const lead = on.ci && on.gitops ? 'меньше часа' : on.ci ? '1–3 дня' : '2–4 недели';
    const blast = on.canary ? 5 : 100;
    const mttr = det + dia + fix;
    const tier = on.ci && on.gitops && mttr <= 60 && cfr <= 10 ? ['Elite', 'ok'] : on.ci && mttr <= 120 ? ['High', 'ok'] : mttr <= 24 * 60 && on.ci ? ['Medium', 'warn'] : ['Low', 'bad'];
    const fresh = on.cdc && on.stream ? 'секунды' : on.cdc ? 'минуты' : on.elt && on.dwh ? 'сутки (ночная выгрузка)' : on.dwh ? 'как повезёт (ручные выгрузки)' : 'отчёты на боевой базе';
    const cost = Object.keys(CAP).filter(k => on[k]).reduce((s, k) => s + CAP[k].cost, 0);
    return { det, dia, fix, mttr, cfr, freq, lead, blast, tier, fresh, cost };
  }

  /* ---------- раскладка ---------- */
  const W = 1400, H = 860;
  let L = null;
  function layout() {
    const g = A().graph, r = A().res1 || A().res || { nodes: {} };
    const pos = {};
    const box = (id, x, y, w, h, extra) => { pos[id] = Object.assign({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 }, extra || {}); };
    /* доставка кода — сверху */
    const cd = ['dev', 'git', 'ci', 'reg', 'argo', 'canary'];
    cd.forEach((id, i) => box(id, 60 + i * 175, 52, 150, 56));
    box('tf', 1150, 52, 200, 56);
    /* продукт и кластер */
    box('users', 18, 316, 120, 64);
    box('k8s', 150, 196, 640, 372);
    box('ingress', 166, 320, 128, 64);
    const svcs = g.nodes.filter(n => COMPUTE.has(n.type)).slice(0, 8);
    const cols = svcs.length > 4 ? 2 : 1, rows = Math.ceil(svcs.length / cols) || 1, sh = Math.min(64, 250 / rows - 8);
    svcs.forEach((n, i) => { const c = Math.floor(i / rows), k = i % rows; box('n:' + n.id, 320 + c * 230, 238 + k * (sh + 8), 210, sh, { node: n, count: Math.max(1, (r.nodes[n.id] || {}).count || n.props.count || 1) }); });
    box('hpa', 166, 504, 140, 52); box('mesh', 322, 504, 140, 52); box('secrets', 478, 504, 140, 52); box('k8sinfo', 634, 504, 142, 52);
    const stores = g.nodes.filter(n => !COMPUTE.has(n.type) && !EDGE_IN.has(n.type) && n.type !== 'client').slice(0, 7);
    box('managed', 815, 196, 170, 372);
    stores.forEach((n, i) => box('n:' + n.id, 825, 238 + i * Math.min(50, 320 / Math.max(1, stores.length)), 150, Math.min(44, 320 / Math.max(1, stores.length) - 6), { node: n }));
    /* данные — справа */
    ['cdc', 'stream', 'lake', 'elt', 'dwh', 'bi'].forEach((id, i) => box(id, 1030 + (i % 2) * 180, 210 + Math.floor(i / 2) * 118, 160, 60));
    /* наблюдаемость — снизу */
    box('col', 60, 640, 170, 60);
    box('logs', 300, 600, 170, 56); box('kibana', 520, 600, 170, 56);
    box('prom', 300, 690, 170, 56); box('grafana', 520, 690, 170, 56); box('alert', 740, 690, 190, 56);
    box('trace', 300, 780, 170, 56);
    L = { pos, svcs, stores, g };
  }
  const EDGES = () => {
    const e = [];
    const add = (a, b, k, cap) => e.push({ a, b, k, cap });
    add('dev', 'git', 'code'); add('git', 'ci', 'code', 'ci'); add('ci', 'reg', 'code', 'ci'); add('reg', 'argo', 'code', 'gitops'); add('argo', 'canary', 'code', 'canary');
    add(on.canary ? 'canary' : on.gitops ? 'argo' : 'reg', 'k8s', 'code');
    add('tf', 'k8s', 'iac', 'iac');
    add('users', 'ingress', 'req');
    L.svcs.forEach(n => add('ingress', 'n:' + n.id, 'req'));
    add('k8s', 'col', 'log', 'logs'); add('k8s', 'prom', 'metric', 'metrics'); add('k8s', 'col', 'trace', 'traces');
    add('col', 'logs', 'log', 'logs'); add('logs', 'kibana', 'log', 'logs'); add('col', 'trace', 'trace', 'traces');
    add('prom', 'grafana', 'metric', 'metrics'); add('prom', 'alert', 'metric', 'alerts');
    const db = L.stores.find(n => n.type === 'sql' || n.type === 'nosql');
    if (db) add('n:' + db.id, 'cdc', 'data', 'cdc');
    add('cdc', 'stream', 'data', 'stream'); add('cdc', 'lake', 'data', 'lake'); add('stream', 'dwh', 'data', 'stream'); add('lake', 'elt', 'data', 'elt'); add('elt', 'dwh', 'data', 'dwh'); add('dwh', 'bi', 'data', 'bi');
    if (!on.cdc && db) add('n:' + db.id, 'elt', 'data', 'elt');
    return e;
  };
  const enabled = id => { const el = EL[id]; return !el || !el.cap || on[el.cap]; };
  const anchor = (p, q) => { const dx = q.cx - p.cx, dy = q.cy - p.cy; const sx = Math.abs(dx) / (p.w / 2 || 1), sy = Math.abs(dy) / (p.h / 2 || 1); const s = Math.max(sx, sy) || 1; return { x: p.cx + dx / s, y: p.cy + dy / s }; };

  /* ---------- отрисовка ---------- */
  const COL = { code: '--accent', req: '--k-read', log: '--text-muted', metric: '--ok', trace: '--info', data: '--k-write', iac: '--k-job' };
  const S = { t: 0, dots: [], acc: 0, sel: null, hl: [], inc: null, step: -1, raf: 0, last: 0, run: true };
  function draw() {
    const P = L.pos, sc = score();
    let s = '';
    const lane = (x, y, w, h, title, sub, c) => `<rect class="ls-lane" x="${x}" y="${y}" width="${w}" height="${h}" rx="16" style="--c:var(${c})"/><text class="ls-lt" x="${x + 14}" y="${y + 22}" style="--c:var(${c})">${title}</text><text class="ls-ls" x="${x + 14}" y="${y + 38}">${sub}</text>`;
    s += lane(10, 6, 1380, 130, 'ДОСТАВКА КОДА · CI/CD', 'как изменение доходит от разработчика до пользователей', '--accent');
    s += lane(10, 146, 990, 430, 'ПРОДУКТ И ПЛАТФОРМА', 'твоя схема внутри Kubernetes; базы и брокеры — рядом', '--k-read');
    s += lane(1010, 146, 380, 430, 'ДАННЫЕ И АНАЛИТИКА', 'из боевых данных — в отчёты', '--k-write');
    s += lane(10, 586, 1380, 266, 'НАБЛЮДАЕМОСТЬ', 'логи, метрики, трейсы, алерты — как узнать, что сломалось и где', '--ok');
    /* связи */
    EDGES().forEach(e => {
      const p = P[e.a], q = P[e.b]; if (!p || !q) return;
      const live = !e.cap || on[e.cap];
      const a = anchor(p, q), b = anchor(q, p);
      s += `<line class="ls-wire ${live ? '' : 'off'} ${hlEdge(e) ? 'hl' : ''}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" style="--c:var(${COL[e.k]})"/>`;
    });
    /* кластер */
    const k = P.k8s;
    s += `<g class="ls-el" data-lsel="k8s"><rect class="ls-k8s ${isHl('k8s') ? 'hl' : ''}" x="${k.x}" y="${k.y}" width="${k.w}" height="${k.h}" rx="14"/><text class="ls-t" x="${k.x + 12}" y="${k.y + 20}">☸ Kubernetes-кластер</text><text class="ls-s" x="${k.x + 12}" y="${k.y + 36}">поды твоих сервисов, самолечение, адреса внутри кластера</text></g>`;
    const m = P.managed;
    s += `<g class="ls-el" data-lsel="managed"><rect class="ls-managed" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="14"/><text class="ls-t" x="${m.x + 10}" y="${m.y + 20}">Базы и брокеры</text><text class="ls-s" x="${m.x + 10}" y="${m.y + 34}">часто managed в облаке</text></g>`;
    /* элементы */
    Object.keys(EL).forEach(id => {
      const p = P[id]; if (!p || id === 'k8s' || id === 'managed') return;
      const el = EL[id], en = enabled(id);
      const nm = SHORT[id] || el.name, fit = Math.floor((p.w - 16) / 7.4);
      s += `<g class="ls-el ${en ? '' : 'off'} ${S.sel === id ? 'sel' : ''} ${isHl(id) ? 'hl' : ''}" data-lsel="${id}"><title>${esc(el.name)}</title><rect class="ls-box" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10"/><text class="ls-t" x="${p.x + 10}" y="${p.y + 21}">${esc(nm.length > fit ? nm.slice(0, fit - 1) + '…' : nm)}</text><text class="ls-s" x="${p.x + 10}" y="${p.y + 38}">${esc(en ? (el.tools || '').split(',')[0] : 'выключено')}</text></g>`;
    });
    s += `<g class="ls-el" data-lsel="k8s"><rect class="ls-box ghost" x="${P.k8sinfo.x}" y="${P.k8sinfo.y}" width="${P.k8sinfo.w}" height="${P.k8sinfo.h}" rx="10"/><text class="ls-s" x="${P.k8sinfo.x + 8}" y="${P.k8sinfo.y + 22}">ConfigMap, DNS,</text><text class="ls-s" x="${P.k8sinfo.x + 8}" y="${P.k8sinfo.y + 38}">cert-manager</text></g>`;
    /* твои сервисы и хранилища */
    L.svcs.forEach(n => {
      const p = P['n:' + n.id], c = p.count, pods = Math.min(c, 8), hl = isHl('n:' + n.id) || isHl('svc');
      s += `<g class="ls-el ls-node" data-lsnode="${n.id}"><rect class="ls-box svc ${hl ? 'hl' : ''} ${S.inc && S.inc.bad === 'n:' + n.id ? 'bad' : ''}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10"/><text class="ls-t" x="${p.x + 10}" y="${p.y + 19}">${esc(lbl(n).slice(0, 22))}</text><text class="ls-s" x="${p.x + 10}" y="${p.y + 31}">Deployment · ${c} ${c === 1 ? 'под' : c < 5 ? 'пода' : 'подов'}${on.hpa && n.props.autoscale ? ' · HPA' : ''}</text>`;
      if (p.h >= 52) for (let i = 0; i < pods; i++) { const px = p.x + 10 + i * 22, py = p.y + p.h - 12; s += `<rect class="ls-pod" x="${px}" y="${py}" width="16" height="10" rx="2"/>${on.mesh ? `<circle class="ls-side mesh" cx="${px + 16}" cy="${py}" r="2.6"/>` : ''}${on.logs || on.metrics ? `<circle class="ls-side obs" cx="${px}" cy="${py}" r="2.2"/>` : ''}`; }
      if (c > 8 && p.h >= 52) s += `<text class="ls-s" x="${p.x + 10 + 8 * 22}" y="${p.y + p.h - 6}">+${c - 8}</text>`;
      s += '</g>';
    });
    if (!L.svcs.length) s += `<text class="ls-s" x="330" y="240">Сервисов на схеме пока нет — добавь их на площадке.</text>`;
    L.stores.forEach(n => {
      const p = P['n:' + n.id];
      s += `<g class="ls-el ls-node" data-lsnode="${n.id}"><rect class="ls-box store ${isHl('n:' + n.id) || isHl('db') ? 'hl' : ''} ${S.inc && S.inc.bad === 'n:' + n.id ? 'bad' : ''}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="9"/><text class="ls-t sm" x="${p.x + 9}" y="${p.y + Math.min(18, p.h / 2 + 4)}">${esc(lbl(n).slice(0, 20))}</text></g>`;
    });
    /* точки: логи, метрики, трейсы, код, данные */
    S.dots.forEach(d => { const f = d.f; s += `<circle class="ls-dot" cx="${(d.x1 + (d.x2 - d.x1) * f).toFixed(1)}" cy="${(d.y1 + (d.y2 - d.y1) * f).toFixed(1)}" r="${d.k === 'code' ? 5 : 3}" style="fill:var(${COL[d.k]})"/>`; });
    /* итог DORA прямо на картинке */
    s += `<g class="ls-dora"><rect x="1010" y="600" width="380" height="244" rx="14"/><text class="ls-lt" x="1024" y="624" style="--c:var(--accent)">МЕТРИКИ DORA</text>`;
    const row = (i, l, v, c) => `<text class="ls-s" x="1024" y="${652 + i * 30}">${l}</text><text class="ls-v ${c || ''}" x="1376" y="${652 + i * 30}" text-anchor="end">${v}</text>`;
    s += row(0, 'Как часто релизы', sc.freq, on.ci && on.gitops ? 'ok' : on.ci ? 'warn' : 'bad');
    s += row(1, 'От коммита до прода', sc.lead, on.ci && on.gitops ? 'ok' : on.ci ? 'warn' : 'bad');
    s += row(2, 'Неудачных релизов', sc.cfr + ' %', sc.cfr <= 5 ? 'ok' : sc.cfr <= 10 ? 'warn' : 'bad');
    s += row(3, 'Восстановление после сбоя', '≈ ' + sc.mttr + ' мин', sc.mttr <= 30 ? 'ok' : sc.mttr <= 90 ? 'warn' : 'bad');
    s += row(4, 'Свежесть аналитики', sc.fresh, /секунд|минут/.test(sc.fresh) ? 'ok' : /сутки/.test(sc.fresh) ? 'warn' : 'bad');
    s += `<text class="ls-s" x="1024" y="${652 + 5 * 30 + 8}">Уровень команды по DORA:</text><text class="ls-v big ${sc.tier[1]}" x="1376" y="${652 + 5 * 30 + 8}" text-anchor="end">${sc.tier[0]}</text></g>`;
    $('lsSvg').innerHTML = s;
  }
  const isHl = id => S.hl.includes(id);
  const hlEdge = e => S.hl.includes(e.a) && S.hl.includes(e.b);

  /* поток точек по включённым связям */
  function tick(dt) {
    if (!L) return;
    S.acc += dt;
    if (S.acc > 140) {
      S.acc = 0;
      const es = EDGES().filter(e => (!e.cap || on[e.cap]) && e.k !== 'req');
      for (let i = 0; i < 3 && es.length; i++) {
        const e = es[Math.floor(Math.random() * es.length)], p = L.pos[e.a], q = L.pos[e.b]; if (!p || !q) continue;
        const a = anchor(p, q), b = anchor(q, p);
        S.dots.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, f: 0, k: e.k, v: 0.0009 + Math.random() * 0.0005 });
      }
      const rq = EDGES().filter(e => e.k === 'req');
      if (rq.length) { const e = rq[Math.floor(Math.random() * rq.length)], p = L.pos[e.a], q = L.pos[e.b]; if (p && q) { const a = anchor(p, q), b = anchor(q, p); S.dots.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, f: 0, k: 'req', v: 0.0016 }); } }
    }
    S.dots.forEach(d => { d.f += d.v * dt; });
    S.dots = S.dots.filter(d => d.f < 1).slice(-120);
  }

  /* ---------- сценарии инцидентов ---------- */
  const INC = {
    db: { name: 'Ночью упала база', note: '02:13. Основная база перестала отвечать.' },
    release: { name: 'Плохой релиз', note: '14:00. В новой версии сервиса ошибка, которую не поймали тесты.' },
    slow: { name: 'Тормозит, но где?', note: 'Пользователи жалуются: оформление заказа стало занимать 4 секунды.' },
    leak: { name: 'Утёк пароль от базы', note: 'Пароль от базы оказался в публичном репозитории.' },
    report: { name: 'Нужен свежий отчёт', note: 'Директор хочет видеть продажи за последний час.' }
  };
  function steps(id) {
    const db = L.stores.find(n => n.type === 'sql' || n.type === 'nosql'), svc = L.svcs.find(n => n.type === 'app') || L.svcs[0];
    const dbk = db ? 'n:' + db.id : 'managed', sk = svc ? 'n:' + svc.id : 'svc', out = [];
    const st = (t, txt, hl, cls) => out.push({ t, txt, hl: hl || [], cls: cls || '' });
    const sc = score();
    if (id === 'db') {
      st('02:13', `База «${db ? lbl(db) : 'база'}» перестала отвечать. Сервисы получают ошибки.`, [dbk], 'bad');
      if (on.metrics && on.alerts) st('02:14', 'Prometheus видит: ошибок больше 5 %. Alertmanager звонит дежурному.', ['prom', 'alert'], 'ok');
      else if (on.metrics) st('02:13–08:30', 'На графиках в Grafana всё красное, но никто не смотрит: алертов нет. Узнают утром.', ['prom', 'grafana'], 'bad');
      else st('08:40', 'Пишут пользователи и поддержка. Метрик нет — масштаб беды непонятен.', ['users'], 'bad');
      if (on.logs) st('+3 мин', 'В Kibana по полю error: «connection refused db-primary:5432» во всех сервисах сразу — значит, дело в базе.', ['logs', 'kibana'], 'ok');
      else st('+40 мин', 'Логов в одном месте нет: заходят на каждый под, логи перезапущенных подов уже пропали.', [sk], 'bad');
      st(db && db.props.replicas ? '+1 мин' : '+30 мин', db && db.props.replicas ? 'Реплика повышается до главной (failover), сервисы переподключаются.' : 'Реплик нет: восстанавливают из ночного бэкапа. Потеряны записи с ночи.', [dbk], db && db.props.replicas ? 'ok' : 'bad');
      st('итог', `Простой ≈ ${(on.metrics && on.alerts ? 4 : on.metrics ? 380 : 390) + (db && db.props.replicas ? 1 : 30)} мин. ${on.alerts ? 'Алерт разбудил дежурного вовремя.' : 'Без алертов ночной сбой длится до утра.'}`, [], on.alerts ? 'ok' : 'bad');
    }
    if (id === 'release') {
      st('14:00', 'Разработчик сливает pull request.', ['dev', 'git']);
      if (on.ci) st('14:04', 'CI: сборка, 1 200 тестов, проверка уязвимостей — всё зелёное. Ошибка хитрая, тесты её не видят.', ['ci', 'reg'], 'warn');
      else st('14:00', 'CI нет: собирают на ноутбуке и выкатывают как есть.', ['dev'], 'bad');
      if (on.gitops) st('14:05', 'Argo CD видит новую версию в Git и начинает выкатку.', ['argo', 'k8s']);
      else st('14:30', 'Выкатывают вручную скриптом по инструкции.', ['k8s'], 'warn');
      if (on.canary) st('14:06', 'Канарейка: новая версия получает 5 % запросов.', ['canary', sk]);
      st(on.canary ? '14:08' : '14:06', `${on.canary ? '5 % пользователей получают' : 'Все пользователи получают'} ошибку 500 при оформлении заказа.`, [sk], 'bad');
      if (on.canary && on.metrics) st('14:09', 'Анализ канарейки: ошибок у новой версии 7 % против 0,1 % у старой → автоматический откат. Задело 5 % пользователей на 3 минуты.', ['canary', 'prom'], 'ok');
      else if (on.metrics && on.alerts) st('14:09', 'Алерт: доля ошибок 5xx выросла до 7 %.', ['prom', 'alert'], 'ok');
      else st('15:10', 'Узнают из жалоб в поддержку.', ['users'], 'bad');
      if (!on.canary) {
        if (on.traces || on.logs) st('+5 мин', on.traces ? 'Трейс упавшего запроса: ошибка в «Оформить заказ» новой версии. Причина ясна.' : 'В логах: NullPointerException в OrderService.place после релиза 1.43.', on.traces ? ['trace'] : ['logs', 'kibana'], 'ok');
        st(on.gitops ? '+2 мин' : '+25 мин', on.gitops ? 'Откат: git revert → Argo CD возвращает прошлую версию.' : 'Откат вручную: ищут прошлый образ, правят скрипт, выкатывают.', on.gitops ? ['git', 'argo'] : ['k8s'], on.gitops ? 'ok' : 'warn');
      }
      st('итог', `Пострадали ${sc.blast} % пользователей. ${on.canary ? 'Канарейка сработала как предохранитель.' : on.gitops ? 'Откат быстрый, но задело всех.' : 'Долго и больно: задело всех, откат вручную.'}`, [], on.canary ? 'ok' : on.gitops ? 'warn' : 'bad');
    }
    if (id === 'slow') {
      st('10:00', 'Оформление заказа стало занимать 4 с вместо 300 мс.', [sk], 'bad');
      if (on.metrics) st('10:02', 'Grafana: p95 «Оформить заказ» 4 с. Но в цепочке 6 сервисов — какой из них?', ['grafana', 'prom'], 'warn');
      if (on.traces) st('10:05', 'Jaeger: водопад одного запроса — 3,6 с из 4 ждёт вызов к внешнему платёжному API без таймаута.', ['trace'], 'ok');
      else if (on.logs) st('11:30', 'По логам каждого сервиса сопоставляют время вручную… через полтора часа находят виноватого.', ['logs', 'kibana'], 'warn');
      else st('весь день', 'Ни трейсов, ни логов в одном месте: гадают и перезапускают сервисы по очереди.', [sk], 'bad');
      st('итог', on.traces ? 'Трейсы нашли узкое место за 5 минут. Лечение — таймаут и предохранитель на вызове.' : 'Без трейсов поиск узкого места в цепочке сервисов — часы.', [], on.traces ? 'ok' : 'bad');
    }
    if (id === 'leak') {
      st('09:00', 'Пароль от базы найден в публичном репозитории.', ['git'], 'bad');
      if (on.secrets) st('09:10', 'Пароль в Vault — меняют его там. Сервисы получают новый при перезапуске подов, без релиза.', ['secrets', 'k8s'], 'ok');
      else st('09:10–13:00', 'Пароль зашит в конфиги сервисов: меняют в базе и в коде, пересобирают и выкатывают все сервисы.', ['ci', 'k8s'], 'bad');
      if (on.logs) st('+5 мин', 'По журналу доступа базы и логам проверяют: входил ли кто-то чужой.', ['logs'], 'ok');
      st('итог', on.secrets ? 'Секреты отдельно от кода — смена за минуты.' : 'Секреты в коде — смена пароля превращается в аварийный релиз.', [], on.secrets ? 'ok' : 'bad');
    }
    if (id === 'report') {
      st('16:00', 'Нужна выручка за последний час по регионам.', ['bi']);
      if (on.cdc && on.stream && on.dwh) st('16:00', 'CDC → Kafka → Flink считает продажи на лету, в ClickHouse данные секундной свежести.', ['cdc', 'stream', 'dwh', 'bi', dbk], 'ok');
      else if (on.elt && on.dwh) st('16:00', 'В хранилище данные на вчерашнюю полночь: Airflow выгружает раз в сутки. Свежих нет.', ['elt', 'dwh'], 'warn');
      else st('16:05', 'Аналитик запускает тяжёлый запрос прямо в боевую базу — покупки начинают тормозить.', [dbk], 'bad');
      st('итог', `Свежесть отчётов: ${sc.fresh}.`, [], /секунд|минут/.test(sc.fresh) ? 'ok' : /сутки/.test(sc.fresh) ? 'warn' : 'bad');
    }
    return out;
  }
  function playInc(id) {
    S.inc = { id, list: steps(id), bad: null }; S.step = -1;
    nextStep();
  }
  function nextStep() {
    if (!S.inc) return;
    S.step = Math.min(S.inc.list.length - 1, S.step + 1);
    const st = S.inc.list[S.step]; S.hl = st.hl;
    S.inc.bad = st.cls === 'bad' ? st.hl.find(h => h.startsWith('n:')) || null : S.inc.bad;
    side();
  }

  /* ---------- боковая панель ---------- */
  function side() {
    const sc = score();
    let h = '';
    if (S.sel && EL[S.sel]) {
      const el = EL[S.sel];
      h += `<div class="xr-partbox"><div class="xr-ph"><span class="eyebrow">${{ cd: 'Доставка кода', k8s: 'Платформа', obs: 'Наблюдаемость', data: 'Данные', prod: 'Продукт' }[el.lane]}</span><b>${esc(el.name)}</b><button type="button" class="chg-x" data-lssel="" aria-label="Закрыть">×</button></div>`;
      h += `<div class="simple sm"><span class="an">${esc(el.an)}</span><span class="pl">${esc(el.pl)}</span></div>`;
      if (el.how) h += `<h4>Как работает</h4><ol class="gd-steps">${el.how.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`;
      if (el.gives) h += `<h4>Что даёт</h4><p>${esc(el.gives)}</p>`;
      if (el.without) h += `<h4>Без него</h4><p>${esc(el.without)}</p>`;
      if (el.tools) h += `<h4>Инструменты</h4><p>${esc(el.tools)}</p>`;
      const con = CON_OF[S.sel];
      if (con && SD.ops) h += `<button type="button" class="btn primary" data-lscon="${con}">Открыть ${esc(CON_NAME[con])} на живых данных</button>`;
      if (el.cap) h += `<label class="ls-tg"><input type="checkbox" data-lscap="${el.cap}" ${on[el.cap] ? 'checked' : ''}> ${on[el.cap] ? 'Включено' : 'Выключено'} — переключи и посмотри на DORA и инциденты</label>`;
      h += '</div>';
    }
    if (S.inc) {
      h += `<h3 class="xr-h">Инцидент: ${esc(INC[S.inc.id].name)}</h3><ol class="ls-tl">${S.inc.list.map((x, i) => `<li class="${x.cls} ${i === S.step ? 'cur' : ''} ${i > S.step ? 'later' : ''}"><b>${esc(x.t)}</b><span>${esc(x.txt)}</span></li>`).join('')}</ol>`;
      h += `<div class="ls-btns">${S.step < S.inc.list.length - 1 ? '<button type="button" class="btn primary" data-lsnext="1">Дальше ▶</button>' : '<button type="button" class="btn" data-lsinc="' + S.inc.id + '">Ещё раз</button>'}<button type="button" class="btn ghost" data-lsstop="1">Закрыть сценарий</button></div><p class="xr-note">Переключи инструменты ниже и проиграй снова — увидишь, как меняется ход инцидента.</p>`;
    }
    if (SD.ops) { h += `<div id="lsGd">${SD.ops.gameday()}</div><div class="ls-incs">${Object.entries(CON_NAME).map(([k, v]) => `<button type="button" class="chip-btn ${S.con === k ? 'on' : ''}" data-lscon="${k}">${esc(v)}</button>`).join('')}</div>`; }
    h += `<h3 class="xr-h">Сценарии: как инструменты работают вместе</h3><div class="ls-incs">${Object.entries(INC).map(([k, v]) => `<button type="button" class="chip-btn ${S.inc && S.inc.id === k ? 'on' : ''}" data-lsinc="${k}" title="${esc(v.note)}">${esc(v.name)}</button>`).join('')}</div>`;
    h += `<h3 class="xr-h">Что включено · ≈ $${sc.cost.toLocaleString('ru-RU')} в месяц</h3>`;
    CAPS.forEach(([, title, list]) => { h += `<div class="ls-capg"><small>${esc(title)}</small>${list.map(([k, name, , cost]) => `<label class="ls-cap"><input type="checkbox" data-lscap="${k}" ${on[k] ? 'checked' : ''}><span>${esc(name)}</span>${cost ? `<em>$${cost}</em>` : ''}</label>`).join('')}</div>`; });
    h += `<p class="xr-note">Цены — порядок величин для средней системы. Логи часто самая дорогая строка наблюдаемости: их много и их долго хранят.</p>`;
    $('lsSide').innerHTML = h;
    const sc2 = score();
    $('lsLive').innerHTML = `<span class="xr-chip ${sc2.tier[1]}"><small>DORA</small><b>${sc2.tier[0]}</b></span><span class="xr-chip"><small>Восстановление</small><b>≈ ${sc2.mttr} мин</b></span><span class="xr-chip"><small>обнаружить ${sc2.det} · найти ${sc2.dia} · откатить ${sc2.fix}</small></span>`;
  }

  /* ---------- консоли наблюдаемости ---------- */
  const CON_OF = { grafana: 'grafana', prom: 'prom', kibana: 'kibana', logs: 'kibana', alert: 'alert', trace: 'jaeger' };
  const CON_NAME = { grafana: 'Grafana', kibana: 'Kibana', prom: 'Prometheus', alert: 'Alertmanager', jaeger: 'Jaeger' };
  /* у SVG нет свойства hidden — прячем схему и подсказку стилем */
  const showMap = v => { $('lsSvg').style.display = v ? '' : 'none'; const h = document.querySelector('#lsModal .xr-hint'); if (h) h.style.display = v ? '' : 'none'; $('lsCon').hidden = v; };
  function openCon(tab) { S.con = tab; showMap(false); renderCon(true); side(); }
  function closeCon() { S.con = null; showMap(true); side(); }
  function renderCon(force) {
    const box = $('lsCon'); if (!box || !S.con) return;
    const ae = document.activeElement;
    if (!force && ae && box.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
    const st = box.querySelector('.oc-body'), top = st ? st.scrollTop : 0;
    box.innerHTML = `<div class="oc-head"><button type="button" class="btn ghost" data-lsconx="1">← Ландшафт</button><div class="seg">${Object.entries(CON_NAME).map(([k, v]) => `<button type="button" data-lscon="${k}" aria-selected="${S.con === k}">${v}</button>`).join('')}</div><span class="oc-sep"></span><b class="oc-lbl">Сбой:</b><button type="button" class="btn" data-ocact="chaos">Уронить экземпляр</button><button type="button" class="btn" data-ocact="wave">Волна ×3</button><button type="button" class="btn ghost" data-ocact="heal">Поднять всё</button></div><div class="oc-body">${SD.ops.render(S.con)}</div>`;
    const nb = box.querySelector('.oc-body'); if (nb) nb.scrollTop = top;
  }
  /* ---------- открыть, закрыть, события ---------- */
  function mount() {
    const m = document.createElement('div');
    m.className = 'modal xr-modal'; m.id = 'lsModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet xr-sheet" role="dialog" aria-modal="true" aria-labelledby="lsTitle">
      <div class="sheet-head xr-head"><span class="eyebrow" style="margin:0">Вся система</span><h2 id="lsTitle">Ландшафт: код → платформа → продукт → наблюдаемость → данные</h2><div class="xr-live" id="lsLive"></div><button class="btn ghost x" type="button" data-lsclose="1">Закрыть</button></div>
      <div class="xr-body"><div class="xr-main"><svg class="xr-svg ls-svg" id="lsSvg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="lsTitle"></svg><div class="ls-con" id="lsCon" hidden></div><p class="xr-hint">Нажми на любой инструмент — расскажу, что это, как работает и что будет без него. Нажми на свой сервис — провалишься внутрь. Точки: <span class="ls-k" style="--c:var(--accent)">код</span> <span class="ls-k" style="--c:var(--k-read)">запросы</span> <span class="ls-k" style="--c:var(--text-muted)">логи</span> <span class="ls-k" style="--c:var(--ok)">метрики</span> <span class="ls-k" style="--c:var(--info)">трейсы</span> <span class="ls-k" style="--c:var(--k-write)">данные</span></p></div>
      <aside class="xr-side" id="lsSide"></aside></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-lsclose]')) { close(); return; }
      const nd = e.target.closest('[data-lsnode]');
      if (nd) { const id = nd.dataset.lsnode, n = A().graph.nodes.find(x => x.id === id); if (n && SD.xray && SD.xray.has(n.type)) { close(); SD.xray.open(id); } else { S.sel = null; side(); } return; }
      const el = e.target.closest('[data-lsel]'); if (el) { S.sel = el.dataset.lsel; side(); draw(); const sd = $('lsSide'); if (sd) sd.scrollTop = 0; return; }
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.lssel !== undefined) { S.sel = null; side(); }
      if (b.dataset.lsinc) playInc(b.dataset.lsinc);
      if (b.dataset.lsnext) nextStep();
      if (b.dataset.lsstop) { S.inc = null; S.hl = []; side(); }
      if (b.dataset.lscon) openCon(b.dataset.lscon);
      if (b.dataset.lsconx) closeCon();
      if (b.dataset.ocact) { const id = { chaos: 'chaosBtn', wave: 'waveBtn', heal: 'healBtn' }[b.dataset.ocact]; if ($(id)) $(id).click(); }
      if (b.dataset.oclvl) { SD.ops.setLvl(b.dataset.oclvl); renderCon(true); }
      if (b.dataset.ocprom) { SD.ops.setProm(b.dataset.ocprom); renderCon(true); }
      if (b.dataset.octid) { SD.ops.openTrace(b.dataset.octid); openCon('jaeger'); }
    });
    m.addEventListener('input', e => { if (e.target.id === 'ocQ') { SD.ops.setQuery(e.target.value); clearTimeout(S.qt); S.qt = setTimeout(() => { renderCon(true); const q = $('ocQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); } });
    m.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'ocSvc') { SD.ops.setSvc(t.value); renderCon(true); return; }
      if (!t.dataset.lscap) return;
      on[t.dataset.lscap] = t.checked; save();
      if (S.inc) { const id = S.inc.id, st = S.step; S.inc = { id, list: steps(id), bad: null }; S.step = Math.min(st, S.inc.list.length - 1); S.hl = S.inc.list[S.step] ? S.inc.list[S.step].hl : []; }
      side(); if (S.con) renderCon(true);
    });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) { e.stopPropagation(); if (S.con) closeCon(); else close(); } }, true);
    /* вход: кнопка в шапке рядом с «Песочницей» */
    const sb = $('navSandbox');
    if (sb && !$('navLand')) { const b = document.createElement('button'); b.className = sb.className; b.id = 'navLand'; b.type = 'button'; b.textContent = 'Ландшафт'; b.title = 'Вся система: CI/CD, Kubernetes, логи, метрики, трейсы, данные'; sb.before(b); b.addEventListener('click', open); }
  }
  function open() {
    load();
    const cs = SD.opsState ? SD.opsState(A().graph) : null;
    if (cs && cs.any) { on.metrics = cs.metrics.size > 0; on.logs = cs.logs.size > 0; on.traces = cs.traces.size > 0; on.alerts = cs.alerts; }
    layout(); S.dots = []; S.sel = null; S.inc = null; S.hl = []; S.con = null; S.gdSig = '';
    if (SD.ops) SD.ops.reset();
    $('lsModal').hidden = false; showMap(true);
    side(); draw();
    S.last = performance.now();
    const loop = now => {
      if ($('lsModal').hidden) return;
      const dt = Math.min(80, now - S.last); S.last = now;
      if (!S.con) { tick(dt); draw(); }
      if (SD.ops && SD.ops.tick(now - (S.opsT || now))) { if (S.con) renderCon(); const gd = SD.ops.gameday(); if (gd !== S.gdSig) { S.gdSig = gd; const b = $('lsGd'); if (b) b.innerHTML = gd; } }
      S.opsT = now;
      S.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(loop);
  }
  function close() { $('lsModal').hidden = true; cancelAnimationFrame(S.raf); }

  SD.landscape = { mount, open, close, score, caps: () => Object.assign({}, on) };
})();
