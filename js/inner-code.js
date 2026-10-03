/* Внутри сервиса: код по компонентам — TypeScript-каркас, композиция зависимостей и конфиг рантайма. */
(function () {
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const DICT = {
    заказ: 'Order', заказы: 'Orders', заказов: 'Orders', заказа: 'Order', платеж: 'Payment', платёж: 'Payment', платежи: 'Payments', платежей: 'Payments', платёжный: 'Payment', платежный: 'Payment', оплата: 'Payment', оплаты: 'Payment',
    склад: 'Inventory', склада: 'Inventory', пользователь: 'User', пользователи: 'Users', товар: 'Product', товары: 'Products', каталог: 'Catalog', корзина: 'Cart', доставка: 'Delivery', уведомления: 'Notifications', уведомление: 'Notification',
    лента: 'Feed', пост: 'Post', посты: 'Posts', сообщение: 'Message', сообщения: 'Messages', бронь: 'Booking', брони: 'Booking', бронирование: 'Booking', счёт: 'Account', счет: 'Account', проценты: 'Interest', начислить: 'Accrue',
    получить: 'Get', изменить: 'Update', создать: 'Create', оформить: 'Place', отменить: 'Cancel', обработать: 'Handle', список: 'List', найти: 'Find', удалить: 'Delete',
    сценарий: '', команда: '', запрос: '', порт: '', реляционная: 'Pg', бд: '', репозиторий: 'Repository', клиент: 'Client', кэш: 'Cache', события: 'Events', событие: 'Event', публикатор: 'Publisher', агрегат: 'Aggregate',
    хранилище: 'Store', шлюз: 'Gateway', файлы: 'Files', поиск: 'Search', консьюмер: 'Consumer', реле: 'Relay', сервис: 'Service', внешний: 'External', учётная: 'Accounting', учетная: 'Accounting', система: 'System',
    почтовый: 'Mail', провайдер: 'Provider', провайдеры: 'Providers', рекомендации: 'Recommendations', модуль: 'Module', модели: 'Model', модель: 'Model', nosql: 'NoSql', хранилище2: 'Store', api: 'Api', http: 'Http'
  };
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const translit = w => w.split('').map(ch => TR[ch] !== undefined ? TR[ch] : ch).join('');
  const SUFFIX = { rest: 'Controller', grpc: 'GrpcService', graphql: 'Resolver', consumer: 'Consumer', cron: 'Job', query: 'Query', saga: 'Saga', repo: 'Repository', cachecl: 'Cache', httpcl: 'Client', pub: 'Publisher', outbox: 'OutboxRelay', objcl: 'Storage', searchcl: 'Search' };
  function pascal(label) {
    const words = String(label || '').toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean);
    return words.map(w => DICT[w] !== undefined ? DICT[w] : /^[a-z0-9]+$/.test(w) ? cap(w) : cap(translit(w))).join('');
  }
  function names(M) {
    const used = new Set(), out = new Map();
    M.comps.forEach((c, i) => {
      let nm = c.ident || pascal(c.label);
      if (!nm || !/^[A-Za-z]/.test(nm)) nm = c.t.base + (i + 1);
      const sfx = SUFFIX[c.type];
      if (!c.ident && sfx && !nm.endsWith(sfx)) nm += sfx;
      let k = nm, j = 2;
      while (used.has(k)) k = nm + j++;
      used.add(k); out.set(c.id, k);
    });
    return out;
  }
  const lc = s => s[0].toLowerCase() + s.slice(1);
  const ROLE_M = {
    repo: { r: 'findById(id: string): Promise<Order | null>', w: 'save(order: Order): Promise<void>' },
    gateway: { r: 'fetch(id: string): Promise<RemoteView>', w: 'reserve(items: Item[], key: string): Promise<Reservation>' },
    publisher: { w: 'publish(events: DomainEvent[]): Promise<void>' },
    cache: { r: 'getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T>', w: 'invalidate(key: string): Promise<void>' },
    files: { r: 'downloadUrl(key: string): Promise<string>', w: 'uploadUrl(key: string): Promise<string>' },
    search: { r: 'search(q: string): Promise<Hit[]>', w: 'index(doc: Doc): Promise<void>' }
  };
  const ROLE_OF = { repo: 'repo', cachecl: 'cache', httpcl: 'gateway', pub: 'publisher', outbox: 'publisher', objcl: 'files', searchcl: 'search' };
  const CALL = {
    repo: { r: 'findById(id)', w: 'save(order)' }, gateway: { r: 'fetch(id)', w: 'reserve(cmd.items, cmd.key)' }, publisher: { w: 'publish(order.pullEvents())' },
    cache: { r: 'getOrLoad(`order:${id}`, () => LOAD)', w: 'invalidate(`order:${order.id}`)' }, files: { r: 'downloadUrl(id)', w: 'uploadUrl(cmd.fileKey)' }, search: { r: 'search(q)', w: 'index(toDoc(order))' }
  };
  const roleOf = c => c.type === 'port' ? c.props.role : ROLE_OF[c.type];
  const layerDir = { in: 'in', app: 'app', dom: 'domain', infra: 'infra' };

  function deps(M, c, N) {
    return M.out.get(c.id).filter(x => !(c.t.layer === 'infra' && x.type === 'port')).map(x => ({ c: x, name: N.get(x.id), param: lc(N.get(x.id)) }));
  }
  const ctor = ds => ds.length ? `  constructor(\n${ds.map(d => `    private readonly ${d.param}: ${d.name},`).join('\n')}\n  ) {}\n` : '';
  const imports = (M, c, N, ds) => ds.map(d => `import { ${d.name} } from '${rel(M, c, d.c, N)}';`).join('\n');
  function pathOf(M, c, N) {
    const mod = c.module ? pascal(c.module).toLowerCase() || 'module' : '';
    const dir = c.type === 'port' ? 'domain/ports' : layerDir[c.t.layer];
    return `src/${mod ? mod + '/' : ''}${dir}/${N.get(c.id)}.ts`;
  }
  function rel(M, a, b, N) {
    const pa = pathOf(M, a, N).split('/').slice(0, -1), pb = pathOf(M, b, N).replace(/\.ts$/, '').split('/');
    let i = 0; while (i < pa.length && pa[i] === pb[i]) i++;
    const up = pa.length - i;
    return (up ? '../'.repeat(up) : './') + pb.slice(i).join('/');
  }
  const has = (arr, v) => (arr || []).includes(v);

  /* ---------- шаблоны компонентов ---------- */
  function callFor(d, kind, self) {
    const me = self === undefined ? 'this.' : self;
    const role = roleOf(d.c);
    if (d.c.type === 'usecase' || d.c.type === 'query' || d.c.type === 'saga') return `await ${me}${d.param}.${d.c.type === 'query' ? 'handle' : 'execute'}(${kind === 'r' ? 'id' : 'cmd'})`;
    if (d.c.type === 'aggregate') return null;
    if (role && CALL[role] && CALL[role][kind]) return `await ${me}${d.param}.${CALL[role][kind]}`;
    return `await ${me}${d.param}.run()`;
  }
  function gen(M, c, N) {
    const name = N.get(c.id), ds = deps(M, c, N), p = c.props;
    const imp = imports(M, c, N, ds);
    const head = `// ${c.label || c.t.name} · ${SD.CLAYERS.find(l => l.id === c.t.layer).label}${c.module ? ' · модуль «' + c.module + '»' : ''}\n`;
    switch (c.type) {
      case 'rest': case 'grpc': case 'graphql': {
        const rd = p.kinds !== 'write', wr = p.kinds !== 'read', pipe = p.pipe || [];
        const reads = ds.filter(d => d.c.type === 'query' || (d.c.type === 'usecase' && d.c.props.kinds !== 'write') || (d.c.t.layer === 'infra'));
        const writes = ds.filter(d => (d.c.type === 'usecase' && d.c.props.kinds !== 'read') || d.c.type === 'saga' || (d.c.t.layer === 'infra'));
        const direct = ds.filter(d => d.c.t.layer === 'infra' || d.c.t.layer === 'dom');
        let s = head + `import { Router } from 'express';\n${has(pipe, 'valid') ? "import { z } from 'zod';\n" : ''}${imp}\n\n`;
        if (c.type === 'graphql') {
          s = head + `import DataLoader from 'dataloader';\n${imp}\n\n// Резолверы GraphQL. Каждое поле разрешается отдельно.\nexport const resolvers = (deps: Deps) => ({\n  Query: {\n    order: (_: unknown, { id }: { id: string }) => deps.${reads[0] ? reads[0].param : 'getOrder'}.${reads[0] && reads[0].c.type === 'query' ? 'handle' : 'execute'}(id),\n  },\n  Order: {\n`;
          s += p.dataloader ? `    // DataLoader собирает id всех заказов из ответа и грузит покупателей одной пачкой\n    customer: (o: Order, _: unknown, ctx: Ctx) => ctx.customerLoader.load(o.customerId),\n  },\n});\n\nexport const makeLoaders = (db: Db) => ({\n  customerLoader: new DataLoader((ids: readonly string[]) =>\n    db.query('SELECT * FROM customers WHERE id = ANY($1)', [ids]).then(byId(ids))),\n});\n`
            : `    // ⚠ N+1: этот резолвер вызывается для КАЖДОГО заказа в списке\n    customer: (o: Order, _: unknown, ctx: Ctx) => ctx.db.query('SELECT * FROM customers WHERE id = $1', [o.customerId]),\n  },\n});\n`;
          if (p.depth) s += `\n// Лимит глубины и стоимости запроса\nexport const validationRules = [depthLimit(6), costLimit({ maximumCost: 1000 })];\n`;
          return s;
        }
        if (has(pipe, 'valid') && wr) s += `const Body = z.object({\n  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),\n});\n\n`;
        s += `export function ${lc(name)}(${ds.map(d => `${d.param}: ${d.name}`).join(', ')}) {\n  const r = Router();\n`;
        if (has(pipe, 'trace')) s += `  r.use(correlationId());                 // trace id в логах и заголовках дальше\n`;
        if (has(pipe, 'rl')) s += `  r.use(rateLimit({ windowMs: 1000, max: 50, store: redisStore }));\n`;
        if (has(pipe, 'auth')) s += p.auth === 'introspect' ? `  r.use(introspectToken(AUTH_URL));        // ⚠ +15 мс и зависимость от auth-сервиса на каждый запрос\n` : `  r.use(requireJwt({ jwksUri: JWKS_URL })); // подпись проверяется локально\n`;
        if (direct.length) s += `  // ⚠ Контроллер сам ходит в ${direct.map(d => d.name).join(', ')}: логика оседает здесь\n`;
        if (rd) {
          const d = reads[0];
          s += `\n  r.get('/orders/:id', async (req, res) => {\n    const id = req.params.id;\n`;
          s += d ? (d.c.t.layer === 'infra' ? `    const row = ${callFor(d, 'r', '')};\n    if (!row) return res.sendStatus(404);\n    res.json(${p.dto ? 'toDto(row)' : 'row'});\n` : `    const view = ${callFor(d, 'r', '')};\n    res.json(${p.dto ? 'view' : 'view /* ⚠ сущность целиком */'});\n`) : `    res.sendStatus(501);\n`;
          s += `  });\n`;
        }
        if (wr) {
          const d = writes.find(x => x.c.t.layer !== 'infra') || writes[0];
          s += `\n  r.post('/orders', ${has(pipe, 'idem') ? 'idempotency(redis, { ttl: 86_400 }), ' : ''}async (req, res) => {\n    const cmd = ${has(pipe, 'valid') ? 'Body.parse(req.body)' : 'req.body /* ⚠ без валидации */'};\n`;
          s += d ? `    const id = ${callFor(d, 'w', '')};\n    res.status(201).json({ id });\n` : `    res.sendStatus(501);\n`;
          s += `  });\n`;
        }
        return s + `  return r;\n}\n`;
      }
      case 'consumer': {
        const h = ds.find(d => d.c.t.layer === 'app') || ds[0];
        let s = head + `import { Kafka } from 'kafkajs';\n${imp}\n\nexport async function start${name}(kafka: Kafka, db: Db${h ? `, ${h.param}: ${h.name}` : ''}) {\n  const consumer = kafka.consumer({ groupId: '${lc(name)}' });\n  await consumer.subscribe({ topic: 'orders' });\n  await consumer.run({\n    autoCommit: false,\n    partitionsConsumedConcurrently: ${p.conc},\n    eachMessage: async ({ topic, partition, message }) => {\n      const id = message.headers?.['message-id']?.toString() ?? message.offset;\n`;
        if (p.ack === 'before') s += `      // ⚠ Подтверждаем ДО обработки: упадём ниже — сообщение потеряно\n      await consumer.commitOffsets([{ topic, partition, offset: next(message.offset) }]);\n`;
        s += `      try {\n        await db.transaction(async tx => {\n`;
        if (p.inbox) s += `          const fresh = await tx.query(\n            'INSERT INTO inbox (message_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);\n          if (fresh.rowCount === 0) return;          // дубль: уже обработали\n`;
        s += `          ${h ? `await ${h.param}.execute(JSON.parse(message.value!.toString()), tx);` : '// обработка'}\n        });\n`;
        if (p.ack === 'after') s += `        await consumer.commitOffsets([{ topic, partition, offset: next(message.offset) }]); // ack после коммита\n`;
        s += `      } catch (err) {\n`;
        s += p.dlq === 'none' ? `        throw err;                                   // ⚠ повторяется бесконечно и держит партицию\n` : `        if (attempts(message) >= ${p.dlq}) {\n          await producer.send({ topic: 'orders.DLQ', messages: [withError(message, err)] });\n          await consumer.commitOffsets([{ topic, partition, offset: next(message.offset) }]);\n        } else throw err;                           // повтор с паузой\n`;
        return s + `      }\n    },\n  });\n}\n`;
      }
      case 'cron': {
        const h = ds[0];
        const every = { '1m': '* * * * *', '1h': '0 * * * *', '1d': '0 3 * * *' }[p.every];
        let s = head + `import cron from 'node-cron';\n${imp}\n\nexport function schedule${name}(${h ? `${h.param}: ${h.name}, ` : ''}db: Db) {\n  cron.schedule('${every}', async () => {\n`;
        if (p.lock === 'none') s += `    // ⚠ Запустится на КАЖДОМ экземпляре сервиса\n`;
        if (p.lock === 'db') s += `    const { rows } = await db.query('SELECT pg_try_advisory_lock(4242) AS ok');\n    if (!rows[0].ok) return;                      // задачу уже выполняет другой экземпляр\n    try {\n`;
        if (p.lock === 'lease') s += `    if (!(await leaderElection.isLeader())) return; // Kubernetes Lease: лидер один\n`;
        s += `${p.lock === 'db' ? '  ' : ''}    ${h ? `await ${h.param}.execute();` : '// работа'}\n`;
        if (p.lock === 'db') s += `    } finally { await db.query('SELECT pg_advisory_unlock(4242)'); }\n`;
        return s + `  });\n}\n`;
      }
      case 'usecase': {
        const agg = ds.find(d => d.c.type === 'aggregate');
        const others = ds.filter(d => d.c.type !== 'aggregate');
        const rd = p.kinds !== 'write', wr = p.kinds !== 'read';
        const ext = others.filter(d => roleOf(d.c) === 'gateway');
        const inner = others.filter(d => roleOf(d.c) !== 'gateway');
        let s = head + `${imp}${agg ? '' : ''}\n${p.tx === 'usecase' && wr ? "import { UnitOfWork } from '../infra/UnitOfWork';\n" : ''}\nexport class ${name} {\n`;
        const ctorDeps = (p.tx === 'usecase' && wr ? [{ param: 'uow', name: 'UnitOfWork' }] : []).concat(others);
        s += ctor(ctorDeps) + '\n';
        if (rd && !wr) {
          s += `  async execute(id: string) {\n`;
          const cache = inner.find(d => roleOf(d.c) === 'cache');
          const repo = inner.find(d => roleOf(d.c) === 'repo');
          if (p.cache === 'aside' && cache) s += `    // cache-aside: сначала кэш, при промахе — хранилище\n    return this.${cache.param}.getOrLoad(\`order:\${id}\`, () => this.${repo ? repo.param : 'store'}.findById(id));\n`;
          else s += (repo ? `    const order = await this.${repo.param}.findById(id);\n    if (!order) throw new NotFound(id);\n    return toView(order);\n` : `    // нет хранилища: откуда читать?\n`);
          inner.filter(d => d !== cache && d !== repo).forEach(d => { const cl = callFor(d, 'r'); if (cl) s += `    ${cl};\n`; });
          ext.forEach(d => { s += `    ${callFor(d, 'r')};\n`; });
          return s + `  }\n}\n`;
        }
        s += `  async execute(cmd: ${name}Command): Promise<string> {\n`;
        const extCalls = ext.map(d => `this.${d.param}.reserve(cmd.items, cmd.key)`);
        const extBlock = ext.length ? (p.calls === 'par' && ext.length > 1 ? `    // независимые вызовы параллельно: ждём самый долгий, а не сумму\n    const [${ext.map(d => d.param.replace(/Client$/, '')).join(', ')}] = await Promise.all([\n${extCalls.map(x => '      ' + x).join(',\n')},\n    ]);\n` : ext.map((d, i) => `    const r${i + 1} = await ${extCalls[i]};${ext.length > 1 ? ' // последовательно: задержки складываются' : ''}\n`).join('')) : '';
        if (!(p.tx === 'usecase' && p.extInTx)) s += extBlock;
        const body = [];
        if (agg) body.push(`const order = ${agg.name}.place(cmd);            // инварианты проверяет агрегат`);
        else body.push(`// ⚠ правила прямо в сценарии (анемичная модель)\n    if (!cmd.items.length) throw new Error('Пустой заказ');\n    const order = { id: uuidv7(), ...cmd, status: 'NEW' };`);
        inner.forEach(d => { const role = roleOf(d.c); const cl = role === 'cache' ? `await this.${d.param}.invalidate(\`order:\${order.id}\`)` : callFor(d, 'w'); if (cl) body.push(cl + ';' + (role === 'publisher' && d.c.type === 'pub' && d.c.props.mode === 'direct' ? (p.tx === 'usecase' ? ' // ⚠ публикация внутри транзакции: откат БД не отменит событие' : ' // ⚠ двойная запись: упадём после save — события не будет') : role === 'publisher' ? ' // outbox: та же транзакция' : '')); });
        if (p.tx === 'usecase') {
          s += `    return this.uow.transaction(async () => {\n${p.extInTx && extBlock ? extBlock.split('\n').filter(Boolean).map(l => '  ' + l + (l.includes('await') ? ' // ⚠ ждём соседа, держа транзакцию' : '')).join('\n') + '\n' : ''}${body.map(b => '      ' + b).join('\n')}\n      return order.id;\n    });\n`;
        } else s += `${body.map(b => '    ' + b).join('\n')}\n    return order.id;\n`;
        return s + `  }\n}\n`;
      }
      case 'query': {
        const src = { replica: 'реплики или read-модели', cache: 'кэша', primary: 'основной базы' }[p.from];
        return head + `${imp}\n\n// Чтение без доменной модели: плоский SQL прямо в DTO (из ${src})\nexport class ${name} {\n  constructor(private readonly db: ReadDb) {}\n\n  async handle(id: string): Promise<OrderView> {\n    return this.db.one(\n      \`SELECT o.id, o.status, o.total, json_agg(i.*) AS items\n         FROM orders o JOIN order_items i ON i.order_id = o.id\n        WHERE o.id = $1 GROUP BY o.id\`, [id]);\n  }\n}\n`;
      }
      case 'saga': {
        let s = head + `${imp}\n\nexport class ${name} {\n  // шаги процесса и обратные действия\n  private steps = [\n`;
        const st = ['reserveStock', 'chargePayment', 'createShipment', 'notifyCustomer', 'awardBonus', 'closeOrder'].slice(0, p.steps);
        const cm = ['releaseStock', 'refundPayment', 'cancelShipment', 'noop', 'revokeBonus', 'reopenOrder'];
        s += st.map((x, i) => `    { do: '${x}'${p.compensate ? `, undo: '${cm[i]}'` : ''} },`).join('\n') + '\n  ];\n\n';
        s += `  async start(orderId: string) {\n    const done: string[] = [];\n    for (const step of this.steps) {\n      try {\n        await this.send(step.do, orderId);\n        done.push(step.do);\n${p.persist ? "        await this.state.save(orderId, { done });  // переживёт рестарт\n" : '        // ⚠ состояние только в памяти\n'}      } catch {\n`;
        s += p.compensate ? `        for (const s of [...done].reverse()) await this.send(this.undoOf(s), orderId);\n        return 'compensated';\n` : `        // ⚠ компенсаций нет: сделанные шаги остаются\n        throw new Error('saga failed');\n`;
        return s + `      }\n    }\n    return 'completed';\n  }\n}\n`;
      }
      case 'aggregate': {
        if (!p.rich) return head + `// ⚠ Анемичная модель: только поля, правила живут в сервисах\nexport class ${name} {\n  id!: string;\n  status!: 'NEW' | 'PAID' | 'SHIPPED' | 'CANCELLED';\n  items!: Item[];\n}\n`;
        let s = head + `export class ${name} {\n${p.events ? '  private events: DomainEvent[] = [];\n' : ''}  private constructor(\n    readonly id: string,\n    private status: 'NEW' | 'PAID' | 'SHIPPED' | 'CANCELLED',\n    private items: Item[],\n${p.version ? '    readonly version: number,          // оптимистичная блокировка\n' : ''}  ) {}\n\n`;
        s += `  static place(cmd: PlaceOrder): ${name} {\n    if (!cmd.items.length) throw new DomainError('Пустой заказ');\n    const o = new ${name}(uuidv7(), 'NEW', cmd.items${p.version ? ', 0' : ''});\n${p.events ? "    o.events.push({ type: 'OrderPlaced', orderId: o.id, at: new Date() });\n" : ''}    return o;\n  }\n\n`;
        s += `  cancel(): void {\n    if (this.status === 'SHIPPED') throw new DomainError('Отгруженный заказ не отменить');\n    this.status = 'CANCELLED';\n${p.events ? "    this.events.push({ type: 'OrderCancelled', orderId: this.id, at: new Date() });\n" : ''}  }\n`;
        if (p.events) s += `\n  pullEvents(): DomainEvent[] { const e = this.events; this.events = []; return e; }\n`;
        return s + `}\n`;
      }
      case 'dservice': return head + `// Правило, которое не принадлежит одному агрегату${p.pure ? ': чистая функция, без ввода-вывода' : ''}\nexport function ${lc(name)}(order: OrderSnapshot, customer: CustomerSnapshot, promo?: Promo): Money {\n  let total = order.items.reduce((s, i) => s.add(i.price.times(i.qty)), Money.zero());\n  if (customer.tier === 'gold') total = total.percentOff(5);\n  if (promo && promo.validFor(order)) total = total.minus(promo.amount);\n  return total.max(Money.zero());\n}\n`;
      case 'port': {
        const m = ROLE_M[p.role] || ROLE_M.repo;
        return head + `// Порт: контракт объявляет бизнес-код, реализует адаптер в infra\nexport interface ${name} {\n${Object.values(m).map(x => '  ' + x + ';').join('\n')}\n}\n`;
      }
      case 'repo': {
        const port = M.out.get(c.id).find(x => x.type === 'port');
        const impl = port ? ` implements ${N.get(port.id)}` : '';
        const bound = c.bound ? c.bound.node : null;
        const nosql = bound && bound.type === 'nosql';
        let s = head + `${port ? `import { ${N.get(port.id)} } from '${rel(M, c, port, N)}';\n` : ''}\n// ${bound ? 'Хранилище на площадке: «' + SD.inner.outerName(bound) + '»' : '⚠ на площадке у сервиса нет базы'}\nexport class ${name}${impl} {\n  constructor(private readonly db: ${nosql ? 'DynamoDBDocument' : 'Pool'}${p.replica ? ', private readonly replica: Pool' : ''}) {}\n\n`;
        if (nosql) {
          s += `  async findById(id: string) {\n    const { Item } = await this.db.get({ TableName: 'orders', Key: { pk: \`ORDER#\${id}\` } });\n    return Item ? toDomain(Item) : null;\n  }\n\n  async save(order: Order) {\n    await this.db.put({ TableName: 'orders', Item: toItem(order),\n      ConditionExpression: 'attribute_not_exists(version) OR version = :v', ExpressionAttributeValues: { ':v': order.version } });\n  }\n}\n`;
          return s;
        }
        const reader = p.replica ? 'this.replica' : 'this.db';
        s += `  async listByUser(userId: string) {\n`;
        if (p.fetch === 'lazy') s += `    const orders = await ${reader}.query('SELECT * FROM orders WHERE user_id = $1 LIMIT 10', [userId]);\n    for (const o of orders.rows) {\n      // ⚠ N+1: отдельный запрос на каждый заказ — 1 + 10 запросов\n      o.items = (await ${reader}.query('SELECT * FROM order_items WHERE order_id = $1', [o.id])).rows;\n    }\n    return orders.rows.map(toDomain);\n  }\n\n`;
        else if (p.fetch === 'batch') s += `    const orders = (await ${reader}.query('SELECT * FROM orders WHERE user_id = $1 LIMIT 10', [userId])).rows;\n    // все позиции одной пачкой: 2 запроса вместо 11\n    const items = (await ${reader}.query('SELECT * FROM order_items WHERE order_id = ANY($1)', [orders.map(o => o.id)])).rows;\n    return orders.map(o => toDomain(o, items.filter(i => i.order_id === o.id)));\n  }\n\n`;
        else s += `    // один запрос с JOIN — индекс (user_id, created_at) обязателен\n    const { rows } = await ${reader}.query(\n      \`SELECT o.*, json_agg(i.*) AS items FROM orders o\n         JOIN order_items i ON i.order_id = o.id\n        WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 10\`, [userId]);\n    return rows.map(toDomain);\n  }\n\n`;
        s += `  async findById(id: string) {\n    const { rows } = await this.db.query('SELECT * FROM orders WHERE id = $1', [id]);\n    return rows[0] ? toDomain(rows[0]) : null;\n  }\n\n  async save(order: Order) {\n    const r = await this.db.query(\n      'UPDATE orders SET status = $2, version = version + 1 WHERE id = $1 AND version = $3', [order.id, order.status, order.version]);\n    if (r.rowCount === 0) throw new ConcurrencyError(order.id); // кто-то изменил раньше\n  }\n}\n`;
        return s;
      }
      case 'cachecl': {
        const port = M.out.get(c.id).find(x => x.type === 'port');
        let s = head + `\nexport class ${name}${port ? ' implements ' + N.get(port.id) : ''} {\n${p.single ? '  private inflight = new Map<string, Promise<unknown>>(); // singleflight\n' : ''}  constructor(private readonly redis: Redis) {}\n\n  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {\n    const hit = await this.redis.get(key);\n    if (hit) return JSON.parse(hit);\n`;
        s += p.single ? `    if (!this.inflight.has(key)) {\n      // один поход в базу на ключ, остальные ждут тот же промис\n      this.inflight.set(key, load().then(async v => {\n        await this.redis.set(key, JSON.stringify(v), 'EX', ${{ '1m': 60, '10m': 600, '1h': 3600 }[p.ttl]} + jitter(30));\n        return v;\n      }).finally(() => this.inflight.delete(key)));\n    }\n    return this.inflight.get(key) as Promise<T>;\n  }\n` : `    const v = await load();                    // ⚠ истёк популярный ключ — в базу идут все сразу\n    await this.redis.set(key, JSON.stringify(v), 'EX', ${{ '1m': 60, '10m': 600, '1h': 3600 }[p.ttl]});\n    return v;\n  }\n`;
        s += p.invalidate ? `\n  async invalidate(key: string) { await this.redis.del(key); }\n` : `\n  async invalidate(_key: string) { /* ⚠ не сбрасываем: до конца TTL отдаём старое */ }\n`;
        return s + `}\n`;
      }
      case 'httpcl': {
        const port = M.out.get(c.id).find(x => x.type === 'port');
        const e = c.bound ? Object.assign(SD.edgeDefaults(), c.bound.edge.props || {}) : SD.edgeDefaults();
        const target = c.bound ? SD.inner.outerName(c.bound.node) : 'сосед';
        let s = head + `${e.cb ? "import CircuitBreaker from 'opossum';\n" : ''}\n// Вызов «${target}» · ${(SD.PROTOCOLS[e.proto] || SD.PROTOCOLS.rest).name}. Таймаут и повторы — те же, что на стрелке площадки.\nexport class ${name}${port ? ' implements ' + N.get(port.id) : ''} {\n`;
        if (e.cb) s += `  private breaker = new CircuitBreaker((items: Item[], key: string) => this.call(items, key), {\n    errorThresholdPercentage: 50, resetTimeout: 10_000, volumeThreshold: 20,\n  });\n\n`;
        s += `  async reserve(items: Item[], key: string): Promise<Reservation> {\n`;
        const inner = e.cb ? 'this.breaker.fire(items, key)' : 'this.call(items, key)';
        let callExpr = e.retries ? `retry(() => ${inner}, { retries: ${e.retries}, ${e.backoff === 'exp' ? 'minTimeout: 100, factor: 2, randomize: true' : 'minTimeout: 0 /* ⚠ сразу, без паузы */'} })` : inner;
        if (e.fallback) s += `    try {\n      return await ${callExpr};\n    } catch {\n      return Reservation.deferred(items);       // fallback: упрощённый ответ\n    }\n  }\n\n`;
        else s += `    return ${callExpr};\n  }\n\n`;
        s += `  private async call(items: Item[], key: string) {\n    const res = await fetch(\`\${BASE_URL}/reservations\`, {\n      method: 'POST',\n      headers: { 'content-type': 'application/json'${p.idemKey ? ", 'Idempotency-Key': key" : ''}, traceparent: currentTrace() },\n      body: JSON.stringify(items),\n      ${e.timeout ? `signal: AbortSignal.timeout(${e.timeout}),` : '// ⚠ без таймаута: зависший сосед держит наш запрос вечно'}\n    });\n    if (!res.ok) throw new RemoteError(res.status);\n    return ${p.acl ? 'translate(await res.json())          // ACL: чужая модель → наша' : 'await res.json()'};\n  }\n}\n`;
        return s;
      }
      case 'pub': {
        const port = M.out.get(c.id).find(x => x.type === 'port');
        if (p.mode === 'outbox') return head + `\n// Событие пишется в таблицу outbox той же транзакцией, что и данные\nexport class ${name}${port ? ' implements ' + N.get(port.id) : ''} {\n  constructor(private readonly tx: TxContext) {}\n\n  async publish(events: DomainEvent[]) {\n    for (const e of events) {\n      await this.tx.current().query(\n        'INSERT INTO outbox (id, aggregate_id, type, payload) VALUES ($1, $2, $3, $4)',\n        [uuidv7(), e.orderId, e.type, JSON.stringify(e)]);\n    }\n  }\n}\n`;
        return head + `\nexport class ${name}${port ? ' implements ' + N.get(port.id) : ''} {\n  constructor(private readonly producer: Producer) {}\n\n  async publish(events: DomainEvent[]) {\n    await this.producer.send({\n      topic: 'orders',\n      messages: events.map(e => ({ key: e.orderId, value: JSON.stringify(e), headers: { traceparent: currentTrace() } })),\n    });\n  }\n}\n`;
      }
      case 'outbox': {
        if (p.relay === 'cdc') return head + `// Реле на CDC: Debezium читает WAL и публикует строки outbox в Kafka\nexport const debeziumConnector = {\n  'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',\n  'table.include.list': 'public.outbox',\n  'transforms': 'outbox',\n  'transforms.outbox.type': 'io.debezium.transforms.outbox.EventRouter',\n  'transforms.outbox.route.by.field': 'type',\n  ${p.order ? "'transforms.outbox.table.field.event.key': 'aggregate_id', // порядок по заказу" : ''}\n};\n`;
        return head + `\nexport class ${name} {\n  constructor(private readonly db: Pool, private readonly producer: Producer) {}\n\n  // каждые 200 мс; несколько экземпляров не мешают друг другу благодаря SKIP LOCKED\n  async tick() {\n    await withTx(this.db, async tx => {\n      const { rows } = await tx.query(\n        \`SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED\`);\n      if (!rows.length) return;\n      await this.producer.send({ topic: 'orders', messages: rows.map(r => ({ ${p.order ? 'key: r.aggregate_id, ' : ''}value: r.payload })) });\n      await tx.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1)', [rows.map(r => r.id)]);\n    });\n  }\n}\n`;
      }
      case 'objcl': return head + `import { getSignedUrl } from '@aws-sdk/s3-request-presigner';\nimport { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';\n\nexport class ${name} {\n  constructor(private readonly s3: S3Client) {}\n\n  ${p.presigned ? `// клиент грузит прямо в S3 по ссылке на 5 минут — байты не идут через сервис\n  uploadUrl(key: string) {\n    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 300 });\n  }\n` : `// ⚠ файл идёт через сервис: потоки и сеть заняты гигабайтами\n  async upload(key: string, body: Readable) {\n    await this.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));\n  }\n`}\n  downloadUrl(key: string) {\n    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 300 });\n  }\n}\n`;
      case 'searchcl': return head + `\nexport class ${name} {\n  constructor(private readonly os: OpenSearchClient) {}\n\n  async search(q: string) {\n    const r = await this.os.search({ index: 'products', body: { query: { multi_match: { query: q, fields: ['title^3', 'description'] } }, size: 20 } });\n    return r.body.hits.hits.map(h => ({ id: h._id, score: h._score, ...h._source }));\n  }\n}\n`;
      default: return head + `export class ${name} {}\n`;
    }
  }

  /* ---------- композиция и рантайм ---------- */
  function mainFile(M, N) {
    const inst = c => {
      const ds = M.out.get(c.id).filter(x => !(c.t.layer === 'infra' && x.type === 'port')).map(x => x.type === 'port' ? (M.inn.get(x.id).find(a => a.t.layer === 'infra') || x) : x).filter(x => x.type !== 'aggregate' && x.type !== 'dservice');
      return ds.map(x => x.type === 'port' ? `/* ⚠ нет реализации ${N.get(x.id)} */ undefined` : lc(N.get(x.id)));
    };
    const order = ['infra', 'app', 'in'];
    let s = `// Composition root: здесь и только здесь создаются реализации и связываются зависимости\nimport express from 'express';\nimport { Pool } from 'pg';\n\nconst app = express().use(express.json());\nconst pool = new Pool({ max: ${M.rt.pool} });   // на экземпляр; × число экземпляров ≤ max_connections\n`;
    s += `const log = pino({ level: '${M.rt.log}' });\n`;
    if (M.rt.trace !== 'off') s += `otel.start({ sampler: new TraceIdRatioBasedSampler(${M.rt.trace === '100' ? '1.0' : '0.1'}) });\n`;
    s += '\n';
    order.forEach(L => {
      M.comps.filter(c => c.t.layer === L && c.type !== 'port').forEach(c => {
        const nm = N.get(c.id);
        if (L === 'in') {
          if (c.type === 'consumer') s += `start${nm}(kafka, pool${inst(c).length ? ', ' + inst(c)[0] : ''});\n`;
          else if (c.type === 'cron') s += `schedule${nm}(${inst(c).concat(['pool']).join(', ')});\n`;
          else s += `app.use(${lc(nm)}(${inst(c).join(', ')}));\n`;
          return;
        }
        const args = c.type === 'repo' ? ['pool'] : c.type === 'cachecl' ? ['redis'] : c.type === 'pub' ? [c.props.mode === 'outbox' ? 'txContext' : 'producer'] : c.type === 'outbox' ? ['pool', 'producer'] : c.type === 'objcl' ? ['s3'] : c.type === 'searchcl' ? ['opensearch'] : c.type === 'httpcl' ? [] : (c.props.tx === 'usecase' && c.props.kinds !== 'read' ? ['new UnitOfWork(pool)'] : []).concat(inst(c));
        s += `const ${lc(nm)} = new ${nm}(${args.join(', ')});\n`;
      });
      s += '\n';
    });
    if (M.rt.health) s += `app.get('/health/live', (_, r) => r.send('ok'));\napp.get('/health/ready', async (_, r) => (await pool.query('SELECT 1'), r.send('ready')));\n`;
    const srv = `const server = app.listen(8080);\n`;
    s += srv;
    if (M.rt.graceful) s += `process.on('SIGTERM', () => server.close(() => pool.end()));   // дорабатываем начатые запросы\n`;
    return s;
  }
  function runtimeFile(M) {
    const r = M.rt, sample = r.trace === 'off' ? null : r.trace === '100' ? '1.0' : '0.1';
    switch (r.rt) {
      case 'java': case 'vthreads': case 'reactive':
        return { path: 'src/main/resources/application.yml', lang: 'yaml', src: `spring:\n${r.rt === 'vthreads' ? '  threads:\n    virtual:\n      enabled: true            # Java 21: поток на запрос почти бесплатен\n' : ''}${r.rt === 'reactive' ? '  main:\n    web-application-type: reactive   # WebFlux + R2DBC\n' : ''}  datasource:\n    hikari:\n      maximum-pool-size: ${r.pool}     # × экземпляров ≤ max_connections\n      connection-timeout: 2000\n${r.rt === 'java' ? 'server:\n  tomcat:\n    threads:\n      max: 200                 # поток занят, пока ждёт базу или соседа\n' : ''}${r.graceful ? (r.rt === 'java' ? '' : 'server:\n') + '  shutdown: graceful\n' : ''}logging:\n  level:\n    root: ${r.log.toUpperCase()}\n${sample ? `management:\n  tracing:\n    sampling:\n      probability: ${sample}\n` : ''}${r.health ? `management.endpoint.health.probes.enabled: true   # /actuator/health/liveness и /readiness\n` : ''}` };
      case 'go':
        return { path: 'cmd/server/config.go', lang: 'go', src: `cfg, _ := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))\ncfg.MaxConns = ${r.pool}                       // × экземпляров ≤ max_connections\npool, _ := pgxpool.NewWithConfig(ctx, cfg)\n\nslog.SetLogLoggerLevel(slog.Level${cap(r.log === 'warn' ? 'warn' : r.log)})\n${sample ? `tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.TraceIDRatioBased(${sample})))\n` : ''}// каждый запрос — горутина: ожидание базы почти ничего не стоит\nsrv := &http.Server{Addr: ":8080", Handler: router, ReadTimeout: 5 * time.Second}\n${r.graceful ? 'go func() { <-sigterm; srv.Shutdown(context.Background()) }() // дорабатываем начатые запросы\n' : ''}` };
      case 'node':
        return { path: 'src/config.ts', lang: 'js', src: `// Один поток и event loop: ожидание бесплатно, тяжёлый CPU блокирует всех\nexport const pool = new Pool({ max: ${r.pool} });\nexport const log = pino({ level: '${r.log}' });\n${sample ? `export const sampler = new TraceIdRatioBasedSampler(${sample});\n` : ''}// CPU-тяжёлое (картинки, PDF) — в worker_threads или отдельный сервис\n` };
      default:
        return { path: r.rt === 'pysync' ? 'gunicorn.conf.py' : 'app/settings.py', lang: 'python', src: r.rt === 'pysync' ? `workers = 4                   # процесс на ядро; запрос держит воркер, пока ждёт\nthreads = 1\ntimeout = 30\n${r.graceful ? 'graceful_timeout = 20\n' : ''}loglevel = "${r.log}"\n# пул SQLAlchemy на процесс\nDB_POOL_SIZE = ${r.pool}\n` : `# FastAPI + asyncpg: ожидание не держит поток\nDB_POOL = dict(min_size=2, max_size=${r.pool})\nLOG_LEVEL = "${r.log.toUpperCase()}"\n${sample ? `OTEL_TRACES_SAMPLER_ARG = ${sample}\n` : ''}# uvicorn --workers 2 --timeout-graceful-shutdown 20\n` };
    }
  }

  function files(n, g) {
    const M = SD.inner.model(n, g);
    const N = names(M);
    const list = M.comps.map(c => ({ path: pathOf(M, c, N), src: gen(M, c, N), lang: 'js', comp: c.id, layer: c.t.layer }));
    list.sort((a, b) => SD.CLAYER_IDX[a.layer] - SD.CLAYER_IDX[b.layer] || a.path.localeCompare(b.path));
    if (M.comps.length) {
      list.push({ path: 'src/main.ts', src: mainFile(M, N), lang: 'js', comp: null, layer: 'main' });
      const rf = runtimeFile(M); list.push(Object.assign({ comp: null, layer: 'rt' }, rf));
    }
    return { files: list, names: N, M };
  }

  SD.innerCode = { files, names, pascal };
})();
