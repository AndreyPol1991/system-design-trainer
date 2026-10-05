/* «Поисковый движок изнутри» (Elasticsearch / OpenSearch): анализ текста, обратный индекс с позициями, пересечение списков,
   ранжирование BM25, шарды и реплики, refresh (near real-time), синхронизация с базой (CDC или двойная запись). */
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
  function arrow(x1, y1, x2, y2, c) {
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
    const a = Math.atan2(y2 - y1, x2 - x1), L = 7, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`;
    return `<line class="xse-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xse-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const MONO = (x, y, t, c, a) => `<text class="xse-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const KW = /^(SELECT|FROM|WHERE|AND|OR|ILIKE|LIKE|ORDER|BY|LIMIT|GET|POST|PUT|true|false|null)$/;
  const hl = line => line.split(/('[^']*'|"[^"]*"|\s+|[(),=<>*;:{}[\]]+)/).filter(x => x !== '').map(tk => /^('.*'|".*")$/.test(tk) ? `<tspan class="xse-st">${ES(tk)}</tspan>` : KW.test(tk) ? `<tspan class="xse-kw">${tk}</tspan>` : /^-?\d[\d.]*$/.test(tk) ? `<tspan class="xse-nu">${tk}</tspan>` : ES(tk)).join('');
  const CODE = (x, y, line, c) => `<text class="xse-code${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${line.trim().startsWith('//') || line.trim().startsWith('--') ? `<tspan class="xse-cm">${ES(line)}</tspan>` : hl(line)}</text>`;

  /* ---------- анализатор: токены, нижний регистр, стоп-слова, стемминг ---------- */
  const STOP = new Set(['для', 'на', 'и', 'в', 'с', 'по', 'из', 'от', 'до']);
  const ENDS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ом', 'ем', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й'];
  const stem = w => { if (/^\d/.test(w) || /^[a-z]/.test(w)) return w; for (const e of ENDS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length); return w; };
  const tokens = s => s.split(/[^0-9A-Za-zА-Яа-яЁё]+/).filter(Boolean);
  const analyze = s => tokens(s).map((t, pos) => ({ raw: t, low: t.toLowerCase().replace(/ё/g, 'е'), pos })).map(t => ({ ...t, stop: STOP.has(t.low), stem: STOP.has(t.low) ? null : stem(t.low) }));

  /* ---------- документы: каталог товаров ---------- */
  const DOCS0 = [
    [1001, 'Кроссовки беговые Nike Pegasus 41, красные', 12990, 'Обувь'],
    [1002, 'Красная футболка хлопковая для бега', 1490, 'Одежда'],
    [1003, 'Кроссовки детские красные на липучке', 3290, 'Обувь'],
    [1004, 'Кеды Converse Chuck 70 белые', 8990, 'Обувь'],
    [1005, 'Кроссовки Adidas Ultraboost чёрные', 15990, 'Обувь'],
    [1006, 'Красный рюкзак для бега 20 л', 4590, 'Аксессуары'],
    [1007, 'Беговые кроссовки Asics Gel-Kayano, красно-белые, красная подошва', 14490, 'Обувь'],
    [1008, 'Носки спортивные красные, 3 пары', 590, 'Аксессуары']];
  const NEW = [1009, 'Кроссовки красные Puma Velocity Nitro', 9990, 'Обувь'];
  const QUERIES = ['красные кроссовки', 'беговые кроссовки', 'красный рюкзак', 'белые кеды'];
  const RI = 1600;   // refresh_interval в модели (в жизни 1 с; время здесь растянуто)
  const K1 = 1.2, B = 0.75, SHARDS = 3;
  const shardOf = id => id % SHARDS;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const QB = { x: 16, y: 46, w: 300, h: 176 }, IX = { x: 326, y: 46, w: 330, h: 276 }, RS = { x: 666, y: 46, w: 318, h: 276 };
  const AN = { x: 16, y: 230, w: 300, h: 92 }, CL = { x: 16, y: 332, w: 470, h: 220 }, SY = { x: 496, y: 332, w: 488, h: 220 };

  SD.XRAY.search = {
    viewBox: '0 0 1000 560',
    cta: 'Анализ текста и стемминг, обратный индекс с позициями, пересечение списков и BM25, шарды, refresh и синхронизация с базой — на товарах каталога',
    dive: 'search',
    simple: () => ({
      an: 'Как <b>предметный указатель в конце толстой книги</b>: «кроссовки — стр. 12, 48, 103». Чтобы найти слово, не листаешь всю книгу, а открываешь указатель. Слова в нём приведены к начальной форме, поэтому «кроссовками» и «кроссовок» стоят в одной строке.',
      pl: 'Поисковый движок заранее разбирает каждый товар на слова, приводит их к основе и строит указатель «слово → в каких товарах и на каких местах оно встречается». Запрос тоже разбирается на слова, движок берёт их списки, находит товары, где есть все слова, и сортирует по релевантности.'
    }),
    props: ['count'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Покупатели ищут товары, каталог меняется. Узлов — как в настройке.' },
      { id: 'fresh', name: 'Новый товар', note: 'Добавили новые красные кроссовки. В базе они есть сразу, а в поиске — когда?' },
      { id: 'dual', name: 'Двойная запись', note: 'Сервис сам пишет в базу и в поиск. Иногда запись в поиск падает по таймауту.' },
      { id: 'down', name: 'Узел упал', note: 'Один узел поискового кластера выключился. Что с шардами и результатами?' },
      { id: 'like', name: 'LIKE в базе', note: 'А если искать прямо в PostgreSQL через ILIKE?' }
    ],
    tries: [
      { id: 'fresh', text: 'В «Новом товаре» поймай момент, когда товар уже в базе, но поиск его ещё не находит' },
      { id: 'dual', text: 'В «Двойной записи» найди товар, у которого цена в поиске не совпадает с базой, потом переключи на CDC' },
      { id: 'down', text: 'В «Узел упал» при одном узле поиск ложится целиком; поставь 2+ узла — кластер переживает падение' },
      { id: 'like', text: 'В «LIKE в базе» сравни время запроса в базе и в поисковом движке' },
      { id: 'pana', text: 'Открой блок «Анализатор» и посмотри, во что превращаются «Кроссовки» и «красные»' },
      { id: 'pbm', text: 'Открой блок «Ранжирование BM25» и разберись, почему первый товар выше второго' }
    ],
    parts: {
      analyze: {
        name: 'Анализатор',
        an: 'Как <b>библиотекарь, который приводит слова к словарной форме</b>: «кроссовками», «кроссовок» и «Кроссовки» в карточке каталога записаны одним словом.',
        pl: 'Перед тем как положить текст в индекс и перед поиском движок прогоняет его через анализатор: режет на слова, переводит в нижний регистр, выбрасывает служебные слова и обрезает окончания. Поэтому «красные кроссовки» найдут «Кроссовки … красная подошва».',
        how: ['<b>Токенизатор</b> режет текст по пробелам и знакам: «Gel-Kayano, красно-белые» → Gel · Kayano · красно · белые.', '<b>lowercase</b>: «Кроссовки» → «кроссовки», ё → е.', '<b>Стоп-слова</b>: «для», «на», «и» выбрасываются — они есть почти везде и ничего не различают.', '<b>Стемминг</b> (Snowball для русского): отрезаем окончания — «кроссовки» → «кроссовк», «красные» и «красная» → «красн».', 'Тот же анализатор применяется и к запросу — иначе «красные» не встретятся с «красн».', 'Можно добавить синонимы («кеды» = «сникеры»), транслит и поиск с опечатками (fuzzy).'],
        watch: 'Слева над индексом — текст запроса проходит через четыре шага: токены, нижний регистр, стоп-слова, основы. Внутри блока — то же самое для настоящего названия товара.',
        real: 'Elasticsearch: analyzer = tokenizer (standard) + filters (lowercase, stop, snowball russian / hunspell). Проверить: GET _analyze {"analyzer": "russian", "text": "Красные кроссовки"}.'
      },
      index: {
        name: 'Обратный индекс',
        an: 'Как <b>указатель в конце книги</b>: для каждого слова — номера страниц и места на странице.',
        pl: 'Обычная таблица хранит «товар → его слова». Обратный индекс — наоборот: «слово → список товаров, где оно есть», плюс сколько раз и на каких позициях. Найти все товары со словом — одна операция, без перебора каталога.',
        how: ['Каждый товар проходит анализатор и раскладывается на основы слов.', 'Для каждой основы ведётся список документов (postings list): номер товара, частота, позиции.', 'Списки отсортированы по номеру документа — их можно быстро пересекать.', 'Позиции нужны для фразового поиска: «красные кроссовки» как фраза — слова должны стоять рядом.', 'Словарь терминов хранится как конечный автомат (FST) — компактно и быстро, в том числе для префиксов.', 'Индекс состоит из сегментов: файлы не меняются, новые документы попадают в новые сегменты.'],
        watch: 'Таблица посередине: слева основа слова, рядом df — в скольких товарах она встречается, справа — список товаров с позициями. Строки слов из запроса подсвечены.',
        real: 'Lucene (на нём Elasticsearch, OpenSearch, Solr). Postings хранятся сжато (delta + bit packing), пересечение идёт с пропусками (skip lists). Миллиард документов — десятки миллисекунд на запрос.'
      },
      query: {
        name: 'Запрос и пересечение',
        an: 'Как <b>найти в двух указателях общие страницы</b>: у «красн» страницы 1001, 1002, 1003…, у «кроссовк» — 1001, 1003, 1005… Общие — 1001, 1003, 1007.',
        pl: 'Запрос разбирается тем же анализатором. Для каждой основы берётся её список товаров. Если нужны все слова (AND), списки пересекаются; если любое (OR), объединяются, а товары, где совпало больше слов, получают больший вес.',
        how: ['«красные кроссовки» → [красн, кроссовк].', 'Список «красн»: 1001, 1002, 1003, 1006, 1007, 1008.', 'Список «кроссовк»: 1001, 1003, 1005, 1007.', 'Пересечение (AND): идём по двум отсортированным спискам одновременно → 1001, 1003, 1007.', 'match по умолчанию — OR: подходят и 1002 (только «красн»), и 1005 (только «кроссовк»), но ниже.', 'Фильтры (категория, цена, наличие) применяются отдельно и кэшируются — они не влияют на релевантность.'],
        watch: 'Нижняя строка индекса — пересечение: товары, у которых есть все слова запроса. Справа — они же в выдаче, отсортированные по BM25.',
        real: 'Elasticsearch: {"query": {"match": {"title": {"query": "красные кроссовки", "operator": "and"}}}}, bool-запрос с must, should, filter.'
      },
      bm25: {
        name: 'Ранжирование BM25',
        an: 'Как <b>судья, который ценит редкие улики</b>: слово, которое есть почти во всех товарах, мало что доказывает; редкое слово — много. И одно слово в коротком названии весомее, чем в длинном.',
        pl: 'Каждый найденный товар получает число — релевантность. BM25 складывает вклады слов запроса: чем реже слово в каталоге (IDF), тем больше вклад; чем чаще слово в этом товаре (TF), тем больше, но с насыщением; длинные названия немного штрафуются.',
        how: ['<b>IDF</b> = ln(1 + (N − df + 0,5) / (df + 0,5)): «кроссовк» в 4 из 8 товаров — вес меньше, чем у редкого слова.', '<b>TF</b> с насыщением: tf · (k1 + 1) / (tf + k1 · (1 − b + b · длина / средняя длина)), k1 = 1,2, b = 0,75.', 'Второе «красн» в названии добавляет меньше, чем первое: насыщение.', 'Длинное название с тем же словом получает чуть меньший вклад — нормировка по длине (b).', 'Итог = сумма вкладов по словам запроса; плюс бусты: поле title весит больше description, свежие и популярные товары — выше.', 'Финальную сортировку магазины часто доделывают своей моделью (learning to rank).'],
        watch: 'Справа у каждого результата — полоска и число BM25. Внутри блока — расчёт по шагам для двух лучших товаров: IDF, TF, нормировка длины.',
        real: 'BM25 — функция по умолчанию в Elasticsearch и Lucene с 2016 года. Объяснение счёта: GET index/_explain/1001. Бусты: function_score, rank_feature.'
      },
      shards: {
        name: 'Шарды и реплики', knobs: ['count'],
        an: 'Как <b>тома энциклопедии в разных шкафах</b> и копия каждого тома в соседнем шкафу: читать можно любую копию, а сгорел шкаф — копии остались.',
        pl: 'Индекс делится на шарды — независимые куски, каждый со своим обратным индексом. Шарды раскладываются по узлам. У каждого основного шарда (primary) может быть реплика на другом узле. Запрос идёт во все шарды параллельно, координатор собирает лучшие результаты.',
        how: ['Товар попадает в шард по хешу id: shard = hash(_id) % число шардов (здесь 3).', 'Каждый шард — отдельный индекс Lucene на каком-то узле.', 'Реплика — копия шарда на другом узле: читать можно и из неё, она же заменит primary при падении.', 'Поиск: координатор шлёт запрос в одну копию каждого шарда, каждая возвращает свой топ-10, координатор сливает их (scatter-gather).', 'Здоровье: green — все копии на месте, yellow — реплики не размещены, red — нет даже primary какого-то шарда.', 'Число шардов задают при создании индекса; менять — переиндексация. Реплик можно добавить в любой момент.'],
        watch: 'Слева внизу — узлы и шарды на них: P — основная копия, R — реплика. Во время запроса к каждому шарду летит точка, назад — его топ. Цвет рамки — здоровье кластера.',
        real: 'Elasticsearch: "number_of_shards": 3, "number_of_replicas": 1. Реплика не размещается на том же узле, что primary, — на одном узле кластер всегда yellow. Узел ≈ 2 500 запросов/с в площадке.'
      },
      refresh: {
        name: 'Refresh: почти сразу',
        an: 'Как <b>доска объявлений, которую переклеивают раз в секунду</b>: объявление сдал — оно принято, но на доске появится при ближайшей переклейке.',
        pl: 'Новый документ сначала попадает в буфер в памяти и в журнал (translog). Искать по нему можно только после refresh — когда буфер превращается в новый сегмент. Refresh идёт раз в секунду, поэтому поиск «почти в реальном времени» (near real-time).',
        how: ['PUT /products/_doc/1009 → документ в буфере памяти и в translog (на случай падения).', 'Ответ 201 Created — но поиск его ещё не видит.', 'Раз в refresh_interval (1 с) буфер превращается в новый маленький сегмент — теперь документ находится.', 'Маленькие сегменты в фоне сливаются в большие (merge).', 'Flush раз в какое-то время пишет сегменты на диск и чистит translog.', 'Массовая загрузка: refresh_interval = -1 на время загрузки, потом обратно — в разы быстрее.'],
        watch: 'Справа внизу — буфер индексации: новые товары ждут в нём, кольцо показывает время до refresh. Вспышка — refresh: товары переехали в сегмент и стали находиться.',
        real: 'Elasticsearch: refresh_interval = 1s по умолчанию; ?refresh=wait_for — дождаться видимости перед ответом. Изменение — тоже новая версия документа: старая помечается удалённой до слияния.'
      },
      sync: {
        name: 'Синхронизация с базой',
        an: 'Как <b>копия прайс-листа на витрине</b>: главный прайс в бухгалтерии. Если витрину обновляет продавец «когда вспомнит», цены расходятся; если копию печатают из журнала изменений — она всегда догоняет.',
        pl: 'Поиск — копия данных базы. Её надо обновлять при каждом изменении товара. Двойная запись из кода (в базу, потом в поиск) теряет обновления при сбое. CDC читает журнал базы и гарантированно донесёт каждое изменение, пусть и с задержкой.',
        how: ['<b>Двойная запись</b>: UPDATE в базе прошёл, а запрос в поиск упал по таймауту — в поиске старая цена, и никто не узнает.', 'Хуже: два параллельных обновления могут прийти в поиск в другом порядке.', '<b>CDC</b>: Debezium читает WAL базы → Kafka → индексатор пишет в поиск. Каждое изменение дойдёт, по порядку для одного товара.', 'Индексатор идемпотентен: пишет документ целиком с версией (version_type=external) — повтор и старое событие не испортят свежее.', 'Задержка — сотни миллисекунд плюс refresh.', 'Раз в сутки — сверка или полная переиндексация в новый индекс с переключением алиаса.'],
        watch: 'Справа внизу: путь изменения из базы в поиск. При двойной записи часть стрелок обрывается — товар в выдаче с неверной ценой (красная метка).',
        real: 'Debezium + Kafka Connect + Elasticsearch Sink, Logstash JDBC, свои индексаторы. Алиас products → products_v7 позволяет переиндексировать без простоя.'
      },
      notdb: {
        name: 'Почему не основная база',
        an: 'Как <b>каталог в библиотеке</b>: им удобно искать, но если каталог сгорел, книги целы — его можно составить заново. Наоборот — нельзя.',
        pl: 'Поисковый движок хорош для поиска, но плох как источник правды: нет транзакций между документами, запись видна не сразу, при некоторых сбоях можно потерять подтверждённые записи, а схему трудно менять. Правда живёт в базе, поиск — пересобираемая копия.',
        how: ['Нет транзакций на несколько документов и нет JOIN — заказ и товары не обновить атомарно.', 'Запись видна через refresh — «записал и сразу прочитал» не работает без wait_for.', 'Изменить тип поля нельзя — только переиндексация в новый индекс.', 'При разделении сети исторически бывали потери подтверждённых записей; бэкап — снапшоты, а не журнал транзакций.', 'Глубокая пагинация (from + size) дорогая: 10 000 результатов — предел по умолчанию.', 'Поэтому: база — источник правды, поиск строится из неё и может быть пересоздан в любой момент.'],
        watch: 'Сравни: в «LIKE в базе» база перебирает всю таблицу, а поиск отвечает за миллисекунды. И наоборот — запись в поиск не появляется мгновенно и может разойтись с базой.',
        real: 'Так устроено почти везде: PostgreSQL или MySQL — источник правды, Elasticsearch, OpenSearch, Meilisearch, Typesense — витрина для поиска. Для поиска прямо в PostgreSQL есть tsvector и pg_trgm — хватает на небольших объёмах.'
      }
    },
    legend: [['sq xse-swq', 'Слово из запроса'], ['sq xse-swh', 'Товар, где есть все слова'], ['read', 'Запрос покупателя'], ['ok', 'Ответ шарда: его топ'], ['write', 'Изменение товара на пути в поиск'], ['sq xse-swb', 'В буфере: ещё не находится'], ['bad', 'Рассинхрон, потерянный шард']],
    live: (n, r) => {
      const l = r.load || {}, s = l.search || 0, out = [['Поисков', SD.fmt.num(s) + '/с', '']];
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      out.push(['Узлов', String(n.props.count || 1), '']);
      out.push(['Кластер', (n.props.count || 1) >= 2 ? 'green' : 'yellow', (n.props.count || 1) >= 2 ? 'ok' : 'warn']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xseSt"></g><g id="xseDy" class="xse-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xseSt'), gDy = ctx.svg.querySelector('#xseDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {}, opt: { cdc: null } };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const N = () => clamp(+P().count || 1, 1, 10);
      const util = () => ctx.res.util || 0;
      const rps = () => (ctx.res.load || {}).search || 0;
      const viaCdc = () => { if (S.opt.cdc != null) return S.opt.cdc; const ins = ctx.ins().map(x => x.n); return ins.some(k => k.type === 'worker' || k.type === 'queue' || k.type === 'cdc'); };

      /* ---------- индекс ---------- */
      function build(docs) {
        const idx = {}, len = {};
        docs.forEach(([id, title]) => {
          const ts = analyze(title).filter(t => !t.stop);
          len[id] = ts.length;
          ts.forEach(t => { const p = idx[t.stem] || (idx[t.stem] = {}); (p[id] || (p[id] = [])).push(t.pos); });
        });
        const avg = Object.values(len).reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
        return { idx, len, avg, N: docs.length };
      }
      function search(q, ix) {
        const qs = [...new Set(analyze(q).filter(t => !t.stop).map(t => t.stem))];
        const lists = qs.map(s => Object.keys(ix.idx[s] || {}).map(Number).sort((a, b) => a - b));
        const all = new Set(lists.flat()), inter = lists.length ? lists.reduce((a, b) => a.filter(x => b.includes(x))) : [];
        const sc = [...all].map(id => {
          let s = 0; const parts = [];
          qs.forEach(t => {
            const p = ix.idx[t] || {}, df = Object.keys(p).length, tf = p[id] ? p[id].length : 0;
            if (!tf) return;
            const idf = Math.log(1 + (ix.N - df + 0.5) / (df + 0.5)), norm = 1 - B + B * ix.len[id] / ix.avg, tfp = tf * (K1 + 1) / (tf + K1 * norm), c = idf * tfp;
            s += c; parts.push({ t, df, tf, idf, norm, tfp, c });
          });
          return { id, s, parts, all: parts.length === qs.length };
        }).sort((a, b) => b.s - a.s);
        return { qs, lists, inter, sc };
      }
      const docOf = id => S.docs.find(d => d[0] === id) || S.dbDocs.find(d => d[0] === id);

      function reset() {
        Object.assign(S, { t: 0, q: null, qi: 0, qAt: 400, hist: [], buf: [], refAt: 1000, refT: -1e9, chg: [], chgAt: 1500, fx: [], miss: 0, drift: {}, nodeDown: -1, downAt: 2500, upAt: 0, cfgT: 0, likeT: 0 });
        S.dbDocs = DOCS0.map(d => d.slice());
        S.docs = DOCS0.map(d => d.slice());   // что видит поиск
        if (S.scn !== 'dual') S.opt.cdc = null; else if (S.opt.cdc == null) S.opt.cdc = false;
        S.ix = build(S.docs);
        S.cfg = S.scn + '|' + N();
      }

      /* ---------- шарды и узлы ---------- */
      function layout() {
        const n = N(), rep = n >= 2 ? 1 : 0, nodes = Array.from({ length: n }, () => []);
        for (let s = 0; s < SHARDS; s++) { nodes[s % n].push({ s, p: true }); if (rep) nodes[(s + 1) % n].push({ s, p: false }); }
        return { nodes, rep, unassigned: rep ? 0 : SHARDS };
      }
      function health() {
        const L = layout(), dn = S.nodeDown;
        if (dn < 0) return L.rep ? 'green' : 'yellow';
        const alive = L.nodes.filter((_, i) => i !== dn).flat();
        for (let s = 0; s < SHARDS; s++) if (!alive.some(x => x.s === s)) return 'red';
        return 'yellow';
      }
      const lostShards = () => { if (S.nodeDown < 0) return []; const L = layout(), alive = L.nodes.filter((_, i) => i !== S.nodeDown).flat(); return [0, 1, 2].filter(s => !alive.some(x => x.s === s)); };

      /* ---------- запросы ---------- */
      function curRes() {   // выдача по текущему индексу: буфер и refresh видны сразу
        const q = S.q; if (!q) return null;
        const res = search(q.q, S.ix), lost = lostShards(), shown = lost.length >= SHARDS ? [] : res.sc.filter(r => !lost.includes(shardOf(r.id)));
        return { q: q.q, res, shown, lost, err: lost.length >= SHARDS, ms: q.ms, t0: q.t0 };
      }
      function newQuery() {
        const q = S.scn === 'fresh' ? QUERIES[0] : QUERIES[S.qi++ % QUERIES.length], lost = lostShards();
        const base = 4 + 3 * Math.min(util(), 1.5) * 8;
        S.q = { q, t0: S.t, ms: S.scn === 'like' ? 2300 : lost.length >= SHARDS ? 0 : base };
        if (S.q.ms) S.hist.push({ t: S.t, ms: S.q.ms });
        if (lost.length >= SHARDS) note('lost', '<b>Все шарды без копий:</b> поиск отвечает 503. Сайт показывает «поиск временно недоступен» — или уходит в запасной вариант (поиск в базе, медленный).', 'bad', 5000);
        else if (lost.length) note('lost', `<b>Шард ${lost.join(', ')} недоступен:</b> на упавшем узле была единственная копия. Поиск отвечает, но без товаров из этого шарда — выдача неполная (кластер red).`, 'bad', 5000);
        if (S.scn === 'like') { S.likeT += 1; if (S.likeT >= 2) done('like'); }
      }
      function freshCheck() {   // поймать момент: в базе есть, в поиске нет
        if (S.scn !== 'fresh' || phase().k < 3) return;
        const inDb = S.dbDocs.some(d => d[0] === NEW[0]), inIx = S.docs.some(d => d[0] === NEW[0]);
        if (inDb && !inIx) { S.flags.freshMiss = 1; done('fresh'); note('fm', '<b>Товар 1009 уже в базе, а поиск его не находит:</b> он лежит в буфере индексации и появится после ближайшего refresh.', 'warn', 6000); }
        if (inIx && S.flags.freshMiss) note('fh', '<b>После refresh</b> товар 1009 нашёлся и сразу встал наверх: в коротком названии оба слова запроса.', 'ok', 8000);
      }
      function changeStep() {
        if (S.scn === 'fresh' && S.docs.some(d => d[0] === NEW[0]) && S.t - (S.newVis || (S.newVis = S.t)) > 6000) {   // повторяем: товар сняли и добавили снова
          S.dbDocs = S.dbDocs.filter(d => d[0] !== NEW[0]); S.docs = S.docs.filter(d => d[0] !== NEW[0]); S.ix = build(S.docs); S.newVis = 0; S.newAt = S.t + 2500;
        }
        if (S.scn === 'fresh' && !S.dbDocs.some(d => d[0] === NEW[0]) && S.t >= (S.newAt || 1800)) {
          S.dbDocs.push(NEW.slice()); S.chg.push({ id: NEW[0], t0: S.t, ph: 'go', ok: true, price: NEW[2], newDoc: true });
          note('fn', '<b>INSERT в базу:</b> новые красные кроссовки 1009 сохранены. Изменение отправлено в поиск.', '', 0);
        }
        if ((S.scn === 'norm' || S.scn === 'dual') && S.t >= S.chgAt) {
          S.chgAt = S.t + (S.scn === 'dual' ? 1400 : 2600);
          const d = S.dbDocs[Math.floor(Math.random() * S.dbDocs.length)], np = Math.round(d[2] * (0.85 + Math.random() * 0.25) / 10) * 10 - 10;
          d[2] = np;
          const fail = S.scn === 'dual' && !viaCdc() && Math.random() < 0.5;
          S.chg.push({ id: d[0], t0: S.t, ph: 'go', ok: !fail, price: np });
        }
        S.chg.forEach(c => {
          if (c.ph === 'go' && S.t - c.t0 > 900) {
            if (!c.ok) { c.ph = 'lost'; c.t1 = S.t; S.drift[c.id] = 1; S.flags.drift = 1; note('dr', `<b>Двойная запись: запрос в поиск упал по таймауту.</b> В базе у товара ${c.id} цена ${nf(c.price)} ₽, а в поиске осталась старая — и никто об этом не узнает.`, 'bad', 4000); }
            else { c.ph = 'buf'; S.buf.push(c); }
          }
        });
        S.chg = S.chg.filter(c => c.ph === 'go' || (c.ph === 'lost' && S.t - c.t1 < 1500));
      }
      function refreshStep() {
        if (S.t < S.refAt) return;
        S.refAt = S.t + RI;
        if (!S.buf.length) return;
        S.buf.forEach(c => {
          const d = S.dbDocs.find(x => x[0] === c.id), i = S.docs.findIndex(x => x[0] === c.id);
          if (i >= 0) S.docs[i] = d.slice(); else S.docs.push(d.slice());
          delete S.drift[c.id];
        });
        S.refT = S.t; S.refN = S.buf.length; S.buf = []; if (S.docs.some(d => d[0] === NEW[0]) && !S.newVis) S.newVis = S.t;
        S.ix = build(S.docs);
        if (viaCdc() && S.scn === 'dual' && S.flags.drift) done('dual');
      }
      function downStep() {
        if (S.scn !== 'down') return;
        if (S.nodeDown < 0 && S.t >= S.downAt) {
          S.nodeDown = 0; S.upAt = S.t + 7000; const h = health();
          note('nd', h === 'red' ? `<b>Узел 1 упал, и это был единственный узел${N() > 1 ? ' с копией части шардов' : ''}.</b> Кластер red: ${N() === 1 ? 'поиск недоступен целиком' : 'часть шардов без копий'}. Поставь 2+ узла — у каждого шарда будет реплика.` : `<b>Узел 1 упал.</b> Его основные шарды заменили реплики на других узлах — поиск работает, выдача полная. Кластер yellow, пока реплики не восстановят на живых узлах.`, h === 'red' ? 'bad' : 'warn', 0);
          if (h === 'red') S.flags.red = 1; else if (S.flags.red) done('down');
        }
        if (S.nodeDown >= 0 && S.t >= S.upAt) { S.nodeDown = -1; S.downAt = S.t + 3500; note('nu', '<b>Узел вернулся</b> — копии шардов догнали изменения, кластер снова в норме.', 'ok', 0); }
      }

      /* ---------- кнопки на картинке ---------- */
      const btn = (x, y, w, k, label, on) => `<g class="xse-btn${on ? ' on' : ''}" data-xse="${k}" tabindex="0" role="button"><rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="22" rx="11"/><text x="${f1(x + w / 2)}" y="${f1(y + 15)}">${label}</text></g>`;
      function onClick(e) {
        const b = e.target.closest('[data-xse]'); if (!b) return;
        if (b.dataset.xse === 'cdc') { S.opt.cdc = !viaCdc(); ctx.log(`<b>Индексация: ${S.opt.cdc ? 'CDC' : 'двойная запись'}.</b> ${S.opt.cdc ? 'Изменения читаются из журнала базы и доходят все, по порядку.' : 'Сервис сам пишет в поиск после базы — сбой теряет обновление.'}`, 'chg'); if (S.opt.cdc) { S.dbDocs.forEach(d => { if (S.drift[d[0]]) S.buf.push({ id: d[0] }); }); } }
        e.stopPropagation();
      }
      function onKey(e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-xse]')) { e.preventDefault(); onClick(e); } }
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- отрисовка ---------- */
      const hlTitle = (title, stems, max) => {
        let out = '', len = 0;
        tokens(title).forEach((tk, i) => { if (len > max) return; const st = stem(tk.toLowerCase().replace(/ё/g, 'е')); const w = cut(tk, Math.max(3, max - len)); out += (i ? ' ' : '') + (stems.includes(st) ? `<tspan class="xse-hit">${ES(w)}</tspan>` : ES(w)); len += tk.length + 1; });
        return out;
      };
      function badges() {
        const bs = [['analyze', 'АНАЛИЗАТОР', 'токены → основы'], ['bm25', 'РАНЖИРОВАНИЕ', 'BM25: k1 1,2 · b 0,75'], ['refresh', 'REFRESH', 'раз в 1 с'], ['notdb', 'НЕ ОСНОВНАЯ БАЗА', 'копия для поиска']];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xse-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xse-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xse-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s')}</g>`; });
        return s;
      }
      function phase() { const q = S.q; if (!q) return { k: -1, u: 0 }; const u = S.t - q.t0; return { k: u < 600 ? 0 : u < 1200 ? 1 : u < 1700 ? 2 : 3, u }; }
      function queryBox() {
        const b = QB, q = curRes(), ph = phase();
        const ins = ctx.ins().map(x => x.n), ap = ins.find(k => k.type === 'app') || ins[0], go = ap && ctx.canGo(ap.id);
        let s = `<g${go ? ` class="xr-go" data-xgo="${ap.id}"` : ''}>${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, ES(cut(ap ? ctx.nm(ap.id) : 'Сервис', 22)) + ' → поиск', 'xr-t') + T(b.x + b.w - 12, b.y + 20, `${SD.fmt.num(rps())} запросов/с`, 'xse-ms', 'end');
        s += R(b.x + 12, b.y + 30, b.w - 24, 30, 'xse-qbox', 8) + T(b.x + 24, b.y + 50, q ? `🔍 ${ES(q.q)}` : '…', 'xse-qt');
        if (S.scn === 'like') {
          s += CODE(b.x + 12, b.y + 80, "SELECT id, title FROM products", 'sm') + CODE(b.x + 12, b.y + 96, "WHERE title ILIKE '%красн%'", 'sm') + CODE(b.x + 12, b.y + 112, "  AND title ILIKE '%кроссовк%';", 'sm');
          s += T(b.x + 12, b.y + 136, 'Seq Scan по 12 млн строк: ≈ 2,3 с', 'xr-m bad') + T(b.x + 12, b.y + 154, 'без ранжирования, без морфологии', 'xse-ms') + T(b.x + 12, b.y + 168, '«кросовки» с опечаткой — ничего', 'xse-ms');
        } else {
          s += MONO(b.x + 12, b.y + 82, 'GET /products/_search');
          s += CODE(b.x + 12, b.y + 100, `{"match": {"title": "${q ? q.q : ''}"}}`, 'sm');
          s += T(b.x + 12, b.y + 124, q ? (q.err ? '503: все шарды недоступны' : `найдено: ${q.shown.length}${q.lost.length ? ` (без шарда ${q.lost.join(', ')})` : ''} · все слова: ${q.shown.filter(r => r.all).length}`) : '', 'xr-s' + (q && q.lost.length ? ' xse-bad' : ''));
          s += T(b.x + 12, b.y + 144, q ? (q.err ? 'нет ответа' : `took: ${nf(q.ms, 0)} мс`) : '', 'xr-m ' + (q && q.err ? 'bad' : 'ok')) + T(b.x + 12, b.y + 164, health() === 'red' ? 'кластер red: часть данных недоступна' : 'шарды отвечают параллельно', 'xse-ms' + (health() === 'red' ? ' xse-bad' : ''));
        }
        return s + '</g>';
      }
      function analyzer() {
        const b = AN, q = curRes(), ph = phase();
        let s = `<g class="xr-part" data-xpart="analyze">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 12, b.y + 18, 'АНАЛИЗАТОР ЗАПРОСА', 'xr-m')}`;
        if (!q) return s + '</g>';
        const a = analyze(q.q), rows = [['токены', a.map(t => t.raw)], ['регистр', a.map(t => t.low)], ['без стоп-слов', a.filter(t => !t.stop).map(t => t.low)], ['основы', a.filter(t => !t.stop).map(t => t.stem)]];
        rows.forEach(([n, ws], j) => {
          const y = b.y + 36 + j * 15, on = ph.k >= 0 && ph.u > j * 140;
          s += T(b.x + 12, y, n, 'xse-ms') + T(b.x + 104, y, on ? ws.map(w => j === 3 ? `<tspan class="xse-hit">${ES(w)}</tspan>` : ES(w)).join(' · ') : '…', 'xse-fn' + (j === 3 ? '' : ' dim'));
        });
        return s + '</g>';
      }
      function indexBox() {
        const b = IX, q = curRes(), ph = phase(), ix = S.ix;
        let s = `<g class="xr-part" data-xpart="index">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 12, b.y + 20, 'ОБРАТНЫЙ ИНДЕКС · title', 'xr-m acc')}${T(b.x + b.w - 12, b.y + 20, `${Object.keys(ix.idx).length} основ · ${ix.N} товаров`, 'xse-ms', 'end')}`;
        s += T(b.x + 12, b.y + 40, 'основа', 'xse-fn') + T(b.x + 92, b.y + 40, 'df', 'xse-fn') + T(b.x + 118, b.y + 40, 'товар:[позиции]', 'xse-fn');
        const qs = q ? q.res.qs : [], others = Object.keys(ix.idx).filter(t => !qs.includes(t) && /^[а-яе]/.test(t) && Object.keys(ix.idx[t]).length >= 2).sort((a, b2) => Object.keys(ix.idx[b2]).length - Object.keys(ix.idx[a]).length).slice(0, 7 - qs.length);
        const terms = qs.concat(others).sort();
        terms.slice(0, 7).forEach((t, j) => {
          const y = b.y + 62 + j * 26, isQ = qs.includes(t), on = isQ && ph.k >= 1, p = ix.idx[t] || {};
          if (on) s += R(b.x + 6, y - 15, b.w - 12, 22, 'xse-qrow', 5);
          s += T(b.x + 12, y, ES(t || '—'), 'xse-fn' + (isQ ? ' xse-acc' : '')) + T(b.x + 92, y, String(Object.keys(p).length), 'xse-ms');
          let x = b.x + 118;
          const ids = Object.keys(p).sort(), fit = ids.length > 3 ? 2 : 3;
          ids.slice(0, fit).forEach(id => { const w = 64, hit = q && ph.k >= 2 && q.res.inter.includes(+id) && isQ; s += R(x, y - 12, w - 3, 17, 'xse-post' + (hit ? ' hit' : ''), 4) + T(x + 4, y, `${id}:[${p[id].join(',')}]`, 'xse-pn'); x += w; });
          if (ids.length > fit) s += T(x + 2, y, `+${ids.length - fit}`, 'xse-pn2');
          if (!Object.keys(p).length) s += T(x, y, 'нет в индексе', 'xse-ms');
        });
        if (q) {
          const y = b.y + b.h - 18, on = ph.k >= 2;
          s += Ln(b.x + 12, y - 18, b.x + b.w - 12, y - 18, 'xse-sep') + T(b.x + 12, y, on ? `∩ AND: ${q.res.inter.length ? q.res.inter.join(', ') : 'пусто'}` : '∩ пересечение списков…', 'xr-m' + (on ? ' acc' : '')) + T(b.x + b.w - 12, y, on ? `∪ OR: ${q.res.sc.length}` : '', 'xse-ms', 'end');
        }
        return s + '</g>';
      }
      function results() {
        const b = RS, q = curRes(), ph = phase();
        let s = `<g class="xr-part" data-xpart="bm25">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 12, b.y + 20, 'ВЫДАЧА · BM25', 'xr-m')}`;
        if (!q || ph.k < 3) return s + T(b.x + 12, b.y + 46, q ? 'шарды считают свой топ…' : '', 'xr-s') + '</g>';
        if (q.err) return s + T(b.x + 12, b.y + 46, '503 Service Unavailable: all shards failed', 'xse-fn xse-bad') + T(b.x + 12, b.y + 66, 'ни у одного шарда не осталось живой копии', 'xr-s') + '</g>';
        const mx = Math.max(0.01, ...q.shown.map(r => r.s)), fr = S.refT && S.t - S.refT < 1200;
        q.shown.slice(0, 6).forEach((r, j) => {
          const d = docOf(r.id), y = b.y + 42 + j * 38, isNew = r.id === NEW[0], dr = S.drift[r.id], dbP = (S.dbDocs.find(x => x[0] === r.id) || d)[2];
          if (isNew) s += R(b.x + 6, y - 14, b.w - 12, 36, 'xse-new', 5);
          s += T(b.x + 12, y, `${j + 1}. ${hlTitle(d[1], q.res.qs, 34)}`, 'xse-tt') + T(b.x + 12, y + 16, `#${r.id} · ${nf(d[2])} ₽${dr ? ` — в базе ${nf(dbP)} ₽!` : ''}`, 'xse-ms' + (dr ? ' xse-bad' : ''));
          s += R(b.x + 196, y + 7, 64, 8, 'xr-bar', 3) + R(b.x + 196, y + 7, 64 * r.s / mx, 8, 'xr-bar-f' + (r.all ? '' : ' warn'), 3) + T(b.x + b.w - 12, y + 15, nf(r.s, 2), 'xr-m' + (r.all ? ' ok' : ' warn'), 'end');
        });
        if (!q.shown.length) s += T(b.x + 12, b.y + 46, 'ничего не найдено', 'xr-s xse-bad');
        return s + '</g>';
      }
      function cluster() {
        const b = CL, L = layout(), q = curRes(), ph = phase(), h = health(), n = L.nodes.length;
        let s = `<g class="xr-part" data-xpart="shards">${R(b.x, b.y, b.w, b.h, 'xr-box xse-h' + h, 12)}`;
        s += T(b.x + 12, b.y + 20, `КЛАСТЕР · ${n} ${pl(n, 'узел', 'узла', 'узлов')} · 3 шарда${L.rep ? ' + 1 реплика' : ''}`, 'xr-m') + T(b.x + b.w - 12, b.y + 20, `здоровье: ${h}`, 'xr-m ' + (h === 'green' ? 'ok' : h === 'yellow' ? 'warn' : 'bad'), 'end');
        const shown = Math.min(n, 5), w = (b.w - 24 - (shown - 1) * 8) / shown;
        for (let i = 0; i < shown; i++) {
          const x = b.x + 12 + i * (w + 8), y = b.y + 54, dn = S.nodeDown === i;
          s += R(x, y, w, 100, 'xse-node' + (dn ? ' dead' : ''), 8) + T(x + 8, y + 16, `узел ${i + 1}`, 'xse-fn') + (dn ? T(x + w - 8, y + 16, 'упал', 'xse-ms xse-bad', 'end') : '');
          L.nodes[i].forEach((sh, j) => {
            const sy = y + 26 + j * 24, promo = S.nodeDown >= 0 && !dn && !sh.p && L.nodes[S.nodeDown].some(z => z.s === sh.s && z.p);
            s += R(x + 8, sy, w - 16, 20, 'xse-shard' + (sh.p || promo ? ' p' : ' r') + (dn ? ' dead' : ''), 4) + T(x + 14, sy + 14, `${sh.p || promo ? 'P' : 'R'}${sh.s}${promo ? ' ← стал P' : ''}`, 'xse-pn');
            if (q && ph.k === 2 && !dn && (sh.p || promo)) { const k = (ph.u - 1200) / 500; s += Dot(x + w - 16, sy + 10, 4, k < 0.5 ? '' : 'ok', k < 0.5 ? `fill:${SD.kindColor('search')}` : ''); }
          });
        }
        if (n > 5) s += T(b.x + b.w - 12, b.y + 168, `+ ещё ${n - 5} ${pl(n - 5, 'узел', 'узла', 'узлов')}`, 'xse-ms', 'end');
        if (!L.rep) s += T(b.x + 12, b.y + 176, 'реплики не размещены: на одном узле копию держать негде', 'xse-ms xse-warn');
        s += T(b.x + 12, b.y + 196, 'товар → шард: hash(_id) % 3 · запрос идёт во все шарды', 'xse-ms') + T(b.x + 12, b.y + 212, `${SD.fmt.num(rps())} поисков/с · узел тянет ≈ 2 500/с · загрузка ${Math.round(Math.min(util(), 9) * 100)} %`, 'xse-ms' + (util() > 1 ? ' xse-bad' : ''));
        return s + '</g>';
      }
      function syncBox() {
        const b = SY, cdc = viaCdc(), fr = S.refT && S.t - S.refT < 900, k = clamp(1 - (S.refAt - S.t) / RI, 0, 1);
        let s = `<g class="xr-part" data-xpart="sync">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, 'ИЗ БАЗЫ В ПОИСК', 'xr-m') + T(b.x + b.w - 12, b.y + 20, cdc ? 'CDC: журнал базы → Kafka → индексатор' : 'двойная запись из сервиса', 'xse-ms' + (cdc ? ' xse-ok' : ' xse-warn'), 'end');
        const X = [b.x + 44, b.x + 170, b.x + 300, b.x + 430], Y = b.y + 66, nm = cdc ? ['PostgreSQL', 'Debezium + Kafka', 'индексатор', 'буфер ES'] : ['PostgreSQL', 'сервис', 'PUT в поиск', 'буфер ES'];
        nm.forEach((t, i) => { s += R(X[i] - 52, Y - 18, 104, 34, 'xse-step' + (i === 3 && S.buf.length ? ' on' : ''), 7) + T(X[i], Y + 4, t, 'xse-fn', 'middle'); if (i < 3) s += arrow(X[i] + 52, Y, X[i + 1] - 54, Y, ''); });
        // буфер и refresh
        const bx = b.x + 12, by = b.y + 110;
        s += `<g class="xr-part" data-xpart="refresh">${R(bx, by - 6, b.w - 24, 104, 'xse-pf', 8)}`;
        s += T(bx, by + 8, `в буфере: ${S.buf.length} ${pl(S.buf.length, 'изменение', 'изменения', 'изменений')} — поиск их ещё не видит`, 'xr-s' + (S.buf.length ? ' xse-warn' : ''));
        S.buf.slice(0, 6).forEach((c, j) => { s += R(bx + j * 74, by + 16, 68, 22, 'xse-bufd', 5) + T(bx + j * 74 + 6, by + 31, `#${c.id}`, 'xse-pn'); });
        const rx = b.x + b.w - 34, ry = by + 26;
        s += `<circle class="xse-ringbg" cx="${rx}" cy="${ry}" r="13"/><circle class="xse-ring" cx="${rx}" cy="${ry}" r="13" stroke-dasharray="${f1(k * 81.7)} 82" transform="rotate(-90 ${rx} ${ry})"/>` + T(rx, ry + 30, 'refresh', 'xse-ms', 'middle');
        s += T(bx, by + 60, fr ? `refresh: ${S.refN} ${pl(S.refN, 'документ', 'документа', 'документов')} → новый сегмент, теперь находятся` : 'refresh раз в секунду превращает буфер в сегмент', 'xr-s' + (fr ? ' xse-ok' : ''));
        const dr = Object.keys(S.drift);
        s += T(bx, by + 80, dr.length ? `рассинхрон: ${dr.length} ${pl(dr.length, 'товар', 'товара', 'товаров')} с неверной ценой в поиске (${dr.slice(0, 3).map(x => '#' + x).join(', ')})` : 'поиск совпадает с базой', 'xr-s ' + (dr.length ? 'xse-bad' : 'xse-ok'));
        s += '</g>';
        if (S.scn === 'dual') s += btn(b.x + b.w - 190, b.y + b.h - 30, 178, 'cdc', cdc ? '✓ индексация через CDC' : '✕ двойная запись', cdc);
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const wc = SD.kindColor('write');
        S.chg.forEach(c => {
          const X = [SY.x + 44, SY.x + 170, SY.x + 300, SY.x + 430], k = clamp((S.t - c.t0) / 900, 0, 1), Y = SY.y + 66;
          if (c.ph === 'go') { const [x, y] = c.ok ? lerp([X[0], Y], [X[3], Y], ease(k)) : lerp([X[0], Y], [X[2], Y], ease(Math.min(k * 1.4, 1))); s += Dot(x, y - 22, 4.5, '', `fill:${wc}`); }
          if (c.ph === 'lost') s += T(X[2], Y - 26, '✕ таймаут', 'xr-pop bad', 'middle');
        });
        const q = S.q, ph = phase();
        if (q && ph.k === 0) s += Dot(...lerp([QB.x + QB.w, QB.y + 45], [IX.x, IX.y + 60], ease(ph.u / 600)), 5, '', `fill:${SD.kindColor('search')}`);
        if (S.refT && S.t - S.refT < 600) s += T(SY.x + SY.w - 34, SY.y + 104, 'refresh!', 'xr-pop ok', 'middle');
        return s;
      }
      function drawMain() { gSt.innerHTML = badges() + queryBox() + analyzer() + indexBox() + results() + cluster() + syncBox(); gDy.innerHTML = dynSvg(); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xse-backb', 13)}${T(68, 27, '← весь поиск', 'xr-s xse-back', 'middle')}</g>` + T(140, 27, t, 'xse-vt') + T(140, 46, sub, 'xr-s');
      function vAnalyze() {
        const C = 9000, u = S.vt % C, k = Math.floor(u / 1500);
        const title = DOCS0[6][1], a = analyze(title);
        S.pv.ana = 1;
        let s = head('Анализатор: из текста — в основы слов', 'один и тот же анализатор применяется к товарам при индексации и к запросу при поиске');
        s += R(24, 60, 952, 54, 'xse-codebg', 10) + T(36, 80, 'ТОВАР 1007', 'xr-m') + T(36, 102, ES(title), 'xse-qt');
        const steps = [['1. Токенизатор', 'режем по пробелам и знакам', a.map(t => t.raw)], ['2. lowercase', 'нижний регистр, ё → е', a.map(t => t.low)], ['3. stop', 'выбросить служебные слова', a.map(t => t.stop ? `✕${t.low}` : t.low)], ['4. snowball russian', 'отрезать окончание', a.filter(t => !t.stop).map(t => t.stem)]];
        steps.forEach(([n, d, ws], j) => {
          const y = 140 + j * 74, on = j <= k;
          s += R(24, y, 952, 64, 'xse-panel' + (j === k ? ' on' : ''), 10) + T(36, y + 22, n, 'xr-t') + T(36, y + 42, d, 'xse-ms');
          let x = 230;
          if (on) ws.forEach(w => { const st = String(w).startsWith('✕'), tw = Math.max(40, String(w).length * 7.2 + 14); if (x + tw < 966) s += R(x, y + 18, tw, 26, 'xse-tok' + (st ? ' stop' : j === 3 ? ' st' : ''), 6) + T(x + tw / 2, y + 36, ES(st ? String(w).slice(1) : w), 'xse-fn', 'middle'); x += tw + 6; });
        });
        s += R(24, 440, 952, 108, 'xse-panel', 10) + T(36, 462, 'ЗАЧЕМ', 'xr-m');
        s += T(36, 486, '«красные кроссовки» → [красн, кроссовк] совпадёт с «красная подошва», «красно-белые» и «Кроссовки» — разные формы, одна основа.', 'xr-s');
        s += T(36, 508, 'Без стемминга «красные» не нашли бы «красная»; без lowercase — «Кроссовки» в начале названия.', 'xse-ms');
        s += MONO(36, 532, 'GET /_analyze  {"analyzer": "russian", "text": "Красные кроссовки"}  →  ["красн", "кроссовк"]', 'on');
        return s;
      }
      function vIndex() {
        const ix = S.ix, rank = t => /^[а-яе]/.test(t) ? 0 : /^[a-z]/.test(t) ? 1 : 2, terms = Object.keys(ix.idx).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ru')), cyr = terms.filter(t => rank(t) === 0 && Object.keys(ix.idx[t]).length >= 2), hi = terms.indexOf(cyr[Math.floor(S.vt / 1800) % cyr.length]);
        let s = head('Обратный индекс: слово → товары и позиции', `${terms.length} основ из ${ix.N} названий товаров; списки отсортированы по номеру товара`);
        s += R(24, 60, 560, 488, 'xse-panel', 10) + T(36, 80, 'СЛОВАРЬ ТЕРМИНОВ И POSTINGS', 'xr-m');
        terms.slice(0, 20).forEach((t, j) => {
          const y = 104 + j * 21, on = j === hi, p = ix.idx[t];
          if (on) s += R(30, y - 14, 548, 19, 'xse-qrow', 4);
          s += T(36, y, ES(t), 'xse-fn' + (on ? ' xse-acc' : '')) + T(150, y, String(Object.keys(p).length), 'xse-ms') + T(180, y, Object.keys(p).map(id => `${id}:[${p[id].join(',')}]`).join('  '), 'xse-pn2');
        });
        if (terms.length > 20) s += T(36, 538, `… ещё ${terms.length - 20}: латиница и числа`, 'xse-ms');
        const t = terms[hi], p = ix.idx[t];
        s += R(596, 60, 380, 488, 'xse-panel', 10) + T(608, 80, `ОСНОВА «${ES(t)}»`, 'xr-m acc');
        Object.keys(p).slice(0, 6).forEach((id, j) => {
          const d = docOf(+id), toks = analyze(d[1]), y = 110 + j * 60;
          s += T(608, y, `товар ${id} · позиции ${p[id].join(', ')}`, 'xse-fn');
          let x = 608;
          toks.forEach(tk => { const on = tk.stem === t, w = Math.max(22, tk.raw.length * 6.4 + 8); if (x + w < 968) s += R(x, y + 8, w, 20, 'xse-tok' + (on ? ' st' : tk.stop ? ' stop' : ''), 4) + T(x + w / 2, y + 22, ES(cut(tk.raw, 14)), 'xse-pn2', 'middle'); x += w + 3; });
        });
        s += T(608, 486, 'Позиции нужны для фраз: «красные кроссовки»', 'xse-ms') + T(608, 504, 'как фраза — позиции красн и кроссовк подряд.', 'xse-ms') + T(608, 528, 'Обычная таблица — товар → слова; тут наоборот.', 'xse-ms');
        return s;
      }
      function vQuery() {
        const q = search(QUERIES[0], S.ix), C = 9000, u = S.vt % C, k = clamp((u - 1500) / 4500, 0, 1);
        const A = q.lists[0] || [], Bl = q.lists[1] || [];
        let s = head('Запрос: пересечение списков', '«красные кроссовки» → [красн, кроссовк]; идём по двум отсортированным спискам одновременно');
        const row = (y, name, list, other) => { let t = T(36, y + 18, name, 'xse-fn xse-acc'); list.forEach((id, j) => { const x = 170 + j * 90, both = other.includes(id), pass = k * Math.max(A.length, Bl.length) > j; t += R(x, y, 80, 28, 'xse-post big' + (pass && both ? ' hit' : pass ? ' seen' : ''), 6) + T(x + 40, y + 19, String(id), 'xse-fn', 'middle'); }); return t; };
        s += R(24, 60, 952, 220, 'xse-panel', 10);
        s += row(80, 'красн', A, Bl) + row(130, 'кроссовк', Bl, A);
        const ptr = Math.floor(k * Math.max(A.length, Bl.length));
        s += T(36, 200, `∩ AND (все слова): ${q.inter.filter((_, j) => j < ptr + 1 || k >= 1).join(', ')}`, 'xr-m acc') + T(36, 224, `∪ OR (любое слово, по умолчанию в match): ${q.sc.map(r => r.id).join(', ')}`, 'xr-s') + T(36, 252, 'Товары, где совпали оба слова, получают больший BM25 и стоят выше.', 'xse-ms');
        s += R(24, 292, 470, 256, 'xse-codebg', 10);
        ['GET /products/_search', '{', '  "query": { "bool": {', '    "must": { "match": { "title": {', '      "query": "красные кроссовки",', '      "operator": "and" } } },', '    "filter": [', '      { "term": { "category": "Обувь" } },', '      { "range": { "price": { "lte": 15000 } } } ]', '  } },', '  "size": 10', '}'].forEach((l, j) => { s += CODE(36, 314 + j * 19, l, 'sm'); });
        s += R(506, 292, 470, 256, 'xse-panel', 10) + T(518, 314, 'ЧТО ВАЖНО', 'xr-m');
        ['must — слова влияют на счёт (score)', 'filter — да/нет без счёта, кэшируется', 'should — «желательно»: добавляет к счёту', 'fuzzy — «кросовки» с опечаткой найдутся', 'match_phrase — слова подряд, по позициям', 'size 10 — каждый шард возвращает топ-10'].forEach((l, j) => { s += T(518, 342 + j * 30, '· ' + l, 'xr-s'); });
        return s;
      }
      function vBm25() {
        const q = search(QUERIES[0], S.ix), top = q.sc.slice(0, 2);
        S.pv.bm = 1;
        let s = head('Ранжирование BM25: почему этот товар выше', `запрос «${QUERIES[0]}», N = ${S.ix.N} товаров, средняя длина названия ${nf(S.ix.avg, 1)} слова`);
        s += R(24, 60, 952, 76, 'xse-codebg', 10) + MONO(36, 84, 'score = Σ по словам запроса  IDF(слово) × tf·(k1+1) / (tf + k1·(1 − b + b·длина/средняя))', 'on') + MONO(36, 106, 'IDF = ln(1 + (N − df + 0,5) / (df + 0,5))     k1 = 1,2   b = 0,75') + T(36, 128, 'IDF — редкость слова, tf — сколько раз оно в товаре, длина — сколько слов в названии', 'xse-ms');
        top.forEach((r, j) => {
          const d = docOf(r.id), x = 24 + j * 480;
          s += R(x, 148, 472, 300, 'xse-panel' + (j === 0 ? ' on' : ''), 10) + T(x + 12, 170, `${j + 1}. товар ${r.id}`, 'xr-t') + T(x + 460, 170, `score ${nf(r.s, 3)}`, 'xr-m ok', 'end');
          s += T(x + 12, 192, hlTitle(d[1], q.qs, 60), 'xse-tt') + T(x + 12, 212, `длина названия: ${S.ix.len[r.id]} ${pl(S.ix.len[r.id], 'слово', 'слова', 'слов')} (средняя ${nf(S.ix.avg, 1)})`, 'xse-ms');
          r.parts.forEach((p, i) => {
            const y = 240 + i * 96;
            s += T(x + 12, y, `«${p.t}»`, 'xse-fn xse-acc') + T(x + 120, y, `df = ${p.df} из ${S.ix.N}`, 'xse-ms') + T(x + 260, y, `tf = ${p.tf}`, 'xse-ms');
            s += MONO(x + 12, y + 22, `IDF = ln(1 + (${S.ix.N} − ${p.df} + 0,5)/(${p.df} + 0,5)) = ${nf(p.idf, 3)}`);
            s += MONO(x + 12, y + 42, `TF  = ${p.tf}·2,2/(${p.tf} + 1,2·${nf(p.norm, 2)}) = ${nf(p.tfp, 3)}`);
            s += MONO(x + 12, y + 62, `вклад = ${nf(p.idf, 3)} × ${nf(p.tfp, 3)} = ${nf(p.c, 3)}`, 'on');
          });
        });
        const a = top[0], b2 = top[1];
        s += R(24, 460, 952, 88, 'xse-panel', 10) + T(36, 482, 'ПОЧЕМУ ПЕРВЫЙ ВЫШЕ', 'xr-m');
        if (a && b2) s += T(36, 506, `${a.id}: ${nf(a.s, 3)} против ${b2.id}: ${nf(b2.s, 3)}. ${S.ix.len[a.id] < S.ix.len[b2.id] ? `У ${a.id} название короче (${S.ix.len[a.id]} против ${S.ix.len[b2.id]} слов) — каждое совпадение весит больше.` : a.parts.reduce((m, p) => m + p.tf, 0) > b2.parts.reduce((m, p) => m + p.tf, 0) ? `У ${a.id} слова запроса встречаются чаще — но с насыщением: второй раз добавляет меньше первого.` : 'Совпали более редкие слова.'}`, 'xr-s xse-acc');
        s += T(36, 530, 'Слово «красн» есть в 6 товарах из 8 — его IDF мал; «кроссовк» реже — поэтому совпадение по нему весит больше.', 'xse-ms');
        return s;
      }
      function vShards() {
        const L = layout(), n = L.nodes.length, C = 8000, u = S.vt % C, k = clamp((u - 800) / 2600, 0, 1), back = clamp((u - 3600) / 1600, 0, 1);
        let s = head('Шарды и реплики: scatter-gather', `${n} ${pl(n, 'узел', 'узла', 'узлов')}, 3 основных шарда${L.rep ? ' и по реплике на других узлах' : ', реплик нет — на одном узле их негде держать'}`);
        const co = [500, 100];
        s += R(co[0] - 90, co[1] - 22, 180, 40, 'xr-box', 8) + T(co[0], co[1] + 4, 'координатор', 'xr-t', 'middle');
        const shown = Math.min(n, 5), w = (952 - (shown - 1) * 12) / shown;
        for (let i = 0; i < shown; i++) {
          const x = 24 + i * (w + 12), y = 180;
          s += R(x, y, w, 210, 'xse-node', 10) + T(x + 12, y + 22, `узел ${i + 1}`, 'xr-t');
          L.nodes[i].forEach((sh, j) => {
            const sy = y + 40 + j * 54, docs = S.docs.filter(d => shardOf(d[0]) === sh.s).map(d => d[0]);
            s += R(x + 10, sy, w - 20, 46, 'xse-shard big' + (sh.p ? ' p' : ' r'), 6) + T(x + 18, sy + 18, `${sh.p ? 'primary' : 'реплика'} шард ${sh.s}`, 'xse-fn') + T(x + 18, sy + 36, `товары ${docs.join(', ')}`, 'xse-pn2');
            if (sh.p) { const tx = x + w / 2, ty = sy; s += Ln(co[0], co[1] + 18, tx, ty, 'xse-fan'); if (k > 0 && k < 1) s += Dot(...lerp([co[0], co[1] + 18], [tx, ty], ease(k)), 5, '', `fill:${SD.kindColor('search')}`); if (back > 0 && back < 1) s += Dot(...lerp([tx, ty], [co[0], co[1] + 18], ease(back)), 5, 'ok'); }
          });
        }
        s += R(24, 404, 952, 144, 'xse-panel', 10);
        ['1. координатор (любой узел) получает запрос и шлёт его в одну копию каждого шарда — primary или реплику', '2. каждый шард ищет в своём обратном индексе и возвращает свой топ-10 с баллами BM25', '3. координатор сливает 3 × 10 результатов в общий топ-10 и дозапрашивает сами документы', 'здоровье: green — все копии на месте; yellow — реплик не хватает; red — нет даже primary какого-то шарда', 'число шардов фиксируется при создании индекса; реплики можно добавить в любой момент'].forEach((l, j) => { s += T(36, 428 + j * 24, l, 'xr-s'); });
        return s;
      }
      function vRefresh() {
        const C = 10000, u = S.vt % C, ph = u < 1500 ? 0 : u < 4500 ? 1 : u < 6000 ? 2 : 3;
        let s = head('Refresh: почему документ виден не сразу', 'запись → буфер в памяти и translog → раз в секунду новый сегмент → документ находится');
        const box = (x, t, d, on, c) => R(x, 70, 220, 90, 'xse-panel' + (on ? ' on' : '') + (c || ''), 10) + T(x + 12, 94, t, 'xr-t') + T(x + 12, 116, d, 'xse-ms');
        s += box(24, 'PUT _doc/1009', '201 Created — принят', ph >= 0) + arrow(246, 115, 268, 115, ph >= 1 ? 'acc' : '');
        s += box(270, 'буфер + translog', 'в памяти, ещё не ищется', ph === 1, ph === 1 ? ' warn' : '') + arrow(492, 115, 514, 115, ph >= 2 ? 'acc' : '');
        s += box(516, 'refresh', 'буфер → новый сегмент', ph === 2) + arrow(738, 115, 760, 115, ph >= 3 ? 'acc' : '');
        s += box(762, 'находится', 'поиск видит товар 1009', ph === 3);
        if (ph === 1) s += T(270, 186, `GET _search «красные кроссовки» → товара 1009 нет: ждём refresh (${nf((4500 - u) / 1000, 1)} с)`, 'xr-s xse-warn');
        if (ph >= 3) s += T(762, 186, 'теперь 1009 — первый в выдаче', 'xr-s xse-ok');
        s += R(24, 210, 952, 160, 'xse-panel', 10) + T(36, 232, 'СЕГМЕНТЫ ИНДЕКСА', 'xr-m');
        const segs = [[1, 240], [2, 120], [3, 60], [4, 12], [5, 8]].concat(ph >= 3 ? [[6, 1]] : []);
        let x = 36;
        segs.forEach(([id, n]) => { const w = 30 + Math.sqrt(n) * 18; s += R(x, 250, w, 60, 'xse-seg' + (id === 6 ? ' fl' : ''), 6) + T(x + 8, 272, `_${id}`, 'xse-fn') + T(x + 8, 292, `${n} тыс. док.`, 'xse-pn2'); x += w + 8; });
        s += T(36, 336, 'Сегменты неизменяемы. Маленькие в фоне сливаются в большие (merge); удалённые документы вычищаются при слиянии.', 'xse-ms') + T(36, 356, 'Изменение товара = новая версия в новом сегменте + пометка «удалён» у старой.', 'xse-ms');
        s += R(24, 382, 952, 166, 'xse-codebg', 10);
        ['PUT /products/_settings  { "index": { "refresh_interval": "1s" } }      // по умолчанию', 'PUT /products/_doc/1009?refresh=wait_for                                   // ответ — когда уже ищется', 'PUT /products/_settings  { "index": { "refresh_interval": "-1" } }      // на время массовой загрузки', 'POST /products/_refresh                                                       // принудительно, дорого', '// translog: при падении узла всё из буфера восстанавливается из журнала'].forEach((l, j) => { s += CODE(36, 406 + j * 26, l, 'sm'); });
        return s;
      }
      function vSync() {
        const C = 11000, u = S.vt % C, k = clamp(u / 7000, 0, 1);
        let s = head('Синхронизация поиска с базой', 'поиск — копия; вопрос в том, как доносить до неё каждое изменение');
        const lane = (y, title, steps, failAt, cls) => {
          let t = R(24, y, 952, 150, 'xse-panel ' + cls, 10) + T(36, y + 22, title, 'xr-t');
          steps.forEach(([a, b2], i) => { const x = 40 + i * 236, on = k * steps.length > i, broke = failAt === i && on; t += R(x, y + 40, 210, 60, 'xse-step' + (broke ? ' bad' : on ? ' on' : ''), 8) + T(x + 10, y + 62, a, 'xse-fn') + T(x + 10, y + 82, b2, 'xse-ms' + (broke ? ' xse-bad' : '')); if (i < steps.length - 1) t += arrow(x + 212, y + 70, x + 234, y + 70, broke ? 'bad' : on ? 'acc' : ''); });
          return t;
        };
        s += lane(60, 'Двойная запись из сервиса', [['UPDATE products', 'цена 12 990 → 9 990 ₽'], ['COMMIT', 'в базе 9 990 ₽'], ['PUT в поиск', 'таймаут 5 с — ошибка'], ['в поиске', 'всё ещё 12 990 ₽']], 2, 'badb');
        s += T(36, 196, 'Сервис упал между записями, сеть моргнула, два обновления пришли в другом порядке — и поиск тихо разошёлся с базой.', 'xse-ms xse-bad');
        s += lane(220, 'CDC: из журнала базы', [['UPDATE products', 'COMMIT → запись в WAL'], ['Debezium', 'читает WAL, шлёт в Kafka'], ['индексатор', 'PUT с version = LSN'], ['в поиске', '9 990 ₽ через ≈ 1 с']], -1, 'okb');
        s += T(36, 356, 'Каждое зафиксированное изменение попадёт в поиск. Упал индексатор — дочитает с того же места. Версия не даст старому событию затереть новое.', 'xse-ms xse-ok');
        s += R(24, 382, 952, 166, 'xse-codebg', 10);
        ['// индексатор: идемпотентная запись с внешней версией', 'PUT /products/_doc/1001?version=27529912&version_type=external', '{ "title": "Кроссовки беговые Nike Pegasus 41, красные", "price": 9990, "category": "Обувь" }', '// пришло старое событие с меньшей версией → 409 Conflict, свежее не затёрто', '// переиндексация без простоя: новый индекс products_v8 + POST _aliases (products → products_v8)'].forEach((l, j) => { s += CODE(36, 406 + j * 26, l, 'sm'); });
        return s;
      }
      function vNotDb() {
        let s = head('Почему поиск — не основная база', 'поиск отлично находит, но плохо хранит правду: правда в базе, поиск из неё пересобирается');
        const rows = [['Транзакции', 'на несколько строк, ACID', 'нет: каждый документ отдельно'], ['Запись видна', 'сразу после COMMIT', 'после refresh (≈ 1 с)'], ['JOIN', 'есть', 'нет — данные кладут в документ'], ['Сменить тип поля', 'ALTER TABLE', 'только переиндексация'], ['Поиск по словам', 'LIKE: перебор, без ранжирования', 'обратный индекс, BM25, морфология'], ['Опечатки, синонимы', 'нет (pg_trgm — частично)', 'fuzzy, synonyms'], ['Если потеряли', 'бэкап и журнал — восстановить', 'пересобрать из базы']];
        s += R(24, 60, 952, 300, 'xse-panel', 10) + T(260, 84, 'PostgreSQL', 'xr-t') + T(620, 84, 'Elasticsearch', 'xr-t');
        rows.forEach(([a, b2, c], j) => { const y = 114 + j * 34; s += T(36, y, a, 'xr-m') + T(260, y, b2, 'xr-s' + (j === 4 || j === 5 ? ' xse-warn' : ' xse-ok')) + T(620, y, c, 'xr-s' + (j === 4 || j === 5 ? ' xse-ok' : j === 6 ? ' xse-acc' : ' xse-warn')); });
        const u = S.vt % 8000, k = clamp(u / 5000, 0, 1);
        s += R(24, 372, 952, 176, 'xse-panel', 10) + T(36, 394, '«КРАСНЫЕ КРОССОВКИ» В 12 МЛН ТОВАРОВ', 'xr-m');
        s += T(36, 424, 'PostgreSQL ILIKE', 'xr-s') + R(200, 412, 640, 14, 'xr-bar', 4) + R(200, 412, 640 * k, 14, 'xr-bar-f warn', 4) + T(852, 424, `${nf(2300 * k)} мс`, 'xr-m warn');
        s += T(36, 456, 'Elasticsearch', 'xr-s') + R(200, 444, 640, 14, 'xr-bar', 4) + R(200, 444, 640 * Math.min(1, k * 150) * 0.0065, 14, 'xr-bar-f', 4) + T(852, 456, `${nf(Math.min(15, 15 * k * 150))} мс`, 'xr-m ok');
        s += T(36, 490, 'База перебирает каждую строку (Seq Scan) и не умеет сортировать по релевантности; поиск берёт два готовых списка.', 'xse-ms');
        s += T(36, 512, 'Поэтому классическая схема: база — источник правды, поиск — витрина для чтения, которую можно пересоздать в любой момент.', 'xse-ms');
        return s;
      }
      const VIEWS = { analyze: vAnalyze, index: vIndex, query: vQuery, bm25: vBm25, shards: vShards, refresh: vRefresh, sync: vSync, notdb: vNotDb };
      function partNow(k) {
        if (k === 'analyze') return '<b>Анализатор</b>: токены → нижний регистр → без стоп-слов → основы. «Кроссовки» становятся «кроссовк», «красные», «красная» и «красно» — «красн». Тот же анализатор разбирает запрос.';
        if (k === 'index') return '<b>Обратный индекс</b>: для каждой основы — список товаров с позициями. Найти все товары со словом — взять готовый список, а не перебирать каталог.';
        if (k === 'query') return '<b>Запрос</b> разбирается на основы, их списки пересекаются (AND) или объединяются (OR). Товары, где есть все слова, получают больший балл.';
        if (k === 'bm25') return '<b>BM25</b>: вклад слова = редкость слова × частота в товаре с насыщением и поправкой на длину названия. Короткое название с обоими словами побеждает длинное.';
        if (k === 'shards') { const L = layout(); return `<b>Шарды:</b> 3 основных ${L.rep ? 'и реплики на соседних узлах' : 'без реплик — на одном узле их негде держать (yellow)'}. Запрос идёт во все шарды параллельно, координатор сливает их топы.`; }
        if (k === 'refresh') return '<b>Refresh</b> раз в секунду превращает буфер в сегмент. До этого документ принят (201), но не находится — поиск «почти в реальном времени».';
        if (k === 'sync') return '<b>Синхронизация:</b> двойная запись из сервиса теряет обновления при сбоях. CDC читает журнал базы и доносит каждое изменение, по порядку и с версией.';
        if (k === 'notdb') return '<b>Поиск — не база:</b> нет транзакций, запись видна через refresh, схему не поменять без переиндексации. Правда в базе, поиск из неё пересобирается.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.docs) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'analyze' && S.vt > 5000) done('pana'); if (pk === 'bm25' && S.vt > 2500) done('pbm'); }
        if (!S.q || S.t - S.q.t0 > (S.scn === 'fresh' ? 2600 : 4200)) newQuery();
        changeStep(); refreshStep(); downStep(); freshCheck();
        S.hist = S.hist.filter(h => h.t > S.t - 10000);
      }
      function draw() {
        if (!S.docs) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { if (S.cfg !== S.scn + '|' + N()) { S.cfg = S.scn + '|' + N(); } },
        scenario(id) { const fl = S.flags; S.scn = id; reset(); S.flags = fl; },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (key === 'count') { if (+v >= 2 && S.flags.red) S.pv.wantDown = 1; return +v >= 2 ? `Узлов ${v}: у каждого шарда есть реплика на другом узле — кластер green и переживает падение узла.` : 'Один узел: реплики разместить негде — кластер yellow, падение узла кладёт поиск целиком.'; }
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const q = curRes(), h = health();
          if (S.scn === 'fresh') { const inDb = S.dbDocs.some(d => d[0] === NEW[0]), inIx = S.docs.some(d => d[0] === NEW[0]); return !inDb ? '<b>Скоро добавят новые красные кроссовки 1009.</b> Смотри на буфер справа внизу и на выдачу.' : !inIx ? '<b>Товар 1009 уже в базе, но поиск его не находит:</b> он в буфере и ждёт refresh. Это near real-time — обычно меньше секунды.' : '<b>Refresh прошёл:</b> товар 1009 в сегменте и находится — в выдаче по «красные кроссовки» он первый.'; }
          if (S.scn === 'dual') return viaCdc() ? '<b>Индексация через CDC:</b> изменения цен читаются из журнала базы и доходят все — рассинхрон исчезает после ближайшего refresh.' : `<b>Двойная запись:</b> сервис меняет цену в базе, потом отдельно пишет в поиск. Часть записей в поиск падает по таймауту — в выдаче старые цены (красные пометки). Рассинхрон: ${Object.keys(S.drift).length}.`;
          if (S.scn === 'down') return S.nodeDown < 0 ? `<b>Скоро упадёт узел 1.</b> ${N() === 1 ? 'Узел один — ему некуда передать шарды.' : 'У каждого шарда есть реплика на другом узле.'}` : h === 'red' ? `<b>Кластер red:</b> ${N() === 1 ? 'единственный узел лежит — поиск недоступен.' : `шарды ${lostShards().join(', ')} без копий — выдача неполная.`} Нужно 2+ узла, чтобы у каждого шарда была реплика.` : '<b>Узел упал, но поиск работает:</b> реплики на других узлах стали primary, выдача полная. Кластер yellow, пока копии не восстановят.';
          if (S.scn === 'like') return '<b>ILIKE в базе</b> перебирает все 12 млн строк (Seq Scan) — около 2,3 с, без ранжирования и морфологии. Поисковый движок берёт готовые списки из обратного индекса — миллисекунды.';
          return `<b>Запрос «${ES(q ? q.q : '')}»</b> проходит анализатор → основы ищутся в обратном индексе → списки пересекаются → каждый шард считает BM25 и отдаёт свой топ → координатор сливает выдачу. ${health() === 'yellow' ? 'Узел один: реплик нет, кластер yellow.' : ''}`;
        },
        stats() {
          const h = health(), avg = S.hist.length ? S.hist.reduce((a, b) => a + b.ms, 0) / S.hist.length : 0, dr = Object.keys(S.drift).length;
          return [
            ['Запрос', avg ? nf(avg) + ' мс' : '…', avg > 500 ? 'bad' : avg > 40 ? 'warn' : 'ok', S.scn === 'like' ? 'ILIKE в базе' : 'took в ответе'],
            ...(() => { const q = curRes(); return [['Найдено', q ? (q.err ? '503' : String(q.shown.length)) : '…', q && q.lost.length ? 'bad' : '', q ? (q.err ? 'шарды недоступны' : `все слова: ${q.shown.filter(r => r.all).length}`) : '']]; })(),
            ['Здоровье', h, h === 'green' ? 'ok' : h === 'yellow' ? 'warn' : 'bad', `${N()} ${pl(N(), 'узел', 'узла', 'узлов')}`],
            ['В буфере', String(S.buf.length), S.buf.length ? 'warn' : 'ok', 'ждут refresh'],
            ['Рассинхрон', String(dr), dr ? 'bad' : 'ok', viaCdc() ? 'CDC' : 'двойная запись'],
            ['Загрузка', Math.round(Math.min(util(), 9) * 100) + ' %', util() > 1 ? 'bad' : util() > 0.75 ? 'warn' : 'ok', `${SD.fmt.num(rps())} поисков/с`]
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
