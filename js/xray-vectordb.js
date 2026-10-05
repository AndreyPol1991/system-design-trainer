/* «Векторная БД и RAG изнутри»: нарезка документов, эмбеддинги как точки (2D-проекция), ближайшие соседи по косинусной близости,
   индекс HNSW против полного перебора, top-k и порог, сборка контекста для LLM и ответ со ссылками.
   Ситуации: устаревший документ, неудачная нарезка, вопрос не по базе, корпус вырос в 10 раз. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
  const MONO = (x, y, t, c, a) => `<text class="xvd-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const BTN = (x, y, w, act, label, on) => `<g class="xvd-btn${on ? ' on' : ''}" data-xvd="${act}" role="button" tabindex="0">${R(x, y, w, 24, '', 7)}<text x="${f1(x + w / 2)}" y="${f1(y + 16)}">${ES(label)}</text></g>`;
  const wrap = (s, n) => { const out = []; let line = ''; String(s).split(' ').forEach(w => { if ((line + ' ' + w).trim().length > n) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); }); if (line) out.push(line); return out; };
  const STAR = (x, y, r, c) => { let p = ''; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; p += `${f1(x + rr * Math.cos(a))},${f1(y + rr * Math.sin(a))} `; } return `<polygon class="xvd-star ${c || ''}" points="${p}"/>`; };

  const VDB = { hnsw: { lat: 6, recall: 0.97, kb: 7, name: 'HNSW' }, ivf: { lat: 10, recall: 0.92, kb: 1, name: 'IVF-PQ' }, flat: { lat: 250, recall: 1, kb: 6, name: 'Flat' } };
  const TH = 0.75, K = 4;

  /* ---------- база знаний банка: документы и куски (координаты — 2D-проекция векторов) ---------- */
  const DOCS = [
    { id: 'tr', name: 'Тарифы на переводы', col: '--k-read', c: [-0.6, -0.1] },
    { id: 'cd', name: 'Карта «Кэшбэк»', col: '--k-write', c: [-0.2, 0.62] },
    { id: 'dp', name: 'Вклады', col: '--k-upload', c: [0.55, 0.45] },
    { id: 'cr', name: 'Кредиты', col: '--k-search', c: [0.62, -0.22] }
  ];
  const OFF = [[0, 0], [0.16, 0.1], [-0.12, 0.14], [0.08, -0.17]];
  const BASE = [
    ['tr', 'Переводы на карты других банков: комиссия 1 %, не меньше 50 ₽.'],
    ['tr', 'Через СБП — бесплатно до 100 000 ₽ в месяц, сверх — 0,5 %.'],
    ['tr', 'Переводы между своими счетами — без комиссии и мгновенно.'],
    ['tr', 'Лимит переводов в сутки — 300 000 ₽, поднять можно в приложении.'],
    ['cd', 'Обслуживание бесплатно при тратах от 10 000 ₽ в месяц, иначе 99 ₽.'],
    ['cd', 'Кэшбэк 5 % в трёх категориях на выбор и 1 % на остальное.'],
    ['cd', 'Заблокировать карту: «Карты» → карта → «Заблокировать» или звонок 900.'],
    ['cd', 'Перевыпуск при утере бесплатный, курьер привезёт за 2 дня.'],
    ['dp', 'Вклад «Доход»: 16 % годовых, без снятия и пополнения.'],
    ['dp', 'Вклад «Свобода»: 14 %, снятие и пополнение без потери процентов.'],
    ['dp', 'Досрочное закрытие «Дохода» — проценты по ставке 0,01 %.'],
    ['dp', 'Проценты по вкладам капитализируются ежемесячно.'],
    ['cr', 'Кредит наличными от 19,9 % годовых, до 5 млн ₽.'],
    ['cr', 'Досрочное погашение кредита без комиссии, в любой день.'],
    ['cr', 'Решение по заявке на кредит — за 2 минуты в приложении.']
  ];
  const CH = (() => { const cnt = {}; return BASE.map(([d, text], i) => { const doc = DOCS.find(x => x.id === d), k = cnt[d] = (cnt[d] || 0) + 1, o = OFF[(k - 1) % 4]; return { id: `${d}-${k}`, d, n: k, text, p: [doc.c[0] + o[0], doc.c[1] + o[1]], tok: 480 + (i * 37) % 60 }; }); })();
  const QS = [
    { q: 'Сколько стоит перевод на карту другого банка?', near: 'tr-1', ans: 'Перевод на карту другого банка стоит 1 %, не меньше 50 ₽ [1]. Через СБП — бесплатно до 100 000 ₽ в месяц [2].' },
    { q: 'Как заблокировать карту?', near: 'cd-3', ans: 'В приложении: «Карты» → нужная карта → «Заблокировать». Или позвоните 900 [1].' },
    { q: 'Можно ли снимать деньги со вклада без потери процентов?', near: 'dp-2', ans: 'Да, на вкладе «Свобода» — 14 % и снятие без потери процентов [1]. На «Доходе» снятие не предусмотрено [2].' },
    { q: 'Можно ли погасить кредит досрочно?', near: 'cr-2', ans: 'Да, досрочно и без комиссии, в любой день [1].' }
  ];
  const OFFQ = [
    { q: 'Какой курс биткоина будет завтра?', p: [0.02, -0.92], hall: 'Завтра биткоин вырастет примерно до 6,2 млн ₽ — банк рекомендует покупать [1].' },
    { q: 'Как оформить ипотеку на квартиру?', p: [0.62, -0.8], hall: 'Ипотека в банке — от 9 % на 30 лет, заявка за 2 минуты в приложении [1].' }
  ];
  const BG = (() => { const out = []; let s = 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; for (let i = 0; i < 46; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.98; out.push([Math.cos(a) * d, Math.sin(a) * d]); } return out; })();
  const simOf = (a, b) => clamp(0.93 - 0.5 * Math.pow(Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.25, 2), -1, 1);

  /* ---------- геометрия ---------- */
  const DB = { x: 16, y: 46, w: 238, h: 346 }, MB = { x: 264, y: 46, w: 432, h: 346 }, QB = { x: 706, y: 46, w: 278, h: 150 }, KB = { x: 706, y: 204, w: 278, h: 188 };
  const IB = { x: 16, y: 402, w: 400, h: 150 }, AB = { x: 426, y: 402, w: 558, h: 150 };

  SD.XRAY.vectordb = {
    viewBox: '0 0 1000 560',
    cta: 'Нарезка документов, эмбеддинги как точки, ближайшие соседи, HNSW против перебора, top-k и порог, контекст для LLM и ответ со ссылками',
    dive: 'rag',
    simple: () => ({
      an: 'Как <b>библиотекарь, который расставил книги не по алфавиту, а по смыслу</b>: про кредиты — в одном углу, про карты — в другом. На вопрос он идёт в нужный угол и приносит несколько самых близких книг.',
      pl: 'Документы режут на куски, а каждый кусок превращают в вектор — точку в пространстве смыслов. Вопрос тоже становится точкой, и база находит ближайшие куски. Их кладут в промпт LLM, и модель отвечает по ним, со ссылками на источник.'
    }),
    props: ['count', 'index'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Вопросы клиентов банка → поиск кусков → ответ со ссылками.' },
      { id: 'stale', name: 'Устаревший документ', note: 'Тариф поменялся, а старый кусок остался в индексе.' },
      { id: 'chunk', name: 'Неудачная нарезка', note: 'Куски нарезаны по 100 токенов — цифра оторвалась от смысла.' },
      { id: 'offbase', name: 'Вопрос не по базе', note: 'Ответа в документах нет: выдумка или «не знаю»?' },
      { id: 'grow', name: 'Корпус ×10', note: 'Документов стало в 10 раз больше: влезет ли индекс в память?' }
    ],
    tries: [
      { id: 'stale', text: 'В «Устаревшем документе» переиндексируй тариф и получи ответ с новой комиссией' },
      { id: 'chunk', text: 'В «Неудачной нарезке» выбери куски по 500 токенов с перекрытием и получи ответ с цифрой' },
      { id: 'offbase', text: 'В «Вопросе не по базе» включи порог и «не знаю» вместо выдуманного ответа' },
      { id: 'grow', text: 'В «Корпусе ×10» сделай так, чтобы индекс поместился в память: узлы или IVF-PQ' },
      { id: 'phnsw', text: 'Открой блок «Индекс HNSW» и дождись, пока жадный спуск дойдёт до нижнего слоя' },
      { id: 'pknn', text: 'Открой блок «Ближайшие соседи» и задай вопрос из другой темы' }
    ],
    parts: {
      chunk: {
        name: 'Нарезка документов',
        an: 'Как <b>карточки для шпаргалки</b>: на каждую выписывают законченную мысль. Слишком мелко — цифра оторвётся от смысла, слишком крупно — карточка обо всём сразу.',
        pl: 'Документ режут на куски по 300–800 токенов, по разделам и абзацам, с перекрытием, чтобы мысль не порвалась на границе. К каждому куску прикладывают метаданные: документ, версию, раздел, дату.',
        how: ['Загрузили документ → вытащили текст (PDF, DOCX, HTML).', 'Режут по заголовкам и абзацам, доводя куски до 300–800 токенов.', 'Перекрытие 10–15 %: конец одного куска повторяется в начале следующего.', 'Метаданные: doc_id, версия, раздел, дата, права доступа.', 'По doc_id и версии старые куски удаляют при обновлении документа.', 'Таблицы и списки режут целиком — иначе заголовок отрывается от цифр.'],
        watch: 'Слева — документы и их куски. В «Неудачной нарезке» можно сравнить куски по 100, 500 и 2 000 токенов.',
        real: 'LangChain RecursiveCharacterTextSplitter, LlamaIndex node parsers, Unstructured. Индексацию запускают в фоне через очередь (уровень «AI-ассистент поддержки»).'
      },
      embed: {
        name: 'Эмбеддинги',
        an: 'Как <b>адрес в городе смыслов</b>: модель даёт каждому тексту координаты, и близкие по смыслу тексты получают соседние адреса — даже если слова разные.',
        pl: 'Модель эмбеддингов превращает текст в вектор из 1 000+ чисел. Похожие по смыслу тексты дают близкие векторы: «отправить деньги на карту» рядом с «перевод на карту», а «кот» — далеко.',
        how: ['Кусок текста → модель эмбеддингов → вектор из 768–3 072 чисел.', 'Вектор нормируют: важен угол между векторами, а не длина.', 'На картинке — проекция на плоскость (как UMAP), расстояния примерные.', 'Вопрос превращают в вектор той же моделью — иначе точки несравнимы.', 'Сменили модель эмбеддингов — переиндексируют весь корпус.', 'Вектор 1 536 чисел × 4 байта ≈ 6 КБ на кусок.'],
        watch: 'Посередине — карта кусков: цвет — документ. Звезда — вопрос пользователя.',
        real: 'text-embedding-3, bge-m3, e5, GigaEmbeddings. Узел «Эмбеддинги» на схеме: ≈ 60 мс через API.'
      },
      knn: {
        name: 'Ближайшие соседи',
        an: 'Как <b>найти на карте ближайшие кафе к точке, где ты стоишь</b>: меряют не адрес, а расстояние.',
        pl: 'Для вектора вопроса ищут k кусков с наибольшей косинусной близостью: 1 — смысл совпадает, около 0 — не связаны. Это поиск по смыслу, а не по словам: вопрос может не содержать ни одного слова из документа.',
        how: ['Косинусная близость = (a·b) / (|a|·|b|); для нормированных векторов — просто скалярное произведение.', 'Берут k ближайших (top-k), обычно 3–8.', 'Близость 0,9 — почти о том же, 0,75 — по теме, 0,5 — мимо.', 'Фильтр по метаданным сужает поиск: только актуальная версия, только доступные пользователю документы.', 'Гибридный поиск: вектор плюс полнотекстовый BM25 — для номеров, кодов и редких слов.', 'Реранкер переставляет найденное точнее, но медленнее.'],
        watch: 'Линии от звезды к ближайшим точкам — top-k. Справа — список с близостью и порогом.',
        real: 'pgvector (оператор <=>), Qdrant, Milvus, Weaviate, OpenSearch k-NN. Реранкеры: bge-reranker, Cohere Rerank.'
      },
      hnsw: {
        name: 'Индекс HNSW', knobs: ['index', 'count'],
        an: 'Как <b>поездка: самолёт → поезд → пешком</b>. Сначала большие прыжки по редким крупным узлам, потом всё мельче, пока не дойдёшь до нужного дома.',
        pl: 'Перебрать миллионы векторов — сотни миллисекунд. HNSW строит многослойный граф: верхние слои редкие, с длинными связями, нижний — все точки. Поиск жадно спускается сверху вниз и проверяет лишь сотни векторов. Цена — память и неполная точность (recall < 100 %).',
        how: ['Слой 2: несколько точек с длинными связями. Слой 0: все точки.', 'Поиск входит в верхний слой и идёт к соседу, который ближе к вопросу.', 'Ближе соседей нет — спускается на слой ниже и продолжает.', 'На нижнем слое собирает k ближайших.', 'Проверяет ≈ сотни векторов из миллионов: миллисекунды.', 'Граф держат в RAM: памяти нужно больше, чем на сами векторы.'],
        watch: 'Внизу слева — выбранный индекс, сколько векторов проверено, задержка, recall и память. Внутри блока — жадный спуск по слоям.',
        real: 'HNSW в pgvector, Qdrant, Weaviate, Milvus. IVF-PQ (FAISS) сжимает векторы в 8 раз ценой recall. Flat — точный перебор, годится до сотен тысяч векторов.'
      },
      topk: {
        name: 'Top-k и порог',
        an: 'Как <b>взять с полки несколько книг, но только по теме</b>: если подходящих нет, честнее сказать «у нас такого нет», чем принести первую попавшуюся.',
        pl: 'Из найденного берут k лучших кусков. Порог близости отсекает то, что лишь отдалённо похоже. Если ничего не прошло порог, ассистент говорит «в документах этого нет», а не отдаёт модели мусор, по которому она выдумает ответ.',
        how: ['k мало — нужный факт может не попасть в контекст.', 'k много — шум, длинный промпт, выше цена и TTFT.', 'Порог 0,75: ниже — кусок не про это.', 'Ничего не прошло порог → ответ «не знаю» без вызова модели или с прямой инструкцией.', 'Порог подбирают на реальных вопросах: меряют, сколько правильных кусков отсекается.', 'Обычно k = 3–8 и порог 0,7–0,8 для косинусной близости.'],
        watch: 'Справа посередине — top-k с близостью и линией порога. В «Вопросе не по базе» близость ниже порога.',
        real: 'score_threshold в Qdrant, match_threshold в pgvector-запросах, similarity_top_k в LlamaIndex.'
      },
      rag: {
        name: 'Контекст и ответ со ссылками',
        an: 'Как <b>ответ на экзамене с открытой книгой</b>: смотришь в нужные страницы и называешь, откуда взял.',
        pl: 'Найденные куски вставляют в промпт с номерами [1], [2]. Системный промпт требует отвечать только по ним и ссылаться на номер. Пользователь видит ссылки и может проверить.',
        how: ['Системный промпт: «Отвечай только по документам ниже, ссылайся [n]. Нет ответа — скажи, что не знаешь».', 'Куски с номерами, названием документа и разделом.', 'Вопрос пользователя в конце.', 'Модель отвечает и ставит ссылки [1], [2].', 'Проверка: каждая цифра ответа есть в источнике (groundedness).', '4 куска по 500 токенов = 2 000 токенов входа сверху — цена и задержка LLM.'],
        watch: 'Внизу справа — собранный контекст и ответ модели со ссылками; красным — когда модель ответила не по документам.',
        real: 'LangChain, LlamaIndex, Haystack; оценка RAG — Ragas, TruLens (faithfulness, context precision, answer relevancy).'
      }
    },
    legend: [['sq xvd-swd', 'Кусок документа (цвет — документ)'], ['xvd-swb', 'Другие куски корпуса'], ['sq xvd-swq', 'Вопрос пользователя'], ['ok', 'Выше порога — в контекст'], ['bad', 'Ниже порога, устарело, выдумка']],
    live: (n, r) => {
      const i = r.info || {}, out = [['Поток', SD.fmt.num(r.rps || 0) + '/с', ''], ['Индекс', (VDB[n.props.index] || VDB.hnsw).name, '']];
      if (i.recall != null) out.push(['Recall', Math.round(i.recall * 100) + ' %', i.recall < 0.95 ? 'warn' : 'ok']);
      if (i.mem) out.push(['Память', `${nf(i.mem.needGb)} из ${nf(i.mem.have)} ГБ`, i.mem.ok ? 'ok' : 'bad']);
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xvdSt"></g><g id="xvdDy" class="xvd-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xvdSt'), gDy = ctx.svg.querySelector('#xvdDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {}, kq: 0 };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const L = () => (SD.app && SD.app.A && SD.app.A.level) || {};
      const IX = () => VDB[P().index] || VDB.hnsw;
      const corpusM = () => ((L().ai || {}).corpusM || 2) * (S.scn === 'grow' ? 10 : 1);
      const mem = () => { const need = corpusM() * IX().kb, have = (P().count || 1) * 64; return { need, have, ok: need <= have }; };
      const latency = () => IX().lat * (P().index === 'hnsw' && !mem().ok ? 6 : 1) * (P().index === 'flat' ? corpusM() / 2 : 1);
      const embedNode = () => { const G = SD.app.A.graph, ps = G.edges.filter(e => e.to === ctx.node.id).map(e => e.from); const e2 = G.edges.find(e => ps.includes(e.from) && (G.nodes.find(n => n.id === e.to) || {}).type === 'embed'); return e2 ? G.nodes.find(n => n.id === e2.to) : null; };

      /* какие куски сейчас в индексе */
      function corpus() {
        let list = CH.map(c => Object.assign({}, c, { ver: 1 }));
        if (S.scn === 'stale') {
          const i = list.findIndex(c => c.id === 'tr-1'), old = list[i];
          const neu = Object.assign({}, old, { id: 'tr-1·v2', text: 'С 1 июня перевод на карту другого банка — 0,5 %, не меньше 30 ₽.', p: [old.p[0] + 0.07, old.p[1] - 0.05], ver: 2, fresh: true });
          old.old = true; old.text = 'Переводы на карты других банков: комиссия 1 %, не меньше 50 ₽ (тариф до 1 июня).';
          list.splice(i + 1, 0, neu);
          if (S.reindexed) list = list.filter(c => !c.old);
        }
        if (S.scn === 'chunk') {
          const tr = list.filter(c => c.d === 'tr'), rest = list.filter(c => c.d !== 'tr'), d = DOCS[0].c;
          if (S.chunk === 100) {
            const parts = [['Переводы на карты других банков: комиссия', [d[0] - 0.02, d[1]]], ['1 %, не меньше 50 ₽. Через СБП —', [d[0] + 0.38, d[1] - 0.42]], ['бесплатно до 100 000 ₽ в месяц, сверх —', [d[0] + 0.2, d[1] + 0.06]], ['0,5 %. Переводы между своими', [d[0] - 0.16, d[1] + 0.12]], ['счетами — без комиссии и мгновенно.', [d[0] + 0.1, d[1] - 0.18]], ['Лимит переводов в сутки — 300 000 ₽,', [d[0] - 0.12, d[1] - 0.2]]];
            list = parts.map(([text, p], i) => ({ id: `tr-${i + 1}`, d: 'tr', n: i + 1, text, p, tok: 100, small: true })).concat(rest);
          } else if (S.chunk === 2000) {
            list = [{ id: 'tr+cd', d: 'tr', n: 1, text: 'Тарифы на переводы и карты целиком: комиссии, СБП, лимиты, обслуживание, кэшбэк, блокировка… (2 000 токенов)', p: [-0.38, 0.32], tok: 2000, big: true }].concat(rest.filter(c => c.d !== 'cd'));
          } else list = tr.concat(rest);
        }
        return list;
      }
      function curQ() {
        if (S.scn === 'stale' || S.scn === 'chunk') return Object.assign({}, QS[0], { p: qPos(QS[0]) });
        if (S.scn === 'offbase') { const o = OFFQ[S.kq % 2]; return { q: o.q, p: o.p, hall: o.hall, off: true }; }
        const q = QS[S.kq % QS.length]; return Object.assign({}, q, { p: qPos(q) });
      }
      function qPos(q) { const c = CH.find(x => x.id === q.near); return [c.p[0] + 0.05, c.p[1] + 0.045]; }
      const useTh = () => S.scn !== 'offbase' || S.thOn;

      /* поиск: ближайшие, recall приближённого индекса, порог */
      function search(q) {
        const list = corpus().map(c => Object.assign({}, c, { sim: simOf(q.p, c.p) })).sort((a, b) => b.sim - a.sim);
        let missed = null;
        if (P().index !== 'flat' && !q.off && (S.scn === 'norm' || S.scn === 'grow') && Math.random() > IX().recall) { missed = list[0]; list.shift(); }
        const top = list.slice(0, K).map(c => Object.assign(c, { pass: !useTh() || c.sim >= TH }));
        return { top, missed, best: top[0] ? top[0].sim : 0 };
      }
      function answerOf(q, res) {
        const ctxs = res.top.filter(c => c.pass);
        if (!ctxs.length) return { text: 'В документах банка нет ответа на этот вопрос. Могу подсказать про переводы, карты, вклады и кредиты.', kind: 'idk' };
        if (q.off) return { text: q.hall, kind: 'hall' };
        if (S.scn === 'stale') { const first = ctxs[0]; return first.old ? { text: 'Перевод на карту другого банка стоит 1 %, не меньше 50 ₽ [1].', kind: 'stale' } : { text: 'С 1 июня перевод на карту другого банка стоит 0,5 %, не меньше 30 ₽ [1].', kind: 'ok' }; }
        if (S.scn === 'chunk' && S.chunk === 100) return { text: 'Комиссия за перевод на карту другого банка есть [1], но её размер в найденных документах не указан.', kind: 'partial' };
        if (S.scn === 'chunk' && S.chunk === 2000) return { text: q.ans + ' (контекст — 8 000 токенов, втрое дороже)', kind: 'ok', heavy: true };
        if (res.missed) return { text: q.ans.replace('[1]', '[2]'), kind: 'ok', missed: true };
        return { text: q.ans, kind: 'ok' };
      }

      /* ---------- цикл одного вопроса ---------- */
      const CYC = 7200;
      function newQuery() {
        const q = curQ(), res = search(q), ans = answerOf(q, res);
        S.Q = { q, res, ans, t0: S.t, hops: hopsFor(q) };
        S.kq++;
      }
      function hopsFor(q) {   // путь жадного спуска на карте: вход → средние узлы → ближайший
        const entry = [-0.85, 0.75], pts = [entry], all = BG.concat(CH.map(c => c.p));
        let cur = entry;
        for (let i = 0; i < 3; i++) { const cands = all.filter(p => Math.hypot(p[0] - cur[0], p[1] - cur[1]) < 0.9 && Math.hypot(p[0] - q.p[0], p[1] - q.p[1]) < Math.hypot(cur[0] - q.p[0], cur[1] - q.p[1]) - 0.1); if (!cands.length) break; cands.sort((a, b) => Math.hypot(a[0] - q.p[0], a[1] - q.p[1]) - Math.hypot(b[0] - q.p[0], b[1] - q.p[1])); cur = cands[Math.min(cands.length - 1, 2 - i)]; pts.push(cur); }
        return pts;
      }
      function finishQuery() {
        const Q = S.Q; if (!Q || Q.fin) return; Q.fin = 1;
        const a = Q.ans, top = Q.res.top;
        S.log.unshift({ q: Q.q.q, best: Q.res.best, kind: a.kind, n: top.filter(c => c.pass).length }); if (S.log.length > 4) S.log.pop();
        S.ev.push({ t: S.t, kind: a.kind, best: Q.res.best });
        if (Q.res.missed) note('miss', `<b>Приближённый индекс пропустил лучший кусок</b> «${ES(cut(Q.res.missed.text, 50))}» — так проявляется recall ${Math.round(IX().recall * 100)} %. Ответ собран по следующим кускам.`, 'warn', 8000);
        if (a.kind === 'stale') { S.flags.staleSeen = 1; note('st', '<b>Ответ по устаревшему тарифу:</b> в индексе две версии документа, и старая оказалась ближе к вопросу. Клиенту назвали 1 % вместо 0,5 %. Нужно удалить старые куски по doc_id и версии — переиндексировать.', 'bad', 6000); }
        if (a.kind === 'ok' && S.scn === 'stale' && S.reindexed) { done('stale'); note('st2', '<b>После переиндексации ответ верный:</b> старые куски тарифа удалены по doc_id, новая версия на месте.', 'ok', 6000); }
        if (a.kind === 'partial') note('ch', '<b>Цифра оторвалась от смысла:</b> кусок «…комиссия» близок к вопросу, а кусок «1 %, не меньше 50 ₽» — нет. Модель честно не знает размер комиссии.', 'warn', 6000);
        if (S.scn === 'chunk' && S.chunk === 500 && S.flags.chunkSwitched && a.kind === 'ok') { done('chunk'); note('ch2', '<b>Куски по 500 токенов с перекрытием:</b> «комиссия 1 %, не меньше 50 ₽» — в одном куске, ответ с цифрой и ссылкой.', 'ok', 6000); }
        if (a.heavy) note('ch3', '<b>Куски по 2 000 токенов:</b> ответ есть, но каждый кусок — обо всём сразу: близость ниже, а контекст в 4 раза длиннее и дороже.', 'warn', 6000);
        if (a.kind === 'hall') note('hall', `<b>Модель выдумала ответ:</b> ничего близкого в базе нет (лучшая близость ${nf(Q.res.best, 2)}), но куски всё равно ушли в промпт, и модель сочинила правдоподобное. Нужен порог и инструкция «не знаю».`, 'bad', 6000);
        if (a.kind === 'idk' && S.scn === 'offbase') { done('offbase'); note('idk', `<b>Честное «не знаю»:</b> лучшая близость ${nf(Q.res.best, 2)} ниже порога ${nf(TH, 2)} — модель не получила мусор и не выдумала ответ.`, 'ok', 6000); }
      }

      /* ---------- рисование ---------- */
      const mp = p => [MB.x + MB.w / 2 + p[0] * (MB.w / 2 - 34), MB.y + 40 + (MB.h - 60) / 2 - p[1] * ((MB.h - 60) / 2 - 16)];
      const colOf = d => (DOCS.find(x => x.id === d) || DOCS[0]).col;
      function badges() {
        const m = mem(), bs = [['chunk', 'НАРЕЗКА', S.scn === 'chunk' ? `по ${nf(S.chunk)} токенов` : '500 токенов, внахлёст 50'], ['embed', 'ЭМБЕДДИНГ', '1 536 чисел на кусок'], ['hnsw', 'ИНДЕКС', `${IX().name} · ${nf(latency())} мс`], ['topk', 'TOP-K И ПОРОГ', `k = ${K}, порог ${useTh() ? nf(TH, 2) : 'выключен'}`]];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xvd-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xvd-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xvd-badge' + (k === 'hnsw' && !m.ok ? ' bad' : ''), 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s' + (k === 'hnsw' && !m.ok ? ' xvd-bad' : ''))}</g>`; });
        return s;
      }
      function docsSvg() {
        const b = DB, list = corpus();
        let s = `<g class="xr-part" data-xpart="chunk">${R(b.x, b.y, b.w, b.h, 'xr-zone', 12)}${T(b.x + 10, b.y + 18, 'ДОКУМЕНТЫ → КУСКИ', 'xr-m')}`;
        let y = b.y + 30;
        DOCS.forEach(d => {
          const cs = list.filter(c => c.d === d.id), vis = cs.slice(0, 3), rows = Math.max(1, vis.length);
          s += `<rect x="${b.x + 10}" y="${y}" width="5" height="${14 + rows * 17}" rx="2" style="fill:var(${d.col})"/>` + T(b.x + 22, y + 11, ES(d.name), 'xvd-fn');
          if (!cs.length) s += T(b.x + 22, y + 24, list.some(c => c.big) ? '— вошли в большой кусок выше' : '—', 'xvd-ms');
          vis.forEach((c, j) => { const yy = y + 18 + j * 17, hot = S.Q && S.Q.res.top.some(t => t.id === c.id && t.pass), more = j === 2 && cs.length > 3; s += R(b.x + 22, yy - 1, b.w - 34, 15, 'xvd-chip' + (c.old ? ' old' : c.fresh ? ' fresh' : '') + (hot ? ' hot' : ''), 3) + T(b.x + 26, yy + 10.5, ES(more ? `… и ещё ${cs.length - 2} ${pl(cs.length - 2, 'кусок', 'куска', 'кусков')}` : cut(c.text, 29)), 'xvd-ct'); });
          y += 22 + rows * 17;
        });
        s += T(b.x + 10, b.y + b.h - 8, `≈ ${nf(corpusM())} млн кусков в корпусе`, 'xvd-ms');
        return s + '</g>';
      }
      function mapSvg() {
        const b = MB, Q = S.Q, list = corpus();
        let s = `<g class="xr-part" data-xpart="embed">${R(b.x, b.y, b.w, b.h, 'xr-zone', 12)}${T(b.x + 10, b.y + 18, 'ПРОСТРАНСТВО СМЫСЛОВ (2D-ПРОЕКЦИЯ)', 'xr-m')}${T(b.x + b.w - 10, b.y + 18, 'близко = похоже по смыслу', 'xvd-ms', 'end')}`;
        BG.forEach(p => { const [x, y] = mp(p); s += `<circle class="xvd-bg" cx="${f1(x)}" cy="${f1(y)}" r="2.6"/>`; });
        DOCS.forEach(d => { const [x, y] = mp([d.c[0], d.c[1] + 0.3]); s += T(x, y, ES(d.name), 'xvd-cl', 'middle'); });
        const u = Q ? S.t - Q.t0 : 0, ph = !Q ? -1 : u < 900 ? 0 : u < 1500 ? 1 : u < 3000 ? 2 : u < 4000 ? 3 : 4;
        if (Q && ph >= 2) {
          if (P().index === 'flat') { const k2 = clamp((u - 1500) / 1500, 0, 1), [qx, qy] = mp(Q.q.p); s += `<circle class="xvd-sweep" cx="${f1(qx)}" cy="${f1(qy)}" r="${f1(k2 * 260)}" opacity="${(1 - k2 * 0.7).toFixed(2)}"/>`; }
          else { const hs = Q.hops.concat([Q.q.p]), k2 = clamp((u - 1500) / 1500, 0, 1) * (hs.length - 1); for (let i = 0; i < hs.length - 1 && i < k2; i++) { const a = mp(hs[i]), c2 = mp(hs[i + 1]), kk = clamp(k2 - i, 0, 1); s += Ln(a[0], a[1], ...lerp(a, c2, kk), 'xvd-hop'); s += `<circle class="xvd-hopn" cx="${f1(a[0])}" cy="${f1(a[1])}" r="5"/>`; } }
        }
        list.forEach(c => {
          const [x, y] = mp(c.p), inTop = Q && ph >= 3 && Q.res.top.find(t => t.id === c.id), miss = Q && ph >= 3 && Q.res.missed && Q.res.missed.id === c.id;
          const r = c.big ? 11 : c.small ? 4 : 6;
          s += `<circle class="xvd-pt${c.old ? ' old' : ''}${inTop ? (inTop.pass ? ' top' : ' low') : ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}" style="fill:var(${colOf(c.d)})"/>`;
          if (c.old) s += T(x - 9, y - 8, 'v1, устарел', 'xvd-pn xvd-bad', 'end');
          if (c.fresh) s += T(x + 9, y + 14, 'v2', 'xvd-pn xvd-ok');
          if (c.small && c.text.startsWith('1 %')) s += T(x, y + 20, '«1 %…» — далеко', 'xvd-pn xvd-warn', 'middle');
          if (miss) s += `<circle class="xvd-miss" cx="${f1(x)}" cy="${f1(y)}" r="11"/>` + T(x, y - 14, 'пропущен', 'xvd-pn xvd-warn', 'middle');
        });
        if (Q && ph >= 1) {
          const [qx, qy] = mp(Q.q.p), k1 = clamp((u - 900) / 600, 0, 1), y0 = qy - 60 * (1 - ease(k1));
          if (ph >= 3) Q.res.top.forEach((c, i) => { const [x, y] = mp(c.p), kk = clamp((u - 3000 - i * 150) / 400, 0, 1); const low = !c.pass || c.sim < TH; s += Ln(qx, qy, ...lerp([qx, qy], [x, y], kk), 'xvd-knn' + (low ? ' low' : '')); if (kk >= 1 && i === 0) s += T(x - 8, y + 18, nf(c.sim, 2), 'xvd-sim' + (low ? ' low' : ''), 'end'); });
          s += STAR(qx, y0, 10, Q.q.off ? 'off' : '');
        }
        s += T(b.x + 10, b.y + b.h - 10, 'на самом деле точек — миллионы, а чисел у вектора — 1 536', 'xvd-ms');
        return s + '</g>';
      }
      function qSvg() {
        const b = QB, Q = S.Q, e = embedNode();
        let s = R(b.x, b.y, b.w, b.h, 'xr-box', 12) + T(b.x + 10, b.y + 18, 'ВОПРОС → ВЕКТОР', 'xr-m') + T(b.x + b.w - 10, b.y + 18, e ? ES(cut(ctx.nm(e.id), 18)) : 'эмбеддинги', 'xvd-ms', 'end');
        if (!Q) return s + T(b.x + 10, b.y + 44, 'ждём вопрос…', 'xr-s');
        wrap(Q.q.q, 36).slice(0, 2).forEach((l, j) => { s += T(b.x + 10, b.y + 40 + j * 15, ES(l), 'xr-t xvd-qt'); });
        const u = S.t - Q.t0, k = clamp(u / 800, 0, 1), nums = [0.12, -0.03, 0.41, 0.07], shown = Math.ceil(k * nums.length);
        s += MONO(b.x + 10, b.y + 92, '[' + nums.slice(0, shown).map(v => (v >= 0 ? ' ' : '') + v.toFixed(2)).join(',') + (k >= 1 ? ', … ×1 536]' : ''), 'on');
        s += T(b.x + 10, b.y + 114, k >= 1 ? `эмбеддинг ${e && e.props.hosting === 'self' ? 15 : 60} мс → поиск ${nf(latency())} мс` : 'считаем вектор…', 'xvd-ms' + (latency() > 100 ? ' xvd-warn' : ''));
        s += T(b.x + 10, b.y + 136, 'та же модель, что у документов', 'xvd-ms');
        return s;
      }
      function topSvg() {
        const b = KB, Q = S.Q;
        let s = `<g class="xr-part" data-xpart="topk">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 10, b.y + 18, `TOP-${K} ПО БЛИЗОСТИ`, 'xr-m')}${T(b.x + b.w - 10, b.y + 18, useTh() ? `порог ${nf(TH, 2)}` : 'порога нет', 'xvd-ms' + (useTh() ? '' : ' xvd-warn'), 'end')}`;
        const u = Q ? S.t - Q.t0 : 0;
        if (!Q || u < 3000) return s + T(b.x + 10, b.y + 44, Q ? 'ищем ближайших…' : 'ждём вопрос…', 'xr-s') + '</g>';
        const X0 = b.x + 150, W = b.w - 196, xs = v => X0 + clamp((v - 0.4) / 0.6, 0, 1) * W;
        if (useTh()) s += Ln(xs(TH), b.y + 28, xs(TH), b.y + 30 + K * 34, 'xvd-th');
        Q.res.top.forEach((c, i) => {
          const y = b.y + 30 + i * 34, kk = clamp((u - 3000 - i * 150) / 400, 0, 1);
          s += `<rect x="${b.x + 10}" y="${y + 3}" width="5" height="22" rx="2" style="fill:var(${colOf(c.d)})"/>` + T(b.x + 20, y + 13, ES(cut(c.text, 18)), 'xvd-ct') + T(b.x + 20, y + 26, `${c.id}${c.old ? ' · v1' : ''}`, 'xvd-pn' + (c.old ? ' xvd-bad' : ''));
          s += R(X0, y + 8, W, 10, 'xr-bar', 3) + R(X0, y + 8, (xs(c.sim) - X0) * kk, 10, 'xr-bar-f' + (c.pass ? '' : ' bad'), 3) + T(b.x + b.w - 10, y + 17, nf(c.sim, 2), 'xvd-pn' + (c.pass ? ' xvd-ok' : ' xvd-bad'), 'end');
        });
        const n = Q.res.top.filter(c => c.pass).length;
        s += T(b.x + 10, b.y + b.h - 10, n ? `в контекст: ${n} ${pl(n, 'кусок', 'куска', 'кусков')} · ${nf(Q.res.top.filter(c => c.pass).reduce((a, c) => a + c.tok, 0))} токенов` : 'ничего не прошло порог', 'xvd-ms' + (n ? '' : ' xvd-warn'));
        return s + '</g>';
      }
      function idxSvg() {
        const b = IB, m = mem(), ix = IX(), lat = latency();
        let s = `<g class="xr-part" data-xpart="hnsw">${R(b.x, b.y, b.w, b.h, 'xr-box' + (m.ok ? '' : ' bad'), 10)}${T(b.x + 12, b.y + 18, `ИНДЕКС ${ix.name.toUpperCase()}`, 'xr-m')}${T(b.x + b.w - 12, b.y + 18, `${P().count} ${pl(P().count, 'узел', 'узла', 'узлов')} × 64 ГБ`, 'xvd-ms', 'end')}`;
        const checked = P().index === 'flat' ? corpusM() * 1e6 : P().index === 'ivf' ? 20000 : 320;
        s += T(b.x + 12, b.y + 42, `проверено ≈ ${nf(checked)} из ${nf(corpusM() * 1e6)} векторов`, 'xvd-ms');
        s += T(b.x + 12, b.y + 62, `поиск ${nf(lat)} мс · recall ${Math.round(ix.recall * 100)} %`, 'xr-t' + (lat > 100 ? ' xvd-bad' : ''));
        s += T(b.x + 12, b.y + 86, `память: нужно ${nf(m.need)} ГБ, есть ${nf(m.have)} ГБ`, 'xvd-ms' + (m.ok ? '' : ' xvd-bad')) + R(b.x + 12, b.y + 94, b.w - 24, 8, 'xr-bar', 3) + R(b.x + 12, b.y + 94, (b.w - 24) * clamp(m.need / m.have, 0, 1), 8, 'xr-bar-f' + (m.ok ? (m.need / m.have > 0.8 ? ' warn' : '') : ' bad'), 3);
        s += T(b.x + 12, b.y + 122, !m.ok && P().index === 'hnsw' ? 'граф не влез в RAM — читается с диска, поиск ×6' : P().index === 'flat' ? 'полный перебор: точно, но медленно на больших корпусах' : P().index === 'ivf' ? 'векторы сжаты в 8 раз, точность чуть ниже' : 'многослойный граф в памяти: миллисекунды', 'xvd-ms' + (!m.ok ? ' xvd-bad' : ''));
        s += T(b.x + 12, b.y + 140, `${ix.kb} КБ на вектор с индексом · корпус ${nf(corpusM())} млн кусков`, 'xvd-ms');
        return s + '</g>';
      }
      function ansSvg() {
        const b = AB, Q = S.Q;
        let s = `<g class="xr-part" data-xpart="rag">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}${T(b.x + 12, b.y + 18, 'КОНТЕКСТ ДЛЯ LLM → ОТВЕТ СО ССЫЛКАМИ', 'xr-m')}`;
        const u = Q ? S.t - Q.t0 : 0;
        if (!Q || u < 4000) return s + T(b.x + 12, b.y + 44, Q ? 'собираем контекст…' : 'ждём вопрос…', 'xr-s') + '</g>';
        const ctxs = Q.res.top.filter(c => c.pass);
        if (Q.q.off && !useTh()) Q.res.top.slice(0, 3).forEach((c, i) => { s += MONO(b.x + 12, b.y + 40 + i * 16, `[${i + 1}] ${ES(cut(c.text, 46))} · ${nf(c.sim, 2)}`, 'bad'); });
        else if (!ctxs.length) s += MONO(b.x + 12, b.y + 40, '(контекст пуст: ничего не прошло порог)', 'dim');
        else ctxs.slice(0, 3).forEach((c, i) => { s += MONO(b.x + 12, b.y + 40 + i * 16, `[${i + 1}] ${ES(cut((DOCS.find(d => d.id === c.d) || {}).name + ': ' + c.text, 68))}`, c.old ? 'bad' : 'dim'); });
        const k = clamp((u - 4300) / 2000, 0, 1), words = Q.ans.text.split(' '), shown = words.slice(0, Math.ceil(words.length * k)).join(' ');
        const cls = { ok: 'xvd-ok', idk: 'xvd-acc', hall: 'xvd-bad', stale: 'xvd-bad', partial: 'xvd-warn' }[Q.ans.kind] || '';
        s += R(b.x + 10, b.y + 92, b.w - 20, 50, 'xvd-bubble ' + Q.ans.kind, 8);
        wrap(shown + (k < 1 ? '▍' : ''), 84).slice(0, 2).forEach((l, j) => { s += T(b.x + 20, b.y + 110 + j * 16, ES(l), 'xvd-ans'); });
        if (k >= 1) s += T(b.x + b.w - 16, b.y + 138, { ok: 'по документам', idk: 'честно: не знаю', hall: 'выдумка', stale: 'устаревший тариф', partial: 'неполно' }[Q.ans.kind] || '', 'xvd-pn ' + cls, 'end');
        return s + '</g>';
      }
      function ctlSvg() {   // кнопки ситуации — поверх карты внизу
        const y = MB.y + 50, x = MB.x + 10;
        if (S.scn === 'stale') return BTN(x, y - 18, 220, 'reidx', S.reindexed ? 'тариф переиндексирован ✓' : 'переиндексировать тариф', S.reindexed);
        if (S.scn === 'chunk') return [[100, 'по 100'], [500, 'по 500 + перекрытие'], [2000, 'по 2 000']].map(([v, l], i) => BTN(x + [0, 74, 222][i], y - 18, [70, 144, 80][i], 'ch' + v, l, S.chunk === v)).join('');
        if (S.scn === 'offbase') return BTN(x, y - 18, 240, 'th', S.thOn ? 'порог 0,75 и «не знаю» — включено' : 'включить порог 0,75 и «не знаю»', S.thOn);
        return '';
      }
      function drawMain() { gSt.innerHTML = badges() + docsSvg() + mapSvg() + qSvg() + topSvg() + idxSvg() + ansSvg() + ctlSvg(); gDy.innerHTML = ''; }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 128, 26, 'xvd-backb', 13)}${T(76, 27, '← вся база', 'xr-s xvd-back', 'middle')}</g>` + T(156, 27, t, 'xvd-vt') + T(156, 46, sub, 'xr-s');
      function vChunk() {
        const doc = 'Тарифы на переводы. 2.1. Переводы на карты других банков: комиссия 1 %, не меньше 50 ₽. 2.2. Через СБП — бесплатно до 100 000 ₽ в месяц, сверх — 0,5 %. 2.3. Переводы между своими счетами — без комиссии и мгновенно. 2.4. Лимит переводов в сутки — 300 000 ₽.';
        const C = 9000, u = S.vt % C, k = clamp(u / 4000, 0, 1);
        let s = head('Нарезка документов на куски', 'один документ — три способа нарезки; хороший кусок — законченная мысль с цифрами и метаданными');
        s += R(24, 60, 952, 70, 'xvd-panel', 10) + T(36, 82, 'ДОКУМЕНТ', 'xr-m');
        wrap(doc, 132).forEach((l, j) => { s += T(36, 102 + j * 16, ES(l), 'xr-s'); });
        const lanes = [
          ['Фиксированно по 100 токенов', ['Тарифы на переводы. 2.1. Переводы на карты', 'других банков: комиссия', '1 %, не меньше 50 ₽. 2.2. Через СБП —', 'бесплатно до 100 000 ₽ в месяц,', 'сверх — 0,5 %. 2.3. Переводы между', 'своими счетами — без комиссии…'], 'bad', 'цифра «1 %» оторвалась от слов «комиссия» и «другие банки»'],
          ['По разделам, ≈ 500 токенов, перекрытие 50', ['2.1. Переводы на карты других банков: комиссия 1 %, не меньше 50 ₽.', '2.2. Через СБП — бесплатно до 100 000 ₽ в месяц, сверх — 0,5 %.', '2.3–2.4. Свои счета — без комиссии. Лимит — 300 000 ₽ в сутки.'], 'ok', 'каждый кусок — законченное правило с цифрой'],
          ['Крупно, по 2 000 токенов', ['Тарифы на переводы и карты целиком: комиссии, СБП, свои счета, лимиты, обслуживание карт, кэшбэк, блокировка…'], 'warn', 'кусок обо всём: близость к вопросу ниже, контекст длиннее']
        ];
        lanes.forEach(([title, parts, cls, why], j) => {
          const y = 142 + j * 112;
          s += R(24, y, 952, 104, 'xvd-panel' + (cls === 'ok' ? ' on' : ''), 10) + T(36, y + 20, title, 'xr-t') + T(964, y + 20, why, 'xvd-ms xvd-' + cls, 'end');
          let x = 36, yy = y + 32; const shown = Math.ceil(parts.length * k);
          parts.slice(0, shown).forEach((p, i) => { const w = Math.min(900, p.length * 6.4 + 16); if (x + w > 964) { x = 36; yy += 30; } s += R(x, yy, w, 24, 'xvd-piece r' + (i % 4), 5) + T(x + 8, yy + 16, ES(p), 'xvd-ct'); x += w + 6; });
        });
        s += R(24, 480, 952, 68, 'xvd-codebg', 10);
        ['{"doc_id": "tariff-transfers", "version": 2, "section": "2.1", "valid_from": "2026-06-01",', ' "access": "public", "text": "Переводы на карты других банков: комиссия…", "vector": [0.12, -0.03, …]}'].forEach((l, j) => { s += MONO(36, 504 + j * 22, ES(l), j ? '' : 'on'); });
        return s;
      }
      const PH = [['перевод на карту другого банка', [-0.55, -0.1]], ['отправить деньги на карту чужого банка', [-0.48, -0.16]], ['комиссия за перевод', [-0.62, 0.05]], ['заблокировать карту', [-0.15, 0.6]], ['ставка по вкладу', [0.55, 0.45]], ['рецепт борща', [0.1, -0.85]]];
      function vEmbed() {
        const C = 8000, u = S.vt % C, k = clamp(u / 3000, 0, 1), shown = Math.ceil(PH.length * k);
        let s = head('Эмбеддинги: текст → точка в пространстве смыслов', 'похожие по смыслу тексты дают близкие векторы, даже если слова разные');
        s += R(24, 60, 470, 488, 'xvd-panel', 10) + T(36, 82, 'ТЕКСТ → МОДЕЛЬ → ВЕКТОР', 'xr-m');
        PH.slice(0, shown).forEach(([t], i) => { const y = 108 + i * 70; s += T(36, y, `«${ES(t)}»`, 'xr-t') + MONO(36, y + 20, `[${[0.12, -0.31, 0.07, 0.44, -0.09].map((v, j) => ((v * (i + 2) * (j % 2 ? -1 : 1)) % 0.6).toFixed(2)).join(', ')}, … ×1 536]`, 'dim'); });
        s += R(506, 60, 470, 300, 'xvd-panel on', 10) + T(518, 82, 'ПРОЕКЦИЯ НА ПЛОСКОСТЬ', 'xr-m');
        const mp2 = p => [741 + p[0] * 190, 214 - p[1] * 120];
        PH.slice(0, shown).forEach(([t, p], i) => { const [x, y] = mp2(p); s += Dot(x, y, 6, '', `fill:var(${i < 3 ? '--k-read' : i === 3 ? '--k-write' : i === 4 ? '--k-upload' : '--text-muted'})`) + T(x + 9, y + 4 + (i === 1 ? 14 : i === 0 ? -6 : i === 2 ? -8 : 0), ES(cut(t, 26)), 'xvd-pn'); });
        s += R(506, 372, 470, 176, 'xvd-codebg', 10) + T(518, 394, 'КОСИНУСНАЯ БЛИЗОСТЬ', 'xr-m');
        const pairs = [[0, 1], [0, 2], [0, 3], [0, 5]];
        pairs.forEach(([a, b2], j) => { const v = simOf(PH[a][1], PH[b2][1]); s += MONO(518, 420 + j * 30, `${cut(PH[a][0], 16).padEnd(17)}↔ ${cut(PH[b2][0], 22).padEnd(23)}${nf(v, 2)}`, v >= TH ? 'on' : 'dim'); });
        return s;
      }
      function vKnn() {
        const q = QS[S.knnQ % QS.length], qp = qPos(q), list = CH.map(c => Object.assign({}, c, { sim: simOf(qp, c.p) })).sort((a, b) => b.sim - a.sim), top = list.slice(0, K);
        let s = head('Ближайшие соседи по косинусной близости', 'поиск по смыслу: берём k кусков, чьи векторы ближе всего к вектору вопроса');
        s += R(24, 60, 560, 488, 'xvd-panel on', 10);
        const mp3 = p => [304 + p[0] * 230, 300 - p[1] * 200];
        BG.forEach(p => { const [x, y] = mp3(p); s += `<circle class="xvd-bg" cx="${f1(x)}" cy="${f1(y)}" r="2.6"/>`; });
        const [qx, qy] = mp3(qp);
        top.forEach(c => { const [x, y] = mp3(c.p); s += Ln(qx, qy, x, y, 'xvd-knn') + T((qx + x) / 2 + 4, (qy + y) / 2 - 3, nf(c.sim, 2), 'xvd-sim'); });
        CH.forEach(c => { const [x, y] = mp3(c.p), it = top.find(t => t.id === c.id); s += `<circle class="xvd-pt${it ? ' top' : ''}" cx="${f1(x)}" cy="${f1(y)}" r="6" style="fill:var(${colOf(c.d)})"/>`; });
        s += STAR(qx, qy, 11, '');
        QS.forEach((qq, i) => { s += BTN(36 + i * 136, 512, 130, 'q' + i, cut(qq.q, 20), S.knnQ % QS.length === i); });
        s += R(596, 60, 380, 300, 'xvd-panel', 10) + T(608, 82, `«${ES(cut(q.q, 44))}»`, 'xr-t');
        list.slice(0, 7).forEach((c, i) => { const y = 104 + i * 36; s += `<rect x="608" y="${y}" width="5" height="26" rx="2" style="fill:var(${colOf(c.d)})"/>` + T(620, y + 11, ES(cut(c.text, 46)), 'xvd-ct') + R(620, y + 17, 290, 7, 'xr-bar', 3) + R(620, y + 17, 290 * clamp((c.sim - 0.3) / 0.7, 0, 1), 7, 'xr-bar-f' + (i < K ? '' : ' bad'), 3) + T(964, y + 24, nf(c.sim, 2), 'xvd-pn' + (i < K ? ' xvd-ok' : ''), 'end'); });
        s += R(596, 372, 380, 176, 'xvd-codebg', 10);
        ['-- pgvector: 4 ближайших по косинусу', 'SELECT id, text,', '  1 - (embedding <=> :q) AS sim', 'FROM chunks', "WHERE version = 'current'", 'ORDER BY embedding <=> :q', 'LIMIT 4;'].forEach((l, j) => { s += MONO(608, 396 + j * 21, ES(l), j ? '' : 'dim'); });
        return s;
      }
      /* граф HNSW: три слоя, жадный спуск */
      const HN = (() => { let sd = 11; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }; const L0 = []; for (let i = 0; i < 34; i++) L0.push([r() * 2 - 1, r() * 2 - 1]); const L1 = L0.filter((_, i) => i % 3 === 0), L2 = L0.filter((_, i) => i % 9 === 0); return [L0, L1, L2]; })();
      function vHnsw() {
        const t0 = HN[0].reduce((a, p) => Math.hypot(p[0] - 0.35, p[1] + 0.3) < Math.hypot(a[0] - 0.35, a[1] + 0.3) ? p : a), target = [t0[0] + 0.05, t0[1] + 0.07], C = 11000, u = S.vt % C, layers = HN, bands = [[396, 128], [246, 128], [96, 128]];
        let s = head('Индекс HNSW: жадный спуск по слоям графа', 'верхние слои — редкие точки и длинные прыжки, нижний — все точки; проверяем сотни векторов вместо миллионов');
        const mpL = (L, p) => [60 + (p[0] + 1) / 2 * 560, bands[L][0] + 14 + (p[1] + 1) / 2 * (bands[L][1] - 28)];
        // путь
        const path = []; let cur = layers[2][0];
        for (let L = 2; L >= 0; L--) { let moved = true; path.push([L, cur]); while (moved) { moved = false; const pts = layers[L].filter(p => Math.hypot(p[0] - cur[0], p[1] - cur[1]) < 1.1); const best = pts.reduce((a, p) => Math.hypot(p[0] - target[0], p[1] - target[1]) < Math.hypot(a[0] - target[0], a[1] - target[1]) ? p : a, cur); if (best !== cur) { cur = best; path.push([L, cur]); moved = true; } } }
        const steps = Math.min(path.length, Math.floor(u / 700) + 1);
        [2, 1, 0].forEach(L => {
          const [y0, h] = bands[L];
          s += R(24, y0, 620, h, 'xvd-panel' + (path[steps - 1][0] === L ? ' on' : ''), 10) + T(36, y0 + 18, `слой ${L} · ${layers[L].length} ${pl(layers[L].length, 'точка', 'точки', 'точек')}${L === 0 ? ' (все)' : ''}`, 'xvd-fn');
          const pts = layers[L];
          pts.forEach((p, i) => { pts.slice(i + 1).forEach(q => { if (Math.hypot(p[0] - q[0], p[1] - q[1]) < (L === 0 ? 0.42 : 0.9)) { const a = mpL(L, p), b = mpL(L, q); s += Ln(a[0], a[1], b[0], b[1], 'xvd-edge'); } }); });
          pts.forEach(p => { const [x, y] = mpL(L, p); s += `<circle class="xvd-gn" cx="${f1(x)}" cy="${f1(y)}" r="4"/>`; });
          const [tx, ty] = mpL(L, target); s += STAR(tx, ty, 8, 'dim');
        });
        for (let i = 0; i < steps; i++) {
          const [L, p] = path[i], [x, y] = mpL(L, p);
          if (i > 0) { const [L2, p2] = path[i - 1], [x2, y2] = mpL(L2, p2); s += L2 === L ? Ln(x2, y2, x, y, 'xvd-hop') : Ln(x2, y2, x, y, 'xvd-down'); }
          s += `<circle class="xvd-hopn" cx="${f1(x)}" cy="${f1(y)}" r="6"/>`;
        }
        const fin = steps >= path.length;
        if (fin) { S.pv.hnsw = 1; const [x, y] = mpL(0, path[path.length - 1][1]); s += `<circle class="xvd-miss ok" cx="${f1(x)}" cy="${f1(y)}" r="10"/>` + T(632, bands[0][0] + 18, 'ближайшая найдена ✓', 'xvd-pn xvd-ok', 'end'); }
        s += R(656, 96, 320, 452, 'xvd-panel', 10) + T(668, 118, 'СКОЛЬКО ПРОВЕРИЛИ', 'xr-m');
        s += T(668, 146, `HNSW: ${steps} ${pl(steps, 'шаг', 'шага', 'шагов')} · ≈ ${steps * 12} сравнений`, 'xr-t xvd-ok') + T(668, 168, `Flat: все ${nf(HN[0].length)} точек (в базе — 2 млн)`, 'xr-t xvd-warn');
        [['HNSW', '6 мс', '97 %', '7 КБ'], ['IVF-PQ', '10 мс', '92 %', '1 КБ'], ['Flat', '250 мс', '100 %', '6 КБ']].forEach(([n, l, r, k], j) => { s += MONO(668, 206 + j * 26, `${n.padEnd(8)}${l.padStart(7)}  recall ${r.padStart(5)}  ${k}`, n.toLowerCase().startsWith(P().index === 'ivf' ? 'ivf' : P().index) ? 'on' : ''); });
        ['· поиск начинается в верхнем слое', '· идём к соседу, который ближе к вопросу', '· ближе нет — спускаемся на слой ниже', '· внизу собираем k ближайших', '· recall < 100 %: иногда лучший кусок', '  остаётся в стороне от пути', '· граф держат в RAM — памяти нужно больше'].forEach((l, j) => { s += T(668, 300 + j * 30, l, 'xr-s'); });
        return s;
      }
      function vTopk() {
        const q = S.scn === 'offbase' ? OFFQ[0] : QS[0], qp = q.p || qPos(q), list = CH.map(c => Object.assign({}, c, { sim: simOf(qp, c.p) })).sort((a, b) => b.sim - a.sim).slice(0, 8);
        const k = S.tk || K, th = S.tth == null ? TH : S.tth;
        let s = head('Top-k и порог', `«${q.q}» — сколько кусков брать и где отсечь`);
        s += R(24, 60, 620, 400, 'xvd-panel on', 10) + T(36, 82, `8 БЛИЖАЙШИХ · берём k = ${k}, порог ${nf(th, 2)}`, 'xr-m');
        const X0 = 330, W = 280, xs = v => X0 + clamp((v - 0.3) / 0.7, 0, 1) * W;
        s += Ln(xs(th), 92, xs(th), 440, 'xvd-th') + T(xs(th), 452, `порог ${nf(th, 2)}`, 'xvd-pn xvd-bad', 'middle');
        list.forEach((c, i) => { const y = 96 + i * 44, inK = i < k, pass = inK && c.sim >= th; s += `<rect x="36" y="${y}" width="5" height="30" rx="2" style="fill:var(${colOf(c.d)})"/>` + T(48, y + 13, ES(cut(c.text, 40)), 'xvd-ct' + (inK ? '' : ' dim')) + T(48, y + 27, pass ? 'в контекст' : inK ? 'ниже порога' : 'за пределами k', 'xvd-pn ' + (pass ? 'xvd-ok' : inK ? 'xvd-bad' : '')) + R(X0, y + 10, W, 10, 'xr-bar', 3) + R(X0, y + 10, xs(c.sim) - X0, 10, 'xr-bar-f' + (pass ? '' : ' bad'), 3) + T(636, y + 20, nf(c.sim, 2), 'xvd-pn', 'end'); });
        [2, 4, 8].forEach((v, i) => { s += BTN(36 + i * 70, 470, 64, 'k' + v, 'k = ' + v, k === v); });
        [0.6, 0.75, 0.85].forEach((v, i) => { s += BTN(260 + i * 112, 470, 106, 'p' + v, 'порог ' + nf(v, 2), Math.abs(th - v) < 0.001); });
        const pass = list.slice(0, k).filter(c => c.sim >= th);
        s += T(36, 520, pass.length ? `в контекст ${pass.length} ${pl(pass.length, 'кусок', 'куска', 'кусков')} ≈ ${nf(pass.length * 500)} токенов` : 'ничего не прошло порог → ассистент отвечает «не знаю»', 'xr-s ' + (pass.length ? 'xvd-ok' : 'xvd-acc'));
        s += R(656, 60, 320, 488, 'xvd-panel', 10) + T(668, 82, 'КАК ВЫБИРАЮТ', 'xr-m');
        ['· k мало — нужный факт не попадёт', '· k много — шум, промпт длиннее,', '  ответ дороже и медленнее', '· порог отсекает «отдалённо похожее»', '· ничего не прошло — честное «не знаю»', '· порог подбирают на реальных', '  вопросах, а не на глаз', '· для номеров и кодов добавляют', '  полнотекстовый поиск (гибрид)', '· реранкер переставляет top-k точнее'].forEach((l, j) => { s += T(668, 110 + j * 30, l, 'xr-s'); });
        return s;
      }
      function vRag() {
        const Q = S.Q || { q: QS[0], res: search(Object.assign({}, QS[0], { p: qPos(QS[0]) })), ans: { text: QS[0].ans, kind: 'ok' } };
        const ctxs = Q.res.top.filter(c => c.pass), C = 9000, u = S.vt % C, k = clamp((u - 2500) / 3000, 0, 1);
        let s = head('Контекст для LLM и ответ со ссылками', 'найденные куски кладут в промпт с номерами — модель отвечает по ним и ссылается');
        s += R(24, 60, 952, 300, 'xvd-codebg', 10) + T(36, 82, 'ПРОМПТ', 'xr-m');
        const lines = ['system: Ты ассистент банка. Отвечай ТОЛЬКО по документам ниже.', '        После каждого факта ставь ссылку [n]. Нет ответа в документах —', '        скажи, что не знаешь, и предложи темы, по которым можешь помочь.', ''].concat(ctxs.length ? ctxs.map((c, i) => `[${i + 1}] ${(DOCS.find(d => d.id === c.d) || {}).name}, ${c.id}: ${c.text}`) : ['(документы не найдены: ничего не прошло порог)']).concat(['', `user: ${Q.q.q}`]);
        const shown = Math.ceil(lines.length * clamp(u / 2500, 0, 1));
        lines.slice(0, shown).forEach((l, j) => { s += MONO(36, 108 + j * 21, ES(cut(l, 120)), l.startsWith('[') ? 'on' : l.startsWith('user') ? '' : 'dim'); });
        s += T(964, 82, `≈ ${nf(250 + ctxs.reduce((a, c) => a + c.tok, 0) + 30)} токенов входа`, 'xvd-ms', 'end');
        s += R(24, 372, 952, 90, 'xvd-bubble ' + Q.ans.kind, 10) + T(36, 394, 'ОТВЕТ МОДЕЛИ', 'xr-m');
        const words = Q.ans.text.split(' '); wrap(words.slice(0, Math.ceil(words.length * k)).join(' '), 130).slice(0, 3).forEach((l, j) => { s += T(36, 418 + j * 18, ES(l), 'xvd-ans'); });
        s += R(24, 474, 952, 74, 'xvd-panel', 10) + T(36, 496, 'ПРОВЕРКА ОТВЕТА', 'xr-m');
        s += T(36, 520, k >= 1 ? (Q.ans.kind === 'ok' ? '✓ каждая цифра ответа есть в источнике [n] — ответ обоснован (faithfulness)' : Q.ans.kind === 'idk' ? '✓ ответа в документах нет — модель честно сказала об этом' : '✕ в ответе есть факты, которых нет в источниках или они устарели') : 'ждём ответ…', 'xr-s ' + (k >= 1 ? (Q.ans.kind === 'ok' || Q.ans.kind === 'idk' ? 'xvd-ok' : 'xvd-bad') : ''));
        s += T(36, 540, 'Проверку делают автоматически на наборе вопросов (Ragas, TruLens) и выборочно — людьми.', 'xvd-ms');
        return s;
      }
      const VIEWS = { chunk: vChunk, embed: vEmbed, knn: vKnn, hnsw: vHnsw, topk: vTopk, rag: vRag };
      function partNow(k) {
        if (k === 'chunk') return '<b>Нарезка:</b> кусок должен быть законченной мыслью — правило вместе с цифрой. По разделам, 300–800 токенов, с перекрытием и метаданными (документ, версия, раздел).';
        if (k === 'embed') return '<b>Эмбеддинги:</b> «отправить деньги на карту чужого банка» и «перевод на карту другого банка» — разные слова, но близкие точки. «Рецепт борща» — далеко.';
        if (k === 'knn') return '<b>Ближайшие соседи:</b> берём k кусков с наибольшей косинусной близостью к вектору вопроса. Выбери вопрос из другой темы — звезда переедет к другому облаку.';
        if (k === 'hnsw') return `<b>HNSW</b> спускается по слоям графа: от редких дальних прыжков к точному поиску внизу и проверяет сотни векторов вместо миллионов. Сейчас индекс ${IX().name}: ${nf(latency())} мс, recall ${Math.round(IX().recall * 100)} %.`;
        if (k === 'topk') return '<b>Top-k и порог:</b> мало кусков — факт не попадёт, много — шум и цена. Порог отсекает отдалённо похожее; ничего не прошло — честное «не знаю».';
        if (k === 'rag') return '<b>Контекст и ссылки:</b> куски с номерами идут в промпт, системный промпт требует отвечать только по ним и ставить [n]. Ответ проверяют: каждая цифра должна быть в источнике.';
        return '';
      }

      /* ---------- кнопки ---------- */
      function act(k) {
        if (k === 'reidx') { if (!S.reindexed) { S.reindexed = true; ctx.log('<b>Тариф переиндексирован:</b> старые куски удалены по doc_id и версии, новая версия загружена. Следующий вопрос — уже по новому тарифу.', 'chg'); S.nextAt = Math.min(S.nextAt, S.t + 600); } return; }
        if (k.startsWith('ch')) { const v = +k.slice(2); if (v !== S.chunk) { S.chunk = v; S.flags.chunkSwitched = 1; ctx.log(`<b>Нарезка по ${nf(v)} токенов${v === 500 ? ' с перекрытием' : ''}.</b> Документ переиндексирован.`, 'chg'); S.nextAt = Math.min(S.nextAt, S.t + 600); } return; }
        if (k === 'th') { S.thOn = !S.thOn; ctx.log(S.thOn ? '<b>Порог 0,75 и инструкция «не знаю» включены.</b>' : '<b>Порог выключен:</b> в промпт идут k ближайших, даже если они не про это.', 'chg'); S.nextAt = Math.min(S.nextAt, S.t + 600); return; }
        if (/^q\d$/.test(k)) { const i = +k.slice(1); if (i !== S.knnQ % QS.length) { const before = QS[S.knnQ % QS.length].near.slice(0, 2); S.knnQ = i; if (QS[i].near.slice(0, 2) !== before) done('pknn'); } return; }
        if (/^k\d$/.test(k)) { S.tk = +k.slice(1); return; }
        if (/^p[\d.]+$/.test(k)) { S.tth = +k.slice(1); return; }
      }
      const onClick = ev => { const b = ev.target.closest && ev.target.closest('[data-xvd]'); if (!b) return; ev.stopPropagation(); act(b.dataset.xvd); };
      const onKey = ev => { if (ev.key !== 'Enter' && ev.key !== ' ') return; const b = ev.target.closest && ev.target.closest('[data-xvd]'); if (!b) return; ev.preventDefault(); ev.stopPropagation(); act(b.dataset.xvd); };
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- шаг ---------- */
      function reset() {
        Object.assign(S, { t: 0, Q: null, log: [], ev: [], nextAt: 300, kq: 0, cfgT: 0, knnQ: S.knnQ || 0 });
        if (S.scn === 'stale') S.reindexed = false;
        if (S.scn === 'chunk') { S.chunk = 100; S.flags.chunkSwitched = 0; } else S.chunk = 500;
        if (S.scn === 'offbase') S.thOn = false;
      }
      function tick(dt) {
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'hnsw' && S.pv.hnsw) done('phnsw'); }
        if (S.t >= S.nextAt) { S.nextAt = S.t + CYC; newQuery(); }
        if (S.Q && S.t - S.Q.t0 > 6400) finishQuery();
        if (S.scn === 'grow') { const m = mem(); if (!m.ok) S.flags.growBad = 1; if (S.flags.growBad && m.ok && latency() < 100 && S.cfgT > 800) { done('grow'); note('gr', `<b>Индекс поместился:</b> нужно ${nf(m.need)} ГБ, есть ${nf(m.have)} ГБ — поиск снова ${nf(latency())} мс.`, 'ok', 6000); } else if (!m.ok) note('grb', `<b>Индекс не влезает в память:</b> корпус ${nf(corpusM())} млн кусков × ${IX().kb} КБ = ${nf(m.need)} ГБ, а у ${P().count} ${pl(P().count, 'узла', 'узлов', 'узлов')} ${nf(m.have)} ГБ. ${P().index === 'hnsw' ? 'Граф читается с диска — поиск в 6 раз медленнее.' : ''} Добавь узлы или возьми IVF-PQ.`, 'bad', 8000); }
        S.ev = S.ev.filter(e => e.t > S.t - 20000);
      }
      function draw() {
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() {},
        scenario(id) { S.scn = id; reset(); },
        onProp(key, prev, v) {
          S.cfgT = 0;
          const m = mem();
          if (key === 'index') return `${IX().name}: поиск ${nf(latency())} мс, recall ${Math.round(IX().recall * 100)} %, ${IX().kb} КБ на вектор — нужно ${nf(m.need)} ГБ из ${nf(m.have)} ГБ.${m.ok ? '' : ' Не влезает!'}`;
          if (key === 'count') return `${v} ${pl(v, 'узел', 'узла', 'узлов')} × 64 ГБ = ${nf(m.have)} ГБ памяти, индексу нужно ${nf(m.need)} ГБ.${m.ok ? '' : ' Мало.'}`;
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const m = mem(), Q = S.Q;
          if (S.scn === 'stale') return S.reindexed ? '<b>Тариф переиндексирован:</b> старые куски удалены по doc_id и версии — в индексе одна актуальная версия, ответ верный.' : '<b>Тариф поменялся с 1 июня</b>, новую версию загрузили, а старую не удалили. В индексе обе, старая формулировка ближе к вопросу — клиенту называют старую комиссию. Переиндексируй тариф.';
          if (S.scn === 'chunk') return S.chunk === 100 ? '<b>Куски по 100 токенов</b> режут фразу пополам: «…комиссия» в одном куске, «1 %, не меньше 50 ₽» — в другом, далёком по смыслу. Модель не видит цифру.' : S.chunk === 2000 ? '<b>Куски по 2 000 токенов:</b> каждый обо всём сразу, близость к вопросу ниже, контекст в 4 раза длиннее и дороже.' : '<b>По разделам, ≈ 500 токенов, с перекрытием:</b> правило и цифра в одном куске — близость высокая, ответ точный.';
          if (S.scn === 'offbase') return S.thOn ? `<b>Порог включён:</b> лучшая близость ${Q ? nf(Q.res.best, 2) : '…'} ниже ${nf(TH, 2)} — контекст пуст, ассистент честно говорит «не знаю».` : `<b>Вопроса нет в базе</b>, но поиск всё равно вернул ${K} ближайших куска (близость ${Q ? nf(Q.res.best, 2) : '…'}). Модель получила мусор и выдумала правдоподобный ответ. Включи порог и инструкцию «не знаю».`;
          if (S.scn === 'grow') return m.ok ? `<b>Корпус ${nf(corpusM())} млн кусков</b> помещается: нужно ${nf(m.need)} ГБ из ${nf(m.have)}. Поиск ${nf(latency())} мс.` : `<b>Корпус вырос до ${nf(corpusM())} млн кусков:</b> ${IX().name} нужно ${nf(m.need)} ГБ, а есть ${nf(m.have)} ГБ. ${P().index === 'hnsw' ? 'Граф не в памяти — поиск в 6 раз медленнее.' : P().index === 'flat' ? 'Полный перебор стал ещё медленнее.' : ''} Добавь узлы (шарды) или возьми IVF-PQ: он сжимает векторы в 8 раз.`;
          return `<b>RAG:</b> вопрос превращается в вектор, ${IX().name} находит ${K} ближайших куска за ${nf(latency())} мс, куски выше порога ${nf(TH, 2)} идут в промпт с номерами, и модель отвечает по ним со ссылками [n].`;
        },
        stats() {
          const m = mem(), Q = S.Q, ok = S.ev.filter(e => e.kind === 'ok' || e.kind === 'idk').length, bad = S.ev.filter(e => ['hall', 'stale', 'partial'].includes(e.kind)).length;
          return [
            ['Поиск', `${nf(latency())} мс`, latency() > 100 ? 'bad' : 'ok', IX().name],
            ['Recall', Math.round(IX().recall * 100) + ' %', IX().recall < 0.95 ? 'warn' : 'ok', 'доля найденных лучших'],
            ['Лучшая близость', Q ? nf(Q.res.best, 2) : '…', Q && Q.res.best < TH ? 'bad' : 'ok', `порог ${nf(TH, 2)}`],
            ['В контексте', Q ? String(Q.res.top.filter(c => c.pass).length) : '…', '', `кусков из ${K}`],
            ['Память', `${nf(m.need)} / ${nf(m.have)} ГБ`, m.ok ? 'ok' : 'bad', `${nf(corpusM())} млн кусков`],
            ['Ответы', `${ok} ✓ · ${bad} ✕`, bad ? 'bad' : 'ok', 'за 20 с']
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
