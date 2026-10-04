/* Инструменты эксплуатации как обычные компоненты площадки: метрики, дашборды, алерты, логи, трейсы, Kubernetes.
   Трафик пользователей через них не идёт: стрелка к ним — это «отдаёт телеметрию» или «разворачивает». */
(function () {
  const tog = (key, label, def, help) => ({ key, label, type: 'toggle', def, help });
  SD.GROUPS.push({ id: 'ops', label: 'Наблюдаемость' }, { id: 'platform', label: 'Платформа' });

  Object.assign(SD.TYPES, {
    prometheus: {
      name: 'Prometheus', short: 'метрики: опрашивает сервисы', group: 'ops', layer: 'obs', ops: 'metrics', managed: true, perCap: 1e9, lat: 0,
      props: [{ key: 'scrape', label: 'Как часто опрашивать', type: 'select', def: 15, options: [[5, 'Каждые 5 с — точнее, но больше данных'], [15, 'Каждые 15 с — стандарт'], [60, 'Раз в минуту — дёшево, сбой виден позже']], help: 'Чаще опрос — быстрее видно проблему, но больше места и нагрузки на сам Prometheus.' },
        { key: 'retention', label: 'Хранить метрики', type: 'select', def: 15, options: [[7, '7 дней'], [15, '15 дней'], [90, '90 дней — для сравнения с прошлым кварталом']], help: 'Долгое хранение обычно выносят в Thanos или VictoriaMetrics.' }],
      cost: n => 100 + (n.props.retention || 15) * 4 + (n.props.scrape === 5 ? 120 : 0),
      info: { what: 'Каждые несколько секунд опрашивает сервисы по адресу /metrics и хранит числа во времени: запросы, ошибки, задержку, CPU.', why: 'Без метрик о проблеме узнаёшь от пользователей. С метриками — видишь, что, где и с какого момента пошло не так.', pros: ['Простой и надёжный: сам ходит за данными', 'Мощный язык запросов PromQL', 'Правила алертов'], cons: ['Один сервер — для долгого хранения нужен Thanos/VictoriaMetrics', 'Не для логов и трейсов'], real: 'Prometheus, VictoriaMetrics, Grafana Mimir, Datadog', numbers: [['Опрос', 'раз в 15 с'], ['Точка данных', '≈ 1–2 байта после сжатия']] }
    },
    grafana: {
      name: 'Grafana', short: 'дашборды: графики по метрикам', group: 'ops', layer: 'obs', ops: 'dash', managed: true, perCap: 1e9, lat: 0, props: [],
      cost: () => 50,
      info: { what: 'Рисует графики и дашборды по данным из Prometheus, логов и трейсов.', why: 'Метрики без графиков — таблицы чисел. Дашборд показывает здоровье системы за секунды: где растут ошибки, кто тормозит.', pros: ['Один экран для метрик, логов и трейсов', 'Готовые дашборды для популярных систем'], cons: ['Дашборды надо поддерживать: устаревают вместе с системой'], real: 'Grafana, Kibana (для логов), Datadog', numbers: [] }
    },
    alertmanager: {
      name: 'Alertmanager', short: 'алерты: будит дежурного', group: 'ops', layer: 'obs', ops: 'alerts', managed: true, perCap: 1e9, lat: 0,
      props: [{ key: 'channel', label: 'Куда слать', type: 'select', def: 'phone', options: [['phone', 'Звонок и пуш дежурному (PagerDuty)'], ['chat', 'Чат команды (Telegram, Slack)'], ['email', 'Почта']], help: 'Ночью почту и чат никто не читает: критичные алерты должны звонить.' }],
      cost: () => 30,
      info: { what: 'Получает сработавшие правила от Prometheus, группирует их и отправляет людям: звонок, чат, почта.', why: 'Графики полезны, только если на них смотрят. Алерт сам зовёт человека, когда что-то сломалось — даже ночью.', pros: ['Группирует и глушит дубли', 'Расписание дежурств через PagerDuty/Opsgenie'], cons: ['Шумные алерты быстро перестают читать'], real: 'Alertmanager, PagerDuty, Opsgenie, Grafana OnCall', numbers: [['Задержка уведомления', 'секунды']] }
    },
    kibana: {
      name: 'Логи: ELK + Kibana', short: 'поиск по логам всех сервисов', group: 'ops', layer: 'obs', ops: 'logs', managed: true, perCap: 1e9, lat: 0,
      props: [{ key: 'retention', label: 'Хранить логи', type: 'select', def: 14, options: [[3, '3 дня — дёшево'], [14, '14 дней'], [90, '90 дней — для расследований и аудита']], help: 'Логи — самая дорогая часть наблюдаемости: их много. Срок хранения сильно влияет на цену.' }],
      cost: n => 150 + (n.props.retention || 14) * 25,
      info: { what: 'Собирает логи всех сервисов в одно место (Elasticsearch) и даёт искать по ним в Kibana.', why: 'Логи в каждом поде пропадают при перезапуске, и искать по ним приходится вручную. В одном месте — ошибку находишь за минуты по тексту, сервису или trace id.', pros: ['Полнотекстовый поиск', 'Фильтры и графики по логам'], cons: ['Дорого хранить', 'Elasticsearch требует внимания: шарды, место'], real: 'Elasticsearch/OpenSearch + Kibana, Grafana Loki', numbers: [['Объём', 'десятки ГБ в день у средней системы']] }
    },
    jaeger: {
      name: 'Jaeger', short: 'трейсы: путь запроса по сервисам', group: 'ops', layer: 'obs', ops: 'traces', managed: true, perCap: 1e9, lat: 0,
      props: [{ key: 'sampling', label: 'Какую долю запросов записывать', type: 'select', def: 0.1, options: [[0.01, '1 % — дёшево, редкие ошибки можно не поймать'], [0.1, '10 %'], [1, '100 % — всё, но дорого']], help: 'Часто пишут все запросы с ошибками и долю обычных (tail sampling).' }],
      cost: n => 80 + Math.round((n.props.sampling || 0.1) * 600),
      info: { what: 'Собирает «отрезки» (spans) одного запроса со всех сервисов в дерево: видно, кто сколько времени занял.', why: 'Когда запрос проходит 5 сервисов, метрики скажут «медленно», а трейс покажет, где именно.', pros: ['Видно узкое место в цепочке', 'Связь с логами через trace id'], cons: ['Нужно пробрасывать trace id через все сервисы'], real: 'OpenTelemetry + Jaeger, Grafana Tempo, Zipkin', numbers: [] }
    },
    k8s: {
      name: 'Kubernetes', short: 'запускает сервисы и поднимает упавшие', group: 'platform', layer: 'platform', ops: 'k8s', managed: true, perCap: 1e9, lat: 0,
      props: [{ key: 'nodes', label: 'Серверов (узлов) в кластере', type: 'range', min: 1, max: 10, def: 3, help: 'Поды раскладываются по узлам. Упадёт узел — поды переедут на другие, если там есть место.' },
        tog('probes', 'Проверки здоровья подов (liveness/readiness)', true, 'Kubernetes сам перезапускает зависший под и не шлёт трафик неготовому.')],
      cost: n => 75 + (n.props.nodes || 3) * 60,
      info: { what: 'Запускает контейнеры сервисов на серверах, следит, чтобы их было сколько надо, и сам поднимает упавшие.', why: 'Без оркестратора упавший сервер — это звонок админу и час простоя. Kubernetes заметит и перезапустит под за секунды, разложит нагрузку по серверам и обновит версию без простоя.', pros: ['Самолечение', 'Выкатка без простоя', 'Автомасштабирование'], cons: ['Сложный: нужна команда платформы', 'Не спасает, если экземпляр один'], real: 'EKS, GKE, AKS, k3s, OpenShift', numbers: [['Перезапуск пода', 'секунды'], ['Переезд с упавшего узла', '≈ 1 мин']] }
    }
  });
  const prevInner = SD.iconInner;
  const OPS_ICONS = {
    prometheus: '<circle cx="12" cy="12" r="8.5"/><path d="M8 16h8M9 13.5c0-2 1.5-2.5 1.5-5 1.5 1 2.5 2.5 3 1.5.5 1.5 1.5 2 1.5 3.5"/>',
    grafana: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M6 14l3-4 3 2 3-5 3 3"/><path d="M9 21h6"/>',
    alertmanager: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M3 7l2 1M21 7l-2 1"/>',
    kibana: '<path d="M4 5h16M4 9h11M4 13h16M4 17h8"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M19.4 19.4L21 21"/>',
    jaeger: '<path d="M3 6h7M6 10h9M9 14h6M11 18h9"/><path d="M3 6v12"/>',
    k8s: '<path d="M12 2.8l7.8 3.8 1.9 8.4-5.4 6.8H7.7L2.3 15l1.9-8.4z"/><circle cx="12" cy="12" r="2.6"/><path d="M12 6.5v3M12 14.6v3M7 9.6l2.6 1.4M14.4 13l2.6 1.4M7 14.4l2.6-1.4M14.4 11l2.6-1.4"/>'
  };
  SD.iconInner = t => OPS_ICONS[t] || prevInner(t);

  /* слой схемы для каждого типа */
  const DATA = new Set(['olap', 'etl', 'lake', 'tsdb', 'cdc']);
  SD.layerOf = type => { const t = SD.TYPES[type] || {}; return t.layer || (DATA.has(type) ? 'data' : 'product'); };
  SD.LAYERS = [['all', 'Все слои'], ['product', 'Продукт'], ['obs', 'Наблюдаемость'], ['platform', 'Платформа'], ['data', 'Данные']];

  /* что даёт эксплуатация на этой схеме: кто под наблюдением и сколько времени уходит на сбой */
  const SVC = new Set(['app', 'worker', 'gateway', 'ws', 'faas', 'agent']);
  SD.opsState = g => {
    const by = id => g.nodes.find(n => n.id === id);
    const tool = (n, kind) => n && SD.TYPES[n.type] && SD.TYPES[n.type].ops === kind;
    const svcs = g.nodes.filter(n => SVC.has(n.type));
    const to = (n, kind) => g.edges.some(e => e.from === n.id && tool(by(e.to), kind));
    const metrics = new Set(svcs.filter(n => to(n, 'metrics')).map(n => n.id));
    const logs = new Set(svcs.filter(n => to(n, 'logs')).map(n => n.id));
    const traces = new Set(svcs.filter(n => to(n, 'traces')).map(n => n.id));
    const k8sNodes = g.nodes.filter(n => tool(n, 'k8s'));
    const k8s = new Set(svcs.filter(n => g.edges.some(e => e.to === n.id && tool(by(e.from), 'k8s'))).map(n => n.id));
    const proms = g.nodes.filter(n => tool(n, 'metrics'));
    const dash = proms.some(p => g.edges.some(e => (e.from === p.id && tool(by(e.to), 'dash')) || (e.to === p.id && tool(by(e.from), 'dash'))));
    const alertNode = g.nodes.find(n => tool(n, 'alerts'));
    const alerts = !!alertNode && proms.some(p => g.edges.some(e => (e.from === p.id && e.to === alertNode.id) || (e.to === p.id && e.from === alertNode.id)));
    const all = set => svcs.length > 0 && svcs.every(n => set.has(n.id));
    const any = g.nodes.some(n => SD.TYPES[n.type] && SD.TYPES[n.type].ops);
    const ch = alertNode && alertNode.props.channel;
    const mttd = all(metrics) && alerts ? (ch === 'email' ? 30 : ch === 'chat' ? 10 : 2) : metrics.size && dash ? 20 : 45;
    const diag = all(logs) && all(traces) ? 5 : all(logs) ? 20 : logs.size ? 40 : 60;
    const restart = all(k8s) && k8sNodes.some(n => n.props.probes !== false) ? 1 : k8s.size ? 15 : 30;
    return { svcs, metrics, logs, traces, k8s, dash, alerts, any, mttd, diag, restart, all, k8sNodes };
  };
})();
