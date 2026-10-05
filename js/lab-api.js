/* Лаборатория «API и контракты»: как сервисам разговаривать (REST, gRPC, GraphQL, событие, WebSocket),
   контракты по текущей схеме (OpenAPI, protobuf, AsyncAPI) и чек-лист хорошего API. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const T = () => SD.TYPES;
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const KIND = { rest: 'REST', grpc: 'gRPC', graphql: 'GraphQL', event: 'Событие', ws: 'WebSocket' };
  const CASES = [
    { id: 'catalog', t: 'Мобильное приложение → бэкенд: каталог товаров', d: 'Читают в сотни раз чаще, чем меняют; разные экраны показывают разные поля.',
      m: { rest: ['good', 'GET кэшируется браузером, CDN и прокси; понятен всем клиентам. Лишние поля решает BFF или ?fields=.'], graphql: ['good', 'Клиент сам выбирает поля — удобно для разных экранов; но кэшировать на CDN сложнее, нужен лимит сложности запроса.'], grpc: ['ok', 'Быстро и строго типизировано, но из браузера нужен gRPC-Web и прокси, CDN не закэширует.'], event: ['bad', 'Пользователь ждёт ответ прямо сейчас — событию отвечать некому.'], ws: ['bad', 'Держать соединение ради запроса-ответа — дорого и не кэшируется.'] } },
    { id: 'pay', t: 'Сервис заказов → сервис платежей: списать деньги', d: 'Нужен ответ сейчас: оплачено или нет. Повтор не должен списать дважды.',
      m: { grpc: ['good', 'Синхронный вызов с дедлайном и ключом идемпотентности; бинарный формат и HTTP/2 — быстро.'], rest: ['good', 'POST /payments с заголовком Idempotency-Key и таймаутом — классика; проще отлаживать.'], event: ['ok', 'Можно, если весь процесс — сага с асинхронным результатом; но покупатель ждёт ответа, и UX усложняется.'], graphql: ['bad', 'GraphQL для команд между сервисами — лишний слой, без выгоды.'], ws: ['bad', 'Не для вызова между сервисами.'] } },
    { id: 'notify', t: 'Сервис заказов → уведомления: письмо после заказа', d: 'Заказу не важно, когда уйдёт письмо, — важно, чтобы ушло.',
      m: { event: ['good', 'Публикуем «заказ создан», уведомления подписаны. Почта упала — заказы работают, письма догонят из очереди.'], rest: ['bad', 'Синхронный вызов связывает судьбы: упадёт почта — упадёт оформление заказа.'], grpc: ['bad', 'Та же связность, что у REST: падение уведомлений роняет заказы.'], graphql: ['bad', 'Не для команд между сервисами.'], ws: ['bad', 'Не для связи между сервисами.'] } },
    { id: 'analytics', t: 'Склад → аналитика: изменения остатков', d: 'Аналитике нужны все изменения, складу не нужно знать про аналитику.',
      m: { event: ['good', 'Поток событий (или CDC из базы склада): аналитика читает в своём темпе, склад не знает о потребителях.'], rest: ['bad', 'Опрашивать склад по расписанию — нагрузка на боевую базу и пропуски изменений.'], grpc: ['bad', 'Синхронная связность ради отчётов.'], graphql: ['bad', 'Запросы на чтение по расписанию — та же проблема опроса.'], ws: ['ok', 'Поток изменений через соединение возможен, но очередь надёжнее: переживёт перезапуск потребителя.'] } },
    { id: 'chat', t: 'Чат: сервер → клиент, новые сообщения', d: 'Сообщение должно появиться у собеседника сразу, без перезагрузки.',
      m: { ws: ['good', 'Соединение держится, сервер сам присылает новое за миллисекунды. Альтернатива для простых случаев — SSE.'], rest: ['ok', 'Опрос раз в N секунд работает на малом масштабе, но это задержка и лишняя нагрузка.'], event: ['ok', 'Внутри — да, через брокер к шлюзу; но до клиента всё равно нужен WebSocket или push.'], grpc: ['ok', 'Серверный стриминг gRPC подходит для своих мобильных клиентов, из браузера — сложнее.'], graphql: ['ok', 'GraphQL Subscriptions работают поверх WebSocket — если GraphQL уже есть.'] } },
    { id: 'price', t: 'Сервис корзины → сервис цен: 20 000 запросов/с, ответ за миллисекунды', d: 'Внутренний горячий вызов, много мелких запросов.',
      m: { grpc: ['good', 'Бинарный protobuf, HTTP/2 с мультиплексированием и строгий контракт — меньше CPU и задержки.'], rest: ['ok', 'Работает, но JSON и новые соединения стоят дороже на таких объёмах.'], event: ['bad', 'Цена нужна сейчас для ответа покупателю.'], graphql: ['bad', 'Гибкость полей не нужна, а разбор запроса — лишняя работа.'], ws: ['bad', 'Не для вызова между сервисами.'] } }
  ];
  const CHECK = [
    ['Идемпотентность', 'POST /orders с заголовком Idempotency-Key: при повторе сервер вернёт тот же ответ, а не создаст второй заказ.', 'Idempotency-Key: 7f3c…'],
    ['Пагинация курсором', 'Не ?page=5000 (база перебирает 5000 страниц), а ?cursor=…&limit=50 — продолжаем с места.', 'GET /items?cursor=eyJpZCI6NDJ9&limit=50'],
    ['Версии', 'Добавлять поля можно всегда; удалять и менять смысл — только в новой версии (/v2) с переходным периодом.', '/api/v1/orders'],
    ['Единый формат ошибок', 'Код ответа + тело с типом и понятным текстом (RFC 7807). 409 — конфликт, 422 — неверные данные, 429 — слишком часто.', '{"type":"…/out-of-stock","title":"Товар закончился"}'],
    ['Лимиты и Retry-After', 'При 429 и 503 сервер говорит, когда повторить; клиент повторяет с паузой и случайной добавкой.', 'Retry-After: 2'],
    ['Таймауты и дедлайны', 'Каждый вызов — с таймаутом меньше, чем у вызывающего; gRPC передаёт дедлайн дальше по цепочке.', 'grpc-timeout: 300m'],
    ['События: идентификатор и версия', 'У события есть event_id (для идемпотентного потребителя), время и версия схемы; доставка — «хотя бы один раз».', 'event_id, occurred_at, schema: orders.created.v1'],
    ['Обратная совместимость', 'Потребитель игнорирует незнакомые поля; производитель не удаляет поля без новой версии.', 'tolerant reader']
  ];

  /* ---------- контракты по схеме ---------- */
  const slug = s => String(s || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '') || 'service';
  const ROLE_EN = { orders: 'Orders', payments: 'Payments', catalog: 'Catalog', users: 'Users', auth: 'Auth', search: 'Search', delivery: 'Delivery', stock: 'Stock', recs: 'Recommendations', notify: 'Notifications' };
  const pascal = n => ROLE_EN[n.props && n.props.role] || (String(n.id).replace(/[^a-z0-9]/gi, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, '') || 'Service');
  function contracts(A) {
    const g = A.graph, L = A.level, tr = L.traffic || {};
    const by = id => g.nodes.find(n => n.id === id);
    const apps = g.nodes.filter(n => n.type === 'app');
    const edge = e => [by(e.from), by(e.to)];
    let open = `openapi: 3.0.3\ninfo:\n  title: ${L.title} — внешнее API\n  version: "1.0"\npaths:\n`;
    if (tr.read || tr.static) open += `  /api/v1/items/{id}:\n    get:\n      summary: Карточка товара (кэшируется)\n      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]\n      responses:\n        "200": { description: OK, headers: { Cache-Control: { schema: { type: string, example: "public, max-age=60" } }, ETag: { schema: { type: string } } } }\n        "404": { $ref: "#/components/responses/Problem" }\n`;
    if (tr.search || tr.read) open += `  /api/v1/items:\n    get:\n      summary: Список с курсорной пагинацией\n      parameters:\n        - { name: cursor, in: query, schema: { type: string } }\n        - { name: limit, in: query, schema: { type: integer, maximum: 100, default: 50 } }\n      responses:\n        "200": { description: "items + next_cursor" }\n`;
    if (tr.write) open += `  /api/v1/orders:\n    post:\n      summary: Создать заказ (идемпотентно)\n      parameters: [{ name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }]\n      responses:\n        "201": { description: Создан }\n        "409": { $ref: "#/components/responses/Problem" }\n        "422": { $ref: "#/components/responses/Problem" }\n        "429": { description: Слишком часто, headers: { Retry-After: { schema: { type: integer } } } }\n`;
    if (tr.upload && g.nodes.some(n => n.type === 'objstore')) open += `  /api/v1/uploads:\n    post:\n      summary: Получить подписанную ссылку — файл грузится прямо в хранилище\n      responses:\n        "201": { description: "upload_url (presigned), expires_in" }\n`;
    open += `components:\n  responses:\n    Problem:\n      description: Ошибка в формате RFC 7807\n      content: { application/problem+json: { schema: { type: object, properties: { type: { type: string }, title: { type: string }, detail: { type: string } } } } }\n`;
    /* сервис → сервис */
    const s2s = g.edges.map(edge).filter(([a, b]) => a && b && a.type === 'app' && b.type === 'app');
    let proto = '';
    if (s2s.length) {
      proto = 'syntax = "proto3";\npackage shop.v1;\n\n';
      [...new Set(s2s.map(([, b]) => b.id))].map(by).forEach(b => {
        const P = pascal(b);
        proto += `// «${nm(b)}». Вызывающие: ${s2s.filter(([, x]) => x.id === b.id).map(([a]) => nm(a)).join(', ')}. Дедлайн — меньше, чем у вызывающего.\nservice ${P}Service {\n  rpc Get${P}(Get${P}Request) returns (${P});\n  rpc Create${P}(Create${P}Request) returns (${P}); // idempotency_key в запросе\n}\nmessage Get${P}Request { string id = 1; }\nmessage Create${P}Request { string idempotency_key = 1; bytes payload = 2; }\nmessage ${P} { string id = 1; int64 version = 2; }\n\n`;
      });
    }
    /* события */
    const qs = g.nodes.filter(n => n.type === 'queue');
    let async = '';
    if (qs.length) {
      async = `asyncapi: 2.6.0\ninfo:\n  title: ${L.title} — события\n  version: "1.0"\nchannels:\n`;
      qs.forEach(q => {
        const pub = g.edges.filter(e => e.to === q.id).map(e => by(e.from)).filter(Boolean), sub = g.edges.filter(e => e.from === q.id).map(e => by(e.to)).filter(Boolean);
        const ch = (pub[0] && pub[0].props && pub[0].props.role ? pub[0].props.role : (L.job ? 'tasks' : 'events')) + '.created.v1';
        async += `  ${ch}:\n    description: «${nm(pub[0] || q)}» → ${nm(q)} → ${sub.map(nm).join(', ') || 'потребители'}. Доставка хотя бы один раз — потребитель идемпотентен по event_id.\n    publish:\n      message:\n        payload:\n          type: object\n          required: [event_id, occurred_at, schema_version]\n          properties:\n            event_id: { type: string, format: uuid }\n            occurred_at: { type: string, format: date-time }\n            schema_version: { type: integer, example: 1 }\n            data: { type: object }\n`;
      });
    }
    return { open, proto, async, apps: apps.length };
  }

  const KEY = 'amp-stroyka-api-v1';
  let U = { pick: {}, tab: 'pick', ct: 'open' };
  try { Object.assign(U, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };

  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'api', title: 'API и контракты', lede: 'REST, gRPC, события, WebSocket — что, где и почему',
    intro: 'Как сервисам разговаривать — такое же архитектурное решение, как выбор базы. Выбери способ для каждой связи, посмотри контракты, сгенерированные по твоей схеме, и чек-лист хорошего API.',
    tasks: [
      { id: 'all', text: 'Выбери хорошие способы для всех шести связей' },
      { id: 'notify', text: 'Попробуй связать заказы и уведомления синхронно — и посмотри, почему это плохо' },
      { id: 'contract', text: 'Открой контракты по своей схеме' },
      { id: 'check', text: 'Пролистай чек-лист хорошего API' }
    ],
    mount(el, api) {
      const draw = () => {
        let h = `<div class="seg ap-tabs">${[['pick', 'Выбор взаимодействия'], ['contract', 'Контракты по схеме'], ['check', 'Чек-лист API']].map(([k, t]) => `<button type="button" data-aptab="${k}" aria-selected="${U.tab === k}">${t}</button>`).join('')}</div>`;
        if (U.tab === 'pick') {
          h += '<div class="ap-cases">';
          CASES.forEach(c => {
            const p = U.pick[c.id], r = p && c.m[p];
            h += `<section class="ap-case ${r ? r[0] : ''}"><b>${esc(c.t)}</b><small>${esc(c.d)}</small><div class="seg">${Object.keys(KIND).map(k => `<button type="button" data-apc="${c.id}" data-apk="${k}" aria-selected="${p === k}">${KIND[k]}</button>`).join('')}</div>${r ? `<p class="ap-why"><span>${r[0] === 'good' ? '✓ хорошо' : r[0] === 'ok' ? '≈ можно' : '✗ плохо'}</span> ${esc(r[1])}</p>` : ''}</section>`;
          });
          const good = CASES.filter(c => U.pick[c.id] && c.m[U.pick[c.id]][0] === 'good').length;
          h += `</div><p class="ap-sum">Хороших выборов: ${good} из ${CASES.length}. Главное правило: ждёт ли вызывающий ответа прямо сейчас? Да — синхронный вызов с таймаутом и идемпотентностью. Нет — событие.</p>`;
        } else if (U.tab === 'contract') {
          const A = SD.app && SD.app.A, c = A ? contracts(A) : null;
          const opts = [['open', 'OpenAPI · внешнее API'], ['proto', 'protobuf · сервис → сервис'], ['async', 'AsyncAPI · события']];
          h += `<p class="ap-note">Сгенерировано по схеме уровня «${esc(A ? A.level.title : '—')}»: внешнее API — по видам запросов, вызовы между сервисами — по стрелкам «сервис → сервис», события — по брокерам. Это черновик: допиши поля своей предметной области.</p><div class="seg">${opts.map(([k, t]) => `<button type="button" data-apct="${k}" aria-selected="${U.ct === k}">${t}</button>`).join('')}</div>`;
          const txt = c ? c[U.ct] : '';
          h += txt ? `<textarea class="sh-text ap-code" readonly spellcheck="false" rows="20">${esc(txt)}</textarea>` : `<p class="ap-note">${U.ct === 'proto' ? 'На схеме нет вызовов «сервис → сервис». Поставь два сервиса и соедини их — появится контракт gRPC.' : U.ct === 'async' ? 'На схеме нет брокера сообщений — событий нет.' : 'Нечего описывать: нет нагрузки.'}</p>`;
        } else {
          h += `<div class="ap-check">${CHECK.map(([t, d, ex]) => `<div><b>${esc(t)}</b><p>${esc(d)}</p><code>${esc(ex)}</code></div>`).join('')}</div>`;
        }
        el.innerHTML = h;
      };
      el.addEventListener('click', e => {
        const t = e.target.closest('[data-aptab]'); if (t) { U.tab = t.dataset.aptab; save(); if (U.tab === 'contract') api.done('contract'); if (U.tab === 'check') api.done('check'); draw(); return; }
        const c = e.target.closest('[data-apc]');
        if (c) { U.pick[c.dataset.apc] = c.dataset.apk; save(); if (c.dataset.apc === 'notify' && (c.dataset.apk === 'rest' || c.dataset.apk === 'grpc')) api.done('notify'); if (CASES.every(x => U.pick[x.id] && x.m[U.pick[x.id]][0] === 'good')) api.done('all'); draw(); return; }
        const ct = e.target.closest('[data-apct]'); if (ct) { U.ct = ct.dataset.apct; save(); draw(); }
      });
      draw();
      return () => {};
    }
  });
  SD.apiLab = { contracts };
})();
