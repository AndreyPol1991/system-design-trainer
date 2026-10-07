/* «На пальцах»: общая карточка темы уровня. Новая тема сначала объясняется без терминов — тезис, бытовая аналогия
   и картинка, где каждый предмет аналогии подписан своим термином, — и только потом идут задание и детали.
   Как добавить в любой уровень:
     L.fingers = {
       title:   'тема коротко — подпись в шапке карточки (необязательно)',
       thesis:  'одна-две фразы без терминов: что это и зачем',
       analogy: 'бытовая аналогия',
       picture: '<svg viewBox="0 0 320 …">…</svg>' или (L) => '<svg …>',
       map:     [['предмет', 'термин', 'пояснение — необязательно'], …]
     };
   Предмет на картинке — любой элемент с data-lf-k="i", где i — номер пары в map. Наведение, фокус или клик по предмету
   (на картинке или в списке) подсвечивает пару «аналогия ↔ термин»; клик закрепляет подсветку, повторный — снимает.
   Карточку можно свернуть: состояние хранится по уровню в localStorage. В свободном режиме без подсказок карточки нет.
   Свободный режим и событие дня берут карточку базового уровня.
   Классы для картинок (стили — в level-fingers.css, только переменные :root, обе темы):
     lf-fg-svg — сама картинка; lf-fg-it — предмет; lf-fg-box — рамка предмета; lf-fg-ico — значок (штрих, как у узлов);
     lf-fg-ta — подпись-аналогия; lf-fg-tt — термин; lf-fg-ar / lf-fg-ah — стрелка и наконечник; lf-fg-tag — короткая пометка;
     lf-fg-zone — подпись зоны; lf-fg-wall — граница зон; цвета: lf-fg-ok, lf-fg-bad, lf-fg-dash (пунктир), lf-fg-weak (неверный путь).
   Пример картинок — js/levels-e2e.js (сквозная аналитика).
   Подключение: в panels.js одна строка рядом с карточками задания — `if (SD.fingers) h += SD.fingers.card(L);`. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const HAS_DOM = typeof document !== 'undefined';
  const KEY = 'amp-stroyka-fingers-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { U = {}; }
  U.closed = U.closed || {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища — состояние до перезагрузки */ } };

  /* состояние живёт между перерисовками панели задания: какой уровень, какая пара закреплена, какая под мышью */
  const ST = { key: null, pin: null, hov: null, F: null };
  /* у каждой карточки своя таблица пар: на экране могут быть сразу две — уровень и открытая поверх лаборатория */
  const FS = {};
  const baseId = L => (L.free && L.free.base) || (L.daily && L.daily.base) || L.id;
  function fingersOf(L) {
    if (!L) return null;
    if (L.fingers) return L.fingers;
    const b = baseId(L);
    const B = b !== L.id && SD.levelById ? SD.levelById(b) : null;
    return (B && B.fingers) || null;
  }
  const hidden = () => !!(SD.free && SD.free.hintsOn && !SD.free.hintsOn());
  const has = L => !!(L && !hidden() && fingersOf(L) && fingersOf(L).thesis);

  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5V4.5a1.5 1.5 0 0 1 3 0v7"/><path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v7.5"/><path d="M17 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7L4.6 14a1.6 1.6 0 0 1 2.6-1.8L8 13.2"/></svg>';
  const capOf = (F, i) => {
    const m = F && F.map && F.map[i];
    if (!m) return 'Наведи на предмет или нажми на него — подсветится его термин.';
    return `<b>${esc(m[0])}</b> <span class="lf-fg-eq" aria-hidden="true">↔</span> <b class="lf-fg-term">${esc(m[1])}</b>${m[2] ? `<span class="lf-fg-capx">${esc(m[2])}</span>` : ''}`;
  };

  function card(L) {
    if (!has(L)) return '';
    const F = fingersOf(L), k = baseId(L);
    if (ST.key !== k) { ST.key = k; ST.pin = null; ST.hov = null; }
    ST.F = F; FS[k] = F;
    const open = !U.closed[k], on = ST.pin;
    let pic = '';
    try { pic = typeof F.picture === 'function' ? F.picture(L) : (F.picture || ''); } catch (e) { pic = ''; }
    const map = F.map || [];
    let h = `<section class="lf-fg${open ? '' : ' lf-fg-closed'}" data-lf-card="${esc(k)}" aria-label="На пальцах: ${esc(F.title || L.title)}">`;
    h += `<button type="button" class="lf-fg-head" data-lf-toggle aria-expanded="${open}"><span class="lf-fg-eb">${ICON}<span>На пальцах</span></span>${F.title ? `<span class="lf-fg-ti">${esc(F.title)}</span>` : ''}<span class="lf-fg-chev">${open ? 'свернуть' : 'развернуть'}<i aria-hidden="true">${open ? '▴' : '▾'}</i></span></button>`;
    h += `<div class="lf-fg-body"${open ? '' : ' hidden'}>`;
    h += `<p class="lf-fg-thesis">${esc(F.thesis)}</p>`;
    if (F.analogy) h += `<p class="lf-fg-an"><b>Как в жизни.</b> ${esc(F.analogy)}</p>`;
    if (pic) h += `<figure class="lf-fg-pic${on != null ? ' lf-fg-has' : ''}">${pic}<figcaption class="lf-fg-cap" aria-live="polite">${capOf(F, on)}</figcaption></figure>`;
    if (map.length) {
      h += `<ul class="lf-fg-map" aria-label="Предмет из жизни и термин">`;
      map.forEach((m, i) => { h += `<li><button type="button" class="lf-fg-pair${on === i ? ' lf-fg-on' : ''}" data-lf-k="${i}" aria-pressed="${on === i}"><span class="lf-fg-a">${esc(m[0])}</span><span class="lf-fg-eq" aria-hidden="true">↔</span><span class="lf-fg-t">${esc(m[1])}</span>${m[2] ? `<small>${esc(m[2])}</small>` : ''}</button></li>`; });
      h += '</ul>';
    }
    h += '</div></section>';
    if (on != null) later();
    return h;
  }

  /* ---------- подсветка пары: класс на предметах картинки и на строке списка ---------- */
  function paint(sec) {
    if (!sec) return;
    const a = ST.hov != null ? ST.hov : ST.pin;
    sec.querySelectorAll('[data-lf-k]').forEach(el => {
      const yes = a != null && +el.getAttribute('data-lf-k') === a;
      el.classList.toggle('lf-fg-on', yes);
      if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(ST.pin != null && +el.getAttribute('data-lf-k') === ST.pin));
    });
    const fig = sec.querySelector('.lf-fg-pic'); if (fig) fig.classList.toggle('lf-fg-has', a != null);
    const cap = sec.querySelector('.lf-fg-cap'); if (cap) cap.innerHTML = capOf(FS[sec.getAttribute('data-lf-card')] || ST.F, a);
  }
  let queued = false;
  function later() {
    if (queued || !HAS_DOM) return;
    queued = true;
    (window.queueMicrotask || (f => Promise.resolve().then(f)))(() => { queued = false; document.querySelectorAll('.lf-fg').forEach(paint); });
  }
  function setOpen(sec, open) {
    const k = sec.getAttribute('data-lf-card');
    if (open) delete U.closed[k]; else U.closed[k] = true;
    save();
    sec.classList.toggle('lf-fg-closed', !open);
    const b = sec.querySelector('.lf-fg-body'); if (b) b.hidden = !open;
    const t = sec.querySelector('[data-lf-toggle]');
    if (t) { t.setAttribute('aria-expanded', String(open)); const ch = t.querySelector('.lf-fg-chev'); if (ch) ch.innerHTML = `${open ? 'свернуть' : 'развернуть'}<i aria-hidden="true">${open ? '▴' : '▾'}</i>`; }
  }

  if (HAS_DOM) {
    document.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('.lf-fg [data-lf-toggle], .lf-fg [data-lf-k]');
      if (!t) return;
      const sec = t.closest('.lf-fg');
      if (t.hasAttribute('data-lf-toggle')) { setOpen(sec, sec.classList.contains('lf-fg-closed')); return; }
      const i = +t.getAttribute('data-lf-k');
      ST.pin = ST.pin === i ? null : i;
      ST.hov = null;
      paint(sec);
    });
    const hover = (e, leave) => {
      const t = e.target.closest && e.target.closest('.lf-fg [data-lf-k]');
      const sec = e.target.closest && e.target.closest('.lf-fg');
      if (!sec) return;
      if (leave) {
        const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.lf-fg [data-lf-k]') : null;
        if (to && t && to.getAttribute('data-lf-k') === t.getAttribute('data-lf-k')) return;
        if (ST.hov == null) return;
        ST.hov = to ? +to.getAttribute('data-lf-k') : null;
      } else {
        if (!t) return;
        const i = +t.getAttribute('data-lf-k');
        if (ST.hov === i) return;
        ST.hov = i;
      }
      paint(sec);
    };
    document.addEventListener('mouseover', e => hover(e, false));
    document.addEventListener('mouseout', e => hover(e, true));
    document.addEventListener('focusin', e => hover(e, false));
    document.addEventListener('focusout', e => hover(e, true));
  }

  /* развернуть и показать карточку текущего уровня — для Ctrl+K */
  function show() {
    const A = SD.app && SD.app.A, L = A && A.level;
    if (!has(L)) return;
    delete U.closed[baseId(L)]; save();
    const tb = document.getElementById('tabTask'); if (tb) tb.click();
    if (SD.panels && A.tab === 'task') SD.panels.task(A);
    requestAnimationFrame(() => { const s = document.querySelector('#paneTask .lf-fg'); if (s) { setOpen(s, true); s.scrollIntoView({ block: 'start', behavior: 'smooth' }); } });
  }
  (SD.cmdExtra = SD.cmdExtra || []).push((add, S) => {
    const L = S && S.level; if (!has(L)) return;
    const F = fingersOf(L);
    add('Уровень', `На пальцах: ${F.title || L.title}`, 'тезис, аналогия и картинка «предмет ↔ термин»', show, 'на пальцах аналогия объяснение простыми словами ' + (F.map || []).map(m => m[0] + ' ' + m[1]).join(' '));
  });

  SD.fingers = { card, has, of: fingersOf, show, state: () => ({ key: ST.key, pin: ST.pin, closed: Object.assign({}, U.closed) }) };
})();
