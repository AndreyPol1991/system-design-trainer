/* ИИ-уровни, часть 2: качество поиска по документам и наблюдаемость ассистента.
   1. «Ассистент находит не то» (ragfix). Рычаги: гибридный поиск (слова + смысл) и права на документы — настройки векторной БД,
      переписывание вопроса и честное «не знаю» — настройки LLM (feature 'rag2'), новый узел «Переранжировщик» (rerank).
      Модель качества: вопросы четырёх видов (обычные, с кодами товаров, расплывчатые, без ответа в базе) → нашёлся ли нужный
      кусок, попал ли он в подсказку модели, ответила ли модель верно или честно сказала «не знаю»; утечка чужих документов.
   2. «Наблюдаемость ассистента» (aiobs). Узлы-датчики в группе «Наблюдаемость»: LLM-трассы, прогон эталонов, выборочная
      разметка. Учебный сбой «поставщик тихо обновил модель»: 10 дней на графиках — ошибки и задержка зелёные, качество падает;
      кто и когда заметит, зависит от датчиков на схеме.
   Уровни встают в ИИ-ярус карты сразу после «AI-ассистента поддержки». Схемы без этих узлов и настроек считаются как раньше:
   модель качества включается только на уровнях с L.rag2. */
(function () {
  const T = SD.TYPES;
  const HAS_DOM = typeof document !== 'undefined';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const dec = (v, k) => { const p = Math.pow(10, k == null ? 1 : k); return (Math.round(v * p) / p).toString().replace('.', ','); };
  const pc = v => Math.round(v * 100) + ' %';
  const pc1 = v => dec(v * 100, 1) + ' %';
  const usd = v => SD.fmt ? SD.fmt.usd(v) : '$' + Math.round(v);
  const num = v => Math.round(v).toLocaleString('ru-RU');
  const plural = (n, a, b, c) => { const x = Math.abs(Math.round(n)) % 100, y = x % 10; return x > 10 && x < 20 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };
  const hrs = h => h >= 48 ? `${dec(h / 24, h >= 240 ? 0 : 1)} ${plural(h / 24 < 5 ? 2 : 5, 'день', 'дня', 'дней')}` : h >= 1 ? `${Math.round(h)} ч` : `${Math.max(1, Math.round(h * 60))} мин`;
  const lbl = n => n ? (n.label || (T[n.type] ? T[n.type].name : n.type)) : '';
  const MONTH = 2.63e6;

  /* =====================================================================
     1. Узлы и настройки
     ===================================================================== */
  const RR = { selfMs: 60, apiMs: 150, gpuQps: 30, apiUsd: 1 };   // переранжировщик: мс на вопрос, вопросов/с на GPU, $ за 1 000
  const RW = { tok: 64, ttftK: 0.35, out: 40, inTok: 300 };        // переписывание вопроса: короткий вызов модели

  if (!T.rerank) T.rerank = {
    name: 'Переранжировщик', short: 'reranker: лучшие куски наверх', group: 'ai',
    props: [
      { key: 'hosting', label: 'Где работает', type: 'select', def: 'self', options: [['api', 'Облачный API — $1 за 1 000 вопросов'], ['self', 'Свой GPU — $1 900 в месяц']],
        help: 'API: держать ничего не надо, платишь за каждый вопрос — выгодно при малой нагрузке, ≈ 150 мс. Свой GPU: одна цена при любой нагрузке, ≈ 60 мс, один GPU пересматривает ≈ 30 вопросов в секунду.' },
      { key: 'gpus', label: 'GPU', type: 'range', min: 1, max: 4, def: 1, showIf: n => n.props.hosting === 'self', help: `Каждый GPU ≈ $${SD.GPU_COST || 1900} в месяц и ≈ ${RR.gpuQps} вопросов в секунду (по 50 кусков на вопрос).` }
    ],
    cost: n => n.props.hosting === 'self' ? (n.props.gpus || 1) * (SD.GPU_COST || 1900) : 0,
    info: {
      what: 'Вторая, внимательная проверка найденного: берёт 50 кусков от поиска, читает каждый вместе с вопросом (cross-encoder) и ставит 5 лучших наверх — они и идут в подсказку модели.',
      why: 'Быстрый поиск сравнивает векторы «издалека» и путает похожие документы: старую инструкцию с новой, соседний товар с нужным. Переранжировщик точнее, но медленнее и дороже — поэтому смотрит только короткий список от поиска.',
      pros: ['Нужный кусок чаще попадает в подсказку модели', 'Отсекает похожие, но устаревшие документы'],
      cons: ['+60–150 мс к ответу', 'GPU или плата за каждый вопрос'],
      real: 'bge-reranker, Cohere Rerank, Jina Reranker, cross-encoder ms-marco', numbers: [['Свой GPU', `≈ ${RR.gpuQps} вопросов/с, ≈ ${RR.selfMs} мс`], ['API', `≈ ${RR.apiMs} мс, $${RR.apiUsd} за 1 000 вопросов`]]
    }, dive: 'rag'
  };

  const has = (t, k) => T[t] && (T[t].props || []).some(p => p.key === k);
  if (T.vectordb && !has('vectordb', 'retrieval')) T.vectordb.props = T.vectordb.props.concat([
    { key: 'retrieval', label: 'Как искать', type: 'select', def: 'vector', feature: 'rag2',
      options: [['vector', 'По смыслу — только векторы'], ['hybrid', 'Гибридно — по словам и по смыслу']],
      help: 'По смыслу поиск найдёт «сдать покупку обратно» по запросу «как вернуть товар», но к точным кодам почти слеп: ПФ-2610-М и ПФ-2016-М для векторов — одно и то же. Гибридный поиск добавляет поиск по словам (BM25) и сливает два списка: коды, артикулы и номера договоров находятся точно. Цена — ≈ 8 мс и индекс слов рядом с векторным.' },
    { key: 'acl', label: 'Права на документы', type: 'select', def: 'none', feature: 'rag2',
      options: [['none', 'Не проверять — ищем по всем документам'], ['post', 'После поиска — выкинуть чужое из найденного'], ['pre', 'До поиска — «только свои» прямо в запросе к индексу']],
      help: 'Не проверять — в подсказку модели попадают чужие договоры и цены, и модель их пересказывает. После поиска — утечки нет, но из 50 найденных кусков большая часть чужие: после фильтра нужного часто не остаётся. До поиска — индекс сразу ищет только среди документов этого партнёра (фильтр по метке partner_id): и безопасно, и точно.' }
  ]);
  if (T.llm && !has('llm', 'rewrite')) T.llm.props = T.llm.props.concat([
    tog('rewrite', 'Переписывать вопрос перед поиском', false, 'Перед поиском модель коротким вызовом превращает «а для той, что подешевле, есть кейс?» в полный вопрос с названием товара из диалога. Расплывчатые и уточняющие вопросы начинают находить нужное. Цена — ещё один короткий вызов модели: ≈ 0,5–0,8 с и токены.', { feature: 'rag2' }),
    { key: 'idk', label: 'Если опоры в документах мало', type: 'select', def: 'off', feature: 'rag2',
      options: [['off', 'Отвечать как получится'], ['soft', 'Честно «не знаю» — мягкий порог'], ['strict', 'Честно «не знаю» — строгий порог']],
      help: 'Модель оценивает, отвечают ли найденные куски на вопрос. Ниже порога — не выдумывает, а говорит «не нашёл в документах, передаю менеджеру». Мягкий порог ловит ≈ 3 из 4 выдумок и почти не мешает честным ответам. Строгий ловит больше, но отказывает и там, где ответ был: ассистент превращается в автоответчик «не знаю».' }
  ]);

  /* датчики наблюдаемости ИИ: те же правила, что у Prometheus и Grafana — трафик через них не идёт, стрелка = телеметрия */
  const EVAL_RUNS = { release: 4, nightly: 30, hourly: 720 };
  const EVAL_USD = 0.05, LABEL_USD = 0.5;
  const TRACE_USD = { 7: 150, 30: 400, 90: 1100 };
  if (!T.llmtrace) T.llmtrace = {
    name: 'LLM-трассы', short: 'каждый вызов модели: токены, цена, исход', group: 'ops', layer: 'obs', ops: 'llmtrace', managed: true, perCap: 1e9, lat: 0,
    props: [{ key: 'retention', label: 'Хранить трассы', type: 'select', def: 30, options: [[7, '7 дней — дёшево'], [30, '30 дней'], [90, '90 дней — для разборов и аудита']],
      help: 'Трассы с текстами занимают много места — срок хранения заметно влияет на цену. Телефоны и номера карт маскируются до записи.' }],
    cost: n => TRACE_USD[n.props.retention] || TRACE_USD[30],
    info: {
      what: 'Записывает каждый вызов модели: вопрос, найденные документы, версию модели и подсказки, токены, цену, время и исход — ответил, «не знаю» или позвал человека; плюс 👍/👎 пользователя.',
      why: 'Prometheus видит, что сервис ответил за 1,2 с без ошибки. Трасса видит, что ответ был «не знаю», стоил $0,008 и получил 👎. Из трасс строятся ИИ-метрики на панели: доля «не знаю», передачи человеку, ссылки на источник, цена ответа, токены, жалобы.',
      pros: ['ИИ-метрики рядом с техническими', 'Любой плохой ответ можно разобрать по шагам'],
      cons: ['Тексты диалогов — персональные данные: маскировать и ограничивать доступ', 'Хранение растёт вместе с трафиком'],
      real: 'Langfuse, Arize Phoenix, LangSmith, Helicone, OpenTelemetry GenAI', numbers: [['Трасса', '≈ 2–5 КБ'], ['Задержка записи', 'асинхронно, 0 мс к ответу']]
    }
  };
  if (!T.evals) T.evals = {
    name: 'Прогон эталонов', short: 'контрольные вопросы с известными ответами', group: 'ops', layer: 'obs', ops: 'evals', managed: true, perCap: 1e9, lat: 0,
    props: [
      { key: 'when', label: 'Когда прогонять', type: 'select', def: 'release', options: [['release', 'Только при своих релизах'], ['nightly', 'Каждую ночь'], ['hourly', 'Каждый час']],
        help: 'Свои релизы — раз в неделю: тихое обновление у поставщика между ними никто не проверит. Каждую ночь — ловит за сутки. Каждый час — быстрее, но дорого, и случайные провалы будят дежурного чаще.' },
      { key: 'size', label: 'Вопросов в наборе', type: 'select', def: 300, options: [[50, '50 — быстро, но шумно (±9 п. п.)'], [300, '300 — ±4 п. п.'], [1000, '1 000 — ±2 п. п., дороже']],
        help: 'Доля верных на маленьком наборе прыгает от прогона к прогону: на 50 вопросах случайный разброс ±9 п. п. — порог «на 4 п. п. хуже нормы» срабатывает от шума. 300 вопросов — разброс ±4 п. п.' }
    ],
    cost: n => (EVAL_RUNS[n.props.when] || 30) * (+n.props.size || 300) * EVAL_USD,
    info: {
      what: 'Набор вопросов с эталонными ответами (золотой набор). По расписанию задаёт их ассистенту тем же путём, что и пользователи, и сравнивает ответы с эталонами: точное совпадение фактов плюс модель-судья.',
      why: 'Технические метрики говорят, отвечает ли ассистент, а не верно ли он отвечает. Прогон эталонов — контрольная закупка: упала доля верных — Prometheus через Alertmanager зовёт дежурного, даже если ошибок ноль.',
      pros: ['Замечает падение качества за часы, а не по жалобам', 'Тот же набор — проверка перед любым релизом'],
      cons: ['Стоит токенов на каждый прогон', 'Стареет: новые темы вопросов в нём не появляются сами'],
      real: 'promptfoo, DeepEval, Ragas, OpenAI Evals, свои наборы в CI', numbers: [['300 вопросов', '≈ 15 мин и ≈ $15 с моделью-судьёй'], ['Разброс на 300', '≈ ±4 п. п.']]
    }
  };
  if (!T.labeling) T.labeling = {
    name: 'Выборочная разметка', short: 'люди оценивают живые диалоги', group: 'ops', layer: 'obs', ops: 'labels', managed: true, perCap: 1e9, lat: 0,
    props: [{ key: 'perDay', label: 'Диалогов в день', type: 'select', def: 50, options: [[50, '50 — ±8 п. п., $750 в месяц'], [200, '200 — ±4 п. п., $3 000 в месяц'], [1000, '1 000 — ±2 п. п., $15 000 в месяц']],
      help: 'Асессоры каждый день оценивают случайную выборку вчерашних диалогов: верно ли, опирается ли ответ на документ, вежлив ли. Чем больше выборка, тем точнее замер, но каждый диалог — ≈ $0,5 работы человека.' }],
    cost: n => (+n.props.perDay || 50) * 30 * LABEL_USD,
    info: {
      what: 'Каждый день люди оценивают случайную выборку живых диалогов: верен ли ответ, опирается ли он на документ, не выдумано ли. Оценки идут в метрики.',
      why: 'Эталоны проверяют известные вопросы, а люди спрашивают о новом: акция, новая линейка, сезон. Разметка — честный замер качества на реальном трафике; из неё же пополняют набор эталонов.',
      pros: ['Качество на живых вопросах, а не на эталонах', 'Находит новые темы, где ассистент слаб'],
      cons: ['Работа людей: дорого и с задержкой в сутки', 'Маленькая выборка шумит'],
      real: 'Label Studio, Argilla, разметка в Langfuse, свои асессоры', numbers: [['Оценка диалога', '≈ 2–3 мин, ≈ $0,5'], ['200 диалогов в день', '≈ ±4 п. п.']]
    }
  };

  /* значки */
  SD.INNER_ICONS = SD.INNER_ICONS || {};
  Object.assign(SD.INNER_ICONS, {
    rerank: '<path d="M4 6h9M4 12h6M4 18h9"/><path d="M18 4v16M15 7l3-3 3 3M15 17l3 3 3-3"/>',
    llmtrace: '<path d="M3 6h8M6 10h10M9 14h7M12 18h8"/><path d="M19 2.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>',
    evals: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M7.5 8l1.5 1.5L12 6.5M7.5 13.5L9 15l3-3M7.5 18h1"/><path d="M14 8h3M14 13.5h3M14 18h3"/>',
    labeling: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15 9.5l2 2 4-4"/>'
  });
  if (SD.iconInner && !SD.iconInner.__aq) {
    const prevIcon = SD.iconInner;
    SD.iconInner = t => SD.INNER_ICONS[t] && ['rerank', 'llmtrace', 'evals', 'labeling'].includes(t) ? SD.INNER_ICONS[t] : prevIcon(t);
    SD.iconInner.__aq = true;
  }
  SD.KIND_ALIAS = SD.KIND_ALIAS || {};
  SD.KIND_ALIAS.rrq = 'chat';

  /* простыми словами: аналогия → фраза без терминов */
  if (SD.SIMPLE_TYPES) Object.assign(SD.SIMPLE_TYPES, {
    rerank: ['Перечитывает найденное вместе с вопросом и ставит самое подходящее наверх.', 'Продавец, который из охапки похожих коробок выбирает ту, что ты просил.'],
    llmtrace: ['Записывает каждый разговор с моделью: что спросили, что нашли, что ответили и во что обошлось.', 'Бортовой самописец: после полёта видно каждое решение пилота.'],
    evals: ['Каждый раз задаёт ассистенту одни и те же вопросы с известными ответами и считает, сколько верных.', 'Контрольная закупка: тайный покупатель задаёт одни и те же вопросы и сверяет ответы.'],
    labeling: ['Люди каждый день проверяют случайные живые диалоги: верно ли ответил ассистент.', 'Шеф пробует блюда из зала, а не только те, что готовил для проверки.']
  });
  if (SD.TYPE_GUIDE) Object.assign(SD.TYPE_GUIDE, {
    rerank: ['Поиск быстро находит 50 похожих кусков документов — «издалека», по векторам.', 'Переранжировщик читает каждый кусок вместе с вопросом и ставит оценку «насколько это ответ».', 'Пять лучших идут в подсказку модели. Старые и соседние документы опускаются вниз.', 'Работает дольше поиска, поэтому смотрит только короткий список, а не всю базу.'],
    llmtrace: ['Сервис ассистента после каждого ответа отправляет трассу: вопрос, найденные куски, версию модели, токены, цену, исход.', 'Пользователь ставит 👍 или 👎 — оценка прикрепляется к той же трассе.', 'Из трасс считаются ИИ-метрики: доля «не знаю», передачи человеку, ссылки на источник, цена ответа, токены, жалобы.', 'Плохой ответ можно открыть и пройти по шагам: что нашлось и почему модель ответила так.'],
    evals: ['В наборе — вопросы с эталонными ответами, собранные из реальных обращений.', 'По расписанию набор прогоняется через ассистента — тем же путём, что у пользователей.', 'Ответы сверяются с эталонами: факты — точным сравнением, смысл — моделью-судьёй.', 'Доля верных уходит в Prometheus. Ниже порога — Alertmanager зовёт дежурного.'],
    labeling: ['Из вчерашних диалогов случайно выбирается выборка — например, 200 штук.', 'Асессоры оценивают каждый: верно ли, опирается ли на документ, не выдумано ли.', 'Оценки идут в метрики: качество на живом трафике с понятной погрешностью.', 'Плохие диалоги пополняют набор эталонов — следующий прогон проверит и их.']
  });
  if (SD.PROP_SIMPLE) {
    SD.PROP_SIMPLE.vectordb = Object.assign(SD.PROP_SIMPLE.vectordb || {}, {
      retrieval: 'Библиотекарь, который ищет только «по смыслу», на просьбу «ПФ-2610-М» принесёт ПФ-2016-М — похоже же. Гибридный поиск — это библиотекарь с каталогом: точные коды и номера ищет по каталогу, а «что-нибудь про возврат» — по смыслу, и складывает обе стопки.',
      acl: 'Читательский билет. Не проверять — выдают любую папку из архива, и чужой договор попадёт в ответ. Проверить после поиска — принесли 50 папок и 47 унесли обратно: своей среди трёх оставшихся часто нет. Проверить до поиска — ищут сразу только на полке этого читателя.'
    });
    SD.PROP_SIMPLE.llm = Object.assign(SD.PROP_SIMPLE.llm || {}, {
      rewrite: 'Секретарь, который переспрашивает: «а для той, что подешевле» — это для болгарки «Бриз», верно? Модель сначала дописывает вопрос по истории диалога, и только потом ищет. Стоит ещё одного короткого вызова модели.',
      idk: 'Хороший консультант говорит «не знаю, уточню у менеджера», а плохой — уверенно выдумывает. Мягкий порог отказывает, когда в найденном почти ничего по делу. Строгий — при малейшем сомнении: выдумок меньше, но и честных ответов тоже.'
    });
    SD.PROP_SIMPLE.rerank = { hosting: 'Свой станок или мастерская на заказ. Свой GPU стоит одинаково при любой загрузке; API берёт за каждый вопрос. Пять миллионов вопросов в месяц — дешевле свой.', gpus: 'Сколько видеокарт у переранжировщика. Одна пересматривает ≈ 30 вопросов в секунду — с большим запасом для двух вопросов в секунду.' };
    SD.PROP_SIMPLE.evals = { when: 'Как часто тайный покупатель приходит в магазин. Только после своих ремонтов — не заметит, что поставщик тихо поменял товар. Каждую ночь — заметит к утру. Каждый час — быстрее, но дорого, и чаще поднимет ложную тревогу.', size: 'Сколько вопросов задаёт тайный покупатель. Из 50 вопросов одна-две случайные ошибки сдвигают долю верных на 2–4 п. п. — шум похож на беду. Из 300 случайность почти не видна.' };
    SD.PROP_SIMPLE.labeling = { perDay: 'Сколько блюд из зала в день пробует шеф. Пять тарелок — ничего не поймёшь, двести — видно, что суп пересолен. Каждая проверка — время человека.' };
    SD.PROP_SIMPLE.llmtrace = { retention: 'Сколько хранить записи самописца. Неделя — хватит на разбор вчерашней жалобы. Три месяца — для разборов, аудита и сравнения с прошлым кварталом, но дороже.' };
  }
  if (SD.OPT_SIMPLE) {
    SD.OPT_SIMPLE['vectordb.retrieval'] = { vector: 'Только смысл: «как вернуть товар» найдётся, а код ПФ-2610-М перепутается с ПФ-2016-М.', hybrid: 'Слова + смысл: коды, артикулы и номера договоров находятся точно. +≈ 8 мс.' };
    SD.OPT_SIMPLE['vectordb.acl'] = { none: 'Без проверки: чужие договоры и цены попадают в подсказку модели — утечка.', post: 'После поиска: утечки нет, но нужный документ часто выпадает вместе с чужими.', pre: 'До поиска: ищем только среди своих документов — безопасно и точно.' };
    SD.OPT_SIMPLE['llm.rewrite'] = { true: 'Вопрос дописывается по истории диалога — расплывчатые вопросы находят нужное. +≈ 0,5–0,8 с.', false: 'Ищем по вопросу как есть: «а для той, что подешевле?» находит что попало.' };
    SD.OPT_SIMPLE['llm.idk'] = { off: 'Отвечает всегда — при пустом поиске уверенно выдумывает.', soft: 'Мягкий порог: ловит ≈ 3 из 4 выдумок, честным ответам почти не мешает.', strict: 'Строгий порог: выдумок меньше, но «не знаю» и там, где ответ был.' };
    SD.OPT_SIMPLE['rerank.hosting'] = { api: '$1 за 1 000 вопросов и ≈ 150 мс. При 5 млн вопросов в месяц — ≈ $5 300.', self: 'Свой GPU: $1 900 в месяц при любой нагрузке, ≈ 60 мс.' };
    SD.OPT_SIMPLE['evals.when'] = { release: 'Только при своих релизах: обновление поставщика между ними не заметит никто.', nightly: 'Каждую ночь: падение качества видно к утру, ≈ $15 за прогон.', hourly: 'Каждый час: быстро, но в 24 раза дороже и чаще ложные тревоги.' };
    SD.OPT_SIMPLE['evals.size'] = { 50: '50 вопросов: разброс ±9 п. п. — порог срабатывает от шума.', 300: '300 вопросов: разброс ±4 п. п. — падение на 9 п. п. видно сразу.', 1000: '1 000 вопросов: ±2 п. п., но втрое дороже.' };
    SD.OPT_SIMPLE['labeling.perDay'] = { 50: '50 диалогов: ±8 п. п. — изменения не отличить от шума.', 200: '200 диалогов: ±4 п. п. — видно падение на 5 п. п. и больше.', 1000: '1 000 диалогов: ±2 п. п., но $15 000 в месяц.' };
  }

  /* =====================================================================
     2. Модель качества поиска по документам (RAG)
     ===================================================================== */
  const MIX = { plain: 0.5, codes: 0.25, vague: 0.15, none: 0.1 };          // какие вопросы задают
  const FOUND = { plain: { vector: 0.93, hybrid: 0.97 }, codes: { vector: 0.55, hybrid: 0.97 }, vague: { vector: 0.93, hybrid: 0.95 } };
  const VAGUE_RAW = 0.55;                                                   // расплывчатый вопрос без переписывания
  const TOP = { plain: 0.84, codes: 0.8, vague: 0.8 }, TOP_RR = 0.98;      // нужный кусок в пятёрке для модели
  const ACL = { none: { found: 1, top: 0.97 }, post: { found: 0.82, top: 1 }, pre: { found: 1, top: 1 } };
  const ANS = { small: 0.92, medium: 0.98, large: 0.99 };                   // модель верно пересказывает нужный кусок
  const IDK = { off: { catch: 0.1, fals: 0.005 }, soft: { catch: 0.75, fals: 0.02 }, strict: { catch: 0.92, fals: 0.18 } };
  const NORAG = 0.1;                                                        // без поиска по документам модель угадывает редко
  const RECALL = { hnsw: 0.97, ivf: 0.92, flat: 1 };
  const CLS = { plain: 'обычные вопросы', codes: 'с кодами товаров', vague: 'расплывчатые и уточняющие', none: 'ответа в базе нет' };

  function ragQuality(lv, cfg) {
    const mix = Object.assign({}, MIX, cfg && cfg.mix), foreign = (cfg && cfg.foreign) || 0.05;
    const ans = ANS[lv.size] || ANS.medium, P = IDK[lv.idk] || IDK.off, A = ACL[lv.acl] || ACL.none;
    const cls = {};
    let acc = 0, idk = 0, wrong = 0;
    ['plain', 'codes', 'vague'].forEach(c => {
      let g = NORAG;
      if (lv.rag) {
        let found = FOUND[c][lv.hybrid ? 'hybrid' : 'vector'] * (lv.recall || 0.97) * A.found;
        if (c === 'vague' && !lv.rewrite) found *= VAGUE_RAW;
        g = found * (lv.rr ? TOP_RR : TOP[c]) * A.top;
      }
      const corr = lv.model ? g * (1 - P.fals) * ans : 0, dk = lv.model ? g * P.fals + (1 - g) * P.catch : 0;
      cls[c] = { g, corr, idk: dk, wrong: Math.max(0, 1 - corr - dk) };
      acc += mix[c] * corr; idk += mix[c] * dk; wrong += mix[c] * cls[c].wrong;
    });
    const nc = lv.model ? P.catch : 0;
    cls.none = { g: 0, corr: nc, idk: nc, wrong: 1 - nc };
    acc += mix.none * nc; idk += mix.none * nc; wrong += mix.none * (1 - nc);
    const leak = lv.rag && lv.model && lv.acl === 'none' ? foreign * (1 - idk) : 0;
    return { acc, idk, wrong, leak, cls, mix };
  }

  /* =====================================================================
     3. Симулятор: переранжировщик, переписывание вопроса, гибридный поиск, итоговое качество
     ===================================================================== */
  let AIX = null;
  const aiExt = () => AIX || (AIX = (SD.simExts || []).find(e => e && e.canHandle && e.route && e.isDead && e.capacity && e.state && e.collect && e.prepare && /ragActive/.test(String(e.prepare))) || null);
  const aiOf = L => Object.assign({ inTok: 800, outTok: 300, ragTok: 2500 }, L.ai || {});
  const tokOf = (ctx, n) => { const a = aiOf(ctx.level); return Math.min(n.props.maxOut || 512, a.outTok) + (a.inTok + (ctx.ragActive ? a.ragTok : 0)) * 0.08; };
  const FRONT = {
    canHandle(ctx, n, kind) { return n.type === 'rerank' ? kind === 'rrq' : undefined; },
    route(ctx, n, kind, r, H) {
      if (n.type === 'rerank') { r.u = 1; return true; }
      if (n.type !== 'app' || kind !== 'chat') return false;
      const rr = H.kids(ctx, n.id).find(k => k.type === 'rerank'), ai = aiExt();
      if (!rr || !ai) return false;
      const ok = ai.route(ctx, n, kind, r, H);
      const vs = r.fwd.find(f => f.kind === 'vsearch');
      if (ok && vs) { r.fwd.push({ to: rr.id, kind: 'rrq', f: vs.f, mode: 'seq' }); r.rerank = rr.id; }
      return ok;
    },
    isDead(ctx, n, H) {
      if (n.type !== 'rerank') return undefined;
      const d = H.down(ctx, n);
      return n.props.hosting === 'api' ? d > 0 : (n.props.gpus || 1) - d < 1;
    },
    capacity(ctx, n, H) {
      if (n.type === 'rerank') return n.props.hosting === 'api' ? 200 : Math.max(0, (n.props.gpus || 1) - H.down(ctx, n)) * RR.gpuQps;
      if (n.type === 'llm' && ctx.level.rag2 && n.props.rewrite) {
        const ai = aiExt(), c = ai && ai.capacity(ctx, n, H);
        if (c == null) return undefined;
        const tk = tokOf(ctx, n);
        return c * tk / (tk + RW.tok);
      }
      return undefined;
    },
    state(ctx, n, ld, cap, H) {
      if (n.type === 'rerank') {
        const u = ld.rrq || 0, util = cap ? u / cap : (u ? 9 : 0), api = n.props.hosting === 'api';
        return { util, lat: () => (api ? RR.apiMs : RR.selfMs * H.qf(util)), ok: () => util > 1 ? 1 / util : 1, info: { rerank: true } };
      }
      if (!ctx.level.rag2) return undefined;
      const ai = aiExt(); if (!ai) return undefined;
      if (n.type === 'vectordb' && (n.props.retrieval === 'hybrid' || n.props.acl === 'pre')) {
        const st = ai.state(ctx, n, ld, cap, H); if (!st) return undefined;
        const add = (n.props.retrieval === 'hybrid' ? 8 : 0) + (n.props.acl === 'pre' ? 2 : 0);
        return Object.assign({}, st, { lat: k => st.lat(k) + add });
      }
      if (n.type === 'llm' && n.props.rewrite) {
        const st = ai.state(ctx, n, ld, cap, H); if (!st || !st.info) return undefined;
        const m = SD.LLM_SIZES[n.props.size] || SD.LLM_SIZES.medium;
        const rw = RW.ttftK * st.info.ttft + RW.out / m.speed * 1000;
        return Object.assign({}, st, { lat: k => st.lat(k) + (k === 'chat' ? rw : 0), info: Object.assign({}, st.info, { rewriteMs: rw }) });
      }
      return undefined;
    }
  };
  function leversOf(ctx, res) {
    const ld = id => ctx.load.get(id) || {};
    const nodes = [...ctx.nodes.values()];
    const vdb = nodes.filter(n => n.type === 'vectordb' && (ld(n.id).vsearch || 0) > 0).sort((a, b) => (ld(b.id).vsearch || 0) - (ld(a.id).vsearch || 0))[0] || null;
    const llm = nodes.filter(n => n.type === 'llm' && (ld(n.id).chat || 0) > 0 && !(res.nodes[n.id] || {}).dead).sort((a, b) => (ld(b.id).chat || 0) - (ld(a.id).chat || 0))[0] || null;
    const rr = nodes.find(n => n.type === 'rerank' && (ld(n.id).rrq || 0) > 0 && !(res.nodes[n.id] || {}).dead) || null;
    return {
      rag: !!vdb, model: !!llm, vdb: vdb && vdb.id, llm: llm && llm.id, rrId: rr && rr.id, rr: !!rr, rrApi: !!(rr && rr.props.hosting === 'api'),
      hybrid: !!(vdb && vdb.props.retrieval === 'hybrid'), acl: (vdb && vdb.props.acl) || 'none', recall: vdb ? (RECALL[vdb.props.index] || 0.97) : 0,
      rewrite: !!(llm && llm.props.rewrite), idk: (llm && llm.props.idk) || 'off', size: (llm && llm.props.size) || 'medium', index: vdb ? vdb.props.index : null
    };
  }
  const BACK = {
    collect(ctx, res, level) {
      for (const n of ctx.nodes.values()) {
        if (n.type !== 'rerank' || n.props.hosting !== 'api' || !res.nodes[n.id]) continue;
        const q = (ctx.load.get(n.id) || {}).rrq || 0, v = MONTH * q * RR.apiUsd / 1000;
        res.nodes[n.id].cost += v; res.cost += v; if (res.ai) res.ai.tokenCost += v;
      }
      if (!level.rag2) return;
      const lv = leversOf(ctx, res);
      /* переписывание вопроса у модели через API — это ещё и токены */
      const llm = lv.llm && ctx.nodes.get(lv.llm);
      if (llm && lv.rewrite && llm.props.hosting === 'api' && res.nodes[llm.id]) {
        const m = SD.LLM_SIZES[llm.props.size] || SD.LLM_SIZES.medium, q = (ctx.load.get(llm.id) || {}).chat || 0;
        const v = MONTH * q * (RW.inTok * m.pIn * (llm.props.pcache ? 0.37 : 1) + RW.out * m.pOut) / 1e6;
        res.nodes[llm.id].cost += v; res.cost += v; if (res.ai) res.ai.tokenCost += v;
      }
      const q = ragQuality(lv, level.rag2);
      const chat = (level.traffic.chat || 0) * (res.mul || 1);
      res.rag2 = Object.assign(q, { levers: lv, perDay: chat * 86400, leakDay: q.leak * chat * 86400, per1k: chat ? res.cost / (chat * MONTH) * 1000 : 0 });
      if (res.ai) res.ai.quality = lv.model ? q.acc : null;
    }
  };
  SD.simExts = SD.simExts || [];
  if (!SD.simExts.includes(FRONT)) { SD.simExts.unshift(FRONT); SD.simExts.push(BACK); }

  /* =====================================================================
     4. Наблюдаемость: датчики на схеме, когда заметим тихое обновление, учебный сбой
     ===================================================================== */
  const OB = { upd: 62, H: 240, acc0: 0.88, acc1: 0.79, thrE: 0.84, gr0: 0.9, gr1: 0.78, thrL: 0.85, complaints: 144, dash: 60, rps: 1 };
  const ZE = [0.4, -1.25, 0.8, -0.3, 0.6, -0.9, 1.1, -0.5, 0.2, -1.4, 0.9, 0.1, -0.7, 1.3, -0.2, 0.5, -1.1, 0.7, -0.6, 0.3];   // разброс ночных прогонов
  const ZL = [0.5, -0.8, 0.3, 0.6, 0.6, -0.2, 0.9, -0.6, 0.1, 0.4, -0.3];                                                 // разброс разметки по дням
  const sigma = (p, n) => Math.sqrt(p * (1 - p) / Math.max(1, n));
  const PHI = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  const nextAt = (t, h) => { const d = Math.floor(t / 24); let x = d * 24 + h; if (x < t) x += 24; return x; };
  const clock = t => `день ${Math.floor(t / 24) + 1}, ${String(Math.floor(t % 24)).padStart(2, '0')}:${String(Math.round((t % 1) * 60) % 60).padStart(2, '0')}`;
  const isNight = t => (t % 24) < 8;

  function obsState(g) {
    const by = id => g.nodes.find(n => n.id === id);
    const link = (a, b) => !!a && !!b && g.edges.some(e => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
    const ofType = t => g.nodes.filter(n => n.type === t);
    const apps = g.nodes.filter(n => n.type === 'app' && g.edges.some(e => e.from === n.id && ['llm', 'router', 'agent'].includes((by(e.to) || {}).type)));
    const proms = ofType('prometheus'), grafs = ofType('grafana'), ams = ofType('alertmanager');
    const promDash = p => grafs.some(gf => link(p, gf));
    const amOf = p => ams.find(a => link(p, a));
    const linkedApp = s => apps.some(a => link(s, a));
    const toProm = s => proms.find(p => link(s, p)) || null;
    const lt = ofType('llmtrace').find(linkedApp) || null;
    const ltAny = ofType('llmtrace')[0] || null;
    const dashAI = !!lt && (grafs.some(gf => link(lt, gf)) || proms.some(p => link(lt, p) && promDash(p)));
    const ev = ofType('evals').find(linkedApp) || null, evAny = ofType('evals')[0] || null;
    const evProm = ev && toProm(ev), evAm = evProm && amOf(evProm);
    const lb = ofType('labeling').find(linkedApp) || null, lbAny = ofType('labeling')[0] || null;
    const lbProm = lb && toProm(lb), lbAm = lbProm && amOf(lbProm);
    return { apps, lt, ltAny, dashAI, ev, evAny, evProm, evAm, lb, lbAny, lbProm, lbAm, proms, grafs, promDash };
  }
  /* когда о чтении датчика узнает человек */
  function notify(s, t, prom, am) {
    if (prom && am) { const ch = am.props.channel || 'phone'; return { t: ch === 'phone' ? t + 0.1 : ch === 'chat' ? (isNight(t) ? nextAt(t, 9) : t + 0.5) : nextAt(t, 10), how: ch === 'phone' ? 'звонок дежурному' : ch === 'chat' ? 'сообщение в чат команды' : 'письмо на почту' }; }
    if (prom && s.promDash(prom)) return { t: nextAt(t, 10), how: 'увидели на утренней планёрке по графику' };
    return { t: nextAt(t, 10) + 48, how: 'отчёт открыли через пару дней' };
  }
  function detect(g) {
    const s = obsState(g), list = [], fa = [];
    list.push({ by: 'complaints', t: OB.upd + OB.complaints, src: 'жалобы клиентов в поддержку', how: 'руководитель поддержки сложил жалобы за неделю' });
    if (s.dashAI) list.push({ by: 'dash', t: nextAt(OB.upd + OB.dash, 10), src: 'ИИ-метрики на панели', how: 'на планёрке заметили, что 👎 и передачи человеку третий день выше обычного' });
    const runs = [], labs = [];
    if (s.ev) {
      const n = +s.ev.props.size || 300, sg = sigma(OB.acc0, n), when = s.ev.props.when || 'release';
      const times = when === 'hourly' ? Array.from({ length: OB.H }, (_, i) => i + 0.25) : when === 'nightly' ? Array.from({ length: 10 }, (_, d) => d * 24 + 3.5) : [];
      let seed = 7;
      const gz = () => { seed = (seed * 16807) % 2147483647; const u = seed / 2147483647; seed = (seed * 16807) % 2147483647; const v = seed / 2147483647; return Math.sqrt(-2 * Math.log(u + 1e-9)) * Math.cos(2 * Math.PI * v); };
      times.forEach((t, i) => {
        const trueV = t - 0.5 < OB.upd ? OB.acc0 : OB.acc1, z = when === 'nightly' ? ZE[i % ZE.length] : Math.max(-2.6, Math.min(2.6, gz()));
        const v = trueV + sg * z, alarm = v < OB.thrE;
        runs.push({ t, v, alarm, bad: trueV < OB.acc0, sg });
        if (alarm && trueV >= OB.acc0) fa.push({ t, v, src: 'прогон эталонов' });
      });
      const hit = runs.find(r => r.bad && r.alarm);
      if (hit) { const nt = notify(s, hit.t, s.evProm, s.evAm); list.push({ by: 'evals', t: nt.t, src: 'прогон эталонов', how: `${pc(hit.v)} верных при норме ${pc(OB.acc0)} — ${nt.how}`, run: hit }); }
    }
    if (s.lb) {
      const n = +s.lb.props.perDay || 50;
      for (let d = 1; d <= 9; d++) {
        const t = d * 24 + 12, a = (d - 1) * 24, b = d * 24, f = Math.max(0, Math.min(1, (b - Math.max(a, OB.upd)) / (b - a)));
        const trueV = OB.gr0 - (OB.gr0 - OB.gr1) * f, sg = sigma(trueV, n), v = trueV + sg * ZL[d % ZL.length], alarm = v < OB.thrL;
        labs.push({ t, v, alarm, bad: f > 0, sg, f });
        if (alarm && f === 0) fa.push({ t, v, src: 'разметка' });
      }
      const hit = labs.find(r => r.bad && r.alarm);
      if (hit) { const nt = notify(s, hit.t, s.lbProm, s.lbAm); list.push({ by: 'labels', t: nt.t, src: 'выборочная разметка', how: `опора на источник ${pc(hit.v)} при норме ${pc(OB.gr0)} — ${nt.how}`, run: hit }); }
    }
    list.sort((a, b) => a.t - b.t);
    const first = list[0];
    /* ложные тревоги в месяц: сколько раз шум опустит замер ниже порога и разбудит людей */
    let fpmE = 0, fpmL = 0;
    if (s.ev && s.evProm && s.evAm) fpmE = (EVAL_RUNS[s.ev.props.when] || 0) * PHI((OB.thrE - OB.acc0) / sigma(OB.acc0, +s.ev.props.size || 300));
    if (s.lb && s.lbProm && s.lbAm) fpmL = 30 * PHI((OB.thrL - OB.gr0) / sigma(OB.gr0, +s.lb.props.perDay || 50));
    const fpm = fpmE + fpmL;
    const half = s.lb ? 1.96 * sigma(OB.gr0, +s.lb.props.perDay || 50) : null;
    return { s, list, first, mttd: first.t - OB.upd, fpm, fpmE, fpmL, runs, labs, fa, half };
  }

  /* 10 дней по часам: что рисуют графики */
  function timeline(g) {
    const D = detect(g), fix = D.first.t + 1, s = D.s;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const day = t => 0.75 + 0.5 * Math.max(0, Math.sin((t % 24 - 6) / 24 * 2 * Math.PI));
    const ramp = (t, h) => t < OB.upd || t >= fix ? 0 : Math.min(1, (t - OB.upd) / h);
    const bad = t => t >= OB.upd && t < fix;
    const S = { err: [], p95: [], idk: [], hand: [], cite: [], cost: [], tok: [], thumbs: [], rps: [] };
    for (let t = 0; t <= OB.H; t++) {
      const b = bad(t) ? 1 : 0, r1 = ramp(t, 24), r2 = ramp(t, 36);
      S.rps.push(OB.rps * day(t));
      S.err.push(0.002 + 0.0008 * rnd());
      S.p95.push((b ? 1150 : 1350) * (1 + 0.04 * rnd()) * (0.9 + 0.15 * day(t)));
      S.idk.push((b ? 0.055 : 0.07) + 0.006 * rnd());
      S.hand.push(0.05 + 0.018 * r1 + 0.004 * rnd());
      S.cite.push(0.96 - 0.004 * b + 0.004 * rnd());
      S.cost.push((b ? 0.0064 : 0.0082) * (1 + 0.03 * rnd()));
      S.tok.push((b ? 3150 : 3400) * (1 + 0.02 * rnd()));
      S.thumbs.push(0.02 + 0.013 * r2 + 0.003 * rnd());
    }
    const badAnswers = OB.rps * 3600 * Math.max(0, D.first.t - OB.upd) * (OB.acc0 - OB.acc1);
    return { D, S, fix, badAnswers };
  }

  /* =====================================================================
     5. Уровни
     ===================================================================== */
  const C = (x = 40, y = 250) => ['client', 'client', x, y];
  const custom = (text, fn) => ({ t: 'custom', text, fn });
  const ragOf = res => res && res.rag2;
  const RAG_CFG = { mix: MIX, foreign: 0.05 };

  const RN = (vdb, rr, llm) => [['lb', 'lb', 200, 250], ['app', 'app', 400, 250, { count: 2 }, 'Ассистент'], ['emb', 'embed', 640, 110, { hosting: 'api' }],
    ['vdb', 'vectordb', 640, 250, Object.assign({ index: 'hnsw', retrieval: 'vector', acl: 'none' }, vdb), 'Документы и каталог'],
    ['llm', 'llm', 640, 420, Object.assign({ hosting: 'self', size: 'medium', gpus: 4, pcache: true, rewrite: false, idk: 'off' }, llm), 'Модель · свои GPU']].concat(rr ? [['rr', 'rerank', 880, 250, rr]] : []);
  const RE = rr => [['client', 'lb'], ['lb', 'app'], ['app', 'emb'], ['app', 'vdb'], ['app', 'llm']].concat(rr ? [['app', 'rr']] : []);

  const L_RAG = {
    id: 'ragfix', tier: 'ai', title: 'Ассистент находит не то',
    chips: ['гибридный поиск', 'переранжирование', 'права до поиска', '«не знаю»'],
    story: 'Библиотекарь, который ищет только «по смыслу», на просьбу «ПФ-2610-М» принесёт ПФ-2016-М — похоже же. А без читательского билета выдаст и чужую папку. Сеть магазинов инструментов «Мастерская» запустила ассистента для 300 магазинов-партнёров: 2 вопроса в секунду (≈ 5 млн в месяц) о 40 000 товаров, инструкциях и договорах. Через месяц — жалобы: путает коды товаров, отвечает по старым инструкциям, на «а та, что подешевле?» несёт чушь, уверенно выдумывает то, чего в базе нет, а один партнёр увидел закупочные цены другого. Почини поиск и ответы, не выходя из задержки и бюджета.',
    traffic: { chat: 2 },
    ai: { inTok: 600, outTok: 250, ragTok: 2500, factual: true, corpusM: 1.2, repeat: 0.2 },
    rag2: RAG_CFG,
    features: ['rag2'],
    allow: ['lb', 'gateway', 'app', 'sql', 'cache', 'queue', 'worker', 'llm', 'router', 'semcache', 'guard', 'embed', 'vectordb', 'rerank'],
    preset: [C()],
    start: { nodes: RN({}, null, {}), edges: RE(false) },
    goals: [
      { t: 'success', min: 0.99 },
      custom('Верных ответов не меньше 85 %', (g, res) => { const q = ragOf(res); return !q ? { ok: false, detail: 'ассистент не отвечает' } : { ok: q.acc >= 0.85, detail: `сейчас ${pc(q.acc)}; мимо ${pc(q.wrong)}, «не знаю» ${pc(q.idk)}` }; }),
      custom('Чужие документы в ответах: ни одного', (g, res) => { const q = ragOf(res); return !q ? { ok: false, detail: 'ассистент не отвечает' } : q.leak > 0 ? { ok: false, detail: `≈ ${num(q.leakDay)} ответов в сутки опираются на чужие договоры и цены` } : { ok: true, detail: q.levers.rag ? (q.levers.acl === 'pre' ? 'фильтр по партнёру до поиска' : 'чужое отбрасывается после поиска') : 'поиска по документам нет' }; }),
      custom('Честное «не знаю» — не чаще чем в 20 % вопросов', (g, res) => { const q = ragOf(res); return !q || !q.levers.model ? { ok: false, detail: 'ассистент не отвечает' } : { ok: q.idk <= 0.2, detail: `сейчас ${pc(q.idk)}${q.idk <= 0.2 ? '' : q.levers.idk === 'strict' ? ' — порог слишком строгий, ассистент отказывает и там, где ответ есть' : ' — поиск часто не находит нужного, и модель честно отказывает'}` }; }),
      { t: 'latency', kind: 'chat', max: 2000 },
      { t: 'cost', max: 12000 }
    ],
    stretch: { cost: 11000 },
    decisions: [
      { q: 'Почему поиск по смыслу путает ПФ-2610-М и ПФ-2016-М?', opts: [
        { t: 'Вектор ловит смысл, а не точные символы: для него два кода почти одинаковы. Точные коды находит поиск по словам — гибридный поиск складывает оба списка', v: 'right', fb: 'Так и есть. Коды, артикулы, номера договоров, фамилии — территория поиска по словам (BM25). Смысловой хорош для «как вернуть товар».' },
        { t: 'Мало узлов в векторной БД', v: 'wrong', fb: 'Узлы дают скорость, а не точность. Поиск найдёт быстро — но не то.' },
        { t: 'Нужна модель побольше', v: 'partial', fb: 'Модель отвечает по тому, что ей нашли. Найден чужой товар — любая модель уверенно расскажет про него.' }
      ] },
      { q: 'Где проверять права партнёра на документы?', opts: [
        { t: 'В самом запросе к индексу: искать только среди документов этого партнёра', v: 'right', fb: 'Фильтр до поиска: чужие куски не попадают ни в выдачу, ни в подсказку модели, а нужные не вытесняются чужими.' },
        { t: 'После поиска выкинуть чужие куски', v: 'partial', fb: 'Утечки нет, но из 50 найденных большая часть чужие — после фильтра нужного документа часто не остаётся, и ассистент отвечает «не знаю».' },
        { t: 'Написать в подсказке модели «не показывай чужие данные»', v: 'wrong', fb: 'Подсказка — не граница безопасности: модель уже прочитала чужой договор, и один хитрый вопрос его достанет.' }
      ] },
      { q: 'Зачем ассистенту честное «не знаю»?', opts: [
        { t: 'Уверенная выдумка хуже отказа: при слабой опоре лучше сказать «не нашёл» и позвать человека. Но слишком строгий порог превращает ассистента в автоответчик', v: 'right', fb: 'Порог — компромисс между выдумками и отказами. Его подбирают по разметке реальных диалогов.' },
        { t: 'Чтобы реже вызывать модель и экономить', v: 'wrong', fb: 'Модель вызывается всё равно — она и решает, хватает ли опоры. Смысл в честности ответа, а не в экономии.' }
      ] }
    ],
    hints: [
      { text: 'Нажми на «Документы и каталог» (векторная БД): «Как искать» — гибридно, «Права на документы» — до поиска.', why: 'Коды товаров находит поиск по словам, а фильтр по партнёру в самом запросе к индексу не пускает чужое ни в выдачу, ни в подсказку модели.' },
      { text: 'Поставь «Переранжировщик» из группы «AI и нейросети» и соедини Ассистент → Переранжировщик. Работает на своём GPU.', why: 'Из 50 найденных кусков он внимательно перечитывает каждый вместе с вопросом и ставит лучшие наверх: новая инструкция обгоняет старую. Через API при 5 млн вопросов в месяц вышло бы ≈ $5 300 — свой GPU дешевле.' },
      { text: 'Нажми на модель: включи «Переписывать вопрос» и выбери «Честно «не знаю» — мягкий порог».', why: 'Переписывание делает из «а та, что подешевле?» полный вопрос. «Не знаю» вместо выдумки там, где в базе ответа нет. Строгий порог отказывает слишком часто.' },
      { text: 'Нажми «Разобрать жалобы партнёров» в задании — увидишь путь каждого вопроса через твою схему.', why: 'Каждая жалоба — про свой рычаг: так видно, что именно чинит каждая настройка.' }
    ],
    solution: {
      nodes: RN({ retrieval: 'hybrid', acl: 'pre' }, { hosting: 'self', gpus: 1 }, { rewrite: true, idk: 'soft' }), edges: RE(true),
      note: 'Гибридный поиск (слова + смысл) с фильтром по партнёру до поиска, переранжировщик на своём GPU, переписывание вопроса и честное «не знаю» с мягким порогом. Верных ≈ 87 %, чужих документов ноль, до первого слова ≈ 1,5 с.'
    }
  };

  const ON = [['lb', 'lb', 200, 230], ['app', 'app', 400, 230, { count: 2 }, 'Ассистент'], ['emb', 'embed', 640, 90, { hosting: 'api' }], ['vdb', 'vectordb', 640, 220, { index: 'hnsw' }, 'База знаний'],
    ['llm', 'llm', 640, 350, { hosting: 'api', size: 'medium', tier: 'pro', pcache: true }, 'Модель · облачный API'],
    ['prom', 'prometheus', 400, 470, {}, 'Prometheus'], ['graf', 'grafana', 640, 520, {}, 'Grafana'], ['am', 'alertmanager', 400, 600, { channel: 'phone' }, 'Alertmanager']];
  const OE = [['client', 'lb'], ['lb', 'app'], ['app', 'emb'], ['app', 'vdb'], ['app', 'llm'], ['app', 'prom'], ['prom', 'graf'], ['prom', 'am']];
  const OBS_SENS = [['lt', 'llmtrace', 880, 330, { retention: 30 }, 'LLM-трассы'], ['ev', 'evals', 160, 470, { when: 'nightly', size: 300 }, 'Прогон эталонов'], ['lab', 'labeling', 880, 470, { perDay: 200 }, 'Выборочная разметка']];
  const OBS_E = [['app', 'lt'], ['lt', 'graf'], ['ev', 'app'], ['ev', 'prom'], ['app', 'lab'], ['lab', 'prom']];
  const L_OBS = {
    id: 'aiobs', tier: 'ai', title: 'Наблюдаемость ассистента',
    chips: ['ИИ-метрики', 'прогон эталонов', 'выборочная разметка', 'тихое обновление модели'],
    story: 'Повар пробует блюдо до подачи, а не ждёт отзывов на сайте. Ассистент поддержки маркетплейса отвечает раз в секунду (≈ 2,6 млн вопросов в месяц) через облачную модель. На дашборде — ошибки, задержка, нагрузка: всё зелёное. В прошлом месяце поставщик тихо обновил модель под тем же именем: ошибок ноль, отвечать стала даже быстрее и дешевле — но перестала опираться на документы. Узнали через 6 дней из жалоб. Поставь датчики, которые ловят такое за сутки: ИИ-метрики на панели, ночной прогон эталонов и выборочную разметку живых диалогов — и проверь учебным сбоем.',
    traffic: { chat: 1 },
    ai: { inTok: 700, outTok: 300, ragTok: 2000, factual: true, corpusM: 0.5, repeat: 0.2 },
    features: ['aiobs'],
    allow: ['lb', 'gateway', 'app', 'sql', 'cache', 'llm', 'router', 'semcache', 'guard', 'embed', 'vectordb'],
    preset: [C()],
    start: { nodes: ON, edges: OE },
    goals: [
      { t: 'success', min: 0.99 },
      { t: 'latency', kind: 'chat', max: 1500 },
      custom('На панели — ИИ-метрики: «не знаю», передачи человеку, ссылки на источник, цена ответа, токены, жалобы', g => {
        const s = obsState(g);
        return s.dashAI ? { ok: true, detail: 'LLM-трассы → Grafana' } : { ok: false, detail: s.lt ? 'трассы пишутся, но на панель не выведены: соедини LLM-трассы с Grafana' : s.ltAny ? 'LLM-трассы не подключены к ассистенту' : 'на панели только технические метрики: поставь LLM-трассы' };
      }),
      custom('Тихое обновление модели замечаем за сутки — и не будим дежурного зря', g => {
        const D = detect(g), ok = D.mttd <= 24 && D.fpm <= 1;
        return { ok, detail: `заметим через ≈ ${hrs(D.mttd)} (${D.first.src})${D.fpm > 1 ? ` · ложных тревог ≈ ${dec(D.fpm, 0)} в месяц — ${D.fpmE >= D.fpmL ? 'эталонов мало или прогоны слишком часты: шум похож на беду' : 'разметка маленькой выборки шумит'}` : D.fpm > 0.05 ? ` · ложных тревог ≈ ${dec(D.fpm, 1)} в месяц` : ''}` };
      }),
      custom('Опору на источник в живых диалогах меряем каждый день точнее ±5 п. п.', g => {
        const D = detect(g), s = D.s;
        if (!s.lb) return { ok: false, detail: s.lbAny ? 'разметка не получает диалоги ассистента' : 'живые диалоги никто не оценивает' };
        if (!s.lbProm) return { ok: false, detail: 'оценки не попадают в метрики: соедини разметку с Prometheus' };
        return { ok: D.half <= 0.05, detail: `${s.lb.props.perDay} диалогов в день — погрешность ±${dec(D.half * 100, 1)} п. п.` };
      }),
      { t: 'cost', max: 25800 }
    ],
    stretch: { cost: 25000 },
    decisions: [
      { q: 'Почему обычный мониторинг не заметил подмену модели?', opts: [
        { t: 'Ошибки и задержка меряют, отвечает ли система, а не верно ли она отвечает. Новая модель отвечала быстро и без ошибок — просто хуже', v: 'right', fb: 'Для ИИ нужен второй слой метрик — про смысл ответов: прогон эталонов, разметка, доля «не знаю», жалобы.' },
        { t: 'Prometheus опрашивал сервис слишком редко', v: 'wrong', fb: 'Опрашивай хоть каждую секунду — ошибок не было. Метрика «верно ли ответил» в Prometheus сама не появится.' }
      ] },
      { q: 'Как защититься от тихих обновлений поставщика?', opts: [
        { t: 'Закрепить версию модели (снимок с датой, а не «latest»), переходить на новую через прогон эталонов и канарейку — и всё равно гонять эталоны каждую ночь', v: 'right', fb: 'Закреплённая версия убирает сюрпризы поставщика, а ночной прогон ловит всё остальное: переиндексацию, новую подсказку, сдвиг вопросов.' },
        { t: 'Перейти на свои GPU', v: 'partial', fb: 'От подмен поставщиком спасёт, но качество может поплыть и само: новый индекс, новая подсказка, новые темы вопросов. Датчики нужны всё равно.' },
        { t: 'Внимательнее смотреть на дашборд', v: 'wrong', fb: 'Технические графики были зелёными. Смотреть надо на другие метрики — и лучше, чтобы смотрел алерт, а не человек.' }
      ] },
      { q: 'Зачем выборочная разметка, если есть эталоны?', opts: [
        { t: 'Эталоны проверяют известные вопросы, а живые меняются: новые товары, акции, сезон. Разметка — честный замер на реальном трафике, из неё же пополняют эталоны', v: 'right', fb: 'Эталоны — быстрый датчик, разметка — точный. Вместе они ловят и внезапное падение, и медленный дрейф.' },
        { t: 'Не нужна: эталонов достаточно', v: 'wrong', fb: 'Набор эталонов стареет. Через полгода он проверяет вопросы, которые никто уже не задаёт.' }
      ] }
    ],
    hints: [
      { text: 'Палитра → «Инструменты эксплуатации» → «LLM-трассы». Стрелки: Ассистент → LLM-трассы → Grafana.', why: 'Каждый вызов модели — трасса: вопрос, найденные документы, версия модели, токены, цена, исход и 👍/👎. Из трасс Grafana рисует ИИ-метрики.' },
      { text: 'Поставь «Прогон эталонов»: «Когда прогонять» — каждую ночь. Стрелки: Прогон эталонов → Ассистент и Прогон эталонов → Prometheus.', why: 'Контрольная закупка каждую ночь: упала доля верных — Prometheus через Alertmanager позвонит дежурному. «Только при релизах» не годится: обновление было у поставщика, а не у нас.' },
      { text: 'Поставь «Выборочную разметку» на 200 диалогов в день: Ассистент → Разметка → Prometheus.', why: '50 диалогов в день — погрешность ±8 п. п., падение не отличить от шума. 1 000 — точно, но $15 000 в месяц.' },
      { text: 'Нажми «Учебный сбой» в задании и посмотри 10 дней на графиках: кто и когда заметит подмену.', why: 'Без датчиков — по жалобам через 6 дней. С ночным прогоном — к утру.' }
    ],
    solution: {
      nodes: ON.concat(OBS_SENS), edges: OE.concat(OBS_E),
      note: 'LLM-трассы выводят ИИ-метрики в Grafana; ночной прогон 300 эталонов пишет долю верных в Prometheus — при падении Alertmanager звонит дежурному (≈ 14 ч после подмены); разметка 200 живых диалогов в день меряет опору на источник с погрешностью ±4 п. п.'
    }
  };

  if (!SD.LEVELS.some(l => l.id === 'ragfix')) {
    const i = SD.LEVELS.findIndex(l => l.id === 'support');
    SD.LEVELS.splice(i >= 0 ? i + 1 : SD.LEVELS.length, 0, L_RAG, L_OBS);
  }
  const tier = (SD.TIERS || []).find(t => t.id === 'ai');
  if (tier && !/наблюдаем/.test(tier.note)) tier.note += ', качество поиска, наблюдаемость';
  if (SD.SANDBOX && SD.SANDBOX.allow && !SD.SANDBOX.allow.includes('rerank')) SD.SANDBOX.allow.push('rerank');

  /* =====================================================================
     6. Советы прораба
     ===================================================================== */
  function aiqAdvice(level, graph, res) {
    const A = [], q = res && res.rag2;
    if (q && q.levers.model) {
      const lv = q.levers, v = lv.vdb, m = lv.llm;
      if (!lv.rag) A.push({ sev: 'bad', node: m, text: 'Ассистент отвечает без поиска по документам: модель не знает каталога и договоров «Мастерской» и угадывает. Подключи Ассистент → Эмбеддинги и Ассистент → Векторная БД.', dive: 'rag' });
      else {
        if (!lv.hybrid) A.push({ sev: 'warn', node: v, text: `Вопросы с кодами товаров (${pc(MIX.codes)} всех) находят нужный документ только в ${pc(q.cls.codes.g)} случаев: смысловой поиск путает похожие коды. «Как искать» → гибридно.`, dive: 'rag' });
        if (lv.acl === 'none') A.push({ sev: 'bad', node: v, text: `≈ ${num(q.leakDay)} ответов в сутки опираются на чужие договоры и цены. «Права на документы» → до поиска.` });
        if (lv.acl === 'post') A.push({ sev: 'warn', node: v, text: 'Фильтр после поиска не пускает чужое, но выкидывает до 18 % нужных документов вместе с чужими. Поставь фильтр до поиска.' });
        if (!lv.rr) A.push({ sev: 'info', node: v, text: 'Нужный кусок часто находится, но не попадает в пятёрку для модели: похожая старая инструкция обгоняет новую. Поставь переранжировщик: Ассистент → Переранжировщик.' });
        if (lv.rrApi) A.push({ sev: 'info', node: lv.rrId, text: `Переранжировщик через API стоит ≈ ${usd(MONTH * (level.traffic.chat || 0) * RR.apiUsd / 1000)} в месяц. Свой GPU — ${usd(SD.GPU_COST || 1900)}.` });
      }
      if (!lv.rewrite) A.push({ sev: 'info', node: m, text: `Расплывчатые вопросы («а для той, что подешевле?») находят нужное лишь в ${pc(q.cls.vague.g)} случаев. Включи у модели «Переписывать вопрос перед поиском».` });
      if (lv.idk === 'off') A.push({ sev: 'warn', node: m, text: `Когда ответа в базе нет, модель выдумывает в ${pc(1 - IDK.off.catch)} случаев. Включи честное «не знаю» с мягким порогом.` });
      if (lv.idk === 'strict' && q.idk > 0.2) A.push({ sev: 'warn', node: m, text: `Строгий порог: «не знаю» в ${pc(q.idk)} вопросов — отказы и там, где ответ был. Возьми мягкий.` });
    }
    if (level && level.id === 'aiobs') {
      const D = detect(graph), s = D.s;
      if (!s.ltAny) A.push({ sev: 'warn', node: null, text: 'Технические метрики не скажут, верно ли отвечает ассистент. Поставь LLM-трассы и выведи их в Grafana.' });
      if (s.evAny && !s.ev) A.push({ sev: 'warn', node: s.evAny.id, text: 'Прогону эталонов не через кого задавать вопросы: соедини Прогон эталонов → Ассистент.' });
      if (s.ev && (s.ev.props.when || 'release') === 'release') A.push({ sev: 'warn', node: s.ev.id, text: 'Эталоны гоняются только при наших релизах, а обновление было у поставщика. Поставь «Каждую ночь».' });
      if (s.ev && !s.evProm) A.push({ sev: 'info', node: s.ev.id, text: 'Результат прогона никуда не пишется: соедини Прогон эталонов → Prometheus, чтобы сработал алерт.' });
      if (s.lbAny && !s.lb) A.push({ sev: 'warn', node: s.lbAny.id, text: 'Разметке нечего размечать: соедини Ассистент → Выборочная разметка.' });
      if (D.fpm > 1) A.push({ sev: 'warn', node: s.ev ? s.ev.id : null, text: `Ложных тревог ≈ ${dec(D.fpm, 0)} в месяц: маленький набор или слишком частые прогоны шумят. Возьми 300 вопросов раз в ночь.` });
    }
    return A;
  }
  const baseAdvise = SD.sim.advise;
  if (baseAdvise && !baseAdvise.__aq) {
    SD.sim.advise = function (level, graph, res) {
      const A = baseAdvise.apply(this, arguments) || [];
      try { aiqAdvice(level, graph, res).forEach(a => A.push(a)); } catch (e) { /* без советов по ИИ-качеству */ }
      return A;
    };
    SD.sim.advise.__aq = true;
  }

  /* лаборатория «Выкладка вживую» грузится по требованию (js/labs-lazy.js): открыть сразу на вкладке «Версия модели»
     можно и до её загрузки — флаг SD.labDeployTab читает сама лаборатория при сборке */
  if (!SD.labDeploy) SD.labDeploy = { open(tab) { SD.labDeployTab = tab || null; if (SD.labs) return SD.labs.open('deploy'); } };
  SD.aiq = { ragQuality, leversOf, obsState, detect, timeline, MIX, OB, levels: [L_RAG, L_OBS] };

  /* =====================================================================
     7. Интерфейс: карточка в задании, разбор жалоб, учебный сбой
     ===================================================================== */
  if (!HAS_DOM) return;
  const $ = id => document.getElementById(id);
  const A = () => SD.app && SD.app.A;

  /* ---------- карточка в задании ---------- */
  const tile = (l, v, sub, cls) => `<div class="aq-tile ${cls || ''}"><span>${l}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  function ragCard() {
    const S = A(), q = S && S.res1 && S.res1.rag2;
    let h = `<div class="aq-pulse"><div class="aq-ph"><b>Пульс ассистента</b><small>симулятор по твоей схеме, ${q ? num(q.perDay) : '—'} вопросов в сутки</small></div>`;
    if (q && q.levers.model) {
      const lat = S.res1.kinds.chat ? S.res1.kinds.chat.lat : 0;
      h += `<div class="aq-tiles">${tile('Верных ответов', pc(q.acc), 'цель ≥ 85 %', q.acc >= 0.85 ? 'ok' : 'bad')}${tile('Честное «не знаю»', pc(q.idk), 'не больше 20 %', q.idk <= 0.2 ? 'ok' : 'bad')}${tile('Чужие документы', q.leak > 0 ? '≈ ' + num(q.leakDay) : '0', q.leak > 0 ? 'ответов в сутки' : 'утечек нет', q.leak > 0 ? 'bad' : 'ok')}${tile('До первого слова', SD.fmt.ms(lat), 'цель ≤ 2 с', lat <= 2000 ? 'ok' : 'bad')}${tile('1 000 ответов', '$' + dec(q.per1k, 2), 'вся инфраструктура', '')}</div>`;
    } else h += '<p class="aq-mut">Модель пока не отвечает: собери Ассистент → Эмбеддинги, Векторная БД и LLM.</p>';
    h += `<button type="button" class="dive-cta" data-aiq="complaints">${SD.icon('vectordb')}<span><b>Разобрать жалобы партнёров</b><small>5 жалоб: путь каждого вопроса через твою схему — что нашлось, что отфильтровалось, что ответила модель</small></span></button></div>`;
    return h;
  }
  function obsCard() {
    const S = A(); if (!S) return '';
    const D = detect(S.graph), s = D.s;
    const row = (ok, t, sub) => `<li class="${ok ? 'ok' : ''}"><span class="st">${ok ? '✓' : '·'}</span><span><b>${t}</b><small>${sub}</small></span></li>`;
    let h = `<div class="aq-pulse"><div class="aq-ph"><b>Датчики качества</b><small>что увидит команда, если модель станет хуже</small></div><ul class="aq-sens">`;
    h += row(s.dashAI, 'ИИ-метрики на панели', s.dashAI ? '«не знаю», передачи человеку, ссылки, цена, токены, 👎' : 'только ошибки и задержка');
    h += row(!!(s.ev && s.ev.props.when !== 'release' && s.evProm), 'Прогон эталонов', s.ev ? `${({ release: 'только при релизах', nightly: 'каждую ночь', hourly: 'каждый час' })[s.ev.props.when || 'release']}, ${s.ev.props.size} вопросов${s.evProm ? (s.evAm ? ', алерт' : ', на графике') : ', в метрики не пишется'}` : 'нет');
    h += row(!!(s.lb && s.lbProm && D.half <= 0.05), 'Разметка живых диалогов', s.lb ? `${s.lb.props.perDay} в день, ±${dec(D.half * 100, 1)} п. п.${s.lbProm ? '' : ', в метрики не пишется'}` : 'нет');
    h += `</ul><div class="aq-tiles">${tile('Подмену заметим', '≈ ' + hrs(D.mttd), D.first.src, D.mttd <= 24 ? 'ok' : 'bad')}${tile('Ложных тревог', D.fpm < 0.05 ? '≈ 0' : '≈ ' + dec(D.fpm, D.fpm < 10 ? 1 : 0), 'в месяц', D.fpm <= 1 ? 'ok' : 'bad')}</div>`;
    h += `<button type="button" class="dive-cta" data-aiq="drill">${SD.icon('grafana')}<span><b>Учебный сбой: поставщик тихо обновил модель</b><small>10 дней на графиках твоей схемы: что видит обычный мониторинг, что — ИИ-датчики, и кто заметит первым</small></span></button></div>`;
    return h;
  }
  const prevCta = SD.dataTaskCta;
  SD.dataTaskCta = L => (L && L.id === 'ragfix' ? ragCard() : L && L.id === 'aiobs' ? obsCard() : '') + (prevCta ? prevCta(L) : '');

  /* ---------- окно ---------- */
  let cur = null;
  function modal() {
    let m = $('aqModal');
    if (m) return m;
    m = document.createElement('div'); m.className = 'modal'; m.id = 'aqModal'; m.hidden = true;
    m.innerHTML = '<div class="sheet aq-sheet" role="dialog" aria-modal="true" aria-labelledby="aqTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0" id="aqEye">ИИ-ассистент</span><h2 id="aqTitle">…</h2><button class="btn ghost x" type="button" data-aqx>Закрыть</button></div><div class="sheet-body aq-body" id="aqBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-aqx]')) { close(); return; }
      const sel = e.target.closest('[data-aqsel]');
      if (sel) { close(); const n = A().graph.nodes.find(x => x.id === sel.dataset.aqsel); if (n && SD.editor && SD.editor.select) SD.editor.select({ type: 'node', id: n.id }); return; }
      const pl = e.target.closest('[data-aqplay]'); if (pl) { play(); return; }
      const jm = e.target.closest('[data-aqt]'); if (jm) { stopPlay(); drillAt(+jm.dataset.aqt); }
    });
    m.addEventListener('input', e => { if (e.target.id === 'aqT') { stopPlay(); drillAt(+e.target.value); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) close(); });
    window.addEventListener('resize', () => { if (!m.hidden && cur === 'drill') drillAt(DR.t, true); });
    return m;
  }
  function close() { stopPlay(); const m = $('aqModal'); if (m) m.hidden = true; cur = null; }
  function open(kind) {
    const m = modal(); cur = kind;
    if (kind === 'complaints') { $('aqEye').textContent = 'Ассистент находит не то'; $('aqTitle').textContent = 'Жалобы партнёров: путь каждого вопроса'; $('aqBody').innerHTML = complaintsHTML(); }
    else { $('aqEye').textContent = 'Наблюдаемость ассистента'; $('aqTitle').textContent = 'Учебный сбой: поставщик тихо обновил модель'; DR.tl = timeline(A().graph); DR.t = OB.H; $('aqBody').innerHTML = drillShell(); }
    m.hidden = false; $('aqBody').scrollTop = 0;
    if (kind === 'drill') drillAt(OB.H, true);
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-aiq]'); if (b) open(b.dataset.aiq); });

  /* ---------- жалобы партнёров ---------- */
  const ana = (life, plain, term) => `<div class="ld-ana"><p class="ld-life"><span class="ld-tag">Как в жизни</span>${life}</p>${plain ? `<p>${plain}</p>` : ''}${term ? `<p><span class="ld-tag t">Термин</span>${term}</p>` : ''}</div>`;
  const CMP = [
    { id: 'codes', who: 'Партнёр «Винтик», Самара', q: 'Какой патрон у перфоратора ПФ-2610-М?', lever: 'Гибридный поиск', where: 'vdb', fix: '«Документы и каталог» → «Как искать» → гибридно',
      run(lv) {
        const rw = { t: lv.rewrite ? 'вопрос и так полный — остаётся как есть' : 'вопрос как есть' };
        const found = lv.hybrid ? ['<b>Паспорт ПФ-2610-М</b> — точное совпадение кода', 'Паспорт ПФ-2016-М', 'Перфораторы: сравнение 2026'] : ['Паспорт ПФ-2016-М — «почти тот же» вектор', 'Перфораторы: сравнение 2026', 'Паспорт ПФ-2160'];
        const ok = lv.hybrid;
        return { rw, found, foundNote: lv.hybrid ? 'по словам код ПФ-2610-М найден точно, по смыслу — похожие' : 'для векторов ПФ-2610-М и ПФ-2016-М почти одинаковы — нужный паспорт даже не в первой полусотне', ok, ans: ok ? 'У ПФ-2610-М патрон SDS-max (паспорт, раздел 2).' : 'У ПФ-2610-М патрон SDS-plus.', why: ok ? 'нужный паспорт найден по точному коду' : 'ответ про соседнюю модель: у ПФ-2016-М — SDS-plus' };
      } },
    { id: 'rerank', who: 'Партнёр «Сфера», Тверь', q: 'Сколько гарантия на шуруповёрты «Сокол»?', lever: 'Переранжировщик', where: 'rr', fix: 'поставь «Переранжировщик» и соедини Ассистент → Переранжировщик',
      run(lv) {
        const found = lv.rr ? ['<b>Гарантийная политика 2026</b> — переранжировщик поднял с 7-го места', 'Шуруповёрт «Сокол»: паспорт', 'Гарантийная политика 2023'] : ['Гарантийная политика 2023 — больше общих слов', 'Шуруповёрт «Сокол»: паспорт', 'Сервисные центры'];
        const ok = lv.rr;
        return { rw: { t: 'вопрос и так полный' }, found, foundNote: lv.rr ? 'поиск нашёл обе политики; переранжировщик прочитал их вместе с вопросом и поставил действующую наверх' : 'новая политика нашлась, но на 7-м месте — в пятёрку для модели не попала', ok, ans: ok ? 'Гарантия на «Сокол» — 3 года (политика с 01.2026).' : 'Гарантия на шуруповёрты — 1 год.', why: ok ? 'ответ по действующему документу' : 'ответ по устаревшей политике 2023 года' };
      } },
    { id: 'vague', who: 'Партнёр «Ключ», Казань', q: '…какие есть болгарки до 5 000 ₽? — «Бриз» и «Вихрь». — А для той, что подешевле, есть кейс?', lever: 'Переписывание вопроса', where: 'llm', fix: 'модель → «Переписывать вопрос перед поиском»',
      run(lv) {
        const rw = lv.rewrite ? { t: '«Есть ли кейс в комплекте у УШМ-125 «Бриз»?»', on: true } : { t: 'ищем по «а для той, что подешевле, есть кейс?»' };
        const found = lv.rewrite ? ['<b>УШМ-125 «Бриз»: комплектация</b>', 'УШМ-125 «Бриз»: паспорт', 'Кейсы для инструмента: каталог'] : ['Кейсы для инструмента: каталог', 'Акция «Кейс в подарок» 2024', 'Ящики и органайзеры'];
        const ok = lv.rewrite;
        return { rw, found, foundNote: lv.rewrite ? 'по полному вопросу нашлась комплектация нужной болгарки' : 'в вопросе нет ни товара, ни модели — нашлось «что-то про кейсы»', ok, ans: ok ? 'Да, УШМ-125 «Бриз» продаётся в пластиковом кейсе.' : 'Кейсы продаются отдельно: от 890 ₽, см. каталог.', why: ok ? 'вопрос дописан по истории диалога' : 'ответ про кейсы вообще, а не про «Бриз»' };
      } },
    { id: 'none', who: 'Партнёр «Дом-Мастер», Пермь', q: 'Есть ли у вас скидка для школ?', lever: 'Честное «не знаю»', where: 'llm', fix: 'модель → «Если опоры мало» → честно «не знаю» (мягкий порог)',
      run(lv) {
        const ok = lv.idk !== 'off';
        return { rw: { t: 'вопрос и так полный' }, found: ['Скидки для юрлиц', 'Программа лояльности партнёров', 'Акции сезона'], foundNote: 'документа про школы в базе нет — найденное о другом', ok, ans: ok ? 'В документах нет программы для школ. Передаю вопрос менеджеру — он ответит сегодня.' : 'Да, для школ действует скидка 15 % по программе «Образование».', why: ok ? 'опоры мало — честный отказ и передача человеку' : 'программы «Образование» не существует: модель уверенно выдумала' };
      } },
    { id: 'acl', who: 'Партнёр «Резьба», Уфа', q: 'По какой цене мы закупаем дрель ДР-4471?', lever: 'Права до поиска', where: 'vdb', fix: '«Документы и каталог» → «Права на документы» → до поиска',
      run(lv) {
        if (lv.acl === 'pre') return { rw: { t: 'вопрос и так полный' }, aclT: 'ищем только среди документов «Резьбы»', found: ['<b>Договор №118 «Резьба»: прайс</b>', 'Дрель ДР-4471: паспорт', 'Договор №118: условия доставки'], foundNote: 'чужие договоры в поиске не участвуют', ok: true, ans: 'По договору №118 — 4 120 ₽ за штуку.', why: 'своя цена, чужих документов модель не видела' };
        if (lv.acl === 'post') return { rw: { t: 'вопрос и так полный' }, aclT: 'из 50 найденных кусков 47 — договоры других партнёров, их выкинули', found: ['Дрель ДР-4471: паспорт', 'Дрель ДР-4471: инструкция', 'Каталог дрелей'], foundNote: 'свой прайс был на 63-м месте и в выдачу не попал', ok: false, warn: true, ans: 'Не нашёл цену закупки в ваших документах. Передаю менеджеру.', why: 'утечки нет, но и ответа нет: нужный документ вытеснили чужие' };
        return { rw: { t: 'вопрос и так полный' }, aclT: 'права не проверяются', found: ['Договор №204 «Винтик»: прайс — чужой', 'Договор №118 «Резьба»: прайс', 'Договор №77 «Сфера»: прайс — чужой'], foundNote: 'прайсы всех партнёров похожи — первым нашёлся чужой', ok: false, leak: true, ans: 'Закупочная цена ДР-4471 — 3 890 ₽ (договор №204).', why: 'утечка: партнёр увидел цену из чужого договора' };
      } }
  ];
  function complaintsHTML() {
    const S = A(), q = S && S.res1 && S.res1.rag2, lv = q ? q.levers : leversOf({ load: new Map(), nodes: new Map() }, { nodes: {} });
    const nodeOf = w => { const g = S.graph; if (w === 'vdb') return g.nodes.find(n => n.type === 'vectordb'); if (w === 'rr') return g.nodes.find(n => n.type === 'rerank'); return g.nodes.find(n => n.type === 'llm'); };
    let h = '<div class="ld aq-c">' + ana('Ассистент с поиском по документам — как консультант с картотекой: сначала достаёт карточки, потом отвечает по ним. Ошибиться можно в поиске (не та карточка), в правах (чужая папка) и в честности (карточки нет — а он отвечает).',
      'Ниже — пять настоящих жалоб. Каждая прошла через твою схему: так видно, на каком шаге вопрос сломался и какая настройка это чинит.',
      '<b>RAG</b>: переписать вопрос → найти кандидатов (по словам и по смыслу) → отфильтровать по правам → переранжировать → модель отвечает по пятёрке лучших кусков или честно говорит «не знаю».');
    if (!q || !lv.model) h += '<div class="ld-card warn">Модель пока не отвечает — собери схему, и жалобы пройдут через неё.</div>';
    const okN = CMP.filter(c => c.run(lv).ok).length;
    h += `<div class="aq-sum"><b>${okN} из ${CMP.length}</b> жалоб твоя схема уже лечит.${q ? ` В целом по симулятору — ${pc(q.acc)} верных ответов.` : ''}</div><div class="aq-cl">`;
    CMP.forEach((c, i) => {
      const r = c.run(lv), cls = r.ok ? 'ok' : r.leak ? 'bad' : r.warn ? 'warn' : 'bad', nd = nodeOf(c.where);
      const step = (n, t, body, on) => `<li class="${on ? 'on' : ''}"><i>${n}</i><div><b>${t}</b>${body}</div></li>`;
      h += `<section class="aq-cmp ${cls}"><div class="aq-ch"><span class="aq-n">${i + 1}</span><div><b>${esc(c.q)}</b><small>${esc(c.who)}</small></div><span class="aq-v ${cls}">${r.ok ? 'починено' : r.leak ? 'утечка' : r.warn ? 'безопасно, но без ответа' : 'ошибка'}</span></div><ol class="aq-steps">`;
      h += step(1, 'Переписать вопрос', `<p>${esc(r.rw.t)}</p>`, r.rw.on);
      h += step(2, lv.hybrid ? 'Найти: по словам и по смыслу' : 'Найти: по смыслу', `<ul>${r.found.map(f => `<li>${f}</li>`).join('')}</ul><p class="aq-mut">${esc(r.foundNote)}</p>`, c.id === 'codes' && lv.hybrid);
      if (r.aclT) h += step(3, 'Права на документы', `<p>${esc(r.aclT)}</p>`, lv.acl === 'pre');
      h += step(r.aclT ? 4 : 3, 'Переранжировать', `<p>${lv.rr ? 'переранжировщик перечитал кандидатов вместе с вопросом' : 'нет — в модель идут первые пять как есть'}</p>`, c.id === 'rerank' && lv.rr);
      h += step(r.aclT ? 5 : 4, 'Ответ модели', `<p class="aq-ans">${esc(r.ans)}</p><p class="aq-mut">${esc(r.why)}</p>`, r.ok);
      h += `</ol>${r.ok ? '' : `<div class="aq-fix"><span>Что поможет: <b>${esc(c.lever)}</b> — ${esc(c.fix)}.</span>${nd ? `<button type="button" class="btn" data-aqsel="${nd.id}">Показать на схеме</button>` : ''}</div>`}</section>`;
    });
    h += '</div>';
    if (q) {
      const rows = ['plain', 'codes', 'vague', 'none'].map(k => `<tr><th>${CLS[k]}</th><td>${pc(q.mix[k])}</td><td>${k === 'none' ? '—' : pc(q.cls[k].g)}</td><td class="${q.cls[k].corr >= 0.85 ? 'ok' : 'bad'}">${pc(q.cls[k].corr)}</td><td>${pc(q.cls[k].idk)}</td></tr>`).join('');
      h += `<div class="ld-tablewrap"><table class="ld-table"><caption class="aq-cap">Все вопросы по видам — симулятор твоей схемы</caption><thead><tr><th>Вопросы</th><th>Доля</th><th>Нужный кусок у модели</th><th>Верный ответ</th><th>«Не знаю»</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    return h + '</div>';
  }

  /* ---------- учебный сбой: 10 дней на графиках ---------- */
  const DR = { t: OB.H, tl: null, timer: 0 };
  function stopPlay() { if (DR.timer) clearInterval(DR.timer); DR.timer = 0; const b = document.querySelector('[data-aqplay]'); if (b) b.textContent = '▶ Проиграть 10 дней'; }
  function play() {
    if (DR.timer) { stopPlay(); return; }
    const calm = document.documentElement.classList.contains('calm');
    if (calm) { drillAt(OB.H); return; }
    let t = DR.t >= OB.H ? 0 : DR.t;
    const b = document.querySelector('[data-aqplay]'); if (b) b.textContent = '❚❚ Пауза';
    DR.timer = setInterval(() => { t = Math.min(OB.H, t + 2); drillAt(t); if (t >= OB.H) stopPlay(); }, 60);
  }
  function drillShell() {
    const tl = DR.tl, D = tl.D, s = D.s;
    const cost = (s.ltAny ? T.llmtrace.cost(s.ltAny) : 0) + (s.evAny ? T.evals.cost(s.evAny) : 0) + (s.lbAny ? T.labeling.cost(s.lbAny) : 0);
    let h = '<div class="ld aq-d">' + ana('Повар пробует блюдо до подачи. Если поставщик тайком поменял муку, тарелки целы и подача быстрая — а пирог хуже. Узнать можно, только пробуя: каждую ночь — контрольный кусок по эталонному вкусу, каждый день — несколько тарелок из зала.',
      'Поставщик обновил модель под тем же именем. Ошибок нет, отвечает даже быстрее и дешевле — но перестал опираться на документы. Ниже 10 дней работы твоей схемы: что увидит каждый датчик и когда.',
      '<b>Дрейф качества</b> не виден по RED-метрикам (запросы, ошибки, задержка). Его ловят <b>офлайн-оценка</b> на золотом наборе (прогон эталонов) и <b>онлайн-оценка</b> на выборке живого трафика (разметка), а <b>LLM-трассы</b> дают ИИ-метрики: «не знаю», передачи человеку, токены, цену, 👎.');
    h += `<div class="ld-kpis aq-k">${tileK('Заметили через', '≈ ' + hrs(D.mttd), D.first.src, D.mttd <= 24 ? 'ok' : 'bad')}${tileK('Плохих ответов до отката', '≈ ' + num(tl.badAnswers), 'клиенты получили ответ «по памяти»', tl.badAnswers > 20000 ? 'bad' : tl.badAnswers > 3000 ? 'warn' : 'ok')}${tileK('Ложных тревог', D.fa.length ? String(D.fa.length) : '0', `за 10 дней · ≈ ${dec(D.fpm, D.fpm < 10 ? 1 : 0)} в месяц`, D.fpm > 1 ? 'bad' : 'ok')}${tileK('Датчики стоят', usd(cost), 'в месяц', '')}</div>`;
    h += `<div class="aq-ctl"><button type="button" class="btn primary" data-aqplay>▶ Проиграть 10 дней</button><input type="range" id="aqT" class="ld-range" min="0" max="${OB.H}" step="1" value="${OB.H}" aria-label="Время, часы"><output id="aqTo">${clock(OB.H)}</output></div>`;
    h += '<div id="aqCh"></div><div class="ld-logbox"><b class="ld-h">Журнал</b><ol class="ld-log" id="aqLog"></ol></div><div id="aqFin"></div></div>';
    return h;
  }
  const tileK = (l, v, sub, cls) => `<div class="ld-kpi ${cls || ''}"><span>${l}</span><b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  function chart(W, H, o) {
    const ml = o.ml || 46, mr = 8, mt = 6, mb = o.axis ? 18 : 4, iw = Math.max(40, W - ml - mr), ih = H - mt - mb;
    const X = t => ml + iw * t / OB.H, Y = v => mt + ih * (1 - Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min))));
    let h = `<svg class="ld-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria)}">`;
    o.ticks.forEach(v => { h += `<line class="ld-grid" x1="${ml}" x2="${W - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ld-ax" x="${ml - 5}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${(o.tick || o.fmt)(v)}</text>`; });
    if (o.thr != null) h += `<line class="ld-thr" x1="${ml}" x2="${W - mr}" y1="${Y(o.thr).toFixed(1)}" y2="${Y(o.thr).toFixed(1)}"/>${o.thrLabel ? `<text class="ld-thrt" x="${W - mr - 2}" y="${(Y(o.thr) - 4).toFixed(1)}" text-anchor="end">${esc(o.thrLabel)}</text>` : ''}`;
    (o.marks || []).forEach(m => { if (m.t <= o.cur) h += `<line class="ld-mark ${m.cls}" x1="${X(m.t).toFixed(1)}" x2="${X(m.t).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/>`; });
    if (o.data) { let d = ''; for (let t = 0; t <= Math.min(o.cur, OB.H); t++) d += `${t ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(o.data[t]).toFixed(1)}`; if (d) h += `<path class="ld-line ${o.cls}" d="${d}"/>`; }
    (o.dots || []).forEach(p => { if (p.t > o.cur) return; const y = Y(p.v); if (p.sg) h += `<line class="aq-wh" x1="${X(p.t).toFixed(1)}" x2="${X(p.t).toFixed(1)}" y1="${Y(p.v + 1.96 * p.sg).toFixed(1)}" y2="${Y(p.v - 1.96 * p.sg).toFixed(1)}"/>`; h += `<circle class="aq-dot ${p.cls}" cx="${X(p.t).toFixed(1)}" cy="${y.toFixed(1)}" r="${o.r || 3.5}"/>`; });
    if (o.axis) for (let d = 0; d <= 10; d += 2) h += `<text class="ld-ax" x="${X(d * 24).toFixed(1)}" y="${H - 4}" text-anchor="${d === 10 ? 'end' : d ? 'middle' : 'start'}">д${d + 1 > 10 ? 10 : d + 1}</text>`;
    if (o.cur < OB.H) h += `<line class="aq-now" x1="${X(o.cur).toFixed(1)}" x2="${X(o.cur).toFixed(1)}" y1="${mt}" y2="${mt + ih}"/>`;
    return h + '</svg>';
  }
  function drillAt(t, rebuild) {
    const tl = DR.tl; if (!tl) return;
    DR.t = Math.max(0, Math.min(OB.H, t));
    const D = tl.D, s = D.s, S = tl.S, box = $('aqCh'); if (!box) return;
    const inp = $('aqT'); if (inp && +inp.value !== DR.t) inp.value = DR.t;
    const out = $('aqTo'); if (out) out.textContent = clock(DR.t);
    const W = Math.max(260, (box.clientWidth || 640)), wide = W >= 744, half = wide ? Math.floor((W - 12) / 2) : W, third = W >= 900 ? Math.floor((W - 24) / 3) : half, inner = w => Math.max(200, w - 18);
    const marks = [{ t: OB.upd, cls: 'warn' }, { t: D.first.t, cls: 'ok' }];
    const cur = DR.t, after = cur >= OB.upd && cur < tl.fix;
    const val = (arr, f) => f(arr[Math.min(OB.H, Math.round(cur))]);
    const mini = (title, arr, o, w) => `<div class="aq-m"><div class="ld-ch-h"><b>${title}</b><span class="${o.badNow ? 'bad' : ''}">${val(arr, o.fmt)}</span></div>${chart(inner(w), 74, Object.assign({ data: arr, cur, marks, aria: title }, o))}</div>`;
    let h = `<h3 class="aq-h3">Что видит обычный мониторинг <small>Prometheus и Grafana на твоей схеме</small></h3><div class="aq-grid g2">`;
    h += mini('Ошибки 5xx', S.err, { min: 0, max: 0.03, ticks: [0, 0.02], fmt: v => pc1(v), thr: 0.02, thrLabel: 'алерт 2 %', cls: 'err' }, half);
    h += mini('Задержка p95', S.p95, { min: 0, max: 2500, ticks: [0, 2000], fmt: v => num(v) + ' мс', tick: v => dec(v / 1000, 0) + ' с', cls: 'lat' }, half);
    h += `</div><p class="aq-note">${after ? 'Модель уже другая, а графики спокойные: ошибок нет, ответы даже быстрее.' : 'Ошибок почти нет, задержка в норме — по этим графикам всё хорошо.'}</p>`;
    h += `<h3 class="aq-h3">ИИ-метрики <small>LLM-трассы → Grafana</small></h3>`;
    if (s.dashAI) {
      h += `<div class="aq-grid g3">`;
      h += mini('Честное «не знаю»', S.idk, { min: 0, max: 0.12, ticks: [0, 0.1], fmt: v => pc1(v), cls: 'ai' }, third);
      h += mini('Передано человеку', S.hand, { min: 0, max: 0.1, ticks: [0, 0.1], fmt: v => pc1(v), cls: 'ai', badNow: after && cur > OB.upd + 12 }, third);
      h += mini('Ответ со ссылкой на документ', S.cite, { min: 0.85, max: 1, ticks: [0.9, 1], fmt: v => pc(v), cls: 'ai' }, third);
      h += mini('Цена ответа', S.cost, { min: 0, max: 0.012, ticks: [0, 0.01], fmt: v => '$' + dec(v, 4), cls: 'ai' }, third);
      h += mini('Токенов на ответ', S.tok, { min: 0, max: 4500, ticks: [0, 4000], fmt: v => num(v), tick: v => v ? dec(v / 1000, 0) + 'k' : '0', cls: 'ai' }, third);
      h += mini('Жалобы 👎', S.thumbs, { min: 0, max: 0.05, ticks: [0, 0.04], fmt: v => pc1(v), cls: 'ai', badNow: after && cur > OB.upd + 18 }, third);
      h += `</div><p class="aq-note">Ссылки на документы остались — модель ставит их по привычке, а цена и токены даже упали. Растут 👎 и передачи человеку — но медленно и в шуме дня: на панели это видно через 2–3 дня.</p>`;
    } else h += `<div class="aq-off">${SD.icon('llmtrace')}<span>Датчика нет: на панели только технические метрики. ${s.ltAny ? 'LLM-трассы стоят, но не выведены в Grafana или не подключены к ассистенту.' : 'Поставь «LLM-трассы»: Ассистент → LLM-трассы → Grafana.'}${s.ltAny ? `<button type="button" class="btn" data-aqsel="${s.ltAny.id}">Показать на схеме</button>` : ''}</span></div>`;
    h += `<div class="aq-grid g2"><div><h3 class="aq-h3">Прогон эталонов <small>доля верных на золотом наборе</small></h3>`;
    if (s.ev && D.runs.length) {
      const dots = D.runs.map(r => ({ t: r.t, v: r.v, sg: s.ev.props.when === 'hourly' ? 0 : r.sg, cls: r.alarm ? (r.bad ? 'bad' : 'warn') : 'ok' }));
      h += `${chart(half, 128, { min: 0.65, max: 1, ticks: [0.7, 0.8, 0.9, 1], fmt: v => pc(v), thr: OB.thrE, thrLabel: 'порог 84 %', dots, cur, marks, axis: true, r: s.ev.props.when === 'hourly' ? 2 : 4, aria: 'Прогон эталонов по дням' })}<p class="aq-note">${s.ev.props.size} вопросов, ${({ nightly: 'каждую ночь в 03:00', hourly: 'каждый час' })[s.ev.props.when]}. Чёрточки — разброс ±${dec(1.96 * sigma(OB.acc0, +s.ev.props.size) * 100, 0)} п. п.${D.fa.some(f => f.src === 'прогон эталонов') ? ' Оранжевые точки — ложные тревоги: шум опустил замер ниже порога.' : ''}</p>`;
    } else h += `<div class="aq-off">${SD.icon('evals')}<span>${!s.evAny ? 'Прогона эталонов нет.' : !s.ev ? 'Прогон эталонов не подключён к ассистенту — задавать вопросы не через кого.' : 'Эталоны гоняются только при наших релизах, а за эти 10 дней релиза не было: обновление — у поставщика.'}${s.evAny ? `<button type="button" class="btn" data-aqsel="${s.evAny.id}">Показать на схеме</button>` : ''}</span></div>`;
    h += `</div><div><h3 class="aq-h3">Разметка живых диалогов <small>опора на источник — оценки людей</small></h3>`;
    if (s.lb && D.labs.length) {
      const dots = D.labs.map(r => ({ t: r.t, v: r.v, sg: r.sg, cls: r.alarm ? (r.bad ? 'bad' : 'warn') : 'ok' }));
      h += `${chart(half, 128, { min: 0.65, max: 1, ticks: [0.7, 0.8, 0.9, 1], fmt: v => pc(v), thr: OB.thrL, thrLabel: 'порог 85 %', dots, cur, marks, axis: true, aria: 'Разметка по дням' })}<p class="aq-note">${s.lb.props.perDay} диалогов в день, оценки за вчера приходят к 12:00. Разброс ±${dec(D.half * 100, 1)} п. п.</p>`;
    } else h += `<div class="aq-off">${SD.icon('labeling')}<span>${!s.lbAny ? 'Живые диалоги никто не оценивает.' : 'Разметка не получает диалоги ассистента.'}${s.lbAny ? `<button type="button" class="btn" data-aqsel="${s.lbAny.id}">Показать на схеме</button>` : ''}</span></div>`;
    h += '</div></div>';
    box.innerHTML = h;
    /* журнал */
    const ev = [{ t: 0, cls: 'mut', text: 'Ассистент работает: ≈ 88 % верных ответов на эталонах, 90 % ответов опираются на документы.' }, { t: OB.upd, cls: 'warn', text: 'Поставщик обновил модель под тем же именем «latest». Ошибок нет, ответы быстрее и дешевле — но модель отвечает «по памяти», мимо документов.' }];
    D.fa.forEach(f => ev.push({ t: f.t, cls: 'warn', text: `Ложная тревога: ${f.src} — ${pc(f.v)}, хотя модель прежняя. ${s.evAm || s.lbAm ? 'Дежурного разбудили зря.' : ''}` }));
    D.list.filter(x => x !== D.first).forEach(x => { if (x.t < OB.H) ev.push({ t: x.t, cls: 'mut', text: `Позже заметил бы и ${x.src}: ${x.how}.` }); });
    ev.push({ t: D.first.t, cls: 'ok', text: `Заметили: ${D.first.src} — ${D.first.how}.` });
    ev.push({ t: tl.fix, cls: 'ok', text: 'Закрепили прежнюю версию модели (снимок с датой вместо «latest») — качество вернулось.' });
    ev.sort((a, b) => a.t - b.t);
    const lg = $('aqLog'); if (lg) lg.innerHTML = ev.filter(e => e.t <= DR.t).map(e => `<li class="${e.cls}"><span class="ld-lt">${e.t > OB.H ? '—' : clock(e.t).replace('день ', 'д')}</span><span>${esc(e.text)}</span></li>`).join('') || '<li class="mut"><span class="ld-lt">д1</span><span>Двигай ползунок или нажми «Проиграть».</span></li>';
    const fin = $('aqFin');
    if (fin) fin.innerHTML = DR.t < OB.H ? '' : `<div class="ld-card ${D.mttd <= 24 && D.fpm <= 1 ? 'ok' : 'bad'}"><b>Итог.</b> Подмену заметили через ≈ ${hrs(D.mttd)} — ${esc(D.first.src)}. За это время клиенты получили ≈ ${num(tl.badAnswers)} ответов «по памяти». ${D.mttd > 24 ? (s.ev ? 'Поставь прогон эталонов на каждую ночь и выведи результат в Prometheus с алертом.' : 'Поставь ночной прогон эталонов: он ловит такое к утру.') : D.fpm > 1 ? 'Быстро, но шумно: ложные тревоги приучат дежурного игнорировать алерт. Возьми 300 вопросов раз в ночь.' : 'Ночной прогон эталонов поймал подмену к утру, и дежурный откатился до того, как пришли жалобы.'}</div>`;
  }
})();
