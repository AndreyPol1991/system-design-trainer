/* Лаборатория «От требований к архитектуре»: нефункциональные требования → архитектурные решения
   с объяснением и проверкой текущей схемы на площадке. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const T = () => SD.TYPES;
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const OPT = {
    av: [['99', '99 %'], ['99.9', '99,9 %'], ['99.95', '99,95 %'], ['99.99', '99,99 %']],
    lat: [['1000', '≤ 1 с'], ['300', '≤ 300 мс'], ['100', '≤ 100 мс'], ['30', '≤ 30 мс']],
    cons: [['eventual', 'со временем (eventual)'], ['ryw', 'свои записи сразу'], ['strong', 'строгая']],
    rpo: [['hours', 'часы'], ['minutes', 'минуты'], ['zero', 'ноль']],
    rto: [['hours', 'часы'], ['minutes', 'минуты'], ['seconds', 'секунды']],
    mix: [['read', 'читают в разы чаще'], ['both', 'поровну'], ['write', 'пишут много']],
    geo: [['one', 'одна страна'], ['global', 'весь мир']],
    pii: [['no', 'нет'], ['yes', 'да']]
  };
  const LBL = { av: 'Доступность', lat: 'Время ответа p99', cons: 'Согласованность', rpo: 'Сколько данных можно потерять (RPO)', rto: 'За сколько восстановиться (RTO)', mix: 'Чтения и записи', geo: 'Пользователи', pii: 'Персональные данные' };
  const HELP = {
    av: 'Доля времени, когда сервис отвечает. Каждая девятка — в 10 раз меньше допустимого простоя.',
    lat: '99 % запросов должны укладываться в это время. Среднее обманчиво: хвост чувствуют самые активные пользователи.',
    cons: 'Насколько быстро все видят изменение. Строгая — сразу и все; eventual — через доли секунды.',
    rpo: 'Recovery Point Objective: данные за какой период не жалко потерять при аварии.',
    rto: 'Recovery Time Objective: за сколько система должна снова заработать после аварии.',
    mix: 'Определяет, что масштабировать: чтения (кэш, реплики) или записи (шарды, очередь).',
    geo: 'Далеко от сервера — значит, свет по оптоволокну идёт десятки миллисекунд.',
    pii: 'Паспорта, телефоны, адреса: шифрование, доступ по ролям, журнал доступа, хранение в стране.'
  };
  const minutes = av => Math.round(30 * 24 * 60 * (1 - parseFloat(av) / 100) * 10) / 10;

  /* ---------- решения ---------- */
  const has = (g, t) => g.nodes.filter(n => n.type === t);
  const svc = g => g.nodes.filter(n => n.type === 'app' || n.type === 'worker' || n.type === 'gateway');
  const D = [
    { id: 'n1', area: 'Надёжность', when: R => +R.av >= 99.9, t: 'Минимум два экземпляра каждого сервиса за балансировщиком с проверками здоровья',
      why: R => `${R.av.replace('.', ',')} % — это ${String(minutes(R.av)).replace('.', ',')} минут простоя в месяц. Одна перезагрузка сервера съест бюджет.`,
      check: g => { const bad = svc(g).filter(n => (n.props.count || 1) < 2 && !n.props.autoscale); const lb = has(g, 'lb').some(n => n.props.health !== false) || has(g, 'gateway').length; return { ok: !bad.length && lb, d: bad.length ? 'по одному экземпляру: ' + bad.map(nm).join(', ') : !lb ? 'нет балансировщика с проверками здоровья' : 'везде ≥ 2 экземпляров' }; } },
    { id: 'spof', area: 'Надёжность', when: R => +R.av >= 99.9, t: 'Нет единой точки отказа: падение любого одного узла не роняет сервис',
      why: () => 'Ломается всегда что-то одно — и обычно в самый неудобный момент.',
      check: (g, L) => { const ch = SD.sim.chaos(L, g).filter(c => !c.ok); return { ok: !ch.length, d: ch.length ? 'роняет всё: ' + ch.map(c => nm(g.nodes.find(n => n.id === c.id))).join(', ') : 'проверено падение каждого узла' }; } },
    { id: 'az', area: 'Надёжность', when: R => +R.av >= 99.95, t: 'Разнести по зонам доступности, автоматическое переключение базы',
      why: R => `${String(minutes(R.av)).replace('.', ',')} минуты в месяц — меньше, чем длится типичная авария дата-центра. Нужна вторая зона, которая подхватит без человека.`,
      check: g => { const one = g.nodes.filter(n => ['app', 'sql', 'cache', 'nosql'].includes(n.type) && (n.props.az || 1) < 2); return { ok: !one.length, d: one.length ? 'в одной зоне: ' + one.map(nm).join(', ') + ' (настройка «Зон доступности» — на облачных уровнях и в свободном режиме)' : 'всё в 2+ зонах' }; } },
    { id: 'obs', area: 'Надёжность', when: R => +R.av >= 99.95 || R.rto === 'seconds' || R.rto === 'minutes', t: 'Метрики и алерты: узнать о сбое за минуты, а не из жалоб',
      why: R => `Восстановиться за ${R.rto === 'seconds' ? 'секунды' : 'минуты'} нельзя, если о сбое узнают через час. Время обнаружения входит в простой.`,
      check: g => { const ok = has(g, 'prometheus').length && has(g, 'alertmanager').length; return { ok, d: ok ? 'Prometheus и Alertmanager на схеме' : 'нет Prometheus → Alertmanager' }; } },
    { id: 'canary', area: 'Надёжность', when: R => +R.av >= 99.99, t: 'Выкладка канарейкой или blue-green, флаги функций, быстрый откат',
      why: () => 'Большая часть аварий — после выкладки. При 4 минутах в месяц ошибку нужно поймать на 1 % трафика.', check: null },
    { id: 'cache', area: 'Скорость', when: R => +R.lat <= 100 && R.mix !== 'write', t: 'Кэш перед базой для горячих чтений',
      why: R => `≤ ${R.lat} мс на 99 % запросов: поход в базу с диском и очередью съедает это время. Ходовые ответы — из памяти.`,
      check: g => { const ok = has(g, 'cache').length > 0; return { ok, d: ok ? 'кэш на схеме' : 'нет кэша' }; } },
    { id: 'hops', area: 'Скорость', when: R => +R.lat <= 300, t: 'Не больше 2–3 синхронных вызовов подряд, таймауты на каждом',
      why: R => `Задержки цепочки складываются, а хвосты умножаются: 5 последовательных вызовов по 50 мс уже не уложатся в ${R.lat} мс на p99.`,
      check: g => { const cl = g.nodes.find(n => n.type === 'client'); let mx = 0; const walk = (id, d, seen) => { mx = Math.max(mx, d); g.edges.filter(e => e.from === id).forEach(e => { const b = g.nodes.find(n => n.id === e.to); if (!b || seen.has(b.id) || (T()[b.type] || {}).ops || b.type === 'queue') return; walk(b.id, d + 1, new Set([...seen, b.id])); }); }; if (cl) walk(cl.id, 0, new Set([cl.id])); return { ok: mx <= 4, d: `самая длинная синхронная цепочка — ${mx} ${mx === 1 ? 'шаг' : mx < 5 ? 'шага' : 'шагов'}` }; } },
    { id: 'cdn', area: 'Скорость', when: R => R.geo === 'global', t: 'CDN и точки присутствия рядом с пользователями',
      why: () => 'Москва — Владивосток по оптоволокну ≈ 120 мс туда-обратно, и это только сеть. Статику и кэшируемое отдают с ближайшей точки.',
      check: g => { const ok = has(g, 'cdn').length > 0; return { ok, d: ok ? 'CDN на схеме' : 'нет CDN' }; } },
    { id: 'readscale', area: 'Масштаб', when: R => R.mix === 'read', t: 'Чтения масштабируют кэш и реплики',
      why: () => 'Реплики берут на себя чтения, кэш — повторные. Primary остаётся записям.',
      check: g => { const ok = has(g, 'cache').length || has(g, 'sql').some(n => (n.props.replicas || 0) > 0); return { ok: !!ok, d: ok ? 'есть кэш или реплики' : 'ни кэша, ни реплик' }; } },
    { id: 'writescale', area: 'Масштаб', when: R => R.mix === 'write', t: 'Записи: очередь, пачки, шарды',
      why: () => 'Запись принимает только primary. Пик сглаживает очередь, объём делят шарды.',
      check: g => { const q = has(g, 'queue').length, sh = has(g, 'sql').some(n => (n.props.shards || 1) > 1) || has(g, 'nosql').length; return { ok: !!(q || sh), d: q ? 'есть очередь' : sh ? 'есть шарды или NoSQL' : 'ни очереди, ни шардов' }; } },
    { id: 'strong', area: 'Данные', when: R => R.cons === 'strong', t: 'Транзакции в одной базе, Serializable или блокировки на спорных строках',
      why: () => 'Строгая согласованность — когда двое не должны продать последнее место. Кэш и асинхронные реплики её ломают.',
      check: g => { const s = has(g, 'sql'); const ok = s.some(n => ['ser', 'rr'].includes(n.props.isolation) || ['pessimistic', 'optimistic'].includes(n.props.locking)); return { ok, d: ok ? 'изоляция или блокировки настроены' : s.length ? 'Read Committed без блокировок' : 'нет реляционной базы' }; } },
    { id: 'ryw', area: 'Данные', when: R => R.cons === 'ryw', t: 'Читать свои записи с primary (read-your-writes)',
      why: () => 'Пользователь оформил заказ и сразу открыл «Мои заказы» — реплика может ещё не знать о нём.',
      check: g => { const s = has(g, 'sql').filter(n => (n.props.replicas || 0) > 0); return { ok: !s.length || s.every(n => n.props.ryw || n.props.replMode === 'sync'), d: !s.length ? 'реплик нет — читаем с primary' : s.every(n => n.props.ryw || n.props.replMode === 'sync') ? 'свои записи — с primary' : 'чтение с реплик без «своих записей»' }; } },
    { id: 'rpo0', area: 'Данные', when: R => R.rpo === 'zero', t: 'Синхронная (или полусинхронная) репликация: подтверждаем запись, когда она есть минимум в двух местах',
      why: () => 'При асинхронной репликации упавший primary уносит последние подтверждённые транзакции. RPO = 0 — значит, запись подтверждена ещё и репликой.',
      check: g => { const s = has(g, 'sql'); const ok = s.length && s.every(n => (n.props.replicas || 0) > 0 && ['sync', 'semisync'].includes(n.props.replMode)); return { ok: !!ok, d: ok ? 'реплики синхронные' : s.length ? 'реплики асинхронные или их нет' : 'нет реляционной базы' }; } },
    { id: 'rpomin', area: 'Данные', when: R => R.rpo === 'minutes', t: 'Асинхронная реплика плюс непрерывный архив журнала (PITR)', why: () => 'Потеря нескольких секунд–минут допустима; восстановление на любой момент — из базовой копии и журнала WAL.', check: null },
    { id: 'rto', area: 'Данные', when: R => R.rto !== 'hours', t: 'Горячий резерв: реплика, готовая стать primary', why: R => `Восстановление из бэкапа большой базы — часы. Чтобы уложиться в ${R.rto === 'seconds' ? 'секунды' : 'минуты'}, резерв должен уже работать и догонять журнал.`,
      check: g => { const s = has(g, 'sql'); const ok = s.length && s.every(n => (n.props.replicas || 0) > 0); return { ok: !!ok, d: ok ? 'у базы есть реплика' : s.length ? 'у базы нет реплики' : 'нет реляционной базы' }; } },
    { id: 'pii', area: 'Безопасность', when: R => R.pii === 'yes', t: 'Шифрование, доступ по ролям, журнал доступа, хранение в стране (152-ФЗ)',
      why: () => 'Персональные данные граждан РФ хранятся на серверах в России; утечка — штрафы и репутация.', check: null }
  ];

  const KEY = 'amp-stroyka-nfr-v1';
  let R = { av: '99.9', lat: '300', cons: 'ryw', rpo: 'minutes', rto: 'minutes', mix: 'read', geo: 'one', pii: 'no' };
  try { Object.assign(R, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(R)); } catch (e) { /* без хранилища */ } };
  const seen = new Set();

  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'nfr', title: 'От требований к архитектуре', lede: '99,9 % и 200 мс: какие решения они диктуют',
    intro: 'Нефункциональные требования — это не галочки в ТЗ, а то, что определяет устройство системы. Выбери требования слева — справа появятся решения, которые они диктуют, с объяснением и проверкой твоей текущей схемы на площадке.',
    tasks: [
      { id: 'nines', text: 'Переключи доступность с 99,9 % на 99,99 % и посмотри, какие решения добавились' },
      { id: 'rpo', text: 'Выбери RPO «ноль» и найди, что это требует от базы' },
      { id: 'green', text: 'Добейся, чтобы все проверяемые решения для своих требований были ✓ на схеме' },
      { id: 'global', text: 'Включи «весь мир» и посмотри, что меняется в скорости' }
    ],
    mount(el, api) {
      const draw = () => {
        const A = SD.app && SD.app.A, g = A && A.graph, L = A && A.level;
        const act = D.filter(d => d.when(R));
        let h = '<div class="nf-wrap"><div class="nf-req"><h4>Требования</h4>';
        Object.keys(OPT).forEach(k => {
          h += `<div class="nf-q"><b>${esc(LBL[k])}</b><small>${esc(HELP[k])}</small><div class="seg">${OPT[k].map(([v, t]) => `<button type="button" data-nf="${k}" data-v="${v}" aria-selected="${R[k] === v}">${esc(t)}</button>`).join('')}</div></div>`;
        });
        h += `<p class="nf-budget">Бюджет простоя при ${R.av.replace('.', ',')} %: <b>${String(minutes(R.av)).replace('.', ',')} мин в месяц</b> · ${String(Math.round(minutes(R.av) * 12 / 60 * 10) / 10).replace('.', ',')} ч в год.</p></div>`;
        h += `<div class="nf-out"><h4>Решения · ${act.length}</h4><p class="nf-lvl">Проверяю схему уровня «${esc(L ? L.title : '—')}» — закрой лабораторию, поправь схему и открой снова.</p>`;
        const areas = [...new Set(act.map(d => d.area))];
        let checked = 0, okN = 0;
        areas.forEach(a => {
          h += `<section class="nf-area"><b>${esc(a)}</b>`;
          act.filter(d => d.area === a).forEach(d => {
            let c = null; try { c = d.check && g ? d.check(g, L) : null; } catch (e) { c = null; }
            if (c) { checked++; if (c.ok) okN++; }
            h += `<div class="nf-d ${c ? (c.ok ? 'ok' : 'bad') : ''}"><span class="nf-st">${c ? (c.ok ? '✓' : '✗') : '·'}</span><div><b>${esc(d.t)}</b><p>${esc(d.why(R))}</p>${c ? `<small>На схеме: ${esc(c.d)}</small>` : '<small>Не видно на схеме — решение процесса и настроек.</small>'}</div></div>`;
          });
          h += '</section>';
        });
        h += `<button type="button" class="dive-cta" data-nfdr>${SD.icon('sql')}<span><b>Проверить RPO и RTO учением</b><small>Площадка пропала, таблицу удалили, шифровальщик: уложится ли стратегия восстановления в эти требования</small></span></button>`;
        h += `<p class="nf-sum">Проверяемых на схеме: ${okN} из ${checked} выполнено.</p></div></div>`;
        el.innerHTML = h;
        if (checked && okN === checked) api.done('green');
      };
      el.addEventListener('click', e => {
        if (e.target.closest('[data-nfdr]')) { SD.labs.open('dr'); return; }
        const b = e.target.closest('[data-nf]'); if (!b) return;
        const k = b.dataset.nf, v = b.dataset.v, prev = R[k];
        R[k] = v; save();
        if (k === 'av' && prev === '99.9' && v === '99.99') api.done('nines');
        if (k === 'rpo' && v === 'zero') api.done('rpo');
        if (k === 'geo' && v === 'global') api.done('global');
        draw();
      });
      draw();
      return () => {};
    }
  });
})();
/* Лаборатория «Учение по восстановлению» (id dr): что делать, когда пропала целая площадка или испорчены данные.
   1) На пальцах: RTO и RPO на примере диплома — автосохранение и запасной ноутбук;
   2) копии и резервные площадки: от чего спасает каждая копия, холодная / «огонёк» / тёплая / горячая и их цена;
   3) учение: площадка пропала, удалили таблицу, шифровальщик — выбираешь стратегию, видишь фактическое время простоя
      и потерю данных против требований и цену в месяц;
   4) план восстановления как документ аналитика: когда объявляем аварию, роли, порядок шагов, связь, возврат обратно.
   Требования можно взять из лаборатории «От требований к архитектуре». Стили — префикс .dr-. */
