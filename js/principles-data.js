/* Принципы вживую: сценарии «изменение → поиск мест правки → рефакторинг → то же изменение снова».
   В коде метка //#тег в конце строки: строку затрагивает изменение с этим тегом; //#new — строка появилась после рефакторинга. */
(function () {
  const P = SD.PRINCIPLES = [];
  const add = o => P.push(o);

  add({
    id: 'dry', pat: 'dry', title: 'DRY: одно знание — одно место',
    lede: 'Ставка НДС зашита в четырёх файлах — и каждый раз по-разному.',
    intro: 'Интернет-магазин считает цену с НДС в корзине, на оформлении, в чеке и в отчёте. Код писали разные люди в разное время.',
    change: { tag: 'vat', title: 'НДС вырос с 20 до 22 %', ask: 'Отметь все строки, которые нужно поправить, чтобы везде считалось по новой ставке.' },
    before: {
      files: [
        { name: 'cart.ts', node: 'cart', code: `export function cartTotal(items: Item[]) {
  const net = items.reduce((s, i) => s + i.price * i.qty, 0);
  return Math.round(net * 1.2 * 100) / 100; //#vat
}` },
        { name: 'checkout.ts', node: 'checkout', code: `export function checkoutTotal(cart: Cart, delivery: number) {
  const net = cartNet(cart) + delivery;
  const total = net + net * 0.2; //#vat
  return Math.round(total * 100) / 100;
}` },
        { name: 'receipt.ts', node: 'receipt', code: `export function receiptLines(order: Order) {
  return order.items.map(i => ({
    title: i.title,
    sum: (i.price * i.qty * 120 / 100).toFixed(2), //#vat
  }));
}` },
        { name: 'admin-report.ts', node: 'report', code: `export function revenue(orders: Order[]) {
  const net = orders.reduce((s, o) => s + o.net, 0);
  return { net, gross: net * 1.2 }; //#vat
}` }
      ],
      map: { nodes: [['cart', 'Корзина', 20, 20], ['checkout', 'Оформление', 20, 110], ['receipt', 'Чек', 300, 20], ['report', 'Отчёт', 300, 110]], edges: [] }
    },
    refactors: [
      { label: 'Сделать константу VAT = 1.2 в каждом файле', ok: false, fb: 'Число получило имя, но знание всё ещё размножено в четырёх копиях. Поменять придётся четыре константы, и одну обязательно забудут. DRY — про знание, а не про одинаковые буквы.' },
      { label: 'Вынести знание «как считается цена с НДС» в одну функцию withVat()', ok: true, fb: 'Правило живёт в одном месте, остальные его вызывают. Ставка, округление и формула меняются в одном файле.' },
      { label: 'Сделать TaxStrategyFactory с интерфейсом ITaxStrategy', ok: false, fb: 'Для одной ставки это три новые сущности ради одной формулы. Задача решится, но ценой лишней сложности — это нарушение KISS и YAGNI.' }
    ],
    after: {
      files: [
        { name: 'money.ts', node: 'money', code: `export const VAT_RATE = 0.20; //#vat,new
export const roundMoney = (x: number) => Math.round(x * 100) / 100; //#new
export const withVat = (net: number) => roundMoney(net * (1 + VAT_RATE)); //#new` },
        { name: 'cart.ts', node: 'cart', code: `export function cartTotal(items: Item[]) {
  return withVat(items.reduce((s, i) => s + i.price * i.qty, 0)); //#new
}` },
        { name: 'checkout.ts', node: 'checkout', code: `export function checkoutTotal(cart: Cart, delivery: number) {
  return withVat(cartNet(cart) + delivery); //#new
}` },
        { name: 'receipt.ts', node: 'receipt', code: `export function receiptLines(order: Order) {
  return order.items.map(i => ({ title: i.title, sum: withVat(i.price * i.qty).toFixed(2) })); //#new
}` },
        { name: 'admin-report.ts', node: 'report', code: `export function revenue(orders: Order[]) {
  const net = orders.reduce((s, o) => s + o.net, 0);
  return { net, gross: withVat(net) }; //#new
}` }
      ],
      map: { nodes: [['cart', 'Корзина', 20, 20], ['checkout', 'Оформление', 20, 110], ['money', 'money.ts · withVat', 170, 65], ['receipt', 'Чек', 320, 20], ['report', 'Отчёт', 320, 110]], edges: [['cart', 'money'], ['checkout', 'money'], ['receipt', 'money'], ['report', 'money']] }
    },
    takeaway: 'DRY — не «никаких одинаковых строк», а «каждое знание в одном месте». Две похожие строки с разным смыслом объединять не надо: когда смыслы разойдутся, общий код придётся резать обратно.',
    where: [['pat', 'dry', 'Карточка DRY'], ['pat', 'copypaste', 'Антипаттерн: копипаст']]
  });

  add({
    id: 'kiss', pat: 'kiss', title: 'KISS: проще — значит дешевле менять',
    lede: 'Два способа доставки, а вокруг них — интерфейс, реестр, фабрика и конфиг.',
    intro: 'Доставка бывает курьером и самовывозом. Чтобы «было расширяемо», для двух случаев написали стратегию, реестр и фабрику.',
    change: { tag: 'read', title: 'Новичок должен поменять цену курьера. Что ему придётся прочитать?', ask: 'Отметь строки, которые нужно прочитать, чтобы понять, откуда берётся цена курьерской доставки.' },
    before: {
      files: [
        { name: 'DeliveryStrategy.ts', node: 'iface', code: `export interface DeliveryStrategy {
  supports(type: string): boolean; //#read
  cost(order: Order): number;
}` },
        { name: 'CourierStrategy.ts', node: 'courier', code: `export class CourierStrategy implements DeliveryStrategy {
  supports(t: string) { return t === 'courier'; } //#read
  cost(o: Order) { return o.weight > 5 ? 500 : 300; } //#read
}` },
        { name: 'StrategyRegistry.ts', node: 'registry', code: `export class StrategyRegistry {
  private list: DeliveryStrategy[] = [];
  register(s: DeliveryStrategy) { this.list.push(s); }
  find(t: string) { return this.list.find(s => s.supports(t))!; } //#read
}` },
        { name: 'DeliveryFactory.ts', node: 'factory', code: `export function createRegistry(cfg: Config) {
  const r = new StrategyRegistry();
  if (cfg.features.courier) r.register(new CourierStrategy()); //#read
  r.register(new PickupStrategy());
  return r;
}` },
        { name: 'checkout.ts', node: 'checkout', code: `const registry = createRegistry(loadConfig()); //#read
const fee = registry.find(order.deliveryType).cost(order); //#read` }
      ],
      map: { nodes: [['checkout', 'checkout', 20, 65], ['factory', 'DeliveryFactory', 170, 10], ['registry', 'StrategyRegistry', 170, 120], ['iface', '«interface»', 330, 65], ['courier', 'CourierStrategy', 470, 20], ['pickup', 'PickupStrategy', 470, 110]], edges: [['checkout', 'factory'], ['checkout', 'registry'], ['factory', 'registry'], ['factory', 'courier'], ['factory', 'pickup'], ['registry', 'iface'], ['courier', 'iface'], ['pickup', 'iface']] }
    },
    refactors: [
      { label: 'Подключить DI-контейнер, чтобы фабрика собиралась автоматически', ok: false, fb: 'Сложность стала ещё больше и ещё невидимее: теперь цену ищут через конфигурацию контейнера.' },
      { label: 'Вынести тарифы в отдельный микросервис', ok: false, fb: 'Сеть, деплой и отказы ради двух чисел. Это «золотой молоток».' },
      { label: 'Заменить всё одной функцией deliveryCost(type, weight)', ok: true, fb: 'Два случая — один if. Всё, что нужно знать о цене, видно в пяти строках.' }
    ],
    after: {
      files: [
        { name: 'delivery.ts', node: 'delivery', code: `export function deliveryCost(type: 'courier' | 'pickup', weightKg: number) { //#new
  if (type === 'pickup') return 0; //#new
  return weightKg > 5 ? 500 : 300; //#read,new
} //#new` },
        { name: 'checkout.ts', node: 'checkout', code: `const fee = deliveryCost(order.deliveryType, order.weight); //#new` }
      ],
      map: { nodes: [['checkout', 'checkout', 60, 65], ['delivery', 'delivery.ts', 300, 65]], edges: [['checkout', 'delivery']] }
    },
    takeaway: 'KISS: самое простое решение, которое решает задачу сегодня. Стратегия окупается, когда вариантов много и они меняются независимо — тогда смотри OCP. Для двух стабильных случаев это просто лишние файлы.',
    where: [['pat', 'kiss', 'Карточка KISS'], ['pat', 'goldenhammer', 'Антипаттерн: золотой молоток'], ['principle', 'ocp', 'Когда стратегия нужна: OCP']]
  });

  add({
    id: 'yagni', pat: 'yagni', title: 'YAGNI: не строй «на будущее»',
    lede: 'Выгрузка нужна только в CSV, но рядом лежат недописанные XML и PDF «на будущее».',
    intro: 'Бизнес просил выгрузку заказов в CSV. Разработчик «заодно» заложил XML и PDF, шифрование и сжатие. Ими никто не пользуется, но они компилируются, тестируются и ломаются.',
    change: { tag: 'col', title: 'В выгрузку добавили колонку «Скидка»', ask: 'Отметь все строки, которые придётся поправить, чтобы проект собрался и тесты прошли.' },
    before: {
      files: [
        { name: 'CsvExporter.ts', node: 'csv', code: `const HEADER = ['id', 'date', 'total']; //#col
export const csvRow = (o: Order) => [o.id, o.date, o.total].join(';'); //#col` },
        { name: 'XmlExporter.ts', node: 'xml', code: `// TODO: никто не использует, но «пригодится»
export const xmlRow = (o: Order) =>
  \`<order id="\${o.id}"><date>\${o.date}</date><total>\${o.total}</total></order>\`; //#col` },
        { name: 'PdfExporter.ts', node: 'pdf', code: `// TODO: дописать шаблон
export const PDF_COLUMNS = [{ key: 'id', w: 60 }, { key: 'date', w: 80 }, { key: 'total', w: 60 }]; //#col` },
        { name: 'ExportService.ts', node: 'svc', code: `export function exportOrders(orders: Order[], o: { format: 'csv' | 'xml' | 'pdf'; zip?: boolean; encrypt?: boolean }) {
  const rows = o.format === 'csv' ? orders.map(csvRow) : o.format === 'xml' ? orders.map(xmlRow) : renderPdf(orders, PDF_COLUMNS);
  return o.encrypt ? encrypt(o.zip ? zip(rows) : rows) : o.zip ? zip(rows) : rows;
}` },
        { name: 'export.test.ts', node: 'test', code: `test('xml', () => expect(xmlRow(order)).toMatchSnapshot()); //#col
test('pdf columns', () => expect(PDF_COLUMNS).toHaveLength(3)); //#col` }
      ],
      map: { nodes: [['svc', 'ExportService', 20, 65], ['csv', 'CSV', 230, 10], ['xml', 'XML (не нужен)', 230, 65], ['pdf', 'PDF (не нужен)', 230, 120], ['test', 'тесты', 430, 65]], edges: [['svc', 'csv'], ['svc', 'xml'], ['svc', 'pdf'], ['test', 'xml'], ['test', 'pdf']] }
    },
    refactors: [
      { label: 'Дописать XML и PDF до конца, раз уже начали', ok: false, fb: 'Ловушка невозвратных затрат. Код, которым не пользуются, всё равно приходится поддерживать — и он отстаёт от реальных требований.' },
      { label: 'Удалить XML, PDF, шифрование и сжатие — оставить CSV', ok: true, fb: 'Когда понадобится XML, его напишут под реальные требования, а не под догадку. История в git ничего не потеряет.' },
      { label: 'Вынести форматы в плагины и грузить динамически', ok: false, fb: 'Ещё больше инфраструктуры под то, что не нужно. Сложность растёт, пользы ноль.' }
    ],
    after: {
      files: [
        { name: 'CsvExporter.ts', node: 'csv', code: `const HEADER = ['id', 'date', 'total']; //#col
export const csvRow = (o: Order) => [o.id, o.date, o.total].join(';'); //#col
export const exportCsv = (orders: Order[]) => [HEADER.join(';'), ...orders.map(csvRow)].join('\\n'); //#new` }
      ],
      map: { nodes: [['csv', 'CSV-выгрузка', 200, 65]], edges: [] }
    },
    takeaway: 'YAGNI: не строй то, что «точно понадобится потом». Каждая неиспользуемая ветка — код, который правят при каждом изменении. Гибкость нужна там, где изменения уже случались, а не где их воображают.',
    where: [['pat', 'yagni', 'Карточка YAGNI'], ['pat', 'prematureopt', 'Антипаттерн: преждевременная оптимизация']]
  });

  add({
    id: 'lod', pat: 'lod', title: 'Закон Деметры: не лезь в чужие внутренности',
    lede: 'order.getCustomer().getAddress().getCity() — и так в четырёх местах.',
    intro: 'Контроллер, доставка и счёт знают, как устроены заказ, клиент и адрес: каждый идёт по цепочке объектов сам.',
    change: { tag: 'addr', title: 'У клиента теперь два адреса: доставки и юридический', ask: 'Отметь строки, которые сломаются и потребуют правки.' },
    before: {
      files: [
        { name: 'Customer.ts', node: 'customer', code: `export class Customer {
  constructor(private address: Address) {} //#addr
  getAddress(): Address { return this.address; } //#addr
}` },
        { name: 'OrderController.ts', node: 'ctl', code: `const city = order.getCustomer().getAddress().getCity(); //#addr
if (order.getCustomer().getAddress().country !== 'RU') { //#addr
  throw new BadRequest('Доставляем только по России');
}` },
        { name: 'DeliveryService.ts', node: 'delivery', code: `const zone = zones.of(order.customer.address.city); //#addr
const price = tariffs.for(zone, order.weight);` },
        { name: 'InvoicePdf.ts', node: 'invoice', code: `pdf.text(order.getCustomer().getAddress().format()); //#addr` }
      ],
      map: { nodes: [['ctl', 'Контроллер', 10, 10], ['delivery', 'Доставка', 10, 75], ['invoice', 'Счёт', 10, 140], ['order', 'Order', 230, 75], ['customer', 'Customer', 380, 40], ['address', 'Address', 380, 120]], edges: [['ctl', 'order'], ['ctl', 'customer'], ['ctl', 'address'], ['delivery', 'order'], ['delivery', 'customer'], ['delivery', 'address'], ['invoice', 'order'], ['invoice', 'customer'], ['invoice', 'address'], ['order', 'customer'], ['customer', 'address']] }
    },
    refactors: [
      { label: 'Добавить проверки на null: order?.customer?.address?.city', ok: false, fb: 'Цепочка стала безопаснее, но каждый вызывающий по-прежнему знает устройство трёх классов. Изменение адреса ломает те же места.' },
      { label: 'Сделать все поля публичными, чтобы не писать геттеры', ok: false, fb: 'Связность только выросла: теперь любое поле можно дёрнуть откуда угодно.' },
      { label: 'Спрашивать у заказа: order.deliveryCity(), order.isDomestic()', ok: true, fb: 'Tell, don’t ask: вызывающий говорит только с ближайшим объектом. Как устроены клиент и адрес, знает один заказ.' }
    ],
    after: {
      files: [
        { name: 'Order.ts', node: 'order', code: `deliveryCity() { return this.customer.deliveryAddress().city; } //#addr,new
isDomestic() { return this.customer.deliveryAddress().country === 'RU'; } //#addr,new
deliveryAddressText() { return this.customer.deliveryAddress().format(); } //#addr,new` },
        { name: 'Customer.ts', node: 'customer', code: `export class Customer {
  constructor(private delivery: Address, private legal: Address) {} //#new
  deliveryAddress(): Address { return this.delivery; } //#new
}` },
        { name: 'OrderController.ts', node: 'ctl', code: `const city = order.deliveryCity(); //#new
if (!order.isDomestic()) throw new BadRequest('Доставляем только по России'); //#new` },
        { name: 'DeliveryService.ts', node: 'delivery', code: `const zone = zones.of(order.deliveryCity()); //#new` },
        { name: 'InvoicePdf.ts', node: 'invoice', code: `pdf.text(order.deliveryAddressText()); //#new` }
      ],
      map: { nodes: [['ctl', 'Контроллер', 10, 10], ['delivery', 'Доставка', 10, 75], ['invoice', 'Счёт', 10, 140], ['order', 'Order', 230, 75], ['customer', 'Customer', 380, 40], ['address', 'Address', 380, 120]], edges: [['ctl', 'order'], ['delivery', 'order'], ['invoice', 'order'], ['order', 'customer'], ['customer', 'address']] }
    },
    takeaway: 'Закон Деметры: объект разговаривает только с ближайшими друзьями — своими полями, параметрами и тем, что создал сам. Никаких a.b().c().d(). Знание о структуре собирается в одном месте, и изменение не расходится по системе.',
    where: [['pat', 'lod', 'Карточка: закон Деметры'], ['pat', 'facade', 'Паттерн «Фасад»']]
  });

  add({
    id: 'srp', pat: 'srp', title: 'SRP: одна причина меняться',
    lede: 'Отчёт сам ходит в базу, считает, рисует HTML и отправляет письмо.',
    intro: 'ReportService писали «чтобы всё было в одном месте». Финансы меняют формулы, маркетинг — внешний вид, админы — рассылку. Все правят один класс.',
    change: { tag: 'pdf', title: 'Маркетинг просит присылать отчёт в PDF вместо HTML', ask: 'Отметь строки, которые нужно поправить.' },
    before: {
      files: [
        { name: 'ReportService.ts', node: 'report', code: `export class ReportService {
  async build(month: string) {
    const rows = await db.query('SELECT * FROM sales WHERE month = $1', [month]);
    const total = rows.reduce((s, r) => s + r.amount * (1 - r.discount), 0);
    const margin = total - rows.reduce((s, r) => s + r.cost, 0);
    let html = \`<h1>Продажи за \${month}</h1>\`; //#pdf
    html += \`<table><tr><td>Выручка</td><td>\${total}</td></tr><tr><td>Маржа</td><td>\${margin}</td></tr></table>\`; //#pdf
    await mailer.send({ to: 'board@shop.ru', html }); //#pdf
  }
}` }
      ],
      map: { nodes: [['report', 'ReportService: данные + расчёт + вёрстка + почта', 120, 65]], edges: [] }
    },
    refactors: [
      { label: 'Разбить файл на четыре части по 3 строки, связи не трогать', ok: false, fb: 'Размер — не причина. Если части по-прежнему меняются вместе и вызывают друг друга изнутри, ответственность осталась одна большая.' },
      { label: 'Разделить по причинам изменения: данные, расчёт, отображение, отправка', ok: true, fb: 'У каждой части свой заказчик изменений: аналитики, финансы, маркетинг, админы. Смена формата трогает только отображение.' },
      { label: 'Сделать методы статическими, чтобы класс был «утилитой»', ok: false, fb: 'Это не меняет ответственности — только добавляет глобальное состояние.' }
    ],
    after: {
      files: [
        { name: 'SalesData.ts', node: 'data', code: `export const loadSales = (month: string) => db.query('SELECT * FROM sales WHERE month = $1', [month]); //#new` },
        { name: 'SalesMath.ts', node: 'math', code: `export const totals = (rows: Sale[]) => { //#new
  const total = rows.reduce((s, r) => s + r.amount * (1 - r.discount), 0);
  return { total, margin: total - rows.reduce((s, r) => s + r.cost, 0) };
};` },
        { name: 'ReportView.ts', node: 'view', code: `export const renderReport = (month: string, t: Totals) => //#new
  pdf.render('sales-report', { month, ...t }); // вернёт Attachment //#pdf,new` },
        { name: 'ReportJob.ts', node: 'job', code: `const t = totals(await loadSales(month)); //#new
await mailer.send({ to: 'board@shop.ru', attachment: renderReport(month, t) }); //#new` }
      ],
      map: { nodes: [['job', 'ReportJob', 20, 65], ['data', 'SalesData', 230, 10], ['math', 'SalesMath', 230, 75], ['view', 'ReportView', 230, 140]], edges: [['job', 'data'], ['job', 'math'], ['job', 'view']] }
    },
    takeaway: 'SRP: у модуля одна причина меняться — один «заказчик» изменений. Не «один метод на класс», а одна ответственность перед одной группой людей. Тогда изменение формата не заставляет перепроверять финансовые формулы.',
    where: [['pat', 'srp', 'Карточка SRP'], ['pat', 'godobject', 'Антипаттерн: божественный объект'], ['inner', 'i-layers', 'Внутри сервиса: толстый контроллер']]
  });

  add({
    id: 'ocp', pat: 'ocp', title: 'OCP: расширять, не переписывая',
    lede: 'Каждый новый способ оплаты правит три switch в трёх файлах.',
    intro: 'Способы оплаты — карта и наличные. Комиссия, проверка и подпись на кнопке написаны через switch по типу.',
    change: { tag: 'sbp', title: 'Добавляем оплату через СБП', ask: 'Отметь строки существующего кода, которые придётся изменить.' },
    before: {
      files: [
        { name: 'types.ts', node: 'types', code: `export type PayType = 'card' | 'cash'; //#sbp` },
        { name: 'fee.ts', node: 'fee', code: `export function fee(t: PayType, sum: number) {
  switch (t) { //#sbp
    case 'card': return sum * 0.015;
    case 'cash': return 0;
  }
}` },
        { name: 'validate.ts', node: 'validate', code: `export function validate(t: PayType, sum: number) {
  if (t === 'cash' && sum > 100_000) throw new Error('Наличными до 100 000'); //#sbp
}` },
        { name: 'label.ts', node: 'label', code: `export const label = (t: PayType) => (t === 'card' ? 'Картой' : 'Наличными'); //#sbp` }
      ],
      map: { nodes: [['types', 'PayType', 200, 10], ['fee', 'fee', 40, 110], ['validate', 'validate', 200, 110], ['label', 'label', 360, 110]], edges: [['fee', 'types'], ['validate', 'types'], ['label', 'types']] }
    },
    refactors: [
      { label: 'Каждый способ оплаты — свой объект с fee, validate и label; выбор через реестр', ok: true, fb: 'Новый способ — новый файл. Существующий код меняется в одной строке: регистрация в реестре.' },
      { label: 'Слить три switch в один большой', ok: false, fb: 'Мест меньше, но каждый новый способ по-прежнему правит работающий общий код — и рискует сломать карту и наличные.' },
      { label: 'Добавить флаг isSbp в каждую функцию', ok: false, fb: 'Флаги растут с каждым способом оплаты. Через год в функции будет пять булевых параметров.' }
    ],
    after: {
      files: [
        { name: 'PaymentMethod.ts', node: 'iface', code: `export interface PaymentMethod { id: string; label: string; fee(sum: number): number; validate(sum: number): void } //#new` },
        { name: 'card.ts', node: 'card', code: `export const card: PaymentMethod = { id: 'card', label: 'Картой', fee: s => s * 0.015, validate: () => {} }; //#new` },
        { name: 'cash.ts', node: 'cash', code: `export const cash: PaymentMethod = { id: 'cash', label: 'Наличными', fee: () => 0, //#new
  validate: s => { if (s > 100_000) throw new Error('Наличными до 100 000'); } };` },
        { name: 'registry.ts', node: 'registry', code: `export const methods = new Map([card, cash].map(m => [m.id, m])); //#sbp,new` }
      ],
      map: { nodes: [['registry', 'реестр', 20, 65], ['card', 'card', 200, 10], ['cash', 'cash', 200, 120], ['iface', '«interface» PaymentMethod', 360, 65]], edges: [['registry', 'card'], ['registry', 'cash'], ['card', 'iface'], ['cash', 'iface']] }
    },
    takeaway: 'OCP: модуль открыт для расширения и закрыт для изменения. Новое поведение добавляется новым кодом, а работающий код не трогают — значит, и не ломают. Но не превращай каждый if в стратегию: см. KISS.',
    where: [['pat', 'ocp', 'Карточка OCP'], ['pat', 'strategy', 'Паттерн «Стратегия»'], ['principle', 'kiss', 'Когда это лишнее: KISS']]
  });

  add({
    id: 'lsp', pat: 'lsp', title: 'LSP: наследник без сюрпризов',
    lede: 'Бонусный счёт унаследован от обычного, но бросает исключение при снятии.',
    intro: 'Появились бонусные счета: с них нельзя снимать. Их сделали наследником Account, а withdraw() переопределили так, чтобы он бросал ошибку.',
    change: { tag: 'bonus', title: 'Бонусные счета попали в переводы, выплаты и закрытие счёта', ask: 'Отметь строки, где теперь возможна ошибка и нужна правка.' },
    before: {
      files: [
        { name: 'BonusAccount.ts', node: 'bonus', code: `export class BonusAccount extends Account {
  withdraw(_: number): void { throw new Error('С бонусного счёта снимать нельзя'); } //#bonus
}` },
        { name: 'transfer.ts', node: 'transfer', code: `export function transfer(from: Account, to: Account, sum: number) {
  from.withdraw(sum); //#bonus
  to.deposit(sum);
}` },
        { name: 'payout.ts', node: 'payout', code: `for (const acc of user.accounts) acc.withdraw(acc.balance * 0.1); //#bonus` },
        { name: 'close.ts', node: 'close', code: `export const close = (acc: Account) => acc.withdraw(acc.balance); //#bonus` }
      ],
      map: { nodes: [['transfer', 'transfer', 10, 10], ['payout', 'payout', 10, 75], ['close', 'close', 10, 140], ['account', 'Account', 260, 75], ['bonus', 'BonusAccount', 420, 75]], edges: [['transfer', 'account'], ['payout', 'account'], ['close', 'account'], ['bonus', 'account']] }
    },
    refactors: [
      { label: 'Добавить if (acc instanceof BonusAccount) во все места', ok: false, fb: 'Это и есть симптом нарушения LSP: вызывающий код начинает знать о подклассах. С каждым новым типом счёта проверок станет больше.' },
      { label: 'Разделить контракт: снимать можно только с Withdrawable, бонусный счёт его не реализует', ok: true, fb: 'Теперь компилятор не даст передать бонусный счёт туда, где нужно снятие. Подстановка честная: каждый тип выполняет весь свой контракт.' },
      { label: 'В BonusAccount.withdraw молча ничего не делать', ok: false, fb: 'Хуже исключения: перевод «прошёл», деньги зачислились, но ниоткуда не списались.' }
    ],
    after: {
      files: [
        { name: 'contracts.ts', node: 'account', code: `export interface Depositable { deposit(sum: number): void } //#new
export interface Withdrawable extends Depositable { withdraw(sum: number): void } //#new` },
        { name: 'BonusAccount.ts', node: 'bonus', code: `export class BonusAccount implements Depositable { deposit(sum: number) { this.balance += sum; } } //#bonus,new` },
        { name: 'transfer.ts', node: 'transfer', code: `export function transfer(from: Withdrawable, to: Depositable, sum: number) { //#new
  from.withdraw(sum);
  to.deposit(sum);
}` },
        { name: 'payout.ts', node: 'payout', code: `for (const acc of user.withdrawableAccounts()) acc.withdraw(acc.balance * 0.1); //#new` }
      ],
      map: { nodes: [['transfer', 'transfer', 10, 10], ['payout', 'payout', 10, 75], ['close', 'close', 10, 140], ['account', 'Withdrawable / Depositable', 230, 75], ['bonus', 'BonusAccount', 430, 120]], edges: [['transfer', 'account'], ['payout', 'account'], ['close', 'account'], ['bonus', 'account']] }
    },
    takeaway: 'LSP: подтип должен работать везде, где работает базовый тип, без особых случаев. Если наследник бросает «не поддерживается» или молча ничего не делает — иерархия неверна, разделяй контракт.',
    where: [['pat', 'lsp', 'Карточка LSP'], ['principle', 'isp', 'Соседний принцип: ISP']]
  });

  add({
    id: 'isp', pat: 'isp', title: 'ISP: маленькие интерфейсы',
    lede: 'Интерфейс Storage на восемь методов: половина реализаций — заглушки.',
    intro: 'Все хранилища реализуют один интерфейс Storage: чтение, запись, бэкап, миграции. CDN только читает, кэш не умеет бэкапы — у них заглушки с throw.',
    change: { tag: 'snap', title: 'Админам нужен метод snapshot() для бэкапов', ask: 'Отметь строки, которые придётся написать или поправить.' },
    before: {
      files: [
        { name: 'Storage.ts', node: 'iface', code: `export interface Storage {
  get(k: string): Promise<Buffer>; put(k: string, v: Buffer): Promise<void>; delete(k: string): Promise<void>;
  backup(): Promise<void>; restore(id: string): Promise<void>; migrate(): Promise<void>;
  // + snapshot(): Promise<string> //#snap
}` },
        { name: 'S3Storage.ts', node: 's3', code: `class S3Storage implements Storage { /* … все методы … */ snapshot() { return s3.snapshot(); } } //#snap` },
        { name: 'LocalStorage.ts', node: 'local', code: `class LocalStorage implements Storage { /* … */ snapshot() { return fs.cp(DIR, SNAP); } } //#snap` },
        { name: 'CdnStorage.ts', node: 'cdn', code: `class CdnStorage implements Storage {
  put() { throw new Error('read-only'); } delete() { throw new Error('read-only'); }
  backup() { throw new Error('нет'); } snapshot() { throw new Error('нет'); } //#snap
}` },
        { name: 'CacheStorage.ts', node: 'cache', code: `class CacheStorage implements Storage { backup() { throw new Error('нет'); } snapshot() { throw new Error('нет'); } } //#snap` }
      ],
      map: { nodes: [['iface', '«interface» Storage (8)', 190, 10], ['s3', 'S3', 20, 120], ['local', 'Local', 150, 120], ['cdn', 'CDN', 280, 120], ['cache', 'Cache', 410, 120]], edges: [['s3', 'iface'], ['local', 'iface'], ['cdn', 'iface'], ['cache', 'iface']] }
    },
    refactors: [
      { label: 'Абстрактный BaseStorage с заглушками throw по умолчанию', ok: false, fb: 'Заглушки никуда не делись — просто спрятались в базовый класс. Клиент по-прежнему видит методы, которые упадут.' },
      { label: 'Разбить по клиентам: Readable, Writable, Admin', ok: true, fb: 'CDN реализует только Readable, кэш — Readable и Writable. snapshot() добавляется в Admin, а его реализует только S3.' },
      { label: 'Добавить snapshot() с реализацией по умолчанию «не поддерживается»', ok: false, fb: 'Компилятор доволен, а пользователь получит ошибку в рантайме.' }
    ],
    after: {
      files: [
        { name: 'contracts.ts', node: 'iface', code: `export interface Readable { get(k: string): Promise<Buffer> } //#new
export interface Writable { put(k: string, v: Buffer): Promise<void>; delete(k: string): Promise<void> } //#new
export interface Admin { backup(): Promise<void>; restore(id: string): Promise<void>; snapshot(): Promise<string> } //#snap,new` },
        { name: 'S3Storage.ts', node: 's3', code: `class S3Storage implements Readable, Writable, Admin { /* … */ snapshot() { return s3.snapshot(); } } //#snap` },
        { name: 'CdnStorage.ts', node: 'cdn', code: `class CdnStorage implements Readable { get(k: string) { return cdn.fetch(k); } } //#new` },
        { name: 'CacheStorage.ts', node: 'cache', code: `class CacheStorage implements Readable, Writable { /* get, put, delete */ } //#new` }
      ],
      map: { nodes: [['iface', 'Readable · Writable · Admin', 180, 10], ['s3', 'S3', 20, 120], ['local', 'Local', 150, 120], ['cdn', 'CDN', 280, 120], ['cache', 'Cache', 410, 120]], edges: [['s3', 'iface'], ['local', 'iface'], ['cdn', 'iface'], ['cache', 'iface']] }
    },
    takeaway: 'ISP: клиент не должен зависеть от методов, которыми не пользуется. Маленькие интерфейсы под конкретных клиентов: новое требование затрагивает только тех, кому оно нужно.',
    where: [['pat', 'isp', 'Карточка ISP'], ['principle', 'lsp', 'Соседний принцип: LSP']]
  });

  add({
    id: 'dip', pat: 'dip', title: 'DIP: зависеть от абстракций',
    lede: 'Каждый сервис сам создаёт PostgreSQL-репозиторий. Тест без базы невозможен.',
    intro: 'OrderService, RefundService и ReportService внутри себя делают new PgOrderRepository(). Бизнес-код знает, что данные лежат именно в PostgreSQL.',
    change: { tag: 'store', title: 'Переезжаем на DynamoDB, а заодно нужны тесты без базы', ask: 'Отметь строки, которые придётся поменять.' },
    before: {
      files: [
        { name: 'OrderService.ts', node: 'orders', code: `import { PgOrderRepository } from './pg/PgOrderRepository'; //#store
export class OrderService {
  private repo = new PgOrderRepository(new Pool(PG_URL)); //#store
}` },
        { name: 'RefundService.ts', node: 'refunds', code: `import { PgOrderRepository } from './pg/PgOrderRepository'; //#store
export class RefundService { private repo = new PgOrderRepository(new Pool(PG_URL)); } //#store` },
        { name: 'ReportService.ts', node: 'reports', code: `import { PgOrderRepository } from './pg/PgOrderRepository'; //#store
export class ReportService { private repo = new PgOrderRepository(new Pool(PG_URL)); } //#store` }
      ],
      map: { nodes: [['orders', 'OrderService', 20, 10], ['refunds', 'RefundService', 20, 75], ['reports', 'ReportService', 20, 140], ['pg', 'PgOrderRepository', 330, 75]], edges: [['orders', 'pg'], ['refunds', 'pg'], ['reports', 'pg']] }
    },
    refactors: [
      { label: 'Глобальный синглтон Db.instance вместо new в каждом сервисе', ok: false, fb: 'Зависимость стала скрытой, но осталась: сервисы всё ещё знают про PostgreSQL, а тест не подменит синглтон без хаков.' },
      { label: 'Скопировать сервисы в версии для DynamoDB', ok: false, fb: 'Две копии бизнес-логики разойдутся через неделю.' },
      { label: 'Сервисы зависят от интерфейса OrderStore, реализация приходит в конструктор', ok: true, fb: 'Бизнес-код знает только контракт. Какую реализацию подставить, решает одна строка в composition root, а тест передаёт фейк.' }
    ],
    after: {
      files: [
        { name: 'OrderStore.ts', node: 'port', code: `export interface OrderStore { findById(id: string): Promise<Order | null>; save(o: Order): Promise<void> } //#new` },
        { name: 'OrderService.ts', node: 'orders', code: `export class OrderService { constructor(private store: OrderStore) {} } //#new` },
        { name: 'RefundService.ts', node: 'refunds', code: `export class RefundService { constructor(private store: OrderStore) {} } //#new` },
        { name: 'ReportService.ts', node: 'reports', code: `export class ReportService { constructor(private store: OrderStore) {} } //#new` },
        { name: 'main.ts', node: 'main', code: `const store: OrderStore = new DynamoOrderStore(ddb); //#store,new
const orders = new OrderService(store), refunds = new RefundService(store), reports = new ReportService(store); //#new` }
      ],
      map: { nodes: [['orders', 'OrderService', 20, 10], ['refunds', 'RefundService', 20, 75], ['reports', 'ReportService', 20, 140], ['port', '«interface» OrderStore', 240, 75], ['pg', 'DynamoOrderStore', 450, 40], ['main', 'main.ts', 450, 120]], edges: [['orders', 'port'], ['refunds', 'port'], ['reports', 'port'], ['pg', 'port'], ['main', 'pg']] }
    },
    takeaway: 'DIP: модули верхнего уровня не зависят от деталей — и те, и другие зависят от абстракций. Технология меняется в одном месте, а сценарии тестируются без базы. На уровне сервиса это архитектура «порты и адаптеры».',
    where: [['pat', 'dip', 'Карточка DIP'], ['inner', 'i-ports', 'Внутри сервиса: переезд базы через порты'], ['pat', 'hexagonal', 'Порты и адаптеры']]
  });

  add({
    id: 'composition', pat: 'composition', title: 'Композиция вместо наследования',
    lede: 'Email, SMS, с повторами, с повторами и логами — по классу на каждое сочетание.',
    intro: 'Уведомления растили наследованием: EmailNotifier, SmsNotifier, RetryingEmailNotifier, RetryingSmsNotifier. Каждое новое умение удваивает число классов.',
    change: { tag: 'log', title: 'Нужно логировать все отправки', ask: 'Отметь строки, которые придётся написать или поменять.' },
    before: {
      files: [
        { name: 'EmailNotifier.ts', node: 'email', code: `class EmailNotifier extends Notifier { send(m: Msg) { log(m); return smtp.send(m); } } //#log` },
        { name: 'SmsNotifier.ts', node: 'sms', code: `class SmsNotifier extends Notifier { send(m: Msg) { log(m); return sms.send(m); } } //#log` },
        { name: 'RetryingEmailNotifier.ts', node: 'remail', code: `class RetryingEmailNotifier extends EmailNotifier { send(m: Msg) { log(m); return retry(() => super.send(m)); } } //#log` },
        { name: 'RetryingSmsNotifier.ts', node: 'rsms', code: `class RetryingSmsNotifier extends SmsNotifier { send(m: Msg) { log(m); return retry(() => super.send(m)); } } //#log` }
      ],
      map: { nodes: [['base', 'Notifier', 200, 10], ['email', 'Email', 80, 75], ['sms', 'Sms', 320, 75], ['remail', 'RetryingEmail', 80, 140], ['rsms', 'RetryingSms', 320, 140]], edges: [['email', 'base'], ['sms', 'base'], ['remail', 'email'], ['rsms', 'sms']] }
    },
    refactors: [
      { label: 'Ещё уровень наследования: LoggedNotifier над всеми', ok: false, fb: 'Логирование попадёт и туда, где оно не нужно, а следующее умение снова потребует перестройки иерархии.' },
      { label: 'Флаги в базовом классе: if (this.retry) …, if (this.log) …', ok: false, fb: 'Базовый класс превращается в комбайн из флагов: каждое новое умение правит его.' },
      { label: 'Обёртки-декораторы: withLog(withRetry(email))', ok: true, fb: 'Каждое умение — маленькая обёртка над любым Notifier. Логирование — один новый декоратор и одна строка сборки.' }
    ],
    after: {
      files: [
        { name: 'Notifier.ts', node: 'base', code: `export interface Notifier { send(m: Msg): Promise<void> } //#new` },
        { name: 'decorators.ts', node: 'deco', code: `export const withRetry = (n: Notifier): Notifier => ({ send: m => retry(() => n.send(m)) }); //#new
export const withLog = (n: Notifier): Notifier => ({ send: m => (log(m), n.send(m)) }); //#log,new` },
        { name: 'main.ts', node: 'main', code: `const email = withLog(withRetry(new SmtpNotifier())), sms = withLog(withRetry(new SmsNotifier())); //#log,new` }
      ],
      map: { nodes: [['main', 'main.ts', 20, 75], ['deco', 'withRetry · withLog', 220, 75], ['email', 'Smtp', 430, 30], ['sms', 'Sms', 430, 120], ['base', '«interface» Notifier', 220, 150]], edges: [['main', 'deco'], ['deco', 'email'], ['deco', 'sms'], ['email', 'base'], ['sms', 'base']] }
    },
    takeaway: 'Композиция вместо наследования: поведение собирается из маленьких частей, а не наследуется пачкой. Наследование — для «является», композиция — для «умеет». Декоратор, стратегия и middleware — всё это композиция.',
    where: [['pat', 'composition', 'Карточка'], ['pat', 'decorator', 'Паттерн «Декоратор»']]
  });

  add({
    id: 'failfast', pat: 'failfast', title: 'Fail fast: падать сразу и громко',
    lede: 'Отрицательное количество проходит через три слоя и падает в базе с непонятной ошибкой.',
    intro: 'Контроллер не проверяет вход. Сервис считает сумму с qty = −3, склад «резервирует» минус три штуки, а база отвечает check_violation через 400 мс.',
    change: { tag: 'guard', title: 'Клиент прислал qty = −3', ask: 'Отметь строки, где плохое значение используется и где его пришлось бы проверять.' },
    before: {
      files: [
        { name: 'OrderController.ts', node: 'ctl', code: `app.post('/orders', async (req, res) => {
  const id = await orders.place(req.body.items); //#guard
  res.json({ id });
});` },
        { name: 'OrderService.ts', node: 'svc', code: `async place(items: Item[]) {
  const total = items.reduce((s, i) => s + i.price * i.qty, 0); //#guard
  await inventory.reserve(items); //#guard
  return repo.insert({ items, total }); //#guard
}` },
        { name: 'schema.sql', node: 'db', code: `CHECK (qty > 0)   -- ошибка всплывёт здесь: check_violation //#guard` }
      ],
      map: { nodes: [['ctl', 'Контроллер', 20, 65], ['svc', 'OrderService', 190, 65], ['inv', 'Склад', 360, 20], ['db', 'БД', 360, 110]], edges: [['ctl', 'svc'], ['svc', 'inv'], ['svc', 'db']] }
    },
    refactors: [
      { label: 'Ловить ошибку базы и возвращать 500', ok: false, fb: 'Склад уже зарезервировал минус три штуки, а клиент получил «внутреннюю ошибку» вместо понятного ответа.' },
      { label: 'Проверять вход на границе: схема запроса и тип Quantity, который не бывает ≤ 0', ok: true, fb: 'Плохие данные останавливаются на входе с ответом 400 и понятным текстом. Внутри системы qty всегда корректен — проверки не размазываются.' },
      { label: 'Подставлять Math.abs(qty)', ok: false, fb: 'Хуже всего: молча «чинить» данные. Клиент получит заказ на 3 штуки, хотя ошибся.' }
    ],
    after: {
      files: [
        { name: 'OrderController.ts', node: 'ctl', code: `const Body = z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1) }); //#guard,new
app.post('/orders', async (req, res) => res.json({ id: await orders.place(Body.parse(req.body).items) })); //#new` },
        { name: 'OrderService.ts', node: 'svc', code: `async place(items: ValidItem[]) { /* qty здесь уже гарантированно > 0 */ }` }
      ],
      map: { nodes: [['ctl', 'Контроллер + схема', 20, 65], ['svc', 'OrderService', 190, 65], ['inv', 'Склад', 360, 20], ['db', 'БД', 360, 110]], edges: [['ctl', 'svc'], ['svc', 'inv'], ['svc', 'db']] }
    },
    takeaway: 'Fail fast: ошибку ловят там, где она вошла в систему, и сообщают понятно. Чем дальше плохие данные уходят, тем больше мест их должны проверять и тем дороже разбор. Внутри системы помогают типы, которые не бывают неверными.',
    where: [['pat', 'failfast', 'Карточка Fail fast'], ['pat', 'valueobject', 'Объект-значение']]
  });

  add({
    id: 'observer', pat: 'observer', group: 'gof', title: 'Наблюдатель: источник не знает о реакциях',
    lede: 'Каждая новая реакция на заказ — правка OrderService.',
    intro: 'После оформления заказа нужно отправить письмо, записать аналитику и начислить баллы. OrderService вызывает всех сам.',
    change: { tag: 'sms', title: 'При оформлении заказа ещё отправлять SMS', ask: 'Отметь строки, которые придётся поменять.' },
    before: {
      files: [
        { name: 'OrderService.ts', node: 'svc', code: `export class OrderService {
  constructor(private email: Mailer, private analytics: Analytics, private loyalty: Loyalty) {} //#sms
  async place(cmd: PlaceOrder) {
    const order = await this.repo.save(Order.place(cmd));
    await this.email.orderPlaced(order);
    await this.analytics.track('order_placed', order);
    await this.loyalty.addPoints(order); //#sms
  }
}` },
        { name: 'OrderService.test.ts', node: 'test', code: `const svc = new OrderService(mailer, analytics, loyalty); //#sms` }
      ],
      map: { nodes: [['svc', 'OrderService', 30, 75], ['test', 'OrderService.test', 30, 150], ['mail', 'Mailer', 300, 10], ['an', 'Analytics', 300, 75], ['loy', 'Loyalty', 300, 140]], edges: [['svc', 'mail'], ['svc', 'an'], ['svc', 'loy'], ['test', 'svc']] }
    },
    refactors: [
      { label: 'Вынести все вызовы в метод afterPlace() того же класса', ok: false, fb: 'Код переехал на 10 строк ниже, но OrderService по-прежнему знает всех получателей.' },
      { label: 'OrderService публикует событие OrderPlaced, реакции подписываются сами', ok: true, fb: 'Источник не знает, кто реагирует. Новая реакция — новый подписчик и одна строка регистрации.' },
      { label: 'Вызывать реакции из контроллера после place()', ok: false, fb: 'Знание просто переехало в контроллер. А консьюмер из брокера, который тоже оформляет заказы, про SMS забудет.' }
    ],
    after: {
      files: [
        { name: 'OrderService.ts', node: 'svc', code: `async place(cmd: PlaceOrder) {
  const order = await this.repo.save(Order.place(cmd));
  this.events.publish({ type: 'OrderPlaced', order }); //#new
}` },
        { name: 'subscribers.ts', node: 'subs', code: `events.on('OrderPlaced', e => mailer.orderPlaced(e.order)); //#new
events.on('OrderPlaced', e => analytics.track('order_placed', e.order)); //#new
events.on('OrderPlaced', e => loyalty.addPoints(e.order)); //#new
events.on('OrderPlaced', e => sms.orderPlaced(e.order)); //#sms,new` }
      ],
      map: { nodes: [['svc', 'OrderService', 20, 75], ['bus', 'OrderPlaced', 200, 75], ['mail', 'Mailer', 380, 0], ['an', 'Analytics', 380, 55], ['loy', 'Loyalty', 380, 110], ['smsn', 'SMS', 380, 165], ['subs', 'subscribers.ts', 170, 150]], edges: [['svc', 'bus'], ['subs', 'bus'], ['subs', 'mail'], ['subs', 'an'], ['subs', 'loy'], ['subs', 'smsn']] }
    },
    takeaway: 'Наблюдатель: источник публикует факт, а подписчики решают, что с ним делать. Новая реакция не трогает источник. В масштабе системы это событийная архитектура: брокер вместо events.on.',
    where: [['pat', 'observer', 'Паттерн «Наблюдатель»'], ['pat', 'eda', 'Событийная архитектура'], ['dive', 'eda', 'Разбор: событийная архитектура']]
  });

  /* разбор кода: метки //#теги в конце строки */
  const TAG = /\s*\/\/#([\w,]+)\s*$/;
  const parse = files => files.map(f => {
    const lines = f.code.split('\n').map(raw => { const m = raw.match(TAG); return { text: m ? raw.replace(TAG, '') : raw, tags: m ? m[1].split(',') : [] }; });
    return Object.assign({}, f, { lines });
  });
  P.forEach(s => { s.before.parsed = parse(s.before.files); s.after.parsed = parse(s.after.files); s.group = s.group || 'principle'; });
  SD.principlesAdd = s => { s.before.parsed = parse(s.before.files); s.after.parsed = parse(s.after.files); s.group = s.group || 'gof'; P.push(s); };
  P.find(s => s.id === 'composition').pats = ['decorator'];
  SD.principleById = id => P.find(s => s.id === id);
  SD.principleForPattern = pat => P.find(s => s.pat === pat) || P.find(s => (s.pats || []).includes(pat));
})();
