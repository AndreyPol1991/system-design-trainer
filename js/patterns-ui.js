/* Раздел «Паттерны»: каталог с карточками и тренировка. */
(function () {
  const KEY = 'amp-stroyka-patterns-v1';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const S = { seen: [], best: 0 };
  const V = { mode: 'catalog', cat: 'all', q: '', open: null, quiz: null, score: 0, total: 0, streak: 0, qmode: 'pattern' };
  const load = () => { try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* без хранилища */ } };
  const byId = id => SD.PATTERNS.find(p => p.id === id);
  const catLabel = id => (SD.PATTERN_CATS.find(c => c.id === id) || { label: id }).label;
  const kindLabel = k => ({ principle: 'принцип', pattern: 'паттерн', anti: 'антипаттерн' }[k]);
  let body;

  let sample = null, eli = null;
  async function eli5(id) {
    const p = byId(id), box = document.getElementById('patEli5');
    if (!p || !box || !sample || eli) return;
    const sim = SD.SIMPLE && SD.SIMPLE[id];
    box.hidden = false; box.innerHTML = '<span class="eyebrow">Ещё проще · Claude</span><span class="an">Думаю, как объяснить…</span>';
    const out = box.querySelector('.an');
    eli = new AbortController();
    const prompt = `Объясни ${p.kind === 'anti' ? 'антипаттерн' : 'паттерн или принцип'} «${p.name}» (${p.en || ''}) человеку, который никогда не программировал. Суть: ${p.kind === 'anti' ? p.why : p.solution}\nПравила: 3–4 коротких предложения, без терминов и английских слов; одна новая бытовая аналогия${sim ? ` (не повторяй эту: «${sim[1]}»)` : ''}; в конце одно предложение «В программе это значит: …» простыми словами. Пиши по-русски, без вступлений и без списков.`;
    try {
      const { text } = await sample(prompt, { modelTier: 'quick', cache: true, signal: eli.signal, onText: ({ text }) => { out.textContent = text; } });
      out.textContent = text;
    } catch (e) {
      if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) sample = null;
      out.textContent = e && e.code === 'cancelled' ? '' : 'Claude сейчас недоступен. Аналогия выше — тоже простое объяснение.';
    }
    eli = null;
  }
  function mount() {
    (async () => { try { sample = window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch (e) { sample = null; } })();
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'patModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="patTitle" style="height: min(860px, calc(100vh - 32px));">
      <div class="sheet-head"><h2 id="patTitle">Паттерны и принципы</h2>
        <div class="seg" role="tablist"><button type="button" data-pm="catalog" aria-selected="true">Каталог</button><button type="button" data-pm="train" aria-selected="false">Тренировка</button></div>
        <button class="btn ghost x" type="button" data-close>Закрыть</button></div>
      <div class="sheet-body" id="patBody"></div></div>`;
    document.body.appendChild(m);
    body = m.querySelector('#patBody');
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; return; }
      const t = e.target.closest('[data-pm],[data-pcat],[data-pid],[data-pback],[data-pdive],[data-plevel],[data-qmode],[data-qa],[data-qnext],[data-pprin],[data-peli]');
      if (!t) return;
      if (t.dataset.pm) { V.mode = t.dataset.pm; V.open = null; m.querySelectorAll('[data-pm]').forEach(b => b.setAttribute('aria-selected', b.dataset.pm === V.mode ? 'true' : 'false')); if (V.mode === 'train' && !V.quiz) nextQuiz(); render(); }
      if (t.dataset.pcat) { V.cat = t.dataset.pcat; render(); }
      if (t.dataset.pid) { openCard(t.dataset.pid); }
      if (t.hasAttribute('data-pback')) { V.open = null; render(); }
      if (t.dataset.pdive && SD.player) SD.player.open(t.dataset.pdive);
      if (t.dataset.pprin && SD.principles) SD.principles.open(t.dataset.pprin);
      if (t.dataset.peli) eli5(t.dataset.peli);
      if (t.dataset.plevel && SD.app) { const L = SD.levelById(t.dataset.plevel); if (L) { m.hidden = true; SD.app.loadLevel(L); } }
      if (t.dataset.qmode) { V.qmode = t.dataset.qmode; nextQuiz(); render(); }
      if (t.dataset.qa) answer(t.dataset.qa);
      if (t.hasAttribute('data-qnext')) { nextQuiz(); render(); }
    });
    m.addEventListener('input', e => { if (e.target.id === 'patSearch') { V.q = e.target.value.trim().toLowerCase(); renderList(); } });
  }

  function open(id) {
    load();
    document.getElementById('patModal').hidden = false;
    if (id) openCard(id); else render();
  }
  function openCard(id) {
    V.mode = 'catalog'; V.open = id;
    if (!S.seen.includes(id)) { S.seen.push(id); save(); }
    document.querySelectorAll('#patModal [data-pm]').forEach(b => b.setAttribute('aria-selected', b.dataset.pm === 'catalog' ? 'true' : 'false'));
    render();
    body.scrollTop = 0;
  }

  function render() {
    if (V.mode === 'train') { body.innerHTML = trainView(); return; }
    if (V.open) { body.innerHTML = cardView(byId(V.open)); return; }
    const total = SD.PATTERNS.length, seen = S.seen.filter(id => byId(id)).length;
    body.innerHTML = `<div class="pat-top"><input id="patSearch" type="search" placeholder="Поиск: retry, сага, God object…" value="${esc(V.q)}" aria-label="Поиск паттерна">
      <div class="pat-prog"><span>Изучено ${seen} из ${total}</span><i><b style="width:${Math.round(seen / total * 100)}%"></b></i></div></div>
      <div class="pat-cats"><button type="button" class="chip-btn ${V.cat === 'all' ? 'on' : ''}" data-pcat="all">Все · ${total}</button>${SD.PATTERN_CATS.map(c => { const n = SD.PATTERNS.filter(p => p.cat === c.id).length; return `<button type="button" class="chip-btn ${V.cat === c.id ? 'on' : ''} ${c.id.startsWith('anti') ? 'anti' : ''}" data-pcat="${c.id}">${esc(c.label)} · ${n}</button>`; }).join('')}</div>
      <div class="pat-grid" id="patGrid"></div>`;
    renderList();
  }
  function renderList() {
    const g = document.getElementById('patGrid'); if (!g) return;
    const list = SD.PATTERNS.filter(p => (V.cat === 'all' || p.cat === V.cat) && (!V.q || (p.name + ' ' + (p.en || '') + ' ' + p.problem).toLowerCase().includes(V.q)));
    g.innerHTML = list.map(p => `<button type="button" class="pat-card ${p.kind}" data-pid="${p.id}"><span class="pk">${kindLabel(p.kind)}${S.seen.includes(p.id) ? ' · ✓' : ''}${SD.principleForPattern && SD.principleForPattern(p.id) ? '<span class="live">▶ вживую</span>' : ''}</span><b>${esc(p.name)}</b><small class="en">${esc(p.en || '')}</small><small>${esc(p.problem.split('. ')[0].replace(/\.$/, ''))}.</small></button>`).join('') || '<p class="empty">Ничего не нашлось.</p>';
  }

  function codeBlock(src, lang) {
    return `<pre class="code pat-code">${src.split('\n').map((l, k) => `<span class="ln" data-n="${k + 1}">${SD.player.highlight(l, lang) || ' '}</span>`).join('')}</pre>`;
  }
  function langOf(code) { return code.lang || (/^\s*(ALTER|UPDATE|SELECT|CREATE)/m.test(code.after || code.before || '') ? 'sql' : 'js'); }
  function cardView(p) {
    if (!p) return '';
    const anti = p.kind === 'anti';
    let h = `<button type="button" class="btn ghost" data-pback>← Каталог</button>
      <div class="pat-head"><span class="pk ${p.kind}">${kindLabel(p.kind)} · ${esc(catLabel(p.cat))}</span><h3>${esc(p.name)}</h3><small>${esc(p.en || '')}</small></div>
      <div class="pat-cols"><div><h4>${anti ? 'Что это' : 'Проблема'}</h4><p>${esc(p.problem)}</p></div>
      <div><h4>${anti ? 'Чем плохо' : 'Решение'}</h4><p>${esc(anti ? p.why : p.solution)}</p>${anti && p.fix ? `<h4>Как лечить</h4><p>${esc(p.fix)}</p>` : ''}</div></div>`;
    const live = SD.principleForPattern && SD.principleForPattern(p.id);
    if (live) h += `<button type="button" class="dive-cta" data-pprin="${live.id}">${SD.icon('app')}<span><b>Попробовать вживую</b><small>${esc(live.change.title)}: найди все места правки, выбери рефакторинг и сравни цену изменения до и после.</small></span></button>`;
    const sim = SD.SIMPLE && SD.SIMPLE[p.id];
    if (sim) h = h.replace('<div class="pat-cols">', `<div class="simple"><span class="eyebrow">Простыми словами</span><span class="an">${esc(sim[1])}</span><span class="pl">${esc(sim[0])}</span>${sample ? `<span><button type="button" class="linkish" data-peli="${p.id}">Объясни ещё проще</button></span>` : ''}</div><div class="simple sm" id="patEli5" hidden></div><div class="pat-cols">`);
    if (p.quiz) h += `<div class="pat-sym"><b>Как узнать в жизни</b>${esc(p.quiz)}</div>`;
    if (p.code) {
      const lang = langOf(p.code);
      if (p.code.before && p.code.after) h += `<div class="code-pair"><div><h4 class="bad">${anti ? 'Антипаттерн' : 'Было'}</h4>${codeBlock(p.code.before, lang)}</div><div><h4 class="ok">${anti ? 'Исправлено' : 'Стало'}</h4>${codeBlock(p.code.after, lang)}</div></div>`;
      else h += `<h4>Пример</h4>${codeBlock(p.code.after || p.code.before, lang)}`;
    }
    const rel = [...(p.related || []), ...(p.fixIds || [])].map(byId).filter(Boolean);
    if (rel.length) h += `<h4>Связано</h4><div class="pat-rel">${rel.map(r => `<button type="button" class="chip-btn ${r.kind === 'anti' ? 'anti' : ''}" data-pid="${r.id}">${esc(r.name)}</button>`).join('')}</div>`;
    const acts = [];
    if (p.dive && SD.DIVES[p.dive]) acts.push(`<button type="button" class="btn" data-pdive="${p.dive}">Разбор: ${esc(SD.DIVES[p.dive].title)}</button>`);
    const inn = (SD.INNER || []).find(l => l.pattern === p.id);
    if (inn) acts.push(`<button type="button" class="btn" data-plevel="${inn.id}">Внутри сервиса: ${esc(inn.title)}</button>`);
    const pr = (SD.PRACTICE || []).find(l => l.pattern === p.id);
    if (pr) acts.push(`<button type="button" class="btn primary" data-plevel="${pr.id}">Практикум: применить паттерн</button>`);
    if (p.level) { const L = SD.LEVELS.find(l => l.id === p.level); if (L) acts.push(`<button type="button" class="btn ${pr ? '' : 'primary'}" data-plevel="${L.id}">Уровень ${SD.LEVELS.indexOf(L) + 1}: ${esc(L.title)}</button>`); }
    if (acts.length) h += `<div class="row-btns">${acts.join('')}</div>`;
    return h;
  }

  /* ---------- тренировка ---------- */
  function pool(mode) {
    if (mode === 'anti') return SD.PATTERNS.filter(p => p.kind === 'anti' && p.quiz);
    if (mode === 'code') return SD.PATTERNS.filter(p => p.code && p.code.before && p.quiz);
    if (mode === 'simple') return SD.PATTERNS.filter(p => SD.SIMPLE && SD.SIMPLE[p.id]);
    return SD.PATTERNS.filter(p => p.kind !== 'anti' && p.quiz);
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function nextQuiz() {
    const list = pool(V.qmode);
    const p = list[Math.floor(Math.random() * list.length)];
    const same = SD.PATTERNS.filter(x => x.id !== p.id && x.kind === p.kind && x.cat === p.cat);
    const other = SD.PATTERNS.filter(x => x.id !== p.id && x.kind === p.kind && x.cat !== p.cat);
    const s = shuffle(same), o = shuffle(other);
    const distract = s.slice(0, 2).concat(o.slice(0, 1));
    for (const x of s.slice(2).concat(o.slice(1))) { if (distract.length >= 3) break; distract.push(x); }
    V.quiz = { id: p.id, opts: shuffle([p, ...distract]).map(x => x.id), picked: null };
  }
  function answer(id) {
    const q = V.quiz; if (!q || q.picked) return;
    q.picked = id; V.total++;
    if (id === q.id) { V.score++; V.streak++; if (V.streak > S.best) { S.best = V.streak; } } else V.streak = 0;
    if (!S.seen.includes(q.id)) S.seen.push(q.id);
    save(); render();
  }
  function trainView() {
    const q = V.quiz; if (!q) return '';
    const p = byId(q.id);
    const modes = [['simple', 'По аналогии'], ['pattern', 'Узнай паттерн'], ['anti', 'Найди антипаттерн'], ['code', 'Код: что не так?']];
    let h = `<div class="train-top"><div class="seg">${modes.map(([k, l]) => `<button type="button" data-qmode="${k}" aria-selected="${V.qmode === k}">${l}</button>`).join('')}</div>
      <div class="train-score"><span>Верно <b>${V.score}</b> из ${V.total}</span><span>Серия <b>${V.streak}</b></span><span>Рекорд <b>${S.best}</b></span></div></div>`;
    h += `<div class="quiz-card"><span class="eyebrow">${V.qmode === 'code' ? 'Посмотри на код' : V.qmode === 'simple' ? 'Аналогия из жизни' : 'Ситуация'}</span>`;
    if (V.qmode === 'simple') h += `<p class="qs">${esc(SD.SIMPLE[p.id][1])}</p><p class="qq">Какой ${p.kind === 'anti' ? 'антипаттерн' : 'паттерн или принцип'} так выглядит в жизни?</p>`;
    else if (V.qmode === 'code') h += codeBlock(p.code.before, langOf(p.code)) + `<p class="qq">${p.kind === 'anti' ? 'Какой это антипаттерн?' : 'Какой принцип или паттерн здесь нарушен и поможет?'}</p>`;
    else h += `<p class="qs">${esc(p.quiz)}</p><p class="qq">${V.qmode === 'anti' ? 'Как называется эта проблема?' : 'Какой паттерн или принцип решает это?'}</p>`;
    h += `<div class="opts">${q.opts.map(id => { const o = byId(id); const cls = q.picked ? (id === q.id ? 'right' : id === q.picked ? 'wrong' : '') : ''; return `<button type="button" class="opt ${cls}" data-qa="${id}" ${q.picked ? 'disabled' : ''}><b>${esc(o.name)}</b><small>${esc(o.en || '')}</small></button>`; }).join('')}</div>`;
    if (q.picked) {
      const ok = q.picked === q.id;
      h += `<div class="qfb ${ok ? 'ok' : 'bad'}"><b>${ok ? 'Верно.' : 'Не совсем. Правильно: ' + esc(p.name) + '.'}</b> ${V.qmode === 'simple' && SD.SIMPLE[p.id] ? esc(SD.SIMPLE[p.id][0]) + ' ' : ''}${esc(p.kind === 'anti' ? p.why + ' Лечение: ' + p.fix : p.solution)}</div>
        <div class="row-btns"><button type="button" class="btn primary" data-qnext>Следующий вопрос →</button><button type="button" class="btn" data-pid="${p.id}">Открыть карточку</button></div>`;
    }
    return h + `</div>`;
  }

  SD.patterns = { open, mount };
})();