(function () {
  if (!window.SD) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const isCalm = () => document.documentElement.classList.contains('calm');
  const plural = (n, a, b, c) => { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const dur = m => { if (m == null) return '—'; if (!isFinite(m)) return 'всё'; if (m < 1) return Math.max(1, Math.round(m * 60)) + ' с'; m = Math.round(m); if (m < 60) return m + ' мин'; const h = Math.floor(m / 60), r = m % 60; return h + ' ч' + (r ? ' ' + r + ' мин' : ''); };
  const usd = v => '$' + Math.round(v).toLocaleString('ru-RU');
  const KEY = 'amp-stroyka-dr-v1';
  const BASE_BILL = 9000;   // счёт платформы за облако в месяц, $ — допущение для цены резерва

  /* ---------- 1. на пальцах: диплом ---------- */
  const SAVE = [
    { k: 'day', n: 'Копирую на флешку вечером', last: 16 * 60 + 47, cost: 0 },
    { k: 'm30', n: 'Облачный диск: синхронизация раз в 30 минут', last: 17, cost: 0 },
    { k: 'm5', n: 'Облачный диск: раз в 5 минут', last: 2, cost: 0 },
    { k: 'cloud', n: 'Пишу в облачном документе', last: 0.05, cost: 300 }
  ];
  const SPARE = [
    { k: 'buy', n: 'Купить новый ноутбук', t: 24 * 60, cost: 0, how: 'завтра после обеда' },
    { k: 'old', n: 'Старый ноутбук из шкафа: поставить всё заново', t: 180, cost: 0, how: 'установка программ и шрифтов' },
    { k: 'peer', n: 'Ноутбук соседа: открыть копию', t: 15, cost: 0, how: 'открыть копию и писать' },
    { k: 'twin', n: 'Второй ноутбук рядом, всё уже открыто', t: 1, cost: 60000, how: 'пересел — и пишешь' }
  ];
  const DIP = { rpo: 30, rto: 60 };

  /* ---------- 2. копии и площадки ---------- */
  const BK = {
    nightly: { n: 'Ночная полная копия', sub: 'раз в сутки в 03:00, в другой регион', last: 16 * 60 + 40, restore: [['Восстановить базу 2 ТБ из полной копии', 240]], pct: 2 },
    snap: { n: 'Снимки диска каждые 4 часа', sub: 'последний — в 16:00', last: 3 * 60 + 40, restore: [['Поднять базу из снимка', 40]], pct: 4 },
    pitr: { n: 'Снимки + журнал изменений (PITR)', sub: 'журнал уходит в другой регион каждую минуту', last: 1, restore: [['Поднять базу из снимка', 40], ['Прокрутить журнал до нужной минуты', 10]], pct: 7 }
  };
  const SITE = {
    none: { n: 'Нет', an: 'Запасной квартиры нет: снимать новую, когда случилось', pct: 0, rto: 'сутки и больше' },
    cold: { n: 'Холодная', an: 'Ключи от пустой квартиры: стены есть, мебель завозить', sub: 'копии в другом регионе, инфраструктура описана кодом', pct: 5, rto: 'часы' },
    pilot: { n: '«Огонёк»', an: 'В запасной квартире горит свет и работает холодильник', sub: 'реплика базы работает, серверы выключены', pct: 15, rto: 'десятки минут' },
    warm: { n: 'Тёплая', an: 'Квартира обставлена, но маленькая', sub: 'работает уменьшенная копия, при аварии её раздувают', pct: 40, rto: 'минуты' },
    hot: { n: 'Горячая', an: 'Две равноценные квартиры, живёшь в обеих', sub: 'полная копия принимает трафик всегда', pct: 100, rto: 'секунды — минута' }
  };
  const IMM_PCT = 2;
  const DIS = {
    site: { n: 'Пропала площадка', an: 'Пожар в дата-центре: в 19:40 основной регион недоступен целиком' },
    drop: { n: 'Удалили таблицу', an: 'Ошибочная миграция в 19:40 удалила таблицу записей; заметили по жалобам через 10 минут' },
    ransom: { n: 'Шифровальщик', an: 'В 19:40 шифровальщик зашифровал базу и все копии, до которых дотянулся' }
  };
  const REQ_RTO = [[240, '4 ч'], [120, '2 ч'], [60, '1 ч'], [15, '15 мин']], REQ_RPO = [[1440, '24 ч'], [60, '1 ч'], [5, '5 мин'], [0, '0']];
  const DEF_REQ = { rto: 120, rpo: 5 };

  /* учение: шаги с длительностью в минутах и потеря данных */
  function drill(S, dis) {
    const steps = [], add = (t, m, k) => steps.push({ t, m, k: k || 'do' });
    const B = BK[S.bk], live = S.site === 'pilot' || S.site === 'warm' || S.site === 'hot', auto = S.site === 'hot';
    const decide = S.drills ? 10 : 45;
    let rpo = 0, lost = null, notes = [];
    if (dis === 'site') {
      add(auto ? 'Проверки здоровья заметили сбой' : 'Алерт: регион не отвечает', auto ? 1 : 5, 'det');
      if (!auto) add(S.drills ? 'Штаб собран по плану, решение — переключаться' : 'Ищем, кто решает, и где план', decide, 'dec');
      if (S.site === 'none') { add('Заказать и настроить серверы вручную', 240, 'inf'); B.restore.forEach(([t, m]) => add(t, m, 'data')); add('Развернуть сервисы вручную', 60, 'svc'); }
      if (S.site === 'cold') { add('Поднять инфраструктуру по коду (Terraform)', 30, 'inf'); B.restore.forEach(([t, m]) => add(t, m, 'data')); add('Развернуть сервисы', 20, 'svc'); }
      if (S.site === 'pilot') { add('Включить серверы', 15, 'inf'); add('Повысить реплику до главной', 5, 'data'); add('Выкатить и прогреть сервисы', 15, 'svc'); }
      if (S.site === 'warm') { add('Раздуть уменьшенную копию', 10, 'inf'); add('Повысить реплику до главной', 5, 'data'); }
      if (auto) add('Автоматически повысить реплику', 1, 'data');
      add(auto ? 'Трафик ушёл сам: проверки здоровья в DNS' : 'Переключить DNS и дождаться TTL', auto ? 2 : 10, 'dns');
      if (!auto) add('Проверить: тестовая запись, графики', S.site === 'warm' ? 5 : S.site === 'pilot' ? 10 : 15, 'chk');
      rpo = live ? 5 / 60 : B.last;
      notes.push(live ? 'Данные во второй регион шли непрерывно (асинхронная реплика): потеряны секунды.' : `Данные восстановлены из «${B.n.toLowerCase()}»: потеряно всё после ${B.sub.includes('16:00') ? '16:00' : B.sub.includes('03:00') ? '03:00' : 'последней минуты журнала'}.`);
    } else if (dis === 'drop') {
      add('Жалобы и алерт на ошибки записи', 10, 'det');
      add(S.drills ? 'Штаб по плану: останавливаем запись, решаем, до какой минуты откатываться' : 'Ищем, кто решает, и где план', decide, 'dec');
      B.restore.forEach(([t, m]) => add(t + ' рядом с рабочей', m, 'data'));
      add('Перенести таблицу обратно', 10, 'data');
      add('Проверить записи и открыть запись клиентов', 10, 'chk');
      rpo = B.last;
      if (live) notes.push('Реплика во втором регионе не спасла: удаление скопировалось туда за секунды. Реплика — не резервная копия.');
      notes.push(S.bk === 'pitr' ? 'Журнал позволил вернуться на 19:39 — за минуту до ошибки.' : `Вернуться можно только к моменту копии: ${B.sub}.`);
    } else {
      add('Алерт: база не отвечает, файлы зашифрованы', 10, 'det');
      add(S.drills ? 'Штаб по плану: отключить заражённое от сети' : 'Паника, поиск плана и ответственных', decide, 'dec');
      add('Изолировать заражённые серверы и сменить все ключи', 20, 'inf');
      if (!S.imm) { lost = Infinity; notes.push('Копии лежали в том же аккаунте — шифровальщик зашифровал и их. Реплика тоже: она повторяет каждую запись. Восстанавливать не из чего.'); }
      else {
        B.restore.forEach(([t, m]) => add(t + ' из неизменяемой копии', m, 'data'));
        add('Проверить, что копия чистая', 20, 'chk');
        add('Переключить трафик на чистую среду', 10, 'dns');
        rpo = B.last;
        notes.push('Неизменяемую копию (блокировка объектов в отдельном аккаунте) нельзя ни стереть, ни зашифровать до конца срока хранения.');
      }
    }
    const rto = lost === Infinity ? Infinity : steps.reduce((s, x) => s + x.m, 0);
    return { steps, rto, rpo: lost === Infinity ? Infinity : rpo, notes };
  }
  const costPct = S => BK[S.bk].pct + SITE[S.site].pct + (S.imm ? IMM_PCT : 0);
  const passes = (S, R, dis) => { const d = drill(S, dis); return d.rto <= R.rto && d.rpo <= R.rpo + 1e-9; };
  /* самая дешёвая стратегия, которая проходит все три учения */
  function cheapest(R) {
    let best = null;
    Object.keys(BK).forEach(bk => Object.keys(SITE).forEach(site => [false, true].forEach(imm => [false, true].forEach(drills => {
      const S = { bk, site, imm, drills };
      if (!['site', 'drop', 'ransom'].every(d => passes(S, R, d))) return;
      const c = costPct(S) + (drills ? 0.5 : 0);
      if (!best || c < best.c) best = { S, c };
    }))));
    return best;
  }

  /* ---------- 4. план восстановления ---------- */
  const TRIG = [
    { k: 'down', t: 'Основная площадка не отвечает дольше 5 минут по внешним проверкам', ok: true },
    { k: 'data', t: 'Данные испорчены: удаление, шифрование, массовые ошибки записи', ok: true },
    { k: 'one', t: 'Упал один сервер', ok: false, why: 'это не авария площадки — его заменит автоматика' },
    { k: 'chat', t: 'Один клиент пожаловался в чат', ok: false, why: 'сигнал проверить, но не повод переезжать в другой регион' }
  ];
  const ROLES = [
    { k: 'lead', t: 'Руководитель восстановления', d: 'принимает решения, ведёт хронологию, не делает руками' },
    { k: 'db', t: 'Инженер базы данных', d: 'поднимает и проверяет данные' },
    { k: 'plat', t: 'Инженер платформы', d: 'поднимает сервисы, переключает трафик' },
    { k: 'comms', t: 'Связь', d: 'франшизы, страница статуса, руководство' }
  ];
  const PEOPLE = [['', '— выбрать —'], ['anya', 'Аня, руководитель эксплуатации'], ['boris', 'Борис, администратор баз'], ['vika', 'Вика, инженер платформы'], ['gleb', 'Глеб, поддержка клиентов'], ['dina', 'Дина, системный аналитик']];
  const STEPS = [
    { k: 'declare', t: 'Объявить аварию и собрать штаб: роли, канал связи' },
    { k: 'freeze', t: 'Остановить запись на старой площадке, чтобы не было двух главных баз' },
    { k: 'data', t: 'Поднять данные на резервной площадке' },
    { k: 'verify', t: 'Проверить данные: последние записи на месте, счётчики сходятся' },
    { k: 'svc', t: 'Поднять сервисы и прогреть кэш' },
    { k: 'switch', t: 'Переключить трафик на резервную площадку' },
    { k: 'smoke', t: 'Проверить как пользователь: тестовая запись, графики' },
    { k: 'tell', t: 'Сообщить франшизам: работает, что потеряно и что дальше' }
  ];
  const BEFORE = [['declare', 'freeze', 'Сначала объявить аварию и собрать штаб — потом действовать.'], ['freeze', 'data', 'Сначала остановить запись на старой площадке: иначе две главные базы разойдутся.'], ['data', 'verify', 'Проверить можно только поднятые данные.'], ['data', 'svc', 'Сервисам нужна база: сначала данные.'], ['verify', 'switch', 'Трафик пускают на проверенные данные.'], ['svc', 'switch', 'Трафик — на уже поднятые сервисы.'], ['switch', 'smoke', 'Проверка «как пользователь» — после переключения.'], ['smoke', 'tell', '«Работает» сообщают, когда проверили.']];
  const MSG = [
    { k: 'what', t: 'что не работает и с какого времени', ok: true },
    { k: 'doing', t: 'что делаем и когда следующее обновление', ok: true },
    { k: 'loss', t: 'потеряны ли записи и за какой период — честно', ok: true },
    { k: 'blame', t: 'кто виноват', ok: false },
    { k: 'eta', t: 'точное время починки, даже если его нет', ok: false }
  ];
  const BACK = [
    { k: 'plan', t: 'Плановое окно ночью: синхронизировать данные обратно, проверить, переключить; резерв держать до конца проверки', ok: true },
    { k: 'now', t: 'Сразу, как основная площадка поднялась, переключить трафик обратно', ok: false, why: 'данные на ней устарели: всё, что записали на резерве, потеряется' },
    { k: 'never', t: 'Остаться на резервной навсегда', ok: false, why: 'можно, только если резерв полноценный, — и тогда сразу нужна новая резервная площадка' }
  ];

  /* ---------- состояние ---------- */
  let U = { tab: 'basics', save: 'day', spare: 'buy', S: { bk: 'nightly', site: 'none', imm: false, drills: false }, R: Object.assign({}, DEF_REQ), dis: 'site', ran: null,
    P: { trig: {}, roles: {}, order: [], first: '', msg: {}, every: '', back: '', drill: '' } };
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) U = Object.assign(U, s, { ran: null }); } catch (e) { /* без хранилища */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(Object.assign({}, U, { ran: null }))); } catch (e) { /* без хранилища */ } };
  const strict = R => R.rto <= DEF_REQ.rto && R.rpo <= DEF_REQ.rpo;

  const TABS = [['basics', '1', 'На пальцах'], ['kinds', '2', 'Копии и площадки'], ['drill', '3', 'Учение'], ['plan', '4', 'План восстановления']];
  const seg = (attr, list, cur, lab) => `<div class="seg dr-seg" role="group" aria-label="${esc(lab)}">${list.map(([v, t]) => `<button type="button" data-${attr}="${v}" aria-selected="${String(cur) === String(v)}">${esc(t)}</button>`).join('')}</div>`;
  const ana = (life, plain, term) => `<div class="dr-ana"><p class="dr-life"><span class="dr-tag">В жизни</span>${life}</p><p><span class="dr-tag">Проще</span>${plain}</p>${term ? `<p><span class="dr-tag t">Термин</span>${term}</p>` : ''}</div>`;

  /* полоса времени: от последней копии через аварию до восстановления */
  function line(rpo, rto, R, steps) {
    const W = 640, H = 96, x0 = 16, x1 = W - 16;
    const lostV = isFinite(rpo) ? rpo : null, rtoV = isFinite(rto) ? rto : null;
    const left = Math.max(R.rpo, lostV || 0, 1), right = Math.max(R.rto, rtoV || 0, 1);
    const crash = x0 + (x1 - x0) * (Math.sqrt(left) / (Math.sqrt(left) + Math.sqrt(right))), kL = (crash - x0) / left, kR = (x1 - crash) / right;
    let s = `<svg class="dr-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="Потеря данных ${esc(dur(rpo))}, простой ${esc(dur(rto))}"><line class="dr-ax" x1="${x0}" y1="44" x2="${x1}" y2="44"/>`;
    if (lostV != null) s += `<rect class="dr-lost" x="${(crash - lostV * kL).toFixed(1)}" y="34" width="${Math.max(2, lostV * kL).toFixed(1)}" height="20" rx="3"/>`;
    else s += `<rect class="dr-lost all" x="${x0}" y="34" width="${(crash - x0).toFixed(1)}" height="20" rx="3"/>`;
    if (rtoV != null) {
      let cx = crash;
      (steps || [{ m: rtoV, k: 'do' }]).forEach((st, i) => { const w = st.m * kR; s += `<rect class="dr-down k-${st.k}" style="animation-delay:${i * 0.18}s" x="${cx.toFixed(1)}" y="34" width="${Math.max(1, w).toFixed(1)}" height="20" rx="2"><title>${esc(st.t || '')}: ${esc(dur(st.m))}</title></rect>`; cx += w; });
    }
    const tx = (x, y, t, c, a) => `<text class="${c}" x="${x.toFixed(1)}" y="${y}"${a ? ` text-anchor="${a}"` : ''}>${esc(t)}</text>`;
    s += `<line class="dr-req" x1="${(crash - R.rpo * kL).toFixed(1)}" y1="26" x2="${(crash - R.rpo * kL).toFixed(1)}" y2="62"/><line class="dr-req" x1="${(crash + R.rto * kR).toFixed(1)}" y1="26" x2="${(crash + R.rto * kR).toFixed(1)}" y2="62"/>`;
    s += `<line class="dr-crash" x1="${crash.toFixed(1)}" y1="18" x2="${crash.toFixed(1)}" y2="70"/>` + tx(Math.min(x1 - 30, Math.max(x0 + 30, crash)), 13, 'авария 19:40', 'dr-tx b', 'middle');
    s += tx(x0, 84, '← потеряно', 'dr-tx', 'start') + tx(x1, 84, 'простой →', 'dr-tx', 'end');
    return s + `</svg><p class="dr-legend"><i class="lost"></i>потеряно данных: <b>${esc(dur(rpo))}</b> (можно ${esc(R.rpo ? dur(R.rpo) : 'ноль')}) <i class="down"></i>простой: <b>${esc(isFinite(rto) ? dur(rto) : 'не поднялись')}</b> (можно ${esc(dur(R.rto))}) <i class="req"></i>требования</p>`;
  }

  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'dr', title: 'Учение по восстановлению', lede: 'RTO и RPO, копии, резервные площадки и план',
    intro: 'Авария целой площадки случается редко, но обходится дороже всего. Здесь на пальцах — сколько можно простоять (RTO) и сколько данных можно потерять (RPO), какие бывают копии и резервные площадки и сколько они стоят. Потом учение: площадка пропала, таблицу удалили, пришёл шифровальщик — выбираешь стратегию и видишь, за сколько поднялся и что потерял. В конце — план восстановления как документ аналитика.',
    tasks: [
      { id: 'basics', text: 'На пальцах: подбери сохранение и запасной ноутбук так, чтобы диплом уложился в RPO и RTO' },
      { id: 'site', text: 'Учение «Пропала площадка»: уложись в RTO 2 ч и RPO 5 мин (или строже)' },
      { id: 'drop', text: 'Учение «Удалили таблицу»: пойми, почему реплика не спасает, и уложись в требования' },
      { id: 'ransom', text: 'Учение «Шифровальщик»: сохрани данные и уложись в требования' },
      { id: 'cheap', text: 'Найди самую дешёвую стратегию, которая проходит все три учения' },
      { id: 'plan', text: 'Собери план восстановления: когда объявляем, роли, порядок шагов, связь и возврат обратно' }
    ],
    mount(el, api) {
      const V = {};
      V.basics = () => {
        const sv = SAVE.find(x => x.k === U.save), sp = SPARE.find(x => x.k === U.spare);
        const rpo = sv.last, rto = sp.t, okP = rpo <= DIP.rpo, okT = rto <= DIP.rto;
        if (okP && okT) api.done('basics');
        let h = ana('Пишешь диплом. В 15:47 ноутбук упал со стола и больше не включается.', 'Два вопроса: <b>сколько текста пропало</b> с последнего сохранения и <b>через сколько ты снова пишешь</b>. Научрук требует: потерять не больше 30 минут работы и вернуться к тексту не позже чем через час.', '<b>RPO</b> (Recovery Point Objective) — сколько данных можно потерять, считая назад от аварии. <b>RTO</b> (Recovery Time Objective) — сколько можно простоять до восстановления. Оба — требования бизнеса, а не свойства техники.');
        h += `<div class="dr-two"><div class="dr-box"><b class="dr-h">Как сохраняешь</b>${seg('drsave', SAVE.map(x => [x.k, x.n]), U.save, 'Как сохраняешь')}<b class="dr-h">Чем продолжишь</b>${seg('drspare', SPARE.map(x => [x.k, x.n]), U.spare, 'Чем продолжишь')}</div>`;
        h += `<div class="dr-box"><div class="dr-kpis"><div class="dr-kpi ${okP ? 'ok' : 'bad'}"><span>Потерял текста (RPO)</span><b>${dur(rpo)}</b><small>можно ${dur(DIP.rpo)}</small></div><div class="dr-kpi ${okT ? 'ok' : 'bad'}"><span>Снова пишешь через (RTO)</span><b>${dur(rto)}</b><small>можно ${dur(DIP.rto)}</small></div><div class="dr-kpi"><span>Цена</span><b>${sv.cost + sp.cost ? (sv.cost + sp.cost).toLocaleString('ru-RU') + ' ₽' : '0 ₽'}</b><small>${sp.cost ? 'второй ноутбук пылится ради одного дня' : 'почти даром'}</small></div></div>`;
        h += `<p class="dr-p">${okP && okT ? `Уложился. ${sp.k === 'twin' ? 'Но второй ноутбук за 60 000 ₽ — перебор: соседский с облаком дал бы те же 15 минут бесплатно.' : 'Дешевле не бывает: требования выполнены почти даром.'}` : !okP ? 'Слишком много текста пропало: сохраняйся чаще или пиши сразу в облаке.' : 'Слишком долго без работы: нужен запасной ноутбук, на котором можно сразу открыть файл.'}</p></div></div>`;
        h += `<div class="dr-card info"><b>Перенос на систему.</b> Сохранение — это резервные копии и журнал изменений: от них зависит <b>RPO</b>. Запасной ноутбук — резервная площадка: от неё зависит <b>RTO</b>. Чем меньше оба числа, тем дороже: «ноль и ноль» стоит как вторая система целиком.</div>`;
        return h;
      };
      V.kinds = () => {
        const ok = '<span class="dr-chip ok">спасает</span>', no = '<span class="dr-chip bad">не спасает</span>', mid = '<span class="dr-chip warn">если копию нельзя стереть</span>';
        let h = ana('Копия диплома на флешке в ящике стола и копия у друга в другом городе — разные вещи: пожар в квартире заберёт и ноутбук, и флешку.', 'Копии отвечают на вопрос «что потеряем», резервная площадка — «где и как быстро продолжим». От разных бед спасают разные копии.', '<b>Резервная копия</b> (backup) — снимок данных на момент времени. <b>Реплика</b> — живая копия, которая повторяет каждое изменение, в том числе ошибочное. <b>PITR</b> — восстановление на любую минуту из снимка и журнала изменений.');
        h += `<div class="tbl"><table class="kind-table dr-tbl"><thead><tr><th>Копия</th><th>Потеряем (RPO)</th><th>Пропала площадка</th><th>Удалили таблицу</th><th>Шифровальщик</th><th>Цена</th></tr></thead><tbody>`;
        h += `<tr><th>Ночная полная копия<small>раз в сутки, в другой регион</small></th><td>до 24 ч</td><td>${ok}</td><td>${ok}<small>откат к ночи</small></td><td>${mid}</td><td>+2 %</td></tr>`;
        h += `<tr><th>Снимки диска каждые 4 часа</th><td>до 4 ч</td><td>${ok}</td><td>${ok}</td><td>${mid}</td><td>+4 %</td></tr>`;
        h += `<tr><th>Снимки + журнал (PITR)<small>журнал уходит каждую минуту</small></th><td>≈ 1 мин</td><td>${ok}</td><td>${ok}<small>на минуту до ошибки</small></td><td>${mid}</td><td>+7 %</td></tr>`;
        h += `<tr><th>Реплика в другом регионе</th><td>секунды</td><td>${ok}</td><td>${no}<small>удаление копируется сразу</small></td><td>${no}<small>шифрование — тоже</small></td><td>как вторая база</td></tr>`;
        h += `<tr><th>Неизменяемая копия<small>блокировка объектов, отдельный аккаунт</small></th><td>как у копии</td><td>—</td><td>—</td><td>${ok}</td><td>+2 %</td></tr></tbody></table></div>`;
        h += `<b class="dr-h">Резервные площадки</b><div class="dr-sites">`;
        Object.entries(SITE).filter(([k]) => k !== 'none').forEach(([k, s]) => { h += `<div class="dr-site"><b>${esc(s.n)}</b><p class="dr-life">${esc(s.an)}.</p><small>${esc(s.sub)}</small><div class="dr-meter"><i style="width:${Math.min(100, s.pct)}%"></i></div><span>поднимаемся за ${esc(s.rto)} · +${s.pct} % к счёту</span></div>`; });
        h += `</div><div class="dr-card"><b>Правило 3-2-1.</b> Три копии данных, на двух разных носителях, одна — в другом месте. Сегодня добавляют ещё «1 неизменяемая» и «0 ошибок при проверке восстановления»: копия, из которой ни разу не восстанавливались, — это надежда, а не копия.</div>`;
        return h;
      };
      V.drill = () => {
        const S = U.S, R = U.R, d = drill(S, U.dis), okT = d.rto <= R.rto, okP = d.rpo <= R.rpo + 1e-9, pct = costPct(S);
        let h = `<div class="dr-ana"><p><span class="dr-tag">Кейс</span>Платформа записи на тренировки для сети фитнес-клубов. Вечер — пик записи. Бизнес говорит: «Записи клиентов терять нельзя — не больше 5 минут. Простоять можем час-два, дольше — клубы начнут записывать на бумаге». Счёт за облако — ${usd(BASE_BILL)} в месяц (допущение).</p></div>`;
        h += `<div class="dr-two"><div class="dr-box"><b class="dr-h">Требования</b><small class="dr-sub">Сколько можно простоять (RTO)</small>${seg('drrto', REQ_RTO, R.rto, 'RTO')}<small class="dr-sub">Сколько данных можно потерять (RPO)</small>${seg('drrpo', REQ_RPO, R.rpo, 'RPO')}<button type="button" class="linkish" data-drnfr>Взять из «От требований к архитектуре»</button>`;
        h += `<b class="dr-h">Стратегия</b><small class="dr-sub">Копии</small>${seg('drbk', Object.entries(BK).map(([k, b]) => [k, b.n]), S.bk, 'Копии')}<small class="dr-sub">Резервная площадка в другом регионе</small>${seg('drsite', Object.entries(SITE).map(([k, s]) => [k, s.n]), S.site, 'Резервная площадка')}`;
        h += `<label class="switch"><input type="checkbox" data-drimm ${S.imm ? 'checked' : ''}><span><b>Неизменяемая копия</b><small>копии в отдельном аккаунте с блокировкой удаления на 30 дней · +${IMM_PCT} %</small></span></label>`;
        h += `<label class="switch"><input type="checkbox" data-drdrills ${S.drills ? 'checked' : ''}><span><b>Учения проводились</b><small>раз в квартал команда восстанавливается по плану: все знают роли и шаги</small></span></label></div>`;
        h += `<div class="dr-box"><b class="dr-h">Что случилось</b>${seg('drdis', Object.entries(DIS).map(([k, x]) => [k, x.n]), U.dis, 'Сценарий')}<p class="dr-p">${esc(DIS[U.dis].an)}.</p><button type="button" class="btn primary" data-drrun>Начать учение</button>`;
        if (U.ran === U.dis) {
          h += `<div class="dr-kpis"><div class="dr-kpi ${okT ? 'ok' : 'bad'}"><span>Простой (RTO)</span><b>${isFinite(d.rto) ? dur(d.rto) : 'не поднялись'}</b><small>можно ${dur(R.rto)}</small></div><div class="dr-kpi ${okP ? 'ok' : 'bad'}"><span>Потеря данных (RPO)</span><b>${isFinite(d.rpo) ? dur(d.rpo) : 'всё'}</b><small>можно ${R.rpo ? dur(R.rpo) : 'ноль'}</small></div><div class="dr-kpi"><span>Цена в месяц</span><b>+${pct} %</b><small>≈ ${usd(BASE_BILL * pct / 100)}${S.drills ? ' и 2 дня команды в квартал' : ''}</small></div></div>`;
          h += line(d.rpo, d.rto, R, d.steps);
          h += `<ol class="dr-steps">${d.steps.map(st => `<li class="k-${st.k}"><span>${esc(st.t)}</span><b>${dur(st.m)}</b></li>`).join('')}</ol>`;
          h += `<div class="dr-card ${okT && okP ? 'ok' : 'bad'}"><b>${okT && okP ? 'Уложились в требования.' : 'Не уложились.'}</b> ${d.notes.map(esc).join(' ')}${!okT && isFinite(d.rto) ? ` Простой ${dur(d.rto)} при допустимых ${dur(R.rto)}${!S.drills ? ': почти час ушёл на поиск плана и ответственных — учения сокращают это до 10 минут' : ''}.` : ''}${R.rpo === 0 && U.dis === 'site' ? ' Ноль потерь при аварии региона даёт только синхронная репликация: каждая запись ждёт подтверждения второго региона — см. лабораторию «Регионы и сеть».' : ''}</div>`;
          if (okT && okP && strict(R)) api.done(U.dis);
          const best = cheapest(R);
          if (best && ['site', 'drop', 'ransom'].every(x => passes(S, R, x)) && costPct(S) <= costPct(best.S) && (!best.S.drills || S.drills) && strict(R)) { api.done('cheap'); h += `<div class="dr-card ok"><b>Это самая дешёвая стратегия, которая проходит все три учения</b> при этих требованиях: +${pct} % к счёту.</div>`; }
          else if (['site', 'drop', 'ransom'].every(x => passes(S, R, x))) h += `<div class="dr-card info">Все три учения пройдены. ${best ? `Есть дешевле: попробуй уменьшить площадку или копии — минимум +${costPct(best.S)} %.` : ''}</div>`;
          if (!best) h += '<div class="dr-card warn">При таких требованиях ни одна стратегия не проходит все три учения: поднять базу 2 ТБ из копии — это уже около часа. Так строже уже не копии, а архитектура: базы поменьше (ячейки), отложенная реплика, восстановление одной таблицы.</div>';
        } else h += `<p class="dr-p dr-muted">Выбери стратегию и нажми «Начать учение». Часы пойдут с 19:40.</p>`;
        return h + '</div></div>';
      };
      V.plan = () => {
        const P = U.P, d = drill(U.S, 'site');
        const trigOk = TRIG.every(x => !!P.trig[x.k] === x.ok);
        const used = ROLES.map(r => P.roles[r.k]).filter(Boolean), rolesOk = used.length === ROLES.length && P.roles.lead && ![P.roles.db, P.roles.plat].includes(P.roles.lead);
        const pos = k => P.order.indexOf(k), bad = P.order.length === STEPS.length ? BEFORE.find(([a, b]) => pos(a) > pos(b)) : null, orderOk = P.order.length === STEPS.length && !bad;
        const msgOk = MSG.every(x => !!P.msg[x.k] === x.ok) && P.first === '15' && (P.every === '15' || P.every === '30');
        const backOk = P.back === 'plan', drillOk = P.drill === 'q';
        const all = trigOk && rolesOk && orderOk && msgOk && backOk && drillOk;
        if (all) api.done('plan');
        const st = ok => `<span class="dr-chip ${ok ? 'ok' : 'warn'}">${ok ? 'готово' : 'не готово'}</span>`;
        let h = ana('План эвакуации на стене офиса: куда идти, кто отвечает за этаж, где собираемся. Его пишут заранее и проверяют учебной тревогой — во время пожара читать инструкцию поздно.', 'План восстановления — документ, по которому команда действует в аварию без споров: когда объявляем, кто что делает, в каком порядке, кому и что сообщаем, как возвращаемся обратно.', '<b>DRP</b> (Disaster Recovery Plan) — план аварийного восстановления. <b>Runbook</b> — пошаговая инструкция внутри него. <b>Failback</b> — возврат на основную площадку.');
        h += `<div class="dr-two"><div class="dr-box">`;
        h += `<b class="dr-h">1. Когда объявляем аварию ${st(trigOk)}</b>${TRIG.map(x => `<label class="switch"><input type="checkbox" data-drtrig="${x.k}" ${P.trig[x.k] ? 'checked' : ''}><span><b>${esc(x.t)}</b>${P.trig[x.k] && !x.ok ? `<small class="bad">${esc(x.why)}</small>` : ''}</span></label>`).join('')}`;
        h += `<b class="dr-h">2. Роли ${st(rolesOk)}</b>${ROLES.map(r => `<div class="dr-role"><span><b>${esc(r.t)}</b><small>${esc(r.d)}</small></span><select data-drrole="${r.k}" aria-label="${esc(r.t)}">${PEOPLE.map(([v, t]) => `<option value="${v}" ${P.roles[r.k] === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`).join('')}${used.length === ROLES.length && !rolesOk ? '<small class="dr-warn">Руководитель не должен сам чинить базу или сервисы: кто-то должен видеть картину целиком.</small>' : ''}`;
        h += `<b class="dr-h">3. Порядок шагов ${st(orderOk)}</b><small class="dr-sub">Нажимай шаги по порядку — они встанут в план. Нажатие на шаг в плане убирает его.</small><ol class="dr-order">${P.order.map(k => `<li><button type="button" class="dr-stp on" data-drun="${k}">${esc(STEPS.find(s => s.k === k).t)}</button></li>`).join('')}</ol><div class="dr-pool">${STEPS.filter(s => !P.order.includes(s.k)).map(s => `<button type="button" class="dr-stp" data-drstep="${s.k}">${esc(s.t)}</button>`).join('')}</div>${bad ? `<small class="dr-warn">${esc(bad[2])}</small>` : ''}`;
        h += `<b class="dr-h">4. Связь ${st(msgOk)}</b><small class="dr-sub">Первое сообщение франшизам и на страницу статуса</small>${seg('drfirst', [['15', 'в течение 15 минут'], ['60', 'через час'], ['end', 'когда починим']], P.first, 'Первое сообщение')}<small class="dr-sub">Что пишем</small>${MSG.map(x => `<label class="switch"><input type="checkbox" data-drmsg="${x.k}" ${P.msg[x.k] ? 'checked' : ''}><span><b>${esc(x.t)}</b></span></label>`).join('')}<small class="dr-sub">Обновления</small>${seg('drevery', [['15', 'каждые 15 минут'], ['30', 'каждые 30 минут'], ['none', 'только в конце']], P.every, 'Обновления')}`;
        h += `<b class="dr-h">5. Возврат обратно ${st(backOk)}</b>${BACK.map(x => `<label class="dr-radio"><input type="radio" name="drback" value="${x.k}" data-drback ${P.back === x.k ? 'checked' : ''}><span>${esc(x.t)}${P.back === x.k && !x.ok ? `<small class="bad">${esc(x.why)}</small>` : ''}</span></label>`).join('')}`;
        h += `<b class="dr-h">6. Учения ${st(drillOk)}</b>${seg('drdrill', [['y', 'раз в год'], ['q', 'раз в квартал'], ['n', 'когда будет время']], P.drill, 'Учения')}</div>`;
        const who = k => (PEOPLE.find(p => p[0] === P.roles[k]) || ['', '—'])[1];
        const doc = [
          'План восстановления платформы записи',
          `Цели: простой не больше ${dur(U.R.rto)}, потеря данных не больше ${U.R.rpo ? dur(U.R.rpo) : 'нуля'}. Стратегия: ${BK[U.S.bk].n.toLowerCase()}, резервная площадка — ${SITE[U.S.site].n.toLowerCase()}${U.S.imm ? ', неизменяемая копия' : ''}. На учении «площадка пропала»: простой ${dur(d.rto)}, потеря ${dur(d.rpo)}.`,
          'Когда объявляем аварию: ' + (TRIG.filter(x => P.trig[x.k]).map(x => x.t.toLowerCase()).join('; ') || '—') + '.',
          'Роли: ' + ROLES.map(r => `${r.t.toLowerCase()} — ${who(r.k)}`).join('; ') + '.',
          'Шаги: ' + (P.order.map((k, i) => `${i + 1}) ${STEPS.find(s => s.k === k).t.toLowerCase()}`).join('; ') || '—') + '.',
          `Связь: первое сообщение ${{ 15: 'в течение 15 минут', 60: 'через час', end: 'после починки' }[P.first] || '—'}; пишем: ${MSG.filter(x => P.msg[x.k]).map(x => x.t).join(', ') || '—'}; обновления ${{ 15: 'каждые 15 минут', 30: 'каждые 30 минут', none: 'только в конце' }[P.every] || '—'}.`,
          'Возврат обратно: ' + ((BACK.find(x => x.k === P.back) || {}).t || '—').toLowerCase() + '.',
          'Учения: ' + ({ y: 'раз в год', q: 'раз в квартал', n: 'не запланированы' }[P.drill] || '—') + '.'
        ];
        h += `<div class="dr-box dr-doc"><b class="dr-h">Документ ${all ? '<span class="dr-chip ok">готов</span>' : ''}</b><article>${doc.map((p, i) => i ? `<p>${esc(p)}</p>` : `<h4>${esc(p)}</h4>`).join('')}</article><button type="button" class="btn" data-drcopy>Скопировать текстом</button><small class="dr-sub" id="drCopied"></small></div></div>`;
        V._doc = doc.join('\n\n');
        return h;
      };
      const draw = () => {
        el.innerHTML = `<div class="dr"><div class="dr-tabs" role="tablist" aria-label="Разделы лаборатории">${TABS.map(([k, n, t]) => `<button type="button" role="tab" data-drtab="${k}" aria-selected="${U.tab === k}"><b>${n}</b>${t}</button>`).join('')}</div><div class="dr-view${isCalm() ? ' calm' : ''}">${V[U.tab]()}</div></div>`;
      };
      const onClick = e => {
        const t = e.target.closest('button,input,select'); if (!t || !el.contains(t)) return;
        const d = t.dataset, P = U.P;
        if (d.drtab) { U.tab = d.drtab; }
        else if (d.drsave) U.save = d.drsave;
        else if (d.drspare) U.spare = d.drspare;
        else if (d.drrto) { U.R.rto = +d.drrto; U.ran = null; }
        else if (d.drrpo) { U.R.rpo = +d.drrpo; U.ran = null; }
        else if (d.drbk) { U.S.bk = d.drbk; U.ran = null; }
        else if (d.drsite) { U.S.site = d.drsite; U.ran = null; }
        else if (d.drdis) { U.dis = d.drdis; U.ran = null; }
        else if (t.hasAttribute('data-drimm')) { U.S.imm = t.checked; U.ran = null; }
        else if (t.hasAttribute('data-drdrills')) { U.S.drills = t.checked; U.ran = null; }
        else if (t.hasAttribute('data-drrun')) U.ran = U.dis;
        else if (t.hasAttribute('data-drnfr')) {
          let N = {}; try { N = JSON.parse(localStorage.getItem('amp-stroyka-nfr-v1') || '{}'); } catch (err) { N = {}; }
          U.R.rto = { hours: 240, minutes: 15, seconds: 15 }[N.rto] || DEF_REQ.rto; U.R.rpo = { hours: 60, minutes: 5, zero: 0 }[N.rpo] || DEF_REQ.rpo; U.ran = null;
        }
        else if (d.drtrig) P.trig[d.drtrig] = t.checked;
        else if (d.drmsg) P.msg[d.drmsg] = t.checked;
        else if (d.drstep) { if (!P.order.includes(d.drstep)) P.order.push(d.drstep); }
        else if (d.drun) P.order = P.order.filter(k => k !== d.drun);
        else if (d.drfirst) P.first = d.drfirst;
        else if (d.drevery) P.every = d.drevery;
        else if (t.hasAttribute('data-drback')) P.back = t.value;
        else if (d.drdrill) P.drill = d.drdrill;
        else if (t.hasAttribute('data-drcopy')) {
          const txt = V._doc || '', note = m => { const c = el.querySelector('#drCopied'); if (c) c.textContent = m; };
          try { navigator.clipboard.writeText(txt).then(() => note('Скопировано.'), () => note('Не удалось скопировать — выдели текст документа вручную.')); } catch (err) { note('Не удалось скопировать — выдели текст документа вручную.'); }
          return;
        }
        else if (t.tagName === 'SELECT') return;
        else return;
        save(); draw();
      };
      const onChange = e => { const t = e.target; if (t.tagName === 'SELECT' && t.dataset.drrole) { U.P.roles[t.dataset.drrole] = t.value; save(); draw(); } };
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      draw();
      return () => { el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
    }
  });
  SD.drLab = { drill, cheapest, costPct, BK, SITE };
})();
