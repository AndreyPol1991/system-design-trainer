/* «Изнутри» → «Как менялись цифры»: мини-графики метрик сцены за последнюю минуту и сравнение «было → стало».
   Отдельная обёртка над mount каждой сцены SD.XRAY[type]. Подключается после xray-sqldata.js и xray-biz.js, перед app.js,
   поэтому она внешняя. Свои у неё только tick, stats и destroy, остальные методы сцены и цепочки обёрток не тронуты.
   – Запись: числа из строк stats() раз в 0,5 с времени сцены. Время сцены идёт только в tick, то есть с учётом паузы
     и скорости. Строки берём из того же вызова stats(), что делает ядро (раз в 300 мс), лишних вызовов нет. Храним 60 с.
   – Блок .xtr-box сразу под #xrStats: подпись, значение, спарклайн за 60 с, подписи минимума и максимума.
   – «Запомнить как „до“» снимает цифры; дальше у каждой метрики видно «было → стало» со стрелкой.
   – Перемотка: ползунок или наведение мыши на график показывают цифры прошлого момента, сама сцена идёт дальше.
   – Смена вида сцены сбрасывает историю: там другие метрики. Закрыл сцену — блок и обработчики убраны. */
(function () {
  'use strict';
  if (!window.SD || !SD.XRAY) return;

  const STEP = 500;        // как часто записывать, мс времени сцены
  const WIN = 60000;       // сколько хранить, мс времени сцены
  const MINSPAN = 15000;   // самое узкое окно графика, пока запись ещё короткая
  const H = 28, PAD = 5;   // высота спарклайна и поля сверху и снизу, px
  const RANK = { bad: 0, warn: 1, '': 2, ok: 3 };
  const CLS_NAME = { ok: 'норма', warn: 'внимание', bad: 'плохо', '': 'без оценки' };
  const GLYPH = { ok: '✓', warn: '!', bad: '✕' };
  const ANALOGY = 'Как весы до и после диеты: запомни цифры, поменяй одну настройку — и смотри, что сдвинулось.';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = c => (c === 'ok' || c === 'warn' || c === 'bad') ? c : '';
  const fx = v => (Math.round(v * 100) / 100).toString();

  /* ---------- разбор значения-строки в число ----------
     Пробел (и неразрывные пробелы) — разделитель тысяч, запятая — десятичная. Множители «k», «тыс», «млн», «млрд».
     Единицы времени приводим к мс, размера — к байтам: тогда «980 мс» и «1,2 с» лежат на одной линии.
     «/с» после числа — это «в секунду», а не секунды. Берём первое число в строке: '3 ✓ · 1 ✕' → 3. */
  const SPACES = /[    ]/g;
  const MUL = { k: 1e3, K: 1e3, 'тыс': 1e3, 'тыс.': 1e3, 'млн': 1e6, 'млрд': 1e9 };
  const UNIT = { 'мкс': 1e-3, 'мс': 1, 'с': 1e3, 'сек': 1e3, 'мин': 6e4, 'ч': 3.6e6, 'дн': 8.64e7, 'Б': 1, 'КБ': 1024, 'МБ': 1048576, 'ГБ': 1073741824, 'ТБ': 1099511627776, 'ПБ': 1125899906842624 };
  const NOTL = '(?![A-Za-zА-Яа-яЁё])';
  const RX = new RegExp('([-−]?)(\\d{1,3}(?: \\d{3})+|\\d+)(?:[,.](\\d+))?(?: ?(тыс\\.?|млн|млрд|k|K)' + NOTL + ')?(?: ?(мкс|мс|сек|мин|дн|ч|с|КБ|МБ|ГБ|ТБ|ПБ|Б)' + NOTL + ')?');
  function parse(raw) {
    const s = String(raw == null ? '' : raw).replace(SPACES, ' ');
    const m = RX.exec(s); if (!m) return null;
    let n = parseFloat(m[2].replace(/ /g, '') + (m[3] ? '.' + m[3] : ''));
    if (!isFinite(n)) return null;
    let a = m.index, b = m.index + m[0].length;
    if (m[1]) { if (a > 0 && /[0-9A-Za-zА-Яа-яЁё]/.test(s[a - 1])) a++; else n = -n; }
    if (m[4]) n *= MUL[m[4]] || 1;
    if (m[5]) n *= UNIT[m[5]] || 1;
    /* короткая подпись для минимума и максимума: само число с единицей, «$ № # ×» спереди, «%», «₽» или «/с» сзади */
    if ('$№#×'.includes(s[a - 1] || ' ')) a--;
    const tail = /^ ?(?:%|₽|\/[A-Za-zА-Яа-яЁё]+)/.exec(s.slice(b)); if (tail) b += tail[0].length;
    return { n, tok: s.slice(a, b).trim() };
  }

  let current = null;   // запись открытой сцены — для отладки и тестов

  /* ---------- запись и блок одной открытой сцены ---------- */
  function trend(ctx) {
    const statsEl = document.getElementById('xrStats');
    const modal = document.getElementById('xrModal');
    document.querySelectorAll('.xtr-box').forEach(x => x.remove());   // хвост прошлой сцены, если её не убрали
    const box = document.createElement('section');
    box.className = 'xtr-box'; box.hidden = true;
    box.setAttribute('aria-label', 'Как менялись цифры за последнюю минуту');
    box.innerHTML = `<div class="xtr-head"><p class="xtr-an">${esc(ANALOGY)}</p><div class="xtr-acts">`
      + `<button type="button" class="btn xtr-btn" data-xtr="mark" title="Снять цифры этого момента, чтобы потом сравнить">Запомнить как «до»</button>`
      + `<button type="button" class="btn xtr-btn" data-xtr="reset" title="Забыть «до»" hidden>Сбросить</button></div></div>`
      + `<div class="xtr-rows" role="list"></div>`
      + `<div class="xtr-foot"><label class="xtr-scrub"><span>Перемотка</span><input type="range" class="xtr-range" min="0" max="0" step="1" value="0" disabled></label>`
      + `<output class="xtr-when" title="По часам сцены: пауза и скорость учтены">сейчас</output>`
      + `<button type="button" class="btn xtr-btn" data-xtr="live" disabled>Сейчас</button>`
      + `<p class="xtr-msg" aria-live="polite"></p></div>`;
    if (statsEl && statsEl.parentNode) statsEl.insertAdjacentElement('afterend', box);
    const rowsEl = box.querySelector('.xtr-rows'), range = box.querySelector('.xtr-range'), whenEl = box.querySelector('.xtr-when');
    const liveBtn = box.querySelector('[data-xtr="live"]'), resetBtn = box.querySelector('[data-xtr="reset"]'), msgEl = box.querySelector('.xtr-msg');

    let dead = false, raf = 0;
    let sceneT = 0, due = 0;               // время сцены и срок следующей записи, мс
    let hist = [];                         // записи: { t, m: { подпись: [число|null, строка, класс, подпись числа] }, o: [порядок подписей] }
    let cur = {}, curOrder = [];           // последние строки stats()
    let base = null, changes = [], missed = false;   // «до», что поменяли после, меняли ли без «до»
    let scrub = null;                      // перемотка: { snap, i, mode: 'drag' | 'key' | 'hover' }
    let view = ctx.view ? ctx.view() : null;
    let shown = '';                        // что сейчас нарисовано — не перерисовывать то же самое

    const reset = () => { hist = []; due = sceneT; base = null; changes = []; missed = false; scrub = null; };
    /* история плюс «сейчас» — чтобы линия доходила до текущего значения, а не до последней записи */
    const series = () => { const a = hist.slice(); if (curOrder.length && (!a.length || sceneT > a[a.length - 1].t)) a.push({ t: sceneT, m: cur, o: curOrder }); return a; };
    const winOf = src => { const tEnd = src.length ? src[src.length - 1].t : sceneT, span = Math.max(MINSPAN, src.length ? tEnd - src[0].t : 0); return { t0: tEnd - span, tEnd, span }; };
    const nearest = (src, t) => { let bi = 0, bd = Infinity; src.forEach((s, i) => { const d = Math.abs(s.t - t); if (d < bd) { bd = d; bi = i; } }); return bi; };

    function take(rows) {
      if (dead) return;
      const v = ctx.view ? ctx.view() : null;
      if (v !== view) { view = v; reset(); }
      const m = {}, o = [];
      (Array.isArray(rows) ? rows : []).forEach(r => {
        if (!r) return;
        let l = String(r[0] == null ? '' : r[0]).trim(); if (!l) return;
        if (l in m) { let k = 2; while ((l + ' (' + k + ')') in m) k++; l = l + ' (' + k + ')'; }
        const s = r[1] == null ? '' : String(r[1]), p = parse(s);
        m[l] = [p ? p.n : null, s, cls(r[2]), p ? p.tok : '']; o.push(l);
      });
      cur = m; curOrder = o;
      if (o.length && sceneT >= due) {   // срок двигаем от прошлого срока: ядро спрашивает раз в 300 мс, а в среднем выходит 0,5 с
        hist.push({ t: sceneT, m, o }); due += STEP; if (due <= sceneT) due = sceneT + STEP;
        while (hist.length && hist[0].t < sceneT - WIN) hist.shift();
      }
      render();
    }

    /* ---------- рисование ---------- */
    function rowHtml(l, v, src, w, i, live) {
      const X = t => (t - w.t0) / w.span * 100;
      let lo = null, hi = null;
      const pts = src.map(s => {
        const r = s.m[l]; if (!r || r[0] == null) return null;
        const p = { t: s.t, n: r[0], c: r[2], k: r[3] || r[1] };
        if (!lo || p.n < lo.n) lo = p; if (!hi || p.n > hi.n) hi = p;
        return p;
      });
      const flat = !lo || hi.n === lo.n;
      const Y = n => flat ? H / 2 : PAD + (1 - (n - lo.n) / (hi.n - lo.n)) * (H - 2 * PAD);
      /* отрезок красим по классу его правой точки; подряд идущие отрезки одного класса — один path; пропуск рвёт линию */
      const runs = []; let prev = null, run = null;
      pts.forEach(p => {
        if (!p) { prev = null; run = null; return; }
        if (prev) {
          if (!run || run.c !== p.c) { run = { c: p.c, d: 'M' + fx(X(prev.t)) + ' ' + fx(Y(prev.n)) }; runs.push(run); }
          run.d += 'L' + fx(X(p.t)) + ' ' + fx(Y(p.n));
        }
        prev = p;
      });
      let dp = null;
      if (live) { for (let k = pts.length - 1; k >= 0; k--) if (pts[k]) { dp = pts[k]; break; } } else dp = pts[i] || null;
      const dot = dp ? `<i class="xtr-dot ${dp.c}" style="left:${fx(X(dp.t))}%;top:${fx(Y(dp.n))}px"></i>` : '';
      const cross = !live && src[i] ? `<i class="xtr-cross" style="left:${fx(X(src[i].t))}%"></i>` : '';
      const bm = base && base.t >= w.t0 && base.t <= w.tEnd ? `<i class="xtr-bm" style="left:${fx(X(base.t))}%" title="Момент «до»"></i>` : '';
      const glyph = c => GLYPH[c] ? `<i class="xtr-st ${c}" aria-hidden="true">${GLYPH[c]}</i>` : '';
      const nowH = `${glyph(v[2])}<b>${esc(v[1])}</b>`;
      let vh = nowH;
      if (base) {
        const was = base.m[l];
        if (was && was[0] != null) {
          const d = v[0] - was[0], same = Math.abs(d) <= Math.abs(was[0]) * 1e-3 + 1e-9;
          const rc = RANK[was[2]], rn = RANK[v[2]];
          const ver = rn > rc ? 'better' : rn < rc ? 'worse ' + (v[2] === 'bad' ? 'bad' : 'warn') : 'same';
          const how = same ? 'не изменилось' : d > 0 ? 'выросло' : 'снизилось';
          const verd = rn > rc ? 'стало лучше' : rn < rc ? 'стало хуже' : 'оценка та же';
          const tip = `${how}; ${verd}: было «${CLS_NAME[was[2]]}», стало «${CLS_NAME[v[2]]}»`;
          vh = `<span class="xtr-was"><span class="xtr-sr">было </span>${glyph(was[2])}${esc(was[1])}</span>`
            + `<span class="xtr-arr ${ver}" title="${esc(tip)}"><span aria-hidden="true">${same ? '→' : d > 0 ? '↗' : '↘'}</span><span class="xtr-sr">${esc(how + ', ' + verd)}, стало </span></span>${nowH}`;
        } else vh = `<span class="xtr-was" title="В момент «до» этой цифры не было">—</span><span class="xtr-arr same" aria-hidden="true">→</span>${nowH}`;
      }
      const mm = lo ? `<span class="xtr-mm"><span title="Максимум за запись">макс <b>${esc(hi.k)}</b></span><span title="Минимум за запись">мин <b>${esc(lo.k)}</b></span></span>` : '<span class="xtr-mm"></span>';
      return `<div class="xtr-row" role="listitem"><span class="xtr-lv"><span class="xtr-l" title="${esc(l)}">${esc(l)}</span><span class="xtr-v">${vh}</span></span>`
        + `<span class="xtr-spark" aria-hidden="true"><svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" focusable="false">${runs.map(r => `<path class="xtr-ln ${r.c}" d="${r.d}"/>`).join('')}</svg>${bm}${cross}${dot}</span>${mm}</div>`;
    }

    function render() {
      if (dead) return;
      const live = !scrub;
      const src = live ? series() : scrub.snap;
      const i = live ? src.length - 1 : Math.max(0, Math.min(src.length - 1, scrub.i));
      const at = src[i] || null;
      const show = live ? cur : (at ? at.m : {}), order = live ? curOrder : (at ? at.o : []);
      const labels = order.filter(l => show[l] && show[l][0] != null);
      const hide = !labels.length || !!(statsEl && statsEl.hidden);
      if (box.hidden !== hide) box.hidden = hide;
      if (hide) return;
      const w = winOf(src);
      const html = labels.map(l => rowHtml(l, show[l], src, w, i, live)).join('');
      if (html !== shown) { rowsEl.innerHTML = html; shown = html; }
      /* ползунок: в живом режиме — на правом краю; при перемотке его ведёт человек */
      const n = src.length;
      range.disabled = n < 2;
      if (live) { if (+range.max !== n - 1) range.max = String(Math.max(0, n - 1)); if (+range.value !== n - 1) range.value = String(Math.max(0, n - 1)); }
      else if (scrub.mode === 'hover' && +range.value !== i) range.value = String(i);
      const ago = at ? Math.round((w.tEnd - at.t) / 1000) : 0;
      const when = live ? 'сейчас' : ago > 0 ? ago + ' с назад' : 'конец записи';
      if (whenEl.textContent !== when) whenEl.textContent = when;
      liveBtn.disabled = live;
      resetBtn.hidden = !base;
      let msg = '';
      if (!live) msg = 'Цифры того момента. Сцена идёт дальше: отпусти ползунок или нажми «Сейчас».';
      else if (base && changes.length) msg = 'Поменял: ' + changes.join(', ') + '. Слева — как было, справа — как стало.';
      else if (base) msg = 'Запомнил «до» — это черта на графиках. Теперь поменяй настройку справа или ситуацию над картинкой.';
      else if (missed) msg = 'Забыл запомнить? Перемотай ползунком назад и нажми «Запомнить как „до“».';
      if (msgEl.textContent !== msg) msgEl.textContent = msg;
    }
    const renderSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

    /* ---------- перемотка ---------- */
    function startScrub(mode) {
      const snap = series(); if (snap.length < 2) return false;
      scrub = { snap, i: snap.length - 1, mode };
      range.max = String(snap.length - 1);
      return true;
    }
    const goLive = () => { if (!scrub) return; scrub = null; render(); };
    const onDown = () => { if (scrub) scrub.mode = 'drag'; else startScrub('drag'); };
    const onInput = () => { if (!scrub && !startScrub('key')) return; scrub.i = +range.value; render(); };
    const onUp = () => { if (scrub && scrub.mode === 'drag') goLive(); };
    const onMove = e => {
      if (e.pointerType === 'touch' || (scrub && scrub.mode !== 'hover')) return;
      const sp = e.target && e.target.closest ? e.target.closest('.xtr-spark') : null;
      if (!sp) { if (scrub) goLive(); return; }
      if (!scrub && !startScrub('hover')) return;
      const r = sp.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
      const w = winOf(scrub.snap), i = nearest(scrub.snap, w.t0 + f * w.span);
      if (i !== scrub.i) { scrub.i = i; renderSoon(); }
    };
    const onLeave = () => { if (scrub && scrub.mode === 'hover') goLive(); };

    /* ---------- кнопки блока ---------- */
    const onBox = e => {
      const b = e.target.closest('[data-xtr]'); if (!b || b.disabled) return;
      const a = b.dataset.xtr;
      if (a === 'mark') {
        const at = scrub ? scrub.snap[Math.max(0, Math.min(scrub.snap.length - 1, scrub.i))] : null;
        base = at ? { t: at.t, m: at.m } : { t: sceneT, m: cur };
        changes = []; missed = false; scrub = null;
      }
      if (a === 'reset') { base = null; changes = []; missed = false; }
      if (a === 'live') scrub = null;
      render();
    };

    /* ---------- что поменяли после «до»: слушаем в фазе захвата, разметку ядра не трогаем ---------- */
    const note = s => { if (!base) { missed = true; return; } changes = changes.filter(x => x !== s).concat(s).slice(-3); };
    const onChg = e => {
      const t = e.target; if (!t || !t.dataset || !t.dataset.xp || !t.closest('#xrProps')) return;
      const p = t.closest('.xr-prop'), lb = p && p.querySelector('label');
      note('«' + (lb ? lb.textContent.trim() : t.dataset.xp) + '»');
    };
    const onClk = e => { const b = e.target && e.target.closest ? e.target.closest('[data-xscn]') : null; if (b) note('ситуация «' + b.textContent.trim() + '»'); };

    box.addEventListener('click', onBox);
    range.addEventListener('pointerdown', onDown);
    range.addEventListener('input', onInput);
    rowsEl.addEventListener('pointermove', onMove);
    rowsEl.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    if (modal) { modal.addEventListener('change', onChg, true); modal.addEventListener('click', onClk, true); }
    /* Окно сцены иногда прячут в обход SD.xray.close() — тогда ядро не зовёт destroy (close() выходит на «уже скрыто»).
       Поэтому следим сами: окно было видно и стало скрытым — убираем блок и обработчики. Повторный destroy от ядра безопасен. */
    const mo = modal && window.MutationObserver ? new MutationObserver(recs => { if (modal.hidden && recs.some(r => r.oldValue === null)) api.destroy(); }) : null;
    if (mo) mo.observe(modal, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });

    const api = {
      tick(dt) { if (!dead && dt > 0 && isFinite(dt)) sceneT += dt; },
      take,
      destroy() {
        if (dead) return;
        dead = true; scrub = null; hist = []; cur = {}; curOrder = []; base = null;
        if (raf) cancelAnimationFrame(raf); raf = 0;
        if (mo) mo.disconnect();
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (modal) { modal.removeEventListener('change', onChg, true); modal.removeEventListener('click', onClk, true); }
        box.removeEventListener('click', onBox);
        range.removeEventListener('pointerdown', onDown); range.removeEventListener('input', onInput);
        rowsEl.removeEventListener('pointermove', onMove); rowsEl.removeEventListener('pointerleave', onLeave);
        box.remove();
        if (current === api) current = null;
      },
      info() {
        return { t: sceneT, samples: hist.length, span: hist.length ? hist[hist.length - 1].t - hist[0].t : 0, view,
          metrics: curOrder.filter(l => cur[l] && cur[l][0] != null), base: base ? base.t : null, changes: changes.slice(), missed,
          scrub: scrub ? { mode: scrub.mode, i: scrub.i, n: scrub.snap.length } : null, hidden: box.hidden };
      }
    };
    current = api;
    return api;
  }

  /* ---------- обёртка над mount каждой сцены ---------- */
  const DONE = new WeakSet();
  function wrap(type) {
    const def = SD.XRAY[type];
    if (!def || typeof def.mount !== 'function' || DONE.has(def)) return;
    DONE.add(def);
    const mount0 = def.mount;
    def.mount = function (ctx) {
      const inner = mount0.apply(this, arguments) || {};
      if (typeof inner.stats !== 'function') return inner;   // сцена без цифр — записывать нечего
      let tr = null;
      try { tr = trend(ctx); } catch (e) { if (window.console) console.warn('xray-trend:', e); return inner; }
      return Object.assign({}, inner, {
        tick(dt) { if (inner.tick) inner.tick(dt); tr.tick(dt); },
        stats() { const rows = inner.stats(); try { tr.take(rows); } catch (e) { if (window.console) console.warn('xray-trend:', e); } return rows; },
        destroy() { tr.destroy(); if (inner.destroy) inner.destroy(); }
      });
    };
  }
  const wrapAll = () => Object.keys(SD.XRAY).forEach(wrap);
  (SD.XRAY_HOOKS = SD.XRAY_HOOKS || []).push(wrap);   // сцена загрузилась позже
  wrapAll();
  window.addEventListener('load', wrapAll);   // если сцену зарегистрируют позже

  SD.xrayTrend = { parse, info: () => (current ? current.info() : null), STEP, WIN };
})();
