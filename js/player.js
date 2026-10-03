/* Плеер разборов: сцена с участниками и сообщениями + код с подсветкой текущих строк. */
(function () {
  SD.DIVES = SD.DIVES || {};
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (parent) parent.appendChild(e);
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COLORS = { ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', accent: 'var(--accent)', info: 'var(--info)', job: 'var(--k-job)', read: 'var(--k-read)', write: 'var(--k-write)', ai: 'var(--k-chat)', voice: 'var(--k-voice)' };

  /* ---------- подсветка кода ---------- */
  const KW = {
    python: 'def return if elif else for while in not and or import from as with try except finally raise class None True False await async lambda yield pass break continue is',
    java: 'public private protected class interface void return if else for while new try catch finally throw throws static final import package extends implements this null true false var record',
    js: 'const let var function return if else for while new try catch finally throw await async import from export class this null true false of in typeof interface implements private public protected readonly abstract extends type enum static constructor number string boolean void bigint unknown any',
    go: 'func return if else for range go defer select case chan struct type package import var const nil true false err',
    sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE BEGIN COMMIT ROLLBACK FOR UPDATE CREATE TABLE INDEX ON PRIMARY KEY UNIQUE AND OR NOT NULL RETURNING ISOLATION LEVEL TRANSACTION SERIALIZABLE REPEATABLE READ COMMITTED LIMIT ORDER BY JOIN AS IF EXISTS CONFLICT DO NOTHING PREPARE',
    yaml: 'true false null',
    lua: 'local if then else elseif end return function and or not nil true false for do while in',
    text: ''
  };
  function highlight(line, lang) {
    const kw = new Set((KW[lang] || '').split(' ').filter(Boolean));
    const ci = lang === 'sql';
    const cmt = lang === 'python' || lang === 'yaml' ? /^#.*/ : lang === 'sql' || lang === 'lua' ? /^--.*/ : /^\/\/.*/;
    let out = '', i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      let m;
      if ((m = rest.match(cmt))) { out += `<span class="tok-c">${esc(m[0])}</span>`; break; }
      if ((m = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/))) { out += `<span class="tok-s">${esc(m[0])}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^\d+(\.\d+)?/))) { out += `<span class="tok-n">${m[0]}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^[A-Za-z_][\w]*/))) {
        const w = m[0];
        const isKw = ci ? kw.has(w.toUpperCase()) : kw.has(w);
        const isFn = !isKw && line[i + w.length] === '(';
        out += isKw ? `<span class="tok-k">${w}</span>` : isFn ? `<span class="tok-f">${w}</span>` : esc(w);
        i += w.length; continue;
      }
      out += esc(line[i]); i++;
    }
    return out;
  }

  /* ---------- состояние ---------- */
  const P = { dive: null, i: 0, tab: 0, timer: null, anim: [] };
  const $ = id => document.getElementById(id);

  function open(id) {
    const d = SD.DIVES[id];
    if (!d) return false;
    P.dive = d; P.i = 0; P.tab = 0; stop();
    $('diveTitle').textContent = d.title;
    renderTabs(); go(0);
    $('diveModal').hidden = false;
    $('diveNext').focus();
    return true;
  }
  function close() { stop(); $('diveModal').hidden = true; }

  function renderTabs() {
    const box = $('codeTabs'); box.textContent = '';
    P.dive.code.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.role = 'tab'; b.textContent = c.label;
      b.setAttribute('aria-selected', i === P.tab ? 'true' : 'false');
      b.addEventListener('click', () => { P.tab = i; renderTabs(); renderCode(); });
      box.appendChild(b);
    });
  }
  function linesFor(step) {
    if (!step.c) return null;
    if (Array.isArray(step.c)) return P.tab === 0 ? step.c : null;
    return step.c[P.tab] || null;
  }
  function renderCode() {
    const c = P.dive.code[P.tab];
    const step = P.dive.steps[P.i];
    const on = new Set(linesFor(step) || []);
    const pre = $('diveCode');
    pre.classList.toggle('focus', on.size > 0);
    pre.innerHTML = c.src.replace(/^\n/, '').split('\n').map((l, k) => `<span class="ln${on.has(k + 1) ? ' on' : ''}" data-n="${k + 1}">${highlight(l, c.lang) || ' '}</span>`).join('');
    const first = pre.querySelector('.ln.on');
    if (first) { const top = first.offsetTop - pre.clientHeight / 3; pre.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); }
    $('codeNote').textContent = c.note || P.dive.note || '';
  }

  function go(i) {
    const d = P.dive;
    P.i = Math.max(0, Math.min(d.steps.length - 1, i));
    const s = d.steps[P.i];
    $('diveStep').innerHTML = `<span class="sn">ШАГ ${P.i + 1} ИЗ ${d.steps.length}</span><h4>${esc(s.title)}</h4><p>${esc(s.text)}</p>`;
    $('divePrev').disabled = P.i === 0;
    $('diveNext').textContent = P.i === d.steps.length - 1 ? 'Сначала ↺' : 'Дальше →';
    const dots = $('diveDots'); dots.textContent = '';
    d.steps.forEach((_, k) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-label', 'Шаг ' + (k + 1));
      if (k === P.i) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { stop(); go(k); });
      dots.appendChild(b);
    });
    renderScene(); renderCode();
  }

  /* накопленное состояние участников к шагу i */
  function stateAt(i) {
    const lines = {}, sub = {};
    for (let k = 0; k <= i; k++) {
      const s = P.dive.steps[k];
      if (s.lines) Object.entries(s.lines).forEach(([a, v]) => { lines[a] = v; });
      if (s.sub) Object.entries(s.sub).forEach(([a, v]) => { sub[a] = v; });
    }
    return { lines, sub };
  }

  function actorBox(a, st) {
    const ls = st.lines[a.id] || a.lines || [];
    const h = Math.max(a.h || 50, 40 + ls.length * 14);
    return { x: a.x, y: a.y, w: a.w || 120, h };
  }

  function renderScene() {
    P.anim.forEach(cancelAnimationFrame); P.anim = [];
    const svg = $('diveSvg'); svg.textContent = '';
    const d = P.dive, s = d.steps[P.i], st = stateAt(P.i);
    svg.setAttribute('viewBox', `0 0 ${d.w || 640} ${d.h || 340}`);
    (d.zones || []).forEach(z => {
      el('rect', { class: 'zone', x: z.x, y: z.y, width: z.w, height: z.h, rx: 10 }, svg);
      const t = el('text', { class: 'zone-t', x: z.x + 10, y: z.y + 16 }, svg); t.textContent = z.label.toUpperCase();
    });
    const boxes = {};
    const has = (arr, id) => (arr || []).includes(id);
    d.actors.forEach(a => {
      const b = actorBox(a, st); boxes[a.id] = b;
      const cls = ['actor', has(s.hl, a.id) ? 'hl' : '', has(s.dim, a.id) ? 'dim' : '', has(s.bad, a.id) ? 'bad' : '', has(s.good, a.id) ? 'good' : ''].join(' ');
      const g = el('g', { class: cls, transform: `translate(${b.x},${b.y})` }, svg);
      el('rect', { width: b.w, height: b.h, rx: 9 }, g);
      const t = el('text', { class: 'at', x: 10, y: 19 }, g); t.textContent = a.label;
      const subT = st.sub[a.id] || a.sub;
      if (subT) { const t2 = el('text', { class: 'as', x: 10, y: 33 }, g); t2.textContent = subT; }
      (st.lines[a.id] || a.lines || []).forEach((l, k) => { const t3 = el('text', { class: 'al', x: 10, y: (subT ? 48 : 36) + k * 14 }, g); t3.textContent = l; });
      if (s.badge && s.badge[a.id]) {
        const txt = s.badge[a.id];
        const bw = txt.length * 6.6 + 12;
        const bad = /MISS|FAIL|ОШИБ|429|DROP|ОТКАЗ|ROLLBACK|TIMEOUT|LOST|ДУБЛ/i.test(txt);
        el('rect', { x: b.w - bw + 6, y: -9, width: bw, height: 18, rx: 9, style: `fill:${bad ? 'var(--bad)' : 'var(--accent)'}` }, g);
        const bt = el('text', { class: 'badge-t', x: b.w - bw / 2 + 6, y: 4, 'text-anchor': 'middle' }, g); bt.textContent = txt;
      }
    });
    (s.msgs || []).forEach((m, k) => {
      const A = boxes[m.from], B = boxes[m.to];
      if (!A || !B) return;
      const p = edgePoint(A, B), q = edgePoint(B, A);
      const off = (m.lane || 0) * 10;
      const pp = { x: p.x + (Math.abs(q.y - p.y) > Math.abs(q.x - p.x) ? off : 0), y: p.y + (Math.abs(q.y - p.y) > Math.abs(q.x - p.x) ? 0 : off) };
      const qq = { x: q.x + (pp.x - p.x), y: q.y + (pp.y - p.y) };
      const color = COLORS[m.color] || m.color || 'var(--info)';
      el('line', { class: 'msg-line', x1: pp.x, y1: pp.y, x2: qq.x, y2: qq.y, style: `stroke:${color}` }, svg);
      const ang = Math.atan2(qq.y - pp.y, qq.x - pp.x);
      el('path', { d: `M${qq.x},${qq.y} l${-8 * Math.cos(ang - 0.4)},${-8 * Math.sin(ang - 0.4)} M${qq.x},${qq.y} l${-8 * Math.cos(ang + 0.4)},${-8 * Math.sin(ang + 0.4)}`, style: `stroke:${color};stroke-width:1.6;fill:none` }, svg);
      if (m.label) {
        const t = el('text', { class: 'msg-lbl', x: (pp.x + qq.x) / 2, y: (pp.y + qq.y) / 2 - 6, 'text-anchor': 'middle', style: `fill:${color}` }, svg);
        t.textContent = m.label;
      }
      const dot = el('circle', { r: 5, cx: pp.x, cy: pp.y, style: `fill:${color}` }, svg);
      animateDot(dot, pp, qq, k * 450);
    });
    if (s.note) {
      const t = el('text', { class: 'zone-t', x: (d.w || 640) / 2, y: (d.h || 340) - 10, 'text-anchor': 'middle' }, svg);
      t.textContent = s.note;
    }
  }
  function edgePoint(A, B) {
    const cx = A.x + A.w / 2, cy = A.y + A.h / 2;
    const tx = B.x + B.w / 2, ty = B.y + B.h / 2;
    const dx = tx - cx, dy = ty - cy;
    const sx = A.w / 2 / Math.abs(dx || 1e-6), sy = A.h / 2 / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  function animateDot(dot, p, q, delay) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { dot.setAttribute('cx', q.x); dot.setAttribute('cy', q.y); return; }
    const dur = 700; let t0 = null;
    const stepF = t => {
      if (t0 === null) t0 = t + delay;
      const k = Math.max(0, Math.min(1, (t - t0) / dur));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      dot.setAttribute('cx', p.x + (q.x - p.x) * e); dot.setAttribute('cy', p.y + (q.y - p.y) * e);
      if (k < 1) P.anim.push(requestAnimationFrame(stepF));
    };
    P.anim.push(requestAnimationFrame(stepF));
  }

  function play() {
    if (P.timer) { stop(); return; }
    $('divePlay').textContent = '❚❚ Пауза';
    P.timer = setInterval(() => {
      if (P.i >= P.dive.steps.length - 1) { stop(); return; }
      go(P.i + 1);
    }, 4200);
  }
  function stop() { if (P.timer) clearInterval(P.timer); P.timer = null; const b = $('divePlay'); if (b) b.textContent = '▶ Авто'; }

  function bind() {
    $('divePrev').addEventListener('click', () => { stop(); go(P.i - 1); });
    $('diveNext').addEventListener('click', () => { stop(); go(P.i >= P.dive.steps.length - 1 ? 0 : P.i + 1); });
    $('divePlay').addEventListener('click', play);
    document.addEventListener('keydown', ev => {
      if ($('diveModal').hidden) return;
      if (ev.key === 'ArrowRight') { stop(); go(P.i + 1); }
      if (ev.key === 'ArrowLeft') { stop(); go(P.i - 1); }
      if (ev.key === 'Escape') close();
    });
  }

  SD.player = { open, close, bind, highlight };
})();
