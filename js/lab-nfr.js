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
        h += `<p class="nf-sum">Проверяемых на схеме: ${okN} из ${checked} выполнено.</p></div></div>`;
        el.innerHTML = h;
        if (checked && okN === checked) api.done('green');
      };
      el.addEventListener('click', e => {
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
