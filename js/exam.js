/* Экзамен: собеседование по системному дизайну по этапам — как на настоящем интервью.
   1) Требования: вопросы «заказчику» с ответами из кейса, функциональные и нефункциональные требования.
   2) Оценка нагрузки: средний и пиковый RPS, доля чтений, серверы, объём — сверка с js/calc.js (±30 %).
   3) API: основные вызовы в коротком конструкторе — метод, ответ, свойства; сверка по смыслу.
   4) Схема: собирается на площадке, как в свободном режиме; оценка — SD.free.evaluate (100 баллов).
   5) Углубление: «что будет, если…» под схему ученика — отказ узла (хаос), ×10 нагрузки (множитель),
      горячий ключ (столько же запросов, но половина — про одну запись). Ответ проверяет симулятор.
   Рубрика по каждому этапу: ниже ожиданий / джун / мидл / сеньор. Отчёт: сильные стороны, что подтянуть
   (лаборатории, уровни, «Мой путь»), итоговый уровень, экспорт в Markdown со схемой (Mermaid или C4),
   история в localStorage. Вход: SD.exam.open(), Ctrl+K (SD.cmdExtra), кнопка в свободном режиме.
   Стили .ex- — в отдельном CSS-блоке. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt, T = () => SD.TYPES;
  const nm = n => n ? (n.label || (T()[n.type] ? T()[n.type].name : n.type)) : '';
  const copy = v => JSON.parse(JSON.stringify(v));
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const toast = m => { if (SD.app && SD.app.toast) SD.app.toast(m); };
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  /* ---------- детерминированный случай: варианты перемешаны одинаково для одного кейса ---------- */
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* ---------- числа ---------- */
  const big = v => v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',').replace(',0', '') + ' млрд' : v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' млн' : Math.round(v).toLocaleString('ru-RU');
  const fx = v => v < 10 ? (Math.round(v * 10) / 10).toString().replace('.', ',') : Math.round(v).toLocaleString('ru-RU');
  const fmtAns = v => v >= 100 ? Math.round(v).toLocaleString('ru-RU') : v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString().replace('.', ',');
  function parse(s) {
    s = String(s || '').trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
    const m = s.match(/^([0-9.]+)(к|k|тыс|млн|m|млрд|b)?/); if (!m) return NaN;
    return parseFloat(m[1]) * ({ 'к': 1e3, k: 1e3, 'тыс': 1e3, 'млн': 1e6, m: 1e6, 'млрд': 1e9, b: 1e9 }[m[2]] || 1);
  }
  /* ±30 % — засчитано, в пределах ×3 — порядок верный (половина), дальше — мимо */
  function grade(g, a) {
    if (!(g > 0) || !(a > 0)) return 'miss';
    if (Math.abs(g / a - 1) <= 0.3) return 'ok';
    return Math.abs(Math.log10(g / a)) <= 0.48 ? 'order' : 'miss';
  }
  const GS = { ok: 1, order: 0.5, miss: 0 };
  const ESTN = { avg: 'средний RPS', peak: 'пиковый RPS', ratio: 'чтений на запись', app: 'серверы приложения', vol: 'объём за год' };
  const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

  /* ---------- этапы и уровни ---------- */
  const ST = [
    { id: 'req', title: 'Требования', min: 5 },
    { id: 'est', title: 'Оценка нагрузки', min: 5 },
    { id: 'api', title: 'API', min: 5 },
    { id: 'hld', title: 'Схема', min: 15 },
    { id: 'deep', title: 'Углубление', min: 8 }
  ];
  const WT = { req: 0.15, est: 0.15, api: 0.15, hld: 0.35, deep: 0.2 };
  const LV = [
    { id: 'below', name: 'Ниже ожиданий', cls: 'b' },
    { id: 'junior', name: 'Джун', cls: 'j' },
    { id: 'middle', name: 'Мидл', cls: 'm' },
    { id: 'senior', name: 'Сеньор', cls: 's' }
  ];
  const lvIdx = s => s >= 0.8 ? 3 : s >= 0.6 ? 2 : s >= 0.4 ? 1 : 0;
  /* у схемы пороги свои — как в разборе свободного режима: даже нерабочая схема получает баллы за цену и паттерны */
  const lvOf = (sid, s) => sid === 'hld' ? (s >= 0.85 ? 3 : s >= 0.7 ? 2 : s >= 0.55 ? 1 : 0) : lvIdx(s);
  /* сначала бытовая фраза «как это будет на собеседовании», потом что делать */
  const LIFE = {
    req: ['Интервьюер даёт задачу одной строкой и ждёт, что ты сначала спросишь. Как прораб: прежде чем рисовать дом, узнаёт, сколько в нём жильцов и какой бюджет.', 'Спроси заказчика, отметь, что система должна делать, и зафиксируй числа: нагрузку, время ответа, доступность, бюджет. Ответы приходят только на заданные вопросы.'],
    est: ['«Прикинь на салфетке, сколько это в секунду». Точности никто не ждёт — ждут порядок величины и понятную цепочку, как при подсчёте касс к вечернему часу пик.', 'Впиши оценки. Засчитывается ±30 % от расчёта «Как посчитать», порядок величины (в пределах ×3) — наполовину. Можно писать «15к», «2,5 млн».'],
    api: ['«Какие вызовы будут у системы?» Это как меню в кафе: в нём не всё, что умеет кухня, а то, что заказывают гости.', 'Отметь, какие вызовы нужны в первой версии, и собери каждый: метод, ответ и свойства. Сверяю по смыслу, без строгого синтаксиса.'],
    hld: ['Рисуешь схему на доске и проводишь по ней запрос. Здесь доска — площадка, а проверяет её симулятор, как сантехник, который пускает воду и смотрит, где течёт.', 'Палитра полная, подсказок и эталона нет — как в свободном режиме. Когда готово — «Готово — оценить схему»: оценка на 100 баллов по требованиям, запасу, надёжности, цене и архитектуре.'],
    deep: ['«А что будет, если…?» Интервьюер проверяет, знаешь ли ты свою схему, — как водитель, который понимает, как машина поведёт себя на льду.', 'Предскажи, что случится с твоей схемой. Ответ проверяю прогоном симулятора: роняю узел, умножаю нагрузку, делаю один ключ горячим.']
  };
  const RUB = {
    req: ['Сразу рисует, не спросив про нагрузку и требования, — как строить дом, не узнав, сколько в нём будет жильцов.',
      'Спросил часть важного, но пропустил что-то из нагрузки, времени ответа, доступности или бюджета; в требования попало лишнее.',
      'Выяснил главное и отделил основное от лишнего, но одно-два числа угадал, а не спросил.',
      'Спросил про масштаб, время ответа, доступность и бюджет, отсёк лишнее и зафиксировал числа — по ним дальше можно считать.'],
    est: ['Числа мимо на порядок или не посчитаны — непонятно, сколько нужно серверов.',
      'Порядок величины в целом верный, но точности не хватает или пропущены шаги — пик, объём, серверы.',
      'Большинство чисел в пределах ±30 %, видна цепочка: пользователи → запросы в секунду → пик.',
      'Все числа в пределах ±30 %, включая объём и число серверов: на такой расчёт можно опирать схему.'],
    api: ['Методы перепутаны или не выбраны главные вызовы.',
      'Методы в основном верные, но без идемпотентности, курсоров и асинхронных ответов; в API попало лишнее.',
      'Верные методы и ответы, часть свойств надёжного API учтена.',
      'Только нужные вызовы, верные методы и коды, идемпотентность записи, курсоры для списков, «принято» для долгого.'],
    hld: ['Схема не держит нагрузку или требования кейса.',
      'Схема работает, но есть единые точки отказа, нет запаса или она дорогая.',
      'Держит требования с запасом; мелкие риски по цене или надёжности.',
      'Держит требования, рост в полтора-два раза и падение узла; по цене близко к эталону.'],
    deep: ['Пока не получается предсказать, как поведёт себя своя же схема при сбое и росте.',
      'Часть сценариев угадана; схема ломается от первого же сбоя.',
      'Поведение схемы предсказано верно, но защищено в ней не всё.',
      'Знает, что и при каком росте сломается первым, и схема переживает отказ узла и горячий ключ.']
  };
  const VOICE = [
    'Пока ниже ожиданий — и это нормальная точка старта. Ниже — что подтянуть в первую очередь, по шагам.',
    'Как джун: основа есть, но важные вещи интервьюеру пришлось бы вытягивать вопросами.',
    'Уверенный мидл: решение рабочее и объяснённое, в паре мест интервьюер подтолкнул бы.',
    'Как сеньор: ты сам ведёшь разговор, считаешь и защищаешь решения — интервьюер бы просто кивал.'
  ];

  /* ---------- хранилище ---------- */
  const KEY = 'amp-stroyka-exam-v1';
  const S = { cur: null, hist: [], noTimer: false };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  if (!Array.isArray(S.hist)) S.hist = [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища */ } };
  const UI = { view: 'pick', pick: null, carry: false, rv: 0, fmt: 'mermaid', copied: '' };

  /* ---------- кейс: всё, что нужно этапам ---------- */
  const READ_K = ['read', 'search', 'feed', 'graph', 'geo', 'report'], WRITE_K = ['write', 'upload', 'msg', 'events', 'metrics'];
  const sumK = (tr, ks) => ks.reduce((s, k) => s + (tr[k] || 0), 0);
  const KN = { geo: 'Поиск рядом', graph: 'Связи в графе', events: 'События', report: 'Отчёты', metrics: 'Метрики', feed: 'Лента' };
  const kindName = k => (SD.KINDS[k] && SD.KINDS[k].label) || KN[k] || k;
  const peakOf = L => Object.entries(L.traffic || {}).filter(([k, v]) => k !== 'bot' && v > 0).reduce((s, [, v]) => s + v, 0);
  const goal = (L, t) => (L.goals || []).find(g => g.t === t);
  const survWhat = sv => sv.types === 'all' ? 'любого одного экземпляра' : 'одного экземпляра: ' + sv.types.map(t => (T()[t] ? T()[t].name : t).toLowerCase()).join(', ');
  const memo = {};
  function caseOf(base) {
    if (memo[base]) return memo[base];
    const L = SD.levelById(base); if (!L) return null;
    const C = { base, L, title: L.title, peak: peakOf(L), m: null, est: [] };
    try { if (SD.calc && SD.calc.usable(L)) { C.m = SD.calc.model(L); C.est = SD.calc.steps(C.m).filter(s => ['avg', 'peak', 'ratio', 'app', 'vol'].includes(s.id) && !(s.id === 'ratio' && s.ans < 0.5) && s.ans > 0); } } catch (e) { C.m = null; C.est = []; }
    C.asks = asksOf(C); C.fr = frOf(C); C.nfr = nfrOf(C); C.ops = opsOf(C);
    memo[base] = C;
    return C;
  }
  const levelD = base => SD.levelById('free-' + base);

  /* этап 1: вопросы заказчику — ответы берутся из самого кейса (нагрузка, цели, бюджет) */
  function asksOf(C) {
    const L = C.L, tr = L.traffic || {}, R = sumK(tr, READ_K), Wr = sumK(tr, WRITE_K), out = [];
    const story = String(L.story || '').split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    const kinds = Object.entries(tr).filter(([k, v]) => v > 0 && k !== 'bot').map(([k, v]) => `${kindName(k).toLowerCase()} — ${F().num(v)}/с`);
    const lat = (L.goals || []).filter(g => g.t === 'latency'), suc = goal(L, 'success'), sv = goal(L, 'survive'), cost = goal(L, 'cost');
    out.push({ id: 'load', q: 'Сколько запросов в час пик?', a: `В пик: ${kinds.join(', ')}${tr.bot ? `; ещё ${F().num(tr.bot)}/с — боты и парсеры` : ''}.${C.m ? ` Пользователей в день — около ${big(C.m.dau)}.` : ''}`, key: 1, reveal: ['load'] });
    if (R > 0 && Wr > 0) out.push({ id: 'ratio', q: 'Чего больше — чтений или записей?', a: R >= Wr ? `Чтений примерно в ${fx(R / Wr)} раза больше, чем записей.` : `Записей больше: на одно чтение приходится ≈ ${fx(Wr / R)} записи.`, key: 0 });
    if (lat.length) out.push({ id: 'lat', q: 'Как быстро должен приходить ответ?', a: cap(lat.map(g => !g.kind || g.kind === 'all' ? `в среднем не дольше ${g.max} мс` : `${kindName(g.kind).toLowerCase()} — не дольше ${g.max} мс`).join('; ')) + '.', key: 1, reveal: ['lat'] });
    out.push({ id: 'avail', q: 'Насколько страшно, если сервис ляжет?', a: `Успешных ответов — не меньше ${F().pct(suc ? suc.min : 0.999)}.` + (sv ? ` Падение ${survWhat(sv)} пользователи не должны заметить.` : ' Отдельно переживать падение узлов кейс не требует, но простои никому не нравятся.'), key: 1, reveal: ['avail', 'surv'] });
    if (cost) out.push({ id: 'cost', q: 'Какой бюджет на инфраструктуру?', a: `До ${F().usd(cost.max)} в месяц.`, key: 1, reveal: ['cost'] });
    if (L.job) out.push({ id: 'job', q: 'Есть ли работа, которую можно сделать позже?', a: `Да: ${L.job.label}.` + (goal(L, 'nolost') ? ' Ни одна задача не должна потеряться.' : '') + (goal(L, 'nodup') ? ' И нельзя выполнить её дважды.' : '') + (goal(L, 'ordered') ? ' Порядок внутри одного ключа важен.' : ''), key: 1, reveal: ['job'] });
    if (L.connections) out.push({ id: 'conn', q: 'Сколько людей онлайн одновременно?', a: `${big(L.connections)} постоянных соединений.`, key: 1 });
    if (tr.static || tr.upload) out.push({ id: 'media', q: 'Есть ли тяжёлые файлы — фото, видео?', a: [tr.static ? `Картинки и видео: ${F().num(tr.static)}/с в пик` : '', tr.upload ? `загрузки файлов: ${F().num(tr.upload)}/с` : ''].filter(Boolean).join(', ') + '.', key: 0 });
    out.push({ id: 'keep', q: 'Сколько хранить данные?', a: 'Считай на год вперёд, старое можно увозить в архив.', key: 0 });
    out.push({ id: 'lang', q: 'На каком языке писать сервисы?', a: 'Это решат разработчики — на архитектуру почти не влияет. Давай про систему.', bad: 1 });
    out.push({ id: 'color', q: 'Какого цвета будут кнопки?', a: 'Это к дизайнерам, к архитектуре не относится.', bad: 1 });
    const prod = { id: 'product', q: 'Что делает система и кто ей пользуется?', a: story, key: 1 };
    return [prod].concat(shuffle(out, rng(hash(L.id + ':ask'))));
  }
  /* функциональные: виды запросов кейса + фоновая работа; лишние — из того, чего в кейсе нет */
  const FRT = { read: 'Открывать и читать данные: страницы, карточки', write: 'Создавать и менять данные', static: 'Показывать картинки и видео', upload: 'Загружать файлы', search: 'Искать по тексту', msg: 'Переписываться в реальном времени', geo: 'Находить то, что рядом на карте', graph: 'Показывать связи: друзья друзей', events: 'Собирать поток событий: клики, просмотры', report: 'Строить отчёты и дашборды', metrics: 'Принимать метрики с тысяч серверов', bot: 'Отсекать ботов и парсеров' };
  const FR_X = ['Видеозвонки между пользователями', 'Рекомендации на машинном обучении', 'Офлайн-режим в мобильном приложении', 'Выгрузка всех данных в Excel', 'Голосовой помощник'];
  function frOf(C) {
    const L = C.L, tr = L.traffic || {}, r = rng(hash(L.id + ':fr')), out = [];
    Object.keys(tr).filter(k => tr[k] > 0 && FRT[k]).forEach(k => {
      let t = FRT[k];
      if (k === 'read' && L.id === 'short') t = 'Переходить по короткой ссылке на исходный адрес';
      else if (k === 'read' && L.feed) t = 'Читать ленту новостей';
      out.push({ id: 'k-' + k, t, ok: 1 });
    });
    if (L.job) out.push({ id: 'job', t: 'В фоне: ' + L.job.label, ok: 1 });
    const pool = ['static', 'upload', 'search', 'msg', 'geo'].filter(k => !(tr[k] > 0)).map(k => FRT[k]).concat(FR_X);
    shuffle(pool, r).slice(0, 3).forEach((t, i) => out.push({ id: 'x-' + i, t, ok: 0 }));
    return shuffle(out, r);
  }
  /* нефункциональные: у каждого числа три варианта — верный из кейса и два мимо на порядок */
  function nfrOf(C) {
    const L = C.L, r = rng(hash(L.id + ':nfr')), rows = [];
    const row = (id, t, opts, okI) => { const ord = shuffle([0, 1, 2], r); rows.push({ id, t, opts: ord.map(i => opts[i]), ok: ord.indexOf(okI) }); };
    const P = C.peak;
    row('load', 'Нагрузка в час пик', [`≈ ${F().num(P / 10)}/с`, `≈ ${F().num(P)}/с`, `≈ ${F().num(P * 10)}/с`], 1);
    const lat = (L.goals || []).find(g => g.t === 'latency' && (!g.kind || g.kind === 'all')) || (L.goals || []).find(g => g.t === 'latency');
    if (lat) row('lat', lat.kind && lat.kind !== 'all' ? `Время ответа: ${kindName(lat.kind).toLowerCase()}` : 'Время ответа', [`≤ ${Math.max(1, Math.round(lat.max / 10))} мс`, `≤ ${lat.max} мс`, `≤ ${F().ms(lat.max * 10)}`], 1);
    const suc = goal(L, 'success'), mn = suc ? suc.min : 0.999;
    row('avail', 'Доступность: доля успешных ответов', [F().pct(mn >= 0.999 ? 0.99 : 0.9), F().pct(mn), F().pct(mn >= 0.999 ? 0.99999 : 0.9999)], 1);
    const cost = goal(L, 'cost');
    if (cost) row('cost', 'Бюджет в месяц', [`до ${F().usd(Math.round(cost.max / 5 / 10) * 10)}`, `до ${F().usd(cost.max)}`, `до ${F().usd(cost.max * 5)}`], 1);
    const sv = goal(L, 'survive');
    if (sv) row('surv', 'Отказ узла', ['Можно полежать до часа — не страшно', `Падение ${survWhat(sv)} пользователи не замечают`, 'Не падает вообще ничего — даже целый регион'], 1);
    if (L.job) row('job', 'Фоновая работа', ['Делать сразу, пока пользователь ждёт', goal(L, 'nolost') ? 'В фоне, и ни одна задача не теряется' : 'В фоне — лишь бы успевали', 'Раз в сутки ночью — не срочно'], 1);
    return rows;
  }
  /* этап 3: вызовы кейса. m — верный метод, mOk — допустимые с частью балла; r — ответ; good — нужные свойства */
  const METHODS = [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT / PATCH'], ['DELETE', 'DELETE'], ['WS', 'WebSocket'], ['EVT', 'Событие в брокер']];
  const RESP = [['200', '200 + данные'], ['201', '201 Создано'], ['202', '202 Принято'], ['302', '302 Перенаправление'], ['ACK', 'Подтверждение (ack)']];
  const PROPS = { idem: 'Ключ идемпотентности: повтор не создаст дубль', cursor: 'Пагинация курсором (cursor + limit)', cache: 'Ответ можно кэшировать (Cache-Control, ETag)', async: 'Асинхронно: «принято», доделаем в фоне', presign: 'Подписанная ссылка: файл идёт прямо в хранилище', batch: 'Пачкой: много событий одним запросом', cdn: 'Отдаёт CDN, а не сервис', rate: 'Лимит частоты: 429 и Retry-After' };
  const PSHORT = { idem: 'идемпотентно', cursor: 'курсор', cache: 'кэш', async: 'асинхронно', presign: 'подписанная ссылка', batch: 'пачкой', cdn: 'через CDN', rate: 'лимит 429' };
  function opsOf(C) {
    const L = C.L, tr = L.traffic || {}, short = L.id === 'short', r = rng(hash(L.id + ':api')), out = [];
    const op = (id, t, path, m, mOk, rr, rOk, good, neutral, why) => out.push({ id, t, path, m, mOk, r: rr, rOk, good, neutral, why, core: 1 });
    if (tr.read) op('read', short ? 'Переход по короткой ссылке' : L.feed ? 'Открыть ленту' : 'Открыть карточку или страницу', short ? '/{code}' : L.feed ? '/feed?cursor=…' : '/items/{id}', 'GET', {}, short ? '302' : '200', short ? { 200: 0.5 } : {}, (L.feed ? ['cursor'] : ['cache']).concat(tr.bot ? ['rate'] : []), L.feed ? ['cache'] : ['rate'],
      'Читать — это GET: его можно кэшировать по дороге до пользователя.' + (short ? ' Короткая ссылка отвечает перенаправлением 302 — браузер уходит на длинный адрес, а переход можно посчитать.' : '') + (L.feed ? ' Лента длинная — листают курсором, без OFFSET.' : '') + (tr.bot ? ' Боты — повод для лимита частоты: 429 с Retry-After.' : ''));
    if (tr.write) op('write', 'Создать или изменить запись', '/items', 'POST', { PUT: 0.6 }, '201', { 200: 0.5, 202: 0.5 }, ['idem'], [], 'Создание — POST с ответом 201. Сеть может повторить запрос — ключ идемпотентности не даст создать дубль.');
    if (tr.search) op('search', 'Поиск', '/search?q=…', 'GET', {}, '200', {}, ['cursor'], ['cache'], 'Поиск — GET с курсором: результатов много, листают страницами без OFFSET.');
    if (tr.upload) op('upload', 'Загрузить файл', '/uploads', 'POST', { PUT: 0.5 }, '201', { 200: 0.5 }, ['presign'], ['async', 'idem'], 'Файл не гонят через сервис: он выдаёт подписанную ссылку, и файл уходит прямо в объектное хранилище.');
    if (tr.static) op('static', 'Картинки и видео', '/media/{id}', 'GET', {}, '200', {}, ['cdn', 'cache'], [], 'Тяжёлое отдаёт CDN рядом с пользователем — сервис его не касается.');
    if (tr.msg) op('msg', 'Отправить сообщение', 'ws: send {chat, text, client_msg_id}', 'WS', {}, 'ACK', {}, ['idem'], [], 'Чату нужен постоянный канал — WebSocket. client_msg_id защищает от дублей при переподключении.');
    if (tr.events) op('events', 'Отправить события: клики, просмотры', '/events', 'POST', { EVT: 0.5 }, '202', { 200: 0.5, ACK: 0.3 }, ['batch', 'async'], [], 'События шлют пачкой и сразу отвечают 202: обработка идёт в фоне через брокер.');
    if (tr.metrics) op('metrics', 'Принять метрики', '/metrics', 'POST', { EVT: 0.5 }, '202', { 200: 0.5 }, ['batch'], ['async'], 'Метрики — поток: пачками, ответ «принято», без ожидания записи.');
    if (tr.report) op('report', 'Получить отчёт', '/reports/{id}', 'GET', {}, '200', { 202: 0.75 }, ['cache'], ['async'], 'Отчёт — чтение: GET, готовые цифры удобно кэшировать; долгий отчёт можно строить асинхронно.');
    if (tr.geo) op('geo', 'Найти, что рядом', '/nearby?lat=…&lon=…&r=…', 'GET', {}, '200', {}, [], ['cursor', 'rate'], 'Поиск рядом — GET с координатами и радиусом. Позиции меняются каждые секунды, кэш тут почти бесполезен.');
    if (tr.graph) op('graph', 'Друзья друзей', '/users/{id}/friends?cursor=…', 'GET', {}, '200', {}, ['cursor'], ['cache'], 'Связи — GET с курсором: списки длинные.');
    if (L.job) op('job', 'В фоне: ' + L.job.label, 'событие → брокер → обработчик', 'EVT', { POST: 0.3 }, 'ACK', { 202: 0.5 }, ['idem'], ['async'], 'Фоновая работа — событие в брокер: пользователь не ждёт, обработчик подтверждает (ack) после выполнения и спокойно переносит повтор.');
    /* у каждого вызова — нужные свойства, нейтральные и одно-два лишних */
    out.forEach(o => {
      const extra = shuffle(Object.keys(PROPS).filter(k => !o.good.includes(k) && !o.neutral.includes(k)), r).slice(0, o.good.length ? 1 : 2);
      o.props = Object.keys(PROPS).filter(k => o.good.includes(k) || o.neutral.includes(k) || extra.includes(k));
    });
    shuffle([['theme', 'Сменить тему оформления'], ['excel', 'Выгрузить все данные в Excel'], ['avatar', 'Поставить анимированный аватар']], r).slice(0, 2)
      .forEach(([id, t]) => out.push({ id: 'x-' + id, t, core: 0, why: 'Не главное для этой системы: в первой версии без него можно жить. На собеседовании лишние вызовы съедают время.' }));
    return shuffle(out, r);
  }

  /* ---------- оценка этапов ---------- */
  function scoreReq(c, C) {
    const a = c.req, keys = C.asks.filter(x => x.key), bad = C.asks.filter(x => x.bad);
    const kA = keys.filter(x => a.asked.includes(x.id)).length, bA = bad.filter(x => a.asked.includes(x.id)).length;
    const extra = C.asks.filter(x => !x.key && !x.bad && a.asked.includes(x.id)).length;
    const askS = clamp01(kA / Math.max(1, keys.length) + 0.05 * extra - 0.1 * bA);
    const tru = C.fr.filter(x => x.ok), fal = C.fr.filter(x => !x.ok);
    const tp = tru.filter(x => a.fr.includes(x.id)).length, fp = fal.filter(x => a.fr.includes(x.id)).length;
    const frS = clamp01(tp / Math.max(1, tru.length) - 0.25 * fp);
    const nOk = C.nfr.filter(r => a.nfr[r.id] === r.ok).length, nfrS = nOk / Math.max(1, C.nfr.length);
    const s = 0.35 * askS + 0.3 * frS + 0.35 * nfrS;
    return { s, det: `вопросов по делу ${kA} из ${keys.length}${bA ? `, мимо архитектуры ${bA}` : ''} · функции ${tp} из ${tru.length}${fp ? `, лишних ${fp}` : ''} · числа ${nOk} из ${C.nfr.length}`, kA, kN: keys.length, bA, tp, tN: tru.length, fp, nOk, nN: C.nfr.length, askS, frS, nfrS };
  }
  function scoreEst(c, C) {
    if (!C.est.length) return { s: null, det: 'для этого кейса расчёт недоступен', rows: [] };
    const rows = C.est.map(st => { const v = (c.est.v || {})[st.id] || '', g = grade(parse(v), st.ans); return { id: st.id, title: st.title, v, ans: st.ans, unit: st.unit, g }; });
    const s = mean(rows.map(r => GS[r.g]));
    return { s, rows, det: `в пределах ±30 % — ${rows.filter(r => r.g === 'ok').length} из ${rows.length}, порядок верный — ${rows.filter(r => r.g === 'order').length}` };
  }
  function opScore(o, sel) {
    if (!sel || !sel.on) return { s: 0, m: 0, r: 0, p: 0 };
    const m = sel.m === o.m ? 1 : (o.mOk[sel.m] || 0), r = sel.r === o.r ? 1 : (o.rOk[sel.r] || 0);
    const pr = sel.p || [], gc = o.good.filter(k => pr.includes(k)).length, dc = pr.filter(k => !o.good.includes(k) && !o.neutral.includes(k)).length;
    const p = o.good.length ? clamp01(gc / o.good.length - 0.5 * dc) : clamp01(1 - 0.5 * dc);
    return { s: 0.45 * m + 0.2 * r + 0.35 * p, m, r, p };
  }
  function scoreApi(c, C) {
    const sel = c.api.sel || {}, core = C.ops.filter(o => o.core), xs = C.ops.filter(o => !o.core);
    const per = core.map(o => opScore(o, sel[o.id]).s), xin = xs.filter(o => sel[o.id] && sel[o.id].on).length;
    const s = clamp01(mean(per) - 0.15 * xin);
    return { s, det: `главных вызовов собрано ${core.filter(o => sel[o.id] && sel[o.id].on).length} из ${core.length}${xin ? `, лишних ${xin}` : ''} · средняя точность ${Math.round(mean(per) * 100)} %`, xin };
  }
  function scoreHld(c) {
    const ev = c.hld.ev;
    if (!ev) return { s: 0, det: 'схема не собрана или не оценена' };
    return { s: ev.total / 100, det: ev.empty ? 'схема пустая' : `оценка ${ev.total} из 100 · цели ${ev.goals.filter(x => x.ok).length} из ${ev.goals.length}` };
  }
  function scoreDeep(c) {
    const qs = c.deep.qs || [];
    if (!qs.length) return { s: 0, det: 'вопросов нет: схема не собрана' };
    const acc = mean(qs.map(q => { const a = c.deep.ans[q.id]; return a === q.right ? 1 : (q.part || []).includes(a) ? 0.5 : 0; }));
    const rb = qs.filter(q => q.id !== 'x10'), robust = rb.length ? mean(rb.map(q => q.ok ? 1 : 0)) : 0;
    return { s: 0.6 * acc + 0.4 * robust, det: `предсказано верно ${qs.filter(q => c.deep.ans[q.id] === q.right).length} из ${qs.length} · схема пережила ${rb.filter(q => q.ok).length} из ${rb.length} испытаний`, acc, robust };
  }
  function scores(c) {
    const C = caseOf(c.base);
    return { req: scoreReq(c, C), est: scoreEst(c, C), api: scoreApi(c, C), hld: scoreHld(c), deep: scoreDeep(c) };
  }
  function finalOf(sc) {
    let ws = 0, wt = 0;
    ST.forEach(s => { if (sc[s.id].s == null) return; ws += WT[s.id] * sc[s.id].s; wt += WT[s.id]; });
    const s = wt ? ws / wt : 0;
    /* нерабочая схема — не больше чем на ступень выше её собственного уровня: без схемы собеседование не пройти;
       сеньор — только если ни один этап не ниже мидла */
    let idx = Math.min(lvIdx(s), lvOf('hld', sc.hld.s) + 1);
    if (idx === 3 && ST.some(x => sc[x.id].s != null && lvOf(x.id, sc[x.id].s) < 2)) idx = 2;
    return { s, idx };
  }

  /* ---------- схема: снимок, сборка графа, оценка свободным режимом ---------- */
  function specFrom(D, g) {
    const pre = new Set((D.preset || []).map(p => p[0]));
    return { nodes: g.nodes.filter(n => !pre.has(n.id)).map(n => [n.id, n.type, Math.round(n.x), Math.round(n.y), copy(n.props), n.label || null]), edges: g.edges.map(e => [e.from, e.to, copy(e.props || {})]) };
  }
  const graphOf = (D, spec) => SD.walk.build(D, spec, spec.nodes, spec.nodes.length);
  const sigOf = spec => spec ? String(hash(JSON.stringify(spec))) : '';
  const realNodes = g => g.nodes.filter(n => n.type !== 'client' && !(T()[n.type] || {}).ops);
  const pname = id => ((SD.PATTERNS || []).find(p => p.id === id) || {}).name || id;
  function evalHld(c) {
    const D = levelD(c.base), spec = c.hld.spec;
    c.hld.sig = sigOf(spec);
    if (!spec || !spec.nodes.length) { c.hld.ev = { total: 0, empty: true, goals: [], good: [], fix: [], sc: { req: 0, head: 0, rel: 0, cost: 0, arch: 0 }, parts: [], need: [] }; return; }
    const g = graphOf(D, spec), E = SD.free.evaluate({ level: D, graph: g });
    c.hld.ev = {
      total: E.total, sc: E.sc, good: E.good.slice(0, 6), fix: E.fix.slice(0, 6), cost: E.cost, rc: E.rc, pats: E.pats.map(pname),
      need: ((E.me.det && E.me.det.needed) || []).map(p => p.id), goals: E.me.goals.map(x => ({ ok: x.ok, text: x.text, detail: x.detail })),
      s12: E.me.s12, s15: E.me.s15, s2: E.me.s2, chOk: E.me.ch.filter(x => x.ok).length, chN: E.me.ch.length,
      parts: realNodes(g).map(n => nm(n) + (n.props.count > 1 ? ' ×' + n.props.count : ''))
    };
  }

  /* ---------- углубление: вопросы под схему ученика, ответы — прогоном симулятора ---------- */
  const PROTECT = { app: 'второй экземпляр за балансировщиком', sql: 'реплика с автоматическим переключением (failover)', cache: 'второй узел кэша — и база, которая переживёт промахи', queue: 'кластер из трёх брокеров или управляемый брокер', worker: 'второй обработчик — очередь подождёт', ws: 'ещё шлюзы: клиенты переподключатся к соседям', gateway: 'второй экземпляр шлюза', nosql: 'больше узлов с репликацией', search: 'реплики индекса' };
  const GROW = { app: 'больше экземпляров или автомасштабирование', sql: 'реплики, если упор в чтения; шарды, если в записи; кэш перед базой', cache: 'больше памяти или узлов кэша', queue: 'больше партиций', worker: 'больше обработчиков', gateway: 'больше экземпляров шлюза', ws: 'больше realtime-шлюзов', nosql: 'больше узлов', search: 'больше узлов поиска', external: 'кэш ответов, очередь и лимит перед внешним сервисом', olap: 'больше узлов аналитической базы' };
  const CAPK = ['count', 'replicas', 'shards', 'partitions'];
  const levers = n => ((T()[n.type] || {}).props || []).filter(p => p.type === 'range' && CAPK.includes(p.key));
  const sMinOf = L => (goal(L, 'success') || { min: 0.999 }).min;
  const utilOf = (r, n) => { const x = r.nodes[n.id]; return x ? (x.dead ? 99 : x.util || 0) : 0; };
  function deepQs(D, g) {
    const real = realNodes(g); if (!real.length) return [];
    const sMin = sMinOf(D), qs = [], pct = v => F().pct(v);
    const uniq = n => real.filter(x => nm(x) === nm(n)).length > 1 ? `${nm(n)} (${n.id})` : nm(n);
    /* 1. отказ узла — как хаос-тест площадки: роняем один экземпляр */
    const ch = SD.sim.chaos(D, g);
    if (ch.length) {
      const pr = ['sql', 'nosql', 'cache', 'queue', 'app', 'gateway', 'ws', 'worker', 'search'];
      let tg = ch.slice().sort((a, b) => a.success - b.success)[0];
      if (tg.ok) tg = ch.slice().sort((a, b) => pr.indexOf(a.type) - pr.indexOf(b.type))[0];
      const n = g.nodes.find(x => x.id === tg.id), s = tg.success, right = s >= 0.99 ? 0 : s >= 0.5 ? 1 : 2;
      let fix = '';
      if (s < 0.99) {
        /* запасной подбираем, как прораб: добавляем по одному, пока падение не станет незаметным (брокеру, например, нужно три) */
        const g2 = copy(g), n2 = g2.nodes.find(x => x.id === n.id), key = n2.type === 'sql' ? 'replicas' : 'count', p = levers(n2).find(x => x.key === key);
        if (p) {
          const from = n2.props[key] !== undefined ? n2.props[key] : (key === 'count' ? 1 : 0); let s2 = s, v = from;
          for (v = Math.max(key === 'count' ? 2 : 1, from + 1); v <= Math.min(p.max, from + 4); v++) { n2.props[key] = v; s2 = SD.sim.run(D, g2, { mul: 1, down: { [n.id]: 1 } }).total.success; if (s2 >= 0.99) break; }
          v = Math.min(v, p.max, from + 4);
          if (s2 > s + 0.005) fix = `Проверил: «${nm(n)}» ${key === 'replicas' ? 'реплик' : 'экземпляров'} ${from} → ${v} — при том же падении успешно ${pct(s2)}.`;
        }
      }
      const cnt = n.props.count || 1;
      const why = s >= 0.99 ? `У «${nm(n)}» есть запас: ${n.type === 'sql' && n.props.replicas ? 'реплика подхватывает работу' : cnt > 1 ? `${cnt} экземпляра, нагрузку взяли соседи` : 'управляемый сервис поднимает экземпляр сам'}.`
        : `${cnt > 1 ? 'Оставшиеся экземпляры не тянут нагрузку упавшего' : n.type === 'sql' && !n.props.replicas ? 'У базы нет реплики — подменить её некому' : 'Экземпляр один — подменить его некому'}. Это единая точка отказа.`;
      qs.push({ id: 'fail', kind: 'Отказ узла', q: `Ночью упал один экземпляр «${uniq(n)}». Что заметят пользователи?`,
        opts: ['Почти ничего: есть запасной, он подхватит', 'Часть запросов будет падать, пока узел не поднимут', 'Сервис ляжет почти целиком'], right,
        sim: `Симулятор уронил один экземпляр «${nm(n)}»: успешно ${pct(s)}.`, why, fix: fix || (s < 0.99 && PROTECT[n.type] ? `Как защититься: ${PROTECT[n.type]}.` : ''), ok: s >= 0.99, node: n.id });
    }
    /* 2. рост ×10 — множитель нагрузки, как ползунок «Нагрузка» и «Событие дня» */
    let brk = null;
    for (const m of [1, 1.5, 2, 3, 5, 7, 10]) {
      const r = SD.sim.run(D, g, { mul: m });
      const hot = real.filter(n => utilOf(r, n) > 1).sort((a, b) => utilOf(r, b) - utilOf(r, a));
      if (hot.length || r.total.success < sMin) {
        const top = hot[0] || real.slice().sort((a, b) => utilOf(r, b) - utilOf(r, a))[0];
        brk = { m, n: top, u: utilOf(r, top) }; break;
      }
    }
    const r10 = SD.sim.run(D, g, { mul: 10 });
    const byU = real.slice().sort((a, b) => utilOf(r10, b) - utilOf(r10, a));
    let cand = byU.slice(0, 3); if (brk && !cand.includes(brk.n)) cand = [brk.n].concat(cand.slice(0, 2));
    const optN = shuffle(cand, rng(hash(sigOf(specFrom(D, g)) + ':x10')));
    const opts = optN.map(n => `«${uniq(n)}»`).concat(['Ничего: схема выдержит ×10']);
    const right = brk ? optN.indexOf(brk.n) : opts.length - 1;
    const part = optN.map((n, i) => utilOf(r10, n) > 1 && i !== right ? i : -1).filter(i => i >= 0);
    let fix = '';
    if (brk && brk.n) {
      const n = brk.n, s0 = r10.total.success; let best = null;
      levers(n).forEach(p => {
        const v0 = n.props[p.key] !== undefined ? n.props[p.key] : (p.def !== undefined ? p.def : p.min); if (v0 >= p.max) return;
        const v1 = Math.min(p.max, Math.max(v0 + 1, Math.ceil(Math.max(v0, 1) * 3)));
        const g2 = copy(g); g2.nodes.find(x => x.id === n.id).props[p.key] = v1;
        const r2 = SD.sim.run(D, g2, { mul: 10 });
        if (!best || r2.total.success > best.s + 1e-4) best = { p, v0, v1, s: r2.total.success, r: r2, g2 };
      });
      if (best && best.s > s0 + 0.005) {
        const nx = realNodes(best.g2).filter(x => x.id !== n.id && utilOf(best.r, x) > 1).sort((a, b) => utilOf(best.r, b) - utilOf(best.r, a))[0];
        fix = `Проверил: «${nm(n)}» ${(best.p.label || best.p.key).toLowerCase()} ${best.v0} → ${best.v1} — при ×10 успешно ${pct(s0)} → ${pct(best.s)}.${nx ? ` Следом упирается «${nm(nx)}» — так и растят систему: расширил узкое место, нашёл следующее.` : ''}`;
      } else fix = GROW[n.type] ? `Что помогает «${nm(n)}»: ${GROW[n.type]}.` : '';
    }
    qs.push({ id: 'x10', kind: 'Рост ×10', q: 'Запустили большую рекламу — нагрузка выросла в 10 раз. Что упрётся в потолок первым?', opts, right, part,
      sim: brk ? `Симулятор: первым упирается «${nm(brk.n)}» уже при ×${String(brk.m).replace('.', ',')} (загрузка ${brk.u >= 99 ? 'узел лежит' : Math.round(brk.u * 100) + ' %'}); при ×10 успешно ${pct(r10.total.success)}.` : `Симулятор: схема выдерживает ×10 — успешно ${pct(r10.total.success)}. Запас большой, но и цена, скорее всего, тоже.`,
      why: brk ? 'Под ростом первым ломается самый загруженный узел: его загрузка растёт вместе с нагрузкой и раньше других переходит 100 %.' : 'Ни один узел не перешёл 100 % загрузки.',
      fix, ok: !brk || brk.m >= 2 });
    /* 3. горячий ключ — запросов столько же, но половина из них про одну запись.
       Чтения: горячая запись живёт в кэше («горячий набор» сжимается), а шард с ней перегружен.
       Записи: одну строку меняют все сразу — блокировки и повторы (contention, как SD.isoStress), и тот же горячий шард. */
    const tr = D.traffic || {}, kind = Object.entries(tr).filter(([k, v]) => !['bot', 'static', 'upload'].includes(k) && v > 0).sort((a, b) => (b[1] - a[1]) || (a[0] === 'read' ? -1 : 1)).map(([k]) => k)[0];
    if (kind) {
      const readLike = READ_K.includes(kind), h = 0.5;
      const L2 = Object.assign({}, D, readLike ? { hotSetGb: (D.hotSetGb || 8) / 6, cacheMax: Math.max(D.cacheMax || 0.97, 0.99) } : { contention: Math.max(D.contention || 0, 0.6) });
      /* шарды не спасают: горячий ключ живёт на одном шарде — эффективных шардов меньше */
      const g2 = copy(g);
      g2.nodes.forEach(n => {
        if (n.type === 'sql' && (n.props.shards || 1) > 1) n.props.shards = +(1 / (h + (1 - h) / n.props.shards)).toFixed(2);
        if (n.type === 'nosql' && (n.props.count || 1) > 1) n.props.count = +(1 / (h + (1 - h) / n.props.count)).toFixed(2);
      });
      const r = SD.sim.run(L2, g2, { mul: 1 });
      const L3 = Object.assign({}, L2, { goals: (D.goals || []).filter(x => x.t === 'success' || x.t === 'latency') });
      const gl = SD.evalGoals(L3, g2, r, [], SD.sim.analyze(L3, g2, r));
      const sOk = gl.filter(x => /Успешных/.test(x.text)).every(x => x.ok) && r.total.success >= sMin;
      const lOk = gl.filter(x => !/Успешных/.test(x.text)).every(x => x.ok);
      const right3 = sOk && lOk ? 0 : sOk ? 1 : 2;
      /* виновник — хранилище; сервис перед ним перегружен, потому что ждёт ответа */
      const STORE = ['sql', 'nosql', 'cache', 'search', 'olap', 'queue'];
      const hot = realNodes(g2).filter(n => utilOf(r, n) > 1).sort((a, b) => (STORE.includes(b.type) - STORE.includes(a.type)) || (utilOf(r, b) - utilOf(r, a)));
      const hasCache = g.nodes.some(n => n.type === 'cache'), sharded = g.nodes.some(n => n.type === 'sql' && n.props.shards > 1);
      const why = [readLike ? (hasCache ? 'Кэш забирает горячую запись на себя — до базы доходит меньше, чем обычно.' : 'Кэша нет — все чтения горячей записи идут в хранилище.') : 'Кэш записи не спасает: каждую надо записать, а одну строку одновременно меняют все — транзакции ждут друг друга и повторяются.',
        sharded ? 'Шарды почти не помогают: горячий ключ живёт на одном шарде.' : '',
        hot.length ? `Перегружен: ${hot.slice(0, 2).map(n => `«${nm(n)}» (${utilOf(r, n) >= 99 ? 'лежит' : Math.round(utilOf(r, n) * 100) + ' %'})`).join(', ')}.` : ''].filter(Boolean).join(' ');
      qs.push({ id: 'hot', kind: 'Горячий ключ', q: readLike ? 'Одна запись стала звездой — вирусная ссылка, пост знаменитости, товар дня. Запросов столько же, но половина чтений — про неё одну. Что будет?' : `Один ключ стал горячим: запросов столько же, но половина запросов вида «${kindName(kind).toLowerCase()}» меняет одну и ту же запись. Что будет?`,
        opts: ['Выдержит без потерь и в пределах времени ответа', 'Ответит, но медленнее, чем требует кейс', 'Начнёт терять запросы'], right: right3,
        sim: `Симулятор: успешно ${pct(r.total.success)}, среднее время ответа ${F().ms(r.total.lat)}.`, why,
        fix: right3 === 0 ? '' : readLike ? 'Что помогает: кэш перед хранилищем (горячее держит память), реплики для чтений, защита от лавины на один ключ.' : 'Что помогает: разнести ключ на части (счётчик по кусочкам, «соль» в ключе), принимать записи в очередь и сливать пачками.',
        ok: sOk });
    }
    return qs;
  }

  /* ---------- сессия ---------- */
  function fresh(base) {
    return { id: Date.now().toString(36), base, t0: Date.now(), stage: 0, stageT: {}, timer: !S.noTimer,
      req: { asked: [], fr: [], nfr: {}, own: '', lock: false }, est: { v: {}, lock: false }, api: { sel: {}, lock: false },
      hld: { spec: null, ev: null, sig: '' }, deep: { sig: '', qs: null, ans: {} } };
  }
  function start(base) {
    const C = caseOf(base); if (!C) return;
    const c = fresh(base), A = SD.app && SD.app.A;
    /* «Сдать как собеседование» из свободного режима: собранная схема — черновик этапа «Схема» */
    if (UI.carry && A && A.level && A.level.free && A.level.free.base === base && realNodes(A.graph).length) c.hld.spec = specFrom(A.level, A.graph);
    S.cur = c; UI.carry = false; save();
    UI.view = 'run'; render(); scrollTop();
  }
  function go(i) { const c = S.cur; if (!c) return; c.stage = Math.max(0, Math.min(ST.length - 1, i)); if (ST[c.stage].id === 'deep') ensureDeep(c); save(); render(); scrollTop(); }
  function lock(c, sid) {
    if (sid === 'req' || sid === 'est' || sid === 'api') c[sid].lock = true;
    if (sid === 'hld' && c.hld.spec && c.hld.sig !== sigOf(c.hld.spec)) evalHld(c);
  }
  function ensureDeep(c) {
    if (c.hld.spec && c.hld.sig !== sigOf(c.hld.spec)) evalHld(c);
    const sig = sigOf(c.hld.spec);
    if (c.deep.sig === sig && c.deep.qs) return;
    const had = c.deep.qs && Object.keys(c.deep.ans).length;
    c.deep.sig = sig; c.deep.ans = {};
    try { c.deep.qs = c.hld.spec && c.hld.spec.nodes.length ? deepQs(levelD(c.base), graphOf(levelD(c.base), c.hld.spec)) : []; } catch (e) { c.deep.qs = []; }
    c.deep.changed = !!had;
  }
  function finish() {
    const c = S.cur; if (!c) return;
    ['req', 'est', 'api', 'hld'].forEach(id => lock(c, id));
    ensureDeep(c);
    const rep = report(c);
    S.hist.unshift(rep); S.hist = S.hist.slice(0, 20); S.cur = null; save();
    UI.view = 'report'; UI.rv = 0; render(); scrollTop(); updateBar();
  }

  /* ---------- холст: этап «Схема» ---------- */
  function build() {
    const c = S.cur; if (!c) return;
    const D = levelD(c.base), A = SD.app.A;
    c.stage = 3; save();
    $('exModal').hidden = true;
    A.freeHints = false;
    if (!A.level || A.level.id !== D.id) SD.app.loadLevel(D, c.hld.spec || null);
    else if (SD.panels && A.tab === 'task') SD.panels.task(A);
    toast('Собирай схему: палитра полная, подсказок нет. Когда готово — «Готово — оценить схему» внизу.');
    updateBar();
  }
  const onCanvas = () => { const c = S.cur, A = SD.app && SD.app.A; return !!(c && A && A.level && A.level.id === 'free-' + c.base); };
  function snap() { const c = S.cur; if (onCanvas()) c.hld.spec = specFrom(SD.app.A.level, SD.app.A.graph); }
  function back(evaluate) {
    const c = S.cur; if (!c) return;
    snap();
    if (evaluate) { evalHld(c); c.stage = 4; ensureDeep(c); }
    save(); UI.view = 'run'; showModal(); render(); scrollTop(); updateBar();
    if (SD.panels && SD.app.A.tab === 'task') SD.panels.task(SD.app.A);
  }

  /* ---------- отчёт ---------- */
  const TABT = { table: { cache: 'кэш', repl: 'реплики', srv: 'сервер', hot: 'горячий шард', idx: 'индексы', shard: 'шарды', iso: 'изоляция', part: 'партиции', weight: 'вес', query: 'запросы', reshard: 'решардинг' }, api: { pick: 'выбор взаимодействия', check: 'чек-лист API', contract: 'контракты' }, front: { offline: 'офлайн', load: 'открытие страницы' } };
  function linkLab(id, tab, why) { const l = (SD.LABS || []).find(x => x.id === id), tn = tab && TABT[id] ? TABT[id][tab] : ''; return l ? { kind: 'lab', id, tab: tab || '', title: 'Лаборатория «' + l.title + '»' + (tn ? ' · ' + tn : ''), why } : null; }
  function linkLevel(id, why) { const L = SD.levelById(id); return L ? { kind: 'level', id, title: 'Уровень «' + L.title + '»', why } : null; }
  function linkPath(id) {
    const s = SD.path && (SD.path.SKILLS || []).find(x => x.id === id); if (!s) return null;
    const its = s.items.map(k => { try { return SD.path.itemOf(k); } catch (e) { return null; } }).filter(Boolean);
    return { kind: 'path', id, title: `«Мой путь»: навык «${s.name}»`, why: `пройдено ${its.filter(i => i.done).length} из ${its.length}` };
  }
  function report(c) {
    const C = caseOf(c.base), sc = scores(c), fin = finalOf(sc), total = ST.reduce((s, x) => s + (c.stageT[x.id] || 0), 0);
    const stg = {};
    ST.forEach(x => { const v = sc[x.id]; stg[x.id] = { s: v.s, lv: v.s == null ? null : lvOf(x.id, v.s), det: v.det, t: c.stageT[x.id] || 0 }; });
    const good = [], gaps = [];
    const L = C.L, R = sc.req, E = sc.est, P = sc.api, ev = c.hld.ev, D = sc.deep;
    /* сильные стороны */
    if (R.kA >= Math.min(4, R.kN)) good.push('Прежде чем рисовать, выяснил главное: нагрузку, время ответа, доступность и бюджет.');
    if (R.nOk === R.nN) good.push('Зафиксировал все числа требований без ошибок.');
    if (R.tp === R.tN && !R.fp) good.push('Отделил основные функции от лишнего.');
    const eOk = (E.rows || []).filter(r => r.g === 'ok');
    if (eOk.length >= 3) good.push(`Оценка нагрузки в пределах ±30 %: ${eOk.map(r => ESTN[r.id] || r.title.toLowerCase()).join(', ')}.`);
    if (P.s >= 0.8) good.push('API по смыслу верное: методы, ответы и свойства надёжного вызова.');
    if (ev && !ev.empty && ev.total >= 75) good.push(`Схема на ${ev.total} из 100: ${ev.good.slice(0, 2).map(x => x.replace(/\.$/, '').toLowerCase()).join('; ')}.`);
    (c.deep.qs || []).forEach(q => { if (c.deep.ans[q.id] === q.right) good.push(`${q.kind}: верно предсказал — «${q.opts[q.right].replace(/^«|»$/g, '')}».`); });
    if ((c.deep.qs || []).some(q => q.id === 'fail' && q.ok)) good.push('Схема переживает падение узла — запасной подхватывает работу.');
    if (total && total <= 38 * 60) good.push(`Уложился в ${Math.ceil(total / 60)} мин — по времени это настоящее собеседование.`);
    /* что подтянуть */
    /* одна и та же ссылка — один раз на весь отчёт, не больше трёх на пункт */
    const seen = new Set();
    const gap = (stage, text, links) => {
      const out = [];
      links.forEach(l => { if (!l || out.length >= 3) return; const k = l.kind + ':' + l.id + ':' + (l.tab || ''); if (seen.has(k)) return; seen.add(k); out.push(l); });
      gaps.push({ stage, text, links: out });
    };
    if (R.s < 0.8) {
      const miss = C.asks.filter(x => x.key && !c.req.asked.includes(x.id)).map(x => '«' + x.q + '»');
      const wrong = C.nfr.filter(r => c.req.nfr[r.id] !== r.ok).map(r => r.t.toLowerCase());
      gap('req', [miss.length ? `Спроси до того, как рисовать: ${miss.join(', ')}.` : '', R.bA ? 'Вопросы про язык и цвет кнопок съедают время — держись системы.' : '', wrong.length ? `Числа требований (${wrong.join(', ')}) уточняй у заказчика, а не угадывай.` : '', R.fp ? 'В функциональные попало лишнее — первая версия делает только главное.' : ''].filter(Boolean).join(' ') || 'Требования собраны не полностью.',
        [linkLab('nfr', '', 'как «99,9 %» и «100 мс» превращаются в решения на схеме'), linkPath('arch')]);
    }
    if (E.s != null && E.s < 0.8) {
      const bad = (E.rows || []).filter(r => r.g !== 'ok').map(r => `${ESTN[r.id] || r.title.toLowerCase()}: у тебя ${r.v || '—'}, по расчёту ${fmtAns(r.ans)}`);
      gap('est', `Расчёт на салфетке: ${bad.join('; ')}. Цепочка: пользователи × действия ÷ 86 400 → среднее, × 3 → пик, ÷ (мощность одного × 0,75) → серверы.`,
        [{ kind: 'calc', id: c.base, title: `«Как посчитать» для кейса «${C.title}»`, why: 'тот же расчёт по шагам с подсказками' }, linkLab('estimate', '', 'средний и пиковый RPS, объём и серверы'), linkLevel('scale', 'сколько экземпляров нужно под пик'), linkPath('calc')]);
    }
    if (P.s < 0.8) {
      const sel = c.api.sel || {};
      const bad = C.ops.filter(o => o.core && opScore(o, sel[o.id]).s < 0.75).map(o => `«${o.t}» — ${METHODS.find(m => m[0] === o.m)[1]}, ответ ${RESP.find(r => r[0] === o.r)[1]}${o.good.length ? ', ' + o.good.map(k => PSHORT[k]).join(', ') : ''}`);
      gap('api', `${bad.length ? 'Как надо: ' + bad.join('; ') + '.' : ''}${P.xin ? ' Лишние вызовы в первой версии — минус: интервьюер ждёт главное.' : ''}`.trim(),
        [linkLab('api', 'pick', 'REST, событие или WebSocket — для какой связи что'), linkLab('api', 'check', 'идемпотентность, курсоры, ошибки, лимиты'), linkLab('front', 'offline', 'ключ идемпотентности на живом примере'), linkPath('arch')]);
    }
    if (!ev || ev.empty || ev.total < 80) {
      const links = [];
      if (!ev || ev.empty || ev.sc.req < 1) { (SD.labLinks ? SD.labLinks.links(L) : []).slice(0, 2).forEach(x => links.push(linkLab(x.lab, x.tab, x.life))); links.push(linkLevel(c.base, 'тот же кейс с подсказками прораба и эталоном')); }
      if (ev && !ev.empty && ev.sc.rel < 0.8) { links.push(linkLevel('f-spof', 'найти единую точку отказа')); links.push(linkLab('resil', '', 'таймауты, повторы и предохранитель')); links.push(linkPath('rel')); }
      if (ev && !ev.empty && ev.sc.head < 0.7) { links.push(linkLevel('friday', 'запас под пик')); links.push(linkPath('scale')); }
      if (ev && !ev.empty && ev.sc.cost < 0.75) links.push(linkLevel('k-size', 'размер против количества'));
      if (ev && !ev.empty && ev.need.length) ev.need.slice(0, 2).forEach(id => links.push({ kind: 'pattern', id, title: `Паттерн «${pname(id)}»`, why: 'карточка: что поставить и почему' }));
      gap('hld', ev && !ev.empty ? ev.fix.slice(0, 4).join(' ') || 'Схема держит требования, но без запаса.' : 'Схема не собрана — а это половина собеседования.', links);
    }
    const qs = c.deep.qs || [];
    if (!qs.length) gap('deep', 'Углубления не было: без схемы не о чем спорить.', [linkLevel('f-spof', ''), linkPath('rel')]);
    qs.forEach(q => {
      /* рост ×10 ломает почти любую схему — запас оценивает этап «Схема»; здесь важен верный прогноз */
      if (c.deep.ans[q.id] === q.right && (q.ok || q.id === 'x10')) return;
      const links = q.id === 'fail' ? [linkLevel('f-spof', 'единая точка отказа'), linkLab('resil', '', 'сосед лежит: что делать вызывающему'), linkPath('rel')]
        : q.id === 'x10' ? [linkLevel('friday', 'нагрузка выросла — что расширять'), linkLab('table', 'srv', 'что кончается первым у сервера'), linkPath('scale')]
          : [linkLevel('f-hotpartition', 'горячий шард'), linkLab('table', 'hot', 'горячий шард на живой таблице'), linkLevel('p-cacheaside', 'кэш перед базой'), linkPath('cache')];
      gap('deep', `${q.kind}: ${c.deep.ans[q.id] === q.right ? 'предсказал верно, но схема не выдержала' : 'предсказание не совпало с симулятором'}. ${q.sim} ${q.fix || ''}`.trim(), links);
    });
    /* что было ответами — для отчёта и Markdown */
    const sel = c.api.sel || {};
    return {
      id: c.id, base: c.base, title: C.title, at: c.t0, dur: total, stages: stg, final: fin, good: good.slice(0, 8), gaps,
      req: { asked: C.asks.filter(x => c.req.asked.includes(x.id)).map(x => ({ q: x.q, a: x.a, bad: !!x.bad })), fr: C.fr.map(x => ({ t: x.t, ok: x.ok, mine: c.req.fr.includes(x.id) })), nfr: C.nfr.map(r => ({ t: r.t, mine: c.req.nfr[r.id] != null ? r.opts[c.req.nfr[r.id]] : null, right: r.opts[r.ok], ok: c.req.nfr[r.id] === r.ok })), own: c.req.own || '' },
      est: (E.rows || []).map(r => ({ title: r.title, v: r.v, ans: fmtAns(r.ans), unit: r.unit, g: r.g })),
      api: C.ops.filter(o => o.core || (sel[o.id] && sel[o.id].on)).map(o => ({ t: o.t, core: o.core, on: !!(sel[o.id] && sel[o.id].on), built: o.core ? callText(o, sel[o.id]) : '', s: o.core ? opScore(o, sel[o.id]).s : 0, need: o.core ? callText(o, { on: 1, m: o.m, r: o.r, p: o.good }) : '' })),
      hld: ev ? { total: ev.total, empty: !!ev.empty, sc: ev.sc, good: ev.good, fix: ev.fix, cost: ev.cost, rc: ev.rc, pats: ev.pats, goals: ev.goals, parts: ev.parts } : null,
      spec: c.hld.spec,
      deep: qs.map(q => ({ kind: q.kind, q: q.q, mine: c.deep.ans[q.id] != null ? q.opts[c.deep.ans[q.id]] : null, right: q.opts[q.right], hit: c.deep.ans[q.id] === q.right, sim: q.sim, why: q.why, fix: q.fix, ok: q.ok }))
    };
  }
  function callText(o, sel) {
    if (!sel || !sel.on) return '— не собран';
    const m = (METHODS.find(x => x[0] === sel.m) || [])[1], r = (RESP.find(x => x[0] === sel.r) || [])[1];
    return `${m || '?'} ${sel.m === 'EVT' || sel.m === 'WS' ? '' : o.path + ' '}→ ${r || '?'}${(sel.p || []).length ? ' · ' + sel.p.map(k => PSHORT[k]).join(', ') : ''}`.replace(/\s+/g, ' ');
  }

  /* ---------- Markdown ---------- */
  const lvName = i => i == null ? '—' : LV[i].name;
  function diagram(rep, fmt) {
    if (!rep.spec || !rep.spec.nodes.length || !SD.share) return '';
    const D = levelD(rep.base); if (!D) return '';
    const A = { level: D, graph: graphOf(D, rep.spec) };
    return fmt === 'c4' ? '```plantuml\n' + SD.share.c4(A) + '```\n' : '```mermaid\n' + SD.share.mermaid(A) + '```\n';
  }
  function markdown(rep, fmt) {
    const d = new Date(rep.at), date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    let t = `# Экзамен по системному дизайну: «${rep.title}»\n\n`;
    t += `- Дата: ${date}, время: ${mmss(rep.dur)}\n- Итог: **${lvName(rep.final.idx)}** (${Math.round(rep.final.s * 100)} из 100)\n- Тренажёр: AMP Стройплощадка, кейс свободного режима\n\n> ${VOICE[rep.final.idx]}\n\n`;
    t += `## Этапы\n\n| Этап | Уровень | Баллы | Почему |\n|---|---|---|---|\n`;
    ST.forEach(x => { const s = rep.stages[x.id]; t += `| ${x.title} | ${lvName(s.lv)} | ${s.s == null ? '—' : Math.round(s.s * 100)} | ${cell(s.lv == null ? s.det : RUB[x.id][s.lv] + ' (' + s.det + ')')} |\n`; });
    t += `\n## Сильные стороны\n\n${rep.good.length ? rep.good.map(x => `- ${x}`).join('\n') : '- Пока отметить нечего — всё впереди.'}\n\n## Что подтянуть\n\n`;
    t += rep.gaps.length ? rep.gaps.map(g => `- **${ST.find(x => x.id === g.stage).title}.** ${g.text}${g.links.length ? '\n  - Куда идти: ' + g.links.map(l => l.title).join('; ') : ''}`).join('\n') : '- Замечаний нет. Попробуй кейс посложнее.';
    t += `\n\n## 1. Требования\n\n**Вопросы заказчику:**\n\n${rep.req.asked.length ? rep.req.asked.map(x => `- ${x.q} — ${x.a}`).join('\n') : '- не задано'}\n\n**Функциональные:**\n\n`;
    t += rep.req.fr.filter(x => x.mine || x.ok).map(x => `- [${x.mine ? 'x' : ' '}] ${x.t}${x.mine && !x.ok ? ' — лишнее' : !x.mine && x.ok ? ' — пропущено' : ''}`).join('\n');
    t += `\n\n**Нефункциональные:**\n\n${rep.req.nfr.map(r => `- ${r.t}: ${r.mine || 'не выбрано'}${r.ok ? ' ✓' : ` — по кейсу ${r.right}`}`).join('\n')}\n`;
    if (rep.req.own) t += `\n**Своими словами:** ${rep.req.own.replace(/\n+/g, ' ')}\n`;
    t += `\n## 2. Оценка нагрузки\n\n`;
    t += rep.est.length ? `| Что | Мой ответ | Расчёт | Итог |\n|---|---|---|---|\n${rep.est.map(r => `| ${cell(r.title)} | ${cell(r.v || '—')} | ${cell(r.ans + ' ' + r.unit)} | ${r.g === 'ok' ? '✓ ±30 %' : r.g === 'order' ? '≈ порядок' : '✗ мимо'} |`).join('\n')}\n` : 'Для этого кейса расчёт недоступен.\n';
    t += `\n## 3. API\n\n${rep.api.map(a => a.core ? `- ${a.t}: \`${a.built}\`${a.s >= 0.75 ? ' ✓' : ` — лучше \`${a.need}\``}` : `- ${a.t}: лишнее в первой версии`).join('\n')}\n`;
    t += `\n## 4. Схема\n\n`;
    if (rep.hld && !rep.hld.empty) {
      t += `Оценка свободного режима: **${rep.hld.total} из 100** · цена ${F().usd(rep.hld.cost)}/мес${rep.hld.rc ? ` (эталон ${F().usd(rep.hld.rc)})` : ''}.\n\nКомпоненты: ${rep.hld.parts.join(', ')}.\n\n`;
      t += rep.hld.goals.map(x => `- [${x.ok ? 'x' : ' '}] ${x.text} — ${x.detail}`).join('\n') + '\n\n';
      t += diagram(rep, fmt);
    } else t += 'Схема не собрана.\n';
    t += `\n## 5. Углубление\n\n${rep.deep.length ? rep.deep.map(q => `- **${q.kind}.** ${q.q}\n  - Мой ответ: ${q.mine || 'нет'}${q.hit ? ' ✓' : ` (верно: ${q.right})`}\n  - ${q.sim} ${q.why}${q.fix ? ' ' + q.fix : ''}`).join('\n') : 'Вопросов не было: схема не собрана.'}\n`;
    return t;
  }

  /* ---------- окно ---------- */
  function ensureModal() {
    let m = $('exModal');
    if (m) return m;
    m = document.createElement('div'); m.className = 'modal ex-modal'; m.id = 'exModal'; m.hidden = true;
    m.innerHTML = '<div class="sheet ex-sheet" role="dialog" aria-modal="true" aria-labelledby="exTitle"><div class="sheet-head ex-head"><span class="eyebrow" style="margin:0">Экзамен · собеседование</span><h2 id="exTitle">Экзамен</h2><span class="ex-clock" id="exClock" hidden></span><button class="btn ghost x" type="button" data-exx>Закрыть</button></div><div class="ex-body" id="exBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('input', onInput);
    m.addEventListener('change', onChange);
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-exest]')) { e.preventDefault(); const n = e.target.closest('.ex-est-row'); const nx = n && n.nextElementSibling && n.nextElementSibling.querySelector('[data-exest]'); if (nx) nx.focus(); } });
    return m;
  }
  function showModal() { document.querySelectorAll('.modal').forEach(x => { if (x.id !== 'exModal') x.hidden = true; }); ensureModal().hidden = false; }
  const scrollTop = () => { const b = $('exBody'); if (b) b.scrollTop = 0; const mn = document.querySelector('.ex-main'); if (mn) mn.scrollTop = 0; };
  function open(base) {
    ensureModal();
    if (typeof base === 'string' && SD.levelById(base)) { UI.pick = base; UI.view = S.cur && S.cur.base === base ? 'run' : 'brief'; }
    else UI.view = S.cur ? 'run' : 'pick';
    render(); showModal(); scrollTop(); updateBar();
  }
  function close() { const m = $('exModal'); if (m) m.hidden = true; updateBar(); }

  function render() {
    const body = $('exBody'); if (!body) return;
    if (UI.view === 'run' && !S.cur) UI.view = 'pick';
    if (UI.view === 'report' && !S.hist[UI.rv]) UI.view = 'pick';
    const mn = document.querySelector('.ex-main'), keep = mn ? mn.scrollTop : 0, keepB = body.scrollTop;
    body.innerHTML = UI.view === 'brief' ? viewBrief() : UI.view === 'run' ? viewRun() : UI.view === 'report' ? viewReport(S.hist[UI.rv]) : viewPick();
    const mn2 = document.querySelector('.ex-main'); if (mn2) mn2.scrollTop = keep; body.scrollTop = keepB;
    const t = UI.view === 'run' ? caseOf(S.cur.base).title : UI.view === 'brief' ? caseOf(UI.pick).title : UI.view === 'report' ? S.hist[UI.rv].title : 'Собеседование по этапам';
    $('exTitle').textContent = t;
    clock();
  }
  const strip = () => `<ol class="ex-strip">${ST.map((s, i) => `<li><b>${i + 1}</b><span>${esc(s.title)}</span><small>${s.min} мин</small></li>`).join('')}</ol>`;
  const lvChip = (i, extra) => i == null ? '<span class="ex-lv">—</span>' : `<span class="ex-lv lv-${LV[i].cls}">${esc(LV[i].name)}${extra ? ' · ' + esc(extra) : ''}</span>`;
  function viewPick() {
    let h = `<p class="ex-life"><b>Как это будет на собеседовании:</b> одна задача и около 40 минут разговора. Ты спрашиваешь, считаешь, предлагаешь вызовы, рисуешь схему и защищаешь её от вопросов «а что, если…». Здесь всё то же, только интервьюер — симулятор, а давления нет: таймер — для ориентира, его можно выключить.</p>`;
    h += `<p class="ex-lede">Пять этапов, по каждому — уровень по рубрике: ниже ожиданий, джун, мидл или сеньор, с объяснением. В конце — отчёт: сильные стороны, что подтянуть со ссылками на уровни и лаборатории, итоговый уровень и экспорт в Markdown вместе со схемой.</p>${strip()}`;
    if (S.cur) { const C = caseOf(S.cur.base); h += `<div class="ex-resume"><div><b>Идёт экзамен: ${esc(C.title)}</b><small>Этап «${esc(ST[S.cur.stage].title)}»</small></div><button class="btn primary" type="button" data-exresume>Продолжить</button><button class="btn ghost danger" type="button" data-exabandon>Бросить</button></div>`; }
    const best = {};
    S.hist.forEach(r => { best[r.base] = Math.max(best[r.base] == null ? -1 : best[r.base], r.final.idx); });
    h += `<h3 class="ex-h3">Кейсы · ${SD.free.cases().length}</h3><div class="ex-cases">${SD.free.cases().map(L => `<button type="button" class="ex-case" data-expick="${esc(L.id)}"><span class="ex-case-n">${esc(SD.levelLabel(L))}${best[L.id] != null ? lvChip(best[L.id]) : ''}</span><b>${esc(L.title)}</b><small>${esc(String(L.story || '').split('. ')[0])}.</small></button>`).join('')}</div>`;
    if (S.hist.length) h += `<h3 class="ex-h3">История экзаменов</h3><div class="ex-hist">${S.hist.map((r, i) => `<button type="button" data-exhist="${i}"><span>${new Date(r.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span><b>${esc(r.title)}</b><span>${mmss(r.dur)}</span>${lvChip(r.final.idx, Math.round(r.final.s * 100) + ' / 100')}</button>`).join('')}</div>`;
    return h;
  }
  function viewBrief() {
    const C = caseOf(UI.pick), A = SD.app && SD.app.A;
    const carry = A && A.level && A.level.free && A.level.free.base === UI.pick && realNodes(A.graph).length;
    let h = `<p class="ex-life"><b>Задача от интервьюера:</b> «Спроектируй: ${esc(C.title.toLowerCase())}». Больше он ничего не скажет, пока не спросишь, — как заказчик, который уверен, что всё и так понятно.</p>`;
    h += `<h3 class="ex-h3">Этапы</h3>${strip()}<h3 class="ex-h3">Правила</h3><ul class="ex-rules"><li>Подробности кейса — только в ответах на вопросы. Хорошая практика — 4–6 вопросов до схемы.</li><li>После каждого этапа — «Зафиксировать»: увидишь уровень по рубрике и верные ответы. Вернуться к этапу можно, переписать зафиксированное — нет, как в разговоре.</li><li>Схема собирается на площадке, как в свободном режиме: палитра полная, подсказок нет. Оценку даёт тот же разбор на 100 баллов.</li><li>Углубление — вопросы под твою схему; каждый ответ проверяет симулятор.</li><li>Таймер ничего не отнимает: за перерасход времени баллы не снимаются.</li></ul>`;
    if (carry) h += `<p class="ex-note">Схема, которую ты собрал на площадке, станет черновиком этапа «Схема».</p>`;
    h += `<label class="ex-toggle"><input type="checkbox" data-exnotimer ${S.noTimer ? 'checked' : ''}><span>Без таймера</span></label>`;
    h += `<div class="ex-nav">${S.cur && S.cur.base !== UI.pick ? '<span class="ex-note">Сначала заверши или брось текущий экзамен.</span><button class="btn" type="button" data-exresume>К текущему</button>' : `<button class="btn primary" type="button" data-exstart="${esc(UI.pick)}">Начать экзамен</button>`}<button class="btn ghost" type="button" data-exlist>← Все кейсы</button></div>`;
    return h;
  }
  function viewRun() {
    const c = S.cur, sc = scores(c);
    let h = `<div class="ex-run"><aside class="ex-rail"><ol class="ex-stages">`;
    ST.forEach((s, i) => {
      const done = s.id === 'hld' ? !!c.hld.ev : s.id === 'deep' ? !!(c.deep.qs && c.deep.qs.length && c.deep.qs.every(q => c.deep.ans[q.id] != null)) : c[s.id].lock;
      const lv = done && sc[s.id].s != null ? lvOf(s.id, sc[s.id].s) : null;
      h += `<li class="${i === c.stage ? 'on' : ''} ${done ? 'done' : ''}"><button type="button" data-exstage="${i}"><i>${done ? '✓' : i + 1}</i><span>${esc(s.title)}<small>${lv != null ? esc(LV[lv].name) : s.min + ' мин'}</small></span>${c.timer ? `<em data-exst="${s.id}">${mmss(c.stageT[s.id] || 0)}</em>` : ''}</button></li>`;
    });
    h += `</ol><button class="btn" type="button" data-exfinish>Завершить и получить отчёт</button><label class="ex-toggle"><input type="checkbox" data-exnotimer ${c.timer ? '' : 'checked'}><span>Без таймера</span></label><button class="btn ghost" type="button" data-exlist>Все кейсы</button></aside><section class="ex-main">`;
    const st = ST[c.stage], life = LIFE[st.id];
    h += `<span class="ex-eb">Этап ${c.stage + 1} из ${ST.length} · ориентир ${st.min} мин</span><h2 class="ex-h">${esc(st.title)}</h2><p class="ex-life"><b>Как на собеседовании:</b> ${esc(life[0])}</p><p class="ex-lede">${esc(life[1])}</p>`;
    h += st.id === 'req' ? stReq(c) : st.id === 'est' ? stEst(c) : st.id === 'api' ? stApi(c) : st.id === 'hld' ? stHld(c) : stDeep(c);
    const fb = st.id === 'hld' ? !!c.hld.ev && c.hld.sig === sigOf(c.hld.spec) : st.id === 'deep' ? !!(c.deep.qs && c.deep.qs.length && c.deep.qs.every(q => c.deep.ans[q.id] != null)) : c[st.id].lock;
    if (fb) h += feedback(st.id, sc[st.id]);
    h += `<div class="ex-nav"><button class="btn" type="button" data-exnav="-1" ${c.stage ? '' : 'disabled'}>← Назад</button>`;
    if (['req', 'est', 'api'].includes(st.id) && !c[st.id].lock) h += `<button class="btn" type="button" data-exlock>Зафиксировать ответ</button>`;
    h += c.stage < ST.length - 1 ? `<button class="btn primary" type="button" data-exnav="1">Дальше: ${esc(ST[c.stage + 1].title)} →</button>` : `<button class="btn primary" type="button" data-exfinish>Завершить и получить отчёт</button>`;
    h += `</div></section></div>`;
    return h;
  }
  function feedback(sid, v) {
    if (v.s == null) return `<div class="ex-fb"><p>${esc(v.det)}</p></div>`;
    const i = lvOf(sid, v.s);
    return `<div class="ex-fb lv-${LV[i].cls}"><div class="ex-fb-h">${lvChip(i)}<b>${Math.round(v.s * 100)} из 100</b></div><p>${esc(RUB[sid][i])}</p><small>${esc(v.det)}${i < 3 ? ` · до уровня «${LV[i + 1].name}»: ${esc(RUB[sid][i + 1].toLowerCase())}` : ''}</small></div>`;
  }
  function stReq(c) {
    const C = caseOf(c.base), a = c.req, lk = a.lock;
    let h = `<section class="ex-card"><h3>Спроси заказчика</h3><p class="ex-sub">Ответ приходит только на заданный вопрос. Вопросы мимо архитектуры отнимают время.</p><div class="ex-asks">`;
    C.asks.forEach(x => {
      const asked = a.asked.includes(x.id);
      h += asked ? `<div class="ex-qa ${x.bad ? 'off' : ''}"><b>${esc(x.q)}</b><span>${esc(x.a)}</span></div>` : `<button type="button" class="ex-ask" data-exask="${x.id}" ${lk ? 'disabled' : ''}>${esc(x.q)}</button>`;
    });
    h += `</div></section><section class="ex-card"><h3>Что система делает · функциональные</h3><p class="ex-sub">Отметь, что входит в первую версию. Лишнее — тоже ошибка.</p><div class="ex-checks">`;
    C.fr.forEach(x => {
      const on = a.fr.includes(x.id), st = lk ? (x.ok && on ? 'ok' : x.ok ? 'miss' : on ? 'bad' : '') : '';
      h += `<label class="ex-check ${st}"><input type="checkbox" data-exfr="${x.id}" ${on ? 'checked' : ''} ${lk ? 'disabled' : ''}><span>${esc(x.t)}${lk && st === 'miss' ? ' <em>пропущено</em>' : lk && st === 'bad' ? ' <em>лишнее</em>' : ''}</span></label>`;
    });
    h += `</div><label class="ex-own"><span>Своими словами (по желанию, попадёт в отчёт)</span><textarea data-exown rows="2" ${lk ? 'disabled' : ''} placeholder="Например: короткий код не длиннее 7 символов, ссылки живут 5 лет">${esc(a.own)}</textarea></label></section>`;
    h += `<section class="ex-card"><h3>Какой она должна быть · нефункциональные</h3><p class="ex-sub">Выбери число, которое зафиксируешь. Не знаешь — спроси выше.</p><div class="ex-nfr">`;
    C.nfr.forEach(r => {
      const mine = a.nfr[r.id];
      h += `<div class="ex-nfr-row"><span>${esc(r.t)}</span><div class="ex-seg" role="group" aria-label="${esc(r.t)}">${r.opts.map((o, i) => `<button type="button" data-exnfr="${r.id}:${i}" aria-pressed="${mine === i}" class="${lk ? (i === r.ok ? 'right' : mine === i ? 'wrong' : '') : ''}" ${lk ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div></div>`;
    });
    return h + '</div></section>';
  }
  function stEst(c) {
    const C = caseOf(c.base), lk = c.est.lock;
    if (!C.est.length) return '<p class="ex-note">Для этого кейса расчёт на салфетке недоступен — этап не влияет на итог.</p>';
    const sc = scoreEst(c, C);
    let h = '<div class="ex-cheat"><b>Шпаргалка</b><span>сутки ≈ 86 400 с ≈ 10⁵ с</span><span>1 млн в сутки ≈ 12 в секунду</span><span>пик ≈ ×3 от среднего</span><span>загрузка не выше 75 %</span></div><div class="ex-est">';
    C.est.forEach((s, i) => {
      const r = sc.rows[i];
      h += `<section class="ex-card ex-est-row ${lk ? r.g : ''}"><div class="ex-est-h"><span class="ex-n">${i + 1}</span><b>${esc(s.title)}</b>${lk ? `<span class="ex-g ${r.g}">${r.g === 'ok' ? '✓ в пределах ±30 %' : r.g === 'order' ? '≈ порядок верный' : '✗ мимо'}</span>` : ''}</div><p class="ex-sub">${esc(s.an)}</p><p>${esc(s.q)}</p><div class="ex-in"><input type="text" inputmode="decimal" autocomplete="off" data-exest="${s.id}" value="${esc((c.est.v || {})[s.id] || '')}" placeholder="твоя оценка" aria-label="${esc(s.title)}" ${lk ? 'disabled' : ''}><span>${esc(s.unit)}</span></div>`;
      if (lk) h += `<div class="ex-ans"><b>По расчёту: ${fmtAns(s.ans)} ${esc(s.unit)}</b><ul>${s.how.filter(Boolean).map(x => `<li>${String(x).replace(/<(?!\/?b>)[^>]*>/g, '')}</li>`).join('')}</ul></div>`;
      h += '</section>';
    });
    return h + '</div>';
  }
  function stApi(c) {
    const C = caseOf(c.base), lk = c.api.lock, sel = c.api.sel;
    let h = '<div class="ex-ops">';
    C.ops.forEach(o => {
      const s = sel[o.id] || {}, on = !!s.on;
      const sc = lk && o.core ? opScore(o, s) : null;
      const st = lk ? (o.core ? (!on ? 'miss' : sc.s >= 0.75 ? 'ok' : sc.s >= 0.4 ? 'half' : 'bad') : on ? 'bad' : 'ok') : '';
      h += `<section class="ex-card ex-op ${on ? 'on' : ''} ${st}"><label class="ex-op-h"><input type="checkbox" data-exop="${o.id}" ${on ? 'checked' : ''} ${lk ? 'disabled' : ''}><b>${esc(o.t)}</b><small>${on ? 'в API' : 'не нужен?'}</small></label>`;
      if (on && o.core) {
        h += `<div class="ex-op-row"><span>Как вызвать</span><div class="ex-seg">${METHODS.map(([k, t]) => `<button type="button" data-exm="${o.id}:${k}" aria-pressed="${s.m === k}" ${lk ? 'disabled' : ''} class="${lk && k === o.m ? 'right' : lk && s.m === k ? 'wrong' : ''}">${t}</button>`).join('')}</div></div>`;
        h += `<div class="ex-op-row"><span>Ответ</span><div class="ex-seg">${RESP.map(([k, t]) => `<button type="button" data-exr="${o.id}:${k}" aria-pressed="${s.r === k}" ${lk ? 'disabled' : ''} class="${lk && k === o.r ? 'right' : lk && s.r === k ? 'wrong' : ''}">${t}</button>`).join('')}</div></div>`;
        h += `<div class="ex-op-row"><span>Свойства</span><div class="ex-props">${o.props.map(k => { const ch = (s.p || []).includes(k), cl = lk ? (o.good.includes(k) ? (ch ? 'ok' : 'miss') : ch && !o.neutral.includes(k) ? 'bad' : '') : ''; return `<label class="ex-check ${cl}"><input type="checkbox" data-exp="${o.id}:${k}" ${ch ? 'checked' : ''} ${lk ? 'disabled' : ''}><span>${esc(PROPS[k])}</span></label>`; }).join('')}</div></div>`;
        h += `<code class="ex-call">${esc(callText(o, s))}</code>`;
      } else if (on) h += `<p class="ex-sub">Добавлен в API.</p>`;
      if (lk) h += `<p class="ex-why">${o.core && (!on || sc.s < 0.999) ? `Как надо: <b>${esc(callText(o, { on: 1, m: o.m, r: o.r, p: o.good }))}</b>. ` : ''}${esc(o.why)}</p>`;
      h += '</section>';
    });
    return h + '</div>';
  }
  function stHld(c) {
    const C = caseOf(c.base), ev = c.hld.ev, stale = ev && c.hld.sig !== sigOf(c.hld.spec);
    let h = `<section class="ex-card"><h3>Что держим в голове</h3><div class="ex-tr">${Object.entries(C.L.traffic).filter(([, v]) => v > 0).map(([k, v]) => `<span><small>${esc(kindName(k))}</small><b>${esc(F().num(v))}/с</b></span>`).join('')}</div>`;
    if (c.req.lock) h += `<ul class="ex-mini">${C.nfr.map(r => `<li>${esc(r.t)}: <b>${esc(r.opts[r.ok])}</b></li>`).join('')}</ul>`;
    else h += '<p class="ex-sub">Числа требований откроются, когда зафиксируешь первый этап.</p>';
    h += `<div class="ex-nav"><button class="btn primary" type="button" data-exbuild>${c.hld.spec && c.hld.spec.nodes.length ? 'Продолжить сборку на площадке →' : 'Собрать на площадке →'}</button>${c.hld.spec && c.hld.spec.nodes.length ? `<button class="btn" type="button" data-exeval>${ev && !stale ? 'Оценить заново' : 'Оценить схему'}</button>` : ''}</div></section>`;
    if (stale) h += '<p class="ex-note">Схема изменилась после оценки — нажми «Оценить схему».</p>';
    if (ev && !ev.empty) {
      const row = (t, v, d) => `<div class="ex-row"><span>${esc(t)}</span><span class="ex-bar"><i class="${v >= 0.8 ? 'ok' : v >= 0.5 ? 'warn' : 'bad'}" style="width:${Math.round(v * 100)}%"></i></span><b>${Math.round(v * 100)}</b><small>${esc(d)}</small></div>`;
      h += `<section class="ex-card"><h3>Разбор схемы · ${ev.total} из 100</h3><p class="ex-sub">${esc(ev.parts.join(', '))}</p><div class="ex-rows">${row('Требования кейса', ev.sc.req, `${ev.goals.filter(x => x.ok).length} из ${ev.goals.length} целей`)}${row('Запас на рост', ev.sc.head, `×1,2 — ${F().pct(ev.s12)}, ×1,5 — ${F().pct(ev.s15)}, ×2 — ${F().pct(ev.s2)}`)}${row('Надёжность', ev.sc.rel, `переживает ${ev.chOk} из ${ev.chN} одиночных падений`)}${row('Цена', ev.sc.cost, `${F().usd(ev.cost)}/мес${ev.rc ? ' · эталон ' + F().usd(ev.rc) : ''}`)}${row('Архитектура', ev.sc.arch, ev.pats.length ? 'паттерны: ' + ev.pats.slice(0, 4).join(', ') : 'паттернов не найдено')}</div>`;
      h += `<div class="ex-cols"><div class="ex-good"><b>Сильное</b>${ev.good.length ? `<ul>${ev.good.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Пока нечем похвастаться.</p>'}</div><div class="ex-fix"><b>Что улучшить</b>${ev.fix.length ? `<ul>${ev.fix.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Замечаний нет.</p>'}</div></div></section>`;
    } else if (ev && ev.empty) h += '<p class="ex-note">Схема пустая — собери систему на площадке.</p>';
    return h;
  }
  function stDeep(c) {
    if (!c.hld.spec || !c.hld.spec.nodes.length) return '<p class="ex-note">Схемы нет — углубляться не во что. Вернись на этап «Схема».</p>';
    ensureDeep(c);
    const qs = c.deep.qs || [];
    if (!qs.length) return '<p class="ex-note">На схеме нет узлов, которые можно испытать.</p>';
    let h = c.deep.changed ? '<p class="ex-note">Схема изменилась — вопросы составлены заново под новую.</p>' : '';
    qs.forEach((q, i) => {
      const a = c.deep.ans[q.id], done = a != null;
      h += `<section class="ex-card ex-q ${done ? (a === q.right ? 'ok' : 'bad') : ''}"><span class="ex-eb">Вопрос ${i + 1} · ${esc(q.kind)}</span><p class="ex-qq">${esc(q.q)}</p><div class="ex-opts">${q.opts.map((o, j) => `<button type="button" class="ex-opt ${done ? (j === q.right ? 'right' : j === a ? 'wrong' : '') : ''}" data-exdeep="${q.id}:${j}" ${done ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>`;
      if (done) h += `<div class="ex-sim"><b>${a === q.right ? '✓ Верно' : (q.part || []).includes(a) ? '≈ Почти: этот узел тоже не выдержит, но не первым' : '✗ Симулятор думает иначе'}</b><p>${esc(q.sim)} ${esc(q.why)}</p>${q.fix ? `<p class="ex-sub">${esc(q.fix)}</p>` : ''}</div>`;
      h += '</section>';
    });
    return h;
  }
  /* ---------- отчёт ---------- */
  let GO = [];
  function viewReport(r) {
    GO = [];
    const fi = r.final.idx;
    let h = `<div class="ex-top"><div class="ex-ring lv-${LV[fi].cls}"><b>${esc(LV[fi].name)}</b><small>${Math.round(r.final.s * 100)} из 100</small></div><div><span class="ex-eb">Итог экзамена · ${new Date(r.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} · ${mmss(r.dur)}</span><p class="ex-voice">${esc(VOICE[fi])}</p><p class="ex-sub">Итог — взвешенная сумма этапов: схема 35 %, углубление 20 %, остальное по 15 %. Если схема не работает, итог не выше, чем на ступень над её уровнем; «сеньор» — когда ни один этап не ниже «мидла».</p></div></div>`;
    h += '<div class="ex-table">';
    ST.forEach(x => { const s = r.stages[x.id]; h += `<div class="ex-tr-row"><span class="ex-tn">${esc(x.title)}</span>${lvChip(s.lv)}<span class="ex-td">${esc(s.lv == null ? s.det : RUB[x.id][s.lv])}<small>${esc(s.det)}${s.t ? ' · ' + mmss(s.t) : ''}</small></span></div>`; });
    h += '</div>';
    h += `<div class="ex-cols"><div class="ex-good"><b>Сильные стороны</b>${r.good.length ? `<ul>${r.good.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Пока отметить нечего — всё впереди.</p>'}</div><div class="ex-fix"><b>Что подтянуть</b>`;
    if (!r.gaps.length) h += '<p>Замечаний нет. Попробуй кейс посложнее.</p>';
    r.gaps.forEach(g => {
      h += `<div class="ex-gap"><p><em>${esc(ST.find(x => x.id === g.stage).title)}.</em> ${esc(g.text)}</p>${g.links.length ? `<div class="ex-links">${g.links.map(l => { GO.push(l); return `<button type="button" class="ex-link" data-exgo="${GO.length - 1}">${esc(l.title)}${l.why ? `<small>${esc(l.why)}</small>` : ''}</button>`; }).join('')}</div>` : ''}</div>`;
    });
    h += '</div></div>';
    h += `<section class="ex-card"><h3>Экспорт в Markdown</h3><p class="ex-sub">Отчёт целиком: этапы, ответы, разбор и схема — для наставника, заметок или портфолио.</p><div class="ex-seg" role="group" aria-label="Формат схемы"><button type="button" data-exfmt="mermaid" aria-pressed="${UI.fmt === 'mermaid'}">Схема: Mermaid</button><button type="button" data-exfmt="c4" aria-pressed="${UI.fmt === 'c4'}">Схема: C4 · PlantUML</button></div><textarea class="ex-md" id="exMd" readonly spellcheck="false" rows="12">${esc(markdown(r, UI.fmt))}</textarea><div class="ex-nav"><button class="btn primary" type="button" data-excopy>Скопировать</button><button class="btn" type="button" data-exdl>Скачать .md</button><span class="ex-note" id="exCopied">${esc(UI.copied)}</span></div></section>`;
    h += `<div class="ex-nav"><button class="btn primary" type="button" data-exagain="${esc(r.base)}">Сдать этот кейс ещё раз</button><button class="btn" type="button" data-expathopen>Открыть «Мой путь»</button><button class="btn ghost" type="button" data-exlist>Все кейсы и история</button></div>`;
    return h;
  }
  function goLink(l) {
    if (!l) return;
    close();
    if (l.kind === 'lab') { if (SD.labLinks && SD.labLinks.open) SD.labLinks.open({ lab: l.id, tab: l.tab }); else SD.labs.open(l.id); return; }
    if (l.kind === 'level') { const L = SD.levelById(l.id); if (L) SD.app.loadLevel(L); return; }
    if (l.kind === 'calc') { const L = SD.levelById(l.id); if (L && SD.calc) SD.calc.open(L); return; }
    if (l.kind === 'path') { if (SD.path) SD.path.open(); return; }
    if (l.kind === 'pattern' && SD.patterns) SD.patterns.open(l.id);
  }
  function copyMd() {
    const t = $('exMd'); if (!t) return;
    const ok = () => { UI.copied = 'Скопировано.'; const n = $('exCopied'); if (n) n.textContent = UI.copied; };
    const fall = () => { t.select(); try { document.execCommand('copy'); ok(); } catch (e) { const n = $('exCopied'); if (n) n.textContent = 'Выдели текст и нажми Ctrl+C.'; } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(ok, fall); else fall();
  }
  function download(r) {
    try {
      const b = new Blob([markdown(r, UI.fmt)], { type: 'text/markdown;charset=utf-8' }), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = `ekzamen-${r.base}-${new Date(r.at).toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (e) { copyMd(); }
  }

  /* ---------- события ---------- */
  function onClick(e) {
    const m = $('exModal');
    if (e.target === m || e.target.closest('[data-exx]')) { close(); return; }
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset, c = S.cur;
    if (d.expick) { UI.pick = d.expick; UI.view = S.cur && S.cur.base === d.expick ? 'run' : 'brief'; render(); scrollTop(); return; }
    if (d.exstart) { start(d.exstart); return; }
    if ('exresume' in d) { UI.view = 'run'; render(); scrollTop(); return; }
    if ('exabandon' in d) { S.cur = null; save(); render(); updateBar(); return; }
    if ('exlist' in d) { UI.view = 'pick'; render(); scrollTop(); return; }
    if (d.exhist) { UI.rv = +d.exhist; UI.copied = ''; UI.view = 'report'; render(); scrollTop(); return; }
    if (d.exagain) { UI.pick = d.exagain; UI.view = S.cur ? (S.cur.base === d.exagain ? 'run' : 'brief') : 'brief'; render(); scrollTop(); return; }
    if ('exfinish' in d) { finish(); return; }
    if ('expathopen' in d) { close(); if (SD.path) SD.path.open(); return; }
    if (d.exgo) { goLink(GO[+d.exgo]); return; }
    if (d.exfmt) { UI.fmt = d.exfmt; render(); return; }
    if ('excopy' in d) { copyMd(); return; }
    if ('exdl' in d) { download(S.hist[UI.rv]); return; }
    if (!c) return;
    if (d.exstage) { go(+d.exstage); return; }
    if (d.exnav) { lock(c, ST[c.stage].id); go(c.stage + +d.exnav); return; }
    if ('exlock' in d) { lock(c, ST[c.stage].id); save(); render(); return; }
    if (d.exask) { if (!c.req.asked.includes(d.exask)) c.req.asked.push(d.exask); save(); render(); return; }
    if (d.exnfr) { const [id, i] = d.exnfr.split(':'); c.req.nfr[id] = +i; save(); render(); return; }
    if (d.exm || d.exr) { const [id, k] = (d.exm || d.exr).split(':'); const s = c.api.sel[id] = c.api.sel[id] || { on: true, p: [] }; s[d.exm ? 'm' : 'r'] = k; save(); render(); return; }
    if ('exbuild' in d) { build(); return; }
    if ('exeval' in d) { evalHld(c); save(); render(); return; }
    if (d.exdeep) { const [id, j] = d.exdeep.split(':'); if (c.deep.ans[id] == null) c.deep.ans[id] = +j; save(); render(); }
  }
  function onInput(e) {
    const t = e.target, c = S.cur; if (!c) return;
    if (t.dataset.exest) { c.est.v[t.dataset.exest] = t.value; save(); }
    if ('exown' in t.dataset) { c.req.own = t.value; save(); }
  }
  function onChange(e) {
    const t = e.target, d = t.dataset, c = S.cur;
    if ('exnotimer' in d) { S.noTimer = t.checked; if (c) c.timer = !t.checked; save(); render(); return; }
    if (!c) return;
    if (d.exfr) { const a = c.req.fr, i = a.indexOf(d.exfr); if (t.checked && i < 0) a.push(d.exfr); if (!t.checked && i >= 0) a.splice(i, 1); save(); render(); return; }
    if (d.exop) { const s = c.api.sel[d.exop] = c.api.sel[d.exop] || { p: [] }; s.on = t.checked; save(); render(); return; }
    if (d.exp) { const [id, k] = d.exp.split(':'); const s = c.api.sel[id] = c.api.sel[id] || { on: true, p: [] }; s.p = s.p || []; const i = s.p.indexOf(k); if (t.checked && i < 0) s.p.push(k); if (!t.checked && i >= 0) s.p.splice(i, 1); save(); render(); }
  }

  /* ---------- время и плашка на холсте ---------- */
  function clock() {
    const c = S.cur, el = $('exClock');
    if (el) {
      const show = !!(c && c.timer && UI.view === 'run');
      el.hidden = !show;
      if (show) { const st = ST[c.stage], v = c.stageT[st.id] || 0, over = v > st.min * 60; el.textContent = over ? `${st.title}: ${mmss(v)} · время этапа вышло, без штрафа` : `${st.title}: ${mmss(v)} из ${st.min}:00`; el.classList.toggle('over', over); }
    }
    if (c) document.querySelectorAll('[data-exst]').forEach(x => { x.textContent = mmss(c.stageT[x.dataset.exst] || 0); });
    const bc = $('exBarClock');
    if (bc && c) { const v = c.stageT.hld || 0; bc.textContent = c.timer ? `${mmss(v)} из 15:00` : ''; }
  }
  function updateBar() {
    let b = $('exBar');
    const c = S.cur, m = $('exModal'), on = !!(c && c.stage === 3 && onCanvas() && (!m || m.hidden));
    if (!b && !on) return;
    if (!b) {
      b = document.createElement('div'); b.id = 'exBar'; b.className = 'ex-dock'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Экзамен');
      b.innerHTML = '<span class="ex-dock-t"><b>Экзамен · этап 4 из 5 · Схема</b><span id="exBarClock"></span></span><button class="btn primary" type="button" data-exdone>Готово — оценить схему</button><button class="btn ghost" type="button" data-exback>К этапам</button>';
      ($('canvasWrap') || document.body).appendChild(b);
      b.addEventListener('click', e => { if (e.target.closest('[data-exdone]')) back(true); else if (e.target.closest('[data-exback]')) back(false); });
    }
    b.hidden = !on;
    clock();
  }
  let ticks = 0;
  function tick() {
    const c = S.cur, m = $('exModal');
    if (c) {
      const vis = (m && !m.hidden && UI.view === 'run') || (c.stage === 3 && onCanvas());
      if (vis) { const id = ST[c.stage].id; c.stageT[id] = (c.stageT[id] || 0) + 1; }
      if (++ticks % 5 === 0) { if (c.stage === 3 && onCanvas()) snap(); save(); }
    }
    updateBar();
  }

  /* ---------- вход: Ctrl+K, свободный режим, хук ---------- */
  (SD.cmdExtra = SD.cmdExtra || []).push(add => add('Учиться', 'Экзамен: собеседование по этапам', 'требования → нагрузка → API → схема → углубление, отчёт с уровнем', () => open(), 'экзамен собеседование интервью system design рубрика уровень джун мидл сеньор отчёт markdown'));
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-examfree]'); if (!b) return;
    const A = SD.app && SD.app.A, L = A && A.level; if (!L || !L.free) return;
    if (inFree(L)) { back(false); return; }
    UI.carry = true; open(L.free.base);
  });
  document.addEventListener('keydown', e => { const m = $('exModal'); if (e.key === 'Escape' && m && !m.hidden) close(); });
  const inFree = L => !!(S.cur && L && L.free && L.free.base === S.cur.base);
  let booted = false;
  function boot() {
    if (booted) return;
    if (!(SD.app && SD.app.A && SD.app.A.level && SD.free && SD.walk)) { setTimeout(boot, 120); return; }
    booted = true;
    setInterval(tick, 1000);
    updateBar();
  }
  setTimeout(boot, 0);

  SD.exam = { open, close, start, finish, inFree, markdown, report: () => S.hist[0] || null, history: () => S.hist.slice(), cur: () => S.cur, caseOf, back,
    /* для тестов: собрать сессию и отчёт без окна */
    _fresh: fresh, _report: report, _scores: scores, _final: finalOf, _deepQs: deepQs, _evalHld: evalHld, _specFrom: specFrom, _graphOf: graphOf, _ensureDeep: ensureDeep, _opScore: opScore };
})();
