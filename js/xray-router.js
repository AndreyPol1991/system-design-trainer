/* «Роутер моделей изнутри»: классификатор сложности, правила маршрута, пул моделей со схемы, фолбэк и предохранитель,
   ошибка маршрутизации и каскад, цена и качество в рублях.
   Ситуации: как на схеме, обманчивые вопросы, провайдер упал, лимит 429, счёт за месяц. */
(function () {
  SD.XRAY = SD.XRAY || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f1 = v => (+v).toFixed(1);
  const pl = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
  const nf = (v, d) => { const s = (+v).toFixed(d || 0).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' '); return s.join(','); };
  const ease = k => { k = clamp(k, 0, 1); return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const along = (pts, k) => { k = clamp(k, 0, 1); const ls = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); ls.push(l); tot += l; } let d = k * tot; for (let i = 0; i < ls.length; i++) { if (d <= ls[i] || i === ls.length - 1) return lerp(pts[i], pts[i + 1], ls[i] ? clamp(d / ls[i], 0, 1) : 1); d -= ls[i]; } return pts[pts.length - 1]; };
  const ES = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T = (x, y, t, c, a) => `<text class="${c || 'xr-s'}" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const R = (x, y, w, h, c, rx) => `<rect class="${c}" x="${f1(x)}" y="${f1(y)}" width="${f1(Math.max(0, w))}" height="${f1(Math.max(0, h))}" rx="${rx == null ? 6 : rx}"/>`;
  const Ln = (x1, y1, x2, y2, c) => `<line class="${c}" x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
  const Dot = (x, y, r, c, st) => `<circle class="xr-dot ${c || ''}" cx="${f1(x)}" cy="${f1(y)}" r="${r}"${st ? ` style="${st}"` : ''}/>`;
  const MONO = (x, y, t, c, a) => `<text class="xrt-mono${c ? ' ' + c : ''}" xml:space="preserve" x="${f1(x)}" y="${f1(y)}"${a ? ` text-anchor="${a}"` : ''}>${t}</text>`;
  const BTN = (x, y, w, act, label, on) => `<g class="xrt-btn${on ? ' on' : ''}" data-xrt="${act}" role="button" tabindex="0">${R(x, y, w, 24, '', 7)}<text x="${f1(x + w / 2)}" y="${f1(y + 16)}">${ES(label)}</text></g>`;
  const XM = (x, y, r) => `<path class="xrt-x" d="M${f1(x - r)} ${f1(y - r)}L${f1(x + r)} ${f1(y + r)}M${f1(x + r)} ${f1(y - r)}L${f1(x - r)} ${f1(y + r)}"/>`;
  const wrap = (s, n) => { const out = []; let line = ''; String(s).split(' ').forEach(w => { if ((line + ' ' + w).trim().length > n) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); }); if (line) out.push(line); return out; };

  const RUB = 90, MONTH = 2.63e6, ORDER = ['small', 'medium', 'large'];
  const SHORT = { small: 'малая 8B', medium: 'средняя 70B', large: 'большая' };
  const STRAT = { cost: 'по сложности', quality: 'всё в сильную', balance: 'поровну' };
  const TO = 2000, BRK = 3, OPEN = 12000;             // таймаут вызова, ошибок подряд до размыкания, пауза предохранителя (время сцены)
  const GEN = { small: 900, medium: 1500, large: 2200 }; // сколько модель «думает» на экране
  const rub = v => v >= 1e6 ? nf(v / 1e6, 1) + ' млн ₽' : v >= 1000 ? nf(v / 1000) + ' тыс. ₽' : v >= 10 ? nf(v) + ' ₽' : v >= 0.1 ? nf(v, 2) + ' ₽' : v > 0 ? nf(v, 3) + ' ₽' : '0 ₽';
  const ms = v => v >= 1000 ? nf(v / 1000, Math.round(v / 100) % 10 ? 1 : 0) + ' с' : Math.round(v) + ' мс';
  const pct = v => Math.round(v * 100) + ' %';

  /* ---------- вопросы: признаки сложности и их веса (оценка = сумма), s — на самом деле простой, tr — обманчивый ---------- */
  const DOM = {
    bank: {
      who: 'банк «Колос»',
      qs: [
        { q: 'Как заблокировать карту?', s: 1, f: [['коротко: 3 слова', 0.06], ['«как сделать»', 0.06]] },
        { q: 'Сколько стоит обслуживание карты «Кэшбэк»?', s: 1, f: [['5 слов', 0.08], ['«сколько стоит»', 0.08], ['название продукта', 0.04]] },
        { q: 'Где посмотреть реквизиты счёта?', s: 1, f: [['4 слова', 0.07], ['«где»', 0.05]] },
        { q: 'Сравни вклады «Доход» и «Свобода», если снимать деньги раз в квартал', s: 0, f: [['11 слов', 0.18], ['«сравни»', 0.3], ['«если»', 0.2]] },
        { q: 'Почему 12 мая с меня списали 350 ₽ комиссии?', s: 0, f: [['8 слов', 0.13], ['«почему»', 0.25], ['дата и сумма', 0.2]] },
        { q: 'Посчитай переплату по кредиту 500 000 ₽ на 3 года', s: 0, f: [['9 слов', 0.14], ['«посчитай»', 0.3], ['числа', 0.2]] },
        { q: 'А если закрыть досрочно?', s: 0, tr: 1, f: [['коротко: 4 слова', 0.06], ['«если»', 0.2]], why: 'нужен контекст диалога и пересчёт процентов' },
        { q: 'Здравствуйте! Я давно ваш клиент, всё нравится. Подскажите, пожалуйста, как заблокировать карту, если потерял?', s: 1, tr: 1, f: [['16 слов', 0.27], ['«если»', 0.2], ['вежливые слова', 0.06]], why: 'простая инструкция в длинной вежливой обёртке' },
        { q: 'Это законно?', s: 0, tr: 1, f: [['коротко: 2 слова', 0.04]], why: 'юридическая оценка по всему диалогу' },
        { q: 'Перечислите офисы в Казани, которые работают в субботу и воскресенье', s: 1, tr: 1, f: [['10 слов', 0.17], ['перечисление', 0.15], ['два условия', 0.18]], why: 'справка из списка офисов' }
      ]
    },
    shop: {
      who: 'маркетплейс',
      qs: [
        { q: 'Где мой заказ?', s: 1, f: [['коротко: 3 слова', 0.05], ['«где»', 0.05]] },
        { q: 'Как вернуть товар?', s: 1, f: [['коротко: 3 слова', 0.05], ['«как сделать»', 0.06]] },
        { q: 'Сколько идёт доставка в Казань?', s: 1, f: [['5 слов', 0.08], ['«сколько»', 0.06], ['город', 0.04]] },
        { q: 'Подбери ноутбук для монтажа видео до 120 000 ₽ и сравни три варианта', s: 0, f: [['12 слов', 0.2], ['«подбери»', 0.22], ['«сравни»', 0.3]] },
        { q: 'Почему мне не пришёл кэшбэк за заказ 7741?', s: 0, f: [['8 слов', 0.13], ['«почему»', 0.25], ['номер заказа', 0.15]] },
        { q: 'Объясни, чем отличаются эти два пылесоса и какой взять для квартиры с котом', s: 0, f: [['13 слов', 0.22], ['«объясни»', 0.25], ['выбор из двух', 0.2]] },
        { q: 'А с котом подойдёт?', s: 0, tr: 1, f: [['коротко: 4 слова', 0.06], ['вопрос-продолжение', 0.1]], why: 'нужно помнить, о каком товаре речь, и сравнить' },
        { q: 'Добрый день! Заказываю у вас давно, всё хорошо. Подскажите, пожалуйста, во сколько закрывается пункт выдачи на Ленина, 5?', s: 1, tr: 1, f: [['18 слов', 0.3], ['вежливые слова', 0.06], ['адрес и время', 0.18]], why: 'справка о часах работы в вежливой обёртке' },
        { q: 'Это оригинал?', s: 0, tr: 1, f: [['коротко: 2 слова', 0.04]], why: 'проверка продавца, документов и отзывов' },
        { q: 'Перечислите пункты выдачи в Казани, которые работают в воскресенье', s: 1, tr: 1, f: [['9 слов', 0.15], ['перечисление', 0.15], ['условие', 0.2]], why: 'справка из списка пунктов' }
      ]
    }
  };
  const scoreOf = it => it.f.reduce((a, x) => a + x[1], 0);

  /* ---------- геометрия ---------- */
  const QB = { x: 16, y: 46, w: 300, h: 226 }, PB = { x: 16, y: 280, w: 300, h: 112 }, RB = { x: 376, y: 112, w: 220, h: 132 }, FB = { x: 336, y: 256, w: 302, h: 136 };
  const MZ = { x: 660, y: 46, w: 324, h: 346 }, CB = { x: 16, y: 402, w: 420, h: 150 }, JB = { x: 446, y: 402, w: 538, h: 150 };
  const SRC = [486, 86], RIN = [486, 112], RCORN = [596, 112], ROUT = [596, 178];

  SD.XRAY.router = {
    viewBox: '0 0 1000 560',
    cta: 'Как вопрос получает оценку сложности и уходит в малую или сильную модель, доля маршрутов, цена и качество, ошибки маршрута и запасная модель',
    dive: 'llmops',
    simple: () => ({
      an: 'Как <b>регистратура в поликлинике</b>: по жалобе решает, к кому идти — к фельдшеру (быстро и недорого) или к профессору (дорого, но справится со сложным). Если врач заболел, пациента ведут к дежурному, а не отправляют домой.',
      pl: 'Роутер стоит перед моделями. За пару миллисекунд он оценивает вопрос: простые отдаёт малой дешёвой модели, сложные — сильной. Если модель упала или ответила 429 «слишком много запросов», роутер отправляет запрос в запасную. Ещё он держит ключи провайдеров, лимиты и считает токены.'
    }),
    props: ['strategy', 'failover'],
    scenarios: [
      { id: 'norm', name: 'Как на схеме', note: 'Обычный поток вопросов: роутер делит его по сложности между моделями со схемы.' },
      { id: 'tricky', name: 'Обманчивые вопросы', note: 'Короткие сложные и длинные простые вопросы: классификатор ошибается.' },
      { id: 'down', name: 'Провайдер упал', note: 'Малая модель первого провайдера не отвечает: таймауты, фолбэк и предохранитель.' },
      { id: 'limit', name: 'Лимит 429', note: 'Всплеск ×5, а у провайдера малой модели базовый лимит — 10 запросов/с.' },
      { id: 'bill', name: 'Счёт за месяц', note: 'Вопросов втрое больше: сравни стратегии по цене и качеству.' }
    ],
    tries: [
      { id: 'split', text: 'В «Как на схеме» дождись простого вопроса в малой модели и сложного — в сильной' },
      { id: 'cascade', text: 'В «Обманчивых вопросах» включи каскад и поймай сложный вопрос, который малая модель передала сильной' },
      { id: 'down', text: 'В «Провайдер упал» дождись, когда предохранитель разомкнётся и запрос уйдёт в запасную модель без ожидания' },
      { id: 'limit', text: 'В «Лимите 429» выключи фолбэк и увидь 429 у пользователя, потом включи — запрос уйдёт другой модели' },
      { id: 'strat', text: 'В «Счёте за месяц» переключи стратегию на «всё в сильную», потом обратно на «по сложности» — сравни цену' },
      { id: 'pthr', text: 'Открой блок «Классификатор сложности» и подними порог до 0,7 — посмотри, сколько сложных уйдёт в малую' }
    ],
    parts: {
      classify: {
        name: 'Классификатор сложности', knobs: ['strategy'],
        an: 'Как <b>медсестра на приёме</b>: по паре вопросов решает, хватит ли фельдшера или нужен профессор. Обычно угадывает, но короткая жалоба может скрывать сложный случай.',
        pl: 'Перед вызовом модели роутер за 1–3 мс ставит вопросу оценку сложности от 0 до 1. Ниже порога — малая модель, выше — сильная. Оценку дают простые признаки (длина, слова «сравни», «почему», «посчитай», числа) или маленькая модель-классификатор, обученная на размеченных вопросах.',
        how: ['Из вопроса достают признаки: длина, слова-маркеры, числа и даты, несколько вопросов в одном.', 'Каждый признак добавляет к оценке свой вес: «сравни» +0,3, «почему» +0,25.', 'Чаще вместо ручных весов — маленький классификатор: эмбеддинг вопроса и логистическая регрессия или модель на 100–300 млн параметров.', 'Оценка ниже порога — малая модель, выше — сильная.', 'Классификатор учат на логах: вопросы, на которые малая модель ответила плохо, размечают как сложные.', 'Ошибается на коротких сложных («А если досрочно?») и длинных простых вопросах.'],
        watch: 'Слева вверху — текущий вопрос, его признаки с весами, оценка и порог. После ответа видно, угадал ли классификатор.',
        real: 'RouteLLM (классификатор, обученный на парах «сильная — слабая модель»), NotDiamond, Martian; в LiteLLM — свои правила маршрута. Классификатор работает 1–5 мс на CPU.'
      },
      policy: {
        name: 'Правила маршрута', knobs: ['strategy'],
        an: 'Как <b>правила регистратуры</b>: «с температурой — к терапевту, с переломом — к хирургу, по записи — к своему врачу».',
        pl: 'Стратегия решает, кто получит вопрос: по сложности (простое — в дешёвую модель), всё в самую сильную (качество любой ценой) или поровну (делить нагрузку). Правила дополняют: VIP-клиентов — в сильную, длинный контекст — в модель с большим окном.',
        how: ['По сложности: оценка ниже порога — малая модель, выше — сильная.', 'Всё в сильную: классификатор не нужен, качество максимальное, цена тоже.', 'Поровну: модели получают вопросы по очереди — просто, но без экономии на простых.', 'Внутри одного размера запросы делят по очереди или по наименьшей загрузке.', 'Дополнительные правила: язык, длина контекста, тариф клиента, бюджет команды.', 'Правила лежат в конфиге роутера и меняются без выкатки сервиса.'],
        watch: 'Слева внизу — текущая стратегия и кнопки смены. Это та же настройка, что справа в «Настройках этого узла».',
        real: 'LiteLLM Router: группы моделей, routing_strategy (simple-shuffle, least-busy, latency-based, cost-based); OpenRouter и Portkey — условия маршрута.'
      },
      pool: {
        name: 'Пул моделей и лимиты',
        an: 'Как <b>штатное расписание</b>: сколько фельдшеров и профессоров на смене, сколько пациентов каждый примет в час и сколько стоит приём.',
        pl: 'За роутером — несколько моделей разного размера: у разных провайдеров или на своих GPU. У каждой свой лимит запросов в секунду, скорость и цена. Роутер знает их все, держит ключи и считает токены.',
        how: ['Модель описывают: имя, провайдер, ключ, лимит запросов и токенов в минуту, цена за 1 млн токенов.', 'Одинаковые модели у разных провайдеров объединяют в группу — они подменяют друг друга.', 'Роутер следит за каждой: сколько запросов в работе, сколько ответов 429.', 'Свои GPU — фиксированная цена в месяц, API — плата за токены.', 'Командам выдают виртуальные ключи с бюджетом: кончился бюджет — запросы режутся или идут в дешёвую модель.', 'Всё логируется: токены, цена и задержка по каждой модели.'],
        watch: 'Справа — модели со схемы: размер, где работают, лимит, доля потока и цена ответа. Нажми на модель — провалишься внутрь неё.',
        real: 'LiteLLM Proxy (виртуальные ключи, max_budget, rpm и tpm), Portkey, Kong AI Gateway; учёт — Langfuse, Helicone.'
      },
      fallback: {
        name: 'Фолбэк и предохранитель', knobs: ['failover'],
        an: 'Как <b>дежурный врач</b>: если свой врач на больничном, пациента ведут к дежурному. А если врач третий раз не берёт трубку, ему перестают звонить на полчаса.',
        pl: 'Модель может упасть (ошибка 5xx), зависнуть (таймаут) или ответить 429 «слишком много запросов». С фолбэком роутер отправляет запрос в следующую модель, и пользователь получает ответ, а не ошибку. Предохранитель после нескольких ошибок подряд перестаёт слать запросы в больную модель — не ждём таймаут каждый раз.',
        how: ['Запрос ушёл в модель; ответа ждём не дольше таймаута (здесь 2 с).', 'Ошибка 5xx или таймаут — ждали зря; 429 приходит сразу.', 'Фолбэк: та же модель у другого провайдера, иначе модель побольше, иначе любая живая.', 'Предохранитель: 3 ошибки подряд — размыкается, запросы сразу идут в запасную.', 'Через паузу — один пробный запрос: модель ответила — предохранитель замкнут, нет — ещё пауза.', 'Без фолбэка пользователь получает 503 — после таймаута или сразу, если предохранитель разомкнут.'],
        watch: 'Посередине внизу — фолбэк и предохранитель у каждой модели. В ситуации «Провайдер упал» видно, как ожидание таймаута сменяется мгновенным переходом в запасную.',
        real: 'LiteLLM: fallbacks, num_retries, timeout, cooldown_time (по сути предохранитель). Паттерн Circuit Breaker: Resilience4j, Polly.'
      },
      misroute: {
        name: 'Ошибка маршрутизации',
        an: 'Как <b>ошибка медсестры</b>: сложного пациента отправили к фельдшеру — лечение хуже; лёгкого к профессору — дорогой приём впустую.',
        pl: 'Классификатор иногда ошибается. Сложное в малую модель — слабый ответ: клиент недоволен или идёт к оператору. Простое в сильную — переплата. Первое опаснее: деньги теряются на жалобах, а не на токенах.',
        how: ['Сложный вопрос в малой модели: ответ неполный или неверный.', 'Простой вопрос в сильной модели: ответ хороший, но в 10–20 раз дороже.', 'Ошибки меряют на размеченном наборе вопросов и по жалобам.', 'Каскад: малая модель отвечает и оценивает свою уверенность; низкая — вопрос переспрашивают у сильной.', 'Каскад исправляет ошибки маршрута ценой двух вызовов на сложных вопросах.', 'Порог подбирают по данным: где меньше суммарная цена ошибок.'],
        watch: 'Справа внизу — журнал маршрутов: красным — сложное в слабой модели, жёлтым — переплата. В «Обманчивых вопросах» есть кнопка каскада.',
        real: 'FrugalGPT (каскад моделей), RouteLLM; качество проверяют выборкой ответов и LLM-судьёй.'
      },
      cost: {
        name: 'Цена и качество', knobs: ['strategy'],
        an: 'Как <b>смешанный тариф</b>: 70 % звонков по дешёвому тарифу, 30 % — по дорогому. В среднем счёт ближе к дешёвому, а сложные случаи всё равно у специалиста.',
        pl: 'Цена ответа зависит от модели: малая в 10–60 раз дешевле сильной. Если 70 % вопросов простые и уходят в малую, средняя цена падает в разы, а качество почти как у сильной: на простых вопросах малая модель отвечает хорошо.',
        how: ['Цена ответа = входные токены × цена входа + выходные × цена выхода.', 'Средняя цена = доля в малую × цена малой + доля в сильную × цена сильной.', 'Месяц = средняя цена × запросов в секунду × 2,63 млн секунд.', 'Качество = доля простых × качество на простых + доля сложных × качество на сложных.', 'Ошибки маршрута немного снижают качество.', 'Свои GPU стоят одинаково при любой доле: там роутер экономит мощность, а не токены.'],
        watch: 'Слева внизу — три стратегии рядом: цена ответа и качество. Текущая выделена.',
        real: 'Тарифы провайдеров за 1 млн токенов; учёт по моделям и командам — LiteLLM, Langfuse.'
      }
    },
    legend: [['xrt-sws', 'Простой вопрос'], ['xrt-swc', 'Сложный вопрос'], ['ok', 'Ответ получен'], ['warn', 'Ждём модель, таймаут'], ['bad', 'Ошибка, 429, слабый ответ']],
    live: (n, r, all) => {
      const out = [['Поток', SD.fmt.num(r.rps || 0) + '/с', '']];
      const G = SD.app.A.graph, AN = (all && all.nodes) || {}, ks = G.edges.filter(e => e.from === n.id).map(e => G.nodes.find(x => x.id === e.to)).filter(x => x && x.type === 'llm');
      if (ks.length && r.rps) {
        const lo = ks.map(k => k.props.size).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
        const sm = ks.filter(k => k.props.size === lo).reduce((a, k) => a + ((AN[k.id] || {}).rps || 0), 0);
        out.push(['В малую', Math.round(sm / r.rps * 100) + ' %', '']);
      }
      out.push(['Стратегия', STRAT[n.props.strategy] || n.props.strategy, '']);
      out.push(['Фолбэк', n.props.failover ? 'включён' : 'выключен', n.props.failover ? 'ok' : 'warn']);
      return out;
    },

    mount(ctx) {
      const P = () => ctx.node.props;
      ctx.svg.innerHTML = '<g id="xrtSt"></g><g id="xrtDy" class="xrt-dyn"></g>';
      const gSt = ctx.svg.querySelector('#xrtSt'), gDy = ctx.svg.querySelector('#xrtDy');
      const S = { scn: ctx.scenario() || 'norm', dn: {}, logT: {}, t: 0, vt: 0, pv: {}, flags: {}, th: 0.5, cascade: false, br: {} };
      const done = id => { if (!S.dn[id]) { S.dn[id] = 1; ctx.done(id); } };
      const note = (id, html, cls, gap) => { const g = gap == null ? 3000 : gap; if (g && S.logT[id] != null && S.t - S.logT[id] < g) return; S.logT[id] = S.t; ctx.log(html, cls || ''); };
      const L = () => (SD.app && SD.app.A && SD.app.A.level) || {};
      const AI = () => Object.assign({ inTok: 800, outTok: 300, ragTok: 2500, simple: 0.7 }, L().ai || {});
      const D = () => DOM[['support', 'voice'].includes(L().id) ? 'bank' : 'shop'];
      const G = () => (SD.app && SD.app.A && SD.app.A.graph) || { nodes: [], edges: [] };
      const nodeBy = id => G().nodes.find(n => n.id === id);
      const kids = id => G().edges.filter(e => e.from === id).map(e => nodeBy(e.to)).filter(Boolean);
      const pars = id => G().edges.filter(e => e.to === id).map(e => nodeBy(e.from)).filter(Boolean);
      const resOf = id => ((ctx.all || {}).nodes || {})[id] || {};
      const rpsAll = () => (ctx.res && ctx.res.rps) || (L().traffic || {}).chat || 1;
      const rag = () => G().nodes.some(n => n.type === 'vectordb' && pars(n.id).some(p => p.type === 'app' || p.type === 'stt'));
      /* подписи под ширину: при узком окне шрифт в единицах картинки крупнее (не меньше 12 px на экране) */
      const FS = () => Math.max(11, 12 / (parseFloat(ctx.svg.style.getPropertyValue('--sc')) || 1));
      const fitc = (t, px, mono) => cut(t, Math.max(3, Math.floor(px / (FS() * (mono ? 0.62 : 0.57)))));
      const wrapc = (t, px) => wrap(t, Math.max(10, Math.floor(px / (FS() * 0.57))));
      const tw = (t, mono) => String(t).length * FS() * (mono ? 0.62 : 0.57);
      const btns = (x, y, maxW, items) => { let s2 = '', cx = x, cy = y; items.forEach(([act, label, on]) => { const w = Math.ceil(tw(label) + 18); if (cx > x && cx + w > x + maxW) { cx = x; cy += 28; } s2 += BTN(cx, cy, w, act, label, on); cx += w + 6; }); return { s: s2, rows: (cy - y) / 28 + 1 }; };

      /* модели за роутером: настоящие со схемы или «как было бы» */
      function pool() {
        const ks = kids(ctx.node.id).filter(n => n.type === 'llm').map((n, i) => ({ id: n.id, i, real: true, name: n.label || `LLM · ${SHORT[n.props.size] || n.props.size}`, size: n.props.size, api: n.props.hosting === 'api', tier: n.props.tier, gpus: n.props.gpus || 1, pcache: !!n.props.pcache, maxOut: n.props.maxOut || 512 }));
        const list = ks.length ? ks : [{ id: 'v1', i: 0, name: 'Малая 8B', size: 'small', api: true, tier: 'pro', gpus: 1, pcache: false, maxOut: 512 }, { id: 'v2', i: 1, name: 'Средняя 70B', size: 'medium', api: true, tier: 'pro', gpus: 2, pcache: false, maxOut: 512 }];
        return list.sort((a, b) => ORDER.indexOf(a.size) - ORDER.indexOf(b.size) || a.i - b.i);
      }
      const virt = ps => !ps[0].real;
      const ends = ps => ({ lo: ps[0].size, hi: ps[ps.length - 1].size });
      const byId = (ps, id) => ps.find(m => m.id === id);
      const toSmall = () => { const s = AI().simple; return s * 0.9 + (1 - s) * 0.1; };
      function shareOf(m, ps) {   // доля потока модели: с площадки, а без моделей на схеме — по стратегии
        if (m.real && rpsAll() > 0 && resOf(m.id).rps != null) return (resOf(m.id).rps || 0) / rpsAll();
        const { lo, hi } = ends(ps), st = P().strategy, same = ps.filter(x => x.size === m.size).length;
        const f = lo === hi || st === 'quality' ? (m.size === hi ? 1 : 0) : st === 'balance' ? 0.5 : (m.size === lo ? toSmall() : 1 - toSmall());
        return f / same;
      }
      const rpsOf = (m, ps) => rpsAll() * shareOf(m, ps);
      const tokIn = () => AI().inTok + (rag() ? AI().ragTok : 0);
      const apiPrice = (size, m) => { const z = SD.LLM_SIZES[size] || SD.LLM_SIZES.medium, out = Math.min((m && m.maxOut) || 512, AI().outTok), cf = m && m.pcache ? 0.37 : 1; return (tokIn() * z.pIn * cf + out * z.pOut) / 1e6 * RUB; };
      const priceOf = (m, ps) => { if (m.api) return apiPrice(m.size, m); const r = rpsOf(m, ps); return r > 0.01 ? m.gpus * SD.GPU_COST * RUB / (r * MONTH) : apiPrice(m.size, m); };
      const Qz = z => (SD.LLM_SIZES[z] || SD.LLM_SIZES.medium).quality, Ez = z => Math.min(0.99, Qz(z) + 0.2);
      function qualOf(st, lo, hi) { const s = AI().simple; if (lo === hi || st === 'quality') return s * Ez(hi) + (1 - s) * Qz(hi); if (st === 'cost') return s * (0.9 * Ez(lo) + 0.1 * Qz(lo)) + (1 - s) * (0.9 * Qz(hi) + 0.1 * Ez(hi)); return 0.5 * (s * Ez(lo) + (1 - s) * Qz(lo)) + 0.5 * (s * Ez(hi) + (1 - s) * Qz(hi)); }
      function mixOf(st, lo, hi) { const a = apiPrice(lo), b = apiPrice(hi); if (lo === hi || st === 'quality') return b; if (st === 'cost') return toSmall() * a + (1 - toSmall()) * b; return 0.5 * (a + b); }
      const smallOf = (st, lo, hi) => lo === hi || st === 'quality' ? 0 : st === 'cost' ? toSmall() : 0.5;

      /* что ломаем в ситуациях: упавшая модель и модель с маленьким лимитом */
      const downId = ps => S.scn === 'down' ? ps[0].id : null;
      const limId = ps => { if (S.scn !== 'limit') return null; const a = ps.find(m => m.api && m.size === ps[0].size) || ps.find(m => m.api); return a ? a.id : null; };
      const isDown = (m, ps) => m.id === downId(ps) || (m.real && !!resOf(m.id).dead);
      const tierRps = m => (SD.API_TIERS[m.tier] || SD.API_TIERS.pro).rps;
      const effTier = (m, ps) => m.id === limId(ps) ? Math.min(tierRps(m), SD.API_TIERS.basic.rps) : tierRps(m);
      const needOf = (m, ps) => Math.max((S.scn === 'limit' ? 5 : S.scn === 'bill' ? 3 : 1) * rpsOf(m, ps), m.id === limId(ps) ? 15 : 0);
      const p429 = (m, ps) => m.api ? clamp(1 - effTier(m, ps) / Math.max(0.01, needOf(m, ps)), 0, 0.9) : 0;

      /* предохранитель: закрыт → разомкнут (после BRK ошибок) → пробный запрос */
      const br = id => S.br[id] || (S.br[id] = { fails: 0, open: 0, st: 'closed' });
      function brState(id) { const b = br(id); if (b.st === 'open' && S.t >= b.open) b.st = 'half'; return b.st; }
      function brFail(m) {
        const b = br(m.id); b.fails++;
        if (b.st === 'half' || b.fails >= BRK) {
          b.st = 'open'; b.open = S.t + OPEN; S.flags.brOpen = 1;
          note('bro', `<b>Предохранитель разомкнулся:</b> «${ES(m.name)}» не ответила ${b.fails} ${pl(b.fails, 'раз', 'раза', 'раз')} подряд. Следующие ${OPEN / 1000} с запросы ${P().failover ? 'идут сразу в запасную модель' : 'получают ошибку сразу'} — без ожидания таймаута.`, 'warn', 4000);
        }
      }
      function brOk(m) { const b = br(m.id); if (b.st === 'half') note('brc', `<b>Пробный запрос прошёл:</b> «${ES(m.name)}» снова отвечает, предохранитель замкнут.`, 'ok', 4000); b.fails = 0; b.st = 'closed'; }
      function alt(m, ps, tried) {
        const c = ps.filter(x => !tried.includes(x.id) && brState(x.id) !== 'open');
        return c.find(x => x.size === m.size) || c.find(x => ORDER.indexOf(x.size) > ORDER.indexOf(m.size)) || c[0] || null;
      }

      /* ---------- запросы ---------- */
      function pickItem() {
        const d = D(), n = S.seq++, norm = d.qs.filter(x => !x.tr), trk = d.qs.filter(x => x.tr);
        if (S.scn === 'tricky') return n % 3 === 2 ? norm[Math.floor(n / 3) % norm.length] : trk[(S.tk++) % trk.length];
        if (S.scn === 'norm' && n % 9 === 8) return trk[Math.floor(n / 9) % trk.length];
        const simp = n === 0 ? true : n === 1 ? false : Math.random() < AI().simple, list = norm.filter(x => !!x.s === simp);
        return list[Math.floor(Math.random() * list.length)];
      }
      function spawn() {
        const it = pickItem(), r = { id: ++S.rid, it, sc: scoreOf(it), simple: !!it.s, ph: 'in', p0: S.t, tried: [], rub: 0, path: [] };
        S.reqs.push(r); if (S.reqs.length > 24) S.reqs.shift();
      }
      function choose(r, ps) {
        const { lo, hi } = ends(ps), st = P().strategy;
        let want;
        if (st === 'quality' || lo === hi) want = hi; else if (st === 'balance') want = (S.bal = !S.bal) ? lo : hi; else want = r.sc < S.th ? lo : hi;
        r.want = want;
        const same = ps.filter(m => m.size === want);
        S.rr[want] = (S.rr[want] || 0) + 1;
        let m = same[S.rr[want] % same.length];
        if (brState(m.id) === 'open') {
          const a = P().failover ? alt(m, ps, [m.id]) : null;
          if (a) { r.skip = m.id; r.fb = 1; r.path.push(`«${cut(m.name, 14)}» отключена предохранителем`); m = a; } else r.fast = 1;
        }
        return m;
      }
      function arrive(r, ps) {
        const m = byId(ps, r.m); if (!m) { finish(r, 'err', null, 'модель убрали со схемы'); return; }
        r.tried.push(m.id);
        if (r.fast && brState(m.id) === 'open') { r.ph = 'rej'; r.code = '503'; r.p0 = S.t; return; }
        if (isDown(m, ps)) { r.ph = 'wait'; r.p0 = S.t; return; }
        if (Math.random() < p429(m, ps)) { r.ph = 'rej'; r.code = '429'; r.p0 = S.t; S.rej.push(S.t); return; }
        if (brState(m.id) === 'half' || br(m.id).fails) brOk(m);
        r.ph = 'gen'; r.p0 = S.t; r.dur = GEN[m.size] * (0.85 + Math.random() * 0.3);
      }
      function failNext(r, ps, m, code) {
        const a = P().failover ? alt(m, ps, r.tried) : null;
        r.path.push(code === '429' ? `429 у «${cut(m.name, 14)}»` : `«${cut(m.name, 14)}» молчит ${ms(TO)}`);
        if (a) { r.from = m.id; r.m = a.id; r.fb = 1; r.via = r.via || code; r.ph = 'go2'; r.p0 = S.t; return; }
        if (code === '429') finish(r, '429', m, `429 у «${cut(m.name, 16)}»${P().failover ? ' — запасных нет' : ' — фолбэк выключен'}`);
        else finish(r, 'err', m, r.fast && !r.waste ? `503 сразу: предохранитель разомкнут${P().failover ? '' : ', фолбэка нет'}` : `${P().failover ? 'запасных нет' : 'фолбэк выключен'} → 503 через ${ms(r.waste || TO)}`);
      }
      function genDone(r, ps) {
        const m = byId(ps, r.m); if (!m) { finish(r, 'err', null, 'модель убрали со схемы'); return; }
        r.rub += priceOf(m, ps);
        const { lo, hi } = ends(ps);
        if (S.scn === 'tricky' && S.cascade && lo !== hi && m.size === lo && !r.esc) {
          r.conf = r.simple ? 0.86 + Math.random() * 0.1 : 0.32 + Math.random() * 0.15;
          if (r.conf < 0.7) {
            const big = ps.filter(x => x.size === hi && brState(x.id) !== 'open' && !isDown(x, ps))[0] || ps.find(x => x.size === hi);
            r.esc = 1; r.from = m.id; r.m = big.id; r.ph = 'go2'; r.p0 = S.t; r.path.push(`малая не уверена (${nf(r.conf, 2)})`);
            note('esc', `<b>Каскад:</b> «${ES(cut(r.it.q, 40))}» — малая модель ответила, но уверенность ${nf(r.conf, 2)} ниже 0,7. Вопрос переспросили у «${ES(big.name)}».`, 'ok', 4000);
            return;
          }
        }
        let kind = 'ok';
        if (lo !== hi && !r.fb && !r.simple && m.size === lo) kind = 'weak';
        else if (lo !== hi && !r.fb && r.simple && m.size === hi && r.want === hi) kind = 'over';
        const lbl = `${r.simple ? 'простой' : 'сложный'} ${nf(r.sc, 2)}`;
        const txt = kind === 'weak' ? `${lbl} < ${nf(S.th, 1)} → малая: слабый ответ` : kind === 'over' ? `простой, но ${nf(r.sc, 2)} → сильная: переплата` : `${lbl} → «${cut(m.name, 16)}» · ${rub(r.rub)}${r.esc ? ' · каскад' : r.fb ? ' · запасная' : ''}`;
        finish(r, kind, m, txt);
      }
      function finish(r, kind, m, txt) {
        const ps = pool(), { lo, hi } = ends(ps);
        r.kind = kind; r.ph = kind === 'err' || kind === '429' ? 'fail' : 'back'; r.p0 = S.t; r.end = m ? m.id : null;
        S.ev.push({ t: S.t, kind, lo: !!(m && m.size === lo && lo !== hi), m: m ? m.id : null, rub: r.rub, fb: !!r.fb, esc: !!r.esc });
        S.log.unshift({ id: r.id, q: r.it.q, kind, txt }); if (S.log.length > 5) S.log.pop();
        if (kind === 'weak') note('weak', `<b>Ошибка маршрута:</b> «${ES(cut(r.it.q, 44))}» — на деле сложный, но оценка ${nf(r.sc, 2)} ниже порога. Малая модель ответила слабо${r.it.why ? `: ${ES(r.it.why)}` : ''}.`, 'bad', 5000);
        if (kind === 'over') note('over', `<b>Переплата:</b> «${ES(cut(r.it.q, 44))}» — простой вопрос, но оценка ${nf(r.sc, 2)} — ушёл в сильную модель за ${rub(r.rub)} вместо ${rub(apiPrice(lo))}.`, 'warn', 6000);
        if (kind === '429') { S.flags.u429 = 1; note('u429', `<b>Пользователь получил 429:</b> «${ES(m ? m.name : '')}» упёрлась в лимит, а фолбэк ${P().failover ? 'не нашёл запасную' : 'выключен'}.`, 'bad', 4000); }
        if (kind === 'err') note('err', `<b>Пользователь получил 503:</b> ${ES(txt)}.`, 'bad', 4000);
        if (kind !== 'ok' && kind !== 'over' && kind !== 'weak') return;
        if (r.fb && r.via === '429') { S.flags.spill = 1; note('spill', `<b>Фолбэк спас запрос:</b> «${ES(r.path[0] || '')}» → ответ дала «${ES(m.name)}».`, 'ok', 5000); }
        if (r.fb && r.via === '503') note('fb', `<b>Запасная модель ответила:</b> ${ES(r.path.join(' → '))} → «${ES(m.name)}». Пользователь подождал лишние ${ms(r.waste || TO)}.`, 'warn', 5000);
        if (r.skip && S.scn === 'down') { done('down'); note('skip', `<b>Без ожидания:</b> предохранитель отключил «${ES(byId(ps, r.skip) ? byId(ps, r.skip).name : '')}», запрос сразу ушёл в «${ES(m.name)}».`, 'ok', 6000); }
        if (S.scn === 'limit' && S.flags.u429 && S.flags.spill) done('limit');
        if (r.esc && S.scn === 'tricky') done('cascade');
        if (S.scn === 'norm' && P().strategy === 'cost' && lo !== hi && kind === 'ok') {
          if (r.simple && m.size === lo) S.flags.sLo = 1;
          if (!r.simple && m.size === hi) S.flags.sHi = 1;
          if (S.flags.sLo && S.flags.sHi) { done('split'); note('split', `<b>Маршрут по сложности:</b> простые вопросы стоят ${rub(apiPrice(lo))} в малой модели, сложные — ${rub(apiPrice(hi))} в сильной.`, 'ok', 8000); }
        }
      }
      function step(r, ps) {
        const u = S.t - r.p0;
        if (r.ph === 'in' && u > 450) { r.ph = 'cls'; r.p0 = S.t; S.cur = r; }
        else if (r.ph === 'cls' && u > 650) { const m = choose(r, ps); r.m = m.id; r.ph = 'go'; r.p0 = S.t; }
        else if ((r.ph === 'go' || r.ph === 'go2') && u > 450) arrive(r, ps);
        else if (r.ph === 'wait' && u > TO) { const m = byId(ps, r.m); r.waste = (r.waste || 0) + TO; if (m) { brFail(m); failNext(r, ps, m, '503'); } else finish(r, 'err', null, 'модель убрали'); }
        else if (r.ph === 'rej' && u > 350) { const m = byId(ps, r.m); if (m) failNext(r, ps, m, r.code); else finish(r, 'err', null, 'модель убрали'); }
        else if (r.ph === 'gen' && u > r.dur) genDone(r, ps);
        else if (r.ph === 'back' && u > 400) { r.ph = 'done'; r.p0 = S.t; }
        else if (r.ph === 'fail' && u > 700) { r.ph = 'done'; r.p0 = S.t; }
      }

      /* ---------- рисование ---------- */
      function boxes(ps) {
        const n = Math.min(ps.length, 4), top = MZ.y + 28, H = MZ.y + MZ.h - 8 - top, h = Math.min(150, (H - (n - 1) * 8) / n);
        return ps.slice(0, n).map((m, i) => ({ m, x: MZ.x + 10, y: top + i * (h + 8), w: MZ.w - 20, h }));
      }
      const ymOf = (bx, id) => { const b = bx.find(x => x.m.id === id); return b ? b.y + b.h / 2 : MZ.y + MZ.h - 12; };
      function badges(ps) {
        const { lo, hi } = ends(ps), st = P().strategy;
        const bs = [['classify', 'КЛАССИФИКАТОР', `порог ${nf(S.th, 1)}`], ['policy', 'ПРАВИЛА', STRAT[st]], ['fallback', 'ФОЛБЭК', P().failover ? `включён · таймаут ${ms(TO)}` : 'выключен'], ['cost', 'ЦЕНА И КАЧЕСТВО', `${rub(mixOf(st, lo, hi))} за ответ`]];
        const w = (984 - 230 - 3 * 8) / 4;
        let s = T(16, 20, 'Нажми на блок —', 'xr-s xrt-go') + T(16, 35, 'разберём, как он работает →', 'xr-s xrt-go');
        bs.forEach(([k, t, v], i) => { const x = 230 + i * (w + 8), bad = k === 'fallback' && !P().failover; s += `<g class="xr-part" data-xpart="${k}">${R(x, 4, w, 34, 'xrt-badge' + (bad ? ' warn' : ''), 9)}${T(x + 9, 18, t, 'xr-m')}${T(x + 9, 32, ES(fitc(v, w - 16)), 'xr-s' + (bad ? ' xrt-warn' : ''))}</g>`; });
        return s;
      }
      function qSvg() {
        const b = QB, r = S.cur, d = D();
        let s = `<g class="xr-part" data-xpart="classify">${R(b.x, b.y, b.w, b.h, 'xr-zone', 12)}${T(b.x + 10, b.y + 18, 'ВОПРОС → СЛОЖНОСТЬ', 'xr-m')}${T(b.x + b.w - 10, b.y + 18, ES(d.who), 'xrt-ms', 'end')}`;
        if (!r) return s + T(b.x + 10, b.y + 44, 'ждём вопрос…', 'xr-s') + '</g>';
        wrapc(r.it.q, b.w - 24).slice(0, 3).forEach((l, j) => { s += T(b.x + 10, b.y + 40 + j * 16, ES(l), 'xrt-qt'); });
        const u = r.ph === 'cls' ? S.t - r.p0 : 9999, k = Math.min(r.it.f.length, Math.floor(u / 160) + 1), sc = r.it.f.slice(0, k).reduce((a, x) => a + x[1], 0);
        r.it.f.forEach(([lab, w], j) => { const y = b.y + 100 + j * 21, on = j < k; s += R(b.x + 10, y - 14, b.w - 20, 19, 'xrt-feat' + (on ? ' on' : ''), 5) + T(b.x + 18, y, ES(fitc(lab, b.w - 96, true)), 'xrt-fn' + (on ? '' : ' dim')) + T(b.x + b.w - 18, y, '+' + nf(w, 2), 'xrt-pn' + (on ? ' xrt-acc' : ''), 'end'); });
        const by = b.y + 166, X0 = b.x + 10, W = b.w - 20, xs = v => X0 + clamp(v, 0, 1) * W;
        s += T(X0, by - 6, `оценка ${nf(sc, 2)} · порог ${nf(S.th, 1)}`, 'xrt-ms' + (P().strategy === 'cost' ? '' : ' dim')) + R(X0, by, W, 10, 'xr-bar', 3) + R(X0, by, xs(sc) - X0, 10, 'xr-bar-f ' + (sc < S.th ? 'acc' : 'warn'), 3) + Ln(xs(S.th), by - 4, xs(S.th), by + 14, 'xrt-th');
        const ps = pool(), { lo, hi } = ends(ps), st = P().strategy;
        const dest = st === 'cost' && lo !== hi ? (sc < S.th ? `→ малая модель (${SHORT[lo]})` : `→ сильная модель (${SHORT[hi]})`) : st === 'quality' || lo === hi ? '→ сильная: оценка не нужна' : '→ по очереди, оценка не нужна';
        s += T(X0, by + 32, fitc(k >= r.it.f.length ? dest : 'считаем признаки…', W), 'xr-s xrt-acc');
        if (r.kind) {
          const ok = r.kind === 'ok' || r.esc, txt = r.kind === 'weak' ? `✕ на деле сложный: ${r.it.why || 'малая ответит слабо'}` : r.kind === 'over' ? `✕ на деле простой: ${r.it.why || 'переплата'}` : r.kind === 'ok' ? `✓ ${r.esc ? 'каскад исправил ошибку' : `угадал: ${r.simple ? 'простой' : 'сложный'}`}` : `ответа нет: ${r.kind === '429' ? '429' : '503'}`;
          s += T(X0, by + 52, ES(fitc(txt, W)), 'xrt-ms ' + (ok ? 'xrt-ok' : r.kind === 'over' ? 'xrt-warn' : 'xrt-bad'));
        } else s += T(X0, by + 52, fitc('классификатор: 2 мс, до вызова модели', W), 'xrt-ms');
        return s + '</g>';
      }
      function policySvg(ps) {
        const b = PB, st = P().strategy, { lo, hi } = ends(ps);
        let s = `<g class="xr-part" data-xpart="policy">${R(b.x, b.y, b.w, b.h, 'xr-box', 12)}${T(b.x + 10, b.y + 18, 'ПРАВИЛА МАРШРУТА', 'xr-m')}${T(b.x + b.w - 10, b.y + 18, ES(STRAT[st]), 'xrt-ms xrt-acc', 'end')}`;
        const line = lo === hi ? 'модели одного размера — делить не на что' : st === 'cost' ? `оценка < ${nf(S.th, 1)} → малая, иначе → сильная` : st === 'quality' ? 'всё → сильная, оценка не нужна' : 'по очереди: малая, сильная, малая…';
        s += T(b.x + 10, b.y + 38, fitc(line, b.w - 20), 'xr-s');
        const bt = btns(b.x + 10, b.y + 48, b.w - 20, [['st-cost', 'по сложности', st === 'cost'], ['st-quality', 'всё в сильную', st === 'quality'], ['st-balance', 'поровну', st === 'balance']]);
        s += bt.s;
        if (bt.rows === 1) s += T(b.x + 10, b.y + 96, ES(fitc(`малая: ${ps[0].name} · сильная: ${ps[ps.length - 1].name}`, b.w - 20)), 'xrt-ms');
        return s + '</g>';
      }
      function routerSvg(ps) {
        const pa = pars(ctx.node.id), src = pa[0], st = P().strategy;
        let s = '';
        if (src) { const go = ctx.canGo(src.id); s += `<g${go ? ` class="xr-go" data-xgo="${src.id}"` : ''}>${R(336, 54, 300, 30, 'xr-box', 15)}${T(350, 74, ES(fitc(`${ctx.nm(src.id)}${pa.length > 1 ? ` +${pa.length - 1}` : ''}`, 286 - tw(`${nf(rpsAll(), rpsAll() < 10 ? 1 : 0)} вопросов/с ↓`) - 12, true)), 'xrt-fn')}${T(624, 74, `${nf(rpsAll(), rpsAll() < 10 ? 1 : 0)} вопросов/с ↓`, 'xrt-ms', 'end')}</g>`; }
        else s += R(336, 54, 300, 30, 'xrt-row', 15) + T(350, 74, 'на схеме никто не шлёт вопросы', 'xrt-ms');
        s += Ln(SRC[0], SRC[1], RIN[0], RIN[1], 'xr-wire');
        const bx = boxes(ps), act = new Set(S.reqs.filter(r => ['go', 'go2', 'gen', 'wait'].includes(r.ph)).map(r => r.m));
        bx.forEach(b => { s += `<path class="xr-wire${act.has(b.m.id) ? ' act' : ''}" d="M${ROUT[0]} ${ROUT[1]} C${ROUT[0] + 34} ${ROUT[1]} ${b.x - 34} ${f1(b.y + b.h / 2)} ${b.x} ${f1(b.y + b.h / 2)}"/>`; });
        const c = S.cur;
        s += R(RB.x, RB.y, RB.w, RB.h, 'xr-box sel', 12) + T(RB.x + 12, RB.y + 20, 'РОУТЕР', 'xr-m acc') + T(RB.x + RB.w - 12, RB.y + 20, '≈ 3 мс', 'xrt-ms', 'end');
        s += T(RB.x + 12, RB.y + 42, `① оценка: ${c ? nf(scoreOf(c.it), 2) : '…'}`, 'xrt-ms') + T(RB.x + 12, RB.y + 62, fitc(`② правило: ${STRAT[st]}`, RB.w - 24), 'xrt-ms') + T(RB.x + 12, RB.y + 82, fitc('③ модель жива? нет — запасная', RB.w - 24), 'xrt-ms');
        if (S.scn === 'tricky') s += BTN(RB.x + 12, RB.y + 96, RB.w - 24, 'casc', S.cascade ? 'каскад включён ✓' : 'включить каскад', S.cascade);
        else s += T(RB.x + 12, RB.y + 102, fitc('④ токены и цена — в учёт', RB.w - 24), 'xrt-ms') + T(RB.x + 12, RB.y + 122, ES(fitc(ctx.nm(ctx.node.id), RB.w - 24)), 'xrt-ms xrt-acc');
        return s;
      }
      function fbSvg(ps) {
        const b = FB, on = P().failover;
        let s = `<g class="xr-part" data-xpart="fallback">${R(b.x, b.y, b.w, b.h, 'xr-box' + (on ? '' : ' hot'), 12)}${T(b.x + 10, b.y + 18, 'ФОЛБЭК И ПРЕДОХРАНИТЕЛЬ', 'xr-m')}${T(b.x + b.w - 10, b.y + 18, on ? 'включён' : 'выключен', 'xrt-ms ' + (on ? 'xrt-ok' : 'xrt-warn'), 'end')}`;
        s += T(b.x + 10, b.y + 38, fitc(on ? 'не ответила или 429 → в следующую модель' : 'не ответила → пользователь получит ошибку', b.w - 20), 'xrt-ms');
        const list = ps.filter(m => br(m.id).fails || br(m.id).st !== 'closed').concat(ps.filter(m => !(br(m.id).fails || br(m.id).st !== 'closed'))).slice(0, 2);
        list.forEach((m, j) => {
          const y = b.y + 60 + j * 21, st = brState(m.id), bb = br(m.id), left = Math.max(0, bb.open - S.t);
          const stT = st === 'open' ? `разомкнут ${nf(left / 1000)} с` : st === 'half' ? 'пробный' : 'замкнут', cx0 = b.x + b.w - 14 - tw(stT, true) - BRK * 11;
          s += T(b.x + 10, y, ES(fitc(m.name, cx0 - b.x - 18, true)), 'xrt-fn');
          for (let i = 0; i < BRK; i++) s += `<circle class="xrt-fail${i < Math.min(BRK, bb.fails) ? ' on' : ''}" cx="${f1(cx0 + i * 11)}" cy="${f1(y - 4)}" r="4"/>`;
          s += T(b.x + b.w - 10, y, stT, 'xrt-pn ' + (st === 'open' ? 'xrt-bad' : st === 'half' ? 'xrt-warn' : 'xrt-ok'), 'end');
        });
        const fl = on ? 'выключить фолбэк' : 'включить фолбэк', fw = Math.ceil(tw(fl) + 18);
        s += BTN(b.x + 10, b.y + 104, fw, 'fo', fl, !on) + (fw + 24 + tw(`таймаут ${ms(TO)}`) < b.w ? T(b.x + fw + 20, b.y + 121, `таймаут ${ms(TO)}`, 'xrt-ms') : '');
        return s + '</g>';
      }
      function modelsSvg(ps) {
        const bx = boxes(ps);
        const zt = virt(ps) ? 'МОДЕЛИ — КАК БЫЛО БЫ' : 'МОДЕЛИ ЗА РОУТЕРОМ', zr = virt(ps) ? 'на схеме их нет' : 'нажми — провалишься';
        let s = R(MZ.x, MZ.y, MZ.w, MZ.h, 'xr-zone', 12) + T(MZ.x + 10, MZ.y + 18, zt, 'xr-m') + (tw(zt, true) + tw(zr) + 30 < MZ.w ? T(MZ.x + MZ.w - 10, MZ.y + 18, zr, 'xrt-ms', 'end') : '');
        bx.forEach(b => {
          const m = b.m, dn = isDown(m, ps), p4 = p429(m, ps), st = brState(m.id), go = m.real && ctx.canGo(m.id), sh = shareOf(m, ps);
          const cls = 'xr-box' + (dn ? ' bad' : p4 > 0.05 || st === 'open' ? ' hot' : '');
          s += `<g${go ? ` class="xr-go" data-xgo="${m.id}"` : ''}>${R(b.x, b.y, b.w, b.h, cls, 10)}${T(b.x + 10, b.y + 18, ES(fitc(m.name, b.w - 30 - tw(SHORT[m.size] || m.size) - 8)), 'xrt-name')}${T(b.x + b.w - 10, b.y + 18, SHORT[m.size] || m.size, 'xrt-ms', 'end')}`;
          const stat = dn ? (S.scn === 'down' && m.id === downId(ps) ? 'упала (опыт)' : 'упала') : st === 'open' ? 'предохранитель' : p4 > 0.05 ? `429: ${pct(p4)}` : 'отвечает';
          s += T(b.x + 10, b.y + 36, fitc(m.api ? `API · лимит ${nf(effTier(m, ps))}/с` : `свои GPU: ${m.gpus}`, b.w - 30 - tw(stat, true)), 'xrt-ms' + (m.id === limId(ps) ? ' xrt-warn' : ''));
          s += T(b.x + b.w - 10, b.y + 36, stat, 'xrt-pn ' + (dn ? 'xrt-bad' : st === 'open' || p4 > 0.05 ? 'xrt-warn' : 'xrt-ok'), 'end');
          s += T(b.x + 10, b.y + 54, fitc(`${pct(sh)} потока · ${rub(priceOf(m, ps))} за ответ`, b.w - 20), 'xrt-ms');
          if (b.h > 90) s += R(b.x + 10, b.y + 64, b.w - 20, 6, 'xr-bar', 3) + R(b.x + 10, b.y + 64, (b.w - 20) * clamp(sh, 0, 1), 6, 'xr-bar-f acc', 3) + T(b.x + 10, b.y + 88, fitc(m.api ? `${nf(SD.LLM_SIZES[m.size].pIn, 2)} $ вход / ${nf(SD.LLM_SIZES[m.size].pOut, 2)} $ выход за 1М токенов` : `${rub(m.gpus * SD.GPU_COST * RUB)} в месяц при любом потоке`, b.w - 20), 'xrt-ms');
          if (b.h > 120) { const inw = S.reqs.filter(r => r.m === m.id && (r.ph === 'gen' || r.ph === 'wait')).length, cnt = S.ev.filter(e => e.m === m.id).length; s += T(b.x + 10, b.y + 112, fitc(`в работе: ${inw} · ответов за 20 с: ${cnt}`, b.w - 20), 'xrt-ms'); }
          s += '</g>';
        });
        if (ps.length > bx.length) s += T(MZ.x + 10, MZ.y + MZ.h - 4, `+ ещё ${ps.length - bx.length}`, 'xrt-ms');
        return s;
      }
      function costSvg(ps) {
        const b = CB, { lo, hi } = ends(ps), st = P().strategy, rps = rpsAll() * (S.scn === 'bill' ? 3 : 1);
        let s = `<g class="xr-part" data-xpart="cost">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}${T(b.x + 12, b.y + 18, 'ЦЕНА И КАЧЕСТВО', 'xr-m')}${T(b.x + b.w - 12, b.y + 18, 'по ценам API · $1 = 90 ₽', 'xrt-ms', 'end')}`;
        const mx = Math.max(...['cost', 'quality', 'balance'].map(k => mixOf(k, lo, hi)));
        ['cost', 'quality', 'balance'].forEach((k, j) => {
          const y = b.y + 40 + j * 22, on = k === st, pr = mixOf(k, lo, hi);
          s += T(b.x + 12, y, STRAT[k], 'xrt-fn' + (on ? ' xrt-acc' : ' dim')) + R(b.x + 130, y - 10, 140, 10, 'xr-bar', 3) + R(b.x + 130, y - 10, 140 * pr / mx, 10, 'xr-bar-f' + (on ? ' acc' : ''), 3) + T(b.x + 340, y, rub(pr), 'xrt-pn' + (on ? ' xrt-acc' : ''), 'end') + T(b.x + b.w - 12, y, pct(qualOf(k, lo, hi)), 'xrt-pn', 'end');
        });
        const cur = mixOf(st, lo, hi) * rps * MONTH, all = apiPrice(hi) * rps * MONTH;
        s += T(b.x + 12, b.y + 116, fitc(`месяц при ${nf(rps, rps < 10 ? 1 : 0)}/с: ${rub(cur)}${st !== 'quality' && lo !== hi ? ` вместо ${rub(all)}` : ''}`, b.w - 24), 'xr-s' + (S.scn === 'bill' ? ' xrt-acc' : ''));
        const realCost = ps.filter(m => m.real).reduce((a, m) => a + (resOf(m.id).cost || 0), 0) * RUB;
        s += T(b.x + 12, b.y + 136, fitc(virt(ps) ? 'на схеме за роутером нет моделей' : `на площадке модели стоят ${rub(realCost)} в месяц`, b.w - 24), 'xrt-ms');
        return s + '</g>';
      }
      function logSvg() {
        const b = JB;
        let s = `<g class="xr-part" data-xpart="misroute">${R(b.x, b.y, b.w, b.h, 'xr-box', 10)}${T(b.x + 12, b.y + 18, 'ЖУРНАЛ МАРШРУТОВ', 'xr-m')}${tw('ЖУРНАЛ МАРШРУТОВ', true) + tw('ошибки маршрута — цветом') + 40 < b.w ? T(b.x + b.w - 12, b.y + 18, 'ошибки маршрута — цветом', 'xrt-ms', 'end') : ''}`;
        const cls = { ok: 'xrt-ok', over: 'xrt-warn', weak: 'xrt-bad', err: 'xrt-bad', '429': 'xrt-bad' };
        S.log.forEach((l, j) => { const y = b.y + 42 + j * 22; s += T(b.x + 12, y, ES(fitc(`#${l.id} «${l.q}`, 204, true)) + '»', 'xrt-fn') + T(b.x + 230, y, ES(fitc(l.txt, b.w - 242)), 'xrt-ms ' + (cls[l.kind] || '')); });
        if (!S.log.length) s += T(b.x + 12, b.y + 44, 'ждём первый ответ…', 'xr-s');
        return s + '</g>';
      }
      function dynSvg(ps) {
        const bx = boxes(ps), ym = id => ymOf(bx, id);
        let s = '';
        const busy = {};
        S.reqs.forEach(r => {
          const u = S.t - r.p0, col = r.simple ? 'fill:var(--k-chat)' : 'fill:var(--k-write)';
          if (r.ph === 'in') s += Dot(...lerp(SRC, RIN, ease(u / 450)), 5, '', col);
          else if (r.ph === 'cls') s += Dot(...along([RIN, RCORN, ROUT], ease(u / 650)), 5, '', col);
          else if (r.ph === 'go') { const y = ym(r.m), k = ease(u / 450), p = [ROUT[0] + (MZ.x + 10 - ROUT[0]) * k, ROUT[1] + (y - ROUT[1]) * (k * k * (3 - 2 * k))]; s += Dot(...p, 5, '', col); }
          else if (r.ph === 'go2') s += Dot(...along([[MZ.x + 4, ym(r.from)], [MZ.x - 6, (ym(r.from) + ym(r.m)) / 2], [MZ.x + 4, ym(r.m)]], ease(u / 450)), 5, r.esc ? '' : 'wait', r.esc ? col : '');
          else if (r.ph === 'wait') { const y = ym(r.m), k = clamp(u / TO, 0, 1); s += Dot(MZ.x + 18, y, 5, 'wait') + `<circle class="xrt-ring" cx="${MZ.x + 18}" cy="${f1(y)}" r="10" stroke-dasharray="${f1(62.8 * k)} 62.8" transform="rotate(-90 ${MZ.x + 18} ${f1(y)})"/>` + T(MZ.x + 32, y + 4, `ждём ${nf(u / 1000, 1)} с`, 'xrt-pop'); }
          else if (r.ph === 'rej') { const y = ym(r.m); s += Dot(MZ.x + 18, y, 5, 'err') + T(MZ.x + 30, y + 4, r.code === '429' ? '429' : '503', 'xrt-pop xrt-bad'); }
          else if (r.ph === 'gen') { const y = ym(r.m), b = bx.find(x => x.m.id === r.m), k = busy[r.m] = (busy[r.m] || 0) + 1; if (b) s += Dot(b.x + b.w - 14 - (k - 1) * 13, b.y + b.h - 12, 5, '', col); else s += Dot(MZ.x + 18, y, 5, '', col); }
          else if (r.ph === 'back') s += Dot(...lerp([MZ.x + 10, ym(r.end)], ROUT, ease(u / 400)), 5, r.kind === 'weak' ? 'err' : r.kind === 'over' ? 'wait' : 'ok');
          else if (r.ph === 'fail') s += XM(MZ.x + 18, ym(r.end), 6);
        });
        return s;
      }
      function drawMain() { const ps = pool(); gSt.innerHTML = badges(ps) + qSvg() + policySvg(ps) + routerSvg(ps) + fbSvg(ps) + modelsSvg(ps) + costSvg(ps) + logSvg(); gDy.innerHTML = dynSvg(ps); }

      /* ---------- блоки изнутри ---------- */
      const head = (t, sub) => `<g class="xr-part" data-xpart="">${R(12, 10, 136, 26, 'xrt-backb', 13)}${T(80, 27, '← весь роутер', 'xr-s xrt-back', 'middle')}</g>` + T(164, 27, t, 'xrt-vt') + T(164, 46, sub, 'xr-s');
      function vClassify() {
        const ex = D().qs, C = 5200, i = Math.floor(S.vt / C) % ex.length, u = S.vt % C, it = ex[i], f = it.f, k = Math.min(f.length, Math.floor(u / 700)), sc = f.slice(0, k).reduce((a, x) => a + x[1], 0), full = k >= f.length;
        let s = head('Классификатор сложности', 'за 1–3 мс до вызова модели роутер ставит вопросу оценку от 0 до 1 и сравнивает с порогом');
        s += R(24, 60, 612, 200, 'xrt-panel on', 10) + T(36, 82, `ПРИМЕР ${i + 1} ИЗ ${ex.length}`, 'xr-m') + (it.tr ? T(624, 82, 'обманчивый', 'xrt-pn xrt-warn', 'end') : '');
        wrap(`«${it.q}»`, 80).slice(0, 2).forEach((l, j) => { s += T(36, 106 + j * 19, ES(l), 'xrt-big'); });
        f.forEach(([lab, w], j) => { const y = 162 + j * 24, on = j < k; s += R(36, y - 15, 290, 21, 'xrt-feat' + (on ? ' on' : ''), 5) + T(46, y, ES(lab), 'xrt-fn' + (on ? '' : ' dim')) + T(316, y, '+' + nf(w, 2), 'xrt-pn' + (on ? ' xrt-acc' : ''), 'end'); });
        const X0 = 360, W = 260, xs = v => X0 + clamp(v, 0, 1) * W;
        s += T(X0, 152, 'оценка сложности', 'xrt-ms') + T(X0, 182, nf(sc, 2), 'xrt-num' + (full ? (sc < S.th ? ' xrt-acc' : ' xrt-warn') : '')) + R(X0, 194, W, 12, 'xr-bar', 3) + R(X0, 194, xs(sc) - X0, 12, 'xr-bar-f ' + (sc < S.th ? 'acc' : 'warn'), 3) + Ln(xs(S.th), 188, xs(S.th), 212, 'xrt-th') + T(xs(S.th), 226, `порог ${nf(S.th, 1)}`, 'xrt-pn xrt-bad', 'middle');
        if (full && u > f.length * 700 + 500) {
          const toLo = sc < S.th, ok = toLo === !!it.s;
          S.pv.cls = 1;
          s += T(36, 248, ES(cut(`${toLo ? '→ малая модель' : '→ сильная модель'} · ${ok ? '✓ угадал' : `✕ на деле ${it.s ? 'простой' : 'сложный'}: ${it.why || ''}`}`, 92)), 'xr-s ' + (ok ? 'xrt-ok' : it.s ? 'xrt-warn' : 'xrt-bad'));
        }
        s += R(648, 60, 328, 200, 'xrt-panel', 10) + T(660, 82, 'КАК СЧИТАЕТ', 'xr-m');
        ['· признаки: длина, слова-маркеры, числа', '· вес признака — из обучения на логах', '· чаще — маленький классификатор:', '  эмбеддинг + логистическая регрессия', '· размечают: где малая ответила плохо', '· работает 1–3 мс на обычном CPU'].forEach((l, j) => { s += T(660, 108 + j * 24, l, 'xr-s'); });
        const list = ex.slice(0, 10);
        s += R(24, 272, 612, 276, 'xrt-panel', 10) + T(36, 294, `10 ВОПРОСОВ И ПОРОГ ${nf(S.th, 1)}`, 'xr-m') + `<rect x="420" y="285" width="10" height="10" rx="2" style="fill:var(--k-chat)"/>` + T(434, 294, 'простой', 'xrt-ms') + `<rect x="500" y="285" width="10" height="10" rx="2" style="fill:var(--k-write)"/>` + T(514, 294, 'сложный', 'xrt-ms');
        const BX = 300, BW = 180, bxs = v => BX + clamp(v, 0, 1) * BW;
        let nLo = 0, nLoBad = 0, nHi = 0, nHiBad = 0;
        list.forEach((q, j) => {
          const y = 318 + j * 21, v = scoreOf(q), lo = v < S.th, bad = lo ? !q.s : !!q.s;
          if (lo) { nLo++; if (bad) nLoBad++; } else { nHi++; if (bad) nHiBad++; }
          s += `<rect x="36" y="${y - 11}" width="5" height="14" rx="2" style="fill:var(${q.s ? '--k-chat' : '--k-write'})"/>` + T(48, y, ES(fitc(q.q, 244)), 'xrt-ct') + R(BX, y - 9, BW, 9, 'xr-bar', 3) + R(BX, y - 9, bxs(v) - BX, 9, 'xr-bar-f ' + (lo ? 'acc' : 'warn'), 3) + T(BX + BW + 44, y, nf(v, 2), 'xrt-pn', 'end') + T(626, y, lo ? 'малая' : 'сильная', 'xrt-pn ' + (bad ? (lo ? 'xrt-bad' : 'xrt-warn') : 'xrt-ok'), 'end');
        });
        s += Ln(bxs(S.th), 302, bxs(S.th), 520, 'xrt-th');
        s += T(36, 538, `в малую ${nLo}: сложных ${nLoBad} — слабый ответ · в сильную ${nHi}: простых ${nHiBad} — переплата`, 'xrt-ms' + (nLoBad ? ' xrt-bad' : ''));
        s += R(648, 272, 328, 276, 'xrt-panel', 10) + T(660, 294, 'ПОДВИНЬ ПОРОГ', 'xr-m');
        [0.3, 0.5, 0.7].forEach((v, j) => { s += BTN(660 + j * 102, 306, 96, 'th' + v, 'порог ' + nf(v, 1), Math.abs(S.th - v) < 0.01); });
        ['ниже порога → малая модель', 'выше или равно → сильная', '0,3: больше в сильную — дороже', '0,7: больше в малую — дешевле,', '     но сложные получат слабый ответ'].forEach((l, j) => { s += T(660, 356 + j * 22, l, 'xr-s'); });
        [`score = classify(question)`, `model = score < ${nf(S.th, 1).replace(',', '.')}`, `        ? "small" : "strong"`].forEach((l, j) => { s += MONO(660, 482 + j * 20, ES(l), j ? '' : 'on'); });
        return s;
      }
      function vPolicy() {
        const ps = pool(), { lo, hi } = ends(ps), list = D().qs.slice(0, 10), C = 8600, u = S.vt % C, k = Math.min(list.length, Math.floor(u / 560)), st = P().strategy;
        let s = head('Правила маршрута', `стратегия решает, какая модель получит вопрос; сейчас — «${STRAT[st]}»`);
        const lanes = [['cost', 'По сложности: простое — в малую, сложное — в сильную'], ['quality', 'Всё в сильную: оценка не нужна'], ['balance', 'Поровну: по очереди']];
        lanes.forEach(([key, title], j) => {
          const y = 60 + j * 164, on = key === st;
          s += R(24, y, 612, 156, 'xrt-panel' + (on ? ' on' : ''), 10) + T(36, y + 22, title, 'xr-t xrt-tt') + (on ? T(624, y + 22, 'так сейчас', 'xrt-pn xrt-acc', 'end') : '');
          const bins = { lo: [], hi: [] };
          list.forEach((q, i) => { const toLo = key === 'quality' || lo === hi ? false : key === 'balance' ? i % 2 === 0 : scoreOf(q) < S.th; if (i < k) bins[toLo ? 'lo' : 'hi'].push(q); });
          list.slice(k).forEach((q, i) => { s += `<circle cx="${f1(48 + i * 18)}" cy="${y + 52}" r="6" style="fill:var(${q.s ? '--k-chat' : '--k-write'})"/>`; });
          if (k < list.length) s += T(36, y + 80, 'ждут маршрута', 'xrt-ms');
          [['lo', 'малая', 330], ['hi', 'сильная', 480]].forEach(([bk, name, x]) => {
            const arr = bins[bk], weak = bk === 'lo' ? arr.filter(q => !q.s).length : arr.filter(q => q.s).length, price = arr.length * apiPrice(bk === 'lo' ? lo : hi);
            s += R(x, y + 34, 140, 112, 'xrt-bin', 8) + T(x + 10, y + 52, `${name}: ${arr.length}`, 'xrt-fn');
            arr.forEach((q, i) => { s += `<circle cx="${f1(x + 16 + (i % 6) * 20)}" cy="${f1(y + 72 + Math.floor(i / 6) * 20)}" r="6" style="fill:var(${q.s ? '--k-chat' : '--k-write'})"/>`; });
            s += T(x + 10, y + 120, rub(price), 'xrt-ms') + (weak ? T(x + 10, y + 138, bk === 'lo' ? `${weak} слабых` : `${weak} переплат`, 'xrt-pn ' + (bk === 'lo' ? 'xrt-bad' : 'xrt-warn')) : '');
          });
          s += T(36, y + 110, `цена ответа ${rub(mixOf(key, lo, hi))}`, 'xr-s') + T(36, y + 130, `качество ${pct(qualOf(key, lo, hi))}`, 'xr-s');
        });
        s += R(648, 60, 328, 484, 'xrt-codebg', 10) + T(660, 82, 'КОНФИГ РОУТЕРА (как в LiteLLM)', 'xr-m');
        ['model_list:', '  - model_name: small', `    model: ${cut(ps[0].name, 18)}`, '  - model_name: strong', `    model: ${cut(ps[ps.length - 1].name, 18)}`, 'router_settings:', `  routing_strategy: ${st === 'balance' ? 'simple-shuffle' : 'custom'}`, `  # ${STRAT[st]}`, `  fallbacks: ${P().failover ? '[{small: [strong]}]' : '[]'}`, `  timeout: ${TO / 1000}`, '  num_retries: 1', '  cooldown_time: 30', '# хук перед вызовом:', `# score < ${nf(S.th, 1).replace(',', '.')} → small, иначе strong`].forEach((l, j) => { s += MONO(660, 110 + j * 21, ES(l), l.startsWith('#') || l.includes('# ') ? 'dim' : l.endsWith(':') ? 'on' : ''); });
        s += T(660, 422, 'Правила меняют в конфиге —', 'xr-s') + T(660, 444, 'сервис перевыкатывать не нужно.', 'xr-s') + T(660, 478, 'VIP-клиентов можно всегда слать', 'xrt-ms') + T(660, 498, 'в сильную, длинный контекст —', 'xrt-ms') + T(660, 518, 'в модель с большим окном.', 'xrt-ms');
        return s;
      }
      function vPool() {
        const ps = pool(), C = 3000, u = S.vt % C;
        let s = head('Пул моделей за роутером', virt(ps) ? 'на схеме за роутером нет моделей — показываем, как было бы с малой и средней' : 'настоящие модели со схемы: размер, где работают, лимит, доля потока и цена ответа');
        s += R(24, 60, 952, 54 + Math.min(ps.length, 5) * 48, 'xrt-panel on', 10);
        [['модель', 36], ['размер', 300], ['где', 400], ['лимит', 520], ['сейчас', 630], ['загрузка', 720], ['цена ответа', 964]].forEach(([t, x], i) => { s += T(x, 84, t, 'xrt-ms', i === 6 ? 'end' : null); });
        ps.slice(0, 5).forEach((m, j) => {
          const y = 116 + j * 48, r = rpsOf(m, ps), cap = m.api ? effTier(m, ps) : (resOf(m.id).cap || 0), util = cap ? r * (S.scn === 'limit' ? 5 : 1) / cap : 0, dn = isDown(m, ps);
          s += T(36, y, ES(cut(m.name, 30)), 'xrt-name') + T(300, y, SHORT[m.size], 'xrt-ms') + T(400, y, m.api ? 'API' : `GPU × ${m.gpus}`, 'xrt-ms') + T(520, y, cap ? `${nf(cap, cap < 10 ? 1 : 0)}/с` : '—', 'xrt-ms') + T(630, y, `${nf(r, r < 10 ? 1 : 0)}/с`, 'xrt-ms');
          s += R(720, y - 10, 140, 10, 'xr-bar', 3) + R(720, y - 10, 140 * clamp(util, 0, 1), 10, 'xr-bar-f' + (util > 1 ? ' bad' : util > 0.75 ? ' warn' : ''), 3) + T(964, y, dn ? 'упала' : rub(priceOf(m, ps)), 'xrt-pn' + (dn ? ' xrt-bad' : ''), 'end');
          const n = dn ? 0 : clamp(Math.round(shareOf(m, ps) * 12), 1, 8);
          s += Ln(36, y + 16, 860, y + 16, 'xrt-track');
          for (let i = 0; i < n; i++) { const x = 36 + ((u / C + i / n) % 1) * 824; s += `<circle class="xrt-flow" cx="${f1(x)}" cy="${y + 16}" r="3.5"/>`; }
          if (dn) s += XM(448, y + 16, 5);
        });
        const y2 = 126 + Math.min(ps.length, 5) * 48;
        const month = ps.reduce((a, m) => a + (m.api ? priceOf(m, ps) * rpsOf(m, ps) * MONTH : m.gpus * SD.GPU_COST * RUB), 0);
        s += R(24, y2, 470, 548 - y2, 'xrt-panel', 10) + T(36, y2 + 22, 'ВИРТУАЛЬНЫЕ КЛЮЧИ И БЮДЖЕТЫ', 'xr-m');
        [['поддержка', 0.62, month * 0.8], ['маркетинг', 0.35, month * 0.2]].forEach(([t, f, b], j) => {
          const y = y2 + 52 + j * 46, budget = Math.max(1000, b * 1.2);
          s += T(36, y, `ключ «${t}» · бюджет ${rub(budget)}/мес`, 'xr-s') + R(36, y + 8, 440, 9, 'xr-bar', 3) + R(36, y + 8, 440 * f, 9, 'xr-bar-f' + (f > 0.8 ? ' warn' : ' acc'), 3) + T(476, y + 30, `потрачено ${pct(f)}`, 'xrt-pn', 'end');
        });
        if (548 - y2 > 150) s += T(36, y2 + 150, 'кончился бюджет — запросы режутся (429)', 'xrt-ms') + T(36, y2 + 170, 'или идут в дешёвую модель', 'xrt-ms');
        s += R(506, y2, 470, 548 - y2, 'xrt-codebg', 10) + T(518, y2 + 22, 'ЧТО ЕЩЁ ДЕРЖИТ РОУТЕР', 'xr-m');
        ['· ключи провайдеров — в одном месте', '· лимиты запросов и токенов на команду', '· учёт токенов и цены по моделям', '· логи вызовов: задержка, ошибки', '· повторы, фолбэк, предохранитель'].forEach((l, j) => { if (y2 + 50 + j * 26 < 540) s += T(518, y2 + 50 + j * 26, l, 'xr-s'); });
        S.pv.pool = 1;
        return s;
      }
      function vFallback() {
        const ps = pool(), A = ps[0], B = ps.find(m => m.id !== A.id && m.size === A.size) || ps.find(m => m.id !== A.id) || A, C = 12000, u = S.vt % C, on = P().failover;
        const X0 = 60, W = 880, sx = t => X0 + clamp(t / 6000, 0, 1) * W, gB = GEN[B.size];
        let s = head('Фолбэк и предохранитель', `«${cut(A.name, 24)}» не отвечает. Что получит пользователь?`);
        const lane = (y, title, on2, bars, endTxt, endCls) => {
          let t = R(24, y, 952, 146, 'xrt-panel' + (on2 ? ' on' : ''), 10) + T(36, y + 22, title, 'xr-t xrt-tt') + (on2 ? T(964, y + 22, 'так сейчас', 'xrt-pn xrt-acc', 'end') : '');
          for (let i = 0; i <= 6; i++) t += Ln(sx(i * 1000), y + 44, sx(i * 1000), y + 92, 'xrt-grid') + T(sx(i * 1000), y + 108, `${i} с`, 'xrt-ms', 'middle');
          bars.forEach(([a, b2, txt, cls]) => { if (u >= a) { const e = Math.min(b2, u); t += R(sx(a), y + 52, Math.max(2, sx(e) - sx(a)), 30, 'xrt-seg ' + cls, 5) + (e - a > 700 ? T(sx(a) + 8, y + 72, ES(txt), 'xrt-sgt') : ''); } });
          t += Ln(sx(Math.min(u, 6000)), y + 40, sx(Math.min(u, 6000)), y + 96, 'xrt-now');
          if (u >= bars[bars.length - 1][1]) t += T(36, y + 134, endTxt, 'xr-s ' + endCls) + (endCls === 'xrt-bad' ? T(sx(bars[1][1]) + 8, y + 72, '503', 'xrt-pop xrt-bad') : '');
          return t;
        };
        s += lane(60, 'Без фолбэка', !on, [[0, TO, `ждём «${cut(A.name, 16)}»`, 'wait'], [TO, TO + 300, '', 'bad']], `пользователь получил 503 через ${ms(TO)} — каждый запрос ждёт таймаут`, 'xrt-bad');
        s += lane(214, 'С фолбэком', on, [[0, TO, `ждём «${cut(A.name, 16)}»`, 'wait'], [TO, TO + gB, 'отвечает запасная', 'ok']], `ответ через ${ms(TO + gB)}: ${ms(TO)} ушло на ожидание`, 'xrt-warn');
        // предохранитель: замкнут → 3 ошибки → разомкнут → пробный
        const y = 368;
        s += R(24, y, 952, 180, 'xrt-panel' + (on ? ' on' : ''), 10) + T(36, y + 22, 'Предохранитель: не ждать таймаут у больной модели', 'xr-t xrt-tt');
        const ph = u < 3000 ? 0 : u < 8000 ? 1 : u < 9500 ? 2 : 3, st = [['ЗАМКНУТ', 'запросы идут в модель'], ['РАЗОМКНУТ', 'сразу в запасную, 0 мс ожидания'], ['ПРОБНЫЙ', 'один запрос: жива ли?'], ['ЗАМКНУТ', 'ответила — снова в работе']];
        [0, 1, 2].forEach(i => { const x = 70 + i * 300, cur = (ph === 3 ? 0 : ph) === i; s += R(x, y + 40, 220, 64, 'xrt-state' + (cur ? ' on' : '') + (i === 1 ? ' bad' : i === 2 ? ' warn' : ''), 10) + T(x + 110, y + 66, st[i][0], 'xrt-fn', 'middle') + T(x + 110, y + 88, st[i][1], 'xrt-ms', 'middle'); if (i < 2) s += Ln(x + 224, y + 72, x + 294, y + 72, 'xrt-arr'); });
        s += T(320, y + 124, '3 ошибки подряд →', 'xrt-ms', 'middle') + T(620, y + 124, `пауза ${OPEN / 1000} с →`, 'xrt-ms', 'middle');
        const fails = ph === 0 ? Math.min(3, Math.floor(u / 1000) + 1) : 3;
        for (let i = 0; i < 3; i++) s += i < fails ? XM(90 + i * 22, y + 124, 6) : `<circle class="xrt-fail" cx="${90 + i * 22}" cy="${y + 124}" r="5"/>`;
        s += T(36, y + 150, ph === 0 ? `ошибок подряд: ${fails} из 3` : ph === 1 ? `разомкнут: запросы идут в «${cut(B.name, 22)}» без ожидания` : ph === 2 ? 'пробный запрос в больную модель' : 'модель ответила — предохранитель замкнут', 'xr-s ' + (ph === 1 ? 'xrt-ok' : ph === 2 ? 'xrt-warn' : ''));
        s += T(36, y + 170, on ? 'Фолбэк включён: при отказе запрос уходит в запасную модель.' : 'Фолбэк выключен: разомкнутый предохранитель хотя бы отдаёт ошибку сразу.', 'xrt-ms');
        return s;
      }
      function vMisroute() {
        const ps = pool(), { lo, hi } = ends(ps), list = D().qs.concat(D().qs.filter(q => q.tr)), C = list.length * 600 + 2400, u = S.vt % C, k = Math.min(list.length, Math.floor(u / 600));
        let s = head('Ошибка маршрутизации', 'классификатор ошибается: сложное уходит в слабую модель (плохой ответ), простое — в сильную (переплата)');
        s += R(24, 60, 560, 300, 'xrt-panel on', 10) + T(36, 82, `${list.length} ВОПРОСОВ · ПОРОГ ${nf(S.th, 1)}`, 'xr-m');
        s += T(320, 104, 'ушёл в малую', 'xrt-fn', 'middle') + T(480, 104, 'ушёл в сильную', 'xrt-fn', 'middle') + T(36, 160, 'на деле простой', 'xrt-fn') + T(36, 270, 'на деле сложный', 'xrt-fn');
        const cell = { ls: [], hs: [], lc: [], hc: [] };
        list.slice(0, k).forEach(q => { const toLo = scoreOf(q) < S.th; cell[(toLo ? 'l' : 'h') + (q.s ? 's' : 'c')].push(q); });
        [['ls', 240, 116, '✓ дёшево и хорошо', 'ok'], ['hs', 400, 116, 'переплата', 'warn'], ['lc', 240, 226, 'слабый ответ', 'bad'], ['hc', 400, 226, '✓ сильная справилась', 'ok']].forEach(([key, x, y, lab, c]) => {
          const arr = cell[key];
          s += R(x, y, 156, 100, 'xrt-cell ' + c, 8) + T(x + 10, y + 26, String(arr.length), 'xrt-num sm') + T(x + 10, y + 90, lab, 'xrt-pn xrt-' + c);
          arr.forEach((q, i) => { s += `<circle cx="${f1(x + 16 + (i % 7) * 19)}" cy="${f1(y + 44 + Math.floor(i / 7) * 17)}" r="6" style="fill:var(${q.s ? '--k-chat' : '--k-write'})"/>`; });
        });
        const sh = AI().simple, pLo = (1 - sh) * 0.1, pHi = sh * 0.1;   // классификатор ошибается в ~10 % случаев
        const day = rpsAll() * 86400, weakDay = day * pLo, overDay = day * pHi * Math.max(0, apiPrice(hi) - apiPrice(lo));
        s += R(596, 60, 380, 300, 'xrt-panel', 10) + T(608, 82, 'ЦЕНА ОШИБОК ЗА ДЕНЬ', 'xr-m') + T(964, 82, 'ошибка ≈ 10 %', 'xrt-ms', 'end');
        [[`поток ${nf(rpsAll(), rpsAll() < 10 ? 1 : 0)}/с → ${nf(day)} вопросов в день`, ''], [`слабых ответов: ${nf(pLo * 100, 1)} % → ${nf(weakDay)}`, 'xrt-bad'], ['из них 5 % переспрашивают оператора', ''], [`× 300 ₽ за обращение = ${rub(weakDay * 0.05 * 300)}`, 'xrt-bad'], [`переплата: ${nf(pHi * 100, 1)} % вопросов → ${rub(overDay)}`, 'xrt-warn'], ['слабый ответ дороже переплаты:', ''], ['деньги уходят на жалобы, а не на токены', '']].forEach(([l, c], j) => { s += T(608, 112 + j * 30, l, 'xr-s' + (c ? ' ' + c : '')); });
        // каскад
        const y = 372, cu = S.vt % 6000, step2 = cu < 900 ? 0 : cu < 2000 ? 1 : cu < 3000 ? 2 : cu < 4600 ? 3 : 4;
        s += R(24, y, 952, 176, 'xrt-panel' + (S.cascade ? ' on' : ''), 10) + T(36, y + 22, 'Каскад: малая отвечает и оценивает уверенность — низкая уверенность → переспросить сильную', 'xr-t xrt-tt');
        const st = [['вопрос', '«А если досрочно?»'], ['малая модель', rub(apiPrice(lo))], ['уверенность', '0,41 < 0,7'], ['сильная модель', rub(apiPrice(hi))], ['ответ', '✓ полный']];
        st.forEach(([a, b2], i) => { const x = 40 + i * 188, on = step2 >= i; s += R(x, y + 46, 160, 60, 'xrt-state' + (on ? ' on' : '') + (i === 2 && on ? ' warn' : ''), 8) + T(x + 80, y + 70, a, 'xrt-fn', 'middle') + T(x + 80, y + 92, b2, 'xrt-ms', 'middle'); if (i < 4) s += Ln(x + 162, y + 76, x + 186, y + 76, 'xrt-arr'); });
        s += T(36, y + 130, `цена сложного вопроса: ${rub(apiPrice(lo) + apiPrice(hi))} вместо ${rub(apiPrice(hi))}; простые остаются в малой за ${rub(apiPrice(lo))}`, 'xr-s');
        s += T(36, y + 154, S.cascade ? 'Каскад сейчас включён (ситуация «Обманчивые вопросы»).' : 'Включить каскад можно в ситуации «Обманчивые вопросы».', 'xrt-ms' + (S.cascade ? ' xrt-ok' : ''));
        return s;
      }
      function vCost() {
        const ps = pool(), { lo, hi } = ends(ps), st = P().strategy, rps = rpsAll();
        let s = head('Цена и качество', `простое — в дешёвую модель, сложное — в сильную; поток с площадки ${nf(rps, rps < 10 ? 1 : 0)} вопросов/с, $1 = 90 ₽`);
        s += R(24, 60, 952, 200, 'xrt-panel on', 10) + T(36, 82, 'ТРИ СТРАТЕГИИ ПРИ ТВОЁМ ПОТОКЕ (ЦЕНЫ API)', 'xr-m');
        s += MONO(36, 108, 'стратегия        в малую   за ответ       в месяц   качество', 'dim');
        const mx = Math.max(...['cost', 'quality', 'balance'].map(k => mixOf(k, lo, hi)));
        ['cost', 'quality', 'balance'].forEach((k, j) => {
          const y = 140 + j * 36, on = k === st, pr = mixOf(k, lo, hi);
          s += MONO(36, y, `${STRAT[k].padEnd(16)}${pct(smallOf(k, lo, hi)).padStart(8)}${rub(pr).padStart(11)}${rub(pr * rps * MONTH).padStart(14)}${pct(qualOf(k, lo, hi)).padStart(11)}`, on ? 'on' : '') + R(680, y - 14, 280 * pr / mx, 18, 'xrt-pbar' + (on ? '' : ' dim'), 3);
        });
        s += T(36, 248, `${SHORT[lo]}: ${rub(apiPrice(lo))} за ответ · ${SHORT[hi]}: ${rub(apiPrice(hi))} — разница в ${nf(apiPrice(hi) / Math.max(1e-6, apiPrice(lo)))} раз`, 'xrt-ms');
        s += R(24, 272, 470, 276, 'xrt-panel', 10) + T(36, 294, virt(ps) ? 'КАК БЫЛО БЫ (НА СХЕМЕ МОДЕЛЕЙ НЕТ)' : 'НА ПЛОЩАДКЕ СЕЙЧАС', 'xr-m');
        let tot = 0;
        ps.slice(0, 5).forEach((m, j) => { const c = m.real ? (resOf(m.id).cost || 0) * RUB : (m.api ? priceOf(m, ps) * rpsOf(m, ps) * MONTH : 0); tot += c; s += T(36, 324 + j * 26, ES(cut(m.name, 26)), 'xrt-fn') + T(330, 324 + j * 26, `${nf(rpsOf(m, ps), 1)}/с`, 'xrt-ms', 'end') + T(482, 324 + j * 26, rub(c), 'xrt-pn', 'end'); });
        const yy = 324 + Math.min(ps.length, 5) * 26;
        s += T(36, yy + 8, `итого модели: ${rub(tot)} в месяц`, 'xr-s xrt-acc');
        const q = ctx.all && ctx.all.ai && ctx.all.ai.quality;
        s += T(36, yy + 32, q != null ? `качество ответов на площадке: ${pct(q)}` : 'качество посчитает симулятор, когда пойдёт поток', 'xrt-ms');
        s += R(506, 272, 470, 276, 'xrt-codebg', 10) + T(518, 294, 'КАК СЧИТАЕМ', 'xr-m');
        ['цена ответа =', '  вход × $ за 1М входа', '+ выход × $ за 1М выхода', 'средняя = доля в малую × малая', '        + доля в сильную × сильная', 'месяц = средняя × поток × 2,63 млн с', 'качество = простые × качество на них', '         + сложные × качество на них'].forEach((l, j) => { s += MONO(518, 322 + j * 26, ES(l), j === 0 || j === 3 || j === 5 || j === 6 ? 'on' : ''); });
        return s;
      }
      const VIEWS = { classify: vClassify, policy: vPolicy, pool: vPool, fallback: vFallback, misroute: vMisroute, cost: vCost };
      function partNow(k) {
        const ps = pool(), { lo, hi } = ends(ps), st = P().strategy;
        if (k === 'classify') return `<b>Классификатор:</b> признаки вопроса дают оценку сложности. Ниже порога ${nf(S.th, 1)} — малая модель, выше — сильная. Ошибается на коротких сложных и длинных простых вопросах — подвигай порог справа внизу.`;
        if (k === 'policy') return `<b>Стратегия «${STRAT[st]}»:</b> цена ответа ${rub(mixOf(st, lo, hi))}, качество ${pct(qualOf(st, lo, hi))}. Три дорожки показывают, куда уходят одни и те же 10 вопросов при разных правилах.`;
        if (k === 'pool') return `<b>Пул:</b> ${ps.length} ${pl(ps.length, 'модель', 'модели', 'моделей')} за роутером${virt(ps) ? ' (на схеме их нет — показываем, как было бы)' : ''}. У каждой свой лимит, загрузка и цена; бюджеты команд роутер держит в виртуальных ключах.`;
        if (k === 'fallback') return `<b>Фолбэк ${P().failover ? 'включён' : 'выключен'}:</b> ${P().failover ? 'упавшая модель стоит пользователю лишних 2 с, а не ошибки.' : 'упавшая модель — это 503 у пользователя.'} Предохранитель после 3 ошибок подряд перестаёт ждать таймаут у больной модели.`;
        if (k === 'misroute') return `<b>Ошибки маршрута при пороге ${nf(S.th, 1)}:</b> сложное в малой модели — слабый ответ и жалоба, простое в сильной — переплата. Каскад исправляет первое ценой второго вызова.`;
        if (k === 'cost') return `<b>Цена:</b> малая ${rub(apiPrice(lo))}, сильная ${rub(apiPrice(hi))} за ответ. «${STRAT[st]}» — ${rub(mixOf(st, lo, hi))} в среднем, ${rub(mixOf(st, lo, hi) * rpsAll() * MONTH)} в месяц.`;
        return '';
      }

      /* ---------- кнопки ---------- */
      function setStrat(v) {
        const prev = P().strategy; if (prev === v) return;
        ctx.setProp('strategy', v);
        ctx.log(`<b>Стратегия: ${STRAT[v]}.</b> ${hook('strategy', prev, v)}`, 'chg');
      }
      function act(k) {
        if (k.startsWith('st-')) { setStrat(k.slice(3)); return; }
        if (k === 'fo') { const prev = P().failover; ctx.setProp('failover', !prev); ctx.log(`<b>Фолбэк ${!prev ? 'включён' : 'выключен'}.</b> ${hook('failover', prev, !prev)}`, 'chg'); return; }
        if (k === 'casc') { S.cascade = !S.cascade; ctx.log(S.cascade ? '<b>Каскад включён:</b> ответ малой модели проверяется на уверенность; низкая — вопрос уйдёт в сильную.' : '<b>Каскад выключен.</b>', 'chg'); return; }
        if (/^th[\d.]+$/.test(k)) { S.th = +k.slice(2); ctx.log(`<b>Порог классификатора ${nf(S.th, 1)}.</b> ${S.th > 0.6 ? 'Больше вопросов уйдёт в малую — дешевле, но сложные получат слабый ответ.' : S.th < 0.4 ? 'Больше вопросов уйдёт в сильную — качество выше, цена тоже.' : 'Середина: так обучен классификатор.'}`, 'chg'); if (S.th >= 0.7 && ctx.part() === 'classify') done('pthr'); }
      }
      function hook(key, prev, v) {
        const ps = pool(), { lo, hi } = ends(ps);
        S.cfgT = 0;
        if (key === 'strategy') {
          if (S.scn === 'bill') { if (v === 'quality') S.flags.bq = 1; if (v === 'cost' && S.flags.bq) done('strat'); }
          return `Цена ответа ${rub(mixOf(v, lo, hi))} вместо ${rub(mixOf(prev, lo, hi))}, качество ${pct(qualOf(v, lo, hi))}. В месяц ≈ ${rub(mixOf(v, lo, hi) * rpsAll() * MONTH)}.`;
        }
        if (key === 'failover') return v ? 'Отказ модели или 429 — запрос уйдёт в следующую модель.' : 'Без фолбэка отказ модели станет ошибкой у пользователя.';
        return '';
      }
      const onClick = ev => { const b = ev.target.closest && ev.target.closest('[data-xrt]'); if (!b) return; ev.stopPropagation(); act(b.dataset.xrt); };
      const onKey = ev => { if (ev.key !== 'Enter' && ev.key !== ' ') return; const b = ev.target.closest && ev.target.closest('[data-xrt]'); if (!b) return; ev.preventDefault(); ev.stopPropagation(); act(b.dataset.xrt); };
      ctx.svg.addEventListener('click', onClick); ctx.svg.addEventListener('keydown', onKey);

      /* ---------- шаг ---------- */
      function reset() {
        Object.assign(S, { t: 0, reqs: [], log: [], ev: [], rej: [], rid: 1040, seq: 0, tk: 0, nextAt: 300, cur: null, cfgT: 0, rr: {}, bal: false, br: {} });
      }
      function tick(dt) {
        if (!S.reqs) return;
        S.t += dt; S.cfgT += dt;
        if (ctx.part && ctx.part()) S.vt += dt;
        if (S.t >= S.nextAt) { const gap = S.scn === 'limit' ? 420 : S.scn === 'bill' ? 650 : S.scn === 'down' ? 1000 : 1300; S.nextAt = S.t + gap * (0.6 + Math.random() * 0.8); spawn(); }
        const ps = pool();
        S.reqs.forEach(r => step(r, ps));
        S.reqs = S.reqs.filter(r => r.ph !== 'done');
        S.ev = S.ev.filter(e => e.t > S.t - 20000); S.rej = S.rej.filter(t => t > S.t - 20000);
      }
      function draw() {
        if (!S.reqs) return;
        const pk = ctx.part && ctx.part();
        if (pk && VIEWS[pk]) { gSt.innerHTML = VIEWS[pk](); gDy.innerHTML = ''; return; }
        drawMain();
      }

      reset();
      return {
        tick, draw,
        focus() { S.vt = 0; S.pv = {}; },
        refresh() {},
        scenario(id) { const keep = S.cascade; S.scn = id; reset(); S.cascade = id === 'tricky' ? keep : false; if (id === 'limit') S.flags.u429 = S.flags.spill = 0; if (id === 'bill') S.flags.bq = 0; if (id === 'norm') S.flags.sLo = S.flags.sHi = 0; },
        onProp(key, prev, v) { return hook(key, prev, v); },
        now() {
          const pk = ctx.part && ctx.part();
          if (pk && VIEWS[pk]) return partNow(pk);
          const ps = pool(), { lo, hi } = ends(ps), st = P().strategy, c = S.cur;
          const pre = virt(ps) ? 'За роутером на схеме нет моделей — показываем, как было бы с малой и средней. ' : lo === hi ? 'За роутером модели одного размера: делить по сложности не на что, роутер делит нагрузку и даёт фолбэк. ' : '';
          if (S.scn === 'tricky') return pre + (S.cascade ? '<b>Каскад включён:</b> малая модель отвечает и оценивает уверенность. На сложном вопросе уверенность низкая — его переспрашивают у сильной. Ошибка маршрута исправлена ценой второго вызова.' : `<b>Обманчивые вопросы:</b> «${ES(cut(D().qs[6].q, 30))}» — короткий, но сложный: оценка низкая, вопрос уходит в малую, ответ слабый. Длинный вежливый простой вопрос уходит в сильную — переплата. Включи каскад под роутером.`);
          if (S.scn === 'down') { const A = ps[0], b = br(A.id); return pre + (P().failover ? (brState(A.id) === 'open' ? `<b>Предохранитель разомкнут:</b> «${ES(A.name)}» не отвечает, запросы сразу идут в запасную — без ожидания ${ms(TO)}.` : `<b>«${ES(A.name)}» не отвечает.</b> Каждый запрос ждёт таймаут ${ms(TO)}, потом уходит в запасную. Ошибок подряд: ${b.fails} из ${BRK} — после ${BRK} предохранитель разомкнётся.`) : `<b>Фолбэк выключен:</b> «${ES(A.name)}» не отвечает, и пользователи получают 503 — после таймаута или сразу, если предохранитель разомкнут.`); }
          if (S.scn === 'limit') { const m = byId(ps, limId(ps)); return pre + (m ? `<b>Лимит 429:</b> поток ×5, у «${ES(m.name)}» лимит ${effTier(m, ps)} запросов/с — ${pct(p429(m, ps))} запросов получают 429. ${P().failover ? 'Фолбэк сразу отправляет их в другую модель.' : 'Фолбэк выключен — 429 видит пользователь.'}` : '<b>Лимит 429:</b> у моделей за роутером свои GPU — вместо 429 у них растёт очередь (смотри сцену LLM).'); }
          if (S.scn === 'bill') return pre + `<b>Счёт за месяц:</b> при ${nf(rpsAll() * 3, 0)} вопросах/с «${STRAT[st]}» стоит ≈ ${rub(mixOf(st, lo, hi) * rpsAll() * 3 * MONTH)} в месяц, качество ${pct(qualOf(st, lo, hi))}. Всё в сильную — ${rub(apiPrice(hi) * rpsAll() * 3 * MONTH)} и ${pct(qualOf('quality', lo, hi))}.`;
          return pre + `<b>Роутер делит поток:</b> ${c ? `вопрос «${ES(cut(c.it.q, 36))}» получил оценку ${nf(c.sc, 2)}. ` : ''}${st === 'cost' && lo !== hi ? `Ниже ${nf(S.th, 1)} — в малую модель за ${rub(apiPrice(lo))}, выше — в сильную за ${rub(apiPrice(hi))}.` : st === 'quality' ? 'Стратегия «всё в сильную»: оценка не нужна, всё уходит в сильную.' : 'Стратегия «поровну»: модели получают вопросы по очереди.'} В среднем ${rub(mixOf(st, lo, hi))} за ответ.`;
        },
        stats() {
          const ps = pool(), { lo, hi } = ends(ps), ev = S.ev, fin = ev.filter(e => e.kind === 'ok' || e.kind === 'weak' || e.kind === 'over');
          const sm = fin.filter(e => e.lo).length, avg = fin.length ? fin.reduce((a, e) => a + e.rub, 0) / fin.length : mixOf(P().strategy, lo, hi);
          const weak = ev.filter(e => e.kind === 'weak').length, over = ev.filter(e => e.kind === 'over').length, errs = ev.filter(e => e.kind === 'err' || e.kind === '429').length, fb = ev.filter(e => e.fb && e.kind !== 'err' && e.kind !== '429').length;
          return [
            ['В малую модель', fin.length ? pct(sm / fin.length) : '…', '', 'доля маршрутов, 20 с'],
            ['Цена ответа', rub(avg), '', 'в среднем, 20 с'],
            ['Всё в сильную', rub(apiPrice(hi)), '', 'для сравнения'],
            ['Ошибки маршрута', `${weak} · ${over}`, weak ? 'bad' : over ? 'warn' : 'ok', 'слабых · переплат'],
            ['Отказы', String(errs), errs ? 'bad' : 'ok', '503 и 429 у людей, 20 с'],
            ['Через запасную', String(fb), fb ? 'ok' : '', 'спас фолбэк, 20 с']
          ];
        },
        destroy() { ctx.svg.removeEventListener('click', onClick); ctx.svg.removeEventListener('keydown', onKey); }
      };
    }
  };
})();
