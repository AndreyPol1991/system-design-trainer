/* «API Gateway изнутри»: проверка токена (JWT), лимит частоты на клиента (token bucket, 429 + Retry-After), маршрутизация по пути,
   агрегация вызовов (BFF), таймауты и предохранитель на маршрут, журнал и трассировка (correlation id). */
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
    return `<line class="xgw-ar ${c || ''}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/><polygon class="xgw-ah ${c || ''}" points="${f1(x2)},${f1(y2)} ${p(0.45)} ${p(-0.45)}"/>`;
  }
  const MONO = (x, y, t, c, a) => `<text class="xgw-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const hl = line => line.split(/('[^']*'|"[^"]*"|\s+|[(),=<>*;:{}[\]]+)/).filter(x => x !== '').map(tk => /^('.*'|".*")$/.test(tk) ? `<tspan class="xgw-st">${ES(tk)}</tspan>` : /^(GET|POST|PUT|DELETE|HTTP\/1\.1|HTTP\/2|routes|path|service|timeout|retries|circuit_breaker|rate_limit|plugins|name|config)$/.test(tk) ? `<tspan class="xgw-kw">${tk}</tspan>` : /^-?\d[\d.]*$/.test(tk) ? `<tspan class="xgw-nu">${tk}</tspan>` : ES(tk)).join('');
  const CODE = (x, y, line, c) => `<text class="xgw-code${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}">${line.trim().startsWith('#') ? `<tspan class="xgw-cm">${ES(line)}</tspan>` : hl(line)}</text>`;
  const rid = () => 'req-' + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const hms = ms => { const s = 12 * 3600 + 31 * 60 + ms / 1000; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}.${String(Math.floor(ms) % 1000).padStart(3, '0')}`; };

  /* ---------- клиенты, маршруты ---------- */
  const CLI = [
    { id: 'm', name: 'Мобильное приложение', key: 'user 55120', rate: 1.0 },
    { id: 'w', name: 'Сайт', key: 'user 80441', rate: 1.0 },
    { id: 'b', name: 'Парсер-бот', key: 'IP 185.12.44.7', rate: 22, bot: true }];
  const ROUTES = [
    { m: 'GET', p: '/api/catalog/products/3071', pre: '/api/catalog/*', svc: 0, name: 'Каталог', role: 'catalog' },
    { m: 'POST', p: '/api/orders', pre: '/api/orders/*', svc: 1, name: 'Заказы', role: 'orders' },
    { m: 'GET', p: '/api/me', pre: '/api/me', svc: 2, name: 'Пользователи', role: 'users' },
    { m: 'GET', p: '/api/home', pre: '/api/home', svc: -1, name: 'BFF: главный экран', bff: true }];
  const BURST = 5, REFILL = 2;   // ведро: 5 жетонов, 2 жетона в секунду на клиента

  /* ---------- геометрия (viewBox 1000 × 560) ---------- */
  const CLX = 16, CLW = 184, CLY = [52, 146, 240], CLH = 86;
  const GW = { x: 214, y: 46, w: 432, h: 286 }, SVX = 660, SVW = 324, SVY = [52, 146, 240], SVH = 86;
  const STG = ['jwt', 'rl', 'route', 'call'], STX = i => GW.x + 14 + i * 104, STY = 112, STW = 96, STH = 96;
  const LANE = STY + STH / 2;
  const LOG = { x: 16, y: 344, w: 560, h: 208 }, RT = { x: 586, y: 344, w: 398, h: 208 };

  SD.XRAY.gateway = {
    viewBox: '0 0 1000 560',
    cta: 'Проверка токена, лимит частоты с ведром жетонов, маршруты, агрегация вызовов, таймауты и предохранитель, correlation id',
    dive: 'ratelimit',
    simple: () => ({
      an: 'Как <b>проходная бизнес-центра</b>: охранник проверяет пропуск, не пускает того, кто ломится по сто раз в минуту, и подсказывает, на какой этаж идти. Офисам внутри не нужно ставить свою охрану.',
      pl: 'API Gateway — единственная дверь для всех клиентов. Он проверяет токен, считает, сколько запросов присылает каждый клиент, и по пути запроса отправляет его в нужный сервис. Тут же — таймауты, предохранители и запись в журнал с номером запроса.'
    }),
    props: ['count', 'auth', 'rateLimit', 'rlAlgo'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Приложение и сайт ходят в каталог, заказы и профиль. Всё по настройкам шлюза.' },
      { id: 'bot', name: 'Бот бьёт', note: 'Парсер с одного адреса присылает 22 запроса в секунду в каталог.' },
      { id: 'down', name: 'Упал сервис', note: 'Сервис заказов отвечает через 3 с ошибкой. Что делают таймаут и предохранитель на маршруте?' },
      { id: 'expired', name: 'Истёк токен', note: 'У мобильного приложения кончился срок токена доступа. Что делает шлюз и как клиент получает новый?' },
      { id: 'bff', name: 'Главный экран', note: 'Мобильному экрану нужны каталог, заказы и профиль. Три запроса по мобильной сети или один в агрегатор?' }
    ],
    tries: [
      { id: 'bot', text: 'В «Бот бьёт» включи лимит частоты: бот получает 429, обычные пользователи — нет' },
      { id: 'cb', text: 'В «Упал сервис» включи таймаут и предохранитель на маршруте: шлюз отвечает сразу, потоки не висят' },
      { id: 'jwt', text: 'В «Истёк токен» поймай 401 и обновление токена; потом выключи проверку токена и посмотри, кто теперь отказывает' },
      { id: 'bff', text: 'В «Главном экране» сравни три вызова с клиента и один вызов в агрегатор' },
      { id: 'pfix', text: 'Открой блок «Лимит частоты», выбери Fixed window и поймай двойной всплеск на границе окна' },
      { id: 'ptrace', text: 'Открой блок «Журнал и трассировка» и найди самый медленный шаг запроса' }
    ],
    parts: {
      jwt: {
        name: 'Проверка токена (JWT)', knobs: ['auth'],
        an: 'Как <b>пропуск с голограммой и датой</b>: охранник не звонит в отдел кадров, а смотрит на голограмму и срок — подделку видно сразу.',
        pl: 'Клиент приносит токен доступа в заголовке Authorization. Шлюз проверяет подпись ключом сервера авторизации, срок и права — без похода в базу. Плохой или просроченный токен получает 401, а сервисы за шлюзом получают уже проверенного пользователя.',
        how: ['Заголовок: Authorization: Bearer eyJhbGciOiJSUzI1NiIs… — три части через точку: заголовок, данные, подпись.', 'Данные (payload): sub = 55120 (кто), exp — до какого времени, scope — что можно.', 'Подпись проверяется публичным ключом сервера авторизации (JWKS) — без запроса в базу, за доли миллисекунды.', 'exp прошёл → 401 Unauthorized + WWW-Authenticate: Bearer error="invalid_token".', 'Клиент берёт refresh-токен и получает новый access-токен (POST /oauth/token), повторяет запрос.', 'В сервис уходит X-User-Id: 55120 — сервисам не нужно разбирать токен самим.'],
        watch: 'Первая ступень шлюза. Зелёная галочка — подпись и срок в порядке; красный 401 — запрос не дошёл дальше. В «Истёк токен» видно, как приложение обновляет токен и повторяет запрос.',
        real: 'Kong (плагин jwt / openid-connect), Envoy (jwt_authn), AWS API Gateway (authorizers), Nginx + lua. Токены выдаёт Keycloak, Auth0 или свой сервис OAuth 2.0. Срок access-токена обычно 5–15 минут.'
      },
      bucket: {
        name: 'Лимит частоты', knobs: ['rateLimit', 'rlAlgo'],
        an: 'Как <b>автомат с жетонами на входе</b>: у каждого посетителя ведёрко на 5 жетонов, раз в полсекунды падает новый. Проход стоит жетон. Пусто — подожди.',
        pl: 'У каждого клиента (пользователя, ключа API или IP) своё ведро жетонов. Запрос забирает жетон; жетоны пополняются с постоянной скоростью. Пустое ведро — 429 Too Many Requests и подсказка Retry-After: когда приходить снова. Короткие всплески проходят, постоянный поток — нет.',
        how: ['<b>Token bucket</b>: ёмкость 5, пополнение 2 жетона в секунду. Обычный пользователь не замечает лимита.', 'Бот шлёт 22 запроса в секунду: первые 5 проходят из запаса, дальше — только 2 в секунду, остальные 429.', '<b>Fixed window</b>: «не больше 5 за календарную секунду». Просто, но на стыке окон можно пройти 10 подряд.', '<b>Sliding window</b>: считаем запросы за последние 1000 мс — точно, но нужно помнить время каждого запроса.', 'Счётчики общие для всех экземпляров шлюза — обычно в Redis (INCR с TTL или Lua-скрипт).', 'Ответ: 429, Retry-After: 1, X-RateLimit-Remaining: 0 — честный клиент подождёт.'],
        watch: 'У каждого клиента слева — его ведро: уровень жетонов. На ступени «Лимит» лишние запросы бота отбиваются 429. Внутри блока — три алгоритма бок о бок.',
        real: 'Kong rate-limiting (local / cluster / redis), Envoy local и global rate limit, Nginx limit_req (leaky bucket). На площадке доля ботов, дошедших до сервисов: token 3 %, sliding 2 %, fixed 8 %.'
      },
      route: {
        name: 'Маршрутизация',
        an: 'Как <b>указатель этажей в холле</b>: «Каталог — 2 этаж, Заказы — 3 этаж». Посетитель знает одну дверь, а куда идти дальше, решает табличка.',
        pl: 'Клиенты знают один адрес — api.shop.ru. Шлюз смотрит на путь запроса и по таблице маршрутов решает, в какой сервис его отправить. Сервисы можно переносить и делить, не меняя приложение.',
        how: ['Таблица маршрутов: /api/catalog/* → catalog, /api/orders/* → orders, /api/me → users.', 'Совпадение ищется по самому длинному префиксу; можно и по методу, заголовку, версии API (/v2/).', 'Перед отправкой шлюз может переписать путь (/api/catalog/products → /products) и добавить заголовки.', 'Сервис адресуется по имени (catalog.svc:8080) — балансировку между экземплярами делает шлюз или сеть.', 'Канареечный выпуск: 5 % запросов /api/catalog — в новую версию.', 'Клиенту не видна внутренняя структура: разделили сервис надвое — поменяли таблицу, не приложение.'],
        watch: 'Третья ступень: путь запроса сравнивается с таблицей маршрутов (справа внизу), и точка уходит к своему сервису справа.',
        real: 'Kong routes и services, Envoy route_config, AWS API Gateway resources, Nginx location, Traefik routers. В Kubernetes — Ingress и Gateway API (HTTPRoute).'
      },
      bff: {
        name: 'Агрегация (BFF)',
        an: 'Как <b>официант, который приносит весь заказ на одном подносе</b>, а не бегает на кухню отдельно за супом, хлебом и чаем.',
        pl: 'Главному экрану нужны данные из трёх сервисов. По мобильной сети каждый лишний запрос стоит 80–150 мс. Агрегатор (Backend for Frontend) принимает один запрос, сам параллельно вызывает три сервиса внутри дата-центра и отдаёт один ответ, собранный под этот экран.',
        how: ['Без агрегатора: телефон делает 3 запроса — даже параллельно это 3 соединения и разбор трёх ответов, последовательно — 3 × RTT.', 'С агрегатором: GET /api/home → шлюз (или BFF-сервис) параллельно зовёт catalog, orders, users.', 'Внутри дата-центра каждый вызов — единицы миллисекунд вместо сотни.', 'Ответ собирается под экран: только нужные поля, без лишних килобайт.', 'Упал один из трёх — экран всё равно показывается: блок «Мои заказы» пустой с надписью «временно недоступно».', 'Обычно BFF отдельный на каждый клиент: мобильный, веб, партнёрский API.'],
        watch: 'В «Главном экране» запрос /api/home на ступени маршрута распадается на три параллельных вызова и собирается обратно. Внутри блока — две временные шкалы: три запроса с телефона против одного.',
        real: 'Паттерн Backend for Frontend (Sam Newman). GraphQL-шлюзы (Apollo Router) делают то же самое по запросу клиента. В Kong и Envoy агрегацию обычно выносят в отдельный BFF-сервис.'
      },
      resil: {
        name: 'Таймауты и предохранитель',
        an: 'Как <b>пробки в щитке</b>: если на одной линии замыкание, пробка выбивает её, а свет в остальных комнатах горит. Через минуту пробуешь включить снова.',
        pl: 'Если сервис зависает, шлюз не должен ждать вечно: таймаут обрывает ожидание. Если сервис сыплет ошибками, предохранитель перестаёт его вызывать и сразу отвечает ошибкой или запасным ответом — пока сервис не оживёт.',
        how: ['<b>Таймаут</b> на маршрут: 300 мс — не ответил, 504 Gateway Timeout, соединение свободно.', 'Без таймаута запросы к больному сервису висят секундами и занимают соединения и потоки шлюза — страдают и здоровые маршруты.', '<b>Предохранитель</b> считает ошибки: больше 50 % из последних 10 — разомкнуть (open).', 'Разомкнут: запросы на этот маршрут сразу получают 503 или запасной ответ, сервис отдыхает.', 'Через 5 с — полуоткрыт (half-open): один пробный запрос. Успех — замкнуть, ошибка — снова open.', 'Повторы (retries) — только для идемпотентных запросов и с паузой, иначе шлюз добьёт больной сервис.'],
        watch: 'У каждого сервиса справа — лампочка предохранителя: зелёная — замкнут, красная — разомкнут, жёлтая — пробный запрос. В «Упал сервис» видно, сколько запросов висит в ожидании.',
        real: 'Envoy outlier detection и circuit_breakers, Kong (upstream healthchecks), Resilience4j и Polly в коде. Таймауты и предохранитель здесь — настройки связи шлюз → сервис в площадке.'
      },
      trace: {
        name: 'Журнал и трассировка',
        an: 'Как <b>номер заказа на чеке</b>: по нему на любой кухне и в любой службе доставки найдут именно твой заказ и посмотрят, где он задержался.',
        pl: 'Шлюз присваивает каждому запросу номер (correlation id) и передаёт его дальше в заголовке. Все сервисы пишут этот номер в свои логи и отрезки трассировки. Потом по одному номеру видно весь путь запроса и где он тормозил.',
        how: ['Шлюз генерирует X-Request-Id: req-7f3a91c2 (или берёт traceparent от клиента).', 'Передаёт его в сервис заголовком traceparent (W3C Trace Context) — дальше его несут все вызовы.', 'Access-лог шлюза: время, id, метод, путь, маршрут, статус, длительность, клиент.', 'Каждый шаг — отрезок (span): проверка токена 0,3 мс, лимит 0,2 мс, вызов сервиса 18 мс.', 'Трасса собирается в Jaeger или Tempo — видно, какой отрезок самый длинный.', 'Метрики шлюза — RPS, доля 4xx и 5xx, задержка по маршрутам — главный экран дежурного.'],
        watch: 'Слева внизу — access-лог шлюза: каждая строка с номером запроса. Внутри блока — водопад отрезков одного запроса.',
        real: 'OpenTelemetry, Jaeger, Grafana Tempo, Zipkin. Kong и Envoy умеют добавлять traceparent и писать отрезки сами.'
      }
    },
    legend: [['read', 'Запрос клиента'], ['xgw-swb', 'Запрос бота'], ['ok', 'Ответ 200'], ['sq xgw-swt', 'Жетоны в ведре клиента'], ['warn', '429 — лимит частоты'], ['bad', '401, 503, 504 — отказ'], ['sq xgw-swc', 'Предохранитель разомкнут']],
    live: (n, r) => {
      const l = r.load || {}, rps = Object.keys(l).reduce((s, k) => s + l[k], 0), out = [['Поток', SD.fmt.num(rps) + '/с', '']];
      if (r.util != null) out.push(['Загрузка', Math.round(Math.min(r.util, 9) * 100) + ' %', r.util > 1 ? 'bad' : r.util > 0.75 ? 'warn' : 'ok']);
      out.push(['Экземпляров', String(n.props.count || 1), (n.props.count || 1) < 2 ? 'warn' : '']);
      out.push(['Лимит', n.props.rateLimit ? ({ token: 'token bucket', sliding: 'sliding window', fixed: 'fixed window' }[n.props.rlAlgo || 'token']) : 'выключен', n.props.rateLimit ? 'ok' : 'warn']);
      if ((l.bot || 0) > 0) out.push(['Ботов до сервисов', n.props.rateLimit ? ({ token: 3, sliding: 2, fixed: 8 }[n.props.rlAlgo || 'token']) + ' %' : '100 %', n.props.rateLimit ? 'ok' : 'bad']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xgwSt"></g><g id="xgwDy" class="xgw-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xgwSt'), gDy = ctx.svg.querySelector('#xgwDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const auth = () => P().auth !== false, rl = () => !!P().rateLimit, algo = () => P().rlAlgo || 'token';
      const outs = () => ctx.outs();
      /* сервисы за шлюзом: настоящие соседи, если их несколько; иначе — маршруты через одного соседа */
      function services() {
        const os = outs(), apps = os.filter(o => o.n.type === 'app' || o.n.type === 'faas');
        return ROUTES.slice(0, 3).map((r, i) => {
          const o = apps.find(a => (a.n.props.role || '') === r.role) || apps[i] || os[i % Math.max(1, os.length)] || null;
          return { i, name: r.name, o, real: o ? ctx.nm(o.n.id) : r.name, viaOne: !(apps.length >= 3) };
        });
      }
      const edgeOf = i => { const s = S.svc[i]; return s && s.o ? s.o.e : null; };
      const eprop = (i, k) => { const e = edgeOf(i); return e ? Object.assign(SD.edgeDefaults(), e.props)[k] : SD.edgeDefaults()[k]; };

      function reset() {
        S.svc = services();
        Object.assign(S, { t: 0, reqs: [], fx: [], log: [], ev: [], seq: 0, cliAt: {}, buckets: {}, win: {}, slide: {}, cb: [0, 1, 2].map(() => ({ st: 'closed', hist: [], openAt: 0 })), hang: 0, tok: { exp: 1e12, ver: 1 }, refreshing: false, cfgT: 0, bffAt: 600, homeMode: 'bff' });
        CLI.forEach(c => { S.cliAt[c.id] = 300 + Math.random() * 400; S.buckets[c.id] = { n: BURST, t: 0 }; S.win[c.id] = { w: -1, n: 0 }; S.slide[c.id] = []; });
        if (S.scn === 'expired') S.tok.exp = 2500;
        S.cfg = S.scn;
      }
      const clientsShown = () => S.scn === 'bot' ? CLI : CLI.slice(0, 2);

      /* ---------- лимит частоты ---------- */
      function allow(cid) {
        if (!rl()) return { ok: true };
        const a = algo(), now = S.t;
        if (a === 'token') { const b = S.buckets[cid]; b.n = Math.min(BURST, b.n + (now - b.t) / 1000 * REFILL); b.t = now; if (b.n >= 1) { b.n -= 1; return { ok: true }; } return { ok: false, retry: Math.ceil((1 - b.n) / REFILL) }; }
        if (a === 'fixed') { const w = Math.floor(now / 1000), s = S.win[cid]; if (s.w !== w) { s.w = w; s.n = 0; } if (s.n < BURST) { s.n++; return { ok: true }; } return { ok: false, retry: 1 }; }
        const L = S.slide[cid] = S.slide[cid].filter(t => t > now - 1000); if (L.length < BURST) { L.push(now); return { ok: true }; } return { ok: false, retry: 1 };
      }

      /* ---------- запросы ---------- */
      const cliPt = cid => { const i = clientsShown().findIndex(c => c.id === cid); return [CLX + CLW, CLY[Math.max(0, i)] + CLH / 2]; };
      const svPt = i => [SVX, SVY[i] + SVH / 2];
      const stPt = k => [STX(k) + STW / 2, LANE];
      function pickRoute(c) {
        if (c.bot) return ROUTES[0];
        if (S.scn === 'bff' && c.id === 'm') return ROUTES[3];
        if (S.scn === 'down') return Math.random() < 0.7 ? ROUTES[1] : ROUTES[Math.random() < 0.5 ? 0 : 2];
        const r = Math.random(); return r < 0.5 ? ROUTES[0] : r < 0.7 ? ROUTES[1] : r < 0.9 ? ROUTES[2] : ROUTES[3];
      }
      function spawn(c) {
        if (S.reqs.length > 46) return;
        const route = pickRoute(c), expired = c.id === 'm' && S.t >= S.tok.exp;
        if (S.scn === 'bff' && c.id === 'm' && S.homeMode === 'direct') { [0, 1, 2].forEach(i => S.reqs.push(mkReq(c, ROUTES[i], false, true))); return; }
        S.reqs.push(mkReq(c, route, expired));
      }
      function mkReq(c, route, expired, direct) {
        const id = rid(), from = cliPt(c.id);
        return { id, c, route, expired, direct, ph: 'in', p0: S.t, dur: c.bot ? 260 : 360, pts: [from, [GW.x, LANE]], start: S.t, spans: [{ n: 'вход, TLS', t: S.t }], sub: [] };
      }
      function stage(q, k) { q.ph = 's' + k; q.p0 = S.t; q.dur = q.c.bot ? 110 : 170; q.pts = [k ? stPt(k - 1) : [GW.x, LANE], stPt(k)]; }
      function reject(q, code, msg) {
        q.res = code; q.msg = msg; q.ph = 'rej'; q.p0 = S.t; q.dur = 520; q.pts = [[q.pts[q.pts.length - 1][0], LANE], cliPt(q.c.id)];
        finish(q);
      }
      function callSvc(q, i, parent) {
        const cb = S.cb[i];
        if (eprop(i, 'cb') && cb.st === 'open') {
          if (S.t - cb.openAt > 5000) { cb.st = 'half'; }
          else return { fast: true, code: 503 };
        }
        const down = S.scn === 'down' && i === 1, to = eprop(i, 'timeout') || 0, base = 120 + Math.random() * 160, sick = down ? 3000 : base * (1 + Math.min(1.5, S.botLoad || 0));
        const dur = to && sick > to ? to : sick, code = down ? (to && sick > to ? 504 : 503) : 200;
        return { dur, code, to: to && sick > to };
      }
      function cbRecord(i, ok) {
        if (!eprop(i, 'cb')) return;
        const cb = S.cb[i]; cb.hist.push(ok); if (cb.hist.length > 10) cb.hist.shift();
        if (cb.st === 'half') { if (ok) { cb.st = 'closed'; cb.hist = []; note('cbc' + i, `<b>Предохранитель «${S.svc[i].name}» замкнулся:</b> пробный запрос прошёл, сервис снова получает трафик.`, 'ok', 0); } else { cb.st = 'open'; cb.openAt = S.t; } return; }
        const fails = cb.hist.filter(x => !x).length;
        if (cb.st === 'closed' && cb.hist.length >= 5 && fails / cb.hist.length >= 0.5) { cb.st = 'open'; cb.openAt = S.t; S.flags.cbOpen = 1; note('cbo' + i, `<b>Предохранитель «${S.svc[i].name}» разомкнулся:</b> ${fails} из ${cb.hist.length} последних вызовов — ошибки. Следующие 5 с шлюз сразу отвечает 503, не трогая сервис.`, 'warn', 0); }
      }
      function advance(q) {
        const ph = q.ph;
        if (ph === 'in') { q.spans.push({ n: 'проверка токена', t: S.t }); stage(q, 0); return; }
        if (ph === 's0') {
          if (q.expired && auth()) { S.flags.e401 = 1; return reject(q, 401, 'invalid_token: срок истёк'); }
          q.spans.push({ n: 'лимит частоты', t: S.t }); stage(q, 1); return;
        }
        if (ph === 's1') {
          const a = allow(q.c.id);
          if (!a.ok) { q.retry = a.retry; return reject(q, 429, `Retry-After: ${a.retry}`); }
          q.spans.push({ n: 'маршрут', t: S.t }); stage(q, 2); return;
        }
        if (ph === 's2') { q.spans.push({ n: 'вызов сервиса', t: S.t }); stage(q, 3); return; }
        if (ph === 's3') {
          if (q.route.bff) {   // агрегатор: три вызова параллельно
            q.ph = 'bff'; q.p0 = S.t; q.subs = [0, 1, 2].map(i => { const r = callSvc(q, i); return { i, r, t0: S.t, end: S.t + 300 + (r.fast ? 0 : r.dur), pts: [stPt(3), svPt(i)] }; });
            q.dur = Math.max(...q.subs.map(s => s.end - S.t)) + 300;
            q.subs.forEach(s => { if (s.r.fast) S.flags.fast = 1; });
            return;
          }
          const i = q.route.svc, r = callSvc(q, i);
          if (r.fast) { S.flags.fast = 1; return reject(q, 503, 'предохранитель разомкнут'); }
          q.r = r; q.ph = 'up'; q.p0 = S.t; q.dur = 300; q.pts = [stPt(3), svPt(i)]; return;
        }
        if (ph === 'up') { q.ph = 'svc'; q.p0 = S.t; q.dur = q.r.dur; if (q.r.dur > 1000) S.hang++; return; }
        if (ph === 'svc') {
          if (q.r.dur > 1000) S.hang--;
          const i = q.route.svc, ok = q.r.code === 200 && !(q.expired && !auth());
          if (q.expired && !auth()) { q.res = 401; q.msg = 'токен отверг сам сервис'; S.flags.svc401 = 1; }
          else { q.res = q.r.code; q.msg = q.r.to ? 'таймаут маршрута' : q.r.code === 503 ? 'сервис ответил ошибкой' : ''; }
          cbRecord(i, ok);
          q.spans.push({ n: 'ответ', t: S.t });
          q.ph = 'back'; q.p0 = S.t; q.dur = 560; q.pts = [svPt(i), stPt(3), [GW.x, LANE], cliPt(q.c.id)];
          finish(q); return;
        }
        if (ph === 'bff') {
          q.subs.forEach(s => cbRecord(s.i, s.r.code === 200));
          const bad = q.subs.filter(s => s.r.code !== 200);
          q.res = bad.length === 3 ? 503 : 200; q.msg = bad.length ? `частично: без «${bad.map(s => S.svc[s.i].name).join('», «')}»` : 'собрано из 3 сервисов';
          q.partial = bad.length > 0 && bad.length < 3;
          q.ph = 'back'; q.p0 = S.t; q.dur = 560; q.pts = [stPt(3), [GW.x, LANE], cliPt(q.c.id)];
          finish(q); return;
        }
        q.gone = true;
      }
      function finish(q) {
        const ms = q.res === 429 || q.res === 401 && auth() && q.expired ? 2 : q.route.bff ? 30 + (q.subs ? Math.max(...q.subs.map(s => s.r.fast ? 0 : s.r.dur)) / 10 : 0) : q.res === 503 && q.msg === 'предохранитель разомкнут' ? 1 : (q.r ? q.r.dur / 10 : 3);
        q.ms = ms;
        S.ev.push({ t: S.t, code: q.res, bot: !!q.c.bot, cid: q.c.id });
        const svc = q.route.bff ? 'bff' : S.svc[q.route.svc] ? (S.svc[q.route.svc].o ? S.svc[q.route.svc].real : q.route.name) : q.route.name;
        S.log.unshift({ t: S.t, id: q.id, m: q.route.m, p: q.direct ? q.route.p : q.route.p, svc, code: q.res, ms, who: q.c.key, msg: q.msg || '' }); if (S.log.length > 8) S.log.pop();
        S.last = q;
        if (q.res === 429 && q.c.bot) { S.flags.b429 = 1; note('429', `<b>429 Too Many Requests для ${q.c.key}:</b> ведро бота пустое, Retry-After: ${q.retry || 1}. Обычные пользователи продолжают получать 200 — у них свои вёдра.`, 'warn', 6000); }
        if (q.res === 401 && auth()) note('401', '<b>401 Unauthorized:</b> срок токена мобильного приложения истёк. Запрос не дошёл до сервисов — шлюз отбил его на первой ступени.', 'bad', 6000);
        if (q.res === 401 && !auth()) note('s401', '<b>Проверка токена на шлюзе выключена:</b> запрос с просроченным токеном прошёл через шлюз, сервис потратил на него время и сам ответил 401. Каждый сервис должен уметь проверять JWT.', 'warn', 6000);
        if (q.res === 504) note('504', `<b>504 Gateway Timeout:</b> «Заказы» не ответили за ${eprop(1, 'timeout')} мс — шлюз оборвал ожидание и освободил соединение.`, 'warn', 5000);
        if (q.res === 503 && q.msg === 'сервис ответил ошибкой' && !eprop(1, 'timeout')) note('hang', `<b>Запрос висел 3 с и всё равно получил ошибку.</b> Без таймаута на маршруте такие запросы копятся в шлюзе: сейчас висит ${S.hang}.`, 'bad', 5000);
        if (q.partial) note('part', `<b>Агрегатор отдал экран частично:</b> ${q.msg}. Пользователь видит главную, а блок заказов — «временно недоступно».`, 'warn', 6000);
      }
      function refreshToken() {
        if (S.scn !== 'expired' || S.refreshing || S.t < S.tok.exp) return;
        if (!S.ev.some(e => e.code === 401 && e.cid === 'm' && e.t > S.tok.exp)) return;
        S.refreshing = { t0: S.t };
      }
      function refreshStep() {
        const r = S.refreshing; if (!r) return;
        if (S.t - r.t0 > 1100) {
          S.tok = { exp: S.t + 5000, ver: S.tok.ver + 1 }; S.refreshing = false;
          if (auth() && S.flags.e401) S.flags.refreshed = 1;
          note('rf', '<b>Приложение обновило токен:</b> POST /oauth/token с refresh-токеном → новый access-токен на 15 минут (в модели — на 5 с). Запросы снова проходят.', 'ok', 0);
          if (S.flags.refreshed && S.flags.svc401) done('jwt');
        }
      }

      /* ---------- кнопки ---------- */
      const btn = (x, y, w, k, label, on) => `<g class="xgw-btn${on ? ' on' : ''}" data-xgw="${k}" tabindex="0" role="button"><rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="22" rx="11"/><text x="${f1(x + w / 2)}" y="${f1(y + 15)}">${label}</text></g>`;
      function setAllEdges(k, v) { const seen = new Set(); S.svc.forEach(s => { if (s.o && !seen.has(s.o.e.id)) { seen.add(s.o.e.id); SD.app.setEdgeProp(s.o.e.id, k, v); } }); }
      function onClick(e) {
        const b = e.target.closest('[data-xgw]'); if (!b) return;
        const k = b.dataset.xgw;
        if (k === 'to') { const v = eprop(1, 'timeout') ? 0 : 300; setAllEdges('timeout', v); ctx.log(`<b>Таймаут на маршрутах: ${v ? '300 мс' : 'нет'}.</b> Это настройка связей «шлюз → сервис» — на площадке она тоже поменялась.`, 'chg'); }
        if (k === 'cb') { const v = !eprop(1, 'cb'); setAllEdges('cb', v); ctx.log(`<b>Предохранитель на маршрутах ${v ? 'включён' : 'выключен'}.</b> Настройка связей «шлюз → сервис».`, 'chg'); }
        if (k === 'home') { S.homeMode = S.homeMode === 'bff' ? 'direct' : 'bff'; S.flags['home_' + S.homeMode] = 1; ctx.log(`<b>Главный экран: ${S.homeMode === 'bff' ? 'один запрос в агрегатор' : 'три запроса с телефона'}.</b>`, 'chg'); if (S.flags.home_direct && S.flags.home_bff) done('bff'); }
        e.stopPropagation();
      }
      function onKey(e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-xgw]')) { e.preventDefault(); onClick(e); } }
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- отрисовка ---------- */
      function counts() {
        const c = { ok: 0, r429: 0, r401: 0, r5: 0, botIn: 0, botOk: 0, n: 0 };
        S.ev.forEach(e => { c.n++; if (e.code === 200) c.ok++; else if (e.code === 429) c.r429++; else if (e.code === 401) c.r401++; else c.r5++; if (e.bot) { c.botIn++; if (e.code === 200) c.botOk++; } });
        return c;
      }
      function badges() {
        const bs = [['jwt', 'ТОКЕН', auth() ? 'проверяет шлюз' : 'выключено'], ['bucket', 'ЛИМИТ ЧАСТОТЫ', rl() ? { token: 'token bucket', sliding: 'sliding window', fixed: 'fixed window' }[algo()] : 'выключен'], ['bff', 'АГРЕГАЦИЯ', '/api/home → 3 сервиса'], ['trace', 'ТРАССИРОВКА', 'X-Request-Id']];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xgw-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xgw-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8); s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xgw-badge', 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(v), 'xr-s' + (k === 'bucket' && !rl() || k === 'jwt' && !auth() ? ' xgw-warn' : ''))}</g>`; });
        return s;
      }
      function clientsSvg() {
        let s = '';
        clientsShown().forEach((c, i) => {
          const y = CLY[i], b = S.buckets[c.id], lvl = rl() ? (algo() === 'token' ? clamp(b.n + (S.t - b.t) / 1000 * REFILL, 0, BURST) : algo() === 'fixed' ? BURST - (S.win[c.id].w === Math.floor(S.t / 1000) ? S.win[c.id].n : 0) : BURST - S.slide[c.id].filter(t => t > S.t - 1000).length) : BURST;
          const expired = c.id === 'm' && S.t >= S.tok.exp;
          s += `<g class="xr-part" data-xpart="bucket">${R(CLX, y, CLW, CLH, 'xr-box' + (c.bot ? ' xgw-botbox' : ''), 10)}`;
          s += T(CLX + 10, y + 18, c.name, 'xr-t xgw-nh') + T(CLX + 10, y + 34, `${c.key} · ${nf(c.rate, c.rate < 10 ? 1 : 0)} запр/с`, 'xgw-ms');
          s += T(CLX + 10, y + 52, c.bot ? 'без токена, перебирает товары' : expired ? (S.refreshing ? 'обновляет токен…' : 'токен истёк!') : `токен до ${hms(Math.min(S.tok.exp, 1e9) > 1e8 ? 900000 : S.tok.exp).slice(0, 8)}`, 'xgw-ms' + (expired ? ' xgw-bad' : ''));
          // ведро жетонов
          if (rl()) { s += T(CLX + 10, y + 74, 'ведро:', 'xgw-ms'); for (let j = 0; j < BURST; j++) s += R(CLX + 56 + j * 18, y + 64, 14, 14, 'xgw-tok' + (j < Math.floor(lvl) ? ' on' : ''), 3); }
          else s += T(CLX + 10, y + 74, 'лимита нет — проходит всё', 'xgw-ms' + (c.bot ? ' xgw-bad' : ''));
          s += '</g>';
        });
        return s;
      }
      function gwSvg() {
        const n = +P().count || 1;
        let s = '';
        for (let k = Math.min(n, 4) - 1; k >= 1; k--) s += R(GW.x + k * 5, GW.y + k * 5, GW.w, GW.h, 'xgw-copy', 14);
        s += R(GW.x, GW.y, GW.w, GW.h, 'xr-zone', 14) + T(GW.x + 12, GW.y + 20, 'API GATEWAY · api.shop.ru', 'xr-m acc') + T(GW.x + GW.w - 12, GW.y + 20, `${n} ${pl(n, 'экземпляр', 'экземпляра', 'экземпляров')}${n < 2 ? ' — точка отказа' : ''}`, 'xgw-ms' + (n < 2 ? ' xgw-warn' : ''), 'end');
        s += T(GW.x + 12, GW.y + 40, 'каждый запрос проходит ступени слева направо', 'xgw-ms');
        const names = [['jwt', 'Токен', auth() ? 'подпись и срок' : 'выключено'], ['bucket', 'Лимит', rl() ? { token: 'ведро 5, +2/с', sliding: 'окно 1 с, 5 шт.', fixed: '5 за секунду' }[algo()] : 'выключен'], ['route', 'Маршрут', 'путь → сервис'], ['resil', 'Вызов', `таймаут ${eprop(1, 'timeout') ? eprop(1, 'timeout') + ' мс' : 'нет'}${eprop(1, 'cb') ? ' · CB' : ''}`]];
        names.forEach(([k, t, d], i) => {
          const x = STX(i), off = (k === 'jwt' && !auth()) || (k === 'bucket' && !rl());
          const recent = S.ev.filter(e => e.t > S.t - 2000), rej = i === 0 ? recent.filter(e => e.code === 401).length : i === 1 ? recent.filter(e => e.code === 429).length : 0;
          s += `<g class="xr-part" data-xpart="${k}">${R(x, STY, STW, STH, 'xgw-stage' + (off ? ' off' : rej ? ' rej' : ''), 10)}`;
          s += T(x + STW / 2, STY + 22, t, 'xr-t xgw-nh', 'middle') + T(x + STW / 2, STY + 40, d, 'xgw-ms', 'middle');
          if (rej) s += T(x + STW / 2, STY + STH - 10, `${i === 0 ? '401' : '429'} ×${rej}`, 'xr-m ' + (i === 0 ? 'bad' : 'warn'), 'middle');
          s += '</g>';
          if (i < 3) s += arrow(x + STW + 1, LANE, x + 103, LANE, '');
        });
        s += `<g class="xr-part" data-xpart="trace">${R(GW.x + 14, GW.y + 236, GW.w - 28, 42, 'xgw-trbar', 8)}`;
        const L = S.last;
        s += T(GW.x + 24, GW.y + 253, 'журнал и трассировка', 'xr-m') + T(GW.x + 24, GW.y + 270, L ? `X-Request-Id: ${L.id} · traceparent: 00-${L.id.slice(4)}a7c1…-01` : 'ждём запрос…', 'xgw-pn');
        s += '</g>';
        if (S.hang > 0) s += T(GW.x + GW.w - 18, STY + STH + 46, `висят: ${S.hang} ${pl(S.hang, 'запрос', 'запроса', 'запросов')}`, 'xr-m bad', 'middle');
        return s;
      }
      function servicesSvg() {
        let s = '';
        S.svc.forEach((sv, i) => {
          const y = SVY[i], cb = S.cb[i], hasCb = eprop(i, 'cb'), down = S.scn === 'down' && i === 1, go = sv.o && ctx.canGo(sv.o.n.id);
          const recent = S.ev.filter(e => e.t > S.t - 3000);
          s += `<g${go ? ` class="xr-go" data-xgo="${sv.o.n.id}"` : ''}>${R(SVX, y, SVW, SVH, 'xr-box' + (down ? ' bad' : ''), 10)}`;
          s += T(SVX + 12, y + 20, ES(cut(sv.viaOne && sv.o ? `${sv.name} · через ${sv.real}` : sv.real, 28)), 'xr-t xgw-nh') + T(SVX + 12, y + 38, ROUTES[i].pre, 'xgw-pn');
          s += T(SVX + 12, y + 58, down ? 'отвечает через 3 с ошибкой 503' : 'отвечает за 12–28 мс', 'xgw-ms' + (down ? ' xgw-bad' : ''));
          const st = hasCb ? cb.st : 'none', lamp = st === 'open' ? 'open' : st === 'half' ? 'half' : st === 'closed' ? 'closed' : 'none';
          s += `<g class="xr-part" data-xpart="resil"><circle class="xgw-lamp ${lamp}" cx="${SVX + SVW - 22}" cy="${y + 22}" r="8"/>${T(SVX + SVW - 36, y + 26, hasCb ? { closed: 'замкнут', open: 'разомкнут', half: 'проба' }[st] : 'без предохр.', 'xgw-ms', 'end')}</g>`;
          s += T(SVX + 12, y + 76, `таймаут: ${eprop(i, 'timeout') ? eprop(i, 'timeout') + ' мс' : 'нет'} · повторов: ${eprop(i, 'retries') || 0}`, 'xgw-ms');
          if (go) s += T(SVX + SVW - 12, y + 76, 'клик — внутрь ›', 'xgw-ms xgw-go', 'end');
          s += '</g>';
        });
        return s;
      }
      function logSvg() {
        const b = LOG;
        let s = `<g class="xr-part" data-xpart="trace">${R(b.x, b.y, b.w, b.h, 'xgw-codebg', 10)}${T(b.x + 12, b.y + 18, 'ACCESS-ЛОГ ШЛЮЗА', 'xr-m')}${T(b.x + b.w - 12, b.y + 18, 'время · id · метод путь → сервис · статус · мс', 'xgw-ms', 'end')}`;
        S.log.forEach((l, j) => {
          const y = b.y + 40 + j * 21, fl = S.t - l.t < 500, cc = l.code === 200 ? 'ok' : l.code === 429 ? 'warn' : 'bad';
          if (fl) s += R(b.x + 6, y - 14, b.w - 12, 19, 'xgw-krow', 4);
          s += MONO(b.x + 12, y, `${hms(l.t).slice(3)} ${l.id.slice(4, 10)} ${l.m.padEnd(4)} ${ES(cut(l.p, 26)).padEnd(26)} → ${ES(cut(l.svc, 11)).padEnd(11)}`) + MONO(b.x + b.w - 70, y, String(l.code), cc) + MONO(b.x + b.w - 12, y, `${nf(l.ms)}`, '', 'end');
        });
        if (!S.log.length) s += T(b.x + 12, b.y + 44, 'ждём запросы…', 'xr-s');
        return s + '</g>';
      }
      function routesSvg() {
        const b = RT, c = counts();
        let s = `<g class="xr-part" data-xpart="route">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}${T(b.x + 12, b.y + 18, 'ТАБЛИЦА МАРШРУТОВ', 'xr-m')}`;
        ROUTES.forEach((r, j) => { const y = b.y + 40 + j * 19, on = S.last && S.last.route === r && S.t - S.last.t < 900; if (on) s += R(b.x + 6, y - 13, b.w - 12, 18, 'xgw-krow', 4); s += MONO(b.x + 12, y, r.pre) + T(b.x + 180, y, `→ ${r.bff ? 'агрегатор: 3 сервиса' : (S.svc[r.svc] ? cut(S.svc[r.svc].real, 22) : r.name)}`, 'xgw-ms'); });
        s += '</g>';
        s += Ln(b.x + 12, b.y + 126, b.x + b.w - 12, b.y + 126, 'xgw-sep') + T(b.x + 12, b.y + 146, 'ЗА 10 С', 'xr-m');
        const rows = [['200', c.ok, 'ok'], ['429', c.r429, 'warn'], ['401', c.r401, 'bad'], ['5xx', c.r5, 'bad']];
        rows.forEach(([k, v, cl], j) => { const x = b.x + 12 + j * 96; s += T(x, b.y + 172, k, 'xgw-fn') + T(x + 34, b.y + 172, String(v), 'xr-m ' + (v ? cl : '')); });
        if (S.scn === 'bot') s += T(b.x + 12, b.y + 196, rl() ? `бот: до сервисов дошло ${c.botIn ? Math.round(c.botOk / c.botIn * 100) : 0} % его запросов` : 'бот: проходит всё — лимита нет', 'xr-s ' + (rl() ? 'xgw-ok' : 'xgw-bad'));
        return s;
      }
      function scnButtons() {
        if (S.scn === 'down') return btn(GW.x + 14, STY + STH + 30, 130, 'to', eprop(1, 'timeout') ? `✓ таймаут ${eprop(1, 'timeout')} мс` : '✕ таймаута нет', !!eprop(1, 'timeout')) + btn(GW.x + 152, STY + STH + 30, 150, 'cb', eprop(1, 'cb') ? '✓ предохранитель' : '✕ предохранителя нет', !!eprop(1, 'cb'));
        if (S.scn === 'bff') return btn(GW.x + 14, STY + STH + 30, 230, 'home', S.homeMode === 'bff' ? '✓ один запрос в агрегатор' : '✕ три запроса с телефона', S.homeMode === 'bff');
        return '';
      }
      function dynSvg() {
        let s = '';
        const rc = SD.kindColor('read'), bc = SD.kindColor('bot');
        S.reqs.forEach(q => {
          const col = q.c.bot ? bc : rc;
          if (q.ph === 'svc') { const y0 = SVY[q.route.svc]; s += `<circle class="xgw-wait" cx="${f1(SVX + 214 + (q.id.charCodeAt(5) % 8) * 11)}" cy="${f1(y0 + 48 + (q.id.charCodeAt(6) % 2) * 11)}" r="4"/>`; return; }
          if (q.ph === 'bff') {
            q.subs.forEach(sb => { const k = (S.t - sb.t0) / 300; if (sb.r.fast) return; if (k <= 1) s += Dot(...lerp(sb.pts[0], sb.pts[1], ease(k)), 3.8, '', `fill:${col}`); else if (S.t < sb.end) s += `<circle class="xgw-wait" cx="${f1(sb.pts[1][0] + 16)}" cy="${f1(sb.pts[1][1])}" r="4"/>`; else { const kk = (S.t - sb.end) / 300; if (kk <= 1) s += Dot(...lerp(sb.pts[1], sb.pts[0], ease(kk)), 3.8, sb.r.code === 200 ? 'ok' : 'err'); } });
            s += T(stPt(3)[0], STY + STH + 16, 'собираем 3 ответа…', 'xr-pop', 'middle'); return;
          }
          const [x, y] = along(q.pts, ease((S.t - q.p0) / q.dur));
          if (q.ph === 'rej') s += Dot(x, y, 4.5, q.res === 429 ? 'wait' : 'err') + (S.t - q.p0 < 260 ? T(x, y - 9, String(q.res), 'xr-pop ' + (q.res === 429 ? 'warn' : 'bad'), 'middle') : '');
          else if (q.ph === 'back') s += Dot(x, y, 4.5, q.res === 200 ? (q.partial ? 'wait' : 'ok') : 'err');
          else s += Dot(x, y, q.c.bot ? 3.6 : 4.5, '', `fill:${col}`);
        });
        if (S.refreshing) { const k = (S.t - S.refreshing.t0) / 1100; s += T(CLX + CLW / 2, CLY[0] - 4 + 0 * k, 'POST /oauth/token (refresh)…', 'xr-pop', 'middle'); }
        return s;
      }
      function drawMain() { gSt.innerHTML = badges() + clientsSvg() + gwSvg() + servicesSvg() + logSvg() + routesSvg() + scnButtons(); gDy.innerHTML = dynSvg(); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 112, 26, 'xgw-backb', 13)}${T(68, 27, '← весь шлюз', 'xr-s xgw-back', 'middle')}</g>` + T(140, 27, t, 'xgw-vt') + T(140, 46, sub, 'xr-s');
      function vJwt() {
        const C = 10000, u = S.vt % C, exp = u > 5000;
        let s = head('Проверка токена (JWT)', auth() ? 'шлюз проверяет подпись и срок сам — без похода в базу и в сервис авторизации' : 'сейчас выключено: токен будет проверять каждый сервис сам');
        s += R(24, 60, 952, 64, 'xgw-codebg', 10) + T(36, 80, 'ЗАГОЛОВОК ЗАПРОСА', 'xr-m');
        s += `<text class="xgw-mono" xml:space="preserve" x="36" y="104">Authorization: Bearer <tspan class="xgw-j1">eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0</tspan>.<tspan class="xgw-j2">eyJzdWIiOiI1NTEyMCIsImV4cCI6MTc4NDAzMjI2N30</tspan>.<tspan class="xgw-j3">Qm9H…kx8</tspan></text>`;
        const col = (x, title, cls, lines) => { let t = R(x, 136, 300, 180, 'xgw-panel ' + cls, 10) + T(x + 12, 158, title, 'xr-t'); lines.forEach((l, j) => { t += MONO(x + 12, 184 + j * 20, ES(l)); }); return t; };
        s += col(24, 'Заголовок', 'j1', ['{', '  "alg": "RS256",', '  "kid": "k1",', '  "typ": "JWT"', '}', 'чем подписано и каким ключом']);
        s += col(350, 'Данные (payload)', 'j2', ['{', '  "sub": "55120",', '  "scope": "orders:write catalog:read",', `  "exp": 1784032267  ${exp ? '← уже прошло!' : '← 12:31:07 + 15 мин'}`, '}', '']);
        s += col(676, 'Подпись', 'j3', ['RSASSA(', '  base64(заголовок) + "." +', '  base64(данные),', '  закрытый ключ сервера', '  авторизации)', 'проверка — открытым ключом из JWKS']);
        const steps = [['подпись', 'открытый ключ k1 из /.well-known/jwks.json', true], ['срок exp', exp ? 'истёк 2 минуты назад' : 'действует ещё 14 мин', !exp], ['права scope', 'POST /api/orders требует orders:write', true]];
        s += R(24, 328, 952, 130, 'xgw-panel', 10) + T(36, 350, 'ЧТО ПРОВЕРЯЕТ ШЛЮЗ', 'xr-m');
        steps.forEach(([a, b2, ok], j) => { const y = 378 + j * 26; s += T(36, y, ok ? '✓' : '✕', 'xr-m ' + (ok ? 'ok' : 'bad')) + T(56, y, a, 'xgw-fn') + T(200, y, b2, 'xr-s' + (ok ? '' : ' xgw-bad')); });
        s += R(24, 470, 952, 78, 'xgw-codebg' + (exp ? ' bad' : ''), 10);
        if (exp) s += MONO(36, 494, 'HTTP/1.1 401 Unauthorized', 'bad') + MONO(36, 514, 'WWW-Authenticate: Bearer error="invalid_token", error_description="token expired"') + T(36, 536, 'Клиент: POST /oauth/token grant_type=refresh_token → новый access-токен → повтор запроса.', 'xgw-ms');
        else s += MONO(36, 494, 'в сервис уходит:  X-User-Id: 55120   X-Scopes: orders:write catalog:read', 'ok') + T(36, 518, 'Сервисам не нужно разбирать токен: шлюз уже проверил, кто это и что ему можно.', 'xgw-ms') + T(36, 538, auth() ? '' : 'Сейчас проверка на шлюзе выключена — каждый сервис делает это сам.', 'xgw-ms xgw-warn');
        return s;
      }
      function vBucket() {
        const C = 8000, u = S.vt % C, a = algo();
        let s = head('Лимит частоты: три алгоритма', `лимит 5 запросов в секунду на клиента; бот шлёт пачками у границы секунды · сейчас: ${rl() ? { token: 'token bucket', sliding: 'sliding window', fixed: 'fixed window' }[a] : 'лимит выключен'}`);
        // бот: пачка по 6 запросов в конце каждой секунды и ещё 6 в начале следующей
        const reqs = []; for (let sec = 0; sec < 6; sec++) { for (let j = 0; j < 6; j++) reqs.push(sec * 1000 + 820 + j * 25); for (let j = 0; j < 6; j++) reqs.push(sec * 1000 + 1000 + 10 + j * 25); }
        const pass = (alg, t0) => { const out = []; let n = BURST, last = 0, w = -1, wn = 0, log = []; reqs.forEach(t => { if (t > t0) return; let ok; if (alg === 'token') { n = Math.min(BURST, n + (t - last) / 1000 * REFILL); last = t; ok = n >= 1; if (ok) n -= 1; } else if (alg === 'fixed') { const ww = Math.floor(t / 1000); if (ww !== w) { w = ww; wn = 0; } ok = wn < BURST; if (ok) wn++; } else { log = log.filter(x => x > t - 1000); ok = log.length < BURST; if (ok) log.push(t); } out.push([t, ok]); }); return out; };
        const X = t => 60 + t / 6000 * 900;
        [['token', 'Token bucket: ведро на 5, +2 жетона в секунду'], ['sliding', 'Sliding window: не больше 5 за последние 1000 мс'], ['fixed', 'Fixed window: не больше 5 за календарную секунду']].forEach(([alg, title], j) => {
          const y = 70 + j * 140, res = pass(alg, u), okN = res.filter(r => r[1]).length, cur = rl() && alg === a;
          s += R(24, y, 952, 128, 'xgw-panel' + (cur ? ' on' : ''), 10) + T(36, y + 22, title, 'xr-t') + T(964, y + 22, `пропущено ${okN} из ${res.length}`, 'xr-m ' + (alg === 'fixed' ? 'warn' : 'ok'), 'end');
          for (let sec = 0; sec <= 6; sec++) s += Ln(X(sec * 1000), y + 36, X(sec * 1000), y + 108, 'xgw-tick') + (j === 2 ? '' : '') + T(X(sec * 1000), y + 120, `${sec} с`, 'xgw-ms', 'middle');
          res.forEach(([t, ok]) => { s += `<rect class="xgw-hit ${ok ? 'ok' : 'no'}" x="${f1(X(t) - 2)}" y="${ok ? y + 46 : y + 76}" width="4" height="22" rx="1"/>`; });
          s += T(36, y + 62, 'пропущен', 'xgw-ms') + T(36, y + 92, '429', 'xgw-ms xgw-warn');
          if (alg === 'fixed') {
            const burst = res.filter(([t, ok]) => ok && Math.floor((t - 820) / 1000) === 0 && t >= 820 && t <= 1200).length;
            s += R(X(800) - 4, y + 40, X(1200) - X(800) + 8, 34, 'xgw-burst', 4) + T(840, y + 22, burst >= 8 ? `${burst} подряд за 0,3 с — двойной всплеск на стыке окон` : 'на стыке окон проходит до 10 подряд', 'xr-s xgw-warn', 'end');
            if (burst >= 8 && cur) S.pv.fixBurst = 1;
          }
        });
        s += T(36, 508, 'Token bucket допускает запас (5) и дальше ровно 2 в секунду. Sliding window считает точно, но хранит время каждого запроса.', 'xgw-ms');
        s += T(36, 528, 'Fixed window проще всего (один счётчик INCR с TTL в Redis), но на границе секунды пропускает до 2 × лимита — боты это используют.', 'xgw-ms');
        return s;
      }
      function vRoute() {
        const C = 8000, i = Math.floor(S.vt / 2000) % ROUTES.length, r = ROUTES[i], u = S.vt % 2000;
        let s = head('Маршрутизация по пути', 'клиенты знают один адрес; шлюз по таблице решает, куда отправить запрос');
        s += R(24, 60, 952, 54, 'xgw-codebg', 10) + MONO(36, 92, `${r.m} https://api.shop.ru${r.p}`, 'on');
        s += R(24, 126, 470, 250, 'xgw-panel', 10) + T(36, 148, 'ТАБЛИЦА МАРШРУТОВ', 'xr-m');
        ROUTES.forEach((rr, j) => { const y = 178 + j * 44, on = j === i && u > 500; if (on) s += R(30, y - 22, 458, 38, 'xgw-krow', 6); s += MONO(40, y, rr.pre, on ? 'on' : '') + T(220, y, `→ ${rr.bff ? 'агрегатор' : S.svc[rr.svc] ? cut(S.svc[rr.svc].real, 22) : rr.name}`, 'xr-s' + (on ? ' xgw-acc' : '')) + T(220, y + 14, rr.bff ? 'catalog + orders + users параллельно' : `rewrite: ${rr.pre.replace('/api', '').replace('/*', '')}`, 'xgw-ms'); });
        s += R(506, 126, 470, 250, 'xgw-codebg', 10);
        ['# Kong / декларативный конфиг (deck)', 'services:', '- name: catalog', '  url: http://catalog.svc:8080', '  routes: [{ paths: ["/api/catalog"], strip_path: true }]', '- name: orders', '  url: http://orders.svc:8080', '  routes: [{ paths: ["/api/orders"], methods: ["POST", "GET"] }]', '  plugins: [{ name: rate-limiting, config: { second: 5 } }]', '- name: users', '  url: http://users.svc:8080', '  routes: [{ paths: ["/api/me"] }]'].forEach((l, j) => { s += CODE(518, 148 + j * 18, l, 'sm'); });
        s += R(24, 388, 952, 160, 'xgw-panel', 10) + T(36, 410, 'ЧТО ЕЩЁ ДЕЛАЕТ МАРШРУТ', 'xr-m');
        ['· самый длинный подходящий префикс побеждает: /api/catalog/admin можно отправить в другой сервис', '· можно разделить по методу, заголовку, версии (/v2/…) или по пользователю (канарейка: 5 % в новую версию)', '· сервисы видны шлюзу по внутренним именам; переехал сервис — поменяли url, приложение не трогаем', '· клиенту не видна внутренняя структура: распилили монолит — таблица стала длиннее, адрес тот же'].forEach((l, j) => { s += T(36, 436 + j * 26, l, 'xr-s'); });
        return s;
      }
      function vBff() {
        const C = 9000, u = S.vt % C, k = clamp(u / 7000, 0, 1), RTT = 120;
        let s = head('Агрегация: Backend for Frontend', 'главному экрану нужны 3 сервиса; мобильная сеть — 120 мс туда и обратно');
        const lane = (y, title, bars, tot, cls) => {
          let t = R(24, y, 952, 160, 'xgw-panel ' + cls, 10) + T(36, y + 22, title, 'xr-t') + T(964, y + 22, `≈ ${tot} мс до экрана`, 'xr-m ' + (cls === 'badb' ? 'bad' : 'ok'), 'end');
          const X = ms => 180 + ms * 1.4;
          bars.forEach(([n, a, d, c], j) => { const yy = y + 44 + j * 26, w = d * 1.4, shown = clamp((k * 600 - a) * 1.4, 0, w); t += T(36, yy + 14, n, 'xgw-ms') + R(X(a), yy, w, 18, 'xgw-span', 3) + R(X(a), yy, shown, 18, 'xgw-span ' + c, 3) + T(X(a) + w + 8, yy + 13, `${d} мс`, 'xgw-pn'); });
          return t;
        };
        s += lane(60, 'Три запроса с телефона', [['GET /api/catalog', 0, RTT + 20, 'c'], ['GET /api/orders', 0, RTT + 30, 'o'], ['GET /api/me', 0, RTT + 15, 'u'], ['разбор 3 ответов', RTT + 30, 40, 'p']], RTT + 70, 'badb');
        s += T(36, 212, 'Даже параллельно: три соединения по мобильной сети, три разбора; на 3G последовательно — 3 × 120 мс.', 'xgw-ms');
        s += lane(230, 'Один запрос в агрегатор', [['GET /api/home', 0, RTT + 30, 'c'], ['→ catalog (внутри ДЦ)', 60, 18, 'c'], ['→ orders (внутри ДЦ)', 60, 28, 'o'], ['→ users (внутри ДЦ)', 60, 12, 'u']], RTT + 30, 'okb');
        s += T(36, 382, 'Агрегатор ходит в сервисы внутри дата-центра за единицы миллисекунд и отдаёт один ответ, собранный под экран.', 'xgw-ms');
        s += R(24, 400, 952, 148, 'xgw-codebg', 10);
        ['GET /api/home  →  200 OK', '{ "products": [ { "id": 3071, "title": "Кроссовки беговые…", "price": 12990 } ],', '  "orders":   { "error": "temporarily_unavailable" },          ← упал сервис заказов — экран всё равно есть', '  "me":       { "name": "Анна К.", "bonus": 340 } }'].forEach((l, j) => { s += MONO(36, 426 + j * 22, ES(l), j === 2 ? 'warn' : j === 0 ? 'ok' : ''); });
        s += T(36, 530, 'Обычно BFF свой на каждый клиент: мобильный, веб, партнёрский API — у них разные экраны и разные поля.', 'xgw-ms');
        return s;
      }
      function vResil() {
        const C = 14000, u = S.vt % C, X = t => 60 + t / 14000 * 900;
        let s = head('Таймаут и предохранитель на маршруте', `маршрут /api/orders · сейчас: таймаут ${eprop(1, 'timeout') ? eprop(1, 'timeout') + ' мс' : 'нет'}, предохранитель ${eprop(1, 'cb') ? 'есть' : 'нет'}`);
        const lane = (y, title, mode) => {
          let t = R(24, y, 952, 136, 'xgw-panel', 10) + T(36, y + 22, title, 'xr-t');
          let st = 'closed', openAt = 0, fails = 0, hang = 0;
          for (let i = 0; i < 40; i++) {
            const t0 = i * 340; if (t0 > u) break;
            let d, cls, lab;
            if (mode === 'none') { d = 3000; cls = 'hang'; hang++; }
            else if (mode === 'to') { d = 300; cls = 'to'; }
            else {
              if (st === 'open' && t0 - openAt > 5000) st = 'half';
              if (st === 'open') { d = 8; cls = 'fast'; }
              else { d = 300; cls = st === 'half' ? (t0 > 9000 ? 'ok' : 'to') : 'to'; if (st === 'half') { st = cls === 'ok' ? 'closed' : 'open'; openAt = t0; } else { fails++; if (fails >= 5) { st = 'open'; openAt = t0; fails = 0; } } }
              if (t0 > 9000 && st === 'closed' && i > 0) { cls = 'ok'; d = 25; }
            }
            const w = Math.max(3, Math.min(d, u - t0) / 14000 * 900);
            t += R(X(t0), y + 40 + (i % 4) * 20, w, 14, 'xgw-call ' + cls, 2);
          }
          return t;
        };
        s += lane(60, 'Без таймаута: каждый вызов висит 3 с и копит соединения', 'none');
        s += lane(206, 'Таймаут 300 мс: 504 быстро, но больной сервис всё равно получает каждый запрос', 'to');
        s += lane(352, 'Таймаут + предохранитель: после 5 ошибок — сразу 503, через 5 с пробный запрос', 'cb');
        s += R(X(9000) - 2, 352 + 34, 4, 96, 'xgw-mark', 1) + T(X(9000) + 6, 352 + 128, 'сервис ожил', 'xgw-ms xgw-ok');
        s += T(36, 510, 'Серые полосы — висящие вызовы, жёлтые — 504 по таймауту, красные — мгновенный 503 от разомкнутого предохранителя, зелёные — снова здоров.', 'xgw-ms');
        s += T(36, 530, 'Повторы (retries) ставят только на идемпотентные GET и с паузой — иначе шлюз сам добивает больной сервис.', 'xgw-ms');
        return s;
      }
      function vTrace() {
        const L = S.log.find(l => l.code === 200) || { id: 'req-7f3a91c2', p: '/api/catalog/products/3071', svc: 'catalog', ms: 24 };
        S.pv.trace = 1;
        let s = head('Журнал и трассировка', `один запрос — один номер: ${L.id}, его несут все сервисы`);
        const spans = [['api-gateway', 'вход: TLS, разбор HTTP', 0, 0.6, 0], ['api-gateway', 'проверка JWT', 0.6, 0.3, 1], ['api-gateway', 'лимит частоты (Redis INCR)', 0.9, 0.8, 1], ['api-gateway', 'маршрут → catalog', 1.7, 0.1, 1], ['catalog', 'GET /products/3071', 1.8, 21, 1], ['catalog', 'Redis GET product:3071 — промах', 2.3, 0.6, 2], ['catalog', 'PostgreSQL SELECT … WHERE id = 3071', 3.1, 17.2, 2], ['api-gateway', 'ответ клиенту', 22.8, 0.5, 1]];
        const tot = 23.3, X = ms => 330 + ms / tot * 560, worst = spans.reduce((m, sp, j) => sp[3] > spans[m][3] && j !== 4 ? j : m, 1);
        s += R(24, 60, 952, 300, 'xgw-panel', 10) + T(36, 82, `ТРАССА ${L.id} · ${nf(tot, 1)} мс`, 'xr-m');
        spans.forEach(([svc, n, a, d, lv], j) => {
          const y = 104 + j * 30, w = Math.max(3, d / tot * 560), wst = j === worst;
          s += T(36 + lv * 12, y + 13, svc, 'xgw-fn') + T(150 + lv * 0, y + 13, ES(cut(n, 26)), 'xgw-ms' + (wst ? ' xgw-warn' : '')) + R(X(a), y, w, 18, 'xgw-span ' + (svc === 'catalog' ? 'c' : 'g') + (wst ? ' hot' : ''), 3) + T(X(a) + w + 6, y + 13, `${nf(d, 1)} мс`, 'xgw-pn');
        });
        s += T(36, 350, `Самый длинный шаг — «${spans[worst][1]}»: ${nf(spans[worst][3], 1)} мс из ${nf(tot, 1)}. Сам шлюз добавил ≈ 1,7 мс.`, 'xr-s xgw-acc');
        s += R(24, 372, 952, 176, 'xgw-codebg', 10) + T(36, 392, 'ЧТО УХОДИТ В СЕРВИС И В ЛОГ', 'xr-m');
        [`X-Request-Id: ${L.id}`, `traceparent: 00-${L.id.slice(4)}a7c19e2b44d10f3e5b8c-01d5e8a2b3c4f601-01`, `access.log: 12:31:07.412 ${L.id} GET ${L.p} 200 23ms ua="ShopApp/5.2 iOS" user=55120 route=catalog`, 'метрики: gateway_requests_total{route="catalog",code="200"}  gateway_latency_seconds_bucket{route="catalog",le="0.025"}'].forEach((l, j) => { s += MONO(36, 418 + j * 26, ES(cut(l, 120)), j < 2 ? 'on' : ''); });
        s += T(36, 530, 'По номеру из жалобы пользователя («ошибка req-7f3a91c2») дежурный находит все строки логов и всю трассу за секунды.', 'xgw-ms');
        return s;
      }
      const VIEWS = { jwt: vJwt, bucket: vBucket, route: vRoute, bff: vBff, resil: vResil, trace: vTrace };
      function partNow(k) {
        if (k === 'jwt') return auth() ? '<b>JWT</b>: шлюз проверяет подпись открытым ключом, срок exp и права scope — без похода в базу. Просроченный токен — 401 на первой же ступени.' : '<b>Проверка токена выключена</b>: шлюз пропускает любой токен, каждый сервис должен проверять его сам.';
        if (k === 'bucket') return rl() ? `<b>Сейчас ${({ token: 'token bucket', sliding: 'sliding window', fixed: 'fixed window' })[algo()]}.</b> На картинке бот присылает пачки у границы секунды: fixed window пропускает двойной всплеск, два других — нет.` : '<b>Лимит выключен</b> — бот проходит целиком. Ниже показано, что сделал бы каждый алгоритм.';
        if (k === 'route') return '<b>Маршрут</b>: путь запроса сравнивается с таблицей, побеждает самый длинный префикс; шлюз переписывает путь и отправляет запрос в сервис по внутреннему имени.';
        if (k === 'bff') return '<b>Агрегатор</b>: один запрос с телефона вместо трёх, вызовы сервисов — внутри дата-центра и параллельно. Упал один сервис — экран собирается частично.';
        if (k === 'resil') return '<b>Таймаут</b> не даёт запросам висеть, <b>предохранитель</b> перестаёт звать больной сервис и пробует снова через 5 с.';
        if (k === 'trace') return '<b>Трасса</b>: номер запроса проходит через все сервисы; по водопаду видно, что дольше всего идёт запрос в базу, а сам шлюз добавляет пару миллисекунд.';
        return '';
      }

      /* ---------- шаг модели ---------- */
      function tick(dt) {
        if (!S.svc) return;
        S.t += dt; S.cfgT += dt;
        const pk = ctx.part && ctx.part();
        if (pk) { S.vt += dt; if (pk === 'bucket' && S.pv.fixBurst) done('pfix'); if (pk === 'trace' && S.vt > 2000) done('ptrace'); }
        clientsShown().forEach(c => { while (S.cliAt[c.id] <= S.t) { S.cliAt[c.id] += 1000 / c.rate * (0.6 + Math.random() * 0.8); spawn(c); } });
        S.botLoad = S.scn === 'bot' && !rl() ? 1 : 0;
        for (const q of S.reqs.slice()) { let g = 0; while (!q.gone && S.t >= q.p0 + q.dur && g++ < 6) advance(q); }
        S.reqs = S.reqs.filter(q => !q.gone);
        refreshToken(); refreshStep();
        S.ev = S.ev.filter(e => e.t > S.t - 10000);
        if (S.scn === 'bot' && rl() && S.flags.b429 && !S.ev.some(e => !e.bot && e.code === 429 && e.t > S.t - 4000)) done('bot');
        if (S.scn === 'down' && eprop(1, 'cb') && eprop(1, 'timeout') && S.flags.fast) done('cb');
      }
      function draw() {
        if (!S.svc) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() { S.svc = services(); },
        scenario(id) { const fl = S.flags; S.scn = id; reset(); S.flags = fl; },
        onProp(key, prev, v) {
          S.cfgT = 0;
          if (key === 'rateLimit') return v ? 'Лимит включён: у каждого клиента своё ведро на 5 жетонов. В «Бот бьёт» лишние запросы бота получат 429.' : 'Лимит выключен: шлюз пропускает всё, что пришло. Бот бьёт прямо в каталог.';
          if (key === 'rlAlgo') return v === 'fixed' ? 'Fixed window: один счётчик на секунду. Просто, но на стыке секунд проходит до 2 × лимита — открой блок «Лимит частоты».' : v === 'sliding' ? 'Sliding window: считаем запросы за последние 1000 мс — точно, но храним время каждого запроса.' : 'Token bucket: запас 5 жетонов и пополнение 2 в секунду — допускает короткий всплеск.';
          if (key === 'auth') return v ? 'Шлюз снова проверяет токен: просроченный получает 401 на первой ступени и до сервисов не доходит.' : 'Проверка токена на шлюзе выключена: запрос с любым токеном проходит дальше, проверять придётся каждому сервису.';
          if (key === 'count') return +v < 2 ? 'Один экземпляр шлюза — единственная дверь: упадёт он, упадёт всё API.' : `Экземпляров ${v}: счётчики лимита общие (в Redis), падение одного не страшно.`;
          return '';
        },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const c = counts();
          if (S.scn === 'bot') return rl() ? `<b>Бот упирается в лимит.</b> Его ведро пустеет за долю секунды — дальше проходят 2 запроса в секунду, остальные 429 (${c.r429} за 10 с). Обычные пользователи получают 200: у них свои вёдра. До сервисов дошло ${c.botIn ? Math.round(c.botOk / c.botIn * 100) : 0} % запросов бота.` : `<b>Лимита нет — бот проходит целиком.</b> 22 запроса в секунду с одного адреса летят в каталог, сервис нагружен, ответы всем медленнее. Включи «Rate limiting» справа.`;
          if (S.scn === 'down') { const cb = S.cb[1]; return !eprop(1, 'timeout') ? `<b>«Заказы» отвечают через 3 с ошибкой, а таймаута нет:</b> каждый запрос висит в шлюзе (сейчас ${S.hang}), занимая соединения. При большом потоке шлюз задохнётся и уронит здоровые маршруты. Включи таймаут.` : !eprop(1, 'cb') ? `<b>Таймаут ${eprop(1, 'timeout')} мс:</b> запросы отваливаются быстро с 504, но больной сервис всё равно получает каждый. Добавь предохранитель.` : `<b>Предохранитель ${cb.st === 'open' ? 'разомкнут' : cb.st === 'half' ? 'пробует' : 'замкнут'}:</b> ${cb.st === 'open' ? 'шлюз сразу отвечает 503, не трогая сервис; через 5 с — пробный запрос.' : 'считаем ошибки: при половине неудач из последних 10 — разомкнётся.'} Главный экран (/api/home) собирается без блока заказов.`; }
          if (S.scn === 'expired') return S.t < S.tok.exp ? '<b>Токен мобильного приложения ещё действует.</b> Скоро срок кончится — следи за первой ступенью.' : S.refreshing ? '<b>Приложение получило 401 и обновляет токен</b> через refresh-токен. Сейчас пойдут повторы.' : auth() ? '<b>Шлюз отбивает просроченный токен 401</b> на первой ступени — сервисы его не видят.' : '<b>Проверка на шлюзе выключена:</b> просроченный токен прошёл до сервиса, и сервис сам ответил 401 — лишний поход и риск, если какой-то сервис забудет проверить.';
          if (S.scn === 'bff') return S.homeMode === 'bff' ? '<b>Один запрос /api/home:</b> шлюз-агрегатор параллельно зовёт каталог, заказы и профиль внутри дата-центра и отдаёт один ответ. По мобильной сети — одна дорога туда и обратно.' : '<b>Три запроса с телефона:</b> каждый идёт по мобильной сети через все ступени шлюза — три соединения, три ответа, телефон склеивает сам.';
          return `<b>Каждый запрос проходит ступени шлюза:</b> токен → лимит → маршрут → вызов сервиса с таймаутом. Отказы видны сразу: 401 на первой ступени, 429 на второй. Номер запроса из лога несут все сервисы. За 10 с: 200 — ${c.ok}, 429 — ${c.r429}, 401 — ${c.r401}, 5xx — ${c.r5}.`;
        },
        stats() {
          const c = counts();
          return [
            ['200 OK', String(c.ok), 'ok', 'за 10 с'],
            ['429', String(c.r429), c.r429 ? 'warn' : '', 'лимит частоты'],
            ['401', String(c.r401), c.r401 ? 'bad' : '', auth() ? 'отбил шлюз' : 'отбили сервисы'],
            ['5xx', String(c.r5), c.r5 ? 'bad' : 'ok', '503 / 504 от маршрутов'],
            ['Висят', String(S.hang), S.hang ? 'bad' : 'ok', 'ждут ответа сервиса'],
            ['Боты до сервисов', c.botIn ? Math.round(c.botOk / c.botIn * 100) + ' %' : '—', c.botIn && c.botOk / c.botIn > 0.2 ? 'bad' : 'ok', 'в модели за 10 с']
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
