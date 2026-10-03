/* Принципы вживую: найди все места правки → выбери рефакторинг → то же изменение снова → сравни цену. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = id => document.getElementById(id);
  const KEY = 'amp-stroyka-principles-v1';
  const ST = { done: {} };
  try { Object.assign(ST, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* без хранилища */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) { /* без хранилища */ } };
  const STEPS = ['Код', 'Изменение', 'Рефакторинг', 'Снова изменение', 'Итог'];
  const V = { id: null, step: 0, maxStep: 0, picks: new Set(), checked: false, choice: null, wrongs: [], res: [null, null] };

  const cur = () => SD.principleById(V.id);
  const ver = () => V.step >= 3 ? cur().after : cur().before;
  function metrics(v, tag) {
    let places = 0, files = 0, retest = 0;
    v.parsed.forEach(f => { const n = f.lines.filter(l => l.tags.includes(tag)).length; places += n; if (n) { files++; retest += f.lines.length; } });
    return { places, files, retest, deps: v.map.edges.length, nodes: v.map.nodes.length };
  }

  function mount() {
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'prModal'; m.hidden = true;
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="prTitle" style="height: min(920px, calc(100vh - 32px));">
      <div class="sheet-head"><span class="eyebrow" style="margin:0">Принципы и паттерны вживую</span><h2 id="prTitle">…</h2><button class="btn ghost x" type="button" data-close>Закрыть</button></div>
      <div class="lab-wrap"><nav class="lab-list" id="prList" aria-label="Принципы"></nav><div class="lab-main" id="prMain"></div></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.prline) { e.preventDefault(); e.target.click(); } });
  }
  function open(id) {
    const s = SD.principleById(id) || SD.PRINCIPLES.find(x => !ST.done[x.id]) || SD.PRINCIPLES[0];
    start(s.id);
    $('prModal').hidden = false;
  }
  function start(id) {
    Object.assign(V, { id, step: 0, maxStep: 0, picks: new Set(), checked: false, choice: null, wrongs: [], res: [null, null] });
    render();
    const mm = $('prMain'); if (mm) mm.scrollTop = 0;
  }
  function go(step) { V.step = step; V.maxStep = Math.max(V.maxStep, step); V.picks = new Set(); V.checked = false; if (step === 4) { ST.done[V.id] = true; save(); } render(); $('prMain').scrollTop = 0; }

  /* ---------- отрисовка ---------- */
  function render() {
    const s = cur(); if (!s) return;
    $('prTitle').textContent = s.title;
    const item = x => `<button type="button" class="lab-item ${x.id === s.id ? 'on' : ''}" data-prid="${x.id}"><b>${esc(x.title.split(':')[0])}</b><small>${esc((SD.SIMPLE && SD.SIMPLE[x.pat] || [x.lede])[0])}</small><span class="lab-prog">${ST.done[x.id] ? '✓' : ''}</span></button>`;
    $('prList').innerHTML = `<div class="pr-group">Принципы</div>${SD.PRINCIPLES.filter(x => x.group !== 'gof').map(item).join('')}<div class="pr-group">Паттерны GoF</div>${SD.PRINCIPLES.filter(x => x.group === 'gof').map(item).join('')}`;
    const pat = SD.PATTERNS.find(p => p.id === s.pat);
    const sim = SD.SIMPLE && SD.SIMPLE[s.pat];
    let h = '';
    if (sim && V.step === 0) h += `<div class="simple"><span class="eyebrow">Простыми словами</span><span class="an">${esc(sim[1])}</span><span class="pl">${esc(pat ? pat.name + ' — ' + sim[0][0].toLowerCase() + sim[0].slice(1) : sim[0])}</span></div>`;
    h += `<div class="lab-head"><p>${V.step === 0 ? '<b>Как это выглядит в коде.</b> ' : ''}${esc(s.intro)}</p></div>`;
    h += `<ol class="pr-steps">${STEPS.map((t, i) => `<li class="${i === V.step ? 'on' : ''} ${i < V.step || ST.done[s.id] && i <= V.maxStep ? 'done' : ''}"><button type="button" ${i <= V.maxStep ? `data-prstep="${i}"` : 'disabled'}><i>${i + 1}</i>${t}</button></li>`).join('')}</ol>`;
    h += [stepCode, stepHunt, stepRefactor, stepHunt, stepSummary][V.step](s);
    void pat;
    $('prMain').innerHTML = h;
  }
  function stepCode(s) {
    let h = `<div class="pr-split"><div>${files(s.before, { click: false })}</div><div class="pr-side">${map(s.before, null)}<div class="lab-card">Стрелка на карте — «знает о»: этот модуль упоминает другой в коде. Чем больше стрелок, тем шире расходится любое изменение.</div></div></div>`;
    return h + `<div class="row-btns"><button type="button" class="btn primary" data-prgo="1">Пришло изменение →</button></div>`;
  }
  function stepHunt(s) {
    const after = V.step === 3, v = after ? s.after : s.before, tag = s.change.tag;
    const mt = metrics(v, tag);
    let h = `<div class="pr-change"><span class="eyebrow" style="margin:0">${after ? 'То же изменение — после рефакторинга' : 'Требование изменилось'}</span><b>${esc(s.change.title)}</b><span>${esc(s.change.ask)}</span></div>`;
    let res = '';
    if (V.checked) {
      let hit = 0, wrong = 0;
      V.picks.forEach(k => { const [f, l] = k.split(':').map(Number); if (v.parsed[f].lines[l].tags.includes(tag)) hit++; else wrong++; });
      const miss = mt.places - hit;
      V.res[after ? 1 : 0] = { hit, wrong, miss, places: mt.places, files: mt.files };
      res = `<div class="lab-card ${miss || wrong ? 'badc' : 'okc'}"><b>Правок: ${mt.places} ${plural(mt.places, 'место', 'места', 'мест')} в ${mt.files} ${plural(mt.files, 'файле', 'файлах', 'файлах')}.</b> Ты нашёл ${hit} из ${mt.places}${wrong ? `, лишних отметок: ${wrong}` : ''}.`;
      if (miss) res += ` ${after ? 'Даже одно место можно пропустить — но здесь его хотя бы видно сразу.' : `Пропущенное место — это баг в проде: часть системы продолжит работать по-старому, и никто не заметит, пока не пожалуется клиент.`}`;
      else if (!after) res += ` Все места найдены — но представь, что их не ${mt.places}, а ${mt.places * 5}, и они в разных репозиториях.`;
      else res += ` Изменение стало локальным.`;
      res += `</div>`;
    }
    h += `<div class="pr-split"><div>${files(v, { click: !V.checked, tag: V.checked ? tag : null })}</div><div class="pr-side">${map(v, V.checked ? touched(v, tag) : null)}`;
    h += `<div class="lab-card">Отмечено строк: <b>${V.picks.size}</b>. Кликай по строкам кода слева.${V.checked ? '<br>Красные узлы на карте — модули, которые придётся менять и перепроверять.' : ''}</div>${res}`;
    h += `<div class="row-btns">${V.checked ? (after ? `<button type="button" class="btn primary" data-prgo="4">Итог →</button>` : `<button type="button" class="btn primary" data-prgo="2">Как сделать дешевле →</button>`) : `<button type="button" class="btn primary" data-prcheck ${V.picks.size ? '' : 'disabled'}>Проверить</button><button type="button" class="btn" data-prreveal>Показать ответ</button>`}${V.checked ? '' : V.picks.size ? '<button type="button" class="btn ghost" data-prclear>Сбросить</button>' : ''}</div></div></div>`;
    return h;
  }
  function stepRefactor(s) {
    let h = `<div class="pr-change"><span class="eyebrow" style="margin:0">Выбери рефакторинг</span><b>Как переделать код, чтобы такое изменение стоило дешевле?</b><span>Не все варианты помогают: некоторые только прячут проблему или добавляют новую.</span></div>`;
    h += `<div class="pr-opts">${s.refactors.map((r, i) => { const cls = V.wrongs.includes(i) ? 'wrong' : V.choice === i ? 'right' : ''; return `<button type="button" class="opt ${cls}" data-propt="${i}" ${V.choice != null ? 'disabled' : ''}>${esc(r.label)}</button>${V.wrongs.includes(i) || V.choice === i ? `<div class="fb">${esc(r.fb)}</div>` : ''}`; }).join('')}</div>`;
    if (V.choice != null) {
      h += `<h4 class="pr-h">После рефакторинга</h4><div class="pr-split"><div>${files(s.after, { click: false, showNew: true })}</div><div class="pr-side">${map(s.after, null, true)}<div class="lab-card">Зелёным отмечены новые и переписанные строки.</div></div></div>`;
      h += `<div class="row-btns"><button type="button" class="btn primary" data-prgo="3">То же изменение ещё раз →</button></div>`;
    }
    return h;
  }
  function stepSummary(s) {
    const a = metrics(s.before, s.change.tag), b = metrics(s.after, s.change.tag);
    const row = (t, x, y, lower = true) => `<tr><td>${t}</td><td>${x}</td><td class="${(lower ? y < x : y > x) ? 'ok' : y === x ? '' : 'bad'}">${y}</td></tr>`;
    let h = `<div class="pr-change ok"><span class="eyebrow" style="margin:0">Цена одного и того же изменения</span><b>${esc(s.change.title)}</b></div>`;
    const depNote = b.deps > a.deps ? `<p class="note">Связей стало больше — это цена новой прослойки. Зато изменение задевает меньше мест: связи теперь идут через одну точку, а не напрямую к чужим деталям.</p>` : '';
    h += `<table class="pr-metrics"><thead><tr><th></th><th>До</th><th>После</th></tr></thead><tbody>${row('Мест правки', a.places, b.places)}${row('Файлов затронуто', a.files, b.files)}${row('Строк перепроверять', a.retest, b.retest)}${row('Связей «знает о» на карте', a.deps, b.deps)}</tbody></table>`;
    h += depNote;
    const r0 = V.res[0], r1 = V.res[1];
    if (r0 && r1) h += `<p class="note">Твой поиск: до рефакторинга нашёл ${r0.hit} из ${r0.places}${r0.miss ? ` (пропуск — баг)` : ''}, после — ${r1.hit} из ${r1.places}.</p>`;
    const sim = SD.SIMPLE && SD.SIMPLE[s.pat];
    if (sim) h += `<div class="simple sm"><span class="eyebrow">Запомнить одной картинкой</span><span class="an">${esc(sim[1])}</span></div>`;
    h += `<div class="pr-take"><b>Вывод</b><p>${esc(s.takeaway)}</p></div>`;
    const links = (s.where || []).map(([kind, id, label]) => {
      if (kind === 'pat' && SD.PATTERNS.find(p => p.id === id)) return `<button type="button" class="btn" data-prpat="${id}">${esc(label)}</button>`;
      if (kind === 'principle' && SD.principleById(id)) return `<button type="button" class="btn" data-prid="${id}">${esc(label)}</button>`;
      if (kind === 'inner' && SD.levelById(id)) return `<button type="button" class="btn" data-prlevel="${id}">${esc(label)}</button>`;
      if (kind === 'dive' && SD.DIVES[id]) return `<button type="button" class="btn" data-prdive="${id}">${esc(label)}</button>`;
      return '';
    }).join('');
    if (links) h += `<h4 class="pr-h">Где ещё посмотреть</h4><div class="row-btns">${links}</div>`;
    const i = SD.PRINCIPLES.indexOf(s), nx = SD.PRINCIPLES[i + 1];
    h += `<div class="row-btns" style="margin-top:14px">${nx ? `<button type="button" class="btn primary" data-prid="${nx.id}">Следующий: ${esc(nx.title.split(':')[0])} →</button>` : ''}<button type="button" class="btn ghost" data-prid="${s.id}">Пройти заново</button></div>`;
    return h;
  }
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many; };
  function touched(v, tag) { const set = new Set(); v.parsed.forEach(f => { if (f.lines.some(l => l.tags.includes(tag))) set.add(f.node); }); return set; }

  function files(v, o) {
    return `<div class="pr-files">${v.parsed.map((f, fi) => `<div class="pr-file"><div class="pr-fname">${esc(f.name)}</div><pre class="code pr-code${o.click ? ' clickable' : ''}">${f.lines.map((l, li) => {
      const k = fi + ':' + li, picked = V.picks.has(k), tagged = o.tag && l.tags.includes(o.tag);
      const cls = ['ln', picked && !o.tag ? 'pick' : '', o.tag && tagged && picked ? 'hit' : '', o.tag && tagged && !picked ? 'miss' : '', o.tag && !tagged && picked ? 'wrong' : '', o.showNew && l.tags.includes('new') ? 'new' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-n="${li + 1}" ${o.click ? `data-prline="${k}" role="button" tabindex="0"` : ''}>${SD.player.highlight(l.text, 'js') || ' '}</span>`;
    }).join('')}</pre></div>`).join('')}</div>`;
  }
  function map(v, hot, showNew) {
    const W = 600, H = 200, NH = 32;
    const nw = n => Math.max(86, Math.min(190, n[1].length * 7.2 + 20));
    const by = new Map(v.map.nodes.map(n => [n[0], n]));
    const newNodes = showNew ? new Set(v.parsed.filter(f => f.lines.some(l => l.tags.includes('new'))).map(f => f.node)) : new Set();
    let s = `<svg class="pr-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Карта связей модулей"><defs><marker id="prA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`;
    v.map.edges.forEach(([a, b]) => {
      const A = by.get(a), B = by.get(b); if (!A || !B) return;
      const ax = A[2] + nw(A) / 2, ay = A[3] + NH / 2, bx = B[2] + nw(B) / 2, by2 = B[3] + NH / 2;
      const dx = bx - ax, dy = by2 - ay, len = Math.hypot(dx, dy) || 1;
      const ex = Math.min(nw(B) / 2 / Math.abs(dx / len || 1e-9), NH / 2 / Math.abs(dy / len || 1e-9));
      const sx = Math.min(nw(A) / 2 / Math.abs(dx / len || 1e-9), NH / 2 / Math.abs(dy / len || 1e-9));
      s += `<line class="pr-edge${hot && (hot.has(a) || hot.has(b)) ? ' hot' : ''}" x1="${ax + dx / len * sx}" y1="${ay + dy / len * sx}" x2="${bx - dx / len * (ex + 2)}" y2="${by2 - dy / len * (ex + 2)}" marker-end="url(#prA)"/>`;
    });
    v.map.nodes.forEach(n => {
      const w = nw(n), cls = hot && hot.has(n[0]) ? 'hot' : newNodes.has(n[0]) ? 'new' : '';
      s += `<g class="pr-node ${cls}"><rect x="${n[2]}" y="${n[3]}" width="${w}" height="${NH}" rx="8"/><text x="${n[2] + w / 2}" y="${n[3] + 20}" text-anchor="middle">${esc(n[1].length > 26 ? n[1].slice(0, 25) + '…' : n[1])}</text></g>`;
    });
    return s + `</svg>`;
  }

  /* ---------- события ---------- */
  function onClick(e) {
    const m = $('prModal');
    if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; return; }
    const ln = e.target.closest('[data-prline]');
    if (ln) { const k = ln.dataset.prline; if (V.picks.has(k)) V.picks.delete(k); else V.picks.add(k); const keep = $('prMain').scrollTop; render(); $('prMain').scrollTop = keep; return; }
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.prid) { start(d.prid); return; }
    if (d.prstep) { V.step = +d.prstep; V.picks = new Set(); V.checked = false; render(); return; }
    if (d.prgo) { go(+d.prgo); return; }
    if ('prcheck' in d) { V.checked = true; const keep = $('prMain').scrollTop; render(); $('prMain').scrollTop = keep; return; }
    if ('prclear' in d) { V.picks = new Set(); render(); return; }
    if ('prreveal' in d) { V.picks = new Set(); V.checked = true; render(); return; }
    if (d.propt) { const i = +d.propt, r = cur().refactors[i]; if (r.ok) V.choice = i; else if (!V.wrongs.includes(i)) V.wrongs.push(i); const keep = $('prMain').scrollTop; render(); $('prMain').scrollTop = keep; return; }
    if (d.prpat) { SD.patterns.open(d.prpat); return; }
    if (d.prdive) { SD.player.open(d.prdive); return; }
    if (d.prlevel) { const L = SD.levelById(d.prlevel); if (L) { m.hidden = true; const pm = $('patModal'); if (pm) pm.hidden = true; SD.app.loadLevel(L); } }
  }

  SD.principles = { mount, open, progress: () => ST.done };
})();
