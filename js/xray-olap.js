/* «Аналитическая БД изнутри»: строки против колонок, сжатие и блоки min/max, звезда и история (SCD2),
   шарды и перемешивание (MPP), вставка пачками и куски, материализованные представления, партиции по месяцам. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const byt = b => b >= 1e9 ? nf(b / 1e9, b >= 1e11 ? 0 : 1) + ' ГБ' : b >= 1e6 ? nf(b / 1e6, b >= 1e7 ? 0 : 1) + ' МБ' : b >= 1e3 ? nf(b / 1e3) + ' КБ' : nf(b) + ' Б';
  const tms = ms => ms >= 1000 ? nf(ms / 1000, ms >= 1e4 ? 0 : 1) + ' с' : ms >= 10 ? nf(ms) + ' мс' : nf(ms, 1) + ' мс';
  const mln = v => v >= 1e9 ? nf(v / 1e9, 1) + ' млрд' : v >= 1e6 ? nf(v / 1e6, v >= 1e7 ? 0 : 1) + ' млн' : v >= 1e3 ? nf(v / 1e3, v >= 1e4 ? 0 : 1) + ' тыс.' : nf(v);
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const bez = (a, c, b, t) => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
  const qf = u => 1 + Math.pow(Math.max(u, 0), 3) / (1 - Math.min(u, 0.95));
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function along(pts, f) {
    if (pts.length < 2) return pts[0];
    const seg = []; let L = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
    let x = clamp(f, 0, 1) * L;
    for (let i = 0; i < seg.length; i++) {
      if (x <= seg[i] || i === seg.length - 1) { const k = seg[i] ? Math.min(1, x / seg[i]) : 1; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
      x -= seg[i];
    }
    return pts[pts.length - 1];
  }
  /* ---------- примитивы SVG ---------- */
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
  function arrow(x1, y1, x2, y2, c) {
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
    const a = Math.atan2(y2 - y1, x2 - x1), L = 8, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`;
    return `<line class="xo-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xo-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  /* SQL с подсветкой: ключевые слова, строки, числа */
  const KW = /^(SELECT|FROM|WHERE|AND|GROUP|BY|ORDER|DESC|JOIN|ON|AS|BETWEEN|CREATE|MATERIALIZED|VIEW|ENGINE|PARTITION|ALTER|TABLE|DROP|DELETE|INSERT|INTO|VALUES|TTL|INTERVAL|MONTH|TO|IS|NULL|NOT|OR)$/;
  const FN = /^(sum|count|toDate|toYYYYMM|avg|uniq|MergeTree|SummingMergeTree)$/;
  const hl = line => line.split(/('[^']*'|\s+|[(),=<>*;]+)/).filter(x => x !== '').map(tk => /^'.*'$/.test(tk) ? `<tspan class="xo-st">${ES(tk)}</tspan>` : KW.test(tk) ? `<tspan class="xo-kw">${tk}</tspan>` : FN.test(tk) ? `<tspan class="xo-fn">${tk}</tspan>` : /^\d[\d.]*$/.test(tk) ? `<tspan class="xo-nu">${tk}</tspan>` : ES(tk)).join('');
  const SQL = (x, y, line, c) => `<text class="xo-sql${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${hl(line)}</text>`;

  /* ---------- данные примера: магазин, таблица orders, отчёт «выручка по странам за июль» ---------- */
  const CC = ['RU', 'KZ', 'BY', 'UZ', 'AM', 'GE'];
  const CSH = [0.58, 0.15, 0.10, 0.08, 0.05, 0.04];          // доля заказов
  const REV = [112.4, 29.1, 19.4, 15.6, 9.7, 7.3];           // выручка июля, млрд ₽
  const CITY = [['Москва', 41.3], ['Санкт-Петербург', 17.8], ['Алматы', 12.2], ['Минск', 9.1], ['Казань', 6.4], ['Ташкент', 5.9]];
  const MON = [
    { id: '202608', name: '2026-08', rows: 32e6, cur: true }, { id: '202607', name: '2026-07', rows: 104e6, jul: true },
    { id: '202606', name: '2026-06', rows: 101e6 }, { id: '202605', name: '2026-05', rows: 99e6 }, { id: '202604', name: '2026-04', rows: 96e6, old: true }];
  const TOTAL = 432e6, JUL = 104e6;
  // колонка, тип, байт в строке, байт после сжатия
  const COLS = [['order_id', 'bigint', 8, 1.9], ['user_id', 'bigint', 8, 3.1], ['product_id', 'int', 4, 1.6], ['country', 'char(2)', 2, 0.1], ['created_at', 'timestamp', 8, 0.7], ['amount', 'numeric(12,2)', 8, 3.6], ['status', 'text', 8, 0.3],
    ['currency', 'char(3)', 3, 0.05], ['payment', 'text', 8, 0.3], ['delivery', 'text', 8, 0.3], ['city', 'text', 12, 0.9], ['address', 'text', 48, 14], ['promo_code', 'text', 6, 0.8], ['discount', 'numeric(12,2)', 8, 1.2],
    ['qty', 'int', 4, 0.4], ['device', 'text', 7, 0.3], ['utm_source', 'text', 10, 0.6], ['warehouse_id', 'int', 4, 0.5], ['courier_id', 'int', 4, 1.5], ['updated_at', 'timestamp', 8, 1.9], ['is_gift', 'boolean', 1, 0.05], ['comment', 'text', 20, 4.2]];
  const NEED = [3, 4, 5];
  const RAW_ROW = 220, ZIP_ROW = 38.3, NEED_ZIP = 4.4;
  const FULL = [
    ['10482931', '55120', '3071', 'RU', '2026-07-14 12:31:07', '1290.00', 'paid', 'RUB', 'card', 'courier', 'Москва', 'ул. Тверская, 7', 'SUMMER10', '129.00', '1', 'ios', 'yandex', '14', '2207', '2026-07-14 12:40:51', 'false', 'позвонить заранее'],
    ['10482932', '80441', '118', 'KZ', '2026-07-14 12:31:09', '845.50', 'paid', 'KZT', 'card', 'pickup', 'Алматы', 'пр. Абая, 150', '', '0.00', '2', 'android', 'google', '31', '0', '2026-07-14 12:31:09', 'false', ''],
    ['10482933', '23878', '9012', 'RU', '2026-07-14 12:31:15', '3490.00', 'cancelled', 'RUB', 'sbp', 'courier', 'Казань', 'ул. Баумана, 12', '', '0.00', '1', 'web', 'direct', '9', '1840', '2026-07-14 13:02:44', 'true', 'подарочная упаковка'],
    ['10482934', '12008', '3071', 'BY', '2026-07-14 12:31:18', '1290.00', 'paid', 'BYN', 'card', 'post', 'Минск', 'ул. Немига, 3', 'SUMMER10', '129.00', '1', 'web', 'vk', '22', '0', '2026-07-14 12:31:18', 'false', '']];
  const ROWS = [
    ['10482931', '55120', '3071', 'RU', '2026-07-14 12:31:07', '1290.00', 'paid'], ['10482932', '80441', '118', 'KZ', '2026-07-14 12:31:09', '845.50', 'paid'],
    ['10482933', '23878', '9012', 'RU', '2026-07-14 12:31:15', '3490.00', 'cancelled'], ['10482934', '12008', '3071', 'BY', '2026-07-14 12:31:18', '1290.00', 'paid'],
    ['10482935', '67311', '455', 'RU', '2026-07-14 12:31:20', '199.00', 'refunded'], ['10482936', '30115', '2204', 'UZ', '2026-07-14 12:31:26', '5600.00', 'paid'],
    ['10482937', '91883', '118', 'RU', '2026-07-14 12:31:31', '845.50', 'paid'], ['10482938', '44019', '7310', 'AM', '2026-07-14 12:31:40', '2150.00', 'new']];
  const ML = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const md = d => { let m = 0; while (d > ML[m]) { d -= ML[m]; m++; } return String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); };
  const JUL0 = 182, JUL1 = 212, TODAY = 222, MAY1 = 121;

  /* ---------- геометрия общей картинки (viewBox 1000 × 560) ---------- */
  const SRC = { x: 16, y: 52, w: 150, h: 150 }, HUB = [198, 96], YB = 96;
  const SZ = { x: 230, y: 46, w: 754, h: 342 }, MCX = 236, SX0 = 306, SXW = 670, SHY = 72, SHB = 384;
  const RY0 = 102, RH = 42, RG = 4, RBOT = 328, FB = 342, FT1 = 360, FT2 = 375, QB = 391;
  const STAR = { x: 16, y: 212, w: 206, h: 176 };
  const DASH = { x: 16, y: 398, w: 150, h: 154 }, CO = { x: 176, y: 398, w: 160, h: 74 }, MVB = { x: 176, y: 478, w: 160, h: 74 };
  const SQB = { x: 346, y: 398, w: 340, h: 154 }, RES = { x: 696, y: 398, w: 288, h: 154 };
  const DELAY = 14, LIMIT = 22, QGAP = 1500;
  const rowY = mi => RY0 + mi * (RH + RG);

  SD.XRAY.olap = {
    viewBox: '0 0 1000 560',
    cta: 'Колонки вместо строк, сжатие и min/max, звезда и история, шарды и перемешивание, куски и партиции — на живой таблице заказов',
    dive: 'olap',
    simple: () => ({
      an: 'Как <b>склад, где товар разложен не по заказам, а по видам</b>: все чайники на одной полке, все кружки — на другой. Чтобы узнать, сколько продали чайников за июль, не вскрываешь каждую коробку с заказом — идёшь к одной полке. А полок много, и считают их несколько кладовщиков сразу.',
      pl: 'Обычная база хранит заказ целиком, строкой. Аналитическая — каждую колонку отдельно и сжато. Отчёт «выручка по странам за июль» читает только 3 колонки из 22 и только июль, а считают его сразу несколько серверов, и каждый отправляет наверх лишь маленький итог.'
    }),
    props: ['count', 'replicas', 'schema', 'mv', 'partition', 'insert'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Дашборд считает выручку по странам за июль, конвейер дописывает новые заказы. Всё по настройкам узла.' },
      { id: 'join', name: 'JOIN по другому ключу', note: 'Отчёт по городам покупателей: заказы разложены по order_id, покупатели — по user_id. Строкам приходится ехать между серверами.' },
      { id: 'skew', name: 'Перекос по ключу', note: 'Таблицу разложили по шардам по стране. На Россию приходится 58 % заказов — её шард считает дольше всех.' },
      { id: 'rows', name: 'Поток вставок', note: 'Сервис сам пишет каждый заказ в аналитическую базу. Пачками через буфер или по одной строке — смотри настройку «Вставка данных».' },
      { id: 'drop', name: 'Чистим старое', note: 'Раз в месяц удаляем данные старше трёх месяцев — апрель 2026.' }
    ],
    tries: [
      { id: 'mv', text: 'Включи материализованные представления: дашборд перестаёт ходить по шардам и читает готовые суммы' },
      { id: 'rows', text: 'В «Поток вставок» поставь вставку «Построчно» и дождись ошибки Too many parts, потом верни пачки' },
      { id: 'join', text: 'В «JOIN по другому ключу» выбери модель «Одна широкая таблица»: перемешивание по сети пропадает' },
      { id: 'skew', text: 'В «Перекосе» поставь 4+ шарда и убедись, что шард России всё равно самый медленный' },
      { id: 'drop', text: 'В «Чистим старое» выключи партиции: вместо удаления папки база переписывает огромный кусок' },
      { id: 'pcols', text: 'Открой блок «Строки и колонки» и дождись, пока строковая база дочитает таблицу' },
      { id: 'pzone', text: 'Открой блок «Сжатие и min/max» и найди блок, который пропущен по min/max' },
      { id: 'pscd', text: 'Открой блок «История (SCD2)» и проверь, какому городу досталась выручка заказа от 3 июля' }
    ],
    parts: {
      cols: {
        name: 'Строки и колонки', knobs: ['schema'],
        an: 'Как <b>анкеты и картотека</b>: строковая база хранит анкету каждого покупателя целиком, колоночная — отдельный ящик для каждого вопроса. Чтобы узнать средний возраст, не листаешь анкеты — открываешь один ящик «возраст».',
        pl: 'В строковой базе (PostgreSQL) заказ лежит на диске целиком: все 22 поля подряд. Чтобы сложить суммы, база читает и адреса, и комментарии. В колоночной (ClickHouse) каждая колонка — свой файл, и отчёт открывает только created_at, country и amount.',
        how: ['Таблица orders: 22 колонки, ≈ 220 байт на строку, 432 млн строк — ≈ 95 ГБ.', 'Строковая база хранит страницы по 8 КБ, в каждой ≈ 37 строк целиком. Взять из страницы одну колонку нельзя — читается вся страница.', 'Отчёт «выручка по странам за июль» в строковой базе читает все страницы таблицы — десятки гигабайт. Индекс по дате сократит до июля, но строки всё равно целиком.', 'Колоночная база хранит каждую колонку в своём файле: created_at.bin, country.bin, amount.bin…', 'Отчёт открывает 3 файла из 22 и читает в 50 раз меньше байт.', 'Плата: вставить или поменять одну строку дорого — это 22 файла. Поэтому колоночные базы любят большие пачки и почти не умеют UPDATE.'],
        watch: 'Слева — страница строковой базы с настоящими строками: нужные отчёту значения выделены, остальное читается зря; клетки ниже — вся таблица, страница за страницей. Справа — 22 файла колонок, читаются только три. Внизу — сколько байт прочитано и сколько это займёт на настоящем диске.',
        real: 'PostgreSQL и MySQL — строковые (для транзакций, OLTP). ClickHouse, BigQuery, Snowflake, Vertica — колоночные (для аналитики, OLAP). ClickHouse читает 1–2 млрд строк в секунду на сервер, если колонок в запросе мало. Колонка в ClickHouse — файлы amount.bin (данные) и amount.cmrk2 (засечки для поиска).'
      },
      comp: {
        name: 'Сжатие и min/max', knobs: ['partition'],
        an: 'Как <b>список покупок «молоко × 3»</b> вместо «молоко, молоко, молоко»: одинаковое пишешь один раз. А на коробках с документами подписано «январь–март» — если ищешь июль, коробку даже не открываешь.',
        pl: 'В одной колонке лежат похожие значения, поэтому она отлично сжимается: страны заменяют номерами из словаря, повторы — парой «значение × сколько раз». Колонку делят на блоки и для каждого запоминают минимум и максимум — блоки, где точно нет июля, не читают.',
        how: ['<b>Словарь</b>: в колонке country всего 6 разных значений. Каждое заменяют номером: RU → 0, KZ → 1… Вместо 2 байт — 3 бита.', '<b>RLE</b> (повторы подряд): если строки отсортированы по стране, RU RU RU RU пишут как «RU × 4». Поэтому порядок сортировки (ORDER BY) сильно влияет на сжатие.', '<b>Дельты</b> для времени: вместо 12:31:07, 12:31:09, 12:31:15 хранят +2 с, +6 с — маленькие числа.', 'Поверх — общий сжиматель LZ4 или ZSTD. Итог: 220 байт строки превращаются в ≈ 38.', '<b>Блоки (гранулы)</b> по 8 192 строки. Для каждого блока записаны min и max колонок ключа.', 'Запрос «за июль» сравнивает свой диапазон с min/max блока: не пересекаются — блок пропускают, его байты даже не читаются.'],
        watch: 'Сверху колонка country до и после словаря, посередине — она же после сортировки и RLE. Ниже — блоки по 8 192 строки с min/max даты: проверка идёт по блокам, серые пропущены, зелёные прочитаны. В самом низу — сколько весит каждая колонка до и после сжатия.',
        real: 'ClickHouse: тип LowCardinality(String) — словарь, кодеки Delta и DoubleDelta для времени, Gorilla для метрик, по умолчанию LZ4, можно ZSTD. Гранула — 8 192 строки, разреженный первичный индекс хранит одну засечку на гранулу, min/max пишется для ключа партиции (minmax-индекс). Parquet и Vertica тоже используют словарь и RLE.'
      },
      star: {
        name: 'Модель данных', knobs: ['schema'],
        an: 'Как <b>чек и справочники</b>: в чеке только номера — товар №3071, покупатель №55120, а названия, категории и города лежат в справочниках. Чек короткий, справочники маленькие.',
        pl: 'Звезда: в центре таблица фактов — события с числами (заказы и суммы), вокруг — таблицы измерений: кто купил, что купил, когда. Снежинка дробит измерения ещё мельче. Широкая таблица (OBT), наоборот, склеивает всё в одну.',
        how: ['<b>Факт</b> fact_orders — одна строка на заказ: ключи измерений и числа (amount, qty). Миллиарды строк.', '<b>Измерения</b> dim_user, dim_product, dim_date — описания: город, категория, день недели. Тысячи и миллионы строк.', 'Отчёт — это факт JOIN нужные измерения, условие по измерениям и GROUP BY по их полям.', '<b>Снежинка</b>: у измерения свои справочники (товар → категория, покупатель → город). Места меньше, JOIN больше.', '<b>Широкая таблица</b>: все поля прямо в строке заказа. JOIN не нужен, читается быстрее всего, но название категории повторено миллионы раз, и переименовать её — значит переписать таблицу.', 'Колоночной базе широкие таблицы не страшны: лишние колонки она просто не читает.'],
        watch: 'Таблицы с типами колонок и значениями. Подсвеченная строка факта ищет свои строки в измерениях — линия показывает, по какому ключу. Внизу собирается строка отчёта. Поменяй «Модель данных» справа — картинка перестроится.',
        real: 'Звезда и снежинка — из книги Ральфа Кимбалла «The Data Warehouse Toolkit». В dbt факты называют fct_, измерения — dim_. ClickHouse держит маленькие измерения в словарях (Dictionary) прямо в памяти, а BigQuery и ClickHouse хорошо работают и с широкими таблицами.'
      },
      scd: {
        name: 'История (SCD2)', knobs: ['schema'],
        an: 'Как <b>трудовая книжка</b>: новое место работы не стирает старое, а дописывается строкой «с такого-то числа». Всегда видно, где человек работал в любой день.',
        pl: 'Покупательница переехала из Казани в Москву. Если просто переписать город, все её старые заказы «переедут» в Москву. SCD2 не перезаписывает строку: закрывает старую датой и добавляет новую. Каждый заказ ссылается на ту версию покупателя, что была в день заказа.',
        how: ['В dim_user у покупательницы 55120 строка: город Казань, действует с 2025-03-02 по «бесконечность» (9999-12-31).', '10 июля приходит изменение: city = Москва.', '<b>SCD1</b> (перезапись): UPDATE city = \'Москва\'. История потеряна: заказ от 3 июля теперь считается московским.', '<b>SCD2</b>: старой строке ставят valid_to = 2026-07-10 и is_current = false, добавляют новую с новым ключом user_key = 1377.', 'Заказ от 14 июля пишется в факт с ключом 1377. Заказ от 3 июля так и ссылается на 901 — Казань.', 'Отчёт по городам за июль делит выручку честно: 3 490 ₽ — Казани, остальное — Москве.'],
        watch: 'Шкала июля: точки — заказы, черта — день переезда. В середине таблица dim_user: в день переезда старая строка закрывается, ниже появляется новая. Стрелка от каждого заказа ведёт к той версии, что действовала в его день. Внизу — отчёт при SCD1 и при SCD2.',
        real: 'SCD — slowly changing dimension, медленно меняющееся измерение. Тип 1 — перезапись, тип 2 — новая строка с valid_from/valid_to, тип 3 — колонка «предыдущее значение». В dbt SCD2 делают снапшотами (dbt snapshot): они сами ставят dbt_valid_from и dbt_valid_to.'
      },
      mpp: {
        name: 'Шарды и перемешивание', knobs: ['count', 'replicas', 'schema'],
        an: 'Как <b>подсчёт голосов по участкам</b>: каждый участок считает свои бюллетени, а в центр отправляет только итог. Но если бюллетени надо сверить со списком избирателей, который лежит на другом участке, бумаги приходится возить.',
        pl: 'Строки таблицы разложены по нескольким серверам (шардам) по ключу. Отчёт считается на всех шардах одновременно, каждый отправляет координатору маленький итог. Медленно становится, когда для JOIN строки должны переехать на другой сервер.',
        how: ['При вставке шард выбирают по ключу: order_id % 3 → шард 1, 2 или 3. Строки делятся поровну.', 'Запрос приходит на координатор (Distributed-таблица), и тот рассылает его на все шарды.', 'Каждый шард читает свои строки и считает частичные суммы: RU 37,5 · KZ 9,7 …', 'Координатор складывает частичные итоги — по сети едут байты, а не миллионы строк.', '<b>JOIN по другому ключу</b>: покупатели лежат по user_id, заказы — по order_id. Чтобы их склеить, строки заказов перемешивают по сети (shuffle) — это самая дорогая часть.', '<b>Перекос</b>: если ключ — страна, на шард России попадает 58 % строк. Запрос ждёт самого медленного шарда.'],
        watch: 'Фазы идут по кругу: раскладка строк по ключу, параллельный подсчёт с частичными итогами, перемешивание при JOIN, перекос. Подписи у летящих строк — какой ключ привёл их на этот шард.',
        real: 'ClickHouse: Distributed-таблица с ключом шардирования, GLOBAL JOIN рассылает маленькую таблицу на все шарды. Greenplum: DISTRIBUTED BY (user_id) и «Redistribute Motion» в плане. Spark и Trino называют перемешивание shuffle и exchange. Совет: класть рядом то, что часто склеивают (co-location), и выбирать ключ с равномерным распределением.'
      },
      ins: {
        name: 'Вставка и куски', knobs: ['insert', 'partition'],
        an: 'Как <b>стопки бумаг на столе</b>: каждая новая пачка — отдельная стопка, а секретарь в фоне подшивает маленькие стопки в толстые папки. Бросай листы по одному — секретарь не успеет, и стол завалит.',
        pl: 'Колоночная база (движок MergeTree) не дописывает строки в старые файлы. Каждая вставка — новый кусок на диске со своими файлами колонок. В фоне куски сливаются в большие. Тысячи вставок по одной строке — тысячи кусков, и база начинает отказывать.',
        how: ['INSERT пачкой в 50 000 строк создаёт один кусок: папку 202608_412_412_0 с файлами колонок внутри.', 'Имя куска: партиция _ первый блок _ последний блок _ уровень слияния.', 'Фоновое слияние берёт несколько соседних кусков и пишет один большой: 202608_409_412_1. Уровень растёт.', 'Чем меньше кусков, тем быстрее чтение: у каждого куска свои файлы и засечки.', 'Вставка по одной строке рождает кусок на каждую строку. Слияния не успевают: при 150 кусках вставки замедляются, при 300 — ошибка Too many parts.', 'Лекарство — копить строки: пачками из конвейера, через Kafka engine или Buffer-таблицу, асинхронные вставки (async_insert).'],
        watch: 'Одна партиция одного шарда. Новые куски появляются справа, слияние подсвечивает соседей и склеивает их в один. Справа — что лежит в папке нового куска. Полоска сверху сравнивает число кусков с порогами замедления и ошибки.',
        real: 'ClickHouse: parts_to_delay_insert = 150 и parts_to_throw_insert = 300 на партицию, ошибка «Code: 252. Too many parts». Совет из документации — не чаще 1 вставки в секунду, от 10–100 тыс. строк в пачке. Список кусков — SELECT * FROM system.parts.'
      },
      mv: {
        name: 'Материализованные представления', knobs: ['mv', 'insert'],
        an: 'Как <b>копилка с бумажкой «итого»</b>: кладя монету, сразу исправляешь сумму на бумажке. Чтобы узнать, сколько накопил, не пересчитываешь монеты — смотришь на бумажку.',
        pl: 'Материализованное представление — таблица с заранее посчитанными суммами. Её обновляет сама вставка: пришла пачка заказов — суммы по дням и странам тут же выросли. Дашборд читает 186 готовых строк вместо 104 млн.',
        how: ['Создаём: CREATE MATERIALIZED VIEW mv_revenue_daily … AS SELECT toDate(created_at) AS day, country, sum(amount), count() FROM orders GROUP BY day, country.', 'Каждая вставка в orders проходит через этот SELECT: из пачки считаются суммы по (день, страна).', 'Маленькие суммы дописываются в mv_revenue_daily (SummingMergeTree): одинаковые ключи при слиянии складываются.', 'Дашборд: SELECT country, sum(revenue) FROM mv_revenue_daily WHERE day в июле — 31 × 6 = 186 строк.', 'Плата: вставка дороже (считаем ещё и суммы), а быстрым становится только тот отчёт, под который MV построено.', 'Поменяли логику — пересчитываем MV по старым данным (бэкфилл).'],
        watch: 'Слева приходит пачка заказов, представление сворачивает её в суммы по (день, страна), и числа в таблице справа растут. Внизу — два пути дашборда: по сырым строкам и по готовым суммам, с числом прочитанных строк.',
        real: 'ClickHouse: MATERIALIZED VIEW … TO таблицу с движком SummingMergeTree или AggregatingMergeTree (для uniq и квантилей — функции -State и -Merge). BigQuery и Snowflake тоже умеют материализованные представления. Дашборды Superset, Grafana, DataLens обычно смотрят именно на такие агрегаты.'
      },
      prt: {
        name: 'Партиции по месяцам', knobs: ['partition'],
        an: 'Как <b>архив по годам на разных полках</b>: нужен июль — снимаешь одну папку. Пора выбросить старое — выносишь всю полку целиком, а не вычёркиваешь строчки по одной.',
        pl: 'Таблица разбита на партиции по месяцам — у каждой свои куски и папки на диске. Запрос за июль трогает только июльскую партицию, а удалить апрель — значит удалить папку. Мгновенно.',
        how: ['PARTITION BY toYYYYMM(created_at): у каждого месяца свои куски — 202607_…, 202606_….', 'Запрос с условием на created_at сразу отбрасывает партиции не того месяца — их даже не открывают.', 'Куски разных месяцев никогда не сливаются между собой.', '<b>DROP PARTITION 202604</b> удаляет папки апреля за доли секунды, ничего не переписывая.', 'Без партиций апрель перемешан с маем и июнем в общих кусках. DELETE WHERE created_at < … запускает мутацию: переписать каждый кусок, где есть хоть одна апрельская строка.', 'Не дробите слишком мелко: партиции по дням за несколько лет — тысячи партиций и миллионы файлов. Обычно — по месяцам.'],
        watch: 'Папки таблицы на диске. Отчёт за июль подсвечивает одну партицию. Потом приходит чистка: с партициями папка апреля исчезает разом, без партиций огромный кусок переписывается целиком.',
        real: 'ClickHouse: PARTITION BY toYYYYMM(created_at), ALTER TABLE … DROP PARTITION, TTL created_at + INTERVAL 3 MONTH DELETE (удаляет по сроку сам). Мутации видно в system.mutations. В BigQuery — партиции по дате и partition expiration.'
      }
    },
    legend: [['read', 'Отчёт: запрос дашборда'], ['write', 'Вставка: пачка или одна строка'], ['ok', 'Частичный итог шарда, ответ дашборду'], ['job', 'Строка едет на другой шард (перемешивание)'],
      ['sq xo-sw0', 'Свежий кусок после вставки'], ['sq xo-sw3', 'Большой кусок после слияний'], ['sq xo-swr', 'Кусок читается этим отчётом'], ['sq xo-swk', 'Пропущен: не та партиция'], ['bad', 'Отказ вставки, удаление']],
    live: (n, r, all) => {
      const l = r.load || {}, rps = Object.keys(l).reduce((s, k) => s + l[k], 0);
      const out = [['Поток', SD.fmt.num(rps) + '/с', '']];
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      out.push(['Шарды × копии', `${n.props.count} × ${1 + (+n.props.replicas || 0)}`, '']);
      const fr = all && all.data ? all.data.fresh : null;
      if (fr != null && isFinite(fr)) out.push(['Свежесть отчётов', fr < 120 ? Math.round(fr) + ' с' : fr < 7200 ? Math.round(fr / 60) + ' мин' : Math.round(fr / 3600) + ' ч', fr > 60 ? 'warn' : 'ok']);
      if (r.info && r.info.parts > 1) out.push(['Куски', 'слишком много', 'bad']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xoSt"></g><g id="xoDy" class="xo-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xoSt'), gDy = ctx.svg.querySelector('#xoDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 9) S.fx.shift(); };
      const N = () => clamp(+P().count || 1, 1, 8);
      const REP = () => clamp(+P().replicas || 0, 0, 2);
      const partOn = () => P().partition !== false;
      const rowMode = () => P().insert === 'row';
      const mvOn = () => !!P().mv && S.scn !== 'join';
      const schema = () => P().schema || 'star';
      const skew = () => S.scn === 'skew';
      const share = i => { const n = S.sh ? S.sh.length : N(); if (!skew()) return 1 / n; let s = 0; CSH.forEach((v, c) => { if (c % n === i) s += v; }); return s; };
      const shuffles = () => S.scn === 'join' && S.sh.length > 1 && schema() !== 'obt';
      const util = () => ctx.res.util || 0;
      const curKey = () => partOn() ? '202608' : 'all';
      let pid = 1;
      const mk = (a, b, lvl, rows, d0, d1) => ({ id: pid++, a, b, lvl, rows, d0: d0 || TODAY, d1: d1 || TODAY, t0: -1e9 });
      const pname = (k, p) => `${k}_${p.a}_${p.b}_${p.lvl}${p.mv ? '_' + p.mv : ''}`;

      /* ---------- соседи ---------- */
      function nbrs() {
        const ins = ctx.ins().map(x => x.n);
        const app = ins.find(k => k.type === 'app' || k.type === 'faas' || k.type === 'worker');
        S.src = S.scn === 'rows' ? (app || ins.find(k => k.type === 'etl') || null) : (ins.find(k => k.type === 'etl') || ins.find(k => k.type === 'queue') || app || null);
        S.dash = ins.find(k => k.type === 'app' || k.type === 'faas') || null;
      }

      /* ---------- куски: стартовая раскладка ---------- */
      function initParts() {
        const n = N();
        S.sh = Array.from({ length: n }, (_, i) => ({ parts: {}, blk: {}, mg: null, mgAt: 0, prog: 0 }));
        S.sh.forEach((sh, i) => {
          const k = share(i);
          if (partOn()) MON.forEach((m, mi) => {
            const R0 = m.rows * k;
            if (m.cur) { sh.parts[m.id] = [mk(1, 288, 5, R0 * 0.72), mk(289, 330, 3, R0 * 0.2), mk(331, 336, 1, R0 * 0.06), mk(337, 337, 0, R0 * 0.01)]; sh.blk[m.id] = 337; }
            else { const b = 1180 + mi * 37 + i * 11; sh.parts[m.id] = [mk(1, b, 6, R0 * 0.88), mk(b + 1, b + 24, 3, R0 * 0.12)]; sh.blk[m.id] = b + 24; }
          });
          else {
            sh.parts.all = [mk(1, 6210, 8, 242e6 * k, 91, 165), mk(6211, 8890, 7, 124e6 * k, 165, 202), mk(8891, 9706, 5, 53e6 * k, 202, 218), mk(9707, 9780, 3, 9.6e6 * k, 218, 221), mk(9781, 9786, 1, 2.4e6 * k, 221, 222), mk(9787, 9787, 0, 5e4 * k, 222, 222)];
            sh.blk.all = 9787;
          }
        });
      }
      function reset() {
        Object.assign(S, { t: 0, ins: [], q: null, qAt: 700, qn: 0, fx: [], insAt: 250, buf: 0, bufAt: 0, drop: null, dropAt: 2600, hist: [], rejT: [], merges: [], shuf: [], shufAt: 0, acc: null, res: null, lastMs: null, lastB: null, lastNet: 0, flags: {}, cfgT: 0 });
        nbrs(); initParts();
        S.cfg = cfgSig();
      }
      const cfgSig = () => [N(), partOn(), S.scn].join('|');

      /* ---------- вставки ---------- */
      const shardX = i => { const n = S.sh.length, gap = n > 4 ? 8 : 12, w = (SXW - (n - 1) * gap) / n; return { x: SX0 + i * (w + gap), w, c: SX0 + i * (w + gap) + w / 2 }; };
      const landY = () => partOn() ? rowY(0) + RH / 2 : RY0 + 14;
      function pickShard() { const n = S.sh.length; let x = Math.random(); for (let i = 0; i < n; i++) { x -= share(i); if (x <= 0) return i; } return n - 1; }
      function spawnBatch(rows) { S.ins.push({ k: 'batch', rows, ph: 'go', p0: S.t, dur: 420, pts: [[SRC.x + SRC.w, YB], HUB] }); }
      function spawnRow() { const i = pickShard(), g = shardX(i); S.ins.push({ k: 'row', i, ph: 'go', p0: S.t, dur: 640, pts: [[SRC.x + SRC.w, YB], HUB, [SZ.x, YB], [g.x + g.w - 18, YB], [g.x + g.w - 18, landY()]] }); }
      function splitBatch(b) {
        S.sh.forEach((sh, i) => { const g = shardX(i); S.ins.push({ k: 'sub', i, rows: b.rows * share(i), ph: 'go', p0: S.t, dur: 520, pts: [HUB, [SZ.x, YB], [g.c, YB], [g.c, landY()]] }); });
        b.gone = true;
      }
      function land(r) {
        const sh = S.sh[r.i]; if (!sh) { r.gone = true; return; }
        const k = curKey(), ps = sh.parts[k] || (sh.parts[k] = []), n = ps.length;
        if (r.k === 'row' && n >= LIMIT) {
          r.gone = true; S.rejT.push(S.t); S.flags.rej = 1;
          const g = shardX(r.i); pop(g.c, rowY(0) - 6, 'Too many parts', 'bad');
          note('rej', `<b>Вставка отклонена: Too many parts.</b> В партиции ${k} на шарде ${r.i + 1} уже ${n} кусков, слияния не успевают. В жизни порог — 300 кусков.`, 'bad', 4000);
          return;
        }
        if (r.k === 'row' && n >= DELAY && !r.waited) { r.waited = 1; r.ph = 'wait'; r.p0 = S.t; r.dur = 650; return; }
        sh.blk[k] = (sh.blk[k] || 0) + 1;
        const p = mk(sh.blk[k], sh.blk[k], 0, r.rows || 1); p.t0 = S.t; ps.push(p);
        r.gone = true;
      }

      /* ---------- фоновые слияния ---------- */
      function mergeStep(sh) {
        if (sh.mg) { if (S.t >= sh.mg.t1) endMerge(sh); return; }
        if (S.t < sh.mgAt) return;
        let best = null;
        for (const k in sh.parts) {
          if (S.drop && S.drop.key === k) continue;
          const ps = sh.parts[k]; let j = ps.length; while (j > 0 && ps[j - 1].lvl < 5 && !ps[j - 1].mu) j--;
          const run = ps.length - j;
          if (run >= 3 && (!best || run > best.run)) best = { k, j, run };
        }
        if (!best) return;
        const take = Math.min(best.run, rowMode() ? 5 : 6);
        sh.mg = { k: best.k, ids: sh.parts[best.k].slice(best.j, best.j + take).map(p => p.id), t0: S.t, t1: S.t + (rowMode() ? 1250 : 800) };
      }
      function endMerge(sh) {
        const ps = sh.parts[sh.mg.k] || [], sel = ps.filter(p => sh.mg.ids.includes(p.id));
        if (sel.length >= 2) {
          const j = ps.indexOf(sel[0]);
          const np = mk(Math.min(...sel.map(p => p.a)), Math.max(...sel.map(p => p.b)), Math.max(...sel.map(p => p.lvl)) + 1, sel.reduce((s, p) => s + p.rows, 0), Math.min(...sel.map(p => p.d0)), Math.max(...sel.map(p => p.d1)));
          np.t0 = S.t; np.fm = 1;
          ps.splice(j, sel.length, np);
          S.merges.push(S.t);
        }
        sh.mg = null; sh.mgAt = S.t + 150;
      }

      /* ---------- отчёт дашборда ---------- */
      function plan() {
        const n = S.sh.length, join = S.scn === 'join', sc = schema();
        const rf = partOn() ? 1 : 1.3, colB = join ? (sc === 'obt' ? NEED_ZIP - 0.1 + 0.9 : NEED_ZIP - 0.1 + 3.1) : NEED_ZIP;
        const bytes = JUL * colB * rf, per = S.sh.map((_, i) => bytes * share(i));
        const net = shuffles() ? JUL * (1 - 1 / n) * 16 * (sc === 'snowflake' ? 1.3 : 1) : 0;
        const dim = join && sc !== 'obt' ? 40e6 * 12 * (sc === 'snowflake' ? 1.4 : 1) : 0;
        const slow = Math.min(30, qf(Math.min(util(), 1.3)));
        const ms = (4 + Math.max(...per) / 1.5e9 * 1000 + dim / n / 1.5e9 * 1000 + net / n / 1.25e9 * 1000 + 3) * slow;
        return { bytes: bytes + dim, per, net, ms };
      }
      function newQuery() {
        const n = S.sh.length, q = { id: ++S.qn, ph: 'go', p0: S.t, dur: 300, mv: mvOn(), rep: REP() ? S.qn % (REP() + 1) : 0, pl: plan() };
        if (!q.mv) {
          const jf = S.scn === 'join' ? (n === 1 ? 1.3 : schema() === 'obt' ? 1.1 : schema() === 'snowflake' ? 2.2 : 1.8) : 1;
          const slow = Math.min(2.2, qf(Math.min(util(), 1.3)));
          q.d = S.sh.map((_, i) => (600 + 2600 * share(i) * (partOn() ? 1 : 1.3) * jf) * slow);
          q.st = S.sh.map(() => 0);   // 0 — ждёт, 1 — читает, 2 — итог летит, 3 — итог у координатора
          q.part = S.sh.map((_, i) => partial(i));
        }
        S.q = q; S.acc = null;
      }
      function partial(i, even) {   // частичный итог шарда: по странам или по городам
        const n = S.sh.length, src = S.scn === 'join' && !even ? CITY.map(c => c[1]) : REV;
        return src.map((v, c) => {
          if (skew() && !even) return c % n === i ? v : 0;
          const w = j => 1 + 0.05 * Math.sin(1.7 * j + c * 1.3);
          let tot = 0; for (let j = 0; j < n; j++) tot += w(j);
          return v * w(i) / tot;
        });
      }
      const coTop = () => [CO.x + CO.w / 2, CO.y];
      const fanPts = i => { const g = shardX(i), c = coTop(); return [c, [c[0], QB], [g.c, QB], [g.c, SHB - 4]]; };
      function qStep() {
        const q = S.q; if (!q) { if (S.t >= S.qAt) newQuery(); return; }
        const at = q.p0 + q.dur;
        if (q.ph === 'go' && S.t >= at) {
          if (q.mv) { q.ph = 'mv'; q.p0 = S.t; q.dur = 260; }
          else { q.ph = 'fan'; q.p0 = S.t; q.dur = 460; }
        } else if (q.ph === 'mv' && S.t >= at) { q.ph = 'back'; q.p0 = S.t; q.dur = 360; }
        else if (q.ph === 'fan' && S.t >= at) { q.ph = 'scan'; q.p0 = S.t; q.st = q.st.map(() => 1); S.acc = (S.scn === 'join' ? CITY : CC).map(() => 0); }
        else if (q.ph === 'scan') {
          q.st.forEach((st, i) => {
            if (st === 1 && S.t >= q.p0 + q.d[i]) { q.st[i] = 2; q.ret = q.ret || []; q.ret[i] = S.t; }
            else if (st === 2 && S.t >= q.ret[i] + 460) { q.st[i] = 3; q.part[i].forEach((v, c) => { S.acc[c] += v; }); }
          });
          if (q.st.every(s => s === 3)) { q.ph = 'merge'; q.p0 = S.t; q.dur = 320; }
        } else if (q.ph === 'merge' && S.t >= at) { q.ph = 'back'; q.p0 = S.t; q.dur = 320; }
        else if (q.ph === 'back' && S.t >= at) finishQuery(q);
      }
      function finishQuery(q) {
        const ms = q.mv ? 3 * Math.min(30, qf(Math.min(util(), 1.3))) : q.pl.ms;
        S.lastMs = ms; S.lastB = q.mv ? 186 * 24 : q.pl.bytes; S.lastNet = q.mv ? 0 : q.pl.net; S.lastMv = q.mv;
        S.res = q.mv ? REV.slice() : (S.acc || []).slice(); S.resJoin = !q.mv && S.scn === 'join'; S.resT = S.t;
        S.hist.push({ t: S.t, ms }); S.q = null; S.qAt = S.t + QGAP;
        if (q.mv) { if (S.seenNoMv) done('mv'); note('mvq', `<b>Отчёт из материализованного представления:</b> 186 готовых строк вместо 104 млн, ответ ≈ ${tms(ms)}. Шарды в отчёте не участвуют.`, 'ok', 8000); }
        else if (S.scn === 'join') {
          if (schema() === 'obt') { done('join'); note('jobt', `<b>Широкая таблица:</b> город лежит прямо в строке заказа, JOIN не нужен — по сети ничего не поехало. Отчёт ≈ ${tms(ms)}.`, 'ok', 8000); }
          else if (S.sh.length > 1) note('jsh', `<b>JOIN с перемешиванием:</b> по сети переехало ≈ ${byt(q.pl.net)} — строки заказов везли к шардам, где лежат их покупатели. Отчёт ≈ ${tms(ms)}.`, 'warn', 8000);
        } else if (skew()) {
          const sl = q.d.indexOf(Math.max(...q.d));
          if (S.sh.length >= 4) done('skew');
          note('skw', `<b>Перекос:</b> шард ${sl + 1} держит ${Math.round(share(sl) * 100)} % строк (в нём Россия) и считает дольше всех. Остальные закончили и ждали его.`, 'warn', 9000);
        }
      }

      /* ---------- чистка старых данных ---------- */
      function dropStep() {
        if (S.scn !== 'drop') return;
        const d = S.drop;
        if (!d) {
          if (S.t < S.dropAt) return;
          if (partOn()) {
            S.drop = { k: 'part', key: '202604', t0: S.t, ph: 'go' };
            note('dp', '<b>ALTER TABLE orders DROP PARTITION 202604</b> — папки апреля удаляются на всех шардах целиком. Ничего не переписывается: ≈ 0,02 с.', 'ok', 0);
          } else {
            const tgt = S.sh.map(sh => (sh.parts.all || []).find(p => p.d0 < MAY1));
            tgt.forEach(p => { if (p) p.mu = 1; });
            const gb = tgt.reduce((s, p) => s + (p ? p.rows * ZIP_ROW : 0), 0);
            S.drop = { k: 'mut', key: 'all', t0: S.t, ph: 'go', gb, dur: 7000 };
            note('dm', `<b>ALTER TABLE orders DELETE WHERE created_at &lt; '2026-05-01'</b> — партиций нет, апрель перемешан с маем и июнем. Запускается мутация: переписать кусок ≈ ${byt(gb)} целиком.`, 'warn', 0);
          }
          return;
        }
        const u = S.t - d.t0;
        if (d.k === 'part') {
          if (d.ph === 'go' && u > 700) { d.ph = 'gone'; S.sh.forEach(sh => { sh.parts['202604'] = []; }); }
          if (d.ph === 'gone' && u > 4800) { d.ph = 'back'; initPartsKeep(); }
          if (d.ph === 'back' && u > 5600) { S.drop = null; S.dropAt = S.t + 3200; }
        } else {
          if (d.ph === 'go' && u > d.dur) {
            d.ph = 'done';
            S.sh.forEach((sh, i) => { const p = (sh.parts.all || []).find(x => x.mu); if (p) { p.mu = 0; p.mv = 9790 + i; p.rows -= 96e6 * share(i); p.d0 = MAY1; p.t0 = S.t; p.fm = 1; } });
            done('drop');
            note('dmd', `<b>Мутация закончилась.</b> Переписано ≈ ${byt(d.gb)}, на настоящем диске это минуты. С партициями было бы одно удаление папки.`, 'warn', 0);
          }
          if (d.ph === 'done' && u > d.dur + 4200) { initPartsKeep(); S.drop = null; S.dropAt = S.t + 3000; }
        }
      }
      function initPartsKeep() { initParts(); }

      /* ---------- перемешивание: строки едут между шардами ---------- */
      function shufStep() {
        const q = S.q;
        if (!q || q.ph !== 'scan' || !shuffles()) return;
        const n = S.sh.length;
        while (S.t >= S.shufAt) {
          S.shufAt = Math.max(S.shufAt, S.t - 50) + 55;
          const live = q.st.map((s, i) => s === 1 ? i : -1).filter(i => i >= 0); if (!live.length) break;
          const a = live[Math.floor(Math.random() * live.length)]; let b = Math.floor(Math.random() * (n - 1)); if (b >= a) b++;
          if (S.shuf.length < 44) S.shuf.push({ a, b, t0: S.t, dur: 850 });
        }
      }

      /* ---------- отрисовка общей картинки ---------- */
      function badges() {
        const mx = S.sh.reduce((m, sh) => Math.max(m, (sh.parts[curKey()] || []).length), 0);
        const bs = [['cols', 'СТРОКИ И КОЛОНКИ', '3 колонки из 22', ''], ['comp', 'СЖАТИЕ И MIN/MAX', '220 Б → 38 Б на строку', ''],
          ['scd', 'ИСТОРИЯ (SCD2)', 'valid_from / valid_to', ''], ['ins', 'ВСТАВКА И КУСКИ', `${rowMode() ? 'по строке' : 'пачками'} · кусков ${mx}`, mx >= LIMIT ? 'bad' : mx >= DELAY ? 'warn' : '']];
        const w = (SZ.w - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xo-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xo-go');
        bs.forEach(([k, t, v, c], i) => {
          const x = SZ.x + i * (w + 8);
          s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xo-badge', 9)}${T(x + 10, 18, t, 'xr-m')}${T(x + 10, 32, ES(v), 'xr-s' + (c ? ' xo-' + c : ''))}</g>`;
        });
        return s;
      }
      function starMini() {
        const sc = schema(), b = STAR, cx = b.x + b.w / 2, cy = b.y + 104;
        let s = `<g class="xr-part" data-xpart="star">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}`;
        s += T(b.x + 12, b.y + 20, 'МОДЕЛЬ ДАННЫХ', 'xr-m') + T(b.x + 12, b.y + 37, sc === 'obt' ? 'одна широкая таблица' : sc === 'snowflake' ? 'снежинка' : 'звезда', 'xr-t');
        const box = (x, y, w, t, c) => R(x, y, w, 20, 'xo-mbox ' + (c || ''), 5) + T(x + w / 2, y + 14, t, 'xo-mt', 'middle');
        if (sc === 'obt') {
          s += R(b.x + 14, cy - 26, b.w - 28, 50, 'xo-mbox f', 6) + T(cx, cy - 8, 'orders_wide', 'xo-mt', 'middle') + T(cx, cy + 10, 'город, товар, дата — внутри', 'xo-ms', 'middle');
          for (let k = 0; k < 16; k++) s += Ln(b.x + 24 + k * 10.8, cy + 16, b.x + 24 + k * 10.8, cy + 21, 'xo-tick');
        } else {
          const D = [[b.x + 8, cy - 42, 'date'], [b.x + b.w - 64, cy - 42, 'user'], [cx - 28, cy + 30, 'product']];
          D.forEach(([x, y]) => { s += Ln(cx, cy, x + 28, y + 10, 'xo-ml'); });
          if (sc === 'snowflake') { s += Ln(b.x + b.w - 36, cy - 22, b.x + b.w - 36, cy - 10, 'xo-ml') + Ln(cx - 28, cy + 40, b.x + 64, cy + 40, 'xo-ml'); }
          s += R(cx - 30, cy - 11, 60, 22, 'xo-mbox f', 5) + T(cx, cy + 4, 'orders', 'xo-mt', 'middle');
          D.forEach(([x, y, t]) => { s += box(x, y, 56, t); });
          if (sc === 'snowflake') s += box(b.x + b.w - 64, cy - 10, 56, 'city', 'sub') + box(b.x + 8, cy + 30, 56, 'category', 'sub');
        }
        const jn = sc === 'obt' ? 0 : sc === 'snowflake' ? 2 : 1;
        s += T(b.x + 12, b.y + b.h - 10, S.scn === 'join' ? `по городам: JOIN × ${jn}` : 'по странам: JOIN не нужен', 'xr-s' + (S.scn === 'join' && jn ? ' xo-warn' : ''));
        return s + '</g>';
      }
      function srcBox() {
        const src = S.src, go = src && ctx.canGo(src.id), l = ctx.res.load || {}, rate = (l.events || 0) + (l.write || 0);
        let s = `<g${go ? ` class="xr-go" data-xgo="${src.id}"` : ''}>${R(SRC.x, SRC.y, SRC.w, SRC.h, 'xr-box', 12)}`;
        s += T(SRC.x + 12, SRC.y + 22, ES(cut(src ? ctx.nm(src.id) : 'Источник', 18)), 'xr-t');
        s += T(SRC.x + 12, SRC.y + 42, 'вставляет в orders:', 'xr-s');
        const viaBuf = S.scn === 'rows' && !rowMode();
        s += T(SRC.x + 12, SRC.y + 60, rowMode() ? 'по 1 строке' : viaBuf ? 'через буфер' : 'пачки по 50 000', 'xr-m ' + (rowMode() ? 'warn' : 'acc'));
        s += T(SRC.x + 12, SRC.y + 78, rate ? `≈ ${SD.fmt.num(rate)} строк/с` : 'поток на площадке 0', 'xr-s');
        if (viaBuf) {
          const f = clamp(S.buf / 12, 0, 1);
          s += T(SRC.x + 12, SRC.y + 98, 'буфер копит строки', 'xr-s') + R(SRC.x + 12, SRC.y + 106, SRC.w - 24, 8, 'xr-bar', 4) + R(SRC.x + 12, SRC.y + 106, (SRC.w - 24) * f, 8, 'xr-bar-f acc', 4);
          s += T(SRC.x + 12, SRC.y + 128, `${S.buf} из 12 → пачка`, 'xr-m acc');
        } else s += T(SRC.x + 12, SRC.y + 100, rowMode() ? 'строка = кусок!' : 'пачка = один кусок', 'xr-s' + (rowMode() ? ' xo-warn' : ''));
        if (go) s += T(SRC.x + 12, SRC.y + SRC.h - 10, 'клик — внутрь ›', 'xr-s xo-go');
        return s + '</g>';
      }
      function zoneSvg() {
        const u = util(), uc = u > 1 ? 'bad' : u > 0.75 ? 'warn' : '';
        let s = R(SZ.x, SZ.y, SZ.w, SZ.h, 'xr-zone', 14);
        const shNow = shuffles() && S.q && S.q.ph === 'scan';
        s += T(SZ.x + 12, SZ.y + 17, 'ТАБЛИЦА orders', 'xr-m acc') + T(SZ.x + 116, SZ.y + 17, shNow ? 'перемешивание: строки заказов едут к шардам своих покупателей' : `ключ шардов: ${skew() ? 'country' : 'order_id % ' + S.sh.length}${partOn() ? ' · партиции по месяцам' : ' · без партиций'}`, 'xr-s' + (shNow ? ' xo-warn' : ''));
        s += T(SZ.x + SZ.w - 150, SZ.y + 17, 'загрузка', 'xr-s', 'end') + R(SZ.x + SZ.w - 142, SZ.y + 10, 80, 8, 'xr-bar', 4) + R(SZ.x + SZ.w - 142, SZ.y + 10, 80 * clamp(u, 0, 1), 8, 'xr-bar-f ' + uc, 4);
        s += T(SZ.x + SZ.w - 12, SZ.y + 17, Math.round(Math.min(u, 9) * 100) + ' %', 'xr-m ' + uc, 'end');
        // шина вставки и путь от источника
        s += Ln(SRC.x + SRC.w, YB, HUB[0] - 9, YB, 'xo-bus') + Ln(HUB[0] + 9, YB, SX0 + SXW, YB, 'xo-bus');
        s += `<polygon class="xo-hub" points="${HUB[0]},${YB - 9} ${HUB[0] + 9},${YB} ${HUB[0]},${YB + 9} ${HUB[0] - 9},${YB}"/>` + T(HUB[0], YB + 24, 'шард', 'xo-ms', 'middle') + T(HUB[0], YB + 36, 'по ключу', 'xo-ms', 'middle');
        // шина запросов
        const c = coTop(), last = shardX(S.sh.length - 1).c;
        s += `<polyline class="xo-qbus" points="${c[0]},${c[1]} ${c[0]},${QB} ${f1(last)},${QB}"/>`;
        S.sh.forEach((_, i) => { const g = shardX(i); s += Ln(g.c, QB, g.c, SHB, 'xo-qbus'); });
        return s;
      }
      function monthsSvg() {
        const q = S.q, scan = q && !q.mv && (q.ph === 'scan' || q.ph === 'fan');
        let s = `<g class="xr-part" data-xpart="prt">${R(MCX - 2, RY0 - 4, 66, RBOT - RY0 + 8, 'xo-pf', 8)}`;
        if (partOn()) MON.forEach((m, mi) => {
          const y = rowY(mi), dr = S.drop && S.drop.k === 'part' && m.id === S.drop.key && S.drop.ph !== 'back';
          let sub = m.cur ? 'идёт' : m.jul ? 'июль' : '', sc = '';
          if (scan) { sub = m.jul ? 'читаем' : 'пропуск'; sc = m.jul ? 'xo-acc' : 'xo-dim'; }
          if (dr) { sub = 'DROP'; sc = 'xo-bad'; }
          s += T(MCX + 2, y + 18, m.name, 'xr-m' + (scan && m.jul ? ' acc' : '')) + T(MCX + 2, y + 33, sub, 'xo-ms ' + sc);
        });
        else {
          s += T(MCX + 2, RY0 + 18, 'all', 'xr-m') + T(MCX + 2, RY0 + 33, 'одна', 'xo-ms') + T(MCX + 2, RY0 + 46, 'партиция', 'xo-ms');
          s += T(MCX + 2, RY0 + 72, 'месяцы', 'xo-ms') + T(MCX + 2, RY0 + 85, 'вперемешку', 'xo-ms');
        }
        return s + '</g>';
      }
      function partW(p, ref, avail) { return clamp(avail * 0.8 * Math.sqrt(p.rows / Math.max(1, ref)), 5, avail * 0.86); }
      function rowParts(sh, i, key, x, y, w, h, st) {
        const ps = sh.parts[key] || [], g = shardX(i), ref = (key === 'all' ? TOTAL * 0.56 : JUL) * share(i), avail = w - 8;
        const big = ps.filter(p => p.rows >= ref * 0.004), tiny = ps.filter(p => p.rows < ref * 0.004);
        let ws = big.map(p => partW(p, ref, avail)), tot = ws.reduce((a, b) => a + b, 0) + Math.max(0, big.length - 1) * 3;
        const room = avail - (tiny.length ? Math.min(tiny.length, 3) * 9 + 4 : 0);
        if (tot > room) { const k = room / tot; ws = ws.map(v => Math.max(4, v * k)); }
        let s = '', cx = x + 4;
        big.forEach((p, j) => {
          const cls = partCls(sh, p, st), wd = ws[j];
          s += R(cx, y + 4, wd, h - 8, 'xo-pt ' + cls, 3);
          if (wd >= 104 && h >= 24) s += T(cx + 6, y + h / 2 + 4, pname(key, p), 'xo-pn');
          else if (wd >= 30 && h >= 24 && g.w >= 90) s += T(cx + wd / 2, y + h / 2 + 4, 'L' + p.lvl, 'xo-pn', 'middle');
          cx += wd + 3;
        });
        const per = Math.max(1, Math.floor((x + w - cx - 2) / 9)), rows2 = Math.max(1, Math.floor((h - 6) / 9));
        tiny.slice(0, per * rows2).forEach((p, j) => { s += R(cx + 2 + (j % per) * 9, y + 4 + Math.floor(j / per) * 9, 7, 7, 'xo-pt ' + partCls(sh, p, st), 1.5); });
        if (tiny.length > per * rows2) s += T(x + w - 4, y + h - 2, '+' + (tiny.length - per * rows2), 'xo-pn xo-bad', 'end');
        return s;
      }
      function partCls(sh, p, st) {
        let c = 'l' + Math.min(3, p.lvl >= 5 ? 3 : p.lvl >= 3 ? 2 : p.lvl >= 1 ? 1 : 0);
        if (sh.mg && sh.mg.ids.includes(p.id)) c += ' mg';
        if (p.mu) c += ' mu';
        if (st === 'rd') c += ' rd';
        if (S.t - p.t0 < 450) c += ' fl';
        return c;
      }
      function shardSvg(i) {
        const sh = S.sh[i], g = shardX(i), q = S.q, n = S.sh.length, rep = REP();
        let s = '';
        for (let k = rep; k >= 1; k--) s += R(g.x + k * 4, SHY + k * 4, g.w, SHB - SHY, 'xo-copy', 10);
        const st = q && !q.mv && q.st ? q.st[i] : 0, hot = skew() && share(i) > 0.4;
        s += `<g class="xr-part" data-xpart="mpp">${R(g.x, SHY, g.w, SHB - SHY, 'xo-sh' + (st === 1 ? ' on' : '') + (hot ? ' hot' : ''), 10)}`;
        const rows = TOTAL * share(i) - (S.drop && S.drop.k === 'part' && S.drop.ph === 'gone' ? 96e6 * share(i) : 0);
        s += T(g.x + 8, SHY + 16, g.w >= 70 ? `шард ${i + 1}` : `${i + 1}`, 'xr-t xo-nh');
        if (g.w >= 120) s += T(g.x + g.w - 8, SHY + 16, `${mln(rows)} строк`, 'xr-m' + (hot ? ' warn' : ''), 'end');
        else if (g.w >= 78) s += T(g.x + g.w - 6, SHY + 16, mln(rows).replace(' млн', 'м'), 'xr-m', 'end');
        if (partOn()) MON.forEach((m, mi) => {
          const y = rowY(mi), rd = st === 1 && m.jul, sk = q && !q.mv && (q.ph === 'scan') && !m.jul;
          const dr = S.drop && S.drop.k === 'part' && S.drop.key === m.id && S.drop.ph === 'go';
          s += R(g.x + 5, y, g.w - 10, RH, 'xo-row' + (rd ? ' rd' : '') + (sk ? ' sk' : '') + (dr ? ' dl' : ''), 6);
          s += rowParts(sh, i, m.id, g.x + 5, y, g.w - 10, RH, rd ? 'rd' : '');
          if (rd && q.ph === 'scan') { const k = clamp((S.t - q.p0) / q.d[i], 0, 1); s += R(g.x + 5, y, (g.w - 10) * k, RH, 'xo-sweep', 6); }
        });
        else {
          const ps = sh.parts.all || [], bigs = ps.filter(p => p.rows >= TOTAL * 0.56 * share(i) * 0.004), tiny = ps.filter(p => !bigs.includes(p));
          const ref = TOTAL * 0.56 * share(i), avail = g.w - 18;
          bigs.slice(0, 7).forEach((p, j) => {
            const y = RY0 + 4 + j * 30, ov = p.d1 >= JUL0 && p.d0 <= JUL1, rd = st === 1 && ov, sk = q && !q.mv && q.ph === 'scan' && !ov;
            const wd = clamp(avail * Math.sqrt(p.rows / ref) * 0.95, 8, avail);
            s += R(g.x + 9, y, wd, 24, 'xo-pt ' + partCls(sh, p, rd ? 'rd' : '') + (sk ? ' sk' : ''), 3);
            const lab = `${pname('all', p)} · ${md(p.d0)}…${md(p.d1)}`;
            if (g.w >= 200) s += T(g.x + 15, y + 16, ES(lab), 'xo-pn');
            else if (g.w >= 120) s += T(g.x + 15, y + 16, `${md(p.d0)}…${md(p.d1)}`, 'xo-pn');
            if (rd && q.ph === 'scan') { const k = clamp((S.t - q.p0) / q.d[i], 0, 1); s += R(g.x + 9, y, wd * k, 24, 'xo-sweep', 3); }
          });
          const per = Math.max(1, Math.floor((g.w - 18) / 9));
          tiny.slice(0, per * 3).forEach((p, j) => { s += R(g.x + 9 + (j % per) * 9, RY0 + 4 + Math.min(7, bigs.length) * 30 + Math.floor(j / per) * 9, 7, 7, 'xo-pt ' + partCls(sh, p, ''), 1.5); });
        }
        // подвал: как идёт отчёт
        s += footer(i, g, st);
        return s + '</g>';
      }
      function footer(i, g, st) {
        const q = S.q, n = S.sh.length, sh = S.sh[i];
        let s = R(g.x + 8, FB, g.w - 16, 7, 'xr-bar', 3);
        let t1 = '', t2 = '', c1 = '';
        const per = q && q.pl ? q.pl.per[i] : 0;
        if (!q || q.mv) {
          t1 = q && q.mv ? 'отдыхает' : 'ждёт отчёт';
          t2 = q && q.mv ? 'отчёт из MV' : sh.mg ? 'идёт слияние' : '';
          if (S.lastMs != null && !q && !S.lastMv) s += R(g.x + 8, FB, g.w - 16, 7, 'xr-bar-f', 3);
        } else if (st === 0) { t1 = 'получает запрос'; }
        else if (st === 1) {
          const k = clamp((S.t - q.p0) / q.d[i], 0, 1);
          s += R(g.x + 8, FB, (g.w - 16) * k, 7, 'xr-bar-f acc', 3);
          t1 = g.w >= 150 ? `читает ${partOn() ? '202607' : 'куски июля'} · ${byt(per)}` : byt(per);
          t2 = shuffles() ? 'шлёт строки соседям' : g.w >= 150 ? '3 колонки из 22' : '';
          c1 = 'xo-acc';
        } else {
          s += R(g.x + 8, FB, g.w - 16, 7, 'xr-bar-f', 3);
          const slow = q.d.indexOf(Math.max(...q.d));
          t1 = g.w >= 110 ? `готово за ${tms(q.pl.ms * q.d[i] / Math.max(...q.d))}` : 'готово';
          t2 = q.st.some(x => x === 1) ? (g.w >= 110 ? `ждём шард ${slow + 1}` : 'ждёт') : 'итог отправлен';
          c1 = 'xo-ok';
        }
        if (REP() && q && !q.mv && g.w >= 150) t2 = t2 || `отвечает ${q.rep ? 'реплика ' + q.rep : 'главная копия'}`;
        s += T(g.x + 8, FT1, t1, 'xo-ms ' + c1);
        if (t2) s += T(g.x + 8, FT2, t2, 'xo-ms');
        return s;
      }
      function bottomSvg() {
        const q = S.q, n = S.sh.length;
        let s = '';
        // дашборд
        const ds = S.dash, dg = ds && ctx.canGo(ds.id);
        s += `<g${dg ? ` class="xr-go" data-xgo="${ds.id}"` : ''}>${R(DASH.x, DASH.y, DASH.w, DASH.h, 'xr-box', 12)}`;
        s += T(DASH.x + 12, DASH.y + 22, ES(cut(ds ? ctx.nm(ds.id) : 'Дашборд', 18)), 'xr-t') + T(DASH.x + 12, DASH.y + 42, 'дашборд продаж', 'xr-s');
        s += T(DASH.x + 12, DASH.y + 60, S.scn === 'join' ? 'выручка по городам' : 'выручка по странам', 'xr-s') + T(DASH.x + 12, DASH.y + 76, 'за июль 2026', 'xr-s');
        s += T(DASH.x + 12, DASH.y + 100, 'последний ответ:', 'xr-s') + T(DASH.x + 12, DASH.y + 118, S.lastMs == null ? '—' : `${tms(S.lastMs)}${S.lastMv ? ' · из MV' : ''}`, 'xr-m ' + (S.lastMs == null ? '' : S.lastMs > 400 ? 'warn' : 'ok'));
        if (dg) s += T(DASH.x + 12, DASH.y + DASH.h - 10, 'клик — внутрь ›', 'xr-s xo-go');
        s += '</g>';
        // координатор
        const ph = q ? q.ph : '';
        const cot = !q ? 'ждёт запрос' : q.mv ? 'отправил в MV' : ph === 'fan' ? `рассылает на ${n} ${pl(n, 'шард', 'шарда', 'шардов')}` : ph === 'scan' ? `итогов ${q.st.filter(x => x === 3).length} из ${n}` : ph === 'merge' ? 'складывает итоги' : ph === 'back' ? 'отвечает' : 'принял запрос';
        s += `<g class="xr-part" data-xpart="mpp">${R(CO.x, CO.y, CO.w, CO.h, 'xr-box' + (q && !q.mv ? ' sel' : ''), 10)}`;
        s += T(CO.x + 10, CO.y + 18, 'КООРДИНАТОР', 'xr-m') + T(CO.x + 10, CO.y + 36, 'Distributed-таблица', 'xr-s') + T(CO.x + 10, CO.y + 56, cot, 'xr-s' + (ph === 'merge' ? ' xo-ok' : ''));
        s += '</g>';
        // MV
        const mvf = S.t - (S.mvFl || -1e9) < 500;
        s += `<g class="xr-part" data-xpart="mv">${R(MVB.x, MVB.y, MVB.w, MVB.h, 'xr-box' + (mvOn() ? (q && q.mv ? ' sel' : '') : ' xo-off'), 10)}`;
        if (P().mv) s += T(MVB.x + 10, MVB.y + 18, 'mv_revenue_daily', 'xr-m acc') + T(MVB.x + 10, MVB.y + 36, '186 строк: суммы', 'xr-s') + T(MVB.x + 10, MVB.y + 52, 'по дням и странам', 'xr-s') + T(MVB.x + 10, MVB.y + 67, S.scn === 'join' ? 'для городов MV нет' : mvf ? '+ пачка учтена' : 'обновляется вставкой', 'xo-ms' + (mvf ? ' xo-ok' : S.scn === 'join' ? ' xo-warn' : ''));
        else s += T(MVB.x + 10, MVB.y + 18, 'MV', 'xr-m') + T(MVB.x + 10, MVB.y + 36, 'материализованных', 'xr-s') + T(MVB.x + 10, MVB.y + 52, 'представлений нет', 'xr-s') + T(MVB.x + 10, MVB.y + 67, 'включи справа', 'xo-ms xo-go');
        s += '</g>';
        // запрос
        s += R(SQB.x, SQB.y, SQB.w, SQB.h, 'xo-code', 10) + T(SQB.x + 12, SQB.y + 18, 'ЗАПРОС ДАШБОРДА', 'xr-m');
        const L = mvOn() ? ['SELECT country, sum(revenue) AS revenue', 'FROM mv_revenue_daily', "WHERE day BETWEEN '2026-07-01'", "              AND '2026-07-31'", 'GROUP BY country']
          : S.scn === 'join' ? (schema() === 'obt' ? ['SELECT city, sum(amount) AS revenue', 'FROM orders_wide', "WHERE created_at >= '2026-07-01'", "  AND created_at <  '2026-08-01'", 'GROUP BY city']
            : ['SELECT u.city, sum(o.amount) AS revenue', 'FROM orders o', `JOIN dim_user u ON u.user_id = o.user_id${schema() === 'snowflake' ? '' : ''}`, schema() === 'snowflake' ? 'JOIN dim_city c ON c.city_key = u.city_key' : "WHERE o.created_at >= '2026-07-01' …", 'GROUP BY u.city'])
            : ['SELECT country, sum(amount) AS revenue', 'FROM orders', "WHERE created_at >= '2026-07-01'", "  AND created_at <  '2026-08-01'", 'GROUP BY country ORDER BY revenue DESC'];
        L.forEach((l, j) => { s += SQL(SQB.x + 12, SQB.y + 38 + j * 17, l); });
        const st = S.lastMs == null ? 'считаем первый отчёт…' : S.lastMv ? `прочитано 186 строк из MV · ${tms(S.lastMs)}` : `прочитано ${byt(S.lastB)}${S.lastNet ? ` · по сети ${byt(S.lastNet)}` : ''} · ${tms(S.lastMs)}`;
        s += T(SQB.x + 12, SQB.y + SQB.h - 12, st, 'xr-s' + (S.lastNet ? ' xo-warn' : ''));
        // результат
        const join = S.scn === 'join', names = join ? CITY.map(c => c[0]) : CC, fin = S.res && (!!S.resJoin === join) ? S.res : null, cur = S.acc && q && !q.mv ? S.acc : null;
        const vals = cur || fin || names.map(() => 0), mx = join ? 41.3 : 112.4;
        s += R(RES.x, RES.y, RES.w, RES.h, 'xr-box', 10) + T(RES.x + 12, RES.y + 18, join ? 'ВЫРУЧКА ЗА ИЮЛЬ ПО ГОРОДАМ' : 'ВЫРУЧКА ЗА ИЮЛЬ ПО СТРАНАМ', 'xr-m') + T(RES.x + RES.w - 12, RES.y + 18, 'млрд ₽', 'xo-ms', 'end');
        const fl = S.resT && S.t - S.resT < 600;
        names.forEach((nm, j) => {
          const y = RES.y + 34 + j * 19, v = vals[j] || 0, bw = (RES.w - (join ? 164 : 110)) * clamp(v / mx, 0, 1), bx = RES.x + (join ? 118 : 56);
          s += T(RES.x + 12, y + 10, ES(join ? cut(nm, 15) : nm), 'xr-m') + R(bx, y, RES.w - (join ? 164 : 110), 12, 'xr-bar', 3) + R(bx, y, bw, 12, 'xr-bar-f' + (cur ? ' acc' : '') + (fl ? ' xo-flb' : ''), 3);
          s += T(RES.x + RES.w - 12, y + 10, v ? nf(v, 1) : '…', 'xr-m' + (cur ? ' acc' : ''), 'end');
        });
        return s;
      }
      function dynSvg() {
        let s = '';
        const wc = SD.kindColor('write'), rc = SD.kindColor('read'), jc = 'var(--k-job)';
        S.ins.forEach(r => {
          const [x, y] = r.ph === 'wait' ? r.pts[r.pts.length - 1] : along(r.pts, (S.t - r.p0) / r.dur);
          if (r.k === 'batch') s += R(x - 7, y - 7, 14, 14, 'xo-batch', 3) + T(x, y - 11, '50 000', 'xo-pn', 'middle');
          else if (r.k === 'sub') s += R(x - 5, y - 5, 10, 10, 'xo-batch', 2);
          else if (r.k === 'row') s += Dot(x, y, 3.2, '', `fill:${wc}`) + (r.ph === 'wait' ? `<circle class="xo-ring" cx="${f1(x)}" cy="${f1(y)}" r="7"/>` : '');
          else if (r.k === 'brow') s += Dot(x, y, 3, '', `fill:${wc}`);
        });
        const q = S.q;
        if (q) {
          const k = (S.t - q.p0) / q.dur;
          if (q.ph === 'go') s += Dot(...along(q.mv ? [[DASH.x + DASH.w, MVB.y + 36], [MVB.x, MVB.y + 36]] : [[DASH.x + DASH.w, CO.y + 37], [CO.x, CO.y + 37]], k), 6, '', `fill:${rc}`);
          if (q.ph === 'mv') s += Dot(MVB.x + 18 + 120 * ease(k), MVB.y + MVB.h - 6, 5, '', `fill:${rc}`);
          if (q.ph === 'back') s += Dot(...along(q.mv ? [[MVB.x, MVB.y + 36], [DASH.x + DASH.w, MVB.y + 36]] : [[CO.x, CO.y + 37], [DASH.x + DASH.w, CO.y + 37]], k), 6, 'ok');
          if (q.ph === 'fan') S.sh.forEach((_, i) => { s += Dot(...along(fanPts(i), ease(k)), 4.5, '', `fill:${rc}`); });
          if (q.ph === 'scan') q.st.forEach((st, i) => {
            if (st !== 2) return;
            const kk = clamp((S.t - q.ret[i]) / 460, 0, 1), [x, y] = along(fanPts(i).slice().reverse(), ease(kk)), v = q.part[i][0];
            s += R(x - 6, y - 6, 12, 12, 'xo-partial', 3) + T(x + 9, y - 8, `${S.scn === 'join' ? 'Мск' : 'RU'} ${nf(v, 1)}`, 'xo-pn xo-ok');
          });
          if (q.ph === 'merge') s += `<circle class="xo-ring ok" cx="${f1(CO.x + CO.w - 16)}" cy="${f1(CO.y + 18)}" r="${f1(6 + 6 * k)}"/>`;
        }
        const arcs = {};
        S.shuf.forEach(f => {
          const a = shardX(f.a), b = shardX(f.b), k = clamp((S.t - f.t0) / f.dur, 0, 1), A = [a.c + (f.b > f.a ? 10 : -10), FB - 6], B = [b.c + (f.b > f.a ? -10 : 10), FB - 6], C = [(a.c + b.c) / 2, FB - 70 - Math.abs(f.a - f.b) * 16];
          const key = f.a + '-' + f.b;
          if (!arcs[key]) { arcs[key] = 1; s += `<path class="xo-arc" d="M${f1(A[0])},${f1(A[1])} Q${f1(C[0])},${f1(C[1])} ${f1(B[0])},${f1(B[1])}"/>`; }
          const [x, y] = bez(A, C, B, ease(k));
          s += `<circle class="xr-dot" cx="${f1(x)}" cy="${f1(y)}" r="4.2" style="fill:${jc}"/>`;
        });

        if (S.drop && S.drop.k === 'mut' && S.drop.ph === 'go') {
          const k = clamp((S.t - S.drop.t0) / S.drop.dur, 0, 1);
          s += T((SX0 + SX0 + SXW) / 2, RBOT - 4, `мутация: переписано ${byt(S.drop.gb * k)} из ${byt(S.drop.gb)}`, 'xr-pop warn', 'middle');
          S.sh.forEach((sh, i) => { const g = shardX(i); s += R(g.x + 9, RY0 + 4, (g.w - 18) * k, 3, 'xo-mubar', 1); });
        }
        if (S.drop && S.drop.k === 'part' && S.drop.ph !== 'back') {
          const k = clamp((S.t - S.drop.t0) / 700, 0, 1);
          s += T((SX0 + SX0 + SXW) / 2, rowY(4) - 4, S.drop.ph === 'go' ? 'DROP PARTITION 202604: папки апреля удаляются…' : 'апрель удалён за 0,02 с — ничего не переписано', 'xr-pop ' + (S.drop.ph === 'go' ? 'bad' : 'ok'), 'middle');
          if (S.drop.ph === 'go') S.sh.forEach((_, i) => { const g = shardX(i); s += R(g.x + 5, rowY(4), g.w - 10, RH, 'xo-ghost', 6).replace('/>', ` opacity="${f1(1 - k)}"/>`); });
        }
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() {
        let s = badges() + starMini() + srcBox() + zoneSvg();
        S.sh.forEach((_, i) => { s += shardSvg(i); });
        s += monthsSvg() + bottomSvg();
        gSt.innerHTML = s;
        gDy.innerHTML = dynSvg();
      }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xo-backb', 13)}${T(68, 27, '← вся база', 'xr-s xo-back', 'middle')}</g>` + T(140, 27, t, 'xo-vt') + T(140, 46, sub, 'xr-s');
      const cyc = (len, off) => (S.vt + (off || 0)) % len;
      function chip(x, y, w, h, c, a, b) { return R(x, y, w, h, 'xo-chip ' + (c || ''), 6) + T(x + 8, y + 13, a, 'xo-cn') + T(x + 8, y + 26, b, 'xo-ms'); }

      function vCols() {
        const C = 11000, u = cyc(C), kr = clamp((u - 800) / 8000, 0, 1), kc = clamp((u - 800) / 1100, 0, 1);
        if (u > 8900) S.pv.colsDone = 1;
        let s = head('Строки против колонок', 'один и тот же отчёт по одной и той же таблице orders: 432 млн строк × 22 колонки');
        s += SQL(30, 72, 'SELECT country, sum(amount) FROM orders') + SQL(30, 89, "WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01' GROUP BY country");
        const cw = (940 - 7 * 6) / 8;
        COLS.forEach((c, j) => {
          const x = 30 + (j % 8) * (cw + 6), y = 100 + Math.floor(j / 8) * 32, nd = NEED.includes(j);
          s += chip(x, y, cw, 28, nd ? 'need' : '', c[0], `${c[1]} · ${nf(c[2])} Б`);
        });
        // строковая
        const LX = 30, RXX = 510, PY = 214;
        s += R(20, PY - 12, 470, 262, 'xo-panel', 10) + R(500, PY - 12, 480, 262, 'xo-panel', 10);
        s += T(LX, PY + 6, 'СТРОКОВАЯ БАЗА · PostgreSQL', 'xr-m') + T(LX, PY + 22, 'страница 8 КБ ≈ 37 строк целиком — колонку отдельно не прочитать', 'xr-s');
        const pg = Math.floor(kr * 120);
        s += R(LX, PY + 30, 450, 82, 'xo-page' + (kr > 0 && kr < 1 ? ' on' : ''), 6) + T(LX + 8, PY + 44, `страница №${nf(1 + Math.floor(kr * 11.6e6))}`, 'xo-ms');
        FULL.forEach((r, i) => {
          const parts = r.map((v, j) => NEED.includes(j) ? `<tspan class="xo-need">${ES(v)}</tspan>` : ES(v || '·'));
          let line = '', len = 0;
          for (let j = 0; j < parts.length; j++) { const add = (r[j] || '·').length + 1; if (len + add > 66) { line += '…'; break; } line += parts[j] + ' '; len += add; }
          s += `<text class="xo-row-t" xml:space="preserve" x="${LX + 8}" y="${PY + 60 + i * 15}">${line}</text>`;
        });
        for (let j = 0; j < 120; j++) s += R(LX + (j % 30) * 15, PY + 122 + Math.floor(j / 30) * 13, 11, 9, 'xo-pg' + (j < pg ? ' rd' : j === pg && kr > 0 && kr < 1 ? ' on' : ''), 2);
        s += T(LX, PY + 186, 'каждая клетка — ≈ 97 тыс. страниц таблицы', 'xo-ms');
        s += T(LX, PY + 206, `прочитано ${byt(95e9 * kr)} из 95 ГБ`, 'xr-m ' + (kr >= 1 ? 'warn' : '')) + T(LX + 450, PY + 206, `≈ ${nf(63 * kr)} с из ≈ 63 с`, 'xr-m', 'end');
        s += T(LX, PY + 226, 'индекс по дате сократил бы до июля, но строки всё равно целиком: 23 ГБ', 'xo-ms');
        // колоночная
        s += T(RXX, PY + 6, 'КОЛОНОЧНАЯ БАЗА · ClickHouse', 'xr-m') + T(RXX, PY + 22, 'каждая колонка — свой файл; отчёт открывает 3 из 22', 'xr-s');
        COLS.forEach((c, j) => {
          const x = RXX + (j >= 11 ? 236 : 0), y = PY + 44 + (j % 11) * 15.5, nd = NEED.includes(j), gb = TOTAL * c[3];
          const bw = 64 * clamp(Math.log10(gb / 1e7) / Math.log10(800), 0.05, 1);
          s += T(x, y, `${c[0]}.bin`, 'xo-fn2' + (nd ? ' need' : ' dim'));
          s += R(x + 112, y - 8, 64, 9, 'xr-bar', 2) + R(x + 112, y - 8, bw * (nd ? kc : 1), 9, nd ? 'xr-bar-f acc' : 'xo-bar0', 2);
          s += T(x + 230, y, byt(gb), 'xo-ms' + (nd ? ' xo-acc' : ''), 'end');
        });
        s += T(RXX, PY + 226, `прочитано ${byt(1.9e9 * kc)} · ≈ ${nf(1.3 * kc, 1)} с${kc >= 1 ? ' — готово' : ''}`, 'xr-m ' + (kc >= 1 ? 'ok' : ''));
        // сравнение
        const BY = 484;
        s += T(30, BY, 'СКОЛЬКО БАЙТ ПРОЧИТАЛ ОТЧЁТ', 'xr-m');
        s += T(30, BY + 22, 'строковая', 'xr-s') + R(130, BY + 12, 700, 12, 'xr-bar', 3) + R(130, BY + 12, 700 * kr, 12, 'xr-bar-f warn', 3) + T(840, BY + 22, `${byt(95e9 * kr)}`, 'xr-m warn');
        s += T(30, BY + 44, 'колоночная', 'xr-s') + R(130, BY + 34, 700, 12, 'xr-bar', 3) + R(130, BY + 34, Math.max(2, 700 * 0.02 * kc), 12, 'xr-bar-f acc', 3) + T(840, BY + 44, `${byt(1.9e9 * kc)}`, 'xr-m acc');
        s += T(30, BY + 64, 'В 50 раз меньше байт. А партиции и min/max (следующий блок) оставят только июль: 458 МБ.', 'xr-s');
        return s;
      }

      function vComp() {
        const u = cyc(12000);
        let s = head('Сжатие колонок и блоки min/max', 'почему колонка весит в разы меньше и как отчёт пропускает блоки, не читая их');
        const RAW = ['RU', 'RU', 'KZ', 'RU', 'BY', 'RU', 'RU', 'UZ', 'RU', 'AM', 'RU', 'KZ', 'RU', 'RU', 'GE', 'RU'];
        // словарь
        const dk = Math.floor(clamp((u - 300) / 2600, 0, 1) * 16);
        s += T(30, 72, 'СЛОВАРЬ · колонка country, тип char(2)', 'xr-m') + T(560, 72, `${16} значений × 2 Б = 32 Б  →  16 × 3 бита = 6 Б`, 'xr-s');
        RAW.forEach((v, i) => {
          const x = 30 + i * 37, on = i === dk && dk < 16;
          s += R(x, 82, 32, 22, 'xo-cell' + (on ? ' on' : ''), 4) + T(x + 16, 97, v, 'xo-cv', 'middle');
          if (i < dk) { s += R(x, 124, 32, 22, 'xo-cell code', 4) + T(x + 16, 139, String(CC.indexOf(v)), 'xo-cv', 'middle'); }
          else s += R(x, 124, 32, 22, 'xo-cell e', 4);
        });
        if (dk < 16) s += arrow(46 + dk * 37, 106, 46 + dk * 37, 121, 'on');
        s += R(630, 80, 340, 68, 'xo-note', 8) + T(642, 98, 'словарь куска (хранится один раз):', 'xr-s');
        CC.forEach((c, j) => { s += T(642 + (j % 3) * 110, 118 + Math.floor(j / 3) * 18, `${j} → ${c}`, 'xr-m' + (j === CC.indexOf(RAW[Math.min(dk, 15)]) && dk < 16 ? ' acc' : '')); });
        // RLE
        const SORT = ['RU', 'RU', 'RU', 'RU', 'RU', 'RU', 'RU', 'RU', 'RU', 'KZ', 'KZ', 'BY', 'UZ', 'AM', 'GE', 'GE'];
        const RUNS = [['RU', 9], ['KZ', 2], ['BY', 1], ['UZ', 1], ['AM', 1], ['GE', 2]];
        const rk = clamp((u - 3200) / 1800, 0, 1);
        s += T(30, 176, 'RLE · повторы подряд — если кусок отсортирован ORDER BY (country, created_at)', 'xr-m');
        SORT.forEach((v, i) => { s += R(30 + i * 37, 186, 32, 22, 'xo-cell' + (rk > 0 ? ' dim' : ''), 4) + T(46 + i * 37, 201, v, 'xo-cv', 'middle'); });
        let rx = 30;
        RUNS.forEach(([c, n], j) => {
          const w = n * 37 - 5, sh = clamp(rk * RUNS.length - j, 0, 1);
          if (sh > 0) s += `<g opacity="${f1(sh)}">` + R(rx, 216, w, 24, 'xo-run', 5) + T(rx + w / 2, 232, n > 1 ? `${c} × ${n}` : `${c}×1`, 'xo-cv', 'middle') + '</g>';
          rx += n * 37;
        });
        s += R(630, 180, 340, 64, 'xo-note', 8) + T(642, 198, 'на настоящем куске июля одного шарда:', 'xr-s') + T(642, 216, 'RU × 20,1 млн · KZ × 5,2 млн · BY × 3,5 млн', 'xr-m') + T(642, 234, '6 пар вместо 34,7 млн значений', 'xr-m acc');
        // min/max
        const BL = [['RU', 121, 132], ['RU', 132, 143], ['RU', 143, 154], ['RU', 154, 165], ['RU', 165, 176], ['RU', 176, 187], ['RU', 187, 198], ['RU', 198, 209], ['RU', 209, 222],
          ['KZ', 121, 147], ['KZ', 147, 172], ['KZ', 172, 197], ['KZ', 197, 222], ['BY', 121, 171], ['BY', 171, 222], ['UZ…GE', 121, 222]];
        const zk = clamp((u - 5200) / 5600, 0, 1), cur = Math.min(15, Math.floor(zk * 16.999)), act = u > 5200;
        s += T(30, 268, 'MIN/MAX ПО БЛОКАМ · колонка created_at, блок = 8 192 строки', 'xr-m') + T(970, 268, 'кусок без партиций: май — 10 августа', 'xr-s', 'end');
        s += SQL(30, 288, "WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01'");
        let rd = 0, sk = 0;
        BL.forEach(([c, a, b], i) => {
          const x = 30 + i * 59, ov = b >= JUL0 && a <= JUL1, seen = act && i < cur || (act && zk >= 1), on = act && i === cur && zk < 1;
          if (seen) { if (ov) rd++; else sk++; }
          s += R(x, 300, 54, 78, 'xo-blk' + (seen ? (ov ? ' rd' : ' sk') : '') + (on ? ' on' : ''), 6);
          s += T(x + 27, 316, c, 'xo-cv', 'middle') + T(x + 6, 336, 'min', 'xo-ms') + T(x + 6, 349, md(a), 'xo-pn') + T(x + 6, 364, 'max', 'xo-ms') + T(x + 6, 376, md(b), 'xo-pn');
        });
        if (act && (sk > 0)) S.pv.zoneSkip = 1;
        const bb = BL[cur], ov = bb[2] >= JUL0 && bb[1] <= JUL1;
        s += T(30, 402, act ? (ov ? `блок ${cur + 1} (${bb[0]}): ${md(bb[1])}…${md(bb[2])} пересекается с июлем → читаем` : `блок ${cur + 1} (${bb[0]}): ${bb[2] < JUL0 ? `max ${md(bb[2])} раньше 07-01` : `min ${md(bb[1])} позже 07-31`} → пропуск, байты не трогаем`) : 'проверка блоков начнётся через секунду…', 'xr-s ' + (act ? (ov ? 'xo-ok' : 'xo-dim2') : ''));
        s += T(970, 402, `прочитано ${rd} · пропущено ${sk} из 16`, 'xr-m', 'end');
        s += T(30, 420, 'С партициями по месяцам этот кусок разделился бы на 4, и июльский читался бы целиком, а остальные отбрасывались ещё до min/max.', 'xo-ms');
        // сколько весит колонка
        const CP = [['country', 2, 0.1, 'словарь'], ['status', 8, 0.3, 'словарь'], ['created_at', 8, 0.7, 'DoubleDelta'], ['amount', 8, 3.6, 'LZ4'], ['address', 48, 14, 'ZSTD'], ['вся строка', 220, 38.3, 'всё вместе']];
        s += T(30, 446, 'СКОЛЬКО БАЙТ НА СТРОКУ — ДО И ПОСЛЕ СЖАТИЯ', 'xr-m');
        CP.forEach(([n, a, b, how], j) => {
          const x = 30 + j * 158, last = j === CP.length - 1;
          s += R(x, 456, 150, 92, 'xo-note' + (last ? ' on' : ''), 8) + T(x + 10, 474, n, 'xo-cn');
          s += R(x + 10, 484, 128, 9, 'xr-bar', 2) + R(x + 10, 484, 128, 9, 'xo-bar0', 2) + R(x + 10, 498, 128 * b / a, 9, 'xr-bar-f acc', 2);
          s += T(x + 10, 522, `${nf(a)} Б → ${nf(b, b < 1 ? 1 : b < 10 ? 1 : 0)} Б`, 'xr-m') + T(x + 10, 540, `×${nf(a / b, a / b >= 10 ? 0 : 1)} · ${how}`, 'xo-ms');
        });
        return s;
      }

      /* модель данных: звезда, снежинка, широкая таблица */
      const F_ROWS = [
        { f: ['10482931', '20260714', '1377', '3071', '1290.00', '1'], d: ['20260714', '2026-07-14', '2026-07', 'Q3', 'вт', 'false'], u: ['1377', '55120', 'Анна К.', 'Москва', 'RU', '2026-07-10', '9999-12-31'], p: ['3071', '3071', 'Наушники беспроводные', 'Электроника', 'Sony'], c: ['7', 'Электроника', 'Техника'], ci: ['14', 'Москва', 'RU'] },
        { f: ['10482932', '20260714', '2210', '118', '845.50', '2'], d: ['20260714', '2026-07-14', '2026-07', 'Q3', 'вт', 'false'], u: ['2210', '80441', 'Ерлан Б.', 'Алматы', 'KZ', '2024-11-20', '9999-12-31'], p: ['118', '118', 'Чехол для телефона', 'Аксессуары', 'Baseus'], c: ['12', 'Аксессуары', 'Техника'], ci: ['31', 'Алматы', 'KZ'] },
        { f: ['10391177', '20260703', '901', '9012', '3490.00', '1'], d: ['20260703', '2026-07-03', '2026-07', 'Q3', 'пт', 'false'], u: ['901', '55120', 'Анна К.', 'Казань', 'RU', '2025-03-02', '2026-07-10'], p: ['9012', '9012', 'Кофемашина капсульная', 'Бытовая техника', 'DeLonghi'], c: ['4', 'Бытовая техника', 'Дом'], ci: ['9', 'Казань', 'RU'] }];
      function card(x, y, w, title, cols, vals, act, keyRow, o) {
        o = o || {};
        const rh = 17, h = 24 + cols.length * rh + 4;
        let s = R(x, y, w, h, 'xo-card' + (act ? ' on' : ''), 8) + R(x, y, w, 22, 'xo-cardh', 8) + T(x + 10, y + 15, title, 'xo-cn');
        if (o.rows) s += T(x + w - 10, y + 15, o.rows, 'xo-ms', 'end');
        cols.forEach(([n, t, k], j) => {
          const yy = y + 24 + j * rh;
          if (keyRow != null && j === keyRow && act) s += R(x + 2, yy, w - 4, rh, 'xo-krow', 3);
          s += T(x + 10, yy + 12, n, 'xo-cn sm' + (k ? ' key' : '')) + T(x + 10 + (o.tw || 104), yy + 12, t + (k === 'pk' ? ' · PK' : k === 'fk' ? ' · FK' : ''), 'xo-ms' + (k ? ' xo-acc' : ''));
          if (vals) s += T(x + w - 10, yy + 12, ES(cut(vals[j], o.vw || 16)), 'xo-val' + (act ? ' on' : ''), 'end');
        });
        return s;
      }
      const cardRowY = (y, j) => y + 24 + j * 17 + 8;
      function vStar() {
        const sc = schema();
        if (sc === 'obt') return vObt();
        const C = 4200, ix = Math.floor(S.vt / C) % 3, u = S.vt % C, F = F_ROWS[ix], k1 = clamp((u - 500) / 900, 0, 1), k2 = u > 1500;
        let s = head(sc === 'snowflake' ? 'Модель данных: снежинка' : 'Модель данных: звезда', sc === 'snowflake' ? 'факт в центре, измерения вокруг, а у измерений — свои справочники: больше JOIN, меньше повторов' : 'факт в центре — заказы с числами; вокруг измерения — кто, что и когда');
        const FX = 375, FY = 150, FW = 250, DD = [30, 66], DU = [720, 66], DP = [30, sc === 'snowflake' ? 222 : 236];
        const fc = [['order_id', 'bigint'], ['date_key', 'int', 'fk'], ['user_key', 'int', 'fk'], ['product_key', 'int', 'fk'], ['amount', 'numeric(12,2)'], ['qty', 'int']];
        const dc = [['date_key', 'int', 'pk'], ['date', 'date'], ['year_month', 'char(7)'], ['quarter', 'char(2)'], ['weekday', 'text'], ['is_holiday', 'boolean']];
        const uc = sc === 'snowflake' ? [['user_key', 'int', 'pk'], ['user_id', 'bigint'], ['name', 'text'], ['city_key', 'int', 'fk'], ['valid_from', 'date'], ['valid_to', 'date']]
          : [['user_key', 'int', 'pk'], ['user_id', 'bigint'], ['name', 'text'], ['city', 'text'], ['country', 'char(2)'], ['valid_from', 'date'], ['valid_to', 'date']];
        const pc = sc === 'snowflake' ? [['product_key', 'int', 'pk'], ['product_id', 'int'], ['name', 'text'], ['category_key', 'int', 'fk'], ['brand', 'text']] : [['product_key', 'int', 'pk'], ['product_id', 'int'], ['name', 'text'], ['category', 'text'], ['brand', 'text']];
        const uv = sc === 'snowflake' ? [F.u[0], F.u[1], F.u[2], F.ci[0], F.u[5], F.u[6]] : F.u, pv = sc === 'snowflake' ? [F.p[0], F.p[1], F.p[2], F.c[0], F.p[4]] : F.p;
        // линии связей
        const links = [[FX, cardRowY(FY, 1), DD[0] + 260, cardRowY(DD[1], 0)], [FX + FW, cardRowY(FY, 2), DU[0], cardRowY(DU[1], 0)], [FX, cardRowY(FY, 3), DP[0] + 260, cardRowY(DP[1], 0)]];
        links.forEach(([x1, y1, x2, y2]) => {
          s += `<path class="xo-link" d="M${f1(x1)},${f1(y1)} C${f1((x1 + x2) / 2)},${f1(y1)} ${f1((x1 + x2) / 2)},${f1(y2)} ${f1(x2)},${f1(y2)}"/>`;
          if (k1 > 0) s += `<path class="xo-link on" pathLength="100" stroke-dasharray="${f1(100 * k1)} 100" d="M${f1(x1)},${f1(y1)} C${f1((x1 + x2) / 2)},${f1(y1)} ${f1((x1 + x2) / 2)},${f1(y2)} ${f1(x2)},${f1(y2)}"/>`;
        });
        s += card(FX, FY, FW, 'fact_orders', fc, F.f, true, null, { rows: '432 млн строк', tw: 92 });
        s += card(DD[0], DD[1], 260, 'dim_date', dc, k2 ? F.d : null, k2, 0, { rows: '3 650 строк', tw: 96 });
        s += card(DU[0], DU[1], 260, 'dim_user', uc, k2 ? uv : null, k2, 0, { rows: '40 млн', tw: 86 });
        s += card(DP[0], DP[1], 260, 'dim_product', pc, k2 ? pv : null, k2, 0, { rows: '1,2 млн', tw: 96, vw: 18 });
        if (sc === 'snowflake') {
          const CI = [720, 216], CA = [30, 352], k3 = u > 2300;
          s += `<path class="xo-link${k3 ? ' on' : ''}" d="M${DU[0] + 130},${f1(DU[1] + 24 + 6 * 17 + 4)} L${CI[0] + 130},${CI[1]}"/>`;
          s += `<path class="xo-link${k3 ? ' on' : ''}" d="M${DP[0] + 130},${f1(DP[1] + 24 + 5 * 17 + 4)} L${CA[0] + 130},${CA[1]}"/>`;
          s += card(CI[0], CI[1], 260, 'dim_city', [['city_key', 'int', 'pk'], ['name', 'text'], ['country', 'char(2)']], k3 ? F.ci : null, k3, 0, { rows: '2 400 строк' });
          s += card(CA[0], CA[1], 260, 'dim_category', [['category_key', 'int', 'pk'], ['name', 'text'], ['parent', 'text']], k3 ? F.c : null, k3, 0, { rows: '640 строк', vw: 18 });
        }
        // отчёт
        const RX0 = 375, RY1 = 300;
        s += R(RX0, RY1, 595, 246, 'xo-panel', 10) + T(RX0 + 14, RY1 + 20, 'ОТЧЁТ: ВЫРУЧКА ПО КАТЕГОРИЯМ И ГОРОДАМ ЗА ИЮЛЬ', 'xr-m');
        const QL = sc === 'snowflake' ? ['SELECT ci.name AS city, ca.name AS category, sum(f.amount)', 'FROM fact_orders f', 'JOIN dim_date d     ON d.date_key = f.date_key', 'JOIN dim_user u     ON u.user_key = f.user_key', 'JOIN dim_city ci    ON ci.city_key = u.city_key', 'JOIN dim_product p  ON p.product_key = f.product_key', 'JOIN dim_category ca ON ca.category_key = p.category_key', "WHERE d.year_month = '2026-07' GROUP BY city, category"]
          : ['SELECT u.city, p.category, sum(f.amount) AS revenue', 'FROM fact_orders f', 'JOIN dim_date d    ON d.date_key = f.date_key', 'JOIN dim_user u    ON u.user_key = f.user_key', 'JOIN dim_product p ON p.product_key = f.product_key', "WHERE d.year_month = '2026-07'", 'GROUP BY u.city, p.category'];
        QL.forEach((l, j) => { s += SQL(RX0 + 14, RY1 + 42 + j * 15, l, 'sm'); });
        const ry = RY1 + 52 + QL.length * 15;
        s += T(RX0 + 14, ry, 'собранная строка (до GROUP BY):', 'xr-s');
        const cells = [['день', F.d[1]], ['город', F.u[3]], ['категория', F.p[3]], ['сумма', F.f[4]]];
        cells.forEach(([h, v], j) => {
          const x = RX0 + 14 + j * 142, on = u > 2000 + j * 250;
          s += R(x, ry + 8, 134, 40, 'xo-cell' + (on ? ' code' : ' e'), 6) + T(x + 8, ry + 22, h, 'xo-ms') + (on ? T(x + 8, ry + 40, ES(cut(v, 18)), 'xr-m acc') : '');
        });
        s += T(RX0 + 14, ry + 66, sc === 'snowflake' ? 'JOIN × 5: категория и город лежат в своих справочниках — места меньше, запрос длиннее.' : 'JOIN × 3: измерения маленькие, их держат на каждом шарде целиком — JOIN дешёвый.', 'xo-ms');
        return s;
      }
      function vObt() {
        const u = S.vt % 6000;
        let s = head('Модель данных: одна широкая таблица (OBT)', 'всё, что нужно отчётам, лежит прямо в строке заказа: JOIN не нужен, но значения повторяются');
        const cols = [['order_id', 'bigint', 74], ['created_at', 'timestamp', 128], ['user_id', 'bigint', 58], ['user_name', 'text', 76], ['city', 'text', 74], ['country', 'char(2)', 52], ['product', 'text', 136], ['category', 'text', 96], ['brand', 'text', 70], ['amount', 'numeric', 72], ['qty', 'int', 34], ['status', 'text', 70]];
        const rows = [['10482931', '2026-07-14 12:31:07', '55120', 'Анна К.', 'Москва', 'RU', 'Наушники беспроводные', 'Электроника', 'Sony', '1290.00', '1', 'paid'],
          ['10482932', '2026-07-14 12:31:09', '80441', 'Ерлан Б.', 'Алматы', 'KZ', 'Чехол для телефона', 'Аксессуары', 'Baseus', '845.50', '2', 'paid'],
          ['10482934', '2026-07-14 12:31:18', '12008', 'Олег М.', 'Минск', 'BY', 'Наушники беспроводные', 'Электроника', 'Sony', '1290.00', '1', 'paid'],
          ['10482939', '2026-07-14 12:31:44', '55120', 'Анна К.', 'Москва', 'RU', 'Зарядка USB-C 65 Вт', 'Электроника', 'Anker', '2490.00', '1', 'paid'],
          ['10482940', '2026-07-14 12:31:52', '30115', 'Дильноза Р.', 'Ташкент', 'UZ', 'Кофемашина капсульная', 'Бытовая техника', 'DeLonghi', '5600.00', '1', 'paid']];
        const X0 = 30, Y0 = 74;
        let x = X0;
        s += R(X0 - 6, Y0 - 6, 952, 34 + rows.length * 22 + 14, 'xo-panel', 10);
        cols.forEach(([n, t, w]) => { s += T(x, Y0 + 8, n, 'xo-cn sm') + T(x, Y0 + 22, t, 'xo-ms'); x += w; });
        const hlv = ['Электроника', 'Анна К.', 'Москва', 'Sony'][Math.floor(u / 1500) % 4];
        rows.forEach((r, i) => {
          x = X0; const y = Y0 + 46 + i * 22;
          r.forEach((v, j) => { const w = cols[j][2]; s += T(x, y, ES(cut(v, Math.floor((w - 10) / 6.4))), 'xo-val' + (v === hlv ? ' rep' : '')); x += w; });
        });
        const by = Y0 + 34 + rows.length * 22 + 30;
        s += T(30, by, `Подсвечено «${hlv}»: одно и то же значение записано в каждой строке. За июль «Электроника» повторяется ≈ 18 млн раз.`, 'xr-s xo-acc');
        const pros = [['Плюсы', ['JOIN не нужен — отчёт читает одну таблицу', 'колоночная база не читает лишние колонки', 'нет перемешивания по сети между шардами', 'проще аналитикам: всё в одном месте']], ['Минусы', ['переименовали категорию — переписать миллионы строк', 'город покупателя «на момент заказа» зашит навсегда', 'больше места на диске (хотя сжатие спасает)', 'новое поле — пересобрать таблицу']]];
        pros.forEach(([t, ls], j) => {
          const xx = 30 + j * 476;
          s += R(xx, by + 16, 464, 128, 'xo-note' + (j === 0 ? ' on' : ''), 10) + T(xx + 14, by + 38, t, 'xr-t');
          ls.forEach((l, k) => { s += T(xx + 14, by + 62 + k * 19, '· ' + l, 'xr-s'); });
        });
        s += SQL(30, by + 172, 'SELECT city, category, sum(amount) FROM orders_wide') + SQL(30, by + 190, "WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01' GROUP BY city, category");
        return s;
      }

      function vScd() {
        const C = 13000, u = S.vt % C, day = clamp(1 + (u - 600) / 8400 * 30, 1, 31), X = d => 60 + (d - 1) * 29.3;
        if (day >= 14) S.pv.scdSeen = 1;
        let s = head('История изменений: SCD2', 'покупательница 55120 переехала из Казани в Москву 10 июля — куда отнести её заказы?');
        // шкала
        s += Ln(X(1), 112, X(31), 112, 'xo-axis');
        for (let d = 1; d <= 31; d++) s += Ln(X(d), 108, X(d), 116, 'xo-tick');
        [1, 5, 10, 15, 20, 25, 31].forEach(d => { s += T(X(d), 132, `${d} июл`, 'xo-ms', 'middle'); });
        s += Ln(X(10), 70, X(10), 118, 'xo-move') + T(X(10) + 6, 78, '10 июля: переезд Казань → Москва', 'xr-s xo-warn');
        const ORD = [[3, '10391177', '3 490'], [14, '10482931', '1 290'], [22, '10529904', '560']];
        ORD.forEach(([d, id, a]) => { const on = day >= d; s += `<circle class="xo-ord${on ? ' on' : ''}" cx="${f1(X(d))}" cy="112" r="7"/>` + T(X(d), 100, `${a} ₽`, 'xr-m' + (on ? ' acc' : ''), 'middle'); });
        s += `<polygon class="xo-cur" points="${f1(X(day) - 6)},146 ${f1(X(day) + 6)},146 ${f1(X(day))},138"/>` + T(X(day), 160, `сегодня в модели: ${Math.floor(day)} июля`, 'xo-ms', 'middle');
        // факт
        const FX = 30, FY = 182, DX = 390, DY0 = 182;
        s += T(FX, FY - 6, 'fact_orders — заказы', 'xr-m');
        const fcols = [['order_id', 76], ['created_at', 84], ['user_key', 66], ['amount', 70]];
        let x = FX; fcols.forEach(([n, w]) => { s += T(x, FY + 12, n, 'xo-cn sm'); x += w; });
        const keyAt = d => d < 10 ? '901' : '1377';
        ORD.forEach(([d, id, a], i) => {
          if (day < d) return;
          const y = FY + 32 + i * 26, fresh = day - d < 1.2;
          s += R(FX - 6, y - 15, 308, 22, 'xo-tr' + (fresh ? ' on' : ''), 4);
          x = FX; [id, `2026-07-${String(d).padStart(2, '0')}`, keyAt(d), a].forEach((v, j) => { s += T(x, y, v, j === 2 ? 'xr-m acc' : 'xo-val'); x += fcols[j][1]; });
          const ty = keyAt(d) === '901' ? 0 : 1;
          s += arrow(FX + 304, y - 4, 384, DY0 + 32 + ty * 26 - 4, 'acc');
        });
        // dim_user SCD2
        s += T(DX, DY0 - 6, 'dim_user — SCD2: новая строка на каждое изменение', 'xr-m');
        const dcols = [['user_key', 66], ['city', 70], ['valid_from', 92], ['valid_to', 92], ['is_current', 66]];
        x = DX; dcols.forEach(([n, w]) => { s += T(x, DY0 + 12, n, 'xo-cn sm'); x += w; });
        const moved = day >= 10, fl = day >= 10 && day < 11.5;
        const r1 = ['901', 'Казань', '2025-03-02', moved ? '2026-07-10' : '9999-12-31', moved ? 'false' : 'true'];
        s += R(DX - 6, DY0 + 17, 392, 22, 'xo-tr' + (fl ? ' upd' : ''), 4);
        x = DX; r1.forEach((v, j) => { s += T(x, DY0 + 32, v, 'xo-val' + ((j === 3 || j === 4) && fl ? ' on' : '')); x += dcols[j][1]; });
        if (moved) {
          const k = clamp((day - 10) / 1.2, 0, 1);
          s += `<g opacity="${f1(k)}">` + R(DX - 6, DY0 + 43, 392, 22, 'xo-tr on', 4);
          x = DX; ['1377', 'Москва', '2026-07-10', '9999-12-31', 'true'].forEach((v, j) => { s += T(x, DY0 + 58, v, 'xo-val on'); x += dcols[j][1]; });
          s += '</g>';
        }
        s += T(DX, DY0 + 92, moved ? 'старую строку закрыли (valid_to), новую добавили с новым ключом' : 'одна строка: живёт в Казани «до бесконечности»', 'xo-ms' + (moved ? ' xo-acc' : ''));
        // SCD1
        const SX = 806;
        s += R(SX - 10, 168, 184, 116, 'xo-note', 8) + T(SX, 186, 'А при SCD1 (перезапись):', 'xr-s');
        s += T(SX, 206, 'user_id  city', 'xo-cn sm') + T(SX, 226, '55120', 'xo-val') + T(SX + 60, 226, moved ? 'Москва' : 'Казань', 'xo-val' + (fl ? ' bad' : ''));
        s += T(SX, 248, moved ? 'UPDATE: Казань стёрта,' : 'одна строка без истории', 'xo-ms' + (moved ? ' xo-bad' : '')) + T(SX, 262, moved ? 'истории больше нет' : '', 'xo-ms xo-bad');
        // отчёты
        const RY = 316, sum = (f) => ORD.filter(o => day >= o[0] && f(o)).reduce((s2, o) => s2 + +o[2].replace(' ', ''), 0);
        const k1 = sum(o => o[0] < 10), k2 = sum(o => o[0] >= 10), all = k1 + k2;
        const rep = (x, title, rowsR, ok, msg) => {
          let t = R(x, RY, 460, 150, 'xo-panel' + (ok ? ' okb' : ' badb'), 10) + T(x + 14, RY + 22, title, 'xr-t');
          rowsR.forEach(([c, v], j) => { const y = RY + 46 + j * 30; t += T(x + 14, y + 10, c, 'xr-m') + R(x + 110, y, 250, 14, 'xr-bar', 3) + R(x + 110, y, 250 * clamp(v / 5340, 0, 1), 14, 'xr-bar-f' + (ok ? '' : ' warn'), 3) + T(x + 446, y + 11, `${nf(v)} ₽`, 'xr-m', 'end'); });
          return t + T(x + 14, RY + 132, msg, 'xr-s ' + (ok ? 'xo-ok' : 'xo-bad'));
        };
        s += rep(30, 'Выручка по городам за июль · SCD1', [['Казань', moved ? 0 : k1], ['Москва', moved ? all : 0]], false, moved && k1 ? 'заказ от 3 июля «переехал» в Москву — неверно' : 'пока покупательница не переехала, всё верно');
        s += rep(510, 'Выручка по городам за июль · SCD2', [['Казань', k1], ['Москва', k2]], true, 'каждый заказ — в городе, где она жила в тот день');
        s += SQL(30, 494, 'JOIN dim_user u ON u.user_key = f.user_key   -- ключ версии записали в факт при загрузке', 'sm');
        s += SQL(30, 512, 'или: ON u.user_id = f.user_id AND f.created_at >= u.valid_from AND f.created_at < u.valid_to', 'sm');
        s += T(30, 536, 'Текущий город — WHERE is_current. В dbt такие таблицы делает dbt snapshot.', 'xo-ms');
        return s;
      }

      function vMpp() {
        const n = S.sh.length, PH = [6000, 6500, 7000, 6000], tot = PH.reduce((a, b) => a + b, 0);
        const off = S.scn === 'join' ? PH[0] + PH[1] : skew() ? PH[0] + PH[1] + PH[2] : 0;
        let u = (S.vt + off) % tot, ph = 0; while (u >= PH[ph]) { u -= PH[ph]; ph++; }
        S.pv.ph = ph;
        const titles = ['1 · Раскладка по ключу', '2 · Параллельный подсчёт', '3 · JOIN и перемешивание', '4 · Перекос'];
        let s = head('Шарды: параллельный подсчёт и перемешивание', `${n} ${pl(n, 'шард', 'шарда', 'шардов')} · ключ раскладки order_id % ${n} · фазы идут по кругу`);
        titles.forEach((t, j) => {
          const x = 30 + j * 238;
          s += R(x, 58, 230, 26, 'xo-phase' + (j === ph ? ' on' : j < ph ? ' past' : ''), 13) + T(x + 115, 75, t, 'xr-s' + (j === ph ? ' xo-acc' : ''), 'middle');
          if (j === ph) s += R(x + 10, 80, 210 * (u / PH[ph]), 3, 'xr-bar-f acc', 1.5);
        });
        const gap = n > 5 ? 8 : 12, W = (940 - (n - 1) * gap) / n, SY = 236, SH = 240, gx = i => 30 + i * (W + gap), cxs = i => gx(i) + W / 2;
        const SRCP = [140, 150], COP = [500, 150];
        const rows = ROWS.map(r => ({ o: +r[0], uid: +r[1], c: r[3], a: r[5] }));
        const home = r => r.o % n, uhome = r => r.uid % n;
        s += R(30, 124, 220, 52, 'xr-box' + (ph === 0 ? ' sel' : ''), 10) + T(42, 144, 'Новые заказы', 'xr-t') + T(42, 162, 'INSERT … 8 строк', 'xr-s');
        s += R(410, 124, 180, 52, 'xr-box' + (ph === 1 ? ' sel' : ''), 10) + T(422, 144, 'Координатор', 'xr-t') + T(422, 162, ph === 1 ? (u > 4200 ? 'сложил итоги' : 'ждёт итоги') : 'рассылает запрос', 'xr-s');
        for (let i = 0; i < n; i++) {
          const x = gx(i), skw = ph === 3 && i === 0 && n > 1;
          s += R(x, SY, W, SH, 'xo-sh' + (skw ? ' hot' : ''), 10) + T(x + 8, SY + 18, W >= 70 ? `шард ${i + 1}` : String(i + 1), 'xr-t xo-nh');
        }
        const lineIn = (i, j, txt, c) => T(gx(i) + 8, SY + 40 + j * 16, ES(cut(txt, Math.floor((W - 14) / 6.3))), 'xo-pn' + (c ? ' ' + c : ''));
        if (ph === 0) {
          const per = 620, cnt = Array(n).fill(0);
          rows.forEach((r, j) => {
            const t0 = 400 + j * per, k = clamp((u - t0) / 700, 0, 1), i = home(r);
            if (u >= t0 + 700) { s += lineIn(i, cnt[i], `${r.o} · ${r.c} · ${r.a}`); cnt[i]++; }
            else if (k > 0) {
              const [x, y] = lerp([250, 150], [cxs(i), SY - 4], ease(k));
              s += Dot(x, y, 5, '', `fill:${SD.kindColor('write')}`) + T(x + 8, y - 8, `${r.o} % ${n} = ${r.o % n} → шард ${i + 1}`, 'xr-pop', '');
            }
          });
          s += T(30, 498, `Ключ раскладки — order_id: остаток от деления на ${n} решает, на какой шард лечь строке. Строк на каждом шарде примерно поровну.`, 'xr-s');
          s += T(30, 518, 'В жизни берут хеш ключа (cityHash64(order_id) % N), чтобы соседние номера не ложились подряд на один шард.', 'xo-ms');
        } else if (ph === 1) {
          const kk = clamp((u - 300) / 2600, 0, 1), sent = u > 3000, arr = clamp((u - 3000) / 900, 0, 1);
          for (let i = 0; i < n; i++) {
            const x = gx(i), p = partial(i, true), d = 1 + 0.06 * Math.sin(i * 2.3), mine = rows.filter(r => home(r) === i);
            mine.slice(0, 4).forEach((r, j) => { s += lineIn(i, j, `${r.o} · ${r.c} · ${r.a}`, 'xo-dim2'); });
            if (mine.length > 4) s += lineIn(i, 4, `… ещё ${mine.length - 4}`, 'xo-dim2');
            const by = SY + 40 + Math.min(5, Math.max(3, mine.length)) * 16, two = W >= 200;
            s += R(x + 8, by - 6, W - 16, 8, 'xr-bar', 3) + R(x + 8, by - 6, (W - 16) * clamp(kk * d, 0, 1), 8, 'xr-bar-f acc', 3);
            s += T(x + 8, by + 14, W >= 130 ? `читает ${mln(JUL / n)} строк` : mln(JUL / n), 'xo-ms');
            if (kk * d >= 1) CC.forEach((c, j) => { if (j < (W >= 100 ? 6 : 3)) s += T(x + 8 + (two ? (j % 2) * Math.min(110, (W - 16) / 2) : 0), by + 34 + (two ? Math.floor(j / 2) : j) * 16, `${c} ${nf(p[j], 1)}`, 'xo-pn xo-ok'); });
            if (sent && arr < 1) { const [xx, yy] = lerp([cxs(i), SY - 4], [500, 178], ease(arr)); s += R(xx - 6, yy - 6, 12, 12, 'xo-partial', 3); }
            s += Ln(cxs(i), SY, 500, 176, 'xo-fan');
          }
          if (arr >= 1) {
            s += R(610, 112, 360, 110, 'xo-note on', 10) + T(624, 132, 'итог координатора, млрд ₽', 'xr-s');
            CC.forEach((c, j) => { s += T(624 + (j % 3) * 116, 156 + Math.floor(j / 3) * 22, `${c} ${nf(REV[j], 1)}`, 'xr-m acc'); });
            s += T(624, 210, 'по сети пришло 6 × ' + n + ' чисел, а не 104 млн строк', 'xo-ms');
          }
          s += T(30, 498, `Каждый шард читает только свои ${mln(JUL / n)} строк — все одновременно. ${n > 1 ? `В ${n} ${pl(n, 'раз', 'раза', 'раз')} быстрее одного сервера.` : 'Шард один — помогать ему некому.'}`, 'xr-s');
          s += T(30, 518, 'Наверх едут только частичные суммы по странам — несколько байт с каждого шарда.', 'xo-ms');
        } else if (ph === 2) {
          const obt = schema() === 'obt', mv = rows.filter(r => home(r) !== uhome(r)).length;
          rows.forEach((r, j) => {
            const i = home(r), t = uhome(r), y0 = SY + 40 + j * 0;
            const k = clamp((u - 600 - j * 450) / 900, 0, 1);
            const slot = rows.slice(0, j).filter(x => home(x) === i).length;
            if (obt || n === 1 || i === t) { s += lineIn(i, slot, `${r.o} · user ${r.uid}`, i === t || obt ? 'xo-ok' : ''); return; }
            if (k <= 0) { s += lineIn(i, slot, `${r.o} · user ${r.uid}`); return; }
            if (k < 1) {
              const A = [cxs(i), SY + 44 + slot * 16], B = [cxs(t), SY + 150], Cc = [(A[0] + B[0]) / 2, SY - 40];
              const [x, y] = bez(A, Cc, B, ease(k));
              s += `<circle class="xr-dot" cx="${f1(x)}" cy="${f1(y)}" r="5" style="fill:var(--k-job)"/>` + T(x + 8, y - 6, `user ${r.uid} % ${n} = ${t}`, 'xr-pop warn');
            } else {
              const arrived = rows.slice(0, j).filter(x => uhome(x) === t && home(x) !== t).length;
              s += T(gx(t) + 8, SY + 160 + arrived * 15, ES(cut(`← ${r.o} от шарда ${i + 1}`, Math.floor((W - 14) / 6.3))), 'xo-pn xo-warn');
            }
          });
          for (let i = 0; i < n; i++) s += Ln(gx(i) + 6, SY + 142, gx(i) + W - 6, SY + 142, 'xo-sep') + T(gx(i) + 8, SY + 138, W >= 120 ? 'покупатели: user_id % ' + n + ' = ' + i : 'покуп.', 'xo-ms');
          s += T(30, 498, obt ? 'Широкая таблица: город уже лежит в строке заказа — JOIN не нужен, по сети ничего не едет.' : n === 1 ? 'Сервер один: заказы и покупатели лежат рядом, перемешивать нечего — но и считать некому помочь.' : `Заказы лежат по order_id, покупатели — по user_id. ${mv} из 8 строк едут на чужой шард: в жизни ≈ ${mln(JUL * (1 - 1 / n))} строк, ${byt(JUL * (1 - 1 / n) * 16)} по сети.`, 'xr-s' + (obt || n === 1 ? ' xo-ok' : ' xo-warn'));
          s += T(30, 518, 'Лечат так: класть заказы по user_id рядом с покупателями (co-location) или разослать маленькую таблицу на все шарды (GLOBAL JOIN, broadcast).', 'xo-ms');
        } else {
          const sk = Array.from({ length: n }, (_, i) => { let v = 0; CSH.forEach((x, c) => { if (c % n === i) v += x; }); return v; });
          const kk = clamp((u - 400) / 3600, 0, 1), mx = Math.max(...sk);
          for (let i = 0; i < n; i++) {
            const x = gx(i), f = clamp(kk / (sk[i] / mx), 0, 1), slow = sk[i] === mx;
            s += T(x + 8, SY + 40, W >= 120 ? `по order_id: ${Math.round(100 / n)} %` : `${Math.round(100 / n)} %`, 'xo-ms');
            s += R(x + 8, SY + 48, (W - 16) * (1 / n) / mx, 10, 'xo-bar0', 3);
            s += T(x + 8, SY + 80, W >= 120 ? `по country: ${Math.round(sk[i] * 100)} %` : `${Math.round(sk[i] * 100)} %`, 'xo-ms' + (slow && n > 1 ? ' xo-bad' : ''));
            s += R(x + 8, SY + 88, (W - 16) * sk[i] / mx, 10, 'xr-bar-f' + (slow && n > 1 ? ' bad' : ''), 3);
            const cs = CC.filter((c, j) => j % n === i).join(' ');
            s += T(x + 8, SY + 118, ES(cut(cs || '—', Math.floor((W - 14) / 6.3))), 'xo-pn');
            s += R(x + 8, SY + 140, W - 16, 8, 'xr-bar', 3) + R(x + 8, SY + 140, (W - 16) * f, 8, 'xr-bar-f' + (slow && n > 1 ? ' warn' : ''), 3);
            s += T(x + 8, SY + 166, f >= 1 ? (slow ? 'готово последним' : 'готово, ждёт') : 'считает…', 'xo-ms ' + (f >= 1 ? (slow && n > 1 ? 'xo-warn' : 'xo-ok') : ''));
          }
          s += T(30, 498, n > 1 ? `Ключ country: Россия (58 % заказов) целиком попадает на шард 1 — ему ${Math.round(mx * 100)} % работы. Отчёт ждёт самого медленного.` : 'Шард один — перекоса нет, но и параллельности тоже.', 'xr-s' + (n > 1 ? ' xo-warn' : ''));
          s += T(30, 518, 'Добавить шарды не поможет: Россия всё равно ляжет на один. Нужен ключ с равномерным распределением — order_id, user_id или хеш.', 'xo-ms');
        }
        return s;
      }

      function insTick(dt) {
        const pv = S.pv.ins || (S.pv.ins = { parts: [mk(1, 388, 4, 9.1e6), mk(389, 405, 2, 0.85e6), mk(406, 410, 1, 0.25e6), mk(411, 411, 0, 5e4)], blk: 411, at: 300, mg: null, mgAt: 0, rej: [], inT: [], mgT: [], last: null, t: 0 });
        pv.t += dt;
        const row = rowMode(), LM = 20;
        while (pv.t >= pv.at) {
          pv.at += row ? 110 : 1600;
          if (row && pv.parts.length >= LM) { pv.rej.push(pv.t); continue; }
          pv.blk++; const p = mk(pv.blk, pv.blk, 0, row ? 1 : 5e4); p.t0 = pv.t; pv.parts.push(p); pv.last = p; pv.inT.push(pv.t);
        }
        if (pv.mg && pv.t >= pv.mg.t1) {
          const sel = pv.parts.filter(p => pv.mg.ids.includes(p.id));
          if (sel.length >= 2) { const j = pv.parts.indexOf(sel[0]), np = mk(sel[0].a, sel[sel.length - 1].b, Math.max(...sel.map(p => p.lvl)) + 1, sel.reduce((s2, p) => s2 + p.rows, 0)); np.t0 = pv.t; pv.parts.splice(j, sel.length, np); pv.mgT.push(pv.t); pv.lastMg = np; }
          pv.mg = null; pv.mgAt = pv.t + 200;
        }
        if (!pv.mg && pv.t >= pv.mgAt) {
          let j = pv.parts.length; while (j > 0 && pv.parts[j - 1].lvl < 4) j--;
          const run = pv.parts.length - j;
          if (run >= 3) pv.mg = { ids: pv.parts.slice(j, j + Math.min(run, row ? 6 : 5)).map(p => p.id), t0: pv.t, t1: pv.t + (row ? 1300 : 900) };
        }
        pv.rej = pv.rej.filter(t => t > pv.t - 10000); pv.inT = pv.inT.filter(t => t > pv.t - 10000); pv.mgT = pv.mgT.filter(t => t > pv.t - 10000);
        if (row && pv.rej.length) S.flags.rej = 1;
      }
      function vIns() {
        const pv = S.pv.ins; if (!pv) return head('Вставка и куски', '…');
        const row = rowMode(), DL = 12, LM = 20, n = pv.parts.length;
        let s = head('Вставка и куски (MergeTree)', 'каждая вставка — новый кусок на диске; фоновые слияния склеивают их в большие');
        s += R(24, 58, 452, 120, 'xo-code', 10) + T(36, 76, row ? 'СЕРВИС ПИШЕТ ПО ОДНОЙ СТРОКЕ' : 'КОНВЕЙЕР ПИШЕТ ПАЧКОЙ', 'xr-m ' + (row ? 'warn' : 'acc'));
        const L = row ? ["INSERT INTO orders VALUES (10482931, 55120, …)", "INSERT INTO orders VALUES (10482932, 80441, …)", "INSERT INTO orders VALUES (10482933, 23878, …)", '…и так 40 000 команд в секунду'] : ['INSERT INTO orders VALUES', "  (10482931, 55120, 3071, 'RU', …),", "  (10482932, 80441, 118, 'KZ', …),", '  … ещё 49 998 строк одной командой'];
        L.forEach((l, j) => { s += SQL(36, 98 + j * 18, l, 'sm'); });
        // пороги
        s += R(492, 58, 478, 120, 'xo-panel', 10) + T(506, 78, `КУСКОВ В ПАРТИЦИИ 202608: ${n}`, 'xr-m ' + (n >= LM ? 'bad' : n >= DL ? 'warn' : ''));
        const bx = 506, bw = 450;
        s += R(bx, 92, bw, 14, 'xr-bar', 4) + R(bx, 92, bw * clamp(n / (LM + 2), 0, 1), 14, 'xr-bar-f' + (n >= LM ? ' bad' : n >= DL ? ' warn' : ''), 4);
        s += Ln(bx + bw * DL / (LM + 2), 88, bx + bw * DL / (LM + 2), 110, 'xo-thr') + Ln(bx + bw * LM / (LM + 2), 88, bx + bw * LM / (LM + 2), 110, 'xo-thr bad');
        s += T(bx + bw * DL / (LM + 2), 124, 'замедление (в жизни 150)', 'xo-ms', 'middle') + T(bx + bw * LM / (LM + 2) - 4, 138, 'ошибка (300)', 'xo-ms xo-bad', 'end');
        if (pv.rej.length) s += T(506, 152, `Code: 252. Too many parts (300) — отказов за 10 с: ${pv.rej.length}`, 'xo-pn xo-bad') + T(506, 168, 'Merges are processing significantly slower than inserts.', 'xo-pn xo-bad');
        else s += T(506, 162, `за 10 с: кусков создано ${pv.inT.length}, слияний ${pv.mgT.length}, отказов 0`, 'xr-s');
        // полоса кусков
        const PX = 30, PY = 196, PW = 664;
        s += R(PX - 6, PY - 6, PW + 12, 230, 'xo-panel', 10) + T(PX + 6, PY + 12, 'шард 1 · партиция 202608 · куски на диске (новые — справа)', 'xr-m');
        const big = pv.parts.filter(p => p.rows >= 1000), tiny = pv.parts.filter(p => p.rows < 1000);
        let x = PX + 6, y = PY + 30;
        big.forEach(p => {
          const w = clamp(560 * Math.sqrt(p.rows / 1e7), 26, 420), mg = pv.mg && pv.mg.ids.includes(p.id), fl = pv.t - p.t0 < 500;
          if (x + w > PX + PW) { x = PX + 6; y += 48; }
          s += R(x, y, w, 38, 'xo-pt l' + (p.lvl >= 4 ? 3 : p.lvl >= 2 ? 2 : p.lvl >= 1 ? 1 : 0) + (mg ? ' mg' : '') + (fl ? ' fl' : ''), 4);
          if (w >= 110) s += T(x + 8, y + 16, pname('202608', p), 'xo-pn') + T(x + 8, y + 31, `${mln(p.rows)} строк`, 'xo-ms');
          else if (w >= 46) s += T(x + 6, y + 23, 'L' + p.lvl, 'xo-pn');
          x += w + 6;
        });
        if (tiny.length && PX + PW - x < 170) { x = PX + 6; y += 48; }
        const per = Math.floor((PX + PW - x) / 13) || 1;
        tiny.forEach((p, j) => {
          const mg = pv.mg && pv.mg.ids.includes(p.id), fl = pv.t - p.t0 < 400, xx = x + (j % Math.max(per, 1)) * 13, yy = y + Math.floor(j / Math.max(per, 1)) * 13;
          if (yy < PY + 210) s += R(xx, yy, 10, 10, 'xo-pt l0' + (mg ? ' mg' : '') + (fl ? ' fl' : ''), 2);
        });
        if (pv.mg) { const k = clamp((pv.t - pv.mg.t0) / (pv.mg.t1 - pv.mg.t0), 0, 1); s += T(PX + 6, PY + 214, `слияние ${pv.mg.ids.length} кусков… ${Math.round(k * 100)} %`, 'xr-s xo-acc'); }
        else if (pv.lastMg && pv.t - pv.lastMg.t0 < 1500) s += T(PX + 6, PY + 214, `готово: ${pname('202608', pv.lastMg)}`, 'xr-s xo-ok');
        // папка куска
        const lp = pv.last || pv.parts[pv.parts.length - 1], FX = 716;
        s += R(FX - 6, 190, 266, 236, 'xo-code', 10) + T(FX + 6, 210, `${pname('202608', lp)}/`, 'xr-m acc');
        const files = [['checksums.txt', ''], ['columns.txt', '22 колонки'], ['count.txt', String(lp.rows >= 1000 ? 50000 : 1)], ['primary.cidx', 'засечки ключа'], ['partition.dat', '202608'], ['minmax_created_at.idx', 'min/max'], ['order_id.bin', ''], ['order_id.cmrk2', ''], ['user_id.bin', ''], ['user_id.cmrk2', '']];
        files.forEach(([f, c], j) => { s += T(FX + 16, 230 + j * 16, f, 'xo-pn') + (c ? T(FX + 248, 230 + j * 16, c, 'xo-ms', 'end') : ''); });
        s += T(FX + 16, 230 + files.length * 16, '… ещё 40 файлов колонок', 'xo-ms') + T(FX + 6, 414, lp.rows >= 1000 ? '≈ 50 файлов на 50 000 строк' : '≈ 50 файлов ради одной строки!', 'xr-s ' + (lp.rows >= 1000 ? 'xo-ok' : 'xo-bad'));
        // пояснения
        const notes = row ? ['Каждая команда INSERT — отдельный кусок: папка и ≈ 50 файлов ради одной строки.', 'Слияния склеивают по 5–6 кусков, но новые приходят быстрее: полоска кусков ползёт к порогу.', 'Перейдёт порог — база начнёт отказывать во вставке: Too many parts.', 'Лечение: копить строки в пачки — Kafka engine, Buffer-таблица или async_insert = 1.']
          : ['Пачка в 50 000 строк — один кусок. Слияниям хватает времени: кусков всегда немного.', 'Слияние берёт соседние куски по номерам блоков и пишет один большой; уровень (последнее число) растёт.', 'Старые маленькие куски удаляются после слияния, чтения сразу идут в новый.', 'Совет ClickHouse: не чаще одной вставки в секунду, от 10–100 тыс. строк в пачке.'];
        notes.forEach((l, j) => { s += T(30, 452 + j * 22, (j + 1) + '. ' + l, 'xr-s' + (row && j === 2 ? ' xo-bad' : '')); });
        return s;
      }

      function vMv() {
        const C = 8000, cyN = Math.floor(S.vt / C), u = S.vt % C, on = !!P().mv;
        const k1 = clamp(u / 1200, 0, 1), k2 = clamp((u - 1300) / 1500, 0, 1), k3 = clamp((u - 3000) / 1300, 0, 1);
        let s = head('Материализованное представление', on ? 'включено: каждая вставка тут же пересчитывает суммы по дням и странам' : 'сейчас выключено (настройка справа) — здесь показано, как оно работало бы');
        s += R(24, 56, 952, 76, 'xo-code', 10);
        ['CREATE MATERIALIZED VIEW mv_revenue_daily', 'ENGINE = SummingMergeTree ORDER BY (day, country) AS', 'SELECT toDate(created_at) AS day, country, sum(amount) AS revenue, count() AS orders FROM orders GROUP BY day, country'].forEach((l, j) => { s += SQL(36, 76 + j * 18, l, 'sm'); });
        const B = [['2026-07-14', 'RU', 1290.00], ['2026-07-14', 'KZ', 845.50], ['2026-07-14', 'RU', 3490.00], ['2026-07-14', 'BY', 1290.00], ['2026-07-14', 'RU', 199.00]];
        s += R(24, 146, 300, 180, 'xo-panel', 10) + T(36, 166, 'ПАЧКА ВСТАВКИ → orders', 'xr-m');
        s += T(36, 186, 'created_at', 'xo-cn sm') + T(160, 186, 'country', 'xo-cn sm') + T(310, 186, 'amount', 'xo-cn sm', 'end');
        B.forEach(([d, c, a], j) => {
          const kk = clamp(k1 * 5 - j, 0, 1);
          if (kk > 0) s += `<g opacity="${f1(kk)}" transform="translate(${f1(-30 * (1 - kk))},0)">` + T(36, 208 + j * 22, d + ' 12:31', 'xo-val') + T(160, 208 + j * 22, c, 'xo-val') + T(310, 208 + j * 22, nf(a, 2), 'xo-val', 'end') + '</g>';
        });
        s += arrow(330, 236, 368, 236, k2 > 0 ? 'on' : '');
        const G = [['RU', 4979.00, 3], ['KZ', 845.50, 1], ['BY', 1290.00, 1]];
        s += R(372, 146, 250, 180, 'xo-panel' + (k2 > 0 && k2 < 1 ? ' okb' : ''), 10) + T(384, 166, 'SELECT представления', 'xr-m') + T(384, 184, 'GROUP BY day, country', 'xo-ms');
        G.forEach(([c, a, n2], j) => { const kk = clamp(k2 * 3 - j, 0, 1); if (kk > 0) s += `<g opacity="${f1(kk)}">` + T(384, 214 + j * 26, `07-14 · ${c}`, 'xo-val') + T(610, 214 + j * 26, `+${nf(a, 2)} · ${n2} шт.`, 'xr-m acc', 'end') + '</g>'; });
        if (k2 > 0) s += T(384, 306, 'из 5 строк — 3 строки сумм', 'xo-ms');
        s += arrow(628, 236, 666, 236, k3 > 0 ? 'on' : '');
        const base = [['07-13', 'RU', 18402310, 9812], ['07-13', 'KZ', 4110900, 2177], ['07-14', 'RU', 17950120, 9540], ['07-14', 'KZ', 3988410, 2091], ['07-14', 'BY', 2622030, 1418], ['07-14', 'UZ', 2145780, 1102]];
        const add = { RU: [4979, 3], KZ: [845.5, 1], BY: [1290, 1] };
        s += R(670, 146, 306, 180, 'xo-panel' + (k3 > 0 && k3 < 1 ? ' okb' : ''), 10) + T(682, 166, 'mv_revenue_daily', 'xr-m acc') + T(964, 166, '186 строк за июль', 'xo-ms', 'end');
        s += T(682, 186, 'day', 'xo-cn sm') + T(734, 186, 'country', 'xo-cn sm') + T(898, 186, 'revenue', 'xo-cn sm', 'end') + T(964, 186, 'orders', 'xo-cn sm', 'end');
        base.forEach(([d, c, r, o], j) => {
          const ad = d === '07-14' && add[c], times = cyN + (ad && k3 >= 1 ? 1 : 0), rv = r + (ad ? ad[0] * times : 0), ov = o + (ad ? ad[1] * times : 0), fl = ad && k3 >= 1 && u < 4800;
          if (fl) s += R(676, 194 + j * 21, 294, 20, 'xo-krow', 3);
          s += T(682, 208 + j * 21, d, 'xo-val') + T(734, 208 + j * 21, c, 'xo-val') + T(898, 208 + j * 21, nf(rv, 2), 'xo-val' + (fl ? ' on' : ''), 'end') + T(964, 208 + j * 21, nf(ov), 'xo-val' + (fl ? ' on' : ''), 'end');
        });
        // два пути дашборда
        const lane = (y, act, t1, q, t2, t3, cls) => R(24, y, 952, 66, 'xo-panel' + (act ? (cls === 'warn' ? ' badb' : ' on') : ' xo-off'), 10) + T(38, y + 20, t1, 'xr-t') + SQL(38, y + 40, q, 'sm') + T(38, y + 58, t2, 'xo-ms') + T(962, y + 22, t3, 'xr-m ' + cls, 'end');
        s += T(30, 352, 'КАК ДАШБОРД ПОЛУЧАЕТ «ВЫРУЧКУ ПО СТРАНАМ ЗА ИЮЛЬ»', 'xr-m');
        s += lane(362, !on, 'Без MV — по сырым строкам', "SELECT country, sum(amount) FROM orders WHERE created_at >= '2026-07-01' …", 'читает 104 млн строк × 3 колонки ≈ 458 МБ при каждом обновлении', '≈ 0,3 с · 300 раз/с = 90 с работы в секунду', 'warn');
        s += lane(436, on, 'С MV — по готовым суммам', "SELECT country, sum(revenue) FROM mv_revenue_daily WHERE day BETWEEN '2026-07-01' AND '2026-07-31' …", '31 день × 6 стран = 186 строк', '≈ 3 мс', 'ok');
        s += T(30, 528, 'Плата: каждая вставка дороже (ещё и суммы посчитать), а быстрым становится только отчёт, под который MV построено. Отчёт по городам из этой MV не получить.', 'xo-ms');
        return s;
      }

      function vPrt() {
        const C = 12500, u = S.vt % C, on = partOn(), sh = S.sh[0];
        const q = u < 3600, ret = u >= 3600 && u < 9800, k = clamp((u - 4200) / 4600, 0, 1);
        let s = head('Партиции по месяцам', on ? 'у каждого месяца свои папки на диске: запрос берёт одну, удаление — одна команда' : 'партиций нет: все месяцы в общих кусках — смотри, чем это кончается при удалении');
        s += R(24, 58, 420, 132, 'xo-code', 10);
        const DDL = on ? ['CREATE TABLE orders ( … 22 колонки … )', 'ENGINE = MergeTree', 'PARTITION BY toYYYYMM(created_at)', 'ORDER BY (country, created_at)', 'TTL created_at + INTERVAL 3 MONTH DELETE'] : ['CREATE TABLE orders ( … 22 колонки … )', 'ENGINE = MergeTree', '-- PARTITION BY нет: одна партиция all', 'ORDER BY (country, created_at)'];
        DDL.forEach((l, j) => { s += SQL(36, 80 + j * 20, l, 'sm' + (l.startsWith('--') ? ' xo-cmt' : '')); });
        // операция
        s += R(24, 202, 420, 214, 'xo-panel', 10);
        if (q) {
          s += T(38, 224, '1. ОТЧЁТ ЗА ИЮЛЬ', 'xr-m acc') + SQL(38, 246, "SELECT … FROM orders", 'sm') + SQL(38, 264, "WHERE created_at >= '2026-07-01'", 'sm') + SQL(38, 282, "  AND created_at <  '2026-08-01'", 'sm');
          s += T(38, 312, on ? 'Партиции не того месяца отброшены сразу:' : 'Партиция одна — смотрим min/max каждого куска:', 'xr-s') + T(38, 330, on ? 'их папки даже не открываются.' : 'июль лежит в двух кусках вместе с июнем и августом.', 'xr-s');
          s += T(38, 362, on ? `читаем 202607 · ${byt(JUL * NEED_ZIP / S.sh.length)} на шард` : `читаем 2 куска · ≈ ${byt(JUL * NEED_ZIP * 1.3 / S.sh.length)} на шард`, 'xr-m ' + (on ? 'ok' : 'warn'));
        } else {
          s += T(38, 224, '2. УДАЛИТЬ АПРЕЛЬ (старше 3 месяцев)', 'xr-m ' + (on ? 'ok' : 'warn'));
          if (on) {
            s += SQL(38, 248, 'ALTER TABLE orders DROP PARTITION 202604', 'sm');
            s += T(38, 278, u < 4600 ? 'удаляем папки апреля…' : 'готово за 0,02 с: папки удалены,', 'xr-s' + (u >= 4600 ? ' xo-ok' : '')) + (u >= 4600 ? T(38, 296, 'ни один байт не переписан.', 'xr-s xo-ok') : '');
            s += T(38, 330, 'Можно и без команды: TTL в описании таблицы', 'xo-ms') + T(38, 346, 'сам удалит партицию, когда ей исполнится 3 месяца.', 'xo-ms');
          } else {
            const gb = 242e6 / S.sh.length * ZIP_ROW;
            s += SQL(38, 248, 'ALTER TABLE orders DELETE', 'sm') + SQL(38, 266, "WHERE created_at < '2026-05-01'", 'sm');
            s += T(38, 296, 'Апрель лежит в одном куске с маем и июнем.', 'xr-s') + T(38, 314, 'Мутация переписывает весь кусок без апрельских строк:', 'xr-s');
            s += R(38, 326, 392, 12, 'xr-bar', 4) + R(38, 326, 392 * k, 12, 'xr-bar-f warn', 4);
            s += T(38, 356, `переписано ${byt(gb * k)} из ${byt(gb)}`, 'xr-m warn') + T(38, 376, k >= 1 ? 'готово: на настоящем диске ≈ 2–5 минут и нагрузка на шард' : 'шард занят: читает и пишет гигабайты', 'xo-ms' + (k >= 1 ? ' xo-warn' : ''));
          }
        }
        // дерево папок
        s += R(458, 58, 518, 358, 'xo-code', 10) + T(472, 78, '/var/lib/clickhouse/data/shop/orders/  (шард 1)', 'xr-m');
        let y = 100;
        const line = (txt, info, cls, st) => { const r = R(466, y - 14, 502, 20, 'xo-fold ' + (st || ''), 4) + T(476, y, txt, 'xo-pn ' + (cls || '')) + T(960, y, info, 'xo-ms', 'end'); y += 22; return r; };
        if (on) MON.slice().reverse().forEach(m => {
          const ps = sh.parts[m.id] || [], drop = ret && m.old;
          if (drop && u >= 4600) { s += line(`${m.id}_… — удалена`, '', 'xo-bad', 'gh'); return; }
          ps.slice(0, 4).forEach(p => { const st = q ? (m.jul ? 'rd' : 'sk') : drop ? 'dl' : ''; s += line(pname(m.id, p) + '/', `${mln(p.rows)} строк · ${byt(p.rows * ZIP_ROW)}`, '', st); });
          if (ps.length > 4) s += line(`… ещё ${ps.length - 4} кусков ${m.id}`, '', 'xo-dim', '');
        });
        else (sh.parts.all || []).slice(0, 12).forEach(p => {
          const ov = p.d1 >= JUL0 && p.d0 <= JUL1, mu = ret && p.d0 < MAY1, st = q ? (ov ? 'rd' : 'sk') : mu ? (k >= 1 ? 'fl' : 'mu') : '';
          s += line(pname('all', p) + (mu && k >= 1 ? '_9790' : '') + '/', `${md(mu && k >= 1 ? MAY1 : p.d0)}…${md(p.d1)} · ${byt(p.rows * ZIP_ROW)}`, '', st);
        });
        s += T(30, 446, on ? 'Партиция — это просто набор папок кусков одного месяца. Куски разных месяцев не сливаются между собой.' : 'Без партиций слияния склеивают соседние месяцы — апрель уже не отделить от мая без перезаписи.', 'xr-s');
        s += T(30, 468, 'Мелко дробить вредно: партиции по дням за годы — тысячи партиций и миллионы файлов. Обычно берут месяц.', 'xo-ms');
        s += T(30, 488, 'Чтение за июль экономят и ORDER BY с min/max (блок «Сжатие и min/max»), а партиции нужны прежде всего для удаления и обслуживания.', 'xo-ms');
        return s;
      }
      const VIEWS = { cols: vCols, comp: vComp, star: vStar, scd: vScd, mpp: vMpp, ins: vIns, mv: vMv, prt: vPrt };

      function partNow(k) {
        const n = S.sh.length;
        if (k === 'cols') return '<b>Строковая база читает страницу целиком</b> — все 22 поля каждой строки, хотя отчёту нужны три (выделены). Колоночная открывает только created_at.bin, country.bin и amount.bin и заканчивает почти сразу. Байт в 50 раз меньше — и во столько же раз быстрее.';
        if (k === 'comp') return '<b>Сжатие и пропуск блоков.</b> Словарь заменяет страну номером, RLE схлопывает повторы, а блоки по 8 192 строки помнят min и max даты. Блок, где max раньше 1 июля или min позже 31-го, пропускается — его байты даже не читаются с диска.';
        if (k === 'star') { const sc = schema(); return sc === 'obt' ? '<b>Широкая таблица:</b> всё в одной строке, JOIN не нужен. Цена — повторы: «Электроника» записана в миллионах строк, а переименование категории — это переписать таблицу.' : sc === 'snowflake' ? '<b>Снежинка:</b> у измерений свои справочники (город, категория). Повторов меньше, но отчёт склеивает уже 5 таблиц.' : '<b>Звезда:</b> строка факта несёт только ключи и числа. По ключам находятся строки измерений — дата, покупатель, товар, — и из них собирается строка отчёта.'; }
        if (k === 'scd') return '<b>SCD2 хранит историю.</b> 10 июля старая строка покупательницы закрывается (valid_to), появляется новая с ключом 1377. Заказ от 3 июля так и ссылается на 901 — Казань, поэтому выручка делится по городам честно. При перезаписи (SCD1) вся выручка «переехала» бы в Москву.';
        if (k === 'mpp') { const ph = S.pv.ph || 0; return ['<b>Раскладка:</b> строку кладут на шард по остатку от деления ключа. Строк на каждом шарде примерно поровну.', `<b>Параллельный подсчёт:</b> ${n} ${pl(n, 'шард', 'шарда', 'шардов')} читают свои строки одновременно и отправляют наверх лишь частичные суммы.`, schema() === 'obt' ? '<b>JOIN не нужен:</b> в широкой таблице город уже в строке заказа — ничего не едет по сети.' : '<b>Перемешивание:</b> заказы лежат по order_id, покупатели — по user_id. Строки заказов едут к шардам своих покупателей — это самая дорогая часть распределённого запроса.', '<b>Перекос:</b> ключ country отправляет Россию (58 %) на один шард. Он считает дольше всех, а запрос ждёт самого медленного.'][ph]; }
        if (k === 'ins') { const pv = S.pv.ins || { parts: [] }; return rowMode() ? `<b>По одной строке:</b> каждая команда — новый кусок. Сейчас в партиции ${pv.parts.length} кусков, слияния не успевают. Дойдёт до порога — база ответит Too many parts.` : `<b>Пачками:</b> одна команда — один кусок на 50 000 строк. Слияния спокойно склеивают их, кусков ${pv.parts.length}.`; }
        if (k === 'mv') return P().mv ? '<b>MV включено.</b> Пачка вставки сворачивается в суммы по (день, страна), и они тут же добавляются в mv_revenue_daily. Дашборд читает 186 строк вместо 104 млн.' : '<b>MV выключено.</b> Здесь показано, как оно работало бы: включи «Материализованные представления» справа, и дашборд на общей картинке перестанет ходить по шардам.';
        if (k === 'prt') return partOn() ? '<b>Партиции по месяцам.</b> Отчёт за июль трогает только папки 202607. Удаление апреля — DROP PARTITION: папки исчезают за доли секунды.' : '<b>Партиций нет.</b> Месяцы перемешаны в общих кусках. Удалить апрель можно только мутацией — переписать огромный кусок без апрельских строк.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.sh) return;
        const end = S.t + dt;
        S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) {
          S.vt += dt;
          if (pk === 'ins') insTick(dt);
          if (pk === 'cols' && S.pv.colsDone) done('pcols');
          if (pk === 'comp' && S.pv.zoneSkip) done('pzone');
          if (pk === 'scd' && S.pv.scdSeen) done('pscd');
        }
        // вставки
        while (S.insAt <= end) {
          S.t = Math.max(S.t, S.insAt);
          if (rowMode()) { if (S.ins.length < 70) spawnRow(); S.insAt += 85; }
          else if (S.scn === 'rows') {
            S.buf++; { const fx = SRC.x + 12 + (SRC.w - 24) * clamp(S.buf / 12, 0, 1) - 3; S.ins.push({ k: 'brow', ph: 'go', p0: S.t, dur: 260, pts: [[fx, SRC.y + 88], [fx, SRC.y + 108]] }); }
            if (S.buf >= 12) { S.buf = 0; spawnBatch(12e3); }
            S.insAt += 85;
          } else { spawnBatch(5e4); S.insAt += 1800; }
        }
        S.t = end;
        for (const r of S.ins) {
          if (r.gone || S.t < r.p0 + r.dur) continue;
          if (r.k === 'batch') { splitBatch(r); if (mvOn()) S.mvFl = S.t; }
          else if (r.k === 'brow') r.gone = true;
          else if (r.ph === 'wait') { r.ph = 'go'; land(r); }
          else land(r);
        }
        S.ins = S.ins.filter(r => !r.gone);
        S.sh.forEach(mergeStep);
        qStep(); shufStep(); dropStep();
        S.shuf = S.shuf.filter(f => S.t - f.t0 < f.dur);
        S.fx = S.fx.filter(f => S.t - f.t0 < 1300);
        S.rejT = S.rejT.filter(t => t > S.t - 10000); S.merges = S.merges.filter(t => t > S.t - 10000); S.hist = S.hist.filter(h => h.t > S.t - 15000);
        if (S.flags.rej && !rowMode() && S.cfgT > 2500) done('rows');
        if (!mvOn()) S.seenNoMv = 1;
        const mx = S.sh.reduce((m, sh) => Math.max(m, (sh.parts[curKey()] || []).length), 0);
        if (rowMode() && mx >= DELAY) note('dly', `<b>Кусков уже ${mx}</b> в одной партиции — вставки начинают ждать (кольцо у точки). Слияния не поспевают за построчной вставкой.`, 'warn', 6000);
      }
      function draw() {
        if (!S.sh) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { nbrs(); if (cfgSig() !== S.cfg) { S.cfg = cfgSig(); initParts(); S.q = null; S.qAt = S.t + 400; S.ins = []; S.shuf = []; S.drop = null; S.dropAt = S.t + 2000; } },
        scenario(id) { S.scn = id; reset(); },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (cfgSig() !== S.cfg) { S.cfg = cfgSig(); initParts(); S.q = null; S.qAt = S.t + 400; S.ins = []; S.shuf = []; S.drop = null; S.dropAt = S.t + 2000; }
          if (key === 'insert') S.pv.ins = null;
          switch (key) {
            case 'count': return +v > +prev ? `Шардов стало ${v}: каждый держит меньше строк, и полоски отчёта в подвалах шардов добегают быстрее.` : `Шардов стало ${v}: каждому достаётся больше строк — отчёт считается дольше.`;
            case 'replicas': return +v ? `У каждого шарда ${v} ${pl(+v, 'копия', 'копии', 'копий')} (тени за рамкой): отчёты делятся между ними, а падение сервера не теряет данные.` : 'Копий нет: упадёт сервер — его доля данных недоступна.';
            case 'schema': return v === 'obt' ? 'Одна широкая таблица: город, товар и дата лежат прямо в строке заказа. Проверь «JOIN по другому ключу» — перемешивание пропадёт.' : v === 'snowflake' ? 'Снежинка: у измерений появились свои справочники — в отчёте по городам JOIN стало два. Открой блок «Модель данных».' : 'Звезда: факт заказов и плоские измерения вокруг. Открой блок «Модель данных».';
            case 'mv': return v ? 'Дашборд теперь читает mv_revenue_daily — 186 готовых строк. Смотри: шарды в отчёте больше не участвуют, ответ за миллисекунды.' : 'MV выключено: дашборд снова считает по сырым строкам на всех шардах.';
            case 'partition': return v ? 'Партиции по месяцам: в каждом шарде строки 2026-04 … 2026-08, отчёт читает только июль. Проверь «Чистим старое».' : 'Партиций нет: месяцы перемешаны в общих кусках all_…, видно их диапазоны дат. Проверь «Чистим старое» — удаление станет мутацией.';
            case 'insert': return v === 'row' ? 'Построчная вставка: каждая точка — отдельный кусок. Следи за счётчиком кусков в верхней строке шардов и в значке «Вставка и куски».' : 'Пачки: одна вставка — один кусок на шард, слияния легко успевают.';
          }
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const n = S.sh.length, q = S.q, mx = S.sh.reduce((m, sh) => Math.max(m, (sh.parts[curKey()] || []).length), 0);
          if (S.scn === 'rows') {
            if (rowMode()) return `<b>Каждый заказ — отдельный INSERT и отдельный кусок.</b> Сейчас в партиции до ${mx} кусков, фоновые слияния склеивают по 5, но не успевают. ${mx >= LIMIT ? '<b>Порог пройден — вставки отклоняются (Too many parts).</b>' : mx >= DELAY ? 'Порог замедления пройден: вставки ждут.' : 'Скоро упрёмся в порог.'} В жизни при 40 000 строк в секунду это случается за доли секунды. Переключи вставку на пачки.`;
            return '<b>Сервис пишет по строке, но в буфер.</b> Строки копятся (полоска в окне источника), и раз в секунду уходят одной пачкой — один кусок на шард. Так работают Buffer-таблица, Kafka engine и async_insert. Слияниям хватает времени.';
          }
          if (S.scn === 'drop') {
            const d = S.drop;
            if (!d) return partOn() ? '<b>Скоро ежемесячная чистка:</b> удалим апрель 2026. С партициями это одна команда DROP PARTITION — смотри на нижнюю строку шардов.' : '<b>Скоро ежемесячная чистка:</b> удалим апрель 2026. Партиций нет — апрель перемешан с маем и июнем в большом куске all_1_6210_8. Смотри, что будет.';
            if (d.k === 'part') return d.ph === 'back' ? 'Апрель вернулся, чтобы показать удаление ещё раз.' : '<b>DROP PARTITION 202604.</b> Папки апреля удалены на всех шардах сразу: ничего не читается и не переписывается, ≈ 0,02 с. Вот зачем партиции: удаление старых данных — операция с папками.';
            return d.ph === 'go' ? `<b>Мутация переписывает кусок.</b> Чтобы выкинуть апрель, база читает весь большой кусок (≈ ${byt(d.gb / n)} на шард) и пишет его заново без апрельских строк. Это минуты работы дисков на каждом шарде, а отчёты в это время тормозят. Включи партиции и сравни.` : '<b>Мутация закончилась.</b> Кусок получил новое имя с номером мутации на конце (_9790). С партициями то же самое было бы удалением папки.';
          }
          if (S.scn === 'join') {
            if (schema() === 'obt') return '<b>Одна широкая таблица:</b> город покупателя лежит прямо в строке заказа, поэтому JOIN не нужен — каждый шард считает выручку по городам сам, по сети едут только итоги. Плата — повторы значений и сложные изменения.';
            if (n === 1) return '<b>Шард один</b> — заказы и покупатели лежат на одном сервере, перемешивать нечего. Но и делить работу некому. Поставь 2+ шарда, чтобы увидеть перемешивание.';
            return `<b>JOIN по другому ключу.</b> Заказы разложены по order_id, покупатели — по user_id. Чтобы склеить заказ с городом покупателя, строки заказов едут к шарду, где лежит покупатель (оранжевые точки по дугам). По сети уходит ≈ ${byt(JUL * (1 - 1 / n) * 16)} — дольше, чем само чтение. Лечится раскладкой заказов по user_id, рассылкой маленькой таблицы на все шарды или широкой таблицей.`;
          }
          if (skew()) {
            if (n === 1) return '<b>Шард один</b> — перекоса не бывает, но и параллельности нет. Поставь 2–4 шарда.';
            return `<b>Перекос по ключу.</b> Таблица разложена по стране, и Россия (58 % заказов) целиком лежит на шарде 1 — у него ${Math.round(share(0) * 100)} % строк (жёлтая рамка). Остальные шарды заканчивают быстро и ждут. Время отчёта — время самого медленного шарда, и новые шарды не помогут: Россия всё равно ляжет на один.`;
          }
          if (mvOn()) return '<b>Дашборд читает готовые суммы.</b> Материализованное представление mv_revenue_daily пересчитывается при каждой вставке, поэтому отчёт за июль берёт 186 строк и отвечает за миллисекунды. Шарды отдыхают и только принимают новые куски.';
          const ph = q ? q.ph : '';
          const base = `<b>Отчёт за июль считается на ${n > 1 ? `всех ${n} шардах сразу` : 'одном сервере'}.</b> Координатор рассылает запрос, каждый шард читает только ${partOn() ? 'партицию 2026-07' : 'куски, где есть июль (min/max дат)'} и только 3 колонки из 22, считает свои суммы по странам и отправляет наверх маленький итог. `;
          return base + (ph === 'scan' ? 'Сейчас шарды читают — голубая заливка бежит по июлю.' : ph === 'merge' ? 'Координатор складывает частичные итоги.' : `Сверху конвейер дописывает новые куски в ${partOn() ? '2026-08' : 'общую партицию'}, а фоновые слияния склеивают их.`) + (util() > 1 ? ' <b>База перегружена</b> — отчёты замедляются.' : '');
        },
        stats() {
          const n = S.sh.length, mx = S.sh.reduce((m, sh) => Math.max(m, (sh.parts[curKey()] || []).length), 0), ms = S.lastMs;
          const out = [
            [S.scn === 'join' ? 'Отчёт по городам' : 'Отчёт за июль', ms == null ? '…' : tms(ms), ms == null ? '' : ms > 400 ? 'warn' : 'ok', S.lastMv ? 'из MV, без шардов' : `${n} ${pl(n, 'шард', 'шарда', 'шардов')}${S.scn === 'join' && schema() !== 'obt' && n > 1 ? ' + перемешивание' : ''}`],
            ['Прочитано за отчёт', S.lastB == null ? '…' : S.lastMv ? '186 строк' : byt(S.lastB), '', S.lastMv ? 'готовые суммы' : 'из 95 ГБ сырых строк'],
            ['По сети', S.scn === 'join' ? byt(S.lastNet || 0) : 'итоги', S.lastNet ? 'warn' : 'ok', S.scn === 'join' ? (S.lastNet ? 'строки едут между шардами' : 'перемешивания нет') : 'шарды шлют только суммы'],
            ['Кусков в партиции', String(mx), mx >= LIMIT ? 'bad' : mx >= DELAY ? 'warn' : 'ok', `порог ${DELAY} / ${LIMIT} (в жизни 150 / 300)`],
            ['Отказов вставки', String(S.rejT.length), S.rejT.length ? 'bad' : 'ok', 'за 10 с · Too many parts'],
            ['Слияний', String(S.merges.length), '', 'за 10 с, в фоне']
          ];
          return out;
        },
        destroy() {}
      };
    }
  };
})();
