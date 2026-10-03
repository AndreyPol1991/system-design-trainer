/* Разборы: архитектурные стили и подходы. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const D = SD.DIVES;

  D.archstyles = {
    title: 'Архитектурные стили: от монолита до serverless', icon: 'app', lede: 'Монолит, модульный монолит, микросервисы, SOA с шиной, serverless — плюсы, цена и как выбрать.',
    actors: [
      { id: 'mono', x: 20, y: 40, w: 140, label: 'Монолит', sub: '1 деплой' },
      { id: 'mod', x: 175, y: 40, w: 140, label: 'Модульный', sub: '1 деплой, модули' },
      { id: 'micro', x: 330, y: 40, w: 140, label: 'Микросервисы', sub: 'N деплоев' },
      { id: 'soa', x: 485, y: 40, w: 140, label: 'SOA', sub: 'шина ESB' },
      { id: 'faas', x: 175, y: 210, w: 140, label: 'Serverless', sub: 'функции' },
      { id: 'pick', x: 330, y: 210, w: 140, label: 'Выбор', sub: 'по силам' }
    ],
    code: [
      { label: 'Модульный монолит', lang: 'java', src: `
// Модули внутри одного приложения общаются только через публичный API
com.shop.orders.api.OrderService          // можно вызывать из других модулей
com.shop.orders.internal.OrderRepository  // нельзя

@ArchTest
static final ArchRule modules = slices().matching("com.shop.(*)..")
    .should().notDependOnEachOther()
    .ignoreDependency(alwaysTrue(), resideInAPackage("..api.."));` },
      { label: 'Serverless', lang: 'js', src: `
export const handler = async (event) => {          // AWS Lambda
  const order = JSON.parse(event.body);
  await db.put({ TableName: 'orders', Item: order });
  return { statusCode: 201, body: JSON.stringify({ id: order.id }) };
};` }
    ],
    steps: [
      { title: 'Монолит', text: 'Одно приложение, одна база, один деплой. Быстрый старт, простые транзакции и отладка. Проблемы приходят с ростом: десятки разработчиков в одном коде, релиз раз в месяц, масштабируется всё целиком.', hl: ['mono'] },
      { title: 'Модульный монолит', text: 'Деплой по-прежнему один, но код разделён на модули с явными границами и публичным API. Границы проверяются тестами архитектуры. Лучший первый шаг: модуль потом легко вынести в сервис.', hl: ['mod'], c: { 0: [1, 2, 3, 4, 5, 6, 7, 8] } },
      { title: 'Микросервисы', text: 'Сервис на ограниченный контекст, своя база, независимый деплой и масштабирование. Цена: сеть вместо вызова функции, распределённые транзакции, трассировка, платформа. Оправданы, когда команд много и они мешают друг другу.', hl: ['micro'] },
      { title: 'SOA и шина', text: 'Сервисы предприятия интегрируются через центральную шину, которая маршрутизирует и преобразует сообщения. Умная шина, простые сервисы. Со временем шина становится узким местом и центром власти одной команды.', hl: ['soa'] },
      { title: 'Serverless', text: 'Функции запускаются по событию, облако масштабирует их само, платишь за вызовы. Хорошо для неровной нагрузки и склейки сервисов. Дорого при постоянной высокой нагрузке, есть холодные старты.', hl: ['faas'], c: { 1: [1, 2, 3, 4, 5] } },
      { title: 'Как выбрать', text: 'Стиль выбирают по силам, а не по моде: число команд, требования к масштабу и надёжности, опыт эксплуатации. Типичный путь: монолит → модульный монолит → вынос отдельных сервисов там, где больно.', good: ['pick'], msgs: [{ from: 'mono', to: 'mod', label: 'границы' }, { from: 'mod', to: 'micro', label: 'вынос' }] }
    ]
  };

  D.ddd = {
    title: 'DDD: контексты, агрегаты, события', icon: 'app', lede: 'Как резать систему по предметной области, а не по таблицам.',
    actors: [
      { id: 'cat', x: 20, y: 30, w: 190, label: 'Каталог' },
      { id: 'ord', x: 225, y: 30, w: 190, label: 'Заказы' },
      { id: 'del', x: 430, y: 30, w: 190, label: 'Доставка' },
      { id: 'bus', x: 225, y: 240, w: 190, label: 'Доменные события' }
    ],
    code: [
      { label: 'Java · агрегат', lang: 'java', src: `
public class Order {                                  // корень агрегата
    private final OrderId id;
    private final List<OrderLine> lines = new ArrayList<>();
    private OrderStatus status = OrderStatus.DRAFT;

    public void addLine(ProductId product, int qty, Money price) {
        if (status != OrderStatus.DRAFT) throw new IllegalStateException("Заказ уже оформлен");
        lines.add(new OrderLine(product, qty, price));     // инвариант проверяет корень
    }

    public OrderPlaced place() {
        if (lines.isEmpty()) throw new IllegalStateException("Пустой заказ");
        status = OrderStatus.PLACED;
        return new OrderPlaced(id, total());             // доменное событие
    }
}` }
    ],
    steps: [
      { title: 'Единый язык', text: 'DDD начинается с разговора с экспертами предметной области: какие слова они используют и что под ними понимают. Эти слова становятся именами классов, методов и таблиц.' },
      { title: 'Ограниченные контексты', text: 'Слово «товар» значит разное: в каталоге это описание и фото, в заказах — цена в момент покупки, в доставке — вес и габариты. Граница, внутри которой модель однозначна, — ограниченный контекст. Кандидат на отдельный сервис и команду.', lines: { cat: ['Товар: название, фото, цена'], ord: ['Товар: SKU, цена покупки'], del: ['Товар: вес, габариты'] } },
      { title: 'Агрегат', text: 'Агрегат — кластер объектов, который меняется одной транзакцией через корень. Заказ сам проверяет правила: нельзя добавить строку в оформленный заказ. Снаружи меняют только через корень.', hl: ['ord'], c: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { title: 'Доменное событие', text: 'Оформление заказа порождает событие OrderPlaced. Другие контексты узнают о нём и реагируют сами, в своё время. Между агрегатами и контекстами — согласованность в конечном счёте.', msgs: [{ from: 'ord', to: 'bus', label: 'OrderPlaced' }], c: [11, 12, 13, 14, 15] },
      { title: 'Карта контекстов', text: 'Карта описывает отношения: кто поставщик, кто потребитель, где нужен антикоррупционный слой (ACL) — переводчик, который не пускает чужую модель в твою.', msgs: [{ from: 'bus', to: 'del', label: 'OrderPlaced → ACL' }, { from: 'bus', to: 'cat', label: 'резерв витрины' }] },
      { title: 'Event Storming', text: 'Границы удобно искать на Event Storming: эксперты и разработчики раскладывают на стене доменные события по времени, потом команды и агрегаты. Плотные кластеры событий подсказывают контексты.' }
    ]
  };

  D.eda = {
    title: 'Событийная архитектура', icon: 'queue', lede: 'Публикация фактов вместо цепочек синхронных вызовов.',
    actors: [
      { id: 'ord', x: 20, y: 140, w: 150, label: 'Заказы' },
      { id: 'bus', x: 230, y: 140, w: 150, label: 'Брокер' },
      { id: 'pay', x: 460, y: 30, w: 160, label: 'Оплата' },
      { id: 'st', x: 460, y: 140, w: 160, label: 'Склад' },
      { id: 'ml', x: 460, y: 250, w: 160, label: 'Уведомления' }
    ],
    code: [
      { label: 'JavaScript', lang: 'js', src: `
// Заказы публикуют факт и не знают, кто его слушает
await broker.publish('orders.placed', { orderId: 777, userId: 42, total: 990 });

// Каждый подписчик реагирует сам
broker.subscribe('orders.placed', 'payments', async e => charge(e.orderId, e.total));
broker.subscribe('orders.placed', 'stock',    async e => reserve(e.orderId));
broker.subscribe('orders.placed', 'mailer',   async e => sendEmail(e.userId, 'Заказ принят'));

// Событие-уведомление или перенос состояния:
// { orderId: 777 }                       → подписчик сам идёт за деталями
// { orderId: 777, items: [...], total }  → всё нужное внутри события` }
    ],
    steps: [
      { title: 'Синхронная цепочка', text: 'Заказы по очереди вызывают оплату, склад и почту и ждут каждого. Упала почта — упал заказ. Задержки складываются, а доступности перемножаются.', bad: ['ord'], msgs: [{ from: 'ord', to: 'pay', label: 'вызов, жду' }, { from: 'ord', to: 'st', label: 'вызов, жду' }, { from: 'ord', to: 'ml', label: 'вызов, жду', color: 'bad' }] },
      { title: 'Публикация факта', text: 'Заказы публикуют факт «заказ оформлен» и сразу отвечают пользователю. Кто и как на него отреагирует, заказы не знают.', msgs: [{ from: 'ord', to: 'bus', label: 'OrderPlaced' }], c: [1, 2] },
      { title: 'Подписчики', text: 'Каждый подписчик реагирует сам и в своём темпе. Новому сервису (аналитике, антифроду) достаточно подписаться — менять заказы не нужно.', msgs: [{ from: 'bus', to: 'pay', label: 'charge' }, { from: 'bus', to: 'st', label: 'reserve' }, { from: 'bus', to: 'ml', label: 'email' }], c: [4, 5, 6, 7] },
      { title: 'Подписчик упал', text: 'Упали уведомления — их события ждут в брокере. Заказы и оплата продолжают работать. Связь по времени и доступности разорвана.', bad: ['ml'], badge: { ml: 'DOWN' }, good: ['ord', 'pay'] },
      { title: 'Цена', text: 'Согласованность в конечном счёте и сложная отладка: где сейчас заказ? Нужны correlation id и трассировка, идемпотентные потребители, мониторинг лага, схемы событий с версиями.' },
      { title: 'Какие бывают события', text: 'Событие-уведомление несёт только ID: подписчик сам ходит за деталями и снова зависит от источника. Перенос состояния кладёт в событие всё нужное: подписчик автономен, но событие тяжелее и его схему надо беречь.', c: [9, 10, 11] }
    ]
  };

  D.cqrs = {
    title: 'CQRS и event sourcing', icon: 'nosql', lede: 'Разные модели для записи и чтения, журнал событий вместо UPDATE.',
    actors: [
      { id: 'cmd', x: 20, y: 40, w: 150, label: 'Команды' },
      { id: 'w', x: 230, y: 40, w: 180, label: 'Модель записи', sub: 'журнал событий' },
      { id: 'bus', x: 230, y: 240, w: 180, label: 'Обработчики' },
      { id: 'r', x: 470, y: 240, w: 150, label: 'Проекция', sub: 'готово для экрана' },
      { id: 'q', x: 470, y: 40, w: 150, label: 'Запросы' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
# Команда: проверить правила и записать событие
def transfer(cmd):
    acc = load_account(cmd.account_id)        # состояние = свёртка событий
    if acc.balance < cmd.amount:
        raise InsufficientFunds()
    append_event("MoneyTransferred", cmd.account_id, amount=cmd.amount, version=acc.version + 1)

# Проекция: обновляется по событиям
def on_money_transferred(e):
    db.execute("UPDATE balances SET balance = balance - %s, version = %s WHERE id = %s AND version < %s",
               e.amount, e.version, e.account_id, e.version)

# Запрос: читаем готовое, без бизнес-логики
def get_balance(account_id):
    return db.fetchone("SELECT balance FROM balances WHERE id = %s", account_id)` }
    ],
    steps: [
      { title: 'Две модели', text: 'CQRS разделяет запись и чтение. Модель записи проверяет правила, модель чтения хранит данные так, как их показывает экран. Нагрузки и схемы у них разные.', hl: ['w', 'r'] },
      { title: 'Команда', text: 'Команда проверяет правила на модели записи. При event sourcing результат — новое событие в журнале, а не UPDATE строки. Журнал — это и история, и аудит.', msgs: [{ from: 'cmd', to: 'w', label: 'перевести 500 ₽' }], lines: { w: ['#56 Deposited 5000', '#57 MoneyTransferred 500'] }, c: [1, 2, 3, 4, 5, 6] },
      { title: 'Событие → проекция', text: 'Обработчики событий обновляют проекцию. Версия защищает от повторов и перестановок: старое событие не перезапишет новое.', msgs: [{ from: 'w', to: 'bus', label: 'MoneyTransferred' }, { from: 'bus', to: 'r', label: 'баланс −500' }], lines: { r: ['баланс 4 500, версия 57'] }, c: [8, 9, 10, 11] },
      { title: 'Запрос', text: 'Запрос читает готовую проекцию без бизнес-логики. Чтения масштабируются отдельно от записи.', good: ['r'], msgs: [{ from: 'q', to: 'r', label: 'баланс?' }, { from: 'r', to: 'q', label: '4 500 ₽', color: 'ok', lane: 1 }], c: [13, 14, 15] },
      { title: 'Отставание проекции', text: 'Проекция отстаёт от журнала на доли секунды. Чтобы пользователь сразу увидел свой перевод, ответ на команду возвращает новую версию, а чтение ждёт проекцию не старше неё.', badge: { r: '≈ 200 мс' } },
      { title: 'Когда не нужно', text: 'CQRS и event sourcing усложняют систему: два хранилища, события, согласованность в конечном счёте, версии схем событий. Оправданы, когда важна история или чтение и запись сильно расходятся. Для простого CRUD — лишнее.' }
    ]
  };

  D.hexagonal = {
    title: 'Гексагональная архитектура: порты и адаптеры', icon: 'app', lede: 'Как отделить бизнес-логику от фреймворков, баз и брокеров.',
    actors: [
      { id: 'core', x: 230, y: 120, w: 180, label: 'Домен', sub: 'правила заказа' },
      { id: 'in1', x: 20, y: 40, w: 160, label: 'REST-контроллер' },
      { id: 'in2', x: 20, y: 240, w: 160, label: 'Kafka-потребитель' },
      { id: 'out1', x: 460, y: 40, w: 160, label: 'PostgreSQL-адаптер' },
      { id: 'out2', x: 460, y: 240, w: 160, label: 'Платёжный адаптер' }
    ],
    code: [
      { label: 'Java', lang: 'java', src: `
// Порты: что нужно домену, без технологий
public interface PaymentGateway { PaymentResult charge(Money amount, CardToken card); }
public interface OrderRepository { Order byId(OrderId id); void save(Order order); }

// Домен (ядро) зависит только от портов
public class PlaceOrder {
    private final OrderRepository orders;
    private final PaymentGateway payments;
    public void handle(PlaceOrderCommand cmd) {
        Order order = orders.byId(cmd.orderId());
        payments.charge(order.total(), cmd.card());
        orders.save(order.markPaid());
    }
}

// Адаптеры: конкретные технологии снаружи
class YooKassaPaymentGateway implements PaymentGateway { /* HTTP-вызовы провайдера */ }
class InMemoryPaymentGateway implements PaymentGateway { /* для тестов */ }` }
    ],
    steps: [
      { title: 'Ядро', text: 'В центре — бизнес-логика: правила оформления заказа. Она не знает ни про HTTP, ни про SQL, ни про Kafka.', hl: ['core'], c: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
      { title: 'Порты', text: 'Порты — интерфейсы, через которые ядро говорит с миром: «сохранить заказ», «списать деньги». Зависимости направлены внутрь, к ядру.', c: [1, 2, 3] },
      { title: 'Входящие адаптеры', text: 'Контроллер превращает HTTP-запрос в вызов сценария ядра, потребитель — сообщение из Kafka. Один сценарий, разные входы.', msgs: [{ from: 'in1', to: 'core', label: 'PlaceOrder' }, { from: 'in2', to: 'core', label: 'PlaceOrder' }] },
      { title: 'Исходящие адаптеры', text: 'Адаптеры реализуют порты конкретной технологией. Сменить платёжного провайдера — написать новый адаптер, ядро не трогается.', msgs: [{ from: 'core', to: 'out1', label: 'save' }, { from: 'core', to: 'out2', label: 'charge' }], c: [16, 17] },
      { title: 'Тесты', text: 'Ядро тестируется без базы и сети: подставляем адаптеры в памяти, тесты быстрые и стабильные. Clean Architecture и Onion — та же идея с другими названиями слоёв.', good: ['core'], c: [18] }
    ]
  };

  D.strangler = {
    title: 'Strangler fig: замена монолита по частям', icon: 'gateway', lede: 'Как мигрировать с легаси без большого переписывания и без простоя.',
    actors: [
      { id: 'u', x: 20, y: 140, w: 140, label: 'Пользователи' },
      { id: 'px', x: 210, y: 140, w: 170, label: 'Прокси / шлюз' },
      { id: 'old', x: 450, y: 40, w: 170, label: 'Старый монолит' },
      { id: 'new', x: 450, y: 240, w: 170, label: 'Новый сервис' }
    ],
    code: [
      { label: 'nginx', lang: 'yaml', src: `
