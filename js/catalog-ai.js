/* Каталог AI-узлов: модели, речь, RAG, защита, агенты.
   Цифры ориентировочные (2026), пропорции между вариантами правдоподобные. */
(function () {
  Object.assign(SD.KINDS, {
    chat:   { label: 'Запросы к ассистенту', short: 'chat',   color: 'var(--k-chat)',   hint: 'Текстовый вопрос к AI-ассистенту' },
    voice:  { label: 'Голосовые запросы',    short: 'voice',  color: 'var(--k-voice)',  hint: 'Пользователь говорит, ассистент отвечает голосом' },
    inject: { label: 'Prompt injection',     short: 'attack', color: 'var(--k-bot)',    hint: 'Попытки увести модель и вытащить данные' },
    docs:   { label: 'Документы в базу знаний', short: 'docs', color: 'var(--k-upload)', hint: 'Новые документы для RAG' }
  });
  Object.assign(SD.KIND_ALIAS, { vchat: 'voice', speak: 'voice', embq: 'chat', vsearch: 'chat', upsert: 'docs', agentllm: 'chat' });
  SD.AI_KINDS = ['chat', 'voice', 'inject', 'docs'];

  SD.LLM_SIZES = {
    small:  { name: 'Малая — 8B, класс Haiku',        quality: 0.72, ttft: 250, speed: 160, pIn: 0.25, pOut: 1.25, gpuTok: 2400, minGpu: 1 },
    medium: { name: 'Средняя — 70B, класс Sonnet',    quality: 0.86, ttft: 450, speed: 80,  pIn: 3,    pOut: 15,   gpuTok: 700,  minGpu: 2 },
    large:  { name: 'Большая — frontier, класс Opus', quality: 0.94, ttft: 800, speed: 45,  pIn: 15,   pOut: 75,   gpuTok: 160,  minGpu: 8 }
  };
  SD.API_TIERS = { basic: { name: 'Базовый лимит — 10 запросов/с', rps: 10 }, pro: { name: 'Pro — 80 запросов/с', rps: 80 }, ent: { name: 'Enterprise — 600 запросов/с', rps: 600 } };
  SD.STT_MODELS = {
    tiny:  { name: 'Whisper tiny — быстро, WER 12 %',   wer: 0.12, rtf: 0.02, streams: 200 },
    base:  { name: 'Whisper small — WER 8 %',           wer: 0.08, rtf: 0.04, streams: 100 },
    large: { name: 'Whisper large-v3 — WER 4 %',        wer: 0.04, rtf: 0.10, streams: 30 }
  };
  SD.TTS_MODELS = {
    fast:   { name: 'Быстрый (Piper) — роботизированно', first: 80,  per100: 60,  streams: 300, natural: 0.7 },
    neural: { name: 'Нейронный (XTTS) — как человек',     first: 250, per100: 400, streams: 40,  natural: 0.95 }
  };
  SD.GPU_COST = 1900;

  const add = (k, v) => { SD.INNER_ICONS = SD.INNER_ICONS || {}; SD.INNER_ICONS[k] = v; };
  add('llm', '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/><path d="M6 15.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L4 17.5l1.4-.6z"/>');
  add('stt', '<rect x="5" y="3" width="6" height="10" rx="3"/><path d="M3 11a5 5 0 0 0 10 0M8 16v3"/><path d="M15 9h6M15 13h6M15 17h4"/>');
  add('tts', '<path d="M3 6h7M3 10h7M3 14h5"/><path d="M13 10.5h2.5l3.5-3v9l-3.5-3H13z"/><path d="M21 9.5a3.5 3.5 0 0 1 0 5"/>');
  add('embed', '<path d="M4 20L12 4l8 16"/><path d="M12 4v16M7 14h10"/><circle cx="12" cy="4" r="1.3"/><circle cx="4" cy="20" r="1.3"/><circle cx="20" cy="20" r="1.3"/>');
  add('vectordb', '<ellipse cx="12" cy="5.5" rx="7" ry="2.6"/><path d="M5 5.5v13c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-13"/><circle cx="9" cy="12" r="1"/><circle cx="14" cy="10.5" r="1"/><circle cx="12.5" cy="15.5" r="1"/><path d="M9 12l5-1.5-1.5 5z"/>');
  add('semcache', '<path d="M4 5h16v10H9l-4 4v-4H4z"/><path d="M12.8 6.8L9.5 11h2.6l-.9 3.2 3.3-4.2h-2.6z"/>');
  add('guard', '<path d="M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z"/><path d="M12 8v4.5M12 15.5h.01"/>');
  add('router', '<circle cx="5" cy="12" r="2"/><path d="M7 12h3c2 0 3-1 4-3l1-2h3M10 12c2 0 3 1 4 3l1 2h3"/><path d="M16.5 5l2 2-2 2M16.5 15l2 2-2 2"/>');
  add('agent', '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 15h5"/><path d="M2.5 11v3M21.5 11v3"/>');

  const prevInner = SD.iconInner;
  SD.iconInner = t => (SD.INNER_ICONS && SD.INNER_ICONS[t]) || prevInner(t);
  SD.icon = (type, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SD.iconInner(type)}</svg>`;

  SD.GROUPS.push({ id: 'ai', label: 'AI и нейросети' });
  const tog = (key, label, def, help, extra) => Object.assign({ key, label, type: 'toggle', def, help }, extra || {});
  const hosting = (def) => ({ key: 'hosting', label: 'Где работает', type: 'select', def, options: [['api', 'Облачный API — платим за токены'], ['self', 'Свои GPU (vLLM, Triton)']],
    help: 'API: не нужно держать GPU, но есть лимиты и цена за токен, данные уходят провайдеру. Свои GPU: фиксированная цена и данные внутри контура.' });
  const gpus = (def, max) => ({ key: 'gpus', label: 'GPU', type: 'range', min: 1, max: max || 32, def, showIf: n => n.props.hosting === 'self', help: `Каждый GPU ≈ $${SD.GPU_COST} в месяц.` });
  const tier = { key: 'tier', label: 'Лимит API', type: 'select', def: 'pro', options: Object.entries(SD.API_TIERS).map(([k, v]) => [k, v.name]), showIf: n => n.props.hosting === 'api',
    help: 'Сверх лимита провайдер отвечает 429. Лимит повышают договором или раскладывают нагрузку на несколько провайдеров.' };
  const gpuCost = n => n.props.hosting === 'self' ? n.props.gpus * SD.GPU_COST : 0;

  Object.assign(SD.TYPES, {
    llm: {
      name: 'LLM', short: 'языковая модель', group: 'ai',
      props: [
        { key: 'size', label: 'Модель', type: 'select', def: 'medium', options: Object.entries(SD.LLM_SIZES).map(([k, v]) => [k, v.name]),
          help: 'Большая модель умнее, но медленнее и в 5–60 раз дороже за токен.' },
        hosting('api'), tier, gpus(2),
        tog('stream', 'Стриминг ответа', true, 'Токены отдаются по мере генерации. Пользователь видит начало ответа через TTFT, а не ждёт весь текст.'),
        { key: 'maxOut', label: 'Лимит ответа', type: 'select', def: 512, options: [[256, '256 токенов'], [512, '512 токенов'], [1024, '1 024 токена'], [4096, '4 096 токенов']],
          help: 'Длинные ответы дольше генерируются и дороже. Слишком короткий лимит обрывает ответ.' },
        tog('pcache', 'Prompt caching', false, 'Неизменная часть промпта (system, инструкции, документы) кэшируется у провайдера: вход в 10 раз дешевле, TTFT ниже.')
      ],
      cost: gpuCost,
      info: {
        what: 'Генерирует текст по промпту. Время ответа = время до первого токена (TTFT) + длина ответа / скорость генерации.',
        why: 'Ядро любого AI-ассистента. Главные рычаги: размер модели (качество против цены и скорости), стриминг (воспринимаемая задержка), лимит токенов и prompt caching (цена), хостинг (API против своих GPU).',
        pros: ['Решает задачи на естественном языке', 'Стриминг даёт быстрый отклик'],
        cons: ['Секунды на ответ', 'Цена за токен растёт с размером модели', 'Галлюцинирует без контекста (нужен RAG)'],
        real: 'Claude, GPT, GigaChat, YandexGPT, Llama, Qwen через vLLM', numbers: [['TTFT', '0,2–1 с'], ['Скорость', '40–160 токенов/с'], ['Средняя модель', '$3 / $15 за 1M токенов']]
      }, dive: 'llm'
    },
    router: {
      name: 'Роутер моделей', short: 'AI-шлюз, LiteLLM', group: 'ai', managed: true,
      props: [
        { key: 'strategy', label: 'Стратегия', type: 'select', def: 'cost', options: [['cost', 'По сложности — простое в малую модель'], ['quality', 'Всё в самую сильную'], ['balance', 'Поровну']],
          help: 'Классификатор оценивает сложность запроса. Простые вопросы отвечает дешёвая модель, сложные — сильная.' },
        tog('failover', 'Фолбэк на другого провайдера', true, 'Если модель недоступна или отвечает 429, запрос уходит в следующую.')
      ],
      cost: () => 100,
      info: {
        what: 'Единая точка вызова моделей: выбирает модель под запрос, держит ключи, лимиты, бюджеты и фолбэки.',
        why: 'Большинство запросов простые, и платить за них ценой большой модели незачем. Роутер снижает цену в разы почти без потери качества и переживает отказ одного провайдера.',
        pros: ['Экономия на простых запросах', 'Фолбэк между провайдерами', 'Учёт токенов и бюджетов'],
        cons: ['Ошибки классификатора отправляют сложное в слабую модель'],
        real: 'LiteLLM, OpenRouter, Portkey', numbers: [['Задержка', '≈ 3 мс']]
      }, dive: 'llmops'
    },
    semcache: {
      name: 'Семантический кэш', short: 'похожие вопросы', group: 'ai',
      props: [
        { key: 'threshold', label: 'Порог похожести', type: 'select', def: '0.95', options: [['0.98', '0.98 — почти дословно'], ['0.95', '0.95 — близкие по смыслу'], ['0.90', '0.90 — широко']],
          help: 'Чем ниже порог, тем чаще попадание, но тем чаще ответ на «похожий, но другой» вопрос.' }
      ],
      cost: () => 260,
      info: {
        what: 'Хранит пары «вопрос → ответ» с эмбеддингами вопросов. Новый вопрос сравнивается по смыслу с сохранёнными.',
        why: 'Пользователи часто спрашивают одно и то же разными словами. Ответ из кэша приходит за 20 мс и ничего не стоит.',
        pros: ['Ответ за десятки миллисекунд', 'Срезает расходы на токены'],
        cons: ['Низкий порог отдаёт неверные ответы', 'Нельзя кэшировать персональные ответы'],
        real: 'GPTCache, Redis + векторы', numbers: [['Задержка', '≈ 20 мс']]
      }, dive: 'llmops'
    },
    guard: {
      name: 'Guardrails', short: 'защита промптов и PII', group: 'ai',
      props: [
        { key: 'count', label: 'Экземпляры', type: 'range', min: 1, max: 10, def: 2 },
        { key: 'mode', label: 'Что проверять', type: 'select', def: 'input', options: [['input', 'Только вход'], ['both', 'Вход и ответ модели']],
          help: 'Проверка ответа ловит утечки, которые модель выдала несмотря на защиту, но добавляет задержку.' },
        tog('pii', 'Маскировать персональные данные', true, 'Телефоны, паспорта и карты заменяются метками до отправки внешнему провайдеру.')
      ],
      cost: n => 200 * n.props.count,
      info: {
        what: 'Фильтр перед и после модели: ловит prompt injection, токсичность, утечку персональных данных.',
        why: 'Модель выполняет инструкции из текста, в том числе вредные. Защиту ставят снаружи модели, потому что промпт «не делай так» обходится. OWASP LLM Top 10 ставит prompt injection на первое место.',
        pros: ['Блокирует атаки и утечки', 'PII не уходит внешнему провайдеру'],
        cons: ['Добавляет 40–100 мс', 'Ложные срабатывания отказывают честным пользователям'],
        real: 'Llama Guard, NeMo Guardrails, Presidio', numbers: [['Проверка входа', '≈ 40 мс'], ['Экземпляр', '≈ 400 запросов/с']]
      }, dive: 'llmops'
    },
    embed: {
      name: 'Эмбеддинги', short: 'текст → вектор', group: 'ai',
      props: [hosting('api'), gpus(1, 8)],
      cost: n => n.props.hosting === 'self' ? n.props.gpus * SD.GPU_COST : 40,
      info: {
        what: 'Модель превращает текст в вектор из 1 000+ чисел. Похожие по смыслу тексты дают близкие векторы.',
        why: 'Основа RAG и семантического поиска: вопрос и куски документов переводятся в векторы и сравниваются.',
        pros: ['Поиск по смыслу, а не по словам', 'Дёшево и быстро'],
        cons: ['Смена модели требует переиндексации всего корпуса'],
        real: 'text-embedding-3, bge-m3, e5', numbers: [['Задержка API', '≈ 60 мс'], ['Свой GPU', '≈ 3 000 текстов/с']]
      }, dive: 'rag'
    },
    vectordb: {
      name: 'Векторная БД', short: 'поиск ближайших', group: 'ai',
      props: [
        { key: 'count', label: 'Узлы', type: 'range', min: 1, max: 12, def: 1 },
        { key: 'index', label: 'Индекс', type: 'select', def: 'hnsw', options: [['hnsw', 'HNSW — быстро, много памяти'], ['ivf', 'IVF-PQ — компактно, чуть хуже recall'], ['flat', 'Flat — точный перебор']],
          help: 'HNSW держит граф в памяти. IVF-PQ сжимает векторы в 8 раз. Flat перебирает всё: точно, но медленно.' }
      ],
      cost: n => 400 * n.props.count,
      info: {
        what: 'Хранит векторы кусков документов и находит k ближайших к вектору вопроса.',
        why: 'Даёт модели нужный контекст из ваших документов: модель отвечает по фактам компании, а не придумывает. Индекс приближённый: скорость обменивается на полноту (recall).',
        pros: ['Миллисекунды на поиск среди миллионов векторов', 'Фильтры по метаданным'],
        cons: ['HNSW требует много RAM', 'Recall < 100 %: иногда нужный кусок не находится'],
        real: 'pgvector, Qdrant, Milvus, Weaviate', numbers: [['HNSW, узел', '≈ 1 500 запросов/с'], ['Вектор 1536 × float32', '≈ 6 КБ']]
      }, dive: 'rag'
    },
    stt: {
      name: 'Распознавание речи', short: 'STT, Whisper', group: 'ai',
      props: [
        { key: 'model', label: 'Модель', type: 'select', def: 'base', options: Object.entries(SD.STT_MODELS).map(([k, v]) => [k, v.name]),
          help: 'WER — доля неверно распознанных слов. Ошибки распознавания портят ответ модели.' },
        hosting('self'), gpus(2, 16), tier,
        tog('stream', 'Потоковое распознавание', true, 'Текст распознаётся, пока человек говорит. После паузы остаётся дождаться только хвоста.')
      ],
      cost: n => n.props.hosting === 'self' ? n.props.gpus * SD.GPU_COST : 0,
      info: {
        what: 'Превращает аудио в текст. Скорость меряют RTF: 0,1 значит 10 секунд аудио за 1 секунду.',
        why: 'Первое звено голосового ассистента. Каждое неверное слово ухудшает понимание вопроса моделью.',
        pros: ['Голосовой интерфейс', 'Потоковый режим почти без задержки'],
        cons: ['Большая модель требует GPU', 'Шум и акценты повышают WER'],
        real: 'Whisper, faster-whisper, Deepgram, SaluteSpeech', numbers: [['large-v3, RTF', '≈ 0,1'], ['Потоков на GPU', '30–200']]
      }, dive: 'voice'
    },
    tts: {
      name: 'Синтез речи', short: 'TTS', group: 'ai',
      props: [
        { key: 'model', label: 'Голос', type: 'select', def: 'neural', options: Object.entries(SD.TTS_MODELS).map(([k, v]) => [k, v.name]) },
        hosting('self'), gpus(2, 16), tier,
        tog('stream', 'Потоковый синтез', true, 'Звук начинает играть после первого предложения, остальное синтезируется на ходу.')
      ],
      cost: n => n.props.hosting === 'self' ? n.props.gpus * SD.GPU_COST : 0,
      info: {
        what: 'Превращает текст ответа в речь.',
        why: 'Последнее звено голосового ассистента. Без потокового режима пользователь ждёт синтез всего ответа.',
        pros: ['Естественный голос', 'Потоковый режим: первые звуки за 100–300 мс'],
        cons: ['Нейронные голоса требуют GPU'],
        real: 'Piper, XTTS, ElevenLabs, SaluteSpeech', numbers: [['Первый фрагмент', '80–250 мс']]
      }, dive: 'voice'
    },
    agent: {
      name: 'AI-агент', short: 'цикл LLM + инструменты', group: 'ai',
      props: [
        { key: 'count', label: 'Экземпляры', type: 'range', min: 1, max: 20, def: 2 },
        { key: 'maxSteps', label: 'Максимум шагов', type: 'range', min: 1, max: 15, def: 6,
          help: 'Каждый шаг: модель решает, какой инструмент вызвать, и читает результат. Без лимита агент может зациклиться и сжечь бюджет.' },
        tog('hitl', 'Подтверждение человеком', false, 'Опасные действия (возврат денег, удаление) ждут подтверждения оператора.')
      ],
      perCap: 300, lat: 5,
      cost: n => 180 * n.props.count,
      info: {
        what: 'Цикл: модель смотрит на задачу, вызывает инструмент (API, поиск, БД), читает результат и решает, что дальше.',
        why: 'Для задач, где нужно несколько действий: найти заказ, проверить статус, оформить возврат. Стрелки от агента к сервисам и поиску — это его инструменты.',
        pros: ['Решает многошаговые задачи', 'Использует ваши API как инструменты'],
        cons: ['Каждый шаг — вызов LLM: дорого и медленно', 'Нужны лимиты шагов и контроль опасных действий'],
        real: 'LangGraph, Claude Agent SDK, Temporal', numbers: [['Шаг', '1–3 с'], ['Типичная задача', '3–6 шагов']]
      }, dive: 'agent'
    }
  });
})();
