/* Анализ поверх симуляции: хаос-тест, гарантии данных, советы «прораба», форматирование. */
(function () {
  const T = () => SD.TYPES;
  const H = () => SD.sim.internals;
  const AI = () => SD.AI_TYPES_SET || new Set();

  /* ---------- падение по одному экземпляру каждого узла ---------- */
  function chaos(level, graph, opts) {
    const base = Object.assign({ mul: 1 }, opts || {});
    const out = [];
    graph.nodes.forEach(n => {
      const ai = AI().has(n.type) && !['router', 'semcache'].includes(n.type);
      if (!SD.sim.CHAOS_TYPES.has(n.type) && !ai) return;
      if (n.type === 'queue' && SD.ENGINES[n.props.engine] && SD.ENGINES[n.props.engine].managed) return;
      const r = SD.sim.run(level, graph, Object.assign({}, base, { down: { [n.id]: 1 } }));
      out.push({ id: n.id, type: n.type, success: r.total.success, ok: r.total.success >= 0.99 });
    });
    return out;
  }

  /* ---------- гарантии данных ---------- */
  function analyze(level, graph, res) {
    const ctx = res.ctx, h = H();
    const A = { durable: [], fresh: [], anomalies: {}, ordering: [], dualWrite: false };
    const nm = n => n.label || T()[n.type].name;
    for (const n of ctx.nodes.values()) {
      const ld = (res.nodes[n.id] || {}).load || {};
      const writes = (ld.write || 0) + (ld.apply || 0);
      if (n.type === 'sql' && writes > 0) {
        const p = n.props, info = (res.nodes[n.id].info) || {};
        if (p.replicas > 0 && (p.replMode || 'async') === 'async')
          A.durable.push({ node: n.id, text: `«${nm(n)}»: асинхронные реплики. При падении primary теряются транзакции за последние ≈ ${Math.round(info.lag || 5)} мс.` });
        if (p.replicas > 0 && (p.replMode || 'async') !== 'sync' && !p.ryw && (ld.read || 0) > 0)
          A.fresh.push({ node: n.id, text: `«${nm(n)}»: чтения идут с реплик, которые отстают на ≈ ${Math.round(info.lag || 5)} мс. Пользователь может не увидеть только что сохранённое.` });
        const prev = new Set(SD.ISOLATION[p.isolation || 'rc'].prevents);
        if (p.locking === 'optimistic') prev.add('lost');
        if (p.locking === 'pessimistic') { prev.add('lost'); prev.add('skew'); }
        A.anomalies[n.id] = Object.keys(SD.ANOMALIES).filter(k => !prev.has(k));
      }
      if (n.type === 'nosql' && writes > 0) {
        if ((n.props.rf || 3) === 1) A.durable.push({ node: n.id, text: `«${nm(n)}»: RF = 1, у данных нет копий. Упавший узел уносит свою часть данных.` });
        else if (n.props.cl === 'one') A.durable.push({ node: n.id, text: `«${nm(n)}»: запись с CL = ONE подтверждает одна реплика. Если она упадёт до репликации, запись потеряется.` });
        if (n.props.cl === 'one' && (ld.read || 0) > 0) A.fresh.push({ node: n.id, text: `«${nm(n)}»: CL = ONE на чтение может вернуть старую версию (R + W ≤ RF).` });
      }
      if (n.type === 'cache') {
        if (n.props.policy === 'behind' && (ld.write || 0) > 0) A.durable.push({ node: n.id, text: `«${nm(n)}»: write-behind. Записи, ещё не сброшенные в БД, пропадут при падении кэша.` });
        if (n.props.invalidate === false && n.props.policy === 'aside' && (ld.read || 0) > 0) A.fresh.push({ node: n.id, text: `«${nm(n)}»: ключи не удаляются при записи. Старые данные живут до конца TTL.` });
      }
      if (n.type === 'queue' && (ld.job || ld.msg)) {
        const e = SD.ENGINES[n.props.engine] || SD.ENGINES.kafka;
        if (!e.durable) A.durable.push({ node: n.id, text: `«${nm(n)}»: ${e.name} хранит сообщения в памяти. При падении узла теряется последняя секунда.` });
        if (n.props.engine === 'kafka' && n.props.acks !== 'all') A.durable.push({ node: n.id, text: `«${nm(n)}»: acks=${n.props.acks}. Сообщение подтверждено до того, как его скопировали на реплики.` });
        if (!e.managed && (n.props.count || 1) < 3) A.durable.push({ node: n.id, text: `«${nm(n)}»: ${n.props.count || 1} брокер(а). Без трёх узлов нет реплик, падение брокера теряет данные.` });
        if (n.props.semantics === 'most') A.durable.push({ node: n.id, text: `«${nm(n)}»: at-most-once. Коммит смещения до обработки: упавший обработчик теряет сообщение.` });
        const q = res.queues[n.id];
        if (q) {
          if (e.order === 'none') A.ordering.push({ node: n.id, text: `«${nm(n)}»: ${e.name} не гарантирует порядок сообщений.` });
          else if (e.order === 'single' && q.consumers > 1) A.ordering.push({ node: n.id, text: `«${nm(n)}»: ${q.consumers} потребителя читают одну очередь ${e.name}. Сообщения одного ключа обрабатываются параллельно и вразнобой.` });
        }
      }
      if (n.type === 'app' && level.job && level.job.from === 'write' && (ld.write || 0) > 0) {
        const q = h.kidOf(ctx, n.id, ['queue']);
        const st = h.pickStore(ctx, n.id);
        const viaCdc = st && h.kidOf(ctx, st.id, ['cdc']);
        if (q && st && !n.props.outbox && !viaCdc) { A.dualWrite = true; A.durable.push({ node: n.id, text: `«${nm(n)}» пишет в БД и отдельно публикует в брокер (dual write). Если сервис упадёт между этими шагами, событие потеряется.` }); }
      }
    }
    return A;
  }

  /* ---------- советы прораба ---------- */
  function advise(level, graph, res, an) {
    const ctx = res.ctx, h = H(), A = [];
    const name = n => n.label || T()[n.type].name;
    const L = level;
    for (const n of ctx.nodes.values()) {
      const nr = res.nodes[n.id];
      if (!nr) continue;
      const rt = k => ctx.routeMemo.get(n.id + '|' + k);
      if (!['client', 'external'].includes(n.type) && !T()[n.type].ops && nr.rps === 0 && !nr.dead)
        A.push({ sev: 'info', node: n.id, text: `«${name(n)}» не получает трафика. Проверь направление стрелок: запрос идёт от пользователя вглубь системы.` });
      if (nr.dead) A.push({ sev: 'bad', node: n.id, text: deadText(n) });
      if (nr.status === 'hot' && !nr.dead) A.push({ sev: 'bad', node: n.id, text: overloadText(ctx, n, nr, level), dive: T()[n.type].dive });
      else if (nr.status === 'warn' && n.type !== 'external') A.push({ sev: 'warn', node: n.id, text: `«${name(n)}» загружен на ${Math.round(nr.util * 100)} %. Задержка растёт нелинейно: после 75 % запросы ждут в очереди. Оставь запас 30–40 %.` });
      if ((n.type === 'app' || n.type === 'ws') && nr.alive > 1 && nr.used === 1 && h.parents(ctx, n.id).some(p => p.type === 'client'))
        A.push({ sev: 'bad', node: n.id, text: `У «${name(n)}» ${nr.alive} экз., но пользователи приходят на один адрес, и работает только один. Поставь перед ними балансировщик.`, dive: 'lb' });
      if (n.type === 'worker' && nr.used < nr.alive)
        A.push({ sev: 'warn', node: n.id, text: `Работают ${nr.used} из ${nr.alive} обработчиков: в топике ${nr.used} партиций, а одну партицию читает один потребитель группы. Увеличь число партиций.`, dive: 'queue' });
      if (nr.scaled) A.push({ sev: 'info', node: n.id, text: `Автомасштабирование подняло «${name(n)}» до ${nr.count} экз.${nr.count >= (n.type === 'worker' ? 40 : 30) ? ' Это потолок: дальше расти некуда.' : ''}` });
      if (n.type === 'queue') {
        const q = res.queues[n.id];
        if ((nr.load.job || 0) > 0 && !h.kids(ctx, n.id).some(k => k.type === 'worker' || k.type === 'app'))
          A.push({ sev: 'bad', node: n.id, text: `В «${name(n)}» приходят события, но их никто не читает. Соедини брокер с обработчиками.`, dive: 'queue' });
        if (q && q.lost > 0.01) A.push({ sev: 'warn', node: n.id, text: `Теряется ≈ ${SD.fmt.num(q.lost * 60)} событий в минуту: ошибки обработки не повторяются${q.sem === 'most' ? ', а at-most-once коммитит смещение до обработки' : ''}. Включи «Повторы + DLQ».`, dive: 'delivery' });
        if (q && q.dup > 0.01 && L.goals && L.goals.some(g => g.t === 'nodup')) A.push({ sev: 'warn', node: n.id, text: `≈ ${SD.fmt.num(q.dup * 60)} дублей в минуту: at-least-once доставляет повторно после сбоя или таймаута подтверждения. Нужен идемпотентный обработчик (inbox).`, dive: 'delivery' });
      }
      if (n.type === 'worker' && rt('job') && rt('job').noTarget)
        A.push({ sev: 'bad', node: n.id, text: `Обработчику некуда отдать результат. Для задачи «${L.job.label}» нужна связь «${name(n)}» → «${T()[L.job.target].name}»${L.job.target === 'vectordb' ? ' и к эмбеддингам' : ''}.` });
      if (n.type === 'cdc' && rt('job') && rt('job').noQueue) A.push({ sev: 'bad', node: n.id, text: `CDC читает журнал БД, но некуда публиковать события. Соедини «${name(n)}» → брокер.`, dive: 'cdc' });
      if (n.type === 'app') {
        const w = rt('write'), u = rt('upload'), st = rt('static');
        if ((w && w.syncJob) || (u && u.syncJob)) A.push({ sev: 'warn', node: n.id, text: `«${L.job.label}» выполняется прямо в запросе пользователя. Он ждёт, поток сервиса занят. Положи задачу в брокер.`, dive: 'queue' });
        if ((w && w.jobMissing) || (u && u.jobMissing)) A.push({ sev: 'bad', node: n.id, text: `Задачу «${L.job.label}» никто не выполняет. Нужен путь до «${T()[L.job.target].name}»: напрямую или через брокер и обработчиков.` });
        if (st && st.servesStatic && (nr.load.static || 0) > 0) A.push({ sev: 'warn', node: n.id, text: `Сервис раздаёт картинки и видео. Статика должна идти через CDN из объектного хранилища.`, dive: 'cdn' });
        if ((nr.load.upload || 0) > 0) A.push({ sev: 'info', node: n.id, text: `Файлы грузятся через сервис. Presigned URL позволит клиенту грузить прямо в хранилище.`, dive: 'objstore' });
        const r0 = rt('read');
        if (r0 && r0.cacheDown) A.push({ sev: 'warn', node: n.id, text: `Кэш недоступен: все чтения ушли в БД.${ctx.nodes.get(r0.cacheDown).props.stampede ? ' Single-flight немного сглаживает удар.' : ' Без защиты от stampede базе достаётся всё сразу.'}`, dive: 'cache' });
        if ((nr.load.search || 0) > 0 && !h.kidOf(ctx, n.id, ['search'])) A.push({ sev: 'warn', node: n.id, text: `Поиск идёт запросами LIKE '%…%' в базу: это полный перебор таблицы. Нужен поисковый движок.`, dive: 'search' });
        const tx = n.props.txMode || 'local';
        const svc = h.kids(ctx, n.id).filter(k => k.type === 'app');
        if (svc.length && (nr.load.write || 0) > 0) {
          if (tx === 'local' && res.dist.inconsistent > 0.01) A.push({ sev: 'warn', node: n.id, text: `Запись проходит через ${svc.length + 1} сервиса без координации. При сбое одного из них остаются частичные изменения: ≈ ${SD.fmt.num(res.dist.inconsistent * 60)} в минуту.`, dive: 'saga' });
          if (tx === '2pc') A.push({ sev: 'info', node: n.id, text: `2PC: запись ждёт prepare и commit во всех базах и держит блокировки. Падение любого участника блокирует оформление.`, dive: 'twopc' });
          if (tx === 'saga' && res.dist.sagaNoBroker) A.push({ sev: 'warn', node: n.id, text: `Сага без брокера: если оркестратор упадёт посреди шагов, никто не продолжит и не откатит. Шаги и компенсации передают через брокер.`, dive: 'saga' });
        }
        ['chat', 'vchat', 'voice'].forEach(k => { const r = rt(k); if (r && r.noModel) A.push({ sev: 'bad', node: n.id, text: `Запросы к ассистенту некому обработать: подключи LLM, роутер моделей или агента.`, dive: 'llm' }); if (r && r.noTts) A.push({ sev: 'bad', node: n.id, text: `Голосовой ассистент не может ответить голосом: нет синтеза речи.`, dive: 'voice' }); if (r && r.noStt) A.push({ sev: 'bad', node: n.id, text: `Голосовые запросы некому распознать: нужен STT.`, dive: 'voice' }); if (r && r.noEmbed) A.push({ sev: 'warn', node: n.id, text: `Векторный поиск есть, а эмбеддингов нет: нечем превратить вопрос в вектор.`, dive: 'rag' }); });
      }
      if (n.type === 'search' && !h.parents(ctx, n.id).some(p => ['worker', 'queue', 'cdc'].includes(p.type)))
        A.push({ sev: 'warn', node: n.id, text: `Индекс никто не наполняет: новые данные не попадут в поиск. Нужен индексатор — обработчик, который пишет в «${name(n)}».`, dive: 'search' });
      if (n.type === 'ws') {
        const r = rt('msg');
        if (r && !r.pubsub && nr.used > 1) A.push({ sev: 'bad', node: n.id, text: `Отправитель и получатель часто на разных серверах, и сообщение не доходит (≈ ${Math.round((1 - 1 / nr.used) * 100)} % потерь). Нужен pub/sub: брокер или Redis между шлюзами.`, dive: 'websocket' });
        if (r && r.noStore && (nr.load.msg || 0) > 0) A.push({ sev: 'warn', node: n.id, text: `Сообщения никуда не сохраняются: после перезахода истории не будет.` });
      }
      if (n.type === 'sql' && nr.info) {
        const i = nr.info;
        if (i.hot && (nr.load.write || 0) > 0) A.push({ sev: 'warn', node: n.id, text: n.props.shardKey === 'range' ? `Ключ шардирования по дате: все новые записи летят в последний шард, остальные простаивают.` : `Шардирование по региону: крупный регион перегружает свой шард. Возьми хэш от user_id.`, dive: 'sharding' });
        if (i.connOk < 1) A.push({ sev: 'bad', node: n.id, text: `Соединений к БД нужно ${i.conns}, а у сервера ${i.connLimit}. Часть запросов получает «too many connections». Включи PgBouncer.`, dive: 'replication' });
        if (i.R > 0 && i.lag > 200) A.push({ sev: 'warn', node: n.id, text: `Реплики отстают на ${SD.fmt.ms(i.lag)}: они перегружены и не успевают применять журнал.`, dive: 'replication' });
        if (n.props.indexes === false && (nr.load.read || 0) > 0) A.push({ sev: 'warn', node: n.id, text: `Без индексов каждое чтение — полный перебор таблицы (seq scan).` });
        if (i.abort > 0.02) A.push({ sev: 'info', node: n.id, text: `${Math.round(i.abort * 100)} % транзакций откатываются из-за конфликтов и повторяются. Это цена строгой изоляции при конкуренции.`, dive: 'isolation' });
      }
      if (n.type === 'llm' && nr.info) {
        if (!nr.dead && n.props.hosting === 'api' && nr.util > 1) A.push({ sev: 'bad', node: n.id, text: `Провайдер отвечает 429: лимит ${SD.API_TIERS[n.props.tier].rps} запросов/с, а приходит ${SD.fmt.num(nr.rps)}. Подними лимит, добавь второго провайдера через роутер или семантический кэш.`, dive: 'llmops' });
        if (nr.info.truncated) A.push({ sev: 'warn', node: n.id, text: `Лимит ответа ${n.props.maxOut} токенов меньше нужного (${(L.ai && L.ai.outTok) || 300}). Ответы обрываются.` });
        if (!n.props.stream && (nr.load.chat || nr.load.vchat)) A.push({ sev: 'info', node: n.id, text: `Без стриминга пользователь ждёт весь ответ: ${SD.fmt.ms(nr.info.ttft + nr.info.gen)} вместо ${SD.fmt.ms(nr.info.ttft)} до первого слова.`, dive: 'llm' });
      }
      if (n.type === 'llm' && nr.dead && n.props.hosting === 'self') A.push({ sev: 'bad', node: n.id, text: `Модель не помещается: нужно минимум ${SD.LLM_SIZES[n.props.size].minGpu} GPU.` });
      if (n.type === 'vectordb' && nr.info && nr.info.mem && !nr.info.mem.ok && n.props.index === 'hnsw')
        A.push({ sev: 'warn', node: n.id, text: `HNSW-индекс (${Math.round(nr.info.mem.needGb)} ГБ) не помещается в память узлов (${nr.info.mem.have} ГБ) и читается с диска. Добавь узлы или возьми IVF-PQ.`, dive: 'rag' });
      if (n.type === 'stt' && !n.props.stream && (nr.load.voice || 0) > 0) A.push({ sev: 'info', node: n.id, text: `Распознавание начинается после конца фразы. Потоковый режим распознаёт, пока человек говорит.`, dive: 'voice' });
      if (n.type === 'agent') {
        const need = (L.ai && L.ai.steps) || 4;
        if (n.props.maxSteps < need) A.push({ sev: 'warn', node: n.id, text: `Агенту нужно ≈ ${need} шагов, а лимит ${n.props.maxSteps}. Часть задач обрывается на полпути.`, dive: 'agent' });
        if (n.props.maxSteps > need * 2) A.push({ sev: 'info', node: n.id, text: `Лимит ${n.props.maxSteps} шагов сильно выше нужного. Зациклившийся агент сожжёт лишние токены.`, dive: 'agent' });
      }
    }
    /* связи: повторы, таймауты, предохранители */
    graph.edges.forEach(e => {
      const er = res.edges[e.id], from = ctx.nodes.get(e.from), to = ctx.nodes.get(e.to);
      if (!er || !er.info || !from || !to) return;
      const ep = Object.assign(SD.edgeDefaults(), e.props);
      const i = er.info;
      if (i.amp > 1.3) A.push({ sev: 'bad', edge: e.id, text: `Повторы ${name(from)} → ${name(to)} раздувают нагрузку в ${i.amp.toFixed(1).replace('.', ',')} раза: перегруженный узел получает ещё больше запросов (retry storm).${ep.backoff !== 'exp' ? ' Нужна экспоненциальная пауза с джиттером.' : ''}${!ep.cb ? ' Circuit breaker остановит повторы, пока узел не оправится.' : ''}`, dive: 'resilience' });
      if (i.open) A.push({ sev: 'warn', edge: e.id, text: `Circuit breaker ${name(from)} → ${name(to)} разомкнут: запросы отбиваются сразу и не ждут упавший узел.${ep.fallback ? ' Пользователь получает упрощённый ответ.' : ''}`, dive: 'resilience' });
      if (['app', 'gateway', 'worker', 'agent'].includes(from.type) && !ep.timeout && i.lat > 800 && !AI().has(to.type))
        A.push({ sev: 'warn', edge: e.id, text: `${name(from)} ждёт «${name(to)}» ${SD.fmt.ms(i.lat)} без таймаута. Потоки сервиса заняты ожиданием, и он сам начинает отказывать.`, dive: 'resilience' });
      if (i.tf > 0.01) A.push({ sev: 'warn', edge: e.id, text: `Таймаут ${ep.timeout} мс на ${name(from)} → ${name(to)} обрывает ${Math.round(i.tf * 100)} % вызовов: зависимость отвечает дольше.` });
    });
    if (an) {
      if (L.ai && L.ai.pii && res.ai && res.ai.piiLeak) A.push({ sev: 'bad', text: `Персональные данные уходят внешнему провайдеру LLM. Поставь Guardrails с маскированием PII перед моделью или подними модель на своих GPU.`, dive: 'llmops' });
    }
    if (res.kinds.inject && res.kinds.inject.passed > 0.2) A.push({ sev: 'bad', text: `${Math.round(res.kinds.inject.passed * 100)} % вредных промптов доходит до модели. Нужны Guardrails перед LLM.`, dive: 'llmops' });
    if (Object.values(res.kinds).some(k => k.timeout)) A.push({ sev: 'bad', text: `Часть запросов идёт дольше 10 секунд и обрывается по таймауту.` });
    const client = graph.nodes.find(n => n.type === 'client');
    if (client) Object.keys(res.kinds).forEach(k => {
      const r = ctx.routeMemo.get(client.id + '|' + k);
      if (r && r.noPath) A.push({ sev: 'bad', text: `Запросам «${SD.KINDS[k].label}» некуда идти: от пользователей нет пути к узлу, который их обработает.` });
    });
    const order = { bad: 0, warn: 1, info: 2 };
    const seen = new Set();
    return A.filter(a => { if (seen.has(a.text)) return false; seen.add(a.text); return true; }).sort((a, b) => order[a.sev] - order[b.sev]);
  }

  function deadText(n) {
    const nm = n.label || T()[n.type].name;
    if (n.type === 'sql') return `«${nm}» лежит: primary упал, а реплик для failover нет.`;
    if (n.type === 'queue') return `«${nm}» лежит: кластер меньше трёх брокеров не переживает падение узла.`;
    if (n.type === 'llm' && n.props.hosting === 'api') return `Провайдер «${nm}» недоступен. Запасной провайдер через роутер с фолбэком спасёт ситуацию.`;
    return `«${nm}» лежит. Всё, что шло только через него, получает ошибки.`;
  }

  function overloadText(ctx, n, nr, level) {
    const p = Math.round(nr.util * 100), nm = n.label || T()[n.type].name;
    const ld = nr.load;
    switch (n.type) {
      case 'app': return `«${nm}» перегружен (${p} %). Добавь экземпляры за балансировщиком или убери лишнюю работу: синхронные задачи, раздачу файлов, долгое ожидание зависимостей.`;
      case 'sql': {
        const i = nr.info || {};
        if ((ld.search || 0) > 0) return `БД перегружена (${p} %) поисковыми запросами. Полнотекстовый поиск выносят в поисковый движок.`;
        if ((ld.feed || 0) > 0) return `БД перегружена (${p} %) сборкой лент: каждый запрос делает JOIN по подпискам. Готовь ленты заранее (fan-out on write).`;
        if (i.uW >= i.uR) return `Primary не справляется с записью (${Math.round(i.uW * 100)} %). Реплики тут не помогут: записи принимает только primary. Нужны шарды, другое хранилище или меньше записей.`;
        return `БД не справляется с чтениями (${p} %). Варианты: кэш перед базой или реплики для чтения.`;
      }
      case 'nosql': return `NoSQL-кластеру не хватает узлов (${p} %). Добавь узлы: данные перераспределятся по кольцу.`;
      case 'cache': return `Кэш упёрся в пропускную способность (${p} %). Добавь узлы.`;
      case 'worker': return `Обработчики не успевают (${p} %), очередь растёт. Добавь экземпляры и следи, чтобы партиций было не меньше.`;
      case 'external': return `Внешний сервис упёрся в свой лимит (${p} %) и отвечает отказами. К нему ходят через очередь, чтобы не превышать лимит.`;
      case 'ws': { const w = nr.info || {}; return w.uConn > w.uMsg ? `Realtime-шлюзу не хватает соединений: ${SD.fmt.num(w.conns)} при лимите ${SD.fmt.num(w.connCap)}.` : `Realtime-шлюз не успевает пересылать сообщения (${p} %).`; }
      case 'queue': return `Брокеру не хватает пропускной способности (${p} %). У Kafka добавь партиций, у остальных движков — отдельные очереди или другой движок.`;
      case 'llm': return n.props.hosting === 'api' ? `Лимит API превышен (${p} %).` : `GPU не успевают генерировать (${p} %). Добавь GPU, возьми модель меньше или срежь число токенов.`;
      case 'stt': case 'tts': return `«${nm}» не успевает (${p} %). Добавь GPU или возьми модель быстрее.`;
      case 'vectordb': return `Векторной БД не хватает узлов (${p} %).`;
      case 'guard': return `Guardrails не успевают проверять (${p} %). Добавь экземпляры.`;
      default: return `«${nm}» перегружен (${p} %).`;
    }
  }

  SD.sim.chaos = chaos;
  SD.sim.analyze = analyze;
  SD.sim.advise = advise;

  SD.fmt = {
    num(v) {
      if (!isFinite(v)) return '∞';
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' млн';
      if (a >= 1e4) return Math.round(v / 1e3) + 'k';
      if (a >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + 'k';
      if (a >= 10) return String(Math.round(v));
      return v.toFixed(a >= 1 ? 1 : 2).replace('.', ',');
    },
    ms(v) { return v >= 60000 ? '> 60 с' : v >= 10000 ? Math.round(v / 1000) + ' с' : v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + ' с' : Math.round(v) + ' мс'; },
    pct(v) {
      if (v >= 0.99995) return '100 %';
      if (v >= 0.99) return (v * 100).toFixed(2).replace('.', ',') + ' %';
      return (v * 100).toFixed(1).replace('.', ',') + ' %';
    },
    usd(v) {
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(2).replace('.', ',') + ' млн';
      return '$' + Math.round(v).toLocaleString('ru-RU');
    }
  };
})();