# Шаг 1: всё идёт в монолит
location / { proxy_pass http://legacy; }

# Шаг 2: новый сервис забирает один маршрут
location /api/orders { proxy_pass http://orders-service; }
location /           { proxy_pass http://legacy; }

# Шаг 3: постепенно каталог, оплата… монолит усыхает
# процент трафика: canary 5 % → 50 % → 100 %` }
    ],
    steps: [
      { title: 'Исходная точка', text: 'Переписать монолит целиком — годы и риск, который редко окупается. Паттерн «душитель» заменяет систему по кусочку, как фикус-душитель обвивает дерево.', msgs: [{ from: 'u', to: 'px', label: 'всё' }, { from: 'px', to: 'old', label: 'всё' }] },
      { title: 'Фасад', text: 'Сначала перед монолитом ставят прокси или API Gateway. Пользователи ничего не замечают, зато появилось место, где можно переключать маршруты.', hl: ['px'], c: [1, 2] },
      { title: 'Первый маршрут', text: 'Новый сервис забирает один маршрут — заказы. Данные на переходный период синхронизируются через CDC или двойную запись.', msgs: [{ from: 'px', to: 'new', label: '/api/orders', color: 'ok' }, { from: 'px', to: 'old', label: 'остальное' }], c: [4, 5, 6] },
      { title: 'Постепенный перевод', text: 'Трафик переводят по шагам: 5 %, 50 %, 100 %. Если метрики стали хуже, откатывают одним флагом.', c: [8, 9] },
      { title: 'Монолит усыхает', text: 'Маршрут за маршрутом функции уходят в новые сервисы, пока монолит не опустеет и его не выключат. Система работает всё время миграции.', dim: ['old'], good: ['new'], lines: { old: ['осталось 20 % функций'] } }
    ]
  };
})();
