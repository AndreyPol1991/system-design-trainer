/* Хаб «Практика»: практикум паттернов, инциденты, лаборатория, тренировка, собеседование. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function mount() {
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'hubModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="hubTitle"><div class="sheet-head"><h2 id="hubTitle">Практика</h2><button class="btn ghost x" type="button" data-close>Закрыть</button></div><div class="sheet-body" id="hubBody"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; return; }
      const t = e.target.closest('[data-hlevel],[data-hlab],[data-htrain],[data-hint],[data-hprin]');
      if (!t) return;
      m.hidden = true;
      if (t.dataset.hlevel) SD.app.loadLevel(SD.levelById(t.dataset.hlevel));
      if (t.dataset.hlab) SD.labs.open(t.dataset.hlab);
      if (t.dataset.htrain) { SD.patterns.open(); const b = document.querySelector('#patModal [data-pm="train"]'); if (b) b.click(); }
      if (t.hasAttribute('data-hint') && SD.interview) SD.interview.open();
      if (t.dataset.hprin && SD.principles) SD.principles.open(t.dataset.hprin);
    });
  }
  function open() {
    const A = SD.app.A, labsDone = SD.labs.progress();
    const st = id => (A.progress[id] || {}).stars ? '✓' : '';
    const prDone = SD.principles ? SD.principles.progress() : {};
    let h = `<p class="lede">Здесь всё пробуешь руками: применяешь паттерны на площадке, чинишь больные системы, ставишь опыты в лаборатории. Симулятор проверяет результат.</p>`;
    if (SD.PRINCIPLES) h += `<h3>Принципы и паттерны вживую · ${SD.PRINCIPLES.filter(x => prDone[x.id]).length} из ${SD.PRINCIPLES.length}</h3><div class="hub-grid">${SD.PRINCIPLES.map(x => `<button type="button" class="lvl" data-hprin="${x.id}"><span class="n">${x.group === 'gof' ? 'ПАТТЕРН GoF' : 'ПРИНЦИП'}<span>${prDone[x.id] ? '✓' : ''}</span></span><b>${esc(x.title.split(':')[0])}</b><small>${esc((SD.SIMPLE && SD.SIMPLE[x.pat] || [x.lede])[1])}</small></button>`).join('')}</div>`;
    h += `<h3>Практикум паттернов · ${SD.PRACTICE.filter(l => st(l.id)).length} из ${SD.PRACTICE.length}</h3><div class="hub-grid">${SD.PRACTICE.map(l => `<button type="button" class="lvl" data-hlevel="${l.id}"><span class="n">ПАТТЕРН<span>${st(l.id)}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`).join('')}</div>`;
    h += `<h3>Найди и перестрой · ${SD.FIXES.filter(l => st(l.id)).length} из ${SD.FIXES.length}</h3><div class="hub-grid">${SD.FIXES.map(l => `<button type="button" class="lvl" data-hlevel="${l.id}"><span class="n">ИНЦИДЕНТ<span>${st(l.id)}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`).join('')}</div>`;
    const sec = (list, title, tag) => list && list.length ? `<h3>${title} · ${list.filter(l => st(l.id)).length} из ${list.length}</h3><div class="hub-grid">${list.map(l => `<button type="button" class="lvl" data-hlevel="${l.id}"><span class="n">${tag}<span>${st(l.id)}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`).join('')}</div>` : '';
    h += sec(SD.KNOBS, 'Настройки на пальцах', 'НАСТРОЙКА') + sec(SD.ARCHL, 'Архитектура из сервисов', 'АРХИТЕКТУРА') + sec(SD.OPSL || [], 'Эксплуатация и инструменты', 'ЭКСПЛУАТАЦИЯ');
    if (SD.INNER) h += `<h3>Внутри сервиса · ${SD.INNER.filter(l => st(l.id)).length} из ${SD.INNER.length}</h3><div class="hub-grid">${SD.INNER.map(l => `<button type="button" class="lvl" data-hlevel="${l.id}"><span class="n">КОМПОНЕНТЫ<span>${st(l.id)}</span></span><b>${esc(l.title)}</b><small>${esc(l.story.split('. ')[0])}.</small></button>`).join('')}</div>`;
    h += `<h3>Лаборатория: глубокие темы руками</h3><div class="hub-grid">${SD.LABS.map(l => { const d = (labsDone[l.id] || []).length; return `<button type="button" class="lvl" data-hlab="${l.id}"><span class="n">ОПЫТ<span>${d}/${l.tasks.length}</span></span><b>${esc(l.title)}</b><small>${esc(l.lede)}</small></button>`; }).join('')}</div>`;
    h += `<h3>Тренировка</h3><div class="hub-grid"><button type="button" class="lvl" data-htrain="1"><span class="n">ПАТТЕРНЫ</span><b>Узнай паттерн и антипаттерн</b><small>Ситуации и код: что здесь нарушено и что поможет.</small></button>${SD.interview ? `<button type="button" class="lvl" data-hint="1"><span class="n">СОБЕСЕДОВАНИЕ</span><b>Режим собеседования</b><small>Задача, этапы, таймер, интервьюер и оценка по рубрике.</small></button>` : ''}</div>`;
    document.getElementById('hubBody').innerHTML = h;
    document.getElementById('hubModal').hidden = false;
  }
  SD.hub = { mount, open };
})();
