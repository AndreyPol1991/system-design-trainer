/* Режим группы: разбор у доски.
   На пальцах: как разбор задач у доски — все решили по-своему, потом сравниваем. Наставник выводит
   на большой экран один кейс (история, нагрузка, цели, таймер). Ученики открывают тот же кейс у себя
   по QR-коду, ссылке #group=<код> или по коду занятия, собирают схему и «сдают» её коротким кодом
   решения (вся схема внутри кода, как в ссылке #s= из js/share.js). Наставник вставляет коды — экран
   показывает решения рядом и без имён: «Решение 1, 2, 3…».

   Без сервера: тренажёр — статический сайт, поэтому решения приходят не сами, а кодом через чат.
   Пульт наставника — второе окно этого же браузера (#group-pult), как в «Арене»: связь через
   BroadcastChannel и запасное событие storage (ключ amp-stroyka-group-v1:bus).

   Форматы:
   · код занятия: <уровень>.<испытание или ->.<минуты>.<метка>, например short.-.15.K7QF;
     ссылка ученика — адрес тренажёра + #group=<код занятия>;
   · код решения: sdg.<base64url(JSON)>.<контрольная сумма>; в JSON — код занятия, анонимная метка
     устройства (чтобы повторная сдача заменила прежнюю), время решения и схема целиком;
   · id уровня занятия: grp-<уровень>-<испытание или 0>-<минуты>-<метка> (формат кода задания платформы).
   Вход: SD.group.open(), Ctrl+K (SD.cmdExtra), ссылка #group=…, пульт #group-pult. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt, T = () => SD.TYPES;
  const clone = o => JSON.parse(JSON.stringify(o));
  const tn = t => (T()[t] || {}).name || t;
  const pname = id => ((SD.PATTERNS || []).find(p => p.id === id) || {}).name || id;
  const toast = m => { if (SD.app && SD.app.toast) SD.app.toast(m); };
  const KEY = 'amp-stroyka-group-v1', BUS = KEY + ':bus';
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const rnd = n => { let s = ''; for (let i = 0; i < n; i++) s += ABC[Math.floor(Math.random() * ABC.length)]; return s; };
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const clock = sec => { sec = Math.max(0, Math.ceil(sec)); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); };

  /* ---------- хранилище: сессия наставника, старт таймера ученика, анонимная метка устройства ---------- */
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища — до перезагрузки */ } };
  U.stu = U.stu || {};
  if (!U.dev) { U.dev = rnd(4); save(); }

  /* ---------- base64url и контрольная сумма ---------- */
  const b64 = s => { const b = new TextEncoder().encode(s); let bin = ''; b.forEach(x => { bin += String.fromCharCode(x); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
  const chk = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 46656).toString(36).padStart(3, '0'); };

  /* ---------- код занятия ---------- */
  const EVS = () => (SD.daily && SD.daily.EV) || [];
  function parseGroup(s) {
    const m = /^([A-Za-z0-9-]{1,40})\.([A-Za-z]{1,12}|-)\.(\d{1,3})\.([A-Za-z0-9]{4})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    const e = m[2] === '-' ? '' : m[2].toLowerCase(), min = Math.max(1, Math.min(180, +m[3])), tag = m[4].toUpperCase();
    const l = m[1].toLowerCase();
    return { l, e, m: min, tag, code: `${l}.${e || '-'}.${min}.${tag}` };
  }
  const makeGroup = (l, e, m, tag) => `${l}.${e || '-'}.${m}.${tag || rnd(4)}`;
  /* id уровня занятия — в формате кода задания платформы (^[a-z0-9][a-z0-9-]{1,40}$): мост и телеметрия
     шлют его в событиях учёбы, а пачку с одним кривым кодом платформа отвергает целиком */
  const TASK_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const idOf = p => `grp-${p.l}-${p.e || '0'}-${p.m}-${p.tag.toLowerCase()}`;
  function fromId(id) {
    const parts = String(id).slice(4).split('-'); if (parts.length < 4) return null;
    const tag = parts.pop(), m = parts.pop(), e = parts.pop();
    return parseGroup(`${parts.join('-')}.${e === '0' ? '-' : e}.${m}.${tag}`);
  }

  /* ---------- уровень занятия: тот же кейс, что на уровне, или эталон под испытанием «События дня» ---------- */
  const baseById = SD.levelById, baseLabel = SD.levelLabel, baseNext = SD.nextLevel;
  const fit = L => !!(L && L.solution && !L.diagnose && !L.interview && !L.sandbox && !L.innerLvl && !L.daily && !L.free && /^[a-z0-9-]+$/.test(L.id) && baseById(L.id) === L);
  const LISTS = () => [['Основные уровни', SD.LEVELS], ['Данные', SD.DATAL], ['Облако', SD.CLOUDL], ['Эксплуатация', SD.OPSL], ['Много клиентов (SaaS)', SD.SAASL],
    ['Архитектура из сервисов', SD.ARCHL], ['Практика паттернов', SD.PRACTICE], ['Найди и перестрой', SD.FIXES]];
  function sync(g) { if (SD.inner && SD.inner.syncFlags) g.nodes.forEach(n => { try { SD.inner.syncFlags(n, g); } catch (e) { /* узел без внутренностей */ } }); return g; }
  /* граф из описания уровня — как app.js graphFrom */
  function buildGraph(L, spec) {
    const nodes = [], edges = [];
    const add = ([id, type, x, y, props, label]) => { if (!T()[type] || nodes.some(n => n.id === id)) return; nodes.push({ id, type, x, y, props: Object.assign(SD.defaultsFor(type), props ? clone(props) : {}), label: label || (type === 'external' && L.ext ? L.ext.name : undefined) }); };
    (L.preset || []).forEach(add);
    if (spec) { (spec.nodes || []).forEach(add); (spec.edges || []).forEach(([a, b, p], i) => edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p || {}) })); }
    return sync({ nodes, edges });
  }
  const every = (L, g) => { const r = SD.sim.run(L, g, { mul: 1 }); return SD.evalGoals(L, g, r, SD.sim.chaos(L, g), SD.sim.analyze(L, g, r)); };
  /* правка «как у прораба» (как в js/daily.js): по одной красной цели, пока все не зелёные */
  function solve(L, g0) {
    const g = clone(g0), steps = [];
    for (let it = 0; it < 8; it++) {
      const gs = every(L, g), bad = gs.findIndex(x => !x.ok);
      if (bad < 0) return { g, steps };
      const w = SD.learn && SD.learn.analyze ? SD.learn.analyze(L, g, bad) : null; if (!w || !w.fix) return null;
      w.fix.forEach(c => { const n = g.nodes.find(x => x.id === c.id); if (n) { n.props[c.key] = c.to; steps.push(c); } });
    }
    return null;
  }
  function specOf(L, g, steps) {
    const pre = new Set((L.preset || []).map(p => p[0]));
    const nm = id => { const n = g.nodes.find(x => x.id === id); return n ? (n.label || tn(n.type)) : id; };
    const seen = {}; steps.forEach(c => { const k = c.id + '|' + c.key; seen[k] = seen[k] ? Object.assign(seen[k], { to: c.to }) : Object.assign({}, c); });
    return {
      nodes: g.nodes.filter(n => !pre.has(n.id)).map(n => [n.id, n.type, n.x, n.y, n.props, n.label]),
      edges: g.edges.map(e => [e.from, e.to, e.props]),
      note: 'Эталон под испытанием: ' + Object.values(seen).map(c => `«${nm(c.id)}» ${c.key === 'count' ? '' : (c.label || c.key).toLowerCase() + ' '}${c.from} → ${c.to}`).join(', ') + '.'
    };
  }
  const memo = {};
  function derive(code) {
    const p = parseGroup(code); if (!p) return null;
    if (memo[p.code]) return memo[p.code];
    const B = baseById(p.l); if (!fit(B) || !TASK_RE.test(idOf(p))) return null;
    const ev = p.e ? EVS().find(x => x.id === p.e) : null; if (p.e && !ev) return null;
    let D, holds = false;
    if (ev) {
      const tr = {}; Object.entries(B.traffic || {}).forEach(([k, v]) => { tr[k] = k === 'bot' ? v : v * (ev.t[k] || ev.t.all || 1); });
      D = Object.assign({}, B, {
        story: `${ev.story} На площадке — эталон уровня «${B.title}». Под таким испытанием он ломается: перестрой, чтобы цели снова стали зелёными.`,
        chips: [ev.chip].concat(B.chips || []).slice(0, 4), traffic: tr, stretch: undefined,
        goals: (B.goals || []).map(g => g.t === 'cost' ? Object.assign({}, g, { max: Math.round(g.max * ev.cost) }) : g),
        hints: [{ text: ev.hint, why: ev.story }].concat(B.hints || []).slice(0, 3),
        start: B.solution
      });
      const g0 = buildGraph(D, B.solution);
      if (every(D, g0).every(x => x.ok)) { holds = true; D.solution = B.solution; }
      else { const s = solve(D, g0); D.solution = s ? specOf(D, s.g, s.steps) : null; if (s) D.stretch = { cost: Math.ceil(SD.sim.run(D, s.g, { mul: 1 }).cost / 10) * 10 }; }
    } else D = Object.assign({}, B);
    Object.assign(D, {
      id: idOf(p), title: B.title + (ev ? ' — ' + ev.title : ''), decisions: [],
      group: { code: p.code, base: B.id, baseTitle: B.title, ev: ev ? ev.id : '', evTitle: ev ? ev.title : '', min: p.m, tag: p.tag, holds }
    });
    memo[p.code] = D;
    return D;
  }
  const goalsMemo = {};
  /* тексты целей без схемы: прогон на стартовой схеме */
  function goalsOf(L) {
    if (goalsMemo[L.id]) return goalsMemo[L.id];
    let gs = [];
    try { gs = every(L, buildGraph(L, L.start || null)).map(x => x.text); } catch (e) { gs = (L.goals || []).map(x => x.t); }
    return (goalsMemo[L.id] = gs);
  }

  /* ---------- код решения ---------- */
  const diff = (obj, def) => { const o = {}; Object.keys(obj || {}).forEach(k => { if (JSON.stringify(obj[k]) !== JSON.stringify(def[k])) o[k] = obj[k]; }); return o; };
  /* opts.u — метка устройства (для проверок: несколько «учеников» в одном окне) */
  function solutionCode(opts) {
    const A = SD.app.A, L = A.level, G = L && L.group; if (!G) return '';
    const g = A.graph, idx = {};
    g.nodes.forEach((n, i) => { idx[n.id] = i; });
    const n = g.nodes.map(x => { const p = diff(x.props, SD.defaultsFor(x.type)); const r = [x.id, x.type, Math.round(x.x), Math.round(x.y)]; if (Object.keys(p).length || x.label) r.push(p); if (x.label) r.push(x.label); return r; });
    const e = g.edges.filter(x => idx[x.from] != null && idx[x.to] != null).map(x => { const p = diff(x.props, SD.edgeDefaults()); return Object.keys(p).length ? [idx[x.from], idx[x.to], p] : [idx[x.from], idx[x.to]]; });
    const st = U.stu[G.code], s = st ? Math.max(0, Math.round((Date.now() - st.t0) / 1000)) : 0;
    const body = b64(JSON.stringify({ v: 1, g: G.code, u: (opts && opts.u) || U.dev, s, ts: Math.round(Date.now() / 1000), n, e }));
    return 'sdg.' + body + '.' + chk(body);
  }
  const CODE_RE = /sdg\.[A-Za-z0-9_-]{8,}\.[a-z0-9]{3}/g;
  function decodeSol(str) {
    const m = /^sdg\.([A-Za-z0-9_-]+)\.([a-z0-9]{3})$/.exec(String(str || '').trim());
    if (!m) return { err: 'это не код решения' };
    if (chk(m[1]) !== m[2]) return { err: 'код скопирован не целиком' };
    let d = null; try { d = JSON.parse(unb64(m[1])); } catch (e) { d = null; }
    if (!d || d.v !== 1 || !Array.isArray(d.n) || !Array.isArray(d.e) || !parseGroup(d.g)) return { err: 'код повреждён' };
    return d;
  }
  /* схема из кода: данные чужие — типы и числа проверяем, лишнее отбрасываем */
  const prim = v => v == null || ['string', 'number', 'boolean'].includes(typeof v);
  function cleanProps(type, p) {
    const out = {}, defs = (T()[type] || {}).props || [];
    Object.entries(p && typeof p === 'object' ? p : {}).forEach(([k, v]) => {
      if (k === '__proto__' || k === 'constructor') return;
      const d = defs.find(x => x.key === k);
      if (d && d.type === 'range') { const x = +v; if (isFinite(x)) out[k] = Math.max(d.min, Math.min(d.max, x)); return; }
      if (prim(v) && String(v).length <= 80) { out[k] = v; return; }
      if (Array.isArray(v) && v.length <= 40 && v.every(prim)) out[k] = v.slice();
    });
    return out;
  }
  function graphOfSol(L, d) {
    const nodes = [], edges = [], ids = [];
    d.n.slice(0, 120).forEach(r => {
      const [id, type, x, y, props, label] = Array.isArray(r) ? r : [];
      if (!T()[type] || id == null || nodes.some(n => n.id === String(id))) { ids.push(null); return; }
      ids.push(String(id));
      const cl = v => Math.max(-20000, Math.min(20000, +v || 0));
      nodes.push({ id: String(id), type, x: cl(x), y: cl(y), props: Object.assign(SD.defaultsFor(type), cleanProps(type, props)), label: typeof label === 'string' ? label.slice(0, 60) : (type === 'external' && L.ext ? L.ext.name : undefined) });
    });
    const ed = SD.edgeDefaults();
    d.e.slice(0, 300).forEach((r, i) => {
      if (!Array.isArray(r)) return;
      const a = ids[r[0]], b = ids[r[1]]; if (!a || !b) return;
      const p = {}; Object.entries(r[2] && typeof r[2] === 'object' ? r[2] : {}).forEach(([k, v]) => { if (k in ed && typeof v === typeof ed[k]) p[k] = v; });
      edges.push({ id: 'e' + i + '_' + a + '_' + b, from: a, to: b, props: Object.assign(SD.edgeDefaults(), p) });
    });
    return sync({ nodes, edges });
  }

  /* ---------- оценка решения: js/free.js evaluate (100 баллов) + виновники из js/learn.js analyze ---------- */
  const scoreLabel = t => t >= 90 ? 'Отлично: решение уровня сеньора' : t >= 75 ? 'Хорошо: держит требования с запасом' : t >= 55 ? 'Работает, но есть риски' : t > 0 ? 'Пока не выдерживает требования' : 'Схема пустая';
  function lite(L, g) {
    const r = SD.sim.run(L, g, { mul: 1 }), ch = SD.sim.chaos(L, g), goals = SD.evalGoals(L, g, r, ch, SD.sim.analyze(L, g, r));
    const sMin = ((L.goals || []).find(x => x.t === 'success') || { min: 0.999 }).min, at = m => SD.sim.run(L, g, { mul: m }).total.success;
    const s12 = at(1.2), s15 = at(1.5), s2 = at(2);
    let det = { applied: [], needed: [], anti: [] }; try { if (SD.archLens) det = SD.archLens.detect(g, r); } catch (e) { /* без линзы */ }
    const built = g.nodes.some(n => n.type !== 'client'), gOk = goals.filter(x => x.ok).length, gN = goals.length || 1, chOk = ch.filter(c => c.ok).length;
    const sc = { req: gOk / gN, head: s15 >= sMin ? 1 : s12 >= sMin ? 0.7 : r.total.success >= sMin ? 0.4 : 0, rel: ch.length ? chOk / ch.length : 0, cost: 0.6, arch: 0.6 };
    const total = built ? Math.round(100 * (0.5 * sc.req + 0.2 * sc.head + 0.2 * sc.rel + 0.1 * sc.arch)) : 0;
    return { me: { r, ch, goals, s12, s15, s2, det, sMin }, sc, total, good: [], fix: goals.filter(x => !x.ok).map(x => `Не выполнено: ${x.text.toLowerCase()} — ${x.detail}.`), pats: [...new Set(det.applied.map(p => p.id))], built };
  }
  function evalOne(L, g) {
    const cap = {}, lrn = SD.learn, orig = lrn && lrn.analyze;
    let E = null;
    if (SD.free && SD.free.evaluate) {
      /* evaluate сам зовёт analyze для красных целей — подслушиваем, чтобы не считать дважды */
      if (orig) lrn.analyze = (L2, g2, i) => { const w = orig(L2, g2, i); if (g2 === g) cap[i] = w; return w; };
      try { E = SD.free.evaluate({ level: L, graph: g }); } catch (e) { E = null; } finally { if (orig) lrn.analyze = orig; }
    }
    if (!E) E = lite(L, g);
    const me = E.me, r = me.r, lg = L.goals || [];
    const fail = me.goals.map((x, i) => x.ok ? -1 : i).filter(i => i >= 0);
    fail.forEach(i => { if (!(i in cap) && orig) { try { cap[i] = orig(L, g, i); } catch (e) { cap[i] = null; } } });
    const typeOf = id => { const n = g.nodes.find(x => x.id === id); return n ? n.type : null; };
    const cul = {}, an = {};
    fail.forEach(i => { const w = cap[i]; cul[i] = w && w.marks ? [...new Set(w.marks.map(m => typeOf(m.id)).filter(Boolean))] : []; an[i] = (w && w.an) || ''; });
    const kl = {}; Object.entries(r.kinds || {}).forEach(([k, v]) => { kl[k] = v.lat; });
    const chOk = me.ch.filter(c => c.ok).length, chN = me.ch.length;
    return {
      score: E.total, label: scoreLabel(E.total), built: E.built !== false,
      ok: me.goals.length > 0 && me.goals.every(x => x.ok), gOk: me.goals.filter(x => x.ok).length, gN: me.goals.length,
      goals: me.goals.map((x, i) => ({ text: x.text, detail: x.detail, ok: !!x.ok, t: lg[i] && lg[i].t })),
      cost: r.cost, lat: r.total.lat, kl, succ: r.total.success, chOk, chN, rel: chN ? chOk / chN : 0, s2: me.s2, head: E.sc ? E.sc.head : 0,
      types: [...new Set(g.nodes.filter(n => n.type !== 'client').map(n => n.type))], boxes: g.nodes.filter(n => n.type !== 'client').length,
      pats: E.pats || [], need: ((me.det || {}).needed || []).map(p => ({ id: p.id, why: p.why || '' })), anti: ((me.det || {}).anti || []).map(a => ({ id: a.id, name: a.name || '', text: a.text || '' })),
      spof: me.ch.filter(c => !c.ok).map(c => typeOf(c.id)).filter(Boolean), cul, an, good: E.good || [], fix: E.fix || []
    };
  }

  /* ---------- шина между экраном и пультом (как в «Арене») ---------- */
  const bus = (() => {
    const me = rnd(8), seen = new Set(), hs = [];
    let bc = null;
    try { bc = new BroadcastChannel('amp-stroyka-group'); } catch (e) { bc = null; }
    const take = m => { if (!m || m.from === me || seen.has(m.r)) return; seen.add(m.r); if (seen.size > 400) seen.clear(); hs.forEach(h => { try { h(m); } catch (e) { /* обработчик не должен ронять шину */ } }); };
    if (bc) bc.onmessage = e => take(e.data);
    window.addEventListener('storage', e => { if (e.key === BUS && e.newValue) { try { take(JSON.parse(e.newValue)); } catch (er) { /* чужая запись */ } } });
    return {
      send(m) {
        const msg = Object.assign({}, m, { from: me, r: me + '.' + Date.now() + '.' + Math.random() });
        try { if (bc) bc.postMessage(msg); } catch (e) { /* канал закрыт */ }
        try { localStorage.setItem(BUS, JSON.stringify(msg)); } catch (e) { /* хранилище недоступно */ }
      },
      on(h) { hs.push(h); }
    };
  })();
  const isPult = /^#group-pult$/.test(location.hash || '');

  /* ---------- состояние экрана наставника ---------- */
  const S = { on: false, sess: null, res: {}, ref: null, refFor: '', busy: false, paste: false, draft: '', canvas: null };
  const lvl = () => S.sess ? derive(S.sess.code) : null;
  const tLeft = t => t.run ? Math.max(0, t.left - (Date.now() - t.at) / 1000) : t.left;
  const persist = () => { U.sess = S.sess; save(); };
  const pending = () => S.sess ? S.sess.sols.filter(x => !S.res[x.code]).length + (S.refFor !== S.sess.code ? 1 : 0) : 0;
  function startSess(o) {
    const B = baseById(o.level); if (!fit(B)) return null;
    const m = Math.max(1, Math.min(180, +o.min || 15)), code = makeGroup(B.id, o.ev || '', m);
    if (!derive(code)) return null;
    S.sess = { code, stage: 'case', hints: 0, timer: { len: m * 60, left: m * 60, run: false, at: 0 }, sols: [], rev: 0, made: Date.now() };
    S.res = {}; S.ref = null; S.refFor = ''; S.on = true; S.paste = false;
    U.lastLv = B.id; U.lastEv = o.ev || ''; U.lastMin = m; persist();
    pump();
    return code;
  }
  const linkOf = code => location.href.split('#')[0] + '#group=' + code;
  /* коды из любого текста: можно вставить сообщения чата целиком */
  function addCodes(text) {
    const s = S.sess; if (!s) return { found: 0, added: 0 };
    const q = parseGroup(s.code), found = String(text || '').match(CODE_RE) || [];
    const out = { found: found.length, added: 0, replaced: 0, same: 0, other: 0, bad: 0 };
    found.forEach(c => {
      const d = decodeSol(c); if (d.err) { out.bad++; return; }
      const p = parseGroup(d.g);
      if (p.l !== q.l || p.e !== q.e) { out.other++; return; }
      const u = String(d.u || c.slice(-6)), i = s.sols.findIndex(x => x.u === u);
      if (i < 0) { s.sols.push({ u, code: c, ts: +d.ts || 0, s: +d.s || 0 }); out.added++; }
      else if (s.sols[i].code === c) out.same++;
      else if ((+d.ts || 0) >= (s.sols[i].ts || 0)) { s.sols[i] = { u, code: c, ts: +d.ts || 0, s: +d.s || 0 }; out.replaced++; }
      else out.same++;
    });
    persist(); pump();
    return out;
  }
  /* оцениваем по одному решению за такт — экран не замирает */
  function pump() {
    if (S.busy || !S.sess) return;
    const L = lvl(); if (!L) return;
    const next = S.refFor !== S.sess.code ? 'ref' : S.sess.sols.find(x => !S.res[x.code]);
    if (!next) { render(); broadcast(); return; }
    S.busy = true;
    setTimeout(() => {
      try {
        if (next === 'ref') { S.ref = L.solution ? evalOne(L, buildGraph(L, L.solution)) : null; S.refFor = S.sess.code; }
        else { const d = decodeSol(next.code); let R = { err: d.err || 'не разобрал' }; if (!d.err) { try { R = evalOne(L, graphOfSol(L, d)); } catch (e) { R = { err: 'не получилось посчитать' }; } } S.res[next.code] = R; }
      } finally { S.busy = false; }
      render(); broadcast(); pump();
    }, 0);
  }
  const sols = () => S.sess ? S.sess.sols : [];
  const resOf = i => { const x = sols()[i]; return x ? S.res[x.code] : null; };

  /* ---------- мини-схема (SVG): узлы и связи как на площадке, без анимации ---------- */
  let svgN = 0;
  function brief(n) {
    const p = n.props || {}, out = [];
    if (p.count > 1) out.push('×' + p.count);
    if (p.replicas) out.push('реплик ' + p.replicas);
    if (p.shards > 1) out.push('шардов ' + p.shards);
    if (p.partitions > 1) out.push('партиций ' + p.partitions);
    if (n.type === 'cache' && p.mem) out.push(p.mem + ' ГБ');
    return out.join(' · ');
  }
  function schemaSvg(g) {
    const ns = g.nodes; if (!ns.length) return '<p class="gr-empty">Схема пустая.</p>';
    const W = 188, H = 64, pad = 28, id = 'grA' + (++svgN);
    const x0 = Math.min(...ns.map(n => n.x)) - pad, y0 = Math.min(...ns.map(n => n.y)) - pad;
    const vw = Math.max(...ns.map(n => n.x)) + W + pad - x0, vh = Math.max(...ns.map(n => n.y)) + H + pad - y0;
    const by = {}; ns.forEach(n => { by[n.id] = n; });
    const edge = (a, b) => {
      const ca = [a.x + W / 2, a.y + H / 2], cb = [b.x + W / 2, b.y + H / 2], dx = cb[0] - ca[0], dy = cb[1] - ca[1];
      const cut = (c, s) => { const tx = dx ? (W / 2 + 4) / Math.abs(dx) : Infinity, ty = dy ? (H / 2 + 4) / Math.abs(dy) : Infinity, t = Math.min(tx, ty); return [c[0] + s * dx * t, c[1] + s * dy * t]; };
      return [cut(ca, 1), cut(cb, -1)];
    };
    let h = `<svg class="gr-svg" viewBox="${x0} ${y0} ${vw} ${vh}" style="min-width:${Math.round(vw * 0.8)}px" role="img" aria-label="Схема решения"><defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="gr-sar"/></marker></defs>`;
    g.edges.forEach(e => {
      const a = by[e.from], b = by[e.to]; if (!a || !b) return;
      const [p, q] = edge(a, b), async = a.type === 'queue' || a.type === 'cdc' || (T()[a.type] || {}).ops || (T()[b.type] || {}).ops;
      h += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" class="gr-se${async ? ' async' : ''}" marker-end="url(#${id})"/>`;
    });
    ns.forEach(n => {
      const name = n.label || tn(n.type), b = brief(n), short = name.length > 15 ? name.slice(0, 14) + '…' : name;
      h += `<g transform="translate(${n.x} ${n.y})" class="gr-sn${(T()[n.type] || {}).ops ? ' ops' : ''}"><title>${esc(name)}${b ? ' · ' + esc(b) : ''}</title><rect width="${W}" height="${H}" rx="10"/><svg x="12" y="17" width="30" height="30" viewBox="0 0 24 24" class="gr-si" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${SD.iconInner ? SD.iconInner(n.type) : ''}</svg><text x="52" y="${b ? 29 : 38}" class="gr-st">${esc(short)}</text>${b ? `<text x="52" y="50" class="gr-sb">${esc(b)}</text>` : ''}</g>`;
    });
    return h + '</svg>';
  }

  /* ---------- QR-код (ISO/IEC 18004, алгоритм Nayuki): байтовый режим, уровни L/M, версии 1–25.
     Сверен с библиотекой qrcode (Python) на 96 матрицах и прочитан декодером jsQR. ---------- */
  const QR = (() => {
    const ECC = { L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26], M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28] };
    const BLK = { L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12], M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21] };
    const FMT = { L: 1, M: 0 };
    const raw = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const na = Math.floor(v / 7) + 2; r -= (25 * na - 10) * na - 55; if (v >= 7) r -= 36; } return r; };
    const dataCw = (v, e) => Math.floor(raw(v) / 8) - ECC[e][v] * BLK[e][v];
    const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; };
    const divisor = deg => { const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); } return r; };
    const rem = (data, div) => { const r = div.map(() => 0); data.forEach(b => { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }); return r; };
    const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    return function (text, ecl, force) {
      const bytes = Array.from(new TextEncoder().encode(text));
      let v = 1;
      while (v <= 25 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCw(v, ecl) * 8) v++;
      if (v > 25) return null;
      const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
      const cap = dataCw(v, ecl) * 8;
      put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
      put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
      for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
      const data = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
      const nb = BLK[ecl][v], el = ECC[ecl][v], rc = Math.floor(raw(v) / 8), nShort = nb - rc % nb, sLen = Math.floor(rc / nb), div = divisor(el), blocks = [];
      for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + sLen - el + (i < nShort ? 0 : 1)); k += d.length; const ec = rem(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(ec)); }
      const all = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== sLen - el || j >= nShort) all.push(b[i]); });
      const size = v * 4 + 17, M = [], Fn = [];
      for (let y = 0; y < size; y++) { M.push(new Array(size).fill(false)); Fn.push(new Array(size).fill(false)); }
      const set = (x, y, d) => { M[y][x] = d; Fn[y][x] = true; };
      for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
      const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
      finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
      const al = [];
      if (v > 1) { const na = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2; al.push(6); for (let p = size - 7; al.length < na; p -= step) al.splice(1, 0, p); }
      al.forEach((ax, i) => al.forEach((ay, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
      const fmt = m => {
        const d = FMT[ecl] << 3 | m; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
        const b = (d << 10 | r) ^ 0x5412, g = i => ((b >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, g(i)); set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, g(i)); set(8, size - 8, true);
      };
      fmt(0);
      if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = v << 12 | r; for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit); set(c, a, bit); } }
      let bi = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
          const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!Fn[y][x] && bi < all.length * 8) { M[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
        }
      }
      const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!Fn[y][x] && MASK[m](x, y)) M[y][x] = !M[y][x]; };
      const penalty = () => {
        let res = 0;
        const addH = (len, h) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
        const count = h => { const n = h[1], core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n; return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0); };
        for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
          let col = false, run = 0; const h = [0, 0, 0, 0, 0, 0, 0];
          for (let b = 0; b < size; b++) { const d = pass ? M[b][a] : M[a][b]; if (d === col) { run++; if (run === 5) res += 3; else if (run > 5) res++; } else { addH(run, h); if (!col) res += count(h) * 40; col = d; run = 1; } }
          if (col) { addH(run, h); run = 0; } run += size; addH(run, h); res += count(h) * 40;
        }
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) res += 3; }
        let dark = 0; M.forEach(r => r.forEach(d => { if (d) dark++; }));
        const tot = size * size; return res + (Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10;
      };
      let best = force >= 0 ? force : -1;
      if (best < 0) { let min = Infinity; for (let m = 0; m < 8; m++) { apply(m); fmt(m); const p = penalty(); if (p < min) { min = p; best = m; } apply(m); } }
      apply(best); fmt(best);
      return { size, v, mask: best, dark: (x, y) => M[y][x] };
    };
  })();
  function qrSvg(text) {
    const q = QR(text, 'M') || QR(text, 'L'); if (!q) return '';
    const n = q.size + 8; let d = '';
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return `<svg class="gr-qrsvg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR-код со ссылкой на кейс"><path d="${d}" fill="currentColor"/></svg>`;
  }

  /* ---------- экран наставника: окно поверх площадки ---------- */
  function ensureScr() {
    let el = $('grScr');
    if (el) return el;
    el = document.createElement('div'); el.id = 'grScr'; el.className = 'gr-scr'; el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Режим группы');
    el.innerHTML = `<header class="gr-top"><div class="gr-brand"><span class="eyebrow">Режим группы</span><b id="grHT">Разбор у доски</b></div>
      <nav class="gr-tabs" id="grTabs" aria-label="Что на экране"></nav><div class="gr-tm" id="grTm"></div>
      <div class="gr-hb"><button type="button" class="btn" data-grpult title="Второе окно: управление экраном и то, что видите только вы">Пульт ↗</button><button type="button" class="btn ghost" data-grfs>Во весь экран</button><button type="button" class="btn ghost" data-grclose>Закрыть</button></div></header>
      <main class="gr-main" id="grMain"></main>`;
    document.body.appendChild(el);
    el.addEventListener('change', e => { if (e.target.closest('[data-grset]')) preview(); });
    el.addEventListener('input', e => { if (e.target.id === 'grPaste') S.draft = e.target.value; });
    return el;
  }
  const shown = () => { const el = $('grScr'); return !!(el && !el.hidden); };
  /* пока экран группы открыт, всплывающие советы площадки (они выше по слою) на проектор не лезут */
  const onCls = () => document.documentElement.classList.toggle('gr-on', shown());
  function open() {
    if (isPult) return;
    if (!S.sess && U.sess && derive(U.sess.code)) { S.sess = U.sess; S.on = true; S.res = {}; S.ref = null; S.refFor = ''; pump(); }
    document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
    ensureScr().hidden = false; onCls();
    S.canvas = null; syncPill();
    render(); broadcast();
  }
  function close() { const el = $('grScr'); if (el) el.hidden = true; onCls(); syncPill(); if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); broadcast(); }
  function endSess() { S.sess = null; S.on = false; S.res = {}; S.ref = null; S.refFor = ''; S.canvas = null; U.sess = null; save(); syncPill(); render(); bus.send({ type: 'state', on: false }); }

  const TABS = [['case', 'Кейс'], ['ref', 'Эталон'], ['cmp', 'Сравнение'], ['rev', 'Разбор']];
  function head() {
    const s = S.sess, L = lvl();
    $('grHT').textContent = L ? L.title : 'Разбор у доски';
    $('grTabs').innerHTML = s ? `<div class="seg">${TABS.map(([k, t]) => `<button type="button" data-grtab="${k}" aria-selected="${s.stage === k}">${t}${k === 'cmp' && s.sols.length ? ` · ${s.sols.length}` : ''}</button>`).join('')}</div><button type="button" class="btn ghost gr-end" data-grend>${S.endAsk ? 'Точно? Решения пропадут' : 'Новое занятие'}</button>` : '';
    $('grTm').innerHTML = s ? `<span class="gr-clock${s.timer.run ? ' run' : ''}${tLeft(s.timer) <= 0 ? ' out' : ''}" data-grclock>${tLeft(s.timer) <= 0 ? 'Время!' : clock(tLeft(s.timer))}</span><button type="button" class="btn${s.timer.run ? '' : ' primary'}" data-grtimer="toggle">${s.timer.run ? '❚❚ Пауза' : '▶ Старт'}</button><button type="button" class="btn ghost" data-grtimer="plus" title="Добавить минуту">+1 мин</button><button type="button" class="btn ghost" data-grtimer="reset" title="Таймер заново">↺</button>` : '';
  }
  /* перерисовка не сбивает прокрутку и курсор в поле ввода (решения досчитываются, пока наставник вставляет коды) */
  function keep(box, html) {
    const a = document.activeElement, id = a && box.contains(a) && a.id, ss = id && a.selectionStart, se = id && a.selectionEnd, top = box.scrollTop;
    box.innerHTML = html; box.scrollTop = top;
    const b = id && $(id); if (b) { b.focus({ preventScroll: true }); try { b.setSelectionRange(ss, se); } catch (e) { /* поле без курсора */ } }
  }
  function render() {
    const el = $('grScr'); if (!el || el.hidden) return;
    head();
    const s = S.sess;
    keep($('grMain'), !s ? homeHtml() : s.stage === 'ref' ? refHtml() : s.stage === 'cmp' ? cmpHtml() : s.stage === 'rev' ? revHtml() : caseHtml());
    if (!s) preview();
    drawPlots();
  }

  /* ---------- главная: аналогия, как это работает, наставник или ученик ---------- */
  function homeHtml() {
    const opts = LISTS().map(([t, list]) => { const ls = (list || []).filter(fit); return ls.length ? `<optgroup label="${esc(t)}">${ls.map(L => `<option value="${esc(L.id)}"${L.id === (U.lastLv || 'short') ? ' selected' : ''}>${esc(L.title)}</option>`).join('')}</optgroup>` : ''; }).join('');
    const evs = EVS().map(e => `<option value="${e.id}"${e.id === U.lastEv ? ' selected' : ''}>${esc(e.title[0].toUpperCase() + e.title.slice(1))} (${esc(e.chip)})</option>`).join('');
    const D = SD.daily && SD.daily.today ? (() => { try { return SD.daily.today(); } catch (e) { return null; } })() : null;
    const mins = [5, 10, 15, 20, 25, 30, 45].map(m => `<option value="${m}"${m === (U.lastMin || 15) ? ' selected' : ''}>${m} мин</option>`).join('');
    const pic = [['Задача на доске', 'кейс на большом экране: история, нагрузка, цели'], ['Тетради учеников', 'схемы на своих телефонах и ноутбуках'], ['Сдать тетрадь без подписи', 'код решения: схема целиком, имени нет'], ['Разбор у доски', 'сравнение: цена, скорость, надёжность, ошибки']];
    return `<div class="gr-home">
      <section class="gr-intro">
        <p class="gr-lede">Как разбор задач у доски: все решили по-своему — сравниваем. Наставник выводит на большой экран один кейс, каждый собирает решение у себя, а потом на экране все решения рядом — без имён, «Решение 1, 2, 3…».</p>
        <div class="gr-pic" aria-label="Аналогия и термин">${pic.map(([a, b]) => `<div class="gr-pic-a">${esc(a)}</div><div class="gr-pic-ar" aria-hidden="true">→</div><div class="gr-pic-b">${esc(b)}</div>`).join('')}</div>
        <ol class="gr-steps"><li><b>Кейс на экран.</b> Выбери уровень или «Событие дня» — на проекторе крупно история, нагрузка, цели и таймер.</li><li><b>Решают у себя.</b> Ученики наводят камеру на QR-код или вводят код занятия — у каждого открывается тот же кейс.</li><li><b>Сдают кодом.</b> «Сдать решение» даёт короткий код; его присылают в чат занятия.</li><li><b>Сравниваем.</b> Вставь коды — экран покажет, кто прошёл цели, цену и скорость на графике, частые узлы и паттерны, типичные ошибки и разбор любого решения.</li></ol>
        <p class="gr-note">Сервера у тренажёра нет, поэтому решения идут через чат, а не сами. Пульт — второе окно на этом же компьютере: экран для проектора, пульт для тебя.</p>
      </section>
      <div class="gr-roles">
        <section class="gr-card gr-setup"><h2>Я наставник</h2>
          ${U.sess && derive(U.sess.code) ? `<div class="gr-resume"><span>Незаконченное занятие: «${esc(derive(U.sess.code).title)}», решений ${U.sess.sols.length}.</span><button type="button" class="btn" data-grgo="resume">Продолжить</button></div>` : ''}
          <label class="gr-f"><span>Кейс</span><select id="grLv" data-grset>${opts}</select></label>
          <label class="gr-f"><span>Испытание</span><select id="grEv" data-grset><option value="">Без испытания — собирают с нуля</option>${evs}</select></label>
          <div class="gr-f2"><label class="gr-f"><span>Время на решение</span><select id="grMin" data-grset>${mins}</select></label>${D ? `<button type="button" class="btn ghost gr-daily" data-grdaily title="Уровень и испытание из «События дня»">Взять «Событие дня»</button>` : ''}</div>
          <div class="gr-prev" id="grPrev"></div>
          <button type="button" class="btn primary gr-go" data-grstart>Вывести кейс на экран</button>
        </section>
        <section class="gr-card gr-join"><h2>Я ученик</h2>
          <p>Введи код занятия с экрана наставника — откроется тот же кейс. Проще — навести камеру телефона на QR-код.</p>
          <label class="gr-f"><span>Код занятия</span><input id="grJoinIn" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="short.-.15.K7QF"></label>
          <button type="button" class="btn primary" data-grjoin>Открыть кейс</button>
          <p class="gr-note" id="grJoinMsg"></p>
        </section>
      </div></div>`;
  }
  function preview() {
    const box = $('grPrev'); if (!box) return;
    const lv = ($('grLv') || {}).value, ev = ($('grEv') || {}).value || '', m = +(($('grMin') || {}).value || 15);
    const D = lv ? derive(makeGroup(lv, ev, m, 'PREV')) : null;
    if (!D) { box.innerHTML = '<p class="gr-note">Этот кейс в режиме группы недоступен.</p>'; return; }
    const st = ev ? (D.group.holds ? '<p class="gr-warn">Эталон выдерживает это испытание — ученикам нечего чинить. Выбери другое испытание.</p>' : D.solution ? '<p class="gr-ok">Эталон под этим испытанием ломается — ученикам есть что чинить. Эталон для разбора найден.</p>' : '<p class="gr-warn">Эталон под испытанием ломается, но правку для разбора найти не вышло — сравнение будет без эталона.</p>') : '';
    box.innerHTML = `<p>${esc(D.story)}</p><p class="gr-note">Целей: ${(D.goals || []).length}. ${ev ? 'Старт — эталон уровня под испытанием.' : 'Старт — как на уровне.'}</p>${st}`;
  }

  /* ---------- кейс на экране ---------- */
  const latGoal = L => (L.goals || []).find(x => x.t === 'latency');
  function caseHtml() {
    const s = S.sess, L = lvl(), G = L.group, link = linkOf(s.code);
    const kinds = Object.entries(L.traffic || {}).filter(([k, v]) => v > 0 && SD.KINDS[k]);
    const hints = (L.hints || []).slice(0, s.hints);
    let h = `<div class="gr-case"><section class="gr-story">
      <span class="gr-kicker">${esc(baseLabel(baseById(G.base)))}${G.evTitle ? ' · испытание: ' + esc(G.evTitle) : ''}</span>
      <h1>${esc(L.title)}</h1><p class="gr-lede">${esc(L.story)}</p>
      ${(L.chips || []).length ? `<div class="gr-chips">${L.chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
      <h3>Нагрузка</h3><div class="gr-load">${kinds.map(([k, v]) => `<div><small><i style="background:${SD.kindColor(k)}"></i>${esc(SD.KINDS[k].label)}</small><b>${F().num(v)} /с</b></div>`).join('')}</div>
      <h3>Цели — их проверит симулятор</h3><ol class="gr-goals">${goalsOf(L).map(t => `<li>${esc(t)}</li>`).join('')}</ol>`;
    if (hints.length) h += `<div class="gr-hints"><h3>Подсказки</h3>${hints.map((x, i) => `<p><b>${i + 1}.</b> ${esc(x.text || x)}</p>`).join('')}</div>`;
    h += `</section><aside class="gr-joinbox"><h3>Подключиться</h3><div class="gr-qr">${qrSvg(link)}</div>
      <p class="gr-jn">Наведи камеру телефона — откроется этот кейс. Или открой тренажёр → Ctrl+K → «Режим группы» и введи код:</p>
      <div class="gr-code" aria-label="Код занятия">${esc(s.code)}</div>
      <div class="gr-cnt"><b>${s.sols.length}</b> ${plural(s.sols.length, 'решение получено', 'решения получено', 'решений получено')}</div>
      <button type="button" class="btn" data-grtab="cmp" data-grpaste="open">Вставить коды решений</button>
      <p class="gr-note">Ссылка: <span class="gr-link">${esc(link.replace(/^https?:\/\//, ''))}</span></p></aside></div>`;
    return h;
  }

  /* ---------- эталон на экране ---------- */
  function metricRows(R, ref) {
    const row = (t, a, b) => `<tr><td>${t}</td><td>${a}</td>${ref !== undefined ? `<td>${b}</td>` : ''}</tr>`;
    const f = F(), x = ref || null;
    return row('Оценка', R.built ? `<b>${R.score}</b> / 100` : '—', x ? `${x.score} / 100` : '—')
      + row('Цели', `${R.gOk} из ${R.gN}`, x ? `${x.gOk} из ${x.gN}` : '—')
      + row('Цена в месяц', f.usd(R.cost), x ? f.usd(x.cost) : '—')
      + row('Время ответа', R.built ? f.ms(R.lat) : '—', x ? f.ms(x.lat) : '—')
      + row('Успешно', R.built ? f.pct(R.succ) : '—', x ? f.pct(x.succ) : '—')
      + row('При нагрузке ×2', R.built ? f.pct(R.s2) : '—', x ? f.pct(x.s2) : '—')
      + row('Переживает падений', `${R.chOk} из ${R.chN}`, x ? `${x.chOk} из ${x.chN}` : '—');
  }
  function refHtml() {
    const L = lvl(), R = S.ref;
    if (!L.solution) return '<div class="gr-pad"><h2>Эталона нет</h2><p class="gr-lede">Для этого испытания правку подобрать не вышло — разбирайте решения группы между собой.</p></div>';
    if (!R) return '<div class="gr-pad"><p class="gr-lede">Считаю эталон…</p></div>';
    return `<div class="gr-rev"><div class="gr-rev-h"><h2>Эталон</h2><span class="gr-badge ok">${R.score} / 100</span><span class="gr-note">Эталон — не единственно верный ответ: решение, которое выполняет цели, имеет право на жизнь.</span><button type="button" class="btn ghost" data-grcanvas="ref">Открыть на площадке</button></div>
      <div class="gr-rev-b"><section class="gr-schema">${schemaSvg(buildGraph(L, L.solution))}</section>
      <aside class="gr-side"><p class="gr-lede gr-sm">${esc(L.solution.note || '')}</p><table class="gr-mt"><tbody>${metricRows(R)}</tbody></table>
      ${R.pats.length ? `<h3>Паттерны эталона</h3><div class="gr-chips">${R.pats.map(id => `<span class="chip">${esc(pname(id))}</span>`).join('')}</div>` : ''}</aside></div></div>`;
  }

  /* ---------- сравнение решений ---------- */
  function freq(list, key) { const c = {}; list.forEach(R => [...new Set(R[key])].forEach(t => { c[t] = (c[t] || 0) + 1; })); return c; }
  function errors() {
    const L = lvl(), rs = sols().map(x => S.res[x.code]).filter(R => R && !R.err), M = rs.length, ref = S.ref; if (!M || !L) return [];
    const top = arr => { const c = {}; arr.forEach(t => { c[t] = (c[t] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `«${tn(t)}» — у ${n}`).join(', '); };
    const gt = goalsOf(L), out = [];
    (L.goals || []).forEach((lg, i) => {
      const bad = rs.filter(R => R.goals[i] && !R.goals[i].ok); if (!bad.length) return;
      const an = ((bad.find(R => R.an[i]) || { an: {} }).an[i] || '').trim(), tt = top(bad.flatMap(R => R.cul[i] || []));
      out.push({ n: bad.length, of: M, k: 0, title: `Не выполнено: ${(gt[i] || lg.t).replace(/^./, c => c.toLowerCase())}`, text: tt ? `${an || 'Где искать:'} ${tt}.` : an.replace(/:$/, '.') });
    });
    /* если кейс требует пережить падение, это уже сказано целью выше — отдельный пункт не повторяем */
    const sp = (L.goals || []).some(x => x.t === 'survive') ? [] : rs.filter(R => R.spof.length);
    if (sp.length) out.push({ n: sp.length, of: M, k: 1, title: 'Единая точка отказа', text: `Кейс этого не требует, но стоит знать. Как мост на одной опоре: убери её — и всё рухнет. Без запасного чаще всего: ${top(sp.flatMap(R => [...new Set(R.spof)]))}.` });
    const nh = rs.filter(R => R.ok && R.head < 0.7);
    if (nh.length) out.push({ n: nh.length, of: M, k: 2, title: 'Нет запаса на рост', text: 'Как маршрутка, набитая под завязку: следующий пассажир уже не влезет. Цели выполнены, но при росте нагрузки на 20 % начнутся отказы.' });
    const need = {}; rs.forEach(R => R.need.forEach(p => { need[p.id] = need[p.id] || { n: 0, why: p.why }; need[p.id].n++; }));
    Object.entries(need).sort((a, b) => b[1].n - a[1].n).slice(0, 2).forEach(([id, x]) => out.push({ n: x.n, of: M, k: 3, title: `Не хватает паттерна «${pname(id)}»`, text: x.why || 'Линза «Паттерны» на площадке покажет, куда его поставить.' }));
    const anti = {}; rs.forEach(R => R.anti.forEach(a => { const k = a.id || a.name; anti[k] = anti[k] || { n: 0, a }; anti[k].n++; }));
    Object.values(anti).sort((a, b) => b.n - a.n).slice(0, 2).forEach(x => out.push({ n: x.n, of: M, k: 4, title: `Антипаттерн «${x.a.name || pname(x.a.id)}»`, text: x.a.text || '' }));
    if (ref) { const ex = rs.filter(R => R.cost > ref.cost * 1.4); if (ex.length) out.push({ n: ex.length, of: M, k: 5, title: 'Дороже эталона в 1,4 раза и больше', text: 'Как такси там, где хватило бы автобуса: обычно это лишние экземпляры, которые почти не загружены.' }); }
    return out.sort((a, b) => b.n - a.n || a.k - b.k).slice(0, 6);
  }
  function cmpHtml() {
    const s = S.sess, L = lvl(), n = s.sols.length, rs = s.sols.map((x, i) => ({ i, R: S.res[x.code] })), ok = rs.filter(x => x.R && !x.R.err), ref = S.ref, wait = pending();
    let h = `<div class="gr-cmp"><div class="gr-cmp-h"><h2>Сравнение решений группы</h2><span class="gr-note">${n ? `${n} ${plural(n, 'решение', 'решения', 'решений')} · без имён${wait ? ` · считаю: осталось ${wait}` : ''}` : 'решений пока нет'}</span>${n ? `<button type="button" class="btn" data-grpaste="toggle">${S.paste ? 'Спрятать поле' : 'Добавить коды'}</button>` : ''}</div>`;
    if (S.paste || !n) h += `<div class="gr-paste"><label for="grPaste">Вставь коды решений — можно целые сообщения из чата, коды найду сам. Повторная сдача с того же устройства заменит прежнее решение.</label><textarea id="grPaste" rows="4" spellcheck="false" placeholder="sdg.eyJ2Ijox….k3f">${esc(S.draft)}</textarea><div class="gr-row"><button type="button" class="btn primary" data-gradd>Добавить</button><span class="gr-note" id="grAddMsg">${esc(S.addMsg || '')}</span></div></div>`;
    if (!ok.length) return h + (n ? '<p class="gr-lede gr-pad">Считаю решения…</p>' : '<p class="gr-lede gr-pad">Ученики нажимают «Сдать решение» и присылают код в чат. Вставь коды сюда — появится сравнение.</p>') + '</div>';
    const gt = goalsOf(L), lgL = latGoal(L);
    /* график и кто прошёл цели */
    h += `<div class="gr-r2"><section class="gr-card"><h3>Цена × время ответа × надёжность</h3><div class="gr-plot" data-grplot></div>
      <div class="gr-legend"><span><i class="gr-lg ok"></i>переживает падение любого узла</span><span><i class="gr-lg warn"></i>части узлов</span><span><i class="gr-lg bad"></i>падает от одного сбоя</span><span><i class="gr-lg hollow"></i>контур — не все цели</span>${ref ? '<span><i class="gr-lg ref"></i>эталон</span>' : ''}</div>
      <p class="gr-note">Лучше — левее и ниже: дешевле и быстрее. Нажми на точку — разбор решения.</p></section>
      <section class="gr-card"><h3>Кто прошёл цели</h3><div class="gr-scroll"><table class="gr-pass"><thead><tr><th>Цель</th>${ref ? '<th title="Эталон">Эт.</th>' : ''}${ok.map(x => `<th><button type="button" class="linkish" data-grrev="${x.i}">${x.i + 1}</button></th>`).join('')}<th>Прошли</th></tr></thead><tbody>`;
    (L.goals || []).forEach((lg, gi) => {
      const pass = ok.filter(x => x.R.goals[gi] && x.R.goals[gi].ok).length;
      h += `<tr><td>${esc(gt[gi] || lg.t)}</td>${ref ? `<td class="${ref.goals[gi] && ref.goals[gi].ok ? 'ok' : 'bad'}">${ref.goals[gi] && ref.goals[gi].ok ? '✓' : '✗'}</td>` : ''}${ok.map(x => { const g = x.R.goals[gi]; return `<td class="${g && g.ok ? 'ok' : 'bad'}" title="${esc(g ? g.detail : '')}">${g && g.ok ? '✓' : '✗'}</td>`; }).join('')}<td><b>${pass}</b> из ${ok.length}</td></tr>`;
    });
    const all = ok.filter(x => x.R.ok).length;
    h += `<tr class="gr-all"><td>Все цели</td>${ref ? `<td class="${ref.ok ? 'ok' : 'bad'}">${ref.ok ? '✓' : '✗'}</td>` : ''}${ok.map(x => `<td class="${x.R.ok ? 'ok' : 'bad'}">${x.R.ok ? '✓' : '✗'}</td>`).join('')}<td><b>${all}</b> из ${ok.length}</td></tr></tbody></table></div></section></div>`;
    /* таблица */
    const budget = (L.goals || []).find(x => x.t === 'cost'), f = F();
    const latV = R => lgL && lgL.kind && lgL.kind !== 'all' ? R.kl[lgL.kind] : R.lat;
    const tr = (no, R, x) => `<tr${no === 'Э' ? ' class="gr-refrow"' : ''}><td>${no === 'Э' ? 'Эталон' : 'Решение ' + no}</td><td><b>${R.built ? R.score : 0}</b></td><td class="${R.ok ? 'ok' : 'bad'}">${R.gOk} из ${R.gN}</td><td class="${budget && R.cost > budget.max ? 'bad' : ''}">${f.usd(R.cost)}</td><td class="${lgL && latV(R) > lgL.max ? 'bad' : ''}">${R.built && isFinite(latV(R)) ? f.ms(latV(R)) : '—'}</td><td>${R.built ? f.pct(R.succ) : '—'}</td><td class="${R.chN && R.chOk < R.chN ? 'warn' : ''}">${R.chOk} из ${R.chN}</td><td>${R.built ? f.pct(R.s2) : '—'}</td><td>${R.boxes}</td><td>${x && x.s ? clock(x.s) : '—'}</td><td class="gr-act">${no === 'Э' ? '<button type="button" class="btn ghost" data-grtab="ref">Показать</button>' : `<button type="button" class="btn ghost" data-grrev="${no - 1}">Разобрать</button><button type="button" class="btn ghost gr-x" data-grdrop="${no - 1}" title="Убрать из сравнения" aria-label="Убрать решение ${no}">×</button>`}</td></tr>`;
    h += `<section class="gr-card"><h3>Таблица</h3><div class="gr-scroll"><table class="gr-tbl"><thead><tr><th></th><th>Оценка</th><th>Цели</th><th>Цена в месяц</th><th>${lgL && lgL.kind && SD.KINDS[lgL.kind] ? 'Время: ' + esc(SD.KINDS[lgL.kind].label.toLowerCase()) : 'Время ответа'}</th><th>Успешно</th><th>Падения</th><th>При ×2</th><th>Узлов</th><th>Решал</th><th></th></tr></thead><tbody>`;
    if (ref) h += tr('Э', ref, null);
    rs.forEach(x => { if (x.R && !x.R.err) h += tr(x.i + 1, x.R, s.sols[x.i]); else if (x.R) h += `<tr><td>Решение ${x.i + 1}</td><td colspan="9" class="bad">Код не разобрался: ${esc(x.R.err)}</td><td class="gr-act"><button type="button" class="btn ghost gr-x" data-grdrop="${x.i}" aria-label="Убрать решение ${x.i + 1}">×</button></td></tr>`; });
    h += '</tbody></table></div></section>';
    /* узлы, паттерны, ошибки */
    const R0 = ok.map(x => x.R), M = R0.length;
    const bars = (cnt, inRef, name, icon) => Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, c]) => `<div class="gr-bar"><span class="gr-bl">${icon ? SD.icon(k, 'gr-bi') : ''}<span>${esc(name(k))}${inRef.includes(k) ? '<em>в эталоне</em>' : ''}</span></span><span class="gr-bt"><i style="width:${Math.round(c / M * 100)}%"></i></span><b>${c} из ${M}</b></div>`).join('');
    const tc = freq(R0, 'types'), pc = freq(R0, 'pats');
    (ref ? ref.types : []).forEach(t => { if (!(t in tc)) tc[t] = 0; });
    (ref ? ref.pats : []).forEach(p => { if (!(p in pc)) pc[p] = 0; });
    const missRef = ref ? ref.pats.filter(p => (pc[p] || 0) < M / 2) : [];
    const er = errors();
    h += `<div class="gr-r3"><section class="gr-card"><h3>Что ставили</h3>${bars(tc, ref ? ref.types : [], tn, true) || '<p class="gr-note">Пусто.</p>'}</section>
      <section class="gr-card"><h3>Паттерны</h3>${bars(pc, ref ? ref.pats : [], pname, false) || '<p class="gr-note">Паттернов на схемах не нашлось.</p>'}${missRef.length ? `<p class="gr-note">В эталоне, но у группы редко: ${missRef.map(p => '«' + esc(pname(p)) + '»').join(', ')}.</p>` : ''}</section>
      <section class="gr-card"><h3>Типичные ошибки</h3>${er.length ? `<ol class="gr-err">${er.map(e => `<li><span class="gr-n">у ${e.n} из ${e.of}</span><b>${esc(e.title)}</b>${e.text ? `<p>${esc(e.text)}</p>` : ''}</li>`).join('')}</ol>` : '<p class="gr-ok">Ошибок, общих для группы, нет — все решения выполняют цели.</p>'}</section></div>`;
    return h + '</div>';
  }

  /* ---------- точечный график: цена × время ответа, цвет — надёжность, заливка — все цели ---------- */
  function niceTicks(max, n) {
    const raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p, st = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p, out = [];
    for (let v = 0; v < max + st * 0.999; v += st) out.push(v);
    return out;
  }
  function plotSvg(w) {
    const L = lvl(), s = S.sess, ref = S.ref, lgL = latGoal(L), lgC = (L.goals || []).find(x => x.t === 'cost'), f = F();
    const latOf = R => lgL && lgL.kind && lgL.kind !== 'all' ? (R.kl[lgL.kind] != null ? R.kl[lgL.kind] : Infinity) : R.lat;
    const pts = s.sols.map((x, i) => ({ no: i + 1, R: S.res[x.code] })).filter(p => p.R && !p.R.err && p.R.built).map(p => ({ no: p.no, R: p.R, x: p.R.cost, y: latOf(p.R) }));
    const rp = ref ? { x: ref.cost, y: latOf(ref), R: ref } : null;
    const fin = v => isFinite(v) && v >= 0;
    const h = Math.round(Math.max(260, Math.min(440, w * 0.58))), m = { l: 84, r: 22, t: 32, b: 52 };
    const xs = pts.map(p => p.x).concat(rp ? [rp.x] : [], lgC ? [lgC.max] : []).filter(fin);
    const ys = pts.map(p => p.y).concat(rp ? [rp.y] : []).filter(fin);
    const cap = Math.max(lgL ? lgL.max * 3 : 0, rp && fin(rp.y) ? rp.y * 3 : 0);
    let ym = Math.max(...ys, lgL ? lgL.max * 1.2 : 0, 10); if (cap && ym > cap) ym = cap;
    const xt = niceTicks(Math.max(...xs, 10) * 1.08, 4), yt = niceTicks(ym * 1.08, 4), xm = xt[xt.length - 1], yM = yt[yt.length - 1];
    const X = v => m.l + Math.min(v, xm) / xm * (w - m.l - m.r), Y = v => h - m.b - Math.min(v, yM) / yM * (h - m.t - m.b);
    let g = `<svg class="gr-psvg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Точечный график решений: цена против времени ответа">`;
    if (lgC || lgL) {
      const x1 = lgC ? X(lgC.max) : X(xm), y1 = lgL ? Y(lgL.max) : Y(yM);
      g += `<rect x="${m.l}" y="${y1}" width="${Math.max(0, x1 - m.l)}" height="${Math.max(0, h - m.b - y1)}" class="gr-zone"/><text x="${m.l + 8}" y="${y1 + 18}" class="gr-zt">зона целей</text>`;
    }
    xt.forEach((v, i) => { g += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${h - m.b}" class="gr-gl"/><text x="${X(v)}" y="${h - m.b + 18}" text-anchor="${i === xt.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}" class="gr-ax">${esc(f.usd(v))}</text>`; });
    yt.forEach(v => { g += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="gr-gl"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="gr-ax">${esc(f.ms(v))}</text>`; });
    if (lgC) g += `<line x1="${X(lgC.max)}" x2="${X(lgC.max)}" y1="${m.t}" y2="${h - m.b}" class="gr-gline"/>`;
    if (lgL) g += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(lgL.max)}" y2="${Y(lgL.max)}" class="gr-gline"/>`;
    g += `<text x="${(m.l + w - m.r) / 2}" y="${h - 10}" text-anchor="middle" class="gr-axt">Цена в месяц${lgC ? ' · пунктир — бюджет ' + esc(f.usd(lgC.max)) : ''}</text>`;
    g += `<text transform="translate(16 ${(m.t + h - m.b) / 2}) rotate(-90)" text-anchor="middle" class="gr-axt">${lgL && lgL.kind && SD.KINDS[lgL.kind] ? 'Время: ' + esc(SD.KINDS[lgL.kind].label.toLowerCase()) : 'Время ответа'}${lgL ? ' · цель ≤ ' + esc(f.ms(lgL.max)) : ''}</text>`;
    const used = [];
    /* совпавшие точки (одинаковые схемы) раздвигаем, чтобы номера читались */
    const place = (x, y) => { let k = 0; const x0 = x; while (used.some(u => Math.hypot(u[0] - x, u[1] - y) < 28) && k < 16) { k++; x = x0 + 30 * (k % 4); if (k % 4 === 0) y -= 30; } used.push([x, y]); return [x, y]; };
    if (rp) { const over = !fin(rp.y) || rp.y > yM, [cx, cy] = place(X(rp.x), over ? m.t + 6 : Y(rp.y)); g += `<g class="gr-pt gr-ptref" data-grtab="ref" tabindex="0"><title>Эталон: ${rp.R.score} / 100 · ${esc(f.usd(rp.x))} · ${esc(fin(rp.y) ? f.ms(rp.y) : '—')}</title><path d="M${cx} ${cy - 15}L${cx + 15} ${cy}L${cx} ${cy + 15}L${cx - 15} ${cy}Z"/><text x="${cx}" y="${cy - 20}" text-anchor="middle" class="gr-reft">эталон</text></g>`; }
    pts.forEach(p => {
      const over = !fin(p.y) || p.y > yM, [cx, cy] = place(X(p.x), over ? m.t + 6 : Y(p.y));
      const rel = p.R.chN ? p.R.chOk / p.R.chN : 0, cls = rel >= 0.999 ? 'ok' : rel >= 0.5 ? 'warn' : 'bad';
      g += `<g class="gr-pt ${cls}${p.R.ok ? '' : ' hollow'}" data-grrev="${p.no - 1}" tabindex="0"><title>Решение ${p.no}: ${p.R.score} / 100 · цели ${p.R.gOk} из ${p.R.gN} · ${esc(f.usd(p.x))} в месяц · ${over ? 'дольше ' + esc(f.ms(yM)) : esc(f.ms(p.y))} · переживает ${p.R.chOk} из ${p.R.chN} падений</title><circle cx="${cx}" cy="${cy}" r="14"/><text x="${cx}" y="${cy + 5}" text-anchor="middle">${p.no}</text>${over ? `<text x="${cx}" y="${cy - 18}" text-anchor="middle" class="gr-over">↑</text>` : ''}</g>`;
    });
    return g + '</svg>';
  }
  function drawPlots() {
    document.querySelectorAll('[data-grplot]').forEach(box => { const w = Math.max(300, Math.floor(box.clientWidth || 600)); box.innerHTML = plotSvg(w); });
  }

  /* ---------- разбор одного решения ---------- */
  function revHtml() {
    const s = S.sess, n = s.sols.length;
    if (!n) return '<div class="gr-pad"><h2>Разбирать пока нечего</h2><p class="gr-lede">Вставь коды решений во вкладке «Сравнение».</p><button type="button" class="btn primary" data-grtab="cmp">К сравнению</button></div>';
    const i = Math.max(0, Math.min(n - 1, s.rev || 0)), R = resOf(i), L = lvl();
    const nav = `<button type="button" class="btn" data-grstep="-1"${i <= 0 ? ' disabled' : ''} aria-label="Предыдущее решение">◀</button><h2>Решение ${i + 1} <small>из ${n}</small></h2><button type="button" class="btn" data-grstep="1"${i >= n - 1 ? ' disabled' : ''} aria-label="Следующее решение">▶</button>`;
    if (!R) return `<div class="gr-rev"><div class="gr-rev-h">${nav}</div><p class="gr-lede gr-pad">Считаю решение…</p></div>`;
    if (R.err) return `<div class="gr-rev"><div class="gr-rev-h">${nav}</div><p class="gr-lede gr-pad">Код не разобрался: ${esc(R.err)}.</p></div>`;
    const d = decodeSol(s.sols[i].code), g = graphOfSol(L, d);
    return `<div class="gr-rev"><div class="gr-rev-h">${nav}<span class="gr-badge ${R.score >= 75 ? 'ok' : R.score >= 55 ? 'warn' : 'bad'}">${R.score} / 100</span><span class="gr-note">${esc(R.label)}</span><button type="button" class="btn ghost" data-grcanvas="${i}">Открыть на площадке</button></div>
      <div class="gr-rev-b"><section class="gr-schema">${schemaSvg(g)}</section>
      <aside class="gr-side"><table class="gr-mt"><thead><tr><th></th><th>Решение ${i + 1}</th><th>Эталон</th></tr></thead><tbody>${metricRows(R, S.ref || null)}</tbody></table>
        <ul class="gr-gl2">${R.goals.map(x => `<li class="${x.ok ? 'ok' : 'bad'}"><span>${x.ok ? '✓' : '✗'}</span>${esc(x.text)}<small>${esc(x.detail || '')}</small></li>`).join('')}</ul>
        ${R.good.length ? `<h3>Сильные стороны</h3><ul class="gr-ls">${R.good.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${R.fix.length ? `<h3>Что улучшить</h3><ul class="gr-ls">${R.fix.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</aside></div></div>`;
  }

  /* ---------- решение на настоящей площадке (симулятор, «Почему?», сцены) ---------- */
  function toCanvas(which) {
    const L = lvl(); if (!L) return;
    let g = null;
    if (which === 'ref') { if (!L.solution) return; g = buildGraph(L, L.solution); }
    else { const x = sols()[+which]; if (!x) return; const d = decodeSol(x.code); if (d.err) return; g = graphOfSol(L, d); }
    const el = $('grScr'); if (el) el.hidden = true; onCls();
    S.canvas = which === 'ref' ? 'ref' : +which;
    SD.app.loadLevel(L, { nodes: [], edges: [] });
    const A = SD.app.A; A.graph = g; SD.editor.setGraph(A.graph); SD.app.recompute(true);
    requestAnimationFrame(() => SD.editor.fit());
    syncPill(); broadcast();
    toast(which === 'ref' ? 'На площадке — эталон. Здесь работает всё: «Почему?», «Уронить узел», «Волна», сцены изнутри.' : `На площадке — решение ${+which + 1}. Покажи группе, где узкое место: «Почему?» у красной цели, «Уронить узел», «Волна».`);
  }

  /* ---------- таймер, подсказки, шаги разбора ---------- */
  function act(a, v) {
    const s = S.sess; if (!s) return;
    const t = s.timer;
    if (a === 'timer') { if (t.run) { t.left = tLeft(t); t.run = false; } else { if (t.left <= 0) t.left = t.len; t.run = true; t.at = Date.now(); } }
    else if (a === 'tplus') { t.left = tLeft(t) + 60; if (t.run) t.at = Date.now(); }
    else if (a === 'treset') { t.left = t.len; t.run = false; }
    else if (a === 'hint') { const L = lvl(); s.hints = Math.min((L.hints || []).length, s.hints + 1); s.stage = 'case'; }
    else if (a === 'hintoff') s.hints = 0;
    else if (a === 'stage' && TABS.some(x => x[0] === v)) s.stage = v;
    else if (a === 'rev') { s.rev = Math.max(0, Math.min(s.sols.length - 1, +v || 0)); s.stage = 'rev'; }
    else if (a === 'revstep') { s.rev = Math.max(0, Math.min(s.sols.length - 1, (s.rev || 0) + (+v || 0))); s.stage = 'rev'; }
    else if (a === 'drop') { const i = +v; if (s.sols[i]) { s.sols.splice(i, 1); if (s.rev >= s.sols.length) s.rev = Math.max(0, s.sols.length - 1); } }
    else if (a === 'codes') { const r = addCodes(v); S.addMsg = addMsg(r); s.stage = 'cmp'; }
    persist();
    if (!shown() && a !== 'timer' && a !== 'tplus' && a !== 'treset') { ensureScr().hidden = false; onCls(); S.canvas = null; syncPill(); }
    render(); broadcast();
  }
  const addMsg = r => !r.found ? 'Кодов не нашёл. Код начинается с «sdg.».' : [r.added ? `добавлено ${r.added}` : '', r.replaced ? `обновлено ${r.replaced}` : '', r.same ? `уже были ${r.same}` : '', r.other ? `с другого кейса ${r.other}` : '', r.bad ? `повреждены ${r.bad}` : ''].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase()) + '.';

  /* ---------- пульт: что видит и что шлёт ---------- */
  const sum = R => R ? (R.err ? { err: R.err } : { score: R.score, ok: R.ok, gOk: R.gOk, gN: R.gN, cost: R.cost, lat: R.lat, built: R.built }) : null;
  function stateMsg() {
    const s = S.sess, L = lvl();
    if (!s || !L) return { type: 'state', on: false };
    return { type: 'state', on: true, shown: shown(), canvas: S.canvas, code: s.code, title: L.title, ev: L.group.evTitle, stage: s.stage, hints: s.hints, hintTexts: (L.hints || []).map(x => x.text || String(x)),
      timer: s.timer, rev: s.rev, refNote: L.solution ? L.solution.note || '' : '', ref: sum(S.ref), sols: s.sols.map((x, i) => Object.assign({ no: i + 1, s: x.s }, sum(S.res[x.code]) || { wait: true })),
      errs: errors().slice(0, 4).map(e => ({ n: e.n, of: e.of, title: e.title })), wait: pending(), addMsg: S.addMsg || '' };
  }
  function broadcast() { if (!isPult && S.on) bus.send(stateMsg()); }
  const P = { st: null, seen: 0, draft: '' };
  function pultHtml() {
    const m = P.st, live = m && Date.now() - P.seen < 4000, f = F();
    let h = `<header class="gr-ph"><div><span class="eyebrow">Режим группы</span><b>Пульт наставника</b></div><span class="gr-live${live ? ' on' : ''}">${live ? '● связь с экраном' : '○ ищу экран…'}</span></header>`;
    if (!m || !m.on) return h + `<div class="gr-pad gr-pempty"><p>Экран не найден. В другом окне этого же браузера открой тренажёр → Ctrl+K → «Режим группы» и выведи кейс — здесь появится управление.</p><p class="gr-note">Пульт работает, когда тренажёр открыт как сайт. Если экран открыт внутри платформы, открой тренажёр отдельной вкладкой.</p></div>`;
    const t = m.timer, left = tLeft(t);
    h += `<section class="gr-pc"><p class="gr-pt1">${esc(m.title)}</p><p class="gr-note">Код занятия: <b class="gr-mono">${esc(m.code)}</b>${m.shown ? '' : ' · экран группы сейчас закрыт'}${m.canvas != null ? ` · на площадке: ${m.canvas === 'ref' ? 'эталон' : 'решение ' + (m.canvas + 1)}` : ''}</p></section>`;
    h += `<section class="gr-pc gr-ptm"><span class="gr-clock${t.run ? ' run' : ''}${left <= 0 ? ' out' : ''}" data-grclock>${left <= 0 ? 'Время!' : clock(left)}</span><button type="button" class="btn${t.run ? '' : ' primary'}" data-gp="timer">${t.run ? '❚❚ Пауза' : '▶ Старт'}</button><button type="button" class="btn" data-gp="tplus">+1 мин</button><button type="button" class="btn ghost" data-gp="treset">↺ Сброс</button></section>`;
    h += `<section class="gr-pc"><h3>На экране</h3><div class="seg">${TABS.map(([k, tt]) => `<button type="button" data-gp="stage" data-v="${k}" aria-selected="${m.shown && m.canvas == null && m.stage === k}">${tt}</button>`).join('')}</div></section>`;
    const hn = m.hintTexts.length;
    h += `<section class="gr-pc"><h3>Подсказки · на экране ${m.hints} из ${hn}</h3>${hn ? `<ol class="gr-phl">${m.hintTexts.map((x, i) => `<li class="${i < m.hints ? 'on' : ''}">${esc(x)}</li>`).join('')}</ol>` : '<p class="gr-note">У кейса нет подсказок.</p>'}<div class="gr-row">${m.hints < hn ? `<button type="button" class="btn" data-gp="hint">Показать подсказку ${m.hints + 1}</button>` : ''}${m.hints ? '<button type="button" class="btn ghost" data-gp="hintoff">Спрятать подсказки</button>' : ''}</div></section>`;
    h += `<section class="gr-pc"><h3>Эталон · видите только вы</h3><p>${esc(m.refNote || 'Эталона для этого кейса нет.')}</p>${m.ref ? `<p class="gr-note">${m.ref.score} / 100 · ${esc(f.usd(m.ref.cost))} в месяц · ${esc(f.ms(m.ref.lat))}</p>` : ''}</section>`;
    h += `<section class="gr-pc"><h3>Решения · ${m.sols.length}${m.wait ? ` · считаю ${m.wait}` : ''}</h3>`;
    if (m.sols.length) {
      h += `<div class="gr-row"><button type="button" class="btn" data-gp="revstep" data-v="-1" aria-label="Предыдущее">◀</button><span class="gr-note">разбор: решение ${(m.rev || 0) + 1}</span><button type="button" class="btn" data-gp="revstep" data-v="1" aria-label="Следующее">▶</button></div><ul class="gr-psol">`;
      m.sols.forEach(x => { h += `<li><span>Решение ${x.no}</span>${x.wait ? '<em>считаю…</em>' : x.err ? `<em class="bad">${esc(x.err)}</em>` : `<b class="${x.ok ? 'ok' : 'bad'}">${x.score}</b><small>цели ${x.gOk}/${x.gN} · ${esc(f.usd(x.cost))}</small>`}<button type="button" class="btn ghost" data-gp="rev" data-v="${x.no - 1}">Разобрать</button></li>`; });
      h += '</ul>';
    } else h += '<p class="gr-note">Пока ни одного. Вставь коды ниже — они уйдут на экран.</p>';
    h += `<label class="gr-f"><span>Коды решений из чата</span><textarea id="grPPaste" rows="3" spellcheck="false" placeholder="sdg.…">${esc(P.draft)}</textarea></label><div class="gr-row"><button type="button" class="btn primary" data-gp="codes">Отправить на экран</button><span class="gr-note">${esc(m.addMsg)}</span></div></section>`;
    if (m.errs.length) h += `<section class="gr-pc"><h3>Типичные ошибки</h3><ol class="gr-err">${m.errs.map(e => `<li><span class="gr-n">у ${e.n} из ${e.of}</span><b>${esc(e.title)}</b></li>`).join('')}</ol></section>`;
    return h;
  }
  function renderPult() {
    let el = $('grPult');
    if (!el) {
      el = document.createElement('div'); el.id = 'grPult'; el.className = 'gr-pult'; document.body.appendChild(el);
      el.addEventListener('input', e => { if (e.target.id === 'grPPaste') P.draft = e.target.value; });
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-gp]'); if (!b) return;
        const a = b.dataset.gp;
        if (a === 'codes') { if (!P.draft.trim()) return; bus.send({ type: 'cmd', act: 'codes', v: P.draft.slice(0, 60000) }); P.draft = ''; renderPult(); return; }
        bus.send({ type: 'cmd', act: a, v: b.dataset.v });
      });
    }
    keep(el, pultHtml());
  }

  /* ---------- ученик: блок в задании, кнопка с таймером, окно «Сдать решение» ---------- */
  const curG = () => { const A = SD.app && SD.app.A; return A && A.level && A.level.group ? A.level : null; };
  const stuLeft = L => { const st = U.stu[L.group.code]; return st ? L.group.min * 60 - (Date.now() - st.t0) / 1000 : L.group.min * 60; };
  function taskCta(L) {
    if (!L || !L.group) return '';
    /* надпись над заголовком — наша (panels.js не знает о режиме группы) */
    Promise.resolve().then(() => { const e = document.querySelector('#paneTask > .eyebrow'); if (e && curG() === L) e.textContent = `Режим группы · кейс «${L.group.baseTitle}»${L.group.evTitle ? ' · ' + L.group.evTitle : ''}`; });
    if (S.canvas != null) return `<div class="gr-stu"><div class="gr-stu-h"><b>Разбор у доски: ${S.canvas === 'ref' ? 'эталон' : 'решение ' + (S.canvas + 1)}</b></div><p>Схема из кода решения. Меняй смело — само решение в сравнении не изменится.</p><div class="gr-row"><button type="button" class="btn primary" data-grback>← К экрану группы</button></div></div>`;
    const left = stuLeft(L);
    return `<div class="gr-stu"><div class="gr-stu-h"><b>Занятие в группе</b><span class="gr-stu-left${left <= 0 ? ' out' : ''}" data-grleft>${left <= 0 ? 'время вышло' : '⏱ ' + clock(left)}</span></div>
      <p>Как контрольная у доски: собери своё решение, потом сдай его кодом. Наставник покажет все решения рядом — без имён.</p>
      <div class="gr-row"><button type="button" class="btn primary" data-grsubmit>Сдать решение</button><small>Код занятия: <span class="gr-mono">${esc(L.group.code)}</span></small></div></div>`;
  }
  function syncPill() {
    if (isPult) return;
    const L = curG();
    let p = $('grPill');
    if (!L) { S.canvas = null; if (p) p.hidden = true; return; }
    if (!p) { p = document.createElement('div'); p.id = 'grPill'; p.className = 'gr-pill'; document.body.appendChild(p); }
    const mode = S.canvas != null ? 'm' + S.canvas : 's';
    if (p.dataset.mode !== mode || p.dataset.code !== L.group.code) {
      p.dataset.mode = mode; p.dataset.code = L.group.code;
      p.innerHTML = mode !== 's' ? `<span class="gr-pill-t">Разбор: ${S.canvas === 'ref' ? 'эталон' : 'решение ' + (S.canvas + 1)}</span>${S.canvas !== 'ref' ? '<button type="button" class="btn ghost" data-grcstep="-1" aria-label="Предыдущее решение">◀</button><button type="button" class="btn ghost" data-grcstep="1" aria-label="Следующее решение">▶</button>' : ''}<button type="button" class="btn primary" data-grback>К экрану группы</button>`
        : '<span class="gr-pill-t" data-grleft></span><button type="button" class="btn primary" data-grsubmit>Сдать решение</button>';
    }
    p.hidden = shown();
    tick();
  }
  function submit() {
    const L = curG(); if (!L) { toast('Сдать решение можно на кейсе занятия: открой его по ссылке или коду.'); return; }
    const A = SD.app.A, code = solutionCode(), built = A.graph.nodes.some(n => n.type !== 'client' && !(L.preset || []).some(p => p[0] === n.id));
    const ok = (A.goals || []).filter(x => x.ok).length, all = (A.goals || []).length;
    let m = $('grSub');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'grSub'; m.hidden = true;
      m.innerHTML = '<div class="sheet gr-sub" role="dialog" aria-modal="true" aria-labelledby="grSubT"><div class="sheet-head"><h2 id="grSubT">Сдать решение</h2><button class="btn ghost x" type="button" data-grsubx>Закрыть</button></div><div class="gr-subb" id="grSubB"></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-grsubx]')) m.hidden = true; });
    }
    $('grSubB').innerHTML = `<p class="gr-lede gr-sm">Как сдать тетрадь без подписи: в коде вся твоя схема, имени нет — на экране она будет «Решение N».</p>
      ${built ? `<p class="${ok === all && all ? 'gr-ok' : 'gr-warn'}">Сейчас выполнено целей: ${ok} из ${all}. ${ok === all && all ? 'Отлично!' : 'Можно сдать и так — разберём вместе.'}</p>` : '<p class="gr-warn">Схема пока пустая — сначала собери решение.</p>'}
      <textarea id="grCode" class="gr-codebox" readonly rows="4" spellcheck="false">${esc(code)}</textarea>
      <div class="gr-row"><button type="button" class="btn primary" data-grcopy>Скопировать код</button>${navigator.share ? '<button type="button" class="btn" data-grshare>Отправить…</button>' : ''}<span class="gr-note" id="grCopied"></span></div>
      <p class="gr-note">Отправь код в чат занятия. Доработал схему — сдай снова: новый код заменит прежний.</p>`;
    m.hidden = false;
  }
  function copyCode() {
    const t = $('grCode'); if (!t) return;
    const done = () => { $('grCopied').textContent = 'Скопировано — вставь в чат занятия.'; };
    const fall = () => { t.select(); try { document.execCommand('copy'); done(); } catch (e) { $('grCopied').textContent = 'Выдели код и скопируй вручную.'; } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(done, fall); else fall();
  }
  function join(code) {
    const p = parseGroup(code), L = p && derive(p.code);
    if (!L) { toast('Кейс по такому коду не нашёлся — проверь код занятия.'); return false; }
    if (!U.stu[L.group.code]) { U.stu[L.group.code] = { t0: Date.now() }; const ks = Object.keys(U.stu); if (ks.length > 20) delete U.stu[ks[0]]; save(); }
    const el = $('grScr'); if (el) el.hidden = true; onCls();
    document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
    S.canvas = null;
    SD.app.loadLevel(L);
    syncPill();
    toast(`Кейс занятия: «${L.title}». На решение — ${L.group.min} мин. Когда готово — «Сдать решение».`);
    return true;
  }
  function fromHash() {
    const m = /^#group=([^&#]+)$/.exec(location.hash || ''); if (!m) return false;
    let code = ''; try { code = decodeURIComponent(m[1]); } catch (e) { code = m[1]; }
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) { /* адрес не меняется */ }
    return join(code);
  }

  /* ---------- таймеры раз в секунду: экран, пульт, ученик ---------- */
  function tick() {
    const s = S.sess;
    if (s && !isPult) {
      const t = s.timer, left = tLeft(t);
      if (t.run && left <= 0) { t.run = false; t.left = 0; persist(); if (shown()) head(); broadcast(); toast('Время вышло: собираем решения — «Сравнение».'); }
    }
    document.querySelectorAll('[data-grclock]').forEach(el => {
      const t = isPult ? P.st && P.st.timer : s && s.timer; if (!t) return;
      const left = tLeft(t); el.textContent = left <= 0 ? 'Время!' : clock(left); el.classList.toggle('out', left <= 0); el.classList.toggle('run', !!t.run && left > 0);
    });
    const L = curG();
    if (L) document.querySelectorAll('[data-grleft]').forEach(el => { const left = stuLeft(L); el.textContent = left <= 0 ? 'время вышло' : '⏱ ' + clock(left); el.classList.toggle('out', left <= 0); });
  }

  /* ---------- вход ---------- */
  function onClick(e) {
    const t = e.target.closest('[data-grtab],[data-grtimer],[data-grpult],[data-grfs],[data-grclose],[data-grgo],[data-grdaily],[data-grstart],[data-grjoin],[data-grpaste],[data-gradd],[data-grrev],[data-grstep],[data-grcanvas],[data-grdrop],[data-grback],[data-grcstep],[data-grsubmit],[data-grcopy],[data-grshare],[data-grend]');
    if (!t || isPult) return;
    const d = t.dataset;
    if (d.grtab) { if (d.grpaste === 'open') S.paste = true; act('stage', d.grtab); return; }
    if (d.grpaste) { S.paste = !S.paste; render(); return; }
    if (d.grtimer) { act(d.grtimer === 'toggle' ? 'timer' : d.grtimer === 'plus' ? 'tplus' : 'treset'); return; }
    if (d.grpult !== undefined) { const w = window.open(location.href.split('#')[0] + '#group-pult', 'amp-group-pult', 'width=560,height=900'); if (!w) toast('Браузер не дал открыть окно. Открой в новой вкладке адрес тренажёра с #group-pult в конце.'); setTimeout(broadcast, 1500); return; }
    if (d.grfs !== undefined) { const de = document.documentElement; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (de.requestFullscreen) de.requestFullscreen().catch(() => toast('Во весь экран не вышло: нажми F11.')); return; }
    if (d.grclose !== undefined) { close(); return; }
    /* новое занятие — со второго нажатия: решения группы пропадут */
    if (d.grend !== undefined) { if (S.endAsk) { S.endAsk = false; endSess(); } else { S.endAsk = true; head(); setTimeout(() => { if (S.endAsk) { S.endAsk = false; if (shown()) head(); } }, 4000); } return; }
    if (d.grgo === 'resume') { open(); return; }
    if (d.grdaily !== undefined) { const D = SD.daily.today(); if (D && D.daily) { $('grLv').value = D.daily.base; $('grEv').value = D.daily.ev; preview(); } return; }
    if (d.grstart !== undefined) { const code = startSess({ level: $('grLv').value, ev: $('grEv').value, min: $('grMin').value }); if (!code) { toast('Этот кейс в режиме группы недоступен.'); return; } render(); broadcast(); return; }
    if (d.grjoin !== undefined) { const v = ($('grJoinIn') || {}).value || ''; if (!join(v)) { const msg = $('grJoinMsg'); if (msg) msg.textContent = 'Код не подошёл. Он выглядит так: short.-.15.K7QF — четыре части через точку.'; } return; }
    if (d.gradd !== undefined) { const r = addCodes(S.draft || ($('grPaste') || {}).value || ''); S.addMsg = addMsg(r); if (r.added || r.replaced) { S.draft = ''; S.paste = false; } render(); broadcast(); return; }
    if (d.grrev !== undefined) { act('rev', d.grrev); return; }
    if (d.grstep !== undefined) { act('revstep', d.grstep); return; }
    if (d.grdrop !== undefined) { act('drop', d.grdrop); return; }
    if (d.grcanvas !== undefined) { toCanvas(d.grcanvas); return; }
    if (d.grcstep !== undefined) { const n = sols().length; if (typeof S.canvas === 'number' && n) { S.sess.rev = Math.max(0, Math.min(n - 1, S.canvas + (+d.grcstep))); persist(); toCanvas(S.sess.rev); } return; }
    if (d.grback !== undefined) { if (S.canvas !== 'ref' && typeof S.canvas === 'number') S.sess.rev = S.canvas; S.canvas = null; open(); return; }
    if (d.grsubmit !== undefined) { submit(); return; }
    if (d.grcopy !== undefined) { copyCode(); return; }
    if (d.grshare !== undefined) { const c = ($('grCode') || {}).value; if (navigator.share && c) navigator.share({ text: c }).catch(() => {}); }
  }
  function mount() {
    if (isPult) {
      document.title = 'Пульт · Режим группы · AMP Стройплощадка';
      document.documentElement.classList.add('gr-pultmode');
      /* пульс экрана приходит каждые 2,5 с: перерисовываем, только если что-то поменялось или связь была потеряна */
      bus.on(m => {
        if (m.type !== 'state') return;
        const sig = JSON.stringify(Object.assign({}, m, { from: 0, r: 0 })), stale = Date.now() - P.seen > 4000;
        P.st = m; P.seen = Date.now();
        if (sig !== P.sig || stale) { P.sig = sig; renderPult(); }
      });
      renderPult(); bus.send({ type: 'hello' });
      setInterval(() => { if (!P.st || Date.now() - P.seen > 4000) { bus.send({ type: 'hello' }); if (P.live !== false) { P.live = false; renderPult(); } } else P.live = true; tick(); }, 1000);
      return;
    }
    bus.on(m => {
      if (m.type === 'hello') { broadcast(); return; }
      if (m.type !== 'cmd' || !S.on || !S.sess) return;
      act(m.act, m.v);
    });
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', e => {
      /* точки графика — с клавиатуры тоже: Enter или пробел открывают разбор */
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.gr-pt')) { e.preventDefault(); onClick(e); return; }
      if (e.key !== 'Escape') return;
      const sm = $('grSub'); if (sm && !sm.hidden) { sm.hidden = true; return; }
      if (shown() && !document.fullscreenElement) close();
    });
    window.addEventListener('resize', () => { clearTimeout(mount.rt); mount.rt = setTimeout(drawPlots, 120); });
    window.addEventListener('hashchange', fromHash);
    setInterval(() => { tick(); syncPill(); }, 1000);
    setInterval(() => { if (S.on && S.sess) broadcast(); }, 2500);
    /* ссылка #group=… — после стартовых окон (ux.js показывает окно цели через 120 мс; загрузка уровня его закрывает) */
    setTimeout(() => {
      if (!fromHash() && curG()) { const gm = $('goalModal'); if (gm && !gm.hidden) gm.hidden = true; } /* ученик перезагрузил кейс занятия — окно «Зачем ты здесь?» не мешает, как при открытии по ссылке */
      syncPill();
    }, 300);
  }
  let tries = 0;
  function boot() {
    if (!SD.app || !SD.app.A || !SD.app.A.level) { if (++tries < 400) setTimeout(boot, 50); return; }
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);

  /* уровни занятия находятся по id — переживают перезагрузку у ученика */
  SD.levelById = id => (typeof id === 'string' && id.startsWith('grp-')) ? (() => { const p = fromId(id); return p ? derive(p.code) : null; })() : baseById(id);
  SD.levelLabel = L => L && L.group ? 'Режим группы' : baseLabel(L);
  SD.nextLevel = L => L && L.group ? null : baseNext(L);
  (SD.taskCtas = SD.taskCtas || []).push(taskCta);
  (SD.cmdExtra = SD.cmdExtra || []).push(add => {
    add('Учиться', 'Режим группы: разбор у доски', 'кейс на экран, ученики решают у себя, сравнение без имён', () => open(), 'группа класс занятие наставник ученик проектор доска сравнение решений код qr пульт урок');
    if (curG()) add('Действие', 'Сдать решение группе', 'код решения для наставника', () => submit(), 'сдать код решения группа занятие');
  });

  SD.group = { open, close, join, submit, start: startSess, end: endSess, addCodes, solutionCode, decode: decodeSol, parse: parseGroup, levelOf: derive, evaluate: evalOne, graphOf: graphOfSol, linkOf, qr: QR, state: () => S, toCanvas, act };

  /* кнопка в меню «Практика» рядом с «Собеседованием»; разложить её по меню помогает js/ux.js (navGroup в списке NAV) */
  (function () {
    const put = () => {
      if (document.getElementById('navGroup')) return;
      const ref = document.getElementById('navInt') || document.getElementById('navHub'); if (!ref || !ref.parentNode) return;
      const b = document.createElement('button'); b.type = 'button'; b.id = 'navGroup'; b.className = ref.className; b.textContent = 'Режим группы';
      b.title = 'Разбор у доски: экран для проектора, QR для учеников, сравнение решений';
      b.addEventListener('click', () => { if (SD.group && SD.group.open) SD.group.open(); });
      ref.after(b);
    };
    [0, 80, 600, 1700].forEach(t => setTimeout(put, t));
  })();
})();
