/* Паттерны GoF вживую: те же шаги — изменение, места правки, рефакторинг, цена до и после. */
(function () {
  const add = SD.principlesAdd;

  add({
    id: 'g-strategy', pat: 'strategy', title: 'Стратегия: подменяемый способ',
    lede: 'Скидки посчитаны цепочкой if — в цене, в чеке и в админке.',
    intro: 'Магазин даёт скидку студентам и в чёрную пятницу. Одна и та же цепочка if повторена в расчёте цены, в тексте для чека и в превью для админа.',
    change: { tag: 'pens', title: 'Добавляем скидку 7 % для пенсионеров', ask: 'Отметь строки, которые придётся изменить или рядом с которыми придётся дописать новую ветку.' },
    before: {
      files: [
        { name: 'customer.ts', node: 'cust', code: `export interface Customer { id: string; isStudent: boolean } //#pens` },
        { name: 'price.ts', node: 'price', code: `export function discount(c: Customer, sum: number) {
  if (isBlackFriday()) return sum * 0.25;
  if (c.isStudent) return sum * 0.10;
  return 0; //#pens
}` },
        { name: 'receipt.ts', node: 'receipt', code: `export function discountText(c: Customer) {
  if (isBlackFriday()) return 'Чёрная пятница −25 %';
  if (c.isStudent) return 'Скидка студента 10 %';
  return ''; //#pens
}` },
        { name: 'admin.ts', node: 'admin', code: `export const preview = (c: Customer) =>
  isBlackFriday() ? '25 %' : c.isStudent ? '10 %' : '—'; //#pens` }
      ],
      map: { nodes: [['price', 'Цена', 20, 10], ['receipt', 'Чек', 20, 80], ['admin', 'Админка', 20, 150], ['cust', 'Customer', 330, 80]], edges: [['price', 'cust'], ['receipt', 'cust'], ['admin', 'cust']] }
    },
    refactors: [
      { label: 'Каждая скидка — объект с условием, ставкой и подписью; подходящую ищем в списке', ok: true, fb: 'Это стратегия: у всех скидок один интерфейс, а вызывающий код не знает, какая сработает. Новая скидка — новый объект и строка в списке.' },
      { label: 'Хранить скидки в базе как текстовые формулы и вычислять их', ok: false, fb: 'Гибко до опасности: логика ушла в данные, её не проверит компилятор и тесты, а ошибку в формуле первыми увидят клиенты.' },
      { label: 'Вынести if-цепочку в функцию discountType() и делать switch по её результату', ok: false, fb: 'Стало чуть лучше, но каждая новая скидка по-прежнему правит switch в цене, чеке и админке.' }
    ],
    after: {
      files: [
        { name: 'DiscountPolicy.ts', node: 'iface', code: `export interface DiscountPolicy { applies(c: Customer): boolean; rate: number; label: string } //#new` },
        { name: 'policies.ts', node: 'pol', code: `export const blackFriday: DiscountPolicy = { applies: () => isBlackFriday(), rate: 0.25, label: 'Чёрная пятница −25 %' }; //#new
export const student: DiscountPolicy = { applies: c => c.tags.includes('student'), rate: 0.10, label: 'Скидка студента 10 %' }; //#new
export const POLICIES = [blackFriday, student]; //#pens,new` },
        { name: 'price.ts', node: 'price', code: `const best = (c: Customer) => POLICIES.find(p => p.applies(c)); //#new
export const discount = (c: Customer, sum: number) => sum * (best(c)?.rate ?? 0); //#new
export const discountText = (c: Customer) => best(c)?.label ?? ''; //#new` }
      ],
      map: { nodes: [['price', 'Цена · чек · админка', 20, 80], ['pol', 'policies: список', 250, 80], ['iface', '«interface» DiscountPolicy', 400, 10]], edges: [['price', 'pol'], ['pol', 'iface']] }
    },
    takeaway: 'Стратегия — семейство взаимозаменяемых способов за одним интерфейсом. Код, который их использует, не знает, какой именно сработает. Новый способ — новый объект, а не новая ветка if в трёх местах.',
    where: [['pat', 'strategy', 'Карточка «Стратегия»'], ['principle', 'ocp', 'Принцип за ней: OCP']]
  });

  add({
    id: 'g-adapter', pat: 'adapter', title: 'Адаптер: переходник к чужому API',
    lede: 'Библиотеку SMS-провайдера вызывают напрямую в трёх модулях.',
    intro: 'Коды входа, статусы заказов и рассылки отправляют SMS через библиотеку провайдера SmsC — прямо её функцией send(phone, text, sender).',
    change: { tag: 'prov', title: 'Переходим на другого провайдера: у него другой API и другие ошибки', ask: 'Отметь строки, которые придётся переписать.' },
    before: {
      files: [
        { name: 'auth.ts', node: 'auth', code: `import { smsc } from 'smsc-sdk'; //#prov
await smsc.send(phone, \`Код входа: \${code}\`, 'SHOP'); //#prov` },
        { name: 'orders.ts', node: 'orders', code: `import { smsc } from 'smsc-sdk'; //#prov
await smsc.send(o.phone, \`Заказ \${o.id}: \${o.status}\`, 'SHOP'); //#prov` },
        { name: 'promo.ts', node: 'promo', code: `import { smsc } from 'smsc-sdk'; //#prov
for (const u of users) await smsc.send(u.phone, text, 'PROMO').catch(e => e.code === 402 && alertFinance()); //#prov` }
      ],
      map: { nodes: [['auth', 'Вход', 20, 10], ['orders', 'Заказы', 20, 80], ['promo', 'Рассылки', 20, 150], ['sdk', 'smsc-sdk (чужой)', 330, 80]], edges: [['auth', 'sdk'], ['orders', 'sdk'], ['promo', 'sdk']] }
    },
    refactors: [
      { label: 'Найти и заменить smsc.send на вызов нового SDK по всему коду', ok: false, fb: 'Сработает один раз. При следующей смене провайдера — снова по всему коду, а обработка ошибок везде своя.' },
      { label: 'Наш интерфейс SmsSender и адаптер под каждого провайдера', ok: true, fb: 'Модули знают только SmsSender.send(to, text). Как говорить с конкретным провайдером, знает его адаптер. Смена провайдера — новый адаптер и одна строка сборки.' },
      { label: 'Форкнуть SDK нового провайдера и переименовать методы как у старого', ok: false, fb: 'Теперь вы поддерживаете чужую библиотеку и не получаете её обновлений и исправлений безопасности.' }
    ],
    after: {
      files: [
        { name: 'SmsSender.ts', node: 'iface', code: `export interface SmsSender { send(to: string, text: string): Promise<void> } //#new` },
        { name: 'SmscAdapter.ts', node: 'adapter', code: `export class SmscAdapter implements SmsSender { //#new
  async send(to: string, text: string) { await smsc.send(to, text, SENDER); } //#new
}` },
        { name: 'auth.ts', node: 'auth', code: `await sms.send(phone, \`Код входа: \${code}\`); //#new` },
        { name: 'main.ts', node: 'main', code: `export const sms: SmsSender = new SmscAdapter(); //#prov,new` }
      ],
      map: { nodes: [['auth', 'Вход · заказы · рассылки', 20, 80], ['iface', '«interface» SmsSender', 230, 80], ['adapter', 'SmscAdapter', 430, 30], ['sdk', 'smsc-sdk', 430, 140], ['main', 'main.ts', 230, 160]], edges: [['auth', 'iface'], ['adapter', 'iface'], ['adapter', 'sdk'], ['main', 'adapter']] }
    },
    takeaway: 'Адаптер — переходник: снаружи наш простой интерфейс, внутри — особенности чужого API. Чужая библиотека касается одного файла, и замена провайдера не расползается по системе.',
    where: [['pat', 'adapter', 'Карточка «Адаптер»'], ['pat', 'acl', 'Его старший брат: антикоррупционный слой'], ['inner', 'i-ports', 'Внутри сервиса: порты и адаптеры']]
  });

  add({
    id: 'g-facade', pat: 'facade', title: 'Фасад: одна дверь в сложное',
    lede: 'Порядок «склад → оплата → доставка → письмо → бонусы» повторён в трёх местах.',
    intro: 'Оформление заказа дёргает пять подсистем. Этот порядок вручную повторён в веб-контроллере, в мобильном API и в админке поддержки.',
    change: { tag: 'fraud', title: 'Перед оплатой нужна проверка антифрода', ask: 'Отметь строки, перед которыми придётся вставить проверку.' },
    before: {
      files: [
        { name: 'WebCheckout.ts', node: 'web', code: `await inventory.reserve(cart.items);
await payments.charge(cart.total, card); //#fraud
await delivery.schedule(order);
await email.orderPlaced(order);
await loyalty.addPoints(order);` },
        { name: 'MobileCheckout.ts', node: 'mob', code: `await inventory.reserve(body.items);
await payments.charge(body.total, body.token); //#fraud
await delivery.schedule(order);
await push.orderPlaced(order);` },
        { name: 'SupportReorder.ts', node: 'sup', code: `await inventory.reserve(old.items);
await payments.charge(old.total, old.savedCard); //#fraud
await delivery.schedule(order);` }
      ],
      map: { nodes: [['web', 'Веб', 10, 10], ['mob', 'Мобильное API', 10, 80], ['sup', 'Поддержка', 10, 150], ['inv', 'Склад', 380, 0], ['pay', 'Оплата', 380, 55], ['del', 'Доставка', 380, 110], ['msg', 'Уведомления', 380, 165]], edges: [['web', 'inv'], ['web', 'pay'], ['web', 'del'], ['web', 'msg'], ['mob', 'inv'], ['mob', 'pay'], ['mob', 'del'], ['mob', 'msg'], ['sup', 'inv'], ['sup', 'pay'], ['sup', 'del']] }
    },
    refactors: [
      { label: 'Объединить веб, мобильный и поддержку в один контроллер', ok: false, fb: 'Клиенты разные: форматы, авторизация и ответы у них свои. Получится контроллер с флагами на каждый случай.' },
      { label: 'Фасад CheckoutFacade.placeOrder(): одна дверь в пять подсистем', ok: true, fb: 'Все входы зовут одну операцию. Порядок шагов, антифрод и ошибки — в одном месте.' },
      { label: 'Каждый контроллер пусть сам вызывает антифрод перед оплатой', ok: false, fb: 'Три копии проверки сегодня — и четвёртый вход, который о ней забудет, завтра.' }
    ],
    after: {
      files: [
        { name: 'CheckoutFacade.ts', node: 'facade', code: `export class CheckoutFacade { //#new
  async placeOrder(items: Item[], total: number, pay: PaymentInfo) { //#new
    await this.inventory.reserve(items);
    await this.payments.charge(total, pay); //#fraud
    const order = await this.delivery.schedule(items);
    await this.notify.orderPlaced(order);
    return order;
  }
}` },
        { name: 'WebCheckout.ts', node: 'web', code: `const order = await checkout.placeOrder(cart.items, cart.total, card); //#new` },
        { name: 'MobileCheckout.ts', node: 'mob', code: `const order = await checkout.placeOrder(body.items, body.total, body.token); //#new` }
      ],
      map: { nodes: [['web', 'Веб', 10, 10], ['mob', 'Мобильное API', 10, 80], ['sup', 'Поддержка', 10, 150], ['facade', 'CheckoutFacade', 200, 80], ['inv', 'Склад', 420, 0], ['pay', 'Оплата', 420, 55], ['del', 'Доставка', 420, 110], ['msg', 'Уведомления', 420, 165]], edges: [['web', 'facade'], ['mob', 'facade'], ['sup', 'facade'], ['facade', 'inv'], ['facade', 'pay'], ['facade', 'del'], ['facade', 'msg']] }
    },
    takeaway: 'Фасад — простая дверь в сложную систему. Клиенты говорят с одним объектом, а он сам координирует подсистемы. Правило «как оформить заказ» живёт в одном месте.',
    where: [['pat', 'facade', 'Карточка «Фасад»'], ['principle', 'lod', 'Соседний принцип: закон Деметры'], ['pat', 'apigw', 'Фасад для всей системы: API Gateway']]
  });

  add({
    id: 'g-factory', pat: 'factory', title: 'Фабрика: создание в одном месте',
    lede: 'Три модуля сами собирают SMTP-клиент со всеми настройками.',
    intro: 'Письма отправляют регистрация, заказы и отчёты. Каждый модуль сам пишет new SmtpClient({ host, port, user, pass }).',
    change: { tag: 'smtp', title: 'Почтовый сервер теперь требует TLS и таймаут 5 секунд', ask: 'Отметь строки, которые придётся поправить.' },
    before: {
      files: [
        { name: 'signup.ts', node: 'signup', code: `const mailer = new SmtpClient({ host: 'smtp.shop.ru', port: 25, user: SMTP_USER, pass: SMTP_PASS }); //#smtp
await mailer.send(welcome(user));` },
        { name: 'orders.ts', node: 'orders', code: `const mailer = new SmtpClient({ host: 'smtp.shop.ru', port: 25, user: SMTP_USER, pass: SMTP_PASS }); //#smtp
await mailer.send(orderPlaced(order));` },
        { name: 'reports.ts', node: 'reports', code: `const mailer = new SmtpClient({ host: process.env.SMTP_HOST, port: 25, user: SMTP_USER, pass: SMTP_PASS }); //#smtp
await mailer.send(monthly(report));` }
      ],
      map: { nodes: [['signup', 'Регистрация', 20, 10], ['orders', 'Заказы', 20, 80], ['reports', 'Отчёты', 20, 150], ['smtp', 'SmtpClient', 330, 80]], edges: [['signup', 'smtp'], ['orders', 'smtp'], ['reports', 'smtp']] }
    },
    refactors: [
      { label: 'Фабрика createMailer(): как создать и настроить клиента, знает одно место', ok: true, fb: 'Модули просят «дай почтовик», а не собирают его. Настройки, TLS и таймауты меняются в одной функции, а в тестах её легко подменить.' },
      { label: 'Глобальная переменная mailer, созданная при импорте', ok: false, fb: 'Точка создания одна — это плюс. Но глобальный объект не подменить в тестах и не настроить иначе для тяжёлых отчётов.' },
      { label: 'Скопировать новую конфигурацию в три места', ok: false, fb: 'Сегодня решит, но в следующий раз снова три места — и одно забудут.' }
    ],
    after: {
      files: [
        { name: 'mailer.ts', node: 'factory', code: `export function createMailer(cfg = config.smtp): Mailer { //#new
  return new SmtpClient({ host: cfg.host, port: 465, secure: true, timeout: 5000, auth: cfg.auth }); //#smtp,new
}` },
        { name: 'signup.ts', node: 'signup', code: `const mailer = createMailer(); //#new` },
        { name: 'orders.ts', node: 'orders', code: `const mailer = createMailer(); //#new` },
        { name: 'reports.ts', node: 'reports', code: `const mailer = createMailer(); //#new` }
      ],
      map: { nodes: [['signup', 'Регистрация', 20, 10], ['orders', 'Заказы', 20, 80], ['reports', 'Отчёты', 20, 150], ['factory', 'createMailer()', 230, 80], ['smtp', 'SmtpClient', 430, 80]], edges: [['signup', 'factory'], ['orders', 'factory'], ['reports', 'factory'], ['factory', 'smtp']] }
    },
    takeaway: 'Фабрика отделяет «что мне нужно» от «как это собрать». Тот, кто пользуется объектом, не знает его настроек и конструктора — и не ломается, когда они меняются.',
    where: [['pat', 'factory', 'Карточка «Фабричный метод»'], ['pat', 'di', 'Следующий шаг: внедрение зависимостей'], ['principle', 'dry', 'Принцип за ней: DRY']]
  });

  add({
    id: 'g-builder', pat: 'builder', title: 'Строитель: сборка по шагам',
    lede: 'Конструктор с девятью параметрами по порядку: что значит пятый true?',
    intro: 'HTTP-запросы создают через new HttpRequest(…) с девятью параметрами. Чтобы понять вызов, нужно открыть конструктор и считать запятые.',
    change: { tag: 'retries', title: 'Нужен новый параметр retries — между timeout и keepAlive', ask: 'Отметь строки, которые придётся поправить.' },
    before: {
      files: [
        { name: 'HttpRequest.ts', node: 'req', code: `export class HttpRequest {
  constructor(method: string, url: string, headers: Headers, body: unknown, timeout: number, //#retries
              keepAlive: boolean, follow: boolean, proxy: string | null, encoding: string) {}
}` },
        { name: 'payments.ts', node: 'pay', code: `new HttpRequest('POST', PAY_URL, h, body, 3000, true, false, null, 'utf8'); //#retries` },
        { name: 'catalog.ts', node: 'cat', code: `new HttpRequest('GET', url, {}, null, 1000, true, true, null, 'utf8'); //#retries` },
        { name: 'webhooks.ts', node: 'hook', code: `new HttpRequest('POST', hook.url, sign(body), body, 5000, false, false, PROXY, 'utf8'); //#retries` }
      ],
      map: { nodes: [['pay', 'payments', 20, 10], ['cat', 'catalog', 20, 80], ['hook', 'webhooks', 20, 150], ['req', 'HttpRequest(9 параметров)', 300, 80]], edges: [['pay', 'req'], ['cat', 'req'], ['hook', 'req']] }
    },
    refactors: [
      { label: 'Добавить retries десятым параметром, в конец', ok: false, fb: 'Старые вызовы не сломаются, но читать new HttpRequest(…, null, \'utf8\', 2) станет ещё труднее, а следующий параметр снова уедет в конец.' },
      { label: 'Строитель: request().post(url).json(body).timeout(3000).build()', ok: true, fb: 'Каждый шаг назван, ненужное можно не указывать, у остального есть значения по умолчанию. Новая настройка — новый метод строителя, старые вызовы не трогаются.' },
      { label: 'Сделать перегрузки конструктора под каждый частый случай', ok: false, fb: 'Число перегрузок растёт с каждой настройкой, а различать их по порядку типов ещё труднее.' }
    ],
    after: {
      files: [
        { name: 'RequestBuilder.ts', node: 'builder', code: `export class RequestBuilder { //#new
  private r: RequestSpec = { method: 'GET', timeout: 1000, keepAlive: true, retries: 0 }; //#retries,new
  post(url: string) { this.r.method = 'POST'; this.r.url = url; return this; } //#new
  json(body: unknown) { this.r.body = body; return this; } //#new
  timeout(ms: number) { this.r.timeout = ms; return this; } //#new
  retries(n: number) { this.r.retries = n; return this; } //#retries,new
  build() { return new HttpRequest(this.r); } //#new
}` },
        { name: 'payments.ts', node: 'pay', code: `request().post(PAY_URL).json(body).timeout(3000).build(); //#new` },
        { name: 'catalog.ts', node: 'cat', code: `request().get(url).timeout(1000).followRedirects().build(); //#new` }
      ],
      map: { nodes: [['pay', 'payments', 20, 10], ['cat', 'catalog', 20, 80], ['hook', 'webhooks', 20, 150], ['builder', 'RequestBuilder', 230, 80], ['req', 'HttpRequest', 440, 80]], edges: [['pay', 'builder'], ['cat', 'builder'], ['hook', 'builder'], ['builder', 'req']] }
    },
    takeaway: 'Строитель собирает сложный объект по шагам с названиями. Вызов читается как фраза, а новая настройка не ломает старые вызовы. В TypeScript похожий эффект даёт объект параметров с именованными полями.',
    where: [['pat', 'builder', 'Карточка «Строитель»'], ['pat', 'magicnumbers', 'Антипаттерн рядом: магические значения']]
  });

  add({
    id: 'g-state', pat: 'state', title: 'Состояние: поведение по статусу',
    lede: 'Каждый метод заказа проверяет статус своим if — и интерфейс тоже.',
    intro: 'У заказа статусы: новый, оплачен, отгружен, отменён. Методы pay(), ship(), cancel() и экран заказа проверяют статус каждый по-своему.',
    change: { tag: 'hold', title: 'Добавляем статус «На проверке»: из него нельзя отгружать, но можно отменить', ask: 'Отметь строки, которые придётся поправить.' },
    before: {
      files: [
        { name: 'Order.ts', node: 'order', code: `type Status = 'NEW' | 'PAID' | 'SHIPPED' | 'CANCELLED'; //#hold
pay()    { if (this.status !== 'NEW') throw new Error('Нельзя оплатить'); this.status = 'PAID'; }
ship()   { if (this.status !== 'PAID') throw new Error('Нельзя отгрузить'); this.status = 'SHIPPED'; } //#hold
cancel() { if (this.status === 'SHIPPED' || this.status === 'CANCELLED') throw new Error('Нельзя отменить'); this.status = 'CANCELLED'; } //#hold` },
        { name: 'OrderView.ts', node: 'view', code: `const LABEL: Record<Status, string> = { NEW: 'Новый', PAID: 'Оплачен', SHIPPED: 'Отгружен', CANCELLED: 'Отменён' }; //#hold
const canShip = o.status === 'PAID'; //#hold` }
      ],
      map: { nodes: [['view', 'Экран заказа', 20, 80], ['order', 'Order: if по статусу в каждом методе', 230, 80]], edges: [['view', 'order']] }
    },
    refactors: [
      { label: 'Каждый статус — объект, который знает свои разрешённые действия и подпись', ok: true, fb: 'Order делегирует действие текущему состоянию. Новый статус — новый объект и одна строка перехода в «Оплачен».' },
      { label: 'Добавить ON_HOLD во все if и switch', ok: false, fb: 'Это и есть сегодняшняя проблема. Следующим придёт статус «Возврат» — и снова по всем методам.' },
      { label: 'Убрать проверки: пусть экран просто не показывает лишние кнопки', ok: false, fb: 'API зовут не только с экрана: мобильное приложение или скрипт отгрузит неоплаченный заказ.' }
    ],
    after: {
      files: [
        { name: 'states.ts', node: 'states', code: `export const New: State = { label: 'Новый', pay: () => Paid, cancel: () => Cancelled }; //#new
export const Paid: State = { label: 'Оплачен', ship: () => Shipped, cancel: () => Cancelled }; //#hold,new
export const Shipped: State = { label: 'Отгружен' }; //#new
export const Cancelled: State = { label: 'Отменён' }; //#new` },
        { name: 'Order.ts', node: 'order', code: `pay()    { this.state = this.state.pay?.() ?? fail('Нельзя оплатить'); } //#new
ship()   { this.state = this.state.ship?.() ?? fail('Нельзя отгрузить'); } //#new
cancel() { this.state = this.state.cancel?.() ?? fail('Нельзя отменить'); } //#new` },
        { name: 'OrderView.ts', node: 'view', code: `const label = o.state.label, canShip = !!o.state.ship; //#new` }
      ],
      map: { nodes: [['view', 'Экран заказа', 10, 80], ['order', 'Order', 180, 80], ['states', 'New · Paid · Shipped · Cancelled', 340, 80]], edges: [['view', 'order'], ['order', 'states']] }
    },
    takeaway: 'Состояние: поведение зависит от статуса, а правила каждого статуса собраны в его объекте. Вместо if в каждом методе — «спроси у текущего состояния». Новый статус не разбирает весь класс.',
    where: [['pat', 'state', 'Карточка «Состояние»'], ['pat', 'aggregate', 'Агрегат: где живут такие правила']]
  });

  add({
    id: 'g-command', pat: 'command', title: 'Команда: действие как объект',
    lede: 'Три действия в админке, и каждое само пишет в аудит и проверяет права.',
    intro: 'В админке можно изменить цену, снять товар с продажи и перенести в категорию. Каждый обработчик сам проверяет права и сам пишет журнал аудита.',
    change: { tag: 'audit', title: 'Служба безопасности требует писать в аудит ещё IP и причину', ask: 'Отметь строки, которые придётся поправить.' },
    before: {
      files: [
        { name: 'price.ts', node: 'price', code: `await requireRole(user, 'manager');
await repo.setPrice(id, price);
await audit.write({ user: user.id, action: 'price', id }); //#audit` },
        { name: 'unpublish.ts', node: 'unpub', code: `await requireRole(user, 'manager');
await repo.unpublish(id);
await audit.write({ user: user.id, action: 'unpublish', id }); //#audit` },
        { name: 'move.ts', node: 'move', code: `await requireRole(user, 'editor');
await repo.move(id, category);
await audit.write({ user: user.id, action: 'move', id }); //#audit` }
      ],
      map: { nodes: [['price', 'Цена', 20, 10], ['unpub', 'Снять', 20, 80], ['move', 'Перенести', 20, 150], ['audit', 'Аудит', 330, 40], ['roles', 'Права', 330, 130]], edges: [['price', 'audit'], ['unpub', 'audit'], ['move', 'audit'], ['price', 'roles'], ['unpub', 'roles'], ['move', 'roles']] }
    },
    refactors: [
      { label: 'Вынести audit.write в функцию logAction() и звать её в каждом обработчике', ok: false, fb: 'Кода меньше, но вызывать по-прежнему нужно в каждом месте — и в новом действии забудут.' },
      { label: 'Каждое действие — объект-команда; права, аудит и история — в одном исполнителе', ok: true, fb: 'Команда описывает «что сделать» и «как отменить». Исполнитель один раз проверяет права, пишет аудит и кладёт команду в историю — отсюда же бесплатная отмена.' },
      { label: 'Писать аудит триггером в базе данных', ok: false, fb: 'База видит изменённые строки, но не знает пользователя, IP и причину.' }
    ],
    after: {
      files: [
        { name: 'Command.ts', node: 'cmds', code: `export interface Command { name: string; role: Role; run(): Promise<void>; undo(): Promise<void> } //#new` },
        { name: 'executor.ts', node: 'exec', code: `export async function execute(cmd: Command, ctx: Ctx) { //#new
  await requireRole(ctx.user, cmd.role);
  await cmd.run();
  await audit.write({ user: ctx.user.id, action: cmd.name, ip: ctx.ip, reason: ctx.reason }); //#audit,new
  history.push(cmd); // отмена последнего действия — history.pop().undo()
}` },
        { name: 'commands.ts', node: 'cmds', code: `export const changePrice = (id: string, price: number, old: number): Command => //#new
  ({ name: 'price', role: 'manager', run: () => repo.setPrice(id, price), undo: () => repo.setPrice(id, old) }); //#new` }
      ],
      map: { nodes: [['cmds', 'Команды: цена, снять, перенести', 10, 80], ['exec', 'Исполнитель', 250, 80], ['audit', 'Аудит', 430, 10], ['roles', 'Права', 430, 80], ['hist', 'История', 430, 150]], edges: [['exec', 'cmds'], ['exec', 'audit'], ['exec', 'roles'], ['exec', 'hist']] }
    },
    takeaway: 'Команда превращает действие в объект: его можно передать, поставить в очередь, записать в журнал и отменить. Сквозные правила — права, аудит, история — живут в одном исполнителе.',
    where: [['pat', 'command', 'Карточка «Команда»'], ['pat', 'eventsourcing', 'Родственная идея: event sourcing']]
  });

  add({
    id: 'g-proxy', pat: 'proxy', title: 'Заместитель: контроль на входе',
    lede: 'Медленный платный сервис превью зовут напрямую из трёх мест.',
    intro: 'Сервис превью картинок медленный и платный. Каталог, корзина и рассылки вызывают его напрямую, каждый со своими размерами.',
    change: { tag: 'cache', title: 'Превью нужно кэшировать и не пускать к сервису без прав', ask: 'Отметь строки, где придётся добавить кэш и проверку.' },
    before: {
      files: [
        { name: 'catalog.ts', node: 'cat', code: `const img = await thumbs.render(p.photo, 300); //#cache` },
        { name: 'cart.ts', node: 'cart', code: `const img = await thumbs.render(item.photo, 120); //#cache` },
        { name: 'mail.ts', node: 'mail', code: `const img = await thumbs.render(order.photo, 600); //#cache` }
      ],
      map: { nodes: [['cat', 'Каталог', 20, 10], ['cart', 'Корзина', 20, 80], ['mail', 'Рассылки', 20, 150], ['thumbs', 'Сервис превью ($)', 330, 80]], edges: [['cat', 'thumbs'], ['cart', 'thumbs'], ['mail', 'thumbs']] }
    },
    refactors: [
      { label: 'Добавить кэш в каждый из трёх модулей', ok: false, fb: 'Три кэша с разными ключами и тремя ошибками инвалидации. Проверку прав всё равно забудут в одном из мест.' },
      { label: 'Заместитель с тем же интерфейсом: кэш и права внутри, вызывающие не меняются', ok: true, fb: 'Модули по-прежнему зовут thumbs.render(), но получают заместителя. Он отвечает из кэша, проверяет права и только при необходимости зовёт настоящий сервис.' },
      { label: 'Попросить команду сервиса превью ускорить его', ok: false, fb: 'Может быть, когда-нибудь. А деньги за вызовы и права — наша забота уже сегодня.' }
    ],
    after: {
      files: [
        { name: 'ThumbsProxy.ts', node: 'proxy', code: `export class ThumbsProxy implements Thumbs { //#new
  constructor(private real: Thumbs, private cache: Cache, private acl: Acl) {} //#new
  async render(src: string, w: number) { //#cache,new
    this.acl.check(src);
    return this.cache.getOrLoad(\`\${src}:\${w}\`, () => this.real.render(src, w));
  }
}` },
        { name: 'main.ts', node: 'main', code: `export const thumbs: Thumbs = new ThumbsProxy(new ThumbsService(), redis, acl); //#new` }
      ],
      map: { nodes: [['cat', 'Каталог', 10, 10], ['cart', 'Корзина', 10, 80], ['mail', 'Рассылки', 10, 150], ['proxy', 'ThumbsProxy', 200, 80], ['main', 'main.ts', 200, 160], ['thumbs', 'Сервис превью ($)', 400, 30], ['cache', 'Кэш', 400, 130]], edges: [['cat', 'proxy'], ['cart', 'proxy'], ['mail', 'proxy'], ['proxy', 'thumbs'], ['proxy', 'cache'], ['main', 'proxy']] }
    },
    takeaway: 'Заместитель встаёт перед объектом с тем же интерфейсом и добавляет контроль: кэш, права, ленивую загрузку, учёт вызовов. Вызывающий код ничего не замечает.',
    where: [['pat', 'proxy', 'Карточка «Заместитель»'], ['pat', 'decorator', 'Похожий паттерн: декоратор'], ['pat', 'cacheaside', 'Cache-aside в масштабе системы']]
  });

  add({
    id: 'g-chain', pat: 'chain', title: 'Цепочка обязанностей: проверки по очереди',
    lede: 'Проверки входа написаны вручную в каждом обработчике — и в разном порядке.',
    intro: 'Запросы проходят проверки: rate limit, подпись или токен, роль. В API заказов, вебхуках и админке они написаны вручную, и порядок везде свой.',
    change: { tag: 'ip', title: 'Блокировать IP из чёрного списка — до всех остальных проверок', ask: 'Отметь строки, перед которыми придётся вставить новую проверку.' },
    before: {
      files: [
        { name: 'orders.ts', node: 'orders', code: `app.post('/orders', async (req, res) => {
  if (!(await limiter.allow(req.ip))) return res.sendStatus(429); //#ip
  const user = await verifyToken(req.headers.authorization);
  if (!user.roles.includes('buyer')) return res.sendStatus(403);` },
        { name: 'webhooks.ts', node: 'hooks', code: `app.post('/hooks/pay', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401); //#ip
  if (!(await limiter.allow(req.ip))) return res.sendStatus(429);` },
        { name: 'admin.ts', node: 'admin', code: `app.post('/admin/prices', async (req, res) => {
  const user = await verifyToken(req.headers.authorization); //#ip
  if (!user.roles.includes('admin')) return res.sendStatus(403);` }
      ],
      map: { nodes: [['orders', 'API заказов', 20, 10], ['hooks', 'Вебхуки', 20, 80], ['admin', 'Админка', 20, 150], ['rl', 'Лимит', 330, 10], ['auth', 'Токен', 330, 80], ['sig', 'Подпись', 330, 150]], edges: [['orders', 'rl'], ['orders', 'auth'], ['hooks', 'sig'], ['hooks', 'rl'], ['admin', 'auth']] }
    },
    refactors: [
      { label: 'Скопировать проверку IP в начало каждого обработчика', ok: false, fb: 'Три копии сегодня, а порядок проверок в каждом файле продолжит расходиться.' },
      { label: 'Цепочка обработчиков: каждый шаг либо пропускает дальше, либо отвечает сам', ok: true, fb: 'Это middleware. Общие шаги собраны в одну цепочку, входы добавляют к ней свои. Новая проверка — одна строка в общей цепочке.' },
      { label: 'Одна большая функция checkEverything(req, type)', ok: false, fb: 'Каждый новый вход добавит в неё if, а шаги нельзя ни переставить, ни переиспользовать по отдельности.' }
    ],
    after: {
      files: [
        { name: 'pipeline.ts', node: 'chain', code: `const common = [rateLimit]; //#ip,new
export const buyerApi = [...common, auth, role('buyer')]; //#new
export const webhook = [...common, signature]; //#new
export const adminApi = [...common, auth, role('admin')]; //#new` },
        { name: 'orders.ts', node: 'orders', code: `app.post('/orders', ...buyerApi, placeOrder); //#new` },
        { name: 'webhooks.ts', node: 'hooks', code: `app.post('/hooks/pay', ...webhook, onPayment); //#new` }
      ],
      map: { nodes: [['orders', 'API заказов', 10, 10], ['hooks', 'Вебхуки', 10, 80], ['admin', 'Админка', 10, 150], ['chain', 'Цепочки проверок', 220, 80], ['rl', 'Лимит', 420, 10], ['auth', 'Токен', 420, 80], ['sig', 'Подпись', 420, 150]], edges: [['orders', 'chain'], ['hooks', 'chain'], ['admin', 'chain'], ['chain', 'rl'], ['chain', 'auth'], ['chain', 'sig']] }
    },
    takeaway: 'Цепочка обязанностей передаёт запрос от звена к звену, пока одно не ответит. Каждое звено маленькое и не знает о других. Middleware в веб-фреймворках — именно она.',
    where: [['pat', 'chain', 'Карточка «Цепочка обязанностей»'], ['pat', 'ratelimit', 'Одно из звеньев: rate limit'], ['principle', 'failfast', 'Почему проверки на входе: fail fast']]
  });

  add({
    id: 'g-template', pat: 'template', title: 'Шаблонный метод: общий порядок шагов',
    lede: 'Три выгрузки повторяют одни и те же шаги, отличаясь только форматом.',
    intro: 'Выгрузки в CSV, Excel и JSON делают одно и то же: загрузить, отфильтровать, отсортировать, оформить, сохранить. Шаги скопированы в каждый класс.',
    change: { tag: 'del', title: 'Не выгружать удалённых пользователей', ask: 'Отметь строки, которые придётся поправить.' },
    before: {
      files: [
        { name: 'CsvExport.ts', node: 'csv', code: `const rows = (await db.users.all()).filter(u => u.active); //#del
rows.sort((a, b) => a.name.localeCompare(b.name));
await save('users.csv', toCsv(rows));` },
        { name: 'ExcelExport.ts', node: 'xls', code: `const users = await db.users.all();
const list = users.filter(u => u.active).sort(byName); //#del
await save('users.xlsx', toXlsx(list));` },
        { name: 'JsonExport.ts', node: 'json', code: `const data = (await db.users.all()).filter(u => u.active); //#del
await save('users.json', JSON.stringify(data.sort(byName)));` }
      ],
      map: { nodes: [['csv', 'CSV', 20, 10], ['xls', 'Excel', 20, 80], ['json', 'JSON', 20, 150], ['db', 'users', 330, 80]], edges: [['csv', 'db'], ['xls', 'db'], ['json', 'db']] }
    },
    refactors: [
      { label: 'Вынести фильтр в функцию activeOnly() и вызывать её в трёх местах', ok: false, fb: 'Лучше, но порядок шагов всё ещё скопирован трижды: следующее «сортировать по дате» снова потребует трёх правок.' },
      { label: 'Шаблонный метод: базовый класс задаёт порядок шагов, наследники — только формат', ok: true, fb: 'Порядок «загрузить → отфильтровать → отсортировать → оформить → сохранить» живёт в одном методе run(). Форматы отличаются одним шагом.' },
      { label: 'Одна выгрузка, а формат выбирать параметром и if внутри', ok: false, fb: 'Работает, пока форматов три. Четвёртый формат правит общий метод с if — см. OCP.' }
    ],
    after: {
      files: [
        { name: 'Export.ts', node: 'base', code: `export abstract class Export { //#new
  async run() {
    const rows = (await db.users.all()).filter(u => u.active); //#del
    rows.sort((a, b) => a.name.localeCompare(b.name));
    await save(this.fileName, this.format(rows));
  }
  protected abstract fileName: string; //#new
  protected abstract format(rows: User[]): Buffer | string; //#new
}` },
        { name: 'CsvExport.ts', node: 'csv', code: `export class CsvExport extends Export { fileName = 'users.csv'; format = toCsv; } //#new` },
        { name: 'ExcelExport.ts', node: 'xls', code: `export class ExcelExport extends Export { fileName = 'users.xlsx'; format = toXlsx; } //#new` }
      ],
      map: { nodes: [['csv', 'CSV', 20, 10], ['xls', 'Excel', 20, 80], ['json', 'JSON', 20, 150], ['base', 'Export.run(): общий порядок', 230, 80], ['db', 'users', 460, 80]], edges: [['csv', 'base'], ['xls', 'base'], ['json', 'base'], ['base', 'db']] }
    },
    takeaway: 'Шаблонный метод фиксирует порядок шагов в одном месте и разрешает подменять отдельные шаги. Тот же эффект даёт композиция: передать формат функцией в общий run(). Выбирай то, что проще прочитать.',
    where: [['pat', 'template', 'Карточка «Шаблонный метод»'], ['principle', 'composition', 'Альтернатива: композиция'], ['principle', 'dry', 'Принцип за ним: DRY']]
  });
})();
