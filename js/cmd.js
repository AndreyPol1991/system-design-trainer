/* Быстрые команды: Ctrl+K — поиск по уровням, паттернам, разборам, узлам и действиям;
   Ctrl+Z / Ctrl+Shift+Z — отмена и возврат правок схемы; настройки вида: меньше анимации, крупный текст в сценах. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const A = () => (SD.app && SD.app.A) || null;
  const T = () => SD.TYPES;
  const nm = n => n ? (n.label || T()[n.type].name) : '';
  const toast = t => SD.app && SD.app.toast(t);

  /* ---------- настройки вида ---------- */
  const KEY = 'amp-stroyka-prefs-v1';
  let P = {};
  try { P = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { P = {}; }
  const saveP = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* без хранилища */ } };
  const calm = () => P.calm !== undefined ? P.calm : !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  function applyPrefs() {
    document.documentElement.classList.toggle('calm', calm());
    document.documentElement.classList.toggle('big-text', !!P.big);
    scaleText();
    document.querySelectorAll('[data-pref]').forEach(b => { const on = b.dataset.pref === 'calm' ? calm() : !!P.big; b.setAttribute('aria-pressed', String(on)); b.querySelector('.ck').textContent = on ? '✓' : ''; });
  }
  function setPref(k, v) { P[k] = v; saveP(); applyPrefs(); toast(k === 'calm' ? (v ? 'Меньше анимации: мигание и плавные переходы выключены.' : 'Анимация снова включена.') : (v ? 'Крупный текст в сценах «изнутри»: подписи не меньше 12 px.' : 'Обычный текст в сценах: подписи не меньше 10 px.')); }
  /* подписи в сценах «изнутри»: SVG сжимается под окно, поэтому держим минимум с поправкой на масштаб */
  function scaleText() {
    const svg = $('xrSvg'); if (!svg) return;
    const m = svg.getScreenCTM && svg.getScreenCTM(), k = m && m.a > 0.05 ? m.a : 1;
    svg.style.setProperty('--sc', k.toFixed(3));
    svg.style.setProperty('--fsmin', (P.big ? 12 : 10) + 'px');
  }

  /* ---------- отмена: снимки схемы ---------- */
  const H = { lv: null, stable: '', undo: [], redo: [], down: false };
  const sigOf = g => JSON.stringify({ nodes: g.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, props: n.props, label: n.label })), edges: g.edges.map(e => ({ id: e.id, from: e.from, to: e.to, props: e.props })) });
  function track() {
    const S = A(); if (!S || !S.graph) return;
    if (S.level.id !== H.lv) { H.lv = S.level.id; H.undo = []; H.redo = []; H.stable = sigOf(S.graph); return; }
    if (H.down || (SD.walk && SD.walk.active())) return;
    const s = sigOf(S.graph);
    if (s !== H.stable) { H.undo.push(H.stable); if (H.undo.length > 60) H.undo.shift(); H.redo = []; H.stable = s; }
  }
  function describe(from, to) {
    const a = JSON.parse(from), b = JSON.parse(to), out = [];
    const gone = a.nodes.filter(n => !b.nodes.some(x => x.id === n.id)), back = b.nodes.filter(n => !a.nodes.some(x => x.id === n.id));
    if (gone.length) out.push('убран ' + gone.map(n => `«${nm(n)}»`).join(', '));
    if (back.length) out.push('вернулся ' + back.map(n => `«${nm(n)}»`).join(', '));
    const ek = g => new Set(g.edges.map(e => e.from + '>' + e.to));
    const ea = ek(a), eb = ek(b), eGone = [...ea].filter(x => !eb.has(x)).length, eBack = [...eb].filter(x => !ea.has(x)).length;
    if (eGone || eBack) out.push(`связи: ${eGone ? '−' + eGone : ''}${eGone && eBack ? ' ' : ''}${eBack ? '+' + eBack : ''}`);
    const pr = b.nodes.filter(n => { const x = a.nodes.find(y => y.id === n.id); return x && JSON.stringify(x.props) !== JSON.stringify(n.props); });
    if (pr.length) out.push('настройки ' + pr.map(n => `«${nm(n)}»`).join(', '));
    const ep = b.edges.filter(e => { const x = a.edges.find(y => y.id === e.id); return x && JSON.stringify(x.props) !== JSON.stringify(e.props); });
    if (ep.length) out.push('настройки связей: ' + ep.length);
    if (!out.length) out.push('расположение узлов');
    return out.join('; ');
  }
  function restore(s) {
    const S = A(), g = JSON.parse(s);
    if (SD.inner) g.nodes.forEach(n => SD.inner.syncFlags(n, g));
    S.graph = g; S.down = {}; S.sel = null; S.pending = null;
    SD.editor.setGraph(g); SD.app.recompute(true);
    H.stable = sigOf(S.graph);
  }
  function undo() {
    track();
    if (!H.undo.length) { toast('Отменять нечего: схема как в начале уровня или после загрузки.'); return; }
    const prev = H.undo.pop(); H.redo.push(H.stable);
    toast(`Отменено: ${describe(H.stable, prev)}. Вернуть — Ctrl+Shift+Z.`);
    restore(prev);
  }
  function redo() {
    track();
    if (!H.redo.length) { toast('Возвращать нечего.'); return; }
    const nx = H.redo.pop(); H.undo.push(H.stable);
    toast(`Вернул: ${describe(H.stable, nx)}.`);
    restore(nx);
  }

  /* ---------- Ctrl+K ---------- */
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const click = id => () => { const b = $(id); if (b) b.click(); };
  function items() {
    const S = A(), out = [];
    const add = (g, t, s, run, kw) => out.push({ g, t, s: s || '', run, k: norm(t + ' ' + (s || '') + ' ' + (kw || '')) });
    /* действия */
    add('Действие', 'Проверить решение', 'все цели уровня', click('checkBtn'), 'check');
    if (SD.walk) add('Действие', 'Эталон по шагам', 'собрать решение по одному узлу', () => SD.walk.start(), 'решение ответ');
    add('Действие', 'Показать эталон целиком', 'заменит схему', click('solBtn'), 'решение ответ');
    add('Действие', 'Отменить', 'Ctrl+Z', undo, 'undo назад');
    add('Действие', 'Вернуть отменённое', 'Ctrl+Shift+Z', redo, 'redo');
    add('Действие', 'Начать уровень заново', 'вернуть стартовую схему', click('clearBtn'), 'сброс очистить');
    add('Действие', 'Уронить случайный узел', 'проверка на отказ', click('chaosBtn'), 'хаос chaos');
    add('Действие', 'Волна нагрузки', 'пик и спад за 13 секунд', click('waveBtn'), 'нагрузка пик');
    add('Действие', 'Пауза / пуск потока запросов', 'точки на стрелках', click('runBtn'), 'стоп');
    add('Открыть', 'Карта уровней', 'все уровни и треки', click('navLevels'), 'уровни');
    add('Открыть', 'Практика паттернов', '', click('navHub'), 'хаб');
    add('Открыть', 'Собеседование', 'задача на время', click('navInt'), 'интервью');
    add('Открыть', 'Паттерны', 'каталог', click('navPat'), 'pattern');
    add('Открыть', 'Справочник', 'разборы и лаборатории', click('navLib'), 'библиотека');
    if ($('navLand')) add('Открыть', 'Ландшафт', 'CI/CD, Kubernetes, наблюдаемость, данные', click('navLand'), 'devops grafana');
    add('Открыть', 'Песочница', 'свободная сборка без целей', click('navSandbox'), 'sandbox');
    if (SD.labs) add('Открыть', 'Таблица вживую', 'типы, вес, партиции, шарды, решардинг, путь запроса', () => SD.labs.open('table'), 'лаборатория users партиционирование шардирование');
    if (SD.calc) add('Открыть', 'Как посчитать нагрузку уровня', 'от пользователей до серверов, кэша, реплик и шардов', () => SD.calc.open(), 'расчёт салфетка оценка rps');
    if (SD.share) add('Действие', 'Поделиться схемой и экспорт', 'ссылка со схемой, Mermaid, C4 для PlantUML', () => SD.share.open(), 'ссылка экспорт mermaid plantuml c4 документация');
    if (SD.trace) add('Действие', 'Проследить запрос', 'один запрос под лупой: путь, время в каждом узле', () => SD.trace.open(), 'трассировка трейс jaeger путь');
    if (SD.path) add('Открыть', 'Мой путь: карта навыков', 'роли, освоенные навыки, следующий шаг', () => SD.path.open(), 'прогресс роль навыки аналитик devops');
    if (SD.free) add('Открыть', 'Свободный режим', 'кейс без эталона и подсказок — оценка любой схемы', () => SD.free.picker(), 'песочница кейс оценка решения');
    if (SD.daily) add('Открыть', 'Событие дня', 'эталон уровня под новым испытанием', () => SD.daily.open(), 'daily челлендж');
    add('Открыть', 'Экскурсия по интерфейсу', 'Арчи покажет, что где', click('navTour'), 'тур помощь');
    add('Вид', 'Сменить тему', 'светлая / тёмная', click('themeBtn'), 'theme');
    add('Вид', `Меньше анимации: ${calm() ? 'выключить' : 'включить'}`, 'без мигания и плавных переходов', () => setPref('calm', !calm()), 'motion');
    add('Вид', `Крупный текст в сценах: ${P.big ? 'выключить' : 'включить'}`, 'подписи «изнутри» не меньше 12 px', () => setPref('big', !P.big), 'шрифт размер');
    if ($('palTg')) add('Вид', 'Свернуть / развернуть палитру', '', click('palTg'));
    if ($('sideTg')) add('Вид', 'Спрятать / показать правую панель', '', click('sideTg'));
    if (SD.editor.setLayer) [['all', 'Все слои'], ['product', 'Только продукт'], ['obs', 'Наблюдаемость'], ['platform', 'Платформа'], ['data', 'Данные']].forEach(([k, t]) => add('Вид', `Слой: ${t}`, 'что видно на схеме', () => SD.editor.setLayer(k), 'layer'));
    if (SD.ux && SD.ux.resetCoach) add('Вид', 'Показать подсказки новичку заново', 'шаг 1 → 2 → 3 на холсте', () => { SD.ux.resetCoach(); toast('Подсказки на холсте снова включены.'); }, 'coach');
    if (!S) return out;
    /* узлы на схеме */
    S.graph.nodes.filter(n => n.type !== 'client').forEach(n => {
      add('На схеме', `«${nm(n)}»`, 'выбрать и открыть настройки', () => SD.editor.select({ type: 'node', id: n.id }), T()[n.type].name);
      if (SD.xray && SD.xray.has(n.type)) add('На схеме', `Провалиться внутрь: «${nm(n)}»`, 'как он устроен и работает', () => SD.xray.open(n.id), 'xray изнутри');
    });
    /* поставить деталь */
    const allow = new Set(S.level.allow || []);
    Object.entries(T()).forEach(([k, t]) => {
      if (k === 'client' || !(allow.has(k) || t.ops)) return;
      add('Поставить', t.name, t.short, () => {
        const xs = S.graph.nodes.map(n => n.x), ys = S.graph.nodes.map(n => n.y);
        const x = xs.length ? Math.max(...xs) + 240 : 300, y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 250;
        SD.editor.addNode(k, x, y); requestAnimationFrame(() => SD.editor.fit());
      }, 'добавить узел ' + k);
    });
    /* уровни */
    const lists = [SD.LEVELS, SD.PRACTICE, SD.FIXES, SD.INNER, SD.KNOBS, SD.ARCHL, SD.OPSL];
    lists.forEach(list => (list || []).forEach(L => {
      const i = SD.LEVELS.indexOf(L), st = (S.progress[L.id] || {}).stars || 0;
      add('Уровень', L.title, `${i >= 0 ? 'уровень ' + (i + 1) : SD.levelLabel(L)}${st ? ' · ' + '★'.repeat(st) : ''}`, () => { closeModals(); SD.app.loadLevel(L); }, (L.chips || []).join(' '));
    }));
    /* паттерны и разборы */
    (SD.PATTERNS || []).forEach(p => add('Паттерн', p.name, p.en || '', () => SD.patterns.open(p.id), p.problem));
    Object.entries(SD.DIVES || {}).forEach(([id, d]) => add('Разбор', d.title, 'как это работает', () => SD.player.open(id), d.lede));
    return out;
  }
  function closeModals() {
    if (SD.xray && $('xrModal') && !$('xrModal').hidden) SD.xray.close();
    if (SD.landscape && $('lsModal') && !$('lsModal').hidden) SD.landscape.close();
    document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
  }
  const GORDER = ['Действие', 'На схеме', 'Поставить', 'Уровень', 'Паттерн', 'Разбор', 'Открыть', 'Вид'];
  let K = null;
  function search(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return K.all.filter(x => x.g === 'Действие' || x.g === 'На схеме').slice(0, 12);
    const hits = K.all.map(x => {
      if (!words.every(w => x.k.includes(w))) return null;
      const t = norm(x.t);
      let sc = GORDER.indexOf(x.g) * 2;
      if (t.startsWith(words[0])) sc -= 6; else if (t.includes(words[0])) sc -= 3;
      return { x, sc };
    }).filter(Boolean).sort((a, b) => a.sc - b.sc).slice(0, 40);
    /* группа целиком, выше — та, где лучшее совпадение */
    const best = {}; hits.forEach(r => { if (best[r.x.g] === undefined) best[r.x.g] = r.sc; });
    return hits.sort((a, b) => best[a.x.g] - best[b.x.g] || a.sc - b.sc).map(r => r.x);
  }
  function render() {
    const list = $('cmdkList'); K.res = search($('cmdkIn').value); K.i = Math.min(K.i, Math.max(0, K.res.length - 1));
    let h = '', g = '';
    K.res.forEach((x, i) => {
      if (x.g !== g) { g = x.g; h += `<li class="cmdk-g" role="presentation">${esc(g)}</li>`; }
      h += `<li role="option" id="cmdk-${i}" class="cmdk-it ${i === K.i ? 'on' : ''}" aria-selected="${i === K.i}" data-ci="${i}"><b>${esc(x.t)}</b>${x.s ? `<small>${esc(x.s)}</small>` : ''}</li>`;
    });
    list.innerHTML = h || '<li class="cmdk-none">Ничего не нашёл. Попробуй по-другому: «кэш», «уровень 5», «retry», «тема».</li>';
    $('cmdkIn').setAttribute('aria-activedescendant', K.res.length ? 'cmdk-' + K.i : '');
    const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function openK() {
    let m = $('cmdk');
    if (!m) {
      m = document.createElement('div'); m.id = 'cmdk'; m.className = 'cmdk'; m.hidden = true;
      m.innerHTML = `<div class="cmdk-box" role="dialog" aria-label="Поиск и команды"><input id="cmdkIn" type="text" autocomplete="off" spellcheck="false" placeholder="Уровень, паттерн, узел, действие…" role="combobox" aria-controls="cmdkList" aria-expanded="true"><ul id="cmdkList" role="listbox"></ul><div class="cmdk-f"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span></div></div>`;
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m) closeK(); const it = e.target.closest('[data-ci]'); if (it) runK(+it.dataset.ci); });
      m.addEventListener('mousemove', e => { const it = e.target.closest('[data-ci]'); if (it && +it.dataset.ci !== K.i) { K.i = +it.dataset.ci; render(); } });
      $('cmdkIn').addEventListener('input', () => { K.i = 0; render(); });
      $('cmdkIn').addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); K.i = Math.min(K.res.length - 1, K.i + 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); K.i = Math.max(0, K.i - 1); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); runK(K.i); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeK(); }
      });
    }
    K = { all: items(), res: [], i: 0, back: document.activeElement };
    $('cmdkIn').value = ''; m.hidden = false; render(); $('cmdkIn').focus();
  }
  function closeK() { const m = $('cmdk'); if (m) m.hidden = true; if (K && K.back && K.back.focus) try { K.back.focus(); } catch (e) { /* нечего фокусировать */ } }
  function runK(i) { const x = K && K.res[i]; if (!x) return; closeK(); setTimeout(() => x.run(), 0); }

  /* ---------- кнопки ---------- */
  function buttons() {
    const nav = document.querySelector('.topbar .nav'), th = $('themeBtn');
    if (nav && th && !$('cmdkBtn')) {
      const b = document.createElement('button'); b.type = 'button'; b.id = 'cmdkBtn'; b.className = 'nav-search'; b.title = 'Поиск и команды (Ctrl+K)';
      b.innerHTML = '<span aria-hidden="true">⌕</span> Поиск <kbd>Ctrl K</kbd>';
      b.addEventListener('click', openK);
      th.parentNode.insertBefore(b, th);
    }
    const menu = document.querySelector('.tb-menu');
    if (menu && !menu.querySelector('[data-cmd]')) {
      const mk = (txt, kbd, fn, attr) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost tbm-it'; b.setAttribute('data-cmd', '1'); if (attr) b.setAttribute('data-pref', attr); b.innerHTML = `${attr ? '<span class="ck" aria-hidden="true"></span>' : ''}<span>${txt}</span>${kbd ? `<kbd>${kbd}</kbd>` : ''}`; b.addEventListener('click', fn); return b; };
      const first = menu.firstChild;
      menu.insertBefore(mk('Отменить', 'Ctrl Z', undo), first);
      menu.insertBefore(mk('Вернуть', 'Ctrl ⇧ Z', redo), first);
      menu.appendChild(mk('Поиск и команды', 'Ctrl K', openK));
      menu.appendChild(mk('Меньше анимации', '', () => setPref('calm', !calm()), 'calm'));
      menu.appendChild(mk('Крупный текст в сценах', '', () => setPref('big', !P.big), 'big'));
    }
    applyPrefs();
  }

  function mount() {
    document.addEventListener('pointerdown', () => { H.down = true; }, true);
    document.addEventListener('pointerup', () => { H.down = false; setTimeout(track, 0); }, true);
    document.addEventListener('pointercancel', () => { H.down = false; }, true);
    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
      if (mod && (k === 'k' || k === 'л')) { e.preventDefault(); const m = $('cmdk'); if (m && !m.hidden) closeK(); else openK(); return; }
      if (!mod || (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) return;
      if ([...document.querySelectorAll('.modal')].some(m => !m.hidden) || (SD.walk && SD.walk.active())) return;
      if ((k === 'z' || k === 'я') && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (((k === 'z' || k === 'я') && e.shiftKey) || k === 'y' || k === 'н') { e.preventDefault(); redo(); }
    });
    setInterval(track, 300);
    setInterval(scaleText, 700);
    window.addEventListener('resize', scaleText);
    setTimeout(buttons, 0);
  }

  SD.cmd = { mount, open: openK, undo, redo, calm, setPref };
})();
