/* Поделиться схемой и экспорт: ссылка, в которой зашита вся схема (уровень, узлы, настройки, связи),
   и текст для документации — Mermaid и C4 (PlantUML). */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const T = () => SD.TYPES;
  const nm = n => n.label || (T()[n.type] ? T()[n.type].name : n.type);
  const diff = (obj, def) => { const o = {}; Object.keys(obj || {}).forEach(k => { if (JSON.stringify(obj[k]) !== JSON.stringify(def[k])) o[k] = obj[k]; }); return o; };

  /* ---------- ссылка ---------- */
  const b64 = s => { const b = new TextEncoder().encode(s); let bin = ''; b.forEach(x => { bin += String.fromCharCode(x); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
  function encode(A) {
    const pre = new Set((A.level.preset || []).map(p => p[0]));
    const g = A.graph;
    const n = g.nodes.filter(x => !pre.has(x.id)).map(x => { const p = diff(x.props, SD.defaultsFor(x.type)); const r = [x.id, x.type, Math.round(x.x), Math.round(x.y)]; if (Object.keys(p).length || x.label) r.push(p); if (x.label) r.push(x.label); return r; });
    const e = g.edges.map(x => { const p = diff(x.props, SD.edgeDefaults()); return Object.keys(p).length ? [x.from, x.to, p] : [x.from, x.to]; });
    return b64(JSON.stringify({ v: 1, l: A.level.id, n, e }));
  }
  const linkOf = A => location.href.split('#')[0] + '#s=' + encode(A);
  function openFromHash() {
    const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)$/); if (!m) return false;
    let d = null; try { d = JSON.parse(unb64(m[1])); } catch (e) { d = null; }
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) { /* адрес не меняется */ }
    if (!d || d.v !== 1) { SD.app.toast('Ссылка на схему повреждена — открыл обычную площадку.'); return false; }
    const L = SD.levelById(d.l); if (!L) { SD.app.toast('Уровень из ссылки не найден.'); return false; }
    SD.app.loadLevel(L, { nodes: d.n || [], edges: d.e || [] });
    SD.app.toast(`Открыта схема по ссылке: «${L.title}». Твоя прошлая схема этого уровня не тронута — просто открой уровень заново.`);
    return true;
  }

  /* ---------- Mermaid ---------- */
  const STORE = new Set(['sql', 'nosql', 'olap', 'lake', 'tsdb', 'vectordb', 'search', 'graphdb', 'objstore', 'cache']);
  const sid = id => String(id).replace(/[^A-Za-z0-9_]/g, '_');
  const q = s => String(s).replace(/"/g, "'");
  function brief(n) {
    const p = n.props || {}, out = [];
    if (p.count > 1) out.push('×' + p.count);
    if (p.size && n.type === 'sql') out.push(String(p.size).toUpperCase());
    if (p.replicas) out.push('реплик ' + p.replicas);
    if (p.shards > 1) out.push('шардов ' + p.shards);
    if (p.partitions > 1) out.push('партиций ' + p.partitions);
    if (n.type === 'etl' && p.mode) out.push(p.mode === 'stream' ? 'поток' : p.mode === 'daily' ? 'ночью' : 'раз в час');
    return out.join(', ');
  }
  function mermaid(A) {
    const g = A.graph, L = A.level;
    let s = `%% ${q(L.title)} — схема из «AMP Стройплощадки»\nflowchart LR\n`;
    g.nodes.forEach(n => {
      const t = T()[n.type] || {}, b = brief(n), text = q(nm(n)) + (t.short && n.type !== 'client' ? `<br/><small>${q(t.short)}</small>` : '') + (b ? `<br/>${q(b)}` : '');
      const sh = n.type === 'client' ? ['([', '])'] : STORE.has(n.type) ? ['[(', ')]'] : n.type === 'queue' ? ['[[', ']]'] : t.ops ? ['{{', '}}'] : ['[', ']'];
      s += `  ${sid(n.id)}${sh[0]}"${text}"${sh[1]}\n`;
    });
    g.edges.forEach(e => {
      const a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to);
      const async = a && (a.type === 'queue' || a.type === 'cdc' || (T()[a.type] || {}).ops || (b && (T()[b.type] || {}).ops));
      s += `  ${sid(e.from)} ${async ? '-.->' : '-->'} ${sid(e.to)}\n`;
    });
    return s;
  }
  /* ---------- C4 (PlantUML) ---------- */
  function c4(A) {
    const g = A.graph, L = A.level;
    let s = `@startuml\n!include <C4/C4_Container>\ntitle ${L.title} — контейнеры (AMP Стройплощадка)\n\n`;
    const people = g.nodes.filter(n => n.type === 'client'), rest = g.nodes.filter(n => n.type !== 'client');
    people.forEach(n => { s += `Person(${sid(n.id)}, "${q(nm(n))}")\n`; });
    s += `System_Boundary(sys, "${q(L.title)}") {\n`;
    rest.forEach(n => {
      const t = T()[n.type] || {}, tech = q(t.short || ''), b = q(brief(n));
      const kind = STORE.has(n.type) ? 'ContainerDb' : n.type === 'queue' ? 'ContainerQueue' : 'Container';
      s += `  ${kind}(${sid(n.id)}, "${q(nm(n))}", "${tech}", "${b}")\n`;
    });
    s += '}\n\n';
    g.edges.forEach(e => { s += `Rel(${sid(e.from)}, ${sid(e.to)}, "")\n`; });
    return s + '@enduml\n';
  }

  /* ---------- окно ---------- */
  let tab = 'link';
  function open() {
    const A = SD.app.A;
    let m = $('shareModal');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'shareModal'; m.hidden = true;
      m.innerHTML = '<div class="sheet sh-sheet" role="dialog" aria-modal="true" aria-labelledby="shTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Поделиться и экспорт</span><h2 id="shTitle"></h2><button class="btn ghost x" type="button" data-shx>Закрыть</button></div><div class="sh-body" id="shBody"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', e => {
        if (e.target === m || e.target.closest('[data-shx]')) { m.hidden = true; return; }
        const t = e.target.closest('[data-shtab]'); if (t) { tab = t.dataset.shtab; render(); return; }
        if (e.target.closest('[data-shcopy]')) copy();
      });
    }
    $('shTitle').textContent = A.level.title;
    render(); m.hidden = false;
  }
  function render() {
    const A = SD.app.A, txt = tab === 'link' ? linkOf(A) : tab === 'mermaid' ? mermaid(A) : c4(A);
    const note = tab === 'link' ? 'В ссылке зашита вся схема: уровень, узлы, их настройки и связи. Отправь её наставнику или другу — у них откроется ровно эта схема.'
      : tab === 'mermaid' ? 'Mermaid понимают GitHub, GitLab, Confluence, Notion и Obsidian: вставь в блок ```mermaid — схема нарисуется сама. Пунктир — асинхронно (очередь, CDC, телеметрия).'
        : 'C4, уровень контейнеров, для PlantUML: люди, контейнеры, базы и очереди с технологиями и связи. Вставь в PlantUML или в плагин Confluence.';
    $('shBody').innerHTML = `<div class="seg sh-tabs">${[['link', 'Ссылка'], ['mermaid', 'Mermaid'], ['c4', 'C4 · PlantUML']].map(([k, t]) => `<button type="button" data-shtab="${k}" aria-selected="${k === tab}">${t}</button>`).join('')}</div>
      <p class="sh-note">${esc(note)}</p><textarea id="shText" class="sh-text" readonly spellcheck="false" rows="${tab === 'link' ? 4 : 16}">${esc(txt)}</textarea>
      <div class="row-btns"><button type="button" class="btn primary" data-shcopy>Скопировать</button><span class="note" id="shDone"></span></div>`;
  }
  function copy() {
    const t = $('shText'); if (!t) return;
    const ok = () => { $('shDone').textContent = 'Скопировано.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(ok, () => { t.select(); try { document.execCommand('copy'); ok(); } catch (e) { $('shDone').textContent = 'Выдели текст и нажми Ctrl+C.'; } });
    else { t.select(); try { document.execCommand('copy'); ok(); } catch (e) { $('shDone').textContent = 'Выдели текст и нажми Ctrl+C.'; } }
  }

  function mount() {
    setTimeout(() => {
      const menu = document.querySelector('.tb-menu');
      if (menu && !$('shareBtn')) { const b = document.createElement('button'); b.type = 'button'; b.id = 'shareBtn'; b.className = 'btn ghost tbm-it'; b.innerHTML = '<span>Поделиться и экспорт</span>'; b.addEventListener('click', open); menu.appendChild(b); }
      openFromHash();
    }, 0);
    window.addEventListener('hashchange', openFromHash);
    document.addEventListener('keydown', e => { const m = $('shareModal'); if (e.key === 'Escape' && m && !m.hidden) m.hidden = true; });
  }

  SD.share = { mount, open, encode, mermaid, c4, openFromHash };
})();
