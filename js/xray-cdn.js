/* «CDN изнутри»: точки присутствия по городам, промах → источник → кэш на краю, TTL и Cache-Control, инвалидация,
   имена файлов с хешем, origin shield и склейка промахов, задержка «Москва → Владивосток», экономия трафика источника. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const byt = b => b >= 1e15 ? nf(b / 1e15, 1) + ' ПБ' : b >= 1e12 ? nf(b / 1e12, b >= 1e13 ? 0 : 1) + ' ТБ' : b >= 1e9 ? nf(b / 1e9, b >= 1e11 ? 0 : 1) + ' ГБ' : b >= 1e6 ? nf(b / 1e6, b >= 1e7 ? 0 : 1) + ' МБ' : nf(b / 1e3) + ' КБ';
  const usd = v => v >= 1000 ? '$' + nf(v / 1000, v >= 1e4 ? 0 : 1) + 'k' : '$' + nf(v);
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
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
  function arrow(x1, y1, x2, y2, c) {
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return '';
    const a = Math.atan2(y2 - y1, x2 - x1), L = 7, p = d => `${f1(x2 - L * Math.cos(a + d))},${f1(y2 - L * Math.sin(a + d))}`;
    return `<line class="xcd-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xcd-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const MONO = (x, y, t, c, a) => `<text class="xcd-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const hdr = (k, v) => `<tspan class="xcd-hk">${ES(k)}:</tspan> ${ES(v)}`;
  const HDR = (x, y, k, v, c) => `<text class="xcd-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${hdr(k, v)}</text>`;
  const km = (a, b) => { const r = Math.PI / 180, d = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(d)); };
  const rttKm = d => Math.max(2, d * 0.02);   // туда и обратно по оптике с петлями маршрута: ≈ 2 мс на 100 км

  /* ---------- города, точки присутствия, файлы ---------- */
  const CITY = [
    { id: 'msk', name: 'Москва', lon: 37.6, lat: 55.75, w: 30, pop: 'msk' }, { id: 'spb', name: 'Санкт-Петербург', lon: 30.3, lat: 59.9, w: 12, pop: 'spb' },
    { id: 'kzn', name: 'Казань', lon: 49.1, lat: 55.8, w: 6, pop: 'kzn' }, { id: 'krr', name: 'Краснодар', lon: 39.0, lat: 45.0, w: 8, pop: 'krr' },
    { id: 'ekb', name: 'Екатеринбург', lon: 60.6, lat: 56.8, w: 8, pop: 'ekb' }, { id: 'nsk', name: 'Новосибирск', lon: 82.9, lat: 55.0, w: 8, pop: 'nsk' },
    { id: 'kja', name: 'Красноярск', lon: 92.9, lat: 56.0, w: 4, pop: 'nsk' }, { id: 'ala', name: 'Алматы', lon: 76.9, lat: 43.2, w: 7, pop: 'ala' },
    { id: 'khv', name: 'Хабаровск', lon: 135.1, lat: 48.5, w: 5, pop: 'vvo' }, { id: 'vvo', name: 'Владивосток', lon: 131.9, lat: 43.1, w: 8, pop: 'vvo' }];
  const POPS = [['msk', 'MOW'], ['spb', 'LED'], ['kzn', 'KZN'], ['krr', 'KRR'], ['ekb', 'SVX'], ['nsk', 'OVB'], ['ala', 'ALA'], ['vvo', 'VVO']];
  const MSK = CITY[0];
  const FILES = [
    { k: '/img/2026/07/14/IMG_4821_1280.webp', t: 'image/webp', sz: 184233 }, { k: '/static/app.js', t: 'application/javascript', sz: 412880, app: true },
    { k: '/static/app.css', t: 'text/css', sz: 61204 }, { k: '/img/2026/07/14/IMG_0093_1280.webp', t: 'image/webp', sz: 171090 },
    { k: '/img/2026/07/13/IMG_7710_1280.webp', t: 'image/webp', sz: 203411 }, { k: '/fonts/inter-v4.woff2', t: 'font/woff2', sz: 48120 },
    { k: '/img/2026/07/12/IMG_3301_1280.webp', t: 'image/webp', sz: 166780 }, { k: '/img/2026/07/11/IMG_2207_1280.webp', t: 'image/webp', sz: 159950 }];
  const FW = FILES.map((f, i) => Math.pow(i + 1, -1.1));
  const TTLM = { min: 3000, hour: 20000, day: 60000 }, MAXAGE = { min: 60, hour: 3600, day: 86400 }, TTLS = { min: '1 минута', hour: '1 час', day: '1 сутки' };
  const CDN_HIT = { min: 0.8, hour: 0.93, day: 0.97 };
  const SLOTS = 8;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const MAP = { x: 16, y: 46, w: 686, h: 334 };
  const proj = c => [MAP.x + 34 + (c.lon - 28) * 5.75, MAP.y + 28 + (61 - c.lat) * 15.2];
  const ORG = { x: 26, y: 204, w: 156, h: 62 }, HUB = [44, 180];
  const HD = { x: 714, y: 46, w: 270, h: 194 }, LT = { x: 714, y: 248, w: 270, h: 132 };
  const LOG = { x: 16, y: 390, w: 500, h: 162 }, SAV = { x: 526, y: 390, w: 458, h: 162 };
  const popXY = id => { const c = CITY.find(x => x.id === id), [x, y] = proj(c); return [x, y - 22]; };

  SD.XRAY.cdn = {
    viewBox: '0 0 1000 560',
    cta: 'Точки присутствия по городам, промахи в источник, TTL и Cache-Control, инвалидация и имена с хешем, origin shield, задержка до Владивостока',
    dive: 'cdn',
    simple: () => ({
      an: 'Как <b>сеть складов в каждом крупном городе</b>: популярный товар держат на местном складе и привозят за час. Если его там нет, местный склад заказывает с центрального — один раз — и оставляет у себя для следующих покупателей.',
      pl: 'CDN — серверы-кэши во многих городах. Пользователь получает картинку или скрипт из ближайшего города за несколько миллисекунд. Если файла там нет (промах), сервер края сходит за ним в источник — например, в S3 в Москве — и сохранит на время жизни (TTL).'
    }),
    props: ['ttl', 'shield'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Пользователи по всей стране смотрят фото и грузят скрипты сайта. TTL и origin shield — как в настройках.' },
      { id: 'far', name: 'Пользователь во Владивостоке', note: 'Источник в Москве, до Владивостока 6 400 км. Сравни задержку с CDN и без.' },
      { id: 'deploy', name: 'Выкатили новую версию', note: 'Вышел новый app.js. Края ещё помнят старый — что увидят пользователи? Инвалидация или имена с хешем.' },
      { id: 'cold', name: 'Холодный кэш', note: 'Кэш всех краёв очистили (или открыли новые). Все запросы — промахи, и они разом идут в источник.' },
      { id: 'down', name: 'Источник упал', note: 'S3 в Москве недоступен 8 секунд из 12. Что отдают края, когда срок файла истёк?' }
    ],
    tries: [
      { id: 'ttl', text: 'Поставь TTL 1 минута, потом 1 сутки: сравни долю попаданий и число запросов в источник' },
      { id: 'far', text: 'В «Пользователе во Владивостоке» сравни задержку промаха и попадания с задержкой без CDN' },
      { id: 'stale', text: 'В «Выкатили новую версию» поймай пользователя со старым app.js, потом нажми «Purge»' },
      { id: 'hash', text: 'Там же включи имена с хешем: старые версии больше не попадаются' },
      { id: 'shield', text: 'В «Холодном кэше» включи origin shield: в источник идёт один запрос на файл вместо восьми' },
      { id: 'sie', text: 'В «Источник упал» включи stale-if-error: края отдают просроченные файлы вместо ошибки 502' },
      { id: 'phdr', text: 'Открой блок «Заголовки кэша» и дождись ответа 304 Not Modified' }
    ],
    parts: {
      pop: {
        name: 'Точки присутствия', knobs: [],
        an: 'Как <b>отделения почты в каждом городе</b>: письмо идёт в ближайшее, а не через всю страну. Какое отделение ближе — решает адрес.',
        pl: 'У CDN серверы в десятках городов — точки присутствия (PoP). Один и тот же адрес cdn.example.ru приводит каждого пользователя в ближайшую точку: через DNS, который отвечает разным городам разными адресами, или через Anycast, когда один IP-адрес объявлен во многих местах.',
        how: ['Браузер спрашивает DNS: cdn.example.ru → какой IP?', '<b>GeoDNS</b>: DNS CDN смотрит, откуда пришёл вопрос, и отвечает адресом ближайшей точки.', '<b>Anycast</b>: один IP объявлен из всех городов, сеть сама доставляет пакет в ближайший по маршруту.', 'TCP и TLS заканчиваются в точке присутствия — рукопожатия идут на 5 мс, а не на 130.', 'Красноярск попадает в Новосибирск, Хабаровск — во Владивосток: точек меньше, чем городов.', 'Точка упала — DNS или маршрутизация уводят пользователей в соседнюю.'],
        watch: 'Точки — пользователи в городах. Каждый идёт в свою точку присутствия (прямоугольник с кодом аэропорта). Линии к Москве — промахи, которые идут в источник.',
        real: 'Cloudflare — 300+ городов, CloudFront — 600+ точек, у российских CDN (NGENIX, CDNvideo, Selectel, VK Cloud) — десятки городов. Anycast использует Cloudflare, GeoDNS — многие другие, часто вместе.'
      },
      cache: {
        name: 'Кэш на краю', knobs: ['ttl'],
        an: 'Как <b>витрина в отделении</b>: самое ходовое лежит на полке, остальное везут со склада. Место на витрине ограничено — залежавшееся убирают.',
        pl: 'Каждая точка держит свой кэш: файл по ключу (обычно URL). Если файл есть и срок не вышел — отдаёт сразу (HIT). Нет или вышел — идёт в источник (MISS), отдаёт и кладёт к себе. Места мало — вытесняется то, что давно не спрашивали.',
        how: ['Ключ кэша — схема, хост и путь: https://cdn.example.ru/img/…/IMG_4821_1280.webp. Иногда плюс часть параметров и заголовков (Vary).', 'Нашли и срок не вышел → HIT: отдать сразу, заголовок Age — сколько файл уже лежит.', 'Нет файла → MISS: запрос в источник, ответ отдать пользователю и сохранить.', 'Срок вышел → проверка в источнике (If-None-Match): не изменился — 304, продлеваем срок, байты не везём.', 'Кэш у каждой точки свой: файл, популярный в Москве, может ни разу не попасть во Владивосток.', 'Места не хватает — вытесняется давно не нужное (LRU и похожие алгоритмы).'],
        watch: 'В каждой точке шесть ячеек: цвет — файл, полоска — сколько ему осталось жить. Вспышка — попадание или новый файл после промаха.',
        real: 'Попаданий у статики обычно 90–98 %. Cloudflare и CloudFront хранят файл не дольше TTL, но могут вытеснить и раньше, если его редко спрашивают. Вручную задаётся через Cache-Control или правила CDN.'
      },
      headers: {
        name: 'Заголовки кэша', knobs: ['ttl'],
        an: 'Как <b>срок годности и номер партии на упаковке</b>: срок говорит, сколько можно не перепроверять, а номер партии — тот ли это товар, что сейчас на заводе.',
        pl: 'Кэшировать или нет и сколько — решают HTTP-заголовки ответа источника. Cache-Control задаёт срок, ETag — отпечаток версии файла. По отпечатку край спрашивает «изменилось ли?» и получает короткое «нет» (304) вместо всего файла.',
        how: ['<b>Cache-Control: public, max-age=3600</b> — любой кэш может хранить час.', '<b>s-maxage</b> — отдельный срок только для CDN; <b>no-store</b> — не хранить нигде; <b>private</b> — только браузер, не CDN.', '<b>ETag: "9b2cf535…"</b> — отпечаток содержимого. Срок вышел → If-None-Match: "9b2cf535…".', 'Файл не изменился → <b>304 Not Modified</b>: пара сотен байт вместо мегабайта, срок продлён.', '<b>Age</b> в ответе — сколько секунд файл уже лежит в кэше; <b>X-Cache: HIT/MISS</b> — откуда ответ.', '<b>stale-while-revalidate</b> и <b>stale-if-error</b> разрешают отдавать просроченное, пока идёт проверка или пока источник лежит.'],
        watch: 'Справа сверху — заголовки последнего ответа края пользователю. Внутри блока — диалог края с источником: первый запрос, проверка по ETag и ответ 304.',
        real: 'RFC 9111 (HTTP Caching). Для статики с хешем в имени: Cache-Control: public, max-age=31536000, immutable. Для HTML: no-cache (хранить, но каждый раз проверять) или короткий s-maxage.'
      },
      purge: {
        name: 'Инвалидация', knobs: ['ttl'],
        an: 'Как <b>отзыв партии товара</b>: всем отделениям рассылают «снять с полки», но доходит не мгновенно, и пока рассылка идёт, кто-то ещё успевает купить старое.',
        pl: 'Файл поменяли в источнике, а края помнят старый до конца TTL. Инвалидация (purge) — команда CDN «забыть этот путь». Она расходится по всем точкам за секунды–минуты, и после неё каждая точка один раз сходит в источник за свежим.',
        how: ['Деплой: новый app.js лежит в источнике под тем же именем /static/app.js.', 'Края с TTL сутки будут отдавать старый файл ещё до суток.', 'Новый HTML + старый app.js у части пользователей = сломанная страница.', 'Purge /static/app.js рассылается по точкам: CloudFront — до пары минут, Cloudflare — секунды.', 'После purge каждая точка промахивается один раз — короткий всплеск запросов в источник.', 'Purge стоит денег и лимитирован (CloudFront: 1 000 путей в месяц бесплатно). Поэтому статику лучше версионировать.'],
        watch: 'В «Выкатили новую версию» красные ячейки — старый app.js на краях. Кнопка «Purge» запускает волну по точкам; пользователи, попавшие на старую версию, отмечены красным в журнале.',
        real: 'aws cloudfront create-invalidation --paths "/static/app.js"; Cloudflare: Purge by URL, по тегу или всё. Инвалидация по маске "/static/*" удобна, но выкидывает и неизменённые файлы.'
      },
      version: {
        name: 'Имена с хешем', knobs: ['ttl'],
        an: 'Как <b>новое издание книги с новым ISBN</b>: старое и новое никогда не перепутать, и старые экземпляры не надо изымать — их просто перестают заказывать.',
        pl: 'Сборщик фронтенда добавляет в имя файла отпечаток содержимого: app.4f9c2e1.js. Поменялся код — поменялось имя. HTML ссылается на новое имя, и края просто кэшируют новый файл. Старый никому не нужен и уйдёт сам. Такой файл можно хранить «вечно».',
        how: ['Vite, webpack, esbuild: app.[contenthash].js → app.4f9c2e1.js.', 'Cache-Control для таких файлов: public, max-age=31536000, immutable — год, без перепроверок.', 'HTML не версионируют: ему короткий TTL или no-cache, он и ссылается на новые имена.', 'Деплой: сначала выложить новые файлы, потом новый HTML. Старый HTML всё ещё ссылается на старые файлы — их не удаляют сразу.', 'Никаких purge и никакой смеси версий у пользователя.', 'Минус один: первый запрос каждого нового файла — промах в каждой точке.'],
        watch: 'В «Выкатили новую версию» включи «имена с хешем»: вместо замены содержимого появляется новый ключ, старые ячейки просто доживают, ни одного пользователя со старым app.js.',
        real: 'Так делают почти все сайты: React, Vue, Angular из коробки. Картинкам часто добавляют версию в путь (/img/v3/…) или параметр (?v=…), если CDN включает параметры в ключ кэша.'
      },
      shield: {
        name: 'Origin shield', knobs: ['shield'],
        an: 'Как <b>региональный склад между заводом и магазинами</b>: восемь магазинов заказывают одно и то же — региональный склад привозит с завода одну партию и раздаёт всем.',
        pl: 'Без щита каждая точка при промахе сама идёт в источник: 8 точек — 8 одинаковых запросов. Origin shield — промежуточный слой кэша рядом с источником. Промахи всех краёв идут в него, и в источник уходит один запрос на файл. Плюс одинаковые одновременные промахи склеиваются.',
        how: ['Край промахнулся → идёт не в источник, а в щит (обычно в том же регионе, что и источник).', 'Щит — тоже кэш: если файл у него есть, источник вообще не трогают.', 'Нет и у щита — щит идёт в источник один раз, остальные края ждут его ответ (request collapsing).', 'В источник приходит в 2–8 раз меньше запросов, особенно после purge и при холодном кэше.', 'Плата: лишний шаг при промахе (+5–20 мс) и доплата за запросы через щит.', 'Склейка одинаковых промахов работает и внутри одной точки: сто одновременных запросов файла — один поход в источник.'],
        watch: 'Ромб у Москвы — щит. В «Холодном кэше» без щита к источнику тянутся линии от всех точек, со щитом — только от ромба. Счётчик в окне источника — запросов в секунду.',
        real: 'CloudFront Origin Shield, Cloudflare Tiered Cache, Fastly Shielding. На площадке щит снижает запросы в источник в 2,5 раза (0,4 от промахов).'
      },
      latency: {
        name: 'Задержка и расстояние', knobs: [],
        an: 'Как <b>разговор через переводчика на другом конце страны</b>: каждое «алло — слышу» занимает время, а для первого слова нужно три таких обмена.',
        pl: 'Скорость света в оптике — ≈ 200 км за миллисекунду, и маршрут никогда не прямой. До Владивостока ответ идёт ≈ 130 мс туда и обратно. Чтобы получить первый файл по HTTPS, нужно три таких обмена: TCP, TLS и сам запрос. CDN делает все три в соседнем здании.',
        how: ['RTT — время «туда и обратно». Москва → Владивосток: 6 400 км по прямой, ≈ 130 мс по реальной сети.', 'Новое соединение: TCP-рукопожатие (1 RTT) + TLS 1.3 (1 RTT) + запрос и ответ (1 RTT) = 3 RTT.', 'Без CDN: 3 × 130 = 390 мс до первого байта, плюс ответ источника.', 'С CDN и попаданием: 3 × 5 мс = 15 мс — всё делает точка во Владивостоке.', 'С CDN и промахом: 15 мс + один RTT края до Москвы по уже открытому соединению + ответ источника ≈ 170 мс.', 'Поэтому важна доля попаданий: она решает, сколько пользователей получают 15 мс, а сколько — 170.'],
        watch: 'Справа — три полосы для выбранного города: без CDN, с CDN при промахе и при попадании. Внутри блока — те же три варианта по шагам рукопожатия.',
        real: 'Скорость света в стекле — ≈ 2/3 от скорости в вакууме. Москва — Новосибирск ≈ 50 мс RTT, Москва — Владивосток ≈ 120–150 мс. HTTP/3 (QUIC) объединяет TCP и TLS и экономит один RTT.'
      },
      savings: {
        name: 'Попадания и экономия', knobs: ['ttl', 'shield'],
        an: 'Как <b>местный склад, который берёт на себя почти всех покупателей</b>: центральный склад видит только заказы, которых на местных не было.',
        pl: 'Доля попаданий (hit ratio) показывает, сколько запросов край отдал сам. Всё остальное доходит до источника. 93 % попаданий — источник получает 7 % запросов и 7 % трафика. Длиннее TTL и щит — меньше нагрузка и счёт за трафик источника.',
        how: ['Hit ratio = попадания / все запросы. Для статики хороший уровень — 90–98 %.', 'Запросы в источник = все запросы × (1 − hit ratio), со щитом — ещё в 2–3 раза меньше.', 'Трафик источника падает так же: S3 берёт ≈ $0,09 за каждый ГБ наружу.', 'Короткий TTL — свежее, но больше промахов. Длинный — меньше промахов, но изменения доходят дольше.', 'Редкие файлы (длинный хвост) почти всегда промахи — их доля и ограничивает hit ratio.', 'Байтовый hit ratio важнее запросного: видео и большие картинки весят больше скриптов.'],
        watch: 'Справа внизу — доля попаданий за 10 с, запросы в источник в секунду (по нагрузке площадки) и сэкономленный трафик источника за месяц.',
        real: 'CDN_HIT в площадке: TTL 1 минута — 80 %, 1 час — 93 %, сутки — 97 %. CloudFront берёт ≈ $0,085 за ГБ, но трафик S3 → CloudFront бесплатный.'
      }
    },
    legend: [['read', 'Запрос пользователя'], ['ok', 'Ответ из кэша края (HIT)'], ['warn', 'Промах: запрос в источник'], ['accent', 'Origin shield'], ['sq xcd-sw0', 'Файл в кэше точки'], ['sq xcd-sws', 'Устаревшая версия файла'], ['bad', 'Ошибка 502, старая версия у пользователя']],
    live: (n, r) => {
      const l = r.load || {}, st = l.static || 0, h = CDN_HIT[n.props.ttl] || 0.93;
      return [['Запросов', SD.fmt.num(st) + '/с', ''], ['Попаданий', Math.round(h * 100) + ' %', h >= 0.9 ? 'ok' : 'warn'], ['TTL', TTLS[n.props.ttl] || '1 час', ''], ['Shield', n.props.shield ? 'да' : 'нет', '']];
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xcdSt"></g><g id="xcdDy" class="xcd-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xcdSt'), gDy = ctx.svg.querySelector('#xcdDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {}, opt: { hash: false, sie: false } };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 8) S.fx.shift(); };
      const ttl = () => P().ttl || 'hour', shield = () => !!P().shield;
      const TTL = () => S.scn === 'cold' ? Math.max(TTLM[ttl()], 20000) : TTLM[ttl()];
      const origin = () => { const o = ctx.outs().map(x => x.n); return o.find(k => k.type === 'objstore') || o[0] || null; };
      const stRps = () => (ctx.res.load || {}).static || 0;
      const keyOf = f => f.app && S.opt.hash ? `/static/app.${S.appHash}.js` : f.k;
      const fileByKey = k => FILES.find(f => keyOf(f) === k) || FILES[1];

      /* ---------- состояние ---------- */
      function reset() {
        Object.assign(S, { t: 0, reqs: [], fx: [], at: 300, log: [], ev: [], org: [], cache: {}, sh: {}, ver: {}, appHash: '4f9c2e1', pTail: 0.12, depAt: 2500, depT: 0, purge: null, coldAt: 1200, downAt: 2200, down: false, last: null, cfgT: 0, staleUsers: 0 });
        POPS.forEach(([id]) => { S.cache[id] = []; });
        FILES.forEach(f => { S.ver[f.k] = 1; });
        if (S.scn !== 'cold') warm();
        S.cfg = S.scn;
      }
      function warm() {   // края прогреты: популярные файлы уже лежат
        POPS.forEach(([id], pi) => FILES.slice(0, 5).forEach((f, i) => { if (Math.random() < 0.9 - i * 0.08) put(id, keyOf(f), S.ver[f.k], -Math.random() * TTL() * 0.8); }));
        FILES.slice(0, 6).forEach(f => { S.sh[keyOf(f)] = { exp: S.t + TTL() * 0.5, ver: S.ver[f.k] }; });
      }
      function put(id, key, ver, age) {
        const c = S.cache[id], i = c.findIndex(e => e.key === key);
        if (i >= 0) c.splice(i, 1);
        c.unshift({ key, ver, t0: S.t + (age || 0), exp: S.t + (age || 0) + TTL(), last: S.t, fl: S.t });
        if (c.length > SLOTS) { c.sort((a, b) => b.last - a.last); c.length = SLOTS; }
      }
      const pickFile = () => { if (S.scn === 'deploy' && Math.random() < 0.45) return FILES[1]; let s = FW.reduce((a, b) => a + b, 0), x = Math.random() * s; for (let i = 0; i < FILES.length; i++) { x -= FW[i]; if (x <= 0) return FILES[i]; } return FILES[0]; };
      const pickCity = () => { if (S.scn === 'far' && Math.random() < 0.5) return CITY.find(c => c.id === 'vvo'); let s = CITY.reduce((a, c) => a + c.w, 0), x = Math.random() * s; for (const c of CITY) { x -= c.w; if (x <= 0) return c; } return CITY[0]; };

      /* ---------- запросы ---------- */
      const orgTop = [ORG.x + ORG.w / 2, ORG.y];
      function spawn() {
        const c = pickCity(), f = pickFile(), tail = Math.random() < S.pTail;
        const key = tail ? `/img/2025/${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}/IMG_${1000 + Math.floor(Math.random() * 9000)}_1280.webp` : keyOf(f);
        const [cx, cy] = proj(c), pp = popXY(c.pop);
        S.reqs.push({ c, pop: c.pop, key, f: tail ? FILES[0] : f, tail, ph: 'in', p0: S.t, dur: 380, pts: [[cx + (Math.random() - 0.5) * 16, cy + 6 + Math.random() * 6], pp] });
      }
      function atPop(r) {
        const ce = S.cache[r.pop].find(e => e.key === r.key), now = S.t;
        if (ce && ce.exp > now) {   // HIT
          ce.last = now; ce.fl = now; r.res = 'hit'; r.age = (now - ce.t0) / TTL() * MAXAGE[ttl()]; r.ver = ce.ver; back(r); return;
        }
        if (S.down) {
          if (ce && S.opt.sie) { r.res = 'stale'; r.ver = ce.ver; r.age = (now - ce.t0) / TTL() * MAXAGE[ttl()]; back(r); S.flags.sie = 1; note('sie', '<b>stale-if-error:</b> источник лежит, срок файла вышел, но край отдал просроченную копию. Пользователь ничего не заметил.', 'ok', 5000); if (S.scn === 'down') done('sie'); return; }
          r.res = 'err'; back(r); pop(popXY(r.pop)[0], popXY(r.pop)[1] - 18, '502', 'bad'); note('502', `<b>502 Bad Gateway:</b> у края ${popCode(r.pop)} срок файла вышел, а источник не отвечает. ${S.opt.sie ? '' : 'Включи stale-if-error — край отдал бы старую копию.'}`, 'bad', 5000); return;
        }
        r.res = ce ? 'reval' : 'miss';
        const coll = S.reqs.find(x => x !== r && x.pop === r.pop && x.key === r.key && (x.ph === 'toOrg' || x.ph === 'atOrg' || x.ph === 'toSh' || x.ph === 'fromOrg'));
        if (coll) { r.ph = 'wait'; r.waitFor = coll; r.p0 = now; r.dur = 1e9; r.res = 'collapsed'; return; }
        const pp = popXY(r.pop);
        if (shield()) { r.ph = 'toSh'; r.p0 = now; r.dur = 520; r.pts = [pp, HUB]; }
        else { r.ph = 'toOrg'; r.p0 = now; r.dur = 650; r.pts = [pp, orgTop]; S.org.push(now); }
      }
      function atShield(r) {
        const se = S.sh[r.key];
        if (se && se.exp > S.t) { r.shHit = true; r.ver = se.ver; r.ph = 'fromOrg'; r.p0 = S.t; r.dur = 520; r.pts = [HUB, popXY(r.pop)]; return; }
        const coll = S.reqs.find(x => x !== r && x.key === r.key && x.viaSh && (x.ph === 'toOrg2' || x.ph === 'atOrg'));
        r.viaSh = true;
        if (coll) { r.ph = 'shWait'; r.waitFor = coll; r.p0 = S.t; r.dur = 1e9; S.flags.coll = 1; return; }
        r.ph = 'toOrg2'; r.p0 = S.t; r.dur = 260; r.pts = [HUB, orgTop]; S.org.push(S.t);
      }
      function atOrigin(r) {
        r.ph = 'atOrg'; r.p0 = S.t; r.dur = 260;
        const ver = r.tail ? 1 : S.ver[fileByKey(r.key).k] || 1;
        r.ver = ver; r.notMod = r.res === 'reval' && !r.tail && (S.cache[r.pop].find(e => e.key === r.key) || {}).ver === ver;
      }
      function fromOrigin(r) {
        if (r.viaSh) { S.sh[r.key] = { exp: S.t + TTL(), ver: r.ver }; r.ph = 'fromOrg'; r.p0 = S.t; r.dur = 520; r.pts = [orgTop, HUB, popXY(r.pop)]; }
        else { r.ph = 'fromOrg'; r.p0 = S.t; r.dur = 650; r.pts = [orgTop, popXY(r.pop)]; }
        S.reqs.forEach(x => { if (x.ph === 'shWait' && x.waitFor === r) { x.ver = r.ver; x.ph = 'fromOrg'; x.p0 = S.t; x.dur = 520; x.pts = [HUB, popXY(x.pop)]; x.shHit = true; } });
      }
      function arriveEdge(r) {
        put(r.pop, r.key, r.ver, 0); r.age = 0;
        if (r.notMod) { S.flags.n304 = (S.flags.n304 || 0) + 1; }
        back(r);
      }
      function back(r) {
        const pp = popXY(r.pop), [cx, cy] = proj(r.c);
        r.ph = 'out'; r.p0 = S.t; r.dur = 380; r.pts = [pp, [cx, cy + 8]];
        finish(r);
        // кто ждал этот же файл (склейка промахов) — получает тот же ответ
        S.reqs.forEach(x => { if ((x.ph === 'wait' || x.ph === 'shWait') && x.waitFor === r) { x.ver = r.ver; x.age = 0; if (r.res === 'err') x.res = 'err'; else if (x.ph === 'shWait') { x.ph = 'fromOrg'; x.p0 = S.t; x.dur = 520; x.pts = [HUB, popXY(x.pop)]; x.shHit = true; return; } back(x); } });
      }
      function finish(r) {
        const f = r.f, edge = rttKm(km(r.c, CITY.find(c => c.id === r.pop))) + 2, toO = rttKm(km(CITY.find(c => c.id === r.pop), MSK));
        let ms = 3 * edge + 1;
        if (r.res === 'miss' || r.res === 'reval' || r.res === 'collapsed') ms += (shield() ? toO + 4 : toO) + (r.shHit ? 0 : 30);
        if (r.res === 'err') ms += 3000;
        r.ms = ms;
        const old = f.app && !S.opt.hash && !r.tail && (r.ver || 1) < S.ver[f.k];
        if (old) { r.old = true; S.staleUsers++; S.flags.oldSeen = 1; note('old', `<b>${r.c.name}: пользователь получил старый app.js</b> из кэша ${popCode(r.pop)}, а HTML уже новый — страница может сломаться. TTL ${TTLS[ttl()]}: края будут отдавать старое до конца срока.`, 'bad', 4000); }
        S.ev.push({ t: S.t, k: r.res === 'hit' || r.res === 'stale' ? 'hit' : r.res === 'err' ? 'err' : 'miss', old, ms, bytes: r.notMod ? 300 : (r.res === 'hit' || r.res === 'stale' ? 0 : f.sz) });
        S.log.unshift({ c: r.c.name, pop: popCode(r.pop), key: r.key, res: r.res, ms, age: r.age || 0, old, t: S.t }); if (S.log.length > 6) S.log.pop();
        S.last = { r, t: S.t };
      }
      const popCode = id => (POPS.find(p => p[0] === id) || ['', '?'])[1];
      function step(r) {
        if (S.t < r.p0 + r.dur) return;
        if (r.ph === 'in') return atPop(r);
        if (r.ph === 'toSh') return atShield(r);
        if (r.ph === 'toOrg' || r.ph === 'toOrg2') { if (S.down) { r.res = 'err'; back(r); return; } return atOrigin(r); }
        if (r.ph === 'atOrg') return fromOrigin(r);
        if (r.ph === 'fromOrg') return arriveEdge(r);
        if (r.ph === 'out') { r.gone = true; }
      }

      /* ---------- ситуации ---------- */
      function scnStep() {
        if (S.scn === 'deploy' && !S.depAt && S.t - S.depT > 12000) S.depAt = S.t;   // следующий деплой
        if (S.scn === 'deploy' && S.depAt && S.t >= S.depAt) {
          S.depAt = 0; S.depT = S.t; S.ver[FILES[1].k]++;
          if (S.opt.hash) { S.appHash = (0x1000000 + Math.floor(Math.random() * 0xeffffff)).toString(16).slice(0, 7); S.flags.hashDep = S.t; note('dep', `<b>Деплой с хешем:</b> новый файл называется app.${S.appHash}.js, новый HTML ссылается на него. Края его ещё не видели — один промах на точку, и никаких старых версий.`, 'ok', 0); }
          else note('dep', '<b>Деплой:</b> в источнике лежит новый /static/app.js под тем же именем. Края помнят старый ещё до конца TTL — часть пользователей получит старый скрипт с новым HTML.', 'warn', 0);
        }
        if (S.scn === 'cold' && S.t >= S.coldAt) {
          S.coldAt = S.t + 13000; POPS.forEach(([id]) => { S.cache[id] = []; }); S.sh = {};
          note('cold', `<b>Кэш всех краёв пуст</b> (purge всего или новые точки). Каждый первый запрос — промах. ${shield() ? 'Щит собирает промахи и ходит в источник один раз на файл.' : 'Без щита каждая из 8 точек сама идёт в источник за одним и тем же.'}`, 'warn', 0);
        }
        if (S.scn === 'down') {
          if (!S.down && S.t >= S.downAt) { S.down = true; S.upAt = S.t + 8000; note('dn', '<b>Источник (S3 в Москве) не отвечает.</b> Свежие файлы края отдают как обычно, а у кого срок вышел — тем идти некуда.', 'bad', 0); }
          if (S.down && S.t >= S.upAt) { S.down = false; S.downAt = S.t + 4000; note('up', '<b>Источник поднялся.</b> Края снова обновляют просроченные файлы.', 'ok', 0); }
        }
        const pu = S.purge;
        if (pu) {
          const k = (S.t - pu.t0) / 2600;
          POPS.forEach(([id], i) => { if (!pu.done[id] && k >= (i + 1) / POPS.length) { pu.done[id] = 1; S.cache[id] = S.cache[id].filter(e => !pu.keys.includes(e.key)); } });
          if (k >= 1) { S.purge = null; note('pd', `<b>Инвалидация завершена:</b> все 8 точек забыли ${pu.keys.length > 1 ? 'весь кэш' : ES(pu.keys[0])}. Следующие запросы — промахи, каждая точка один раз сходит в источник за свежим.`, 'ok', 0); if (S.flags.oldSeen) done('stale'); }
        }
      }
      function purge(all) {
        const keys = all ? [...new Set(Object.values(S.cache).flat().map(e => e.key))] : [keyOf(FILES[1])];
        S.purge = { t0: S.t, keys, done: {} };
        ctx.log(`<b>Purge ${all ? 'всего кэша' : ES(keys[0])}:</b> команда расходится по точкам присутствия — в жизни от секунд до пары минут.`, 'chg');
      }

      /* ---------- кнопки на картинке ---------- */
      const btn = (x, y, w, k, label, on) => `<g class="xcd-btn${on ? ' on' : ''}" data-xcd="${k}" tabindex="0" role="button"><rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="22" rx="11"/><text x="${f1(x + w / 2)}" y="${f1(y + 15)}">${label}</text></g>`;
      function onClick(e) {
        const b = e.target.closest('[data-xcd]'); if (!b) return;
        const k = b.dataset.xcd;
        if (k === 'purge') purge(false);
        if (k === 'hash') { S.opt.hash = !S.opt.hash; ctx.log(`<b>Имена с хешем ${S.opt.hash ? 'включены' : 'выключены'}.</b> ${S.opt.hash ? `app.js теперь называется app.${S.appHash}.js: новая версия — новое имя. Через пару секунд — следующий деплой.` : 'Файл снова называется /static/app.js.'}`, 'chg'); if (S.scn === 'deploy' && S.opt.hash && !S.depAt) S.depAt = S.t + 2500; }
        if (k === 'sie') { S.opt.sie = !S.opt.sie; ctx.log(`<b>stale-if-error ${S.opt.sie ? 'включён' : 'выключен'}.</b> ${S.opt.sie ? 'Cache-Control: max-age=…, stale-if-error=86400 — если источник лежит, край отдаёт просроченную копию.' : 'Источник лежит — просроченные файлы будут ошибками 502.'}`, 'chg'); }
        e.stopPropagation();
      }
      function onKey(e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-xcd]')) { e.preventDefault(); onClick(e); } }
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- счёт ---------- */
      function counts() {
        const c = { hit: 0, miss: 0, err: 0, old: 0, ms: 0, n: 0, bytes: 0 };
        S.ev.forEach(e => { c[e.k]++; if (e.old) c.old++; c.ms += e.ms; c.n++; c.bytes += e.bytes; });
        c.hr = c.n ? c.hit / c.n : 0; c.avg = c.n ? c.ms / c.n : 0;
        return c;
      }
      function real() {
        const st = stRps(), h = CDN_HIT[ttl()] || 0.93, sh = shield() ? 0.4 : 1, o = origin(), avg = 2e5;
        const orgRps = st * (1 - h) * sh;
        return { st, h, orgRps, saved: (st - orgRps) * avg * 2.63e6 / 1e9 * 0.09, total: st * avg * 2.63e6 / 1e9 * 0.09, o };
      }

      /* ---------- отрисовка общей картинки ---------- */
      function badges() {
        const bs = [['pop', 'ТОЧКИ ПРИСУТСТВИЯ', `${POPS.length} городов`], ['purge', 'ИНВАЛИДАЦИЯ', S.purge ? 'идёт purge…' : 'забыть путь на краях'], ['version', 'ИМЕНА С ХЕШЕМ', S.opt.hash ? 'включены' : 'app.[hash].js'], ['shield', 'ORIGIN SHIELD', shield() ? 'включён' : 'выключен']];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xcd-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xcd-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xcd-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s')}</g>`; });
        return s;
      }
      function mapSvg() {
        let s = `<g class="xr-part" data-xpart="pop">${R(MAP.x, MAP.y, MAP.w, MAP.h, 'xr-zone', 14)}</g>`;
        for (let lat = 50; lat <= 60; lat += 5) { const y = MAP.y + 28 + (61 - lat) * 15.2; s += Ln(MAP.x + 8, y, MAP.x + MAP.w - 8, y, 'xcd-grid') + T(MAP.x + MAP.w - 10, y - 3, `${lat}° с. ш.`, 'xcd-ms', 'end'); }
        s += T(MAP.x + 12, MAP.y + MAP.h - 12, 'ТОЧКИ ПРИСУТСТВИЯ CDN', 'xr-m acc') + T(MAP.x + 188, MAP.y + MAP.h - 12, `TTL ${TTLS[ttl()]}${shield() ? ' · щит в Москве' : ''}${S.down ? ' · источник не отвечает' : ''}`, 'xr-s' + (S.down ? ' xcd-bad' : ''));
        // линии в источник
        POPS.forEach(([id]) => { const p = popXY(id); s += Ln(p[0], p[1] + 13, shield() ? HUB[0] : orgTop[0], shield() ? HUB[1] : orgTop[1], 'xcd-link' + (shield() ? ' sh' : '')); });
        if (shield()) s += Ln(HUB[0], HUB[1], orgTop[0], orgTop[1], 'xcd-link main');
        // города
        CITY.forEach(c => { const [x, y] = proj(c); s += `<circle class="xcd-city" cx="${f1(x)}" cy="${f1(y)}" r="${2.5 + c.w / 8}"/>` + T(x, y + 18, c.name, 'xcd-cn', 'middle'); });
        // источник и щит
        const o = origin(), og = o && ctx.canGo(o.id), orq = S.org.filter(t => t > S.t - 2000).length / 2;
        s += `<g${og ? ` class="xr-go" data-xgo="${o.id}"` : ''}>${R(ORG.x, ORG.y, ORG.w, ORG.h, 'xr-box' + (S.down ? ' bad' : orq > 2.5 ? ' hot' : ''), 10)}`;
        s += T(ORG.x + 10, ORG.y + 18, ES(cut(o ? ctx.nm(o.id) : 'Источник', 20)), 'xr-t xcd-nh') + T(ORG.x + 10, ORG.y + 35, S.down ? 'не отвечает!' : `Москва · ${shield() ? 'через щит' : 'щита нет'}`, 'xcd-ms' + (S.down ? ' xcd-bad' : ''));
        s += T(ORG.x + 10, ORG.y + 53, `${nf(orq, 1)} запроса/с в модели`, 'xr-m' + (orq > 2.5 ? ' warn' : '')) + '</g>';
        s += `<g class="xr-part" data-xpart="shield"><polygon class="xcd-hub${shield() ? ' on' : ''}" points="${HUB[0]},${HUB[1] - 11} ${HUB[0] + 11},${HUB[1]} ${HUB[0]},${HUB[1] + 11} ${HUB[0] - 11},${HUB[1]}"/></g>`;
        // точки присутствия
        POPS.forEach(([id, code]) => {
          const [x, y] = popXY(id), c = S.cache[id], pu = S.purge && !S.purge.done[id];
          s += `<g class="xr-part" data-xpart="cache">${R(x - 30, y - 13, 60, 27, 'xcd-pop' + (pu ? ' pu' : ''), 6)}${T(x - 25, y - 2, code, 'xcd-code')}`;
          for (let j = 0; j < SLOTS; j++) {
            const e = c[j], sx = x - 26 + j * 6.7, sy = y + 3;
            if (!e) { s += R(sx, sy, 5.4, 7, 'xcd-slot e', 1.2); continue; }
            const fi = FILES.findIndex(f => keyOf(f) === e.key), exp = e.exp <= S.t, old = fi === 1 && !S.opt.hash && e.ver < S.ver[FILES[1].k], fl = S.t - e.fl < 400;
            s += `<rect class="xcd-slot${exp ? ' x' : ''}${old ? ' old' : ''}${fl ? ' fl' : ''}" x="${f1(sx)}" y="${f1(sy)}" width="5.4" height="7" rx="1.2" style="fill:${fi >= 0 ? `var(--k-${['read', 'job', 'static', 'write', 'upload', 'search', 'msg', 'geo'][fi]})` : 'var(--text-muted)'}"/>`;
          }
          s += '</g>';
        });
        if (S.scn === 'deploy') s += btn(MAP.x + MAP.w - 290, MAP.y + MAP.h - 32, 136, 'hash', S.opt.hash ? '✓ имена с хешем' : '✕ имена без хеша', S.opt.hash) + btn(MAP.x + MAP.w - 146, MAP.y + MAP.h - 32, 134, 'purge', S.purge ? 'purge идёт…' : 'Purge app.js', false);
        if (S.scn === 'down') s += btn(MAP.x + MAP.w - 200, MAP.y + MAP.h - 32, 188, 'sie', S.opt.sie ? '✓ stale-if-error' : '✕ stale-if-error', S.opt.sie);
        return s;
      }
      function hdrPanel() {
        const L = S.last && S.last.r, b = HD;
        let s = `<g class="xr-part" data-xpart="headers">${R(b.x, b.y, b.w, b.h, 'xcd-codebg', 10)}`;
        s += T(b.x + 12, b.y + 18, 'ОТВЕТ КРАЯ ПОЛЬЗОВАТЕЛЮ', 'xr-m');
        if (!L) return s + T(b.x + 12, b.y + 44, 'ждём запрос…', 'xr-s') + '</g>';
        const f = L.f, code = L.res === 'err' ? '502 Bad Gateway' : '200 OK', x = L.res === 'hit' ? 'HIT' : L.res === 'stale' ? 'STALE' : L.res === 'err' ? 'ERROR' : L.res === 'collapsed' ? 'MISS (склеен)' : L.res === 'reval' ? (L.notMod ? 'REVALIDATED' : 'MISS') : 'MISS';
        s += MONO(b.x + 12, b.y + 40, ES(cut(`GET ${L.key}`, 40)), 'on') + MONO(b.x + 12, b.y + 56, `HTTP/2 ${code}`, L.res === 'err' ? 'bad' : 'ok');
        const rows = L.res === 'err' ? [['x-cache', 'ERROR from ' + popCode(L.pop).toLowerCase() + '-edge-03'], ['retry-after', '5']] : [['content-type', f.t], ['content-length', nf(f.sz)], ['cache-control', f.app && S.opt.hash ? 'public, max-age=31536000, immutable' : `public, max-age=${MAXAGE[ttl()]}${S.opt.sie ? ', stale-if-error=86400' : ''}`], ['etag', `"${(L.ver > 1 ? '7b1d3a9' : '9b2cf53') + 'f27731c9'}"`], ['age', String(Math.round(L.age || 0))], ['x-cache', `${x} from ${popCode(L.pop).toLowerCase()}-edge-03`]];
        rows.forEach(([k, v], j) => { s += HDR(b.x + 12, b.y + 76 + j * 17, k, cut(v, 34), k === 'x-cache' ? (x === 'HIT' || x === 'STALE' ? 'ok' : x === 'ERROR' ? 'bad' : 'warn') : ''); });
        s += T(b.x + 12, b.y + b.h - 10, `${L.c.name} → ${popCode(L.pop)} · ${nf(L.ms)} мс${L.old ? ' · старый app.js!' : ''}`, 'xcd-ms' + (L.old ? ' xcd-bad' : ''));
        return s + '</g>';
      }
      function latPanel() {
        const b = LT, c = S.scn === 'far' ? CITY.find(x => x.id === 'vvo') : (S.last ? S.last.r.c : CITY[9]), pc = CITY.find(x => x.id === c.pop);
        const d = km(c, MSK), rtt = rttKm(d), edge = rttKm(km(c, pc)) + 2, toO = rttKm(km(pc, MSK));
        const no = 3 * rtt + 30, hit = 3 * edge + 1, miss = hit + toO + 30, mx = Math.max(no, 60);
        let s = `<g class="xr-part" data-xpart="latency">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}`;
        s += T(b.x + 12, b.y + 18, `${c.name.toUpperCase()} → ИСТОЧНИК`, 'xr-m') + T(b.x + b.w - 12, b.y + 18, `${nf(d)} км`, 'xcd-ms', 'end');
        [['без CDN', no, 'bad', `3 × ${nf(rtt)} мс`], ['CDN, промах', miss, 'warn', `край ${popCode(c.pop)} + путь в Москву`], ['CDN, попадание', hit, 'ok', `3 × ${nf(edge)} мс`]].forEach(([n, v, cl, d2], j) => {
          const y = b.y + 38 + j * 30;
          s += T(b.x + 12, y + 9, n, 'xr-s') + R(b.x + 112, y, 104, 11, 'xr-bar', 3) + R(b.x + 112, y, 104 * clamp(v / mx, 0.02, 1), 11, 'xr-bar-f ' + (cl === 'ok' ? '' : cl), 3) + T(b.x + b.w - 12, y + 9, `${nf(v)} мс`, 'xr-m ' + cl, 'end') + T(b.x + 112, y + 22, d2, 'xcd-ms');
        });
        return s + '</g>';
      }
      function logPanel() {
        const b = LOG;
        let s = R(b.x, b.y, b.w, b.h, 'xr-box', 10) + T(b.x + 12, b.y + 18, 'ПОСЛЕДНИЕ ЗАПРОСЫ', 'xr-m');
        s += T(b.x + 12, b.y + 36, 'город → точка', 'xcd-fn') + T(b.x + 186, b.y + 36, 'файл', 'xcd-fn') + T(b.x + 398, b.y + 36, 'кэш', 'xcd-fn') + T(b.x + b.w - 12, b.y + 36, 'время', 'xcd-fn', 'end');
        S.log.forEach((l, j) => {
          const y = b.y + 56 + j * 18, fl = S.t - l.t < 500, rc = l.res === 'hit' ? 'ok' : l.res === 'stale' ? 'ok' : l.res === 'err' ? 'bad' : 'warn';
          if (fl) s += R(b.x + 6, y - 12, b.w - 12, 16, 'xcd-krow', 3);
          s += T(b.x + 12, y, ES(cut(`${l.c} → ${l.pop}`, 26)), 'xcd-val') + MONO(b.x + 186, y, ES(cut(l.key.split('/').pop(), 26)), l.old ? 'bad' : '') + T(b.x + 398, y, l.res === 'hit' ? 'HIT' : l.res === 'stale' ? 'STALE' : l.res === 'err' ? '502' : l.res === 'collapsed' ? 'ждал' : 'MISS', 'xcd-val xcd-' + rc) + T(b.x + b.w - 12, y, `${nf(l.ms)} мс`, 'xcd-val', 'end');
        });
        return s;
      }
      function savPanel() {
        const b = SAV, c = counts(), rl = real();
        let s = `<g class="xr-part" data-xpart="savings">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}`;
        s += T(b.x + 12, b.y + 18, 'ПОПАДАНИЯ И ЭКОНОМИЯ', 'xr-m');
        s += T(b.x + 12, b.y + 40, 'в модели за 10 с', 'xr-s') + R(b.x + 140, b.y + 30, 220, 12, 'xr-bar', 3) + R(b.x + 140, b.y + 30, 220 * c.hr, 12, 'xr-bar-f', 3) + T(b.x + b.w - 12, b.y + 40, `${Math.round(c.hr * 100)} %`, 'xr-m ok', 'end');
        s += Ln(b.x + 140 + 220 * rl.h, b.y + 26, b.x + 140 + 220 * rl.h, b.y + 46, 'xcd-mark') + T(b.x + 140, b.y + 58, `черта — на площадке ${Math.round(rl.h * 100)} % (TTL ${TTLS[ttl()]})`, 'xcd-ms');
        s += T(b.x + 12, b.y + 84, 'к пользователям', 'xr-s') + T(b.x + 200, b.y + 84, `${SD.fmt.num(rl.st)} запросов/с`, 'xr-m');
        s += T(b.x + 12, b.y + 104, 'в источник', 'xr-s') + T(b.x + 200, b.y + 104, `${SD.fmt.num(rl.orgRps)} запросов/с`, 'xr-m ' + (rl.orgRps > rl.st * 0.1 ? 'warn' : 'ok')) + T(b.x + b.w - 12, b.y + 104, shield() ? 'со щитом ×0,4' : 'без щита', 'xcd-ms', 'end');
        s += T(b.x + 12, b.y + 124, 'трафик источника', 'xr-s') + T(b.x + 200, b.y + 124, `экономия ≈ ${usd(rl.saved)}/мес`, 'xr-m ok') + T(b.x + b.w - 12, b.y + 124, `из ${usd(rl.total)}`, 'xcd-ms', 'end');
        s += T(b.x + 12, b.y + 148, `средний ответ в модели: ${nf(c.avg)} мс${c.err ? ` · ошибок ${c.err}` : ''}${c.old ? ` · старых версий ${c.old}` : ''}`, 'xcd-ms' + (c.err || c.old ? ' xcd-bad' : ''));
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const rc = SD.kindColor('read');
        S.reqs.forEach(r => {
          if (r.ph === 'wait' || r.ph === 'shWait') { const p = r.ph === 'wait' ? popXY(r.pop) : HUB; s += `<circle class="xcd-wait" cx="${f1(p[0] + 26)}" cy="${f1(p[1] - 10)}" r="4"/>`; return; }
          if (r.ph === 'atOrg') { s += `<circle class="xcd-proc" cx="${f1(orgTop[0])}" cy="${f1(orgTop[1] + 20)}" r="10"/>`; return; }
          const [x, y] = along(r.pts, ease((S.t - r.p0) / r.dur));
          if (r.ph === 'in') s += Dot(x, y, 3.6, '', `fill:${rc}`);
          else if (r.ph === 'out') s += Dot(x, y, 3.8, r.res === 'err' || r.old ? 'err' : r.res === 'hit' || r.res === 'stale' ? 'ok' : 'wait');
          else s += Dot(x, y, 4.2, 'wait');
        });
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() { gSt.innerHTML = badges() + mapSvg() + hdrPanel() + latPanel() + logPanel() + savPanel(); gDy.innerHTML = dynSvg(); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xcd-backb', 13)}${T(68, 27, '← весь CDN', 'xr-s xcd-back', 'middle')}</g>` + T(140, 27, t, 'xcd-vt') + T(140, 46, sub, 'xr-s');
      function seq(x1, x2, y0, names, steps, cyc) {
        const ST = 1000, n = steps.length, len = n * ST + 2000, u = cyc % len, cur = Math.floor(u / ST), f = (u % ST) / ST, dy = 34;
        let s = R(x1 - 80, y0, 160, 30, 'xr-box', 8) + T(x1, y0 + 20, names[0], 'xr-t', 'middle') + R(x2 - 80, y0, 160, 30, 'xr-box', 8) + T(x2, y0 + 20, names[1], 'xr-t', 'middle');
        s += Ln(x1, y0 + 30, x1, y0 + 44 + n * dy, 'xcd-life') + Ln(x2, y0 + 30, x2, y0 + 44 + n * dy, 'xcd-life');
        steps.forEach((st, i) => {
          const y = y0 + 58 + i * dy, state = i < cur ? 'past' : i === cur ? 'now' : 'fut', a = st.r ? x2 : x1, b = st.r ? x1 : x2, k = state === 'now' ? Math.min(1, f * 1.4) : 1;
          if (st.self) s += R(Math.min(x1, x2) + 10, y - 16, Math.abs(x2 - x1) - 20, 22, `xcd-nt ${state}`, 5) + `<text class="xcd-sl ${state}${st.c ? ' xcd-' + st.c : ''}" xml:space="preserve" x="${f1((x1 + x2) / 2)}" y="${f1(y - 1)}" text-anchor="middle">${ES(st.t)}</text>`;
          else s += arrow(a, y, a + (b - a) * k, y, `${st.c || ''} ${state}`) + `<text class="xcd-sl ${state}${st.c ? ' xcd-' + st.c : ''}" xml:space="preserve" x="${f1((x1 + x2) / 2)}" y="${f1(y - 7)}" text-anchor="middle">${ES(st.t)}</text>`;
        });
        return { s, cur };
      }
      function vPop() {
        let s = head('Точки присутствия и выбор ближайшей', 'один адрес cdn.example.ru, но каждый город попадает в свою точку');
        const u = S.vt % 9000, c = CITY[Math.floor(S.vt / 3000) % CITY.length], pc = CITY.find(x => x.id === c.pop);
        s += R(24, 60, 470, 240, 'xcd-codebg', 10) + T(36, 80, `GeoDNS: пользователь из города ${c.name}`, 'xr-m');
        [['$ dig cdn.example.ru', ''], [';; QUESTION: cdn.example.ru. IN A', ''], [`;; ANSWER: cdn.example.ru. 60 IN A 185.71.${CITY.indexOf(pc) + 10}.${20 + CITY.indexOf(c)}`, 'on'], [`;; ← адрес точки ${popCode(c.pop)} (${pc.name})`, '']].forEach(([l, cl], j) => { s += MONO(36, 106 + j * 20, ES(l), cl); });
        s += T(36, 200, 'DNS CDN видит, откуда пришёл вопрос (по адресу резолвера', 'xr-s') + T(36, 218, 'или по EDNS Client Subnet), и отвечает адресом ближайшей точки.', 'xr-s');
        s += T(36, 250, `${c.name} → ${popCode(c.pop)} (${pc.name}): ${nf(km(c, pc))} км, RTT ≈ ${nf(rttKm(km(c, pc)) + 2)} мс`, 'xr-m acc');
        s += T(36, 272, `а до источника в Москве — ${nf(km(c, MSK))} км, RTT ≈ ${nf(rttKm(km(c, MSK)))} мс`, 'xcd-ms');
        s += R(506, 60, 470, 240, 'xcd-panel', 10) + T(518, 80, 'ANYCAST: ОДИН IP ВО ВСЕХ ГОРОДАХ', 'xr-m');
        const P2 = [[560, 150, 'MOW'], [650, 120, 'LED'], [740, 170, 'SVX'], [850, 140, 'OVB'], [930, 220, 'VVO']];
        P2.forEach(([x, y, cd], j) => { const on = cd === popCode(c.pop); s += `<circle class="xcd-city" cx="${x}" cy="${y}" r="16" style="${on ? 'fill:var(--accent-soft);stroke:var(--accent);stroke-width:2' : ''}"/>` + T(x, y + 4, cd, 'xcd-code', 'middle'); });
        s += T(518, 230, 'все объявляют 104.16.0.1 по BGP;', 'xr-s') + T(518, 248, 'пакет приходит туда, куда короче маршрут.', 'xr-s') + T(518, 272, 'Точка упала — маршрут исчез, трафик сам уходит к соседям.', 'xcd-ms');
        s += R(24, 312, 952, 236, 'xcd-panel', 10) + T(36, 334, 'КАКАЯ ТОЧКА У КАКОГО ГОРОДА', 'xr-m');
        CITY.forEach((cc, j) => { const p2 = CITY.find(x => x.id === cc.pop), y = 358 + (j % 5) * 34, x = 36 + Math.floor(j / 5) * 470, on = cc === c; s += R(x - 6, y - 15, 456, 26, on ? 'xcd-krow' : 'xcd-none', 4) + T(x, y + 2, cc.name, 'xr-s') + T(x + 150, y + 2, `→ ${popCode(cc.pop)}`, 'xr-m' + (cc.id === cc.pop ? '' : ' warn')) + T(x + 210, y + 2, `${nf(rttKm(km(cc, p2)) + 2)} мс до края · ${nf(rttKm(km(cc, MSK)))} мс до Москвы`, 'xcd-ms'); });
        return s;
      }
      function vCache() {
        const id = S.last ? S.last.r.pop : 'vvo', c = S.cache[id] || [];
        let s = head(`Кэш точки ${popCode(id)}`, 'ключ кэша — адрес файла; срок жизни — из Cache-Control; места мало — вытесняем давно не нужное');
        s += R(24, 60, 952, 300, 'xcd-panel', 10) + T(36, 82, `ЯЧЕЙКИ КЭША ${popCode(id)} (${c.length} из ${SLOTS})`, 'xr-m');
        s += T(36, 104, 'ключ', 'xcd-fn') + T(560, 104, 'версия', 'xcd-fn') + T(640, 104, 'осталось жить', 'xcd-fn') + T(964, 104, 'спрашивали', 'xcd-fn', 'end');
        for (let j = 0; j < SLOTS; j++) {
          const e = c[j], y = 128 + j * 28;
          if (!e) { s += R(30, y - 16, 940, 24, 'xcd-slotrow e', 5) + T(36, y, 'свободно', 'xcd-ms'); continue; }
          const left = clamp((e.exp - S.t) / TTL(), 0, 1), fl = S.t - e.fl < 500, old = FILES[1].k === e.key && e.ver < S.ver[FILES[1].k];
          s += R(30, y - 16, 940, 24, 'xcd-slotrow' + (fl ? ' fl' : '') + (old ? ' old' : ''), 5) + MONO(36, y, ES(cut('https://cdn.example.ru' + e.key, 72)), old ? 'bad' : '');
          s += T(560, y, `v${e.ver}`, 'xr-m' + (old ? ' bad' : '')) + R(640, y - 9, 180, 9, 'xr-bar', 3) + R(640, y - 9, 180 * left, 9, 'xr-bar-f' + (left < 0.2 ? ' warn' : ''), 3) + T(830, y, left <= 0 ? 'срок вышел' : `${nf(left * MAXAGE[ttl()])} с`, 'xcd-ms' + (left <= 0 ? ' xcd-warn' : ''));
          s += T(964, y, `${nf((S.t - e.last) / 1000, 1)} с назад`, 'xcd-ms', 'end');
        }
        s += R(24, 372, 952, 176, 'xcd-panel', 10) + T(36, 394, 'ЧТО ДЕЛАЕТ КРАЙ С ЗАПРОСОМ', 'xr-m');
        [['ключ есть, срок не вышел', 'HIT — отдать сразу, Age = сколько лежит', 'ok'], ['ключа нет', 'MISS — в источник (или в щит), ответ сохранить', 'warn'], ['срок вышел', 'проверка If-None-Match: 304 — продлить, 200 — заменить', 'warn'], ['источник лежит', 'stale-if-error — отдать просроченное, иначе 502', 'bad'], ['место кончилось', 'вытеснить ячейку, которую дольше всех не спрашивали', '']].forEach(([a, b2, c2], j) => { s += T(36, 418 + j * 26, a, 'xr-s') + T(260, 418 + j * 26, b2, 'xr-m' + (c2 ? ' ' + c2 : '')); });
        return s;
      }
      function vHeaders() {
        const steps = [{ t: 'GET /img/…/IMG_4821_1280.webp', c: '' }, { t: '200 OK · 184 233 байт · max-age=3600 · ETag "9b2cf53"', r: 1, c: 'ok' }, { t: 'сохранили, час отдаём сами (HIT, Age растёт)', self: 1 }, { t: 'срок вышел → GET … If-None-Match: "9b2cf53"', c: 'acc' }, { t: '304 Not Modified · 0 байт тела', r: 1, c: 'ok' }, { t: 'продлили ещё на час — байты не везли', self: 1, c: 'ok' }];
        const q = seq(250, 750, 60, ['Край (VVO)', 'Источник (S3)'], steps, S.vt);
        if (q.cur >= 4) S.pv.saw304 = 1;
        let s = head('Заголовки кэша: Cache-Control, ETag, 304', 'срок решает, сколько не перепроверять; отпечаток — изменилось ли');
        s += q.s;
        s += R(24, 330, 470, 218, 'xcd-codebg', 10) + T(36, 350, 'ТИПИЧНЫЕ ЗНАЧЕНИЯ', 'xr-m');
        [['app.4f9c2e1.js', 'public, max-age=31536000, immutable'], ['IMG_4821_1280.webp', `public, max-age=${MAXAGE[ttl()]}`], ['index.html', 'no-cache  (хранить, но проверять каждый раз)'], ['/api/me', 'private, no-store  (никакого кэша)'], ['ленты, цены', 's-maxage=30, stale-while-revalidate=60']].forEach(([a, b2], j) => { s += MONO(36, 376 + j * 32, a, 'on') + MONO(36, 392 + j * 32, 'Cache-Control: ' + b2); });
        s += R(506, 330, 470, 218, 'xcd-panel', 10) + T(518, 350, 'ЗАГОЛОВКИ ОТВЕТА КРАЯ', 'xr-m');
        [['age', 'сколько секунд файл лежит в кэше края'], ['x-cache', 'HIT / MISS / REVALIDATED — откуда ответ'], ['etag', 'отпечаток версии для проверки 304'], ['vary', 'Accept-Encoding — отдельная копия для gzip и br'], ['cf-cache-status', 'то же у Cloudflare: HIT, MISS, EXPIRED, STALE']].forEach(([a, b2], j) => { s += MONO(518, 376 + j * 32, a + ':', 'on') + T(518, 392 + j * 32, b2, 'xcd-ms'); });
        return s;
      }
      function vPurge() {
        const C = 11000, u = S.vt % C, k = clamp((u - 2500) / 4000, 0, 1);
        let s = head('Инвалидация (purge)', 'файл поменяли, а края помнят старый до конца срока — им нужно сказать «забудь»');
        s += R(24, 60, 952, 70, 'xcd-codebg', 10) + MONO(36, 86, '$ aws cloudfront create-invalidation --distribution-id E2QWRUHAPOMQZL --paths "/static/app.js"', 'on') + MONO(36, 108, u < 2500 ? '…деплой: новый app.js уже в источнике, края ещё отдают старый' : k < 1 ? `{"Invalidation": {"Status": "InProgress"}}  — разошлось по ${Math.floor(k * 8)} из 8 точек` : '{"Invalidation": {"Status": "Completed"}}', k >= 1 ? 'ok' : '');
        POPS.forEach(([id, cd], j) => {
          const x = 40 + (j % 4) * 236, y = 150 + Math.floor(j / 4) * 110, dn = k >= (j + 1) / 8;
          s += R(x, y, 220, 96, 'xcd-panel' + (dn ? ' okb' : u >= 2500 ? ' badb' : ''), 10) + T(x + 12, y + 22, `${cd} · ${CITY.find(c => c.id === id).name}`, 'xr-t');
          s += T(x + 12, y + 46, dn ? 'app.js: забыт' : 'app.js: старая версия v1', 'xr-m ' + (dn ? 'ok' : u >= 2500 ? 'bad' : '')) + T(x + 12, y + 66, dn ? 'следующий запрос — MISS,' : u >= 2500 ? 'пользователи получают старое' : 'всё совпадает с источником', 'xcd-ms') + T(x + 12, y + 82, dn ? 'потом свежий v2 из источника' : '', 'xcd-ms');
        });
        s += R(24, 382, 952, 166, 'xcd-panel', 10) + T(36, 404, 'ПОЧЕМУ ЭТО НЕУДОБНО', 'xr-m');
        ['· рассылка занимает время: CloudFront — до пары минут, Cloudflare — секунды; всё это время пользователи видят смесь версий', '· новый HTML + старый app.js = ошибки в браузере: функции, которые HTML ждёт, ещё не существуют', '· после purge каждая точка один раз промахивается — всплеск запросов в источник (помогает щит)', '· purge платный и лимитированный: у CloudFront бесплатно 1 000 путей в месяц', '· поэтому статику не перезаписывают, а называют по-новому — блок «Имена с хешем»'].forEach((l, j) => { s += T(36, 430 + j * 22, l, 'xr-s'); });
        return s;
      }
      function vVersion() {
        const C = 10000, u = S.vt % C, dep = u > 3500;
        let s = head('Имена файлов с хешем', 'поменялся код — поменялось имя; старое и новое никогда не перепутать');
        const col2 = (x, title, ok, lines) => { let t = R(x, 60, 466, 300, 'xcd-panel' + (ok ? ' okb' : ' badb'), 10) + T(x + 14, 84, title, 'xr-t'); lines.forEach(([a, c], j) => { t += MONO(x + 14, 112 + j * 24, ES(a), c); }); return t; };
        s += col2(24, 'Без хеша: одно имя на все версии', false, [['<script src="/static/app.js">', 'on'], ['Cache-Control: public, max-age=86400', ''], ['', ''], [dep ? 'деплой: /static/app.js теперь другой файл' : 'версия 1 во всех кэшах', dep ? 'bad' : ''], [dep ? 'края до суток отдают версию 1' : '', dep ? 'bad' : ''], [dep ? 'новый HTML + старый JS = ошибки' : '', dep ? 'bad' : ''], [dep ? 'лечение: purge и ждать рассылку' : '', ''], ['', ''], ['браузеры тоже хранят до суток!', 'bad']]);
        s += col2(510, 'С хешем: новое содержимое — новое имя', true, [[`<script src="/static/app.${dep ? '7b1d3a9' : '4f9c2e1'}.js">`, 'on'], ['Cache-Control: public, max-age=31536000,', ''], ['               immutable', ''], [dep ? 'деплой: app.7b1d3a9.js — новый ключ' : 'app.4f9c2e1.js во всех кэшах', dep ? 'ok' : ''], [dep ? 'HTML (no-cache) сразу ссылается на него' : '', dep ? 'ok' : ''], [dep ? 'края: один промах на точку — и всё' : '', ''], [dep ? 'старый app.4f9c2e1.js доживёт и вытеснится' : '', ''], ['', ''], ['purge не нужен, смеси версий нет', 'ok']]);
        s += R(24, 372, 952, 176, 'xcd-codebg', 10) + T(36, 394, 'КАК ЭТО ДЕЛАЕТ СБОРЩИК', 'xr-m');
        ['// vite.config.ts', 'build: { rollupOptions: { output: { entryFileNames: "assets/[name].[hash].js",', '                                     assetFileNames: "assets/[name].[hash][extname]" } } }', '// результат: dist/assets/app.7b1d3a9.js, app.c41e0f2.css, index.html ссылается на них', '// порядок деплоя: сначала новые файлы в S3, потом index.html; старые файлы удалить через неделю'].forEach((l, j) => { s += MONO(36, 420 + j * 22, ES(l), j === 0 || j >= 3 ? '' : 'on'); });
        return s;
      }
      function vShield() {
        const C = 9000, u = S.vt % C, k = clamp((u - 600) / 3000, 0, 1), on = shield();
        let s = head('Origin shield и склейка промахов', on ? 'включён: промахи всех краёв идут в щит, в источник — один запрос на файл' : 'выключен: каждая точка при промахе сама идёт в источник (здесь показаны оба варианта)');
        const lane = (x, title, sh) => {
          let t = R(x, 60, 466, 330, 'xcd-panel' + ((sh && on) || (!sh && !on) ? ' on' : ''), 10) + T(x + 14, 82, title, 'xr-t');
          const O = [x + 233, 350], H = [x + 233, 240];
          t += R(O[0] - 60, O[1] - 16, 120, 32, 'xr-box', 8) + T(O[0], O[1] + 4, 'источник', 'xcd-fn', 'middle');
          if (sh) t += `<polygon class="xcd-hub on" points="${H[0]},${H[1] - 14} ${H[0] + 14},${H[1]} ${H[0]},${H[1] + 14} ${H[0] - 14},${H[1]}"/>` + T(H[0] + 20, H[1] + 4, 'щит', 'xcd-ms xcd-acc');
          POPS.forEach(([id, cd], j) => {
            const p = [x + 40 + j * 55, 120];
            t += R(p[0] - 22, p[1] - 12, 44, 24, 'xcd-pop', 5) + T(p[0], p[1] + 4, cd, 'xcd-code', 'middle');
            const to = sh ? H : O;
            t += Ln(p[0], p[1] + 12, to[0], to[1] - 14, 'xcd-link');
            if (k > 0 && k < 1) t += Dot(...lerp([p[0], p[1] + 12], [to[0], to[1] - 14], ease(Math.min(1, k * 1.6))), 3.8, 'wait');
          });
          if (sh) { t += Ln(H[0], H[1] + 14, O[0], O[1] - 16, 'xcd-link main'); if (k > 0.6 && k < 1) t += Dot(...lerp(H, O, ease((k - 0.6) / 0.4)), 4.5, 'wait'); }
          t += T(x + 14, 384, sh ? 'в источник: 1 запрос на файл, 7 краёв ждут ответа щита' : 'в источник: 8 одинаковых запросов — по одному от каждой точки', 'xr-s ' + (sh ? 'xcd-ok' : 'xcd-warn'));
          return t;
        };
        s += lane(24, 'Без щита', false) + lane(510, 'Со щитом', true);
        s += R(24, 402, 952, 146, 'xcd-panel', 10) + T(36, 424, 'ГДЕ ЭТО ПОМОГАЕТ', 'xr-m');
        ['· холодный кэш и purge: промахи всех краёв сходятся в одну точку — источник не тонет', '· редкие файлы: у щита больше шанс попадания, чем у каждой отдельной точки', '· склейка: сто одновременных промахов одного файла — один поход в источник (request collapsing)', `· на площадке: запросы в источник × 0,4; сейчас ${on ? 'включён' : 'выключен'} (настройка узла справа)`].forEach((l, j) => { s += T(36, 450 + j * 22, l, 'xr-s'); });
        return s;
      }
      function vLatency() {
        const c = CITY.find(x => x.id === 'vvo'), d = km(c, MSK), rtt = rttKm(d), edge = 5, C = 9000, u = S.vt % C;
        let s = head('Задержка: Владивосток → Москва', `${nf(d)} км по прямой; свет в оптике ≈ 200 км/мс, маршрут не прямой → RTT ≈ ${nf(rtt)} мс`);
        const rows = [['Без CDN: все три обмена до Москвы', [['TCP', rtt], ['TLS 1.3', rtt], ['запрос → ответ', rtt + 30]], 'bad'], ['CDN, промах: обмены рядом + один путь края в Москву', [['TCP', edge], ['TLS', edge], ['запрос', edge], ['край → источник', rtt + 30]], 'warn'], ['CDN, попадание: всё в соседнем здании', [['TCP', edge], ['TLS', edge], ['запрос', edge + 1]], 'ok']];
        const sc = 1.6;
        rows.forEach(([title, segs, cl], j) => {
          const y = 80 + j * 120, tot = segs.reduce((a, b) => a + b[1], 0), k = clamp(u / 6000, 0, 1) * 700 / sc;
          s += T(30, y, title, 'xr-t') + T(970, y, `${nf(tot)} мс`, 'xr-m ' + cl, 'end');
          let x = 30, acc = 0;
          segs.forEach(([n, v], i) => { const w = v * sc, shown = clamp(k - acc, 0, v) * sc; s += R(x, y + 14, w, 30, 'xcd-seg', 4) + R(x, y + 14, shown, 30, 'xcd-seg ' + cl, 4) + (w > 50 ? T(x + 6, y + 34, `${n} · ${nf(v)} мс`, 'xcd-pn') : ''); x += w + 2; acc += v; });
          s += T(30, y + 64, cl === 'bad' ? 'каждое «алло — слышу» летит через всю страну' : cl === 'warn' ? 'рукопожатия у края; в Москву край ходит по уже открытому соединению' : 'ответ отдаёт точка VVO из своего кэша', 'xcd-ms');
        });
        s += R(24, 432, 952, 116, 'xcd-panel', 10);
        s += T(36, 456, `Страница на 30 файлов: браузер открывает несколько соединений и переиспользует их, но первое соединение всегда стоит 3 RTT.`, 'xr-s');
        s += T(36, 478, `Без CDN первая картинка придёт через ≈ ${nf(3 * rtt + 30)} мс, с CDN — через ≈ ${nf(3 * edge + 1)} мс при попадании.`, 'xr-s xcd-acc');
        s += T(36, 502, 'HTTP/3 (QUIC) объединяет TCP и TLS — на один RTT меньше. Повторное соединение (0-RTT) — ещё меньше.', 'xcd-ms');
        s += T(36, 524, 'Ускорить свет нельзя: можно только приблизить сервер к пользователю.', 'xcd-ms');
        return s;
      }
      function vSavings() {
        const rl = real(), c = counts();
        let s = head('Попадания и экономия источника', `TTL ${TTLS[ttl()]}${shield() ? ' и щит' : ''}: на площадке ${Math.round(rl.h * 100)} % попаданий`);
        const tt = ['min', 'hour', 'day'];
        s += R(24, 60, 952, 230, 'xcd-panel', 10) + T(36, 82, 'TTL → ДОЛЯ ПОПАДАНИЙ → ЗАПРОСЫ В ИСТОЧНИК (по нагрузке площадки)', 'xr-m');
        tt.forEach((t, j) => {
          const h = CDN_HIT[t], o1 = rl.st * (1 - h), o2 = o1 * 0.4, y = 112 + j * 56, cur = t === ttl();
          if (cur) s += R(30, y - 18, 940, 50, 'xcd-krow', 6);
          s += T(36, y, `TTL ${TTLS[t]}`, 'xr-m' + (cur ? ' acc' : '')) + R(180, y - 10, 300, 12, 'xr-bar', 3) + R(180, y - 10, 300 * h, 12, 'xr-bar-f', 3) + T(490, y, `${Math.round(h * 100)} %`, 'xr-m ok');
          s += T(560, y, `в источник ${SD.fmt.num(o1)}/с`, 'xr-s') + T(760, y, `со щитом ${SD.fmt.num(o2)}/с`, 'xr-s xcd-ok') + T(180, y + 20, t === 'min' ? 'свежее всего, но промахов больше всех' : t === 'hour' ? 'обычный выбор для картинок' : 'для неизменяемых файлов; изменения — через purge или новые имена', 'xcd-ms');
        });
        s += R(24, 302, 952, 246, 'xcd-panel', 10) + T(36, 324, 'ЧТО ЭТО ДАЁТ В ДЕНЬГАХ И НАГРУЗКЕ', 'xr-m');
        s += T(36, 352, 'запросов к пользователям', 'xr-s') + T(300, 352, `${SD.fmt.num(rl.st)}/с`, 'xr-m');
        s += T(36, 376, 'доходит до источника', 'xr-s') + T(300, 376, `${SD.fmt.num(rl.orgRps)}/с — в ${nf(rl.st / Math.max(0.01, rl.orgRps), 0)} раз меньше`, 'xr-m ok');
        s += T(36, 400, 'трафик источника наружу', 'xr-s') + T(300, 400, `${usd(rl.total - rl.saved)} вместо ${usd(rl.total)} в месяц (при $0,09/ГБ, 200 КБ на файл)`, 'xr-m ok');
        s += T(36, 424, 'в модели за 10 с', 'xr-s') + T(300, 424, `${Math.round(c.hr * 100)} % попаданий, средний ответ ${nf(c.avg)} мс`, 'xr-m');
        s += T(36, 456, 'Hit ratio ограничивает «длинный хвост»: старые фото, которые спрашивают раз в неделю, почти всегда промахи.', 'xcd-ms');
        s += T(36, 476, 'Байтовый hit ratio важнее запросного: один сегмент видео весит как сто скриптов.', 'xcd-ms');
        return s;
      }
      const VIEWS = { pop: vPop, cache: vCache, headers: vHeaders, purge: vPurge, version: vVersion, shield: vShield, latency: vLatency, savings: vSavings };
      function partNow(k) {
        const rl = real();
        if (k === 'pop') return '<b>Ближайшая точка:</b> GeoDNS отвечает каждому городу адресом его точки, Anycast объявляет один IP отовсюду. Рукопожатия TCP и TLS идут до соседнего здания, а не до Москвы.';
        if (k === 'cache') return `<b>Кэш края:</b> ${SLOTS} ячеек, ключ — адрес файла. Срок жизни — из Cache-Control (TTL ${TTLS[ttl()]}). Нет файла — промах в источник; места нет — вытесняется то, что дольше всех не спрашивали.`;
        if (k === 'headers') return '<b>Cache-Control</b> задаёт срок, <b>ETag</b> — отпечаток версии. Срок вышел — край спрашивает «изменилось?» и получает 304 без тела, если нет.';
        if (k === 'purge') return '<b>Инвалидация</b> расходится по точкам за секунды–минуты. До этого часть пользователей получает старый файл, после — каждая точка один раз промахивается.';
        if (k === 'version') return '<b>Имена с хешем:</b> новое содержимое — новый ключ кэша. Старые копии никому не мешают, purge не нужен, смеси версий нет.';
        if (k === 'shield') return shield() ? '<b>Щит включён:</b> промахи всех краёв сходятся в Москве, источник получает один запрос на файл.' : '<b>Щита нет:</b> каждая точка при промахе сама ходит в источник. Включи «Origin shield» справа.';
        if (k === 'latency') return '<b>Задержку решают обмены:</b> 3 RTT до первого байта. До Владивостока RTT ≈ 130 мс — без CDN почти 0,4 с, с CDN и попаданием — около 15 мс.';
        if (k === 'savings') return `<b>Попаданий ${Math.round(rl.h * 100)} %:</b> из ${SD.fmt.num(rl.st)} запросов в секунду до источника доходит ${SD.fmt.num(rl.orgRps)}. Трафик источника — ${usd(rl.total - rl.saved)} вместо ${usd(rl.total)} в месяц.`;
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.cache) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'headers' && S.pv.saw304) done('phdr'); }
        while (S.at <= S.t) { S.at += 140 * (0.6 + Math.random() * 0.8); if (S.reqs.length < 50) spawn(); }
        scnStep();
        S.reqs.slice().forEach(r => { let g = 0; while (!r.gone && S.t >= r.p0 + r.dur && g++ < 4) step(r); });
        S.reqs = S.reqs.filter(r => !r.gone);
        S.ev = S.ev.filter(e => e.t > S.t - 10000); S.org = S.org.filter(t => t > S.t - 10000); S.fx = S.fx.filter(f => S.t - f.t0 < 1300);
        if (S.scn === 'norm') { const c = counts(); if (c.n > 20) { const goal = CDN_HIT[ttl()]; S.pTail = clamp(S.pTail + (c.hr - goal) * dt / 4000, 0.01, 0.4); } }
        if (S.scn === 'far') { const c = counts(); if (c.n > 15 && S.log.some(l => l.c === 'Владивосток' && l.res === 'hit') && S.log.some(l => l.c === 'Владивосток' && l.res !== 'hit')) done('far'); }
        if (S.flags.ttlMin && S.flags.ttlDay) done('ttl');
        if (S.scn === 'deploy' && S.opt.hash && S.flags.hashDep && S.t - S.flags.hashDep > 2000 && !S.ev.some(e => e.old && e.t > S.flags.hashDep)) done('hash');
        if (S.scn === 'cold' && shield() && S.flags.coll) done('shield');
      }
      function draw() {
        if (!S.cache) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      if (ttl() === 'min') S.flags.ttlMin = 1; if (ttl() === 'day') S.flags.ttlDay = 1;
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() {},
        scenario(id) { const keep = S.flags; S.scn = id; reset(); S.flags = keep; },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (key === 'ttl') {
            if (v === 'min') S.flags.ttlMin = 1; if (v === 'day') S.flags.ttlDay = 1;
            Object.values(S.cache).forEach(c => c.forEach(e => { e.exp = Math.min(e.exp, e.t0 + TTL()); }));
            return v === 'min' ? 'TTL 1 минута: файлы на краях быстро истекают — больше промахов и запросов в источник, зато изменения видны быстрее.' : v === 'day' ? 'TTL сутки: края почти всё отдают сами, источник отдыхает. Но заменённый файл края будут отдавать до суток — нужен purge или новые имена.' : 'TTL 1 час: обычный выбор для картинок.';
          }
          if (key === 'shield') return v ? 'Щит включён: линии от краёв теперь сходятся в ромб у Москвы, в источник идёт один запрос на файл. Сильнее всего видно в «Холодном кэше».' : 'Щит выключен: каждая точка при промахе сама идёт в источник.';
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const c = counts(), rl = real();
          if (S.scn === 'far') { const v = CITY.find(x => x.id === 'vvo'), rtt = rttKm(km(v, MSK)); return `<b>Владивосток: ${nf(km(v, MSK))} км до источника.</b> Без CDN каждое из трёх рукопожатий летит через всю страну: ≈ ${nf(3 * rtt + 30)} мс до первого байта. Точка VVO отвечает за ≈ 16 мс при попадании и ≈ ${nf(16 + rttKm(km(v, MSK)) + 30)} мс при промахе — смотри справа.`; }
          if (S.scn === 'deploy') return S.opt.hash ? `<b>Имена с хешем:</b> каждый деплой даёт app.js новое имя (сейчас app.${S.appHash}.js), поэтому края просто кэшируют новый файл. Старые копии никому не отдаются — ни одного пользователя со смесью версий.` : S.depAt ? '<b>Сейчас выкатят новую версию app.js</b> под тем же именем. Смотри, что начнут отдавать края.' : `<b>Края помнят старый app.js</b> (красные ячейки). Пользователи, попавшие на них, получают старый скрипт с новым HTML — уже ${S.staleUsers}. Нажми «Purge app.js» или включи имена с хешем.`;
          if (S.scn === 'cold') return `<b>Холодный кэш:</b> все точки пусты, первые запросы — промахи. ${shield() ? 'Щит собирает промахи всех краёв и ходит в источник один раз на файл — источник почти не замечает.' : `Без щита каждая точка сама идёт за одним и тем же — источник получает до 8 одинаковых запросов на файл (${nf(S.org.filter(t => t > S.t - 2000).length / 2, 1)} в секунду в модели). Включи origin shield.`}`;
          if (S.scn === 'down') return S.down ? `<b>Источник лежит.</b> Свежие файлы края отдают как обычно — пользователи ничего не замечают. Но если срок файла вышел, ${S.opt.sie ? 'край по stale-if-error отдаёт просроченную копию.' : 'краю некуда идти — 502. Включи stale-if-error.'}` : '<b>Источник работает.</b> Скоро он упадёт на 8 секунд — смотри, что будет с файлами, у которых истекает срок.';
          return `<b>Пользователь идёт в ближайшую точку.</b> Есть файл и срок не вышел — ответ за миллисекунды (зелёные точки). Нет — точка ${shield() ? 'через щит ' : ''}идёт в источник в Москве (оранжевые) и оставляет файл у себя на ${TTLS[ttl()]}. Попаданий ${Math.round(c.hr * 100)} % в модели и ${Math.round(rl.h * 100)} % на площадке: из ${SD.fmt.num(rl.st)} запросов в секунду до источника доходит ${SD.fmt.num(rl.orgRps)}.`;
        },
        stats() {
          const c = counts(), rl = real();
          return [
            ['Попаданий', Math.round(c.hr * 100) + ' %', c.hr >= 0.85 ? 'ok' : c.hr >= 0.6 ? 'warn' : 'bad', `на площадке ${Math.round(rl.h * 100)} %`],
            ['В источник', SD.fmt.num(rl.orgRps) + '/с', rl.orgRps > rl.st * 0.15 ? 'warn' : 'ok', `из ${SD.fmt.num(rl.st)}/с${shield() ? ', со щитом' : ''}`],
            ['Ответ в среднем', nf(c.avg) + ' мс', c.avg > 80 ? 'warn' : 'ok', 'в модели за 10 с'],
            ['Ошибок 502', String(c.err), c.err ? 'bad' : 'ok', 'источник лежит'],
            ['Старый app.js', String(c.old), c.old ? 'bad' : 'ok', 'за 10 с'],
            ['Экономия трафика', usd(rl.saved) + '/мес', 'ok', 'трафик источника']
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
