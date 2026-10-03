/* Разборы, часть 1: основы. Номера строк в шагах (c) совпадают с кодом во вкладках. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const D = SD.DIVES;

  D.request = {
    title: 'Путь одного запроса', icon: 'client', lede: 'DNS, TLS, балансировщик, кэш, база и обратно — с цифрами задержки.',
    actors: [
      { id: 'user', x: 20, y: 140, w: 110, label: 'Браузер', sub: 'Москва' },
      { id: 'dns', x: 180, y: 24, w: 130, label: 'DNS', sub: 'резолвер' },
      { id: 'lb', x: 180, y: 140, w: 130, label: 'Балансировщик', sub: 'nginx' },
      { id: 'app', x: 350, y: 140, w: 120, label: 'Сервис', sub: 'экземпляр 2' },
      { id: 'cache', x: 505, y: 50, w: 120, label: 'Redis', sub: 'кэш' },
      { id: 'db', x: 505, y: 230, w: 120, label: 'PostgreSQL', sub: 'primary' }
    ],
    code: [
      { label: 'Python · FastAPI', lang: 'python', src: `
from fastapi import FastAPI, HTTPException
import redis.asyncio as redis, asyncpg, json

app = FastAPI()
cache = redis.Redis(host="redis")

@app.get("/users/{user_id}")
async def get_user(user_id: int):
    # 1. сначала кэш
    cached = await cache.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)
    # 2. промах — идём в базу
    row = await db.fetchrow(
        "SELECT id, name FROM users WHERE id = $1", user_id)
    if row is None:
        raise HTTPException(404, "Пользователь не найден")
    user = dict(row)
    # 3. кладём в кэш на 10 минут
    await cache.set(f"user:{user_id}", json.dumps(user), ex=600)
    return user` },
      { label: 'HTTP', lang: 'text', src: `
GET /users/42 HTTP/2
Host: api.shop.ru
Authorization: Bearer eyJhbGciOi...
Accept: application/json

HTTP/2 200
Content-Type: application/json
Cache-Control: private, max-age=0

{"id": 42, "name": "Анна"}` }
    ],
    steps: [
      { title: 'DNS: какой IP у api.shop.ru', text: 'Браузер спрашивает DNS, по какому адресу живёт домен. Ответ кэшируется на время TTL, поэтому обычно этот шаг занимает 0 мс.', hl: ['dns'], msgs: [{ from: 'user', to: 'dns', label: 'api.shop.ru?' }, { from: 'dns', to: 'user', label: '203.0.113.10', color: 'ok', lane: 1 }], lines: { dns: ['api.shop.ru → 203.0.113.10', 'TTL 300 с'] }, c: { 1: [2] } },
      { title: 'Соединение и TLS', text: 'Браузер открывает TCP-соединение и договаривается о шифровании. Это 1–2 круга по сети, поэтому соединения держат открытыми и переиспользуют (keep-alive, HTTP/2).', hl: ['lb'], msgs: [{ from: 'user', to: 'lb', label: 'TCP + TLS 1.3' }], c: { 1: [1, 2, 3] } },
      { title: 'Балансировщик выбирает экземпляр', text: 'Балансировщик берёт живой экземпляр сервиса и проксирует ему запрос. Экземпляры одинаковые, потому что не хранят состояние: сессия в токене, данные в базе.', hl: ['lb', 'app'], msgs: [{ from: 'lb', to: 'app', label: 'GET /users/42' }], lines: { lb: ['round robin', '→ экземпляр 2 из 3'] }, c: [7, 8] },
      { title: 'Промах в кэше', text: 'Сервис сначала смотрит в Redis. Ключа нет, значит промах. Запрос в Redis внутри дата-центра стоит доли миллисекунды.', hl: ['cache'], badge: { cache: 'MISS' }, msgs: [{ from: 'app', to: 'cache', label: 'GET user:42' }, { from: 'cache', to: 'app', label: 'nil', color: 'bad', lane: 1 }], c: [9, 10, 11, 12] },
      { title: 'Запрос в базу', text: 'Поиск по первичному ключу: индекс B-tree находит строку за 1–5 мс. Без индекса пришлось бы читать всю таблицу.', hl: ['db'], msgs: [{ from: 'app', to: 'db', label: 'SELECT … WHERE id=42' }, { from: 'db', to: 'app', label: 'строка', color: 'ok', lane: 1 }], c: [13, 14, 15, 16, 17, 18] },
      { title: 'Результат в кэш', text: 'Ответ кладём в Redis на 10 минут. Следующий запрос того же пользователя до базы не дойдёт.', hl: ['cache'], msgs: [{ from: 'app', to: 'cache', label: 'SET user:42 EX 600' }], lines: { cache: ['user:42 → {name: Анна}', 'TTL 600 с'] }, c: [19, 20] },
      { title: 'Ответ пользователю', text: 'Ответ идёт обратно тем же путём. Итог ≈ 25 мс сети + 12 мс сервиса + 6 мс базы. Повторный запрос обойдётся без базы и будет ещё быстрее.', good: ['user'], msgs: [{ from: 'app', to: 'lb', label: '200 OK' }, { from: 'lb', to: 'user', label: '200 OK · 43 мс', color: 'ok' }], c: { 0: [21], 1: [6, 7, 8, 9, 10] } }
    ]
  };

  D.lb = {
    title: 'Балансировщик и health checks', icon: 'lb', lede: 'Round robin, least connections, исключение упавших и повтор на другом сервере.',
    actors: [
      { id: 'user', x: 20, y: 140, w: 110, label: 'Клиенты' },
      { id: 'lb', x: 190, y: 140, w: 140, label: 'Балансировщик', sub: 'api.shop.ru:443' },
      { id: 's1', x: 420, y: 30, w: 140, label: 'Сервер 1' },
      { id: 's2', x: 420, y: 140, w: 140, label: 'Сервер 2' },
      { id: 's3', x: 420, y: 250, w: 140, label: 'Сервер 3' }
    ],
    code: [
      { label: 'nginx', lang: 'text', src: `
upstream api {
    least_conn;                 # кто свободнее
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.13:8080 max_fails=3 fail_timeout=10s;
    keepalive 64;               # держим соединения открытыми
}

server {
    listen 443 ssl http2;
    location / {
        proxy_pass http://api;
        proxy_next_upstream error timeout http_502 http_503;
        proxy_connect_timeout 1s;
        proxy_read_timeout 5s;
    }
}` },
      { label: 'JavaScript', lang: 'js', src: `
class Balancer {
  constructor(servers) { this.servers = servers; this.i = 0; }

  // Round robin: по кругу
  roundRobin() {
    const alive = this.servers.filter(s => s.healthy);
    const s = alive[this.i++ % alive.length];
    return s;
  }

  // Least connections: у кого меньше активных запросов
  leastConn() {
    const alive = this.servers.filter(s => s.healthy);
    return alive.reduce((a, b) => (a.active <= b.active ? a : b));
  }

  // Health check раз в 2 секунды
  async check() {
    for (const s of this.servers) {
      s.healthy = await fetch(s.url + '/health').then(r => r.ok).catch(() => false);
    }
  }
}` }
    ],
    steps: [
      { title: 'Один адрес на всех', text: 'Пользователи знают только адрес балансировщика. Сколько за ним серверов и какие из них живы, клиенту неважно.', hl: ['lb'], msgs: [{ from: 'user', to: 'lb', label: 'HTTPS :443' }], c: { 0: [9, 10, 11, 12] } },
      { title: 'Round robin', text: 'Запросы раздаются по кругу: 1, 2, 3, 1, 2, 3. Просто и ровно, пока запросы примерно одинаковые.', msgs: [{ from: 'lb', to: 's1', label: 'запрос 1' }, { from: 'lb', to: 's2', label: 'запрос 2' }, { from: 'lb', to: 's3', label: 'запрос 3' }], lines: { s1: ['активных: 1'], s2: ['активных: 1'], s3: ['активных: 1'] }, c: { 1: [4, 5, 6, 7, 8, 9] } },
      { title: 'Least connections', text: 'Запросы бывают долгими: отчёт считается 2 секунды, профиль — 10 мс. Least connections отправляет новый запрос туда, где меньше активных.', hl: ['s2'], msgs: [{ from: 'lb', to: 's2', label: 'новый запрос' }], lines: { s1: ['активных: 12'], s2: ['активных: 3'], s3: ['активных: 9'] }, c: { 0: [2], 1: [11, 12, 13, 14, 15] } },
      { title: 'Health check', text: 'Балансировщик регулярно опрашивает /health. Сервер 3 не ответил три раза подряд.', bad: ['s3'], badge: { s3: 'FAIL' }, msgs: [{ from: 'lb', to: 's3', label: 'GET /health', color: 'bad' }], c: { 0: [3, 4, 5], 1: [17, 18, 19, 20, 21] } },
      { title: 'Упавший исключается', text: 'Трафик делится между живыми серверами. Поэтому их держат с запасом: при правиле N+1 оставшиеся выдерживают всю нагрузку.', dim: ['s3'], msgs: [{ from: 'lb', to: 's1', label: '50 %' }, { from: 'lb', to: 's2', label: '50 %' }], lines: { s3: ['исключён из раздачи'] }, c: { 1: [6, 13] } },
      { title: 'Повтор на другом сервере', text: 'Если запрос упал на полпути, nginx повторит его на соседнем сервере. Это безопасно только для идемпотентных запросов: GET, PUT, DELETE. POST без ключа идемпотентности может выполниться дважды.', msgs: [{ from: 'lb', to: 's3', label: 'запрос', color: 'bad' }, { from: 'lb', to: 's1', label: 'повтор', color: 'ok' }], c: { 0: [13, 14, 15] } }
    ]
  };

  D.cache = {
    title: 'Кэш: cache-aside, инвалидация, stampede', icon: 'cache', lede: 'Как кэш снимает 95 % чтений с базы и как он же может её уронить.',
    actors: [
      { id: 'app', x: 40, y: 140, w: 140, label: 'Сервис' },
      { id: 'cache', x: 330, y: 40, w: 220, label: 'Redis', sub: 'кэш в памяти' },
      { id: 'db', x: 330, y: 220, w: 220, label: 'PostgreSQL', sub: 'источник правды' }
    ],
    code: [
      { label: 'Python', lang: 'python', src: `
import json, time, redis
r = redis.Redis()

def get_product(pid):
    key = f"product:{pid}"
    hit = r.get(key)                      # 1. смотрим в кэш
    if hit:
        return json.loads(hit)            # попадание: < 1 мс
    row = db.query("SELECT * FROM products WHERE id=%s", pid)
    r.set(key, json.dumps(row), ex=600)   # 2. кладём с TTL
    return row

def update_price(pid, price):
    db.execute("UPDATE products SET price=%s WHERE id=%s", price, pid)
    r.delete(f"product:{pid}")            # 3. инвалидация после записи

def get_product_safe(pid):
    key = f"product:{pid}"
    hit = r.get(key)
    if hit:
        return json.loads(hit)
    # 4. single-flight: в базу идёт только тот, кто взял замок
    if r.set(f"lock:{key}", 1, nx=True, ex=5):
        row = db.query("SELECT * FROM products WHERE id=%s", pid)
        r.set(key, json.dumps(row), ex=600)
        r.delete(f"lock:{key}")
        return row
    time.sleep(0.05)                      # остальные ждут и читают кэш
    return get_product_safe(pid)` }
    ],
    steps: [
      { title: 'Промах', text: 'Сервис ищет товар в Redis. Ключа нет.', badge: { cache: 'MISS' }, msgs: [{ from: 'app', to: 'cache', label: 'GET product:7' }, { from: 'cache', to: 'app', label: 'nil', color: 'bad', lane: 1 }], c: [4, 5, 6, 7] },
      { title: 'Чтение из базы', text: 'На промахе сервис идёт в базу. Это в 10–50 раз дольше, чем чтение из памяти.', hl: ['db'], msgs: [{ from: 'app', to: 'db', label: 'SELECT …' }, { from: 'db', to: 'app', label: 'строка', color: 'ok', lane: 1 }], c: [9] },
      { title: 'Сохранение с TTL', text: 'Результат кладётся в кэш с временем жизни. TTL — страховка: даже если инвалидация не сработает, устаревшее значение проживёт не дольше 10 минут.', hl: ['cache'], msgs: [{ from: 'app', to: 'cache', label: 'SET … EX 600' }], lines: { cache: ['product:7 → {price: 990}', 'TTL 600 с'] }, c: [10, 11] },
      { title: 'Попадание', text: 'Следующие запросы получают ответ из памяти. Hit ratio 95 % значит, что база видит только каждый двадцатый запрос.', badge: { cache: 'HIT' }, dim: ['db'], msgs: [{ from: 'app', to: 'cache', label: 'GET product:7' }, { from: 'cache', to: 'app', label: '{price: 990}', color: 'ok', lane: 1 }], c: [6, 7, 8] },
      { title: 'Инвалидация', text: 'При смене цены сначала пишем в базу, затем удаляем ключ. Следующее чтение подтянет свежее значение. Обновлять ключ вместо удаления опаснее: две конкурентные записи могут оставить в кэше старую цену.', msgs: [{ from: 'app', to: 'db', label: 'UPDATE price=890' }, { from: 'app', to: 'cache', label: 'DEL product:7', color: 'warn' }], lines: { cache: ['product:7 удалён'] }, c: [13, 14, 15] },
      { title: 'Cache stampede', text: 'Ключ популярного товара истёк, и 500 запросов одновременно промахнулись и пошли в базу. База падает от пустяка. То же случается, когда падает весь кэш.', bad: ['db'], badge: { db: '×500' }, msgs: [{ from: 'app', to: 'db', label: 'запрос 1', color: 'bad', lane: -1 }, { from: 'app', to: 'db', label: '…', color: 'bad' }, { from: 'app', to: 'db', label: 'запрос 500', color: 'bad', lane: 1 }], lines: { cache: ['product:7 истёк'] }, c: [4, 5, 6, 9] },
      { title: 'Single-flight', text: 'Защита: замок в Redis (SET NX). В базу идёт один запрос, остальные 50 мс ждут и читают уже заполненный кэш. Другие способы: случайный разброс TTL и фоновое обновление до истечения.', good: ['db'], msgs: [{ from: 'app', to: 'cache', label: 'SET lock NX' }, { from: 'app', to: 'db', label: '1 запрос', color: 'ok' }], lines: { cache: ['lock:product:7', 'product:7 → {price: 890}'] }, c: [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] }
    ]
  };

  D.cdn = {
    title: 'CDN: статика рядом с пользователем', icon: 'cdn', lede: 'Промах, попадание, Cache-Control и версии файлов.',
    actors: [
      { id: 'u1', x: 20, y: 50, w: 150, label: 'Пользователь', sub: 'Москва' },
      { id: 'u2', x: 20, y: 230, w: 150, label: 'Пользователь', sub: 'Новосибирск' },
      { id: 'e1', x: 240, y: 50, w: 150, label: 'Край CDN', sub: 'Москва' },
      { id: 'e2', x: 240, y: 230, w: 150, label: 'Край CDN', sub: 'Новосибирск' },
      { id: 'o', x: 470, y: 140, w: 150, label: 'S3', sub: 'источник, Франкфурт' }
    ],
    code: [
      { label: 'Заголовки', lang: 'yaml', src: `
# Ответ источника
HTTP/2 200
Content-Type: image/webp
Cache-Control: public, max-age=86400, immutable
ETag: "a1f3c9"

# Ответ края CDN при попадании
HTTP/2 200
Age: 3127
X-Cache: HIT

# Имя файла с хэшем: новая версия — новый URL
/static/app.3f9a1c.js` },
      { label: 'Сброс кэша', lang: 'js', src: `
// После деплоя сбросить старую версию на всех краях
await fetch(\`https://api.cloudflare.com/client/v4/zones/\${ZONE}/purge_cache\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${TOKEN}\` },
  body: JSON.stringify({ files: ['https://cdn.shop.ru/img/banner.webp'] })
});` }
    ],
    steps: [
      { title: 'Первый запрос: промах', text: 'Пользователь в Москве просит картинку. На ближайшем краю её нет, и CDN идёт в источник по своей магистрали.', badge: { e1: 'MISS' }, msgs: [{ from: 'u1', to: 'e1', label: 'GET /img/7.webp' }, { from: 'e1', to: 'o', label: 'в источник' }, { from: 'o', to: 'e1', label: '200, max-age=86400', color: 'ok', lane: 1 }], c: { 0: [1, 2, 3, 4, 5] } },
      { title: 'Копия на краю', text: 'Край сохраняет файл на время из Cache-Control. Этот запрос был медленным: ≈ 180 мс.', hl: ['e1'], msgs: [{ from: 'e1', to: 'u1', label: '200 · 180 мс' }], lines: { e1: ['7.webp, живёт 24 ч'] }, c: { 0: [4] } },
      { title: 'Попадание', text: 'Все следующие пользователи поблизости получают файл за 12 мс. Источник этих запросов не видит.', badge: { e1: 'HIT' }, dim: ['o'], msgs: [{ from: 'u1', to: 'e1', label: 'GET' }, { from: 'e1', to: 'u1', label: 'HIT · 12 мс', color: 'ok', lane: 1 }], c: { 0: [7, 8, 9, 10] } },
      { title: 'У каждого края свой кэш', text: 'В Новосибирске первый запрос тоже промахнётся. Поэтому hit ratio растёт вместе с популярностью файла и временем жизни.', badge: { e2: 'MISS' }, msgs: [{ from: 'u2', to: 'e2', label: 'GET /img/7.webp' }, { from: 'e2', to: 'o', label: 'в источник' }] },
      { title: 'Как обновить файл', text: 'Лучший способ — новый URL с хэшем содержимого: старая версия просто перестанет запрашиваться. Сброс кэша через API тоже работает, но расходится по краям за секунды.', hl: ['e1', 'e2'], c: { 0: [12, 13], 1: [1, 2, 3, 4, 5, 6] } }
    ]
  };

  D.objstore = {
    title: 'Загрузка в S3 по presigned URL', icon: 'objstore', lede: 'Файл идёт мимо сервиса, а обработка запускается событием.',
    actors: [
      { id: 'client', x: 20, y: 130, w: 130, label: 'Приложение' },
      { id: 'app', x: 230, y: 24, w: 160, label: 'Сервис' },
      { id: 's3', x: 470, y: 130, w: 150, label: 'S3', sub: 'бакет media' },
      { id: 'q', x: 470, y: 260, w: 150, label: 'Очередь', sub: 'события S3' },
      { id: 'w', x: 230, y: 260, w: 160, label: 'Обработчик', sub: 'перекодирование' }
    ],
    code: [
      { label: 'Python · boto3', lang: 'python', src: `
import boto3, uuid
s3 = boto3.client("s3")

@app.post("/uploads")
def create_upload(user):
    key = f"raw/{user.id}/{uuid.uuid4()}.mp4"
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": "media", "Key": key, "ContentType": "video/mp4"},
        ExpiresIn=300)                       # ссылка живёт 5 минут
    db.execute("INSERT INTO uploads(key, user_id, status) VALUES (%s, %s, 'pending')", key, user.id)
    return {"url": url, "key": key}

# Обработчик события ObjectCreated из очереди
def on_object_created(event):
    key = event["Records"][0]["s3"]["object"]["key"]
    transcode(key)                           # 20 с CPU — в фоне
    db.execute("UPDATE uploads SET status='ready' WHERE key=%s", key)` }
    ],
    steps: [
      { title: 'Запрос разрешения', text: 'Приложение не отправляет файл сервису. Оно просит разрешение на загрузку.', msgs: [{ from: 'client', to: 'app', label: 'POST /uploads' }], c: [4, 5, 6] },
      { title: 'Подписанная ссылка', text: 'Сервис подписывает ссылку своим ключом: «можно положить один файл с таким именем в течение 5 минут». Через сервис проходит только этот маленький ответ.', hl: ['app'], msgs: [{ from: 'app', to: 'client', label: 'presigned URL' }], lines: { app: ['подпись HMAC', 'raw/42/9f1c.mp4', 'истекает через 300 с'] }, c: [7, 8, 9, 10, 11, 12] },
      { title: 'Загрузка напрямую', text: 'Приложение грузит 500 МБ прямо в S3. Сервис не тратит на это ни поток, ни канал. S3 сам проверяет подпись и срок.', dim: ['app'], msgs: [{ from: 'client', to: 's3', label: 'PUT 500 МБ', color: 'var(--k-upload)' }] },
      { title: 'Событие о новом файле', text: 'S3 сам публикует событие ObjectCreated в очередь. Никто не опрашивает бакет в цикле.', hl: ['q'], msgs: [{ from: 's3', to: 'q', label: 'ObjectCreated' }], c: [14, 15, 16] },
      { title: 'Обработка в фоне', text: 'Обработчик забирает событие, перекодирует видео и кладёт результат обратно в S3. Статус в базе меняется на ready, пользователь видит готовое видео.', good: ['w'], msgs: [{ from: 'q', to: 'w', label: 'событие' }, { from: 'w', to: 's3', label: 'PUT 1080p, 720p', color: 'job' }], c: [17, 18] }
    ]
  };

  D.ratelimit = {
    title: 'Rate limiter: token bucket', icon: 'gateway', lede: 'Ведро токенов в Redis, атомарный Lua-скрипт и ответ 429.',
    actors: [
      { id: 'client', x: 20, y: 140, w: 120, label: 'Клиент', sub: 'API-ключ k_42' },
      { id: 'gw', x: 220, y: 140, w: 150, label: 'API Gateway' },
      { id: 'redis', x: 450, y: 30, w: 170, label: 'Redis', sub: 'ведро rl:k_42' },
      { id: 'app', x: 450, y: 240, w: 170, label: 'Сервис' }
    ],
    code: [
      { label: 'Lua в Redis', lang: 'lua', src: `
-- KEYS[1] — ведро клиента; ARGV: ёмкость, скорость, сейчас
local cap, rate, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
-- пополняем ведро за прошедшее время
tokens = math.min(cap, tokens + (now - ts) * rate)
if tokens < 1 then
  return 0                                  -- отказ: 429
end
redis.call('HMSET', KEYS[1], 'tokens', tokens - 1, 'ts', now)
redis.call('EXPIRE', KEYS[1], 60)
return 1                                    -- пропускаем` },
      { label: 'Python', lang: 'python', src: `
allow = redis.register_script(LUA)

@app.middleware("http")
async def rate_limit(request, call_next):
    key = f"rl:{request.headers.get('X-Api-Key') or request.client.host}"
    ok = await allow(keys=[key], args=[20, 10, time.time()])   # 20 в запасе, 10/с
    if not ok:
        return JSONResponse({"error": "too many requests"}, status_code=429,
                            headers={"Retry-After": "1"})
    return await call_next(request)` }
    ],
    steps: [
      { title: 'Ведро токенов', text: 'У каждого клиента своё ведро. Оно пополняется с постоянной скоростью, но не выше ёмкости. Ёмкость разрешает короткие всплески, скорость задаёт средний лимит.', hl: ['redis'], lines: { redis: ['ёмкость 20', 'пополнение 10/с', '●●●●●●●●●●●●●●●●●●●●'] }, c: { 0: [1, 2] } },
      { title: 'Обычный запрос', text: 'Шлюз выполняет скрипт в Redis: пополнить ведро, взять токен. Токен есть — запрос идёт в сервис.', msgs: [{ from: 'client', to: 'gw', label: 'GET /items' }, { from: 'gw', to: 'redis', label: 'EVALSHA' }, { from: 'redis', to: 'gw', label: '1', color: 'ok', lane: 1 }, { from: 'gw', to: 'app', label: 'пропустить', color: 'ok' }], lines: { redis: ['ёмкость 20', 'пополнение 10/с', '●●●●●●●●●●●●●●●●●●●○'] }, c: { 0: [3, 4, 5, 6, 7, 11, 12, 13], 1: [4, 5, 6] } },
      { title: 'Всплеск', text: 'Клиент прислал 20 запросов разом. Ведро опустело, но всё прошло: это разрешённый всплеск.', msgs: [{ from: 'client', to: 'gw', label: '×20 за 100 мс' }], lines: { redis: ['ёмкость 20', 'пополнение 10/с', 'токенов: 0'] } },
      { title: 'Отказ 429', text: 'Токенов нет. Шлюз отвечает 429 с заголовком Retry-After. Запрос не дошёл ни до сервиса, ни до базы: отказ стоит микросекунды.', badge: { gw: '429' }, dim: ['app'], msgs: [{ from: 'client', to: 'gw', label: 'ещё запрос' }, { from: 'gw', to: 'client', label: '429 Retry-After: 1', color: 'bad', lane: 1 }], c: { 0: [8, 9, 10], 1: [7, 8, 9] } },
      { title: 'Пополнение', text: 'Через секунду в ведре снова 10 токенов. Честный клиент почти не замечает лимит, бот упирается в 10 запросов в секунду.', lines: { redis: ['ёмкость 20', 'пополнение 10/с', 'через 1 с: ●●●●●●●●●●'] }, c: { 0: [6, 7] } },
      { title: 'Почему Lua', text: 'Чтение, пересчёт и запись должны быть атомарны. Иначе два экземпляра шлюза одновременно прочитают «1 токен» и пропустят оба запроса. Lua-скрипт выполняется в Redis целиком.', hl: ['redis'], c: { 0: [3, 7, 11] } }
    ]
  };

  D.websocket = {
    title: 'WebSocket и pub/sub', icon: 'ws', lede: 'Как сообщение находит получателя на другом сервере.',
    actors: [
      { id: 'alice', x: 20, y: 40, w: 120, label: 'Алиса' },
      { id: 'bob', x: 20, y: 250, w: 120, label: 'Борис' },
      { id: 'ws1', x: 220, y: 40, w: 160, label: 'WS-сервер 1' },
      { id: 'ws2', x: 220, y: 250, w: 160, label: 'WS-сервер 2' },
      { id: 'bus', x: 460, y: 145, w: 160, label: 'Redis Pub/Sub', sub: 'шина между серверами' },
      { id: 'db', x: 460, y: 20, w: 160, label: 'Cassandra', sub: 'история' }
    ],
    code: [
      { label: 'Node.js', lang: 'js', src: `
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const pub = new Redis(), sub = new Redis();
const wss = new WebSocketServer({ port: 8080 });
const local = new Map();                    // userId → сокет на ЭТОМ сервере

wss.on('connection', (ws, req) => {
  const userId = auth(req);
  local.set(userId, ws);
  ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    await cassandra.execute(                  // 1. сохранить историю
      'INSERT INTO messages (chat_id, ts, from_id, text) VALUES (?, ?, ?, ?)',
      [msg.chatId, Date.now(), userId, msg.text]);
    pub.publish(\`user:\${msg.to}\`, raw);      // 2. отдать в шину
  });
});

sub.psubscribe('user:*');
sub.on('pmessage', (_, channel, raw) => {   // 3. сообщение для кого-то
  const ws = local.get(channel.slice(5));
  if (ws) ws.send(raw);                      // получатель у нас — доставляем
});` }
    ],
    steps: [
      { title: 'Постоянные соединения', text: 'Каждый клиент держит открытое соединение с одним из серверов. Алиса попала на первый, Борис на второй.', msgs: [{ from: 'alice', to: 'ws1', label: 'WebSocket' }, { from: 'bob', to: 'ws2', label: 'WebSocket' }], lines: { ws1: ['онлайн: Алиса'], ws2: ['онлайн: Борис'] }, c: [8, 9, 10] },
      { title: 'Сообщение', text: 'Алиса пишет Борису. Сообщение приходит на первый сервер.', msgs: [{ from: 'alice', to: 'ws1', label: '«Привет»' }], c: [11, 12] },
      { title: 'Сохранение', text: 'Сначала сообщение пишется в историю. Cassandra держит такой поток записей: партиция — чат, внутри сортировка по времени.', hl: ['db'], msgs: [{ from: 'ws1', to: 'db', label: 'INSERT' }], c: [13, 14, 15] },
      { title: 'Где Борис?', text: 'Борис подключён к другому серверу. Первый сервер не знает его сокета и сам доставить сообщение не может.', bad: ['ws1'], badge: { ws1: 'Бориса нет' }, c: [6] },
      { title: 'Шина pub/sub', text: 'Сервер публикует сообщение в канал получателя. Все серверы подписаны на шину, и сообщение получает тот, у кого Борис.', hl: ['bus'], msgs: [{ from: 'ws1', to: 'bus', label: 'PUBLISH user:boris' }, { from: 'bus', to: 'ws2', label: 'pmessage' }], c: [16, 20, 21] },
      { title: 'Доставка', text: 'Второй сервер находит Бориса среди своих соединений и отправляет. Вся доставка ≈ 10 мс.', good: ['bob'], msgs: [{ from: 'ws2', to: 'bob', label: '«Привет»', color: 'ok' }], c: [22, 23] }
    ]
  };

  D.search = {
    title: 'Поиск: обратный индекс', icon: 'search', lede: 'Почему поисковый движок быстрее LIKE в тысячи раз.',
    actors: [
      { id: 'docs', x: 20, y: 24, w: 230, label: 'Документы' },
      { id: 'idx', x: 380, y: 24, w: 240, label: 'Обратный индекс', sub: 'слово → документы' },
      { id: 'q', x: 20, y: 240, w: 170, label: 'Запрос' },
      { id: 'es', x: 230, y: 240, w: 180, label: 'Поиск' },
      { id: 'res', x: 450, y: 240, w: 170, label: 'Результат' }
    ],
    code: [
      { label: 'JavaScript', lang: 'js', src: `
const docs = {
  1: 'красный зимний пуховик',
  2: 'зимние ботинки на меху',
  3: 'красные кроссовки',
};

// Индексация: слово → список документов
const index = new Map();
for (const [id, text] of Object.entries(docs)) {
  for (const word of tokenize(text)) {          // «зимние» → «зимн»
    if (!index.has(word)) index.set(word, new Set());
    index.get(word).add(Number(id));
  }
}

// Поиск: пересечение списков, без перебора документов
function search(q) {
  const lists = tokenize(q).map(w => index.get(w) || new Set());
  return [...lists.reduce((a, b) => new Set([...a].filter(x => b.has(x))))];
}

search('красный зимний');   // → [1]` },
      { label: 'SQL', lang: 'sql', src: `
-- Так ищут без поискового движка: полный перебор таблицы
SELECT * FROM products WHERE title LIKE '%зимн%';

-- B-tree индекс по title не поможет: шаблон начинается с %
-- 10 млн строк = 10 млн сравнений на каждый запрос` }
    ],
    steps: [
      { title: 'Документы', text: 'Три товара. В реальности их миллионы.', hl: ['docs'], lines: { docs: ['1: красный зимний пуховик', '2: зимние ботинки на меху', '3: красные кроссовки'] }, c: { 0: [1, 2, 3, 4, 5] } },
      { title: 'Токенизация', text: 'Текст режется на слова и приводится к основе: «зимние» и «зимний» → «зимн». Так находятся разные формы слова.', msgs: [{ from: 'docs', to: 'idx', label: 'слова → основы' }], c: { 0: [9, 10] } },
      { title: 'Индекс', text: 'Для каждой основы хранится список документов. Индекс строится один раз и обновляется при изменениях.', hl: ['idx'], lines: { idx: ['красн → 1, 3', 'зимн → 1, 2', 'пуховик → 1', 'ботинк → 2', 'кроссовк → 3'] }, c: { 0: [7, 8, 11, 12] } },
      { title: 'Запрос', text: 'Пользователь ищет «красный зимний». Запрос тоже разбивается на основы.', msgs: [{ from: 'q', to: 'es', label: '«красный зимний»' }], lines: { q: ['красный зимний'] }, c: { 0: [17, 18] } },
      { title: 'Пересечение списков', text: 'Движок берёт два коротких списка и пересекает их. Документы целиком не читаются.', hl: ['es', 'idx'], msgs: [{ from: 'es', to: 'idx', label: 'красн, зимн' }, { from: 'idx', to: 'es', label: '{1,3} и {1,2}', color: 'ok', lane: 1 }], lines: { es: ['{1, 3} ∩ {1, 2} = {1}'] }, c: { 0: [19] } },
      { title: 'Результат', text: 'Найдено за миллисекунды. Дальше движок сортирует по релевантности (BM25) и подсвечивает совпадения.', good: ['res'], msgs: [{ from: 'es', to: 'res', label: 'документ 1', color: 'ok' }], lines: { res: ['красный зимний пуховик'] }, c: { 0: [22] } },
      { title: 'А если через LIKE', text: 'LIKE с процентом в начале читает каждую строку таблицы. На 10 млн товаров это секунды на запрос и упавшая база при 100 поисках в секунду.', bad: ['es'], c: { 1: [1, 2, 3, 4, 5] } }
    ]
  };
})();
