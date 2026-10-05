/* «Объектное хранилище изнутри» (S3): бакет и ключи, PUT/GET/LIST, multipart-загрузка, подписанные ссылки,
   классы хранения и жизненный цикл, версии объектов, цена хранения и исходящего трафика. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const byt = b => b >= 1e15 ? nf(b / 1e15, 1) + ' ПБ' : b >= 1e12 ? nf(b / 1e12, b >= 1e13 ? 0 : 1) + ' ТБ' : b >= 1e9 ? nf(b / 1e9, b >= 1e11 ? 0 : 1) + ' ГБ' : b >= 1e6 ? nf(b / 1e6, b >= 1e7 ? 0 : 1) + ' МБ' : b >= 1e3 ? nf(b / 1e3) + ' КБ' : nf(b) + ' Б';
  const usd = v => v >= 1000 ? '$' + nf(v / 1000, v >= 1e4 ? 0 : 1) + 'k' : v >= 10 ? '$' + nf(v) : '$' + nf(v, 2);
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
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
    return `<line class="xs3-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xs3-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const hl = line => line.split(/('[^']*'|"[^"]*"|\s+|[(),=<>*;:{}[\]&?]+)/).filter(x => x !== '').map(tk => /^('.*'|".*")$/.test(tk) ? `<tspan class="xs3-st">${ES(tk)}</tspan>` : /^(PUT|GET|POST|DELETE|HEAD|LIST|HTTP\/1\.1|HTTP\/2|aws|s3|s3api)$/.test(tk) ? `<tspan class="xs3-kw">${tk}</tspan>` : /^-?\d[\d.]*$/.test(tk) ? `<tspan class="xs3-nu">${tk}</tspan>` : ES(tk)).join('');
  const CODE = (x, y, line, c) => { const i = line.indexOf('#'); const body = i === 0 || line.trim().startsWith('#') || line.trim().startsWith('//') ? `<tspan class="xs3-cm">${ES(line)}</tspan>` : hl(line); return `<text class="xs3-code${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${body}</text>`; };
  const MONO = (x, y, t, c, a) => `<text class="xs3-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;

  /* ---------- классы хранения: цена за ГБ в месяц, извлечение (как у AWS S3) ---------- */
  const CLS = [
    { id: 'STANDARD', name: 'Стандарт', price: 0.023, get: 0, wait: 'мс', note: 'часто читают' },
    { id: 'STANDARD_IA', name: 'Редкий доступ', price: 0.0125, get: 0.01, wait: 'мс', note: 'от 30 дней, +$0,01 за ГБ чтения' },
    { id: 'GLACIER_IR', name: 'Архив, быстрое чтение', price: 0.004, get: 0.03, wait: 'мс', note: 'от 90 дней, +$0,03 за ГБ' },
    { id: 'DEEP_ARCHIVE', name: 'Глубокий архив', price: 0.001, get: 0.02, wait: '12–48 ч', note: 'от 180 дней, восстановление часами' }];
  const KEYS = [
    ['photos/2026/07/14/u55120/IMG_4821.jpg', 2.4e6, 0, 'image/jpeg'], ['thumbs/2026/07/14/u55120/IMG_4821_400.webp', 3.8e4, 0, 'image/webp'],
    ['photos/2026/07/14/u80441/IMG_0093.heic', 1.9e6, 0, 'image/heic'], ['videos/hls/v_8812/720p/seg_00004.ts', 1.1e6, 4, 'video/mp2t'],
    ['avatars/u55120.jpg', 8.4e4, 12, 'image/jpeg'], ['photos/2026/05/02/u23878/IMG_7710.jpg', 2.6e6, 73, 'image/jpeg'],
    ['videos/raw/2026/03/01/v_6120.mp4', 2.1e9, 135, 'video/mp4'], ['photos/2025/11/20/u12008/IMG_3301.jpg', 2.2e6, 236, 'image/jpeg'],
    ['backups/pg/2025-06-01.dump.zst', 4.1e10, 408, 'application/zstd']];
  const NEWK = ['photos/2026/07/14/u30115/IMG_5120.jpg', 'photos/2026/07/14/u91883/IMG_0451.heic', 'photos/2026/07/14/u44019/IMG_2207.jpg', 'thumbs/2026/07/14/u30115/IMG_5120_400.webp', 'photos/2026/07/14/u67311/IMG_9302.jpg'];
  const MONTH = 2.63e6;

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const CL = { x: 16, y: 52, w: 210, h: 128 }, SV = { x: 16, y: 190, w: 210, h: 120 }, CD = { x: 16, y: 320, w: 210, h: 112 };
  const BK = { x: 240, y: 46, w: 476, h: 386 }, SH = { x: 728, y: 46, w: 256, h: 386 }, BOT = { x: 16, y: 444, w: 968, h: 108 };
  const ROW0 = 96, RH = 30;

  SD.XRAY.objstore = {
    viewBox: '0 0 1000 560',
    cta: 'Бакет и ключи, загрузка частями, подписанные ссылки, классы хранения и жизненный цикл, версии и счёт за трафик',
    dive: 'objstore',
    simple: () => ({
      an: 'Как <b>огромная камера хранения</b>: сдаёшь вещь — получаешь номерок (ключ), по номерку её выдадут в любой момент. Переложить что-то внутри сумки нельзя — только сдать новую. Старые вещи можно отправить на дальний склад: хранить дешевле, но ждать выдачи дольше.',
      pl: 'S3 хранит файлы целиком по ключу — длинной строке вроде photos/2026/07/14/u55120/IMG_4821.jpg. Файл кладут (PUT) и забирают (GET) по HTTP. Большие файлы грузят частями, клиент может грузить сам по подписанной ссылке, а старые файлы автоматически переезжают в более дешёвые классы.'
    }),
    props: ['sclass', 'lifecycle'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Пользователи смотрят фото и загружают новые по подписанной ссылке. Нагрузка — как на площадке.' },
      { id: 'thru', name: 'Загрузка через сервис', note: 'Тот же поток загрузок, но каждый файл идёт через сервис: его потоки и сеть заняты байтами.' },
      { id: 'multi', name: 'Большое видео', note: 'Пользователь загружает видео 2,4 ГБ: 48 частей по 50 МБ, по 4 параллельно. Одна часть падает и перезагружается.' },
      { id: 'life', name: 'Жизненный цикл', note: 'Время ускорено: файлы стареют и по правилу переезжают в более дешёвые классы. Смотри счёт за хранение.' },
      { id: 'ver', name: 'Перезапись и версии', note: 'Пользователь меняет аватар и потом удаляет его. Что осталось в бакете — с версиями и без?' }
    ],
    tries: [
      { id: 'thru', text: 'Сравни «Как на схеме» и «Загрузку через сервис»: посмотри, сколько потоков сервиса заняты байтами' },
      { id: 'multi', text: 'В «Большом видео» дождись падения части и её повтора: остальные части не перезагружаются' },
      { id: 'life', text: 'В «Жизненном цикле» дождись, пока старое фото уедет в архив, и выключи правило: сравни счёт за хранение' },
      { id: 'ver', text: 'В «Перезаписи и версиях» выключи версии и посмотри, как старый аватар пропадает безвозвратно' },
      { id: 'restore', text: 'Там же при включённых версиях восстанови удалённый аватар' },
      { id: 'pcost', text: 'Открой блок «Цена» и посмотри, сколько стоит исходящий трафик без CDN' },
      { id: 'psign', text: 'Открой блок «Подписанная ссылка» и дождись, пока просроченная ссылка получит 403' },
      { id: 'arch', text: 'На облачном уровне «Счёт за хранение растёт» поставь класс «Архив»: счёт падает, а фото перестают открываться' }
    ],
    parts: {
      bucket: {
        name: 'Бакет и ключи',
        an: 'Как <b>камера хранения с номерками</b>: номерок — ключ объекта, сумка — сам файл с биркой (метаданными). Отделений «папок» нет: просто номерки бывают похожими.',
        pl: 'Бакет — контейнер с уникальным именем. Объект — файл до 5 ТБ, ключ — любая строка до 1 024 байт, плюс метаданные: тип, размер, контрольная сумма (ETag), свои заголовки. Слеши в ключе — просто символы.',
        how: ['Бакет media-prod создают один раз в регионе: ru-central1 или eu-west-1.', 'Ключ photos/2026/07/14/u55120/IMG_4821.jpg — не путь в папках, а строка. «Папки» — общий префикс.', 'Объект неизменяем: изменить байт нельзя, можно только записать новый объект с тем же ключом.', 'К объекту прилагаются метаданные: Content-Type, Content-Length, ETag (хеш), x-amz-meta-*.', 'Доступ — по HTTP: https://media-prod.s3.amazonaws.com/photos/… С правами решают политики бакета и IAM.', 'Данные копируются минимум в три зоны доступности: заявленная надёжность — 11 девяток (99,999999999 %).'],
        watch: 'Список объектов бакета: ключ, размер, класс хранения и возраст. Новые объекты появляются сверху, прочитанные (GET) вспыхивают.',
        real: 'Amazon S3, Yandex Object Storage, VK Cloud, MinIO у себя. Имя бакета уникально на весь мир (в AWS). Объект до 5 ТБ, одним PUT — до 5 ГБ.'
      },
      api: {
        name: 'PUT, GET, LIST',
        an: 'Как <b>окно выдачи</b>: «положите» (PUT), «выдайте» (GET), «покажите, что у меня есть на букву П» (LIST). Больше ничего — зато окон тысячи.',
        pl: 'У S3 простой HTTP-интерфейс. PUT кладёт объект целиком, GET отдаёт его или кусок по диапазону байт, LIST перечисляет ключи по префиксу страницами по 1 000, DELETE удаляет.',
        how: ['PUT /photos/…/IMG_4821.jpg с телом файла → 200 OK и ETag (контрольная сумма).', 'GET /photos/…/IMG_4821.jpg → файл. С заголовком Range: bytes=0-1023 — только кусок.', 'GET ?list-type=2&prefix=photos/2026/07/14/ → до 1 000 ключей и токен следующей страницы.', 'HEAD — только метаданные: размер, тип, дата, ETag. Удобно проверить, есть ли объект.', 'Первый байт приходит через ≈ 20–80 мс, зато параллельных запросов — тысячи.', 'Лимит — ≈ 3 500 записей и 5 500 чтений в секунду на префикс; нагрузку раскладывают по префиксам.'],
        watch: 'Диалог клиента и S3 по шагам: запрос, ответ, заголовки. Цифры — настоящие заголовки ответа.',
        real: 'S3 API стал стандартом: его понимают MinIO, Ceph, Yandex Object Storage, Cloudflare R2. С 2020 года S3 строго согласован: после PUT объект сразу виден в GET и LIST.'
      },
      multi: {
        name: 'Загрузка частями',
        an: 'Как <b>переезд в нескольких машинах</b>: вещи везут параллельно, а если одна машина сломалась, перевозят только её груз, а не всё заново.',
        pl: 'Большой файл грузят частями по 5 МБ – 5 ГБ, параллельно. Каждая часть — отдельный запрос со своим номером. Упала часть — повторяют её одну. В конце S3 склеивает части в один объект.',
        how: ['CreateMultipartUpload → S3 возвращает UploadId.', 'Файл режут на части, например 48 × 50 МБ. Каждая — UploadPart с номером 1…48.', 'Части грузят параллельно (по 4–8): канал используется полностью.', 'Каждая часть возвращает свой ETag. Упала часть — повторяют только её.', 'CompleteMultipartUpload со списком номеров и ETag — объект появляется сразу целиком.', 'Брошенные загрузки занимают место: правило AbortIncompleteMultipartUpload чистит их через 7 дней.'],
        watch: 'Сетка из 48 частей видео: синие — летят, зелёные — загружены, красная — упала и повторяется. В конце — склейка и новый объект в бакете.',
        real: 'Часть от 5 МБ до 5 ГБ, до 10 000 частей, объект до 5 ТБ. AWS CLI и SDK делают это сами (порог multipart_threshold = 8 МБ). Клиент в браузере может грузить части по подписанным ссылкам.'
      },
      presign: {
        name: 'Подписанная ссылка',
        an: 'Как <b>пропуск на склад на одно имя и на час</b>: охранник выдал бумажку с подписью, и курьер сам отвозит коробку на склад, не таская её через офис.',
        pl: 'Сервис не пропускает файлы через себя. Он подписывает своим ключом временную ссылку «можно положить вот такой объект до 12:45» и отдаёт её клиенту. Клиент грузит файл прямо в S3. Ссылку нельзя подделать и нельзя использовать после срока.',
        how: ['Клиент: POST /api/uploads {"name": "IMG_4821.jpg", "size": 2400000}.', 'Сервис проверяет права и лимиты, выбирает ключ и подписывает URL (HMAC-SHA256 своим секретом).', 'В ссылке: метод PUT, ключ, срок X-Amz-Expires=900, подпись X-Amz-Signature.', 'Клиент делает PUT по ссылке прямо в S3. Сервис не видит ни байта.', 'S3 проверяет подпись и срок; просрочено или подделано — 403 Forbidden.', 'О новом объекте S3 сообщает событием (s3:ObjectCreated) в очередь — дальше обработка.'],
        watch: 'Три шага стрелками: запрос ссылки, ответ с подписью, загрузка мимо сервиса. Ниже — разобранная ссылка. Через какое-то время ссылка истекает, и повторный PUT получает 403.',
        real: 'AWS SDK: generatePresignedUrl / presigned_url, срок до 7 дней (SigV4). Паттерн называется Valet Key. Для браузерных форм есть presigned POST с ограничением размера и типа.'
      },
      classes: {
        name: 'Классы хранения',
        an: 'Как <b>гардероб, антресоль и дача</b>: что носишь — в шкафу под рукой, зимнее — на антресоли, старые фотоальбомы — на даче: хранить почти бесплатно, но ехать за ними долго.',
        pl: 'Один и тот же объект можно хранить в разных классах. Чем реже он нужен, тем дешевле хранение, но дороже и дольше чтение. Класс выбирают при записи или меняют правилом жизненного цикла.',
        how: ['<b>Стандарт</b>: $0,023 за ГБ в месяц, чтение мгновенное и без доплаты.', '<b>Редкий доступ</b>: $0,0125, но за каждый прочитанный ГБ +$0,01 и минимум 30 дней хранения.', '<b>Архив с быстрым чтением</b>: $0,004, чтение за миллисекунды, но дорого (+$0,03 за ГБ), минимум 90 дней.', '<b>Глубокий архив</b>: $0,00099 — в 23 раза дешевле стандарта, но объект сначала восстанавливают (RestoreObject) 12–48 часов.', 'Переезд между классами не меняет ключ — меняется только цена и способ чтения.', 'Мелкие объекты в дешёвых классах невыгодны: минимум 128 КБ на объект и плата за каждый переход.'],
        watch: 'Четыре полки справа: сколько данных в каждом классе и сколько это стоит в месяц. Цветная метка класса стоит и у каждого объекта в списке. На облачных уровнях класс задаёт настройка узла «Класс хранения».',
        knobs: ['sclass', 'lifecycle'],
        real: 'AWS S3: Standard, Standard-IA, One Zone-IA, Glacier Instant/Flexible Retrieval, Deep Archive, Intelligent-Tiering (переносит сам по статистике обращений). У Yandex Object Storage — стандартное, холодное и ледяное хранилище.'
      },
      life: {
        name: 'Жизненный цикл',
        an: 'Как <b>правило «через месяц — на антресоль, через полгода — на дачу, через год — выбросить»</b>: никто не разбирает шкаф руками, всё происходит по календарю.',
        pl: 'Правило жизненного цикла по префиксу и возрасту само переводит объекты в дешёвые классы и удаляет ненужное: старые сырые видео, брошенные загрузки, старые версии. Хранение дешевеет в разы без единой строчки кода.',
        knobs: ['lifecycle', 'sclass'],
        how: ['Правило задают на бакет: фильтр по префиксу или тегу и список действий по возрасту.', 'Transition: через 30 дней → Редкий доступ, через 180 → Глубокий архив.', 'Expiration: videos/raw/ удалять через 365 дней — после перекодирования оригинал не нужен.', 'NoncurrentVersionExpiration: старые версии удалять через 30 дней.', 'AbortIncompleteMultipartUpload: брошенные загрузки — через 7 дней.', 'S3 применяет правила раз в сутки, асинхронно; переход оплачивается за каждый объект.'],
        watch: 'Время ускорено: возраст объектов растёт, их классы меняются по правилу, полки справа наполняются, а счёт за хранение падает. Правило выключается кнопкой справа (на облачных уровнях — это настройка узла «Правила жизненного цикла»).',
        real: 'Пример: фото после 30 дней читают в 10–20 раз реже — их держат в Standard-IA. Логи и бэкапы — сразу в Glacier. Если старые фото всё же иногда открывают, вместо глубокого архива берут Glacier Instant Retrieval: $4 за ТБ, но чтение за миллисекунды. Правило в JSON: Rules: [{ Filter: { Prefix: "videos/raw/" }, Transitions: [...], Expiration: { Days: 365 } }].'
      },
      ver: {
        name: 'Версии объектов',
        an: 'Как <b>история изменений документа</b>: новая правка не стирает старую, а кладётся поверх. Удаление — это наклейка «удалено», которую можно снять.',
        pl: 'С включёнными версиями каждый PUT по тому же ключу создаёт новую версию, а старые остаются. DELETE не стирает, а ставит маркер удаления. Любую версию можно прочитать по её VersionId или вернуть.',
        how: ['Versioning: Enabled на бакете. У каждого объекта появляется VersionId.', 'PUT avatars/u55120.jpg второй раз — новая текущая версия, старая стала «нетекущей».', 'GET без параметров отдаёт текущую версию; GET ?versionId=… — любую старую.', 'DELETE без versionId ставит маркер удаления: GET отвечает 404, но данные целы.', 'Восстановить — удалить маркер или скопировать нужную версию поверх.', 'Каждая версия оплачивается как отдельный объект — поэтому правило NoncurrentVersionExpiration.'],
        watch: 'Стопка версий одного ключа: каждый PUT кладёт новую сверху, DELETE — маркер. Без версий новая запись стирает старую навсегда.',
        real: 'S3 Versioning + MFA Delete и Object Lock (защита от удаления, в том числе от шифровальщиков). Репликация между регионами (CRR) требует включённых версий.'
      },
      cost: {
        name: 'Цена',
        an: 'Как <b>камера хранения с тарифом</b>: платишь за место по дням, за каждую выдачу по номерку и — дороже всего — за вывоз вещей за ворота.',
        pl: 'Счёт S3 складывается из трёх частей: хранение (за ГБ в месяц), запросы (за каждую тысячу PUT и GET) и исходящий трафик в интернет (за каждый ГБ, отданный наружу). Для популярного контента трафик — самая большая строка.',
        how: ['Хранение: $0,023 за ГБ в месяц в стандартном классе.', 'Запросы: PUT и LIST — $0,005 за 1 000, GET — $0,0004 за 1 000.', 'Исходящий трафик в интернет: ≈ $0,09 за ГБ. Входящий — бесплатно.', 'CDN перед S3 берёт почти весь трафик на себя: из S3 уходит только то, чего нет в кэше краёв.', 'Трафик из S3 в CDN того же облака часто бесплатный или дешевле.', 'Классы и жизненный цикл снижают строку «хранение», CDN — строку «трафик».'],
        watch: 'Счёт за месяц по строкам, посчитанный из нагрузки площадки: хранение, запросы, трафик. Рядом — сколько стоил бы трафик без CDN.',
        knobs: ['sclass', 'lifecycle'],
        real: 'Цены AWS S3 us-east-1 на 2026 год (порядок такой же у других облаков). Cloudflare R2 не берёт плату за исходящий трафик — поэтому популярен для медиа. В площадке цена S3 — фиксированные $90 в месяц, а здесь — полный расчёт.'
      }
    },
    legend: [['read', 'GET: чтение объекта'], ['sq xs3-swu', 'PUT: загрузка, часть файла'], ['ok', 'Ответ 200 OK'], ['sq xs3-sw0', 'Класс «Стандарт»'], ['sq xs3-sw1', 'Класс «Редкий доступ»'], ['sq xs3-sw2', 'Архив с быстрым чтением'], ['sq xs3-sw3', 'Глубокий архив'], ['accent', 'Подписанная ссылка'], ['bad', 'Ошибка части, 403, 404']],
    live: (n, r, all) => {
      const l = r.load || {}, g = l.static || 0, u = (l.upload || 0) + (l.blob || 0), lv = (SD.app && SD.app.A && SD.app.A.level) || {}, cl = lv.sandbox || (lv.features || []).includes('cloud');
      const out = [['GET', SD.fmt.num(g) + '/с', ''], ['PUT', SD.fmt.num(u) + '/с', '']];
      const arch = cl && n.props.sclass === 'arch' && !n.props.lifecycle;
      if (cl) out.push(['Класс', n.props.lifecycle ? 'по правилу' : ({ std: 'стандарт', ia: 'редкий доступ', arch: 'архив: чтение часами' }[n.props.sclass] || 'стандарт'), arch ? 'bad' : '']);
      else out.push(['Задержка', '≈ 30 мс до первого байта', '']);
      if (cl && r.cost) out.push(['Счёт S3', '$' + nf(r.cost) + '/мес', '']);
      return out;
    },

    mount(ctx) {
      ctx.svg.innerHTML = '<g id="xs3St"></g><g id="xs3Dy" class="xs3-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xs3St'), gDy = ctx.svg.querySelector('#xs3Dy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {}, opt: { life: false, ver: true }, day: 0, arch: [] };
      const P = () => ctx.node.props;
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const pop = (x, y, txt, cls) => { if (S.fx.some(f => f.txt === txt && S.t - f.t0 < 700)) return; S.fx.push({ x, y, txt, cls: cls || '', t0: S.t }); if (S.fx.length > 8) S.fx.shift(); };
      const L = () => (SD.app && SD.app.A && SD.app.A.level) || {};
      const isVideo = () => L().id === 'video';
      const objSize = () => isVideo() ? 1.1e6 : 3.2e5;     // средний размер отдаваемого объекта: сегмент видео или сжатое фото
      const upSize = () => isVideo() ? 1.2e9 : 2.4e6;      // средний размер загрузки
      const ld = () => ctx.res.load || {};
      const getRps = () => ld().static || 0, putRps = () => (ld().upload || 0) + (ld().blob || 0);
      const nb = () => {
        const ins = ctx.ins().map(x => x.n);
        return { cdn: ins.find(k => k.type === 'cdn') || null, app: ins.find(k => k.type === 'app' || k.type === 'faas') || SD.app.A.graph.nodes.find(k => k.type === 'app') || null, worker: ins.find(k => k.type === 'worker') || null, client: ins.find(k => k.type === 'client') || null };
      };
      const cdnHit = c => c ? ({ min: 0.8, hour: 0.93, day: 0.97 }[c.props.ttl] || 0.93) : 0;
      const viaCdnFactor = c => c ? (1 - cdnHit(c)) * (c.props.shield ? 0.4 : 1) : 1;
      // настройки узла «Класс хранения» и «Правила жизненного цикла» видны на облачных уровнях; на остальных — кнопка на картинке
      const cloudOn = () => { const l = L(); return !!(l.sandbox || (l.features || []).includes('cloud')); };
      const lifeOn = () => cloudOn() ? !!P().lifecycle : !!S.opt.life;
      const sclass = () => cloudOn() ? (P().sclass || 'std') : 'std';
      const baseCls = () => ({ std: 0, ia: 1, arch: 3 })[sclass()] || 0;
      const SCN = { std: 'Стандарт', ia: 'Редкий доступ', arch: 'Архив' };

      /* ---------- объекты бакета ---------- */
      function reset() {
        Object.assign(S, { t: 0, reqs: [], fx: [], at: 300, upAt: 600, nk: 0, threads: 0, day: 0, mp: null, mpAt: 1200, ver: null, verAt: 900, cfgT: 0, sig: null, hist: [], arch: [] });
        if (!cloudOn()) S.opt.life = S.scn === 'life';
        S.objs = KEYS.map(([k, size, age, type], i) => ({ k, size, age, born: -age, type, cls: clsOf(k, age), t0: -1e9, g: -1e9, i }));
        if (S.scn === 'ver') S.ver = { ph: 0, t0: S.t, list: [{ id: '3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY', t: '12.03.2025', sz: '84 КБ', cur: true }] };
        S.cfg = S.scn;
      }
      function clsOf(k, age) {   // правило: фото 30 дн → IA, 180 дн → глубокий архив; видео 30 дн → IA; бэкапы сразу в архив. Без правила — класс из настройки
        if (k.startsWith('backups/')) return 3;
        if (!lifeOn()) return baseCls();
        if (k.startsWith('videos/')) return age >= 30 ? 1 : 0;
        return age >= 180 ? 3 : age >= 30 ? 1 : 0;
      }

      /* ---------- запросы ---------- */
      const cliOut = [CL.x + CL.w, CL.y + 50], cliIn = [CL.x + CL.w, CL.y + 90], svP = [SV.x + SV.w, SV.y + 60], cdP = [CD.x + CD.w, CD.y + 50];
      const rowMid = i => BK.y + 70 + i * RH - 3;
      function spawnGet() {
        const n = nb(), pool = S.objs.slice(0, 9).filter(o => !o.k.startsWith('backups/') && !o.exp);
        if (!pool.length) return;
        const o = Math.random() < 0.8 ? pool[Math.floor(Math.random() * Math.min(3, pool.length))] : pool[Math.floor(Math.random() * pool.length)];   // читают в основном свежее
        const src = n.cdn ? cdP : cliIn, i = S.objs.indexOf(o), y = rowMid(i);
        S.reqs.push({ k: 'get', o, ph: 'go', p0: S.t, dur: 520, pts: [src, [BK.x - 6, src[1]], [BK.x + 10, y]], back: [[BK.x + 10, y], [BK.x - 6, src[1] + 8], [src[0], src[1] + 8]] });
      }
      function spawnPut(thru) {
        const k = NEWK[S.nk++ % NEWK.length], o = { k, size: 1.8e6 + Math.random() * 1e6, age: 0, born: S.day, type: 'image/jpeg', cls: clsOf(k, 0), t0: S.t, g: -1e9, i: -1 };
        if (thru) {
          S.threads++;
          S.reqs.push({ k: 'put', thru: true, o, ph: 'go', p0: S.t, dur: 600, pts: [cliOut, [SV.x + SV.w / 2, SV.y]], hold: 2600 + Math.random() * 1200 });
        } else {
          S.reqs.push({ k: 'sign', o, ph: 'go', p0: S.t, dur: 420, pts: [[CL.x + 60, CL.y + CL.h], [SV.x + 60, SV.y]] });
        }
      }
      function land(o) {
        o.t0 = S.t; o.born = S.day; o.cls = clsOf(o.k, 0); S.objs.unshift(o); if (S.objs.length > 9) { const old = S.objs.pop(); }
        S.objs.forEach((x, j) => { x.i = j; });
      }
      function reqStep(r) {
        if (S.t < r.p0 + r.dur) return;
        if (r.k === 'get') {
          if (r.ph === 'go') {
            r.ph = 'back'; r.p0 = S.t; r.dur = 520; r.pts = r.back; r.o.g = S.t; S.hist.push({ t: S.t, k: 'get' });
            if (r.o.cls === 3) {   // объект в архиве: прочитать нельзя, пока не восстановят
              r.fail = true; S.arch.push(S.t); const y = rowMid(Math.max(0, S.objs.indexOf(r.o)));
              pop(BK.x + 200, y - 6, '403 InvalidObjectState', 'bad');
              note('arch', `<b>GET не прошёл: объект в глубоком архиве.</b> S3 ответил 403 InvalidObjectState — сначала RestoreObject, ждать 12–48 часов. ${lifeOn() ? 'Так бывает с редкими старыми фото — правило отправило их в архив.' : 'Весь бакет в классе «Архив» — просмотр сломан.'}`, 'bad', 5000);
              if (!lifeOn() && sclass() === 'arch') done('arch');
            }
            return;
          }
          r.gone = true; return;
        }
        if (r.k === 'sign') {
          if (r.ph === 'go') { r.ph = 'url'; r.p0 = S.t; r.dur = 420; r.pts = [[SV.x + 100, SV.y], [CL.x + 100, CL.y + CL.h]]; return; }
          if (r.ph === 'url') { r.k = 'put'; r.ph = 'up'; r.p0 = S.t; r.dur = 900; r.pts = [cliOut, [BK.x - 6, cliOut[1]], [BK.x + 10, rowMid(0)]]; return; }
        }
        if (r.k === 'put') {
          if (r.thru && r.ph === 'go') { r.ph = 'hold'; r.p0 = S.t; r.dur = r.hold; return; }
          if (r.thru && r.ph === 'hold') { r.ph = 'up'; r.p0 = S.t; r.dur = 600; r.pts = [svP, [BK.x - 6, svP[1]], [BK.x + 10, rowMid(0)]]; return; }
          if (r.ph === 'up') { land(r.o); S.hist.push({ t: S.t, k: 'put' }); if (r.thru) { S.threads--; } r.ph = 'ok'; r.p0 = S.t; r.dur = 420; r.pts = r.thru ? [svP, [CL.x + 150, CL.y + CL.h]] : [[BK.x + 10, rowMid(0)], [BK.x - 6, cliOut[1] + 10], [cliOut[0], cliOut[1] + 10]]; return; }
          r.gone = true;
        }
      }

      /* ---------- большое видео: multipart ---------- */
      function mpStep(dt) {
        if (S.scn !== 'multi') return;
        if (!S.mp && S.t >= S.mpAt) { S.mp = { parts: Array.from({ length: 48 }, () => ({ st: 0, t0: 0, tries: 0 })), t0: S.t, failAt: 17, ph: 'up', id: 'VXBsb2FkSWQ9dl85MDAxLm1wNA' }; note('mp0', '<b>CreateMultipartUpload:</b> S3 выдал UploadId. Видео 2,4 ГБ режем на 48 частей по 50 МБ и грузим по 4 одновременно.', '', 0); }
        const m = S.mp; if (!m) return;
        if (m.ph === 'up') {
          const act = m.parts.filter(p => p.st === 1).length;
          m.parts.forEach((p, j) => {
            if (p.st === 1 && S.t >= p.t0 + 900) {
              if (j === m.failAt && p.tries === 1) { p.st = 3; p.fT = S.t; S.flags.mpFail = 1; note('mpf', `<b>Часть ${j + 1} упала</b> (сеть оборвалась). Остальные ${m.parts.filter(x => x.st === 2).length} загруженных частей не трогаем — повторим только её.`, 'warn', 0); }
              else { p.st = 2; p.etag = Math.random().toString(16).slice(2, 10); if (p.tries > 1) { done('multi'); note('mpr', `<b>Часть ${j + 1} загружена со второй попытки.</b> Повтор стоил 50 МБ, а не 2,4 ГБ.`, 'ok', 0); } }
            }
            if (p.st === 3 && S.t >= p.fT + 700) { p.st = 0; }
          });
          let a = m.parts.filter(p => p.st === 1).length;
          for (let j = 0; j < 48 && a < 4; j++) { const p = m.parts[j]; if (p.st === 0) { p.st = 1; p.t0 = S.t; p.tries++; a++; } }
          if (m.parts.every(p => p.st === 2)) { m.ph = 'done'; m.doneT = S.t; land({ k: 'videos/raw/2026/07/14/v_9001.mp4', size: 2.4e9, age: 0, born: S.day, type: 'video/mp4', cls: clsOf('videos/raw/', 0), t0: S.t, g: -1e9 }); note('mpd', '<b>CompleteMultipartUpload:</b> 48 частей склеены — в бакете появился videos/raw/…/v_9001.mp4 (2,4 ГБ). Событие ObjectCreated уйдёт в очередь на перекодирование.', 'ok', 0); }
        }
        if (m.ph === 'done' && S.t - m.doneT > 4500) { S.mp = null; S.mpAt = S.t + 800; S.objs = S.objs.filter(o => !o.k.endsWith('v_9001.mp4')); S.objs.forEach((x, j) => { x.i = j; }); }
      }

      /* ---------- жизненный цикл ---------- */
      function lifeStep(dt) {   // возраст и класс каждого объекта; в «Жизненном цикле» время ускорено
        const life = S.scn === 'life';
        if (life) S.day += dt / 1000 * 30;   // месяц за секунду
        S.objs.forEach((o, j) => {
          const age = S.day - o.born, prev = o.cls;
          o.age = age;
          if (!life) { o.cls = clsOf(o.k, age); return; }
          if (lifeOn() && o.k.startsWith('videos/raw/') && age >= 365) { if (!o.exp) { S.flags.deep = 1; note('exp', `<b>Правило удалило</b> ${ES(cut(o.k, 34))}: сырому видео год, перекодированные копии остались.`, 'ok', 0); } o.exp = true; } else o.exp = false;
          o.cls = clsOf(o.k, age);
          if (o.cls > prev && lifeOn()) { o.t0 = S.t; o.mv = prev; if (o.cls >= 2 && !o.k.startsWith('backups/')) S.flags.deep = 1; note('mv' + o.cls, `<b>Правило перенесло</b> ${ES(cut(o.k, 34))} в класс «${CLS[o.cls].name}»: хранение ${o.cls === 1 ? 'почти вдвое' : o.cls === 2 ? 'в 6 раз' : 'в 23 раза'} дешевле.`, 'ok', 4000); }
        });
        if (S.flags.deep && S.flags.noLife) done('life');
      }

      /* ---------- версии ---------- */
      const VIDS = ['3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY', 'wxBoq4SQ.5MKTPhWbEjxAjm0Ixp_XQzK', 'Wd0GkvH7_9eN8m0aiqoqT1TlDQ3E8iwP', 'null-marker:uRHzF2yvYq2'];
      function verStep() {
        if (S.scn !== 'ver') return;
        const v = S.ver, u = S.t - v.t0, on = S.opt.ver;
        const at = [1500, 4000, 6500, 9500, 13500];
        if (v.ph === 0 && u > at[0]) { v.ph = 1; addVer('avatar_new.jpg', '91 КБ'); }
        if (v.ph === 1 && u > at[1]) { v.ph = 2; addVer('avatar_sea.jpg', '77 КБ'); }
        if (v.ph === 2 && u > at[2]) {
          v.ph = 3;
          if (on) { v.list.forEach(x => { x.cur = false; }); v.list.unshift({ id: 'DelMarker.Gx4Yn0', marker: true, cur: true, t: '14.07.2026' }); note('vdm', '<b>DELETE avatars/u55120.jpg</b> — версии включены, поэтому S3 положил маркер удаления. GET отвечает 404, но все три картинки на месте.', 'warn', 0); }
          else { v.list = []; v.gone = true; note('vdl', '<b>DELETE avatars/u55120.jpg</b> — версии выключены: объект удалён навсегда. Вернуть нечем.', 'bad', 0); }
        }
        if (v.ph === 3 && u > at[3]) {
          v.ph = 4;
          if (on) { v.list = v.list.filter(x => !x.marker); v.list[0].cur = true; done('restore'); note('vrs', '<b>Восстановили:</b> DELETE ?versionId=DelMarker.Gx4Yn0 — удалили сам маркер, и текущей снова стала последняя версия. Можно и скопировать любую старую версию поверх.', 'ok', 0); }
          else note('vrn', '<b>Восстанавливать нечего:</b> без версий каждая запись стирала предыдущую, а DELETE стёр последнюю.', 'bad', 0);
        }
        if (v.ph === 4 && u > at[4]) { S.ver = { ph: 0, t0: S.t, list: [{ id: VIDS[0], t: '12.03.2025', sz: '84 КБ', cur: true }] }; }
      }
      function addVer(name, sz) {
        const v = S.ver, on = S.opt.ver;
        if (on) { v.list.forEach(x => { x.cur = false; }); v.list.unshift({ id: VIDS[v.list.length] || 'v' + v.list.length, t: '14.07.2026', sz, cur: true, name }); note('vp' + v.list.length, `<b>PUT avatars/u55120.jpg</b> (${name}) — новая версия ${VIDS[v.list.length - 1].slice(0, 10)}…, старая осталась нетекущей.`, '', 0); }
        else { v.list = [{ id: 'null', t: '14.07.2026', sz, cur: true, name }]; S.flags.overwrite = 1; note('vow', `<b>PUT avatars/u55120.jpg</b> (${name}) — версии выключены: старая картинка перезаписана, её больше нет.`, 'warn', 0); }
      }

      /* ---------- счёт ---------- */
      function bill() {
        const n = nb(), g = getRps(), p = putRps(), f = viaCdnFactor(n.cdn), total = n.cdn ? g / Math.max(0.01, f) : g;
        const lv = L(), cl = cloudOn() && lv.storeTb, life = lifeOn(), bc = baseCls();
        const stored = cl ? lv.storeTb * 1e12 : Math.max(1, p) * upSize() * 86400 * 365 * 1.3;   // облачный уровень: объём задан; иначе ≈ полтора года загрузок
        const mix = life ? [0.1, 0.4, 0, 0.5] : [0, 1, 2, 3].map(i => i === bc ? 1 : 0);   // как в площадке (cloud.js)
        const reads = g + (cl ? (ld().blob || 0) : 0);
        const fetch = !life && sclass() === 'ia' ? reads * MONTH * (cl ? 2e5 : objSize()) / 1e9 * 0.01 : 0;   // плата за извлечение из «Редкого доступа»
        const storage = stored / 1e9 * mix.reduce((s, w, i) => s + w * CLS[i].price, 0) + fetch;
        const reqs = (p * MONTH / 1000) * 0.005 + (g * MONTH / 1000) * 0.0004;
        const egress = g * objSize() * MONTH / 1e9 * 0.09, egressNo = total * objSize() * MONTH / 1e9 * 0.09;
        return { stored, mix, storage, fetch, reqs, egress, egressNo, cdn: !!n.cdn, f, total, storageStd: stored / 1e9 * 0.023, life, cl };
      }

      /* ---------- кнопки на картинке ---------- */
      const btn = (x, y, w, k, label, on) => `<g class="xs3-btn${on ? ' on' : ''}" data-xs3="${k}" tabindex="0" role="button"><rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="22" rx="11"/><text x="${f1(x + w / 2)}" y="${f1(y + 15)}">${label}</text></g>`;
      function onClick(e) {
        const b = e.target.closest('[data-xs3]'); if (!b) return;
        const k = b.dataset.xs3;
        if (k === 'life') {
          const nv = !lifeOn();
          if (cloudOn()) ctx.setProp('lifecycle', nv); else S.opt.life = nv;
          if (!nv) S.flags.noLife = 1;
          ctx.log(`<b>Правило жизненного цикла ${nv ? 'включено' : 'выключено'}.</b> ${nv ? 'Старые объекты переезжают в дешёвые классы.' : `Все объекты остаются в классе «${CLS[baseCls()].name}» — смотри счёт.`}`, 'chg');
          if (S.flags.deep && S.flags.noLife) done('life');
        }
        if (k === 'ver') { S.opt.ver = !S.opt.ver; ctx.log(`<b>Версии ${S.opt.ver ? 'включены' : 'выключены'}.</b> Сценарий начинается заново.`, 'chg'); S.ver = { ph: 0, t0: S.t, list: [{ id: S.opt.ver ? VIDS[0] : 'null', t: '12.03.2025', sz: '84 КБ', cur: true }] }; if (!S.opt.ver) S.flags.verOff = 1; }
        e.stopPropagation();
      }
      function onKey(e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-xs3]')) { e.preventDefault(); onClick(e); } }
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- отрисовка общей картинки ---------- */
      function badges() {
        const b = bill(), bs = [['api', 'PUT, GET, LIST', `GET ${SD.fmt.num(getRps())}/с · PUT ${SD.fmt.num(putRps())}/с`], ['presign', 'ПОДПИСАННАЯ ССЫЛКА', S.scn === 'thru' ? 'нет: файлы через сервис' : 'загрузка мимо сервиса'], ['ver', 'ВЕРСИИ', S.scn === 'ver' ? (S.opt.ver ? 'включены' : 'выключены') : 'история изменений'], ['cost', 'ЦЕНА В МЕСЯЦ', usd(b.storage + b.reqs + b.egress)]];
        const w = (984 - 240 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xs3-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xs3-go');
        bs.forEach(([k, t, v], i) => { const x = 240 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xs3-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(cut(v, 30)), 'xr-s')}</g>`; });
        return s;
      }
      function leftCol() {
        const n = nb(), thru = S.scn === 'thru';
        let s = R(CL.x, CL.y, CL.w, CL.h, 'xr-box', 12) + T(CL.x + 12, CL.y + 22, 'Пользователи', 'xr-t');
        s += T(CL.x + 12, CL.y + 44, `смотрят: ≈ ${SD.fmt.num(n.cdn ? bill().total : getRps())} файлов/с`, 'xr-s') + T(CL.x + 12, CL.y + 62, `грузят: ≈ ${SD.fmt.num(putRps())} в секунду`, 'xr-s');
        s += T(CL.x + 12, CL.y + 84, isVideo() ? 'видео ≈ 1,2 ГБ' : 'фото ≈ 2,4 МБ', 'xr-m acc') + T(CL.x + 12, CL.y + 104, thru ? 'шлют файл сервису' : 'грузят по ссылке прямо в S3', 'xr-s' + (thru ? ' xs3-warn' : ' xs3-ok'));
        const ap = n.app, go = ap && ctx.canGo(ap.id), cap = 40, busy = clamp(S.threads, 0, cap);
        s += `<g class="xr-part" data-xpart="presign">${R(SV.x, SV.y, SV.w, SV.h, 'xr-box' + (thru && busy > 30 ? ' bad' : thru && busy > 20 ? ' hot' : ''), 12)}`;
        s += T(SV.x + 12, SV.y + 22, ES(cut(ap ? ctx.nm(ap.id) : 'Сервис', 20)), 'xr-t') + T(SV.x + 12, SV.y + 42, thru ? 'принимает файлы сам:' : 'только подписывает ссылки:', 'xr-s');
        if (thru) {
          s += T(SV.x + 12, SV.y + 62, `заняты байтами ${busy} из ${cap} потоков`, 'xr-s' + (busy > 20 ? ' xs3-warn' : ''));
          for (let j = 0; j < cap; j++) s += R(SV.x + 12 + (j % 20) * 9.2, SV.y + 70 + Math.floor(j / 20) * 10, 7, 7, 'xs3-th' + (j < busy ? ' on' : ''), 1.5);
          s += T(SV.x + 12, SV.y + 108, 'трафик ×2: принять и отправить', 'xs3-ms xs3-warn');
        } else {
          s += MONO(SV.x + 12, SV.y + 62, 'PUT …/IMG_5120.jpg?') + MONO(SV.x + 12, SV.y + 78, 'X-Amz-Expires=900&') + MONO(SV.x + 12, SV.y + 94, 'X-Amz-Signature=9f2c…', 'on');
          s += T(SV.x + 12, SV.y + 112, 'клик — как это работает ›', 'xs3-ms xs3-go');
        }
        s += '</g>';
        const c = n.cdn;
        s += `<g${c && ctx.canGo(c.id) ? ` class="xr-go" data-xgo="${c.id}"` : ''}>${R(CD.x, CD.y, CD.w, CD.h, 'xr-box' + (c ? '' : ' xs3-off'), 12)}`;
        if (c) s += T(CD.x + 12, CD.y + 22, ES(cut(ctx.nm(c.id), 20)), 'xr-t') + T(CD.x + 12, CD.y + 42, `попаданий ≈ ${Math.round(cdnHit(c) * 100)} %${c.props.shield ? ' + shield' : ''}`, 'xr-s xs3-ok') + T(CD.x + 12, CD.y + 60, `в S3 доходит ${Math.round(viaCdnFactor(c) * 100)} % чтений`, 'xr-s') + T(CD.x + 12, CD.y + 78, 'остальное — из кэша краёв', 'xr-s') + T(CD.x + 12, CD.y + 100, 'клик — внутрь CDN ›', 'xs3-ms xs3-go');
        else s += T(CD.x + 12, CD.y + 22, 'CDN нет', 'xr-t') + T(CD.x + 12, CD.y + 42, 'каждый просмотр — GET в S3', 'xr-s xs3-warn') + T(CD.x + 12, CD.y + 60, 'и исходящий трафик из S3', 'xr-s') + T(CD.x + 12, CD.y + 78, 'по $0,09 за ГБ', 'xr-s');
        return s + '</g>';
      }
      function bucketSvg() {
        let s = `<g class="xr-part" data-xpart="bucket">${R(BK.x, BK.y, BK.w, BK.h, 'xr-zone', 14)}`;
        s += T(BK.x + 12, BK.y + 20, 's3://media-prod/', 'xr-m acc') + T(BK.x + BK.w - 12, BK.y + 20, isVideo() ? 'видеохостинг · eu-central-1' : 'фотохостинг · eu-central-1', 'xr-s', 'end');
        s += T(BK.x + 14, BK.y + 42, 'ключ', 'xs3-fn') + T(BK.x + 296, BK.y + 42, 'размер', 'xs3-fn') + T(BK.x + 356, BK.y + 42, 'класс', 'xs3-fn') + T(BK.x + BK.w - 14, BK.y + 42, 'возраст', 'xs3-fn', 'end') + '</g>';
        const rows = S.objs.slice(0, S.scn === 'multi' || S.scn === 'ver' ? 5 : 9);
        rows.forEach((o, j) => {
          const y = BK.y + 70 + j * RH, fl = S.t - o.t0 < 900, gl = S.t - o.g < 500;
          s += R(BK.x + 8, y - 15, BK.w - 16, 24, 'xs3-row' + (fl ? ' new' : gl ? ' get' : '') + (o.exp ? ' exp' : ''), 5);
          s += MONO(BK.x + 14, y + 1, ES(cut(o.k, 42)), o.exp ? 'dim' : '') + T(BK.x + 296, y + 1, byt(o.size), 'xs3-ms');
          s += `<g class="xr-part" data-xpart="classes">${R(BK.x + 352, y - 10, 58, 15, 'xs3-cls c' + o.cls + (S.t - o.t0 < 1200 && o.mv != null ? ' fl' : ''), 4)}${T(BK.x + 381, y + 1, ['STD', 'IA', 'GL-IR', 'DEEP'][o.cls], 'xs3-cl', 'middle')}</g>`;
          s += T(BK.x + BK.w - 14, y + 1, o.exp ? 'удалён' : o.age < 1 ? 'сейчас' : `${Math.floor(o.age)} дн`, 'xs3-ms' + (o.exp ? ' xs3-bad' : ''), 'end');
        });
        if (S.scn === 'multi') s += mpSvg();
        if (S.scn === 'ver') s += verSvg();
        return s;
      }
      function mpSvg() {
        const m = S.mp, y0 = BK.y + 222, x0 = BK.x + 12;
        let s = `<g class="xr-part" data-xpart="multi">${R(BK.x + 6, y0 - 22, BK.w - 12, 184, 'xs3-panel', 10)}`;
        s += T(x0, y0 - 4, 'MULTIPART: videos/raw/2026/07/14/v_9001.mp4 · 2,4 ГБ', 'xr-m acc');
        if (!m) return s + T(x0, y0 + 30, 'пользователь выбирает файл…', 'xr-s') + '</g>';
        s += MONO(x0, y0 + 14, `UploadId=${m.id}`);
        m.parts.forEach((p, j) => { const x = x0 + (j % 16) * 28.5, y = y0 + 26 + Math.floor(j / 16) * 30; s += R(x, y, 24, 24, 'xs3-part p' + p.st, 4) + T(x + 12, y + 16, String(j + 1), 'xs3-pn', 'middle'); if (p.st === 1) { const k = clamp((S.t - p.t0) / 900, 0, 1); s += R(x, y + 21, 24 * k, 3, 'xs3-pbar', 1); } });
        const dn = m.parts.filter(p => p.st === 2).length;
        s += T(x0, y0 + 136, m.ph === 'done' ? 'CompleteMultipartUpload → объект склеен из 48 частей' : `загружено ${dn} из 48 · в полёте ${m.parts.filter(p => p.st === 1).length} · ${byt(dn * 5e7)} из 2,4 ГБ`, 'xr-s' + (m.ph === 'done' ? ' xs3-ok' : ''));
        s += T(x0, y0 + 156, m.parts.some(p => p.st === 3) ? `часть ${m.failAt + 1} упала — повторяем только её (50 МБ)` : 'каждая часть возвращает свой ETag; упала — повторяем её одну', 'xs3-ms' + (m.parts.some(p => p.st === 3) ? ' xs3-bad' : ''));
        return s + '</g>';
      }
      function verSvg() {
        const v = S.ver, y0 = BK.y + 222, x0 = BK.x + 12, on = S.opt.ver;
        let s = `<g class="xr-part" data-xpart="ver">${R(BK.x + 6, y0 - 22, BK.w - 12, 184, 'xs3-panel', 10)}`;
        s += T(x0, y0 - 4, 'ВЕРСИИ КЛЮЧА avatars/u55120.jpg', 'xr-m ' + (on ? 'acc' : 'warn'));
        s += '</g>' + btn(BK.x + BK.w - 138, y0 - 18, 126, 'ver', on ? '✓ версии: вкл' : '✕ версии: выкл', on);
        if (!v.list.length) s += R(x0, y0 + 20, BK.w - 24, 28, 'xs3-ver gone', 6) + T(x0 + 10, y0 + 39, 'объекта нет — и вернуть его нечем', 'xr-s xs3-bad');
        v.list.slice(0, 4).forEach((x, j) => {
          const y = y0 + 20 + j * 34;
          s += R(x0, y, BK.w - 24, 30, 'xs3-ver' + (x.marker ? ' mk' : x.cur ? ' cur' : ''), 6);
          s += T(x0 + 10, y + 14, x.marker ? 'маркер удаления' : x.cur ? 'текущая версия' : 'нетекущая', 'xs3-fn' + (x.marker ? ' xs3-bad' : x.cur ? ' xs3-ok' : ''));
          s += MONO(x0 + 10, y + 27, `VersionId=${cut(x.id, 34)}`) + T(x0 + BK.w - 36, y + 14, `${x.t || ''}${x.sz ? ' · ' + x.sz : ''}`, 'xs3-ms', 'end');
        });
        const ops = ['было', 'PUT new', 'PUT sea', 'DELETE', on ? 'вернуть' : '—'];
        s += T(x0, y0 + 12, 'шаг: ' + ops.map((o, j) => j === v.ph ? `[${o}]` : o).join(' → '), 'xs3-ms');
        return s;
      }
      function shelves() {
        const b = bill(), life = b.life;
        let s = `<g class="xr-part" data-xpart="classes">${R(SH.x, SH.y, SH.w, SH.h, 'xr-box', 12)}`;
        s += T(SH.x + 12, SH.y + 20, 'КЛАССЫ ХРАНЕНИЯ', 'xr-m') + T(SH.x + SH.w - 12, SH.y + 20, `всего ${byt(b.stored)}`, 'xs3-ms', 'end');
        CLS.forEach((c, i) => {
          const y = SH.y + 34 + i * 72, w = b.mix[i], cost = b.stored / 1e9 * w * c.price;
          s += R(SH.x + 10, y, SH.w - 20, 56, 'xs3-shelf c' + i, 8) + T(SH.x + 20, y + 17, c.name, 'xs3-fn') + T(SH.x + SH.w - 20, y + 17, `$${String(c.price).replace('.', ',')}/ГБ`, 'xs3-ms', 'end');
          s += R(SH.x + 20, y + 24, SH.w - 40, 8, 'xr-bar', 3) + R(SH.x + 20, y + 24, (SH.w - 40) * w, 8, 'xs3-fill c' + i, 3);
          s += T(SH.x + 20, y + 47, `${byt(b.stored * w)} · ${usd(cost)}/мес`, 'xs3-ms') + T(SH.x + SH.w - 20, y + 47, c.wait, 'xs3-ms' + (i === 3 ? ' xs3-warn' : ''), 'end');
          if (i < 2 && life) s += T(SH.x + SH.w / 2, y + 68, ['↓ через 30 дней', '↓ через 180 дней — в глубокий архив'][i], 'xs3-ms xs3-acc', 'middle');
        });
        s += T(SH.x + 12, SH.y + 326, `хранение: ${usd(b.storage)}/мес`, 'xr-m ' + (life || baseCls() ? 'ok' : 'warn')) + T(SH.x + 12, SH.y + 344, life ? `в «Стандарте» было бы ${usd(b.storageStd)}` : `всё в классе «${CLS[baseCls()].name}»${b.fetch ? ` · извлечение ${usd(b.fetch)}` : ''}`, 'xs3-ms' + (baseCls() === 3 && !life ? ' xs3-bad' : ''));
        s += '</g>';
        if (S.scn === 'life') s += btn(SH.x + 12, SH.y + 354, SH.w - 24, 'life', life ? '✓ правило жизненного цикла: вкл' : '✕ правило выключено', life);
        else if (cloudOn()) s += T(SH.x + 12, SH.y + 372, `настройка узла: ${life ? 'правило вкл' : `класс «${SCN[sclass()]}»`}`, 'xs3-ms xs3-acc');
        return s;
      }
      function bottom() {
        const b = bill(), g = getRps(), p = putRps();
        let s = `<g class="xr-part" data-xpart="cost">${R(BOT.x, BOT.y, BOT.w, BOT.h, 'xr-box', 12)}`;
        s += T(BOT.x + 12, BOT.y + 20, S.scn === 'life' ? `ДЕНЬ ${Math.floor(S.day)} · СЧЁТ ЗА МЕСЯЦ` : 'СЧЁТ ЗА МЕСЯЦ (по нагрузке площадки, цены AWS S3)', 'xr-m');
        const items = [['хранение', b.storage, b.cl ? `${byt(b.stored)} — как в площадке` : b.fetch ? `в т. ч. извлечение ${usd(b.fetch)}` : ''], ['запросы', b.reqs, `${SD.fmt.num(g)} GET и ${SD.fmt.num(p)} PUT в секунду`], ['исходящий трафик', b.egress, b.cdn ? `только промахи CDN: ${Math.round(b.f * 100)} %` : 'каждый просмотр — из S3']];
        const tot = items.reduce((s2, x) => s2 + x[1], 0), mx = Math.max(tot, b.egressNo + b.storage + b.reqs);
        items.forEach(([n, v, d], j) => { const x = BOT.x + 12 + j * 318; s += T(x, BOT.y + 44, n, 'xr-s') + T(x + 300, BOT.y + 44, usd(v), 'xr-m', 'end') + R(x, BOT.y + 52, 300, 8, 'xr-bar', 3) + R(x, BOT.y + 52, 300 * clamp(v / mx, 0, 1), 8, 'xr-bar-f' + (j === 2 && !b.cdn ? ' warn' : ''), 3) + T(x, BOT.y + 76, d, 'xs3-ms'); });
        s += T(BOT.x + 12, BOT.y + 98, `итого ≈ ${usd(tot)} в месяц${b.cdn ? ` · без CDN трафик стоил бы ${usd(b.egressNo)}` : ''}`, 'xr-s' + (b.cdn ? ' xs3-ok' : ' xs3-warn'));
        return s + '</g>';
      }
      function dynSvg() {
        let s = '';
        const rc = SD.kindColor('read'), uc = SD.kindColor('upload');
        S.reqs.forEach(r => {
          const [x, y] = along(r.pts, ease((S.t - r.p0) / r.dur));
          if (r.k === 'get') s += r.ph === 'go' ? Dot(x, y, 4.5, '', `fill:${rc}`) : Dot(x, y, 4.5, r.fail ? 'err' : 'ok');
          else if (r.k === 'sign') s += r.ph === 'go' ? Dot(x, y, 4, '', `fill:${rc}`) : R(x - 9, y - 5, 18, 10, 'xs3-url', 3) + T(x + 13, y + 4, 'URL', 'xs3-pn', '');
          else if (r.k === 'put') {
            if (r.ph === 'hold') { /* файл внутри сервиса: виден по занятым потокам */ }
            else if (r.ph === 'ok') s += Dot(x, y, 4, 'ok');
            else s += R(x - 6, y - 6, 12, 12, 'xs3-up', 2);
          }
        });
        S.fx.forEach(f => { const k = clamp((S.t - f.t0) / 1300, 0, 1); s += `<text class="xr-pop ${f.cls}" x="${f1(f.x)}" y="${f1(f.y - 14 * k)}" text-anchor="middle" opacity="${(1 - k).toFixed(2)}">${ES(f.txt)}</text>`; });
        return s;
      }
      function drawMain() { gSt.innerHTML = badges() + leftCol() + bucketSvg() + shelves() + bottom(); gDy.innerHTML = dynSvg(); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 140, 26, 'xs3-backb', 13)}${T(82, 27, '← всё хранилище', 'xr-s xs3-back', 'middle')}</g>` + T(166, 27, t, 'xs3-vt') + T(166, 46, sub, 'xr-s');
      function seq(x1, x2, y0, names, steps, cyc) {
        const ST = 1000, n = steps.length, len = n * ST + 2000, u = cyc % len, cur = Math.floor(u / ST), f = (u % ST) / ST, dy = 38;
        let s = R(x1 - 80, y0, 160, 30, 'xr-box', 8) + T(x1, y0 + 20, names[0], 'xr-t', 'middle') + R(x2 - 80, y0, 160, 30, 'xr-box', 8) + T(x2, y0 + 20, names[1], 'xr-t', 'middle');
        s += Ln(x1, y0 + 30, x1, y0 + 44 + n * dy, 'xs3-life') + Ln(x2, y0 + 30, x2, y0 + 44 + n * dy, 'xs3-life');
        steps.forEach((st, i) => {
          const y = y0 + 60 + i * dy, state = i < cur ? 'past' : i === cur ? 'now' : 'fut', a = st.r ? x2 : x1, b = st.r ? x1 : x2, k = state === 'now' ? Math.min(1, f * 1.4) : 1;
          s += arrow(a, y, a + (b - a) * k, y, `${st.c || ''} ${state}`);
          s += `<text class="xs3-sl ${state}${st.c ? ' xs3-' + st.c : ''}" xml:space="preserve" x="${f1((x1 + x2) / 2)}" y="${f1(y - 8)}" text-anchor="middle">${ES(st.t)}</text>`;
          if (st.d) s += T((x1 + x2) / 2, y + 14, ES(st.d), 'xs3-ms' + (state === 'fut' ? ' xs3-fut' : ''), 'middle');
        });
        return s;
      }
      function vBucket() {
        let s = head('Бакет, ключи и метаданные', 'папок нет: ключ — просто строка, а «папка» — общий префикс');
        s += R(24, 60, 470, 300, 'xs3-codebg', 10) + T(36, 80, 'ОДИН ОБЪЕКТ', 'xr-m');
        const md = [['Bucket', 'media-prod'], ['Key', 'photos/2026/07/14/u55120/IMG_4821.jpg'], ['Content-Type', 'image/jpeg'], ['Content-Length', '2 418 773'], ['ETag', '"9b2cf535f27731c974343645a3985328"'], ['Last-Modified', 'Tue, 14 Jul 2026 12:31:07 GMT'], ['x-amz-storage-class', 'STANDARD'], ['x-amz-meta-user-id', '55120'], ['x-amz-server-side-encryption', 'AES256']];
        md.forEach(([a, b2], j) => { s += T(36, 106 + j * 26, a, 'xs3-fn') + MONO(220, 106 + j * 26, ES(cut(b2, 40)), j === 1 ? 'on' : ''); });
        s += R(506, 60, 470, 300, 'xs3-panel', 10) + T(518, 80, 'КЛЮЧИ С ОБЩИМ ПРЕФИКСОМ', 'xr-m');
        const ks = ['photos/2026/07/14/u55120/IMG_4821.jpg', 'photos/2026/07/14/u55120/IMG_4822.jpg', 'photos/2026/07/14/u80441/IMG_0093.heic', 'photos/2026/07/15/u12008/IMG_1010.jpg', 'thumbs/2026/07/14/u55120/IMG_4821_400.webp'], pre = 'photos/2026/07/14/';
        const on = Math.floor(S.vt / 2500) % 2;
        ks.forEach((k, j) => { const y = 108 + j * 30, m = on && k.startsWith(pre); if (m) s += R(512, y - 16, 458, 24, 'xs3-krow', 4); s += MONO(520, y, ES(k), m ? 'on' : ''); });
        s += T(518, 270, on ? `LIST prefix=${pre} → 3 ключа` : 'в S3 нет каталогов — все ключи в одном плоском списке', 'xr-s' + (on ? ' xs3-acc' : ''));
        s += T(518, 292, 'консоль рисует «папки», разрезая ключи по «/»', 'xs3-ms') + T(518, 310, 'переименовать «папку» = скопировать каждый объект', 'xs3-ms');
        s += R(24, 372, 952, 176, 'xs3-panel', 10) + T(36, 394, 'ЧТО ВАЖНО ЗНАТЬ', 'xr-m');
        [['Объект неизменяем', 'поменять байт нельзя — только записать объект заново целиком'], ['До 5 ТБ', 'одним PUT — до 5 ГБ, больше — частями (multipart)'], ['11 девяток', 'копии в трёх зонах доступности: потерять объект — раз в 10 тысяч лет на 10 млн объектов'], ['Права', 'бакет закрыт по умолчанию; доступ — политики, IAM, подписанные ссылки'], ['Строгая согласованность', 'после PUT объект сразу виден в GET и LIST (S3 — с декабря 2020)']].forEach(([a, b2], j) => { s += T(36, 420 + j * 24, a, 'xr-m') + T(236, 420 + j * 24, b2, 'xr-s'); });
        return s;
      }
      function vApi() {
        let s = head('PUT, GET, LIST по HTTP', 'весь интерфейс — несколько HTTP-запросов; любой язык и любой клиент');
        const steps = [{ t: 'PUT /photos/…/IMG_4821.jpg  (2,4 МБ)', d: 'Content-Type: image/jpeg' }, { t: '200 OK · ETag: "9b2cf535…"', r: 1, c: 'ok' }, { t: 'GET /photos/…/IMG_4821.jpg', d: 'Range: bytes=0-65535 — только первые 64 КБ' }, { t: '206 Partial Content · 65 536 байт', r: 1, c: 'ok' }, { t: 'GET /?list-type=2&prefix=photos/2026/07/14/', d: 'max-keys=1000' }, { t: '200 OK · 1 000 ключей + NextContinuationToken', r: 1, c: 'ok' }, { t: 'HEAD /avatars/u55120.jpg' }, { t: '404 Not Found', r: 1, c: 'bad' }];
        s += seq(200, 760, 60, ['Клиент', 'S3'], steps, S.vt);
        s += R(24, 410, 952, 138, 'xs3-codebg', 10);
        ['# то же самое из командной строки', 'aws s3api put-object --bucket media-prod --key photos/2026/07/14/u55120/IMG_4821.jpg --body IMG_4821.jpg', 'aws s3api get-object --bucket media-prod --key photos/…/IMG_4821.jpg --range bytes=0-65535 part.bin', 'aws s3api list-objects-v2 --bucket media-prod --prefix photos/2026/07/14/ --max-keys 1000', '# лимиты: ≈ 3 500 PUT/LIST и 5 500 GET в секунду на префикс — нагрузку раскладывают по префиксам'].forEach((l, j) => { s += CODE(36, 434 + j * 22, l, 'sm'); });
        return s;
      }
      function vMulti() {
        const C = 13000, u = S.vt % C, N = 48, k = clamp((u - 800) / 9500, 0, 1);
        let s = head('Загрузка частями (multipart)', 'видео 2,4 ГБ = 48 частей по 50 МБ, по 4 параллельно; упала часть — повторяем только её');
        const steps = [['CreateMultipartUpload', 'UploadId = VXBsb2FkSWQ9…'], ['UploadPart × 48', 'partNumber 1…48, у каждой свой ETag'], ['CompleteMultipartUpload', 'список (номер, ETag) → один объект']];
        steps.forEach(([a, b2], j) => { const on = (j === 0 && u < 800) || (j === 1 && u >= 800 && k < 1) || (j === 2 && k >= 1); s += R(24 + j * 320, 60, 310, 54, 'xs3-step' + (on ? ' on' : ''), 8) + T(36 + j * 320, 82, `${j + 1}. ${a}`, 'xs3-fn') + T(36 + j * 320, 102, b2, 'xs3-ms'); });
        const doneN = Math.floor(k * N), fail = 17;
        for (let j = 0; j < N; j++) {
          const x = 40 + (j % 12) * 76, y = 136 + Math.floor(j / 12) * 54;
          let st = j < doneN ? 2 : j < doneN + 4 ? 1 : 0;
          if (j === fail && k > 0.3 && k < 0.5) st = 3;
          s += R(x, y, 68, 44, 'xs3-part p' + st, 6) + T(x + 8, y + 18, `часть ${j + 1}`, 'xs3-pn') + T(x + 8, y + 34, st === 2 ? `ETag ${(j * 2654435761 >>> 0).toString(16).slice(0, 4)}` : st === 3 ? 'ошибка!' : st === 1 ? 'летит…' : '50 МБ', 'xs3-ms' + (st === 3 ? ' xs3-bad' : st === 2 ? ' xs3-ok' : ''));
        }
        s += T(40, 370, k >= 1 ? 'Готово: S3 склеил части — объект videos/raw/…/v_9001.mp4 появился целиком, сразу.' : k > 0.3 && k < 0.5 ? 'Часть 18 упала: сеть оборвалась. Повторяем только её — 50 МБ, а не 2,4 ГБ.' : `Загружено ${doneN} из 48 · ${byt(doneN * 5e7)}`, 'xr-s' + (k >= 1 ? ' xs3-ok' : k > 0.3 && k < 0.5 ? ' xs3-bad' : ''));
        s += R(24, 386, 952, 162, 'xs3-codebg', 10);
        ['# SDK делает это сам: порог 8 МБ, части по 8 МБ, 10 потоков', 'aws configure set default.s3.multipart_threshold 64MB', 'aws configure set default.s3.multipart_chunksize 50MB', 'aws s3 cp v_9001.mp4 s3://media-prod/videos/raw/2026/07/14/v_9001.mp4', '# брошенные загрузки занимают место — правило: AbortIncompleteMultipartUpload { DaysAfterInitiation: 7 }', '# лимиты: часть 5 МБ – 5 ГБ (кроме последней), до 10 000 частей, объект до 5 ТБ'].forEach((l, j) => { s += CODE(36, 410 + j * 22, l, 'sm'); });
        return s;
      }
      function vPresign() {
        const C = 15000, u = S.vt % C, exp = u > 11000;
        if (exp && u > 12500) S.pv.p403 = 1;
        let s = head('Подписанная ссылка (presigned URL)', 'сервис выдаёт временный пропуск, файл идёт из браузера прямо в S3');
        const A = [120, 120], B = [500, 120], Cc = [880, 120];
        [[A, 'Браузер'], [B, 'Сервис'], [Cc, 'S3']].forEach(([p, n]) => { s += R(p[0] - 90, p[1] - 30, 180, 56, 'xr-box', 10) + T(p[0], p[1] + 4, n, 'xr-t', 'middle'); });
        const step = u < 2500 ? 0 : u < 5000 ? 1 : u < 9000 ? 2 : 3;
        const arr = [[A, B, 'POST /api/uploads {name, size}', 0], [B, A, '201 · url = подписанная ссылка', 1], [A, Cc, 'PUT по ссылке — 2,4 МБ, мимо сервиса', 2], [Cc, A, '200 OK · ETag', 3]];
        arr.forEach(([p, q, t, j]) => { const y = 170 + j * 30, on = j <= step; s += arrow(p[0], y, q[0] + (q[0] > p[0] ? -4 : 4), y, on ? (j === 2 ? 'acc' : 'ok') : 'fut') + T((p[0] + q[0]) / 2, y - 6, t, 'xs3-sl' + (on ? '' : ' fut') + (j === step ? ' now' : ''), 'middle'); });
        if (step === 2) { const k = clamp((u - 5000) / 4000, 0, 1); s += R(A[0] + (Cc[0] - A[0]) * ease(k) - 8, 224, 16, 12, 'xs3-up', 2); }
        s += R(24, 300, 952, 120, 'xs3-codebg', 10) + T(36, 320, 'ССЫЛКА ПО ЧАСТЯМ', 'xr-m');
        const parts = [['https://media-prod.s3.eu-central-1.amazonaws.com/photos/2026/07/14/u55120/IMG_4821.jpg', 'куда', 'on'], ['?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAQ…/20260714/eu-central-1/s3/aws4_request', 'кто подписал', ''], ['&X-Amz-Date=20260714T123000Z&X-Amz-Expires=900', 'с 12:30 на 15 минут', exp ? 'bad' : ''], ['&X-Amz-SignedHeaders=host;content-type&X-Amz-Signature=9f2c41…e7d1', 'HMAC-SHA256 секретом сервиса', '']];
        parts.forEach(([a, b2, c], j) => { s += MONO(36, 342 + j * 18, ES(cut(a, 100)), c) + T(964, 342 + j * 18, b2, 'xs3-ms' + (c === 'bad' ? ' xs3-bad' : ''), 'end'); });
        s += R(24, 432, 952, 116, 'xs3-panel' + (exp ? ' badb' : ''), 10);
        if (exp) s += T(36, 456, '12:46 — ссылка просрочена. Повторный PUT:', 'xr-t') + MONO(36, 480, '403 Forbidden · <Code>AccessDenied</Code><Message>Request has expired</Message>', 'bad') + T(36, 504, 'Подделать ссылку нельзя: поменяй ключ или срок — подпись не сойдётся (SignatureDoesNotMatch).', 'xr-s') + T(36, 526, 'Клиенту нужна новая ссылка — сервис снова проверит права.', 'xs3-ms');
        else s += T(36, 456, 'Почему так лучше', 'xr-t') + T(36, 480, '· сервис не держит поток и канал на всё время загрузки — только подписывает (≈ 1 мс)', 'xr-s') + T(36, 502, '· трафик не идёт дважды: клиент → S3 напрямую', 'xr-s') + T(36, 524, '· S3 потом сообщит событием s3:ObjectCreated — сервис узнает, что файл на месте', 'xr-s');
        return s;
      }
      function vClasses() {
        const b = bill();
        let s = head('Классы хранения', 'чем реже читаем, тем дешевле храним — и тем дороже и дольше читаем');
        CLS.forEach((c, i) => {
          const x = 24 + i * 240, sel = i === Math.floor(S.vt / 2500) % 4;
          s += R(x, 60, 228, 300, 'xs3-shelf c' + i + (sel ? ' sel' : ''), 10) + T(x + 14, 84, c.name, 'xr-t') + MONO(x + 14, 104, c.id);
          s += T(x + 14, 136, 'хранение за ГБ/мес', 'xs3-ms') + T(x + 14, 158, `$${String(c.price).replace('.', ',')}`, 'xs3-big');
          s += T(x + 14, 186, 'чтение за ГБ', 'xs3-ms') + T(x + 14, 206, c.get ? `+$${String(c.get).replace('.', ',')}` : 'бесплатно', 'xr-m');
          s += T(x + 14, 234, 'сколько ждать', 'xs3-ms') + T(x + 14, 254, c.wait === 'мс' ? 'миллисекунды' : c.wait, 'xr-m' + (i === 3 ? ' warn' : ''));
          s += T(x + 14, 284, c.note, 'xs3-ms');
          const h = 40 * c.price / 0.023; s += R(x + 14, 340 - h, 40, h, 'xs3-fill c' + i, 3) + T(x + 62, 336, `×${nf(0.023 / c.price, c.price < 0.005 ? 0 : 1)} дешевле`, 'xs3-ms');
        });
        s += R(24, 372, 952, 176, 'xs3-panel', 10) + T(36, 394, 'ПРИМЕР: 1 ТБ ФОТО, КОТОРЫЕ РАЗ В МЕСЯЦ ЧИТАЮТ НА 5 %', 'xr-m');
        CLS.forEach((c, i) => { const st = 1000 * c.price, rd = 50 * c.get, tot = st + rd; s += T(36, 420 + i * 28, c.name, 'xr-s') + R(240, 410 + i * 28, 560, 12, 'xr-bar', 3) + R(240, 410 + i * 28, 560 * tot / 23, 12, 'xs3-fill c' + i, 3) + T(820, 420 + i * 28, `$${nf(tot, 2)} = хранение $${nf(st, 2)} + чтение $${nf(rd, 2)}`, 'xs3-ms'); });
        return s;
      }
      function vLife() {
        const C = 16000, u = S.vt % C, day = clamp(u / 13000 * 420, 0, 420);
        let s = head('Жизненный цикл', 'правило само переносит старые объекты в дешёвые классы и удаляет ненужное');
        s += R(24, 60, 400, 250, 'xs3-codebg', 10);
        ['{ "Rules": [', '  { "ID": "photos-cooldown", "Filter": { "Prefix": "photos/" },', '    "Transitions": [', '      { "Days": 30,  "StorageClass": "STANDARD_IA" },', '      { "Days": 180, "StorageClass": "DEEP_ARCHIVE" } ] },', '  { "ID": "raw-video", "Filter": { "Prefix": "videos/raw/" },', '    "Transitions": [{ "Days": 30, "StorageClass": "STANDARD_IA" }],', '    "Expiration": { "Days": 365 } },', '  { "ID": "old-versions",', '    "NoncurrentVersionExpiration": { "NoncurrentDays": 30 } },', '  { "ID": "abort-mpu", "AbortIncompleteMultipartUpload":', '    { "DaysAfterInitiation": 7 } } ] }'].forEach((l, j) => { s += CODE(36, 82 + j * 19, l, 'sm'); });
        const X = d => 450 + d * 1.2;
        s += Ln(X(0), 120, X(420), 120, 'xs3-axis');
        [0, 30, 90, 180, 365].forEach(d => { s += Ln(X(d), 114, X(d), 126, 'xs3-tick') + T(X(d), 142, `${d} дн`, 'xs3-ms', 'middle'); });
        s += `<polygon class="xs3-cur" points="${f1(X(day) - 6)},104 ${f1(X(day) + 6)},104 ${f1(X(day))},112"/>` + T(X(day), 96, `возраст ${Math.floor(day)} дн`, 'xr-m acc', 'middle');
        const objs = [['photos/…/IMG_4821.jpg', 'photo'], ['videos/raw/…/v_6120.mp4', 'raw'], ['backups/pg/….dump.zst', 'bak']];   // по тому же правилу, что в JSON слева
        objs.forEach(([k, t], j) => {
          const y = 176 + j * 44, c = t === 'bak' ? 3 : t === 'raw' ? (day >= 365 ? -1 : day >= 30 ? 1 : 0) : day >= 180 ? 3 : day >= 30 ? 1 : 0;
          s += MONO(450, y, ES(k)) + (c < 0 ? T(940, y, 'удалён правилом', 'xs3-ms xs3-bad', 'end') : R(820, y - 13, 120, 18, 'xs3-cls c' + c, 4) + T(880, y, CLS[c].name.split(',')[0], 'xs3-cl', 'middle'));
        });
        const cost = d => d < 30 ? 23 : d < 180 ? 12.5 : 1;
        s += R(24, 322, 952, 226, 'xs3-panel', 10) + T(36, 344, 'ЦЕНА ХРАНЕНИЯ 1 ТБ ФОТО ПО МЕСЯЦАМ, $', 'xr-m');
        const GX = 60, GW = 880, GY = 360, GH = 150, Xd = d => GX + GW * d / 420, Yv = v => GY + GH - GH * v / 25;
        s += Ln(GX, GY + GH, GX + GW, GY + GH, 'xs3-axis') + `<polyline class="xs3-spark st" points="${f1(Xd(0))},${f1(Yv(23))} ${f1(Xd(day))},${f1(Yv(23))}"/>`;
        const pts = []; for (let d = 0; d <= day; d += 5) pts.push(`${f1(Xd(d))},${f1(Yv(cost(d)))}`);
        if (pts.length > 1) s += `<polyline class="xs3-spark" points="${pts.join(' ')}"/>`;
        s += T(Xd(5), Yv(23) - 8, 'без правила: $23', 'xs3-ms') + T(Xd(Math.min(day, 400)), Yv(cost(day)) - 8, `с правилом: $${nf(cost(day), 1)}`, 'xr-m acc', 'end');
        s += T(36, 536, 'Правила применяются раз в сутки, асинхронно; за каждый переход объекта — плата, поэтому мелкие файлы выгоднее оставлять как есть.', 'xs3-ms');
        return s;
      }
      function vVer() {
        const C = 12000, u = S.vt % C, ph = u < 2000 ? 0 : u < 4500 ? 1 : u < 7000 ? 2 : u < 9500 ? 3 : 4;
        let s = head('Версии объектов', 'новая запись не стирает старую, а DELETE ставит маркер — всё можно вернуть');
        const stack = (x, title, on) => {
          let t = R(x, 60, 466, 360, 'xs3-panel' + (on ? ' on' : ''), 10) + T(x + 14, 82, title, 'xr-t');
          const ops = ['PUT avatar.jpg (март)', 'PUT avatar_new.jpg', 'PUT avatar_sea.jpg', 'DELETE avatars/u55120.jpg', on ? 'DELETE маркера → восстановлено' : 'восстановить нечего'];
          t += T(x + 14, 104, `шаг ${ph + 1}: ${ops[ph]}`, 'xr-s xs3-acc');
          let list;
          if (on) { list = [['84 КБ · март', 'v1']]; if (ph >= 1) list.unshift(['91 КБ · new', 'v2']); if (ph >= 2) list.unshift(['77 КБ · sea', 'v3']); if (ph === 3) list.unshift(['маркер удаления', 'mk']); }
          else list = ph >= 3 ? [] : [[['84 КБ · март', '91 КБ · new', '77 КБ · sea'][ph], 'null']];
          list.forEach(([a, b2], j) => { const y = 124 + j * 56, cur = j === 0; t += R(x + 14, y, 438, 46, 'xs3-ver' + (b2 === 'mk' ? ' mk' : cur ? ' cur' : ''), 6) + T(x + 26, y + 20, b2 === 'mk' ? 'маркер удаления — GET вернёт 404' : `${cur ? 'текущая' : 'нетекущая'}: ${a}`, 'xs3-fn' + (b2 === 'mk' ? ' xs3-bad' : cur ? ' xs3-ok' : '')) + MONO(x + 26, y + 37, `VersionId = ${b2 === 'null' ? 'null' : b2 === 'mk' ? 'DelMarker.Gx4Yn0' : VIDS[+b2.slice(1) - 1].slice(0, 22)}`); });
          if (!list.length) t += R(x + 14, 124, 438, 46, 'xs3-ver gone', 6) + T(x + 26, 152, 'объекта нет: стёрт навсегда', 'xr-s xs3-bad');
          return t;
        };
        s += stack(24, 'Versioning: Enabled', true) + stack(510, 'Версии выключены', false);
        s += R(24, 432, 952, 116, 'xs3-codebg', 10);
        ['aws s3api put-bucket-versioning --bucket media-prod --versioning-configuration Status=Enabled', 'aws s3api list-object-versions --bucket media-prod --prefix avatars/u55120.jpg', 'aws s3api get-object --bucket media-prod --key avatars/u55120.jpg --version-id wxBoq4SQ.5MKTPhWbEjxAjm0Ixp_XQzK old.jpg', '# каждая версия оплачивается как объект — правило NoncurrentVersionExpiration { NoncurrentDays: 30 }'].forEach((l, j) => { s += CODE(36, 456 + j * 22, l, 'sm'); });
        return s;
      }
      function vCost() {
        const b = bill(), n = nb();
        S.pv.costSeen = 1;
        let s = head('Из чего складывается счёт', 'хранение, запросы и исходящий трафик — посчитано по нагрузке площадки');
        const rows = [['Хранение', b.storage, `${byt(b.stored)} · смесь классов`], ['Запросы PUT', putRps() * MONTH / 1000 * 0.005, `${SD.fmt.num(putRps())}/с × $0,005 за 1 000`], ['Запросы GET', getRps() * MONTH / 1000 * 0.0004, `${SD.fmt.num(getRps())}/с × $0,0004 за 1 000`], ['Трафик наружу', b.egress, `${SD.fmt.num(getRps())}/с × ${byt(objSize())} × $0,09 за ГБ`]];
        const mx = Math.max(...rows.map(r => r[1]), b.egressNo);
        s += R(24, 60, 952, 230, 'xs3-panel', 10) + T(36, 82, 'СЧЁТ ЗА МЕСЯЦ', 'xr-m');
        rows.forEach(([a, v, d], j) => { const y = 108 + j * 42; s += T(36, y, a, 'xr-s') + R(180, y - 12, 520, 14, 'xr-bar', 3) + R(180, y - 12, 520 * clamp(v / mx, 0, 1), 14, 'xr-bar-f' + (j === 3 && !b.cdn ? ' warn' : ''), 3) + T(712, y, usd(v), 'xr-m') + T(36, y + 16, d, 'xs3-ms'); });
        s += T(36, 280, `итого ≈ ${usd(rows.reduce((s2, r) => s2 + r[1], 0))} в месяц`, 'xr-t');
        s += R(24, 302, 952, 246, 'xs3-panel' + (b.cdn ? ' okb' : ' badb'), 10) + T(36, 324, 'ИСХОДЯЩИЙ ТРАФИК: С CDN И БЕЗ', 'xr-m');
        s += T(36, 352, 'без CDN', 'xr-s') + R(180, 340, 520, 16, 'xr-bar', 3) + R(180, 340, 520, 16, 'xr-bar-f warn', 3) + T(712, 352, `${usd(b.egressNo)} в месяц`, 'xr-m warn');
        s += T(36, 384, 'с CDN', 'xr-s') + R(180, 372, 520, 16, 'xr-bar', 3) + R(180, 372, 520 * (b.cdn ? b.egress / Math.max(1, b.egressNo) : 0.07), 16, 'xr-bar-f', 3) + T(712, 384, b.cdn ? `${usd(b.egress)} из S3 + плата CDN` : 'поставь CDN перед S3', 'xr-m ok');
        s += T(36, 420, b.cdn ? `Сейчас перед хранилищем CDN: в S3 доходит ${Math.round(b.f * 100)} % чтений, остальные отдают края.` : 'Сейчас CDN перед хранилищем нет: каждый просмотр — исходящий трафик из S3.', 'xr-s ' + (b.cdn ? 'xs3-ok' : 'xs3-warn'));
        s += T(36, 444, 'CDN тоже берёт деньги за трафик (≈ $0,085 за ГБ у CloudFront, меньше по объёму), но снимает нагрузку и задержку.', 'xs3-ms');
        s += T(36, 466, 'Cloudflare R2 и некоторые облака не берут плату за исходящий трафик — для медиа это главная строка счёта.', 'xs3-ms');
        s += T(36, 488, 'Входящий трафик (загрузки) бесплатный; трафик между S3 и CDN одного облака обычно бесплатный.', 'xs3-ms');
        return s;
      }
      const VIEWS = { bucket: vBucket, api: vApi, multi: vMulti, presign: vPresign, classes: vClasses, life: vLife, ver: vVer, cost: vCost };
      function partNow(k) {
        const b = bill();
        if (k === 'bucket') return '<b>Бакет — плоский список ключей.</b> Слеши в ключе — просто символы, «папки» рисует консоль. Объект неизменяем: изменить можно, только записав его заново целиком.';
        if (k === 'api') return '<b>Весь интерфейс — HTTP:</b> PUT кладёт, GET отдаёт (можно кусок по Range), LIST перечисляет ключи по префиксу страницами по 1 000, HEAD — только метаданные.';
        if (k === 'multi') return '<b>Multipart:</b> 48 частей по 50 МБ летят параллельно, у каждой свой ETag. Упала одна — повторяем её, а не весь файл. В конце CompleteMultipartUpload склеивает объект.';
        if (k === 'presign') return '<b>Подписанная ссылка:</b> сервис только проверяет права и подписывает URL со сроком, файл идёт из браузера прямо в S3. Просроченная или изменённая ссылка получает 403.';
        if (k === 'classes') return '<b>Классы хранения:</b> от $0,023 до $0,00099 за ГБ в месяц. Чем дешевле хранение, тем дороже чтение и тем дольше ждать: глубокий архив восстанавливают 12–48 часов.';
        if (k === 'life') return `<b>Жизненный цикл:</b> фото через 30 дней уезжают в «Редкий доступ», через 180 — в глубокий архив, сырые видео удаляются через год. Хранение 1 ТБ дешевеет с $23 до $1 в месяц. ${lifeOn() ? 'Правило сейчас включено.' : 'Правило сейчас выключено.'}`;
        if (k === 'ver') return '<b>Версии:</b> каждый PUT — новая версия, DELETE — маркер. Слева всё можно вернуть, справа каждая запись стирает прошлую навсегда.';
        if (k === 'cost') return `<b>Счёт:</b> хранение ${usd(b.storage)}, трафик ${usd(b.egress)} в месяц. ${b.cdn ? `CDN снимает с S3 ${Math.round((1 - b.f) * 100)} % чтений — без него трафик стоил бы ${usd(b.egressNo)}.` : 'CDN нет — каждый просмотр оплачивается как исходящий трафик S3.'}`;
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.objs) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'presign' && S.pv.p403) done('psign'); if (pk === 'cost' && S.vt > 1500) done('pcost'); }
        const getGap = S.scn === 'multi' ? 900 : 380, putGap = S.scn === 'ver' || S.scn === 'multi' ? 1e9 : S.scn === 'life' ? 1200 : S.scn === 'thru' ? 260 : 900;
        while (S.at <= S.t) { S.at += getGap * (0.6 + Math.random() * 0.8); if (S.reqs.length < 40) spawnGet(); }
        while (S.upAt <= S.t) { S.upAt += putGap * (0.6 + Math.random() * 0.8); if (S.reqs.length < 40 && S.threads < 40) spawnPut(S.scn === 'thru'); }
        S.reqs.forEach(reqStep); S.reqs = S.reqs.filter(r => !r.gone);
        mpStep(dt); lifeStep(dt); verStep();
        S.fx = S.fx.filter(f => S.t - f.t0 < 1300); S.hist = S.hist.filter(h => h.t > S.t - 10000); S.arch = S.arch.filter(t => t > S.t - 10000);
        if (S.scn === 'thru' && S.threads > 20) { S.flags.thru = 1; note('th', `<b>Сервис занят байтами:</b> ${S.threads} из 40 потоков просто перекладывают файлы из сети в S3. Новые запросы к API ждут. С подписанной ссылкой эти потоки свободны.`, 'warn', 8000); }
        if (S.flags.thru && S.flags.normSeen) done('thru');
        if (S.scn === 'norm' && S.cfgT > 2000) S.flags.normSeen = 1;
        if (S.scn === 'ver' && S.flags.verOff && S.ver.gone) done('ver');
      }
      function draw() {
        if (!S.objs) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() {},
        scenario(id) { const keep = S.flags; S.scn = id; S.cfgT = 0; reset(); S.flags = keep; },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (key === 'sclass') return v === 'arch' ? 'Архив: $1 за ТБ — хранение в 23 раза дешевле, но каждый GET теперь получает 403: объект сначала восстанавливают часами. Смотри красные ответы.' : v === 'ia' ? 'Редкий доступ: хранение почти вдвое дешевле, но за каждый прочитанный ГБ доплата — а свежие фото читают постоянно. Смотри строку «хранение» в счёте.' : 'Стандарт: дороже хранить, зато чтение мгновенное и без доплат.';
          if (key === 'lifecycle') return v ? 'Правило включено: свежие файлы в «Стандарте», старше 30 дней — в «Редком доступе», старше 180 — в глубоком архиве. Счёт за хранение падает в разы.' : `Правило выключено: всё лежит в классе «${CLS[baseCls()].name}».`;
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const b = bill(), n = nb();
          if (S.scn === 'thru') return `<b>Загрузка через сервис:</b> каждый файл сначала целиком принимает сервис, держит поток всё время передачи и только потом кладёт в S3. Сейчас заняты ${S.threads} из 40 потоков, трафик идёт дважды. С подписанной ссылкой сервис тратил бы ≈ 1 мс на подпись.`;
          if (S.scn === 'multi') { const m = S.mp; return !m ? '<b>Пользователь выбирает видео 2,4 ГБ.</b> Одним PUT можно до 5 ГБ, но обрыв на 2-м гигабайте означал бы начать сначала. Поэтому — частями.' : m.ph === 'done' ? '<b>Готово:</b> 48 частей склеены в один объект. Событие ObjectCreated уйдёт в очередь, и обработчик начнёт перекодирование.' : `<b>Загрузка частями:</b> по 4 части параллельно, у каждой свой номер и ETag. ${m.parts.some(p => p.st === 3) ? 'Одна часть упала — повторим только её.' : `Готово ${m.parts.filter(p => p.st === 2).length} из 48.`}`; }
          if (S.scn === 'life') return lifeOn() ? `<b>Правило жизненного цикла:</b> через 30 дней фото уезжают в «Редкий доступ», через 180 — в архив, сырые видео удаляются через год, бэкапы сразу лежат в глубоком архиве. Хранение стоит ${usd(b.storage)} в месяц вместо ${usd(b.storageStd)}. Редкие запросы к фото старше полугода получают 403 — их надо сначала восстановить.` : `<b>Правило выключено:</b> всё лежит в классе «${CLS[baseCls()].name}» — ${usd(b.storage)} в месяц. Включи правило кнопкой справа и сравни.`;
          if (S.scn === 'ver') { const v = S.ver; return S.opt.ver ? `<b>Версии включены.</b> ${['Есть одна версия аватара.', 'Новый аватар — новая версия, старый остался нетекущим.', 'Ещё одна версия. Все три картинки лежат в бакете.', 'DELETE поставил маркер удаления: GET вернёт 404, но данные целы.', 'Маркер удалили — аватар вернулся.'][v.ph]}` : `<b>Версии выключены.</b> ${['Одна картинка по ключу.', 'Новый аватар перезаписал старый навсегда.', 'И этот перезаписан.', 'DELETE стёр объект — вернуть нечем.', 'Восстанавливать нечего.'][v.ph]}`; }
          if (!lifeOn() && sclass() === 'arch') return `<b>Весь бакет в глубоком архиве.</b> Хранение копеечное (${usd(b.storage)} в месяц), но каждый GET получает 403 InvalidObjectState — объект сначала восстанавливают (RestoreObject) 12–48 часов. Фото не открываются. Верни «Стандарт» или включи правила жизненного цикла: свежее останется в «Стандарте».`;
          if (!lifeOn() && sclass() === 'ia') return `<b>Весь бакет в «Редком доступе».</b> Хранение почти вдвое дешевле, но каждый прочитанный ГБ стоит ещё $0,01, а свежие фото читают постоянно: извлечение ≈ ${usd(b.fetch)} в месяц. Правило жизненного цикла выгоднее: свежее — в «Стандарте», старое — в дешёвых классах.`;
          return `<b>Чтение и загрузка.</b> ${lifeOn() ? `Правило жизненного цикла включено: хранение ${usd(b.storage)} вместо ${usd(b.storageStd)} в месяц. ` : ''}${n.cdn ? `Просмотры идут через CDN — в S3 доходит только ${Math.round(b.f * 100)} % (промахи краёв).` : 'CDN нет — каждый просмотр идёт в S3 и оплачивается как исходящий трафик.'} Загрузка: браузер просит у сервиса подписанную ссылку и кладёт файл прямо в бакет — новые ключи появляются сверху списка.`;
        },
        stats() {
          const b = bill(), puts = S.hist.filter(h => h.k === 'put').length;
          return [
            ['GET в S3', SD.fmt.num(getRps()) + '/с', '', b.cdn ? `из ${SD.fmt.num(b.total)}/с у пользователей` : 'все просмотры'],
            ['PUT', SD.fmt.num(putRps()) + '/с', '', S.scn === 'thru' ? 'через сервис' : 'по подписанной ссылке'],
            ['Потоки сервиса', S.scn === 'thru' ? `${S.threads} из 40` : '≈ 0', S.scn === 'thru' && S.threads > 20 ? 'bad' : 'ok', 'заняты передачей файлов'],
            ['Хранение', usd(b.storage) + '/мес', '', `${byt(b.stored)}`],
            ['Трафик наружу', usd(b.egress) + '/мес', b.cdn ? 'ok' : 'warn', b.cdn ? `без CDN ${usd(b.egressNo)}` : '$0,09 за ГБ'],
            !lifeOn() && sclass() === 'arch' ? ['Первый байт', '12–48 ч', 'bad', `архив: отказов ${S.arch.length} за 10 с`] : S.arch.length ? ['Из архива', String(S.arch.length), 'warn', 'GET старых фото за 10 с → 403'] : ['Первый байт', '≈ 30 мс', '', !lifeOn() && sclass() === 'ia' ? 'плюс плата за извлечение' : 'стандартный класс']
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
