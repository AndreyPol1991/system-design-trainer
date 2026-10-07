/* Лаборатория, часть 1: каркас, оценка на салфетке, цифры задержек, consistent hashing, кворумы. */
(function () {
  const KEY = 'amp-stroyka-labs-v1';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const S = { done: {} };
  const load = () => { try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища */ } };
  SD.LABS = SD.LABS || [];
  let cur = null, cleanup = null, root = null;

  /* ---------- каркас ---------- */
  function mount() {
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'labModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="labTitle" style="height: min(880px, calc(100vh - 32px));">
      <div class="sheet-head"><span class="eyebrow" style="margin:0">Лаборатория</span><h2 id="labTitle">…</h2><button class="btn ghost x" type="button" data-close>Закрыть</button></div>
      <div class="lab-wrap"><nav class="lab-list" id="labList" aria-label="Лаборатории"></nav><section class="lab-main" id="labMain"></section></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) { close(); return; }
      const b = e.target.closest('[data-lab]'); if (b) open(b.dataset.lab);
    });
  }
  function close() { if (cleanup) cleanup(); cleanup = null; document.getElementById('labModal').hidden = true; }
  function list() {
    document.getElementById('labList').innerHTML = SD.LABS.map(l => {
      const d = (S.done[l.id] || []).length, t = l.tasks.length;
      return `<button type="button" class="lab-item ${cur === l.id ? 'on' : ''}" data-lab="${l.id}"><b>${esc(l.title)}</b><small>${esc(l.lede)}</small><span class="lab-prog">${d}/${t}${d === t ? ' ✓' : ''}</span></button>`;
    }).join('');
  }
  /* лаборатории по требованию: в SD.LABS сначала лежит запись-оглавление с полем lazy (js/labs-lazy.js);
     при первом открытии грузим файл, и настоящая лаборатория встаёт на место записи */
  const files = {};
  function need(lab) {
    const src = lab.lazy;
    if (!files[src]) files[src] = new Promise(res => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => {
        SD.LABS.filter(l => l.lazy === src).forEach(stub => {
          const real = SD.LABS.find(x => x.id === stub.id && !x.lazy); if (!real) return;
          SD.LABS.splice(SD.LABS.indexOf(real), 1);
          SD.LABS[SD.LABS.indexOf(stub)] = real;
          const a = stub.tasks.map(t => t.id).join(), b = real.tasks.map(t => t.id).join();
          if (a !== b && window.console) console.warn('labs-lazy.js устарел для «' + real.id + '»: обнови задания в оглавлении');
        });
        res();
      };
      s.onerror = () => { delete files[src]; res(); };
      document.head.appendChild(s);
    });
    return files[src];
  }
  /* лабораторию уже открывали — «На пальцах» сворачиваем, чтобы сама лаборатория была на первом экране */
  const SEEN = 'amp-stroyka-lab-seen-v1';
  const seenLab = id => { let s = {}; try { s = JSON.parse(localStorage.getItem(SEEN) || '{}') || {}; } catch (e) { s = {}; } const was = !!s[id] || !!(S.done[id] && S.done[id].length); if (!s[id]) { s[id] = 1; try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch (e) { /* без хранилища */ } } return was; };
  function open(id) {
    const want = SD.LABS.find(l => l.id === id) || SD.LABS[0];
    if (want.lazy) {
      document.documentElement.classList.add('xr-loading');
      return need(want).then(() => {
        document.documentElement.classList.remove('xr-loading');
        const now = SD.LABS.find(l => l.id === want.id);
        if (now && !now.lazy) return open(want.id);
        if (SD.app && SD.app.toast) SD.app.toast('Лаборатория не загрузилась — проверь интернет и попробуй ещё раз.');
      });
    }
    load();
    const lab = want;
    if (cleanup) cleanup();
    cur = lab.id;
    document.getElementById('labModal').hidden = false;
    document.getElementById('labTitle').textContent = lab.title;
    list();
    root = document.getElementById('labMain');
    root.innerHTML = `<div class="lab-head"><p>${esc(lab.intro)}</p><ul class="lab-tasks" id="labTasks"></ul></div><div class="lab-body" id="labBody"></div>${lab.dive && SD.DIVES[lab.dive] ? `<div class="row-btns"><button type="button" class="btn ghost" id="labDive">Пошаговый разбор: ${esc(SD.DIVES[lab.dive].title)}</button></div>` : ''}`;
    renderTasks(lab);
    /* «На пальцах» сверху лаборатории: тезис, аналогия и картинка (SD.LAB_FINGERS[id], рисует js/level-fingers.js) */
    const LF = SD.LAB_FINGERS && SD.LAB_FINGERS[lab.id];
    if (LF && SD.fingers && SD.fingers.card) { const hd = root.querySelector('.lab-head'); if (hd) hd.insertAdjacentHTML('afterbegin', SD.fingers.card({ id: 'lab-' + lab.id, title: lab.title, fingers: LF }, { closed: seenLab(lab.id) })); }
    if (SD.incidents && SD.incidents.labCard) { const hd = root.querySelector('.lab-head'); if (hd) hd.insertAdjacentHTML('beforeend', SD.incidents.labCard(lab.id)); }
    const dv = document.getElementById('labDive'); if (dv) dv.onclick = () => SD.player.open(lab.dive);
    cleanup = lab.mount(document.getElementById('labBody'), { done: tid => done(lab, tid) }) || null;
    return Promise.resolve();
  }
  function renderTasks(lab) {
    const d = S.done[lab.id] || [];
    document.getElementById('labTasks').innerHTML = lab.tasks.map(t => `<li class="${d.includes(t.id) ? 'ok' : ''}"><span class="st">${d.includes(t.id) ? '✓' : '·'}</span>${esc(t.text)}</li>`).join('');
  }
  function done(lab, tid) {
    S.done[lab.id] = S.done[lab.id] || [];
    if (S.done[lab.id].includes(tid)) return;
    S.done[lab.id].push(tid); save(); renderTasks(lab); list();
    if (SD.bridge && lab.tasks.every(x => S.done[lab.id].includes(x.id))) SD.bridge.labDone(lab.id);
    const t = lab.tasks.find(x => x.id === tid);
    if (SD.app && t) SD.app.toast(`Задание выполнено: ${t.text}`);
  }
  SD.labs = { mount, open, need, progress: () => { load(); return S.done; } };

  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  SD.labHash = fnv;
  const fmtN = v => SD.fmt.num(v);

  /* ---------- 1. Оценка на салфетке ---------- */
  const PRODUCTS = [
    { name: 'мессенджер', dau: [20e6, 80e6], act: [40, 120], w: 0.5, size: [300, 1200], what: 'сообщений' },
    { name: 'лента соцсети', dau: [10e6, 50e6], act: [30, 80], w: 0.05, size: [500, 2000], what: 'просмотров и постов' },
    { name: 'сокращатель ссылок', dau: [2e6, 20e6], act: [5, 20], w: 0.02, size: [200, 600], what: 'переходов и ссылок' },
    { name: 'интернет-магазин', dau: [1e6, 10e6], act: [20, 60], w: 0.03, size: [1000, 4000], what: 'действий' },
    { name: 'такси', dau: [1e6, 5e6], act: [200, 600], w: 0.9, size: [100, 200], what: 'обновлений координат' },
    { name: 'платёжный сервис', dau: [3e6, 15e6], act: [3, 10], w: 0.4, size: [800, 2000], what: 'операций' }
  ];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const round2 = v => { const p = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
  function newTask() {
    const p = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
    const dau = round2(rnd(...p.dau)), act = Math.round(rnd(...p.act)), size = Math.round(rnd(...p.size) / 100) * 100, years = [1, 3, 5][Math.floor(Math.random() * 3)];
    const avg = dau * act / 86400, peak = avg * 3, wps = peak * p.w;
    const day = dau * act * p.w * size / 1e9, total = day * 365 * years / 1000, servers = Math.ceil(peak / 2500 * 1.3);
    return { p, dau, act, size, years, ans: { avg, peak, wps, day, total, servers } };
  }
  const Q = [
    { k: 'avg', l: 'Средний RPS', u: 'запросов/с', idea: 'Сколько всего действий за сутки — и раздели на секунды в сутках. Как посчитать, сколько людей в среднем проходит через турникет в секунду, зная, сколько прошло за день.' },
    { k: 'peak', l: 'Пиковый RPS (пик ×3)', u: 'запросов/с', idea: 'Люди приходят неравномерно: вечером втрое больше, чем в среднем. Систему строят под пик.' },
    { k: 'wps', l: 'Записей в секунду в пике', u: 'записей/с', idea: 'Не каждое действие что-то записывает: возьми долю записей от пиковой нагрузки. Это нагрузка на primary базы.' },
    { k: 'day', l: 'Новых данных в сутки', u: 'ГБ', idea: 'Сколько записей за сутки × сколько весит одна запись. Потом байты перевести в гигабайты.' },
    { k: 'total', l: 'Данных за весь срок', u: 'ТБ', idea: 'Сутки × 365 × число лет хранения. Потом гигабайты — в терабайты.' },
    { k: 'servers', l: 'Серверов приложения (2 500 RPS, запас 30 %)', u: 'шт.', idea: 'Пиковую нагрузку делим на то, сколько тянет один сервер, добавляем запас и округляем вверх.' }
  ];
  /* числа словами — как пишут на салфетке */
  const W = v => { const a = Math.abs(v); const t = (x, d) => (Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).toString().replace('.', ','); return a >= 1e9 ? t(v / 1e9, 2) + ' млрд' : a >= 1e6 ? t(v / 1e6, 2) + ' млн' : a >= 1e4 ? Math.round(v).toLocaleString('ru-RU') : a >= 100 ? Math.round(v).toLocaleString('ru-RU') : t(v, a >= 10 ? 1 : 2); };
  /* разбор каждого вопроса на шаги: формула с числами, ожидаемый результат, приём счёта */
  function stepsOf(T, k) {
    const A = T.ans, pd = T.dau * T.act, wd = pd * T.p.w, w = Math.round(T.p.w * 100);
    const S = {
      avg: [
        { l: 'Действий за сутки', f: `${W(T.dau)} × ${T.act}`, v: pd, u: 'в сутки', tip: `Перемножь отдельно «значащие» числа и нули: ${W(T.dau)} × ${T.act}. Миллион — 6 нулей, миллиард — 9.` },
        { l: 'Раздели на секунды в сутках', f: `${'{0}'} ÷ 86 400`, v: A.avg, u: 'запросов/с', tip: 'На салфетке делят на 100 000 (это 10⁵ — просто убрать 5 нулей), ответ потом чуть увеличивают: точное число на ≈ 15 % больше.' }
      ],
      peak: [{ l: 'Пик в 3 раза выше среднего', f: `${W(A.avg)} × 3`, v: A.peak, u: 'запросов/с', tip: 'Средний RPS — из прошлого вопроса. Пиковый коэффициент 2–5, здесь договорились о ×3.' }],
      wps: [{ l: 'Доля записей от пика', f: `${W(A.peak)} × ${w} %`, v: A.wps, u: 'записей/с', tip: `${w} % — это × ${(T.p.w).toString().replace('.', ',')}. Например, 10 % от 30 000 — это 3 000.` }],
      day: [
        { l: 'Записей за сутки', f: `${W(pd)} × ${w} %`, v: wd, u: 'записей', tip: 'Действий за сутки (из первого вопроса) × доля записей.' },
        { l: 'Байт за сутки', f: `${'{0}'} × ${T.size} байт`, v: wd * T.size, u: 'байт', tip: `Умножь на вес одной записи: ${T.size} байт ≈ ${(T.size / 1000).toString().replace('.', ',')} КБ.` },
        { l: 'В гигабайтах', f: `${'{1}'} ÷ 10⁹`, v: A.day, u: 'ГБ', tip: '1 ГБ = 1 000 000 000 байт (10⁹): убери 9 нулей.' }
      ],
      total: [
        { l: 'За год', f: `${W(A.day)} ГБ × 365`, v: A.day * 365, u: 'ГБ', tip: 'На салфетке 365 ≈ 400 или ≈ 1/3 тысячи × 1 000 — порядок не изменится.' },
        { l: `За ${T.years} ${T.years === 1 ? 'год' : T.years < 5 ? 'года' : 'лет'}`, f: `${'{0}'} × ${T.years}`, v: A.day * 365 * T.years, u: 'ГБ', tip: 'Умножь на срок хранения из легенды.' },
        { l: 'В терабайтах', f: `${'{1}'} ÷ 1 000`, v: A.total, u: 'ТБ', tip: '1 ТБ = 1 000 ГБ.' }
      ],
      servers: [
        { l: 'Серверов на пределе', f: `${W(A.peak)} ÷ 2 500`, v: A.peak / 2500, u: 'шт.', tip: 'Один сервер приложения тянет ≈ 2 500 запросов в секунду. Пик — из второго вопроса.' },
        { l: 'С запасом 30 %', f: `${'{0}'} × 1,3`, v: A.peak / 2500 * 1.3, u: 'шт.', tip: 'Запас нужен, чтобы под пиком не расти в очередь и пережить падение одного сервера.' },
        { l: 'Округли вверх', f: `${'{1}'} → целое`, v: A.servers, u: 'шт.', tip: 'Полсервера не бывает: 4,2 → 5.' }
      ]
    };
    return S[k];
  }
  const gradeOf = (v, a) => { const r = v > 0 && a > 0 ? Math.abs(Math.log10(v / a)) : 9; return r <= Math.log10(1.5) ? 'exact' : r <= Math.log10(3) ? 'order' : 'miss'; };
  const GR = { exact: '✓ точно', order: '≈ порядок верный', miss: '✗ мимо', shown: 'ответ открыт' };
  /* ввод: «30 млн», «1,5к», «2e6» */
  const parseN = s => {
    s = String(s || '').trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
    const m = s.match(/^(-?[0-9.]+(?:e[+-]?\d+)?)(млрд|млн|тыс|к|k|m|b)?$/); if (!m) return NaN;
    return parseFloat(m[1]) * ({ 'млрд': 1e9, b: 1e9, 'млн': 1e6, m: 1e6, 'тыс': 1e3, 'к': 1e3, k: 1e3 }[m[2]] || 1);
  };
  /* калькулятор: только числа и + − × ÷ ( ) */
  const calcExpr = s => {
    let e = String(s || '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s+(?=\d{3}\b)/g, '$1').replace(/млрд/g, '*1e9').replace(/млн/g, '*1e6').replace(/тыс/g, '*1e3').replace(/(\d)\s*к\b/g, '$1*1e3').replace(/×|х(?=\s*\d)/g, '*').replace(/÷|:/g, '/').replace(/\^/g, '**').replace(/\s+/g, '');
    if (!e || !/^[0-9+\-*/().e]+$/.test(e) || /[a-df-z]/.test(e)) return null;
    try { const v = Function('"use strict";return (' + e + ')')(); return typeof v === 'number' && isFinite(v) ? v : null; } catch (err) { return null; }
  };
  SD.LABS.push({
    id: 'estimate', title: 'Оценка на салфетке', lede: 'RPS, объём, серверы по порядку величины', dive: 'estimate',
    intro: 'Получи легенду продукта и посчитай нагрузку. Не знаешь, с чего начать, — нажми «Решать по шагам»: вопрос разложится на шаги с формулой и подсказкой. Считать можно в калькуляторе справа. Засчитывается порядок величины: в пределах ×3 — верный порядок, в пределах ×1,5 — точно.',
    tasks: [{ id: 'one', text: 'Реши одну задачу с верным порядком во всех ответах' }, { id: 'exact', text: 'Получи «точно» во всех шести ответах' }, { id: 'three', text: 'Реши три задачи подряд без промахов' }, { id: 'sort', text: 'Расставь задержки по скорости без ошибок' }],
    mount(el, api) {
      let T = newTask(), streak = 0;
      el.innerHTML = '<div id="estMain"></div><h4>Цифры: расставь от быстрого к медленному</h4><div id="latSort"></div>';
      const main = el.querySelector('#estMain');
      latSort(el.querySelector('#latSort'), api);
      /* состояние: введённые значения, оценки, раскрытые шаги */
      let V = {}, G = {}, open = {}, checkedAll = false;
      const reset = () => { V = {}; G = {}; open = {}; checkedAll = false; };
      const prevVal = (k, steps, i) => (G[`${k}.${i}`] ? steps[i].v : null);
      const fText = (k, steps, s) => s.f.replace(/\{(\d)\}/g, (m, j) => { const pv = prevVal(k, steps, +j); return pv == null ? `(шаг ${+j + 1})` : W(pv); });
      const draw = () => {
        const act = document.activeElement && document.activeElement.id;
        const legend = `<b>Легенда.</b> ${esc(T.p.name[0].toUpperCase() + T.p.name.slice(1))}: <b>${W(T.dau)}</b> активных пользователей в день, каждый совершает ≈ <b>${T.act}</b> ${T.p.what} в сутки. Записей среди них — <b>${Math.round(T.p.w * 100)} %</b>. Одна запись весит ≈ <b>${T.size} байт</b>. Храним <b>${T.years} ${T.years === 1 ? 'год' : T.years < 5 ? 'года' : 'лет'}</b>.`;
        let h = `<div class="est-top"><div class="lab-card">${legend}</div>
          <aside class="est-cheat"><b>Шпаргалка</b><ul><li>в сутках 86 400 с ≈ <b>10⁵</b></li><li>в году ≈ 3·10⁷ с</li><li>тысяча 10³ · миллион 10⁶ · миллиард 10⁹</li><li>1 КБ = 10³ байт · 1 ГБ = 10⁹ · 1 ТБ = 10¹²</li><li>пик ≈ средний × 3</li><li>сервер приложения ≈ 2 500 запросов/с</li></ul>
          <label class="est-calc"><span>Калькулятор</span><input id="estCalc" autocomplete="off" placeholder="30 млн × 50 / 86400" value="${esc(V.calc || '')}"><output id="estCalcOut">${V.calc ? (calcExpr(V.calc) != null ? '= ' + W(calcExpr(V.calc)) : 'не понял выражение') : ''}</output></label></aside></div>
          <div class="est-qs">`;
        Q.forEach((q, qi) => {
          const g = checkedAll || G[q.k] ? gradeOf(parseN(V[q.k]), T.ans[q.k]) : null, shown = G[q.k] === 'shown';
          const steps = stepsOf(T, q.k);
          h += `<section class="est-q ${shown ? 'shown' : g || ''}"><div class="est-h"><span class="est-n">${qi + 1}</span><b>${esc(q.l)}</b>${g || shown ? `<span class="est-g">${shown ? GR.shown : GR[g]}</span>` : ''}</div>
            <div class="est-in"><input id="est_${q.k}" inputmode="decimal" autocomplete="off" value="${esc(V[q.k] || '')}" placeholder="твой ответ" aria-label="${esc(q.l)}"><small>${q.u}</small><button type="button" class="btn" data-estck="${q.k}">Проверить</button><button type="button" class="btn ghost" data-estopen="${q.k}" aria-expanded="${!!open[q.k]}">${open[q.k] ? 'Скрыть шаги' : 'Решать по шагам'}</button><button type="button" class="linkish" data-estshow="${q.k}">Ответ</button></div>`;
          if (g || shown) h += `<p class="est-ans">Ответ: <b>${W(T.ans[q.k])} ${q.u}</b>${g && !shown ? ` · у тебя ${esc(V[q.k] || '—')}` : ''}</p>`;
          if (open[q.k]) {
            h += `<div class="est-steps"><p class="est-idea">${esc(q.idea)}</p>`;
            steps.forEach((s, i) => {
              const key = `${q.k}.${i}`, sg = G[key], val = V[key] || '';
              h += `<div class="est-step ${sg || ''}"><span class="est-sl">Шаг ${i + 1}. ${esc(s.l)}:</span><span class="est-f">${esc(fText(q.k, steps, s))} =</span>
                <input id="est_${q.k}_${i}" inputmode="decimal" autocomplete="off" value="${esc(val)}" placeholder="?" aria-label="Шаг ${i + 1}: ${esc(s.l)}"><small>${esc(s.u)}</small>
                <button type="button" class="btn" data-estsck="${key}">✓</button><button type="button" class="linkish" data-estsshow="${key}">показать</button>
                ${sg ? `<span class="est-sg">${sg === 'shown' ? '' : GR[sg]}${sg === 'shown' || sg !== 'exact' ? ` · ответ ${W(s.v)}` : ''}</span>` : ''}
                ${sg === 'miss' || sg === 'order' ? `<p class="est-tip">Подсказка: ${esc(s.tip)}</p>` : ''}</div>`;
            });
            h += `<p class="est-note">Результат последнего шага — ответ на вопрос. Впиши его в поле выше и нажми «Проверить».</p></div>`;
          }
          h += `</section>`;
        });
        h += `</div><div class="row-btns"><button type="button" class="btn primary" id="estCheck">Проверить всё</button><button type="button" class="btn" id="estNew">Новая задача</button><span class="note">Серия без промахов: ${streak}</span></div>`;
        if (checkedAll) h += `<div class="lab-card sol"><b>Решение целиком.</b><br>Средний RPS = ${W(T.dau)} × ${T.act} / 86 400 ≈ <b>${W(T.ans.avg)}</b>.<br>Пик = средний × 3 ≈ <b>${W(T.ans.peak)}</b>.<br>Записи в пике = ${W(T.ans.peak)} × ${Math.round(T.p.w * 100)} % ≈ <b>${W(T.ans.wps)}</b> — это нагрузка на primary базы.<br>Данные в сутки = ${W(T.dau * T.act)} × ${Math.round(T.p.w * 100)} % × ${T.size} байт ≈ <b>${W(T.ans.day)} ГБ</b>.<br>За ${T.years} ${T.years === 1 ? 'год' : T.years < 5 ? 'года' : 'лет'} ≈ <b>${W(T.ans.total)} ТБ</b> (без реплик и индексов — с ними ×2–3).<br>Серверов = ${W(T.ans.peak)} / 2 500 × 1,3 ≈ <b>${T.ans.servers}</b>.</div>`;
        main.innerHTML = h;
        if (act) { const f = document.getElementById(act); if (f) { f.focus(); const n = f.value.length; try { f.setSelectionRange(n, n); } catch (e) { /* не текстовое поле */ } } }
      };
      el.addEventListener('input', e => {
        const t = e.target; if (!t.id || !t.id.startsWith('est')) return;
        if (t.id === 'estCalc') { V.calc = t.value; const o = el.querySelector('#estCalcOut'); const r = calcExpr(t.value); o.textContent = !t.value ? '' : r != null ? '= ' + W(r) : 'не понял выражение'; return; }
        const m = t.id.match(/^est_([a-z]+)(?:_(\d))?$/); if (m) V[m[2] != null ? `${m[1]}.${m[2]}` : m[1]] = t.value;
      });
      el.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const m = e.target.id && e.target.id.match(/^est_([a-z]+)(?:_(\d))?$/); if (!m) return;
        e.preventDefault();
        const b = el.querySelector(m[2] != null ? `[data-estsck="${m[1]}.${m[2]}"]` : `[data-estck="${m[1]}"]`); if (b) b.click();
      });
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'estCheck') {
          checkedAll = true;
          const r = Q.map(q => gradeOf(parseN(V[q.k]), T.ans[q.k]));
          if (r.every(x => x !== 'miss')) { api.done('one'); streak++; if (streak >= 3) api.done('three'); } else streak = 0;
          if (r.every(x => x === 'exact')) api.done('exact');
          draw(); return;
        }
        if (b.id === 'estNew') { T = newTask(); reset(); draw(); return; }
        if (b.dataset.estck) { G[b.dataset.estck] = 'checked'; draw(); return; }
        if (b.dataset.estshow) { const k = b.dataset.estshow; G[k] = 'shown'; draw(); return; }
        if (b.dataset.estopen) { const k = b.dataset.estopen; open[k] = !open[k]; draw(); const f = el.querySelector(`#est_${k}_0`); if (f && open[k]) f.focus(); return; }
        if (b.dataset.estsck || b.dataset.estsshow) {
          const key = b.dataset.estsck || b.dataset.estsshow, [k, i] = key.split('.'), s = stepsOf(T, k)[+i];
          G[key] = b.dataset.estsshow ? 'shown' : gradeOf(parseN(V[key]), s.v);
          draw();
          if (G[key] !== 'miss') { const n = el.querySelector(`#est_${k}_${+i + 1}`) || el.querySelector(`#est_${k}`); if (n) n.focus(); }
        }
      });
      draw();
    }
  });
  const LAT = [['Чтение из L1-кэша процессора', 1], ['Чтение из оперативной памяти', 100], ['Запрос в Redis в том же дата-центре', 300000], ['Случайное чтение с SSD', 100000], ['Простой SELECT по индексу в PostgreSQL', 2000000], ['Пинг Москва — Новосибирск', 50000000], ['Пинг Европа — США', 100000000], ['Ответ с CDN рядом с пользователем', 15000000]];
  function latSort(el, api) {
    let order = LAT.map((x, i) => i).sort(() => Math.random() - 0.5), checked = false;
    const draw = () => {
      const correct = order.every((v, i, a) => i === 0 || LAT[a[i - 1]][1] <= LAT[v][1]);
      el.innerHTML = `<ol class="sort-list">${order.map((v, i) => `<li class="${checked ? (i === 0 || LAT[order[i - 1]][1] <= LAT[v][1] ? 'ok' : 'bad') : ''}"><span>${esc(LAT[v][0])}${checked ? ` · <small>${LAT[v][1] >= 1e6 ? fmtN(LAT[v][1] / 1e6) + ' мс' : LAT[v][1] >= 1000 ? fmtN(LAT[v][1] / 1000) + ' мкс' : LAT[v][1] + ' нс'}</small>` : ''}</span><button type="button" data-up="${i}" aria-label="Выше">↑</button><button type="button" data-down="${i}" aria-label="Ниже">↓</button></li>`).join('')}</ol>
        <div class="row-btns"><button type="button" class="btn" id="latCheck">Проверить порядок</button>${checked ? `<span class="note">${correct ? 'Всё верно: разница между соседями — порядки величин.' : 'Есть ошибки: красные строки стоят не на месте.'}</span>` : ''}</div>`;
      el.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; checked = false; draw(); } });
      el.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { const i = +b.dataset.down; if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; checked = false; draw(); } });
      el.querySelector('#latCheck').onclick = () => { checked = true; if (order.every((v, i, a) => i === 0 || LAT[a[i - 1]][1] <= LAT[v][1])) api.done('sort'); draw(); };
    };
    draw();
  }

  /* ---------- 2. Consistent hashing ---------- */
  SD.LABS.push({
    id: 'ring', title: 'Consistent hashing', lede: 'Кольцо против hash % N', dive: 'sharding',
    intro: '400 ключей распределены по серверам. Добавляй и убирай серверы и смотри, сколько ключей переезжает. Сравни режимы «hash % N» и «кольцо», поиграй числом виртуальных точек.',
    tasks: [{ id: 'mod', text: 'В режиме hash % N добавь сервер и посмотри, сколько ключей переехало' }, { id: 'ring', text: 'В режиме кольца добавь сервер: переехать должно меньше 35 % ключей' }, { id: 'balance', text: 'Подбери виртуальные точки так, чтобы перекос нагрузки был меньше 15 %' }],
    mount(el, api) {
      const COLORS = ['#74a6ff', '#a78bfa', '#22d3ee', '#fbbf24', '#f472b6', '#35d68e', '#fb923c', '#c4b5fd', '#86efac', '#fda4af'];
      const keys = Array.from({ length: 400 }, (_, i) => 'user:' + (i * 7919 % 100003));
      let nodes = ['A', 'B', 'C'], vn = 1, mode = 'ring', prev = null, moved = null, seq = 3;
      const ringOf = () => nodes.flatMap(n => Array.from({ length: vn }, (_, i) => [fnv(n + '#' + i), n])).sort((a, b) => a[0] - b[0]);
      const assign = () => {
        if (mode === 'mod') return keys.map(k => nodes[fnv(k) % nodes.length]);
        const r = ringOf();
        return keys.map(k => { const h = fnv(k); const p = r.find(([v]) => v >= h) || r[0]; return p[1]; });
      };
      const draw = () => {
        const a = assign();
        if (prev) moved = a.filter((n, i) => n !== prev[i]).length / keys.length;
        const counts = nodes.map(n => a.filter(x => x === n).length);
        const avg = keys.length / nodes.length, skew = Math.max(...counts.map(c => Math.abs(c - avg) / avg));
        if (mode === 'ring' && nodes.length >= 3 && skew < 0.15) api.done('balance');
        const R = 120, cx = 150, cy = 150, ang = h => h / 4294967296 * Math.PI * 2 - Math.PI / 2;
        const ring = mode === 'ring' ? ringOf() : [];
        el.innerHTML = `<div class="lab-split"><svg viewBox="0 0 300 300" class="lab-svg" aria-label="Кольцо хэшей">
          <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--border-strong)" stroke-width="2"></circle>
          ${keys.map((k, i) => { const t = ang(fnv(k)); return `<circle cx="${cx + Math.cos(t) * (R - 12)}" cy="${cy + Math.sin(t) * (R - 12)}" r="2.2" fill="${COLORS[nodes.indexOf(a[i]) % COLORS.length]}" opacity=".85"></circle>`; }).join('')}
          ${ring.map(([h, n]) => { const t = ang(h); return `<circle cx="${cx + Math.cos(t) * R}" cy="${cy + Math.sin(t) * R}" r="${vn > 20 ? 2 : 5}" fill="${COLORS[nodes.indexOf(n) % COLORS.length]}" stroke="var(--bg)" stroke-width="1"></circle>`; }).join('')}
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="lab-big">${mode === 'ring' ? 'кольцо' : 'hash % ' + nodes.length}</text>
          <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="lab-small">${nodes.length} сервера · ${keys.length} ключей</text></svg>
          <div class="lab-side"><div class="seg"><button type="button" data-mode="mod" aria-selected="${mode === 'mod'}">hash % N</button><button type="button" data-mode="ring" aria-selected="${mode === 'ring'}">Кольцо</button></div>
          <div class="row-btns"><button type="button" class="btn primary" id="rAdd">+ сервер</button><button type="button" class="btn" id="rDel" ${nodes.length < 2 ? 'disabled' : ''}>− сервер</button></div>
          ${mode === 'ring' ? `<div class="prop"><label for="rVn">Виртуальных точек на сервер <output>${vn}</output></label><input type="range" id="rVn" min="1" max="200" value="${vn}"></div>` : ''}
          ${moved != null ? `<div class="lab-card ${moved > 0.5 ? 'badc' : 'okc'}"><b>Переехало ключей: ${Math.round(moved * 100)} %.</b> ${moved > 0.5 ? 'Почти всё: при шардировании это значит переносить почти все данные.' : 'Переехала только доля нового сервера — около 1/N.'}</div>` : ''}
          <div class="bars">${nodes.map((n, i) => `<div><span style="color:${COLORS[i % COLORS.length]}">●</span> ${n}<i><b style="width:${counts[i] / keys.length * 100 * nodes.length / 2}%;background:${COLORS[i % COLORS.length]}"></b></i><small>${counts[i]}</small></div>`).join('')}</div>
          <p class="note">Перекос нагрузки: ${Math.round(skew * 100)} % от среднего.</p></div></div>`;
        el.querySelector('#rAdd').onclick = () => { prev = assign(); nodes.push(String.fromCharCode(65 + seq++)); const na = assign(); const m = na.filter((n, i) => n !== prev[i]).length / keys.length; if (mode === 'mod') api.done('mod'); else if (m < 0.35) api.done('ring'); draw(); };
        el.querySelector('#rDel').onclick = () => { prev = assign(); nodes.pop(); draw(); };
        el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; prev = null; moved = null; draw(); });
        const s = el.querySelector('#rVn'); if (s) s.onchange = () => { vn = +s.value; prev = null; moved = null; draw(); };
      };
      draw();
    }
  });

  /* ---------- 3. Кворумы ---------- */
  SD.LABS.push({
    id: 'quorum', title: 'Кворумы N, R, W', lede: 'Когда чтение видит последнюю запись', dive: 'quorum',
    intro: 'N реплик хранят значение. Запись подтверждают W реплик, чтение опрашивает R реплик и берёт самую свежую версию. Роняй узлы кликом, пиши и читай.',
    tasks: [{ id: 'stale', text: 'Получи устаревшее чтение' }, { id: 'fresh', text: 'Настрой R и W так, чтобы чтение всегда было свежим (R + W > N), и прочитай' }, { id: 'unavail', text: 'Добейся отказа записи: живых реплик меньше W' }],
    mount(el, api) {
      let N = 3, R = 1, W = 1, ver = 0, wptr = 0, rptr = 1, nodes = Array.from({ length: 7 }, () => ({ v: 0, up: true })), log = [];
      const alive = () => nodes.slice(0, N).map((n, i) => ({ n, i })).filter(x => x.n.up);
      const draw = () => {
        const cx = 160, cy = 140, rr = 95;
        el.innerHTML = `<div class="lab-split"><svg viewBox="0 0 320 280" class="lab-svg" aria-label="Реплики">
          ${nodes.slice(0, N).map((n, i) => { const t = i / N * Math.PI * 2 - Math.PI / 2, x = cx + Math.cos(t) * rr, y = cy + Math.sin(t) * rr; return `<g class="q-node" data-node="${i}" style="cursor:pointer"><circle cx="${x}" cy="${y}" r="28" fill="${n.up ? 'var(--surface-2)' : 'var(--bad-soft)'}" stroke="${n.up ? (n.v === ver && ver ? 'var(--ok)' : 'var(--border-strong)') : 'var(--bad)'}" stroke-width="2"></circle><text x="${x}" y="${y - 2}" text-anchor="middle" class="lab-big">v${n.v}</text><text x="${x}" y="${y + 13}" text-anchor="middle" class="lab-small">${n.up ? 'реплика ' + (i + 1) : 'лежит'}</text></g>`; }).join('')}
          <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="lab-small">последняя запись: v${ver}</text></svg>
          <div class="lab-side">
            <div class="prop"><label for="qN">N — реплик <output>${N}</output></label><input type="range" id="qN" min="3" max="7" value="${N}"></div>
            <div class="prop"><label for="qW">W — подтверждений записи <output>${W}</output></label><input type="range" id="qW" min="1" max="${N}" value="${W}"></div>
            <div class="prop"><label for="qR">R — реплик на чтение <output>${R}</output></label><input type="range" id="qR" min="1" max="${N}" value="${R}"></div>
            <p class="note">${R + W > N ? `R + W = ${R + W} > N = ${N}: множества чтения и записи пересекаются, чтение увидит последнюю запись.` : `R + W = ${R + W} ≤ N = ${N}: чтение может не задеть ни одной свежей реплики.`}</p>
            <div class="row-btns"><button type="button" class="btn primary" id="qWr">Записать</button><button type="button" class="btn" id="qRd">Прочитать</button></div>
            <p class="note">Клик по реплике роняет или поднимает её.</p>
            <ul class="lab-log">${log.slice(-6).reverse().map(l => `<li class="${l.c}">${esc(l.t)}</li>`).join('')}</ul></div></div>`;
        el.querySelectorAll('[data-node]').forEach(g => g.onclick = () => { const n = nodes[+g.dataset.node]; n.up = !n.up; log.push({ t: `Реплика ${+g.dataset.node + 1} ${n.up ? 'поднята' : 'упала'}`, c: n.up ? '' : 'bad' }); draw(); });
        const bind = (id, f) => { el.querySelector(id).oninput = e => { f(+e.target.value); draw(); }; };
        bind('#qN', v => { N = v; W = Math.min(W, N); R = Math.min(R, N); });
        bind('#qW', v => { W = v; }); bind('#qR', v => { R = v; });
        el.querySelector('#qWr').onclick = () => {
          const a = alive();
          if (a.length < W) { log.push({ t: `Запись отклонена: живых реплик ${a.length}, а нужно W = ${W}`, c: 'bad' }); api.done('unavail'); draw(); return; }
          ver++;
          for (let k = 0; k < W; k++) { const x = a[(wptr + k) % a.length]; x.n.v = ver; }
          wptr = (wptr + 1) % Math.max(1, a.length);
          log.push({ t: `Запись v${ver} подтвердили ${W} реплик(и)`, c: 'ok' }); draw();
        };
        el.querySelector('#qRd').onclick = () => {
          const a = alive();
          if (a.length < R) { log.push({ t: `Чтение не удалось: живых реплик ${a.length} < R = ${R}`, c: 'bad' }); draw(); return; }
          const got = []; for (let k = 0; k < R; k++) got.push(a[(rptr + k) % a.length]);
          rptr = (rptr + 1) % Math.max(1, a.length);
          const best = Math.max(...got.map(x => x.n.v));
          const stale = best < ver;
          log.push({ t: `Прочитали реплики ${got.map(x => x.i + 1).join(', ')}: v${best}${stale ? ' — устарело!' : ' — свежее'}`, c: stale ? 'bad' : 'ok' });
          if (stale) api.done('stale'); else if (R + W > N && ver > 0) api.done('fresh');
          draw();
        };
      };
      draw();
    }
  });
})();
