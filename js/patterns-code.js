/* Каталог паттернов, часть 1: принципы, GoF, корпоративные паттерны, антипаттерны кода.
   Код на TypeScript: before — как бывает, after — как лучше. quiz — симптом для тренировки. */
(function () {
  SD.PATTERN_CATS = [
    { id: 'principles', label: 'Принципы' },
    { id: 'creational', label: 'GoF: порождающие' },
    { id: 'structural', label: 'GoF: структурные' },
    { id: 'behavioral', label: 'GoF: поведенческие' },
    { id: 'enterprise', label: 'Корпоративные и DDD' },
    { id: 'resilience', label: 'Отказоустойчивость' },
    { id: 'data', label: 'Данные и согласованность' },
    { id: 'integration', label: 'Интеграции и сообщения' },
    { id: 'architecture', label: 'Архитектура' },
    { id: 'delivery', label: 'Поставка и эксплуатация' },
    { id: 'ai', label: 'AI-системы' },
    { id: 'anti-code', label: 'Антипаттерны кода' },
    { id: 'anti-sys', label: 'Антипаттерны систем' }
  ];
  const P = SD.PATTERNS = SD.PATTERNS || [];
  const add = (cat, list) => list.forEach(p => P.push(Object.assign({ cat, kind: cat.startsWith('anti') ? 'anti' : cat === 'principles' ? 'principle' : 'pattern' }, p)));

  add('principles', [
    { id: 'srp', name: 'Единственная ответственность', en: 'Single Responsibility (S)', problem: 'Класс меняется по разным причинам: бухгалтерия просит другой расчёт, маркетинг — другое письмо, и правки задевают друг друга.', solution: 'У модуля одна причина для изменения. Разделяй по тем, кто заказывает изменения.', quiz: 'Класс Invoice считает сумму, сохраняет себя в БД и отправляет письмо клиенту. Любая правка ломает соседнее.',
      code: { before: `class Invoice {
  total() { /* расчёт */ }
  save() { db.insert('invoices', this); }
  sendEmail() { mailer.send(this.customer, render(this)); }
}`, after: `class Invoice { total() { /* только расчёт */ } }
class InvoiceRepository { save(inv: Invoice) { /* SQL */ } }
class InvoiceMailer { send(inv: Invoice) { /* письмо */ } }` } },
    { id: 'ocp', name: 'Открытость/закрытость', en: 'Open/Closed (O)', problem: 'Каждый новый способ доставки — правка большого switch в ядре и риск сломать старые.', solution: 'Модуль открыт для расширения и закрыт для изменения: новое поведение добавляется новым классом, а не правкой старого.', quiz: 'Чтобы добавить новый способ оплаты, приходится править switch в пяти местах сервиса заказов.',
      code: { before: `function shippingCost(o: Order) {
  switch (o.method) {
    case 'courier': return 300;
    case 'pickup': return 0;
    // + каждый новый способ — правка здесь
  }
}`, after: `interface Shipping { cost(o: Order): number }
const methods: Record<string, Shipping> = {
  courier: { cost: () => 300 },
  pickup: { cost: () => 0 },
};
const shippingCost = (o: Order) => methods[o.method].cost(o);   // новое — новой записью` } },
    { id: 'lsp', name: 'Подстановка Лисков', en: 'Liskov Substitution (L)', problem: 'Наследник ломает ожидания: код, работающий с базовым классом, падает на подклассе.', solution: 'Подтип можно подставить вместо базового типа без сюрпризов: не усиливай предусловия и не ослабляй гарантии.', quiz: 'ReadOnlyFile наследует File и бросает исключение в write(). Код, принимающий File, падает в проде.',
      code: { before: `class File { write(s: string) { /* ... */ } }
class ReadOnlyFile extends File {
  write() { throw new Error('read only'); }   // нарушает контракт File
}`, after: `interface Readable { read(): string }
interface Writable { write(s: string): void }
class ReadOnlyFile implements Readable { read() { return '…'; } }` } },
    { id: 'isp', name: 'Разделение интерфейсов', en: 'Interface Segregation (I)', problem: 'Клиенты зависят от методов, которыми не пользуются, и вынуждены реализовывать заглушки.', solution: 'Много узких интерфейсов лучше одного толстого.', quiz: 'Интерфейс Printer требует print, scan и fax, и простой принтер реализует scan и fax пустыми методами.',
      code: { before: `interface Device { print(): void; scan(): void; fax(): void }
class SimplePrinter implements Device {
  print() {} scan() { throw 'нет'; } fax() { throw 'нет'; }
}`, after: `interface Printer { print(): void }
interface Scanner { scan(): void }
class SimplePrinter implements Printer { print() {} }` } },
    { id: 'dip', name: 'Инверсия зависимостей', en: 'Dependency Inversion (D)', problem: 'Бизнес-логика жёстко создаёт конкретную базу и почтовый сервис: не подменить в тестах, не сменить провайдера.', solution: 'Высокоуровневый код зависит от абстракций; конкретные реализации передаются снаружи.', related: ['di', 'hexagonal'], quiz: 'Сервис заказов внутри делает new PostgresClient() и new SmtpMailer(), поэтому его нельзя протестировать без базы.',
      code: { before: `class OrderService {
  private db = new PostgresClient();      // прибито гвоздями
  private mail = new SmtpMailer();
}`, after: `class OrderService {
  constructor(private repo: OrderRepository, private notify: Notifier) {}
}
new OrderService(new PgOrderRepository(pool), new EmailNotifier(smtp));` } },
    { id: 'dry', name: 'DRY', en: "Don't Repeat Yourself", problem: 'Одно знание (правило скидки) записано в пяти местах, и при изменении правят четыре.', solution: 'У каждого знания одно авторитетное представление. Но не склеивай случайно похожий код с разными причинами изменения.', quiz: 'Правило «скидка 10 % от 5 000 ₽» скопировано в корзину, чек и письмо. После изменения правила чек и письмо показывают разные суммы.' },
    { id: 'kiss', name: 'KISS', en: 'Keep It Simple', problem: 'Для задачи на 100 строк построены фабрики фабрик и три слоя абстракций.', solution: 'Самое простое решение, которое работает. Сложность добавляют, когда она окупается.', quiz: 'Для формы обратной связи сделали микросервис, брокер и CQRS. Чтобы поменять текст ошибки, нужно три релиза.' },
    { id: 'yagni', name: 'YAGNI', en: "You Aren't Gonna Need It", problem: 'Делают «на будущее» поддержку пяти баз и мультиязычности, которые никогда не понадобятся.', solution: 'Не реализуй то, что не нужно сейчас. Будущее требование реализуешь, когда оно появится, — с реальными данными.', quiz: 'Команда месяц делала плагинную систему для отчётов, хотя отчёт пока один и второго не планируют.' },
    { id: 'lod', name: 'Закон Деметры', en: 'Law of Demeter', problem: 'Код лезет через цепочку чужих объектов и ломается при любой перестановке внутри них.', solution: 'Общайся только с ближайшими «друзьями»: попроси объект сделать дело, а не доставай его внутренности.', quiz: 'В коде order.getCustomer().getAddress().getCity().getZone().getTariff() — и любое изменение адреса ломает расчёт доставки.',
      code: { before: `const tariff = order.customer.address.city.zone.tariff;`, after: `const tariff = order.deliveryTariff();   // заказ сам знает, как его получить` } },
    { id: 'composition', name: 'Композиция вместо наследования', en: 'Composition over Inheritance', problem: 'Глубокая иерархия классов: чтобы добавить «летающую плавающую утку», приходится плодить комбинации наследников.', solution: 'Собирай поведение из маленьких объектов-компонентов вместо дерева наследования.', related: ['strategy', 'decorator'], quiz: 'Иерархия Notification → EmailNotification → UrgentEmailNotification → UrgentEmailWithSmsNotification разрастается при каждом новом сочетании.' },
    { id: 'failfast', name: 'Fail fast', en: 'Fail Fast', problem: 'Ошибочные данные молча проходят вглубь системы и ломают её далеко от причины.', solution: 'Проверяй входные данные на границе и падай сразу с понятной ошибкой.', quiz: 'Пустой email доходит до сервиса рассылки и через сутки роняет ночной джоб с непонятной ошибкой.',
      code: { before: `function createUser(data: any) { db.insert('users', data); }`, after: `const User = z.object({ email: z.string().email(), age: z.number().int().min(14) });
function createUser(data: unknown) { db.insert('users', User.parse(data)); }   // падает сразу` } }
  ]);

  add('creational', [
    { id: 'factory', name: 'Фабричный метод', en: 'Factory Method', problem: 'Код создаёт объекты через new с выбором класса по условию, и это ветвление размазано по системе.', solution: 'Создание объекта выносится в метод, который подклассы или конфигурация могут переопределить.', quiz: 'В десяти местах кода повторяется if (type === "pdf") new PdfExporter() else new XlsxExporter().',
      code: { before: `const exp = type === 'pdf' ? new PdfExporter() : new XlsxExporter();`, after: `const exporters = { pdf: () => new PdfExporter(), xlsx: () => new XlsxExporter() };
function createExporter(type: keyof typeof exporters): Exporter { return exporters[type](); }` } },
    { id: 'absfactory', name: 'Абстрактная фабрика', en: 'Abstract Factory', problem: 'Нужно создавать семейства согласованных объектов (кнопка, поле, диалог) под разные темы или платформы и не смешивать их.', solution: 'Фабрика создаёт всё семейство, клиент работает только с её интерфейсом.', quiz: 'В приложении светлые кнопки иногда оказываются в тёмных диалогах, потому что компоненты создаются вразнобой.',
      code: { after: `interface UiKit { button(): Button; dialog(): Dialog }
class DarkKit implements UiKit { button() { return new DarkButton(); } dialog() { return new DarkDialog(); } }
function renderForm(kit: UiKit) { kit.dialog().add(kit.button()); }` } },
    { id: 'builder', name: 'Строитель', en: 'Builder', problem: 'Конструктор с десятью параметрами, половина необязательна, легко перепутать порядок.', solution: 'Объект собирается пошагово методами с понятными именами.', quiz: 'new HttpRequest("GET", url, null, null, 30, true, false, null) — никто не помнит, что значит пятый аргумент.',
      code: { before: `new HttpRequest('GET', url, null, null, 30, true, false, null);`, after: `HttpRequest.get(url).timeout(30).followRedirects().build();` } },
    { id: 'prototype', name: 'Прототип', en: 'Prototype', problem: 'Создание объекта дорогое или сложное, а нужны его копии с небольшими отличиями.', solution: 'Новый объект создаётся клонированием готового образца.', quiz: 'Для каждого нового отчёта заново грузят из базы и собирают тяжёлый шаблон, хотя меняется только период.',
      code: { after: `const base = loadReportTemplate();          // дорого, один раз
const q3 = structuredClone(base); q3.period = '2026-Q3';` } },
    { id: 'singleton', name: 'Одиночка', en: 'Singleton', problem: 'Нужен ровно один экземпляр (пул соединений), доступный многим частям программы.', solution: 'Класс сам гарантирует единственный экземпляр. В современном коде чаще заменяют внедрением зависимостей с областью жизни singleton: глобальное состояние мешает тестам.', related: ['di', 'global-state'], quiz: 'Пул соединений к базе случайно создаётся в каждом модуле заново, и база упирается в лимит соединений.',
      code: { after: `export const pool = new Pool({ max: 10 });   // модуль ES — естественный одиночка
// лучше: создать в точке сборки и передать через DI` } }
  ]);

  add('structural', [
    { id: 'adapter', name: 'Адаптер', en: 'Adapter', problem: 'Внешняя библиотека или старая система имеет неудобный интерфейс, несовместимый с вашим.', solution: 'Обёртка переводит чужой интерфейс в нужный вам.', related: ['acl', 'hexagonal'], quiz: 'Новый платёжный провайдер отдаёт XML с другими полями, а весь код ждёт интерфейс PaymentGateway.',
      code: { after: `class LegacyBankAdapter implements PaymentGateway {
  constructor(private soap: LegacySoapClient) {}
  charge(amount: Money) { return this.soap.DoPayment({ Sum: amount.kopecks, Cur: 'RUB' }); }
}` } },
    { id: 'bridge', name: 'Мост', en: 'Bridge', problem: 'Две независимые оси вариантов (тип уведомления × канал доставки) дают взрыв подклассов.', solution: 'Разделяют абстракцию и реализацию на две иерархии и связывают их ссылкой.', quiz: 'Есть классы UrgentEmail, UrgentSms, DigestEmail, DigestSms — и каждый новый канал удваивает их число.',
      code: { after: `interface Channel { send(to: string, text: string): void }
class Notification { constructor(protected ch: Channel) {} }
class Urgent extends Notification { notify(u: User) { this.ch.send(u.contact, '❗ ' + u.alert); } }` } },
    { id: 'composite', name: 'Компоновщик', en: 'Composite', problem: 'Нужно одинаково работать с отдельным объектом и с группой (товар и набор товаров, файл и папка).', solution: 'Лист и контейнер реализуют общий интерфейс, контейнер делегирует детям.', quiz: 'Цена «набора» и цена отдельного товара считаются разным кодом, а наборы бывают вложенными.',
      code: { after: `interface Priced { price(): number }
class Product implements Priced { constructor(private p: number) {} price() { return this.p; } }
class Bundle implements Priced { constructor(private items: Priced[]) {} price() { return this.items.reduce((s, i) => s + i.price(), 0) * 0.9; } }` } },
    { id: 'decorator', name: 'Декоратор', en: 'Decorator', problem: 'Нужно добавлять поведение (кэш, логирование, повторы) к объекту, не меняя его класс и не плодя подклассы.', solution: 'Обёртка с тем же интерфейсом добавляет поведение и делегирует остальное.', related: ['retry', 'cacheaside'], quiz: 'К клиенту API нужно добавить кэш, логирование и повторы в разных сочетаниях для разных сервисов.',
      code: { after: `class CachedRepo implements ProductRepo {
  constructor(private inner: ProductRepo, private cache: Cache) {}
  async byId(id: string) { return (await this.cache.get(id)) ?? this.cache.set(id, await this.inner.byId(id)); }
}
const repo = new CachedRepo(new LoggedRepo(new PgRepo(pool)), redis);` } },
    { id: 'facade', name: 'Фасад', en: 'Facade', problem: 'Чтобы оформить заказ, клиенту нужно вызвать восемь подсистем в правильном порядке.', solution: 'Простой интерфейс поверх сложной подсистемы.', related: ['bff', 'apigw'], quiz: 'Мобильное приложение само вызывает склад, цены, скидки и доставку, чтобы показать карточку товара.',
      code: { after: `class CheckoutFacade {
  placeOrder(cart: Cart) { stock.reserve(cart); const p = pricing.total(cart); payments.charge(p); return orders.create(cart, p); }
}` } },
    { id: 'flyweight', name: 'Легковес', en: 'Flyweight', problem: 'Миллионы мелких объектов дублируют одинаковые данные и съедают память.', solution: 'Общее неизменяемое состояние выносится и разделяется между объектами.', quiz: 'На карте 2 млн маркеров, и у каждого своя копия одинаковой иконки и стиля.',
      code: { after: `const styles = new Map<string, Style>();            // общие стили
const marker = (x: number, y: number, kind: string) => ({ x, y, style: styles.get(kind)! });` } },
    { id: 'proxy', name: 'Заместитель', en: 'Proxy', problem: 'Нужно контролировать доступ к объекту: ленивая загрузка, права, кэш, удалённый вызов.', solution: 'Объект-заместитель с тем же интерфейсом стоит перед настоящим.', quiz: 'Тяжёлое изображение грузится, даже когда пользователь не долистал до него.',
      code: { after: `class LazyImage implements Image {
  private real?: RealImage;
  draw() { (this.real ??= new RealImage(this.url)).draw(); }   // грузим при первом показе
  constructor(private url: string) {}
}` } }
  ]);

  add('behavioral', [
    { id: 'chain', name: 'Цепочка обязанностей', en: 'Chain of Responsibility', problem: 'Запрос должен пройти ряд проверок (авторизация, лимиты, валидация), набор которых меняется.', solution: 'Обработчики выстраиваются в цепочку, каждый решает сам или передаёт дальше. Так устроены middleware.', quiz: 'В контроллере 40 строк проверок подряд, и для нового эндпоинта их копируют с изменениями.',
      code: { after: `app.use(auth);          // каждый middleware: next() или ответ
app.use(rateLimit);
app.use(validate(schema));
app.post('/orders', createOrder);` } },
    { id: 'command', name: 'Команда', en: 'Command', problem: 'Действия нужно ставить в очередь, логировать, повторять или отменять.', solution: 'Действие оформляется объектом с данными и методом выполнения.', related: ['queue-cc'], quiz: 'Нужна кнопка «отменить» для последних десяти действий в редакторе.',
      code: { after: `interface Command { execute(): void; undo(): void }
class MoveNode implements Command {
  constructor(private n: Node, private dx: number) {}
  execute() { this.n.x += this.dx; } undo() { this.n.x -= this.dx; }
}` } },
    { id: 'iterator', name: 'Итератор', en: 'Iterator', problem: 'Нужно обходить коллекцию, не зная её внутреннего устройства (дерево, страницы API).', solution: 'Обход выносится в отдельный объект или генератор.', quiz: 'Чтобы обработать все заказы из API с пагинацией, каждый разработчик пишет свой цикл со страницами.',
      code: { after: `async function* allOrders() {
  for (let cursor = null; ; ) {
    const page = await api.orders({ cursor }); yield* page.items;
    if (!(cursor = page.next)) return;
  }
}` } },
    { id: 'mediator', name: 'Посредник', en: 'Mediator', problem: 'Компоненты связаны каждый с каждым, и изменение одного тянет правки во всех.', solution: 'Компоненты общаются через посредника и не знают друг о друге.', related: ['pubsub'], quiz: 'На форме 12 полей, и каждое при изменении напрямую дёргает остальные одиннадцать.' },
    { id: 'memento', name: 'Снимок', en: 'Memento', problem: 'Нужно сохранять и восстанавливать состояние объекта, не раскрывая его внутренности.', solution: 'Объект сам выдаёт непрозрачный снимок и умеет из него восстановиться.', quiz: 'Нужен черновик формы, который можно откатить к любой сохранённой версии.' },
    { id: 'observer', name: 'Наблюдатель', en: 'Observer', problem: 'Когда меняется объект, должны реагировать несколько других, и источник не должен о них знать.', solution: 'Подписчики регистрируются у источника и получают уведомления.', related: ['pubsub', 'eda'], quiz: 'При смене статуса заказа нужно обновить экран, отправить push и записать аналитику — и список растёт.',
      code: { after: `order.on('statusChanged', s => ui.update(s));
order.on('statusChanged', s => push.send(s));
order.on('statusChanged', s => analytics.track(s));` } },
    { id: 'state', name: 'Состояние', en: 'State', problem: 'Поведение объекта зависит от его статуса, и каждый метод — большой switch по статусам.', solution: 'Каждое состояние — отдельный объект со своим поведением; объект делегирует текущему состоянию.', quiz: 'В методах заказа pay(), ship() и cancel() одинаковые switch по шести статусам, и переходы легко нарушить.',
      code: { after: `const transitions: Record<Status, Status[]> = {
  draft: ['placed', 'cancelled'], placed: ['paid', 'cancelled'], paid: ['shipped'], shipped: [], cancelled: [],
};
function move(o: Order, to: Status) { if (!transitions[o.status].includes(to)) throw new Error('нельзя'); o.status = to; }` } },
    { id: 'strategy', name: 'Стратегия', en: 'Strategy', problem: 'Есть несколько алгоритмов для одной задачи (расчёт скидки, балансировка), выбираемых на лету.', solution: 'Алгоритмы — взаимозаменяемые объекты с общим интерфейсом.', related: ['ocp'], quiz: 'Балансировщик должен уметь round robin, least connections и hash, а выбор задаётся в конфиге.',
      code: { after: `type Pick = (servers: Server[]) => Server;
const roundRobin = (): Pick => { let i = 0; return s => s[i++ % s.length]; };
const leastConn: Pick = s => s.reduce((a, b) => (a.active <= b.active ? a : b));
const lb = new Balancer(config.algo === 'lc' ? leastConn : roundRobin());` } },
    { id: 'template', name: 'Шаблонный метод', en: 'Template Method', problem: 'Несколько процессов совпадают по скелету и отличаются отдельными шагами.', solution: 'Базовый класс задаёт порядок шагов, подклассы переопределяют отдельные шаги.', quiz: 'Импорт из CSV, XML и API отличается только чтением, а валидация, сохранение и отчёт скопированы трижды.' },
    { id: 'visitor', name: 'Посетитель', en: 'Visitor', problem: 'Нужно добавлять новые операции над стабильной иерархией объектов (AST, документ), не трогая её классы.', solution: 'Операция оформляется отдельным объектом-посетителем с методом на каждый тип узла.', quiz: 'Над деревом выражений нужно то печатать, то вычислять, то оптимизировать, и каждый раз правятся все классы узлов.' },
    { id: 'interpreter', name: 'Интерпретатор', en: 'Interpreter', problem: 'Есть простой язык правил (фильтры, скидки), который бизнес хочет менять сам.', solution: 'Грамматика представлена классами, предложение — деревом, которое умеет себя вычислять.', quiz: 'Маркетинг хочет сам писать правила вида «категория = обувь И сумма > 5000 → скидка 10 %».' }
  ]);

  add('enterprise', [
    { id: 'repository', name: 'Репозиторий', en: 'Repository', problem: 'SQL размазан по бизнес-логике, и сменить хранилище или протестировать логику невозможно.', solution: 'Коллекция агрегатов с методами byId, save, find; детали хранения спрятаны внутри.', related: ['dip', 'hexagonal'], quiz: 'В методе расчёта скидки три SQL-запроса, и тест на скидку требует поднять PostgreSQL.',
      code: { after: `interface OrderRepository { byId(id: OrderId): Promise<Order>; save(o: Order): Promise<void> }` } },
    { id: 'uow', name: 'Единица работы', en: 'Unit of Work', problem: 'Несколько изменений должны сохраниться одной транзакцией, а каждый репозиторий коммитит сам.', solution: 'Объект копит изменения и фиксирует их одной транзакцией.', quiz: 'Заказ сохранился, а строки заказа — нет, потому что каждый репозиторий открывает свою транзакцию.' },
    { id: 'di', name: 'Внедрение зависимостей', en: 'Dependency Injection', problem: 'Объекты сами создают свои зависимости и прячут их, тесты и замена реализаций невозможны.', solution: 'Зависимости передаются снаружи (в конструктор), сборка происходит в одной точке.', related: ['dip'], quiz: 'Чтобы протестировать сервис, приходится патчить глобальные модули, потому что он сам импортирует и создаёт клиентов.' },
    { id: 'valueobject', name: 'Объект-значение', en: 'Value Object', problem: 'Деньги хранятся числом с плавающей точкой, валюты смешиваются, копейки теряются.', solution: 'Неизменяемый объект, равный по значению и проверяющий свои правила (Money, Email, Period).', quiz: 'В отчёте 0.1 + 0.2 = 0.30000000000000004 ₽, а рубли иногда складываются с долларами.',
      code: { after: `class Money {
  private constructor(readonly kopecks: bigint, readonly cur: 'RUB' | 'USD') {}
  static rub(r: number) { return new Money(BigInt(Math.round(r * 100)), 'RUB'); }
  plus(o: Money) { if (o.cur !== this.cur) throw new Error('валюты'); return new Money(this.kopecks + o.kopecks, this.cur); }
}` } },
    { id: 'specification', name: 'Спецификация', en: 'Specification', problem: 'Бизнес-правила отбора («VIP-клиент») повторяются в коде, SQL и отчётах по-разному.', solution: 'Правило оформляется объектом, который можно комбинировать (и, или, не) и применять в разных местах.', quiz: 'Определение «активного клиента» в трёх местах написано по-разному, и цифры в отчётах расходятся.' }
  ]);

  add('anti-code', [
    { id: 'godobject', name: 'Божественный объект', en: 'God Object', problem: 'Один класс на 5 000 строк знает и делает всё: заказы, оплату, письма, отчёты.', why: 'Любое изменение рискованно, тесты тяжёлые, над ним одновременно работают все команды и мешают друг другу.', fix: 'Разделить по ответственностям и ограниченным контекстам.', fixIds: ['srp', 'facade'], quiz: 'В проекте есть OrderManager на 4 800 строк, и любая задача начинается с конфликта слияния в нём.' },
    { id: 'spaghetti', name: 'Большой ком грязи', en: 'Big Ball of Mud', problem: 'Нет видимой структуры: всё зависит от всего, циклические зависимости между модулями.', why: 'Изменение в одном месте ломает неожиданные места, систему невозможно понять и разделить.', fix: 'Ввести модульные границы, проверять их тестами архитектуры, выносить модули по одному.', fixIds: ['modmono', 'strangler'], quiz: 'Модуль оплаты импортирует модуль каталога, а каталог — модуль оплаты, и никто не знает, где граница.' },
    { id: 'goldenhammer', name: 'Золотой молоток', en: 'Golden Hammer', problem: 'Одна любимая технология применяется ко всему: «всё в Kafka», «всё в микросервисах».', why: 'Решение не соответствует задаче, растут сложность и цена.', fix: 'Выбирать инструмент по требованиям и ограничениям задачи.', fixIds: ['kiss'], quiz: 'Команда кладёт в Kafka даже настройки сайта, которые меняются раз в месяц, и чтение конфига требует потребителя.' },
    { id: 'prematureopt', name: 'Преждевременная оптимизация', en: 'Premature Optimization', problem: 'Код усложняют ради скорости, которую никто не измерял.', why: 'Сложность и баги без выгоды, а настоящее узкое место остаётся.', fix: 'Сначала измерить (профилировщик, метрики), потом оптимизировать узкое место.', fixIds: ['kiss', 'yagni'], quiz: 'Перед запуском сервиса на 10 RPS полгода переписывали сериализацию на ручной бинарный формат.' },
    { id: 'magicnumbers', name: 'Магические числа', en: 'Magic Numbers', problem: 'В коде числа и строки без имени: if (status === 3), * 0.87.', why: 'Непонятно, что значит число, и при изменении его ищут по всему коду.', fix: 'Именованные константы, перечисления, конфигурация.', fixIds: ['dry'], quiz: 'В коде встречается if (user.type === 4) в двенадцати местах, и никто не помнит, что значит 4.',
      code: { before: `if (order.status === 3 && total > 5000) total *= 0.9;`, after: `const FREE_DELIVERY_FROM = 5000; const LOYAL_DISCOUNT = 0.1;
if (order.status === Status.Paid && total > FREE_DELIVERY_FROM) total *= 1 - LOYAL_DISCOUNT;` } },
    { id: 'copypaste', name: 'Копипаст', en: 'Copy-Paste Programming', problem: 'Похожие куски кода копируются и правятся по месту.', why: 'Баг исправляют в одной копии из пяти, поведение расходится.', fix: 'Выделить общую функцию там, где совпадает знание, а не только текст.', fixIds: ['dry'], quiz: 'Ошибку в расчёте НДС починили, но через неделю она всплыла в трёх других отчётах с тем же кодом.' },
    { id: 'global-state', name: 'Глобальное состояние', en: 'Global Mutable State', problem: 'Изменяемые глобальные переменные и синглтоны, которые читают и пишут из любого места.', why: 'Скрытые зависимости, гонки в многопоточном коде, тесты влияют друг на друга.', fix: 'Явные зависимости через параметры и DI, неизменяемые данные.', fixIds: ['di', 'singleton'], quiz: 'Тесты проходят по одному, но падают при запуске вместе, потому что делят глобальный объект текущего пользователя.' },
    { id: 'hardcode', name: 'Секреты и настройки в коде', en: 'Hard-coded Config & Secrets', problem: 'Пароли, ключи API и адреса серверов записаны прямо в коде.', why: 'Ключи утекают через git, смена окружения требует пересборки.', fix: 'Переменные окружения и хранилище секретов (Vault, KMS), конфигурация вне кода.', quiz: 'В публичном репозитории нашли ключ платёжного API, который лежал в config.ts.',
      code: { before: `const stripe = new Stripe('sk_live_51H...');`, after: `const stripe = new Stripe(process.env.STRIPE_KEY!);   // секрет из Vault/KMS через окружение` } },
    { id: 'anemic', name: 'Анемичная модель', en: 'Anemic Domain Model', problem: 'Сущности — только поля с геттерами, а все правила живут в «сервисах-менеджерах».', why: 'Инварианты не защищены: любой код может перевести заказ в невозможное состояние.', fix: 'Перенести правила в методы сущностей и агрегатов.', fixIds: ['aggregate', 'state'], quiz: 'У класса Order нет ни одного метода, а статус оплаченного заказа можно поменять на «черновик» из любого места.' }
  ]);
})();
